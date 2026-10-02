import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * #461: a tree's Project facet is three-valued. A People / My tasks rule is UNKNOWN in the facet context (the facet is
 * editor-unfiltered), so a Project is in the facet set unless the tree is definitely false for it: an OR with an unknown
 * leaf can never exclude anything, and NOT unknown is unknown.
 */

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;

const adminId = "98111111-1111-4111-8111-111111111111";
const alexId = "98222222-2222-4222-8222-222222222222";
const tokens = { admin: "t461f-admin", alex: "t461f-alex" };
const id = (n: number) => `98a00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P1 = id(1); // priority 1, Alex is its Editor (so `mine` is genuinely true), Deadline 2026-08-27
const P2 = id(2); // priority 1, no Editor, Deadline 2026-08-28
const P3 = id(3); // priority 5, no Editor, Deadline 2026-08-29
const window = "start=2026-08-24&end=2026-09-05&date=2026-08-27&sub=month&scope=active&layers=project";

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

async function calendar(query: string, token: string): Promise<{ status: number; body: any }> {
  const response = await SELF.fetch(`https://portal.test/api/production-calendar?${query}`, { headers: { cookie: await cookie(token) } });
  return { status: response.status, body: await response.json() };
}

const facetIds = (body: any): string[] => ((body.filterFacets?.projects ?? (() => { throw new Error(JSON.stringify(body)); })()) as Array<{ id: string }>).map((project) => project.id).filter((projectId) => projectId.startsWith("98a00000")).sort();
const deadlineIds = (body: any): string[] => (body.events as Array<{ kind: string; project: { id: string } }>).filter((event) => event.kind === "project_deadline").map((event) => event.project.id).sort();

async function insertProject(projectId: string, street: string, priority: number, deadline: string): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, priority, deadline_at, deadline_local_civil, deadline_zone, deadline_utc_offset_minutes, deadline_fold, deadline_version, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?, ?, 'Australia/Sydney', 600, 0, 1, ?, ?)")
    .bind(projectId, street, priority, Date.parse(`${deadline}:00+10:00`), deadline, now, now).run();
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Admin Facet', 'admin@facet461.test', 1, 'admin', 1, 0, ?, ?)").bind(adminId, now, now),
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Alex Facet', 'alex@facet461.test', 1, 'editor', 1, 0, ?, ?)").bind(alexId, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, tokens.admin, adminId, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, tokens.alex, alexId, now, now),
  ]);
  await insertProject(P1, "1 Facet Street", 1, "2026-08-27T09:00");
  await insertProject(P2, "2 Facet Street", 1, "2026-08-28T09:00");
  await insertProject(P3, "3 Facet Street", 5, "2026-08-29T09:00");
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), P1, alexId, now).run();
});

const F = (tree: string) => `${window}&f=${encodeURIComponent(tree)}`;

describe("a tree's Project facet is three-valued (People / My tasks are unknown, never dropped)", () => {
  it("or(mine; priority=5): the deadline event matches through `mine`, so its Project is in the facet set", async () => {
    const { status, body } = await calendar(F("1:or(mine;priority=5)"), tokens.alex);
    expect(status).toBe(200);
    expect(deadlineIds(body)).toEqual([P1, P3].sort());
    expect(facetIds(body)).toEqual([P1, P2, P3].sort());
  });
  it("and(!mine; priority=1): NOT unknown is unknown, so Priority alone decides", async () => {
    const { status, body } = await calendar(F("1:and(!mine;priority=1)"), tokens.alex);
    expect(status).toBe(200);
    expect(facetIds(body)).toEqual([P1, P2].sort());
  });
  it("and(priority=N; or(mine; shoot range)): an AND still narrows by its known rule", async () => {
    expect(facetIds((await calendar(F("1:and(priority=1;or(mine;shoot=2026-08-01..2026-08-02))"), tokens.alex)).body)).toEqual([P1, P2].sort());
    expect(facetIds((await calendar(F("1:and(priority=5;or(mine;shoot=2026-08-01..2026-08-02))"), tokens.alex)).body)).toEqual([P3]);
  });
  it("or(people=X; priority=5) lists every Project: an unknown OR leaf excludes nothing", async () => {
    expect(facetIds((await calendar(F(`1:or(people=${alexId};priority=5)`), tokens.admin)).body)).toEqual([P1, P2, P3].sort());
  });
});
