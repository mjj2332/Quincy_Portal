/**
 * Test support (not a test file): the rows the RUNNING APP writes against a project once a browser
 * pass has used it — comments, mentions, read markers, activity, audit, outbox + ledger, jobs, the
 * AutoHDR handoff/claim chain, assets + renditions + a rendition DLQ event, and more — as plain
 * `INSERT` statements, so the same shapes can be planted into a `node:sqlite` test database and into
 * a real scratch local D1 (`verify-qa-teardown-local-d1.sh`).
 *
 * Planted twice by the used-fixture tests: once against a FIXTURE project (every row must be gone
 * after teardown) and once against a hand-made CONTROL project (every row must be byte-identical
 * after teardown). Depth ≥ 2 throughout (project → collection → asset → rendition / DLQ / claim).
 *
 * Honest note on "reply": `project_comments` has no parent column and the live schema has no
 * self-referencing FK at all, so a reply here is a second comment on the same project. The
 * self-reference the teardown's fixed point really has to terminate on is the no-FK version chain
 * `assets.supersedes_asset_id` (v1 ← v2 ← v3), which is planted below.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeChecklistSchedule, presetSubtaskRange } from "@quincy/shared";

/** The control Subtask's range: the presets on one day, normalized so its instants are the app's own (ADR 0016). */
const CONTROL_SCHEDULE = (() => {
  const result = normalizeChecklistSchedule(presetSubtaskRange("2026-09-21"), 1);
  if (!result.ok) throw new Error("control schedule fixture invalid");
  return result.value;
})();

export type PlantRow = { table: string; values: Record<string, string | number | null> };

/** Deterministic canonical v5-shaped UUID for a planted row. */
export function plantId(name: string): string {
  const hex = createHash("sha1").update(`qa-seed-app-rows:${name}`).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function literal(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

export function insertSql(row: PlantRow): string {
  const columns = Object.keys(row.values);
  return `INSERT INTO ${row.table} (${columns.join(", ")}) VALUES (${columns.map((c) => literal(row.values[c]!)).join(", ")});`;
}

const T0 = 1_790_000_000_000;

// ---------------------------------------------------------------------------
// audit_log target types the app actually writes — scanned from workers/ source, not guessed.
// ---------------------------------------------------------------------------

const workersDir = fileURLToPath(new URL("../../../workers/", import.meta.url));
const dbSrcDir = fileURLToPath(new URL("../src/", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".ts") && !/\.test\.ts$/.test(full)) out.push(full);
  }
  return out;
}

/** Every literal `target_type` in an `INSERT INTO audit_log (..., target_type, ...)` statement, every
 * literal fourth argument of the `audit(env, principal, action, targetType, ...)` helper, and every
 * `targetType: "..."` drizzle insert — across `workers/` and `packages/db/src/`. */
export function scannedAuditTargetTypes(): string[] {
  const found = new Set<string>();
  for (const file of [...sourceFiles(workersDir), ...sourceFiles(dbSrcDir)]) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/INSERT INTO audit_log\s*\(\s*id,\s*actor_id,\s*action,\s*target_type,\s*target_id,\s*meta_json,\s*created_at\s*\)([\s\S]{0,400})/g)) {
      const literals = [...match[1]!.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]!).filter((value) => !value.includes("."));
      if (literals[0]) found.add(literals[0]);
    }
    for (const match of source.matchAll(/\baudit\([^,]+,\s*[^,]+,\s*(?:"[a-z_.]+"|[^,]+),\s*"([a-z_]+)"/g)) found.add(match[1]!);
    for (const match of source.matchAll(/targetType:\s*"([a-z_]+)"/g)) found.add(match[1]!);
    for (const match of source.matchAll(/\.bind\([^)]*?"[a-z]+(?:\.[a-z_]+)+",\s*"([a-z_]+)"/g)) found.add(match[1]!);
  }
  return [...found].sort();
}

/** Target types whose target is a row UNDER a project — each gets an audit row per planted project,
 * targeting the planted (or registered) row of that type. */
export const PROJECT_DESCENDANT_AUDIT_TYPES = [
  "annotation", "asset", "autohdr_mapping", "collection_link", "document_upload", "embedded_media", "job", "link_preview", "notification",
  "notification_outbox", "project", "project_comment", "project_deadline_occurrence", "project_member",
  "project_subtask", "project_subtask_reminder_occurrence", "raw_reconciliation_claim", "rendition_dlq_event", "review_link", "upload_manifest", "video_upload",
] as const;

/** Target types whose target is never a project's descendant (a user, a flag, an integration, a
 * directory row, a notice-board post, a webhook, a rendition-backfill cursor) — planted once each,
 * and must survive teardown. */
export const GLOBAL_AUDIT_TYPES = [
  "agency", "agent", "asset_renditions", "feature_flag", "integration", "notice_board_post",
  "notification_preference", "pipeline_stage", "system", "user", "webhook_event",
] as const;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export type PlantContext = {
  tag: string;
  projectId: string;
  collectionId: string;
  subtaskId: string;
  occurrenceId: string;
  userId: string;
  connectionId: string;
};

/** The global rows both sides share: one integration connection (AutoHDR handoffs need one), plus
 * one audit row per global target type. None of these may be touched by teardown. */
export function globalRows(connectionId: string, userId: string): PlantRow[] {
  return [
    { table: "integration_connections", values: { id: connectionId, provider: "dropbox", status: "connected", created_at: T0, updated_at: T0 } },
    ...GLOBAL_AUDIT_TYPES.map((type) => ({
      table: "audit_log",
      values: { id: plantId(`global-audit:${type}`), actor_id: userId, action: `qa.${type}`, target_type: type, target_id: plantId(`global-target:${type}`), meta_json: null, created_at: T0 },
    })),
  ];
}

/** A hand-made control project: never registered, so teardown must leave it and everything under it
 * alone. Carries the same collection/subtask/occurrence the fixture side gets from the generator. */
export function controlProjectRows(ctx: PlantContext): PlantRow[] {
  return [
    { table: "projects", values: { id: ctx.projectId, street: `Control ${ctx.tag}`, stage_key: "raw_review", created_at: T0, updated_at: T0 } },
    { table: "collections", values: { id: ctx.collectionId, project_id: ctx.projectId, kind: "raw", status: "empty", received_count: 0, created_at: T0, updated_at: T0 } },
    { table: "project_subtasks", values: { id: ctx.subtaskId, project_id: ctx.projectId, title: "Control subtask", done: 0, position: 1024, due_date: CONTROL_SCHEDULE.dueDate, schedule_start_kind: "timed", schedule_start_civil: CONTROL_SCHEDULE.scheduleStartCivil, schedule_start_at: CONTROL_SCHEDULE.scheduleStartAt, schedule_start_utc_offset_minutes: CONTROL_SCHEDULE.scheduleStartUtcOffsetMinutes, schedule_start_fold: CONTROL_SCHEDULE.scheduleStartFold, schedule_end_kind: "timed", schedule_end_at: CONTROL_SCHEDULE.scheduleEndAt, schedule_end_utc_offset_minutes: CONTROL_SCHEDULE.scheduleEndUtcOffsetMinutes, schedule_end_fold: CONTROL_SCHEDULE.scheduleEndFold, schedule_zone: "Australia/Sydney", schedule_version: 1, created_by: ctx.userId, created_at: T0, updated_at: T0 } },
    {
      table: "project_deadline_occurrences",
      values: {
        id: ctx.occurrenceId, project_id: ctx.projectId, schedule_version: 1, kind: "due_now", reminder_offset_minutes: 0, fire_at: T0 + 86_400_000, deadline_at: T0 + 86_400_000,
        deadline_local_civil: "2026-09-30T17:00", deadline_zone: "Australia/Sydney", deadline_utc_offset_minutes: 600, deadline_fold: 0, status: "pending", created_by: ctx.userId, created_at: T0, updated_at: T0,
      },
    },
  ];
}

export type AppRowGroup = "comments" | "activity" | "audit" | "notifications" | "jobs" | "assets" | "dlq" | "autohdr" | "members" | "documents";

/** Every app-shaped row for one project, grouped so a test can plant one finding's shape alone. */
export function appRows(ctx: PlantContext, groups?: readonly AppRowGroup[]): PlantRow[] {
  const id = (name: string) => plantId(`${ctx.tag}:${name}`);
  const want = (group: AppRowGroup) => !groups || groups.includes(group);
  const ids = {
    member: id("member"), comment: id("comment"), linkPreview: id("link-preview"), linkPreviewAttempt: id("link-preview-attempt"), embeddedMedia: id("embedded-media"), reply: id("reply"), mention: id("mention"), activity: id("activity"),
    job: id("job"), handoff: id("handoff"), mapping: id("mapping"), assetV1: id("asset-v1"), assetV2: id("asset-v2"), assetV3: id("asset-v3"),
    rendition: id("rendition"), dlq: id("dlq"), claim: id("claim"), outbox: id("outbox"), notification: id("notification"), ledger: id("ledger"),
    annotation: id("annotation"), link: id("link"), manifest: id("manifest"), rawClaim: id("raw-claim"), subtaskOcc: id("subtask-reminder-occurrence"), document: id("document"), documentAudit: id("document-audit"), videoUpload: id("video-upload"), videoUploadAudit: id("video-upload-audit"),
    reviewLink: id("review-link"), reviewVideo: id("review-video"), reviewMember: id("review-member"), reviewGrant: id("review-grant"), guestSession: id("guest-session"),
  };
  const rows: PlantRow[] = [];
  const needsAssets = want("assets") || want("dlq") || want("autohdr") || want("documents");
  const needsJob = want("jobs") || want("autohdr");

  if (want("members") || want("notifications")) {
    rows.push({ table: "project_members", values: { id: ids.member, project_id: ctx.projectId, user_id: ctx.userId, role_on_project: "photographer", created_at: T0 } });
  }
  if (want("comments") || want("activity") || want("audit")) {
    rows.push(
      { table: "project_comments", values: { id: ids.comment, project_id: ctx.projectId, author_id: ctx.userId, body: "First", content_json: "{}", created_at: T0 } },
      { table: "embedded_media", values: { id: ids.embeddedMedia, owner_kind: "project_comment", owner_id: ids.comment, project_id: ctx.projectId, uploader_id: ctx.userId, kind: "image", content_type: "image/png", bytes: 64, original_key: `projects/${ctx.projectId}/embedded-media/${ids.embeddedMedia}/original`, state: "attached", created_at: T0, updated_at: T0 } },
      { table: "link_previews", values: { id: ids.linkPreview, owner_kind: "project_comment", owner_id: ids.comment, project_id: ctx.projectId, requester_id: ctx.userId, url: "https://example.test/", title: "Example", description: null, site_name: null, image_media_id: ids.embeddedMedia, created_at: T0, updated_at: T0 } },
      { table: "link_preview_attempts", values: { id: ids.linkPreviewAttempt, requester_id: ctx.userId, owner_kind: "project_comment", context_id: ctx.projectId, url: "https://example.test/", status: "done", preview_id: ids.linkPreview, created_at: T0, updated_at: T0 } },
      { table: "project_comments", values: { id: ids.reply, project_id: ctx.projectId, author_id: ctx.userId, body: "Reply", content_json: "{}", created_at: T0 + 1 } },
    );
  }
  if (want("comments")) {
    rows.push(
      { table: "project_comment_mentions", values: { id: ids.mention, comment_id: ids.comment, mentioned_user_id: ctx.userId, created_at: T0 } },
      { table: "project_comment_read_markers", values: { user_id: ctx.userId, project_id: ctx.projectId, last_read_comment_id: ids.reply, last_read_comment_created_at: T0 + 1, updated_at: T0 + 1 } },
    );
  }
  if (want("activity")) {
    rows.push({
      table: "project_activity_events",
      values: {
        id: ids.activity, schema_version: 1, event_type: "comment.created", category: "collaboration", project_id: ctx.projectId, actor_kind: "user", actor_id: ctx.userId,
        occurred_at: T0, source_kind: "project_comment", source_id: ids.comment, source_key: `comment:${ids.comment}`, safe_payload_json: "{}",
        deep_link_kind: "project", deep_link_path: `/projects/${ctx.projectId}`, created_at: T0,
      },
    });
  }
  if (needsJob) {
    rows.push({ table: "jobs", values: { id: ids.job, kind: "autohdr", status: "succeeded", project_id: ctx.projectId, retries: 0, created_at: T0, updated_at: T0 } });
  }
  if (want("autohdr")) {
    rows.push(
      {
        table: "autohdr_handoffs",
        values: {
          id: ids.handoff, project_id: ctx.projectId, connection_id: ctx.connectionId, generation: 1, selection_hash: "h", selected_asset_ids_json: "[]", readiness_units_json: "[]",
          frozen_raw_folder_path: "/raw", initiated_by: ctx.userId, state: "completed", workflow_id: `wf-${ctx.tag}`, job_id: ids.job, lease_expires_at: T0, created_at: T0, updated_at: T0,
        },
      },
      { table: "autohdr_output_mappings", values: { id: ids.mapping, project_id: ctx.projectId, handoff_id: ids.handoff, connection_id: ctx.connectionId, generation: 1, created_at: T0, updated_at: T0 } },
    );
  }
  if (needsAssets) {
    const asset = (assetId: string, version: number, extra: Record<string, string | null>) => ({
      table: "assets",
      values: {
        id: assetId, collection_id: ctx.collectionId, kind: "photo", r2_key: `qa/${ctx.tag}/${version}`, original_filename: `v${version}.jpg`, bytes: 1, source: "upload",
        version, version_group_id: id("version-group"), created_at: T0, updated_at: T0, ...extra,
      },
    });
    rows.push(
      asset(ids.assetV1, 1, { replaced_by_asset_id: ids.assetV2 }),
      asset(ids.assetV2, 2, { supersedes_asset_id: ids.assetV1, autohdr_handoff_id: want("autohdr") ? ids.handoff : null }),
      asset(ids.assetV3, 3, { supersedes_asset_id: ids.assetV2, source_raw_asset_id: ids.assetV1 }),
      { table: "asset_renditions", values: { id: ids.rendition, asset_id: ids.assetV1, variant: "thumb", r2_key: `qa/${ctx.tag}/thumb`, created_at: T0 } },
    );
  }
  if (want("dlq")) {
    rows.push({ table: "rendition_dlq_events", values: { id: ids.dlq, asset_id: ids.assetV1, status: "open", received_at: T0 } });
  }
  if (want("autohdr")) {
    // RESTRICT to both the asset and the handoff (Sol round 2, finding 1).
    rows.push({ table: "edited_source_claims", values: { id: ids.claim, collection_id: ctx.collectionId, source_path_key: "/edited/v2.jpg", current_asset_id: ids.assetV2, handoff_id: ids.handoff, updated_at: T0, created_at: T0 } });
  }
  if (want("notifications")) {
    rows.push(
      {
        table: "notification_outbox",
        values: {
          id: ids.outbox, schema_version: 1, event_type: "comment.mention", source_key: `outbox:${ctx.tag}`, project_id: ctx.projectId, actor_id: ctx.userId, recipient_id: ctx.userId,
          payload_json: "{}", status: "completed", available_at: T0, created_at: T0, updated_at: T0, recipient_membership_cycle_id: ids.member,
        },
      },
      { table: "notifications", values: { id: ids.notification, user_id: ctx.userId, project_id: ctx.projectId, type: "mention", title: "Mention", created_at: T0 } },
      {
        table: "notification_delivery_ledger",
        values: { id: ids.ledger, outbox_id: ids.outbox, event_type: "comment.mention", source_key: `outbox:${ctx.tag}`, recipient_id: ctx.userId, channel: "in_app", status: "sent", notification_id: ids.notification, created_at: T0, updated_at: T0 },
      },
    );
  }
  if (want("documents")) {
    rows.push(
      { table: "annotations", values: { id: ids.annotation, asset_id: ids.assetV1, author_id: ctx.userId, author_role: "admin", scope: "internal", created_at: T0 } },
      { table: "collection_links", values: { id: ids.link, collection_id: ctx.collectionId, url: "https://example.test", source: "manual", created_at: T0, updated_at: T0 } },
      { table: "upload_manifests", values: { id: ids.manifest, collection_id: ctx.collectionId, expected_count: 1, filenames_json: "[]", created_by: ctx.userId, created_at: T0 } },
      {
        table: "document_uploads",
        values: {
          id: ids.document, project_id: ctx.projectId, collection_id: ctx.collectionId, created_by: ctx.userId, kind: "copy_pdf", version_group_id: id("doc-group"), version: 1,
          pdf_asset_id: ids.assetV3, pdf_key: `qa/${ctx.tag}/doc.pdf`, pdf_filename: "doc.pdf", pdf_bytes: 1, pdf_content_type: "application/pdf", status: "completed",
          expires_at: T0, completion_audit_id: ids.documentAudit, created_at: T0, updated_at: T0,
        },
      },
      {
        table: "video_upload_reservations",
        values: {
          id: ids.videoUpload, project_id: ctx.projectId, collection_id: ctx.collectionId, created_by: ctx.userId, video_id: id("video"), new_video_title: "QA", version: 1, asset_id: id("video-asset"),
          r2_key: `qa/${ctx.tag}/video.mp4`, original_filename: "video.mp4", bytes: 1, content_type: "video/mp4", status: "failed", expires_at: T0, completion_audit_id: ids.videoUploadAudit, created_at: T0, updated_at: T0,
        },
      },
    );
  }
  if (want("documents")) {
    // A Review link (#741 11a) with one member Video and its live grant, the shape the staff routes write. No FK-less column: all three hang off the project.
    rows.push(
      { table: "videos", values: { id: ids.reviewVideo, project_id: ctx.projectId, collection_id: ctx.collectionId, title: "QA", premium: 0, position: 0, created_by: ctx.userId, created_at: T0, updated_at: T0 } },
      { table: "client_links", values: { id: ids.reviewLink, project_id: ctx.projectId, token_hash: `qa-token-hash:${ctx.tag}`, kind: "video_review", expires_at: T0 + 86_400_000, created_by: ctx.userId, updated_at: T0, created_at: T0 } },
      { table: "review_link_videos", values: { id: ids.reviewMember, link_id: ids.reviewLink, video_id: ids.reviewVideo, project_id: ctx.projectId, added_by: ctx.userId, added_at: T0 } },
      { table: "review_link_version_grants", values: { id: ids.reviewGrant, link_id: ids.reviewLink, video_id: ids.reviewVideo, asset_id: ids.assetV1, granted_by: ctx.userId, granted_at: T0 } },
      { table: "guest_sessions", values: { id: ids.guestSession, token_hash: `qa-session-hash:${ctx.tag}`, link_id: ids.reviewLink, link_generation: 1, created_at: T0, expires_at: T0 + 86_400_000, last_seen_at: T0 } },
    );
  }
  if (want("jobs") && want("documents")) {
    rows.push({ table: "raw_reconciliation_claims", values: { id: ids.rawClaim, project_id: ctx.projectId, owner_job_id: ids.job, state: "completed", lease_expires_at: T0, trigger: "manual", created_at: T0, updated_at: T0 } });
  }
  if (want("audit")) {
    rows.push({ table: "project_subtask_reminder_occurrences", values: {
      id: ids.subtaskOcc, subtask_id: ctx.subtaskId, project_id: ctx.projectId, schedule_version: 1, kind: "due_now", reminder_offset_minutes: 0,
      fire_at: T0 + 86_400_000, due_at: T0 + 86_400_000, due_local_civil: "2026-09-30T17:00", due_zone: "Australia/Sydney", due_utc_offset_minutes: 600, due_fold: 0,
      status: "pending", created_by: ctx.userId, created_at: T0, updated_at: T0,
    } });
    const targetFor: Record<(typeof PROJECT_DESCENDANT_AUDIT_TYPES)[number], string> = {
      annotation: ids.annotation, asset: ids.assetV1, autohdr_mapping: ids.mapping, collection_link: ids.link, document_upload: ids.document, video_upload: ids.videoUpload, embedded_media: ids.embeddedMedia, job: ids.job, link_preview: ids.linkPreview,
      notification: ids.notification, notification_outbox: ids.outbox, project: ctx.projectId, project_comment: ids.comment,
      project_deadline_occurrence: ctx.occurrenceId, project_member: ids.member, project_subtask: ctx.subtaskId, project_subtask_reminder_occurrence: ids.subtaskOcc, raw_reconciliation_claim: ids.rawClaim,
      rendition_dlq_event: ids.dlq, review_link: ids.reviewLink, upload_manifest: ids.manifest,
    };
    const types = groups ? PROJECT_DESCENDANT_AUDIT_TYPES.filter((type) => type === "project_comment") : PROJECT_DESCENDANT_AUDIT_TYPES;
    for (const type of types) {
      rows.push({ table: "audit_log", values: { id: id(`audit:${type}`), actor_id: ctx.userId, action: `qa.${type}`, target_type: type, target_id: targetFor[type], meta_json: null, created_at: T0 } });
    }
    if (!groups || groups.includes("documents")) {
      rows.push({ table: "audit_log", values: { id: ids.documentAudit, actor_id: ctx.userId, action: "document.complete", target_type: "document_upload", target_id: ids.document, meta_json: null, created_at: T0 } });
    }
  }
  return rows;
}
