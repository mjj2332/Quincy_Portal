import { z } from "zod";
import { externalAssetSchema } from "./external-asset-dto";

export const EXTERNAL_UPLOAD_MAX_BYTES = 5 * 1024 * 1024 * 1024;
export const EXTERNAL_UPLOAD_PART_BYTES = 64 * 1024 * 1024;
export const EXTERNAL_UPLOAD_MAX_SESSIONS_PER_PRINCIPAL = 3;
export const EXTERNAL_UPLOAD_SESSION_STATES = ["open", "completing", "completed", "aborting", "aborted", "expired"] as const;

const safeFilename = z.string().min(1).max(500).refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), "Invalid filename");

export const externalEditedUploadCreateRequestSchema = z.object({
  projectId: z.string().uuid(),
  collection: z.literal("edited"),
  filename: safeFilename.refine((value) => /\.jpe?g$/i.test(value), "Edited uploads must be JPEG files"),
  bytes: z.number().int().min(1).max(EXTERNAL_UPLOAD_MAX_BYTES),
}).strict();
export type ExternalEditedUploadCreateRequest = z.infer<typeof externalEditedUploadCreateRequestSchema>;

const sameOriginPath = z.string().regex(/^\/api\/external-uploads\/[A-Za-z0-9_-]+(?:\/parts\/\d+|\/complete)?$/);
export const externalEditedUploadCreateResponseSchema = z.object({
  sessionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  assetId: z.string().uuid(),
  expiresAt: z.string(),
  parts: z.array(z.object({ partNumber: z.number().int().positive(), uploadUrl: sameOriginPath, expectedBytes: z.number().int().positive() }).strict()).min(1),
  completeUrl: sameOriginPath,
  abortUrl: sameOriginPath,
}).strict();

export const externalEditedPartResponseSchema = z.object({ partNumber: z.number().int().positive(), state: z.literal("accepted"), receivedBytes: z.number().int().positive() }).strict();
export const externalEditedCompleteRequestSchema = z.object({}).strict();
export const externalEditedCompleteResponseSchema = z.object({ asset: externalAssetSchema, workflow: z.object({ state: z.enum(["processing", "ready"]) }).strict() }).strict();
export const externalEditedAbortResponseSchema = z.object({ state: z.literal("aborted") }).strict();
export const externalEditedUploadErrorSchema = z.discriminatedUnion("code", [
  z.object({ error: z.literal("Invalid edited upload"), code: z.literal("invalid_edited_upload") }).strict(),
  z.object({ error: z.literal("Edited upload not found"), code: z.literal("edited_upload_not_found") }).strict(),
  z.object({ error: z.literal("Edited upload is unavailable"), code: z.literal("edited_upload_unavailable") }).strict(),
  z.object({ error: z.literal("Upload service is unavailable"), code: z.literal("upload_service_unavailable") }).strict(),
]);

export type ExternalEditedUploadCreateResponse = z.infer<typeof externalEditedUploadCreateResponseSchema>;
export type ExternalEditedPartResponse = z.infer<typeof externalEditedPartResponseSchema>;
export type ExternalEditedCompleteResponse = z.infer<typeof externalEditedCompleteResponseSchema>;
export type ExternalEditedAbortResponse = z.infer<typeof externalEditedAbortResponseSchema>;
export type ExternalEditedUploadError = z.infer<typeof externalEditedUploadErrorSchema>;
export type ExternalUploadSessionState = (typeof EXTERNAL_UPLOAD_SESSION_STATES)[number];

export function externalUploadError(code: ExternalEditedUploadError["code"]): ExternalEditedUploadError {
  const messages: Record<ExternalEditedUploadError["code"], ExternalEditedUploadError["error"]> = {
    invalid_edited_upload: "Invalid edited upload",
    edited_upload_not_found: "Edited upload not found",
    edited_upload_unavailable: "Edited upload is unavailable",
    upload_service_unavailable: "Upload service is unavailable",
  };
  return { error: messages[code], code } as ExternalEditedUploadError;
}
