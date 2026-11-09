import type { ProjectConfigFileScript, ProjectScript } from "@piedpiper/contracts";

import type { NewProjectScriptInput } from "./components/ProjectScriptsControl";

/** piedpiper.json scripts not yet configured, matched by command or (case-insensitive) name. */
export function importableProjectConfigScripts(
  fileScripts: ReadonlyArray<ProjectConfigFileScript>,
  scripts: ReadonlyArray<Pick<ProjectScript, "name" | "command">>,
): ProjectConfigFileScript[] {
  const commands = new Set(scripts.map((script) => script.command));
  const names = new Set(scripts.map((script) => script.name.toLowerCase()));
  const seen = new Set<string>();
  return fileScripts.filter((fileScript) => {
    const name = fileScript.name.toLowerCase();
    if (commands.has(fileScript.command) || names.has(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/** Add-script payload for importing a piedpiper.json script; the id is derived from the name on add. */
export function newProjectScriptInputFromConfigScript(
  fileScript: ProjectConfigFileScript,
): NewProjectScriptInput {
  return {
    name: fileScript.name,
    command: fileScript.command,
    icon: fileScript.icon ?? "play",
    runOnWorktreeCreate: fileScript.runOnWorktreeCreate ?? false,
    keybinding: null,
  };
}
