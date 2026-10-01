import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * `/api/projects`'s shared Dashboard Filter -- #428: `stages`, `priority`, `archived`. Seam A: the
 * wire contract, the Archived authorisation (role matrix, including the External Editor early
 * return), and the invariant that Stage/Priority narrow the rows but never the authorised Board
 * order or the `total`.
 */

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;

const adminId = "82111111-1111-4111-8111-111111111111";
const photographerId = "82222222-2222-4222-8222-222222222222";
const editorId = "82333333-3333-4333-8333-333333333333";
const externalId = "82444444-4444-4444-8444-444444444444";
const tokens = { admin: "tb428-admin", photographer: "tb428-photographer", editor: "tb428-editor", external: "tb428-external" };

const id = (n: number) => `82a00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Active internal Projects across Stages and priorities.
const awaitingP5 = id(1);
const awaitingNone = id(2);
const rawReviewP5 = id(3);
const rawReviewP2 = id(4);
const editingP5 = id(5); // stored `editing_autohdr`
const editedReviewNone = id(6);
const deliveredP1 = id(7);
// Archived Projects.
const archivedAwaitingP5 = id(8);
const archivedEditingNone = id(9);
const archivedDeliveredP3 = id(10);
// A Project the photographer is a member of, and an External Editor's own.
const photographerAwaiting = id(11);
const externalAwaiting = id(12);
const externalEditing = id(13);
const externalArchived = id(14);
const ACTIVE = [awaitingP5, awaitingNone, rawReviewP5, rawReviewP2, editingP5, editedReviewNone, deliveredP1];
const ARCHIVED = [archivedAwaitingP5, archivedEditingNone, archivedDeliveredP3];

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

type ProjectsBody = {
  projects: Array<{ id: string; stageKey: string; priority?: number | null; archivedAt?: string | null }>;
  board: { orderedProjectIdsByStage: Record<string, string[]> };
  search?: { query: string; matching: number; total: number };
  error?: string; code?: string; capability?: string;
};

async function request(path: string, token: string): Promise<{ status: number; body: ProjectsBody }> {
  const response = await SELF.fetch(`https://portal.test${path}`, { headers: { cookie: await cookie(token) } });
  return { status: response.status, body: await response.json() as ProjectsBody };
}

const idsOf = (body: ProjectsBody) => body.projects.map((project) => project.id);
const mine = (ids: string[]) => ids.filter((projectId) => projectId.startsWith("82a00000"));

async function insertUser(userId: string, role: string, token: string): Promise<void> {
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(userId, `${role} Filter`, `${userId}@filter.test`, role, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, userId, now, now),
  ]);
}

async function insertProject(projectId: string, street: string, stage: string, priority: number | null, archived = false): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, priority, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(projectId, street, stage, priority, archived ? now : null, now, now).run();
}

async function insertMember(projectId: string, userId: string, roleOnProject: "editor" | "photographer"): Promise<void> {
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), projectId, userId, roleOnProject, Date.now()).run();
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await insertUser(adminId, "admin", tokens.admin);
  await insertUser(photographerId, "photographer", tokens.photographer);
  await insertUser(editorId, "editor", tokens.editor);
  await insertUser(externalId, "external_editor", tokens.external);

  await insertProject(awaitingP5, "1 Filter Street", "awaiting_raw", 5);
  await insertProject(awaitingNone, "2 Filter Street", "awaiting_raw", null);
  await insertProject(rawReviewP5, "3 Filter Street", "raw_review", 5);
  await insertProject(rawReviewP2, "4 Filter Street", "raw_review", 2);
  await insertProject(editingP5, "5 Filter Street", "editing_autohdr", 5);
  await insertProject(editedReviewNone, "6 Filter Street", "edited_review", null);
  await insertProject(deliveredP1, "7 Filter Street", "delivered", 1);
  await insertProject(archivedAwaitingP5, "8 Archived Filter Street", "awaiting_raw", 5, true);
  await insertProject(archivedEditingNone, "9 Archived Filter Street", "editing_autohdr", null, true);
  await insertProject(archivedDeliveredP3, "10 Archived Filter Street", "delivered", 3, true);
  await insertProject(photographerAwaiting, "11 Photographer Filter Street", "awaiting_raw", 4);
  await insertMember(photographerAwaiting, photographerId, "photographer");
  await insertProject(externalAwaiting, "12 External Filter Street", "awaiting_raw", 5);
  await insertMember(externalAwaiting, externalId, "editor");
  await insertProject(externalEditing, "13 External Filter Street", "editing_autohdr", 5);
  await insertMember(externalEditing, externalId, "editor");
  await insertProject(externalArchived, "14 External Archived Filter Street", "awaiting_raw", 5, true);
  await insertMember(externalArchived, externalId, "editor");
});

describe("/api/projects — Stage and Priority filters (#428)", () => {
  it("filters by Stage, with `editing` standing for the stored editing_autohdr (Admin sees the stored key)", async () => {
    const raw = await request("/api/projects?stages=raw_review", tokens.admin);
    expect(raw.status).toBe(200);
    expect(mine(idsOf(raw.body)).sort()).toEqual([rawReviewP5, rawReviewP2].sort());
    const editing = await request("/api/projects?stages=editing", tokens.admin);
    expect(mine(idsOf(editing.body)).sort()).toEqual([editingP5, externalEditing].sort());
    expect(editing.body.projects.every((project) => project.stageKey === "editing_autohdr")).toBe(true);
    // A non-Admin sees the presentation key.
    const asEditor = await request("/api/projects?stages=editing", tokens.editor);
    expect(mine(idsOf(asEditor.body)).sort()).toEqual([editingP5, externalEditing].sort());
    expect(asEditor.body.projects.every((project) => project.stageKey === "editing")).toBe(true);
  });

  it("any-of across Stages", async () => {
    const { body } = await request("/api/projects?stages=awaiting_raw,delivered", tokens.admin);
    expect(mine(idsOf(body)).sort()).toEqual([awaitingP5, awaitingNone, deliveredP1, photographerAwaiting, externalAwaiting].sort());
  });

  it("filters by Project priority; `none` is an unset priority, never a rating", async () => {
    const five = await request("/api/projects?priority=5", tokens.admin);
    expect(mine(idsOf(five.body)).sort()).toEqual([awaitingP5, rawReviewP5, editingP5, externalAwaiting, externalEditing].sort());
    const none = await request("/api/projects?priority=none", tokens.admin);
    expect(mine(idsOf(none.body)).sort()).toEqual([awaitingNone, editedReviewNone].sort());
    const anyOf = await request("/api/projects?priority=2,none", tokens.admin);
    expect(mine(idsOf(anyOf.body)).sort()).toEqual([awaitingNone, rawReviewP2, editedReviewNone].sort());
  });

  it("Stage AND Priority intersect, and intersect with q", async () => {
    const both = await request("/api/projects?stages=awaiting_raw&priority=5", tokens.admin);
    expect(mine(idsOf(both.body)).sort()).toEqual([awaitingP5, externalAwaiting].sort());
    const withQ = await request("/api/projects?stages=awaiting_raw&priority=5&q=1+Filter", tokens.admin);
    expect(mine(idsOf(withQ.body))).toEqual([awaitingP5]);
  });

  it("a facet-only filter carries the counts envelope: matching is the narrowed count, total the authorised set", async () => {
    const unfiltered = await request("/api/projects", tokens.admin);
    expect(unfiltered.body.search).toBeUndefined();
    const { body } = await request("/api/projects?priority=5", tokens.admin);
    expect(body.search).toEqual({ query: "", matching: body.projects.length, total: unfiltered.body.projects.length });
    expect(body.search!.matching).toBeLessThan(body.search!.total);
  });

  it("never changes the authorised Board order: boardRank is not a rank within the filtered set", async () => {
    const unfiltered = await request("/api/projects", tokens.admin);
    for (const query of ["priority=5", "stages=raw_review", "stages=editing&priority=5", "priority=none", "stages=awaiting_raw,delivered&priority=1,5"]) {
      const filtered = await request(`/api/projects?${query}`, tokens.admin);
      expect(filtered.body.board, query).toEqual(unfiltered.body.board);
    }
    // And the order the rows come back in is the unfiltered order, restricted.
    const filtered = await request("/api/projects?priority=5", tokens.admin);
    const unfilteredOrder = idsOf(unfiltered.body).filter((projectId) => idsOf(filtered.body).includes(projectId));
    expect(idsOf(filtered.body)).toEqual(unfilteredOrder);
  });

  it("an empty narrowing result is a 200 with matching 0", async () => {
    const { status, body } = await request("/api/projects?stages=delivered&priority=5", tokens.admin);
    expect(status).toBe(200);
    expect(mine(idsOf(body))).toEqual([]);
    expect(body.search!.matching).toBe(0);
  });

  it("applies to a photographer's scoped set too", async () => {
    const all = await request("/api/projects?priority=4", tokens.photographer);
    expect(mine(idsOf(all.body))).toEqual([photographerAwaiting]);
    const none = await request("/api/projects?priority=5", tokens.photographer);
    expect(mine(idsOf(none.body))).toEqual([]);
  });
});

describe("/api/projects — Archived Hide/Include/Only (#428)", () => {
  it("Hide is the default: no archived Project", async () => {
    const { body } = await request("/api/projects", tokens.admin);
    for (const projectId of ARCHIVED) expect(idsOf(body)).not.toContain(projectId);
    for (const projectId of ACTIVE) expect(idsOf(body)).toContain(projectId);
  });

  it("Only returns the archived Projects and no Board mutation envelope", async () => {
    const { status, body } = await request("/api/projects?archived=only", tokens.admin);
    expect(status).toBe(200);
    expect(mine(idsOf(body)).sort()).toEqual([...ARCHIVED, externalArchived].sort());
    expect(body.projects.every((project) => typeof project.archivedAt === "string")).toBe(true);
    expect(body.board.orderedProjectIdsByStage).toEqual({});
  });

  it("the pre-#428 archived=1 spelling still means Only for an Admin", async () => {
    const legacy = await request("/api/projects?archived=1", tokens.admin);
    const only = await request("/api/projects?archived=only", tokens.admin);
    expect(idsOf(legacy.body)).toEqual(idsOf(only.body));
  });

  it("Include returns both, and the Board envelope is built from ACTIVE rows only", async () => {
    const hide = await request("/api/projects", tokens.admin);
    const include = await request("/api/projects?archived=include", tokens.admin);
    expect(include.status).toBe(200);
    for (const projectId of [...ACTIVE, ...ARCHIVED]) expect(idsOf(include.body)).toContain(projectId);
    expect(include.body.board).toEqual(hide.body.board);
    const boardIds = Object.values(include.body.board.orderedProjectIdsByStage).flat();
    for (const projectId of ARCHIVED) expect(boardIds).not.toContain(projectId);
  });

  it("the counts total is the authorised set within the archive mode", async () => {
    const include = await request("/api/projects?archived=include&priority=5", tokens.admin);
    const includeAll = await request("/api/projects?archived=include", tokens.admin);
    expect(include.body.search!.total).toBe(includeAll.body.projects.length);
    const only = await request("/api/projects?archived=only&priority=5", tokens.admin);
    expect(only.body.search!.total).toBe(ARCHIVED.length + 1);
    expect(mine(idsOf(only.body)).sort()).toEqual([archivedAwaitingP5, externalArchived].sort());
  });

  it("combines with Stage, Priority and q", async () => {
    const { body } = await request("/api/projects?archived=include&stages=awaiting_raw&priority=5&q=Archived", tokens.admin);
    expect(mine(idsOf(body)).sort()).toEqual([archivedAwaitingP5, externalArchived].sort());
    const editing = await request("/api/projects?archived=only&stages=editing", tokens.admin);
    expect(mine(idsOf(editing.body))).toEqual([archivedEditingNone]);
  });

  it("is Admin only, enforced on the server: every other role is refused with 403, never a silent fallback", async () => {
    for (const mode of ["include", "only", "1"]) {
      for (const token of [tokens.photographer, tokens.editor, tokens.external]) {
        const { status, body } = await request(`/api/projects?archived=${mode}`, token);
        expect(status, `${mode} ${token}`).toBe(403);
        expect(body.capability).toBe("adminBackend");
        expect(body.projects).toBeUndefined();
      }
    }
    // The default still works for them.
    for (const token of [tokens.photographer, tokens.editor, tokens.external]) expect((await request("/api/projects", token)).status).toBe(200);
  });
});

describe("/api/projects — validation (#428)", () => {
  it("rejects malformed filters with 400 for every role, before any role branch", async () => {
    for (const query of [
      "archived=hide", "archived=0", "archived=", "archived=nope", "archived=only&archived=include",
      "stages=", "stages=nope", "stages=editing_autohdr", "stages=editing,editing", "stages=editing,", "stages=editing&stages=delivered",
      "priority=", "priority=6", "priority=0", "priority=5,5", "priority=high", "priority=5&priority=4",
    ]) {
      for (const token of [tokens.admin, tokens.editor, tokens.external]) {
        const { status, body } = await request(`/api/projects?${query}`, token);
        expect(status, `${query} ${token}`).toBe(400);
        expect(body.code).toBe("project_filter_invalid");
      }
    }
  });
});

describe("/api/projects — External Editor (#428)", () => {
  it("filters by Stage with the presentation key, narrowing matching but not total", async () => {
    const unfiltered = await request("/api/projects", tokens.external);
    expect(mine(idsOf(unfiltered.body)).sort()).toEqual([externalAwaiting, externalEditing].sort());
    const { status, body } = await request("/api/projects?stages=editing", tokens.external);
    expect(status).toBe(200);
    expect(idsOf(body)).toEqual([externalEditing]);
    expect(body.projects[0]!.stageKey).toBe("editing");
    expect(body.search).toEqual({ query: "", matching: 1, total: 2 });
    expect(body.board).toEqual(unfiltered.body.board);
  });

  it("refuses a Priority filter: the external DTO withholds priority, so matches must not reveal it", async () => {
    const { status, body } = await request("/api/projects?priority=5", tokens.external);
    expect(status).toBe(400);
    expect(body.code).toBe("project_filter_priority_unavailable");
    expect(body.projects).toBeUndefined();
  });
});
