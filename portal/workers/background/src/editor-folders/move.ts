import { and, eq, gt, inArray, sql } from "drizzle-orm";
import {
  assetIngestIdentities,
  assets,
  collections,
  editedSourceClaims,
  editorFolderMappings,
  jobs,
  projects,
  rawReconciliationClaims,
} from "@quincy/db/schema";
import type { Database } from "@quincy/db";

import type { DropboxFolder } from "../dropbox/client";
import { errorMessage } from "../lib/db";
import { DropboxPathNotFoundError, DropboxRelocationConflictError, DropboxRelocationRefusedError, isDropboxPathNotFoundError, recordDropboxSuccess } from "../dropbox/client";
import { dropboxPathKey, pathEqualsOrIsBelow } from "../dropbox/paths";
import type { Env } from "../env";
import { createJob } from "../lib/jobs";
import { editorFolderPathKey } from "./paths";
import { editorMoveTarget, rebaseEditorPath, type EditorMoveTarget } from "./move-paths";
import { getEditorFolderMapping, type EditorFolderMapping, type EditorFolderRecoveryProof, type EditorFolderSubtree } from "./mapping";
import type {
  DropboxCreateFolderOperation,
  DropboxListFolderRecursiveOperation,
  DropboxMetadataOperation,
  DropboxMoveFolderOperation,
  EditorReconcileOutcome,
  EditorScaffoldSkipReason,
} from "./scaffold";

/** Dropbox operations the move state machine needs, on top of the plain scaffold's getMetadata/createFolder. */
export type EditorFolderMoveDependencies = {
  getMetadata: DropboxMetadataOperation;
  createFolder: DropboxCreateFolderOperation;
  moveFolderStrict: DropboxMoveFolderOperation;
  listFolderRecursive: DropboxListFolderRecursiveOperation;
  now: () => Date;
};

/** In-flight jobs of these kinds hold up a move: the two Editor-tree syncs, the two manual publish
 * workflows, and the two AutoHDR "send RAW" kinds (both read from a mapped Input root). */
const BLOCKING_JOB_KINDS = ["editor_sync", "dropbox_sync", "manual_edited_publish", "manual_raw_publish", "autohdr", "autohdr_api_send"] as const;

const MOVE_LEASE_MS = 10 * 60 * 1000;

/**
 * How many times a commit may fail AFTER Dropbox has already reported the tree at its new
 * location before the move stops being retried and is escalated instead.
 *
 * This is the one genuinely dangerous state in the feature: the world has changed and the database
 * has not. Retrying is right for a transient D1 failure and wrong for a deterministic one — a
 * UNIQUE collision fails identically every minute, forever, while the project's Editor pipeline
 * stays fenced and nobody is told. Past this limit the mapping stays `moving` (so the fence holds
 * and no sync runs against a path that no longer exists) but takeover stops, the note says plainly
 * that Dropbox and the database disagree, and an audit row records it for a human to find.
 */
const MOVE_COMMIT_ATTEMPT_LIMIT = 3;
export const JOB_STALE_MS = 2 * 60 * 60 * 1000;
const QUIET_PERIOD_MS = 30 * 60 * 1000;
const ORPHAN_SWEEP_MS = 30 * 60 * 1000;
const STALE_JOB_NOTE = "stale_job: no progress for 2h; no longer blocks the Editor folder move";

/** Mirrors `scaffold.ts`'s `reconcileNote`; duplicated to avoid a runtime import cycle between
 * this module and the one that calls into it (a plain string join has no cycle risk of its own). */
function reconcileNote(code: string, detail: string): string {
  return `${code}: ${detail}`;
}

function parseReconcileNote(note: string): { reason: EditorScaffoldSkipReason; detail: string } {
  const separator = note.indexOf(": ");
  if (separator === -1) return { reason: note as EditorScaffoldSkipReason, detail: note };
  return { reason: note.slice(0, separator) as EditorScaffoldSkipReason, detail: note.slice(separator + 2) };
}

function isUniqueConstraintViolation(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (/UNIQUE constraint failed/i.test(cause.message)) return true;
  }
  return false;
}

/** The move follows the tree by Dropbox folder ID, never by path. `attemptEditorFolderMove` blocks
 * a ready mapping without one before it gets here; a mid-move mapping reaching this without one is
 * corrupt state, and a named error on the job beats a null dereference inside a Dropbox call. */
function requireRootFolderId(mapping: EditorFolderMapping): string {
  if (mapping.rootFolderId === null) throw new Error(`Editor folder mapping ${mapping.id} has no Dropbox folder ID to move by`);
  return mapping.rootFolderId;
}

async function getFolderById(env: Env, db: Database, mapping: EditorFolderMapping, deps: EditorFolderMoveDependencies): Promise<DropboxFolder> {
  const metadata = await deps.getMetadata(env, db, requireRootFolderId(mapping), mapping.connectionId);
  if (metadata[".tag"] !== "folder") throw new Error(`Editor root folder ${mapping.rootFolderId} unexpectedly resolved to a file`);
  return metadata;
}

async function findRecentUpload(
  env: Env,
  db: Database,
  mapping: EditorFolderMapping,
  deps: EditorFolderMoveDependencies,
): Promise<{ path: string; serverModified: string } | null> {
  const cutoff = deps.now().getTime() - QUIET_PERIOD_MS;
  const entries = await deps.listFolderRecursive(env, db, requireRootFolderId(mapping), mapping.connectionId);
  for (const entry of entries) {
    if (entry[".tag"] !== "file" || !entry.server_modified) continue;
    const modifiedAt = Date.parse(entry.server_modified);
    if (Number.isFinite(modifiedAt) && modifiedAt > cutoff) {
      return { path: entry.path_display ?? entry.path_lower, serverModified: entry.server_modified };
    }
  }
  return null;
}

async function findBlockingJob(db: Database, projectId: string, now: Date): Promise<{ id: string; kind: string } | null> {
  const cutoff = new Date(now.getTime() - JOB_STALE_MS);
  const row = await db.select({ id: jobs.id, kind: jobs.kind }).from(jobs).where(and(
    eq(jobs.projectId, projectId),
    inArray(jobs.status, ["queued", "running"]),
    inArray(jobs.kind, [...BLOCKING_JOB_KINDS]),
    gt(jobs.updatedAt, cutoff),
  )).get();
  return row ?? null;
}

async function activeReconciliationClaim(db: Database, projectId: string, now: Date): Promise<boolean> {
  const row = await db.select({ id: rawReconciliationClaims.id }).from(rawReconciliationClaims).where(and(
    eq(rawReconciliationClaims.projectId, projectId),
    eq(rawReconciliationClaims.state, "running"),
    gt(rawReconciliationClaims.leaseExpiresAt, now),
  )).get();
  return Boolean(row);
}

/** Jobs stuck for >2h no longer block the move; each gets a one-time visible note on `jobs.error`
 * (never touching `status`/`updated_at`, so this is not mistaken for real progress). */
async function markStaleJobs(db: Database, projectId: string, now: Date): Promise<string[]> {
  const cutoff = now.getTime() - JOB_STALE_MS;
  const stale = await db.select({ id: jobs.id }).from(jobs).where(and(
    eq(jobs.projectId, projectId),
    inArray(jobs.status, ["queued", "running"]),
    inArray(jobs.kind, [...BLOCKING_JOB_KINDS]),
    sql`${jobs.updatedAt} <= ${cutoff}`,
  ));
  const ids: string[] = [];
  for (const job of stale) {
    await db.run(sql`UPDATE jobs SET error = ${STALE_JOB_NOTE} WHERE id = ${job.id} AND (error IS NULL OR error NOT LIKE 'stale_job:%')`);
    ids.push(job.id);
  }
  return ids;
}

async function queueEditorFolderResync(env: Env, db: Database, projectId: string, connectionId: string): Promise<void> {
  const editorSyncJobId = await createJob(db, { kind: "editor_sync", projectId });
  await env.INGEST_QUEUE.send({ type: "editor_sync", projectId, jobId: editorSyncJobId, connectionId });
  // The RAW pass is only worth queueing for a project that has a Tonomo RAW folder: without one,
  // `dropbox_sync` has nothing to look at and the job exists only to be marked done, which reads
  // in the jobs list as a RAW sync that ran and found nothing.
  const project = await db.select({ rawFolderPath: projects.rawFolderPath }).from(projects).where(eq(projects.id, projectId)).get();
  if (!project?.rawFolderPath) return;
  const dropboxSyncJobId = await createJob(db, { kind: "dropbox_sync", projectId, correlationId: `dropbox_sync:${projectId}:editor_folder_moved:${editorSyncJobId}` });
  await env.INGEST_QUEUE.send({ type: "dropbox_sync", projectId, jobId: dropboxSyncJobId, connectionId, trigger: "editor_folder_moved" });
}

type MoveTarget = Extract<EditorMoveTarget, { kind: "move" }>;

/** Fenced write before any token exists: a `ready` mapping whose `move_status` is NULL, or
 * `blocked` for a different target date than the one being blocked on now. */
async function blockBeforeClaim(
  env: Env,
  db: Database,
  mapping: EditorFolderMapping,
  input: { code: EditorScaffoldSkipReason; detail: string; nextShootDate: string },
  now: Date,
): Promise<EditorReconcileOutcome> {
  const note = reconcileNote(input.code, input.detail);
  const auditId = crypto.randomUUID();
  const meta = JSON.stringify({ actor: "editor_reconcile", mappingId: mapping.id, code: input.code, note, nextShootDate: input.nextShootDate });
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE editor_folder_mappings
      SET move_status = 'blocked', move_target_shoot_date = ?, move_note = ?, updated_at = ?
      WHERE id = ? AND state = 'ready' AND root_path_key = ? AND root_revision = ?
        AND (move_status IS NULL OR (move_status = 'blocked' AND move_target_shoot_date IS NOT ?))
    `).bind(input.nextShootDate, note, now.getTime(), mapping.id, mapping.rootPathKey, mapping.rootRevision, input.nextShootDate),
    env.DB.prepare(
      "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'editor_folder.move.blocked', 'project', ?, ?, ? WHERE changes() = 1",
    ).bind(auditId, mapping.projectId, meta, now.getTime()),
  ]);
  const current = await getEditorFolderMapping(db, mapping.projectId);
  return { status: "skipped", mapping: current ?? mapping, reason: input.code, detail: input.detail };
}

/** Fenced write while a token is held (a claimed or taken-over move): clears the token/expiry and
 * the target path/key, but keeps `move_target_shoot_date` so the same target is recognised next time. */
async function blockByToken(
  env: Env,
  db: Database,
  mapping: EditorFolderMapping,
  code: EditorScaffoldSkipReason,
  detail: string,
  now: Date,
): Promise<EditorReconcileOutcome> {
  const note = reconcileNote(code, detail);
  const auditId = crypto.randomUUID();
  const meta = JSON.stringify({ actor: "editor_reconcile", mappingId: mapping.id, code, note });
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE editor_folder_mappings
      SET move_status = 'blocked', move_note = ?, move_token = NULL, move_expires_at = NULL,
          move_target_path = NULL, move_target_path_key = NULL, updated_at = ?
      WHERE id = ? AND move_token = ? AND move_status = 'moving'
    `).bind(note, now.getTime(), mapping.id, mapping.moveToken),
    env.DB.prepare(
      "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'editor_folder.move.blocked', 'project', ?, ?, ? WHERE changes() = 1",
    ).bind(auditId, mapping.projectId, meta, now.getTime()),
  ]);
  const current = await getEditorFolderMapping(db, mapping.projectId);
  return { status: "skipped", mapping: current ?? mapping, reason: code, detail };
}

/** Fenced on the token: drops back to no move in progress so a normal pass re-runs the job/quiet
 * checks from scratch (used for a post-claim quiet-period hit and a takeover found at the old root). */
async function releaseEditorFolderMove(env: Env, db: Database, mapping: EditorFolderMapping, now: Date, reason: string): Promise<void> {
  const auditId = crypto.randomUUID();
  const meta = JSON.stringify({ actor: "editor_reconcile", mappingId: mapping.id, reason });
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE editor_folder_mappings
      SET move_status = NULL, move_target_path = NULL, move_target_path_key = NULL, move_target_shoot_date = NULL,
          move_token = NULL, move_expires_at = NULL, move_note = NULL, move_commit_attempts = 0, updated_at = ?
      WHERE id = ? AND move_token = ? AND move_status = 'moving'
    `).bind(now.getTime(), mapping.id, mapping.moveToken),
    env.DB.prepare(
      "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'editor_folder.move.released', 'project', ?, ?, ? WHERE changes() = 1",
    ).bind(auditId, mapping.projectId, meta, now.getTime()),
  ]);
}

type ClaimResult =
  | { status: "claimed"; mapping: EditorFolderMapping }
  | { status: "conflict" }
  | { status: "deferred" };

/** One D1 batch: claims the move (fenced on state/revision/root key/blocked-target and the same
 * blocking-job/claim checks as the standalone pre-check) and audits the claim atomically. */
async function claimEditorFolderMove(
  env: Env,
  db: Database,
  mapping: EditorFolderMapping,
  project: { id: string },
  target: MoveTarget,
  now: Date,
): Promise<ClaimResult> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + MOVE_LEASE_MS);
  const auditId = crypto.randomUUID();
  const startedMeta = JSON.stringify({
    actor: "editor_reconcile", mappingId: mapping.id, from: mapping.rootPath, to: target.targetPath,
    previousShootDate: mapping.shootDate, nextShootDate: target.next,
  });
  const jobKindPlaceholders = BLOCKING_JOB_KINDS.map(() => "?").join(",");
  const claimStatement = env.DB.prepare(`
    UPDATE editor_folder_mappings
    SET move_status = 'moving', move_target_path = ?, move_target_path_key = ?, move_target_shoot_date = ?,
        move_token = ?, move_expires_at = ?, move_note = NULL, updated_at = ?
    WHERE id = ? AND state = 'ready' AND root_revision = ? AND root_path_key = ?
      AND (move_status IS NULL OR (move_status = 'blocked' AND move_target_shoot_date IS NOT ?))
      AND EXISTS (SELECT 1 FROM projects p WHERE p.id = ? AND p.archived_at IS NULL AND p.stage_key != 'delivered' AND p.shoot_date = ?)
      AND NOT EXISTS (
        SELECT 1 FROM jobs j WHERE j.project_id = ? AND j.status IN ('queued','running')
          AND j.kind IN (${jobKindPlaceholders}) AND j.updated_at > ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM raw_reconciliation_claims rc WHERE rc.project_id = ? AND rc.state = 'running' AND rc.lease_expires_at > ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM editor_folder_mappings m2 WHERE m2.connection_id = ? AND m2.id != ?
          AND (m2.root_path_key = ? OR m2.move_target_path_key = ?)
      )
  `).bind(
    target.targetPath, target.targetPathKey, target.next,
    token, expiresAt.getTime(), now.getTime(),
    mapping.id, mapping.rootRevision, mapping.rootPathKey,
    target.next,
    project.id, target.next,
    project.id, ...BLOCKING_JOB_KINDS, now.getTime() - JOB_STALE_MS,
    project.id, now.getTime(),
    mapping.connectionId, mapping.id, target.targetPathKey, target.targetPathKey,
  );
  const auditStatement = env.DB.prepare(
    "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'editor_folder.move.started', 'project', ?, ?, ? WHERE changes() = 1",
  ).bind(auditId, mapping.projectId, startedMeta, now.getTime());

  let results;
  try {
    results = await env.DB.batch([claimStatement, auditStatement]);
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return { status: "conflict" };
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    const holder = await db.select({ id: editorFolderMappings.id }).from(editorFolderMappings).where(and(
      eq(editorFolderMappings.connectionId, mapping.connectionId),
      sql`${editorFolderMappings.id} != ${mapping.id}`,
      sql`(${editorFolderMappings.rootPathKey} = ${target.targetPathKey} OR ${editorFolderMappings.moveTargetPathKey} = ${target.targetPathKey})`,
    )).get();
    return holder ? { status: "conflict" } : { status: "deferred" };
  }
  const claimed = await getEditorFolderMapping(db, mapping.projectId);
  if (!claimed) return { status: "deferred" };
  return { status: "claimed", mapping: claimed };
}

function rebasedSubtrees(roots: readonly EditorFolderSubtree[], oldRoot: string, newRoot: string): EditorFolderSubtree[] {
  return roots.map((root) => {
    const rebased = rebaseEditorPath(root.path, oldRoot, newRoot);
    if (!rebased) throw new Error(`Editor folder move could not rebase ${root.path} under ${oldRoot}`);
    return { ...root, path: rebased };
  });
}

/** One D1 batch: lands the mapping at its target and rebases every Dropbox path recorded for the
 * project under the old root, gated on this exact move having just landed (so a batch replay after
 * a partial failure is a no-op, not a double-rebase). */
async function commitEditorFolderMove(
  env: Env,
  db: Database,
  mapping: EditorFolderMapping,
  target: MoveTarget,
  staleJobIds: string[],
  now: Date,
): Promise<EditorReconcileOutcome> {
  const oldRootPath = mapping.rootPath;
  const oldRootKey = mapping.rootPathKey;
  const newRootPath = target.targetPath;
  const newRootKey = target.targetPathKey;
  const newRevision = mapping.rootRevision + 1;

  const inputRoots = rebasedSubtrees(mapping.inputRoots, oldRootPath, newRootPath);
  const outputRoots = rebasedSubtrees(mapping.outputRoots, oldRootPath, newRootPath);
  const editingNotesPath = rebaseEditorPath(mapping.editingNotesPath, oldRootPath, newRootPath);
  if (!editingNotesPath) throw new Error(`Editor folder move could not rebase ${mapping.editingNotesPath} under ${oldRootPath}`);

  const existingProof: EditorFolderRecoveryProof = mapping.recoveryProof ?? { version: 1, rootPath: oldRootPath, rootPathKey: oldRootKey, attempts: 0, created: [] };
  const recoveryProof: EditorFolderRecoveryProof = {
    ...existingProof,
    rootPath: newRootPath,
    rootPathKey: newRootKey,
    // Not incremented: `attempts` counts provisioning attempts, and a move is not one. Bumping it
    // would make a moved tree read as though its scaffold had been retried.
    attempts: existingProof.attempts,
    created: existingProof.created.map((entry) => {
      const rebased = rebaseEditorPath(entry.path, oldRootPath, newRootPath);
      return rebased ? { ...entry, path: rebased } : entry;
    }),
    diagnostics: [
      ...(existingProof.diagnostics ?? []),
      `Moved from ${oldRootPath} to ${newRootPath} after the shoot date changed from ${mapping.shootDate} to ${target.next}`,
    ].slice(-20),
  };

  const previousShootDate = mapping.shootDate;
  const handLinked = mapping.reviewedBy !== null;
  const auditId = crypto.randomUUID();
  const movedMeta = JSON.stringify({
    actor: "editor_reconcile", mappingId: mapping.id, from: oldRootPath, to: newRootPath,
    previousShootDate, shootDate: target.next, rootFolderId: mapping.rootFolderId, rootRevision: newRevision,
    handLinked, staleJobIds,
  });

  // Pre-read every Dropbox path this project has recorded under the old root; the rebase itself
  // happens here in TS (rebaseEditorPath compares by key and slices by segment count, which a pure
  // SQL prefix substitution cannot do safely for a differently-cased or non-ASCII display path).
  const assetRows = await db.select({ id: assets.id, sourcePath: assets.sourcePath, sourcePathKey: assets.sourcePathKey })
    .from(assets).innerJoin(collections, eq(assets.collectionId, collections.id))
    .where(and(eq(collections.projectId, mapping.projectId), sql`${assets.sourcePathKey} IS NOT NULL`));
  const assetUpdates = assetRows
    .filter((row): row is typeof row & { sourcePathKey: string } => Boolean(row.sourcePathKey) && pathEqualsOrIsBelow(row.sourcePathKey!, oldRootKey))
    .map((row) => {
      // `source_path` is the display path and `source_path_key` its lower-cased form. A row with no
      // display path keeps none (a JSON null reaches the UPDATE as SQL NULL): rebasing the key into
      // that column would invent a lower-cased display path that Dropbox never reported.
      const newPath = row.sourcePath === null ? null : rebaseEditorPath(row.sourcePath, oldRootPath, newRootPath)!;
      const newPathKey = dropboxPathKey(rebaseEditorPath(row.sourcePathKey, oldRootPath, newRootPath)!);
      return { id: row.id, oldPathKey: row.sourcePathKey, newPath, newPathKey };
    });

  const identityRows = await db.select({ id: assetIngestIdentities.id, identityKey: assetIngestIdentities.identityKey })
    .from(assetIngestIdentities).innerJoin(collections, eq(assetIngestIdentities.collectionId, collections.id))
    .where(and(eq(collections.projectId, mapping.projectId), sql`${assetIngestIdentities.identityKey} LIKE 'path:%'`));
  const identityUpdates = identityRows
    .map((row) => ({ id: row.id, oldIdentityKey: row.identityKey, key: row.identityKey.slice("path:".length) }))
    .filter((row) => pathEqualsOrIsBelow(row.key, oldRootKey))
    .map((row) => ({ id: row.id, oldIdentityKey: row.oldIdentityKey, newIdentityKey: `path:${dropboxPathKey(rebaseEditorPath(row.key, oldRootPath, newRootPath)!)}` }));

  const claimRows = await db.select({ id: editedSourceClaims.id, sourcePathKey: editedSourceClaims.sourcePathKey })
    .from(editedSourceClaims).innerJoin(collections, eq(editedSourceClaims.collectionId, collections.id))
    .where(eq(collections.projectId, mapping.projectId));
  const claimUpdates = claimRows
    .filter((row) => pathEqualsOrIsBelow(row.sourcePathKey, oldRootKey))
    .map((row) => ({ id: row.id, oldPathKey: row.sourcePathKey, newPathKey: dropboxPathKey(rebaseEditorPath(row.sourcePathKey, oldRootPath, newRootPath)!) }));

  const mappingGuard = "EXISTS (SELECT 1 FROM editor_folder_mappings m WHERE m.id = ? AND m.root_revision = ? AND m.root_path_key = ?)";

  const mappingUpdate = env.DB.prepare(`
    UPDATE editor_folder_mappings
    SET root_path = ?, root_path_key = ?, shoot_date = ?,
        input_roots_json = ?, output_roots_json = ?, editing_notes_path = ?,
        recovery_proof_json = ?, root_revision = ?, moved_from_path = ?, move_completed_at = ?,
        move_status = NULL, move_target_path = NULL, move_target_path_key = NULL,
        move_target_shoot_date = NULL, move_token = NULL, move_expires_at = NULL, move_note = NULL,
        move_commit_attempts = 0, updated_at = ?
    WHERE id = ? AND move_token = ? AND move_status = 'moving' AND root_path_key = ? AND root_revision = ?
  `).bind(
    newRootPath, newRootKey, target.next,
    JSON.stringify(inputRoots), JSON.stringify(outputRoots), editingNotesPath,
    JSON.stringify(recoveryProof), newRevision, oldRootPath, now.getTime(),
    now.getTime(),
    mapping.id, mapping.moveToken, oldRootKey, mapping.rootRevision,
  );
  const auditInsert = env.DB.prepare(
    "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'editor_folder.moved', 'project', ?, ?, ? WHERE changes() = 1",
  ).bind(auditId, mapping.projectId, movedMeta, now.getTime());

  const assetsPayload = JSON.stringify(assetUpdates.map((u) => ({ id: u.id, newPath: u.newPath, newPathKey: u.newPathKey, oldPathKey: u.oldPathKey })));
  const assetsUpdate = env.DB.prepare(`
    UPDATE assets SET source_path = pending.new_path, source_path_key = pending.new_path_key, updated_at = ?
    FROM (SELECT json_extract(je.value,'$.id') AS id, json_extract(je.value,'$.newPath') AS new_path,
                 json_extract(je.value,'$.newPathKey') AS new_path_key, json_extract(je.value,'$.oldPathKey') AS old_path_key
          FROM json_each(?) AS je) AS pending
    WHERE assets.id = pending.id AND assets.source_path_key = pending.old_path_key AND ${mappingGuard}
  `).bind(now.getTime(), assetsPayload, mapping.id, newRevision, newRootKey);

  const identitiesPayload = JSON.stringify(identityUpdates.map((u) => ({ id: u.id, newKey: u.newIdentityKey, oldKey: u.oldIdentityKey })));
  const identitiesUpdate = env.DB.prepare(`
    UPDATE asset_ingest_identities SET identity_key = pending.new_key
    FROM (SELECT json_extract(je.value,'$.id') AS id, json_extract(je.value,'$.newKey') AS new_key, json_extract(je.value,'$.oldKey') AS old_key
          FROM json_each(?) AS je) AS pending
    WHERE asset_ingest_identities.id = pending.id AND asset_ingest_identities.identity_key = pending.old_key AND ${mappingGuard}
  `).bind(identitiesPayload, mapping.id, newRevision, newRootKey);

  const claimsPayload = JSON.stringify(claimUpdates.map((u) => ({ id: u.id, newKey: u.newPathKey, oldKey: u.oldPathKey })));
  const claimsUpdate = env.DB.prepare(`
    UPDATE edited_source_claims SET source_path_key = pending.new_key, updated_at = ?
    FROM (SELECT json_extract(je.value,'$.id') AS id, json_extract(je.value,'$.newKey') AS new_key, json_extract(je.value,'$.oldKey') AS old_key
          FROM json_each(?) AS je) AS pending
    WHERE edited_source_claims.id = pending.id AND edited_source_claims.source_path_key = pending.old_key AND ${mappingGuard}
  `).bind(now.getTime(), claimsPayload, mapping.id, newRevision, newRootKey);

  let results;
  try {
    results = await env.DB.batch([mappingUpdate, auditInsert, assetsUpdate, identitiesUpdate, claimsUpdate]);
  } catch (error) {
    // A UNIQUE collision (or any other batch failure) rolls the whole transaction back; the
    // mapping is untouched and still `moving`, so a later pass (a fresh claim, or a takeover once
    // this one's lease expires) retries the whole commit from scratch.
    console.error("Editor folder move commit failed; the mapping stays in a moving state for a later pass to retry", { mappingId: mapping.id, error: error instanceof Error ? error.message : String(error) });
    await noteFailedCommit(env, db, mapping, newRootPath, errorMessage(error), now);
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    const current = await getEditorFolderMapping(db, mapping.projectId);
    if (current && current.rootPathKey === newRootKey && current.moveStatus === null) {
      return { status: "moved", mapping: current, from: oldRootPath, to: newRootPath, previousShootDate };
    }
    return { status: "skipped", mapping: current, reason: "editor_folder_move_deferred", detail: "Another pass already committed or is completing this Editor folder move" };
  }

  // Each rebase statement is fenced on the row's own old key as well as the mapping guard, so a
  // row that changed underneath us is skipped rather than overwritten — silently. Report the
  // shortfall: "rebased 3 of 4" is the only signal that a path was left behind.
  const rebased = [
    { what: "assets", planned: assetUpdates.length, changed: results[2]?.meta.changes ?? 0 },
    { what: "asset_ingest_identities", planned: identityUpdates.length, changed: results[3]?.meta.changes ?? 0 },
    { what: "edited_source_claims", planned: claimUpdates.length, changed: results[4]?.meta.changes ?? 0 },
  ].filter((row) => row.changed !== row.planned);
  if (rebased.length > 0) {
    console.error("Editor folder move rebased fewer rows than it planned to", {
      mappingId: mapping.id, projectId: mapping.projectId, from: oldRootPath, to: newRootPath,
      shortfall: rebased.map((row) => `${row.what}: rebased ${row.changed} of ${row.planned}`),
    });
  }

  await recordDropboxSuccess(db, mapping.connectionId, ["credentials", "current_account", "list_folder", "folder_path"]);
  await queueEditorFolderResync(env, db, mapping.projectId, mapping.connectionId);
  const committed = await getEditorFolderMapping(db, mapping.projectId);
  return { status: "moved", mapping: committed!, from: oldRootPath, to: newRootPath, previousShootDate };
}

/** Dropbox resolution right after a fresh claim: the token is fresh, so a real move is attempted. */
async function resolveClaimedMove(
  env: Env,
  db: Database,
  mapping: EditorFolderMapping,
  target: MoveTarget,
  staleJobIds: string[],
  deps: EditorFolderMoveDependencies,
  now: Date,
): Promise<EditorReconcileOutcome> {
  let current: DropboxFolder;
  try {
    current = await getFolderById(env, db, mapping, deps);
  } catch (error) {
    if (isDropboxPathNotFoundError(error)) {
      return await blockByToken(env, db, mapping, "editor_folder_move_source_missing", `The Editor root folder (Dropbox id ${mapping.rootFolderId}) no longer exists; an operator must restore or relink it`, now);
    }
    throw error;
  }
  const currentKey = editorFolderPathKey(current.path_lower);
  if (currentKey === mapping.rootPathKey) {
    const monthPath = target.targetPath.split("/").slice(0, -2).join("/");
    const dayPath = target.targetPath.split("/").slice(0, -1).join("/");
    await deps.createFolder(env, db, monthPath, mapping.connectionId);
    await deps.createFolder(env, db, dayPath, mapping.connectionId);
    let moved: DropboxFolder;
    try {
      moved = await deps.moveFolderStrict(env, db, mapping.rootPath, target.targetPath, mapping.connectionId);
    } catch (error) {
      if (error instanceof DropboxRelocationConflictError) {
        const recheck = await getFolderById(env, db, mapping, deps);
        if (editorFolderPathKey(recheck.path_lower) !== target.targetPathKey) {
          const leaf = target.targetPath.split("/").at(-1)!;
          return await blockByToken(env, db, mapping, "editor_folder_move_conflict", `A folder named ${leaf} already exists in ${dayPath}`, now);
        }
        moved = recheck;
      } else if (error instanceof DropboxPathNotFoundError) {
        return await blockByToken(env, db, mapping, "editor_folder_move_source_missing", `The Editor root ${mapping.rootPath} was gone when the Portal tried to move it; an operator must restore or relink it`, now);
      } else if (error instanceof DropboxRelocationRefusedError) {
        // Dropbox refused the relocation for a reason that is neither a conflict nor a missing
        // path — no write permission, quota, too many files. The tree has NOT moved, so this is a
        // durable block an operator can see rather than a throw that only replays every minute.
        return await blockByToken(env, db, mapping, "editor_folder_move_refused", `Dropbox refused to move the Editor root to ${target.targetPath}: ${errorMessage(error)}`, now);
      } else {
        throw error;
      }
    }
    if (moved.id !== mapping.rootFolderId || editorFolderPathKey(moved.path_lower) !== target.targetPathKey) {
      // The tree HAS left the old path, but not for the path the Portal asked for, so the commit
      // is refused and the database still records the old location. Say both halves: an operator
      // reading only "unexpected location" would not know the recorded path is now a dead one.
      return await blockByToken(env, db, mapping, "editor_folder_move_moved_elsewhere", `Dropbox reported the Editor root at ${moved.path_display ?? moved.path_lower} instead of ${target.targetPath}. The move was not recorded, so the Portal still has it at ${mapping.rootPath}, which is no longer where the folder is; an operator must resolve this by hand`, now);
    }
  } else if (currentKey !== target.targetPathKey) {
    return await blockByToken(env, db, mapping, "editor_folder_move_moved_elsewhere", `The Editor root now lives at ${current.path_display ?? current.path_lower}, neither the expected old nor new location; an operator must resolve this by hand`, now);
  }
  return await commitEditorFolderMove(env, db, mapping, target, staleJobIds, now);
}

/** Dropbox resolution after a takeover: the previous pass may have crashed before ever calling
 * Dropbox, so this never attempts a fresh move itself — only completing (found at target) or
 * releasing (found at old root, unchanged) so a normal pass re-runs every check from scratch. */
async function resolveTakeoverMove(env: Env, db: Database, mapping: EditorFolderMapping, deps: EditorFolderMoveDependencies, now: Date): Promise<EditorReconcileOutcome> {
  const target: MoveTarget = {
    kind: "move",
    previous: mapping.shootDate,
    next: mapping.moveTargetShootDate!,
    targetPath: mapping.moveTargetPath!,
    targetPathKey: mapping.moveTargetPathKey!,
  };
  let current: DropboxFolder;
  try {
    current = await getFolderById(env, db, mapping, deps);
  } catch (error) {
    if (isDropboxPathNotFoundError(error)) {
      return await blockByToken(env, db, mapping, "editor_folder_move_source_missing", `The Editor root folder (Dropbox id ${mapping.rootFolderId}) no longer exists; an operator must restore or relink it`, now);
    }
    throw error;
  }
  const currentKey = editorFolderPathKey(current.path_lower);
  if (currentKey === target.targetPathKey) {
    return await commitEditorFolderMove(env, db, mapping, target, [], now);
  }
  if (currentKey === mapping.rootPathKey) {
    await releaseEditorFolderMove(env, db, mapping, now, "takeover_at_old_root");
    const released = await getEditorFolderMapping(db, mapping.projectId);
    return {
      status: "skipped", mapping: released ?? mapping, reason: "editor_folder_move_deferred",
      detail: "Took over an expired Editor folder move that had not reached Dropbox yet; released it so a normal pass re-checks blocking jobs and the quiet period",
    };
  }
  return await blockByToken(env, db, mapping, "editor_folder_move_moved_elsewhere", `The Editor root now lives at ${current.path_display ?? current.path_lower}, neither the expected old nor new location; an operator must resolve this by hand`, now);
}

/**
 * Records one failed commit against the mapping, outside the batch that just rolled back. The
 * counter is fenced on the move token so a takeover by another pass cannot double-count, and the
 * escalation fires on the attempt that crosses the limit, so the audit row is written once.
 */
async function noteFailedCommit(
  env: Env, db: Database, mapping: EditorFolderMapping, targetPath: string, detail: string, now: Date,
): Promise<void> {
  const attempts = mapping.moveCommitAttempts + 1;
  const escalated = attempts >= MOVE_COMMIT_ATTEMPT_LIMIT;
  const note = escalated
    ? `editor_folder_move_stuck: the Dropbox folder has already moved to ${targetPath}, but the Portal could not record the move after ${attempts} attempts and has stopped retrying. The Editor pipeline for this project is paused until an operator resolves it. Last failure: ${detail}`
    : null;
  const update = env.DB.prepare(`
    UPDATE editor_folder_mappings SET move_commit_attempts = ?, move_note = COALESCE(?, move_note), updated_at = ?
    WHERE id = ? AND move_token = ? AND move_status = 'moving'
  `).bind(attempts, note, now.getTime(), mapping.id, mapping.moveToken);
  if (!escalated) {
    await update.run();
    return;
  }
  await env.DB.batch([
    update,
    env.DB.prepare(
      "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'editor_folder.move.commit_stuck', 'project', ?, ?, ? WHERE changes() = 1",
    ).bind(crypto.randomUUID(), mapping.projectId, JSON.stringify({
      actor: "editor_reconcile", mappingId: mapping.id, from: mapping.rootPath, to: targetPath, attempts, detail,
    }), now.getTime()),
  ]);
}

/** A mapping with `move_status = 'moving'`: takes over an expired lease (never starting a fresh
 * move — see `resolveTakeoverMove`) or reports another pass's lease is still active. */
export async function resumeEditorFolderMove(env: Env, db: Database, mapping: EditorFolderMapping, deps: EditorFolderMoveDependencies): Promise<EditorReconcileOutcome> {
  const now = deps.now();
  if (mapping.moveCommitAttempts >= MOVE_COMMIT_ATTEMPT_LIMIT) {
    // Escalated by `noteFailedCommit`. Taking the lease over again would repeat a failure that has
    // already proved deterministic; the mapping deliberately stays `moving` so nothing syncs
    // against the old path, and the note tells an operator why.
    return {
      status: "skipped", mapping, reason: "editor_folder_move_stuck",
      detail: mapping.moveNote ?? `The Editor folder move for this project failed to commit ${mapping.moveCommitAttempts} times and is no longer being retried; an operator must resolve it`,
    };
  }
  if (!mapping.moveExpiresAt || mapping.moveExpiresAt.getTime() >= now.getTime()) {
    return {
      status: "skipped", mapping, reason: "editor_folder_move_in_flight",
      detail: `Editor folder move token is still active${mapping.moveExpiresAt ? ` until ${mapping.moveExpiresAt.toISOString()}` : ""}; another pass is completing it`,
    };
  }
  const newToken = crypto.randomUUID();
  const newExpiresAt = new Date(now.getTime() + MOVE_LEASE_MS);
  const swap = await env.DB.prepare(`
    UPDATE editor_folder_mappings SET move_token = ?, move_expires_at = ?, updated_at = ?
    WHERE id = ? AND move_status = 'moving' AND move_token = ? AND move_expires_at = ?
  `).bind(newToken, newExpiresAt.getTime(), now.getTime(), mapping.id, mapping.moveToken, mapping.moveExpiresAt.getTime()).run();
  if ((swap.meta.changes ?? 0) !== 1) {
    const current = await getEditorFolderMapping(db, mapping.projectId);
    return { status: "skipped", mapping: current ?? mapping, reason: "editor_folder_move_in_flight", detail: "Another pass is already taking over this Editor folder move" };
  }
  const claimed = await getEditorFolderMapping(db, mapping.projectId);
  if (!claimed || claimed.moveToken !== newToken) {
    return { status: "skipped", mapping: claimed ?? mapping, reason: "editor_folder_move_in_flight", detail: "The Editor folder move changed while this pass was taking it over" };
  }
  return await resolveTakeoverMove(env, db, claimed, deps, now);
}

/** Clears a stale `blocked` state whose drift resolved itself (the Project's shoot date came back
 * to the mapping's own placement date before an operator acted on the block). */
async function clearStaleBlock(env: Env, db: Database, mapping: EditorFolderMapping, now: Date): Promise<void> {
  await env.DB.prepare(`
    UPDATE editor_folder_mappings SET move_status = NULL, move_target_shoot_date = NULL, move_note = NULL, updated_at = ?
    WHERE id = ? AND move_status = 'blocked' AND move_target_shoot_date = ?
  `).bind(now.getTime(), mapping.id, mapping.moveTargetShootDate).run();
}

/** Watches the now-empty former root after a move lands: human uploads are invisible to the move
 * itself (only the quiet period sees them before a commit), so this is the safety net afterwards.
 * Never adopts/merges what it finds — only reports it and, once 30 minutes have passed, stops
 * watching. Returns `null` when there is nothing to report (including when `movedFromPath` is unset). */
async function sweepOrphanUpload(env: Env, db: Database, mapping: EditorFolderMapping, deps: EditorFolderMoveDependencies, now: Date): Promise<EditorReconcileOutcome | null> {
  if (!mapping.movedFromPath) return null;
  let found = false;
  try {
    await deps.getMetadata(env, db, mapping.movedFromPath, mapping.connectionId);
    found = true;
  } catch (error) {
    if (!isDropboxPathNotFoundError(error)) throw error;
  }
  let result: EditorReconcileOutcome | null = null;
  if (found) {
    const auditId = crypto.randomUUID();
    const meta = JSON.stringify({ actor: "editor_reconcile", mappingId: mapping.id, oldPath: mapping.movedFromPath, newPath: mapping.rootPath });
    await env.DB.prepare(
      "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'editor_folder.move.orphan_upload', 'project', ?, ?, ?)",
    ).bind(auditId, mapping.projectId, meta, now.getTime()).run();
    result = {
      status: "skipped", mapping, reason: "editor_folder_move_orphan_upload",
      detail: `Files landed at ${mapping.movedFromPath} after the move; move them into ${mapping.rootPath} by hand`,
    };
  }
  if (mapping.moveCompletedAt && now.getTime() >= mapping.moveCompletedAt.getTime() + ORPHAN_SWEEP_MS) {
    await env.DB.prepare(`
      UPDATE editor_folder_mappings SET moved_from_path = NULL, move_completed_at = NULL, updated_at = ?
      WHERE id = ? AND moved_from_path = ? AND move_completed_at = ?
    `).bind(now.getTime(), mapping.id, mapping.movedFromPath, mapping.moveCompletedAt.getTime()).run();
  }
  return result;
}

/**
 * The move state machine's entry point for a `ready` mapping. Returns `null` when there is
 * nothing to report (no drift and no orphan upload) so the caller falls back to its plain
 * `mapped` outcome; otherwise returns the move's own outcome (moved / blocked / deferred).
 */
export async function attemptEditorFolderMove(
  env: Env,
  db: Database,
  project: { id: string; shootDate: string | null },
  mapping: EditorFolderMapping,
  deps: EditorFolderMoveDependencies,
): Promise<EditorReconcileOutcome | null> {
  const now = deps.now();

  if (mapping.moveStatus === "blocked" && mapping.moveTargetShootDate === project.shootDate) {
    // Still a mapping with a `moved_from_path` to watch: an earlier move landed, a LATER reschedule
    // blocked, and the orphan sweep's own bookkeeping (audit row, and clearing the watch at +30min)
    // must not stop just because this pass has a block to report instead. The block is the more
    // durable of the two — it sits in `move_note` until an operator acts — so it stays the outcome.
    await sweepOrphanUpload(env, db, mapping, deps, now);
    const parsed = mapping.moveNote === null ? null : parseReconcileNote(mapping.moveNote);
    if (parsed === null) {
      return { status: "skipped", mapping, reason: "editor_folder_move_deferred", detail: "The Editor folder move is blocked but its note is missing; the next reschedule re-evaluates it" };
    }
    return { status: "skipped", mapping, reason: parsed.reason, detail: parsed.detail };
  }

  const target = editorMoveTarget({ rootPath: mapping.rootPath, shootDate: mapping.shootDate }, project.shootDate);
  if (!target) {
    if (mapping.moveStatus === "blocked") await clearStaleBlock(env, db, mapping, now);
    return await sweepOrphanUpload(env, db, mapping, deps, now);
  }

  if (target.kind === "nonstandard_parent") {
    return await blockBeforeClaim(env, db, mapping, {
      code: "editor_folder_move_nonstandard_parent",
      detail: `The Editor root's current parent ${target.currentParent} is not this mapping's day folder for shoot date ${mapping.shootDate} (expected ${target.expectedDayPath}); an operator must move ${mapping.rootPath} into ${target.expectedDayPath} by hand before the Portal will retarget it`,
      nextShootDate: project.shootDate!,
    }, now);
  }

  // Only once there is a real move to make: every `ready` mapping is provisioned or linked with a
  // Dropbox folder ID, and the move follows the tree by that ID rather than by path. Without one
  // there is nothing safe to follow. Checked here, not earlier, so a mapping with nothing to move
  // still reports its ordinary `mapped` outcome rather than being blocked for a move nobody asked for.
  if (mapping.rootFolderId === null) {
    return await blockBeforeClaim(env, db, mapping, {
      code: "editor_folder_move_source_missing",
      detail: `The Editor mapping for ${mapping.rootPath} is ready but has no Dropbox folder ID recorded, so the Portal cannot follow the tree to move it; an operator must relink it`,
      nextShootDate: target.next,
    }, now);
  }

  const blockingJob = await findBlockingJob(db, project.id, now);
  if (blockingJob) {
    return {
      status: "skipped", mapping, reason: "editor_folder_move_deferred",
      detail: `${blockingJob.kind} job ${blockingJob.id} is in flight for this Project; the Editor folder move waits for it to finish or go stale`,
    };
  }
  if (await activeReconciliationClaim(db, project.id, now)) {
    return { status: "skipped", mapping, reason: "editor_folder_move_deferred", detail: "A RAW reconciliation pass is running for this Project; the Editor folder move waits for it to finish" };
  }
  const quietHit = await findRecentUpload(env, db, mapping, deps);
  if (quietHit) {
    return {
      status: "skipped", mapping, reason: "editor_folder_move_deferred",
      detail: `recent upload ${quietHit.path} at ${quietHit.serverModified}; the move waits for 30 quiet minutes`,
    };
  }

  const claim = await claimEditorFolderMove(env, db, mapping, project, target, now);
  if (claim.status === "conflict") {
    return await blockBeforeClaim(env, db, mapping, {
      code: "editor_folder_move_conflict",
      detail: `Another Editor folder mapping already holds or is moving to ${target.targetPath}`,
      nextShootDate: target.next,
    }, now);
  }
  if (claim.status === "deferred") {
    return {
      status: "skipped", mapping, reason: "editor_folder_move_deferred",
      detail: "Another reconcile changed the mapping while this pass tried to claim the Editor folder move; the next pass re-evaluates",
    };
  }

  const claimed = claim.mapping;
  const postClaimQuietHit = await findRecentUpload(env, db, claimed, deps);
  if (postClaimQuietHit) {
    await releaseEditorFolderMove(env, db, claimed, now, "post_claim_quiet_hit");
    const released = await getEditorFolderMapping(db, project.id);
    return {
      status: "skipped", mapping: released ?? claimed, reason: "editor_folder_move_deferred",
      detail: `recent upload ${postClaimQuietHit.path} at ${postClaimQuietHit.serverModified}; the move waits for 30 quiet minutes`,
    };
  }

  // Stamped only once the move is actually going ahead. Stamping before the claim wrote "no longer
  // blocks the Editor folder move" onto jobs for moves that then deferred on the quiet period or
  // lost the claim — a note about a move that never happened. The claim's own SQL decides what
  // blocks, by timestamp, so it is unaffected by where this runs.
  const staleJobIds = await markStaleJobs(db, project.id, now);
  return await resolveClaimedMove(env, db, claimed, target, staleJobIds, deps, now);
}
