import { SELF as workerSelf, createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { externalEmbeddedMediaPresignSchema } from "@quincy/shared";
import { createAuth } from "../src/auth";
import { app } from "../src/index";
import { enqueueEmbeddedMediaCleanup } from "../src/lib/embedded-media";
import { CommentMediaConflictError, createProjectComment, editProjectComment } from "../src/lib/project-comments";
import type { Env } from "../src/env";
import { baseEnv, cookie, database, ids, imageDoc, jpegBytes, mediaKey, mediaRow, mp4Bytes, pngBytes, request, seedFixture, seedMedia, tokens, type Who } from "./embedded-media-support";

/** Video in Project discussion (#494): presign and complete for video, the poster, abort, Range, and attaching to a comment. */
const S3_ENV: Env = { ...baseEnv, R2_ACCOUNT_ID: "acct", R2_S3_ACCESS_KEY_ID: "key", R2_S3_SECRET_ACCESS_KEY: "secret" };
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const GIB = 1024 * 1024 * 1024;

async function appRequest(environment: Env, path: string, who: Who, method: "GET" | "POST" | "PUT", body?: unknown, rawBody?: BodyInit, headers: Record<string, string> = {}) {
  const context = await createAuth(environment).$context;
  const cookieValue = `${context.authCookies.sessionToken.name}=${tokens[who]}.${await makeSignature(tokens[who], authSecret)}`;
  const init: RequestInit = { method, headers: { cookie: cookieValue, origin: environment.APP_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : rawBody !== undefined ? { body: rawBody } : {}) };
  return app.fetch(new Request(`https://portal.test${path}`, init), environment, createExecutionContext());
}
const base = (projectId: string = ids.project) => `/api/projects/${projectId}/embedded-media`;
const presign = (environment: Env, who: Who, body: unknown, projectId?: string) => appRequest(environment, base(projectId), who, "POST", body);
const complete = (who: Who, mediaId: string, environment: Env = baseEnv, parts?: unknown) => appRequest(environment, `${base()}/${mediaId}/complete`, who, "POST", parts ? { parts } : {});
const putPoster = (who: Who, mediaId: string, body: BodyInit | undefined, environment: Env = baseEnv, headers: Record<string, string> = {}, projectId?: string) => appRequest(environment, `${base(projectId)}/${mediaId}/poster`, who, "PUT", undefined, body, headers);
const abort = (who: Who, mediaId: string, environment: Env = baseEnv, projectId?: string) => appRequest(environment, `${base(projectId)}/${mediaId}/abort`, who, "POST", {});
async function get(path: string, who: Who, headers: Record<string, string> = {}) { return workerSelf.fetch(`https://portal.test${path}`, { headers: { cookie: await cookie(who), ...headers } }); }
const queued = async (key: string) => database.DB.prepare("SELECT storage_key AS storageKey, upload_id AS uploadId, project_id AS projectId FROM embedded_media_cleanup WHERE storage_key = ?").bind(key).first<{ storageKey: string; uploadId: string | null; projectId: string | null }>();
const rowCount = async () => (await database.DB.prepare("SELECT count(*) AS n FROM embedded_media").first<{ n: number }>())!.n;
const consume = async (response: Response) => new Uint8Array(await response.arrayBuffer());
const videoDoc = (...mediaIds: string[]) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Look" }] }, ...mediaIds.map((mediaId) => ({ type: "video", attrs: { mediaId } }))] });
const wrapMedia = (override: (target: R2Bucket, property: string | symbol) => unknown): Env => ({ ...baseEnv, MEDIA: new Proxy(baseEnv.MEDIA, { get: (target, property) => {
  const custom = override(target, property); if (custom !== undefined) return custom;
  const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
} }) });

function stubS3() {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); calls.push({ url: request.url, method: request.method });
    if (request.method === "POST" && request.url.includes("?uploads")) return new Response("<InitiateMultipartUploadResult><UploadId>s3-upload-v1</UploadId></InitiateMultipartUploadResult>");
    return new Response("unexpected", { status: 500 });
  });
  return calls;
}

beforeAll(async () => { await seedFixture(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("video presign (#494)", () => {
  it("reserves a video row for staff and an assigned External editor, with part URLs that live six hours (an image's stay at one)", async () => {
    stubS3();
    for (const who of ["admin", "member", "external"] as const) for (const contentType of ["video/mp4", "video/quicktime"]) {
      const response = await presign(S3_ENV, who, { contentType, bytes: 300_000_000 });
      expect(response.status, `${who} ${contentType}`).toBe(200);
      const body = externalEmbeddedMediaPresignSchema.parse(await response.json());
      expect(body.partUrls).toHaveLength(5);
      for (const url of body.partUrls!) expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("21600");
      expect(await mediaRow(body.mediaId)).toMatchObject({ kind: "video", content_type: contentType, bytes: 300_000_000, uploader_id: ids[who], state: "uploading", original_key: mediaKey(ids.project, body.mediaId) });
    }
    const image = externalEmbeddedMediaPresignSchema.parse(await (await presign(S3_ENV, "member", { contentType: "image/png", bytes: 10 })).json());
    expect(new URL(image.partUrls![0]!).searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(await mediaRow(image.mediaId)).toMatchObject({ kind: "image" });
  });

  it("takes exactly 1 GiB and refuses one byte more, and still holds an image to 25 MB", async () => {
    stubS3(); const before = await rowCount();
    const full = await presign(S3_ENV, "member", { contentType: "video/mp4", bytes: GIB });
    expect(full.status).toBe(200); expect(externalEmbeddedMediaPresignSchema.parse(await full.json()).partUrls).toHaveLength(16);
    for (const input of [{ contentType: "video/mp4", bytes: GIB + 1 }, { contentType: "video/quicktime", bytes: 2 * GIB }, { contentType: "image/png", bytes: 26_214_401 }, { contentType: "video/mp4", bytes: 0 }])
      expect((await presign(S3_ENV, "member", input)).status, JSON.stringify(input)).toBe(400);
    expect(await rowCount()).toBe(before + 1);
  });

  it("refuses other video types and a mislabelled one, and leaves no row", async () => {
    stubS3(); const before = await rowCount();
    for (const contentType of ["video/webm", "video/x-matroska", "video/avi", "audio/mp4", "application/mp4", "VIDEO/MP4", "video/*"])
      expect((await presign(S3_ENV, "member", { contentType, bytes: 1000 })).status, contentType).toBe(400);
    expect(await rowCount()).toBe(before);
  });

  it("keeps the Project gates: non-member staff 403, outsider External 404, archived 409", async () => {
    stubS3(); const body = { contentType: "video/mp4", bytes: 1000 };
    expect((await presign(S3_ENV, "other", body)).status).toBe(403);
    expect((await presign(S3_ENV, "externalOutsider", body)).status).toBe(404);
    expect((await presign(S3_ENV, "admin", body, ids.archivedProject)).status).toBe(409);
  });
});

describe("video complete (#494)", () => {
  it("promotes an MP4 and a QuickTime file to pending, whatever brand the container carries", async () => {
    for (const [contentType, brand] of [["video/mp4", "isom"], ["video/mp4", "mp42"], ["video/quicktime", "qt  "]] as const) {
      const { id } = await seedMedia({ kind: "video", state: "uploading", contentType, bytes: 4096, object: mp4Bytes(4096, brand) });
      expect((await complete("member", id)).status, brand).toBe(200);
      expect(await mediaRow(id)).toMatchObject({ state: "pending", kind: "video" });
    }
  });

  it("accepts a container whose brand disagrees with the declared type, because the browser only guesses a type from the file extension", async () => {
    const { id } = await seedMedia({ kind: "video", state: "uploading", contentType: "video/quicktime", bytes: 4096, object: mp4Bytes(4096, "isom") });
    expect((await complete("member", id)).status).toBe(200);
    expect(await mediaRow(id)).toMatchObject({ state: "pending", content_type: "video/quicktime" });
  });

  it("deletes the object and the row for a file that is not an MP4/MOV container: an image, text, a missing ftyp, a legacy ftyp-less QuickTime file", async () => {
    const legacy = mp4Bytes(4096); legacy.set([0x6d, 0x6f, 0x6f, 0x76], 4);
    const cases: Array<[string, Uint8Array]> = [["png", pngBytes(4096)], ["jpeg", jpegBytes(4096)], ["text", new TextEncoder().encode("<html>".padEnd(4096, " "))], ["legacy quicktime moov", legacy], ["tiny box", (() => { const b = mp4Bytes(4096); b.set([0, 0, 0, 4]); return b; })()]];
    for (const [label, object] of cases) {
      const { id, key } = await seedMedia({ kind: "video", state: "uploading", bytes: 4096, object });
      expect((await complete("member", id)).status, label).toBe(400);
      expect(await mediaRow(id), label).toBeNull(); expect(await database.MEDIA.head(key), label).toBeNull();
    }
  });

  it("still rejects a video container sent as an image row", async () => {
    const { id, key } = await seedMedia({ kind: "image", state: "uploading", bytes: 4096, object: mp4Bytes(4096) });
    expect((await complete("member", id)).status).toBe(400);
    expect(await mediaRow(id)).toBeNull(); expect(await database.MEDIA.head(key)).toBeNull();
  });

  it("rejects a video whose stored size is not the reserved size", async () => {
    const { id } = await seedMedia({ kind: "video", state: "uploading", bytes: 9999, object: mp4Bytes(4096) });
    expect((await complete("member", id)).status).toBe(400);
    expect(await mediaRow(id)).toBeNull();
  });

  it("loses cleanly to a cancel: an abort that claims the row while the completion reads R2 leaves the completion at 404 and nothing promoted", async () => {
    const { id, key } = await seedMedia({ kind: "video", state: "uploading", bytes: 4096 });
    const racing = wrapMedia((target, property) => property === "get" ? async (...args: Parameters<R2Bucket["get"]>) => {
      const result = await (target.get as (...a: unknown[]) => Promise<unknown>).call(target, ...args);
      expect((await abort("member", id)).status).toBe(204);
      return result;
    } : undefined);
    expect((await complete("member", id, racing)).status).toBe(404);
    expect(await mediaRow(id)).toBeNull(); expect(await database.MEDIA.head(key)).toBeNull();
  });
});

describe("PUT …/poster (#494)", () => {
  const pending = (extra: Parameters<typeof seedMedia>[0] = {}) => seedMedia({ kind: "video", state: "pending", bytes: 4096, ...extra });

  it("stores a JPEG poster under the media's own prefix for the uploader, and serves it to the uploader only until the video is attached", async () => {
    const { id } = await pending();
    const response = await putPoster("member", id, jpegBytes(2048), baseEnv, { "content-type": "image/jpeg" });
    expect(response.status).toBe(204);
    const row = (await mediaRow(id))!; const posterKey = row.poster_key as string;
    expect(posterKey.startsWith(`projects/${ids.project}/embedded-media/${id}/poster-`)).toBe(true);
    expect((await database.MEDIA.head(posterKey))?.size).toBe(2048);
    expect(await queued(posterKey)).toBeNull();
    const poster = await get(`/media/embedded/${id}/poster`, "member");
    expect(poster.status).toBe(200); expect(poster.headers.get("content-type")).toBe("image/jpeg");
    expect(poster.headers.get("x-content-type-options")).toBe("nosniff"); expect(poster.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(poster.headers.get("cache-control")).toBe("private, max-age=300"); expect(poster.headers.get("vary")).toBe("Cookie");
    expect((await consume(poster)).byteLength).toBe(2048);
    for (const who of ["admin", "external", "other"] as const) expect((await get(`/media/embedded/${id}/poster`, who)).status, who).toBe(404);
  });

  it("follows the video once it is attached: collaborators, an assigned External editor and an admin read it, an outsider does not", async () => {
    const { id } = await seedMedia({ kind: "video", state: "attached", poster: true });
    for (const who of ["member", "admin", "external"] as const) { const response = await get(`/media/embedded/${id}/poster`, who); expect(response.status, who).toBe(200); await consume(response); }
    expect((await get(`/media/embedded/${id}/poster`, "other")).status).toBe(403);
    expect((await get(`/media/embedded/${id}/poster`, "externalOutsider")).status).toBe(404);
  });

  it("answers 404 for a video with no poster, an image row, an unknown id and a malformed id", async () => {
    const noPoster = await seedMedia({ kind: "video", state: "attached" });
    const image = await seedMedia({ kind: "image", state: "attached" });
    for (const id of [noPoster.id, image.id, crypto.randomUUID()]) expect((await get(`/media/embedded/${id}/poster`, "member")).status).toBe(404);
    expect((await get("/media/embedded/not-a-uuid/poster", "member")).status).toBe(400);
  });

  it("refuses a body over 2 MiB (413), a non-JPEG (400) and an empty body (400), and stores nothing", async () => {
    const { id } = await pending();
    expect((await putPoster("member", id, jpegBytes(2 * 1024 * 1024 + 1), baseEnv, { "content-type": "image/jpeg" })).status).toBe(413);
    expect((await putPoster("member", id, pngBytes(512))).status).toBe(400);
    expect((await putPoster("member", id, new TextEncoder().encode("<svg/>"))).status).toBe(400);
    expect((await putPoster("member", id, new Uint8Array())).status).toBe(400);
    expect((await mediaRow(id))!.poster_key).toBeNull();
    expect((await database.MEDIA.list({ prefix: `projects/${ids.project}/embedded-media/${id}/poster-` })).objects).toHaveLength(0);
  });

  it("accepts exactly 2 MiB", async () => {
    const { id } = await pending();
    expect((await putPoster("member", id, jpegBytes(2 * 1024 * 1024))).status).toBe(204);
  });

  it("is the uploader's alone, for a video row in pending, once, in a live Project", async () => {
    const { id } = await pending();
    expect((await putPoster("admin", id, jpegBytes(64))).status).toBe(404);
    expect((await putPoster("external", id, jpegBytes(64))).status).toBe(404);
    expect((await putPoster("other", id, jpegBytes(64))).status).toBe(403);
    expect((await putPoster("member", id, jpegBytes(64), baseEnv, {}, ids.otherProject)).status).toBe(403);
    expect((await mediaRow(id))!.poster_key).toBeNull();
    expect((await putPoster("member", id, jpegBytes(64))).status).toBe(204);
    const first = (await mediaRow(id))!.poster_key;
    expect((await putPoster("member", id, jpegBytes(64))).status).toBe(409);
    expect((await mediaRow(id))!.poster_key).toBe(first);
    const image = await seedMedia({ kind: "image", state: "pending" });
    expect((await putPoster("member", image.id, jpegBytes(64))).status).toBe(404);
    const uploading = await seedMedia({ kind: "video", state: "uploading" });
    expect((await putPoster("member", uploading.id, jpegBytes(64))).status).toBe(409);
    const attached = await seedMedia({ kind: "video", state: "attached" });
    expect((await putPoster("member", attached.id, jpegBytes(64))).status).toBe(409);
    const archived = await seedMedia({ kind: "video", state: "pending", projectId: ids.archivedProject });
    expect((await putPoster("member", archived.id, jpegBytes(64), baseEnv, {}, ids.archivedProject)).status).toBe(409);
    expect((await putPoster("member", crypto.randomUUID(), jpegBytes(64))).status).toBe(404);
    expect((await putPoster("member", "not-a-uuid", jpegBytes(64))).status).toBe(400);
  });

  it("leaves no orphan when the video is cancelled between the R2 write and the database write: the object goes, the queue is empty", async () => {
    const { id } = await pending();
    let written = "";
    const racing = wrapMedia((target, property) => property === "put" ? async (key: string, ...rest: unknown[]) => {
      written = key; const result = await (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest);
      expect((await abort("member", id)).status).toBe(204);
      return result;
    } : undefined);
    expect((await putPoster("member", id, jpegBytes(64), racing)).status).toBe(409);
    expect(written).toContain("/poster-");
    expect(await mediaRow(id)).toBeNull();
    expect(await database.MEDIA.head(written)).toBeNull(); expect(await queued(written)).toBeNull();
  });

  it("never loses ownership of a late poster: the sweep drained its queue entry and the cancel removed the row while the PUT was pending, then R2 refuses the delete, so the key is queued again", async () => {
    const { id } = await pending();
    let written = "";
    const racing = wrapMedia((target, property) => {
      if (property === "delete") return async () => { throw new Error("R2 down"); };
      if (property === "put") return async (key: string, ...rest: unknown[]) => {
        written = key; const result = await (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest);
        await database.DB.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ?").bind(key).run();
        await database.DB.prepare("DELETE FROM embedded_media WHERE id = ?").bind(id).run();
        return result;
      };
      return undefined;
    });
    expect((await putPoster("member", id, jpegBytes(64), racing)).status).toBe(409);
    expect(await database.MEDIA.head(written)).not.toBeNull();
    expect(await queued(written)).not.toBeNull();
  });

  it("does not adopt a poster whose cleanup entry the sweep claimed, cleaned and dequeued while the PUT was pending: the object is deleted and the row keeps no poster", async () => {
    const { id } = await pending();
    let written = "";
    const racing = wrapMedia((target, property) => property === "put" ? async (key: string, ...rest: unknown[]) => {
      written = key; const result = await (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest);
      await database.DB.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ?").bind(key).run();
      return result;
    } : undefined);
    expect((await putPoster("member", id, jpegBytes(64), racing)).status).toBe(409);
    expect((await mediaRow(id))!.poster_key).toBeNull();
    expect(await database.MEDIA.head(written)).toBeNull(); expect(await queued(written)).toBeNull();
  });

  it("refuses to adopt a poster whose cleanup entry the sweep holds a lease on, even an expired one: the object is deleted, no orphan", async () => {
    for (const claimedUntil of [Date.now() + 600_000, 1, 0]) {
      const { id } = await pending();
      let written = "";
      const racing = wrapMedia((target, property) => property === "put" ? async (key: string, ...rest: unknown[]) => {
        written = key; const result = await (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest);
        await database.DB.prepare("UPDATE embedded_media_cleanup SET claimed_until = ? WHERE storage_key = ?").bind(claimedUntil, key).run();
        return result;
      } : undefined);
      expect((await putPoster("member", id, jpegBytes(64), racing)).status, String(claimedUntil)).toBe(409);
      expect((await mediaRow(id))!.poster_key).toBeNull();
      expect(await database.MEDIA.head(written)).toBeNull(); expect(await queued(written)).toBeNull();
    }
  });

  it("when a claimed poster is refused and R2 will not delete it, the key is re-queued unclaimed with a newer queued_at, so a stale sweep's fenced dequeue and release match nothing", async () => {
    const { id } = await pending();
    let written = ""; let staleFence = { attempts: 0, queuedAt: 0 };
    const racing = wrapMedia((target, property) => {
      if (property === "delete") return async () => { throw new Error("R2 down"); };
      if (property === "put") return async (key: string, ...rest: unknown[]) => {
        written = key; const result = await (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest);
        await database.DB.prepare("UPDATE embedded_media_cleanup SET claimed_until = ?, attempts = attempts + 1 WHERE storage_key = ?").bind(Date.now() + 600_000, key).run();
        const claimed = await database.DB.prepare("SELECT attempts, queued_at AS queuedAt FROM embedded_media_cleanup WHERE storage_key = ?").bind(key).first<{ attempts: number; queuedAt: number }>();
        staleFence = claimed!;
        return result;
      };
      return undefined;
    });
    expect((await putPoster("member", id, jpegBytes(64), racing)).status).toBe(409);
    expect(await database.MEDIA.head(written)).not.toBeNull();
    expect(await database.DB.prepare("SELECT claimed_until AS claimedUntil FROM embedded_media_cleanup WHERE storage_key = ?").bind(written).first()).toEqual({ claimedUntil: null });
    const stale = [staleFence.attempts, staleFence.queuedAt];
    expect((await database.DB.prepare("DELETE FROM embedded_media_cleanup WHERE storage_key = ? AND attempts = ? AND queued_at = ?").bind(written, ...stale).run()).meta.changes).toBe(0);
    expect((await database.DB.prepare("UPDATE embedded_media_cleanup SET claimed_until = 0 WHERE storage_key = ? AND attempts = ? AND queued_at = ?").bind(written, ...stale).run()).meta.changes).toBe(0);
    expect(await queued(written)).not.toBeNull();
  });

  const throwingBatch = (base: Env): Env => ({ ...base, DB: new Proxy(base.DB, { get: (target, property) => {
    if (property === "batch") return async () => { throw new Error("D1 down"); };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } }) });

  it("(3) deletes the poster object when the adoption batch throws, leaving the row without a poster and no queue entry", async () => {
    const { id } = await pending(); let written = "";
    const base = wrapMedia((target, property) => property === "put" ? async (key: string, ...rest: unknown[]) => { written = key; return (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest); } : undefined);
    const response = await putPoster("member", id, jpegBytes(64), throwingBatch(base));
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect((await mediaRow(id))!.poster_key).toBeNull();
    expect(await database.MEDIA.head(written)).toBeNull(); expect(await queued(written)).toBeNull();
  });

  it("when the adoption throws, R2 refuses the delete and the re-queue fails too, the key is logged loudly as an orphan", async () => {
    const { id } = await pending(); let written = "";
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const base = wrapMedia((target, property) => {
      if (property === "delete") return async () => { throw new Error("R2 down"); };
      if (property === "put") return async (key: string, ...rest: unknown[]) => { written = key; return (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest); };
      return undefined;
    });
    await putPoster("member", id, jpegBytes(64), throwingBatch(base));
    const logged = errors.mock.calls.find((call) => /orphan/i.test(String(call[0])));
    errors.mockRestore();
    expect(logged).toBeDefined(); expect(JSON.stringify(logged)).toContain(written);
  });

  it("keeps the poster when the adoption batch commits and then throws and the verification read throws too: object present, row references it, no queue entry, key logged", async () => {
    const { id } = await pending(); let written = ""; let committed = false;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const base = wrapMedia((target, property) => property === "put" ? async (key: string, ...rest: unknown[]) => { written = key; return (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest); } : undefined);
    const flaky: Env = { ...base, DB: new Proxy(base.DB, { get: (target, property) => {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => { await target.batch(statements); committed = true; throw new Error("D1 connection lost"); };
      if (property === "prepare" && committed) return () => { throw new Error("D1 still down"); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) };
    const response = await putPoster("member", id, jpegBytes(64), flaky);
    const logged = errors.mock.calls.find((call) => /UNKNOWN/.test(String(call[0])));
    errors.mockRestore();
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(logged).toBeDefined(); expect(JSON.stringify(logged)).toContain(written);
    expect((await mediaRow(id))!.poster_key).toBe(written);
    expect(await database.MEDIA.head(written)).not.toBeNull(); expect(await queued(written)).toBeNull();
  });

  it("uses a fresh key for every attempt, never reusing one across PUTs", async () => {
    const { id } = await pending(); const keys: string[] = [];
    const recording = (claim: boolean) => wrapMedia((target, property) => property === "put" ? async (key: string, ...rest: unknown[]) => {
      keys.push(key); const result = await (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest);
      if (claim) await database.DB.prepare("UPDATE embedded_media_cleanup SET claimed_until = 0 WHERE storage_key = ?").bind(key).run();
      return result;
    } : undefined);
    expect((await putPoster("member", id, jpegBytes(64), recording(true))).status).toBe(409);
    expect((await putPoster("member", id, jpegBytes(64), recording(false))).status).toBe(204);
    expect(keys).toHaveLength(2); expect(keys[0]).not.toBe(keys[1]);
  });

  it("a poster adopted before any sweep claims it leaves no queue entry for a sweep to take", async () => {
    const { id } = await pending();
    expect((await putPoster("member", id, jpegBytes(64))).status).toBe(204);
    const posterKey = (await mediaRow(id))!.poster_key as string;
    expect(await queued(posterKey)).toBeNull();
    expect(await database.MEDIA.head(posterKey)).not.toBeNull();
  });

  it("leaves no orphan when the Project cascades away mid-write: with R2 refusing the delete, the key waits in the cleanup queue", async () => {
    const projectId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Cascade', 'editing_autohdr', ?, ?)").bind(projectId, now, now).run();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, ids.member, now).run();
    const { id } = await pending({ projectId });
    let written = "";
    const racing = wrapMedia((target, property) => {
      if (property === "delete") return async () => { throw new Error("R2 down"); };
      if (property === "put") return async (key: string, ...rest: unknown[]) => {
        written = key; const result = await (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest);
        await database.DB.prepare("DELETE FROM projects WHERE id = ? AND ? > 0").bind(projectId, 1).run();
        return result;
      };
      return undefined;
    });
    expect((await putPoster("member", id, jpegBytes(64), racing, {}, projectId)).status).toBe(409);
    expect(await mediaRow(id)).toBeNull();
    expect(await queued(written)).toMatchObject({ storageKey: written, projectId });
  });

  it("queues the key before writing it, so a crash after the write still has an owner", async () => {
    const { id } = await pending(); let queuedBeforePut = false;
    const watching = wrapMedia((target, property) => property === "put" ? async (key: string, ...rest: unknown[]) => {
      queuedBeforePut = (await queued(key)) !== null;
      return (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest);
    } : undefined);
    expect((await putPoster("member", id, jpegBytes(64), watching)).status).toBe(204);
    expect(queuedBeforePut).toBe(true);
  });
});

describe("POST …/abort (#494)", () => {
  it("kills the multipart upload before deleting its object, drops the row and the queue entry, and answers 204", async () => {
    const id = crypto.randomUUID(); const key = mediaKey(ids.project, id);
    const upload = await database.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: "video/mp4" } });
    await upload.uploadPart(1, new Uint8Array(64));
    await seedMedia({ id, kind: "video", state: "uploading", uploadId: upload.uploadId, object: null, bytes: 64 });
    const order: string[] = [];
    const watching = wrapMedia((target, property) => {
      if (property === "resumeMultipartUpload") return (k: string, uploadId: string) => { const resumed = target.resumeMultipartUpload(k, uploadId); return { uploadId, key: k, abort: async () => { order.push("abort"); return resumed.abort(); }, uploadPart: resumed.uploadPart.bind(resumed), complete: resumed.complete.bind(resumed) }; };
      if (property === "delete") return async (keys: string | string[]) => { order.push("delete"); return target.delete(keys); };
      return undefined;
    });
    expect((await abort("member", id, watching)).status).toBe(204);
    expect(order).toEqual(["abort", "delete"]);
    expect(await mediaRow(id)).toBeNull(); expect(await queued(key)).toBeNull(); expect(await database.MEDIA.head(key)).toBeNull();
    await expect(database.MEDIA.resumeMultipartUpload(key, upload.uploadId).uploadPart(2, new Uint8Array(8))).rejects.toThrow();
  });

  it("keeps the queue entry, which carries the upload id, when R2 will not abort, so the sweep finishes the job", async () => {
    const { id, key } = await seedMedia({ kind: "video", state: "uploading", uploadId: "stuck-upload", object: null });
    const failing = wrapMedia((_target, property) => property === "resumeMultipartUpload" ? () => ({ abort: async () => { throw new Error("R2 down"); } }) : undefined);
    expect((await abort("member", id, failing)).status).toBe(204);
    expect(await mediaRow(id)).toBeNull();
    expect(await queued(key)).toMatchObject({ uploadId: "stuck-upload", projectId: ids.project });
  });

  it("leaves the queue entry alone when a sweep took a lease on it while the cancel's own delete was running", async () => {
    const { id, key } = await seedMedia({ kind: "video", state: "uploading", uploadId: null });
    const sweeping = wrapMedia((target, property) => property === "delete" ? async (keys: string | string[]) => {
      await database.DB.prepare("UPDATE embedded_media_cleanup SET claimed_until = ? WHERE storage_key = ?").bind(Date.now() + 600_000, key).run();
      return target.delete(keys);
    } : undefined);
    expect((await abort("member", id, sweeping)).status).toBe(204);
    expect(await mediaRow(id)).toBeNull();
    expect(await queued(key)).not.toBeNull();
  });

  it("treats an upload R2 no longer knows as already dead", async () => {
    const { id, key } = await seedMedia({ kind: "video", state: "uploading", uploadId: "unknown-upload" });
    const gone = wrapMedia((_target, property) => property === "resumeMultipartUpload" ? () => ({ abort: async () => { throw new Error("abortMultipartUpload: The specified multipart upload does not exist. (10024)"); } }) : undefined);
    expect((await abort("member", id, gone)).status).toBe(204);
    expect(await mediaRow(id)).toBeNull(); expect(await queued(key)).toBeNull(); expect(await database.MEDIA.head(key)).toBeNull();
  });

  it("discards a dev direct upload (no upload id) and a still-uploading image alike", async () => {
    for (const kind of ["video", "image"] as const) {
      const { id, key } = await seedMedia({ kind, state: "uploading" });
      expect((await abort("member", id)).status, kind).toBe(204);
      expect(await mediaRow(id), kind).toBeNull(); expect(await database.MEDIA.head(key), kind).toBeNull();
    }
  });

  it("deletes a completed but unattached video together with its poster, claiming it first", async () => {
    const { id, key } = await seedMedia({ kind: "video", state: "pending", poster: true });
    const posterKey = (await mediaRow(id))!.poster_key as string;
    expect((await abort("member", id)).status).toBe(204);
    expect(await mediaRow(id)).toBeNull(); expect(await database.MEDIA.head(key)).toBeNull(); expect(await database.MEDIA.head(posterKey)).toBeNull();
  });

  it("queues the keys when R2 refuses the delete of a completed video, and still drops the row", async () => {
    const { id, key } = await seedMedia({ kind: "video", state: "pending", poster: true });
    const posterKey = (await mediaRow(id))!.poster_key as string;
    const failing = wrapMedia((_target, property) => property === "delete" ? async () => { throw new Error("R2 down"); } : undefined);
    expect((await abort("member", id, failing)).status).toBe(204);
    expect(await mediaRow(id)).toBeNull();
    expect(await queued(key)).not.toBeNull(); expect(await queued(posterKey)).not.toBeNull();
  });

  it("is the uploader's alone, refuses an attached or detached video, and answers 404 for a missing row", async () => {
    const { id, key } = await seedMedia({ kind: "video", state: "uploading" });
    expect((await abort("admin", id)).status).toBe(404);
    expect((await abort("external", id)).status).toBe(404);
    expect((await abort("other", id)).status).toBe(403);
    expect((await abort("member", id, baseEnv, ids.otherProject)).status).toBe(403);
    expect(await mediaRow(id)).not.toBeNull(); expect(await database.MEDIA.head(key)).not.toBeNull();
    for (const state of ["attached", "detached"] as const) {
      const other = await seedMedia({ kind: "video", state });
      expect((await abort("member", other.id)).status, state).toBe(409);
      expect(await mediaRow(other.id), state).not.toBeNull(); expect(await database.MEDIA.head(other.key), state).not.toBeNull();
    }
    expect((await abort("member", crypto.randomUUID())).status).toBe(404);
    expect((await abort("member", "not-a-uuid")).status).toBe(400);
  });

  it("is repeatable: a second abort finds nothing", async () => {
    const { id } = await seedMedia({ kind: "video", state: "uploading" });
    expect((await abort("member", id)).status).toBe(204);
    expect((await abort("member", id)).status).toBe(404);
  });
});

describe("GET /media/embedded/:mediaId Range (#494)", () => {
  const size = 4096; const bytes = mp4Bytes(size);
  const slice = (from: number, to: number) => bytes.slice(from, to + 1);

  it("tells a full response it can be ranged, and sends the whole body with its length and strong ETag", async () => {
    const { id } = await seedMedia({ kind: "video", state: "attached", bytes: size, object: bytes });
    const response = await get(`/media/embedded/${id}`, "member");
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes"); expect(response.headers.get("content-length")).toBe(String(size));
    expect(response.headers.get("content-type")).toBe("video/mp4"); expect(response.headers.get("etag")).toMatch(/^"/);
    expect(await consume(response)).toEqual(bytes);
  });

  it("serves a QuickTime file as video/quicktime", async () => {
    const { id } = await seedMedia({ kind: "video", state: "attached", contentType: "video/quicktime", bytes: size, object: mp4Bytes(size, "qt  ") });
    const response = await get(`/media/embedded/${id}`, "member");
    expect(response.headers.get("content-type")).toBe("video/quicktime"); await consume(response);
  });

  it("answers a range with 206, the exact bytes, Content-Range and the exact length, for a-b, a- and -n", async () => {
    const { id } = await seedMedia({ kind: "video", state: "attached", bytes: size, object: bytes });
    const cases: Array<[string, number, number]> = [["bytes=0-99", 0, 99], ["bytes=100-", 100, size - 1], ["bytes=-50", size - 50, size - 1], ["bytes=4000-9999", 4000, size - 1], ["bytes=0-", 0, size - 1], ["bytes=-99999", 0, size - 1], ["bytes=7-7", 7, 7]];
    for (const [range, from, to] of cases) {
      const response = await get(`/media/embedded/${id}`, "member", { range });
      expect(response.status, range).toBe(206);
      expect(response.headers.get("content-range"), range).toBe(`bytes ${from}-${to}/${size}`);
      expect(response.headers.get("content-length"), range).toBe(String(to - from + 1));
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(await consume(response), range).toEqual(slice(from, to));
    }
  });

  it("keeps the type, nosniff, the sandboxing CSP, the private cache and the ETag on a 206", async () => {
    const { id } = await seedMedia({ kind: "video", state: "attached", bytes: size, object: bytes });
    const full = await get(`/media/embedded/${id}`, "member"); await consume(full);
    const response = await get(`/media/embedded/${id}`, "member", { range: "bytes=0-9" });
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300"); expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("etag")).toBe(full.headers.get("etag"));
    await consume(response);
  });

  it("answers an unsatisfiable range with 416, Content-Range */size and no-store, and no body", async () => {
    const { id } = await seedMedia({ kind: "video", state: "attached", bytes: size, object: bytes });
    for (const range of [`bytes=${size}-`, `bytes=${size + 100}-${size + 200}`, "bytes=-0"]) {
      const response = await get(`/media/embedded/${id}`, "member", { range });
      expect(response.status, range).toBe(416);
      expect(response.headers.get("content-range"), range).toBe(`bytes */${size}`);
      expect(response.headers.get("cache-control"), range).toBe("private, no-store");
      expect((await consume(response)).byteLength, range).toBe(0);
    }
  });

  it("ignores a range it cannot serve and sends the whole body: several ranges, a malformed header, another unit, last before first", async () => {
    const { id } = await seedMedia({ kind: "video", state: "attached", bytes: size, object: bytes });
    for (const range of ["bytes=0-1,5-6", "bytes=abc", "items=0-1", "bytes=9-3", "bytes=", "garbage"]) {
      const response = await get(`/media/embedded/${id}`, "member", { range });
      expect(response.status, range).toBe(200); expect(response.headers.get("content-range"), range).toBeNull();
      expect((await consume(response)).byteLength, range).toBe(size);
    }
  });

  it("honours If-Range only on an exact strong ETag match", async () => {
    const { id } = await seedMedia({ kind: "video", state: "attached", bytes: size, object: bytes });
    const full = await get(`/media/embedded/${id}`, "member"); await consume(full); const etag = full.headers.get("etag")!;
    const same = await get(`/media/embedded/${id}`, "member", { range: "bytes=0-9", "if-range": etag });
    expect(same.status).toBe(206); expect((await consume(same)).byteLength).toBe(10);
    for (const ifRange of ['"not-the-etag"', `W/${etag}`, "Wed, 21 Oct 2015 07:28:00 GMT"]) {
      const response = await get(`/media/embedded/${id}`, "member", { range: "bytes=0-9", "if-range": ifRange });
      expect(response.status, ifRange).toBe(200); expect((await consume(response)).byteLength, ifRange).toBe(size);
    }
  });

  it("evaluates If-Range before the range is checked: a stale validator with an unsatisfiable range is the whole body, not a 416", async () => {
    const { id } = await seedMedia({ kind: "video", state: "attached", bytes: size, object: bytes });
    const full = await get(`/media/embedded/${id}`, "member"); await consume(full); const etag = full.headers.get("etag")!;
    for (const ifRange of ['"stale"', `W/${etag}`, "Wed, 21 Oct 2015 07:28:00 GMT"]) {
      const response = await get(`/media/embedded/${id}`, "member", { range: `bytes=${size + 10}-`, "if-range": ifRange });
      expect(response.status, ifRange).toBe(200); expect((await consume(response)).byteLength, ifRange).toBe(size);
    }
    const fresh = await get(`/media/embedded/${id}`, "member", { range: `bytes=${size + 10}-`, "if-range": etag });
    expect(fresh.status).toBe(416); await consume(fresh);
  });

  it("applies the same access rules to a ranged read: a refused viewer never gets a 206, an uploader sees a pending video, an assigned External editor an attached one", async () => {
    const attached = await seedMedia({ kind: "video", state: "attached", bytes: size, object: bytes });
    const pending = await seedMedia({ kind: "video", state: "pending", bytes: size, object: bytes });
    const range = { range: "bytes=0-9" };
    expect((await get(`/media/embedded/${attached.id}`, "other", range)).status).toBe(403);
    expect((await get(`/media/embedded/${attached.id}`, "externalOutsider", range)).status).toBe(404);
    for (const who of ["member", "admin", "external"] as const) { const response = await get(`/media/embedded/${attached.id}`, who, range); expect(response.status, who).toBe(206); await consume(response); }
    for (const who of ["admin", "external", "other"] as const) expect((await get(`/media/embedded/${pending.id}`, who, range)).status, who).toBe(404);
    const own = await get(`/media/embedded/${pending.id}`, "member", range); expect(own.status).toBe(206); await consume(own);
    const uploading = await seedMedia({ kind: "video", state: "uploading" });
    expect((await get(`/media/embedded/${uploading.id}`, "member", range)).status).toBe(404);
    expect((await get(`/media/embedded/${crypto.randomUUID()}`, "member", range)).status).toBe(404);
  });

  it("answers 404, not a range error, when the object is gone", async () => {
    const { id } = await seedMedia({ kind: "video", state: "attached", object: null });
    expect((await get(`/media/embedded/${id}`, "member", { range: "bytes=0-9" })).status).toBe(404);
  });

  it("offers the file as a download with ?download=1, named by its type", async () => {
    const mp4 = await seedMedia({ kind: "video", state: "attached", bytes: size, object: bytes });
    const mov = await seedMedia({ kind: "video", state: "attached", contentType: "video/quicktime", bytes: size, object: mp4Bytes(size, "qt  ") });
    const a = await get(`/media/embedded/${mp4.id}?download=1`, "member"); expect(a.status).toBe(200);
    expect(a.headers.get("content-disposition")).toBe('attachment; filename="video.mp4"'); await consume(a);
    const b = await get(`/media/embedded/${mov.id}?download=1`, "member");
    expect(b.headers.get("content-disposition")).toBe('attachment; filename="video.mov"'); await consume(b);
    const plain = await get(`/media/embedded/${mp4.id}`, "member"); expect(plain.headers.get("content-disposition")).toBeNull(); await consume(plain);
    expect((await get(`/media/embedded/${mp4.id}?download=1`, "other")).status).toBe(403);
  });

  it("still serves an image, which is rangeable too", async () => {
    const { id } = await seedMedia({ kind: "image", state: "attached", object: pngBytes(64) });
    const response = await get(`/media/embedded/${id}`, "member", { range: "bytes=0-7" });
    expect(response.status).toBe(206); expect(response.headers.get("content-type")).toBe("image/png"); expect((await consume(response)).byteLength).toBe(8);
  });
});

describe("a comment with a video (#494)", () => {
  const post = (who: "admin" | "member" | "external", content: unknown) => request(`/api/projects/${ids.project}/comments`, who, "POST", { content });
  const created = async (response: Response) => { expect(response.status).toBe(201); return (await response.json()) as { id: string; body: string; content: { content: Array<{ type: string; attrs?: { mediaId: string } }> } }; };
  const video = async (state: "pending" | "attached" | "detached" = "pending", extra: Parameters<typeof seedMedia>[0] = {}) => (await seedMedia({ kind: "video", state, ...extra })).id;
  const image = async (state: "pending" | "attached" | "detached" = "pending") => (await seedMedia({ kind: "image", state })).id;

  it("attaches the author's pending video, stores [video] in the body, and the Project can then play it", async () => {
    const id = await video("pending", { poster: true });
    const comment = await created(await post("member", videoDoc(id)));
    expect(comment.body).toBe("Look\n[video]");
    expect(comment.content.content.filter((node) => node.type === "video").map((node) => node.attrs?.mediaId)).toEqual([id]);
    expect(await mediaRow(id)).toMatchObject({ state: "attached", owner_kind: "project_comment", owner_id: comment.id });
    for (const who of ["admin", "external"] as const) { const response = await get(`/media/embedded/${id}`, who, { range: "bytes=0-9" }); expect(response.status, who).toBe(206); await consume(response); }
  });

  it("accepts a video-only comment and an External editor's own video", async () => {
    const only = await created(await post("member", { type: "doc", content: [{ type: "video", attrs: { mediaId: await video() } }] }));
    expect(only.body).toBe("[video]");
    const id = await video("pending", { uploader: ids.external });
    await created(await post("external", videoDoc(id)));
  });

  it("holds images and videos to one shared ten per post", async () => {
    const mixed = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Ten" }] }, ...await Promise.all(Array.from({ length: 10 }, async (_, index) => index % 2 ? { type: "video", attrs: { mediaId: await video() } } : { type: "image", attrs: { mediaId: await image() } }))] };
    expect((await created(await post("member", mixed))).content.content.filter((node) => node.type !== "paragraph")).toHaveLength(10);
    const eleven = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Eleven" }] }, ...await Promise.all(Array.from({ length: 11 }, async (_, index) => index % 2 ? { type: "video", attrs: { mediaId: await video() } } : { type: "image", attrs: { mediaId: await image() } }))] };
    const response = await post("member", eleven); expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_media" });
  });

  it("refuses a node whose kind is not the stored row's kind, in either direction", async () => {
    const asVideo = await image(); const asImage = await video();
    const before = await rowCount();
    for (const content of [videoDoc(asVideo), imageDoc(asImage)]) {
      const response = await post("member", content); expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_media" });
    }
    expect(await mediaRow(asVideo)).toMatchObject({ state: "pending", owner_id: null }); expect(await mediaRow(asImage)).toMatchObject({ state: "pending", owner_id: null });
    expect(await rowCount()).toBe(before);
  });

  it("refuses an owned image named by a video node on edit, and the batch itself refuses it too if the pre-check is bypassed", async () => {
    const id = await image();
    const comment = await created(await post("member", imageDoc(id)));
    const edit = await request(`/api/projects/${ids.project}/comments/${comment.id}`, "member", "PATCH", { content: videoDoc(id) });
    expect(edit.status).toBe(400);
    expect(await mediaRow(id)).toMatchObject({ state: "attached", owner_id: comment.id });
    const commentId = crypto.randomUUID(); const own = await image();
    await expect(createProjectComment(database.DB, { id: commentId, projectId: ids.project, authorId: ids.member, body: "[video]", contentJson: JSON.stringify(videoDoc(own)), mentions: [], wallClockMs: Date.now(), occurredAt: new Date(), media: { authorId: ids.member, ids: [own], videoIds: [own] } })).rejects.toBeInstanceOf(CommentMediaConflictError);
    expect(await mediaRow(own)).toMatchObject({ state: "pending", owner_id: null });
    const edited = await created(await post("member", imageDoc(await image())));
    const attachedImage = (await database.DB.prepare("SELECT id FROM embedded_media WHERE owner_id = ?").bind(edited.id).first<{ id: string }>())!.id;
    await expect(editProjectComment(database.DB, { projectId: ids.project, commentId: edited.id, actorId: ids.member, body: "[video]", contentJson: JSON.stringify(videoDoc(attachedImage)), removeMentionIds: [], addMentions: [], mentionIds: [], editedAt: new Date(), occurredAt: new Date(), media: { authorId: ids.member, ids: [attachedImage], videoIds: [attachedImage] } })).rejects.toBeInstanceOf(CommentMediaConflictError);
    expect(await mediaRow(attachedImage)).toMatchObject({ state: "attached", owner_id: edited.id });
  });

  it("detaches a video that is edited out, and deletes it and its poster when the comment is deleted", async () => {
    const id = await video("pending", { poster: true }); const posterKey = () => mediaRow(id).then((row) => row?.poster_key as string);
    const comment = await created(await post("member", videoDoc(id)));
    const key = (await mediaRow(id))!.original_key as string; const poster = await posterKey();
    const edited = await request(`/api/projects/${ids.project}/comments/${comment.id}`, "member", "PATCH", { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "No video" }] }] } });
    expect(edited.status).toBe(200);
    expect(await mediaRow(id)).toMatchObject({ state: "detached" });
    const again = await request(`/api/projects/${ids.project}/comments/${comment.id}`, "member", "PATCH", { content: videoDoc(id) });
    expect(again.status).toBe(200);
    expect(await mediaRow(id)).toMatchObject({ state: "attached" });
    expect((await request(`/api/projects/${ids.project}/comments/${comment.id}`, "member", "DELETE")).status).toBe(200);
    expect(await mediaRow(id)).toBeNull(); expect(await database.MEDIA.head(key)).toBeNull(); expect(await database.MEDIA.head(poster)).toBeNull();
    expect((await get(`/media/embedded/${id}`, "member")).status).toBe(404);
  });

  it("keeps video out of the Notice board", async () => {
    const id = await video();
    const response = await request("/api/notice-board/posts", "member", "POST", { content: videoDoc(id) });
    expect(response.status).toBe(400);
    expect(await mediaRow(id)).toMatchObject({ state: "pending", owner_id: null });
    const presignResponse = await appRequest(S3_ENV, "/api/notice-board/embedded-media", "member", "POST", { contentType: "video/mp4", bytes: 1000 });
    expect(presignResponse.status).toBe(400);
  });
});

describe("enqueueEmbeddedMediaCleanup and the lease (#494)", () => {
  it("re-queueing a key bumps queued_at and clears any lease on it, keeping its upload id", async () => {
    const key = `projects/${ids.project}/embedded-media/${crypto.randomUUID()}/original`;
    await database.DB.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at, attempts, claimed_until) VALUES (?, 'u-1', ?, 1000, 2, ?)").bind(key, ids.project, 9_999_999_999_999).run();
    await enqueueEmbeddedMediaCleanup(database.DB, [{ key, projectId: ids.project }], 1000);
    expect(await database.DB.prepare("SELECT upload_id AS uploadId, queued_at AS queuedAt, attempts, claimed_until AS claimedUntil FROM embedded_media_cleanup WHERE storage_key = ?").bind(key).first()).toEqual({ uploadId: "u-1", queuedAt: 1001, attempts: 2, claimedUntil: null });
  });
});
