import type { ProviderRuntimeEvent } from "@piedpiper/contracts";

/** Keys naming a credential; `token\b` leaves `max_tokens` alone. Authorization has its own rules. */
const CREDENTIAL_KEY_PATTERN = String.raw`[\w-]*(?:(?:api[_-]?key|credentials?|password|secret)[\w-]*|token)`;
/** A quoted value, honouring escapes; a value cut off when the CLI died runs to the line's end. */
const QUOTED_VALUE_PATTERN = String.raw`"(?:\\.|[^"\\\n])*(?:"|\\?$)|'(?:\\.|[^'\\\n])*(?:'|\\?$)`;
/** One level of stringified JSON: an inner quote has more backslashes than the delimiter. */
const STRINGIFIED_VALUE_PATTERN = String.raw`(\\+["'])[^\n]*?(?:(?<!\\)\3|$)`;
const QUOTED_CREDENTIAL_PATTERN = new RegExp(
  String.raw`(\\*["'](?:[\w-]*authorization|${CREDENTIAL_KEY_PATTERN})\\*["']\s*:\s*)(${QUOTED_VALUE_PATTERN}|${STRINGIFIED_VALUE_PATTERN}|-?\d[\w.+-]*)`,
  "gim",
);
const AUTHORIZATION_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`((?<![\w-])[\w-]*authorization\s*[:=]\s*)(?:${QUOTED_VALUE_PATTERN}|(?:(bearer|basic)\s+)?\S+)`,
  "gim",
);
const CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`((?<![\w-])${CREDENTIAL_KEY_PATTERN}\b\s*[:=]\s*)(?:${QUOTED_VALUE_PATTERN}|\S+)`,
  "gim",
);
const UPPERCASE_CREDENTIAL_ASSIGNMENT_PATTERN = new RegExp(
  String.raw`\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[=:]\s*)(?:${QUOTED_VALUE_PATTERN}|\S+)`,
  "gm",
);

/** Masks API keys, bearer tokens and secret-looking assignments in provider diagnostics. */
export function redactProviderErrorText(text: string): string {
  return text
    .replace(/\b(sk-(?:ant-|proj-)?)[\w-]+/g, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(QUOTED_CREDENTIAL_PATTERN, (_match, prefix: string, value: string) => {
      const quote = /^\\*["']/.exec(value)?.[0] ?? "";
      return `${prefix}${quote}[redacted]${quote}`;
    })
    .replace(AUTHORIZATION_ASSIGNMENT_PATTERN, (_match, prefix, scheme) =>
      scheme ? `${prefix}${scheme} [redacted]` : `${prefix}[redacted]`,
    )
    .replace(/\b(bearer\s+)[\w.~+/=-]{8,}/gi, "$1[redacted]")
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, "$1[redacted]")
    .replace(UPPERCASE_CREDENTIAL_ASSIGNMENT_PATTERN, "$1[redacted]");
}

/** Error details may include nested SDK response bodies; do not mutate the provider's objects. */
function redactDetail(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === "string") return redactProviderErrorText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  if (value instanceof Error) return redactProviderErrorText(value.message);
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !("value" in descriptor)) continue;
    const secretKey = /(?:authorization|api[_-]?key|credentials?|password|secret|token)$/i.test(
      key,
    );
    Object.defineProperty(copy, key, {
      value: secretKey ? "[redacted]" : redactDetail(descriptor.value, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return copy;
}

/** Sanitize diagnostic fields before they enter persistence; normal model/tool text is untouched. */
export function redactProviderRuntimeEvent(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  if (event.type === "runtime.error" || event.type === "runtime.warning") {
    return {
      ...event,
      payload: {
        ...event.payload,
        message: redactProviderErrorText(event.payload.message),
        ...(event.payload.detail === undefined
          ? {}
          : { detail: redactDetail(event.payload.detail) }),
      },
      ...(event.raw ? { raw: { ...event.raw, payload: redactDetail(event.raw.payload) } } : {}),
    };
  }
  if (event.type === "turn.completed" && event.payload.errorMessage) {
    return {
      ...event,
      payload: {
        ...event.payload,
        errorMessage: redactProviderErrorText(event.payload.errorMessage),
      },
    };
  }
  return event;
}
