/**
 * #274 — the Gantt's Editor filter: the opt-in `facets=1` people list, and which editor ids count as
 * valid. Validity is "an active editor on a project this viewer can see", independent of the other
 * filters, so choosing a Stage an editor has no projects in narrows to nothing instead of silently
 * dropping the editor filter and widening the results.
 */
import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { adminProductionGanttResponseSchema, EXTERNAL_API_RESPONSE_SCHEMAS } from "@quincy/shared";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";

declare const __PORTAL_MIGRATION_SQL__: string;

const ids = {
  admin: "27400000-0000-4000-8000-000000000001",
  alice: "27400000-0000-4000-8000-00000000000a",
  bob: "27400000-0000-4000-8000-00000000000b",
  carolInactive: "27400000-0000-4000-8000-00000000000c",
  dave: "27400000-0000-4000-8000-00000000000d",
  eveArchivedOnly: "27400000-0000-4000-8000-00000000000e",
  photographer: "27400000-0000-4000-8000-00000000000f",
  external: "27400000-0000-4000-8000-000000000010",
  unknown: "27400000-0000-4000-8000-0000000000ff",
  editingProject: "27400000-0000-4000-8000-0000000000a1",
  rawReviewProject: "27400000-0000-4000-8000-0000000000a2",
  deliveredProject: "27400000-0000-4000-8000-0000000000a3",
  archivedProject: "27400000-0000-4000-8000-0000000000a4",
  secondEditingProject: "27400000-0000-4000-8000-0000000000a5",
};
const tokens = { admin: "t274-gantt-admin", external: "t274-gantt-external" };

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

async function get(path: string, token = tokens.admin): Promise<Response> {
  return SELF.fetch(`https://portal.test${path}`, { headers: { cookie: await cookie(token) } });
}

async function page(query: string, token = tokens.admin) {
  const response = await get(`/api/production-gantt?${query}`, token);
  expect(response.status, query).toBe(200);
  return adminProductionGanttResponseSchema.parse(await response.json());
}

async function insertUser(id: string, name: string, role: string, active = true): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, 0, ?, ?)")
    .bind(id, name, `${id}@gantt-editor.test`, role, active ? 1 : 0, now, now).run();
}

async function insertSession(userId: string, token: string): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, userId, now, now).run();
}

async function insertProject(id: string, street: string, stage: string, shootDate: string): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, suburb, stage_key, shoot_date, created_at, updated_at) VALUES (?, ?, 'Suburb', ?, ?, ?, ?)").bind(id, street, stage, shootDate, now, now).run();
}

async function insertMember(projectId: string, userId: string, roleOnProject: "editor" | "photographer" = "editor"): Promise<void> {
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), projectId, userId, roleOnProject, Date.now()).run();
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await insertUser(ids.admin, "Admin Gantt", "admin");
  await insertSession(ids.admin, tokens.admin);
  await insertUser(ids.alice, "Alice Editor", "editor");
  await insertUser(ids.bob, "Bob Editor", "editor");
  await insertUser(ids.carolInactive, "Carol Inactive", "editor", false);
  await insertUser(ids.dave, "Dave Delivered", "editor");
  await insertUser(ids.eveArchivedOnly, "Eve Archived", "editor");
  await insertUser(ids.photographer, "Pat Photographer", "photographer");
  await insertUser(ids.external, "Xavier External", "external_editor");
  await insertSession(ids.external, tokens.external);

  await insertProject(ids.editingProject, "1 Editing Street", "editing_autohdr", "2026-08-01");
  await insertMember(ids.editingProject, ids.alice);
  await insertMember(ids.editingProject, ids.external);
  await insertMember(ids.editingProject, ids.photographer, "photographer");
  await insertProject(ids.secondEditingProject, "2 Editing Street", "editing_autohdr", "2026-08-02");
  await insertMember(ids.secondEditingProject, ids.bob);
  await insertProject(ids.rawReviewProject, "3 Review Street", "raw_review", "2026-08-03");
  await insertMember(ids.rawReviewProject, ids.bob);
  await insertMember(ids.rawReviewProject, ids.carolInactive);
  await insertProject(ids.deliveredProject, "4 Delivered Street", "delivered", "2026-08-04");
  await insertMember(ids.deliveredProject, ids.dave);
  await insertProject(ids.archivedProject, "5 Archived Street", "editing_autohdr", "2026-08-05");
  await insertMember(ids.archivedProject, ids.eveArchivedOnly);
  await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.archivedProject).run();
}, 60_000);

const projectIds = (response: { projects: Array<{ id: string }> }) => response.projects.map((row) => row.id).sort();

describe("production-gantt Editor filter (#274)", () => {
  it("facets=1 lists every active editor on a visible project, sorted by name, whatever the other filters", async () => {
    const expected = [
      { id: ids.alice, name: "Alice Editor", roleLabel: "Editor", isExternal: false, active: true },
      { id: ids.bob, name: "Bob Editor", roleLabel: "Editor", isExternal: false, active: true },
      { id: ids.dave, name: "Dave Delivered", roleLabel: "Editor", isExternal: false, active: true },
      { id: ids.external, name: "Xavier External", roleLabel: expect.any(String), isExternal: true, active: true },
    ];
    expect((await page("scope=active&facets=1")).filterFacets?.people).toEqual(expected);
    // Narrowing the view does not narrow the option list.
    expect((await page(`scope=active&facets=1&stages=raw_review&q=nothing-matches&editors=${ids.bob}`)).filterFacets?.people).toEqual(expected);
  });

  it("an external editor's list holds only the editors on their own projects", async () => {
    const response = await get("/api/production-gantt?scope=active&facets=1", tokens.external);
    expect(response.status).toBe(200);
    const body = EXTERNAL_API_RESPONSE_SCHEMAS.gantt.parse(await response.json());
    expect(body.filterFacets?.people.map((person) => person.id)).toEqual([ids.alice, ids.external]);
  });

  it("omits filterFacets without facets=1", async () => {
    const response = await get("/api/production-gantt?scope=active");
    expect(Object.keys(await response.json() as object)).not.toContain("filterFacets");
  });

  it("rejects facets on a continuation or child page, and any value but 1", async () => {
    const first = await page("scope=active&limit=1");
    expect(first.page.nextCursor).not.toBeNull();
    for (const query of [
      `scope=active&facets=1&cursor=${encodeURIComponent(first.page.nextCursor!)}`,
      `scope=active&facets=1&childrenOf=${ids.editingProject}`,
      "scope=active&facets=0",
      "scope=active&facets=",
      "scope=active&facets=1&facets=1",
    ]) {
      const response = await get(`/api/production-gantt?${query}`);
      expect(response.status, query).toBe(400);
    }
  });

  it("editors= narrows to that editor's projects and echoes the id", async () => {
    const response = await page(`scope=active&editors=${ids.alice}`);
    expect(projectIds(response)).toEqual([ids.editingProject]);
    expect(response.appliedFilters.editorIds).toEqual([ids.alice]);
  });

  it("an editor with no project in the chosen Stage narrows to nothing instead of dropping the filter", async () => {
    const response = await page(`scope=active&editors=${ids.alice}&stages=raw_review`);
    expect(response.projects).toEqual([]);
    expect(response.appliedFilters.editorIds).toEqual([ids.alice]);
  });

  it("drops an unknown id from the echo and ignores it", async () => {
    const mixed = await page(`scope=active&editors=${ids.alice},${ids.unknown}`);
    expect(projectIds(mixed)).toEqual([ids.editingProject]);
    expect(mixed.appliedFilters.editorIds).toEqual([ids.alice]);
    // Only unknown ids: no editor filter applies, exactly as for an out-of-scope real editor.
    const unknownOnly = await page(`scope=active&editors=${ids.unknown}`);
    const outOfScope = await page(`scope=active&editors=${ids.eveArchivedOnly}`);
    expect(unknownOnly.appliedFilters.editorIds).toEqual([]);
    expect(outOfScope.appliedFilters.editorIds).toEqual([]);
    expect(projectIds(unknownOnly)).toEqual(projectIds(await page("scope=active")));
    expect(projectIds(outOfScope)).toEqual(projectIds(unknownOnly));
  });

  it("echoes only valid ids on a continuation page too", async () => {
    const query = `scope=active&limit=1&editors=${ids.alice},${ids.bob},${ids.unknown}`;
    const first = await page(query);
    expect(first.appliedFilters.editorIds).toEqual([ids.alice, ids.bob]);
    const second = await page(`${query}&cursor=${encodeURIComponent(first.page.nextCursor!)}`);
    expect(second.appliedFilters.editorIds).toEqual([ids.alice, ids.bob]);
    expect(second.filterFacets).toBeUndefined();
  });
});
