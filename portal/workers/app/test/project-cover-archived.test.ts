import { env } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import app from "../src/index";
import type { Env } from "../src/env";

/**
 * #459: an archived Project's cover is read-only. POST /projects/:id/cover answers 409 `cover_project_archived` (set or clear)
 * before it writes the Project row or the audit log, and the write itself is fenced inside one D1 batch so a write that loses the
 * race to an archive writes nothing. The legacy POST /projects/:id/dropbox-sync route is gone.
 */
const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminId = "b1111111-1111-4111-8111-111111111111";
const editorId = "b2222222-2222-4222-8222-222222222222";
const photographerId = "b3333333-3333-4333-8333-333333333333";
const externalId = "b4444444-4444-4444-8444-444444444444";
const tokens = { admin: "cover-admin-token", editor: "cover-editor-token", external: "cover-external-token" } as const;
type Who = keyof typeof tokens;
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); } }
async function cookie(token: string) { const context = await createAuth(baseEnv).$context; return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`; }

type Race = { archive: string; restoreAfter?: boolean } | { remove: string };
/** Runs the real app. `race` swaps in a D1 whose first multi-statement batch archives (or deletes) that Project first; `restoreAfter` un-archives it once the batch has run. */
async function call(who: Who, method: "GET" | "POST", path: string, body?: unknown, race?: Race) {
  const waits: Promise<unknown>[] = [];
  const executionContext = { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); }, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
  const state = { flipped: 0 };
  const db = race ? new Proxy(database.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!state.flipped && statements.length >= 2) {
            state.flipped += 1;
            if ("archive" in race) await target.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), race.archive).run();
            else await target.prepare("DELETE FROM projects WHERE id = ?").bind(race.remove).run();
          }
          const results = await target.batch(statements);
          if ("archive" in race && race.restoreAfter) {
            // The real batch is atomic, so its own trailing snapshot still sees the archive. Re-take the snapshot after the restore to exercise the classification of a lost race that is no longer archived.
            await target.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(race.archive).run();
            results[2] = await target.prepare("SELECT archived_at FROM projects WHERE id = ?").bind(race.archive).all();
          }
          return results;
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
  return { response, flipped: state.flipped };
}

type Fixture = { projectId: string; assetId: string; otherAssetId: string };

/** A Project with a cover-eligible raw photo, plus a second Project's photo (never eligible here). */
async function seedProject(archived: boolean, cover: "none" | "set" = "set"): Promise<Fixture> {
  const projectId = crypto.randomUUID(); const otherProjectId = crypto.randomUUID(); const now = Date.now();
  const assetId = crypto.randomUUID(); const otherAssetId = crypto.randomUUID();
  const collectionId = crypto.randomUUID(); const otherCollectionId = crypto.randomUUID();
  await database.DB.batch([
    ...[projectId, otherProjectId].map((id) => database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Cover Street', 'editing_autohdr', ?, ?)").bind(id, now, now)),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?), (?, ?, 'raw', 'empty', 0, ?, ?)").bind(collectionId, projectId, now, now, otherCollectionId, otherProjectId, now, now),
    database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'a.jpg', 1, 'upload', ?, ?), (?, ?, ?, 'b.jpg', 1, 'upload', ?, ?)").bind(assetId, collectionId, `k/${assetId}`, now, now, otherAssetId, otherCollectionId, `k/${otherAssetId}`, now, now),
  ]);
  if (cover === "set") await database.DB.prepare("UPDATE projects SET cover_asset_id = ? WHERE id = ?").bind(assetId, projectId).run();
  if (archived) await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), projectId).run();
  return { projectId, assetId, otherAssetId };
}

/** Everything a cover write can touch, for one Project. Compared whole before and after a refused write. */
async function footprint(projectId: string) {
  const all = async (sql: string, ...binds: unknown[]) => (await database.DB.prepare(sql).bind(...binds).all()).results;
  return {
    project: await all("SELECT cover_asset_id, updated_at FROM projects WHERE id = ?", projectId),
    audit: await all("SELECT id, action, target_id, meta_json FROM audit_log WHERE action = 'project.cover.set' AND target_id = ? ORDER BY id", projectId),
    activity: await all("SELECT * FROM project_activity_events WHERE project_id = ? ORDER BY id", projectId),
  };
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__); const now = Date.now();
  for (const [id, role] of [[adminId, "admin"], [editorId, "editor"], [photographerId, "photographer"], [externalId, "external_editor"]]) await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)").bind(id, `${role} ${id.slice(0, 4)}`, `${id}@example.test`, role, now, now).run();
  for (const [token, userId] of [[tokens.admin, adminId], [tokens.editor, editorId], [tokens.external, externalId]]) await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 3_600_000, token, userId, now, now).run();
});

const ARCHIVED_BODY = { error: "Archived projects are read-only; restore the project to change its cover.", code: "cover_project_archived" };
const setCover = (who: Who, projectId: string, assetId: string | null, race?: Race) => call(who, "POST", `/api/projects/${projectId}/cover`, { assetId }, race);

describe("an archived Project's cover (#459)", () => {
  it("refuses to set a cover: 409 and nothing written", async () => {
    const f = await seedProject(true, "none"); const before = await footprint(f.projectId);
    const { response } = await setCover("admin", f.projectId, f.assetId);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(ARCHIVED_BODY);
    expect(await footprint(f.projectId)).toEqual(before);
  });
  it("refuses to clear a cover: 409 and the cover is kept", async () => {
    const f = await seedProject(true); const before = await footprint(f.projectId);
    const { response } = await setCover("admin", f.projectId, null);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(ARCHIVED_BODY);
    expect(await footprint(f.projectId)).toEqual(before);
    expect((before.project[0] as { cover_asset_id: string }).cover_asset_id).toBe(f.assetId);
  });
  it("archived wins over the asset 404", async () => {
    const f = await seedProject(true); const before = await footprint(f.projectId);
    for (const assetId of [f.otherAssetId, crypto.randomUUID()]) {
      const { response } = await setCover("admin", f.projectId, assetId);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual(ARCHIVED_BODY);
    }
    expect(await footprint(f.projectId)).toEqual(before);
  });
  it("an archive that lands before the batch is 409 and writes nothing", async () => {
    const f = await seedProject(false); const before = await footprint(f.projectId);
    const { response, flipped } = await setCover("admin", f.projectId, f.assetId, { archive: f.projectId });
    expect(flipped).toBe(1);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(ARCHIVED_BODY);
    expect(await footprint(f.projectId)).toEqual(before);
  });
  it("archived then restored inside the write is a retryable 409 cover_conflict and writes nothing", async () => {
    const f = await seedProject(false); const before = await footprint(f.projectId);
    const { response, flipped } = await setCover("admin", f.projectId, f.assetId, { archive: f.projectId, restoreAfter: true });
    expect(flipped).toBe(1);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "The project changed while saving; reload and try again.", code: "cover_conflict" });
    expect(await footprint(f.projectId)).toEqual(before);
  });
  it("a Project deleted before the batch is 404", async () => {
    const f = await seedProject(false);
    const { response, flipped } = await setCover("admin", f.projectId, f.assetId, { remove: f.projectId });
    expect(flipped).toBe(1);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Project not found" });
    expect((await footprint(f.projectId)).audit).toEqual([]);
  });
  it("restoring lets the cover be set again, with one audit row", async () => {
    const flag = await database.DB.prepare("SELECT enabled FROM feature_flags WHERE key = 'tb5a_board_contract_enabled'").first<{ enabled: number }>();
    await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
    try {
      const f = await seedProject(true, "none");
      expect((await call("admin", "POST", `/api/projects/${f.projectId}/restore`)).response.status).toBe(200);
      const { response } = await setCover("admin", f.projectId, f.assetId);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ coverAssetId: f.assetId });
      const { audit } = await footprint(f.projectId);
      expect(audit).toHaveLength(1);
      expect(JSON.parse((audit[0] as { meta_json: string }).meta_json)).toEqual({ assetId: f.assetId });
    } finally {
      await database.DB.prepare("UPDATE feature_flags SET enabled = ? WHERE key = 'tb5a_board_contract_enabled'").bind(flag?.enabled ?? 0).run();
    }
  });
});

describe("a live Project's cover is unchanged (#459)", () => {
  it("an Editor and an External Editor are 403; an unknown id is 403 (hasProjectAccess resolves no Project)", async () => {
    const f = await seedProject(false); const before = await footprint(f.projectId);
    expect((await setCover("editor", f.projectId, f.assetId)).response.status).toBe(403);
    expect((await setCover("external", f.projectId, f.assetId)).response.status).toBe(403);
    expect((await setCover("admin", crypto.randomUUID(), null)).response.status).toBe(403);
    expect(await footprint(f.projectId)).toEqual(before);
  });
  it("set then clear are 200, each with one audit row, and updated_at advances", async () => {
    const f = await seedProject(false, "none");
    const t0 = (await footprint(f.projectId)).project[0] as { updated_at: number };
    const set = await setCover("admin", f.projectId, f.assetId);
    expect(set.response.status).toBe(200);
    expect(await set.response.json()).toEqual({ coverAssetId: f.assetId });
    let state = await footprint(f.projectId);
    expect(state.project[0]).toMatchObject({ cover_asset_id: f.assetId });
    expect((state.project[0] as { updated_at: number }).updated_at).toBeGreaterThan(t0.updated_at);
    expect(state.audit).toHaveLength(1);
    const clear = await setCover("admin", f.projectId, null);
    expect(clear.response.status).toBe(200);
    expect(await clear.response.json()).toEqual({ coverAssetId: null });
    state = await footprint(f.projectId);
    expect(state.project[0]).toMatchObject({ cover_asset_id: null });
    expect(state.audit).toHaveLength(2);
  });
});

describe("the legacy dropbox-sync route (#459)", () => {
  it("is gone: 404 {error:'Not found'} and no audit row", async () => {
    const f = await seedProject(false);
    const { response } = await call("admin", "POST", `/api/projects/${f.projectId}/dropbox-sync`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    const rows = await database.DB.prepare("SELECT id FROM audit_log WHERE action = 'project.dropbox_sync' AND target_id = ?").bind(f.projectId).all();
    expect(rows.results).toEqual([]);
  });
});
