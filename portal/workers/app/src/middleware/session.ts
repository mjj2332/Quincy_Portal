import type { MiddlewareHandler } from "hono";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import { getSession } from "../auth";
import type { AppEnv, SessionUser } from "../env";
import { ROLES } from "@quincy/shared";
import { assertImpersonationSessionAllowed, impersonationDisabledResponse } from "../lib/impersonation";

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await getSession(c);
  const user = session?.user;
  const role = user?.role;
  const sessionValue = session?.session;
  const impersonatedBy = sessionValue && typeof sessionValue.impersonatedBy === "string" ? sessionValue.impersonatedBy : null;
  if (impersonatedBy && user?.active !== true) return impersonationDisabledResponse(c);
  if (!user || typeof user.id !== "string" || typeof user.email !== "string" || typeof user.name !== "string" || typeof role !== "string" || !ROLES.includes(role as never) || user.active !== true) return c.json({ error: "Authentication required" }, 401);
  // better-auth validates the cookie, but authorization is reloaded from the same primary row
  // that role transitions fence. This makes role/active/epoch revocation effective immediately
  // and keeps every downstream scope/upload/media check on one current principal contract.
  const current = await createDb(c.env.DB).select({ id: schema.user.id, email: schema.user.email, name: schema.user.name, role: schema.user.role, active: schema.user.active, authorizationEpoch: schema.user.authorizationEpoch })
    .from(schema.user).where(eq(schema.user.id, user.id)).get();
  if (!current?.active || !ROLES.includes(current.role as never)) return c.json({ error: "Authentication required" }, 401);
  if (impersonatedBy) {
    try { await assertImpersonationSessionAllowed(c.env, user.id, impersonatedBy); }
    catch { return impersonationDisabledResponse(c); }
  }
  c.set("user", { id: current.id, email: current.email, name: current.name, role: current.role, active: true, authorizationEpoch: current.authorizationEpoch, impersonatedBy } as SessionUser);
  await next();
};
