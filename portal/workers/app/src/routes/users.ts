import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { desc, eq } from "drizzle-orm";
import { ROLES } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCapability } from "../middleware/capability";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { jsonInput } from "./helpers";

const input = z.object({ email: z.string().email(), name: z.string().min(1).max(200), role: z.enum(ROLES) });
const patchInput = input.partial().omit({ email: true }).extend({ active: z.boolean().optional() });
export const usersRoutes = new Hono<AppEnv>();
// Scope to /users paths only: use("*") leaks onto sibling routers mounted at the same base.
usersRoutes.use("/users", requireCapability("manageUsers"));
usersRoutes.use("/users/*", requireCapability("manageUsers"));
usersRoutes.get("/users", async (c) => c.json({ users: await createDb(c.env.DB).select().from(schema.user).orderBy(desc(schema.user.createdAt)).all() }));
usersRoutes.post("/users", async (c) => {
  const data = await jsonInput(c, input); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const id = newId();
  try { await db.insert(schema.user).values({ id, ...data, emailVerified: false, active: true, createdAt: new Date(), updatedAt: new Date() }); }
  catch { return c.json({ error: "A user with this email already exists" }, 409); }
  await audit(c.env, c.get("user").id, "user.provision", "user", id, { email: data.email, role: data.role });
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
  await audit(c.env, c.get("user").id, action, "user", id, meta);
  return c.json({ ok: true });
});
