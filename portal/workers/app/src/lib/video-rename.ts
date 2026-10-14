import { auditMeta } from "./audit";
import { newId } from "./ids";
import { LIVE_VERSION, LIVE_VIDEO, fencedRecomputeStatements } from "./video-live-sql";
import { readReviewHead, type Principal } from "./video-review-status";

/**
 * Rename a Video (#867): the new file name of its latest Version. One `db.batch`: the audit row first, written by an `INSERT ... SELECT` that carries the whole fence as its `WHERE` (a live Version
 * of a live Video of this Project, the Video's current Version, the Project unarchived, and a real change) and records the stored name as `before`; then the name UPDATE fenced on that audit row's id;
 * then the current-Version recompute, which is the one place the film's title moves (docs/lessons.md: a derived value belongs inside the statement that changes its inputs). A refused fence
 * writes nothing, a no-op leaves no audit row, and there is no read-then-write. Two simultaneous renames are last-write-wins, each audited with the name it replaced.
 */
export type RenameOutcome =
  | { kind: "set" }
  | { kind: "unchanged"; videoId: string }
  | { kind: "archived" }
  | { kind: "not_found" }
  | { kind: "not_latest_version"; videoId: string };

export async function renameVersion(db: D1Database, input: { projectId: string; assetId: string; filename: string; principal: Principal; now: number }): Promise<RenameOutcome> {
  const { projectId, assetId, filename, now } = input;
  const head = await readReviewHead(db, projectId, assetId);
  if (!head) return { kind: "not_found" };
  if (head.archived) return { kind: "archived" };
  if (!head.current) return { kind: "not_latest_version", videoId: head.videoId };
  const auditId = newId();
  const base = auditMeta(input.principal, { projectId, videoId: head.videoId, after: filename })!;
  await db.batch([
    db.prepare(
      `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
       SELECT ?1, ?2, 'video_version.rename', 'asset', m.asset_id, json_patch(?3, json_object('version', a.version, 'before', a.original_filename)), ?4
       FROM video_version_meta m JOIN videos v ON v.id = m.video_id JOIN assets a ON a.id = m.asset_id AND a.kind = 'video'
       WHERE m.asset_id = ?5 AND v.project_id = ?6 AND ${LIVE_VERSION("m")} AND ${LIVE_VIDEO("v")} AND a.superseded_at IS NULL
         AND a.original_filename <> ?7
         AND EXISTS (SELECT 1 FROM projects pr WHERE pr.id = v.project_id AND pr.archived_at IS NULL)`).bind(auditId, input.principal.id, base, now, assetId, projectId, filename),
    db.prepare("UPDATE assets SET original_filename = ?1, updated_at = ?2 WHERE id = ?3 AND kind = 'video' AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?4)").bind(filename, now, assetId, auditId),
    ...fencedRecomputeStatements(db, head.videoId, now, auditId),
  ]);
  if (await db.prepare("SELECT 1 AS one FROM audit_log WHERE id = ?1").bind(auditId).first()) return { kind: "set" };
  // Nothing was written: say why, from a fresh read.
  const fresh = await readReviewHead(db, projectId, assetId);
  if (!fresh) return { kind: "not_found" };
  if (fresh.archived) return { kind: "archived" };
  if (!fresh.current) return { kind: "not_latest_version", videoId: fresh.videoId };
  return { kind: "unchanged", videoId: fresh.videoId };
}
