import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { COMPOSER_TYPING_IDLE_MS } from "./composerTypingGuard";
import { useComposerTypingGuard } from "./useComposerTypingGuard";

type Guard = ReturnType<typeof useComposerTypingGuard>;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("useComposerTypingGuard", () => {
  it("re-renders only when a typing burst starts and ends, and holds requests meanwhile", async () => {
    let renders = 0;
    let guard: Guard | null = null;
    function Harness(props: { requestIds: string[] }) {
      renders += 1;
      guard = useComposerTypingGuard("thread-a", props.requestIds);
      return <div>{[...guard.heldRequestIds].join(",")}</div>;
    }
    const screen = await render(<Harness requestIds={[]} />);
    const current = () => guard as unknown as Guard;
    current().onFocusChange(true);
    await pause(20);
    const rendersBeforeTyping = renders;
    for (let index = 0; index < 8; index += 1) {
      current().onDraftChange();
      await pause(20);
    }
    expect(renders).toBe(rendersBeforeTyping + 1);

    await screen.rerender(<Harness requestIds={["question"]} />);
    expect([...current().heldRequestIds]).toEqual(["question"]);

    await pause(COMPOSER_TYPING_IDLE_MS + 100);
    expect([...current().heldRequestIds]).toEqual([]);
  });
});
