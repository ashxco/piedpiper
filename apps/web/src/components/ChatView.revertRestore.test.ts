import {
  EventId,
  MessageId,
  type OrchestrationThreadActivity,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IMAGE_ONLY_BOOTSTRAP_PROMPT } from "@piedpiper/shared/imageOnlyBootstrapPrompt";
import { appendReviewCommentsToPrompt, type ReviewCommentContext } from "../reviewCommentContext";
import { useStore } from "../store";
import { type ChatMessage, type Thread, type TurnDiffSummary } from "../types";
import {
  buildRevertedComposerImages,
  fetchRevertedMessageImages,
  isThreadReverting,
  mergeRevertedPrompt,
  restorableReviewComments,
  revertedImagesFitDraft,
  setThreadReverting,
  unrestoredImagesToast,
  waitForRevertedMessage,
} from "./ChatView.revertRestore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const MESSAGE_ID = MessageId.makeUnsafe("message-2");

function userMessage(id: MessageId): ChatMessage {
  return { id, role: "user", text: "hi", createdAt: "2026-01-01T00:00:00.000Z", streaming: false };
}

function checkpoint(checkpointTurnCount: number): TurnDiffSummary {
  return {
    turnId: TurnId.makeUnsafe(`turn-${checkpointTurnCount}`),
    completedAt: "2026-01-01T00:00:00.000Z",
    files: [],
    checkpointTurnCount,
  };
}

function failureActivity(id: string, detail: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(id),
    tone: "error",
    kind: "checkpoint.revert.failed",
    summary: "Checkpoint revert failed",
    payload: { turnCount: 1, detail },
    turnId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function setThread(overrides: Partial<Thread>): void {
  useStore.setState({
    threads: [
      {
        id: THREAD_ID,
        messages: [userMessage(MESSAGE_ID)],
        activities: [],
        turnDiffSummaries: [checkpoint(1), checkpoint(2)],
        ...overrides,
      } as Thread,
    ],
  });
}

function wait(revert: () => Promise<unknown> = async () => {}, timeoutMs?: number) {
  return waitForRevertedMessage({
    threadId: THREAD_ID,
    messageId: MESSAGE_ID,
    turnCount: 1,
    revert,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

describe("mergeRevertedPrompt", () => {
  it("restores the typed text into an empty draft", () => {
    expect(mergeRevertedPrompt("", "  fix the bug \n")).toBe("fix the bug");
  });

  it("appends to an existing draft", () => {
    expect(mergeRevertedPrompt("draft", "fix the bug")).toBe("draft\n\nfix the bug");
  });

  it("leaves the draft alone for an image-only message", () => {
    expect(mergeRevertedPrompt("draft", IMAGE_ONLY_BOOTSTRAP_PROMPT)).toBe("draft");
    expect(mergeRevertedPrompt("", IMAGE_ONLY_BOOTSTRAP_PROMPT)).toBe("");
  });
});

describe("waitForRevertedMessage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setThread({});
  });

  afterEach(() => {
    vi.useRealTimers();
    useStore.setState({ threads: [] });
  });

  it("resolves once the message leaves the store", async () => {
    const pending = wait();
    setThread({ messages: [] });
    await expect(pending).resolves.toBeUndefined();
  });

  it("stays pending while the message is still there", async () => {
    let settled = false;
    const pending = wait().finally(() => {
      settled = true;
    });
    setThread({});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    setThread({ messages: [] });
    await pending;
  });

  it("resolves when newer checkpoints go even though the message is retained", async () => {
    const pending = wait();
    setThread({ turnDiffSummaries: [checkpoint(1)] });
    await expect(pending).resolves.toBeUndefined();
  });

  it("works for a second revert on the same thread", async () => {
    const first = wait();
    setThread({ messages: [] });
    await first;
    setThread({ messages: [userMessage(MESSAGE_ID)] });
    const second = wait();
    setThread({ messages: [] });
    await expect(second).resolves.toBeUndefined();
  });

  it("rejects on a new revert failure, ignoring earlier ones", async () => {
    setThread({ activities: [failureActivity("old", "old failure")] });
    const pending = wait();
    setThread({ activities: [failureActivity("old", "old failure")] });
    await Promise.resolve();
    setThread({
      activities: [failureActivity("old", "old failure"), failureActivity("new", "dirty tree")],
    });
    await expect(pending).rejects.toThrow("dirty tree");
  });

  it("rejects when the command is refused", async () => {
    await expect(wait(() => Promise.reject(new Error("refused")))).rejects.toThrow("refused");
  });

  it("rejects on timeout and stops listening", async () => {
    const pending = wait(undefined, 5_000);
    const assertion = expect(pending).rejects.toThrow("Timed out");
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("rejects when the thread goes away", async () => {
    const pending = wait();
    useStore.setState({ threads: [] });
    await expect(pending).rejects.toThrow("no longer available");
  });

  it("subscribes before dispatching, so a revert applied during dispatch is seen", async () => {
    await expect(
      wait(async () => {
        setThread({ messages: [] });
      }),
    ).resolves.toBeUndefined();
  });
});

describe("fetchRevertedMessageImages", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const attachment = {
    type: "image" as const,
    id: "image-1",
    name: "a.png",
    mimeType: "image/png",
    sizeBytes: 1,
    previewUrl: "http://localhost/attachments/image-1",
  };

  it("leaves out a PDF, which has no preview to fetch", async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(["x"])));
    vi.stubGlobal("fetch", fetchMock);
    const { files } = await fetchRevertedMessageImages({
      attachments: [
        attachment,
        { type: "file", id: "pdf-1", name: "a.pdf", mimeType: "application/pdf", sizeBytes: 1 },
      ],
    });
    expect(files.map((file) => file.name)).toEqual(["a.png"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns files with the attachment's name and type", async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(["x"])));
    vi.stubGlobal("fetch", fetchMock);
    const {
      files: [file],
    } = await fetchRevertedMessageImages({ attachments: [attachment] });
    expect(file).toMatchObject({ name: "a.png", type: "image/png", size: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      attachment.previewUrl,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns nothing for a message without images", async () => {
    await expect(fetchRevertedMessageImages({})).resolves.toEqual({ files: [], failedNames: [] });
  });

  it("reports a bad response, a network error, a body failure or a missing preview URL", async () => {
    const failed = { files: [], failedNames: ["a.png"] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    await expect(fetchRevertedMessageImages({ attachments: [attachment] })).resolves.toEqual(
      failed,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(fetchRevertedMessageImages({ attachments: [attachment] })).resolves.toEqual(
      failed,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        blob: async () => {
          throw new DOMException("signal timed out", "TimeoutError");
        },
      })),
    );
    await expect(fetchRevertedMessageImages({ attachments: [attachment] })).resolves.toEqual(
      failed,
    );
    const { previewUrl: _previewUrl, ...withoutUrl } = attachment;
    await expect(fetchRevertedMessageImages({ attachments: [withoutUrl] })).resolves.toEqual(
      failed,
    );
  });

  it("keeps the images it could read when another one fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("gone") ? new Response(null, { status: 404 }) : new Response(new Blob(["x"])),
      ),
    );
    const { files, failedNames } = await fetchRevertedMessageImages({
      attachments: [
        attachment,
        { ...attachment, id: "image-2", name: "b.png", previewUrl: "http://localhost/gone" },
      ],
    });
    expect(files.map((file) => file.name)).toEqual(["a.png"]);
    expect(failedNames).toEqual(["b.png"]);
  });
});

describe("revertedImagesFitDraft", () => {
  const restored = [{ size: 10 }];

  it("always fits when nothing comes back", () => {
    const draftImages = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS + 1 }, () => ({
      sizeBytes: 1,
    }));
    expect(revertedImagesFitDraft({ draftImages, preparingImageCount: 0, restoredFiles: [] })).toBe(
      true,
    );
  });

  it("counts images still being fitted toward the attachment limit", () => {
    const draftImages = [{ sizeBytes: 1 }];
    const room = PROVIDER_SEND_TURN_MAX_ATTACHMENTS - draftImages.length - restored.length;
    const fits = (preparingImageCount: number) =>
      revertedImagesFitDraft({ draftImages, preparingImageCount, restoredFiles: restored });
    expect(fits(room)).toBe(true);
    expect(fits(room + 1)).toBe(false);
  });

  it("refuses restored images that push the draft over the byte budget", () => {
    const fits = (sizeBytes: number) =>
      revertedImagesFitDraft({
        draftImages: [{ sizeBytes }],
        preparingImageCount: 0,
        restoredFiles: restored,
      });
    expect(fits(PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES - 10)).toBe(true);
    expect(fits(PROVIDER_SEND_TURN_MAX_TOTAL_IMAGE_BYTES - 9)).toBe(false);
  });
});

describe("unrestoredImagesToast", () => {
  it("names the images it could not restore", () => {
    expect(unrestoredImagesToast(["a.png"])).toEqual({
      title: "An image was not restored.",
      description: "Attach it again before sending: a.png.",
    });
    expect(unrestoredImagesToast(["a.png", "b.png"])).toEqual({
      title: "2 images were not restored.",
      description: "Attach them again before sending: a.png, b.png.",
    });
  });
});

describe("thread reverting flag", () => {
  it("tracks each thread on its own", () => {
    const other = ThreadId.makeUnsafe("thread-other");
    setThreadReverting(THREAD_ID, true);
    expect(isThreadReverting(THREAD_ID)).toBe(true);
    expect(isThreadReverting(other)).toBe(false);
    setThreadReverting(other, true);
    setThreadReverting(other, false);
    expect(isThreadReverting(THREAD_ID)).toBe(true);
    setThreadReverting(THREAD_ID, false);
    expect(isThreadReverting(THREAD_ID)).toBe(false);
  });
});

describe("buildRevertedComposerImages", () => {
  it("gives each file a new id and its own preview URL", () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:preview" }));
    const file = new File(["x"], "a.png", { type: "image/png" });
    const [first, second] = buildRevertedComposerImages([file, file]);
    expect(first).toMatchObject({
      type: "image",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 1,
      previewUrl: "blob:preview",
      file,
    });
    expect(first?.id).not.toBe(second?.id);
    vi.unstubAllGlobals();
  });
});

describe("restorableReviewComments", () => {
  const comment: ReviewCommentContext = {
    id: "comment-1",
    sectionId: "uncommitted",
    sectionTitle: "Uncommitted",
    filePath: "src/app.ts",
    startIndex: 0,
    endIndex: 1,
    rangeLabel: "L1",
    text: "rename this",
    diff: "+const a = 1;",
    selection: { start: 1, side: "additions", end: 1, endSide: "additions" },
  };

  it("returns nothing for a message without comments", () => {
    expect(restorableReviewComments("just a prompt")).toEqual([]);
  });

  it("parses the comments, leaving the prompt to mergeRevertedPrompt", () => {
    const text = appendReviewCommentsToPrompt("fix this", [comment]);
    const [restored] = restorableReviewComments(text);
    expect(restored).toMatchObject({
      filePath: "src/app.ts",
      rangeLabel: "L1",
      text: "rename this",
      diff: "+const a = 1;",
    });
    expect(restored?.selection).toBeUndefined();
    expect(mergeRevertedPrompt("", text)).toBe("fix this");
  });

  it("restores a comment-only message, which leaves the prompt empty", () => {
    const text = appendReviewCommentsToPrompt("", [comment]);
    expect(restorableReviewComments(text)).toHaveLength(1);
    expect(mergeRevertedPrompt("", text)).toBe("");
  });

  it("gives parsed comments fresh ids, so another message's same-range comment is kept", () => {
    const text = appendReviewCommentsToPrompt("", [comment]);
    const [first] = restorableReviewComments(text);
    const [second] = restorableReviewComments(text);
    expect(first?.id).not.toBe(second?.id);
  });
});
