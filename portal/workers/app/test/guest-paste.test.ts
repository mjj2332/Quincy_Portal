import { SELF as workerSelf } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { guestNotePasteCommitResponseSchema, guestNotePastePreviewResponseSchema, guestNotePasteStaleSchema, type GuestNotePasteRow } from "@quincy/shared";
import { hashToken } from "../src/lib/opaque-token";
import { commitNotePaste } from "../src/lib/video-note-paste";
import { cookie as staffCookie, database, ids, seedFixture } from "./embedded-media-support";
import { addMember, clearGuestRows, GUEST_WINDOW_MS, grant, guestFetch, guestOrigin, linkPath, linkWithSession, openGuestGate, slowRequest, verifySession, type LinkInput } from "./guest-support";
import { clearVideoFlags, clearVideoNotes, noteAudit, noteRow, seedVideoNote, seedVideoVersion, setVideoFlags, SEED_STROKES_JSON } from "./video-review-support";

/** Guest note paste (#741 13d): a verified guest copies their OWN notes from one granted Version of a Video onto another, behind the same fence as every guest write. */
type Json = Record<string, any>;
const json = async (response: Response) => await response.json() as Json;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const INTERNAL = "INTERNAL-ONLY-secret-feedback";
const STAFF_BODY = "STUDIO-NOTE-body-text";
const OTHER_BODY = "OTHER-GUEST-body-text";

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
/** A verified guest on a link that holds Video A with BOTH Versions granted (v1 the source, v2 the target). `link.cookie` is the guest's. */
async function world(input: { link?: LinkInput; verified?: boolean; name?: string | null; grantTarget?: boolean; grantSource?: boolean } = {}) {
  const a = await seedVideoVersion({ title: "Hero film" });
  const a2 = await seedVideoVersion({ projectId: a.projectId, videoId: a.videoId, version: 2 });
  const link = await linkWithSession(input.link);
  await addMember(link.id, a.videoId, [...(input.grantSource === false ? [] : [a.assetId]), ...(input.grantTarget === false ? [] : [a2.assetId])]);
  const guest = input.verified === false ? null : await verifySession(link, { name: input.name });
  return { link, a, a2, guest };
}
const previewUrl = (w: World, target: string = w.a2.assetId) => linkPath(w.link.id, `/versions/${target}/note-paste/preview`);
const commitUrl = (w: World, target: string = w.a2.assetId) => linkPath(w.link.id, `/versions/${target}/note-paste`);
const previewBody = (w: World, noteIds: string[], extra: Json = {}) => ({ sourceAssetId: w.a.assetId, noteIds, ...extra });
const preview = (w: World, noteIds: string[], init: Parameters<typeof guestFetch>[1] = {}, extra: Json = {}) => guestFetch(previewUrl(w), { method: "POST", cookie: w.link.cookie, body: previewBody(w, noteIds, extra), ...init });
const commit = (w: World, notes: Array<{ noteId: string; revision: number }>, init: Parameters<typeof guestFetch>[1] = {}, extra: Json = {}) => guestFetch(commitUrl(w), { method: "POST", cookie: w.link.cookie, body: { sourceAssetId: w.a.assetId, notes, ...extra }, ...init });
const revisions = (ids_: string[]) => ids_.map((noteId) => ({ noteId, revision: 1 }));

/** A note the world's guest wrote on `assetId` (default v1), inserted directly. */
async function ownNote(w: World, input: { parentId?: string; assetId?: string; body?: string; startFrame?: number; endFrame?: number | null; revision?: number; markup?: boolean; deleted?: boolean } = {}) {
  const id = crypto.randomUUID(); const now = Date.now(); const reply = input.parentId !== undefined;
  await database.DB.prepare("INSERT INTO video_notes (id, project_id, video_id, asset_id, parent_id, author_user_id, author_guest_id, author_role, visibility, start_frame, end_frame, drawing_frame, body, revision, deleted_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 'guest', 'public', ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, w.a.projectId, w.a.videoId, input.assetId ?? w.a.assetId, input.parentId ?? null, w.guest!.guestId, reply ? null : input.startFrame ?? 10, reply ? null : input.endFrame ?? null, input.markup && !reply ? input.startFrame ?? 10 : null, input.body ?? "My note", input.revision ?? 1, input.deleted ? now : null, now).run();
  if (input.markup) await database.DB.prepare("INSERT INTO video_note_markup (note_id, strokes_json, created_at, updated_at) VALUES (?, ?, ?, ?)").bind(id, SEED_STROKES_JSON, now, now).run();
  return id;
}
const noteCount = async () => (await database.DB.prepare("SELECT COUNT(*) AS n FROM video_notes").first<{ n: number }>())!.n;
const markupCount = async () => (await database.DB.prepare("SELECT COUNT(*) AS n FROM video_note_markup").first<{ n: number }>())!.n;
const pasteAudits = async () => (await noteAudit("video_note.paste")).map((row) => ({ ...row, meta: row.meta_json ? JSON.parse(row.meta_json) as Json : null }));
const copyOf = (sourceId: string, target: string) => database.DB.prepare("SELECT * FROM video_notes WHERE copied_from_note_id = ? AND asset_id = ?").bind(sourceId, target).first<Record<string, any>>();
const stubBody = async () => { const stub = await guestFetch("/d"); return { status: stub.status, body: await stub.text() }; };
const plain = async (response: Response) => ({ status: response.status, body: await response.text() });
const archive = () => database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run();
const seedBucket = (bucket: string, count: number) => database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?1, ?2, ?3)").bind(bucket, Math.floor(Date.now() / GUEST_WINDOW_MS) * GUEST_WINDOW_MS, count).run();
const bucketCount = async (bucket: string) => (await database.DB.prepare("SELECT count FROM guest_rate_limits WHERE bucket = ?").bind(bucket).first<{ count: number }>())?.count ?? null;
const parsePreview = async (response: Response) => { expect(response.status, await response.clone().text()).toBe(200); return guestNotePastePreviewResponseSchema.parse(await response.json()); };
const parseCommit = async (response: Response) => { expect(response.status, await response.clone().text()).toBe(200); return guestNotePasteCommitResponseSchema.parse(await response.json()); };
/** The commit body a page builds from a preview: a revision for every row that carries a source. */
const commitFrom = (rows: GuestNotePasteRow[]) => rows.flatMap((row) => (row.status === "skipped" ? (row.source ? [{ noteId: row.noteId, revision: row.source.revision }] : []) : [{ noteId: row.noteId, revision: row.source.revision }]));

describe("previewing a paste", () => {
  it("maps the guest's own notes onto the target Version and writes nothing", async () => {
    const w = await world(); const point = await ownNote(w, { startFrame: 10, body: "  First\n note  " }); const range = await ownNote(w, { startFrame: 20, endFrame: 40, body: "Second" });
    const result = await parsePreview(await preview(w, [point, range]));
    expect(result).toMatchObject({ sourceVersion: 1, targetVersion: 2, offsetFrames: 0 });
    expect(result.rows).toEqual([
      { noteId: point, status: "mapped", source: { revision: 1, visibility: "public", authorName: "Gina Guest", excerpt: "First note", from: { startFrame: 10, endFrame: null } }, to: { startFrame: 10, endFrame: null }, shortened: false },
      { noteId: range, status: "mapped", source: { revision: 1, visibility: "public", authorName: "Gina Guest", excerpt: "Second", from: { startFrame: 20, endFrame: 40 } }, to: { startFrame: 20, endFrame: 40 }, shortened: false },
    ]);
    expect(await noteCount()).toBe(2); expect(await pasteAudits()).toEqual([]);
  });

  it("applies the offset the staff paste applies, and skips a note the offset pushes out of range", async () => {
    const w = await world(); const near = await ownNote(w, { startFrame: 10 }); const far = await ownNote(w, { startFrame: 240 });
    const result = await parsePreview(await preview(w, [near, far], {}, { offsetFrames: 20 }));
    expect(result.rows[0]).toMatchObject({ status: "mapped", to: { startFrame: 30 } });
    expect(result.rows[1]).toMatchObject({ status: "skipped", reason: "out_of_range" });
  });

  it("skips what is not the guest's as not_author with no source: another guest's note, a studio note, an internal note and an unknown id look the same", async () => {
    const w = await world(); const mine = await ownNote(w);
    const theirs = await seedVideoNote({ assetId: w.a.assetId, guest: true, body: OTHER_BODY }); const studio = await seedVideoNote({ assetId: w.a.assetId, body: STAFF_BODY });
    const internal = await seedVideoNote({ assetId: w.a.assetId, visibility: "internal", body: INTERNAL }); const unknown = crypto.randomUUID();
    const response = await preview(w, [theirs.id, studio.id, internal.id, unknown, mine]);
    const text = await response.clone().text();
    for (const secret of [OTHER_BODY, STAFF_BODY, INTERNAL, "Client Person"]) expect(text, secret).not.toContain(secret);
    const result = await parsePreview(response);
    expect(result.rows.map((row) => [row.noteId, row.status, row.status === "skipped" ? row.reason : null, row.status === "skipped" ? row.source : "n/a"])).toEqual([
      [theirs.id, "skipped", "not_author", null], [studio.id, "skipped", "not_author", null], [internal.id, "skipped", "not_author", null], [unknown, "skipped", "not_author", null], [mine, "mapped", null, "n/a"],
    ]);
  });

  it("skips an own reply as reply, an own tombstone as deleted (no excerpt) and a note already on the target as already_copied", async () => {
    const w = await world(); const root = await ownNote(w); const replyId = await ownNote(w, { parentId: root }); const gone = await ownNote(w, { deleted: true, body: "was here" });
    const done = await ownNote(w, { startFrame: 50 }); await commit(w, revisions([done]));
    const result = await parsePreview(await preview(w, [replyId, gone, done]));
    expect(result.rows).toMatchObject([{ status: "skipped", reason: "reply" }, { status: "skipped", reason: "deleted", source: { excerpt: "" } }, { status: "skipped", reason: "already_copied" }]);
  });

  it("charges one attempt to each note bucket", async () => {
    const w = await world(); const note = await ownNote(w);
    await parsePreview(await preview(w, [note]));
    expect(await bucketCount(`note:guest:${w.guest!.guestId}`)).toBe(1); expect(await bucketCount(`note:link:${w.link.id}`)).toBe(1);
  });
});

describe("committing a paste", () => {
  it("copies the guest's notes onto the target as the same guest, public, with the original author, and writes ONE audit row", async () => {
    const w = await world(); const point = await ownNote(w, { startFrame: 10, body: "Fix the logo" }); const range = await ownNote(w, { startFrame: 20, endFrame: 40, body: "Soften this" });
    const result = await parseCommit(await commit(w, revisions([point, range])));
    expect(result).toMatchObject({ sourceVersion: 1, targetVersion: 2, copied: 2, skipped: 0 });
    for (const [sourceId, body, start, end] of [[point, "Fix the logo", 10, null], [range, "Soften this", 20, 40]] as const) {
      const copy = (await copyOf(sourceId, w.a2.assetId))!;
      expect(copy).toMatchObject({
        author_user_id: null, author_guest_id: w.guest!.guestId, author_role: "guest", visibility: "public", project_id: w.a.projectId, video_id: w.a.videoId, asset_id: w.a2.assetId, parent_id: null,
        body, start_frame: start, end_frame: end, revision: 1, copied_from_version: 1, original_author_name: "Gina Guest", original_author_role: "guest", deleted_at: null, resolved_at: null,
      });
      expect(result.rows.find((row) => row.noteId === sourceId)).toMatchObject({ status: "copied", copyId: copy.id });
    }
    const audits = await pasteAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_id: null, action: "video_note.paste", target_id: w.a2.assetId });
    expect(audits[0]!.meta).toMatchObject({
      guest: { guestId: w.guest!.guestId, sessionId: w.guest!.sessionId }, linkId: w.link.id, projectId: w.a.projectId, videoId: w.a.videoId, sourceAssetId: w.a.assetId, targetAssetId: w.a2.assetId,
      sourceVersion: 1, targetVersion: 2, requested: 2, mapped: 2, copied: 2, skipped: 0,
    });
    expect(audits[0]!.meta).not.toHaveProperty("principal");
  });

  it("shows the copies in the target's note list as the guest's own", async () => {
    const w = await world(); const note = await ownNote(w, { body: "Carry me" }); await parseCommit(await commit(w, revisions([note])));
    const listed = await json(await guestFetch(linkPath(w.link.id, `/versions/${w.a2.assetId}/notes`), { cookie: w.link.cookie }));
    expect(listed.notes).toHaveLength(1); expect(listed.notes[0]).toMatchObject({ body: "Carry me", author: { kind: "guest", name: "Gina Guest", self: true } });
  });

  it("copies a drawing with its note", async () => {
    const w = await world(); await setVideoFlags("video_review_markup"); const drawn = await ownNote(w, { startFrame: 30, markup: true });
    const result = await parseCommit(await commit(w, revisions([drawn])));
    expect(result.copied).toBe(1);
    const copy = (await copyOf(drawn, w.a2.assetId))!;
    expect(copy.drawing_frame).toBe(30); expect(await markupCount()).toBe(2);
    expect((await database.DB.prepare("SELECT strokes_json FROM video_note_markup WHERE note_id = ?").bind(copy.id).first<{ strokes_json: string }>())!.strokes_json).toBe(SEED_STROKES_JSON);
  });

  it("keeps the original author through a second hop (a copy of a copy)", async () => {
    const w = await world(); const a3 = await seedVideoVersion({ projectId: w.a.projectId, videoId: w.a.videoId, version: 3 }); await grant(w.link.id, w.a.videoId, a3.assetId);
    const note = await ownNote(w); await parseCommit(await commit(w, revisions([note])));
    const hop = (await copyOf(note, w.a2.assetId))!;
    const response = await guestFetch(commitUrl(w, a3.assetId), { method: "POST", cookie: w.link.cookie, body: { sourceAssetId: w.a2.assetId, notes: [{ noteId: hop.id, revision: 1 }] } });
    expect((await parseCommit(response)).copied).toBe(1);
    expect(await copyOf(hop.id, a3.assetId)).toMatchObject({ author_guest_id: w.guest!.guestId, original_author_name: "Gina Guest", original_author_role: "guest", copied_from_version: 2 });
  });

  it("agrees with its preview: the rows it copies are the rows the preview mapped", async () => {
    const w = await world(); const a = await ownNote(w, { startFrame: 10 }); const b = await ownNote(w, { startFrame: 20, endFrame: 50 }); const skip = await ownNote(w, { startFrame: 240 });
    const theirs = await seedVideoNote({ assetId: w.a.assetId, guest: true });
    const planned = await parsePreview(await preview(w, [a, b, skip, theirs.id], {}, { offsetFrames: 20 }));
    const result = await parseCommit(await commit(w, commitFrom(planned.rows), {}, { offsetFrames: 20 }));
    expect(result.rows.filter((row) => row.status !== "skipped").map((row) => [row.noteId, row.status === "copied" && row.to, row.status === "copied" && row.shortened]))
      .toEqual(planned.rows.filter((row) => row.status === "mapped").map((row) => [row.noteId, row.to, row.shortened]));
    expect(result.copied).toBe(planned.rows.filter((row) => row.status === "mapped").length);
    expect(await copyOf(a, w.a2.assetId)).toMatchObject({ start_frame: 30 });
    expect(await copyOf(skip, w.a2.assetId)).toBeNull(); expect(await copyOf(theirs.id, w.a2.assetId)).toBeNull();
  });

  it("copies only the guest's notes when the request names others (their revision is unknown to the guest, so the commit answers stale), and writes nothing", async () => {
    const w = await world(); const mine = await ownNote(w); const theirs = await seedVideoNote({ assetId: w.a.assetId, guest: true, body: OTHER_BODY });
    const before = await noteCount();
    const response = await commit(w, [{ noteId: mine, revision: 1 }, { noteId: theirs.id, revision: 1 }]);
    expect(response.status).toBe(409); const stale = guestNotePasteStaleSchema.parse(await response.json());
    expect(stale.preview.rows.map((row) => row.status === "skipped" ? row.reason : row.status)).toEqual(["mapped", "not_author"]);
    expect(JSON.stringify(stale)).not.toContain(OTHER_BODY);
    expect(await noteCount()).toBe(before); expect(await pasteAudits()).toEqual([]);
  });

  it("is idempotent: a repeat finds every copy in place, copies nothing, and the copy keeps its single row", async () => {
    const w = await world(); const note = await ownNote(w);
    expect((await parseCommit(await commit(w, revisions([note])))).copied).toBe(1);
    const again = await parseCommit(await commit(w, revisions([note])));
    expect(again).toMatchObject({ copied: 0, skipped: 1 }); expect(again.rows[0]).toMatchObject({ status: "skipped", reason: "already_copied" });
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM video_notes WHERE copied_from_note_id = ?").bind(note).first<{ n: number }>())!.n).toBe(1);
    const audits = await pasteAudits(); expect(audits).toHaveLength(2); expect(audits[1]!.meta).toMatchObject({ copied: 0, skipped: 1 });
  });

  it("admits one of two concurrent commits of the same note", async () => {
    const w = await world(); const note = await ownNote(w);
    const responses = await Promise.all([commit(w, revisions([note])), commit(w, revisions([note]))]);
    const results = await Promise.all(responses.map(parseCommit));
    expect(results.map((result) => result.copied).sort()).toEqual([0, 1]);
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM video_notes WHERE copied_from_note_id = ?").bind(note).first<{ n: number }>())!.n).toBe(1);
  });

  it("409s paste_stale with the fresh preview when a source note changed since the preview, and writes nothing", async () => {
    const w = await world(); const note = await ownNote(w); await database.DB.prepare("UPDATE video_notes SET revision = 2, body = 'edited since' WHERE id = ?").bind(note).run();
    const response = await commit(w, revisions([note]));
    expect(response.status).toBe(409); const stale = guestNotePasteStaleSchema.parse(await response.json());
    expect(stale.preview.rows[0]).toMatchObject({ status: "mapped", source: { revision: 2, excerpt: "edited since" } });
    expect(await copyOf(note, w.a2.assetId)).toBeNull(); expect(await pasteAudits()).toEqual([]);
  });

  it("charges the number of notes it requests to both note buckets", async () => {
    const w = await world(); const notes = [await ownNote(w, { startFrame: 10 }), await ownNote(w, { startFrame: 11 }), await ownNote(w, { startFrame: 12 })];
    await parseCommit(await commit(w, revisions(notes)));
    expect(await bucketCount(`note:guest:${w.guest!.guestId}`)).toBe(3); expect(await bucketCount(`note:link:${w.link.id}`)).toBe(3);
  });

  it("429s a paste that would pass the guest's quota, with Retry-After, writing nothing and charging nothing", async () => {
    const w = await world(); const notes = [await ownNote(w, { startFrame: 10 }), await ownNote(w, { startFrame: 11 })];
    await seedBucket(`note:guest:${w.guest!.guestId}`, 59);
    const response = await commit(w, revisions(notes)); expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBeTruthy();
    expect(await bucketCount(`note:guest:${w.guest!.guestId}`)).toBe(59); expect(await noteCount()).toBe(2); expect(await pasteAudits()).toEqual([]);
    const one = await commit(w, revisions([notes[0]!])); expect(one.status).toBe(200);
  });

  it("is counted against the link's note quota as well", async () => {
    const w = await world(); const note = await ownNote(w); await seedBucket(`note:link:${w.link.id}`, 300);
    expect((await commit(w, revisions([note]))).status).toBe(429); expect((await preview(w, [note])).status).toBe(429);
    expect(await copyOf(note, w.a2.assetId)).toBeNull();
  });
});

describe("which Versions a paste may touch", () => {
  it("is the stub, writing nothing, when the source Version is not granted to the link (preview and commit)", async () => {
    const w = await world({ grantSource: false }); const note = await ownNote(w); const stub = await stubBody();
    expect(await plain(await preview(w, [note]))).toEqual(stub); expect(await plain(await commit(w, revisions([note])))).toEqual(stub);
    expect(await copyOf(note, w.a2.assetId)).toBeNull(); expect(await pasteAudits()).toEqual([]);
  });

  it("is the stub when the TARGET Version is not granted, is unknown, is another Project's or its Video was removed", async () => {
    const w = await world({ grantTarget: false }); const note = await ownNote(w); const stub = await stubBody();
    const other = await seedVideoVersion({ projectId: ids.otherProject });
    for (const target of [w.a2.assetId, crypto.randomUUID(), other.assetId, "not-a-uuid"]) {
      expect(await plain(await guestFetch(previewUrl(w, target), { method: "POST", cookie: w.link.cookie, body: previewBody(w, [note]) })), target).toEqual(stub);
      expect(await plain(await guestFetch(commitUrl(w, target), { method: "POST", cookie: w.link.cookie, body: { sourceAssetId: w.a.assetId, notes: revisions([note]) } })), target).toEqual(stub);
    }
    const ok = await world(); const okNote = await ownNote(ok);
    await database.DB.prepare("UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE link_id = ?").bind(Date.now(), ids.member, ok.link.id).run();
    expect(await plain(await preview(ok, [okNote]))).toEqual(stub); expect(await plain(await commit(ok, revisions([okNote])))).toEqual(stub);
    expect(await noteCount()).toBe(2);
  });

  it("is the stub for an unknown, another Project's or a malformed source, and a source whose grant was revoked", async () => {
    const w = await world(); const note = await ownNote(w); const stub = await stubBody(); const other = await seedVideoVersion({ projectId: ids.otherProject });
    for (const source of [crypto.randomUUID(), other.assetId]) {
      expect(await plain(await guestFetch(previewUrl(w), { method: "POST", cookie: w.link.cookie, body: { sourceAssetId: source, noteIds: [note] } })), source).toEqual(stub);
      expect(await plain(await guestFetch(commitUrl(w), { method: "POST", cookie: w.link.cookie, body: { sourceAssetId: source, notes: revisions([note]) } })), source).toEqual(stub);
    }
    await database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE link_id = ? AND asset_id = ?").bind(Date.now(), ids.member, w.link.id, w.a.assetId).run();
    expect(await plain(await commit(w, revisions([note])))).toEqual(stub);
  });

  it("422s the same Version and two Versions of different Videos, both reachable", async () => {
    const w = await world(); const note = await ownNote(w); const b = await seedVideoVersion({ projectId: w.a.projectId }); await addMember(w.link.id, b.videoId, [b.assetId]);
    const same = await guestFetch(previewUrl(w, w.a.assetId), { method: "POST", cookie: w.link.cookie, body: previewBody(w, [note]) });
    expect(same.status).toBe(422); expect(await json(same)).toEqual({ error: "same_version" });
    const across = await guestFetch(commitUrl(w, b.assetId), { method: "POST", cookie: w.link.cookie, body: { sourceAssetId: w.a.assetId, notes: revisions([note]) } });
    expect(across.status).toBe(422); expect(await json(across)).toEqual({ error: "not_same_video" });
  });
});

describe("the body", () => {
  it("400s unknown keys (visibility, body, frames), duplicates, an empty list, more than 60 notes, a bad id and bad JSON, and 413s an oversized body", async () => {
    const w = await world(); const note = await ownNote(w);
    const bads: Json[] = [{ visibility: "public" }, { body: "x" }, { startFrame: 1 }, { noteIds: [note, note] }, { noteIds: [] }, { noteIds: Array.from({ length: 61 }, () => crypto.randomUUID()) }, { noteIds: ["nope"] }, { offsetFrames: 1.5 }, { offsetFrames: 2_000_000 }];
    for (const bad of bads) {
      const response = await preview(w, [note], {}, bad.noteIds ? { noteIds: bad.noteIds } : bad); expect(response.status, JSON.stringify(bad).slice(0, 60)).toBe(400); expect(await json(response)).toEqual({ error: "invalid_request" });
    }
    expect((await commit(w, [{ noteId: note, revision: 0 }])).status).toBe(400);
    expect((await commit(w, [{ noteId: note, revision: 1 }, { noteId: note, revision: 1 }])).status).toBe(400);
    expect((await preview(w, [note], { body: "{not json" })).status).toBe(400);
    const huge = await preview(w, [note], { body: JSON.stringify({ sourceAssetId: w.a.assetId, noteIds: [note], pad: "y".repeat(17 * 1024) }) });
    expect(huge.status).toBe(413); expect(await json(huge)).toEqual({ error: "payload_too_large" });
    expect(await copyOf(note, w.a2.assetId)).toBeNull();
  });

  it("charges an invalid body one attempt in each bucket", async () => {
    const w = await world(); const note = await ownNote(w);
    expect((await preview(w, [note], {}, { visibility: "x" })).status).toBe(400);
    expect(await bucketCount(`note:guest:${w.guest!.guestId}`)).toBe(1); expect(await bucketCount(`note:link:${w.link.id}`)).toBe(1);
  });
});

describe("every guest paste is the stub, and writes nothing, without a live credential", () => {
  type Call = { name: string; run: (w: World, init?: Parameters<typeof guestFetch>[1]) => Promise<Response> };
  const calls: Call[] = [
    { name: "preview", run: async (w, init) => preview(w, [((await database.DB.prepare("SELECT id FROM video_notes WHERE author_guest_id IS NOT NULL").first<{ id: string }>())?.id ?? crypto.randomUUID())], init) },
    { name: "commit", run: async (w, init) => commit(w, revisions([((await database.DB.prepare("SELECT id FROM video_notes WHERE author_guest_id IS NOT NULL").first<{ id: string }>())?.id ?? crypto.randomUUID())]), init) },
  ];
  const snapshot = async () => JSON.stringify([(await database.DB.prepare("SELECT id, body, revision, deleted_at, copied_from_note_id FROM video_notes ORDER BY id").all()).results, (await noteAudit()).length, await markupCount()]);

  it("for no cookie, another link's cookie, a staff cookie alone and a mangled cookie", async () => {
    const stub = await stubBody();
    for (const call of calls) {
      const w = await world(); const other = await world(); await ownNote(w); const before = await snapshot(); const staff = await staffCookie("admin");
      for (const [label, cookie] of [["none", null], ["other link", other.link.cookie], ["staff", staff], ["mangled", w.link.cookie.replace("=", "=x")]] as const)
        expect(await plain(await call.run(w, { cookie })), `${call.name} ${label}`).toEqual(stub);
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
      await openGuestGate(); const w = await world(); await ownNote(w); const before = await snapshot(); await change(w.link.id);
      expect(await plain(await call.run(w)), `${call.name} ${label}`).toEqual(stub);
      expect(await snapshot(), `${call.name} ${label}`).toBe(before);
      await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("403 invalid_origin for a wrong Origin or content type, spending no quota and writing nothing", async () => {
    for (const call of calls) {
      const w = await world(); await ownNote(w); const before = await snapshot();
      for (const init of [{ origin: "https://evil.test" }, { origin: null }, { contentType: "text/plain" }, { contentType: null }]) {
        const response = await call.run(w, init); expect(response.status, `${call.name} ${JSON.stringify(init)}`).toBe(403); expect(await json(response)).toEqual({ error: "invalid_origin" });
      }
      expect(await snapshot()).toBe(before); expect(await bucketCount(`note:guest:${w.guest!.guestId}`)).toBeNull();
      await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("401s an unverified session and 403s a link without comments, each writing nothing", async () => {
    for (const call of calls) {
      const unverified = await world({ verified: false }); const response = await call.run(unverified, { body: { sourceAssetId: unverified.a.assetId, noteIds: [crypto.randomUUID()], notes: [{ noteId: crypto.randomUUID(), revision: 1 }] } });
      expect(response.status, call.name).toBe(401); expect(await json(response)).toEqual({ error: "verification_required" });
      const off = await world({ link: { allow: [0, 1, 1] } }); await ownNote(off);
      const refused = await call.run(off); expect(refused.status, call.name).toBe(403); expect(await json(refused)).toEqual({ error: "comments_disabled" });
      expect(await copyCount()).toBe(0);
      await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("409 project_archived for an archived Project, before the quota and the body", async () => {
    for (const call of calls) {
      const w = await world(); await ownNote(w); const before = await snapshot(); await archive();
      const response = await call.run(w); expect(response.status, call.name).toBe(409); expect(await json(response)).toEqual({ error: "project_archived" });
      for (const init of [{ body: { nonsense: true } }, { body: "{not json" }, { body: JSON.stringify({ pad: "y".repeat(17 * 1024) }) }]) expect((await call.run(w, init)).status, call.name).toBe(409);
      expect(await snapshot(), call.name).toBe(before); expect(await bucketCount(`note:guest:${w.guest!.guestId}`)).toBeNull();
      await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run(); await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("answers a guest cookie on the staff twin with 401", async () => {
    const w = await world(); const note = await ownNote(w);
    const headers = { cookie: w.link.cookie, origin: guestOrigin, "content-type": "application/json" };
    for (const path of [`/api/projects/${ids.project}/video-versions/${w.a2.assetId}/note-paste/preview`, `/api/projects/${ids.project}/video-versions/${w.a2.assetId}/note-paste`]) {
      const response = await workerSelf.fetch(`https://portal.test${path}`, { method: "POST", headers, body: JSON.stringify({ sourceAssetId: w.a.assetId, noteIds: [note], notes: revisions([note]) }) });
      expect(response.status, path).toBe(401);
    }
    expect(await copyOf(note, w.a2.assetId)).toBeNull();
  });
});

const copyCount = async () => (await database.DB.prepare("SELECT COUNT(*) AS n FROM video_notes WHERE copied_from_note_id IS NOT NULL").first<{ n: number }>())!.n;

describe("the commit repeats what the entry checked", () => {
  const revoke = (w: World) => database.DB.batch([database.DB.prepare("UPDATE client_links SET revoked_at = ? WHERE id = ?").bind(Date.now(), w.link.id), database.DB.prepare("DELETE FROM guest_sessions WHERE link_id = ?").bind(w.link.id)]);
  const replace = (w: World) => database.DB.batch([database.DB.prepare("UPDATE client_links SET token_generation = token_generation + 1 WHERE id = ?").bind(w.link.id), database.DB.prepare("DELETE FROM guest_sessions WHERE link_id = ?").bind(w.link.id)]);
  const stubTransitions: Array<[string, (w: World) => Promise<unknown>]> = [
    ["revoke", revoke], ["replace", replace],
    ["expiry", (w) => database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, w.link.id).run()],
    ["guest part off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_guest'").run()],
    ["guest_comments part off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_guest_comments'").run()],
    ["gate close", () => clearVideoFlags()],
    ["target ungranted", (w) => database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE link_id = ? AND asset_id = ?").bind(Date.now(), ids.member, w.link.id, w.a2.assetId).run()],
    ["source ungranted", (w) => database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE link_id = ? AND asset_id = ?").bind(Date.now(), ids.member, w.link.id, w.a.assetId).run()],
    ["Video removed", (w) => database.DB.prepare("UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE link_id = ?").bind(Date.now(), ids.member, w.link.id).run()],
  ];
  const held = (w: World, note: string, kind: "preview" | "commit") => kind === "commit"
    ? slowRequest("POST", commitUrl(w), w.link.cookie, { sourceAssetId: w.a.assetId, notes: revisions([note]) }, 300)
    : slowRequest("POST", previewUrl(w), w.link.cookie, { sourceAssetId: w.a.assetId, noteIds: [note] }, 300);

  it("a revoke, replace, expiry, part-off, gate close, ungrant (either Version) or Video removal while the body is pending is the exact stub, and nothing is written", async () => {
    const stub = await stubBody();
    for (const kind of ["commit", "preview"] as const) for (const [label, change] of stubTransitions) {
      await openGuestGate(); const w = await world(); const note = await ownNote(w);
      const pending = held(w, note, kind); await sleep(80); await change(w);
      expect(await plain(await pending), `${kind} ${label}`).toEqual(stub);
      expect(await copyCount(), `${kind} ${label}`).toBe(0); expect(await pasteAudits(), `${kind} ${label}`).toEqual([]);
      await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("an archive that lands while the body is pending is 409 project_archived and writes nothing", async () => {
    for (const kind of ["commit", "preview"] as const) {
      const w = await world(); const note = await ownNote(w);
      const pending = held(w, note, kind); await sleep(80); await archive();
      const response = await pending; expect(response.status, kind).toBe(409); expect(await json(response)).toEqual({ error: "project_archived" });
      expect(await copyCount()).toBe(0);
      await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run(); await clearVideoNotes(); await clearGuestRows();
    }
  });

  it("comments switched off on the link while the body is pending is 403 comments_disabled and writes nothing", async () => {
    const w = await world(); const note = await ownNote(w);
    const pending = held(w, note, "commit"); await sleep(80); await database.DB.prepare("UPDATE client_links SET allow_comments = 0 WHERE id = ?").bind(w.link.id).run();
    const response = await pending; expect(response.status).toBe(403); expect(await json(response)).toEqual({ error: "comments_disabled" });
    expect(await copyCount()).toBe(0);
  });
});

describe("the SQL fence on its own (a paste that bypasses the route inserts and audits nothing)", () => {
  const writerOf = async (w: World) => ({ guestId: w.guest!.guestId, sessionId: w.guest!.sessionId, linkId: w.link.id, tokenHash: await hashToken(w.link.cookie.split("=")[1]!), markup: false });
  /** `between` runs after the plan was read and before the write batch, the window the SQL fence exists for (the planner would otherwise refuse a state that was already broken). */
  const run = async (w: World, note: string, writer: Awaited<ReturnType<typeof writerOf>>, between?: () => Promise<unknown>) => {
    let batches = 0;
    const db = { prepare: (sql: string) => database.DB.prepare(sql), batch: async (statements: D1PreparedStatement[]) => { batches += 1; if (batches === 2 && between) await between(); return database.DB.batch(statements); } } as unknown as D1Database;
    return (await commitNotePaste(db, { projectId: w.a.projectId, targetAssetId: w.a2.assetId, sourceAssetId: w.a.assetId, notes: revisions([note]), offsetFrames: 0, principal: null, guest: writer, now: Date.now() })).kind;
  };
  const breaks: Array<[string, (w: World) => Promise<unknown>]> = [
    ["revoked", (w) => database.DB.prepare("UPDATE client_links SET revoked_at = ? WHERE id = ?").bind(Date.now(), w.link.id).run()],
    ["expired", (w) => database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, w.link.id).run()],
    ["replaced", (w) => database.DB.prepare("UPDATE client_links SET token_generation = 2 WHERE id = ?").bind(w.link.id).run()],
    ["session expired", (w) => database.DB.prepare("UPDATE guest_sessions SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, w.guest!.sessionId).run()],
    ["token rotated", (w) => database.DB.prepare("UPDATE guest_sessions SET token_hash = 'rotated' WHERE id = ?").bind(w.guest!.sessionId).run()],
    ["not verified", (w) => database.DB.prepare("UPDATE guest_sessions SET guest_id = NULL, verified_at = NULL WHERE id = ?").bind(w.guest!.sessionId).run()],
    ["guest part off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_guest'").run()],
    ["guest_comments part off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_guest_comments'").run()],
    ["master off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review'").run()],
    ["comments off on the link", (w) => database.DB.prepare("UPDATE client_links SET allow_comments = 0 WHERE id = ?").bind(w.link.id).run()],
    ["target grant revoked", (w) => database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE link_id = ? AND asset_id = ?").bind(Date.now(), ids.member, w.link.id, w.a2.assetId).run()],
    ["source grant revoked", (w) => database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE link_id = ? AND asset_id = ?").bind(Date.now(), ids.member, w.link.id, w.a.assetId).run()],
    ["Video removed", (w) => database.DB.prepare("UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE link_id = ?").bind(Date.now(), ids.member, w.link.id).run()],
    ["Project archived", () => archive()],
  ];

  it("writes under an intact fence and nothing under any broken one", async () => {
    const control = await world(); const controlNote = await ownNote(control);
    expect(await run(control, controlNote, await writerOf(control))).toBe("ok"); expect(await copyCount()).toBe(1); expect(await pasteAudits()).toHaveLength(1);
    await clearVideoNotes(); await clearGuestRows(); await openGuestGate();
    for (const [label, change] of breaks) {
      const w = await world(); const note = await ownNote(w);
      expect(await run(w, note, await writerOf(w), () => change(w)), label).not.toBe("ok");
      expect(await copyCount(), label).toBe(0); expect(await pasteAudits(), label).toEqual([]); expect(await markupCount(), label).toBe(0);
      await clearVideoNotes(); await clearGuestRows(); await openGuestGate();
      await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run();
    }
  });

  it("copies nothing that is not the writer's: another guest's and a studio note come back stale, with no copy and no audit row", async () => {
    const w = await world(); const theirs = await seedVideoNote({ assetId: w.a.assetId, guest: true }); const studio = await seedVideoNote({ assetId: w.a.assetId });
    for (const note of [theirs.id, studio.id]) expect(await run(w, note, await writerOf(w)), note).toBe("stale");
    expect(await copyCount()).toBe(0); expect(await pasteAudits()).toEqual([]);
  });
});

describe("the staff paste is unchanged", () => {
  it("still copies as the staff author and never skips as not_author", async () => {
    const w = await world(); const staffNoteRow = await seedVideoNote({ assetId: w.a.assetId, body: STAFF_BODY });
    const outcome = await commitNotePaste(database.DB, { projectId: w.a.projectId, targetAssetId: w.a2.assetId, sourceAssetId: w.a.assetId, notes: revisions([staffNoteRow.id]), offsetFrames: 0, principal: { id: ids.member, role: "editor" } as never, now: Date.now() });
    expect(outcome.kind).toBe("ok");
    expect(await copyOf(staffNoteRow.id, w.a2.assetId)).toMatchObject({ author_user_id: ids.member, author_guest_id: null });
    expect(await noteRow(staffNoteRow.id)).toMatchObject({ revision: 1 });
  });
});
