import { UNKNOWN_SDK_MESSAGE_NO_CONTENT_SUFFIX } from "@piedpiper/contracts";
import { sliceSurrogateSafe } from "@piedpiper/shared/String";

// Discriminator and identity keys carry no human-readable content.
const SDK_MESSAGE_NOISE_KEYS = new Set([
  "type",
  "subtype",
  "uuid",
  "parent_uuid",
  "session_id",
  "parent_tool_use_id",
  "request_id",
]);
const MAX_PREVIEW_CHARS = 280;

/**
 * Joins the scalar fields of a provider message the adapter does not model, so a
 * work-log row shows what arrived instead of an opaque "unhandled subtype" note.
 * Nested structures are left to the full payload kept in the event's detail.
 */
export function previewUnknownSdkContent(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(message as Record<string, unknown>)) {
    if (SDK_MESSAGE_NOISE_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.replace(/\s+/g, " ").trim();
      if (trimmed.length > 0) {
        parts.push(`${key}: ${trimmed}`);
      }
    } else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${String(value)}`);
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  const joined = parts.join("; ");
  return joined.length > MAX_PREVIEW_CHARS
    ? `${sliceSurrogateSafe(joined, MAX_PREVIEW_CHARS - 3)}...`
    : joined;
}

/** e.g. describeUnknownSdkMessage("Claude system message 'x'", message) -> "Claude system message 'x' - text: hi". */
export function describeUnknownSdkMessage(kind: string, message: unknown): string {
  const preview = previewUnknownSdkContent(message);
  return preview ? `${kind} - ${preview}` : `${kind} ${UNKNOWN_SDK_MESSAGE_NO_CONTENT_SUFFIX}`;
}
