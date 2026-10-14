import type { VersionReviewStatus } from "@quincy/shared";
import { auditMeta, type Principal } from "./audit";
import { newId } from "./ids";
import { LIVE_VERSION, LIVE_VIDEO } from "./video-live-sql";

/**
 * Review status writes (#863). One `db.batch`: the audit row first, written by an `INSERT ... SELECT` that carries the whole fence as its `WHERE` (a live Version of a live Video of this Project, the
 * Video's current Version, the Project unarchived, the stored status still the one the caller saw, and a real change), then the UPDATE fenced on that audit row's id. A refused fence writes nothing and
 * leaves no audit row, a no-op leaves none either, and there is no read-then-write: `before` is the status the fence matched. Published is derived on read and never written here.
 */
export type ReviewStatusOutcome =
  | { kind: "set"; videoId: string }
  | { kind: "unchanged"; videoId: string }
  | { kind: "archived" }
  | { kind: "not_found" }
  | { kind: "not_latest_version"; videoId: string }
  | { kind: "conflict"; videoId: string };

type Head = { videoId: string; current: boolean; archived: boolean; status: VersionReviewStatus };

/** The Version's head from a fresh read, or null when it is not a Version of a live Video of this Project (a Version in Trash is still returned: it is `current = false`). */
export async function readReviewHead(db: D1Database, projectId: string, assetId: string): Promise<Head | null> {
  const row = await db.prepare(
    `SELECT m.video_id AS videoId, m.review_status AS status, (a.superseded_at IS NULL AND ${LIVE_VERSION("m")}) AS current,
            EXISTS (SELECT 1 FROM projects pr WHERE pr.id = v.project_id AND pr.archived_at IS NOT NULL) AS archived
     FROM video_version_meta m JOIN videos v ON v.id = m.video_id JOIN assets a ON a.id = m.asset_id AND a.kind = 'video'
     WHERE m.asset_id = ?1 AND v.project_id = ?2 AND ${LIVE_VIDEO("v")}`).bind(assetId, projectId).first<{ videoId: string; status: VersionReviewStatus; current: number; archived: number }>();
  return row ? { videoId: row.videoId, status: row.status, current: row.current === 1, archived: row.archived === 1 } : null;
}

export async function setVersionReviewStatus(db: D1Database, input: { projectId: string; assetId: string; status: VersionReviewStatus; expected: VersionReviewStatus; principal: Principal; now: number }): Promise<ReviewStatusOutcome> {
  const head = await readReviewHead(db, input.projectId, input.assetId);
  if (!head) return { kind: "not_found" };
  if (head.archived) return { kind: "archived" };
  if (!head.current) return { kind: "not_latest_version", videoId: head.videoId };
  return await write(db, input, newId(), head, input.now);
}

async function write(db: D1Database, input: { projectId: string; assetId: string; status: VersionReviewStatus; expected: VersionReviewStatus; principal: Principal }, auditId: string, head: Head, now: number): Promise<ReviewStatusOutcome> {
  const { projectId, assetId, status, expected } = input;
  // The Version number is read inside the statement, so the audit meta is built there from the pieces that do not change between the read and the batch.
  const base = auditMeta(input.principal, { projectId, videoId: head.videoId, before: expected, after: status })!;
  await db.batch([
    db.prepare(
      `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
       SELECT ?1, ?2, 'video_version.review_status_set', 'asset', m.asset_id, json_patch(?3, json_object('version', a.version)), ?4
       FROM video_version_meta m JOIN videos v ON v.id = m.video_id JOIN assets a ON a.id = m.asset_id AND a.kind = 'video'
       WHERE m.asset_id = ?5 AND v.project_id = ?6 AND ${LIVE_VERSION("m")} AND ${LIVE_VIDEO("v")} AND a.superseded_at IS NULL
         AND m.review_status = ?7 AND ?7 <> ?8
         AND EXISTS (SELECT 1 FROM projects pr WHERE pr.id = v.project_id AND pr.archived_at IS NULL)`).bind(auditId, input.principal.id, base, now, assetId, projectId, expected, status),
    db.prepare(`UPDATE video_version_meta SET review_status = ?1 WHERE asset_id = ?2 AND ${LIVE_VERSION("video_version_meta")} AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?3)`).bind(status, assetId, auditId),
  ]);
  if (await db.prepare("SELECT 1 AS one FROM audit_log WHERE id = ?1").bind(auditId).first()) return { kind: "set", videoId: head.videoId };
  // Nothing was written: say why, from a fresh read.
  const fresh = await readReviewHead(db, projectId, assetId);
  if (!fresh) return { kind: "not_found" };
  if (fresh.archived) return { kind: "archived" };
  if (!fresh.current) return { kind: "not_latest_version", videoId: fresh.videoId };
  if (fresh.status === status) return { kind: "unchanged", videoId: fresh.videoId };
  return { kind: "conflict", videoId: fresh.videoId };
}
