import { and, eq, isNull } from "drizzle-orm";
import { COLLECTION_KINDS, normaliseAddressKey, parseTonomoOrder, TonomoParseError, type CollectionKind, type TonomoOrder } from "@quincy/shared";
import { auditLog, collectionLinks, collections, projectMembers, projects, user, webhookEvents } from "@quincy/db/schema";

import type { Env } from "../env";
import { dbFor } from "../lib/db";

type Project = typeof projects.$inferSelect;

export class TonomoApplyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "TonomoApplyError";
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
    const existing = await db.select({ id: collectionLinks.id }).from(collectionLinks)
      .where(and(eq(collectionLinks.collectionId, collection.id), eq(collectionLinks.url, service.url))).get();
    const now = new Date();
    if (!existing) {
      await db.insert(collectionLinks).values({
        id: crypto.randomUUID(), collectionId: collection.id, url: service.url, label: service.label,
        source: "tonomo", createdAt: now, updatedAt: now,
      });
    }
    await db.update(collections).set({ status: "received", updatedAt: now }).where(eq(collections.id, collection.id));
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

async function findProject(env: Env, order: TonomoOrder): Promise<{ project: Project; linkedByAddress: boolean } | null> {
  const db = dbFor(env);
  const byOrderId = await db.select().from(projects).where(eq(projects.orderId, order.orderId)).get();
  if (byOrderId) {
    if (byOrderId.archivedAt) {
      throw new TonomoApplyError(`order ${order.orderId} matches archived project ${byOrderId.street} — restore the project or discard this event`);
    }
    return { project: byOrderId, linkedByAddress: false };
  }

  const candidates = await db.select().from(projects).where(order.postcode
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
    stageKey: "awaiting_raw", createdAt: now, updatedAt: now,
  });
  return id;
}

async function updateProject(env: Env, project: Project, linkedByAddress: boolean, order: TonomoOrder): Promise<string> {
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
  if (order.invoiceAmount !== undefined) changes.invoiceAmount = order.invoiceAmount;
  if (order.paymentStatus !== undefined) changes.paymentStatus = order.paymentStatus;
  if (!project.rawFolderLink && order.rawFolderLink) changes.rawFolderLink = order.rawFolderLink;
  if (!project.rawFolderPath && order.rawFolderPath) changes.rawFolderPath = order.rawFolderPath;
  await db.update(projects).set(changes).where(eq(projects.id, project.id));
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

async function applyOrder(env: Env, order: TonomoOrder): Promise<string | null> {
  const match = await findProject(env, order);
  const action = match ? "project.update" : "project.create";
  const projectId = match
    ? await updateProject(env, match.project, match.linkedByAddress, order)
    : await createProject(env, order);
  const collectionByKind = await ensureCollections(env, projectId, order);
  await attachServiceLinks(env, order, collectionByKind);
  const photographers = await assignPhotographers(env, projectId, order.photographerEmails);
  await writeAudit(env, action, projectId, order.orderId, photographers.userIds);
  return photographers.warning;
}

export function isDeterministicTonomoError(error: unknown): error is TonomoParseError | TonomoApplyError {
  return error instanceof TonomoParseError || error instanceof TonomoApplyError;
}

/** Processes one stored event. The fixed-ID TonomoProcessorDO owns all draining and retries. */
export async function processTonomoEvent(env: Env, event: Pick<typeof webhookEvents.$inferSelect, "id" | "payloadJson">): Promise<void> {
  const db = dbFor(env);
  const order = parseTonomoOrder(JSON.parse(event.payloadJson));
  const photographerWarning = await applyOrder(env, order);
  const warnings = [
    order.unrecognisedServices.length ? `Unrecognised services: ${order.unrecognisedServices.join(", ")}` : null,
    photographerWarning,
  ].filter((warning): warning is string => Boolean(warning));
  await db.update(webhookEvents).set({ status: "processed", error: warnings.join("\n") || null, processedAt: new Date() }).where(eq(webhookEvents.id, event.id));
}
