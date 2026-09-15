import { and, eq, isNull } from "drizzle-orm";
import { editorFolderMappings, projectMembers, projects, user } from "@quincy/db/schema";
import type { Database } from "@quincy/db";

import type { DropboxFile, DropboxFolder } from "../dropbox/client";
import {
  createFolder,
  createFolderStrict,
  getMetadata,
  isDropboxPathNotFoundError,
  recordDropboxSuccess,
} from "../dropbox/client";
import { canonicalDropboxConnectionId } from "../dropbox/connection";
import { dropboxPathKey, pathEqualsOrIsBelow, TONOMO_RAW_ROOT } from "../dropbox/paths";
import { enqueueAutoHdrScaffold } from "../autohdr/scaffold";
import { commitRawFolderPathChange, enqueueRawFolderPathSync } from "../projects/raw-folder-path";
import { latestTonomoFormattedAddress } from "../tonomo/formatted-address";
import { pathFromRawFolderLink } from "../dropbox/sync";
import type { Env } from "../env";
import { dbFor } from "../lib/db";
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
  parseShootDate,
  fallbackEditorProjectFolderName,
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
  type EditorFolderMapping,
  type EditorFolderSubtree,
} from "./mapping";

export type DropboxMetadataOperation = (
  env: Env,
  db: Database,
  path: string,
  connectionId?: string,
) => Promise<DropboxFile | DropboxFolder>;
type DropboxCreateFolderOperation = (
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
type DropboxConnectionOperation = (db: Database) => Promise<string>;
type RawFolderPathOperation = (env: Env, rawFolderLink: string | null, connectionId: string) => Promise<string | null>;

export type EditorFolderScaffoldDependencies = {
  db?: Database;
  getMetadata?: DropboxMetadataOperation;
  createFolder?: DropboxCreateFolderOperation;
  createFolderStrict?: DropboxCreateFolderStrictOperation;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

/**
 * Reconciles the Portal-owned Editor folder tree for one active Project.
 *
 * Existing Dropbox project roots are never silently adopted. Only child conflicts below a root
 * created by this mapping, or below a previously persisted/proven root ID, may be adopted after
 * an exact metadata re-read. Every successful create is recorded before the next provider call so
 * a retry resumes from the durable partial tree.
 */
export type EditorRawSource = "tonomo" | "link_recovered" | "missing";
export type EditorNameSource = "tonomo_path_display" | "tonomo_formatted_address" | "project_address";

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
async function resolveRawIdentity(
  env: Env,
  db: Database,
  project: RawIdentityProject,
  connectionId: string,
  operations: { getMetadata: DropboxMetadataOperation; resolveRawFolderPath: RawFolderPathOperation },
): Promise<RawIdentity | null> {
  const storedPath = project.rawFolderPath;
  const rawFolderPath = storedPath || await operations.resolveRawFolderPath(env, project.rawFolderLink, connectionId);
  if (!rawFolderPath) return null;
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
      console.log("Editor scaffold: RAW shared link did not resolve", { projectId: project.id, error: errorMessage(error) });
    }
    if (linkPath && dropboxPathKey(linkPath) !== dropboxPathKey(storedPath)) {
      const linkMetadata = await getExactMetadata(env, db, operations.getMetadata, linkPath, connectionId);
      if (isFolder(linkMetadata)) {
        if (!pathEqualsOrIsBelow(linkPath, TONOMO_RAW_ROOT)) {
          console.log("Editor scaffold skipped: RAW folder found outside the Tonomo RAW root", {
            projectId: project.id,
            reason: `RAW folder now lives at ${linkMetadata.path_display ?? linkPath}, outside ${TONOMO_RAW_ROOT}. This project was completed and delivered outside the Portal; mark it delivered or archived instead of chasing the folder.`,
          });
          return null;
        }
        const adopted = await commitRawFolderPathChange(env, {
          projectId: project.id, previousPath: storedPath, previousLink: project.rawFolderLink,
          path: linkPath, link: null, dropboxFolderId: linkMetadata.id, actor: "editor_scaffold",
        });
        if (!adopted) return null;
        await enqueueAutoHdrScaffold(env, project.id).catch((error) =>
          console.error("AutoHDR scaffold trigger failed", { projectId: project.id, error }));
        await enqueueRawFolderPathSync(env, db, project.id, "editor_scaffold_raw_path_recovered").catch((error) =>
          console.error("RAW folder path sync trigger failed", { projectId: project.id, error }));
        return {
          rawFolderPath: linkPath,
          projectFolderName: deriveEditorProjectFolderName(linkMetadata.path_display ?? linkPath),
          tonomoFolderId: linkMetadata.id,
          rawSource: "link_recovered",
          nameSource: "tonomo_path_display",
        };
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

export async function reconcileEditorFolder(
  env: Env,
  projectId: string,
  dependencies: EditorFolderScaffoldDependencies = {},
): Promise<EditorFolderMapping | null> {
  const db = dependencies.db ?? dbFor(env);
  const now = dependencies.now ?? (() => new Date());
  const getMetadataOperation = dependencies.getMetadata ?? getMetadata;
  const createFolderOperation = dependencies.createFolder ?? createFolder;
  const createFolderStrictOperation = dependencies.createFolderStrict ?? createFolderStrict;
  const connectionOperation = dependencies.canonicalDropboxConnectionId ?? canonicalDropboxConnectionId;
  const rawFolderPathOperation = dependencies.resolveRawFolderPath ?? ((currentEnv, link, connectionId) => pathFromRawFolderLink(currentEnv, link, connectionId));

  const project = await db.select({
    id: projects.id,
    shootDate: projects.shootDate,
    rawFolderPath: projects.rawFolderPath,
    rawFolderLink: projects.rawFolderLink,
    orderId: projects.orderId,
    street: projects.street,
    suburb: projects.suburb,
  }).from(projects).where(and(eq(projects.id, projectId), isNull(projects.archivedAt))).get();
  if (!project) return null;

  let mapping = await getEditorFolderMapping(db, projectId);
  if (mapping?.state === "ready" || mapping?.state === "needs_review") return mapping;

  let connectionId: string;
  if (mapping) {
    connectionId = mapping.connectionId;
  } else {
    if (!project.shootDate) return null;
    parseShootDate(project.shootDate);
    const photographer = await db.select({ userId: projectMembers.userId }).from(projectMembers)
      .innerJoin(user, eq(projectMembers.userId, user.id))
      .where(and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.roleOnProject, "photographer"),
        eq(user.active, true),
      )).get();
    if (!photographer) return null;
    connectionId = await connectionOperation(db);

    const identity = await resolveRawIdentity(env, db, project, connectionId, { getMetadata: getMetadataOperation, resolveRawFolderPath: rawFolderPathOperation });
    if (!identity) return null;
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
    if (mapping.state !== "pending") return mapping;
    connectionId = mapping.connectionId;
  }

  if (!mapping) return null;
  const lease = await acquireEditorFolderProvisionLease(db, mapping.id, now(), dependencies.leaseMs);
  if (!lease) return (await getEditorFolderMapping(db, projectId)) ?? mapping;
  mapping = lease.mapping;

  const operations = { getMetadata: getMetadataOperation, createFolderStrict: createFolderStrictOperation };
  try {
    // Re-read mutable assignment state after reservation and immediately before Dropbox creates.
    // A queued job must not create a new external tree after the photographer is unassigned.
    const stillProvisionable = await db.select({ userId: projectMembers.userId }).from(projectMembers)
      .innerJoin(user, eq(projectMembers.userId, user.id))
      .innerJoin(projects, eq(projectMembers.projectId, projects.id))
      .where(and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.roleOnProject, "photographer"),
        eq(user.active, true),
        isNull(projects.archivedAt),
      )).get();
    if (!stillProvisionable) return (await getEditorFolderMapping(db, projectId)) ?? mapping;
    const monthPath = mapping.rootPath.split("/").slice(0, -2).join("/");
    const dayPath = mapping.rootPath.split("/").slice(0, -1).join("/");
    // The configured Editor root is pre-existing and deliberately excluded from this chain.
    if (!monthPath.startsWith(`${EDITOR_ROOT}/`) || !dayPath.startsWith(`${monthPath}/`)) {
      mapping = await markConflict(db, mapping, lease.token, "root", mapping.rootPath, "Persisted Editor root is outside the configured workspace");
      return mapping;
    }
    await createFolderOperation(env, db, monthPath, connectionId);
    await createFolderOperation(env, db, dayPath, connectionId);

    let root: DropboxFolder | undefined;
    if (mapping.rootFolderId) {
      const metadata = await getExactMetadata(env, db, getMetadataOperation, mapping.rootPath, connectionId);
      if (!exactFolder(metadata, mapping.rootPath, mapping.rootFolderId)) {
        mapping = await markConflict(db, mapping, lease.token, "root", mapping.rootPath, "Persisted Editor root metadata no longer matches its recorded Dropbox ID", mapping.rootFolderId);
        return mapping;
      }
      root = metadata;
    } else {
      const existing = await getExactMetadata(env, db, getMetadataOperation, mapping.rootPath, connectionId);
      if (existing) {
        mapping = await markConflict(db, mapping, lease.token, "root", mapping.rootPath, "An existing Dropbox project folder requires explicit operator review", existing.id);
        return mapping;
      }
      try {
        const created = await createFolderStrictOperation(env, db, mapping.rootPath, connectionId);
        if (!exactFolder(created, mapping.rootPath)) {
          mapping = await markConflict(db, mapping, lease.token, "root", mapping.rootPath, "Dropbox returned unexpected metadata after creating the Editor project folder");
          return mapping;
        }
        mapping = await recordEditorFolderProvision(db, mapping.id, {
          role: "root",
          path: mapping.rootPath,
          folderId: created.id,
          method: "created",
          leaseToken: lease.token,
        });
        if (mapping.state !== "pending") return mapping;
        root = created;
      } catch (error) {
        if (!isDropboxConflict(error)) throw error;
        mapping = await markConflict(db, mapping, lease.token, "root", mapping.rootPath, "Editor project folder creation conflicted; existing roots are never auto-adopted");
        return mapping;
      }
    }
    if (!root) throw new Error("Editor root metadata was not established");

    for (const spec of CHILD_SPECS) {
      mapping = await ensureChild(env, db, mapping, connectionId, lease.token, spec, operations);
      if (mapping.state !== "pending") return mapping;
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
    return ready;
  } catch (error) {
    await persistDiagnostic(db, mapping.id, lease.token, error);
    throw error;
  } finally {
    await releaseEditorFolderProvisionLease(db, mapping.id, lease.token, now());
  }
}
