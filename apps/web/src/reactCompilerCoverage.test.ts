import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { transform } from "oxc-transform-react";
import { describe, expect, it } from "vitest";

const webRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

// Files the React Compiler currently bails out on; each must keep bailing out, so fixed files come off.
const KNOWN_BAILOUTS = new Set<string>([
  // Deliberate: isolates TanStack's useVirtualizer, which the compiler flags as incompatible.
  "src/components/BranchToolbarBranchSelector.virtualizer.ts",
  "src/components/chat/ChatPlanPanel.tsx",
  // Deliberate: isolates TanStack's useVirtualizer, which the compiler flags as incompatible.
  "src/components/chat/MessagesTimeline.virtualizer.ts",
  "src/components/office-mode/Joystick.tsx",
  "src/components/office-mode/OfficeMode.tsx",
  "src/hooks/useThreadActions.ts",
  "src/hooks/useThreadPlanCatalog.ts",
]);

// The largest components take several seconds to compile on their own.
const SLOW_FILE_TIMEOUT_MS = 60_000;
const SLOW_FILES = new Set(["src/components/ChatView.tsx"]);

const webSourceFiles = NodeFS.readdirSync(NodePath.join(webRoot, "src"), { recursive: true })
  .map((file) => String(file).split(NodePath.sep).join("/"))
  .filter((file) => /\.tsx?$/.test(file) && !/\.(test|browser)\.tsx?$/.test(file))
  .filter((file) => !file.endsWith(".gen.ts") && !file.endsWith(".d.ts"))
  .map((file) => `src/${file}`)
  .toSorted();

async function collectCompilerBailouts(file: string): Promise<string[]> {
  const absolute = NodePath.join(webRoot, file);
  const result = await transform(absolute, NodeFS.readFileSync(absolute, "utf8"), {
    jsx: { runtime: "automatic", development: false, refresh: false },
    reactCompiler: { reportDiagnostics: true },
  });
  return result.errors.map((error) => error.codeframe ?? error.message);
}

// A file the compiler skips still builds, just without memoization, so check the compiler itself.
describe("React Compiler coverage", () => {
  it("only lists known bailouts that still exist", () => {
    const missing = [...KNOWN_BAILOUTS].filter((file) => !webSourceFiles.includes(file));
    expect(missing).toEqual([]);
  });

  for (const file of webSourceFiles) {
    const knownBailout = KNOWN_BAILOUTS.has(file);
    it(
      knownBailout ? `still bails out on ${file}` : `compiles ${file}`,
      async () => {
        const bailouts = await collectCompilerBailouts(file);
        if (knownBailout) {
          expect(bailouts, `remove ${file} from KNOWN_BAILOUTS`).not.toEqual([]);
        } else {
          expect(bailouts).toEqual([]);
        }
      },
      SLOW_FILES.has(file) ? SLOW_FILE_TIMEOUT_MS : undefined,
    );
  }
});
