import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { scanDueSubtasks } from "../../background/src/notifications";

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
  it("creates and cycles every writable schedule state, preserves exact civil metadata, and keeps the legacy adapter bounded", async () => {
    const rangeResponse = await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", {
      title: "TB4D date range",
      schedule: { state: "range", start: { kind: "date", localCivil: "2026-08-27" }, end: { kind: "date", localCivil: "2026-08-28" } },
    });
    expect(rangeResponse.status).toBe(201);
    const range = await rangeResponse.json() as { id: string; schedule: { state: string; version: number; start: { kind: string; localCivil: string }; end: { kind: string; localCivil: string }; zone: string }; dueDate: string };
    expect(range).toMatchObject({ schedule: { state: "range", version: 1, zone: "Australia/Sydney", start: { kind: "date", localCivil: "2026-08-27" }, end: { kind: "date", localCivil: "2026-08-28" } }, dueDate: "2026-08-28" });

    const dueOnly = await request(`/api/projects/${projectId}/subtasks/${range.id}`, "subtasks-editor-token", "PATCH", { schedule: { expectedVersion: 1, schedule: { state: "due_only", end: { kind: "date", localCivil: "2026-08-29" } } } });
    expect(dueOnly.status).toBe(200); expect(await dueOnly.json()).toMatchObject({ schedule: { state: "due_only", version: 2, end: { kind: "date", localCivil: "2026-08-29" } }, dueDate: "2026-08-29" });
    const timed = await request(`/api/projects/${projectId}/subtasks/${range.id}`, "subtasks-editor-token", "PATCH", { schedule: { expectedVersion: 2, schedule: { state: "due_only", end: { kind: "timed", localCivil: "2026-08-30T09:15" } } } });
    expect(timed.status).toBe(200); expect(await timed.json()).toMatchObject({ schedule: { state: "due_only", version: 3, end: { kind: "timed", localCivil: "2026-08-30T09:15", utcOffsetMinutes: 600, fold: 0 } }, dueDate: "2026-08-30T09:15" });
    const cleared = await request(`/api/projects/${projectId}/subtasks/${range.id}`, "subtasks-editor-token", "PATCH", { schedule: { expectedVersion: 3, schedule: { state: "unscheduled" } } });
    expect(cleared.status).toBe(200); expect(await cleared.json()).toMatchObject({ schedule: { state: "unscheduled", version: 4, start: null, end: null, due: null }, dueDate: null });

    const timedRange = await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "TB4D timed range", schedule: { state: "range", start: { kind: "timed", localCivil: "2026-10-04T01:30" }, end: { kind: "timed", localCivil: "2026-10-04T03:30" } } });
    expect(timedRange.status).toBe(201); const timedRangeBody = await timedRange.json() as { id: string; schedule: { start: { instant: string }; end: { instant: string } } }; expect(Date.parse(timedRangeBody.schedule.start.instant)).toBeLessThan(Date.parse(timedRangeBody.schedule.end.instant));

    const both = await request(`/api/projects/${projectId}/subtasks/${timedRangeBody.id}`, "subtasks-editor-token", "PATCH", { schedule: { expectedVersion: 1, schedule: { state: "unscheduled" } }, dueDate: null });
    expect(both.status).toBe(400); expect(await both.json()).toMatchObject({ code: "subtask_schedule_inputs_conflict" });
    const stale = await request(`/api/projects/${projectId}/subtasks/${timedRangeBody.id}`, "subtasks-editor-token", "PATCH", { schedule: { expectedVersion: 0, schedule: { state: "unscheduled" } } });
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: "subtask_schedule_version_conflict", current: { state: "range", version: 1 } });

    const legacyId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, created_by, created_at, updated_at) VALUES (?, ?, 'TB4D legacy adapter', 0, 999999, 0, '2026-09-01', ?, ?, ?)").bind(legacyId, projectId, editorId, now, now).run();
    const legacy = await request(`/api/projects/${projectId}/subtasks/${legacyId}`, "subtasks-editor-token", "PATCH", { dueDate: "2026-09-02" });
    expect(legacy.status).toBe(200); expect(await legacy.json()).toMatchObject({ dueDate: "2026-09-02", schedule: { state: "due_only", version: 1 } });
    const bounded = await request(`/api/projects/${projectId}/subtasks/${legacyId}`, "subtasks-editor-token", "PATCH", { dueDate: "2026-09-03" });
    expect(bounded.status).toBe(400); expect(await bounded.json()).toMatchObject({ code: "subtask_schedule_reload_required" });
  });

  it("returns invalid storage as 422 only for schedule-bearing writes while item edits preserve the invalid DTO", async () => {
    const id = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, 'TB4D corrupt', 0, 999998, 0, 'Australia/Sydney', 1, ?, ?, ?)").bind(id, projectId, editorId, now, now).run();
    const itemEdit = await request(`/api/projects/${projectId}/subtasks/${id}`, "subtasks-editor-token", "PATCH", { title: "TB4D repaired label" });
    expect(itemEdit.status).toBe(200); expect(await itemEdit.json()).toMatchObject({ title: "TB4D repaired label", schedule: { state: "invalid", error: { reason: "shape_mismatch" } } });
    const scheduleEdit = await request(`/api/projects/${projectId}/subtasks/${id}`, "subtasks-editor-token", "PATCH", { schedule: { expectedVersion: 1, schedule: { state: "unscheduled" } } });
    expect(scheduleEdit.status).toBe(422); expect(await scheduleEdit.json()).toMatchObject({ code: "subtask_schedule_storage_invalid", current: { state: "invalid", error: { reason: "shape_mismatch" } } });
  });

  it("uses collaboration access, validates scoped input, orders/reorders tasks, and emits assignment notices only for real assignment changes", async () => {
    expect((await request(`/api/projects/${projectId}/subtasks`, "subtasks-admin-token")).status).toBe(200);
    expect((await request(`/api/projects/${projectId}/subtasks`, "subtasks-photographer-token")).status).toBe(200);
    expect((await request(`/api/projects/${projectId}/subtasks`, "subtasks-outsider-token")).status).toBe(403);
    expect((await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: " ", dueDate: "2026-02-29" })).status).toBe(400);
    expect((await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "Bad time", dueDate: "2028-02-29T24:00" })).status).toBe(400);
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
    const moved = await request(`/api/projects/${projectId}/subtasks/${second.id}/reorder`, "subtasks-editor-token", "POST", { beforeId: null, afterId: first.id });
    expect(await moved.json()).toEqual({ position: 0 });
    const listed = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token")).json() as { subtasks: Array<{ id: string }> };
    expect(listed.subtasks.slice(0, 2).map((item) => item.id)).toEqual([second.id, first.id]);
    expect((await request(`/api/projects/${projectId}/subtasks/${first.id}`, "subtasks-photographer-token", "DELETE")).status).toBe(200);
    const auditActions = (await database.DB.prepare("SELECT action FROM audit_log WHERE target_id IN (?, ?) ORDER BY created_at").bind(first.id, second.id).all()).results.map((row) => (row as { action: string }).action);
    expect(auditActions).toEqual(expect.arrayContaining(["project_subtask.create", "project_subtask.update", "project_subtask.reorder", "project_subtask.delete"]));
  });

  it("keeps absent optional fields unchanged, does access-before-existence checks, and never audits missing mutations", async () => {
    const task = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "Null semantics", dueDate: "2026-12-01" })).json() as { id: string; dueDate: string };
    const unchanged = await (await request(`/api/projects/${projectId}/subtasks/${task.id}`, "subtasks-editor-token", "PATCH", { done: true })).json() as { dueDate: string | null };
    expect(unchanged.dueDate).toBe("2026-12-01");
    const missingProject = crypto.randomUUID(); const missingTask = crypto.randomUUID();
    const before = (await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(missingTask).first<{ count: number }>())!.count;
    for (const [method, suffix, body] of [["POST", "", { title: "No" }], ["PATCH", `/${missingTask}`, { done: true }], ["POST", `/${missingTask}/reorder`, { beforeId: null, afterId: null }], ["DELETE", `/${missingTask}`, undefined]] as const) {
      expect((await request(`/api/projects/${missingProject}/subtasks${suffix}`, "subtasks-admin-token", method, body)).status).toBe(404);
    }
    expect((await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(missingTask).first<{ count: number }>())!.count).toBe(before);
    expect((await request(`/api/projects/${missingProject}/subtasks`, "subtasks-outsider-token")).status).toBe(403);
  });

  it("rejects invalid or stale reorder neighbors and rebases tied snapshots, including a 24-item checklist", async () => {
    const now = Date.now(); const guardedProject = crypto.randomUUID(); const targetId = crypto.randomUUID(); const beforeId = crypto.randomUUID(); const afterId = crypto.randomUUID(); const betweenId = crypto.randomUUID(); const otherProject = crypto.randomUUID(); const foreignId = crypto.randomUUID();
    for (const id of [guardedProject, otherProject]) await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', 0, ?, ?)").bind(id, `Reorder ${id}`, now, now).run();
    for (const [id, position] of [[beforeId, 1024], [afterId, 2048], [targetId, 3072], [betweenId, 4096]] as const) await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, ?, ?, ?)").bind(id, guardedProject, id, position, editorId, now, now).run();
    await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, created_by, created_at, updated_at) VALUES (?, ?, 'foreign', 0, 1024, 0, ?, ?, ?)").bind(foreignId, otherProject, editorId, now, now).run();
    for (const body of [{ beforeId: "not-a-uuid", afterId: null }, { beforeId: 42, afterId: null }, { beforeId: null }, { beforeId: null, afterId: null, position: 1 }]) expect((await request(`/api/projects/${guardedProject}/subtasks/${targetId}/reorder`, "subtasks-admin-token", "POST", body)).status).toBe(400);
    expect((await request(`/api/projects/${guardedProject}/subtasks/${targetId}/reorder`, "subtasks-admin-token", "POST", { beforeId: targetId, afterId })).status).toBe(400);
    expect((await request(`/api/projects/${guardedProject}/subtasks/${targetId}/reorder`, "subtasks-admin-token", "POST", { beforeId, afterId: beforeId })).status).toBe(400);
    expect((await request(`/api/projects/${guardedProject}/subtasks/${targetId}/reorder`, "subtasks-admin-token", "POST", { beforeId: foreignId, afterId })).status).toBe(404);
    await database.DB.prepare("UPDATE project_subtasks SET position = 1500 WHERE id = ?").bind(betweenId).run();
    const beforeAudit = (await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'project_subtask.reorder'").bind(targetId).first<{ count: number }>())!.count;
    expect((await request(`/api/projects/${guardedProject}/subtasks/${targetId}/reorder`, "subtasks-admin-token", "POST", { beforeId, afterId })).status).toBe(409);
    expect((await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'project_subtask.reorder'").bind(targetId).first<{ count: number }>())!.count).toBe(beforeAudit);

    const tiedProject = crypto.randomUUID(); const tiedBefore = "81000000-0000-4000-8000-000000000001"; const tiedAfter = "81000000-0000-4000-8000-000000000002"; const tiedTarget = "81000000-0000-4000-8000-000000000003";
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Tied rebase', 'editing_autohdr', 0, ?, ?)").bind(tiedProject, now, now).run();
    for (const [id, position] of [[tiedBefore, 1024], [tiedAfter, 1024], [tiedTarget, 4096]] as const) await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, ?, ?, ?)").bind(id, tiedProject, id, position, editorId, now, now).run();
    expect(await (await request(`/api/projects/${tiedProject}/subtasks/${tiedTarget}/reorder`, "subtasks-admin-token", "POST", { beforeId: tiedBefore, afterId: tiedAfter })).json()).toEqual({ position: 2048 });
    expect((await database.DB.prepare("SELECT id, position FROM project_subtasks WHERE project_id = ? ORDER BY position, id").bind(tiedProject).all()).results).toEqual([{ id: tiedBefore, position: 1024 }, { id: tiedTarget, position: 2048 }, { id: tiedAfter, position: 3072 }]);

    const longProject = crypto.randomUUID(); await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Long tied rebase', 'editing_autohdr', 0, ?, ?)").bind(longProject, now, now).run();
    const ids = Array.from({ length: 24 }, (_, index) => `82000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    for (const [index, id] of ids.entries()) await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, ?, ?, ?)").bind(id, longProject, id, index === 10 ? 10 * 1024 : (index + 1) * 1024, editorId, now, now).run();
    const longTarget = ids[23]!; const longBefore = ids[9]!; const longAfter = ids[10]!;
    expect((await request(`/api/projects/${longProject}/subtasks/${longTarget}/reorder`, "subtasks-admin-token", "POST", { beforeId: longBefore, afterId: longAfter })).status).toBe(200);
    const longRows = (await database.DB.prepare("SELECT id, position FROM project_subtasks WHERE project_id = ? ORDER BY position, id").bind(longProject).all()).results as Array<{ id: string; position: number }>;
    expect(longRows.map((row) => row.id)).toEqual([...ids.slice(0, 10), longTarget, ...ids.slice(10, 23)]); expect(longRows.map((row) => row.position)).toEqual(Array.from({ length: 24 }, (_, index) => (index + 1) * 1024));
  });

  it("reorders at beginning, middle, and end without restamping neighbors, auditing twice, or notifying", async () => {
    const now = 1; const ordinaryProject = crypto.randomUUID(); const a = crypto.randomUUID(); const b = crypto.randomUUID(); const c = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Ordinary reorders', 'editing_autohdr', 0, ?, ?)").bind(ordinaryProject, now, now).run();
    for (const [id, position] of [[a, 1024], [b, 2048], [c, 3072]] as const) await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, ?, ?, ?)").bind(id, ordinaryProject, id, position, editorId, now, now).run();
    const assignments = async () => (await database.DB.prepare("SELECT count(*) AS count FROM notifications WHERE project_id = ? AND type = 'subtask_assigned'").bind(ordinaryProject).first<{ count: number }>())!.count;
    const reorder = async (target: string, beforeId: string | null, afterId: string | null, expectedPosition: number, expectedOrder: string[]) => {
      const previous = (await database.DB.prepare("SELECT id, updated_at FROM project_subtasks WHERE project_id = ?").bind(ordinaryProject).all()).results as Array<{ id: string; updated_at: number }>;
      const priorAudit = (await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'project_subtask.reorder'").bind(target).first<{ count: number }>())!.count; const priorNotices = await assignments();
      const response = await request(`/api/projects/${ordinaryProject}/subtasks/${target}/reorder`, "subtasks-admin-token", "POST", { beforeId, afterId }); expect(response.status).toBe(200); expect(await response.json()).toEqual({ position: expectedPosition });
      const rows = (await database.DB.prepare("SELECT id, position, updated_at FROM project_subtasks WHERE project_id = ? ORDER BY position, id").bind(ordinaryProject).all()).results as Array<{ id: string; position: number; updated_at: number }>;
      expect(rows.map((row) => row.id)).toEqual(expectedOrder); expect(rows.find((row) => row.id === target)?.updated_at).not.toBe(previous.find((row) => row.id === target)?.updated_at); for (const row of rows.filter((row) => row.id !== target)) expect(row.updated_at).toBe(previous.find((candidate) => candidate.id === row.id)?.updated_at);
      expect((await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'project_subtask.reorder'").bind(target).first<{ count: number }>())!.count).toBe(priorAudit + 1); expect(await assignments()).toBe(priorNotices);
    };
    await reorder(c, null, a, 0, [c, a, b]); await reorder(b, c, a, 512, [c, b, a]); await reorder(c, a, null, 2048, [b, a, c]);
  });

  it("keeps a non-integral ordinary midpoint without rebasing its neighbors", async () => {
    const now = 1; const midpointProject = crypto.randomUUID(); const before = crypto.randomUUID(); const after = crypto.randomUUID(); const target = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Fractional midpoint', 'editing_autohdr', 0, ?, ?)").bind(midpointProject, now, now).run();
    for (const [id, position] of [[before, 1024], [after, 1025], [target, 4096]] as const) await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, ?, ?, ?)").bind(id, midpointProject, id, position, editorId, now, now).run();
    const response = await request(`/api/projects/${midpointProject}/subtasks/${target}/reorder`, "subtasks-admin-token", "POST", { beforeId: before, afterId: after }); expect(response.status).toBe(200); expect(await response.json()).toEqual({ position: 1024.5 });
    expect(await database.DB.prepare("SELECT position FROM project_subtasks WHERE id = ?").bind(target).first()).toEqual({ position: 1024.5 });
    expect((await database.DB.prepare("SELECT id, position, updated_at FROM project_subtasks WHERE project_id = ? ORDER BY position, id").bind(midpointProject).all()).results).toEqual([{ id: before, position: 1024, updated_at: now }, { id: target, position: 1024.5, updated_at: expect.any(Number) }, { id: after, position: 1025, updated_at: now }]);
  });

  it("accepts literal due times and clears a sent reminder when the due date is rescheduled", async () => {
    const firstMorning = Date.UTC(2026, 7, 17, 22);
    const nextMorning = Date.UTC(2026, 7, 18, 22);
    const due = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "Reschedule reminder", assigneeId: photographerId, dueDate: "2026-08-18T14:30" })).json() as { id: string; dueDate: string };
    expect(due.dueDate).toBe("2026-08-18T14:30");
    const reminderEnv = { ...baseEnv, DB: database.DB, EMAIL: { send: vi.fn().mockResolvedValue({ messageId: "reschedule" }) }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test" } as unknown as Env;
    expect(await scanDueSubtasks(reminderEnv, firstMorning)).toBe(1);
    expect(await database.DB.prepare("SELECT due_reminder_sent_at FROM project_subtasks WHERE id = ?").bind(due.id).first()).toEqual({ due_reminder_sent_at: firstMorning });
    expect((await request(`/api/projects/${projectId}/subtasks/${due.id}`, "subtasks-editor-token", "PATCH", { dueDate: "2026-08-19" })).status).toBe(200);
    expect(await database.DB.prepare("SELECT due_reminder_sent_at FROM project_subtasks WHERE id = ?").bind(due.id).first()).toEqual({ due_reminder_sent_at: null });
    expect(await scanDueSubtasks(reminderEnv, nextMorning)).toBe(1);
    expect((await database.DB.prepare("SELECT count(*) AS count FROM notifications WHERE type = 'subtask_due_today' AND project_id = ? AND user_id = ?").bind(projectId, photographerId).first<{ count: number }>())!.count).toBe(2);
    expect((await request(`/api/projects/${projectId}/subtasks/${due.id}`, "subtasks-editor-token", "DELETE")).status).toBe(200);
  });

  it("resets a fold-only end claim without changing due_date or emitting a duplicate reminder", async () => {
    const firstMorning = Date.UTC(2026, 3, 4, 22);
    const created = await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", {
      title: "Fold-only reminder",
      assigneeId: photographerId,
      schedule: { state: "due_only", end: { kind: "timed", localCivil: "2026-04-05T02:30", disambiguation: "earlier" } },
    });
    expect(created.status).toBe(201);
    const item = await created.json() as { id: string; dueDate: string; schedule: { version: number; end: { fold: number } } };
    const reminderEnv = { ...baseEnv, DB: database.DB, EMAIL: { send: vi.fn().mockResolvedValue({ messageId: "fold" }) }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test" } as unknown as Env;
    expect(await scanDueSubtasks(reminderEnv, firstMorning)).toBe(1);
    const changed = await request(`/api/projects/${projectId}/subtasks/${item.id}`, "subtasks-editor-token", "PATCH", {
      schedule: { expectedVersion: item.schedule.version, schedule: { state: "due_only", end: { kind: "timed", localCivil: "2026-04-05T02:30", disambiguation: "later" } } },
    });
    expect(changed.status).toBe(200);
    const changedItem = await changed.json() as { dueDate: string; schedule: { end: { fold: number } } };
    expect(changedItem).toMatchObject({ dueDate: item.dueDate, schedule: { end: { fold: 1 } } });
    expect(await database.DB.prepare("SELECT due_reminder_sent_at, due_date FROM project_subtasks WHERE id = ?").bind(item.id).first()).toEqual({ due_reminder_sent_at: null, due_date: item.dueDate });
    expect(await scanDueSubtasks(reminderEnv, firstMorning)).toBe(0);
  });

  it("clears only final-role non-admin assignees as part of the project membership batch", async () => {
    const initialPhotographer = await database.DB.prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ? AND role_on_project = 'photographer'").bind(projectId, photographerId).first<{ id: string }>();
    expect(initialPhotographer).toBeDefined();
    const finalTask = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-admin-token", "POST", { title: "Final role", assigneeId: photographerId })).json() as { id: string };
    const unconfirmed = await request(`/api/projects/${projectId}/photographers/${photographerId}`, "subtasks-admin-token", "DELETE", { membershipCycle: initialPhotographer!.id, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    expect(unconfirmed.status).toBe(422);
    expect(await unconfirmed.json()).toMatchObject({ code: "subtask_assignment_confirmation_required", assignmentCount: 1 });
    const confirmed = await request(`/api/projects/${projectId}/photographers/${photographerId}`, "subtasks-admin-token", "DELETE", { membershipCycle: initialPhotographer!.id, clearSubtaskAssignments: true, confirmedAssignmentCount: 1 });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ outcome: "removed", removed: { membershipCycle: initialPhotographer!.id, userId: photographerId, roleOnProject: "photographer" }, subtaskAssignmentsCleared: 1 });
    expect(await database.DB.prepare("SELECT assignee_id, assignment_version FROM project_subtasks WHERE id = ?").bind(finalTask.id).first()).toEqual({ assignee_id: null, assignment_version: 2 });
    const audit = await database.DB.prepare("SELECT action, meta_json FROM audit_log WHERE action = 'project.member.remove' AND target_id = ? ORDER BY created_at DESC LIMIT 1").bind(initialPhotographer!.id).first<{ action: string; meta_json: string }>();
    expect(audit?.action).toBe("project.member.remove");
    expect(JSON.parse(audit!.meta_json)).toMatchObject({ projectId, userId: photographerId, roleOnProject: "photographer", membershipCycle: initialPhotographer!.id });

    const retainedPhotographer = await addMember(editorId, "photographer");
    const retained = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-admin-token", "POST", { title: "Retained role", assigneeId: editorId })).json() as { id: string };
    const retainedRemoval = await request(`/api/projects/${projectId}/photographers/${editorId}`, "subtasks-admin-token", "DELETE", { membershipCycle: retainedPhotographer, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    expect(retainedRemoval.status).toBe(200);
    expect(await retainedRemoval.json()).toMatchObject({ outcome: "removed", subtaskAssignmentsCleared: 0 });
    expect(await database.DB.prepare("SELECT assignee_id FROM project_subtasks WHERE id = ?").bind(retained.id).first()).toEqual({ assignee_id: editorId });

    const adminPhotographer = await addMember(adminId, "photographer");
    const adminTask = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-admin-token", "POST", { title: "Admin persists", assigneeId: adminId })).json() as { id: string };
    const adminRemoval = await request(`/api/projects/${projectId}/photographers/${adminId}`, "subtasks-admin-token", "DELETE", { membershipCycle: adminPhotographer, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    expect(adminRemoval.status).toBe(200);
    expect(await adminRemoval.json()).toMatchObject({ outcome: "removed", subtaskAssignmentsCleared: 0 });
    expect(await database.DB.prepare("SELECT assignee_id FROM project_subtasks WHERE id = ?").bind(adminTask.id).first()).toEqual({ assignee_id: adminId });
    const transferredPhotographer = await addMember(outsiderId, "photographer");
    const transferred = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-admin-token", "POST", { title: "Transferred role", assigneeId: outsiderId })).json() as { id: string };
    const editorRole = await request(`/api/projects/${projectId}/editors/${outsiderId}`, "subtasks-admin-token", "PUT", {});
    expect(editorRole.status).toBe(201);
    const editorMembership = await editorRole.json() as { membership: { id: string } };
    const transferredRemoval = await request(`/api/projects/${projectId}/photographers/${outsiderId}`, "subtasks-admin-token", "DELETE", { membershipCycle: transferredPhotographer, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    expect(transferredRemoval.status).toBe(200);
    expect(await transferredRemoval.json()).toMatchObject({ outcome: "removed", subtaskAssignmentsCleared: 0 });
    expect(await database.DB.prepare("SELECT assignee_id FROM project_subtasks WHERE id = ?").bind(transferred.id).first()).toEqual({ assignee_id: outsiderId });
    expect(await database.DB.prepare("SELECT id FROM project_members WHERE id = ? AND role_on_project = 'editor'").bind(editorMembership.membership.id).first()).toEqual({ id: editorMembership.membership.id });
  });

  it("returns 409 for a stale C1 delete and never removes the re-added C2 membership", async () => {
    const isolatedProject = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Membership cycle race', 'editing_autohdr', ?, ?)").bind(isolatedProject, now, now).run();
    const c1 = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(c1, isolatedProject, editorId, now).run();
    const adminToken = "subtasks-admin-token";
    const firstDelete = await request(`/api/projects/${isolatedProject}/editors/${editorId}`, adminToken, "DELETE", { membershipCycle: c1, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    expect(firstDelete.status).toBe(200);
    const readded = await request(`/api/projects/${isolatedProject}/editors/${editorId}`, adminToken, "PUT", {});
    expect(readded.status).toBe(201);
    const c2 = (await readded.json() as { membership: { id: string } }).membership.id;
    expect(c2).not.toBe(c1);
    const stale = await request(`/api/projects/${isolatedProject}/editors/${editorId}`, adminToken, "DELETE", { membershipCycle: c1, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ code: "membership_cycle_changed", requestedMembershipCycle: c1, currentMembership: { id: c2, userId: editorId, roleOnProject: "editor" } });
    expect(await database.DB.prepare("SELECT id FROM project_members WHERE id = ?").bind(c2).first()).toEqual({ id: c2 });
  });

  it("rechecks the assignment count after a stale confirmation and returns a fresh 422", async () => {
    const isolatedProject = crypto.randomUUID(); const taskOne = crypto.randomUUID(); const taskTwo = crypto.randomUUID(); const cycle = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Assignment count race', 'editing_autohdr', ?, ?)").bind(isolatedProject, now, now).run();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(cycle, isolatedProject, photographerId, now).run();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignee_id, assignment_version, created_by, created_at, updated_at) VALUES (?, ?, 'One', 0, 1024, ?, 1, ?, ?, ?)").bind(taskOne, isolatedProject, photographerId, editorId, now, now),
      database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignee_id, assignment_version, created_by, created_at, updated_at) VALUES (?, ?, 'Two', 0, 2048, ?, 1, ?, ?, ?)").bind(taskTwo, isolatedProject, photographerId, editorId, now, now),
    ]);
    const body = { membershipCycle: cycle, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 };
    const first = await request(`/api/projects/${isolatedProject}/photographers/${photographerId}`, "subtasks-admin-token", "DELETE", body);
    expect(first.status).toBe(422);
    const firstPayload = await first.json() as { assignmentCount: number };
    expect(firstPayload.assignmentCount).toBe(2);
    await database.DB.prepare("UPDATE project_subtasks SET assignee_id = NULL, assignment_version = assignment_version + 1 WHERE id = ?").bind(taskTwo).run();
    const retry = await request(`/api/projects/${isolatedProject}/photographers/${photographerId}`, "subtasks-admin-token", "DELETE", { membershipCycle: cycle, clearSubtaskAssignments: true, confirmedAssignmentCount: firstPayload.assignmentCount });
    expect(retry.status).toBe(422);
    await expect(retry.json()).resolves.toMatchObject({ code: "subtask_assignment_confirmation_required", assignmentCount: 1 });
    expect(await database.DB.prepare("SELECT id FROM project_members WHERE id = ?").bind(cycle).first()).toEqual({ id: cycle });
    expect(await database.DB.prepare("SELECT assignee_id FROM project_subtasks WHERE id = ?").bind(taskOne).first()).toEqual({ assignee_id: photographerId });
  });

  it("treats a residual role made ineligible by global-role drift as no compatible role", async () => {
    const isolatedProject = crypto.randomUUID(); const taskId = crypto.randomUUID(); const photographerCycle = crypto.randomUUID(); const editorCycle = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Compatible role drift', 'editing_autohdr', ?, ?)").bind(isolatedProject, now, now).run();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(photographerCycle, isolatedProject, editorId, now),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(editorCycle, isolatedProject, editorId, now),
      database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignee_id, assignment_version, created_by, created_at, updated_at) VALUES (?, ?, 'Drifted assignment', 0, 1024, ?, 1, ?, ?, ?)").bind(taskId, isolatedProject, editorId, editorId, now, now),
    ]);
    try {
      await database.DB.prepare("UPDATE user SET role = 'photographer' WHERE id = ?").bind(editorId).run();
      const probe = await request(`/api/projects/${isolatedProject}/photographers/${editorId}`, "subtasks-admin-token", "DELETE", { membershipCycle: photographerCycle, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
      expect(probe.status).toBe(422);
      await expect(probe.json()).resolves.toMatchObject({ code: "subtask_assignment_confirmation_required", assignmentCount: 1 });
      const removed = await request(`/api/projects/${isolatedProject}/photographers/${editorId}`, "subtasks-admin-token", "DELETE", { membershipCycle: photographerCycle, clearSubtaskAssignments: true, confirmedAssignmentCount: 1 });
      expect(removed.status).toBe(200);
      expect(await database.DB.prepare("SELECT id FROM project_members WHERE id = ?").bind(editorCycle).first()).toEqual({ id: editorCycle });
      expect(await database.DB.prepare("SELECT assignee_id FROM project_subtasks WHERE id = ?").bind(taskId).first()).toEqual({ assignee_id: null });
    } finally {
      await database.DB.prepare("UPDATE user SET role = 'editor' WHERE id = ?").bind(editorId).run();
    }
  });
});
