import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminId = "71111111-1111-4111-8111-111111111111";
const editorId = "72222222-2222-4222-8222-222222222222";
const photographerId = "73333333-3333-4333-8333-333333333333";
const outsiderId = "74444444-4444-4444-8444-444444444444";
const projectId = "7aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;

async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); } }
async function cookie(token: string) { const context = await createAuth(baseEnv).$context; return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`; }
async function request(path: string, token: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", body?: unknown) { const headers = new Headers({ cookie: await cookie(token) }); if (body !== undefined) headers.set("content-type", "application/json"); if (method !== "GET") headers.set("origin", baseEnv.APP_ORIGIN); return workerSelf.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
async function addMember(userId: string, role: "editor" | "photographer", id = crypto.randomUUID()) { await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, projectId, userId, role, Date.now()).run(); return id; }

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__); const now = Date.now();
  for (const [id, role] of [[adminId, "admin"], [editorId, "editor"], [photographerId, "photographer"], [outsiderId, "editor"]]) await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)").bind(id, `${role} ${id.slice(0, 4)}`, `${id}@example.test`, role, now, now).run();
  for (const [id, token, userId] of [["subtasks-admin", "subtasks-admin-token", adminId], ["subtasks-editor", "subtasks-editor-token", editorId], ["subtasks-photographer", "subtasks-photographer-token", photographerId], ["subtasks-outsider", "subtasks-outsider-token", outsiderId]]) await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, now + 3_600_000, token, userId, now, now).run();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Subtask Street', 'editing_autohdr', 0, ?, ?)").bind(projectId, now, now).run();
  await addMember(editorId, "editor"); await addMember(photographerId, "photographer");
});

describe("project subtasks API", () => {
  it("uses collaboration access, validates scoped input, orders/moves tasks, and emits assignment notices only for real assignment changes", async () => {
    expect((await request(`/api/projects/${projectId}/subtasks`, "subtasks-admin-token")).status).toBe(200);
    expect((await request(`/api/projects/${projectId}/subtasks`, "subtasks-photographer-token")).status).toBe(200);
    expect((await request(`/api/projects/${projectId}/subtasks`, "subtasks-outsider-token")).status).toBe(403);
    expect((await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: " ", dueDate: "2026-02-29" })).status).toBe(400);
    expect((await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "Bad assignee", assigneeId: outsiderId })).status).toBe(400);
    const firstResponse = await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "First", assigneeId: photographerId, dueDate: "2028-02-29" });
    expect(firstResponse.status).toBe(201); const first = await firstResponse.json() as { id: string; position: number; assignmentVersion: number; dueDate: string | null };
    expect(first).toMatchObject({ position: 1024, assignmentVersion: 1, dueDate: "2028-02-29" });
    const second = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "Second" })).json() as { id: string; position: number };
    expect(second.position).toBe(2048);
    const notificationCount = async () => (await database.DB.prepare("SELECT count(*) AS count FROM notifications WHERE type = 'subtask_assigned' AND project_id = ?").bind(projectId).first<{ count: number }>())!.count;
    expect(await notificationCount()).toBe(1);
    const completed = await request(`/api/projects/${projectId}/subtasks/${first.id}`, "subtasks-editor-token", "PATCH", { done: true });
    expect((await completed.json() as { assignmentVersion: number }).assignmentVersion).toBe(1); expect(await notificationCount()).toBe(1);
    const reassigned = await request(`/api/projects/${projectId}/subtasks/${first.id}`, "subtasks-editor-token", "PATCH", { assigneeId: adminId });
    expect((await reassigned.json() as { assignmentVersion: number }).assignmentVersion).toBe(2); expect(await notificationCount()).toBe(2);
    // Retrying the same persisted assignee is not another assignment event.
    await request(`/api/projects/${projectId}/subtasks/${first.id}`, "subtasks-editor-token", "PATCH", { assigneeId: adminId }); expect(await notificationCount()).toBe(2);
    const cleared = await request(`/api/projects/${projectId}/subtasks/${first.id}`, "subtasks-editor-token", "PATCH", { dueDate: null, assigneeId: null });
    expect(await cleared.json()).toMatchObject({ dueDate: null, assignee: null, assignmentVersion: 3 });
    const reassignedAgain = await request(`/api/projects/${projectId}/subtasks/${first.id}`, "subtasks-editor-token", "PATCH", { assigneeId: adminId });
    expect(await reassignedAgain.json()).toMatchObject({ assignmentVersion: 4 }); expect(await notificationCount()).toBe(3);
    expect((await database.DB.prepare("SELECT source_key FROM notifications WHERE type = 'subtask_assigned' AND project_id = ? ORDER BY source_key").bind(projectId).all()).results.map((row) => (row as { source_key: string }).source_key)).toEqual(expect.arrayContaining([`subtask-assignment:${first.id}:2`, `subtask-assignment:${first.id}:4`]));
    const moved = await request(`/api/projects/${projectId}/subtasks/${second.id}/move`, "subtasks-editor-token", "POST", { direction: "up" });
    expect(await moved.json()).toEqual({ position: 1024 });
    const listed = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token")).json() as { subtasks: Array<{ id: string }> };
    expect(listed.subtasks.slice(0, 2).map((item) => item.id)).toEqual([second.id, first.id]);
    expect((await request(`/api/projects/${projectId}/subtasks/${first.id}`, "subtasks-photographer-token", "DELETE")).status).toBe(200);
    const auditActions = (await database.DB.prepare("SELECT action FROM audit_log WHERE target_id IN (?, ?) ORDER BY created_at").bind(first.id, second.id).all()).results.map((row) => (row as { action: string }).action);
    expect(auditActions).toEqual(expect.arrayContaining(["project_subtask.create", "project_subtask.update", "project_subtask.move", "project_subtask.delete"]));
  });

  it("keeps absent optional fields unchanged, does access-before-existence checks, and never audits missing mutations", async () => {
    const task = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "Null semantics", dueDate: "2026-12-01" })).json() as { id: string; dueDate: string };
    const unchanged = await (await request(`/api/projects/${projectId}/subtasks/${task.id}`, "subtasks-editor-token", "PATCH", { done: true })).json() as { dueDate: string | null };
    expect(unchanged.dueDate).toBe("2026-12-01");
    const missingProject = crypto.randomUUID(); const missingTask = crypto.randomUUID();
    const before = (await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(missingTask).first<{ count: number }>())!.count;
    for (const [method, suffix, body] of [["POST", "", { title: "No" }], ["PATCH", `/${missingTask}`, { done: true }], ["POST", `/${missingTask}/move`, { direction: "up" }], ["DELETE", `/${missingTask}`, undefined]] as const) {
      expect((await request(`/api/projects/${missingProject}/subtasks${suffix}`, "subtasks-admin-token", method, body)).status).toBe(404);
    }
    expect((await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(missingTask).first<{ count: number }>())!.count).toBe(before);
    expect((await request(`/api/projects/${missingProject}/subtasks`, "subtasks-outsider-token")).status).toBe(403);
  });

  it("clears only final-role non-admin assignees as part of the project membership batch", async () => {
    // photographerId already holds a "photographer" project_members row from beforeAll.
    const finalTask = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-admin-token", "POST", { title: "Final role", assigneeId: photographerId })).json() as { id: string };
    await request(`/api/projects/${projectId}`, "subtasks-admin-token", "PATCH", { photographerUserIds: [] });
    expect(await database.DB.prepare("SELECT assignee_id, assignment_version FROM project_subtasks WHERE id = ?").bind(finalTask.id).first()).toEqual({ assignee_id: null, assignment_version: 2 });
    const audit = await database.DB.prepare("SELECT meta_json FROM audit_log WHERE action = 'project.update' AND target_id = ? ORDER BY created_at DESC LIMIT 1").bind(projectId).first<{ meta_json: string }>();
    expect(JSON.parse(audit!.meta_json).subtaskAssignmentsCleared).toBe(1);
    await addMember(photographerId, "photographer"); await addMember(photographerId, "editor");
    const retained = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-admin-token", "POST", { title: "Retained role", assigneeId: photographerId })).json() as { id: string };
    await request(`/api/projects/${projectId}`, "subtasks-admin-token", "PATCH", { photographerUserIds: [] });
    expect(await database.DB.prepare("SELECT assignee_id FROM project_subtasks WHERE id = ?").bind(retained.id).first()).toEqual({ assignee_id: photographerId });
    await addMember(adminId, "photographer");
    const adminTask = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-admin-token", "POST", { title: "Admin persists", assigneeId: adminId })).json() as { id: string };
    await request(`/api/projects/${projectId}`, "subtasks-admin-token", "PATCH", { photographerUserIds: [] });
    expect(await database.DB.prepare("SELECT assignee_id FROM project_subtasks WHERE id = ?").bind(adminTask.id).first()).toEqual({ assignee_id: adminId });
    await addMember(outsiderId, "photographer");
    const transferred = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-admin-token", "POST", { title: "Transferred role", assigneeId: outsiderId })).json() as { id: string };
    await request(`/api/projects/${projectId}`, "subtasks-admin-token", "PATCH", { photographerUserIds: [], editorUserIds: [outsiderId] });
    expect(await database.DB.prepare("SELECT assignee_id FROM project_subtasks WHERE id = ?").bind(transferred.id).first()).toEqual({ assignee_id: outsiderId });
  });
});
