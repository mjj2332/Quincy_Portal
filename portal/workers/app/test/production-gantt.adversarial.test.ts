import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  adminProductionCalendarRangeResponseSchema,
  adminProductionGanttResponseSchema,
  editorProductionGanttResponseSchema,
  EXTERNAL_API_RESPONSE_SCHEMAS,
  encodeGanttChildCursor,
  encodeGanttProjectCursor,
  PRODUCTION_GANTT_CHILD_PAGE_LIMIT,
  productionGanttChildPageSchema,
} from "@quincy/shared";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";

const adminId = "82111111-1111-4111-8111-111111111111";
const editorId = "82222222-2222-4222-8222-222222222222";
const externalId = "82333333-3333-4333-8333-333333333333";
const photographerId = "82444444-4444-4444-8444-444444444444";

const assignedProjectId = "82aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const unassignedProjectId = "82bbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const archivedProjectId = "82cccccc-cccc-4ccc-8ccc-cccccccccccc";
const tieProjectAId = "82dddddd-dddd-4ddd-8ddd-dddddddddddd";
const tieProjectBId = "82eeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const nullDateProjectId = "82ffffff-ffff-4fff-8fff-fffffffffff0";
const invalidDateProjectId = "82ffffff-ffff-4fff-8fff-fffffffffff1";
const childProjectId = "82888888-8888-4888-8888-888888888880";
const movedProjectId = "82999999-9999-4999-8999-999999999990";
const movedPeerProjectId = "82999999-9999-4999-8999-999999999991";
const percentProjectId = "82666666-6666-4666-8666-666666666660";
const underscoreProjectId = "82777777-7777-4777-8777-777777777770";
const completedOnlyProjectId = "82777777-7777-4777-8777-777777777771";
const calendarProjectId = "82777777-7777-4777-8777-777777777772";

const tokens = {
  admin: "tb218-adversarial-admin",
  editor: "tb218-adversarial-editor",
  external: "tb218-adversarial-external",
  photographer: "tb218-adversarial-photographer",
} as const;

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

async function insertUser(id: string, role: string, token: string): Promise<void> {
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(id, `${role} adversarial`, `${id}@gantt-adversarial.test`, role, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, id, now, now),
  ]);
}

async function insertProject(id: string, street: string, stage: string, shootDate: string | null, createdAt: number): Promise<void> {
  await database.DB.prepare("INSERT INTO projects (id, street, suburb, stage_key, shoot_date, created_at, updated_at) VALUES (?, ?, 'Probe Suburb', ?, ?, ?, ?)")
    .bind(id, street, stage, shootDate, createdAt, createdAt).run();
}

async function insertMember(projectId: string, userId: string, roleOnProject: "editor" | "photographer"): Promise<void> {
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), projectId, userId, roleOnProject, Date.now()).run();
}

async function insertSubtask(projectId: string, id: string, title: string, position: number, done = false): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)")
    .bind(id, projectId, title, done ? 1 : 0, position, adminId, now, now).run();
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await insertUser(adminId, "admin", tokens.admin);
  await insertUser(editorId, "editor", tokens.editor);
  await insertUser(externalId, "external_editor", tokens.external);
  await insertUser(photographerId, "photographer", tokens.photographer);

  const day = (value: string) => Date.parse(`${value}T00:00:00.000Z`);
  await insertProject(assignedProjectId, "Assigned Probe Street", "editing_autohdr", "2026-08-01", day("2026-08-01"));
  await insertProject(unassignedProjectId, "Unassigned Probe Street", "editing_autohdr", "2026-08-01", day("2026-08-01"));
  await insertProject(archivedProjectId, "Archived Probe Street", "editing_autohdr", "2026-08-01", day("2026-08-01"));
  await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), archivedProjectId).run();
  await insertProject(tieProjectAId, "Keyset Probe A", "raw_review", "2026-09-01", day("2026-09-01"));
  await insertProject(tieProjectBId, "Keyset Probe B", "raw_review", "2026-09-01", day("2026-09-01"));
  await insertProject(nullDateProjectId, "Keyset Probe Null", "raw_review", null, day("2026-09-02"));
  await insertProject(invalidDateProjectId, "Keyset Probe Invalid", "raw_review", "2026-02-30", day("2026-09-03"));
  await insertProject(childProjectId, "Child Cursor Probe", "editing_autohdr", "2026-08-02", day("2026-08-02"));
  await insertProject(movedProjectId, "Mutable Sort Probe A", "raw_review", "2026-08-03", day("2026-08-03"));
  await insertProject(movedPeerProjectId, "Mutable Sort Probe B", "raw_review", "2026-08-03", day("2026-08-03"));
  await insertProject(percentProjectId, "Literal % Probe", "awaiting_raw", "2026-08-04", day("2026-08-04"));
  await insertProject(underscoreProjectId, "Literal _ Probe", "awaiting_raw", "2026-08-04", day("2026-08-04"));
  await insertProject(completedOnlyProjectId, "Completed Title Probe", "awaiting_raw", "2026-08-04", day("2026-08-04"));
  await insertProject(calendarProjectId, "Calendar Characterization Probe", "awaiting_raw", "2026-08-05", day("2026-08-05"));
  await database.DB.prepare("UPDATE projects SET deadline_at = ?, deadline_local_civil = '2026-08-05T10:00', deadline_zone = 'Australia/Sydney', deadline_utc_offset_minutes = 600, deadline_fold = 0, deadline_version = 1 WHERE id = ?")
    .bind(Date.parse("2026-08-05T00:00:00.000Z"), calendarProjectId).run();

  await insertMember(assignedProjectId, externalId, "editor");
  await insertMember(assignedProjectId, editorId, "editor");
  await insertMember(assignedProjectId, photographerId, "photographer");
  await insertMember(archivedProjectId, externalId, "editor");
  await insertMember(childProjectId, externalId, "editor");
  await insertMember(childProjectId, editorId, "editor");
  for (let i = 0; i <= PRODUCTION_GANTT_CHILD_PAGE_LIMIT; i++) {
    await insertSubtask(childProjectId, `82888888-8888-4888-8888-${String(i + 1).padStart(12, "0")}`, `Child ${i}`, i, i % 2 === 0);
  }
  await insertSubtask(percentProjectId, crypto.randomUUID(), "Percent child %", 0);
  await insertSubtask(underscoreProjectId, crypto.randomUUID(), "Underscore child _", 0);
  await insertSubtask(completedOnlyProjectId, crypto.randomUUID(), "Only completed sentinel", 0, true);

  for (let i = 0; i < 201; i++) {
    await insertProject(`82555555-5555-4555-8555-${String(i + 1).padStart(12, "0")}`, `Page Limit Probe ${String(i + 1).padStart(3, "0")}`, "raw_review", "2026-08-08", day("2026-08-08"));
  }
  // fix-218-r2 #5: the soft (DRAW_CAP) and hard (MAX_MATCHED_ROWS) density boundaries, at both N
  // and N+1, are now pinned in production-gantt.integration.test.ts's own "density" describe
  // block, seeded the same bulk-INSERT-from-a-recursive-CTE way but without this file's other
  // ~400 fixture rows — that version runs in well under a second. Seeding and asserting the same
  // boundaries again here made this suite take minutes per run (default vitest timeouts), so this
  // test was removed rather than duplicated; see production-gantt.integration.test.ts's "density"
  // tests for the equivalent, faster coverage.
});

describe("production-gantt adversarial probes", () => {
  it("enforces the role matrix in both page and childrenOf modes, including archived projects", async () => {
    const pageCases = [
      [tokens.admin, 200],
      [tokens.editor, 200],
      [tokens.external, 200],
      [tokens.photographer, 403],
    ] as const;
    for (const [token, status] of pageCases) {
      const response = await request("/api/production-gantt?scope=active", token);
      expect(response.status).toBe(status);
      if (status === 200) {
        const body = token === tokens.admin
          ? adminProductionGanttResponseSchema.parse(await response.json())
          : token === tokens.external
            ? EXTERNAL_API_RESPONSE_SCHEMAS.gantt.parse(await response.json())
            : editorProductionGanttResponseSchema.parse(await response.json());
        expect(body.projects.map((project) => project.id)).not.toContain(archivedProjectId);
      }
    }

    for (const [token, status] of [[tokens.admin, 200], [tokens.editor, 200], [tokens.external, 200], [tokens.photographer, 403]] as const) {
      const response = await request(`/api/production-gantt?scope=active&childrenOf=${assignedProjectId}`, token);
      expect(response.status).toBe(status);
    }
    for (const token of [tokens.admin, tokens.editor, tokens.external]) {
      const response = await request(`/api/production-gantt?scope=active&childrenOf=${archivedProjectId}`, token);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ projectId: archivedProjectId, children: { rows: [], total: 0, returned: 0, truncated: false, nextCursor: null } });
    }
  });

  it("re-applies scope on forged, replayed, cross-project, and cross-principal cursors", async () => {
    const forgedProjectCursor = encodeGanttProjectCursor({ startDate: "2026-08-01", id: unassignedProjectId });
    const externalPage = await request(`/api/production-gantt?scope=active&cursor=${forgedProjectCursor}`, tokens.external);
    expect(externalPage.status).toBe(200);
    const externalBody = EXTERNAL_API_RESPONSE_SCHEMAS.gantt.parse(await externalPage.json()) as { projects: { id: string }[] };
    expect(externalBody.projects.map((project) => project.id)).not.toContain(unassignedProjectId);

    const crossProjectCursor = encodeGanttChildCursor({ projectId: assignedProjectId, position: 0, id: "82888888-8888-4888-8888-000000000001", completed: false });
    const crossProject = await request(`/api/production-gantt?scope=active&childrenOf=${unassignedProjectId}&childCursor=${crossProjectCursor}`, tokens.admin);
    expect(crossProject.status).toBe(400);
    await expect(crossProject.json()).resolves.toMatchObject({ code: "gantt_query_invalid" });

    const forgedChildCursor = encodeGanttChildCursor({ projectId: unassignedProjectId, position: 0, id: "82888888-8888-4888-8888-000000000001", completed: false });
    const externalChild = await request(`/api/production-gantt?scope=active&childrenOf=${unassignedProjectId}&childCursor=${forgedChildCursor}`, tokens.external);
    expect(externalChild.status).toBe(200);
    expect(await externalChild.json()).toEqual({ projectId: unassignedProjectId, children: { rows: [], total: 0, returned: 0, truncated: false, nextCursor: null } });

    const first = await request(`/api/production-gantt?scope=active&childrenOf=${childProjectId}&completed=1`, tokens.external);
    const firstBody = productionGanttChildPageSchema.parse(await first.json());
    expect(firstBody.children.nextCursor).not.toBeNull();
    await database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(childProjectId, externalId).run();
    try {
      const replay = await request(`/api/production-gantt?scope=active&childrenOf=${childProjectId}&childCursor=${encodeURIComponent(firstBody.children.nextCursor!)}`, tokens.external);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ projectId: childProjectId, children: { rows: [], total: 0, returned: 0, truncated: false, nextCursor: null } });
    } finally {
      await insertMember(childProjectId, externalId, "editor");
    }
  });

  it("walks equal barStartDate ties and null/invalid shoot dates without gaps", async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const response = await request(`/api/production-gantt?scope=active&q=Keyset+Probe&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, tokens.admin);
      expect(response.status).toBe(200);
      const body = adminProductionGanttResponseSchema.parse(await response.json());
      ids.push(...body.projects.map((project) => project.id));
      cursor = body.page.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(ids)).toEqual(new Set([tieProjectAId, tieProjectBId, nullDateProjectId, invalidDateProjectId]));
    // fix-218-r2 #3: `q` never matches by id — look this project up by its own street
    // ("Keyset Probe Invalid") instead of a UUID-prefix substring, which could never match.
    const invalid = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active&q=Keyset+Probe+Invalid", tokens.admin)).json()).projects.find((project) => project.id === invalidDateProjectId);
    expect(invalid?.shootDateCivil).toBeNull();
    expect(invalid?.barStartDate).not.toBe("2026-02-30");
  });

  it("does not duplicate or resurrect rows when an unseen row is archived and a tied row is inserted between pages", async () => {
    const first = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active&q=Mutable+Sort+Probe&limit=1", tokens.admin)).json());
    expect(first.projects).toHaveLength(1);
    const cursor = first.page.nextCursor!;
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), movedPeerProjectId).run();
    const insertedId = "82999999-9999-4999-8999-999999999992";
    await insertProject(insertedId, "Mutable Sort Probe Inserted", "raw_review", "2026-08-03", Date.parse("2026-08-03T00:00:00.000Z"));
    try {
      const second = adminProductionGanttResponseSchema.parse(await (await request(`/api/production-gantt?scope=active&q=Mutable+Sort+Probe&limit=1&cursor=${encodeURIComponent(cursor)}`, tokens.admin)).json());
      const ids = second.projects.map((project) => project.id);
      expect(ids).not.toContain(movedPeerProjectId);
      expect(ids).toContain(insertedId);
      expect(ids).not.toContain(movedProjectId);
    } finally {
      await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(movedPeerProjectId).run();
      await database.DB.prepare("DELETE FROM projects WHERE id = ?").bind(insertedId).run();
    }
  });

  // fix-218-r2 #2: this used to assert no duplicates, which is the exact behaviour the
  // orchestrator's decision (fix-218-r2 #1) intentionally does NOT guarantee server-side — a
  // keyset cursor over live data cannot prevent a row whose sort key moves mid-walk from being
  // re-selected, and clients are the documented dedupe point
  // (`flattenGanttProjectPages`/`mergeGanttChildPage` in
  // apps/web/src/lib/production-gantt-query.ts). This test now pins the CONTRACT the server does
  // own instead: after the same mutation, the walk still surfaces every project at least once,
  // skips none, and terminates.
  it("mutable barStartDate changes: the walk still returns every project at least once, skips none, and terminates", async () => {
    const first = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active&q=Mutable+Sort+Probe&limit=1", tokens.admin)).json());
    await database.DB.prepare("UPDATE projects SET shoot_date = '9999-01-01' WHERE id = ?").bind(first.projects[0]!.id).run();
    const seen: string[] = [...first.projects.map((project) => project.id)];
    let next: string | null = first.page.nextCursor;
    const MAX_PAGES = 10;
    let pages = 1;
    while (next && pages < MAX_PAGES) {
      const body = adminProductionGanttResponseSchema.parse(await (await request(`/api/production-gantt?scope=active&q=Mutable+Sort+Probe&limit=1&cursor=${encodeURIComponent(next)}`, tokens.admin)).json());
      seen.push(...body.projects.map((project) => project.id));
      next = body.page.nextCursor;
      pages++;
    }
    // Terminates: the walk stopped because the server ran out of pages (nextCursor became null),
    // not because the iteration cap was hit — which would indicate an infinite cursor loop.
    expect(next).toBeNull();
    // Every project appears at least once and none is skipped. The mutated row may legitimately
    // appear more than once under the documented live-data pagination contract, so this
    // deliberately checks the *set* of ids, not their count.
    expect(new Set(seen)).toEqual(new Set([movedProjectId, movedPeerProjectId]));
  });

  it("treats search metacharacters literally, rejects controls, and enforces the 200-code-point cap", async () => {
    const percent = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active&q=%25", tokens.admin)).json());
    expect(percent.projects.map((project) => project.id)).toContain(percentProjectId);
    expect(percent.projects.map((project) => project.id)).not.toContain(underscoreProjectId);
    const underscore = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active&q=_", tokens.admin)).json());
    expect(underscore.projects.map((project) => project.id)).toContain(underscoreProjectId);
    expect(underscore.projects.map((project) => project.id)).not.toContain(percentProjectId);

    for (const encoded of ["%00", "%0A", "%7F"]) {
      const response = await request(`/api/production-gantt?scope=active&q=${encoded}`, tokens.admin);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: "gantt_query_invalid" });
    }
    const exactly200 = await request(`/api/production-gantt?scope=active&q=${"x".repeat(200)}`, tokens.admin);
    expect(exactly200.status).toBe(200);
    const over200 = await request(`/api/production-gantt?scope=active&q=${"x".repeat(201)}`, tokens.admin);
    expect(over200.status).toBe(400);
    await expect(over200.json()).resolves.toMatchObject({ code: "gantt_query_too_large" });

    const defaultCompleted = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active&q=Only+completed+sentinel", tokens.admin)).json());
    expect(defaultCompleted.projects.map((project) => project.id)).not.toContain(completedOnlyProjectId);
    const includeCompleted = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active&q=Only+completed+sentinel&completed=1", tokens.admin)).json());
    expect(includeCompleted.projects.map((project) => project.id)).toContain(completedOnlyProjectId);
  });

  it("honors the 100/200 project pages and the exact 100-child cap", async () => {
    const page100 = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active&limit=100&q=Page+Limit+Probe", tokens.admin)).json());
    expect(page100.page.limit).toBe(100);
    expect(page100.projects).toHaveLength(100);
    expect(page100.page.nextCursor).not.toBeNull();
    const page200 = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active&limit=200&q=Page+Limit+Probe", tokens.admin)).json());
    expect(page200.page.limit).toBe(200);
    expect(page200.projects).toHaveLength(200);
    expect(page200.page.nextCursor).not.toBeNull();
    const children = adminProductionGanttResponseSchema.parse(await (await request(`/api/production-gantt?scope=active&q=Child+Cursor+Probe&completed=1`, tokens.admin)).json()).projects.find((project) => project.id === childProjectId)!;
    expect(children.children.returned).toBe(PRODUCTION_GANTT_CHILD_PAGE_LIMIT);
    expect(children.children.total).toBe(PRODUCTION_GANTT_CHILD_PAGE_LIMIT + 1);
    expect(children.children.truncated).toBe(true);
  });

  it("returns 400 gantt_query_invalid for malformed combinations and values", async () => {
    const cases = [
      "scope=active&limit=0",
      "scope=active&limit=201",
      "scope=active&limit=01",
      "scope=active&completed=0",
      "scope=active&delivered=true",
      "scope=active&stages=",
      "scope=active&scope=active",
      "scope=active&unknown=1",
      "scope=active&childrenOf=not-a-uuid",
      `scope=active&childrenOf=${assignedProjectId}&limit=1`,
      `scope=active&childrenOf=${assignedProjectId}&childCursor=not-a-cursor`,
      `scope=active&childrenOf=${assignedProjectId}&childCursor=${encodeURIComponent(encodeGanttChildCursor({ projectId: assignedProjectId, position: 0, id: "82888888-8888-4888-8888-000000000001", completed: false }))}&completed=1`,
      "scope=active%ZZ",
    ];
    for (const query of cases) {
      const response = await request(`/api/production-gantt?${query}`, tokens.admin);
      expect(response.status, query).toBe(400);
      await expect(response.json(), query).resolves.toMatchObject({ code: "gantt_query_invalid" });
    }
  });

  it("keeps the Calendar response contract and visibility after the Gantt route is mounted", async () => {
    const response = await request("/api/production-calendar?start=2026-08-01&end=2026-08-08&date=2026-08-05&sub=week&scope=active&layers=project", tokens.admin);
    expect(response.status).toBe(200);
    const body = adminProductionCalendarRangeResponseSchema.parse(await response.json());
    expect(body.range).toMatchObject({ start: "2026-08-01", end: "2026-08-08", date: "2026-08-05", subview: "week", zone: "Australia/Sydney" });
    // fix-218-r2 #4: CalendarEventDto has no top-level `projectId` — the project reference is
    // nested at `event.project.id` (packages/shared/src/production-calendar.ts).
    expect(body.events.some((event) => event.project.id === calendarProjectId)).toBe(true);
  });
});
