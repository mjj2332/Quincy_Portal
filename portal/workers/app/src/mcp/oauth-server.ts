import { GrantType, OAuthAuthorizationServer, OAuthError, type TokenExchangeCallbackOptions, type TokenExchangeCallbackResult } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";
import { isMcpAccessEnabled } from "../lib/mcp-access";
import { loadMcpAuthority, parseGrantProps } from "./authority";

export const ADMIN_ACCESS_TTL = 900;
export const ACCESS_TTL = 3600;
export const REFRESH_IDLE_TTL = 30 * 24 * 60 * 60;
/** An `admin` grant refreshes until 8 hours after consent, then the Admin consents again (ADR 0026, #962). */
export const ADMIN_MAX_SESSION_SECONDS = 8 * 60 * 60;
/** The library's floor for a refresh-token lifetime (KV's minimum TTL); below it the cap counts as reached. */
const MIN_REFRESH_SECONDS = 60;

/** Whole seconds left before the admin cap, or null when the grant carries no consent time. */
function adminSecondsLeft(consentedAt: number | undefined): number | null {
  if (consentedAt === undefined) return null;
  return Math.floor((consentedAt + ADMIN_MAX_SESSION_SECONDS * 1000 - Date.now()) / 1000);
}

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
  if (options.scope.includes("admin")) {
    // The live checks above run first, so revoke, an epoch bump and the flag still cut refresh at once.
    const left = adminSecondsLeft(props.consentedAt);
    if (options.grantType === GrantType.AUTHORIZATION_CODE) {
      // The grant's lifetime ends at the cap; a grant with no consent time gets no refresh token.
      return { accessTokenTTL: ADMIN_ACCESS_TTL, refreshTokenTTL: left !== null && left >= MIN_REFRESH_SECONDS ? left : 0 };
    }
    if (left === null || left < MIN_REFRESH_SECONDS) throw new OAuthError("invalid_grant", { description: "Admin access lasts 8 hours from consent; connect again" });
    // Returned on every refresh: the provider's global 30-day idle TTL would otherwise slide past the cap.
    return { accessTokenTTL: ADMIN_ACCESS_TTL, refreshTokenIdleTTL: left };
  }
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
