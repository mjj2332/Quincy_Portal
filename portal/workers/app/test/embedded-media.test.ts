import { createExecutionContext, env } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { externalEmbeddedMediaCompleteSchema, externalEmbeddedMediaPresignSchema } from "@quincy/shared";
import { createAuth } from "../src/auth";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, cookie, database, ids, jpegBytes, mediaKey, mediaRow, pngBytes, request, seedFixture, seedMedia, tokens, type Who } from "./embedded-media-support";

const S3_ENV: Env = { ...baseEnv, R2_ACCOUNT_ID: "acct", R2_S3_ACCESS_KEY_ID: "key", R2_S3_SECRET_ACCESS_KEY: "secret" };
const DEV_ENV: Env = { ...baseEnv, APP_ENV: "dev" };
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";

async function appRequest(environment: Env, path: string, who: Who, method: "GET" | "POST" | "PUT", body?: unknown, rawBody?: BodyInit, headers: Record<string, string> = {}) {
  const context = await createAuth(environment).$context;
  const cookieValue = `${context.authCookies.sessionToken.name}=${tokens[who]}.${await makeSignature(tokens[who], authSecret)}`;
  const init: RequestInit = { method, headers: { cookie: cookieValue, origin: environment.APP_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : rawBody !== undefined ? { body: rawBody } : {}) };
  return app.fetch(new Request(`https://portal.test${path}`, init), environment, createExecutionContext());
}
const presign = (environment: Env, who: Who, body: unknown, projectId: string = ids.project) => appRequest(environment, `/api/projects/${projectId}/embedded-media`, who, "POST", body);
const rowCount = async () => (await database.DB.prepare("SELECT count(*) AS n FROM embedded_media").first<{ n: number }>())!.n;

function stubS3(handler: (url: string, init: RequestInit | undefined) => Response | undefined = () => undefined) {
  const calls: Array<{ url: string; method: string; headers: Headers }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = request.url;
    calls.push({ url, method: request.method, headers: request.headers });
    const custom = handler(url, init); if (custom) return custom;
    if (request.method === "POST" && url.includes("?uploads")) return new Response("<InitiateMultipartUploadResult><UploadId>s3-upload-1</UploadId></InitiateMultipartUploadResult>");
    if (request.method === "POST" && url.includes("uploadId=")) return new Response("<CompleteMultipartUploadResult/>");
    return new Response("unexpected", { status: 500 });
  });
  return calls;
}

beforeAll(async () => { await seedFixture(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("POST /projects/:id/embedded-media (presign)", () => {
  it("reserves a row and a multipart upload for an admin, an assigned editor and an assigned External editor, under the Project's storage prefix", async () => {
    const calls = stubS3();
    for (const who of ["admin", "member", "external"] as const) {
      const response = await presign(S3_ENV, who, { contentType: "image/png", bytes: 1234 });
      expect(response.status, who).toBe(200);
      const body = externalEmbeddedMediaPresignSchema.parse(await response.json());
      expect(body.partUrls).toHaveLength(1); expect(body.uploadId).toBe("s3-upload-1");
      expect(body).not.toHaveProperty("key");
      const row = (await mediaRow(body.mediaId))!;
      expect(row).toMatchObject({ owner_kind: "project_comment", owner_id: null, project_id: ids.project, uploader_id: ids[who], kind: "image", content_type: "image/png", bytes: 1234, state: "uploading", upload_id: "s3-upload-1", original_key: mediaKey(ids.project, body.mediaId) });
      const create = calls.find((call) => call.url.includes("?uploads") && call.url.includes(body.mediaId))!;
      expect(create.url).toContain(`/projects/${ids.project}/embedded-media/${body.mediaId}/original`);
      expect(create.headers.get("content-type")).toBe("image/png");
    }
  });

  it("refuses a type outside JPEG, PNG and WebP, a size outside 1 byte to 25 MB, and unknown fields, and leaves no row", async () => {
    stubS3(); const before = await rowCount();
    for (const input of [
      { contentType: "image/gif", bytes: 10 }, { contentType: "image/svg+xml", bytes: 10 }, { contentType: "text/html", bytes: 10 }, { contentType: "IMAGE/PNG", bytes: 10 },
      { contentType: "image/png", bytes: 0 }, { contentType: "image/png", bytes: 26_214_401 }, { contentType: "image/png", bytes: 1.5 }, { contentType: "image/png" }, { bytes: 5 }, { contentType: "image/png", bytes: 5, extra: true },
    ]) expect((await presign(S3_ENV, "member", input)).status, JSON.stringify(input)).toBe(400);
    expect((await presign(S3_ENV, "member", { contentType: "image/webp", bytes: 26_214_400 })).status).toBe(200);
    expect(await rowCount()).toBe(before + 1);
  });

  it("answers a non-member staff 403, a non-member External 404, an unknown Project 404 for an admin, and an archived Project 409", async () => {
    stubS3(); const before = await rowCount(); const body = { contentType: "image/png", bytes: 10 };
    expect((await presign(S3_ENV, "other", body)).status).toBe(403);
    expect((await presign(S3_ENV, "externalOutsider", body)).status).toBe(404);
    expect((await presign(S3_ENV, "admin", body, crypto.randomUUID())).status).toBe(404);
    expect((await presign(S3_ENV, "admin", body, ids.archivedProject)).status).toBe(409);
    expect((await presign(S3_ENV, "admin", body, "not-a-uuid")).status).toBe(400);
    expect(await rowCount()).toBe(before);
  });

  it("answers 503 with no row when R2 upload credentials are missing in production, and 401 with no session", async () => {
    const before = await rowCount();
    expect((await presign(baseEnv, "member", { contentType: "image/png", bytes: 10 })).status).toBe(503);
    expect(await rowCount()).toBe(before);
    const anonymous = await app.fetch(new Request(`https://portal.test/api/projects/${ids.project}/embedded-media`, { method: "POST", headers: { origin: baseEnv.APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ contentType: "image/png", bytes: 10 }) }), baseEnv, createExecutionContext());
    expect(anonymous.status).toBe(401);
  });

  it("removes the reservation when R2 refuses to start the multipart upload", async () => {
    stubS3((url) => url.includes("?uploads") ? new Response("nope", { status: 403 }) : undefined); const before = await rowCount();
    expect((await presign(S3_ENV, "member", { contentType: "image/png", bytes: 10 })).status).toBeGreaterThanOrEqual(500);
    expect(await rowCount()).toBe(before);
  });

  it("dev: answers devDirect and accepts the bytes only from the uploader, with the stored content type", async () => {
    const response = await presign(DEV_ENV, "member", { contentType: "image/jpeg", bytes: 40 });
    expect(response.status).toBe(200); const body = externalEmbeddedMediaPresignSchema.parse(await response.json());
    expect(body).toMatchObject({ devDirect: true }); expect(body.partUrls).toBeUndefined();
    const path = `/api/projects/${ids.project}/embedded-media/${body.mediaId}/direct`;
    expect((await appRequest(DEV_ENV, path, "other", "PUT", undefined, jpegBytes(40))).status).toBe(403);
    expect((await appRequest(DEV_ENV, path, "admin", "PUT", undefined, jpegBytes(40))).status).toBe(404);
    expect((await appRequest(baseEnv, path, "member", "PUT", undefined, jpegBytes(40))).status).toBe(404);
    expect((await appRequest(DEV_ENV, path, "member", "PUT", undefined, jpegBytes(40), { "content-type": "text/html" })).status).toBe(204);
    const stored = await database.MEDIA.head(mediaKey(ids.project, body.mediaId));
    expect(stored?.size).toBe(40); expect(stored?.httpMetadata?.contentType).toBe("image/jpeg");
  });
});

describe("POST /projects/:id/embedded-media/:mediaId/complete", () => {
  const complete = (who: Who, mediaId: string, body: unknown = {}, projectId: string = ids.project, environment: Env = baseEnv) => appRequest(environment, `/api/projects/${projectId}/embedded-media/${mediaId}/complete`, who, "POST", body);

  it("verifies size, type and magic bytes, then moves the row to pending", async () => {
    const { id } = await seedMedia({ state: "uploading", bytes: 64 });
    const response = await complete("member", id);
    expect(response.status).toBe(200); expect(externalEmbeddedMediaCompleteSchema.parse(await response.json())).toEqual({ mediaId: id, state: "pending" });
    expect(await mediaRow(id)).toMatchObject({ state: "pending", owner_id: null });
  });

  it("is idempotent: a retry on a pending row answers 200 and changes nothing", async () => {
    const { id } = await seedMedia({ state: "uploading" });
    expect((await complete("member", id)).status).toBe(200);
    const first = await mediaRow(id);
    expect((await complete("member", id)).status).toBe(200);
    expect(await mediaRow(id)).toEqual(first);
  });

  it("deletes the object and the row on a size, content-type or magic-byte mismatch", async () => {
    const cases: Array<[string, Parameters<typeof seedMedia>[0]]> = [
      ["size", { state: "uploading", bytes: 99, object: pngBytes(64) }],
      ["content type", { state: "uploading", bytes: 64, contentType: "image/jpeg", object: pngBytes(64) }],
      ["magic bytes", { state: "uploading", bytes: 64, object: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'>".padEnd(64, " ")) }],
    ];
    for (const [label, input] of cases) {
      const { id, key } = await seedMedia(input);
      if (label === "content type") await database.MEDIA.put(key, pngBytes(64), { httpMetadata: { contentType: "image/png" } });
      expect((await complete("member", id)).status, label).toBe(400);
      expect(await mediaRow(id), label).toBeNull(); expect(await database.MEDIA.head(key), label).toBeNull();
    }
  });

  it("answers 400 and keeps the reservation when the object is not there yet", async () => {
    const { id } = await seedMedia({ state: "uploading", object: null });
    expect((await complete("member", id)).status).toBe(400);
    expect((await mediaRow(id))?.state).toBe("uploading");
  });

  it("is the uploader's alone: another collaborator, an admin and a stranger get 404", async () => {
    const { id } = await seedMedia({ state: "uploading", uploader: ids.member });
    expect((await complete("admin", id)).status).toBe(404);
    expect((await complete("external", id)).status).toBe(404);
    expect((await complete("other", id)).status).toBe(403);
    expect((await mediaRow(id))?.state).toBe("uploading");
  });

  it("refuses a row from another Project's path, an archived Project and a malformed id", async () => {
    const { id } = await seedMedia({ state: "uploading" });
    expect((await complete("admin", id, {}, ids.otherProject)).status).toBe(404);
    expect((await complete("member", "not-a-uuid")).status).toBe(400);
    const archived = await seedMedia({ state: "uploading", projectId: ids.archivedProject });
    expect((await complete("member", archived.id, {}, ids.archivedProject)).status).toBe(409);
  });

  it("deletes the stray object and answers 404 when the row is gone because the Project was deleted mid-upload", async () => {
    const projectId = crypto.randomUUID(); const mediaId = crypto.randomUUID(); const key = mediaKey(projectId, mediaId);
    await database.MEDIA.put(key, pngBytes(64), { httpMetadata: { contentType: "image/png" } });
    expect((await complete("admin", mediaId, {}, projectId)).status).toBe(404);
    expect(await database.MEDIA.head(key)).toBeNull();
  });

  it("does not delete the object of a row that still exists under a different state", async () => {
    const { id, key } = await seedMedia({ state: "attached" });
    expect((await complete("member", id)).status).toBe(409);
    expect(await database.MEDIA.head(key)).not.toBeNull();
  });

  it("completes a multipart upload with the stored upload id, requires the parts, and then verifies the object", async () => {
    const calls = stubS3();
    const { id } = await seedMedia({ state: "uploading", uploadId: "s3-upload-1", bytes: 64 });
    expect((await complete("member", id, {}, ids.project, S3_ENV)).status).toBe(400);
    expect((await complete("member", id, { parts: [{ partNumber: 1, etag: "\"abc\"" }, { partNumber: 2, etag: "\"def\"" }] }, ids.project, S3_ENV)).status).toBe(400);
    expect(calls.filter((call) => call.url.includes("uploadId="))).toHaveLength(0);
    expect((await complete("member", id, { parts: [{ partNumber: 1, etag: "\"abc\"" }] }, ids.project, S3_ENV)).status).toBe(200);
    const finish = calls.find((call) => call.method === "POST" && call.url.includes("uploadId=s3-upload-1"));
    expect(finish?.url).toContain(`/projects/${ids.project}/embedded-media/${id}/original`);
    expect((await mediaRow(id))?.state).toBe("pending");
  });
});

describe("GET /media/embedded/:mediaId", () => {
  const get = (who: Who, mediaId: string) => request(`/media/embedded/${mediaId}`, who);

  it("serves a pending image to its uploader only", async () => {
    const { id } = await seedMedia({ state: "pending", uploader: ids.member });
    const response = await get("member", id);
    expect(response.status).toBe(200); expect((await response.arrayBuffer()).byteLength).toBe(64);
    for (const who of ["admin", "other", "external", "externalOutsider"] as const) expect((await get(who, id)).status, who).toBe(404);
  });

  it("serves an attached image to everyone who can collaborate on its Project, including an assigned External editor", async () => {
    const { id } = await seedMedia({ state: "attached", uploader: ids.member });
    for (const who of ["member", "admin", "external"] as const) expect((await get(who, id)).status, who).toBe(200);
    expect((await get("other", id)).status).toBe(403);
    expect((await get("externalOutsider", id)).status).toBe(404);
  });

  it("serves a detached image to its uploader only", async () => {
    const { id } = await seedMedia({ state: "detached", uploader: ids.member });
    expect((await get("member", id)).status).toBe(200);
    for (const who of ["admin", "external", "other"] as const) expect((await get(who, id)).status, who).toBe(404);
  });

  it("sends the stored type, nosniff, a sandboxing CSP and a private five-minute cache that varies by cookie", async () => {
    const { id } = await seedMedia({ state: "attached", contentType: "image/jpeg", object: jpegBytes(64) });
    const response = await get("member", id);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    expect(response.headers.get("vary")).toBe("Cookie");
    await response.arrayBuffer();
  });

  it("never lets an error be cached, and answers 404 for an unknown id or a missing object and 400 for a malformed id", async () => {
    const { id } = await seedMedia({ state: "attached", object: null });
    const missing = await get("member", id); expect(missing.status).toBe(404); expect(missing.headers.get("cache-control")).toBe("private, no-store");
    expect((await get("member", crypto.randomUUID())).status).toBe(404);
    expect((await get("member", "not-a-uuid")).status).toBe(400);
    const denied = await get("other", (await seedMedia({ state: "attached" })).id); expect(denied.headers.get("cache-control")).toBe("private, no-store");
  });

  it("requires a session", async () => {
    const { id } = await seedMedia({ state: "attached" });
    expect((await workerFetch(`/media/embedded/${id}`)).status).toBe(401);
  });
});

async function workerFetch(path: string) { return app.fetch(new Request(`https://portal.test${path}`), baseEnv, createExecutionContext()); }
void env;
