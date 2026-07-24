import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { assets, collections, projects } from "@quincy/db/schema";
import { isLegacyManualEditedRecoveryCandidate } from "@quincy/shared";
import { and, eq } from "drizzle-orm";

import { autoHdrManualUploadPath, deriveAutoHdrFolderName } from "../autohdr/paths";
import { pathFromRawFolderLink } from "../dropbox/sync";
import { upload } from "../dropbox/client";
import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import { setJobStatus } from "../lib/jobs";
import { enqueueManualEditedRenditions } from "../manual-edited-renditions";

export interface LegacyManualEditedRecoveryInput {
  projectId: string;
  assetId: string;
  jobId: string;
}

/**
 * Temporary recovery for the exact legacy state created before manual Edited publication tracked
 * a Dropbox destination. It never delegates to ManualEditedPublish: that workflow's semantics
 * intentionally remain reserved for normal pending/failed publication.
 */
export class LegacyManualEditedRecovery extends WorkflowEntrypoint<Env, LegacyManualEditedRecoveryInput> {
  /** Test seam: production keeps the established Dropbox upload implementation. */
  protected readonly uploadToDropbox = upload;

  async run(event: Readonly<WorkflowEvent<LegacyManualEditedRecoveryInput>>, step: WorkflowStep): Promise<void> {
    const input = event.payload;
    try {
      await step.do("mark-legacy-recovery-running", async () => {
        await setJobStatus(dbFor(this.env), input.jobId, "running");
        return { status: "running" };
      });

      const asset = await step.do("assert-strict-legacy-recovery-predicate", async () => {
        const row = await dbFor(this.env).select({
          assetId: assets.id, r2Key: assets.r2Key, originalFilename: assets.originalFilename,
          collectionKind: collections.kind, source: assets.source, publishStatus: assets.publishStatus,
          sourcePath: assets.sourcePath, archivedAt: projects.archivedAt, rawFolderPath: projects.rawFolderPath,
          rawFolderLink: projects.rawFolderLink,
        }).from(assets)
          .innerJoin(collections, eq(assets.collectionId, collections.id))
          .innerJoin(projects, eq(collections.projectId, projects.id))
          .where(and(eq(assets.id, input.assetId), eq(collections.projectId, input.projectId))).get();
        const renditionCount = (await this.env.DB.prepare("SELECT COUNT(*) AS count FROM asset_renditions WHERE asset_id = ?").bind(input.assetId).first<{ count: number }>())?.count ?? 0;
        if (!row || !isLegacyManualEditedRecoveryCandidate({ ...row, renditionCount })) {
          throw new Error("Asset no longer meets the strict legacy manual Edited recovery predicate");
        }
        if (!row.rawFolderPath && !row.rawFolderLink) throw new Error(`Project ${input.projectId} has no Dropbox RAW folder configured`);
        return row;
      });

      const destination = await step.do("resolve-legacy-manual-destination", async () => {
        const rawFolderPath = asset.rawFolderPath ?? await pathFromRawFolderLink(this.env, asset.rawFolderLink);
        if (!rawFolderPath) throw new Error(`Project ${input.projectId} has no resolvable Dropbox RAW folder path`);
        return autoHdrManualUploadPath(deriveAutoHdrFolderName(rawFolderPath), asset.assetId, asset.originalFilename);
      });

      await step.do("copy-legacy-manual-upload-to-dropbox", async () => {
        const object = await this.env.MEDIA.get(asset.r2Key);
        if (!object?.body) throw new Error(`Legacy manual Edited upload ${asset.assetId} is missing from R2`);
        await this.uploadToDropbox(this.env, dbFor(this.env), destination, object.body);
        return { destination };
      });

      await step.do("guarded-legacy-source-path-repair", async () => {
        const now = Date.now();
        await this.env.DB.batch([
          // The original predicate is reasserted at the writer. A concurrent path/rendition
          // writer causes a hard recovery failure instead of overwriting historical linkage.
          this.env.DB.prepare("UPDATE assets SET source_path = ?, updated_at = ? WHERE id = ? AND source = 'upload' AND source_path IS NULL AND publish_status = 'ready' AND EXISTS (SELECT 1 FROM collections INNER JOIN projects ON collections.project_id = projects.id WHERE collections.id = assets.collection_id AND collections.kind = 'edited' AND projects.id = ? AND projects.archived_at IS NULL) AND NOT EXISTS (SELECT 1 FROM asset_renditions WHERE asset_renditions.asset_id = assets.id)").bind(destination, now, input.assetId, input.projectId),
          this.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'asset.legacy_manual_edited_recovery.source_path_repaired', 'asset', ?, ?, ? WHERE changes() = 1").bind(crypto.randomUUID(), input.assetId, JSON.stringify({ actor: "system", projectId: input.projectId, jobId: input.jobId, destination }), now),
        ]);
        const repaired = await this.env.DB.prepare("SELECT source_path FROM assets WHERE id = ?").bind(input.assetId).first<{ source_path: string | null }>();
        if (repaired?.source_path !== destination) throw new Error(`Legacy manual Edited asset ${input.assetId} source path repair was refused`);
        return { destination };
      });

      await step.do("enqueue-legacy-manual-edited-renditions", async () => {
        // The Dropbox copy and source_path repair are durable. A later queue failure must fail
        // only this job and never undo ready visibility or the repaired provider linkage.
        await enqueueManualEditedRenditions(this.env, input.assetId);
        return { queued: true };
      });

      await step.do("complete-legacy-manual-edited-recovery", async () => {
        const now = Date.now();
        await this.env.DB.batch([
          this.env.DB.prepare("UPDATE jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ?").bind(now, input.jobId),
          this.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'asset.legacy_manual_edited_recovery.queued', 'asset', ?, ?, ?)")
            .bind(crypto.randomUUID(), input.assetId, JSON.stringify({ actor: "system", projectId: input.projectId, jobId: input.jobId }), now),
        ]);
        return { status: "done" };
      });
    } catch (error) {
      const message = errorMessage(error);
      const now = Date.now();
      await this.env.DB.batch([
        this.env.DB.prepare("UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(message, now, input.jobId),
        this.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'asset.legacy_manual_edited_recovery.failed', 'asset', ?, ?, ?)")
          .bind(crypto.randomUUID(), input.assetId, JSON.stringify({ actor: "system", projectId: input.projectId, jobId: input.jobId, error: message }), now),
      ]);
      throw error;
    }
  }
}
