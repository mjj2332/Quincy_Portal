import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { assets, collections, projects } from "@quincy/db/schema";
import { eq, inArray } from "drizzle-orm";

import { autoHdrRawInputPath, deriveAutoHdrFolderName, reconstructSourcePath } from "../autohdr/paths";
import { copyBatch, copyBatchCheck, createFolder, listFolderContinue, listFolderIfExists, type DropboxCopyBatchEntryResult, upload } from "../dropbox/client";
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
  section: string | null;
  source: "upload" | "dropbox" | "tonomo";
  sourcePath: string | null;
}

async function loadRawAssets(env: Env, input: AutoHdrInput): Promise<RawAsset[]> {
  if (input.assetIds.length === 0) throw new Error("autoHDR requires at least one selected RAW asset");
  const db = dbFor(env);
  const rows = await db
    .select({
      id: assets.id,
      originalFilename: assets.originalFilename,
      r2Key: assets.r2Key,
      section: assets.section,
      source: assets.source,
      sourcePath: assets.sourcePath,
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
  return rows.map(({ id, originalFilename, r2Key, section, source, sourcePath }) => ({
    id,
    originalFilename,
    r2Key,
    section,
    source,
    sourcePath,
  }));
}

function tagOf(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && typeof (value as Record<string, unknown>)[".tag"] === "string"
    ? (value as Record<string, string>)[".tag"]
    : undefined;
}

/** True ONLY for a destination-side (`to`) write conflict — the file is already at the target,
 *  which for our immutable RAW copies is the desired end state. This makes copy retries and
 *  re-sends idempotent (a resubmitted batch after a lost response or premature poll-timeout returns
 *  to/conflict per entry, which we accept). A source-side (`from_*`) conflict is a real failure and
 *  must NOT be masked. Tolerates Dropbox nesting the RelocationError or inlining it. */
function isDestinationConflict(failure: Record<string, unknown>): boolean {
  const reloc = tagOf(failure) === "relocation_error" && typeof failure.relocation_error === "object" && failure.relocation_error !== null
    ? failure.relocation_error as Record<string, unknown>
    : failure;
  if (tagOf(reloc) !== "to") return false;
  return tagOf(reloc.to) === "conflict";
}

function throwOnCopyFailures(entries: DropboxCopyBatchEntryResult[], inputs: { from_path: string; to_path: string }[]): void {
  const hard: { from?: string; to?: string; failure: Record<string, unknown> }[] = [];
  entries.forEach((entry, index) => {
    if (entry[".tag"] !== "failure") return;
    if (isDestinationConflict(entry.failure)) return;
    hard.push({ from: inputs[index]?.from_path, to: inputs[index]?.to_path, failure: entry.failure });
  });
  if (hard.length > 0) throw new Error(`Dropbox copy_batch_v2 failed: ${JSON.stringify(hard)}`);
}

const COPY_BATCH_MAX_ENTRIES = 1_000;
const COPY_BATCH_MAX_POLLS = 45;

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

      const rawAssets = await step.do("load-assets", async () => loadRawAssets(this.env, input));
      const { inputPath, rawFolderPath } = await step.do("resolve-input-path", async () => {
        const db = dbFor(this.env);
        const [project] = await db
          .select({ rawFolderPath: projects.rawFolderPath, rawFolderLink: projects.rawFolderLink })
          .from(projects)
          .where(eq(projects.id, input.projectId))
          .limit(1);
        if (!project) throw new Error(`Project ${input.projectId} does not exist`);
        const rawFolderPath = project.rawFolderPath ?? await pathFromRawFolderLink(this.env, project.rawFolderLink);
        if (!rawFolderPath) throw new Error(`Project ${input.projectId} has no Dropbox RAW folder configured`);
        return { rawFolderPath, inputPath: autoHdrRawInputPath(deriveAutoHdrFolderName(rawFolderPath)) };
      });

      await step.do("ensure-dest-folder", async () => {
        await createFolder(this.env, dbFor(this.env), inputPath);
        return { inputPath };
      });

      const transfers = await step.do("skip-existing", async () => {
        const db = dbFor(this.env);
        const existingNames = new Set<string>();
        let page = await listFolderIfExists(this.env, db, inputPath);
        while (page) {
          for (const entry of page.entries) if (entry[".tag"] === "file") existingNames.add(entry.name.toLowerCase());
          if (!page.has_more) break;
          page = await listFolderContinue(this.env, db, page.cursor);
        }
        const copyable: { assetId: string; fromPath: string; toPath: string }[] = [];
        const fallback: RawAsset[] = [];
        for (const asset of rawAssets) {
          if (existingNames.has(asset.originalFilename.toLowerCase())) continue;
          const fromPath = asset.sourcePath ?? reconstructSourcePath(rawFolderPath, asset.section, asset.originalFilename);
          if (asset.source === "dropbox" && fromPath.trim()) {
            copyable.push({ assetId: asset.id, fromPath, toPath: `${inputPath}/${asset.originalFilename}` });
          } else {
            fallback.push(asset);
          }
        }
        return { copyable, fallback };
      });

      for (let offset = 0; offset < transfers.copyable.length; offset += COPY_BATCH_MAX_ENTRIES) {
        const chunk = transfers.copyable.slice(offset, offset + COPY_BATCH_MAX_ENTRIES);
        const submitted = chunk.map(({ fromPath, toPath }) => ({ from_path: fromPath, to_path: toPath }));
        const chunkNumber = (offset / COPY_BATCH_MAX_ENTRIES) + 1;
        const copyStepName = chunkNumber === 1 ? "copy-batch" : `copy-batch-${chunkNumber}`;
        const started = await step.do(copyStepName, async () => {
          const result = await copyBatch(this.env, dbFor(this.env), submitted);
          if (result[".tag"] === "complete") {
            throwOnCopyFailures(result.entries, submitted);
            return { asyncJobId: null };
          }
          return { asyncJobId: result.async_job_id };
        });

        let asyncJobId = started.asyncJobId;
        for (let attempt = 1; asyncJobId && attempt <= COPY_BATCH_MAX_POLLS; attempt += 1) {
          await step.sleep(`copy-batch-wait-${chunkNumber}-${attempt}`, "2 seconds");
          const check = await step.do(`copy-batch-check-${chunkNumber}-${attempt}`, async () => {
            const result = await copyBatchCheck(this.env, dbFor(this.env), asyncJobId!);
            if (result[".tag"] === "complete") {
              throwOnCopyFailures(result.entries, submitted);
              return { complete: true };
            }
            return { complete: false };
          });
          if (check.complete) asyncJobId = null;
        }
        if (asyncJobId) throw new Error(`Dropbox copy_batch_v2 did not complete after ${COPY_BATCH_MAX_POLLS} checks`);
      }

      for (const asset of transfers.fallback) {
        await step.do(`copy-fallback-${asset.id}`, async () => {
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
