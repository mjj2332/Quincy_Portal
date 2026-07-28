import { COLLECTION_RECEIVED_COUNT_SQL, collectionReceivedCountBindings, guardedStageTransition } from "@quincy/db";
import { assetIngestIdentities, assets, collections, jobs, projects, rawReconciliationClaims } from "@quincy/db/schema";
import { enqueueRenditionSafely, isAcceptedPhotoFilename, parseXmpRating, XMP_SCAN_BYTES, xmpRatingToStars } from "@quincy/shared";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import { createJob, setJobStatus } from "../lib/jobs";
import { createDropboxClientContext, download, getSharedLinkMetadata, listFolder, listFolderContinue, recordDropboxSuccess, type DropboxClientContext, type DropboxFile } from "./client";
import { normalisePath } from "./paths";
import { dropboxPathKey } from "./paths";
import { enqueueAutoHdrScaffold } from "../autohdr/scaffold";
import { notifyProject } from "../notifications";

// Each downloaded file costs ~9-10 subrequests (2 Dropbox content calls, an R2 put, a
// rendition enqueue, and several D1 statements) — 150 once overran the pre-2026 Free-tier
// 1,000-subrequest default and failed the whole run mid-way, which is why this was 40 for a
// long time. The account has been on Workers Paid (10,000 subrequests/invocation default)
// since 2026-07-25, so 120 downloads (~1,080-1,200 subrequests) has ample subrequest margin.
// The binding constraint now is Cloudflare's 15-minute wall-clock limit for Queue consumer
// invocations, not subrequests: at a measured ~4.1-4.2s/file this is ~8-8.5 minutes of active
// download time, leaving real margin for the initial full-folder listing and the D1 round-trip
// every reconciliation-only file costs even though it doesn't count toward this cap (see the
// loop below). Larger backlogs are not lost — the continuation re-enqueues whatever a run did
// not reach. See docs/plans/Dropbox-RAW-Fetch-Speedup-Plan.md for the sizing rationale.
const MAX_DOWNLOADS_PER_RUN = 120;
const RAW_CLAIM_LEASE_MS = 15 * 60_000;

export { normalisePath } from "./paths";

export async function renewRawReconciliationClaim(
  database: D1Database,
  claimId: string,
  ownerJobId: string,
  now = Date.now(),
): Promise<boolean> {
  const result = await database.prepare(
    "UPDATE raw_reconciliation_claims SET lease_expires_at = ?, updated_at = ? " +
    "WHERE id = ? AND owner_job_id = ? AND state = 'running' AND lease_expires_at >= ?",
  ).bind(now + RAW_CLAIM_LEASE_MS, now, claimId, ownerJobId, now).run();
  return (result.meta.changes ?? 0) === 1;
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

/** Root files are Captures; files may be grouped by up to two Dropbox subfolder levels. */
export function sectionForDropboxFile(file: DropboxFile, rootPath: string): string | null | typeof SKIP_DROPBOX_SECTION {
  const rootSegments = normalisePath(rootPath).toLowerCase().split("/").filter(Boolean);
  const lowerSegments = normalisePath(file.path_lower).toLowerCase().split("/").filter(Boolean);
  if (lowerSegments.length <= rootSegments.length || rootSegments.some((segment, index) => lowerSegments[index] !== segment)) return SKIP_DROPBOX_SECTION;
  const displaySegments = normalisePath(file.path_display ?? file.path_lower).split("/").filter(Boolean);
  const relative = displaySegments.slice(rootSegments.length);
  // Manual browser uploads are mirrored back to Dropbox for external visibility, but R2/D1
  // already own the canonical asset. Never ingest that provider copy a second time.
  if (relative.length >= 2 && relative[0]?.toLowerCase() === "manual-uploads") return SKIP_DROPBOX_SECTION;
  if (relative.length === 1) return null;
  if (relative.length === 2) return relative[0]!;
  return relative.length === 3 ? `${relative[0]!}/${relative[1]!}` : SKIP_DROPBOX_SECTION;
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
  trigger: "dropbox_delta" | "manual_dropbox_sync" | "queue_retry" = jobId ? "queue_retry" : "manual_dropbox_sync",
): Promise<{ newlyImported: number; currentRawAvailable: boolean; claimed: boolean }> {
  const db = dbFor(env);
  const trackingJobId = jobId ?? await createJob(db, {
    kind: "dropbox_sync",
    projectId,
    correlationId: `dropbox_sync:${projectId}`,
  });
  await setJobStatus(db, trackingJobId, "running");
  const claimId = crypto.randomUUID();
  const claimNow = new Date();
  await db.update(rawReconciliationClaims).set({ state: "failed", updatedAt: claimNow })
    .where(and(eq(rawReconciliationClaims.projectId, projectId), eq(rawReconciliationClaims.state, "running"), sql`${rawReconciliationClaims.leaseExpiresAt} < ${claimNow.getTime()}`));
  try {
    await db.insert(rawReconciliationClaims).values({
      id: claimId,
      projectId,
      ownerJobId: trackingJobId,
      state: "running",
      leaseExpiresAt: new Date(claimNow.getTime() + RAW_CLAIM_LEASE_MS),
      trigger,
      createdAt: claimNow,
      updatedAt: claimNow,
    });
  } catch (error) {
    const unique = (() => {
      for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
        if (/UNIQUE constraint failed/i.test(cause.message)) return true;
      }
      return false;
    })();
    if (!unique) throw error;
    const owner = await db.select({ ownerJobId: rawReconciliationClaims.ownerJobId }).from(rawReconciliationClaims)
      .where(and(eq(rawReconciliationClaims.projectId, projectId), eq(rawReconciliationClaims.state, "running"))).get();
    await db.update(jobs).set({
      status: "done",
      payloadJson: JSON.stringify({ reusedClaimOwnerJobId: owner?.ownerJobId ?? null }),
      updatedAt: new Date(),
    }).where(eq(jobs.id, trackingJobId));
    const existingRaw = await db.select({ id: assets.id }).from(assets)
      .innerJoin(collections, eq(assets.collectionId, collections.id))
      .where(and(eq(collections.projectId, projectId), eq(collections.kind, "raw"), sql`${assets.supersededAt} IS NULL`)).get();
    return { newlyImported: 0, currentRawAvailable: Boolean(existingRaw), claimed: false };
  }

  try {
    const assertLease = async () => {
      if (!await renewRawReconciliationClaim(env.DB, claimId, trackingJobId)) {
        throw new Error(`RAW reconciliation lease ${claimId} expired or was reclaimed`);
      }
    };
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

    await assertLease();
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
    let contentCallsThisRun = 0;
    let continuationEnqueued = false;
    let newlyImported = 0;
    for (const file of files) {
      if (!isAcceptedPhotoFilename(file.name)) continue;
      await assertLease();
      const section = sectionForDropboxFile(file, rawFolderPath);
      if (section === SKIP_DROPBOX_SECTION) { skippedSubfolderFiles += 1; continue; }
      const sourcePath = file.path_display ?? file.path_lower;
      const sourcePathKey = dropboxPathKey(file.path_lower);
      const identityKey = file.content_hash ? `hash:${file.content_hash.toLowerCase()}` : `path:${sourcePathKey}`;
      const identityOwner = await db.select({ assetId: assetIngestIdentities.assetId }).from(assetIngestIdentities)
        .where(and(eq(assetIngestIdentities.collectionId, collection.id), eq(assetIngestIdentities.identityKey, identityKey))).get();
      if (identityOwner) {
        await db.update(assets).set({ sourcePath, sourcePathKey, section, isPremium: false, updatedAt: new Date() })
          .where(eq(assets.id, identityOwner.assetId));
        await enqueueRenditionSafely(env, identityOwner.assetId, "dropbox-existing-asset");
        continue;
      }
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
        await db.insert(assetIngestIdentities).values({
          id: crypto.randomUUID(), collectionId: collection.id, identityKey, assetId: existing.id, createdAt: now,
        }).onConflictDoNothing();
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
      const stableSource = (file.content_hash ?? file.id).replace(/[^a-zA-Z0-9_-]/g, "_");
      const r2Key = `projects/${projectId}/raw/dropbox/${stableSource}/${file.name}`;
      downloadsThisRun += 1;
      if (contentCallsThisRun > 0) await new Promise<void>((resolve) => setTimeout(resolve, 150));
      const source = await download(env, db, sourcePath, {}, connectionId, client);
      contentCallsThisRun += 1;
      if (!source.body) throw new Error(`Dropbox returned no body for ${file.name}`);
      await env.MEDIA.put(r2Key, source.body, {
        httpMetadata: { contentType: "image/jpeg" },
      });

      if (contentCallsThisRun > 0) await new Promise<void>((resolve) => setTimeout(resolve, 150));
      const header = await download(env, db, sourcePath, { range: `bytes=0-${XMP_SCAN_BYTES - 1}` }, connectionId, client);
      contentCallsThisRun += 1;
      const rating = xmpRatingToStars(parseXmpRating(await header.arrayBuffer()));
      await assertLease();
      const now = new Date();
      const results = await env.DB.batch([
        env.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, rating_from_metadata, section, is_premium, created_at, updated_at) SELECT ?, ?, 'photo', ?, ?, ?, ?, 'dropbox', ?, ?, ?, ?, 0, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL) ON CONFLICT DO NOTHING").bind(assetId, collection.id, r2Key, file.name, file.size, file.content_hash ?? null, sourcePath, sourcePathKey, rating, section, now.getTime(), now.getTime(), projectId),
        env.DB.prepare("INSERT INTO asset_ingest_identities (id, collection_id, identity_key, asset_id, created_at) SELECT ?, ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT DO NOTHING").bind(crypto.randomUUID(), collection.id, identityKey, assetId, now.getTime()),
        env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'asset.ingested', 'asset', ?, ?, ? WHERE EXISTS (SELECT 1 FROM asset_ingest_identities WHERE collection_id = ? AND identity_key = ? AND asset_id = ?)")
          .bind(crypto.randomUUID(), assetId, JSON.stringify({ projectId, trigger, jobId: trackingJobId, reconciliationClaimId: claimId, connectionId: client.connectionId, sourcePathKey }), now.getTime(), collection.id, identityKey, assetId),
        env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(collection.id, now.getTime())),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 0) continue; // reconciliation already ran in this batch
      if ((results[1]?.meta.changes ?? 0) === 0) {
        // Another intake path won the identity after our external write. Preserve R2, remove only
        // the unowned metadata, and accept the winner on replay.
        await db.delete(assets).where(eq(assets.id, assetId));
        continue;
      }
      await enqueueRenditionSafely(env, assetId, "dropbox-ingest");
      newlyImported += 1;
    }
    await assertLease();
    if (continuationEnqueued && downloadsThisRun > 0) {
      await env.INGEST_QUEUE.send({ type: "dropbox_sync", projectId, connectionId: client.connectionId, trigger: "queue_retry" });
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
    if (project.rawFolderPath !== rawFolderPath) {
      await db.update(projects).set({ rawFolderPath, updatedAt: new Date() }).where(eq(projects.id, projectId));
      await enqueueAutoHdrScaffold(env, projectId).catch((error) =>
        console.error("AutoHDR scaffold trigger failed", { projectId, error }));
    }
    const currentRawAvailable = Boolean(await db.select({ id: assets.id }).from(assets)
      .where(and(eq(assets.collectionId, collection.id), sql`${assets.supersededAt} IS NULL`)).get());
    if (currentRawAvailable) {
      await guardedStageTransition(env.DB, {
        projectId,
        from: "awaiting_raw",
        to: "raw_review",
        meta: {
          trigger,
          reconciliationClaimId: claimId,
          jobId: trackingJobId,
          connectionId: connectionId ?? null,
          durableRawEvidence: { newlyImported, currentRawAvailable },
        },
        onSuccess: () => notifyProject(env, projectId, "raw_ready"),
      });
    }
    const completedAt = Date.now();
    const completion = await env.DB.prepare(
      "UPDATE raw_reconciliation_claims SET state = 'done', updated_at = ? " +
      "WHERE id = ? AND owner_job_id = ? AND state = 'running' AND lease_expires_at >= ?",
    ).bind(completedAt, claimId, trackingJobId, completedAt).run();
    if ((completion.meta.changes ?? 0) !== 1) {
      throw new Error(`RAW reconciliation lease ${claimId} expired or was reclaimed before completion`);
    }
    await setJobStatus(db, trackingJobId, "done");
    // This operation did list the configured project folder, so it can recover a sticky path
    // error. It does not necessarily exercise sharing.read (a saved path can bypass it).
    await recordDropboxSuccess(db, client.connectionId, ["credentials", "current_account", "list_folder", "folder_path"]).catch((error) => {
      console.error("Dropbox sync succeeded but health recovery bookkeeping failed", error);
    });
    return { newlyImported, currentRawAvailable, claimed: true };
  } catch (error) {
    await db.update(rawReconciliationClaims).set({ state: "failed", updatedAt: new Date() })
      .where(and(eq(rawReconciliationClaims.id, claimId), eq(rawReconciliationClaims.state, "running"))).catch(() => undefined);
    await setJobStatus(db, trackingJobId, "failed", errorMessage(error));
    throw error;
  }
}
