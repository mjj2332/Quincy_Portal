import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * #461 fix round: a LEGACY Calendar request (no `f=`) behaves exactly as on `main`.
 * - `filterFacets.projects` is the editor-unfiltered candidate set narrowed by Priority, Shoot date, Deadline range and
 *   Overdue (the first cut of the tree compiler widened it to every Project in the window).
 * - `overdue=1` still counts a Project with no Deadline toward the 10,000-candidate density ceiling.
 * Expected values below are what `main`'s statements return for this seed (the facet set is a pure function of it).
 */

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;

const adminId = "97111111-1111-4111-8111-111111111111";
const token = "t461p-admin";
const id = (n: number) => `97a00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = id(1); // Deadline 2020-06-10 (overdue), priority 5, shoot 2026-08-10
const B = id(2); // Deadline 2020-06-12 (overdue), priority 3, shoot 2026-08-20
const C = id(3); // Deadline 2020-06-14 (overdue), no priority, no shoot
const D = id(4); // no Deadline, priority 5, shoot 2026-08-10
const E = id(5); // Delivered, Deadline 2020-06-15, priority 5
const past = "start=2020-06-01&end=2020-07-01&date=2020-06-15&sub=month&scope=active&layers=project,checklist";

async function executeSql(sql: string): Promise<void> {
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const withoutComments = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of withoutComments.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

async function cookie(): Promise<string> {
  const context = await createAuth(baseEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function calendar(query: string): Promise<{ status: number; body: any }> {
  const response = await SELF.fetch(`https://portal.test/api/production-calendar?${query}`, { headers: { cookie: await cookie() } });
  return { status: response.status, body: await response.json() };
}

const facetIds = (body: any): string[] => ((body.filterFacets?.projects ?? (() => { throw new Error(JSON.stringify(body)); })()) as Array<{ id: string }>).map((project) => project.id).filter((projectId) => projectId.startsWith("97a00000")).sort();

async function insertProject(projectId: string, street: string, options: { priority?: number; shoot?: string; deadline?: string; delivered?: boolean }): Promise<void> {
  const now = Date.now();
  const at = options.deadline ? Date.parse(`${options.deadline}:00+10:00`) : null;
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, priority, shoot_date, deadline_at, deadline_local_civil, deadline_zone, deadline_utc_offset_minutes, deadline_fold, deadline_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(projectId, street, options.delivered ? "delivered" : "awaiting_raw", options.priority ?? null, options.shoot ?? null, at, options.deadline ?? null, options.deadline ? "Australia/Sydney" : null, options.deadline ? 600 : null, options.deadline ? 0 : null, options.deadline ? 1 : 0, now, now).run();
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Admin Parity', 'admin@parity461.test', 1, 'admin', 1, 0, ?, ?)").bind(adminId, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, adminId, now, now),
  ]);
  await insertProject(A, "1 Parity Street", { priority: 5, shoot: "2026-08-10", deadline: "2020-06-10T09:00" });
  await insertProject(B, "2 Parity Street", { priority: 3, shoot: "2026-08-20", deadline: "2020-06-12T09:00" });
  await insertProject(C, "3 Parity Street", { deadline: "2020-06-14T09:00" });
  await insertProject(D, "4 Parity Street", { priority: 5, shoot: "2026-08-10" });
  await insertProject(E, "5 Parity Street", { priority: 5, deadline: "2020-06-15T09:00", delivered: true });
});

describe("legacy Calendar facets.projects is narrowed by every flat facet, as on main", () => {
  it("no facet: every Project in the window (Delivered hidden)", async () => {
    expect(facetIds((await calendar(past)).body)).toEqual([A, B, C, D].sort());
  });
  it("priority=5 keeps only priority-5 Projects (a no-Deadline one included)", async () => {
    expect(facetIds((await calendar(`${past}&priority=5`)).body)).toEqual([A, D].sort());
    expect(facetIds((await calendar(`${past}&priority=none`)).body)).toEqual([C]);
  });
  it("shoot= keeps only Projects shot in the range", async () => {
    expect(facetIds((await calendar(`${past}&shoot=2026-08-01..2026-08-15`)).body)).toEqual([A, D].sort());
  });
  it("deadline= keeps only Projects whose Deadline falls in the range (never a no-Deadline one)", async () => {
    expect(facetIds((await calendar(`${past}&deadline=2020-06-11..2020-06-13`)).body)).toEqual([B]);
  });
  it("overdue=1 drops a Delivered Project (and keeps a no-Deadline one, as main's candidate rule did)", async () => {
    expect(facetIds((await calendar(`${past}&delivered=1`)).body)).toEqual([A, B, C, D, E].sort());
    expect(facetIds((await calendar(`${past}&delivered=1&overdue=1`)).body)).toEqual([A, B, C, D].sort());
  });
});

describe("a tree's Project facet applies the tree's non-People rules; a People rule is unknown, never dropped", () => {
  it("or(Shoot range; Priority 3) lists the Projects either rule keeps", async () => {
    const { status, body } = await calendar(`${past}&f=${encodeURIComponent("1:or(shoot=2026-08-01..2026-08-15;priority=3)")}`);
    expect(status).toBe(200);
    expect(facetIds(body)).toEqual([A, B, D].sort());
  });
  it("a People rule never narrows the Project facet: an unknown OR leaf keeps every Project, an unknown AND leaf narrows nothing", async () => {
    const or = await calendar(`${past}&f=${encodeURIComponent(`1:or(people=${adminId};shoot=2026-08-01..2026-08-15)`)}`);
    expect(facetIds(or.body)).toEqual([A, B, C, D].sort());
    const and = await calendar(`${past}&f=${encodeURIComponent(`1:and(shoot=2026-08-01..2026-08-15;or(people=${adminId};mine))`)}`);
    expect(facetIds(and.body)).toEqual([A, D].sort());
  });
});

describe("legacy Calendar density counts a no-Deadline Project under overdue=1, as on main", () => {
  it("10,001 Projects with no Deadline still refuse the range with 422 under overdue=1", async () => {
    await database.DB.exec("WITH digits(n) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)), numbers(n) AS (SELECT a.n * 1000 + b.n * 100 + c.n * 10 + d.n + 1 FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d WHERE a.n * 1000 + b.n * 100 + c.n * 10 + d.n < 10000 UNION ALL SELECT 10001) INSERT INTO projects (id, street, stage_key, created_at, updated_at) SELECT printf('97c00000-0000-4000-8000-%012d', n), printf('%d Dense Street', n), 'awaiting_raw', 0, 0 FROM numbers");
    const dense = await calendar(`${past}&overdue=1`);
    expect(dense.status).toBe(422);
    expect(dense.body).toMatchObject({ code: "calendar_range_too_dense", max: 10_000 });
  });
});
