import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { provisioningFreezeReleaseStatements } from "../src/routes/users";

const database = env as unknown as { DB: D1Database };
const authEnv = env as unknown as Env;
const authSecret = authEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const adminToken = "tb161-admin-session-token";
const photographerId = "a1611111-1111-4111-8111-111111111111";
const photographerToken = "tb161-photographer-session-token";
const FLAG = "external_editor_provisioning_frozen";
const PATH = "/api/users/external-provisioning-freeze";

declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

async function executeSql(sql: string): Promise<void> {
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const withoutComments = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of withoutComments.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

async function sessionCookie(token: string): Promise<string> {
  const context = await createAuth(authEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function request(path: string, cookie: string, method: "GET" | "POST" | "PATCH" = "GET", body?: unknown): Promise<Response> {
  const headers = new Headers({ cookie, origin: authEnv.APP_ORIGIN });
  if (body !== undefined) headers.set("content-type", "application/json");
  return workerSelf.fetch(new Request(`https://portal.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

/** Writes the row exactly as `freezeProvisioning` in the background worker does. */
async function freeze(at: number): Promise<void> {
  await database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES (?, 1, NULL, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1, updated_by = NULL, updated_at = ?")
    .bind(FLAG, at, at).run();
}

async function releaseAudits(): Promise<Array<{ actor_id: string; target_type: string; target_id: string; meta_json: string | null }>> {
  return (await database.DB.prepare("SELECT actor_id, target_type, target_id, meta_json FROM audit_log WHERE action = 'external.provisioning.released' ORDER BY created_at").all<{ actor_id: string; target_type: string; target_id: string; meta_json: string | null }>()).results;
}

function provisionExternal(cookie: string): Promise<Response> {
  return request("/api/users", cookie, "POST", { email: `tb161-${crypto.randomUUID()}@example.test`, name: "TB161 External", role: "external_editor" });
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'TB161 Photographer', 'tb161-photographer@example.test', 1, 'photographer', 1, ?, ?)").bind(photographerId, now, now),
    database.DB.prepare("INSERT OR IGNORE INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES ('tb161-admin-session', ?, ?, ?, ?, ?)").bind(now + 3_600_000, adminToken, adminId, now, now),
    database.DB.prepare("INSERT OR IGNORE INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES ('tb161-photographer-session', ?, ?, ?, ?, ?)").bind(now + 3_600_000, photographerToken, photographerId, now, now),
  ]);
});

beforeEach(async () => {
  await database.DB.batch([
    database.DB.prepare("DELETE FROM feature_flags WHERE key = ?").bind(FLAG),
    database.DB.prepare("DELETE FROM audit_log WHERE action = 'external.provisioning.released'"),
  ]);
});

describe("External Editor provisioning freeze release (#161)", () => {
  it("reads an absent row as open and gates both verbs on manageUsers", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const photographerCookie = await sessionCookie(photographerToken);
    const response = await request(PATH, adminCookie);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ frozen: false, frozenAt: null, updatedBy: null });
    expect((await request(PATH, photographerCookie)).status).toBe(403);
    expect((await request(PATH, photographerCookie, "PATCH", { frozen: false })).status).toBe(403);
  });

  it("is release-only: it refuses to freeze and rejects any other body", async () => {
    const adminCookie = await sessionCookie(adminToken);
    for (const body of [{ frozen: true }, {}, { frozen: "false" }, { frozen: false, extra: 1 }]) {
      expect((await request(PATH, adminCookie, "PATCH", body)).status).toBe(400);
    }
    expect(await database.DB.prepare("SELECT key FROM feature_flags WHERE key = ?").bind(FLAG).first()).toBeNull();
  });

  it("shows a worker freeze, refuses provisioning without calling it temporary, and releases it with an audit entry", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const frozenAt = Date.now() - 60_000;
    await freeze(frozenAt);

    await expect((await request(PATH, adminCookie)).json()).resolves.toEqual({ frozen: true, frozenAt, updatedBy: null });

    const refused = await provisionExternal(adminCookie);
    expect(refused.status).toBe(503);
    const refusal = await refused.json() as { error: string; code: string };
    expect(refusal.code).toBe("external_provisioning_frozen");
    expect(refusal.error).not.toMatch(/temporar/i);
    expect(refusal.error).toContain("Admin → Users");

    const released = await request(PATH, adminCookie, "PATCH", { frozen: false });
    expect(released.status).toBe(200);
    await expect(released.json()).resolves.toEqual({ frozen: false, frozenAt: null, updatedBy: adminId });
    expect(await database.DB.prepare("SELECT enabled, updated_by FROM feature_flags WHERE key = ?").bind(FLAG).first()).toEqual({ enabled: 0, updated_by: adminId });
    expect(await releaseAudits()).toEqual([{ actor_id: adminId, target_type: "feature_flag", target_id: FLAG, meta_json: JSON.stringify({ frozenAt }) }]);

    expect((await provisionExternal(adminCookie)).status).toBe(201);
  });

  it("refuses a role change to External Editor while frozen, with the same code", async () => {
    const adminCookie = await sessionCookie(adminToken);
    await freeze(Date.now());
    const refused = await request(`/api/users/${photographerId}`, adminCookie, "PATCH", { role: "external_editor" });
    expect(refused.status).toBe(503);
    await expect(refused.json()).resolves.toMatchObject({ code: "external_provisioning_frozen" });
    expect(await database.DB.prepare("SELECT role FROM user WHERE id = ?").bind(photographerId).first()).toEqual({ role: "photographer" });
  });

  it("treats releasing an open latch as a no-op that writes no audit entry", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const absent = await request(PATH, adminCookie, "PATCH", { frozen: false });
    expect(absent.status).toBe(200);
    await expect(absent.json()).resolves.toEqual({ frozen: false, frozenAt: null, updatedBy: null });
    expect(await database.DB.prepare("SELECT key FROM feature_flags WHERE key = ?").bind(FLAG).first()).toBeNull();

    await freeze(Date.now());
    expect((await request(PATH, adminCookie, "PATCH", { frozen: false })).status).toBe(200);
    const again = await request(PATH, adminCookie, "PATCH", { frozen: false });
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toEqual({ frozen: false, frozenAt: null, updatedBy: adminId });
    expect(await releaseAudits()).toHaveLength(1);
  });

  it("does not release, or audit, a re-freeze that landed after the release read the row", async () => {
    const t0 = Date.now() - 120_000;
    const t1 = t0 + 60_000;
    await freeze(t0);
    await freeze(t1);
    const statements = provisioningFreezeReleaseStatements(database.DB, { actorId: adminId, frozenAt: t0, metaJson: JSON.stringify({ frozenAt: t0 }), now: Date.now() });
    await database.DB.batch(statements);
    expect(await database.DB.prepare("SELECT enabled, updated_by, updated_at FROM feature_flags WHERE key = ?").bind(FLAG).first()).toEqual({ enabled: 1, updated_by: null, updated_at: t1 });
    expect(await releaseAudits()).toEqual([]);

    const current = provisioningFreezeReleaseStatements(database.DB, { actorId: adminId, frozenAt: t1, metaJson: JSON.stringify({ frozenAt: t1 }), now: Date.now() });
    await database.DB.batch(current);
    expect(await database.DB.prepare("SELECT enabled, updated_by FROM feature_flags WHERE key = ?").bind(FLAG).first()).toEqual({ enabled: 0, updated_by: adminId });
    expect(await releaseAudits()).toHaveLength(1);
  });
});
