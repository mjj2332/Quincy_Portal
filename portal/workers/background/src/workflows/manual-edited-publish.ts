import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings } from "@quincy/db";
import { assets, collections, projects } from "@quincy/db/schema";
import { enqueueRenditionSafely } from "@quincy/shared";
import { and, eq, isNull } from "drizzle-orm";

import { autoHdrManualUploadPath, deriveAutoHdrFolderName } from "../autohdr/paths";
import { pathFromRawFolderLink } from "../dropbox/sync";
import { upload } from "../dropbox/client";
import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import { setJobStatus } from "../lib/jobs";

export interface ManualEditedPublishInput {
  projectId: string;
  assetId: string;
  jobId: string;
}

export class ManualEditedPublish extends WorkflowEntrypoint<Env, ManualEditedPublishInput> {
  async run(event: Readonly<WorkflowEvent<ManualEditedPublishInput>>, step: WorkflowStep): Promise<void> {
    const input = event.payload;
    try {
      await step.do("mark-manual-publish-running", async () => {
        await setJobStatus(dbFor(this.env), input.jobId, "running");
        return { status: "running" };
      });

      const asset = await step.do("load-manual-upload", async () => {
        const row = await dbFor(this.env).select({
          id: assets.id, collectionId: assets.collectionId, r2Key: assets.r2Key, originalFilename: assets.originalFilename,
          source: assets.source, publishStatus: assets.publishStatus, collectionKind: collections.kind,
          projectId: collections.projectId, archivedAt: projects.archivedAt, rawFolderPath: projects.rawFolderPath, rawFolderLink: projects.rawFolderLink,
        }).from(assets)
          .innerJoin(collections, eq(assets.collectionId, collections.id))
          .innerJoin(projects, eq(collections.projectId, projects.id))
          .where(and(eq(assets.id, input.assetId), eq(collections.projectId, input.projectId))).get();
        if (!row || row.collectionKind !== "edited" || row.source !== "upload") throw new Error("Manual edited upload is no longer available for publishing");
        // Writer-side guard: archiving can race an already-created Workflow. Never write a
        // Dropbox delivery or promote an asset for an archived project.
        if (row.archivedAt) throw new Error(`Project ${input.projectId} is archived — manual publish refused`);
        if (row.publishStatus === "ready") return row;
        if (!row.rawFolderPath && !row.rawFolderLink) throw new Error(`Project ${input.projectId} has no Dropbox RAW folder configured`);
        return row;
      });

      if (asset.publishStatus !== "ready") {
        const destination = await step.do("resolve-manual-destination", async () => {
          const rawFolderPath = asset.rawFolderPath ?? await pathFromRawFolderLink(this.env, asset.rawFolderLink);
          if (!rawFolderPath) throw new Error(`Project ${input.projectId} has no resolvable Dropbox RAW folder path`);
          return autoHdrManualUploadPath(deriveAutoHdrFolderName(rawFolderPath), asset.id, asset.originalFilename);
        });
        await step.do("publish-manual-upload", async () => {
          const object = await this.env.MEDIA.get(asset.r2Key);
          if (!object?.body) throw new Error(`Manual edited upload ${asset.id} is missing from R2`);
          await upload(this.env, dbFor(this.env), destination, object.body);
          return { destination };
        });
        await step.do("make-manual-upload-ready", async () => {
          const now = new Date();
          // Recheck the project in the promotion statement: archive/delete can happen after
          // Dropbox accepts the idempotent overwrite but before this final visibility change.
          await this.env.DB.batch([
            this.env.DB.prepare("UPDATE assets SET publish_status = 'ready', updated_at = ? WHERE id = ? AND publish_status = 'pending' AND EXISTS (SELECT 1 FROM collections INNER JOIN projects ON collections.project_id = projects.id WHERE collections.id = assets.collection_id AND projects.id = ? AND projects.archived_at IS NULL)").bind(now.getTime(), input.assetId, input.projectId),
            // `changes()` is connection-local, and D1 batches execute on one connection. The
            // audit row therefore exists only for the guarded pending -> ready promotion.
            this.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'asset.manual_publish.ready', 'asset', ?, ?, ? WHERE changes() = 1").bind(crypto.randomUUID(), input.assetId, JSON.stringify({ actor: "system", projectId: input.projectId, jobId: input.jobId, destination }), now.getTime()),
            this.env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(asset.collectionId, now.getTime())),
          ]);
          const promoted = await dbFor(this.env).select({ publishStatus: assets.publishStatus })
            .from(assets)
            .innerJoin(collections, eq(assets.collectionId, collections.id))
            .innerJoin(projects, and(eq(collections.projectId, projects.id), eq(projects.id, input.projectId), isNull(projects.archivedAt)))
            .where(eq(assets.id, input.assetId)).get();
          if (promoted?.publishStatus !== "ready") throw new Error(`Manual edited upload ${input.assetId} could not be published`);
          // Source publication is durable before this best-effort side effect. A failed queue
          // handoff leaves the ready asset eligible for the bounded rendition backfill.
          await enqueueRenditionSafely(this.env, input.assetId, "manual-edited-publish");
          return { status: "ready" };
        });
      }

      await step.do("complete-manual-publish", async () => {
        await setJobStatus(dbFor(this.env), input.jobId, "done");
        return { status: "done" };
      });
    } catch (error) {
      const message = errorMessage(error);
      const now = new Date();
      await this.env.DB.batch([
        this.env.DB.prepare("UPDATE assets SET publish_status = 'failed', updated_at = ? WHERE id = ? AND publish_status = 'pending'").bind(now.getTime(), input.assetId),
        this.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'asset.manual_publish.failed', 'asset', ?, ?, ? WHERE changes() = 1").bind(crypto.randomUUID(), input.assetId, JSON.stringify({ actor: "system", projectId: input.projectId, jobId: input.jobId, error: message }), now.getTime()),
      ]);
      await setJobStatus(dbFor(this.env), input.jobId, "failed", message);
      throw error;
    }
  }
}
