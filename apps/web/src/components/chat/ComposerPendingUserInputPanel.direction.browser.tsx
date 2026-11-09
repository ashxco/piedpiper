import { ApprovalRequestId } from "@piedpiper/contracts";
import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

type Question = Parameters<
  typeof ComposerPendingUserInputPanel
>[0]["pendingUserInputs"][number]["questions"][number];

async function mountQuestions(questions: Question[], questionIndex = 0) {
  return render(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[
        {
          requestId: ApprovalRequestId.makeUnsafe("request-direction"),
          createdAt: "2026-04-02T20:00:00.000Z",
          questions,
        },
      ]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={questionIndex}
      onSelectOption={vi.fn()}
      onCustomAnswer={vi.fn()}
      onAdvance={vi.fn()}
    />,
  );
}

function optionButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!button) throw new Error(`no option button for ${label}`);
  return button;
}

function computedDirection(element: Element): string {
  return getComputedStyle(element).direction;
}

function labelDirection(label: string): string {
  const span = Array.from(optionButton(label).querySelectorAll("span")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!span) throw new Error(`no label span for ${label}`);
  return computedDirection(span);
}

function questionParagraph(text: string): HTMLElement {
  const paragraph = Array.from(document.querySelectorAll<HTMLElement>(".chat-markdown p")).find(
    (candidate) => candidate.textContent?.includes(text),
  );
  if (!paragraph) throw new Error(`no rendered paragraph for ${text}`);
  return paragraph;
}

describe("ComposerPendingUserInputPanel text direction", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lays out a mostly Hebrew set right to left, and an English option left to right", async () => {
    const screen = await mountQuestions([
      {
        id: "q-1",
        header: "גישה",
        question: "באיזו גישה כדאי לבחור עכשיו?",
        options: [
          { label: "לשדרג את הגרסה", description: "שינוי קטן בלבד" },
          { label: "Keep it on React 18", description: "לא לשנות כלום" },
        ],
      },
    ]);
    try {
      expect(computedDirection(optionButton("לשדרג את הגרסה"))).toBe("rtl");
      expect(labelDirection("לשדרג את הגרסה")).toBe("rtl");
      expect(labelDirection("Keep it on React 18")).toBe("ltr");
      // An empty dir=auto input computes to ltr, which would detach the placeholder from its letter.
      const customInput = document.querySelector('input[type="text"]') as Element;
      expect(computedDirection(customInput)).toBe("rtl");

      // Right-aligned against the set, so a left-to-right label stays beside its letter.
      const englishButton = optionButton("Keep it on React 18");
      const englishLabel = Array.from(englishButton.querySelectorAll("span")).find(
        (candidate) => candidate.textContent === "Keep it on React 18",
      ) as HTMLElement;
      expect(getComputedStyle(englishButton).textAlign).toBe("right");
      expect(englishLabel.getBoundingClientRect().width).toBeGreaterThan(0);

      const header = document.querySelector("[data-pending-user-input-header]") as Element;
      expect(computedDirection(header)).toBe("rtl");
      const description = Array.from(optionButton("לשדרג את הגרסה").querySelectorAll("span")).find(
        (candidate) => candidate.textContent === "שינוי קטן בלבד",
      ) as Element;
      expect(computedDirection(description)).toBe("rtl");

      (document.querySelector("[data-pending-user-input-toggle]") as HTMLElement).click();
      await vi.waitFor(() => {
        const toggle = document.querySelector("[data-pending-user-input-toggle]") as Element;
        expect(toggle.getAttribute("data-pending-user-input-toggle")).toBe("collapsed");
        const summary = Array.from(toggle.querySelectorAll("span")).find((candidate) =>
          candidate.textContent?.includes("באיזו גישה"),
        ) as Element;
        expect(computedDirection(summary)).toBe("rtl");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("takes the direction from the whole set, not the question on screen", async () => {
    const screen = await mountQuestions(
      [
        {
          id: "q-1",
          header: "Approach",
          question: "Which approach should this take for the migration?",
          options: [
            { label: "Upgrade the library", description: "A small change" },
            { label: "Stay on the current version", description: "Change nothing" },
          ],
        },
        {
          id: "q-2",
          header: "Version",
          question: "Which version should it target next?",
          options: [
            { label: "גרסה חדשה", description: "The newest release" },
            { label: "Keep the current one", description: "No change at all" },
          ],
        },
      ],
      1,
    );
    try {
      expect(computedDirection(optionButton("גרסה חדשה"))).toBe("ltr");
      expect(labelDirection("גרסה חדשה")).toBe("rtl");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps an English set left to right around one short Hebrew question", async () => {
    const screen = await mountQuestions([
      {
        id: "q-1",
        header: "Approach",
        question: "Which approach should this take for the migration?",
        options: [
          { label: "שדרוג", description: "Upgrade to the latest release of the library" },
          { label: "Stay on the current version", description: "Change nothing for now" },
        ],
      },
    ]);
    try {
      expect(computedDirection(optionButton("שדרוג"))).toBe("ltr");
      expect(labelDirection("שדרוג")).toBe("rtl");
    } finally {
      await screen.unmount();
    }
  });

  describe("the expanded question's alignment", () => {
    it("sides an English question with a mostly Hebrew set", async () => {
      const screen = await mountQuestions([
        {
          id: "q-1",
          header: "גישה",
          question: "Which one?",
          options: [
            { label: "לשדרג את הגרסה", description: "שינוי קטן בלבד בקוד הקיים של הפרויקט" },
            { label: "להישאר על הגרסה הנוכחית", description: "לא לשנות כלום בשלב הזה של העבודה" },
          ],
        },
      ]);
      try {
        await vi.waitFor(() => {
          expect(getComputedStyle(questionParagraph("Which one?")).textAlign).toBe("right");
        });
        expect(computedDirection(questionParagraph("Which one?"))).toBe("ltr");
      } finally {
        await screen.unmount();
      }
    });

    it("sides a Hebrew question with a mostly English set", async () => {
      const screen = await mountQuestions([
        {
          id: "q-1",
          header: "Approach",
          question: "איזו גישה?",
          options: [
            { label: "Upgrade the library", description: "A small change to the existing code" },
            { label: "Stay on the current version", description: "Change nothing for now at all" },
          ],
        },
      ]);
      try {
        await vi.waitFor(() => {
          expect(getComputedStyle(questionParagraph("איזו גישה")).textAlign).toBe("left");
        });
        expect(computedDirection(questionParagraph("איזו גישה"))).toBe("rtl");
      } finally {
        await screen.unmount();
      }
    });

    it("keeps a fenced code block left-aligned in a right-aligned question", async () => {
      const screen = await mountQuestions([
        {
          id: "q-1",
          header: "גישה",
          question: "האם להריץ את הפקודה הזאת עכשיו?\n\n```sh\nbun run build\n```",
          options: [
            { label: "כן, להריץ", description: "להריץ את הפקודה מיד" },
            { label: "לא עכשיו", description: "לחכות לשלב הבא של העבודה" },
          ],
        },
      ]);
      try {
        await vi.waitFor(() => {
          expect(document.querySelector(".chat-markdown-codeblock pre")).not.toBeNull();
        });
        const block = document.querySelector(".chat-markdown-codeblock") as Element;
        expect(getComputedStyle(block).textAlign).toBe("start");
        expect(computedDirection(block)).toBe("ltr");
      } finally {
        await screen.unmount();
      }
    });
  });
});
