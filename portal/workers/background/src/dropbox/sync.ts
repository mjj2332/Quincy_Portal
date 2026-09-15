import { buildProjectActivityStatements, COLLECTION_RECEIVED_COUNT_SQL, RAW_CLAIM_LEASE_MS, collectionReceivedCountBindings } from "@quincy/db";
import { assetIngestIdentities, assets, collections, jobs, projects, rawReconciliationClaims } from "@quincy/db/schema";
import { enqueueRenditionSafely, isAcceptedPhotoFilename, isDngFilename, isRawMediaFilename, parseXmpRating, projectActivityDeepLink, publishNotificationOutbox, rawMediaContentType, XMP_SCAN_BYTES, xmpRatingToStars, type ProjectActivityIntent } from "@quincy/shared";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Env } from "../env";
import type { DropboxSyncTrigger } from "../messages";
import { dbFor, errorMessage } from "../lib/db";
import { createJob, setJobStatus } from "../lib/jobs";
import { createDropboxClientContext, download, getSharedLinkMetadata, listFolder, listFolderContinue, recordDropboxSuccess, type DropboxClientContext, type DropboxFile } from "./client";
import { dropboxPathKey, normalisePath, pathEqualsOrIsBelow } from "./paths";
import { automationFlag } from "./monitor-state";
import { enqueueAutoHdrScaffold } from "../autohdr/scaffold";
import { notifyProject } from "../notifications";
import { requireBoardSchemaReady } from "../lib/board-schema";
import { commitAutomaticStage } from "../lib/automatic-stage";
import { getEditorFolderMapping, type EditorFolderMapping } from "../editor-folders/mapping";

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
const EDITOR_REQUEST_PACING_MS = 150;

function editorAutomationEnabled(value: string | boolean | undefined): boolean {
  return automationFlag(value);
}

type RawSyncRoot = {
  path: string;
  section: string | null;
  editorMapped: boolean;
};

type RawSyncPlan = {
  roots: RawSyncRoot[];
  legacyRawFolderPath: string | null;
  editorMapping: EditorFolderMapping | null;
};

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

function isReservedManualUploadPath(path: string, root: string): boolean {
  if (!pathEqualsOrIsBelow(path, root)) return false;
  const relative = dropboxPathKey(path)
    .slice(dropboxPathKey(root).length)
    .replace(/^\/+/, "");
  return relative.split("/").some((segment) => segment === "manual-uploads");
}

/** Keep reviewed root-section metadata while retaining semantic folders below that root. */
function sectionForMappedFile(file: DropboxFile, root: { path: string; section: string | null }): string | null {
  if (!pathEqualsOrIsBelow(file.path_lower, root.path)
    || (file.path_display !== undefined && !pathEqualsOrIsBelow(file.path_display, root.path))) return null;
  const relative = normalisePath(file.path_display ?? file.path_lower)
    .slice(normalisePath(root.path).length)
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean);
  const nested = relative.slice(0, -1).join("/");
  if (!root.section) return nested || null;
  return nested ? `${root.section}/${nested}` : root.section;
}

function downloadedContentHash(response: Response): string | null {
  const header = response.headers.get("Dropbox-API-Result");
  if (!header) return null;
  try {
    const parsed: unknown = JSON.parse(header);
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { content_hash?: unknown }).content_hash !== "string") return null;
    return (parsed as { content_hash: string }).content_hash;
  } catch {
    return null;
  }
}

/** A mapped Input file must still be the exact Dropbox revision that list_folder observed. */
function assertDownloadedEditorInputVersion(file: DropboxFile, response: Response): void {
  if (!file.content_hash) return;
  const downloadedHash = downloadedContentHash(response);
  if (!downloadedHash || downloadedHash.toLowerCase() !== file.content_hash.toLowerCase()) {
    throw new Error(`Dropbox file changed while downloading ${file.name}; list content hash no longer matches the downloaded object`);
  }
}

async function allEditorInputFiles(
  env: Env,
  mapping: EditorFolderMapping,
  client: DropboxClientContext,
): Promise<Array<{ file: DropboxFile; section: string | null }>> {
  const files = new Map<string, { file: DropboxFile; section: string | null }>();
  for (const root of mapping.inputRoots) {
    for (const file of await allFolderFiles(env, root.path, mapping.connectionId, client)) {
      if (!pathEqualsOrIsBelow(file.path_lower, root.path)
        || (file.path_display !== undefined && !pathEqualsOrIsBelow(file.path_display, root.path))
        || !isRawMediaFilename(file.name)
        || isReservedManualUploadPath(file.path_lower, root.path)) continue;
      const key = dropboxPathKey(file.path_lower);
      if (!files.has(key)) files.set(key, { file, section: sectionForMappedFile(file, root) });
    }
  }
  return [...files.values()];
}

async function resolveRawSyncPlan(
  env: Env,
  projectId: string,
  project: { rawFolderPath: string | null; rawFolderLink: string | null },
  mapping: EditorFolderMapping | null,
  client: DropboxClientContext,
): Promise<RawSyncPlan> {
  if (mapping?.state === "ready") {
    if (!mapping.inputRoots.length) {
      throw new Error(`Editor folder mapping for project ${projectId} has no ready Input roots`);
    }
    return {
      roots: mapping.inputRoots.map((root) => ({ path: root.path, section: root.section, editorMapped: true })),
      legacyRawFolderPath: null,
      editorMapping: mapping,
    };
  }

  // A pending/review mapping is not allowed to take over RAW ownership, but an existing
  // Tonomo path remains a safe legacy source during the operator-review window.  Projects with
  // no legacy path stay fail-closed instead of guessing a provider folder from the mapping.
  const legacyRawFolderPath = project.rawFolderPath
    ? normalisePath(project.rawFolderPath)
    : normalisePath(await pathFromRawFolderLink(env, project.rawFolderLink, client.connectionId, client) ?? "");
  if (!legacyRawFolderPath) {
    if (mapping) throw new Error(`Editor folder mapping for project ${projectId} needs review before RAW synchronization`);
    throw new Error(`Project ${projectId} has no resolvable Dropbox RAW folder path`);
  }
  return {
    roots: [{ path: legacyRawFolderPath, section: null, editorMapped: false }],
    legacyRawFolderPath,
    editorMapping: mapping,
  };
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
  trigger: DropboxSyncTrigger = jobId ? "queue_retry" : "manual_dropbox_sync",
): Promise<{ newlyImported: number; currentRawAvailable: boolean; claimed: boolean; hasMore: boolean }> {
  // Do not create a job, claim, asset, or legacy Stage statement on a pre-0037 database.
  await requireBoardSchemaReady(env);
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
    return { newlyImported: 0, currentRawAvailable: Boolean(existingRaw), claimed: false, hasMore: false };
  }

  try {
    const assertLease = async () => {
      if (!await renewRawReconciliationClaim(env.DB, claimId, trackingJobId)) {
        throw new Error(`RAW reconciliation lease ${claimId} expired or was reclaimed`);
      }
    };
    const [project] = await db
      .select({ rawFolderPath: projects.rawFolderPath, rawFolderLink: projects.rawFolderLink, archivedAt: projects.archivedAt, shootDate: projects.shootDate })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) throw new Error(`Project ${projectId} does not exist`);
    // Writer-side guard: archived projects are deletable, and deletion races any sync that
    // slips in after its active-jobs check — refuse at the source, not just at the trigger.
    if (project.archivedAt) throw new Error(`Project ${projectId} is archived — Dropbox sync refused`);

    const editorMapping = editorAutomationEnabled(env.DROPBOX_EDITOR_AUTOMATION_ENABLED)
      ? await getEditorFolderMapping(db, projectId)
      : null;
    if (editorMapping?.state === "ready" && connectionId && connectionId !== editorMapping.connectionId) {
      throw new Error(`Editor folder mapping for project ${projectId} requires Dropbox connection ${editorMapping.connectionId}`);
    }
    const client = await createDropboxClientContext(env, db, editorMapping?.state === "ready" ? editorMapping.connectionId : connectionId);
    const syncPlan = await resolveRawSyncPlan(env, projectId, project, editorMapping, client);
    const mappedInput = syncPlan.editorMapping?.state === "ready";
    const mappedInputRevision = mappedInput ? syncPlan.editorMapping!.rootRevision : null;
    // Not-moving is part of the same fence as the mapping/revision check below: a mapping mid-move
    // is still `state = 'ready'`, but its root is about to be rebased by the move's own commit, so
    // a write bound to the pre-move revision must not land underneath it.
    const sourceGuard = editorAutomationEnabled(env.DROPBOX_EDITOR_AUTOMATION_ENABLED)
      ? mappedInput
        ? ` AND EXISTS (SELECT 1 FROM editor_folder_mappings m WHERE m.project_id = projects.id AND m.state = 'ready' AND m.root_revision = ${mappedInputRevision} AND (m.move_status IS NULL OR m.move_status != 'moving'))`
        : " AND NOT EXISTS (SELECT 1 FROM editor_folder_mappings m WHERE m.project_id = projects.id AND m.state = 'ready')"
      : "";
    const sourceOwnerGuard = editorAutomationEnabled(env.DROPBOX_EDITOR_AUTOMATION_ENABLED)
      ? mappedInput
        ? sql`EXISTS (SELECT 1 FROM editor_folder_mappings m WHERE m.project_id = ${projectId} AND m.state = 'ready' AND m.root_revision = ${mappedInputRevision} AND (m.move_status IS NULL OR m.move_status != 'moving'))`
        : sql`NOT EXISTS (SELECT 1 FROM editor_folder_mappings m WHERE m.project_id = ${projectId} AND m.state = 'ready')`
      : sql`1 = 1`;

    if (mappedInput && syncPlan.editorMapping!.moveStatus === "moving") {
      // Same no-op as Editor Output while a mapping is mid-move: release this run's claim and job
      // cleanly instead of leaving either stuck `running` for the move's own blocking-job check.
      await db.update(rawReconciliationClaims).set({ state: "done", updatedAt: new Date() })
        .where(and(eq(rawReconciliationClaims.id, claimId), eq(rawReconciliationClaims.state, "running")));
      await db.update(jobs).set({
        status: "done",
        payloadJson: JSON.stringify({ note: "editor_folder_move_in_flight: RAW input is mapped to an Editor folder that is currently moving; this sync resumes once the move settles" }),
        updatedAt: new Date(),
      }).where(eq(jobs.id, trackingJobId));
      const existingRaw = await db.select({ id: assets.id }).from(assets)
        .innerJoin(collections, eq(assets.collectionId, collections.id))
        .where(and(eq(collections.projectId, projectId), eq(collections.kind, "raw"), sql`${assets.supersededAt} IS NULL`)).get();
      return { newlyImported: 0, currentRawAvailable: Boolean(existingRaw), claimed: false, hasMore: false };
    }

    await assertLease();
    const collection = await ensureRawCollection(env, projectId);
    const expectedCount = syncPlan.legacyRawFolderPath ? expectedCountFromFolder(syncPlan.legacyRawFolderPath) : null;
    if (!syncPlan.editorMapping || syncPlan.editorMapping.state !== "ready") {
      if (collection.expectedCount === null && expectedCount !== null) {
      await db
        .update(collections)
        .set({ expectedCount, updatedAt: new Date() })
        .where(and(eq(collections.id, collection.id), isNull(collections.expectedCount)));
      }
    }

    const files = syncPlan.editorMapping?.state === "ready"
      ? await allEditorInputFiles(env, syncPlan.editorMapping, client)
      : (await allFolderFiles(env, syncPlan.roots[0]!.path, client.connectionId, client)).map((file) => ({ file, section: null }));
    let skippedSubfolderFiles = 0;
    let downloadsThisRun = 0;
    let contentCallsThisRun = 0;
    let continuationEnqueued = false;
    let newlyImported = 0;
    for (const { file, section: mappedSection } of files) {
      const editorInput = syncPlan.editorMapping?.state === "ready";
      if (editorInput ? !isRawMediaFilename(file.name) : !isAcceptedPhotoFilename(file.name)) continue;
      await assertLease();
      const section = editorInput ? mappedSection : sectionForDropboxFile(file, syncPlan.roots[0]!.path);
      if (section === SKIP_DROPBOX_SECTION) { skippedSubfolderFiles += 1; continue; }
      const sourcePath = file.path_display ?? file.path_lower;
      const sourcePathKey = dropboxPathKey(file.path_lower);
      const identityKey = file.content_hash ? `hash:${file.content_hash.toLowerCase()}` : `path:${sourcePathKey}`;
      const identityOwner = await db.select({ assetId: assetIngestIdentities.assetId, source: assets.source, supersededAt: assets.supersededAt })
        .from(assetIngestIdentities)
        .innerJoin(assets, eq(assets.id, assetIngestIdentities.assetId))
        .where(and(eq(assetIngestIdentities.collectionId, collection.id), eq(assetIngestIdentities.identityKey, identityKey))).get();
      if (identityOwner && identityOwner.supersededAt === null) {
        if (identityOwner.source === "dropbox") {
          await db.update(assets).set({ sourcePath, sourcePathKey, section, isPremium: false, updatedAt: new Date() })
            .where(and(eq(assets.id, identityOwner.assetId), isNull(assets.supersededAt), sourceOwnerGuard));
        }
        await enqueueRenditionSafely(env, identityOwner.assetId, "dropbox-existing-asset");
        continue;
      }
      // Reconcile by content hash when Dropbox supplies one, else by the stored source path so
      // hashless files are still recognised on the next continuation run (otherwise the download
      // cap would re-fetch them forever and never advance past the cap).
      const [existing] = await db
        .select({ id: assets.id, source: assets.source, section: assets.section, isPremium: assets.isPremium, sourcePath: assets.sourcePath })
        .from(assets)
        .innerJoin(collections, eq(assets.collectionId, collections.id))
        .where(and(
          file.content_hash ? eq(assets.contentHash, file.content_hash) : eq(assets.sourcePath, sourcePath),
          eq(collections.projectId, projectId),
          eq(collections.kind, "raw"),
          isNull(assets.supersededAt),
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
        if (existing.source === "dropbox" && (existing.section !== section || existing.isPremium || existing.sourcePath !== sourcePath)) statements.unshift(env.DB.prepare(`UPDATE assets SET section = ?, is_premium = 0, source_path = ?, source_path_key = ?, updated_at = ? WHERE id = ? AND superseded_at IS NULL AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL${sourceGuard})`).bind(section, sourcePath, sourcePathKey, now.getTime(), existing.id, projectId));
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
      const returningRevision = identityOwner && identityOwner.supersededAt !== null;
      const r2Key = `projects/${projectId}/raw/dropbox/${stableSource}${returningRevision ? `/${assetId}` : ""}/${file.name}`;
      downloadsThisRun += 1;
      if (contentCallsThisRun > 0) await new Promise<void>((resolve) => setTimeout(resolve, EDITOR_REQUEST_PACING_MS));
      const source = await download(env, db, sourcePath, {}, client.connectionId, client);
      contentCallsThisRun += 1;
      if (!source.body) throw new Error(`Dropbox returned no body for ${file.name}`);
      if (editorInput) assertDownloadedEditorInputVersion(file, source);
      await env.MEDIA.put(r2Key, source.body, {
        httpMetadata: { contentType: rawMediaContentType(file.name) ?? "image/jpeg" },
      });

      let rating: number | null = null;
      if (!isDngFilename(file.name)) {
        if (contentCallsThisRun > 0) await new Promise<void>((resolve) => setTimeout(resolve, EDITOR_REQUEST_PACING_MS));
        const header = await download(env, db, sourcePath, { range: `bytes=0-${XMP_SCAN_BYTES - 1}` }, client.connectionId, client);
        contentCallsThisRun += 1;
        rating = xmpRatingToStars(parseXmpRating(await header.arrayBuffer()));
      }
      await assertLease();
      const now = new Date();
      const results = await env.DB.batch([
        env.DB.prepare(`INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, rating_from_metadata, section, is_premium, created_at, updated_at) SELECT ?, ?, 'photo', ?, ?, ?, ?, 'dropbox', ?, ?, ?, ?, 0, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL${sourceGuard}) ON CONFLICT DO NOTHING`).bind(assetId, collection.id, r2Key, file.name, file.size, file.content_hash ?? null, sourcePath, sourcePathKey, rating, section, now.getTime(), now.getTime(), projectId),
        env.DB.prepare("INSERT INTO asset_ingest_identities (id, collection_id, identity_key, asset_id, created_at) SELECT ?, ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT(collection_id, identity_key) DO UPDATE SET asset_id = excluded.asset_id WHERE EXISTS (SELECT 1 FROM assets previous WHERE previous.id = asset_ingest_identities.asset_id AND previous.superseded_at IS NOT NULL)").bind(crypto.randomUUID(), collection.id, identityKey, assetId, now.getTime()),
        env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'asset.ingested', 'asset', ?, ?, ? WHERE EXISTS (SELECT 1 FROM asset_ingest_identities WHERE collection_id = ? AND identity_key = ? AND asset_id = ?)")
          .bind(crypto.randomUUID(), assetId, JSON.stringify({ projectId, trigger, jobId: trackingJobId, reconciliationClaimId: claimId, connectionId: client.connectionId, sourcePathKey }), now.getTime(), collection.id, identityKey, assetId),
        env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(collection.id, now.getTime())),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 0) {
        const staleOccupant = await db.select({ id: assets.id })
          .from(assets)
          .where(and(
            eq(assets.collectionId, collection.id),
            eq(assets.sourcePathKey, sourcePathKey),
            isNull(assets.supersededAt),
          ))
          .get();
        if (!staleOccupant) continue; // reconciliation already ran in this batch

        const retryResults = await env.DB.batch([
          env.DB.prepare(`UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ?, updated_at = ? WHERE id = ? AND collection_id = ? AND source_path_key = ? AND superseded_at IS NULL AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL${sourceGuard})`)
            .bind(now.getTime(), assetId, now.getTime(), staleOccupant.id, collection.id, sourcePathKey, projectId),
          env.DB.prepare(`INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, rating_from_metadata, section, is_premium, supersedes_asset_id, created_at, updated_at) SELECT ?, ?, 'photo', ?, ?, ?, ?, 'dropbox', ?, ?, ?, ?, 0, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL${sourceGuard}) ON CONFLICT DO NOTHING`)
            .bind(assetId, collection.id, r2Key, file.name, file.size, file.content_hash ?? null, sourcePath, sourcePathKey, rating, section, staleOccupant.id, now.getTime(), now.getTime(), projectId),
          env.DB.prepare("INSERT INTO asset_ingest_identities (id, collection_id, identity_key, asset_id, created_at) SELECT ?, ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT(collection_id, identity_key) DO UPDATE SET asset_id = excluded.asset_id WHERE EXISTS (SELECT 1 FROM assets previous WHERE previous.id = asset_ingest_identities.asset_id AND previous.superseded_at IS NOT NULL)")
            .bind(crypto.randomUUID(), collection.id, identityKey, assetId, now.getTime()),
          env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'asset.ingested', 'asset', ?, ?, ? WHERE EXISTS (SELECT 1 FROM asset_ingest_identities WHERE collection_id = ? AND identity_key = ? AND asset_id = ?)")
            .bind(crypto.randomUUID(), assetId, JSON.stringify({ projectId, trigger, jobId: trackingJobId, reconciliationClaimId: claimId, connectionId: client.connectionId, sourcePathKey, supersedesAssetId: staleOccupant.id }), now.getTime(), collection.id, identityKey, assetId),
          env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(collection.id, now.getTime())),
        ]);
        const supersedeResult = (retryResults[0]?.meta.changes ?? 0);
        const retryInsertResult = (retryResults[1]?.meta.changes ?? 0);
        if (supersedeResult === 1 && retryInsertResult === 0) {
          await env.DB.batch([
            env.DB.prepare(
              "UPDATE assets SET superseded_at = CASE WHEN NOT EXISTS (SELECT 1 FROM assets a2 WHERE a2.collection_id = ? AND a2.source_path_key = ? AND a2.superseded_at IS NULL AND a2.id != assets.id) THEN NULL ELSE superseded_at END, replaced_by_asset_id = CASE WHEN NOT EXISTS (SELECT 1 FROM assets a2 WHERE a2.collection_id = ? AND a2.source_path_key = ? AND a2.superseded_at IS NULL AND a2.id != assets.id) THEN NULL ELSE (SELECT a3.id FROM assets a3 WHERE a3.collection_id = ? AND a3.source_path_key = ? AND a3.superseded_at IS NULL AND a3.id != assets.id LIMIT 1) END, updated_at = ? WHERE id = ? AND superseded_at IS ?",
            ).bind(
              collection.id, sourcePathKey,
              collection.id, sourcePathKey,
              collection.id, sourcePathKey,
              now.getTime(), staleOccupant.id, now.getTime(),
            ),
            env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(collection.id, now.getTime())),
          ]);
        }
        if (retryInsertResult === 0) continue;
        if ((retryResults[2]?.meta.changes ?? 0) === 0) {
          await env.DB.batch([
            env.DB.prepare("DELETE FROM assets WHERE id = ? AND collection_id = ? AND supersedes_asset_id = ?")
              .bind(assetId, collection.id, staleOccupant.id),
            env.DB.prepare(
              "UPDATE assets SET replaced_by_asset_id = COALESCE((SELECT winner.id FROM asset_ingest_identities winner_identity JOIN assets winner ON winner.id = winner_identity.asset_id WHERE winner_identity.collection_id = ? AND winner_identity.identity_key = ? AND winner.collection_id = ? AND winner.superseded_at IS NULL AND winner.id != ? LIMIT 1), replaced_by_asset_id), updated_at = ? WHERE id = ? AND collection_id = ? AND replaced_by_asset_id = ?",
            ).bind(collection.id, identityKey, collection.id, assetId, now.getTime(), staleOccupant.id, collection.id, assetId),
            env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(collection.id, now.getTime())),
          ]);
          continue;
        }
        await enqueueRenditionSafely(env, assetId, "dropbox-ingest");
        newlyImported += 1;
        continue;
      }
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
    if (syncPlan.legacyRawFolderPath && project.rawFolderPath !== syncPlan.legacyRawFolderPath) {
      await db.update(projects).set({ rawFolderPath: syncPlan.legacyRawFolderPath, updatedAt: new Date() }).where(eq(projects.id, projectId));
      await enqueueAutoHdrScaffold(env, projectId).catch((error) =>
        console.error("AutoHDR scaffold trigger failed", { projectId, error }));
    }
    const currentRawAvailable = Boolean(await db.select({ id: assets.id }).from(assets)
      .where(and(eq(assets.collectionId, collection.id), sql`${assets.supersededAt} IS NULL`)).get());
    if (currentRawAvailable) {
      const auditId = crypto.randomUUID();
      const outcome = await commitAutomaticStage({
        env,
        projectId,
        from: "awaiting_raw",
        to: "raw_review",
        auditId,
        auditActorId: null,
        auditMetaJson: JSON.stringify({
          trigger,
          reconciliationClaimId: claimId,
          jobId: trackingJobId,
          connectionId: client.connectionId,
          editorFolderMappingId: syncPlan.editorMapping?.state === "ready" ? syncPlan.editorMapping.id : null,
          sourceScope: syncPlan.editorMapping?.state === "ready" ? "editor_input" : "tonomo_raw",
          durableRawEvidence: { newlyImported, currentRawAvailable },
        }),
        now: Date.now(),
          workflow: {
            kind: "raw_reconciliation",
            projectId,
            claimId,
            claimStates: ["running"],
            shootDate: project.shootDate,
          },
          alreadyAtDestination: { allowed: true, effect: { kind: "none" } },
        legacyWorkflowNotification: "raw_ready",
      });
      if (outcome.kind === "winner" && outcome.finalizer.legacyWorkflowNotification === "raw_ready") {
        try {
          await notifyProject(env, projectId, "raw_ready");
        } catch (error) {
          console.error("Dropbox RAW notification failed", { projectId, error });
        }
      }
    }
    const completedAt = Date.now();
    const completionAuditId = crypto.randomUUID();
    const completion = env.DB.prepare(
      "UPDATE raw_reconciliation_claims SET state = 'done', updated_at = ? " +
      "WHERE id = ? AND owner_job_id = ? AND state = 'running' AND lease_expires_at >= ? RETURNING id",
    ).bind(completedAt, claimId, trackingJobId, completedAt);
    const completionAudit = env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'raw_reconciliation.complete', 'raw_reconciliation_claim', ?, ?, ? WHERE changes() = 1 RETURNING id").bind(completionAuditId, claimId, JSON.stringify({ projectId, claimId, newlyImported }), completedAt);
    const activityId = crypto.randomUUID();
    const activity: ProjectActivityIntent = { schemaVersion: 1, activity: { id: activityId, type: "project.collection.raw_sync_completed", projectId, actorId: null, actorKind: "system", occurredAt: completedAt, source: { kind: "project_raw_sync", id: claimId, key: `project-raw-sync:${claimId}:completed` }, safePayload: { collectionKind: "raw", importedCount: newlyImported }, deepLink: projectActivityDeepLink("project.collection.raw_sync_completed", projectId) }, broadDelivery: { registryKey: "project.collection.raw_sync_completed", sourceActivityId: activityId, coalesce: null } };
    const activityBundle = newlyImported > 0 ? buildProjectActivityStatements({ db: env.DB, intent: activity, winnerAuditId: completionAuditId, createdAt: completedAt }) : null;
    const completionResults = await env.DB.batch([completion, completionAudit, ...(activityBundle?.statements ?? [])]);
    if (!completionResults[0]?.results?.length) throw new Error(`RAW reconciliation lease ${claimId} expired or was reclaimed before completion`);
    if (activityBundle) {
      const publicationIds = ((completionResults[2 + activityBundle.broadOutboxIndex]?.results ?? []) as Array<{ id?: string }>).flatMap((row) => row.id ? [row.id] : []);
      if (publicationIds.length) await publishNotificationOutbox(env.NOTIFICATION_QUEUE, env.DB, publicationIds);
    }
    await setJobStatus(db, trackingJobId, "done");
    // This operation did list the configured project folder, so it can recover a sticky path
    // error. It does not necessarily exercise sharing.read (a saved path can bypass it).
    await recordDropboxSuccess(db, client.connectionId, ["credentials", "current_account", "list_folder", "folder_path"]).catch((error) => {
      console.error("Dropbox sync succeeded but health recovery bookkeeping failed", error);
    });
    return { newlyImported, currentRawAvailable, claimed: true, hasMore: continuationEnqueued };
  } catch (error) {
    await db.update(rawReconciliationClaims).set({ state: "failed", updatedAt: new Date() })
      .where(and(eq(rawReconciliationClaims.id, claimId), eq(rawReconciliationClaims.state, "running"))).catch(() => undefined);
    await setJobStatus(db, trackingJobId, "failed", errorMessage(error));
    throw error;
  }
}
