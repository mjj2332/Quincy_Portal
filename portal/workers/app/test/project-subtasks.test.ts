import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { scanDueSubtasks } from "../../background/src/notifications";
import { externalSubtaskAssigneeOptionsResponseSchema, subtaskAssigneeOptionsResponseSchema } from "@quincy/shared";

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
  it("creates and cycles every writable schedule shape (date range, one day, timed range), preserving exact civil metadata", async () => {
    const rangeResponse = await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", {
      title: "TB4D date range",
      schedule: { state: "range", start: { kind: "date", localCivil: "2026-08-27" }, end: { kind: "date", localCivil: "2026-08-28" } },
    });
    expect(rangeResponse.status).toBe(201);
    const range = await rangeResponse.json() as { id: string; schedule: { state: string; version: number; start: { kind: string; localCivil: string }; end: { kind: string; localCivil: string }; zone: string }; dueDate: string };
    expect(range).toMatchObject({ schedule: { state: "range", version: 1, zone: "Australia/Sydney", start: { kind: "date", localCivil: "2026-08-27" }, end: { kind: "date", localCivil: "2026-08-28" } }, dueDate: "2026-08-28" });

    const oneDay = await request(`/api/projects/${projectId}/subtasks/${range.id}`, "subtasks-editor-token", "PATCH", { schedule: { expectedVersion: 1, schedule: { state: "range", start: { kind: "date", localCivil: "2026-08-29" }, end: { kind: "date", localCivil: "2026-08-29" } } } });
    expect(oneDay.status).toBe(200); expect(await oneDay.json()).toMatchObject({ schedule: { state: "range", version: 2, start: { kind: "date", localCivil: "2026-08-29" }, end: { kind: "date", localCivil: "2026-08-29" } }, dueDate: "2026-08-29" });
    const timed = await request(`/api/projects/${projectId}/subtasks/${range.id}`, "subtasks-editor-token", "PATCH", { schedule: { expectedVersion: 2, schedule: { state: "range", start: { kind: "timed", localCivil: "2026-08-30T08:00" }, end: { kind: "timed", localCivil: "2026-08-30T09:15" } } } });
    expect(timed.status).toBe(200); expect(await timed.json()).toMatchObject({ schedule: { state: "range", version: 3, start: { kind: "timed", localCivil: "2026-08-30T08:00", utcOffsetMinutes: 600, fold: 0 }, end: { kind: "timed", localCivil: "2026-08-30T09:15", utcOffsetMinutes: 600, fold: 0 } }, dueDate: "2026-08-30T09:15" });
    const backToDates = await request(`/api/projects/${projectId}/subtasks/${range.id}`, "subtasks-editor-token", "PATCH", { schedule: { expectedVersion: 3, schedule: { state: "range", start: { kind: "date", localCivil: "2026-09-01" }, end: { kind: "date", localCivil: "2026-09-04" } } } });
    expect(backToDates.status).toBe(200); expect(await backToDates.json()).toMatchObject({ schedule: { state: "range", version: 4, start: { kind: "date", localCivil: "2026-09-01" }, end: { kind: "date", localCivil: "2026-09-04" } }, dueDate: "2026-09-04" });

    const timedRange = await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "TB4D timed range", schedule: { state: "range", start: { kind: "timed", localCivil: "2026-10-04T01:30" }, end: { kind: "timed", localCivil: "2026-10-04T03:30" } } });
    expect(timedRange.status).toBe(201); const timedRangeBody = await timedRange.json() as { id: string; schedule: { start: { instant: string }; end: { instant: string } } }; expect(Date.parse(timedRangeBody.schedule.start.instant)).toBeLessThan(Date.parse(timedRangeBody.schedule.end.instant));
    const stale = await request(`/api/projects/${projectId}/subtasks/${timedRangeBody.id}`, "subtasks-editor-token", "PATCH", { schedule: { expectedVersion: 0, schedule: { state: "range", start: { kind: "date", localCivil: "2026-10-05" }, end: { kind: "date", localCivil: "2026-10-06" } } } });
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: "subtask_schedule_version_conflict", current: { state: "range", version: 1 } });
  });

  it("the database refuses a Subtask without a complete range, and accepts a valid one (#343)", async () => {
    const insert = (id: string, cols: string, ...values: unknown[]) => database.DB.prepare(`INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, ${cols}, created_by, created_at, updated_at) VALUES (?, ?, 'TB4D constraint', 0, 999997, 0, ${values.map(() => "?").join(", ")}, ?, ?, ?)`).bind(id, projectId, ...values, editorId, Date.now(), Date.now()).run();
    const count = async () => (await database.DB.prepare("SELECT COUNT(*) AS n FROM project_subtasks WHERE project_id = ?").bind(projectId).first<{ n: number }>())!.n;
    const before = await count();
    // Unscheduled, and due-only: both are refused at the storage layer.
    await expect(insert(crypto.randomUUID(), "schedule_version", 0)).rejects.toThrow(/CHECK constraint failed/);
    await expect(insert(crypto.randomUUID(), "due_date, schedule_version", "2026-08-18", 1)).rejects.toThrow(/CHECK constraint failed/);
    expect(await count()).toBe(before);

    const id = crypto.randomUUID();
    await insert(id, "due_date, schedule_start_kind, schedule_start_civil, schedule_end_kind, schedule_zone, schedule_version", "2026-08-19", "date", "2026-08-18", "date", "Australia/Sydney", 1);
    expect(await count()).toBe(before + 1);
    const listed = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token")).json() as { subtasks: Array<{ id: string; schedule: { state: string } }> };
    expect(listed.subtasks.find((item) => item.id === id)?.schedule.state).toBe("range");

    // Clearing one endpoint of a stored range is refused, and the row survives unchanged.
    const stored = await database.DB.prepare("SELECT * FROM project_subtasks WHERE id = ?").bind(id).first();
    await expect(database.DB.prepare("UPDATE project_subtasks SET due_date = NULL, schedule_end_kind = NULL WHERE id = ?").bind(id).run()).rejects.toThrow(/CHECK constraint failed/);
    await expect(database.DB.prepare("UPDATE project_subtasks SET schedule_start_civil = NULL WHERE id = ?").bind(id).run()).rejects.toThrow(/CHECK constraint failed/);
    expect(await database.DB.prepare("SELECT * FROM project_subtasks WHERE id = ?").bind(id).first()).toEqual(stored);

    // The ordinary HTTP path still works: a create with no schedule stores a complete default range.
    const created = await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "TB4D no schedule" });
    expect(created.status).toBe(201);
    const body = await created.json() as { id: string; schedule: { state: string; version: number } };
    expect(body.schedule).toMatchObject({ state: "range", version: 1 });
    expect(await database.DB.prepare("SELECT schedule_start_kind, schedule_end_kind, schedule_zone, due_date IS NOT NULL AS has_due FROM project_subtasks WHERE id = ?").bind(body.id).first()).toEqual({ schedule_start_kind: "date", schedule_end_kind: "date", schedule_zone: "Australia/Sydney", has_due: 1 });
    await database.DB.prepare("DELETE FROM project_subtasks WHERE id IN (?, ?)").bind(id, body.id).run();
  });

  it("fails loud on storage that passes the range CHECK but is not a valid range: list and every write 500 with no schedule DTO, and the row is left untouched (ADR 0011)", async () => {
    const id = crypto.randomUUID(); const now = Date.now();
    // Structurally complete (so migration 0047's CHECK accepts it) but semantically invalid: 2026-02-30 is not a calendar day.
    await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_end_kind, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, 'TB4D corrupt', 0, 999998, 0, '2026-03-01', 'date', '2026-02-30', 'date', 'Australia/Sydney', 1, ?, ?, ?)").bind(id, projectId, editorId, now, now).run();
    const before = await database.DB.prepare("SELECT * FROM project_subtasks WHERE id = ?").bind(id).first();
    const responses = [
      await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token"),
      await request(`/api/projects/${projectId}/subtasks/${id}`, "subtasks-editor-token", "PATCH", { title: "TB4D renamed" }),
      await request(`/api/projects/${projectId}/subtasks/${id}`, "subtasks-editor-token", "PATCH", { schedule: { expectedVersion: 1, schedule: { state: "range", start: { kind: "date", localCivil: "2026-09-01" }, end: { kind: "date", localCivil: "2026-09-02" } } } }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain("invalid"); expect(text).not.toContain("due_only"); expect(text).not.toContain("schedule");
    }
    expect(await database.DB.prepare("SELECT * FROM project_subtasks WHERE id = ?").bind(id).first()).toEqual(before);
    await database.DB.prepare("DELETE FROM project_subtasks WHERE id = ?").bind(id).run();
  });

  it("uses collaboration access, validates scoped input, orders/reorders tasks, and emits assignment notices only for real assignment changes", async () => {
    // Earlier schedule coverage intentionally leaves durable history on the shared fixture
    // project. Start this ordering contract from an empty checklist so the first two positions
    // prove the command's inline tail allocation rather than test execution order.
    await database.DB.prepare("DELETE FROM project_subtasks WHERE project_id = ?").bind(projectId).run();
    expect((await request(`/api/projects/${projectId}/subtasks`, "subtasks-admin-token")).status).toBe(200);
    expect((await request(`/api/projects/${projectId}/subtasks`, "subtasks-photographer-token")).status).toBe(200);
    expect((await request(`/api/projects/${projectId}/subtasks`, "subtasks-outsider-token")).status).toBe(403);
    expect((await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: " ", schedule: { state: "range", start: { kind: "date", localCivil: "2026-09-01" }, end: { kind: "date", localCivil: "2026-09-02" } } })).status).toBe(400);
    expect((await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "Bad date", schedule: { state: "range", start: { kind: "date", localCivil: "2027-02-29" }, end: { kind: "date", localCivil: "2027-03-01" } } })).status).toBe(400);
    expect((await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "Bad assignee", assigneeIds: [outsiderId] })).status).toBe(400);
    const firstResponse = await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "First", assigneeIds: [photographerId], schedule: { state: "range", start: { kind: "date", localCivil: "2028-02-28" }, end: { kind: "date", localCivil: "2028-02-29" } } });
    expect(firstResponse.status).toBe(201); const first = await firstResponse.json() as { id: string; position: number; assignmentVersion: number; dueDate: string | null };
    expect(first).toMatchObject({ position: 1024, assignmentVersion: 1, dueDate: "2028-02-29" });
    const second = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "Second" })).json() as { id: string; position: number };
    expect(second.position).toBe(2048);
    // #141: an assignment is a durable occurrence (outbox row) the consumer delivers, not a direct row.
    const notificationCount = async () => (await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE event_type = 'project.subtask.assigned' AND project_id = ?").bind(projectId).first<{ count: number }>())!.count;
    expect(await notificationCount()).toBe(1);
    const completed = await request(`/api/projects/${projectId}/subtasks/${first.id}`, "subtasks-editor-token", "PATCH", { done: true });
    expect((await completed.json() as { assignmentVersion: number }).assignmentVersion).toBe(1); expect(await notificationCount()).toBe(1);
    const assignees = (expectedVersion: number, add: string[], remove: string[]) => request(`/api/projects/${projectId}/subtasks/${first.id}`, "subtasks-editor-token", "PATCH", { assignees: { expectedVersion, add, remove } });
    const reassigned = await assignees(1, [adminId], [photographerId]);
    expect((await reassigned.json() as { assignmentVersion: number }).assignmentVersion).toBe(2); expect(await notificationCount()).toBe(2);
    // Retrying the same delta is stale (the version moved): a conflict, not another assignment event.
    expect((await assignees(1, [adminId], [photographerId])).status).toBe(409); expect(await notificationCount()).toBe(2);
    const cleared = await assignees(2, [], [adminId]);
    expect(await cleared.json()).toMatchObject({ dueDate: "2028-02-29", assignees: [], assignmentVersion: 3 });
    const reassignedAgain = await assignees(3, [adminId], []);
    expect(await reassignedAgain.json()).toMatchObject({ assignmentVersion: 4 }); expect(await notificationCount()).toBe(3);
    expect((await database.DB.prepare("SELECT source_key FROM notification_outbox WHERE event_type = 'project.subtask.assigned' AND project_id = ? ORDER BY source_key").bind(projectId).all()).results.map((row) => (row as { source_key: string }).source_key)).toEqual(expect.arrayContaining([`subtask-assignment:${first.id}:2`, `subtask-assignment:${first.id}:4`]));
    const moved = await request(`/api/projects/${projectId}/subtasks/${second.id}/reorder`, "subtasks-editor-token", "POST", { beforeId: null, afterId: first.id });
    expect(await moved.json()).toEqual({ position: 0 });
    const listed = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token")).json() as { subtasks: Array<{ id: string }> };
    expect(listed.subtasks.slice(0, 2).map((item) => item.id)).toEqual([second.id, first.id]);
    expect((await request(`/api/projects/${projectId}/subtasks/${first.id}`, "subtasks-photographer-token", "DELETE")).status).toBe(200);
    const auditActions = (await database.DB.prepare("SELECT action FROM audit_log WHERE target_id IN (?, ?) ORDER BY created_at").bind(first.id, second.id).all()).results.map((row) => (row as { action: string }).action);
    expect(auditActions).toEqual(expect.arrayContaining(["project_subtask.create", "project_subtask.update", "project_subtask.reorder", "project_subtask.delete"]));
  });

  it("keeps absent optional fields unchanged, does access-before-existence checks, and never audits missing mutations", async () => {
    const task = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "Null semantics", schedule: { state: "range", start: { kind: "date", localCivil: "2026-11-28" }, end: { kind: "date", localCivil: "2026-12-01" } } })).json() as { id: string; dueDate: string };
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
    for (const [id, position] of [[beforeId, 1024], [afterId, 2048], [targetId, 3072], [betweenId, 4096]] as const) await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_end_kind, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, '2099-12-31', 'date', '2099-12-31', 'date', 'Australia/Sydney', 1, ?, ?, ?)").bind(id, guardedProject, id, position, editorId, now, now).run();
    await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_end_kind, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, 'foreign', 0, 1024, 0, '2099-12-31', 'date', '2099-12-31', 'date', 'Australia/Sydney', 1, ?, ?, ?)").bind(foreignId, otherProject, editorId, now, now).run();
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
    for (const [id, position] of [[tiedBefore, 1024], [tiedAfter, 1024], [tiedTarget, 4096]] as const) await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_end_kind, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, '2099-12-31', 'date', '2099-12-31', 'date', 'Australia/Sydney', 1, ?, ?, ?)").bind(id, tiedProject, id, position, editorId, now, now).run();
    expect(await (await request(`/api/projects/${tiedProject}/subtasks/${tiedTarget}/reorder`, "subtasks-admin-token", "POST", { beforeId: tiedBefore, afterId: tiedAfter })).json()).toEqual({ position: 2048 });
    expect((await database.DB.prepare("SELECT id, position FROM project_subtasks WHERE project_id = ? ORDER BY position, id").bind(tiedProject).all()).results).toEqual([{ id: tiedBefore, position: 1024 }, { id: tiedTarget, position: 2048 }, { id: tiedAfter, position: 3072 }]);

    const longProject = crypto.randomUUID(); await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Long tied rebase', 'editing_autohdr', 0, ?, ?)").bind(longProject, now, now).run();
    const ids = Array.from({ length: 24 }, (_, index) => `82000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    for (const [index, id] of ids.entries()) await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_end_kind, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, '2099-12-31', 'date', '2099-12-31', 'date', 'Australia/Sydney', 1, ?, ?, ?)").bind(id, longProject, id, index === 10 ? 10 * 1024 : (index + 1) * 1024, editorId, now, now).run();
    const longTarget = ids[23]!; const longBefore = ids[9]!; const longAfter = ids[10]!;
    expect((await request(`/api/projects/${longProject}/subtasks/${longTarget}/reorder`, "subtasks-admin-token", "POST", { beforeId: longBefore, afterId: longAfter })).status).toBe(200);
    const longRows = (await database.DB.prepare("SELECT id, position FROM project_subtasks WHERE project_id = ? ORDER BY position, id").bind(longProject).all()).results as Array<{ id: string; position: number }>;
    expect(longRows.map((row) => row.id)).toEqual([...ids.slice(0, 10), longTarget, ...ids.slice(10, 23)]); expect(longRows.map((row) => row.position)).toEqual(Array.from({ length: 24 }, (_, index) => (index + 1) * 1024));
  });

  it("reorders at beginning, middle, and end without restamping neighbors, auditing twice, or notifying", async () => {
    const now = 1; const ordinaryProject = crypto.randomUUID(); const a = crypto.randomUUID(); const b = crypto.randomUUID(); const c = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Ordinary reorders', 'editing_autohdr', 0, ?, ?)").bind(ordinaryProject, now, now).run();
    for (const [id, position] of [[a, 1024], [b, 2048], [c, 3072]] as const) await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_end_kind, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, '2099-12-31', 'date', '2099-12-31', 'date', 'Australia/Sydney', 1, ?, ?, ?)").bind(id, ordinaryProject, id, position, editorId, now, now).run();
    const assignments = async () => (await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ? AND event_type = 'project.subtask.assigned'").bind(ordinaryProject).first<{ count: number }>())!.count;
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
    for (const [id, position] of [[before, 1024], [after, 1025], [target, 4096]] as const) await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_end_kind, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, '2099-12-31', 'date', '2099-12-31', 'date', 'Australia/Sydney', 1, ?, ?, ?)").bind(id, midpointProject, id, position, editorId, now, now).run();
    const response = await request(`/api/projects/${midpointProject}/subtasks/${target}/reorder`, "subtasks-admin-token", "POST", { beforeId: before, afterId: after }); expect(response.status).toBe(200); expect(await response.json()).toEqual({ position: 1024.5 });
    expect(await database.DB.prepare("SELECT position FROM project_subtasks WHERE id = ?").bind(target).first()).toEqual({ position: 1024.5 });
    expect((await database.DB.prepare("SELECT id, position, updated_at FROM project_subtasks WHERE project_id = ? ORDER BY position, id").bind(midpointProject).all()).results).toEqual([{ id: before, position: 1024, updated_at: now }, { id: target, position: 1024.5, updated_at: expect.any(Number) }, { id: after, position: 1025, updated_at: now }]);
  });

  it("clears a sent reminder when the range end is rescheduled, and the next end day fires again", async () => {
    const firstMorning = Date.UTC(2026, 7, 17, 22);
    const nextMorning = Date.UTC(2026, 7, 18, 22);
    const scheduleActivityCount = async () => (await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE event_type = 'project.checklist.schedule_changed' AND project_id = ?").bind(projectId).first<{ count: number }>())!.count;
    const scheduleOutboxCount = async () => (await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox o JOIN project_activity_events a ON a.id = o.source_key WHERE o.event_type = 'project.activity.broad' AND a.event_type = 'project.checklist.schedule_changed' AND o.project_id = ?").bind(projectId).first<{ count: number }>())!.count;
    const beforeScheduleActivityCount = await scheduleActivityCount();
    const beforeScheduleOutboxCount = await scheduleOutboxCount();
    const dueResponse = await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "Reschedule reminder", assigneeIds: [photographerId], schedule: { state: "range", start: { kind: "timed", localCivil: "2026-08-18T09:00" }, end: { kind: "timed", localCivil: "2026-08-18T14:30" } } });
    expect(dueResponse.status).toBe(201);
    const due = await dueResponse.json() as { id: string; dueDate: string; schedule: { state: string; version: number; end: { kind: string; localCivil: string; resolution: string } } };
    expect(due).toMatchObject({ dueDate: "2026-08-18T14:30", schedule: { state: "range", version: 1, end: { kind: "timed", localCivil: "2026-08-18T14:30" } } });
    expect(await scheduleActivityCount()).toBe(beforeScheduleActivityCount);
    expect(await scheduleOutboxCount()).toBe(beforeScheduleOutboxCount);
    const reminderEnv = { ...baseEnv, DB: database.DB, EMAIL: { send: vi.fn().mockResolvedValue({ messageId: "reschedule" }) }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test" } as unknown as Env;
    expect(await scanDueSubtasks(reminderEnv, firstMorning)).toBe(1);
    expect(await database.DB.prepare("SELECT due_reminder_sent_at FROM project_subtasks WHERE id = ?").bind(due.id).first()).toEqual({ due_reminder_sent_at: firstMorning });
    expect((await request(`/api/projects/${projectId}/subtasks/${due.id}`, "subtasks-editor-token", "PATCH", { schedule: { expectedVersion: due.schedule.version, schedule: { state: "range", start: { kind: "date", localCivil: "2026-08-18" }, end: { kind: "date", localCivil: "2026-08-19" } } } })).status).toBe(200);
    expect(await database.DB.prepare("SELECT due_reminder_sent_at FROM project_subtasks WHERE id = ?").bind(due.id).first()).toEqual({ due_reminder_sent_at: null });
    expect(await scanDueSubtasks(reminderEnv, nextMorning)).toBe(1);
    expect((await database.DB.prepare("SELECT count(*) AS count FROM notifications WHERE type = 'subtask_due_today' AND project_id = ? AND user_id = ?").bind(projectId, photographerId).first<{ count: number }>())!.count).toBe(2);
    expect((await request(`/api/projects/${projectId}/subtasks/${due.id}`, "subtasks-editor-token", "DELETE")).status).toBe(200);
  });

  it("emits one broad schedule notification when a schedule change moves the end", async () => {
    const created = await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", { title: "End change broadcast", schedule: { state: "range", start: { kind: "date", localCivil: "2026-12-30" }, end: { kind: "date", localCivil: "2026-12-31" } } });
    expect(created.status).toBe(201);
    const item = await created.json() as { id: string; schedule: { version: number } };
    const broadCount = async () => (await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox o JOIN project_activity_events a ON a.id = o.source_key WHERE o.event_type = 'project.activity.broad' AND a.event_type = 'project.checklist.schedule_changed' AND o.project_id = ?").bind(projectId).first<{ count: number }>())!.count;
    const before = await broadCount();
    const dueOnly = await request(`/api/projects/${projectId}/subtasks/${item.id}`, "subtasks-editor-token", "PATCH", { schedule: { expectedVersion: item.schedule.version, schedule: { state: "range", start: { kind: "date", localCivil: "2026-12-30" }, end: { kind: "date", localCivil: "2027-01-01" } } } });
    expect(dueOnly.status).toBe(200);
    expect(await broadCount()).toBe(before + 1);
  });

  it("resets a fold-only end claim without changing due_date or emitting a duplicate reminder", async () => {
    const firstMorning = Date.UTC(2026, 3, 4, 22);
    const created = await request(`/api/projects/${projectId}/subtasks`, "subtasks-editor-token", "POST", {
      title: "Fold-only reminder",
      assigneeIds: [photographerId],
      schedule: { state: "range", start: { kind: "timed", localCivil: "2026-04-05T00:00" }, end: { kind: "timed", localCivil: "2026-04-05T02:30", disambiguation: "earlier" } },
    });
    expect(created.status).toBe(201);
    const item = await created.json() as { id: string; dueDate: string; schedule: { version: number; end: { fold: number } } };
    const reminderEnv = { ...baseEnv, DB: database.DB, EMAIL: { send: vi.fn().mockResolvedValue({ messageId: "fold" }) }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test" } as unknown as Env;
    expect(await scanDueSubtasks(reminderEnv, firstMorning)).toBe(1);
    const changed = await request(`/api/projects/${projectId}/subtasks/${item.id}`, "subtasks-editor-token", "PATCH", {
      schedule: { expectedVersion: item.schedule.version, schedule: { state: "range", start: { kind: "timed", localCivil: "2026-04-05T00:00" }, end: { kind: "timed", localCivil: "2026-04-05T02:30", disambiguation: "later" } } },
    });
    expect(changed.status).toBe(200);
    const changedItem = await changed.json() as { dueDate: string; schedule: { end: { fold: number } } };
    expect(changedItem).toMatchObject({ dueDate: item.dueDate, schedule: { end: { fold: 1 } } });
    expect(await database.DB.prepare("SELECT due_reminder_sent_at, due_date FROM project_subtasks WHERE id = ?").bind(item.id).first()).toEqual({ due_reminder_sent_at: null, due_date: item.dueDate });
    expect(await scanDueSubtasks(reminderEnv, firstMorning)).toBe(0);
  });

  it("clears only final-role non-admin assignees as part of the project membership batch", async () => {
    const isolatedProject = crypto.randomUUID(); const now = Date.now(); const initialPhotographerId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Final role isolation', 'editing_autohdr', 0, ?, ?)").bind(isolatedProject, now, now).run();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(initialPhotographerId, isolatedProject, photographerId, now).run();
    const initialPhotographer = await database.DB.prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ? AND role_on_project = 'photographer'").bind(isolatedProject, photographerId).first<{ id: string }>();
    expect(initialPhotographer).toBeDefined();
    const finalTask = await (await request(`/api/projects/${isolatedProject}/subtasks`, "subtasks-admin-token", "POST", { title: "Final role", assigneeIds: [photographerId] })).json() as { id: string };
    const relationOf = (subtaskId: string) => database.DB.prepare("SELECT user_id, assignment_version FROM project_subtask_assignees WHERE subtask_id = ? ORDER BY user_id").bind(subtaskId).all<{ user_id: string; assignment_version: number }>().then((result) => result.results);
    expect(await relationOf(finalTask.id)).toEqual([{ user_id: photographerId, assignment_version: 1 }]);
    // Another Project's assignment of the same person is not touched by this removal (#364).
    const otherProjectTask = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-admin-token", "POST", { title: "Other project", assigneeIds: [photographerId] })).json() as { id: string };
    const unconfirmed = await request(`/api/projects/${isolatedProject}/photographers/${photographerId}`, "subtasks-admin-token", "DELETE", { membershipCycle: initialPhotographer!.id, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    expect(unconfirmed.status).toBe(422);
    expect(await unconfirmed.json()).toMatchObject({ code: "subtask_assignment_confirmation_required", assignmentCount: 1 });
    const confirmed = await request(`/api/projects/${isolatedProject}/photographers/${photographerId}`, "subtasks-admin-token", "DELETE", { membershipCycle: initialPhotographer!.id, clearSubtaskAssignments: true, confirmedAssignmentCount: 1 });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ outcome: "removed", removed: { membershipCycle: initialPhotographer!.id, userId: photographerId, roleOnProject: "photographer" }, subtaskAssignmentsCleared: 1 });
    expect(await database.DB.prepare("SELECT assignment_version FROM project_subtasks WHERE id = ?").bind(finalTask.id).first()).toEqual({ assignment_version: 2 });
    expect(await relationOf(finalTask.id)).toEqual([]);
    expect(await relationOf(otherProjectTask.id)).toEqual([{ user_id: photographerId, assignment_version: 1 }]);
    const audit = await database.DB.prepare("SELECT action, meta_json FROM audit_log WHERE action = 'project.member.remove' AND target_id = ? ORDER BY created_at DESC LIMIT 1").bind(initialPhotographer!.id).first<{ action: string; meta_json: string }>();
    expect(audit?.action).toBe("project.member.remove");
    expect(JSON.parse(audit!.meta_json)).toMatchObject({ projectId: isolatedProject, userId: photographerId, roleOnProject: "photographer", membershipCycle: initialPhotographer!.id });

    const retainedPhotographer = await addMember(editorId, "photographer");
    const retained = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-admin-token", "POST", { title: "Retained role", assigneeIds: [editorId] })).json() as { id: string };
    const retainedRemoval = await request(`/api/projects/${projectId}/photographers/${editorId}`, "subtasks-admin-token", "DELETE", { membershipCycle: retainedPhotographer, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    expect(retainedRemoval.status).toBe(200);
    expect(await retainedRemoval.json()).toMatchObject({ outcome: "removed", subtaskAssignmentsCleared: 0 });
    expect(await relationOf(retained.id)).toEqual([{ user_id: editorId, assignment_version: 1 }]);

    const adminPhotographer = await addMember(adminId, "photographer");
    const adminTask = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-admin-token", "POST", { title: "Admin persists", assigneeIds: [adminId] })).json() as { id: string };
    const adminRemoval = await request(`/api/projects/${projectId}/photographers/${adminId}`, "subtasks-admin-token", "DELETE", { membershipCycle: adminPhotographer, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    expect(adminRemoval.status).toBe(200);
    expect(await adminRemoval.json()).toMatchObject({ outcome: "removed", subtaskAssignmentsCleared: 0 });
    expect(await relationOf(adminTask.id)).toEqual([{ user_id: adminId, assignment_version: 1 }]);
    const transferredPhotographer = await addMember(outsiderId, "photographer");
    const transferred = await (await request(`/api/projects/${projectId}/subtasks`, "subtasks-admin-token", "POST", { title: "Transferred role", assigneeIds: [outsiderId] })).json() as { id: string };
    const editorRole = await request(`/api/projects/${projectId}/editors/${outsiderId}`, "subtasks-admin-token", "PUT", {});
    expect(editorRole.status).toBe(201);
    const editorMembership = await editorRole.json() as { membership: { id: string } };
    const transferredRemoval = await request(`/api/projects/${projectId}/photographers/${outsiderId}`, "subtasks-admin-token", "DELETE", { membershipCycle: transferredPhotographer, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    expect(transferredRemoval.status).toBe(200);
    expect(await transferredRemoval.json()).toMatchObject({ outcome: "removed", subtaskAssignmentsCleared: 0 });
    expect(await relationOf(transferred.id)).toEqual([{ user_id: outsiderId, assignment_version: 1 }]);
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
      database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_end_kind, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, 'One', 0, 1024, 1, '2099-12-31', 'date', '2099-12-31', 'date', 'Australia/Sydney', 1, ?, ?, ?)").bind(taskOne, isolatedProject, editorId, now, now),
      database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_end_kind, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, 'Two', 0, 2048, 1, '2099-12-31', 'date', '2099-12-31', 'date', 'Australia/Sydney', 1, ?, ?, ?)").bind(taskTwo, isolatedProject, editorId, now, now),
      database.DB.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, 1, ?)").bind(taskOne, photographerId, now),
      database.DB.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, 1, ?)").bind(taskTwo, photographerId, now),
    ]);
    const body = { membershipCycle: cycle, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 };
    const first = await request(`/api/projects/${isolatedProject}/photographers/${photographerId}`, "subtasks-admin-token", "DELETE", body);
    expect(first.status).toBe(422);
    const firstPayload = await first.json() as { assignmentCount: number };
    expect(firstPayload.assignmentCount).toBe(2);
    await database.DB.prepare("UPDATE project_subtasks SET assignment_version = assignment_version + 1 WHERE id = ?").bind(taskTwo).run();
    await database.DB.prepare("DELETE FROM project_subtask_assignees WHERE subtask_id = ?").bind(taskTwo).run();
    const retry = await request(`/api/projects/${isolatedProject}/photographers/${photographerId}`, "subtasks-admin-token", "DELETE", { membershipCycle: cycle, clearSubtaskAssignments: true, confirmedAssignmentCount: firstPayload.assignmentCount });
    expect(retry.status).toBe(422);
    await expect(retry.json()).resolves.toMatchObject({ code: "subtask_assignment_confirmation_required", assignmentCount: 1 });
    expect(await database.DB.prepare("SELECT id FROM project_members WHERE id = ?").bind(cycle).first()).toEqual({ id: cycle });
    expect(await database.DB.prepare("SELECT user_id FROM project_subtask_assignees WHERE subtask_id = ?").bind(taskOne).first()).toEqual({ user_id: photographerId });
  });

  it("treats a residual role made ineligible by global-role drift as no compatible role", async () => {
    const isolatedProject = crypto.randomUUID(); const taskId = crypto.randomUUID(); const photographerCycle = crypto.randomUUID(); const editorCycle = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Compatible role drift', 'editing_autohdr', ?, ?)").bind(isolatedProject, now, now).run();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(photographerCycle, isolatedProject, editorId, now),
      database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(editorCycle, isolatedProject, editorId, now),
      database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_end_kind, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, 'Drifted assignment', 0, 1024, 1, '2099-12-31', 'date', '2099-12-31', 'date', 'Australia/Sydney', 1, ?, ?, ?)").bind(taskId, isolatedProject, editorId, now, now),
      database.DB.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, 1, ?)").bind(taskId, editorId, now),
    ]);
    try {
      await database.DB.prepare("UPDATE user SET role = 'photographer' WHERE id = ?").bind(editorId).run();
      const probe = await request(`/api/projects/${isolatedProject}/photographers/${editorId}`, "subtasks-admin-token", "DELETE", { membershipCycle: photographerCycle, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
      expect(probe.status).toBe(422);
      await expect(probe.json()).resolves.toMatchObject({ code: "subtask_assignment_confirmation_required", assignmentCount: 1 });
      const removed = await request(`/api/projects/${isolatedProject}/photographers/${editorId}`, "subtasks-admin-token", "DELETE", { membershipCycle: photographerCycle, clearSubtaskAssignments: true, confirmedAssignmentCount: 1 });
      expect(removed.status).toBe(200);
      expect(await database.DB.prepare("SELECT id FROM project_members WHERE id = ?").bind(editorCycle).first()).toEqual({ id: editorCycle });
      expect(await database.DB.prepare("SELECT COUNT(*) AS n FROM project_subtask_assignees WHERE subtask_id = ?").bind(taskId).first()).toEqual({ n: 0 });
    } finally {
      await database.DB.prepare("UPDATE user SET role = 'editor' WHERE id = ?").bind(editorId).run();
    }
  });
});

describe("default Subtask range (#339)", () => {
  const CREATED_SPLIT = Date.UTC(2026, 5, 30, 15); // 2026-07-01 01:00 in Sydney
  type Seed = { shootDate?: string | null; deadlineLocalCivil?: string | null; createdAt?: number };
  async function seedProject(seed: Seed = {}) {
    const id = crypto.randomUUID(); const createdAt = seed.createdAt ?? CREATED_SPLIT;
    await database.DB.prepare("INSERT INTO projects (id, street, shoot_date, stage_key, board_position, created_at, updated_at) VALUES (?, 'Default Range Street', ?, 'editing_autohdr', 0, ?, ?)").bind(id, seed.shootDate ?? null, createdAt, createdAt).run();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(crypto.randomUUID(), id, photographerId, createdAt).run();
    if (seed.deadlineLocalCivil) await setDeadline(id, seed.deadlineLocalCivil);
    return id;
  }
  async function setDeadline(id: string, localCivil: string) {
    const before = await database.DB.prepare("SELECT deadline_version AS version FROM projects WHERE id = ?").bind(id).first<{ version: number }>();
    const response = await request(`/api/projects/${id}/deadline`, "subtasks-admin-token", "PUT", { expectedVersion: before!.version, deadline: { localCivil }, reminderOffsetsMinutes: [] });
    expect(response.status).toBe(200);
  }
  type Dto = { id: string; dueDate: string | null; schedule: { state: string; version: number; zone: string; start: { kind: string; localCivil: string } | null; end: { kind: string; localCivil: string } | null } };
  async function create(id: string, body: Record<string, unknown> = { title: "Defaulted" }) {
    const response = await request(`/api/projects/${id}/subtasks`, "subtasks-admin-token", "POST", body);
    expect(response.status).toBe(201);
    return await response.json() as Dto;
  }
  const columns = "due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_end_kind, schedule_end_at, schedule_zone, schedule_version";
  const row = (id: string) => database.DB.prepare(`SELECT ${columns} FROM project_subtasks WHERE id = ?`).bind(id).first();

  it("creates without a schedule as the Project's shoot date to Deadline range", async () => {
    const id = await seedProject({ shootDate: "2026-11-02", deadlineLocalCivil: "2026-11-06T17:00" });
    const item = await create(id);
    expect(item).toMatchObject({ dueDate: "2026-11-06", schedule: { state: "range", version: 1, zone: "Australia/Sydney", start: { kind: "date", localCivil: "2026-11-02" }, end: { kind: "date", localCivil: "2026-11-06" } } });
    expect(await row(item.id)).toEqual({ due_date: "2026-11-06", schedule_start_kind: "date", schedule_start_civil: "2026-11-02", schedule_start_at: null, schedule_end_kind: "date", schedule_end_at: null, schedule_zone: "Australia/Sydney", schedule_version: 1 });
  });

  it.each([
    ["no shoot date and no Deadline: the Sydney creation date, not the UTC date", { shootDate: null }, "2026-07-01", "2026-07-01"],
    ["non-canonical shoot text falls back to the creation date", { shootDate: "Thursday arvo", deadlineLocalCivil: "2026-07-09T10:00" }, "2026-07-01", "2026-07-09"],
    ["a Deadline before the shoot date collapses to one day on the Deadline", { shootDate: "2026-11-10", deadlineLocalCivil: "2026-11-06T09:00" }, "2026-11-06", "2026-11-06"],
    ["a shoot date with no Deadline is one day", { shootDate: "2026-11-02" }, "2026-11-02", "2026-11-02"],
  ] as Array<[string, Seed, string, string]>)("%s", async (_name, seed, start, end) => {
    const item = await create(await seedProject(seed));
    expect(item.schedule).toMatchObject({ state: "range", version: 1, start: { kind: "date", localCivil: start }, end: { kind: "date", localCivil: end } });
    expect(item.dueDate).toBe(end);
  });

  it("keeps an explicit range unchanged and rejects an explicit unscheduled create (#340)", async () => {
    const id = await seedProject({ shootDate: "2026-11-02", deadlineLocalCivil: "2026-11-06T17:00" });
    const explicit = await create(id, { title: "Explicit", schedule: { state: "range", start: { kind: "date", localCivil: "2026-12-01" }, end: { kind: "date", localCivil: "2026-12-03" } } });
    expect(explicit.schedule).toMatchObject({ state: "range", start: { localCivil: "2026-12-01" }, end: { localCivil: "2026-12-03" } });
    const unscheduled = await request(`/api/projects/${id}/subtasks`, "subtasks-admin-token", "POST", { title: "Explicit unscheduled", schedule: { state: "unscheduled" } });
    expect(unscheduled.status).toBe(400);
  });

  it("does not move existing Subtasks when the Project's shoot date or Deadline changes later", async () => {
    const id = await seedProject({ shootDate: "2026-11-02", deadlineLocalCivil: "2026-11-06T17:00" });
    const item = await create(id);
    const auditBefore = (await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(item.id).first<{ count: number }>())!.count;
    const updatedBefore = (await database.DB.prepare("SELECT updated_at FROM project_subtasks WHERE id = ?").bind(item.id).first<{ updated_at: number }>())!.updated_at;
    await database.DB.prepare("UPDATE projects SET shoot_date = '2026-12-01' WHERE id = ?").bind(id).run();
    await setDeadline(id, "2026-12-20T09:00");
    const listed = await (await request(`/api/projects/${id}/subtasks`, "subtasks-admin-token")).json() as { subtasks: Dto[] };
    expect(listed.subtasks.find((entry) => entry.id === item.id)).toMatchObject({ dueDate: "2026-11-06", schedule: { state: "range", version: 1, start: { localCivil: "2026-11-02" }, end: { localCivil: "2026-11-06" } } });
    expect(await row(item.id)).toMatchObject({ due_date: "2026-11-06", schedule_start_civil: "2026-11-02", schedule_version: 1 });
    expect((await database.DB.prepare("SELECT updated_at FROM project_subtasks WHERE id = ?").bind(item.id).first<{ updated_at: number }>())!.updated_at).toBe(updatedBefore);
    expect((await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ?").bind(item.id).first<{ count: number }>())!.count).toBe(auditBefore);
  });

  it("writes the same audit and activity shape as an explicit range create, apart from the schedule", async () => {
    const id = await seedProject({ shootDate: "2026-11-02", deadlineLocalCivil: "2026-11-06T17:00" });
    const defaulted = await create(id, { title: "Audit default", assigneeIds: [photographerId] });
    const explicit = await create(id, { title: "Audit explicit", assigneeIds: [photographerId], schedule: { state: "range", start: { kind: "date", localCivil: "2026-11-02" }, end: { kind: "date", localCivil: "2026-11-06" } } });
    const audit = async (itemId: string) => (await database.DB.prepare("SELECT action, target_type, meta_json FROM audit_log WHERE target_id = ?").bind(itemId).all()).results;
    expect(await audit(defaulted.id)).toEqual(await audit(explicit.id));
    expect(await audit(defaulted.id)).toHaveLength(1);
    expect(JSON.parse((await audit(defaulted.id))[0]!.meta_json as string)).toMatchObject({ scheduleState: "range", scheduleVersion: 1 });
    const activityCount = async (itemId: string, type: string) => (await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ? AND event_type = ? AND source_id = ?").bind(id, type, itemId).first<{ count: number }>())!.count;
    for (const item of [defaulted, explicit]) {
      expect(await activityCount(item.id, "project.checklist.item_created")).toBe(1);
      expect(await activityCount(item.id, "project.checklist.schedule_changed")).toBe(0);
    }
    expect((await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE event_type = 'project.subtask.assigned' AND source_key = ?").bind(`subtask-assignment:${defaulted.id}:1`).first<{ count: number }>())!.count).toBe(1);
  });

  it("makes a defaulted, assigned Subtask due on its range end for the due-day reminder scan", async () => {
    const id = await seedProject({ shootDate: "2026-11-02", deadlineLocalCivil: "2026-11-06T17:00" });
    const item = await create(id, { title: "Reminder default", assigneeIds: [photographerId] });
    const reminderEnv = { ...baseEnv, DB: database.DB, EMAIL: { send: vi.fn().mockResolvedValue({ messageId: "default-range" }) }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test" } as unknown as Env;
    const dueMorning = Date.UTC(2026, 10, 5, 21); // 2026-11-06 08:00 in Sydney (AEDT)
    await scanDueSubtasks(reminderEnv, dueMorning);
    expect(await database.DB.prepare("SELECT due_reminder_sent_at FROM project_subtasks WHERE id = ?").bind(item.id).first()).toEqual({ due_reminder_sent_at: dueMorning });
  });
});

describe("ranges only (#340)", () => {
  const base = () => `/api/projects/${projectId}/subtasks`;
  const day = (localCivil: string) => ({ kind: "date", localCivil }) as const;
  const range = (start: string, end: string) => ({ state: "range", start: day(start), end: day(end) }) as const;
  const auditCount = async () => (await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action LIKE 'project_subtask.%'").first<{ count: number }>())!.count;
  const rowCount = async () => (await database.DB.prepare("SELECT count(*) AS count FROM project_subtasks WHERE project_id = ?").bind(projectId).first<{ count: number }>())!.count;
  async function createRange(title: string, extra: Record<string, unknown> = {}, schedule: unknown = range("2026-09-01", "2026-09-03")) {
    const response = await request(base(), "subtasks-editor-token", "POST", { title, schedule, ...extra });
    expect(response.status).toBe(201);
    return await response.json() as { id: string; dueDate: string; schedule: { version: number; start: { localCivil: string }; end: { localCivil: string } } };
  }
  it("rejects an unscheduled or due-only create with a validation error and writes nothing", async () => {
    const audits = await auditCount(); const rows = await rowCount();
    for (const schedule of [{ state: "unscheduled" }, { state: "due_only", end: day("2026-08-18") }]) {
      const response = await request(base(), "subtasks-editor-token", "POST", { title: "Nope", schedule });
      expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: "Invalid input" });
    }
    expect(await auditCount()).toBe(audits); expect(await rowCount()).toBe(rows);
  });

  it("removes the legacy single dueDate create input", async () => {
    const audits = await auditCount(); const rows = await rowCount();
    const response = await request(base(), "subtasks-editor-token", "POST", { title: "Legacy", dueDate: "2026-08-18" });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: "Invalid input" });
    expect(await auditCount()).toBe(audits); expect(await rowCount()).toBe(rows);
  });

  it("rejects unscheduled, due-only and legacy dueDate updates without touching the row", async () => {
    const item = await createRange("Range then legacy writes");
    const audits = await auditCount();
    for (const body of [
      { schedule: { expectedVersion: item.schedule.version, schedule: { state: "due_only", end: day("2026-09-04") } } },
      { schedule: { expectedVersion: item.schedule.version, schedule: { state: "unscheduled" } } },
      { dueDate: "2026-09-02" },
      { dueDate: null },
    ]) {
      const response = await request(`${base()}/${item.id}`, "subtasks-editor-token", "PATCH", body);
      expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: "Invalid input" });
    }
    expect(await auditCount()).toBe(audits);
    expect(await database.DB.prepare("SELECT due_date, schedule_version FROM project_subtasks WHERE id = ?").bind(item.id).first()).toEqual({ due_date: "2026-09-03", schedule_version: 1 });
  });

  it("stores a date range with start = end as a one-day range", async () => {
    const item = await createRange("One day", {}, range("2026-09-10", "2026-09-10"));
    expect(item).toMatchObject({ dueDate: "2026-09-10", schedule: { state: "range", start: { localCivil: "2026-09-10" }, end: { localCivil: "2026-09-10" } } });
  });

  it("rejects timed start = end (an instant is not a day)", async () => {
    const at = { kind: "timed", localCivil: "2026-09-10T09:00" } as const;
    const response = await request(base(), "subtasks-editor-token", "POST", { title: "Instant", schedule: { state: "range", start: at, end: at } });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "subtask_schedule_invalid_order" });
  });

  it("keeps the expected-version lock: a stale range PATCH is a 409 with the current schedule", async () => {
    const item = await createRange("Locked");
    const stale = await request(`${base()}/${item.id}`, "subtasks-editor-token", "PATCH", { schedule: { expectedVersion: 0, schedule: range("2026-09-05", "2026-09-06") } });
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: "subtask_schedule_version_conflict", current: { state: "range", version: 1 } });
    const fresh = await request(`${base()}/${item.id}`, "subtasks-editor-token", "PATCH", { schedule: { expectedVersion: 1, schedule: range("2026-09-05", "2026-09-06") } });
    expect(fresh.status).toBe(200); expect(await fresh.json()).toMatchObject({ schedule: { version: 2 } });
  });

  it("fires the due-day reminder on the range END day, and again after the end moves", async () => {
    const reminderEnv = { ...baseEnv, DB: database.DB, EMAIL: { send: vi.fn().mockResolvedValue({ messageId: "range-end" }) }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test" } as unknown as Env;
    const item = await createRange("Reminder on end", { assigneeIds: [photographerId] }, { state: "range", start: { kind: "timed", localCivil: "2026-11-02T00:00" }, end: { kind: "timed", localCivil: "2026-11-06T15:00" } });
    const startMorning = Date.UTC(2026, 10, 1, 21); // 2026-11-02 08:00 Sydney
    const endMorning = Date.UTC(2026, 10, 5, 21); // 2026-11-06 08:00 Sydney
    expect(await scanDueSubtasks(reminderEnv, startMorning)).toBe(0);
    expect(await scanDueSubtasks(reminderEnv, endMorning)).toBe(1);
    const moved = await request(`${base()}/${item.id}`, "subtasks-editor-token", "PATCH", { schedule: { expectedVersion: 1, schedule: { state: "range", start: { kind: "timed", localCivil: "2026-11-02T00:00" }, end: { kind: "timed", localCivil: "2026-11-09T15:00" } } } });
    expect(moved.status).toBe(200);
    expect(await database.DB.prepare("SELECT due_reminder_sent_at FROM project_subtasks WHERE id = ?").bind(item.id).first()).toEqual({ due_reminder_sent_at: null });
    expect(await scanDueSubtasks(reminderEnv, Date.UTC(2026, 10, 8, 21))).toBe(1); // 2026-11-09 08:00
  });
});

describe("assignee relation writes (#364, #373)", () => {
  const relationProject = crypto.randomUUID();
  const base = () => `/api/projects/${relationProject}/subtasks`;
  const create = async (body: Record<string, unknown>) => (await (await request(base(), "subtasks-editor-token", "POST", { title: "Relation", ...body })).json()) as { id: string };
  const patch = (id: string, body: Record<string, unknown>) => request(`${base()}/${id}`, "subtasks-editor-token", "PATCH", body);
  const delta = (id: string, expectedVersion: number, add: string[], remove: string[] = []) => patch(id, { assignees: { expectedVersion, add, remove } });
  const relationRows = async (subtaskId: string) => (await database.DB.prepare("SELECT user_id, assignment_version FROM project_subtask_assignees WHERE subtask_id = ? ORDER BY user_id").bind(subtaskId).all<{ user_id: string; assignment_version: number }>()).results;
  const versionOf = async (subtaskId: string) => (await database.DB.prepare("SELECT assignment_version FROM project_subtasks WHERE id = ?").bind(subtaskId).first<{ assignment_version: number }>())!.assignment_version;

  beforeAll(async () => {
    const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Relation Street', 'editing_autohdr', 0, ?, ?)").bind(relationProject, now, now).run();
    for (const [userId, role] of [[editorId, "editor"], [photographerId, "photographer"]] as const) await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), relationProject, userId, role, now).run();
  });

  it("create with an assignee writes one relation row at version 1, without one writes none", async () => {
    const assigned = await create({ assigneeIds: [editorId] });
    expect(await relationRows(assigned.id)).toEqual([{ user_id: editorId, assignment_version: 1 }]);
    const unassigned = await create({});
    expect(await relationRows(unassigned.id)).toEqual([]);
  });

  it("replacing removes one row and adds another at the new version, clearing removes it, and unrelated edits leave it alone", async () => {
    const item = await create({ assigneeIds: [editorId] });
    expect((await delta(item.id, 1, [photographerId], [editorId])).status).toBe(200);
    expect(await relationRows(item.id)).toEqual([{ user_id: photographerId, assignment_version: 2 }]);
    expect(await versionOf(item.id)).toBe(2);
    expect((await patch(item.id, { title: "Renamed", done: true })).status).toBe(200);
    expect(await relationRows(item.id)).toEqual([{ user_id: photographerId, assignment_version: 2 }]);
    expect((await delta(item.id, 2, [], [photographerId])).status).toBe(200);
    expect(await relationRows(item.id)).toEqual([]);
    expect(await versionOf(item.id)).toBe(3);
    expect((await delta(item.id, 3, [editorId])).status).toBe(200);
    expect(await relationRows(item.id)).toEqual([{ user_id: editorId, assignment_version: 4 }]);
  });

  it("two concurrent reassignments from the same version: one wins, the other is a conflict, and exactly one row remains", async () => {
    const item = await create({ assigneeIds: [editorId] });
    const responses = await Promise.all([delta(item.id, 1, [photographerId], [editorId]), delta(item.id, 1, [adminId], [editorId])]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const loser = responses.find((response) => response.status === 409)!;
    expect(await loser.json()).toMatchObject({ code: "subtask_assignment_version_conflict" });
    const rows = await relationRows(item.id);
    expect(rows).toHaveLength(1);
    expect([photographerId, adminId]).toContain(rows[0]!.user_id);
    expect(rows[0]!.assignment_version).toBe(await versionOf(item.id));
    expect(rows[0]!.assignment_version).toBe(2);
  });

  it("the retired single-assignee fields are refused: create and update take assigneeIds / assignees only", async () => {
    const item = await create({ assigneeIds: [editorId] });
    expect((await request(base(), "subtasks-editor-token", "POST", { title: "Legacy", assigneeId: editorId })).status).toBe(400);
    expect((await patch(item.id, { assigneeId: photographerId })).status).toBe(400);
    expect((await patch(item.id, { assigneeId: null })).status).toBe(400);
    expect(await relationRows(item.id)).toEqual([{ user_id: editorId, assignment_version: 1 }]);
    expect(await versionOf(item.id)).toBe(1);
  });

  it("deleting a Subtask removes its rows", async () => {
    const doomed = await create({ assigneeIds: [photographerId] });
    expect(await relationRows(doomed.id)).toHaveLength(1);
    expect((await request(`${base()}/${doomed.id}`, "subtasks-editor-token", "DELETE")).status).toBe(200);
    expect(await relationRows(doomed.id)).toEqual([]);
  });
});

describe("multi-assignee writes (#368)", () => {
  const multiProject = crypto.randomUUID();
  const externalId = "75555555-5555-4555-8555-555555555555";
  const retiredId = "76666666-6666-4666-8666-666666666666";
  const base = () => `/api/projects/${multiProject}/subtasks`;
  const create = async (body: Record<string, unknown> = {}, token = "subtasks-editor-token") => request(base(), token, "POST", { title: "Multi", ...body });
  const createItem = async (body: Record<string, unknown> = {}) => (await (await create(body)).json()) as Dto;
  const patch = (id: string, body: Record<string, unknown>, token = "subtasks-editor-token") => request(`${base()}/${id}`, token, "PATCH", body);
  const delta = (id: string, expectedVersion: number, add: string[], remove: string[] = [], token = "subtasks-editor-token") => patch(id, { assignees: { expectedVersion, add, remove } }, token);
  const relationRows = async (subtaskId: string) => (await database.DB.prepare("SELECT user_id, assignment_version FROM project_subtask_assignees WHERE subtask_id = ? ORDER BY user_id").bind(subtaskId).all<{ user_id: string; assignment_version: number }>()).results;
  const versionOf = async (subtaskId: string) => (await database.DB.prepare("SELECT assignment_version FROM project_subtasks WHERE id = ?").bind(subtaskId).first<{ assignment_version: number }>())!.assignment_version;
  const assignedOutbox = async (subtaskId: string) => (await database.DB.prepare("SELECT source_key, recipient_id, json_extract(payload_json, '$.assignment.assignmentVersion') AS version FROM notification_outbox WHERE event_type = 'project.subtask.assigned' AND json_extract(payload_json, '$.assignment.subtaskId') = ? ORDER BY recipient_id").bind(subtaskId).all<{ source_key: string; recipient_id: string; version: number }>()).results;
  type Dto = { id: string; assignees: Array<{ id: string; name: string; roleLabel: string; isExternal: boolean; active: boolean }>; assignmentVersion: number };

  beforeAll(async () => {
    const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Multi Assignee Street', 'editing_autohdr', 0, ?, ?)").bind(multiProject, now, now).run();
    for (const [id, role] of [[externalId, "external_editor"], [retiredId, "photographer"]] as const) await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(id, `${role} ${id.slice(0, 4)}`, `${id}@example.test`, role, now, now).run();
    await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind("subtasks-external", now + 3_600_000, "subtasks-external-token", externalId, now, now).run();
    for (const [userId, role] of [[editorId, "editor"], [photographerId, "photographer"], [externalId, "editor"], [retiredId, "photographer"]] as const) await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), multiProject, userId, role, now).run();
  });

  it("adds several assignees in one delta: ordered DTO, one version, one row each", async () => {
    const item = await createItem();
    const response = await delta(item.id, 0, [photographerId, adminId, editorId]);
    expect(response.status).toBe(200);
    const body = await response.json() as Dto;
    // Same version and added_at: the order falls back to user id (admin 71.., editor 72.., photographer 73..).
    expect(body.assignees.map((person) => person.id)).toEqual([adminId, editorId, photographerId]);
    expect(body.assignees[0]).toEqual({ id: adminId, name: expect.any(String), roleLabel: expect.any(String), isExternal: false, active: true });
    expect(body.assignmentVersion).toBe(1);
    expect(await relationRows(item.id)).toEqual([{ user_id: adminId, assignment_version: 1 }, { user_id: editorId, assignment_version: 1 }, { user_id: photographerId, assignment_version: 1 }]);
    expect(await versionOf(item.id)).toBe(1);

    const removed = await delta(item.id, 1, [], [adminId]);
    expect(removed.status).toBe(200);
    const after = await removed.json() as Dto;
    expect(after.assignmentVersion).toBe(2);
    expect(after.assignees.map((person) => person.id)).toEqual([editorId, photographerId]);
    expect(await versionOf(item.id)).toBe(2);
    // Survivors keep the version they were added at.
    expect(await relationRows(item.id)).toEqual([{ user_id: editorId, assignment_version: 1 }, { user_id: photographerId, assignment_version: 1 }]);

    const listed = await (await request(base(), "subtasks-editor-token")).json() as { subtasks: Dto[] };
    expect(listed.subtasks.find((row) => row.id === item.id)?.assignees.map((person) => person.id)).toEqual([editorId, photographerId]);
  });

  it("creates with assigneeIds, and refuses duplicate ids", async () => {
    const created = await create({ assigneeIds: [editorId, photographerId] });
    expect(created.status).toBe(201);
    const body = await created.json() as Dto;
    expect(body.assignmentVersion).toBe(1);
    expect(body.assignees.map((person) => person.id).sort()).toEqual([editorId, photographerId]);
    expect(await relationRows(body.id)).toEqual([{ user_id: editorId, assignment_version: 1 }, { user_id: photographerId, assignment_version: 1 }]);
    expect(await versionOf(body.id)).toBe(1);
    expect((await create({ assigneeIds: [editorId, editorId] })).status).toBe(400);
  });

  it("refuses an ineligible add without writing, and a deactivated kept assignee does not block removing someone else", async () => {
    const item = await createItem({ assigneeIds: [editorId, retiredId] });
    const before = await relationRows(item.id);
    const refused = await delta(item.id, 1, [outsiderId]);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ code: "subtask_assignee_ineligible" });
    expect((await create({ assigneeIds: [outsiderId] })).status).toBe(400);
    expect(await relationRows(item.id)).toEqual(before);
    expect(await versionOf(item.id)).toBe(1);

    await database.DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(retiredId).run();
    try {
      const removed = await delta(item.id, 1, [], [editorId]);
      expect(removed.status).toBe(200);
      // The since-deactivated assignee still reads as an assignee, flagged inactive.
      const remaining = (await removed.json() as Dto).assignees;
      expect(remaining.map((person) => person.id)).toEqual([retiredId]);
      expect(remaining[0]).toMatchObject({ active: false });
    } finally { await database.DB.prepare("UPDATE user SET active = 1 WHERE id = ?").bind(retiredId).run(); }
  });

  it("rejects an invalid delta: adding a current assignee, removing a non-assignee, or the same id on both sides", async () => {
    const item = await createItem({ assigneeIds: [editorId] });
    const addExisting = await delta(item.id, 1, [editorId]);
    expect(addExisting.status).toBe(400); expect(await addExisting.json()).toMatchObject({ code: "subtask_assignee_invalid_delta" });
    const removeAbsent = await delta(item.id, 1, [], [photographerId]);
    expect(removeAbsent.status).toBe(400); expect(await removeAbsent.json()).toMatchObject({ code: "subtask_assignee_invalid_delta" });
    expect((await delta(item.id, 1, [photographerId], [photographerId])).status).toBe(400);
    expect((await patch(item.id, { assignees: { expectedVersion: 1, add: [], remove: [] } })).status).toBe(400);
    expect(await relationRows(item.id)).toEqual([{ user_id: editorId, assignment_version: 1 }]);
    expect(await versionOf(item.id)).toBe(1);
  });

  it("guards every assignee change with the Subtask-wide version", async () => {
    const item = await createItem({ assigneeIds: [editorId, photographerId] });
    const stale = await delta(item.id, 0, [adminId]);
    expect(stale.status).toBe(409);
    const conflict = await stale.json() as { code: string; currentSubtask: Dto };
    expect(conflict.code).toBe("subtask_assignment_version_conflict");
    expect(conflict.currentSubtask).toMatchObject({ id: item.id, assignmentVersion: 1 });
    expect(conflict.currentSubtask.assignees.map((person) => person.id).sort()).toEqual([editorId, photographerId]);
    expect(await relationRows(item.id)).toEqual([{ user_id: editorId, assignment_version: 1 }, { user_id: photographerId, assignment_version: 1 }]);
    // A stale change is a conflict whatever it would have changed.
    expect((await delta(item.id, 0, [], [photographerId])).status).toBe(409);
    expect(await versionOf(item.id)).toBe(1);
  });

  it("two concurrent deltas with the same expectedVersion: exactly one wins, the other gets a 409", async () => {
    const item = await createItem({ assigneeIds: [editorId] });
    const responses = await Promise.all([delta(item.id, 1, [photographerId]), delta(item.id, 1, [adminId])]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const loser = responses.find((response) => response.status === 409)!;
    expect(await loser.json()).toMatchObject({ code: "subtask_assignment_version_conflict" });
    expect(await versionOf(item.id)).toBe(2);
    const rows = await relationRows(item.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.user_id === editorId)).toEqual({ user_id: editorId, assignment_version: 1 });
    expect(rows.filter((row) => row.assignment_version === 2)).toHaveLength(1);
  });

  it("notifies only the newly added person, with that person's own version", async () => {
    const item = await createItem({ assigneeIds: [adminId] });
    // Created by the editor with the admin assigned: one notice, version 1.
    expect(await assignedOutbox(item.id)).toEqual([{ source_key: `subtask-assignment:${item.id}:1`, recipient_id: adminId, version: 1 }]);
    expect((await delta(item.id, 1, [photographerId])).status).toBe(200);
    expect(await assignedOutbox(item.id)).toEqual([
      { source_key: `subtask-assignment:${item.id}:1`, recipient_id: adminId, version: 1 },
      { source_key: `subtask-assignment:${item.id}:2`, recipient_id: photographerId, version: 2 },
    ]);
    expect(await relationRows(item.id)).toEqual([{ user_id: adminId, assignment_version: 1 }, { user_id: photographerId, assignment_version: 2 }]);
    // Adding yourself, or removing anyone, notifies nobody.
    expect((await delta(item.id, 2, [editorId])).status).toBe(200);
    expect((await delta(item.id, 3, [], [adminId])).status).toBe(200);
    expect(await assignedOutbox(item.id)).toHaveLength(2);
  });

  it("two people added at once are two notices with one source key and different recipients", async () => {
    const item = await createItem();
    expect((await delta(item.id, 0, [adminId, photographerId])).status).toBe(200);
    expect(await assignedOutbox(item.id)).toEqual([
      { source_key: `subtask-assignment:${item.id}:1`, recipient_id: adminId, version: 1 },
      { source_key: `subtask-assignment:${item.id}:1`, recipient_id: photographerId, version: 1 },
    ]);
  });

  it("records who was added and removed in the activity payload and the audit details", async () => {
    const item = await createItem({ assigneeIds: [adminId] });
    expect((await delta(item.id, 1, [photographerId, editorId], [adminId])).status).toBe(200);
    const events = (await database.DB.prepare("SELECT safe_payload_json FROM project_activity_events WHERE event_type = 'project.checklist.item_updated' AND source_id = ? ORDER BY occurred_at, id").bind(item.id).all<{ safe_payload_json: string }>()).results.map((row) => JSON.parse(row.safe_payload_json));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ itemId: item.id, changes: ["assignee"], assigneesAddedCount: 2, assigneesRemovedCount: 1, assigneesRemoved: [adminId] });
    expect((events[0].assigneesAdded as string[]).sort()).toEqual([editorId, photographerId]);
    const audit = await database.DB.prepare("SELECT meta_json FROM audit_log WHERE action = 'project_subtask.update' AND target_id = ? ORDER BY created_at DESC LIMIT 1").bind(item.id).first<{ meta_json: string }>();
    const meta = JSON.parse(audit!.meta_json) as Record<string, unknown>;
    expect(meta).toMatchObject({ assigneesRemoved: [adminId] });
    expect((meta.assigneesAdded as string[]).sort()).toEqual([editorId, photographerId]);
  });

  it("caps activity ids at 25 while the counts carry the total", async () => {
    const item = await createItem();
    const now = Date.now();
    const bulk = Array.from({ length: 30 }, (_, index) => `77000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    for (const id of bulk) {
      await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, 'photographer', 1, ?, ?)").bind(id, `bulk ${id.slice(-4)}`, `${id}@example.test`, now, now).run();
      await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(crypto.randomUUID(), multiProject, id, now).run();
    }
    expect((await delta(item.id, 0, bulk)).status).toBe(200);
    const event = await database.DB.prepare("SELECT safe_payload_json FROM project_activity_events WHERE event_type = 'project.checklist.item_updated' AND source_id = ?").bind(item.id).first<{ safe_payload_json: string }>();
    const payload = JSON.parse(event!.safe_payload_json) as { assigneesAdded: string[]; assigneesAddedCount: number };
    expect(payload.assigneesAdded).toHaveLength(25); expect(payload.assigneesAddedCount).toBe(30);
    expect(await relationRows(item.id)).toHaveLength(30);
  });

  describe("as an External Editor", () => {
    const externalPatch = (id: string, body: Record<string, unknown>) => patch(id, body, "subtasks-external-token");

    it("may remove a team-member assignee, but never touches a person hidden from them", async () => {
      const item = await createItem({ assigneeIds: [photographerId, adminId] });
      const removed = await externalPatch(item.id, { assignees: { expectedVersion: 1, add: [], remove: [photographerId] } });
      expect(removed.status).toBe(200);
      // Only the hidden admin remains: the external sees no name, an empty list and a count of one.
      expect(await removed.json()).toMatchObject({ assignees: [], otherAssigneeCount: 1 });
      expect(await relationRows(item.id)).toEqual([{ user_id: adminId, assignment_version: 1 }]);
      // The non-team admin is hidden from an external: removing them is refused and changes nothing.
      const hidden = await externalPatch(item.id, { assignees: { expectedVersion: 2, add: [], remove: [adminId] } });
      expect(hidden.status).toBe(400); expect(await hidden.json()).toMatchObject({ code: "subtask_assignee_invalid_delta" });
      expect(await relationRows(item.id)).toEqual([{ user_id: adminId, assignment_version: 1 }]);
    });

    it("may add only active users on the Project's team", async () => {
      const item = await createItem();
      const refused = await externalPatch(item.id, { assignees: { expectedVersion: 0, add: [adminId], remove: [] } });
      expect(refused.status).toBe(400);
      expect(await relationRows(item.id)).toEqual([]);
      const allowed = await externalPatch(item.id, { assignees: { expectedVersion: 0, add: [photographerId], remove: [] } });
      expect(allowed.status).toBe(200);
      expect(await relationRows(item.id)).toEqual([{ user_id: photographerId, assignment_version: 1 }]);
    });

    it("gets the external DTO in every conflict body, never the staff DTO", async () => {
      const item = await createItem({ assigneeIds: [photographerId] });
      const stale = await externalPatch(item.id, { assignees: { expectedVersion: 0, add: [editorId], remove: [] } });
      expect(stale.status).toBe(409);
      const body = await stale.json() as { code: string; currentSubtask: Record<string, unknown> };
      expect(body.code).toBe("subtask_assignment_version_conflict");
      expect(body.currentSubtask).toMatchObject({ id: item.id, assignmentVersion: 1 });
      expect(body.currentSubtask).toMatchObject({ assignees: [{ id: photographerId }], otherAssigneeCount: 0 });
      const schedule = await externalPatch(item.id, { title: "Renamed", schedule: { expectedVersion: 9, schedule: { state: "range", start: { kind: "date", localCivil: "2026-09-01" }, end: { kind: "date", localCivil: "2026-09-02" } } } });
      expect(schedule.status).toBe(409);
      expect((await schedule.json() as { currentSubtask: Record<string, unknown> }).currentSubtask).toMatchObject({ assignees: [{ id: photographerId }], otherAssigneeCount: 0 });
    });

    it("names only team assignees on GET and counts the rest, never leaking a hidden id or name", async () => {
      const item = await createItem({ assigneeIds: [photographerId, adminId] });
      const adminName = (await database.DB.prepare("SELECT name FROM user WHERE id = ?").bind(adminId).first<{ name: string }>())!.name;
      const list = await request(base(), "subtasks-external-token");
      expect(list.status).toBe(200);
      const text = await list.text();
      const found = (JSON.parse(text) as { subtasks: Array<Record<string, unknown> & { id: string }> }).subtasks.find((row) => row.id === item.id)!;
      expect(found).toMatchObject({ assignees: [{ id: photographerId }], otherAssigneeCount: 1 });
      const own = JSON.stringify(found);
      expect(own).not.toContain(adminId); expect(own).not.toContain(adminName);
      const staff = await (await request(base(), "subtasks-editor-token")).json() as { subtasks: Array<{ id: string; assignees: Array<{ id: string }> }> };
      expect(staff.subtasks.find((row) => row.id === item.id)!.assignees.map((person) => person.id).sort()).toEqual([adminId, photographerId].sort());
    });

    it("a sole non-team assignee is not named: empty list, one other", async () => {
      const item = await createItem({ assigneeIds: [adminId] });
      const list = await (await request(base(), "subtasks-external-token")).json() as { subtasks: Array<Record<string, unknown> & { id: string }> };
      const found = list.subtasks.find((row) => row.id === item.id)!;
      expect(found).toMatchObject({ assignees: [], otherAssigneeCount: 1 });
      expect(JSON.stringify(found)).not.toContain(adminId);
    });

    it("an external PATCH success uses the same projection", async () => {
      const item = await createItem({ assigneeIds: [adminId] });
      const response = await externalPatch(item.id, { assignees: { expectedVersion: 1, add: [photographerId], remove: [] } });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ assignees: [{ id: photographerId }], otherAssigneeCount: 1 });
      expect(text).not.toContain(adminId);
    });
  });

  describe("GET /projects/:projectId/subtask-assignee-options", () => {
    const options = (token: string, project = multiProject) => request(`/api/projects/${project}/subtask-assignee-options`, token);

    it("staff get every eligible person uncapped", async () => {
      const bulkRows = 25;
      const now = Date.now();
      for (let index = 0; index < bulkRows; index += 1) {
        const id = `78000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
        await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, 'photographer', 1, ?, ?)").bind(id, `option ${index}`, `${id}@example.test`, now, now).run();
        await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(crypto.randomUUID(), multiProject, id, now).run();
      }
      const response = await options("subtasks-editor-token");
      expect(response.status).toBe(200);
      const body = subtaskAssigneeOptionsResponseSchema.parse(await response.json());
      expect(body.candidates.length).toBeGreaterThan(20);
      const ids = body.candidates.map((person) => person.id);
      expect(ids).toEqual(expect.arrayContaining([adminId, editorId, photographerId, externalId]));
      expect(ids).not.toContain(outsiderId);
    });

    it("externals get team members only, in the external person shape", async () => {
      const response = await options("subtasks-external-token");
      expect(response.status).toBe(200);
      const body = externalSubtaskAssigneeOptionsResponseSchema.parse(await response.json());
      const ids = body.candidates.map((person) => person.id);
      expect(ids).toEqual(expect.arrayContaining([editorId, photographerId, externalId]));
      expect(ids).not.toContain(adminId);
      expect(body.candidates.find((person) => person.id === externalId)).toMatchObject({ isExternal: true, active: true });
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("a non-member is refused, and an external sees a generic 404 for a project it cannot see", async () => {
      expect((await options("subtasks-outsider-token")).status).toBe(403);
      expect((await options("subtasks-external-token", projectId)).status).toBe(404);
      expect((await options("subtasks-admin-token", crypto.randomUUID())).status).toBe(404);
      expect((await options("subtasks-admin-token", "not-a-uuid")).status).toBe(400);
    });
  });
});

describe("team removal and counts with several assignees (#371)", () => {
  const idFor = (n: number) => `79000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const [aId, bId, cId, xId, eId] = [idFor(1), idFor(2), idFor(3), idFor(4), idFor(5)];
  beforeAll(async () => {
    const now = Date.now();
    for (const [id, role] of [[aId, "editor"], [bId, "editor"], [cId, "editor"], [xId, "admin"], [eId, "external_editor"]] as const) await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(id, `t371 ${role} ${id.slice(-2)}`, `${id}@example.test`, role, now, now).run();
    await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES ('t371-external', ?, 't371-external-token', ?, ?, ?)").bind(now + 3_600_000, eId, now, now).run();
  });

  async function seed(members: Array<[string, "editor" | "photographer"]>) {
    const project = crypto.randomUUID(); const now = Date.now(); const cycles = new Map<string, string>();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'T371 Street', 'editing_autohdr', 0, ?, ?)").bind(project, now, now).run();
    for (const [userId, role] of members) { const id = crypto.randomUUID(); cycles.set(`${userId}:${role}`, id); await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, project, userId, role, now).run(); }
    return { project, cycles };
  }
  const subtask = async (project: string, assigneeIds: string[]) => (await (await request(`/api/projects/${project}/subtasks`, "subtasks-admin-token", "POST", { title: "T371", assigneeIds })).json()) as { id: string };
  const relation = async (id: string) => (await database.DB.prepare("SELECT user_id, assignment_version FROM project_subtask_assignees WHERE subtask_id = ? ORDER BY user_id").bind(id).all<{ user_id: string; assignment_version: number }>()).results;
  const versionOf = async (id: string) => (await database.DB.prepare("SELECT assignment_version FROM project_subtasks WHERE id = ?").bind(id).first<{ assignment_version: number }>())!.assignment_version;
  const remove = (project: string, userId: string, cycle: string, clear: boolean, confirmed: number, role = "editors") => request(`/api/projects/${project}/${role}/${userId}`, "subtasks-admin-token", "DELETE", { membershipCycle: cycle, clearSubtaskAssignments: clear, confirmedAssignmentCount: confirmed });

  it("removing one of three assignees from the team removes only them", async () => {
    const { project, cycles } = await seed([[aId, "editor"], [bId, "editor"], [cId, "editor"]]);
    const s = await subtask(project, [aId, bId, cId]);
    const before = await relation(s.id);
    const response = await remove(project, aId, cycles.get(`${aId}:editor`)!, true, 1);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "removed", subtaskAssignmentsCleared: 1 });
    expect(await relation(s.id)).toEqual(before.filter((row) => row.user_id !== aId));
    expect(await versionOf(s.id)).toBe(2);
  });

  it("the confirmation count is per person, and a stale count asks again", async () => {
    const { project, cycles } = await seed([[aId, "editor"], [bId, "editor"]]);
    // B is first on the shared Subtask: the count is over every assignee, not the first.
    const shared = await subtask(project, [bId]); const solo = await subtask(project, [aId]);
    expect((await request(`/api/projects/${project}/subtasks/${shared.id}`, "subtasks-admin-token", "PATCH", { assignees: { expectedVersion: 1, add: [aId], remove: [] } })).status).toBe(200);
    const cycle = cycles.get(`${aId}:editor`)!;
    const first = await remove(project, aId, cycle, false, 0);
    expect(first.status).toBe(422); expect(await first.json()).toMatchObject({ code: "subtask_assignment_confirmation_required", assignmentCount: 2 });
    const stale = await remove(project, aId, cycle, true, 1);
    expect(stale.status).toBe(422); expect(await stale.json()).toMatchObject({ code: "subtask_assignment_confirmation_required", assignmentCount: 2 });
    expect(await relation(shared.id)).toHaveLength(2);
    const ok = await remove(project, aId, cycle, true, 2);
    expect(ok.status).toBe(200); expect(await ok.json()).toMatchObject({ outcome: "removed", subtaskAssignmentsCleared: 2 });
    expect(await relation(shared.id)).toEqual([{ user_id: bId, assignment_version: 1 }]);
    expect(await versionOf(shared.id)).toBe(3);
    expect(await relation(solo.id)).toEqual([]);
    expect(await versionOf(solo.id)).toBe(2);
  });

  it("a person who keeps another role on the Project stays on every Subtask", async () => {
    const { project, cycles } = await seed([[aId, "editor"], [aId, "photographer"], [bId, "editor"]]);
    const s = await subtask(project, [aId, bId]);
    const response = await remove(project, aId, cycles.get(`${aId}:editor`)!, false, 0);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ outcome: "removed", subtaskAssignmentsCleared: 0 });
    expect(await relation(s.id)).toEqual([{ user_id: aId, assignment_version: 1 }, { user_id: bId, assignment_version: 1 }]);
    expect(await versionOf(s.id)).toBe(1);
  });

  it("an active admin removed from the team stays assigned", async () => {
    const { project, cycles } = await seed([[xId, "editor"], [aId, "editor"]]);
    const s = await subtask(project, [xId, aId]);
    const response = await remove(project, xId, cycles.get(`${xId}:editor`)!, false, 0);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ outcome: "removed", subtaskAssignmentsCleared: 0 });
    expect(await relation(s.id)).toEqual([{ user_id: aId, assignment_version: 1 }, { user_id: xId, assignment_version: 1 }]);
  });

  it("team counts are per person on the staff and the external project views", async () => {
    const { project, cycles } = await seed([[aId, "editor"], [bId, "editor"], [cId, "editor"], [eId, "editor"]]);
    // C-free shared Subtask where B is first: A is still counted for it.
    const shared = await subtask(project, [bId]);
    expect((await request(`/api/projects/${project}/subtasks/${shared.id}`, "subtasks-admin-token", "PATCH", { assignees: { expectedVersion: 1, add: [aId], remove: [] } })).status).toBe(200);
    await subtask(project, [aId]);
    const detail = await (await request(`/api/projects/${project}`, "subtasks-admin-token")).json() as { members: Array<{ userId: string; assignedSubtaskCount: number }> };
    const counts = Object.fromEntries(detail.members.map((member) => [member.userId, member.assignedSubtaskCount]));
    expect(counts).toMatchObject({ [aId]: 2, [bId]: 1, [cId]: 0 });
    const external = await request(`/api/projects/${project}/collaboration-summary`, "t371-external-token");
    expect(external.status).toBe(200);
    const summary = await external.json() as { members: Array<{ membershipCycleId: string; assignedSubtaskCount: number }> };
    const byCycle = Object.fromEntries(summary.members.map((member) => [member.membershipCycleId, member.assignedSubtaskCount]));
    expect(byCycle).toMatchObject({ [cycles.get(`${aId}:editor`)!]: 2, [cycles.get(`${bId}:editor`)!]: 1, [cycles.get(`${cId}:editor`)!]: 0 });
  });

  for (const xFirst of [false, true]) {
    it(`an admin removed from the team stays assigned but is only counted for an External Editor (${xFirst ? "admin first" : "editor first"})`, async () => {
      const { project, cycles } = await seed([[eId, "editor"], [xId, "editor"]]);
      // Different versions fix the order: the first id is created first, the second is added after.
      const [first, second] = xFirst ? [xId, eId] : [eId, xId];
      const s = await subtask(project, [first]);
      expect((await request(`/api/projects/${project}/subtasks/${s.id}`, "subtasks-admin-token", "PATCH", { assignees: { expectedVersion: 1, add: [second], remove: [] } })).status).toBe(200);
      const removed = await remove(project, xId, cycles.get(`${xId}:editor`)!, false, 0);
      expect(removed.status).toBe(200);
      expect((await relation(s.id)).map((row) => row.user_id).sort()).toEqual([eId, xId].sort());
      const response = await request(`/api/projects/${project}/subtasks`, "t371-external-token");
      expect(response.status).toBe(200);
      const text = await response.text();
      const found = (JSON.parse(text) as { subtasks: Array<Record<string, unknown> & { id: string }> }).subtasks.find((row) => row.id === s.id)!;
      expect((found.assignees as Array<{ id: string }>).map((person) => person.id)).toEqual([eId]);
      expect(found.otherAssigneeCount).toBe(1);
      expect(text).not.toContain(xId);
      expect(text).not.toContain(`t371 admin ${xId.slice(-2)}`);
    });
  }

  it("another assignee's pending assignment notice still matches the relation after the removal", async () => {
    const { project, cycles } = await seed([[aId, "editor"], [bId, "editor"]]);
    const s = await subtask(project, [aId, bId]);
    const pending = (id: string) => database.DB.prepare("SELECT status, json_extract(payload_json, '$.assignment.assignmentVersion') AS version FROM notification_outbox WHERE event_type = 'project.subtask.assigned' AND recipient_id = ? AND json_extract(payload_json, '$.assignment.subtaskId') = ?").bind(id, s.id).first<{ status: string; version: number }>();
    const notice = await pending(bId);
    expect(notice).toMatchObject({ version: 1 });
    expect((await remove(project, aId, cycles.get(`${aId}:editor`)!, true, 1)).status).toBe(200);
    expect(await pending(bId)).toEqual(notice);
    // The delivery guard's predicate: the recipient's relation row still carries the noticed version.
    expect(await relation(s.id)).toEqual([{ user_id: bId, assignment_version: notice!.version }]);
  });
});
