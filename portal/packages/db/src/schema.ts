/**
 * Quincy Portal — D1 schema v1 (Implementation-Plan §5).
 * Metadata only: media bytes live in R2; dense annotation JSON lives in R2 (ref here).
 * All media rows use immutable, versioned R2 keys.
 */
import { sqliteTable, text, integer, real, index, unique, uniqueIndex, check, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const id = () => text("id").primaryKey();
const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull();
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" }).$defaultFn(() => new Date()).notNull();

/* ---------------------------------------------------------------- auth
 * better-auth managed tables (Google-only in MVP — no magic-link tables).
 * Column names follow better-auth's drizzle conventions; profile fields
 * (role, active) are additionalFields on user.
 */
export const user = sqliteTable("user", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  // Quincy profile fields
  role: text("role", { enum: ["admin", "photographer", "editor", "external_editor"] })
    .notNull()
    .default("photographer"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  authorizationEpoch: integer("authorization_epoch").notNull().default(0),
  banned: integer("banned", { mode: "boolean" }).notNull().default(false),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp_ms" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = sqliteTable(
  "session",
  {
    id: id(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const featureFlags = sqliteTable(
  "feature_flags",
  {
    key: text("key").primaryKey().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check("feature_flags_enabled_check", sql`${t.enabled} in (0,1)`),
    index("feature_flags_updated_by_idx").on(t.updatedBy),
  ],
);

export const account = sqliteTable(
  "account",
  {
    id: id(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = sqliteTable("verification", {
  id: id(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ------------------------------------------------------- admin backend */

export const agencies = sqliteTable("agencies", {
  id: id(),
  name: text("name").notNull(),
  notes: text("notes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const agents = sqliteTable(
  "agents",
  {
    id: id(),
    agencyId: text("agency_id").references(() => agencies.id),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("agents_agency_idx").on(t.agencyId)],
);

export const pipelineStages = sqliteTable("pipeline_stages", {
  key: text("key").primaryKey(),
  label: text("label").notNull(),
  displayOrder: integer("display_order").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
});

export const integrationConnections = sqliteTable("integration_connections", {
  id: id(),
  provider: text("provider", { enum: ["dropbox", "tonomo", "vimeo", "email"] }).notNull(),
  status: text("status", { enum: ["disconnected", "connected", "expired", "error"] })
    .notNull()
    .default("disconnected"),
  /** AES-GCM ciphertext (KEK in wrangler secret) — never plaintext (Implementation-Plan §2 A5). */
  encryptedCredentials: text("encrypted_credentials"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  scopes: text("scopes"),
  lastEventAt: integer("last_event_at", { mode: "timestamp_ms" }),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* -------------------------------------------------------------- projects */

export const projects = sqliteTable(
  "projects",
  {
    id: id(),
    street: text("street").notNull(),
    suburb: text("suburb"),
    postcode: text("postcode"),
    /** Tonomo-supplied contact snapshot (free text, kept even when linked to directory). */
    agencyName: text("agency_name"),
    agentName: text("agent_name"),
    agentEmail: text("agent_email"),
    agentPhone: text("agent_phone"),
    /** Directory links (admin backend §6.9) — nullable. */
    agencyId: text("agency_id").references(() => agencies.id),
    agentId: text("agent_id").references(() => agents.id),
    shootDate: text("shoot_date"),
    timeWindow: text("time_window"),
    stageKey: text("stage_key").notNull().default("awaiting_raw"),
    priority: integer("priority"),
    boardPosition: real("board_position").notNull().default(0),
    boardRevision: integer("board_revision").notNull().default(0),
    orderNo: text("order_no"),
    orderId: text("order_id"),
    invoiceAmount: real("invoice_amount"),
    paymentStatus: text("payment_status"),
    notes: text("notes"),
    productionNotes: text("production_notes"),
    rawFolderLink: text("raw_folder_link"),
    rawFolderPath: text("raw_folder_path"),
    coverAssetId: text("cover_asset_id"),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    archivedBy: text("archived_by").references(() => user.id),
    deadlineLocalCivil: text("deadline_local_civil"),
    deadlineZone: text("deadline_zone", { enum: ["Australia/Sydney"] }),
    deadlineUtcOffsetMinutes: integer("deadline_utc_offset_minutes"),
    deadlineFold: integer("deadline_fold"),
    deadlineAt: integer("deadline_at"),
    deadlineReminderOffsetsJson: text("deadline_reminder_offsets_json"),
    deadlineVersion: integer("deadline_version").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("projects_stage_idx").on(t.stageKey),
    index("projects_order_idx").on(t.orderId),
    index("projects_archived_idx").on(t.archivedAt),
    check("projects_priority_check", sql`${t.priority} IS NULL OR (typeof(${t.priority}) = 'integer' AND ${t.priority} >= 1 AND ${t.priority} <= 10)`),
    check("projects_deadline_zone_check", sql`${t.deadlineZone} IS NULL OR ${t.deadlineZone} = 'Australia/Sydney'`),
    check("projects_deadline_utc_offset_check", sql`${t.deadlineUtcOffsetMinutes} IS NULL OR (typeof(${t.deadlineUtcOffsetMinutes}) = 'integer' AND ${t.deadlineUtcOffsetMinutes} BETWEEN -840 AND 840)`),
    check("projects_deadline_fold_check", sql`${t.deadlineFold} IS NULL OR ${t.deadlineFold} IN (0, 1)`),
    check("projects_deadline_at_check", sql`${t.deadlineAt} IS NULL OR typeof(${t.deadlineAt}) = 'integer'`),
    check("projects_deadline_reminder_offsets_check", sql`${t.deadlineReminderOffsetsJson} IS NULL OR json_valid(${t.deadlineReminderOffsetsJson})`),
    check("projects_deadline_version_check", sql`typeof(${t.deadlineVersion}) = 'integer' AND ${t.deadlineVersion} >= 0`),
  ],
);

export const projectDeadlineOccurrences = sqliteTable(
  "project_deadline_occurrences",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    scheduleVersion: integer("schedule_version").notNull(),
    kind: text("kind", { enum: ["advance", "due_now"] as const }).notNull(),
    reminderOffsetMinutes: integer("reminder_offset_minutes").notNull(),
    fireAt: integer("fire_at").notNull(),
    deadlineAt: integer("deadline_at").notNull(),
    deadlineLocalCivil: text("deadline_local_civil").notNull(),
    deadlineZone: text("deadline_zone", { enum: ["Australia/Sydney"] as const }).notNull(),
    deadlineUtcOffsetMinutes: integer("deadline_utc_offset_minutes").notNull(),
    deadlineFold: integer("deadline_fold").notNull(),
    status: text("status", { enum: ["pending", "fired", "skipped", "superseded"] as const }).notNull(),
    terminalReason: text("terminal_reason", { enum: ["elapsed_at_save", "schedule_replaced", "deadline_cleared", "project_delivered", "project_archived"] as const }),
    firedAt: integer("fired_at"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("project_deadline_occurrences_due_idx").on(t.status, t.fireAt, t.projectId, t.id),
    index("project_deadline_occurrences_project_version_idx").on(t.projectId, t.scheduleVersion, t.status, t.reminderOffsetMinutes, t.id),
    unique("project_deadline_occurrences_unique").on(t.projectId, t.scheduleVersion, t.kind, t.reminderOffsetMinutes),
    check("project_deadline_occurrences_schedule_version_check", sql`typeof(${t.scheduleVersion}) = 'integer' AND ${t.scheduleVersion} >= 1`),
    check("project_deadline_occurrences_kind_check", sql`(${t.kind} = 'due_now' AND ${t.reminderOffsetMinutes} = 0) OR (${t.kind} = 'advance' AND ${t.reminderOffsetMinutes} BETWEEN 1 AND 43200)`),
    check("project_deadline_occurrences_offset_check", sql`typeof(${t.reminderOffsetMinutes}) = 'integer' AND ${t.reminderOffsetMinutes} BETWEEN 0 AND 43200`),
    check("project_deadline_occurrences_zone_check", sql`${t.deadlineZone} = 'Australia/Sydney'`),
    check("project_deadline_occurrences_fold_check", sql`${t.deadlineFold} IN (0, 1)`),
    check("project_deadline_occurrences_fire_at_check", sql`${t.fireAt} = ${t.deadlineAt} - (${t.reminderOffsetMinutes} * 60000)`),
    check("project_deadline_occurrences_terminal_check", sql`(${t.status} = 'pending' AND ${t.terminalReason} IS NULL AND ${t.firedAt} IS NULL) OR (${t.status} = 'fired' AND ${t.terminalReason} IS NULL AND ${t.firedAt} IS NOT NULL) OR (${t.status} IN ('skipped', 'superseded') AND ${t.terminalReason} IS NOT NULL AND ${t.firedAt} IS NULL)`),
  ],
);

export const notificationPreferences = sqliteTable(
  "notification_preferences",
  {
    userId: text("user_id").primaryKey().notNull().references(() => user.id, { onDelete: "cascade" }),
    projectDeadlineReminderEmails: integer("project_deadline_reminder_emails").notNull().default(1),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [check("notification_preferences_email_check", sql`${t.projectDeadlineReminderEmails} IN (0, 1)`)],
);

export const projectMembers = sqliteTable(
  "project_members",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    roleOnProject: text("role_on_project", { enum: ["photographer", "editor"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("project_members_unique").on(t.projectId, t.userId, t.roleOnProject),
    index("project_members_user_idx").on(t.userId),
  ],
);

export const projectActivityEvents = sqliteTable(
  "project_activity_events",
  {
    id: id(),
    schemaVersion: integer("schema_version").notNull(),
    eventType: text("event_type").notNull(),
    category: text("category").notNull(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    actorKind: text("actor_kind", { enum: ["user", "system"] as const }).notNull(),
    actorId: text("actor_id"),
    occurredAt: integer("occurred_at").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    sourceKey: text("source_key").notNull(),
    safePayloadJson: text("safe_payload_json").notNull(),
    deepLinkKind: text("deep_link_kind", { enum: ["project", "project_collaboration"] as const }).notNull(),
    deepLinkPath: text("deep_link_path").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    unique("project_activity_events_event_source_unique").on(t.eventType, t.sourceKey),
    check("project_activity_events_schema_version_check", sql`${t.schemaVersion} = 1`),
    check("project_activity_events_actor_kind_check", sql`${t.actorKind} IN ('user', 'system')`),
    check("project_activity_events_occurred_at_check", sql`typeof(${t.occurredAt}) = 'integer'`),
    check("project_activity_events_safe_payload_check", sql`json_valid(${t.safePayloadJson})`),
    check("project_activity_events_deep_link_kind_check", sql`${t.deepLinkKind} IN ('project', 'project_collaboration')`),
    check("project_activity_events_created_at_check", sql`typeof(${t.createdAt}) = 'integer'`),
    check("project_activity_events_actor_contract_check", sql`(${t.actorKind} = 'user' AND ${t.actorId} IS NOT NULL) OR (${t.actorKind} = 'system' AND ${t.actorId} IS NULL)`),
  ],
);

/** Shared discussion scoped to explicit project participants and active admins. */
export const projectComments = sqliteTable(
  "project_comments",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    authorId: text("author_id").notNull().references(() => user.id),
    body: text("body").notNull(),
    contentJson: text("content_json").notNull(),
    createdAt: createdAt(),
    editedAt: integer("edited_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("project_comments_project_created_idx").on(t.projectId, t.createdAt, t.id)],
);

export const projectCommentMentions = sqliteTable(
  "project_comment_mentions",
  {
    id: id(),
    commentId: text("comment_id").notNull().references(() => projectComments.id, { onDelete: "cascade" }),
    mentionedUserId: text("mentioned_user_id").notNull().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("project_comment_mentions_unique").on(t.commentId, t.mentionedUserId)],
);

export const projectCommentReadMarkers = sqliteTable(
  "project_comment_read_markers",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    lastReadCommentId: text("last_read_comment_id").notNull(),
    lastReadCommentCreatedAt: integer("last_read_comment_created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.projectId] }),
    index("project_comment_read_markers_project_idx").on(t.projectId, t.lastReadCommentCreatedAt),
  ],
);

/** A shared, ordered checklist item owned by a project. Due dates are literal calendar strings. */
export const projectSubtasks = sqliteTable(
  "project_subtasks",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    done: integer("done", { mode: "boolean" }).notNull().default(false),
    position: integer("position").notNull(),
    assigneeId: text("assignee_id").references(() => user.id, { onDelete: "set null" }),
    assignmentVersion: integer("assignment_version").notNull().default(0),
    dueDate: text("due_date"),
    dueReminderSentAt: integer("due_reminder_sent_at", { mode: "timestamp_ms" }),
    scheduleStartKind: text("schedule_start_kind", { enum: ["date", "timed"] as const }),
    scheduleStartCivil: text("schedule_start_civil"),
    scheduleStartAt: integer("schedule_start_at"),
    scheduleStartUtcOffsetMinutes: integer("schedule_start_utc_offset_minutes"),
    scheduleStartFold: integer("schedule_start_fold"),
    scheduleEndKind: text("schedule_end_kind", { enum: ["date", "timed"] as const }),
    scheduleEndAt: integer("schedule_end_at"),
    scheduleEndUtcOffsetMinutes: integer("schedule_end_utc_offset_minutes"),
    scheduleEndFold: integer("schedule_end_fold"),
    scheduleZone: text("schedule_zone", { enum: ["Australia/Sydney"] as const }),
    scheduleVersion: integer("schedule_version").notNull().default(0),
    createdBy: text("created_by").notNull().references(() => user.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("project_subtasks_project_position_idx").on(t.projectId, t.position, t.id),
    index("project_subtasks_assignee_idx").on(t.assigneeId),
    check("project_subtasks_schedule_start_kind_check", sql`${t.scheduleStartKind} IS NULL OR ${t.scheduleStartKind} IN ('date', 'timed')`),
    check("project_subtasks_schedule_start_at_check", sql`${t.scheduleStartAt} IS NULL OR typeof(${t.scheduleStartAt}) = 'integer'`),
    check("project_subtasks_schedule_start_utc_offset_check", sql`${t.scheduleStartUtcOffsetMinutes} IS NULL OR (typeof(${t.scheduleStartUtcOffsetMinutes}) = 'integer' AND ${t.scheduleStartUtcOffsetMinutes} BETWEEN -840 AND 840)`),
    check("project_subtasks_schedule_start_fold_check", sql`${t.scheduleStartFold} IS NULL OR ${t.scheduleStartFold} IN (0, 1)`),
    check("project_subtasks_schedule_end_kind_check", sql`${t.scheduleEndKind} IS NULL OR ${t.scheduleEndKind} IN ('date', 'timed')`),
    check("project_subtasks_schedule_end_at_check", sql`${t.scheduleEndAt} IS NULL OR typeof(${t.scheduleEndAt}) = 'integer'`),
    check("project_subtasks_schedule_end_utc_offset_check", sql`${t.scheduleEndUtcOffsetMinutes} IS NULL OR (typeof(${t.scheduleEndUtcOffsetMinutes}) = 'integer' AND ${t.scheduleEndUtcOffsetMinutes} BETWEEN -840 AND 840)`),
    check("project_subtasks_schedule_end_fold_check", sql`${t.scheduleEndFold} IS NULL OR ${t.scheduleEndFold} IN (0, 1)`),
    check("project_subtasks_schedule_zone_check", sql`${t.scheduleZone} IS NULL OR ${t.scheduleZone} = 'Australia/Sydney'`),
    check("project_subtasks_schedule_version_check", sql`typeof(${t.scheduleVersion}) = 'integer' AND ${t.scheduleVersion} >= 0`),
  ],
);

/** Short-lived, user-scoped handoff from a selection POST to a streamed ZIP GET. */
export const downloadSelectionTickets = sqliteTable(
  "download_selection_tickets",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    assetIdsJson: text("asset_ids_json").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("download_selection_tickets_expires_at_idx").on(t.expiresAt)],
);

/* ------------------------------------------------------- media pipeline */

export const collections = sqliteTable(
  "collections",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["raw", "edited", "video", "floorplan", "copy"] }).notNull(),
    status: text("status").notNull().default("empty"),
    /** File-count verification ("upload 18 → see 18", Implementation-Plan §6 Phase 1). */
    expectedCount: integer("expected_count"),
    receivedCount: integer("received_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("collections_project_kind").on(t.projectId, t.kind)],
);

/** Finished Tonomo deliverables are external URLs, not R2-backed media assets. */
export const collectionLinks = sqliteTable(
  "collection_links",
  {
    id: id(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    label: text("label"),
    source: text("source", { enum: ["tonomo", "manual"] }).notNull(),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("collection_links_collection_idx").on(t.collectionId),
    index("collection_links_collection_position_idx").on(t.collectionId, t.position, t.id),
    uniqueIndex("collection_links_collection_url_unique").on(t.collectionId, t.url),
  ],
);

/** Server-owned reservation for direct document uploads. Keys and version numbers never
 * come from the browser; a completed reservation is also the idempotency record. */
export const documentUploads = sqliteTable(
  "document_uploads",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    collectionId: text("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
    createdBy: text("created_by").notNull().references(() => user.id),
    kind: text("kind", { enum: ["copy_pdf", "floorplan"] }).notNull(),
    versionGroupId: text("version_group_id").notNull(),
    version: integer("version").notNull(),
    pdfAssetId: text("pdf_asset_id").notNull(),
    pdfKey: text("pdf_key").notNull().unique(),
    pdfFilename: text("pdf_filename").notNull(),
    pdfBytes: integer("pdf_bytes").notNull(),
    pdfContentType: text("pdf_content_type").notNull(),
    pdfUploadId: text("pdf_upload_id"),
    pdfSupersedesAssetId: text("pdf_supersedes_asset_id"),
    previewAssetId: text("preview_asset_id"),
    previewKey: text("preview_key").unique(),
    previewFilename: text("preview_filename"),
    previewBytes: integer("preview_bytes"),
    previewContentType: text("preview_content_type"),
    previewUploadId: text("preview_upload_id"),
    previewSupersedesAssetId: text("preview_supersedes_asset_id"),
    /** Finite lifecycle: pending → completing → completed; aborting owns failed R2 cleanup. */
    status: text("status", { enum: ["pending", "completing", "aborting", "completed", "expired", "failed"] }).notNull().default("pending"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    /** Completing has a bounded lease; stale sessions are retried through abort cleanup. */
    completingAt: integer("completing_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    /** Stored before external completion so the final asset/audit batch is retry-safe. */
    completionAuditId: text("completion_audit_id").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("document_uploads_active_group_unique").on(t.versionGroupId).where(sql`${t.status} in ('pending', 'completing', 'aborting')`),
    index("document_uploads_project_creator_idx").on(t.projectId, t.createdBy),
    index("document_uploads_collection_idx").on(t.collectionId),
    index("document_uploads_status_expiry_idx").on(t.status, t.expiresAt),
    check("document_uploads_status_check", sql`${t.status} in ('pending', 'completing', 'aborting', 'completed', 'expired', 'failed')`),
    check("document_uploads_kind_preview_check", sql`(${t.kind} = 'copy_pdf' AND ${t.previewAssetId} IS NULL AND ${t.previewKey} IS NULL AND ${t.previewFilename} IS NULL AND ${t.previewBytes} IS NULL AND ${t.previewContentType} IS NULL AND ${t.previewUploadId} IS NULL AND ${t.previewSupersedesAssetId} IS NULL) OR (${t.kind} = 'floorplan' AND ${t.previewAssetId} IS NOT NULL AND ${t.previewKey} IS NOT NULL AND ${t.previewFilename} IS NOT NULL AND ${t.previewBytes} IS NOT NULL AND ${t.previewContentType} = 'image/jpeg')`),
  ],
);

/** Browser-selected-file manifest persisted BEFORE ingest (file-count verification for manual uploads). */
export const uploadManifests = sqliteTable(
  "upload_manifests",
  {
    id: id(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    expectedCount: integer("expected_count").notNull(),
    filenamesJson: text("filenames_json").notNull(),
    /** Active manifests nag indefinitely until their stamped asset count exactly matches. */
    status: text("status", { enum: ["active", "complete"] }).notNull().default("active"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [index("upload_manifests_collection_idx").on(t.collectionId)],
);

export const assets = sqliteTable(
  "assets",
  {
    id: id(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["photo", "video", "floorplan_pdf", "floorplan_preview", "copy_pdf"] })
      .notNull()
      .default("photo"),
    /** Immutable, versioned R2 key. */
    r2Key: text("r2_key").notNull().unique(),
    originalFilename: text("original_filename").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    contentHash: text("content_hash"),
    source: text("source", { enum: ["upload", "dropbox", "tonomo"] }).notNull(),
    /** Original provider path captured at ingest for source-system handoffs such as AutoHDR; legacy rows may be NULL. */
    sourcePath: text("source_path"),
    /** Lower-cased canonical Dropbox key. Nullable until the Wave-3 backfill validates legacy rows. */
    sourcePathKey: text("source_path_key"),
    /** Durable manual-upload batch attribution; retained independently of collection totals. */
    manifestId: text("manifest_id").references(() => uploadManifests.id, { onDelete: "set null" }),
    /** Manual edited uploads stay hidden until their Dropbox publish job succeeds. */
    publishStatus: text("publish_status", { enum: ["pending", "ready", "failed"] }).notNull().default("ready"),
    /** XMP xmp:Rating read at ingest; NULL = unrated (never coerce to 0). */
    ratingFromMetadata: integer("rating_from_metadata"),
    streamUid: text("stream_uid"),
    /** NULL is the root Captures section; Dropbox immediate subfolders retain their display name. */
    section: text("section"),
    /** Deprecated in favour of section; retained for non-destructive compatibility. */
    isPremium: integer("is_premium", { mode: "boolean" }).notNull().default(false),
    version: integer("version").notNull().default(1),
    supersedesAssetId: text("supersedes_asset_id"),
    /** Current edited versions have NULL. Historical versions are retained indefinitely. */
    supersededAt: integer("superseded_at", { mode: "timestamp_ms" }),
    replacedByAssetId: text("replaced_by_asset_id"),
    /** Frozen AutoHDR handoff that owns this returned final. */
    autoHdrHandoffId: text("autohdr_handoff_id"),
    /** RAW↔Edited pairing (D-07): set on edited assets returned from autoHDR. */
    sourceRawAssetId: text("source_raw_asset_id"),
    /** Ties floorplan PDF + preview JPG into one floorplan version (D-08). */
    versionGroupId: text("version_group_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("assets_collection_idx").on(t.collectionId),
    index("assets_manifest_idx").on(t.manifestId),
    index("assets_source_raw_idx").on(t.sourceRawAssetId),
    index("assets_source_path_key_idx").on(t.collectionId, t.sourcePathKey),
    index("assets_current_idx").on(t.collectionId, t.supersededAt),
    uniqueIndex("assets_current_source_unique").on(t.collectionId, t.sourcePathKey)
      .where(sql`${t.supersededAt} IS NULL AND ${t.sourcePathKey} IS NOT NULL`),
    index("assets_autohdr_handoff_idx").on(t.autoHdrHandoffId),
    index("assets_hash_idx").on(t.contentHash),
    index("assets_publish_status_idx").on(t.publishStatus),
    uniqueIndex("assets_version_group_kind_version_unique").on(t.versionGroupId, t.kind, t.version),
  ],
);

export const assetRenditions = sqliteTable(
  "asset_renditions",
  {
    id: id(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    variant: text("variant", { enum: ["thumb", "web"] }).notNull(),
    r2Key: text("r2_key").notNull(),
    bytes: integer("bytes"),
    // Defaults deliberately describe unvalidated legacy rows. The generator writes every
    // validated v1 field explicitly, so new scaffold data can never look current by default.
    contentType: text("content_type").notNull().default("application/octet-stream"),
    width: integer("width"),
    height: integer("height"),
    specVersion: text("spec_version").notNull().default("legacy"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("asset_renditions_unique").on(t.assetId, t.variant),
    index("asset_renditions_current_spec_idx").on(t.assetId, t.specVersion),
  ],
);

/* ------------------------------------------------------------ QA state */

export const selections = sqliteTable(
  "selections",
  {
    id: id(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    selectedBy: text("selected_by")
      .notNull()
      .references(() => user.id),
    state: text("state", { enum: ["selected_for_editing"] }).notNull(),
    /** Manual bracketing by the editor — no auto-grouping (PRD §5). */
    bracketGroup: text("bracket_group"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("selections_asset_unique").on(t.assetId)],
);

/** Immutable selection/readiness snapshot and atomic ownership record for one AutoHDR send. */
export const autoHdrHandoffs = sqliteTable(
  "autohdr_handoffs",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").notNull().references(() => integrationConnections.id),
    generation: integer("generation").notNull(),
    manifestVersion: integer("manifest_version").notNull().default(1),
    selectionHash: text("selection_hash").notNull(),
    selectedAssetIdsJson: text("selected_asset_ids_json").notNull(),
    readinessUnitsJson: text("readiness_units_json").notNull(),
    frozenRawFolderPath: text("frozen_raw_folder_path").notNull(),
    initiatedBy: text("initiated_by").references(() => user.id),
    expectedOriginStage: text("expected_origin_stage").notNull().default("raw_review"),
    editingEntryBoardRevision: integer("editing_entry_board_revision"),
    state: text("state", { enum: ["starting", "started", "blocked", "retired", "failed"] }).notNull().default("starting"),
    workflowId: text("workflow_id").notNull().unique(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    stalledNotifiedAt: integer("stalled_notified_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("autohdr_handoffs_project_generation_unique").on(t.projectId, t.generation),
    uniqueIndex("autohdr_handoffs_active_project_unique").on(t.projectId)
      .where(sql`${t.state} in ('starting', 'started', 'blocked')`),
    index("autohdr_handoffs_connection_idx").on(t.connectionId),
  ],
);

/** Folder-scaffolding ownership for one Portal-managed `/AutoHDR/<folderName>` workspace. */
export const autohdrScaffoldClaims = sqliteTable(
  "autohdr_scaffold_claims",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").notNull().references(() => integrationConnections.id),
    scaffoldPath: text("scaffold_path").notNull(),
    scaffoldPathKey: text("scaffold_path_key").notNull(),
    state: text("state", { enum: ["active", "retired", "tombstone"] }).notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("autohdr_scaffold_claims_connection_path_key_unique").on(t.connectionId, t.scaffoldPathKey),
    uniqueIndex("autohdr_scaffold_claims_active_project_unique").on(t.projectId)
      .where(sql`${t.state} = 'active'`),
    index("autohdr_scaffold_claims_project_idx").on(t.projectId),
  ],
);

/** One handoff-owned mapping; candidate path ownership lives in the permanent claim table. */
export const autoHdrOutputMappings = sqliteTable(
  "autohdr_output_mappings",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    handoffId: text("handoff_id").notNull().references(() => autoHdrHandoffs.id, { onDelete: "cascade" }).unique(),
    connectionId: text("connection_id").notNull().references(() => integrationConnections.id),
    generation: integer("generation").notNull(),
    state: text("state", { enum: ["pending_discovery", "active", "blocked_collision", "retired"] }).notNull().default("pending_discovery"),
    finalPath: text("final_path"),
    finalPathKey: text("final_path_key"),
    folderId: text("folder_id"),
    diagnostic: text("diagnostic"),
    observedAt: integer("observed_at", { mode: "timestamp_ms" }),
    retiredAt: integer("retired_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("autohdr_output_mappings_project_generation_unique").on(t.projectId, t.generation),
    index("autohdr_output_mappings_connection_state_idx").on(t.connectionId, t.state),
  ],
);

/** Keeps a whole Dropbox manual-supplement batch from being retired mid-ingest. */
export const autoHdrManualIngestLeases = sqliteTable("autohdr_manual_ingest_leases", {
  mappingId: text("mapping_id")
    .primaryKey()
    .references(() => autoHdrOutputMappings.id, { onDelete: "cascade" }),
  ownerToken: text("owner_token").notNull(),
  leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Permanent connection-scoped ownership. Rows are tombstoned, never deleted on archive. */
export const autoHdrPathClaims = sqliteTable(
  "autohdr_path_claims",
  {
    id: id(),
    mappingId: text("mapping_id").notNull().references(() => autoHdrOutputMappings.id, { onDelete: "restrict" }),
    handoffId: text("handoff_id").notNull().references(() => autoHdrHandoffs.id, { onDelete: "restrict" }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    connectionId: text("connection_id").notNull().references(() => integrationConnections.id),
    candidate: text("candidate", { enum: ["final", "finals", "manual"] }).notNull(),
    path: text("path").notNull(),
    pathKey: text("path_key").notNull(),
    folderId: text("folder_id"),
    state: text("state", { enum: ["pending", "active", "blocked", "tombstone"] }).notNull().default("pending"),
    diagnostic: text("diagnostic"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("autohdr_path_claims_connection_path_unique").on(t.connectionId, t.pathKey),
    uniqueIndex("autohdr_path_claims_mapping_candidate_unique").on(t.mappingId, t.candidate),
    index("autohdr_path_claims_handoff_idx").on(t.handoffId),
  ],
);

/** Provenance for files a specific AutoHDR generation confirmed writing to Dropbox. */
export const autoHdrSentFiles = sqliteTable(
  "autohdr_sent_files",
  {
    id: id(),
    handoffId: text("handoff_id").notNull().references(() => autoHdrHandoffs.id, { onDelete: "cascade" }),
    assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    dropboxPath: text("dropbox_path").notNull(),
    dropboxPathKey: text("dropbox_path_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("autohdr_sent_files_handoff_asset_unique").on(t.handoffId, t.assetId),
    index("autohdr_sent_files_handoff_idx").on(t.handoffId),
  ],
);

/** Active workflow ownership is DB-backed; deterministic Workflow IDs are only a second fence. */
export const autoHdrFetchClaims = sqliteTable(
  "autohdr_fetch_claims",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    handoffId: text("handoff_id").notNull().references(() => autoHdrHandoffs.id, { onDelete: "cascade" }),
    mappingId: text("mapping_id").notNull().references(() => autoHdrOutputMappings.id, { onDelete: "cascade" }),
    mappingGeneration: integer("mapping_generation").notNull(),
    connectionId: text("connection_id").notNull().references(() => integrationConnections.id),
    workflowId: text("workflow_id").notNull().unique(),
    jobId: text("job_id").notNull().references(() => jobs.id),
    state: text("state", { enum: ["starting", "running", "done", "failed", "quarantined"] }).notNull().default("starting"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }).notNull(),
    trigger: text("trigger", { enum: ["manual", "dropbox_delta"] }).notNull(),
    triggerJson: text("trigger_json").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("autohdr_fetch_claims_active_unique").on(t.projectId, t.mappingGeneration)
      .where(sql`${t.state} in ('starting', 'running')`),
    index("autohdr_fetch_claims_mapping_idx").on(t.mappingId),
  ],
);

/** Per-project single-flight for overlapping webhook baselines, retries, and manual sync. */
export const rawReconciliationClaims = sqliteTable(
  "raw_reconciliation_claims",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    ownerJobId: text("owner_job_id").notNull().references(() => jobs.id),
    state: text("state", { enum: ["running", "done", "failed"] }).notNull().default("running"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }).notNull(),
    trigger: text("trigger").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("raw_reconciliation_claims_active_unique").on(t.projectId)
      .where(sql`${t.state} = 'running'`),
  ],
);

/** Provider/source identity reservation prevents overlapping intake paths from duplicating RAWs. */
export const assetIngestIdentities = sqliteTable(
  "asset_ingest_identities",
  {
    id: id(),
    collectionId: text("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
    identityKey: text("identity_key").notNull(),
    assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("asset_ingest_identities_collection_key_unique").on(t.collectionId, t.identityKey),
    uniqueIndex("asset_ingest_identities_asset_unique").on(t.assetId),
  ],
);

/** The authoritative current pointer makes source-key replacement ownership explicit. */
export const editedSourceClaims = sqliteTable(
  "edited_source_claims",
  {
    id: id(),
    collectionId: text("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
    sourcePathKey: text("source_path_key").notNull(),
    currentAssetId: text("current_asset_id").references(() => assets.id, { onDelete: "restrict" }),
    contentHash: text("content_hash"),
    handoffId: text("handoff_id").references(() => autoHdrHandoffs.id, { onDelete: "restrict" }),
    reservationToken: text("reservation_token"),
    updatedAt: updatedAt(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("edited_source_claims_collection_path_unique").on(t.collectionId, t.sourcePathKey),
    index("edited_source_claims_current_asset_idx").on(t.currentAssetId),
  ],
);

/** Explicit many-to-one returned-final coverage for bracket readiness units. */
export const autoHdrFinalAssociations = sqliteTable(
  "autohdr_final_associations",
  {
    id: id(),
    handoffId: text("handoff_id").notNull().references(() => autoHdrHandoffs.id, { onDelete: "cascade" }),
    assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    readinessUnitKey: text("readiness_unit_key").notNull(),
    matchKind: text("match_kind", { enum: ["exact", "suffix", "manual"] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("autohdr_final_associations_unique").on(t.handoffId, t.assetId, t.readinessUnitKey),
    index("autohdr_final_associations_unit_idx").on(t.handoffId, t.readinessUnitKey),
  ],
);

/** Scope health is persisted independently so one root cannot mask its sibling. */
export const dropboxMonitorHealth = sqliteTable(
  "dropbox_monitor_health",
  {
    id: id(),
    connectionId: text("connection_id").notNull().references(() => integrationConnections.id, { onDelete: "cascade" }),
    scope: text("scope", { enum: ["raw", "autohdr"] }).notNull(),
    root: text("root").notNull(),
    cursorFingerprint: text("cursor_fingerprint"),
    cursorUpdatedAt: integer("cursor_updated_at", { mode: "timestamp_ms" }),
    lastSuccessfulPageAt: integer("last_successful_page_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    resetCount: integer("reset_count").notNull().default(0),
    scannedCount: integer("scanned_count").notNull().default(0),
    matchedCount: integer("matched_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    routedProjectCount: integer("routed_project_count").notNull().default(0),
    durationMs: integer("duration_ms"),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("dropbox_monitor_health_scope_unique").on(t.connectionId, t.scope)],
);

/** Singular QA state per asset (ratings / labels / decisions / photographer recommend). */
export const assetReviewState = sqliteTable(
  "asset_review_state",
  {
    id: id(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" })
      .unique(),
    stars: integer("stars"),
    colorLabel: text("color_label", { enum: ["select", "maybe", "cut", "hero"] }),
    decision: text("decision", { enum: ["approved", "flagged"] }),
    recommended: integer("recommended", { mode: "boolean" }).notNull().default(false),
    updatedBy: text("updated_by").references(() => user.id),
    updatedAt: updatedAt(),
  },
);

export const annotations = sqliteTable(
  "annotations",
  {
    id: id(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id),
    authorRole: text("author_role", { enum: ["admin", "photographer", "editor", "external_editor"] }).notNull(),
    scope: text("scope", { enum: ["raw", "edited"] }).notNull(),
    /** Dense freehand vector JSON lives in R2 (D1 2 MB row cap) — ref only. */
    strokeR2Key: text("stroke_r2_key"),
    thumbnailR2Key: text("thumbnail_r2_key"),
    noteText: text("note_text"),
    createdAt: createdAt(),
    editedAt: integer("edited_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("annotations_asset_idx").on(t.assetId)],
);

export const noticeBoardPosts = sqliteTable(
  "notice_board_posts",
  {
    id: id(),
    authorId: text("author_id").notNull().references(() => user.id),
    body: text("body").notNull(),
    contentJson: text("content_json"),
    createdAt: createdAt(),
    editedAt: integer("edited_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("notice_board_posts_created_idx").on(t.createdAt)],
);

export const noticeBoardPostMentions = sqliteTable(
  "notice_board_post_mentions",
  {
    id: id(),
    postId: text("post_id").notNull().references(() => noticeBoardPosts.id, { onDelete: "cascade" }),
    mentionedUserId: text("mentioned_user_id").notNull().references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("notice_board_post_mentions_unique").on(t.postId, t.mentionedUserId)],
);

/* ------------------------------------------------------ publish & links */

export const publishes = sqliteTable(
  "publishes",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    publishVersion: integer("publish_version").notNull(),
    publishedBy: text("published_by")
      .notNull()
      .references(() => user.id),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("publishes_project_version_idx").on(t.projectId, t.publishVersion)],
);

export const clientLinks = sqliteTable(
  "client_links",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Token hashed at rest; 30-day default expiry (D-04). */
    tokenHash: text("token_hash").notNull().unique(),
    publishVersion: integer("publish_version").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    passcodeHash: text("passcode_hash"),
    revoked: integer("revoked", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("client_links_project_idx").on(t.projectId)],
);

export const premiumUnlocks = sqliteTable("premium_unlocks", {
  id: id(),
  clientLinkId: text("client_link_id")
    .notNull()
    .references(() => clientLinks.id, { onDelete: "cascade" }),
  scope: text("scope", { enum: ["asset", "all"] }).notNull(),
  assetId: text("asset_id").references(() => assets.id),
  unlockedAt: integer("unlocked_at", { mode: "timestamp_ms" }).notNull(),
  paymentRef: text("payment_ref"),
});

/* --------------------------------------------------------------- infra */

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: id(),
    source: text("source", { enum: ["tonomo", "dropbox"] }).notNull(),
    eventId: text("event_id").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status", { enum: ["received", "processed", "poison"] })
      .notNull()
      .default("received"),
    error: text("error"),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
  },
  (t) => [uniqueIndex("webhook_events_dedupe").on(t.source, t.eventId)],
);

/** One row per message the rendition consumer's DLQ actually received (append-only; a replay
 * that fails again produces a fresh row rather than mutating this one). */
export const renditionDlqEvents = sqliteTable(
  "rendition_dlq_events",
  {
    id: id(),
    assetId: text("asset_id").notNull(),
    status: text("status", { enum: ["open", "replayed", "discarded"] })
      .notNull()
      .default("open"),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("rendition_dlq_events_asset_idx").on(t.assetId),
    // Matches the admin list route's actual access pattern: filter by status, order by receivedAt.
    index("rendition_dlq_events_status_received_idx").on(t.status, t.receivedAt),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: id(),
    kind: text("kind").notNull(),
    status: text("status", { enum: ["queued", "running", "done", "failed", "stuck"] })
      .notNull()
      .default("queued"),
    correlationId: text("correlation_id"),
    projectId: text("project_id").references(() => projects.id),
    stageEntryBoardRevision: integer("stage_entry_board_revision"),
    payloadJson: text("payload_json"),
    retries: integer("retries").notNull().default(0),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_status_idx").on(t.status),
    index("jobs_correlation_idx").on(t.correlationId),
    uniqueIndex("jobs_manual_upload_publish_active_unique")
      .on(t.correlationId)
      .where(sql`${t.kind} in ('manual_edited_publish', 'manual_raw_publish') and ${t.status} in ('queued', 'running')`),
  ],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: id(),
    actorId: text("actor_id").references(() => user.id),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    metaJson: text("meta_json"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_actor_idx").on(t.actorId), index("audit_target_idx").on(t.targetType, t.targetId)],
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    readAt: integer("read_at", { mode: "timestamp_ms" }),
    emailSentAt: integer("email_sent_at", { mode: "timestamp_ms" }),
    emailError: text("email_error"),
    emailMessageId: text("email_message_id"),
    sourceKey: text("source_key"),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_user_unread_idx").on(t.userId, t.readAt, t.createdAt),
    uniqueIndex("notifications_source_key_unique")
      .on(t.type, t.sourceKey, t.userId)
      .where(sql`${t.sourceKey} IS NOT NULL`),
  ],
);

export const notificationOutbox = sqliteTable(
  "notification_outbox",
  {
    id: id(),
    schemaVersion: integer("schema_version").notNull(),
    eventType: text("event_type").notNull(),
    sourceKey: text("source_key").notNull(),
    projectId: text("project_id").notNull(),
    actorId: text("actor_id").notNull(),
    recipientId: text("recipient_id").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status", { enum: ["pending", "queued", "processing", "completed", "suppressed", "failed", "dlq", "discarded"] as const }).notNull().default("pending"),
    availableAt: integer("available_at").notNull(),
    queuePublishedAt: integer("queue_published_at"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: integer("lease_expires_at"),
    publishAttempts: integer("publish_attempts").notNull().default(0),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    lastError: text("last_error"),
    completedAt: integer("completed_at"),
    coalesceKey: text("coalesce_key"),
    coalesceUntil: integer("coalesce_until"),
    recipientMembershipCycleId: text("recipient_membership_cycle_id"),
    // Nullable so pre-TB4E outbox rows fail closed until a producer stamps the
    // recipient's authorization epoch.
    recipientAuthorizationEpoch: integer("recipient_authorization_epoch"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("notification_outbox_status_available_idx").on(t.status, t.availableAt, t.createdAt, t.id),
    index("notification_outbox_status_lease_idx").on(t.status, t.leaseExpiresAt),
    index("notification_outbox_status_queue_idx").on(t.status, t.queuePublishedAt),
    index("notification_outbox_status_updated_idx").on(t.status, t.updatedAt, t.id),
    index("notification_outbox_project_event_status_idx").on(t.projectId, t.eventType, t.status, t.sourceKey),
    index("notification_outbox_coalesce_idx").on(t.eventType, t.recipientId, t.recipientMembershipCycleId, t.coalesceKey, t.coalesceUntil),
    unique("notification_outbox_event_source_recipient_unique").on(t.eventType, t.sourceKey, t.recipientId),
    check("notification_outbox_status_check", sql`${t.status} IN ('pending', 'queued', 'processing', 'completed', 'suppressed', 'failed', 'dlq', 'discarded')`),
    check("notification_outbox_publish_attempts_check", sql`${t.publishAttempts} >= 0`),
    check("notification_outbox_delivery_attempts_check", sql`${t.deliveryAttempts} >= 0`),
    check("notification_outbox_lease_check", sql`(${t.status} = 'processing' AND ${t.leaseToken} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL) OR (${t.status} != 'processing' AND ${t.leaseToken} IS NULL AND ${t.leaseExpiresAt} IS NULL)`),
  ],
);

export const notificationDeliveryLedger = sqliteTable(
  "notification_delivery_ledger",
  {
    id: id(),
    outboxId: text("outbox_id").notNull().references(() => notificationOutbox.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    sourceKey: text("source_key").notNull(),
    recipientId: text("recipient_id").notNull(),
    channel: text("channel", { enum: ["in_app", "email"] as const }).notNull(),
    status: text("status", { enum: ["pending", "processing", "sent", "suppressed", "failed", "unknown", "discarded"] as const }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    notificationId: text("notification_id").references(() => notifications.id, { onDelete: "set null" }),
    emailMessageId: text("email_message_id"),
    lastErrorCode: text("last_error_code"),
    lastError: text("last_error"),
    lastAttemptAt: integer("last_attempt_at"),
    deliveredAt: integer("delivered_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("notification_delivery_ledger_outbox_idx").on(t.outboxId, t.channel),
    index("notification_delivery_ledger_status_updated_idx").on(t.status, t.updatedAt, t.id),
    index("notification_delivery_ledger_notification_idx").on(t.notificationId),
    unique("notification_delivery_ledger_outbox_channel_unique").on(t.outboxId, t.channel),
    unique("notification_delivery_ledger_event_source_recipient_channel_unique").on(t.eventType, t.sourceKey, t.recipientId, t.channel),
    check("notification_delivery_ledger_channel_check", sql`${t.channel} IN ('in_app', 'email')`),
    check("notification_delivery_ledger_status_check", sql`${t.status} IN ('pending', 'processing', 'sent', 'suppressed', 'failed', 'unknown', 'discarded')`),
    check("notification_delivery_ledger_attempts_check", sql`${t.attempts} >= 0`),
  ],
);

/** Opaque same-origin multipart sessions for External Editor edited uploads. */
export const externalEditedUploadSessions = sqliteTable(
  "external_edited_upload_sessions",
  {
    id: id(),
    tokenHash: text("token_hash").notNull(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    collectionId: text("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
    assetId: text("asset_id").notNull(),
    createdBy: text("created_by").notNull().references(() => user.id),
    membershipCycleId: text("membership_cycle_id").notNull(),
    authorizationEpoch: integer("authorization_epoch").notNull(),
    originalFilename: text("original_filename").notNull(),
    bytes: integer("bytes").notNull(),
    r2Key: text("r2_key").notNull(),
    r2UploadId: text("r2_upload_id").notNull(),
    partBytes: integer("part_bytes").notNull(),
    partCount: integer("part_count").notNull(),
    status: text("status", { enum: ["open", "completing", "completed", "aborting", "aborted", "expired"] as const }).notNull().default("open"),
    completionLeaseToken: text("completion_lease_token"),
    completionLeaseExpiresAt: integer("completion_lease_expires_at"),
    expiresAt: integer("expires_at").notNull(),
    completedAt: integer("completed_at"),
    terminalAt: integer("terminal_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("external_edited_upload_sessions_token_hash_idx").on(t.tokenHash),
    index("external_edited_upload_sessions_principal_status_idx").on(t.createdBy, t.status, t.expiresAt),
    index("external_edited_upload_sessions_sweep_idx").on(t.status, t.expiresAt, t.completionLeaseExpiresAt, t.id),
    check("external_edited_upload_sessions_bytes_check", sql`${t.bytes} > 0 AND ${t.bytes} <= 5368709120`),
    check("external_edited_upload_sessions_part_bytes_check", sql`${t.partBytes} > 0`),
    check("external_edited_upload_sessions_part_count_check", sql`${t.partCount} > 0`),
    check("external_edited_upload_sessions_authorization_epoch_check", sql`${t.authorizationEpoch} >= 0`),
    check("external_edited_upload_sessions_status_check", sql`${t.status} IN ('open','completing','completed','aborting','aborted','expired')`),
    check("external_edited_upload_sessions_completion_lease_check", sql`(${t.status} = 'completing' AND ${t.completionLeaseToken} IS NOT NULL AND ${t.completionLeaseExpiresAt} IS NOT NULL) OR (${t.status} != 'completing' AND ${t.completionLeaseToken} IS NULL AND ${t.completionLeaseExpiresAt} IS NULL)`),
    check("external_edited_upload_sessions_terminal_check", sql`(${t.status} = 'completed' AND ${t.completedAt} IS NOT NULL AND ${t.terminalAt} IS NOT NULL) OR (${t.status} IN ('aborted','expired') AND ${t.completedAt} IS NULL AND ${t.terminalAt} IS NOT NULL) OR (${t.status} IN ('open','completing','aborting') AND ${t.completedAt} IS NULL AND ${t.terminalAt} IS NULL)`),
  ],
);

export const externalEditedUploadParts = sqliteTable(
  "external_edited_upload_parts",
  {
    sessionId: text("session_id").notNull().references(() => externalEditedUploadSessions.id, { onDelete: "cascade" }),
    partNumber: integer("part_number").notNull(),
    expectedBytes: integer("expected_bytes").notNull(),
    receivedBytes: integer("received_bytes"),
    etag: text("etag"),
    status: text("status", { enum: ["pending", "uploading", "uploaded"] as const }).notNull().default("pending"),
    uploadLeaseToken: text("upload_lease_token"),
    uploadLeaseExpiresAt: integer("upload_lease_expires_at"),
    uploadedAt: integer("uploaded_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.partNumber] }),
    check("external_edited_upload_parts_number_check", sql`${t.partNumber} > 0`),
    check("external_edited_upload_parts_expected_bytes_check", sql`${t.expectedBytes} > 0`),
    check("external_edited_upload_parts_lease_check", sql`(${t.status} = 'uploading' AND ${t.uploadLeaseToken} IS NOT NULL AND ${t.uploadLeaseExpiresAt} IS NOT NULL) OR (${t.status} != 'uploading' AND ${t.uploadLeaseToken} IS NULL AND ${t.uploadLeaseExpiresAt} IS NULL)`),
    check("external_edited_upload_parts_uploaded_check", sql`(${t.status} = 'uploaded' AND ${t.receivedBytes} = ${t.expectedBytes} AND ${t.etag} IS NOT NULL AND ${t.uploadedAt} IS NOT NULL) OR (${t.status} != 'uploaded' AND ${t.etag} IS NULL AND ${t.uploadedAt} IS NULL)`),
    check("external_edited_upload_parts_status_check", sql`${t.status} IN ('pending','uploading','uploaded')`),
  ],
);
