import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { toStoredProjectFaviconPath } from "@piedpiper/shared/path";
import { Effect, Fiber, FileSystem, Layer, Path } from "effect";
import { TestClock } from "effect/testing";

import { ProjectFaviconResolver } from "../Services/ProjectFaviconResolver.ts";
import {
  extractIconHref,
  makeProjectFaviconResolver,
  ProjectFaviconResolverLive,
} from "./ProjectFaviconResolver.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectFaviconResolverLive),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "piedpiper-project-favicon-",
  });
});

function pngHeader(size: number): Uint8Array {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(png.buffer).setUint32(16, size);
  new DataView(png.buffer).setUint32(20, size);
  return png;
}

// A one-entry .icns; `ic07` holds a PNG, `it32` stands in for a PNG-less legacy entry.
function icns(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(16 + data.length);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("icns"));
  view.setUint32(4, bytes.length);
  bytes.set(new TextEncoder().encode(type), 8);
  view.setUint32(12, 8 + data.length);
  bytes.set(data, 16);
  return bytes;
}

const writeBinaryFile = Effect.fn("writeBinaryFile")(function* (
  cwd: string,
  relativePath: string,
  contents: Uint8Array,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFile(absolutePath, contents).pipe(Effect.orDie);
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("ProjectFaviconResolverLive", (it) => {
  describe("chosen favicon path", () => {
    const realPathOf = (filePath: string) =>
      Effect.flatMap(FileSystem.FileSystem.asEffect(), (fileSystem) =>
        fileSystem.realPath(filePath).pipe(Effect.orDie),
      );

    it.effect("wins over piedpiper.json and well-known files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "brand/chosen.png", "png");
        yield* writeTextFile(cwd, "brand/config.svg", "<svg/>");
        yield* writeTextFile(cwd, "favicon.svg", "<svg/>");
        yield* writeTextFile(cwd, "piedpiper.json", '{ "iconPath": "brand/config.svg" }');

        expect(yield* resolver.resolvePath(cwd, "brand/chosen.png")).toBe(
          yield* realPathOf(path.join(cwd, "brand/chosen.png")),
        );
      }),
    );

    it.effect("accepts an .avif inside the workspace, and no .icns", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "brand/chosen.avif", "avif");
        yield* writeTextFile(cwd, "brand/chosen.icns", "icns");

        expect(yield* resolver.resolvePath(cwd, "brand/chosen.avif")).toBe(
          yield* realPathOf(path.join(cwd, "brand/chosen.avif")),
        );
        expect(yield* resolver.resolvePath(cwd, "brand/chosen.icns")).toBeNull();
      }),
    );

    it.effect("serves an absolute path outside the workspace", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const pictures = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg/>");
        yield* writeTextFile(pictures, "My Icon.PNG", "png");
        const external = path.join(pictures, "My Icon.PNG");

        expect(yield* resolver.resolvePath(cwd, external)).toBe(yield* realPathOf(external));
      }),
    );

    it.effect("keeps absolute paths out of piedpiper.json iconPath", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const pictures = yield* makeTempDir;
        yield* writeTextFile(pictures, "logo.png", "png");
        yield* writeTextFile(
          cwd,
          "piedpiper.json",
          JSON.stringify({ iconPath: path.join(pictures, "logo.png") }),
        );

        expect(yield* resolver.resolvePath(cwd)).toBeNull();
      }),
    );

    it.effect("rejects a relative path that leaves the workspace, then falls back", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const pictures = yield* makeTempDir;
        yield* writeTextFile(pictures, "logo.png", "png");
        yield* writeTextFile(cwd, "favicon.svg", "<svg/>");
        yield* fileSystem
          .symlink(path.join(pictures, "logo.png"), path.join(cwd, "linked.png"))
          .pipe(Effect.orDie);
        const fallback = yield* resolver.resolvePath(cwd);
        expect(fallback).toContain("favicon.svg");

        const escaping = path.relative(cwd, path.join(pictures, "logo.png"));
        expect(yield* resolver.resolvePath(cwd, escaping)).toBe(fallback);
        expect(yield* resolver.resolvePath(cwd, "linked.png")).toBe(fallback);
      }),
    );

    it.effect(
      "serves an in-repo symlink leaving the workspace only once it is stored as real",
      () =>
        Effect.gen(function* () {
          const resolver = yield* ProjectFaviconResolver;
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const cwd = yield* realPathOf(yield* makeTempDir);
          const outside = yield* makeTempDir;
          yield* writeTextFile(outside, "brand/logo.png", "png");
          yield* writeTextFile(cwd, "favicon.svg", "<svg/>");
          yield* fileSystem
            .symlink(path.join(outside, "brand"), path.join(cwd, "brand"))
            .pipe(Effect.orDie);
          const picked = path.join(cwd, "brand/logo.png");
          const realPicked = yield* realPathOf(picked);

          const lexical = toStoredProjectFaviconPath(cwd, picked);
          expect(lexical).toBe("brand/logo.png");
          expect(yield* resolver.resolvePath(cwd, lexical)).toContain("favicon.svg");

          const stored = toStoredProjectFaviconPath(cwd, realPicked);
          expect(stored).toBe(realPicked);
          expect(yield* resolver.resolvePath(cwd, stored)).toBe(realPicked);
        }),
    );

    it.effect("keeps a real in-repo pick relative, and serves it from a linked workspace", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* realPathOf(yield* makeTempDir);
        const links = yield* makeTempDir;
        yield* writeTextFile(cwd, "brand/logo.png", "png");
        const realPicked = yield* realPathOf(path.join(cwd, "brand/logo.png"));
        const linkedCwd = path.join(links, "linked-repo");
        yield* fileSystem.symlink(cwd, linkedCwd).pipe(Effect.orDie);

        const relative = toStoredProjectFaviconPath(cwd, realPicked);
        expect(relative).toBe("brand/logo.png");
        expect(yield* resolver.resolvePath(cwd, relative)).toBe(realPicked);

        const fromLinked = toStoredProjectFaviconPath(linkedCwd, realPicked);
        expect(fromLinked).toBe(realPicked);
        expect(yield* resolver.resolvePath(linkedCwd, fromLinked)).toBe(realPicked);
      }),
    );

    it.effect("refuses a non-image, however it is named or linked", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* writeTextFile(outside, "id_rsa", "secret");
        yield* writeTextFile(outside, "AppIcon.icns", "icns");
        yield* fileSystem.makeDirectory(path.join(outside, "folder.png")).pipe(Effect.orDie);
        yield* fileSystem
          .symlink(path.join(outside, "id_rsa"), path.join(outside, "looks-fine.png"))
          .pipe(Effect.orDie);

        for (const name of ["id_rsa", "AppIcon.icns", "folder.png", "looks-fine.png"]) {
          expect(yield* resolver.resolvePath(cwd, path.join(outside, name))).toBeNull();
        }
      }),
    );

    it.effect("follows a symlink to a real image and returns its target", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* writeTextFile(outside, "real.webp", "webp");
        yield* fileSystem
          .symlink(path.join(outside, "real.webp"), path.join(outside, "link.png"))
          .pipe(Effect.orDie);

        expect(yield* resolver.resolvePath(cwd, path.join(outside, "link.png"))).toBe(
          yield* realPathOf(path.join(outside, "real.webp")),
        );
      }),
    );

    it.effect("falls back to discovery when the chosen file is missing", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg/>");

        for (const missing of ["brand/gone.png", path.join(cwd, "gone.png")]) {
          expect(yield* resolver.resolvePath(cwd, missing)).toContain("favicon.svg");
        }
      }),
    );

    it.effect("applies a change or clear at once despite the discovery cache", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const pictures = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg/>");
        yield* writeTextFile(pictures, "one.png", "png");
        yield* writeTextFile(pictures, "two.png", "png");
        const discovered = yield* resolver.resolvePath(cwd);
        expect(discovered).toContain("favicon.svg");

        const one = path.join(pictures, "one.png");
        const two = path.join(pictures, "two.png");
        expect(yield* resolver.resolvePath(cwd, one)).toBe(yield* realPathOf(one));
        expect(yield* resolver.resolvePath(cwd, two)).toBe(yield* realPathOf(two));
        expect(yield* resolver.resolvePath(cwd, null)).toBe(discovered);
        expect(yield* resolver.resolvePath(cwd)).toBe(discovered);

        yield* fileSystem.remove(two);
        expect(yield* resolver.resolvePath(cwd, two)).toBe(discovered);
      }),
    );
  });

  describe("resolvePath", () => {
    it.effect("prefers well-known favicon files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("favicon.svg");
      }),
    );

    it.effect("prefers the piedpiper.json iconPath over well-known files", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");
        yield* writeTextFile(cwd, "brand/mark.png", "png");
        yield* writeTextFile(cwd, "piedpiper.json", '{ "iconPath": "brand/mark.png" }');

        expect(yield* resolver.resolvePath(cwd)).toBe(
          yield* fileSystem.realPath(path.join(cwd, "brand/mark.png")),
        );
      }),
    );

    it.effect("falls back to well-known files when the iconPath is unusable", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");
        yield* writeTextFile(cwd, "piedpiper.json", '{ "iconPath": "../outside.png" }');

        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "favicon.svg"));
      }),
    );

    it.effect("resolves icon hrefs from project source files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="/brand/logo.svg">');
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("public/brand/logo.svg");
      }),
    );

    it.effect("resolves object-literal icon metadata from route files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "src/routes/__root.tsx",
          `export const Route = createRootRoute({
  head: () => ({
    links: [
      { rel: "stylesheet", href: "/app.css" },
      { rel: "icon", href: "/brand/logo.svg" },
    ],
  }),
});`,
        );
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        expect(yield* resolver.resolvePath(cwd)).toContain("public/brand/logo.svg");
      }),
    );

    it.effect("uses a JetBrains .idea/icon.svg after the web-app paths", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".idea/icon.svg", "<svg>idea</svg>");

        expect(yield* resolver.resolvePath(cwd)).toContain(".idea/icon.svg");

        const otherCwd = yield* makeTempDir;
        yield* writeTextFile(otherCwd, ".idea/icon.svg", "<svg>idea</svg>");
        yield* writeTextFile(otherCwd, "assets/logo.png", "png");
        expect(yield* resolver.resolvePath(otherCwd)).toContain("assets/logo.png");
      }),
    );

    it.effect("prefers an icon declared in index.html over .idea and .icns fallbacks", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".idea/icon.svg", "<svg>idea</svg>");
        yield* writeBinaryFile(cwd, "Resources/AppIcon.icns", icns("ic07", pngHeader(128)));
        yield* writeTextFile(cwd, "src/assets/brand.svg", "<svg>brand</svg>");
        yield* writeTextFile(
          cwd,
          "index.html",
          '<link rel="icon" type="image/svg+xml" href="/src/assets/brand.svg">',
        );

        expect(yield* resolver.resolvePath(cwd)).toContain("src/assets/brand.svg");
      }),
    );

    it.effect("uses a macOS AppIcon.icns, preferring Resources/", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeBinaryFile(cwd, "AppIcon.icns", icns("ic07", pngHeader(128)));
        yield* writeBinaryFile(cwd, "Resources/AppIcon.icns", icns("ic07", pngHeader(128)));

        expect(yield* resolver.resolvePath(cwd)).toContain("Resources/AppIcon.icns");
      }),
    );

    it.effect("skips an .icns with no embedded PNG", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeBinaryFile(cwd, "Resources/AppIcon.icns", icns("it32", new Uint8Array(32)));
        yield* writeBinaryFile(cwd, "AppIcon.icns", icns("ic07", pngHeader(128)));

        expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "AppIcon.icns"));

        const legacyOnly = yield* makeTempDir;
        yield* writeBinaryFile(legacyOnly, "AppIcon.icns", icns("it32", new Uint8Array(32)));
        expect(yield* resolver.resolvePath(legacyOnly)).toBeNull();
      }),
    );

    it.effect("scans large icon sources without an icon in reasonable time", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        const filler = `<p>${"companion guide ".repeat(24)}</p>\n`;
        yield* writeTextFile(
          cwd,
          "index.html",
          `<!doctype html><html><body>\n${filler.repeat(1200)}</body></html>`,
        );

        const startedAt = performance.now();
        expect(yield* resolver.resolvePath(cwd)).toBeNull();
        expect(performance.now() - startedAt).toBeLessThan(5_000);
      }),
    );

    it.effect("scans many unterminated <link tags in linear time", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", "<link rel=x ".repeat(40_000));
        const closedLater = yield* makeTempDir;
        yield* writeTextFile(closedLater, "index.html", `${"<link rel=x ".repeat(40_000)}>`);

        const startedAt = performance.now();
        expect(yield* resolver.resolvePath(cwd)).toBeNull();
        expect(yield* resolver.resolvePath(closedLater)).toBeNull();
        expect(performance.now() - startedAt).toBeLessThan(1_000);
      }),
    );

    it.effect("returns null when no icon is present", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).toBeNull();
      }),
    );
  });
});

it.layer(NodeServices.layer)("ProjectFaviconResolverLive cache", (it) => {
  it.effect("reuses a cached hit and re-resolves when the icon is deleted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const resolver = yield* ProjectFaviconResolver;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "public/favicon.png", "png");

      const first = yield* resolver.resolvePath(cwd);
      expect(first).toContain("public/favicon.png");

      // A higher-priority icon added later is not picked up while the hit is cached.
      yield* writeTextFile(cwd, "favicon.svg", "<svg/>");
      expect(yield* resolver.resolvePath(cwd)).toBe(first);

      yield* fileSystem.remove(first!);
      const afterDelete = yield* resolver.resolvePath(cwd);
      expect(afterDelete).toContain("favicon.svg");
      expect(afterDelete).not.toContain("public");
    }).pipe(Effect.provide(ProjectFaviconResolverLive)),
  );

  it.effect("re-resolves a cached result when piedpiper.json changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resolver = yield* ProjectFaviconResolver;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "favicon.svg", "<svg/>");
      yield* writeTextFile(cwd, "brand/mark.png", "png");

      expect(yield* resolver.resolvePath(cwd)).toContain("favicon.svg");

      yield* writeTextFile(cwd, "piedpiper.json", '{ "iconPath": "brand/mark.png" }');
      expect(yield* resolver.resolvePath(cwd)).toBe(
        yield* fileSystem.realPath(path.join(cwd, "brand/mark.png")),
      );

      const missCwd = yield* makeTempDir;
      expect(yield* resolver.resolvePath(missCwd)).toBeNull();
      yield* writeTextFile(missCwd, "logo.svg", "<svg/>");
      yield* writeTextFile(missCwd, "piedpiper.json", '{ "iconPath": "logo.svg" }');
      expect(yield* resolver.resolvePath(missCwd)).toContain("logo.svg");
    }).pipe(Effect.provide(ProjectFaviconResolverLive)),
  );

  it.effect("re-resolves a cached hit once its TTL expires", () =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "public/favicon.png", "png");

      const first = yield* resolver.resolvePath(cwd);
      expect(first).toContain("public/favicon.png");

      yield* writeTextFile(cwd, "favicon.svg", "<svg/>");
      yield* TestClock.adjust("9 minutes");
      expect(yield* resolver.resolvePath(cwd)).toBe(first);

      yield* TestClock.adjust("2 minutes");
      const refreshed = yield* resolver.resolvePath(cwd);
      expect(refreshed).toContain("favicon.svg");
      expect(refreshed).not.toContain("public");
    }).pipe(Effect.provide(ProjectFaviconResolverLive)),
  );

  it.effect("does not fail concurrent callers when the first caller is interrupted", () =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "assets/logo.png", "png");

      // The first caller starts the shared lookup and suspends on file I/O.
      const first = yield* resolver
        .resolvePath(cwd)
        .pipe(Effect.forkChild({ startImmediately: true }));
      const second = yield* resolver
        .resolvePath(cwd)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(first);

      expect(yield* Fiber.join(second)).toContain("assets/logo.png");
    }).pipe(Effect.provide(ProjectFaviconResolverLive)),
  );

  it.effect("caches misses briefly, then finds a newly added icon", () =>
    Effect.gen(function* () {
      const resolver = yield* ProjectFaviconResolver;
      const cwd = yield* makeTempDir;

      expect(yield* resolver.resolvePath(cwd)).toBeNull();
      yield* writeTextFile(cwd, "favicon.svg", "<svg/>");
      expect(yield* resolver.resolvePath(cwd)).toBeNull();

      yield* TestClock.adjust("2 minutes");
      expect(yield* resolver.resolvePath(cwd)).toContain("favicon.svg");
    }).pipe(Effect.provide(ProjectFaviconResolverLive)),
  );
});

describe("extractIconHref", () => {
  it("reads html link tags with rel and href in any order", () => {
    expect(extractIconHref('<link href="/a.svg" rel="icon">')).toBe("/a.svg");
    expect(extractIconHref("<link rel='shortcut icon' href='/b.ico?v=1'>")).toBe("/b.ico");
  });

  it("reads object metadata when href precedes rel or sits beside nested objects", () => {
    expect(extractIconHref(`[{ href: "/a.svg", rel: "shortcut icon" }]`)).toBe("/a.svg");
    expect(extractIconHref(`[{ attributes: {}, rel: "icon", href: "/b.svg" }]`)).toBe("/b.svg");
  });

  it("skips a run holding rel but no href and keeps scanning", () => {
    expect(extractIconHref(`[{ rel: "icon" }, { rel: "icon", href: "/c.svg" }]`)).toBe("/c.svg");
  });

  it("skips non-icon link tags, including ones that contain a stray `<link`", () => {
    expect(
      extractIconHref('<link rel="stylesheet" href="/a.css"><LINK REL="icon" HREF="/b.svg">'),
    ).toBe("/b.svg");
    expect(
      extractIconHref('<link rel="preload" <link href="/c.svg"><link rel="icon" href="/d.svg">'),
    ).toBe("/d.svg");
    expect(extractIconHref('<link rel="icon" href="/unterminated.svg"')).toBeNull();
  });

  it("does not pair rel and href from different objects", () => {
    expect(extractIconHref(`[{ rel: "icon" }, { href: "/d.svg" }]`)).toBeNull();
  });
});

it.layer(NodeServices.layer)("ProjectFaviconResolver concurrency", (it) => {
  const withFileSystem = (overrides: Partial<FileSystem.FileSystem>) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return yield* makeProjectFaviconResolver.pipe(
        Effect.provideService(FileSystem.FileSystem, { ...fileSystem, ...overrides }),
      );
    });

  it.effect("probes well-known candidates concurrently", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* makeTempDir;
      let inFlight = 0;
      let peakInFlight = 0;
      const resolver = yield* withFileSystem({
        stat: (filePath) =>
          Effect.suspend(() => {
            inFlight += 1;
            peakInFlight = Math.max(peakInFlight, inFlight);
            return Effect.yieldNow.pipe(Effect.andThen(fileSystem.stat(filePath)));
          }).pipe(Effect.ensuring(Effect.sync(() => (inFlight -= 1)))),
      });

      expect(yield* resolver.resolvePath(cwd)).toBeNull();
      expect(peakInFlight).toBeGreaterThan(1);
    }),
  );

  it.effect("returns a hit without waiting for lower-ranked probes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "favicon.ico", "ico");
      const stuckPath = path.join(cwd, "favicon.png");
      const resolver = yield* withFileSystem({
        stat: (filePath) => (filePath === stuckPath ? Effect.never : fileSystem.stat(filePath)),
      });

      expect(yield* resolver.resolvePath(cwd)).toBe(path.join(cwd, "favicon.ico"));
    }),
  );

  it.effect("keeps priority order when a higher-ranked probe is slower", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeTempDir;
      yield* writeTextFile(cwd, "favicon.svg", "<svg/>");
      yield* writeTextFile(cwd, "assets/logo.png", "png");
      const slowPath = path.join(cwd, "favicon.svg");
      const resolver = yield* withFileSystem({
        stat: (filePath) =>
          filePath === slowPath
            ? Effect.yieldNow.pipe(
                Effect.repeat({ times: 20 }),
                Effect.andThen(fileSystem.stat(filePath)),
              )
            : fileSystem.stat(filePath),
      });

      expect(yield* resolver.resolvePath(cwd)).toBe(slowPath);
    }),
  );
});
