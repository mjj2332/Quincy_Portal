import { SELF as workerSelf } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { guestNoteDeleteResponseSchema, guestNoteListResponseSchema, guestNoteMarkupResponseSchema, guestNoteThreadDtoSchema, type GuestNoteThreadDto } from "@quincy/shared";
import { reserveAttempts } from "../src/guest/rate-limit";
import { hashToken } from "../src/lib/opaque-token";
import { createVideoNote, createVideoNoteReply, deleteVideoNote, editVideoNote, findNoteHead, type NoteAuthor } from "../src/lib/video-notes";
import { cookie as staffCookie, database, ids, seedFixture } from "./embedded-media-support";
import {
  addMember, clearGuestRows, GUEST_WINDOW_MS, grant, guestFetch, guestOrigin, linkPath, linkWithSession, openGuestGate, slowRequest, verifySession, type LinkInput,
} from "./guest-support";
import { clearVideoFlags, clearVideoNotes, noteAudit, noteRow, seedVideoNote, seedVideoVersion, setVideoFlags, SEED_STROKES_JSON } from "./video-review-support";

/** The guest note writes (#741 13b): create, reply, edit and delete of a guest's own notes, behind the same fence as every guest write. */
type Json = Record<string, any>;
const json = async (response: Response) => await response.json() as Json;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MINUTE = 60_000;
const MARKUP = JSON.parse(SEED_STROKES_JSON) as unknown[];
const INTERNAL = "INTERNAL-ONLY-secret-feedback";

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearGuestRows(); await clearVideoNotes(); await openGuestGate(); });
afterEach(async () => {
  vi.restoreAllMocks();
  await clearVideoNotes(); await clearGuestRows(); await clearVideoFlags();
  await database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'review_link.%'").run();
  await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run();
  await database.DB.prepare("DELETE FROM guest_reviewers WHERE email_normalized LIKE '%@guest-13b.test' OR email_normalized LIKE '%@guest.test'").run();
});

type World = Awaited<ReturnType<typeof world>>;
/** A verified guest on a link that holds Video A (v1 granted, v2 not). `link.cookie` is the guest's. */
async function world(input: { link?: LinkInput; verified?: boolean; name?: string | null } = {}) {
  const a = await seedVideoVersion({ title: "Hero film" });
  const a2 = await seedVideoVersion({ projectId: a.projectId, videoId: a.videoId, version: 2 });
  const link = await linkWithSession(input.link);
  await addMember(link.id, a.videoId, [a.assetId]);
  const guest = input.verified === false ? null : await verifySession(link, { name: input.name });
  return { link, a, a2, guest };
}
const notesUrl = (w: World, assetId: string = w.a.assetId) => linkPath(w.link.id, `/versions/${assetId}/notes`);
const noteUrl = (w: World, noteId: string) => linkPath(w.link.id, `/notes/${noteId}`);
const create = (w: World, body: Json = {}, init: Parameters<typeof guestFetch>[1] = {}) => guestFetch(notesUrl(w), { method: "POST", cookie: w.link.cookie, body: { startFrame: 10, body: "A guest note", ...body }, ...init });
const reply = (w: World, noteId: string, body: Json = {}, init: Parameters<typeof guestFetch>[1] = {}) => guestFetch(`${noteUrl(w, noteId)}/replies`, { method: "POST", cookie: w.link.cookie, body: { body: "A guest reply", ...body }, ...init });
const edit = (w: World, noteId: string, body: Json, init: Parameters<typeof guestFetch>[1] = {}) => guestFetch(noteUrl(w, noteId), { method: "PATCH", cookie: w.link.cookie, body, ...init });
const del = (w: World, noteId: string, body: Json = { expectedRevision: 1 }, init: Parameters<typeof guestFetch>[1] = {}) => guestFetch(noteUrl(w, noteId), { method: "DELETE", cookie: w.link.cookie, body, ...init });
const list = async (w: World, assetId: string = w.a.assetId) => { const response = await guestFetch(notesUrl(w, assetId), { cookie: w.link.cookie }); expect(response.status).toBe(200); return guestNoteListResponseSchema.parse(await response.json()).notes; };
const thread = async (response: Response, status: number) => { expect(response.status, await response.clone().text()).toBe(status); return guestNoteThreadDtoSchema.parse(await response.json()); };

/** A note the world's guest wrote, inserted directly (the create route has its own cases). */
async function ownNote(w: World, input: { parentId?: string; assetId?: string; body?: string; startFrame?: number; revision?: number; markup?: boolean } = {}) {
  const id = crypto.randomUUID(); const now = Date.now(); const reply = input.parentId !== undefined;
  await database.DB.prepare("INSERT INTO video_notes (id, project_id, video_id, asset_id, parent_id, author_user_id, author_guest_id, author_role, visibility, start_frame, end_frame, drawing_frame, body, revision, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 'guest', 'public', ?, NULL, ?, ?, ?, ?)")
    .bind(id, w.a.projectId, w.a.videoId, input.assetId ?? w.a.assetId, input.parentId ?? null, w.guest!.guestId, reply ? null : input.startFrame ?? 10, input.markup && !reply ? input.startFrame ?? 10 : null, input.body ?? "My note", input.revision ?? 1, now).run();
  if (input.markup) await database.DB.prepare("INSERT INTO video_note_markup (note_id, strokes_json, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(id, SEED_STROKES_JSON, now, now).run();
  return id;
}
const staffNote = (w: World, input: { visibility?: "public" | "internal"; parentId?: string; body?: string } = {}) => seedVideoNote({ assetId: w.a.assetId, ...input });
const noteCount = async () => (await database.DB.prepare("SELECT COUNT(*) AS n FROM video_notes").first<{ n: number }>())!.n;
const markupCount = async () => (await database.DB.prepare("SELECT COUNT(*) AS n FROM video_note_markup").first<{ n: number }>())!.n;
const guestAudits = async (action?: string) => (await noteAudit(action)).map((row) => ({ ...row, meta: row.meta_json ? JSON.parse(row.meta_json) as Json : null }));
const stubBody = async () => { const stub = await guestFetch("/d"); return { status: stub.status, body: await stub.text() }; };
const plain = async (response: Response) => ({ status: response.status, body: await response.text() });
const archive = () => database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run();
const seedBucket = (bucket: string, count: number) => database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?1, ?2, ?3)").bind(bucket, Math.floor(Date.now() / GUEST_WINDOW_MS) * GUEST_WINDOW_MS, count).run();
const bucketCount = async (bucket: string) => (await database.DB.prepare("SELECT count FROM guest_rate_limits WHERE bucket = ?").bind(bucket).first<{ count: number }>())?.count ?? null;

describe("POST .../versions/:assetId/notes", () => {
  it("creates a point note: a guest thread, a public row authored by the guest, one audit row with the guest and the link", async () => {
    const w = await world();
    const created = await thread(await create(w), 201);
    expect(created).toMatchObject({ parentId: null, author: { kind: "guest", name: "Gina Guest", self: true }, startFrame: 10, endFrame: null, body: "A guest note", revision: 1, deleted: false, resolved: false, hasMarkup: false, replies: [] });
    expect(await noteRow(created.id)).toMatchObject({ author_user_id: null, author_guest_id: w.guest!.guestId, author_role: "guest", visibility: "public", project_id: w.a.projectId, video_id: w.a.videoId, asset_id: w.a.assetId, parent_id: null, revision: 1 });
    const audits = await guestAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_id: null, action: "video_note.create", target_id: created.id });
    expect(audits[0]!.meta).toMatchObject({ guest: { guestId: w.guest!.guestId, sessionId: w.guest!.sessionId }, linkId: w.link.id, projectId: w.a.projectId, assetId: w.a.assetId, visibility: "public", startFrame: 10 });
  });

  it("creates a range note, stamps the time taken after the body arrived and shows it in the list with self true", async () => {
    const w = await world(); const before = Date.now();
    const created = await thread(await create(w, { startFrame: 20, endFrame: 40, body: "  trimmed  " }), 201);
    expect(created).toMatchObject({ startFrame: 20, endFrame: 40, body: "trimmed" });
    expect((await noteRow(created.id))!.created_at as number).toBeGreaterThanOrEqual(before);
    expect((await list(w)).map((note) => [note.id, note.author])).toEqual([[created.id, { kind: "guest", name: "Gina Guest", self: true }]]);
  });

  it("creates a note with markup when the markup part is on, and a plain note without it", async () => {
    const w = await world(); await setVideoFlags("video_review_markup");
    const drawn = await thread(await create(w, { startFrame: 20, markup: MARKUP, drawingFrame: 20 }), 201);
    expect(drawn).toMatchObject({ hasMarkup: true, drawingFrame: 20 });
    expect(await markupCount()).toBe(1);
    const markup = guestNoteMarkupResponseSchema.parse(await (await guestFetch(linkPath(w.link.id, `/notes/${drawn.id}/markup`), { cookie: w.link.cookie })).json());
    expect(markup).toMatchObject({ noteId: drawn.id, revision: 1, markup: MARKUP });
    expect((await guestAudits("video_note.create")).at(-1)!.meta).toMatchObject({ markup: "add", strokeCount: 1, drawingFrame: 20 });
    await database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_markup'").run();
    expect((await create(w, { startFrame: 30 })).status).toBe(201);
  });

  it("is the byte-identical stub, and writes nothing, when the markup part is off and the body carries markup (or just a drawing frame)", async () => {
    const w = await world(); const stub = await stubBody();
    expect(await plain(await create(w, { markup: MARKUP, drawingFrame: 10 }))).toEqual(stub);
    expect(await plain(await create(w, { drawingFrame: 10 }))).toEqual(stub);
    expect(await noteCount()).toBe(0); expect(await markupCount()).toBe(0); expect(await guestAudits()).toEqual([]);
  });

  it("422s a frame outside the Version and a drawing frame outside the note, and writes nothing", async () => {
    const w = await world(); await setVideoFlags("video_review_markup");
    const outside = await create(w, { startFrame: 250 }); expect(outside.status).toBe(422); expect(await json(outside)).toEqual({ error: "frame_out_of_range", frameCount: 250 });
    expect((await create(w, { startFrame: 10, endFrame: 251 })).status).toBe(422);
    const drawing = await create(w, { startFrame: 20, endFrame: 30, markup: MARKUP, drawingFrame: 30 }); expect(drawing.status).toBe(422); expect(await json(drawing)).toEqual({ error: "drawing_frame_outside" });
    expect(await noteCount()).toBe(0); expect(await guestAudits()).toEqual([]);
  });

  it("400s a body naming visibility, an unknown key, an empty body, a markup without a frame, an inverted range or bad JSON, and 413s an oversized one", async () => {
    const w = await world(); await setVideoFlags("video_review_markup");
    for (const bad of [{ visibility: "public" }, { visibility: "internal" }, { extra: 1 }, { body: "   " }, { body: "x".repeat(10_001) }, { markup: MARKUP }, { startFrame: 20, endFrame: 20 }, { startFrame: -1 }]) {
      const response = await create(w, bad); expect(response.status, JSON.stringify(bad).slice(0, 60)).toBe(400); expect(await json(response)).toEqual({ error: "invalid_request" });
    }
    expect((await create(w, {}, { body: "{not json" })).status).toBe(400);
    const huge = await create(w, {}, { body: JSON.stringify({ startFrame: 10, body: "x", pad: "y".repeat(601 * 1024) }) });
    expect(huge.status).toBe(413); expect(await json(huge)).toEqual({ error: "payload_too_large" });
    expect(await noteCount()).toBe(0);
  });

  it("401s an unverified session and 403s a link without comments, each writing nothing", async () => {
    const unverified = await world({ verified: false });
    const response = await create(unverified); expect(response.status).toBe(401); expect(await json(response)).toEqual({ error: "verification_required" });
    const noComments = await world({ link: { allow: [0, 1, 1] } });
    const refused = await create(noComments); expect(refused.status).toBe(403); expect(await json(refused)).toEqual({ error: "comments_disabled" });
    expect(await noteCount()).toBe(0); expect(await guestAudits()).toEqual([]);
  });

  it("is the stub for a Version the link does not grant, a removed Video, another Project's Version and an unknown id", async () => {
    const w = await world(); const stub = await stubBody();
    const other = await seedVideoVersion({ projectId: ids.otherProject }); const removed = await seedVideoVersion();
    await addMember(w.link.id, removed.videoId, [removed.assetId]);
    await database.DB.prepare("UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE video_id = ?").bind(Date.now(), ids.member, removed.videoId).run();
    for (const assetId of [w.a2.assetId, removed.assetId, other.assetId, crypto.randomUUID(), "not-a-uuid"]) {
      expect(await plain(await guestFetch(notesUrl(w, assetId), { method: "POST", cookie: w.link.cookie, body: { startFrame: 10, body: "x" } })), assetId).toEqual(stub);
    }
    expect(await noteCount()).toBe(0);
  });

  it("follows a grant: granting the second Version lets the guest write on it", async () => {
    const w = await world(); await grant(w.link.id, w.a.videoId, w.a2.assetId);
    await thread(await guestFetch(notesUrl(w, w.a2.assetId), { method: "POST", cookie: w.link.cookie, body: { startFrame: 10, body: "on v2" } }), 201);
  });
});

describe("POST .../notes/:noteId/replies", () => {
  it("replies to a staff public root: a guest thread with the reply, a public reply row authored by the guest, a reply audit row", async () => {
    const w = await world(); const root = await staffNote(w, { body: "Studio note" });
    const result = await thread(await reply(w, root.id), 201);
    expect(result.id).toBe(root.id);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).toMatchObject({ parentId: root.id, author: { kind: "guest", name: "Gina Guest", self: true }, body: "A guest reply", revision: 1 });
    expect(await noteRow(result.replies[0]!.id)).toMatchObject({ author_user_id: null, author_guest_id: w.guest!.guestId, author_role: "guest", visibility: "public", parent_id: root.id, asset_id: w.a.assetId, start_frame: null });
    const audits = await guestAudits("video_note.reply");
    expect(audits).toHaveLength(1); expect(audits[0]).toMatchObject({ actor_id: null, target_id: result.replies[0]!.id });
    expect(audits[0]!.meta).toMatchObject({ guest: { guestId: w.guest!.guestId, sessionId: w.guest!.sessionId }, linkId: w.link.id, parentId: root.id, visibility: "public" });
  });

  it("replies to the guest's own root and to another guest's root", async () => {
    const w = await world(); const mine = await ownNote(w); const theirs = await seedVideoNote({ assetId: w.a.assetId, guest: true });
    expect((await thread(await reply(w, mine), 201)).replies).toHaveLength(1);
    const onTheirs = await thread(await reply(w, theirs.id), 201);
    expect(onTheirs.author).toEqual({ kind: "guest", name: "Client Person", self: false }); expect(onTheirs.replies.map((r) => r.author)).toEqual([{ kind: "guest", name: "Gina Guest", self: true }]);
  });

  it("is the stub for an internal root, a tombstone root, an unknown note, an ungranted Version's note and an invalid id; 422 for a reply", async () => {
    const w = await world(); const stub = await stubBody();
    const internal = await staffNote(w, { visibility: "internal", body: INTERNAL });
    const tomb = await staffNote(w); await database.DB.prepare("UPDATE video_notes SET deleted_at = ?, body = '' WHERE id = ?").bind(Date.now(), tomb.id).run();
    const ungranted = await seedVideoNote({ assetId: w.a2.assetId });
    for (const id of [internal.id, tomb.id, ungranted.id, crypto.randomUUID(), "nope"]) expect(await plain(await reply(w, id)), id).toEqual(stub);
    const root = await staffNote(w); const staffReply = await staffNote(w, { parentId: root.id });
    const nested = await reply(w, staffReply.id); expect(nested.status).toBe(422); expect(await json(nested)).toEqual({ error: "not_a_thread" });
    expect(await noteCount()).toBe(5);
  });

  it("401s an unverified session, 403s a link without comments, 400s a bad body and 413s one over 16 KiB", async () => {
    const w = await world(); const root = await staffNote(w);
    for (const bad of [{ body: "" }, { body: "x", visibility: "internal" }, { extra: 1 }]) expect((await reply(w, root.id, bad)).status).toBe(400);
    const huge = await reply(w, root.id, {}, { body: JSON.stringify({ body: "x".repeat(17 * 1024) }) }); expect(huge.status).toBe(413);
    const unverified = await world({ verified: false }); const unverifiedRoot = await staffNote(unverified);
    expect((await reply(unverified, unverifiedRoot.id)).status).toBe(401);
    const noComments = await world({ link: { allow: [0, 1, 1] } }); const noCommentsRoot = await staffNote(noComments);
    const refused = await reply(noComments, noCommentsRoot.id); expect(refused.status).toBe(403); expect(await json(refused)).toEqual({ error: "comments_disabled" });
    expect(await noteCount()).toBe(3);
  });
});

describe("PATCH .../notes/:noteId", () => {
  it("edits the body of an own note: revision 2, editedAt set, one edit audit row; the same body is a no-op", async () => {
    const w = await world(); const id = await ownNote(w);
    const edited = await thread(await edit(w, id, { expectedRevision: 1, body: "Changed" }), 200);
    expect(edited).toMatchObject({ id, body: "Changed", revision: 2 }); expect(edited.editedAt).not.toBeNull();
    const audits = await guestAudits("video_note.edit");
    expect(audits).toHaveLength(1); expect(audits[0]).toMatchObject({ actor_id: null, target_id: id }); expect(audits[0]!.meta).toMatchObject({ guest: { guestId: w.guest!.guestId }, linkId: w.link.id, revision: 2 });
    expect((await thread(await edit(w, id, { expectedRevision: 2, body: "Changed" }), 200)).revision).toBe(2);
    expect(await guestAudits("video_note.edit")).toHaveLength(1);
  });

  it("edits an own reply (the thread comes back) and refuses frames or a drawing on it", async () => {
    const w = await world(); const root = await staffNote(w); const mine = await ownNote(w, { parentId: root.id });
    const edited = await thread(await edit(w, mine, { expectedRevision: 1, body: "Better" }), 200);
    expect(edited.id).toBe(root.id); expect(edited.replies[0]).toMatchObject({ id: mine, body: "Better", revision: 2 });
    const frames = await edit(w, mine, { expectedRevision: 2, startFrame: 5 }); expect(frames.status).toBe(422); expect(await json(frames)).toEqual({ error: "reply_has_no_frames" });
    await setVideoFlags("video_review_markup");
    const drawn = await edit(w, mine, { expectedRevision: 2, markup: MARKUP, drawingFrame: 5 }); expect(drawn.status).toBe(422); expect(await json(drawn)).toEqual({ error: "markup_on_reply" });
  });

  it("moves an own note, and refuses a frame outside the Version (422)", async () => {
    const w = await world(); const id = await ownNote(w);
    expect(await thread(await edit(w, id, { expectedRevision: 1, startFrame: 30, endFrame: 60 }), 200)).toMatchObject({ startFrame: 30, endFrame: 60, revision: 2 });
    const outside = await edit(w, id, { expectedRevision: 2, startFrame: 300, endFrame: null }); expect(outside.status).toBe(422); expect(await json(outside)).toMatchObject({ error: "frame_out_of_range" });
  });

  it("adds, replaces and removes markup behind the markup part; a body edit of a drawn note needs no markup part", async () => {
    const w = await world(); const id = await ownNote(w); const stub = await stubBody();
    expect(await plain(await edit(w, id, { expectedRevision: 1, markup: MARKUP, drawingFrame: 10 }))).toEqual(stub);
    expect(await noteRow(id)).toMatchObject({ revision: 1, drawing_frame: null });
    await setVideoFlags("video_review_markup");
    expect(await thread(await edit(w, id, { expectedRevision: 1, markup: MARKUP, drawingFrame: 10 }), 200)).toMatchObject({ hasMarkup: true, drawingFrame: 10, revision: 2 });
    await database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_markup'").run();
    expect(await thread(await edit(w, id, { expectedRevision: 2, body: "words only" }), 200)).toMatchObject({ hasMarkup: true, revision: 3 });
    expect(await plain(await edit(w, id, { expectedRevision: 3, markup: null }))).toEqual(stub);
    await setVideoFlags("video_review_markup");
    expect(await thread(await edit(w, id, { expectedRevision: 3, markup: null }), 200)).toMatchObject({ hasMarkup: false, drawingFrame: null, revision: 4 });
    expect(await markupCount()).toBe(0);
  });

  it("403s another guest's note and a staff note, answers the stub for an internal note and an ungranted Version, and changes nothing", async () => {
    const w = await world(); const stub = await stubBody();
    const theirs = await seedVideoNote({ assetId: w.a.assetId, guest: true }); const studio = await staffNote(w); const internal = await staffNote(w, { visibility: "internal" }); const ungranted = await seedVideoNote({ assetId: w.a2.assetId, guest: true });
    for (const id of [theirs.id, studio.id]) { const response = await edit(w, id, { expectedRevision: 1, body: "hijack" }); expect(response.status, id).toBe(403); expect(await json(response)).toEqual({ error: "not_author" }); }
    for (const id of [internal.id, ungranted.id, crypto.randomUUID()]) expect(await plain(await edit(w, id, { expectedRevision: 1, body: "hijack" })), id).toEqual(stub);
    expect(await guestAudits("video_note.edit")).toEqual([]);
    expect((await noteRow(theirs.id))!.body).toBe("Seeded note");
  });

  it("409s a stale revision with the current thread in the guest projection, and a deleted note", async () => {
    const w = await world(); const id = await ownNote(w, { revision: 3 }); await staffNote(w, { parentId: id, body: "studio reply" });
    const stale = await edit(w, id, { expectedRevision: 1, body: "late" }); expect(stale.status).toBe(409);
    const body = await json(stale); expect(body.error).toBe("note_conflict");
    expect(guestNoteThreadDtoSchema.parse(body.thread)).toMatchObject({ id, revision: 3, body: "My note" });
    expect(Object.keys(body).sort()).toEqual(["error", "thread"]);
    await database.DB.prepare("UPDATE video_notes SET deleted_at = ?, body = '' WHERE id = ?").bind(Date.now(), id).run();
    const gone = await edit(w, id, { expectedRevision: 3, body: "late" }); expect(gone.status).toBe(409); expect(await json(gone)).toEqual({ error: "note_deleted" });
  });

  it("admits one of two concurrent edits at the same revision", async () => {
    const w = await world(); const id = await ownNote(w);
    const results = await Promise.all([edit(w, id, { expectedRevision: 1, body: "first" }), edit(w, id, { expectedRevision: 1, body: "second" })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await noteRow(id)).toMatchObject({ revision: 2 }); expect(await guestAudits("video_note.edit")).toHaveLength(1);
  });
});

describe("DELETE .../notes/:noteId", () => {
  it("hard-deletes an own note nobody answered, with its markup and its own replies, and says the thread is gone", async () => {
    const w = await world(); const id = await ownNote(w, { markup: true }); await ownNote(w, { parentId: id });
    const response = await del(w, id); expect(response.status).toBe(200);
    expect(guestNoteDeleteResponseSchema.parse(await response.json())).toEqual({ thread: null });
    expect(await noteCount()).toBe(0); expect(await markupCount()).toBe(0);
    const audits = await guestAudits("video_note.delete"); expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_id: null, target_id: id }); expect(audits[0]!.meta).toMatchObject({ mode: "removed", ownRepliesRemoved: 1, hadMarkup: true, guest: { guestId: w.guest!.guestId }, linkId: w.link.id });
  });

  it("tombstones an own note a studio user or another guest answered, and the tombstone still shows its replies", async () => {
    for (const answer of ["staff", "guest"] as const) {
      const w = await world(); const id = await ownNote(w, { markup: true });
      const other = await seedVideoNote({ assetId: w.a.assetId, parentId: id, ...(answer === "guest" ? { guest: true } : {}) });
      const response = await del(w, id); expect(response.status, answer).toBe(200);
      const result = guestNoteDeleteResponseSchema.parse(await response.json());
      expect(result.thread).toMatchObject({ id, deleted: true, body: "", hasMarkup: false, replies: [{ id: other.id }] });
      expect(await noteRow(id)).toMatchObject({ deleted_at: expect.any(Number), body: "" }); expect(await markupCount()).toBe(0);
      expect((await guestAudits("video_note.delete")).at(-1)!.meta).toMatchObject({ mode: "tombstone" });
      await clearVideoNotes();
    }
  });

  it("deletes an own reply and answers the thread it belonged to", async () => {
    const w = await world(); const root = await staffNote(w); const mine = await ownNote(w, { parentId: root.id });
    const result = guestNoteDeleteResponseSchema.parse(await (await del(w, mine)).json());
    expect(result.thread).toMatchObject({ id: root.id, replies: [] }); expect(await noteRow(mine)).toBeNull();
  });

  it("403s another guest's note and a staff note, answers the stub for an internal note, 409s a stale revision and a deleted note", async () => {
    const w = await world(); const stub = await stubBody();
    const theirs = await seedVideoNote({ assetId: w.a.assetId, guest: true }); const studio = await staffNote(w); const internal = await staffNote(w, { visibility: "internal" });
    for (const id of [theirs.id, studio.id]) { const response = await del(w, id); expect(response.status, id).toBe(403); expect(await json(response)).toEqual({ error: "not_author" }); }
    expect(await plain(await del(w, internal.id))).toEqual(stub);
    const mine = await ownNote(w, { revision: 4 });
    const stale = await del(w, mine, { expectedRevision: 1 }); expect(stale.status).toBe(409); expect((await json(stale)).error).toBe("note_conflict");
    await database.DB.prepare("UPDATE video_notes SET deleted_at = ?, body = '' WHERE id = ?").bind(Date.now(), mine).run();
    const again = await del(w, mine, { expectedRevision: 4 }); expect(again.status).toBe(409); expect(await json(again)).toEqual({ error: "note_deleted" });
    expect(await noteCount()).toBe(4); expect(await guestAudits("video_note.delete")).toEqual([]);
  });

  it("400s a body without expectedRevision", async () => {
    const w = await world(); const id = await ownNote(w);
    expect((await del(w, id, {})).status).toBe(400); expect((await del(w, id, { expectedRevision: 1, extra: true })).status).toBe(400);
  });

  it("admits one of two concurrent deletes of the same note", async () => {
    const w = await world(); const id = await ownNote(w);
    const results = await Promise.all([del(w, id), del(w, id)]);
    const stub = await stubBody(); const bodies = await Promise.all(results.map(plain));
    expect(bodies.filter((r) => r.status === 200)).toHaveLength(1); expect(bodies.filter((r) => r.status === stub.status && r.body === stub.body)).toHaveLength(1);
    expect(await guestAudits("video_note.delete")).toHaveLength(1);
  });
});

describe("the guest note DTO", () => {
  it("carries revision and self: self is true only for the viewing guest's own notes, another guest is a name, and no email or id reaches the page", async () => {
    const w = await world(); const mine = await ownNote(w); const theirs = await seedVideoNote({ assetId: w.a.assetId, guest: true }); const studio = await staffNote(w);
    const raw = await (await guestFetch(notesUrl(w), { cookie: w.link.cookie })).text();
    const notes = guestNoteListResponseSchema.parse(JSON.parse(raw)).notes;
    const byId = new Map(notes.map((note) => [note.id, note]));
    expect(byId.get(mine)).toMatchObject({ revision: 1, author: { kind: "guest", name: "Gina Guest", self: true } });
    expect(byId.get(theirs.id)).toMatchObject({ revision: 1, author: { kind: "guest", name: "Client Person", self: false } });
    expect(byId.get(studio.id)).toMatchObject({ revision: 1, author: { kind: "studio" } });
    for (const secret of ["@guest.test", "@guest-13b.test", theirs.guestId!, w.guest!.guestId, ids.member, "author_user_id"]) expect(raw, secret).not.toContain(secret);
  });

  it("shows self false to an unverified session, and 'Client reviewer' for a guest with no name", async () => {
    const w = await world({ verified: false }); const theirs = await seedVideoNote({ assetId: w.a.assetId, guest: true });
    await database.DB.prepare("UPDATE guest_reviewers SET display_name = NULL WHERE id = ?").bind(theirs.guestId).run();
    expect((await list(w))[0]!.author).toEqual({ kind: "guest", name: "Client reviewer", self: false });
  });
});

describe("leak sweep", () => {
  it("puts no internal body, staff id, other guest's email or id in any write response, 409 thread or list", async () => {
    const w = await world(); const theirs = await seedVideoNote({ assetId: w.a.assetId, guest: true, body: "their public note" });
    const internal = await staffNote(w, { visibility: "internal", body: INTERNAL }); await staffNote(w, { visibility: "internal", parentId: internal.id, body: `${INTERNAL}-reply` });
    const root = await staffNote(w, { body: "public studio note" }); await staffNote(w, { parentId: root.id, body: "public studio reply" });
    const texts: Array<[string, string]> = [];
    const keep = async (label: string, response: Response) => { texts.push([label, `${response.status} ${JSON.stringify([...response.headers])} ${await response.text()}`]); };
    const created = await create(w); const createdThread = JSON.parse(await created.clone().text()) as GuestNoteThreadDto; await keep("create", created);
    await keep("reply", await reply(w, root.id)); await keep("reply to theirs", await reply(w, theirs.id));
    await keep("edit", await edit(w, createdThread.id, { expectedRevision: 1, body: "edited" }));
    await keep("stale", await edit(w, createdThread.id, { expectedRevision: 1, body: "late" }));
    await keep("delete", await del(w, createdThread.id, { expectedRevision: 2 }));
    await keep("list", await guestFetch(notesUrl(w), { cookie: w.link.cookie }));
    await keep("hijack", await edit(w, theirs.id, { expectedRevision: 1, body: "x" })); await keep("internal", await edit(w, internal.id, { expectedRevision: 1, body: "x" }));
    const secrets = [INTERNAL, ids.member, ids.admin, ids.other, theirs.guestId!, "@guest.test", "@guest-13b.test", "author_user_id", "project_id"];
    for (const [label, text] of texts) for (const secret of secrets) expect(text, `${label} ${secret}`).not.toContain(secret);
  });
});

describe("rate limits", () => {
  it("caps a guest at 60 writes in 15 minutes: the 429 carries Retry-After, writes nothing and is spent per guest", async () => {
    const w = await world(); await seedBucket(`note:guest:${w.guest!.guestId}`, 59);
    expect((await create(w)).status).toBe(201);
    const limited = await create(w); expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0); expect(await json(limited)).toEqual({ error: "too_many_attempts", retryAfterSeconds: Number(limited.headers.get("retry-after")) });
    const root = await staffNote(w); expect((await reply(w, root.id)).status).toBe(429);
    const mine = await ownNote(w); expect((await edit(w, mine, { expectedRevision: 1, body: "x" })).status).toBe(429); expect((await del(w, mine)).status).toBe(429);
    expect(await noteCount()).toBe(3); expect((await noteRow(mine))!.revision).toBe(1);
    const second = await verifySession(w.link); expect(second.guestId).not.toBe(w.guest!.guestId);
  });

  it("caps a link at 300 writes in 15 minutes, for every guest on it", async () => {
    const w = await world(); await seedBucket(`note:link:${w.link.id}`, 299);
    expect((await create(w)).status).toBe(201);
    expect((await create(w)).status).toBe(429);
    const other = await world(); expect((await create(other)).status).toBe(201);
  });

  it("charges every write kind one attempt to both buckets", async () => {
    const w = await world(); const root = await staffNote(w);
    await create(w); await reply(w, root.id); const mine = await ownNote(w); await edit(w, mine, { expectedRevision: 1, body: "x" }); await del(w, mine, { expectedRevision: 2 });
    expect(await bucketCount(`note:guest:${w.guest!.guestId}`)).toBe(4); expect(await bucketCount(`note:link:${w.link.id}`)).toBe(4);
  });

  it("admits one of two concurrent writes at limit minus one", async () => {
    const w = await world(); await seedBucket(`note:guest:${w.guest!.guestId}`, 59);
    const results = await Promise.all([create(w), create(w)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 429]); expect(await noteCount()).toBe(1);
  });

  it("charges a write whose body is held across a window boundary to the window it completes in", async () => {
    const w = await world(); const real = Date.now.bind(Date); let offset = 0; vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
    const entry = Date.now(); const next = (Math.floor(entry / GUEST_WINDOW_MS) + 1) * GUEST_WINDOW_MS;
    const pending = slowRequest("POST", notesUrl(w), w.link.cookie, { startFrame: 10, body: "held" }, 300);
    await sleep(80); offset += next - entry + 1000;
    expect((await pending).status).toBe(201);
    const windows = async (like: string) => (await database.DB.prepare("SELECT window_start FROM guest_rate_limits WHERE bucket LIKE ?").bind(like).all<{ window_start: number }>()).results.map((row) => row.window_start);
    expect(await windows("note:guest:%")).toEqual([next]); expect(await windows("note:link:%")).toEqual([next]);
    expect(((await database.DB.prepare("SELECT created_at FROM video_notes").first<{ created_at: number }>())!.created_at)).toBeGreaterThanOrEqual(next);
  });
});

describe("reserveAttempts amount", () => {
  const bucket = () => `amount:test:${crypto.randomUUID()}`;
  it("adds the amount, refuses a reservation that would pass the limit and leaves the count alone", async () => {
    const b = bucket(); const now = Date.now();
    expect((await reserveAttempts(database.DB, [{ bucket: b, limit: 10, amount: 4 }], now)).limited).toBe(false); expect(await bucketCount(b)).toBe(4);
    expect((await reserveAttempts(database.DB, [{ bucket: b, limit: 10, amount: 6 }], now)).limited).toBe(false); expect(await bucketCount(b)).toBe(10);
    expect((await reserveAttempts(database.DB, [{ bucket: b, limit: 10, amount: 1 }], now)).limited).toBe(true); expect(await bucketCount(b)).toBe(10);
  });
  it("refuses a first reservation larger than the limit without inserting a row, and defaults to one", async () => {
    const b = bucket(); const now = Date.now();
    const over = await reserveAttempts(database.DB, [{ bucket: b, limit: 5, amount: 6 }], now); expect(over.limited).toBe(true); expect(over.retryAfterSeconds).toBeGreaterThan(0); expect(await bucketCount(b)).toBeNull();
    const one = bucket(); await reserveAttempts(database.DB, [{ bucket: one, limit: 5 }], now); expect(await bucketCount(one)).toBe(1);
    expect((await reserveAttempts(database.DB, [{ bucket: one, limit: 5, amount: 4 }], now)).limited).toBe(false); expect((await reserveAttempts(database.DB, [{ bucket: one, limit: 5, amount: 1 }], now)).limited).toBe(true);
  });
});

describe("every guest write is the stub, and writes nothing, without a live credential", () => {
  type Call = { name: string; run: (w: World, init?: Parameters<typeof guestFetch>[1]) => Promise<Response>; prepare: (w: World) => Promise<string | null> };
  const calls: Call[] = [
    { name: "create", prepare: async () => null, run: (w, init) => create(w, {}, init) },
    { name: "reply", prepare: async (w) => (await staffNote(w)).id, run: async (w, init) => reply(w, (await database.DB.prepare("SELECT id FROM video_notes WHERE parent_id IS NULL").first<{ id: string }>())!.id, {}, init) },
    { name: "edit", prepare: (w) => ownNote(w), run: async (w, init) => edit(w, (await database.DB.prepare("SELECT id FROM video_notes WHERE author_guest_id IS NOT NULL").first<{ id: string }>())!.id, { expectedRevision: 1, body: "x" }, init) },
    { name: "delete", prepare: (w) => ownNote(w), run: async (w, init) => del(w, (await database.DB.prepare("SELECT id FROM video_notes WHERE author_guest_id IS NOT NULL").first<{ id: string }>())!.id, { expectedRevision: 1 }, init) },
  ];
  const snapshot = async () => JSON.stringify([(await database.DB.prepare("SELECT id, body, revision, deleted_at, edited_at FROM video_notes ORDER BY id").all()).results, (await noteAudit()).length]);

  it("for no cookie, another link's cookie, a staff cookie alone and a mangled cookie", async () => {
    const stub = await stubBody();
    for (const call of calls) {
      const w = await world(); const other = await world(); await call.prepare(w); const before = await snapshot();
      const staff = await staffCookie("admin");
      for (const [label, cookie] of [["none", null], ["other link", other.link.cookie], ["staff", staff], ["mangled", w.link.cookie.replace("=", "=x")]] as const) {
        expect(await plain(await call.run(w, { cookie })), `${call.name} ${label}`).toEqual(stub);
      }
      expect(await snapshot(), call.name).toBe(before);
      await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("for a revoked, expired or replaced link and for a part that is off (guest, then guest_comments)", async () => {
    const stub = await stubBody();
    const changes: Array<[string, (linkId: string) => Promise<unknown>]> = [
      ["revoked", (id) => database.DB.prepare("UPDATE client_links SET revoked_at = ? WHERE id = ?").bind(Date.now(), id).run()],
      ["expired", (id) => database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, id).run()],
      ["replaced", (id) => database.DB.prepare("UPDATE client_links SET token_generation = 2 WHERE id = ?").bind(id).run()],
      ["guest part off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_guest'").run()],
      ["guest_comments part off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_guest_comments'").run()],
      ["gate closed", () => clearVideoFlags()],
    ];
    for (const call of calls) for (const [label, change] of changes) {
      await openGuestGate(); const w = await world(); await call.prepare(w); const before = await snapshot(); await change(w.link.id);
      expect(await plain(await call.run(w)), `${call.name} ${label}`).toEqual(stub);
      expect(await snapshot(), `${call.name} ${label}`).toBe(before);
      await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("403 invalid_origin for a wrong Origin or content type, spending no quota and writing nothing", async () => {
    for (const call of calls) {
      const w = await world(); await call.prepare(w); const before = await snapshot();
      for (const init of [{ origin: "https://evil.test" }, { origin: null }, { contentType: "text/plain" }, { contentType: null }]) {
        const response = await call.run(w, init); expect(response.status, `${call.name} ${JSON.stringify(init)}`).toBe(403); expect(await json(response)).toEqual({ error: "invalid_origin" });
      }
      expect(await snapshot()).toBe(before); expect(await bucketCount(`note:guest:${w.guest!.guestId}`)).toBeNull();
      await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("409 project_archived for an archived Project, after the capability and visibility answers and before the quota and the body", async () => {
    for (const call of calls) {
      const w = await world(); await call.prepare(w); const before = await snapshot(); await archive();
      const response = await call.run(w); expect(response.status, call.name).toBe(409); expect(await json(response)).toEqual({ error: "project_archived" });
      for (const init of [{ body: { nonsense: true } }, { body: "{not json" }, { body: JSON.stringify({ pad: "y".repeat(601 * 1024) }) }]) { const invalid = await call.run(w, init); expect(invalid.status, call.name).toBe(409); }
      expect(await snapshot()).toBe(before); expect(await bucketCount(`note:guest:${w.guest!.guestId}`)).toBeNull();
      await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run();
      await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("on an archived Project an unverified session is still 401, comments off is still 403 and an unreachable or internal-note target is still the stub", async () => {
    const stub = await stubBody(); const unverified = await world({ verified: false }); const noComments = await world({ link: { allow: [0, 1, 1] } }); const w = await world();
    const internal = await staffNote(w, { visibility: "internal" }); await archive();
    const unverifiedAnswer = await create(unverified); expect(unverifiedAnswer.status).toBe(401); expect(await json(unverifiedAnswer)).toEqual({ error: "verification_required" });
    const commentsAnswer = await create(noComments); expect(commentsAnswer.status).toBe(403); expect(await json(commentsAnswer)).toEqual({ error: "comments_disabled" });
    expect(await plain(await reply(w, internal.id))).toEqual(stub);
    expect(await plain(await edit(w, internal.id, { expectedRevision: 1, body: "x" }))).toEqual(stub);
    expect(await plain(await del(w, internal.id))).toEqual(stub);
    expect(await plain(await guestFetch(notesUrl(w, w.a2.assetId), { method: "POST", cookie: w.link.cookie, body: { startFrame: 10, body: "x" } }))).toEqual(stub);
    expect(await plain(await reply(w, crypto.randomUUID()))).toEqual(stub);
  });

  it("charges every invalid body (400, 413, 422) one attempt in each bucket", async () => {
    await setVideoFlags("video_review_markup");
    for (const call of calls) {
      const w = await world(); await call.prepare(w); const guestBucket = `note:guest:${w.guest!.guestId}`; const linkBucket = `note:link:${w.link.id}`;
      const invalid: Array<[number, Parameters<typeof guestFetch>[1]]> = [[400, { body: { nonsense: true } }], [400, { body: "{not json" }], [413, { body: JSON.stringify({ pad: "y".repeat(601 * 1024) }) }]];
      if (call.name === "create") invalid.push([422, { body: { startFrame: 250, body: "x" } }]);
      let count = 0;
      for (const [status, init] of invalid) {
        const response = await call.run(w, init); expect(response.status, `${call.name} ${status}`).toBe(status); count += 1;
        expect(await bucketCount(guestBucket), `${call.name} ${status} guest`).toBe(count); expect(await bucketCount(linkBucket), `${call.name} ${status} link`).toBe(count);
      }
      await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("an invalid body after the quota is exhausted is 429, not 400, 413 or 422", async () => {
    for (const call of calls) {
      const w = await world(); await call.prepare(w); await seedBucket(`note:guest:${w.guest!.guestId}`, 60);
      for (const init of [{ body: { nonsense: true } }, { body: "{not json" }, { body: JSON.stringify({ pad: "y".repeat(601 * 1024) }) }, ...(call.name === "create" ? [{ body: { startFrame: 250, body: "x" } }] : [])]) {
        const response = await call.run(w, init); expect(response.status, call.name).toBe(429); expect(response.headers.get("retry-after")).not.toBeNull();
      }
      await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("with the markup part off, a drawing body is the byte-identical stub for an unverified session, a wrong Origin and no cookie", async () => {
    const stub = await stubBody();
    for (const call of calls) {
      const w = await world(); await call.prepare(w); const unverified = await world({ verified: false }); const before = await snapshot();
      const drawn = { body: { startFrame: 10, body: "x", expectedRevision: 1, drawingFrame: 10, markup: MARKUP } };
      expect(await plain(await call.run(unverified, drawn)), `${call.name} unverified`).toEqual(stub);
      expect(await plain(await call.run(w, { ...drawn, origin: "https://evil.test" })), `${call.name} origin`).toEqual(stub);
      expect(await plain(await call.run(w, { ...drawn, contentType: "text/plain" })), `${call.name} content type`).toEqual(stub);
      expect(await plain(await call.run(w, { ...drawn, cookie: null })), `${call.name} no cookie`).toEqual(stub);
      expect(await snapshot()).toBe(before); expect(await bucketCount(`note:guest:${w.guest!.guestId}`)).toBeNull();
      await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("an oversized body from an unverified session is 401, not 413, and from a wrong Origin is 403", async () => {
    const unverified = await world({ verified: false }); const huge = JSON.stringify({ startFrame: 10, body: "x", pad: "y".repeat(601 * 1024) });
    const response = await create(unverified, {}, { body: huge }); expect(response.status).toBe(401); expect(await json(response)).toEqual({ error: "verification_required" });
    const w = await world(); const origin = await create(w, {}, { body: huge, origin: "https://evil.test" }); expect(origin.status).toBe(403);
    expect(await bucketCount(`note:guest:${w.guest!.guestId}`)).toBeNull();
  });

  it("answers a guest cookie on the staff twin with 401", async () => {
    const w = await world(); const root = await staffNote(w);
    const headers = { cookie: w.link.cookie, origin: guestOrigin, "content-type": "application/json" };
    const attempts: Array<[string, string, unknown]> = [
      ["POST", `/api/projects/${ids.project}/video-versions/${w.a.assetId}/notes`, { startFrame: 1, visibility: "public", body: "x" }],
      ["POST", `/api/projects/${ids.project}/video-notes/${root.id}/replies`, { body: "x" }],
      ["PATCH", `/api/projects/${ids.project}/video-notes/${root.id}`, { expectedRevision: 1, body: "x" }],
      ["DELETE", `/api/projects/${ids.project}/video-notes/${root.id}`, { expectedRevision: 1 }],
    ];
    for (const [method, path, body] of attempts) expect((await workerSelf.fetch(`https://portal.test${path}`, { method, headers, body: JSON.stringify(body) })).status, `${method} ${path}`).toBe(401);
  });
});

describe("the committing SQL repeats what the entry checked", () => {
  /** A write whose body arrives late, and the target state it needs. */
  type Held = { name: string; setup: (w: World) => Promise<string | null>; send: (w: World, target: string | null) => Promise<Response> };
  const held: Held[] = [
    { name: "create", setup: async () => null, send: (w) => slowRequest("POST", notesUrl(w), w.link.cookie, { startFrame: 10, body: "held" }, 300) },
    { name: "reply", setup: async (w) => (await staffNote(w)).id, send: (w, id) => slowRequest("POST", `${noteUrl(w, id!)}/replies`, w.link.cookie, { body: "held" }, 300) },
    { name: "edit", setup: (w) => ownNote(w), send: (w, id) => slowRequest("PATCH", noteUrl(w, id!), w.link.cookie, { expectedRevision: 1, body: "held" }, 300) },
    { name: "delete", setup: (w) => ownNote(w), send: (w, id) => slowRequest("DELETE", noteUrl(w, id!), w.link.cookie, { expectedRevision: 1 }, 300) },
  ];
  const revoke = (w: World) => database.DB.batch([database.DB.prepare("UPDATE client_links SET revoked_at = ? WHERE id = ?").bind(Date.now(), w.link.id), database.DB.prepare("DELETE FROM guest_sessions WHERE link_id = ?").bind(w.link.id)]);
  const replace = (w: World) => database.DB.batch([database.DB.prepare("UPDATE client_links SET token_generation = token_generation + 1 WHERE id = ?").bind(w.link.id), database.DB.prepare("DELETE FROM guest_sessions WHERE link_id = ?").bind(w.link.id)]);
  const stubTransitions: Array<[string, (w: World) => Promise<unknown>]> = [
    ["revoke", revoke], ["replace", replace],
    ["expiry", (w) => database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, w.link.id).run()],
    ["session expiry", (w) => database.DB.prepare("UPDATE guest_sessions SET expires_at = ? WHERE link_id = ?").bind(Date.now() - 1, w.link.id).run()],
    ["guest part off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_guest'").run()],
    ["guest_comments part off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_guest_comments'").run()],
    ["gate close", () => clearVideoFlags()],
    ["grant revoked", (w) => database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE link_id = ?").bind(Date.now(), ids.member, w.link.id).run()],
    ["Video removed", (w) => database.DB.prepare("UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE link_id = ?").bind(Date.now(), ids.member, w.link.id).run()],
  ];
  const snapshot = async () => JSON.stringify([(await database.DB.prepare("SELECT id, body, revision, deleted_at FROM video_notes ORDER BY id").all()).results, (await noteAudit()).length]);

  it("a revoke, replace, expiry, part-off, gate close, ungrant or Video removal while the body is pending is the exact stub, and nothing is written", async () => {
    const stub = await stubBody();
    for (const call of held) for (const [label, change] of stubTransitions) {
      await openGuestGate(); const w = await world(); const target = await call.setup(w); const before = await snapshot();
      const pending = call.send(w, target); await sleep(80); await change(w);
      expect(await plain(await pending), `${call.name} ${label}`).toEqual(stub);
      expect(await snapshot(), `${call.name} ${label}`).toBe(before);
      await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("an archive that lands while the body is pending is 409 project_archived and writes nothing", async () => {
    for (const call of held) {
      const w = await world(); const target = await call.setup(w); const before = await snapshot();
      const pending = call.send(w, target); await sleep(80); await archive();
      const response = await pending; expect(response.status, call.name).toBe(409); expect(await json(response)).toEqual({ error: "project_archived" });
      expect(await snapshot(), call.name).toBe(before);
      await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run(); await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("comments switched off on the link while the body is pending is 403 comments_disabled and writes nothing", async () => {
    for (const call of held) {
      const w = await world(); const target = await call.setup(w); const before = await snapshot();
      const pending = call.send(w, target); await sleep(80); await database.DB.prepare("UPDATE client_links SET allow_comments = 0 WHERE id = ?").bind(w.link.id).run();
      const response = await pending; expect(response.status, call.name).toBe(403); expect(await json(response)).toEqual({ error: "comments_disabled" });
      expect(await snapshot(), call.name).toBe(before); await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("the markup part switched off while a markup body is pending is the stub", async () => {
    const w = await world(); await setVideoFlags("video_review_markup"); const stub = await stubBody();
    const pending = slowRequest("POST", notesUrl(w), w.link.cookie, { startFrame: 10, body: "held", markup: MARKUP, drawingFrame: 10 }, 300);
    await sleep(80); await database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_markup'").run();
    expect(await plain(await pending)).toEqual(stub); expect(await noteCount()).toBe(0); expect(await markupCount()).toBe(0);
  });

  it("a quota 429, a 400 and a 413 held across a transition are the refusal, not 429, 400 or 413", async () => {
    const stub = await stubBody();
    const bodies: Array<[string, (w: World) => Promise<Response>]> = [
      ["429", async (w) => { await seedBucket(`note:guest:${w.guest!.guestId}`, 60); return slowRequest("POST", notesUrl(w), w.link.cookie, { startFrame: 10, body: "held" }, 300); }],
      ["400", async (w) => slowRequest("POST", notesUrl(w), w.link.cookie, { nonsense: true }, 300)],
      ["413", async (w) => slowRequest("POST", notesUrl(w), w.link.cookie, JSON.stringify({ startFrame: 10, body: "x", pad: "y".repeat(601 * 1024) }), 300)],
    ];
    for (const [label, send] of bodies) for (const [change, kind] of [[revoke, "stub"], [archive, "archived"]] as const) {
      await openGuestGate(); await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run();
      const w = await world(); const promise = send(w); await sleep(80); await change(w);
      const response = await promise;
      if (kind === "stub") expect(await plain(response), `${label} ${kind}`).toEqual(stub); else { expect(response.status, `${label} ${kind}`).toBe(409); expect(await json(response)).toEqual({ error: "project_archived" }); }
      await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("a verified session that stops being the one the write saw (token rotated) writes nothing", async () => {
    const w = await world(); const before = await snapshot();
    const pending = slowRequest("POST", notesUrl(w), w.link.cookie, { startFrame: 10, body: "held" }, 300);
    await sleep(80); await database.DB.prepare("UPDATE guest_sessions SET token_hash = 'rotated' WHERE link_id = ?").bind(w.link.id).run();
    expect(await plain(await pending)).toEqual(await stubBody()); expect(await snapshot()).toBe(before);
  });

  it("a delete racing a studio reply tombstones instead of removing the reply (the hard-delete test and the DELETE are one batch)", async () => {
    const w = await world(); const id = await ownNote(w);
    const pending = slowRequest("DELETE", noteUrl(w, id), w.link.cookie, { expectedRevision: 1 }, 300);
    await sleep(80); await staffNote(w, { parentId: id });
    const result = guestNoteDeleteResponseSchema.parse(await (await pending).json());
    expect(result.thread).toMatchObject({ id, deleted: true }); expect(await noteCount()).toBe(2);
  });
});

describe("the SQL fence on its own (a write that bypasses the route inserts, changes and audits nothing)", () => {
  /** The writer a route would build, for the world's guest; `change` then breaks one thing the fence checks. */
  const writerOf = async (w: World, markup = false): Promise<NoteAuthor> => ({ kind: "guest", guestId: w.guest!.guestId, sessionId: w.guest!.sessionId, linkId: w.link.id, tokenHash: await hashToken(w.link.cookie.split("=")[1]!), markup });
  type Op = { name: string; prepare: (w: World) => Promise<string | null>; run: (w: World, target: string | null, author: NoteAuthor) => Promise<string> };
  const projectId = ids.project;
  const ops: Op[] = [
    { name: "create", prepare: async () => null, run: async (w, _t, author) => (await createVideoNote(database.DB, { projectId, assetId: w.a.assetId, author, visibility: "public", startFrame: 10, endFrame: null, body: "bypass", now: Date.now() })).kind },
    { name: "reply", prepare: async (w) => (await staffNote(w)).id, run: async (w, id, author) => (await createVideoNoteReply(database.DB, { projectId, parent: (await findNoteHead(database.DB, projectId, id!))!, author, body: "bypass", now: Date.now() })).kind },
    { name: "edit", prepare: (w) => ownNote(w), run: async (w, id, author) => (await editVideoNote(database.DB, { projectId, note: (await findNoteHead(database.DB, projectId, id!))!, author, expectedRevision: 1, body: "bypass", startFrame: 10, endFrame: null, now: Date.now() })).kind },
    { name: "delete", prepare: (w) => ownNote(w), run: async (w, id, author) => (await deleteVideoNote(database.DB, { projectId, note: (await findNoteHead(database.DB, projectId, id!))!, author, expectedRevision: 1, now: Date.now() })).kind },
  ];
  const breaks: Array<[string, (w: World) => Promise<unknown>, boolean?]> = [
    ["revoked", (w) => database.DB.prepare("UPDATE client_links SET revoked_at = ? WHERE id = ?").bind(Date.now(), w.link.id).run()],
    ["expired", (w) => database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, w.link.id).run()],
    ["replaced", (w) => database.DB.prepare("UPDATE client_links SET token_generation = 2 WHERE id = ?").bind(w.link.id).run()],
    ["session expired", (w) => database.DB.prepare("UPDATE guest_sessions SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, w.guest!.sessionId).run()],
    ["token rotated", (w) => database.DB.prepare("UPDATE guest_sessions SET token_hash = 'rotated' WHERE id = ?").bind(w.guest!.sessionId).run()],
    ["not verified", (w) => database.DB.prepare("UPDATE guest_sessions SET guest_id = NULL, verified_at = NULL WHERE id = ?").bind(w.guest!.sessionId).run()],
    ["another guest", async (w) => { const other = crypto.randomUUID(); await database.DB.batch([database.DB.prepare("INSERT INTO guest_reviewers (id, email_normalized, display_name, created_at) VALUES (?, ?, 'Other', ?)").bind(other, `${other}@guest-13b.test`, Date.now()), database.DB.prepare("UPDATE guest_sessions SET guest_id = ? WHERE id = ?").bind(other, w.guest!.sessionId)]); }],
    ["guest part off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_guest'").run()],
    ["guest_comments part off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_guest_comments'").run()],
    ["master off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review'").run()],
    ["Project out of the pilot", () => database.DB.prepare("DELETE FROM feature_flags WHERE key LIKE 'video_review_pilot:%'").run()],
    ["comments off on the link", (w) => database.DB.prepare("UPDATE client_links SET allow_comments = 0 WHERE id = ?").bind(w.link.id).run()],
    ["grant revoked", (w) => database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE link_id = ?").bind(Date.now(), ids.member, w.link.id).run()],
    ["Video removed", (w) => database.DB.prepare("UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE link_id = ?").bind(Date.now(), ids.member, w.link.id).run()],
    ["Project archived", () => archive()],
  ];
  const snapshot = async () => JSON.stringify([(await database.DB.prepare("SELECT id, body, revision, deleted_at, edited_at FROM video_notes ORDER BY id").all()).results, (await noteAudit()).length, await markupCount()]);

  it("writes nothing under any broken fence, and writes under an intact one", async () => {
    for (const op of ops) {
      const control = await world(); const controlTarget = await op.prepare(control);
      expect(await op.run(control, controlTarget, await writerOf(control)), `${op.name} control`).toBe("ok");
      expect((await noteAudit()).length, `${op.name} control`).toBe(1);
      await clearVideoNotes(); await clearGuestRows(); await openGuestGate();
      for (const [label, change] of breaks) {
        const w = await world(); const target = await op.prepare(w); const before = await snapshot(); await change(w);
        expect(await op.run(w, target, await writerOf(w)), `${op.name} ${label}`).not.toBe("ok");
        expect(await snapshot(), `${op.name} ${label}`).toBe(before);
        await clearVideoNotes(); await clearGuestRows(); await openGuestGate();
        await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run();
      }
    }
  });

  it("needs the markup part when the writer says the write carries a drawing", async () => {
    const w = await world(); await setVideoFlags("video_review_markup");
    const drawn = { json: JSON.stringify(MARKUP), items: 1, bytes: 10, drawingFrame: 10 };
    const write = async (author: NoteAuthor) => (await createVideoNote(database.DB, { projectId, assetId: w.a.assetId, author, visibility: "public", startFrame: 10, endFrame: null, body: "drawn", markup: drawn, now: Date.now() })).kind;
    await database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_markup'").run();
    expect(await write(await writerOf(w, true))).not.toBe("ok"); expect(await noteCount()).toBe(0); expect(await markupCount()).toBe(0);
    await setVideoFlags("video_review_markup");
    expect(await write(await writerOf(w, true))).toBe("ok"); expect(await markupCount()).toBe(1);
  });

  it("is refused by the author test itself for a note that is not the guest's (the UPDATE and the DELETE carry the author)", async () => {
    const w = await world(); const theirs = await seedVideoNote({ assetId: w.a.assetId, guest: true });
    const head = (await findNoteHead(database.DB, projectId, theirs.id))!;
    expect((await editVideoNote(database.DB, { projectId, note: head, author: await writerOf(w), expectedRevision: 1, body: "x", startFrame: 10, endFrame: null, now: Date.now() })).kind).toBe("forbidden");
    expect((await deleteVideoNote(database.DB, { projectId, note: head, author: await writerOf(w), expectedRevision: 1, now: Date.now() })).kind).toBe("forbidden");
    expect(await noteRow(theirs.id)).toMatchObject({ body: "Seeded note", revision: 1, deleted_at: null });
  });
});
