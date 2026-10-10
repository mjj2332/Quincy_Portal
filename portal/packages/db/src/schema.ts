/**
 * Quincy Portal — D1 schema v1 (Implementation-Plan §5).
 * Metadata only: media bytes live in R2; dense annotation JSON lives in R2 (ref here).
 * All media rows use immutable, versioned R2 keys.
 */
import { sqliteTable, text, integer, real, index, unique, uniqueIndex, check, primaryKey, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { desc, sql } from "drizzle-orm";

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
  // #135: added as an editor on every Project created while set (and while active + editor-eligible).
  defaultEditor: integer("default_editor", { mode: "boolean" }).notNull().default(false),
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
    /** Latest Edited-media arrival (epoch ms) awaiting the 15-minute quiet-period move to Edited review; NULL when none is pending. */
    editedArrivedAt: integer("edited_arrived_at"),
    /** Failed move attempts for the pending arrival, and when the pass may try again (backoff). Reset by every new arrival. */
    editedArrivalAttempts: integer("edited_arrival_attempts").notNull().default(0),
    editedArrivalRetryAt: integer("edited_arrival_retry_at"),
    archivedBy: text("archived_by").references(() => user.id),
    deadlineLocalCivil: text("deadline_local_civil"),
    deadlineZone: text("deadline_zone", { enum: ["Australia/Sydney"] }),
    deadlineUtcOffsetMinutes: integer("deadline_utc_offset_minutes"),
    deadlineFold: integer("deadline_fold"),
    deadlineAt: integer("deadline_at"),
    deadlineReminderOffsetsJson: text("deadline_reminder_offsets_json"),
    deadlineVersion: integer("deadline_version").notNull().default(0),
    deadlineSource: text("deadline_source", { enum: ["automatic", "manual", "none"] as const }).notNull().default("none"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("projects_stage_idx").on(t.stageKey),
    index("projects_order_idx").on(t.orderId),
    index("projects_archived_idx").on(t.archivedAt),
    index("projects_edited_arrival_pending_idx").on(t.editedArrivedAt).where(sql`${t.editedArrivedAt} IS NOT NULL`),
    check("projects_edited_arrived_at_check", sql`${t.editedArrivedAt} IS NULL OR typeof(${t.editedArrivedAt}) = 'integer'`),
    check("projects_board_revision_check", sql`typeof(${t.boardRevision}) = 'integer' AND ${t.boardRevision} >= 0 AND ${t.boardRevision} <= 9007199254740991`),
    check("projects_priority_check", sql`${t.priority} IS NULL OR (typeof(${t.priority}) = 'integer' AND ${t.priority} >= 1 AND ${t.priority} <= 5)`),
    check("projects_deadline_zone_check", sql`${t.deadlineZone} IS NULL OR ${t.deadlineZone} = 'Australia/Sydney'`),
    check("projects_deadline_utc_offset_check", sql`${t.deadlineUtcOffsetMinutes} IS NULL OR (typeof(${t.deadlineUtcOffsetMinutes}) = 'integer' AND ${t.deadlineUtcOffsetMinutes} BETWEEN -840 AND 840)`),
    check("projects_deadline_fold_check", sql`${t.deadlineFold} IS NULL OR ${t.deadlineFold} IN (0, 1)`),
    check("projects_deadline_at_check", sql`${t.deadlineAt} IS NULL OR typeof(${t.deadlineAt}) = 'integer'`),
    check("projects_deadline_reminder_offsets_check", sql`${t.deadlineReminderOffsetsJson} IS NULL OR json_valid(${t.deadlineReminderOffsetsJson})`),
    check("projects_deadline_version_check", sql`typeof(${t.deadlineVersion}) = 'integer' AND ${t.deadlineVersion} >= 0`),
    check("projects_deadline_source_check", sql`${t.deadlineSource} IN ('automatic', 'manual', 'none')`),
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
    /** Migration 0053 (#424). Read with COALESCE(..., 1): an old Worker's upsert omits the column. */
    subtaskReminderEmails: integer("subtask_reminder_emails").notNull().default(1),
    /** Migration 0056 (#489). How often non-exempt notification emails are gathered into one Email digest. Read with COALESCE(..., 'twice_daily'): a user with no row has the default. */
    emailDigestCadence: text("email_digest_cadence", { enum: ["immediate", "hourly", "twice_daily", "daily"] as const }).notNull().default("twice_daily"),
    /** Migration 0058 (#490). 1 = Project activity (stage changes, collaboration activity) is gathered into the person's Email digest; 0 = it is not. Read with COALESCE(..., 1): a user with no row, or an old Worker's upsert, is on. */
    includeProjectActivity: integer("include_project_activity").notNull().default(1),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check("notification_preferences_email_check", sql`${t.projectDeadlineReminderEmails} IN (0, 1)`),
    check("notification_preferences_subtask_reminder_emails_check", sql`${t.subtaskReminderEmails} IN (0, 1)`),
    check("notification_preferences_email_digest_cadence_check", sql`${t.emailDigestCadence} IN ('immediate', 'hourly', 'twice_daily', 'daily')`),
    check("notification_preferences_include_project_activity_check", sql`${t.includeProjectActivity} IN (0, 1)`),
  ],
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
    /** The MCP client that acted, copied from the gating audit row; NULL for a browser action (#704). */
    viaClient: text("via_client"),
  },
  (t) => [
    index("project_activity_events_project_occurred_idx").on(t.projectId, desc(t.occurredAt), desc(t.id)),
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

/**
 * Embedded media (#493): an image or video placed inside a post. `ownerKind` / `ownerId` name what holds
 * it. `ownerId` is polymorphic and has no foreign key, so a post and its media move together inside one
 * batch in application code (no triggers). `projectId` cascades: a Project hard delete purges the objects
 * by prefix first, then the rows go with it.
 */
export const embeddedMedia = sqliteTable(
  "embedded_media",
  {
    id: id(),
    ownerKind: text("owner_kind", { enum: ["project_comment", "notice_post", "whiteboard"] as const }).notNull(),
    ownerId: text("owner_id"),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    uploaderId: text("uploader_id").notNull().references(() => user.id),
    kind: text("kind", { enum: ["image", "video", "preview_image"] as const }).notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    originalKey: text("original_key").notNull(),
    displayKey: text("display_key"),
    posterKey: text("poster_key"),
    uploadId: text("upload_id"),
    state: text("state", { enum: ["uploading", "pending", "attached", "detached"] as const }).notNull().default("uploading"),
    detachedAt: integer("detached_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    // HEIC display copy (#495, migration 0063): a JPEG written into `displayKey` by the background Worker. Every other upload stays `not_required`.
    renditionStatus: text("rendition_status", { enum: ["not_required", "pending", "ready", "failed"] as const }).notNull().default("not_required"),
    displayContentType: text("display_content_type"),
    displayBytes: integer("display_bytes"),
    displayWidth: integer("display_width"),
    displayHeight: integer("display_height"),
    // The image's pixel size as the uploading browser measured it (#611, migration 0065). Null for older rows, videos and HEIC (whose size is `displayWidth`/`displayHeight`).
    width: integer("width"),
    height: integer("height"),
    renditionAttempts: integer("rendition_attempts").notNull().default(0),
    renditionLeaseUntil: integer("rendition_lease_until"),
    renditionRequestedAt: integer("rendition_requested_at"),
    renditionResentAt: integer("rendition_resent_at"),
    renditionError: text("rendition_error"),
  },
  (t) => [
    uniqueIndex("embedded_media_original_key_unique").on(t.originalKey),
    index("embedded_media_owner_idx").on(t.ownerKind, t.ownerId),
    index("embedded_media_state_detached_idx").on(t.state, t.detachedAt),
    index("embedded_media_state_created_idx").on(t.state, t.createdAt),
    index("embedded_media_project_idx").on(t.projectId),
    index("embedded_media_rendition_idx").on(t.renditionStatus, t.renditionRequestedAt),
    check("embedded_media_rendition_status_check", sql`${t.renditionStatus} IN ('not_required','pending','ready','failed')`),
    check("embedded_media_owner_kind_check", sql`${t.ownerKind} IN ('project_comment','notice_post','whiteboard')`),
    check("embedded_media_kind_check", sql`${t.kind} IN ('image','video','preview_image')`),
    check("embedded_media_bytes_check", sql`${t.bytes} > 0`),
    check("embedded_media_state_check", sql`${t.state} IN ('uploading','pending','attached','detached')`),
    check("embedded_media_owner_state_check", sql`(${t.state} IN ('uploading','pending')) = (${t.ownerId} IS NULL)`),
    check("embedded_media_detached_check", sql`(${t.state} = 'detached') = (${t.detachedAt} IS NOT NULL)`),
    check("embedded_media_project_check", sql`(${t.ownerKind} = 'notice_post') = (${t.projectId} IS NULL)`),
  ],
);

/**
 * Link previews (#497): the card a post shows for a link. A post stores only `previewId`, and the server fills the rest in when it
 * serves the post. `ownerId` is NULL while the preview is pending and polymorphic once owned, so a post and its previews move
 * together inside one batch in application code. `projectId` cascades. `imageMediaId` is the `preview_image` row, cleared when it goes.
 * `requesterId` is who asked for the fetch: the per-person hourly limit is counted from these rows.
 */
export const linkPreviews = sqliteTable(
  "link_previews",
  {
    id: id(),
    ownerKind: text("owner_kind", { enum: ["project_comment", "notice_post"] as const }).notNull(),
    ownerId: text("owner_id"),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    requesterId: text("requester_id").notNull().references(() => user.id),
    url: text("url").notNull(),
    title: text("title"),
    description: text("description"),
    siteName: text("site_name"),
    imageMediaId: text("image_media_id").references(() => embeddedMedia.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("link_previews_owner_idx").on(t.ownerKind, t.ownerId),
    index("link_previews_requester_created_idx").on(t.requesterId, t.createdAt),
    index("link_previews_pending_idx").on(t.createdAt).where(sql`${t.ownerId} IS NULL`),
    index("link_previews_project_idx").on(t.projectId),
    index("link_previews_image_idx").on(t.imageMediaId),
    check("link_previews_owner_kind_check", sql`${t.ownerKind} IN ('project_comment','notice_post')`),
    check("link_previews_project_check", sql`(${t.ownerKind} = 'notice_post') = (${t.projectId} IS NULL)`),
  ],
);

/**
 * Every fetch the server starts for a link preview (#497), kept whether or not it made a card and never removed when a card goes: the
 * per-person limit of 30 an hour is counted here, in one INSERT that writes nothing at the limit. The partial unique index lets one fetch
 * per person, place and address be in flight at a time. `contextId` is a Project id or `notice_board`. Swept after a day.
 */
export const linkPreviewAttempts = sqliteTable(
  "link_preview_attempts",
  {
    id: id(),
    requesterId: text("requester_id").notNull().references(() => user.id),
    ownerKind: text("owner_kind", { enum: ["project_comment", "notice_post"] as const }).notNull(),
    contextId: text("context_id").notNull(),
    url: text("url").notNull(),
    status: text("status", { enum: ["fetching", "done", "failed"] as const }).notNull(),
    previewId: text("preview_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("link_preview_attempts_requester_created_idx").on(t.requesterId, t.createdAt),
    index("link_preview_attempts_created_idx").on(t.createdAt),
    uniqueIndex("link_preview_attempts_in_flight_idx").on(t.requesterId, t.ownerKind, t.contextId, t.url).where(sql`${t.status} = 'fetching'`),
    check("link_preview_attempts_owner_kind_check", sql`${t.ownerKind} IN ('project_comment','notice_post')`),
    check("link_preview_attempts_status_check", sql`${t.status} IN ('fetching','done','failed')`),
  ],
);

/**
 * Durable cleanup queue for embedded-media R2 objects and multipart uploads that no `embedded_media` row owns
 * any more (#493). `projectId` deliberately has no foreign key: the Project is usually already gone. A row
 * leaves only after its object is deleted (and its multipart upload is terminal).
 */
export const embeddedMediaCleanup = sqliteTable(
  "embedded_media_cleanup",
  {
    storageKey: text("storage_key").primaryKey(),
    uploadId: text("upload_id"),
    projectId: text("project_id"),
    queuedAt: integer("queued_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    /** The sweep's lease on this entry (epoch ms): set when it claims the entry, cleared on failure and on every re-queue, and the entry is deleted only on success. NULL = unclaimed. */
    claimedUntil: integer("claimed_until"),
  },
  (t) => [index("embedded_media_cleanup_queued_idx").on(t.queuedAt)],
);

/**
 * Project whiteboard versions (#500): the index of immutable snapshots of a Project's whiteboard. The scene lives in the
 * Project's Durable Object and each snapshot's bytes in R2 at `r2Key`, so this is metadata only, and a row is written only
 * after its object exists. `ordinal` is the Project's own monotonic counter. `state` is `pruning` while an object beyond the
 * newest 30 is being deleted. `projectId` cascades (the objects are purged by prefix first); `createdBy` clears if the user goes.
 */
export const projectWhiteboardVersions = sqliteTable(
  "project_whiteboard_versions",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    r2Key: text("r2_key").notNull(),
    ordinal: integer("ordinal").notNull(),
    generation: integer("generation").notNull(),
    sceneRevision: integer("scene_revision").notNull(),
    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    reason: text("reason", { enum: ["interval", "last_leave", "pre_restore"] as const }).notNull(),
    sceneSha256: text("scene_sha256").notNull(),
    byteCount: integer("byte_count").notNull(),
    elementCount: integer("element_count").notNull(),
    state: text("state", { enum: ["ready", "pruning"] as const }).notNull().default("ready"),
    /** #501: JSON array of the embedded media ids the snapshot references (written in the same INSERT as the row). */
    mediaIds: text("media_ids").notNull().default("[]"),
  },
  (t) => [
    uniqueIndex("project_whiteboard_versions_r2_key_unique").on(t.r2Key),
    uniqueIndex("project_whiteboard_versions_project_ordinal_unique").on(t.projectId, t.ordinal),
    index("project_whiteboard_versions_project_state_ordinal_idx").on(t.projectId, t.state, desc(t.ordinal)),
    check("project_whiteboard_versions_ordinal_check", sql`typeof(${t.ordinal}) = 'integer' AND ${t.ordinal} >= 0`),
    check("project_whiteboard_versions_generation_check", sql`typeof(${t.generation}) = 'integer' AND ${t.generation} >= 0`),
    check("project_whiteboard_versions_scene_revision_check", sql`typeof(${t.sceneRevision}) = 'integer' AND ${t.sceneRevision} >= 0`),
    check("project_whiteboard_versions_created_at_check", sql`typeof(${t.createdAt}) = 'integer' AND ${t.createdAt} >= 0`),
    check("project_whiteboard_versions_reason_check", sql`${t.reason} IN ('interval','last_leave','pre_restore')`),
    check("project_whiteboard_versions_byte_count_check", sql`typeof(${t.byteCount}) = 'integer' AND ${t.byteCount} >= 0`),
    check("project_whiteboard_versions_element_count_check", sql`typeof(${t.elementCount}) = 'integer' AND ${t.elementCount} >= 0`),
    check("project_whiteboard_versions_state_check", sql`${t.state} IN ('ready','pruning')`),
    check("project_whiteboard_versions_media_ids_check", sql`json_valid(${t.mediaIds}) AND json_type(${t.mediaIds}) = 'array'`),
  ],
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
    /** Constant marker (always 1, never read or written by the app) that carries the migration 0047 range CHECK below.
     * Any migration that drops a schedule column or `due_date` must drop this column first. */
    scheduleRangeRequired: integer("schedule_range_required").notNull().default(1),
    /** Constant marker (always 1, never read or written by the app) that carries the migration 0052 timed-only CHECK below (ADR 0016).
     * Any migration that drops a schedule kind column must drop this column first. */
    scheduleTimedRequired: integer("schedule_timed_required").notNull().default(1),
    /** Advance reminder offsets in minutes before due (migration 0053, #424). "Due now" is implied and never stored. */
    reminderOffsetsJson: text("reminder_offsets_json").notNull().default("[1440]"),
    createdBy: text("created_by").notNull().references(() => user.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("project_subtasks_project_position_idx").on(t.projectId, t.position, t.id),
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
    // Mirrors migration 0047 and scripts/subtask-range-backfill-verify.sql: every Subtask is a structurally complete range (ADR 0011).
    check("project_subtasks_schedule_range_required_check", sql`${t.scheduleRangeRequired} = 1 AND COALESCE((
      ${t.scheduleVersion} >= 1
      AND ${t.scheduleZone} IS 'Australia/Sydney'
      AND ${t.scheduleStartKind} IS NOT NULL
      AND ${t.scheduleStartKind} IS ${t.scheduleEndKind}
      AND ${t.scheduleStartCivil} IS NOT NULL
      AND ${t.dueDate} IS NOT NULL
      AND (
        (${t.scheduleStartKind} = 'date'
          AND ${t.scheduleStartAt} IS NULL AND ${t.scheduleStartUtcOffsetMinutes} IS NULL AND ${t.scheduleStartFold} IS NULL
          AND ${t.scheduleEndAt} IS NULL AND ${t.scheduleEndUtcOffsetMinutes} IS NULL AND ${t.scheduleEndFold} IS NULL
          AND ${t.scheduleStartCivil} <= ${t.dueDate})
        OR
        (${t.scheduleStartKind} = 'timed'
          AND ${t.scheduleStartAt} IS NOT NULL AND ${t.scheduleStartUtcOffsetMinutes} IS NOT NULL AND ${t.scheduleStartFold} IS NOT NULL
          AND ${t.scheduleEndAt} IS NOT NULL AND ${t.scheduleEndUtcOffsetMinutes} IS NOT NULL AND ${t.scheduleEndFold} IS NOT NULL
          AND ${t.scheduleStartAt} < ${t.scheduleEndAt})
      )
    ), 0) = 1`),
    // Mirrors migration 0052: every Subtask end is a moment, so both endpoint kinds are the constant 'timed' (ADR 0016).
    check("project_subtasks_schedule_timed_required_check", sql`${t.scheduleTimedRequired} = 1 AND COALESCE((${t.scheduleStartKind} IS 'timed' AND ${t.scheduleEndKind} IS 'timed'), 0) = 1`),
    // Mirrors migration 0053: the offsets are always a JSON array.
    check("project_subtasks_reminder_offsets_check", sql`CASE WHEN json_valid(${t.reminderOffsetsJson}) THEN json_type(${t.reminderOffsetsJson}) = 'array' ELSE 0 END`),
  ],
);

/** Scheduled Subtask reminders (migration 0053, #424), mirroring `projectDeadlineOccurrences`. `createdBy` is NULL for system and migration rows. */
export const projectSubtaskReminderOccurrences = sqliteTable(
  "project_subtask_reminder_occurrences",
  {
    id: id(),
    subtaskId: text("subtask_id").notNull().references(() => projectSubtasks.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    /** The Subtask `schedule_version` this occurrence was generated for. */
    scheduleVersion: integer("schedule_version").notNull(),
    kind: text("kind", { enum: ["advance", "due_now"] as const }).notNull(),
    reminderOffsetMinutes: integer("reminder_offset_minutes").notNull(),
    fireAt: integer("fire_at").notNull(),
    dueAt: integer("due_at").notNull(),
    dueLocalCivil: text("due_local_civil").notNull(),
    dueZone: text("due_zone", { enum: ["Australia/Sydney"] as const }).notNull(),
    dueUtcOffsetMinutes: integer("due_utc_offset_minutes").notNull(),
    dueFold: integer("due_fold").notNull(),
    status: text("status", { enum: ["pending", "fired", "superseded"] as const }).notNull(),
    terminalReason: text("terminal_reason", { enum: ["schedule_replaced", "reminders_changed", "subtask_completed", "project_archived", "due_elapsed", "legacy_due_today_sent"] as const }),
    firedAt: integer("fired_at"),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("project_subtask_reminder_occurrences_due_idx").on(t.status, t.fireAt, t.id),
    index("project_subtask_reminder_occurrences_subtask_idx").on(t.subtaskId, t.status),
    index("project_subtask_reminder_occurrences_project_idx").on(t.projectId, t.status),
    uniqueIndex("project_subtask_reminder_occurrences_live_unique").on(t.subtaskId, t.scheduleVersion, t.kind, t.reminderOffsetMinutes).where(sql`${t.status} IN ('pending', 'fired')`),
    check("project_subtask_reminder_occurrences_schedule_version_check", sql`typeof(${t.scheduleVersion}) = 'integer' AND ${t.scheduleVersion} >= 1`),
    check("project_subtask_reminder_occurrences_kind_check", sql`(${t.kind} = 'due_now' AND ${t.reminderOffsetMinutes} = 0) OR (${t.kind} = 'advance' AND ${t.reminderOffsetMinutes} BETWEEN 1 AND 43200)`),
    check("project_subtask_reminder_occurrences_offset_check", sql`typeof(${t.reminderOffsetMinutes}) = 'integer' AND ${t.reminderOffsetMinutes} BETWEEN 0 AND 43200`),
    check("project_subtask_reminder_occurrences_zone_check", sql`${t.dueZone} = 'Australia/Sydney'`),
    check("project_subtask_reminder_occurrences_fold_check", sql`${t.dueFold} IN (0, 1)`),
    check("project_subtask_reminder_occurrences_fire_at_check", sql`${t.fireAt} = ${t.dueAt} - (${t.reminderOffsetMinutes} * 60000)`),
    check("project_subtask_reminder_occurrences_terminal_check", sql`(${t.status} = 'pending' AND ${t.terminalReason} IS NULL AND ${t.firedAt} IS NULL) OR (${t.status} = 'fired' AND ${t.terminalReason} IS NULL AND ${t.firedAt} IS NOT NULL) OR (${t.status} = 'superseded' AND ${t.terminalReason} IS NOT NULL AND ${t.firedAt} IS NULL)`),
  ],
);

/** One row per Subtask assignee (#364). `assignmentVersion` is the Subtask's version when this person was added. */
export const projectSubtaskAssignees = sqliteTable("project_subtask_assignees", {
  subtaskId: text("subtask_id").notNull().references(() => projectSubtasks.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  assignmentVersion: integer("assignment_version").notNull(),
  addedAt: integer("added_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.subtaskId, t.userId] }),
  index("project_subtask_assignees_user_idx").on(t.userId, t.subtaskId),
  check("project_subtask_assignees_version_check", sql`typeof(${t.assignmentVersion}) = 'integer' AND ${t.assignmentVersion} >= 0`),
]);

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
    check("autohdr_handoffs_editing_entry_board_revision_check", sql`${t.editingEntryBoardRevision} IS NULL OR (typeof(${t.editingEntryBoardRevision}) = 'integer' AND ${t.editingEntryBoardRevision} >= 0 AND ${t.editingEntryBoardRevision} <= 9007199254740991)`),
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
    scope: text("scope", { enum: ["raw", "autohdr", "editor"] }).notNull(),
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

/**
 * Stable ownership and Dropbox subtree mapping for the Portal-owned Editor workspace.
 *
 * `projects.rawFolderPath` deliberately remains the Tonomo/AutoHDR identity.  The placement
 * date below is the date used when this mapping was first reserved; it must not be rewritten
 * when a project is subsequently rescheduled.  Input/output roots are JSON because the existing
 * September folders contain explicit legacy layouts (for example `Day/Input` and `Dusk/Input`)
 * that cannot safely be inferred from a path convention.
 */
export const editorFolderMappings = sqliteTable(
  "editor_folder_mappings",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").notNull().references(() => integrationConnections.id),
    rootPath: text("root_path").notNull(),
    rootPathKey: text("root_path_key").notNull(),
    rootFolderId: text("root_folder_id"),
    /** The civil date the CURRENT root is placed for: first reservation, then whatever a pending
     * retarget or a ready move most recently landed the tree at. Never rewritten except by one
     * of those two paths. */
    shootDate: text("shoot_date").notNull(),
    projectFolderName: text("project_folder_name").notNull(),
    /** Snapshot of the Tonomo path used to derive projectFolderName; not an AutoHDR pointer. */
    tonomoRawFolderPath: text("tonomo_raw_folder_path"),
    photographerEvidenceJson: text("photographer_evidence_json").notNull(),
    inputRootsJson: text("input_roots_json").notNull().default("[]"),
    outputRootsJson: text("output_roots_json").notNull().default("[]"),
    editingNotesPath: text("editing_notes_path").notNull(),
    editingNotesFolderId: text("editing_notes_folder_id"),
    state: text("state", { enum: ["pending", "ready", "needs_review"] as const }).notNull().default("pending"),
    /** Ordered, JSON-safe evidence of external creates and partial failures. */
    recoveryProofJson: text("recovery_proof_json"),
    /** Short-lived claim used to serialize provider-side reconciliation attempts. */
    provisionLeaseToken: text("provision_lease_token"),
    provisionLeaseExpiresAt: integer("provision_lease_expires_at", { mode: "timestamp_ms" }),
    initialSyncCompletedAt: integer("initial_sync_completed_at", { mode: "timestamp_ms" }),
    reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
    reviewedBy: text("reviewed_by").references(() => user.id, { onDelete: "set null" }),
    /** Bumped on every completed Editor tree move; fences a scaffold/sync pass reading the root
     * mid-move against the batch that rebases it. */
    rootRevision: integer("root_revision").notNull().default(0),
    /** Set while a ready mapping's tree is being relocated for a reschedule, or when a move
     * attempt could not proceed. The reason is in `moveNote`; the app reads both through
     * `workers/app/src/lib/attention.ts` (Admin → Pipeline, and the project page banner). */
    moveStatus: text("move_status", { enum: ["moving", "blocked"] as const }),
    moveTargetPath: text("move_target_path"),
    moveTargetPathKey: text("move_target_path_key"),
    /** The Project's shoot date this move (or blocked attempt) is targeting. */
    moveTargetShootDate: text("move_target_shoot_date"),
    /** Claims the in-flight move so a takeover only happens after `moveExpiresAt`. */
    moveToken: text("move_token"),
    moveExpiresAt: integer("move_expires_at", { mode: "timestamp_ms" }),
    /** `<code>: <sentence>` (see `editor-folders/move-note.ts`) for a `blocked` move, or for a
     * `moving` one that has stopped being retried. */
    moveNote: text("move_note"),
    /** @deprecated since 0046 (#195): neither read nor written. Orphan-upload watches live in
     * `editorFolderOrphanWatches`; the columns stay only because dropping them needs a rebuild. */
    movedFromPath: text("moved_from_path"),
    /** @deprecated since 0046 (#195); see `movedFromPath`. */
    moveCompletedAt: integer("move_completed_at", { mode: "timestamp_ms" }),
    /** Commit attempts made after Dropbox already reported the tree at its new location. Reset to
     * 0 by a successful commit or a release; past `MOVE_COMMIT_ATTEMPT_LIMIT` the move stops
     * being retried and is escalated for an operator instead of wedging quietly. */
    moveCommitAttempts: integer("move_commit_attempts").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("editor_folder_mappings_connection_root_key_unique").on(t.connectionId, t.rootPathKey),
    uniqueIndex("editor_folder_mappings_project_unique").on(t.projectId),
    uniqueIndex("editor_folder_mappings_connection_move_target_key_unique").on(t.connectionId, t.moveTargetPathKey).where(sql`${t.moveTargetPathKey} IS NOT NULL`),
    index("editor_folder_mappings_state_updated_idx").on(t.state, t.updatedAt, t.id),
    index("editor_folder_mappings_connection_state_idx").on(t.connectionId, t.state),
    check("editor_folder_mappings_state_check", sql`${t.state} IN ('pending', 'ready', 'needs_review')`),
    check("editor_folder_mappings_input_roots_json_check", sql`json_valid(${t.inputRootsJson})`),
    check("editor_folder_mappings_output_roots_json_check", sql`json_valid(${t.outputRootsJson})`),
    check("editor_folder_mappings_photographer_evidence_json_check", sql`json_valid(${t.photographerEvidenceJson})`),
    check("editor_folder_mappings_recovery_proof_json_check", sql`${t.recoveryProofJson} IS NULL OR json_valid(${t.recoveryProofJson})`),
    check("editor_folder_mappings_move_status_check", sql`${t.moveStatus} IS NULL OR ${t.moveStatus} IN ('moving', 'blocked')`),
  ],
);

/**
 * One orphan-upload watch per committed Editor tree move (#195). After a move lands, the sweep
 * checks `oldPath` for files a human dropped into the now-abandoned root. `watching` until files
 * are found (`found`, held until an admin acknowledges it, which deletes the row) or the watch
 * lapses empty at `watchUntil` (deleted). Read by `workers/app/src/lib/attention.ts`.
 */
export const editorFolderOrphanWatches = sqliteTable(
  "editor_folder_orphan_watches",
  {
    id: id(),
    mappingId: text("mapping_id").notNull().references(() => editorFolderMappings.id, { onDelete: "cascade" }),
    /** The `root_revision` the move committed; one watch per revision, so a replayed commit is a no-op. */
    moveRevision: integer("move_revision").notNull(),
    oldPath: text("old_path").notNull(),
    oldPathKey: text("old_path_key").notNull(),
    status: text("status", { enum: ["watching", "found"] as const }).notNull().default("watching"),
    watchUntil: integer("watch_until", { mode: "timestamp_ms" }).notNull(),
    foundAt: integer("found_at", { mode: "timestamp_ms" }),
    /** The first file the sweep saw at `oldPath`. */
    foundDetail: text("found_detail"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("editor_folder_orphan_watches_mapping_revision_unique").on(t.mappingId, t.moveRevision),
    index("editor_folder_orphan_watches_status_due_idx").on(t.status, t.watchUntil),
    check("editor_folder_orphan_watches_status_check", sql`${t.status} IN ('watching', 'found')`),
  ],
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

export const noticeBoardReadMarkers = sqliteTable(
  "notice_board_read_markers",
  {
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    lastReadPostId: text("last_read_post_id").notNull(),
    lastReadPostCreatedAt: integer("last_read_post_created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId] })],
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
    /** Null for a video_review link; set for a delivery link (route SQL enforces, migration 0069). */
    publishVersion: integer("publish_version"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    passcodeHash: text("passcode_hash"),
    createdAt: createdAt(),
    /* video review (#741, migration 0069). Cross-column invariants live in route SQL, not CHECKs. */
    kind: text("kind", { enum: ["delivery", "video_review"] as const }).notNull().default("delivery"),
    label: text("label"),
    allowComments: integer("allow_comments").notNull().default(1),
    allowApprove: integer("allow_approve").notNull().default(1),
    allowDownload: integer("allow_download").notNull().default(1),
    createdBy: text("created_by").references(() => user.id),
    tokenGeneration: integer("token_generation").notNull().default(1),
    updatedAt: integer("updated_at"),
    revokedAt: integer("revoked_at"),
    revokedBy: text("revoked_by").references(() => user.id),
  },
  (t) => [
    index("client_links_project_idx").on(t.projectId),
    index("client_links_project_kind_idx").on(t.projectId, t.kind, t.createdAt),
    check("client_links_kind_check", sql`${t.kind} IN ('delivery', 'video_review')`),
    check("client_links_label_check", sql`${t.label} IS NULL OR length(trim(${t.label})) BETWEEN 1 AND 80`),
    check("client_links_allow_comments_check", sql`${t.allowComments} IN (0, 1)`),
    check("client_links_allow_approve_check", sql`${t.allowApprove} IN (0, 1)`),
    check("client_links_allow_download_check", sql`${t.allowDownload} IN (0, 1)`),
    check("client_links_token_generation_check", sql`${t.tokenGeneration} >= 1`),
    check("client_links_updated_at_check", sql`${t.updatedAt} IS NULL OR typeof(${t.updatedAt}) = 'integer'`),
    check("client_links_revoked_at_check", sql`${t.revokedAt} IS NULL OR typeof(${t.revokedAt}) = 'integer'`),
    check("client_links_publish_version_check", sql`${t.publishVersion} IS NULL OR ${t.publishVersion} >= 1`),
  ],
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

/** A deleted Project's Tonomo order. Tonomo re-sends an order on every change, so the Tonomo
 * processor ignores an event whose order has a tombstone and no live Project holds the order_id.
 * `deletedProjectId` is history, not a foreign key: the Project is gone. */
export const tonomoOrderTombstones = sqliteTable("tonomo_order_tombstones", {
  orderId: text("order_id").primaryKey(),
  deletedProjectId: text("deleted_project_id").notNull(),
  street: text("street"),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  deletedBy: text("deleted_by"),
  source: text("source", { enum: ["project_delete", "migration_0051", "manual"] }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

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
    check("jobs_stage_entry_board_revision_check", sql`${t.stageEntryBoardRevision} IS NULL OR (typeof(${t.stageEntryBoardRevision}) = 'integer' AND ${t.stageEntryBoardRevision} >= 0 AND ${t.stageEntryBoardRevision} <= 9007199254740991)`),
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
    status: text("status", { enum: ["pending", "processing", "sent", "suppressed", "failed", "unknown", "discarded", "deferred"] as const }).notNull().default("pending"),
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
    check("notification_delivery_ledger_status_check", sql`${t.status} IN ('pending', 'processing', 'sent', 'suppressed', 'failed', 'unknown', 'discarded', 'deferred')`),
    check("notification_delivery_ledger_attempts_check", sql`${t.attempts} >= 0`),
  ],
);

/**
 * #489: one Email digest per recipient per hourly slot. `UNIQUE(recipient_id, slot_at)` is the
 * per-recipient-per-slot idempotency key: a cron retry loses the insert race and sends nothing.
 */
export const notificationDigests = sqliteTable(
  "notification_digests",
  {
    id: id(),
    recipientId: text("recipient_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    slotAt: integer("slot_at").notNull(),
    cadence: text("cadence").notNull(),
    status: text("status", { enum: ["claimed", "sending", "sent", "empty", "failed", "unknown", "released"] as const }).notNull(),
    itemCount: integer("item_count").notNull().default(0),
    projectCount: integer("project_count").notNull().default(0),
    emailMessageId: text("email_message_id"),
    lastErrorCode: text("last_error_code"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    unique("notification_digests_recipient_slot_unique").on(t.recipientId, t.slotAt),
    index("notification_digests_status_updated_idx").on(t.status, t.updatedAt),
    check("notification_digests_status_check", sql`${t.status} IN ('claimed', 'sending', 'sent', 'empty', 'failed', 'unknown', 'released')`),
    check("notification_digests_counts_check", sql`${t.itemCount} >= 0 AND ${t.projectCount} >= 0`),
  ],
);

/** #489: a notification whose email waits for a digest. `notification_id` and `ledger_id` are SET NULL, never RESTRICT: project deletion removes ledger rows first. */
export const notificationDigestItems = sqliteTable(
  "notification_digest_items",
  {
    id: id(),
    recipientId: text("recipient_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    notificationId: text("notification_id").references(() => notifications.id, { onDelete: "set null" }),
    ledgerId: text("ledger_id").references(() => notificationDeliveryLedger.id, { onDelete: "set null" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    notificationType: text("notification_type").notNull(),
    state: text("state", { enum: ["pending", "sent", "dropped_read", "suppressed", "failed", "unknown"] as const }).notNull().default("pending"),
    outcomeCode: text("outcome_code"),
    digestId: text("digest_id").references(() => notificationDigests.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    unique("notification_digest_items_notification_unique").on(t.notificationId),
    index("notification_digest_items_state_recipient_idx").on(t.state, t.recipientId, t.createdAt),
    index("notification_digest_items_digest_idx").on(t.digestId),
    check("notification_digest_items_state_check", sql`${t.state} IN ('pending', 'sent', 'dropped_read', 'suppressed', 'failed', 'unknown')`),
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

/** MCP access (#701): one row per consented AI client connection, the Portal's record of authority checked on every MCP call. `scopes` is a JSON array of read, write and admin. */
export const mcpConnections = sqliteTable(
  "mcp_connections",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    clientName: text("client_name").notNull(),
    redirectHost: text("redirect_host").notNull(),
    scopes: text("scopes").notNull(),
    authorizationEpoch: integer("authorization_epoch").notNull(),
    oauthGrantId: text("oauth_grant_id").unique(),
    createdAt: createdAt(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    revokedBy: text("revoked_by"),
    revokeReason: text("revoke_reason"),
  },
  (t) => [
    index("mcp_connections_user_revoked_idx").on(t.userId, t.revokedAt),
    index("mcp_connections_client_idx").on(t.clientId),
  ],
);

/* ------------------------------------------------- staff-side video review (#741, migration 0068) */
export const guestReviewers = sqliteTable("guest_reviewers", {
  id: id(),
  emailNormalized: text("email_normalized").notNull().unique(),
  displayName: text("display_name"),
  createdAt: integer("created_at").notNull(),
});

export const videos = sqliteTable(
  "videos",
  {
    /** Equals assets.version_group_id of this Video's Versions. */
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    collectionId: text("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    premium: integer("premium").notNull().default(0),
    position: integer("position").notNull().default(0),
    createdBy: text("created_by").notNull().references(() => user.id),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("videos_collection_position_idx").on(t.collectionId, t.position, t.id),
    index("videos_project_idx").on(t.projectId),
    check("videos_title_check", sql`length(trim(${t.title})) BETWEEN 1 AND 200`),
    check("videos_premium_check", sql`${t.premium} IN (0, 1)`),
    check("videos_position_check", sql`${t.position} >= 0`),
    check("videos_created_at_check", sql`typeof(${t.createdAt}) = 'integer'`),
    check("videos_updated_at_check", sql`typeof(${t.updatedAt}) = 'integer'`),
  ],
);

export const videoVersionMeta = sqliteTable(
  "video_version_meta",
  {
    assetId: text("asset_id").primaryKey().references(() => assets.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
    fpsNum: integer("fps_num").notNull(),
    fpsDen: integer("fps_den").notNull(),
    mediaTimescale: integer("media_timescale").notNull(),
    frameDelta: integer("frame_delta").notNull(),
    frameCount: integer("frame_count").notNull(),
    durationMs: integer("duration_ms").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    codec: text("codec", { enum: ["avc1", "avc3"] as const }).notNull(),
    codecString: text("codec_string").notNull(),
    startTcFrames: integer("start_tc_frames"),
    tcNominalFps: integer("tc_nominal_fps").notNull(),
    tcDropFrame: integer("tc_drop_frame").notNull(),
    fastStart: integer("fast_start").notNull(),
    hasAudio: integer("has_audio").notNull(),
    probeVersion: integer("probe_version").notNull(),
    posterKey: text("poster_key").unique(),
    uploadedBy: text("uploaded_by").notNull().references(() => user.id),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("video_version_meta_video_idx").on(t.videoId),
    check("video_version_meta_fps_num_check", sql`${t.fpsNum} > 0`),
    check("video_version_meta_fps_den_check", sql`${t.fpsDen} > 0`),
    check("video_version_meta_media_timescale_check", sql`${t.mediaTimescale} > 0`),
    check("video_version_meta_frame_delta_check", sql`${t.frameDelta} > 0`),
    check("video_version_meta_frame_count_check", sql`${t.frameCount} > 0`),
    check("video_version_meta_duration_ms_check", sql`${t.durationMs} > 0`),
    check("video_version_meta_width_check", sql`${t.width} > 0`),
    check("video_version_meta_height_check", sql`${t.height} > 0`),
    check("video_version_meta_codec_check", sql`${t.codec} IN ('avc1', 'avc3')`),
    check("video_version_meta_start_tc_frames_check", sql`${t.startTcFrames} IS NULL OR ${t.startTcFrames} >= 0`),
    check("video_version_meta_tc_nominal_fps_check", sql`${t.tcNominalFps} > 0`),
    check("video_version_meta_tc_drop_frame_check", sql`${t.tcDropFrame} IN (0, 1)`),
    check("video_version_meta_fast_start_check", sql`${t.fastStart} IN (0, 1)`),
    check("video_version_meta_has_audio_check", sql`${t.hasAudio} IN (0, 1)`),
    check("video_version_meta_probe_version_check", sql`${t.probeVersion} > 0`),
    check("video_version_meta_created_at_check", sql`typeof(${t.createdAt}) = 'integer'`),
  ],
);

export const videoUploadReservations = sqliteTable(
  "video_upload_reservations",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    collectionId: text("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
    createdBy: text("created_by").notNull().references(() => user.id),
    /** No FK: the Video row is created at completion. */
    videoId: text("video_id").notNull(),
    newVideoTitle: text("new_video_title"),
    version: integer("version").notNull(),
    /** No FK: the Asset row is created at completion. */
    assetId: text("asset_id").notNull().unique(),
    r2Key: text("r2_key").notNull().unique(),
    originalFilename: text("original_filename").notNull(),
    bytes: integer("bytes").notNull(),
    contentType: text("content_type").notNull(),
    uploadId: text("upload_id"),
    supersedesAssetId: text("supersedes_asset_id"),
    clientProbeJson: text("client_probe_json"),
    status: text("status", { enum: ["pending", "completing", "aborting", "completed", "rejected", "expired", "failed"] as const }).notNull().default("pending"),
    rejectReason: text("reject_reason"),
    expiresAt: integer("expires_at").notNull(),
    completingAt: integer("completing_at"),
    completedAt: integer("completed_at"),
    completionAuditId: text("completion_audit_id").notNull().unique(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("video_upload_reservations_active_video_unique").on(t.videoId).where(sql`${t.status} IN ('pending', 'completing', 'aborting')`),
    index("video_upload_reservations_status_expiry_idx").on(t.status, t.expiresAt),
    index("video_upload_reservations_project_creator_idx").on(t.projectId, t.createdBy),
    check("video_upload_reservations_version_check", sql`${t.version} >= 1`),
    check("video_upload_reservations_bytes_check", sql`${t.bytes} > 0 AND ${t.bytes} <= 2000000000`),
    check("video_upload_reservations_content_type_check", sql`${t.contentType} = 'video/mp4'`),
    check("video_upload_reservations_status_check", sql`${t.status} IN ('pending', 'completing', 'aborting', 'completed', 'rejected', 'expired', 'failed')`),
    check("video_upload_reservations_title_check", sql`(${t.version} = 1) = (${t.newVideoTitle} IS NOT NULL)`),
    check("video_upload_reservations_created_at_check", sql`typeof(${t.createdAt}) = 'integer'`),
    check("video_upload_reservations_updated_at_check", sql`typeof(${t.updatedAt}) = 'integer'`),
  ],
);

export const videoNotes = sqliteTable(
  "video_notes",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
    assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnySQLiteColumn => videoNotes.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").references(() => user.id),
    authorGuestId: text("author_guest_id").references(() => guestReviewers.id),
    authorRole: text("author_role", { enum: ["admin", "editor", "external_editor", "photographer", "guest"] as const }).notNull(),
    visibility: text("visibility", { enum: ["public", "internal"] as const }).notNull(),
    startFrame: integer("start_frame"),
    endFrame: integer("end_frame"),
    drawingFrame: integer("drawing_frame"),
    body: text("body").notNull(),
    resolvedAt: integer("resolved_at"),
    resolvedBy: text("resolved_by").references(() => user.id),
    revision: integer("revision").notNull().default(1),
    deletedAt: integer("deleted_at"),
    copiedFromNoteId: text("copied_from_note_id").references((): AnySQLiteColumn => videoNotes.id, { onDelete: "set null" }),
    copiedFromVersion: integer("copied_from_version"),
    originalAuthorName: text("original_author_name"),
    originalAuthorRole: text("original_author_role"),
    createdAt: integer("created_at").notNull(),
    editedAt: integer("edited_at"),
  },
  (t) => [
    index("video_notes_asset_frame_idx").on(t.assetId, t.parentId, t.startFrame),
    index("video_notes_parent_idx").on(t.parentId),
    index("video_notes_video_idx").on(t.videoId),
    index("video_notes_project_created_idx").on(t.projectId, t.createdAt),
    uniqueIndex("video_notes_copy_unique").on(t.assetId, t.copiedFromNoteId).where(sql`${t.copiedFromNoteId} IS NOT NULL`),
    check("video_notes_author_role_check", sql`${t.authorRole} IN ('admin', 'editor', 'external_editor', 'photographer', 'guest')`),
    check("video_notes_visibility_check", sql`${t.visibility} IN ('public', 'internal')`),
    check("video_notes_start_frame_check", sql`${t.startFrame} IS NULL OR ${t.startFrame} >= 0`),
    check("video_notes_drawing_frame_check", sql`${t.drawingFrame} IS NULL OR ${t.drawingFrame} >= 0`),
    check("video_notes_body_check", sql`length(${t.body}) <= 10000`),
    check("video_notes_revision_check", sql`${t.revision} >= 1`),
    check("video_notes_created_at_check", sql`typeof(${t.createdAt}) = 'integer'`),
    check("video_notes_one_author_check", sql`(${t.authorUserId} IS NULL) <> (${t.authorGuestId} IS NULL)`),
    check("video_notes_guest_public_check", sql`${t.authorGuestId} IS NULL OR (${t.visibility} = 'public' AND ${t.authorRole} = 'guest')`),
    check("video_notes_root_frame_check", sql`(${t.parentId} IS NULL) = (${t.startFrame} IS NOT NULL)`),
    check("video_notes_end_frame_check", sql`${t.endFrame} IS NULL OR (${t.startFrame} IS NOT NULL AND ${t.endFrame} > ${t.startFrame})`),
    check("video_notes_reply_shape_check", sql`${t.parentId} IS NULL OR (${t.drawingFrame} IS NULL AND ${t.resolvedAt} IS NULL AND ${t.copiedFromVersion} IS NULL)`),
    check("video_notes_resolved_pair_check", sql`(${t.resolvedAt} IS NULL) = (${t.resolvedBy} IS NULL)`),
    check("video_notes_copy_provenance_check", sql`(${t.copiedFromVersion} IS NULL) = (${t.originalAuthorName} IS NULL) AND (${t.copiedFromVersion} IS NULL) = (${t.originalAuthorRole} IS NULL)`),
    check("video_notes_copy_source_check", sql`${t.copiedFromNoteId} IS NULL OR ${t.copiedFromVersion} IS NOT NULL`),
  ],
);

export const videoNoteMarkup = sqliteTable(
  "video_note_markup",
  {
    noteId: text("note_id").primaryKey().references(() => videoNotes.id, { onDelete: "cascade" }),
    strokesJson: text("strokes_json").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check("video_note_markup_strokes_check", sql`length(CAST(${t.strokesJson} AS BLOB)) <= 524288`),
    check("video_note_markup_created_at_check", sql`typeof(${t.createdAt}) = 'integer'`),
    check("video_note_markup_updated_at_check", sql`typeof(${t.updatedAt}) = 'integer'`),
  ],
);

/* ------------------------------------------------- guest-side video review (#741, migration 0069) */
const intTime = (name: string) => integer(name);

export const reviewLinkVideos = sqliteTable(
  "review_link_videos",
  {
    id: id(),
    linkId: text("link_id").notNull().references(() => clientLinks.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    addedBy: text("added_by").notNull().references(() => user.id),
    addedAt: intTime("added_at").notNull(),
    removedAt: intTime("removed_at"),
    removedBy: text("removed_by").references(() => user.id),
  },
  (t) => [
    uniqueIndex("review_link_videos_live_unique").on(t.linkId, t.videoId).where(sql`${t.removedAt} IS NULL`),
    index("review_link_videos_video_idx").on(t.videoId, t.removedAt),
    check("review_link_videos_added_at_check", sql`typeof(${t.addedAt}) = 'integer'`),
    check("review_link_videos_removed_at_check", sql`${t.removedAt} IS NULL OR typeof(${t.removedAt}) = 'integer'`),
    check("review_link_videos_removed_pair_check", sql`(${t.removedAt} IS NULL) = (${t.removedBy} IS NULL)`),
  ],
);

export const reviewLinkVersionGrants = sqliteTable(
  "review_link_version_grants",
  {
    id: id(),
    linkId: text("link_id").notNull().references(() => clientLinks.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
    assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by").notNull().references(() => user.id),
    grantedAt: intTime("granted_at").notNull(),
    revokedAt: intTime("revoked_at"),
    revokedBy: text("revoked_by").references(() => user.id),
  },
  (t) => [
    uniqueIndex("review_link_version_grants_live_unique").on(t.linkId, t.assetId).where(sql`${t.revokedAt} IS NULL`),
    index("review_link_version_grants_link_video_idx").on(t.linkId, t.videoId),
    check("review_link_version_grants_granted_at_check", sql`typeof(${t.grantedAt}) = 'integer'`),
    check("review_link_version_grants_revoked_at_check", sql`${t.revokedAt} IS NULL OR typeof(${t.revokedAt}) = 'integer'`),
    check("review_link_version_grants_revoked_pair_check", sql`(${t.revokedAt} IS NULL) = (${t.revokedBy} IS NULL)`),
  ],
);

export const guestSessions = sqliteTable(
  "guest_sessions",
  {
    id: id(),
    tokenHash: text("token_hash").notNull().unique(),
    linkId: text("link_id").notNull().references(() => clientLinks.id, { onDelete: "cascade" }),
    linkGeneration: integer("link_generation").notNull(),
    guestId: text("guest_id").references(() => guestReviewers.id, { onDelete: "cascade" }),
    verifiedAt: intTime("verified_at"),
    createdAt: intTime("created_at").notNull(),
    expiresAt: intTime("expires_at").notNull(),
    lastSeenAt: intTime("last_seen_at").notNull(),
  },
  (t) => [
    index("guest_sessions_link_idx").on(t.linkId),
    index("guest_sessions_expires_idx").on(t.expiresAt),
    check("guest_sessions_link_generation_check", sql`${t.linkGeneration} >= 1`),
    check("guest_sessions_verified_at_check", sql`${t.verifiedAt} IS NULL OR typeof(${t.verifiedAt}) = 'integer'`),
    check("guest_sessions_created_at_check", sql`typeof(${t.createdAt}) = 'integer'`),
    check("guest_sessions_expires_at_check", sql`typeof(${t.expiresAt}) = 'integer'`),
    check("guest_sessions_last_seen_at_check", sql`typeof(${t.lastSeenAt}) = 'integer'`),
    check("guest_sessions_verified_pair_check", sql`(${t.guestId} IS NULL) = (${t.verifiedAt} IS NULL)`),
    check("guest_sessions_expiry_check", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

export const guestRateLimits = sqliteTable(
  "guest_rate_limits",
  {
    bucket: text("bucket").notNull(),
    windowStart: intTime("window_start").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bucket, t.windowStart] }),
    index("guest_rate_limits_window_idx").on(t.windowStart),
    check("guest_rate_limits_window_start_check", sql`typeof(${t.windowStart}) = 'integer'`),
    check("guest_rate_limits_count_check", sql`${t.count} >= 1`),
  ],
);

export const guestEmailCodes = sqliteTable(
  "guest_email_codes",
  {
    id: id(),
    linkId: text("link_id").notNull().references(() => clientLinks.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull().references(() => guestSessions.id, { onDelete: "cascade" }),
    emailNormalized: text("email_normalized").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: intTime("expires_at").notNull(),
    consumedAt: intTime("consumed_at"),
    createdAt: intTime("created_at").notNull(),
  },
  (t) => [
    index("guest_email_codes_session_created_idx").on(t.sessionId, t.createdAt),
    index("guest_email_codes_link_email_created_idx").on(t.linkId, t.emailNormalized, t.createdAt),
    check("guest_email_codes_email_check", sql`length(${t.emailNormalized}) <= 254`),
    check("guest_email_codes_attempts_check", sql`${t.attempts} BETWEEN 0 AND 5`),
    check("guest_email_codes_expires_at_check", sql`typeof(${t.expiresAt}) = 'integer'`),
    check("guest_email_codes_consumed_at_check", sql`${t.consumedAt} IS NULL OR typeof(${t.consumedAt}) = 'integer'`),
    check("guest_email_codes_created_at_check", sql`typeof(${t.createdAt}) = 'integer'`),
  ],
);

export const guestLinkMembers = sqliteTable(
  "guest_link_members",
  {
    id: id(),
    linkId: text("link_id").notNull().references(() => clientLinks.id, { onDelete: "cascade" }),
    guestId: text("guest_id").notNull().references(() => guestReviewers.id, { onDelete: "cascade" }),
    firstVerifiedAt: intTime("first_verified_at").notNull(),
    lastVerifiedAt: intTime("last_verified_at").notNull(),
    lastSeenAt: intTime("last_seen_at").notNull(),
    unsubscribedAt: intTime("unsubscribed_at"),
    lastDigestSentAt: intTime("last_digest_sent_at"),
  },
  (t) => [
    unique("guest_link_members_link_guest_unique").on(t.linkId, t.guestId),
    check("guest_link_members_first_verified_at_check", sql`typeof(${t.firstVerifiedAt}) = 'integer'`),
    check("guest_link_members_last_verified_at_check", sql`typeof(${t.lastVerifiedAt}) = 'integer'`),
    check("guest_link_members_last_seen_at_check", sql`typeof(${t.lastSeenAt}) = 'integer'`),
    check("guest_link_members_unsubscribed_at_check", sql`${t.unsubscribedAt} IS NULL OR typeof(${t.unsubscribedAt}) = 'integer'`),
    check("guest_link_members_last_digest_sent_at_check", sql`${t.lastDigestSentAt} IS NULL OR typeof(${t.lastDigestSentAt}) = 'integer'`),
  ],
);

export const guestUnsubscribeTokens = sqliteTable(
  "guest_unsubscribe_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    memberId: text("member_id").notNull().references(() => guestLinkMembers.id, { onDelete: "cascade" }),
    createdAt: intTime("created_at").notNull(),
  },
  (t) => [
    index("guest_unsubscribe_tokens_created_idx").on(t.createdAt),
    check("guest_unsubscribe_tokens_created_at_check", sql`typeof(${t.createdAt}) = 'integer'`),
  ],
);

export const videoApprovalEvents = sqliteTable(
  "video_approval_events",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
    assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    linkId: text("link_id").references(() => clientLinks.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    decision: text("decision", { enum: ["approved", "changes_requested"] as const }).notNull(),
    note: text("note"),
    actorGuestId: text("actor_guest_id").references(() => guestReviewers.id),
    actorUserId: text("actor_user_id").references(() => user.id),
    createdAt: intTime("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("video_approval_events_asset_revision_unique").on(t.assetId, t.revision),
    index("video_approval_events_video_idx").on(t.videoId),
    check("video_approval_events_revision_check", sql`${t.revision} >= 1`),
    check("video_approval_events_decision_check", sql`${t.decision} IN ('approved', 'changes_requested')`),
    check("video_approval_events_note_check", sql`${t.note} IS NULL OR length(${t.note}) <= 2000`),
    check("video_approval_events_created_at_check", sql`typeof(${t.createdAt}) = 'integer'`),
    check("video_approval_events_one_actor_check", sql`(${t.actorGuestId} IS NULL) <> (${t.actorUserId} IS NULL)`),
    check("video_approval_events_guest_link_check", sql`${t.actorGuestId} IS NULL OR ${t.linkId} IS NOT NULL`),
  ],
);

export const videoReleases = sqliteTable(
  "video_releases",
  {
    id: id(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
    assetId: text("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    approvalEventId: text("approval_event_id").notNull().references(() => videoApprovalEvents.id, { onDelete: "cascade" }),
    approvalRevision: integer("approval_revision").notNull(),
    releasedBy: text("released_by").notNull().references(() => user.id),
    releasedAt: intTime("released_at").notNull(),
    withdrawnAt: intTime("withdrawn_at"),
    withdrawnBy: text("withdrawn_by").references(() => user.id),
  },
  (t) => [
    uniqueIndex("video_releases_live_unique").on(t.assetId).where(sql`${t.withdrawnAt} IS NULL`),
    index("video_releases_video_idx").on(t.videoId),
    check("video_releases_approval_revision_check", sql`${t.approvalRevision} >= 1`),
    check("video_releases_released_at_check", sql`typeof(${t.releasedAt}) = 'integer'`),
    check("video_releases_withdrawn_at_check", sql`${t.withdrawnAt} IS NULL OR typeof(${t.withdrawnAt}) = 'integer'`),
    check("video_releases_withdrawn_pair_check", sql`(${t.withdrawnAt} IS NULL) = (${t.withdrawnBy} IS NULL)`),
  ],
);

export const videoPremiumUnlocks = sqliteTable(
  "video_premium_unlocks",
  {
    videoId: text("video_id").primaryKey().references(() => videos.id, { onDelete: "cascade" }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    unlockedBy: text("unlocked_by").notNull().references(() => user.id),
    unlockedAt: intTime("unlocked_at").notNull(),
    paymentRef: text("payment_ref"),
  },
  (t) => [
    index("video_premium_unlocks_project_idx").on(t.projectId),
    check("video_premium_unlocks_unlocked_at_check", sql`typeof(${t.unlockedAt}) = 'integer'`),
    check("video_premium_unlocks_payment_ref_check", sql`${t.paymentRef} IS NULL OR length(${t.paymentRef}) <= 200`),
  ],
);

export const guestNotificationDigest = sqliteTable(
  "guest_notification_digest",
  {
    id: id(),
    guestId: text("guest_id").notNull().references(() => guestReviewers.id, { onDelete: "cascade" }),
    linkId: text("link_id").notNull().references(() => clientLinks.id, { onDelete: "cascade" }),
    eventType: text("event_type", { enum: ["video_added", "version_granted", "public_note", "staff_reply", "video_released"] as const }).notNull(),
    videoId: text("video_id").notNull().references(() => videos.id, { onDelete: "cascade" }),
    assetId: text("asset_id").references(() => assets.id, { onDelete: "cascade" }),
    noteId: text("note_id").references(() => videoNotes.id, { onDelete: "cascade" }),
    createdAt: intTime("created_at").notNull(),
    sentAt: intTime("sent_at"),
  },
  (t) => [
    index("guest_notification_digest_pending_guest_link_idx").on(t.guestId, t.linkId).where(sql`${t.sentAt} IS NULL`),
    index("guest_notification_digest_pending_created_idx").on(t.createdAt).where(sql`${t.sentAt} IS NULL`),
    check("guest_notification_digest_event_type_check", sql`${t.eventType} IN ('video_added', 'version_granted', 'public_note', 'staff_reply', 'video_released')`),
    check("guest_notification_digest_created_at_check", sql`typeof(${t.createdAt}) = 'integer'`),
    check("guest_notification_digest_sent_at_check", sql`${t.sentAt} IS NULL OR typeof(${t.sentAt}) = 'integer'`),
  ],
);
