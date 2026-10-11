/**
 * "Is this item locked" for the Client Delivery page (#787), as SQL over an `assets` row aliased `alias`: 1 when it is a paid extra nobody has unlocked, 0 otherwise. The background Worker cannot
 * import the app Worker's `lib/delivery-lock.ts` (`lockedSql`), so the text is written out here; `test/delivery-lock-sql.guard.test.ts` fails if the two ever differ.
 */
export const deliveryLockedSql = (alias: string): string => `(CASE
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
