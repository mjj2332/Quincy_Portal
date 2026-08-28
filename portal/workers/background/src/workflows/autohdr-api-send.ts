import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { assets, collections, projects } from "@quincy/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { isAcceptedPhotoFilename } from "@quincy/shared";

import { createAutoHdrPresignedPhotoshoot, finalizeAutoHdrPhotoshoot, uploadAutoHdrPresignedFile } from "../autohdr/api-client";
import type { AutoHdrApiSendInput, AutoHdrApiSendJobPayload } from "../autohdr/api-send";
import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import { setJobStatus } from "../lib/jobs";
import { notifyProject } from "../notifications";
import { requireBoardSchemaReady } from "../lib/board-schema";
import { automaticBoardWritesEnabled, commitAutomaticStage } from "../lib/automatic-stage";

function chunked<T>(items: readonly T[], size = 80): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export class AutoHdrApiSend extends WorkflowEntrypoint<Env, AutoHdrApiSendInput> {
  async run(event: Readonly<WorkflowEvent<AutoHdrApiSendInput>>, step: WorkflowStep): Promise<void> {
    const input = event.payload;
    await requireBoardSchemaReady(this.env);
    if (!await automaticBoardWritesEnabled(this.env)) {
      console.log("AutoHDR API send deferred while automatic Board writes are disabled", { projectId: input.projectId, jobId: input.jobId });
      return;
    }
    try {
      const apiKey = this.env.AUTOHDR_API_KEY?.trim();
      if (!apiKey) throw new Error("The AutoHDR API key is not configured on the background Worker");
      await step.do("mark-autohdr-api-send-running", async () => {
        await setJobStatus(dbFor(this.env), input.jobId, "running");
        return { status: "running" };
      });

      const selectedAssets = await step.do("load-autohdr-api-assets", async () => {
        const db = dbFor(this.env);
        const project = await db.select({ archivedAt: projects.archivedAt })
          .from(projects).where(eq(projects.id, input.projectId)).get();
        if (!project) throw new Error(`Project ${input.projectId} no longer exists`);
        if (project.archivedAt) throw new Error(`Project ${input.projectId} is archived — AutoHDR send refused`);

        const rows: Array<{ id: string; r2Key: string; filename: string; bytes: number }> = [];
        for (const ids of chunked(input.assetIds)) {
          rows.push(...await db.select({
            id: assets.id,
            r2Key: assets.r2Key,
            filename: assets.originalFilename,
            bytes: assets.bytes,
          }).from(assets)
            .innerJoin(collections, and(eq(assets.collectionId, collections.id), eq(collections.projectId, input.projectId), eq(collections.kind, "raw")))
            .where(and(inArray(assets.id, ids), isNull(assets.supersededAt)))
            .all());
        }
        if (rows.length !== input.assetIds.length) throw new Error("One or more selected RAW assets are no longer available");
        const byId = new Map(rows.map((row) => [row.id, row]));
        const ordered = input.assetIds.map((assetId) => byId.get(assetId));
        if (ordered.some((row) => !row)) throw new Error("One or more selected RAW assets are no longer available");
        const filenames = new Set<string>();
        for (const row of ordered) {
          if (!row || !isAcceptedPhotoFilename(row.filename)) throw new Error(`Unsupported selected RAW filename: ${row?.filename ?? "unknown"}`);
          const key = row.filename.toLowerCase();
          if (filenames.has(key)) throw new Error(`Duplicate selected RAW filename: ${row.filename}`);
          filenames.add(key);
        }
        return ordered as Array<{ id: string; r2Key: string; filename: string; bytes: number }>;
      });

      const photoshoot = await step.do("create-autohdr-presigned-photoshoot", async () => {
        return createAutoHdrPresignedPhotoshoot(apiKey, {
          files: selectedAssets.map((asset) => ({ filename: asset.filename })),
          address: input.address,
        });
      });

      await step.do("record-autohdr-photoshoot", async () => {
        const payload: AutoHdrApiSendJobPayload = {
          provider: "autohdr_api_v4",
          projectId: input.projectId,
          generation: 1,
          stageEntrySourceJobId: input.jobId,
          stageEntryGeneration: 1,
          assetIds: input.assetIds,
          initiatedBy: input.initiatedBy,
          address: input.address,
          phase: "created",
          uid: photoshoot.uid,
        };
        await this.env.DB.prepare("UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ? AND status = 'running'")
          .bind(JSON.stringify(payload), Date.now(), input.jobId).run();
        return { uid: photoshoot.uid };
      });

      for (let index = 0; index < selectedAssets.length; index += 1) {
        const asset = selectedAssets[index]!;
        const uploadUrl = photoshoot.uploadedFiles[index]!;
        await step.do(`upload-autohdr-${index + 1}-${asset.id}`, async () => {
          const object = await this.env.MEDIA.get(asset.r2Key);
          if (!object?.body) throw new Error(`Selected RAW asset ${asset.id} is missing from R2`);
          if (object.size !== asset.bytes) throw new Error(`Selected RAW asset ${asset.id} has an unexpected byte length`);
          await uploadAutoHdrPresignedFile(uploadUrl, object.body, "image/jpeg");
          return { assetId: asset.id, bytes: object.size };
        });
      }

      await step.do("verify-project-before-autohdr-finalize", async () => {
        const project = await dbFor(this.env).select({ archivedAt: projects.archivedAt })
          .from(projects).where(eq(projects.id, input.projectId)).get();
        if (!project) throw new Error(`Project ${input.projectId} no longer exists`);
        if (project.archivedAt) throw new Error(`Project ${input.projectId} was archived before AutoHDR finalization`);
        return { active: true };
      });

      await step.do("finalize-autohdr-photoshoot", async () => {
        await finalizeAutoHdrPhotoshoot(apiKey, photoshoot.uid);
        return { uid: photoshoot.uid, finalized: true };
      });

      const completion = await step.do("complete-autohdr-api-send", async () => {
        const now = Date.now();
        const payload: AutoHdrApiSendJobPayload = {
          provider: "autohdr_api_v4",
          projectId: input.projectId,
          generation: 1,
          stageEntrySourceJobId: input.jobId,
          stageEntryGeneration: 1,
          assetIds: input.assetIds,
          initiatedBy: input.initiatedBy,
          address: input.address,
          phase: "finalized",
          uid: photoshoot.uid,
        };
        const stageMeta = JSON.stringify({
          from: "raw_review",
          to: "editing_autohdr",
          trigger: "autohdr_api_send",
          jobId: input.jobId,
          uid: photoshoot.uid,
        });
        const finalizedMeta = JSON.stringify({
          provider: "autohdr_api_v4",
          jobId: input.jobId,
          uid: photoshoot.uid,
          assetCount: input.assetIds.length,
          retrievalEnabled: false,
        });
        const stageAuditId = crypto.randomUUID();
        const stageOutcome = await commitAutomaticStage({
          env: this.env,
          projectId: input.projectId,
          from: "raw_review",
          to: "editing_autohdr",
          auditId: stageAuditId,
          auditActorId: input.initiatedBy,
          auditMetaJson: stageMeta,
          now,
          prefix: [
            this.env.DB.prepare("UPDATE jobs SET error = NULL, payload_json = ?, updated_at = ? WHERE id = ? AND kind = 'autohdr_api_send' AND status = 'running'")
              .bind(JSON.stringify(payload), now, input.jobId),
            this.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, ?, 'project.autohdr_api_send.finalized', 'project', ?, ?, ?)")
              .bind(crypto.randomUUID(), input.initiatedBy, input.projectId, finalizedMeta, now),
          ],
          workflow: {
            kind: "autohdr_job_entry",
            prerequisite: {
              kind: "autohdr_job",
              jobId: input.jobId,
              projectId: input.projectId,
              generation: 1,
              jobKind: "autohdr_api_send",
              expectedPriorToken: null,
              db: this.env.DB,
              auditId: stageAuditId,
              now,
            },
          },
        });
        if (stageOutcome.kind === "invariant_failure") throw new Error(`AutoHDR job ${input.jobId} Stage entry invariant failed`);
        await setJobStatus(dbFor(this.env), input.jobId, "done");
        return { stageAdvanced: stageOutcome.kind === "winner" };
      });

      if (completion.stageAdvanced) {
        try {
          await notifyProject(this.env, input.projectId, "sent_to_editing");
        } catch (notificationError) {
          // AutoHDR has already accepted the photos and the job/stage commit is durable. A
          // notification outage must not relabel that irreversible provider action as failed.
          console.error("AutoHDR API send notification failed", {
            projectId: input.projectId,
            jobId: input.jobId,
            error: errorMessage(notificationError),
          });
        }
      }
    } catch (error) {
      await setJobStatus(dbFor(this.env), input.jobId, "failed", errorMessage(error));
      throw error;
    }
  }
}
