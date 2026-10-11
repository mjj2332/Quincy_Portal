import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VIDEO_REVIEW_NOTIFICATION_EVENT } from "@quincy/shared";
import { videoRemovalSuppressionStatements } from "@quincy/db";
import type { Env } from "../src/env";
import { runEmailDigests } from "../src/email-digest";

/**
 * #776 C, Sol round 3 (ADR 0018): a digest item whose digest is already `sending` when its Video or Version is removed keeps its state, so the provider's accepted or ambiguous outcome records
 * normally (message id, `email_sent_at`). The removal only marks it (`outcome_code = 'video_removed'`); the one path that would return it to pending, the quota release, suppresses it instead.
 * These drive the real digest sender (`runEmailDigests`) with the very statements a removal runs, fired inside `EMAIL.send`.
 */
const database = env as unknown as { DB: D1Database };
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}
beforeAll(async () => { await executeSql(__PORTAL_MIGRATION_SQL__); }, 60_000);

const EIGHT_AM = Date.UTC(2026, 6, 1, 22);
const NINE_AM = Date.UTC(2026, 6, 1, 23);
const HOUR = 3_600_000;
const digestEnv = (send: ReturnType<typeof vi.fn>): Env => ({ DB: database.DB, APP_ORIGIN: "https://portal.test", EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test" }) as unknown as Env;

/** A recipient on the hourly cadence with one pending digest item whose email ledger row hangs off a video-review outbox row for a Version. The item's type is not a video-review type, so only the removal (not re-authorization) decides it. */
async function seed() {
  const now = Date.now(); const createdAt = EIGHT_AM - 5 * HOUR;
  const [userId, projectId, notificationId, itemId, outboxId, ledgerId, assetId] = Array.from({ length: 7 }, () => crypto.randomUUID());
  const sourceKey = crypto.randomUUID();
  const payload = { video: { kind: "video_version_uploaded", projectId, videoId: crypto.randomUUID(), assetId } };
  const db = database.DB;
  await db.batch([
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Digest person', ?, 1, 'editor', 1, ?, ?)").bind(userId, `${userId}@example.test`, now, now),
    db.prepare("INSERT INTO notification_preferences (user_id, email_digest_cadence, updated_at) VALUES (?, 'hourly', ?)").bind(userId, now),
    db.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Digest Removal Street', 'editing_autohdr', ?, ?)").bind(projectId, now, now),
    db.prepare("INSERT INTO notifications (id, user_id, project_id, type, title, body, source_key, read_at, created_at) VALUES (?, ?, ?, 'mentioned', 'Title', 'Body', ?, NULL, ?)").bind(notificationId, userId, projectId, sourceKey, createdAt),
    db.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)").bind(outboxId, VIDEO_REVIEW_NOTIFICATION_EVENT, sourceKey, projectId, userId, userId, JSON.stringify(payload), createdAt, createdAt, createdAt),
    db.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'email', 'deferred', ?, ?)").bind(ledgerId, outboxId, VIDEO_REVIEW_NOTIFICATION_EVENT, sourceKey, userId, createdAt, createdAt),
    db.prepare("INSERT INTO notification_digest_items (id, recipient_id, notification_id, ledger_id, project_id, notification_type, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'mentioned', 'pending', ?, ?)").bind(itemId, userId, notificationId, ledgerId, projectId, createdAt, createdAt),
  ]);
  return { userId: userId!, projectId: projectId!, assetId: assetId!, notificationId: notificationId!, itemId: itemId!, ledgerId: ledgerId! };
}
type Fixture = Awaited<ReturnType<typeof seed>>;

async function remove(f: Fixture): Promise<void> {
  const auditId = crypto.randomUUID();
  await database.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'video_version.remove', 'asset', ?, '{}', ?)").bind(auditId, f.assetId, Date.now()).run();
  await database.DB.batch(videoRemovalSuppressionStatements(database.DB, { projectId: f.projectId, path: "$.video.assetId", subjectId: f.assetId, auditId, now: Date.now() }));
}
const item = (f: Fixture) => database.DB.prepare("SELECT state, outcome_code AS outcome FROM notification_digest_items WHERE id = ?").bind(f.itemId).first<{ state: string; outcome: string | null }>();
const ledger = (f: Fixture) => database.DB.prepare("SELECT status, email_message_id AS messageId, last_error_code AS code FROM notification_delivery_ledger WHERE id = ?").bind(f.ledgerId).first<{ status: string; messageId: string | null; code: string | null }>();
const notification = (f: Fixture) => database.DB.prepare("SELECT email_sent_at AS sentAt, email_message_id AS messageId FROM notifications WHERE id = ?").bind(f.notificationId).first<{ sentAt: number | null; messageId: string | null }>();
const digestStatus = (f: Fixture) => database.DB.prepare("SELECT status, email_message_id AS messageId FROM notification_digests WHERE recipient_id = ?").bind(f.userId).first<{ status: string; messageId: string | null }>();

describe("#776 C: removal while a digest is sending", () => {
  it("control: a digest not yet sending is suppressed at removal and nothing is sent", async () => {
    const f = await seed(); const send = vi.fn().mockResolvedValue({ messageId: "never" });
    await remove(f);
    expect(await item(f)).toEqual({ state: "suppressed", outcome: "video_removed" });
    expect(await ledger(f)).toMatchObject({ status: "suppressed", code: "video_removed" });
    await runEmailDigests(digestEnv(send), EIGHT_AM);
    expect(send).not.toHaveBeenCalled();
  });

  it("removal during EMAIL.send, provider accepts: digest, item, ledger and notification record the sent outcome", async () => {
    const f = await seed();
    const send = vi.fn(async () => { await remove(f); return { messageId: "digest-accepted" }; });
    await runEmailDigests(digestEnv(send), EIGHT_AM);
    expect(await digestStatus(f)).toEqual({ status: "sent", messageId: "digest-accepted" });
    expect((await item(f))!.state).toBe("sent");
    expect(await ledger(f)).toEqual({ status: "sent", messageId: "digest-accepted", code: null });
    const n = (await notification(f))!;
    expect(n.messageId).toBe("digest-accepted"); expect(n.sentAt).not.toBeNull();
  });

  it("removal during EMAIL.send, quota rejection: the marked item is suppressed, not rearmed, and a later run never sends it", async () => {
    const f = await seed();
    const send = vi.fn(async () => { await remove(f); throw { code: "E_RATE_LIMIT_EXCEEDED" }; });
    await runEmailDigests(digestEnv(send), EIGHT_AM);
    expect(send).toHaveBeenCalledOnce();
    expect(await item(f)).toMatchObject({ state: "suppressed", outcome: "video_removed" });
    expect(await ledger(f)).toMatchObject({ status: "suppressed", code: "video_removed" });
    await runEmailDigests(digestEnv(send), NINE_AM);
    expect(send).toHaveBeenCalledOnce();
  });
});
