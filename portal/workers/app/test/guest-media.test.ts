import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { externalEmbeddedMediaCompleteSchema, externalEmbeddedMediaPresignSchema } from "@quincy/shared";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, database, ids, imageDoc, jpegBytes, mediaKey, mediaRow, mp4Bytes, pngBytes, seedFixture, seedMedia } from "./embedded-media-support";
import { addMember, clearGuestRows, freshIp, guestFetch, guestOrigin, linkPath, linkWithSession, openGuestGate, verifySession, type LinkInput } from "./guest-support";
import { clearVideoFlags, clearVideoNotes, seedVideoNote, seedVideoVersion } from "./video-review-support";

/**
 * Guest media (#835 C): a verified guest uploads images and videos for a video note, and reads the media of public notes. The dev route (`APP_ENV: "dev"`, no R2 S3 credentials) drives the byte PUT;
 * refusals and reads run on the plain test env.
 */
type Json = Record<string, any>;
const DEV_ENV: Env = { ...baseEnv, APP_ENV: "dev" };
const json = async (response: Response) => await response.json() as Json;

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearGuestRows(); await clearVideoNotes(); await openGuestGate(); });
afterEach(async () => {
  await clearVideoNotes(); await clearGuestRows(); await clearVideoFlags();
  await database.DB.prepare("DELETE FROM embedded_media").run();
  await database.DB.prepare("DELETE FROM embedded_media_cleanup").run();
  await database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'review_link.%' OR action LIKE 'embedded_media.%'").run();
  await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run();
  await database.DB.prepare("DELETE FROM guest_reviewers WHERE email_normalized LIKE '%@guest-13b.test' OR email_normalized LIKE '%@guest.test'").run();
});

/** A guest request on the dev env (or `env`), with the cookie and app Origin; `body` is JSON unless `raw` is given. */
async function guestApp(env: Env, path: string, init: { method?: string; cookie?: string | null; body?: unknown; raw?: BodyInit; contentType?: string; origin?: string | null } = {}) {
  const method = init.method ?? "GET"; const headers = new Headers({ "cf-connecting-ip": freshIp() });
  if (init.cookie) headers.set("cookie", init.cookie);
  if (method !== "GET") { if (init.origin !== null) headers.set("origin", init.origin ?? guestOrigin); if (init.body !== undefined || init.raw !== undefined) headers.set("content-type", init.contentType ?? "application/json"); }
  return app.fetch(new Request(`https://portal.test${path}`, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : init.raw !== undefined ? { body: init.raw } : {}) }), env, createExecutionContext());
}

/** A verified guest on a link that holds one Video with its first Version granted. */
async function world(input: { link?: LinkInput; verified?: boolean } = {}) {
  const a = await seedVideoVersion({ title: "Hero film" });
  const link = await linkWithSession(input.link);
  await addMember(link.id, a.videoId, [a.assetId]);
  const guest = input.verified === false ? null : await verifySession(link);
  return { link, a, guest };
}
type World = Awaited<ReturnType<typeof world>>;
const mediaUrl = (w: World, rest = "") => linkPath(w.link.id, `/media${rest}`);
const presign = (w: World, body: unknown = { contentType: "image/png", bytes: 64 }, env: Env = DEV_ENV) => guestApp(env, mediaUrl(w), { method: "POST", cookie: w.link.cookie, body });

/** presign, bytes and complete in the dev flow; returns the media id. */
async function uploadImage(w: World, bytes: Uint8Array = pngBytes(64)) {
  const response = await presign(w, { contentType: "image/png", bytes: bytes.byteLength });
  expect(response.status, await response.clone().text()).toBe(200);
  const { mediaId } = externalEmbeddedMediaPresignSchema.parse(await response.json());
  const put = await guestApp(DEV_ENV, mediaUrl(w, `/${mediaId}/direct`), { method: "PUT", cookie: w.link.cookie, raw: bytes, contentType: "image/png" });
  expect(put.status).toBe(204);
  const done = await guestApp(DEV_ENV, mediaUrl(w, `/${mediaId}/complete`), { method: "POST", cookie: w.link.cookie, body: {} });
  expect(done.status, await done.clone().text()).toBe(200);
  expect(externalEmbeddedMediaCompleteSchema.parse(await done.json())).toEqual({ mediaId, state: "pending" });
  return mediaId;
}
const read = (w: World, mediaId: string, cookie: string | null = w.link.cookie, rest = "", headers: Record<string, string> = {}) => guestFetch(mediaUrl(w, `/${mediaId}${rest}`), { cookie, headers });
const STUB = async (response: Response) => { expect(response.status).toBe(404); };

describe("guest upload", () => {
  it("presigns, takes the bytes, completes, and audits with no actor", async () => {
    const w = await world();
    const mediaId = await uploadImage(w);
    expect(await mediaRow(mediaId)).toMatchObject({ owner_kind: "video_note", state: "pending", owner_id: null, uploader_id: null, uploader_guest_id: w.guest!.guestId, project_id: ids.project });
    const audits = (await database.DB.prepare("SELECT actor_id, action, meta_json FROM audit_log WHERE action LIKE 'embedded_media.%' ORDER BY created_at, action").all<{ actor_id: string | null; action: string; meta_json: string }>()).results;
    // The dev flow answers `devDirect` before the presign audit (as the staff route does); the completion is audited.
    expect(audits.map((row) => row.action)).toEqual(["embedded_media.upload"]);
    for (const row of audits) { expect(row.actor_id).toBeNull(); expect(JSON.parse(row.meta_json)).toMatchObject({ guest: { guestId: w.guest!.guestId, sessionId: w.guest!.sessionId }, linkId: w.link.id }); }
  });

  it("takes a video with its poster, once", async () => {
    const w = await world();
    const bytes = mp4Bytes(4096);
    const { mediaId } = externalEmbeddedMediaPresignSchema.parse(await (await presign(w, { contentType: "video/mp4", bytes: bytes.byteLength })).json());
    expect((await guestApp(DEV_ENV, mediaUrl(w, `/${mediaId}/direct`), { method: "PUT", cookie: w.link.cookie, raw: bytes, contentType: "video/mp4" })).status).toBe(204);
    expect((await guestApp(DEV_ENV, mediaUrl(w, `/${mediaId}/complete`), { method: "POST", cookie: w.link.cookie, body: {} })).status).toBe(200);
    const put = () => guestApp(DEV_ENV, mediaUrl(w, `/${mediaId}/poster`), { method: "PUT", cookie: w.link.cookie, raw: jpegBytes(32), contentType: "image/jpeg" });
    expect((await put()).status).toBe(204);
    expect((await put()).status).toBe(409);
    expect((await mediaRow(mediaId))!.poster_key).toBeTruthy();
    const poster = await read(w, mediaId, w.link.cookie, "/poster");
    expect(poster.status).toBe(200); expect(poster.headers.get("content-type")).toBe("image/jpeg");
  });

  it("aborts its own upload and nobody else's", async () => {
    const w = await world();
    const { mediaId } = externalEmbeddedMediaPresignSchema.parse(await (await presign(w)).json());
    const other = await linkWithSession(); await addMember(other.id, w.a.videoId, [w.a.assetId]); await verifySession(other);
    expect((await guestApp(DEV_ENV, linkPath(other.id, `/media/${mediaId}/abort`), { method: "POST", cookie: other.cookie, body: {} })).status).toBe(404);
    expect((await guestApp(DEV_ENV, mediaUrl(w, `/${mediaId}/abort`), { method: "POST", cookie: w.link.cookie, body: {} })).status).toBe(204);
    expect(await mediaRow(mediaId)).toBeNull();
  });

  it("refuses with comments off (403), unverified (401), no cookie (the stub), a wrong Origin (403) and an archived Project (409)", async () => {
    const off = await world({ link: { allow: [0, 1, 1] } });
    expect((await presign(off)).status).toBe(403); expect(await json(await presign(off))).toEqual({ error: "comments_disabled" });
    const unverified = await world({ verified: false });
    expect((await presign(unverified)).status).toBe(401);
    const w = await world();
    await STUB(await guestApp(DEV_ENV, mediaUrl(w), { method: "POST", cookie: null, body: { contentType: "image/png", bytes: 64 } }));
    expect((await guestApp(DEV_ENV, mediaUrl(w), { method: "POST", cookie: w.link.cookie, origin: "https://evil.test", body: { contentType: "image/png", bytes: 64 } })).status).toBe(403);
    expect((await guestApp(DEV_ENV, mediaUrl(w, `/${crypto.randomUUID()}/direct`), { method: "PUT", cookie: w.link.cookie, origin: "https://evil.test", raw: pngBytes(8), contentType: "image/png" })).status).toBe(403);
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run();
    const archived = await presign(w); expect(archived.status).toBe(409); expect((await json(archived)).error).toBe("project_archived");
    expect(await database.DB.prepare("SELECT count(*) AS n FROM embedded_media").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("is the stub once the link is revoked, even mid-flight", async () => {
    const w = await world();
    const { mediaId } = externalEmbeddedMediaPresignSchema.parse(await (await presign(w)).json());
    await guestApp(DEV_ENV, mediaUrl(w, `/${mediaId}/direct`), { method: "PUT", cookie: w.link.cookie, raw: pngBytes(64), contentType: "image/png" });
    await database.DB.prepare("UPDATE client_links SET revoked_at = ? WHERE id = ?").bind(Date.now(), w.link.id).run();
    await STUB(await guestApp(DEV_ENV, mediaUrl(w, `/${mediaId}/complete`), { method: "POST", cookie: w.link.cookie, body: {} }));
    await STUB(await presign(w));
  });

  it("limits a guest to 20 uploads in 15 minutes (429), and spends nothing on a refusal before the limiter", async () => {
    const w = await world();
    for (let i = 0; i < 20; i += 1) expect((await presign(w)).status).toBe(200);
    const limited = await presign(w); expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("limits a link to 100 uploads across its guests", async () => {
    const w = await world();
    const bucket = `media:link:${w.link.id}`; const start = Math.floor(Date.now() / 900_000) * 900_000;
    await database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?, ?, 100)").bind(bucket, start).run();
    expect((await presign(w)).status).toBe(429);
  });

  it("refuses an oversize or unknown body with 400, and a JSON body that is not JSON", async () => {
    const w = await world();
    expect((await presign(w, { contentType: "image/png", bytes: 1024 ** 3 })).status).toBe(400);
    expect((await presign(w, { contentType: "text/html", bytes: 10 })).status).toBe(400);
    expect((await presign(w, { contentType: "image/png", bytes: 10, owner: "whiteboard" })).status).toBe(400);
    expect((await guestApp(DEV_ENV, mediaUrl(w), { method: "POST", cookie: w.link.cookie, raw: "{nope" })).status).toBe(400);
  });

  it("takes HEIC only with renditions on and the owner's flag on, with no Admin bypass", async () => {
    const w = await world();
    const heic = { contentType: "image/heic", bytes: 64 };
    const setFlag = (enabled: boolean) => database.DB.prepare("UPDATE feature_flags SET enabled = ?, updated_by = NULL WHERE key = 'embedded_heic_uploads'").bind(enabled ? 1 : 0).run();
    const on: Env = { ...DEV_ENV, RENDITIONS_ENABLED: true };
    await setFlag(false);
    const off = await presign(w, heic, on); expect(off.status).toBe(403); expect(await json(off)).toMatchObject({ code: "heic_not_enabled" });
    expect(await database.DB.prepare("SELECT count(*) AS n FROM embedded_media").first<{ n: number }>()).toEqual({ n: 0 });
    await setFlag(true);
    try {
      const unavailable = await presign(w, heic, { ...DEV_ENV, RENDITIONS_ENABLED: false }); expect(unavailable.status).toBe(503); expect(await json(unavailable)).toMatchObject({ code: "heic_unavailable" });
      const allowed = await presign(w, heic, on); expect(allowed.status).toBe(200);
      const { mediaId } = externalEmbeddedMediaPresignSchema.parse(await allowed.json());
      expect(await mediaRow(mediaId)).toMatchObject({ rendition_status: "pending", uploader_guest_id: w.guest!.guestId });
    } finally { await setFlag(false); }
  });
});

describe("guest serve", () => {
  const guestMedia = (input: Parameters<typeof seedMedia>[0] = {}) => seedMedia({ ownerKind: "video_note", ...input });

  it("serves the guest's own pending upload with the isolating headers, and to nobody else", async () => {
    const w = await world();
    const mediaId = await uploadImage(w);
    const own = await read(w, mediaId);
    expect(own.status).toBe(200); expect(await own.arrayBuffer()).toHaveProperty("byteLength", 64);
    expect(own.headers.get("content-type")).toBe("image/png");
    expect(own.headers.get("x-content-type-options")).toBe("nosniff");
    expect(own.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(own.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(own.headers.get("cache-control")).toBe("private, no-store");
    // Another verified guest on the same link, an unverified session, no session: the stub.
    const other = await linkWithSession(); await addMember(other.id, w.a.videoId, [w.a.assetId]); await verifySession(other);
    await STUB(await guestFetch(linkPath(other.id, `/media/${mediaId}`), { cookie: other.cookie }));
    await STUB(await read(w, mediaId, null));
    const unverified = await world({ verified: false });
    await STUB(await guestFetch(linkPath(unverified.link.id, `/media/${mediaId}`), { cookie: unverified.link.cookie }));
  });

  it("honours Range", async () => {
    const w = await world();
    const mediaId = await uploadImage(w);
    const ranged = await read(w, mediaId, w.link.cookie, "", { range: "bytes=0-7" });
    expect(ranged.status).toBe(206); expect((await ranged.arrayBuffer()).byteLength).toBe(8);
  });

  it("serves staff public media and another guest's media to anyone who can read the note, and the stub for the rest", async () => {
    const w = await world();
    // Staff public note with an attached image.
    const staffNote = await seedVideoNote({ assetId: w.a.assetId, visibility: "public" });
    const staffImage = await guestMedia({ state: "attached", ownerId: staffNote.id });
    expect((await read(w, staffImage.id)).status).toBe(200);
    // Another guest's attached image in a public note.
    const otherNote = await seedVideoNote({ assetId: w.a.assetId, guest: true });
    const otherImage = await guestMedia({ state: "attached", ownerId: otherNote.id });
    await database.DB.prepare("UPDATE embedded_media SET uploader_id = NULL, uploader_guest_id = ? WHERE id = ?").bind(otherNote.guestId, otherImage.id).run();
    expect((await read(w, otherImage.id)).status).toBe(200);
    // An internal note's image, a staff pending upload and a detached one: the stub.
    const internal = await seedVideoNote({ assetId: w.a.assetId, visibility: "internal" });
    const internalImage = await guestMedia({ state: "attached", ownerId: internal.id });
    await STUB(await read(w, internalImage.id));
    await STUB(await read(w, (await guestMedia({ state: "pending", ownerId: null })).id));
    await STUB(await read(w, (await guestMedia({ state: "detached", ownerId: staffNote.id })).id));
    // A comment's image, a whiteboard's, and another Project's video-note image: the stub.
    await STUB(await read(w, (await seedMedia({ ownerKind: "project_comment", state: "attached" })).id));
    await STUB(await read(w, (await guestMedia({ state: "attached", ownerId: staffNote.id, projectId: ids.otherProject })).id));
    await STUB(await read(w, crypto.randomUUID())); await STUB(await read(w, "not-a-uuid"));
  });

  it("is the stub for media of a Version the link does not grant, a removed note, and a revoked link", async () => {
    const w = await world();
    const other = await seedVideoVersion({ title: "Not on this link" });
    const elsewhere = await seedVideoNote({ assetId: other.assetId, visibility: "public" });
    await STUB(await read(w, (await guestMedia({ state: "attached", ownerId: elsewhere.id })).id));
    const note = await seedVideoNote({ assetId: w.a.assetId, visibility: "public" });
    const image = await guestMedia({ state: "attached", ownerId: note.id });
    expect((await read(w, image.id)).status).toBe(200);
    await database.DB.prepare("UPDATE video_notes SET deleted_at = ? WHERE id = ?").bind(Date.now(), note.id).run();
    await STUB(await read(w, image.id));
    await database.DB.prepare("UPDATE video_notes SET deleted_at = NULL WHERE id = ?").bind(note.id).run();
    expect((await read(w, image.id)).status).toBe(200);
    await database.DB.prepare("UPDATE client_links SET revoked_at = ? WHERE id = ?").bind(Date.now(), w.link.id).run();
    await STUB(await read(w, image.id));
  });

  it("serves a video's poster only under the same rules", async () => {
    const w = await world();
    const note = await seedVideoNote({ assetId: w.a.assetId, visibility: "public" });
    const video = await guestMedia({ state: "attached", ownerId: note.id, kind: "video", poster: true });
    const poster = await read(w, video.id, w.link.cookie, "/poster");
    expect(poster.status).toBe(200); expect(poster.headers.get("content-type")).toBe("image/jpeg");
    const internal = await seedVideoNote({ assetId: w.a.assetId, visibility: "internal" });
    await STUB(await read(w, (await guestMedia({ state: "attached", ownerId: internal.id, kind: "video", poster: true })).id, w.link.cookie, "/poster"));
  });

  it("answers the uploader's rendition status to the uploader alone", async () => {
    const w = await world();
    const mediaId = await uploadImage(w);
    const status = await read(w, mediaId, w.link.cookie, "/rendition");
    expect(status.status).toBe(200); expect(await json(status)).toEqual({ mediaId, status: "not_required" });
    const other = await linkWithSession(); await addMember(other.id, w.a.videoId, [w.a.assetId]); await verifySession(other);
    await STUB(await guestFetch(linkPath(other.id, `/media/${mediaId}/rendition`), { cookie: other.cookie }));
  });
});

describe("guest media and notes", () => {
  it("attaches an uploaded image to a note, then everyone who reads the note reads the image", async () => {
    const w = await world();
    const mediaId = await uploadImage(w);
    const created = await guestFetch(linkPath(w.link.id, `/versions/${w.a.assetId}/notes`), { method: "POST", cookie: w.link.cookie, body: { startFrame: 10, content: imageDoc(mediaId) } });
    expect(created.status, await created.clone().text()).toBe(201);
    const thread = await json(created);
    expect(thread).toMatchObject({ body: "Photos [1 image]", mediaCount: 1 });
    expect(await mediaRow(mediaId)).toMatchObject({ state: "attached", owner_id: thread.id, uploader_guest_id: w.guest!.guestId });
    const other = await linkWithSession(); await addMember(other.id, w.a.videoId, [w.a.assetId]);
    expect((await guestFetch(linkPath(other.id, `/media/${mediaId}`), { cookie: other.cookie })).status).toBe(200);
  });

  it("refuses to attach another guest's pending upload (409)", async () => {
    const w = await world();
    const other = await linkWithSession(); await addMember(other.id, w.a.videoId, [w.a.assetId]); const otherGuest = await verifySession(other);
    const media = await seedMedia({ ownerKind: "video_note", state: "pending", ownerId: null });
    await database.DB.prepare("UPDATE embedded_media SET uploader_id = NULL, uploader_guest_id = ? WHERE id = ?").bind(otherGuest.guestId, media.id).run();
    const response = await guestFetch(linkPath(w.link.id, `/versions/${w.a.assetId}/notes`), { method: "POST", cookie: w.link.cookie, body: { startFrame: 10, content: imageDoc(media.id) } });
    expect(response.status).toBe(409); expect(await json(response)).toEqual({ error: "media_unavailable" });
    expect(await mediaRow(media.id)).toMatchObject({ state: "pending", owner_id: null });
  });
});

void mediaKey;
