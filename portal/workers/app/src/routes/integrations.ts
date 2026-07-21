import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env";
import { requireCapability } from "../middleware/capability";
import { encryptCredentials } from "@quincy/shared";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";

export const integrationsRoutes = new Hono<AppEnv>();
const stateKey = (nonce: string) => `dropbox_oauth_state:${nonce}`;
function dropboxState(): string { const bytes = crypto.getRandomValues(new Uint8Array(16)); return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

// Scope to /integrations paths only: use("*") leaks onto sibling routers mounted at the same base.
integrationsRoutes.use("/integrations", requireCapability("manageIntegrations"));
integrationsRoutes.use("/integrations/*", requireCapability("manageIntegrations"));
integrationsRoutes.get("/integrations", async (c) => c.json({ integrations: await createDb(c.env.DB).select({ id: schema.integrationConnections.id, provider: schema.integrationConnections.provider, status: schema.integrationConnections.status, expiresAt: schema.integrationConnections.expiresAt, scopes: schema.integrationConnections.scopes, lastEventAt: schema.integrationConnections.lastEventAt, lastError: schema.integrationConnections.lastError, updatedAt: schema.integrationConnections.updatedAt }).from(schema.integrationConnections).all() }));
integrationsRoutes.post("/integrations/dropbox/connect-url", async (c) => {
  if (!c.env.DROPBOX_APP_KEY) return c.json({ error: "Dropbox OAuth is not configured" }, 503);
  const nonce = dropboxState(); await c.env.SESSIONS.put(stateKey(nonce), c.get("user").id, { expirationTtl: 600 });
  const redirect = `${c.env.APP_ORIGIN}/api/integrations/dropbox/callback`; const url = new URL("https://www.dropbox.com/oauth2/authorize");
  url.search = new URLSearchParams({ client_id: c.env.DROPBOX_APP_KEY, response_type: "code", token_access_type: "offline", redirect_uri: redirect, state: nonce }).toString();
  return c.json({ url: url.toString() });
});
integrationsRoutes.get("/integrations/dropbox/callback", async (c) => {
  if (!c.env.DROPBOX_APP_KEY || !c.env.INTEGRATION_KEK) return c.json({ error: "Dropbox OAuth is not configured" }, 503);
  const state = c.req.query("state"); if (!state) return c.json({ error: "Invalid or expired Dropbox OAuth state" }, 400);
  const stateUserId = await c.env.SESSIONS.get(stateKey(state));
  if (!stateUserId || stateUserId !== c.get("user").id) return c.json({ error: "Invalid or expired Dropbox OAuth state" }, 400);
  await c.env.SESSIONS.delete(stateKey(state));
  const code = c.req.query("code"); if (!code || !c.env.DROPBOX_APP_SECRET) return c.json({ error: "Dropbox OAuth configuration or code is missing" }, 400);
  const redirect = `${c.env.APP_ORIGIN}/api/integrations/dropbox/callback`; const response = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, grant_type: "authorization_code", client_id: c.env.DROPBOX_APP_KEY, client_secret: c.env.DROPBOX_APP_SECRET, redirect_uri: redirect }) }); if (!response.ok) return c.json({ error: "Dropbox token exchange failed" }, 502);
  const token = await response.json() as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown }; if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string" || typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0) return c.json({ error: "Dropbox token exchange returned invalid credentials" }, 502);
  const expiresAt = new Date(Date.now() + token.expires_in * 1000); const encryptedCredentials = await encryptCredentials(c.env.INTEGRATION_KEK, JSON.stringify({ accessToken: token.access_token, refreshToken: token.refresh_token })); const db = createDb(c.env.DB); const old = await db.select({ id: schema.integrationConnections.id }).from(schema.integrationConnections).where(eq(schema.integrationConnections.provider, "dropbox")).get(); const values = { status: "connected" as const, encryptedCredentials, expiresAt, scopes: typeof token.scope === "string" ? token.scope : null, lastError: null, updatedAt: new Date() }; if (old) await db.update(schema.integrationConnections).set(values).where(eq(schema.integrationConnections.id, old.id)); else await db.insert(schema.integrationConnections).values({ id: newId(), provider: "dropbox", ...values, createdAt: new Date() }); await audit(c.env, c.get("user").id, "integration.dropbox.connect", "integration", old?.id ?? "dropbox"); return c.redirect(`${c.env.APP_ORIGIN}/`);
});
