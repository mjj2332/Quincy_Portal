import { env } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const adminToken = "test-integrations-admin-session-token";
const photographerToken = "test-integrations-photographer-session-token";
const kek = btoa("k".repeat(32));
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

async function executeSql(sql: string): Promise<void> {
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const withoutComments = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of withoutComments.split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); }
  }
}

const requestEnv: Env = { ...baseEnv, DROPBOX_APP_KEY: "test-dropbox-app-key", DROPBOX_APP_SECRET: "test-dropbox-app-secret", INTEGRATION_KEK: kek };
const executionContext = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
async function request(path: string, token: string, method: "GET" | "POST" = "GET"): Promise<Response> {
  const context = await createAuth(requestEnv).$context;
  const cookie = `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
  return app.fetch(new Request(`https://portal.test${path}`, { method, headers: { cookie, ...(method === "POST" ? { origin: requestEnv.APP_ORIGIN } : {}) } }), requestEnv, executionContext);
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind("test-integrations-admin-session", now + 60 * 60 * 1000, adminToken, "seed-admin", now, now).run();
  await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind("test-integrations-photographer", "Integrations Photographer", "integrations-photographer@example.test", 1, "photographer", 1, now, now).run();
  await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind("test-integrations-photographer-session", now + 60 * 60 * 1000, photographerToken, "test-integrations-photographer", now, now).run();
});

describe("Dropbox integrations", () => {
  it("returns an offline Dropbox authorize URL with one-time user-bound state", async () => {
    const response = await request("/api/integrations/dropbox/connect-url", adminToken, "POST");
    expect(response.status).toBe(200);
    const url = new URL((await response.json() as { url: string }).url);
    expect(url.origin + url.pathname).toBe("https://www.dropbox.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-dropbox-app-key");
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    expect(url.searchParams.get("redirect_uri")).toBe(`${requestEnv.APP_ORIGIN}/api/integrations/dropbox/callback`);
    const state = url.searchParams.get("state");
    expect(state).toMatch(/^[a-f0-9]{32}$/);
    await expect(baseEnv.SESSIONS.get(`dropbox_oauth_state:${state}`)).resolves.toBe("seed-admin");
  });

  it("rejects missing and forged OAuth state before creating a connection", async () => {
    const [missing, forged] = await Promise.all([
      request("/api/integrations/dropbox/callback?code=unused", adminToken),
      request("/api/integrations/dropbox/callback?code=unused&state=0000000000000.0000000000000000000000000000000000000000000000000000000000000000", adminToken),
    ]);
    expect(missing.status).toBe(400); expect(forged.status).toBe(400);
    const rows = await database.DB.prepare("SELECT id FROM integration_connections WHERE provider = ?").bind("dropbox").all();
    expect(rows.results).toHaveLength(0);
  });

  it("consumes OAuth state before attempting the token exchange", async () => {
    const url = new URL((await (await request("/api/integrations/dropbox/connect-url", adminToken, "POST")).json() as { url: string }).url);
    const state = url.searchParams.get("state")!;
    const first = await request(`/api/integrations/dropbox/callback?state=${state}`, adminToken);
    const second = await request(`/api/integrations/dropbox/callback?state=${state}`, adminToken);
    expect(first.status).toBe(400);
    expect(second.status).toBe(400);
    await expect(baseEnv.SESSIONS.get(`dropbox_oauth_state:${state}`)).resolves.toBeNull();
  });

  it("rejects a photographer without manageIntegrations", async () => {
    const response = await request("/api/integrations/dropbox/connect-url", photographerToken, "POST");
    expect(response.status).toBe(403);
  });
});
