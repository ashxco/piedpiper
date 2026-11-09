import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MessageCopyButton } from "./MessageCopyButton";

const REPLY =
  'Updated :codex-file-citation{path="src/a.ts" line_range_start="3"}.\n\n- :codex-followup[Add tests]{prompt="Add tests for a.ts"}';

describe("MessageCopyButton", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [true, "Updated [a.ts](<src/a.ts#L3>).\n\n- Add tests"],
    [false, REPLY],
  ])("rewrites Codex directives when asked (%s)", async (rewrite, expected) => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.spyOn(navigator, "clipboard", "get").mockReturnValue({ writeText } as unknown as Clipboard);
    const screen = await render(
      <MessageCopyButton text={REPLY} rewriteCodexDirectives={rewrite} />,
    );
    try {
      await page.getByTitle("Copy message").click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(expected));
    } finally {
      await screen.unmount();
    }
  });
});
