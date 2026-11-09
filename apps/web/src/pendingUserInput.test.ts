import { describe, expect, it } from "vitest";

import {
  buildPendingUserInputAnswers,
  carryDisplacedCustomAnswerIntoPrompt,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  getPendingUserInputSelectedLabels,
  resolvePendingUserInputAnswer,
  resolvePendingUserInputStructuredAnswer,
  selectPendingUserInputOption,
  setPendingUserInputCustomAnswer,
} from "./pendingUserInput";

describe("resolvePendingUserInputAnswer", () => {
  it("prefers a custom answer over a selected option", () => {
    expect(
      resolvePendingUserInputAnswer({
        selectedOptionLabel: "Keep current envelope",
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("falls back to the selected option", () => {
    expect(
      resolvePendingUserInputAnswer({
        selectedOptionLabel: "Scaffold only",
      }),
    ).toBe("Scaffold only");
  });

  it("clears the preset selection when a custom answer is entered", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          selectedOptionLabel: "Preserve existing tags",
        },
        "doesn't matter",
      ),
    ).toEqual({
      selectedOptionLabel: undefined,
      customAnswer: "doesn't matter",
    });
  });
});

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What should the plan target first?",
            options: [
              {
                label: "Orchestration-first",
                description: "Focus on orchestration first",
              },
            ],
          },
          {
            id: "compat",
            header: "Compat",
            question: "How strict should compatibility be?",
            options: [
              {
                label: "Keep current envelope",
                description: "Preserve current wire format",
              },
            ],
          },
        ],
        {
          scope: {
            selectedOptionLabel: "Orchestration-first",
          },
          compat: {
            customAnswer: "Keep the current envelope for one release window",
          },
        },
      ),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });

  it("returns null when any question is unanswered", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What should the plan target first?",
            options: [
              {
                label: "Orchestration-first",
                description: "Focus on orchestration first",
              },
            ],
          },
        ],
        {},
      ),
    ).toBeNull();
  });
});

describe("pending user input question progress", () => {
  const questions = [
    {
      id: "scope",
      header: "Scope",
      question: "What should the plan target first?",
      options: [
        {
          label: "Orchestration-first",
          description: "Focus on orchestration first",
        },
      ],
    },
    {
      id: "compat",
      header: "Compat",
      question: "How strict should compatibility be?",
      options: [
        {
          label: "Keep current envelope",
          description: "Preserve current wire format",
        },
      ],
    },
  ] as const;

  it("counts only answered questions", () => {
    expect(
      countAnsweredPendingUserInputQuestions(questions, {
        scope: {
          selectedOptionLabel: "Orchestration-first",
        },
      }),
    ).toBe(1);
  });

  it("finds the first unanswered question", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabel: "Orchestration-first",
        },
      }),
    ).toBe(1);
  });

  it("returns the last question index when all answers are complete", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabel: "Orchestration-first",
        },
        compat: {
          customAnswer: "Keep it for one release window",
        },
      }),
    ).toBe(1);
  });

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            selectedOptionLabel: "Orchestration-first",
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionLabel: "Orchestration-first",
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });
});

describe("carryDisplacedCustomAnswerIntoPrompt", () => {
  it("keeps the thread draft when nothing was typed into the answer", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("draft", undefined)).toBe("draft");
    expect(carryDisplacedCustomAnswerIntoPrompt("draft", "   ")).toBe("draft");
  });

  it("moves the typed answer into an empty thread draft", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("", "also rename the flag ")).toBe(
      "also rename the flag",
    );
  });

  it("appends the typed answer after an existing thread draft", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("first half\n", "second half")).toBe(
      "first half\n\nsecond half",
    );
  });
});

describe("multi-select questions", () => {
  const question = {
    id: "targets",
    header: "Targets",
    question: "Which platforms?",
    multiSelect: true,
    options: [
      { label: "macOS", description: "Apple" },
      { label: "Linux", description: "Penguin" },
      { label: "Windows", description: "Microsoft" },
    ],
  };
  const single = { ...question, id: "single", multiSelect: false };

  it("toggles picks in option order and clears the custom answer", () => {
    let draft = selectPendingUserInputOption({ customAnswer: "typed" }, question, "Windows");
    draft = selectPendingUserInputOption(draft, question, "macOS");
    expect(draft).toEqual({ selectedOptionLabels: ["macOS", "Windows"], customAnswer: "" });
    draft = selectPendingUserInputOption(draft, question, "Windows");
    expect(draft.selectedOptionLabels).toEqual(["macOS"]);
    draft = selectPendingUserInputOption(draft, question, "macOS");
    expect(resolvePendingUserInputAnswer(draft)).toBeNull();
  });

  it("replaces the pick on a single-select question", () => {
    const draft = selectPendingUserInputOption({ selectedOptionLabel: "macOS" }, single, "Linux");
    expect(draft).toEqual({ selectedOptionLabel: "Linux", customAnswer: "" });
  });

  it("sends multi-select picks as a list and single picks as a string", () => {
    expect(
      buildPendingUserInputAnswers([question, single], {
        targets: { selectedOptionLabels: ["macOS", "Linux"] },
        single: { selectedOptionLabel: "Windows" },
      }),
    ).toEqual({ targets: ["macOS", "Linux"], single: "Windows" });
    expect(
      resolvePendingUserInputStructuredAnswer(question, {
        selectedOptionLabels: ["macOS"],
        customAnswer: "  all of them ",
      }),
    ).toBe("all of them");
  });

  it("exposes every pick in progress and joins them for display", () => {
    const progress = derivePendingUserInputProgress(
      [question],
      { targets: { selectedOptionLabels: ["macOS", "Linux"] } },
      0,
    );
    expect(progress.selectedOptionLabels).toEqual(["macOS", "Linux"]);
    expect(progress.resolvedAnswer).toBe("macOS, Linux");
    expect(progress.canAdvance).toBe(true);
    expect(getPendingUserInputSelectedLabels({ selectedOptionLabel: "Linux" })).toEqual(["Linux"]);
  });

  it("keeps multi-select picks while the custom answer is empty", () => {
    expect(setPendingUserInputCustomAnswer({ selectedOptionLabels: ["macOS"] }, "")).toEqual({
      customAnswer: "",
      selectedOptionLabels: ["macOS"],
    });
    expect(setPendingUserInputCustomAnswer({ selectedOptionLabels: ["macOS"] }, "x")).toEqual({
      customAnswer: "x",
    });
  });
});
