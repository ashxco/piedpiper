import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type UploadChatFileAttachment,
} from "@piedpiper/contracts";
import { parseBase64DataUrl } from "../imageMime";
import { decodeUploadedPdf, type DecodedPdfUpload } from "./pdfAttachmentIntake";

/** Validate bytes before persistence; a renamed binary must never enter the text path. */
export function decodeUploadedFile(input: UploadChatFileAttachment): DecodedPdfUpload {
  if (input.mimeType === "application/pdf") return decodeUploadedPdf(input);
  const parsed = parseBase64DataUrl(input.dataUrl);
  if (!parsed || parsed.mimeType.toLowerCase() !== "text/plain") {
    return { ok: false, error: `Invalid text attachment payload for '${input.name}'.` };
  }
  const bytes = Buffer.from(parsed.base64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
    return { ok: false, error: `Text attachment '${input.name}' is empty or too large.` };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("Binary content");
  } catch {
    return { ok: false, error: `Attachment '${input.name}' is not a UTF-8 text file.` };
  }
  return { ok: true, bytes };
}
