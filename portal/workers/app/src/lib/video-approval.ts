import { ROLE_LABELS, type Role, type VideoDecisionEvent, type VideoRelease, type VideoVersionDecisions } from "@quincy/shared";
import { auditMeta, type AuditPrincipal } from "./audit";
import { newId } from "./ids";
import { LIVE_VERSION, LIVE_VERSION_EXISTS, LIVE_VIDEO, LIVE_VIDEO_EXISTS } from "./video-live-sql";

/**
 * Staff approval, Release and premium (#741 14a). Every write is ONE `db.batch` in the shape of `review-links.ts` and `video-notes.ts`: the committing statement carries the whole
 * guard (the Version or Video belongs to the Project, the Project is not archived, the Release CAS) as a `WHERE`, and the audit row follows only a statement that landed, so a refused
 * guard writes nothing and leaves no audit row. A decision is append-only and informational (ADR 0021 section 5); a Release names the exact approval event it rests on.
 */
export type Principal = NonNullable<AuditPrincipal>;
const NOT_ARCHIVED = (param: string) => `EXISTS (SELECT 1 FROM projects WHERE id = ${param} AND archived_at IS NULL)`;
const iso = (ms: number) => new Date(ms).toISOString();
const person = (id: string | null, name: string | null, role: Role | null, active: number | null) =>
  id === null || name === null || role === null ? null : { id, name, roleLabel: ROLE_LABELS[role], isExternal: role === "external_editor", active: Boolean(active) };

/** `json_patch(base, patch)`: the provenance-aware audit meta from `auditMeta` with the values only SQL knows (the allocated revision, a row id) merged in. */
const metaWith = (base: string, patch: string) => `json_patch(COALESCE(${base}, '{}'), ${patch})`;
const isUnique = (error: unknown) => error instanceof Error && /UNIQUE constraint/i.test(error.message);

// ---- read ---------------------------------------------------------------------------------------------------------------------------------

type EventRow = {
  id: string; asset_id: string; revision: number; decision: "approved" | "changes_requested"; note: string | null; created_at: number; link_id: string | null; link_label: string | null;
  actor_guest_id: string | null; g_name: string | null; u_id: string | null; u_name: string | null; u_role: Role | null; u_active: number | null;
};
const EVENT_SELECT = `SELECT e.id, e.asset_id, e.revision, e.decision, e.note, e.created_at, e.link_id, l.label AS link_label, e.actor_guest_id, g.display_name AS g_name,
    u.id AS u_id, u.name AS u_name, u.role AS u_role, u.active AS u_active
  FROM video_approval_events e LEFT JOIN client_links l ON l.id = e.link_id LEFT JOIN guest_reviewers g ON g.id = e.actor_guest_id LEFT JOIN user u ON u.id = e.actor_user_id`;
function eventDto(row: EventRow): VideoDecisionEvent {
  const user = person(row.u_id, row.u_name, row.u_role, row.u_active);
  return {
    id: row.id, revision: row.revision, decision: row.decision, note: row.note, at: iso(row.created_at),
    actor: row.actor_guest_id !== null ? { kind: "guest", name: row.g_name } : { kind: "user", person: user! },
    link: row.link_id === null ? null : { id: row.link_id, label: row.link_label },
  };
}
export async function readEvent(db: D1Database, eventId: string): Promise<VideoDecisionEvent | null> {
  const row = await db.prepare(`${EVENT_SELECT} WHERE e.id = ?1`).bind(eventId).first<EventRow>();
  return row ? eventDto(row) : null;
}

type ReleaseRow = { id: string; asset_id: string; approval_revision: number; released_at: number; u_id: string | null; u_name: string | null; u_role: Role | null; u_active: number | null };
const RELEASE_SELECT = `SELECT r.id, r.asset_id, r.approval_revision, r.released_at, u.id AS u_id, u.name AS u_name, u.role AS u_role, u.active AS u_active FROM video_releases r LEFT JOIN user u ON u.id = r.released_by`;
const releaseDto = (row: ReleaseRow): VideoRelease => ({ id: row.id, approvalRevision: row.approval_revision, releasedAt: iso(row.released_at), releasedBy: person(row.u_id, row.u_name, row.u_role, row.u_active) });
export async function readRelease(db: D1Database, releaseId: string): Promise<VideoRelease | null> {
  const row = await db.prepare(`${RELEASE_SELECT} WHERE r.id = ?1`).bind(releaseId).first<ReleaseRow>();
  return row ? releaseDto(row) : null;
}

/** Every Version of a Video (newest first) with its decision events (oldest first) and its live Release. The caller has already checked the Video belongs to the Project. */
export async function loadDecisions(db: D1Database, projectId: string, videoId: string): Promise<VideoVersionDecisions[]> {
  const [versions, events, releases] = await db.batch([
    db.prepare(`SELECT a.id AS asset_id, a.version FROM video_version_meta m JOIN assets a ON a.id = m.asset_id AND a.kind = 'video' WHERE m.video_id = ?1 AND ${LIVE_VERSION("m")} ORDER BY a.version DESC`).bind(videoId),
    db.prepare(`${EVENT_SELECT} WHERE e.video_id = ?1 AND e.project_id = ?2 ORDER BY e.revision, e.rowid`).bind(videoId, projectId),
    db.prepare(`${RELEASE_SELECT} WHERE r.video_id = ?1 AND r.project_id = ?2 AND r.withdrawn_at IS NULL`).bind(videoId, projectId),
  ]);
  const byAsset = new Map<string, VideoDecisionEvent[]>();
  for (const row of events!.results as EventRow[]) byAsset.set(row.asset_id, [...(byAsset.get(row.asset_id) ?? []), eventDto(row)]);
  const live = new Map((releases!.results as ReleaseRow[]).map((row) => [row.asset_id, releaseDto(row)] as const));
  return (versions!.results as Array<{ asset_id: string; version: number }>).map((row) => ({ assetId: row.asset_id, version: row.version, events: byAsset.get(row.asset_id) ?? [], release: live.get(row.asset_id) ?? null }));
}

/** The Version's Video and Project, or null when it is not a Version of this Project. */
export async function findVersion(db: D1Database, projectId: string, assetId: string): Promise<{ videoId: string; version: number } | null> {
  const row = await db.prepare(`SELECT m.video_id, a.version FROM video_version_meta m JOIN assets a ON a.id = m.asset_id AND a.kind = 'video' JOIN videos v ON v.id = m.video_id WHERE a.id = ?1 AND v.project_id = ?2 AND ${LIVE_VERSION("m")} AND ${LIVE_VIDEO("v")}`).bind(assetId, projectId).first<{ video_id: string; version: number }>();
  return row ? { videoId: row.video_id, version: row.version } : null;
}
export async function findVideo(db: D1Database, projectId: string, videoId: string): Promise<{ premium: boolean; unlocked: boolean; paymentRef: string | null } | null> {
  const row = await db.prepare(`SELECT v.premium, (p.video_id IS NOT NULL) AS unlocked, p.payment_ref FROM videos v LEFT JOIN video_premium_unlocks p ON p.video_id = v.id WHERE v.id = ?1 AND v.project_id = ?2 AND ${LIVE_VIDEO("v")}`).bind(videoId, projectId).first<{ premium: number; unlocked: number; payment_ref: string | null }>();
  return row ? { premium: row.premium === 1, unlocked: row.unlocked === 1, paymentRef: row.payment_ref } : null;
}

// ---- decisions ----------------------------------------------------------------------------------------------------------------------------

/**
 * A client decision staff record themselves (the client approved by phone): no link, the user as actor. The revision is allocated inside the INSERT, so concurrent decisions
 * on a Version get distinct numbers. Null when the Version is not in the Project or the Project is archived.
 */
export async function recordStaffDecision(db: D1Database, input: { projectId: string; assetId: string; principal: Principal; decision: "approved" | "changes_requested"; note: string | null; now: number }): Promise<VideoDecisionEvent | null> {
  const eventId = newId();
  try {
    await db.batch([
      db.prepare(`INSERT INTO video_approval_events (id, project_id, video_id, asset_id, link_id, revision, decision, note, actor_guest_id, actor_user_id, created_at)
        SELECT ?1, v.project_id, m.video_id, a.id, NULL, COALESCE((SELECT MAX(x.revision) FROM video_approval_events x WHERE x.asset_id = a.id), 0) + 1, ?2, ?3, NULL, ?4, ?5
        FROM video_version_meta m JOIN assets a ON a.id = m.asset_id AND a.kind = 'video' JOIN videos v ON v.id = m.video_id
        WHERE a.id = ?6 AND v.project_id = ?7 AND ${LIVE_VERSION("m")} AND ${LIVE_VIDEO("v")} AND ${NOT_ARCHIVED("?7")}`).bind(eventId, input.decision, input.note, input.principal.id, input.now, input.assetId, input.projectId),
      db.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
        SELECT ?1, ?2, 'video_version.decision', 'asset', e.asset_id, ${metaWith("?3", "json_object('projectId', e.project_id, 'videoId', e.video_id, 'decision', e.decision, 'revision', e.revision, 'staffRecorded', json('true'), 'hasNote', e.note IS NOT NULL)")}, ?4
        FROM video_approval_events e WHERE e.id = ?5`).bind(newId(), input.principal.id, auditMeta(input.principal), input.now, eventId),
    ]);
  } catch (error) { if (isUnique(error)) return null; throw error; }
  return readEvent(db, eventId);
}

// ---- Release ------------------------------------------------------------------------------------------------------------------------------

export type ReleaseVerdict = { kind: "ok" } | { kind: "already_released" } | { kind: "stale"; current: number | null } | { kind: "not_approved" };
/** Whether `expected` may be released now, from a fresh read: not already live, the latest event on the Version, and an approval. The INSERT repeats exactly this. */
export async function releaseVerdict(db: D1Database, assetId: string, expected: number): Promise<ReleaseVerdict> {
  const [live, latest] = await db.batch([
    db.prepare("SELECT 1 AS one FROM video_releases WHERE asset_id = ?1 AND withdrawn_at IS NULL").bind(assetId),
    db.prepare("SELECT revision, decision FROM video_approval_events WHERE asset_id = ?1 ORDER BY revision DESC LIMIT 1").bind(assetId),
  ]);
  if (live!.results.length > 0) return { kind: "already_released" };
  const row = latest!.results[0] as { revision: number; decision: string } | undefined;
  if (!row || row.revision !== expected) return { kind: "stale", current: row?.revision ?? null };
  return row.decision === "approved" ? { kind: "ok" } : { kind: "not_approved" };
}

/**
 * Releases a Version. The INSERT is the compare-and-set: it selects the approval event only while it is the Version's latest event, still an approval, with no live Release and the
 * Project unarchived, and the partial unique index `video_releases_live_unique` backs it. So two Releases leave one winner, and a decision landing first makes the Release stale.
 * Returns the Release, the verdict that refused it, or `archived`.
 */
export async function releaseVersion(db: D1Database, input: { projectId: string; assetId: string; principal: Principal; approvalRevision: number; now: number }): Promise<{ release: VideoRelease } | ReleaseVerdict | { kind: "archived" }> {
  const releaseId = newId();
  try {
    await db.batch([
      db.prepare(`INSERT INTO video_releases (id, project_id, video_id, asset_id, approval_event_id, approval_revision, released_by, released_at, withdrawn_at, withdrawn_by)
        SELECT ?1, e.project_id, e.video_id, e.asset_id, e.id, e.revision, ?2, ?3, NULL, NULL FROM video_approval_events e
        WHERE e.asset_id = ?4 AND e.project_id = ?5 AND e.revision = ?6 AND e.decision = 'approved'
          AND e.revision = (SELECT MAX(x.revision) FROM video_approval_events x WHERE x.asset_id = e.asset_id)
          AND NOT EXISTS (SELECT 1 FROM video_releases r WHERE r.asset_id = e.asset_id AND r.withdrawn_at IS NULL) AND ${LIVE_VERSION_EXISTS("e.asset_id")} AND ${NOT_ARCHIVED("e.project_id")}`)
        .bind(releaseId, input.principal.id, input.now, input.assetId, input.projectId, input.approvalRevision),
      db.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
        SELECT ?1, ?2, 'video_version.release', 'asset', r.asset_id, ${metaWith("?3", "json_object('projectId', r.project_id, 'videoId', r.video_id, 'releaseId', r.id, 'approvalRevision', r.approval_revision)")}, ?4
        FROM video_releases r WHERE r.id = ?5`).bind(newId(), input.principal.id, auditMeta(input.principal), input.now, releaseId),
    ]);
  } catch (error) { if (!isUnique(error)) throw error; }
  const release = await readRelease(db, releaseId);
  if (release) return { release };
  if (await projectArchived(db, input.projectId)) return { kind: "archived" };
  const verdict = await releaseVerdict(db, input.assetId, input.approvalRevision);
  // The verdict can read "ok" only if the state changed back between the INSERT and now; the Release was still refused, so the safe answer is stale.
  return verdict.kind === "ok" ? { kind: "stale", current: input.approvalRevision } : verdict;
}

/** Withdraws the Version's live Release. `none` when there is none, `archived` when the Project is. */
export async function withdrawRelease(db: D1Database, input: { projectId: string; assetId: string; principal: Principal; now: number }): Promise<"withdrawn" | "none" | "archived"> {
  if (await projectArchived(db, input.projectId)) return "archived";
  const live = await db.prepare("SELECT id FROM video_releases WHERE asset_id = ?1 AND project_id = ?2 AND withdrawn_at IS NULL").bind(input.assetId, input.projectId).first<{ id: string }>();
  if (!live) return "none";
  const auditId = newId();
  await db.batch([
    db.prepare(`UPDATE video_releases SET withdrawn_at = ?1, withdrawn_by = ?2 WHERE id = ?3 AND withdrawn_at IS NULL AND ${LIVE_VERSION_EXISTS("video_releases.asset_id")} AND ${NOT_ARCHIVED("project_id")}`).bind(input.now, input.principal.id, live.id),
    db.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?1, ?2, 'video_version.release_withdraw', 'asset', r.asset_id, ${metaWith("?3", "json_object('projectId', r.project_id, 'videoId', r.video_id, 'releaseId', r.id, 'approvalRevision', r.approval_revision)")}, ?4
      FROM video_releases r WHERE r.id = ?5 AND r.withdrawn_at = ?4 AND r.withdrawn_by = ?2 AND changes() > 0`).bind(auditId, input.principal.id, auditMeta(input.principal), input.now, live.id),
  ]);
  if (await db.prepare("SELECT 1 AS one FROM audit_log WHERE id = ?1").bind(auditId).first()) return "withdrawn";
  return await projectArchived(db, input.projectId) ? "archived" : "none";
}

async function projectArchived(db: D1Database, projectId: string): Promise<boolean> {
  return (await db.prepare("SELECT archived_at FROM projects WHERE id = ?1").bind(projectId).first<{ archived_at: number | null }>())?.archived_at != null;
}

// ---- premium ------------------------------------------------------------------------------------------------------------------------------

export type PremiumState = { premium: boolean; premiumUnlocked: boolean };
const stateOf = (video: { premium: boolean; unlocked: boolean }): PremiumState => ({ premium: video.premium, premiumUnlocked: video.unlocked });

/** Sets `videos.premium`. Idempotent: the same state writes nothing and audits nothing. `archived` when the Project is. */
export async function setPremium(db: D1Database, input: { projectId: string; videoId: string; principal: Principal; premium: boolean; now: number }): Promise<PremiumState | "archived" | "not_found"> {
  const before = await findVideo(db, input.projectId, input.videoId); if (!before) return "not_found";
  let landed = false;
  if (before.premium !== input.premium) {
    const [update] = await db.batch([
      db.prepare(`UPDATE videos SET premium = ?1, updated_at = ?2 WHERE id = ?3 AND project_id = ?4 AND premium <> ?1 AND ${LIVE_VIDEO("videos")} AND ${NOT_ARCHIVED("?4")}`).bind(input.premium ? 1 : 0, input.now, input.videoId, input.projectId),
      db.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
        SELECT ?1, ?2, 'video.premium_set', 'video', ?3, ${metaWith("?4", "json_object('projectId', ?5, 'premium', json(?6))")}, ?7 WHERE changes() > 0`)
        .bind(newId(), input.principal.id, input.videoId, auditMeta(input.principal), input.projectId, input.premium ? "true" : "false", input.now),
    ]);
    landed = (update?.meta.changes ?? 0) > 0;
  }
  return settle(db, input.projectId, landed, () => findVideo(db, input.projectId, input.videoId));
}

/**
 * The answer after a write: the Video's state, or `archived` when no mutation landed and the Project is archived. A request that changed nothing (idempotent, or refused by the guard) is
 * not a success on a Project that was archived while its body was being read, so the archive is checked at the end, not only on entry.
 */
async function settle(db: D1Database, projectId: string, landed: boolean, read: () => Promise<{ premium: boolean; unlocked: boolean } | null>): Promise<PremiumState | "archived" | "not_found"> {
  if (!landed && await projectArchived(db, projectId)) return "archived";
  const after = await read();
  return after ? stateOf(after) : "not_found";
}

/**
 * Unlocks (inserts the row, or changes its payment reference) or re-locks (deletes it). Idempotent: an unchanged state writes nothing. The payment reference is never put in the
 * audit row, only whether one is set. A re-lock is `video.premium_relock`; an unlock and a reference change are `video.premium_unlock`.
 */
export async function setPremiumUnlock(db: D1Database, input: { projectId: string; videoId: string; principal: Principal; unlocked: boolean; paymentRef: string | null; now: number }): Promise<PremiumState | "archived" | "not_found"> {
  const before = await findVideo(db, input.projectId, input.videoId); if (!before) return "not_found";
  const meta = (extra: string) => `json_object('projectId', ?5, ${extra})`;
  let landed = false;
  if (input.unlocked && (!before.unlocked || before.paymentRef !== input.paymentRef)) {
    const [write] = await db.batch([
      db.prepare(`INSERT INTO video_premium_unlocks (video_id, project_id, unlocked_by, unlocked_at, payment_ref)
        SELECT v.id, v.project_id, ?1, ?2, ?3 FROM videos v WHERE v.id = ?4 AND v.project_id = ?5 AND ${LIVE_VIDEO("v")} AND ${NOT_ARCHIVED("?5")}
        ON CONFLICT (video_id) DO UPDATE SET payment_ref = excluded.payment_ref WHERE payment_ref IS NOT excluded.payment_ref`).bind(input.principal.id, input.now, input.paymentRef, input.videoId, input.projectId),
      db.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
        SELECT ?1, ?2, 'video.premium_unlock', 'video', ?3, ${metaWith("?4", meta("'hasPaymentRef', json(?6), 'paymentRefChanged', json(?7)"))}, ?8 WHERE changes() > 0`)
        .bind(newId(), input.principal.id, input.videoId, auditMeta(input.principal), input.projectId, input.paymentRef === null ? "false" : "true", before.unlocked ? "true" : "false", input.now),
    ]);
    landed = (write?.meta.changes ?? 0) > 0;
  } else if (!input.unlocked && before.unlocked) {
    const [write] = await db.batch([
      db.prepare(`DELETE FROM video_premium_unlocks WHERE video_id = ?1 AND project_id = ?2 AND ${LIVE_VIDEO_EXISTS("video_premium_unlocks.video_id")} AND ${NOT_ARCHIVED("?2")}`).bind(input.videoId, input.projectId),
      db.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
        SELECT ?1, ?2, 'video.premium_relock', 'video', ?3, ${metaWith("?4", "json_object('projectId', ?5)")}, ?6 WHERE changes() > 0`)
        .bind(newId(), input.principal.id, input.videoId, auditMeta(input.principal), input.projectId, input.now),
    ]);
    landed = (write?.meta.changes ?? 0) > 0;
  }
  return settle(db, input.projectId, landed, () => findVideo(db, input.projectId, input.videoId));
}
