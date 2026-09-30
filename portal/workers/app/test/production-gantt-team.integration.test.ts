import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { adminProductionGanttResponseSchema, editorProductionGanttResponseSchema, EXTERNAL_API_RESPONSE_SCHEMAS } from "@quincy/shared";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

// #365. A file of its own (not `production-gantt.integration.test.ts`): that file's density
// fixtures leave ~20k checklist rows in its D1, which makes a `q` search there take minutes.

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";

const adminId = "83111111-1111-4111-8111-111111111111";
const editorId = "83222222-2222-4222-8222-222222222222";
const tokens = { admin: "tb365-gantt-admin", editor: "tb365-gantt-editor", external: "tb365-team-external" };

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

async function insertProject(id: string, street: string, stage: string, shootDate: string | null = null): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, suburb, stage_key, shoot_date, created_at, updated_at) VALUES (?, ?, 'Suburb', ?, ?, ?, ?)").bind(id, street, stage, shootDate, now, now).run();
}

async function insertMember(projectId: string, userId: string, roleOnProject: "editor" | "photographer"): Promise<void> {
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), projectId, userId, roleOnProject, Date.now()).run();
}

// The row's Project team (display-only) and canEditTeam, opt-in via `team=1`.
describe("#365: Project team on Gantt rows (team=1)", () => {
  const teamProjectId = "81555555-5555-4555-8555-555555555501";
  const teamDeliveredProjectId = "81555555-5555-4555-8555-555555555502";
  const ids = {
    photographer: "81555555-5555-4555-8555-5555555555a1",
    editorB: "81555555-5555-4555-8555-5555555555a2",
    editorA: "81555555-5555-4555-8555-5555555555a3",
    inactive: "81555555-5555-4555-8555-5555555555a4",
    both: "81555555-5555-4555-8555-5555555555a5",
    external: "81555555-5555-4555-8555-5555555555a6",
  };
  const allowedKeys = ["active", "id", "isExternal", "name", "roleLabel", "roleOnProject"];

  beforeAll(async () => {
    await executeSql(__PORTAL_MIGRATION_SQL__);
    const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'admin Gantt', ?, 1, 'admin', 1, 0, ?, ?)").bind(adminId, `${adminId}@gantt.test`, now, now),
      database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, tokens.admin, adminId, now, now),
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'editor Gantt', ?, 1, 'editor', 1, 0, ?, ?)").bind(editorId, `${editorId}@gantt.test`, now, now),
      database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, tokens.editor, editorId, now, now),
    ]);
    const user = (id: string, name: string, role: string, active: number) =>
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, 0, ?, ?)").bind(id, name, `${id}@team.test`, role, active, now, now);
    await database.DB.batch([
      user(ids.photographer, "Pia Photographer", "photographer", 1),
      user(ids.editorB, "Bea Editor", "editor", 1),
      user(ids.editorA, "Abe Editor", "editor", 1),
      user(ids.inactive, "Zed Inactive", "editor", 0),
      user(ids.both, "Cal Both", "editor", 1),
      user(ids.external, "Xena External", "external_editor", 1),
      database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, tokens.external, ids.external, now, now),
    ]);
    await insertProject(teamProjectId, "365 Team Street", "editing_autohdr", "2026-08-25");
    await insertProject(teamDeliveredProjectId, "366 Team Delivered Street", "delivered", "2026-08-19");
    for (const projectId of [teamProjectId, teamDeliveredProjectId]) {
      await insertMember(projectId, ids.editorB, "editor");
      await insertMember(projectId, ids.photographer, "photographer");
      await insertMember(projectId, ids.editorA, "editor");
      await insertMember(projectId, ids.inactive, "editor");
      await insertMember(projectId, ids.both, "editor");
      await insertMember(projectId, ids.both, "photographer");
    }
    await insertMember(teamProjectId, ids.external, "editor");
  });

  type TeamBody = { projects: Array<{ id: string; team?: Array<Record<string, unknown>>; permissions: Record<string, unknown> }> };
  const teamPage = async (token: string, extra = "") => (await (await request(`/api/production-gantt?scope=active&team=1${extra}`, token)).json()) as TeamBody;
  const projectIn = (body: TeamBody, id: string) => body.projects.find((project) => project.id === id)!;

  it("W1 admin: every membership, both roles, inactive included, photographer then editor then name then id", async () => {
    const body = await teamPage(tokens.admin, "&delivered=1");
    adminProductionGanttResponseSchema.parse(body);
    const row = projectIn(body, teamProjectId);
    expect(row.team!.map((member) => [member.name, member.roleOnProject])).toEqual([
      ["Cal Both", "photographer"],
      ["Pia Photographer", "photographer"],
      ["Abe Editor", "editor"],
      ["Bea Editor", "editor"],
      ["Cal Both", "editor"],
      ["Xena External", "editor"],
      ["Zed Inactive", "editor"],
    ]);
    expect(row.team!.find((member) => member.name === "Zed Inactive")).toMatchObject({ active: false, roleLabel: "Editor", isExternal: false });
    expect(row.team!.find((member) => member.name === "Xena External")).toMatchObject({ isExternal: true });
    for (const member of row.team!) expect(Object.keys(member).sort()).toEqual(allowedKeys);
    expect(row.permissions).toMatchObject({ canEditTeam: true, canEditDeadline: true });
    const delivered = projectIn(body, teamDeliveredProjectId);
    expect(delivered.permissions).toMatchObject({ canEditTeam: true, canEditDeadline: false });
  });

  it("W2 internal editor: same team, cannot edit", async () => {
    const body = await teamPage(tokens.editor);
    editorProductionGanttResponseSchema.parse(body);
    const row = projectIn(body, teamProjectId);
    expect(row.team).toHaveLength(7);
    expect(row.permissions).toMatchObject({ canEditTeam: false, canEditDeadline: false });
  });

  it("W3 external editor: only assigned projects, cannot edit, only the six fields", async () => {
    const body = await teamPage(tokens.external, "&delivered=1");
    EXTERNAL_API_RESPONSE_SCHEMAS.gantt.parse(body);
    expect(body.projects.map((project) => project.id)).toContain(teamProjectId);
    expect(body.projects.map((project) => project.id)).not.toContain(teamDeliveredProjectId);
    const row = projectIn(body, teamProjectId);
    expect(row.permissions).toMatchObject({ canEditTeam: false, canEditDeadline: false });
    for (const member of row.team!) expect(Object.keys(member).sort()).toEqual(allowedKeys);
  });

  it("W4 without team=1 no row carries team or canEditTeam (old bundles' strict decoders)", async () => {
    const body = (await (await request("/api/production-gantt?scope=active&delivered=1", tokens.admin)).json()) as TeamBody;
    expect(body.projects.length).toBeGreaterThan(0);
    for (const project of body.projects) {
      expect(Object.keys(project)).not.toContain("team");
      expect(Object.keys(project.permissions)).not.toContain("canEditTeam");
    }
  });

  it("W5 external parity: each Gantt team entry equals the same external's Project detail member", async () => {
    const gantt = projectIn(await teamPage(tokens.external), teamProjectId);
    const detail = (await (await request(`/api/projects/${teamProjectId}`, tokens.external)).json()) as { members: Array<Record<string, unknown>> };
    const project = (member: Record<string, unknown>) => ({ id: member.id, name: member.name, roleLabel: member.roleLabel, isExternal: member.isExternal, active: member.active, roleOnProject: member.roleOnProject });
    const key = (member: Record<string, unknown>) => `${member.id}:${member.roleOnProject}`;
    const expected = detail.members.map(project).sort((a, b) => key(a).localeCompare(key(b)));
    const actual = [...gantt.team!].sort((a, b) => key(a).localeCompare(key(b)));
    expect(actual).toEqual(expected);
  });
});
