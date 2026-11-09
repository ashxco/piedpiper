import { PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES } from "@piedpiper/contracts";

const PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPE_SET = new Set<string>(
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
);
/** Checks new uploads; persisted attachment schemas remain permissive. */
export function isProviderSendTurnSupportedImageMimeType(mimeType: string): boolean {
  return PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPE_SET.has(mimeType.trim().toLowerCase());
}
