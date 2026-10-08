import { GrantType, OAuthAuthorizationServer, OAuthError, type TokenExchangeCallbackOptions, type TokenExchangeCallbackResult } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { isMcpAccessEnabled } from "../lib/mcp-access";
import { loadMcpAuthority, parseGrantProps } from "./authority";

export const ADMIN_ACCESS_TTL = 900;
export const ACCESS_TTL = 3600;
export const REFRESH_IDLE_TTL = 30 * 24 * 60 * 60;

/** Token rules (#699): the D1 connection row is authority; throwing `invalid_grant` revokes the library grant. */
export async function tokenExchangeRules(options: TokenExchangeCallbackOptions<Env>): Promise<TokenExchangeCallbackResult> {
  if (options.grantType !== GrantType.AUTHORIZATION_CODE && options.grantType !== GrantType.REFRESH_TOKEN) {
    throw new OAuthError("unsupported_grant_type", { description: "Unsupported grant type" });
  }
  if (!await isMcpAccessEnabled(options.env)) throw new OAuthError("temporarily_unavailable", { description: "MCP access is off" });
  const props = parseGrantProps(options.props);
  const authority = props ? await loadMcpAuthority(options.env, props) : null;
  if (!props || !authority) throw new OAuthError("invalid_grant", { description: "This connection is no longer valid" });
  if (options.grantType === GrantType.AUTHORIZATION_CODE) {
    await options.env.DB.prepare("UPDATE mcp_connections SET oauth_grant_id = ? WHERE id = ? AND oauth_grant_id IS NULL").bind(options.grantId, props.connectionId).run();
  }
  if (options.scope.includes("admin")) return { accessTokenTTL: ADMIN_ACCESS_TTL, refreshTokenTTL: 0 };
  return { accessTokenTTL: ACCESS_TTL, refreshTokenIdleTTL: REFRESH_IDLE_TTL };
}

const serversByEnv = new WeakMap<Env, OAuthAuthorizationServer<Env>>();

/** Built once per `env` object (same shape as getAuth, #360): never spread or clone env. */
export function getAuthorizationServer(env: Env): OAuthAuthorizationServer<Env> {
  const cached = serversByEnv.get(env);
  if (cached) return cached;
  const issuer = env.APP_ORIGIN;
  const server = new OAuthAuthorizationServer<Env>({
    issuer,
    authorizeEndpoint: "/oauth/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    resources: [mcpResource(env)],
    defaultResource: mcpResource(env),
    scopesSupported: ["read", "write", "admin"],
    accessTokenTTL: ACCESS_TTL,
    refreshTokenTTL: REFRESH_IDLE_TTL,
    refreshTokenIdleTTL: REFRESH_IDLE_TTL,
    tokenExchangeCallback: tokenExchangeRules,
  });
  serversByEnv.set(env, server);
  return server;
}

export const mcpResource = (env: Env) => `${env.APP_ORIGIN}/mcp`;
