import { ROLE_LABELS, REVIEW_LINK_STATUSES, type ReviewLinkDto, type Role } from "@quincy/shared";
import { auditMeta, type AuditPrincipal } from "./audit";
import { newId } from "./ids";

/**
 * Review links (#741 11a). Every mutation is ONE `db.batch`, built the way `video-notes.ts` builds its writes: the audit row goes in first and
 * carries the whole guard (Project not archived, link live, membership present, same-Project fence) as a `WHERE`; every later statement runs
 * only `WHERE EXISTS (the audit row)`. A refused guard therefore writes nothing at all, and the route reads the audit row back to learn whether
 * it landed. The cross-column rules 0069 leaves to SQL live here: a video link is always inserted with `created_by` and `updated_at`, every
 * UPDATE stamps `updated_at`, `revoked_at` and `revoked_by` are written together, and `publish_version` is never touched (a delivery link is
 * unreachable: every statement says `kind = 'video_review'`).
 */
const AUDIT_INSERT_WHERE = "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, ?, 'review_link', ?, ?, ? WHERE";
const AUDITED = "EXISTS (SELECT 1 FROM audit_log WHERE id = ?)";
const NOT_ARCHIVED = "EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)";
const LINK_LIVE = "EXISTS (SELECT 1 FROM client_links WHERE id = ? AND project_id = ? AND kind = 'video_review' AND revoked_at IS NULL)";
const MEMBER_LIVE = "EXISTS (SELECT 1 FROM review_link_videos WHERE link_id = ? AND video_id = ? AND removed_at IS NULL)";

export type Principal = NonNullable<AuditPrincipal>;
export type Allow = { comments: boolean; approve: boolean; download: boolean };

export type LinkHead = { id: string; revoked_at: number | null; expires_at: number };
export async function findLinkHead(db: D1Database, projectId: string, linkId: string): Promise<LinkHead | null> {
  return await db.prepare("SELECT id, revoked_at, expires_at FROM client_links WHERE id = ? AND project_id = ? AND kind = 'video_review'").bind(linkId, projectId).first<LinkHead>() ?? null;
}

/** Whether the audit row of a guarded batch landed (the guard held and every later statement ran). */
async function landed(db: D1Database, auditId: string): Promise<boolean> {
  return await db.prepare("SELECT 1 AS one FROM audit_log WHERE id = ?").bind(auditId).first() !== null;
}

type VersionRef = { assetId: string; version: number };
/** Every committed Version of each given Video that belongs to the Project, keyed by Video id (a Video of another Project, or unknown, is absent). Oldest first. */
export async function versionsByVideo(db: D1Database, projectId: string, videoIds: string[]): Promise<Map<string, VersionRef[]>> {
  const rows = (await db.prepare(`SELECT m.video_id, m.asset_id, a.version FROM videos v JOIN video_version_meta m ON m.video_id = v.id JOIN assets a ON a.id = m.asset_id
      WHERE v.project_id = ? AND v.id IN (SELECT value FROM json_each(?)) ORDER BY a.version`).bind(projectId, JSON.stringify(videoIds)).all<{ video_id: string; asset_id: string; version: number }>()).results;
  const map = new Map<string, VersionRef[]>();
  for (const row of rows) { const list = map.get(row.video_id) ?? []; list.push({ assetId: row.asset_id, version: row.version }); map.set(row.video_id, list); }
  return map;
}

export async function isLiveMember(db: D1Database, linkId: string, videoId: string): Promise<boolean> {
  return await db.prepare("SELECT 1 AS one FROM review_link_videos WHERE link_id = ? AND video_id = ? AND removed_at IS NULL").bind(linkId, videoId).first() !== null;
}

// ---- read ---------------------------------------------------------------------------------------------------------------------------------------

type LinkRow = {
  id: string; label: string | null; expires_at: number; created_at: number; revoked_at: number | null; has_passcode: number; allow_comments: number; allow_approve: number; allow_download: number;
  created_by: string | null; cu_name: string | null; cu_role: Role | null; cu_active: number | null; revoked_by: string | null; ru_name: string | null; ru_role: Role | null; ru_active: number | null;
};
const person = (id: string | null, name: string | null, role: Role | null, active: number | null) =>
  id === null || name === null || role === null ? null : { id, name, roleLabel: ROLE_LABELS[role], isExternal: role === "external_editor", active: Boolean(active) };
const iso = (ms: number) => new Date(ms).toISOString();

/** The Project's Review links (or one), newest first, as the staff DTO. Never selects the token hash or the passcode hash itself. */
export async function loadReviewLinkDtos(db: D1Database, projectId: string, now: number, linkId?: string): Promise<ReviewLinkDto[]> {
  const scope = "SELECT id FROM client_links WHERE project_id = ?1 AND kind = 'video_review' AND (?2 IS NULL OR id = ?2)";
  const [links, videos, grants, activity, guests] = await db.batch([
    db.prepare(`SELECT l.id, l.label, l.expires_at, l.created_at, l.revoked_at, l.passcode_hash IS NOT NULL AS has_passcode, l.allow_comments, l.allow_approve, l.allow_download,
        l.created_by, cu.name AS cu_name, cu.role AS cu_role, cu.active AS cu_active, l.revoked_by, ru.name AS ru_name, ru.role AS ru_role, ru.active AS ru_active
      FROM client_links l LEFT JOIN user cu ON cu.id = l.created_by LEFT JOIN user ru ON ru.id = l.revoked_by
      WHERE l.project_id = ?1 AND l.kind = 'video_review' AND (?2 IS NULL OR l.id = ?2) ORDER BY l.created_at DESC, l.rowid DESC`).bind(projectId, linkId ?? null),
    db.prepare(`SELECT m.link_id, m.video_id, m.added_at, v.title FROM review_link_videos m JOIN videos v ON v.id = m.video_id
      WHERE m.removed_at IS NULL AND m.link_id IN (${scope}) ORDER BY m.added_at, m.rowid`).bind(projectId, linkId ?? null),
    db.prepare(`SELECT g.link_id, g.video_id, g.asset_id, a.version FROM review_link_version_grants g JOIN assets a ON a.id = g.asset_id
      WHERE g.revoked_at IS NULL AND g.link_id IN (${scope}) ORDER BY a.version, g.rowid`).bind(projectId, linkId ?? null),
    db.prepare(`SELECT s.link_id, SUM(CASE WHEN s.expires_at > ?3 AND s.link_generation = l.token_generation AND l.revoked_at IS NULL AND l.expires_at > ?3 THEN 1 ELSE 0 END) AS open_sessions, MAX(s.created_at) AS last_opened
      FROM guest_sessions s JOIN client_links l ON l.id = s.link_id WHERE s.link_id IN (${scope}) GROUP BY s.link_id`).bind(projectId, linkId ?? null, now),
    // Guests who verified an email on the link (#741 13a): the only place staff see an address besides a note author.
    db.prepare(`SELECT m.link_id, g.email_normalized AS email, g.display_name AS name, m.last_seen_at, m.unsubscribed_at FROM guest_link_members m JOIN guest_reviewers g ON g.id = m.guest_id
      WHERE m.link_id IN (${scope}) ORDER BY m.first_verified_at, m.rowid`).bind(projectId, linkId ?? null),
  ]);
  const guestMap = new Map<string, ReviewLinkDto["activity"]["verifiedGuests"]>();
  for (const row of (guests!.results as Array<{ link_id: string; email: string; name: string | null; last_seen_at: number; unsubscribed_at: number | null }>)) {
    const list = guestMap.get(row.link_id) ?? []; list.push({ email: row.email, name: row.name, lastSeenAt: iso(row.last_seen_at), unsubscribed: row.unsubscribed_at !== null }); guestMap.set(row.link_id, list);
  }
  const grantMap = new Map<string, Array<{ assetId: string; version: number }>>();
  for (const row of (grants!.results as Array<{ link_id: string; video_id: string; asset_id: string; version: number }>)) {
    const key = `${row.link_id}:${row.video_id}`; const list = grantMap.get(key) ?? []; list.push({ assetId: row.asset_id, version: row.version }); grantMap.set(key, list);
  }
  const videoMap = new Map<string, ReviewLinkDto["videos"]>();
  for (const row of (videos!.results as Array<{ link_id: string; video_id: string; added_at: number; title: string }>)) {
    const list = videoMap.get(row.link_id) ?? []; list.push({ videoId: row.video_id, title: row.title, addedAt: iso(row.added_at), grants: grantMap.get(`${row.link_id}:${row.video_id}`) ?? [] }); videoMap.set(row.link_id, list);
  }
  const activityMap = new Map((activity!.results as Array<{ link_id: string; open_sessions: number; last_opened: number | null }>).map((row) => [row.link_id, row]));
  return (links!.results as LinkRow[]).map((row): ReviewLinkDto => {
    const seen = activityMap.get(row.id);
    const status = REVIEW_LINK_STATUSES[row.revoked_at !== null ? 2 : row.expires_at <= now ? 1 : 0]!;
    return {
      id: row.id, label: row.label, status, createdAt: iso(row.created_at), createdBy: person(row.created_by, row.cu_name, row.cu_role, row.cu_active), expiresAt: iso(row.expires_at),
      revokedAt: row.revoked_at === null ? null : iso(row.revoked_at), revokedBy: person(row.revoked_by, row.ru_name, row.ru_role, row.ru_active), hasPasscode: row.has_passcode === 1,
      allow: { comments: row.allow_comments === 1, approve: row.allow_approve === 1, download: row.allow_download === 1 }, videos: videoMap.get(row.id) ?? [],
      activity: { openSessions: Number(seen?.open_sessions ?? 0), lastOpenedAt: seen?.last_opened == null ? null : iso(seen.last_opened), verifiedGuests: guestMap.get(row.id) ?? [] },
    };
  });
}

// ---- write --------------------------------------------------------------------------------------------------------------------------------------

type Audit = { id: string; action: string; linkId: string; principal: Principal; meta: Record<string, unknown>; now: number };
/** The audit INSERT carrying the guard. `guard` is a SQL boolean over `guardBinds`. */
function auditStatement(db: D1Database, audit: Audit, guard: string, guardBinds: unknown[]) {
  return db.prepare(`${AUDIT_INSERT_WHERE} ${guard}`).bind(audit.id, audit.principal.id, audit.action, audit.linkId, auditMeta(audit.principal, audit.meta), audit.now, ...guardBinds);
}
/** Runs the batch; true when the guard held. A unique-index race (`already_on_link`, a repeated grant) surfaces as false: nothing landed, the transaction rolled back. */
async function commit(db: D1Database, audit: Audit, statements: D1PreparedStatement[]): Promise<boolean> {
  try { await db.batch(statements); } catch (error) {
    if (error instanceof Error && /UNIQUE constraint/i.test(error.message)) return false;
    throw error;
  }
  return landed(db, audit.id);
}

export type GrantPair = { videoId: string; assetId: string };
const COUNT_PAIRS = `(SELECT COUNT(*) FROM json_each(?) j JOIN video_version_meta m ON m.asset_id = json_extract(j.value, '$.a') AND m.video_id = json_extract(j.value, '$.v')
  JOIN videos v ON v.id = m.video_id AND v.project_id = ?)`;

export type CreateInput = {
  projectId: string; principal: Principal; videoIds: string[]; grants: GrantPair[]; label: string | null; allow: Allow; expiresAt: number; passcodeHash: string | null; tokenHash: string; now: number;
};
/** Creates the link, its memberships and its grants in one batch. Returns the link id, or false when the guard refused (archived, a Video outside the Project, a grant that is not a Version). */
export async function createReviewLink(db: D1Database, input: CreateInput): Promise<string | false> {
  const linkId = newId(); const auditId = newId();
  const audit: Audit = { id: auditId, action: "review_link.create", linkId, principal: input.principal, now: input.now, meta: {
    projectId: input.projectId, linkId, videoIds: input.videoIds, assetIds: input.grants.map((grant) => grant.assetId), expiresAt: new Date(input.expiresAt).toISOString(), hasPasscode: input.passcodeHash !== null, allow: input.allow,
  } };
  const pairs = JSON.stringify(input.grants.map((grant) => ({ id: newId(), v: grant.videoId, a: grant.assetId })));
  const members = JSON.stringify(input.videoIds.map((videoId) => ({ id: newId(), v: videoId })));
  const guard = `${NOT_ARCHIVED} AND (SELECT COUNT(*) FROM videos WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))) = ? AND ${COUNT_PAIRS} = ?`;
  const ok = await commit(db, audit, [
    auditStatement(db, audit, guard, [input.projectId, input.projectId, JSON.stringify(input.videoIds), input.videoIds.length, pairs, input.projectId, input.grants.length]),
    db.prepare(`INSERT INTO client_links (id, project_id, token_hash, kind, label, passcode_hash, allow_comments, allow_approve, allow_download, expires_at, created_by, token_generation, updated_at, created_at)
      SELECT ?, ?, ?, 'video_review', ?, ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE ${AUDITED}`)
      .bind(linkId, input.projectId, input.tokenHash, input.label, input.passcodeHash, Number(input.allow.comments), Number(input.allow.approve), Number(input.allow.download), input.expiresAt, input.principal.id, input.now, input.now, auditId),
    db.prepare(`INSERT INTO review_link_videos (id, link_id, video_id, project_id, added_by, added_at) SELECT json_extract(j.value, '$.id'), ?, json_extract(j.value, '$.v'), ?, ?, ? FROM json_each(?) j WHERE ${AUDITED} ORDER BY j.key`)
      .bind(linkId, input.projectId, input.principal.id, input.now, members, auditId),
    db.prepare(`INSERT INTO review_link_version_grants (id, link_id, video_id, asset_id, granted_by, granted_at) SELECT json_extract(j.value, '$.id'), ?, json_extract(j.value, '$.v'), json_extract(j.value, '$.a'), ?, ? FROM json_each(?) j WHERE ${AUDITED} ORDER BY j.key`)
      .bind(linkId, input.principal.id, input.now, pairs, auditId),
  ]);
  return ok ? linkId : false;
}

export type PatchSet = { label?: string | null; expiresAt?: number; passcodeHash?: string | null; allow?: Partial<Allow> };
/** The columns a PATCH names, in the order the audit row lists them. */
export const patchedFields = (patch: PatchSet & { passcode?: unknown }): string[] =>
  [patch.label !== undefined && "label", patch.expiresAt !== undefined && "expiresAt", patch.passcodeHash !== undefined && "passcode", patch.allow !== undefined && "allow"].filter((field): field is string => field !== false);

export async function patchReviewLink(db: D1Database, input: { projectId: string; linkId: string; principal: Principal; patch: PatchSet; now: number }): Promise<boolean> {
  const { patch } = input; const auditId = newId();
  const assignments = ["updated_at = ?"]; const values: unknown[] = [input.now];
  if (patch.label !== undefined) { assignments.push("label = ?"); values.push(patch.label); }
  if (patch.expiresAt !== undefined) { assignments.push("expires_at = ?"); values.push(patch.expiresAt); }
  if (patch.passcodeHash !== undefined) { assignments.push("passcode_hash = ?"); values.push(patch.passcodeHash); }
  for (const [key, column] of [["comments", "allow_comments"], ["approve", "allow_approve"], ["download", "allow_download"]] as const) {
    const value = patch.allow?.[key]; if (value !== undefined) { assignments.push(`${column} = ?`); values.push(Number(value)); }
  }
  const audit: Audit = { id: auditId, action: "review_link.update", linkId: input.linkId, principal: input.principal, now: input.now, meta: { projectId: input.projectId, linkId: input.linkId, fields: patchedFields(patch) } };
  return commit(db, audit, [
    auditStatement(db, audit, `${NOT_ARCHIVED} AND ${LINK_LIVE}`, [input.projectId, input.linkId, input.projectId]),
    db.prepare(`UPDATE client_links SET ${assignments.join(", ")} WHERE id = ? AND project_id = ? AND kind = 'video_review' AND revoked_at IS NULL AND ${AUDITED}`).bind(...values, input.linkId, input.projectId, auditId),
  ]);
}

export async function addLinkVideo(db: D1Database, input: { projectId: string; linkId: string; principal: Principal; videoId: string; assetIds: string[]; now: number }): Promise<boolean> {
  const auditId = newId();
  const audit: Audit = { id: auditId, action: "review_link.video_add", linkId: input.linkId, principal: input.principal, now: input.now, meta: { projectId: input.projectId, linkId: input.linkId, videoId: input.videoId, assetIds: input.assetIds } };
  const pairs = JSON.stringify(input.assetIds.map((assetId) => ({ id: newId(), v: input.videoId, a: assetId })));
  const guard = `${NOT_ARCHIVED} AND ${LINK_LIVE} AND NOT ${MEMBER_LIVE} AND EXISTS (SELECT 1 FROM videos WHERE id = ? AND project_id = ?) AND ${COUNT_PAIRS} = ?`;
  return commit(db, audit, [
    auditStatement(db, audit, guard, [input.projectId, input.linkId, input.projectId, input.linkId, input.videoId, input.videoId, input.projectId, pairs, input.projectId, input.assetIds.length]),
    db.prepare(`INSERT INTO review_link_videos (id, link_id, video_id, project_id, added_by, added_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${AUDITED}`).bind(newId(), input.linkId, input.videoId, input.projectId, input.principal.id, input.now, auditId),
    db.prepare(`INSERT INTO review_link_version_grants (id, link_id, video_id, asset_id, granted_by, granted_at) SELECT json_extract(j.value, '$.id'), ?, json_extract(j.value, '$.v'), json_extract(j.value, '$.a'), ?, ? FROM json_each(?) j WHERE ${AUDITED} ORDER BY j.key`)
      .bind(input.linkId, input.principal.id, input.now, pairs, auditId),
  ]);
}

export async function removeLinkVideo(db: D1Database, input: { projectId: string; linkId: string; principal: Principal; videoId: string; now: number }): Promise<boolean> {
  const auditId = newId();
  const audit: Audit = { id: auditId, action: "review_link.video_remove", linkId: input.linkId, principal: input.principal, now: input.now, meta: { projectId: input.projectId, linkId: input.linkId, videoId: input.videoId } };
  return commit(db, audit, [
    auditStatement(db, audit, `${NOT_ARCHIVED} AND ${LINK_LIVE} AND ${MEMBER_LIVE}`, [input.projectId, input.linkId, input.projectId, input.linkId, input.videoId]),
    db.prepare(`UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE link_id = ? AND video_id = ? AND removed_at IS NULL AND ${AUDITED}`).bind(input.now, input.principal.id, input.linkId, input.videoId, auditId),
    db.prepare(`UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE link_id = ? AND video_id = ? AND revoked_at IS NULL AND ${AUDITED}`).bind(input.now, input.principal.id, input.linkId, input.videoId, auditId),
    db.prepare("UPDATE client_links SET updated_at = ? WHERE id = ? AND kind = 'video_review' AND " + AUDITED).bind(input.now, input.linkId, auditId),
  ]);
}

/** Replaces the live grant set of one member Video by diff. The set is non-empty (the route refuses an empty one), so a member keeps at least one live grant. */
export async function setLinkGrants(db: D1Database, input: { projectId: string; linkId: string; principal: Principal; videoId: string; assetIds: string[]; now: number }): Promise<boolean> {
  const auditId = newId();
  const audit: Audit = { id: auditId, action: "review_link.grants_set", linkId: input.linkId, principal: input.principal, now: input.now, meta: { projectId: input.projectId, linkId: input.linkId, videoId: input.videoId, assetIds: input.assetIds } };
  const pairs = JSON.stringify(input.assetIds.map((assetId) => ({ id: newId(), v: input.videoId, a: assetId })));
  return commit(db, audit, [
    auditStatement(db, audit, `${NOT_ARCHIVED} AND ${LINK_LIVE} AND ${MEMBER_LIVE} AND ${COUNT_PAIRS} = ?`, [input.projectId, input.linkId, input.projectId, input.linkId, input.videoId, pairs, input.projectId, input.assetIds.length]),
    db.prepare(`UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE link_id = ? AND video_id = ? AND revoked_at IS NULL AND asset_id NOT IN (SELECT value FROM json_each(?)) AND ${AUDITED}`)
      .bind(input.now, input.principal.id, input.linkId, input.videoId, JSON.stringify(input.assetIds), auditId),
    db.prepare(`INSERT INTO review_link_version_grants (id, link_id, video_id, asset_id, granted_by, granted_at) SELECT json_extract(j.value, '$.id'), ?, json_extract(j.value, '$.v'), json_extract(j.value, '$.a'), ?, ? FROM json_each(?) j
      WHERE NOT EXISTS (SELECT 1 FROM review_link_version_grants g WHERE g.link_id = ? AND g.asset_id = json_extract(j.value, '$.a') AND g.revoked_at IS NULL) AND ${AUDITED} ORDER BY j.key`)
      .bind(input.linkId, input.principal.id, input.now, pairs, input.linkId, auditId),
    db.prepare("UPDATE client_links SET updated_at = ? WHERE id = ? AND kind = 'video_review' AND " + AUDITED).bind(input.now, input.linkId, auditId),
  ]);
}

/** Revoke is allowed on an archived Project (no archived guard). It bumps the generation and deletes the sessions, so a guest request already past its join fails on the next read. */
export async function revokeReviewLink(db: D1Database, input: { projectId: string; linkId: string; principal: Principal; now: number }): Promise<boolean> {
  const auditId = newId();
  const audit: Audit = { id: auditId, action: "review_link.revoke", linkId: input.linkId, principal: input.principal, now: input.now, meta: { projectId: input.projectId, linkId: input.linkId } };
  return commit(db, audit, [
    auditStatement(db, audit, LINK_LIVE, [input.linkId, input.projectId]),
    db.prepare(`UPDATE client_links SET revoked_at = ?, revoked_by = ?, updated_at = ?, token_generation = token_generation + 1 WHERE id = ? AND project_id = ? AND kind = 'video_review' AND revoked_at IS NULL AND ${AUDITED}`)
      .bind(input.now, input.principal.id, input.now, input.linkId, input.projectId, auditId),
    db.prepare(`DELETE FROM guest_sessions WHERE link_id = ? AND ${AUDITED}`).bind(input.linkId, auditId),
  ]);
}

/** Rotates the token. Refused (false) on a revoked or expired link, or an archived Project. */
export async function replaceReviewLinkToken(db: D1Database, input: { projectId: string; linkId: string; principal: Principal; tokenHash: string; now: number }): Promise<boolean> {
  const auditId = newId();
  const audit: Audit = { id: auditId, action: "review_link.replace", linkId: input.linkId, principal: input.principal, now: input.now, meta: { projectId: input.projectId, linkId: input.linkId } };
  const live = "EXISTS (SELECT 1 FROM client_links WHERE id = ? AND project_id = ? AND kind = 'video_review' AND revoked_at IS NULL AND expires_at > ?)";
  return commit(db, audit, [
    auditStatement(db, audit, `${NOT_ARCHIVED} AND ${live}`, [input.projectId, input.linkId, input.projectId, input.now]),
    db.prepare(`UPDATE client_links SET token_hash = ?, token_generation = token_generation + 1, updated_at = ? WHERE id = ? AND project_id = ? AND kind = 'video_review' AND revoked_at IS NULL AND expires_at > ? AND ${AUDITED}`)
      .bind(input.tokenHash, input.now, input.linkId, input.projectId, input.now, auditId),
    db.prepare(`DELETE FROM guest_sessions WHERE link_id = ? AND ${AUDITED}`).bind(input.linkId, auditId),
  ]);
}
