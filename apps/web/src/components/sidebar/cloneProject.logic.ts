/** Pure parts of adding a project by cloning a Git URL: names, destinations and the clone flow. */

const CLONE_URL_SCHEMES = /^(?:https?|ssh|git|git\+ssh|git\+https|file):\/\/\S+$/i;
const SCP_LIKE_REMOTE = /^[^\s/\\:@-][^\s/\\:@]*@[^\s/\\:]+:\S+$/;

/** True for what `git clone` reads as a remote; a stray option or a plain path is not one. */
export function isCloneUrl(input: string): boolean {
  const url = input.trim();
  return CLONE_URL_SCHEMES.test(url) || SCP_LIKE_REMOTE.test(url);
}

/** The folder `git clone` would pick: the last path segment without `.git`, or "" if it has none. */
export function getCloneDirectoryName(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0]?.trim() ?? "";
  const schemeIndex = withoutQuery.indexOf("://");
  // The host is never the repository, so a URL that stops at it, or at a port, names nothing.
  const hasHost = schemeIndex >= 0 || /^[^/\\:]+@[^/\\:]+:/.test(withoutQuery);
  // Userinfo can hold a token, which must never end up in a folder name.
  const pathPart =
    schemeIndex >= 0
      ? withoutQuery.slice(schemeIndex + "://".length).replace(/^[^/]*@/, "")
      : withoutQuery;
  const segments = pathPart.split(/[/\\:]+/).filter((segment) => segment.trim().length > 0);
  if (hasHost && segments.length < 2) return "";
  const last = segments.at(-1)?.trim() ?? "";
  if (hasHost && segments.length === 2 && /^\d+$/.test(last)) return "";
  const name = last.endsWith(".git") ? last.slice(0, -".git".length) : last;
  return name === "." || name === ".." ? "" : name;
}

/** Joins with the separator the folder already uses, so a Windows path stays one. */
export function getCloneDestinationPath(parentDirectory: string, name: string): string {
  const parent = parentDirectory.trim();
  if (parent.length === 0 || name.length === 0) return "";
  if (/[/\\]$/.test(parent)) return `${parent}${name}`;
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent}${separator}${name}`;
}

/** Clones land beside the newest project; `~` works everywhere, as the server expands it. */
export function getCloneParentDirectory(projectCwd: string | null | undefined): string {
  const cwd = projectCwd?.trim().replace(/[/\\]+$/, "") ?? "";
  const separatorIndex = Math.max(cwd.lastIndexOf("/"), cwd.lastIndexOf("\\"));
  if (separatorIndex < 0) return "~";
  const parent = cwd.slice(0, separatorIndex);
  // The parent of `/repo` or `C:\repo` is the root, which needs its separator back.
  return parent.length === 0 || /^[a-z]:$/i.test(parent)
    ? cwd.slice(0, separatorIndex + 1)
    : parent;
}

export interface CloneProgress {
  readonly stage: "connecting" | "counting" | "receiving" | "resolving" | "checkout";
  readonly percent: number | null;
  readonly detail: string | null;
}

const STAGE_LABELS: Record<CloneProgress["stage"], string> = {
  connecting: "Connecting",
  counting: "Counting objects",
  receiving: "Receiving objects",
  resolving: "Resolving deltas",
  checkout: "Checking out files",
};

export function describeCloneProgress(progress: CloneProgress): string {
  const percent = progress.percent === null ? "" : ` ${progress.percent}%`;
  const detail = progress.detail === null ? "" : ` (${progress.detail})`;
  return `${STAGE_LABELS[progress.stage]}${percent}${detail}`;
}

/** Git's own words when the server sent them, not the full command wrapper. */
export function describeCloneError(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const { detail, message } = error as { detail?: unknown; message?: unknown };
    if (typeof detail === "string" && detail.length > 0) return detail;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The repository could not be cloned.";
}

export interface CloneRepositoryOptions {
  readonly onProgress?: (progress: CloneProgress) => void;
  readonly signal?: AbortSignal;
}

export type CloneRepository = (
  input: { readonly url: string; readonly destinationPath: string },
  options?: CloneRepositoryOptions,
) => Promise<{ readonly destinationPath: string }>;

export interface CloneToast {
  readonly loading: (input: { title: string; description: string; onCancel: () => void }) => void;
  readonly progress: (description: string) => void;
  readonly succeeded: (title: string) => void;
  readonly failed: (title: string, description: string) => void;
  readonly cancelled: (title: string) => void;
}

export type CloneOutcome = "cloned" | "add-failed" | "cancelled" | "failed";

/**
 * The project is added only after the clone finished, so a failed one leaves no project behind.
 * `addProject` rejects when it could not add it; the repository is on disk by then, so say where.
 */
export async function runCloneProject(input: {
  readonly url: string;
  readonly destinationPath: string;
  readonly cloneRepository: CloneRepository;
  readonly addProject: (destinationPath: string) => Promise<void>;
  readonly toast: CloneToast;
}): Promise<CloneOutcome> {
  const url = input.url.trim();
  const destinationPath = input.destinationPath.trim();
  // Never the URL: it can carry a token.
  const name =
    getCloneDirectoryName(url) || destinationPath.split(/[/\\]/).findLast(Boolean) || "repository";
  const controller = new AbortController();
  input.toast.loading({
    title: `Cloning ${name}`,
    description: "Connecting",
    onCancel: () => controller.abort(),
  });
  let finishedPath: string;
  try {
    const result = await input.cloneRepository(
      { url, destinationPath },
      {
        signal: controller.signal,
        onProgress: (progress) => input.toast.progress(describeCloneProgress(progress)),
      },
    );
    finishedPath = result.destinationPath;
  } catch (error) {
    if (controller.signal.aborted) {
      input.toast.cancelled(`Cancelled cloning ${name}`);
      return "cancelled";
    }
    input.toast.failed(`Could not clone ${name}`, describeCloneError(error));
    return "failed";
  }
  input.toast.progress("Adding project");
  try {
    await input.addProject(finishedPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "An error occurred.";
    input.toast.failed(
      `Cloned ${name}, but could not add it as a project`,
      `${reason} The repository is in ${finishedPath}.`,
    );
    return "add-failed";
  }
  input.toast.succeeded(`Cloned ${name}`);
  return "cloned";
}
