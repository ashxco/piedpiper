/**
 * Stable terminal numbers. New terminals get `term-N` ids so a tab keeps its number when others
 * close; the first terminal's `default` id counts as 1. Other ids, like the `terminal-<uuid>` ids
 * of older threads, take the lowest free numbers in list order.
 */
import { DEFAULT_THREAD_TERMINAL_ID } from "../types";

function stableTerminalNumber(terminalId: string): number | null {
  if (terminalId === DEFAULT_THREAD_TERMINAL_ID) return 1;
  const match = /^term-([1-9]\d*)$/.exec(terminalId);
  return match ? Number(match[1]) : null;
}

export function terminalNumberById(terminalIds: ReadonlyArray<string>): Map<string, number> {
  const numbers = new Map<string, number>();
  const used = new Set<number>();
  for (const terminalId of terminalIds) {
    const number = stableTerminalNumber(terminalId);
    if (number === null || used.has(number)) continue;
    numbers.set(terminalId, number);
    used.add(number);
  }
  let candidate = 1;
  for (const terminalId of terminalIds) {
    if (numbers.has(terminalId)) continue;
    while (used.has(candidate)) candidate += 1;
    numbers.set(terminalId, candidate);
    used.add(candidate);
  }
  return numbers;
}

/** `Terminal N` for each id: the stable name for close prompts and composer context chips. */
export function terminalNumberLabelById(terminalIds: ReadonlyArray<string>): Map<string, string> {
  return new Map(
    [...terminalNumberById(terminalIds)].map(([terminalId, number]) => [
      terminalId,
      `Terminal ${number}`,
    ]),
  );
}

/**
 * The lowest free `term-N`. Ids still closing on the server stay reserved, so a new terminal
 * cannot be opened under an id that a queued close would then kill.
 */
export function nextTerminalId(
  terminalIds: ReadonlyArray<string>,
  closingTerminalIds: ReadonlyArray<string> = [],
): string {
  const used = new Set(terminalNumberById(terminalIds).values());
  for (const terminalId of closingTerminalIds) {
    const number = stableTerminalNumber(terminalId);
    if (number !== null) used.add(number);
  }
  let candidate = 1;
  while (used.has(candidate)) candidate += 1;
  return `term-${candidate}`;
}
