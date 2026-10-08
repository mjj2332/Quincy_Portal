import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { mcpDispatchStorage, mcpDispatchFor, type McpPrincipal } from "../src/lib/mcp-dispatch-context";
import { dispatchToApi, McpRouteNotAllowedError, type McpFetchApp } from "../src/mcp/dispatch";
import { isAllowedMcpRoute } from "../src/mcp/route-allowlist";

const database = env as unknown as { DB: D1Database };
const testEnv = env as unknown as Env;
const authSecret = testEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const photographerId = "a1000000-0000-4000-8000-000000000001";
const externalId = "a1000000-0000-4000-8000-000000000002";
const otherId = "a1000000-0000-4000-8000-000000000003";
const adminToken = "mcp-foundation-admin-session-token";
const photographerToken = "mcp-foundation-photographer-session-token";

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
const fetchApp: McpFetchApp = (request, e, c) => app.fetch(request, e, c);

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
  const context = await createAuth(testEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function insertUser(id: string, role: string, active = true): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)")
    .bind(id, `MCP ${role}`, `${id}@example.test`, role, active ? 1 : 0, now, now).run();
}

async function insertSession(id: string, token: string, userId: string): Promise<void> {
  const now = Date.now();
  await database.DB.prepare("INSERT OR IGNORE INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, now + 3_600_000, token, userId, now, now).run();
}

async function insertConnection(id: string, userId: string, epoch = 0): Promise<McpPrincipal> {
  await database.DB.prepare("INSERT INTO mcp_connections (id, user_id, client_id, client_name, redirect_host, scopes, authorization_epoch, created_at) VALUES (?, ?, 'client-1', 'Test Client', 'client.example.test', '[\"read\"]', ?, ?)")
    .bind(id, userId, epoch, Date.now()).run();
  return { userId, connectionId: id, clientName: "Test Client", authorizationEpoch: epoch };
}

const setFlag = (enabled: boolean) => database.DB.prepare("UPDATE feature_flags SET enabled = ? WHERE key = 'mcp_access'").bind(enabled ? 1 : 0).run();
const dispatch = (principal: McpPrincipal, input: { method: string; path: string; query?: Record<string, string>; body?: unknown } = { method: "GET", path: "/api/me" }) =>
  dispatchToApi(fetchApp, testEnv, ctx, principal, input);

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql(__PORTAL_SEED_SQL__);
  await insertUser(photographerId, "photographer");
  await insertUser(externalId, "external_editor");
  await insertUser(otherId, "editor");
  await insertSession("mcp-foundation-admin-session", adminToken, adminId);
  await insertSession("mcp-foundation-photographer-session", photographerToken, photographerId);
});

beforeEach(async () => {
  await database.DB.batch([
    database.DB.prepare("DELETE FROM mcp_connections"),
    database.DB.prepare("UPDATE user SET active = 1, authorization_epoch = 0, role = CASE id WHEN ? THEN 'photographer' WHEN ? THEN 'external_editor' WHEN ? THEN 'editor' ELSE role END WHERE id IN (?, ?, ?)")
      .bind(photographerId, externalId, otherId, photographerId, externalId, otherId),
    database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES ('mcp_access', 0, NULL, ?) ON CONFLICT(key) DO UPDATE SET enabled = 0, updated_by = NULL").bind(Date.now()),
    database.DB.prepare("DELETE FROM audit_log WHERE action = 'user.mcp_access_toggle'"),
  ]);
});

describe("MCP dispatch authenticates through the connection record", () => {
  it("is refused while the mcp_access flag is off or its row is missing", async () => {
    const principal = await insertConnection("conn-flag", photographerId);
    expect((await dispatch(principal)).status).toBe(401);
    await database.DB.prepare("DELETE FROM feature_flags WHERE key = 'mcp_access'").run();
    expect((await dispatch(principal)).status).toBe(401);
  });

  it("returns the connection's user on GET /api/me when the flag is on", async () => {
    await setFlag(true);
    const principal = await insertConnection("conn-ok", photographerId);
    const response = await dispatch(principal);
    expect(response.status).toBe(200);
    const body = await response.json() as { user: Record<string, unknown> };
    expect(body.user).toMatchObject({ id: photographerId, role: "photographer", active: true, impersonatedBy: null, authorizationEpoch: 0 });
    expect(body.user).not.toHaveProperty("via");
  });

  it("refuses a revoked connection, another user's connection and a missing connection", async () => {
    await setFlag(true);
    const revoked = await insertConnection("conn-revoked", photographerId);
    await database.DB.prepare("UPDATE mcp_connections SET revoked_at = ? WHERE id = 'conn-revoked'").bind(Date.now()).run();
    expect((await dispatch(revoked)).status).toBe(401);
    await insertConnection("conn-other", otherId);
    expect((await dispatch({ ...revoked, connectionId: "conn-other", userId: photographerId })).status).toBe(401);
    expect((await dispatch({ ...revoked, connectionId: "conn-missing" })).status).toBe(401);
  });

  it("refuses a deactivated user, a role change that bumps the epoch, and a principal epoch that differs from the current one", async () => {
    await setFlag(true);
    const principal = await insertConnection("conn-user", photographerId);
    expect((await dispatch(principal)).status).toBe(200);
    expect((await dispatch({ ...principal, authorizationEpoch: 5 })).status).toBe(401);
    await database.DB.prepare("UPDATE user SET role = 'editor', authorization_epoch = authorization_epoch + 1 WHERE id = ?").bind(photographerId).run();
    expect((await dispatch(principal)).status).toBe(401);
    // Even a principal carrying the new epoch is refused while the connection row keeps the consented one.
    expect((await dispatch({ ...principal, authorizationEpoch: 1 })).status).toBe(401);
    await database.DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(otherId).run();
    expect((await dispatch(await insertConnection("conn-inactive", otherId))).status).toBe(401);
  });

  it("refuses a store bound to a different Request object, and never trusts a request it did not build", async () => {
    await setFlag(true);
    const principal = await insertConnection("conn-identity", photographerId);
    const real = new Request(`${testEnv.APP_ORIGIN}/api/me`);
    const stray = new Request(`${testEnv.APP_ORIGIN}/api/me`);
    const response = await mcpDispatchStorage.run({ request: stray, principal }, () => Promise.resolve(app.fetch(real, testEnv, ctx)));
    expect(response.status).toBe(401);
    expect(mcpDispatchFor(real)).toBeNull();
  });

  it("gives an External Editor the external projection on /api/me, as the cookie path does", async () => {
    await setFlag(true);
    const response = await dispatch(await insertConnection("conn-external", externalId));
    expect(response.status).toBe(200);
    const body = await response.json() as { user: Record<string, unknown>; capabilities: string[] };
    expect(Object.keys(body.user).sort()).toEqual(["active", "authorizationEpoch", "email", "id", "impersonatedBy", "name", "role"]);
    expect(body.user.role).toBe("external_editor");
  });

  it("keeps two concurrent dispatches with different principals isolated", async () => {
    await setFlag(true);
    const a = await insertConnection("conn-a", photographerId);
    const b = await insertConnection("conn-b", otherId);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => dispatch(i % 2 === 0 ? a : b).then((r) => r.json() as Promise<{ user: { id: string } }>)));
    results.forEach((body, i) => expect(body.user.id).toBe(i % 2 === 0 ? photographerId : otherId));
  });
});

describe("dispatchToApi", () => {
  it("refuses off-allowlist routes before the app is called", async () => {
    const spy = vi.fn<McpFetchApp>();
    const principal = await insertConnection("conn-allow", photographerId);
    for (const input of [
      { method: "DELETE", path: "/api/projects/x" },
      { method: "POST", path: "/api/projects" },
      { method: "GET", path: "/api/auth/session" },
      { method: "GET", path: "/api/users" },
      { method: "GET", path: "/api/projects/a/b" },
      { method: "GET", path: "/api/projects/../auth/session" },
      { method: "GET", path: "/api/me?x=1" },
    ]) await expect(dispatchToApi(spy, testEnv, ctx, principal, input), `${input.method} ${input.path}`).rejects.toBeInstanceOf(McpRouteNotAllowedError);
    expect(spy).not.toHaveBeenCalled();
    expect(isAllowedMcpRoute("GET", "/api/projects/abc-123")).toBe(true);
  });

  it("builds a Request with no Origin, Cookie or Authorization header", async () => {
    await setFlag(true);
    const principal = await insertConnection("conn-headers", photographerId);
    const seen: Request[] = [];
    const recording: McpFetchApp = (request, e, c) => { seen.push(request); return app.fetch(request, e, c); };
    const response = await dispatchToApi(recording, testEnv, ctx, principal, { method: "GET", path: "/api/projects", query: { limit: "1" } });
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    const names = [...seen[0]!.headers.keys()];
    for (const forbidden of ["origin", "cookie", "authorization"]) expect(names).not.toContain(forbidden);
    expect(new URL(seen[0]!.url).search).toBe("?limit=1");
  });
});

describe("the public /api path is unchanged", () => {
  it("rejects a bearer token on GET /api/me", async () => {
    const response = await workerSelf.fetch("https://portal.test/api/me", { headers: { authorization: "Bearer x" } });
    expect(response.status).toBe(401);
  });

  it("still requires Origin on an unsafe /api request, even with a valid session cookie", async () => {
    const cookie = await sessionCookie(adminToken);
    const response = await workerSelf.fetch("https://portal.test/api/users/mcp-settings", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    expect(response.status).toBe(403);
  });

  it("ignores spoofed principal headers", async () => {
    await setFlag(true);
    const principal = await insertConnection("conn-spoof", photographerId);
    const response = await workerSelf.fetch("https://portal.test/api/me", { headers: { "x-mcp-principal": JSON.stringify(principal), "x-mcp-connection-id": principal.connectionId } });
    expect(response.status).toBe(401);
  });
});

describe("admin mcp-settings", () => {
  const call = async (token: string, method: string, body?: unknown) => workerSelf.fetch("https://portal.test/api/users/mcp-settings", {
    method,
    headers: { cookie: await sessionCookie(token), origin: testEnv.APP_ORIGIN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  it("is admin-only", async () => {
    expect((await call(photographerToken, "GET")).status).toBe(403);
    expect((await call(photographerToken, "PATCH", { enabled: true })).status).toBe(403);
  });

  it("defaults off, toggles, and writes the audit row in the same batch", async () => {
    await expect((await call(adminToken, "GET")).json()).resolves.toEqual({ enabled: false });
    const patched = await call(adminToken, "PATCH", { enabled: true });
    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toEqual({ enabled: true });
    await expect((await call(adminToken, "GET")).json()).resolves.toEqual({ enabled: true });
    const row = await database.DB.prepare("SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE action = 'user.mcp_access_toggle'").first();
    expect(row).toEqual({ actor_id: adminId, action: "user.mcp_access_toggle", target_type: "feature_flag", target_id: "mcp_access", meta_json: '{"enabled":true}' });
    const flag = await database.DB.prepare("SELECT enabled, updated_by FROM feature_flags WHERE key = 'mcp_access'").first();
    expect(flag).toEqual({ enabled: 1, updated_by: adminId });
  });

  it("rejects a bad body", async () => {
    expect((await call(adminToken, "PATCH", { enabled: "yes" })).status).toBe(400);
    expect((await call(adminToken, "PATCH", { enabled: true, extra: 1 })).status).toBe(400);
    expect((await call(adminToken, "PATCH", {})).status).toBe(400);
  });
});
