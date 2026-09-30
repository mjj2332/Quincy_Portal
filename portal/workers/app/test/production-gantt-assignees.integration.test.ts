import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { EXTERNAL_API_RESPONSE_SCHEMAS } from "@quincy/shared";
import { createAuth } from "../src/auth";
import { productionGanttChildPageSql, productionGanttChildrenForPageSql } from "../src/routes/production-gantt";
import type { Env } from "../src/env";

/**
 * #372: Gantt Subtask rows carry their assignees. Its own file (and so its own D1) because the sibling
 * `production-gantt.integration.test.ts` ends by seeding ~10,000 density rows, after which a `q=` request is
 * slow enough to time out: a fresh database keeps this suite about the assignee columns alone.
 */
const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";

const adminId = "82111111-1111-4111-8111-111111111111";
const editorId = "82222222-2222-4222-8222-222222222222";
const externalId = "82333333-3333-4333-8333-333333333333";

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
  // Every Subtask is a range (ADR 0011): a one-day date range.
  await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_end_kind, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, '2026-08-27', 'date', '2026-08-27', 'date', 'Australia/Sydney', 1, ?, ?, ?)")
    .bind(id, projectId, title, done ? 1 : 0, position, adminId, now, now).run();
  return id;
}


const tokens = { admin: "t372-gantt-admin", editor: "t372-gantt-editor", external: "t372-gantt-external" };

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await insertUser(adminId, "admin", tokens.admin);
  await insertUser(editorId, "editor", tokens.editor);
  await insertUser(externalId, "external_editor", tokens.external);
});

describe("#372 Gantt Subtask rows carry their assignees", () => {
  const assigneeProjectId = "81a37237-2372-4372-8372-a37237237237";
  let pairId = "";
  let soloId = "";
  let noneId = "";
  type Row = { id: string; assignees: Array<{ id: string; name: string }>; otherAssigneeCount: number; assignmentVersion: number; permissions: Record<string, boolean> };
  const pageRows = async (token: string) => {
    const body = await (await request("/api/production-gantt?scope=active&rev=1", token)).json() as { projects: Array<{ id: string; children: { rows: Row[]; revision?: number } }> };
    return body.projects.find((project) => project.id === assigneeProjectId)!.children;
  };
  const childPage = async (token: string) => ((await (await request(`/api/production-gantt?scope=active&childrenOf=${assigneeProjectId}`, token)).json()) as { children: { rows: Row[] } }).children.rows;

  beforeAll(async () => {
    await insertProject(assigneeProjectId, "372 Assignee Street", "editing_autohdr", "2026-08-25");
    await insertMember(assigneeProjectId, externalId, "editor");
    pairId = await insertSubtask(assigneeProjectId, "Pair task", 0);
    soloId = await insertSubtask(assigneeProjectId, "Solo task", 1);
    noneId = await insertSubtask(assigneeProjectId, "Nobody task", 2);
    const now = Date.now();
    // The relation is the source of truth; the legacy column is deliberately left NULL to prove the Gantt does not read it.
    await database.DB.batch([
      database.DB.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, 1, ?)").bind(pairId, externalId, now),
      database.DB.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, 1, ?)").bind(pairId, adminId, now + 1),
      database.DB.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, 1, ?)").bind(soloId, editorId, now),
      database.DB.prepare("UPDATE project_subtasks SET assignment_version = 1 WHERE id IN (?, ?)").bind(pairId, soloId),
    ]);
  });

  it("lists every assignee in assignment order, with the version and the first as `assignee`", async () => {
    const rows = (await pageRows(tokens.admin)).rows;
    const pair = rows.find((row) => row.id === pairId)!;
    expect(pair.assignees.map((person) => person.id)).toEqual([externalId, adminId]);
    expect(pair.otherAssigneeCount).toBe(0);
    expect(pair.assignmentVersion).toBe(1);
    const none = rows.find((row) => row.id === noneId)!;
    expect(none).toMatchObject({ assignees: [], otherAssigneeCount: 0, assignmentVersion: 0 });
  });

  it("gives the child-page endpoint the same list", async () => {
    const pair = (await childPage(tokens.admin)).find((row) => row.id === pairId)!;
    expect(pair.assignees.map((person) => person.id)).toEqual([externalId, adminId]);
    expect(pair.assignmentVersion).toBe(1);
  });

  it("grants canEditAssignees to a collaborator and withholds it from a staff viewer who is not on the Project", async () => {
    expect((await pageRows(tokens.admin)).rows.every((row) => row.permissions.canEditAssignees === true)).toBe(true);
    expect((await pageRows(tokens.external)).rows.every((row) => row.permissions.canEditAssignees === true)).toBe(true);
    const asEditor = (await pageRows(tokens.editor)).rows;
    expect(asEditor.length).toBeGreaterThan(0);
    expect(asEditor.every((row) => row.permissions.canEditAssignees === false)).toBe(true);
    expect((await childPage(tokens.editor)).every((row) => row.permissions.canEditAssignees === false)).toBe(true);
  });

  it("shows an External Editor only team assignees, counts the rest, and never sends the hidden id", async () => {
    const embedded = await (await request("/api/production-gantt?scope=active", tokens.external)).text();
    expect(embedded).not.toContain(adminId);
    const page = await (await request(`/api/production-gantt?scope=active&childrenOf=${assigneeProjectId}`, tokens.external)).text();
    expect(page).not.toContain(adminId);
    const parsed = EXTERNAL_API_RESPONSE_SCHEMAS.gantt.parse(JSON.parse(embedded));
    const pair = parsed.projects.find((project) => project.id === assigneeProjectId)!.children.rows.find((row) => row.id === pairId)!;
    expect(pair.assignees.map((person) => person.id)).toEqual([externalId]);
    expect(pair.otherAssigneeCount).toBe(1);
    const solo = (JSON.parse(page) as { children: { rows: Row[] } }).children.rows.find((row) => row.id === soloId)!;
    // The editor assigned to it is not on this Project's team.
    expect(solo.assignees).toEqual([]);
    expect(solo.otherAssigneeCount).toBe(1);
  });

  it("moves the children revision when an assignee is added through the API", async () => {
    const before = (await pageRows(tokens.admin)).revision;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const headers = new Headers({ cookie: await cookie(tokens.admin), "content-type": "application/json", origin: baseEnv.APP_ORIGIN });
    const patched = await SELF.fetch(`https://portal.test/api/projects/${assigneeProjectId}/subtasks/${noneId}`, { method: "PATCH", headers, body: JSON.stringify({ assignees: { expectedVersion: 0, add: [externalId], remove: [] } }) });
    expect(patched.status, await patched.clone().text()).toBe(200);
    const after = await pageRows(tokens.admin);
    expect(after.revision).not.toBe(before);
    expect(after.rows.find((row) => row.id === noneId)?.assignees.map((person) => person.id)).toEqual([externalId]);
  });

  it("keeps the Gantt child SQL off the per-row assignee columns, for every role", () => {
    for (const role of ["admin", "editor", "external_editor"] as const) {
      expect(productionGanttChildrenForPageSql(role), role).not.toMatch(/assignee_name|assignee_role|assignee_active/u);
      expect(productionGanttChildPageSql(role), role).not.toMatch(/assignee_name|assignee_role|assignee_active/u);
    }
  });
});
