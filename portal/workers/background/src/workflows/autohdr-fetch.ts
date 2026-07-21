import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings } from "@quincy/db";
import { assets, collections, projects, selections } from "@quincy/db/schema";
import { enqueueRenditionSafely, isAcceptedPhotoFilename } from "@quincy/shared";
import { and, eq } from "drizzle-orm";

import { autoHdrFinalPathCandidates, deriveAutoHdrFolderName } from "../autohdr/paths";
import { createDropboxClientContext, download, listFolderContinue, listFolderIfExists, type DropboxFile } from "../dropbox/client";
import { pathFromRawFolderLink } from "../dropbox/sync";
import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import { setJobStatus } from "../lib/jobs";

export interface AutoHdrFetchInput {
  projectId: string;
  jobId: string;
}

interface RawAsset {
  id: string;
  originalFilename: string;
}

/** Original-capture identity: extension stripped and lowercased. RAW files carry no export suffix,
 *  so RAW assets are always keyed by this (injective across distinct filenames). */
function plainBasename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").toLowerCase();
}

/** A final's fallback identity: `plainBasename` with a trailing add-on suffix (`_vs`, `-staged`, …)
 *  removed. Applied ONLY to returned finals, never to RAW keys, so `kitchen.jpg` and
 *  `kitchen_staged.jpg` cannot collapse into the same RAW key. */
function strippedBasename(filename: string): string {
  return plainBasename(filename).replace(/[ _-]+(?:vs|staged)$/i, "");
}

async function ensureEditedCollection(env: Env, projectId: string): Promise<{ id: string }> {
  const db = dbFor(env);
  await db
    .insert(collections)
    .values({ id: crypto.randomUUID(), projectId, kind: "edited", status: "empty" })
    .onConflictDoNothing();
  const collection = await db
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.projectId, projectId), eq(collections.kind, "edited")))
    .get();
  if (!collection) throw new Error(`Unable to resolve edited collection for project ${projectId}`);
  return collection;
}

async function rawAssetsByBasename(env: Env, projectId: string): Promise<Map<string, RawAsset>> {
  const rows = await dbFor(env)
    .select({ id: assets.id, originalFilename: assets.originalFilename })
    .from(assets)
    .innerJoin(collections, eq(assets.collectionId, collections.id))
    .where(and(eq(collections.projectId, projectId), eq(collections.kind, "raw")));
  return new Map(rows.map((row) => [plainBasename(row.originalFilename), row]));
}

export class AutoHdrFetch extends WorkflowEntrypoint<Env, AutoHdrFetchInput> {
  async run(event: Readonly<WorkflowEvent<AutoHdrFetchInput>>, step: WorkflowStep): Promise<void> {
    const input = event.payload;
    try {
      await step.do("mark-fetch-running", async () => {
        await setJobStatus(dbFor(this.env), input.jobId, "running");
        return { status: "running" };
      });

      const finalPaths = await step.do("resolve-final-paths", async () => {
        const db = dbFor(this.env);
        const project = await db
          .select({ rawFolderPath: projects.rawFolderPath, rawFolderLink: projects.rawFolderLink })
          .from(projects)
          .where(eq(projects.id, input.projectId))
          .get();
        if (!project) throw new Error(`Project ${input.projectId} does not exist`);
        const rawFolderPath = project.rawFolderPath ?? await pathFromRawFolderLink(this.env, project.rawFolderLink);
        if (!rawFolderPath) throw new Error(`Project ${input.projectId} has no Dropbox RAW folder configured`);
        return autoHdrFinalPathCandidates(deriveAutoHdrFolderName(rawFolderPath));
      });

      const finalFiles = await step.do("list-finals", async () => {
        const db = dbFor(this.env);
        const client = await createDropboxClientContext(this.env, db);
        for (const path of finalPaths) {
          let page = await listFolderIfExists(this.env, db, path, {}, undefined, client);
          if (!page) continue;
          const files: DropboxFile[] = [];
          while (true) {
            files.push(...page.entries.filter((entry): entry is DropboxFile => entry[".tag"] === "file" && isAcceptedPhotoFilename(entry.name)));
            if (!page.has_more) return files;
            page = await listFolderContinue(this.env, db, page.cursor, undefined, client);
          }
        }
        return [] as DropboxFile[];
      });

      const result = await step.do("ingest", async () => {
        const db = dbFor(this.env);
        const [editedCollection, rawByBasename] = await Promise.all([
          ensureEditedCollection(this.env, input.projectId),
          rawAssetsByBasename(this.env, input.projectId),
        ]);
        let ingested = 0;
        let skipped = 0;
        for (const file of finalFiles) {
          const existing = await db
            .select({ id: assets.id })
            .from(assets)
            .where(and(eq(assets.collectionId, editedCollection.id), eq(assets.originalFilename, file.name)))
            .get();
          if (existing) {
            skipped += 1;
            continue;
          }

          const assetId = crypto.randomUUID();
          const r2Key = `projects/${input.projectId}/edited/${assetId}/${file.name}`;
          const source = await download(this.env, db, file.path_display ?? file.path_lower);
          if (!source.body) throw new Error(`Dropbox returned no body for ${file.name}`);
          await this.env.MEDIA.put(r2Key, source.body, { httpMetadata: { contentType: "image/jpeg" } });

          const now = new Date();
          const matched = rawByBasename.get(plainBasename(file.name)) ?? rawByBasename.get(strippedBasename(file.name));
          await this.env.DB.batch([
            this.env.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, source_raw_asset_id, created_at, updated_at) VALUES (?, ?, 'photo', ?, ?, ?, ?, 'dropbox', ?, ?, ?)")
              .bind(assetId, editedCollection.id, r2Key, file.name, file.size, file.content_hash ?? null, matched?.id ?? null, now.getTime(), now.getTime()),
            this.env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(editedCollection.id, now.getTime())),
          ]);
          await enqueueRenditionSafely(this.env, assetId, "autohdr-fetch");
          ingested += 1;
        }
        return { ingested, skipped };
      });

      await step.do("advance-stage", async () => {
        const db = dbFor(this.env);
        const [selectedRawAssets, editedAssets] = await Promise.all([
          db.select({ id: assets.id })
            .from(selections)
            .innerJoin(assets, eq(selections.assetId, assets.id))
            .innerJoin(collections, eq(assets.collectionId, collections.id))
            .where(and(eq(selections.state, "selected_for_editing"), eq(collections.projectId, input.projectId), eq(collections.kind, "raw"))),
          db.select({ sourceRawAssetId: assets.sourceRawAssetId })
            .from(assets)
            .innerJoin(collections, eq(assets.collectionId, collections.id))
            .where(and(eq(collections.projectId, input.projectId), eq(collections.kind, "edited"))),
        ]);
        const returnedSourceIds = new Set(editedAssets.flatMap((asset) => asset.sourceRawAssetId ? [asset.sourceRawAssetId] : []));
        const readyForReview = selectedRawAssets.length > 0 && selectedRawAssets.every((asset) => returnedSourceIds.has(asset.id));
        if (readyForReview) {
          // Only advance from the canonical predecessor so a re-fetch on a delivered project
          // never silently regresses its stage.
          await db.update(projects).set({ stageKey: "edited_review", updatedAt: new Date() }).where(and(eq(projects.id, input.projectId), eq(projects.stageKey, "editing_autohdr")));
        }
        return { stageAdvanced: readyForReview };
      });

      await step.do("complete-fetch", async () => {
        await setJobStatus(dbFor(this.env), input.jobId, "done");
        return { status: "done", ...result };
      });
    } catch (error) {
      await setJobStatus(dbFor(this.env), input.jobId, "failed", errorMessage(error));
      throw error;
    }
  }
}
