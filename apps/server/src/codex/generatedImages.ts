/**
 * Images made by Codex's `imageGeneration` item. Codex saves the file under its own home, which the
 * app does not serve, so a completed image is copied into the attachment store and carried on the
 * item's `item.completed` runtime event for ingestion to put on an assistant message.
 */
import { createHash } from "node:crypto";
import path from "node:path";

import {
  ChatImageAttachment,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderEvent,
  type ProviderRuntimeEvent,
} from "@piedpiper/contracts";
import { Effect, type FileSystem, Schema } from "effect";

import { resolveAttachmentPath, toSafeThreadAttachmentSegment } from "../attachmentStore.ts";

const GENERATED_IMAGE_ATTACHMENT_KEY = "generatedImageAttachment";
const TRACKER_MEMORY_LIMIT = 512;
const isChatImageAttachment = Schema.is(ChatImageAttachment);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function withoutImageBytes(item: unknown): unknown {
  const record = asRecord(item);
  if (record?.type !== "imageGeneration" || !("result" in record)) return item;
  const { result: _result, ...itemWithoutBytes } = record;
  return itemWithoutBytes;
}

function turnWithoutImageBytes(turn: unknown): unknown {
  const record = asRecord(turn);
  if (!Array.isArray(record?.items)) return turn;
  const items = record.items.map(withoutImageBytes);
  return items.some((item, index) => item !== (record.items as Array<unknown>)[index])
    ? { ...record, items }
    : turn;
}

function threadWithoutImageBytes(thread: unknown): unknown {
  const record = asRecord(thread);
  if (!Array.isArray(record?.turns)) return thread;
  const turns = record.turns.map(turnWithoutImageBytes);
  return turns.some((turn, index) => turn !== (record.turns as Array<unknown>)[index])
    ? { ...record, turns }
    : thread;
}

/**
 * Drops the base64 `result` of image items, so no event or log ever carries the image bytes. Items
 * arrive on item notifications, on `turn.items` and on `thread.turns[].items`.
 */
export function stripCodexGeneratedImageBytes(params: unknown): unknown {
  const record = asRecord(params);
  if (!record) return params;
  const item = withoutImageBytes(record.item);
  const turn = turnWithoutImageBytes(record.turn);
  const thread = threadWithoutImageBytes(record.thread);
  if (item === record.item && turn === record.turn && thread === record.thread) return params;
  return {
    ...record,
    ...(item === record.item ? {} : { item }),
    ...(turn === record.turn ? {} : { turn }),
    ...(thread === record.thread ? {} : { thread }),
  };
}

/** The saved file of a finished image item; undefined while running, failed or not saved. */
export function readCodexGeneratedImagePath(item: unknown): string | undefined {
  const record = asRecord(item);
  if (record?.type !== "imageGeneration" || record.status !== "completed") return undefined;
  if (record.failure !== undefined && record.failure !== null) return undefined;
  const savedPath = typeof record.savedPath === "string" ? record.savedPath.trim() : "";
  return path.isAbsolute(savedPath) ? savedPath : undefined;
}

/** Trusts the file's bytes rather than its name; SVG is left out because it can carry script. */
export function sniffGeneratedImageMimeType(bytes: Uint8Array): string | undefined {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (ascii(1, 4) === "PNG" && bytes[0] === 0x89) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

/** Stable for one saved file, so a repeated delivery overwrites the same attachment. */
function generatedImageAttachmentId(threadId: string, savedPath: string): string | null {
  const segment = toSafeThreadAttachmentSegment(threadId);
  if (!segment) return null;
  const hash = createHash("sha256").update(`${threadId}\0${savedPath}`).digest("hex");
  const uuid = [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
  return `${segment}-${uuid}`;
}

/** Copies a saved image into the attachment store; undefined when the file is not a usable image. */
export const persistCodexGeneratedImage = Effect.fn("persistCodexGeneratedImage")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
    readonly threadId: string;
    readonly savedPath: string;
  }) {
    const { fileSystem } = input;
    const info = yield* fileSystem.stat(input.savedPath);
    const sizeBytes = Number(info.size);
    if (info.type !== "File" || sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) return undefined;
    const bytes = yield* fileSystem.readFile(input.savedPath);
    const mimeType = sniffGeneratedImageMimeType(bytes);
    const id = generatedImageAttachmentId(input.threadId, input.savedPath);
    if (!mimeType || !id || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) return undefined;
    const attachment = {
      type: "image" as const,
      id,
      name: path.basename(input.savedPath).trim().slice(-255) || "generated-image",
      mimeType,
      sizeBytes: bytes.byteLength,
    };
    if (!isChatImageAttachment(attachment)) return undefined;
    const target = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    if (!target) return undefined;
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
    yield* fileSystem.writeFile(target, bytes);
    return attachment;
  },
);

export function withCodexGeneratedImageAttachment(
  runtimeEvents: ReadonlyArray<ProviderRuntimeEvent>,
  attachment: ChatImageAttachment,
): ReadonlyArray<ProviderRuntimeEvent> {
  return runtimeEvents.map((runtimeEvent) =>
    runtimeEvent.type === "item.completed" && runtimeEvent.payload.itemType === "image_view"
      ? {
          ...runtimeEvent,
          payload: {
            ...runtimeEvent.payload,
            data: {
              ...asRecord(runtimeEvent.payload.data),
              [GENERATED_IMAGE_ATTACHMENT_KEY]: attachment,
            },
          },
        }
      : runtimeEvent,
  );
}

/** For ingestion: the stored image an `item.completed` event's `data` carries, if any. */
export function readCodexGeneratedImageAttachment(data: unknown): ChatImageAttachment | undefined {
  const attachment = asRecord(data)?.[GENERATED_IMAGE_ATTACHMENT_KEY];
  return isChatImageAttachment(attachment) ? attachment : undefined;
}

function rememberBounded(values: Set<string>, value: string): void {
  values.add(value);
  if (values.size > TRACKER_MEMORY_LIMIT) {
    values.delete(values.values().next().value as string);
  }
}

/**
 * Decides which image items are worth copying: each saved file once, and nothing that finishes
 * after the user interrupted its turn. Images completed before the interrupt still count.
 */
export function makeCodexGeneratedImageTracker() {
  const interruptingThreads = new Set<string>();
  const interruptedTurns = new Set<string>();
  const seenImages = new Set<string>();

  const observe = (
    event: Pick<ProviderEvent, "method" | "threadId" | "turnId" | "payload">,
  ): string | undefined => {
    const threadKey = String(event.threadId);
    const payload = asRecord(event.payload);
    if (event.method === "turn/started") {
      interruptingThreads.delete(threadKey);
      return undefined;
    }
    if (event.method === "turn/completed") {
      const status = asRecord(payload?.turn)?.status;
      if ((status === "interrupted" || status === "cancelled") && event.turnId) {
        rememberBounded(interruptedTurns, `${threadKey}\0${event.turnId}`);
      }
      return undefined;
    }
    if (event.method !== "item/completed") return undefined;
    const savedPath = readCodexGeneratedImagePath(payload?.item);
    if (!savedPath || interruptingThreads.has(threadKey)) return undefined;
    if (event.turnId && interruptedTurns.has(`${threadKey}\0${event.turnId}`)) return undefined;
    const imageKey = `${threadKey}\0${savedPath}`;
    if (seenImages.has(imageKey)) return undefined;
    rememberBounded(seenImages, imageKey);
    return savedPath;
  };

  return {
    observe,
    interruptRequested: (threadId: string) => interruptingThreads.add(threadId),
    interruptFailed: (threadId: string) => interruptingThreads.delete(threadId),
  };
}
