import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXTERNAL_API_RESPONSE_SCHEMAS, videoNoteListResponseSchema, videoNoteThreadDtoSchema, type VideoNoteThreadDto } from "@quincy/shared";
import app from "../src/index";
import type { Env } from "../src/env";
import { REPLY_INSERT_SQL } from "../src/lib/video-notes-sql";
import { baseEnv, cookie, database, ids, request, seedFixture, type Who } from "./embedded-media-support";
import { clearVideoFlags, clearVideoNotes, ensureCollection, noteAudit, noteRow, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** Staff video review (#741, 5a): notes and replies on a Video Version, with real sessions per role. */
const OPEN = ["video_review", "video_review_notes", `video_review_pilot:${ids.project}`] as const;
const FRAMES = 250; // seedVideoVersion's frame_count

const notesPath = (assetId: string, projectId: string = ids.project) => `/api/projects/${projectId}/video-versions/${assetId}/notes`;
const notePath = (noteId: string, projectId: string = ids.project) => `/api/projects/${projectId}/video-notes/${noteId}`;
type Json = Record<string, any>;
const json = async (response: Response) => await response.json() as Json;

async function create(who: Who, assetId: string, body: Json = {}, projectId: string = ids.project) {
  return request(notesPath(assetId, projectId), who, "POST", { startFrame: 10, visibility: "public", body: "A note", ...body });
}
async function createOk(who: Who, assetId: string, body: Json = {}): Promise<VideoNoteThreadDto> {
  const response = await create(who, assetId, body); expect(response.status, await response.clone().text()).toBe(201);
  return videoNoteThreadDtoSchema.parse(await response.json());
}
async function list(who: Who, assetId: string) { const response = await request(notesPath(assetId), who); expect(response.status).toBe(200); return videoNoteListResponseSchema.parse(await response.json()).notes; }

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearVideoFlags(); await setVideoFlags(...OPEN); await clearVideoNotes(); });
afterEach(async () => { await clearVideoFlags(); });

describe("the notes gate", () => {
  it("answers one 404 for a real and an unknown id on every route when the master, the notes part or the Project's pilot is off", async () => {
    const version = await seedVideoVersion(); const note = await seedVideoNote({ assetId: version.assetId });
    const calls = (assetId: string, noteId: string): Array<[string, string, Json?]> => [
      ["GET", notesPath(assetId)], ["POST", notesPath(assetId), { startFrame: 1, visibility: "public", body: "x" }],
      ["POST", `${notePath(noteId)}/replies`, { body: "x" }], ["PATCH", notePath(noteId), { expectedRevision: 1, body: "y" }],
      ["DELETE", notePath(noteId), { expectedRevision: 1 }], ["PUT", `${notePath(noteId)}/resolution`, { resolved: true }],
    ];
    const closings: Array<[string, () => Promise<void>]> = [
      ["master off", async () => { await clearVideoFlags(); await setVideoFlags("video_review_notes", `video_review_pilot:${ids.project}`); }],
      ["notes off", async () => { await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.project}`); }],
      ["another Project's pilot", async () => { await clearVideoFlags(); await setVideoFlags("video_review", "video_review_notes", `video_review_pilot:${ids.otherProject}`); }],
    ];
    for (const [label, close] of closings) {
      await close();
      for (const who of ["admin", "member", "external"] as const) {
        const real = calls(version.assetId, note.id); const unknown = calls(crypto.randomUUID(), crypto.randomUUID());
        for (let i = 0; i < real.length; i += 1) {
          const [method, path, body] = real[i]!; const [, unknownPath] = unknown[i]!;
          const a = await request(path, who, method as "GET", body); const b = await request(unknownPath, who, method as "GET", body);
          expect([a.status, b.status], `${label} ${who} ${method} ${path}`).toEqual([404, 404]);
          expect(await json(a), label).toEqual(await json(b));
        }
      }
    }
    expect(await noteAudit()).toEqual([]);
  });

  it("answers 400 for a malformed id before the gate", async () => {
    expect((await request(`/api/projects/not-a-uuid/video-versions/${crypto.randomUUID()}/notes`, "admin")).status).toBe(400);
    expect((await request(notePath("nope"), "admin", "PATCH", { expectedRevision: 1, body: "x" })).status).toBe(400);
  });
});

describe("who can reach notes", () => {
  it("lets Admin, a member Editor, a non-member Editor and an assigned External read and write; refuses a Photographer 403 and an outsider External 404", async () => {
    const version = await seedVideoVersion();
    for (const who of ["admin", "member", "other", "external"] as const) {
      expect((await request(notesPath(version.assetId), who)).status, `list ${who}`).toBe(200);
      expect((await create(who, version.assetId)).status, `create ${who}`).toBe(201);
    }
    for (const response of [await request(notesPath(version.assetId), "photographer"), await create("photographer", version.assetId)]) expect(response.status).toBe(403);
    for (const response of [await request(notesPath(version.assetId), "externalOutsider"), await create("externalOutsider", version.assetId)]) expect(response.status).toBe(404);
  });

  it("scopes a Version to its Project and to video-kind Assets", async () => {
    const other = await seedVideoVersion({ projectId: ids.otherProject });
    await setVideoFlags(`video_review_pilot:${ids.otherProject}`);
    expect((await request(notesPath(other.assetId, ids.project), "admin")).status).toBe(404);
    expect((await create("admin", other.assetId, {}, ids.project)).status).toBe(404);
    const photo = crypto.randomUUID(); const collection = await ensureCollection(ids.project, "raw");
    await database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, 'photo', ?, 'p.jpg', 1, 'upload', ?, ?)").bind(photo, collection, `tests/${photo}.jpg`, Date.now(), Date.now()).run();
    expect((await request(notesPath(photo), "admin")).status).toBe(404);
    expect((await create("admin", photo)).status).toBe(404);
  });
});

describe("visibility", () => {
  it("returns internal and public notes to Admin, Editor and an assigned External, and an External writes internal notes (story 42)", async () => {
    const version = await seedVideoVersion();
    await seedVideoNote({ assetId: version.assetId, visibility: "internal", body: "staff only", startFrame: 5 });
    const internalByExternal = await createOk("external", version.assetId, { visibility: "internal", body: "from the editor", startFrame: 20 });
    expect(internalByExternal).toMatchObject({ visibility: "internal", authorRole: "external_editor", author: { kind: "staff", person: { id: ids.external, isExternal: true } } });
    await createOk("admin", version.assetId, { visibility: "public", startFrame: 30 });
    for (const who of ["admin", "member", "external"] as const) {
      const response = await request(notesPath(version.assetId), who); expect(response.status).toBe(200);
      const body = EXTERNAL_API_RESPONSE_SCHEMAS["video-note-list"].parse(await response.json()) as { notes: VideoNoteThreadDto[] };
      expect(body.notes.map((n) => [n.startFrame, n.visibility]), who).toEqual([[5, "internal"], [20, "internal"], [30, "public"]]);
    }
  });
});

describe("frame bounds, half-open [start, end) with end <= frameCount", () => {
  it("accepts frame 0, the last frame and an end equal to frameCount; refuses past them with 422 and the frame count", async () => {
    const version = await seedVideoVersion();
    expect((await create("admin", version.assetId, { startFrame: 0 })).status).toBe(201);
    expect((await create("admin", version.assetId, { startFrame: FRAMES - 1 })).status).toBe(201);
    expect((await create("admin", version.assetId, { startFrame: 0, endFrame: FRAMES })).status).toBe(201);
    for (const body of [{ startFrame: FRAMES }, { startFrame: 5, endFrame: FRAMES + 1 }, { startFrame: FRAMES + 100 }]) {
      const response = await create("admin", version.assetId, body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(await json(response)).toMatchObject({ code: "frame_out_of_range", frameCount: FRAMES });
    }
    expect(await database.DB.prepare("SELECT COUNT(*) AS n FROM video_notes").first()).toEqual({ n: 3 });
    expect((await noteAudit("video_note.create")).length).toBe(3);
  });

  it("refuses end <= start, a non-integer, a negative frame, a missing visibility, extra keys and bodies out of range with 400", async () => {
    const version = await seedVideoVersion();
    for (const body of [{ startFrame: 5, endFrame: 5 }, { startFrame: 5, endFrame: 4 }, { startFrame: 1.5 }, { startFrame: -1 }, { startFrame: 5, endFrame: 6.5 }, { body: "" }, { body: "   " }, { body: "x".repeat(10_001) }, { authorId: ids.admin }, { parentId: crypto.randomUUID() }]) {
      expect((await create("admin", version.assetId, body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect((await request(notesPath(version.assetId), "admin", "POST", { startFrame: 1, body: "no visibility" })).status).toBe(400);
    expect((await create("admin", version.assetId, { body: "x".repeat(10_000) })).status).toBe(201);
    expect((await create("admin", version.assetId, { body: "  trimmed  " })).status).toBe(201);
    expect(await noteAudit("video_note.create")).toHaveLength(2);
  });

  it("stores a point note with a null endFrame", async () => {
    const version = await seedVideoVersion();
    expect(await createOk("admin", version.assetId, { startFrame: 7, endFrame: null })).toMatchObject({ startFrame: 7, endFrame: null, revision: 1, editedAt: null, deleted: false, resolved: null, hasMarkup: false, drawingFrame: null, copiedFrom: null, replies: [] });
  });
});

describe("replies", () => {
  it("inherit the root's visibility in SQL, carry no frames, and refuse visibility or frames in the body", async () => {
    const version = await seedVideoVersion();
    const internal = await createOk("admin", version.assetId, { visibility: "internal" }); const open = await createOk("admin", version.assetId, { visibility: "public", startFrame: 40 });
    for (const [root, expected] of [[internal, "internal"], [open, "public"]] as const) {
      const response = await request(`${notePath(root.id)}/replies`, "external", "POST", { body: "reply" }); expect(response.status).toBe(201);
      const created = videoNoteThreadDtoSchema.parse(await response.json());
      expect(created.id).toBe(root.id); expect(created.replies).toHaveLength(1);
      expect(created.replies[0]).toMatchObject({ visibility: expected, parentId: root.id, startFrame: null, endFrame: null, authorRole: "external_editor", assetId: version.assetId });
    }
    const threads = await list("admin", version.assetId);
    expect(threads.map((t) => t.replies.map((r) => r.visibility))).toEqual([["internal"], ["public"]]);
    for (const body of [{ body: "x", visibility: "public" }, { body: "x", startFrame: 1 }, { body: "x", parentId: open.id }, {}]) expect((await request(`${notePath(internal.id)}/replies`, "admin", "POST", body)).status).toBe(400);
    expect(REPLY_INSERT_SQL).toContain("p.visibility");
    expect(new Set(REPLY_INSERT_SQL.match(/\?\d+/g)).size).toBe(8);
    expect(REPLY_INSERT_SQL.split("p.visibility").length).toBe(2);
  });

  it("refuses a reply to a reply with 422, to a tombstone with 409, and to an unknown or other-Project note with 404", async () => {
    const version = await seedVideoVersion(); const root = await seedVideoNote({ assetId: version.assetId }); const reply = await seedVideoNote({ assetId: version.assetId, parentId: root.id });
    const tomb = await seedVideoNote({ assetId: version.assetId, deletedAt: Date.now(), startFrame: 50 });
    const nested = await request(`${notePath(reply.id)}/replies`, "admin", "POST", { body: "x" }); expect(nested.status).toBe(422); expect(await json(nested)).toMatchObject({ code: "not_a_thread" });
    const dead = await request(`${notePath(tomb.id)}/replies`, "admin", "POST", { body: "x" }); expect(dead.status).toBe(409); expect(await json(dead)).toMatchObject({ code: "note_deleted" });
    expect((await request(`${notePath(crypto.randomUUID())}/replies`, "admin", "POST", { body: "x" })).status).toBe(404);
    expect((await request(`${notePath(root.id, ids.otherProject)}/replies`, "admin", "POST", { body: "x" })).status).toBe(404);
    expect(await noteAudit("video_note.reply")).toEqual([]);
  });
});

describe("Versions", () => {
  it("keeps v1's notes off v2's list and lets a superseded v1 take notes (story 44)", async () => {
    const first = await seedVideoVersion(); const second = await seedVideoVersion({ projectId: first.projectId, videoId: first.videoId, version: 2 });
    await database.DB.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ? WHERE id = ?").bind(Date.now(), second.assetId, first.assetId).run();
    await createOk("admin", first.assetId, { body: "on v1" });
    expect(await list("admin", second.assetId)).toEqual([]);
    await createOk("member", second.assetId, { body: "on v2" });
    expect((await list("admin", first.assetId)).map((n) => n.body)).toEqual(["on v1"]);
    expect((await list("admin", second.assetId)).map((n) => n.body)).toEqual(["on v2"]);
  });
});

describe("author-only edit and delete (stories 38-40)", () => {
  it("lets the author edit, bumping the revision and stamping edited_at; refuses an Admin and every other staff role 403", async () => {
    const version = await seedVideoVersion(); const note = await createOk("member", version.assetId);
    for (const who of ["admin", "other", "external"] as const) {
      expect((await request(notePath(note.id), who, "PATCH", { expectedRevision: 1, body: "hijack" })).status, who).toBe(403);
      expect((await request(notePath(note.id), who, "DELETE", { expectedRevision: 1 })).status, who).toBe(403);
    }
    const response = await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, body: "  fixed  " }); expect(response.status).toBe(200);
    const edited = videoNoteThreadDtoSchema.parse(await response.json());
    expect(edited).toMatchObject({ body: "fixed", revision: 2 }); expect(edited.editedAt).not.toBeNull();
    expect(await noteRow(note.id)).toMatchObject({ body: "fixed", revision: 2 });
    expect((await request(notePath(note.id), "admin", "PATCH", { expectedRevision: 2, body: "no" })).status).toBe(403);
    expect(await noteAudit("video_note.edit")).toHaveLength(1);
  });

  it("lets an External edit their own note and refuses an Admin on it", async () => {
    const version = await seedVideoVersion(); const note = await createOk("external", version.assetId);
    expect((await request(notePath(note.id), "admin", "PATCH", { expectedRevision: 1, body: "no" })).status).toBe(403);
    expect((await request(notePath(note.id), "external", "PATCH", { expectedRevision: 1, body: "mine" })).status).toBe(200);
    expect((await request(notePath(note.id), "external", "DELETE", { expectedRevision: 2 })).status).toBe(200);
  });

  it("refuses every staff role on a guest-authored note, impersonating or not", async () => {
    const version = await seedVideoVersion(); const guest = await seedVideoNote({ assetId: version.assetId, guest: true });
    for (const who of ["admin", "member", "external"] as const) {
      expect((await request(notePath(guest.id), who, "PATCH", { expectedRevision: 1, body: "x" })).status, who).toBe(403);
      expect((await request(notePath(guest.id), who, "DELETE", { expectedRevision: 1 })).status, who).toBe(403);
    }
    expect(await noteRow(guest.id)).toMatchObject({ body: "Seeded note", revision: 1 });
    const read = (await list("admin", version.assetId))[0]!;
    expect(read.author).toEqual({ kind: "guest", id: guest.guestId, name: "Client Person" }); expect(read.authorRole).toBe("guest");
  });

  it("lets an impersonating Admin act as the author, stamping the Editor as the actor and the Admin in impersonatedBy", async () => {
    const version = await seedVideoVersion(); const note = await createOk("member", version.assetId);
    await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'user_impersonation'").run();
    try {
      const started = await fetchImpersonation(ids.member);
      const edited = await rawRequest(notePath(note.id), started, "PATCH", { expectedRevision: 1, body: "as the editor" }); expect(edited.status).toBe(200);
      const wrong = await seedVideoNote({ assetId: version.assetId, author: ids.other, startFrame: 77 });
      expect((await rawRequest(notePath(wrong.id), started, "PATCH", { expectedRevision: 1, body: "not mine" })).status).toBe(403);
      expect((await rawRequest(notePath(note.id), started, "DELETE", { expectedRevision: 2 })).status).toBe(200);
      const rows = await noteAudit();
      const edit = rows.find((row) => row.action === "video_note.edit")!;
      expect(edit.actor_id).toBe(ids.member); expect(JSON.parse(edit.meta_json!)).toMatchObject({ impersonatedBy: ids.admin });
      expect(JSON.parse(rows.find((row) => row.action === "video_note.delete")!.meta_json!)).toMatchObject({ impersonatedBy: ids.admin });
    } finally { await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'user_impersonation'").run(); }
  });
});

describe("edit", () => {
  it("answers a stale revision 409 note_conflict with the current thread, and a repeated PATCH on the old revision loses", async () => {
    const version = await seedVideoVersion(); const note = await createOk("member", version.assetId);
    expect((await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, body: "first" })).status).toBe(200);
    const stale = await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, body: "second" }); expect(stale.status).toBe(409);
    const body = await json(stale); expect(body).toMatchObject({ code: "note_conflict", thread: { id: note.id, body: "first", revision: 2 } });
    expect((await request(notePath(note.id), "member", "DELETE", { expectedRevision: 1 })).status).toBe(409);
    expect(await noteRow(note.id)).toMatchObject({ body: "first", revision: 2 });
  });

  it("answers the same body with 200, the same revision and no audit row", async () => {
    const version = await seedVideoVersion(); const note = await createOk("member", version.assetId, { body: "same" });
    const response = await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, body: "same" }); expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ revision: 1, editedAt: null });
    expect(await noteAudit("video_note.edit")).toEqual([]);
  });

  it("moves a note's frames with the bounds checked, refuses a note with markup 422, a reply with frames 422, and a tombstone 409", async () => {
    const version = await seedVideoVersion(); const note = await createOk("member", version.assetId, { startFrame: 10, endFrame: 20 });
    const moved = await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, startFrame: 30, endFrame: 40 }); expect(moved.status).toBe(200);
    expect(await json(moved)).toMatchObject({ startFrame: 30, endFrame: 40, revision: 2, body: "A note" });
    const point = await request(notePath(note.id), "member", "PATCH", { expectedRevision: 2, endFrame: null }); expect(await json(point)).toMatchObject({ startFrame: 30, endFrame: null, revision: 3 });
    const outside = await request(notePath(note.id), "member", "PATCH", { expectedRevision: 3, startFrame: FRAMES }); expect(outside.status).toBe(422); expect(await json(outside)).toMatchObject({ code: "frame_out_of_range", frameCount: FRAMES });
    expect((await request(notePath(note.id), "member", "PATCH", { expectedRevision: 3, startFrame: 50, endFrame: 50 })).status).toBe(400);
    expect((await request(notePath(note.id), "member", "PATCH", { expectedRevision: 3, endFrame: FRAMES + 1 })).status).toBe(422);
    expect((await request(notePath(note.id), "member", "PATCH", { expectedRevision: 3 })).status).toBe(400);
    const drawn = await seedVideoNote({ assetId: version.assetId, markup: true, startFrame: 60 });
    const locked = await request(notePath(drawn.id), "member", "PATCH", { expectedRevision: 1, startFrame: 61 }); expect(locked.status).toBe(422); expect(await json(locked)).toMatchObject({ code: "markup_locks_frames" });
    expect((await request(notePath(drawn.id), "member", "PATCH", { expectedRevision: 1, body: "body only is fine" })).status).toBe(200);
    const reply = await seedVideoNote({ assetId: version.assetId, parentId: note.id }); const replyFrames = await request(notePath(reply.id), "member", "PATCH", { expectedRevision: 1, startFrame: 5 });
    expect(replyFrames.status).toBe(422); expect(await json(replyFrames)).toMatchObject({ code: "reply_has_no_frames" });
    expect((await request(notePath(reply.id), "member", "PATCH", { expectedRevision: 1, body: "reply edited" })).status).toBe(200);
    const tomb = await seedVideoNote({ assetId: version.assetId, deletedAt: Date.now(), startFrame: 99 });
    const dead = await request(notePath(tomb.id), "member", "PATCH", { expectedRevision: 1, body: "x" }); expect(dead.status).toBe(409); expect(await json(dead)).toMatchObject({ code: "note_deleted" });
    for (const extra of [{ visibility: "internal" }, { authorId: ids.admin }]) expect((await request(notePath(note.id), "member", "PATCH", { expectedRevision: 3, body: "x", ...extra })).status).toBe(400);
  });
});

describe("delete", () => {
  it("removes a note with no replies, its markup and one audit row (mode removed)", async () => {
    const version = await seedVideoVersion(); const note = await seedVideoNote({ assetId: version.assetId, markup: true });
    const response = await request(notePath(note.id), "member", "DELETE", { expectedRevision: 1 }); expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ thread: null });
    expect(await noteRow(note.id)).toBeNull();
    expect(await database.DB.prepare("SELECT COUNT(*) AS n FROM video_note_markup WHERE note_id = ?").bind(note.id).first()).toEqual({ n: 0 });
    const audit = await noteAudit("video_note.delete"); expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.meta_json!)).toMatchObject({ mode: "removed", ownRepliesRemoved: 0, assetId: version.assetId, projectId: ids.project });
  });

  it("removes the author's own replies with the note", async () => {
    const version = await seedVideoVersion(); const note = await seedVideoNote({ assetId: version.assetId });
    const own = await seedVideoNote({ assetId: version.assetId, parentId: note.id }); await seedVideoNote({ assetId: version.assetId, parentId: note.id });
    await database.DB.prepare("UPDATE video_notes SET author_user_id = ? WHERE parent_id = ?").bind(ids.member, note.id).run();
    expect((await request(notePath(note.id), "member", "DELETE", { expectedRevision: 1 })).status).toBe(200);
    expect(await noteRow(note.id)).toBeNull(); expect(await noteRow(own.id)).toBeNull();
    const audit = await noteAudit("video_note.delete"); expect(audit).toHaveLength(1); expect(JSON.parse(audit[0]!.meta_json!)).toMatchObject({ mode: "removed", ownRepliesRemoved: 2 });
  });

  it("tombstones a note someone else replied to: body cleared, markup gone, the reply intact, one audit row (mode tombstone)", async () => {
    const version = await seedVideoVersion(); const note = await seedVideoNote({ assetId: version.assetId, markup: true, body: "secret text" });
    await seedVideoNote({ assetId: version.assetId, parentId: note.id, author: ids.other, body: "their reply" });
    const response = await request(notePath(note.id), "member", "DELETE", { expectedRevision: 1 }); expect(response.status).toBe(200);
    const body = await json(response); const parsed = videoNoteThreadDtoSchema.parse(body.thread);
    expect(parsed).toMatchObject({ id: note.id, deleted: true, body: "", hasMarkup: false, drawingFrame: null, revision: 2, startFrame: 10, author: { kind: "staff", person: { id: ids.member } } });
    expect(parsed.replies.map((r) => r.body)).toEqual(["their reply"]);
    expect(await noteRow(note.id)).toMatchObject({ body: "", revision: 2 }); expect((await noteRow(note.id))!.deleted_at).not.toBeNull();
    expect(await database.DB.prepare("SELECT COUNT(*) AS n FROM video_note_markup").first()).toEqual({ n: 0 });
    const audit = await noteAudit("video_note.delete"); expect(audit).toHaveLength(1); expect(JSON.parse(audit[0]!.meta_json!)).toMatchObject({ mode: "tombstone" });
    expect((await request(notePath(note.id), "member", "DELETE", { expectedRevision: 2 })).status).toBe(409);
    expect((await request(`${notePath(note.id)}/replies`, "admin", "POST", { body: "late" })).status).toBe(409);
    expect((await request(`${notePath(note.id)}/resolution`, "admin", "PUT", { resolved: true })).status).toBe(200);
  });

  it("tombstones when the other reply is a guest's", async () => {
    const version = await seedVideoVersion(); const note = await seedVideoNote({ assetId: version.assetId });
    await seedVideoNote({ assetId: version.assetId, parentId: note.id, guest: true });
    const response = await request(notePath(note.id), "member", "DELETE", { expectedRevision: 1 });
    expect(await json(response)).toMatchObject({ thread: { deleted: true } });
  });

  it("hard-deletes a reply and answers with the thread it belonged to", async () => {
    const version = await seedVideoVersion(); const note = await seedVideoNote({ assetId: version.assetId });
    const reply = await createReplyOk("member", note.id);
    const response = await request(notePath(reply), "member", "DELETE", { expectedRevision: 1 }); expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ thread: { id: note.id, replies: [] } });
    expect(await noteRow(reply)).toBeNull();
    expect(JSON.parse((await noteAudit("video_note.delete"))[0]!.meta_json!)).toMatchObject({ mode: "removed", parentId: note.id });
  });
});

async function createReplyOk(who: Who, noteId: string): Promise<string> {
  const response = await request(`${notePath(noteId)}/replies`, who, "POST", { body: "a reply" }); expect(response.status).toBe(201);
  return videoNoteThreadDtoSchema.parse(await response.json()).replies.at(-1)!.id;
}

describe("resolve and reopen", () => {
  it("resolves as the actor with one audit row, is idempotent, reopens, and lets an External resolve an Admin's note", async () => {
    const version = await seedVideoVersion(); const note = await createOk("admin", version.assetId);
    const resolved = await request(`${notePath(note.id)}/resolution`, "external", "PUT", { resolved: true }); expect(resolved.status).toBe(200);
    const thread = videoNoteThreadDtoSchema.parse(await resolved.json());
    expect(thread.resolved).toMatchObject({ by: { id: ids.external } }); expect(thread.revision).toBe(1);
    expect(await noteAudit("video_note.resolve")).toHaveLength(1);
    const again = await request(`${notePath(note.id)}/resolution`, "member", "PUT", { resolved: true }); expect(again.status).toBe(200);
    expect((await json(again)).resolved.by.id).toBe(ids.external); expect(await noteAudit("video_note.resolve")).toHaveLength(1);
    const reopened = await request(`${notePath(note.id)}/resolution`, "admin", "PUT", { resolved: false }); expect(reopened.status).toBe(200);
    expect((await json(reopened)).resolved).toBeNull(); expect(await noteAudit("video_note.reopen")).toHaveLength(1);
    expect((await request(`${notePath(note.id)}/resolution`, "admin", "PUT", { resolved: false })).status).toBe(200); expect(await noteAudit("video_note.reopen")).toHaveLength(1);
    expect((await request(`${notePath(note.id)}/resolution`, "admin", "PUT", { resolved: "yes" })).status).toBe(400);
  });

  it("refuses a reply with 422 and an unknown note with 404", async () => {
    const version = await seedVideoVersion(); const note = await seedVideoNote({ assetId: version.assetId }); const reply = await seedVideoNote({ assetId: version.assetId, parentId: note.id });
    const refused = await request(`${notePath(reply.id)}/resolution`, "admin", "PUT", { resolved: true }); expect(refused.status).toBe(422); expect(await json(refused)).toMatchObject({ code: "not_a_thread" });
    expect((await request(`${notePath(crypto.randomUUID())}/resolution`, "admin", "PUT", { resolved: true })).status).toBe(404);
    expect(await noteAudit()).toEqual([]);
  });
});

describe("an archived Project (story 43)", () => {
  async function archivedFixture() {
    await setVideoFlags(`video_review_pilot:${ids.archivedProject}`);
    const version = await seedVideoVersion({ projectId: ids.archivedProject, uploader: ids.member });
    const mine = await seedVideoNote({ assetId: version.assetId, author: ids.member }); const theirs = await seedVideoNote({ assetId: version.assetId, author: ids.other, startFrame: 20 });
    return { version, mine, theirs };
  }

  it("reads for Admin and Editor, 404s an External, and refuses every write 409 project_archived with no audit row, a non-author's included", async () => {
    const { version, mine, theirs } = await archivedFixture(); const P = ids.archivedProject;
    for (const who of ["admin", "member"] as const) { const response = await request(notesPath(version.assetId, P), who); expect(response.status, who).toBe(200); expect(videoNoteListResponseSchema.parse(await response.json()).notes).toHaveLength(2); }
    expect((await request(notesPath(version.assetId, P), "external")).status).toBe(404);
    const writes: Array<[Who, string, string, Json]> = [
      ["member", "POST", notesPath(version.assetId, P), { startFrame: 1, visibility: "public", body: "x" }], ["admin", "POST", notesPath(version.assetId, P), { startFrame: 1, visibility: "public", body: "x" }],
      ["member", "POST", `${notePath(mine.id, P)}/replies`, { body: "x" }], ["member", "PATCH", notePath(mine.id, P), { expectedRevision: 1, body: "x" }],
      ["admin", "PATCH", notePath(mine.id, P), { expectedRevision: 1, body: "x" }], ["admin", "PATCH", notePath(theirs.id, P), { expectedRevision: 1, body: "x" }],
      ["member", "PATCH", notePath(mine.id, P), { expectedRevision: 1, body: "Seeded note" }], ["member", "DELETE", notePath(mine.id, P), { expectedRevision: 1 }],
      ["admin", "DELETE", notePath(theirs.id, P), { expectedRevision: 1 }], ["member", "PUT", `${notePath(mine.id, P)}/resolution`, { resolved: true }],
    ];
    for (const [who, method, path, body] of writes) {
      const response = await request(path, who, method as "POST", body);
      expect([response.status, (await json(response)).code], `${who} ${method} ${path}`).toEqual([409, "project_archived"]);
    }
    expect(await noteAudit()).toEqual([]); expect((await noteRow(mine.id))).toMatchObject({ body: "Seeded note", revision: 1, resolved_at: null });
    expect((await request(`${notePath(mine.id, P)}/replies`, "external", "POST", { body: "x" })).status).toBe(404);
  });

  it("refuses an impersonating Admin 409", async () => {
    const { mine } = await archivedFixture();
    await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'user_impersonation'").run();
    try {
      const started = await fetchImpersonation(ids.member);
      const response = await rawRequest(notePath(mine.id, ids.archivedProject), started, "PATCH", { expectedRevision: 1, body: "x" });
      expect([response.status, (await json(response)).code]).toEqual([409, "project_archived"]);
    } finally { await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'user_impersonation'").run(); }
  });

  it("writes nothing when an archive lands inside the batch", async () => {
    const project = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Race Street', 'editing_autohdr', ?, ?)").bind(project, now, now).run();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), project, ids.member, now).run();
    await setVideoFlags(`video_review_pilot:${project}`);
    const version = await seedVideoVersion({ projectId: project, uploader: ids.member }); const note = await seedVideoNote({ assetId: version.assetId, author: ids.member });
    const cases: Array<[string, string, Json]> = [
      ["POST", notesPath(version.assetId, project), { startFrame: 1, visibility: "public", body: "x" }], ["POST", `${notePath(note.id, project)}/replies`, { body: "x" }],
      ["PATCH", notePath(note.id, project), { expectedRevision: 1, body: "raced" }], ["PATCH", notePath(note.id, project), { expectedRevision: 1, body: "Seeded note" }], ["PUT", `${notePath(note.id, project)}/resolution`, { resolved: true }], ["DELETE", notePath(note.id, project), { expectedRevision: 1 }],
    ];
    for (const [method, path, body] of cases) {
      await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(project).run();
      const response = await racing(project, method, path, body);
      expect([response.status, (await json(response)).code], `${method} ${path}`).toEqual([409, "project_archived"]);
    }
    expect(await noteAudit()).toEqual([]);
    expect(await noteRow(note.id)).toMatchObject({ body: "Seeded note", revision: 1, resolved_at: null });
    expect(await database.DB.prepare("SELECT COUNT(*) AS n FROM video_notes WHERE project_id = ?").bind(project).first()).toEqual({ n: 1 });
  });
});

describe("audit (story 41)", () => {
  it("writes each action with its meta, never a body, and the impersonation keys only when impersonating", async () => {
    const version = await seedVideoVersion();
    const note = await createOk("member", version.assetId, { visibility: "internal", body: "SECRET create", startFrame: 12, endFrame: 20 });
    const reply = await createReplyOk("external", note.id);
    await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, body: "SECRET edit" });
    await request(`${notePath(note.id)}/resolution`, "admin", "PUT", { resolved: true });
    await request(`${notePath(note.id)}/resolution`, "admin", "PUT", { resolved: false });
    await request(notePath(reply), "external", "DELETE", { expectedRevision: 1 });
    await request(notePath(note.id), "member", "DELETE", { expectedRevision: 2 });
    const rows = await noteAudit();
    expect(rows.map((row) => row.action)).toEqual(["video_note.create", "video_note.reply", "video_note.edit", "video_note.resolve", "video_note.reopen", "video_note.delete", "video_note.delete"]);
    const meta = (action: string, index = 0) => JSON.parse(rows.filter((row) => row.action === action)[index]!.meta_json!) as Json;
    expect(meta("video_note.create")).toEqual({ projectId: ids.project, videoId: version.videoId, assetId: version.assetId, visibility: "internal", startFrame: 12, endFrame: 20 });
    expect(meta("video_note.reply")).toEqual({ projectId: ids.project, videoId: version.videoId, assetId: version.assetId, parentId: note.id, visibility: "internal" });
    expect(meta("video_note.edit")).toEqual({ projectId: ids.project, assetId: version.assetId, revision: 2 });
    expect(meta("video_note.resolve")).toEqual({ projectId: ids.project, assetId: version.assetId });
    expect(meta("video_note.delete", 0)).toEqual({ projectId: ids.project, assetId: version.assetId, parentId: note.id, mode: "removed", ownRepliesRemoved: 0 });
    expect(meta("video_note.delete", 1)).toEqual({ projectId: ids.project, assetId: version.assetId, parentId: null, mode: "removed", ownRepliesRemoved: 0 });
    expect(rows.map((row) => row.actor_id)).toEqual([ids.member, ids.external, ids.member, ids.admin, ids.admin, ids.external, ids.member]);
    for (const row of rows) { expect(row.meta_json).not.toMatch(/SECRET/); expect(Object.keys(JSON.parse(row.meta_json!))).not.toContain("body"); expect(row.meta_json).not.toContain("impersonatedBy"); }
    expect(rows.every((row) => row.target_id === note.id || row.target_id === reply)).toBe(true);
  });
});

// ---- helpers that need the real app ----

async function rawRequest(path: string, sessionCookie: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET", body?: unknown) {
  const headers = new Headers({ cookie: sessionCookie, origin: baseEnv.APP_ORIGIN }); if (body !== undefined) headers.set("content-type", "application/json");
  const { SELF } = await import("cloudflare:test");
  return SELF.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
/** The admin starts a real Better Auth impersonation of `userId` and gets that session's cookie. */
async function fetchImpersonation(userId: string): Promise<string> {
  const response = await rawRequest("/api/auth/admin/impersonate-user", await cookie("admin"), "POST", { userId }); expect(response.status).toBe(200);
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = new Map<string, string>();
  for (const value of headers.getSetCookie?.() ?? []) { const pair = value.split(";", 1)[0]!; const at = pair.indexOf("="); if (at > 0) cookies.set(pair.slice(0, at), pair.slice(at + 1)); }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}
/** The real app against a D1 whose first multi-statement batch archives `projectId` just before it runs. Signs in as the Project's member Editor. */
async function racing(projectId: string, method: string, path: string, body: unknown) {
  let flipped = false;
  const db = new Proxy(database.DB, {
    get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!flipped && statements.length >= 2) { flipped = true; await target.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), projectId).run(); }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  const headers = new Headers({ cookie: await cookie("member"), origin: baseEnv.APP_ORIGIN, "content-type": "application/json" });
  const executionContext = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
  return app.fetch(new Request(`https://portal.test${path}`, { method, headers, body: JSON.stringify(body) }), { ...baseEnv, DB: db } as Env, executionContext);
}
