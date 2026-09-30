import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { scanDueSubtasks } from "../../background/src/notifications";

/**
 * #373 part 1: no code reads or writes `project_subtasks.assignee_id`. The proof is this suite: migration 0050
 * drops the index and the column (applied by the migration loader), then it drives every path that ever touched them over HTTP. Any `no such column: assignee_id`
 * (including a drizzle full-row select, which is a hidden column read) is a 500 and fails a test here.
 */
const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminId = "91111111-1111-4111-8111-111111111111";
const editorId = "92222222-2222-4222-8222-222222222222";
const photographerId = "93333333-3333-4333-8333-333333333333";
const externalId = "94444444-4444-4444-8444-444444444444";
const projectId = "9aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const tokens = { admin: "t373-admin", editor: "t373-editor", photographer: "t373-photographer", external: "t373-external" };
declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;

async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); } }
async function cookie(token: string) { const context = await createAuth(baseEnv).$context; return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`; }
async function request(path: string, token: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", body?: unknown) { const headers = new Headers({ cookie: await cookie(token) }); if (body !== undefined) headers.set("content-type", "application/json"); if (method !== "GET") headers.set("origin", baseEnv.APP_ORIGIN); return workerSelf.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
const range = (from: string, to: string) => ({ state: "range", start: { kind: "date", localCivil: from }, end: { kind: "date", localCivil: to } });
const calendar = "start=2026-08-24&end=2026-09-05&date=2026-08-27&sub=month&scope=active&layers=project,checklist";

type Person = { id: string };
type Item = { id: string; title: string; done: boolean; assignees: Person[]; assignmentVersion: number; otherAssigneeCount?: number; schedule: { version: number } };

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  for (const [id, role] of [[adminId, "admin"], [editorId, "editor"], [photographerId, "photographer"], [externalId, "external_editor"]] as const) {
    await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(id, `${role} ${id.slice(0, 2)}`, `${id}@example.test`, role, now, now).run();
  }
  for (const [key, userId] of [["admin", adminId], ["editor", editorId], ["photographer", photographerId], ["external", externalId]] as const) {
    await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(`t373-${key}`, now + 3_600_000, tokens[key], userId, now, now).run();
  }
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Dropped Column Street', 'editing_autohdr', 0, ?, ?)").bind(projectId, now, now).run();
  for (const [userId, role] of [[editorId, "editor"], [photographerId, "photographer"], [externalId, "editor"]] as const) {
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), projectId, userId, role, now).run();
  }
});

describe("with project_subtasks.assignee_id dropped", () => {
  const base = `/api/projects/${projectId}/subtasks`;
  const item = { id: "" };

  it("the column and its index are really gone", async () => {
    const columns = (await database.DB.prepare("SELECT name FROM pragma_table_info('project_subtasks')").all<{ name: string }>()).results.map((row) => row.name);
    expect(columns).not.toContain("assignee_id");
    expect((await database.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'project_subtasks_assignee_idx'").all()).results).toEqual([]);
  });

  // The retired single-assignee field, in every spelling it ever had, is on no Subtask-shaped response.
  function expectNoSingularAssignee(value: unknown) {
    for (const key of ["assignee", "assigneeId", "assignee_id"]) expect(value).not.toHaveProperty(key);
  }

  it("lists, creates with three assignees, and reads the assignee options", async () => {
    expect((await request(base, tokens.editor)).status).toBe(200);
    const options = await request(`/api/projects/${projectId}/subtask-assignee-options`, tokens.editor);
    expect(options.status).toBe(200);
    expect(Object.keys(await options.json() as object)).toEqual(["candidates"]);
    expect((await request(`/api/projects/${projectId}/subtask-assignee-options`, tokens.external)).status).toBe(200);
    const created = await request(base, tokens.editor, "POST", { title: "Dropped", assigneeIds: [adminId, photographerId, externalId], schedule: range("2026-08-27", "2026-08-28") });
    expect(created.status).toBe(201);
    const body = await created.json() as Item;
    item.id = body.id;
    expect(body.assignmentVersion).toBe(1);
    expect(body.assignees.map((person) => person.id).sort()).toEqual([adminId, photographerId, externalId].sort());
    expectNoSingularAssignee(body);
    const listed = await (await request(base, tokens.editor)).json() as { subtasks: Item[] };
    expect(listed.subtasks.find((row) => row.id === item.id)?.assignees).toHaveLength(3);
    expectNoSingularAssignee(listed.subtasks.find((row) => row.id === item.id));
    const external = await (await request(base, tokens.external)).json() as { subtasks: Item[] };
    const seen = external.subtasks.find((row) => row.id === item.id)!;
    expect(seen.assignees.map((person) => person.id).sort()).toEqual([photographerId, externalId].sort());
    expect(seen.otherAssigneeCount).toBe(1);
    expectNoSingularAssignee(seen);
  });

  it("adds and removes an assignee, as staff and as an External Editor", async () => {
    const added = await request(`${base}/${item.id}`, tokens.editor, "PATCH", { assignees: { expectedVersion: 1, add: [editorId], remove: [photographerId] } });
    expect(added.status).toBe(200);
    const after = await added.json() as Item;
    expect(after.assignmentVersion).toBe(2);
    expect(after.assignees.map((person) => person.id).sort()).toEqual([adminId, editorId, externalId].sort());
    const externalRemove = await request(`${base}/${item.id}`, tokens.external, "PATCH", { assignees: { expectedVersion: 2, add: [], remove: [editorId] } });
    expect(externalRemove.status).toBe(200);
    expect((await externalRemove.json() as Item).assignmentVersion).toBe(3);
    expect((await database.DB.prepare("SELECT user_id FROM project_subtask_assignees WHERE subtask_id = ? ORDER BY user_id").bind(item.id).all<{ user_id: string }>()).results.map((row) => row.user_id)).toEqual([adminId, externalId]);
  });

  it("toggles done, edits the title, and edits the schedule", async () => {
    const done = await request(`${base}/${item.id}`, tokens.editor, "PATCH", { done: true });
    expect(done.status).toBe(200); expect(await done.json()).toMatchObject({ done: true, assignmentVersion: 3 });
    const renamed = await request(`${base}/${item.id}`, tokens.editor, "PATCH", { title: "Dropped, renamed", done: false });
    expect(renamed.status).toBe(200); expect(await renamed.json()).toMatchObject({ title: "Dropped, renamed", done: false });
    const rescheduled = await request(`${base}/${item.id}`, tokens.editor, "PATCH", { schedule: { expectedVersion: 1, schedule: range("2026-08-27", "2026-08-29") } });
    expect(rescheduled.status).toBe(200); expect(await rescheduled.json()).toMatchObject({ schedule: { version: 2 }, assignmentVersion: 3 });
  });

  it("serves the project detail (team counts) and the external project detail", async () => {
    const detail = await request(`/api/projects/${projectId}`, tokens.admin);
    expect(detail.status).toBe(200);
    const members = (await detail.json() as { members: Array<{ userId: string; assignedSubtaskCount: number }> }).members;
    expect(members.find((member) => member.userId === externalId)?.assignedSubtaskCount).toBe(1);
    expect((await request(`/api/projects/${projectId}`, tokens.external)).status).toBe(200);
    expect((await request(`/api/projects/${projectId}/collaboration-summary`, tokens.external)).status).toBe(200);
    expect((await request("/api/projects", tokens.external)).status).toBe(200);
  });

  it("serves the Calendar with the editor, unassigned and my-tasks filters", async () => {
    const all = await request(`/api/production-calendar?${calendar}`, tokens.admin);
    expect(all.status).toBe(200);
    const event = (await all.json() as { events: Array<{ kind: string; title: string; assignees?: Person[]; assignee?: unknown }> }).events.find((row) => row.kind === "checklist" && row.title === "Dropped, renamed");
    expect(event?.assignees?.map((person) => person.id).sort()).toEqual([adminId, externalId].sort());
    expectNoSingularAssignee(event);
    const byEditor = await request(`/api/production-calendar?${calendar}&editors=${externalId}`, tokens.admin);
    expect(byEditor.status).toBe(200);
    expect((await request(`/api/production-calendar?${calendar}&unassigned=1`, tokens.admin)).status).toBe(200);
    const mine = await request(`/api/production-calendar?${calendar}&mine=1`, tokens.admin);
    expect(mine.status).toBe(200);
    expect(JSON.stringify(await mine.json())).toContain("Dropped, renamed");
    expect((await request(`/api/production-calendar?${calendar}`, tokens.editor)).status).toBe(200);
    expect((await request(`/api/production-calendar?${calendar}`, tokens.external)).status).toBe(200);
  });

  it("serves the Gantt page and the child page", async () => {
    for (const token of [tokens.admin, tokens.editor, tokens.external]) {
      const page = await request("/api/production-gantt?scope=active", token);
      expect(page.status).toBe(200);
      const child = await request(`/api/production-gantt?scope=active&childrenOf=${projectId}`, token);
      expect(child.status).toBe(200);
      const rows = (await child.json() as { children: { rows: Array<{ title: string; assignees: Person[]; assignee?: unknown }> } }).children.rows;
      const row = rows.find((candidate) => candidate.title === "Dropped, renamed");
      expect(row?.assignees.length).toBeGreaterThan(0);
      expectNoSingularAssignee(row);
    }
  });

  it("lists a per-person assigned notice in the staff and external bell", async () => {
    const now = Date.now();
    for (const [userId, token] of [[externalId, tokens.external], [adminId, tokens.admin]] as const) {
      const outbox = await database.DB.prepare("SELECT id, source_key FROM notification_outbox WHERE event_type = 'project.subtask.assigned' AND recipient_id = ? AND json_extract(payload_json, '$.assignment.subtaskId') = ?").bind(userId, item.id).first<{ id: string; source_key: string }>();
      // The producer wrote this notice from the relation (the actor is the editor, never the assignee).
      expect(outbox).not.toBeNull();
      const notificationId = crypto.randomUUID();
      await database.DB.batch([
        database.DB.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, body, source_key, created_at) VALUES (?, ?, ?, 'subtask_assigned', 'Checklist item assigned', 'Body', ?, ?)").bind(notificationId, userId, projectId, outbox!.source_key, now),
        database.DB.prepare("UPDATE notification_delivery_ledger SET status = 'sent', notification_id = ? WHERE outbox_id = ? AND channel = 'in_app'").bind(notificationId, outbox!.id),
      ]);
      const bell = await request("/api/notifications", token);
      expect(bell.status).toBe(200);
      const list = await bell.json() as { notifications: Array<{ id: string }> };
      // The external bell re-validates against the relation: the external is still an assignee, so the notice shows.
      expect(list.notifications.some((row) => row.id === notificationId)).toBe(true);
    }
  });

  it("runs the due-reminder scan over the relation", async () => {
    const created = await request(base, tokens.editor, "POST", { title: "Due in the dropped world", assigneeIds: [photographerId, externalId], schedule: range("2026-11-02", "2026-11-06") });
    expect(created.status).toBe(201);
    const reminderEnv = { ...baseEnv, DB: database.DB, EMAIL: { send: vi.fn().mockResolvedValue({ messageId: "dropped" }) }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test" } as unknown as Env;
    // Both Subtasks are past due and unclaimed: the earlier one reaches its one staff recipient, this one the photographer.
    expect(await scanDueSubtasks(reminderEnv, Date.UTC(2026, 10, 5, 21))).toBe(2);
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'subtask_due_today' AND project_id = ? AND user_id = ?").bind(projectId, photographerId).first<{ n: number }>())!.n).toBe(1);
    // The External Editor is an assignee of both Subtasks: one due notice each.
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE event_type = 'project.subtask.due_today' AND recipient_id = ?").bind(externalId).first<{ n: number }>())!.n).toBe(2);
  });

  it("removes a person from the team and clears their assignments per person", async () => {
    const cycle = (await database.DB.prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ?").bind(projectId, photographerId).first<{ id: string }>())!.id;
    const probe = await request(`/api/projects/${projectId}/photographers/${photographerId}`, tokens.admin, "DELETE", { membershipCycle: cycle, clearSubtaskAssignments: false, confirmedAssignmentCount: 0 });
    expect(probe.status).toBe(422);
    const count = (await probe.json() as { assignmentCount: number }).assignmentCount;
    expect(count).toBe(1);
    const removed = await request(`/api/projects/${projectId}/photographers/${photographerId}`, tokens.admin, "DELETE", { membershipCycle: cycle, clearSubtaskAssignments: true, confirmedAssignmentCount: count });
    expect(removed.status).toBe(200); expect(await removed.json()).toMatchObject({ outcome: "removed", subtaskAssignmentsCleared: 1 });
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM project_subtask_assignees WHERE user_id = ?").bind(photographerId).first<{ n: number }>())!.n).toBe(0);
  });

  it("deletes a Subtask", async () => {
    expect((await request(`${base}/${item.id}`, tokens.editor, "DELETE")).status).toBe(200);
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM project_subtask_assignees WHERE subtask_id = ?").bind(item.id).first<{ n: number }>())!.n).toBe(0);
    expect((await request(base, tokens.editor)).status).toBe(200);
  });
});
