import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  adminProductionGanttResponseSchema,
  editorProductionGanttResponseSchema,
  encodeGanttChildCursor,
  encodeGanttProjectCursor,
  EXTERNAL_API_RESPONSE_SCHEMAS,
  PRODUCTION_GANTT_CHILD_PAGE_LIMIT,
  PRODUCTION_GANTT_DRAW_CAP,
  PRODUCTION_GANTT_MAX_MATCHED_ROWS,
} from "@quincy/shared";
import { createAuth } from "../src/auth";
import { serializeGanttDeadline } from "../src/routes/production-gantt";
import type { Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";

const adminId = "81111111-1111-4111-8111-111111111111";
const editorId = "81222222-2222-4222-8222-222222222222";
const externalId = "81333333-3333-4333-8333-333333333333";
const photographerId = "81444444-4444-4444-8444-444444444444";

const memberProjectId = "81aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const deliveredProjectId = "81cccccc-cccc-4ccc-8ccc-cccccccccccc";
const archivedProjectId = "81dddddd-dddd-4ddd-8ddd-dddddddddddd";
const tieProjectAId = "81eeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const tieProjectBId = "81eeeeee-eeee-4eee-8eee-eeeeeeeeeeef";
const manyChildrenProjectId = "81ffffff-ffff-4fff-8fff-fffffffffff0";
const noDeadlineProjectId = "81ffffff-ffff-4fff-8fff-fffffffffff1";

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
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(id, `${role} Gantt`, `${id}@gantt.test`, role, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, id, now, now),
  ]);
}

async function insertProject(id: string, street: string, stage: string, shootDate: string | null = null, createdAtOffsetMs = 0): Promise<void> {
  const now = Date.now() + createdAtOffsetMs;
  await database.DB.prepare("INSERT INTO projects (id, street, suburb, stage_key, shoot_date, created_at, updated_at) VALUES (?, ?, 'Suburb', ?, ?, ?, ?)").bind(id, street, stage, shootDate, now, now).run();
}

async function insertMember(projectId: string, userId: string, roleOnProject: "editor" | "photographer"): Promise<void> {
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), projectId, userId, roleOnProject, Date.now()).run();
}

async function insertSubtask(projectId: string, title: string, position: number, done = false): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)")
    .bind(id, projectId, title, done ? 1 : 0, position, adminId, now, now).run();
  return id;
}

const tokens = { admin: "tb218-gantt-admin", editor: "tb218-gantt-editor", external: "tb218-gantt-external", photographer: "tb218-gantt-photographer" };

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await insertUser(adminId, "admin", tokens.admin);
  await insertUser(editorId, "editor", tokens.editor);
  await insertUser(externalId, "external_editor", tokens.external);
  await insertUser(photographerId, "photographer", tokens.photographer);

  await insertProject(memberProjectId, "1 Gantt Street", "editing_autohdr", "2026-08-27");
  await database.DB.prepare("UPDATE projects SET deadline_at = ?, deadline_local_civil = '2026-08-27T09:00', deadline_zone = 'Australia/Sydney', deadline_utc_offset_minutes = 600, deadline_fold = 0, deadline_reminder_offsets_json = '[60,1440]', deadline_version = 1 WHERE id = ?")
    .bind(Date.now() + 86_400_000, memberProjectId).run();
  await insertMember(memberProjectId, externalId, "editor");
  await insertMember(memberProjectId, editorId, "editor");
  await insertMember(memberProjectId, photographerId, "photographer");
  await insertSubtask(memberProjectId, "Prep listing", 0);
  await insertSubtask(memberProjectId, "Done task", 1, true);

  await insertProject(deliveredProjectId, "3 Delivered Street", "delivered", "2026-08-20");
  await insertProject(archivedProjectId, "4 Archived Street", "editing_autohdr", "2026-08-21");
  await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), archivedProjectId).run();

  await insertProject(tieProjectAId, "5A Tie Street", "raw_review", "2026-09-01");
  await insertProject(tieProjectBId, "5B Tie Street", "raw_review", "2026-09-01");

  await insertProject(manyChildrenProjectId, "6 Many Children Street", "editing_autohdr", "2026-08-22");
  for (let i = 0; i < PRODUCTION_GANTT_CHILD_PAGE_LIMIT + 3; i++) await insertSubtask(manyChildrenProjectId, `Task ${i}`, i);

  await insertProject(noDeadlineProjectId, "7 No Deadline Street", "raw_review", null);
});

describe("production-gantt", () => {
  it("admin sees every non-archived project", async () => {
    const response = await request("/api/production-gantt?scope=active", tokens.admin);
    expect(response.status).toBe(200);
    const body = adminProductionGanttResponseSchema.parse(await response.json());
    const ids = body.projects.map((project) => project.id);
    expect(ids).toContain(memberProjectId);
    expect(ids).not.toContain(archivedProjectId);
    expect(ids).not.toContain(deliveredProjectId);
  });

  it("includes delivered when delivered=1", async () => {
    const response = await request("/api/production-gantt?scope=active&delivered=1", tokens.admin);
    const body = adminProductionGanttResponseSchema.parse(await response.json());
    expect(body.projects.map((p) => p.id)).toContain(deliveredProjectId);
  });

  it("photographer receives 403", async () => {
    const response = await request("/api/production-gantt?scope=active", tokens.photographer);
    expect(response.status).toBe(403);
  });

  it("stage keys are role-projected: admin gets editing_autohdr, editor gets editing", async () => {
    const adminResponse = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active", tokens.admin)).json());
    const editorResponse = editorProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active", tokens.editor)).json());
    const adminProject = adminResponse.projects.find((p) => p.id === memberProjectId)!;
    const editorProject = editorResponse.projects.find((p) => p.id === memberProjectId)!;
    expect(adminProject.stageKey).toBe("editing_autohdr");
    expect(editorProject.stageKey).toBe("editing");
  });

  it("external editor sees only assigned projects", async () => {
    const response = await request("/api/production-gantt?scope=active", tokens.external);
    const body = EXTERNAL_API_RESPONSE_SCHEMAS.gantt.parse(await response.json()) as { projects: { id: string }[] };
    expect(body.projects.map((p) => p.id)).toEqual([memberProjectId]);
  });

  it("cursor ties: two projects sharing bar start date both appear exactly once across pages", async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const path = `/api/production-gantt?scope=active&limit=1&stages=raw_review${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = adminProductionGanttResponseSchema.parse(await (await request(path, tokens.admin)).json());
      ids.push(...page.projects.map((p) => p.id));
      cursor = page.page.nextCursor;
      if (!cursor) break;
    }
    expect(ids).toHaveLength(3);
    expect(new Set(ids)).toEqual(new Set([tieProjectAId, tieProjectBId, noDeadlineProjectId]));
  });

  it("cursor round-trip rejects a mutated cursor", async () => {
    const response = await request("/api/production-gantt?scope=active&cursor=not-a-real-cursor", tokens.admin);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "gantt_query_invalid" });
  });

  it("a project with CHILD_PAGE_LIMIT+3 subtasks reports total, truncated and a nextCursor", async () => {
    const response = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active", tokens.admin)).json());
    const project = response.projects.find((p) => p.id === manyChildrenProjectId)!;
    expect(project.children.total).toBe(PRODUCTION_GANTT_CHILD_PAGE_LIMIT + 3);
    expect(project.children.returned).toBe(PRODUCTION_GANTT_CHILD_PAGE_LIMIT);
    expect(project.children.truncated).toBe(true);
    expect(project.children.nextCursor).not.toBeNull();
  });

  it("the child page returns the remainder with no overlap or gap", async () => {
    const response = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active", tokens.admin)).json());
    const project = response.projects.find((p) => p.id === manyChildrenProjectId)!;
    const childPage = await request(`/api/production-gantt?scope=active&childrenOf=${manyChildrenProjectId}&childCursor=${encodeURIComponent(project.children.nextCursor!)}`, tokens.admin);
    expect(childPage.status).toBe(200);
    const body = await childPage.json() as { projectId: string; children: { rows: { id: string }[]; total: number; returned: number; truncated: boolean; nextCursor: string | null } };
    expect(body.projectId).toBe(manyChildrenProjectId);
    expect(body.children.total).toBe(PRODUCTION_GANTT_CHILD_PAGE_LIMIT + 3);
    expect(body.children.returned).toBe(3);
    expect(body.children.truncated).toBe(false);
    expect(body.children.nextCursor).toBeNull();
    const firstPageIds = new Set(project.children.rows.map((row) => row.id));
    const remainderIds = body.children.rows.map((row) => row.id);
    expect(remainderIds).toHaveLength(3);
    for (const id of remainderIds) expect(firstPageIds.has(id)).toBe(false);
  });

  it("childrenOf outside scope returns an empty child page, not 404", async () => {
    const response = await request(`/api/production-gantt?scope=active&childrenOf=${noDeadlineProjectId}`, tokens.external);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ projectId: noDeadlineProjectId, children: { rows: [], total: 0, returned: 0, truncated: false, nextCursor: null } });
  });

  it("reminder offsets survive a set deadline", async () => {
    const response = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active", tokens.admin)).json());
    const project = response.projects.find((p) => p.id === memberProjectId)!;
    expect(project.deadline?.reminderOffsetsMinutes).toEqual([1440, 60]);
  });

  it("deadline version is present for a project with no deadline", async () => {
    const response = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active&stages=raw_review", tokens.admin)).json());
    const project = response.projects.find((p) => p.id === noDeadlineProjectId)!;
    expect(project.deadline).toBeNull();
    expect(project.deadlineVersion).toBe(0);
  });

  it("q matches street, suburb, agency, agent and checklist title", async () => {
    const streetMatch = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active&q=Gantt+Street", tokens.admin)).json());
    expect(streetMatch.projects.map((p) => p.id)).toContain(memberProjectId);
    const suburbMatch = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active&q=Suburb", tokens.admin)).json());
    expect(suburbMatch.projects.map((p) => p.id)).toContain(memberProjectId);
    const titleMatch = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active&q=Prep+listing", tokens.admin)).json());
    expect(titleMatch.projects.map((p) => p.id)).toContain(memberProjectId);
  });

  it("q matching only a checklist title still returns the parent project row", async () => {
    const response = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active&q=Prep+listing", tokens.admin)).json());
    const project = response.projects.find((p) => p.id === memberProjectId);
    expect(project).toBeDefined();
    expect(project!.street).toBe("1 Gantt Street");
  });

  it("editor sees every non-archived project", async () => {
    const response = editorProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active", tokens.editor)).json());
    const ids = response.projects.map((p) => p.id);
    expect(ids).toContain(memberProjectId);
    expect(ids).not.toContain(archivedProjectId);
  });

  it("archived projects never appear for any role", async () => {
    const admin = adminProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active&delivered=1", tokens.admin)).json());
    const editor = editorProductionGanttResponseSchema.parse(await (await request("/api/production-gantt?scope=active&delivered=1", tokens.editor)).json());
    const external = EXTERNAL_API_RESPONSE_SCHEMAS.gantt.parse(await (await request("/api/production-gantt?scope=active&delivered=1", tokens.external)).json()) as { projects: { id: string }[] };
    expect(admin.projects.map((p) => p.id)).not.toContain(archivedProjectId);
    expect(editor.projects.map((p) => p.id)).not.toContain(archivedProjectId);
    expect(external.projects.map((p) => p.id)).not.toContain(archivedProjectId);
  });

  it("revocation: removing the external editor's membership removes the project from the next page", async () => {
    const before = EXTERNAL_API_RESPONSE_SCHEMAS.gantt.parse(await (await request("/api/production-gantt?scope=active", tokens.external)).json()) as { projects: { id: string }[] };
    expect(before.projects.map((p) => p.id)).toContain(memberProjectId);
    await database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(memberProjectId, externalId).run();
    try {
      const after = EXTERNAL_API_RESPONSE_SCHEMAS.gantt.parse(await (await request("/api/production-gantt?scope=active", tokens.external)).json()) as { projects: { id: string }[] };
      expect(after.projects.map((p) => p.id)).not.toContain(memberProjectId);
    } finally {
      await insertMember(memberProjectId, externalId, "editor");
    }
  });

  // Density fixtures are seeded in this nested describe's own beforeAll, which vitest's default
  // sequential runner executes strictly after every `it` declared above has already run — so
  // these large row counts never distort an earlier, unfiltered assertion (e.g. "admin sees every
  // non-archived project"). Each test below scopes itself to one dedicated, otherwise-unused stage
  // key so the two density fixtures don't also inflate each other's counts.
  describe("density", () => {
    const drawCapProjectId = "81999999-9999-4999-8999-999999999990";
    const maxRowsProjectId = "81999999-9999-4999-8999-999999999991";
    const drawCapRowCount = PRODUCTION_GANTT_DRAW_CAP + 1;
    const maxRowsRowCount = PRODUCTION_GANTT_MAX_MATCHED_ROWS + 1;

    beforeAll(async () => {
      await insertProject(drawCapProjectId, "20 Draw Cap Street", "awaiting_raw");
      await database.DB.exec(`WITH digits(n) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)), numbers(n) AS (SELECT a.n * 1000 + b.n * 100 + c.n * 10 + d.n + 1 FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d WHERE a.n * 1000 + b.n * 100 + c.n * 10 + d.n < ${drawCapRowCount}) INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, created_by, created_at, updated_at) SELECT printf('92000000-0000-4000-8000-%012d', n), '${drawCapProjectId}', printf('Draw cap row %05d', n), 0, n, 0, '${adminId}', 0, 0 FROM numbers`);

      await insertProject(maxRowsProjectId, "21 Max Rows Street", "edited_review");
      await database.DB.exec(`WITH digits(n) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)), numbers(n) AS (SELECT a.n * 10000 + b.n * 1000 + c.n * 100 + d.n * 10 + e.n + 1 FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e WHERE a.n * 10000 + b.n * 1000 + c.n * 100 + d.n * 10 + e.n < ${maxRowsRowCount}) INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, created_by, created_at, updated_at) SELECT printf('93000000-0000-4000-8000-%012d', n), '${maxRowsProjectId}', printf('Max rows row %05d', n), 0, n, 0, '${adminId}', 0, 0 FROM numbers`);
    });

    it("matchedRows over DRAW_CAP sets tooManyToDraw and still returns a page", async () => {
      const response = await request("/api/production-gantt?scope=active&stages=awaiting_raw", tokens.admin);
      expect(response.status).toBe(200);
      const body = adminProductionGanttResponseSchema.parse(await response.json());
      expect(body.density.matchedRows).toBeGreaterThan(PRODUCTION_GANTT_DRAW_CAP);
      expect(body.density.tooManyToDraw).toBe(true);
      expect(body.projects.length).toBeGreaterThan(0);
    });

    it("matchedRows over MAX_MATCHED_ROWS returns 422 gantt_scope_too_dense", async () => {
      const response = await request("/api/production-gantt?scope=active&stages=edited_review", tokens.admin);
      expect(response.status).toBe(422);
      const body = await response.json() as { code: string; count: number; max: number };
      expect(body.code).toBe("gantt_scope_too_dense");
      expect(body.count).toBeGreaterThan(PRODUCTION_GANTT_MAX_MATCHED_ROWS);
      expect(body.max).toBe(PRODUCTION_GANTT_MAX_MATCHED_ROWS);
    });
  });
});

// Coordinator decision on #218 step 6 (spec flag #5 withdrawn): a null deadline carries no
// reminderOffsetsMinutes, because deadline_at and deadline_reminder_offsets_json are always
// written together (lib/project-deadline.ts:233-249) — there is nothing stored to lose.
describe("serializeGanttDeadline", () => {
  it("returns null when deadline_at IS NULL", () => {
    expect(serializeGanttDeadline({ deadline_at: null, deadline_local_civil: null, deadline_version: null, deadline_reminder_offsets_json: null, delivered: 0 }, Date.now())).toBeNull();
  });

  it("returns the stored offsets, deduped and sorted descending, when a deadline is set", () => {
    const at = Date.parse("2026-09-01T00:00:00.000Z");
    const result = serializeGanttDeadline({ deadline_at: at, deadline_local_civil: "2026-09-01T10:00", deadline_version: 3, deadline_reminder_offsets_json: "[60,1440,60]", delivered: 0 }, at - 1);
    expect(result).toMatchObject({ at: new Date(at).toISOString(), localCivil: "2026-09-01T10:00", version: 3, reminderOffsetsMinutes: [1440, 60], overdue: false });
  });
});
