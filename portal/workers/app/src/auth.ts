import { betterAuth, APIError } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, createAccessControl } from "better-auth/plugins";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type { Env } from "./env";
import { audit } from "./lib/audit";
import { assertImpersonationSessionAllowed } from "./lib/impersonation";

const adminStatements = {
  user: [
    "create",
    "list",
    "set-role",
    "ban",
    "impersonate",
    "impersonate-admins",
    "delete",
    "set-password",
    "set-email",
    "get",
    "update",
  ],
  session: ["list", "revoke", "delete"],
} as const;

const ac = createAccessControl(adminStatements);
const adminRole = ac.newRole({ user: ["impersonate"], session: [] });
const photographerRole = ac.newRole({ user: [], session: [] });
const editorRole = ac.newRole({ user: [], session: [] });
const externalEditorRole = ac.newRole({ user: [], session: [] });

export function createAuth(env: Env) {
  const db = createDb(env.DB);
  const googleConfigured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite", schema, usePlural: false }),
    secret: env.BETTER_AUTH_SECRET || "dev-only-replace-better-auth-secret-32-bytes",
    baseURL: env.APP_ORIGIN,
    basePath: "/api/auth",
    trustedOrigins: [env.APP_ORIGIN],
    plugins: [admin({
      ac,
      roles: { admin: adminRole, photographer: photographerRole, editor: editorRole, external_editor: externalEditorRole },
      defaultRole: "photographer",
      adminRoles: ["admin"],
      impersonationSessionDuration: 60 * 60,
    })],
    user: { additionalFields: { role: { type: "string", input: false }, active: { type: "boolean", input: false }, authorizationEpoch: { type: "number", input: false } } },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
        requireLocalEmailVerified: false,
      },
    },
    socialProviders: googleConfigured ? { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET!, disableImplicitSignUp: true, disableSignUp: true } } : {},
    databaseHooks: {
      user: { create: { before: async () => { throw new APIError("FORBIDDEN", { message: "This is a closed staff system. Ask an administrator to provision your account." }); } } },
      session: {
        create: { before: async (session, context) => {
        const user = await db.select({ active: schema.user.active }).from(schema.user).where(eq(schema.user.id, session.userId)).get();
        if (!user?.active) throw new APIError("FORBIDDEN", { message: "This staff account is inactive." });
        const impersonatedBy = typeof session.impersonatedBy === "string" ? session.impersonatedBy : null;
        if (!impersonatedBy) return;
        try {
          await assertImpersonationSessionAllowed(env, session.userId, impersonatedBy);
        } catch {
          throw new APIError("FORBIDDEN", { message: "User impersonation is disabled." });
        }
        const target = await db.select({ email: schema.user.email, role: schema.user.role, active: schema.user.active })
          .from(schema.user).where(eq(schema.user.id, session.userId)).get();
        if (!target?.active || (target.role !== "photographer" && target.role !== "editor" && target.role !== "external_editor")) throw new APIError("FORBIDDEN", { message: "User impersonation is disabled." });
        await audit(env, { id: impersonatedBy, impersonatedBy: null }, "user.impersonate_start", "user", session.userId, { targetEmail: target.email, targetRole: target.role });
        void context;
      } },
        delete: { before: async (session, context) => {
          const impersonatedBy = typeof session.impersonatedBy === "string" ? session.impersonatedBy : null;
          if (!impersonatedBy || context?.path !== "/admin/stop-impersonating") return;
          const target = await db.select({ email: schema.user.email, role: schema.user.role })
            .from(schema.user).where(eq(schema.user.id, session.userId)).get();
          if (!target) throw new APIError("FORBIDDEN", { message: "User impersonation is disabled." });
          await audit(env, { id: impersonatedBy, impersonatedBy: null }, "user.impersonate_stop", "user", session.userId, { targetEmail: target.email, targetRole: target.role });
        } },
      },
    },
  });
}

export async function getSession(c: Context<any>) {
  const auth = createAuth(c.env);
  // Better Auth's typed endpoint accepts the request headers and validates its session cookie.
  return (auth.api.getSession as (input: { headers: Headers }) => Promise<{ user: Record<string, unknown>; session: Record<string, unknown> } | null>)({ headers: c.req.raw.headers });
}
