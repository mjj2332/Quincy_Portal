import { env } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import app from "../src/index";
import type { Env } from "../src/env";

/**
 * #455: an archived Project's details are read-only. PATCH /projects/:id answers 409 `details_project_archived` before it touches
 * a column, the audit log, the activity feed or `updated_at`, including when the archive lands inside the batch. Archived wins over the
 * services-blocked 409. POST /projects/:id/sync-dropbox answers 409 `dropbox_sync_project_archived` before it enqueues anything.
 */
const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminId = "b1111111-1111-4111-8111-111111111111";
const editorId = "b2222222-2222-4222-8222-222222222222";
const tokens = { admin: "det-admin-token", editor: "det-editor-token" } as const;
type Who = keyof typeof tokens;
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); } }
async function cookie(token: string) { const context = await createAuth(baseEnv).$context; return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`; }

/** Runs the real app. `racingArchive` swaps in a D1 whose first multi-statement batch archives that Project, then runs the real batch. */
async function call(who: Who, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, racingArchive?: string) {
  const waits: Promise<unknown>[] = [];
  const executionContext = { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); }, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
  const race = { flipped: 0 };
  const db = racingArchive ? new Proxy(database.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!race.flipped && statements.length >= 2) {
            race.flipped += 1;
            await target.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), racingArchive).run();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database : database.DB;
  const headers = new Headers({ cookie: await cookie(tokens[who]) });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (method !== "GET") headers.set("origin", baseEnv.APP_ORIGIN);
  const response = await app.fetch(new Request(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { ...baseEnv, DB: db } as Env, executionContext);
  await Promise.all(waits);
  return { response, flipped: race.flipped };
}

async function seedProject(archived: boolean): Promise<string> {
  const projectId = crypto.randomUUID(); const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'Original Street', 'editing_autohdr', 0, ?, ?)").bind(projectId, now, now),
    database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, editorId, now),
  ]);
  if (archived) await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), projectId).run();
  return projectId;
}

/** Everything a details write can touch, for one Project. Compared whole before and after a refused write. */
async function footprint(projectId: string) {
  const all = async (sql: string, ...binds: unknown[]) => (await database.DB.prepare(sql).bind(...binds).all()).results;
  return {
    project: await all("SELECT street, suburb, updated_at FROM projects WHERE id = ?", projectId),
    audit: await all("SELECT id, action FROM audit_log WHERE target_id = ? ORDER BY id", projectId),
    activity: await all("SELECT id FROM project_activity_events WHERE project_id = ? ORDER BY id", projectId),
    collections: await all("SELECT id, kind FROM collections WHERE project_id = ? ORDER BY id", projectId),
    jobs: await all("SELECT id FROM jobs WHERE project_id = ? ORDER BY id", projectId),
  };
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__); const now = Date.now();
  for (const [id, role] of [[adminId, "admin"], [editorId, "editor"]]) await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)").bind(id, `${role} ${id.slice(0, 4)}`, `${id}@example.test`, role, now, now).run();
  for (const [token, userId] of [[tokens.admin, adminId], [tokens.editor, editorId]]) await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, userId, now, now).run();
});

const DETAILS_BODY = { error: "Archived projects are read-only; restore the project to edit its details.", code: "details_project_archived" };
const DROPBOX_BODY = { error: "Archived projects can't sync from Dropbox. Restore the project first.", code: "dropbox_sync_project_archived" };
const patch = (who: Who, projectId: string, body: unknown, race?: string) => call(who, "PATCH", `/api/projects/${projectId}`, body, race);

describe("PATCH /projects/:id on an archived Project (#455)", () => {
  it("an Admin edit is 409 details_project_archived and changes nothing", async () => {
    const id = await seedProject(true);
    const before = await footprint(id);
    const { response } = await patch("admin", id, { street: "Changed Street" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(DETAILS_BODY);
    expect(await footprint(id)).toEqual(before);
  });

  it("archived wins over the services-blocked 409", async () => {
    const id = await seedProject(true);
    await database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'video', 'empty', 3, ?, ?)").bind(crypto.randomUUID(), id, Date.now(), Date.now()).run();
    const before = await footprint(id);
    const { response } = await patch("admin", id, { orderedServices: [] });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(DETAILS_BODY);
    expect(await footprint(id)).toEqual(before);
  });

  it("the archive landing inside the batch is 409 details_project_archived and writes nothing", async () => {
    const id = await seedProject(false);
    const before = await footprint(id);
    const { response, flipped } = await patch("admin", id, { street: "Racing Street" }, id);
    expect(flipped).toBe(1);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(DETAILS_BODY);
    expect(await footprint(id)).toEqual(before);
  });

  it("an Editor is 403 (unchanged) and a missing id is 403 too (hasProjectAccess answers before the 404)", async () => {
    const id = await seedProject(true);
    expect((await patch("editor", id, { street: "x" })).response.status).toBe(403);
    expect((await patch("admin", crypto.randomUUID(), { street: "x" })).response.status).toBe(403);
  });

  it("after Restore the edit is 200, and a live Project's edit is 200", async () => {
    const flag = await database.DB.prepare("SELECT enabled FROM feature_flags WHERE key = 'tb5a_board_contract_enabled'").first<{ enabled: number }>();
    await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
    try {
      const live = await seedProject(false);
      expect((await patch("admin", live, { street: "Live Edit" })).response.status).toBe(200);
      const id = await seedProject(true);
      expect((await call("admin", "POST", `/api/projects/${id}/restore`)).response.status).toBe(200);
      expect((await patch("admin", id, { street: "Restored Edit" })).response.status).toBe(200);
    } finally {
      await database.DB.prepare("UPDATE feature_flags SET enabled = ? WHERE key = 'tb5a_board_contract_enabled'").bind(flag?.enabled ?? 0).run();
    }
  });
});

describe("POST /projects/:id/sync-dropbox on an archived Project (#455)", () => {
  for (const who of ["admin", "editor"] as const) {
    it(`${who}: 409 dropbox_sync_project_archived, no job row, no audit row`, async () => {
      const id = await seedProject(true);
      const before = await footprint(id);
      const { response } = await call(who, "POST", `/api/projects/${id}/sync-dropbox`);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(DROPBOX_BODY);
      expect(await footprint(id)).toEqual(before);
    });
  }
});
