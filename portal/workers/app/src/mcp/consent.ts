import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../env";

export const CONSENT_PATH_PREFIX = "/settings/connected-apps/consent/";
export const CONSENT_HANDLE = /^[A-Za-z0-9_-]{43}$/;
const TTL_SECONDS = 600;
const key = (handle: string) => `portal-consent:${handle}`;

/** The library has no "peek" for a handle, so the SPA's consent page reads what `describeConsent` said at authorize time. */
export type StoredConsent = Pick<ConsentDescription, "clientName" | "redirectHost" | "redirectIsLoopback" | "scope">;

export async function storeConsentDescription(env: Env, handle: string, description: ConsentDescription) {
  const value: StoredConsent = { clientName: description.clientName, redirectHost: description.redirectHost, redirectIsLoopback: description.redirectIsLoopback, scope: description.scope };
  await env.OAUTH_KV.put(key(handle), JSON.stringify(value), { expirationTtl: TTL_SECONDS });
}
export const loadConsentDescription = (env: Env, handle: string) => env.OAUTH_KV.get<StoredConsent>(key(handle), "json");
export const dropConsentDescription = (env: Env, handle: string) => env.OAUTH_KV.delete(key(handle));
