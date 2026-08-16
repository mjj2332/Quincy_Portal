import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCapability } from "../middleware/capability";

const query = z.object({ scope: z.literal("notice-board"), q: z.string().trim().max(200).optional() });
export const mentionableUsersRoutes = new Hono<AppEnv>();
mentionableUsersRoutes.use("/mentionable-users", requireCapability("viewNoticeBoard"));
mentionableUsersRoutes.use("/mentionable-users/*", requireCapability("viewNoticeBoard"));

mentionableUsersRoutes.get("/mentionable-users", async (c) => {
  const parsed = query.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Invalid query", details: parsed.error.flatten() }, 400);
  const q = parsed.data.q?.toLocaleLowerCase().replace(/[\\%_]/g, "\\$&");
  const users = await createDb(c.env.DB).select({ id: schema.user.id, name: schema.user.name, role: schema.user.role })
    .from(schema.user)
    .where(and(eq(schema.user.active, true), q ? sql`lower(${schema.user.name}) like ${`%${q}%`} escape '\\'` : undefined))
    .orderBy(asc(schema.user.name), asc(schema.user.id)).limit(20).all();
  return c.json({ users });
});
