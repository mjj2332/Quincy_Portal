import type { SessionUser } from "../env";
import { auditMeta } from "./audit";
import { guestDigestStatements } from "./guest-digest";
import { newId } from "./ids";
import { hashToken, randomToken } from "./opaque-token";
import { SQL_UUID_V4 } from "./sql-uuid";
import { LIVE_VERSION, LIVE_VIDEO } from "./video-live-sql";

/**
 * The Delivery review link (#847, ADR 0023): the one system-owned Review link of a Project, made and kept in step with its Delivery page. This is the WRITE side and the only writer of
 * `client_links.delivery_review = 1`, its Video memberships and its Version grants. Staff routes refuse the link (409 `delivery_review_managed`), so nothing else can drift it.
 *
 * `deliveryReviewSyncStatements` returns statements to append to a caller's `db.batch`: Publish, Unlock, Re-lock, a premium mark, or the backfill. Everything is SET-BASED SQL that reads the
 * desired state at COMMIT time, never a pre-read: the desired state is "the films of the Project's latest Published set that are not locked, each at its published Version and every older
 * Version" (QV and QG below), and the statements diff it against the live rows. Two concurrent writers therefore converge on f(state), whichever commits last (lesson #828, the
 * RECOMPUTE_CURRENT_SQL pattern). Nothing is written when there is nothing to change: no audit, no digest.
 *
 * Only Publish and the backfill CREATE the link (`create` set). Unlock, Re-lock and a premium mark pass `create: null`, so a non-Publish write can never fail on the unique index and roll
 * the Unlock back. The link is kept when its membership becomes empty. Every statement after the audit row is fenced on it, so a refused parent leaves no trace.
 *
 * Older Versions are granted "by Version number": every committed Version of the film with `version <= published`, Trash included (a restore then needs no sync; the guest reads filter
 * Trash). A Version uploaded after the Publish is never granted. See ADR 0023 for that reading of "every older Version".
 */
export type Principal = Pick<SessionUser, "id" | "impersonatedBy" | "via">;
export type DeliverySyncTrigger = "publish" | "premium" | "unlock" | "relock" | "backfill";
export type DeliverySyncInput = {
  projectId: string; principal: Principal; now: number; trigger: DeliverySyncTrigger;
  /** The audit row of the write this sync rides on. Every sync statement is fenced on it landing. `null` for a standalone sync (backfill), which is its own batch. */
  parentAuditId: string | null;
  /** Set by Publish and the backfill: the link is created when the Project has none and its latest set holds a film. */
  create: { linkId: string; tokenHash: string; tokenSecret: string; createAuditId: string } | null;
};

/** A fresh link's identity, minted per attempt. The secret is stored beside its hash (ADR 0021) so staff can copy the address again. */
export async function mintDeliveryLink(): Promise<NonNullable<DeliverySyncInput["create"]>> {
  const secret = randomToken();
  return { linkId: newId(), tokenHash: await hashToken(secret), tokenSecret: secret, createAuditId: newId() };
}

const LINK = "(SELECT id FROM client_links WHERE project_id = {project} AND delivery_review = 1)";
const AUDITED = "EXISTS (SELECT 1 FROM audit_log WHERE id = {sync})";
const PARENT = "({parent} IS NULL OR EXISTS (SELECT 1 FROM audit_log WHERE id = {parent}))";

/** QV: the films the link should carry: the Project's latest set, live Versions of live Videos, not locked (a Premium film joins once Unlocked). One row per film with its published Version number. */
const QV = `SELECT v.id AS video_id, MAX(a.version) AS pub_version
    FROM delivery_pages dp
    JOIN delivery_sets ds ON ds.project_id = dp.project_id AND ds.set_number = dp.latest_set_number
    JOIN delivery_set_items di ON di.set_id = ds.id
    JOIN assets a ON a.id = di.asset_id AND a.kind = 'video'
    JOIN video_version_meta vm ON vm.asset_id = a.id AND ${LIVE_VERSION("vm")}
    JOIN videos v ON v.id = vm.video_id AND v.project_id = dp.project_id AND ${LIVE_VIDEO("v")}
    WHERE dp.project_id = {project} AND (v.premium = 0 OR EXISTS (SELECT 1 FROM video_premium_unlocks vu WHERE vu.video_id = v.id))
    GROUP BY v.id`;

/** QG: the Versions the link should grant: every committed Version of a QV film up to and including the published one. Trash included on purpose (video-live.guard ALLOWLIST). */
const QG = `SELECT qv.video_id AS video_id, ga.id AS asset_id
    FROM (${QV}) qv
    JOIN video_version_meta gm ON gm.video_id = qv.video_id
    JOIN assets ga ON ga.id = gm.asset_id AND ga.kind = 'video' AND ga.version <= qv.pub_version`;

const LIVE_MEMBER = (video: string) => `EXISTS (SELECT 1 FROM review_link_videos rv WHERE rv.link_id = ${LINK} AND rv.video_id = ${video} AND rv.removed_at IS NULL)`;
const LIVE_GRANT = (asset: string) => `EXISTS (SELECT 1 FROM review_link_version_grants rg WHERE rg.link_id = ${LINK} AND rg.asset_id = ${asset} AND rg.revoked_at IS NULL)`;

/** There is something to change: a film without a live member, a live member that no longer qualifies, a Version without a live grant, or a live grant that no longer qualifies. */
const DIFF = `(
    EXISTS (SELECT 1 FROM (${QV}) q WHERE NOT ${LIVE_MEMBER("q.video_id")})
    OR EXISTS (SELECT 1 FROM review_link_videos rv WHERE rv.link_id = ${LINK} AND rv.removed_at IS NULL AND rv.video_id NOT IN (SELECT video_id FROM (${QV})))
    OR EXISTS (SELECT 1 FROM (${QG}) g WHERE NOT ${LIVE_GRANT("g.asset_id")})
    OR EXISTS (SELECT 1 FROM review_link_version_grants rg WHERE rg.link_id = ${LINK} AND rg.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM (${QG}) g WHERE g.video_id = rg.video_id AND g.asset_id = rg.asset_id))
  )`;

/** Statement text with `{name}` tokens becomes `?1..?n` in order of first use, so every bound value is named in the statement (D1 refuses an unnamed one). */
function prepare(db: D1Database, sql: string, values: Record<string, unknown>): D1PreparedStatement {
  const order: string[] = [];
  const text = sql.replace(/\{(\w+)\}/g, (_match, name: string) => {
    if (!(name in values)) throw new Error(`delivery-review-link: no value for {${name}}`);
    let index = order.indexOf(name); if (index < 0) { order.push(name); index = order.length - 1; }
    return `?${index + 1}`;
  });
  return db.prepare(text).bind(...order.map((name) => values[name]));
}

export type DeliverySyncStatements = { statements: D1PreparedStatement[]; /** Present in `audit_log` iff the sync changed anything. */ syncAuditId: string };
export function deliveryReviewSyncStatements(db: D1Database, input: DeliverySyncInput): DeliverySyncStatements {
  const syncAuditId = newId();
  const create = input.create;
  const values: Record<string, unknown> = {
    project: input.projectId, now: input.now, actor: input.principal.id, sync: syncAuditId, parent: input.parentAuditId,
    meta: auditMeta(input.principal, { projectId: input.projectId, trigger: input.trigger }),
    ...(create ? { link: create.linkId, hash: create.tokenHash, secret: create.tokenSecret, createAudit: create.createAuditId, createMeta: auditMeta(input.principal, { projectId: input.projectId, linkId: create.linkId, delivery: true, trigger: input.trigger }) } : {}),
  };
  const run = (sql: string) => prepare(db, sql, values);
  const statements: D1PreparedStatement[] = [];
  if (create) {
    // S0 and S1 must stay adjacent: S1 reads `changes()`.
    statements.push(
      run(`INSERT INTO client_links (id, project_id, token_hash, token_secret, kind, label, passcode_hash, allow_comments, allow_approve, allow_download, expires_at, created_by, token_generation, updated_at, created_at, delivery_review)
        SELECT {link}, {project}, {hash}, {secret}, 'video_review', 'Delivery', NULL, 1, 1, 1, NULL, {actor}, 1, {now}, {now}, 1
        WHERE NOT EXISTS (SELECT 1 FROM client_links WHERE project_id = {project} AND delivery_review = 1) AND ${PARENT}
          AND EXISTS (SELECT 1 FROM delivery_pages dp JOIN delivery_sets ds ON ds.project_id = dp.project_id AND ds.set_number = dp.latest_set_number
            JOIN delivery_set_items di ON di.set_id = ds.id JOIN assets fa ON fa.id = di.asset_id AND fa.kind = 'video' WHERE dp.project_id = {project})`),
      run(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
        SELECT {createAudit}, {actor}, 'review_link.create', 'review_link', {link}, {createMeta}, {now} WHERE changes() > 0`),
    );
  }
  statements.push(
    run(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT {sync}, {actor}, 'review_link.delivery_sync', 'review_link', ${LINK},
        json_patch(COALESCE({meta}, '{}'), json_object('linkId', ${LINK}, 'videoIds', json((SELECT json_group_array(video_id) FROM (${QV}))), 'assetIds', json((SELECT json_group_array(asset_id) FROM (${QG}))))), {now}
      WHERE ${LINK} IS NOT NULL AND ${PARENT} AND ${DIFF}`),
    run(`UPDATE review_link_videos SET removed_at = {now}, removed_by = {actor}
      WHERE link_id = ${LINK} AND removed_at IS NULL AND video_id NOT IN (SELECT video_id FROM (${QV})) AND ${AUDITED}`),
    run(`UPDATE review_link_version_grants SET revoked_at = {now}, revoked_by = {actor}
      WHERE link_id = ${LINK} AND revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM (${QG}) g WHERE g.video_id = review_link_version_grants.video_id AND g.asset_id = review_link_version_grants.asset_id) AND ${AUDITED}`),
    run(`INSERT INTO review_link_videos (id, link_id, video_id, project_id, added_by, added_at)
      SELECT ${SQL_UUID_V4}, ${LINK}, q.video_id, {project}, {actor}, {now} FROM (${QV}) q WHERE NOT ${LIVE_MEMBER("q.video_id")} AND ${AUDITED}`),
    run(`INSERT INTO review_link_version_grants (id, link_id, video_id, asset_id, granted_by, granted_at)
      SELECT ${SQL_UUID_V4}, ${LINK}, g.video_id, g.asset_id, {actor}, {now} FROM (${QG}) g WHERE NOT ${LIVE_GRANT("g.asset_id")} AND ${AUDITED}`),
    // The digest: subscribers are told once of what this sync added, exactly as an ordinary link's add-Video and grant writes tell them (15b).
    ...guestDigestStatements(db, { kind: "delivery_sync", projectId: input.projectId, actorId: input.principal.id }, syncAuditId, input.now),
    run(`UPDATE client_links SET updated_at = {now} WHERE id = ${LINK} AND delivery_review = 1 AND ${AUDITED}`),
  );
  return { statements, syncAuditId };
}

export type DeliverySyncResult = { created: boolean; changed: boolean };
/** The sync as its own batch (the Admin backfill). Idempotent: a second run on an unchanged Project writes nothing and reports `{ created: false, changed: false }`. */
export async function syncDeliveryReviewLink(db: D1Database, input: Omit<DeliverySyncInput, "create" | "parentAuditId"> & { creates?: boolean }): Promise<DeliverySyncResult> {
  const create = input.creates === false ? null : await mintDeliveryLink();
  const { creates: _creates, ...rest } = input;
  const { statements, syncAuditId } = deliveryReviewSyncStatements(db, { ...rest, parentAuditId: null, create });
  await db.batch(statements);
  const landed = async (id: string) => await db.prepare("SELECT 1 AS one FROM audit_log WHERE id = ?1").bind(id).first() !== null;
  return { created: create !== null && await landed(create.createAuditId), changed: await landed(syncAuditId) };
}
