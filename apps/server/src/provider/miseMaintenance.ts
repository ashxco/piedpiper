import { createHash } from "node:crypto";
import * as FS from "node:fs/promises";
import { Effect } from "effect";
import { findFileOnPath } from "@piedpiper/shared/shell";
import { resolveWindowsExecutable } from "@piedpiper/shared/windowsCommand";
import { runProcess } from "../processRunner.ts";

interface MiseInstall {
  install_path: string;
  requested_version?: string;
  active?: boolean;
}
export interface MiseMaintenance {
  readonly misePath: string;
  readonly tool: string;
  readonly canUpgrade: boolean;
  readonly latestVersion: string | null;
}
export interface MiseMaintenanceInput {
  readonly commandPath: string | null;
  readonly realCommandPath: string | null;
  readonly tool: string;
  readonly environment?: NodeJS.ProcessEnv;
}
const normalize = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "");
const miseExecutable = (path: string) => /(?:^|\/)mise(?:\.exe)?$/i.test(normalize(path));
const looksMiseOwned = (path: string) =>
  /\/mise\/(?:shims|command-wrappers)\//.test(normalize(path)) ||
  (/\/mise\/installs\//.test(normalize(path)) && !/\/mise\/installs\/node\//.test(normalize(path)));

function installsForTool(text: string | null, tool: string): readonly MiseInstall[] {
  if (!text) return [];
  try {
    const decoded: unknown = JSON.parse(text);
    const value = Array.isArray(decoded)
      ? decoded
      : decoded && typeof decoded === "object" && Object.keys(decoded).every((key) => key === tool)
        ? (decoded as Record<string, unknown>)[tool]
        : undefined;
    return Array.isArray(value)
      ? value.filter(
          (entry): entry is MiseInstall =>
            entry && typeof entry === "object" && typeof entry.install_path === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/** Probes mise ownership instead of assuming that every binary under its Node install is mise's. */
export function makeMiseMaintenanceResolver(
  dependencies: {
    readonly findMise?: (env: NodeJS.ProcessEnv) => string | null;
    readonly realPath?: (path: string) => Promise<string>;
    readonly readWrapper?: (path: string) => Promise<string>;
    readonly probe?: (
      path: string,
      args: readonly string[],
      env: NodeJS.ProcessEnv,
    ) => Promise<string | null>;
    readonly now?: () => number;
  } = {},
) {
  const findMise =
    dependencies.findMise ??
    ((env) =>
      process.platform === "win32"
        ? (resolveWindowsExecutable("mise", env) ?? null)
        : (findFileOnPath("mise", process.platform, env) ?? null));
  const realPath = async (path: string) =>
    (dependencies.realPath ?? FS.realpath)(path).catch(() => path);
  const readWrapper =
    dependencies.readWrapper ??
    (async (path) => {
      const stat = await FS.stat(path);
      return stat.isFile() && stat.size <= 64 * 1024 ? FS.readFile(path, "utf8") : "";
    });
  const probe =
    dependencies.probe ??
    (async (path, args, env) => {
      try {
        const result = await runProcess(path, [...args], {
          env,
          timeoutMs: 4_000,
          maxBufferBytes: 1024 * 1024,
        });
        return result.code === 0 && !result.timedOut ? result.stdout.trim() : null;
      } catch {
        return null;
      }
    });
  const latest = new Map<string, { at: number; version: string | null }>();
  const resolve = (input: MiseMaintenanceInput): Effect.Effect<MiseMaintenance | null> =>
    Effect.promise(async () => {
      const { commandPath, realCommandPath, tool } = input;
      if (!commandPath || !realCommandPath) return null;
      const env = input.environment ?? process.env;
      const shim = miseExecutable(realCommandPath);
      const wrapper = /\bmise\s+(?:x|exec)\b/.test(
        await readWrapper(realCommandPath).catch(() => ""),
      );
      const looksOwned = shim || wrapper || [commandPath, realCommandPath].some(looksMiseOwned);
      const misePath = findMise(env) ?? (shim ? realCommandPath : null);
      const manual = (): MiseMaintenance => ({
        misePath: misePath ?? "mise",
        tool,
        canUpgrade: false,
        latestVersion: null,
      });
      if (!misePath) return looksOwned ? manual() : null;
      if (wrapper) return manual();
      if (
        shim &&
        normalize(commandPath)
          .split("/")
          .at(-1)
          ?.replace(/\.(exe|cmd|bat|ps1)$/i, "") !== tool
      )
        return manual();
      const which = (await probe(misePath, ["which", tool], env))?.trim();
      const resolved = which ? await realPath(which) : null;
      const binary = shim ? resolved : realCommandPath;
      if (!binary) return looksOwned ? manual() : null;
      const listing = await probe(misePath, ["ls", "--json", "--installed", tool], env);
      const owning: MiseInstall[] = [];
      for (const install of installsForTool(listing, tool)) {
        if (normalize(binary).startsWith(`${normalize(await realPath(install.install_path))}/`))
          owning.push(install);
      }
      if (!owning.length) return looksOwned ? manual() : null;
      if (resolved !== binary) return manual();
      const install = owning.find(
        (entry) => entry.active === true && entry.requested_version === "latest",
      );
      if (!install) return manual();
      if (!shim) {
        const toolDir = normalize(install.install_path).replace(/\/[^/]+$/, "");
        const latestDirs = [toolDir, normalize(await realPath(toolDir))].map(
          (dir) => `${dir}/latest/`,
        );
        if (!latestDirs.some((dir) => normalize(commandPath).startsWith(dir))) return manual();
      }
      const envHash = createHash("sha256")
        .update(JSON.stringify(Object.entries(env).toSorted(([a], [b]) => a.localeCompare(b))))
        .digest("hex");
      const key = `${misePath}\0${tool}\0${envHash}`;
      const now = (dependencies.now ?? Date.now)();
      let cached = latest.get(key);
      if (!cached || now - cached.at >= 60 * 60_000) {
        const version = (await probe(misePath, ["latest", tool], env))?.trim();
        cached = { at: now, version: version && /^\S+$/.test(version) ? version : null };
        latest.clear();
        latest.set(key, cached);
      }
      return { misePath, tool, canUpgrade: true, latestVersion: cached.version };
    });
  return Object.assign(resolve, { invalidate: () => latest.clear() });
}
