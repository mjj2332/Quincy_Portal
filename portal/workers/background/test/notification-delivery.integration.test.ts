import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NOTIFICATION_OUTBOX_EVENT_TYPE, NOTIFICATION_OUTBOX_EVENT_TYPES, type NotificationOutboxMessage } from "@quincy/shared";
import QuincyBackground from "../src";
import type { Env } from "../src/env";
import {
  NOTIFICATION_DELIVERY_LEASE_MS,
  NOTIFICATION_QUEUE_STUCK_MS,
  deliverBroadInApp,
  processNotificationDlqMessage,
  processNotificationMessage,
  recoverNotificationOutbox,
} from "../src/notification-delivery";

const database = env as unknown as { DB: D1Database };
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

type DeliveryFixtureOptions = {
  actorId?: string;
  recipientId?: string;
  actorRole?: string;
  recipientRole?: string;
  recipientActive?: boolean;
  includeMembership?: boolean;
  membershipId?: string;
  projectArchived?: boolean;
  includeComment?: boolean;
  includeMapping?: boolean;
  authorization?: { kind: "admin" } | { kind: "project_member"; membershipIds: string[] };
  outboxStatus?: "pending" | "queued" | "processing" | "completed" | "suppressed" | "failed" | "dlq" | "discarded";
  availableAt?: number;
  queuePublishedAt?: number | null;
  leaseExpiresAt?: number | null;
  inAppStatus?: "pending" | "processing" | "sent" | "suppressed" | "failed" | "unknown" | "discarded";
  emailStatus?: "pending" | "processing" | "sent" | "suppressed" | "failed" | "unknown" | "discarded";
  ledgerAttempts?: number;
};

async function seedDelivery(options: DeliveryFixtureOptions = {}) {
  const now = Date.now();
  const actorId = options.actorId ?? crypto.randomUUID();
  const recipientId = options.recipientId ?? crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const commentId = crypto.randomUUID();
  const mappingId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const membershipId = options.membershipId ?? crypto.randomUUID();
  const actorRole = options.actorRole ?? "editor";
  const recipientRole = options.recipientRole ?? "editor";
  const includeComment = options.includeComment !== false;
  const includeMapping = options.includeMapping !== false;
  const includeMembership = options.includeMembership !== false;
  const outboxStatus = options.outboxStatus ?? "pending";
  const inAppStatus = options.inAppStatus ?? "pending";
  const emailStatus = options.emailStatus ?? "pending";
  const activity = {
    schemaVersion: 1,
    activity: {
      id: crypto.randomUUID(),
      type: "project.comment.created" as const,
      projectId,
      actorId,
      occurredAt: new Date(now).toISOString(),
      source: { kind: "project_comment" as const, id: commentId, key: `project-comment:${commentId}:created` },
      safePayload: { commentId },
      deepLink: { kind: "project_collaboration" as const, path: `/projects/${projectId}?collaboration=open` },
    },
    broadDelivery: { registryKey: "project.comment.created" as const, sourceActivityId: "activity-1", coalesce: null },
    targetedMentionDelivery: false as const,
  };
  const authorization = options.authorization ?? { kind: "project_member" as const, membershipIds: [membershipId] };
  const payload = {
    schemaVersion: 1,
    event: { type: NOTIFICATION_OUTBOX_EVENT_TYPE, sourceKey: mappingId, recipientId },
    authorizationAtOccurrence: authorization,
    projectCommentActivity: activity,
  };
  const leaseExpiresAt = options.leaseExpiresAt === undefined
    ? outboxStatus === "processing" ? now + NOTIFICATION_DELIVERY_LEASE_MS : null
    : options.leaseExpiresAt;
  const queuePublishedAt = options.queuePublishedAt === undefined
    ? outboxStatus === "queued" ? now : null
    : options.queuePublishedAt;

  const statements: D1PreparedStatement[] = [
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'TB4 Actor', ?, 1, ?, 1, ?, ?)").bind(actorId, `${actorId}@example.test`, actorRole, now, now),
  ];
  if (recipientId !== actorId) statements.push(database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'TB4 Recipient', ?, 1, ?, ?, ?, ?)").bind(recipientId, `${recipientId}@example.test`, recipientRole, options.recipientActive === false ? 0 : 1, now, now));
  statements.push(database.DB.prepare("INSERT INTO projects (id, street, stage_key, archived_at, created_at, updated_at) VALUES (?, 'TB4 Delivery Street', 'editing_autohdr', ?, ?, ?)").bind(projectId, options.projectArchived ? now : null, now, now));
  if (includeMembership) statements.push(database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(membershipId, projectId, recipientId, now));
  if (includeComment) statements.push(database.DB.prepare("INSERT INTO project_comments (id, project_id, author_id, body, content_json, created_at) VALUES (?, ?, ?, 'Actual comment body', ?, ?)").bind(commentId, projectId, actorId, JSON.stringify({ type: "doc", content: [] }), now));
  if (includeMapping) statements.push(database.DB.prepare("INSERT INTO project_comment_mentions (id, comment_id, mentioned_user_id, created_at) VALUES (?, ?, ?, ?)").bind(mappingId, commentId, recipientId, now));
  statements.push(database.DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, queue_published_at, lease_token, lease_expires_at, delivery_attempts, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)").bind(outboxId, NOTIFICATION_OUTBOX_EVENT_TYPE, mappingId, projectId, actorId, recipientId, JSON.stringify(payload), outboxStatus, options.availableAt ?? now - 1, queuePublishedAt, outboxStatus === "processing" ? "tb4-lease" : null, leaseExpiresAt, now, now));
  statements.push(database.DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'in_app', ?, ?, ?, ?), (?, ?, ?, ?, ?, 'email', ?, ?, ?, ?)").bind(crypto.randomUUID(), outboxId, NOTIFICATION_OUTBOX_EVENT_TYPE, mappingId, recipientId, inAppStatus, options.ledgerAttempts ?? 0, now, now, crypto.randomUUID(), outboxId, NOTIFICATION_OUTBOX_EVENT_TYPE, mappingId, recipientId, emailStatus, options.ledgerAttempts ?? 0, now, now));
  await database.DB.batch(statements);
  return { now, actorId, recipientId, projectId, commentId, mappingId, outboxId, membershipId, payload };
}

type AssignmentFixtureOptions = {
  roleOnProject?: "photographer" | "editor";
  recipientRole?: "admin" | "photographer" | "editor";
  recipientActive?: boolean;
  includeMembership?: boolean;
  membershipId?: string;
  projectArchived?: boolean;
  actorId?: string;
  recipientId?: string;
};

async function seedAssignment(options: AssignmentFixtureOptions = {}) {
  const now = Date.now();
  const actorId = options.actorId ?? crypto.randomUUID();
  const recipientId = options.recipientId ?? crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const membershipId = options.membershipId ?? crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const roleOnProject = options.roleOnProject ?? "editor";
  const includeMembership = options.includeMembership !== false;
  const payload = {
    schemaVersion: 1,
    event: { type: NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated, sourceKey: membershipId, recipientId },
    assignment: { projectId, userId: recipientId, roleOnProject, membershipCycle: membershipId },
  };
  const statements: D1PreparedStatement[] = [
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Assignment Actor', ?, 1, 'editor', 1, ?, ?)").bind(actorId, `${actorId}@example.test`, now, now),
  ];
  if (recipientId !== actorId) statements.push(database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Assignment Recipient', ?, 1, ?, ?, ?, ?)").bind(recipientId, `${recipientId}@example.test`, options.recipientRole ?? "editor", options.recipientActive === false ? 0 : 1, now, now));
  statements.push(database.DB.prepare("INSERT INTO projects (id, street, stage_key, archived_at, created_at, updated_at) VALUES (?, 'Assignment Street', 'editing_autohdr', ?, ?, ?)").bind(projectId, options.projectArchived ? now : null, now, now));
  if (includeMembership) statements.push(database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(membershipId, projectId, recipientId, roleOnProject, now));
  statements.push(database.DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, queue_published_at, lease_token, lease_expires_at, delivery_attempts, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, 0, ?, ?)").bind(outboxId, NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated, membershipId, projectId, actorId, recipientId, JSON.stringify(payload), now - 1, now, now));
  statements.push(database.DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'in_app', 'pending', 0, ?, ?), (?, ?, ?, ?, ?, 'email', 'pending', 0, ?, ?)").bind(crypto.randomUUID(), outboxId, NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated, membershipId, recipientId, now, now, crypto.randomUUID(), outboxId, NOTIFICATION_OUTBOX_EVENT_TYPES.projectAssignmentCreated, membershipId, recipientId, now, now));
  await database.DB.batch(statements);
  return { now, actorId, recipientId, projectId, membershipId, outboxId, payload };
}

async function seedBroadDelivery() {
  const now = Date.now();
  const actorId = crypto.randomUUID();
  const recipientId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const activityId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const commentId = crypto.randomUUID();
  const sourceKey = activityId;
  const payload = {
    schemaVersion: 1,
    event: { type: NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad, sourceKey, recipientId },
    authorizationAtOccurrence: { kind: "project_editor_membership", membershipCycle: membershipId, startedAt: now },
    activity: { id: activityId, projectId },
  };
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Broad Actor', ?, 1, 'editor', 1, ?, ?)").bind(actorId, `${actorId}@example.test`, now, now),
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Broad Recipient', ?, 1, 'editor', 1, ?, ?)").bind(recipientId, `${recipientId}@example.test`, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Broad Activity Street', 'editing_autohdr', ?, ?)").bind(projectId, now, now),
    database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(membershipId, projectId, recipientId, now),
    database.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, ?, 'project.test', 'projects', ?, '{}', ?)").bind(auditId, actorId, projectId, now),
    database.DB.prepare("INSERT INTO project_activity_events (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at) VALUES (?, 1, 'project.comment.created', 'comment', ?, 'user', ?, ?, 'project_comment', ?, ?, ?, 'project_collaboration', ?, ?)").bind(activityId, projectId, actorId, now, commentId, `project-comment:${commentId}:created`, JSON.stringify({ commentId }), `/projects/${projectId}?collaboration=open`, now),
    database.DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, coalesce_key, coalesce_until, recipient_membership_cycle_id, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, ?)").bind(outboxId, NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad, sourceKey, projectId, actorId, recipientId, JSON.stringify(payload), now - 1, membershipId, now, now),
    database.DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'in_app', 'pending', ?, ?)").bind(crypto.randomUUID(), outboxId, NOTIFICATION_OUTBOX_EVENT_TYPES.projectActivityBroad, sourceKey, recipientId, now, now),
  ]);
  return { now, actorId, recipientId, projectId, membershipId, activityId, commentId, outboxId, sourceKey, payload };
}

function resolvedBroadFixture(fixture: Awaited<ReturnType<typeof seedBroadDelivery>>) {
  return {
    ok: true,
    kind: "broad",
    row: { recipientId: fixture.recipientId, projectId: fixture.projectId, sourceKey: fixture.sourceKey },
    activity: {
      id: fixture.activityId,
      type: "project.comment.created",
      projectId: fixture.projectId,
      actorId: fixture.actorId,
      actorKind: "user",
      occurredAt: fixture.now,
      source: { kind: "project_comment", id: fixture.commentId, key: `project-comment:${fixture.commentId}:created` },
      safePayload: { commentId: fixture.commentId },
      deepLink: { kind: "project_collaboration", path: `/projects/${fixture.projectId}?collaboration=open` },
      category: "comment",
      createdAt: fixture.now,
    },
    delivery: {
      notificationType: "project_collaboration_activity",
      title: "Project comment added",
      body: "A project comment was added.",
      emailSubject: "Project comment added",
      emailText: "A project comment was added.",
      emailHtml: "<p>A project comment was added.</p>",
    },
    commentPath: `https://portal.test/projects/${fixture.projectId}?collaboration=open`,
  } as unknown as Parameters<typeof deliverBroadInApp>[3];
}

function message(outboxId: string, attempts = 0) {
  return { body: { type: "notification_outbox", outboxId } as NotificationOutboxMessage, attempts, ack: vi.fn(), retry: vi.fn() } as never;
}

function deliveryEnv(send?: ReturnType<typeof vi.fn>, db: D1Database = database.DB): Env {
  return {
    DB: db,
    APP_ENV: "test",
    APP_ORIGIN: "https://portal.test",
    NOTIFICATION_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
    EMAIL: send ? { send } : undefined,
    NOTIFICATIONS_FROM_ADDRESS: send ? "studio@example.test" : undefined,
  } as unknown as Env;
}

function service(envOverride: unknown = { DB: database.DB }) {
  return new QuincyBackground({} as ExecutionContext, envOverride as never);
}

describe("TB4 notification delivery Worker integration", () => {
  beforeAll(async () => {
    await executeSql(__PORTAL_MIGRATION_SQL__);
  });

  it("returns terminal broad outcomes and never creates an email ledger", async () => {
    const delivered = await seedBroadDelivery();
    await database.DB.prepare("UPDATE notification_outbox SET status = 'processing', lease_token = 'broad-direct-1', lease_expires_at = ? WHERE id = ?").bind(delivered.now + NOTIFICATION_DELIVERY_LEASE_MS, delivered.outboxId).run();
    const deliveredRow = await database.DB.prepare("SELECT * FROM notification_outbox WHERE id = ?").bind(delivered.outboxId).first();
    const resolved = {
      ok: true,
      kind: "broad",
      row: { recipientId: delivered.recipientId, projectId: delivered.projectId, sourceKey: delivered.sourceKey },
      activity: {
        id: delivered.activityId,
        type: "project.comment.created",
        projectId: delivered.projectId,
        actorId: delivered.actorId,
        actorKind: "user",
        occurredAt: delivered.now,
        source: { kind: "project_comment", id: delivered.commentId, key: `project-comment:${delivered.commentId}:created` },
        safePayload: { commentId: delivered.commentId },
        deepLink: { kind: "project_collaboration", path: `/projects/${delivered.projectId}?collaboration=open` },
        category: "comment",
        createdAt: delivered.now,
      },
      delivery: {
        notificationType: "project_collaboration_activity",
        title: "Project comment added",
        body: "A project comment was added.",
        emailSubject: "Project comment added",
        emailText: "A project comment was added.",
        emailHtml: "<p>A project comment was added.</p>",
      },
      commentPath: `https://portal.test/projects/${delivered.projectId}?collaboration=open`,
    } as unknown as Parameters<typeof deliverBroadInApp>[3];
    expect(await deliverBroadInApp(deliveryEnv(), deliveredRow as Parameters<typeof deliverBroadInApp>[1], "broad-direct-1", resolved, delivered.now)).toBe("delivered");
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(delivered.outboxId).first()).toEqual({ status: "completed" });
    expect(await database.DB.prepare("SELECT status FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app'").bind(delivered.outboxId).first()).toEqual({ status: "sent" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(delivered.outboxId).first()).toEqual({ count: 0 });

    const suppressed = await seedBroadDelivery();
    await database.DB.prepare("UPDATE notification_outbox SET status = 'processing', lease_token = 'broad-direct-2', lease_expires_at = ? WHERE id = ?").bind(suppressed.now + NOTIFICATION_DELIVERY_LEASE_MS, suppressed.outboxId).run();
    await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(suppressed.membershipId).run();
    const suppressedRow = await database.DB.prepare("SELECT * FROM notification_outbox WHERE id = ?").bind(suppressed.outboxId).first();
    const suppressedResolved = { ...resolved, row: { recipientId: suppressed.recipientId, projectId: suppressed.projectId, sourceKey: suppressed.sourceKey }, activity: { ...(resolved as unknown as { activity: Record<string, unknown> }).activity, id: suppressed.activityId, projectId: suppressed.projectId, actorId: suppressed.actorId, occurredAt: suppressed.now, source: { kind: "project_comment", id: suppressed.commentId, key: `project-comment:${suppressed.commentId}:created` }, safePayload: { commentId: suppressed.commentId }, deepLink: { kind: "project_collaboration", path: `/projects/${suppressed.projectId}?collaboration=open` } } } as unknown as Parameters<typeof deliverBroadInApp>[3];
    expect(await deliverBroadInApp(deliveryEnv(), suppressedRow as Parameters<typeof deliverBroadInApp>[1], "broad-direct-2", suppressedResolved, suppressed.now)).toBe("suppressed");
    expect(await database.DB.prepare("SELECT status, last_error_code AS code FROM notification_delivery_ledger WHERE outbox_id = ?").bind(suppressed.outboxId).first()).toEqual({ status: "suppressed", code: "reauthorization_suppressed" });
  });

  it("acks a suppressed broad message exactly once with no retry or DLQ", async () => {
    const fixture = await seedBroadDelivery();
    await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(fixture.membershipId).run();
    const m = message(fixture.outboxId);
    await processNotificationMessage(deliveryEnv(), m);
    expect((m as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
    expect((m as { retry: ReturnType<typeof vi.fn> }).retry).not.toHaveBeenCalled();
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toEqual({ status: "completed" });
    expect(await database.DB.prepare("SELECT status, last_error_code AS code FROM notification_delivery_ledger WHERE outbox_id = ?").bind(fixture.outboxId).first()).toEqual({ status: "suppressed", code: "reauthorization_suppressed" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(fixture.outboxId).first()).toEqual({ count: 0 });
  });

  it("permanently fails a broad message when its activity row is missing", async () => {
    const fixture = await seedBroadDelivery();
    await database.DB.prepare("DELETE FROM project_activity_events WHERE id = ?").bind(fixture.activityId).run();
    const m = message(fixture.outboxId);
    await processNotificationMessage(deliveryEnv(), m);
    expect((m as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
    expect((m as { retry: ReturnType<typeof vi.fn> }).retry).not.toHaveBeenCalled();
    expect(await database.DB.prepare("SELECT status, last_error_code AS code FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toEqual({ status: "failed", code: "project_activity_missing" });
    expect(await database.DB.prepare("SELECT status, last_error_code AS code FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app'").bind(fixture.outboxId).first()).toEqual({ status: "failed", code: "project_activity_missing" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'notification.delivery.failed' AND target_id = ?").bind(fixture.outboxId).first()).toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'notification.delivery.dlq' AND target_id = ?").bind(fixture.outboxId).first()).toEqual({ count: 0 });
  });

  it("permanently fails a broad message whose activity type is reserved", async () => {
    const fixture = await seedBroadDelivery();
    // project.stage.changed became a live type in TB5A Slice 1; project.workflow.raw_ready is still reserved.
    await database.DB.prepare("UPDATE project_activity_events SET event_type = 'project.workflow.raw_ready' WHERE id = ?").bind(fixture.activityId).run();
    const m = message(fixture.outboxId);
    await processNotificationMessage(deliveryEnv(), m);
    expect((m as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
    expect((m as { retry: ReturnType<typeof vi.fn> }).retry).not.toHaveBeenCalled();
    expect(await database.DB.prepare("SELECT status, last_error_code AS code FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toEqual({ status: "failed", code: "project_activity_type_reserved" });
    expect(await database.DB.prepare("SELECT status, last_error_code AS code FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app'").bind(fixture.outboxId).first()).toEqual({ status: "failed", code: "project_activity_type_reserved" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'notification.delivery.failed' AND target_id = ?").bind(fixture.outboxId).first()).toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'notification.delivery.dlq' AND target_id = ?").bind(fixture.outboxId).first()).toEqual({ count: 0 });
  });

  it("distinguishes permanent broad failure from removed-cycle authorization suppression", async () => {
    const fixture = await seedBroadDelivery();
    await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(fixture.membershipId).run();
    const m = message(fixture.outboxId);
    await processNotificationMessage(deliveryEnv(), m);
    expect((m as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
    expect((m as { retry: ReturnType<typeof vi.fn> }).retry).not.toHaveBeenCalled();
    expect(await database.DB.prepare("SELECT status, last_error_code AS code FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toEqual({ status: "completed", code: null });
    expect(await database.DB.prepare("SELECT status, last_error_code AS code FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app'").bind(fixture.outboxId).first()).toEqual({ status: "suppressed", code: "reauthorization_suppressed" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'notification.delivery.failed' AND target_id = ?").bind(fixture.outboxId).first()).toEqual({ count: 0 });
  });

  it("suppresses broad delivery after recipient deactivation or global-role demotion", async () => {
    for (const [label, update, bumpedEpoch] of [
      ["deactivation", "UPDATE user SET active = 0 WHERE id = ?", false],
      ["role demotion", "UPDATE user SET role = 'photographer', authorization_epoch = 1 WHERE id = ?", true],
      ["role-ineligible", "UPDATE user SET role = 'client', authorization_epoch = 1 WHERE id = ?", true],
    ] as const) {
      const fixture = await seedBroadDelivery();
      await database.DB.prepare(update).bind(fixture.recipientId).run();
      if (bumpedEpoch) await database.DB.prepare("UPDATE notification_outbox SET recipient_authorization_epoch = 0 WHERE id = ?").bind(fixture.outboxId).run();
      await database.DB.prepare("UPDATE notification_outbox SET status = 'processing', lease_token = ?, lease_expires_at = ? WHERE id = ?").bind(`broad-${label}`, fixture.now + NOTIFICATION_DELIVERY_LEASE_MS, fixture.outboxId).run();
      const outbox = await database.DB.prepare("SELECT * FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first();
      const outcome = await deliverBroadInApp(deliveryEnv(), outbox as Parameters<typeof deliverBroadInApp>[1], `broad-${label}`, resolvedBroadFixture(fixture), fixture.now);
      expect(outcome, label).toBe("suppressed");
      expect(await database.DB.prepare("SELECT status, last_error_code AS code FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app'").bind(fixture.outboxId).first(), label).toEqual({ status: "suppressed", code: "reauthorization_suppressed" });
      expect(await database.DB.prepare("SELECT count(*) AS count FROM notifications WHERE project_id = ?").bind(fixture.projectId).first(), label).toEqual({ count: 0 });
    }
  });

  it("suppresses a leased occurrence after both preserved-membership role directions bump the epoch", async () => {
    const editorToExternal = await seedBroadDelivery();
    await database.DB.prepare("UPDATE notification_outbox SET recipient_authorization_epoch = 0, status = 'processing', lease_token = 'epoch-editor-external', lease_expires_at = ? WHERE id = ?")
      .bind(editorToExternal.now + NOTIFICATION_DELIVERY_LEASE_MS, editorToExternal.outboxId).run();
    await database.DB.prepare("UPDATE user SET role = 'external_editor', authorization_epoch = 1 WHERE id = ?")
      .bind(editorToExternal.recipientId).run();
    const first = await database.DB.prepare("SELECT * FROM notification_outbox WHERE id = ?").bind(editorToExternal.outboxId).first();
    expect(await deliverBroadInApp(deliveryEnv(), first as Parameters<typeof deliverBroadInApp>[1], "epoch-editor-external", resolvedBroadFixture(editorToExternal), editorToExternal.now)).toBe("suppressed");
    expect(await database.DB.prepare("SELECT id FROM project_members WHERE id = ?").bind(editorToExternal.membershipId).first()).toEqual({ id: editorToExternal.membershipId });
    expect(await database.DB.prepare("SELECT status, last_error_code AS code FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app'").bind(editorToExternal.outboxId).first()).toEqual({ status: "suppressed", code: "authorization_epoch_changed" });

    const externalToEditor = await seedBroadDelivery();
    await database.DB.prepare("UPDATE user SET role = 'external_editor', authorization_epoch = 1 WHERE id = ?").bind(externalToEditor.recipientId).run();
    await database.DB.prepare("UPDATE notification_outbox SET recipient_authorization_epoch = 1, status = 'processing', lease_token = 'epoch-external-editor', lease_expires_at = ? WHERE id = ?")
      .bind(externalToEditor.now + NOTIFICATION_DELIVERY_LEASE_MS, externalToEditor.outboxId).run();
    await database.DB.prepare("UPDATE user SET role = 'editor', authorization_epoch = 2 WHERE id = ?").bind(externalToEditor.recipientId).run();
    const second = await database.DB.prepare("SELECT * FROM notification_outbox WHERE id = ?").bind(externalToEditor.outboxId).first();
    expect(await deliverBroadInApp(deliveryEnv(), second as Parameters<typeof deliverBroadInApp>[1], "epoch-external-editor", resolvedBroadFixture(externalToEditor), externalToEditor.now)).toBe("suppressed");
    expect(await database.DB.prepare("SELECT id FROM project_members WHERE id = ?").bind(externalToEditor.membershipId).first()).toEqual({ id: externalToEditor.membershipId });
    expect(await database.DB.prepare("SELECT status, last_error_code AS code FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app'").bind(externalToEditor.outboxId).first()).toEqual({ status: "suppressed", code: "authorization_epoch_changed" });
  });

  it("records an in-batch broad structural failure with the bounded ledger code", async () => {
    const fixture = await seedBroadDelivery();
    const token = "broad-structural-failure";
    await database.DB.prepare("UPDATE notification_outbox SET status = 'processing', lease_token = ?, lease_expires_at = ? WHERE id = ?").bind(token, fixture.now + NOTIFICATION_DELIVERY_LEASE_MS, fixture.outboxId).run();
    await database.DB.prepare("DELETE FROM project_activity_events WHERE id = ?").bind(fixture.activityId).run();
    const outbox = await database.DB.prepare("SELECT * FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first();
    expect(await deliverBroadInApp(deliveryEnv(), outbox as Parameters<typeof deliverBroadInApp>[1], token, resolvedBroadFixture(fixture), fixture.now)).toBe("failed");
    expect(await database.DB.prepare("SELECT status, last_error_code AS code FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app'").bind(fixture.outboxId).first()).toEqual({ status: "failed", code: "project_activity_missing" });
    expect(await database.DB.prepare("SELECT status, last_error_code AS code FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toEqual({ status: "failed", code: "project_activity_missing" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'notification.delivery.failed' AND target_id = ?").bind(fixture.outboxId).first()).toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'notification.delivery.dlq' AND target_id = ?").bind(fixture.outboxId).first()).toEqual({ count: 0 });
  });

  it("does not run a second broad outbox terminalization write in the Queue wrapper", async () => {
    const fixture = await seedBroadDelivery();
    let fallbackWrites = 0;
    const noFallbackDb = new Proxy(database.DB, {
      get(target, property, receiver) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          if (sql.includes("SET status = 'completed'")) fallbackWrites += 1;
          return target.prepare(sql);
        };
      },
    }) as unknown as D1Database;
    const m = message(fixture.outboxId);
    await processNotificationMessage(deliveryEnv(undefined, noFallbackDb), m);
    expect(fallbackWrites).toBe(0);
    expect((m as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toEqual({ status: "completed" });
  });

  it("lets exactly one of two concurrent claims win and converges duplicate Queue delivery to one result", async () => {
    const fixture = await seedDelivery();
    const send = vi.fn().mockResolvedValue({ messageId: "message-race" });
    const first = message(fixture.outboxId);
    const second = message(fixture.outboxId);
    await Promise.all([processNotificationMessage(deliveryEnv(send), first), processNotificationMessage(deliveryEnv(send), second)]);
    expect((first as { retry: ReturnType<typeof vi.fn> }).retry).not.toHaveBeenCalled();
    expect((second as { retry: ReturnType<typeof vi.fn> }).retry).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(await database.DB.prepare("SELECT status, delivery_attempts FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toMatchObject({ status: "completed", delivery_attempts: 1 });
    expect(await database.DB.prepare("SELECT channel, status FROM notification_delivery_ledger WHERE outbox_id = ? ORDER BY channel").bind(fixture.outboxId).all()).toMatchObject({ results: [{ channel: "email", status: "sent" }, { channel: "in_app", status: "sent" }] });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notifications WHERE source_key = ?").bind(fixture.mappingId).first()).toEqual({ count: 1 });
    await database.DB.prepare("DELETE FROM notifications WHERE source_key = ?").bind(fixture.mappingId).run();
    const afterDismissal = message(fixture.outboxId);
    await processNotificationMessage(deliveryEnv(send), afterDismissal);
    expect((afterDismissal as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notifications WHERE source_key = ?").bind(fixture.mappingId).first()).toEqual({ count: 0 });
  });

  it("delivers durable assignments by role, permits self/archived occurrences, and reauthorizes the exact cycle", async () => {
    const photographer = await seedAssignment({ roleOnProject: "photographer", recipientRole: "photographer" });
    const send = vi.fn().mockResolvedValue({ messageId: "assignment-photographer" });
    const first = message(photographer.outboxId);
    await processNotificationMessage(deliveryEnv(send), first);
    expect((first as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("assigned as the photographer") }));
    expect(await database.DB.prepare("SELECT type, source_key, body FROM notifications WHERE source_key = ?").bind(photographer.membershipId).first()).toMatchObject({ type: "assigned_to_project", source_key: photographer.membershipId, body: "You have been assigned as the photographer for Assignment Street." });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: `You have been assigned as the photographer for Assignment Street.\n\nhttps://portal.test/projects/${photographer.projectId}` }));
    expect(await database.DB.prepare("SELECT status FROM notification_delivery_ledger WHERE outbox_id = ? ORDER BY channel").bind(photographer.outboxId).all()).toMatchObject({ results: [{ status: "sent" }, { status: "sent" }] });

    const duplicate = message(photographer.outboxId, 1);
    await processNotificationMessage(deliveryEnv(send), duplicate);
    expect(send).toHaveBeenCalledOnce();
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notifications WHERE source_key = ?").bind(photographer.membershipId).first()).toEqual({ count: 1 });

    const editor = await seedAssignment({ roleOnProject: "editor", recipientRole: "editor", projectArchived: true });
    const editorSend = vi.fn().mockResolvedValue({ messageId: "assignment-editor" });
    await processNotificationMessage(deliveryEnv(editorSend), message(editor.outboxId));
    expect(editorSend).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("assigned as the editor") }));

    const selfUser = crypto.randomUUID();
    const selfFixture = await seedAssignment({ roleOnProject: "editor", recipientRole: "editor", actorId: selfUser, recipientId: selfUser });
    const selfSend = vi.fn().mockResolvedValue({ messageId: "assignment-self" });
    await processNotificationMessage(deliveryEnv(selfSend), message(selfFixture.outboxId));
    expect(selfSend).toHaveBeenCalledOnce();
    const changed = await seedAssignment({ roleOnProject: "editor", recipientRole: "editor" });
    await database.DB.prepare("UPDATE user SET role = 'photographer' WHERE id = ?").bind(changed.recipientId).run();
    const changedMessage = message(changed.outboxId);
    await processNotificationMessage(deliveryEnv(vi.fn()), changedMessage);
    expect((changedMessage as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(changed.outboxId).first()).toEqual({ status: "suppressed" });
  });

  it("reclaims a stale in-app processing ledger in the claim batch and completes without Cron", async () => {
    const now = Date.now();
    const fixture = await seedDelivery({ outboxStatus: "processing", leaseExpiresAt: now - 1, inAppStatus: "processing", emailStatus: "pending", ledgerAttempts: 1 });
    const m = message(fixture.outboxId);
    await processNotificationMessage(deliveryEnv(), m);
    expect((m as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
    expect((m as { retry: ReturnType<typeof vi.fn> }).retry).not.toHaveBeenCalled();
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toEqual({ status: "completed" });
    expect(await database.DB.prepare("SELECT channel, status FROM notification_delivery_ledger WHERE outbox_id = ? ORDER BY channel").bind(fixture.outboxId).all()).toMatchObject({ results: [{ channel: "email", status: "failed" }, { channel: "in_app", status: "sent" }] });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notifications WHERE source_key = ?").bind(fixture.mappingId).first()).toEqual({ count: 1 });
  });

  it("releases in-app D1 failure before retry, then redelivery claims and completes", async () => {
    const fixture = await seedDelivery();
    await database.DB.exec(`CREATE TRIGGER tb4_fail_notification BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'forced in-app failure'); END`);
    const first = message(fixture.outboxId);
    try {
      await processNotificationMessage(deliveryEnv(), first);
    } finally {
      await database.DB.exec("DROP TRIGGER tb4_fail_notification");
    }
    expect((first as { retry: ReturnType<typeof vi.fn> }).retry).toHaveBeenCalledWith({ delaySeconds: 1 });
    expect(await database.DB.prepare("SELECT status, lease_token, lease_expires_at FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toMatchObject({ status: "queued", lease_token: null, lease_expires_at: null });
    expect(await database.DB.prepare("SELECT status FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app'").bind(fixture.outboxId).first()).toEqual({ status: "pending" });
    // The release sets available_at ~1s in the future (the computed backoff); fast-forward it so
    // the redelivery attempt below doesn't hit the "not yet available, retry" branch instead.
    await database.DB.prepare("UPDATE notification_outbox SET available_at = ? WHERE id = ?").bind(Date.now() - 1, fixture.outboxId).run();
    const second = message(fixture.outboxId, 1);
    await processNotificationMessage(deliveryEnv(), second);
    expect((second as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toEqual({ status: "completed" });
  });

  it("reroutes a future-available duplicate message with the remaining delay without claiming it", async () => {
    const availableAt = Date.now() + 7_000;
    const fixture = await seedDelivery({ outboxStatus: "queued", availableAt, queuePublishedAt: Date.now() });
    const m = message(fixture.outboxId);
    await processNotificationMessage(deliveryEnv(), m);
    expect((m as { retry: ReturnType<typeof vi.fn> }).retry).toHaveBeenCalledWith(expect.objectContaining({ delaySeconds: expect.any(Number) }));
    expect((m as { ack: ReturnType<typeof vi.fn> }).ack).not.toHaveBeenCalled();
    expect(await database.DB.prepare("SELECT status, delivery_attempts FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toMatchObject({ status: "queued", delivery_attempts: 0 });
  });

  it("runs the full email classification matrix while keeping in-app delivery independent", async () => {
    const quotaCodes = ["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED"] as const;
    for (const code of quotaCodes) {
      const fixture = await seedDelivery();
      const send = vi.fn().mockRejectedValue({ code });
      const m = message(fixture.outboxId);
      await processNotificationMessage(deliveryEnv(send), m);
      expect((m as { retry: ReturnType<typeof vi.fn> }).retry).toHaveBeenCalledWith({ delaySeconds: 1 });
      expect(await database.DB.prepare("SELECT status FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app'").bind(fixture.outboxId).first()).toEqual({ status: "sent" });
      expect(await database.DB.prepare("SELECT status, last_error_code FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(fixture.outboxId).first()).toMatchObject({ status: "pending", last_error_code: code });
    }

    const permanent = await seedDelivery();
    const permanentSend = vi.fn().mockRejectedValue({ code: "E_INVALID_TO" });
    const permanentMessage = message(permanent.outboxId);
    await processNotificationMessage(deliveryEnv(permanentSend), permanentMessage);
    expect((permanentMessage as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
    expect((permanentMessage as { retry: ReturnType<typeof vi.fn> }).retry).not.toHaveBeenCalled();
    expect(await database.DB.prepare("SELECT status, attempts, last_error_code, last_error FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(permanent.outboxId).first()).toEqual({ status: "failed", attempts: 1, last_error_code: "E_INVALID_TO", last_error: "Cloudflare rejected the email before delivery." });
    expect(await database.DB.prepare("SELECT email_error FROM notifications WHERE source_key = ?").bind(permanent.mappingId).first()).toEqual({ email_error: "E_INVALID_TO" });

    for (const failure of [{ code: "E_INTERNAL_SERVER_ERROR" }, new Error("uncoded")]) {
      const fixture = await seedDelivery();
      const m = message(fixture.outboxId);
      await processNotificationMessage(deliveryEnv(vi.fn().mockRejectedValue(failure)), m);
      expect((m as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
      expect((m as { retry: ReturnType<typeof vi.fn> }).retry).not.toHaveBeenCalled();
      expect(await database.DB.prepare("SELECT status, last_error_code FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(fixture.outboxId).first()).toMatchObject({ status: "unknown", last_error_code: "email_acceptance_unknown" });
      expect(await database.DB.prepare("SELECT status FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app'").bind(fixture.outboxId).first()).toEqual({ status: "sent" });
    }

    const success = await seedDelivery();
    const successMessage = message(success.outboxId);
    await processNotificationMessage(deliveryEnv(vi.fn().mockResolvedValue({ messageId: "provider-message-1" })), successMessage);
    expect(await database.DB.prepare("SELECT status, email_message_id FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(success.outboxId).first()).toEqual({ status: "sent", email_message_id: "provider-message-1" });
    expect(await database.DB.prepare("SELECT email_message_id FROM notifications WHERE source_key = ?").bind(success.mappingId).first()).toEqual({ email_message_id: "provider-message-1" });

    const missing = await seedDelivery();
    const missingMessage = message(missing.outboxId);
    await processNotificationMessage(deliveryEnv(), missingMessage);
    expect(await database.DB.prepare("SELECT status, attempts, last_error_code FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(missing.outboxId).first()).toMatchObject({ status: "failed", attempts: 0, last_error_code: "email_configuration_missing" });
    expect(await database.DB.prepare("SELECT status FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'in_app'").bind(missing.outboxId).first()).toEqual({ status: "sent" });
  });

  it("reauthorizes every occurrence at send time and suppresses all disqualifying cases without retry", async () => {
    const qualifyingAdmin = await seedDelivery({ recipientRole: "admin", includeMembership: false, authorization: { kind: "admin" } });
    const adminMessage = message(qualifyingAdmin.outboxId);
    await processNotificationMessage(deliveryEnv(vi.fn().mockResolvedValue({ messageId: "admin-mail" })), adminMessage);
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(qualifyingAdmin.outboxId).first()).toEqual({ status: "completed" });

    const disqualifiers: Array<{ name: string; options: DeliveryFixtureOptions; mutate?: (fixture: Awaited<ReturnType<typeof seedDelivery>>) => Promise<void> }> = [
      { name: "deactivated", options: { recipientActive: false } },
      { name: "role-ineligible", options: { recipientRole: "client" } },
      { name: "membership-removed", options: {}, mutate: async (fixture) => { await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(fixture.membershipId).run(); } },
      { name: "remove-readd-new-row", options: {}, mutate: async (fixture) => { await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(fixture.membershipId).run(); await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), fixture.projectId, fixture.recipientId, Date.now()).run(); } },
      { name: "mapping-removed", options: {}, mutate: async (fixture) => { await database.DB.prepare("DELETE FROM project_comment_mentions WHERE id = ?").bind(fixture.mappingId).run(); } },
      { name: "comment-deleted", options: {}, mutate: async (fixture) => { await database.DB.prepare("DELETE FROM project_comments WHERE id = ?").bind(fixture.commentId).run(); } },
      { name: "project-deleted", options: {}, mutate: async (fixture) => { await database.DB.prepare("DELETE FROM projects WHERE id = ?").bind(fixture.projectId).run(); } },
      { name: "wrong-recipient", options: {}, mutate: async (fixture) => { const other = crypto.randomUUID(); const now = Date.now(); await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Wrong recipient', ?, 1, 'editor', 1, ?, ?)").bind(other, `${other}@example.test`, now, now).run(); await database.DB.prepare("UPDATE notification_outbox SET recipient_id = ? WHERE id = ?").bind(other, fixture.outboxId).run(); } },
      { name: "self", options: { actorId: crypto.randomUUID(), recipientId: undefined }, mutate: undefined },
    ];
    for (const disqualifier of disqualifiers) {
      const options = { ...disqualifier.options };
      if (disqualifier.name === "self") options.recipientId = options.actorId;
      const fixture = await seedDelivery(options);
      if (disqualifier.mutate) await disqualifier.mutate(fixture);
      const send = vi.fn().mockResolvedValue({ messageId: `${disqualifier.name}-mail` });
      const m = message(fixture.outboxId);
      await processNotificationMessage(deliveryEnv(send), m);
      expect((m as { ack: ReturnType<typeof vi.fn> }).ack, disqualifier.name).toHaveBeenCalledOnce();
      expect((m as { retry: ReturnType<typeof vi.fn> }).retry, disqualifier.name).not.toHaveBeenCalled();
      expect(send, disqualifier.name).not.toHaveBeenCalled();
      expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first(), disqualifier.name).toEqual({ status: "suppressed" });
      expect(await database.DB.prepare("SELECT status FROM notification_delivery_ledger WHERE outbox_id = ? ORDER BY channel").bind(fixture.outboxId).all(), disqualifier.name).toMatchObject({ results: [{ status: "suppressed" }, { status: "suppressed" }] });
      expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'notification.delivery.suppressed' AND target_id = ?").bind(fixture.outboxId).first(), disqualifier.name).toEqual({ count: 1 });
    }
  });

  it("suppresses email only when access disappears between in-app and email reauthorization", async () => {
    const fixture = await seedDelivery();
    let batches = 0;
    const raceDb = {
      prepare: database.DB.prepare.bind(database.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        const result = await database.DB.batch(statements);
        batches += 1;
        if (batches === 2) await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(fixture.membershipId).run();
        return result;
      },
    } as unknown as D1Database;
    const send = vi.fn().mockResolvedValue({ messageId: "should-not-send" });
    const m = message(fixture.outboxId);
    await processNotificationMessage(deliveryEnv(send, raceDb), m);
    expect(send).not.toHaveBeenCalled();
    expect(await database.DB.prepare("SELECT channel, status FROM notification_delivery_ledger WHERE outbox_id = ? ORDER BY channel").bind(fixture.outboxId).all()).toMatchObject({ results: [{ channel: "email", status: "suppressed" }, { channel: "in_app", status: "sent" }] });
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toEqual({ status: "completed" });
  });

  it("suppresses an assignment occurrence from C1 after removal and re-addition as C2", async () => {
    const fixture = await seedAssignment();
    const newCycle = crypto.randomUUID();
    await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(fixture.membershipId).run();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(newCycle, fixture.projectId, fixture.recipientId, Date.now()).run();
    const send = vi.fn().mockResolvedValue({ messageId: "stale-assignment" });
    const m = message(fixture.outboxId);
    await processNotificationMessage(deliveryEnv(send), m);
    expect((m as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
    expect((m as { retry: ReturnType<typeof vi.fn> }).retry).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toEqual({ status: "suppressed" });
    expect(await database.DB.prepare("SELECT channel, status FROM notification_delivery_ledger WHERE outbox_id = ? ORDER BY channel").bind(fixture.outboxId).all()).toMatchObject({ results: [{ channel: "email", status: "suppressed" }, { channel: "in_app", status: "suppressed" }] });
    expect(await database.DB.prepare("SELECT id FROM project_members WHERE id = ?").bind(newCycle).first()).toEqual({ id: newCycle });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notifications WHERE source_key = ?").bind(fixture.membershipId).first()).toEqual({ count: 0 });
  });

  it("reauthorizes each assignment channel independently after in-app sends", async () => {
    const fixture = await seedAssignment();
    let batches = 0;
    const raceDb = {
      prepare: database.DB.prepare.bind(database.DB),
      batch: async (statements: D1PreparedStatement[]) => {
        const result = await database.DB.batch(statements);
        batches += 1;
        if (batches === 2) await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(fixture.membershipId).run();
        return result;
      },
    } as unknown as D1Database;
    const send = vi.fn().mockResolvedValue({ messageId: "assignment-should-not-send" });
    const m = message(fixture.outboxId);
    await processNotificationMessage(deliveryEnv(send, raceDb), m);
    expect(send).not.toHaveBeenCalled();
    expect(await database.DB.prepare("SELECT channel, status FROM notification_delivery_ledger WHERE outbox_id = ? ORDER BY channel").bind(fixture.outboxId).all()).toMatchObject({ results: [{ channel: "email", status: "suppressed" }, { channel: "in_app", status: "sent" }] });
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toEqual({ status: "completed" });
  });

  it("keeps ambiguous email processing leased, refuses an immediate resend, and lets expired Cron recovery record unknown", async () => {
    const fixture = await seedDelivery();
    // Plan §6 step 7 makes a plain uncoded EMAIL.send() rejection resolve to `unknown`
    // immediately (covered by the classification-matrix test above) -- that is NOT ambiguous.
    // Step 8's genuinely ambiguous case is a crash/D1 failure *after* email entered `processing`,
    // which prevents finishEmail's own classification write from completing at all. Simulate that
    // by making the ledger's own "resolve to unknown" UPDATE itself fail, so the exception escapes
    // finishEmail uncaught and reaches processNotificationMessage's outer catch.
    await database.DB.exec(`CREATE TRIGGER tb4_fail_email_classify BEFORE UPDATE ON notification_delivery_ledger WHEN NEW.channel = 'email' AND NEW.status = 'unknown' BEGIN SELECT RAISE(ABORT, 'forced D1 failure recording email outcome'); END`);
    const send = vi.fn().mockRejectedValue(new Error("connection dropped after acceptance"));
    const first = message(fixture.outboxId);
    try {
      await processNotificationMessage(deliveryEnv(send), first);
    } finally {
      await database.DB.exec("DROP TRIGGER tb4_fail_email_classify");
    }
    expect((first as { retry: ReturnType<typeof vi.fn> }).retry).toHaveBeenCalledOnce();
    expect(await database.DB.prepare("SELECT status, lease_token FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toMatchObject({ status: "processing", lease_token: expect.any(String) });
    expect(await database.DB.prepare("SELECT status, attempts FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(fixture.outboxId).first()).toEqual({ status: "processing", attempts: 1 });
    const immediate = message(fixture.outboxId, 1);
    await processNotificationMessage(deliveryEnv(send), immediate);
    expect((immediate as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    await database.DB.prepare("UPDATE notification_outbox SET lease_expires_at = ? WHERE id = ?").bind(Date.now() - 1, fixture.outboxId).run();
    await recoverNotificationOutbox(deliveryEnv(send), Date.now());
    expect(await database.DB.prepare("SELECT status, attempts FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(fixture.outboxId).first()).toEqual({ status: "unknown", attempts: 1 });
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toEqual({ status: "completed" });
  });

  it("handles DLQ live/expired leases conservatively and never turns an attempted email into failed/discarded", async () => {
    const live = await seedDelivery({ outboxStatus: "processing", leaseExpiresAt: Date.now() + 60_000, inAppStatus: "sent", emailStatus: "processing", ledgerAttempts: 1 });
    const liveMessage = message(live.outboxId);
    await processNotificationDlqMessage(deliveryEnv(), liveMessage);
    expect((liveMessage as { retry: ReturnType<typeof vi.fn> }).retry).toHaveBeenCalledOnce();
    expect(await database.DB.prepare("SELECT status FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(live.outboxId).first()).toEqual({ status: "processing" });

    const expired = await seedDelivery({ outboxStatus: "processing", leaseExpiresAt: Date.now() - 1, inAppStatus: "sent", emailStatus: "processing", ledgerAttempts: 1 });
    const expiredMessage = message(expired.outboxId);
    await processNotificationDlqMessage(deliveryEnv(), expiredMessage);
    expect((expiredMessage as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
    expect(await database.DB.prepare("SELECT status, attempts FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(expired.outboxId).first()).toEqual({ status: "unknown", attempts: 1 });
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(expired.outboxId).first()).toEqual({ status: "dlq" });

    const alreadyUnknown = await seedDelivery({ outboxStatus: "completed", inAppStatus: "sent", emailStatus: "unknown", ledgerAttempts: 1 });
    // seedDelivery's ledger INSERT doesn't set last_error_code; populate it to match what the
    // real `unknown` transition would have written, since the assertion below proves it survives unchanged.
    await database.DB.prepare("UPDATE notification_delivery_ledger SET last_error_code = 'email_acceptance_unknown' WHERE outbox_id = ? AND channel = 'email'").bind(alreadyUnknown.outboxId).run();
    const unknownMessage = message(alreadyUnknown.outboxId);
    await processNotificationDlqMessage(deliveryEnv(), unknownMessage);
    await recoverNotificationOutbox(deliveryEnv(), Date.now());
    expect(await database.DB.prepare("SELECT status, attempts, last_error_code FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = 'email'").bind(alreadyUnknown.outboxId).first()).toEqual({ status: "unknown", attempts: 1, last_error_code: "email_acceptance_unknown" });
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(alreadyUnknown.outboxId).first()).toEqual({ status: "completed" });
  });

  it("publishes bounded pending/queued-stuck recovery work and converges duplicate Cron publication", async () => {
    const queueSend = vi.fn().mockResolvedValue(undefined);
    const recoveryEnv = deliveryEnv(undefined);
    recoveryEnv.NOTIFICATION_QUEUE = { send: queueSend };
    const fixtures = await Promise.all(Array.from({ length: 101 }, () => seedDelivery({ emailStatus: "sent", inAppStatus: "sent" })));
    const recovered = await recoverNotificationOutbox(recoveryEnv, Date.now());
    expect(recovered).toBe(100);
    expect(queueSend).toHaveBeenCalledTimes(100);

    const stuck = await seedDelivery({ outboxStatus: "queued", queuePublishedAt: Date.now() - NOTIFICATION_QUEUE_STUCK_MS - 1, availableAt: Date.now() - 1 });
    const terminal = await seedDelivery({ outboxStatus: "discarded", emailStatus: "discarded", inAppStatus: "discarded" });
    const before = queueSend.mock.calls.length;
    await recoverNotificationOutbox(recoveryEnv, Date.now());
    expect(queueSend.mock.calls.slice(before).map(([body]) => body)).toContainEqual({ type: "notification_outbox", outboxId: stuck.outboxId });
    expect(queueSend.mock.calls.slice(before).map(([body]) => body)).not.toContainEqual({ type: "notification_outbox", outboxId: terminal.outboxId });

    const duplicate = await seedDelivery();
    const firstPublication = publishWith(recoveryEnv, duplicate.outboxId);
    const secondPublication = publishWith(recoveryEnv, duplicate.outboxId);
    await Promise.all([firstPublication, secondPublication]);
    const sends = queueSend.mock.calls.filter(([body]) => (body as { outboxId?: string }).outboxId === duplicate.outboxId);
    expect(sends.length).toBe(2);
    const messages = sends.map(() => message(duplicate.outboxId));
    await Promise.all(messages.map((item) => processNotificationMessage(deliveryEnv(vi.fn().mockResolvedValue({ messageId: "cron-converged" })), item)));
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notifications WHERE source_key = ?").bind(duplicate.mappingId).first()).toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT channel, status FROM notification_delivery_ledger WHERE outbox_id = ? ORDER BY channel").bind(duplicate.outboxId).all()).toMatchObject({ results: [{ channel: "email", status: "sent" }, { channel: "in_app", status: "sent" }] });
  });

  it("routes the fourth pre-email failure to the configured DLQ boundary and records/acks the DLQ receipt", async () => {
    const fixture = await seedDelivery();
    await database.DB.exec("CREATE TRIGGER tb4_fail_before_email BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'pre-email D1 failure'); END");
    const retries: ReturnType<typeof vi.fn>[] = [];
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const m = message(fixture.outboxId, attempt);
        retries.push((m as { retry: ReturnType<typeof vi.fn> }).retry);
        await service({ DB: database.DB, NOTIFICATION_QUEUE: { send: vi.fn() }, APP_ORIGIN: "https://portal.test" }).queue({ queue: "quincy-notifications", messages: [m] } as never);
        if (attempt < 3) {
          await database.DB.prepare("UPDATE notification_outbox SET status = 'queued', lease_token = NULL, lease_expires_at = NULL, available_at = ? WHERE id = ?").bind(Date.now() - 1, fixture.outboxId).run();
          await database.DB.prepare("UPDATE notification_delivery_ledger SET status = 'pending' WHERE outbox_id = ?").bind(fixture.outboxId).run();
        }
      }
    } finally {
      await database.DB.exec("DROP TRIGGER tb4_fail_before_email");
    }
    expect(retries.length).toBe(4);
    expect(retries.every((retry) => retry.mock.calls.length === 1)).toBe(true);
    const dlqMessage = message(fixture.outboxId, 0);
    await service({ DB: database.DB }).queue({ queue: "quincy-notifications-dlq", messages: [dlqMessage] } as never);
    expect((dlqMessage as { ack: ReturnType<typeof vi.fn> }).ack).toHaveBeenCalledOnce();
    expect(await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(fixture.outboxId).first()).toEqual({ status: "dlq" });
  });
});

async function publishWith(envValue: Env, outboxId: string): Promise<void> {
  const { publishNotificationOutbox } = await import("@quincy/shared");
  await publishNotificationOutbox(envValue.NOTIFICATION_QUEUE, database.DB, [outboxId], Date.now());
}
