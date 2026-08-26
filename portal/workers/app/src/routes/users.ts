import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { desc, eq } from "drizzle-orm";
import { ROLES } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCapability } from "../middleware/capability";
import { audit, auditMeta } from "../lib/audit";
import { newId } from "../lib/ids";
import { USER_IMPERSONATION_FLAG } from "../lib/impersonation";
import { jsonInput } from "./helpers";

const input = z.object({ email: z.string().email(), name: z.string().min(1).max(200), role: z.enum(ROLES) });
const patchInput = input.partial().omit({ email: true }).extend({ active: z.boolean().optional() });
const impersonationSettingsInput = z.object({ enabled: z.boolean() }).strict();
export const usersRoutes = new Hono<AppEnv>();
// Scope to /users paths only: use("*") leaks onto sibling routers mounted at the same base.
usersRoutes.use("/users", requireCapability("manageUsers"));
usersRoutes.use("/users/*", requireCapability("manageUsers"));
usersRoutes.get("/users", async (c) => c.json({ users: await createDb(c.env.DB).select({
  id: schema.user.id,
  name: schema.user.name,
  email: schema.user.email,
  role: schema.user.role,
  active: schema.user.active,
  createdAt: schema.user.createdAt,
}).from(schema.user).orderBy(desc(schema.user.createdAt)).all() }));
usersRoutes.get("/users/impersonation-settings", async (c) => {
  const row = await createDb(c.env.DB).select({ enabled: schema.featureFlags.enabled })
    .from(schema.featureFlags).where(eq(schema.featureFlags.key, USER_IMPERSONATION_FLAG)).get();
  return c.json({ enabled: row?.enabled === true });
});
usersRoutes.patch("/users/impersonation-settings", async (c) => {
  const data = await jsonInput(c, impersonationSettingsInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB);
  const existing = await db.select({ key: schema.featureFlags.key }).from(schema.featureFlags)
    .where(eq(schema.featureFlags.key, USER_IMPERSONATION_FLAG)).get();
  if (!existing) return c.json({ error: "Impersonation setting is unavailable" }, 500);
  const user = c.get("user"); const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE feature_flags SET enabled = ?, updated_by = ?, updated_at = ? WHERE key = ?")
      .bind(data.enabled ? 1 : 0, user.id, now, USER_IMPERSONATION_FLAG),
    c.env.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(newId(), user.id, "user.impersonation_toggle", "feature_flag", USER_IMPERSONATION_FLAG, auditMeta(user, { enabled: data.enabled }), now),
  ]);
  return c.json({ enabled: data.enabled });
});
usersRoutes.post("/users", async (c) => {
  const data = await jsonInput(c, input); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const id = newId();
  try { await db.insert(schema.user).values({ id, ...data, emailVerified: false, active: true, createdAt: new Date(), updatedAt: new Date() }); }
  catch { return c.json({ error: "A user with this email already exists" }, 409); }
  await audit(c.env, c.get("user"), "user.provision", "user", id, { email: data.email, role: data.role });
  return c.json({ id, ...data, active: true }, 201);
});
usersRoutes.patch("/users/:id", async (c) => {
  const id = c.req.param("id"); if (!z.string().uuid().safeParse(id).success) return c.json({ error: "Invalid user id" }, 400);
  const data = await jsonInput(c, patchInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const existing = await db.select().from(schema.user).where(eq(schema.user.id, id)).get();
  if (!existing) return c.json({ error: "User not found" }, 404);
  await db.update(schema.user).set({ ...data, updatedAt: new Date() }).where(eq(schema.user.id, id));
  if (data.active === false) await db.delete(schema.session).where(eq(schema.session.userId, id));
  const didRename = data.name !== undefined && data.name !== existing.name;
  const action = data.active === false ? "user.deactivate" : didRename ? "user.rename" : "user.update";
  const meta = didRename ? { ...data, previousName: existing.name } : data;
  await audit(c.env, c.get("user"), action, "user", id, meta);
  return c.json({ ok: true });
});
