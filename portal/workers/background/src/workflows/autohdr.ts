import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { assets, collections, projects } from "@quincy/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Env } from "../env";
import { download, listFolder, listFolderContinue, upload, type DropboxFile } from "../dropbox/client";
import { dbFor, errorMessage } from "../lib/db";
import { createJob, setJobStatus } from "../lib/jobs";

export interface AutoHdrInput {
  projectId: string;
  assetIds: string[];
}

interface RawAsset {
  id: string;
  originalFilename: string;
  r2Key: string;
}

interface ReturnedAsset {
  id: string;
  originalFilename: string;
  r2Key: string;
  bytes: number;
  contentHash: string | null;
  sourceRawAssetId: string;
}

const WAIT_INTERVAL = "15 minutes" as const;
const MAX_WAIT_TICKS = 48 * 4;

function requireAutoHdrPaths(env: Env): { input: string; output: string } {
  if (!env.AUTOHDR_IN_PATH || !env.AUTOHDR_OUT_PATH) {
    throw new Error(
      "TODO: configure AUTOHDR_IN_PATH and AUTOHDR_OUT_PATH after the real autoHDR Dropbox account is confirmed",
    );
  }
  return { input: env.AUTOHDR_IN_PATH.replace(/\/+$/, ""), output: env.AUTOHDR_OUT_PATH.replace(/\/+$/, "") };
}

function basename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").toLowerCase();
}

async function allFilesInFolder(env: Env, path: string): Promise<DropboxFile[]> {
  const db = dbFor(env);
  let page = await listFolder(env, db, path);
  const files: DropboxFile[] = [];
  while (true) {
    files.push(...page.entries.filter((entry): entry is DropboxFile => entry[".tag"] === "file"));
    if (!page.has_more) return files;
    page = await listFolderContinue(env, db, page.cursor);
  }
}

async function ensureEditedCollection(env: Env, projectId: string): Promise<string> {
  const db = dbFor(env);
  await db
    .insert(collections)
    .values({ id: crypto.randomUUID(), projectId, kind: "edited", status: "empty" })
    .onConflictDoNothing();
  const [collection] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.projectId, projectId), eq(collections.kind, "edited")))
    .limit(1);
  if (!collection) throw new Error(`Unable to resolve edited collection for project ${projectId}`);
  return collection.id;
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
  return rows.map(({ id, originalFilename, r2Key }) => ({ id, originalFilename, r2Key }));
}

async function ingestReturnedFiles(
  env: Env,
  projectId: string,
  rawAssets: readonly RawAsset[],
): Promise<ReturnedAsset[]> {
  const { output } = requireAutoHdrPaths(env);
  const db = dbFor(env);
  const rawByBasename = new Map(rawAssets.map((asset) => [basename(asset.originalFilename), asset]));
  const editedCollectionId = await ensureEditedCollection(env, projectId);
  const returned: ReturnedAsset[] = [];
  for (const file of await allFilesInFolder(env, output)) {
    const rawAsset = rawByBasename.get(basename(file.name));
    if (!rawAsset) continue;
    const [existing] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.sourceRawAssetId, rawAsset.id))
      .limit(1);
    if (existing) {
      returned.push({
        id: existing.id,
        originalFilename: file.name,
        r2Key: "",
        bytes: file.size,
        contentHash: file.content_hash ?? null,
        sourceRawAssetId: rawAsset.id,
      });
      continue;
    }

    const assetId = crypto.randomUUID();
    const r2Key = `projects/${projectId}/edited/${assetId}/${file.name}`;
    const source = await download(env, db, file.path_display ?? file.path_lower);
    if (!source.body) throw new Error(`Dropbox returned no body for edited file ${file.name}`);
    await env.MEDIA.put(r2Key, source.body, { httpMetadata: { contentType: "image/jpeg" } });
    const inserted = await db
      .insert(assets)
      .values({
        id: assetId,
        collectionId: editedCollectionId,
        kind: "photo",
        r2Key,
        originalFilename: file.name,
        bytes: file.size,
        contentHash: file.content_hash ?? null,
        source: "dropbox",
        sourceRawAssetId: rawAsset.id,
      })
      .onConflictDoNothing()
      .returning({ id: assets.id });
    if (inserted.length > 0) {
      await db
        .update(collections)
        .set({ receivedCount: sql`${collections.receivedCount} + 1`, status: "received", updatedAt: new Date() })
        .where(eq(collections.id, editedCollectionId));
      returned.push({
        id: assetId,
        originalFilename: file.name,
        r2Key,
        bytes: file.size,
        contentHash: file.content_hash ?? null,
        sourceRawAssetId: rawAsset.id,
      });
    }
  }
  return returned;
}

export class AutoHdrRoundtrip extends WorkflowEntrypoint<Env, AutoHdrInput> {
  async run(event: Readonly<WorkflowEvent<AutoHdrInput>>, step: WorkflowStep): Promise<void> {
    const input = event.payload;
    const jobId = await step.do("create-autohdr-job", async () => {
      const db = dbFor(this.env);
      const createdJobId = await createJob(db, {
        kind: "autohdr_roundtrip",
        projectId: input.projectId,
        payload: input,
      });
      await setJobStatus(db, createdJobId, "running");
      return createdJobId;
    });

    try {
      const rawAssets = await step.do("load-raw-assets", async () => loadRawAssets(this.env, input));
      await step.do("copy-to-autohdr", async () => {
        const { input: inputPath } = requireAutoHdrPaths(this.env);
        const db = dbFor(this.env);
        for (const asset of rawAssets) {
          const object = await this.env.MEDIA.get(asset.r2Key);
          if (!object) throw new Error(`Original RAW asset ${asset.id} is missing from R2`);
          // TODO: confirm autoHDR's required folder layout and filename-collision policy with the real account.
          await upload(this.env, db, `${inputPath}/${asset.originalFilename}`, object.body);
        }
        return { copied: rawAssets.length };
      });
      await step.do("mark-stage", async () => {
        const db = dbFor(this.env);
        await db
          .update(projects)
          .set({ stageKey: "editing_autohdr", updatedAt: new Date() })
          .where(eq(projects.id, input.projectId));
        return { stageKey: "editing_autohdr" };
      });

      for (let tick = 0; tick < MAX_WAIT_TICKS; tick += 1) {
        await step.sleep(`wait-for-autohdr-${tick}`, WAIT_INTERVAL);
        const returned = await step.do(`check-returned-${tick}`, async () =>
          ingestReturnedFiles(this.env, input.projectId, rawAssets),
        );
        const returnedSourceIds = new Set(returned.map((asset) => asset.sourceRawAssetId));
        if (rawAssets.every((asset) => returnedSourceIds.has(asset.id))) {
          await step.do("complete-autohdr-roundtrip", async () => {
            const db = dbFor(this.env);
            await db
              .update(projects)
              .set({ stageKey: "edited_review", updatedAt: new Date() })
              .where(eq(projects.id, input.projectId));
            await setJobStatus(db, jobId, "done");
            return { stageKey: "edited_review" };
          });
          return;
        }
      }
      await step.do("mark-autohdr-stuck", async () => {
        await setJobStatus(dbFor(this.env), jobId, "stuck", "Timed out waiting for autoHDR return files after 48 hours");
        return { status: "stuck" };
      });
    } catch (error) {
      await setJobStatus(dbFor(this.env), jobId, "failed", errorMessage(error));
      throw error;
    }
  }
}
