import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyEmailError } from "../../../workers/background/src/notification-delivery";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const migration = read("../migrations/0031_notification_outbox_and_delivery_ledger.sql");
const comments = read("../../../workers/app/src/lib/project-comments.ts");
const commentRoutes = read("../../../workers/app/src/routes/project-comments.ts");
const noticeRoutes = read("../../../workers/app/src/routes/notice-board.ts");
const notifications = read("../../../workers/app/src/lib/notifications.ts");
const projects = read("../../../workers/app/src/routes/projects.ts");
const projectMembers = read("../../../workers/app/src/lib/project-members.ts");
const sharedOutbox = read("../../../packages/shared/src/notification-outbox.ts");
const delivery = read("../../../workers/background/src/notification-delivery.ts");
const backgroundConfig = read("../../../workers/background/wrangler.jsonc");
const appConfig = read("../../../workers/app/wrangler.jsonc");
const admin = read("../../../workers/app/src/routes/admin.ts");
const adminUi = read("../../../apps/web/src/screens/Admin.tsx");

describe("TB4 implementation contracts", () => {
  it("1. keeps migration 0031 additive with seven named indexes and three unique constraints", () => {
    expect(migration).not.toMatch(/\b(DROP TABLE|ALTER TABLE|PRAGMA)\b/i);
    expect((migration.match(/CREATE INDEX /g) ?? []).length).toBe(7);
    expect((migration.match(/UNIQUE \(/g) ?? []).length).toBe(3);
    expect(migration).toContain("notification_delivery_ledger_notification_idx");
  });

  it("2. keeps comment mutation statement ordering and the changes audit pattern", () => {
    for (const functionBody of [comments.slice(comments.indexOf("export async function createProjectComment")), comments.slice(comments.indexOf("export async function editProjectComment"))]) {
      expect(functionBody).toContain("createProjectCommentActivityIntent");
      expect(functionBody).toContain("WHERE changes() = 1");
      expect(functionBody).toContain("await db.batch(");
    }
    const deleteBody = comments.slice(comments.indexOf("export async function deleteProjectComment"));
    expect(deleteBody).toContain("createProjectCommentActivityIntent");
    expect(deleteBody).toContain("await db.batch(");
    // The JS-level DELETE result's .meta.changes includes cascade-deleted
    // project_comment_mentions rows, so the outer <1 check accepts any positive value. The
    // SQL-level changes() function used by the audit guard excludes cascades, so =1 is correct.
    expect(deleteBody).toContain("WHERE changes() = 1");
    const create = comments.slice(comments.indexOf("export async function createProjectComment"));
    expect(create.indexOf("INSERT INTO project_comments")).toBeLessThan(create.indexOf("INSERT INTO project_comment_mentions"));
    expect(create.indexOf("INSERT INTO project_comment_mentions")).toBeLessThan(create.indexOf("project_comment.create"));
    expect(create.indexOf("project_comment.create")).toBeLessThan(create.indexOf("mentionOutboxStatements"));
  });

  it("3. persists one safe activity envelope with only the mention occurrence snapshot", () => {
    expect(comments).toContain("authorizationAtOccurrence");
    expect(comments).toContain(".sort();");
    expect(comments).toContain('targetedMentionDelivery: false');
    expect(comments).toContain("projectCommentActivity: activity");
    expect(comments).not.toContain("recipientEmail");
    expect(comments).not.toContain("payload: { body");
  });

  it("4. has one project-assignment outbox producer and leaves Notice Board direct", () => {
    expect(commentRoutes).not.toContain("notifyMentions");
    expect(commentRoutes).toContain("waitUntil(publishNotificationOutbox");
    expect(noticeRoutes).toContain("notifyNoticeBoardMentions");
    expect(notifications).toContain("notifyNoticeBoardMentions");
    expect(notifications).not.toContain("notifyProjectAssignments");
    expect(projects).not.toContain("notifyProjectAssignments");
    expect(projectMembers).toContain("NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated");
    expect((projectMembers.match(/NOTIFICATION_OUTBOX_EVENT_TYPES\.projectAssignmentCreated/g) ?? []).length).toBeGreaterThan(0);
    const assignmentProducerOwners = [notifications, projects, projectMembers]
      .filter((source) => source.includes("NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated"));
    expect(assignmentProducerOwners).toHaveLength(1);
    expect(notifications).toContain("notifySubtaskAssignee");
  });

  it("5. publishes after commit, records acceptance, and preserves pending intent on rejection", () => {
    expect(sharedOutbox).toContain('await queue.send({ type: "notification_outbox", outboxId });');
    expect(sharedOutbox).toContain("status IN ('pending', 'queued')");
    expect(sharedOutbox).toContain("queue_publish_failed");
    expect(commentRoutes).toContain("c.executionCtx.waitUntil");
  });

  it("6. uses the claim and in-app reclaim as one ordered lease-token batch", () => {
    expect(delivery).toContain("const results = await env.DB.batch([\n    env.DB.prepare(`\n      UPDATE notification_outbox");
    expect(delivery).toContain("RETURNING *");
    expect(delivery).toContain("channel = 'in_app'");
    expect(delivery).toContain("o.lease_token = ?");
    expect(delivery).toContain("available_at <= ?");
  });

  it("7. reauthorizes active role/capability/membership and exact comment visibility", () => {
    for (const term of ["recipient.active", "roleHasCapability", "project_members", "authorizationAtOccurrence", "mention.id", "comment.project_id", "project.street", "author.name"]) {
      expect(delivery).toContain(term);
    }
    expect(delivery).toContain("recipient_ineligible");
    expect(delivery).toContain("membership_cycle_changed");
  });

  it("8. suppresses silently with an audit and reauthorizes immediately before each channel", () => {
    expect(delivery).toContain("notification.delivery.suppressed");
    expect(delivery).toContain("message.ack();");
    expect(delivery.indexOf("const secondResolution = await resolveRecipient")).toBeLessThan(delivery.indexOf("INSERT INTO notifications"));
    expect(delivery.indexOf("const reauthorized = await resolveRecipient")).toBeLessThan(delivery.indexOf("beginChannel(env, outbox, token, \"email\""));
  });

  it("9. classifies only quota errors as automatic retry and internal errors as unknown", () => {
    expect(classifyEmailError({ code: "E_RATE_LIMIT_EXCEEDED" }).kind).toBe("quota_transient");
    expect(classifyEmailError({ code: "E_DAILY_LIMIT_EXCEEDED" }).kind).toBe("quota_transient");
    expect(classifyEmailError({ code: "E_INTERNAL_SERVER_ERROR" })).toMatchObject({ kind: "unknown", code: "email_acceptance_unknown" });
    expect(classifyEmailError(new Error("uncoded")).kind).toBe("unknown");
    expect(delivery).toContain("retryDelaySeconds(messageAttempts)");
  });

  it("10. never launders an email processing attempt into failed or discarded", () => {
    expect(delivery).toContain("classification.code");
    expect(delivery).toContain("channel = 'email' AND status = 'processing'");
    expect(delivery).toContain("channel = 'email' AND status = 'pending'");
    expect(admin).toContain("channel = 'email' AND status IN ('processing', 'unknown') THEN 'unknown'");
    expect(delivery).toContain("SET status = 'unknown'");
    expect(admin).toContain("delivery_active");
    expect(admin).toContain("channel = 'email' AND status IN ('processing', 'unknown') THEN 'unknown'");
    expect(admin).toContain("status != 'discarded'");
  });

  it("11. configures the main notification Queue and separate DLQ with the approved retry policy", () => {
    expect(backgroundConfig).toContain('"queue": "quincy-notifications", "max_batch_size": 1, "max_concurrency": 1, "max_retries": 3, "dead_letter_queue": "quincy-notifications-dlq"');
    expect(backgroundConfig).toContain('"queue": "quincy-notifications-dlq", "max_batch_size": 10, "max_retries": 3');
    expect(appConfig).toContain('{ "binding": "NOTIFICATION_QUEUE", "queue": "quincy-notifications" }');
  });

  it("12. performs the four bounded Cron recovery phases with both due fences", () => {
    expect(delivery).toContain("await env.DB.batch([");
    expect(delivery).toContain("In-app delivery lease expired before completion.");
    expect(delivery).toContain("Delivery lease expired before an ambiguous email attempt.");
    expect(delivery).toContain("queue_published_at <= ? AND available_at <= ?");
    expect(delivery).toContain("LIMIT ${NOTIFICATION_RECOVERY_LIMIT}");
    expect(delivery).toContain("export const NOTIFICATION_RECOVERY_LIMIT = 100");
  });

  it("13. keeps Admin delivery views paginated, content-free, and acknowledgement-gated", () => {
    for (const view of ["pending_stuck", "dlq", "failed", "unknown"]) expect(admin).toContain(view);
    expect(admin).toContain("/admin/notification-deliveries");
    expect(admin).toContain("safeNotificationErrorCode");
    expect(admin).not.toContain("payload_json");
    expect(admin).not.toContain("recipient.email");
    expect(admin).toContain("duplicate_email_possible");
    expect(admin).toContain("WHERE id = ? AND updated_at = ? AND status != 'suppressed'");
  });

  it("14. exposes all four Admin UI views and the unknown duplicate warning", () => {
    for (const view of ["pending_stuck", "dlq", "failed", "unknown"]) expect(adminUi).toContain(view);
    expect(adminUi).toContain("Duplicate email possible");
    expect(adminUi).toContain("acknowledgeDuplicateEmail");
    expect(adminUi).toContain("notification-deliveries");
  });

  it("15. preserves every non-comment direct notification producer", () => {
    expect(notifications).toContain("export async function notifyProject");
    expect(notifications).toContain("export async function notifySubtaskAssignee");
    expect(notifications).not.toContain("notifyProjectAssignments");
    expect(projects).not.toContain("notifyProjectAssignments");
    expect(notifications).toContain("emitNotifications");
    expect(commentRoutes).not.toContain("emitNotifications");
  });

  it("16. releases in-app work before retry and retries future-available messages", () => {
    const release = delivery.slice(delivery.indexOf("async function releaseBeforeRetry"), delivery.indexOf("async function completeIfTerminal"));
    expect(release.indexOf("UPDATE notification_delivery_ledger")).toBeLessThan(release.indexOf("UPDATE notification_outbox"));
    const failure = delivery.slice(delivery.indexOf("if (!emailReachedProcessing.value)"));
    expect(failure.indexOf("releaseBeforeRetry")).toBeLessThan(failure.indexOf("message.retry"));
    expect(delivery).toContain("message.retry({ delaySeconds });");
    expect(delivery).toContain("row.available_at > now");
  });
});
