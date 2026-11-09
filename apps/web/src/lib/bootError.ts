import { APP_BASE_NAME, APP_VERSION } from "../branding";
import { isElectron } from "../env";
import { errorDetails, redactErrorReportText } from "./rootErrorReport";

const MAX_CAUSES = 3;
const MAX_ERROR_CHARS = 6_000;
const BOOT_ERROR_ID = "boot-error";

export interface BootErrorEnvironment {
  readonly appName: string;
  readonly version: string;
  readonly surface: "desktop" | "web";
  readonly platform: string;
  readonly userAgent: string;
  readonly time: string;
}

/** Strips user names from home paths, and hosts and query/hash tokens from URLs. */
export function redactBootErrorText(text: string): string {
  return redactErrorReportText(text);
}

/** Firefox and Safari stacks hold frames only, so the "Name: message" header is added when missing. */
function describeOne(value: unknown): string {
  if (!(value instanceof Error)) return errorDetails(value);
  const header = value.message ? `${value.name}: ${value.message}` : value.name;
  const stack = value.stack;
  if (stack === header || stack?.startsWith(`${header}\n`)) return stack;
  return [header, stack].filter(Boolean).join("\n");
}

/** Plain text that is shown and copied as-is, so users see exactly what they share. */
export function buildBootErrorReport(error: unknown, environment: BootErrorEnvironment): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current != null && !seen.has(current) && parts.length <= MAX_CAUSES) {
    seen.add(current);
    const text = describeOne(current);
    parts.push(parts.length === 0 ? text : `Caused by: ${text}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  let details = redactBootErrorText(parts.join("\n") || "(no error message)");
  if (details.length > MAX_ERROR_CHARS) {
    details = `${details.slice(0, MAX_ERROR_CHARS)}\n[truncated]`;
  }
  return [
    details,
    "",
    `App: ${environment.appName} ${environment.version}`,
    `Surface: ${environment.surface}`,
    `Platform: ${environment.platform}`,
    `User agent: ${environment.userAgent}`,
    `Time: ${environment.time}`,
  ].join("\n");
}

export function bootErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return "An unexpected error stopped the app from loading.";
}

let booted = false;

/** Called after the first render; later errors belong to the router error view. */
export function markAppBooted(): void {
  // apps/desktop/scripts/smoke-test.mjs waits for this exact line.
  if (!booted) console.info(`${APP_BASE_NAME} booted.`);
  booted = true;
}

export function isAppBooted(): boolean {
  return booted;
}

function readEnvironment(): BootErrorEnvironment {
  return {
    appName: APP_BASE_NAME,
    version: APP_VERSION,
    surface: isElectron ? "desktop" : "web",
    platform: navigator.platform,
    userAgent: navigator.userAgent,
    time: new Date().toISOString(),
  };
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: ReadonlyArray<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** Plain http has no Clipboard API, so fall back to selecting the text and the legacy copy command. */
function copyText(target: HTMLElement, onDone: (label: string) => void): void {
  const fallback = () => {
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    onDone(copied ? "Copied" : "Press Ctrl+C or ⌘C to copy");
  };
  const clipboard = window.isSecureContext ? navigator.clipboard : undefined;
  if (typeof clipboard?.writeText !== "function") return fallback();
  clipboard.writeText(target.textContent ?? "").then(() => onDone("Copied"), fallback);
}

/** Draws the startup failure card with plain DOM, since React may be the thing that failed. */
export function showBootError(error: unknown): void {
  // apps/desktop/scripts/smoke-test.mjs fails on this exact line.
  console.error(`${APP_BASE_NAME} failed to start.`, error);
  if (typeof document === "undefined" || document.getElementById(BOOT_ERROR_ID)) return;

  let report = "(no error message)";
  try {
    report = buildBootErrorReport(error, readEnvironment());
  } catch (reportError) {
    console.warn("Could not describe the startup error.", reportError);
  }

  const details = element("pre", { tabIndex: 0, textContent: report });
  const copy = element("button", { type: "button", textContent: "Copy error" });
  copy.addEventListener("click", () => copyText(details, (label) => (copy.textContent = label)));
  const reload = element("button", { type: "button", textContent: "Reload" });
  reload.className = "boot-error-primary";
  reload.addEventListener("click", () => window.location.reload());

  const heading = element("h1", { textContent: `${APP_BASE_NAME} failed to start` });
  const message = element("p", { textContent: redactBootErrorText(bootErrorMessage(error)) });
  const alert = element("div", {}, [heading, message]);
  alert.setAttribute("role", "alert");

  const card = element("div", { className: "boot-error-card" }, [
    alert,
    element("div", { className: "boot-error-actions" }, [reload, copy]),
    details,
    element("p", {
      className: "boot-error-note",
      textContent: "Details may include file names. Check before sharing.",
    }),
  ]);
  document.body.append(element("div", { id: BOOT_ERROR_ID }, [card]));
  document.getElementById("root")?.setAttribute("inert", "");
  reload.focus();
}
