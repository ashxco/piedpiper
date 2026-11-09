import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerConfig } from "../../config.ts";
import { cloneCheckout, CheckoutCloneError } from "./CheckoutCloner.ts";
import { makeGitCore } from "./GitCore.ts";
import { makeWorktreeCheckoutCache } from "./WorktreeCheckoutCache.ts";

const layerTest = ServerConfig.layerTest(process.cwd(), {
  prefix: "pied-worktree-cache-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));
const sh = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "worktree-checkout-cache-" });
  const repo = NodePath.join(root, "repo");
  NodeFS.mkdirSync(repo);
  sh(repo, ["init", "-q", "-b", "main"]);
  sh(repo, ["config", "user.name", "Test"]);
  sh(repo, ["config", "user.email", "test@example.test"]);
  sh(repo, ["config", "filter.probe.smudge", "cat"]);
  sh(repo, ["config", "filter.probe.clean", "cat"]);
  NodeFS.writeFileSync(
    NodePath.join(repo, ".gitattributes"),
    "*.bat text eol=crlf\n*.gen filter=probe\n",
  );
  NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "# test\n");
  NodeFS.writeFileSync(NodePath.join(repo, "run.bat"), "echo hi\r\n");
  NodeFS.mkdirSync(NodePath.join(repo, "src"));
  NodeFS.writeFileSync(NodePath.join(repo, "src", "tool.sh"), "#!/bin/sh\n", { mode: 0o755 });
  NodeFS.symlinkSync("README.md", NodePath.join(repo, "readme-link"));
  sh(repo, ["add", "."]);
  sh(repo, ["commit", "-qm", "initial"]);
  const baseDriver = yield* makeGitCore();
  const driver = yield* makeGitCore({
    executeOverride: (input) =>
      baseDriver.execute({
        ...input,
        env: { ...input.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      }),
  });
  const cacheDir = NodePath.join(root, "cache");
  const cache = (yield* makeWorktreeCheckoutCache({
    cacheDir,
    execute: (input) =>
      driver.execute({
        ...input,
        env: { ...input.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      }),
    clone:
      process.platform === "darwin"
        ? cloneCheckout
        : (source, destination) =>
            Effect.try({
              try: () => void NodeChildProcess.execFileSync("cp", ["-a", source, destination]),
              catch: (cause) => new CheckoutCloneError({ source, destination, cause }),
            }),
  }))!;
  const stockCreates = new Set<string>();
  const create = (name: string, branch = "main", fastCheckout = true) =>
    Effect.gen(function* () {
      const path = NodePath.join(root, name);
      const cloned =
        fastCheckout &&
        (yield* cache.create({
          cwd: repo,
          worktreePath: path,
          refName: branch,
          newBranch: name,
          checkoutWorkers: "0",
        }));
      if (!cloned) {
        stockCreates.add(name);
        yield* driver.createWorktree({ cwd: repo, branch, newBranch: name, path });
      }
      return path;
    });
  return {
    root,
    repo,
    create,
    checkedOutWithGit: (name: string) => stockCreates.has(name),
    cacheDir,
    driver,
    cache,
    build: (path: string) => cache.build(path, 0),
  };
});

// Every tracked file and its type, mode and contents, so two checkouts can be compared.
const snapshot = (worktreePath: string) =>
  sh(worktreePath, ["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((name) => {
      const file = NodePath.join(worktreePath, name);
      const stat = NodeFS.lstatSync(file);
      return [
        name,
        stat.mode,
        stat.isSymbolicLink() ? NodeFS.readlinkSync(file) : NodeFS.readFileSync(file, "utf8"),
      ];
    });

// Git's recorded stat data matches each file, so status will not re-read them.
const indexMatchesFiles = (worktreePath: string) => {
  const debug = sh(worktreePath, ["ls-files", "--debug"]);
  for (const block of debug.split(/\n(?=\S)/)) {
    const name = block.split("\n")[0]!;
    const ino = Number(block.match(/ino: (\d+)/)![1]);
    const size = Number(block.match(/size: (\d+)/)![1]);
    const stat = NodeFS.lstatSync(NodePath.join(worktreePath, name), { bigint: true });
    if (ino !== Number(stat.ino & 0xffff_ffffn) || size !== Number(stat.size)) return false;
  }
  return true;
};

// The feature is macOS-only; the fixtures need symlinks.
describe.skipIf(process.platform === "win32")("worktree checkout cache", () => {
  it.effect("clones a cached checkout that matches what git worktree add writes", () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const stock = yield* fixture.create("stock", "main", false);
      yield* fixture.build(stock);

      const fast = yield* fixture.create("fast");
      assert.isFalse(fixture.checkedOutWithGit("fast"));
      assert.deepStrictEqual(snapshot(fast), snapshot(stock));
      assert.equal(sh(fast, ["status", "--porcelain"]), "");
      assert.equal(sh(fast, ["rev-parse", "--abbrev-ref", "HEAD"]), "fast");
      assert.isTrue(indexMatchesFiles(fast));
      // The clone has its own files: editing one leaves the cache and the other worktree alone.
      NodeFS.writeFileSync(NodePath.join(fast, "README.md"), "changed\n");
      assert.equal(sh(stock, ["status", "--porcelain"]), "");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("moves an older cached checkout to the requested commit", () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* fixture.build(yield* fixture.create("base", "main", false));
      NodeFS.writeFileSync(NodePath.join(fixture.repo, "README.md"), "# newer\n");
      NodeFS.writeFileSync(NodePath.join(fixture.repo, "added.txt"), "new file\n");
      NodeFS.rmSync(NodePath.join(fixture.repo, "run.bat"));
      sh(fixture.repo, ["add", "-A"]);
      sh(fixture.repo, ["commit", "-qm", "newer"]);

      const fast = yield* fixture.create("fast");
      assert.isFalse(fixture.checkedOutWithGit("fast"));
      const stock = yield* fixture.create("stock", "main", false);
      assert.deepStrictEqual(snapshot(fast), snapshot(stock));
      assert.equal(sh(fast, ["status", "--porcelain"]), "");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("caches a far newer commit by moving the older cached checkout", () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* fixture.build(yield* fixture.create("base", "main", false));
      NodeFS.mkdirSync(NodePath.join(fixture.repo, "many"));
      for (let index = 0; index < 600; index++) {
        NodeFS.writeFileSync(NodePath.join(fixture.repo, "many", `${index}.txt`), `${index}\n`);
      }
      NodeFS.writeFileSync(NodePath.join(fixture.repo, "README.md"), "# newer\n");
      sh(fixture.repo, ["add", "-A"]);
      sh(fixture.repo, ["commit", "-qm", "many files"]);
      const stock = yield* fixture.create("stock", "main", false);
      yield* fixture.build(stock);

      const fast = yield* fixture.create("fast");
      assert.isFalse(fixture.checkedOutWithGit("fast"));
      assert.deepStrictEqual(snapshot(fast), snapshot(stock));
      assert.equal(sh(fast, ["status", "--porcelain"]), "");
      assert.isTrue(indexMatchesFiles(fast));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("runs the post-checkout hook as git worktree add would", () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* fixture.build(yield* fixture.create("base", "main", false));
      const marker = NodePath.join(fixture.root, "hook-args");
      const hook = NodePath.join(fixture.repo, ".git", "hooks", "post-checkout");
      NodeFS.writeFileSync(hook, `#!/bin/sh\necho "$@" > "${marker}"\n`, { mode: 0o755 });

      yield* fixture.create("fast");
      assert.isFalse(fixture.checkedOutWithGit("fast"));
      const commit = sh(fixture.repo, ["rev-parse", "main"]);
      assert.equal(NodeFS.readFileSync(marker, "utf8").trim(), `${"0".repeat(40)} ${commit} 1`);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("checks out with Git when the checkout adds a post-index-change hook", () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const marker = NodePath.join(fixture.root, "index-hook-runs");
      NodeFS.mkdirSync(NodePath.join(fixture.repo, ".hooks"));
      const hook = NodePath.join(fixture.repo, ".hooks", "post-index-change");
      NodeFS.writeFileSync(hook, `#!/bin/sh\necho ran >> "${marker}"\n`);
      sh(fixture.repo, ["add", "--chmod=+x", hook]);
      sh(fixture.repo, ["commit", "-qm", "tracked hooks"]);
      yield* fixture.build(yield* fixture.create("base", "main", false));
      sh(fixture.repo, ["config", "core.hooksPath", ".hooks"]);
      NodeFS.rmSync(marker, { force: true });

      yield* fixture.create("fallback");
      assert.isTrue(fixture.checkedOutWithGit("fallback"));
      assert.isTrue(NodeFS.existsSync(marker));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("clones the branch Git checks out when a tag has the same name", () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      sh(fixture.repo, ["tag", "fast"]);
      NodeFS.writeFileSync(NodePath.join(fixture.repo, "README.md"), "# newer\n");
      sh(fixture.repo, ["commit", "-qam", "newer"]);
      const stock = yield* fixture.create("stock", "main", false);
      yield* fixture.build(stock);

      const fast = yield* fixture.create("fast");
      assert.isFalse(fixture.checkedOutWithGit("fast"));
      assert.deepStrictEqual(snapshot(fast), snapshot(stock));
      assert.equal(sh(fast, ["status", "--porcelain"]), "");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("does not cache checkouts whose attributes name a filter", () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      NodeFS.writeFileSync(NodePath.join(fixture.repo, ".gitattributes"), "*.bin filter=lfs\n");
      NodeFS.writeFileSync(NodePath.join(fixture.repo, "asset.bin"), "pointer\n");
      sh(fixture.repo, ["add", "-A"]);
      sh(fixture.repo, ["commit", "-qm", "lfs"]);
      yield* fixture.build(yield* fixture.create("stock", "main", false));
      yield* fixture.create("next");
      assert.isTrue(fixture.checkedOutWithGit("next"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  const cacheEntry = (fixture: { cacheDir: string }) => {
    const [bucket] = NodeFS.readdirSync(fixture.cacheDir);
    const [entry] = NodeFS.readdirSync(NodePath.join(fixture.cacheDir, bucket!));
    return NodePath.join(fixture.cacheDir, bucket!, entry!, "files");
  };

  it.effect.each([
    {
      name: "a cached file changed",
      change: (fixture: { cacheDir: string; repo: string; root: string }) =>
        NodeFS.writeFileSync(NodePath.join(cacheEntry(fixture), "README.md"), "tampered with\n"),
    },
    {
      name: "a file was added to the cache",
      change: (fixture: { cacheDir: string; repo: string; root: string }) =>
        NodeFS.writeFileSync(NodePath.join(cacheEntry(fixture), "src", "extra.txt"), "extra\n"),
    },
    {
      name: "the repository's checkout settings changed",
      change: (fixture: { cacheDir: string; repo: string; root: string }) =>
        sh(fixture.repo, ["config", "core.autocrlf", "true"]),
    },
    {
      // Moving the cached checkout forward would keep README.md's old line endings.
      name: "attributes changed since the cached commit",
      change: (fixture: { cacheDir: string; repo: string; root: string }) => {
        NodeFS.appendFileSync(
          NodePath.join(fixture.repo, ".gitattributes"),
          "*.md text eol=crlf\n",
        );
        sh(fixture.repo, ["commit", "-qam", "crlf markdown"]);
      },
    },
    {
      // On a case-insensitive volume the new file would land in the cached `src` folder.
      name: "a new folder's name differs only in case",
      change: (fixture: { cacheDir: string; repo: string; root: string }) => {
        // Plumbing, because a case-insensitive volume cannot hold both folders.
        NodeFS.writeFileSync(NodePath.join(fixture.root, "b.txt"), "b\n");
        const blob = sh(fixture.repo, ["hash-object", "-w", NodePath.join(fixture.root, "b.txt")]);
        sh(fixture.repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},Src/b.txt`]);
        sh(fixture.repo, ["commit", "-qm", "case folder"]);
      },
    },
    {
      // Git would run this hook during its own checkout, with its own environment.
      name: "the move adds a post-index-change hook",
      change: (fixture: { cacheDir: string; repo: string; root: string }) => {
        const hook = NodePath.join(fixture.repo, ".hooks", "post-index-change");
        NodeFS.mkdirSync(NodePath.dirname(hook));
        NodeFS.writeFileSync(hook, "#!/bin/sh\n");
        sh(fixture.repo, ["add", "--chmod=+x", hook]);
        sh(fixture.repo, ["commit", "-qm", "hook"]);
        sh(fixture.repo, ["config", "core.hooksPath", ".hooks"]);
      },
    },
    {
      // The cached tree has the rule but no matching file; the move would run the filter itself.
      name: "the move adds a file that uses a filter",
      change: (fixture: { cacheDir: string; repo: string; root: string }) => {
        NodeFS.writeFileSync(NodePath.join(fixture.repo, "asset.gen"), "generated\n");
        sh(fixture.repo, ["add", "-A"]);
        sh(fixture.repo, ["commit", "-qm", "generated asset"]);
      },
    },
  ])("checks out with Git when $name", ({ change }) =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      yield* fixture.build(yield* fixture.create("base", "main", false));
      change(fixture);

      const created = yield* fixture.create("fallback");
      assert.isTrue(fixture.checkedOutWithGit("fallback"));
      const stock = yield* fixture.create("stock", "main", false);
      assert.deepStrictEqual(snapshot(created), snapshot(stock));
      assert.equal(sh(created, ["status", "--porcelain"]), "");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});

it.effect("removes an interrupted clone registration and branch before Git fallback", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* fixture.build(yield* fixture.create("base", "main", false));
    let clones = 0;
    const cache = (yield* makeWorktreeCheckoutCache({
      cacheDir: fixture.cacheDir,
      execute: fixture.driver.execute,
      clone: (source, destination) => {
        clones++;
        return Effect.fail(new CheckoutCloneError({ source, destination }));
      },
    }))!;
    const path = NodePath.join(fixture.root, "failed-clone");
    assert.isFalse(
      yield* cache.create({
        cwd: fixture.repo,
        worktreePath: path,
        refName: "main",
        newBranch: "failed-clone",
        checkoutWorkers: "0",
      }),
    );
    assert.isAbove(clones, 0);
    assert.isFalse(NodeFS.existsSync(path));
    assert.equal(sh(fixture.repo, ["branch", "--list", "failed-clone"]), "");
    yield* fixture.driver.createWorktree({
      cwd: fixture.repo,
      path,
      branch: "main",
      newBranch: "failed-clone",
    });
    assert.equal(sh(path, ["status", "--porcelain"]), "");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect.skipIf(process.platform !== "darwin")(
  "GitCore uses the cache only when the setting is enabled",
  () =>
    Effect.gen(function* () {
      const fixture = yield* setup;
      const { stateDir } = yield* ServerConfig;
      const stock = yield* fixture.create("seed", "main", false);
      const cache = (yield* makeWorktreeCheckoutCache({
        cacheDir: NodePath.join(stateDir, "worktree-checkout-cache"),
        execute: fixture.driver.execute,
      }))!;
      yield* cache.build(stock, 0);
      const registrations: string[] = [];
      const core = yield* makeGitCore({
        executeOverride: (input) =>
          Effect.suspend(() => {
            if (input.args.includes("worktree") && input.args.includes("add"))
              registrations.push(input.args.includes("--no-checkout") ? "cached" : "stock");
            return fixture.driver.execute(input);
          }),
      }).pipe(Effect.provide(ServerSettingsService.layerTest({ fastWorktreeCheckout: true })));
      const created = yield* core.createWorktree({
        cwd: fixture.repo,
        path: NodePath.join(fixture.root, "enabled"),
        branch: "main",
        newBranch: "enabled",
      });
      assert.deepStrictEqual(registrations, ["cached"]);
      assert.equal(sh(created.worktree.path, ["status", "--porcelain"]), "");
      assert.deepStrictEqual(snapshot(created.worktree.path), snapshot(stock));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
