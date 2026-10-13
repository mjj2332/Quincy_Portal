import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NOTIFICATION_RETENTION_MS, externalVisibleNotificationCte } from "@quincy/db";
import { pruneNotifications } from "../src/notifications";
import type { Env } from "../src/env";

/**
 * #856: every notification table is kept for 30 days. Rows are seeded as plain SQL and judged through `pruneNotifications(env, now)`.
 * The rule under test: a Notification goes by its own age; an outbox chain goes by the outbox age, unless a Notification linked
 * through its ledger is still young or the outbox holds a live lease; digest items are never left to SET NULL.
 */
const database = env as unknown as { DB: D1Database };
const target = database as unknown as Env;
declare const __PORTAL_MIGRATION_SQL__: string;
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const RETENTION = NOTIFICATION_RETENTION_MS;
const userId = "e1111111-1111-4111-8111-111111111111";
const projectId = "e2222222-2222-4222-8222-222222222222";

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); }
  }
}
const id = () => crypto.randomUUID();
const run = (sql: string, ...binds: unknown[]) => database.DB.prepare(sql).bind(...binds).run();
const count = async (table: string, where = "1=1", ...binds: unknown[]) => (await database.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).bind(...binds).first<{ n: number }>())!.n;
const exists = async (table: string, rowId: string) => (await count(table, "id = ?", rowId)) === 1;

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await run("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Retention User', 'retention@example.test', 1, 'editor', 1, ?, ?)", userId, NOW, NOW);
  await run("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Retention Street', 'editing_autohdr', ?, ?)", projectId, NOW, NOW);
});
beforeEach(async () => {
  for (const table of ["notification_digest_items", "notification_delivery_ledger", "notification_outbox", "notification_digests", "notifications", "project_activity_events", "audit_log"]) {
    await run(`DELETE FROM ${table}`);
  }
});

type Chain = { outboxId: string; inAppLedgerId: string; emailLedgerId: string | null; notificationId: string | null; itemId: string | null };
type ChainInput = {
  /** Age of the outbox row in ms; the Notification, ledger and item default to the same instant. */
  outboxAge: number; notificationAge?: number | null; outboxStatus?: string; ledgerStatus?: string; read?: boolean;
  lease?: number; email?: boolean; item?: boolean; itemAge?: number;
};
async function seedChain(input: ChainInput): Promise<Chain> {
  const outboxId = id(); const inAppLedgerId = id(); const sourceKey = `retention:${outboxId}`;
  const outboxAt = NOW - input.outboxAge; const status = input.outboxStatus ?? "completed";
  const notificationAge = input.notificationAge === undefined ? input.outboxAge : input.notificationAge;
  const processing = status === "processing";
  await run("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, lease_token, lease_expires_at, created_at, updated_at) VALUES (?, 1, 'legacy.test', ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)",
    outboxId, sourceKey, projectId, userId, userId, status, outboxAt, processing ? "lease-token" : null, processing ? NOW + (input.lease ?? DAY) : null, outboxAt, outboxAt);
  let notificationId: string | null = null;
  if (notificationAge !== null) {
    notificationId = id(); const at = NOW - notificationAge;
    await run("INSERT INTO notifications (id, user_id, project_id, type, title, body, read_at, source_key, created_at) VALUES (?, ?, ?, 'raw_ready', 'T', 'B', ?, ?, ?)", notificationId, userId, projectId, input.read ? at + 1 : null, sourceKey, at);
  }
  await run("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, notification_id, created_at, updated_at) VALUES (?, ?, 'legacy.test', ?, ?, 'in_app', ?, ?, ?, ?)", inAppLedgerId, outboxId, sourceKey, userId, input.ledgerStatus ?? "sent", notificationId, outboxAt, outboxAt);
  let emailLedgerId: string | null = null;
  if (input.email) {
    emailLedgerId = id();
    await run("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, notification_id, created_at, updated_at) VALUES (?, ?, 'legacy.test', ?, ?, 'email', ?, NULL, ?, ?)", emailLedgerId, outboxId, sourceKey, userId, input.ledgerStatus ?? "sent", outboxAt, outboxAt);
  }
  let itemId: string | null = null;
  if (input.item) {
    itemId = id();
    await run("INSERT INTO notification_digest_items (id, recipient_id, notification_id, ledger_id, project_id, notification_type, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'raw_ready', 'pending', ?, ?)", itemId, userId, notificationId, inAppLedgerId, projectId, NOW - (input.itemAge ?? notificationAge ?? input.outboxAge), NOW - (input.itemAge ?? notificationAge ?? input.outboxAge));
  }
  return { outboxId, inAppLedgerId, emailLedgerId, notificationId, itemId };
}
async function chainRows(chain: Chain) {
  return {
    outbox: await exists("notification_outbox", chain.outboxId),
    ledger: await exists("notification_delivery_ledger", chain.inAppLedgerId),
    emailLedger: chain.emailLedgerId ? await exists("notification_delivery_ledger", chain.emailLedgerId) : null,
    notification: chain.notificationId ? await exists("notifications", chain.notificationId) : null,
    item: chain.itemId ? await exists("notification_digest_items", chain.itemId) : null,
  };
}
const expected = (chain: Chain, present: boolean) => ({
  outbox: present, ledger: present,
  emailLedger: chain.emailLedgerId ? present : null,
  notification: chain.notificationId ? present : null,
  item: chain.itemId ? present : null,
});

describe("notification retention (#856)", () => {
  it("the harness enforces foreign keys: deleting an outbox that still has a ledger row is rejected", async () => {
    // Without this, every RESTRICT / SET NULL assertion below would pass vacuously on a harness that ignores FKs.
    const chain = await seedChain({ outboxAge: 40 * DAY });
    await expect(run("DELETE FROM notification_outbox WHERE id = ?", chain.outboxId)).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("keeps a chain exactly 30 days old and removes one a millisecond older, entirely", async () => {
    const edge = await seedChain({ outboxAge: RETENTION, email: true, item: true });
    const over = await seedChain({ outboxAge: RETENTION + 1, email: true, item: true });
    await pruneNotifications(target, NOW);
    expect(await chainRows(edge)).toEqual(expected(edge, true));
    expect(await chainRows(over)).toEqual(expected(over, false));
  });

  it("keeps a chain at 29 days 23 hours", async () => {
    const chain = await seedChain({ outboxAge: 30 * DAY - 3_600_000, email: true, item: true });
    await pruneNotifications(target, NOW);
    expect(await chainRows(chain)).toEqual(expected(chain, true));
  });

  it("removes old chains whatever their read state, outbox status and ledger status", async () => {
    for (const read of [true, false]) {
      for (const outboxStatus of ["pending", "queued", "completed", "suppressed", "failed", "dlq", "discarded"]) {
        await seedChain({ outboxAge: 31 * DAY, read, outboxStatus, email: true });
      }
    }
    for (const ledgerStatus of ["pending", "processing", "sent", "suppressed", "failed", "unknown", "discarded", "deferred"]) {
      await seedChain({ outboxAge: 31 * DAY, ledgerStatus, email: true });
    }
    await pruneNotifications(target, NOW);
    expect(await count("notification_outbox")).toBe(0);
    expect(await count("notification_delivery_ledger")).toBe(0);
    expect(await count("notifications")).toBe(0);
  });

  it("keeps an old outbox whose Notification is still young (delayed delivery), then removes it once that ages out", async () => {
    const delayed = await seedChain({ outboxAge: 31 * DAY, notificationAge: 2 * DAY, email: true, item: true });
    await pruneNotifications(target, NOW);
    expect(await chainRows(delayed)).toEqual(expected(delayed, true));
    await pruneNotifications(target, NOW + 29 * DAY);
    expect(await chainRows(delayed)).toEqual(expected(delayed, false));
  });

  it("leaves an outbox holding a live lease alone, and removes it once the lease has expired", async () => {
    const leased = await seedChain({ outboxAge: 31 * DAY, outboxStatus: "processing", ledgerStatus: "processing", lease: DAY });
    await pruneNotifications(target, NOW);
    expect(await chainRows(leased)).toEqual(expected(leased, true));
    await pruneNotifications(target, NOW + 2 * DAY);
    expect(await chainRows(leased)).toEqual(expected(leased, false));
  });

  it("removes a legacy direct Notification (no ledger) with its item by its own age, and keeps a younger one", async () => {
    const rows: Record<string, { notification: string; item: string }> = {};
    for (const [label, age] of [["old", 31 * DAY], ["young", 29 * DAY]] as const) {
      const notification = id(); const item = id(); const at = NOW - age;
      await run("INSERT INTO notifications (id, user_id, project_id, type, title, created_at) VALUES (?, ?, ?, 'raw_ready', 'Legacy', ?)", notification, userId, projectId, at);
      await run("INSERT INTO notification_digest_items (id, recipient_id, notification_id, ledger_id, project_id, notification_type, state, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, 'raw_ready', 'pending', ?, ?)", item, userId, notification, projectId, at, at);
      rows[label] = { notification, item };
    }
    await pruneNotifications(target, NOW);
    expect([await exists("notifications", rows.old.notification), await exists("notification_digest_items", rows.old.item)]).toEqual([false, false]);
    expect([await exists("notifications", rows.young.notification), await exists("notification_digest_items", rows.young.item)]).toEqual([true, true]);
  });

  it("removes an old Notification reused by a young ledger, and leaves the young ledger and outbox with a NULL link", async () => {
    const old = id(); const outboxId = id(); const ledgerId = id(); const itemId = id();
    await run("INSERT INTO notifications (id, user_id, project_id, type, title, created_at) VALUES (?, ?, ?, 'raw_ready', 'Old', ?)", old, userId, projectId, NOW - 40 * DAY);
    await run("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, created_at, updated_at) VALUES (?, 1, 'legacy.test', 'reuse', ?, ?, ?, '{}', 'completed', ?, ?, ?)", outboxId, projectId, userId, userId, NOW - DAY, NOW - DAY, NOW - DAY);
    await run("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, notification_id, created_at, updated_at) VALUES (?, ?, 'legacy.test', 'reuse', ?, 'in_app', 'sent', ?, ?, ?)", ledgerId, outboxId, userId, old, NOW - DAY, NOW - DAY);
    await run("INSERT INTO notification_digest_items (id, recipient_id, notification_id, ledger_id, project_id, notification_type, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'raw_ready', 'pending', ?, ?)", itemId, userId, old, ledgerId, projectId, NOW - DAY, NOW - DAY);
    await pruneNotifications(target, NOW);
    expect(await exists("notifications", old)).toBe(false);
    expect(await exists("notification_outbox", outboxId)).toBe(true);
    const ledger = await database.DB.prepare("SELECT notification_id FROM notification_delivery_ledger WHERE id = ?").bind(ledgerId).first<{ notification_id: string | null }>();
    expect(ledger).toEqual({ notification_id: null });
    expect(await exists("notification_digest_items", itemId)).toBe(false); // deleted with its Notification, never left to SET NULL
  });

  it("removes old digests with their attached items and orphan items by age, leaving no claimable item behind", async () => {
    const oldDigest = id(); const youngDigest = id();
    for (const [digestId, age] of [[oldDigest, 31 * DAY], [youngDigest, DAY]] as const) {
      await run("INSERT INTO notification_digests (id, recipient_id, slot_at, cadence, status, item_count, project_count, created_at, updated_at) VALUES (?, ?, ?, 'hourly', 'sent', 1, 1, ?, ?)", digestId, userId, NOW - age, NOW - age, NOW - age);
    }
    const oldItem = id(); const youngItem = id(); const staleItem = id();
    await run("INSERT INTO notification_digest_items (id, recipient_id, project_id, notification_type, state, digest_id, created_at, updated_at) VALUES (?, ?, ?, 'raw_ready', 'sent', ?, ?, ?)", oldItem, userId, projectId, oldDigest, NOW - 31 * DAY, NOW - 31 * DAY);
    await run("INSERT INTO notification_digest_items (id, recipient_id, project_id, notification_type, state, digest_id, created_at, updated_at) VALUES (?, ?, ?, 'raw_ready', 'sent', ?, ?, ?)", youngItem, userId, projectId, youngDigest, NOW - DAY, NOW - DAY);
    await run("INSERT INTO notification_digest_items (id, recipient_id, project_id, notification_type, state, created_at, updated_at) VALUES (?, ?, ?, 'raw_ready', 'unknown', ?, ?)", staleItem, userId, projectId, NOW - 45 * DAY, NOW - 45 * DAY);
    await pruneNotifications(target, NOW);
    expect(await exists("notification_digests", oldDigest)).toBe(false);
    expect(await exists("notification_digests", youngDigest)).toBe(true);
    expect(await exists("notification_digest_items", oldItem)).toBe(false);
    expect(await exists("notification_digest_items", staleItem)).toBe(false);
    expect(await exists("notification_digest_items", youngItem)).toBe(true);
    // The young item still points at its young digest: nothing was orphaned into a claimable state.
    expect(await count("notification_digest_items", "id = ? AND digest_id = ?", youngItem, youngDigest)).toBe(1);
  });

  it("drains a backlog larger than one run across runs, never leaving a half chain", async () => {
    const total = 100 * 30 + 5;
    for (let i = 0; i < total; i += 1) await seedChain({ outboxAge: 31 * DAY + i, item: i % 7 === 0 });
    await pruneNotifications(target, NOW);
    const surviving = await count("notification_outbox");
    expect(surviving).toBeGreaterThan(0);
    expect(surviving).toBeLessThan(total);
    // Whole chains only: the tables lose rows in lockstep and nothing outlives its parent.
    expect(await count("notification_delivery_ledger")).toBe(surviving);
    expect(await count("notifications")).toBe(surviving);
    expect(await count("notification_digest_items")).toBe(await count("notification_digest_items", "ledger_id IN (SELECT id FROM notification_delivery_ledger)"));
    await pruneNotifications(target, NOW);
    expect(await count("notification_outbox")).toBe(0);
    expect(await count("notification_delivery_ledger")).toBe(0);
    expect(await count("notifications")).toBe(0);
    expect(await count("notification_digest_items")).toBe(0);
  }, 120_000);

  it("is idempotent, and two concurrent runs both resolve", async () => {
    await seedChain({ outboxAge: 31 * DAY, item: true });
    const young = await seedChain({ outboxAge: DAY, item: true });
    await Promise.all([pruneNotifications(target, NOW), pruneNotifications(target, NOW)]);
    const tally = async () => [await count("notification_outbox"), await count("notification_delivery_ledger"), await count("notifications"), await count("notification_digest_items")];
    expect(await tally()).toEqual([1, 1, 1, 1]);
    await pruneNotifications(target, NOW);
    expect(await tally()).toEqual([1, 1, 1, 1]);
    expect(await chainRows(young)).toEqual(expected(young, true));
  });

  it("keeps an old pending item whose chain is kept, and removes a true orphan at 31 days", async () => {
    const delayed = await seedChain({ outboxAge: 31 * DAY, notificationAge: 2 * DAY, item: true, itemAge: 31 * DAY });
    const leased = await seedChain({ outboxAge: 31 * DAY, outboxStatus: "processing", ledgerStatus: "processing", item: true });
    const orphan = id();
    await run("INSERT INTO notification_digest_items (id, recipient_id, project_id, notification_type, state, created_at, updated_at) VALUES (?, ?, ?, 'raw_ready', 'pending', ?, ?)", orphan, userId, projectId, NOW - 31 * DAY, NOW - 31 * DAY);
    await pruneNotifications(target, NOW);
    expect(await exists("notification_digest_items", delayed.itemId!)).toBe(true);
    expect(await exists("notification_digest_items", leased.itemId!)).toBe(true);
    expect(await exists("notification_digest_items", orphan)).toBe(false);
  });

  it("prunes an old legacy Notification and an old digest in the same run as a chain backlog bigger than one run", async () => {
    for (let i = 0; i < 100 * 30 + 5; i += 1) await seedChain({ outboxAge: 31 * DAY + i });
    const legacy = id(); const digest = id();
    await run("INSERT INTO notifications (id, user_id, project_id, type, title, created_at) VALUES (?, ?, ?, 'raw_ready', 'Legacy', ?)", legacy, userId, projectId, NOW - 31 * DAY);
    await run("INSERT INTO notification_digests (id, recipient_id, slot_at, cadence, status, item_count, project_count, created_at, updated_at) VALUES (?, ?, ?, 'hourly', 'sent', 0, 0, ?, ?)", digest, userId, NOW - 31 * DAY, NOW - 31 * DAY, NOW - 31 * DAY);
    await pruneNotifications(target, NOW);
    expect(await count("notification_outbox")).toBeGreaterThan(0);
    expect(await exists("notifications", legacy)).toBe(false);
    expect(await exists("notification_digests", digest)).toBe(false);
  }, 120_000);

  it("keeps a row created one millisecond after the cutoff and removes one created at cutoff minus one, for every leaf table", async () => {
    const cutoff = NOW - RETENTION;
    const rows = { notification: [id(), id()], item: [id(), id()], digest: [id(), id()] };
    for (const [index, at] of [cutoff + 1, cutoff - 1].entries()) {
      await run("INSERT INTO notifications (id, user_id, project_id, type, title, created_at) VALUES (?, ?, ?, 'raw_ready', 'Edge', ?)", rows.notification[index], userId, projectId, at);
      await run("INSERT INTO notification_digest_items (id, recipient_id, project_id, notification_type, state, created_at, updated_at) VALUES (?, ?, ?, 'raw_ready', 'unknown', ?, ?)", rows.item[index], userId, projectId, at, at);
      await run("INSERT INTO notification_digests (id, recipient_id, slot_at, cadence, status, item_count, project_count, created_at, updated_at) VALUES (?, ?, ?, 'hourly', 'sent', 0, 0, ?, ?)", rows.digest[index], userId, at, at, at);
    }
    await pruneNotifications(target, NOW);
    const present = async (index: number) => [await exists("notifications", rows.notification[index]), await exists("notification_digest_items", rows.item[index]), await exists("notification_digests", rows.digest[index])];
    expect(await present(0)).toEqual([true, true, true]);
    expect(await present(1)).toEqual([false, false, false]);
  });

  it("keeps an External Editor's Notification visible through the real reader when its outbox is 31 days old and the Notification 2 days old", async () => {
    const externalId = id(); const membershipId = id(); const notificationId = id(); const outboxId = id(); const ledgerId = id();
    const sourceKey = membershipId; // the assignment event's source key is the membership cycle
    const outboxAt = NOW - 31 * DAY; const notificationAt = NOW - 2 * DAY;
    await run("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'External', 'external-retention@example.test', 1, 'external_editor', 1, ?, ?)", externalId, NOW, NOW);
    await run("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)", membershipId, projectId, externalId, NOW - 40 * DAY);
    const payload = JSON.stringify({
      schemaVersion: 1,
      event: { type: "project.assignment.created", sourceKey, recipientId: externalId },
      assignment: { projectId, userId: externalId, roleOnProject: "editor", membershipCycle: membershipId },
    });
    await run("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, recipient_authorization_epoch, created_at, updated_at) VALUES (?, 1, 'project.assignment.created', ?, ?, ?, ?, ?, 'completed', ?, 0, ?, ?)", outboxId, sourceKey, projectId, userId, externalId, payload, outboxAt, outboxAt, outboxAt);
    await run("INSERT INTO notifications (id, user_id, project_id, type, title, body, source_key, created_at) VALUES (?, ?, ?, 'assigned_to_project', 'T', 'B', ?, ?)", notificationId, externalId, projectId, sourceKey, notificationAt);
    await run("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, notification_id, created_at, updated_at) VALUES (?, ?, 'project.assignment.created', ?, ?, 'in_app', 'sent', ?, ?, ?)", ledgerId, outboxId, sourceKey, externalId, notificationId, outboxAt, notificationAt);
    const visible = async () => {
      const cte = externalVisibleNotificationCte(externalId);
      return (await database.DB.prepare(`${cte.sql} SELECT id FROM external_visible_notifications`).bind(...cte.bindings).all<{ id: string }>()).results.map((row) => row.id);
    };
    expect(await visible()).toEqual([notificationId]); // the seed is real: visible before the prune
    await pruneNotifications(target, NOW);
    expect(await visible()).toEqual([notificationId]);
    await pruneNotifications(target, NOW + 29 * DAY);
    expect(await visible()).toEqual([]);
  });

  it("leaves project activity and the audit log untouched", async () => {
    const old = NOW - 400 * DAY;
    await run("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, created_at) VALUES (?, ?, 'x', 'project', ?, ?)", id(), userId, projectId, old);
    await run("INSERT INTO project_activity_events (id, schema_version, event_type, category, project_id, actor_kind, actor_id, occurred_at, source_kind, source_id, source_key, safe_payload_json, deep_link_kind, deep_link_path, created_at) VALUES (?, 1, 'x', 'x', ?, 'user', ?, ?, 'x', 'x', 'x', '{}', 'project', '/p', ?)", id(), projectId, userId, old, old);
    await seedChain({ outboxAge: 31 * DAY });
    await pruneNotifications(target, NOW);
    expect([await count("audit_log"), await count("project_activity_events")]).toEqual([1, 1]);
  });
});
