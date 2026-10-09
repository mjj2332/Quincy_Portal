import {
  planPaste, rational, type PastePlanRow, type Role, type VideoNotePasteRow, type VideoNotePasteSkipReason, type VideoNotePastePreviewResponse, type VideoNoteVisibility,
} from "@quincy/shared";
import { archivedInSnapshot, ARCHIVED_SNAPSHOT_SQL } from "./project-archive";
import { auditMeta, type AuditPrincipal } from "./audit";
import { newId } from "./ids";
import { alreadyOnTarget, PASTE_AUDIT_SQL, PASTE_INSERT_SQL, VERSION_FROM } from "./video-notes-sql";

/**
 * Copying notes from one Version of a Video onto another (#741, 5c-api). Preview and commit share ONE planner (`planNotePaste`), so what the
 * person reviewed is what the commit tries to write. The commit repeats the whole freshness check inside its D1 batch (`pasteFence`): a source
 * that changed between the read and the write copies nothing and writes no audit row. Visibility and body are copied from the source row in SQL.
 */

type Principal = NonNullable<AuditPrincipal> & { role: Role };
type VersionFacts = { asset_id: string; video_id: string; fps_num: number; fps_den: number; frame_count: number; version: number };
type SourceRow = {
  id: string; parent_id: string | null; start_frame: number | null; end_frame: number | null; visibility: VideoNoteVisibility; body: string;
  revision: number; deleted_at: number | null; u_name: string | null; g_name: string | null;
};
type Source = Extract<VideoNotePasteRow, { status: "skipped" }>["source"];

export type PastePlan = {
  preview: VideoNotePastePreviewResponse;
  videoId: string;
  /** Mapped rows, in request order, with the source row they came from. */
  copies: Array<{ noteId: string; start: number; end: number | null }>;
  revisions: Map<string, number | null>;
};
export type PlanOutcome = { kind: "ok"; plan: PastePlan } | { kind: "no_target" } | { kind: "no_source" } | { kind: "same_version" } | { kind: "not_same_video" };

const excerpt = (body: string) => body.replace(/\s+/g, " ").trim().slice(0, 160);

/** Reads everything in one batch (one snapshot), then maps with the shared pure planner. Writes nothing. */
export async function planNotePaste(db: D1Database, input: { projectId: string; targetAssetId: string; sourceAssetId: string; noteIds: string[]; offsetFrames: number }): Promise<PlanOutcome> {
  const idsJson = JSON.stringify(input.noteIds);
  const [versions, notes, copied] = await db.batch([
    db.prepare(`SELECT m.asset_id, m.video_id, m.fps_num, m.fps_den, m.frame_count, a.version FROM ${VERSION_FROM} WHERE m.asset_id IN (?1, ?2) AND v.project_id = ?3`).bind(input.targetAssetId, input.sourceAssetId, input.projectId),
    db.prepare(`SELECT n.id, n.parent_id, n.start_frame, n.end_frame, n.visibility, n.body, n.revision, n.deleted_at, u.name AS u_name, g.display_name AS g_name
      FROM video_notes n LEFT JOIN user u ON u.id = n.author_user_id LEFT JOIN guest_reviewers g ON g.id = n.author_guest_id
      WHERE n.project_id = ?1 AND n.asset_id = ?2 AND n.id IN (SELECT value FROM json_each(?3))`).bind(input.projectId, input.sourceAssetId, idsJson),
    db.prepare(`SELECT s.id FROM video_notes s WHERE s.project_id = ?1 AND s.asset_id = ?2 AND s.parent_id IS NULL AND s.id IN (SELECT value FROM json_each(?3)) AND ${alreadyOnTarget("s", "?4")}`)
      .bind(input.projectId, input.sourceAssetId, idsJson, input.targetAssetId),
  ]);
  const facts = versions!.results as VersionFacts[];
  const target = facts.find((row) => row.asset_id === input.targetAssetId); const source = facts.find((row) => row.asset_id === input.sourceAssetId);
  if (!target) return { kind: "no_target" };
  if (!source) return { kind: "no_source" };
  if (target.asset_id === source.asset_id) return { kind: "same_version" };
  if (target.video_id !== source.video_id) return { kind: "not_same_video" };

  const byId = new Map((notes!.results as SourceRow[]).map((row) => [row.id, row]));
  const already = new Set((copied!.results as Array<{ id: string }>).map((row) => row.id));
  const skip = new Map<string, VideoNotePasteSkipReason>();
  const candidates: Array<{ id: string; startFrame: number; endFrame: number | null; drawingFrame: null }> = [];
  for (const id of input.noteIds) {
    const row = byId.get(id);
    if (!row) skip.set(id, "deleted");
    else if (row.parent_id !== null) skip.set(id, "reply");
    else if (row.deleted_at !== null) skip.set(id, "deleted");
    // Markup is not copied until 6b; a note has no drawing frame to carry yet.
    else candidates.push({ id, startFrame: row.start_frame!, endFrame: row.end_frame, drawingFrame: null });
  }
  const planned = new Map<string, PastePlanRow>(planPaste(candidates, rational(source.fps_num, source.fps_den), { fps: rational(target.fps_num, target.fps_den), frameCount: target.frame_count }, input.offsetFrames, already)
    .map((row) => [row.noteId, row]));

  const copies: PastePlan["copies"] = []; const revisions = new Map<string, number | null>();
  const rows = input.noteIds.map((id): VideoNotePasteRow => {
    const row = byId.get(id); revisions.set(id, row?.revision ?? null);
    const described: Source = row ? {
      revision: row.revision, visibility: row.visibility, authorName: row.g_name ?? row.u_name ?? "Unknown",
      excerpt: row.deleted_at === null ? excerpt(row.body) : "", from: { startFrame: row.start_frame, endFrame: row.end_frame },
    } : null;
    const reason = skip.get(id);
    if (reason) return { noteId: id, status: "skipped", reason, source: described };
    const result = planned.get(id)!;
    if (result.status === "skipped") return { noteId: id, status: "skipped", reason: result.reason === "already_copied" ? "already_copied" : "out_of_range", source: described };
    copies.push({ noteId: id, start: result.startFrame, end: result.endFrame });
    return { noteId: id, status: "mapped", source: described!, to: { startFrame: result.startFrame, endFrame: result.endFrame }, shortened: result.shortened };
  });
  return { kind: "ok", plan: { preview: { sourceVersion: source.version, targetVersion: target.version, offsetFrames: input.offsetFrames, rows }, videoId: source.video_id, copies, revisions } };
}

export type CommitOutcome =
  | { kind: "ok"; value: { sourceVersion: number; targetVersion: number; offsetFrames: number; copied: number; skipped: number; rows: VideoNotePasteRow[] } }
  | { kind: "stale"; preview: VideoNotePastePreviewResponse } | { kind: "archived" }
  | Exclude<PlanOutcome, { kind: "ok" }>;

/**
 * Commit what the preview showed. The route's pre-check compares every revision and answers `stale` with the fresh plan; the batch then repeats that
 * comparison in SQL, so a change that lands between the two is the same `stale`, with nothing written. ONE audit row per commit that passes the fence,
 * all-skipped included. Idempotent: a repeat finds every copy in place (`already_copied`).
 */
export async function commitNotePaste(db: D1Database, input: {
  projectId: string; targetAssetId: string; sourceAssetId: string; notes: Array<{ noteId: string; revision: number }>; offsetFrames: number; principal: Principal; now: number;
}): Promise<CommitOutcome> {
  const noteIds = input.notes.map((note) => note.noteId);
  const planned = await planNotePaste(db, { ...input, noteIds });
  if (planned.kind !== "ok") return planned;
  const { plan } = planned;
  if (input.notes.some((note) => plan.revisions.get(note.noteId) !== note.revision)) return { kind: "stale", preview: plan.preview };

  const copyIds = new Map(plan.copies.map((copy) => [copy.noteId, newId()]));
  const auditId = newId();
  const reasonCount = (reason: VideoNotePasteSkipReason) => plan.preview.rows.filter((row) => row.status === "skipped" && row.reason === reason).length;
  const meta = auditMeta(input.principal, {
    projectId: input.projectId, videoId: plan.videoId, sourceAssetId: input.sourceAssetId, sourceVersion: plan.preview.sourceVersion, targetAssetId: input.targetAssetId, targetVersion: plan.preview.targetVersion,
    offsetFrames: input.offsetFrames, requested: noteIds.length, mapped: plan.copies.length,
    skippedByReason: { already_copied: reasonCount("already_copied"), out_of_range: reasonCount("out_of_range"), deleted: reasonCount("deleted"), reply: reasonCount("reply") },
  });
  const copiesJson = JSON.stringify(plan.copies.map((copy) => ({ id: copyIds.get(copy.noteId), src: copy.noteId, start: copy.start, end: copy.end })));
  const expectedJson = JSON.stringify(input.notes.map((note) => ({ id: note.noteId, rev: note.revision })));
  const results = await db.batch([
    db.prepare(PASTE_INSERT_SQL).bind(copiesJson, input.targetAssetId, input.projectId, input.sourceAssetId, input.principal.id, input.principal.role, plan.preview.sourceVersion, input.now, expectedJson, noteIds.length),
    db.prepare(PASTE_AUDIT_SQL).bind(auditId, input.principal.id, input.targetAssetId, meta, input.now, input.projectId, input.sourceAssetId, expectedJson, noteIds.length, noteIds.length, plan.copies.length, reasonCount("already_copied")),
    db.prepare(ARCHIVED_SNAPSHOT_SQL).bind(input.projectId),
    db.prepare("SELECT id FROM audit_log WHERE id = ?1").bind(auditId),
    db.prepare("SELECT id FROM video_notes WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify([...copyIds.values()])),
  ]);
  if ((results[3]!.results as unknown[]).length === 0) {
    if (archivedInSnapshot(results[2])) return { kind: "archived" };
    const fresh = await planNotePaste(db, { ...input, noteIds });
    return fresh.kind === "ok" ? { kind: "stale", preview: fresh.plan.preview } : fresh;
  }
  const landed = new Set((results[4]!.results as Array<{ id: string }>).map((row) => row.id));
  const rows = plan.preview.rows.map((row): VideoNotePasteRow => {
    if (row.status !== "mapped") return row;
    const copyId = copyIds.get(row.noteId)!;
    return landed.has(copyId) ? { ...row, status: "copied", copyId } : { noteId: row.noteId, status: "skipped", reason: "already_copied", source: row.source };
  });
  const copied = rows.filter((row) => row.status === "copied").length;
  return { kind: "ok", value: { sourceVersion: plan.preview.sourceVersion, targetVersion: plan.preview.targetVersion, offsetFrames: input.offsetFrames, copied, skipped: rows.length - copied, rows } };
}
