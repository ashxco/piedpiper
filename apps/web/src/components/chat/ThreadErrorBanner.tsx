import { memo, useState } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { CheckIcon, CircleAlertIcon, CopyIcon, XIcon } from "lucide-react";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";

/**
 * Readable message for a structured error such as `{"error":{"message":"..."}}`,
 * optionally preceded by a prefix like `API Error: 529 `. Null when `error` is not structured.
 */
export function parseStructuredThreadErrorMessage(error: string): string | null {
  const jsonStart = error.indexOf("{");
  if (jsonStart < 0) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(error.slice(jsonStart));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || !("error" in payload)) return null;
  const nestedError = payload.error;
  if (typeof nestedError !== "object" || nestedError === null || !("message" in nestedError)) {
    return null;
  }
  const message = typeof nestedError.message === "string" ? nestedError.message.trim() : "";
  if (message.length === 0) return null;
  const prefix = error.slice(0, jsonStart).trim();
  return prefix.length > 0 ? `${prefix} ${message}` : message;
}

export function getThreadErrorDisplayMessage(error: string): string {
  return parseStructuredThreadErrorMessage(error) ?? error;
}

// Session-scoped: a reconnect snapshot or session update that brings back the same
// error must not resurface it, while a different error on the thread still shows.
const dismissedThreadErrorKeys = new Set<string>();

export function getThreadErrorDismissalKey(threadId: string, error: string): string {
  return `${threadId}\u0000${error}`;
}

export function dismissThreadErrorForSession(threadId: string, error: string): void {
  dismissedThreadErrorKeys.add(getThreadErrorDismissalKey(threadId, error));
}

export function isThreadErrorDismissedForSession(threadId: string, error: string): boolean {
  return dismissedThreadErrorKeys.has(getThreadErrorDismissalKey(threadId, error));
}

/** Lets an error raised again by a local action show again, while server replays stay masked. */
export function undismissThreadErrorForSession(threadId: string, error: string): void {
  dismissedThreadErrorKeys.delete(getThreadErrorDismissalKey(threadId, error));
}

/** Forget a thread's dismissals, e.g. when the user starts a new turn there. */
export function clearThreadErrorDismissalsForThread(threadId: string): void {
  const prefix = `${threadId}\u0000`;
  for (const key of dismissedThreadErrorKeys) {
    if (key.startsWith(prefix)) dismissedThreadErrorKeys.delete(key);
  }
}

/** Readable error text, with the raw payload behind a toggle when the error is structured. */
export function ThreadErrorDetails({ error }: { error: string }) {
  const [showFullError, setShowFullError] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const readableMessage = parseStructuredThreadErrorMessage(error);
  if (readableMessage === null) {
    return (
      <div className="line-clamp-3 break-words" title={error}>
        {error}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="break-words">{readableMessage}</div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="w-fit text-xs underline underline-offset-2 opacity-80 hover:opacity-100"
          aria-expanded={showFullError}
          onClick={() => setShowFullError((value) => !value)}
        >
          {showFullError ? "Hide full error" : "Show full error"}
        </button>
        <button
          type="button"
          className="inline-flex w-fit items-center gap-1 text-xs opacity-80 hover:opacity-100"
          title="Copy error"
          onClick={() => copyToClipboard(error)}
        >
          {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          {isCopied ? "Copied" : "Copy error"}
        </button>
      </div>
      {showFullError ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
          {error}
        </pre>
      ) : null}
    </div>
  );
}

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="pt-3 mx-auto max-w-(--chat-max-width)">
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription>
          <ThreadErrorDetails key={error} error={error} />
        </AlertDescription>
        {onDismiss && (
          <AlertAction>
            <button
              type="button"
              aria-label="Dismiss error"
              className="inline-flex size-6 items-center justify-center rounded-md text-destructive/60 transition-colors hover:text-destructive"
              onClick={onDismiss}
            >
              <XIcon className="size-3.5" />
            </button>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
