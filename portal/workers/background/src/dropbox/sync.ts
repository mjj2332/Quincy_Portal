import { assets, collections, projects } from "@quincy/db/schema";
import { isAcceptedPhotoFilename, parseXmpRating, XMP_SCAN_BYTES, xmpRatingToStars } from "@quincy/shared";
import { and, eq, isNull, or, sql } from "drizzle-orm";

import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import { createJob, setJobStatus } from "../lib/jobs";
import type { IngestMessage } from "../messages";
import { download, getSharedLinkMetadata, listFolder, listFolderContinue, type DropboxFile } from "./client";

function normalisePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

async function pathFromRawFolderLink(env: Env, rawFolderLink: string | null, connectionId?: string): Promise<string | null> {
  if (!rawFolderLink) return null;
  let url: URL;
  try {
    url = new URL(rawFolderLink);
  } catch {
    // A manually entered Dropbox path is also a useful fallback.
    if (rawFolderLink.startsWith("/")) return normalisePath(rawFolderLink);
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "dropbox.com" && hostname !== "www.dropbox.com" && !hostname.endsWith(".dropbox.com")) throw new Error("Dropbox RAW folder link must use a dropbox.com URL");
  const queryPath = url.searchParams.get("path");
  if (queryPath) return normalisePath(queryPath);
  const homeMarker = "/home";
  const markerIndex = url.pathname.toLowerCase().indexOf(homeMarker);
  if (markerIndex !== -1) return normalisePath(decodeURIComponent(url.pathname.slice(markerIndex + homeMarker.length)));
  return normalisePath(await getSharedLinkMetadata(env, dbFor(env), rawFolderLink, connectionId));
}

function expectedCountFromFolder(path: string): number | null {
  const folderName = decodeURIComponent(path.split("/").filter(Boolean).at(-1) ?? "");
  const match = folderName.match(/\[\s*expected\s+(\d+)\s*\]|-\s*(\d+)\s*$/i);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return null;
  const count = Number.parseInt(raw, 10);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

async function allFolderFiles(env: Env, path: string, connectionId?: string): Promise<DropboxFile[]> {
  const db = dbFor(env);
  let page = await listFolder(env, db, path, { recursive: false }, connectionId);
  const files: DropboxFile[] = [];
  while (true) {
    files.push(...page.entries.filter((entry): entry is DropboxFile => entry[".tag"] === "file"));
    if (!page.has_more) return files;
    page = await listFolderContinue(env, db, page.cursor, connectionId);
  }
}

async function ensureRawCollection(env: Env, projectId: string): Promise<{ id: string; expectedCount: number | null }> {
  const db = dbFor(env);
  await db
    .insert(collections)
    .values({ id: crypto.randomUUID(), projectId, kind: "raw", status: "empty" })
    .onConflictDoNothing();
  const [collection] = await db
    .select({ id: collections.id, expectedCount: collections.expectedCount })
    .from(collections)
    .where(and(eq(collections.projectId, projectId), eq(collections.kind, "raw")))
    .limit(1);
  if (!collection) throw new Error(`Unable to resolve RAW collection for project ${projectId}`);
  return collection;
}

/**
 * Ingests Dropbox JPEGs one at a time. The content hash is the idempotency key;
 * the queue carries only the new asset ID to stay under the 128 KB message cap.
 */
export async function syncProjectRawFolder(
  env: Env,
  projectId: string,
  jobId?: string,
  connectionId?: string,
): Promise<void> {
  const db = dbFor(env);
  const trackingJobId = jobId ?? await createJob(db, {
    kind: "dropbox_sync",
    projectId,
    correlationId: `dropbox_sync:${projectId}`,
  });
  await setJobStatus(db, trackingJobId, "running");

  try {
    const [project] = await db
      .select({ rawFolderPath: projects.rawFolderPath, rawFolderLink: projects.rawFolderLink })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw new Error(`Project ${projectId} does not exist`);

    const rawFolderPath = project.rawFolderPath ? normalisePath(project.rawFolderPath) : normalisePath(await pathFromRawFolderLink(env, project.rawFolderLink, connectionId) ?? "");
    if (!rawFolderPath) throw new Error(`Project ${projectId} has no resolvable Dropbox RAW folder path`);
    if (!project.rawFolderPath) await db.update(projects).set({ rawFolderPath, updatedAt: new Date() }).where(and(eq(projects.id, projectId), or(isNull(projects.rawFolderPath), eq(projects.rawFolderPath, ""))));

    const collection = await ensureRawCollection(env, projectId);
    const expectedCount = expectedCountFromFolder(rawFolderPath);
    if (collection.expectedCount === null && expectedCount !== null) {
      await db
        .update(collections)
        .set({ expectedCount, updatedAt: new Date() })
        .where(and(eq(collections.id, collection.id), isNull(collections.expectedCount)));
    }

    const files = await allFolderFiles(env, rawFolderPath, connectionId);
    for (const file of files) {
      if (!isAcceptedPhotoFilename(file.name)) continue;
      if (file.content_hash) {
        const [existing] = await db
          .select({ id: assets.id })
          .from(assets)
          .where(eq(assets.contentHash, file.content_hash))
          .limit(1);
        if (existing) continue;
      }

      const assetId = crypto.randomUUID();
      const r2Key = `projects/${projectId}/raw/${assetId}/${file.name}`;
      const sourcePath = file.path_display ?? file.path_lower;
      const source = await download(env, db, sourcePath, {}, connectionId);
      if (!source.body) throw new Error(`Dropbox returned no body for ${file.name}`);
      await env.MEDIA.put(r2Key, source.body, {
        httpMetadata: { contentType: "image/jpeg" },
      });

      const header = await download(env, db, sourcePath, { range: `bytes=0-${XMP_SCAN_BYTES - 1}` }, connectionId);
      const rating = xmpRatingToStars(parseXmpRating(await header.arrayBuffer()));
      const inserted = await db
        .insert(assets)
        .values({
          id: assetId,
          collectionId: collection.id,
          kind: "photo",
          r2Key,
          originalFilename: file.name,
          bytes: file.size,
          contentHash: file.content_hash ?? null,
          source: "dropbox",
          ratingFromMetadata: rating,
        })
        .onConflictDoNothing()
        .returning({ id: assets.id });

      if (inserted.length === 0) continue;
      await db
        .update(collections)
        .set({ receivedCount: sql`${collections.receivedCount} + 1`, status: "received", updatedAt: new Date() })
        .where(eq(collections.id, collection.id));
      const message: IngestMessage = { type: "asset_ingested", assetId };
      await env.INGEST_QUEUE.send(message);
    }
    await setJobStatus(db, trackingJobId, "done");
  } catch (error) {
    await setJobStatus(db, trackingJobId, "failed", errorMessage(error));
    throw error;
  }
}
