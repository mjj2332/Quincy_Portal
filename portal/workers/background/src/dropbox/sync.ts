import { COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings } from "@quincy/db";
import { assets, collections, jobs, projects } from "@quincy/db/schema";
import { enqueueRenditionSafely, isAcceptedPhotoFilename, parseXmpRating, XMP_SCAN_BYTES, xmpRatingToStars } from "@quincy/shared";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import { createJob, setJobStatus } from "../lib/jobs";
import { createDropboxClientContext, download, getSharedLinkMetadata, listFolder, listFolderContinue, recordDropboxSuccess, type DropboxClientContext, type DropboxFile } from "./client";

const MAX_DOWNLOADS_PER_RUN = 150;

export function normalisePath(path: string): string {
  let normalised = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (/^\/(?:users|volumes)\//i.test(normalised)) {
    const segments = normalised.split("/");
    // Matches team-space roots ("Quincy Productions Dropbox") and the personal "Dropbox" folder,
    // without stripping unrelated segments that merely contain the word.
    const dropboxIndex = segments.findIndex((segment) => /(?:^| )Dropbox$/i.test(segment));
    if (dropboxIndex !== -1) normalised = segments.slice(dropboxIndex + 1).join("/");
  }
  normalised = normalised.replace(/^\/+|\/+$/g, "");
  return normalised ? `/${normalised}` : "";
}

export async function pathFromRawFolderLink(env: Env, rawFolderLink: string | null, connectionId?: string, client?: DropboxClientContext): Promise<string | null> {
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
  return normalisePath(await getSharedLinkMetadata(env, dbFor(env), rawFolderLink, connectionId, client));
}

function expectedCountFromFolder(path: string): number | null {
  const folderName = decodeURIComponent(path.split("/").filter(Boolean).at(-1) ?? "");
  const match = folderName.match(/\[\s*expected\s+(\d+)\s*\]|-\s*(\d+)\s*$/i);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return null;
  const count = Number.parseInt(raw, 10);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

async function allFolderFiles(env: Env, path: string, connectionId: string | undefined, client: DropboxClientContext): Promise<DropboxFile[]> {
  const db = dbFor(env);
  let page = await listFolder(env, db, path, { recursive: true }, connectionId, client);
  const files: DropboxFile[] = [];
  while (true) {
    files.push(...page.entries.filter((entry): entry is DropboxFile => entry[".tag"] === "file"));
    if (!page.has_more) return files;
    page = await listFolderContinue(env, db, page.cursor, connectionId, client);
  }
}

export const SKIP_DROPBOX_SECTION = Symbol("skip-dropbox-section");

/** Root files are Captures; only immediate Dropbox subfolders become named sections. */
export function sectionForDropboxFile(file: DropboxFile, rootPath: string): string | null | typeof SKIP_DROPBOX_SECTION {
  const rootSegments = normalisePath(rootPath).toLowerCase().split("/").filter(Boolean);
  const lowerSegments = normalisePath(file.path_lower).toLowerCase().split("/").filter(Boolean);
  if (lowerSegments.length <= rootSegments.length || rootSegments.some((segment, index) => lowerSegments[index] !== segment)) return SKIP_DROPBOX_SECTION;
  const displaySegments = normalisePath(file.path_display ?? file.path_lower).split("/").filter(Boolean);
  const relative = displaySegments.slice(rootSegments.length);
  if (relative.length === 1) return null;
  return relative.length === 2 ? relative[0]! : SKIP_DROPBOX_SECTION;
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
      .select({ rawFolderPath: projects.rawFolderPath, rawFolderLink: projects.rawFolderLink, archivedAt: projects.archivedAt })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw new Error(`Project ${projectId} does not exist`);
    // Writer-side guard: archived projects are deletable, and deletion races any sync that
    // slips in after its active-jobs check — refuse at the source, not just at the trigger.
    if (project.archivedAt) throw new Error(`Project ${projectId} is archived — Dropbox sync refused`);

    const client = await createDropboxClientContext(env, db, connectionId);
    const rawFolderPath = project.rawFolderPath ? normalisePath(project.rawFolderPath) : normalisePath(await pathFromRawFolderLink(env, project.rawFolderLink, connectionId, client) ?? "");
    if (!rawFolderPath) throw new Error(`Project ${projectId} has no resolvable Dropbox RAW folder path`);

    const collection = await ensureRawCollection(env, projectId);
    const expectedCount = expectedCountFromFolder(rawFolderPath);
    if (collection.expectedCount === null && expectedCount !== null) {
      await db
        .update(collections)
        .set({ expectedCount, updatedAt: new Date() })
        .where(and(eq(collections.id, collection.id), isNull(collections.expectedCount)));
    }

    const files = await allFolderFiles(env, rawFolderPath, connectionId, client);
    let skippedSubfolderFiles = 0;
    let downloadsThisRun = 0;
    let continuationEnqueued = false;
    for (const file of files) {
      if (!isAcceptedPhotoFilename(file.name)) continue;
      const section = sectionForDropboxFile(file, rawFolderPath);
      if (section === SKIP_DROPBOX_SECTION) { skippedSubfolderFiles += 1; continue; }
      const sourcePath = file.path_display ?? file.path_lower;
      // Reconcile by content hash when Dropbox supplies one, else by the stored source path so
      // hashless files are still recognised on the next continuation run (otherwise the download
      // cap would re-fetch them forever and never advance past the cap).
      const [existing] = await db
        .select({ id: assets.id, section: assets.section, isPremium: assets.isPremium, sourcePath: assets.sourcePath })
        .from(assets)
        .innerJoin(collections, eq(assets.collectionId, collections.id))
        .where(and(
          file.content_hash ? eq(assets.contentHash, file.content_hash) : eq(assets.sourcePath, sourcePath),
          eq(collections.projectId, projectId),
          eq(collections.kind, "raw"),
        ))
        .limit(1);
      if (existing) {
        const now = new Date();
        const statements = [env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(collection.id, now.getTime()))];
        // Keep source_path current (a Dropbox move keeps the same content hash but changes the
        // path); a stale path would later break AutoHDR's server-side copy.
        if (existing.section !== section || existing.isPremium || existing.sourcePath !== sourcePath) statements.unshift(env.DB.prepare("UPDATE assets SET section = ?, is_premium = 0, source_path = ?, updated_at = ? WHERE id = ?").bind(section, sourcePath, now.getTime(), existing.id));
        await env.DB.batch(statements);
        await enqueueRenditionSafely(env, existing.id, "dropbox-existing-asset");
        continue;
      }

      // Reconcile-only files do not consume the cap. Once an additional new asset is found,
      // leave it for a fresh queue invocation so Dropbox downloads remain bounded.
      if (downloadsThisRun >= MAX_DOWNLOADS_PER_RUN) {
        continuationEnqueued = true;
        break;
      }

      const assetId = crypto.randomUUID();
      const r2Key = `projects/${projectId}/raw/${assetId}/${file.name}`;
      downloadsThisRun += 1;
      const source = await download(env, db, sourcePath, {}, connectionId, client);
      if (!source.body) throw new Error(`Dropbox returned no body for ${file.name}`);
      await env.MEDIA.put(r2Key, source.body, {
        httpMetadata: { contentType: "image/jpeg" },
      });

      const header = await download(env, db, sourcePath, { range: `bytes=0-${XMP_SCAN_BYTES - 1}` }, connectionId, client);
      const rating = xmpRatingToStars(parseXmpRating(await header.arrayBuffer()));
      const now = new Date();
      const results = await env.DB.batch([
        env.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, source_path, rating_from_metadata, section, is_premium, created_at, updated_at) VALUES (?, ?, 'photo', ?, ?, ?, ?, 'dropbox', ?, ?, ?, 0, ?, ?) ON CONFLICT DO NOTHING").bind(assetId, collection.id, r2Key, file.name, file.size, file.content_hash ?? null, sourcePath, rating, section, now.getTime(), now.getTime()),
        env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(collection.id, now.getTime())),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 0) continue; // reconciliation already ran in this batch
      await enqueueRenditionSafely(env, assetId, "dropbox-ingest");
    }
    if (continuationEnqueued && downloadsThisRun > 0) {
      await env.INGEST_QUEUE.send({ type: "dropbox_sync", projectId });
      await db.update(jobs).set({
        payloadJson: JSON.stringify({ note: `partial sync — ${downloadsThisRun} downloaded, continuation enqueued`, downloaded: downloadsThisRun, skippedSubfolderFiles }),
        updatedAt: new Date(),
      }).where(eq(jobs.id, trackingJobId));
    } else if (skippedSubfolderFiles > 0) {
      await db.update(jobs).set({
        payloadJson: JSON.stringify({ note: `skipped ${skippedSubfolderFiles} files nested deeper than one subfolder`, skippedSubfolderFiles }),
        updatedAt: new Date(),
      }).where(eq(jobs.id, trackingJobId));
    }
    if (project.rawFolderPath !== rawFolderPath) await db.update(projects).set({ rawFolderPath, updatedAt: new Date() }).where(eq(projects.id, projectId));
    await setJobStatus(db, trackingJobId, "done");
    // This operation did list the configured project folder, so it can recover a sticky path
    // error. It does not necessarily exercise sharing.read (a saved path can bypass it).
    await recordDropboxSuccess(db, client.connectionId, ["credentials", "current_account", "list_folder", "folder_path"]).catch((error) => {
      console.error("Dropbox sync succeeded but health recovery bookkeeping failed", error);
    });
  } catch (error) {
    await setJobStatus(db, trackingJobId, "failed", errorMessage(error));
    throw error;
  }
}
