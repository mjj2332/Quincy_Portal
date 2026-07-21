import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Custom API mutations use cookie sessions, so require the browser-supplied Origin
 * to exactly match APP_ORIGIN. better-auth owns its own OAuth/session endpoint rules.
 */
export const requireAppOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!unsafeMethods.has(c.req.method) || c.req.path.startsWith("/api/auth/")) return next();
  if (c.req.header("Origin") !== c.env.APP_ORIGIN) return c.json({ error: "Forbidden: invalid request origin" }, 403);
  return next();
};
