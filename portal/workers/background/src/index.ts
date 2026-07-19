import { WorkerEntrypoint } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { integrationConnections } from "@quincy/db/schema";

import { DropboxSyncDO } from "./do/dropbox-sync";
import type { Env } from "./env";
import { dbFor } from "./lib/db";
import { createJob, setJobStatus } from "./lib/jobs";
import type { IngestMessage } from "./messages";
import { syncProjectRawFolder } from "./dropbox/sync";
import { AutoHdrRoundtrip } from "./workflows/autohdr";

export { AutoHdrRoundtrip, DropboxSyncDO };

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
      await this.env.INGEST_QUEUE.send({ type: "dropbox_sync", projectId });
      return { jobId };
    } catch (error) {
      await setJobStatus(db, jobId, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** Fans out the Dropbox webhook to the cursor DO for every connected Dropbox account. */
  async handleDropboxWebhook(): Promise<void> {
    const db = dbFor(this.env);
    const connections = await db
      .select({ id: integrationConnections.id })
      .from(integrationConnections)
      .where(eq(integrationConnections.provider, "dropbox"));
    await Promise.all(
      connections.map(async (connection) => {
        const stub = this.env.DROPBOX_SYNC.getByName(connection.id);
        await stub.kick();
      }),
    );
  }

  async queue(batch: MessageBatch<IngestMessage>): Promise<void> {
    for (const message of batch.messages) {
      try {
        switch (message.body.type) {
          case "asset_ingested":
            // Rendition generation is intentionally deferred to its own consumer implementation.
            message.ack();
            break;
          case "dropbox_sync":
            await syncProjectRawFolder(this.env, message.body.projectId);
            message.ack();
            break;
          case "autohdr_check":
            // The workflow owns the 15-minute polling loop; this ID-only event is reserved for recovery checks.
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
