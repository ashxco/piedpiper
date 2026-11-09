/** A command the provider reported for the `/` menu; matches the server's list item. */
export interface ComposerProviderCommand {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
}

/** A slash word with a second slash, such as `/usr/bin`, is a path, not a command. */
export function isComposerPathWord(text: string, wordStart: number, cursor: number): boolean {
  let wordEnd = cursor;
  while (wordEnd < text.length && !/\s/.test(text[wordEnd] ?? "")) {
    wordEnd += 1;
  }
  return text.slice(wordStart + 1, wordEnd).includes("/");
}

/** Claude only expands a slash command at the very start of a message. */
export function canOfferProviderCommands(text: string, rangeStart: number): boolean {
  return text.slice(0, rangeStart).trim() === "";
}

/**
 * Commands for the menu: prefix matches first, then substring ones. Local commands win a
 * name clash, and an exact name closes the menu so that Enter sends it instead of inserting a
 * longer one such as /security-review for /review.
 */
export function filterComposerProviderCommands(
  commands: ReadonlyArray<ComposerProviderCommand>,
  query: string,
  localCommandNames: ReadonlyArray<string>,
): ReadonlyArray<ComposerProviderCommand> {
  const needle = query.trim().toLowerCase();
  const local = new Set(localCommandNames.map((name) => name.toLowerCase()));
  const available = commands.filter((command) => !local.has(command.name.toLowerCase()));
  if (needle && available.some((command) => command.name.toLowerCase() === needle)) return [];
  if (!needle) return available;
  return [
    ...available.filter((command) => command.name.toLowerCase().startsWith(needle)),
    ...available.filter((command) => {
      const name = command.name.toLowerCase();
      return !name.startsWith(needle) && name.includes(needle);
    }),
  ];
}

/** Text a chosen command leaves in the composer. */
export function providerCommandInsertion(command: ComposerProviderCommand): string {
  return `/${command.name} `;
}
