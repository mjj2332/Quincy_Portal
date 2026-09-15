import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { notificationCopy } from "@quincy/db";
import { PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID, conformsToNotificationEnrichment } from "@quincy/shared";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { notifyProject, notifySubtaskAssignee } from "../src/lib/notifications";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const userA = crypto.randomUUID();
const userB = crypto.randomUUID();
const tokenA = `notifications-a-${crypto.randomUUID()}`;
const tokenB = `notifications-b-${crypto.randomUUID()}`;
const photographer = crypto.randomUUID();
const tokenPhotographer = `notifications-photographer-${crypto.randomUUID()}`;
const externalEditor = crypto.randomUUID();
const tokenExternalEditor = `notifications-external-${crypto.randomUUID()}`;
const admin = crypto.randomUUID();
const tokenAdmin = `notifications-admin-${crypto.randomUUID()}`;
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(source: string) {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

async function cookie(token: string) {
  const context = await createAuth(baseEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function request(path: string, token: string, method: "GET" | "POST" | "DELETE" = "GET") {
  const headers = new Headers({ cookie: await cookie(token), origin: baseEnv.APP_ORIGIN });
  return workerSelf.fetch(`https://portal.test${path}`, { method, headers });
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  const now = Date.now();
  const projectId = crypto.randomUUID();
  await database.DB.batch([
    // This fixture's role is 'editor', not 'admin': projectNotificationRecipients() (see
    // packages/db/src/notifications.ts) treats every *active admin* user as an implicit recipient
    // of every project's notifyProject() call, so a literal admin-role fixture here would silently
    // add a recipient to the pre-existing tests above that assert an exact recipient set.
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Notification A', ?, 1, 'editor', 1, ?, ?), (?, 'Notification B', ?, 1, 'editor', 1, ?, ?), (?, 'Notification Photographer', ?, 1, 'photographer', 1, ?, ?), (?, 'Notification External', ?, 1, 'external_editor', 1, ?, ?), (?, 'Notification Admin', ?, 1, 'editor', 1, ?, ?)").bind(userA, `${userA}@example.test`, now, now, userB, `${userB}@example.test`, now, now, photographer, `${photographer}@example.test`, now, now, externalEditor, `${externalEditor}@example.test`, now, now, admin, `${admin}@example.test`, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, tokenA, userA, now, now, crypto.randomUUID(), now + 3_600_000, tokenB, userB, now, now, crypto.randomUUID(), now + 3_600_000, tokenPhotographer, photographer, now, now, crypto.randomUUID(), now + 3_600_000, tokenExternalEditor, externalEditor, now, now, crypto.randomUUID(), now + 3_600_000, tokenAdmin, admin, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Comment Street', 'edited_review', ?, ?)").bind(projectId, now, now),
    database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?), (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userA, now, crypto.randomUUID(), projectId, userB, now),
  ]);
  await database.DB.batch([
    database.DB.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, body, created_at) VALUES (?, ?, ?, 'raw_ready', 'A notification', 'Body', ?)").bind(crypto.randomUUID(), userA, projectId, now),
    database.DB.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, body, created_at) VALUES (?, ?, ?, 'raw_ready', 'B notification', 'Body', ?)").bind(crypto.randomUUID(), userB, projectId, now),
  ]);
});

describe("notifications API and recipient selection", () => {
  it("scopes listing and read mutations to the authenticated user", async () => {
    const list = await request("/api/notifications", tokenA);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ unreadCount: 1, notifications: [expect.objectContaining({ title: "A notification" })] });

    const otherId = (await database.DB.prepare("SELECT id FROM notifications WHERE user_id = ?").bind(userB).first<{ id: string }>())!.id;
    expect((await request(`/api/notifications/${otherId}/read`, tokenA, "POST")).status).toBe(404);
    expect((await request("/api/notifications/read-all", tokenA, "POST")).status).toBe(200);
    const after = await request("/api/notifications", tokenA);
    expect((await after.json() as { unreadCount: number }).unreadCount).toBe(0);
    expect((await request("/api/notifications", tokenB)).status).toBe(200);
  });

  it("deletes only the caller's notification and audits the successful deletion", async () => {
    const otherId = (await database.DB.prepare("SELECT id FROM notifications WHERE user_id = ?").bind(userB).first<{ id: string }>())!.id;
    expect((await request(`/api/notifications/${otherId}`, tokenA, "DELETE")).status).toBe(404);
    expect(await database.DB.prepare("SELECT id FROM notifications WHERE id = ?").bind(otherId).first()).toEqual({ id: otherId });

    const id = crypto.randomUUID();
    const project = await database.DB.prepare("SELECT id FROM projects WHERE street = 'Comment Street'").first<{ id: string }>();
    await database.DB.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, body, created_at) VALUES (?, ?, ?, 'raw_ready', 'Delete me', 'Unread notification', ?)").bind(id, userA, project!.id, Date.now()).run();
    const deleted = await request(`/api/notifications/${id}`, tokenA, "DELETE");
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect(await database.DB.prepare("SELECT id, read_at FROM notifications WHERE id = ?").bind(id).first()).toBeNull();
    expect((await request(`/api/notifications/${id}`, tokenA, "DELETE")).status).toBe(404);
    expect((await request(`/api/notifications/${crypto.randomUUID()}`, tokenA, "DELETE")).status).toBe(404);
    expect(await database.DB.prepare("SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE action = ? AND target_id = ?").bind("notification.delete", id).first()).toEqual({ actor_id: userA, action: "notification.delete", target_type: "notification", target_id: id, meta_json: null });
  });

  it("notifies only active non-actor editors, including no recipient for an actor-only project", async () => {
    expect(notificationCopy("comment_added", "Example").title).toBe("New review feedback");
    const projectId = crypto.randomUUID();
    const now = Date.now();
    const inactiveEditor = crypto.randomUUID();
    const actor = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Inactive', ?, 1, 'editor', 0, ?, ?), (?, 'Actor', ?, 1, 'editor', 1, ?, ?)").bind(inactiveEditor, `${inactiveEditor}@example.test`, now, now, actor, `${actor}@example.test`, now, now),
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Actor Street', 'edited_review', ?, ?)").bind(projectId, now, now),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?), (?, ?, ?, 'editor', ?), (?, ?, ?, 'photographer', ?)").bind(crypto.randomUUID(), projectId, userB, now, crypto.randomUUID(), projectId, inactiveEditor, now, crypto.randomUUID(), projectId, actor, now),
    ]);
    await notifyProject(baseEnv, projectId, "comment_added", { editorOnly: true, excludeUserId: actor });
    const rows = await database.DB.prepare("SELECT user_id FROM notifications WHERE project_id = ? AND type = 'comment_added'").bind(projectId).all<{ user_id: string }>();
    expect(rows.results).toEqual([{ user_id: userB }]);
  });

  it("deduplicates an admin who is also a project member", async () => {
    const now = Date.now();
    const projectId = crypto.randomUUID();
    const adminId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Member admin', ?, 1, 'admin', 1, ?, ?)").bind(adminId, `${adminId}@example.test`, now, now),
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Admin dedupe', 'awaiting_raw', ?, ?)").bind(projectId, now, now),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(crypto.randomUUID(), projectId, adminId, now),
    ]);
    const send = vi.fn().mockResolvedValue({ messageId: "test-message" });
    const testEnv = { DB: database.DB, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test", APP_ORIGIN: "https://portal.test" } as unknown as Env;
    await notifyProject(testEnv, projectId, "raw_ready");
    expect((await database.DB.prepare("SELECT user_id FROM notifications WHERE project_id = ? AND type = 'raw_ready'").bind(projectId).all<{ user_id: string }>()).results).toEqual([{ user_id: adminId }]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining(`https://portal.test/projects/${projectId}`) }));
  });

  it("includes active admins for every project event", async () => {
    const now = Date.now();
    const projectId = crypto.randomUUID();
    const activeAdmin = crypto.randomUUID();
    const inactiveAdmin = crypto.randomUUID();
    const editor = crypto.randomUUID();
    const photographer = crypto.randomUUID();
    const assignedActive = crypto.randomUUID();
    const assignedInactive = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Active admin', ?, 1, 'admin', 1, ?, ?), (?, 'Inactive admin', ?, 1, 'admin', 0, ?, ?), (?, 'Editor', ?, 1, 'editor', 1, ?, ?), (?, 'Photographer', ?, 1, 'photographer', 1, ?, ?), (?, 'Assigned active', ?, 1, 'editor', 1, ?, ?), (?, 'Assigned inactive', ?, 1, 'editor', 0, ?, ?)")
        .bind(activeAdmin, `${activeAdmin}@example.test`, now, now, inactiveAdmin, `${inactiveAdmin}@example.test`, now, now, editor, `${editor}@example.test`, now, now, photographer, `${photographer}@example.test`, now, now, assignedActive, `${assignedActive}@example.test`, now, now, assignedInactive, `${assignedInactive}@example.test`, now, now),
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Admin recipients', 'edited_review', ?, ?)").bind(projectId, now, now),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?), (?, ?, ?, 'photographer', ?)")
        .bind(crypto.randomUUID(), projectId, editor, now, crypto.randomUUID(), projectId, photographer, now),
    ]);
    const send = vi.fn().mockResolvedValue({ messageId: "test-message" });
    const testEnv = { DB: database.DB, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test", APP_ORIGIN: "https://portal.test" } as unknown as Env;
    for (const type of ["raw_ready", "edited_landed", "sent_to_editing", "autohdr_stalled", "delivered", "comment_added"] as const) {
      await notifyProject(testEnv, projectId, type, type === "comment_added" ? { editorOnly: true } : {});
    }
    const existing = await database.DB.prepare("SELECT user_id, type FROM notifications WHERE project_id = ? AND type <> 'assigned_to_project'").bind(projectId).all<{ user_id: string; type: string }>();
    expect(existing.results.filter((row) => row.user_id === activeAdmin)).toHaveLength(6);
    expect(existing.results.filter((row) => row.user_id === inactiveAdmin)).toHaveLength(0);
    expect(existing.results.filter((row) => row.type === "comment_added" && row.user_id === photographer)).toHaveLength(0);
    expect(existing.results.filter((row) => row.type === "comment_added" && row.user_id === activeAdmin)).toHaveLength(1);

    await notifyProject(testEnv, projectId, "raw_ready", { excludeUserId: activeAdmin });
    const excluded = await database.DB.prepare("SELECT user_id FROM notifications WHERE project_id = ? AND type = 'raw_ready'").bind(projectId).all<{ user_id: string }>();
    expect(excluded.results.filter((row) => row.user_id === activeAdmin)).toHaveLength(1);
    expect(excluded.results.map((row) => row.user_id)).toContain(editor);
    expect(excluded.results.filter((row) => row.user_id === editor)).toHaveLength(2);

  });

  it("records a mocked email failure without failing the notification write", async () => {
    const project = await database.DB.prepare("SELECT id FROM projects WHERE street = 'Comment Street'").first<{ id: string }>();
    const send = async () => { throw new Error("mock email unavailable"); };
    await notifyProject({ DB: database.DB, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test", APP_ORIGIN: "https://portal.test" } as unknown as Env, project!.id, "edited_landed");
    const row = await database.DB.prepare("SELECT email_error FROM notifications WHERE project_id = ? AND type = 'edited_landed' LIMIT 1").bind(project!.id).first<{ email_error: string }>();
    expect(row?.email_error).toContain("mock email unavailable");
  });

  it("uses collaboration-open links for subtask assignments", async () => {
    const now = Date.now();
    const projectId = crypto.randomUUID();
    const actorId = crypto.randomUUID();
    const assigneeId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Mention actor', ?, 1, 'editor', 1, ?, ?), (?, 'Mention assignee', ?, 1, 'editor', 1, ?, ?)").bind(actorId, `${actorId}@example.test`, now, now, assigneeId, `${assigneeId}@example.test`, now, now),
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Collaboration links', 'edited_review', ?, ?)").bind(projectId, now, now),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?), (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, actorId, now, crypto.randomUUID(), projectId, assigneeId, now),
    ]);
    const send = vi.fn().mockResolvedValue({ messageId: "collaboration-link" });
    const testEnv = { DB: database.DB, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test", APP_ORIGIN: "https://portal.test" } as unknown as Env;
    await notifySubtaskAssignee(testEnv, { projectId, actorId, assigneeId, subtaskId: crypto.randomUUID(), assignmentVersion: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    for (const [message] of send.mock.calls) expect(message).toMatchObject({ text: expect.stringContaining(`https://portal.test/projects/${projectId}?collaboration=open`) });
  });
});

describe("notification list per-row project street and cover", () => {
  async function makeProject(street: string, stageKey: string) {
    const projectId = crypto.randomUUID();
    const now = Date.now();
    const rawCollectionId = crypto.randomUUID();
    const editedCollectionId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(projectId, street, stageKey, now, now),
      database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?), (?, ?, 'edited', 'empty', 0, ?, ?)").bind(rawCollectionId, projectId, now, now, editedCollectionId, projectId, now, now),
    ]);
    return { projectId, rawCollectionId, editedCollectionId, now };
  }
  async function makeAsset(collectionId: string, publishStatus: "pending" | "ready" = "ready") {
    const assetId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, publish_status, created_at, updated_at) VALUES (?, ?, ?, 'frame.jpg', 1, 'upload', ?, ?, ?)")
      .bind(assetId, collectionId, `assets/${assetId}.jpg`, publishStatus, now, now).run();
    return assetId;
  }
  async function makeNotification(userId: string, projectId: string | null, title: string) {
    const id = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, body, created_at) VALUES (?, ?, ?, 'raw_ready', ?, 'Body', ?)")
      .bind(id, userId, projectId, title, Date.now()).run();
    return id;
  }
  function notificationRow(body: unknown, title: string) {
    return (body as { notifications: Array<Record<string, unknown>> }).notifications.find((row) => row.title === title);
  }

  it("returns the project street and the effective cover asset on every project row", async () => {
    const { projectId, rawCollectionId } = await makeProject("Automatic Cover Street", "editing");
    const rawAssetId = await makeAsset(rawCollectionId);
    const title = "Automatic cover notification";
    await makeNotification(userA, projectId, title);
    const response = await request("/api/notifications", tokenA);
    expect(response.status).toBe(200);
    const row = notificationRow(await response.json(), title);
    expect(row).toMatchObject({ projectStreet: "Automatic Cover Street", coverAssetId: rawAssetId });
  });

  it("prefers the stored cover over the first RAW frame", async () => {
    const { projectId, rawCollectionId, editedCollectionId } = await makeProject("Stored Cover Street", "editing");
    await makeAsset(rawCollectionId);
    const editedAssetId = await makeAsset(editedCollectionId, "ready");
    await database.DB.prepare("UPDATE projects SET cover_asset_id = ? WHERE id = ?").bind(editedAssetId, projectId).run();
    const title = "Stored cover notification";
    await makeNotification(userA, projectId, title);
    const response = await request("/api/notifications", tokenA);
    const row = notificationRow(await response.json(), title);
    expect(row).toMatchObject({ projectStreet: "Stored Cover Street", coverAssetId: editedAssetId });
  });

  it("never names an edited cover for a photographer", async () => {
    const { projectId, rawCollectionId, editedCollectionId } = await makeProject("Photographer Cover Street", "raw_review");
    const rawAssetId = await makeAsset(rawCollectionId);
    const editedAssetId = await makeAsset(editedCollectionId, "ready");
    await database.DB.prepare("UPDATE projects SET cover_asset_id = ? WHERE id = ?").bind(editedAssetId, projectId).run();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)")
      .bind(crypto.randomUUID(), projectId, photographer, Date.now()).run();
    const title = "Photographer cover notification";
    await makeNotification(photographer, projectId, title);
    const response = await request("/api/notifications", tokenPhotographer);
    const row = notificationRow(await response.json(), title);
    expect(row).toMatchObject({ projectStreet: "Photographer Cover Street", coverAssetId: rawAssetId });
  });

  it("returns a null street and cover when the notification has no project", async () => {
    const title = "Projectless notification";
    await makeNotification(userA, null, title);
    const response = await request("/api/notifications", tokenA);
    const row = notificationRow(await response.json(), title);
    expect(row).toMatchObject({ projectStreet: null, coverAssetId: null });
  });

  it("keeps the notification but nulls street and cover when the recipient can no longer see the project", async () => {
    const { projectId } = await makeProject("Revoked Access Street", "raw_review");
    const membershipId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)")
      .bind(membershipId, projectId, photographer, Date.now()).run();
    const title = "Revoked access notification";
    await makeNotification(photographer, projectId, title);
    await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(membershipId).run();
    const response = await request("/api/notifications", tokenPhotographer);
    expect(response.status).toBe(200);
    const row = notificationRow(await response.json(), title);
    expect(row).toMatchObject({ projectStreet: null, coverAssetId: null });
  });

  it("does not duplicate notifications when a project has multiple memberships", async () => {
    const { projectId, rawCollectionId } = await makeProject("Multi Membership Street", "editing");
    const rawAssetId = await makeAsset(rawCollectionId);
    // Two distinct memberships on the same project: the recipient (userA) sees it via editor's
    // viewAllProjects, not via membership, but the context query's left join still fans out one
    // row per member — it must dedupe on project id, not surface a duplicate notification row.
    await database.DB.batch([
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userA, Date.now()),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userB, Date.now()),
    ]);
    const title = "Multi membership notification";
    await makeNotification(userA, projectId, title);
    const response = await request("/api/notifications", tokenA);
    const body = await response.json() as { notifications: Array<Record<string, unknown>> };
    expect(body.notifications.filter((row) => row.title === title)).toHaveLength(1);
    expect(notificationRow(body, title)).toMatchObject({ projectStreet: "Multi Membership Street", coverAssetId: rawAssetId });
  });

  /**
   * One notification the external-editor branch's visibility CTE accepts: a current editor
   * membership, and outbox + ledger rows shaped exactly as `externalVisibleNotificationWhere`'s
   * `project.external_safe.direct` arm requires. Returns the handles the cases below revoke.
   */
  async function seedExternalDirectNotification(street: string, cover: "ready" | "pending" | "none" = "ready") {
    const { projectId, editedCollectionId } = await makeProject(street, "editing");
    const coverAssetId = cover === "none" ? null : await makeAsset(editedCollectionId, cover);
    if (coverAssetId) await database.DB.prepare("UPDATE projects SET cover_asset_id = ? WHERE id = ?").bind(coverAssetId, projectId).run();
    const membershipId = crypto.randomUUID();
    const startedAt = Date.now();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)")
      .bind(membershipId, projectId, externalEditor, startedAt).run();

    const title = `External notification ${crypto.randomUUID()}`;
    const notificationId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    const sourceKey = `external-cover:${crypto.randomUUID()}`;
    const now = Date.now();
    const payload = JSON.stringify({
      schemaVersion: 1,
      event: { type: "project.external_safe.direct", sourceKey, recipientId: externalEditor },
      authorizationAtOccurrence: { kind: "project_editor_membership", membershipCycle: membershipId, startedAt },
      legacy: { type: "raw_ready", projectId, sourceId: sourceKey },
    });
    await database.DB.batch([
      database.DB.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, body, source_key, created_at) VALUES (?, ?, ?, 'raw_ready', ?, 'Body', ?, ?)")
        .bind(notificationId, externalEditor, projectId, title, sourceKey, now),
      database.DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, recipient_authorization_epoch, payload_json, status, available_at, recipient_membership_cycle_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(outboxId, 1, "project.external_safe.direct", sourceKey, projectId, externalEditor, externalEditor, 0, payload, "completed", now, membershipId, now, now),
      database.DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, notification_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'in_app', 'sent', ?, ?, ?)")
        .bind(crypto.randomUUID(), outboxId, "project.external_safe.direct", sourceKey, externalEditor, notificationId, now, now),
    ]);
    return { projectId, coverAssetId, membershipId, title };
  }

  async function externalList() {
    const response = await request("/api/notifications", tokenExternalEditor);
    expect(response.status).toBe(200);
    return await response.json() as { notifications: Array<Record<string, unknown>>; unreadCount: number };
  }

  it("returns the street and the effective cover asset on the external-editor notification branch", async () => {
    const { coverAssetId, title } = await seedExternalDirectNotification("External Cover Street");
    const body = await externalList();
    expect(notificationRow(body, title)).toMatchObject({ projectStreet: "External Cover Street", coverAssetId });
    expect(body.unreadCount).toBe(body.notifications.filter((row) => row.readAt === null).length);
  });

  it("never names a pending edited cover to an external editor", async () => {
    const { title } = await seedExternalDirectNotification("Pending Cover Street", "pending");
    const row = notificationRow(await externalList(), title);
    expect(row).toMatchObject({ projectStreet: "Pending Cover Street", coverAssetId: null });
  });

  it("drops the row and its count once the external editor's membership is revoked", async () => {
    const { membershipId, title } = await seedExternalDirectNotification("Revoked Street");
    expect(notificationRow(await externalList(), title)).toBeDefined();
    await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(membershipId).run();
    const body = await externalList();
    expect(notificationRow(body, title)).toBeUndefined();
    expect(body.notifications.some((row) => row.projectStreet === "Revoked Street")).toBe(false);
    expect(body.unreadCount).toBe(body.notifications.filter((row) => row.readAt === null).length);
  });

  it("drops the row and its count once the project is archived", async () => {
    const { projectId, title } = await seedExternalDirectNotification("Archived Street");
    expect(notificationRow(await externalList(), title)).toBeDefined();
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), projectId).run();
    const body = await externalList();
    expect(notificationRow(body, title)).toBeUndefined();
    expect(body.unreadCount).toBe(body.notifications.filter((row) => row.readAt === null).length);
  });
});

describe("notification read-model enrichment", () => {
  async function makeProject(street: string, stageKey = "editing") {
    const projectId = crypto.randomUUID();
    const now = Date.now();
    const rawCollectionId = crypto.randomUUID();
    const editedCollectionId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(projectId, street, stageKey, now, now),
      database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?), (?, ?, 'edited', 'empty', 0, ?, ?)").bind(rawCollectionId, projectId, now, now, editedCollectionId, projectId, now, now),
    ]);
    return { projectId, rawCollectionId, editedCollectionId };
  }

  async function makeAsset(collectionId: string, filename = "frame.jpg", publishStatus: "pending" | "ready" = "ready") {
    const assetId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, publish_status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'upload', ?, ?, ?)")
      .bind(assetId, collectionId, `assets/${assetId}.jpg`, filename, publishStatus, now, now).run();
    return assetId;
  }

  async function makeAnnotation(assetId: string, authorId: string, noteText: string | null) {
    const annotationId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO annotations (id, asset_id, author_id, author_role, scope, note_text, created_at) VALUES (?, ?, ?, 'editor', 'raw', ?, ?)")
      .bind(annotationId, assetId, authorId, noteText, Date.now()).run();
    return annotationId;
  }

  async function makeStaffMember(projectId: string, userId: string, roleOnProject: "editor" | "photographer" = "editor") {
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), projectId, userId, roleOnProject, Date.now()).run();
  }

  async function makeNotification(input: { userId: string; projectId: string | null; type: string; title?: string; body?: string | null; sourceKey?: string | null; createdAt?: number }) {
    const id = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, body, source_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, input.userId, input.projectId, input.type, input.title ?? "Stored title", input.body ?? "Stored body", input.sourceKey ?? null, input.createdAt ?? Date.now()).run();
    return id;
  }

  async function makeProjectComment(projectId: string, authorId: string, body: string) {
    const commentId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO project_comments (id, project_id, author_id, body, content_json, created_at) VALUES (?, ?, ?, ?, '{}', ?)")
      .bind(commentId, projectId, authorId, body, Date.now()).run();
    return commentId;
  }

  async function makeProjectCommentMention(commentId: string, mentionedUserId: string) {
    const mentionId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO project_comment_mentions (id, comment_id, mentioned_user_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(mentionId, commentId, mentionedUserId, Date.now()).run();
    return mentionId;
  }

  async function makeNoticeBoardPost(authorId: string, body: string) {
    const postId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO notice_board_posts (id, author_id, body, created_at) VALUES (?, ?, ?, ?)")
      .bind(postId, authorId, body, Date.now()).run();
    return postId;
  }

  async function makeNoticeBoardMention(postId: string, mentionedUserId: string) {
    const mentionId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO notice_board_post_mentions (id, post_id, mentioned_user_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(mentionId, postId, mentionedUserId, Date.now()).run();
    return mentionId;
  }

  async function makeSubtask(projectId: string, title: string, assigneeId: string | null, assignmentVersion = 1) {
    const subtaskId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignee_id, assignment_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?)")
      .bind(subtaskId, projectId, title, assigneeId, assignmentVersion, admin, now, now).run();
    return subtaskId;
  }

  /** A staff-visible ledger row: notification_delivery_ledger -> notification_outbox -> user (actor). */
  async function makeLedgerActor(notificationId: string, recipientId: string, actorId: string) {
    const outboxId = crypto.randomUUID();
    const sourceKey = crypto.randomUUID();
    const now = Date.now();
    await database.DB.batch([
      database.DB.prepare(
        "INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, created_at, updated_at) VALUES (?, 1, 'project.assignment.created', ?, ?, ?, ?, '{}', 'completed', ?, ?, ?)",
      ).bind(outboxId, sourceKey, crypto.randomUUID(), actorId, recipientId, now, now, now),
      database.DB.prepare(
        "INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, notification_id, created_at, updated_at) VALUES (?, ?, 'project.assignment.created', ?, ?, 'in_app', 'sent', ?, ?, ?)",
      ).bind(crypto.randomUUID(), outboxId, sourceKey, recipientId, notificationId, now, now),
    ]);
    // A fresh random sourceKey per call keeps every test's ledger row independent of the
    // (event_type, source_key, recipient_id, channel) unique constraint.
  }

  async function fetchAsAdmin() {
    const response = await request("/api/notifications", tokenAdmin);
    expect(response.status).toBe(200);
    return await response.json() as { notifications: Array<Record<string, unknown>>; unreadCount: number };
  }

  async function fetchAs(token: string) {
    const response = await request("/api/notifications", token);
    expect(response.status).toBe(200);
    return await response.json() as { notifications: Array<Record<string, unknown>>; unreadCount: number };
  }

  function rowFor(body: { notifications: Array<Record<string, unknown>> }, id: string) {
    return body.notifications.find((row) => row.id === id);
  }

  it("enriches comment_added title/body/actor/subject/assetId for a staff recipient", async () => {
    const { projectId, rawCollectionId } = await makeProject("Enrichment Comment Street");
    const assetId = await makeAsset(rawCollectionId, "frame.jpg");
    const annotationId = await makeAnnotation(assetId, userA, "Please re-crop this shot.");
    const notificationId = await makeNotification({ userId: admin, projectId, type: "comment_added", sourceKey: `annotation:${annotationId}` });
    const row = rowFor(await fetchAsAdmin(), notificationId);
    expect(row).toMatchObject({
      title: "Notification A commented on frame.jpg",
      body: "Please re-crop this shot.",
      actor: { id: userA, name: "Notification A" },
      subject: { kind: "asset", label: "frame.jpg" },
      assetId,
    });
  });

  it("does not compose 'You commented on' when the annotation author is the recipient", async () => {
    const { projectId, rawCollectionId } = await makeProject("Enrichment Self Comment Street");
    const assetId = await makeAsset(rawCollectionId, "own-frame.jpg");
    const annotationId = await makeAnnotation(assetId, userB, "I should revisit this crop.");
    const notificationId = await makeNotification({ userId: userB, projectId, type: "comment_added", title: "Stored own-comment title", body: "Stored own-comment body", sourceKey: `annotation:${annotationId}` });
    const row = rowFor(await fetchAs(tokenB), notificationId);
    expect(row).toMatchObject({
      title: "Stored own-comment title",
      body: "I should revisit this crop.",
      actor: null,
      subject: { kind: "asset", label: "own-frame.jpg" },
      assetId,
    });
    expect(row?.title).not.toContain("You commented on");
  });

  it("uses the actor's current name when it changed after the notification was emitted", async () => {
    const actorId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Original Actor Name', ?, 1, 'editor', 1, ?, ?)")
      .bind(actorId, `${actorId}@example.test`, now, now).run();
    const { projectId, rawCollectionId } = await makeProject("Enrichment Renamed Actor Street");
    const assetId = await makeAsset(rawCollectionId, "renamed-frame.jpg");
    const annotationId = await makeAnnotation(assetId, actorId, "Name this comment with the current actor.");
    const notificationId = await makeNotification({ userId: admin, projectId, type: "comment_added", sourceKey: `annotation:${annotationId}` });
    await database.DB.prepare("UPDATE user SET name = ?, updated_at = ? WHERE id = ?").bind("Current Actor Name", Date.now(), actorId).run();

    const row = rowFor(await fetchAsAdmin(), notificationId);
    expect(row).toMatchObject({
      title: "Current Actor Name commented on renamed-frame.jpg",
      actor: { id: actorId, name: "Current Actor Name" },
    });
  });

  it("keeps actor enrichment but omits the superseded asset and its filename", async () => {
    const { projectId, rawCollectionId } = await makeProject("Enrichment Superseded Asset Street");
    const assetId = await makeAsset(rawCollectionId, "superseded-frame.jpg");
    const annotationId = await makeAnnotation(assetId, userA, "This annotation is on an old version.");
    const notificationId = await makeNotification({ userId: admin, projectId, type: "comment_added", title: "Stored superseded title", body: "Stored superseded body", sourceKey: `annotation:${annotationId}` });
    await database.DB.prepare("UPDATE assets SET superseded_at = ? WHERE id = ?").bind(Date.now(), assetId).run();

    const body = await fetchAsAdmin();
    const row = rowFor(body, notificationId);
    expect(row).toMatchObject({
      title: "Stored superseded title",
      body: "Stored superseded body",
      actor: { id: userA, name: "Notification A" },
      subject: null,
      assetId: null,
    });
    expect(JSON.stringify(row)).not.toContain("superseded-frame.jpg");
  });

  it("omits the asset when its collection belongs to a different project", async () => {
    const { projectId: notificationProjectId } = await makeProject("Enrichment Collection Mismatch Notification Street");
    const { projectId: assetProjectId, rawCollectionId } = await makeProject("Enrichment Collection Mismatch Asset Street");
    const assetId = await makeAsset(rawCollectionId, "cross-project-frame.jpg");
    const annotationId = await makeAnnotation(assetId, userA, "This asset belongs to another project.");
    const notificationId = await makeNotification({ userId: admin, projectId: notificationProjectId, type: "comment_added", title: "Stored cross-project title", body: "Stored cross-project body", sourceKey: `annotation:${annotationId}` });

    const row = rowFor(await fetchAsAdmin(), notificationId);
    expect(row).toMatchObject({
      title: "Stored cross-project title",
      body: "Stored cross-project body",
      actor: null,
      subject: null,
      assetId: null,
    });
    expect(row?.projectId).toBe(notificationProjectId);
    expect(row?.assetId).not.toBe(assetId);
    expect(assetProjectId).not.toBe(notificationProjectId);
  });

  it("gives a photographer recipient the actor but neither the EDITED asset, its filename, nor the note about it", async () => {
    const { projectId, editedCollectionId } = await makeProject("Enrichment Photographer Street", "raw_review");
    await makeStaffMember(projectId, photographer, "photographer");
    const assetId = await makeAsset(editedCollectionId, "edit.jpg", "ready");
    const annotationId = await makeAnnotation(assetId, userA, "Edited note.");
    const notificationId = await makeNotification({ userId: photographer, projectId, type: "comment_added", title: "Stored comment title", body: "Stored comment body", sourceKey: `annotation:${annotationId}` });
    const body = await fetchAs(tokenPhotographer);
    const row = rowFor(body, notificationId);
    expect(row).toMatchObject({
      title: "Stored comment title",
      body: "Stored comment body",
      actor: { id: userA, name: "Notification A" },
      subject: null,
      assetId: null,
    });
    expect(JSON.stringify(body)).not.toContain("edit.jpg");
    expect(JSON.stringify(body)).not.toContain("Edited note.");
  });

  it("falls back to the stored copy with nulls when the annotation has been deleted", async () => {
    const { projectId } = await makeProject("Enrichment Deleted Annotation Street");
    const notificationId = await makeNotification({ userId: admin, projectId, type: "comment_added", title: "Stored deleted-annotation title", body: "Stored deleted-annotation body", sourceKey: `annotation:${crypto.randomUUID()}` });
    const row = rowFor(await fetchAsAdmin(), notificationId);
    expect(row).toMatchObject({ title: "Stored deleted-annotation title", body: "Stored deleted-annotation body", actor: null, subject: null, assetId: null });
  });

  it("enriches a project-comment mention (actor = comment author, body = comment text clamped)", async () => {
    const { projectId } = await makeProject("Enrichment Project Mention Street");
    await makeStaffMember(projectId, userB);
    const commentId = await makeProjectComment(projectId, userA, "Please review the collection order.");
    const mentionId = await makeProjectCommentMention(commentId, userB);
    const notificationId = await makeNotification({ userId: userB, projectId, type: "mentioned", sourceKey: mentionId });
    const row = rowFor(await fetchAs(tokenB), notificationId);
    expect(row).toMatchObject({
      title: "Notification A mentioned you",
      body: "Please review the collection order.",
      actor: { id: userA, name: "Notification A" },
      subject: { kind: "project_comment", label: "Please review the collection order." },
      assetId: null,
    });
  });

  it("enriches a notice-board mention", async () => {
    const postId = await makeNoticeBoardPost(userA, "Studio closed Friday for stocktake.");
    const mentionId = await makeNoticeBoardMention(postId, userB);
    const notificationId = await makeNotification({ userId: userB, projectId: null, type: "mentioned", sourceKey: mentionId });
    const row = rowFor(await fetchAs(tokenB), notificationId);
    expect(row).toMatchObject({
      title: "Notification A mentioned you on the Notice Board",
      body: "Studio closed Friday for stocktake.",
      actor: { id: userA, name: "Notification A" },
      subject: { kind: "notice_board_post", label: "Studio closed Friday for stocktake." },
      assetId: null,
    });
  });

  it("resolves assigned_to_project's actor for a staff recipient via the ledger, not the sourceKey", async () => {
    const { projectId } = await makeProject("Enrichment Assigned Street");
    const notificationId = await makeNotification({ userId: userB, projectId, type: "assigned_to_project", title: "Project assigned", body: "You were assigned to a project.", sourceKey: crypto.randomUUID() });
    await makeLedgerActor(notificationId, userB, userA);
    const row = rowFor(await fetchAs(tokenB), notificationId);
    expect(row).toMatchObject({
      title: "Notification A assigned you to this project",
      body: "You were assigned to a project.",
      actor: { id: userA, name: "Notification A" },
      subject: null,
      assetId: null,
    });
  });

  it("never resolves an actor for project_activity's system outbox sentinel", async () => {
    const { projectId } = await makeProject("Enrichment System Activity Street");
    const notificationId = await makeNotification({ userId: userB, projectId, type: "project_activity", title: "System — did a thing", body: "Unchanged body" });
    await makeLedgerActor(notificationId, userB, PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID);
    const row = rowFor(await fetchAs(tokenB), notificationId);
    expect(row).toMatchObject({ title: "System — did a thing", body: "Unchanged body", actor: null, subject: null, assetId: null });
  });

  it("resolves a real actor for project_collaboration_activity when the outbox actor is a user", async () => {
    const { projectId } = await makeProject("Enrichment Collaboration Activity Street");
    const notificationId = await makeNotification({ userId: userB, projectId, type: "project_collaboration_activity", title: "Notification A — added a comment", body: "Unchanged body" });
    await makeLedgerActor(notificationId, userB, userA);
    const row = rowFor(await fetchAs(tokenB), notificationId);
    expect(row).toMatchObject({ title: "Notification A — added a comment", body: "Unchanged body", actor: { id: userA, name: "Notification A" }, subject: null, assetId: null });
  });

  it("gives a staff subtask_assigned recipient an unchanged title, the subtask title as body, and no actor", async () => {
    const { projectId } = await makeProject("Enrichment Subtask Street");
    await makeStaffMember(projectId, userB);
    const subtaskId = await makeSubtask(projectId, "Retouch the hero shot", userB);
    const notificationId = await makeNotification({ userId: userB, projectId, type: "subtask_assigned", title: "Subtask assigned", body: "You have been assigned a project subtask.", sourceKey: `subtask-assignment:${subtaskId}:1` });
    const row = rowFor(await fetchAs(tokenB), notificationId);
    expect(row).toMatchObject({
      title: "Subtask assigned",
      body: "Retouch the hero shot",
      actor: null,
      subject: { kind: "subtask", label: "Retouch the hero shot" },
      assetId: null,
    });
  });

  it("clamps a 10k-character comment body to 280 characters ending in an ellipsis", async () => {
    const { projectId, rawCollectionId } = await makeProject("Enrichment Clamp Street");
    const assetId = await makeAsset(rawCollectionId, "long-note.jpg");
    const longNote = "a".repeat(10_000);
    const annotationId = await makeAnnotation(assetId, userA, longNote);
    const notificationId = await makeNotification({ userId: admin, projectId, type: "comment_added", sourceKey: `annotation:${annotationId}` });
    const row = rowFor(await fetchAsAdmin(), notificationId);
    expect((row?.body as string)).toHaveLength(280);
    expect((row?.body as string).endsWith("…")).toBe(true);
  });

  it("enriches nothing for a notification whose project the recipient can no longer see", async () => {
    const { projectId, rawCollectionId } = await makeProject("Enrichment Revoked Street");
    const membershipId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)")
      .bind(membershipId, projectId, photographer, Date.now()).run();
    const assetId = await makeAsset(rawCollectionId, "revoked.jpg");
    const annotationId = await makeAnnotation(assetId, userA, "Revoked note.");
    const notificationId = await makeNotification({ userId: photographer, projectId, type: "comment_added", title: "Stored revoked title", body: "Stored revoked body", sourceKey: `annotation:${annotationId}` });
    await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(membershipId).run();
    const row = rowFor(await fetchAs(tokenPhotographer), notificationId);
    expect(row).toMatchObject({ title: "Stored revoked title", body: "Stored revoked body", actor: null, subject: null, assetId: null, projectStreet: null });
  });

  it("passes a row of a type this build no longer knows through unchanged instead of failing the list", async () => {
    const { projectId } = await makeProject("Enrichment Retired Type Street");
    const retiredId = await makeNotification({ userId: userB, projectId, type: "retired_type", title: "Retired title", body: "Retired body", sourceKey: `annotation:${crypto.randomUUID()}` });
    const body = await fetchAs(tokenB);
    expect(rowFor(body, retiredId)).toMatchObject({ type: "retired_type", title: "Retired title", body: "Retired body", actor: null, subject: null, assetId: null });
  });

  it("leaves every one of the seven no-actor types with a null actor and the six purely-passthrough types with an untouched title and body", async () => {
    const { projectId } = await makeProject("Enrichment No-Actor Types Street");
    await makeStaffMember(projectId, userB);
    const passthroughTypes = ["raw_ready", "edited_landed", "sent_to_editing", "autohdr_stalled", "delivered", "project_deadline_reminder"] as const;
    const passthroughIds = await Promise.all(passthroughTypes.map((type) => makeNotification({ userId: userB, projectId, type, title: `${type} title`, body: `${type} body` })));

    const dueSubtaskId = await makeSubtask(projectId, "Deliver the gallery link", userB);
    const dueNotificationId = await makeNotification({ userId: userB, projectId, type: "subtask_due_today", title: "Subtask due today", body: "An assigned checklist item is due today.", sourceKey: `subtask-due:${dueSubtaskId}:2026-09-15` });

    const body = await fetchAs(tokenB);
    for (const [index, type] of passthroughTypes.entries()) {
      const row = rowFor(body, passthroughIds[index]);
      expect(row).toMatchObject({ title: `${type} title`, body: `${type} body`, actor: null, subject: null, assetId: null });
    }
    const dueRow = rowFor(body, dueNotificationId);
    expect(dueRow).toMatchObject({
      title: "Subtask due today",
      body: "Deliver the gallery link",
      actor: null,
      subject: { kind: "subtask", label: "Deliver the gallery link" },
      assetId: null,
    });
  });

  it("issues no more prepared statements for a 30-row comment_added page than for a 1-row page", async () => {
    const { projectId, rawCollectionId } = await makeProject("Enrichment Query Count Street");
    const countUserId = crypto.randomUUID();
    const countToken = `notifications-count-${crypto.randomUUID()}`;
    const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Notification Count', ?, 1, 'editor', 1, ?, ?)")
        .bind(countUserId, `${countUserId}@example.test`, now, now),
      database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), now + 3_600_000, countToken, countUserId, now, now),
    ]);
    await makeStaffMember(projectId, countUserId);
    const seededIds: string[] = [];

    async function seedRow() {
      const assetId = await makeAsset(rawCollectionId, "count.jpg");
      const annotationId = await makeAnnotation(assetId, userA, "Count me.");
      const id = await makeNotification({ userId: countUserId, projectId, type: "comment_added", sourceKey: `annotation:${annotationId}`, createdAt: Date.now() });
      seededIds.push(id);
      return id;
    }
    await seedRow();

    async function countPreparedStatements(limit: number): Promise<{ calls: number; ids: string[] }> {
      for (let i = 1; i < limit; i += 1) await seedRow();
      let calls = 0;
      const originalPrepare = database.DB.prepare.bind(database.DB);
      database.DB.prepare = ((sql: string) => {
        calls += 1;
        return originalPrepare(sql);
      }) as typeof database.DB.prepare;
      try {
        const response = await request(`/api/notifications?limit=${limit}`, countToken);
        expect(response.status).toBe(200);
        const parsed = await response.json() as { notifications: Array<{ id: string }> };
        expect(parsed.notifications).toHaveLength(limit);
        const returnedIds = parsed.notifications.map((row) => row.id);
        expect(returnedIds).toEqual(expect.arrayContaining(seededIds));
        return { calls, ids: returnedIds };
      } finally {
        database.DB.prepare = originalPrepare;
      }
    }

    const warmup = await request("/api/notifications?limit=1", countToken);
    expect(warmup.status).toBe(200);
    await warmup.json();
    const onePage = await countPreparedStatements(1);
    const thirtyPage = await countPreparedStatements(30);
    expect(thirtyPage.calls).toBe(onePage.calls);
    expect(thirtyPage.ids).toEqual(expect.arrayContaining(seededIds));
  });

  it("keeps one row per notification and counts the unread rows without an aggregate", async () => {
    const recipientId = crypto.randomUUID();
    const recipientToken = `notifications-unaggregated-${crypto.randomUUID()}`;
    const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Notification Unaggregated', ?, 1, 'editor', 1, ?, ?)")
        .bind(recipientId, `${recipientId}@example.test`, now, now),
      database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), now + 3_600_000, recipientToken, recipientId, now, now),
    ]);
    const { projectId } = await makeProject("Enrichment No Aggregate Street");
    await makeStaffMember(projectId, recipientId);
    const ids = await Promise.all([
      makeNotification({ userId: recipientId, projectId, type: "comment_added", title: "First stored notification", body: "First stored body", sourceKey: `legacy:first:${crypto.randomUUID()}`, createdAt: now + 2 }),
      makeNotification({ userId: recipientId, projectId, type: "comment_added", title: "Second stored notification", body: "Second stored body", sourceKey: `legacy:second:${crypto.randomUUID()}`, createdAt: now + 1 }),
    ]);
    await database.DB.prepare("UPDATE notifications SET read_at = ? WHERE id = ?").bind(Date.now(), ids[1]).run();

    const body = await fetchAs(recipientToken);
    expect(body.notifications).toHaveLength(2);
    expect(new Set(body.notifications.map((row) => row.id))).toEqual(new Set(ids));
    expect(body.unreadCount).toBe(1);
    expect(body.unreadCount).toBe(body.notifications.filter((row) => row.readAt === null).length);
    expect(body.notifications).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ title: expect.stringMatching(/\b2\b|count|aggregate/i) }),
    ]));
  });
  describe("collaboration gate", () => {
    // The comment and subtask routes answer 403 to a non-member editor even though
    // `viewAllProjects` lets them see the project (hasProjectCollaborationAccessForUser). The
    // enriched row must not say more than those routes would.
    it("gives a non-member editor the stored copy for a mention and a subtask, and enriches once they are a member", async () => {
      const { projectId } = await makeProject("Enrichment Non-Member Street");
      const commentId = await makeProjectComment(projectId, userA, "Secret comment for members only.");
      const mentionId = await makeProjectCommentMention(commentId, userB);
      const mentionNotificationId = await makeNotification({ userId: userB, projectId, type: "mentioned", title: "You were mentioned", body: "You were mentioned.", sourceKey: mentionId });
      const subtaskId = await makeSubtask(projectId, "Members-only subtask", userB);
      const subtaskNotificationId = await makeNotification({ userId: userB, projectId, type: "subtask_due_today", title: "Subtask due today", body: "Stored due body", sourceKey: `subtask-due:${subtaskId}:2026-09-15` });

      const before = await fetchAs(tokenB);
      expect(rowFor(before, mentionNotificationId)).toMatchObject({ title: "You were mentioned", body: "You were mentioned.", actor: null, subject: null, assetId: null });
      expect(rowFor(before, subtaskNotificationId)).toMatchObject({ title: "Subtask due today", body: "Stored due body", actor: null, subject: null });
      expect(JSON.stringify(before)).not.toContain("Secret comment for members only.");
      expect(JSON.stringify(before)).not.toContain("Members-only subtask");

      await makeStaffMember(projectId, userB);
      const after = await fetchAs(tokenB);
      expect(rowFor(after, mentionNotificationId)).toMatchObject({ title: "Notification A mentioned you", body: "Secret comment for members only." });
      expect(rowFor(after, subtaskNotificationId)).toMatchObject({ body: "Members-only subtask", subject: { kind: "subtask", label: "Members-only subtask" } });
    });

    it("enriches a mention for an admin without a membership row, like the comment route does", async () => {
      const { projectId } = await makeProject("Enrichment Admin Mention Street");
      const adminId = crypto.randomUUID();
      const adminToken = `notifications-real-admin-${crypto.randomUUID()}`;
      const now = Date.now();
      await database.DB.batch([
        database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Real Admin', ?, 1, 'admin', 1, ?, ?)").bind(adminId, `${adminId}@example.test`, now, now),
        database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, adminToken, adminId, now, now),
      ]);
      const commentId = await makeProjectComment(projectId, userA, "Admin-visible comment.");
      const mentionId = await makeProjectCommentMention(commentId, adminId);
      const notificationId = await makeNotification({ userId: adminId, projectId, type: "mentioned", sourceKey: mentionId });
      expect(rowFor(await fetchAs(adminToken), notificationId)).toMatchObject({ title: "Notification A mentioned you", body: "Admin-visible comment.", actor: { id: userA } });
      // Leave no active admin behind: projectNotificationRecipients() would add one to every
      // later project's recipient set and break the exact-recipient tests above.
      await database.DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(adminId).run();
    });

    it("ignores a mention row addressed to somebody else even when the source key is this recipient's", async () => {
      const { projectId } = await makeProject("Enrichment Wrong Recipient Street");
      await makeStaffMember(projectId, userB);
      const commentId = await makeProjectComment(projectId, userA, "Addressed to A's colleague, not B.");
      const mentionId = await makeProjectCommentMention(commentId, photographer);
      const notificationId = await makeNotification({ userId: userB, projectId, type: "mentioned", title: "You were mentioned", body: "You were mentioned.", sourceKey: mentionId });
      const body = await fetchAs(tokenB);
      expect(rowFor(body, notificationId)).toMatchObject({ title: "You were mentioned", body: "You were mentioned.", actor: null, subject: null });
      expect(JSON.stringify(body)).not.toContain("Addressed to A's colleague");
    });

    it("keeps every returned row inside its type's declared enriched form", async () => {
      // Every row this recipient has accumulated across the enrichment tests, held against the
      // shared declaration table — the enumeration the issue asks for, applied to real output.
      const stored = new Map<string, { title: string; body: string | null }>();
      const rows = await database.DB.prepare("SELECT id, title, body FROM notifications WHERE user_id = ?").bind(userB).all<{ id: string; title: string; body: string | null }>();
      for (const row of rows.results) stored.set(row.id, { title: row.title, body: row.body });
      const body = await fetchAs(tokenB);
      expect(body.notifications.length).toBeGreaterThan(5);
      for (const row of body.notifications) {
        const original = stored.get(row.id as string)!;
        expect(conformsToNotificationEnrichment(row.type as string, row as never, original)).toBe(true);
      }
    });
  });
});

describe("notification enrichment — external boundary (staff-only)", () => {
  async function makeProject(street: string) {
    const projectId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, ?, 'editing', ?, ?)").bind(projectId, street, now, now).run();
    return projectId;
  }

  async function externalList() {
    const response = await request("/api/notifications", tokenExternalEditor);
    expect(response.status).toBe(200);
    return await response.json() as { notifications: Array<Record<string, unknown>>; unreadCount: number };
  }

  async function staffList(token: string) {
    const response = await request("/api/notifications", token);
    expect(response.status).toBe(200);
    return await response.json() as { notifications: Array<Record<string, unknown>>; unreadCount: number };
  }

  /**
   * Wires a `mentioned` notification an external editor is legitimately allowed to see
   * (EXTERNAL_LEGACY_NOTIFICATION_POLICY's `project.comment.mentioned` durable event), matching
   * every predicate `externalVisibleNotificationWhere` checks.
   */
  async function seedExternalMention(projectId: string, commentId: string, mentionedUserId: string) {
    const membershipId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)")
      .bind(membershipId, projectId, mentionedUserId, now).run();
    const mentionId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO project_comment_mentions (id, comment_id, mentioned_user_id, created_at) VALUES (?, ?, ?, ?)")
      .bind(mentionId, commentId, mentionedUserId, now).run();
    const notificationId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    const payload = JSON.stringify({
      schemaVersion: 1,
      event: { type: "project.comment.mentioned", sourceKey: mentionId, recipientId: mentionedUserId },
      authorizationAtOccurrence: { kind: "project_member", membershipIds: [membershipId] },
      projectCommentActivity: { activity: { projectId, safePayload: { commentId } } },
    });
    await database.DB.batch([
      database.DB.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, body, source_key, created_at) VALUES (?, ?, ?, 'mentioned', 'You were mentioned', 'You were mentioned in a project comment.', ?, ?)")
        .bind(notificationId, mentionedUserId, projectId, mentionId, now),
      database.DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, recipient_authorization_epoch, payload_json, status, available_at, created_at, updated_at) VALUES (?, 1, 'project.comment.mentioned', ?, ?, ?, ?, 0, ?, 'completed', ?, ?, ?)")
        .bind(outboxId, mentionId, projectId, mentionedUserId, mentionedUserId, payload, now, now, now),
      database.DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, notification_id, created_at, updated_at) VALUES (?, ?, 'project.comment.mentioned', ?, ?, 'in_app', 'sent', ?, ?, ?)")
        .bind(crypto.randomUUID(), outboxId, mentionId, mentionedUserId, notificationId, now, now),
    ]);
    return notificationId;
  }

  /** A second, independently-visible external row (the direct-legacy arm) so the leak test can
   * prove enrichment absence doesn't come at the cost of dropping rows. */
  async function seedExternalDirectRow(projectId: string, options: { type?: "raw_ready" | "comment_added"; sourceKey?: string } = {}) {
    const now = Date.now();
    const existing = await database.DB.prepare("SELECT id, created_at FROM project_members WHERE project_id = ? AND user_id = ? AND role_on_project = 'editor'").bind(projectId, externalEditor).first<{ id: string; created_at: number }>();
    const membershipId = existing?.id ?? crypto.randomUUID();
    const membershipStartedAt = existing?.created_at ?? now;
    if (!existing) {
      await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)")
        .bind(membershipId, projectId, externalEditor, membershipStartedAt).run();
    }
    const notificationId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();
    const type = options.type ?? "raw_ready";
    const sourceKey = options.sourceKey ?? `external-direct:${crypto.randomUUID()}`;
    const payload = JSON.stringify({
      schemaVersion: 1,
      event: { type: "project.external_safe.direct", sourceKey, recipientId: externalEditor },
      authorizationAtOccurrence: { kind: "project_editor_membership", membershipCycle: membershipId, startedAt: membershipStartedAt },
      legacy: { type, projectId, sourceId: sourceKey },
    });
    await database.DB.batch([
      database.DB.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, body, source_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(notificationId, externalEditor, projectId, type, type === "comment_added" ? "New annotation feedback" : "RAW media ready", type === "comment_added" ? "Annotation feedback was added to assigned media." : "RAW media is ready for review.", sourceKey, now),
      database.DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, recipient_authorization_epoch, payload_json, status, available_at, recipient_membership_cycle_id, created_at, updated_at) VALUES (?, 1, 'project.external_safe.direct', ?, ?, ?, ?, 0, ?, 'completed', ?, ?, ?, ?)")
        .bind(outboxId, sourceKey, projectId, externalEditor, externalEditor, payload, now, membershipId, now, now),
      database.DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, notification_id, created_at, updated_at) VALUES (?, ?, 'project.external_safe.direct', ?, ?, 'in_app', 'sent', ?, ?, ?)")
        .bind(crypto.randomUUID(), outboxId, sourceKey, externalEditor, notificationId, now, now),
    ]);
    return notificationId;
  }

  it("never leaks a staff colleague's name, an Asset filename, or comment text to an external editor, while both rows stay present", async () => {
    const projectId = await makeProject("Boundary Leak Street");
    const rawCollectionId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?)").bind(rawCollectionId, projectId, Date.now(), Date.now()).run();
    const assetId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, publish_status, created_at, updated_at) VALUES (?, ?, ?, 'super-secret-filename.jpg', 1, 'upload', 'ready', ?, ?)")
      .bind(assetId, rawCollectionId, `assets/${assetId}.jpg`, Date.now(), Date.now()).run();

    const commentId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO project_comments (id, project_id, author_id, body, content_json, created_at) VALUES (?, ?, ?, 'a very private staff-only comment', '{}', ?)")
      .bind(commentId, projectId, userA, Date.now()).run();
    const annotationId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO annotations (id, asset_id, author_id, author_role, scope, note_text, created_at) VALUES (?, ?, ?, 'editor', 'raw', 'a very private staff-only annotation', ?)")
      .bind(annotationId, assetId, userA, Date.now()).run();

    const externalNotificationId = await seedExternalMention(projectId, commentId, externalEditor);
    const directNotificationId = await seedExternalDirectRow(projectId, { type: "comment_added", sourceKey: `annotation:${annotationId}` });

    const body = await externalList();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("Notification A");
    expect(serialized).not.toContain("super-secret-filename.jpg");
    expect(serialized).not.toContain("a very private staff-only comment");
    expect(serialized).not.toContain("a very private staff-only annotation");
    expect(body.notifications.some((row) => row.id === externalNotificationId)).toBe(true);
    expect(body.notifications.some((row) => row.id === directNotificationId)).toBe(true);
  });

  it("keeps the external response strict — exactly the existing key set, no enrichment fields", async () => {
    const projectId = await makeProject("Boundary Schema Street");
    const commentId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO project_comments (id, project_id, author_id, body, content_json, created_at) VALUES (?, ?, ?, 'schema check', '{}', ?)").bind(commentId, projectId, userA, Date.now()).run();
    const notificationId = await seedExternalMention(projectId, commentId, externalEditor);
    const body = await externalList();
    const row = body.notifications.find((r) => r.id === notificationId)!;
    expect(Object.keys(row).sort()).toEqual(["body", "coverAssetId", "createdAt", "id", "projectId", "projectStreet", "readAt", "title", "type"].sort());
  });

  it("enriches the same mentioned event for a staff recipient while the external recipient's row stays un-enriched", async () => {
    const projectId = await makeProject("Boundary Same Event Street");
    const commentId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO project_comments (id, project_id, author_id, body, content_json, created_at) VALUES (?, ?, ?, 'shared mention body', '{}', ?)").bind(commentId, projectId, userA, Date.now()).run();

    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, userB, Date.now()).run();
    const staffMentionId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO project_comment_mentions (id, comment_id, mentioned_user_id, created_at) VALUES (?, ?, ?, ?)").bind(staffMentionId, commentId, userB, Date.now()).run();
    const staffNotificationId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, body, source_key, created_at) VALUES (?, ?, ?, 'mentioned', 'You were mentioned', 'You were mentioned in a project comment.', ?, ?)")
      .bind(staffNotificationId, userB, projectId, staffMentionId, Date.now()).run();

    const externalNotificationId = await seedExternalMention(projectId, commentId, externalEditor);

    const staffRow = staffList(tokenB).then((body) => body.notifications.find((row) => row.id === staffNotificationId));
    const [resolvedStaffRow, externalBody] = await Promise.all([staffRow, externalList()]);
    expect(resolvedStaffRow).toMatchObject({
      title: "Notification A mentioned you",
      body: "shared mention body",
      actor: { id: userA, name: "Notification A" },
      subject: { kind: "project_comment", label: "shared mention body" },
    });
    const externalRow = externalBody.notifications.find((row) => row.id === externalNotificationId)!;
    expect(externalRow).not.toHaveProperty("actor");
    expect(externalRow).not.toHaveProperty("subject");
    expect(externalRow).not.toHaveProperty("assetId");
    expect(externalRow.title).toBe("You were mentioned");
    expect(externalRow.body).toBe("You were mentioned in a project comment.");
  });
});
