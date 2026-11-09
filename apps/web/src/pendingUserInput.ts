import type { UserInputQuestion } from "@piedpiper/contracts";

export interface PendingUserInputDraftAnswer {
  selectedOptionLabel?: string;
  /** Picks on a multi-select question, in option order. */
  selectedOptionLabels?: string[];
  customAnswer?: string;
}

/** A question answer as sent to the provider: multi-select picks stay a list. */
export type PendingUserInputAnswer = string | string[];

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionLabel: string | undefined;
  selectedOptionLabels: string[];
  customAnswer: string;
  resolvedAnswer: string | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getPendingUserInputSelectedLabels(
  draft: PendingUserInputDraftAnswer | undefined,
): string[] {
  const labels =
    draft?.selectedOptionLabels ?? (draft?.selectedOptionLabel ? [draft.selectedOptionLabel] : []);
  return labels.flatMap((label) => {
    const normalized = normalizeDraftAnswer(label);
    return normalized ? [normalized] : [];
  });
}

export function resolvePendingUserInputAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
): string | null {
  const customAnswer = normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer) {
    return customAnswer;
  }

  const labels = getPendingUserInputSelectedLabels(draft);
  return labels.length > 0 ? labels.join(", ") : null;
}

/** The answer to send for one question; the server joins multi-select lists for the provider. */
export function resolvePendingUserInputStructuredAnswer(
  question: Pick<UserInputQuestion, "multiSelect">,
  draft: PendingUserInputDraftAnswer | undefined,
): PendingUserInputAnswer | null {
  const customAnswer = normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer) {
    return customAnswer;
  }
  const labels = getPendingUserInputSelectedLabels(draft);
  if (labels.length === 0) {
    return null;
  }
  return question.multiSelect === true ? labels : (labels[0] ?? null);
}

/**
 * Picking an option toggles it on a multi-select question and replaces the pick otherwise.
 * Either way it clears the custom answer, which outranks options.
 */
export function selectPendingUserInputOption(
  draft: PendingUserInputDraftAnswer | undefined,
  question: Pick<UserInputQuestion, "multiSelect" | "options">,
  optionLabel: string,
): PendingUserInputDraftAnswer {
  if (question.multiSelect !== true) {
    return { selectedOptionLabel: optionLabel, customAnswer: "" };
  }
  const current = new Set(getPendingUserInputSelectedLabels(draft));
  if (current.has(optionLabel)) {
    current.delete(optionLabel);
  } else {
    current.add(optionLabel);
  }
  const selectedOptionLabels = question.options
    .map((option) => option.label)
    .filter((label) => current.has(label));
  return { selectedOptionLabels, customAnswer: "" };
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const keepSelection = customAnswer.trim().length === 0;
  const selectedOptionLabel = keepSelection ? draft?.selectedOptionLabel : undefined;
  const selectedOptionLabels = keepSelection ? draft?.selectedOptionLabels : undefined;

  return {
    customAnswer,
    ...(selectedOptionLabel ? { selectedOptionLabel } : {}),
    ...(selectedOptionLabels ? { selectedOptionLabels } : {}),
  };
}

const DISPLACED_ANSWER_SEPARATOR = "\n\n";

/**
 * Picking an option clears the custom answer (a custom answer outranks options), so
 * text typed there moves into the thread draft after whatever was already waiting.
 */
export function carryDisplacedCustomAnswerIntoPrompt(
  prompt: string,
  customAnswer: string | undefined,
): string {
  const displaced = customAnswer?.trim() ?? "";
  if (displaced.length === 0) {
    return prompt;
  }
  if (prompt.trim().length === 0) {
    return displaced;
  }
  return `${prompt.trimEnd()}${DISPLACED_ANSWER_SEPARATOR}${displaced}`;
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, PendingUserInputAnswer> | null {
  const answers: Record<string, PendingUserInputAnswer> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputStructuredAnswer(question, draftAnswers[question.id]);
    if (!answer) {
      return null;
    }
    answers[question.id] = answer;
  }

  return answers;
}

export function countAnsweredPendingUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  return questions.reduce((count, question) => {
    return resolvePendingUserInputAnswer(draftAnswers[question.id]) ? count + 1 : count;
  }, 0);
}

export function findFirstUnansweredPendingUserInputQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  const unansweredIndex = questions.findIndex(
    (question) => !resolvePendingUserInputAnswer(draftAnswers[question.id]),
  );

  return unansweredIndex === -1 ? Math.max(questions.length - 1, 0) : unansweredIndex;
}

export function derivePendingUserInputProgress(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
): PendingUserInputProgress {
  const normalizedQuestionIndex =
    questions.length === 0 ? 0 : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[normalizedQuestionIndex] ?? null;
  const activeDraft = activeQuestion ? draftAnswers[activeQuestion.id] : undefined;
  const resolvedAnswer = resolvePendingUserInputAnswer(activeDraft);
  const customAnswer = activeDraft?.customAnswer ?? "";
  const answeredQuestionCount = countAnsweredPendingUserInputQuestions(questions, draftAnswers);
  const isLastQuestion =
    questions.length === 0 ? true : normalizedQuestionIndex >= questions.length - 1;

  return {
    questionIndex: normalizedQuestionIndex,
    activeQuestion,
    activeDraft,
    selectedOptionLabel: activeDraft?.selectedOptionLabel,
    selectedOptionLabels: getPendingUserInputSelectedLabels(activeDraft),
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer: customAnswer.trim().length > 0,
    answeredQuestionCount,
    isLastQuestion,
    isComplete: buildPendingUserInputAnswers(questions, draftAnswers) !== null,
    canAdvance: Boolean(resolvedAnswer),
  };
}
