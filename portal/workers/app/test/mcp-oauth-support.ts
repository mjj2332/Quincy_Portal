import { SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { expect } from "vitest";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/** The OAuth flow and JSON-RPC helpers the MCP tests share (same flow as `mcp-auth.test.ts`). */
export function mcpHarness(testEnv: Env) {
  const DB = testEnv.DB; const ORIGIN = testEnv.APP_ORIGIN; const RESOURCE = `${ORIGIN}/mcp`; const REDIRECT = "https://client.test/cb";
  const authSecret = testEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
  const cookies: Record<string, string> = {};
  const json = { "content-type": "application/json" };
  const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await DB.exec(`${flat};`); } }
  async function cookieFor(token: string) { const context = await createAuth(testEnv).$context; return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`; }
  async function addUser(id: string, role: string) { const t = Date.now(); await DB.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, ?, ?)").bind(id, `MCP ${role}`, `${id}@example.test`, role, t, t).run(); }
  async function addSession(name: string, userId: string) {
    const t = Date.now(); const token = `mcp-reads-${name}-token`;
    await DB.prepare("INSERT OR IGNORE INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(`mcp-reads-${name}`, t + 3_600_000, token, userId, t, t).run();
    cookies[name] = await cookieFor(token);
  }
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
  const consentFetch = (handle: string, who: string, binding: string, body: unknown) => workerSelf.fetch(`${ORIGIN}/api/connected-apps/consent/${handle}`, { method: "POST", headers: { ...json, origin: ORIGIN, cookie: [cookies[who], binding].join("; ") }, body: JSON.stringify(body) });
  /** Runs DCR, authorize, consent and the token exchange for `who`, and returns the access token. */
  async function connect(scope: string, who: string, granted?: string[]): Promise<{ accessToken: string; connectionId: string; expiresIn: number; refreshToken: string | undefined }> {
    const client_id = await register();
    const a = await authorize(client_id, scope);
    expect(a.res.status).toBe(302);
    const approved = await consentFetch(a.handle, who, a.binding, { decision: "approve", scopes: granted ?? scope.split(" ") });
    expect(approved.status).toBe(200);
    const code = new URL(((await approved.json()) as { redirectTo: string }).redirectTo).searchParams.get("code")!;
    const res = await workerSelf.fetch(`${ORIGIN}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id, redirect_uri: REDIRECT, code_verifier: a.verifier, resource: RESOURCE }) });
    expect(res.status).toBe(200);
    const row = await DB.prepare("SELECT id FROM mcp_connections WHERE client_id = ?").bind(client_id).first<{ id: string }>();
    const tokens = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    return { accessToken: tokens.access_token, connectionId: row!.id, expiresIn: tokens.expires_in, refreshToken: tokens.refresh_token };
  }
  let rpcId = 0;
  const rpc = (token: string, method: string, params: unknown = {}) => workerSelf.fetch(`${ORIGIN}/mcp`, { method: "POST", headers: { ...json, accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  type ToolResult = { content: { type: string; text: string }[]; isError?: boolean; _meta?: { retryAfterSeconds?: number } };
  const toolsList = async (token: string) => ((await (await rpc(token, "tools/list")).json()) as { result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] } }).result.tools;
  const callTool = async (token: string, name: string, args: unknown = {}) => (await (await rpc(token, "tools/call", { name, arguments: args })).json()) as { result?: ToolResult; error?: { code: number; message: string } };
  const asCookie = (who: string, path: string) => workerSelf.fetch(`${ORIGIN}${path}`, { headers: { cookie: cookies[who]! } });
  return { DB, ORIGIN, cookies, executeSql, addUser, addSession, register, authorize, consentFetch, connect, rpc, toolsList, callTool, asCookie };
}
