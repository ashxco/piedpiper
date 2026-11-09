/**
 * Finds folders the user already works in with Claude Code and Codex, by reading only the working
 * directory out of their local session transcripts. Read-only, and nothing else from a transcript
 * leaves this module.
 *
 * @module AgentSessionScanner
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  AgentSessionProjectCandidate,
  AgentSessionScanResult,
  AgentSessionSource,
  ServerSettings,
} from "@piedpiper/contracts";
import { Effect, FileSystem, Option, Path } from "effect";

import { expandCodexHomePath } from "../codex/homePath";
import { runProcess } from "../processRunner";

export interface AgentSessionScanOptions {
  readonly homeDir: string;
  /** Null skips the provider, for one the user has disabled. */
  readonly claudeHome: string | null;
  readonly codexHome: string | null;
  readonly baseDir: string;
  readonly worktreesDir: string;
  readonly knownWorkspaceRoots: ReadonlyArray<string>;
  readonly tempDirs?: ReadonlyArray<string>;
  readonly maxTranscriptsPerSource?: number;
  readonly folderProbeTimeoutMs?: number;
}

const MAX_TRANSCRIPTS_PER_SOURCE = 5000;
const DISCOVERY_OPERATIONS_PER_TRANSCRIPT = 4;
const METADATA_READ_BYTES = 8 * 1024;
const MAX_TRANSCRIPT_SCAN_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES_PER_SOURCE = 64 * 1024 * 1024;
const MAX_RECORDS_PER_TRANSCRIPT = 1000;
const MAX_RECORDS_PER_SOURCE = 100_000;

const GIT_FILE_READ_TIMEOUT_MS = 2000;
const MAX_GIT_FILE_BYTES = 1024 * 1024;
const GIT_FILE_READ_CONCURRENCY = 16;
const MAX_GIT_ANCESTOR_LEVELS = 8;

const FOLDER_PROBE_TIMEOUT_MS = 2000;
// A probe that times out still holds a libuv pool thread (4 by default), so stop before they run out.
const MAX_TIMED_OUT_PROBES = 2;

interface Transcript {
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly size: number;
}

interface MetadataBudget {
  bytesRemaining: number;
  recordsRemaining: number;
  truncated: boolean;
}

interface FolderEntry {
  readonly path: string;
  readonly sources: Array<AgentSessionSource>;
  threadCount: number;
  lastActiveAtMs: number;
}

interface GitCheckout {
  readonly directory: string;
  readonly isGitDirectory: boolean;
}

/** Follows the same precedence as the providers: the settings field, then their env variable. */
export function resolveAgentSessionHomes(
  providers: ServerSettings["providers"],
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): { readonly claudeHome: string | null; readonly codexHome: string | null } {
  const resolveHome = (configured: string, envValue: string | undefined, fallback: string) => {
    const value = configured.trim() || envValue?.trim();
    return value
      ? NodePath.resolve(expandCodexHomePath(value, homeDir))
      : NodePath.join(homeDir, fallback);
  };
  return {
    claudeHome: providers.claudeAgent.enabled
      ? resolveHome(providers.claudeAgent.homePath, env.CLAUDE_CONFIG_DIR, ".claude")
      : null,
    codexHome: providers.codex.enabled
      ? resolveHome(providers.codex.homePath, env.CODEX_HOME, ".codex")
      : null,
  };
}

/** The record's cwd; null to keep reading; false when the whole transcript does not count. */
function extractCwd(line: string, source: AgentSessionSource): string | null | false {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (source === "claudeAgent") {
    if (record.isSidechain === true) return null;
    return typeof record.cwd === "string" && record.cwd.trim().length > 0 ? record.cwd : null;
  }
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const fields = payload as Record<string, unknown>;
  if (record.type === "session_meta") {
    const sessionSource = fields.source;
    if (
      typeof sessionSource === "object" &&
      sessionSource !== null &&
      (Object.hasOwn(sessionSource, "subagent") || Object.hasOwn(sessionSource, "subAgent"))
    ) {
      return false;
    }
  }
  return typeof fields.cwd === "string" && fields.cwd.trim().length > 0 ? fields.cwd : null;
}

/** Git's rule for the value of `core.bare`, on the last assignment in the file. */
export function isBareGitConfig(configText: string): boolean {
  let inCore = false;
  let bare = false;
  for (const rawLine of configText.split(/\r?\n/)) {
    let line = rawLine.trim();
    const header = /^\[\s*([^\]]*?)\s*\](.*)$/.exec(line);
    if (header) {
      inCore = header[1]?.toLowerCase() === "core";
      line = header[2]?.trim() ?? "";
    }
    if (!inCore) continue;
    const match = /^bare\s*(?:=\s*([^#;]*))?(?:[#;].*)?$/i.exec(line);
    if (!match) continue;
    const value = match[1]?.trim().replace(/^"(.*)"$/, "$1");
    bare = value === undefined || /^(true|yes|on|[1-9]\d*)$/i.test(value);
  }
  return bare;
}

/**
 * open() on a file under macOS privacy protection waits on a consent prompt a server never gets,
 * and on a FIFO waits for a writer. Either pins a libuv pool thread that interruption cannot free,
 * so files found through arbitrary transcript cwds are read by a child process we can kill.
 */
const readGitFile = Effect.fn("AgentSessionScanner.readGitFile")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  if (process.platform === "win32") {
    return yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  }
  return yield* Effect.tryPromise(() =>
    runProcess("cat", ["--", filePath], {
      timeoutMs: GIT_FILE_READ_TIMEOUT_MS,
      allowNonZeroExit: true,
      maxBufferBytes: MAX_GIT_FILE_BYTES,
      outputMode: "truncate",
    }),
  ).pipe(
    Effect.map((result) => (result.code === 0 && !result.timedOut ? result.stdout : "")),
    Effect.orElseSucceed(() => ""),
  );
});

/** A session can start in any subfolder, so this walks up, but a dotfiles repo in home does not count. */
const findGitCheckout = Effect.fn("AgentSessionScanner.findGitCheckout")(function* (
  directory: string,
  stopAt: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = directory;
  for (let level = 0; level <= MAX_GIT_ANCESTOR_LEVELS; level += 1) {
    if (stopAt.includes(current)) return null;
    const stats = yield* fileSystem.stat(path.join(current, ".git")).pipe(Effect.option);
    if (Option.isSome(stats)) {
      return {
        directory: current,
        isGitDirectory: stats.value.type === "Directory",
      } satisfies GitCheckout;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
});

/** A linked worktree belongs to its main checkout, except for a bare repository, which has none. */
const readGitIdentity = Effect.fn("AgentSessionScanner.readGitIdentity")(function* (
  checkout: GitCheckout,
) {
  const path = yield* Path.Path;
  if (checkout.isGitDirectory) return "repository";

  const gitPath = path.join(checkout.directory, ".git");
  const pointer = /^gitdir:\s*(.+)$/m.exec(yield* readGitFile(gitPath))?.[1]?.trim();
  if (!pointer) return "none";
  const gitDir = path.resolve(checkout.directory, pointer);
  if (!/[\\/]worktrees[\\/][^\\/]+[\\/]?$/.test(gitDir)) return "repository";

  const commonDir = (yield* readGitFile(path.join(gitDir, "commondir"))).trim();
  if (!commonDir) return "worktree";
  const config = yield* readGitFile(path.join(path.resolve(gitDir, commonDir), "config"));
  return isBareGitConfig(config) ? "repository" : "worktree";
});

const statTranscript = Effect.fn("AgentSessionScanner.statTranscript")(function* (
  filePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const stats = yield* fileSystem.stat(filePath).pipe(Effect.option);
  if (Option.isNone(stats) || stats.value.type !== "File" || Option.isNone(stats.value.mtime)) {
    return null;
  }
  return {
    filePath,
    mtimeMs: stats.value.mtime.value.getTime(),
    size: Number(stats.value.size),
  } satisfies Transcript;
});

function makeOperationBudget(operations: number) {
  return {
    remaining: operations,
    truncated: false,
    take() {
      if (this.remaining <= 0) {
        this.truncated = true;
        return false;
      }
      this.remaining -= 1;
      return true;
    },
  };
}

const listDirectory = Effect.fn("AgentSessionScanner.listDirectory")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
});

/** Subagent transcripts live a level deeper or, on older versions, as `agent-*.jsonl`. */
const discoverClaudeTranscripts = Effect.fn("AgentSessionScanner.discoverClaudeTranscripts")(
  function* (home: string, maxTranscripts: number) {
    const path = yield* Path.Path;
    const budget = makeOperationBudget(maxTranscripts * DISCOVERY_OPERATIONS_PER_TRANSCRIPT);
    const transcripts: Array<Transcript> = [];
    const projectsDir = path.join(home, "projects");
    for (const entry of yield* listDirectory(projectsDir)) {
      if (!budget.take()) break;
      const directory = path.join(projectsDir, entry);
      for (const name of yield* listDirectory(directory)) {
        if (!name.endsWith(".jsonl") || name.startsWith("agent-")) continue;
        if (!budget.take()) break;
        const transcript = yield* statTranscript(path.join(directory, name));
        if (transcript) transcripts.push(transcript);
      }
    }
    return { transcripts, truncated: budget.truncated };
  },
);

const newestFirst = (entries: ReadonlyArray<string>) => entries.toSorted().toReversed();

/** Codex nests rollouts by date, so walking newest first keeps recent ones when a cap is hit. */
const discoverCodexTranscripts = Effect.fn("AgentSessionScanner.discoverCodexTranscripts")(
  function* (home: string, maxTranscripts: number) {
    const path = yield* Path.Path;
    const budget = makeOperationBudget(maxTranscripts * DISCOVERY_OPERATIONS_PER_TRANSCRIPT);
    const transcripts: Array<Transcript> = [];

    const sessionsDir = path.join(home, "sessions");
    for (const year of newestFirst(yield* listDirectory(sessionsDir))) {
      if (!budget.take()) break;
      for (const month of newestFirst(yield* listDirectory(path.join(sessionsDir, year)))) {
        if (!budget.take()) break;
        for (const day of newestFirst(yield* listDirectory(path.join(sessionsDir, year, month)))) {
          if (!budget.take()) break;
          const directory = path.join(sessionsDir, year, month, day);
          for (const name of newestFirst(yield* listDirectory(directory))) {
            if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
            if (!budget.take()) break;
            const transcript = yield* statTranscript(path.join(directory, name));
            if (transcript) transcripts.push(transcript);
          }
        }
      }
    }
    return { transcripts, truncated: budget.truncated };
  },
);

/** Reads forward until a record names a cwd, within the per-transcript and per-source caps. */
const readTranscriptCwd = Effect.fn("AgentSessionScanner.readTranscriptCwd")(function* (
  source: AgentSessionSource,
  transcript: Transcript,
  budget: MetadataBudget,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fileSystem.open(transcript.filePath, { flag: "r" });
      const decoder = new TextDecoder();
      let pending = "";
      let bytesRead = 0;
      let recordsRead = 0;
      const maxBytes = Math.min(MAX_TRANSCRIPT_SCAN_BYTES, transcript.size);
      const inspect = (line: string): string | false | null => {
        if (recordsRead >= MAX_RECORDS_PER_TRANSCRIPT || budget.recordsRemaining <= 0) {
          budget.truncated = true;
          return false;
        }
        recordsRead += 1;
        budget.recordsRemaining -= 1;
        return extractCwd(line.trim(), source);
      };

      while (bytesRead < maxBytes) {
        if (budget.bytesRemaining <= 0) {
          budget.truncated = true;
          return null;
        }
        const size = Math.min(METADATA_READ_BYTES, maxBytes - bytesRead, budget.bytesRemaining);
        budget.bytesRemaining -= size;
        const chunk = yield* file.readAlloc(size);
        if (Option.isNone(chunk)) break;
        bytesRead += chunk.value.byteLength;
        pending += decoder.decode(chunk.value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const cwd = inspect(line);
          if (cwd === false) return null;
          if (cwd !== null) return cwd;
        }
      }

      if (bytesRead < transcript.size) {
        budget.truncated = true;
        return null;
      }
      const cwd = pending.length > 0 ? inspect(pending) : null;
      return cwd === false ? null : cwd;
    }),
  ).pipe(Effect.orElseSucceed(() => null));
});

export const scanAgentSessions = Effect.fn("AgentSessionScanner.scan")(function* (
  options: AgentSessionScanOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const maxTranscripts = options.maxTranscriptsPerSource ?? MAX_TRANSCRIPTS_PER_SOURCE;
  let truncated = false;

  const isWithin = (candidate: string, ancestor: string) => {
    const relative = path.relative(ancestor, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  const folderProbeTimeoutMs = options.folderProbeTimeoutMs ?? FOLDER_PROBE_TIMEOUT_MS;
  let timedOutProbes = 0;
  // A cwd on a dead network mount blocks until the OS gives up, so these calls get a deadline.
  const probeFolder = <A, E, R>(probe: Effect.Effect<A, E, R>) =>
    timedOutProbes >= MAX_TIMED_OUT_PROBES
      ? Effect.succeed(Option.none<A>())
      : probe.pipe(
          Effect.timeoutOption(folderProbeTimeoutMs),
          Effect.tap((result) =>
            Effect.sync(() => {
              if (Option.isSome(result)) return;
              timedOutProbes += 1;
              truncated = true;
            }),
          ),
        );

  // Agents record the real path, and /tmp or a home folder can be symlinks, so both forms count.
  const withRealPaths = Effect.fn("AgentSessionScanner.withRealPaths")(function* (
    directories: ReadonlyArray<string>,
  ) {
    const all = new Set(directories.map((directory) => path.resolve(directory)));
    for (const directory of Array.from(all)) {
      const realPath = Option.flatten(
        yield* probeFolder(fileSystem.realPath(directory).pipe(Effect.option)),
      );
      if (Option.isSome(realPath)) all.add(realPath.value);
    }
    return Array.from(all);
  });

  const homeDir = path.resolve(options.homeDir);
  const homeRoots = yield* withRealPaths([homeDir]);
  const excludedTrees = yield* withRealPaths([
    ...(options.tempDirs ?? [
      NodeOS.tmpdir(),
      "/tmp",
      "/private/tmp",
      "/var/tmp",
      "/private/var/tmp",
    ]),
    path.join(homeDir, "Downloads"),
    // Codex gives every conversation its own scratch folder here.
    path.join(homeDir, "Documents", "Codex"),
    options.baseDir,
    options.worktreesDir,
  ]);
  const isExcluded = (candidate: string) =>
    // The home folder and its parents hold everything, so they are never one project.
    homeRoots.some((root) => isWithin(root, candidate)) ||
    excludedTrees.some((tree) => isWithin(candidate, tree));

  const directoryIdentity = (resolved: string, stats: FileSystem.File.Info) =>
    Option.isSome(stats.ino) && stats.ino.value > 0n
      ? `inode:${stats.dev}:${stats.ino.value}`
      : `path:${resolved}`;

  const merged = new Map<string, FolderEntry>();
  // Null marks a folder already ruled out, so its later transcripts skip the filesystem.
  const identities = new Map<string, string | null>();

  const resolveIdentity = Effect.fn("AgentSessionScanner.resolveIdentity")(function* (
    resolved: string,
  ) {
    const stats = yield* fileSystem.stat(resolved).pipe(Effect.option);
    if (Option.isNone(stats) || stats.value.type !== "Directory") return null;
    // Symlinks can disguise an excluded path, so the target is checked too.
    const realPath = yield* fileSystem
      .realPath(resolved)
      .pipe(Effect.orElseSucceed(() => resolved));
    if (isExcluded(realPath)) return null;
    return directoryIdentity(resolved, stats.value);
  });

  const scanSource = Effect.fn("AgentSessionScanner.scanSource")(function* (
    source: AgentSessionSource,
    home: string,
  ) {
    const discovered =
      source === "claudeAgent"
        ? yield* discoverClaudeTranscripts(home, maxTranscripts)
        : yield* discoverCodexTranscripts(home, maxTranscripts);
    truncated ||= discovered.truncated || discovered.transcripts.length > maxTranscripts;
    const transcripts = discovered.transcripts
      .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, maxTranscripts);
    const budget: MetadataBudget = {
      bytesRemaining: MAX_METADATA_BYTES_PER_SOURCE,
      recordsRemaining: MAX_RECORDS_PER_SOURCE,
      truncated: false,
    };
    for (const transcript of transcripts) {
      const cwd = yield* readTranscriptCwd(source, transcript, budget);
      // Project roots are trimmed strings, so a folder whose path has edge spaces cannot be added.
      if (!cwd || cwd !== cwd.trim()) continue;
      const expanded = expandCodexHomePath(cwd, homeDir);
      if (!path.isAbsolute(expanded)) continue;
      const resolved = path.resolve(expanded);
      if (resolved !== resolved.trim()) continue;
      let identity = identities.get(resolved);
      if (identity === undefined) {
        identity = isExcluded(resolved)
          ? null
          : Option.getOrNull(yield* probeFolder(resolveIdentity(resolved)));
        identities.set(resolved, identity);
      }
      if (identity === null) continue;
      const existing = merged.get(identity);
      if (!existing) {
        merged.set(identity, {
          path: resolved,
          sources: [source],
          threadCount: 1,
          lastActiveAtMs: transcript.mtimeMs,
        });
        continue;
      }
      if (!existing.sources.includes(source)) existing.sources.push(source);
      existing.threadCount += 1;
      existing.lastActiveAtMs = Math.max(existing.lastActiveAtMs, transcript.mtimeMs);
    }
    truncated ||= budget.truncated;
  });

  if (options.claudeHome) yield* scanSource("claudeAgent", options.claudeHome);
  if (options.codexHome) yield* scanSource("codex", options.codexHome);

  // Roots are compared by identity too, since transcripts may reach one through a symlink.
  const knownRoots = new Set<string>();
  for (const root of options.knownWorkspaceRoots) {
    const resolved = path.resolve(root);
    knownRoots.add(`path:${resolved}`);
    const stats = Option.flatten(yield* probeFolder(fileSystem.stat(resolved).pipe(Effect.option)));
    if (Option.isSome(stats)) knownRoots.add(directoryIdentity(resolved, stats.value));
  }
  const remaining = Array.from(merged).filter(
    ([identity, entry]) => !knownRoots.has(identity) && !knownRoots.has(`path:${entry.path}`),
  );

  const toCandidate = Effect.fn("AgentSessionScanner.toCandidate")(function* (entry: FolderEntry) {
    const checkout = yield* findGitCheckout(entry.path, homeRoots).pipe(
      Effect.timeoutOption(folderProbeTimeoutMs),
    );
    if (Option.isNone(checkout)) {
      truncated = true;
      return null;
    }
    const git = checkout.value ? yield* readGitIdentity(checkout.value) : "none";
    if (git === "worktree") return null;
    return {
      path: entry.path,
      title: path.basename(entry.path).trim() || entry.path,
      sources: entry.sources,
      threadCount: entry.threadCount,
      lastActiveAt: new Date(entry.lastActiveAtMs).toISOString(),
      isGitRepository: git === "repository",
    } satisfies AgentSessionProjectCandidate;
  });

  const candidates = yield* Effect.forEach(remaining, ([, entry]) => toCandidate(entry), {
    concurrency: GIT_FILE_READ_CONCURRENCY,
  });

  return {
    candidates: candidates
      .filter((candidate) => candidate !== null)
      .toSorted(
        (left, right) =>
          (right.lastActiveAt ?? "").localeCompare(left.lastActiveAt ?? "") ||
          left.title.localeCompare(right.title),
      ),
    truncated,
  } satisfies AgentSessionScanResult;
});
