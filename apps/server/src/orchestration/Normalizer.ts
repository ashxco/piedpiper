import { DateTime, Effect, FileSystem, Path } from "effect";
import {
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type UploadChatImageAttachment,
} from "@piedpiper/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore";
import { ServerConfig } from "../config";
import { parseBase64DataUrl } from "../imageMime";
import { WorkspacePaths } from "../workspace/Services/WorkspacePaths";
import { decodeUploadedFile } from "./fileAttachmentIntake";

// Client clocks can be wrong, so every client command is stamped with the server's receive time.
const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: string,
): ClientOrchestrationCommand => {
  if (command.type === "project.meta.update" && command.archivedAt) {
    return { ...command, archivedAt: receivedAt };
  }
  return "createdAt" in command ? { ...command, createdAt: receivedAt } : command;
};

function decodeUploadedImage(attachment: UploadChatImageAttachment) {
  const parsed = parseBase64DataUrl(attachment.dataUrl);
  if (!parsed || !parsed.mimeType.startsWith("image/")) {
    return {
      ok: false as const,
      error: `Invalid image attachment payload for '${attachment.name}'.`,
    };
  }
  const bytes = Buffer.from(parsed.base64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    return {
      ok: false as const,
      error: `Image attachment '${attachment.name}' is empty or too large.`,
    };
  }
  return { ok: true as const, bytes, mimeType: parsed.mimeType.toLowerCase() };
}

export const normalizeDispatchCommand = (clientCommand: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const command = canonicalizeClientCommandTimestamps(clientCommand, receivedAt);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    if (command.type === "project.create") {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (command.type === "project.meta.update" && command.workspaceRoot !== undefined) {
      return {
        ...command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (command.type !== "thread.turn.start") {
      return command as OrchestrationCommand;
    }

    const attachments = command.message.attachments;

    const upfrontLimitError = getProviderAttachmentLimitError(attachments);
    if (upfrontLimitError) {
      return yield* new OrchestrationDispatchCommandError({ message: upfrontLimitError });
    }

    // Decode and size-check every attachment before writing any, so a rejected batch leaves no files.
    // Declared sizes are swapped for decoded ones as we go, so an understated batch fails early.
    const budgetSizes = attachments.map((attachment) => ({
      sizeBytes: attachment.sizeBytes,
      type: attachment.type,
    }));
    const decodedAttachments = yield* Effect.forEach(
      attachments,
      (attachment, index) =>
        Effect.gen(function* () {
          const decoded =
            attachment.type === "file"
              ? { ...decodeUploadedFile(attachment), mimeType: attachment.mimeType }
              : decodeUploadedImage(attachment);
          if (!decoded.ok) {
            return yield* new OrchestrationDispatchCommandError({ message: decoded.error });
          }
          const { bytes } = decoded;
          budgetSizes[index] = { sizeBytes: bytes.byteLength, type: attachment.type };
          const decodedLimitError = getProviderAttachmentLimitError(budgetSizes);
          if (decodedLimitError) {
            return yield* new OrchestrationDispatchCommandError({ message: decodedLimitError });
          }

          const attachmentId = createAttachmentId(command.threadId);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment =
            attachment.type === "file"
              ? {
                  type: "file" as const,
                  id: attachmentId,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  sizeBytes: bytes.byteLength,
                }
              : {
                  type: "image" as const,
                  id: attachmentId,
                  name: attachment.name,
                  mimeType: decoded.mimeType,
                  sizeBytes: bytes.byteLength,
                };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          return { persistedAttachment, attachmentPath, bytes };
        }),
      { concurrency: 1 },
    );

    const writtenPaths: string[] = [];
    const normalizedAttachments = yield* Effect.forEach(
      decodedAttachments,
      ({ persistedAttachment, attachmentPath, bytes }) =>
        Effect.gen(function* () {
          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to create attachment directory for '${persistedAttachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist attachment '${persistedAttachment.name}'.`,
                }),
            ),
          );
          writtenPaths.push(attachmentPath);

          return persistedAttachment;
        }),
      { concurrency: 1 },
    ).pipe(
      Effect.tapError(() =>
        Effect.forEach(
          writtenPaths,
          (writtenPath) => fileSystem.remove(writtenPath, { force: true }).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
    );

    return {
      ...command,
      message: {
        ...command.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });
