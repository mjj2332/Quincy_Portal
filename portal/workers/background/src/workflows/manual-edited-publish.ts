import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { buildProjectActivityStatements, COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings } from "@quincy/db";
import { assets, collections, projects } from "@quincy/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { projectActivityDeepLink, publishNotificationOutbox, type ProjectActivityIntent } from "@quincy/shared";

import { autoHdrManualUploadFolderChain, autoHdrManualUploadPath, deriveAutoHdrFolderName, rawManualUploadPath } from "../autohdr/paths";
import { pathFromRawFolderLink } from "../dropbox/sync";
import { createFolder, upload } from "../dropbox/client";
import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import { setJobStatus } from "../lib/jobs";
import { enqueueManualEditedRenditions } from "../manual-edited-renditions";

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
          source: assets.source, sourcePath: assets.sourcePath, publishStatus: assets.publishStatus, collectionKind: collections.kind,
          projectId: collections.projectId, archivedAt: projects.archivedAt, rawFolderPath: projects.rawFolderPath, rawFolderLink: projects.rawFolderLink,
        }).from(assets)
          .innerJoin(collections, eq(assets.collectionId, collections.id))
          .innerJoin(projects, eq(collections.projectId, projects.id))
          .where(and(eq(assets.id, input.assetId), eq(collections.projectId, input.projectId))).get();
        if (!row || !["raw", "edited"].includes(row.collectionKind) || row.source !== "upload") throw new Error("Manual upload is no longer available for Dropbox publishing");
        // Writer-side guard: archiving can race an already-created Workflow. Never write a
        // Dropbox delivery or promote an asset for an archived project.
        if (row.archivedAt) throw new Error(`Project ${input.projectId} is archived — manual publish refused`);
        if (!row.sourcePath && !row.rawFolderPath && !row.rawFolderLink) throw new Error(`Project ${input.projectId} has no Dropbox RAW folder configured`);
        return row;
      });

      const destination = await step.do("resolve-manual-destination", async () => {
        if (asset.sourcePath && (asset.collectionKind === "raw" || asset.publishStatus === "ready")) return asset.sourcePath;
        const rawFolderPath = asset.rawFolderPath ?? await pathFromRawFolderLink(this.env, asset.rawFolderLink);
        if (!rawFolderPath) throw new Error(`Project ${input.projectId} has no resolvable Dropbox RAW folder path`);
        return asset.collectionKind === "raw"
          ? rawManualUploadPath(rawFolderPath, asset.originalFilename)
          : autoHdrManualUploadPath(deriveAutoHdrFolderName(rawFolderPath), asset.id, asset.originalFilename);
      });
      const alreadyPublished = asset.collectionKind === "edited"
        ? asset.publishStatus === "ready"
        : asset.sourcePath === destination;

      if (!alreadyPublished) {
        if (asset.collectionKind === "raw") {
          await step.do("ensure-manual-raw-folder", async () => {
            // Create only our child folder. Dropbox returns path/not_found if the Tonomo-owned
            // listing parent is absent; this Workflow must never create that external folder.
            const folder = destination.slice(0, destination.lastIndexOf("/"));
            await createFolder(this.env, dbFor(this.env), folder);
            return { folder };
          });
        } else {
          await step.do("ensure-manual-edited-folder", async () => {
            // Unlike the Tonomo listing folder, the `/AutoHDR` subtree is Portal-owned, so create
            // the destination the same way the AutoHDR hand-off does instead of relying on the
            // provider's implicit parent creation. Every level is created because create_folder_v2
            // only guarantees the leaf, and each call absorbs path/conflict.
            const folders = autoHdrManualUploadFolderChain(destination);
            for (const folder of folders) await createFolder(this.env, dbFor(this.env), folder);
            return { folders };
          });
        }
        await step.do("publish-manual-upload", async () => {
          const object = await this.env.MEDIA.get(asset.r2Key);
          if (!object?.body) throw new Error(`Manual ${asset.collectionKind} upload ${asset.id} is missing from R2`);
          await upload(this.env, dbFor(this.env), destination, object.body);
          return { destination };
        });
        await step.do("make-manual-upload-ready", async () => {
          const now = new Date();
          if (asset.collectionKind === "raw") {
            // The RAW asset is visible from R2 before this Workflow starts. This guarded write
            // only records the provider destination after Dropbox has durably accepted it.
            await this.env.DB.batch([
              this.env.DB.prepare("UPDATE assets SET source_path = ?, updated_at = ? WHERE id = ? AND source = 'upload' AND EXISTS (SELECT 1 FROM collections INNER JOIN projects ON collections.project_id = projects.id WHERE collections.id = assets.collection_id AND collections.kind = 'raw' AND projects.id = ? AND projects.archived_at IS NULL)").bind(destination, now.getTime(), input.assetId, input.projectId),
              this.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'asset.manual_raw_mirror.ready', 'asset', ?, ?, ? WHERE changes() = 1").bind(crypto.randomUUID(), input.assetId, JSON.stringify({ actor: "system", projectId: input.projectId, jobId: input.jobId, destination }), now.getTime()),
            ]);
            const mirrored = await dbFor(this.env).select({ sourcePath: assets.sourcePath })
              .from(assets)
              .innerJoin(collections, eq(assets.collectionId, collections.id))
              .innerJoin(projects, and(eq(collections.projectId, projects.id), eq(projects.id, input.projectId), isNull(projects.archivedAt)))
              .where(eq(assets.id, input.assetId)).get();
            if (mirrored?.sourcePath !== destination) throw new Error(`Manual RAW upload ${input.assetId} could not record its Dropbox mirror`);
            return { status: "ready" };
          }

          // Recheck the project in the promotion statement: archive/delete can happen after
          // Dropbox accepts the idempotent overwrite but before this final visibility change.
          const publishAuditId = crypto.randomUUID();
          const publishActivityId = crypto.randomUUID();
          const publishActivity: ProjectActivityIntent = {
            schemaVersion: 1,
            activity: { id: publishActivityId, type: "project.workflow.manual_edited_ready", projectId: input.projectId, actorId: null, actorKind: "system", occurredAt: now.getTime(), source: { kind: "project_manual_edited", id: input.assetId, key: `project-manual-edited:${input.jobId}:${input.assetId}:ready` }, safePayload: { collectionKind: "edited", count: 1 }, deepLink: projectActivityDeepLink("project.workflow.manual_edited_ready", input.projectId) },
            broadDelivery: { registryKey: "project.workflow.manual_edited_ready", sourceActivityId: publishActivityId, coalesce: null },
          };
          const publishActivityBundle = buildProjectActivityStatements({ db: this.env.DB, intent: publishActivity, winnerAuditId: publishAuditId, createdAt: now.getTime() });
          const publishResults = await this.env.DB.batch([
            this.env.DB.prepare("UPDATE assets SET publish_status = 'ready', source_path = ?, updated_at = ? WHERE id = ? AND publish_status = 'pending' AND EXISTS (SELECT 1 FROM collections INNER JOIN projects ON collections.project_id = projects.id WHERE collections.id = assets.collection_id AND projects.id = ? AND projects.archived_at IS NULL)").bind(destination, now.getTime(), input.assetId, input.projectId),
            // `changes()` is connection-local, and D1 batches execute on one connection. The
            // audit row therefore exists only for the guarded pending -> ready promotion.
            this.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'asset.manual_publish.ready', 'asset', ?, ?, ? WHERE changes() = 1 RETURNING id").bind(publishAuditId, input.assetId, JSON.stringify({ actor: "system", projectId: input.projectId, jobId: input.jobId, destination }), now.getTime()),
            this.env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(asset.collectionId, now.getTime())),
            ...publishActivityBundle.statements,
          ]);
          const publicationIds = ((publishResults[3 + publishActivityBundle.broadOutboxIndex]?.results ?? []) as Array<{ id?: string }>).flatMap((row) => row.id ? [row.id] : []);
          if (publicationIds.length) await publishNotificationOutbox(this.env.NOTIFICATION_QUEUE, this.env.DB, publicationIds);
          const promoted = await dbFor(this.env).select({ publishStatus: assets.publishStatus })
            .from(assets)
            .innerJoin(collections, eq(assets.collectionId, collections.id))
            .innerJoin(projects, and(eq(collections.projectId, projects.id), eq(projects.id, input.projectId), isNull(projects.archivedAt)))
            .where(eq(assets.id, input.assetId)).get();
          if (promoted?.publishStatus !== "ready") throw new Error(`Manual edited upload ${input.assetId} could not be published`);
          return { status: "ready" };
        });
      }

      if (asset.collectionKind === "edited") {
        await step.do("enqueue-manual-edited-renditions", async () => {
          // Dropbox publication is already durable. Throwing preserves ready visibility and makes
          // the Workflow/job retryable; a replay skips upload/promotion and retries only enqueue.
          await enqueueManualEditedRenditions(this.env, input.assetId);
          return { queued: true };
        });
      }

      await step.do("complete-manual-publish", async () => {
        await setJobStatus(dbFor(this.env), input.jobId, "done");
        return { status: "done" };
      });
    } catch (error) {
      const message = errorMessage(error);
      const now = new Date();
      const asset = await dbFor(this.env).select({ collectionKind: collections.kind })
        .from(assets)
        .innerJoin(collections, eq(assets.collectionId, collections.id))
        .where(and(eq(assets.id, input.assetId), eq(collections.projectId, input.projectId)))
        .get();
      if (asset?.collectionKind === "raw") {
        await this.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'asset.manual_raw_mirror.failed', 'asset', ?, ?, ?)")
          .bind(crypto.randomUUID(), input.assetId, JSON.stringify({ actor: "system", projectId: input.projectId, jobId: input.jobId, error: message }), now.getTime())
          .run();
      } else {
        await this.env.DB.batch([
          this.env.DB.prepare("UPDATE assets SET publish_status = 'failed', updated_at = ? WHERE id = ? AND publish_status = 'pending'").bind(now.getTime(), input.assetId),
          this.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'asset.manual_publish.failed', 'asset', ?, ?, ? WHERE changes() = 1").bind(crypto.randomUUID(), input.assetId, JSON.stringify({ actor: "system", projectId: input.projectId, jobId: input.jobId, error: message }), now.getTime()),
        ]);
      }
      await setJobStatus(dbFor(this.env), input.jobId, "failed", message);
      throw error;
    }
  }
}
