import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { DASHBOARD_FILTER_TREE_MAX_DEPTH, DASHBOARD_FILTER_TREE_MAX_PEOPLE_IDS, DASHBOARD_FILTER_TREE_MAX_RULES, formatDashboardFilterTree, canonicalizeDashboardFilterTree, dashboardFilterLeaves, dashboardFilterPeopleIds, parseDashboardFilterTree, type DashboardFilterNode, type DashboardFilterTree } from "@quincy/shared";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * #461: a filter tree AT every cap (20 rules, depth 3, 50 People ids) must run through EVERY statement on EVERY surface
 * without a SQLite limit (SQLITE_NOMEM, "Expression tree is too large (maximum depth 100)"), for an Admin and an External
 * Editor. Two failures of exactly that kind shipped in the first cut of the compiler, found only by hand against a local D1.
 */

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;

const adminId = "96111111-1111-4111-8111-111111111111";
const alexId = "96222222-2222-4222-8222-222222222222";
const externalId = "96333333-3333-4333-8333-333333333333";
const tokens = { admin: "t461m-admin", external: "t461m-external" };
const id = (n: number) => `96a00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const person = (n: number) => `96b00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projects = [id(1), id(2), id(3)];
const deadlineCivil = "2026-08-27T09:00";
const window = "start=2026-08-24&end=2026-09-05&date=2026-08-27&sub=month&scope=active";

async function executeSql(sql: string): Promise<void> {
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const withoutComments = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of withoutComments.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

async function cookie(token: string): Promise<string> {
  const context = await createAuth(baseEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function get(path: string, token: string): Promise<{ status: number; body: any }> {
  const response = await SELF.fetch(`https://portal.test${path}`, { headers: { cookie: await cookie(token) } });
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) }; } catch { return { status: response.status, body: text }; }
}

async function insertUser(userId: string, role: string, token: string | null, name: string): Promise<void> {
  const now = Date.now();
  const statements = [database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(userId, name, `${userId}@cap461.test`, role, now, now)];
  if (token) statements.push(database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, userId, now, now));
  await database.DB.batch(statements);
}

async function member(projectId: string, userId: string, role: string): Promise<void> {
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), projectId, userId, role, Date.now()).run();
}

async function subtask(projectId: string, title: string, position: number, assignees: string[]): Promise<void> {
  const subtaskId = crypto.randomUUID();
  const now = Date.now();
  const statements = [database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, due_date, schedule_start_kind, schedule_start_civil, schedule_start_at, schedule_start_utc_offset_minutes, schedule_start_fold, schedule_end_kind, schedule_end_at, schedule_end_utc_offset_minutes, schedule_end_fold, schedule_zone, schedule_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 1, '2026-08-27T17:00', 'timed', '2026-08-27T09:00', 1787785200000, 600, 0, 'timed', 1787814000000, 600, 0, 'Australia/Sydney', 1, ?, ?, ?)")
    .bind(subtaskId, projectId, title, position, adminId, now, now)];
  for (const [index, userId] of assignees.entries()) statements.push(database.DB.prepare("INSERT INTO project_subtask_assignees (subtask_id, user_id, assignment_version, added_at) VALUES (?, ?, 1, ?)").bind(subtaskId, userId, now + index));
  await database.DB.batch(statements);
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await insertUser(adminId, "admin", tokens.admin, "Admin Cap");
  await insertUser(alexId, "editor", null, "Alex Cap");
  await insertUser(externalId, "external_editor", tokens.external, "External Cap");
  const now = Date.now();
  for (const [index, projectId] of projects.entries()) {
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, priority, deadline_at, deadline_local_civil, deadline_zone, deadline_utc_offset_minutes, deadline_fold, deadline_version, created_at, updated_at) VALUES (?, ?, ?, '2026-08-10', 3, ?, ?, 'Australia/Sydney', 600, 0, 1, ?, ?)")
      .bind(projectId, `${index + 1} Cap Street`, index === 0 ? "editing_autohdr" : "awaiting_raw", Date.parse(`${deadlineCivil}:00+10:00`), deadlineCivil, now, now).run();
    await member(projectId, externalId, "editor");
    await member(projectId, alexId, "photographer");
    for (let position = 0; position < 3; position += 1) await subtask(projectId, `T${index}${position}`, position, position === 0 ? [alexId] : position === 1 ? [externalId] : []);
  }
});

const leaf = (field: string, extra: object = {}, negated = false): DashboardFilterNode => ({ kind: "leaf", ...(negated ? { negated: true } : {}), field, ...extra } as DashboardFilterNode);

/** 4 AND groups under one OR root, each: a People rule (12, 12, 11, 11 ids), a negated People rule (1 id), a Stage rule, and an inner OR of a Shoot range and My tasks. 20 rules, 50 ids, depth 3. */
function maxCapTree(options: { priority: boolean }): DashboardFilterTree {
  const group = (index: number): DashboardFilterNode => {
    const ids = [index === 0 ? alexId : person(index * 100), ...Array.from({ length: index < 2 ? 11 : 10 }, (_, n) => person(index * 100 + n + 1))];
    return {
      kind: "group",
      op: "and",
      children: [
        leaf("people", { ids, unassigned: index % 2 === 0 }),
        leaf("people", { ids: [index === 1 ? externalId : person(index * 100 + 50)], unassigned: false }, true),
        index === 3 && options.priority ? leaf("priority", { values: ["3", "4"] }) : leaf("stages", { values: index % 2 === 0 ? ["editing"] : ["awaiting_raw"] }, index === 2),
        { kind: "group", op: "or", children: [leaf("shoot", { range: { from: "2026-08-01", to: "2026-08-31" } }), leaf("mine")] },
      ],
    };
  };
  const tree: DashboardFilterTree = { kind: "group", op: "or", children: [0, 1, 2, 3].map(group) };
  return canonicalizeDashboardFilterTree(tree);
}

/** 20 People rules (3 ids in the first ten, 2 in the rest = 50) flat under one OR: the widest tree, every rule a People rule. */
function flatPeopleTree(): DashboardFilterTree {
  const rules = Array.from({ length: 20 }, (_, n) => leaf("people", { ids: [n === 0 ? alexId : n === 1 ? externalId : person(n * 3), person(n * 3 + 1), ...(n < 10 ? [person(n * 3 + 2)] : [])], unassigned: n % 5 === 0 }, n % 7 === 3));
  return canonicalizeDashboardFilterTree({ kind: "group", op: "or", children: rules });
}

/** 3 groups x (a nested group of People rules) at depth 3: 20 People rules in all, 50 ids (3 in the first ten rules, 2 in the rest). */
function deepPeopleTree(): DashboardFilterTree {
  let n = 0;
  const rule = () => { n += 1; return leaf("people", { ids: [n === 1 ? alexId : person(n * 3), person(n * 3 + 1), ...(n <= 10 ? [person(n * 3 + 2)] : [])], unassigned: false }, n % 4 === 0); };
  const inner = (count: number): DashboardFilterNode => ({ kind: "group", op: n % 2 === 0 ? "or" : "and", children: Array.from({ length: count }, rule) });
  const outer = (counts: number[]): DashboardFilterNode => ({ kind: "group", op: "and", children: counts.map(inner) });
  return canonicalizeDashboardFilterTree({ kind: "group", op: "or", children: [outer([4, 3]), outer([4, 3]), outer([3, 3])] });
}

const shapes: Array<[string, (priority: boolean) => DashboardFilterTree]> = [
  ["mixed max-cap tree", (priority) => maxCapTree({ priority })],
  ["20 flat People rules", () => flatPeopleTree()],
  ["20 People rules in nested groups", () => deepPeopleTree()],
];

describe("every statement at every cap", () => {
  for (const [shape, build] of shapes) for (const role of ["admin", "external"] as const) {
    const token = tokens[role];
    const tree = build(role === "admin");
    const value = formatDashboardFilterTree(tree);
    const label = `${shape}, ${role}`;

    it(`${label}: the fixture really is at the caps and parses`, () => {
      const parsed = parseDashboardFilterTree(value);
      expect("tree" in parsed).toBe(true);
      const depthOf = (node: DashboardFilterNode): number => node.kind === "leaf" ? 0 : 1 + Math.max(0, ...node.children.map(depthOf));
      const idOccurrences = dashboardFilterLeaves(tree).reduce((total, rule) => total + (rule.field === "people" ? rule.ids.length : 0), 0);
      // pinned to the constants, so a fixture edit that drifts below a cap fails here instead of passing quietly
      expect(dashboardFilterLeaves(tree)).toHaveLength(DASHBOARD_FILTER_TREE_MAX_RULES);
      expect(idOccurrences).toBe(DASHBOARD_FILTER_TREE_MAX_PEOPLE_IDS);
      expect(dashboardFilterPeopleIds(tree)).toHaveLength(DASHBOARD_FILTER_TREE_MAX_PEOPLE_IDS);
      expect(depthOf(tree)).toBe(shape === "20 flat People rules" ? 1 : DASHBOARD_FILTER_TREE_MAX_DEPTH);
    });

    it(`${label}: Projects list / External list`, async () => {
      const { status } = await get(`/api/projects?${new URLSearchParams([["f", value]]).toString()}`, token);
      expect(status).toBe(200);
    });

    it(`${label}: Calendar range, facets and bounds`, async () => {
      const { status, body } = await get(`/api/production-calendar?${window}&layers=project,checklist&bounds=1&f=${encodeURIComponent(value)}`, token);
      expect(status, JSON.stringify(body)).toBe(200);
    });

    it(`${label}: Gantt page (facets, children for page), child page and child total`, async () => {
      const page = await get(`/api/production-gantt?scope=active&limit=200&facets=1&dm=1&completed=1&f=${encodeURIComponent(value)}`, token);
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      for (const projectId of projects) {
        const child = await get(`/api/production-gantt?scope=active&childrenOf=${projectId}&completed=1&f=${encodeURIComponent(value)}`, token);
        expect(child.status, JSON.stringify(child.body)).toBe(200);
      }
    });
  }
});
