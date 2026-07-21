import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { assets, collections, projects } from "@quincy/db/schema";
import { eq, inArray } from "drizzle-orm";

import { autoHdrRawInputPath, deriveAutoHdrFolderName } from "../autohdr/paths";
import { upload } from "../dropbox/client";
import { pathFromRawFolderLink } from "../dropbox/sync";
import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import { setJobStatus } from "../lib/jobs";

export interface AutoHdrInput {
  projectId: string;
  assetIds: string[];
  jobId: string;
}

interface RawAsset {
  id: string;
  originalFilename: string;
  r2Key: string;
}

async function loadRawAssets(env: Env, input: AutoHdrInput): Promise<RawAsset[]> {
  if (input.assetIds.length === 0) throw new Error("autoHDR requires at least one selected RAW asset");
  const db = dbFor(env);
  const rows = await db
    .select({
      id: assets.id,
      originalFilename: assets.originalFilename,
      r2Key: assets.r2Key,
      projectId: collections.projectId,
      collectionKind: collections.kind,
    })
    .from(assets)
    .innerJoin(collections, eq(assets.collectionId, collections.id))
    .where(inArray(assets.id, input.assetIds));
  if (rows.length !== input.assetIds.length || rows.some((row) => row.projectId !== input.projectId || row.collectionKind !== "raw")) {
    throw new Error("All autoHDR asset IDs must be RAW assets in the requested project");
  }
  // Each selected frame maps to one Dropbox path by filename; a case-insensitive collision would
  // silently overwrite in the AutoHDR input folder, so refuse it up front.
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.originalFilename.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate RAW filename selected for autoHDR: ${row.originalFilename}. Rename so every selected frame is unique.`);
    seen.add(key);
  }
  return rows.map(({ id, originalFilename, r2Key }) => ({ id, originalFilename, r2Key }));
}

export class AutoHdrSend extends WorkflowEntrypoint<Env, AutoHdrInput> {
  async run(event: Readonly<WorkflowEvent<AutoHdrInput>>, step: WorkflowStep): Promise<void> {
    const input = event.payload;
    try {
      await step.do("mark-send-running", async () => {
        const db = dbFor(this.env);
        await setJobStatus(db, input.jobId, "running");
        await db
          .update(projects)
          .set({ stageKey: "editing_autohdr", updatedAt: new Date() })
          .where(eq(projects.id, input.projectId));
        return { status: "running", stageKey: "editing_autohdr" };
      });

      const rawAssets = await step.do("load-raw-assets", async () => loadRawAssets(this.env, input));
      const { inputPath } = await step.do("resolve-input-path", async () => {
        const db = dbFor(this.env);
        const [project] = await db
          .select({ rawFolderPath: projects.rawFolderPath, rawFolderLink: projects.rawFolderLink })
          .from(projects)
          .where(eq(projects.id, input.projectId))
          .limit(1);
        if (!project) throw new Error(`Project ${input.projectId} does not exist`);
        const rawFolderPath = project.rawFolderPath ?? await pathFromRawFolderLink(this.env, project.rawFolderLink);
        if (!rawFolderPath) throw new Error(`Project ${input.projectId} has no Dropbox RAW folder configured`);
        return { inputPath: autoHdrRawInputPath(deriveAutoHdrFolderName(rawFolderPath)) };
      });

      for (const asset of rawAssets) {
        await step.do(`copy-${asset.id}`, async () => {
          const object = await this.env.MEDIA.get(asset.r2Key);
          if (!object) throw new Error(`Original RAW asset ${asset.id} is missing from R2`);
          await upload(this.env, dbFor(this.env), `${inputPath}/${asset.originalFilename}`, object.body);
          return { assetId: asset.id };
        });
      }

      await step.do("complete-send", async () => {
        await setJobStatus(dbFor(this.env), input.jobId, "done");
        return { status: "done" };
      });
    } catch (error) {
      await setJobStatus(dbFor(this.env), input.jobId, "failed", errorMessage(error));
      throw error;
    }
  }
}
