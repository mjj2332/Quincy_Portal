import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { notificationCopy } from "@quincy/db";
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
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Notification A', ?, 1, 'editor', 1, ?, ?), (?, 'Notification B', ?, 1, 'editor', 1, ?, ?), (?, 'Notification Photographer', ?, 1, 'photographer', 1, ?, ?)").bind(userA, `${userA}@example.test`, now, now, userB, `${userB}@example.test`, now, now, photographer, `${photographer}@example.test`, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, tokenA, userA, now, now, crypto.randomUUID(), now + 3_600_000, tokenB, userB, now, now, crypto.randomUUID(), now + 3_600_000, tokenPhotographer, photographer, now, now),
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
});
