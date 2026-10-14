import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import type { Principal } from "../lib/audit";

export async function jsonInput<T extends z.ZodTypeAny>(c: Context<AppEnv>, validator: T): Promise<z.infer<T> | Response> {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const result = validator.safeParse(body);
  return result.success ? result.data : c.json({ error: "Invalid input", details: result.error.flatten() }, 400);
}
/** Who is acting, for an audit row: the user, who is impersonating them (ADR 0019 also carries `via` for an MCP connection). */
export const principalOf = (c: Context<AppEnv>): Principal => { const user = c.get("user"); return { id: user.id, impersonatedBy: user.impersonatedBy, via: user.via }; };
export const idParam = z.string().uuid();
