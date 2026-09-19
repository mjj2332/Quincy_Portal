import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { DASHBOARD_SEARCH_MAX_CHARS } from "@quincy/shared";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * Second, deliberately small role matrix for `/api/projects?q=`. The existing integration
 * fixture is broad; this one keeps exact totals and Board-envelope membership obvious while
 * stressing the three authorization paths independently.
 */
const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;

const adminId = "82111111-1111-4111-8111-111111111111";
const photographerId = "82222222-2222-4222-8222-222222222222";
const externalId = "82333333-3333-4333-8333-333333333333";
const tokens = { admin: "tb217-adversarial-admin", photographer: "tb217-adversarial-photographer", external: "tb217-adversarial-external" };

const adminStreetId = "82a00000-0000-4000-8000-000000000001";
const adminChecklistId = "82a00000-0000-4000-8000-000000000002";
const adminControlId = "82a00000-0000-4000-8000-000000000003";
const literalId = "82a00000-0000-4000-8000-000000000004";
const literalPercentControlId = "82a00000-0000-4000-8000-000000000005";
const literalUnderscoreControlId = "82a00000-0000-4000-8000-000000000006";
const cappedId = "82a00000-0000-4000-8000-000000000007";
const photographerVisibleId = "82a00000-0000-4000-8000-000000000008";
const photographerHiddenId = "82a00000-0000-4000-8000-000000000009";
const externalVisibleId = "82a00000-0000-4000-8000-00000000000a";
const externalOtherId = "82a00000-0000-4000-8000-00000000000b";
const externalHiddenId = "82a00000-0000-4000-8000-00000000000c";

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

async function request(path: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await SELF.fetch(`https://portal.test${path}`, { headers: { cookie: await cookie(token) } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function insertUser(id: string, role: string, token: string): Promise<void> {
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(id, `${role} Adversarial`, `${id}@adversarial.test`, role, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, id, now, now),
  ]);
}

async function insertProject(id: string, street: string, stage = "editing_autohdr"): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, street, stage, now, now).run();
}

async function insertMember(projectId: string, userId: string, roleOnProject: "editor" | "photographer"): Promise<void> {
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), projectId, userId, roleOnProject, Date.now()).run();
}

async function insertSubtask(projectId: string, title: string): Promise<void> {
  await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?)")
    .bind(crypto.randomUUID(), projectId, title, adminId, Date.now(), Date.now()).run();
}

function ids(body: Record<string, unknown>): string[] {
  return (body.projects as Array<{ id: string }>).map((project) => project.id);
}

function boardIds(body: Record<string, unknown>): string[] {
  return Object.values((body.board as { orderedProjectIdsByStage: Record<string, string[]> }).orderedProjectIdsByStage).flat();
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await insertUser(adminId, "admin", tokens.admin);
  await insertUser(photographerId, "photographer", tokens.photographer);
  await insertUser(externalId, "external_editor", tokens.external);

  await insertProject(adminStreetId, "Admin Needle Street");
  await insertProject(adminChecklistId, "Admin Plain Street");
  await insertSubtask(adminChecklistId, "Admin Checklist Needle");
  await insertProject(adminControlId, "Admin Other Street");
  await insertProject(literalId, "100%_literal Needle");
  await insertProject(literalPercentControlId, "100xxliteral Needle");
  await insertProject(literalUnderscoreControlId, "100Xliteral Needle");
  await insertProject(cappedId, "z".repeat(DASHBOARD_SEARCH_MAX_CHARS));

  await insertProject(photographerVisibleId, "Photographer Needle Street", "awaiting_raw");
  await insertMember(photographerVisibleId, photographerId, "photographer");
  await insertProject(photographerHiddenId, "Photographer Hidden Needle Street", "awaiting_raw");

  await insertProject(externalVisibleId, "External Plain Street");
  await insertMember(externalVisibleId, externalId, "editor");
  await insertSubtask(externalVisibleId, "External Checklist Needle");
  await insertProject(externalOtherId, "External Other Street");
  await insertMember(externalOtherId, externalId, "editor");
  await insertProject(externalHiddenId, "External Hidden Street");
  await insertSubtask(externalHiddenId, "External Checklist Needle");
});

describe("/api/projects?q= adversarial role matrix (#217)", () => {
  it("internal search returns exact matching/total counts and an unfiltered Board envelope", async () => {
    const [unfiltered, filtered] = await Promise.all([
      request("/api/projects", tokens.admin),
      request("/api/projects?q=Admin+Checklist+Needle", tokens.admin),
    ]);
    expect(filtered.status).toBe(200);
    expect(ids(filtered.body)).toEqual([adminChecklistId]);
    expect(filtered.body.search).toEqual({ query: "Admin Checklist Needle", matching: 1, total: ids(unfiltered.body).length });
    expect(filtered.body.board).toEqual(unfiltered.body.board);
    expect(boardIds(filtered.body)).toEqual(boardIds(unfiltered.body));
  });

  it("photographer search cannot match an unassigned project and reports the authorized total", async () => {
    const [unfiltered, filtered] = await Promise.all([
      request("/api/projects", tokens.photographer),
      request("/api/projects?q=needle", tokens.photographer),
    ]);
    expect(ids(unfiltered.body)).toEqual([photographerVisibleId]);
    expect(ids(filtered.body)).toEqual([photographerVisibleId]);
    expect(filtered.body.search).toEqual({ query: "needle", matching: 1, total: 1 });
    expect(ids(filtered.body)).not.toContain(photographerHiddenId);
    expect(filtered.body.board).toEqual(unfiltered.body.board);
  });

  it("external checklist matching is visible-project-only, exact-counted, and keeps the full Board envelope", async () => {
    const [unfiltered, filtered] = await Promise.all([
      request("/api/projects", tokens.external),
      request("/api/projects?q=External+Checklist+Needle", tokens.external),
    ]);
    expect(ids(unfiltered.body).sort()).toEqual([externalOtherId, externalVisibleId].sort());
    expect(ids(filtered.body)).toEqual([externalVisibleId]);
    expect(filtered.body.search).toEqual({ query: "External Checklist Needle", matching: 1, total: 2 });
    expect(filtered.body.board).toEqual(unfiltered.body.board);
    expect(boardIds(filtered.body).sort()).toEqual([externalOtherId, externalVisibleId].sort());
    expect(boardIds(filtered.body)).not.toContain(externalHiddenId);
  });

  it("treats percent and underscore literally, and caps a 201-character q to 200 code points", async () => {
    const literal = await request(`/api/projects?q=${encodeURIComponent("100%_literal")}`, tokens.admin);
    expect(ids(literal.body)).toContain(literalId);
    expect(ids(literal.body)).not.toContain(literalPercentControlId);
    expect(ids(literal.body)).not.toContain(literalUnderscoreControlId);

    const capped = await request(`/api/projects?q=${"z".repeat(DASHBOARD_SEARCH_MAX_CHARS + 1)}`, tokens.admin);
    expect(capped.status).toBe(200);
    expect((capped.body.search as { query: string }).query).toBe("z".repeat(DASHBOARD_SEARCH_MAX_CHARS));
    expect(ids(capped.body)).toEqual([cappedId]);
  });
});
