import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { videoNoteListResponseSchema, videoNotePastePreviewResponseSchema, videoNoteThreadDtoSchema, type VideoNoteThreadDto } from "@quincy/shared";
import { createVideoNote, editVideoNote, findNoteHead } from "../src/lib/video-notes";
import { database, ids, request, seedFixture, type Who } from "./embedded-media-support";
import { clearVideoFlags, clearVideoNotes, noteAudit, noteRow, SEED_STROKES_JSON, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** Markup on video notes, server side (#741 6b-api): the strict envelope, the drawing-frame rule, revisions, the lazy read, audit and paste. */
const OPEN = ["video_review", "video_review_notes", "video_review_markup", `video_review_pilot:${ids.project}`] as const;
type Json = Record<string, any>;
const json = async (response: Response) => await response.json() as Json;
const notesPath = (assetId: string, projectId: string = ids.project) => `/api/projects/${projectId}/video-versions/${assetId}/notes`;
const notePath = (noteId: string, projectId: string = ids.project) => `/api/projects/${projectId}/video-notes/${noteId}`;
const markupPath = (noteId: string, projectId: string = ids.project) => `${notePath(noteId, projectId)}/markup`;

const stroke = (color = "#e64b3c", width = 4) => ({ points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], color, width });
const arrow = { type: "arrow", points: [{ x: 0.1, y: 0.1 }, { x: 0.8, y: 0.8 }], color: "#2f6df0", width: 6 };
const MARKUP = [stroke()];

async function create(who: Who, assetId: string, body: Json = {}) {
  return request(notesPath(assetId), who, "POST", { startFrame: 10, visibility: "public", body: "A note", ...body });
}
async function createDrawn(who: Who, assetId: string, body: Json = {}): Promise<VideoNoteThreadDto> {
  const response = await create(who, assetId, { markup: MARKUP, drawingFrame: 10, ...body }); expect(response.status, await response.clone().text()).toBe(201);
  return videoNoteThreadDtoSchema.parse(await response.json());
}
const markupRow = (noteId: string) => database.DB.prepare("SELECT strokes_json, created_at, updated_at FROM video_note_markup WHERE note_id = ?").bind(noteId).first<{ strokes_json: string; created_at: number; updated_at: number }>();
const counts = () => database.DB.prepare("SELECT (SELECT COUNT(*) FROM video_notes) AS notes, (SELECT COUNT(*) FROM video_note_markup) AS markup, (SELECT COUNT(*) FROM audit_log WHERE action LIKE 'video_note.%') AS audits").first<{ notes: number; markup: number; audits: number }>();
const principal = { id: ids.member, role: "editor" as const, impersonatedBy: undefined, via: undefined };
const meta = async (action: string) => JSON.parse((await noteAudit(action)).at(-1)!.meta_json!) as Json;

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearVideoFlags(); await setVideoFlags(...OPEN); await clearVideoNotes(); });
afterEach(async () => { await clearVideoFlags(); });

describe("the markup gate, read once and checked before capability, visibility and archived", () => {
  it("answers one 404 when the markup part is off but notes is on, for every route that touches markup, while plain note CRUD keeps working", async () => {
    const version = await seedVideoVersion(); const plain = await seedVideoNote({ assetId: version.assetId }); const drawn = await seedVideoNote({ assetId: version.assetId, markup: true, startFrame: 40 });
    await clearVideoFlags(); await setVideoFlags("video_review", "video_review_notes", `video_review_pilot:${ids.project}`);
    const touching: Array<[string, string, Json?]> = [
      ["POST", notesPath(version.assetId), { startFrame: 5, visibility: "public", body: "x", markup: MARKUP, drawingFrame: 5 }],
      ["PATCH", notePath(plain.id), { expectedRevision: 1, markup: MARKUP, drawingFrame: 10 }],
      ["PATCH", notePath(drawn.id), { expectedRevision: 1, markup: null }],
      ["GET", markupPath(drawn.id)],
    ];
    for (const who of ["admin", "member", "external", "photographer", "externalOutsider"] as const) {
      for (const [method, path, body] of touching) {
        const response = await request(path, who, method as "GET", body); const unknown = await request(path.replace(/[0-9a-f-]{36}\/markup$|notes\/[0-9a-f-]{36}$/, (m) => m.replace(/[0-9a-f-]{36}/, crypto.randomUUID())), who, method as "GET", body);
        expect([response.status, unknown.status], `${who} ${method} ${path}`).toEqual([404, 404]);
        expect(await json(response)).toEqual(await json(unknown));
      }
    }
    expect(await counts()).toMatchObject({ notes: 2, markup: 1, audits: 0 });
    // Plain CRUD (no markup key) still works with the part off, and a body-only edit of a drawn note keeps its drawing.
    expect((await create("member", version.assetId, { startFrame: 5 })).status).toBe(201);
    expect((await request(notePath(plain.id), "member", "PATCH", { expectedRevision: 1, body: "edited" })).status).toBe(200);
    expect((await request(notePath(drawn.id), "member", "PATCH", { expectedRevision: 1, body: "still drawn" })).status).toBe(200);
    expect((await request(`${notePath(plain.id)}/replies`, "member", "POST", { body: "r" })).status).toBe(201);
    expect((await request(`${notesPath(version.assetId)}`, "member")).status).toBe(200);
    expect((await request(notePath(drawn.id), "member", "DELETE", { expectedRevision: 2 })).status).toBe(200);
  });

  it("is checked before capability (a Photographer gets 404 with the part off, 403 with it on) and before visibility", async () => {
    const version = await seedVideoVersion(); const note = await seedVideoNote({ assetId: version.assetId, markup: true });
    expect((await request(markupPath(note.id), "photographer")).status).toBe(403);
    expect((await request(markupPath(note.id), "externalOutsider")).status).toBe(404);
    expect((await create("photographer", version.assetId, { markup: MARKUP, drawingFrame: 10 })).status).toBe(403);
    await clearVideoFlags(); await setVideoFlags("video_review", "video_review_notes", `video_review_pilot:${ids.project}`);
    expect((await request(markupPath(note.id), "photographer")).status).toBe(404);
    expect((await create("photographer", version.assetId, { markup: MARKUP, drawingFrame: 10 })).status).toBe(404);
  });

  it("reads the gate once per request", async () => {
    const version = await seedVideoVersion();
    const statements: string[] = [];
    const real = database.DB.prepare.bind(database.DB);
    (database.DB as any).prepare = (sql: string) => { statements.push(sql); return real(sql); };
    try { expect((await create("member", version.assetId, { markup: MARKUP, drawingFrame: 10 })).status).toBe(201); }
    finally { (database.DB as any).prepare = real; }
    expect(statements.filter((sql) => sql.includes("FROM feature_flags")).length).toBe(1);
  });

  it("orders archived last: a staff write is 409 and an External's is a concealed 404, after the gate, capability and visibility", async () => {
    const version = await seedVideoVersion(); const note = await seedVideoNote({ assetId: version.assetId, author: ids.external, role: "external_editor", markup: true });
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run();
    try {
      const staff = await create("member", version.assetId, { markup: MARKUP, drawingFrame: 10 }); expect(staff.status).toBe(409); expect(await json(staff)).toMatchObject({ code: "project_archived" });
      expect((await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, markup: null })).status).toBe(409);
      const external = await create("external", version.assetId, { markup: MARKUP, drawingFrame: 10 }); expect(external.status).toBe(404); expect(await json(external)).toEqual({ error: "Project not found" });
      expect((await request(notePath(note.id), "external", "PATCH", { expectedRevision: 1, markup: null })).status).toBe(404);
      // Reads still work on an archived Project.
      expect((await request(markupPath(note.id), "member")).status).toBe(200);
      // An assigned External sees an archived Project as it does a missing one, notes and markup alike.
      expect((await request(markupPath(note.id), "external")).status).toBe((await request(notesPath(version.assetId), "external")).status);
      expect((await request(markupPath(note.id), "externalOutsider")).status).toBe(404);
    } finally { await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run(); }
    expect(await counts()).toMatchObject({ notes: 1, markup: 1, audits: 0 });
  });
});

describe("the strict video markup envelope", () => {
  it("accepts a freehand stroke and a shape, stores the canonical JSON and answers hasMarkup with the drawing frame", async () => {
    const version = await seedVideoVersion();
    const created = await createDrawn("member", version.assetId, { markup: [stroke(), arrow, stroke("#fff", 24), stroke("#abc", 1)] });
    expect(created).toMatchObject({ hasMarkup: true, drawingFrame: 10, revision: 1, startFrame: 10, endFrame: null });
    const stored = await markupRow(created.id);
    expect(JSON.parse(stored!.strokes_json)).toEqual([stroke(), arrow, stroke("#fff", 24), stroke("#abc", 1)]);
    expect(stored!.strokes_json).toBe(JSON.stringify([stroke(), arrow, stroke("#fff", 24), stroke("#abc", 1)]));
    expect(await noteRow(created.id)).toMatchObject({ drawing_frame: 10 });
  });

  it("refuses every non-conforming envelope with 400 and writes nothing", async () => {
    const version = await seedVideoVersion();
    const bad: Array<[string, unknown]> = [
      ["empty", []], ["not an array", { points: [] }], ["null on create", null], ["non-hex colour", [stroke("red")]], ["rgb colour", [stroke("rgb(1,2,3)")]], ["short hex", [stroke("#12")]],
      ["width 0", [stroke("#fff", 0)]], ["width 0.5", [stroke("#fff", 0.5)]], ["width 25", [stroke("#fff", 25)]], ["unknown key", [{ ...stroke(), extra: 1 }]],
      ["freehand literal type", [{ ...stroke(), type: "freehand" }]], ["unknown shape", [{ ...arrow, type: "circle" }]], ["shape with 3 points", [{ ...arrow, points: [...arrow.points, { x: 0.5, y: 0.5 }] }]],
      ["x out of range", [{ ...stroke(), points: [{ x: 1.5, y: 0 }] }]], ["point extra key", [{ ...stroke(), points: [{ x: 0, y: 0, z: 1 }] }]],
      ["201 items", Array.from({ length: 201 }, () => stroke())], ["2001 points", [{ ...stroke(), points: Array.from({ length: 2001 }, () => ({ x: 0.5, y: 0.5 })) }]],
    ];
    for (const [label, markup] of bad) expect((await create("member", version.assetId, { markup, drawingFrame: 10 })).status, label).toBe(400);
    expect((await create("member", version.assetId, { markup: Array.from({ length: 200 }, () => stroke()), drawingFrame: 10 })).status).toBe(201);
    expect(await counts()).toMatchObject({ notes: 1, markup: 1, audits: 1 });
  });

  it("answers 413 above 524,288 bytes before the batch, never a 500 from the CHECK, and accepts a payload just under", async () => {
    const version = await seedVideoVersion(); const long = (n: number) => Array.from({ length: n }, () => ({ x: 0.12345678901234567, y: 0.76543210987654321 }));
    const big = Array.from({ length: 8 }, () => ({ ...stroke(), points: long(2000) }));
    const response = await create("member", version.assetId, { markup: big, drawingFrame: 10 });
    expect(response.status).toBe(413); expect(await json(response)).toMatchObject({ code: "markup_too_large" });
    const note = await seedVideoNote({ assetId: version.assetId, startFrame: 30 });
    expect((await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, markup: big, drawingFrame: 30 })).status).toBe(413);
    expect(await counts()).toMatchObject({ notes: 1, markup: 0, audits: 0 });
    const under = Array.from({ length: 4 }, () => ({ ...stroke(), points: long(2000) }));
    expect(new TextEncoder().encode(JSON.stringify(under)).length).toBeLessThan(524_288);
    expect((await create("member", version.assetId, { markup: under, drawingFrame: 10 })).status).toBe(201);
  });

  it("still requires a body: a drawing alone cannot be posted", async () => {
    const version = await seedVideoVersion();
    expect((await request(notesPath(version.assetId), "member", "POST", { startFrame: 10, visibility: "public", markup: MARKUP, drawingFrame: 10 })).status).toBe(400);
    expect((await create("member", version.assetId, { body: "  ", markup: MARKUP, drawingFrame: 10 })).status).toBe(400);
  });
});

describe("create with markup: the drawing-frame rule", () => {
  it("point note: the drawing frame must equal startFrame; range note: [start, end)", async () => {
    const version = await seedVideoVersion();
    expect((await createDrawn("member", version.assetId, { startFrame: 20, drawingFrame: 20 })).drawingFrame).toBe(20);
    for (const drawingFrame of [19, 21, 0, 249]) {
      const response = await create("member", version.assetId, { startFrame: 20, markup: MARKUP, drawingFrame });
      expect(response.status, `point ${drawingFrame}`).toBe(422); expect(await json(response)).toMatchObject({ code: "drawing_frame_outside" });
    }
    for (const drawingFrame of [20, 25, 29]) expect((await createDrawn("member", version.assetId, { startFrame: 20, endFrame: 30, drawingFrame })).drawingFrame, `range ${drawingFrame}`).toBe(drawingFrame);
    for (const drawingFrame of [19, 30, 31, 249]) expect((await create("member", version.assetId, { startFrame: 20, endFrame: 30, markup: MARKUP, drawingFrame })).status, `range ${drawingFrame}`).toBe(422);
    expect(await counts()).toMatchObject({ notes: 4, markup: 4, audits: 4 });
  });

  it("requires markup and drawingFrame to travel together (400)", async () => {
    const version = await seedVideoVersion();
    expect((await create("member", version.assetId, { markup: MARKUP })).status).toBe(400);
    expect((await create("member", version.assetId, { drawingFrame: 10 })).status).toBe(400);
    expect((await create("member", version.assetId, { markup: MARKUP, drawingFrame: -1 })).status).toBe(400);
    expect((await create("member", version.assetId, { markup: MARKUP, drawingFrame: 1.5 })).status).toBe(400);
    expect(await counts()).toMatchObject({ notes: 0, markup: 0, audits: 0 });
  });

  it("repeats the frame rule in the batch SQL: a write that bypasses the route inserts nothing", async () => {
    const version = await seedVideoVersion();
    const write = (startFrame: number, endFrame: number | null, drawingFrame: number) => createVideoNote(database.DB, {
      projectId: ids.project, assetId: version.assetId, principal, visibility: "public", startFrame, endFrame, body: "x", now: Date.now(),
      markup: { json: JSON.stringify(MARKUP), items: 1, bytes: JSON.stringify(MARKUP).length, drawingFrame },
    });
    for (const [s, e, d] of [[20, null, 21], [20, null, 19], [20, 30, 30], [20, 30, 19]] as const) expect((await write(s, e, d)).kind, `${s} ${e} ${d}`).toBe("gone");
    expect(await counts()).toMatchObject({ notes: 0, markup: 0, audits: 0 });
    expect((await write(20, null, 20)).kind).toBe("ok"); expect((await write(20, 30, 29)).kind).toBe("ok");
    expect(await counts()).toMatchObject({ notes: 2, markup: 2, audits: 2 });
  });

  it("writes one audit row carrying counts and no strokes", async () => {
    const version = await seedVideoVersion();
    const note = await createDrawn("member", version.assetId, { markup: [stroke(), arrow], startFrame: 12, endFrame: 20, drawingFrame: 15 });
    const audit = await noteAudit("video_note.create"); expect(audit).toHaveLength(1);
    const body = await meta("video_note.create");
    expect(body).toMatchObject({ markup: "add", strokeCount: 2, markupBytes: new TextEncoder().encode(JSON.stringify([stroke(), arrow])).length, drawingFrame: 15 });
    expect(audit[0]!.meta_json).not.toContain("#e64b3c"); expect(audit[0]!.meta_json).not.toContain("points"); expect(audit[0]!.target_id).toBe(note.id);
    // A note without markup carries none of those keys.
    await create("member", version.assetId, { startFrame: 50 });
    const plain = JSON.parse((await noteAudit("video_note.create")).at(-1)!.meta_json!);
    expect(plain.markup).toBeUndefined(); expect(plain.strokeCount).toBeUndefined();
  });
});

describe("edit with markup", () => {
  it("adds markup to a plain note: needs drawingFrame, bumps the revision once, audits add", async () => {
    const version = await seedVideoVersion(); const point = await seedVideoNote({ assetId: version.assetId, startFrame: 10 }); const range = await seedVideoNote({ assetId: version.assetId, startFrame: 40, endFrame: 60 });
    const missing = await request(notePath(point.id), "member", "PATCH", { expectedRevision: 1, markup: MARKUP }); expect(missing.status).toBe(422); expect(await json(missing)).toMatchObject({ code: "drawing_frame_required" });
    const wrong = await request(notePath(point.id), "member", "PATCH", { expectedRevision: 1, markup: MARKUP, drawingFrame: 11 }); expect(wrong.status).toBe(422); expect(await json(wrong)).toMatchObject({ code: "drawing_frame_outside" });
    const added = await request(notePath(point.id), "member", "PATCH", { expectedRevision: 1, markup: MARKUP, drawingFrame: 10 }); expect(added.status).toBe(200);
    expect(videoNoteThreadDtoSchema.parse(await added.json())).toMatchObject({ revision: 2, hasMarkup: true, drawingFrame: 10, body: "Seeded note" });
    const inRange = await request(notePath(range.id), "member", "PATCH", { expectedRevision: 1, markup: MARKUP, drawingFrame: 59 }); expect(inRange.status).toBe(200);
    expect((await request(notePath(range.id), "member", "PATCH", { expectedRevision: 2, markup: [stroke("#000", 2)], drawingFrame: 60 })).status).toBe(422);
    const audit = await noteAudit("video_note.edit"); expect(audit).toHaveLength(2);
    expect(await meta("video_note.edit")).toMatchObject({ markup: "add", strokeCount: 1, drawingFrame: 59, revision: 2 });
    expect((await markupRow(point.id))!.strokes_json).toBe(JSON.stringify(MARKUP));
  });

  it("replaces markup (revision +1, audit replace, created_at kept) and treats a byte-identical markup as a no-op with no revision bump and no audit", async () => {
    const version = await seedVideoVersion(); const note = await createDrawn("member", version.assetId);
    const before = await markupRow(note.id);
    const same = await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, markup: MARKUP }); expect(same.status).toBe(200);
    expect(await json(same)).toMatchObject({ revision: 1, editedAt: null, hasMarkup: true }); expect(await noteAudit("video_note.edit")).toEqual([]);
    const sameWithFrame = await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, markup: MARKUP, drawingFrame: 10 }); expect(await json(sameWithFrame)).toMatchObject({ revision: 1 });
    const replaced = await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, markup: [stroke("#000000", 8), arrow] }); expect(replaced.status).toBe(200);
    expect(await json(replaced)).toMatchObject({ revision: 2, hasMarkup: true, drawingFrame: 10 }); expect(await json(await request(notePath(note.id), "member", "PATCH", { expectedRevision: 2, markup: [stroke("#000000", 8), arrow] }))).toMatchObject({ revision: 2 });
    const after = await markupRow(note.id);
    expect(JSON.parse(after!.strokes_json)).toEqual([stroke("#000000", 8), arrow]); expect(after!.created_at).toBe(before!.created_at); expect(after!.updated_at).toBeGreaterThanOrEqual(before!.updated_at);
    expect(await noteAudit("video_note.edit")).toHaveLength(1);
    expect(await meta("video_note.edit")).toMatchObject({ markup: "replace", strokeCount: 2 });
  });

  it("removes markup with null: row gone, drawing frame cleared, audit remove, revision +1; null on a note without markup is a no-op", async () => {
    const version = await seedVideoVersion(); const note = await createDrawn("member", version.assetId);
    const removed = await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, markup: null }); expect(removed.status).toBe(200);
    expect(videoNoteThreadDtoSchema.parse(await removed.json())).toMatchObject({ revision: 2, hasMarkup: false, drawingFrame: null });
    expect(await markupRow(note.id)).toBeNull(); expect(await noteRow(note.id)).toMatchObject({ drawing_frame: null, revision: 2 });
    expect(await meta("video_note.edit")).toMatchObject({ markup: "remove" });
    const again = await request(notePath(note.id), "member", "PATCH", { expectedRevision: 2, markup: null }); expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ revision: 2 }); expect(await noteAudit("video_note.edit")).toHaveLength(1);
    expect((await request(notePath(note.id), "member", "PATCH", { expectedRevision: 2, markup: null, drawingFrame: 10 })).status).toBe(400);
    // The note can be drawn on again afterwards.
    expect((await request(notePath(note.id), "member", "PATCH", { expectedRevision: 2, markup: MARKUP, drawingFrame: 10 })).status).toBe(200);
  });

  it("bumps the revision once for a body and markup change in one request, and one audit row", async () => {
    const version = await seedVideoVersion(); const note = await createDrawn("member", version.assetId);
    const response = await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, body: "new text", markup: [stroke("#111111", 3)] }); expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ revision: 2, body: "new text" }); expect(await noteAudit("video_note.edit")).toHaveLength(1);
    // A body-only change with identical markup is a body edit: no markup key in the audit.
    expect((await request(notePath(note.id), "member", "PATCH", { expectedRevision: 2, body: "again", markup: [stroke("#111111", 3)] })).status).toBe(200);
    expect((await meta("video_note.edit")).markup).toBeUndefined();
  });

  it("refuses frames and markup in one request (422), markup on a reply (422), and keeps markup_locks_frames", async () => {
    const version = await seedVideoVersion(); const note = await createDrawn("member", version.assetId);
    for (const body of [{ startFrame: 11, markup: MARKUP }, { endFrame: 20, markup: null }, { startFrame: 10, markup: MARKUP, drawingFrame: 10 }]) {
      const response = await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, ...body }); expect(response.status, JSON.stringify(body)).toBe(422);
      expect(await json(response)).toMatchObject({ code: "markup_and_frames" });
    }
    const reply = await seedVideoNote({ assetId: version.assetId, parentId: note.id, author: ids.member });
    const onReply = await request(notePath(reply.id), "member", "PATCH", { expectedRevision: 1, markup: MARKUP, drawingFrame: 10 }); expect(onReply.status).toBe(422); expect(await json(onReply)).toMatchObject({ code: "markup_on_reply" });
    const locked = await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, startFrame: 11 }); expect(locked.status).toBe(422); expect(await json(locked)).toMatchObject({ code: "markup_locks_frames" });
    expect(await noteRow(note.id)).toMatchObject({ revision: 1, start_frame: 10 });
    expect((await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, markup: [] })).status).toBe(400);
  });

  it("is author-only, 409 note_conflict on a stale revision (the loser writes nothing), 409 note_deleted on a tombstone", async () => {
    const version = await seedVideoVersion(); const note = await createDrawn("member", version.assetId);
    for (const who of ["admin", "other", "external"] as const) expect((await request(notePath(note.id), who, "PATCH", { expectedRevision: 1, markup: null })).status, who).toBe(403);
    const first = await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, markup: [stroke("#222222")] }); expect(first.status).toBe(200);
    const loser = await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, markup: [stroke("#333333")] }); expect(loser.status).toBe(409);
    expect(await json(loser)).toMatchObject({ code: "note_conflict", thread: { id: note.id, revision: 2, hasMarkup: true } });
    expect(JSON.parse((await markupRow(note.id))!.strokes_json)).toEqual([stroke("#222222")]);
    const tomb = await seedVideoNote({ assetId: version.assetId, deletedAt: Date.now(), startFrame: 99, author: ids.member });
    const dead = await request(notePath(tomb.id), "member", "PATCH", { expectedRevision: 1, markup: MARKUP, drawingFrame: 99 }); expect(dead.status).toBe(409); expect(await json(dead)).toMatchObject({ code: "note_deleted" });
  });

  it("repeats the frame rule and the revision in the batch SQL: a write that bypasses the route changes nothing", async () => {
    const version = await seedVideoVersion(); const point = await seedVideoNote({ assetId: version.assetId, startFrame: 10, author: ids.member });
    const head = (await findNoteHead(database.DB, ids.project, point.id))!;
    const set = (drawingFrame: number) => ({ kind: "set" as const, json: JSON.stringify(MARKUP), items: 1, bytes: 10, drawingFrame });
    const edit = (markup: Parameters<typeof editVideoNote>[1]["markup"], expectedRevision = 1) => editVideoNote(database.DB, { projectId: ids.project, note: head, principal, expectedRevision, body: head.body, startFrame: 10, endFrame: null, now: Date.now(), markup });
    expect((await edit(set(11))).kind).not.toBe("ok");
    expect(await counts()).toMatchObject({ markup: 0, audits: 0 }); expect(await noteRow(point.id)).toMatchObject({ revision: 1, drawing_frame: null });
    expect((await edit(set(10), 5)).kind).toBe("conflict");
    expect((await edit(set(10))).kind).toBe("ok"); expect(await noteRow(point.id)).toMatchObject({ revision: 2, drawing_frame: 10 });
    expect((await edit({ kind: "remove" }, 2)).kind).toBe("ok"); expect(await markupRow(point.id)).toBeNull();
  });
});

describe("the lazy markup read", () => {
  it("returns { noteId, revision, markup } with private, no-store, and null for a note without markup, a reply and a tombstone", async () => {
    const version = await seedVideoVersion(); const note = await createDrawn("member", version.assetId, { markup: [stroke(), arrow] });
    const response = await request(markupPath(note.id), "admin"); expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await json(response)).toEqual({ noteId: note.id, revision: 1, markup: [stroke(), arrow] });
    await request(notePath(note.id), "member", "PATCH", { expectedRevision: 1, markup: [stroke("#010101")] });
    expect(await json(await request(markupPath(note.id), "external"))).toEqual({ noteId: note.id, revision: 2, markup: [stroke("#010101")] });
    const plain = await seedVideoNote({ assetId: version.assetId, startFrame: 70 }); const reply = await seedVideoNote({ assetId: version.assetId, parentId: note.id });
    for (const id of [plain.id, reply.id]) { const r = await request(markupPath(id), "member"); expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("private, no-store"); expect(await json(r)).toEqual({ noteId: id, revision: 1, markup: null }); }
    await seedVideoNote({ assetId: version.assetId, parentId: note.id, author: ids.other });
    expect((await request(notePath(note.id), "member", "DELETE", { expectedRevision: 2 })).status).toBe(200);
    expect(await json(await request(markupPath(note.id), "member"))).toEqual({ noteId: note.id, revision: 3, markup: null });
  });

  it("answers 400 for a bad id, 404 for an unknown note or another Project's, 403 to a Photographer and 404 to an outsider External", async () => {
    const version = await seedVideoVersion(); const note = await seedVideoNote({ assetId: version.assetId, markup: true });
    expect((await request(`/api/projects/${ids.project}/video-notes/nope/markup`, "admin")).status).toBe(400);
    expect((await request(markupPath(crypto.randomUUID()), "admin")).status).toBe(404);
    await setVideoFlags(`video_review_pilot:${ids.otherProject}`);
    expect((await request(markupPath(note.id, ids.otherProject), "admin")).status).toBe(404);
    expect((await request(markupPath(note.id), "photographer")).status).toBe(403);
    expect((await request(markupPath(note.id), "externalOutsider")).status).toBe(404);
    for (const who of ["admin", "member", "other", "external"] as const) expect((await request(markupPath(note.id), who)).status, who).toBe(200);
  });

  it("keeps the note list to hasMarkup and drawingFrame: no strokes in it", async () => {
    const version = await seedVideoVersion(); const note = await createDrawn("member", version.assetId);
    const response = await request(notesPath(version.assetId), "admin"); const text = await response.text();
    expect(text).not.toContain("#e64b3c"); expect(text).not.toContain("strokes_json");
    expect(videoNoteListResponseSchema.parse(JSON.parse(text)).notes[0]).toMatchObject({ id: note.id, hasMarkup: true, drawingFrame: 10 });
    expect(Object.keys(JSON.parse(text).notes[0])).not.toContain("markup");
  });
});

describe("delete audit", () => {
  it("records hadMarkup on a hard delete and on a tombstone, true and false", async () => {
    const version = await seedVideoVersion();
    const drawn = await seedVideoNote({ assetId: version.assetId, markup: true, author: ids.member }); const plain = await seedVideoNote({ assetId: version.assetId, startFrame: 50, author: ids.member });
    expect((await request(notePath(drawn.id), "member", "DELETE", { expectedRevision: 1 })).status).toBe(200);
    expect((await request(notePath(plain.id), "member", "DELETE", { expectedRevision: 1 })).status).toBe(200);
    const tomb = await seedVideoNote({ assetId: version.assetId, markup: true, startFrame: 80, author: ids.member }); await seedVideoNote({ assetId: version.assetId, parentId: tomb.id, author: ids.other });
    const tomb2 = await seedVideoNote({ assetId: version.assetId, startFrame: 90, author: ids.member }); await seedVideoNote({ assetId: version.assetId, parentId: tomb2.id, author: ids.other });
    expect((await request(notePath(tomb.id), "member", "DELETE", { expectedRevision: 1 })).status).toBe(200);
    expect((await request(notePath(tomb2.id), "member", "DELETE", { expectedRevision: 1 })).status).toBe(200);
    const rows = (await noteAudit("video_note.delete")).map((row) => JSON.parse(row.meta_json!) as Json);
    expect(rows.map((row) => [row.mode, row.hadMarkup])).toEqual([["removed", true], ["removed", false], ["tombstone", true], ["tombstone", false]]);
    expect(await markupRow(tomb.id)).toBeNull();
  });
});

describe("paste carries markup", () => {
  const pairOf = async (frames?: number, fps?: [number, number]) => {
    const v1 = await seedVideoVersion({ version: 1 }); const v2 = await seedVideoVersion({ videoId: v1.videoId, version: 2 });
    if (frames || fps) await database.DB.prepare("UPDATE video_version_meta SET frame_count = ?, fps_num = ?, fps_den = ? WHERE asset_id = ?").bind(frames ?? 250, fps?.[0] ?? 25, fps?.[1] ?? 1, v2.assetId).run();
    return { v1, v2 };
  };
  const pastePath = (target: string, kind: "preview" | "commit") => `/api/projects/${ids.project}/video-versions/${target}/note-paste${kind === "preview" ? "/preview" : ""}`;
  async function paste(target: string, source: string, noteIds: string[], offsetFrames = 0) {
    const preview = await request(pastePath(target, "preview"), "member", "POST", { sourceAssetId: source, noteIds, offsetFrames }); expect(preview.status).toBe(200);
    const rows = videoNotePastePreviewResponseSchema.parse(await preview.json()).rows;
    const commit = await request(pastePath(target, "commit"), "member", "POST", { sourceAssetId: source, offsetFrames, notes: rows.flatMap((row) => row.status === "skipped" ? (row.source ? [{ noteId: row.noteId, revision: row.source.revision }] : []) : [{ noteId: row.noteId, revision: row.source.revision }]) });
    expect(commit.status, await commit.clone().text()).toBe(200); return { rows, receipt: await json(commit) };
  }
  const copyOf = (sourceId: string, target: string) => database.DB.prepare("SELECT * FROM video_notes WHERE copied_from_note_id = ? AND asset_id = ?").bind(sourceId, target).first<Record<string, any>>();

  it("copies the markup rows and the mapped drawing frame, even with the markup part off, and counts them in the paste audit", async () => {
    const { v1, v2 } = await pairOf(500, [50, 1]);
    const point = await seedVideoNote({ assetId: v1.assetId, startFrame: 10, markup: true }); const range = await seedVideoNote({ assetId: v1.assetId, startFrame: 20, endFrame: 30, drawingFrame: 24, markup: true }); const plain = await seedVideoNote({ assetId: v1.assetId, startFrame: 40 });
    await clearVideoFlags(); await setVideoFlags("video_review", "video_review_notes", `video_review_pilot:${ids.project}`);
    const { receipt } = await paste(v2.assetId, v1.assetId, [point.id, range.id, plain.id]);
    expect(receipt).toMatchObject({ copied: 3, skipped: 0 });
    const pointCopy = (await copyOf(point.id, v2.assetId))!; const rangeCopy = (await copyOf(range.id, v2.assetId))!; const plainCopy = (await copyOf(plain.id, v2.assetId))!;
    // 25 -> 50 fps maps a frame's middle moment: 10 -> 21, 20 -> 41, 24 -> 49.
    expect(pointCopy).toMatchObject({ start_frame: 21, drawing_frame: 21 }); expect(rangeCopy).toMatchObject({ start_frame: 41, drawing_frame: 49 }); expect(plainCopy.drawing_frame).toBeNull();
    expect((await markupRow(pointCopy.id))!.strokes_json).toBe(SEED_STROKES_JSON); expect((await markupRow(rangeCopy.id))!.strokes_json).toBe(SEED_STROKES_JSON); expect(await markupRow(plainCopy.id)).toBeNull();
    expect(JSON.parse((await noteAudit("video_note.paste"))[0]!.meta_json!)).toMatchObject({ copied: 3, markupCopied: 2 });
    expect(await noteRow(point.id)).toMatchObject({ revision: 1, drawing_frame: 10 });
    // A repeat copies nothing, writes no second markup row and counts none.
    const again = await paste(v2.assetId, v1.assetId, [point.id]); expect(again.receipt).toMatchObject({ copied: 0 });
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM video_note_markup").first<{ n: number }>())!.n).toBe(4);
    expect(JSON.parse((await noteAudit("video_note.paste"))[1]!.meta_json!)).toMatchObject({ copied: 0, markupCopied: 0 });
  });

  it("skips a note whose mapped drawing frame falls outside the target note with drawing_outside, and writes nothing for it", async () => {
    const { v1, v2 } = await pairOf(15);
    const clipped = await seedVideoNote({ assetId: v1.assetId, startFrame: 10, endFrame: 20, drawingFrame: 18, markup: true }); const fine = await seedVideoNote({ assetId: v1.assetId, startFrame: 2, endFrame: 8, drawingFrame: 4, markup: true });
    const { rows, receipt } = await paste(v2.assetId, v1.assetId, [clipped.id, fine.id]);
    expect(rows.find((row) => row.noteId === clipped.id)).toMatchObject({ status: "skipped", reason: "drawing_outside" });
    expect(receipt).toMatchObject({ copied: 1, skipped: 1 });
    expect(await copyOf(clipped.id, v2.assetId)).toBeNull();
    expect(JSON.parse((await noteAudit("video_note.paste"))[0]!.meta_json!)).toMatchObject({ skippedByReason: { drawing_outside: 1, out_of_range: 0 }, markupCopied: 1 });
  });

  it("repeats the drawing rule in the paste INSERT: a copy whose drawing frame is outside its range lands nothing", async () => {
    const { PASTE_INSERT_SQL } = await import("../src/lib/video-notes-sql");
    const { v1, v2 } = await pairOf();
    const source = await seedVideoNote({ assetId: v1.assetId, startFrame: 10, endFrame: 20, markup: true });
    const attempt = (draw: number | null, id: string) => database.DB.prepare(PASTE_INSERT_SQL).bind(
      JSON.stringify([{ id, src: source.id, start: 10, end: 20, draw }]), v2.assetId, ids.project, v1.assetId, ids.member, "editor", 1, Date.now(), JSON.stringify([{ id: source.id, rev: 1 }]), 1,
    ).run();
    const bad = crypto.randomUUID(); const good = crypto.randomUUID();
    for (const draw of [9, 20, 25]) expect((await attempt(draw, bad)).meta.changes, `draw ${draw}`).toBe(0);
    expect((await attempt(15, good)).meta.changes).toBe(1);
    expect(await noteRow(bad)).toBeNull(); expect(await noteRow(good)).toMatchObject({ drawing_frame: 15, start_frame: 10, end_frame: 20 });
  });
});
