import { and, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { editorFolderMappings, jobs, projectMembers, projects, user } from "@quincy/db/schema";
import type { Database } from "@quincy/db";

import type { DropboxEntry, DropboxFile, DropboxFolder } from "../dropbox/client";
import {
  createFolder,
  createFolderStrict,
  getMetadata,
  isDropboxPathNotFoundError,
  listFolderRecursive,
  moveFolderStrict,
  recordDropboxSuccess,
} from "../dropbox/client";
import { canonicalDropboxConnectionId } from "../dropbox/connection";
import { dropboxPathKey, pathEqualsOrIsBelow, TONOMO_RAW_ROOT } from "../dropbox/paths";
import { commitRawFolderPathChange, followRawFolderPathChange } from "../projects/raw-folder-path";
import { latestTonomoFormattedAddress } from "../tonomo/formatted-address";
import { pathFromRawFolderLink } from "../dropbox/sync";
import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import {
  EDITOR_INPUT_FOLDER,
  EDITOR_INPUT_NAME_PATTERN,
  EDITOR_NOTES_FOLDER,
  EDITOR_OUTPUT_FOLDER,
  EDITOR_OUTPUT_NAME_PATTERN,
  EDITOR_ROOT,
  editorFolderChildPath,
  editorFolderPath,
  editorFolderPathKey,
  deriveEditorProjectFolderName,
  isValidShootDate,
  parseShootDate,
  fallbackEditorProjectFolderName,
  type EditorNameSource,
  type EditorRawSource,
} from "./paths";
import {
  acquireEditorFolderProvisionLease,
  getEditorFolderMapping,
  markEditorFolderNeedsReview,
  markEditorFolderReady,
  recordEditorFolderDiagnostic,
  recordEditorFolderProvision,
  releaseEditorFolderProvisionLease,
  reserveEditorFolderMapping,
  retargetPendingEditorFolderMapping,
  type EditorFolderMapping,
  type EditorFolderSubtree,
} from "./mapping";
import { attemptEditorFolderMove, resumeEditorFolderMove, type EditorFolderMoveDependencies } from "./move";

export type DropboxMetadataOperation = (
  env: Env,
  db: Database,
  path: string,
  connectionId?: string,
) => Promise<DropboxFile | DropboxFolder>;
export type DropboxCreateFolderOperation = (
  env: Env,
  db: Database,
  path: string,
  connectionId?: string,
) => Promise<void>;
type DropboxCreateFolderStrictOperation = (
  env: Env,
  db: Database,
  path: string,
  connectionId?: string,
) => Promise<DropboxFolder>;
export type DropboxMoveFolderOperation = (
  env: Env,
  db: Database,
  fromPath: string,
  toPath: string,
  connectionId?: string,
) => Promise<DropboxFolder>;
export type DropboxListFolderRecursiveOperation = (
  env: Env,
  db: Database,
  path: string,
  connectionId?: string,
) => Promise<DropboxEntry[]>;
type DropboxConnectionOperation = (db: Database) => Promise<string>;
type RawFolderPathOperation = (env: Env, rawFolderLink: string | null, connectionId: string) => Promise<string | null>;

export type EditorFolderScaffoldDependencies = {
  db?: Database;
  getMetadata?: DropboxMetadataOperation;
  createFolder?: DropboxCreateFolderOperation;
  createFolderStrict?: DropboxCreateFolderStrictOperation;
  moveFolderStrict?: DropboxMoveFolderOperation;
  listFolderRecursive?: DropboxListFolderRecursiveOperation;
  canonicalDropboxConnectionId?: DropboxConnectionOperation;
  resolveRawFolderPath?: RawFolderPathOperation;
  now?: () => Date;
  leaseMs?: number;
};

type FolderRole = "root" | "input" | "output" | "editing_notes";

type ChildName = typeof EDITOR_INPUT_FOLDER | typeof EDITOR_OUTPUT_FOLDER | typeof EDITOR_NOTES_FOLDER;
type ChildSpec = { role: Exclude<FolderRole, "root">; name: ChildName; pattern: RegExp | null };

/**
 * `name` is what a fresh create uses; `pattern` is how an already-recorded child of the same
 * role is recognised directly below the root, so a tree begun under the plain `Input`/`Output`
 * spelling resumes with the child it already has instead of gaining a numbered sibling.
 */
const CHILD_SPECS: readonly ChildSpec[] = [
  { role: "input", name: EDITOR_INPUT_FOLDER, pattern: EDITOR_INPUT_NAME_PATTERN },
  { role: "output", name: EDITOR_OUTPUT_FOLDER, pattern: EDITOR_OUTPUT_NAME_PATTERN },
  { role: "editing_notes", name: EDITOR_NOTES_FOLDER, pattern: null },
];

function isDropboxConflict(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (/(?:\b409\b|path\/conflict|already exists|conflict)/i.test(cause.message)) return true;
  }
  return false;
}

function isFolder(value: DropboxFile | DropboxFolder | undefined): value is DropboxFolder {
  return value?.[".tag"] === "folder";
}

function exactFolder(value: DropboxFile | DropboxFolder | undefined, expectedPath: string, expectedId?: string): value is DropboxFolder {
  if (!isFolder(value) || !value.id) return false;
  try {
    if (editorFolderPathKey(value.path_lower) !== editorFolderPathKey(expectedPath)) return false;
    if (value.path_display !== undefined && editorFolderPathKey(value.path_display) !== editorFolderPathKey(expectedPath)) return false;
  } catch {
    return false;
  }
  return expectedId === undefined || value.id === expectedId;
}

function childPath(mapping: EditorFolderMapping, name: ChildName): string {
  return editorFolderChildPath(mapping.rootPath, name);
}

type PersistedChild = { path: string; folderId: string };

/**
 * The child already recorded for this role directly below the project root, under either
 * spelling. Legacy section roots (`Day/Input`) sit one level deeper and never match here.
 */
function persistedChild(mapping: EditorFolderMapping, spec: ChildSpec): PersistedChild | undefined {
  if (spec.role === "editing_notes") {
    return mapping.editingNotesFolderId ? { path: childPath(mapping, spec.name), folderId: mapping.editingNotesFolderId } : undefined;
  }
  const roots = spec.role === "input" ? mapping.inputRoots : mapping.outputRoots;
  const rootKey = editorFolderPathKey(mapping.rootPath);
  for (const root of roots) {
    if (!root.folderId) continue;
    try {
      const segments = root.path.split("/");
      const leaf = segments.at(-1) ?? "";
      if (editorFolderPathKey(segments.slice(0, -1).join("/")) === rootKey && spec.pattern?.test(leaf)) {
        return { path: root.path, folderId: root.folderId };
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function currentChildRoots(mapping: EditorFolderMapping, role: "input" | "output", path: string, folderId: string): EditorFolderSubtree[] {
  const roots = role === "input" ? mapping.inputRoots : mapping.outputRoots;
  const next = roots.filter((root) => {
    try {
      return editorFolderPathKey(root.path) !== editorFolderPathKey(path);
    } catch {
      return true;
    }
  });
  return [...next, { path, section: null, folderId }];
}

async function markConflict(
  db: Database,
  mapping: EditorFolderMapping,
  leaseToken: string,
  role: FolderRole,
  path: string,
  reason: string,
  folderId?: string,
): Promise<EditorFolderMapping> {
  return markEditorFolderNeedsReview(db, mapping.id, {
    reason,
    leaseToken,
    conflict: { role, path, reason, ...(folderId === undefined ? {} : { folderId }) },
  });
}

async function getExactMetadata(
  env: Env,
  db: Database,
  operation: DropboxMetadataOperation,
  path: string,
  connectionId: string,
): Promise<DropboxFile | DropboxFolder | undefined> {
  try {
    return await operation(env, db, path, connectionId);
  } catch (error) {
    if (isDropboxPathNotFoundError(error)) return undefined;
    throw error;
  }
}

async function ensureChild(
  env: Env,
  db: Database,
  mapping: EditorFolderMapping,
  connectionId: string,
  leaseToken: string,
  spec: ChildSpec,
  operations: Required<Pick<EditorFolderScaffoldDependencies, "getMetadata" | "createFolderStrict">>,
): Promise<EditorFolderMapping> {
  const persisted = persistedChild(mapping, spec);
  if (persisted) {
    const metadata = await getExactMetadata(env, db, operations.getMetadata, persisted.path, connectionId);
    if (!exactFolder(metadata, persisted.path, persisted.folderId)) {
      return markConflict(db, mapping, leaseToken, spec.role, persisted.path, `Persisted ${spec.name} folder metadata no longer matches its recorded Dropbox ID`, persisted.folderId);
    }
    return mapping;
  }
  const path = childPath(mapping, spec.name);

  try {
    const created = await operations.createFolderStrict(env, db, path, connectionId);
    if (!exactFolder(created, path)) {
      return markConflict(db, mapping, leaseToken, spec.role, path, `Dropbox returned unexpected metadata after creating ${spec.name}`);
    }
    return await recordEditorFolderProvision(db, mapping.id, {
      role: spec.role,
      path,
      folderId: created.id,
      method: "created",
      leaseToken,
    });
  } catch (error) {
    if (!isDropboxConflict(error)) throw error;
    // A child conflict is adoptable only after the project root was proven owned in this run.
    const existing = await getExactMetadata(env, db, operations.getMetadata, path, connectionId);
    if (!exactFolder(existing, path)) {
      return markConflict(db, mapping, leaseToken, spec.role, path, `Dropbox reported an existing ${spec.name} path but exact folder metadata could not be verified`, existing?.id);
    }
    return await recordEditorFolderProvision(db, mapping.id, {
      role: spec.role,
      path,
      folderId: existing.id,
      method: "verified_existing_child",
      leaseToken,
    });
  }
}

async function persistDiagnostic(db: Database, mappingId: string, leaseToken: string, error: unknown): Promise<void> {
  try {
    await recordEditorFolderDiagnostic(db, mappingId, { message: errorMessage(error), leaseToken });
  } catch (diagnosticError) {
    // Preserve the provider/DB error that caused the reconciliation to fail. The original error
    // is retried by the queue, while a diagnostic write can legitimately lose a lease race.
    console.error("Editor folder diagnostic could not be persisted", { mappingId, error: errorMessage(diagnosticError) });
  }
}

function addressLeaf(path: string): string | undefined {
  return path.split("/").filter(Boolean).at(-1)?.toLowerCase();
}

/** Why a reconcile pass ended without a ready tree. Written to `jobs.error` by the queue consumer. */
export type EditorScaffoldSkipReason =
  | "project_inactive"
  | "no_shoot_date"
  | "no_active_photographer"
  | "raw_identity_unavailable"
  | "raw_leaf_mismatch"
  | "raw_outside_root"
  | "raw_path_recovered"
  | "raw_path_change_lost"
  | "raw_sync_in_flight"
  | "provision_lease_held"
  | "project_not_provisionable"
  | "editor_folder_move_nonstandard_parent"
  | "editor_folder_move_conflict"
  | "editor_folder_move_source_missing"
  | "editor_folder_move_moved_elsewhere"
  | "editor_folder_move_deferred"
  | "editor_folder_move_in_flight"
  | "editor_folder_move_orphan_upload";

/** Every code that can prefix an `editor_reconcile` job's `error` note. */
export type EditorReconcileNoteCode = EditorScaffoldSkipReason | "needs_review" | "autocreate_not_allowed" | "editor_folder_moved";

export type EditorReconcileOutcome =
  | { status: "mapped"; mapping: EditorFolderMapping }
  | { status: "needs_review"; mapping: EditorFolderMapping; reason: string }
  | { status: "skipped"; mapping: EditorFolderMapping | null; reason: EditorScaffoldSkipReason; detail: string }
  | { status: "moved"; mapping: EditorFolderMapping; from: string; to: string; previousShootDate: string };

type RawIdentitySkip = { skip: EditorScaffoldSkipReason; detail: string };

/** The `jobs.error` text for a pass that created no ready tree: `<code>: <sentence>`; undefined when it did. */
export function editorReconcileNote(outcome: EditorReconcileOutcome): string | undefined {
  if (outcome.status === "skipped") return reconcileNote(outcome.reason, outcome.detail);
  if (outcome.status === "needs_review") return reconcileNote("needs_review", outcome.reason);
  if (outcome.status === "moved") {
    return reconcileNote("editor_folder_moved", `Moved the Editor tree from ${outcome.from} to ${outcome.to} after the shoot date changed from ${outcome.previousShootDate} to ${outcome.mapping.shootDate}`);
  }
  return undefined;
}

export function reconcileNote(code: EditorReconcileNoteCode, detail: string): string {
  return `${code}: ${detail}`;
}

type RawIdentity = {
  rawFolderPath: string;
  projectFolderName: string;
  tonomoFolderId?: string;
  rawSource: EditorRawSource;
  nameSource: EditorNameSource;
};

type RawIdentityProject = {
  id: string;
  rawFolderPath: string | null;
  rawFolderLink: string | null;
  orderId: string | null;
  street: string;
  suburb: string | null;
};

/**
 * Where the Project's RAW folder is, and what to call its Editor tree, in this order:
 * 1. the stored Tonomo path still exists: name from Dropbox path_display (original casing);
 * 2. it does not, but the RAW shared link resolves to a folder under the Tonomo RAW root: Tonomo
 *    moved it (photographer or date change); adopt the new path on the Project and name from it;
 *    a link that resolves OUTSIDE the RAW root is reported and never adopted: that project was
 *    completed and delivered outside the Portal, so an admin should mark it delivered/archived;
 * 3. neither: the folder is gone; keep the stored path as the identity and name the tree from
 *    Tonomo's original-cased formatted address (else the Project's own address). RAW then arrives
 *    through the Editor tree's Input root, which is what a ready mapping does anyway.
 */
/**
 * Queued or running `dropbox_sync` jobs touched within the last two hours; older ones are stuck,
 * not in flight. Measured on the wall clock because `jobs.updated_at` is written by the queue
 * consumer's clock, not the caller's injected `now`.
 */
async function rawSyncInFlight(db: Database, projectId: string): Promise<boolean> {
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const job = await db.select({ id: jobs.id }).from(jobs).where(and(
    eq(jobs.projectId, projectId),
    eq(jobs.kind, "dropbox_sync"),
    inArray(jobs.status, ["queued", "running"]),
    gte(jobs.updatedAt, since),
  )).get();
  return Boolean(job);
}

async function resolveRawIdentity(
  env: Env,
  db: Database,
  project: RawIdentityProject,
  connectionId: string,
  operations: { getMetadata: DropboxMetadataOperation; resolveRawFolderPath: RawFolderPathOperation },
): Promise<RawIdentity | RawIdentitySkip> {
  const storedPath = project.rawFolderPath;
  const rawFolderPath = storedPath || await operations.resolveRawFolderPath(env, project.rawFolderLink, connectionId);
  if (!rawFolderPath) return { skip: "raw_identity_unavailable", detail: "The Project has no Tonomo RAW folder path, and its RAW shared link (if any) does not resolve to a Dropbox path" };
  const tonomoMetadata = await getExactMetadata(env, db, operations.getMetadata, rawFolderPath, connectionId);
  if (isFolder(tonomoMetadata)) {
    return {
      rawFolderPath,
      projectFolderName: deriveEditorProjectFolderName(tonomoMetadata.path_display ?? rawFolderPath),
      tonomoFolderId: tonomoMetadata.id,
      rawSource: "tonomo",
      nameSource: "tonomo_path_display",
    };
  }

  if (storedPath && project.rawFolderLink) {
    let linkPath: string | null = null;
    try {
      linkPath = await operations.resolveRawFolderPath(env, project.rawFolderLink, connectionId);
    } catch (error) {
      // A deleted target or a link outside the studio account is a fact about the folder; anything
      // else (auth, rate limit, outage) is an error and must not be mistaken for "gone".
      if (!isDropboxPathNotFoundError(error) && !errorMessage(error).includes("Shared link is not owned by")) throw error;
      console.log("Editor scaffold: RAW shared link did not resolve", { projectId: project.id, error: errorMessage(error) });
    }
    if (linkPath && dropboxPathKey(linkPath) !== dropboxPathKey(storedPath)) {
      const linkMetadata = await getExactMetadata(env, db, operations.getMetadata, linkPath, connectionId);
      if (isFolder(linkMetadata)) {
        if (addressLeaf(linkPath) !== addressLeaf(storedPath)) {
          // Same rule as the Tonomo processor: Editor and AutoHDR names derive from the address leaf.
          console.log("Editor scaffold skipped: RAW folder found under a different address leaf; needs manual review", { projectId: project.id, storedPath, linkPath });
          return { skip: "raw_leaf_mismatch", detail: `The RAW shared link now points at ${linkMetadata.path_display ?? linkPath}, a different address from the stored ${storedPath}; review the Project manually` };
        }
        if (!pathEqualsOrIsBelow(linkPath, TONOMO_RAW_ROOT) || dropboxPathKey(linkPath) === dropboxPathKey(TONOMO_RAW_ROOT)) {
          const detail = `RAW folder now lives at ${linkMetadata.path_display ?? linkPath}, outside ${TONOMO_RAW_ROOT}. This project was completed and delivered outside the Portal; mark it delivered or archived instead of chasing the folder.`;
          console.log("Editor scaffold skipped: RAW folder found outside the Tonomo RAW root", { projectId: project.id, reason: detail });
          return { skip: "raw_outside_root", detail };
        }
        const adopted = await commitRawFolderPathChange(env, {
          projectId: project.id, previousPath: storedPath, previousLink: project.rawFolderLink,
          path: linkPath, link: null, dropboxFolderId: linkMetadata.id, actor: "editor_scaffold",
        });
        if (!adopted) return { skip: "raw_path_change_lost", detail: "The Project's RAW folder path changed while the shared link was being resolved; the next pass re-reads it" };
        await followRawFolderPathChange(env, db, project.id, "editor_scaffold_raw_path_recovered");
        // Stop here: a ready mapping hands RAW intake to the Editor Input root, so the recovered
        // Tonomo folder must be scanned before any tree exists. The queued sync scans it, and the
        // next reconcile (hourly recovery or the sync's own follow-up) finds the stored path and
        // creates the tree from its path_display like any other project.
        console.log("Editor scaffold deferred: RAW folder path recovered from the shared link; scanning it before creating the tree", { projectId: project.id, storedPath, linkPath });
        return { skip: "raw_path_recovered", detail: `RAW folder found at ${linkMetadata.path_display ?? linkPath} via the shared link; the Project now points there and a RAW sync is queued. The tree is created on the next pass` };
      }
    }
  }

  const fallback = fallbackEditorProjectFolderName({
    storedRawFolderPath: rawFolderPath,
    formattedAddress: await latestTonomoFormattedAddress(env, project.orderId),
    street: project.street,
    suburb: project.suburb,
  });
  console.log("Editor scaffold: Tonomo RAW folder is missing; creating the Editor tree from the fallback name", { projectId: project.id, rawFolderPath, nameSource: fallback.source });
  return { rawFolderPath, projectFolderName: fallback.name, rawSource: "missing", nameSource: fallback.source };
}

/**
 * Reconciles the Portal-owned Editor folder tree for one active Project.
 *
 * Existing Dropbox project roots are never silently adopted. Only child conflicts below a root
 * created by this mapping, or below a previously persisted/proven root ID, may be adopted after
 * an exact metadata re-read. Every successful create is recorded before the next provider call so
 * a retry resumes from the durable partial tree.
 */
export async function reconcileEditorFolder(
  env: Env,
  projectId: string,
  dependencies: EditorFolderScaffoldDependencies = {},
): Promise<EditorFolderMapping | null> {
  return (await reconcileEditorFolderOutcome(env, projectId, dependencies)).mapping;
}

/**
 * The pass's result from the mapping it ends with: ready is mapped, a conflict is needs_review,
 * and a mapping still pending here means a lease-fenced write lost to another pass, never a tree.
 */
function outcomeFor(mapping: EditorFolderMapping): EditorReconcileOutcome {
  if (mapping.state === "needs_review") {
    return { status: "needs_review", mapping, reason: mapping.recoveryProof?.conflict?.reason ?? mapping.recoveryProof?.lastError ?? "Editor folder mapping needs operator review" };
  }
  if (mapping.state === "pending") {
    return { status: "skipped", mapping, reason: "provision_lease_held", detail: "Another reconcile changed the mapping while this pass held the provisioning lease; the next pass finishes it" };
  }
  return { status: "mapped", mapping };
}

/**
 * The stored and current shoot dates of a Portal-derived mapping whose day folder no longer matches, or null when the
 * dates agree, the Project's date is not a calendar date, or an operator linked the root by hand
 * (a hand-linked path is theirs, whatever the date says).
 */
function shootDateDrift(
  mapping: EditorFolderMapping,
  projectShootDate: string | null,
): { previous: string; next: string } | null {
  if (!isValidShootDate(projectShootDate) || projectShootDate === mapping.shootDate) return null;
  if (mapping.reviewedBy !== null) return null;
  let derivedKey: string;
  try {
    derivedKey = editorFolderPathKey(editorFolderPath({ shootDate: mapping.shootDate, projectFolderName: mapping.projectFolderName }));
  } catch {
    return null;
  }
  if (derivedKey !== mapping.rootPathKey) return null;
  return { previous: mapping.shootDate, next: projectShootDate };
}

/**
 * `reconcileEditorFolder` with the reason a pass stopped short of a ready tree, so the queue
 * consumer can record it on the job instead of leaving a silent "done".
 */
export async function reconcileEditorFolderOutcome(
  env: Env,
  projectId: string,
  dependencies: EditorFolderScaffoldDependencies = {},
): Promise<EditorReconcileOutcome> {
  const skipped = (reason: EditorScaffoldSkipReason, detail: string, mapping: EditorFolderMapping | null = null): EditorReconcileOutcome => ({ status: "skipped", mapping, reason, detail });
  const db = dependencies.db ?? dbFor(env);
  // After a lost race, report whatever the mapping became: still pending is a skip, anything else is its own result.
  const settled = async (reason: EditorScaffoldSkipReason, detail: string, fallback: EditorFolderMapping): Promise<EditorReconcileOutcome> => {
    const current = (await getEditorFolderMapping(db, projectId)) ?? fallback;
    return current.state === "pending" ? skipped(reason, detail, current) : outcomeFor(current);
  };
  const now = dependencies.now ?? (() => new Date());
  const getMetadataOperation = dependencies.getMetadata ?? getMetadata;
  const createFolderOperation = dependencies.createFolder ?? createFolder;
  const createFolderStrictOperation = dependencies.createFolderStrict ?? createFolderStrict;
  const moveFolderStrictOperation = dependencies.moveFolderStrict ?? moveFolderStrict;
  const listFolderRecursiveOperation = dependencies.listFolderRecursive ?? listFolderRecursive;
  const connectionOperation = dependencies.canonicalDropboxConnectionId ?? canonicalDropboxConnectionId;
  const rawFolderPathOperation = dependencies.resolveRawFolderPath ?? ((currentEnv, link, connectionId) => pathFromRawFolderLink(currentEnv, link, connectionId));
  const moveDependencies: EditorFolderMoveDependencies = {
    getMetadata: getMetadataOperation,
    createFolder: createFolderOperation,
    moveFolderStrict: moveFolderStrictOperation,
    listFolderRecursive: listFolderRecursiveOperation,
    now,
  };

  // A mapping mid-move must be resolved (commit or release) even for a Project that has since
  // become archived/delivered; the resume path may only finish an in-flight move, never start
  // one — a fresh move only ever starts from the ready branch below.
  const priorMapping = await getEditorFolderMapping(db, projectId);
  if (priorMapping?.moveStatus === "moving") {
    return await resumeEditorFolderMove(env, db, priorMapping, moveDependencies);
  }

  const project = await db.select({
    id: projects.id,
    shootDate: projects.shootDate,
    rawFolderPath: projects.rawFolderPath,
    rawFolderLink: projects.rawFolderLink,
    orderId: projects.orderId,
    street: projects.street,
    suburb: projects.suburb,
  }).from(projects).where(and(eq(projects.id, projectId), isNull(projects.archivedAt), ne(projects.stageKey, "delivered"))).get();
  if (!project) return skipped("project_inactive", "Project is archived, delivered or missing");

  let mapping = priorMapping;
  if (mapping?.state === "needs_review") return outcomeFor(mapping);
  if (mapping?.state === "ready") {
    // A ready tree that has drifted from the Project's current shoot date is moved (or blocked
    // and reported) here; a mapping with nothing to move still runs the orphan-upload sweep.
    const moveOutcome = await attemptEditorFolderMove(env, db, project, mapping, moveDependencies);
    if (moveOutcome) return moveOutcome;
    return outcomeFor(mapping);
  }

  let connectionId: string;
  if (mapping) {
    connectionId = mapping.connectionId;
  } else {
    if (!project.shootDate) return skipped("no_shoot_date", "Project has no shoot date");
    parseShootDate(project.shootDate);
    const photographer = await db.select({ userId: projectMembers.userId }).from(projectMembers)
      .innerJoin(user, eq(projectMembers.userId, user.id))
      .where(and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.roleOnProject, "photographer"),
        eq(user.active, true),
      )).get();
    if (!photographer) return skipped("no_active_photographer", "Project has no active photographer member");
    connectionId = await connectionOperation(db);

    const identity = await resolveRawIdentity(env, db, project, connectionId, { getMetadata: getMetadataOperation, resolveRawFolderPath: rawFolderPathOperation });
    if ("skip" in identity) return skipped(identity.skip, identity.detail);
    mapping = await reserveEditorFolderMapping(db, {
      projectId,
      connectionId,
      shootDate: project.shootDate,
      projectFolderName: identity.projectFolderName,
      tonomoRawFolderPath: identity.rawFolderPath,
      photographerEvidence: {
        userId: photographer.userId,
        roleOnProject: "photographer",
        active: true,
        ...(identity.tonomoFolderId ? { tonomoFolderId: identity.tonomoFolderId } : {}),
        rawSource: identity.rawSource,
        nameSource: identity.nameSource,
      },
      now: now(),
    });
    if (mapping.state !== "pending") return outcomeFor(mapping);
    connectionId = mapping.connectionId;
  }

  // A ready tree takes RAW intake away from the Tonomo folder, so never finish one while a RAW
  // sync of that folder is queued or running (a Tonomo path change or link recovery just nudged
  // one). The hourly recovery pass retries once the sync has settled.
  if (await rawSyncInFlight(db, projectId)) {
    console.log("Editor scaffold deferred: a RAW sync for the project is still in flight", { projectId, mappingId: mapping.id });
    return skipped("raw_sync_in_flight", "A RAW sync for the Project is queued or running; the tree is created once it settles", mapping);
  }
  const lease = await acquireEditorFolderProvisionLease(db, mapping.id, now(), dependencies.leaseMs);
  if (!lease) return settled("provision_lease_held", "Another reconcile holds the provisioning lease for this mapping", mapping);
  mapping = lease.mapping;

  const operations = { getMetadata: getMetadataOperation, createFolderStrict: createFolderStrictOperation };
  try {
    // Re-read mutable assignment state after reservation and immediately before Dropbox creates.
    // A queued job must not create a new external tree after the photographer is unassigned.
    const stillProvisionable = await db.select({ userId: projectMembers.userId, shootDate: projects.shootDate }).from(projectMembers)
      .innerJoin(user, eq(projectMembers.userId, user.id))
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.roleOnProject, "photographer"),
        eq(user.active, true),
        isNull(projects.archivedAt),
        ne(projects.stageKey, "delivered"),
      )).get();
    if (!stillProvisionable) return settled("project_not_provisionable", "Project lost its active photographer, was archived or was delivered after the tree was reserved", mapping);
    // A pending mapping that has created nothing yet follows a verified reschedule to the new day
    // folder; once anything exists in Dropbox the tree stays put (see the ready branch above).
    // The date is re-read inside the lease: a reschedule committed after this pass first read the
    // Project must not let the tree be created under the old day.
    const pendingReschedule = mapping.rootFolderId ? null : shootDateDrift(mapping, stillProvisionable.shootDate);
    // An unrecorded root at the old path means a previous pass created it and died before writing
    // the id. Retargeting would orphan it, so provision in place and let the existing-root review take it.
    if (pendingReschedule && !await getExactMetadata(env, db, getMetadataOperation, mapping.rootPath, connectionId)) {
      const retarget = await retargetPendingEditorFolderMapping(db, mapping.id, { shootDate: pendingReschedule.next, leaseToken: lease.token, at: now() });
      if (retarget.status === "held") {
        mapping = await markConflict(db, mapping, lease.token, "root", retarget.rootPath, "Editor root for the new shoot date is already mapped to another Project");
        return outcomeFor(mapping);
      }
      if (retarget.status === "stale") return settled("provision_lease_held", "The mapping changed while this pass was re-pointing it at the new shoot date; the next pass re-reads it", mapping);
      // "started" keeps the stored root: the tree is finished where it began and reported as not moved.
      if (retarget.status === "retargeted") mapping = retarget.mapping;
    }
    const monthPath = mapping.rootPath.split("/").slice(0, -2).join("/");
    const dayPath = mapping.rootPath.split("/").slice(0, -1).join("/");
    // The configured Editor root is pre-existing and deliberately excluded from this chain.
    if (!monthPath.startsWith(`${EDITOR_ROOT}/`) || !dayPath.startsWith(`${monthPath}/`)) {
      mapping = await markConflict(db, mapping, lease.token, "root", mapping.rootPath, "Persisted Editor root is outside the configured workspace");
      return outcomeFor(mapping);
    }
    await createFolderOperation(env, db, monthPath, connectionId);
    await createFolderOperation(env, db, dayPath, connectionId);

    let root: DropboxFolder | undefined;
    if (mapping.rootFolderId) {
      const metadata = await getExactMetadata(env, db, getMetadataOperation, mapping.rootPath, connectionId);
      if (!exactFolder(metadata, mapping.rootPath, mapping.rootFolderId)) {
        mapping = await markConflict(db, mapping, lease.token, "root", mapping.rootPath, "Persisted Editor root metadata no longer matches its recorded Dropbox ID", mapping.rootFolderId);
        return outcomeFor(mapping);
      }
      root = metadata;
    } else {
      const existing = await getExactMetadata(env, db, getMetadataOperation, mapping.rootPath, connectionId);
      if (existing) {
        mapping = await markConflict(db, mapping, lease.token, "root", mapping.rootPath, "An existing Dropbox project folder requires explicit operator review", existing.id);
        return outcomeFor(mapping);
      }
      try {
        const created = await createFolderStrictOperation(env, db, mapping.rootPath, connectionId);
        if (!exactFolder(created, mapping.rootPath)) {
          mapping = await markConflict(db, mapping, lease.token, "root", mapping.rootPath, "Dropbox returned unexpected metadata after creating the Editor project folder");
          return outcomeFor(mapping);
        }
        mapping = await recordEditorFolderProvision(db, mapping.id, {
          role: "root",
          path: mapping.rootPath,
          folderId: created.id,
          method: "created",
          leaseToken: lease.token,
        });
        if (mapping.state !== "pending") return outcomeFor(mapping);
        root = created;
      } catch (error) {
        if (!isDropboxConflict(error)) throw error;
        mapping = await markConflict(db, mapping, lease.token, "root", mapping.rootPath, "Editor project folder creation conflicted; existing roots are never auto-adopted");
        return outcomeFor(mapping);
      }
    }
    if (!root) throw new Error("Editor root metadata was not established");

    for (const spec of CHILD_SPECS) {
      mapping = await ensureChild(env, db, mapping, connectionId, lease.token, spec, operations);
      if (mapping.state !== "pending") return outcomeFor(mapping);
    }

    const provisioned = mapping;
    const [input, output, notes] = CHILD_SPECS.map((spec) => persistedChild(provisioned, spec));
    if (!provisioned.rootFolderId || !input || !output || !notes) {
      throw new Error("Editor folder provisioning completed without all required folder IDs");
    }
    const ready = await markEditorFolderReady(db, provisioned.id, {
      rootFolderId: provisioned.rootFolderId,
      inputRoots: currentChildRoots(provisioned, "input", input.path, input.folderId),
      outputRoots: currentChildRoots(provisioned, "output", output.path, output.folderId),
      editingNotesFolderId: notes.folderId,
      leaseToken: lease.token,
      at: now(),
    });
    if (ready.state === "ready") await recordDropboxSuccess(db, connectionId, ["credentials", "current_account", "list_folder", "folder_path"]);
    return outcomeFor(ready);
  } catch (error) {
    await persistDiagnostic(db, mapping.id, lease.token, error);
    throw error;
  } finally {
    await releaseEditorFolderProvisionLease(db, mapping.id, lease.token, now());
  }
}
