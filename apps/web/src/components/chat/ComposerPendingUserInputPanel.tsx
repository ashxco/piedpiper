import { type ApprovalRequestId } from "@piedpiper/contracts";
import { memo, useCallback, useEffect, useState } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon } from "lucide-react";
import { cn } from "~/lib/utils";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  onCustomAnswer: (questionId: string, text: string) => void;
  onAdvance: () => void;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  onSelectOption,
  onCustomAnswer,
  onAdvance,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onSelectOption={onSelectOption}
      onCustomAnswer={onCustomAnswer}
      onAdvance={onAdvance}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  onSelectOption,
  onCustomAnswer,
  onAdvance,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  onCustomAnswer: (questionId: string, text: string) => void;
  onAdvance: () => void;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  // Per-question custom text, keyed by question id so navigating
  // back restores what the user previously typed.
  const [customTextByQuestion, setCustomTextByQuestion] = useState<Record<string, string>>({});
  const activeQuestionId = activeQuestion?.id ?? "";
  const customText = customTextByQuestion[activeQuestionId] ?? "";
  const setCustomText = useCallback(
    (text: string) => {
      setCustomTextByQuestion((prev) => ({ ...prev, [activeQuestionId]: text }));
    },
    [activeQuestionId],
  );

  const selectOption = useCallback(
    (questionId: string, optionLabel: string) => {
      onSelectOption(questionId, optionLabel);
    },
    [onSelectOption],
  );

  // Keyboard shortcut: number keys 1-9 select corresponding option and auto-advance.
  // Works even when the Lexical composer (contenteditable) has focus — the composer
  // doubles as a custom-answer field during user input, and when it's empty the digit
  // keys should pick options instead of typing into the editor.
  useEffect(() => {
    if (!activeQuestion || isResponding) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      // If the user has started typing a custom answer in the contenteditable
      // composer, let digit keys pass through so they can type numbers.
      if (target instanceof HTMLElement && target.isContentEditable) {
        const hasCustomText = progress.customAnswer.length > 0;
        if (hasCustomText) return;
      }
      // Support both letter keys (a-z) and number keys (1-9).
      const key = event.key.toLowerCase();
      let optionIndex = key.charCodeAt(0) - 97; // a=0, b=1, ...
      if (optionIndex < 0 || optionIndex > 25) {
        const digit = Number.parseInt(event.key, 10);
        if (Number.isNaN(digit) || digit < 1 || digit > 9) return;
        optionIndex = digit - 1;
      }
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      selectOption(activeQuestion.id, option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, isResponding, selectOption, progress.customAnswer.length]);

  if (!activeQuestion) {
    return null;
  }

  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const customLetter = ALPHA[activeQuestion.options.length] ?? "?";
  const hasCustomText = customText.length > 0;

  return (
    <div className="px-4 py-3 sm:px-5">
      <p className="text-[13px] font-medium text-foreground/90">{activeQuestion.question}</p>
      <div className="mt-1.5">
        {activeQuestion.options.map((option, index) => {
          const isSelected = progress.selectedOptionLabel === option.label && !hasCustomText;
          const letter = ALPHA[index] ?? String(index + 1);
          return (
            <button
              key={`${activeQuestion.id}:${option.label}`}
              type="button"
              disabled={isResponding}
              onClick={() => selectOption(activeQuestion.id, option.label)}
              className={cn(
                "flex w-full items-center gap-2 border-b border-border/40 px-1 py-1.5 text-left transition-colors",
                isSelected
                  ? "text-foreground"
                  : "text-foreground/70 hover:text-foreground hover:bg-accent/30",
                isResponding && "opacity-50 cursor-not-allowed",
              )}
            >
              <span
                className={cn(
                  "shrink-0 text-[11px] font-medium tabular-nums",
                  isSelected ? "text-foreground" : "text-muted-foreground/50",
                )}
              >
                {letter}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px]">{option.label}</span>
              {isSelected ? <CheckIcon className="size-3 shrink-0 text-foreground" /> : null}
            </button>
          );
        })}
        {/* Custom answer — inline input styled as the next letter option */}
        <div className="flex items-center gap-2 px-1 py-1.5">
          <span
            className={cn(
              "shrink-0 text-[11px] font-medium tabular-nums",
              hasCustomText ? "text-foreground" : "text-muted-foreground/50",
            )}
          >
            {customLetter}
          </span>
          <input
            type="text"
            value={customText}
            onChange={(e) => {
              setCustomText(e.target.value);
              if (activeQuestion) {
                onCustomAnswer(activeQuestion.id, e.target.value);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onAdvance();
              }
            }}
            placeholder="Type your own answer"
            disabled={isResponding}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/30 outline-none"
          />
        </div>
      </div>
    </div>
  );
});
