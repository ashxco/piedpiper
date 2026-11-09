import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vitest";

import afterPack, { removeSharedWriteAccess } from "./linux-after-pack.ts";

describe.skipIf(process.platform === "win32")("removeSharedWriteAccess", () => {
  it("removes group and other write access from the packed app only", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pp-after-pack-"));
    try {
      const appOutDir = NodePath.join(root, "app");
      const modes = {
        "app/piedpiper": [0o777, 0o755],
        "app/resources.pak": [0o666, 0o644],
        "app/chrome-sandbox": [0o4777, 0o4755],
        "app/resources/app.asar": [0o644, 0o644],
        "outside/file": [0o666, 0o666],
      } as const;
      await NodeFSP.mkdir(NodePath.join(appOutDir, "resources"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(root, "outside"));
      for (const [file, [before]] of Object.entries(modes)) {
        await NodeFSP.writeFile(NodePath.join(root, file), "");
        await NodeFSP.chmod(NodePath.join(root, file), before);
      }
      await NodeFSP.chmod(NodePath.join(appOutDir, "resources"), 0o777);
      await NodeFSP.chmod(NodePath.join(root, "outside"), 0o777);
      await NodeFSP.symlink("../outside", NodePath.join(appOutDir, "linked-dir"));

      await afterPack({ appOutDir });

      for (const [file, [, after]] of Object.entries(modes)) {
        const { mode } = await NodeFSP.stat(NodePath.join(root, file));
        expect([file, mode & 0o7777]).toEqual([file, after]);
      }
      const { mode: resourcesMode } = await NodeFSP.stat(NodePath.join(appOutDir, "resources"));
      expect(resourcesMode & 0o7777).toBe(0o755);
      const { mode: outsideMode } = await NodeFSP.stat(NodePath.join(root, "outside"));
      expect(outsideMode & 0o7777).toBe(0o777);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("leaves already-safe modes untouched", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pp-after-pack-"));
    try {
      const file = NodePath.join(root, "bin");
      await NodeFSP.writeFile(file, "");
      await NodeFSP.chmod(file, 0o700);
      await removeSharedWriteAccess(root);
      expect((await NodeFSP.stat(file)).mode & 0o7777).toBe(0o700);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
