import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { projects } from "@quincy/db/schema";
import type { Database } from "@quincy/db";
import { normalisePath } from "@quincy/shared";
import type { Env } from "../env";
import { dbFor } from "../lib/db";
import { canonicalDropboxConnectionId } from "../dropbox/connection";
import { getMetadata, listFolder, listFolderContinue, type DropboxFolder } from "../dropbox/client";
import { pathFromRawFolderLink } from "../dropbox/sync";
import { deriveEditorProjectFolderName, editorFolderPath, editorFolderPathKey, EDITOR_INPUT_NAME_PATTERN, EDITOR_OUTPUT_NAME_PATTERN, isEditorProjectFolderPath, isEditorWorkspacePath, validateShootDate, type EditorNameSource, type EditorRawSource } from "./paths";
import { getEditorFolderMapping, linkExistingEditorFolder } from "./mapping";

export type ReviewedEditorCandidate = {
  projectId: string;
  connectionId: string;
  expectedShootDate: string;
  expectedRawFolderPath: string | null;
  expectedRawFolderLink: string | null;
  rootPath: string;
  rootFolderId: string;
  inputRoots: { path: string; section: string | null; folderId: string }[];
  outputRoots: { path: string; section: string | null; folderId: string }[];
};

type ActiveProject = { shootDate: string; rawFolderPath: string | null; rawFolderLink: string | null };

const REVIEWED_ROOT_ERROR = "Reviewed Editor root must be a project folder under /Editor/01_ACTIVE EDITS";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function childFolders(env: Env, path: string, connectionId: string): Promise<DropboxFolder[]> {
  const db = dbFor(env);
  let page = await listFolder(env, db, path, { recursive: false }, connectionId);
  const folders: DropboxFolder[] = [];
  let pages = 0;
  while (true) {
    folders.push(...page.entries.filter((entry): entry is DropboxFolder => entry[".tag"] === "folder"));
    if (!page.has_more) return folders;
    if (++pages >= 10) throw new Error("Folder inventory exceeds bounded review size");
    page = await listFolderContinue(env, db, page.cursor, connectionId);
  }
}

/** Active, non-delivered Project with a shoot date; the same row shape every Editor discovery path needs. */
async function loadActiveProject(db: Database, projectId: string): Promise<ActiveProject> {
  const project = await db.select({ shootDate: projects.shootDate, rawFolderPath: projects.rawFolderPath, rawFolderLink: projects.rawFolderLink })
    .from(projects).where(and(eq(projects.id, projectId), isNull(projects.archivedAt), ne(projects.stageKey, "delivered"))).get();
  if (!project?.shootDate) throw new Error("Active Project with a shoot date is required");
  return { shootDate: project.shootDate, rawFolderPath: project.rawFolderPath, rawFolderLink: project.rawFolderLink };
}

/** Tonomo RAW path from the stored path, else from the RAW link (may call Dropbox for a bare share link). */
async function resolveRawPath(env: Env, project: ActiveProject, connectionId: string): Promise<string> {
  const rawPath = project.rawFolderPath ?? await pathFromRawFolderLink(env, project.rawFolderLink, connectionId);
  if (!rawPath) throw new Error("Tonomo folder identity is unavailable");
  return rawPath;
}

/** Automatic Editor root for a Project, or null when the shoot date or RAW path cannot produce one. */
export function derivedEditorRootPath(shootDate: string | null, rawPath: string | null): string | null {
  if (rawPath === null) return null;
  try {
    return editorFolderPath({ shootDate: validateShootDate(shootDate), projectFolderName: deriveEditorProjectFolderName(rawPath) });
  } catch {
    return null;
  }
}

/** Exact-ID verification of one Editor root plus its Input/Output children. Read-only. */
async function verifyEditorRoot(env: Env, db: Database, projectId: string, project: ActiveProject, connectionId: string, rootPath: string): Promise<ReviewedEditorCandidate> {
  const root = await getMetadata(env, db, rootPath, connectionId);
  if (root[".tag"] !== "folder" || editorFolderPathKey(root.path_lower) !== editorFolderPathKey(rootPath)) throw new Error("Exact Project folder could not be verified");
  const inputRoots: ReviewedEditorCandidate["inputRoots"] = [];
  const outputRoots: ReviewedEditorCandidate["outputRoots"] = [];
  const inspect = (folders: DropboxFolder[], section: string | null) => {
    const inputs = folders.filter((folder) => EDITOR_INPUT_NAME_PATTERN.test(folder.name));
    const outputs = folders.filter((folder) => EDITOR_OUTPUT_NAME_PATTERN.test(folder.name));
    if (inputs.length > 1 || outputs.length > 1) throw new Error("Ambiguous Input/Output variants require manual review");
    inputRoots.push(...inputs.map((folder) => ({ path: folder.path_display ?? folder.path_lower, section, folderId: folder.id })));
    outputRoots.push(...outputs.map((folder) => ({ path: folder.path_display ?? folder.path_lower, section, folderId: folder.id })));
  };
  const children = await childFolders(env, rootPath, connectionId);
  inspect(children, null);
  // Legacy Day/Input and Dusk/Input are explicit in the reviewed manifest, never guessed by ingest.
  for (const section of children.filter((folder) => /^(Day|Dusk)$/i.test(folder.name))) {
    inspect(await childFolders(env, section.path_display ?? section.path_lower, connectionId), section.name);
  }
  if (!inputRoots.length || !outputRoots.length) throw new Error("Verified Input and Output folders are required");
  return { projectId, connectionId, expectedShootDate: project.shootDate, expectedRawFolderPath: project.rawFolderPath,
    expectedRawFolderLink: project.rawFolderLink, rootPath: root.path_display ?? root.path_lower, rootFolderId: root.id, inputRoots, outputRoots };
}

/** Derived root of an active Project: the premise every automatic discovery starts from. */
async function resolveDerivedRoot(env: Env, db: Database, projectId: string): Promise<{ project: ActiveProject; connectionId: string; rootPath: string }> {
  const project = await loadActiveProject(db, projectId);
  const connectionId = await canonicalDropboxConnectionId(db);
  const rawPath = await resolveRawPath(env, project, connectionId);
  const rootPath = editorFolderPath({ shootDate: project.shootDate, projectFolderName: deriveEditorProjectFolderName(rawPath) });
  return { project, connectionId, rootPath };
}

/** Inspect folder names only. No mutation, file download, or automatic fuzzy match. */
export async function discoverEditorCandidate(env: Env, projectId: string): Promise<ReviewedEditorCandidate> {
  const db = dbFor(env);
  const { project, connectionId, rootPath } = await resolveDerivedRoot(env, db, projectId);
  return verifyEditorRoot(env, db, projectId, project, connectionId, rootPath);
}

/**
 * Inspect a human-reviewed alternate Editor root (hand-named legacy folders that the automatic
 * derivation in `discoverEditorCandidate` cannot find). Read-only; the returned `candidate` is
 * what `/editor-folders/link` requires.
 */
export async function inspectEditorCandidate(env: Env, projectId: string, rootPath: string): Promise<
  | { status: "candidate"; candidate: ReviewedEditorCandidate; derivedRootPath: string | null; matchesDerived: boolean }
  | { status: "needs_review"; reason: string; derivedRootPath: string | null }
> {
  const db = dbFor(env);
  const normalisedRoot = normalisePath(rootPath);
  let project: ActiveProject;
  try {
    project = await loadActiveProject(db, projectId);
  } catch (error) {
    return { status: "needs_review", reason: message(error), derivedRootPath: null };
  }
  if (!isEditorWorkspacePath(normalisedRoot) || !isEditorProjectFolderPath(normalisedRoot)) {
    // Deliberately uses only the stored path here: a rejected root must never cause a Dropbox
    // call, and link resolution can itself need one.
    return { status: "needs_review", reason: REVIEWED_ROOT_ERROR, derivedRootPath: derivedEditorRootPath(project.shootDate, project.rawFolderPath) };
  }
  let derivedRootPath: string | null = null;
  try {
    validateShootDate(project.shootDate);
    const connectionId = await canonicalDropboxConnectionId(db);
    try {
      derivedRootPath = derivedEditorRootPath(project.shootDate, await resolveRawPath(env, project, connectionId));
    } catch {
      derivedRootPath = null;
    }
    const candidate = await verifyEditorRoot(env, db, projectId, project, connectionId, normalisedRoot);
    const matchesDerived = derivedRootPath !== null && editorFolderPathKey(derivedRootPath) === editorFolderPathKey(candidate.rootPath);
    return { status: "candidate", candidate, derivedRootPath, matchesDerived };
  } catch (error) {
    return { status: "needs_review", reason: message(error), derivedRootPath };
  }
}

export async function previewEditorBackfill(env: Env, cursor?: string) {
  const db = dbFor(env);
  const rows = await db.select({ id: projects.id })
    .from(projects)
    .where(and(isNull(projects.archivedAt), ne(projects.stageKey, "delivered"), cursor ? gt(projects.id, cursor) : undefined))
    .orderBy(projects.id).limit(25);
  const items = [];
  for (const row of rows) {
    const mapping = await getEditorFolderMapping(db, row.id);
    if (mapping) {
      const evidence = (mapping.photographerEvidence ?? {}) as { rawSource?: EditorRawSource; nameSource?: EditorNameSource };
      items.push({ projectId: row.id, status: mapping.state === "ready" ? "already_mapped" as const : "needs_review" as const,
        mappingId: mapping.id, state: mapping.state, rootPath: mapping.rootPath,
        reason: mapping.recoveryProof?.conflict?.reason ?? mapping.recoveryProof?.lastError ?? null,
        initialSyncPending: mapping.initialSyncCompletedAt === null,
        // Where the RAW folder was when the tree was reserved: "missing" means the Tonomo folder was
        // gone and RAW is expected through the Editor Input root only.
        rawSource: (evidence.rawSource ?? "tonomo") satisfies EditorRawSource,
        nameSource: (evidence.nameSource ?? "tonomo_path_display") satisfies EditorNameSource });
      continue;
    }
    let derivedRootPath: string | null = null;
    try {
      const { project, connectionId, rootPath } = await resolveDerivedRoot(env, db, row.id);
      derivedRootPath = rootPath;
      items.push({ projectId: row.id, status: "candidate" as const, candidate: await verifyEditorRoot(env, db, row.id, project, connectionId, rootPath) });
    } catch (error) {
      items.push({ projectId: row.id, status: "needs_review" as const, reason: message(error), derivedRootPath });
    }
  }
  return { items, nextCursor: rows.length === 25 ? rows.at(-1)!.id : null, dryRun: true as const };
}

/** Revalidate the reviewed candidate against both providers before linking; never import here. */
export async function applyEditorCandidate(env: Env, candidate: ReviewedEditorCandidate, actorId: string) {
  const db = dbFor(env);
  const project = await db.select({ shootDate: projects.shootDate, rawFolderPath: projects.rawFolderPath, rawFolderLink: projects.rawFolderLink })
    .from(projects).where(and(eq(projects.id, candidate.projectId), isNull(projects.archivedAt), ne(projects.stageKey, "delivered"))).get();
  if (!project || project.shootDate !== candidate.expectedShootDate || project.rawFolderPath !== candidate.expectedRawFolderPath || project.rawFolderLink !== candidate.expectedRawFolderLink) {
    throw new Error("Project changed since review; refresh the reviewed candidate");
  }
  if (candidate.connectionId !== await canonicalDropboxConnectionId(db) || !isEditorProjectFolderPath(candidate.rootPath)) throw new Error("Invalid reviewed Editor root or connection");
  // A human-reviewed path may deliberately differ from today's shoot date/name (reschedules and
  // legacy names). Verify exact Dropbox identity, rather than rerunning the heuristic discovery.
  const root = await getMetadata(env, db, candidate.rootPath, candidate.connectionId);
  if (root[".tag"] !== "folder" || root.id !== candidate.rootFolderId || editorFolderPathKey(root.path_lower) !== editorFolderPathKey(candidate.rootPath)) throw new Error("Reviewed folder identity changed");
  const fresh = candidate;
  for (const [role, roots] of [["input", fresh.inputRoots], ["output", fresh.outputRoots]] as const) {
    if (!roots.length || new Set(roots.map((item) => editorFolderPathKey(item.path))).size !== roots.length) throw new Error("Reviewed folder roots must be nonempty and distinct");
    const allowed = role === "input" ? EDITOR_INPUT_NAME_PATTERN : EDITOR_OUTPUT_NAME_PATTERN;
    if (roots.some((item) => !allowed.test(item.path.split("/").at(-1) ?? ""))) throw new Error("Reviewed subtree does not match its Input/Output role");
  }
  const verifiedRoots = async (roots: ReviewedEditorCandidate["inputRoots"]) => Promise.all(roots.map(async (root) => {
    const metadata = await getMetadata(env, dbFor(env), root.path, fresh.connectionId);
    if (metadata[".tag"] !== "folder" || metadata.id !== root.folderId) throw new Error("Folder changed during review verification");
    return { ...root, metadata };
  }));
  const mapping = await linkExistingEditorFolder(dbFor(env), {
    projectId: fresh.projectId, connectionId: fresh.connectionId, rootPath: fresh.rootPath,
    shootDate: fresh.expectedShootDate, reviewed: true, reviewedBy: actorId,
    verifiedRoot: root,
    rootFolderId: fresh.rootFolderId, inputRoots: await verifiedRoots(fresh.inputRoots), outputRoots: await verifiedRoots(fresh.outputRoots),
    tonomoRawFolderPath: fresh.expectedRawFolderPath,
    expectedProjectSnapshot: { shootDate: fresh.expectedShootDate, rawFolderPath: fresh.expectedRawFolderPath, rawFolderLink: fresh.expectedRawFolderLink },
  });
  return { projectId: mapping.projectId, mappingId: mapping.id, state: mapping.state, imported: false as const };
}
