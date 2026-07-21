import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";

export async function jsonInput<T extends z.ZodTypeAny>(c: Context<AppEnv>, validator: T): Promise<z.infer<T> | Response> {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const result = validator.safeParse(body);
  return result.success ? result.data : c.json({ error: "Invalid input", details: result.error.flatten() }, 400);
}
export const idParam = z.string().uuid();
