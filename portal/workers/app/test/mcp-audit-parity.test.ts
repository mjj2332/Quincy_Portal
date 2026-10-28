import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import type { McpPrincipal } from "../src/lib/mcp-dispatch-context";
import type { McpFetchApp } from "../src/mcp/dispatch";
import { MCP_TOOLS } from "../src/mcp/tools/registry";
import { seedVideoVersion, setVideoFlags } from "./video-review-support";
import { seedAsset, seedCoverage, seedDelivery, seedOpenDeadLetter, seedOrphanReport, seedPoisonEvent } from "./mcp-admin-fixtures";
import { seedGuestLink } from "./guest-support"; // #966
import { ids as fixtureIds } from "./embedded-media-support"; // #966

/**
 * Audit parity (#704, extended by #705): every write tool the MCP door lists must stamp provenance on every audit_log and
 * project_activity_events row it creates. Each call below drives the tool itself (so the route it dispatches to is the production
 * allowlist), and the completeness test fails when a write tool has neither a call nor a stated reason in NO_AUDIT_ROWS.
 * Later tickets (collaboration writes, admin) append to WRITE_CALLS and, only with a stated reason, to EXCEPTIONS.
 */

/** audit_log actions a write may create WITHOUT provenance, each with the reason. A listed action that never appears fails the run, so the list cannot go stale. */
const EXCEPTIONS: ReadonlyArray<{ action: string; reason: string }> = [
  { action: "project.deadline.automatic_set", reason: "System consequence (actor NULL, meta actor:system) of a fill or create. The person's own rows in the same batch carry provenance." },
];

const database = env as unknown as { DB: D1Database };
const testEnv = env as unknown as Env;
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const editorId = "b6000000-0000-4000-8000-000000000001";
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
const fetchApp: McpFetchApp = (request, e, c) => app.fetch(request, e, c);
const principal: McpPrincipal = { userId: adminId, connectionId: "conn-parity", clientName: "Parity Client", authorizationEpoch: 0 };
const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

type Setup = { projectId: string; [key: string]: string };
type WriteCall = {
  tool: string;
  stage?: string;
  archived?: boolean;
  /** Extra rows the call needs; returns ids the arguments can use. */
  setup?: (projectId: string) => Promise<Record<string, string>>;
  args: (ids: Setup) => Record<string, unknown>;
};

const insert = async (sql: string, ...bindings: unknown[]) => { await database.DB.prepare(sql).bind(...bindings).run(); };
const subtaskSetup = async (projectId: string) => {
  const created = async (title: string) => { const body = JSON.parse(await callTool("create_subtask", { projectId, title })) as { id?: string; subtask?: { id: string } }; return (body.subtask?.id ?? body.id)!; };
  return { subtaskId: await created("Parity"), otherId: await created("Other") };
};
const commentSetup = async (projectId: string) => {
  const created = JSON.parse(await callTool("add_project_comment", { projectId, text: "Seed" })) as { id: string };
  return { commentId: created.id };
};
const linkSetup = async (projectId: string) => {
  const first = JSON.parse(await callTool("add_video_link", { projectId, url: `https://example.test/${crypto.randomUUID()}` })) as { id: string };
  const second = JSON.parse(await callTool("add_video_link", { projectId, url: `https://example.test/${crypto.randomUUID()}` })) as { id: string };
  return { linkId: first.id, otherId: second.id };
};
const memberSetup = async (projectId: string) => {
  const membershipCycle = crypto.randomUUID();
  await insert("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)", membershipCycle, projectId, editorId, Date.now());
  return { membershipCycle };
};

const assetSetup = async (projectId: string) => {
  const collectionId = crypto.randomUUID(); const assetId = crypto.randomUUID(); const now = Date.now();
  await insert("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?)", collectionId, projectId, now, now);
  await insert("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'p.jpg', 10, 'upload', ?, ?)", assetId, collectionId, `parity/${assetId}.jpg`, now, now);
  return { assetId };
};
const annotationSetup = async (projectId: string) => {
  const { assetId } = await assetSetup(projectId);
  const created = JSON.parse(await callTool("create_annotation", { assetId, noteText: "Seed" })) as { id: string };
  return { assetId, annotationId: created.id };
};
const selectedSetup = async (projectId: string) => {
  const ids = await assetSetup(projectId);
  await callTool("select_asset_for_editing", ids);
  return ids;
};
const noticeSetup = async () => {
  const created = JSON.parse(await callTool("create_notice_post", { text: "Seed notice" })) as { post: { id: string } };
  return { postId: created.post.id };
};

/** Admin tools (#709): the rows each one's route writes, so the setups seed what the route needs. */
const agencySetup = async () => ({ agencyId: (JSON.parse(await callTool("admin_create_agency", { name: `Parity Agency ${crypto.randomUUID()}` })) as { id: string }).id });
const agentSetup = async () => ({ agentId: (JSON.parse(await callTool("admin_create_agent", { name: "Parity Agent" })) as { id: string }).id });
const jobSetup = async (projectId: string) => {
  const jobId = crypto.randomUUID(); const now = Date.now();
  await insert("INSERT INTO jobs (id, kind, status, project_id, retries, created_at, updated_at) VALUES (?, 'editor_sync', 'failed', ?, 0, ?, ?)", jobId, projectId, now, now);
  return { jobId };
};
const deadLetterSetup = async (projectId: string) => {
  const { assetId } = await assetSetup(projectId); const deadLetterId = crypto.randomUUID();
  await insert("INSERT INTO rendition_dlq_events (id, asset_id, status, received_at) VALUES (?, ?, 'open', ?)", deadLetterId, assetId, Date.now());
  const holder = testEnv as unknown as { RENDITIONS_ENABLED?: boolean; RENDITION_QUEUE?: unknown };
  holder.RENDITIONS_ENABLED = true; holder.RENDITION_QUEUE = { send: async () => undefined };
  return { deadLetterId };
};
const webhookSetup = async () => {
  const eventId = crypto.randomUUID();
  await insert("INSERT INTO webhook_events (id, source, event_id, payload_json, status, error, received_at, processed_at) VALUES (?, 'tonomo', ?, '{}', 'poison', 'boom', ?, ?)", eventId, `parity-${eventId}`, Date.now(), Date.now());
  return { eventId };
};
const coverageSetup = async (projectId: string) => { const seed = await seedCoverage(database.DB, projectId, adminId); return { handoffId: seed.handoffId, assetId: seed.assetId, readinessUnitKey: seed.readinessUnitKey }; };
const deliverySetup = async (projectId: string) => ({ outboxId: (await seedDelivery(database.DB, projectId, adminId)).outboxId });
const openDeadLetterSetup = async (projectId: string) => ({ deadLetterId: (await seedOpenDeadLetter(database.DB, projectId)).deadLetterId });
const poisonSetup = async () => ({ eventId: (await seedPoisonEvent(database.DB)).eventId });
const orphanSetup = async (projectId: string) => ({ watchId: (await seedOrphanReport(database.DB, projectId)).watchId });
const plainAssetSetup = async (projectId: string) => ({ assetId: (await seedAsset(database.DB, projectId)).assetId });
/** Social overlays (#970): a library row; for the Project's selection the Video review gate is opened for that Project. */
const overlaySetup = async () => {
  const overlayId = crypto.randomUUID(); const now = Date.now();
  await insert("INSERT INTO social_overlays (id, name, platform_label, image_key, width, height, bytes, is_default, created_by, updated_by, created_at, updated_at) VALUES (?, ?, 'Platform', ?, 1080, 1920, 100, 0, ?, ?, ?, ?)", overlayId, `Parity ${overlayId}`, `social-overlays/${overlayId}/${crypto.randomUUID()}.png`, adminId, adminId, now, now);
  return { overlayId };
};
const archivedOverlaySetup = async () => {
  const { overlayId } = await overlaySetup();
  await insert("UPDATE social_overlays SET archived_at = ?, archived_by = ? WHERE id = ?", Date.now(), adminId, overlayId);
  return { overlayId };
};
const projectOverlaySetup = async (projectId: string) => {
  const now = Date.now();
  await insert("INSERT INTO feature_flags (key, enabled, updated_at) VALUES ('video_review', 1, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1", now);
  await insert("INSERT INTO feature_flags (key, enabled, updated_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1", `video_review_pilot:${projectId}`, now);
  const { overlayId } = await overlaySetup();
  const state = JSON.parse(await callTool("get_project_social_overlays", { projectId })) as { revision: string };
  return { overlayId, revision: state.revision };
};
/** The first delete_project call returns the token the second one needs. */
const deleteSetup = async (projectId: string) => {
  const first = await callTool("delete_project", { projectId });
  return { confirmToken: /"confirmToken":\s*"([^"]+)"/.exec(first)![1]! };
};
/** Premium and Unlock (#969): a Video (no Version needed) and a photo, both unpublished and Premium; the Unlock setup takes the first call's token. */
const premiumVideoSetup = async (projectId: string) => {
  const collectionId = crypto.randomUUID(); const videoId = crypto.randomUUID(); const now = Date.now();
  await insert("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'video', 'empty', 0, ?, ?)", collectionId, projectId, now, now);
  await insert("INSERT INTO videos (id, project_id, collection_id, title, premium, position, created_by, created_at, updated_at) VALUES (?, ?, ?, 'Parity film', 1, 0, ?, ?, ?)", videoId, projectId, collectionId, adminId, now, now);
  return { videoId };
};
const premiumPhotoSetup = async (projectId: string) => {
  const collectionId = crypto.randomUUID(); const assetId = crypto.randomUUID(); const now = Date.now();
  await insert("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'edited', 'empty', 0, ?, ?)", collectionId, projectId, now, now);
  await insert("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version, delivery_premium, publish_status, created_at, updated_at) VALUES (?, ?, 'photo', ?, 'p.jpg', 10, 'upload', 1, 1, 'ready', ?, ?)", assetId, collectionId, `parity/${assetId}.jpg`, now, now);
  return { assetId };
};
const unlockSetup = (tool: string, seed: (projectId: string) => Promise<Record<string, string>>) => async (projectId: string) => {
  const ids = await seed(projectId);
  const first = await callTool(tool, { projectId, ...ids, unlocked: true });
  return { ...ids, confirmToken: /"confirmToken":\s*"([^"]+)"/.exec(first)![1]! };
};
const editorCandidate = {
  projectId: "00000000-0000-4000-8000-000000000001", connectionId: "dbx-1", expectedShootDate: "2037-01-02", expectedRawFolderPath: null, expectedRawFolderLink: null,
  rootPath: "/Editors/Parity", rootFolderId: "id:root",
  inputRoots: [{ path: "/Editors/Parity/Input", section: null, folderId: "id:in" }], outputRoots: [{ path: "/Editors/Parity/Output", section: null, folderId: "id:out" }],
};

/** Video and Version management (#965): a Video of `versions` Versions on the call's Project, the older ones superseded as upload completion leaves them. */
const videoSetup = (versions: number, trashed: "none" | "version" | "video" = "none") => async (projectId: string) => {
  const first = await seedVideoVersion({ projectId, uploader: adminId, version: 1 });
  const all = [first];
  for (let version = 2; version <= versions; version += 1) all.push(await seedVideoVersion({ projectId, videoId: first.videoId, uploader: adminId, version }));
  for (let i = 0; i < all.length - 1; i += 1) await database.DB.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ? WHERE id = ?").bind(Date.now(), all[i + 1]!.assetId, all[i]!.assetId).run();
  const zero = { notes: 0, decisions: 0, release: false, links: 0 };
  if (trashed === "version") await callTool("remove_video_version", { projectId, assetId: first.assetId, expected: zero, removeVideo: false });
  if (trashed === "video") await callTool("delete_video", { projectId, videoId: first.videoId, expected: { assetIds: all.map((version) => version.assetId), notes: 0, decisions: 0, releases: 0, links: 0 } });
  return { videoId: first.videoId, firstAssetId: first.assetId, latestAssetId: all[all.length - 1]!.assetId, allAssetIds: all.map((version) => version.assetId).join(",") };
};
/** Video note writes (#964): a live Version on the call's Project, and a note on it written through the tool. */
const videoVersionSetup = async (projectId: string) => ({ assetId: (await seedVideoVersion({ projectId, uploader: adminId })).assetId });
const videoNoteSetup = async (projectId: string) => {
  const { assetId } = await videoVersionSetup(projectId);
  const created = JSON.parse(await callTool("create_video_note", { projectId, assetId, visibility: "internal", body: "Seed", startFrame: 1 })) as { thread: { id: string } };
  return { assetId, noteId: created.thread.id };
};

const WRITE_CALLS: readonly WriteCall[] = [
  { tool: "admin_reset_dropbox_monitor", args: () => ({ scope: "raw" }) },
  { tool: "admin_link_editor_folder", args: () => ({ reviewed: true, candidate: editorCandidate }) },
  { tool: "admin_send_to_autohdr", args: ({ projectId }) => ({ projectId }) },
  { tool: "admin_fetch_edited_from_autohdr", args: ({ projectId }) => ({ projectId }) },
  { tool: "admin_retry_job", setup: jobSetup, args: ({ jobId }) => ({ jobId: jobId! }) },
  { tool: "admin_replay_dead_letter", setup: deadLetterSetup, args: ({ deadLetterId }) => ({ deadLetterId: deadLetterId! }) },
  { tool: "admin_retry_webhook_event", setup: webhookSetup, args: ({ eventId }) => ({ eventId: eventId! }) },
  { tool: "admin_create_agency", args: () => ({ name: `Parity Agency ${crypto.randomUUID()}` }) },
  { tool: "admin_update_agency", setup: agencySetup, args: ({ agencyId }) => ({ agencyId: agencyId!, notes: "Parity" }) },
  { tool: "admin_create_agent", args: () => ({ name: "Parity Agent" }) },
  { tool: "admin_update_agent", setup: agentSetup, args: ({ agentId }) => ({ agentId: agentId!, phone: "0400 000 000" }) },
  { tool: "admin_update_stage", args: () => ({ key: "raw_review", label: "Raw review" }) },
  { tool: "admin_backfill_renditions", args: () => ({ dryRun: true, limit: 1 }) },
  { tool: "admin_backfill_autohdr", args: () => ({ dryRun: true, limit: 1 }) },
  { tool: "admin_backfill_autohdr_scaffolds", args: () => ({ dryRun: true, limit: 1 }) },
  { tool: "admin_sync_project_dropbox", args: ({ projectId }) => ({ projectId }) },
  { tool: "admin_resolve_autohdr_coverage", setup: coverageSetup, args: ({ projectId, handoffId, assetId, readinessUnitKey }) => ({ projectId, handoffId: handoffId!, assetId: assetId!, readinessUnitKey: readinessUnitKey! }) },
  { tool: "admin_replay_notification_delivery", setup: deliverySetup, args: ({ outboxId }) => ({ outboxId: outboxId!, channels: ["email"] }) },
  { tool: "admin_discard_notification_delivery", setup: deliverySetup, args: ({ outboxId }) => ({ outboxId: outboxId! }) },
  { tool: "admin_discard_dead_letter", setup: openDeadLetterSetup, args: ({ deadLetterId }) => ({ deadLetterId: deadLetterId! }) },
  { tool: "admin_discard_webhook_event", setup: poisonSetup, args: ({ eventId }) => ({ eventId: eventId! }) },
  { tool: "admin_acknowledge_orphan_file_report", setup: orphanSetup, args: ({ watchId }) => ({ watchId: watchId! }) },
  { tool: "admin_delete_asset", setup: plainAssetSetup, args: ({ assetId }) => ({ assetId: assetId! }) },
  { tool: "delete_project", stage: "edited_review", archived: true, setup: deleteSetup, args: ({ projectId, confirmToken }) => ({ projectId, confirm: true, confirmToken: confirmToken! }) },
  { tool: "create_project", args: () => ({ street: "Parity Created", shootDate: "2037-05-04" }) },
  { tool: "update_project_details", stage: "edited_review", args: ({ projectId }) => ({ projectId, suburb: "Parity", shootDate: "2037-06-01" }) },
  { tool: "set_project_priority", stage: "edited_review", args: ({ projectId }) => ({ projectId, priority: 2 }) },
  { tool: "set_project_deadline", stage: "edited_review", args: ({ projectId }) => ({ projectId, expectedVersion: 0, deadline: { localCivil: "2037-02-15T09:00" }, reminderOffsetsMinutes: [60] }) },
  { tool: "add_project_editor", stage: "edited_review", args: ({ projectId }) => ({ projectId, userId: editorId }) },
  { tool: "remove_project_editor", stage: "edited_review", setup: memberSetup, args: ({ projectId, membershipCycle }) => ({ projectId, userId: editorId, membershipCycle: membershipCycle! }) },
  { tool: "move_project_stage", stage: "awaiting_raw", args: ({ projectId }) => ({ projectId, expectedStageKey: "awaiting_raw", expectedBoardRevision: 0, targetStageKey: "raw_review" }) },
  { tool: "archive_project", stage: "edited_review", args: ({ projectId }) => ({ projectId }) },
  { tool: "restore_project", stage: "edited_review", archived: true, args: ({ projectId }) => ({ projectId }) },
  { tool: "create_subtask", stage: "edited_review", args: ({ projectId }) => ({ projectId, title: "Parity subtask" }) },
  { tool: "update_subtask", stage: "edited_review", setup: subtaskSetup, args: ({ projectId, subtaskId }) => ({ projectId, subtaskId: subtaskId!, title: "Renamed", done: true }) },
  { tool: "reorder_subtask", stage: "edited_review", setup: subtaskSetup, args: ({ projectId, subtaskId, otherId }) => ({ projectId, subtaskId: subtaskId!, beforeId: otherId!, afterId: null }) },
  { tool: "delete_subtask", stage: "edited_review", setup: subtaskSetup, args: ({ projectId, subtaskId }) => ({ projectId, subtaskId: subtaskId! }) },
  { tool: "add_project_comment", stage: "edited_review", args: ({ projectId }) => ({ projectId, text: "Parity comment" }) },
  { tool: "edit_project_comment", stage: "edited_review", setup: commentSetup, args: ({ projectId, commentId }) => ({ projectId, commentId: commentId!, text: "Edited" }) },
  { tool: "delete_project_comment", stage: "edited_review", setup: commentSetup, args: ({ projectId, commentId }) => ({ projectId, commentId: commentId! }) },
  { tool: "add_video_link", stage: "edited_review", args: ({ projectId }) => ({ projectId, url: "https://example.test/parity", label: "Parity" }) },
  { tool: "update_video_link", stage: "edited_review", setup: linkSetup, args: ({ projectId, linkId }) => ({ projectId, linkId: linkId!, url: "https://example.test/parity-b" }) },
  { tool: "reorder_video_link", stage: "edited_review", setup: linkSetup, args: ({ projectId, linkId, otherId }) => ({ projectId, linkId: linkId!, beforeId: otherId!, afterId: null }) },
  { tool: "remove_video_link", stage: "edited_review", setup: linkSetup, args: ({ projectId, linkId }) => ({ projectId, linkId: linkId! }) },
  { tool: "create_annotation", stage: "edited_review", setup: assetSetup, args: ({ assetId }) => ({ assetId: assetId!, noteText: "Parity note" }) },
  { tool: "edit_annotation", stage: "edited_review", setup: annotationSetup, args: ({ annotationId }) => ({ annotationId: annotationId!, noteText: "Edited" }) },
  { tool: "delete_annotation", stage: "edited_review", setup: annotationSetup, args: ({ annotationId }) => ({ annotationId: annotationId! }) },
  { tool: "create_notice_post", args: () => ({ text: "Parity notice" }) },
  { tool: "edit_notice_post", setup: noticeSetup, args: ({ postId }) => ({ postId: postId!, text: "Edited notice" }) },
  { tool: "delete_notice_post", setup: noticeSetup, args: ({ postId }) => ({ postId: postId! }) },
  { tool: "set_asset_review", stage: "edited_review", setup: assetSetup, args: ({ assetId }) => ({ assetId: assetId!, stars: 3 }) },
  { tool: "select_asset_for_editing", stage: "edited_review", setup: assetSetup, args: ({ assetId }) => ({ assetId: assetId! }) },
  { tool: "unselect_asset_for_editing", stage: "edited_review", setup: selectedSetup, args: ({ assetId }) => ({ assetId: assetId! }) },
  { tool: "request_project_link_preview", stage: "edited_review", args: ({ projectId }) => ({ projectId, url: "https://example.com/parity-preview" }) },
  { tool: "request_notice_link_preview", args: () => ({ url: "https://example.com/parity-notice-preview" }) },
  { tool: "edit_project_whiteboard", stage: "edited_review", args: ({ projectId }) => ({ projectId, expectedGeneration: 1, edits: [{ op: "add_text", x: 0, y: 0, text: "Parity whiteboard" }] }) },  { tool: "update_notification_preferences", args: () => ({ emailDigestCadence: "daily" }) }, // #971
  { tool: "admin_sync_delivery_review_links", args: () => ({ cursor: "ffffffff-ffff-4fff-bfff-ffffffffffff" }) }, // #973
  { tool: "admin_reprobe_video_versions", args: () => ({ dryRun: false, limit: 1 }) }, // #973
  { tool: "admin_set_project_cover", args: ({ projectId }) => ({ projectId, assetId: null }) }, // #973
  // #973: a Photographer user (and, for the removal, their membership) seeded inline so this block stays append-only.
  { tool: "admin_add_project_photographer", setup: async () => {
    const userId = crypto.randomUUID(); const now = Date.now();
    await insert("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Parity Photographer', ?, 1, 'photographer', 1, ?, ?)", userId, `${userId}@example.test`, now, now);
    return { userId };
  }, args: ({ projectId, userId }) => ({ projectId, userId: userId! }) },
  { tool: "admin_remove_project_photographer", setup: async (projectId) => {
    const userId = crypto.randomUUID(); const membershipCycle = crypto.randomUUID(); const now = Date.now();
    await insert("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Parity Photographer', ?, 1, 'photographer', 1, ?, ?)", userId, `${userId}@example.test`, now, now);
    await insert("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)", membershipCycle, projectId, userId, now);
    return { userId, membershipCycle };
  }, args: ({ projectId, userId, membershipCycle }) => ({ projectId, userId: userId!, membershipCycle: membershipCycle! }) },
  // Video and Version management (#965)
  { tool: "set_version_review_status", setup: videoSetup(1), args: ({ projectId, latestAssetId }) => ({ projectId, assetId: latestAssetId!, reviewStatus: "approved_internal", expectedStatus: "in_review" }) },
  { tool: "rename_video_version", setup: videoSetup(1), args: ({ projectId, latestAssetId }) => ({ projectId, assetId: latestAssetId!, filename: "renamed-cut.mp4" }) },
  { tool: "remove_video_version", setup: videoSetup(2), args: ({ projectId, firstAssetId }) => ({ projectId, assetId: firstAssetId!, expected: { notes: 0, decisions: 0, release: false, links: 0 }, removeVideo: false }) },
  { tool: "delete_video", setup: videoSetup(2), args: ({ projectId, videoId, allAssetIds }) => ({ projectId, videoId: videoId!, expected: { assetIds: allAssetIds!.split(","), notes: 0, decisions: 0, releases: 0, links: 0 } }) },
  { tool: "restore_video_version", setup: videoSetup(2, "version"), args: ({ projectId, firstAssetId }) => ({ projectId, assetId: firstAssetId! }) },
  { tool: "restore_video", setup: videoSetup(2, "video"), args: ({ projectId, videoId }) => ({ projectId, videoId: videoId! }) },
  // Video note writes (#964)
  { tool: "create_video_note", setup: videoVersionSetup, args: ({ projectId, assetId }) => ({ projectId, assetId: assetId!, visibility: "public", body: "Parity note", startTimecode: "0:01" }) },
  { tool: "reply_to_video_note", setup: videoNoteSetup, args: ({ projectId, noteId }) => ({ projectId, noteId: noteId!, body: "Parity reply" }) },
  { tool: "edit_video_note", setup: videoNoteSetup, args: ({ projectId, noteId }) => ({ projectId, noteId: noteId!, expectedRevision: 1, body: "Parity edit" }) },
  { tool: "delete_video_note", setup: videoNoteSetup, args: ({ projectId, noteId }) => ({ projectId, noteId: noteId!, expectedRevision: 1 }) },
  { tool: "set_video_note_resolution", setup: videoNoteSetup, args: ({ projectId, noteId }) => ({ projectId, noteId: noteId!, resolved: true }) },
  // Review links (#966): helpers are function declarations at the end of this file.
  { tool: "create_review_link", setup: reviewLinkVideoSetup, args: ({ projectId, videoId }) => ({ projectId, videoIds: [videoId!], label: "Parity link", passcode: "parity-pass" }) },
  { tool: "update_review_link", setup: reviewLinkSetup, args: ({ projectId, linkId }) => ({ projectId, linkId: linkId!, label: "Edited link" }) },
  { tool: "add_review_link_video", setup: reviewLinkSecondVideoSetup, args: ({ projectId, linkId, otherVideoId, otherAssetId }) => ({ projectId, linkId: linkId!, videoId: otherVideoId!, assetIds: [otherAssetId!] }) },
  { tool: "remove_review_link_video", setup: reviewLinkSetup, args: ({ projectId, linkId, videoId }) => ({ projectId, linkId: linkId!, videoId: videoId! }) },
  { tool: "set_review_link_grants", setup: reviewLinkSetup, args: ({ projectId, linkId, videoId, assetId }) => ({ projectId, linkId: linkId!, videoId: videoId!, assetIds: [assetId!] }) },
  { tool: "revoke_review_link", setup: reviewLinkSetup, args: ({ projectId, linkId }) => ({ projectId, linkId: linkId!, confirm: true }) },
  { tool: "replace_review_link", setup: reviewLinkSetup, args: ({ projectId, linkId }) => ({ projectId, linkId: linkId!, confirm: true }) },
  { tool: "delete_review_link", setup: revokedReviewLinkSetup, args: ({ projectId, linkId }) => ({ projectId, linkId: linkId!, confirm: true }) },
  { tool: "end_review_link_guest_sessions", setup: deliveryReviewLinkSetup, args: ({ projectId, linkId }) => ({ projectId, linkId: linkId!, confirm: true }) },
  { tool: "admin_update_social_overlay", setup: overlaySetup, args: ({ overlayId }) => ({ id: overlayId!, name: "Parity renamed", expectedRevision: 1 }) }, // #970
  { tool: "admin_archive_social_overlay", setup: overlaySetup, args: ({ overlayId }) => ({ id: overlayId!, expectedRevision: 1 }) }, // #970
  { tool: "admin_unarchive_social_overlay", setup: archivedOverlaySetup, args: ({ overlayId }) => ({ id: overlayId!, expectedRevision: 1 }) }, // #970
  { tool: "set_project_social_overlays", setup: projectOverlaySetup, args: ({ projectId, overlayId, revision }) => ({ projectId, overlayIds: [overlayId!], expectedRevision: revision! }) }, // #970
  // #969: premium is seeded on, so each premium call unmarks (an unpublished item) and writes its row.
  { tool: "set_video_premium", setup: premiumVideoSetup, args: ({ projectId, videoId }) => ({ projectId, videoId: videoId!, premium: false }) },
  { tool: "set_delivery_video_premium", setup: premiumVideoSetup, args: ({ projectId, videoId }) => ({ projectId, videoId: videoId!, premium: false }) },
  { tool: "set_asset_premium", setup: premiumPhotoSetup, args: ({ projectId, assetId }) => ({ projectId, assetId: assetId!, premium: false }) },
  { tool: "set_video_premium_unlock", setup: unlockSetup("set_video_premium_unlock", premiumVideoSetup), args: ({ projectId, videoId, confirmToken }) => ({ projectId, videoId: videoId!, unlocked: true, confirm: true, confirmToken: confirmToken! }) },
  { tool: "set_delivery_video_premium_unlock", setup: unlockSetup("set_delivery_video_premium_unlock", premiumVideoSetup), args: ({ projectId, videoId, confirmToken }) => ({ projectId, videoId: videoId!, unlocked: true, confirm: true, confirmToken: confirmToken! }) },
  { tool: "set_asset_premium_unlock", setup: unlockSetup("set_asset_premium_unlock", premiumPhotoSetup), args: ({ projectId, assetId, confirmToken }) => ({ projectId, assetId: assetId!, unlocked: true, confirm: true, confirmToken: confirmToken! }) },
];

/** Write tools whose route writes no audit_log or activity row at all (so there is nothing to stamp), each with the reason. */
const NO_AUDIT_ROWS: ReadonlyArray<{ tool: string; reason: string }> = [
  { tool: "admin_resolve_autohdr_mapping", reason: "The audit row is written by the background Worker, not the route. Its via is asserted in workers/background/test/autohdr-mapping.test.ts, and the app's hand-off in mcp-admin.test.ts." },
  { tool: "admin_reassign_autohdr_path_claim", reason: "The audit row is written by the background Worker, not the route. Its via is asserted in workers/background/test/autohdr-mapping.test.ts, and the app's hand-off in mcp-admin.test.ts." },
  { tool: "mark_notification_read", reason: "The notifications read route only sets read_at; it writes no audit row." },
  { tool: "mark_all_notifications_read", reason: "The notifications read-all route only sets read_at; it writes no audit row." },
];

const mcpTool = (name: string) => MCP_TOOLS.find((tool) => tool.name === name)!;
async function callTool(name: string, args: Record<string, unknown>) {
  const result = await mcpTool(name).call({ env: testEnv, executionCtx: ctx, fetchApp, principal, role: "admin" }, args);
  expect(result.isError, `${name}: ${result.content[0]!.text}`).toBeUndefined();
  return result.content[0]!.text;
}
/** The background Worker's page fetch, answered locally: a link preview only writes its audit row once a page was fetched. */
/** The background Worker's RPC surface, answered locally for the admin tools: the route's audit row is what is under test. */
const adminFakeBackground = new Proxy({}, {
  get: (_target, name) => typeof name !== "string" || name === "then" ? undefined : async () => (({
    triggerDropboxSync: { jobId: "job" }, sendSelectedToAutoHdr: { ok: true, jobId: "job" }, fetchEditedFromAutoHdr: { ok: true, jobId: "job" }, triggerEditorSync: { jobId: "job" },
    backfillRenditions: { scanned: 0, wouldEnqueue: 0, enqueued: 0, skipped: 0, nextCursor: null, dryRun: true }, backfillAutoHdrV2: { scanned: 0 },
  } as Record<string, unknown>)[name] ?? {}),
});
const fakeBackground = { fetchLinkPreview: async () => ({ ok: true as const, finalUrl: "https://example.com/parity", title: "Parity", description: null, siteName: null, image: null }) };
async function callToolRaw(name: string, args: Record<string, unknown>) {
  const holder = testEnv as unknown as { BACKGROUND: unknown };
  const original = holder.BACKGROUND;
  if (name.endsWith("link_preview")) holder.BACKGROUND = fakeBackground;
  else if (mcpTool(name).scope === "admin") holder.BACKGROUND = adminFakeBackground;
  try { return await mcpTool(name).call({ env: testEnv, executionCtx: ctx, fetchApp, principal, role: "admin" }, args); }
  finally { holder.BACKGROUND = original; }
}

async function executeSql(sql: string): Promise<void> {
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const withoutComments = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of withoutComments.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

const maxRowid = async (table: "audit_log" | "project_activity_events") =>
  (await database.DB.prepare(`SELECT COALESCE(MAX(rowid), 0) AS n FROM ${table}`).first<{ n: number }>())!.n;

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await database.DB.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Parity Editor', 'parity-editor@example.test', 1, 'editor', 1, ?, ?)").bind(editorId, now, now).run();
  await setVideoFlags("video_review", "video_review_all_projects", "video_review_trash", "video_review_notes"); // #965
  await database.DB.batch([
    database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'"),
    database.DB.prepare("INSERT INTO mcp_connections (id, user_id, client_id, client_name, redirect_host, scopes, authorization_epoch, created_at) VALUES ('conn-parity', ?, 'client-1', 'Parity Client', 'client.example.test', '[\"write\"]', 0, ?)").bind(adminId, now),
    database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES ('mcp_access', 1, NULL, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1").bind(now),
    // #969: the Video review `delivery` part and the Client Delivery gate, which the premium routes check.
    ...["video_review", "video_review_all_projects", "video_review_delivery", "client_delivery", "client_delivery_all_projects"].map((key) => database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES (?, 1, NULL, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1").bind(key, now)),
  ]);
  await setVideoFlags("video_review", "video_review_all_projects", "video_review_notes", "video_review_markup"); // #964
});

describe("every row an MCP write creates carries provenance", () => {
  const seen = new Set<string>();

  it("covers every write tool", () => {
    const writes = MCP_TOOLS.filter((tool) => tool.annotations.readOnlyHint === false).map((tool) => tool.name).sort();
    expect([...WRITE_CALLS.map((call) => call.tool), ...NO_AUDIT_ROWS.map((entry) => entry.tool)].sort()).toEqual(writes);
  });

  for (const call of WRITE_CALLS) {
    it(call.tool, async () => {
      const projectId = crypto.randomUUID();
      const now = Date.now();
      await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_revision, archived_at, created_at, updated_at) VALUES (?, 'Parity Street', ?, 0, ?, ?, ?)").bind(projectId, call.stage ?? "edited_review", call.archived ? now : null, now, now).run();
      const ids: Setup = { projectId, ...(call.setup ? await call.setup(projectId) : {}) };
      const [auditMark, activityMark] = [await maxRowid("audit_log"), await maxRowid("project_activity_events")];
      const result = await callToolRaw(call.tool, call.args(ids));
      expect(result.isError, `${call.tool}: ${result.content[0]!.text}`).toBeUndefined();

      const audit = (await database.DB.prepare("SELECT action, meta_json FROM audit_log WHERE rowid > ? ORDER BY rowid").bind(auditMark).all<{ action: string; meta_json: string | null }>()).results;
      const activity = (await database.DB.prepare("SELECT event_type, via_client FROM project_activity_events WHERE rowid > ? ORDER BY rowid").bind(activityMark).all<{ event_type: string; via_client: string | null }>()).results;
      expect(audit.length, `${call.tool}: audit rows`).toBeGreaterThan(0);
      const covered = audit.filter((row) => !EXCEPTIONS.some((exception) => exception.action === row.action));
      expect(covered.length).toBeGreaterThan(0);
      for (const row of audit) {
        if (EXCEPTIONS.some((exception) => exception.action === row.action)) { seen.add(row.action); continue; }
        const meta = row.meta_json ? JSON.parse(row.meta_json) as Record<string, unknown> : {};
        expect(meta, `${call.tool}: audit ${row.action}`).toMatchObject({ via: "mcp", client: "Parity Client", connectionId: "conn-parity" });
      }
      for (const row of activity) expect(row.via_client, `${call.tool}: activity ${row.event_type}`).toBe("Parity Client");
    });
  }

  it("lists no exception that no call exercised", () => {
    expect([...seen].sort()).toEqual(EXCEPTIONS.map((exception) => exception.action).sort());
  });
});

/** Review links (#966): the Project's video review gate with the links part, and one committed Version. */
async function reviewLinkVideoSetup(projectId: string) {
  await setVideoFlags("video_review", "video_review_links", `video_review_pilot:${projectId}`);
  const version = await seedVideoVersion({ projectId, uploader: adminId });
  return { videoId: version.videoId, assetId: version.assetId };
}
async function reviewLinkSetup(projectId: string) {
  const video = await reviewLinkVideoSetup(projectId);
  const created = JSON.parse(await callTool("create_review_link", { projectId, videoIds: [video.videoId] })) as { link: { id: string } };
  return { ...video, linkId: created.link.id };
}
async function reviewLinkSecondVideoSetup(projectId: string) {
  const link = await reviewLinkSetup(projectId);
  const other = await seedVideoVersion({ projectId, uploader: adminId, title: "Second cut" });
  return { ...link, otherVideoId: other.videoId, otherAssetId: other.assetId };
}
async function revokedReviewLinkSetup(projectId: string) {
  const link = await reviewLinkSetup(projectId);
  await callTool("revoke_review_link", { projectId, linkId: link.linkId, confirm: true });
  return link;
}
/** The Delivery review link (End guest sessions' only target). Its seed names the embedded-media fixture's member as creator, so that user is added here. */
async function deliveryReviewLinkSetup(projectId: string) {
  await setVideoFlags("video_review", `video_review_pilot:${projectId}`);
  const now = Date.now();
  await database.DB.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Fixture Member', 'fixture-member@example.test', 1, 'editor', 1, ?, ?)").bind(fixtureIds.member, now, now).run();
  const link = await seedGuestLink({ projectId, deliveryReview: true });
  return { linkId: link.id };
}
