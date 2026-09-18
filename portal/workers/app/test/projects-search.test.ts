import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * `/api/projects`'s `q` -- #217. Mirrors `production-calendar.integration.test.ts`'s own seeding
 * idiom (direct D1 inserts against the migrated schema, one shared fixture for the whole file).
 */

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;

const adminId = "81111111-1111-4111-8111-111111111111";
const photographerId = "81222222-2222-4222-8222-222222222222";
const externalEditorId = "81333333-3333-4333-8333-333333333333";
const tokens = { admin: "tb217-search-admin", photographer: "tb217-search-photographer", external: "tb217-search-external" };

// Every field the matcher covers, one project each, plus a control with none matching.
const streetMatchId = "81a00000-0000-4000-8000-000000000001";
const suburbMatchId = "81a00000-0000-4000-8000-000000000002";
const agencyMatchId = "81a00000-0000-4000-8000-000000000003";
const agentMatchId = "81a00000-0000-4000-8000-000000000004";
const checklistOnlyMatchId = "81a00000-0000-4000-8000-000000000005";
const noMatchId = "81a00000-0000-4000-8000-000000000006";
const photographerVisibleId = "81a00000-0000-4000-8000-000000000007"; // photographer IS a member
const photographerHiddenId = "81a00000-0000-4000-8000-000000000008"; // photographer is NOT a member
const archivedMatchId = "81a00000-0000-4000-8000-000000000009";
const metacharMatchId = "81a00000-0000-4000-8000-00000000000a";
const metacharPercentControlId = "81a00000-0000-4000-8000-00000000000b"; // would falsely match a `%` LIKE wildcard
const metacharUnderscoreControlId = "81a00000-0000-4000-8000-00000000000c"; // would falsely match a `_` LIKE wildcard
const externalVisibleChecklistId = "81a00000-0000-4000-8000-00000000000d"; // external IS a member, checklist-title-only match
const externalOtherVisibleId = "81a00000-0000-4000-8000-00000000000e"; // external IS a member, no match -- makes total > matching
const externalHiddenChecklistId = "81a00000-0000-4000-8000-00000000000f"; // external is NOT a member, checklist title would match

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
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(id, `${role} Search`, `${id}@search.test`, role, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, id, now, now),
  ]);
}

async function insertProject(id: string, fields: { street: string; suburb?: string; agencyName?: string; agentName?: string; stage?: string; archived?: boolean }): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, suburb, agency_name, agent_name, stage_key, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, fields.street, fields.suburb ?? null, fields.agencyName ?? null, fields.agentName ?? null, fields.stage ?? "editing_autohdr", fields.archived ? now : null, now, now).run();
}

async function insertMember(projectId: string, userId: string, roleOnProject: "editor" | "photographer"): Promise<void> {
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), projectId, userId, roleOnProject, Date.now()).run();
}

async function insertSubtask(projectId: string, title: string): Promise<void> {
  await database.DB.prepare("INSERT INTO project_subtasks (id, project_id, title, done, position, assignment_version, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?)")
    .bind(crypto.randomUUID(), projectId, title, adminId, Date.now(), Date.now()).run();
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await insertUser(adminId, "admin", tokens.admin);
  await insertUser(photographerId, "photographer", tokens.photographer);
  await insertUser(externalEditorId, "external_editor", tokens.external);

  await insertProject(streetMatchId, { street: "12 Harbour View Road", suburb: "Manly" });
  await insertProject(suburbMatchId, { street: "1 Other Street", suburb: "Harbourside" });
  await insertProject(agencyMatchId, { street: "2 Other Street", agencyName: "Harbour Realty" });
  await insertProject(agentMatchId, { street: "3 Other Street", agentName: "Harbour Agent" });
  await insertProject(checklistOnlyMatchId, { street: "4 Plain Street" });
  await insertSubtask(checklistOnlyMatchId, "Deliver to harbour office");
  await insertProject(noMatchId, { street: "5 Nowhere Street", suburb: "Elsewhere", agencyName: "Other Agency", agentName: "Other Agent" });
  await insertSubtask(noMatchId, "Unrelated checklist item");
  // `PHOTOGRAPHER_VISIBLE_STAGES` is `["awaiting_raw", "raw_review"]` -- the default
  // `editing_autohdr` every other fixture above uses would be invisible to a photographer
  // regardless of membership, which is not what this fixture is testing.
  await insertProject(photographerVisibleId, { street: "6 Photographer Harbour Street", stage: "awaiting_raw" });
  await insertMember(photographerVisibleId, photographerId, "photographer");
  await insertProject(photographerHiddenId, { street: "7 Photographer-Hidden Harbour Street", stage: "awaiting_raw" });
  await insertProject(archivedMatchId, { street: "8 Archived Harbour Street", archived: true });
  await insertProject(metacharMatchId, { street: "9 100%_off Harbour Street" });
  await insertProject(metacharPercentControlId, { street: "9a 100xxxoff Harbour Street" });
  await insertProject(metacharUnderscoreControlId, { street: "9b 100Xoff Harbour Street" });

  // External visibility requires a `project_members` row with role_on_project = "editor"
  // (`visible-project-scope.ts`'s own `visibleProjectWhere`) -- membership, not stage, is what
  // gates these three.
  await insertProject(externalVisibleChecklistId, { street: "10 Plain External Street" });
  await insertMember(externalVisibleChecklistId, externalEditorId, "editor");
  await insertSubtask(externalVisibleChecklistId, "Upload externallyvisibleneedle photos");
  await insertProject(externalOtherVisibleId, { street: "11 Other External Street" });
  await insertMember(externalOtherVisibleId, externalEditorId, "editor");
  await insertProject(externalHiddenChecklistId, { street: "12 Hidden External Street" });
  await insertSubtask(externalHiddenChecklistId, "Upload externallyvisibleneedle photos");
});

describe("/api/projects — q (#217)", () => {
  it("matches street case-insensitively", async () => {
    const { status, body } = await request("/api/projects?q=HARBOUR", tokens.admin);
    expect(status).toBe(200);
    const projects = body.projects as Array<{ id: string }>;
    expect(projects.some((p) => p.id === streetMatchId)).toBe(true);
    expect((body.search as { matching: number }).matching).toBeGreaterThan(0);
  });

  it("matches suburb case-insensitively", async () => {
    const { body } = await request("/api/projects?q=harbourside", tokens.admin);
    const ids = (body.projects as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(suburbMatchId);
  });

  it("matches agency_name case-insensitively", async () => {
    const { body } = await request("/api/projects?q=REALTY", tokens.admin);
    const ids = (body.projects as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(agencyMatchId);
  });

  it("matches agent_name case-insensitively", async () => {
    const { body } = await request("/api/projects?q=Harbour+Agent", tokens.admin);
    const ids = (body.projects as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(agentMatchId);
  });

  it("a checklist-title-only match returns the project exactly once, no duplicate rows from the join", async () => {
    const { body } = await request("/api/projects?q=office", tokens.admin);
    const ids = (body.projects as Array<{ id: string }>).map((p) => p.id);
    expect(ids.filter((id) => id === checklistOnlyMatchId)).toHaveLength(1);
  });

  it("percent and underscore match literally, not as LIKE wildcards", async () => {
    // Backslash is deliberately excluded from this query: it is one of the "unsafe" characters
    // `normalizeProjectListSearch` strips server-side (the same class `sanitizeDashboardCalendarSearch`
    // strips client-side), so a backslash in `q` never reaches the matcher at all -- there is no
    // escaping surface to test at the query level. `instr()` itself has no metacharacters either
    // way (the reason this route never uses `LIKE`), which is what this test actually exercises:
    // `%` and `_` inside the SEARCHED text must match only that literal substring, not act as a
    // LIKE wildcard against the control fixtures that would otherwise falsely match.
    const { body } = await request(`/api/projects?q=${encodeURIComponent("100%_off")}`, tokens.admin);
    const ids = (body.projects as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(metacharMatchId);
    expect(ids).not.toContain(metacharPercentControlId);
    expect(ids).not.toContain(metacharUnderscoreControlId);
  });

  it("a no-match q returns matching: 0 with an unchanged board.orderedProjectIdsByStage", async () => {
    const [unfiltered, filtered] = await Promise.all([
      request("/api/projects", tokens.admin),
      request("/api/projects?q=zzz-does-not-exist-zzz", tokens.admin),
    ]);
    expect((filtered.body.search as { matching: number; total: number }).matching).toBe(0);
    expect((filtered.body.search as { total: number }).total).toBe((unfiltered.body.board as object) && (unfiltered.body.projects as unknown[]).length);
    expect(filtered.body.board).toEqual(unfiltered.body.board);
    expect((filtered.body.projects as unknown[])).toHaveLength(0);
  });

  it("photographer scoping still applies -- a matching project outside membership never appears", async () => {
    const { body } = await request("/api/projects?q=harbour", tokens.photographer);
    const ids = (body.projects as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(photographerVisibleId);
    expect(ids).not.toContain(photographerHiddenId);
  });

  it("archived=1 combines with q", async () => {
    const { body } = await request("/api/projects?archived=1&q=harbour", tokens.admin);
    const ids = (body.projects as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toContain(archivedMatchId);
    expect(ids).not.toContain(streetMatchId); // active-only match must not leak into archived scope
  });

  it("truncates a 500-character q to 200 code points rather than rejecting it", async () => {
    const long = "a".repeat(500);
    const { status, body } = await request(`/api/projects?q=${long}`, tokens.admin);
    expect(status).toBe(200);
    expect((body.search as { query: string }).query.length).toBe(200);
  });

  it("keeps ordering identical to the unfiltered run, restricted to the matching subset", async () => {
    const [unfiltered, filtered] = await Promise.all([
      request("/api/projects", tokens.admin),
      request("/api/projects?q=harbour", tokens.admin),
    ]);
    const unfilteredIds = (unfiltered.body.projects as Array<{ id: string }>).map((p) => p.id);
    const filteredIds = (filtered.body.projects as Array<{ id: string }>).map((p) => p.id);
    expect(filteredIds).toEqual(unfilteredIds.filter((id) => filteredIds.includes(id)));
  });

  it("omits `search` from the response entirely when no q was supplied", async () => {
    const { body } = await request("/api/projects", tokens.admin);
    expect(body.search).toBeUndefined();
  });
});

describe("/api/projects — q, external_editor checklist-title matching (#217 follow-up)", () => {
  it("a title-only match on a visible project is present, with correct counts", async () => {
    const { status, body } = await request("/api/projects?q=externallyvisibleneedle", tokens.external);
    expect(status).toBe(200);
    const ids = (body.projects as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toEqual([externalVisibleChecklistId]);
    expect(body.search).toMatchObject({ matching: 1 });
    // total counts the external's full authorised (member) set, not just the match --
    // `externalOtherVisibleId` is also a member project and must be counted there.
    expect((body.search as { total: number }).total).toBeGreaterThanOrEqual(2);
  });

  it("the identical title on a project the external is NOT a member of is absent, and not counted", async () => {
    const { body } = await request("/api/projects?q=externallyvisibleneedle", tokens.external);
    const ids = (body.projects as Array<{ id: string }>).map((p) => p.id);
    expect(ids).not.toContain(externalHiddenChecklistId);
    // Exactly one match (the visible project) despite two projects sharing the same checklist
    // title text -- the hidden one must not inflate `matching` or `total` either.
    expect(body.search).toMatchObject({ matching: 1 });
  });
});
