import { DELIVERY_PREMIUM_KINDS, type AssetPremiumResponse } from "@quincy/shared";
import { auditMeta, type AuditPrincipal } from "./audit";
import { newId } from "./ids";

/**
 * Photo and document premium and Unlock (#787 slice 2), the Asset counterpart of the Video premium in `video-approval.ts`. Every write is ONE `db.batch`: the committing statement carries
 * the whole guard (the Asset is a current, eligible Asset of the Project, and the Project is not archived) as a `WHERE`, and the audit row follows only a statement that landed, so a refused
 * guard writes nothing and leaves no audit row. Premium is **live**: marking, Unlocking and Re-locking act on the current page at once and never touch a published set. The payment
 * reference is never put in an audit row, only whether one is set.
 */
export type Principal = NonNullable<AuditPrincipal>;
const NOT_ARCHIVED = (param: string) => `EXISTS (SELECT 1 FROM projects WHERE id = ${param} AND archived_at IS NULL)`;
const ELIGIBLE_KINDS = DELIVERY_PREMIUM_KINDS.map((kind) => `'${kind}'`).join(", ");
/** The Asset belongs to the Project (through its collection) and is the current copy. */
const OF_PROJECT = (asset: string, project: string) => `${asset}.superseded_at IS NULL AND EXISTS (SELECT 1 FROM collections c WHERE c.id = ${asset}.collection_id AND c.project_id = ${project})`;

export type PremiumAsset = { kind: string; premium: boolean; unlocked: boolean; paymentRef: string | null };

/** The current Asset of the Project, or null when it is not one (unknown, another Project's, or superseded). */
export async function findPremiumAsset(db: D1Database, projectId: string, assetId: string): Promise<PremiumAsset | null> {
  const row = await db.prepare(`SELECT a.kind, a.delivery_premium AS premium, u.asset_id IS NOT NULL AS unlocked, u.payment_ref AS paymentRef
      FROM assets a LEFT JOIN asset_premium_unlocks u ON u.asset_id = a.id WHERE a.id = ?1 AND ${OF_PROJECT("a", "?2")}`).bind(assetId, projectId)
    .first<{ kind: string; premium: number; unlocked: number; paymentRef: string | null }>();
  return row ? { kind: row.kind, premium: row.premium === 1, unlocked: row.unlocked === 1, paymentRef: row.paymentRef } : null;
}

export const isPremiumEligible = (kind: string): boolean => (DELIVERY_PREMIUM_KINDS as readonly string[]).includes(kind);
const stateOf = (asset: PremiumAsset): AssetPremiumResponse => ({ premium: asset.premium, premiumUnlocked: asset.unlocked });

async function projectArchived(db: D1Database, projectId: string): Promise<boolean> {
  return (await db.prepare("SELECT archived_at FROM projects WHERE id = ?1").bind(projectId).first<{ archived_at: number | null }>())?.archived_at != null;
}

/**
 * The answer after a write: the Asset's state, or `archived` when no mutation landed and the Project is archived. A request that changed nothing (idempotent, or refused by the guard)
 * is not a success on a Project that was archived while its body was being read, so the archive is checked at the end, not only on entry.
 */
async function settle(db: D1Database, projectId: string, assetId: string, landed: boolean): Promise<AssetPremiumResponse | "archived" | "not_found"> {
  if (!landed && await projectArchived(db, projectId)) return "archived";
  const after = await findPremiumAsset(db, projectId, assetId);
  return after ? stateOf(after) : "not_found";
}

/** Sets `assets.delivery_premium`. Idempotent: the same state writes nothing and audits nothing. */
export async function setAssetPremium(db: D1Database, input: { projectId: string; assetId: string; principal: Principal; premium: boolean; now: number }): Promise<AssetPremiumResponse | "archived" | "not_found"> {
  const before = await findPremiumAsset(db, input.projectId, input.assetId); if (!before) return "not_found";
  let landed = false;
  if (before.premium !== input.premium) {
    const [update] = await db.batch([
      db.prepare(`UPDATE assets SET delivery_premium = ?1, updated_at = ?2 WHERE id = ?3 AND delivery_premium <> ?1 AND kind IN (${ELIGIBLE_KINDS}) AND ${OF_PROJECT("assets", "?4")} AND ${NOT_ARCHIVED("?4")}`)
        .bind(input.premium ? 1 : 0, input.now, input.assetId, input.projectId),
      db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?1, ?2, 'asset.delivery_premium_set', 'asset', ?3, ?4, ?5 WHERE changes() > 0")
        .bind(newId(), input.principal.id, input.assetId, auditMeta(input.principal, { projectId: input.projectId, premium: input.premium }), input.now),
    ]);
    landed = (update?.meta.changes ?? 0) > 0;
  }
  return settle(db, input.projectId, input.assetId, landed);
}

/**
 * Unlocks (inserts the row, or changes its payment reference) or re-locks (deletes it). Idempotent: an unchanged state writes nothing. A Re-lock is `asset.premium_relock`; an Unlock and
 * a reference change are `asset.premium_unlock`.
 */
export async function setAssetUnlock(db: D1Database, input: { projectId: string; assetId: string; principal: Principal; unlocked: boolean; paymentRef: string | null; now: number }): Promise<AssetPremiumResponse | "archived" | "not_found"> {
  const before = await findPremiumAsset(db, input.projectId, input.assetId); if (!before) return "not_found";
  let landed = false;
  if (input.unlocked && (!before.unlocked || before.paymentRef !== input.paymentRef)) {
    const [write] = await db.batch([
      db.prepare(`INSERT INTO asset_premium_unlocks (asset_id, project_id, unlocked_by, unlocked_at, payment_ref)
        SELECT a.id, ?5, ?1, ?2, ?3 FROM assets a WHERE a.id = ?4 AND a.kind IN (${ELIGIBLE_KINDS}) AND ${OF_PROJECT("a", "?5")} AND ${NOT_ARCHIVED("?5")}
        ON CONFLICT (asset_id) DO UPDATE SET payment_ref = excluded.payment_ref WHERE payment_ref IS NOT excluded.payment_ref`)
        .bind(input.principal.id, input.now, input.paymentRef, input.assetId, input.projectId),
      db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?1, ?2, 'asset.premium_unlock', 'asset', ?3, ?4, ?5 WHERE changes() > 0")
        .bind(newId(), input.principal.id, input.assetId, auditMeta(input.principal, { projectId: input.projectId, hasPaymentRef: input.paymentRef !== null, paymentRefChanged: before.unlocked }), input.now),
    ]);
    landed = (write?.meta.changes ?? 0) > 0;
  } else if (!input.unlocked && before.unlocked) {
    const [write] = await db.batch([
      db.prepare(`DELETE FROM asset_premium_unlocks WHERE asset_id = ?1 AND project_id = ?2 AND ${NOT_ARCHIVED("?2")}`).bind(input.assetId, input.projectId),
      db.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?1, ?2, 'asset.premium_relock', 'asset', ?3, ?4, ?5 WHERE changes() > 0")
        .bind(newId(), input.principal.id, input.assetId, auditMeta(input.principal, { projectId: input.projectId }), input.now),
    ]);
    landed = (write?.meta.changes ?? 0) > 0;
  }
  return settle(db, input.projectId, input.assetId, landed);
}
