import { WorkerEntrypoint } from "cloudflare:workers";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { assets, collections, integrationConnections, jobs, projects, selections } from "@quincy/db/schema";
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
import { parseQueueBody } from "./queue-dispatch";
import { AutoHdrSend } from "./workflows/autohdr";
import { AutoHdrFetch } from "./workflows/autohdr-fetch";
import { ManualEditedPublish } from "./workflows/manual-edited-publish";
import { reconcileAwaitingRawProjects } from "./reconcile-awaiting-raw";

export { AutoHdrFetch, AutoHdrSend, ManualEditedPublish, DropboxSyncDO, TonomoProcessorDO };

type DropboxSyncMessage = Extract<IngestMessage, { type: "dropbox_sync" }> & { jobId?: string };
export type RenditionBackfillInput = { dryRun?: boolean; cursor?: string; limit?: number; confirmProduction?: boolean };
export type RenditionBackfillResult = { scanned: number; wouldEnqueue: number; enqueued: number; skipped: number; nextCursor: string | null; dryRun: boolean };

export default class QuincyBackground extends WorkerEntrypoint<Env> {
  async fetch(): Promise<Response> {
    return Response.json({ ok: true, service: "quincy-background" });
  }

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
      const message: DropboxSyncMessage = { type: "dropbox_sync", projectId, jobId };
      await this.env.INGEST_QUEUE.send(message);
      return { jobId };
    } catch (error) {
      await setJobStatus(db, jobId, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async startAutoHdr(projectId: string): Promise<{ jobId: string }> {
    const db = dbFor(this.env);
    const selected = await db
      .select({ assetId: assets.id })
      .from(selections)
      .innerJoin(assets, eq(selections.assetId, assets.id))
      .innerJoin(collections, eq(assets.collectionId, collections.id))
      .where(and(
        eq(selections.state, "selected_for_editing"),
        eq(collections.projectId, projectId),
        eq(collections.kind, "raw"),
      ));
    const assetIds = selected.map((row) => row.assetId);
    if (assetIds.length === 0) throw new Error("No RAW assets are selected for editing");

    const jobId = await createJob(db, {
      kind: "autohdr",
      projectId,
      payload: { projectId, assetIds },
      correlationId: `autohdr:${projectId}`,
    });
    try {
      await this.env.AUTOHDR_WORKFLOW.create({ id: jobId, params: { projectId, assetIds, jobId } });
      // Surface the hand-off immediately; the workflow owns terminal stage and job updates.
      await db.update(projects).set({ stageKey: "editing_autohdr", updatedAt: new Date() }).where(eq(projects.id, projectId));
      return { jobId };
    } catch (error) {
      await setJobStatus(db, jobId, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async fetchEditedFromAutoHdr(projectId: string): Promise<{ jobId: string }> {
    const db = dbFor(this.env);
    // Single-flight: an in-progress fetch already covers this project. Returning it avoids two
    // concurrent workflows double-inserting the same finals (no unique constraint on edited assets).
    const active = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.projectId, projectId), eq(jobs.kind, "fetch_edited"), inArray(jobs.status, ["queued", "running"])))
      .get();
    if (active) return { jobId: active.id };
    const jobId = await createJob(db, {
      kind: "fetch_edited",
      projectId,
      payload: { projectId },
      correlationId: `fetch_edited:${projectId}`,
    });
    try {
      await this.env.AUTOHDR_FETCH_WORKFLOW.create({ id: jobId, params: { projectId, jobId } });
      return { jobId };
    } catch (error) {
      await setJobStatus(db, jobId, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async publishManualEditedUpload(projectId: string, assetId: string): Promise<{ jobId: string }> {
    const db = dbFor(this.env);
    const asset = await db.select({ id: assets.id, publishStatus: assets.publishStatus, archivedAt: projects.archivedAt })
      .from(assets)
      .innerJoin(collections, eq(assets.collectionId, collections.id))
      .innerJoin(projects, eq(collections.projectId, projects.id))
      .where(and(eq(assets.id, assetId), eq(collections.projectId, projectId), eq(collections.kind, "edited"), eq(assets.source, "upload"))).get();
    if (!asset) throw new Error("Manual edited upload is not available for publishing");
    // The service can be called after the app's archive check, so it must independently close
    // that race before creating a new background writer.
    if (asset.archivedAt) throw new Error(`Project ${projectId} is archived — manual publish refused`);
    if (asset.publishStatus === "ready") {
      // A ready manual asset can only re-enter this workflow after its durable Dropbox
      // publication succeeded but the rendition queue handoff failed. The replay skips
      // Dropbox and retries that handoff; ordinary already-published assets stay immutable.
      const failedHandoff = await db.select({ id: jobs.id }).from(jobs).where(and(
        eq(jobs.projectId, projectId), eq(jobs.kind, "manual_edited_publish"),
        eq(jobs.correlationId, `manual_edited_publish:${assetId}`), inArray(jobs.status, ["failed", "stuck"]),
      )).get();
      if (!failedHandoff) throw new Error("Manual edited upload is already published");
    }
    const active = await db.select({ id: jobs.id }).from(jobs).where(and(
      eq(jobs.projectId, projectId), eq(jobs.kind, "manual_edited_publish"), inArray(jobs.status, ["queued", "running"]),
      eq(jobs.correlationId, `manual_edited_publish:${assetId}`),
    )).get();
    if (active) return { jobId: active.id };
    const statusAfterWorkflowCreateFailure = publishStatusAfterWorkflowCreateFailure(asset.publishStatus);
    // A failed publication retry must return the asset to the only state the workflow can
    // promote. A ready asset is a post-publication rendition-handoff retry and remains visible.
    if (asset.publishStatus !== "ready") await db.update(assets).set({ publishStatus: "pending", updatedAt: new Date() }).where(eq(assets.id, assetId));
    let jobId: string;
    try {
      jobId = await createJob(db, { kind: "manual_edited_publish", projectId, payload: { projectId, assetId }, correlationId: `manual_edited_publish:${assetId}` });
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
          eq(jobs.projectId, projectId), eq(jobs.kind, "manual_edited_publish"), inArray(jobs.status, ["queued", "running"]),
          eq(jobs.correlationId, `manual_edited_publish:${assetId}`),
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

  /** The historical schema is not singleton-enforced; use its canonical oldest row only. */
  async handleDropboxWebhook(): Promise<void> {
    const db = dbFor(this.env);
    const connections = await db
      .select({ id: integrationConnections.id })
      .from(integrationConnections)
      .where(eq(integrationConnections.provider, "dropbox"))
      .orderBy(asc(integrationConnections.createdAt), asc(integrationConnections.id)).limit(1);
    await fanOutDropboxKicks(connections.map((connection) => connection.id), async (connectionId) => {
      const stub = this.env.DROPBOX_SYNC.getByName(connectionId);
      await stub.kick();
    });
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
            await syncProjectRawFolder(this.env, parsed.body.projectId, (parsed.body as DropboxSyncMessage).jobId);
            message.ack();
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
