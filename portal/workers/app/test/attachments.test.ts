import { createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_MAX_BYTES, attachmentCompleteResponseSchema, attachmentObjectKey, attachmentPresignResponseSchema } from "@quincy/shared";
import { createAuth } from "../src/auth";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, database, ids, request, seedFixture, tokens, type Who } from "./embedded-media-support";
import { attachmentAudits, attachmentRow, fileBytes, seedAttachment } from "./attachment-support";

const S3_ENV: Env = { ...baseEnv, R2_ACCOUNT_ID: "acct", R2_S3_ACCESS_KEY_ID: "key", R2_S3_SECRET_ACCESS_KEY: "secret" };
const DEV_ENV: Env = { ...baseEnv, APP_ENV: "dev" };
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";

async function appRequest(environment: Env, path: string, who: Who, method: "GET" | "POST" | "PUT", body?: unknown, rawBody?: BodyInit) {
  const context = await createAuth(environment).$context;
  const cookieValue = `${context.authCookies.sessionToken.name}=${tokens[who]}.${await makeSignature(tokens[who], authSecret)}`;
  const init: RequestInit = { method, headers: { cookie: cookieValue, origin: environment.APP_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : rawBody !== undefined ? { body: rawBody } : {}) };
  return app.fetch(new Request(`https://portal.test${path}`, init), environment, createExecutionContext());
}
const base = (projectId: string = ids.project) => `/api/projects/${projectId}/attachments`;
const presign = (environment: Env, who: Who, body: unknown, projectId?: string) => appRequest(environment, base(projectId), who, "POST", body);
const pdf = (bytes = 32, name = "Floor plan.pdf") => ({ name, contentType: "application/pdf", bytes });
const rowCount = async () => (await database.DB.prepare("SELECT count(*) AS n FROM attachments").first<{ n: number }>())!.n;

function stubS3() {
  const calls: Array<{ url: string; method: string; contentType: string | null }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push({ url: req.url, method: req.method, contentType: req.headers.get("content-type") });
    if (req.method === "POST" && req.url.includes("?uploads")) return new Response("<InitiateMultipartUploadResult><UploadId>s3-attachment-1</UploadId></InitiateMultipartUploadResult>");
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(null, { status: 200 });
  });
  return calls;
}

beforeAll(async () => { await seedFixture(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("POST /api/projects/:projectId/attachments", () => {
  it("reserves an uploading row for a PDF and hands out part URLs, the object stored as octet-stream", async () => {
    const calls = stubS3();
    const response = await presign(S3_ENV, "member", pdf(5000));
    expect(response.status).toBe(200);
    const body = attachmentPresignResponseSchema.parse(await response.json());
    expect(body.partUrls).toHaveLength(1); expect(body.uploadId).toBe("s3-attachment-1");
    expect(await attachmentRow(body.attachmentId)).toMatchObject({ state: "uploading", file_name: "Floor plan.pdf", content_type: "application/pdf", bytes: 5000, owner_id: null, uploader_id: ids.member, upload_id: "s3-attachment-1", storage_key: attachmentObjectKey(ids.project, body.attachmentId) });
    expect(calls.find((call) => call.url.includes("?uploads"))?.contentType).toBe("application/octet-stream");
    expect((await attachmentAudits(body.attachmentId)).map((row) => row.action)).toEqual(["attachment.presign"]);
  });

  it("stores the sanitised name, never the path or a hidden override", async () => {
    stubS3();
    const body = attachmentPresignResponseSchema.parse(await (await presign(S3_ENV, "member", pdf(10, "C:\\fakepath\\report\u202Efdp.txt. "))).json());
    expect((await attachmentRow(body.attachmentId))?.file_name).toBe("reportfdp.txt");
  });

  it("refuses, and reserves nothing for, a blocked extension, a blocked type, an empty file, one over 100 MB and a blank name", async () => {
    stubS3();
    const before = await rowCount();
    const cases: Array<[unknown, number, string]> = [
      [pdf(10, "setup.exe"), 400, "attachment_blocked"],
      [{ name: "notes.txt", contentType: "text/html; charset=utf-8", bytes: 10 }, 400, "attachment_blocked"],
      [pdf(0), 400, "attachment_empty"],
      [pdf(ATTACHMENT_MAX_BYTES + 1), 400, "attachment_too_large"],
      [pdf(10, " .. "), 400, "invalid_name"],
    ];
    for (const [input, status, code] of cases) {
      const response = await presign(S3_ENV, "member", input);
      expect(response.status, code).toBe(status);
      const json = await response.json() as { code: string; error: string };
      expect(json.code).toBe(code);
      if (code === "attachment_too_large") expect(json.error).toContain("100 MB");
      if (code === "attachment_blocked") expect(json.error).toMatch(/\.exe|text\/html/);
    }
    expect(await rowCount()).toBe(before);
  });

  it("is 403 for staff off the Project, 404 for an External outside it, 409 on an archived Project and 401 without a session", async () => {
    stubS3();
    expect((await presign(S3_ENV, "other", pdf())).status).toBe(403);
    expect((await presign(S3_ENV, "externalOutsider", pdf())).status).toBe(404);
    expect((await presign(S3_ENV, "member", pdf(), ids.archivedProject)).status).toBe(409);
    expect((await request(base(), "member", "POST", pdf())).status).not.toBe(401);
    const anonymous = await app.fetch(new Request(`https://portal.test${base()}`, { method: "POST", headers: { origin: baseEnv.APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify(pdf()) }), baseEnv, createExecutionContext());
    expect(anonymous.status).toBe(401);
  });

  it("lets an External editor on the Project upload (owner decision A1)", async () => {
    stubS3();
    expect((await presign(S3_ENV, "external", pdf())).status).toBe(200);
  });

  it("dev: answers devDirect and takes the bytes from the uploader only, stored as octet-stream", async () => {
    const response = await presign(DEV_ENV, "member", pdf(32));
    const body = attachmentPresignResponseSchema.parse(await response.json());
    expect(body.devDirect).toBe(true);
    const path = `${base()}/${body.attachmentId}/direct`;
    expect((await appRequest(DEV_ENV, path, "admin", "PUT", undefined, fileBytes(32))).status).toBe(404);
    expect((await appRequest(baseEnv, path, "member", "PUT", undefined, fileBytes(32))).status).toBe(404);
    expect((await appRequest(DEV_ENV, path, "member", "PUT", undefined, fileBytes(32))).status).toBe(204);
    expect((await database.MEDIA.head(attachmentObjectKey(ids.project, body.attachmentId)))?.httpMetadata?.contentType).toBe("application/octet-stream");
  });
});

describe("POST /api/projects/:projectId/attachments/:id/complete", () => {
  const complete = (who: Who, id: string, body: unknown = {}) => appRequest(baseEnv, `${base()}/${id}/complete`, who, "POST", body);

  it("checks the stored object and moves the row to pending, idempotently", async () => {
    const { id } = await seedAttachment({ state: "uploading" });
    const response = await complete("member", id);
    expect(response.status).toBe(200);
    expect(attachmentCompleteResponseSchema.parse(await response.json())).toEqual({ attachmentId: id, state: "pending" });
    const first = await attachmentRow(id);
    expect(first).toMatchObject({ state: "pending", owner_id: null });
    expect((await complete("member", id)).status).toBe(200);
    expect(await attachmentRow(id)).toEqual(first);
    expect((await attachmentAudits(id)).map((row) => row.action)).toEqual(["attachment.upload"]);
  });

  it("discards the row and the object when the stored size or type is not what was reserved", async () => {
    const short = await seedAttachment({ state: "uploading", bytes: 99, object: fileBytes(32) });
    expect((await complete("member", short.id)).status).toBe(400);
    expect(await attachmentRow(short.id)).toBeNull(); expect(await database.MEDIA.head(short.key)).toBeNull();
    const typed = await seedAttachment({ state: "uploading", object: null });
    await database.MEDIA.put(typed.key, fileBytes(32), { httpMetadata: { contentType: "text/html" } });
    expect((await complete("member", typed.id)).status).toBe(400);
    expect(await attachmentRow(typed.id)).toBeNull(); expect(await database.MEDIA.head(typed.key)).toBeNull();
  });

  it("is 404 for someone else's upload", async () => {
    const { id } = await seedAttachment({ state: "uploading" });
    expect((await complete("admin", id)).status).toBe(404);
    expect((await attachmentRow(id))?.state).toBe("uploading");
  });
});

describe("POST /api/projects/:projectId/attachments/:id/abort", () => {
  const abort = (who: Who, id: string) => appRequest(baseEnv, `${base()}/${id}/abort`, who, "POST");

  it("lets the uploader cancel an uploading or pending file, and nobody else", async () => {
    const uploading = await seedAttachment({ state: "uploading" });
    const pending = await seedAttachment({ state: "pending" });
    expect((await abort("admin", uploading.id)).status).toBe(404);
    expect((await abort("member", uploading.id)).status).toBe(204);
    expect((await abort("member", pending.id)).status).toBe(204);
    for (const row of [uploading, pending]) { expect(await attachmentRow(row.id)).toBeNull(); expect(await database.MEDIA.head(row.key)).toBeNull(); }
  });

  it("will not cancel a file already in a post", async () => {
    const attached = await seedAttachment({ state: "attached" });
    expect((await abort("member", attached.id)).status).toBe(409);
    expect((await attachmentRow(attached.id))?.state).toBe("attached");
  });
});
