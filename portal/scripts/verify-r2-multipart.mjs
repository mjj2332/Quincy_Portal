#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { AwsClient } from "aws4fetch";

const bucket = "quincy-portal-media";
const partBytes = 64 * 1024 * 1024;
const totalBytes = partBytes + 1024;
const origin = process.env.SPIKE_ORIGIN ?? "https://quincy-portal-app.mjj2332.workers.dev";

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    values[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1);
  }
  return values;
}

function uploadIdFrom(xml) {
  return xml.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
}

async function requireOk(response, operation) {
  if (response.ok) return response;
  const body = await response.text();
  throw new Error(`${operation} failed (${response.status}): ${body.slice(0, 500)}`);
}

const values = parseEnv(await readFile(new URL("../workers/app/.dev.vars", import.meta.url), "utf8"));
const accountId = values.R2_ACCOUNT_ID;
const accessKeyId = values.R2_S3_ACCESS_KEY_ID;
const secretAccessKey = values.R2_S3_SECRET_ACCESS_KEY;
if (!accountId || !accessKeyId || !secretAccessKey) throw new Error("R2 S3 credentials are missing from workers/app/.dev.vars");

const aws = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
const key = `spikes/multipart-${crypto.randomUUID()}.jpg`;
const endpoint = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`;
let uploadId;
let completed = false;

try {
  const create = await requireOk(await aws.fetch(`${endpoint}?uploads`, { method: "POST" }), "create multipart upload");
  uploadId = uploadIdFrom(await create.text());
  if (!uploadId) throw new Error("CreateMultipartUpload returned no upload ID");

  const etags = [];
  for (let partNumber = 1; partNumber <= 2; partNumber += 1) {
    const length = partNumber === 1 ? partBytes : totalBytes - partBytes;
    const body = new Uint8Array(length);
    body.fill(partNumber);
    const request = new Request(`${endpoint}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}`, { method: "PUT" });
    const signed = await aws.sign(request, { aws: { signQuery: true } });

    const preflight = await fetch(signed.url, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    await requireOk(preflight, `part ${partNumber} CORS preflight`);
    if (preflight.headers.get("access-control-allow-origin") !== origin) throw new Error(`Part ${partNumber} preflight did not allow ${origin}`);

    const part = await requireOk(await fetch(signed.url, {
      method: "PUT",
      headers: { Origin: origin, "content-type": "image/jpeg" },
      body,
    }), `upload part ${partNumber}`);
    const etag = part.headers.get("etag");
    const exposed = part.headers.get("access-control-expose-headers")?.toLowerCase().split(",").map((value) => value.trim()) ?? [];
    if (!etag) throw new Error(`Part ${partNumber} returned no ETag`);
    if (!exposed.includes("etag")) throw new Error(`Part ${partNumber} did not expose ETag to browsers`);
    etags.push({ partNumber, etag });
  }

  const body = `<CompleteMultipartUpload>${etags.map(({ partNumber, etag }) => `<Part><PartNumber>${partNumber}</PartNumber><ETag>${etag}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
  await requireOk(await aws.fetch(`${endpoint}?uploadId=${encodeURIComponent(uploadId)}`, { method: "POST", headers: { "content-type": "application/xml" }, body }), "complete multipart upload");
  completed = true;

  const head = await requireOk(await aws.fetch(endpoint, { method: "HEAD" }), "head completed object");
  const size = Number(head.headers.get("content-length"));
  if (size !== totalBytes) throw new Error(`Completed object size ${size} did not match ${totalBytes}`);
  console.log(JSON.stringify({ ok: true, parts: 2, bytes: size, corsOrigin: origin, etagExposed: true }));
} finally {
  if (completed) {
    await aws.fetch(endpoint, { method: "DELETE" });
  } else if (uploadId) {
    await aws.fetch(`${endpoint}?uploadId=${encodeURIComponent(uploadId)}`, { method: "DELETE" });
  }
}
