import { ADVISORS_PROJECT_ID, type ThreadId } from "@piedpiper/contracts";
import { ArrowUpIcon, XIcon } from "lucide-react";
import React, {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ChatMessage } from "../../types";
import { advisorAvatarSrc, advisorThreadTitle, parseAdvisor } from "../../lib/advisorIdentity";
import { newCommandId, newMessageId, newThreadId } from "../../lib/utils";
import { readNativeApi } from "../../nativeApi";
import { useThreadById } from "../../storeSelectors";
import {
  filterAckedAdvisorCardMessages,
  mergeAdvisorCardMessages,
} from "./advisorCardChatMessages";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ShimmerText } from "../chat/ShimmerText";

interface AdvisorCardChatProps {
  /** Character file id, e.g. `"character-sv-richard-hendricks"`. */
  readonly characterId: string;
  /**
   * Existing server thread for this advisor, or `null` to lazy-create one on
   * first send. Owned by the parent so each character keeps its own
   * conversation across opens.
   */
  readonly threadId: ThreadId | null;
  /**
   * Called once after the thread.create dispatch on the first send so the
   * parent can persist `characterId → threadId` and resume next time.
   */
  readonly onThreadCreated: (threadId: ThreadId) => void;
  /** Closes the chat card and returns the office to its default state. */
  readonly onClose: () => void;
}

const ADVISOR_MODEL_SELECTION = {
  provider: "claudeAgent" as const,
  model: "claude-haiku-4-5",
};

// ────────────────────────────────────────────────────────────────────────────
// Module-level style constants. Inline styles allocate fresh objects per
// render in React, which defeats Object.is comparison and causes downstream
// reconciler work for every prop. Hoisting these constants once means each
// rendered element references the same style object across re-renders, and
// memoised children only have to walk the (stable) reference graph.
// ────────────────────────────────────────────────────────────────────────────

const ROOT_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "100%",
  height: 480,
  gap: 0,
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "14px 18px 12px",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
};

const HEADER_AVATAR_STYLE: CSSProperties = {
  height: 40,
  width: "auto",
  objectFit: "contain",
};

const HEADER_TEXT_WRAP_STYLE: CSSProperties = { flex: 1, minWidth: 0 };

const HEADER_NAME_STYLE: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "white",
  lineHeight: 1.2,
};

const HEADER_CLOSE_STYLE: CSSProperties = {
  background: "none",
  border: "none",
  color: "rgba(255,255,255,0.45)",
  cursor: "pointer",
  padding: 4,
  display: "flex",
  transition: "color 0.15s",
};

const MESSAGES_SCROLLER_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "16px 18px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const MESSAGES_EMPTY_STYLE: CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "rgba(255,255,255,0.4)",
  fontSize: 13,
  fontStyle: "italic",
  textAlign: "center",
};

const ROW_USER_STYLE: CSSProperties = { display: "flex", justifyContent: "flex-end" };
const ROW_ASSISTANT_STYLE: CSSProperties = { display: "flex", justifyContent: "flex-start" };

const BUBBLE_BASE_STYLE: CSSProperties = {
  maxWidth: "82%",
  padding: "9px 13px",
  borderRadius: 14,
  fontSize: 13,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const USER_BUBBLE_STYLE: CSSProperties = {
  ...BUBBLE_BASE_STYLE,
  color: "black",
  background: "white",
  border: "none",
};

const ASSISTANT_BUBBLE_STYLE: CSSProperties = {
  ...BUBBLE_BASE_STYLE,
  whiteSpace: "normal",
  color: "rgba(255,255,255,0.92)",
  background: "transparent",
  border: "none",
  padding: "4px 0",
};

const ERROR_BUBBLE_STYLE: CSSProperties = {
  alignSelf: "flex-start",
  padding: "8px 12px",
  borderRadius: 12,
  fontSize: 12,
  color: "rgba(255, 180, 180, 0.95)",
  background: "rgba(220, 70, 70, 0.15)",
  border: "1px solid rgba(220, 70, 70, 0.3)",
};

const COMPOSER_FORM_STYLE: CSSProperties = {
  position: "relative",
  padding: "12px 14px 14px",
  borderTop: "1px solid rgba(255,255,255,0.06)",
};

const COMPOSER_TEXTAREA_STYLE: CSSProperties = {
  width: "100%",
  resize: "none",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 20,
  padding: "9px 38px 9px 14px",
  color: "white",
  fontSize: 13,
  fontFamily: "inherit",
  outline: "none",
  maxHeight: 120,
  minHeight: 38,
};

const SEND_BUTTON_BASE_STYLE: CSSProperties = {
  position: "absolute",
  right: 20,
  bottom: 26,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: "50%",
  border: "none",
  transition: "opacity 0.15s ease",
};

const SEND_BUTTON_DISABLED_STYLE: CSSProperties = {
  ...SEND_BUTTON_BASE_STYLE,
  background: "rgba(255,255,255,0.15)",
  color: "rgba(255,255,255,0.3)",
  cursor: "not-allowed",
};

const SEND_BUTTON_ENABLED_STYLE: CSSProperties = {
  ...SEND_BUTTON_BASE_STYLE,
  background: "white",
  color: "black",
  cursor: "pointer",
};

// Stable reference for the "no thread yet" case so derivations downstream
// don't re-evaluate on every parent render just because `messages` is a new
// `[]` literal each time.
const EMPTY_MESSAGES: readonly ChatMessage[] = [];

// ────────────────────────────────────────────────────────────────────────────
// Subcomponents. Each is independently memoised so streaming chunks only
// re-render the messages subtree — the header + composer stay stable.
// ────────────────────────────────────────────────────────────────────────────

interface HeaderProps {
  readonly characterId: string;
  readonly displayName: string;
  readonly onClose: () => void;
}

const AdvisorCardChatHeader = memo(function AdvisorCardChatHeader({
  characterId,
  displayName,
  onClose,
}: HeaderProps) {
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      onClose();
    },
    [onClose],
  );
  return (
    <div style={HEADER_STYLE}>
      <img
        src={advisorAvatarSrc(characterId)}
        alt=""
        draggable={false}
        style={HEADER_AVATAR_STYLE}
      />
      <div style={HEADER_TEXT_WRAP_STYLE}>
        <div style={HEADER_NAME_STYLE}>{displayName}</div>
      </div>
      <button
        type="button"
        onClick={handleClick}
        aria-label="Close advisor chat"
        style={HEADER_CLOSE_STYLE}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = "white";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = "rgba(255,255,255,0.45)";
        }}
      >
        <XIcon size={16} />
      </button>
    </div>
  );
});

interface MessagesProps {
  readonly messages: readonly ChatMessage[];
  readonly isAssistantWorking: boolean;
  readonly advisorLabel: string;
  readonly error: string | null;
}

const S: Record<string, CSSProperties> = {
  p: {},
  ul: {
    margin: "4px 0",
    paddingLeft: 20,
    listStyleType: "disc",
    listStylePosition: "outside" as const,
  },
  ol: {
    margin: "4px 0",
    paddingLeft: 20,
    listStyleType: "decimal",
    listStylePosition: "outside" as const,
  },
  li: { margin: "2px 0", padding: 0, display: "list-item" },
  h1: { margin: "8px 0 4px", fontSize: 15, fontWeight: 600 },
  h2: { margin: "6px 0 3px", fontSize: 14, fontWeight: 600 },
  h3: { margin: "4px 0 2px", fontSize: 13, fontWeight: 600 },
  code: { background: "rgba(255,255,255,0.1)", borderRadius: 4, padding: "1px 4px", fontSize: 12 },
  pre: {
    background: "rgba(255,255,255,0.08)",
    borderRadius: 6,
    padding: 8,
    margin: "6px 0",
    overflow: "auto",
    fontSize: 12,
  },
  blockquote: {
    margin: "4px 0",
    paddingLeft: 12,
    borderLeft: "2px solid rgba(255,255,255,0.2)",
    fontStyle: "italic",
  },
  table: { margin: "6px 0", width: "100%", fontSize: 12, borderCollapse: "collapse" as const },
  th: {
    border: "1px solid rgba(255,255,255,0.15)",
    padding: "4px 8px",
    textAlign: "left" as const,
    fontWeight: 600,
  },
  td: { border: "1px solid rgba(255,255,255,0.1)", padding: "4px 8px" },
  a: { textDecoration: "underline" },
  hr: { margin: "8px 0", border: "none", borderTop: "1px solid rgba(255,255,255,0.1)" },
};

const advisorMarkdownComponents = {
  p: ({ children, node: _node, ...props }: React.ComponentProps<"p"> & { node?: unknown }) => (
    <p style={S.p} {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }: React.ComponentProps<"ul">) => (
    <ul style={S.ul} {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: React.ComponentProps<"ol">) => (
    <ol style={S.ol} {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }: React.ComponentProps<"li">) => (
    <li style={S.li} className="[&>p]:inline [&>p]:m-0" {...props}>
      {children}
    </li>
  ),
  h1: ({ children, ...props }: React.ComponentProps<"h1">) => (
    <h1 style={S.h1} {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: React.ComponentProps<"h2">) => (
    <h2 style={S.h2} {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: React.ComponentProps<"h3">) => (
    <h3 style={S.h3} {...props}>
      {children}
    </h3>
  ),
  code: ({ children, className, ...props }: React.ComponentProps<"code">) => {
    if (className?.includes("language-"))
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    return (
      <code style={S.code} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }: React.ComponentProps<"pre">) => (
    <pre style={S.pre} {...props}>
      {children}
    </pre>
  ),
  blockquote: ({ children, ...props }: React.ComponentProps<"blockquote">) => (
    <blockquote style={S.blockquote} {...props}>
      {children}
    </blockquote>
  ),
  table: ({ children, ...props }: React.ComponentProps<"table">) => (
    <table style={S.table} {...props}>
      {children}
    </table>
  ),
  th: ({ children, ...props }: React.ComponentProps<"th">) => (
    <th style={S.th} {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }: React.ComponentProps<"td">) => (
    <td style={S.td} {...props}>
      {children}
    </td>
  ),
  a: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a style={S.a} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
  hr: (props: React.ComponentProps<"hr">) => <hr style={S.hr} {...props} />,
};

const AdvisorCardChatMessages = memo(function AdvisorCardChatMessages({
  messages,
  isAssistantWorking,
  advisorLabel,
  error,
}: MessagesProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  const visibleMessages = useMemo(
    () => messages.filter((m) => m.role !== "system" && m.text.length > 0),
    [messages],
  );

  const lastAssistantText =
    visibleMessages.length > 0 && visibleMessages[visibleMessages.length - 1]?.role === "assistant"
      ? (visibleMessages[visibleMessages.length - 1]?.text ?? "")
      : "";

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [visibleMessages.length, lastAssistantText, isAssistantWorking]);

  const showThinking =
    isAssistantWorking &&
    (visibleMessages.length === 0 || visibleMessages[visibleMessages.length - 1]?.role === "user");

  return (
    <div ref={scrollerRef} style={MESSAGES_SCROLLER_STYLE}>
      {visibleMessages.length === 0 && !isAssistantWorking && (
        <div style={MESSAGES_EMPTY_STYLE}>Say something to {advisorLabel}…</div>
      )}
      {visibleMessages.map((message) => {
        const isUser = message.role === "user";
        return (
          <div key={message.id} style={isUser ? ROW_USER_STYLE : ROW_ASSISTANT_STYLE}>
            <div style={isUser ? USER_BUBBLE_STYLE : ASSISTANT_BUBBLE_STYLE}>
              {isUser ? (
                message.text
              ) : (
                <div
                  className="text-[13px] leading-normal [&>*+*]:mt-2"
                  style={{ overflow: "hidden" }}
                >
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={advisorMarkdownComponents}>
                    {message.text}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          </div>
        );
      })}
      {showThinking && (
        <div style={ROW_ASSISTANT_STYLE}>
          <ShimmerText className="text-[13px] font-medium text-white/50">thinking…</ShimmerText>
        </div>
      )}
      {error && <div style={ERROR_BUBBLE_STYLE}>{error}</div>}
    </div>
  );
});

interface ComposerProps {
  readonly advisorLabel: string;
  readonly isSending: boolean;
  /**
   * Returns true if the dispatch succeeded (so the composer clears its
   * draft) or false if it failed (composer keeps the draft so the user can
   * retry without retyping).
   */
  readonly onSend: (text: string) => Promise<boolean>;
}

const AdvisorCardChatComposer = memo(function AdvisorCardChatComposer({
  advisorLabel,
  isSending,
  onSend,
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trySend = useCallback(async () => {
    const text = draft.trim();
    if (!text || isSending) return;
    const ok = await onSend(text);
    if (ok) setDraft("");
  }, [draft, isSending, onSend]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void trySend();
    },
    [trySend],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void trySend();
      }
    },
    [trySend],
  );

  const trimmedLength = draft.trim().length;
  const isDisabled = isSending || trimmedLength === 0;
  const sendButtonStyle = isDisabled ? SEND_BUTTON_DISABLED_STYLE : SEND_BUTTON_ENABLED_STYLE;
  const placeholder = `Message ${advisorLabel}…`;

  return (
    <form onSubmit={handleSubmit} style={COMPOSER_FORM_STYLE}>
      <textarea
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        placeholder={placeholder}
        disabled={isSending}
        style={COMPOSER_TEXTAREA_STYLE}
      />
      <button type="submit" disabled={isDisabled} aria-label="Send message" style={sendButtonStyle}>
        <ArrowUpIcon size={14} strokeWidth={2.5} />
      </button>
    </form>
  );
});

/**
 * Inline chat surface that lives inside the office floating glass card.
 * Subscribes to its thread once via {@link useThreadById}; the header and
 * composer subtrees are independently memoised so streaming chunks only
 * re-render the messages list — the textarea keeps focus and selection,
 * and the avatar header doesn't flicker on every tick.
 */
export const AdvisorCardChat = memo(function AdvisorCardChat({
  characterId,
  threadId,
  onThreadCreated,
  onClose,
}: AdvisorCardChatProps) {
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localThreadId, setLocalThreadId] = useState<ThreadId | null>(threadId);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const advisorLabel = parseAdvisor(characterId)?.shortName ?? "Advisor";

  useEffect(() => {
    if (!threadId) return;
    setLocalThreadId((current) => (current === threadId ? current : threadId));
  }, [threadId]);

  const thread = useThreadById(localThreadId);
  const serverMessages = thread?.messages ?? EMPTY_MESSAGES;
  const messages = useMemo(
    () => mergeAdvisorCardMessages(serverMessages, optimisticUserMessages),
    [optimisticUserMessages, serverMessages],
  );
  const sessionStatus = thread?.session?.status;
  const sessionActiveTurnId = thread?.session?.activeTurnId;
  const isAssistantWorking = useMemo(
    () =>
      (sessionActiveTurnId != null && sessionStatus === "running") ||
      serverMessages.some((message) => message.role === "assistant" && message.streaming),
    [serverMessages, sessionActiveTurnId, sessionStatus],
  );

  useEffect(() => {
    setOptimisticUserMessages((existing) => {
      const next = filterAckedAdvisorCardMessages(existing, serverMessages);
      return next.length === existing.length ? existing : next;
    });
  }, [serverMessages]);

  const handleSend = useCallback(
    async (text: string): Promise<boolean> => {
      const api = readNativeApi();
      if (!api) return false;

      const createdAt = new Date().toISOString();
      const messageId = newMessageId();
      const optimisticMessage: ChatMessage = {
        id: messageId,
        role: "user",
        text,
        attachments: [],
        turnId: null,
        createdAt,
        streaming: false,
      };

      setError(null);
      setIsSending(true);
      setOptimisticUserMessages((existing) => [...existing, optimisticMessage]);

      let activeThreadId = localThreadId;
      let createdThreadId: ThreadId | null = null;
      let createDispatched = false;
      try {
        if (!activeThreadId) {
          const created = newThreadId();
          createdThreadId = created;
          activeThreadId = created;
          setLocalThreadId(created);
          // Lazy-import the catalog so the line corpus stays out of the office
          // chunk. Only the first NPC click pays the chunk download.
          const { buildAdvisorSystemPrompt } = await import("../../lib/advisorCatalog");
          await api.orchestration.dispatchCommand({
            type: "thread.create",
            commandId: newCommandId(),
            threadId: created,
            projectId: ADVISORS_PROJECT_ID,
            title: advisorThreadTitle(characterId),
            modelSelection: ADVISOR_MODEL_SELECTION,
            runtimeMode: "full-access",
            // Advisors are conversational personas — Ask mode disables every
            // tool so they reply with words, not file edits.
            interactionMode: "ask",
            systemPrompt: buildAdvisorSystemPrompt(characterId),
            branch: null,
            worktreePath: null,
            createdAt,
          });
          createDispatched = true;
          onThreadCreated(created);
        }

        await api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: activeThreadId,
          message: {
            messageId,
            role: "user",
            text,
            attachments: [],
          },
          modelSelection: ADVISOR_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "ask",
          createdAt,
        });

        return true;
      } catch (e) {
        setOptimisticUserMessages((existing) =>
          existing.filter((message) => message.id !== optimisticMessage.id),
        );
        if (createdThreadId && !createDispatched) {
          setLocalThreadId(threadId ?? null);
        }
        setError(e instanceof Error ? e.message : "Failed to send message");
        return false;
      } finally {
        setIsSending(false);
      }
    },
    [characterId, localThreadId, onThreadCreated, threadId],
  );

  return (
    <div style={ROOT_STYLE}>
      <AdvisorCardChatHeader
        characterId={characterId}
        displayName={advisorLabel}
        onClose={onClose}
      />
      <AdvisorCardChatMessages
        messages={messages}
        isAssistantWorking={isAssistantWorking}
        advisorLabel={advisorLabel}
        error={error}
      />
      <AdvisorCardChatComposer
        advisorLabel={advisorLabel}
        isSending={isSending}
        onSend={handleSend}
      />
    </div>
  );
});
