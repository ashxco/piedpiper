import { ApprovalRequestId } from "@piedpiper/contracts";
import "../../index.css";

import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";

const QUESTION_ID = "q-1";

function makePrompt() {
  return {
    requestId: ApprovalRequestId.makeUnsafe("request-1"),
    createdAt: "2026-04-02T20:00:00.000Z",
    questions: [
      {
        id: QUESTION_ID,
        header: "Approach",
        question: "Which approach?",
        options: [
          { label: "Alpha", description: "First" },
          { label: "Beta", description: "Second" },
        ],
      },
    ],
  };
}

function makePromptWithQuestion<T extends object>(overrides: T) {
  const prompt = makePrompt();
  const [question] = prompt.questions;
  return { ...prompt, questions: [{ ...question!, ...overrides }] };
}

function pendingUserInputPreview() {
  return document.querySelector("[data-pending-user-input-preview]");
}

function pressKey(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

async function mountPanel(answers: Record<string, PendingUserInputDraftAnswer> = {}) {
  const onSelectOption = vi.fn();
  const screen = await render(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[makePrompt()]}
      respondingRequestIds={[]}
      answers={answers}
      questionIndex={0}
      onSelectOption={onSelectOption}
      onCustomAnswer={vi.fn()}
      onAdvance={vi.fn()}
    />,
  );
  return { screen, onSelectOption };
}

describe("ComposerPendingUserInputPanel keyboard shortcuts", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("selects options from letter and digit keys when focus is outside text entry", async () => {
    const { onSelectOption } = await mountPanel();

    pressKey(document.body, "a");
    expect(onSelectOption).toHaveBeenLastCalledWith(QUESTION_ID, "Alpha");
    pressKey(document.body, "2");
    expect(onSelectOption).toHaveBeenLastCalledWith(QUESTION_ID, "Beta");
    expect(onSelectOption).toHaveBeenCalledTimes(2);
  });

  it("ignores auto-repeated keys so holding a letter does not toggle an option back and forth", async () => {
    const { onSelectOption } = await mountPanel();

    pressKey(document.body, "a");
    pressKey(document.body, "a", { repeat: true });
    pressKey(document.body, "a", { repeat: true });
    expect(onSelectOption).toHaveBeenCalledTimes(1);
  });

  it("ignores navigation and editing keys whose names start with a letter", async () => {
    const { onSelectOption } = await mountPanel();

    for (const key of ["ArrowDown", "Backspace", "CapsLock", "Delete", "Enter", "Escape"]) {
      const event = pressKey(document.body, key);
      expect(event.defaultPrevented, key).toBe(false);
    }
    expect(onSelectOption).not.toHaveBeenCalled();
  });

  it("ignores shortcuts while a modifier is held", async () => {
    const { onSelectOption } = await mountPanel();

    pressKey(document.body, "a", { metaKey: true });
    pressKey(document.body, "b", { ctrlKey: true });
    pressKey(document.body, "1", { altKey: true });
    expect(onSelectOption).not.toHaveBeenCalled();
  });

  it("lets typing through when the contenteditable composer has focus", async () => {
    const { onSelectOption } = await mountPanel();
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const paragraph = document.createElement("p");
    editor.append(paragraph);
    document.body.append(editor);

    const event = pressKey(paragraph, "a");
    expect(event.defaultPrevented).toBe(false);
    expect(onSelectOption).not.toHaveBeenCalled();
  });

  it("ignores keys from menus, selects and dialogs that use their own typeahead", async () => {
    const { onSelectOption } = await mountPanel();
    for (const role of ["menu", "listbox", "combobox", "dialog"]) {
      const container = document.createElement("div");
      container.setAttribute("role", role);
      const item = document.createElement("div");
      item.tabIndex = 0;
      container.append(item);
      document.body.append(container);
      const event = pressKey(item, "a");
      expect(event.defaultPrevented, role).toBe(false);
    }
    const select = document.createElement("select");
    document.body.append(select);
    pressKey(select, "b");
    expect(onSelectOption).not.toHaveBeenCalled();
  });

  it("ignores keys another handler already consumed", async () => {
    const { onSelectOption } = await mountPanel();
    const consumer = document.createElement("div");
    consumer.addEventListener("keydown", (event) => event.preventDefault());
    document.body.append(consumer);

    pressKey(consumer, "a");
    expect(onSelectOption).not.toHaveBeenCalled();
  });

  it("lets typing through inside the custom answer input", async () => {
    const { screen, onSelectOption } = await mountPanel();
    const input = screen.getByPlaceholder("Type your own answer");

    pressKey(input.element(), "b");
    pressKey(input.element(), "1");
    expect(onSelectOption).not.toHaveBeenCalled();
  });

  it("does not pick options once a custom answer has been typed", async () => {
    const { onSelectOption } = await mountPanel({
      [QUESTION_ID]: { customAnswer: "yes please" },
    });

    pressKey(document.body, "a");
    pressKey(document.body, "1");
    expect(onSelectOption).not.toHaveBeenCalled();
  });
});

describe("ComposerPendingUserInputPanel custom answer", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function renderPanel(answers: Record<string, PendingUserInputDraftAnswer>) {
    return (
      <ComposerPendingUserInputPanel
        pendingUserInputs={[makePrompt()]}
        respondingRequestIds={[]}
        answers={answers}
        questionIndex={0}
        onSelectOption={vi.fn()}
        onCustomAnswer={vi.fn()}
        onAdvance={vi.fn()}
      />
    );
  }

  it("shows the draft custom answer and clears it once an option replaces it", async () => {
    const screen = await render(renderPanel({ [QUESTION_ID]: { customAnswer: "my own idea" } }));
    const input = screen.getByPlaceholder("Type your own answer");
    await expect.element(input).toHaveValue("my own idea");

    await screen.rerender(
      renderPanel({ [QUESTION_ID]: { selectedOptionLabel: "Alpha", customAnswer: "" } }),
    );
    await expect.element(input).toHaveValue("");
    const alpha = screen.getByRole("button", { name: /Alpha/ });
    expect(alpha.element().querySelector("svg")).not.toBeNull();
  });
});

describe("ComposerPendingUserInputPanel content", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the question as Markdown with clickable links", async () => {
    const screen = await render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          makePromptWithQuestion({
            question: "Use `pnpm` per [the docs](https://example.com/docs)?",
          }),
        ]}
        cwd="/repo"
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onSelectOption={vi.fn()}
        onCustomAnswer={vi.fn()}
        onAdvance={vi.fn()}
      />,
    );

    await expect
      .element(screen.getByRole("link", { name: "the docs" }))
      .toHaveAttribute("href", "https://example.com/docs");
    expect(document.querySelector(".chat-markdown code")?.textContent).toBe("pnpm");
    expect(document.body.textContent).not.toContain("`pnpm`");
  });

  it("shows option descriptions under the label, skipping ones equal to the label", async () => {
    const screen = await render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          makePromptWithQuestion({
            options: [
              { label: "Alpha", description: "Fast but uses more memory" },
              { label: "Beta", description: "Beta" },
            ],
          }),
        ]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onSelectOption={vi.fn()}
        onCustomAnswer={vi.fn()}
        onAdvance={vi.fn()}
      />,
    );

    await expect
      .element(screen.getByRole("button", { name: /Alpha/ }))
      .toHaveTextContent("Fast but uses more memory");
    const beta = screen.getByRole("button", { name: /Beta/ }).element();
    expect(beta.textContent?.match(/Beta/g)).toHaveLength(1);
  });
});

describe("ComposerPendingUserInputPanel custom answer Enter", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not advance on the Enter that confirms an IME candidate", async () => {
    const onAdvance = vi.fn();
    const screen = await render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[makePrompt()]}
        respondingRequestIds={[]}
        answers={{ [QUESTION_ID]: { customAnswer: "日本" } }}
        questionIndex={0}
        onSelectOption={vi.fn()}
        onCustomAnswer={vi.fn()}
        onAdvance={onAdvance}
      />,
    );
    const input = screen.getByPlaceholder("Type your own answer").element();

    pressKey(input, "Enter", { isComposing: true });
    pressKey(input, "Enter", { keyCode: 229 });
    expect(onAdvance).not.toHaveBeenCalled();
    pressKey(input, "Enter");
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });
});

describe("ComposerPendingUserInputPanel multi-select", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the hint and a check mark on every selected option", async () => {
    const screen = await render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[makePromptWithQuestion({ multiSelect: true })]}
        respondingRequestIds={[]}
        answers={{ [QUESTION_ID]: { selectedOptionLabels: ["Alpha", "Beta"] } }}
        questionIndex={0}
        onSelectOption={vi.fn()}
        onCustomAnswer={vi.fn()}
        onAdvance={vi.fn()}
      />,
    );
    await expect.element(screen.getByText("Select one or more options.")).toBeVisible();
    for (const name of [/Alpha/, /Beta/]) {
      const option = screen.getByRole("button", { name });
      await expect.element(option).toHaveAttribute("aria-pressed", "true");
      expect(option.element().querySelector("svg")).not.toBeNull();
    }
  });
});

const toggle = () => document.querySelector<HTMLElement>("[data-pending-user-input-toggle]")!;

describe("ComposerPendingUserInputPanel collapse", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function twoQuestionPrompt() {
    const prompt = makePrompt();
    const first = prompt.questions[0]!;
    return {
      ...prompt,
      questions: [first, { ...first, id: "q-2", header: "Scope", question: "Which scope?" }],
    };
  }

  function renderPanel(questionIndex: number, onSelectOption = vi.fn()) {
    return (
      <ComposerPendingUserInputPanel
        pendingUserInputs={[twoQuestionPrompt()]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={questionIndex}
        onSelectOption={onSelectOption}
        onCustomAnswer={vi.fn()}
        onAdvance={vi.fn()}
      />
    );
  }

  it("collapses to the header line, disabling shortcuts, and reopens on the next question", async () => {
    const onSelectOption = vi.fn();
    const screen = await render(renderPanel(0, onSelectOption));

    expect(toggle().getAttribute("data-pending-user-input-toggle")).toBe("expanded");
    expect(toggle().textContent).toContain("Approach");
    expect(toggle().textContent).toContain("1/2");

    toggle().click();
    await expect
      .poll(() => toggle().getAttribute("data-pending-user-input-toggle"))
      .toBe("collapsed");
    expect(toggle().textContent).toContain("Which approach?");
    await expect.poll(() => document.querySelector('input[type="text"]')).toBeNull();
    pressKey(document.body, "a");
    expect(onSelectOption).not.toHaveBeenCalled();

    await screen.rerender(renderPanel(1, onSelectOption));
    await expect
      .poll(() => toggle().getAttribute("data-pending-user-input-toggle"))
      .toBe("expanded");
    await expect.element(screen.getByPlaceholder("Type your own answer")).toBeVisible();
    pressKey(document.body, "a");
    expect(onSelectOption).toHaveBeenLastCalledWith("q-2", "Alpha");
  });

  it("counts from the clamped question index shown when the stored index is out of range", async () => {
    await render(renderPanel(5));

    expect(toggle().textContent).toContain("Scope");
    expect(toggle().textContent).toContain("2/2");
  });

  it("shows a markdown question as plain text when collapsed", async () => {
    await render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          makePromptWithQuestion({ question: "Use `pnpm` per [the docs](https://pnpm.io)?" }),
        ]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onSelectOption={vi.fn()}
        onCustomAnswer={vi.fn()}
        onAdvance={vi.fn()}
      />,
    );

    toggle().click();
    await expect
      .poll(() => toggle().getAttribute("data-pending-user-input-toggle"))
      .toBe("collapsed");
    expect(toggle().textContent).toContain("Use pnpm per the docs?");
    expect(toggle().textContent).not.toContain("`");
    expect(toggle().textContent).not.toContain("https://pnpm.io");
  });
});

function dismissButton() {
  return Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === "Dismiss",
  );
}

describe("ComposerPendingUserInputPanel non-blocking questions", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  async function mountNonBlocking(props: {
    responseMode?: "blocking" | "message";
    isTurnRunning?: boolean;
    withOptions?: boolean;
    respondingRequestIds?: ReadonlyArray<string>;
  }) {
    const onDismiss = vi.fn();
    const prompt = {
      ...(props.withOptions === false ? makePromptWithQuestion({ options: [] }) : makePrompt()),
      ...(props.responseMode ? { responseMode: props.responseMode } : {}),
    };
    await render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[prompt]}
        respondingRequestIds={(props.respondingRequestIds ?? []).map((id) =>
          ApprovalRequestId.makeUnsafe(id),
        )}
        answers={{}}
        questionIndex={0}
        onSelectOption={vi.fn()}
        onCustomAnswer={vi.fn()}
        onAdvance={vi.fn()}
        onDismiss={onDismiss}
        isTurnRunning={props.isTurnRunning ?? false}
      />,
    );
    return { onDismiss, prompt };
  }

  it("offers Dismiss on a message-mode question and reports its request id", async () => {
    const { onDismiss, prompt } = await mountNonBlocking({ responseMode: "message" });
    dismissButton()!.click();
    expect(onDismiss).toHaveBeenCalledExactlyOnceWith(prompt.requestId);
  });

  it("disables Dismiss while the answer is being sent", async () => {
    await mountNonBlocking({ responseMode: "message", respondingRequestIds: ["request-1"] });
    expect(dismissButton()?.disabled).toBe(true);
  });

  it("says a held answer waits for the turn only while the turn runs", async () => {
    await mountNonBlocking({ responseMode: "message", isTurnRunning: true });
    expect(document.body.textContent).toContain("Your answer is sent when this turn finishes.");
    document.body.innerHTML = "";

    await mountNonBlocking({ responseMode: "message", isTurnRunning: false });
    expect(document.body.textContent).not.toContain("when this turn finishes");
  });

  it("leaves blocking questions without Dismiss or the hint", async () => {
    await mountNonBlocking({ isTurnRunning: true });
    expect(dismissButton()).toBeUndefined();
    expect(document.querySelector("[data-pending-user-input-non-blocking]")).toBeNull();
  });

  it("asks for a typed answer on a question with no options", async () => {
    await mountNonBlocking({ responseMode: "message", withOptions: false });
    const input = document.querySelector<HTMLInputElement>('input[type="text"]');
    expect(input?.placeholder).toBe("Type your answer");
    expect(input?.parentElement?.querySelector("span")).toBeNull();
  });
});

describe("ComposerPendingUserInputPanel option previews", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("previews the first option by default and switches to the hovered option", async () => {
    const screen = await render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          makePromptWithQuestion({
            options: [
              { label: "Alpha", description: "First", preview: "Alpha `code` preview" },
              { label: "Beta", description: "Second", preview: "Beta preview" },
            ],
          }),
        ]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onSelectOption={vi.fn()}
        onCustomAnswer={vi.fn()}
        onAdvance={vi.fn()}
      />,
    );

    const preview = pendingUserInputPreview;
    await expect.poll(() => preview()?.textContent).toContain("Preview · Alpha");
    expect(preview()?.querySelector(".chat-markdown code")?.textContent).toBe("code");

    await screen.getByRole("button", { name: /Beta/ }).hover();
    await expect.poll(() => preview()?.textContent).toContain("Preview · Beta");
    expect(preview()?.textContent).toContain("Beta preview");
  });

  it("shows no preview while a custom answer is typed and no option is hovered", async () => {
    await render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          makePromptWithQuestion({
            options: [
              { label: "Alpha", description: "First", preview: "Alpha preview" },
              { label: "Beta", description: "Second", preview: "Beta preview" },
            ],
          }),
        ]}
        respondingRequestIds={[]}
        answers={{ [QUESTION_ID]: { customAnswer: "my own idea" } }}
        questionIndex={0}
        onSelectOption={vi.fn()}
        onCustomAnswer={vi.fn()}
        onAdvance={vi.fn()}
      />,
    );
    expect(document.body.textContent).not.toContain("Preview ·");
  });

  it("renders no preview box when options have no preview", async () => {
    await mountPanel();
    expect(document.querySelector("[data-pending-user-input-preview]")).toBeNull();
  });
});

const viewport = () =>
  document.querySelector<HTMLElement>(
    "[data-pending-user-input-scroll] [data-slot=scroll-area-viewport]",
  )!;

const customInput = () => document.querySelector<HTMLInputElement>('input[type="text"]')!;

describe("ComposerPendingUserInputPanel long content", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const longOptions = Array.from({ length: 24 }, (_, index) => ({
    label: `Option ${index + 1}`,
    description: "A description long enough to take up a line of its own.",
  }));

  function renderPanel<T extends object>(overrides: T, onSelectOption = vi.fn()) {
    return (
      <ComposerPendingUserInputPanel
        pendingUserInputs={[makePromptWithQuestion(overrides)]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onSelectOption={onSelectOption}
        onCustomAnswer={vi.fn()}
        onAdvance={vi.fn()}
      />
    );
  }

  it("caps a long question and keeps the custom input below the scroller", async () => {
    await render(renderPanel({ options: longOptions }));

    const viewportBox = viewport().getBoundingClientRect();
    expect(viewportBox.height).toBeLessThanOrEqual(384);
    expect(viewport().scrollHeight).toBeGreaterThan(viewport().clientHeight);
    expect(viewport().contains(customInput())).toBe(false);
    expect(customInput().getBoundingClientRect().top).toBeGreaterThanOrEqual(viewportBox.bottom);
  });

  it("does not overflow on a short question", async () => {
    await mountPanel();
    expect(viewport().scrollHeight).toBeLessThanOrEqual(viewport().clientHeight);
  });

  it("keeps the preview inside the scroller with no scroller of its own", async () => {
    await render(
      renderPanel({
        options: [{ label: "Alpha", description: "First", preview: "Long\n\n".repeat(60) }],
      }),
    );
    const preview = pendingUserInputPreview()!;
    expect(viewport().contains(preview)).toBe(true);
    expect(preview.querySelector(".overflow-auto")).toBeNull();
  });

  it("scrolls an option picked by shortcut into view", async () => {
    const onSelectOption = vi.fn();
    await render(renderPanel({ options: longOptions }, onSelectOption));
    expect(viewport().scrollTop).toBe(0);

    pressKey(document.body, "t");
    expect(onSelectOption).toHaveBeenLastCalledWith(QUESTION_ID, "Option 20");
    await expect.poll(() => viewport().scrollTop).toBeGreaterThan(0);
  });

  it("lets the keyboard scroll a long question with no options", async () => {
    await render(renderPanel({ options: [], question: "A long question.\n\n".repeat(120) }));
    expect(viewport().scrollHeight).toBeGreaterThan(viewport().clientHeight);
    await expect.poll(() => viewport().tabIndex).toBe(0);
  });

  it("keeps options, not the viewport, as the tab stops when there are options", async () => {
    await render(renderPanel({ options: longOptions }));
    expect(viewport().tabIndex).toBe(-1);
  });

  describe("a preview below the fold", () => {
    const optionsWithPreviews = longOptions.map((option, index) => ({
      ...option,
      preview: `Preview body ${index + 1}`,
    }));
    const previewIsInView = () => {
      const preview = pendingUserInputPreview()!.getBoundingClientRect();
      const box = viewport().getBoundingClientRect();
      return preview.top >= box.top - 0.5 && preview.bottom <= box.bottom + 0.5;
    };

    it("follows a shortcut pick into view", async () => {
      await render(renderPanel({ options: optionsWithPreviews }));
      expect(previewIsInView()).toBe(false);

      pressKey(document.body, "c");
      await expect.poll(() => pendingUserInputPreview()?.textContent).toContain("Preview body 3");
      await expect.poll(previewIsInView).toBe(true);
    });

    it("follows keyboard focus into view", async () => {
      await render(renderPanel({ options: optionsWithPreviews }));
      await userEvent.keyboard("{Tab}{Tab}");
      await expect.poll(previewIsInView).toBe(true);
    });

    it("stays put under the pointer", async () => {
      await render(renderPanel({ options: optionsWithPreviews }));
      const option = viewport().querySelectorAll("button")[1]!;
      await userEvent.hover(option);
      await expect.poll(() => pendingUserInputPreview()?.textContent).toContain("Preview body 2");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(viewport().scrollTop).toBe(0);
    });
  });

  it("resets the scroll position on the next question", async () => {
    const prompt = makePromptWithQuestion({ options: longOptions });
    const twoQuestions = {
      ...prompt,
      questions: [prompt.questions[0]!, { ...prompt.questions[0]!, id: "q-2" }],
    };
    const panel = (questionIndex: number) => (
      <ComposerPendingUserInputPanel
        pendingUserInputs={[twoQuestions]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={questionIndex}
        onSelectOption={vi.fn()}
        onCustomAnswer={vi.fn()}
        onAdvance={vi.fn()}
      />
    );
    const screen = await render(panel(0));
    viewport().scrollTop = 200;
    await expect.poll(() => viewport().scrollTop).toBeGreaterThan(0);

    await screen.rerender(panel(1));
    await expect.poll(() => viewport().scrollTop).toBe(0);
  });

  it("keeps a long header and the chevron inside the row", async () => {
    await render(renderPanel({ header: "A very long header ".repeat(40) }));
    const header = document.querySelector<HTMLElement>("[data-pending-user-input-header]")!;
    expect(header.title).toContain("A very long header");
    expect(header.scrollWidth).toBeGreaterThan(header.clientWidth);
    const row = toggle().getBoundingClientRect();
    const chevron = toggle().querySelector("svg")!.getBoundingClientRect();
    expect(chevron.right).toBeLessThanOrEqual(row.right + 0.5);

    toggle().click();
    await expect
      .poll(() => toggle().getAttribute("data-pending-user-input-toggle"))
      .toBe("collapsed");
    expect(header.getBoundingClientRect().width).toBeLessThanOrEqual(row.width / 2 + 0.5);
    expect(toggle().querySelector("svg")!.getBoundingClientRect().right).toBeLessThanOrEqual(
      row.right + 0.5,
    );
  });

  it("wraps a long option label instead of clipping it", async () => {
    const screen = await render(
      renderPanel({
        options: [{ label: "x".repeat(600), description: "Long" }],
      }),
    );
    const label = screen.getByRole("button", { name: /xxx/ }).element().querySelector("span span")!;
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
    expect(label.getBoundingClientRect().height).toBeGreaterThan(20);
  });

  it("announces single-select state and clears it when a custom answer is typed", async () => {
    const panel = (answer: PendingUserInputDraftAnswer) => (
      <ComposerPendingUserInputPanel
        pendingUserInputs={[makePrompt()]}
        respondingRequestIds={[]}
        answers={{ [QUESTION_ID]: answer }}
        questionIndex={0}
        onSelectOption={vi.fn()}
        onCustomAnswer={vi.fn()}
        onAdvance={vi.fn()}
      />
    );
    const screen = await render(panel({ selectedOptionLabel: "Alpha" }));
    const alpha = screen.getByRole("button", { name: /Alpha/ });
    const beta = screen.getByRole("button", { name: /Beta/ });
    await expect.element(alpha).toHaveAttribute("aria-pressed", "true");
    await expect.element(beta).toHaveAttribute("aria-pressed", "false");

    await screen.rerender(panel({ selectedOptionLabel: "Alpha", customAnswer: "mine" }));
    await expect.element(alpha).toHaveAttribute("aria-pressed", "false");
  });
});
