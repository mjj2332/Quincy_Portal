import { createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateEmbeddedDisplay } from "@quincy/db";
import { externalEmbeddedMediaCompleteSchema, externalEmbeddedMediaPresignSchema, externalEmbeddedMediaRenditionSchema, externalEmbeddedMediaSettingsSchema } from "@quincy/shared";
import { createAuth } from "../src/auth";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, database, displayJpeg, extendedFtypBytes, heicBytes, ids, imageDoc, jpegBytes, mediaRow, mp4Bytes, noticeMediaKey, request, seedFixture, seedMedia, tokens, type Who } from "./embedded-media-support";

/** HEIC images in Embedded media (#495), server half: the gate, the upload, the display copy, serving, the attach gate, retry, deletion. */
const S3_ENV: Env = { ...baseEnv, R2_ACCOUNT_ID: "acct", R2_S3_ACCESS_KEY_ID: "key", R2_S3_SECRET_ACCESS_KEY: "secret" };
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const sends: unknown[] = [];
const withQueue = (environment: Env): Env => ({ ...environment, RENDITION_QUEUE: { send: async (message: unknown) => { sends.push(message); } } as unknown as Env["RENDITION_QUEUE"] });
const QUEUE_ENV = withQueue(baseEnv);

async function call(environment: Env, path: string, who: Who, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown, headers: Record<string, string> = {}) {
  const context = await createAuth(environment).$context;
  const cookieValue = `${context.authCookies.sessionToken.name}=${tokens[who]}.${await makeSignature(tokens[who], authSecret)}`;
  const init: RequestInit = { method, headers: { cookie: cookieValue, origin: environment.APP_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
  return app.fetch(new Request(`https://portal.test${path}`, init), environment, createExecutionContext());
}
const projectMedia = (projectId: string = ids.project) => `/api/projects/${projectId}/embedded-media`;
const NOTICE_MEDIA = "/api/notice-board/embedded-media";
const setFlag = (enabled: boolean) => database.DB.prepare("UPDATE feature_flags SET enabled = ?, updated_by = NULL WHERE key = 'embedded_heic_uploads'").bind(enabled ? 1 : 0).run();
const queued = async (key: string) => database.DB.prepare("SELECT storage_key FROM embedded_media_cleanup WHERE storage_key = ?").bind(key).first();
const cleanupCount = async () => (await database.DB.prepare("SELECT count(*) AS n FROM embedded_media_cleanup").first<{ n: number }>())!.n;
const jpegFetch = (jpeg: Uint8Array = displayJpeg(), headers: Record<string, string> = { "content-type": "image/jpeg", "cf-resized": "internal=ok" }, status = 200) => vi.fn(async () => new Response(status === 200 ? jpeg : "nope", { status, headers }));
/** The generation a queue message for this row carries: its `rendition_requested_at`. */
const generationOf = async (id: string) => ((await mediaRow(id))?.rendition_requested_at ?? 0) as number;
const convert = async (id: string, fetchImpl: typeof fetch = jpegFetch() as unknown as typeof fetch, extra: Partial<Parameters<typeof generateEmbeddedDisplay>[2]> = {}) =>
  generateEmbeddedDisplay({ DB: database.DB, MEDIA: database.MEDIA }, id, { fetch: fetchImpl, transformUrl: async (key) => `https://transform.test/${key}`, generation: await generationOf(id), ...extra });
const heicRow = (extra: Parameters<typeof seedMedia>[0] = {}) => seedMedia({ contentType: "image/heic", object: heicBytes(), bytes: 4096, renditionStatus: "pending", ...extra });
const readyHeic = (extra: Parameters<typeof seedMedia>[0] = {}) => seedMedia({ contentType: "image/heic", object: heicBytes(), bytes: 4096, renditionStatus: "ready", display: displayJpeg(), ...extra });

function stubS3() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.method === "POST" && req.url.includes("?uploads")) return new Response("<InitiateMultipartUploadResult><UploadId>s3-upload-1</UploadId></InitiateMultipartUploadResult>");
    return new Response("unexpected", { status: 500 });
  });
}

beforeAll(async () => { await seedFixture(); });
beforeEach(() => { sends.length = 0; });
afterEach(async () => { vi.unstubAllGlobals(); await setFlag(false); });

describe("the HEIC gate on the presign (#495)", () => {
  it("lets an Admin reserve a pending HEIC row in the discussion, the whiteboard and the Notice board while the flag is off", async () => {
    stubS3();
    for (const [path, body] of [[projectMedia(), { contentType: "image/heic", bytes: 4096 }], [projectMedia(), { contentType: "image/heif", bytes: 4096, owner: "whiteboard" }], [NOTICE_MEDIA, { contentType: "image/heic", bytes: 4096 }]] as const) {
      const response = await call(S3_ENV, path, "admin", "POST", body);
      expect(response.status, path).toBe(200);
      const parsed = externalEmbeddedMediaPresignSchema.parse(await response.json());
      expect(await mediaRow(parsed.mediaId)).toMatchObject({ kind: "image", content_type: body.contentType, state: "uploading", rendition_status: "pending", display_key: null });
    }
  });

  it("refuses staff and External editors with 403 heic_not_enabled while the flag is off, and lets them in once it is on", async () => {
    stubS3(); await setFlag(false);
    for (const [who, path] of [["member", projectMedia()], ["external", projectMedia()], ["member", NOTICE_MEDIA], ["photographer", NOTICE_MEDIA]] as const) {
      const response = await call(S3_ENV, path, who, "POST", { contentType: "image/heic", bytes: 100 });
      expect(response.status, `${who} ${path}`).toBe(403); expect(await response.json()).toMatchObject({ code: "heic_not_enabled" });
    }
    await setFlag(true);
    for (const [who, path] of [["member", projectMedia()], ["external", projectMedia()], ["member", NOTICE_MEDIA]] as const) expect((await call(S3_ENV, path, who, "POST", { contentType: "image/heic", bytes: 100 })).status, `${who} ${path}`).toBe(200);
  });

  it("answers 503 heic_unavailable when renditions are off, for an Admin too, and leaves no row", async () => {
    stubS3(); const before = (await database.DB.prepare("SELECT count(*) AS n FROM embedded_media").first<{ n: number }>())!.n;
    for (const path of [projectMedia(), NOTICE_MEDIA]) {
      const response = await call({ ...S3_ENV, RENDITIONS_ENABLED: false }, path, "admin", "POST", { contentType: "image/heic", bytes: 100 });
      expect(response.status, path).toBe(503); expect(await response.json()).toMatchObject({ code: "heic_unavailable" });
    }
    expect((await database.DB.prepare("SELECT count(*) AS n FROM embedded_media").first<{ n: number }>())!.n).toBe(before);
  });

  it("does not treat an Admin impersonating staff as an Admin", async () => {
    stubS3();
    await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'user_impersonation'").run();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, impersonated_by, created_at, updated_at) VALUES ('heic-imp-session', ?, 'heic-imp-token', ?, ?, ?, ?)").bind(now + 3_600_000, ids.member, ids.admin, now, now).run();
    const context = await createAuth(S3_ENV).$context;
    const cookieValue = `${context.authCookies.sessionToken.name}=heic-imp-token.${await makeSignature("heic-imp-token", authSecret)}`;
    const response = await app.fetch(new Request(`https://portal.test${projectMedia()}`, { method: "POST", headers: { cookie: cookieValue, origin: S3_ENV.APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ contentType: "image/heic", bytes: 100 }) }), S3_ENV, createExecutionContext());
    expect(response.status).toBe(403);
  });

  it("keeps JPEG, PNG, WebP and video presigns exactly as they were, and still caps a HEIC at 25 MiB", async () => {
    stubS3();
    for (const contentType of ["image/jpeg", "image/png", "image/webp", "video/mp4"]) {
      const response = await call(S3_ENV, projectMedia(), "member", "POST", { contentType, bytes: 100 });
      expect(response.status, contentType).toBe(200);
      expect(await mediaRow(externalEmbeddedMediaPresignSchema.parse(await response.json()).mediaId)).toMatchObject({ rendition_status: "not_required" });
    }
    expect((await call(S3_ENV, projectMedia(), "admin", "POST", { contentType: "image/heic", bytes: 26_214_401 })).status).toBe(400);
    expect((await call(S3_ENV, projectMedia(), "admin", "POST", { contentType: "image/heic", bytes: 26_214_400 })).status).toBe(200);
    expect((await call(S3_ENV, projectMedia(), "admin", "POST", { contentType: "image/heic-sequence", bytes: 100 })).status).toBe(400);
  });
});

describe("completing a HEIC upload (#495)", () => {
  const complete = (who: Who, id: string, environment: Env = QUEUE_ENV, projectId: string = ids.project) => call(environment, `${projectMedia(projectId)}/${id}/complete`, who, "POST", {});

  it("accepts a HEIC whichever of heic or heif was declared, answers rendition pending and queues exactly one embedded_display message, even when completed twice", async () => {
    for (const contentType of ["image/heic", "image/heif"]) {
      const { id } = await heicRow({ state: "uploading", contentType, uploader: ids.admin });
      const response = await complete("admin", id);
      expect(response.status, contentType).toBe(200);
      expect(externalEmbeddedMediaCompleteSchema.parse(await response.json())).toEqual({ mediaId: id, state: "pending", rendition: "pending" });
      expect(await mediaRow(id)).toMatchObject({ state: "pending", rendition_status: "pending" });
      expect((await mediaRow(id))!.rendition_requested_at).toEqual(expect.any(Number));
      expect(sends.filter((message) => (message as { mediaId: string }).mediaId === id)).toEqual([{ type: "embedded_display", mediaId: id, generation: (await mediaRow(id))!.rendition_requested_at }]);
      const again = await complete("admin", id); expect(again.status).toBe(200);
      expect(externalEmbeddedMediaCompleteSchema.parse(await again.json()).rendition).toBe("pending");
      expect(sends.filter((message) => (message as { mediaId: string }).mediaId === id)).toHaveLength(1);
    }
  });

  it("never sends a message for a PNG and leaves its response unchanged", async () => {
    const { id } = await seedMedia({ state: "uploading", uploader: ids.admin });
    const response = await complete("admin", id);
    expect(externalEmbeddedMediaCompleteSchema.parse(await response.json())).toEqual({ mediaId: id, state: "pending" });
    expect(sends).toEqual([]);
  });

  it("rejects a JPEG declared as HEIC, deleting the object and the row", async () => {
    const { id, key } = await heicRow({ state: "uploading", uploader: ids.admin, object: jpegBytes(4096) });
    const response = await complete("admin", id);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "media_rejected" });
    expect(await mediaRow(id)).toBeNull(); expect(await database.MEDIA.head(key)).toBeNull(); expect(sends).toEqual([]);
  });

  it("rejects HEIC bytes declared as a JPEG and as an MP4 video", async () => {
    for (const [kind, contentType] of [["image", "image/jpeg"], ["video", "video/mp4"]] as const) {
      const { id, key } = await seedMedia({ state: "uploading", kind, contentType, object: heicBytes(), bytes: 4096 });
      const response = await complete("member", id);
      expect(response.status, contentType).toBe(400); expect(await response.json()).toMatchObject({ code: "media_rejected" });
      expect(await mediaRow(id)).toBeNull(); expect(await database.MEDIA.head(key)).toBeNull();
    }
  });

  it("rejects a HEIC behind an extended-size ftyp declared as an MP4 video, and never serves it as an original (Sol P1-1)", async () => {
    const { id, key } = await seedMedia({ state: "uploading", kind: "video", contentType: "video/mp4", object: extendedFtypBytes(["heic", "mif1", "heic"]), bytes: 4096 });
    const response = await complete("member", id);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "media_rejected" });
    expect(await mediaRow(id)).toBeNull(); expect(await database.MEDIA.head(key)).toBeNull();
  });

  it("rejects a 68-byte extended ftyp declared as MP4 whose heic brand sits past the first 64 bytes, and never serves it (Sol r2 P1)", async () => {
    const { id, key } = await seedMedia({ state: "uploading", kind: "video", contentType: "video/mp4", object: extendedFtypBytes(["isom", ...Array<string>(10).fill("mp41"), "heic"]), bytes: 4096 });
    const response = await complete("member", id);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "media_rejected" });
    expect(await mediaRow(id)).toBeNull(); expect(await database.MEDIA.head(key)).toBeNull();
  });

  it("still accepts a real extended-size MP4 and a real QuickTime file (Sol P1-1)", async () => {
    for (const [contentType, brands] of [["video/mp4", ["isom", "iso2", "mp41"]], ["video/quicktime", ["qt  "]]] as const) {
      const { id } = await seedMedia({ state: "uploading", kind: "video", contentType, object: extendedFtypBytes([...brands]), bytes: 4096 });
      expect((await complete("member", id)).status, contentType).toBe(200);
    }
  });

  it("still accepts a real MP4 whose compatible brands are video brands", async () => {
    const { id } = await seedMedia({ state: "uploading", kind: "video", contentType: "video/mp4", object: mp4Bytes(4096, "isom"), bytes: 4096 });
    expect((await complete("member", id)).status).toBe(200);
  });

  it("checks the gate again at complete: a flag turned off in between, or renditions switched off, stops it", async () => {
    const first = await heicRow({ state: "uploading" }); await setFlag(false);
    const refused = await complete("member", first.id);
    expect(refused.status).toBe(403); expect(await refused.json()).toMatchObject({ code: "heic_not_enabled" });
    expect(await mediaRow(first.id)).toMatchObject({ state: "uploading" });
    const second = await heicRow({ state: "uploading", uploader: ids.admin });
    const off = await complete("admin", second.id, withQueue({ ...baseEnv, RENDITIONS_ENABLED: false }));
    expect(off.status).toBe(503); expect(await off.json()).toMatchObject({ code: "heic_unavailable" });
    expect(sends).toEqual([]);
  });

  it("completes a Notice board HEIC the same way", async () => {
    const { id } = await heicRow({ ownerKind: "notice_post", state: "uploading", uploader: ids.admin });
    const response = await call(QUEUE_ENV, `${NOTICE_MEDIA}/${id}/complete`, "admin", "POST", {});
    expect(response.status).toBe(200); expect(externalEmbeddedMediaCompleteSchema.parse(await response.json()).rendition).toBe("pending");
    expect(sends).toEqual([{ type: "embedded_display", mediaId: id, generation: (await mediaRow(id))!.rendition_requested_at }]);
    await setFlag(false);
    const member = await heicRow({ ownerKind: "notice_post", state: "uploading" });
    expect((await call(QUEUE_ENV, `${NOTICE_MEDIA}/${member.id}/complete`, "member", "POST", {})).status).toBe(403);
  });
});

describe("serving a HEIC image never returns the HEIC (#495)", () => {
  const get = (who: Who, id: string, headers: Record<string, string> = {}) => call(baseEnv, `/media/embedded/${id}`, who, "GET", undefined, headers);

  it("end to end: complete, 409 while pending, convert, then the JPEG at 200 and 206, and the HEIC bytes are never returned", async () => {
    const { id } = await heicRow({ state: "uploading", uploader: ids.admin });
    expect((await call(QUEUE_ENV, `${projectMedia()}/${id}/complete`, "admin", "POST", {})).status).toBe(200);
    const pending = await get("admin", id);
    expect(pending.status).toBe(409); expect(await pending.json()).toEqual({ error: "This image is still being prepared", code: "rendition_pending" });
    expect(pending.headers.get("retry-after")).toBe("5"); expect(pending.headers.get("cache-control")).toContain("no-store");

    const jpeg = displayJpeg({ width: 4096, height: 3072 });
    const fetchStub = jpegFetch(jpeg);
    expect(await convert(id, fetchStub as unknown as typeof fetch)).toBe("ready");
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect((fetchStub.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ accept: "image/jpeg" });
    const row = (await mediaRow(id))!;
    expect(row).toMatchObject({ rendition_status: "ready", display_content_type: "image/jpeg", display_bytes: jpeg.byteLength, display_width: 4096, display_height: 3072, rendition_lease_until: null, rendition_error: null });
    expect(row.display_key).toMatch(new RegExp(`^projects/${ids.project}/embedded-media/${id}/display-[0-9a-f-]+\\.jpg$`));
    expect(await database.MEDIA.head(row.display_key as string)).not.toBeNull();
    expect(await queued(row.display_key as string)).toBeNull();

    const ready = await get("admin", id);
    expect(ready.status).toBe(200); expect(ready.headers.get("content-type")).toBe("image/jpeg");
    const served = new Uint8Array(await ready.arrayBuffer());
    expect([...served]).toEqual([...jpeg]);
    expect([...served.slice(4, 8)]).not.toEqual([0x66, 0x74, 0x79, 0x70]);
    const ranged = await get("admin", id, { range: "bytes=0-9" });
    expect(ranged.status).toBe(206); expect([...new Uint8Array(await ranged.arrayBuffer())]).toEqual([...jpeg.slice(0, 10)]);
    expect(ranged.headers.get("content-range")).toBe(`bytes 0-9/${jpeg.byteLength}`);
    expect((await get("admin", id, { range: "bytes=999999-" })).status).toBe(416);
  });

  it("serves a failed row as a final 404 and a HEIC row that somehow says not_required as 404 too", async () => {
    const failed = await heicRow({ state: "pending", renditionStatus: "failed", uploader: ids.admin });
    const response = await get("admin", failed.id);
    expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ code: "rendition_failed" });
    const odd = await seedMedia({ state: "pending", uploader: ids.admin, contentType: "image/heic", object: heicBytes(), renditionStatus: "not_required" });
    expect((await get("admin", odd.id)).status).toBe(404);
  });

  it("keeps the access rules: a pending HEIC is its uploader's, an attached one follows its post", async () => {
    const pending = await heicRow({ state: "pending", uploader: ids.member });
    expect((await get("member", pending.id)).status).toBe(409);
    for (const who of ["admin", "other", "external"] as const) expect((await get(who, pending.id)).status, who).toBe(404);
    const attached = await readyHeic({ state: "attached" });
    expect((await get("admin", attached.id)).status).toBe(200); expect((await get("external", attached.id)).status).toBe(200); expect((await get("other", attached.id)).status).toBe(403);
  });

  it("serves a whiteboard HEIC as 409 until it is ready, then as the JPEG, to anyone who collaborates on the Project", async () => {
    const { id } = await heicRow({ ownerKind: "whiteboard", state: "pending", uploader: ids.member });
    expect((await get("member", id)).status).toBe(409); expect((await get("external", id)).status).toBe(409); expect((await get("other", id)).status).toBe(403);
    expect(await convert(id)).toBe("ready");
    const response = await get("external", id);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/jpeg");
  });
});

describe("the display copy conversion (#495)", () => {
  it("is a no-op for a duplicate, a ready, a failed, a leased and an unknown row, and never calls the transformation", async () => {
    const stub = jpegFetch();
    const ready = await readyHeic({ state: "pending" }); const failed = await heicRow({ renditionStatus: "failed" }); const leased = await heicRow();
    await database.DB.prepare("UPDATE embedded_media SET rendition_lease_until = ? WHERE id = ?").bind(Date.now() + 60_000, leased.id).run();
    for (const id of [ready.id, failed.id, leased.id, crypto.randomUUID()]) expect(await convert(id, stub as unknown as typeof fetch)).toBe("noop");
    expect(stub).not.toHaveBeenCalled();
    const { id } = await heicRow();
    expect(await convert(id, stub as unknown as typeof fetch)).toBe("ready");
    expect(await convert(id, stub as unknown as typeof fetch)).toBe("noop");
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("fails permanently, keeping no object, when the output is not a JPEG, still carries EXIF or XMP, is too large, or lacks cf-resized internal=ok", async () => {
    const cases: Array<[string, typeof fetch]> = [
      ["exif", jpegFetch(displayJpeg({ exif: true })) as unknown as typeof fetch],
      ["xmp", jpegFetch(displayJpeg({ xmp: true })) as unknown as typeof fetch],
      ["oversize", jpegFetch(displayJpeg({ width: 4097, height: 100 })) as unknown as typeof fetch],
      ["not a jpeg", jpegFetch(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])) as unknown as typeof fetch],
      ["heic passed through", jpegFetch(heicBytes(256), { "content-type": "image/heic", "cf-resized": "internal=ok" }) as unknown as typeof fetch],
      ["no cf-resized", jpegFetch(displayJpeg(), { "content-type": "image/jpeg" }) as unknown as typeof fetch],
      ["decode error", jpegFetch(displayJpeg(), { "content-type": "image/jpeg", "cf-resized": "err=9520" }) as unknown as typeof fetch],
      ["4xx", jpegFetch(displayJpeg(), { "content-type": "text/plain", "cf-resized": "err=9520" }, 415) as unknown as typeof fetch],
    ];
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [name, fetchImpl] of cases) {
      const { id } = await heicRow(); const before = await cleanupCount();
      expect(await convert(id, fetchImpl), name).toBe("failed");
      expect(await mediaRow(id), name).toMatchObject({ rendition_status: "failed", display_key: null, rendition_lease_until: null });
      expect((await mediaRow(id))!.rendition_error, name).toEqual(expect.any(String));
      expect(await cleanupCount(), name).toBe(before);
    }
    error.mockRestore();
  });

  it("names why: an EXIF leftover is recorded as such, so the GPS strip is a check", async () => {
    const { id } = await heicRow(); const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await convert(id, jpegFetch(displayJpeg({ exif: true })) as unknown as typeof fetch);
    expect((await mediaRow(id))!.rendition_error).toContain("EXIF"); error.mockRestore();
  });

  it("releases the lease on a transient failure and throws, so the immediate redelivery can claim it again", async () => {
    for (const fetchImpl of [vi.fn(async () => { throw new Error("network"); }), jpegFetch(displayJpeg(), { "content-type": "text/plain" }, 503), jpegFetch(displayJpeg(), { "content-type": "text/html" }, 403), jpegFetch(displayJpeg(), { "content-type": "image/jpeg", "cf-resized": "err=9401" }, 400)]) {
      const { id } = await heicRow();
      await expect(convert(id, fetchImpl as unknown as typeof fetch)).rejects.toThrow();
      expect(await mediaRow(id)).toMatchObject({ rendition_status: "pending", rendition_lease_until: 0, rendition_attempts: 1 });
      expect(await convert(id, jpegFetch() as unknown as typeof fetch)).toBe("ready");
      expect(await mediaRow(id)).toMatchObject({ rendition_attempts: 2, rendition_status: "ready" });
    }
  });

  it("fails a row that has used its attempts, and leaves nothing leased", async () => {
    const { id } = await heicRow(); await database.DB.prepare("UPDATE embedded_media SET rendition_attempts = 4 WHERE id = ?").bind(id).run();
    const stub = jpegFetch();
    expect(await convert(id, stub as unknown as typeof fetch)).toBe("failed");
    expect(stub).not.toHaveBeenCalled();
    expect(await mediaRow(id)).toMatchObject({ rendition_status: "failed", rendition_error: "attempts", rendition_lease_until: null });
  });

  it("discards the copy and its queue entry when the row was swept or hard deleted mid conversion, and keeps the entry when R2 refuses the delete", async () => {
    const { id } = await heicRow({ state: "pending" });
    const deleting = vi.fn(async () => { await database.DB.prepare("DELETE FROM embedded_media WHERE id = ?").bind(id).run(); return new Response(displayJpeg(), { headers: { "content-type": "image/jpeg", "cf-resized": "internal=ok" } }); });
    const before = (await database.MEDIA.list({ prefix: `projects/${ids.project}/embedded-media/${id}/` })).objects.length;
    expect(await convert(id, deleting as unknown as typeof fetch)).toBe("lost");
    expect((await database.MEDIA.list({ prefix: `projects/${ids.project}/embedded-media/${id}/` })).objects.length).toBe(before); // only the original is left: the display copy was deleted
    expect(await database.DB.prepare("SELECT 1 FROM embedded_media_cleanup WHERE storage_key LIKE ?").bind(`%/${id}/display-%`).first()).toBeNull();

    const second = await heicRow({ state: "pending" });
    const deletingAgain = vi.fn(async () => { await database.DB.prepare("DELETE FROM embedded_media WHERE id = ?").bind(second.id).run(); return new Response(displayJpeg(), { headers: { "content-type": "image/jpeg", "cf-resized": "internal=ok" } }); });
    const refusing = { DB: database.DB, MEDIA: new Proxy(database.MEDIA, { get: (target, property) => { if (property === "delete") return async () => { throw new Error("R2 down"); }; const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; } }) as R2Bucket };
    expect(await generateEmbeddedDisplay(refusing, second.id, { fetch: deletingAgain as unknown as typeof fetch, transformUrl: async (key) => key, generation: await generationOf(second.id) })).toBe("lost");
    expect(await database.DB.prepare("SELECT storage_key FROM embedded_media_cleanup WHERE storage_key LIKE ?").bind(`%/${second.id}/display-%`).first()).not.toBeNull();
  });

  it("a drain claim that lands between the write and the adoption makes the adoption lose, and the copy is discarded", async () => {
    const { id } = await heicRow({ state: "pending" });
    const claimed = vi.fn(async () => { await database.DB.prepare("UPDATE embedded_media_cleanup SET claimed_until = ? WHERE storage_key LIKE ?").bind(Date.now() + 600_000, `%/${id}/display-%`).run(); return new Response(displayJpeg(), { headers: { "content-type": "image/jpeg", "cf-resized": "internal=ok" } }); });
    // The entry exists only after the fetch, so the claim has to run between the put and the batch: a MEDIA proxy does it.
    let lostTo = 0;
    const media = new Proxy(database.MEDIA, { get: (target, property) => {
      if (property === "put") return async (...args: Parameters<R2Bucket["put"]>) => { const result = await target.put(...args); await database.DB.prepare("UPDATE embedded_media_cleanup SET claimed_until = ? WHERE storage_key = ?").bind(Date.now() + 600_000, String(args[0])).run(); lostTo += 1; return result; };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) as R2Bucket;
    expect(await generateEmbeddedDisplay({ DB: database.DB, MEDIA: media }, id, { fetch: claimed as unknown as typeof fetch, transformUrl: async (key) => key, generation: await generationOf(id) })).toBe("lost");
    expect(lostTo).toBe(1);
    expect(await mediaRow(id)).toMatchObject({ rendition_status: "pending", display_key: null });
  });

  it("decides a thrown adoption from the row: an adopted copy stays and the call succeeds, a missed one is discarded and retried", async () => {
    const { id } = await heicRow({ state: "pending" });
    let batches = 0;
    const flaky = new Proxy(database.DB, { get: (target, property) => {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => { batches += 1; const result = await target.batch(statements); throw new Error("D1 ack lost"); void result; };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) as D1Database;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await generateEmbeddedDisplay({ DB: flaky, MEDIA: database.MEDIA }, id, { fetch: jpegFetch() as unknown as typeof fetch, transformUrl: async (key) => key, generation: await generationOf(id) })).toBe("ready");
    expect(batches).toBe(1); expect(await mediaRow(id)).toMatchObject({ rendition_status: "ready" });
    const second = await heicRow({ state: "pending" });
    const failing = new Proxy(database.DB, { get: (target, property) => {
      if (property === "batch") return async () => { throw new Error("D1 down"); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) as D1Database;
    await expect(generateEmbeddedDisplay({ DB: failing, MEDIA: database.MEDIA }, second.id, { fetch: jpegFetch() as unknown as typeof fetch, transformUrl: async (key) => key, generation: await generationOf(second.id) })).rejects.toThrow("D1 down");
    expect(await mediaRow(second.id)).toMatchObject({ rendition_status: "pending", display_key: null, rendition_lease_until: 0 });
    expect(await database.DB.prepare("SELECT 1 FROM embedded_media_cleanup WHERE storage_key LIKE ?").bind(`%/${second.id}/display-%`).first()).toBeNull();
    error.mockRestore();
  });

  it("fences the lifecycle writes on the requested time: a Retry while an old run is in flight makes the old run lose (Sol P2-4)", async () => {
    const { id } = await heicRow({ state: "pending" });
    const retried = vi.fn(async () => { await database.DB.prepare("UPDATE embedded_media SET rendition_requested_at = rendition_requested_at + 1000, rendition_attempts = 1, rendition_lease_until = ? WHERE id = ?").bind(Date.now() + 600_000, id).run(); return new Response(displayJpeg(), { headers: { "content-type": "image/jpeg", "cf-resized": "internal=ok" } }); });
    expect(await convert(id, retried as unknown as typeof fetch)).toBe("lost");
    expect(await mediaRow(id)).toMatchObject({ rendition_status: "pending", display_key: null });
    expect(await database.DB.prepare("SELECT 1 FROM embedded_media_cleanup WHERE storage_key LIKE ?").bind(`%/${id}/display-%`).first()).toBeNull();
  });

  it("refuses to claim a row for a message from an older generation (Sol P2-4)", async () => {
    const { id } = await heicRow({ state: "pending" }); const stub = jpegFetch();
    const requested = (await mediaRow(id))!.rendition_requested_at as number | null;
    expect(await convert(id, stub as unknown as typeof fetch, { generation: (requested ?? 0) - 1 })).toBe("noop");
    expect(stub).not.toHaveBeenCalled();
    expect(await mediaRow(id)).toMatchObject({ rendition_attempts: 0 });
  });

  it("never leaves an object without a cleanup entry when the R2 PUT commits and then throws (Sol P2-5)", async () => {
    const prefix = (id: string) => `projects/${ids.project}/embedded-media/${id}/display-`;
    const orphans = async (id: string) => {
      const objects = (await database.MEDIA.list({ prefix: prefix(id) })).objects;
      const missing: string[] = [];
      for (const object of objects) if (!await queued(object.key)) missing.push(object.key);
      return { objects: objects.length, missing };
    };
    const committing = (deleteFails: boolean) => new Proxy(database.MEDIA, { get: (target, property) => {
      if (property === "put") return async (...args: Parameters<R2Bucket["put"]>) => { await target.put(...args); throw new Error("ack lost"); };
      if (property === "delete" && deleteFails) return async () => { throw new Error("R2 down"); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) as R2Bucket;
    for (const deleteFails of [false, true]) {
      const { id } = await heicRow({ state: "pending" });
      await expect(generateEmbeddedDisplay({ DB: database.DB, MEDIA: committing(deleteFails) }, id, { fetch: jpegFetch() as unknown as typeof fetch, transformUrl: async (key) => key, generation: await generationOf(id) })).rejects.toThrow("could not be stored");
      expect(await orphans(id), `deleteFails=${deleteFails}`).toEqual({ objects: deleteFails ? 1 : 0, missing: [] });
      expect(await mediaRow(id)).toMatchObject({ rendition_status: "pending", display_key: null, rendition_lease_until: 0 });
    }
  });

  it("releases the lease when fail() hits a transient D1 error, on the permanent branch and on the attempt cap, so a redelivery can retry (Sol P2-6)", async () => {
    const failing = (inject: { on: boolean }) => new Proxy(database.DB, { get: (target, property) => {
      if (property === "prepare") return (sql: string) => { if (inject.on && sql.includes("rendition_status = 'failed'")) throw new Error("D1 transient"); return target.prepare(sql); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } }) as D1Database;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const branch of ["permanent", "attempt cap"] as const) {
      const { id } = await heicRow({ state: "pending" });
      if (branch === "attempt cap") await database.DB.prepare("UPDATE embedded_media SET rendition_attempts = 4 WHERE id = ?").bind(id).run();
      const inject = { on: true };
      const output = branch === "permanent" ? displayJpeg({ exif: true }) : displayJpeg();
      await expect(generateEmbeddedDisplay({ DB: failing(inject), MEDIA: database.MEDIA }, id, { fetch: jpegFetch(output) as unknown as typeof fetch, transformUrl: async (key) => key, generation: await generationOf(id) })).rejects.toThrow("D1 transient");
      expect(await mediaRow(id), branch).toMatchObject({ rendition_status: "pending", rendition_lease_until: 0 });
      inject.on = false;
      // The redelivery is not a no-op any more: it claims the row and settles it.
      expect(await convert(id, jpegFetch(output) as unknown as typeof fetch), branch).toBe("failed");
      expect(await mediaRow(id), branch).toMatchObject({ rendition_status: "failed" });
    }
    error.mockRestore();
  });

  it("puts a Notice board display copy under the Notice-board prefix", async () => {
    const { id } = await heicRow({ ownerKind: "notice_post", state: "pending", uploader: ids.member });
    expect(await convert(id)).toBe("ready");
    expect((await mediaRow(id))!.display_key).toMatch(new RegExp(`^notice-board/embedded-media/${id}/display-[0-9a-f-]+\\.jpg$`));
    expect(noticeMediaKey(id)).toBe((await mediaRow(id))!.original_key);
  });
});

describe("attaching a HEIC image (#495)", () => {
  const commentsPath = `/api/projects/${ids.project}/comments`;
  const postComment = (who: Who, ...mediaIds: string[]) => request(commentsPath, who, "POST", { content: imageDoc(...mediaIds) });
  const postNotice = (who: Who, ...mediaIds: string[]) => request("/api/notice-board/posts", who, "POST", { content: imageDoc(...mediaIds) });

  it("refuses a comment or a Notice post holding a pending or failed HEIC with a 400, and takes a ready one", async () => {
    for (const status of ["pending", "failed"] as const) {
      const c = await heicRow({ state: "pending", renditionStatus: status }); const n = await heicRow({ ownerKind: "notice_post", state: "pending", renditionStatus: status });
      expect((await postComment("member", c.id)).status, `comment ${status}`).toBe(400);
      expect((await postNotice("member", n.id)).status, `notice ${status}`).toBe(400);
      expect(await mediaRow(c.id)).toMatchObject({ state: "pending", owner_id: null }); expect(await mediaRow(n.id)).toMatchObject({ state: "pending", owner_id: null });
    }
    const c = await readyHeic({ state: "pending" }); const n = await readyHeic({ ownerKind: "notice_post", state: "pending" });
    expect((await postComment("member", c.id)).status).toBe(201); expect((await postNotice("member", n.id)).status).toBe(201);
    expect(await mediaRow(c.id)).toMatchObject({ state: "attached" }); expect(await mediaRow(n.id)).toMatchObject({ state: "attached" });
  });

  it("holds even when the preflight is bypassed: the batch itself refuses a processing HEIC", async () => {
    const { ownedMediaStatements } = await import("../src/lib/embedded-media");
    const pending = await heicRow({ state: "pending" });
    const owner = crypto.randomUUID(); const now = Date.now();
    const statements = ownedMediaStatements(database.DB, { ownerKind: "project_comment", ownerId: owner, projectId: ids.project, uploaderId: ids.member, ids: [pending.id], now, fence: { sql: "1 = 1", binds: [] }, guardId: crypto.randomUUID() });
    await expect(database.DB.batch(statements)).rejects.toThrow(/CHECK constraint failed/i);
    expect(await mediaRow(pending.id)).toMatchObject({ state: "pending", owner_id: null });
  });

  it("leaves an already attached HEIC alone when its post is edited", async () => {
    const ready = await readyHeic({ state: "pending" });
    const comment = await (await postComment("member", ready.id)).json() as { id: string };
    await database.DB.prepare("UPDATE embedded_media SET rendition_status = 'failed' WHERE id = ?").bind(ready.id).run();
    expect((await request(`${commentsPath}/${comment.id}`, "member", "PATCH", { content: imageDoc(ready.id) })).status).toBe(200);
    expect(await mediaRow(ready.id)).toMatchObject({ state: "attached", owner_id: comment.id });
  });
});

describe("the uploader's status and retry routes (#495)", () => {
  const statusPath = (id: string, projectId: string = ids.project) => `${projectMedia(projectId)}/${id}/rendition`;

  it("reports the status to the uploader only, in a body with no key or error text", async () => {
    const { id } = await heicRow({ state: "pending", uploader: ids.member });
    const response = await call(QUEUE_ENV, statusPath(id), "member", "GET");
    expect(response.status).toBe(200); expect(externalEmbeddedMediaRenditionSchema.parse(await response.json())).toEqual({ mediaId: id, status: "pending" });
    await database.DB.prepare("UPDATE embedded_media SET rendition_status = 'failed', rendition_error = 'secret reason' WHERE id = ?").bind(id).run();
    const failed = await call(QUEUE_ENV, statusPath(id), "member", "GET");
    expect(await failed.json()).toEqual({ mediaId: id, status: "failed" });
    for (const who of ["admin", "external"] as const) expect((await call(QUEUE_ENV, statusPath(id), who, "GET")).status, who).toBe(404);
    expect((await call(QUEUE_ENV, statusPath(id), "other", "GET")).status).toBe(403); expect((await call(QUEUE_ENV, statusPath(id), "externalOutsider", "GET")).status).toBe(404);
    expect((await call(QUEUE_ENV, statusPath(id, ids.otherProject), "member", "GET")).status).toBe(403);
    expect((await call(QUEUE_ENV, statusPath("not-a-uuid"), "member", "GET")).status).toBe(400);
    const uploading = await heicRow({ state: "uploading", uploader: ids.member });
    expect((await call(QUEUE_ENV, statusPath(uploading.id), "member", "GET")).status).toBe(404);
  });

  it("retries a failed row: back to pending with fresh attempts, one queued message, and a repeat sends nothing", async () => {
    const { id } = await heicRow({ state: "pending", uploader: ids.member, renditionStatus: "failed" });
    await database.DB.prepare("UPDATE embedded_media SET rendition_attempts = 4, rendition_error = 'dlq' WHERE id = ?").bind(id).run();
    const response = await call(QUEUE_ENV, `${statusPath(id)}/retry`, "member", "POST", {});
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ mediaId: id, status: "pending" });
    expect(await mediaRow(id)).toMatchObject({ rendition_status: "pending", rendition_attempts: 0, rendition_error: null, rendition_lease_until: null });
    expect(sends).toEqual([{ type: "embedded_display", mediaId: id, generation: (await mediaRow(id))!.rendition_requested_at }]);
    expect(sends[0]).toMatchObject({ generation: expect.any(Number) });
    expect((await call(QUEUE_ENV, `${statusPath(id)}/retry`, "member", "POST", {})).status).toBe(200);
    expect(sends).toHaveLength(1);
    expect(await convert(id)).toBe("ready");
    const ready = await call(QUEUE_ENV, `${statusPath(id)}/retry`, "member", "POST", {});
    expect(ready.status).toBe(409); expect(await ready.json()).toMatchObject({ code: "rendition_not_failed" });
    expect(sends).toHaveLength(1);
  });

  it("answers a non-uploader 404 on retry, and 503 while renditions are off", async () => {
    const { id } = await heicRow({ state: "pending", uploader: ids.member, renditionStatus: "failed" });
    for (const who of ["admin", "external"] as const) expect((await call(QUEUE_ENV, `${statusPath(id)}/retry`, who, "POST", {})).status, who).toBe(404);
    expect((await call(QUEUE_ENV, `${statusPath(id)}/retry`, "other", "POST", {})).status).toBe(403);
    const off = await call(withQueue({ ...baseEnv, RENDITIONS_ENABLED: false }), `${statusPath(id)}/retry`, "member", "POST", {});
    expect(off.status).toBe(503); expect(await mediaRow(id)).toMatchObject({ rendition_status: "failed" }); expect(sends).toEqual([]);
  });

  it("serves the Notice board's status and retry to its uploader only", async () => {
    const { id } = await heicRow({ ownerKind: "notice_post", state: "pending", uploader: ids.member, renditionStatus: "failed" });
    const path = `${NOTICE_MEDIA}/${id}/rendition`;
    expect(await (await call(QUEUE_ENV, path, "member", "GET")).json()).toEqual({ mediaId: id, status: "failed" });
    expect((await call(QUEUE_ENV, path, "admin", "GET")).status).toBe(404); expect((await call(QUEUE_ENV, `${path}/retry`, "other", "POST", {})).status).toBe(404);
    expect((await call(QUEUE_ENV, `${path}/retry`, "member", "POST", {})).status).toBe(200);
    expect(sends).toEqual([{ type: "embedded_display", mediaId: id, generation: (await mediaRow(id))!.rendition_requested_at }]);
    expect((await call(QUEUE_ENV, `${NOTICE_MEDIA}/${crypto.randomUUID()}/rendition`, "member", "GET")).status).toBe(404);
    expect((await call(QUEUE_ENV, `${NOTICE_MEDIA}/${id}/rendition`, "external", "GET")).status).toBe(403);
  });
});

describe("deleting a HEIC image (#495)", () => {
  it("a Project hard delete leaves no row, no original and no display copy", async () => {
    const projectId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, archived_at, created_at, updated_at) VALUES (?, 'Doomed', 'editing_autohdr', 0, ?, ?, ?)").bind(projectId, now, now, now).run();
    const ready = await readyHeic({ projectId, state: "attached" }); const pending = await heicRow({ projectId, state: "pending" });
    const displayKey = (await mediaRow(ready.id))!.display_key as string;
    const response = await call(baseEnv, `/api/projects/${projectId}`, "admin", "DELETE");
    expect(response.status).toBe(200);
    for (const row of [ready, pending]) { expect(await mediaRow(row.id)).toBeNull(); expect(await database.MEDIA.head(row.key)).toBeNull(); }
    expect(await database.MEDIA.head(displayKey)).toBeNull();
  });

  it("deleting a Notice post purges the display copy with the original", async () => {
    const ready = await readyHeic({ ownerKind: "notice_post", state: "pending", uploader: ids.member });
    const displayKey = (await mediaRow(ready.id))!.display_key as string;
    const created = await request("/api/notice-board/posts", "member", "POST", { content: imageDoc(ready.id) });
    expect(created.status).toBe(201);
    const post = ((await created.json()) as { post: { id: string } }).post;
    expect((await request(`/api/notice-board/posts/${post.id}`, "member", "DELETE")).status).toBe(200);
    expect(await mediaRow(ready.id)).toBeNull(); expect(await database.MEDIA.head(ready.key)).toBeNull(); expect(await database.MEDIA.head(displayKey)).toBeNull();
  });

  it("cancelling a pending HEIC through abort deletes the row and the original", async () => {
    const { id, key } = await heicRow({ state: "pending", uploader: ids.member });
    expect((await call(QUEUE_ENV, `${projectMedia()}/${id}/abort`, "member", "POST", {})).status).toBe(204);
    expect(await mediaRow(id)).toBeNull(); expect(await database.MEDIA.head(key)).toBeNull();
  });
});

describe("the settings route and the flag toggle (#495)", () => {
  const settings = (environment: Env, who: Who) => call(environment, "/api/embedded-media/settings", who, "GET");

  it("tells each person whether they may upload HEIC: an Admin always, others only with the flag on, nobody while renditions are off", async () => {
    await setFlag(false);
    expect(externalEmbeddedMediaSettingsSchema.parse(await (await settings(QUEUE_ENV, "admin")).json())).toEqual({ heic: true });
    for (const who of ["member", "external", "photographer"] as const) expect(await (await settings(QUEUE_ENV, who)).json(), who).toEqual({ heic: false });
    await setFlag(true);
    for (const who of ["member", "external", "photographer"] as const) expect(await (await settings(QUEUE_ENV, who)).json(), who).toEqual({ heic: true });
    expect(await (await settings({ ...baseEnv, RENDITIONS_ENABLED: false }, "admin")).json()).toEqual({ heic: false });
    expect((await call(QUEUE_ENV, "/api/embedded-media/settings", "admin", "GET", undefined, { cookie: "" })).status).toBe(401);
  });

  it("lets an Admin read and flip the flag with an audit entry, and refuses everyone else", async () => {
    expect(await (await call(QUEUE_ENV, "/api/users/embedded-heic-settings", "admin", "GET")).json()).toEqual({ enabled: false });
    const response = await call(QUEUE_ENV, "/api/users/embedded-heic-settings", "admin", "PATCH", { enabled: true });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ enabled: true });
    expect(await database.DB.prepare("SELECT enabled, updated_by AS updatedBy FROM feature_flags WHERE key = 'embedded_heic_uploads'").first()).toEqual({ enabled: 1, updatedBy: ids.admin });
    const audited = await database.DB.prepare("SELECT actor_id AS actorId, target_type AS targetType, target_id AS targetId, meta_json AS meta FROM audit_log WHERE action = 'embedded_media.heic_toggle' ORDER BY created_at DESC LIMIT 1").first<{ actorId: string; targetType: string; targetId: string; meta: string }>();
    expect(audited).toMatchObject({ actorId: ids.admin, targetType: "feature_flag", targetId: "embedded_heic_uploads" }); expect(JSON.parse(audited!.meta)).toEqual({ enabled: true });
    for (const who of ["member", "external", "photographer"] as const) {
      expect((await call(QUEUE_ENV, "/api/users/embedded-heic-settings", who, "PATCH", { enabled: false })).status, who).toBe(403);
      expect((await call(QUEUE_ENV, "/api/users/embedded-heic-settings", who, "GET")).status, who).toBe(403);
    }
    expect((await call(QUEUE_ENV, "/api/users/embedded-heic-settings", "admin", "PATCH", { enabled: "yes" })).status).toBe(400);
    expect((await call(QUEUE_ENV, "/api/users/embedded-heic-settings", "admin", "PATCH", { enabled: false })).status).toBe(200);
  });
});
