import {
  COLLECTION_RECEIVED_COUNT_SQL,
  collectionReceivedCountBindings,
  createDb,
} from "@quincy/db";
import {
  assets,
  collections,
  projects,
} from "@quincy/db/schema";
import { enqueueRenditionSafely } from "@quincy/shared";
import { and, eq, isNull } from "drizzle-orm";

import type { Env } from "../env";
import { errorMessage } from "../lib/db";
import { createJob } from "../lib/jobs";
import { requireBoardSchemaReady } from "../lib/board-schema";
import {
  createDropboxClientContext,
  download,
  listFolder,
  listFolderContinue,
  recordDropboxSuccess,
  type DropboxClientContext,
  type DropboxFile,
} from "../dropbox/client";
import { automationFlag } from "../dropbox/monitor-state";
import { dropboxPathKey, normalisePath, pathEqualsOrIsBelow } from "../dropbox/paths";
import { getEditorFolderMapping, type EditorFolderMapping } from "./mapping";

const MAX_DOWNLOADS_PER_RUN = 120;
const EDITOR_REQUEST_PACING_MS = 150;

type OutputFile = { file: DropboxFile; section: string | null };
type ExistingOutputAsset = {
  id: string;
  source: "upload" | "dropbox" | "tonomo";
  contentHash: string | null;
  sourcePath: string | null;
  sourcePathKey: string | null;
  section: string | null;
  isPremium: boolean;
  version: number;
  versionGroupId: string | null;
};

export type EditorOutputSyncResult = {
  newlyImported: number;
  currentEditedAvailable: boolean;
  hasMore: boolean;
};

function isEditorOutputFilename(filename: string): boolean {
  return /\.jpe?g$/iu.test(filename);
}

function isReservedManualPath(path: string, root: string): boolean {
  if (!pathEqualsOrIsBelow(path, root)) return false;
  const relative = dropboxPathKey(path)
    .slice(dropboxPathKey(root).length)
    .replace(/^\/+/, "");
  return relative.split("/").some((segment) => segment === "manual-uploads");
}

function sameContent(existing: string | null, observed: string | undefined): boolean {
  if (existing === null && observed === undefined) return true;
  return existing !== null && observed !== undefined && existing.toLowerCase() === observed.toLowerCase();
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

function assertDownloadedVersion(file: DropboxFile, response: Response): void {
  if (!file.content_hash) return;
  const downloadedHash = downloadedContentHash(response);
  if (!downloadedHash || downloadedHash.toLowerCase() !== file.content_hash.toLowerCase()) {
    throw new Error(`Dropbox file changed while downloading ${file.name}; list content hash no longer matches the downloaded object`);
  }
}

/** Preserve the explicit root section while retaining semantic nested folders below that root. */
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

async function allFiles(
  env: Env,
  path: string,
  connectionId: string,
  client: DropboxClientContext,
): Promise<DropboxFile[]> {
  const db = createDb(env.DB);
  let page = await listFolder(
    env,
    db,
    path,
    { recursive: true },
    connectionId,
    client,
  );
  const files: DropboxFile[] = [];
  while (true) {
    files.push(
      ...page.entries.filter(
        (entry): entry is DropboxFile => entry[".tag"] === "file",
      ),
    );
    if (!page.has_more) return files;
    page = await listFolderContinue(env, db, page.cursor, connectionId, client);
  }
}

async function outputFiles(
  env: Env,
  mapping: EditorFolderMapping,
  client: DropboxClientContext,
): Promise<OutputFile[]> {
  const files = new Map<string, OutputFile>();
  for (const root of mapping.outputRoots) {
    for (const file of await allFiles(
      env,
      root.path,
      mapping.connectionId,
      client,
    )) {
      const section = sectionForMappedFile(file, root);
      if (!pathEqualsOrIsBelow(file.path_lower, root.path)
        || (file.path_display !== undefined && !pathEqualsOrIsBelow(file.path_display, root.path))
        || !isEditorOutputFilename(file.name)
        || isReservedManualPath(file.path_lower, root.path)) {
        continue;
      }
      const key = dropboxPathKey(file.path_lower);
      if (!files.has(key)) files.set(key, { file, section });
    }
  }
  return [...files.values()];
}

async function ensureEditedCollection(
  env: Env,
  projectId: string,
): Promise<{ id: string }> {
  const db = createDb(env.DB);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO collections (id, project_id, kind, status, created_at, updated_at) SELECT ?, ?, 'edited', 'empty', ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL) ON CONFLICT DO NOTHING",
  ).bind(crypto.randomUUID(), projectId, now, now, projectId).run();
  const collection = await db
    .select({ id: collections.id })
    .from(collections)
    .innerJoin(projects, eq(collections.projectId, projects.id))
    .where(
      and(
        eq(collections.projectId, projectId),
        eq(collections.kind, "edited"),
        isNull(projects.archivedAt),
      ),
    )
    .get();
  if (!collection)
    throw new Error(
      `Unable to resolve Edited collection for project ${projectId}`,
    );
  return collection;
}

/**
 * Imports JPEGs from the reviewed Editor Output roots as independent Edited assets. Output files
 * are intentionally not paired to RAW assets and this function has no Stage/publication side
 * effects; client delivery remains an explicit Portal action.
 */
export async function syncProjectEditorOutput(
  env: Env,
  projectId: string,
  connectionId?: string,
): Promise<EditorOutputSyncResult> {
  await requireBoardSchemaReady(env);
  if (!automationFlag(env.DROPBOX_EDITOR_AUTOMATION_ENABLED)) {
    return { newlyImported: 0, currentEditedAvailable: false, hasMore: false };
  }
  const db = createDb(env.DB);
  const mapping = await getEditorFolderMapping(db, projectId);
  // A pending/review mapping is intentionally a no-op for Output. Raw sync may continue from
  // the old Tonomo path during review, but no Editor Output bytes may enter Portal until the
  // operator has verified the mapped roots.
  if (!mapping || mapping.state !== "ready") {
    return { newlyImported: 0, currentEditedAvailable: false, hasMore: false };
  }
  // A mapping mid-move is a no-op the same way an inapplicable mapping is: the root a listing
  // would scan is about to be rebased by the move's own commit, and every path this sync would
  // record is rebased there too, so scanning now would only race that batch.
  if (mapping.moveStatus === "moving") {
    return { newlyImported: 0, currentEditedAvailable: false, hasMore: false };
  }
  if (!mapping.outputRoots.length) {
    throw new Error(
      `Editor folder mapping for project ${projectId} has no ready Output roots`,
    );
  }
  if (connectionId && connectionId !== mapping.connectionId) {
    throw new Error(
      `Editor folder mapping for project ${projectId} requires Dropbox connection ${mapping.connectionId}`,
    );
  }
  const project = await db
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, projectId))
    .get();
  if (!project) throw new Error(`Project ${projectId} does not exist`);
  if (project.archivedAt) {
    throw new Error(
      `Project ${projectId} is archived — Editor Output sync refused`,
    );
  }
  const client = await createDropboxClientContext(
    env,
    db,
    mapping.connectionId,
  );
  const collection = await ensureEditedCollection(env, projectId);
  const files = await outputFiles(env, mapping, client);
  let newlyImported = 0;
  let downloadsThisRun = 0;
  let contentCallsThisRun = 0;
  let continuationEnqueued = false;
  // Bound to the revision read at the start of this run so a mapping that starts moving
  // mid-listing (root_revision unchanged, move_status flips to 'moving') fences every write
  // below just as reliably as one that has already landed at a new revision.
  const mappingGuard = " AND EXISTS (SELECT 1 FROM editor_folder_mappings m WHERE m.id = ? AND m.project_id = ? AND m.connection_id = ? AND m.root_revision = ? AND m.state = 'ready' AND (m.move_status IS NULL OR m.move_status != 'moving'))";
  const mappingGuardBindings = [mapping.id, projectId, mapping.connectionId, mapping.rootRevision];

  try {
    for (const { file, section } of files) {
      const sourcePath = file.path_display ?? file.path_lower;
      const sourcePathKey = dropboxPathKey(file.path_lower);
      // The partial current-source unique index is the durable idempotency key. Do not use
      // assetIngestIdentities here: its intentionally historical unique key would reject a
      // legitimate A -> B -> A provider revision after A had been superseded.
      const existing = (await db
        .select({
          id: assets.id,
          source: assets.source,
          contentHash: assets.contentHash,
          sourcePath: assets.sourcePath,
          sourcePathKey: assets.sourcePathKey,
          section: assets.section,
          isPremium: assets.isPremium,
          version: assets.version,
          versionGroupId: assets.versionGroupId,
        })
        .from(assets)
        .where(
          and(
            eq(assets.collectionId, collection.id),
            eq(assets.kind, "photo"),
            eq(assets.sourcePathKey, sourcePathKey),
            isNull(assets.supersededAt),
          ),
        )
        .get()) as ExistingOutputAsset | undefined;

      if (existing && sameContent(existing.contentHash, file.content_hash)) {
        if (existing.source === "dropbox") {
          // Raw SQL (not drizzle's .update()) so the same mapping/revision/not-moving fence as
          // every other write below applies here too — this update was unguarded before #153.
          await env.DB.prepare(
            `UPDATE assets SET source_path = ?, source_path_key = ?, section = ?, updated_at = ? WHERE id = ?${mappingGuard}`,
          ).bind(sourcePath, sourcePathKey, section, Date.now(), existing.id, ...mappingGuardBindings).run();
        }
        await enqueueRenditionSafely(
          env,
          existing.id,
          "editor-output-existing-asset",
        );
        continue;
      }

      // Reconciliation-only files do not consume the cap. Once another changed/new file is
      // encountered, leave it for a fresh queue invocation so one Worker run has a bounded
      // number of potentially large Dropbox downloads.
      if (downloadsThisRun >= MAX_DOWNLOADS_PER_RUN) {
        continuationEnqueued = true;
        break;
      }

      if (!file.content_hash) {
        throw new Error(`Editor Output file ${file.name} has no trusted Dropbox content hash; synchronization is paused until Dropbox returns one`);
      }

      if (contentCallsThisRun > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, EDITOR_REQUEST_PACING_MS),
        );
      }
      const source = await download(
        env,
        db,
        sourcePath,
        {},
        mapping.connectionId,
        client,
      );
      contentCallsThisRun += 1;
      assertDownloadedVersion(file, source);
      downloadsThisRun += 1;
      if (!source.body)
        throw new Error(`Dropbox returned no body for ${file.name}`);
      const assetId = crypto.randomUUID();
      const stableSource = (file.content_hash ?? file.id).replace(
        /[^a-zA-Z0-9_-]/g,
        "_",
      );
      // Include the immutable asset ID as well as the provider hash. A provider can legally
      // return to an earlier hash at the same path (A -> B -> A); retaining old D1 rows means a
      // hash-only key would collide with the first A even though this is a new asset version.
      const r2Key = `projects/${projectId}/edited/dropbox/editor/${stableSource}/${assetId}/${file.name}`;
      await env.MEDIA.put(r2Key, source.body, {
        httpMetadata: { contentType: "image/jpeg" },
      });
      const now = Date.now();
      const insert = existing
        ? env.DB.prepare(
            `INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, section, publish_status, is_premium, version, version_group_id, supersedes_asset_id, created_at, updated_at) SELECT ?, ?, 'photo', ?, ?, ?, ?, 'dropbox', ?, ?, ?, 'ready', 0, ?, ?, ?, ?, ? WHERE changes() = 1 AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)${mappingGuard}`,
          ).bind(
            assetId,
            collection.id,
            r2Key,
            file.name,
            file.size,
            file.content_hash ?? null,
            sourcePath,
            sourcePathKey,
            section,
            existing.version + 1,
            existing.versionGroupId ?? existing.id,
            existing.id,
            now,
            now,
            projectId,
            ...mappingGuardBindings,
          )
        : env.DB.prepare(
            `INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, section, publish_status, is_premium, created_at, updated_at) SELECT ?, ?, 'photo', ?, ?, ?, ?, 'dropbox', ?, ?, ?, 'ready', 0, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL) AND NOT EXISTS (SELECT 1 FROM assets WHERE collection_id = ? AND source_path_key = ? AND superseded_at IS NULL)${mappingGuard} ON CONFLICT DO NOTHING`,
          ).bind(
            assetId,
            collection.id,
            r2Key,
            file.name,
            file.size,
            file.content_hash ?? null,
            sourcePath,
            sourcePathKey,
            section,
            now,
            now,
            projectId,
            collection.id,
            sourcePathKey,
            ...mappingGuardBindings,
          );
      const supersede = existing
        ? env.DB.prepare(
            `UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ?, updated_at = ? WHERE id = ? AND collection_id = ? AND source_path_key = ? AND superseded_at IS NULL AND content_hash IS ? AND EXISTS (SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL)${mappingGuard}`,
          ).bind(
            now,
            assetId,
            now,
            existing.id,
            collection.id,
            sourcePathKey,
            existing.contentHash,
            projectId,
            ...mappingGuardBindings,
          )
        : null;
      // The supersede and insert are one D1 transaction. A stale read cannot supersede a newer
      // current row because the old id/hash are both guarded; if it loses, the insert is gated by
      // that update's changes() and the candidate is simply ignored (the R2 object is immutable
      // and can be reclaimed by the existing project-prefix cleanup).
      const statements: D1PreparedStatement[] = supersede
        ? [
            supersede,
            insert,
            env.DB.prepare(
              "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'asset.ingested', 'asset', ?, ?, ? WHERE changes() = 1",
            ).bind(
              crypto.randomUUID(),
              assetId,
              JSON.stringify({
                projectId,
                trigger: "editor_output",
                connectionId: client.connectionId,
                editorFolderMappingId: mapping.id,
                sourcePathKey,
                supersedesAssetId: existing?.id,
              }),
              now,
            ),
            env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(
              ...collectionReceivedCountBindings(collection.id, now),
            ),
          ]
        : [
            insert,
            env.DB.prepare(
              "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'asset.ingested', 'asset', ?, ?, ? WHERE changes() = 1",
            ).bind(
              crypto.randomUUID(),
              assetId,
              JSON.stringify({
                projectId,
                trigger: "editor_output",
                connectionId: client.connectionId,
                editorFolderMappingId: mapping.id,
                sourcePathKey,
              }),
              now,
            ),
            env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(
              ...collectionReceivedCountBindings(collection.id, now),
            ),
          ];
      const results = await env.DB.batch(statements);
      const insertResult = supersede ? results[1] : results[0];
      if ((insertResult?.meta.changes ?? 0) !== 1) {
        // No non-atomic DELETE/restore compensation: the D1 transaction above either owns the
        // complete version transition or leaves the existing current row untouched.
        continue;
      }
      await enqueueRenditionSafely(env, assetId, "editor-output-ingest");
      newlyImported += 1;
    }
    if (continuationEnqueued) {
      // A tracked job the same way index.ts's triggerEditorSync creates one, not a bare message:
      // an untracked continuation left no jobs row for an operator or the move state machine's
      // blocking-job check to see while it was in flight.
      const continuationJobId = await createJob(db, { kind: "editor_sync", projectId });
      await env.INGEST_QUEUE.send({
        type: "editor_sync",
        projectId,
        jobId: continuationJobId,
        connectionId: mapping.connectionId,
      });
    }
  } catch (error) {
    throw new Error(`Editor Output sync failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  const currentEditedAvailable = Boolean(
    await db
      .select({ id: assets.id })
      .from(assets)
      .innerJoin(collections, eq(assets.collectionId, collections.id))
      .innerJoin(projects, eq(collections.projectId, projects.id))
      .where(
        and(
          eq(collections.id, collection.id),
          eq(assets.kind, "photo"),
          eq(assets.publishStatus, "ready"),
          isNull(assets.supersededAt),
          isNull(projects.archivedAt),
        ),
      )
      .get(),
  );
  await recordDropboxSuccess(db, client.connectionId, [
    "credentials",
    "current_account",
    "list_folder",
    "folder_path",
  ]).catch((error) => {
    console.error(
      "Editor Output sync succeeded but health recovery bookkeeping failed",
      { projectId, error },
    );
  });
  return { newlyImported, currentEditedAvailable, hasMore: continuationEnqueued };
}
