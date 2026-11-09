export interface GitCheckoutProgress {
  readonly percent: number;
  readonly completed: number;
  readonly total: number;
}

// Git prints checkout progress to a pipe only with a zero delay; LC_ALL keeps the wording parseable.
export const GIT_CHECKOUT_PROGRESS_ENV: Readonly<Record<string, string>> = {
  GIT_PROGRESS_DELAY: "0",
  LC_ALL: "C",
};

const GIT_CHECKOUT_PROGRESS_LINE = /Updating files:\s+(\d+)%\s+\((\d+)\/(\d+)\)/;

/** Parses `Updating files:  78% (2104/2700)` from git's stderr; other lines return null. */
export function parseGitCheckoutProgressLine(line: string): GitCheckoutProgress | null {
  const match = GIT_CHECKOUT_PROGRESS_LINE.exec(line);
  if (!match) return null;
  return {
    percent: Math.min(100, Number(match[1])),
    completed: Number(match[2]),
    total: Number(match[3]),
  };
}

const GIT_OUTPUT_LINE_SEPARATOR = /\r\n|\r|\n/;

/** Drops checkout progress redraws from captured stderr, keeping every other line. */
export function stripGitCheckoutProgressLines(text: string): string {
  return text
    .split(GIT_OUTPUT_LINE_SEPARATOR)
    .filter((line) => parseGitCheckoutProgressLine(line) === null)
    .join("\n");
}

// Git redraws progress with a bare `\r` and ends the line only when the step is done.
export function splitGitOutputLines(buffer: string): {
  readonly lines: ReadonlyArray<string>;
  readonly rest: string;
} {
  const lines: Array<string> = [];
  let rest = buffer;
  let separator = GIT_OUTPUT_LINE_SEPARATOR.exec(rest);
  while (separator) {
    const line = rest.slice(0, separator.index);
    if (line.length > 0) lines.push(line);
    rest = rest.slice(separator.index + separator[0].length);
    separator = GIT_OUTPUT_LINE_SEPARATOR.exec(rest);
  }
  return { lines, rest };
}
