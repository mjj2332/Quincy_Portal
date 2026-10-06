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
const queued = async (key: string) => database.DB.prepare("SELECT storage_key AS storageKey, upload_id AS uploadId, project_id AS projectId, attempts FROM embedded_media_cleanup WHERE storage_key = ?").bind(key).first<{ storageKey: string; uploadId: string | null; projectId: string | null; attempts: number }>();
const failingDelete = (): Env => ({ ...baseEnv, MEDIA: new Proxy(baseEnv.MEDIA, { get: (target, property) => {
  if (property === "delete") return async () => { throw new Error("R2 down"); };
  const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
} }) });
const rowCount = async () => (await database.DB.prepare("SELECT count(*) AS n FROM embedded_media").first<{ n: number }>())!.n;

function stubS3(handler: (url: string, init: RequestInit | undefined) => Response | undefined = () => undefined) {
  const calls: Array<{ url: string; method: string; headers: Headers }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = request.url;
    calls.push({ url, method: request.method, headers: request.headers });
    const custom = handler(url, { ...init, method: request.method }); if (custom) return custom;
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

  it("aborts the multipart upload and hands out no URLs when the reservation is gone by the time R2 answers", async () => {
    const calls = stubS3((_url, init) => init?.method === "DELETE" ? new Response(null, { status: 204 }) : undefined);
    // The reservation disappears after R2 has started the upload and before the route stores the upload id.
    const racing: Env = { ...S3_ENV, DB: new Proxy(S3_ENV.DB, { get: (target, property) => {
      if (property !== "prepare") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("SET upload_id")) return statement;
        return { bind: (...values: unknown[]) => { const bound = statement.bind(...values); return { run: async () => { await target.prepare("DELETE FROM embedded_media WHERE state = 'uploading' AND bytes = 7777").run(); return bound.run(); } }; } };
      };
    } }) };
    const before = await rowCount();
    const response = await presign(racing, "member", { contentType: "image/png", bytes: 7777 });
    expect(response.status).toBe(409);
    expect(calls.some((call) => call.method === "DELETE" && call.url.includes("uploadId=s3-upload-1"))).toBe(true);
    expect(await rowCount()).toBe(before);
  });

  it("queues the multipart upload for cleanup when the abort itself fails after the reservation vanished", async () => {
    stubS3((_url, init) => init?.method === "DELETE" ? new Response("down", { status: 403 }) : undefined);
    const racing: Env = { ...S3_ENV, DB: new Proxy(S3_ENV.DB, { get: (target, property) => {
      if (property !== "prepare") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("SET upload_id")) return statement;
        return { bind: (...values: unknown[]) => { const bound = statement.bind(...values); return { run: async () => { await target.prepare("DELETE FROM embedded_media WHERE state = 'uploading' AND bytes = 7778").run(); return bound.run(); } }; } };
      };
    } }) };
    expect((await presign(racing, "member", { contentType: "image/png", bytes: 7778 })).status).toBe(409);
    const row = await database.DB.prepare("SELECT storage_key AS k, upload_id AS u, project_id AS p FROM embedded_media_cleanup WHERE upload_id = 's3-upload-1'").first<{ k: string; u: string; p: string }>();
    expect(row).toMatchObject({ u: "s3-upload-1", p: ids.project });
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

  it("queues the object for cleanup (never just drops it) when a rejection cannot delete it, and the queue owns it from then on", async () => {
    const { id, key } = await seedMedia({ state: "uploading", bytes: 99, object: pngBytes(64) });
    expect((await complete("member", id, {}, ids.project, failingDelete())).status).toBe(400);
    expect(await database.MEDIA.head(key)).not.toBeNull();
    expect(await mediaRow(id)).toBeNull();
    expect(await queued(key)).toMatchObject({ storageKey: key, projectId: ids.project, attempts: 0 });
  });

  it("leaves the object and the queue alone when the row vanished while R2 was being read: whoever removed the row owns the bytes", async () => {
    const { id, key } = await seedMedia({ state: "uploading", object: pngBytes(64) });
    const racing: Env = { ...baseEnv, MEDIA: new Proxy(baseEnv.MEDIA, { get: (target, property) => {
      if (property === "delete") return async () => { throw new Error("complete must not touch R2 without owning the row"); };
      if (property === "get") return async (...args: Parameters<R2Bucket["get"]>) => {
        const result = await (target.get as (...a: unknown[]) => Promise<unknown>).call(target, ...args);
        await database.DB.prepare("DELETE FROM embedded_media WHERE id = ?").bind(id).run();
        return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) };
    expect((await complete("member", id, {}, ids.project, racing)).status).toBe(404);
    expect(await database.MEDIA.head(key)).not.toBeNull(); expect(await queued(key)).toBeNull();
  });

  it("a completion that loses the promotion to a concurrent winner leaves the live image and the queue untouched", async () => {
    const { id, key } = await seedMedia({ state: "uploading", object: pngBytes(64) });
    const owner = crypto.randomUUID();
    // Another completion promotes and a comment attaches the image after this completion's checks, while it is reading R2.
    const racing: Env = { ...baseEnv, MEDIA: new Proxy(baseEnv.MEDIA, { get: (target, property) => {
      if (property === "delete") return async () => { throw new Error("a losing completion must not delete a live image"); };
      if (property === "get") return async (...args: Parameters<R2Bucket["get"]>) => {
        const result = await (target.get as (...a: unknown[]) => Promise<unknown>).call(target, ...args);
        await database.DB.prepare("UPDATE embedded_media SET state = 'attached', owner_id = ? WHERE id = ?").bind(owner, id).run();
        return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) };
    expect((await complete("member", id, {}, ids.project, racing)).status).toBe(409);
    expect(await mediaRow(id)).toMatchObject({ state: "attached", owner_id: owner });
    expect(await database.MEDIA.head(key)).not.toBeNull(); expect(await queued(key)).toBeNull();
    expect((await request(`/media/embedded/${id}`, "admin")).status).toBe(200);
  });

  it("claims the row before deleting: if another writer attaches it between the lost promotion's re-read and the cleanup, R2 is never touched", async () => {
    const projectId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Claim', 'editing_autohdr', ?, ?)").bind(projectId, now, now).run();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, ids.member, now).run();
    const { id, key } = await seedMedia({ state: "uploading", projectId });
    const owner = crypto.randomUUID(); let reads = 0;
    const racing: Env = {
      ...baseEnv,
      // The Project is archived while R2 is read, so the promotion is lost and the row still reads as uploading.
      MEDIA: new Proxy(baseEnv.MEDIA, { get: (target, property) => {
        if (property === "delete") return async () => { throw new Error("must not delete an object the completion no longer owns"); };
        if (property === "get") return async (...args: Parameters<R2Bucket["get"]>) => {
          const result = await (target.get as (...a: unknown[]) => Promise<unknown>).call(target, ...args);
          await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), projectId).run();
          return result;
        };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } }),
      DB: new Proxy(baseEnv.DB, { get: (target, property) => {
        if (property !== "prepare") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("SELECT * FROM embedded_media WHERE id")) return statement;
          return { bind: (...values: unknown[]) => { const bound = statement.bind(...values); return { first: async () => {
            const read = await bound.first(); reads += 1;
            // The re-read after the lost promotion sees 'uploading'. Then another writer takes the row, before the cleanup claims it.
            if (reads === 2) await database.DB.prepare("UPDATE embedded_media SET state = 'attached', owner_id = ? WHERE id = ?").bind(owner, id).run();
            return read;
          } }; } };
        };
      } }),
    };
    expect((await complete("member", id, {}, projectId, racing)).status).toBe(409);
    expect(await mediaRow(id)).toMatchObject({ state: "attached", owner_id: owner });
    expect(await database.MEDIA.head(key)).not.toBeNull(); expect(await queued(key)).toBeNull();
  });

  it("does not touch R2 when the Project is gone: the hard delete already queued the key", async () => {
    const projectId = crypto.randomUUID(); const mediaId = crypto.randomUUID(); const key = mediaKey(projectId, mediaId);
    await database.MEDIA.put(key, pngBytes(64), { httpMetadata: { contentType: "image/png" } });
    expect((await complete("admin", mediaId, {}, projectId, failingDelete())).status).toBe(404);
    expect(await database.MEDIA.head(key)).not.toBeNull(); expect(await queued(key)).toBeNull();
  });

  it("does not promote, and deletes the object and the row, when the Project is archived or deleted while R2 is being read", async () => {
    for (const lifecycle of ["archive", "delete"] as const) {
      const projectId = crypto.randomUUID(); const now = Date.now();
      await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Racy', 'editing_autohdr', ?, ?)").bind(projectId, now, now).run();
      await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, ids.member, now).run();
      const { id, key } = await seedMedia({ state: "uploading", projectId });
      // The lifecycle change lands after the route's earlier checks, during its R2 reads.
      const racing: Env = { ...baseEnv, MEDIA: new Proxy(baseEnv.MEDIA, { get: (target, property) => {
        if (property === "get") return async (...args: Parameters<R2Bucket["get"]>) => {
          const result = await (target.get as (...a: unknown[]) => Promise<unknown>).call(target, ...args);
          await database.DB.prepare(lifecycle === "archive" ? "UPDATE projects SET archived_at = ? WHERE id = ?" : "DELETE FROM projects WHERE id = ? AND ? > 0").bind(...(lifecycle === "archive" ? [Date.now(), projectId] : [projectId, 1])).run();
          return result;
        };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } }) };
      const response = await complete("member", id, {}, projectId, racing);
      expect(response.status, lifecycle).toBe(lifecycle === "archive" ? 409 : 404);
      expect(await mediaRow(id), lifecycle).toBeNull();
      // Archive: this completion claims the row and deletes the object. Delete: the row went with the Project, whose hard delete owns the bytes.
      if (lifecycle === "archive") expect(await database.MEDIA.head(key)).toBeNull(); else expect(await database.MEDIA.head(key)).not.toBeNull();
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

  it("answers 404 and leaves the object when the row is gone because the Project was deleted mid-upload", async () => {
    const projectId = crypto.randomUUID(); const mediaId = crypto.randomUUID(); const key = mediaKey(projectId, mediaId);
    await database.MEDIA.put(key, pngBytes(64), { httpMetadata: { contentType: "image/png" } });
    expect((await complete("admin", mediaId, {}, projectId)).status).toBe(404);
    expect(await database.MEDIA.head(key)).not.toBeNull();
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
