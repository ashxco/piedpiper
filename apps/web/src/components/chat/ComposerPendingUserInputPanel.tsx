import { type ApprovalRequestId } from "@piedpiper/contracts";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  canDismissPendingUserInput,
  isBlockingPendingUserInput,
  type PendingUserInput,
} from "../../session-logic";
import { type ThreadSession } from "../../types";
import { isInsideConfirmationDialog } from "../../lib/confirmationDialogGuard";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "~/lib/utils";
import { isImeComposingKeyboardEvent } from "~/lib/imeComposition";
import ChatMarkdown from "../ChatMarkdown";
import {
  markdownProseDirection,
  questionSetDirection,
  textDirection,
} from "../../markdown-text-direction";
import { pendingUserInputQuestionSummary } from "./composerPendingUserInputSummary";
import {
  isPendingUserInputTextEntryTarget,
  resolvePendingUserInputShortcutIndex,
} from "./composerPendingUserInputKeys";

export { isPendingUserInputTextEntryTarget, resolvePendingUserInputShortcutIndex };

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  /** Resolves file links in the question text. */
  cwd?: string | undefined;
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  onCustomAnswer: (questionId: string, text: string) => void;
  onAdvance: () => void;
  /** Declines a non-blocking question, or a blocking one left open with no live turn. */
  onDismiss?: ((requestId: ApprovalRequestId) => void) | undefined;
  isTurnRunning?: boolean | undefined;
  /** Omitted, only non-blocking questions offer Dismiss. */
  session?: Pick<ThreadSession, "orchestrationStatus" | "activeTurnId"> | null | undefined;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  cwd,
  respondingRequestIds,
  answers,
  questionIndex,
  onSelectOption,
  onCustomAnswer,
  onAdvance,
  onDismiss,
  isTurnRunning = false,
  session,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      cwd={cwd}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onSelectOption={onSelectOption}
      onCustomAnswer={onCustomAnswer}
      onAdvance={onAdvance}
      onDismiss={onDismiss}
      isTurnRunning={isTurnRunning}
      session={session}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  cwd,
  isResponding,
  answers,
  questionIndex,
  onSelectOption,
  onCustomAnswer,
  onAdvance,
  onDismiss,
  isTurnRunning,
  session,
}: {
  prompt: PendingUserInput;
  cwd: string | undefined;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  onCustomAnswer: (questionId: string, text: string) => void;
  onAdvance: () => void;
  onDismiss: ((requestId: ApprovalRequestId) => void) | undefined;
  isTurnRunning: boolean;
  session: Pick<ThreadSession, "orchestrationStatus" | "activeTurnId"> | null | undefined;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  // The draft answers own the custom text, so picking an option (which clears it) shows its check.
  const customText = progress.customAnswer;
  // Storing the collapsed question's id reopens the card when the active question changes.
  const [collapsedQuestionId, setCollapsedQuestionId] = useState<string | null>(null);
  const isCollapsed = collapsedQuestionId !== null && collapsedQuestionId === activeQuestion?.id;
  // Keyed by question id so the hovered or focused option resets when the question changes.
  const [previewTarget, setPreviewTarget] = useState<{ questionId: string; index: number } | null>(
    null,
  );
  const optionListRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const scrollPreviewIntoViewRef = useRef(false);
  // Keyboard picks only: following the pointer would move the rows out from under it.
  useEffect(() => {
    if (!scrollPreviewIntoViewRef.current) return;
    scrollPreviewIntoViewRef.current = false;
    previewRef.current?.scrollIntoView({ block: "nearest" });
  });

  const selectOption = useCallback(
    (questionId: string, optionLabel: string) => {
      onSelectOption(questionId, optionLabel);
    },
    [onSelectOption],
  );

  // Keyboard shortcut: letter keys a-z and number keys 1-9 select the matching option.
  // Never fires while a text input or the contenteditable composer has focus, nor once
  // a custom answer has been typed, so typing is never hijacked into an option pick.
  const hasCustomAnswerText = progress.customAnswer.length > 0;
  useEffect(() => {
    if (!activeQuestion || isResponding || hasCustomAnswerText || isCollapsed) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        isImeComposingKeyboardEvent(event) ||
        isPendingUserInputTextEntryTarget(event.target) ||
        isInsideConfirmationDialog(event.target)
      ) {
        return;
      }
      const optionIndex = resolvePendingUserInputShortcutIndex(
        event,
        activeQuestion.options.length,
      );
      if (optionIndex === null) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      selectOption(activeQuestion.id, option.label);
      optionListRef.current?.children[optionIndex]?.scrollIntoView({ block: "nearest" });
      scrollPreviewIntoViewRef.current = true;
      setPreviewTarget({ questionId: activeQuestion.id, index: optionIndex });
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isResponding, selectOption, hasCustomAnswerText, isCollapsed]);

  if (!activeQuestion) {
    return null;
  }

  const promptDirection = questionSetDirection(prompt.questions);
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const hasOptions = activeQuestion.options.length > 0;
  const isNonBlocking = !isBlockingPendingUserInput(prompt);
  // `text-start` resolves against each element's own dir, which would put an English label in an
  // RTL set hundreds of pixels from its letter.
  const questionTextAlign = promptDirection === "rtl" ? "text-right" : "text-left";
  const canDismissNow =
    isNonBlocking || (session !== undefined && canDismissPendingUserInput(prompt, session));
  const customLetter = ALPHA[activeQuestion.options.length] ?? "?";
  const hasCustomText = customText.length > 0;
  const selectedOptionIndex = hasCustomText
    ? -1
    : activeQuestion.options.findIndex((option) =>
        progress.selectedOptionLabels.includes(option.label),
      );
  // The last hovered or focused option's preview stays while the pointer moves into it; a typed
  // custom answer with nothing hovered shows no preview.
  const previewOptionIndex =
    previewTarget?.questionId === activeQuestion.id
      ? previewTarget.index
      : hasCustomText
        ? -1
        : Math.max(0, selectedOptionIndex);
  const previewOption = activeQuestion.options[previewOptionIndex];
  const previewText = previewOption?.preview?.trim() ? previewOption.preview : null;
  const showPreviewFor = (index: number) =>
    setPreviewTarget({ questionId: activeQuestion.id, index });

  return (
    <Collapsible
      dir={promptDirection}
      className="px-4 py-3 sm:px-5"
      open={!isCollapsed}
      onOpenChange={(open) => {
        setCollapsedQuestionId(open ? null : activeQuestion.id);
      }}
    >
      <CollapsibleTrigger
        title={
          isCollapsed ? "Show the question and its options" : "Hide the question and its options"
        }
        data-pending-user-input-toggle={isCollapsed ? "collapsed" : "expanded"}
        className="group -mx-1 mb-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 py-0.5 text-start outline-none transition-colors hover:bg-accent/30 focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span
          title={activeQuestion.header}
          dir={textDirection(activeQuestion.header)}
          data-pending-user-input-header="true"
          className={cn(
            "min-w-0 truncate text-[11px] font-semibold tracking-wider text-muted-foreground uppercase group-hover:text-foreground",
            isCollapsed && "max-w-1/2",
          )}
        >
          {activeQuestion.header}
        </span>
        {prompt.questions.length > 1 ? (
          <span className="shrink-0 rounded-md bg-muted/60 px-1.5 text-[10px] font-medium text-muted-foreground tabular-nums">
            {progress.questionIndex + 1}/{prompt.questions.length}
          </span>
        ) : null}
        {isCollapsed ? (
          <span
            dir={markdownProseDirection(activeQuestion.question)}
            className={cn(
              "min-w-0 flex-1 truncate text-xs text-muted-foreground",
              questionTextAlign,
            )}
          >
            {pendingUserInputQuestionSummary(activeQuestion.question)}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "ms-auto size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:text-foreground",
            isCollapsed && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        {/* Keyed by question so moving between questions starts at the top. */}
        <ScrollArea
          key={activeQuestion.id}
          scrollFade
          // Without options only the viewport can take focus to scroll a long question.
          {...(hasOptions ? { viewportTabIndex: -1 } : {})}
          data-pending-user-input-scroll="true"
          className="h-auto max-h-[min(24rem,40dvh)] [&>[data-slot=scroll-area-viewport]]:max-h-[min(24rem,40dvh)]"
        >
          <div className="wrap-anywhere">
            <div
              dir={markdownProseDirection(activeQuestion.question)}
              // Follows the set like its options; a code block stays left-aligned inside it.
              className={cn(
                "font-medium [&>.chat-markdown]:text-[13px] [&>.chat-markdown]:leading-normal [&>.chat-markdown]:text-foreground/90 [&_.chat-markdown-codeblock]:text-start",
                questionTextAlign,
              )}
            >
              <ChatMarkdown text={activeQuestion.question} cwd={cwd} />
            </div>
            {activeQuestion.multiSelect ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                <bdi>Select one or more options.</bdi>
              </p>
            ) : null}
            <div ref={optionListRef} className={cn(hasOptions && "mt-1.5")}>
              {activeQuestion.options.map((option, index) => {
                const isSelected =
                  progress.selectedOptionLabels.includes(option.label) && !hasCustomText;
                const letter = ALPHA[index] ?? String(index + 1);
                return (
                  <button
                    // Claude options can share a label, so the index keeps keys unique.
                    // oxlint-disable-next-line react/no-array-index-key
                    key={`${activeQuestion.id}:${index}`}
                    type="button"
                    disabled={isResponding}
                    onMouseEnter={() => showPreviewFor(index)}
                    onFocus={(event) => {
                      if (event.currentTarget.matches(":focus-visible")) {
                        scrollPreviewIntoViewRef.current = true;
                      }
                      showPreviewFor(index);
                    }}
                    aria-pressed={isSelected}
                    onClick={() => selectOption(activeQuestion.id, option.label)}
                    className={cn(
                      "flex w-full items-start gap-2 border-b border-border/40 px-1 py-1.5 transition-colors",
                      questionTextAlign,
                      isSelected
                        ? "text-foreground"
                        : "text-foreground/70 hover:text-foreground hover:bg-accent/30",
                      isResponding && "opacity-50 cursor-not-allowed",
                    )}
                  >
                    <span
                      className={cn(
                        "shrink-0 text-[11px] leading-5 font-medium tabular-nums",
                        isSelected ? "text-foreground" : "text-muted-foreground/50",
                      )}
                    >
                      {letter}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span
                        dir={textDirection(option.label)}
                        className="text-[13px] leading-5 wrap-anywhere"
                      >
                        {option.label}
                      </span>
                      {option.description && option.description !== option.label ? (
                        <span
                          dir={textDirection(option.description)}
                          className="text-xs text-muted-foreground"
                        >
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {isSelected ? (
                      <CheckIcon className="mt-1 size-3 shrink-0 text-foreground" />
                    ) : null}
                  </button>
                );
              })}
            </div>
            {previewText !== null && previewOption ? (
              <div
                ref={previewRef}
                data-pending-user-input-preview="true"
                className="mt-2 rounded-md border border-border/60 bg-background/40 px-3 py-2"
              >
                <div className="mb-1 truncate text-xs text-muted-foreground">
                  <bdi>Preview · {previewOption.label}</bdi>
                </div>
                <div
                  dir={markdownProseDirection(previewText)}
                  className="[&>.chat-markdown]:text-[13px] [&>.chat-markdown]:leading-normal"
                >
                  <ChatMarkdown text={previewText} cwd={cwd} />
                </div>
              </div>
            ) : null}
          </div>
        </ScrollArea>
        {/* Custom answer — inline input styled as the next letter option, pinned below the scroller */}
        <div className="flex items-center gap-2 px-1 py-1.5">
          {hasOptions ? (
            <span
              className={cn(
                "shrink-0 text-[11px] font-medium tabular-nums",
                hasCustomText ? "text-foreground" : "text-muted-foreground/50",
              )}
            >
              {customLetter}
            </span>
          ) : null}
          <input
            type="text"
            // An empty dir=auto input computes to ltr, which detaches the placeholder from its letter.
            dir={customText ? "auto" : promptDirection}
            value={customText}
            onChange={(e) => {
              onCustomAnswer(activeQuestion.id, e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !isImeComposingKeyboardEvent(e.nativeEvent)) {
                e.preventDefault();
                onAdvance();
              }
            }}
            placeholder={hasOptions ? "Type your own answer" : "Type your answer"}
            aria-label={hasOptions ? undefined : "Your answer"}
            disabled={isResponding}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/30 outline-none"
          />
        </div>
        {(isNonBlocking && isTurnRunning) || (canDismissNow && onDismiss) ? (
          <div
            {...(isNonBlocking
              ? { "data-pending-user-input-non-blocking": "true" }
              : { "data-pending-user-input-dismissable": "true" })}
            className="flex items-center justify-between gap-2 px-1 pb-0.5"
          >
            <p className="min-w-0 text-xs text-muted-foreground">
              {isNonBlocking && isTurnRunning ? (
                <bdi>Your answer is sent when this turn finishes.</bdi>
              ) : null}
            </p>
            {canDismissNow && onDismiss ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="shrink-0"
                disabled={isResponding}
                onClick={() => onDismiss(prompt.requestId)}
              >
                Dismiss
              </Button>
            ) : null}
          </div>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
});
