import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@piedpiper/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../config.ts";
import { WorkspacePathsLive } from "../workspace/Layers/WorkspacePaths.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const layer = it.layer(
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "pp-normalizer-test-" }),
    WorkspacePathsLive,
  ).pipe(Layer.provideMerge(NodeServices.layer)),
);

const MIB = 1024 * 1024;

function imageDataUrl(byteLength: number): string {
  return `data:image/png;base64,${Buffer.alloc(byteLength, 1).toString("base64")}`;
}

function turnStart(
  attachments: ReadonlyArray<{ readonly sizeBytes: number; readonly dataUrl: string }>,
): ClientOrchestrationCommand {
  return {
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe("cmd-normalizer"),
    threadId: ThreadId.makeUnsafe("thread-normalizer"),
    message: {
      messageId: MessageId.makeUnsafe("message-normalizer"),
      role: "user",
      text: "look",
      attachments: attachments.map((attachment, index) => ({
        type: "image" as const,
        name: `shot-${index}.png`,
        mimeType: "image/png",
        ...attachment,
      })),
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date(0).toISOString(),
  };
}

layer("normalizeDispatchCommand attachments", (it) => {
  it.effect("persists many small images in one message", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const command = turnStart(
        Array.from({ length: 20 }, () => ({ sizeBytes: 4, dataUrl: imageDataUrl(4) })),
      );
      const normalized = yield* normalizeDispatchCommand(command);
      assert.equal(normalized.type, "thread.turn.start");
      if (normalized.type !== "thread.turn.start") return;
      assert.equal(normalized.message.attachments.length, 20);
      const files = yield* fileSystem.readDirectory(config.attachmentsDir);
      assert.isAtLeast(files.length, 20);
    }),
  );

  it.effect("rejects an over-budget batch by declared size before writing anything", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const before = yield* fileSystem.readDirectory(config.attachmentsDir);
      const command = turnStart(
        Array.from({ length: 9 }, () => ({ sizeBytes: 10 * MIB, dataUrl: imageDataUrl(4) })),
      );
      const error = yield* Effect.flip(normalizeDispatchCommand(command));
      assert.include(error.message, "64 MiB");
      const after = yield* fileSystem.readDirectory(config.attachmentsDir);
      assert.equal(after.length, before.length);
    }),
  );

  it.effect("rejects a batch whose decoded images exceed the budget and writes no files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const before = yield* fileSystem.readDirectory(config.attachmentsDir);
      // Declared sizes understate the real payload, so only the decoded check catches it.
      const command = turnStart(
        Array.from({ length: 9 }, () => ({ sizeBytes: 1, dataUrl: imageDataUrl(10 * MIB) })),
      );
      const error = yield* Effect.flip(normalizeDispatchCommand(command));
      assert.include(error.message, "64 MiB");
      const after = yield* fileSystem.readDirectory(config.attachmentsDir);
      assert.equal(after.length, before.length);
    }),
  );

  it.effect("stops decoding as soon as the decoded total goes over the budget", () =>
    Effect.gen(function* () {
      // The 8th image is invalid; reaching it would report a payload error instead.
      const command = turnStart([
        ...Array.from({ length: 7 }, () => ({ sizeBytes: 1, dataUrl: imageDataUrl(10 * MIB) })),
        { sizeBytes: 1, dataUrl: "not-a-data-url" },
      ]);
      const error = yield* Effect.flip(normalizeDispatchCommand(command));
      assert.include(error.message, "64 MiB");
    }),
  );
});

function pdfTurnStart(
  attachments: ReadonlyArray<{ readonly sizeBytes: number; readonly dataUrl: string }>,
): ClientOrchestrationCommand {
  const base = turnStart([]);
  if (base.type !== "thread.turn.start") throw new Error("expected a turn start");
  return {
    ...base,
    message: {
      ...base.message,
      attachments: attachments.map((attachment, index) => ({
        type: "file" as const,
        name: `doc-${index}.pdf`,
        mimeType: "application/pdf" as const,
        ...attachment,
      })),
    },
  };
}

const pdfDataUrl = (contents: string | Buffer) =>
  `data:application/pdf;base64,${Buffer.from(contents).toString("base64")}`;

layer("normalizeDispatchCommand PDF attachments", (it) => {
  it.effect("stores UTF-8 text under a .txt path using its decoded size", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const contents = "const greeting = 'こんにちは';";
      const command = pdfTurnStart([]);
      if (command.type !== "thread.turn.start") throw new Error("expected turn start");
      const normalized = yield* normalizeDispatchCommand({
        ...command,
        message: {
          ...command.message,
          attachments: [
            {
              type: "file",
              name: "source.ts",
              mimeType: "text/plain",
              sizeBytes: 1,
              dataUrl: `data:text/plain;base64,${Buffer.from(contents).toString("base64")}`,
            },
          ],
        },
      });
      if (normalized.type !== "thread.turn.start") throw new Error("expected turn start");
      const attachment = normalized.message.attachments[0]!;
      assert.equal(attachment.mimeType, "text/plain");
      assert.equal(attachment.sizeBytes, Buffer.byteLength(contents));
      assert.equal(
        yield* fileSystem.readFileString(`${config.attachmentsDir}/${attachment.id}.txt`),
        contents,
      );
    }),
  );

  it.effect("stores a PDF with its real size under a .pdf name", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const contents = "%PDF-1.4 body";
      const normalized = yield* normalizeDispatchCommand(
        pdfTurnStart([{ sizeBytes: 1, dataUrl: pdfDataUrl(contents) }]),
      );
      if (normalized.type !== "thread.turn.start") throw new Error("expected a turn start");
      const attachment = normalized.message.attachments[0];
      if (attachment === undefined) throw new Error("expected an attachment");
      assert.equal(attachment.type, "file");
      assert.equal(attachment.mimeType, "application/pdf");
      assert.equal(attachment.sizeBytes, contents.length);
      assert.equal(
        yield* fileSystem.readFileString(`${config.attachmentsDir}/${attachment.id}.pdf`),
        contents,
      );
    }),
  );

  it.effect("rejects content without the PDF magic, whatever its declared type", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const before = yield* fileSystem.readDirectory(config.attachmentsDir);
      const error = yield* Effect.flip(
        normalizeDispatchCommand(
          pdfTurnStart([{ sizeBytes: 12, dataUrl: pdfDataUrl("<html>nope</html>") }]),
        ),
      );
      assert.include(error.message, "not a valid PDF");
      assert.equal((yield* fileSystem.readDirectory(config.attachmentsDir)).length, before.length);
    }),
  );

  it.effect("rejects a payload that is not a PDF data URL, and one over 20 MiB", () =>
    Effect.gen(function* () {
      const wrongType = yield* Effect.flip(
        normalizeDispatchCommand(pdfTurnStart([{ sizeBytes: 4, dataUrl: imageDataUrl(4) }])),
      );
      assert.include(wrongType.message, "Invalid PDF attachment payload");
      const tooLarge = Buffer.alloc(20 * MIB + 1);
      tooLarge.write("%PDF-");
      const oversized = yield* Effect.flip(
        normalizeDispatchCommand(pdfTurnStart([{ sizeBytes: 1, dataUrl: pdfDataUrl(tooLarge) }])),
      );
      assert.include(oversized.message, "empty or too large");
    }),
  );
});

layer("normalizeDispatchCommand timestamps", (it) => {
  it.effect("stamps client commands with the server receive time", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-03-04T05:06:07.000Z"));
      const command: ClientOrchestrationCommand = {
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-normalizer-create"),
        threadId: ThreadId.makeUnsafe("thread-normalizer-create"),
        projectId: ProjectId.makeUnsafe("project-normalizer"),
        title: "Skewed clock",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: "2099-01-01T00:00:00.000Z",
      };
      const normalized = yield* normalizeDispatchCommand(command);
      assert.equal(normalized.type, "thread.create");
      if (normalized.type !== "thread.create") return;
      assert.equal(normalized.createdAt, "2026-03-04T05:06:07.000Z");
    }),
  );

  it.effect("stamps a project archive with the server's time and passes an unarchive through", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-03-04T05:06:09.000Z"));
      const metaUpdate = (archivedAt: string | null): ClientOrchestrationCommand => ({
        type: "project.meta.update",
        commandId: CommandId.makeUnsafe("cmd-normalizer-project-archive"),
        projectId: ProjectId.makeUnsafe("project-normalizer"),
        archivedAt,
      });
      const archive = yield* normalizeDispatchCommand(metaUpdate("2099-01-01T00:00:00.000Z"));
      assert.equal(archive.type, "project.meta.update");
      if (archive.type !== "project.meta.update") return;
      assert.equal(archive.archivedAt, "2026-03-04T05:06:09.000Z");

      const unarchive = yield* normalizeDispatchCommand(metaUpdate(null));
      assert.equal(unarchive.type, "project.meta.update");
      if (unarchive.type !== "project.meta.update") return;
      assert.isNull(unarchive.archivedAt);
    }),
  );

  it.effect("stamps turn starts and leaves commands without createdAt unchanged", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-03-04T05:06:08.000Z"));
      const turn = yield* normalizeDispatchCommand(turnStart([]));
      assert.equal(turn.type, "thread.turn.start");
      if (turn.type !== "thread.turn.start") return;
      assert.equal(turn.createdAt, "2026-03-04T05:06:08.000Z");

      const archive: ClientOrchestrationCommand = {
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("cmd-normalizer-archive"),
        threadId: ThreadId.makeUnsafe("thread-normalizer"),
      };
      const normalizedArchive = yield* normalizeDispatchCommand(archive);
      assert.deepEqual(normalizedArchive, archive);
    }),
  );
});
