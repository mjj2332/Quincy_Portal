import type { MiddlewareHandler } from "hono";
import { getSession } from "../auth";
import type { AppEnv, SessionUser } from "../env";
import { ROLES } from "@quincy/shared";

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const session = await getSession(c);
  const user = session?.user;
  const role = user?.role;
  if (!user || typeof user.id !== "string" || typeof user.email !== "string" || typeof user.name !== "string" || typeof role !== "string" || !ROLES.includes(role as never) || user.active !== true) return c.json({ error: "Authentication required" }, 401);
  c.set("user", { id: user.id, email: user.email, name: user.name, role, active: true } as SessionUser);
  await next();
};
