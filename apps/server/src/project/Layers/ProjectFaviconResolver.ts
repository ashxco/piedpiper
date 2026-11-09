import {
  Cache,
  Cause,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
} from "effect";

import { PROJECT_CONFIG_FILE_NAME } from "@piedpiper/contracts";

import { isIcnsPath, readIcnsFaviconPng } from "../icns.ts";
import { fileInfoFingerprint, makeProjectConfigFileLoader } from "./ProjectConfigFileLoader.ts";
import {
  ProjectFaviconResolver,
  type ProjectFaviconResolverShape,
} from "../Services/ProjectFaviconResolver.ts";

// A miss costs ~23 stats plus 7 source reads, and the sidebar requests one icon per project,
// so results are cached per cwd and re-validated by statting the icon and piedpiper.json.
const FAVICON_CACHE_CAPACITY = 512;
const FAVICON_POSITIVE_CACHE_TTL = Duration.minutes(10);
const FAVICON_NEGATIVE_CACHE_TTL = Duration.minutes(1);

// Well-known favicon paths checked in order.
const FAVICON_CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
] as const;

// Non-web icons, tried only after the source files so a declared <link rel="icon"> wins.
const FALLBACK_CANDIDATES = [".idea/icon.svg", "Resources/AppIcon.icns", "AppIcon.icns"] as const;

// A chosen icon can be anywhere on disk and the route serves it, so only web image types qualify.
const CUSTOM_FAVICON_EXTENSIONS = new Set([
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

// Files that may contain a <link rel="icon"> or icon metadata declaration.
const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
] as const;

// Tags are scanned one at a time (rel/href in any order); per-tag lookaheads over `[^>]*` were quadratic.
const LINK_TAG_START_RE = /<link\b/gi;
const LINK_TAG_MAX_LENGTH = 4096;
const LINK_REL_ICON_RE = /\brel=["'](?:icon|shortcut icon)["']/i;
const LINK_HREF_RE = /\bhref=["']([^"'?>]+)/i;
// Object metadata is matched per brace-free run: one unanchored pattern would rescan from every offset.
const ICON_REL_RE = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/i;
const ICON_HREF_RE = /\bhref\s*:\s*["']([^"'?]+)/i;

function extractLinkIconHref(source: string): string | null {
  LINK_TAG_START_RE.lastIndex = 0;
  for (let match = LINK_TAG_START_RE.exec(source); match; match = LINK_TAG_START_RE.exec(source)) {
    const end = source.indexOf(">", match.index);
    // Unterminated tags never matched before, and nothing later can close.
    if (end === -1) return null;
    const tag = source.slice(match.index, Math.min(end, match.index + LINK_TAG_MAX_LENGTH));
    if (LINK_REL_ICON_RE.test(tag)) {
      const href = tag.match(LINK_HREF_RE)?.[1];
      if (href) return href;
    }
    // A `<link` nested before this `>` sees a suffix of the same tag, so skip past it.
    LINK_TAG_START_RE.lastIndex = end + 1;
  }
  return null;
}

export function extractIconHref(source: string): string | null {
  const htmlHref = extractLinkIconHref(source);
  if (htmlHref) return htmlHref;
  // A run holding `rel` but no href falls through to the next run.
  for (const run of source.split("}")) {
    if (!ICON_REL_RE.test(run)) continue;
    const hrefMatch = run.match(ICON_HREF_RE);
    if (hrefMatch?.[1]) return hrefMatch[1];
  }
  return null;
}

export const makeProjectFaviconResolver = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectConfigFileLoader = yield* makeProjectConfigFileLoader;

  const resolveIconHref = (projectCwd: string, href: string): string[] => {
    const clean = href.replace(/^\//, "");
    return [path.join(projectCwd, "public", clean), path.join(projectCwd, clean)];
  };

  const isPathWithinProject = (projectCwd: string, candidatePath: string): boolean => {
    const relative = path.relative(path.resolve(projectCwd), path.resolve(candidatePath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const findExistingFile = Effect.fn("ProjectFaviconResolver.findExistingFile")(function* (
    projectCwd: string,
    candidates: ReadonlyArray<string>,
  ): Effect.fn.Return<string | null> {
    for (const candidate of candidates) {
      if (!isPathWithinProject(projectCwd, candidate)) {
        continue;
      }
      const stats = yield* fileSystem
        .stat(candidate)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (stats?.type === "File") {
        return candidate;
      }
    }
    return null;
  });

  // An .icns with no embedded PNG cannot be served, so it counts as a miss.
  const isServableIcon = (candidate: string): Effect.Effect<boolean> =>
    isIcnsPath(candidate)
      ? readIcnsFaviconPng(candidate).pipe(
          Effect.map((png) => png !== null),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        )
      : Effect.succeed(true);

  const findIconFromSource = Effect.fn("ProjectFaviconResolver.findIconFromSource")(function* (
    cwd: string,
    sourceFile: string,
  ): Effect.fn.Return<string | null> {
    const source = yield* fileSystem
      .readFileString(path.join(cwd, sourceFile))
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!source) {
      return null;
    }
    const href = extractIconHref(source);
    if (!href) {
      return null;
    }
    return yield* findExistingFile(cwd, resolveIconHref(cwd, href));
  });

  // Starts every probe at once and joins in list order, so a miss costs one round of
  // filesystem latency; on a hit the scope interrupts the lower-ranked probes.
  const firstInOrder = <A>(
    items: ReadonlyArray<A>,
    probe: (item: A) => Effect.Effect<string | null>,
  ): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      const fibers = yield* Effect.forEach(items, (item) => Effect.forkScoped(probe(item)));
      for (const fiber of fibers) {
        const found = yield* Fiber.join(fiber);
        if (found) {
          return found;
        }
      }
      return null;
    }).pipe(Effect.scoped);

  const resolvePathUncached = Effect.fn("ProjectFaviconResolver.resolvePathUncached")(function* (
    cwd: string,
  ): Effect.fn.Return<string | null> {
    // A piedpiper.json iconPath takes precedence over the well-known locations.
    const projectConfig = yield* projectConfigFileLoader.load(cwd);
    if (Option.isSome(projectConfig) && projectConfig.value.iconPath !== undefined) {
      const configured = yield* projectConfigFileLoader.resolveIconPath(
        cwd,
        projectConfig.value.iconPath,
      );
      if (configured) {
        return configured;
      }
    }
    const wellKnown = yield* firstInOrder(FAVICON_CANDIDATES, (candidate) =>
      findExistingFile(cwd, [path.join(cwd, candidate)]),
    );
    if (wellKnown) {
      return wellKnown;
    }
    const fromSource = yield* firstInOrder(ICON_SOURCE_FILES, (sourceFile) =>
      findIconFromSource(cwd, sourceFile),
    );
    if (fromSource) {
      return fromSource;
    }
    return yield* firstInOrder(FALLBACK_CANDIDATES, (candidate) =>
      findExistingFile(cwd, [path.join(cwd, candidate)]).pipe(
        Effect.flatMap((found) =>
          found === null
            ? Effect.succeed(null)
            : isServableIcon(found).pipe(Effect.map((servable) => (servable ? found : null))),
        ),
      ),
    );
  });

  const statConfigFingerprint = (cwd: string): Effect.Effect<string | null> =>
    fileSystem.stat(path.join(cwd, PROJECT_CONFIG_FILE_NAME)).pipe(
      Effect.map(fileInfoFingerprint),
      Effect.orElseSucceed(() => null),
    );

  interface CachedFavicon {
    readonly iconPath: string | null;
    readonly configFingerprint: string | null;
  }

  const faviconCache = yield* Cache.makeWith<string, CachedFavicon>({
    // The fingerprint is taken first, so an edit made mid-resolve is noticed on the next request.
    lookup: (cwd) =>
      Effect.all({
        configFingerprint: statConfigFingerprint(cwd),
        iconPath: resolvePathUncached(cwd),
      }),
    capacity: FAVICON_CACHE_CAPACITY,
    timeToLive: Exit.match({
      onSuccess: (value: CachedFavicon) =>
        value.iconPath === null ? FAVICON_NEGATIVE_CACHE_TTL : FAVICON_POSITIVE_CACHE_TTL,
      onFailure: () => Duration.zero,
    }),
  });

  // Cache.get settles waiters with the first caller's exit, so another caller's interruption is retried.
  const getCached = (cwd: string): Effect.Effect<CachedFavicon> =>
    Cache.get(faviconCache, cwd).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? // restore fails right away if this fiber itself was interrupted.
            Effect.uninterruptibleMask((restore) => restore(Effect.suspend(() => getCached(cwd))))
          : Effect.failCause(cause),
      ),
    );

  // Checked per request and never cached, so choosing or clearing an icon applies at once.
  const resolveCustomFavicon = Effect.fn("ProjectFaviconResolver.resolveCustomFavicon")(function* (
    cwd: string,
    faviconPath: string,
  ): Effect.fn.Return<string | null> {
    const isAllowedImage = (filePath: string) =>
      CUSTOM_FAVICON_EXTENSIONS.has(path.extname(filePath).toLowerCase());
    if (!isAllowedImage(faviconPath)) {
      return null;
    }
    const realTarget = path.isAbsolute(faviconPath)
      ? yield* fileSystem.realPath(faviconPath).pipe(Effect.orElseSucceed(() => null))
      : yield* projectConfigFileLoader.resolveIconPath(cwd, faviconPath);
    if (realTarget === null || !isAllowedImage(realTarget)) {
      return null;
    }
    const stats = yield* fileSystem.stat(realTarget).pipe(Effect.orElseSucceed(() => null));
    // The checked real path is what gets served, so a later symlink swap cannot redirect it.
    return stats?.type === "File" ? realTarget : null;
  });

  const resolvePath: ProjectFaviconResolverShape["resolvePath"] = Effect.fn(
    "ProjectFaviconResolver.resolvePath",
  )(function* (cwd: string, faviconPath?: string | null): Effect.fn.Return<string | null> {
    if (faviconPath) {
      const custom = yield* resolveCustomFavicon(cwd, faviconPath);
      if (custom !== null) {
        return custom;
      }
    }
    const cached = yield* getCached(cwd);
    // A deleted icon or an edited piedpiper.json re-resolves immediately rather than after the TTL.
    const [configFingerprint, iconStats] = yield* Effect.all(
      [
        statConfigFingerprint(cwd),
        cached.iconPath === null
          ? Effect.succeed(null)
          : fileSystem.stat(cached.iconPath).pipe(Effect.orElseSucceed(() => null)),
      ],
      { concurrency: "unbounded" },
    );
    const iconStillValid = cached.iconPath === null || iconStats?.type === "File";
    if (configFingerprint === cached.configFingerprint && iconStillValid) {
      return cached.iconPath;
    }
    yield* Cache.invalidate(faviconCache, cwd);
    return (yield* getCached(cwd)).iconPath;
  });

  return {
    resolvePath,
  } satisfies ProjectFaviconResolverShape;
});

export const ProjectFaviconResolverLive = Layer.effect(
  ProjectFaviconResolver,
  makeProjectFaviconResolver,
);
