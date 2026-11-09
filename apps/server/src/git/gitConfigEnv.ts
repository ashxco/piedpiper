/**
 * Appends `key=value` to the `GIT_CONFIG_*` entries git reads as command-line config, so argv and
 * the user's config stay unchanged. Windows env names are case-insensitive (elsewhere git reads only
 * `GIT_CONFIG_COUNT`): there the count is read from the last spelling, a per-command value spread
 * over process.env, and updated under every spelling. A count git would reject is left alone so git
 * still reports it.
 */
export function gitConfigEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  value: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const countKeys = Object.keys(env).filter((name) =>
    platform === "win32" ? name.toUpperCase() === "GIT_CONFIG_COUNT" : name === "GIT_CONFIG_COUNT",
  );
  const countKey = countKeys.at(-1) ?? "GIT_CONFIG_COUNT";
  const inherited = env[countKey];
  if (
    inherited !== undefined &&
    inherited !== "" &&
    // Git parses the count with strtoul: leading whitespace, an optional sign (only -0 is valid), digits.
    /^[ \t\r\n\v\f]*(?:\+?\d+|-0+)/.exec(inherited)?.[0] !== inherited
  ) {
    return {};
  }
  const count = inherited === undefined || inherited === "" ? 0 : Number.parseInt(inherited, 10);
  return {
    ...Object.fromEntries([...countKeys, countKey].map((name) => [name, String(count + 1)])),
    [`GIT_CONFIG_KEY_${count}`]: key,
    [`GIT_CONFIG_VALUE_${count}`]: value,
  };
}

/**
 * Git otherwise opens any folder holding `HEAD`, `objects/` and `refs/` as a bare repository and
 * applies its `config`, including commands such as `core.fsmonitor`. Files saved in a project or
 * checked out from a clone can form one, so git (and gh) started here only open a bare repository
 * named with `--git-dir` or `GIT_DIR`. Git before 2.38 ignores the setting.
 */
export function explicitBareRepositoryEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  return gitConfigEnv(env, "safe.bareRepository", "explicit", platform);
}
