import { createExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { attachmentCompleteResponseSchema, attachmentPresignResponseSchema } from "@quincy/shared";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, database, ids, request, seedFixture } from "./embedded-media-support";
import { attachmentAudits, attachmentRow, fileBytes, seedAttachment } from "./attachment-support";
import { addMember, clearGuestRows, freshIp, GUEST_WINDOW_MS, guestFetch, guestOrigin, linkPath, linkWithSession, openGuestGate, verifySession, type LinkInput } from "./guest-support";
import { clearVideoFlags, clearVideoNotes, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/**
 * Guest Attachments (#956): a verified Guest reviewer uploads files through the Review link's own routes (`/d/api/links/:linkId/attachments`), 25 MB a file and five a note, under a
 * per-guest and per-link rate limit, and attaches them to their own notes, replies and edits. Staff and the link's other guests download them. The dev route (`APP_ENV: "dev"`, no R2 S3
 * credentials) drives the byte PUT.
 */
type Json = Record<string, any>;
const DEV_ENV: Env = { ...baseEnv, APP_ENV: "dev" };
const MB = 1024 * 1024;
const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const files = (...attachmentIds: string[]) => ({ type: "doc", content: [para("See the plan"), ...attachmentIds.map((attachmentId) => ({ type: "attachment", attrs: { attachmentId } }))] });
const fileNodes = (dto: Json) => (dto.content.content as Json[]).filter((node) => node.type === "attachment").map((node) => node.attrs);

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearGuestRows(); await clearVideoNotes(); await openGuestGate(); await setVideoFlags("video_review_notes"); });
afterEach(async () => {
  await clearVideoNotes(); await clearGuestRows(); await clearVideoFlags();
  await database.DB.batch([
    database.DB.prepare("DELETE FROM attachments"), database.DB.prepare("DELETE FROM embedded_media"), database.DB.prepare("DELETE FROM embedded_media_cleanup"),
    database.DB.prepare("DELETE FROM audit_log WHERE target_type = 'attachment' OR action LIKE 'video_note.%'"),
    database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project),
    database.DB.prepare("DELETE FROM guest_reviewers WHERE email_normalized LIKE '%@guest-13b.test' OR email_normalized LIKE '%@guest.test'"),
  ]);
});

/** A guest request on the dev env, with the cookie and app Origin; `body` is JSON unless `raw` is given. */
async function guestApp(path: string, init: { method?: string; cookie?: string | null; body?: unknown; raw?: BodyInit; origin?: string | null; env?: Env } = {}) {
  const method = init.method ?? "GET"; const headers = new Headers({ "cf-connecting-ip": freshIp() });
  if (init.cookie) headers.set("cookie", init.cookie);
  if (method !== "GET") { if (init.origin !== null) headers.set("origin", init.origin ?? guestOrigin); if (init.body !== undefined || init.raw !== undefined) headers.set("content-type", init.raw !== undefined ? "application/octet-stream" : "application/json"); }
  return app.fetch(new Request(`https://portal.test${path}`, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : init.raw !== undefined ? { body: init.raw } : {}) }), init.env ?? DEV_ENV, createExecutionContext());
}

/** A verified guest on a link that holds one Video with its first Version granted. */
async function world(input: { link?: LinkInput; verified?: boolean } = {}) {
  const v = await seedVideoVersion({ title: "Hero film" });
  const link = await linkWithSession(input.link);
  await addMember(link.id, v.videoId, [v.assetId]);
  const guest = input.verified === false ? null : await verifySession(link);
  return { link, v, guest };
}
type World = { link: { id: string; cookie: string }; v: { assetId: string; videoId: string }; guest: { guestId: string; sessionId: string } | null };
const filesUrl = (w: World, rest = "") => linkPath(w.link.id, `/attachments${rest}`);
const presign = (w: World, body: unknown = { name: "Plan.pdf", contentType: "application/pdf", bytes: 48 }) => guestApp(filesUrl(w), { method: "POST", cookie: w.link.cookie, body });

/** presign, bytes and complete in the dev flow; returns the Attachment id. */
async function upload(w: World, name = "Plan.pdf", bytes = 48) {
  const response = await presign(w, { name, contentType: "application/pdf", bytes });
  expect(response.status, await response.clone().text()).toBe(200);
  const { attachmentId } = attachmentPresignResponseSchema.parse(await response.json());
  expect((await guestApp(filesUrl(w, `/${attachmentId}/direct`), { method: "PUT", cookie: w.link.cookie, raw: fileBytes(bytes) })).status).toBe(204);
  const done = await guestApp(filesUrl(w, `/${attachmentId}/complete`), { method: "POST", cookie: w.link.cookie, body: {} });
  expect(done.status, await done.clone().text()).toBe(200);
  expect(attachmentCompleteResponseSchema.parse(await done.json())).toEqual({ attachmentId, state: "pending" });
  return attachmentId;
}
const note = (w: World, content: unknown) => guestApp(linkPath(w.link.id, `/versions/${w.v.assetId}/notes`), { method: "POST", cookie: w.link.cookie, body: { startFrame: 10, content } });
const reply = (w: World, noteId: string, content: unknown) => guestApp(linkPath(w.link.id, `/notes/${noteId}/replies`), { method: "POST", cookie: w.link.cookie, body: { content } });
const edit = (w: World, noteId: string, revision: number, content: unknown) => guestApp(linkPath(w.link.id, `/notes/${noteId}`), { method: "PATCH", cookie: w.link.cookie, body: { expectedRevision: revision, content } });
const remove = (w: World, noteId: string, revision: number) => guestApp(linkPath(w.link.id, `/notes/${noteId}`), { method: "DELETE", cookie: w.link.cookie, body: { expectedRevision: revision } });
const guestDownload = (w: World, id: string) => guestFetch(linkPath(w.link.id, `/attachments/${id}`), { cookie: w.link.cookie });
const staffDownload = (id: string) => request(`/media/attachments/${id}`, "member", "GET");
const errorOf = async (response: Response) => ((await response.json()) as Json).error;

describe("a guest uploads a file", () => {
  it("through the link's own routes: a pending video_note row with the guest as uploader, audited with no actor", async () => {
    const w = await world();
    const id = await upload(w);
    expect(await attachmentRow(id)).toMatchObject({ owner_kind: "video_note", state: "pending", owner_id: null, uploader_id: null, uploader_guest_id: w.guest!.guestId, project_id: ids.project, file_name: "Plan.pdf" });
    const audits = await attachmentAudits(id);
    // The dev flow audits the reservation as well (its `devDirect` answer), then the completion.
    expect(audits.map((row) => row.action)).toEqual(["attachment.presign", "attachment.upload"]);
    for (const row of audits) { expect(row.actorId).toBeNull(); expect(JSON.parse(row.meta!)).toMatchObject({ guest: { guestId: w.guest!.guestId, sessionId: w.guest!.sessionId }, linkId: w.link.id }); }
  });

  it("is refused over 25 MB, empty, or of a blocked type by extension or by declared type, with the reason in words", async () => {
    const w = await world();
    const big = await presign(w, { name: "raw.zip", contentType: "application/zip", bytes: 25 * MB + 1 });
    expect(big.status).toBe(400); expect(await errorOf(big)).toBe("raw.zip is larger than 25 MB, the most a file can be.");
    expect((await presign(w, { name: "raw.zip", contentType: "application/zip", bytes: 25 * MB })).status).toBe(200);
    const exe = await presign(w, { name: "setup.exe", contentType: "application/octet-stream", bytes: 10 });
    expect(exe.status).toBe(400); expect(await errorOf(exe)).toBe("setup.exe can't be attached: .exe files are blocked.");
    expect((await presign(w, { name: "page.txt", contentType: "text/html", bytes: 10 })).status).toBe(400);
    expect((await presign(w, { name: "macro.xlsm", contentType: "application/vnd.ms-excel", bytes: 10 })).status).toBe(400);
    expect((await presign(w, { name: "empty.pdf", contentType: "application/pdf", bytes: 0 })).status).toBe(400);
    // A staff-only field is not part of the guest's body.
    expect((await presign(w, { name: "a.pdf", contentType: "application/pdf", bytes: 10, owner: "discussion" })).status).toBe(400);
    expect(await database.DB.prepare("SELECT count(*) AS n FROM attachments WHERE uploader_guest_id IS NOT NULL").first<{ n: number }>()).toEqual({ n: 1 });
  });

  it("is refused with comments off (403), unverified (401), no cookie or another link's cookie (the stub), a wrong Origin (403) and an archived Project (409)", async () => {
    const off = await world({ link: { allow: [0, 1, 1] } });
    const disabled = await presign(off); expect(disabled.status).toBe(403); expect(await errorOf(disabled)).toBe("comments_disabled");
    expect((await presign(await world({ verified: false }))).status).toBe(401);
    const w = await world(); const other = await world();
    expect((await guestApp(filesUrl(w), { method: "POST", cookie: null, body: { name: "a.pdf", contentType: "application/pdf", bytes: 10 } })).status).toBe(404);
    expect((await guestApp(filesUrl(w), { method: "POST", cookie: other.link.cookie, body: { name: "a.pdf", contentType: "application/pdf", bytes: 10 } })).status).toBe(404);
    expect((await guestApp(filesUrl(w), { method: "POST", cookie: w.link.cookie, origin: "https://evil.test", body: { name: "a.pdf", contentType: "application/pdf", bytes: 10 } })).status).toBe(403);
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run();
    const archived = await presign(w); expect(archived.status).toBe(409); expect(await errorOf(archived)).toBe("project_archived");
    expect(await database.DB.prepare("SELECT count(*) AS n FROM attachments").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("is the stub once the link is revoked mid-flight, and another link's session cannot finish or abort it", async () => {
    const w = await world(); const other = await world();
    const { attachmentId } = attachmentPresignResponseSchema.parse(await (await presign(w)).json());
    expect((await guestApp(linkPath(other.link.id, `/attachments/${attachmentId}/complete`), { method: "POST", cookie: other.link.cookie, body: {} })).status).toBe(404);
    expect((await guestApp(linkPath(other.link.id, `/attachments/${attachmentId}/abort`), { method: "POST", cookie: other.link.cookie, body: {} })).status).toBe(404);
    expect(await attachmentRow(attachmentId)).toMatchObject({ state: "uploading" });
    await guestApp(filesUrl(w, `/${attachmentId}/direct`), { method: "PUT", cookie: w.link.cookie, raw: fileBytes(48) });
    await database.DB.prepare("UPDATE client_links SET revoked_at = ? WHERE id = ?").bind(Date.now(), w.link.id).run();
    expect((await guestApp(filesUrl(w, `/${attachmentId}/complete`), { method: "POST", cookie: w.link.cookie, body: {} })).status).toBe(404);
    expect((await presign(w)).status).toBe(404);
  });

  it("aborts its own upload and nobody else's", async () => {
    const w = await world();
    const { attachmentId } = attachmentPresignResponseSchema.parse(await (await presign(w)).json());
    const staffFile = (await seedAttachment({ ownerKind: "video_note", state: "pending", ownerId: null })).id;
    expect((await guestApp(filesUrl(w, `/${staffFile}/abort`), { method: "POST", cookie: w.link.cookie, body: {} })).status).toBe(404);
    expect(await attachmentRow(staffFile)).toMatchObject({ state: "pending" });
    expect((await guestApp(filesUrl(w, `/${attachmentId}/abort`), { method: "POST", cookie: w.link.cookie, body: {} })).status).toBe(204);
    expect(await attachmentRow(attachmentId)).toBeNull();
  });

  it("limits a guest to 20 uploads in 15 minutes (429) and a link to 100, apart from the media quota", async () => {
    const w = await world();
    for (let n = 0; n < 20; n += 1) expect((await presign(w)).status).toBe(200);
    const limited = await presign(w); expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toBeTruthy();
    // The media quota is its own: an image still presigns.
    expect((await guestApp(linkPath(w.link.id, "/media"), { method: "POST", cookie: w.link.cookie, body: { contentType: "image/png", bytes: 64 } })).status).toBe(200);
    const next = await world();
    await database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?, ?, 100)").bind(`attachment:link:${next.link.id}`, Math.floor(Date.now() / GUEST_WINDOW_MS) * GUEST_WINDOW_MS).run();
    expect((await presign(next)).status).toBe(429);
  });
});

describe("a guest's note with files", () => {
  it("attaches the guest's own files, which staff and the link's other guests download, with the forced-download headers", async () => {
    const w = await world();
    const a = await upload(w, "Plan.pdf", 40); const b = await upload(w, "Moodboard.zip", 50);
    const created = await note(w, files(a, b));
    expect(created.status, await created.clone().text()).toBe(201);
    const dto = await created.json() as Json;
    expect(fileNodes(dto)).toEqual([{ attachmentId: a, name: "Plan.pdf", bytes: 40 }, { attachmentId: b, name: "Moodboard.zip", bytes: 50 }]);
    expect(await attachmentRow(a)).toMatchObject({ state: "attached", owner_id: dto.id });
    expect((await attachmentAudits(a)).map((row) => row.action)).toEqual(["attachment.presign", "attachment.upload", "attachment.attach"]);
    expect(JSON.parse((await attachmentAudits(a))[2]!.meta!)).toMatchObject({ ownerKind: "video_note", ownerId: dto.id, guest: { guestId: w.guest!.guestId }, linkId: w.link.id });
    const staff = await staffDownload(a);
    expect(staff.status).toBe(200);
    expect(staff.headers.get("content-type")).toBe("application/octet-stream");
    expect(staff.headers.get("content-disposition")).toContain("attachment");
    expect(staff.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await staff.arrayBuffer()).byteLength).toBe(40);
    const own = await guestDownload(w, b);
    expect(own.status).toBe(200); expect(own.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    // Another guest, on a link that reaches the same Version (not even verified: reading needs no email), reads the public note's file.
    const second = await linkWithSession(); await addMember(second.id, w.v.videoId, [w.v.assetId]);
    expect((await guestDownload({ ...w, link: second }, b)).status).toBe(200);
  });

  it("takes five files and refuses a sixth (400), attaching none of them", async () => {
    const w = await world();
    const six = [];
    for (let n = 0; n < 6; n += 1) six.push(await upload(w, `File ${n}.pdf`));
    const refused = await note(w, files(...six));
    expect(refused.status).toBe(400); expect(await errorOf(refused)).toBe("invalid_content");
    for (const id of six) expect(await attachmentRow(id)).toMatchObject({ state: "pending", owner_id: null });
    expect((await note(w, files(...six.slice(0, 5)))).status).toBe(201);
  });

  it("refuses a file the guest did not upload: a staff upload or another guest's (409), and attaches nothing", async () => {
    const w = await world();
    const staffFile = (await seedAttachment({ ownerKind: "video_note", state: "pending", ownerId: null })).id;
    const refused = await note(w, files(staffFile));
    expect(refused.status).toBe(409); expect(await errorOf(refused)).toBe("media_unavailable");
    expect(await attachmentRow(staffFile)).toMatchObject({ state: "pending", owner_id: null });
    const other = await world();
    const theirs = await upload(other);
    expect((await note(w, files(theirs))).status).toBe(409);
    expect(await attachmentRow(theirs)).toMatchObject({ state: "pending", owner_id: null });
    expect(await database.DB.prepare("SELECT count(*) AS n FROM video_notes").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("refuses a file attached to another note, so a guest cannot take a staff note's file", async () => {
    const w = await world();
    const staffNote = await seedVideoNote({ assetId: w.v.assetId, visibility: "public" });
    const theirs = (await seedAttachment({ ownerKind: "video_note", state: "attached", ownerId: staffNote.id })).id;
    expect((await note(w, files(theirs))).status).toBe(409);
    expect(await attachmentRow(theirs)).toMatchObject({ state: "attached", owner_id: staffNote.id });
  });

  it("adds and removes files in an edit, each audited, and a removed file stops downloading", async () => {
    const w = await world();
    const a = await upload(w); const b = await upload(w, "Second.pdf");
    const dto = await (await note(w, files(a))).json() as Json;
    const edited = await edit(w, dto.id, dto.revision, files(b));
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect(fileNodes(await edited.json() as Json)).toEqual([{ attachmentId: b, name: "Second.pdf", bytes: 48 }]);
    expect(await attachmentRow(a)).toMatchObject({ state: "detached", owner_id: dto.id });
    expect((await attachmentAudits(a)).map((row) => row.action)).toEqual(["attachment.presign", "attachment.upload", "attachment.attach", "attachment.detach"]);
    expect(await attachmentRow(b)).toMatchObject({ state: "attached", owner_id: dto.id });
    expect((await staffDownload(a)).status).toBe(404);
    expect((await guestDownload(w, a)).status).toBe(404);
  });

  it("cannot edit another guest's note, so it can remove only its own files", async () => {
    const w = await world();
    // Another guest whose link reaches the same Version, so the note is in view and only authorship refuses the edit.
    const otherLink = await linkWithSession(); await addMember(otherLink.id, w.v.videoId, [w.v.assetId]);
    const other: World = { link: otherLink, v: w.v, guest: await verifySession(otherLink) };
    const theirs = await upload(other);
    const dto = await (await note(other, files(theirs))).json() as Json;
    const refused = await guestApp(linkPath(w.link.id, `/notes/${dto.id}`), { method: "PATCH", cookie: w.link.cookie, body: { expectedRevision: dto.revision, content: { type: "doc", content: [para("Gone")] } } });
    expect(refused.status).toBe(403); expect(await errorOf(refused)).toBe("not_author");
    expect(await attachmentRow(theirs)).toMatchObject({ state: "attached", owner_id: dto.id });
  });

  it("takes files on a reply, and deleting the note stops its files downloading", async () => {
    const w = await world();
    const root = await (await note(w, files(await upload(w)))).json() as Json;
    const file = await upload(w, "Reply file.pdf");
    const replied = await reply(w, root.id, files(file));
    expect(replied.status, await replied.clone().text()).toBe(201);
    expect(await attachmentRow(file)).toMatchObject({ state: "attached" });
    expect((await guestDownload(w, file)).status).toBe(200);
    const thread = await replied.json() as Json;
    const own = (thread.replies as Json[]).find((entry) => entry.content && fileNodes(entry).length);
    expect((await remove(w, own!.id, own!.revision)).status).toBe(200);
    expect(await attachmentRow(file)).toMatchObject({ state: "detached", detached_at: 0 });
    expect((await guestDownload(w, file)).status).toBe(404);
  });

  it("cannot put a file on a staff Internal note: a reply under one is the stub, and the file stays pending", async () => {
    const w = await world();
    const internal = await seedVideoNote({ assetId: w.v.assetId, visibility: "internal" });
    const file = await upload(w);
    expect((await reply(w, internal.id, files(file))).status).toBe(404);
    expect(await attachmentRow(file)).toMatchObject({ state: "pending", owner_id: null });
  });
});
