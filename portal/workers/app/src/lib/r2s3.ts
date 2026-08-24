import { AwsClient } from "aws4fetch";
import type { Env } from "../env";

export const PART_BYTES = 64 * 1024 * 1024;
const MAX_PART_BYTES = 5 * 1024 * 1024 * 1024;
const BUCKET = "quincy-portal-media";
export const PRESIGN_EXPIRES_SECONDS = 60 * 60;

function client(env: Env) {
  if (!env.R2_ACCOUNT_ID || !env.R2_S3_ACCESS_KEY_ID || !env.R2_S3_SECRET_ACCESS_KEY) return null;
  return new AwsClient({ accessKeyId: env.R2_S3_ACCESS_KEY_ID, secretAccessKey: env.R2_S3_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
}
export function encodedObjectPath(key: string) {
  return key.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
export function endpoint(env: Env, key = "") {
  return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${encodedObjectPath(key)}`;
}
export function expectedPartCount(bytes: number, partBytes = PART_BYTES) {
  return Math.ceil(bytes / partBytes);
}
export function validateMultipartParts(bytes: number, parts: { partNumber: number; etag: string }[], partBytes = PART_BYTES) {
  const count = expectedPartCount(bytes, partBytes);
  if (parts.length !== count) throw new Error(`Expected ${count} multipart parts`);
  const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index]!.partNumber !== index + 1 || !ordered[index]!.etag.trim()) throw new Error("Multipart parts must have unique contiguous part numbers and ETags");
  }
  return ordered;
}
function xmlEscape(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}
export async function createMultipartPresign(env: Env, key: string, bytes: number, contentType?: string, partBytes = PART_BYTES) {
  // Local Wrangler binds MEDIA to Miniflare's R2 simulator. Never presign against the
  // remote S3 endpoint in that mode, even if stale R2 credentials remain in .dev.vars:
  // completion verifies the object through the local MEDIA binding.
  if (env.APP_ENV === "dev") return null;
  const aws = client(env);
  if (!aws || bytes <= 0) return null;
  const create = await aws.fetch(endpoint(env, key) + "?uploads", { method: "POST", headers: contentType ? { "content-type": contentType } : undefined });
  if (!create.ok) throw new Error(`R2 multipart create failed (${create.status})`);
  const xml = await create.text();
  const uploadId = xml.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!uploadId) throw new Error("R2 multipart create returned no upload id");
  try {
    const effectivePartBytes = Math.min(partBytes, MAX_PART_BYTES);
    const parts = expectedPartCount(bytes, effectivePartBytes);
    const partUrls = await Promise.all(Array.from({ length: parts }, (_, index) => {
      const n = index + 1;
      const query = new URLSearchParams({ partNumber: String(n), uploadId, "X-Amz-Expires": String(PRESIGN_EXPIRES_SECONDS) });
      return aws.sign(new Request(`${endpoint(env, key)}?${query}`, { method: "PUT" }), { aws: { signQuery: true } }).then((r) => r.url);
    }));
    return { uploadId, key, partUrls, partBytes: effectivePartBytes };
  } catch (error) {
    await abortMultipart(env, key, uploadId).catch(() => undefined);
    throw error;
  }
}
export async function abortMultipart(env: Env, key: string, uploadId: string) {
  const aws = client(env); if (!aws) return;
  const response = await aws.fetch(`${endpoint(env, key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error(`R2 multipart abort failed (${response.status})`);
}
export async function completeMultipart(env: Env, key: string, uploadId: string, parts: { partNumber: number; etag: string }[], bytes?: number, partBytes = PART_BYTES) {
  const aws = client(env); if (!aws) throw new Error("R2 S3 credentials are not configured");
  const ordered = bytes === undefined
    ? validateMultipartParts(parts.length * partBytes, parts, partBytes)
    : validateMultipartParts(bytes, parts, partBytes);
  const body = `<CompleteMultipartUpload>${ordered.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
  const response = await aws.fetch(`${endpoint(env, key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: "POST", body, headers: { "content-type": "application/xml" } });
  if (!response.ok) throw new Error(`R2 multipart completion failed (${response.status})`);
}
