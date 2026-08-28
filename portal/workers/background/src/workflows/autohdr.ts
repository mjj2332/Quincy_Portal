import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { appendToStageBottomExpr } from "@quincy/db";
import { assets, autoHdrHandoffs, autoHdrSentFiles, collections, projects } from "@quincy/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { computeRemovalAssetIds } from "@quincy/shared";

import { autoHdrRawInputPath, deriveAutoHdrFolderName, reconstructSourcePath } from "../autohdr/paths";
import { copyBatch, copyBatchCheck, createFolder, deleteBatch, deleteBatchCheck, getMetadata, isDropboxPathNotFound, listFolderContinue, listFolderIfExists, type DropboxCopyBatchEntryResult, type DropboxDeleteBatchCheckResult, type DropboxDeleteBatchResult, upload } from "../dropbox/client";
import { dropboxPathKey } from "../dropbox/paths";
import { pathFromRawFolderLink } from "../dropbox/sync";
import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import { setJobStatus } from "../lib/jobs";
import { confirmAutoHdrHandoff } from "../autohdr/claims";
import { notifyProject } from "../notifications";
import { requireBoardSchemaReady } from "../lib/board-schema";

export interface AutoHdrInput {
  projectId: string;
  assetIds: string[];
  jobId: string;
  handoffId?: string;
  connectionId?: string;
  mappingGeneration?: number;
  initiatedBy?: string | null;
  retiredHandoffId?: string;
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

export function throwOnCopyFailures(entries: DropboxCopyBatchEntryResult[], inputs: { from_path: string; to_path: string }[]): void {
  const hard: { from?: string; to?: string; failure: Record<string, unknown> }[] = [];
  entries.forEach((entry, index) => {
    if (entry[".tag"] !== "failure") return;
    if (isDestinationConflict(entry.failure)) return;
    hard.push({ from: inputs[index]?.from_path, to: inputs[index]?.to_path, failure: entry.failure });
  });
  if (hard.length > 0) throw new Error(`Dropbox copy_batch_v2 failed: ${JSON.stringify(hard)}`);
}

async function handoffIsStarted(env: Env, handoffId: string): Promise<boolean> {
  const row = await dbFor(env).select({ id: autoHdrHandoffs.id }).from(autoHdrHandoffs)
    .where(and(eq(autoHdrHandoffs.id, handoffId), eq(autoHdrHandoffs.state, "started"))).get();
  return Boolean(row);
}

export async function recordSentFiles(
  env: Env,
  input: AutoHdrInput,
  entries: DropboxCopyBatchEntryResult[],
  destinations: { assetId: string; toPath: string }[],
): Promise<void> {
  const successful = entries.flatMap((entry, index) => entry[".tag"] === "success" && destinations[index] ? [destinations[index]!] : []);
  if (!successful.length || !input.handoffId) return;
  if (!await handoffIsStarted(env, input.handoffId)) return;
  const now = Date.now();
  await env.DB.batch(successful.map((item) => env.DB.prepare(
    "INSERT INTO autohdr_sent_files (id, handoff_id, asset_id, dropbox_path, dropbox_path_key, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = ? AND state = 'started') ON CONFLICT (handoff_id, asset_id) DO NOTHING",
  ).bind(crypto.randomUUID(), input.handoffId, item.assetId, item.toPath, dropboxPathKey(item.toPath), now, input.handoffId)));
}

type RemovalOutcome = { assetId: string; path: string; outcome: "removed" | "alreadyGone" | "failed"; reason?: string };
export type RemovalCandidate = { assetId: string; dropboxPath: string; dropboxPathKey: string; connectionId: string };
export type RemovalSelectedAsset = { assetId: string; filename: string };
export type RemovalAuditSummary = {
  retiredHandoffId?: string;
  newHandoffId?: string;
  removed: number;
  alreadyGone: number;
  failed: { assetId: string; path: string; reason?: string }[];
};
export type RemoveDeselectedDependencies = {
  loadSent?: () => Promise<RemovalCandidate[]>;
  loadSelected?: () => Promise<RemovalSelectedAsset[]>;
  getMetadata?: typeof getMetadata;
  deleteBatch?: typeof deleteBatch;
  deleteBatchCheck?: typeof deleteBatchCheck;
  writeAuditLog?: (summary: RemovalAuditSummary) => Promise<void>;
};

export async function removeDeselected(
  env: Env,
  input: AutoHdrInput,
  dependencies: RemoveDeselectedDependencies = {},
): Promise<{ removed: number; alreadyGone: number; failed: number }> {
  const outcomes: RemovalOutcome[] = [];
  try {
    if (input.retiredHandoffId) {
      const db = dbFor(env);
      const sent = await (dependencies.loadSent ?? (async () => db.select({
        assetId: autoHdrSentFiles.assetId,
        dropboxPath: autoHdrSentFiles.dropboxPath,
        dropboxPathKey: autoHdrSentFiles.dropboxPathKey,
        connectionId: autoHdrHandoffs.connectionId,
      }).from(autoHdrSentFiles).innerJoin(autoHdrHandoffs, eq(autoHdrSentFiles.handoffId, autoHdrHandoffs.id)).where(and(
        eq(autoHdrSentFiles.handoffId, input.retiredHandoffId!),
        eq(autoHdrHandoffs.projectId, input.projectId),
      ))))();
      const selected = await (dependencies.loadSelected ?? (async () => db.select({ assetId: assets.id, filename: assets.originalFilename }).from(assets)
        .innerJoin(collections, eq(assets.collectionId, collections.id)).where(and(
          eq(collections.projectId, input.projectId),
          eq(collections.kind, "raw"),
          inArray(assets.id, input.assetIds),
        ))))();
      const removalIds = new Set(computeRemovalAssetIds(sent, selected));
      const candidates = sent.filter((row) => removalIds.has(row.assetId));
      for (const candidate of candidates) {
        try {
          const metadata = await (dependencies.getMetadata ?? getMetadata)(env, db, candidate.dropboxPathKey, candidate.connectionId);
          if (metadata[".tag"] !== "file") {
            outcomes.push({ assetId: candidate.assetId, path: candidate.dropboxPath, outcome: "failed", reason: "Recorded Dropbox path is now a folder" });
            continue;
          }
        } catch (error) {
          if (isDropboxPathNotFound(error instanceof Error ? error.message : error)) {
            outcomes.push({ assetId: candidate.assetId, path: candidate.dropboxPath, outcome: "alreadyGone" });
          } else {
            outcomes.push({ assetId: candidate.assetId, path: candidate.dropboxPath, outcome: "failed", reason: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      const toDelete = candidates.filter((candidate) => !outcomes.some((outcome) => outcome.assetId === candidate.assetId));
      for (let offset = 0; offset < toDelete.length; offset += COPY_BATCH_MAX_ENTRIES) {
        const chunk = toDelete.slice(offset, offset + COPY_BATCH_MAX_ENTRIES);
        const live = await db.select({ id: autoHdrHandoffs.id }).from(autoHdrHandoffs).innerJoin(projects, eq(autoHdrHandoffs.projectId, projects.id)).where(and(
          eq(autoHdrHandoffs.id, input.handoffId ?? ""),
          eq(autoHdrHandoffs.state, "started"),
          eq(projects.id, input.projectId),
          sql`${projects.archivedAt} IS NULL`,
        )).get();
        if (!live) {
          for (const candidate of chunk) outcomes.push({ assetId: candidate.assetId, path: candidate.dropboxPath, outcome: "failed", reason: "Project or new AutoHDR handoff is no longer live" });
          continue;
        }
        try {
          let result: DropboxDeleteBatchResult | DropboxDeleteBatchCheckResult = await (dependencies.deleteBatch ?? deleteBatch)(env, db, chunk.map((candidate) => ({ path: candidate.dropboxPath })), chunk[0]!.connectionId);
          let asyncJobId = result[".tag"] === "async_job_id" ? result.async_job_id : null;
          for (let poll = 1; asyncJobId && poll <= COPY_BATCH_MAX_POLLS; poll += 1) {
            result = await (dependencies.deleteBatchCheck ?? deleteBatchCheck)(env, db, asyncJobId, chunk[0]!.connectionId);
            if (result[".tag"] !== "in_progress") asyncJobId = null;
          }
          if (asyncJobId) {
            for (const candidate of chunk) outcomes.push({ assetId: candidate.assetId, path: candidate.dropboxPath, outcome: "failed", reason: `Dropbox delete_batch did not complete after ${COPY_BATCH_MAX_POLLS} checks` });
          } else if (result[".tag"] === "failed") {
            for (const candidate of chunk) outcomes.push({ assetId: candidate.assetId, path: candidate.dropboxPath, outcome: "failed", reason: "Dropbox delete_batch failed" });
          } else if (result[".tag"] === "complete") {
            chunk.forEach((candidate, index) => {
              const entry = result.entries[index];
              if (entry?.[".tag"] === "success") outcomes.push({ assetId: candidate.assetId, path: candidate.dropboxPath, outcome: "removed" });
              else if (entry?.[".tag"] === "failure" && isDropboxPathNotFound(entry.failure)) outcomes.push({ assetId: candidate.assetId, path: candidate.dropboxPath, outcome: "alreadyGone" });
              else outcomes.push({ assetId: candidate.assetId, path: candidate.dropboxPath, outcome: "failed", reason: "Dropbox delete_batch entry failed" });
            });
          }
        } catch (error) {
          for (const candidate of chunk) outcomes.push({ assetId: candidate.assetId, path: candidate.dropboxPath, outcome: "failed", reason: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  } catch (error) {
    outcomes.push({ assetId: "remove-deselected", path: "", outcome: "failed", reason: error instanceof Error ? error.message : String(error) });
  }

  const summary: RemovalAuditSummary = {
      retiredHandoffId: input.retiredHandoffId,
      newHandoffId: input.handoffId,
      removed: outcomes.filter((item) => item.outcome === "removed").length,
      alreadyGone: outcomes.filter((item) => item.outcome === "alreadyGone").length,
      failed: outcomes.filter((item) => item.outcome === "failed").map((item) => ({ assetId: item.assetId, path: item.path, reason: item.reason })),
  };
  try {
    if (dependencies.writeAuditLog) await dependencies.writeAuditLog(summary);
    else await env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'autohdr.deselected_removed', 'project', ?, ?, ?)")
      .bind(crypto.randomUUID(), input.projectId, JSON.stringify(summary), Date.now()).run();
  } catch (error) {
    // There is no second durable sink available for an audit failure. Keep the step non-fatal,
    // preserve the counts represented by the one attempted summary row, and emit the failure.
    console.error("AutoHDR deselected-removal audit-log write failed", error);
  }
  return {
    removed: summary.removed,
    alreadyGone: summary.alreadyGone,
    failed: summary.failed.length,
  };
}

const COPY_BATCH_MAX_ENTRIES = 1_000;
const COPY_BATCH_MAX_POLLS = 45;

export class AutoHdrSend extends WorkflowEntrypoint<Env, AutoHdrInput> {
  async run(event: Readonly<WorkflowEvent<AutoHdrInput>>, step: WorkflowStep): Promise<void> {
    const input = event.payload;
    await requireBoardSchemaReady(this.env);
    try {
      await step.do("mark-send-running", async () => {
        const db = dbFor(this.env);
        await setJobStatus(db, input.jobId, "running");
        if (input.handoffId) {
          if (!input.connectionId || input.mappingGeneration === undefined || !input.initiatedBy) {
            throw new Error("Frozen AutoHDR handoff input is incomplete");
          }
          await confirmAutoHdrHandoff(this.env, {
            projectId: input.projectId,
            handoffId: input.handoffId,
            connectionId: input.connectionId,
            mappingGeneration: input.mappingGeneration,
            initiatedBy: input.initiatedBy,
            jobId: input.jobId,
          });
          const confirmed = await db.select({ state: autoHdrHandoffs.state, stageKey: projects.stageKey })
            .from(autoHdrHandoffs).innerJoin(projects, eq(autoHdrHandoffs.projectId, projects.id))
            .where(eq(autoHdrHandoffs.id, input.handoffId)).get();
          if (confirmed?.state !== "started" || confirmed.stageKey !== "editing_autohdr") {
            throw new Error("AutoHDR handoff confirmation lost its stage/ownership guard");
          }
        } else {
          const result = await db.update(projects).set({ stageKey: "editing_autohdr", boardPosition: appendToStageBottomExpr("editing_autohdr", input.projectId), updatedAt: new Date() })
            .where(and(eq(projects.id, input.projectId), eq(projects.stageKey, "raw_review"), sql`${projects.archivedAt} IS NULL`)).run();
          if ((result.meta.changes ?? 0) === 1) {
            await notifyProject(this.env, input.projectId, "sent_to_editing");
          } else {
            const current = await db.select({ stageKey: projects.stageKey, archivedAt: projects.archivedAt })
              .from(projects).where(eq(projects.id, input.projectId)).get();
            if (!current || current.archivedAt || current.stageKey !== "editing_autohdr") {
              throw new Error("AutoHDR send stage guard was lost before the transfer started");
            }
          }
        }
        return { status: "running", stageKey: "editing_autohdr" };
      });

      const rawAssets = await step.do("load-assets", async () => loadRawAssets(this.env, input));
      const { inputPath, rawFolderPath } = await step.do("resolve-input-path", async () => {
        const db = dbFor(this.env);
        const project = input.handoffId
          ? await db.select({ rawFolderPath: autoHdrHandoffs.frozenRawFolderPath, rawFolderLink: projects.rawFolderLink })
            .from(autoHdrHandoffs).innerJoin(projects, eq(autoHdrHandoffs.projectId, projects.id))
            .where(and(eq(autoHdrHandoffs.id, input.handoffId), eq(autoHdrHandoffs.projectId, input.projectId))).get()
          : await db.select({ rawFolderPath: projects.rawFolderPath, rawFolderLink: projects.rawFolderLink })
            .from(projects).where(eq(projects.id, input.projectId)).get();
        if (!project) throw new Error(`Project ${input.projectId} does not exist`);
        const rawFolderPath = project.rawFolderPath ?? await pathFromRawFolderLink(this.env, project.rawFolderLink, input.connectionId);
        if (!rawFolderPath) throw new Error(`Project ${input.projectId} has no Dropbox RAW folder configured`);
        return { rawFolderPath, inputPath: autoHdrRawInputPath(deriveAutoHdrFolderName(rawFolderPath)) };
      });

      await step.do("ensure-dest-folder", async () => {
        await createFolder(this.env, dbFor(this.env), inputPath, input.connectionId);
        return { inputPath };
      });

      const transfers = await step.do("skip-existing", async () => {
        const db = dbFor(this.env);
        const existingNames = new Set<string>();
        let page = await listFolderIfExists(this.env, db, inputPath, {}, input.connectionId);
        while (page) {
          for (const entry of page.entries) if (entry[".tag"] === "file") existingNames.add(entry.name.toLowerCase());
          if (!page.has_more) break;
          page = await listFolderContinue(this.env, db, page.cursor, input.connectionId);
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

      let superseded = false;
      for (let offset = 0; offset < transfers.copyable.length && !superseded; offset += COPY_BATCH_MAX_ENTRIES) {
        const chunk = transfers.copyable.slice(offset, offset + COPY_BATCH_MAX_ENTRIES);
        const submitted = chunk.map(({ fromPath, toPath }) => ({ from_path: fromPath, to_path: toPath }));
        const chunkNumber = (offset / COPY_BATCH_MAX_ENTRIES) + 1;
        const copyStepName = chunkNumber === 1 ? "copy-batch" : `copy-batch-${chunkNumber}`;
        const started = await step.do(copyStepName, async () => {
          if (input.handoffId && !await handoffIsStarted(this.env, input.handoffId)) return { asyncJobId: null, entries: null, superseded: true };
          const result = await copyBatch(this.env, dbFor(this.env), submitted, input.connectionId);
          if (result[".tag"] === "complete") {
            return { asyncJobId: null, entries: result.entries, superseded: false };
          }
          return { asyncJobId: result.async_job_id, entries: null, superseded: false };
        });
        superseded = started.superseded;

        let asyncJobId = started.asyncJobId;
        let completedEntries = started.entries;
        for (let attempt = 1; asyncJobId && attempt <= COPY_BATCH_MAX_POLLS; attempt += 1) {
          await step.sleep(`copy-batch-wait-${chunkNumber}-${attempt}`, "2 seconds");
          const check = await step.do(`copy-batch-check-${chunkNumber}-${attempt}`, async () => {
            const result = await copyBatchCheck(this.env, dbFor(this.env), asyncJobId!, input.connectionId);
            if (result[".tag"] === "complete") {
              return { complete: true, entries: result.entries };
            }
            return { complete: false, entries: null };
          });
          if (check.complete) { asyncJobId = null; completedEntries = check.entries; }
        }
        if (asyncJobId) throw new Error(`Dropbox copy_batch_v2 did not complete after ${COPY_BATCH_MAX_POLLS} checks`);
        if (completedEntries) {
          await step.do(chunkNumber === 1 ? "record-sent-files" : `record-sent-files-${chunkNumber}`, async () => {
            await recordSentFiles(this.env, input, completedEntries!, chunk.map(({ assetId, toPath }) => ({ assetId, toPath })));
            throwOnCopyFailures(completedEntries!, submitted);
            return { recorded: completedEntries!.filter((entry) => entry[".tag"] === "success").length };
          });
        }
      }

      for (const asset of transfers.fallback) {
        if (superseded) break;
        await step.do(`copy-fallback-${asset.id}`, async () => {
          if (input.handoffId && !await handoffIsStarted(this.env, input.handoffId)) { superseded = true; return { assetId: asset.id, superseded: true }; }
          const object = await this.env.MEDIA.get(asset.r2Key);
          if (!object) throw new Error(`Original RAW asset ${asset.id} is missing from R2`);
          const toPath = `${inputPath}/${asset.originalFilename}`;
          await upload(this.env, dbFor(this.env), toPath, object.body, input.connectionId);
          await recordSentFiles(this.env, input, [{ ".tag": "success" }], [{ assetId: asset.id, toPath }]);
          return { assetId: asset.id, superseded: false };
        });
      }

      if (input.retiredHandoffId) {
        await step.do("remove-deselected", async () => removeDeselected(this.env, input));
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
