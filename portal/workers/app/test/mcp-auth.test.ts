import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;
const testEnv = env as unknown as Env;
const DB = testEnv.DB;
const ORIGIN = testEnv.APP_ORIGIN;
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://client.test/cb";
const authSecret = testEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const editorId = "b2000000-0000-4000-8000-000000000001";
const photographerId = "b2000000-0000-4000-8000-000000000002";
const cookies: Record<string, string> = {};

async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await DB.exec(`${flat};`); } }
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function cookieFor(token: string) { const context = await createAuth(testEnv).$context; return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`; }
async function addUser(id: string, role: string) { const t = Date.now(); await DB.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)").bind(id, `MCP ${role}`, `${id}@example.test`, role, t, t).run(); }
async function addSession(name: string, userId: string, impersonatedBy?: string) {
  const t = Date.now(); const token = `mcp-auth-${name}-token`;
  await DB.prepare("INSERT OR IGNORE INTO session (id, expires_at, token, user_id, impersonated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(`mcp-auth-${name}`, t + 3_600_000, token, userId, impersonatedBy ?? null, t, t).run();
  cookies[name] = await cookieFor(token);
}
const setFlag = (on: boolean) => DB.prepare("UPDATE feature_flags SET enabled = ? WHERE key = 'mcp_access'").bind(on ? 1 : 0).run();

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__);
  await addUser(editorId, "editor"); await addUser(photographerId, "photographer");
  await addSession("admin", adminId); await addSession("editor", editorId); await addSession("imp", photographerId, adminId);
  await DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'user_impersonation'").run();
});
beforeEach(async () => { await setFlag(true); await DB.prepare("UPDATE user SET authorization_epoch = 0, active = 1").run(); });

const json = { "content-type": "application/json" };
async function register() {
  const res = await workerSelf.fetch(`${ORIGIN}/oauth/register`, { method: "POST", headers: json, body: JSON.stringify({ client_name: "Test Client", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}
async function authorize(clientId: string, scope: string) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope, state: "st", code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE });
  const res = await workerSelf.fetch(`${ORIGIN}/oauth/authorize?${q}`, { redirect: "manual" });
  return { res, verifier, handle: res.headers.get("location")?.split("/").pop() ?? "", binding: (res.headers.get("set-cookie") ?? "").split(";")[0]! };
}
const consentFetch = (handle: string, who: string, binding: string, body?: unknown) => workerSelf.fetch(`${ORIGIN}/api/connected-apps/consent/${handle}`, body === undefined ? { headers: { cookie: cookies[who]! } } : { method: "POST", headers: { ...json, origin: ORIGIN, cookie: [cookies[who], binding].join("; ") }, body: JSON.stringify(body) });
async function tokenReq(body: Record<string, string>) { const res = await workerSelf.fetch(`${ORIGIN}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) }); return { status: res.status, json: (await res.json()) as Record<string, unknown> }; }
type Tokens = { access_token: string; refresh_token?: string; expires_in: number; scope: string };
async function connect(scope: string, who = "admin", granted?: string[]) {
  const client_id = await register();
  const a = await authorize(client_id, scope);
  expect(a.res.status).toBe(302);
  const approved = await consentFetch(a.handle, who, a.binding, { decision: "approve", scopes: granted ?? scope.split(" ") });
  expect(approved.status).toBe(200);
  const { redirectTo } = (await approved.json()) as { redirectTo: string };
  const code = new URL(redirectTo).searchParams.get("code")!;
  const t = await tokenReq({ grant_type: "authorization_code", code, client_id, redirect_uri: REDIRECT, code_verifier: a.verifier, resource: RESOURCE });
  expect(t.status).toBe(200);
  return { client_id, tokens: t.json as unknown as Tokens };
}
let rpcId = 0;
const rpc = (token: string, method: string, params: unknown = {}, path = "/mcp") => workerSelf.fetch(`${ORIGIN}${path}`, { method: "POST", headers: { ...json, accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
const initParams = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } };

describe("flag off", () => {
  it("/mcp and /oauth/authorize are 404", async () => {
    await setFlag(false);
    expect((await workerSelf.fetch(`${ORIGIN}/mcp`, { method: "POST" })).status).toBe(404);
    expect((await workerSelf.fetch(`${ORIGIN}/mcp/`, { method: "POST" })).status).toBe(404);
    expect((await workerSelf.fetch(`${ORIGIN}/oauth/authorize?client_id=x`, { redirect: "manual" })).status).toBe(404);
  });
});

describe("discovery and /mcp challenge", () => {
  it("serves AS and protected-resource metadata; /mcp without a token is 401 with resource_metadata", async () => {
    const as = await (await workerSelf.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    expect(as).toMatchObject({ issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/oauth/authorize`, token_endpoint: `${ORIGIN}/oauth/token`, registration_endpoint: `${ORIGIN}/oauth/register` });
    const prm = await (await workerSelf.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json() as Record<string, unknown>;
    expect(prm).toMatchObject({ resource: RESOURCE });
    for (const path of ["/mcp", "/mcp/"]) {
      const res = await workerSelf.fetch(`${ORIGIN}${path}`, { method: "POST" });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    }
    expect((await workerSelf.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { authorization: "Bearer a:b:c" } })).status).toBe(401);
  });
  it("an invalid authorize request is a plain error page, never a redirect", async () => {
    const res = await workerSelf.fetch(`${ORIGIN}/oauth/authorize?response_type=code&client_id=nope&redirect_uri=${encodeURIComponent(REDIRECT)}`, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("full flow", () => {
  it("DCR, authorize, consent, token, initialize, tools/list (get_me only), tools/call", async () => {
    const client_id = await register();
    const a = await authorize(client_id, "read write");
    expect(a.res.status).toBe(302);
    expect(a.handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.res.headers.get("location")).toBe(`${ORIGIN}/settings/connected-apps/consent/${a.handle}`);
    expect(a.res.headers.get("set-cookie")).toContain("__Host-oauth-consent-");
    expect(a.res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(a.res.headers.get("x-frame-options")).toBe("DENY");
    const desc = await (await consentFetch(a.handle, "admin", "")).json() as Record<string, unknown>;
    expect(desc).toEqual({ clientName: "Test Client", redirectHost: "client.test", isLocalhost: false, scopes: ["read", "write"], warning: "This app will see Portal data you can see" });
    const approved = await consentFetch(a.handle, "admin", a.binding, { decision: "approve", scopes: ["read", "write"] });
    expect(approved.status).toBe(200);
    const code = new URL(((await approved.json()) as { redirectTo: string }).redirectTo).searchParams.get("code")!;
    const t = await tokenReq({ grant_type: "authorization_code", code, client_id, redirect_uri: REDIRECT, code_verifier: a.verifier, resource: RESOURCE });
    const tokens = t.json as unknown as Tokens;
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.refresh_token).toBeTypeOf("string");
    const row = await DB.prepare("SELECT * FROM mcp_connections WHERE client_id = ?").bind(client_id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ user_id: adminId, client_name: "Test Client", redirect_host: "client.test", scopes: '["read","write"]', authorization_epoch: 0 });
    expect(row!.oauth_grant_id).toBeTypeOf("string");
    expect((await DB.prepare("SELECT action FROM audit_log WHERE action = 'connected_app.grant' AND target_id = ?").bind(row!.id).first())).not.toBeNull();

    for (const path of ["/mcp", "/mcp/"]) {
      const init = await rpc(tokens.access_token, "initialize", initParams, path);
      expect(init.status).toBe(200);
      const list = await (await rpc(tokens.access_token, "tools/list", {}, path)).json() as { result: { tools: { name: string }[] } };
      expect(list.result.tools.map((x) => x.name)).toEqual(["get_me"]);
    }
    const call = await (await rpc(tokens.access_token, "tools/call", { name: "get_me", arguments: {} })).json() as { result: { content: { text: string }[] } };
    const me = JSON.parse(call.result.content[0]!.text) as { user: { id: string; role: string } };
    expect(me.user).toMatchObject({ id: adminId, role: "admin" });
    expect((await DB.prepare("SELECT last_used_at FROM mcp_connections WHERE id = ?").bind(row!.id).first<{ last_used_at: number }>())!.last_used_at).toBeGreaterThan(0);

    // CORS on /mcp, without credentials.
    const pre = await workerSelf.fetch(`${ORIGIN}/mcp`, { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-credentials")).toBeNull();

    // A bearer never works on /api.
    expect((await workerSelf.fetch(`${ORIGIN}/api/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(401);
    expect((await workerSelf.fetch(`${ORIGIN}/api/projects`, { method: "POST", headers: { ...json, authorization: `Bearer ${tokens.access_token}` }, body: "{}" })).status).toBe(403);
  });

  it("an editor sees get_me only for its own role; read grant refreshes, admin grant does not", async () => {
    const editor = await connect("read", "editor");
    const call = await (await rpc(editor.tokens.access_token, "tools/call", { name: "get_me", arguments: {} })).json() as { result: { content: { text: string }[] } };
    expect(JSON.parse(call.result.content[0]!.text).user.id).toBe(editorId);
    expect(editor.tokens.expires_in).toBe(3600);
    expect(editor.tokens.refresh_token).toBeTypeOf("string");
    const refreshed = await tokenReq({ grant_type: "refresh_token", refresh_token: editor.tokens.refresh_token!, client_id: editor.client_id });
    expect(refreshed.status).toBe(200);
    const admin = await connect("read write admin", "admin");
    expect(admin.tokens.expires_in).toBe(900);
    expect(admin.tokens.refresh_token).toBeUndefined();
  });

  it("a write-only tool listing follows the granted scopes", async () => {
    const { tokens } = await connect("read");
    const list = await (await rpc(tokens.access_token, "tools/list")).json() as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((x) => x.name)).toEqual(["get_me"]);
  });
});

describe("revocation", () => {
  const cases: [string, (connectionId: string, userId: string) => Promise<unknown>][] = [
    ["revoked", (id) => DB.prepare("UPDATE mcp_connections SET revoked_at = ?, revoke_reason = 'user' WHERE id = ?").bind(Date.now(), id).run()],
    ["deactivated", (_id, userId) => DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(userId).run()],
    ["epoch bump", (_id, userId) => DB.prepare("UPDATE user SET authorization_epoch = authorization_epoch + 1 WHERE id = ?").bind(userId).run()],
  ];
  for (const [name, mutate] of cases) {
    it(`${name}: next /mcp is 401 and refresh is invalid_grant`, async () => {
      const { client_id, tokens } = await connect("read", "editor");
      expect((await rpc(tokens.access_token, "tools/list")).status).toBe(200);
      const row = await DB.prepare("SELECT id FROM mcp_connections WHERE client_id = ?").bind(client_id).first<{ id: string }>();
      await mutate(row!.id, editorId);
      expect((await rpc(tokens.access_token, "tools/list")).status).toBe(401);
      const refresh = await tokenReq({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id });
      expect(refresh.json.error).toBe("invalid_grant");
    });
  }
  it("the flag going off makes refresh temporarily_unavailable", async () => {
    const { client_id, tokens } = await connect("read", "editor");
    await setFlag(false);
    expect((await tokenReq({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id })).json.error).toBe("temporarily_unavailable");
  });
  it("re-consent marks the old row superseded", async () => {
    const first = await connect("read", "editor");
    const a = await authorize(first.client_id, "read");
    const approved = await consentFetch(a.handle, "editor", a.binding, { decision: "approve", scopes: ["read"] });
    expect(approved.status).toBe(200);
    const rows = await DB.prepare("SELECT revoked_at, revoke_reason FROM mcp_connections WHERE client_id = ? ORDER BY created_at").bind(first.client_id).all<{ revoked_at: number | null; revoke_reason: string | null }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]).toMatchObject({ revoke_reason: "superseded" });
    expect(rows.results[0]!.revoked_at).not.toBeNull();
    expect(rows.results[1]!.revoked_at).toBeNull();
  });
});

describe("concurrent consent", () => {
  it("concurrent re-consent: the surviving row's grant always works and the superseded one is refused", async () => {
    const client_id = await register();
    const exchange = async (res: Response, x: Awaited<ReturnType<typeof authorize>>) => {
      const code = new URL(((await res.json()) as { redirectTo: string }).redirectTo).searchParams.get("code")!;
      return tokenReq({ grant_type: "authorization_code", code, client_id, redirect_uri: REDIRECT, code_verifier: x.verifier, resource: RESOURCE });
    };
    for (let round = 0; round < 6; round++) {
      const first = await authorize(client_id, "read"); const second = await authorize(client_id, "read");
      // Both consents run at once, so their D1 batches and library completions interleave freely.
      const [r1, r2] = await Promise.all([first, second].map((x) => consentFetch(x.handle, "editor", x.binding, { decision: "approve", scopes: ["read"] })));
      expect([r1!.status, r2!.status]).toEqual([200, 200]);
      const t1 = await exchange(r1!, first); const t2 = await exchange(r2!, second);
      const live = await DB.prepare("SELECT oauth_grant_id FROM mcp_connections WHERE client_id = ? AND revoked_at IS NULL").bind(client_id).all<{ oauth_grant_id: string }>();
      expect(live.results).toHaveLength(1);
      const results = await Promise.all([t1, t2].map(async (t) => t.status === 200 ? { grant: ((t.json as unknown as Tokens).access_token.split(":")[1]), status: (await rpc((t.json as unknown as Tokens).access_token, "tools/list")).status } : { grant: "", status: t.status }));
      const survivor = results.find((r) => r.grant === live.results[0]!.oauth_grant_id);
      expect(survivor?.status, `round ${round}: the live row's grant must work`).toBe(200);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    }
  });
});

describe("consent rules", () => {
  it("is refused while impersonating", async () => {
    const client_id = await register(); const a = await authorize(client_id, "read");
    const res = await consentFetch(a.handle, "imp", a.binding, { decision: "approve", scopes: ["read"] });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "impersonation_consent_refused" });
  });
  it("an editor cannot grant admin; the handle survives the refusal", async () => {
    const client_id = await register(); const a = await authorize(client_id, "read admin");
    expect((await consentFetch(a.handle, "editor", a.binding, { decision: "approve", scopes: ["read", "admin"] })).status).toBe(403);
    expect((await consentFetch(a.handle, "editor", a.binding, { decision: "approve", scopes: ["read"] })).status).toBe(200);
  });
  it("a used handle is a clear 404; deny redirects with access_denied", async () => {
    const client_id = await register(); const a = await authorize(client_id, "read");
    const denied = await consentFetch(a.handle, "editor", a.binding, { decision: "deny", scopes: [] });
    expect(denied.status).toBe(200);
    expect(new URL(((await denied.json()) as { redirectTo: string }).redirectTo).searchParams.get("error")).toBe("access_denied");
    expect((await consentFetch(a.handle, "editor", a.binding, { decision: "approve", scopes: ["read"] })).status).toBe(404);
    expect((await consentFetch(a.handle, "editor", "")).status).toBe(404);
  });
  it("consent needs a session", async () => {
    const client_id = await register(); const a = await authorize(client_id, "read");
    expect((await workerSelf.fetch(`${ORIGIN}/api/connected-apps/consent/${a.handle}`)).status).toBe(401);
  });
});

describe("Connected apps", () => {
  it("lists my connections and revokes one (audited)", async () => {
    const { client_id, tokens } = await connect("read", "editor");
    const list = await (await workerSelf.fetch(`${ORIGIN}/api/connected-apps`, { headers: { cookie: cookies.editor! } })).json() as { id: string; clientName: string; redirectHost: string; scopes: string[]; status: string }[];
    const mine = list.find((x) => x.clientName === "Test Client")!;
    expect(mine).toMatchObject({ redirectHost: "client.test", scopes: ["read"], status: "active" });
    expect((await workerSelf.fetch(`${ORIGIN}/api/connected-apps`, { headers: { cookie: cookies.admin! } }).then((r) => r.json()) as unknown[]).some((x) => (x as { id: string }).id === mine.id)).toBe(false);
    expect((await workerSelf.fetch(`${ORIGIN}/api/connected-apps/${mine.id}`, { method: "DELETE", headers: { origin: ORIGIN, cookie: cookies.admin! } })).status).toBe(404);
    expect((await workerSelf.fetch(`${ORIGIN}/api/connected-apps/${mine.id}`, { method: "DELETE", headers: { origin: ORIGIN, cookie: cookies.editor! } })).status).toBe(204);
    expect((await rpc(tokens.access_token, "tools/list")).status).toBe(401);
    expect((await tokenReq({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, client_id })).json.error).toBe("invalid_grant");
    expect(await DB.prepare("SELECT 1 FROM audit_log WHERE action = 'connected_app.revoke' AND target_id = ?").bind(mine.id).first()).not.toBeNull();
  });
  it("revoke-all needs manageUsers and revokes every live row", async () => {
    const { tokens } = await connect("read", "editor");
    const denied = await workerSelf.fetch(`${ORIGIN}/api/admin/connected-apps/revoke-all`, { method: "POST", headers: { origin: ORIGIN, cookie: cookies.editor! } });
    expect(denied.status).toBe(403);
    expect((await rpc(tokens.access_token, "tools/list")).status).toBe(200);
    const ok = await workerSelf.fetch(`${ORIGIN}/api/admin/connected-apps/revoke-all`, { method: "POST", headers: { origin: ORIGIN, cookie: cookies.admin! } });
    expect(ok.status).toBe(200);
    expect(await DB.prepare("SELECT COUNT(*) AS n FROM mcp_connections WHERE revoked_at IS NULL").first<{ n: number }>()).toEqual({ n: 0 });
    expect((await rpc(tokens.access_token, "tools/list")).status).toBe(401);
    expect(await DB.prepare("SELECT 1 FROM audit_log WHERE action = 'connected_app.revoke_all'").first()).not.toBeNull();
  });
});
