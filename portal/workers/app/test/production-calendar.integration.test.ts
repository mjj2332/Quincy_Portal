import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import type { Context } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import {
  EXTERNAL_API_RESPONSE_SCHEMAS,
  adminProductionCalendarRangeResponseSchema,
  editorProductionCalendarRangeResponseSchema,
  externalCalendarRangeSchema,
  resolveSydneyCivilMinute,
  subtaskIdFromCalendarEntityId,
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
const boundaryProjectId = "80fffff3-ffff-4fff-8fff-fffffffffff3";
const overlapProjectId = "80fffff4-ffff-4fff-8fff-fffffffffff4";
const denseProjectId = "80fffff5-ffff-4fff-8fff-fffffffffff5";
const externalRemovedProjectId = "80fffff6-ffff-4fff-8fff-fffffffffff6";
const externalArchivedProjectId = "80fffff7-ffff-4fff-8fff-fffffffffff7";
const externalUnassignedProjectId = "80fffff8-ffff-4fff-8fff-fffffffffff8";
const foreignProjectId = "80fffff9-ffff-4fff-8fff-fffffffffff9";
const idContractProjectId = "80fffffa-ffff-4fff-8fff-fffffffffffa";
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

async function patchRequest(path: string, token: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://portal.test${path}`, {
    method: "PATCH",
    headers: { cookie: await cookie(token), "content-type": "application/json", origin: baseEnv.APP_ORIGIN },
    body: JSON.stringify(body),
  });
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

/** Every Subtask is a range (ADR 0011). A missing start defaults to the end's day (date) or an hour before it (timed); no schedule at all is a far-off one-day range outside every window here. */
async function insertSubtask(projectId: string, title: string, assigneeId: string | null, schedule: {
  start?: string;
  end?: string;
  startKind?: "date" | "timed";
  endKind?: "date" | "timed";
} = {}): Promise<string> {
  const id = crypto.randomUUID();
  const endKind = schedule.endKind ?? "date";
  const endCivil = schedule.end ?? "2027-03-01";
  const startKind = schedule.startKind ?? endKind;
  const start = startKind === "timed" ? instant(schedule.start ?? oneHourBefore(endCivil)) : null;
  const end = endKind === "timed" ? instant(endCivil) : null;
  const now = Date.now();
  await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignee_id, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    // The end's civil string is stored in `due_date` (there is no `schedule_end_civil` column).
    .bind(id, projectId, title, Math.floor(Math.random() * 1_000_000), assigneeId, assigneeId ? 1 : 0, endCivil, startKind, schedule.start ?? (startKind === "timed" ? oneHourBefore(endCivil) : endCivil), start?.epochMs ?? null, start?.utcOffsetMinutes ?? null, start?.fold ?? null, endKind, end?.epochMs ?? null, end?.utcOffsetMinutes ?? null, end?.fold ?? null, "Australia/Sydney", 1, adminId, now, now).run();
  return id;
}

function oneHourBefore(civilMinute: string): string {
  const shifted = new Date(`${civilMinute}:00Z`);
  shifted.setUTCHours(shifted.getUTCHours() - 1);
  return shifted.toISOString().slice(0, 16);
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
  await insertSubtask(memberProjectId, "One-day date range", externalId, { end: "2026-08-27", endKind: "date" });
  await insertSubtask(memberProjectId, "Timed range", externalId, { start: "2026-08-26T09:00", end: "2026-08-27T11:00", startKind: "timed", endKind: "timed" });
  await insertSubtask(memberProjectId, "Unassigned checklist", null, { end: "2026-08-27", endKind: "date" });
  await insertSubtask(editorOnlyProjectId, "Non-member read-only checklist", null, { end: "2026-08-27", endKind: "date" });

  await insertProject(assigneeOnlyProjectId, "6 Assignee Only Street", "editing_autohdr");
  await insertSubtask(assigneeOnlyProjectId, "Assignee without editor membership", assigneeOnlyEditorId, { end: "2026-08-27", endKind: "date" });

  await insertProject(boundaryProjectId, "9 Boundary Schedule Street", "editing_autohdr");
  await database.DB.prepare("UPDATE projects SET deadline_at = ?, deadline_local_civil = ?, deadline_zone = 'Australia/Sydney', deadline_utc_offset_minutes = ?, deadline_fold = 0, deadline_reminder_offsets_json = '[]', deadline_version = 1 WHERE id = ?")
    .bind(instant("2026-08-27T00:00").epochMs, "2026-08-27T00:00", instant("2026-08-27T00:00").utcOffsetMinutes, boundaryProjectId).run();
  await insertSubtask(boundaryProjectId, "Boundary timed range start", null, { start: "2026-08-27T00:00", end: "2026-08-27T01:00", startKind: "timed", endKind: "timed" });
  await insertSubtask(boundaryProjectId, "Boundary timed range end", null, { start: "2026-08-28T00:00", end: "2026-08-28T01:00", startKind: "timed", endKind: "timed" });
  await insertSubtask(boundaryProjectId, "Boundary timed range inside start", null, { start: "2026-08-27T00:01", end: "2026-08-27T01:00", startKind: "timed", endKind: "timed" });
  await insertSubtask(boundaryProjectId, "Boundary timed range outside start", null, { start: "2026-08-26T23:00", end: "2026-08-27T00:00", startKind: "timed", endKind: "timed" });
  await insertSubtask(boundaryProjectId, "Boundary timed range inside end", null, { start: "2026-08-27T23:59", end: "2026-08-28T01:00", startKind: "timed", endKind: "timed" });
  await insertSubtask(boundaryProjectId, "Boundary timed range outside end", null, { start: "2026-08-28T00:01", end: "2026-08-28T01:00", startKind: "timed", endKind: "timed" });
  await insertSubtask(boundaryProjectId, "Boundary date milestone start", null, { end: "2026-08-27", endKind: "date" });
  await insertSubtask(boundaryProjectId, "Boundary date milestone end", null, { end: "2026-08-28", endKind: "date" });
  await insertSubtask(boundaryProjectId, "Boundary date range start", null, { start: "2026-08-26", end: "2026-08-27", startKind: "date", endKind: "date" });
  await insertSubtask(boundaryProjectId, "Boundary date range end", null, { start: "2026-08-28", end: "2026-08-29", startKind: "date", endKind: "date" });
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
  await insertSubtask(overlapProjectId, "Overlap first", editorId, { start: "2026-08-27T09:00", end: "2026-08-27T11:00", startKind: "timed", endKind: "timed" });
  await insertSubtask(overlapProjectId, "Overlap second", editorId, { start: "2026-08-27T10:00", end: "2026-08-27T12:00", startKind: "timed", endKind: "timed" });
  const touching = await insertSubtask(overlapProjectId, "Overlap touching", editorId, { start: "2026-08-27T12:00", end: "2026-08-27T13:00", startKind: "timed", endKind: "timed" });
  const completed = await insertSubtask(overlapProjectId, "Overlap completed", editorId, { start: "2026-08-27T10:30", end: "2026-08-27T11:30", startKind: "timed", endKind: "timed" });
  await database.DB.prepare("UPDATE project_subtasks SET done = 1 WHERE id = ?").bind(completed).run();
  await insertSubtask(overlapProjectId, "Overlap date only", editorId, { start: "2026-08-27", end: "2026-08-28", startKind: "date", endKind: "date" });
  await insertSubtask(overlapProjectId, "Overlap unassigned", null, { start: "2026-08-27T10:00", end: "2026-08-27T12:00", startKind: "timed", endKind: "timed" });

  await insertProject(externalRemovedProjectId, "11 External Removed Street", "editing_autohdr");
  await insertMember(externalRemovedProjectId, externalId, "editor");
  await insertSubtask(externalRemovedProjectId, "Removed assignment checklist", externalId, { end: "2026-08-27T12:00", endKind: "timed" });
  await insertProject(externalArchivedProjectId, "12 External Archived Street", "editing_autohdr");
  await insertMember(externalArchivedProjectId, externalId, "editor");
  await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), externalArchivedProjectId).run();
  await insertProject(externalUnassignedProjectId, "13 External Unassigned Street", "editing_autohdr");
  await insertProject(foreignProjectId, "14 Foreign Project Street", "editing_autohdr");
  await insertUser("80666666-6666-4666-8666-666666666666", "editor", "tb5c-calendar-foreign");
  await insertMember(foreignProjectId, "80666666-6666-4666-8666-666666666666", "editor");
  await insertSubtask(foreignProjectId, "Foreign checklist", "80666666-6666-4666-8666-666666666666", { end: "2026-08-27T12:00", endKind: "timed" });

  await insertProject(idContractProjectId, "16 Id Contract Street", "editing_autohdr");
  await insertSubtask(idContractProjectId, "Id contract scheduled checklist", null, { end: "2026-08-27", endKind: "date" });

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
    const nonMember = editor.events.find((entry) => entry.kind === "checklist" && entry.title === "Non-member read-only checklist");
    expect(nonMember?.permissions.canDrag).toBe(false);
    expect(external.events.some((entry) => entry.kind === "checklist" && entry.title === "Unassigned checklist")).toBe(true);
    expect(external.events.find((event) => event.kind === "project_deadline")?.permissions.canDrag).toBe(false);
  });

  it("has no Unscheduled surface (ADR 0011): no `unscheduled` list, no facet counts, and a deadline-less Project with nothing in range is absent", async () => {
    const raw = await (await request(`/api/production-calendar?${range}&bounds=1`, tokens.admin)).json() as { unscheduled?: unknown; filterFacets: Record<string, unknown>; events: Array<{ project: { id: string } }>; projectBounds: Array<{ projectId: string }> };
    expect(raw).not.toHaveProperty("unscheduled");
    expect(raw.filterFacets).not.toHaveProperty("unscheduled");
    const referenced = new Set(raw.events.map((event) => event.project.id));
    expect(referenced.has(externalUnassignedProjectId)).toBe(false);
    expect(new Set(raw.projectBounds.map((bound) => bound.projectId))).toEqual(referenced);
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

  it("uses the exact inclusive/exclusive boundaries for project and checklist schedules", async () => {
    const boundaryRange = "start=2026-08-27&end=2026-08-28&date=2026-08-27&sub=agenda&scope=active&layers=project,checklist&q=Boundary";
    const body = await adminCalendar(`/api/production-calendar?${boundaryRange}`);
    const names = body.events.map((event) => event.title).sort();
    expect(names).toEqual([
      "Boundary date milestone start",
      "Boundary date range start",
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
      "Boundary timed range end",
      "Deadline Boundary End",
      "Deadline Boundary Outside End",
      "Deadline Boundary Outside Start",
    ]));
    const dateRange = body.events.find((event) => event.title === "Boundary date range start");
    expect(dateRange?.kind).toBe("checklist");
    if (dateRange?.kind === "checklist") expect(dateRange.timing).toMatchObject({ allDay: true, start: "2026-08-26", end: "2026-08-28" });
  });

  it("#222: serves the day and days subviews over the same bounded window and echoes them back", async () => {
    const dayRange = "start=2026-08-27&end=2026-08-28&date=2026-08-27&sub=day&scope=active&layers=project,checklist&q=Boundary";
    const day = await adminCalendar(`/api/production-calendar?${dayRange}`);
    expect(day.range).toMatchObject({ start: "2026-08-27", end: "2026-08-28", date: "2026-08-27", subview: "day" });
    // a day window returns exactly what the same one-day agenda window returns
    const agenda = await adminCalendar(`/api/production-calendar?${dayRange.replace("sub=day", "sub=agenda")}`);
    expect(day.events.map((event) => event.id).sort()).toEqual(agenda.events.map((event) => event.id).sort());

    const days = await adminCalendar("/api/production-calendar?start=2026-08-27&end=2026-08-30&date=2026-08-27&sub=days&scope=active&layers=project,checklist");
    expect(days.range.subview).toBe("days");

    const unknown = await request("/api/production-calendar?start=2026-08-27&end=2026-08-28&date=2026-08-27&sub=year&scope=active&layers=project", tokens.admin);
    expect(unknown.status).toBe(400);
  });

  it("#222: bounds=1 adds access-scoped project bounds; without it the key is absent", async () => {
    await database.DB.prepare("UPDATE projects SET shoot_date = '2026-08-20' WHERE id = ?").bind(memberProjectId).run();
    await database.DB.prepare("UPDATE projects SET shoot_date = 'Tuesday arvo' WHERE id = ?").bind(editorOnlyProjectId).run();
    // #288: known creation instants, emitted as ISO (the Calendar's created-at lower-bound fallback)
    await database.DB.prepare("UPDATE projects SET created_at = ? WHERE id = ?").bind(Date.UTC(2026, 6, 1, 2, 3, 4, 567), memberProjectId).run();
    await database.DB.prepare("UPDATE projects SET created_at = ? WHERE id = ?").bind(Date.UTC(2026, 7, 11, 14, 0, 0, 0), editorOnlyProjectId).run();
    const referenced = (body: { events: Array<{ project: { id: string } }> }) =>
      new Set(body.events.map((item) => item.project.id));

    // Without the param (every old bundle): the key is absent from the JSON, not merely undefined.
    const plain = await (await request(`/api/production-calendar?${range}`, tokens.admin)).json() as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(plain, "projectBounds")).toBe(false);

    const admin = await adminCalendar(`/api/production-calendar?${range}&bounds=1`);
    expect(admin.projectBounds).toBeDefined();
    const adminIds = referenced(admin);
    expect(admin.projectBounds!.every((bound) => adminIds.has(bound.projectId))).toBe(true);
    expect(new Set(admin.projectBounds!.map((bound) => bound.projectId))).toEqual(adminIds);
    expect(admin.projectBounds!.find((bound) => bound.projectId === memberProjectId)).toEqual({ projectId: memberProjectId, shootDate: "2026-08-20", createdAt: "2026-07-01T02:03:04.567Z", deadlineLocalCivil: "2026-08-27T09:00" });
    // a non-canonical free-text shoot date is not a bound; a project with no deadline has none
    expect(admin.projectBounds!.find((bound) => bound.projectId === editorOnlyProjectId)).toEqual({ projectId: editorOnlyProjectId, shootDate: null, createdAt: "2026-08-11T14:00:00.000Z", deadlineLocalCivil: null });
    // the rest of the response is unchanged by the param
    expect({ ...admin, projectBounds: undefined }).toEqual({ ...adminProductionCalendarRangeResponseSchema.parse(plain), projectBounds: undefined });

    // External: only projects already in the External response
    const external = EXTERNAL_API_RESPONSE_SCHEMAS.calendar.parse(await (await request(`/api/production-calendar?${range}&bounds=1`, tokens.external)).json());
    const externalIds = referenced(external);
    expect(external.projectBounds!.length).toBeGreaterThan(0);
    expect(external.projectBounds!.every((bound) => externalIds.has(bound.projectId))).toBe(true);
    expect(external.projectBounds!.some((bound) => bound.projectId === editorOnlyProjectId)).toBe(false);

    for (const bad of ["bounds=0", "bounds=true", "bounds=", "bounds=1&bounds=1"]) {
      const response = await request(`/api/production-calendar?${range}&${bad}`, tokens.admin);
      expect(response.status, bad).toBe(400);
    }
  });

  it("#222: bounds=1 adds exactly one more read, access-scoped like the other two", async () => {
    const url = `https://portal.test/api/production-calendar?${range}&bounds=1`;
    const allStatements: string[] = [];
    const fakeDb = { prepare(sql: string) { return { bind() { return { all: async () => { allStatements.push(sql); return { results: [] }; } }; } }; } };
    const context = {
      req: { url, query: () => Object.fromEntries(new URL(url).searchParams.entries()) },
      env: { DB: fakeDb },
      get: (key: string) => key === "user" ? { id: adminId, role: "admin" } : undefined,
      json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    } as unknown as Context<AppEnv>;
    const response = await productionCalendarHandler(context);
    expect(response.status).toBe(200);
    expect(allStatements).toHaveLength(3);
    expect(allStatements.every((sql) => sql.includes("authorized_projects_base"))).toBe(true);
    expect(await response.json()).toMatchObject({ projectBounds: [] });
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

  it("marks only overlapping incomplete timed ranges for the same assignee", async () => {
    const body = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=checklist&q=Overlap&completed=1`);
    const byTitle = new Map(body.events.filter((event) => event.kind === "checklist").map((event) => [event.title, event]));
    expect(byTitle.get("Overlap first")?.status.sameAssigneeOverlap).toBe(true);
    expect(byTitle.get("Overlap second")?.status.sameAssigneeOverlap).toBe(true);
    expect(byTitle.get("Overlap touching")?.status.sameAssigneeOverlap).toBe(false);
    expect(byTitle.get("Overlap completed")?.status.sameAssigneeOverlap).toBe(false);
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

    const overdue = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=checklist&q=One-day%20date%20range&overdue=1`);
    expect(overdue.events.find((event) => event.kind === "checklist")?.status.overdue).toBe(true);

    // overdue_only keeps only the overdue scheduled ranges: this one ended in the past.
    const overdueDefault = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=checklist&q=Unassigned%20checklist`);
    expect(overdueDefault.events.some((entry) => entry.kind === "checklist" && entry.title === "Unassigned checklist")).toBe(true);
    const overdueRange = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=checklist&q=Unassigned%20checklist&overdue=1`);
    expect(overdueRange.events.some((entry) => entry.kind === "checklist" && entry.title === "Unassigned checklist" && entry.status.overdue)).toBe(true);

    const projectOnly = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=project&q=Calendar`);
    expect(projectOnly.events.every((event) => event.kind === "project_deadline")).toBe(true);
    const checklistOnly = await adminCalendar(`/api/production-calendar?${rangeNoLayers}&layers=checklist&q=Calendar`);
    expect(checklistOnly.events.every((event) => event.kind === "checklist")).toBe(true);

    const selected = await adminCalendar(`/api/production-calendar?${range}&q=Calendar&editors=${editorId}`);
    const withUnassigned = await adminCalendar(`/api/production-calendar?${range}&q=Calendar&editors=${editorId}&unassigned=1`);
    expect(withUnassigned.events.some((entry) => entry.kind === "checklist" && entry.title === "Unassigned checklist")).toBe(true);
    expect(selected.events.some((entry) => entry.kind === "checklist" && entry.title === "Unassigned checklist")).toBe(false);
  });

  it("removes an External assignment from the complete calendar projection", async () => {
    await database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(externalRemovedProjectId, externalId).run();
    const body = externalCalendarRangeSchema.parse(await (await request(`/api/production-calendar?${range}&q=External`, tokens.external)).json());
    expect(body.events).toHaveLength(0);
    expect(body.filterFacets.projects.some((project) => project.id === externalRemovedProjectId || project.id === externalArchivedProjectId || project.id === externalUnassignedProjectId)).toBe(false);
    expect(body.filterFacets.people.some((person) => person.id === "80666666-6666-4666-8666-666666666666")).toBe(false);
  });

  it("gives an external collaborator drag, resize and schedule-editor access on ranges", async () => {
    const body = externalCalendarRangeSchema.parse(await (await request(`/api/production-calendar?${range}&q=Calendar`, tokens.external)).json());
    const rangeEvent = body.events.find((event) => event.kind === "checklist" && event.title === "Timed range");
    expect(rangeEvent?.permissions).toMatchObject({ canDrag: true, canResize: true, canOpenScheduleEditor: true });
    const oneDay = body.events.find((event) => event.kind === "checklist" && event.title === "One-day date range");
    expect(oneDay?.permissions).toEqual({ canDrag: true, canResize: true, canOpenScheduleEditor: true });
    expect(rangeEvent?.permissions).not.toHaveProperty("canScheduleRange");
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

  it("mints checklist event ids that PATCH /subtasks rejects verbatim but accepts once unwrapped (#226)", async () => {
    const body = await adminCalendar(`/api/production-calendar?${range}&q=Id%20Contract`);
    const scheduledEvent = body.events.find((event) => event.kind === "checklist" && event.title === "Id contract scheduled checklist");
    expect(scheduledEvent).toBeDefined();
    if (!scheduledEvent) return;

    // The Calendar's entity id is `checklist:<subtaskId>` — every DOM id, focus
    // descriptor, and optimistic overlay on the client depends on that prefix
    // staying on the wire. It must never be sent verbatim to the subtasks route.
    expect(scheduledEvent.id.startsWith("checklist:")).toBe(true);

    const rawPatch = await patchRequest(`/api/projects/${idContractProjectId}/subtasks/${scheduledEvent.id}`, tokens.admin, {
      schedule: { expectedVersion: 1, schedule: { state: "range", start: { kind: "date", localCivil: "2026-08-29" }, end: { kind: "date", localCivil: "2026-08-29" } } },
    });
    expect(rawPatch.status).toBe(400);
    await expect(rawPatch.json()).resolves.toMatchObject({ error: "Invalid project or subtask id" });

    const unwrappedId = subtaskIdFromCalendarEntityId(scheduledEvent.id);
    expect(unwrappedId).not.toBeNull();
    const unwrappedPatch = await patchRequest(`/api/projects/${idContractProjectId}/subtasks/${unwrappedId}`, tokens.admin, {
      schedule: { expectedVersion: 1, schedule: { state: "range", start: { kind: "date", localCivil: "2026-08-29" }, end: { kind: "date", localCivil: "2026-08-29" } } },
    });
    expect(unwrappedPatch.status).toBe(200);
    await expect(unwrappedPatch.json()).resolves.toMatchObject({ schedule: { state: "range", start: { kind: "date", localCivil: "2026-08-29" }, end: { kind: "date", localCivil: "2026-08-29" } } });
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
