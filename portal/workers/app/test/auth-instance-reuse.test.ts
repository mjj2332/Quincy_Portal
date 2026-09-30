import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { authInstanceBuildCount, createAuth, getAuth } from "../src/auth";
import type { Env } from "../src/env";

// Own file so the isolate (and the build counter) starts fresh (#360).
const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const token = "auth-reuse-session-token";
const userId = "auth-reuse-user";
declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;

async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); } }

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, 'photographer', 1, ?, ?)").bind(userId, "Reuse User", "auth-reuse@example.test", now, now).run();
  await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind("auth-reuse-session", now + 3_600_000, token, userId, now, now).run();
});

describe("auth instance reuse per isolate (#360)", () => {
  it("builds the auth instance once across many requests", async () => {
    // createAuth does not touch the counter, so minting the cookie leaves it at 0.
    const context = await createAuth(baseEnv).$context;
    const cookie = `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
    expect(authInstanceBuildCount()).toBe(0);
    const paths = ["/api/me", "/api/projects", "/api/auth/get-session", "/media/does-not-exist"];
    for (let i = 0; i < 20; i++) {
      const response = await SELF.fetch(`https://portal.test${paths[i % paths.length]}`, { headers: { cookie } });
      expect(response.status).toBeLessThan(500);
    }
    // `=== 1`, not `<= 1`: a 0 means SELF does not share this module registry and must fail loudly.
    expect(authInstanceBuildCount()).toBe(1);
  });

  it("keys on the env object", () => {
    expect(getAuth(baseEnv)).toBe(getAuth(baseEnv));
    expect(getAuth({ ...baseEnv })).not.toBe(getAuth(baseEnv));
  });
});
