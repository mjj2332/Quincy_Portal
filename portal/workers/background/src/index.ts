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
import { syncProjectRawFolder } from "./dropbox/sync";
import { fanOutDropboxKicks } from "./dropbox/webhook";
import { canMutateRenditionBackfill } from "./backfill-gate";
import { parseQueueBody } from "./queue-dispatch";
import { AutoHdrSend } from "./workflows/autohdr";
import { AutoHdrFetch } from "./workflows/autohdr-fetch";

export { AutoHdrFetch, AutoHdrSend, DropboxSyncDO, TonomoProcessorDO };

type DropboxSyncMessage = Extract<IngestMessage, { type: "dropbox_sync" }> & { jobId?: string };
export type RenditionBackfillInput = { dryRun?: boolean; cursor?: string; limit?: number; confirmProduction?: boolean };
export type RenditionBackfillResult = { scanned: number; wouldEnqueue: number; enqueued: number; skipped: number; nextCursor: string | null; dryRun: boolean };

export default class QuincyBackground extends WorkerEntrypoint<Env> {
  async fetch(): Promise<Response> {
    return Response.json({ ok: true, service: "quincy-background" });
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
        console.error("Background queue message failed", message.body, error);
        message.retry();
      }
    }
  }
}
