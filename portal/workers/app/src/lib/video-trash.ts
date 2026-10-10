import { COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings, SQL_UUID_V4 } from "@quincy/db";
import {
  NOTIFICATION_OUTBOX_EVENT_TYPES, ROLE_LABELS, VIDEO_TRASH_RETENTION_DAYS, VIDEO_TRASH_RETENTION_MS, VIDEO_UPLOAD_ACTIVE_STATUSES,
  type Role, type VideoRemovalImpact, type VideoRemoveInput, type VideoTrashItem, type VideoTrashResponse,
} from "@quincy/shared";
import { auditMeta, type AuditPrincipal } from "./audit";
import { newId } from "./ids";
import { recomputeCurrentStatements } from "./video-live-sql";

/**
 * Video Trash (#776 C): remove a Version or a Video, restore it, and list what is in Trash. A removal HIDES; it deletes nothing. Grants, notes, decisions, Releases and memberships are not
 * touched, because slice B's read filters already hide everything under a removed Version, so a restore brings it all back exactly. The one thing a removal does write outside the two
 * tables is terminal: outstanding notification deliveries and digest items for the removed subject are suppressed, so a restore never replays a stale email.
 *
 * Every write is ONE `db.batch` in the shape of `video-approval.ts`: the first statement is the UPDATE that carries the whole fence as a `WHERE` (rows live, the impact counts still the ones the
 * person confirmed, the live-Version count still saying whether this is the last, no active upload when the Video goes, the Project unarchived), the audit row follows it on `changes() > 0`, and
 * every later statement that must not run on a refused write is fenced on that audit row's id. So a refused fence writes nothing and leaves no audit row. There is no check-then-write.
 */
export type Principal = NonNullable<AuditPrincipal>;
const NOT_ARCHIVED = (param: string) => `EXISTS (SELECT 1 FROM projects WHERE id = ${param} AND archived_at IS NULL)`;
const ACTIVE_RESERVATION_STATUSES = VIDEO_UPLOAD_ACTIVE_STATUSES.map((status) => `'${status}'`).join(", ");
const iso = (ms: number) => new Date(ms).toISOString();
const person = (id: string, name: string, role: Role, active: number) => ({ id, name, roleLabel: ROLE_LABELS[role], isExternal: role === "external_editor", active: Boolean(active) });

// ---- the impact: one set of fragments for the read and for the fence ---------------------------------------------------------------------------------------

/** Notes and replies on the Version that still exist (a tombstone is not counted). `asset` is a SQL expression. */
const NOTES_SQL = (asset: string) => `(SELECT COUNT(*) FROM video_notes WHERE asset_id = ${asset} AND deleted_at IS NULL)`;
const DECISIONS_SQL = (asset: string) => `(SELECT COUNT(*) FROM video_approval_events WHERE asset_id = ${asset})`;
const RELEASED_SQL = (asset: string) => `(CASE WHEN EXISTS (SELECT 1 FROM video_releases WHERE asset_id = ${asset} AND withdrawn_at IS NULL) THEN 1 ELSE 0 END)`;
/** The live Review links that grant the Version: an unrevoked grant, on a link that is a video review link, unrevoked and unexpired, whose Video membership is live. */
const LINKS_FROM_SQL = (asset: string, now: string) =>
  `FROM review_link_version_grants g JOIN client_links l ON l.id = g.link_id AND l.kind = 'video_review' AND l.revoked_at IS NULL AND l.expires_at > ${now}
     JOIN review_link_videos rv ON rv.link_id = g.link_id AND rv.video_id = g.video_id AND rv.removed_at IS NULL
   WHERE g.asset_id = ${asset} AND g.revoked_at IS NULL`;
const ACTIVE_UPLOAD_SQL = (video: string) => `EXISTS (SELECT 1 FROM video_upload_reservations r WHERE r.video_id = ${video} AND r.status IN (${ACTIVE_RESERVATION_STATUSES}))`;
/** 1 when the Video has exactly one live Version. */
const LAST_VERSION_SQL = (video: string) => `(CASE WHEN (SELECT COUNT(*) FROM video_version_meta lm WHERE lm.video_id = ${video} AND lm.removed_at IS NULL) = 1 THEN 1 ELSE 0 END)`;

export type RemovalTarget = { impact: VideoRemovalImpact; videoId: string; collectionId: string; version: number };

/** The Version's impact from a fresh read, or null when it is not a live Version of a live Video of this Project. */
export async function readRemovalImpact(db: D1Database, projectId: string, assetId: string, now: number): Promise<RemovalTarget | null> {
  const [head, links] = await db.batch([
    db.prepare(`SELECT m.video_id AS videoId, v.collection_id AS collectionId, a.version AS version, ${LAST_VERSION_SQL("m.video_id")} AS lastVersion, ${ACTIVE_UPLOAD_SQL("m.video_id")} AS uploading,
        ${NOTES_SQL("m.asset_id")} AS notes, ${DECISIONS_SQL("m.asset_id")} AS decisions, ${RELEASED_SQL("m.asset_id")} AS release
      FROM video_version_meta m JOIN videos v ON v.id = m.video_id JOIN assets a ON a.id = m.asset_id AND a.kind = 'video'
      WHERE m.asset_id = ?1 AND v.project_id = ?2 AND m.removed_at IS NULL AND v.removed_at IS NULL`).bind(assetId, projectId),
    db.prepare(`SELECT l.id, l.label ${LINKS_FROM_SQL("?1", "?2")} ORDER BY COALESCE(l.label, ''), l.id`).bind(assetId, now),
  ]);
  const row = head!.results[0] as { videoId: string; collectionId: string; version: number; lastVersion: number; uploading: number; notes: number; decisions: number; release: number } | undefined;
  if (!row) return null;
  return {
    videoId: row.videoId, collectionId: row.collectionId, version: row.version,
    impact: { lastVersion: row.lastVersion === 1, uploading: row.uploading === 1, notes: row.notes, decisions: row.decisions, release: row.release === 1, links: links!.results as Array<{ id: string; label: string | null }> },
  };
}

export type RemovalRefusal = "impact_changed" | "last_version" | "upload_in_progress";
/** The refusal a removal meets against the impact as it stands, in the order the answers are given: the confirmed counts, then the last-Version rule, then an active upload. */
export function removalRefusal(impact: VideoRemovalImpact, input: VideoRemoveInput): RemovalRefusal | null {
  const expected = input.expected;
  if (expected.notes !== impact.notes || expected.decisions !== impact.decisions || expected.release !== impact.release || expected.links !== impact.links.length) return "impact_changed";
  if (input.removeVideo !== impact.lastVersion) return "last_version";
  if (input.removeVideo && impact.uploading) return "upload_in_progress";
  return null;
}

// ---- notifications -----------------------------------------------------------------------------------------------------------------------------------

/**
 * Terminally suppresses what is outstanding for a removed subject, fenced on the removal's audit row. The subject is the Version (`$.video.assetId`) or, for a Video, the Video (`$.video.videoId`)
 * in the payload of a video-review outbox row. A pending or queued outbox row, a pending or deferred ledger row and a pending digest item go to `suppressed`; a row that is `processing` is leased
 * to the delivery worker and is left to its send-time re-check (which already requires a live Version and Video). A delivery that already went out stays sent.
 */
function suppressionStatements(db: D1Database, input: { projectId: string; path: "$.video.assetId" | "$.video.videoId"; subjectId: string; auditId: string; now: number }): D1PreparedStatement[] {
  const binds = [input.now, NOTIFICATION_OUTBOX_EVENT_TYPES.projectVideoReview, input.projectId, input.path, input.subjectId, input.auditId] as const;
  const fence = "EXISTS (SELECT 1 FROM audit_log WHERE id = ?6)";
  const subject = "o.event_type = ?2 AND o.project_id = ?3 AND o.status <> 'processing' AND json_extract(o.payload_json, ?4) = ?5";
  return [
    db.prepare(`UPDATE notification_digest_items SET state = 'suppressed', outcome_code = 'video_removed', updated_at = ?1
      WHERE state = 'pending' AND ledger_id IN (SELECT l.id FROM notification_delivery_ledger l JOIN notification_outbox o ON o.id = l.outbox_id WHERE ${subject}) AND ${fence}`).bind(...binds),
    db.prepare(`UPDATE notification_delivery_ledger SET status = 'suppressed', last_error_code = 'video_removed', last_error = 'The Video or Version was removed.', updated_at = ?1
      WHERE status IN ('pending', 'deferred') AND outbox_id IN (SELECT o.id FROM notification_outbox o WHERE ${subject}) AND ${fence}`).bind(...binds),
    db.prepare(`UPDATE notification_outbox SET status = 'suppressed', last_error_code = 'video_removed', last_error = 'The Video or Version was removed.', lease_token = NULL, lease_expires_at = NULL, completed_at = ?1, updated_at = ?1
      WHERE event_type = ?2 AND project_id = ?3 AND status IN ('pending', 'queued') AND json_extract(payload_json, ?4) = ?5 AND ${fence}`).bind(...binds),
  ];
}

// ---- remove ------------------------------------------------------------------------------------------------------------------------------------------

export type RemoveOutcome = { kind: "removed" } | { kind: "archived" } | { kind: "not_found" } | { kind: RemovalRefusal; impact: VideoRemovalImpact };

/**
 * Removes a Version (and, with `removeVideo`, the Video it is the last live Version of) in one batch. `target` is the read the handler built its answer from; the batch repeats every condition
 * of it. On a refused fence nothing is written, and the outcome is classified from a fresh read.
 */
export async function removeVersion(db: D1Database, input: { projectId: string; assetId: string; target: RemovalTarget; principal: Principal; request: VideoRemoveInput; now: number }): Promise<RemoveOutcome> {
  const { projectId, assetId, target, request, now } = input; const { videoId, collectionId } = target; const expected = request.expected;
  const versionAudit = newId(); const videoAudit = newId();
  const meta = auditMeta(input.principal, { projectId, videoId, version: target.version, removeVideo: request.removeVideo, notes: expected.notes, decisions: expected.decisions, release: expected.release, links: expected.links })!;
  const videoMeta = auditMeta(input.principal, { projectId, version: target.version, assetId })!;
  const args = [versionAudit, now, assetId, projectId, input.principal.id, request.removeVideo ? 1 : 0, now + VIDEO_TRASH_RETENTION_MS, expected.notes, expected.decisions, expected.release ? 1 : 0, expected.links, meta, videoId, videoAudit, videoMeta];
  const bind = (sql: string, upTo: number) => db.prepare(sql).bind(...args.slice(0, upTo));
  await db.batch([
    bind(`UPDATE video_version_meta SET removed_at = ?2, removed_by = ?5, purge_at = ?7, removed_with_video = ?6
      WHERE asset_id = ?3 AND video_id = ?13 AND removed_at IS NULL
        AND EXISTS (SELECT 1 FROM videos v WHERE v.id = video_version_meta.video_id AND v.project_id = ?4 AND v.removed_at IS NULL)
        AND ${NOT_ARCHIVED("?4")}
        AND ${NOTES_SQL("?3")} = ?8 AND ${DECISIONS_SQL("?3")} = ?9 AND ${RELEASED_SQL("?3")} = ?10
        AND (SELECT COUNT(*) ${LINKS_FROM_SQL("?3", "?2")}) = ?11
        AND ${LAST_VERSION_SQL("?13")} = ?6
        AND (?6 = 0 OR NOT ${ACTIVE_UPLOAD_SQL("?13")})`, 13),
    bind("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?1, ?5, 'video_version.remove', 'asset', ?3, ?12, ?2 WHERE changes() > 0", 12),
    bind("UPDATE videos SET removed_at = ?2, removed_by = ?5, purge_at = ?7, updated_at = ?2 WHERE id = ?13 AND project_id = ?4 AND removed_at IS NULL AND ?6 = 1 AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?1)", 13),
    bind("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?14, ?5, 'video.remove', 'video', ?13, ?15, ?2 WHERE changes() > 0", 15),
    ...recomputeCurrentStatements(db, videoId, now),
    db.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(collectionId, now)),
    ...suppressionStatements(db, { projectId, path: request.removeVideo ? "$.video.videoId" : "$.video.assetId", subjectId: request.removeVideo ? videoId : assetId, auditId: versionAudit, now }),
  ]);
  if (await db.prepare("SELECT 1 AS one FROM audit_log WHERE id = ?1").bind(versionAudit).first()) return { kind: "removed" };
  return await diagnoseRemoval(db, projectId, assetId, request, now);
}

/** Why a removal wrote nothing, from a fresh read, in a fixed order: the Project is archived, the Version is gone, then the refusal the handler would give. */
async function diagnoseRemoval(db: D1Database, projectId: string, assetId: string, request: VideoRemoveInput, now: number): Promise<RemoveOutcome> {
  if (await projectArchived(db, projectId)) return { kind: "archived" };
  const fresh = await readRemovalImpact(db, projectId, assetId, now);
  if (!fresh) return { kind: "not_found" };
  // Every condition now passes yet the batch refused: the state moved between the two reads, so the confirmation is stale.
  return { kind: removalRefusal(fresh.impact, request) ?? "impact_changed", impact: fresh.impact };
}

async function projectArchived(db: D1Database, projectId: string): Promise<boolean> {
  return (await db.prepare("SELECT archived_at FROM projects WHERE id = ?1").bind(projectId).first<{ archived_at: number | null }>())?.archived_at != null;
}

// ---- restore -----------------------------------------------------------------------------------------------------------------------------------------

export type TrashedVersion = { videoId: string; collectionId: string; version: number; videoRemoved: boolean };
/** A Version that is in Trash in this Project, or null (live, unknown, other Project, or purged). */
export async function findTrashedVersion(db: D1Database, projectId: string, assetId: string): Promise<TrashedVersion | null> {
  const row = await db.prepare(`SELECT m.video_id AS videoId, v.collection_id AS collectionId, a.version AS version, v.removed_at IS NOT NULL AS videoRemoved
    FROM video_version_meta m JOIN videos v ON v.id = m.video_id JOIN assets a ON a.id = m.asset_id AND a.kind = 'video'
    WHERE m.asset_id = ?1 AND v.project_id = ?2 AND m.removed_at IS NOT NULL`).bind(assetId, projectId).first<{ videoId: string; collectionId: string; version: number; videoRemoved: number }>();
  return row ? { videoId: row.videoId, collectionId: row.collectionId, version: row.version, videoRemoved: row.videoRemoved === 1 } : null;
}

export type RestoreOutcome = { kind: "restored" } | { kind: "archived" } | { kind: "not_found" } | { kind: "video_in_trash" };

/**
 * Restores a Version. The newest live Version is current afterwards, so an older one stays non-current and a newer one than the current takes over. A row that still exists is restorable: the
 * purge's own fenced DELETE decides a race with it, not a clock here.
 */
export async function restoreVersion(db: D1Database, input: { projectId: string; assetId: string; target: TrashedVersion; principal: Principal; now: number }): Promise<RestoreOutcome> {
  const { projectId, assetId, target, now } = input; const auditId = newId();
  const meta = auditMeta(input.principal, { projectId, videoId: target.videoId, version: target.version })!;
  await db.batch([
    db.prepare(`UPDATE video_version_meta SET removed_at = NULL, removed_by = NULL, purge_at = NULL, removed_with_video = 0
      WHERE asset_id = ?1 AND video_id = ?2 AND removed_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM videos v WHERE v.id = video_version_meta.video_id AND v.project_id = ?3 AND v.removed_at IS NULL) AND ${NOT_ARCHIVED("?3")}`).bind(assetId, target.videoId, projectId),
    db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?1, ?2, 'video_version.restore', 'asset', ?3, ?4, ?5 WHERE changes() > 0").bind(auditId, input.principal.id, assetId, meta, now),
    ...recomputeCurrentStatements(db, target.videoId, now),
    db.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(target.collectionId, now)),
  ]);
  if (await db.prepare("SELECT 1 AS one FROM audit_log WHERE id = ?1").bind(auditId).first()) return { kind: "restored" };
  if (await projectArchived(db, projectId)) return { kind: "archived" };
  const fresh = await findTrashedVersion(db, projectId, assetId);
  return fresh?.videoRemoved ? { kind: "video_in_trash" } : { kind: "not_found" };
}

export type TrashedVideo = { collectionId: string; versionCount: number };
export async function findTrashedVideo(db: D1Database, projectId: string, videoId: string): Promise<TrashedVideo | null> {
  const row = await db.prepare(`SELECT v.collection_id AS collectionId,
      (SELECT COUNT(*) FROM video_version_meta m WHERE m.video_id = v.id AND m.removed_with_video = 1 AND m.removed_at IS NOT NULL) AS versionCount
    FROM videos v WHERE v.id = ?1 AND v.project_id = ?2 AND v.removed_at IS NOT NULL`).bind(videoId, projectId).first<{ collectionId: string; versionCount: number }>();
  return row ?? null;
}

/** Restores a Video and the Versions removed with it. A Version removed on its own earlier stays in Trash on its own clock. */
export async function restoreVideo(db: D1Database, input: { projectId: string; videoId: string; target: TrashedVideo; principal: Principal; now: number }): Promise<RestoreOutcome> {
  const { projectId, videoId, target, now } = input; const auditId = newId();
  const meta = auditMeta(input.principal, { projectId, versionCount: target.versionCount })!;
  const versionMeta = auditMeta(input.principal, { projectId, videoId, viaVideoRestore: true })!;
  await db.batch([
    db.prepare(`UPDATE videos SET removed_at = NULL, removed_by = NULL, purge_at = NULL, updated_at = ?5 WHERE id = ?1 AND project_id = ?2 AND removed_at IS NOT NULL AND ${NOT_ARCHIVED("?2")}`).bind(videoId, projectId, input.principal.id, auditId, now),
    db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?1, ?2, 'video.restore', 'video', ?3, ?4, ?5 WHERE changes() > 0").bind(auditId, input.principal.id, videoId, meta, now),
    db.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ${SQL_UUID_V4}, ?2, 'video_version.restore', 'asset', m.asset_id, json_patch(?4, json_object('version', a.version)), ?5
      FROM video_version_meta m JOIN assets a ON a.id = m.asset_id AND a.kind = 'video'
      WHERE m.video_id = ?3 AND m.removed_with_video = 1 AND m.removed_at IS NOT NULL AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?1)`).bind(auditId, input.principal.id, videoId, versionMeta, now),
    db.prepare(`UPDATE video_version_meta SET removed_at = NULL, removed_by = NULL, purge_at = NULL, removed_with_video = 0
      WHERE video_id = ?1 AND removed_with_video = 1 AND removed_at IS NOT NULL AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?2)`).bind(videoId, auditId),
    ...recomputeCurrentStatements(db, videoId, now),
    db.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(target.collectionId, now)),
  ]);
  if (await db.prepare("SELECT 1 AS one FROM audit_log WHERE id = ?1").bind(auditId).first()) return { kind: "restored" };
  if (await projectArchived(db, projectId)) return { kind: "archived" };
  return { kind: "not_found" };
}

// ---- the Trash list ----------------------------------------------------------------------------------------------------------------------------------

type RemoverColumns = { u_id: string; u_name: string; u_role: Role; u_active: number };
/**
 * What is in Trash for a Project, newest removal first: each removed Video (with how many Versions a restore of it brings back), and each Version removed on its own while its Video is live. A
 * Version removed on its own and then left behind by a Video removal is not listed until the Video is restored, because it cannot be restored before then.
 */
export async function listTrash(db: D1Database, projectId: string): Promise<VideoTrashResponse> {
  const [videos, versions] = await db.batch([
    db.prepare(`SELECT v.id, v.title, v.removed_at, v.purge_at, u.id AS u_id, u.name AS u_name, u.role AS u_role, u.active AS u_active,
        (SELECT COUNT(*) FROM video_version_meta m WHERE m.video_id = v.id AND m.removed_with_video = 1 AND m.removed_at IS NOT NULL) AS version_count
      FROM videos v JOIN user u ON u.id = v.removed_by WHERE v.project_id = ?1 AND v.removed_at IS NOT NULL`).bind(projectId),
    db.prepare(`SELECT a.id AS asset_id, a.version, v.id, v.title, m.removed_at, m.purge_at, u.id AS u_id, u.name AS u_name, u.role AS u_role, u.active AS u_active
      FROM video_version_meta m JOIN videos v ON v.id = m.video_id JOIN assets a ON a.id = m.asset_id AND a.kind = 'video' JOIN user u ON u.id = m.removed_by
      WHERE v.project_id = ?1 AND m.removed_at IS NOT NULL AND v.removed_at IS NULL`).bind(projectId),
  ]);
  const items: Array<VideoTrashItem & { at: number }> = [];
  for (const row of videos!.results as Array<{ id: string; title: string; removed_at: number; purge_at: number | null; version_count: number } & RemoverColumns>) {
    items.push({ kind: "video", videoId: row.id, title: row.title, versionCount: Math.max(row.version_count, 1), removedAt: iso(row.removed_at), removedBy: person(row.u_id, row.u_name, row.u_role, row.u_active), purgeAt: iso(row.purge_at ?? row.removed_at + VIDEO_TRASH_RETENTION_MS), at: row.removed_at });
  }
  for (const row of versions!.results as Array<{ asset_id: string; version: number; id: string; title: string; removed_at: number; purge_at: number | null } & RemoverColumns>) {
    items.push({ kind: "version", videoId: row.id, title: row.title, assetId: row.asset_id, version: row.version, removedAt: iso(row.removed_at), removedBy: person(row.u_id, row.u_name, row.u_role, row.u_active), purgeAt: iso(row.purge_at ?? row.removed_at + VIDEO_TRASH_RETENTION_MS), at: row.removed_at });
  }
  items.sort((a, b) => b.at - a.at || a.videoId.localeCompare(b.videoId) || (a.assetId ?? "").localeCompare(b.assetId ?? ""));
  return { retentionDays: VIDEO_TRASH_RETENTION_DAYS, items: items.map(({ at: _at, ...item }) => item) };
}
