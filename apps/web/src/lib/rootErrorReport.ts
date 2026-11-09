const MAX_ERROR_CAUSE_DEPTH = 5;

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

export function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    const stack = error.stack;
    if (!stack) return error.message;
    // Firefox and Safari stacks are frames only, without the "Name: message" line Chrome prepends.
    if (error.message && !stack.includes(error.message)) {
      return `${error.name}: ${error.message}\n${stack}`;
    }
    return stack;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2) ?? String(error);
  } catch {
    return "No additional error details are available.";
  }
}

/** Strips user names from home paths, and hosts and query/hash tokens from URLs. */
export function redactErrorReportText(text: string): string {
  return text
    .replace(/\b[a-z][\w+.-]*:\/\/[^\s/?#'"()]+/gi, "")
    .replace(/[?#][^\s'"()]*=[^\s'"()]*?((?::\d+){1,2})?(?=[\s'"()]|$)/g, "$1")
    .replace(/\/(Users|home)\/[^/\s'"()]+/g, "/$1/~")
    .replace(/\b([A-Za-z]:\\Users\\)[^\\\s'"()]+/g, "$1~");
}

/**
 * Full error text for bug reports: app build, route path, time, then the stack
 * and the Error.cause chain, redacted like the boot error report. Takes only the pathname so query
 * tokens never reach the clipboard.
 */
export function buildErrorReport(input: {
  error: unknown;
  appName: string;
  appVersion: string;
  pathname: string;
  timestamp: string;
}): string {
  const details = [errorDetails(input.error)];
  let cause = input.error instanceof Error ? input.error.cause : undefined;
  for (let depth = 0; cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    details.push("", "Caused by:", errorDetails(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return [
    `${input.appName} ${input.appVersion}`,
    `Path: ${input.pathname}`,
    `Time: ${input.timestamp}`,
    "",
    redactErrorReportText(details.join("\n")),
  ].join("\n");
}
