import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

/**
 * /media responses are per-principal. Anything a handler has not explicitly marked cacheable
 * (errors, 401/403/404/409, unknown paths) must never be stored (#362).
 */
export const mediaNoStoreByDefault: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "private, no-store");
};
