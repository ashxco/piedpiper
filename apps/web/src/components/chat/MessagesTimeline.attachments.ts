import { type ChatAttachment, type ChatImageAttachment } from "../../types";

/** Rendered as a chip with no preview; wider than ChatAttachment until PDFs join that union. */
export interface TimelineFileAttachment {
  type: "file";
  id: string;
  name: string;
  sizeBytes: number;
}

export function partitionMessageAttachments(
  attachments: ReadonlyArray<ChatAttachment | TimelineFileAttachment>,
): { images: ChatImageAttachment[]; files: TimelineFileAttachment[] } {
  const images: ChatImageAttachment[] = [];
  const files: TimelineFileAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.type === "file") files.push(attachment);
    else images.push(attachment);
  }
  return { images, files };
}
