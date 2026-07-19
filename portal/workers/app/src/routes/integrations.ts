import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env";
import { requireCapability } from "../middleware/capability";
import { encryptCredentials } from "@quincy/shared";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";

export const integrationsRoutes = new Hono<AppEnv>();
// Scope to /integrations paths only: use("*") leaks onto sibling routers mounted at the same base.
integrationsRoutes.use("/integrations", requireCapability("manageIntegrations"));
integrationsRoutes.use("/integrations/*", requireCapability("manageIntegrations"));
integrationsRoutes.get("/integrations", async (c) => c.json({ integrations: await createDb(c.env.DB).select({ id: schema.integrationConnections.id, provider: schema.integrationConnections.provider, status: schema.integrationConnections.status, expiresAt: schema.integrationConnections.expiresAt, scopes: schema.integrationConnections.scopes, lastEventAt: schema.integrationConnections.lastEventAt, lastError: schema.integrationConnections.lastError, updatedAt: schema.integrationConnections.updatedAt }).from(schema.integrationConnections).all() }));
integrationsRoutes.post("/integrations/dropbox/connect-url", async (c) => { if (!c.env.DROPBOX_APP_KEY) return c.json({ error: "Dropbox OAuth is not configured" }, 503); const redirect = `${c.env.APP_ORIGIN}/api/integrations/dropbox/callback`; const url = new URL("https://www.dropbox.com/oauth2/authorize"); url.search = new URLSearchParams({ client_id: c.env.DROPBOX_APP_KEY, response_type: "code", token_access_type: "offline", redirect_uri: redirect }).toString(); return c.json({ url: url.toString() }); });
integrationsRoutes.get("/integrations/dropbox/callback", async (c) => {
  const code = c.req.query("code"); if (!code || !c.env.DROPBOX_APP_KEY || !c.env.DROPBOX_APP_SECRET || !c.env.INTEGRATION_KEK) return c.json({ error: "Dropbox OAuth configuration or code is missing" }, 400);
  const redirect = `${c.env.APP_ORIGIN}/api/integrations/dropbox/callback`; const response = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, grant_type: "authorization_code", client_id: c.env.DROPBOX_APP_KEY, client_secret: c.env.DROPBOX_APP_SECRET, redirect_uri: redirect }) }); if (!response.ok) return c.json({ error: "Dropbox token exchange failed" }, 502);
  const token = await response.json() as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string }; const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null; const encryptedCredentials = await encryptCredentials(c.env.INTEGRATION_KEK, JSON.stringify({ access_token: token.access_token, refresh_token: token.refresh_token, expires_at: expiresAt?.toISOString(), scope: token.scope })); const db = createDb(c.env.DB); const old = await db.select({ id: schema.integrationConnections.id }).from(schema.integrationConnections).where(eq(schema.integrationConnections.provider, "dropbox")).get(); const values = { status: "connected" as const, encryptedCredentials, expiresAt, scopes: token.scope ?? null, lastError: null, updatedAt: new Date() }; if (old) await db.update(schema.integrationConnections).set(values).where(eq(schema.integrationConnections.id, old.id)); else await db.insert(schema.integrationConnections).values({ id: newId(), provider: "dropbox", ...values, createdAt: new Date() }); await audit(c.env, c.get("user").id, "integration.dropbox.connect", "integration", old?.id ?? "dropbox"); return c.redirect(`${c.env.APP_ORIGIN}/`);
});
