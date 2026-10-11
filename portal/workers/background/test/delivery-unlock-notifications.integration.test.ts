import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELIVERY_CLIENT_OUTBOX_ACTOR, DELIVERY_UNLOCK_NOTIFICATION_EVENT, deliveryUnlockSourceKey, type NotificationOutboxMessage } from "@quincy/shared";
import { externalVisibleNotificationCte } from "@quincy/db";
import type { Env } from "../src/env";
import { processNotificationMessage } from "../src/notification-delivery";

/** The unlock-request resolver and delivery (#787 slice 8): Admins and Project Editors only, in app only, re-authorized at delivery, never an External's. */
const database = env as unknown as { DB: D1Database };
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); }
  }
}
const message = (outboxId: string) => ({ body: { type: "notification_outbox", outboxId } as NotificationOutboxMessage, attempts: 0, ack: vi.fn(), retry: vi.fn() }) as never;
const deliveryEnv = (send?: ReturnType<typeof vi.fn>): Env => ({ DB: database.DB, APP_ENV: "test", APP_ORIGIN: "https://portal.test", NOTIFICATION_QUEUE: { send: vi.fn().mockResolvedValue(undefined) }, EMAIL: send ? { send } : undefined, NOTIFICATIONS_FROM_ADDRESS: send ? "studio@example.test" : undefined }) as unknown as Env;

type Role = "admin" | "editor" | "external_editor" | "photographer";
type Options = {
  role?: Role; member?: boolean; recipientActive?: boolean; authorization?: "member" | "admin"; gateOpen?: boolean; archived?: boolean; pageOff?: boolean;
  unlocked?: boolean; notPremium?: boolean; notInLatestSet?: boolean; noAudit?: boolean; wrongRoleOnProject?: "photographer" | "editor";
};

async function seed(options: Options = {}) {
  const now = Date.now(); const id = () => crypto.randomUUID();
  const projectId = id(); const collectionId = id(); const assetId = id(); const recipientId = id(); const membershipId = id(); const outboxId = id(); const auditId = id(); const setId = id();
  const role = options.role ?? "editor"; const handle = id().replaceAll("-", "").slice(0, 16);
  const sourceKey = deliveryUnlockSourceKey(auditId);
  const payload = {
    schemaVersion: 1,
    event: { type: DELIVERY_UNLOCK_NOTIFICATION_EVENT, sourceKey, recipientId },
    authorizationAtOccurrence: options.authorization === "admin" || (role === "admin" && options.authorization !== "member") ? { kind: "admin" } : { kind: "project_member", membershipIds: [membershipId] },
    delivery: { projectId, setId, setNumber: 1, assetId, handle, label: "Photo 07" },
  };
  const statements: D1PreparedStatement[] = [
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Recipient Person', ?, 1, ?, ?, ?, ?)").bind(recipientId, `${recipientId}@example.test`, role, options.recipientActive === false ? 0 : 1, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, archived_at, created_at, updated_at) VALUES (?, '1 Delivery Street', 'delivered', ?, ?, ?)").bind(projectId, options.archived ? now : null, now, now),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'edited', 'empty', 0, ?, ?)").bind(collectionId, projectId, now, now),
    database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version, delivery_premium, publish_status, created_at, updated_at) VALUES (?, ?, 'photo', ?, 'SECRET-ORIGINAL.jpg', 10, 'upload', 1, ?, 'ready', ?, ?)").bind(assetId, collectionId, `projects/${projectId}/x/${assetId}`, options.notPremium ? 0 : 1, now, now),
    database.DB.prepare("INSERT INTO delivery_pages (project_id, slug, enabled, latest_set_number, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)").bind(projectId, `slug-${id().slice(0, 12)}`, options.pageOff ? 0 : 1, now, now),
    database.DB.prepare("INSERT INTO delivery_sets (id, project_id, set_number, operation_id, published_by, published_at) VALUES (?, ?, 1, ?, ?, ?)").bind(setId, projectId, id().slice(0, 32), recipientId, now),
  ];
  if (!options.notInLatestSet) statements.push(database.DB.prepare("INSERT INTO delivery_set_items (set_id, asset_id, handle, position) VALUES (?, ?, ?, 0)").bind(setId, assetId, handle));
  if (options.unlocked) statements.push(database.DB.prepare("INSERT INTO asset_premium_unlocks (asset_id, project_id, unlocked_by, unlocked_at) VALUES (?, ?, ?, ?)").bind(assetId, projectId, recipientId, now));
  if (options.member !== false && role !== "admin") statements.push(database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(membershipId, projectId, recipientId, options.wrongRoleOnProject ?? (role === "photographer" ? "photographer" : "editor"), now));
  if (!options.noAudit) statements.push(database.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'delivery.unlock_request', 'project', ?, '{}', ?)").bind(auditId, projectId, now));
  statements.push(
    database.DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, recipient_authorization_epoch, payload_json, status, available_at, created_at, updated_at) SELECT ?, 1, ?, ?, ?, ?, ?, authorization_epoch, ?, 'queued', ?, ?, ? FROM user WHERE id = ?")
      .bind(outboxId, DELIVERY_UNLOCK_NOTIFICATION_EVENT, sourceKey, projectId, DELIVERY_CLIENT_OUTBOX_ACTOR, recipientId, JSON.stringify(payload), now - 1, now, now, recipientId),
    database.DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'in_app', 'pending', ?, ?)").bind(id(), outboxId, DELIVERY_UNLOCK_NOTIFICATION_EVENT, sourceKey, recipientId, now, now),
  );
  const flags = options.gateOpen === false ? [] : ["client_delivery", `client_delivery_pilot:${projectId}`];
  for (const key of flags) statements.push(database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1").bind(key, now));
  await database.DB.batch(statements);
  // A person on 'immediate' would be emailed inline by any type that has an email ledger row; this type has none.
  await database.DB.prepare("INSERT INTO notification_preferences (user_id, email_digest_cadence, updated_at) VALUES (?, 'immediate', ?) ON CONFLICT(user_id) DO UPDATE SET email_digest_cadence = 'immediate'").bind(recipientId, now).run();
  return { outboxId, recipientId, projectId, membershipId, sourceKey, assetId, setId };
}
async function deliver(fixture: { outboxId: string }) {
  const send = vi.fn().mockResolvedValue({ messageId: "m-1" });
  await processNotificationMessage(deliveryEnv(send), message(fixture.outboxId));
  return send;
}
const stored = (recipientId: string) => database.DB.prepare("SELECT type, title, body, source_key AS sourceKey, project_id AS projectId FROM notifications WHERE user_id = ?").bind(recipientId).all<{ type: string; title: string; body: string | null; sourceKey: string; projectId: string }>().then((result) => result.results);
const outbox = async (outboxId: string) => (await database.DB.prepare("SELECT status, last_error AS reason FROM notification_outbox WHERE id = ?").bind(outboxId).first<{ status: string; reason: string | null }>())!;
const ledger = async (outboxId: string) => Object.fromEntries((await database.DB.prepare("SELECT channel, status FROM notification_delivery_ledger WHERE outbox_id = ?").bind(outboxId).all<{ channel: string; status: string }>()).results.map((row) => [row.channel, row.status]));

beforeAll(async () => { await executeSql(__PORTAL_MIGRATION_SQL__); });
beforeEach(async () => { await database.DB.prepare("DELETE FROM feature_flags").run(); });

describe("who is told", () => {
  it("an active Admin who is NOT a member of the Project gets it, in app, naming the item and the address, and no email goes out", async () => {
    const fixture = await seed({ role: "admin", member: false });
    const send = await deliver(fixture);
    expect(await stored(fixture.recipientId)).toEqual([{ type: "delivery_unlock_requested", title: "A client asked to unlock Photo 07", body: expect.stringContaining("1 Delivery Street"), sourceKey: fixture.sourceKey, projectId: fixture.projectId }]);
    expect(await ledger(fixture.outboxId)).toEqual({ in_app: "sent" });
    expect(await outbox(fixture.outboxId)).toMatchObject({ status: "completed" });
    expect(send).not.toHaveBeenCalled();
    expect(JSON.stringify(await stored(fixture.recipientId))).not.toContain("SECRET-ORIGINAL");
  });

  it("an Editor who is a member of the Project gets it", async () => {
    const fixture = await seed({ role: "editor" });
    await deliver(fixture);
    expect(await stored(fixture.recipientId)).toHaveLength(1);
  });

  it("a deactivated Admin is suppressed: no notification", async () => {
    const fixture = await seed({ role: "admin", member: false, recipientActive: false });
    await deliver(fixture);
    expect(await stored(fixture.recipientId)).toEqual([]);
    expect(await outbox(fixture.outboxId)).toMatchObject({ status: "suppressed", reason: "recipient_ineligible" });
  });

  it("an External editor who is assigned to the Project never gets it, even from a planted outbox row", async () => {
    const fixture = await seed({ role: "external_editor" });
    await deliver(fixture);
    expect(await stored(fixture.recipientId)).toEqual([]);
    expect(await outbox(fixture.outboxId)).toMatchObject({ status: "suppressed", reason: "recipient_ineligible" });
  });

  it("an External never sees the type in their list, even as a stored row", async () => {
    const fixture = await seed({ role: "external_editor" });
    await database.DB.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, body, source_key, created_at) VALUES (?, ?, ?, 'delivery_unlock_requested', 't', 'b', ?, ?)").bind(crypto.randomUUID(), fixture.recipientId, fixture.projectId, fixture.sourceKey, Date.now()).run();
    const cte = externalVisibleNotificationCte(fixture.recipientId);
    expect((await database.DB.prepare(`${cte.sql} SELECT id FROM external_visible_notifications`).bind(...cte.bindings).all()).results).toEqual([]);
  });

  it("a Photographer is suppressed", async () => {
    const fixture = await seed({ role: "photographer" });
    await deliver(fixture);
    expect(await stored(fixture.recipientId)).toEqual([]);
    expect(await outbox(fixture.outboxId)).toMatchObject({ status: "suppressed", reason: "recipient_ineligible" });
  });

  it("a member who left the Project between the request and delivery is suppressed", async () => {
    const fixture = await seed({ role: "editor" });
    await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(fixture.membershipId).run();
    await deliver(fixture);
    expect(await stored(fixture.recipientId)).toEqual([]);
    expect(await outbox(fixture.outboxId)).toMatchObject({ status: "suppressed", reason: "membership_removed" });
    expect(await ledger(fixture.outboxId)).toEqual({ in_app: "suppressed" });
  });

  it("a member re-added after leaving (a new membership) is not the snapshotted one: suppressed", async () => {
    const fixture = await seed({ role: "editor" });
    await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(fixture.membershipId).run();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), fixture.projectId, fixture.recipientId, Date.now()).run();
    await deliver(fixture);
    expect(await stored(fixture.recipientId)).toEqual([]);
    expect(await outbox(fixture.outboxId)).toMatchObject({ status: "suppressed", reason: "membership_cycle_changed" });
  });

  it("an Admin snapshot for someone who is no longer an Admin is suppressed", async () => {
    const fixture = await seed({ role: "editor", authorization: "admin", member: true });
    await deliver(fixture);
    expect(await stored(fixture.recipientId)).toEqual([]);
    expect(await outbox(fixture.outboxId)).toMatchObject({ status: "suppressed", reason: "admin_authorization_changed" });
  });

  it("a changed authorization epoch is suppressed", async () => {
    const fixture = await seed({ role: "admin", member: false });
    await database.DB.prepare("UPDATE user SET authorization_epoch = authorization_epoch + 1 WHERE id = ?").bind(fixture.recipientId).run();
    await deliver(fixture);
    expect(await stored(fixture.recipientId)).toEqual([]);
  });
});

describe("is it still news", () => {
  it.each([
    ["the Client Delivery gate shut", { gateOpen: false }, "delivery_closed"],
    ["the item unlocked meanwhile", { unlocked: true }, "item_unlocked"],
    ["the item no longer premium", { notPremium: true }, "item_unlocked"],
    ["the item gone from the latest set (a newer Publish dropped it)", { notInLatestSet: true }, "item_not_published"],
    ["the request's audit row missing", { noAudit: true }, "source_missing"],
  ] as Array<[string, Options, string]>)("suppresses %s", async (_name, options, reason) => {
    const fixture = await seed({ role: "admin", member: false, ...options });
    const send = await deliver(fixture);
    expect(await stored(fixture.recipientId)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(await outbox(fixture.outboxId)).toMatchObject({ status: "suppressed", reason });
  });

  it("suppresses once a newer set replaced the one the request was made on, even though the asset is still in the new latest set under another label", async () => {
    const fixture = await seed({ role: "admin", member: false });
    const set2 = crypto.randomUUID(); const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO delivery_sets (id, project_id, set_number, operation_id, published_by, published_at) VALUES (?, ?, 2, ?, ?, ?)").bind(set2, fixture.projectId, crypto.randomUUID().slice(0, 32), fixture.recipientId, now),
      database.DB.prepare("INSERT INTO delivery_set_items (set_id, asset_id, handle, position) VALUES (?, ?, ?, 1)").bind(set2, fixture.assetId, crypto.randomUUID().replaceAll("-", "").slice(0, 16)),
      database.DB.prepare("UPDATE delivery_pages SET latest_set_number = 2 WHERE project_id = ?").bind(fixture.projectId),
    ]);
    const send = await deliver(fixture);
    expect(await stored(fixture.recipientId)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(await outbox(fixture.outboxId)).toMatchObject({ status: "suppressed", reason: "set_replaced" });
  });

  it("delivers for an archived Project to an active Admin and to a member Editor: the page keeps serving, so the studio still hears", async () => {
    const admin = await seed({ role: "admin", member: false, archived: true }); const editor = await seed({ role: "editor", archived: true });
    await deliver(admin); await deliver(editor);
    expect(await stored(admin.recipientId)).toHaveLength(1); expect(await stored(editor.recipientId)).toHaveLength(1);
  });

  it("still delivers when the page was switched off after the request: the studio should still hear it", async () => {
    const fixture = await seed({ role: "admin", member: false, pageOff: true });
    await deliver(fixture);
    expect(await stored(fixture.recipientId)).toHaveLength(1);
  });

  it("re-checks at the channel write: a member removed after the first resolution but before the insert batch writes nothing", async () => {
    const fixture = await seed({ role: "editor" });
    const original = database.DB.batch.bind(database.DB);
    let fired = false; let calls = 0;
    // Batch 1 is the claim; batch 2 is the in-app write (insert + ledger convergence), the last step after the second resolution.
    const spy = vi.spyOn(database.DB, "batch").mockImplementation(async (statements: D1PreparedStatement[]) => {
      calls += 1;
      if (calls === 2) { fired = true; await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(fixture.membershipId).run(); }
      return original(statements);
    });
    try { await deliver(fixture); } finally { spy.mockRestore(); }
    expect(fired).toBe(true);
    expect(await stored(fixture.recipientId)).toEqual([]);
    expect(await outbox(fixture.outboxId)).toMatchObject({ status: "suppressed" });
  });
});
