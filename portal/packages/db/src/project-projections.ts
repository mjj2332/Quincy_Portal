import type { BoardSchemaVariant } from "./board-schema-variant";
import * as schema from "./schema";

/**
 * Explicitly enumerated because Drizzle's table-wide select follows schema.ts and would mention
 * board_revision on a 0036 database. This is also the single audit surface for project reads.
 */
export const projectColumnsPre0037 = {
  id: schema.projects.id,
  street: schema.projects.street,
  suburb: schema.projects.suburb,
  postcode: schema.projects.postcode,
  agencyName: schema.projects.agencyName,
  agentName: schema.projects.agentName,
  agentEmail: schema.projects.agentEmail,
  agentPhone: schema.projects.agentPhone,
  agencyId: schema.projects.agencyId,
  agentId: schema.projects.agentId,
  shootDate: schema.projects.shootDate,
  timeWindow: schema.projects.timeWindow,
  stageKey: schema.projects.stageKey,
  priority: schema.projects.priority,
  boardPosition: schema.projects.boardPosition,
  orderNo: schema.projects.orderNo,
  orderId: schema.projects.orderId,
  invoiceAmount: schema.projects.invoiceAmount,
  paymentStatus: schema.projects.paymentStatus,
  notes: schema.projects.notes,
  productionNotes: schema.projects.productionNotes,
  rawFolderLink: schema.projects.rawFolderLink,
  rawFolderPath: schema.projects.rawFolderPath,
  coverAssetId: schema.projects.coverAssetId,
  archivedAt: schema.projects.archivedAt,
  archivedBy: schema.projects.archivedBy,
  deadlineLocalCivil: schema.projects.deadlineLocalCivil,
  deadlineZone: schema.projects.deadlineZone,
  deadlineUtcOffsetMinutes: schema.projects.deadlineUtcOffsetMinutes,
  deadlineFold: schema.projects.deadlineFold,
  deadlineAt: schema.projects.deadlineAt,
  deadlineReminderOffsetsJson: schema.projects.deadlineReminderOffsetsJson,
  deadlineVersion: schema.projects.deadlineVersion,
  createdAt: schema.projects.createdAt,
  updatedAt: schema.projects.updatedAt,
} as const;

export function projectColumnsForVariant(variant: BoardSchemaVariant) {
  return variant === "tb5a_0037"
    ? { ...projectColumnsPre0037, boardRevision: schema.projects.boardRevision }
    : projectColumnsPre0037;
}

