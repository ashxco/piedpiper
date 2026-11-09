import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@piedpiper/contracts";
import { Effect, FileSystem } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { parseThreadSegmentFromAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import {
  makeCodexGeneratedImageTracker,
  persistCodexGeneratedImage,
  readCodexGeneratedImageAttachment,
  readCodexGeneratedImagePath,
  sniffGeneratedImageMimeType,
  stripCodexGeneratedImageBytes,
  withCodexGeneratedImageAttachment,
} from "./generatedImages.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const threadId = ThreadId.makeUnsafe("thread-1");
const completedImage = (savedPath: string, id = "image-1") => ({
  type: "imageGeneration",
  id,
  status: "completed",
  savedPath,
});

describe("stripCodexGeneratedImageBytes", () => {
  it("removes the base64 result and keeps the rest of the item", () => {
    const params = {
      turnId: "turn-1",
      item: { ...completedImage("/tmp/a.png"), result: "aW1hZ2U=" },
    };
    const stripped = stripCodexGeneratedImageBytes(params);
    expect(JSON.stringify(stripped)).not.toContain("aW1hZ2U=");
    expect(stripped).toEqual({ turnId: "turn-1", item: completedImage("/tmp/a.png") });
  });

  it("removes the result from the items of a turn payload", () => {
    const other = { type: "agentMessage", id: "msg-1", text: "done" };
    const params = {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [other, { ...completedImage("/tmp/a.png"), result: "aW1hZ2U=" }],
      },
    };
    const stripped = stripCodexGeneratedImageBytes(params);
    expect(JSON.stringify(stripped)).not.toContain("aW1hZ2U=");
    expect(stripped).toEqual({
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [other, completedImage("/tmp/a.png")],
      },
    });
  });

  it("removes the result from the turns of a thread payload", () => {
    const params = {
      thread: {
        id: "thread-1",
        turns: [{ id: "turn-1", items: [{ ...completedImage("/tmp/a.png"), result: "aW1hZ2U=" }] }],
      },
    };
    expect(stripCodexGeneratedImageBytes(params)).toEqual({
      thread: { id: "thread-1", turns: [{ id: "turn-1", items: [completedImage("/tmp/a.png")] }] },
    });
  });

  it("returns other payloads untouched", () => {
    const params = { item: { type: "agentMessage", result: "keep" } };
    expect(stripCodexGeneratedImageBytes(params)).toBe(params);
    expect(stripCodexGeneratedImageBytes(undefined)).toBeUndefined();
    const turnParams = {
      turn: { id: "turn-1", items: [{ type: "agentMessage", result: "keep" }] },
    };
    expect(stripCodexGeneratedImageBytes(turnParams)).toBe(turnParams);
    const threadParams = { thread: { id: "thread-1", turns: [{ id: "turn-1", items: [] }] } };
    expect(stripCodexGeneratedImageBytes(threadParams)).toBe(threadParams);
  });
});

describe("readCodexGeneratedImagePath", () => {
  it.each([
    ["running", { ...completedImage("/tmp/a.png"), status: "in_progress" }],
    ["failed", { ...completedImage("/tmp/a.png"), status: "failed" }],
    ["completed with a failure", { ...completedImage("/tmp/a.png"), failure: { type: "limit" } }],
    ["not saved", { ...completedImage("/tmp/a.png"), savedPath: null }],
    ["relative path", completedImage("a.png")],
    ["another item", { ...completedImage("/tmp/a.png"), type: "imageView" }],
  ])("ignores an item that is %s", (_name, item) => {
    expect(readCodexGeneratedImagePath(item)).toBeUndefined();
  });

  it("accepts a completed item with a path and no failure", () => {
    expect(readCodexGeneratedImagePath({ ...completedImage("/tmp/a.png"), failure: null })).toBe(
      "/tmp/a.png",
    );
  });
});

describe("sniffGeneratedImageMimeType", () => {
  it("reads the type from the bytes", () => {
    expect(sniffGeneratedImageMimeType(PNG)).toBe("image/png");
    expect(sniffGeneratedImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffGeneratedImageMimeType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffGeneratedImageMimeType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  });

  it("rejects anything else, including SVG", () => {
    expect(sniffGeneratedImageMimeType(Buffer.from("<svg xmlns='x'/>"))).toBeUndefined();
    expect(sniffGeneratedImageMimeType(new Uint8Array())).toBeUndefined();
  });
});

describe("makeCodexGeneratedImageTracker", () => {
  const completed = (savedPath: string, turnId = "turn-1", id = "image-1") => ({
    method: "item/completed",
    threadId,
    turnId: TurnId.makeUnsafe(turnId),
    payload: { item: completedImage(savedPath, id) },
  });
  const turnCompleted = (status: string, turnId = "turn-1") => ({
    method: "turn/completed",
    threadId,
    turnId: TurnId.makeUnsafe(turnId),
    payload: { turn: { id: turnId, status } },
  });
  const turnStarted = { method: "turn/started", threadId, payload: {} };

  it("reports each saved file once, even from two items", () => {
    const tracker = makeCodexGeneratedImageTracker();
    expect(tracker.observe(completed("/tmp/a.png"))).toBe("/tmp/a.png");
    expect(tracker.observe(completed("/tmp/a.png"))).toBeUndefined();
    expect(tracker.observe(completed("/tmp/a.png", "turn-1", "image-2"))).toBeUndefined();
    expect(tracker.observe(completed("/tmp/b.png"))).toBe("/tmp/b.png");
  });

  it("still reports an image completing after a normal turn end", () => {
    const tracker = makeCodexGeneratedImageTracker();
    tracker.observe(turnCompleted("completed"));
    expect(tracker.observe(completed("/tmp/late.png"))).toBe("/tmp/late.png");
  });

  it("drops images finishing after an interrupt, including after the next turn started", () => {
    const tracker = makeCodexGeneratedImageTracker();
    expect(tracker.observe(completed("/tmp/before.png"))).toBe("/tmp/before.png");
    tracker.interruptRequested(threadId);
    expect(tracker.observe(completed("/tmp/during.png"))).toBeUndefined();
    tracker.observe(turnCompleted("interrupted"));
    tracker.observe(turnStarted);
    expect(tracker.observe(completed("/tmp/stale.png"))).toBeUndefined();
    expect(tracker.observe(completed("/tmp/next.png", "turn-2"))).toBe("/tmp/next.png");
  });

  it("keeps images when the interrupt request failed", () => {
    const tracker = makeCodexGeneratedImageTracker();
    tracker.interruptRequested(threadId);
    tracker.interruptFailed(threadId);
    expect(tracker.observe(completed("/tmp/a.png"))).toBe("/tmp/a.png");
  });
});

describe("persistCodexGeneratedImage", () => {
  const tempDirs: string[] = [];
  const makeDirs = () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "codex-generated-image-"));
    tempDirs.push(root);
    return { root, attachmentsDir: NodePath.join(root, "attachments") };
  };
  const persist = (attachmentsDir: string, savedPath: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        return yield* persistCodexGeneratedImage({
          fileSystem,
          attachmentsDir,
          threadId,
          savedPath,
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("copies the image and describes it from its bytes", async () => {
    const { root, attachmentsDir } = makeDirs();
    const savedPath = NodePath.join(root, "ig_1.bin");
    NodeFS.writeFileSync(savedPath, PNG);

    const attachment = await persist(attachmentsDir, savedPath);

    expect(attachment).toMatchObject({
      type: "image",
      name: "ig_1.bin",
      mimeType: "image/png",
      sizeBytes: PNG.byteLength,
    });
    expect(parseThreadSegmentFromAttachmentId(attachment!.id)).toBe("thread-1");
    const stored = resolveAttachmentPath({ attachmentsDir, attachment: attachment! });
    expect(stored?.endsWith(".png")).toBe(true);
    expect(NodeFS.readFileSync(stored!).equals(PNG)).toBe(true);
  });

  it("gives one saved file the same attachment every time", async () => {
    const { root, attachmentsDir } = makeDirs();
    const savedPath = NodePath.join(root, "a.png");
    NodeFS.writeFileSync(savedPath, PNG);
    expect(await persist(attachmentsDir, savedPath)).toEqual(
      await persist(attachmentsDir, savedPath),
    );
  });

  it("refuses files that are not images, too large, or directories", async () => {
    const { root, attachmentsDir } = makeDirs();
    const text = NodePath.join(root, "fake.png");
    NodeFS.writeFileSync(text, "not an image");
    const large = NodePath.join(root, "large.png");
    NodeFS.writeFileSync(
      large,
      Buffer.concat([PNG, Buffer.alloc(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)]),
    );

    expect(await persist(attachmentsDir, text)).toBeUndefined();
    expect(await persist(attachmentsDir, large)).toBeUndefined();
    expect(await persist(attachmentsDir, root)).toBeUndefined();
    expect(NodeFS.existsSync(attachmentsDir)).toBe(false);
  });

  it("fails on a missing file so the caller can log it", async () => {
    const { root, attachmentsDir } = makeDirs();
    await expect(persist(attachmentsDir, NodePath.join(root, "gone.png"))).rejects.toThrow();
  });
});

describe("generated image on the runtime event", () => {
  const attachment = {
    type: "image" as const,
    id: "thread-1-12345678-1234-1234-1234-123456789abc",
    name: "ig_1.png",
    mimeType: "image/png",
    sizeBytes: 4,
  };
  const base = {
    eventId: EventId.makeUnsafe("evt-1"),
    provider: "codex",
    threadId,
    createdAt: "2026-02-10T00:00:00.000Z",
  } as const;

  it("round-trips on the image item only", () => {
    const events: ReadonlyArray<ProviderRuntimeEvent> = [
      {
        ...base,
        type: "item.completed",
        payload: { itemType: "image_view", data: { item: { id: "image-1" } } },
      },
      { ...base, type: "item.completed", payload: { itemType: "command_execution", data: {} } },
    ];

    const [image, command] = withCodexGeneratedImageAttachment(events, attachment);

    expect(image?.type === "item.completed" && image.payload.data).toMatchObject({
      item: { id: "image-1" },
    });
    expect(
      readCodexGeneratedImageAttachment(image?.type === "item.completed" && image.payload.data),
    ).toEqual(attachment);
    expect(
      readCodexGeneratedImageAttachment(command?.type === "item.completed" && command.payload.data),
    ).toBeUndefined();
  });

  it("ignores a malformed value", () => {
    expect(
      readCodexGeneratedImageAttachment({
        generatedImageAttachment: { type: "image", id: "../x" },
      }),
    ).toBeUndefined();
    expect(readCodexGeneratedImageAttachment(undefined)).toBeUndefined();
  });
});
