import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import type { Context } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  EXTERNAL_API_RESPONSE_SCHEMAS,
  adminProductionCalendarRangeResponseSchema,
  editorProductionCalendarRangeResponseSchema,
  externalCalendarRangeSchema,
  resolveSydneyCivilMinute,
} from "@quincy/shared";
import { createAuth } from "../src/auth";
import type { AppEnv, Env } from "../src/env";
import { productionCalendarFacetsSql, productionCalendarHandler, productionCalendarRangeSql } from "../src/routes/production-calendar";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminId = "80111111-1111-4111-8111-111111111111";
const editorId = "80222222-2222-4222-8222-222222222222";
const externalId = "80333333-3333-4333-8333-333333333333";
const photographerId = "80444444-4444-4444-8444-444444444444";
const memberProjectId = "80aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const editorOnlyProjectId = "80bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const deliveredProjectId = "80cccccc-cccc-4ccc-8ccc-cccccccccccc";
const archivedProjectId = "80dddddd-dddd-4ddd-8ddd-dddddddddddd";
const notesOnlyProjectId = "80eeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const assigneeOnlyEditorId = "80555555-5555-4555-8555-555555555555";
const assigneeOnlyProjectId = "80fffff0-ffff-4fff-8fff-fffffffffff0";
const legacyProjectId = "80fffff1-ffff-4fff-8fff-fffffffffff1";
const invalidProjectId = "80fffff2-ffff-4fff-8fff-fffffffffff2";
const boundaryProjectId = "80fffff3-ffff-4fff-8fff-fffffffffff3";
const overlapProjectId = "80fffff4-ffff-4fff-8fff-fffffffffff4";
const denseProjectId = "80fffff5-ffff-4fff-8fff-fffffffffff5";
const externalRemovedProjectId = "80fffff6-ffff-4fff-8fff-fffffffffff6";
const externalArchivedProjectId = "80fffff7-ffff-4fff-8fff-fffffffffff7";
const externalUnassignedProjectId = "80fffff8-ffff-4fff-8fff-fffffffffff8";
const foreignProjectId = "80fffff9-ffff-4fff-8fff-fffffffffff9";
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

async function cookie(token: string): Promise<string> {
  const context = await createAuth(baseEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function request(path: string, token: string): Promise<Response> {
  return SELF.fetch(`https://portal.test${path}`, { headers: { cookie: await cookie(token) } });
}

async function adminCalendar(path: string) {
  const response = await request(path, tokens.admin);
  expect(response.status).toBe(200);
  return adminProductionCalendarRangeResponseSchema.parse(await response.json());
}

function instant(localCivil: string) {
  const resolved = resolveSydneyCivilMinute(localCivil, "earlier");
  if (!resolved.ok) throw new Error(`Fixture civil time did not resolve: ${localCivil}`);
  return resolved.value;
}

async function insertUser(id: string, role: string, token: string): Promise<void> {
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(id, `${role} Calendar`, `${id}@calendar.test`, role, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, id, now, now),
  ]);
}

async function insertProject(id: string, street: string, stage: string, extra = "", suburb = ""): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, suburb, stage_key, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, street, suburb || null, stage, extra || null, now, now).run();
}

async function insertMember(projectId: string, userId: string, roleOnProject: "editor" | "photographer"): Promise<void> {
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), projectId, userId, roleOnProject, Date.now()).run();
}

async function insertSubtask(projectId: string, title: string, assigneeId: string | null, schedule: {
  dueDate?: string | null;
  start?: string;
  end?: string;
  startKind?: "date" | "timed";
  endKind?: "date" | "timed";
  version?: number;
} = {}): Promise<string> {
  const id = crypto.randomUUID();
  const start = schedule.startKind === "timed" && schedule.start ? instant(schedule.start) : null;
  const end = schedule.endKind === "timed" && schedule.end ? instant(schedule.end) : null;
  const now = Date.now();
  await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignee_id, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    // TB4D stores the end's civil string in `due_date` for every scheduled state
    // (due_only and range alike — there is no `schedule_end_civil` column). Mirror that
    // here so the range endpoint's schedule-shape validation matches real data.
    .bind(id, projectId, title, Math.floor(Math.random() * 1_000_000), assigneeId, assigneeId ? 1 : 0, schedule.dueDate ?? schedule.end ?? null, schedule.startKind ?? null, schedule.start ?? null, start?.epochMs ?? null, start?.utcOffsetMinutes ?? null, start?.fold ?? null, schedule.endKind ?? null, end?.epochMs ?? null, end?.utcOffsetMinutes ?? null, end?.fold ?? null, schedule.version === undefined ? null : "Australia/Sydney", schedule.version ?? 0, adminId, now, now).run();
  return id;
}

const rangeNoLayers = "start=2026-08-24&end=2026-09-05&date=2026-08-27&sub=month&scope=active";
const range = `${rangeNoLayers}&layers=project,checklist`;
const tokens = { admin: "tb5c-calendar-admin", editor: "tb5c-calendar-editor", external: "tb5c-calendar-external", photographer: "tb5c-calendar-photographer", assigneeOnly: "tb5c-calendar-assignee-only" };

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await insertUser(adminId, "admin", tokens.admin);
  await insertUser(editorId, "editor", tokens.editor);
  await insertUser(externalId, "external_editor", tokens.external);
  await insertUser(photographerId, "photographer", tokens.photographer);
  await insertUser(assigneeOnlyEditorId, "editor", tokens.assigneeOnly);
  await insertProject(memberProjectId, "1 Calendar Street", "editing_autohdr", "", "Calendar Suburb");
  await insertProject(editorOnlyProjectId, "2 Editor Only Street", "edited_review");
  await insertProject(deliveredProjectId, "3 Delivered Street", "delivered");
  await insertProject(archivedProjectId, "4 Archived Street", "editing_autohdr");
  await insertProject(notesOnlyProjectId, "5 Notes Excluded Street", "editing_autohdr", "needle-not-in-calendar-search");
  await database.DB.prepare("UPDATE projects SET deadline_at = ?, deadline_local_civil = '2026-08-27T09:00', deadline_zone = 'Australia/Sydney', deadline_utc_offset_minutes = ?, deadline_fold = 0, deadline_reminder_offsets_json = '[]', deadline_version = 1 WHERE id = ?")
    .bind(instant("2026-08-27T09:00").epochMs, instant("2026-08-27T09:00").utcOffsetMinutes, memberProjectId).run();
  await database.DB.prepare("UPDATE projects SET deadline_at = ?, deadline_local_civil = '2026-08-27T10:00', deadline_zone = 'Australia/Sydney', deadline_utc_offset_minutes = ?, deadline_fold = 0, deadline_reminder_offsets_json = '[]', deadline_version = 1 WHERE id = ?")
    .bind(instant("2026-08-27T10:00").epochMs, instant("2026-08-27T10:00").utcOffsetMinutes, deliveredProjectId).run();
  await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), archivedProjectId).run();
  await insertMember(memberProjectId, externalId, "editor");
  await insertMember(memberProjectId, editorId, "editor");
  await insertMember(memberProjectId, photographerId, "photographer");
  await insertSubtask(memberProjectId, "Date milestone", externalId, { dueDate: "2026-08-27", end: "2026-08-27", endKind: "date", version: 1 });
  await insertSubtask(memberProjectId, "Timed range", externalId, { start: "2026-08-26T09:00", end: "2026-08-27T11:00", startKind: "timed", endKind: "timed", version: 1 });
  await insertSubtask(memberProjectId, "Unassigned checklist", null);
  await insertSubtask(editorOnlyProjectId, "Non-member read-only checklist", null);

  await insertProject(assigneeOnlyProjectId, "6 Assignee Only Street", "editing_autohdr");
  await insertSubtask(assigneeOnlyProjectId, "Assignee without editor membership", assigneeOnlyEditorId, { dueDate: "2026-08-27", end: "2026-08-27", endKind: "date", version: 1 });

  await insertProject(legacyProjectId, "7 Legacy Schedule Street", "editing_autohdr");
  await insertSubtask(legacyProjectId, "Legacy date milestone", null, { dueDate: "2026-08-27" });
  await insertSubtask(legacyProjectId, "Legacy timed milestone", null, { dueDate: "2026-08-27T12:00" });
  await insertSubtask(legacyProjectId, "Legacy bad literal", null, { dueDate: "not-a-date" });
  await insertSubtask(legacyProjectId, "Legacy DST gap", null, { dueDate: "2026-10-04T02:30" });

  await insertProject(invalidProjectId, "8 Invalid Schedule Street", "editing_autohdr");
  const partial = await insertSubtask(invalidProjectId, "Invalid partial metadata", null, { end: "2026-08-27T12:00", endKind: "timed", version: 1 });
  const drift = await insertSubtask(invalidProjectId, "Invalid zone drift", null, { dueDate: "2026-08-27", end: "2026-08-27", endKind: "date", version: 1 });
  const resolution = await insertSubtask(invalidProjectId, "Invalid resolution mismatch", null, { end: "2026-08-27T13:00", endKind: "timed", version: 1 });
  const reversed = await insertSubtask(invalidProjectId, "Invalid reversed range", null, { start: "2026-08-28T12:00", end: "2026-08-27T12:00", startKind: "timed", endKind: "timed", version: 1 });
  await database.DB.prepare("UPDATE project_subtasks SET schedule_zone = NULL WHERE id = ?").bind(partial).run();
  await database.DB.exec("PRAGMA ignore_check_constraints = ON");
  await database.DB.prepare("UPDATE project_subtasks SET schedule_zone = 'UTC' WHERE id = ?").bind(drift).run();
  await database.DB.exec("PRAGMA ignore_check_constraints = OFF");
  await database.DB.prepare("UPDATE project_subtasks SET schedule_end_at = schedule_end_at + 60000 WHERE id = ?").bind(resolution).run();

  await insertProject(boundaryProjectId, "9 Boundary Schedule Street", "editing_autohdr");
  await database.DB.prepare("UPDATE projects SET deadline_at = ?, deadline_local_civil = ?, deadline_zone = 'Australia/Sydney', deadline_utc_offset_minutes = ?, deadline_fold = 0, deadline_reminder_offsets_json = '[]', deadline_version = 1 WHERE id = ?")
    .bind(instant("2026-08-27T00:00").epochMs, "2026-08-27T00:00", instant("2026-08-27T00:00").utcOffsetMinutes, boundaryProjectId).run();
  await insertSubtask(boundaryProjectId, "Boundary timed milestone start", null, { end: "2026-08-27T00:00", endKind: "timed", version: 1 });
  await insertSubtask(boundaryProjectId, "Boundary timed milestone end", null, { end: "2026-08-28T00:00", endKind: "timed", version: 1 });
  await insertSubtask(boundaryProjectId, "Boundary timed milestone inside start", null, { end: "2026-08-27T00:01", endKind: "timed", version: 1 });
  await insertSubtask(boundaryProjectId, "Boundary timed milestone outside start", null, { end: "2026-08-26T23:59", endKind: "timed", version: 1 });
  await insertSubtask(boundaryProjectId, "Boundary timed milestone inside end", null, { end: "2026-08-27T23:59", endKind: "timed", version: 1 });
  await insertSubtask(boundaryProjectId, "Boundary timed milestone outside end", null, { end: "2026-08-28T00:01", endKind: "timed", version: 1 });
  await insertSubtask(boundaryProjectId, "Boundary timed range start", null, { start: "2026-08-27T00:00", end: "2026-08-27T01:00", startKind: "timed", endKind: "timed", version: 1 });
  await insertSubtask(boundaryProjectId, "Boundary timed range end", null, { start: "2026-08-28T00:00", end: "2026-08-28T01:00", startKind: "timed", endKind: "timed", version: 1 });
  await insertSubtask(boundaryProjectId, "Boundary timed range inside start", null, { start: "2026-08-27T00:01", end: "2026-08-27T01:00", startKind: "timed", endKind: "timed", version: 1 });
  await insertSubtask(boundaryProjectId, "Boundary timed range outside start", null, { start: "2026-08-26T23:00", end: "2026-08-27T00:00", startKind: "timed", endKind: "timed", version: 1 });
  await insertSubtask(boundaryProjectId, "Boundary timed range inside end", null, { start: "2026-08-27T23:59", end: "2026-08-28T01:00", startKind: "timed", endKind: "timed", version: 1 });
  await insertSubtask(boundaryProjectId, "Boundary timed range outside end", null, { start: "2026-08-28T00:01", end: "2026-08-28T01:00", startKind: "timed", endKind: "timed", version: 1 });
  await insertSubtask(boundaryProjectId, "Boundary date milestone start", null, { end: "2026-08-27", endKind: "date", version: 1 });
  await insertSubtask(boundaryProjectId, "Boundary date milestone end", null, { end: "2026-08-28", endKind: "date", version: 1 });
  await insertSubtask(boundaryProjectId, "Boundary date range start", null, { start: "2026-08-26", end: "2026-08-27", startKind: "date", endKind: "date", version: 1 });
  await insertSubtask(boundaryProjectId, "Boundary date range end", null, { start: "2026-08-28", end: "2026-08-29", startKind: "date", endKind: "date", version: 1 });
  for (const [street, civil] of [
    ["Deadline Boundary Start", "2026-08-27T00:00"],
    ["Deadline Boundary End", "2026-08-28T00:00"],
    ["Deadline Boundary Inside Start", "2026-08-27T00:01"],
    ["Deadline Boundary Outside Start", "2026-08-26T23:59"],
    ["Deadline Boundary Inside End", "2026-08-27T23:59"],
    ["Deadline Boundary Outside End", "2026-08-28T00:01"],
  ] as const) {
    const id = crypto.randomUUID();
    await insertProject(id, street, "editing_autohdr");
    await database.DB.prepare("UPDATE projects SET deadline_at = ?, deadline_local_civil = ?, deadline_zone = 'Australia/Sydney', deadline_utc_offset_minutes = ?, deadline_fold = 0, deadline_reminder_offsets_json = '[]', deadline_version = 1 WHERE id = ?")
      .bind(instant(civil).epochMs, civil, instant(civil).utcOffsetMinutes, id).run();
  }

  await insertProject(overlapProjectId, "10 Overlap Schedule Street", "editing_autohdr");
  await insertSubtask(overlapProjectId, "Overlap first", editorId, { start: "2026-08-27T09:00", end: "2026-08-27T11:00", startKind: "timed", endKind: "timed", version: 1 });
  await insertSubtask(overlapProjectId, "Overlap second", editorId, { start: "2026-08-27T10:00", end: "2026-08-27T12:00", startKind: "timed", endKind: "timed", version: 1 });
  const touching = await insertSubtask(overlapProjectId, "Overlap touching", editorId, { start: "2026-08-27T12:00", end: "2026-08-27T13:00", startKind: "timed", endKind: "timed", version: 1 });
  const completed = await insertSubtask(overlapProjectId, "Overlap completed", editorId, { start: "2026-08-27T10:30", end: "2026-08-27T11:30", startKind: "timed", endKind: "timed", version: 1 });
  await database.DB.prepare("UPDATE project_subtasks SET done = 1 WHERE id = ?").bind(completed).run();
  await insertSubtask(overlapProjectId, "Overlap due only", editorId, { end: "2026-08-27T14:00", endKind: "timed", version: 1 });
  await insertSubtask(overlapProjectId, "Overlap date only", editorId, { start: "2026-08-27", end: "2026-08-28", startKind: "date", endKind: "date", version: 1 });
  await insertSubtask(overlapProjectId, "Overlap unassigned", null, { start: "2026-08-27T10:00", end: "2026-08-27T12:00", startKind: "timed", endKind: "timed", version: 1 });

  await insertProject(externalRemovedProjectId, "11 External Removed Street", "editing_autohdr");
  await insertMember(externalRemovedProjectId, externalId, "editor");
  await insertSubtask(externalRemovedProjectId, "Removed assignment checklist", externalId, { end: "2026-08-27T12:00", endKind: "timed", version: 1 });
  await insertProject(externalArchivedProjectId, "12 External Archived Street", "editing_autohdr");
  await insertMember(externalArchivedProjectId, externalId, "editor");
  await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), externalArchivedProjectId).run();
  await insertProject(externalUnassignedProjectId, "13 External Unassigned Street", "editing_autohdr");
  await insertProject(foreignProjectId, "14 Foreign Project Street", "editing_autohdr");
  await insertUser("80666666-6666-4666-8666-666666666666", "editor", "tb5c-calendar-foreign");
  await insertMember(foreignProjectId, "80666666-6666-4666-8666-666666666666", "editor");
  await insertSubtask(foreignProjectId, "Foreign checklist", "80666666-6666-4666-8666-666666666666", { end: "2026-08-27T12:00", endKind: "timed", version: 1 });

  for (let i = 0; i < 51; i += 1) {
    await insertProject(crypto.randomUUID(), `Truncation Project ${String(i).padStart(2, "0")}`, "editing_autohdr");
  }
  const truncationChecklistProjectId = crypto.randomUUID();
  await insertProject(truncationChecklistProjectId, "Truncation Checklist Host", "editing_autohdr");
  for (let i = 0; i < 51; i += 1) {
    await insertSubtask(truncationChecklistProjectId, `Truncation Checklist ${String(i).padStart(2, "0")}`, null);
  }

  await insertProject(denseProjectId, "15 Density Street", "editing_autohdr");
  // Every dense row is done=1 so it is excluded from the default (completed=0) candidate set —
  // only the density test, which passes completed=1, pulls these 10,001 rows into scope.
  await database.DB.exec(`WITH digits(n) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)), numbers(n) AS (SELECT a.n * 1000 + b.n * 100 + c.n * 10 + d.n + 1 FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d WHERE a.n * 1000 + b.n * 100 + c.n * 10 + d.n < 10000 UNION ALL SELECT 10001) INSERT INTO project_subtasks (id, project_id, title, done, position, assignee_id, assignment_version, due_date, schedule_end_kind, schedule_zone, schedule_version, created_by, created_at, updated_at) SELECT printf('90000000-0000-4000-8000-%012d', n), '${denseProjectId}', printf('Dense checklist %05d', n), 1, n, NULL, 0, '2030-01-01', 'date', 'Australia/Sydney', 1, '${adminId}', 0, 0 FROM numbers`);
});

describe("TB5C production Calendar range endpoint", () => {
  it("fails closed for unauthenticated and Photographer principals, and both route forms are equivalent", async () => {
    const unauthenticated = await SELF.fetch(`https://portal.test/api/production-calendar?${range}`);
    expect(unauthenticated.status).toBe(401);
    const photographer = await request(`/api/production-calendar?${range}`, tokens.photographer);
    expect(photographer.status).toBe(403);
    await expect(request(`/api/production-calendar?${range}`, tokens.admin)).resolves.toMatchObject({ status: 200 });
    const bare = await (await request(`/api/production-calendar?${range}`, tokens.external)).json();
    const trailing = await (await request(`/api/production-calendar/?${range}`, tokens.external)).json();
    expect(trailing).toEqual(bare);
    externalCalendarRangeSchema.parse(bare);
  });

  it("returns role-safe strict projections and principal-specific checklist permissions", async () => {
    const admin = adminProductionCalendarRangeResponseSchema.parse(await (await request(`/api/production-calendar?${range}`, tokens.admin)).json());
    const editor = editorProductionCalendarRangeResponseSchema.parse(await (await request(`/api/production-calendar?${range}`, tokens.editor)).json());
    const external = EXTERNAL_API_RESPONSE_SCHEMAS.calendar.parse(await (await request(`/api/production-calendar?${range}`, tokens.external)).json());
    expect(admin.events.find((event) => event.kind === "project_deadline")?.project.stageKey).toBe("editing_autohdr");
    expect(editor.events.find((event) => event.kind === "project_deadline")?.project.stageKey).toBe("editing");
    expect(external.events.find((event) => event.kind === "project_deadline")?.project.stageKey).toBe("editing");
    const editorChecklist = editor.events.find((event) => event.kind === "checklist" && event.title === "Timed range");
    expect(editorChecklist?.permissions.canDrag).toBe(true);
    const nonMember = editor.unscheduled.find((entry) => entry.kind === "checklist" && entry.title === "Non-member read-only checklist");
    expect(nonMember?.permissions.canDrag).toBe(false);
    expect(external.unscheduled.some((entry) => entry.kind === "checklist" && entry.title === "Unassigned checklist")).toBe(true);
    expect(external.events.find((event) => event.kind === "project_deadline")?.permissions.canDrag).toBe(false);
  });

  it("uses exactly two bounded Calendar reads and never performs a project fan-out", async () => {
    const url = `https://portal.test/api/production-calendar?${range}`;
    const allStatements: string[] = [];
    const fakeDb = {
      prepare(sql: string) {
        return {
          bind() {
            return { all: async () => { allStatements.push(sql); return { results: [] }; } };
          },
        };
      },
    };
    const context = {
      req: { url, query: () => Object.fromEntries(new URL(url).searchParams.entries()) },
      env: { DB: fakeDb },
      get: (key: string) => key === "user" ? { id: adminId, role: "admin" } : undefined,
      json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    } as unknown as Context<AppEnv>;
    const response = await productionCalendarHandler(context);
    expect(response.status).toBe(200);
    expect(allStatements).toHaveLength(2);
    expect(allStatements.every((sql) => sql.includes("authorized_projects_base"))).toBe(true);
  });

  it("refuses a dense scheduled stream before the facet read", async () => {
    const url = `https://portal.test/api/production-calendar?${range}`;
    let allCalls = 0;
    const fakeDb = {
      prepare() {
        return {
          bind() {
            return { all: async () => { allCalls += 1; return { results: [{ row_kind: "density", scheduled_total: 10_001 }] }; } };
          },
        };
      },
    };
    const context = {
      req: { url, query: () => Object.fromEntries(new URL(url).searchParams.entries()) },
      env: { DB: fakeDb },
      get: (key: string) => key === "user" ? { id: adminId, role: "admin" } : undefined,
      json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    } as unknown as Context<AppEnv>;
    const response = await productionCalendarHandler(context);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "calendar_range_too_dense", count: 10_001, max: 10_000 });
    expect(allCalls).toBe(1);
  });

  it("applies bounded literal filters and expands presentation editing only inside SQL", async () => {
    const filtered = await request(`/api/production-calendar?${range}&stages=editing&q=Calendar`, tokens.external);
    expect(filtered.status).toBe(200);
    const body = externalCalendarRangeSchema.parse(await filtered.json());
    expect(body.range.appliedFilters.stageKeys).toEqual(["editing"]);
    expect(body.events.every((event) => event.project.stageKey === "editing")).toBe(true);
    const notesOnly = await request(`/api/production-calendar?${range}&q=needle-not-in-calendar-search`, tokens.admin);
    expect(notesOnly.status).toBe(200);
    expect((await adminProductionCalendarRangeResponseSchema.parse(await notesOnly.json())).events).toHaveLength(0);
    const suburb = await request(`/api/production-calendar?${range}&q=Calendar%20Suburb`, tokens.admin);
    expect(suburb.status).toBe(200);
    expect(adminProductionCalendarRangeResponseSchema.parse(await suburb.json()).events.length).toBeGreaterThan(0);
    for (const role of ["admin", "editor", "external"] as const) {
      const rejected = await request(`/api/production-calendar?${range}&stages=editing_autohdr`, tokens[role]);
      expect(rejected.status).toBe(400);
      await expect(rejected.json()).resolves.toMatchObject({ code: "calendar_query_invalid" });
    }
  });

  it("rejects oversized filters before the range statements and accepts 50 editors plus a multibyte search", async () => {
    const editors = Array.from({ length: 51 }, () => crypto.randomUUID()).join(",");
    const tooLarge = await request(`/api/production-calendar?${range}&editors=${editors}`, tokens.admin);
    expect(tooLarge.status).toBe(400);
    await expect(tooLarge.json()).resolves.toMatchObject({ code: "calendar_query_too_large" });
    const fifty = Array.from({ length: 50 }, () => crypto.randomUUID()).join(",");
    const unicodeSearch = "界".repeat(200);
    const accepted = await request(`/api/production-calendar?${range}&editors=${fifty}&q=${encodeURIComponent(unicodeSearch)}`, tokens.admin);
    expect(accepted.status).toBe(200);
    adminProductionCalendarRangeResponseSchema.parse(await accepted.json());
    expect(productionCalendarRangeSql("admin").match(/json_each\(\?8\)/g)).toHaveLength(1);
    expect(productionCalendarRangeSql("admin").match(/json_each\(\?9\)/g)).toHaveLength(1);
    expect(productionCalendarRangeSql("admin")).not.toMatch(/\bLIKE\b|IN\s*\(\s*\?|valid_schedule_shapes|ROW_NUMBER\s*\(/iu);
    expect(productionCalendarFacetsSql("external_editor")).not.toMatch(/\bLIKE\b|IN\s*\(\s*\?|valid_schedule_shapes|ROW_NUMBER\s*\(/iu);
  });

  it("keeps the External DTO a strict privacy boundary", async () => {
    const body = externalCalendarRangeSchema.parse(await (await request(`/api/production-calendar?${range}`, tokens.external)).json());
    const event = body.events[0];
    expect(event).toBeDefined();
    if (event) {
      expect(externalCalendarRangeSchema.safeParse({ ...body, events: [{ ...event, email: "private@example.test" }] }).success).toBe(false);
      expect(externalCalendarRangeSchema.safeParse({ ...body, events: [{ ...event, provider: "internal" }] }).success).toBe(false);
      expect(externalCalendarRangeSchema.safeParse({ ...body, events: [{ ...event, boardPosition: 1 }] }).success).toBe(false);
      expect(externalCalendarRangeSchema.safeParse({ ...body, events: [{ ...event, project: { ...event.project, notes: "private" } }] }).success).toBe(false);
    }
  });

  it("classifies legacy date and timed schedules in the handler and retains unresolved legacy rows", async () => {
    const body = await adminCalendar(`/api/production-calendar?${range}&q=Legacy`);
    const events = body.events.filter((event) => event.kind === "checklist");
    expect(events.map((event) => event.title).sort()).toEqual(["Legacy date milestone", "Legacy timed milestone"]);
    expect(events.every((event) => event.schedule.state === "due_only")).toBe(true);
    const attention = body.unscheduled.filter((entry) => entry.kind === "checklist");
    expect(attention.map((entry) => [entry.title, entry.reason])).toEqual(expect.arrayContaining([
      ["Legacy bad literal", "schedule_needs_attention"],
      ["Legacy DST gap", "schedule_needs_attention"],
    ]));
    expect(attention.filter((entry) => entry.reason === "schedule_needs_attention").every((entry) => entry.attentionReason === "legacy_unresolved" && !entry.permissions.canDrag)).toBe(true);
  });

  it("returns every coarse-corrupt versioned row as invalid repair work", async () => {
    const body = await adminCalendar(`/api/production-calendar?${range}&q=Invalid`);
    const invalid = body.unscheduled.filter((entry) => entry.kind === "checklist");
    expect(invalid).toHaveLength(4);
    expect(invalid.every((entry) => entry.reason === "schedule_needs_attention" && entry.attentionReason === "invalid")).toBe(true);
    expect(invalid.every((entry) => !entry.permissions.canDrag && !entry.permissions.canResize && !entry.permissions.canOpenScheduleEditor && !entry.permissions.canScheduleRange)).toBe(true);
    expect(body.events.some((event) => event.kind === "checklist" && event.title.startsWith("Invalid"))).toBe(false);
  });

  it("uses the exact inclusive/exclusive boundaries for project and checklist schedules", async () => {
    const boundaryRange = "start=2026-08-27&end=2026-08-28&date=2026-08-27&sub=agenda&scope=active&layers=project,checklist&q=Boundary";
    const body = await adminCalendar(`/api/production-calendar?${boundaryRange}`);
    const names = body.events.map((event) => event.title).sort();
    expect(names).toEqual([
      "Boundary date milestone start",
      "Boundary date range start",
      "Boundary timed milestone inside end",
      "Boundary timed milestone inside start",
      "Boundary timed milestone start",
      "Boundary timed range inside end",
      "Boundary timed range inside start",
      "Boundary timed range start",
      "Deadline Boundary Inside End",
      "Deadline Boundary Inside Start",
      "Deadline Boundary Start",
      "9 Boundary Schedule Street",
    ].sort());
    expect(names).not.toEqual(expect.arrayContaining([
      "Boundary date milestone end",
      "Boundary date range end",
      "Boundary timed milestone end",
      "Boundary timed range end",
      "Deadline Boundary End",
      "Deadline Boundary Outside End",
      "Deadline Boundary Outside Start",
    ]));
    const dateRange = body.events.find((event) => event.title === "Boundary date range start");
    expect(dateRange?.kind).toBe("checklist");
    if (dateRange?.kind === "checklist") expect(dateRange.timing).toMatchObject({ allDay: true, start: "2026-08-26", end: "2026-08-28" });
  });

  it("sanitizes inaccessible Editor IDs, keeps partial validity, and applies checklist assignees independently of project membership", async () => {
    const fakeId = "80777777-7777-4777-8777-777777777777";
    const noFilter = await adminCalendar(`/api/production-calendar?${range}&q=Calendar`);
    const allInaccessible = await adminCalendar(`/api/production-calendar?${range}&q=Calendar&editors=${fakeId}`);
    expect(allInaccessible.events).toEqual(noFilter.events);
    expect(allInaccessible.unscheduled).toEqual(noFilter.unscheduled);

    // No ID oracle: a real editor whose only work is out of this q=Calendar scope
    // (assigneeOnlyEditorId, assignee of a subtask on "6 Assignee Only Street") must be
    // indistinguishable from a fabricated UUID — byte-identical response, and identical to
    // the unfiltered result. A caller cannot learn whether an ID names a real person.
    const realOutOfScope = await request(`/api/production-calendar?${range}&q=Calendar&editors=${assigneeOnlyEditorId}`, tokens.admin);
    const fabricated = await request(`/api/production-calendar?${range}&q=Calendar&editors=${fakeId}`, tokens.admin);
    expect(await realOutOfScope.text()).toEqual(await fabricated.text());
    const realOutOfScopeBody = await adminCalendar(`/api/production-calendar?${range}&q=Calendar&editors=${assigneeOnlyEditorId}`);
    expect(realOutOfScopeBody.events).toEqual(noFilter.events);
    expect(realOutOfScopeBody.range.appliedFilters.editorIds).toEqual([]);

    const partial = await adminCalendar(`/api/production-calendar?${range}&q=Calendar&editors=${editorId},${fakeId}`);
    expect(partial.range.appliedFilters.editorIds).toEqual([editorId]);
    expect(JSON.stringify(partial)).not.toContain(fakeId);

    const assigned = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=checklist&q=Assignee%20without%20editor%20membership&editors=${assigneeOnlyEditorId}`);
    expect(assigned.events.map((event) => event.title)).toEqual(["Assignee without editor membership"]);
  });

  it("treats mine as an assignee filter without hiding a checklist on a non-member project", async () => {
    const response = await request(`/api/production-calendar?${rangeNoLayers}&layers=checklist&q=Assignee%20without%20editor%20membership&mine=1`, tokens.assigneeOnly);
    expect(response.status).toBe(200);
    const body = editorProductionCalendarRangeResponseSchema.parse(await response.json());
    expect(body.events.map((event) => event.title)).toEqual(["Assignee without editor membership"]);

    // mine=1 is a checklist-assignee filter only: it must not touch the project-deadline layer
    // (a project has no single assignee). Same query with both layers, with and without mine=1 —
    // the project_deadline event set is identical.
    const withMine = editorProductionCalendarRangeResponseSchema.parse(await (await request(`/api/production-calendar?${range}&q=Calendar&mine=1`, tokens.assigneeOnly)).json());
    const withoutMine = editorProductionCalendarRangeResponseSchema.parse(await (await request(`/api/production-calendar?${range}&q=Calendar`, tokens.assigneeOnly)).json());
    const deadlineEvents = (r: typeof withMine) => r.events.filter((event) => event.kind === "project_deadline").map((event) => event.id).sort();
    expect(deadlineEvents(withMine)).toEqual(deadlineEvents(withoutMine));
    expect(deadlineEvents(withMine).length).toBeGreaterThan(0);
  });

  it("caps each unscheduled kind in JavaScript with matched counts and deterministic order", async () => {
    const projects = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=project&q=Truncation%20Project`);
    expect(projects.filterFacets.unscheduled.project).toEqual({ matched: 51, returned: 50, truncated: true });
    expect(projects.unscheduled).toHaveLength(50);
    expect(projects.unscheduled[0]?.title).toBe("Truncation Project 00");
    expect(projects.unscheduled.at(-1)?.title).toBe("Truncation Project 49");
    expect(projects.unscheduled.some((entry) => entry.title === "Truncation Project 50")).toBe(false);

    const checklists = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=checklist&q=Truncation%20Checklist`);
    expect(checklists.filterFacets.unscheduled.checklist).toEqual({ matched: 51, returned: 50, truncated: true });
    expect(checklists.unscheduled).toHaveLength(50);
    expect(checklists.unscheduled[0]?.title).toBe("Truncation Checklist 00");
    expect(checklists.unscheduled.at(-1)?.title).toBe("Truncation Checklist 49");
    expect(checklists.unscheduled.some((entry) => entry.title === "Truncation Checklist 50")).toBe(false);
  });

  it("marks only overlapping incomplete timed ranges for the same assignee", async () => {
    const body = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=checklist&q=Overlap&completed=1`);
    const byTitle = new Map(body.events.filter((event) => event.kind === "checklist").map((event) => [event.title, event]));
    expect(byTitle.get("Overlap first")?.status.sameAssigneeOverlap).toBe(true);
    expect(byTitle.get("Overlap second")?.status.sameAssigneeOverlap).toBe(true);
    expect(byTitle.get("Overlap touching")?.status.sameAssigneeOverlap).toBe(false);
    expect(byTitle.get("Overlap completed")?.status.sameAssigneeOverlap).toBe(false);
    expect(byTitle.get("Overlap due only")?.status.sameAssigneeOverlap).toBe(false);
    expect(byTitle.get("Overlap date only")?.status.sameAssigneeOverlap).toBe(false);
    expect(byTitle.get("Overlap unassigned")?.status.sameAssigneeOverlap).toBe(false);
  });

  it("keeps delivered, overdue, completed, layer, Editor-OR, and unassigned filters independent", async () => {
    const delivered = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=project&q=Delivered&delivered=1`);
    expect(delivered.events.some((event) => event.kind === "project_deadline" && event.project.id === deliveredProjectId)).toBe(true);
    const deliveredDefault = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=project&q=Delivered`);
    expect(deliveredDefault.events).toHaveLength(0);

    const completedDefault = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=checklist&q=Overlap%20completed`);
    const completed = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=checklist&q=Overlap%20completed&completed=1`);
    expect(completedDefault.events).toHaveLength(0);
    expect(completed.events.map((event) => event.title)).toEqual(["Overlap completed"]);

    const overdue = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=checklist&q=Date%20milestone&overdue=1`);
    expect(overdue.events.find((event) => event.kind === "checklist")?.status.overdue).toBe(true);

    // overdue_only constrains scheduled events, not the Unscheduled panel: an
    // unscheduled checklist entry has no due date to be "overdue" and must stay
    // visible (matching the project branch, which lets a null-deadline project through).
    const overdueDefault = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=checklist&q=Unassigned%20checklist`);
    expect(overdueDefault.unscheduled.some((entry) => entry.kind === "checklist" && entry.title === "Unassigned checklist")).toBe(true);
    const overdueUnscheduled = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=checklist&q=Unassigned%20checklist&overdue=1`);
    expect(overdueUnscheduled.unscheduled.some((entry) => entry.kind === "checklist" && entry.title === "Unassigned checklist" && entry.reason === "unscheduled")).toBe(true);

    const projectOnly = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=project&q=Calendar`);
    expect(projectOnly.events.every((event) => event.kind === "project_deadline")).toBe(true);
    const checklistOnly = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=checklist&q=Calendar`);
    expect(checklistOnly.events.every((event) => event.kind === "checklist")).toBe(true);

    const selected = await adminCalendar(`/api/production-calendar?${range}&q=Calendar&editors=${editorId}`);
    const withUnassigned = await adminCalendar(`/api/production-calendar?${range}&q=Calendar&editors=${editorId}&unassigned=1`);
    expect(withUnassigned.unscheduled.some((entry) => entry.kind === "checklist" && entry.title === "Unassigned checklist")).toBe(true);
    expect(selected.unscheduled.some((entry) => entry.kind === "checklist" && entry.title === "Unassigned checklist")).toBe(false);
  });

  it("removes an External assignment from the complete calendar projection", async () => {
    await database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(externalRemovedProjectId, externalId).run();
    const body = externalCalendarRangeSchema.parse(await (await request(`/api/production-calendar?${range}&q=External`, tokens.external)).json());
    expect(body.events).toHaveLength(0);
    expect(body.unscheduled).toHaveLength(0);
    expect(body.filterFacets.projects.some((project) => project.id === externalRemovedProjectId || project.id === externalArchivedProjectId || project.id === externalUnassignedProjectId)).toBe(false);
    expect(body.filterFacets.people.some((person) => person.id === "80666666-6666-4666-8666-666666666666")).toBe(false);
  });

  it("honors the inert range flag for event and Unscheduled permissions", async () => {
    vi.resetModules();
    vi.doMock("@quincy/shared", async () => ({ ...(await vi.importActual<typeof import("@quincy/shared")>("@quincy/shared")), CHECKLIST_SCHEDULE_RANGES_ENABLED: false }));
    const { productionCalendarHandler: inertHandler } = await import("../src/routes/production-calendar");
    const url = `https://portal.test/api/production-calendar?${range}&q=Calendar`;
    const context = {
      req: { url, query: () => Object.fromEntries(new URL(url).searchParams.entries()) },
      env: { DB: database.DB },
      get: (key: string) => key === "user" ? { id: externalId, role: "external_editor", active: true } : undefined,
      json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    } as unknown as Context<AppEnv>;
    const body = externalCalendarRangeSchema.parse(await (await inertHandler(context)).json());
    const rangeEvent = body.events.find((event) => event.kind === "checklist" && event.title === "Timed range");
    expect(rangeEvent?.permissions).toMatchObject({ canDrag: false, canResize: false, canScheduleRange: false, canOpenScheduleEditor: true });
    const dueEvent = body.events.find((event) => event.kind === "checklist" && event.title === "Date milestone");
    expect(dueEvent?.permissions).toMatchObject({ canDrag: true, canResize: false, canScheduleRange: false, canOpenScheduleEditor: true });
    const unscheduled = body.unscheduled.find((entry) => entry.kind === "checklist" && entry.title === "Unassigned checklist");
    expect(unscheduled?.permissions).toMatchObject({ canDrag: false, canResize: false, canScheduleRange: false, canOpenScheduleEditor: true });
    vi.doUnmock("@quincy/shared");
    vi.resetModules();
  });

  it("refuses a real 10,001-row scheduled query before executing the facet statement", async () => {
    let allCalls = 0;
    const realDb = database.DB;
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            const statement = realDb.prepare(sql).bind(...values);
            return { all: async <T>() => { allCalls += 1; return statement.all<T>(); } };
          },
        };
      },
    } as unknown as D1Database;
    const url = "https://portal.test/api/production-calendar?start=2030-01-01&end=2030-01-02&date=2030-01-01&sub=agenda&scope=active&layers=checklist&q=Dense&completed=1";
    const context = {
      req: { url, query: () => Object.fromEntries(new URL(url).searchParams.entries()) },
      env: { DB: db },
      get: (key: string) => key === "user" ? { id: adminId, role: "admin", active: true } : undefined,
      json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    } as unknown as Context<AppEnv>;
    const response = await productionCalendarHandler(context);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "calendar_range_too_dense", count: 10_001, max: 10_000 });
    expect(allCalls).toBe(1);
  });
});

/**
 * Query-review record (Slice 4): both statements share the bounded candidate CTE graph and
 * carry one json_each expansion per Editor/Stage list. The reviewed local SQLite plan shows
 * projects_archived_idx / project_members_unique / project_subtasks_project_position_idx
 * searches, materialized authorized_people_base/checklist_counts, and temporary B-trees for
 * UNION/window work. There is deliberately no direct deadline_at, schedule_end_at, or due_date
 * index. Measured against the workerd Workers pool via SELF.fetch on the full migration
 * schema: 1,601 events -> 200 / ~85 ms / 1,284,266 bytes; 7,701 events -> 200 / ~259 ms /
 * 6,176,466 bytes; 10,001 -> 422 / ~16 ms / 213 bytes (statement 2 skipped). The 10,000
 * ceiling is retained; see docs/plans/tb5c/slice-4-query-review.md.
 */
