import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth";
import type { AppEnv, Env } from "../src/env";
import {
  createProjectComment,
  deleteProjectComment,
  editProjectComment,
} from "../src/lib/project-comments";
import { projectCommentsRoutes } from "../src/routes/project-comments";
import { publishNotificationOutbox } from "@quincy/shared";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
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

async function authCookie(token: string): Promise<string> {
  const context = await createAuth(baseEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function request(path: string, token: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", body?: unknown): Promise<Response> {
  const headers = new Headers({ cookie: await authCookie(token), origin: baseEnv.APP_ORIGIN });
  if (body !== undefined) headers.set("content-type", "application/json");
  return workerSelf.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

const doc = (content: unknown[]) => ({ type: "doc", content: [{ type: "paragraph", content }] });
const mention = (id: string, label = "mention") => ({ type: "mention", attrs: { id, label } });

async function seedDiscussionFixture(options: { actorRole?: "admin" | "editor"; recipientRole?: "editor" | "photographer" } = {}) {
  const now = Date.now();
  const actorId = crypto.randomUUID();
  const recipientId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const actorToken = `tb4-actor-${crypto.randomUUID()}`;
  const adminToken = `tb4-admin-${crypto.randomUUID()}`;
  const recipientMembershipId = crypto.randomUUID();
  const actorMembershipId = crypto.randomUUID();
  const actorRole = options.actorRole ?? "editor";
  const recipientRole = options.recipientRole ?? "editor";
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'TB4 Actor', ?, 1, ?, 1, ?, ?), (?, 'TB4 Recipient', ?, 1, ?, 1, ?, ?)").bind(actorId, `${actorId}@example.test`, actorRole, now, now, recipientId, `${recipientId}@example.test`, recipientRole, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, actorToken, actorId, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'TB4 Comment Street', 'editing_autohdr', ?, ?)").bind(projectId, now, now),
    database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?), (?, ?, ?, 'editor', ?)").bind(actorMembershipId, projectId, actorId, now, recipientMembershipId, projectId, recipientId, now),
  ]);
  return { now, actorId, recipientId, projectId, actorToken, adminToken, recipientMembershipId, actorMembershipId };
}

function mutationInput(fixture: Awaited<ReturnType<typeof seedDiscussionFixture>>, commentId: string, mentionIds: Array<{ id: string; userId: string }>, occurredAt = new Date(fixture.now)) {
  return {
    id: commentId,
    projectId: fixture.projectId,
    authorId: fixture.actorId,
    body: "TB4 comment",
    contentJson: JSON.stringify(doc(mentionIds.map((item) => mention(item.userId)))),
    mentions: mentionIds.map((item) => ({ id: item.id, commentId, mentionedUserId: item.userId, createdAt: occurredAt })),
    wallClockMs: fixture.now,
    occurredAt,
  };
}

describe("TB4 project-comment outbox integration", () => {
  beforeAll(async () => {
    await executeSql(__PORTAL_MIGRATION_SQL__);
  });

  it("commits create/edit/delete mapping, audit, outbox, and ledger atomically with exact safe payloads", async () => {
    const fixture = await seedDiscussionFixture();
    const secondRecipientMembershipId = "00000000-0000-4000-8000-000000000001";
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(secondRecipientMembershipId, fixture.projectId, fixture.recipientId, fixture.now).run();
    const commentId = crypto.randomUUID();
    const selfMentionId = crypto.randomUUID();
    const recipientMentionId = crypto.randomUUID();
    const created = await createProjectComment(database.DB, mutationInput(fixture, commentId, [
      { id: selfMentionId, userId: fixture.actorId },
      { id: recipientMentionId, userId: fixture.recipientId },
    ]));

    expect(created.notificationOutboxIds).toHaveLength(1);
    const mentionRows = await database.DB.prepare("SELECT mentioned_user_id FROM project_comment_mentions WHERE comment_id = ?").bind(commentId).all<{ mentioned_user_id: string }>();
    // mention row ids are random UUIDs unrelated to insertion order, so compare as a set rather than relying on ORDER BY id.
    expect(mentionRows.results.map((row) => row.mentioned_user_id).sort()).toEqual([fixture.actorId, fixture.recipientId].sort());
    const outbox = await database.DB.prepare("SELECT id, event_type, source_key, actor_id, recipient_id, payload_json, status FROM notification_outbox WHERE project_id = ?").bind(fixture.projectId).first<{ id: string; event_type: string; source_key: string; actor_id: string; recipient_id: string; payload_json: string; status: string }>();
    expect(outbox).toMatchObject({ event_type: "project.comment.mentioned", source_key: recipientMentionId, actor_id: fixture.actorId, recipient_id: fixture.recipientId, status: "pending" });
    const payload = JSON.parse(outbox!.payload_json) as Record<string, unknown>;
    expect(payload).toEqual({
      schemaVersion: 1,
      event: { type: "project.comment.mentioned", sourceKey: recipientMentionId, recipientId: fixture.recipientId },
      authorizationAtOccurrence: { kind: "project_member", membershipIds: [secondRecipientMembershipId, fixture.recipientMembershipId].sort() },
      projectCommentActivity: created.activity,
    });
    expect(payload).not.toHaveProperty("body");
    expect(payload).not.toHaveProperty("recipientEmail");
    expect(JSON.stringify(payload)).not.toContain("TB4 comment");
    expect(JSON.stringify(payload)).not.toContain("@example.test");
    expect((await database.DB.prepare("SELECT channel, status FROM notification_delivery_ledger WHERE outbox_id = ? ORDER BY channel").bind(outbox!.id).all()).results).toEqual([{ channel: "email", status: "pending" }, { channel: "in_app", status: "pending" }]);
    expect(await database.DB.prepare("SELECT action FROM audit_log WHERE action = 'project_comment.create' AND target_id = ?").bind(commentId).all()).toMatchObject({ results: [{ action: "project_comment.create" }] });
    expect(await database.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%activity%'").all()).toMatchObject({ results: [] });

    const retained = await editProjectComment(database.DB, {
      projectId: fixture.projectId,
      commentId,
      actorId: fixture.actorId,
      body: "TB4 retained edit",
      contentJson: JSON.stringify(doc([mention(fixture.recipientId)])),
      removeMentionIds: [],
      addMentions: [],
      editedAt: new Date(fixture.now + 1),
      occurredAt: new Date(fixture.now + 1),
    });
    expect(retained.notificationOutboxIds).toEqual([]);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(fixture.projectId).first()).toEqual({ count: 1 });

    const readdedMentionId = crypto.randomUUID();
    const edited = await editProjectComment(database.DB, {
      projectId: fixture.projectId,
      commentId,
      actorId: fixture.actorId,
      body: "TB4 re-added edit",
      contentJson: JSON.stringify(doc([mention(fixture.recipientId)])),
      removeMentionIds: [recipientMentionId],
      addMentions: [{ id: readdedMentionId, commentId, mentionedUserId: fixture.recipientId, createdAt: new Date(fixture.now + 2) }],
      editedAt: new Date(fixture.now + 2),
      occurredAt: new Date(fixture.now + 2),
    });
    expect(edited.notificationOutboxIds).toHaveLength(1);
    expect(edited.activity.activity.id).not.toBe(created.activity.activity.id);
    expect(await database.DB.prepare("SELECT source_key FROM notification_outbox WHERE project_id = ? ORDER BY created_at, id").bind(fixture.projectId).all()).toMatchObject({ results: [{ source_key: recipientMentionId }, { source_key: readdedMentionId }] });

    await deleteProjectComment(database.DB, { projectId: fixture.projectId, commentId, actorId: fixture.actorId, occurredAt: new Date(fixture.now + 3) });
    expect(await database.DB.prepare("SELECT id FROM project_comments WHERE id = ?").bind(commentId).first()).toBeNull();
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(fixture.projectId).first()).toEqual({ count: 2 });
    expect(await database.DB.prepare("SELECT action FROM audit_log WHERE target_id = ? ORDER BY created_at").bind(commentId).all()).toMatchObject({ results: [{ action: "project_comment.create" }, { action: "project_comment.edit" }, { action: "project_comment.edit" }, { action: "project_comment.delete" }] });
  });

  it("creates a self mapping without delivery intent and rolls failed domain batches back completely", async () => {
    const fixture = await seedDiscussionFixture();
    const commentId = crypto.randomUUID();
    const selfMentionId = crypto.randomUUID();
    const self = await createProjectComment(database.DB, mutationInput(fixture, commentId, [{ id: selfMentionId, userId: fixture.actorId }]));
    expect(self.notificationOutboxIds).toEqual([]);
    expect(await database.DB.prepare("SELECT id FROM project_comment_mentions WHERE id = ?").bind(selfMentionId).first()).toEqual({ id: selfMentionId });
    expect(await database.DB.prepare("SELECT id FROM notification_outbox WHERE source_key = ?").bind(selfMentionId).first()).toBeNull();

    const failedCommentId = crypto.randomUUID();
    const duplicateMentionId = crypto.randomUUID();
    await expect(createProjectComment(database.DB, mutationInput(fixture, failedCommentId, [
      { id: duplicateMentionId, userId: fixture.recipientId },
      { id: duplicateMentionId, userId: fixture.recipientId },
    ]))).rejects.toThrow();
    expect(await database.DB.prepare("SELECT id FROM project_comments WHERE id = ?").bind(failedCommentId).first()).toBeNull();
    expect(await database.DB.prepare("SELECT id FROM project_comment_mentions WHERE comment_id = ?").bind(failedCommentId).all()).toMatchObject({ results: [] });
    expect(await database.DB.prepare("SELECT id FROM audit_log WHERE target_id = ?").bind(failedCommentId).all()).toMatchObject({ results: [] });
    expect(await database.DB.prepare("SELECT id FROM notification_outbox WHERE project_id = ? AND source_key = ?").bind(fixture.projectId, duplicateMentionId).all()).toMatchObject({ results: [] });

    const editableId = crypto.randomUUID();
    const editableMentionId = crypto.randomUUID();
    await createProjectComment(database.DB, mutationInput(fixture, editableId, [{ id: editableMentionId, userId: fixture.recipientId }]));
    const editMentionId = crypto.randomUUID();
    await expect(editProjectComment(database.DB, {
      projectId: fixture.projectId,
      commentId: editableId,
      actorId: fixture.actorId,
      body: "should roll back",
      contentJson: JSON.stringify(doc([mention(fixture.recipientId)])),
      removeMentionIds: [],
      addMentions: [
        { id: editMentionId, commentId: editableId, mentionedUserId: fixture.recipientId, createdAt: new Date() },
        { id: editMentionId, commentId: editableId, mentionedUserId: fixture.recipientId, createdAt: new Date() },
      ],
      editedAt: new Date(),
      occurredAt: new Date(),
    })).rejects.toThrow();
    expect(await database.DB.prepare("SELECT body FROM project_comments WHERE id = ?").bind(editableId).first()).toEqual({ body: "TB4 comment" });
    expect(await database.DB.prepare("SELECT id FROM audit_log WHERE action = 'project_comment.edit' AND target_id = ?").bind(editableId).all()).toMatchObject({ results: [] });
  });

  it("keeps project-comment mutations on the outbox producer while Notice Board remains a direct producer", async () => {
    const fixture = await seedDiscussionFixture();
    const commentResponse = await request(`/api/projects/${fixture.projectId}/comments`, fixture.actorToken, "POST", { content: doc([mention(fixture.recipientId, "forged label")]) });
    expect(commentResponse.status).toBe(201);
    const body = await commentResponse.json() as { id: string };
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(fixture.projectId).first()).toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT id FROM notifications WHERE project_id = ? AND type = 'mentioned'").bind(fixture.projectId).all()).toMatchObject({ results: [] });
    expect(await database.DB.prepare("SELECT action FROM audit_log WHERE action = 'project_comment.create' AND target_id = ?").bind(body.id).all()).toMatchObject({ results: [{ action: "project_comment.create" }] });
    expect((await database.DB.prepare("SELECT action FROM audit_log WHERE action = 'project_comment.create' AND target_id = ?").bind(body.id).all()).results).toHaveLength(1);
  });

  it("records Queue rejection without undoing the committed comment and returns before a deferred Queue send", async () => {
    const fixture = await seedDiscussionFixture();
    const commentId = crypto.randomUUID();
    const mentionId = crypto.randomUUID();
    const created = await createProjectComment(database.DB, mutationInput(fixture, commentId, [{ id: mentionId, userId: fixture.recipientId }]));
    const rejectingQueue = { send: vi.fn().mockRejectedValue(new Error("queue unavailable")) };
    await publishNotificationOutbox(rejectingQueue, database.DB, created.notificationOutboxIds, fixture.now + 10);
    expect(await database.DB.prepare("SELECT status, publish_attempts, last_error_code FROM notification_outbox WHERE id = ?").bind(created.notificationOutboxIds[0]).first()).toMatchObject({ status: "pending", publish_attempts: 1, last_error_code: "queue_publish_failed" });
    expect(await database.DB.prepare("SELECT id FROM project_comments WHERE id = ?").bind(commentId).first()).toEqual({ id: commentId });

    const deferred = new Promise<void>((resolve) => { (globalThis as typeof globalThis & { resolveTb4Queue?: () => void }).resolveTb4Queue = resolve; });
    const queue = { send: vi.fn(() => deferred) };
    const routeEnv = { DB: database.DB, APP_ORIGIN: "https://portal.test", NOTIFICATION_QUEUE: queue } as unknown as AppEnv["Bindings"];
    const routeApp = new Hono<AppEnv>();
    routeApp.use("*", async (c, next) => { c.set("user", { id: fixture.actorId, email: `${fixture.actorId}@example.test`, name: "TB4 Actor", role: "editor", active: true }); await next(); });
    routeApp.route("/", projectCommentsRoutes);
    const waits: Promise<unknown>[] = [];
    const executionCtx = { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); }, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
    const response = await Promise.race([
      routeApp.fetch(new Request(`https://portal.test/projects/${fixture.projectId}/comments`, { method: "POST", headers: { "content-type": "application/json", origin: "https://portal.test" }, body: JSON.stringify({ content: doc([mention(fixture.recipientId)]) }) }), routeEnv, executionCtx),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("route awaited Queue publication")), 100)),
    ]);
    expect(response.status).toBe(201);
    expect(waits).toHaveLength(1);
    (globalThis as typeof globalThis & { resolveTb4Queue?: () => void }).resolveTb4Queue?.();
    await Promise.all(waits);
    expect(queue.send).toHaveBeenCalledTimes(1);
  });
});
