import { AwsClient } from "aws4fetch";
import type { Env } from "../env";

const PART_BYTES = 64 * 1024 * 1024;
const MAX_PART_BYTES = 5 * 1024 * 1024 * 1024;
const BUCKET = "quincy-portal-media";

function client(env: Env) {
  if (!env.R2_ACCOUNT_ID || !env.R2_S3_ACCESS_KEY_ID || !env.R2_S3_SECRET_ACCESS_KEY) return null;
  return new AwsClient({ accessKeyId: env.R2_S3_ACCESS_KEY_ID, secretAccessKey: env.R2_S3_SECRET_ACCESS_KEY, service: "s3", region: "auto" });
}
function endpoint(env: Env, key = "") {
  return `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${key}`;
}
export async function createMultipartPresign(env: Env, key: string, bytes: number) {
  const aws = client(env);
  if (!aws || bytes <= 0) return null;
  const create = await aws.fetch(endpoint(env, key) + "?uploads", { method: "POST" });
  if (!create.ok) throw new Error(`R2 multipart create failed (${create.status})`);
  const xml = await create.text();
  const uploadId = xml.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!uploadId) throw new Error("R2 multipart create returned no upload id");
  const parts = Math.ceil(bytes / PART_BYTES);
  const partUrls = await Promise.all(Array.from({ length: parts }, (_, index) => {
    const n = index + 1;
    return aws.sign(new Request(`${endpoint(env, key)}?partNumber=${n}&uploadId=${encodeURIComponent(uploadId)}`, { method: "PUT" }), { aws: { signQuery: true } }).then((r) => r.url);
  }));
  return { uploadId, key, partUrls, partBytes: Math.min(PART_BYTES, MAX_PART_BYTES) };
}
export async function completeMultipart(env: Env, key: string, uploadId: string, parts: { partNumber: number; etag: string }[]) {
  const aws = client(env); if (!aws) throw new Error("R2 S3 credentials are not configured");
  const body = `<CompleteMultipartUpload>${parts.sort((a, b) => a.partNumber - b.partNumber).map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${p.etag}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
  const response = await aws.fetch(`${endpoint(env, key)}?uploadId=${encodeURIComponent(uploadId)}`, { method: "POST", body, headers: { "content-type": "application/xml" } });
  if (!response.ok) throw new Error(`R2 multipart completion failed (${response.status})`);
}
