/**
 * Supersede carry (#787). A paid extra on a photo or document (`assets.delivery_premium`, plus its
 * `asset_premium_unlocks` row) belongs to the picture, not to one file version, so when a writer
 * supersedes an Asset with a new version the new row must inherit both. Owner question 2's default:
 * a paid Unlock carries to a re-edited version of the same photo.
 *
 * Append these statements to the SAME D1 batch that supersedes the old row and inserts the new
 * one, after both and after any statement that reads `changes()`, so a rollback cannot leave a
 * superseded row whose successor lost the flag. Both are no-ops unless the new row exists and the
 * old row has been superseded, so a batch whose insert was skipped (a lost race) carries nothing.
 * The old row keeps its own flag and Unlock as history: only the current version is ever served,
 * and Re-lock acts on the current row.
 *
 * Every worker source file that writes `superseded_at` must call this or be listed in
 * `packages/db/test/supersede-carry.guard.test.ts`.
 */
export function supersedeCarryStatements(db: D1Database, oldAssetId: string, newAssetId: string): D1PreparedStatement[] {
  return [
    db.prepare(
      "UPDATE assets SET delivery_premium = 1 WHERE id = ? AND EXISTS (SELECT 1 FROM assets o WHERE o.id = ? AND o.delivery_premium = 1 AND o.superseded_at IS NOT NULL)",
    ).bind(newAssetId, oldAssetId),
    db.prepare(
      "INSERT INTO asset_premium_unlocks (asset_id, project_id, unlocked_by, unlocked_at, payment_ref) SELECT ?, u.project_id, u.unlocked_by, u.unlocked_at, u.payment_ref FROM asset_premium_unlocks u WHERE u.asset_id = ? AND EXISTS (SELECT 1 FROM assets n WHERE n.id = ?) AND EXISTS (SELECT 1 FROM assets o WHERE o.id = ? AND o.superseded_at IS NOT NULL) ON CONFLICT (asset_id) DO NOTHING",
    ).bind(newAssetId, oldAssetId, newAssetId, oldAssetId),
  ];
}

/**
 * Carry to whichever Asset the superseded row now points at (`replaced_by_asset_id`). For the
 * Dropbox identity-race cleanup (#787), where the candidate that first received the carry is
 * deleted and the predecessor is repointed to the identity winner, a target SQL alone can resolve.
 * Append it AFTER the repoint and after every `changes()` reader. The fence is the pointer itself:
 * if the repoint did not land, or the winner vanished, the pointer still names the deleted
 * candidate (or nothing), no live row matches, and both statements are no-ops.
 */
export function supersedeCarryToSuccessorStatements(db: D1Database, oldAssetId: string): D1PreparedStatement[] {
  const successor = "(SELECT o.replaced_by_asset_id FROM assets o WHERE o.id = ? AND o.superseded_at IS NOT NULL)";
  return [
    db.prepare(
      `UPDATE assets SET delivery_premium = 1 WHERE id = ${successor} AND superseded_at IS NULL AND EXISTS (SELECT 1 FROM assets o WHERE o.id = ? AND o.delivery_premium = 1)`,
    ).bind(oldAssetId, oldAssetId),
    db.prepare(
      `INSERT INTO asset_premium_unlocks (asset_id, project_id, unlocked_by, unlocked_at, payment_ref) SELECT n.id, u.project_id, u.unlocked_by, u.unlocked_at, u.payment_ref FROM asset_premium_unlocks u JOIN assets n ON n.id = ${successor} AND n.superseded_at IS NULL WHERE u.asset_id = ? ON CONFLICT (asset_id) DO NOTHING`,
    ).bind(oldAssetId, oldAssetId),
  ];
}
