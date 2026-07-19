import { betterAuth, APIError } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type { Env } from "./env";

export function createAuth(env: Env) {
  const db = createDb(env.DB);
  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema, usePlural: false }),
    secret: env.BETTER_AUTH_SECRET || "dev-only-replace-better-auth-secret-32-bytes",
    baseURL: env.APP_ORIGIN,
    basePath: "/api/auth",
    trustedOrigins: [env.APP_ORIGIN],
    user: { additionalFields: { role: { type: "string", input: false }, active: { type: "boolean", input: false } } },
    socialProviders: googleConfigured ? { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, disableImplicitSignUp: true, disableSignUp: true } } : {},
    databaseHooks: {
      user: { create: { before: async () => { throw new APIError("FORBIDDEN", { message: "This is a closed staff system. Ask an administrator to provision your account." }); } } },
      session: { create: { before: async (session) => {
        const user = await db.select({ active: schema.user.active }).from(schema.user).where(eq(schema.user.id, session.userId)).get();
        if (!user?.active) throw new APIError("FORBIDDEN", { message: "This staff account is inactive." });
      } } },
    },
  });
}

export async function getSession(c: Context<any>) {
  const auth = createAuth(c.env);
  // Better Auth's typed endpoint accepts the request headers and validates its session cookie.
  return (auth.api.getSession as (input: { headers: Headers }) => Promise<{ user: Record<string, unknown>; session: Record<string, unknown> } | null>)({ headers: c.req.raw.headers });
}
