/**
 * "Is this item locked" for the Client Delivery page (#787), as SQL so every public gate asks the same question and none can drift.
 *
 * `lockedSql("a")` is an expression over an `assets` row aliased `a`: 1 when the item is a paid extra nobody has unlocked, 0 otherwise.
 * - A Video Version is locked by its Video: `videos.premium = 1` with no `video_premium_unlocks` row. `assets.delivery_premium` is ignored for it.
 * - A Floorplan preview resolves to the PDF of the same version group and version, and is locked exactly when that PDF is. With no PDF found it answers for itself.
 * - Anything else is locked by `assets.delivery_premium = 1` with no `asset_premium_unlocks` row.
 * The flag and the unlock are live: a published set never changes, only this answer does. Inner aliases are prefixed `ld_` so they cannot shadow the caller's.
 */
export const lockedSql = (alias: string): string => `(CASE
  WHEN ${alias}.kind = 'video' THEN EXISTS (
    SELECT 1 FROM video_version_meta ld_m JOIN videos ld_v ON ld_v.id = ld_m.video_id
    WHERE ld_m.asset_id = ${alias}.id AND ld_v.premium = 1 AND NOT EXISTS (SELECT 1 FROM video_premium_unlocks ld_vu WHERE ld_vu.video_id = ld_v.id))
  ELSE EXISTS (
    SELECT 1 FROM assets ld_t
    WHERE ld_t.id = COALESCE(
        CASE WHEN ${alias}.kind = 'floorplan_preview' THEN (SELECT ld_p.id FROM assets ld_p WHERE ld_p.kind = 'floorplan_pdf' AND ld_p.collection_id = ${alias}.collection_id AND ld_p.version_group_id = ${alias}.version_group_id AND ld_p.version = ${alias}.version) END,
        ${alias}.id)
      AND ld_t.delivery_premium = 1 AND NOT EXISTS (SELECT 1 FROM asset_premium_unlocks ld_u WHERE ld_u.asset_id = ld_t.id))
  END)`;

const CURRENT_SET_ITEMS = `FROM delivery_set_items cs_i JOIN delivery_sets cs_s ON cs_s.id = cs_i.set_id
      JOIN delivery_pages cs_p ON cs_p.project_id = cs_s.project_id AND cs_p.latest_set_number = cs_s.set_number`;

/**
 * An EXISTS over the **current** set of every page: the latest set of a `delivery_pages` row (older sets are audit trail, not a surface). `assetCondition` is a predicate tail on the
 * item's asset id, such as `"= ?3"` or `"IN (?, ?)"`. A page that is switched off still counts: the set is still the one it will serve when switched back on.
 */
export const inCurrentSetSql = (assetCondition: string): string => `EXISTS (SELECT 1 ${CURRENT_SET_ITEMS} WHERE cs_i.asset_id ${assetCondition})`;

/** The first of these Assets that is in a page's current set, or null. Used to name the blocker once a guarded delete or Trash was refused. */
export async function firstInCurrentSet(db: D1Database, assetIds: readonly string[]): Promise<string | null> {
  if (assetIds.length === 0) return null;
  const row = await db.prepare(`SELECT cs_i.asset_id AS id ${CURRENT_SET_ITEMS} WHERE cs_i.asset_id IN (${assetIds.map(() => "?").join(", ")}) LIMIT 1`).bind(...assetIds).first<{ id: string }>();
  return row?.id ?? null;
}

/** The body of the 409 a delete or Trash answers while the Asset is in a page's current set. One shape for both routes. */
export const DELIVERY_PUBLISHED_BODY = { error: "This is part of a published Client Delivery page; it can't be deleted or removed while it is.", code: "delivery_published" } as const;
