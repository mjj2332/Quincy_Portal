import { Hono } from "hono";
import { terminalRoute } from "../lib/terminal-route";
import { createDb, schema } from "@quincy/db";
import { desc, eq } from "drizzle-orm";
import { PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID, ROLES } from "@quincy/shared";
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
const EXTERNAL_PROVISIONING_FROZEN_FLAG = "external_editor_provisioning_frozen";
export const usersRoutes = new Hono<AppEnv>();
// Scope to /users paths only: use("*") leaks onto sibling routers mounted at the same base.
usersRoutes.use("/users", requireCapability("manageUsers"));
usersRoutes.use("/users/*", requireCapability("manageUsers"));
usersRoutes.get("/users", terminalRoute("/users", async (c) => c.json({ users: await createDb(c.env.DB).select({
  id: schema.user.id,
  name: schema.user.name,
  email: schema.user.email,
  role: schema.user.role,
  active: schema.user.active,
  createdAt: schema.user.createdAt,
}).from(schema.user).orderBy(desc(schema.user.createdAt)).all() })));
usersRoutes.get("/users/impersonation-settings", terminalRoute("/users/impersonation-settings", async (c) => {
  const row = await createDb(c.env.DB).select({ enabled: schema.featureFlags.enabled })
    .from(schema.featureFlags).where(eq(schema.featureFlags.key, USER_IMPERSONATION_FLAG)).get();
  return c.json({ enabled: row?.enabled === true });
}));
usersRoutes.patch("/users/impersonation-settings", terminalRoute("/users/impersonation-settings", async (c) => {
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
}));
usersRoutes.post("/users", terminalRoute("/users", async (c) => {
  const data = await jsonInput(c, input); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const id = newId();
  if (id === PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID) return c.json({ error: "Reserved user identifier" }, 409);
  if (data.role === "external_editor") {
    const frozen = await db.select({ enabled: schema.featureFlags.enabled }).from(schema.featureFlags)
      .where(eq(schema.featureFlags.key, EXTERNAL_PROVISIONING_FROZEN_FLAG)).get();
    if (frozen?.enabled) return c.json({ error: "External Editor provisioning is temporarily frozen", code: "external_provisioning_frozen" }, 503);
  }
  try { await db.insert(schema.user).values({ id, ...data, emailVerified: false, active: true, createdAt: new Date(), updatedAt: new Date() }); }
  catch { return c.json({ error: "A user with this email already exists" }, 409); }
  await audit(c.env, c.get("user"), "user.provision", "user", id, { email: data.email, role: data.role });
  return c.json({ id, ...data, active: true }, 201);
}));
usersRoutes.patch("/users/:id", terminalRoute("/users/:id", async (c) => {
  const id = c.req.param("id"); if (!z.string().uuid().safeParse(id).success) return c.json({ error: "Invalid user id" }, 400);
  const data = await jsonInput(c, patchInput); if (data instanceof Response) return data;
  const db = createDb(c.env.DB); const existing = await db.select().from(schema.user).where(eq(schema.user.id, id)).get();
  if (!existing) return c.json({ error: "User not found" }, 404);
  const didRename = data.name !== undefined && data.name !== existing.name;
  const roleChanged = data.role !== undefined && data.role !== existing.role;
  const activeChanged = data.active !== undefined && data.active !== existing.active;
  if (roleChanged && activeChanged) return c.json({ error: "Role and active state must be changed in separate requests", code: "one_lifecycle_transition_at_a_time" }, 400);

  if (roleChanged || activeChanged) {
    if (roleChanged && data.role === "external_editor") {
      const frozen = await db.select({ enabled: schema.featureFlags.enabled }).from(schema.featureFlags)
        .where(eq(schema.featureFlags.key, EXTERNAL_PROVISIONING_FROZEN_FLAG)).get();
      if (frozen?.enabled) return c.json({ error: "External Editor provisioning is temporarily frozen", code: "external_provisioning_frozen" }, 503);
    }
    const blockerRole = data.role === "external_editor" ? "photographer" : data.role === "photographer" ? "editor" : null;
    if (blockerRole) {
      const blockers = await c.env.DB.prepare(`
        SELECT pm.id AS membershipCycle, pm.project_id AS projectId, pm.role_on_project AS roleOnProject
        FROM project_members pm
        WHERE pm.user_id = ? AND pm.role_on_project = ?
        ORDER BY pm.project_id, pm.id
      `).bind(id, blockerRole).all<{ membershipCycle: string; projectId: string; roleOnProject: string }>();
      if (blockers.results.length) return c.json({ error: "Role transition is blocked by incompatible project memberships", code: "incompatible_project_memberships", blockers: blockers.results }, 409);
    }

    const now = Date.now();
    const nextRole = data.role ?? existing.role;
    const nextActive = data.active ?? existing.active;
    const pendingCounts = await c.env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM session WHERE user_id = ?) AS sessionCount,
        (SELECT COUNT(*) FROM notification_delivery_ledger WHERE recipient_id = ? AND status = 'pending') AS pendingDeliveryCount,
        (SELECT COUNT(*) FROM notification_outbox o WHERE o.recipient_id = ? AND o.status IN ('pending', 'queued')) AS pendingOutboxCount
    `).bind(id, id, id).first<{ sessionCount: number; pendingDeliveryCount: number; pendingOutboxCount: number }>();
    const winnerAuditId = newId();
    const roleOrActiveUpdate = roleChanged
      ? c.env.DB.prepare(`
        UPDATE user SET role = ?, name = COALESCE(?, name), authorization_epoch = authorization_epoch + 1, updated_at = ?
        WHERE id = ? AND role = ? AND active = ? AND authorization_epoch = ? AND updated_at = ?
        RETURNING id, authorization_epoch
      `).bind(nextRole, data.name ?? null, now, id, existing.role, existing.active ? 1 : 0, existing.authorizationEpoch, existing.updatedAt.getTime())
      : c.env.DB.prepare(`
        UPDATE user SET active = ?, name = COALESCE(?, name), authorization_epoch = authorization_epoch + 1, updated_at = ?
        WHERE id = ? AND role = ? AND active = ? AND authorization_epoch = ? AND updated_at = ?
        RETURNING id, authorization_epoch
      `).bind(nextActive ? 1 : 0, data.name ?? null, now, id, existing.role, existing.active ? 1 : 0, existing.authorizationEpoch, existing.updatedAt.getTime());
    const action = roleChanged ? "user.role_change" : nextActive ? "user.reactivate" : "user.deactivate";
    const auditMetaJson = auditMeta(c.get("user"), {
      previousRole: existing.role,
      nextRole,
      previousActive: existing.active,
      nextActive,
      previousAuthorizationEpoch: existing.authorizationEpoch,
      sessionCount: Number(pendingCounts?.sessionCount ?? 0),
      pendingDeliveryCount: Number(pendingCounts?.pendingDeliveryCount ?? 0),
      pendingOutboxCount: Number(pendingCounts?.pendingOutboxCount ?? 0),
      ...(didRename ? { previousName: existing.name, nextName: data.name } : {}),
    });
    const auditStatement = c.env.DB.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, ?, ?, 'user', ?, ?, ? WHERE changes() = 1
    `).bind(winnerAuditId, c.get("user").id, action, id, auditMetaJson, now);
    const revokeSessions = c.env.DB.prepare(`DELETE FROM session WHERE user_id = ? AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)`)
      .bind(id, winnerAuditId);
    const suppressLedger = c.env.DB.prepare(`
      UPDATE notification_delivery_ledger
      SET status = 'suppressed', last_error_code = ?, last_error = ?, updated_at = ?
      WHERE recipient_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    `).bind(roleChanged ? "role_changed" : "recipient_inactive", roleChanged ? "Recipient role changed." : "Recipient became inactive.", now, id, winnerAuditId);
    const suppressOutbox = c.env.DB.prepare(`
      UPDATE notification_outbox
      SET status = 'suppressed', last_error_code = ?, last_error = ?, completed_at = ?, updated_at = ?
      WHERE recipient_id = ? AND status IN ('pending', 'queued')
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM notification_delivery_ledger WHERE outbox_id = notification_outbox.id AND status IN ('pending', 'processing'))
    `).bind(roleChanged ? "role_changed" : "recipient_inactive", roleChanged ? "Recipient role changed." : "Recipient became inactive.", now, now, id, winnerAuditId);
    const statements: D1PreparedStatement[] = [roleOrActiveUpdate, auditStatement, revokeSessions, suppressLedger, suppressOutbox];
    if (roleChanged && nextRole === "external_editor") {
      statements.push(c.env.DB.prepare(`
        INSERT INTO jobs (id, kind, status, correlation_id, payload_json, created_at, updated_at)
        SELECT ?, 'external_role_conversion_cache_purge', 'queued', ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
          AND NOT EXISTS (SELECT 1 FROM jobs WHERE correlation_id = ?)
      `).bind(newId(), `external-role-purge:${winnerAuditId}`, JSON.stringify({ userId: id, roleChangeAuditId: winnerAuditId, authorizationEpoch: existing.authorizationEpoch + 1 }), now, now, winnerAuditId, `external-role-purge:${winnerAuditId}`));
    }
    const result = await c.env.DB.batch(statements);
    if ((result[1]?.meta.changes ?? 0) !== 1) return c.json({ error: "User changed concurrently; retry" }, 409);
    return c.json({ ok: true, authorizationEpoch: existing.authorizationEpoch + 1, sessionsRevoked: result[2]?.meta.changes ?? 0 });
  }

  if (didRename || data.role !== undefined || data.active !== undefined) {
    await db.update(schema.user).set({ ...(didRename ? { name: data.name } : {}), updatedAt: new Date() }).where(eq(schema.user.id, id));
    const action = didRename ? "user.rename" : "user.update";
    const meta = didRename ? { previousName: existing.name, nextName: data.name } : {};
    await audit(c.env, c.get("user"), action, "user", id, meta);
  }
  return c.json({ ok: true });
}));
