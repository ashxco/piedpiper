/**
 * Resolves GitHub pull requests and issues linked from a message into reference data for thread
 * title prompts, so a thread seeded with only a link can still be named after its subject.
 *
 * @module threadTitleLinks
 */
import { Effect, Schema } from "effect";
import { sliceSurrogateSafe } from "@piedpiper/shared/String";

import type { GitHubCliShape } from "./Services/GitHubCli.ts";

const MAX_THREAD_TITLE_LINKS = 2;
const MAX_LINKED_TITLE_CHARS = 300;
const MAX_LINKED_BODY_CHARS = 1_200;
const LINK_LOOKUP_TIMEOUT_MS = 3_000;

const OWNER_PATTERN = /^[A-Za-z0-9-]+$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;
// A leading run of digits, so `1.next` still reads as 1 while `1abc` is no number at all.
const NUMBER_PATTERN = /^[1-9][0-9]*(?![0-9A-Za-z_-])/;
// The same trailing block apps/web appends to a prompt for attached terminal output.
const TRAILING_TERMINAL_CONTEXT_PATTERN =
  /\n*<terminal_context>\n[\s\S]*?\n<\/terminal_context>\s*$/;
// Diff comment blocks from apps/web; their inner tags are escaped, so the first opener starts the run.
const TRAILING_REVIEW_COMMENTS_PATTERN =
  /(?:^|\n)<review_comment\b[^>\n]*>\n[\s\S]*?\n<\/review_comment>\s*$/;

export interface ThreadTitleLink {
  readonly url: string;
  readonly owner: string;
  readonly repository: string;
  readonly number: string;
}

const LinkedSubject = Schema.fromJsonString(
  Schema.Struct({ title: Schema.String, body: Schema.NullOr(Schema.String) }),
);
const decodeLinkedSubject = Schema.decodeEffect(LinkedSubject);

function parseThreadTitleLink(candidate: string): ThreadTitleLink | null {
  const url = URL.parse(candidate);
  if (!url || !["github.com", "www.github.com"].includes(url.hostname)) {
    return null;
  }
  const [owner, repository, kind, numberSegment] = url.pathname.split("/").filter(Boolean);
  const number = numberSegment?.match(NUMBER_PATTERN)?.[0];
  if (
    !owner ||
    !repository ||
    !number ||
    (kind !== "pull" && kind !== "issues") ||
    !OWNER_PATTERN.test(owner) ||
    !REPOSITORY_PATTERN.test(repository)
  ) {
    return null;
  }
  return {
    url: `https://github.com/${owner}/${repository}/${kind}/${number}`,
    owner,
    repository,
    number,
  };
}

/** A message without attached terminal output and diffs, whose links are not its subject. */
function withoutAttachedContext(message: string): string {
  return message
    .replace(TRAILING_TERMINAL_CONTEXT_PATTERN, "")
    .replace(TRAILING_REVIEW_COMMENTS_PATTERN, "");
}

/** The first two distinct github.com pull request or issue links the user wrote in a message. */
export function extractThreadTitleLinks(message: string): ReadonlyArray<ThreadTitleLink> {
  const links = new Map<string, ThreadTitleLink>();
  for (const match of withoutAttachedContext(message).matchAll(/https?:\/\/[^\s<>"')\]`,;|]+/gi)) {
    const link = parseThreadTitleLink(match[0].replace(/[.,:;!?*_~|}]+$/, ""));
    if (!link) continue;
    // Pull requests and issues share one number space, so either URL names the same thread.
    const key = `${link.owner}/${link.repository}#${link.number}`.toLowerCase();
    if (links.has(key)) continue;
    links.set(key, link);
    if (links.size === MAX_THREAD_TITLE_LINKS) break;
  }
  return [...links.values()];
}

/** What regeneration scans for links: assistant text is not the user's stated subject. */
export function threadTitleLinkSourceFromMessages(
  messages: ReadonlyArray<{ readonly role: string; readonly text: string }>,
): string {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => withoutAttachedContext(message.text))
    .join("\n");
}

const lookUpLink = (
  gitHubCli: Pick<GitHubCliShape, "execute">,
  cwd: string,
  link: ThreadTitleLink,
) =>
  gitHubCli
    .execute({
      cwd,
      // Explicit host: gh otherwise defaults to the configured one, which may be Enterprise.
      args: [
        "api",
        "--hostname",
        "github.com",
        `repos/${link.owner}/${link.repository}/issues/${link.number}`,
        "--jq",
        "{title, body}",
      ],
      timeoutMs: LINK_LOOKUP_TIMEOUT_MS,
    })
    .pipe(
      Effect.flatMap((result) => decodeLinkedSubject(result.stdout.trim())),
      // JSON keeps third-party newlines from imitating the prompt's own sections.
      Effect.map(
        (subject) =>
          `${link.url}\n${JSON.stringify({
            title: sliceSurrogateSafe(subject.title, MAX_LINKED_TITLE_CHARS),
            body: sliceSurrogateSafe(subject.body ?? "", MAX_LINKED_BODY_CHARS),
          })}`,
      ),
      Effect.timeout(`${LINK_LOOKUP_TIMEOUT_MS} millis`),
      Effect.orElseSucceed(() => `${link.url}: unavailable`),
    );

/**
 * Read the subjects of a message's linked pull requests and issues; never fails. A link that
 * cannot be read is reported as unavailable. Undefined when the message links to none.
 */
export const resolveThreadTitleLinkedContext = Effect.fn("resolveThreadTitleLinkedContext")(
  function* (input: {
    readonly cwd: string;
    readonly message: string;
    readonly gitHubCli: Pick<GitHubCliShape, "execute">;
  }) {
    const links = extractThreadTitleLinks(input.message);
    if (links.length === 0) {
      return undefined;
    }
    const subjects = yield* Effect.forEach(
      links,
      (link) => lookUpLink(input.gitHubCli, input.cwd, link),
      { concurrency: MAX_THREAD_TITLE_LINKS },
    );
    return subjects.join("\n\n");
  },
);
