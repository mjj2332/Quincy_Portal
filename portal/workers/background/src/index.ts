import { WorkerEntrypoint } from "cloudflare:workers";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { boardSchemaVariant } from "@quincy/db";
import { assets, autoHdrFinalAssociations, autoHdrHandoffs, autoHdrOutputMappings, autoHdrPathClaims, collections, dropboxMonitorHealth, editorFolderMappings, jobs, projects, renditionDlqEvents } from "@quincy/db/schema";
import { enqueueRenditionSafely, renditionsEnabled, type RenditionMessage } from "@quincy/shared";

import { DropboxSyncDO } from "./do/dropbox-sync";
import { TonomoProcessorDO } from "./do/tonomo-processor";
import type { Env } from "./env";
import { dbFor } from "./lib/db";
import { createJob, setJobStatus } from "./lib/jobs";
import type { DropboxSyncMessage, IngestMessage } from "./messages";
import { generateRenditions } from "./renditions";
import { publishStatusAfterWorkflowCreateFailure } from "./manual-edited-renditions";
import { deleteBatch, deleteBatchCheck, isDropboxPathNotFound, type DropboxDeleteBatchCheckResult, type DropboxDeleteBatchResult } from "./dropbox/client";
import { renewRawReconciliationClaim, syncProjectRawFolder } from "./dropbox/sync";
import { fanOutDropboxKicks } from "./dropbox/webhook";
import { canMutateRenditionBackfill } from "./backfill-gate";
import { safeRenditionFailure } from "./rendition-diagnostics";
import { NOTIFICATION_DLQ_QUEUE_NAME, NOTIFICATION_QUEUE_NAME } from "@quincy/shared";
import { parseQueueBody, RENDITION_DLQ_QUEUE_NAME } from "./queue-dispatch";
import { AutoHdrSend } from "./workflows/autohdr";
import { AutoHdrApiSend } from "./workflows/autohdr-api-send";
import { AutoHdrFetch } from "./workflows/autohdr-fetch";
import { ManualEditedPublish } from "./workflows/manual-edited-publish";
import { canonicalDropboxConnectionId } from "./dropbox/connection";
import { enqueueEditorReconcile, handleEditorReconcileMessage } from "./editor-folders/queue";
import { syncProjectEditorOutput } from "./editor-folders/sync-output";
import { automationFlag } from "./dropbox/monitor-state";
import { previewEditorBackfill, applyEditorCandidate, inspectEditorCandidate, type ReviewedEditorCandidate } from "./editor-folders/backfill";
import { dropboxPathKey, monitorName } from "./dropbox/paths";
import { claimAutoHdrFetch, claimAutoHdrHandoff, isWorkflowAlreadyExists, startClaimedFetch, type HandoffOwner } from "./autohdr/claims";
import { routeAutoHdrDelta, type RoutedAutoHdrMapping } from "./autohdr/mapping";
import { getMetadata, listFolderIfExists } from "./dropbox/client";
import { autoHdrFinalPathCandidates, deriveAutoHdrFolderName } from "./autohdr/paths";
import { reconcileAwaitingRawProjects } from "./reconcile-awaiting-raw";
import { backfillAutoHdrV2 as backfillAutoHdrV2Impl, type BackfillParams, type BackfillResult } from "./autohdr/backfill";
import { enqueueAutoHdrScaffold, ensureScaffold } from "./autohdr/scaffold";
import { AutoHdrClaimError } from "./autohdr/errors";
import { claimAutoHdrApiSend } from "./autohdr/api-send";
import type { AutoHdrApiSendResult } from "./autohdr/api-send";
import type { AutoHdrErrorCode, AutoHdrFetchResult, AutoHdrResult } from "./autohdr/errors";
import { notifyProject, pruneNotifications, scanDueSubtasks, scanStalledAutoHdr } from "./notifications";
import { processNotificationDlqMessage, processNotificationMessage, recoverNotificationOutbox } from "./notification-delivery";
import { scanProjectDeadlineOccurrences } from "./project-deadline";
import { sweepExternalEditedUploads } from "./external-upload-sweep";
import { processExternalRoleCachePurges } from "./external-role-cache-purge";
import { isBoardSchemaMaintenanceError, requireBoardSchemaReady } from "./lib/board-schema";

export { AutoHdrApiSend, AutoHdrFetch, AutoHdrSend, ManualEditedPublish, DropboxSyncDO, TonomoProcessorDO };

const INGEST_QUEUE_MAX_ATTEMPTS = 4;
export type RenditionBackfillInput = { dryRun?: boolean; cursor?: string; limit?: number; confirmProduction?: boolean };
export type RenditionBackfillResult = { scanned: number; wouldEnqueue: number; enqueued: number; skipped: number; nextCursor: string | null; dryRun: boolean };

export default class QuincyBackground extends WorkerEntrypoint<Env> {
  async fetch(): Promise<Response> {
    return Response.json({ ok: true, service: "quincy-background" });
  }

  // Temporary safety net: retire only after Dropbox RAW automation has been verified live in a later deploy.
  async scheduled(controller: ScheduledController): Promise<void> {
    // Warm the isolate-local variant memo before any scheduled handler can touch D1.
    if (this.env.DB) await boardSchemaVariant(this.env.DB);
    if (controller.cron === "* * * * *") {
      if (automationFlag(this.env.DROPBOX_EDITOR_AUTOMATION_ENABLED)) {
        try {
          const pending = await dbFor(this.env).select({ projectId: editorFolderMappings.projectId }).from(editorFolderMappings)
            .innerJoin(projects, eq(projects.id, editorFolderMappings.projectId))
            .where(sql`${editorFolderMappings.state} = 'ready' AND ${editorFolderMappings.initialSyncCompletedAt} IS NULL AND ${projects.archivedAt} IS NULL
              AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.project_id = editor_folder_mappings.project_id AND j.kind = 'editor_sync' AND j.status IN ('queued','running') AND j.updated_at > ${controller.scheduledTime - 20 * 60_000})`)
            .orderBy(editorFolderMappings.updatedAt).limit(25);
          for (const row of pending) {
            await this.triggerEditorSync(row.projectId);
            // Rotate attempted mappings behind unattempted ones; one permanently bad folder
            // must not monopolize every bounded recovery page.
            await dbFor(this.env).update(editorFolderMappings).set({ updatedAt: new Date(controller.scheduledTime) })
              .where(and(eq(editorFolderMappings.projectId, row.projectId), eq(editorFolderMappings.state, "ready")));
          }
        } catch (error) {
          console.error("Editor initial sync recovery failed", { error: error instanceof Error ? error.message : String(error) });
        }
      }
      try {
        const result = await scanProjectDeadlineOccurrences(this.env, controller.scheduledTime);
        console.log("Project Deadline occurrence scan", result);
      } catch (error) {
        console.error("Project Deadline occurrence scan failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      }
      try {
        const recovered = await recoverNotificationOutbox(this.env, controller.scheduledTime);
        console.log("Notification outbox recovery scan", { recovered });
      } catch (error) {
        console.error("Notification outbox recovery scan failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      }
      try {
        const swept = await sweepExternalEditedUploads(this.env, controller.scheduledTime);
        console.log("External upload sweep", swept);
      } catch (error) {
        console.error("External upload sweep failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      }
      try {
        const purged = await processExternalRoleCachePurges(this.env, controller.scheduledTime);
        if (purged) console.log("External role cache purge jobs", { purged });
      } catch (error) {
        console.error("External role cache purge failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
      }
      return;
    }
    if (controller.cron !== "0 * * * *") {
      console.warn("Ignored unknown Cron trigger", { cron: controller.cron });
      return;
    }
    if (automationFlag(this.env.DROPBOX_EDITOR_AUTOMATION_ENABLED)) {
      try {
        const db = dbFor(this.env);
        // Rotating bounded pages recover missed prerequisite triggers without flooding Dropbox.
        const candidates = await db.select({ id: projects.id }).from(projects)
          .where(sql`${projects.archivedAt} IS NULL AND ${projects.stageKey} != 'delivered'`).orderBy(projects.id);
        const pageCount = Math.max(1, Math.ceil(candidates.length / 25));
        const offset = (Math.floor(controller.scheduledTime / 3_600_000) % pageCount) * 25;
        for (const candidate of candidates.slice(offset, offset + 25)) await enqueueEditorReconcile(this.env, candidate.id);
        const connectionId = await canonicalDropboxConnectionId(db);
        await this.env.DROPBOX_SYNC.getByName(monitorName(connectionId, "editor")).kick();
      } catch (error) {
        console.error("Editor reconciliation recovery failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    try {
      await reconcileAwaitingRawProjects(this.env.DB, controller.scheduledTime, (projectId) => notifyProject(this.env, projectId, "raw_ready"));
    } catch (error) {
      console.error("RAW reconciliation scan failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    }
    try {
      const emitted = await scanStalledAutoHdr(this.env, controller.scheduledTime);
      console.log("AutoHDR stalled notification scan", { emitted });
    } catch (error) {
      console.error("AutoHDR stalled notification scan failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    }
    try {
      const emitted = await scanDueSubtasks(this.env, controller.scheduledTime);
      console.log("Due subtask notification scan", { emitted });
    } catch (error) {
      console.error("Due subtask notification scan failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    }
    try {
      await pruneNotifications(this.env, controller.scheduledTime);
      console.log("Notification pruning complete");
    } catch (error) {
      console.error("Notification pruning failed", { error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    }
  }

  async triggerDropboxSync(projectId: string): Promise<{ jobId: string }> {
    await requireBoardSchemaReady(this.env);
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

  async ensureEditorFolder(projectId: string): Promise<{ jobId: string } | null> {
    return enqueueEditorReconcile(this.env, projectId);
  }

  async previewEditorFolders(cursor?: string): Promise<Record<string, unknown>> {
    return previewEditorBackfill(this.env, cursor);
  }

  async inspectEditorFolder(projectId: string, rootPath: string): Promise<Record<string, unknown>> {
    return inspectEditorCandidate(this.env, projectId, rootPath);
  }

  async linkEditorFolder(candidate: ReviewedEditorCandidate, actorId: string): Promise<Record<string, unknown>> {
    const result = await applyEditorCandidate(this.env, candidate, actorId);
    const initialSync = automationFlag(this.env.DROPBOX_EDITOR_AUTOMATION_ENABLED)
      ? await this.triggerEditorSync(candidate.projectId) : null;
    return { ...result, initialSyncJobId: initialSync?.jobId ?? null, syncRequiredAfterActivation: !initialSync };
  }

  async triggerEditorSync(projectId: string): Promise<{ jobId: string }> {
    if (!automationFlag(this.env.DROPBOX_EDITOR_AUTOMATION_ENABLED)) throw new Error("Editor automation is disabled");
    const db = dbFor(this.env);
    const jobId = await createJob(db, { kind: "editor_sync", projectId });
    try {
      await this.env.INGEST_QUEUE.send({ type: "editor_sync", projectId, jobId });
      return { jobId };
    } catch (error) {
      await setJobStatus(db, jobId, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async renewDropboxDeletionClaim(claimId: string, ownerJobId: string): Promise<boolean> {
    return renewRawReconciliationClaim(this.env.DB, claimId, ownerJobId);
  }

  async deleteDropboxSourceFile(path: string, claimId: string, ownerJobId: string): Promise<
    | { outcome: "removed" }
    | { outcome: "alreadyGone" }
    | { outcome: "claimLost" }
    | { outcome: "failed"; reason: string }
  > {
    const DELETE_BATCH_MAX_POLLS = 45;
    const db = dbFor(this.env);
    try {
      if (!await renewRawReconciliationClaim(this.env.DB, claimId, ownerJobId)) return { outcome: "claimLost" };
      let result: DropboxDeleteBatchResult | DropboxDeleteBatchCheckResult = await deleteBatch(this.env, db, [{ path }]);
      let asyncJobId = result[".tag"] === "async_job_id" ? result.async_job_id : null;
      for (let poll = 1; asyncJobId && poll <= DELETE_BATCH_MAX_POLLS; poll += 1) {
        if (!await renewRawReconciliationClaim(this.env.DB, claimId, ownerJobId)) return { outcome: "claimLost" };
        result = await deleteBatchCheck(this.env, db, asyncJobId);
        if (result[".tag"] !== "in_progress") asyncJobId = null;
      }
      if (asyncJobId) return { outcome: "failed", reason: `did not complete after ${DELETE_BATCH_MAX_POLLS} checks` };
      if (result[".tag"] === "failed") return { outcome: "failed", reason: "Dropbox delete_batch failed" };
      if (result[".tag"] === "complete") {
        const entry = result.entries[0];
        if (entry?.[".tag"] === "success") return { outcome: "removed" };
        if (entry?.[".tag"] === "failure" && isDropboxPathNotFound(entry.failure)) return { outcome: "alreadyGone" };
        return { outcome: "failed", reason: "Dropbox delete_batch entry failed" };
      }
      return { outcome: "failed", reason: "unexpected Dropbox response shape" };
    } catch (error) {
      return { outcome: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async ensureAutoHdrScaffold(projectId: string): Promise<{ jobId: string }> {
    await requireBoardSchemaReady(this.env);
    return enqueueAutoHdrScaffold(this.env, projectId);
  }

  async backfillAutoHdrV2(params: BackfillParams): Promise<BackfillResult> {
    await requireBoardSchemaReady(this.env);
    return backfillAutoHdrV2Impl(this.env, params);
  }

  async sendSelectedToAutoHdr(projectId: string, initiatedBy?: string): Promise<AutoHdrApiSendResult> {
    await requireBoardSchemaReady(this.env);
    return claimAutoHdrApiSend(this.env, projectId, initiatedBy);
  }

  async startAutoHdr(projectId: string, initiatedBy?: string, options: { startNewRound?: boolean; resumeExisting?: boolean; removalSetHash?: string } = {}): Promise<AutoHdrResult> {
    await requireBoardSchemaReady(this.env);
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
      owner = await claimAutoHdrHandoff(this.env, projectId, initiatedBy, options);
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
          retiredHandoffId: owner.retiredHandoffId,
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
      const claimError = error instanceof AutoHdrClaimError ? error : null;
      const code: AutoHdrErrorCode = claimError?.code ?? (/archived/i.test(message)
        ? "ERR_PROJECT_ARCHIVED"
        : /no raw assets|no raw selection|selected for editing/i.test(message)
          ? "ERR_NO_RAW_SELECTION"
          : /collision|mapping/i.test(message)
            ? "ERR_MAPPING_BLOCKED"
            : /blocked/i.test(message)
              ? "ERR_HANDOFF_BLOCKED"
              : "ERR_HANDOFF_DISAPPEARED");
      return { ok: false, code, message, ...claimError?.details };
    }
  }

  async fetchEditedFromAutoHdr(projectId: string): Promise<AutoHdrFetchResult> {
    await requireBoardSchemaReady(this.env);
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
      if ("routeNoLongerValid" in owner) return { ok: false, code: "ERR_FOLDER_NOT_READY", message: owner.reason };
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
    await requireBoardSchemaReady(this.env);
    const db = dbFor(this.env);
    const connectionId = await canonicalDropboxConnectionId(db);
    await fanOutDropboxKicks(
      [monitorName(connectionId, "raw"), monitorName(connectionId, "autohdr"),
        ...(automationFlag(this.env.DROPBOX_EDITOR_AUTOMATION_ENABLED) ? [monitorName(connectionId, "editor")] : [])],
      async (name) => {
      const stub = this.env.DROPBOX_SYNC.getByName(name);
      await stub.kick();
      },
    );
  }

  async inspectDropboxMonitor(scope: "raw" | "autohdr" | "editor"): Promise<Record<string, unknown>> {
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

  async resetDropboxMonitor(scope: "raw" | "autohdr" | "editor"): Promise<Record<string, unknown>> {
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
    await requireBoardSchemaReady(this.env);
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

  async queue(batch: MessageBatch<IngestMessage | RenditionMessage | import("@quincy/shared").NotificationOutboxMessage>): Promise<void> {
    if (batch.queue === NOTIFICATION_DLQ_QUEUE_NAME) {
      for (const message of batch.messages) {
        const parsed = parseQueueBody(batch.queue, message.body);
        if (!parsed || parsed.queue !== NOTIFICATION_DLQ_QUEUE_NAME) { message.ack(); continue; }
        await processNotificationDlqMessage(this.env, message as Message<import("@quincy/shared").NotificationOutboxMessage>);
      }
      return;
    }
    if (batch.queue === NOTIFICATION_QUEUE_NAME) {
      for (const message of batch.messages) {
        try {
          const parsed = parseQueueBody(batch.queue, message.body);
          if (!parsed || parsed.queue !== NOTIFICATION_QUEUE_NAME) throw new Error("Invalid notification queue body");
          await processNotificationMessage(this.env, message as Message<import("@quincy/shared").NotificationOutboxMessage>);
        } catch (error) {
          console.error("Notification queue message failed", { outboxId: typeof message.body === "object" && message.body && typeof (message.body as { outboxId?: unknown }).outboxId === "string" ? (message.body as { outboxId: string }).outboxId : undefined, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
          message.retry();
        }
      }
      return;
    }
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
          case "editor_reconcile":
            await handleEditorReconcileMessage(this.env, parsed.body);
            message.ack();
            break;
          case "editor_sync":
            if (automationFlag(this.env.DROPBOX_EDITOR_AUTOMATION_ENABLED)) {
              try {
                if (parsed.body.jobId) await setJobStatus(dbFor(this.env), parsed.body.jobId, "running");
                const initialMapping = await dbFor(this.env).select({ id: editorFolderMappings.id, updatedAt: editorFolderMappings.updatedAt })
                  .from(editorFolderMappings).where(and(eq(editorFolderMappings.projectId, parsed.body.projectId), eq(editorFolderMappings.state, "ready"))).get();
                const raw = await syncProjectRawFolder(this.env, parsed.body.projectId, undefined, parsed.body.connectionId, "dropbox_delta");
                const output = await syncProjectEditorOutput(this.env, parsed.body.projectId, parsed.body.connectionId);
                if (initialMapping && raw.claimed && !raw.hasMore && !output.hasMore) {
                  await dbFor(this.env).update(editorFolderMappings).set({ initialSyncCompletedAt: new Date() })
                    .where(and(eq(editorFolderMappings.id, initialMapping.id), eq(editorFolderMappings.updatedAt, initialMapping.updatedAt), eq(editorFolderMappings.state, "ready")));
                }
                if (parsed.body.jobId) await setJobStatus(dbFor(this.env), parsed.body.jobId, "done");
              } catch (error) {
                if (parsed.body.jobId) await setJobStatus(dbFor(this.env), parsed.body.jobId, "failed", error instanceof Error ? error.message : String(error));
                throw error;
              }
            } else if (parsed.body.jobId) {
              await setJobStatus(dbFor(this.env), parsed.body.jobId, "failed", "Editor automation is disabled");
            }
            message.ack();
            break;
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
        if (isBoardSchemaMaintenanceError(error)) {
          // A migration window is an expected bounded maintenance state. Ack the message so a
          // queue consumer does not create a retry storm; the operator can replay after 0037.
          message.ack();
          continue;
        }
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
