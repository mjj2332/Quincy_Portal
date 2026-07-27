import { WorkerEntrypoint } from "cloudflare:workers";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { assets, autoHdrFinalAssociations, autoHdrHandoffs, autoHdrOutputMappings, autoHdrPathClaims, collections, dropboxMonitorHealth, jobs, projects, renditionDlqEvents } from "@quincy/db/schema";
import { enqueueRenditionSafely, renditionsEnabled, type RenditionMessage } from "@quincy/shared";

import { DropboxSyncDO } from "./do/dropbox-sync";
import { TonomoProcessorDO } from "./do/tonomo-processor";
import type { Env } from "./env";
import { dbFor } from "./lib/db";
import { createJob, setJobStatus } from "./lib/jobs";
import type { IngestMessage } from "./messages";
import { generateRenditions } from "./renditions";
import { publishStatusAfterWorkflowCreateFailure } from "./manual-edited-renditions";
import { syncProjectRawFolder } from "./dropbox/sync";
import { fanOutDropboxKicks } from "./dropbox/webhook";
import { canMutateRenditionBackfill } from "./backfill-gate";
import { safeRenditionFailure } from "./rendition-diagnostics";
import { parseQueueBody, RENDITION_DLQ_QUEUE_NAME } from "./queue-dispatch";
import { AutoHdrSend } from "./workflows/autohdr";
import { AutoHdrFetch } from "./workflows/autohdr-fetch";
import { ManualEditedPublish } from "./workflows/manual-edited-publish";
import { canonicalDropboxConnectionId } from "./dropbox/connection";
import { dropboxPathKey, monitorName } from "./dropbox/paths";
import { claimAutoHdrFetch, claimAutoHdrHandoff, isWorkflowAlreadyExists, startClaimedFetch, type HandoffOwner } from "./autohdr/claims";
import { routeAutoHdrDelta, type RoutedAutoHdrMapping } from "./autohdr/mapping";
import { getMetadata, listFolderIfExists } from "./dropbox/client";
import { autoHdrFinalPathCandidates, deriveAutoHdrFolderName } from "./autohdr/paths";
import { reconcileAwaitingRawProjects } from "./reconcile-awaiting-raw";
import { backfillAutoHdrV2 as backfillAutoHdrV2Impl, type BackfillParams, type BackfillResult } from "./autohdr/backfill";
import { enqueueAutoHdrScaffold, ensureScaffold } from "./autohdr/scaffold";
import type { AutoHdrErrorCode, AutoHdrFetchResult, AutoHdrResult } from "./autohdr/errors";

export { AutoHdrFetch, AutoHdrSend, ManualEditedPublish, DropboxSyncDO, TonomoProcessorDO };

type DropboxSyncMessage = Extract<IngestMessage, { type: "dropbox_sync" }>;
const INGEST_QUEUE_MAX_ATTEMPTS = 4;
export type RenditionBackfillInput = { dryRun?: boolean; cursor?: string; limit?: number; confirmProduction?: boolean };
export type RenditionBackfillResult = { scanned: number; wouldEnqueue: number; enqueued: number; skipped: number; nextCursor: string | null; dryRun: boolean };

export default class QuincyBackground extends WorkerEntrypoint<Env> {
  async fetch(): Promise<Response> {
    return Response.json({ ok: true, service: "quincy-background" });
  }

  // Temporary safety net: retire only after Dropbox RAW automation has been verified live in a later deploy.
  async scheduled(controller: ScheduledController): Promise<void> {
    await reconcileAwaitingRawProjects(this.env.DB, controller.scheduledTime);
  }

  async triggerDropboxSync(projectId: string): Promise<{ jobId: string }> {
    const db = dbFor(this.env);
    const jobId = await createJob(db, {
      kind: "dropbox_sync",
      projectId,
      correlationId: `dropbox_sync:${projectId}`,
    });
    try {
      const message: DropboxSyncMessage = { type: "dropbox_sync", projectId, jobId, trigger: "manual_dropbox_sync" };
      await this.env.INGEST_QUEUE.send(message);
      return { jobId };
    } catch (error) {
      await setJobStatus(db, jobId, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async ensureAutoHdrScaffold(projectId: string): Promise<{ jobId: string }> {
    return enqueueAutoHdrScaffold(this.env, projectId);
  }

  async backfillAutoHdrV2(params: BackfillParams): Promise<BackfillResult> {
    return backfillAutoHdrV2Impl(this.env, params);
  }

  async startAutoHdr(projectId: string, initiatedBy?: string): Promise<AutoHdrResult> {
    if (!initiatedBy) {
      return {
        ok: false,
        code: "ERR_HANDOFF_BLOCKED",
        message: "AutoHDR handoff requires an initiating staff identity",
      };
    }
    const db = dbFor(this.env);
    let owner: HandoffOwner | undefined;
    try {
      owner = await claimAutoHdrHandoff(this.env, projectId, initiatedBy);
      const handoff = await db.select({
        assetIdsJson: autoHdrHandoffs.selectedAssetIdsJson,
        connectionId: autoHdrHandoffs.connectionId,
        generation: autoHdrHandoffs.generation,
        initiatedBy: autoHdrHandoffs.initiatedBy,
        state: autoHdrHandoffs.state,
      }).from(autoHdrHandoffs).where(eq(autoHdrHandoffs.id, owner.handoffId)).get();
      if (!handoff) {
        return {
          ok: false,
          code: "ERR_HANDOFF_DISAPPEARED",
          message: "Claimed AutoHDR handoff disappeared",
        };
      }
      if (!handoff.initiatedBy) {
        return {
          ok: false,
          code: "ERR_HANDOFF_BLOCKED",
          message: "The active AutoHDR handoff was auto-detected and cannot be used as an explicit send",
        };
      }
      if (handoff.state === "started") {
        return {
          ok: true,
          jobId: owner.jobId,
          handoffId: owner.handoffId,
          workflowId: owner.workflowId,
        };
      }
      if (handoff.state === "blocked") throw new Error("AutoHDR handoff is blocked for staff resolution");
      await this.env.AUTOHDR_WORKFLOW.create({
        id: owner.workflowId,
        params: {
          projectId,
          assetIds: JSON.parse(handoff.assetIdsJson) as string[],
          jobId: owner.jobId,
          handoffId: owner.handoffId,
          connectionId: handoff.connectionId,
          mappingGeneration: handoff.generation,
          initiatedBy: handoff.initiatedBy,
        },
      });
      return {
        ok: true,
        jobId: owner.jobId,
        handoffId: owner.handoffId,
        workflowId: owner.workflowId,
      };
    } catch (error) {
      if (isWorkflowAlreadyExists(error) && owner) {
        const existing = await db.select({
          initiatedBy: autoHdrHandoffs.initiatedBy,
          state: autoHdrHandoffs.state,
        }).from(autoHdrHandoffs).where(and(
          eq(autoHdrHandoffs.id, owner.handoffId),
          inArray(autoHdrHandoffs.state, ["starting", "started"]),
        )).get();
        if (existing?.initiatedBy) {
          return {
            ok: true,
            jobId: owner.jobId,
            handoffId: owner.handoffId,
            workflowId: owner.workflowId,
          };
        }
      }
      if (owner) {
        await setJobStatus(
          db,
          owner.jobId,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      const code: AutoHdrErrorCode = /archived/i.test(message)
        ? "ERR_PROJECT_ARCHIVED"
        : /no raw assets|no raw selection|selected for editing/i.test(message)
          ? "ERR_NO_RAW_SELECTION"
          : /collision|mapping/i.test(message)
            ? "ERR_MAPPING_BLOCKED"
            : /blocked/i.test(message)
              ? "ERR_HANDOFF_BLOCKED"
              : "ERR_HANDOFF_DISAPPEARED";
      return { ok: false, code, message };
    }
  }

  async fetchEditedFromAutoHdr(projectId: string): Promise<AutoHdrFetchResult> {
    const db = dbFor(this.env);
    const mapping = await db.select({
      mappingId: autoHdrOutputMappings.id,
      projectId: autoHdrOutputMappings.projectId,
      handoffId: autoHdrOutputMappings.handoffId,
      generation: autoHdrOutputMappings.generation,
      connectionId: autoHdrOutputMappings.connectionId,
      state: autoHdrOutputMappings.state,
      finalPath: autoHdrOutputMappings.finalPath,
      finalPathKey: autoHdrOutputMappings.finalPathKey,
      handoffState: autoHdrHandoffs.state,
    }).from(autoHdrOutputMappings)
      .innerJoin(autoHdrHandoffs, eq(autoHdrOutputMappings.handoffId, autoHdrHandoffs.id))
      .where(and(
        eq(autoHdrOutputMappings.projectId, projectId),
        inArray(autoHdrHandoffs.state, ["started", "blocked"]),
      ))
      .get();
    if (!mapping) {
      return {
        ok: false,
        code: "ERR_FOLDER_NOT_READY",
        message: "No active AutoHDR handoff mapping exists for this project",
      };
    }
    if (mapping.state === "blocked_collision" || mapping.handoffState === "blocked") {
      return {
        ok: false,
        code: "ERR_MAPPING_BLOCKED",
        message: "AutoHDR output mapping is blocked for staff resolution",
      };
    }
    let route: RoutedAutoHdrMapping | undefined;
    if (mapping.state === "active" && mapping.finalPath && mapping.finalPathKey) {
      route = {
        projectId: mapping.projectId,
        handoffId: mapping.handoffId,
        mappingId: mapping.mappingId,
        generation: mapping.generation,
        connectionId: mapping.connectionId,
        finalPath: mapping.finalPath,
        finalPathKey: mapping.finalPathKey,
        representativeChangedPath: mapping.finalPath,
      };
    } else if (mapping.state === "pending_discovery") {
      const claims = await db.select({ path: autoHdrPathClaims.path, pathKey: autoHdrPathClaims.pathKey })
        .from(autoHdrPathClaims).where(eq(autoHdrPathClaims.mappingId, mapping.mappingId));
      const observed = [];
      for (const claim of claims) {
        const page = await listFolderIfExists(this.env, db, claim.path, {}, mapping.connectionId);
        if (page) observed.push({
          ".tag": "folder" as const,
          id: `manual:${claim.pathKey}`,
          name: claim.path.split("/").at(-1)!,
          path_lower: claim.pathKey,
          path_display: claim.path,
        });
      }
      route = (await routeAutoHdrDelta(db, mapping.connectionId, observed)).routes[0];
    }
    if (!route) {
      return {
        ok: false,
        code: "ERR_FOLDER_NOT_READY",
        message: "AutoHDR final folder is not ready",
      };
    }
    try {
      const owner = await claimAutoHdrFetch(this.env, route, {
        trigger: "manual",
        representativeChangedPath: route.finalPath,
      });
      await startClaimedFetch(this.env, owner);
      return { ok: true, jobId: owner.jobId, fetchClaimId: owner.claimId };
    } catch (error) {
      return {
        ok: false,
        code: "ERR_FETCH_CLAIM_FAILED",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async publishManualUpload(projectId: string, assetId: string): Promise<{ jobId: string }> {
    const db = dbFor(this.env);
    const asset = await db.select({
      id: assets.id,
      collectionKind: collections.kind,
      sourcePath: assets.sourcePath,
      publishStatus: assets.publishStatus,
      archivedAt: projects.archivedAt,
    })
      .from(assets)
      .innerJoin(collections, eq(assets.collectionId, collections.id))
      .innerJoin(projects, eq(collections.projectId, projects.id))
      .where(and(eq(assets.id, assetId), eq(collections.projectId, projectId), inArray(collections.kind, ["raw", "edited"]), eq(assets.source, "upload"))).get();
    if (!asset) throw new Error("Manual upload is not available for Dropbox publishing");
    // The service can be called after the app's archive check, so it must independently close
    // that race before creating a new background writer.
    if (asset.archivedAt) throw new Error(`Project ${projectId} is archived — manual publish refused`);
    const isEdited = asset.collectionKind === "edited";
    const jobKind = isEdited ? "manual_edited_publish" : "manual_raw_publish";
    const correlationId = `${jobKind}:${assetId}`;
    if ((isEdited && asset.publishStatus === "ready") || (!isEdited && asset.sourcePath)) {
      // A ready manual asset can only re-enter this workflow after its durable Dropbox
      // write succeeded but the final handoff/job checkpoint failed. The replay skips the
      // idempotent provider write; ordinary completed assets stay immutable.
      const failedHandoff = await db.select({ id: jobs.id }).from(jobs).where(and(
        eq(jobs.projectId, projectId), eq(jobs.kind, jobKind),
        eq(jobs.correlationId, correlationId), inArray(jobs.status, ["failed", "stuck"]),
      )).get();
      if (!failedHandoff) throw new Error(isEdited ? "Manual edited upload is already published" : "Manual RAW upload is already mirrored");
    }
    const active = await db.select({ id: jobs.id }).from(jobs).where(and(
      eq(jobs.projectId, projectId), eq(jobs.kind, jobKind), inArray(jobs.status, ["queued", "running"]),
      eq(jobs.correlationId, correlationId),
    )).get();
    if (active) return { jobId: active.id };
    const statusAfterWorkflowCreateFailure = isEdited
      ? publishStatusAfterWorkflowCreateFailure(asset.publishStatus)
      : "ready";
    // A failed publication retry must return the asset to the only state the workflow can
    // promote. A ready asset is a post-publication rendition-handoff retry and remains visible.
    if (isEdited && asset.publishStatus !== "ready") await db.update(assets).set({ publishStatus: "pending", updatedAt: new Date() }).where(eq(assets.id, assetId));
    let jobId: string;
    try {
      jobId = await createJob(db, { kind: jobKind, projectId, payload: { projectId, assetId, collection: asset.collectionKind }, correlationId });
    } catch (error) {
      // The partial unique index is the single-flight authority. A second caller can race the
      // preflight above, so return the winner rather than report a false publication failure.
      const uniqueConflict = (() => {
        for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
          if (/UNIQUE constraint failed:\s*jobs\.correlation_id/i.test(cause.message)) return true;
        }
        return false;
      })();
      if (uniqueConflict) {
        const winner = await db.select({ id: jobs.id }).from(jobs).where(and(
          eq(jobs.projectId, projectId), eq(jobs.kind, jobKind), inArray(jobs.status, ["queued", "running"]),
          eq(jobs.correlationId, correlationId),
        )).get();
        if (winner) return { jobId: winner.id };
      }
      throw error;
    }
    try {
      await this.env.MANUAL_EDITED_PUBLISH_WORKFLOW.create({ id: jobId, params: { projectId, assetId, jobId } });
      return { jobId };
    } catch (error) {
      await setJobStatus(db, jobId, "failed", error instanceof Error ? error.message : String(error));
      // A publication-start failure only hides an asset that has not reached Dropbox yet. A
      // ready retry is repairing a rendition handoff, so preserve its visible publication state.
      if (statusAfterWorkflowCreateFailure === "failed") await db.update(assets).set({ publishStatus: "failed", updatedAt: new Date() }).where(and(
        eq(assets.id, assetId),
        eq(assets.publishStatus, "pending"),
      ));
      throw error;
    }
  }

  /** Backward-compatible service method for already-deployed app Workers during ordered rollout. */
  async publishManualEditedUpload(projectId: string, assetId: string): Promise<{ jobId: string }> {
    return this.publishManualUpload(projectId, assetId);
  }

  /** One account notification wakes both independent root-specific objects. */
  async handleDropboxWebhook(): Promise<void> {
    const db = dbFor(this.env);
    const connectionId = await canonicalDropboxConnectionId(db);
    await fanOutDropboxKicks(
      [monitorName(connectionId, "raw"), monitorName(connectionId, "autohdr")],
      async (name) => {
      const stub = this.env.DROPBOX_SYNC.getByName(name);
      await stub.kick();
      },
    );
  }

  async inspectDropboxMonitor(scope: "raw" | "autohdr"): Promise<Record<string, unknown>> {
    const db = dbFor(this.env);
    const connectionId = await canonicalDropboxConnectionId(db);
    const durable = await this.env.DROPBOX_SYNC.getByName(monitorName(connectionId, scope)).inspect();
    const health = await db.query.dropboxMonitorHealth.findFirst({
      where: (table, operators) => operators.and(
        operators.eq(table.connectionId, connectionId),
        operators.eq(table.scope, scope),
      ),
    });
    const mappingRows = scope === "autohdr"
      ? await db.select({
        id: autoHdrOutputMappings.id,
        projectId: autoHdrOutputMappings.projectId,
        state: autoHdrOutputMappings.state,
        generation: autoHdrOutputMappings.generation,
        diagnostic: autoHdrOutputMappings.diagnostic,
        handoffId: autoHdrHandoffs.id,
        handoffState: autoHdrHandoffs.state,
        handoffError: autoHdrHandoffs.lastError,
        readinessUnitsJson: autoHdrHandoffs.readinessUnitsJson,
        jobId: jobs.id,
        jobStatus: jobs.status,
        jobError: jobs.error,
      }).from(autoHdrOutputMappings)
        .innerJoin(autoHdrHandoffs, eq(autoHdrOutputMappings.handoffId, autoHdrHandoffs.id))
        .innerJoin(jobs, eq(autoHdrHandoffs.jobId, jobs.id))
        .where(inArray(autoHdrOutputMappings.state, ["pending_discovery", "active", "blocked_collision"]))
        .limit(100)
      : [];
    const mappings = await Promise.all(mappingRows.map(async (mapping) => {
      const units = JSON.parse(mapping.readinessUnitsJson) as { key: string }[];
      const { readinessUnitsJson: _readinessUnitsJson, ...diagnostic } = mapping;
      const covered = await db.select({ key: autoHdrFinalAssociations.readinessUnitKey })
        .from(autoHdrFinalAssociations)
        .innerJoin(assets, and(
          eq(autoHdrFinalAssociations.assetId, assets.id),
          sql`${assets.supersededAt} IS NULL`,
        ))
        .where(eq(autoHdrFinalAssociations.handoffId, mapping.handoffId));
      const coveredKeys = new Set(covered.map((row) => row.key));
      return {
        ...diagnostic,
        readiness: {
          covered: coveredKeys.size,
          total: units.length,
          missing: units.filter((unit) => !coveredKeys.has(unit.key)).map((unit) => unit.key),
        },
      };
    }));
    return {
      durable,
      health: health ? {
        ...health,
        cursorAgeMs: health.cursorUpdatedAt ? Math.max(0, Date.now() - health.cursorUpdatedAt.getTime()) : null,
      } : null,
      mappings,
    };
  }

  async resetDropboxMonitor(scope: "raw" | "autohdr"): Promise<Record<string, unknown>> {
    const connectionId = await canonicalDropboxConnectionId(dbFor(this.env));
    const stub = this.env.DROPBOX_SYNC.getByName(monitorName(connectionId, scope));
    await stub.resetCursor();
    return stub.inspect();
  }

  async resolveAutoHdrMapping(mappingId: string, chosenPathKey: string, verifiedFolderId: string, actorId: string): Promise<Record<string, unknown>> {
    const db = dbFor(this.env);
    const claim = await db.select({
      id: autoHdrPathClaims.id,
      path: autoHdrPathClaims.path,
      pathKey: autoHdrPathClaims.pathKey,
      connectionId: autoHdrPathClaims.connectionId,
      mappingId: autoHdrPathClaims.mappingId,
    }).from(autoHdrPathClaims)
      .innerJoin(autoHdrOutputMappings, eq(autoHdrPathClaims.mappingId, autoHdrOutputMappings.id))
      .where(and(
        eq(autoHdrPathClaims.mappingId, mappingId),
        eq(autoHdrPathClaims.pathKey, chosenPathKey),
        eq(autoHdrOutputMappings.state, "blocked_collision"),
      )).get();
    if (!claim) throw new Error("Blocked AutoHDR mapping candidate was not found");
    const metadata = await getMetadata(this.env, db, claim.path, claim.connectionId);
    if (metadata[".tag"] !== "folder" || metadata.id !== verifiedFolderId) {
      throw new Error("Dropbox folder ownership verification failed");
    }
    const now = new Date();
    const results = await this.env.DB.batch([
      this.env.DB.prepare("UPDATE autohdr_output_mappings SET state = 'active', final_path = ?, final_path_key = ?, folder_id = ?, diagnostic = NULL, observed_at = ?, updated_at = ? WHERE id = ? AND state = 'blocked_collision'")
        .bind(claim.path, claim.pathKey, metadata.id, now.getTime(), now.getTime(), mappingId),
      this.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'integration.autohdr_mapping.resolve', 'autohdr_mapping', ?, ?, ? WHERE changes() = 1")
        .bind(crypto.randomUUID(), actorId, mappingId, JSON.stringify({ chosenPathKey: claim.pathKey, verifiedFolderId: metadata.id }), now.getTime()),
      this.env.DB.prepare("UPDATE autohdr_path_claims SET state = CASE WHEN id = ? THEN 'active' ELSE 'tombstone' END, folder_id = CASE WHEN id = ? THEN ? ELSE folder_id END, diagnostic = NULL, updated_at = ? WHERE mapping_id = ? AND EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ? AND state = 'active' AND final_path_key = ?)")
        .bind(claim.id, claim.id, metadata.id, now.getTime(), mappingId, mappingId, claim.pathKey),
      this.env.DB.prepare("UPDATE autohdr_handoffs SET state = 'started', last_error = NULL, updated_at = ? WHERE id = (SELECT handoff_id FROM autohdr_output_mappings WHERE id = ? AND state = 'active' AND final_path_key = ?) AND state = 'blocked'")
        .bind(now.getTime(), mappingId, claim.pathKey),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      const winner = await db.select({ state: autoHdrOutputMappings.state, finalPathKey: autoHdrOutputMappings.finalPathKey })
        .from(autoHdrOutputMappings).where(eq(autoHdrOutputMappings.id, mappingId)).get();
      if (winner?.state !== "active" || winner.finalPathKey !== claim.pathKey) {
        throw new Error("AutoHDR mapping resolution lost a concurrent ownership race");
      }
    }
    return { mappingId, finalPath: claim.path, finalPathKey: claim.pathKey, folderId: metadata.id, state: "active" };
  }

  async reassignAutoHdrPathClaim(pathKey: string, targetMappingId: string, verifiedFolderId: string, actorId: string): Promise<Record<string, unknown>> {
    const db = dbFor(this.env);
    const target = await db.select({
      mappingId: autoHdrOutputMappings.id,
      projectId: autoHdrOutputMappings.projectId,
      handoffId: autoHdrOutputMappings.handoffId,
      connectionId: autoHdrOutputMappings.connectionId,
      rawFolderPath: autoHdrHandoffs.frozenRawFolderPath,
      jobId: autoHdrHandoffs.jobId,
    }).from(autoHdrOutputMappings)
      .innerJoin(autoHdrHandoffs, eq(autoHdrOutputMappings.handoffId, autoHdrHandoffs.id))
      .where(and(eq(autoHdrOutputMappings.id, targetMappingId), eq(autoHdrOutputMappings.state, "blocked_collision"))).get();
    if (!target) throw new Error("Target AutoHDR mapping is not blocked for reassignment");
    const source = await db.select({
      claimId: autoHdrPathClaims.id,
      sourceMappingId: autoHdrPathClaims.mappingId,
      path: autoHdrPathClaims.path,
      pathKey: autoHdrPathClaims.pathKey,
      connectionId: autoHdrPathClaims.connectionId,
      sourceState: autoHdrPathClaims.state,
    }).from(autoHdrPathClaims).where(and(
      eq(autoHdrPathClaims.connectionId, target.connectionId),
      eq(autoHdrPathClaims.pathKey, pathKey),
    )).get();
    if (!source || !["tombstone", "blocked"].includes(source.sourceState)) {
      throw new Error("Path claim is not eligible for explicit reassignment");
    }
    const metadata = await getMetadata(this.env, db, source.path, source.connectionId);
    if (metadata[".tag"] !== "folder" || metadata.id !== verifiedFolderId) throw new Error("Dropbox folder ownership verification failed");
    const candidates = autoHdrFinalPathCandidates(deriveAutoHdrFolderName(target.rawFolderPath));
    if (!candidates.map(dropboxPathKey).includes(source.pathKey)) throw new Error("Claim path is not one of the target handoff's frozen candidates");
    const siblingPath = candidates.find((candidate) => dropboxPathKey(candidate) !== source.pathKey)!;
    const siblingCollision = await db.select({ id: autoHdrPathClaims.id }).from(autoHdrPathClaims)
      .where(and(eq(autoHdrPathClaims.connectionId, target.connectionId), eq(autoHdrPathClaims.pathKey, dropboxPathKey(siblingPath)))).get();
    if (siblingCollision) throw new Error("The target handoff's sibling candidate also has a permanent owner");
    const now = Date.now();
    const results = await this.env.DB.batch([
      this.env.DB.prepare("UPDATE autohdr_path_claims SET mapping_id = ?, handoff_id = ?, project_id = ?, state = 'active', folder_id = ?, diagnostic = NULL, updated_at = ? WHERE id = ? AND state in ('tombstone','blocked') AND EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ? AND state = 'blocked_collision')")
        .bind(target.mappingId, target.handoffId, target.projectId, metadata.id, now, source.claimId, target.mappingId),
      this.env.DB.prepare("INSERT INTO autohdr_path_claims (id, mapping_id, handoff_id, project_id, connection_id, candidate, path, path_key, state, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ? WHERE changes() = 1")
        .bind(crypto.randomUUID(), target.mappingId, target.handoffId, target.projectId, target.connectionId, siblingPath.includes("/04-FINALS-") ? "finals" : "final", siblingPath, dropboxPathKey(siblingPath), now, now),
      this.env.DB.prepare("UPDATE autohdr_output_mappings SET state = 'active', final_path = ?, final_path_key = ?, folder_id = ?, diagnostic = NULL, observed_at = ?, updated_at = ? WHERE id = ? AND state = 'blocked_collision' AND EXISTS (SELECT 1 FROM autohdr_path_claims WHERE id = ? AND mapping_id = ? AND state = 'active')")
        .bind(source.path, source.pathKey, metadata.id, now, now, target.mappingId, source.claimId, target.mappingId),
      this.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, ?, 'integration.autohdr_path_claim.reassign', 'autohdr_mapping', ?, ?, ? WHERE changes() = 1")
        .bind(crypto.randomUUID(), actorId, target.mappingId, JSON.stringify({ pathKey: source.pathKey, sourceMappingId: source.sourceMappingId, verifiedFolderId: metadata.id }), now),
      this.env.DB.prepare("UPDATE autohdr_handoffs SET state = 'starting', last_error = NULL, updated_at = ? WHERE id = ? AND state = 'blocked' AND EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ? AND state = 'active' AND final_path_key = ?)")
        .bind(now, target.handoffId, target.mappingId, source.pathKey),
      this.env.DB.prepare("UPDATE jobs SET status = 'queued', error = NULL, updated_at = ? WHERE id = ? AND status = 'failed' AND EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ? AND state = 'active' AND final_path_key = ?)")
        .bind(now, target.jobId, target.mappingId, source.pathKey),
    ]);
    if ((results[2]?.meta.changes ?? 0) !== 1) {
      throw new Error("AutoHDR path reassignment lost a concurrent ownership race");
    }
    return { sourceMappingId: source.sourceMappingId, targetMappingId, path: source.path, pathKey: source.pathKey, folderId: metadata.id };
  }

  async processTonomoEvents(): Promise<void> {
    const id = this.env.TONOMO_PROCESSOR.idFromName("tonomo");
    await this.env.TONOMO_PROCESSOR.get(id).drain();
  }

  /** Operator-only, bounded page. It never runs on deploy and requires a deliberate prod flag. */
  async backfillRenditions(input: RenditionBackfillInput = {}): Promise<RenditionBackfillResult> {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Rendition backfill limit must be an integer from 1 to 100");
    if (!input.dryRun) { const refusal = canMutateRenditionBackfill(this.env, input); if (refusal) throw new Error(refusal); }
    const db = dbFor(this.env);
    const rows = await db.select({ id: assets.id })
      .from(assets)
      .where(input.cursor ? and(eq(assets.kind, "photo"), gt(assets.id, input.cursor)) : eq(assets.kind, "photo"))
      .orderBy(assets.id).limit(limit).all();
    let enqueued = 0;
    for (const row of rows) {
      // D1 rows alone cannot prove the rendition bytes exist in R2. Every candidate reaches
      // the idempotent generator, which heads current objects before it does any transform.
      if (!input.dryRun && await enqueueRenditionSafely(this.env, row.id, "operator-backfill")) enqueued += 1;
    }
    return { scanned: rows.length, wouldEnqueue: rows.length, enqueued, skipped: 0, nextCursor: rows.length === limit ? rows.at(-1)!.id : null, dryRun: input.dryRun === true };
  }

  async queue(batch: MessageBatch<IngestMessage | RenditionMessage>): Promise<void> {
    if (batch.queue === RENDITION_DLQ_QUEUE_NAME) {
      // Messages here already exhausted max_retries on quincy-renditions. Record the backlog so
      // it's operator-visible, then ack — retrying here just burns attempts before the root
      // cause (e.g. a secret drift) has actually been fixed.
      const db = dbFor(this.env);
      for (const message of batch.messages) {
        const parsed = parseQueueBody(batch.queue, message.body);
        // A malformed body should be unreachable (the only producer of quincy-renditions-dlq is
        // Cloudflare re-delivering an already-validated quincy-renditions body), but "should be
        // unreachable" describes the exact gap that caused this incident. Record it anyway with
        // a best-effort asset id rather than silently dropping it — an unrecorded arrival here
        // reproduces the same invisible-backlog failure this consumer exists to catch.
        const rawBody = message.body;
        const fallbackAssetId = rawBody && typeof rawBody === "object" && typeof (rawBody as { assetId?: unknown }).assetId === "string"
          ? (rawBody as { assetId: string }).assetId
          : "unparseable-dlq-body";
        const assetId = parsed && parsed.body.type === "generate_renditions" ? parsed.body.assetId : fallbackAssetId;
        if (!parsed || parsed.body.type !== "generate_renditions") {
          console.error("Rendition DLQ message has an unrecognized body", { queue: batch.queue, assetId });
        }
        await db.insert(renditionDlqEvents).values({
          id: crypto.randomUUID(),
          assetId,
          status: "open",
          receivedAt: new Date(),
        });
        message.ack();
      }
      return;
    }
    for (const message of batch.messages) {
      try {
        const parsed = parseQueueBody(batch.queue, message.body);
        if (!parsed) throw new Error(`Invalid queue body for ${batch.queue}`);
        switch (parsed.body.type) {
          case "asset_ingested":
            // Kept for historic messages only. New writers enqueue the dedicated contract.
            message.ack();
            break;
          case "generate_renditions":
            // Do not acknowledge work while the red gate is closed: explicit retries reach the
            // configured DLQ instead of silently producing bytes outside max_concurrency=1.
            if (!renditionsEnabled(this.env)) throw new Error("Rendition consumer is disabled");
            await generateRenditions(this.env, parsed.body.assetId);
            message.ack();
            break;
          case "dropbox_sync":
            await syncProjectRawFolder(
              this.env,
              parsed.body.projectId,
              (parsed.body as DropboxSyncMessage).jobId,
              (parsed.body as DropboxSyncMessage).connectionId,
              (parsed.body as DropboxSyncMessage).trigger ?? "queue_retry",
            );
            message.ack();
            break;
          case "autohdr_scaffold":
            try {
              await ensureScaffold(
                this.env,
                parsed.body.jobId,
                parsed.body.projectId,
              );
              message.ack();
            } catch (error) {
              if (message.attempts >= INGEST_QUEUE_MAX_ATTEMPTS) {
                await setJobStatus(
                  dbFor(this.env),
                  parsed.body.jobId,
                  "failed",
                  error instanceof Error ? error.message : String(error),
                );
                message.ack();
              } else {
                throw error;
              }
            }
            break;
          case "autohdr_check":
            // Reserved for the future on-demand return-file fetch flow.
            message.ack();
            break;
        }
      } catch (error) {
        const body = message.body;
        const renditionFailure = batch.queue === "quincy-renditions" && body && typeof body === "object" && (body as { type?: unknown }).type === "generate_renditions"
          ? safeRenditionFailure(error)
          : undefined;
        console.error("Background queue message failed", {
          queue: batch.queue,
          type: body && typeof body === "object" ? (body as { type?: unknown }).type : "invalid",
          assetId: body && typeof body === "object" && typeof (body as { assetId?: unknown }).assetId === "string" ? (body as { assetId: string }).assetId : undefined,
          renditionFailure,
        });
        message.retry();
      }
    }
  }
}
