import { stripVTControlCharacters } from "node:util";
import type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  UserInputQuestion,
} from "@piedpiper/contracts";
import { toMcpElicitationResponse } from "../../codex/protocolHelpers.ts";

type ClaudeMcpElicitationContent = NonNullable<ElicitationResult["content"]>;

function isClaudeMcpElicitationValue(value: unknown): value is ClaudeMcpElicitationContent[string] {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

/** A plain one-time approval (`allow`, `approve_once`, `allow this time`), never a broader grant. */
const CLAUDE_MCP_ONE_TIME_APPROVAL =
  /^(?:once|accept|approve|allow)(?:[_\s-]*(?:once(?:[_\s-]*only)?|this[_\s-]*time))?$/i;

function isClaudeMcpOneTimeApproval(value: unknown): boolean {
  return typeof value === "string" && CLAUDE_MCP_ONE_TIME_APPROVAL.test(value.trim());
}

function claudeMcpAnswerableField(field: Record<string, unknown>): Record<string, unknown> {
  const answerable: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(field)) {
    if (name === "default") continue;
    // Only a plain one-time choice may be picked, so `allow_all` before `allow_once` is skipped.
    if (name === "enum" && Array.isArray(value)) {
      answerable.enum = value.filter(isClaudeMcpOneTimeApproval);
    } else if (name === "oneOf" && Array.isArray(value)) {
      answerable.oneOf = value.filter(
        (option) =>
          typeof option === "object" &&
          option !== null &&
          isClaudeMcpOneTimeApproval((option as { const?: unknown }).const),
      );
    } else {
      answerable[name] = value;
    }
  }
  return answerable;
}

function withoutSchemaDefaults(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return schema;
  }
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, field]) => [
        key,
        typeof field === "object" && field !== null && !Array.isArray(field)
          ? claudeMcpAnswerableField(field as Record<string, unknown>)
          : field,
      ]),
    ),
  };
}

/**
 * The answer an approved MCP elicitation sends, or undefined when the approval card cannot
 * answer it (URL mode, no schema, or required fields only free text could fill). Schema
 * defaults and choices broader than a one-time approval are dropped so they never grant
 * something the user did not see.
 */
export function claudeMcpElicitationAcceptance(
  request: ElicitationRequest,
): ElicitationResult | undefined {
  if (request.mode === "url" || request.requestedSchema === undefined) return undefined;
  const response = toMcpElicitationResponse(
    { mode: "form", requestedSchema: withoutSchemaDefaults(request.requestedSchema) },
    "accept",
  );
  // The helper leaves content out when the schema is not a form it can read.
  const filled = response.content;
  if (response.action !== "accept") return undefined;
  if (typeof filled !== "object" || filled === null || Array.isArray(filled)) return undefined;
  const content: ClaudeMcpElicitationContent = {};
  for (const [key, value] of Object.entries(filled)) {
    if (!isClaudeMcpElicitationValue(value)) return undefined;
    content[key] = value;
  }
  return { action: "accept", content };
}

/** Approval-card detail for an MCP elicitation: the server's label and its message. */
export function claudeMcpElicitationDetail(request: ElicitationRequest): string {
  const source = (request.displayName ?? request.title ?? request.serverName).trim();
  const message = request.message.trim();
  if (!message) return source || "MCP server request";
  return source ? `${source}: ${message}` : message;
}

/** Extra approval-card fields from Claude's permission callback; both stay absent for a plain ask. */
export function claudeApprovalPresentation(input: {
  readonly detail: string | undefined;
  readonly callbackOptions: Pick<
    Parameters<CanUseTool>[2],
    "decisionReason" | "suppressAlwaysAllowRule"
  >;
}): { readonly reason?: string; readonly noStandingGrant?: true } {
  // The reason can carry terminal escapes from the CLI's own prompt renderer.
  const reason = stripVTControlCharacters(input.callbackOptions.decisionReason ?? "").trim();
  return {
    ...(reason === "" || reason === input.detail?.trim() ? {} : { reason }),
    ...(input.callbackOptions.suppressAlwaysAllowRule === true ? { noStandingGrant: true } : {}),
  };
}

/** Downgrades a session grant to a one-time approval when Claude forbids a standing rule. */
export function effectiveClaudeApprovalDecision(
  decision: ProviderApprovalDecision,
  noStandingGrant: boolean | undefined,
): ProviderApprovalDecision {
  return noStandingGrant === true && decision === "acceptForSession" ? "accept" : decision;
}

/**
 * Permission updates for "Always allow this session": suggestions are rescoped to
 * `session` (they usually target localSettings, which would persist to disk), and
 * when none exist (common for MCP tools) a whole-tool session allow rule is used.
 */
export function toSessionPermissionUpdates(
  toolName: string,
  suggestions: ReadonlyArray<PermissionUpdate> | undefined,
): Array<PermissionUpdate> {
  const sessionScoped: Array<PermissionUpdate> = [];
  for (const suggestion of suggestions ?? []) {
    sessionScoped.push({ ...suggestion, destination: "session" });
  }
  if (sessionScoped.length > 0) {
    return sessionScoped;
  }
  return [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }];
}

export function claudeUserInputQuestions(value: unknown): Array<UserInputQuestion> {
  // Parse questions from the SDK's AskUserQuestion input.
  const rawQuestions = Array.isArray(value) ? value : [];
  const usedQuestionIds = new Set<string>();
  return rawQuestions.map((q: Record<string, unknown>, idx: number) => {
    // Headers are short and can repeat within one call; ids must stay unique.
    const base = typeof q.header === "string" ? q.header : `q-${idx}`;
    const id = usedQuestionIds.has(base) ? `${base}-${idx}` : base;
    usedQuestionIds.add(id);
    return {
      id,
      header: typeof q.header === "string" ? q.header : `Question ${idx + 1}`,
      question: typeof q.question === "string" ? q.question : "",
      options: Array.isArray(q.options)
        ? q.options.map((opt: Record<string, unknown>) => {
            const label = typeof opt.label === "string" ? opt.label : "";
            const description = typeof opt.description === "string" ? opt.description.trim() : "";
            return {
              label,
              description: description || label,
              ...(typeof opt.preview === "string" ? { preview: opt.preview } : {}),
            };
          })
        : [],
      multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
    };
  });
}

export function claudeUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  answers: ProviderUserInputAnswers,
): Record<string, unknown> {
  // The SDK looks answers up by full question text; the web keys them by
  // question id (the header), so remap ids here and keep the web contract.
  const questionTextById = new Map(
    questions.flatMap((q) => (q.question.length > 0 ? [[q.id, q.question] as const] : [])),
  );
  const sdkAnswers: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answers)) {
    // Multi-select answers reach the SDK as one comma-separated string.
    sdkAnswers[questionTextById.get(key) ?? key] = Array.isArray(value)
      ? value.filter((entry) => typeof entry === "string").join(", ")
      : value;
  }
  return sdkAnswers;
}
