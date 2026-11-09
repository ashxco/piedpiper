import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@piedpiper/contracts";

import { parseBase64DataUrl } from "../imageMime.ts";

const PDF_MAGIC = Buffer.from("%PDF-", "latin1");

const hasPdfMagicBytes = (bytes: Uint8Array): boolean =>
  bytes.length >= PDF_MAGIC.length && PDF_MAGIC.equals(bytes.subarray(0, PDF_MAGIC.length));

export const pdfAttachmentRelativePath = (attachmentId: string): string => `${attachmentId}.pdf`;

export type DecodedPdfUpload =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly error: string };

/** Trusts neither the declared type nor size: both come from the client. */
export function decodeUploadedPdf(input: {
  readonly name: string;
  readonly dataUrl: string;
}): DecodedPdfUpload {
  const parsed = parseBase64DataUrl(input.dataUrl);
  if (!parsed || parsed.mimeType.toLowerCase() !== "application/pdf") {
    return { ok: false, error: `Invalid PDF attachment payload for '${input.name}'.` };
  }
  const bytes = Buffer.from(parsed.base64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
    return { ok: false, error: `PDF attachment '${input.name}' is empty or too large.` };
  }
  if (!hasPdfMagicBytes(bytes)) {
    return { ok: false, error: `Attachment '${input.name}' is not a valid PDF file.` };
  }
  return { ok: true, bytes };
}
