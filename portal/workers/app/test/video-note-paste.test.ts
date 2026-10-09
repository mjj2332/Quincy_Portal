import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  EXTERNAL_API_RESPONSE_SCHEMAS, mapBoundary, mapFrame, rational, videoNotePasteCommitResponseSchema, videoNotePastePreviewResponseSchema, videoNotePasteStaleSchema,
  type VideoNotePasteRow,
} from "@quincy/shared";
import { commitNotePaste } from "../src/lib/video-note-paste";
import { baseEnv, database, ids, request, seedFixture, type Who } from "./embedded-media-support";
import { clearVideoFlags, clearVideoNotes, noteAudit, noteRow, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** Copying notes between Versions of a Video (#741, 5c-api): preview and commit, with real sessions per role. */
const OPEN = ["video_review", "video_review_notes", `video_review_pilot:${ids.project}`] as const;
type Json = Record<string, any>;
const json = async (response: Response) => await response.json() as Json;

const pastePath = (target: string, kind: "preview" | "commit", projectId: string = ids.project) =>
  `/api/projects/${projectId}/video-versions/${target}/note-paste${kind === "preview" ? "/preview" : ""}`;
const preview = (who: Who, target: string, body: Json, projectId: string = ids.project) => request(pastePath(target, "preview", projectId), who, "POST", body);
const commit = (who: Who, target: string, body: Json, projectId: string = ids.project) => request(pastePath(target, "commit", projectId), who, "POST", body);

/** Two Versions of one Video (25 fps, 250 frames each unless `meta` says otherwise). */
async function pair(meta: { fpsNum?: number; fpsDen?: number; frames?: number } = {}) {
  const v1 = await seedVideoVersion({ version: 1 });
  const v2 = await seedVideoVersion({ videoId: v1.videoId, version: 2 });
  if (meta.fpsNum || meta.fpsDen || meta.frames) {
    await database.DB.prepare("UPDATE video_version_meta SET fps_num = ?, fps_den = ?, frame_count = ? WHERE asset_id = ?").bind(meta.fpsNum ?? 25, meta.fpsDen ?? 1, meta.frames ?? 250, v2.assetId).run();
  }
  return { v1, v2 };
}
const previewBody = (source: string, noteIds: string[], offsetFrames?: number) => ({ sourceAssetId: source, noteIds, ...(offsetFrames === undefined ? {} : { offsetFrames }) });
const commitBody = (source: string, rows: VideoNotePasteRow[], offsetFrames?: number) => ({
  sourceAssetId: source, notes: rows.flatMap((row) => row.status === "skipped" ? (row.source ? [{ noteId: row.noteId, revision: row.source.revision }] : []) : [{ noteId: row.noteId, revision: row.source.revision }]),
  ...(offsetFrames === undefined ? {} : { offsetFrames }),
});
async function previewRows(who: Who, target: string, source: string, noteIds: string[], offsetFrames?: number) {
  const response = await preview(who, target, previewBody(source, noteIds, offsetFrames)); expect(response.status, await response.clone().text()).toBe(200);
  return videoNotePastePreviewResponseSchema.parse(await response.json());
}
/** Previews and then commits exactly what the preview listed. */
async function paste(who: Who, target: string, source: string, noteIds: string[], offsetFrames?: number) {
  const rows = (await previewRows(who, target, source, noteIds, offsetFrames)).rows;
  const response = await commit(who, target, commitBody(source, rows, offsetFrames)); expect(response.status, await response.clone().text()).toBe(200);
  return videoNotePasteCommitResponseSchema.parse(await response.json());
}
const counts = async () => await database.DB.prepare("SELECT (SELECT COUNT(*) FROM video_notes) AS notes, (SELECT COUNT(*) FROM audit_log WHERE action LIKE 'video_note.%') AS audits").first<{ notes: number; audits: number }>();
const copyOf = async (sourceId: string, target: string) => await database.DB.prepare("SELECT * FROM video_notes WHERE copied_from_note_id = ? AND asset_id = ?").bind(sourceId, target).first<Record<string, any>>();

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearVideoFlags(); await setVideoFlags(...OPEN); await clearVideoNotes(); });
afterEach(async () => { await clearVideoFlags(); });

describe("admission order, on preview and on commit alike", () => {
  const both = (target: string, source: string, note: string) => [
    ["preview", pastePath(target, "preview"), previewBody(source, [note])] as const,
    ["commit", pastePath(target, "commit"), { sourceAssetId: source, notes: [{ noteId: note, revision: 1 }] }] as const,
  ];

  it("answers one 404 for a real and an unknown id when the master, the notes part or the Project's pilot is off", async () => {
    const { v1, v2 } = await pair(); const note = await seedVideoNote({ assetId: v1.assetId });
    const closings: Array<[string, () => Promise<void>]> = [
      ["master off", async () => { await clearVideoFlags(); await setVideoFlags("video_review_notes", `video_review_pilot:${ids.project}`); }],
      ["notes off", async () => { await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.project}`); }],
      ["another Project's pilot", async () => { await clearVideoFlags(); await setVideoFlags("video_review", "video_review_notes", `video_review_pilot:${ids.otherProject}`); }],
    ];
    for (const [label, close] of closings) {
      await close();
      for (const who of ["admin", "member", "external", "photographer"] as const) {
        const real = both(v2.assetId, v1.assetId, note.id); const unknown = both(crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID());
        for (let i = 0; i < real.length; i += 1) {
          const a = await request(real[i]![1], who, "POST", real[i]![2]); const b = await request(unknown[i]![1], who, "POST", unknown[i]![2]);
          expect([a.status, b.status], `${label} ${who} ${real[i]![0]}`).toEqual([404, 404]);
          expect(await json(a), label).toEqual(await json(b));
        }
      }
    }
    expect(await counts()).toEqual({ notes: 1, audits: 0 });
  });

  it("answers 400 for a malformed id before the gate, then 403 to a Photographer before anything else, then 404 to an outsider External", async () => {
    const { v1, v2 } = await pair(); const note = await seedVideoNote({ assetId: v1.assetId });
    expect((await request(`/api/projects/not-a-uuid/video-versions/${v2.assetId}/note-paste/preview`, "admin", "POST", previewBody(v1.assetId, [note.id]))).status).toBe(400);
    expect((await request(`/api/projects/${ids.project}/video-versions/nope/note-paste`, "admin", "POST", {})).status).toBe(400);
    for (const [label, path, body] of both(v2.assetId, v1.assetId, note.id)) {
      expect((await request(path, "photographer", "POST", body)).status, `photographer ${label}`).toBe(403);
      expect((await request(path, "externalOutsider", "POST", body)).status, `outsider ${label}`).toBe(404);
      // Capability is checked before the body: a Photographer's malformed body is still 403.
      expect((await request(path, "photographer", "POST", { nonsense: true })).status, `photographer malformed ${label}`).toBe(403);
    }
  });

  it("refuses an archived Project after the capability: staff 409, External 404, a Photographer still 403, and no archived-Project row is written", async () => {
    const P = ids.archivedProject; await setVideoFlags(`video_review_pilot:${P}`);
    const v1 = await seedVideoVersion({ projectId: P, uploader: ids.member }); const v2 = await seedVideoVersion({ projectId: P, videoId: v1.videoId, version: 2, uploader: ids.member });
    const note = await seedVideoNote({ assetId: v1.assetId, author: ids.member });
    for (const [label, path, body] of [
      ["preview", pastePath(v2.assetId, "preview", P), previewBody(v1.assetId, [note.id])] as const,
      ["commit", pastePath(v2.assetId, "commit", P), { sourceAssetId: v1.assetId, notes: [{ noteId: note.id, revision: 1 }] }] as const,
    ]) {
      for (const who of ["admin", "member"] as const) {
        const response = await request(path, who, "POST", body);
        expect([response.status, (await json(response)).code], `${who} ${label}`).toEqual([409, "project_archived"]);
      }
      expect((await request(path, "external", "POST", body)).status, `external ${label}`).toBe(404);
      expect((await request(path, "photographer", "POST", body)).status, `photographer ${label}`).toBe(403);
    }
    expect(await counts()).toEqual({ notes: 1, audits: 0 });
  });

  it("writes nothing when an archive lands inside the commit batch", async () => {
    const project = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Race Street', 'editing_autohdr', ?, ?)").bind(project, now, now).run();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), project, ids.member, now).run();
    await setVideoFlags(`video_review_pilot:${project}`);
    const v1 = await seedVideoVersion({ projectId: project, uploader: ids.member }); const v2 = await seedVideoVersion({ projectId: project, videoId: v1.videoId, version: 2, uploader: ids.member });
    const note = await seedVideoNote({ assetId: v1.assetId, author: ids.member });
    const outcome = await commitThroughRacingDb(2, async () => { await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), project).run(); }, {
      projectId: project, targetAssetId: v2.assetId, sourceAssetId: v1.assetId, notes: [{ noteId: note.id, revision: 1 }],
    });
    expect(outcome.kind).toBe("archived");
    expect(await counts()).toEqual({ notes: 1, audits: 0 });
  });
});

describe("the input", () => {
  it("rejects visibility, a body, frames or any other key with 400 on both routes", async () => {
    const { v1, v2 } = await pair(); const note = await seedVideoNote({ assetId: v1.assetId });
    for (const extra of [{ visibility: "public" }, { visibility: "internal" }, { body: "mine" }, { startFrame: 3 }, { authorId: ids.admin }]) {
      expect((await preview("admin", v2.assetId, { ...previewBody(v1.assetId, [note.id]), ...extra })).status, JSON.stringify(extra)).toBe(400);
      expect((await commit("admin", v2.assetId, { sourceAssetId: v1.assetId, notes: [{ noteId: note.id, revision: 1 }], ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
    expect((await commit("admin", v2.assetId, { sourceAssetId: v1.assetId, notes: [{ noteId: note.id, revision: 1, visibility: "public" }] })).status).toBe(400);
    expect(await counts()).toEqual({ notes: 1, audits: 0 });
  });

  it("accepts 100 notes and refuses 101, an empty list, duplicates, a non-integer or huge offset, and a revision below 1 with 400", async () => {
    const { v1, v2 } = await pair(); const ids100 = Array.from({ length: 100 }, () => crypto.randomUUID());
    expect((await preview("admin", v2.assetId, previewBody(v1.assetId, ids100))).status).toBe(200);
    expect((await preview("admin", v2.assetId, previewBody(v1.assetId, [...ids100, crypto.randomUUID()]))).status).toBe(400);
    expect((await commit("admin", v2.assetId, { sourceAssetId: v1.assetId, notes: [...ids100, crypto.randomUUID()].map((noteId) => ({ noteId, revision: 1 })) })).status).toBe(400);
    expect((await preview("admin", v2.assetId, previewBody(v1.assetId, []))).status).toBe(400);
    const dup = crypto.randomUUID();
    expect((await preview("admin", v2.assetId, previewBody(v1.assetId, [dup, dup]))).status).toBe(400);
    expect((await commit("admin", v2.assetId, { sourceAssetId: v1.assetId, notes: [{ noteId: dup, revision: 1 }, { noteId: dup, revision: 1 }] })).status).toBe(400);
    for (const offsetFrames of [1.5, 1_000_001, -1_000_001]) expect((await preview("admin", v2.assetId, previewBody(v1.assetId, [dup], offsetFrames))).status, String(offsetFrames)).toBe(400);
    expect((await commit("admin", v2.assetId, { sourceAssetId: v1.assetId, notes: [{ noteId: dup, revision: 0 }] })).status).toBe(400);
  });

  it("is 404 for an unknown or other-Project target or source, and 422 for the same Version or a Version of another Video", async () => {
    const { v1, v2 } = await pair(); const note = await seedVideoNote({ assetId: v1.assetId });
    const stranger = await seedVideoVersion(); const elsewhere = await seedVideoVersion({ projectId: ids.otherProject }); await setVideoFlags(`video_review_pilot:${ids.otherProject}`);
    expect((await preview("admin", crypto.randomUUID(), previewBody(v1.assetId, [note.id]))).status).toBe(404);
    expect((await preview("admin", v2.assetId, previewBody(crypto.randomUUID(), [note.id]))).status).toBe(404);
    expect((await preview("admin", v2.assetId, previewBody(elsewhere.assetId, [note.id]))).status).toBe(404);
    expect((await preview("admin", elsewhere.assetId, previewBody(v1.assetId, [note.id]))).status).toBe(404);
    expect(await json(await preview("admin", v1.assetId, previewBody(v1.assetId, [note.id])))).toMatchObject({ code: "same_version" });
    expect((await preview("admin", v1.assetId, previewBody(v1.assetId, [note.id]))).status).toBe(422);
    expect(await json(await preview("admin", stranger.assetId, previewBody(v1.assetId, [note.id])))).toMatchObject({ code: "not_same_video" });
    expect((await commit("admin", stranger.assetId, { sourceAssetId: v1.assetId, notes: [{ noteId: note.id, revision: 1 }] })).status).toBe(422);
    expect(await counts()).toEqual({ notes: 1, audits: 0 });
  });
});

describe("preview", () => {
  it("writes nothing: no note and no audit row, however often it runs", async () => {
    const { v1, v2 } = await pair(); const note = await seedVideoNote({ assetId: v1.assetId });
    const before = await counts();
    for (let i = 0; i < 3; i += 1) await previewRows("admin", v2.assetId, v1.assetId, [note.id], i);
    expect(await counts()).toEqual(before);
  });

  it("maps 25 to 30000/1001 by the middle moment, maps a range end as a boundary, applies the offset, and keeps the response strict for staff and External", async () => {
    const { v1, v2 } = await pair({ fpsNum: 30000, fpsDen: 1001, frames: 300 });
    const point = await seedVideoNote({ assetId: v1.assetId, startFrame: 10 });
    const range = await seedVideoNote({ assetId: v1.assetId, startFrame: 20, endFrame: 21 });
    const from = rational(25, 1); const to = rational(30000, 1001);
    for (const offset of [0, 7, -3]) {
      const result = await previewRows("admin", v2.assetId, v1.assetId, [point.id, range.id], offset);
      expect(result).toMatchObject({ sourceVersion: 1, targetVersion: 2, offsetFrames: offset });
      const [a, b] = result.rows;
      expect(a).toMatchObject({ noteId: point.id, status: "mapped", to: { startFrame: mapFrame(10, from, to) + offset, endFrame: null }, source: { revision: 1, visibility: "public", authorName: "Member Person", from: { startFrame: 10, endFrame: null } } });
      const start = mapFrame(20, from, to) + offset;
      expect(b).toMatchObject({ noteId: range.id, status: "mapped", to: { startFrame: start, endFrame: Math.max(mapBoundary(21, from, to) + offset, start + 1) } });
    }
    const response = await preview("external", v2.assetId, previewBody(v1.assetId, [point.id]));
    EXTERNAL_API_RESPONSE_SCHEMAS["video-note-paste-preview"].parse(await response.json());
  });

  it("flags a range clipped at the target's end as shortened", async () => {
    const { v1, v2 } = await pair({ frames: 100 });
    const note = await seedVideoNote({ assetId: v1.assetId, startFrame: 90, endFrame: 200 });
    expect((await previewRows("admin", v2.assetId, v1.assetId, [note.id])).rows[0]).toMatchObject({ status: "mapped", shortened: true, to: { startFrame: 90, endFrame: 100 } });
  });

  it("skips out_of_range both past the end and before the start, and lists the row instead of dropping it", async () => {
    const { v1, v2 } = await pair({ frames: 100 });
    const late = await seedVideoNote({ assetId: v1.assetId, startFrame: 150 }); const early = await seedVideoNote({ assetId: v1.assetId, startFrame: 5 });
    const edge = await seedVideoNote({ assetId: v1.assetId, startFrame: 99 });
    const result = await previewRows("admin", v2.assetId, v1.assetId, [late.id, early.id, edge.id], -10);
    expect(result.rows.map((row) => [row.noteId, row.status, row.status === "skipped" ? row.reason : null])).toEqual([[late.id, "skipped", "out_of_range"], [early.id, "skipped", "out_of_range"], [edge.id, "mapped", null]]);
    expect(result.rows[0]).toMatchObject({ source: { revision: 1, from: { startFrame: 150 } } });
  });

  it("skips a reply, a deleted note and an id that is not on the source Version, each with its reason, in request order", async () => {
    const { v1, v2 } = await pair();
    const root = await seedVideoNote({ assetId: v1.assetId }); const reply = await seedVideoNote({ assetId: v1.assetId, parentId: root.id });
    const tomb = await seedVideoNote({ assetId: v1.assetId, startFrame: 30, deletedAt: Date.now(), body: "" }); const live = await seedVideoNote({ assetId: v1.assetId, startFrame: 40 });
    const onTarget = await seedVideoNote({ assetId: v2.assetId, startFrame: 50 }); const unknown = crypto.randomUUID();
    const result = await previewRows("admin", v2.assetId, v1.assetId, [reply.id, tomb.id, live.id, onTarget.id, unknown]);
    expect(result.rows.map((row) => [row.noteId, row.status, row.status === "skipped" ? row.reason : null])).toEqual([
      [reply.id, "skipped", "reply"], [tomb.id, "skipped", "deleted"], [live.id, "mapped", null], [onTarget.id, "skipped", "deleted"], [unknown, "skipped", "deleted"],
    ]);
    expect(result.rows[0]).toMatchObject({ source: { revision: 1, from: { startFrame: null, endFrame: null } } });
    expect(result.rows[3]).toMatchObject({ source: null }); expect(result.rows[4]).toMatchObject({ source: null });
  });
});

describe("commit", () => {
  it("copies body and visibility from the source row, keeps internal internal, opens a resolved note, drops replies, and credits the paster as author", async () => {
    const { v1, v2 } = await pair();
    const internal = await seedVideoNote({ assetId: v1.assetId, visibility: "internal", body: "Internal words", startFrame: 12, endFrame: 30 });
    const open = await seedVideoNote({ assetId: v1.assetId, visibility: "public", body: "Public words", startFrame: 40, resolvedBy: ids.admin });
    await seedVideoNote({ assetId: v1.assetId, parentId: internal.id, body: "A reply" });
    const result = await paste("admin", v2.assetId, v1.assetId, [internal.id, open.id], 5);
    expect([result.copied, result.skipped]).toEqual([2, 0]);
    const a = await copyOf(internal.id, v2.assetId); const b = await copyOf(open.id, v2.assetId);
    expect(a).toMatchObject({ visibility: "internal", body: "Internal words", start_frame: 17, end_frame: 35, author_user_id: ids.admin, author_role: "admin", revision: 1, resolved_at: null, resolved_by: null, parent_id: null, drawing_frame: null, copied_from_version: 1, original_author_name: "Member Person", original_author_role: "editor", deleted_at: null });
    expect(b).toMatchObject({ visibility: "public", body: "Public words", start_frame: 45, end_frame: null, resolved_at: null });
    expect(await database.DB.prepare("SELECT COUNT(*) AS n FROM video_notes WHERE asset_id = ?").bind(v2.assetId).first()).toEqual({ n: 2 });
    expect(result.rows.map((row) => row.status === "copied" ? row.copyId : null)).toEqual([a!.id, b!.id]);
    const listed = await json(await request(`/api/projects/${ids.project}/video-versions/${v2.assetId}/notes`, "member"));
    expect(listed.notes.find((n: Json) => n.id === a!.id)).toMatchObject({ copiedFrom: { version: 1, authorName: "Member Person", authorRole: "editor" }, visibility: "internal", author: { person: { id: ids.admin } } });
  });

  it("preview and commit agree on every mapped frame", async () => {
    const { v1, v2 } = await pair({ fpsNum: 30000, fpsDen: 1001, frames: 300 });
    const a = await seedVideoNote({ assetId: v1.assetId, startFrame: 3, endFrame: 90 }); const b = await seedVideoNote({ assetId: v1.assetId, startFrame: 200 });
    const planned = await previewRows("admin", v2.assetId, v1.assetId, [a.id, b.id], 4);
    const result = await paste("admin", v2.assetId, v1.assetId, [a.id, b.id], 4);
    expect(result.rows.map((row) => row.status === "copied" ? [row.noteId, row.to] : null)).toEqual(planned.rows.map((row) => row.status === "mapped" ? [row.noteId, row.to] : null));
    for (const row of result.rows) if (row.status === "copied") expect(await noteRow(row.copyId)).toMatchObject({ start_frame: row.to.startFrame, end_frame: row.to.endFrame });
  });

  it("writes exactly one audit row, with counts by reason and no note text", async () => {
    const { v1, v2 } = await pair({ frames: 100 });
    const ok = await seedVideoNote({ assetId: v1.assetId, body: "SECRET-BODY-TEXT", startFrame: 10 }); const far = await seedVideoNote({ assetId: v1.assetId, startFrame: 200 });
    const root = await seedVideoNote({ assetId: v1.assetId, startFrame: 20 }); const reply = await seedVideoNote({ assetId: v1.assetId, parentId: root.id });
    const tomb = await seedVideoNote({ assetId: v1.assetId, startFrame: 30, deletedAt: Date.now(), body: "" });
    await paste("member", v2.assetId, v1.assetId, [ok.id, far.id, reply.id, tomb.id]);
    const audits = await noteAudit("video_note.paste"); expect(audits).toHaveLength(1); expect((await noteAudit()).filter((a) => a.action.startsWith("video_note.")).length).toBe(1);
    expect(audits[0]).toMatchObject({ actor_id: ids.member, target_id: v2.assetId });
    const meta = JSON.parse(audits[0]!.meta_json!);
    expect(meta).toMatchObject({ projectId: ids.project, videoId: v1.videoId, sourceAssetId: v1.assetId, sourceVersion: 1, targetAssetId: v2.assetId, targetVersion: 2, offsetFrames: 0, requested: 4, copied: 1, skipped: 3, skippedByReason: { already_copied: 0, out_of_range: 1, deleted: 1, reply: 1 } });
    expect(audits[0]!.meta_json).not.toContain("SECRET-BODY-TEXT");
  });

  it("writes one audit row even when every note was skipped, and copies nothing", async () => {
    const { v1, v2 } = await pair();
    const root = await seedVideoNote({ assetId: v1.assetId }); const reply = await seedVideoNote({ assetId: v1.assetId, parentId: root.id });
    const tomb = await seedVideoNote({ assetId: v1.assetId, startFrame: 30, deletedAt: Date.now(), body: "" });
    const before = await counts();
    const result = await paste("admin", v2.assetId, v1.assetId, [reply.id, tomb.id]);
    expect([result.copied, result.skipped]).toEqual([0, 2]);
    expect(await counts()).toEqual({ notes: before!.notes, audits: 1 });
    expect(JSON.parse((await noteAudit("video_note.paste"))[0]!.meta_json!)).toMatchObject({ requested: 2, copied: 0, skipped: 2, skippedByReason: { already_copied: 0, out_of_range: 0, deleted: 1, reply: 1 } });
  });

  it("is idempotent: a repeat commit copies nothing new, reports already_copied, and writes one more audit row", async () => {
    const { v1, v2 } = await pair(); const a = await seedVideoNote({ assetId: v1.assetId, startFrame: 10 }); const b = await seedVideoNote({ assetId: v1.assetId, startFrame: 20 });
    const rows = (await previewRows("admin", v2.assetId, v1.assetId, [a.id, b.id])).rows; const body = commitBody(v1.assetId, rows);
    const first = videoNotePasteCommitResponseSchema.parse(await (await commit("admin", v2.assetId, body)).json());
    expect([first.copied, first.skipped]).toEqual([2, 0]);
    const second = await commit("admin", v2.assetId, body); expect(second.status).toBe(200);
    const again = videoNotePasteCommitResponseSchema.parse(await second.json());
    expect([again.copied, again.skipped]).toEqual([0, 2]);
    expect(again.rows.map((row) => row.status === "skipped" ? row.reason : null)).toEqual(["already_copied", "already_copied"]);
    expect(await database.DB.prepare("SELECT COUNT(*) AS n FROM video_notes WHERE asset_id = ?").bind(v2.assetId).first()).toEqual({ n: 2 });
    const audits = await noteAudit("video_note.paste"); expect(audits).toHaveLength(2);
    expect(JSON.parse(audits[1]!.meta_json!)).toMatchObject({ copied: 0, skipped: 2, skippedByReason: { already_copied: 2 } });
    EXTERNAL_API_RESPONSE_SCHEMAS["video-note-paste"].parse(again);
  });

  it("copies each note once when two commits race, and the loser's audit row counts the notes it lost as already_copied", async () => {
    const { v1, v2 } = await pair(); const notes = await Promise.all([10, 20, 30].map((startFrame) => seedVideoNote({ assetId: v1.assetId, startFrame })));
    const rows = (await previewRows("admin", v2.assetId, v1.assetId, notes.map((n) => n.id))).rows; const body = commitBody(v1.assetId, rows);
    const responses = await Promise.all([commit("admin", v2.assetId, body), commit("member", v2.assetId, body)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const receipts = await Promise.all(responses.map(async (r) => videoNotePasteCommitResponseSchema.parse(await r.json())));
    expect(receipts.reduce((sum, r) => sum + r.copied, 0)).toBe(3);
    expect(await database.DB.prepare("SELECT COUNT(*) AS n FROM video_notes WHERE asset_id = ?").bind(v2.assetId).first()).toEqual({ n: 3 });
    const audits = await noteAudit("video_note.paste"); expect(audits).toHaveLength(2);
    expect(audits.reduce((sum, a) => sum + JSON.parse(a.meta_json!).copied, 0)).toBe(3);
  });

  it("skips already_copied for a one-step chain: a copy pasted back onto the Version of its original, and a sibling copy of the same original", async () => {
    const { v1, v2 } = await pair(); const v3 = await seedVideoVersion({ videoId: v1.videoId, version: 3 });
    const original = await seedVideoNote({ assetId: v1.assetId, startFrame: 10 });
    await paste("admin", v2.assetId, v1.assetId, [original.id]);
    const copy = await copyOf(original.id, v2.assetId);
    // v2's copy back onto v1: its original is already there.
    expect((await previewRows("admin", v1.assetId, v2.assetId, [copy!.id])).rows[0]).toMatchObject({ status: "skipped", reason: "already_copied" });
    const back = await paste("admin", v1.assetId, v2.assetId, [copy!.id]);
    expect([back.copied, back.skipped]).toEqual([0, 1]);
    expect(await database.DB.prepare("SELECT COUNT(*) AS n FROM video_notes WHERE asset_id = ?").bind(v1.assetId).first()).toEqual({ n: 1 });
    // v1 -> v3 directly, then v2's copy onto v3: they are siblings of the same original.
    await paste("admin", v3.assetId, v1.assetId, [original.id]);
    expect((await previewRows("admin", v3.assetId, v2.assetId, [copy!.id])).rows[0]).toMatchObject({ status: "skipped", reason: "already_copied" });
    expect((await paste("admin", v3.assetId, v2.assetId, [copy!.id])).copied).toBe(0);
  });

  it("keeps a tombstoned copy occupying its slot, and frees the slot when the copy was hard-deleted", async () => {
    const { v1, v2 } = await pair(); const note = await seedVideoNote({ assetId: v1.assetId, startFrame: 10 });
    await paste("admin", v2.assetId, v1.assetId, [note.id]); const copy = (await copyOf(note.id, v2.assetId))!;
    await database.DB.prepare("UPDATE video_notes SET deleted_at = ?, body = '' WHERE id = ?").bind(Date.now(), copy.id).run();
    expect((await paste("admin", v2.assetId, v1.assetId, [note.id])).copied).toBe(0);
    await database.DB.prepare("DELETE FROM video_notes WHERE id = ?").bind(copy.id).run();
    expect((await paste("admin", v2.assetId, v1.assetId, [note.id])).copied).toBe(1);
  });

  it("carries the original author's name and role through a copy of a copy, keeping the immediate source and version", async () => {
    const { v1, v2 } = await pair(); const v3 = await seedVideoVersion({ videoId: v1.videoId, version: 3 });
    const staff = await seedVideoNote({ assetId: v1.assetId, author: ids.other, role: "editor", startFrame: 10 });
    const guest = await seedVideoNote({ assetId: v1.assetId, guest: true, startFrame: 20 });
    await paste("admin", v2.assetId, v1.assetId, [staff.id, guest.id]);
    const c2 = (await copyOf(staff.id, v2.assetId))!; const g2 = (await copyOf(guest.id, v2.assetId))!;
    expect(c2).toMatchObject({ original_author_name: "Other Person", original_author_role: "editor", author_user_id: ids.admin, author_guest_id: null, copied_from_version: 1 });
    expect(g2).toMatchObject({ original_author_name: "Client Person", original_author_role: "guest", visibility: "public", author_user_id: ids.admin, author_role: "admin" });
    await paste("member", v3.assetId, v2.assetId, [c2.id, g2.id]);
    expect(await copyOf(c2.id, v3.assetId)).toMatchObject({ copied_from_version: 2, original_author_name: "Other Person", original_author_role: "editor", author_user_id: ids.member, author_role: "editor" });
    expect(await copyOf(g2.id, v3.assetId)).toMatchObject({ copied_from_version: 2, original_author_name: "Client Person", original_author_role: "guest" });
  });

  it("makes the copy the paster's own note for author-only edits, and leaves a copy standing when its source is hard-deleted", async () => {
    const { v1, v2 } = await pair(); const note = await seedVideoNote({ assetId: v1.assetId, author: ids.other });
    await paste("member", v2.assetId, v1.assetId, [note.id]); const copy = (await copyOf(note.id, v2.assetId))!;
    expect((await request(`/api/projects/${ids.project}/video-notes/${copy.id}`, "other", "PATCH", { expectedRevision: 1, body: "x" })).status).toBe(403);
    expect((await request(`/api/projects/${ids.project}/video-notes/${copy.id}`, "member", "PATCH", { expectedRevision: 1, body: "mine" })).status).toBe(200);
    await database.DB.prepare("DELETE FROM video_notes WHERE id = ?").bind(note.id).run();
    expect(await noteRow(copy.id)).toMatchObject({ copied_from_note_id: null, copied_from_version: 1, original_author_name: "Other Person" });
  });

  it("lets an assigned External editor paste both visibilities, and treats a note from another Project as not on the source Version", async () => {
    const { v1, v2 } = await pair(); const pub = await seedVideoNote({ assetId: v1.assetId, startFrame: 10 }); const priv = await seedVideoNote({ assetId: v1.assetId, visibility: "internal", startFrame: 20 });
    const foreign = await seedVideoVersion({ projectId: ids.otherProject }); const hidden = await seedVideoNote({ assetId: foreign.assetId, visibility: "internal", body: "not yours" });
    const rows = (await previewRows("external", v2.assetId, v1.assetId, [pub.id, priv.id, hidden.id])).rows;
    expect(rows[2]).toMatchObject({ status: "skipped", reason: "deleted", source: null });
    expect(JSON.stringify(rows)).not.toContain("not yours");
    const response = await commit("external", v2.assetId, commitBody(v1.assetId, rows)); expect(response.status).toBe(200);
    const receipt = videoNotePasteCommitResponseSchema.parse(await response.json());
    expect([receipt.copied, receipt.skipped, receipt.rows.length]).toEqual([2, 0, 2]); // the vanished row has no revision to send
    expect(await copyOf(priv.id, v2.assetId)).toMatchObject({ visibility: "internal", author_user_id: ids.external, author_role: "external_editor" });
    expect(await database.DB.prepare("SELECT COUNT(*) AS n FROM video_notes WHERE asset_id = ? AND project_id = ?").bind(foreign.assetId, ids.otherProject).first()).toEqual({ n: 1 });
  });

  it("answers an outsider External 404 and writes nothing", async () => {
    const { v1, v2 } = await pair(); const note = await seedVideoNote({ assetId: v1.assetId });
    expect((await commit("externalOutsider", v2.assetId, { sourceAssetId: v1.assetId, notes: [{ noteId: note.id, revision: 1 }] })).status).toBe(404);
    expect(await counts()).toEqual({ notes: 1, audits: 0 });
  });
});

describe("staleness", () => {
  it("answers 409 paste_stale with a fresh preview and writes nothing when a source note was edited after the preview", async () => {
    const { v1, v2 } = await pair(); const a = await seedVideoNote({ assetId: v1.assetId, startFrame: 10 }); const b = await seedVideoNote({ assetId: v1.assetId, startFrame: 20 });
    const rows = (await previewRows("admin", v2.assetId, v1.assetId, [a.id, b.id])).rows;
    await database.DB.prepare("UPDATE video_notes SET body = 'edited', revision = 2 WHERE id = ?").bind(b.id).run();
    const before = await counts();
    const response = await commit("admin", v2.assetId, commitBody(v1.assetId, rows)); expect(response.status).toBe(409);
    const stale = videoNotePasteStaleSchema.parse(await response.json());
    expect(stale.preview.rows.map((row) => row.status === "skipped" ? null : [row.noteId, row.source.revision])).toEqual([[a.id, 1], [b.id, 2]]);
    expect(await counts()).toEqual(before);
    // Re-committing what the fresh preview says succeeds.
    expect((await commit("admin", v2.assetId, commitBody(v1.assetId, stale.preview.rows))).status).toBe(200);
  });

  it("is also stale when a note was deleted, tombstoned or its skipped row changed since the preview", async () => {
    const { v1, v2 } = await pair(); const a = await seedVideoNote({ assetId: v1.assetId, startFrame: 10 });
    const reply = await seedVideoNote({ assetId: v1.assetId, parentId: a.id });
    const rows = (await previewRows("admin", v2.assetId, v1.assetId, [a.id, reply.id])).rows;
    await database.DB.prepare("UPDATE video_notes SET revision = 2 WHERE id = ?").bind(reply.id).run();
    expect((await commit("admin", v2.assetId, commitBody(v1.assetId, rows))).status).toBe(409);
    await database.DB.prepare("DELETE FROM video_notes WHERE id = ?").bind(a.id).run();
    const gone = await commit("admin", v2.assetId, commitBody(v1.assetId, rows)); expect(gone.status).toBe(409);
    expect(videoNotePasteStaleSchema.parse(await gone.json()).preview.rows[0]).toMatchObject({ status: "skipped", reason: "deleted", source: null });
    expect(await counts()).toEqual({ notes: 0, audits: 0 }); // the hard delete cascaded the reply; nothing was copied
  });

  it("fences freshness inside the batch: a source edited between the read and the write copies nothing and writes no audit row", async () => {
    const { v1, v2 } = await pair(); const a = await seedVideoNote({ assetId: v1.assetId, startFrame: 10 }); const b = await seedVideoNote({ assetId: v1.assetId, startFrame: 20 });
    const before = await counts();
    const outcome = await commitThroughRacingDb(2, async () => { await database.DB.prepare("UPDATE video_notes SET body = 'edited', revision = 2 WHERE id = ?").bind(b.id).run(); }, {
      projectId: ids.project, targetAssetId: v2.assetId, sourceAssetId: v1.assetId, notes: [{ noteId: a.id, revision: 1 }, { noteId: b.id, revision: 1 }],
    });
    expect(outcome.kind).toBe("stale");
    if (outcome.kind === "stale") expect(outcome.preview.rows.map((row) => row.status === "skipped" ? null : row.source.revision)).toEqual([1, 2]);
    expect(await counts()).toEqual(before);
  });

  it("fences a skipped note too: a reply that changed between the read and the write blocks the whole commit", async () => {
    const { v1, v2 } = await pair(); const a = await seedVideoNote({ assetId: v1.assetId, startFrame: 10 }); const reply = await seedVideoNote({ assetId: v1.assetId, parentId: a.id });
    const outcome = await commitThroughRacingDb(2, async () => { await database.DB.prepare("UPDATE video_notes SET revision = 2 WHERE id = ?").bind(reply.id).run(); }, {
      projectId: ids.project, targetAssetId: v2.assetId, sourceAssetId: v1.assetId, notes: [{ noteId: a.id, revision: 1 }, { noteId: reply.id, revision: 1 }],
    });
    expect(outcome.kind).toBe("stale");
    expect(await counts()).toEqual({ notes: 2, audits: 0 });
  });
});

/** commitNotePaste against a D1 whose `nth` multi-statement batch (the first is the planner's read, the second the write) runs `before` first. */
async function commitThroughRacingDb(nth: number, before: () => Promise<void>, input: { projectId: string; targetAssetId: string; sourceAssetId: string; notes: Array<{ noteId: string; revision: number }> }) {
  let batches = 0;
  const db = new Proxy(database.DB, {
    get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (statements.length >= 2) { batches += 1; if (batches === nth) await before(); }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  void baseEnv;
  return await commitNotePaste(db, { ...input, offsetFrames: 0, principal: { id: ids.member, role: "editor" }, now: Date.now() });
}
