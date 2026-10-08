import { Hono } from "hono";
import { z } from "zod";
import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { roleHasCapability } from "@quincy/shared";
import { terminalRoute } from "../lib/terminal-route";
import type { AppEnv } from "../env";
import { auditMeta } from "../lib/audit";
import { newId } from "../lib/ids";
import { isMcpAccessEnabled } from "../lib/mcp-access";
import { jsonInput } from "./helpers";
import { getAuthorizationServer } from "../mcp/oauth-server";
import { CONSENT_HANDLE, dropConsentDescription, loadConsentDescription } from "../mcp/consent";
import { MCP_SCOPES, type McpScope } from "../mcp/authority";

export const connectedAppsRoutes = new Hono<AppEnv>();

const WARNING = "This app will see Portal data you can see";
const consentInput = z.object({ decision: z.enum(["approve", "deny"]), scopes: z.array(z.enum(["read", "write", "admin"])).max(3) }).strict();
const AUDIT_SQL = "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)";
const gone = (c: { json: (d: unknown, s: number) => Response }) => c.json({ error: "This connection request expired or was already used", code: "consent_expired" }, 404);

function parseScopes(value: string): McpScope[] {
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((s): s is McpScope => MCP_SCOPES.includes(s as McpScope)) : []; } catch { return []; }
}
function forwardCookies(from: Headers, to: Headers) {
  const get = (from as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  for (const cookie of get ? get.call(from) : (from.get("set-cookie") ? [from.get("set-cookie")!] : [])) to.append("set-cookie", cookie);
}

connectedAppsRoutes.get("/connected-apps/consent/:handle", terminalRoute("/connected-apps/consent/:handle", async (c) => {
  if (!await isMcpAccessEnabled(c.env)) return c.json({ error: "Not found" }, 404);
  const handle = c.req.param("handle");
  const stored = CONSENT_HANDLE.test(handle) ? await loadConsentDescription(c.env, handle) : null;
  if (!stored) return gone(c);
  return c.json({ clientName: stored.clientName, redirectHost: stored.redirectHost, isLocalhost: stored.redirectIsLoopback, scopes: stored.scope, warning: WARNING });
}));

connectedAppsRoutes.post("/connected-apps/consent/:handle", terminalRoute("/connected-apps/consent/:handle", async (c) => {
  const user = c.get("user");
  if (user.impersonatedBy) return c.json({ error: "Connecting an app is not available while impersonating", code: "impersonation_consent_refused" }, 403);
  if (!await isMcpAccessEnabled(c.env)) return c.json({ error: "Not found" }, 404);
  const data = await jsonInput(c, consentInput); if (data instanceof Response) return data;
  const handle = c.req.param("handle");
  const stored = CONSENT_HANDLE.test(handle) ? await loadConsentDescription(c.env, handle) : null;
  if (!stored) return gone(c);
  const api = getAuthorizationServer(c.env).getOAuthApi(c.env);
  const respond = (body: Record<string, unknown>, headers: Headers) => { const out = new Headers({ "content-type": "application/json", "cache-control": "no-store" }); forwardCookies(headers, out); return new Response(JSON.stringify(body), { headers: out }); };

  if (data.decision === "deny") {
    try {
      const denied = await api.denyConsent(c.req.raw, handle);
      await dropConsentDescription(c.env, handle);
      await c.env.DB.prepare(AUDIT_SQL).bind(newId(), user.id, "connected_app.deny", "mcp_client", null, auditMeta(user, { clientName: stored.clientName, redirectHost: stored.redirectHost }), Date.now()).run();
      return respond({ redirectTo: denied.headers.get("location") }, denied.headers);
    } catch (error) { if (error instanceof AuthorizationError) return gone(c); throw error; }
  }

  const granted = [...new Set(data.scopes)];
  if (!granted.includes("read")) return c.json({ error: "The read scope is required" }, 400);
  if (granted.includes("admin") && !roleHasCapability(user.role, "manageUsers")) return c.json({ error: "Only an admin can grant the admin scope", code: "admin_scope_refused" }, 403);
  if (granted.includes("admin") && user.role !== "admin") return c.json({ error: "Only an admin can grant the admin scope", code: "admin_scope_refused" }, 403);
  const offered = new Set(stored.scope);
  if (granted.some((s) => s !== "read" && !offered.has(s))) return c.json({ error: "A scope was granted that the app did not request" }, 400);

  let approved;
  try { approved = await api.approveConsent(c.req.raw, handle, { scope: granted }); }
  catch (error) { if (error instanceof AuthorizationError) return gone(c); throw error; }
  await dropConsentDescription(c.env, handle);

  const connectionId = newId(); const now = Date.now();
  const clientId = approved.request.clientId;
  // Library grants of the rows this consent supersedes; revoked best-effort below. D1 is the boundary.
  const superseded = await c.env.DB.prepare("SELECT oauth_grant_id, user_id FROM mcp_connections WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL").bind(user.id, clientId).all<{ oauth_grant_id: string | null; user_id: string }>();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE mcp_connections SET revoked_at = ?, revoked_by = ?, revoke_reason = 'superseded' WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL").bind(now, user.id, user.id, clientId),
    c.env.DB.prepare("INSERT INTO mcp_connections (id, user_id, client_id, client_name, redirect_host, scopes, authorization_epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(connectionId, user.id, clientId, stored.clientName, stored.redirectHost, JSON.stringify(granted), user.authorizationEpoch, now),
    c.env.DB.prepare(AUDIT_SQL).bind(newId(), user.id, "connected_app.grant", "mcp_connection", connectionId, auditMeta(user, { clientName: stored.clientName, redirectHost: stored.redirectHost, scopes: granted }), now),
  ]);
  try {
    const { redirectTo } = await api.completeAuthorization({
      request: approved.request, userId: user.id, metadata: { clientId }, scope: granted,
      // Never let the library sweep this user+client: a concurrent consent's newer grant would die with it.
      revokeExistingGrants: false,
      props: { userId: user.id, connectionId, authorizationEpoch: user.authorizationEpoch, clientName: stored.clientName },
    });
    await revokeInLibrary(c.env, superseded.results);
    return respond({ redirectTo }, approved.headers);
  } catch (error) {
    await c.env.DB.prepare("UPDATE mcp_connections SET revoked_at = ?, revoked_by = ?, revoke_reason = 'failed' WHERE id = ? AND revoked_at IS NULL").bind(Date.now(), user.id, connectionId).run();
    throw error;
  }
}));

connectedAppsRoutes.get("/connected-apps", terminalRoute("/connected-apps", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, client_name, redirect_host, scopes, created_at, last_used_at FROM mcp_connections WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC")
    .bind(c.get("user").id).all<{ id: string; client_name: string; redirect_host: string; scopes: string; created_at: number; last_used_at: number | null }>();
  return c.json(rows.results.map((r) => ({ id: r.id, clientName: r.client_name, redirectHost: r.redirect_host, scopes: parseScopes(r.scopes), createdAt: r.created_at, lastUsedAt: r.last_used_at, status: "active" as const })));
}));

async function revokeInLibrary(env: AppEnv["Bindings"], grants: { oauth_grant_id: string | null; user_id: string }[]) {
  const api = getAuthorizationServer(env).getOAuthApi(env);
  for (const grant of grants) {
    if (!grant.oauth_grant_id) continue;
    try { await api.revokeGrant(grant.oauth_grant_id, grant.user_id); } catch { /* best effort: the D1 row is the revocation boundary */ }
  }
}

connectedAppsRoutes.delete("/connected-apps/:id", terminalRoute("/connected-apps/:id", async (c) => {
  const user = c.get("user"); const id = c.req.param("id"); const now = Date.now();
  const row = await c.env.DB.prepare("SELECT oauth_grant_id, user_id, client_name FROM mcp_connections WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(id, user.id).first<{ oauth_grant_id: string | null; user_id: string; client_name: string }>();
  if (!row) return c.json({ error: "Connected app not found" }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE mcp_connections SET revoked_at = ?, revoked_by = ?, revoke_reason = 'user' WHERE id = ? AND revoked_at IS NULL").bind(now, user.id, id),
    c.env.DB.prepare(AUDIT_SQL).bind(newId(), user.id, "connected_app.revoke", "mcp_connection", id, auditMeta(user, { clientName: row.client_name }), now),
  ]);
  await revokeInLibrary(c.env, [row]);
  return c.body(null, 204);
}));

connectedAppsRoutes.post("/admin/connected-apps/revoke-all", terminalRoute("/admin/connected-apps/revoke-all", async (c) => {
  const user = c.get("user");
  if (!roleHasCapability(user.role, "manageUsers")) return c.json({ error: "Forbidden", capability: "manageUsers" }, 403);
  const live = await c.env.DB.prepare("SELECT oauth_grant_id, user_id FROM mcp_connections WHERE revoked_at IS NULL").all<{ oauth_grant_id: string | null; user_id: string }>();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE mcp_connections SET revoked_at = ?, revoked_by = ?, revoke_reason = 'admin_revoke_all' WHERE revoked_at IS NULL").bind(now, user.id),
    c.env.DB.prepare(AUDIT_SQL).bind(newId(), user.id, "connected_app.revoke_all", "mcp_connection", null, auditMeta(user, { count: live.results.length }), now),
  ]);
  await revokeInLibrary(c.env, live.results);
  return c.json({ revoked: live.results.length });
}));
