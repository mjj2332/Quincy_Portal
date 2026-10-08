import type { Context, Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { terminalRoute } from "../lib/terminal-route";
import type { AppEnv } from "../env";
import { isMcpAccessEnabled } from "../lib/mcp-access";
import { loadMcpAuthority, parseGrantProps, MCP_SCOPES, type McpScope } from "./authority";
import { getAuthorizationServer, mcpResource } from "./oauth-server";
import { toolsFor, strictInput } from "./tools/registry";
import { checkMcpRateLimit, rateLimitedResult, readBoundedBody } from "./rate-limit";
import { CONSENT_PATH_PREFIX, storeConsentDescription } from "./consent";
import type { McpFetchApp } from "./dispatch";
import type { McpTool } from "./tools/registry";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, accept", "access-control-expose-headers": "www-authenticate, mcp-session-id", "access-control-max-age": "86400" } as const;
const LAST_USED_GRANULARITY_MS = 60_000;
const notFound = (c: Context<AppEnv>) => c.json({ error: "Not found" }, 404);

/** The library writes `props`/`auth` onto the context it is given: hand it a fresh object, never `c.executionCtx`. */
function freshContext(c: Context<AppEnv>): ExecutionContext {
  return { waitUntil: (p: Promise<unknown>) => c.executionCtx.waitUntil(p), passThroughOnException: () => c.executionCtx.passThroughOnException(), props: undefined } as unknown as ExecutionContext;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
function errorPage(message: string) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Cannot connect</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>Cannot connect this app</h1><p>${escapeHtml(message)}</p></body>`, { status: 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function setCookies(from: Headers, to: Headers) {
  const getSetCookie = (from as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  for (const cookie of getSetCookie ? getSetCookie.call(from) : (from.get("set-cookie") ? [from.get("set-cookie")!] : [])) to.append("set-cookie", cookie);
}

function bearer(c: Context<AppEnv>): string | null {
  return /^Bearer[\t ]+([^\s,]+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? null;
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

type JsonRpcMessage = { jsonrpc?: string; id?: string | number | null; method?: string; params?: { name?: unknown } };
const rpcError = (c: Context<AppEnv>, status: 400 | 413, code: number, message: string) => c.json({ jsonrpc: "2.0", id: null, error: { code, message } }, status);

/**
 * Reads the POST body once, bounded to 1 MiB, and parses it once. Returns the parsed body for the transport to reuse,
 * or the Response to send: 413 when too large, -32700 when not JSON, -32600 for a batch (removed in protocol 2025-06-18),
 * or the rate-limit result when the single `tools/call` is over its limit.
 */
async function admitBody(c: Context<AppEnv>, connectionId: string, tools: readonly McpTool[]): Promise<{ parsedBody?: unknown } | { response: Response }> {
  if (c.req.method !== "POST") return {};
  const read = await readBoundedBody(c.req.raw);
  if ("tooLarge" in read) return { response: rpcError(c, 413, -32600, "Request body is too large") };
  let body: unknown;
  try { body = JSON.parse(read.text); } catch { return { response: rpcError(c, 400, -32700, "Parse error") }; }
  if (Array.isArray(body)) return { response: rpcError(c, 400, -32600, "Batching is not supported") };
  const message = body as JsonRpcMessage | null;
  if (message && typeof message === "object" && message.method === "tools/call" && message.id !== undefined && message.id !== null) {
    const tool = tools.find((candidate) => candidate.name === message.params?.name);
    const kind = await checkMcpRateLimit(c.env, connectionId, tool !== undefined && tool.annotations.readOnlyHint !== true);
    if (kind) return { response: c.json({ jsonrpc: "2.0", id: message.id, result: rateLimitedResult(kind) }, 200) };
  }
  return { parsedBody: body };
}

export function mountMcp(app: Hono<AppEnv>, fetchApp: McpFetchApp) {
  const asFetch = (path: string) => terminalRoute(path, async (c) => getAuthorizationServer(c.env).fetch(c.req.raw, c.env, freshContext(c)));
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/*", "/oauth/token", "/oauth/register"]) {
    app.all(path, asFetch(path));
  }

  // RFC 9728 metadata: the AS serves only its own, so the resource's is built here.
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/*"]) {
    app.all(path, terminalRoute(path, (c) => c.req.method !== "GET" && c.req.method !== "HEAD" ? c.json({ error: "Method not allowed" }, 405) : c.json({ resource: mcpResource(c.env), authorization_servers: [c.env.APP_ORIGIN], scopes_supported: [...MCP_SCOPES], bearer_methods_supported: ["header"], resource_name: "Quincy Portal" })));
  }

  app.get("/oauth/authorize", terminalRoute("/oauth/authorize", async (c) => {
    if (!await isMcpAccessEnabled(c.env)) return notFound(c);
    const api = getAuthorizationServer(c.env).getOAuthApi(c.env);
    let handle: string; let headers: Headers;
    try {
      const request = await api.parseAuthRequest(c.req.raw);
      const description = await api.describeConsent(request);
      ({ handle, headers } = await api.beginConsent(request));
      await storeConsentDescription(c.env, handle, description);
    } catch (error) {
      // Invalid requests never redirect: the redirect_uri is not yet trusted.
      return errorPage(error instanceof Error && error.message ? error.message : "The authorization request is not valid.");
    }
    const out = new Headers({ location: `${c.env.APP_ORIGIN}${CONSENT_PATH_PREFIX}${handle}`, "cache-control": "no-store" });
    setCookies(headers, out);
    return new Response(null, { status: 302, headers: out });
  }));

  const mcpHandler = (path: string) => terminalRoute(path, async (c) => {
    if (!await isMcpAccessEnabled(c.env)) return notFound(c);
    if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const challenge = { "www-authenticate": `Bearer resource_metadata="${c.env.APP_ORIGIN}/.well-known/oauth-protected-resource/mcp"` };
    const unauthorized = () => withCors(c.json({ error: "invalid_token" }, 401, challenge));
    const token = bearer(c);
    const validated = token ? await getAuthorizationServer(c.env).validateToken(mcpResource(c.env), token, c.env).catch(() => null) : null;
    const props = validated ? parseGrantProps(validated.props) : null;
    const authority = props ? await loadMcpAuthority(c.env, props) : null;
    if (!validated || !props || !authority) return unauthorized();
    const scopes = validated.scope.filter((s): s is McpScope => MCP_SCOPES.includes(s as McpScope) && authority.connectionScopes.includes(s as McpScope));
    const now = Date.now();
    c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE mcp_connections SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)").bind(now, props.connectionId, now - LAST_USED_GRANULARITY_MS).run());

    const principal = { userId: props.userId, connectionId: props.connectionId, clientName: props.clientName, authorizationEpoch: props.authorizationEpoch };
    const tools = toolsFor(authority.user.role, scopes);

    // Rate limit per Connected app: every tools/call is counted, and a call to a tool without readOnlyHint also counts as a write.
    const admitted = await admitBody(c, props.connectionId, tools);
    if ("response" in admitted) return withCors(admitted.response);

    const server = new McpServer({ name: "quincy-portal", version: "1.0.0" });
    for (const tool of tools) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: strictInput(tool), annotations: tool.annotations }, async (input: Record<string, unknown>) =>
        tool.call({ env: c.env, executionCtx: c.executionCtx as ExecutionContext, fetchApp, principal, role: authority.user.role }, input));
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return withCors(await transport.handleRequest(c.req.raw, admitted.parsedBody === undefined ? undefined : { parsedBody: admitted.parsedBody }));
  });
  app.all("/mcp", mcpHandler("/mcp"));
  app.all("/mcp/", mcpHandler("/mcp/"));
}
