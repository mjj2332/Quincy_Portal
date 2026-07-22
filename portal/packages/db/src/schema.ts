/**
 * Quincy Portal — D1 schema v1 (Implementation-Plan §5).
 * Metadata only: media bytes live in R2; dense annotation JSON lives in R2 (ref here).
 * All media rows use immutable, versioned R2 keys.
 */
import { sqliteTable, text, integer, real, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
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
  role: text("role", { enum: ["admin", "photographer", "editor"] })
    .notNull()
    .default("photographer"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
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
    orderNo: text("order_no"),
    orderId: text("order_id"),
    invoiceAmount: real("invoice_amount"),
    paymentStatus: text("payment_status"),
    notes: text("notes"),
    rawFolderLink: text("raw_folder_link"),
    rawFolderPath: text("raw_folder_path"),
    coverAssetId: text("cover_asset_id"),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    archivedBy: text("archived_by").references(() => user.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("projects_stage_idx").on(t.stageKey),
    index("projects_order_idx").on(t.orderId),
    index("projects_archived_idx").on(t.archivedAt),
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("collection_links_collection_idx").on(t.collectionId),
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
    /** Original provider path, retained for source-system handoffs such as AutoHDR. */
    sourcePath: text("source_path"),
    /** XMP xmp:Rating read at ingest; NULL = unrated (never coerce to 0). */
    ratingFromMetadata: integer("rating_from_metadata"),
    streamUid: text("stream_uid"),
    /** NULL is the root Captures section; Dropbox immediate subfolders retain their display name. */
    section: text("section"),
    /** Deprecated in favour of section; retained for non-destructive compatibility. */
    isPremium: integer("is_premium", { mode: "boolean" }).notNull().default(false),
    version: integer("version").notNull().default(1),
    supersedesAssetId: text("supersedes_asset_id"),
    /** RAW↔Edited pairing (D-07): set on edited assets returned from autoHDR. */
    sourceRawAssetId: text("source_raw_asset_id"),
    /** Ties floorplan PDF + preview JPG into one floorplan version (D-08). */
    versionGroupId: text("version_group_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("assets_collection_idx").on(t.collectionId),
    index("assets_source_raw_idx").on(t.sourceRawAssetId),
    index("assets_hash_idx").on(t.contentHash),
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
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: createdAt(),
  },
  (t) => [index("upload_manifests_collection_idx").on(t.collectionId)],
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
    authorRole: text("author_role", { enum: ["admin", "photographer", "editor"] }).notNull(),
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

export const comments = sqliteTable(
  "comments",
  {
    id: id(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id),
    authorRole: text("author_role", { enum: ["admin", "photographer", "editor"] }).notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
    editedAt: integer("edited_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("comments_asset_idx").on(t.assetId)],
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
    payloadJson: text("payload_json"),
    retries: integer("retries").notNull().default(0),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("jobs_status_idx").on(t.status), index("jobs_correlation_idx").on(t.correlationId)],
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
