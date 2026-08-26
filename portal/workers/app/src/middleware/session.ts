import type { MiddlewareHandler } from "hono";
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
  if (impersonatedBy) {
    try { await assertImpersonationSessionAllowed(c.env, user.id, impersonatedBy); }
    catch { return impersonationDisabledResponse(c); }
  }
  c.set("user", { id: user.id, email: user.email, name: user.name, role, active: true, impersonatedBy } as SessionUser);
  await next();
};
