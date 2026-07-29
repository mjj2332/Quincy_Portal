import { Hono } from "hono";
import { COLLECTION_RECEIVED_COUNT_SQL, RAW_CLAIM_LEASE_MS, collectionReceivedCountBindings, createDb, schema } from "@quincy/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCapability } from "../middleware/capability";
import { newId } from "../lib/ids";

type DropboxOutcome = "removed" | "alreadyGone" | "claimLost" | "failed";

export function isRawClaimConflict(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (/UNIQUE constraint failed:\s*raw_reconciliation_claims\.project_id/i.test(cause.message)) return true;
  }
  return false;
}

function placeholders(count: number) { return Array.from({ length: count }, () => "?").join(", "); }

// A single-project claim slot means two Dropbox-sourced assets deleted in the same bulk action
// (each its own request) genuinely contend with each other, not just with an external sync — a
// bounded retry here lets the second one wait out the first's typically-fast delete rather than
// failing immediately. Retries only fire when the current holder is itself an asset_delete claim
// (a sibling in the same or a concurrent bulk action); a sync/AutoHDR-held claim fails fast, since
// that can legitimately hold the slot for its full lease duration and retrying quickly won't help.
const ASSET_DELETE_CLAIM_MAX_RETRIES = 5;
const ASSET_DELETE_CLAIM_RETRY_DELAY_MS = 150;

export const assetsRoutes = new Hono<AppEnv>();
assetsRoutes.use("/assets/:id", requireCapability("adminBackend"));

assetsRoutes.delete("/assets/:id", async (c) => {
  const primaryAssetId = c.req.param("id");
  if (!z.string().uuid().safeParse(primaryAssetId).success) return c.json({ error: "Invalid asset id" }, 400);
  const db = createDb(c.env.DB);
  const primary = await db.select({
    id: schema.assets.id,
    collectionId: schema.assets.collectionId,
    kind: schema.assets.kind,
    r2Key: schema.assets.r2Key,
    source: schema.assets.source,
    sourcePath: schema.assets.sourcePath,
    sourcePathKey: schema.assets.sourcePathKey,
    versionGroupId: schema.assets.versionGroupId,
    version: schema.assets.version,
    projectId: schema.collections.projectId,
  }).from(schema.assets).innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id))
    .where(eq(schema.assets.id, primaryAssetId)).get();
  if (!primary) return c.json({ error: "Asset not found" }, 404);

  // Excludes this route's own "asset_delete" kind: two Dropbox-sourced assets deleted in the same
  // bulk action would otherwise see each other's momentary job row here and self-block — that
  // contention is handled precisely, with a bounded retry, by the claim acquisition below instead.
  // This check exists for genuinely unrelated background work (a Dropbox sync, an AutoHDR job).
  const activeJobs = (await db.select({ count: sql<number>`count(*)` }).from(schema.jobs)
    .where(and(eq(schema.jobs.projectId, primary.projectId), inArray(schema.jobs.status, ["queued", "running"]), sql`${schema.jobs.kind} != 'asset_delete'`)).get())?.count ?? 0;
  if (activeJobs) return c.json({ error: "Background work is still running for this project — wait for it to finish and try again.", activeJobs }, 409);

  const targets = [primary];
  if ((primary.kind === "floorplan_pdf" || primary.kind === "floorplan_preview") && primary.versionGroupId) {
    const siblingKind = primary.kind === "floorplan_pdf" ? "floorplan_preview" : "floorplan_pdf";
    const sibling = await db.select({
      id: schema.assets.id,
      collectionId: schema.assets.collectionId,
      kind: schema.assets.kind,
      r2Key: schema.assets.r2Key,
      source: schema.assets.source,
      sourcePath: schema.assets.sourcePath,
      sourcePathKey: schema.assets.sourcePathKey,
      versionGroupId: schema.assets.versionGroupId,
      version: schema.assets.version,
      projectId: schema.collections.projectId,
    }).from(schema.assets).innerJoin(schema.collections, eq(schema.assets.collectionId, schema.collections.id)).where(and(
      eq(schema.assets.collectionId, primary.collectionId),
      eq(schema.assets.kind, siblingKind),
      eq(schema.assets.versionGroupId, primary.versionGroupId),
      eq(schema.assets.version, primary.version),
    )).get();
    if (sibling) targets.push(sibling);
  }

  const targetIds = targets.map((target) => target.id);
  const idMarks = placeholders(targetIds.length);
  const needsClaim = targets.some((target) => target.source === "dropbox" && target.sourcePath !== null && target.sourcePathKey !== null);
  let claimId: string | null = null;
  let deleteJobId: string | null = null;
  if (needsClaim) {
    deleteJobId = newId();
    await db.insert(schema.jobs).values({ kind: "asset_delete", id: deleteJobId, projectId: primary.projectId, correlationId: `asset_delete:${primaryAssetId}`, status: "queued" });
    claimId = newId();
    let acquired = false;
    for (let attempt = 0; !acquired; attempt += 1) {
      const now = new Date();
      await db.update(schema.rawReconciliationClaims).set({ state: "failed", updatedAt: now })
        .where(and(eq(schema.rawReconciliationClaims.projectId, primary.projectId), eq(schema.rawReconciliationClaims.state, "running"), sql`${schema.rawReconciliationClaims.leaseExpiresAt} < ${now.getTime()}`));
      try {
        await db.insert(schema.rawReconciliationClaims).values({
          id: claimId, projectId: primary.projectId, ownerJobId: deleteJobId, state: "running",
          leaseExpiresAt: new Date(now.getTime() + RAW_CLAIM_LEASE_MS), trigger: "asset_delete", createdAt: now, updatedAt: now,
        });
        acquired = true;
      } catch (error) {
        if (!isRawClaimConflict(error)) throw error;
        if (attempt < ASSET_DELETE_CLAIM_MAX_RETRIES) {
          const holder = await db.select({ trigger: schema.rawReconciliationClaims.trigger }).from(schema.rawReconciliationClaims)
            .where(and(eq(schema.rawReconciliationClaims.projectId, primary.projectId), eq(schema.rawReconciliationClaims.state, "running"))).get();
          if (holder?.trigger === "asset_delete") { await new Promise((resolve) => setTimeout(resolve, ASSET_DELETE_CLAIM_RETRY_DELAY_MS)); continue; }
        }
        await db.update(schema.jobs).set({ status: "failed", error: "Dropbox sync claim unavailable", updatedAt: new Date() }).where(eq(schema.jobs.id, deleteJobId));
        return c.json({ error: "Dropbox sync is active for this project — wait for it to finish and try again." }, 409);
      }
    }
  }

  const now = new Date();
  const nowMs = now.getTime();
  const targetCount = targetIds.length;
  const auditId = newId();
  const succeededIds = targetIds;
  let deletedObjects = 0;
  let succeeded = false;
  const dropboxOutcomes: DropboxOutcome[] = [];
  let lastDropboxOutcome: DropboxOutcome | null = null;
  let lastDropboxReason: string | undefined;
  const targetSql = `(${idMarks})`;
  const deleteParams = [...targetIds, ...targetIds, targetCount, ...targetIds, ...targetIds];

  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`DELETE FROM assets
        WHERE id IN ${targetSql}
          AND (SELECT count(*) FROM assets WHERE id IN ${targetSql}) = ?
          AND NOT EXISTS (SELECT 1 FROM premium_unlocks WHERE asset_id IN ${targetSql} AND scope = 'asset')
          AND NOT EXISTS (SELECT 1 FROM edited_source_claims WHERE current_asset_id IN ${targetSql})`)
        .bind(...deleteParams),
      c.env.DB.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
        SELECT ?, ?, 'asset.delete', 'asset', ?, ?, ? WHERE changes() > 0`)
        .bind(auditId, c.get("user").id, primaryAssetId, JSON.stringify({ projectId: primary.projectId, assetIds: targetIds, kinds: targets.map((target) => target.kind) }), nowMs),
      c.env.DB.prepare(`UPDATE assets SET
          supersedes_asset_id = CASE WHEN supersedes_asset_id IN ${targetSql} THEN NULL ELSE supersedes_asset_id END,
          replaced_by_asset_id = CASE WHEN replaced_by_asset_id IN ${targetSql} THEN NULL ELSE replaced_by_asset_id END,
          source_raw_asset_id = CASE WHEN source_raw_asset_id IN ${targetSql} THEN NULL ELSE source_raw_asset_id END,
          updated_at = ?
        WHERE (supersedes_asset_id IN ${targetSql} OR replaced_by_asset_id IN ${targetSql} OR source_raw_asset_id IN ${targetSql})
          AND NOT EXISTS (SELECT 1 FROM assets WHERE id IN ${targetSql})`)
        .bind(...targetIds, ...targetIds, ...targetIds, nowMs, ...targetIds, ...targetIds, ...targetIds, ...targetIds),
      c.env.DB.prepare(`UPDATE projects SET cover_asset_id = NULL, updated_at = ?
        WHERE id = ? AND cover_asset_id IN ${targetSql}
          AND NOT EXISTS (SELECT 1 FROM assets WHERE id IN ${targetSql})`)
        .bind(nowMs, primary.projectId, ...targetIds, ...targetIds),
      c.env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(primary.collectionId, nowMs)),
    ]);

    if ((results[0]?.meta.changes ?? 0) === 0) {
      const stillThere = await db.select({ id: schema.assets.id }).from(schema.assets).where(eq(schema.assets.id, primaryAssetId)).get();
      if (!stillThere) return c.json({ error: "Asset not found" }, 404);
      const currentTargetCount = (await db.select({ count: sql<number>`count(*)` }).from(schema.assets).where(inArray(schema.assets.id, targetIds)).get())?.count ?? 0;
      if (currentTargetCount !== targetCount) return c.json({ error: "The floorplan pair changed during deletion — retry the delete.", blocker: "floorplan_pair" }, 409);
      const premium = await db.select({ assetId: schema.premiumUnlocks.assetId }).from(schema.premiumUnlocks).where(and(inArray(schema.premiumUnlocks.assetId, targetIds), eq(schema.premiumUnlocks.scope, "asset"))).get();
      if (premium) return c.json({ error: "This asset is protected by a premium unlock.", blocker: "premium_unlock", assetId: premium.assetId }, 409);
      const editedClaim = await db.select({ assetId: schema.editedSourceClaims.currentAssetId }).from(schema.editedSourceClaims).where(inArray(schema.editedSourceClaims.currentAssetId, targetIds)).get();
      if (editedClaim) return c.json({ error: "This asset is the current edited source and cannot be deleted.", blocker: "edited_source_claim", assetId: editedClaim.assetId }, 409);
      return c.json({ error: "Asset deletion was blocked by a concurrent change — retry the delete." }, 409);
    }

    const keys: string[] = targets.map((target) => target.r2Key);
    for (const target of targets) {
      const prefix = `renditions/${target.id}/`;
      let cursor: string | undefined;
      while (true) {
        if (claimId && deleteJobId && !await c.env.BACKGROUND.renewDropboxDeletionClaim(claimId, deleteJobId)) {
          return c.json({ ok: false, error: "Dropbox sync claim was lost during cleanup — retry the delete", outcome: "claimLost" }, 409);
        }
        const page = await c.env.MEDIA.list({ prefix, ...(cursor ? { cursor } : {}) });
        keys.push(...page.objects.map((object) => object.key));
        if (!page.truncated) break;
        cursor = page.cursor;
      }
    }
    for (let index = 0; index < keys.length; index += 1000) {
      if (claimId && deleteJobId && !await c.env.BACKGROUND.renewDropboxDeletionClaim(claimId, deleteJobId)) {
        return c.json({ ok: false, error: "Dropbox sync claim was lost during cleanup — retry the delete", outcome: "claimLost" }, 409);
      }
      const batch = keys.slice(index, index + 1000);
      await c.env.MEDIA.delete(batch);
      deletedObjects += batch.length;
    }

    for (const target of targets) {
      if (target.source !== "dropbox" || target.sourcePath === null || target.sourcePathKey === null || !claimId || !deleteJobId) continue;
      const result = await c.env.BACKGROUND.deleteDropboxSourceFile(target.sourcePath, claimId, deleteJobId);
      dropboxOutcomes.push(result.outcome);
      lastDropboxOutcome = result.outcome;
      if (result.outcome === "failed") lastDropboxReason = result.reason;
      if (result.outcome === "claimLost") break;
    }
    const dropboxDeleted = dropboxOutcomes.every((outcome) => outcome === "removed" || outcome === "alreadyGone");
    succeeded = dropboxDeleted;
    return c.json({ ok: true, deletedAssetIds: succeededIds, deletedObjects, dropboxDeleted, ...(lastDropboxOutcome ? { dropboxOutcome: lastDropboxOutcome } : {}), ...(lastDropboxReason ? { dropboxReason: lastDropboxReason } : {}) });
  } finally {
    if (claimId && deleteJobId) {
      await db.update(schema.rawReconciliationClaims).set({ state: "done", updatedAt: new Date() })
        .where(and(eq(schema.rawReconciliationClaims.id, claimId), eq(schema.rawReconciliationClaims.ownerJobId, deleteJobId), eq(schema.rawReconciliationClaims.state, "running")));
      await db.update(schema.jobs).set({ status: succeeded ? "done" : "failed", updatedAt: new Date() }).where(eq(schema.jobs.id, deleteJobId));
    }
  }
});
