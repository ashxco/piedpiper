import { describe, expect, it } from "vitest";

import {
  importableProjectConfigScripts,
  newProjectScriptInputFromConfigScript,
} from "./projectConfigFileScripts";

describe("importableProjectConfigScripts", () => {
  it("skips scripts already configured by command or case-insensitive name", () => {
    const result = importableProjectConfigScripts(
      [
        { name: "Dev", command: "bun dev" },
        { name: "test", command: "bun run test" },
        { name: "Lint", command: "bun lint" },
        { name: "Build", command: "bun run build" },
      ],
      [
        { name: "Start", command: "bun dev" },
        { name: "Test", command: "vitest" },
      ],
    );
    expect(result.map((script) => script.name)).toEqual(["Lint", "Build"]);
  });

  it("offers only the first of duplicate names in the file", () => {
    const result = importableProjectConfigScripts(
      [
        { name: "Dev", command: "bun dev" },
        { name: "dev", command: "npm run dev" },
      ],
      [],
    );
    expect(result).toEqual([{ name: "Dev", command: "bun dev" }]);
  });
});

describe("newProjectScriptInputFromConfigScript", () => {
  it("fills defaults for optional fields", () => {
    expect(newProjectScriptInputFromConfigScript({ name: "Dev", command: "bun dev" })).toEqual({
      name: "Dev",
      command: "bun dev",
      icon: "play",
      runOnWorktreeCreate: false,
      keybinding: null,
    });
    expect(
      newProjectScriptInputFromConfigScript({
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      }),
    ).toMatchObject({ icon: "configure", runOnWorktreeCreate: true });
  });
});
