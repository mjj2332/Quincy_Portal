import { and, eq, isNull, sql } from "drizzle-orm";
import { editorFolderMappings, integrationConnections, projects } from "@quincy/db/schema";
import type { Database } from "@quincy/db";

import type { DropboxFolder } from "../dropbox/client";
import {
  EDITOR_NOTES_FOLDER,
  EDITOR_OUTPUT_FOLDER,
  editorFolderChildPath,
  editorFolderPath,
  editorFolderPathKey,
  isEditorWorkspacePath,
  isSafeEditorPathSegment,
  parseShootDate,
} from "./paths";

export type EditorFolderMappingState = "pending" | "ready" | "needs_review";

/** A mapped import/export root. `section` is explicit metadata, never inferred from `path`. */
export type EditorFolderSubtree = {
  path: string;
  section: string | null;
  folderId?: string;
};

export type EditorFolderRecoveryProofEntry = {
  role: "root" | "input" | "output" | "editing_notes";
  path: string;
  folderId: string;
  method: "created" | "verified_existing_child";
  at: string;
};

export type EditorFolderRecoveryProof = {
  version: 1;
  rootPath: string;
  rootPathKey: string;
  attempts: number;
  created: EditorFolderRecoveryProofEntry[];
  diagnostics?: string[];
  lastError?: string;
  conflict?: { role: "root" | "input" | "output" | "editing_notes"; path: string; reason: string; folderId?: string };
};

export type EditorFolderMappingRow = typeof editorFolderMappings.$inferSelect;

/** Database row with JSON contracts decoded for editor import/export consumers. */
export type EditorFolderMapping = Omit<
  EditorFolderMappingRow,
  "inputRootsJson" | "outputRootsJson" | "photographerEvidenceJson" | "recoveryProofJson"
> & {
  inputRoots: EditorFolderSubtree[];
  outputRoots: EditorFolderSubtree[];
  photographerEvidence: unknown;
  recoveryProof: EditorFolderRecoveryProof | null;
};

export type EditorFolderMetadata = Pick<DropboxFolder, ".tag" | "id" | "path_lower"> & {
  path_display?: string;
  name?: string;
};

export class EditorFolderMappingError extends Error {
  constructor(readonly code: "EDITOR_FOLDER_PATH_COLLISION" | "EDITOR_FOLDER_PROJECT_COLLISION" | "EDITOR_FOLDER_NOT_FOUND" | "EDITOR_FOLDER_REVIEW_REQUIRED", message: string) {
    super(message);
    this.name = "EditorFolderMappingError";
  }
}

export class EditorFolderPathCollisionError extends EditorFolderMappingError {
  constructor(readonly connectionId: string, readonly rootPath: string, readonly holderProjectId: string) {
    super("EDITOR_FOLDER_PATH_COLLISION", `Editor folder path ${rootPath} is already mapped to project ${holderProjectId}`);
    this.name = "EditorFolderPathCollisionError";
  }
}

function isUniqueConflict(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (/UNIQUE constraint failed/i.test(cause.message)) return true;
  }
  return false;
}

function json(value: unknown, fallback: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? JSON.stringify(fallback) : encoded;
  } catch {
    return JSON.stringify(fallback);
  }
}

function parseJsonObject(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Editor folder mapping has invalid ${field}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Editor folder mapping has invalid ${field}`);
  return parsed as Record<string, unknown>;
}

function parseSubtrees(value: string, field: string, rootPath: string): EditorFolderSubtree[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Editor folder mapping has invalid ${field}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Editor folder mapping has invalid ${field}`);
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Editor folder mapping has invalid ${field}[${index}]`);
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.path !== "string" || !isEditorWorkspacePath(candidate.path) || !editorFolderPathKey(candidate.path).startsWith(`${editorFolderPathKey(rootPath)}/`)) {
      throw new Error(`Editor folder mapping has invalid ${field}[${index}].path`);
    }
    if (candidate.section !== null && (typeof candidate.section !== "string" || candidate.section.length > 200 || /[\u0000-\u001f\u007f]/u.test(candidate.section))) {
      throw new Error(`Editor folder mapping has invalid ${field}[${index}].section`);
    }
    if (candidate.folderId !== undefined && !isSafeDropboxFolderId(candidate.folderId)) {
      throw new Error(`Editor folder mapping has invalid ${field}[${index}].folderId`);
    }
    return {
      path: candidate.path,
      section: candidate.section as string | null,
      ...(candidate.folderId === undefined ? {} : { folderId: candidate.folderId as string }),
    };
  });
}

/** Dropbox folder IDs are metadata, not path segments; the usual `id:` prefix is valid. */
function isSafeDropboxFolderId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && value !== "."
    && value !== ".."
    && !/[\\/\u0000-\u001f\u007f]/u.test(value);
}

function parseRecoveryProof(value: string | null): EditorFolderRecoveryProof | null {
  if (!value) return null;
  const parsed = parseJsonObject(value, "recovery proof");
  if (parsed.version !== 1 || typeof parsed.rootPath !== "string" || typeof parsed.rootPathKey !== "string" || typeof parsed.attempts !== "number" || !Array.isArray(parsed.created)) {
    throw new Error("Editor folder mapping has invalid recovery proof");
  }
  return parsed as unknown as EditorFolderRecoveryProof;
}

function parsedMapping(row: EditorFolderMappingRow): EditorFolderMapping {
  parseShootDate(row.shootDate);
  if (!isSafeEditorPathSegment(row.projectFolderName)) throw new Error("Editor folder mapping has invalid project folder name");
  if (editorFolderPathKey(row.rootPath) !== row.rootPathKey) throw new Error("Editor folder mapping path key is not canonical");
  if (!isEditorWorkspacePath(row.rootPath)) throw new Error("Editor folder mapping root is outside the Editor workspace");
  return {
    ...row,
    inputRoots: parseSubtrees(row.inputRootsJson, "input roots", row.rootPath),
    outputRoots: parseSubtrees(row.outputRootsJson, "output roots", row.rootPath),
    photographerEvidence: parseJsonObject(row.photographerEvidenceJson, "photographer evidence"),
    recoveryProof: parseRecoveryProof(row.recoveryProofJson),
  };
}

function rawRootPath(value: string): string {
  const key = editorFolderPathKey(value);
  if (!isEditorWorkspacePath(value) || key.split("/").filter(Boolean).length !== 5) {
    throw new Error(`Invalid Editor project root path: ${value}`);
  }
  return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "").replace(/^/, "/");
}

export type CanonicalEditorFolderPathInput = {
  shootDate: string;
  projectFolderName: string;
};

export function canonicalEditorFolderPath(input: CanonicalEditorFolderPathInput): string;
export function canonicalEditorFolderPath(shootDate: string, projectFolderName: string): string;
export function canonicalEditorFolderPath(inputOrDate: CanonicalEditorFolderPathInput | string, projectFolderName?: string): string {
  return typeof inputOrDate === "string"
    ? editorFolderPath({ shootDate: inputOrDate, projectFolderName: projectFolderName ?? "" })
    : editorFolderPath(inputOrDate);
}

export async function getEditorFolderMapping(db: Database, projectId: string): Promise<EditorFolderMapping | null> {
  const row = await db.select().from(editorFolderMappings).where(eq(editorFolderMappings.projectId, projectId)).get();
  return row ? parsedMapping(row) : null;
}

export async function getReadyEditorFolderMapping(db: Database, projectId: string): Promise<EditorFolderMapping | null> {
  const row = await db.select({ mapping: editorFolderMappings, archivedAt: projects.archivedAt })
    .from(editorFolderMappings)
    .innerJoin(projects, eq(editorFolderMappings.projectId, projects.id))
    .where(and(eq(editorFolderMappings.projectId, projectId), eq(editorFolderMappings.state, "ready"), isNull(projects.archivedAt)))
    .get();
  return row ? parsedMapping(row.mapping) : null;
}

export const resolveReadyEditorFolder = getReadyEditorFolderMapping;

export async function findEditorFolderMappingByPath(
  db: Database,
  input: { connectionId: string; path: string },
): Promise<EditorFolderMapping | null> {
  const pathKey = editorFolderPathKey(input.path);
  const row = await db.select().from(editorFolderMappings).where(and(
    eq(editorFolderMappings.connectionId, input.connectionId),
    eq(editorFolderMappings.rootPathKey, pathKey),
  )).get();
  return row ? parsedMapping(row) : null;
}

export type ReserveEditorFolderMappingInput = {
  projectId: string;
  connectionId: string;
  shootDate: string;
  projectFolderName?: string;
  rootPath?: string;
  tonomoRawFolderPath?: string | null;
  photographerEvidence?: unknown;
  now?: Date;
};

function reservePath(input: ReserveEditorFolderMappingInput): { rootPath: string; projectFolderName: string } {
  if (input.rootPath) {
    const rootPath = rawRootPath(input.rootPath);
    const projectFolderName = rootPath.split("/").at(-1)!;
    if (input.projectFolderName !== undefined && input.projectFolderName !== projectFolderName) throw new Error("Editor project folder name does not match root path");
    return { rootPath, projectFolderName };
  }
  if (!input.projectFolderName) throw new Error("Editor project folder name is required");
  return { rootPath: editorFolderPath({ shootDate: input.shootDate, projectFolderName: input.projectFolderName }), projectFolderName: input.projectFolderName };
}

export async function reserveEditorFolderMapping(db: Database, input: ReserveEditorFolderMappingInput): Promise<EditorFolderMapping> {
  parseShootDate(input.shootDate);
  const existingProject = await getEditorFolderMapping(db, input.projectId);
  if (existingProject) return existingProject;
  const { rootPath, projectFolderName } = reservePath(input);
  const rootPathKey = editorFolderPathKey(rootPath);
  const existingPath = await findEditorFolderMappingByPath(db, { connectionId: input.connectionId, path: rootPath });
  if (existingPath && existingPath.projectId !== input.projectId) throw new EditorFolderPathCollisionError(input.connectionId, rootPath, existingPath.projectId);
  const now = input.now ?? new Date();
  const proof: EditorFolderRecoveryProof = {
    version: 1,
    rootPath,
    rootPathKey,
    attempts: 0,
    created: [],
  };
  const mappingId = crypto.randomUUID();
  try {
    // The SELECT guard matters: the project can be archived between the caller's read and this
    // reservation.  A plain INSERT would leave a mapping that an archived project can never use.
    await db.run(sql`
      INSERT INTO editor_folder_mappings (
        id, project_id, connection_id, root_path, root_path_key, root_folder_id,
        shoot_date, project_folder_name, tonomo_raw_folder_path, photographer_evidence_json,
        input_roots_json, output_roots_json, editing_notes_path, editing_notes_folder_id,
        state, recovery_proof_json, provision_lease_token, provision_lease_expires_at,
        reviewed_at, reviewed_by, created_at, updated_at
      )
      SELECT
        ${mappingId}, ${input.projectId}, ${input.connectionId}, ${rootPath}, ${rootPathKey}, NULL,
        ${input.shootDate}, ${projectFolderName}, ${input.tonomoRawFolderPath ?? null},
        ${json(input.photographerEvidence ?? {}, {})}, '[]', '[]',
        ${editorFolderChildPath(rootPath, EDITOR_NOTES_FOLDER)}, NULL,
        'pending', ${JSON.stringify(proof)}, NULL, NULL, NULL, NULL, ${now.getTime()}, ${now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM projects p
        WHERE p.id = ${input.projectId} AND p.archived_at IS NULL
      )
        AND EXISTS (
          SELECT 1 FROM integration_connections c
          WHERE c.id = ${input.connectionId} AND c.provider = 'dropbox'
        )
      ON CONFLICT DO NOTHING
    `);
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const winner = await getEditorFolderMapping(db, input.projectId);
    if (winner) return winner;
    const pathWinner = await findEditorFolderMappingByPath(db, { connectionId: input.connectionId, path: rootPath });
    if (pathWinner) throw new EditorFolderPathCollisionError(input.connectionId, rootPath, pathWinner.projectId);
    throw error;
  }
  const created = await getEditorFolderMapping(db, input.projectId);
  if (!created) throw new EditorFolderMappingError("EDITOR_FOLDER_NOT_FOUND", `Editor folder mapping for project ${input.projectId} was not persisted`);
  return created;
}

function nextProof(current: EditorFolderMapping, patch: Partial<EditorFolderRecoveryProof> = {}): EditorFolderRecoveryProof {
  const existing = current.recoveryProof ?? {
    version: 1 as const,
    rootPath: current.rootPath,
    rootPathKey: current.rootPathKey,
    attempts: 0,
    created: [],
  };
  return {
    ...existing,
    ...patch,
    rootPath: current.rootPath,
    rootPathKey: current.rootPathKey,
    attempts: existing.attempts + 1,
    created: patch.created ?? existing.created,
  };
}

export const EDITOR_PROVISION_LEASE_MS = 5 * 60 * 1000;

export type EditorFolderProvisionLease = {
  mapping: EditorFolderMapping;
  token: string;
  expiresAt: Date;
};

/** Claims a pending mapping before making any provider-side mutation. */
export async function acquireEditorFolderProvisionLease(
  db: Database,
  mappingId: string,
  now = new Date(),
  leaseMs = EDITOR_PROVISION_LEASE_MS,
): Promise<EditorFolderProvisionLease | null> {
  const current = await getEditorFolderMappingById(db, mappingId);
  if (!current || current.state !== "pending") return null;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("Invalid Editor provisioning lease duration");
  const token = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + leaseMs);
  const result = await db.run(sql`
    UPDATE editor_folder_mappings
    SET provision_lease_token = ${token}, provision_lease_expires_at = ${expiresAt.getTime()}, updated_at = ${now.getTime()}
    WHERE id = ${mappingId}
      AND state = 'pending'
      AND (provision_lease_token IS NULL OR provision_lease_expires_at IS NULL OR provision_lease_expires_at <= ${now.getTime()})
      AND EXISTS (
        SELECT 1 FROM projects p
        WHERE p.id = editor_folder_mappings.project_id AND p.archived_at IS NULL
      )
  `);
  if ((result.meta?.changes ?? 0) !== 1) return null;
  const claimed = await getEditorFolderMappingById(db, mappingId);
  if (!claimed || claimed.state !== "pending" || claimed.provisionLeaseToken !== token) return null;
  return { mapping: claimed, token, expiresAt };
}

/** Releases a lease only when it is still owned by this reconciliation attempt. */
export async function releaseEditorFolderProvisionLease(db: Database, mappingId: string, token: string, now = new Date()): Promise<void> {
  await db.run(sql`
    UPDATE editor_folder_mappings
    SET provision_lease_token = NULL, provision_lease_expires_at = NULL, updated_at = ${now.getTime()}
    WHERE id = ${mappingId} AND provision_lease_token = ${token}
  `);
}

export type EditorFolderDiagnosticInput = {
  message: string;
  leaseToken?: string;
  at?: Date;
};

/** Persists a retryable provider failure without moving a mapping out of `pending`. */
export async function recordEditorFolderDiagnostic(
  db: Database,
  mappingId: string,
  input: EditorFolderDiagnosticInput | string,
): Promise<EditorFolderMapping> {
  const current = await getEditorFolderMappingById(db, mappingId);
  if (!current) throw new EditorFolderMappingError("EDITOR_FOLDER_NOT_FOUND", `Editor folder mapping ${mappingId} does not exist`);
  const details: EditorFolderDiagnosticInput = typeof input === "string" ? { message: input } : input;
  const at = details.at ?? new Date();
  const proof = nextProof(current, {
    diagnostics: [...(current.recoveryProof?.diagnostics ?? []), details.message].slice(-20),
    lastError: details.message,
  });
  const conditions = [
    eq(editorFolderMappings.id, mappingId),
    eq(editorFolderMappings.state, "pending"),
    sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = editor_folder_mappings.project_id AND p.archived_at IS NULL)`,
  ];
  if (details.leaseToken) conditions.push(eq(editorFolderMappings.provisionLeaseToken, details.leaseToken));
  await db.update(editorFolderMappings).set({
    recoveryProofJson: JSON.stringify(proof),
    updatedAt: at,
  }).where(and(...conditions));
  return (await getEditorFolderMappingById(db, mappingId))!;
}

export async function recordEditorFolderProvision(
  db: Database,
  mappingId: string,
  input: { role: EditorFolderRecoveryProofEntry["role"]; path: string; folderId: string; method?: EditorFolderRecoveryProofEntry["method"]; at?: Date; leaseToken?: string },
): Promise<EditorFolderMapping> {
  const current = await getEditorFolderMappingById(db, mappingId);
  if (!current) throw new EditorFolderMappingError("EDITOR_FOLDER_NOT_FOUND", `Editor folder mapping ${mappingId} does not exist`);
  const entry: EditorFolderRecoveryProofEntry = {
    role: input.role,
    path: input.path,
    folderId: input.folderId,
    method: input.method ?? "created",
    at: (input.at ?? new Date()).toISOString(),
  };
  const proof = nextProof(current, {
    created: [...(current.recoveryProof?.created ?? []).filter((item) => item.role !== input.role), entry],
    lastError: undefined,
    conflict: undefined,
  });
  const values: Partial<typeof editorFolderMappings.$inferInsert> = {
    recoveryProofJson: JSON.stringify(proof),
    updatedAt: input.at ?? new Date(),
  };
  if (input.role === "root") values.rootFolderId = input.folderId;
  if (input.role === "editing_notes") values.editingNotesFolderId = input.folderId;
  if (input.role === "input" || input.role === "output") {
    const roots = input.role === "input" ? current.inputRoots : current.outputRoots;
    const next = [...roots.filter((item) => editorFolderPathKey(item.path) !== editorFolderPathKey(input.path)), { path: input.path, section: null, folderId: input.folderId }];
    values[input.role === "input" ? "inputRootsJson" : "outputRootsJson"] = JSON.stringify(next);
  }
  const conditions = [
    eq(editorFolderMappings.id, mappingId),
    eq(editorFolderMappings.state, "pending"),
    sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = editor_folder_mappings.project_id AND p.archived_at IS NULL)`,
  ];
  if (input.leaseToken) conditions.push(eq(editorFolderMappings.provisionLeaseToken, input.leaseToken));
  await db.update(editorFolderMappings).set(values).where(and(...conditions));
  return (await getEditorFolderMappingById(db, mappingId))!;
}

async function getEditorFolderMappingById(db: Database, mappingId: string): Promise<EditorFolderMapping | null> {
  const row = await db.select().from(editorFolderMappings).where(eq(editorFolderMappings.id, mappingId)).get();
  return row ? parsedMapping(row) : null;
}

export type MarkEditorNeedsReviewInput = {
  reason: string;
  conflict?: EditorFolderRecoveryProof["conflict"];
  folderId?: string;
  leaseToken?: string;
  at?: Date;
};

/**
 * Why a retarget did not happen: `held` means another mapping owns the new root, `started` means
 * this mapping already recorded a Dropbox folder (its tree stays where it is), and `stale` means
 * the mapping changed under the caller's lease, so the caller re-reads rather than concluding.
 */
export type RetargetEditorFolderResult =
  | { status: "retargeted"; mapping: EditorFolderMapping }
  | { status: "held"; rootPath: string }
  | { status: "started" }
  | { status: "stale" };

/**
 * Re-points a pending mapping that has created nothing in Dropbox yet at the root its Project's
 * current shoot date derives to. Fenced in SQL on state, lease, no recorded root folder, no
 * recorded created folder and the old key, so a mapping that already provisioned keeps its tree
 * (moving a tree is a separate, deliberate operation).
 */
export async function retargetPendingEditorFolderMapping(
  db: Database,
  mappingId: string,
  input: { shootDate: string; leaseToken: string; at?: Date },
): Promise<RetargetEditorFolderResult> {
  const current = await getEditorFolderMappingById(db, mappingId);
  if (!current || current.state !== "pending") return { status: "stale" };
  if (current.rootFolderId || (current.recoveryProof?.created.length ?? 0) > 0) return { status: "started" };
  parseShootDate(input.shootDate);
  const rootPath = editorFolderPath({ shootDate: input.shootDate, projectFolderName: current.projectFolderName });
  const rootPathKey = editorFolderPathKey(rootPath);
  const holder = await findEditorFolderMappingByPath(db, { connectionId: current.connectionId, path: rootPath });
  if (holder && holder.id !== mappingId) return { status: "held", rootPath };
  const at = input.at ?? new Date();
  const proof = nextProof(current, {
    rootPath,
    rootPathKey,
    diagnostics: [...(current.recoveryProof?.diagnostics ?? []), `Retargeted from ${current.rootPath} to ${rootPath} after the shoot date changed to ${input.shootDate}`].slice(-20),
  });
  try {
    const result = await db.run(sql`
      UPDATE editor_folder_mappings
      SET shoot_date = ${input.shootDate}, root_path = ${rootPath}, root_path_key = ${rootPathKey},
          editing_notes_path = ${editorFolderChildPath(rootPath, EDITOR_NOTES_FOLDER)},
          recovery_proof_json = ${JSON.stringify(proof)}, updated_at = ${at.getTime()}
      WHERE id = ${mappingId} AND state = 'pending' AND provision_lease_token = ${input.leaseToken}
        AND root_folder_id IS NULL AND root_path_key = ${current.rootPathKey}
        AND COALESCE(json_array_length(recovery_proof_json, '$.created'), 0) = 0
    `);
    if ((result.meta?.changes ?? 0) !== 1) return { status: "stale" };
  } catch (error) {
    // Another mapping reserved the new root between the holder read and this write.
    if (isUniqueConflict(error)) return { status: "held", rootPath };
    throw error;
  }
  const mapping = await getEditorFolderMappingById(db, mappingId);
  return mapping ? { status: "retargeted", mapping } : { status: "stale" };
}

export async function markEditorFolderNeedsReview(
  db: Database,
  mappingId: string,
  input: MarkEditorNeedsReviewInput | string,
): Promise<EditorFolderMapping> {
  const current = await getEditorFolderMappingById(db, mappingId);
  if (!current) throw new EditorFolderMappingError("EDITOR_FOLDER_NOT_FOUND", `Editor folder mapping ${mappingId} does not exist`);
  const details: MarkEditorNeedsReviewInput = typeof input === "string" ? { reason: input } : input;
  if (current.state === "needs_review") return current;
  const diagnostics = [...(current.recoveryProof?.diagnostics ?? []), details.reason].slice(-20);
  const proof = nextProof(current, {
    diagnostics,
    lastError: details.reason,
    ...(details.conflict ? { conflict: details.conflict } : {}),
  });
  const at = details.at ?? new Date();
  const conditions = [
    eq(editorFolderMappings.id, mappingId),
    eq(editorFolderMappings.state, "pending"),
    sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = editor_folder_mappings.project_id AND p.archived_at IS NULL)`,
  ];
  if (details.leaseToken) conditions.push(eq(editorFolderMappings.provisionLeaseToken, details.leaseToken));
  await db.update(editorFolderMappings).set({
    state: "needs_review",
    recoveryProofJson: JSON.stringify(proof),
    provisionLeaseToken: null,
    provisionLeaseExpiresAt: null,
    updatedAt: at,
  }).where(and(...conditions));
  return (await getEditorFolderMappingById(db, mappingId))!;
}

export const markEditorNeedsReview = markEditorFolderNeedsReview;

export type MarkEditorReadyInput = {
  rootFolderId: string;
  inputRoots: EditorFolderSubtree[];
  outputRoots: EditorFolderSubtree[];
  editingNotesFolderId: string;
  leaseToken?: string;
  at?: Date;
};

function validateSubtrees(rootPath: string, field: string, roots: readonly EditorFolderSubtree[]): void {
  if (!roots.length) throw new Error(`Editor folder mapping requires at least one ${field} root`);
  parseSubtrees(JSON.stringify(roots), field, rootPath);
  for (const root of roots) if (!root.folderId) throw new Error(`Editor folder mapping ${field} root is missing a Dropbox folder ID`);
}

export async function markEditorFolderReady(db: Database, mappingId: string, input: MarkEditorReadyInput): Promise<EditorFolderMapping> {
  const current = await getEditorFolderMappingById(db, mappingId);
  if (!current) throw new EditorFolderMappingError("EDITOR_FOLDER_NOT_FOUND", `Editor folder mapping ${mappingId} does not exist`);
  // A worker that lost the lease must never promote a review decision back to ready. Returning
  // the latest row lets the caller observe the winning state without clobbering it.
  if (current.state !== "pending") return current;
  if (!isSafeDropboxFolderId(input.rootFolderId) || !isSafeDropboxFolderId(input.editingNotesFolderId)) throw new Error("Editor folder mapping is missing folder IDs");
  validateSubtrees(current.rootPath, "input roots", input.inputRoots);
  validateSubtrees(current.rootPath, "output roots", input.outputRoots);
  const inputRoots = storedSubtrees(input.inputRoots);
  const outputRoots = storedSubtrees(input.outputRoots);
  const at = input.at ?? new Date();
  const conditions = [
    eq(editorFolderMappings.id, mappingId),
    eq(editorFolderMappings.state, "pending"),
    sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = editor_folder_mappings.project_id AND p.archived_at IS NULL)`,
  ];
  if (input.leaseToken) conditions.push(eq(editorFolderMappings.provisionLeaseToken, input.leaseToken));
  await db.update(editorFolderMappings).set({
    rootFolderId: input.rootFolderId,
    inputRootsJson: JSON.stringify(inputRoots),
    outputRootsJson: JSON.stringify(outputRoots),
    editingNotesFolderId: input.editingNotesFolderId,
    state: "ready",
    provisionLeaseToken: null,
    provisionLeaseExpiresAt: null,
    recoveryProofJson: JSON.stringify(nextProof(current, {
      created: [
        ...(current.recoveryProof?.created ?? []).filter((entry) => entry.role !== "root"),
        { role: "root", path: current.rootPath, folderId: input.rootFolderId, method: "created", at: at.toISOString() },
      ],
      lastError: undefined,
      conflict: undefined,
    })),
    updatedAt: at,
  }).where(and(...conditions));
  return (await getEditorFolderMappingById(db, mappingId))!;
}

export const markEditorReady = markEditorFolderReady;

function verifyFolderMetadata(metadata: EditorFolderMetadata | undefined, expectedPath: string, expectedId?: string): void {
  if (!metadata || metadata[".tag"] !== "folder" || !metadata.id || editorFolderPathKey(metadata.path_lower) !== editorFolderPathKey(expectedPath) || (expectedId !== undefined && metadata.id !== expectedId)) {
    throw new EditorFolderMappingError("EDITOR_FOLDER_REVIEW_REQUIRED", `Verified Dropbox metadata does not exactly match ${expectedPath}`);
  }
  if (metadata.path_display !== undefined && editorFolderPathKey(metadata.path_display) !== editorFolderPathKey(expectedPath)) {
    throw new EditorFolderMappingError("EDITOR_FOLDER_REVIEW_REQUIRED", `Verified Dropbox display path does not exactly match ${expectedPath}`);
  }
}

export type LinkExistingEditorFolderInput = {
  projectId: string;
  connectionId: string;
  rootPath: string;
  shootDate: string;
  reviewed: true;
  reviewedBy: string;
  rootFolder?: EditorFolderMetadata;
  verifiedRoot?: EditorFolderMetadata;
  rootFolderId?: string;
  inputRoots: (EditorFolderSubtree & { metadata?: EditorFolderMetadata; verifiedMetadata?: EditorFolderMetadata })[];
  outputRoots: (EditorFolderSubtree & { metadata?: EditorFolderMetadata; verifiedMetadata?: EditorFolderMetadata })[];
  editingNotesFolderId?: string;
  editingNotesFolder?: EditorFolderMetadata;
  editingNotesPath?: string;
  tonomoRawFolderPath?: string | null;
  expectedProjectSnapshot?: { shootDate: string; rawFolderPath: string | null; rawFolderLink: string | null };
  now?: Date;
};

function storedSubtrees(roots: readonly EditorFolderSubtree[]): EditorFolderSubtree[] {
  return roots.map(({ path, section, folderId }) => ({ path, section, ...(folderId === undefined ? {} : { folderId }) }));
}

function verifyLinkedSubtrees(
  rootPath: string,
  field: string,
  roots: readonly (EditorFolderSubtree & { metadata?: EditorFolderMetadata; verifiedMetadata?: EditorFolderMetadata })[],
): void {
  validateSubtrees(rootPath, field, roots);
  for (const root of roots) {
    const metadata = root.metadata ?? root.verifiedMetadata;
    // Existing-folder linking is the one path where an operator may adopt provider state. Every
    // adopted child therefore needs the same exact metadata proof as the project root.
    verifyFolderMetadata(metadata, root.path, root.folderId);
  }
}

/** Links an operator-reviewed existing folder; it never searches or adopts by similarity. */
export async function linkExistingEditorFolder(db: Database, input: LinkExistingEditorFolderInput): Promise<EditorFolderMapping> {
  if (input.reviewed !== true || !input.reviewedBy.trim()) throw new EditorFolderMappingError("EDITOR_FOLDER_REVIEW_REQUIRED", "Existing Editor folders require an explicit reviewer");
  parseShootDate(input.shootDate);
  const rootPath = rawRootPath(input.rootPath);
  const rootMetadata = input.rootFolder ?? input.verifiedRoot;
  const rootId = input.rootFolderId ?? rootMetadata?.id;
  verifyFolderMetadata(rootMetadata, rootPath, rootId);
  const connection = await db.select({ id: integrationConnections.id }).from(integrationConnections).where(and(
    eq(integrationConnections.id, input.connectionId),
    eq(integrationConnections.provider, "dropbox"),
  )).get();
  if (!connection) throw new EditorFolderMappingError("EDITOR_FOLDER_REVIEW_REQUIRED", `Connection ${input.connectionId} is not a Dropbox integration`);
  const project = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.projectId), isNull(projects.archivedAt))).get();
  if (!project) throw new EditorFolderMappingError("EDITOR_FOLDER_REVIEW_REQUIRED", `Project ${input.projectId} is missing or archived`);
  verifyLinkedSubtrees(rootPath, "input roots", input.inputRoots);
  verifyLinkedSubtrees(rootPath, "output roots", input.outputRoots);
  const notesPath = input.editingNotesPath ?? editorFolderChildPath(rootPath, EDITOR_NOTES_FOLDER);
  const notesId = input.editingNotesFolderId;
  if (notesId !== undefined) {
    if (!isSafeDropboxFolderId(notesId)) throw new Error("Invalid Editing Notes folder ID");
    verifyFolderMetadata(input.editingNotesFolder, notesPath, notesId);
  }
  if (editorFolderPathKey(notesPath) !== editorFolderPathKey(editorFolderChildPath(rootPath, EDITOR_NOTES_FOLDER))) {
    throw new EditorFolderMappingError("EDITOR_FOLDER_REVIEW_REQUIRED", "Editing Notes path is outside the canonical project root");
  }
  const inputRoots = storedSubtrees(input.inputRoots);
  const outputRoots = storedSubtrees(input.outputRoots);
  const existingProject = await getEditorFolderMapping(db, input.projectId);
  if (existingProject?.state === "ready") {
    const rootsKey = (roots: readonly EditorFolderSubtree[]) => JSON.stringify(roots.map((root) => ({
      path: editorFolderPathKey(root.path), section: root.section, folderId: root.folderId ?? null,
    })).sort((a, b) => a.path.localeCompare(b.path)));
    if (existingProject.connectionId !== input.connectionId || existingProject.rootPathKey !== editorFolderPathKey(rootPath) || existingProject.rootFolderId !== rootId
        || rootsKey(existingProject.inputRoots) !== rootsKey(inputRoots) || rootsKey(existingProject.outputRoots) !== rootsKey(outputRoots)) {
      throw new EditorFolderMappingError("EDITOR_FOLDER_REVIEW_REQUIRED", "An established Editor mapping cannot be moved or have its I/O roots replaced by linking");
    }
    return existingProject;
  }
  const changingReservation = existingProject && (existingProject.connectionId !== input.connectionId || existingProject.rootPathKey !== editorFolderPathKey(rootPath));
  if (changingReservation && (existingProject.rootFolderId ||
      (existingProject.provisionLeaseToken && existingProject.provisionLeaseExpiresAt && existingProject.provisionLeaseExpiresAt.getTime() > Date.now()))) {
    throw new EditorFolderMappingError("EDITOR_FOLDER_REVIEW_REQUIRED", "An established or actively provisioning Editor folder cannot be moved by linking");
  }
  const existingPath = await findEditorFolderMappingByPath(db, { connectionId: input.connectionId, path: rootPath });
  if (existingPath && existingPath.projectId !== input.projectId) throw new EditorFolderPathCollisionError(input.connectionId, rootPath, existingPath.projectId);
  const now = input.now ?? new Date();
  const expected = input.expectedProjectSnapshot;
  const snapshotGuard = expected
    ? sql`p.shoot_date IS ${expected.shootDate} AND p.raw_folder_path IS ${expected.rawFolderPath} AND p.raw_folder_link IS ${expected.rawFolderLink}`
    : sql`p.shoot_date IS ${input.shootDate}`;
  if (existingProject) {
    const updated = await db.update(editorFolderMappings).set({
      connectionId: input.connectionId,
      rootPath,
      rootPathKey: editorFolderPathKey(rootPath),
      projectFolderName: rootPath.split("/").at(-1)!,
      rootFolderId: rootId!,
      inputRootsJson: JSON.stringify(inputRoots),
      outputRootsJson: JSON.stringify(outputRoots),
      editingNotesPath: notesPath,
      editingNotesFolderId: notesId ?? null,
      state: "ready",
      initialSyncCompletedAt: null,
      provisionLeaseToken: null,
      provisionLeaseExpiresAt: null,
      reviewedAt: now,
      reviewedBy: input.reviewedBy,
      tonomoRawFolderPath: input.tonomoRawFolderPath ?? existingProject.tonomoRawFolderPath,
      recoveryProofJson: JSON.stringify({ version: 1, rootPath, rootPathKey: editorFolderPathKey(rootPath), attempts: 1, created: [], diagnostics: ["linked_existing_reviewed"] }),
      updatedAt: now,
    }).where(and(
      eq(editorFolderMappings.id, existingProject.id),
      eq(editorFolderMappings.connectionId, existingProject.connectionId),
      eq(editorFolderMappings.rootPathKey, existingProject.rootPathKey),
      eq(editorFolderMappings.state, existingProject.state),
      sql`root_folder_id IS ${existingProject.rootFolderId}`,
      sql`(provision_lease_token IS NULL OR provision_lease_expires_at <= ${now.getTime()})`,
      sql`EXISTS (SELECT 1 FROM projects p WHERE p.id = editor_folder_mappings.project_id AND p.archived_at IS NULL AND p.stage_key != 'delivered' AND ${snapshotGuard})`,
    )).catch(async (error: unknown) => {
      if (!isUniqueConflict(error)) throw error;
      const holder = await findEditorFolderMappingByPath(db, { connectionId: input.connectionId, path: rootPath });
      if (holder) throw new EditorFolderPathCollisionError(input.connectionId, rootPath, holder.projectId);
      throw new EditorFolderMappingError("EDITOR_FOLDER_REVIEW_REQUIRED", "Folder claim changed while saving the reviewed link");
    });
    if ((updated.meta?.changes ?? 0) !== 1) {
      throw new EditorFolderMappingError("EDITOR_FOLDER_REVIEW_REQUIRED", `Project or folder reservation changed before the Editor link was saved`);
    }
    return (await getEditorFolderMapping(db, input.projectId))!;
  }
  const mappingId = crypto.randomUUID();
  try {
    await db.run(sql`
      INSERT INTO editor_folder_mappings (
        id, project_id, connection_id, root_path, root_path_key, root_folder_id,
        shoot_date, project_folder_name, tonomo_raw_folder_path, photographer_evidence_json,
        input_roots_json, output_roots_json, editing_notes_path, editing_notes_folder_id,
        state, recovery_proof_json, provision_lease_token, provision_lease_expires_at,
        reviewed_at, reviewed_by, created_at, updated_at
      )
      SELECT
        ${mappingId}, ${input.projectId}, ${input.connectionId}, ${rootPath}, ${editorFolderPathKey(rootPath)}, ${rootId!},
        ${input.shootDate}, ${rootPath.split("/").at(-1)!}, ${input.tonomoRawFolderPath ?? null},
        ${JSON.stringify({ reviewedBy: input.reviewedBy, kind: "existing_folder_link" })},
        ${JSON.stringify(inputRoots)}, ${JSON.stringify(outputRoots)}, ${notesPath}, ${notesId ?? null},
        'ready', ${JSON.stringify({ version: 1, rootPath, rootPathKey: editorFolderPathKey(rootPath), attempts: 1, created: [], diagnostics: ["linked_existing_reviewed"] })},
        NULL, NULL, ${now.getTime()}, ${input.reviewedBy}, ${now.getTime()}, ${now.getTime()}
      WHERE EXISTS (
        SELECT 1 FROM projects p WHERE p.id = ${input.projectId} AND p.archived_at IS NULL AND p.stage_key != 'delivered' AND ${snapshotGuard}
      )
      ON CONFLICT DO NOTHING
    `);
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const winner = await getEditorFolderMapping(db, input.projectId);
    if (winner && winner.rootPathKey === editorFolderPathKey(rootPath) && winner.connectionId === input.connectionId) return winner;
    const holder = await findEditorFolderMappingByPath(db, { connectionId: input.connectionId, path: rootPath });
    if (holder) throw new EditorFolderPathCollisionError(input.connectionId, rootPath, holder.projectId);
    throw error;
  }
  const linked = await getEditorFolderMapping(db, input.projectId);
  if (!linked) {
    const holder = await findEditorFolderMappingByPath(db, { connectionId: input.connectionId, path: rootPath });
    if (holder) throw new EditorFolderPathCollisionError(input.connectionId, rootPath, holder.projectId);
    throw new EditorFolderMappingError("EDITOR_FOLDER_NOT_FOUND", `Editor folder mapping for project ${input.projectId} was not persisted`);
  }
  if (linked.rootPathKey !== editorFolderPathKey(rootPath) || linked.connectionId !== input.connectionId || linked.rootFolderId !== rootId) {
    throw new EditorFolderMappingError("EDITOR_FOLDER_REVIEW_REQUIRED", "Another reviewed folder won the Project mapping; refresh before linking");
  }
  return linked;
}
