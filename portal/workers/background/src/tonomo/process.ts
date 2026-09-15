import { and, eq, isNull, sql } from "drizzle-orm";
import { boardSchemaVariant, projectColumnsForVariant, type BoardSchemaVariant, type Database } from "@quincy/db";
import { COLLECTION_RECEIVED_COUNT_SQL, appendToStageBottomExpr, collectionReceivedCountBindings } from "@quincy/db";
import { COLLECTION_KINDS, isCanonicalCalendarDate, normaliseAddressKey, normalisePath, parseTonomoOrder, TonomoParseError, type CollectionKind, type TonomoOrder } from "@quincy/shared";
import { auditLog, collectionLinks, collections, projectMembers, projects, user, webhookEvents } from "@quincy/db/schema";

import type { Env } from "../env";
import { dbFor, errorMessage } from "../lib/db";
import { createJob, setJobStatus } from "../lib/jobs";
import { enqueueAutoHdrScaffold } from "../autohdr/scaffold";
import { enqueueEditorReconcile } from "../editor-folders/queue";
import { getEditorFolderMapping } from "../editor-folders/mapping";
import type { DropboxMetadataOperation } from "../editor-folders/scaffold";
import { automationFlag } from "../dropbox/monitor-state";
import type { DropboxSyncMessage } from "../messages";
import { canonicalDropboxConnectionId } from "../dropbox/connection";
import { getMetadata, isDropboxPathNotFoundError } from "../dropbox/client";

type Project = Pick<typeof projects.$inferSelect, "id" | "street" | "postcode" | "archivedAt" | "orderId" | "orderNo" | "suburb" | "agencyName" | "agentName" | "agentEmail" | "agentPhone" | "shootDate" | "timeWindow" | "notes" | "rawFolderLink" | "rawFolderPath">;

/** Optional dependency seam so tests can substitute Dropbox metadata verification without a live connection. */
export type TonomoProcessDependencies = {
  getMetadata?: DropboxMetadataOperation;
};

type VerifiedRawFolder = { path: string; folderId: string };

function addressLeaf(path: string): string | undefined {
  return path.split("/").filter(Boolean).at(-1)?.toLowerCase();
}

export class TonomoApplyError extends Error {
  code?: "board_schema_maintenance";

  constructor(reason: string) {
    super(reason);
    this.name = "TonomoApplyError";
  }

  static boardSchemaMaintenance() {
    const error = new TonomoApplyError("Board schema migration is still being applied.");
    error.code = "board_schema_maintenance";
    return error;
  }
}

const snapshotFields = ["orderNo", "suburb", "postcode", "agencyName", "agentName", "agentEmail", "agentPhone", "shootDate", "timeWindow", "notes"] as const;

function orderedKinds(order: TonomoOrder): Set<CollectionKind> {
  const kinds = new Set<CollectionKind>(["raw"]);
  for (const service of order.services) {
    if ((COLLECTION_KINDS as readonly string[]).includes(service.kind)) kinds.add(service.kind);
  }
  return kinds;
}

async function ensureCollections(env: Env, projectId: string, order: TonomoOrder) {
  const db = dbFor(env);
  const kinds = orderedKinds(order);
  for (const kind of kinds) {
    const now = new Date();
    await db.insert(collections).values({ id: crypto.randomUUID(), projectId, kind, status: "empty", receivedCount: 0, createdAt: now, updatedAt: now }).onConflictDoNothing();
  }
  const rows = await db.select().from(collections).where(eq(collections.projectId, projectId)).all();
  return new Map(rows.map((collection) => [collection.kind as CollectionKind, collection]));
}

async function attachServiceLinks(env: Env, order: TonomoOrder, collectionByKind: Map<CollectionKind, typeof collections.$inferSelect>) {
  const db = dbFor(env);
  for (const service of order.services) {
    if (!service.url || service.kind === "raw") continue;
    const collection = collectionByKind.get(service.kind);
    if (!collection) continue;
    const now = new Date();
    // Redeliveries and concurrent manual additions use one logical-link constraint. The
    // count reconciliation shares this D1 batch even when the insert dedupes.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO collection_links (id, collection_id, url, label, source, position, created_at, updated_at) VALUES (?, ?, ?, ?, 'tonomo', COALESCE((SELECT MAX(position) FROM collection_links WHERE collection_id = ?), 0) + 1024, ?, ?) ON CONFLICT(collection_id, url) DO NOTHING").bind(crypto.randomUUID(), collection.id, service.url, service.label ?? null, collection.id, now.getTime(), now.getTime()),
      env.DB.prepare(COLLECTION_RECEIVED_COUNT_SQL).bind(...collectionReceivedCountBindings(collection.id, now.getTime())),
    ]);
  }
}

async function writeAudit(
  env: Env,
  action: "project.create" | "project.update",
  projectId: string,
  orderId: string,
  photographerUserIds: string[],
) {
  // audit_log.actor_id is a user foreign key; system actors are recorded in metadata instead.
  await dbFor(env).insert(auditLog).values({
    id: crypto.randomUUID(), actorId: null, action, targetType: "project", targetId: projectId,
    metaJson: JSON.stringify({ actor: "tonomo", orderId, assignedPhotographerUserIds: photographerUserIds }), createdAt: new Date(),
  });
}

async function findProject(env: Env, order: TonomoOrder, variant: BoardSchemaVariant): Promise<{ project: Project; linkedByAddress: boolean } | null> {
  const db = dbFor(env);
  const byOrderId = await db.select(projectColumnsForVariant(variant)).from(projects).where(eq(projects.orderId, order.orderId)).get() as Project | undefined;
  if (byOrderId) {
    if (byOrderId.archivedAt) {
      throw new TonomoApplyError(`order ${order.orderId} matches archived project ${byOrderId.street} — restore the project or discard this event`);
    }
    return { project: byOrderId, linkedByAddress: false };
  }

  const candidates = await db.select(projectColumnsForVariant(variant)).from(projects).where(order.postcode
    ? and(isNull(projects.orderId), isNull(projects.archivedAt), eq(projects.postcode, order.postcode))
    : and(isNull(projects.orderId), isNull(projects.archivedAt))).all();
  const key = normaliseAddressKey(order.street, order.postcode);
  const matches = candidates.filter((candidate) => normaliseAddressKey(candidate.street, candidate.postcode) === key);
  if (matches.length > 1) {
    throw new TonomoApplyError(`${matches.length} projects match address ${order.street} — link the order manually`);
  }
  return matches[0] ? { project: matches[0], linkedByAddress: true } : null;
}

async function createProject(env: Env, order: TonomoOrder): Promise<string> {
  const db = dbFor(env);
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(projects).values({
    id, street: order.street, suburb: order.suburb, postcode: order.postcode, agencyName: order.agencyName,
    agentName: order.agentName, agentEmail: order.agentEmail, agentPhone: order.agentPhone,
    shootDate: order.shootDate, timeWindow: order.timeWindow, orderNo: order.orderNo, orderId: order.orderId,
    invoiceAmount: order.invoiceAmount, paymentStatus: order.paymentStatus, notes: order.notes,
    rawFolderLink: order.rawFolderLink, rawFolderPath: order.rawFolderPath,
    stageKey: "awaiting_raw", boardPosition: appendToStageBottomExpr("awaiting_raw", id), boardRevision: 0, createdAt: now, updatedAt: now,
  });
  await enqueueAutoHdrScaffold(env, id).catch((error) =>
    console.error("AutoHDR scaffold trigger failed", { projectId: id, error }));
  return id;
}

/**
 * Tonomo's raw_folder_path encodes the assigned photographer and shoot date and can legitimately
 * change after the RAW folder already exists in Dropbox (a reassignment or a rescheduled shoot).
 * It also sometimes recomputes the string with no folder move at all, so an incoming path that
 * differs from what is stored is only adopted once a fresh Dropbox lookup proves the new path is
 * a real folder — never on the word of the webhook payload alone.
 */
async function verifiedRawFolderPathChange(
  env: Env,
  project: Project,
  order: TonomoOrder,
  dependencies: TonomoProcessDependencies,
): Promise<VerifiedRawFolder | null> {
  const db = dbFor(env);
  const decline = (reason: string) => {
    console.log("Tonomo raw folder path change declined", { projectId: project.id, orderId: order.orderId, reason });
    return null;
  };

  // Same gate as the RAW monitor: a ready Editor mapping owns RAW intake only while editor automation is on.
  if (automationFlag(env.DROPBOX_EDITOR_AUTOMATION_ENABLED)) {
    const mapping = await getEditorFolderMapping(db, project.id);
    if (mapping?.state === "ready") return decline("editor mapping ready; RAW intake already moved to the Editor tree");
  }

  const incomingPath = normalisePath(order.rawFolderPath as string);
  const storedPath = normalisePath(project.rawFolderPath as string);
  if (addressLeaf(incomingPath) !== addressLeaf(storedPath)) return decline("address leaf changed; needs manual review");

  let connectionId: string;
  try {
    connectionId = await canonicalDropboxConnectionId(db);
  } catch (error) {
    return decline(errorMessage(error));
  }

  const getMetadataOperation = dependencies.getMetadata ?? getMetadata;
  try {
    const entry = await getMetadataOperation(env, db, incomingPath, connectionId);
    if (entry[".tag"] !== "folder") return decline("Tonomo path is not a folder in Dropbox; keeping stored path");
    return { path: incomingPath, folderId: entry.id };
  } catch (error) {
    if (isDropboxPathNotFoundError(error)) return decline("Tonomo path not found in Dropbox; keeping stored path");
    return decline(errorMessage(error));
  }
}

/**
 * Guarded write of the verified path with its audit row in one D1 batch: the UPDATE is fenced on
 * the raw_folder_path this event read, and the audit INSERT only fires when that UPDATE landed
 * (matched by the unique updated_at it stamps). Zero changes means another writer (PATCH, the RAW
 * monitor) moved the path first; the next Tonomo event re-reads and decides again.
 */
async function commitRawFolderPathChange(
  env: Env,
  project: Project,
  order: TonomoOrder,
  verified: VerifiedRawFolder,
): Promise<boolean> {
  const at = Date.now();
  const link = order.rawFolderLink && order.rawFolderLink !== project.rawFolderLink ? order.rawFolderLink : null;
  const meta = JSON.stringify({
    actor: "tonomo", orderId: order.orderId, previousRawFolderPath: project.rawFolderPath, rawFolderPath: verified.path, dropboxFolderId: verified.folderId,
    ...(link ? { previousRawFolderLink: project.rawFolderLink, rawFolderLink: link } : {}),
  });
  // The ready-mapping guard is re-checked inside the fence: a mapping can go ready during the Dropbox lookup.
  const mappingGuard = automationFlag(env.DROPBOX_EDITOR_AUTOMATION_ENABLED)
    ? " AND NOT EXISTS (SELECT 1 FROM editor_folder_mappings m WHERE m.project_id = projects.id AND m.state = 'ready')"
    : "";
  const [update] = await env.DB.batch([
    env.DB.prepare(`UPDATE projects SET raw_folder_path = ?, raw_folder_link = COALESCE(?, raw_folder_link), updated_at = ? WHERE id = ? AND raw_folder_path = ? AND archived_at IS NULL${mappingGuard}`)
      .bind(verified.path, link, at, project.id, project.rawFolderPath),
    env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ?, NULL, 'project.raw_folder_path.changed', 'project', ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ? AND raw_folder_path = ? AND updated_at = ?)")
      .bind(crypto.randomUUID(), project.id, meta, at, project.id, verified.path, at),
  ]);
  if ((update?.meta.changes ?? 0) === 0) {
    console.log("Tonomo raw folder path change lost the race; another writer moved the path first", { projectId: project.id, orderId: order.orderId });
    return false;
  }
  return true;
}

/** A D1-only path edit produces no Dropbox delta, so the monitor never notices the new location on its own. */
async function enqueueRawFolderPathSync(env: Env, db: Database, projectId: string): Promise<{ jobId: string }> {
  const jobId = await createJob(db, { kind: "dropbox_sync", projectId, correlationId: `dropbox_sync:${projectId}` });
  try {
    const message: DropboxSyncMessage = { type: "dropbox_sync", projectId, jobId, trigger: "tonomo_raw_path_changed" };
    await env.INGEST_QUEUE.send(message);
    return { jobId };
  } catch (error) {
    await setJobStatus(db, jobId, "failed", errorMessage(error));
    throw error;
  }
}

async function updateProject(env: Env, project: Project, linkedByAddress: boolean, order: TonomoOrder, dependencies: TonomoProcessDependencies): Promise<string> {
  const db = dbFor(env);
  const changes: {
    orderId?: string; orderNo?: string; suburb?: string; postcode?: string; agencyName?: string;
    agentName?: string; agentEmail?: string; agentPhone?: string; shootDate?: string; timeWindow?: string;
    notes?: string; invoiceAmount?: number | null; paymentStatus?: string | null;
    rawFolderLink?: string; rawFolderPath?: string; updatedAt: Date;
  } = { updatedAt: new Date() };
  if (linkedByAddress) changes.orderId = order.orderId;
  for (const field of snapshotFields) {
    const incoming = order[field];
    if (project[field] === null && incoming !== null) changes[field] = incoming;
  }
  // A `created` webhook without `when.start_time` stores its display text verbatim
  // (parseTonomoOrder only recognises the exact canonical weekday/day/month/year shape); a
  // later `changed` event carrying the real date must be allowed to upgrade that display
  // text even though the field is already non-null, but never overwrite a manually edited
  // or already-canonical value, and never write a non-canonical incoming value over it.
  if (order.shootDate !== null && project.shootDate !== null
    && !isCanonicalCalendarDate(project.shootDate) && isCanonicalCalendarDate(order.shootDate)) changes.shootDate = order.shootDate;
  if (order.invoiceAmount !== undefined) changes.invoiceAmount = order.invoiceAmount;
  if (order.paymentStatus !== undefined) changes.paymentStatus = order.paymentStatus;
  if (!project.rawFolderLink && order.rawFolderLink) changes.rawFolderLink = order.rawFolderLink;
  if (!project.rawFolderPath && order.rawFolderPath) changes.rawFolderPath = order.rawFolderPath;

  let verified: VerifiedRawFolder | null = null;
  if (order.rawFolderPath && project.rawFolderPath && normalisePath(order.rawFolderPath) !== normalisePath(project.rawFolderPath)) {
    verified = await verifiedRawFolderPathChange(env, project, order, dependencies);
  }

  await db.update(projects).set(changes).where(eq(projects.id, project.id));
  const moved = verified ? await commitRawFolderPathChange(env, project, order, verified) : false;
  if (changes.rawFolderPath !== undefined || moved) {
    await enqueueAutoHdrScaffold(env, project.id).catch((error) =>
      console.error("AutoHDR scaffold trigger failed", { projectId: project.id, error }));
  }
  if (moved) {
    await enqueueRawFolderPathSync(env, db, project.id).catch((error) =>
      console.error("RAW folder path sync trigger failed", { projectId: project.id, error }));
  }
  return project.id;
}

async function assignPhotographers(env: Env, projectId: string, emails: string[]): Promise<{ userIds: string[]; warning: string | null }> {
  if (!emails.length) return { userIds: [], warning: null };
  const db = dbFor(env);
  const activeUsers = await db.select({ id: user.id, email: user.email }).from(user).where(eq(user.active, true));
  const usersByEmail = new Map(activeUsers.map((candidate) => [candidate.email.toLowerCase(), candidate]));
  const userIds: string[] = [];
  const unmatched: string[] = [];
  for (const email of emails) {
    const matched = usersByEmail.get(email);
    if (!matched) {
      unmatched.push(email);
      continue;
    }
    userIds.push(matched.id);
    await db.insert(projectMembers).values({
      id: crypto.randomUUID(), projectId, userId: matched.id, roleOnProject: "photographer", createdAt: new Date(),
    }).onConflictDoNothing();
  }
  return { userIds, warning: unmatched.length ? `No active user matches photographers: ${unmatched.join(", ")}` : null };
}

async function applyOrder(env: Env, order: TonomoOrder, dependencies: TonomoProcessDependencies): Promise<string | null> {
  const variant = await boardSchemaVariant(env.DB);
  if (variant === "pre_0037") throw TonomoApplyError.boardSchemaMaintenance();
  const match = await findProject(env, order, variant);
  const action = match ? "project.update" : "project.create";
  const projectId = match
    ? await updateProject(env, match.project, match.linkedByAddress, order, dependencies)
    : await createProject(env, order);
  const collectionByKind = await ensureCollections(env, projectId, order);
  await attachServiceLinks(env, order, collectionByKind);
  const photographers = await assignPhotographers(env, projectId, order.photographerEmails);
  await writeAudit(env, action, projectId, order.orderId, photographers.userIds);
  // Assignment must be durable before the scaffold worker evaluates its prerequisites.
  await enqueueEditorReconcile(env, projectId).catch((error) =>
    console.error("Editor folder reconciliation trigger failed", { projectId, error }));
  return photographers.warning;
}

export function isDeterministicTonomoError(error: unknown): error is TonomoParseError | TonomoApplyError {
  return error instanceof TonomoParseError || error instanceof TonomoApplyError;
}

/** Processes one stored event. The fixed-ID TonomoProcessorDO owns all draining and retries. */
export async function processTonomoEvent(env: Env, event: Pick<typeof webhookEvents.$inferSelect, "id" | "payloadJson">, dependencies: TonomoProcessDependencies = {}): Promise<void> {
  const db = dbFor(env);
  const order = parseTonomoOrder(JSON.parse(event.payloadJson));
  const photographerWarning = await applyOrder(env, order, dependencies);
  const warnings = [
    order.unrecognisedServices.length ? `Unrecognised services: ${order.unrecognisedServices.join(", ")}` : null,
    photographerWarning,
  ].filter((warning): warning is string => Boolean(warning));
  await db.update(webhookEvents).set({ status: "processed", error: warnings.join("\n") || null, processedAt: new Date() }).where(eq(webhookEvents.id, event.id));
}
