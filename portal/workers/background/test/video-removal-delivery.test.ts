import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VIDEO_REVIEW_NOTIFICATION_EVENT, videoReviewNotificationSourceKey } from "@quincy/shared";
import { videoRemovalSuppressionStatements } from "@quincy/db";
import type { NotificationOutboxMessage } from "@quincy/shared";
import type { Env } from "../src/env";
import { processNotificationMessage } from "../src/notification-delivery";

/**
 * #776 C, Sol round 2: a delivery that is `processing` when a Version is removed must not escape the suppression, because an Undo makes the live re-check pass again. These drive the real
 * worker (`processNotificationMessage`) with the very statements a removal runs (`videoRemovalSuppressionStatements`), fired at the worker's own interleaving points. The Undo needs no statement of
 * its own here: it touches nothing in the notification tables, so with the Video left live the suppression is the ONLY thing that can stop a delivery.
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

type Fixture = Awaited<ReturnType<typeof seed>>;
async function seed(options: { inApp?: "pending" | "sent" } = {}) {
  const now = Date.now(); const [actorId, recipientId, projectId, collectionId, videoId, assetId, outboxId] = Array.from({ length: 7 }, () => crypto.randomUUID());
  const sourceKey = videoReviewNotificationSourceKey("video_version_uploaded", assetId!);
  const payload = { schemaVersion: 1, event: { type: VIDEO_REVIEW_NOTIFICATION_EVENT, sourceKey, recipientId }, authorizationAtOccurrence: { kind: "admin" }, video: { kind: "video_version_uploaded", projectId, videoId, assetId, sourceId: assetId } };
  const db = database.DB;
  await db.batch([
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Actor', ?, 1, 'editor', 1, ?, ?)").bind(actorId, `${actorId}@example.test`, now, now),
    db.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Recipient', ?, 1, 'admin', 1, ?, ?)").bind(recipientId, `${recipientId}@example.test`, now, now),
    db.prepare("INSERT INTO notification_preferences (user_id, email_digest_cadence, updated_at) VALUES (?, 'immediate', ?)").bind(recipientId, now),
    db.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Removal Street', 'editing_autohdr', ?, ?)").bind(projectId, now, now),
    db.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'video', 'empty', 0, ?, ?)").bind(collectionId, projectId, now, now),
    db.prepare("INSERT INTO videos (id, project_id, collection_id, title, premium, position, created_by, created_at, updated_at) VALUES (?, ?, ?, 'Walkthrough', 0, 0, ?, ?, ?)").bind(videoId, projectId, collectionId, actorId, now, now),
    db.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version_group_id, version, publish_status, created_at, updated_at) VALUES (?, ?, 'video', ?, 'cut.mp4', 4096, 'upload', ?, 1, 'ready', ?, ?)").bind(assetId, collectionId, `k/${assetId}`, videoId, now, now),
    db.prepare("INSERT INTO video_version_meta (asset_id, video_id, fps_num, fps_den, media_timescale, frame_delta, frame_count, duration_ms, width, height, codec, codec_string, start_tc_frames, tc_nominal_fps, tc_drop_frame, fast_start, has_audio, probe_version, poster_key, uploaded_by, created_at) VALUES (?, ?, 25, 1, 25000, 1000, 250, 10000, 1920, 1080, 'avc1', 'avc1.640028', NULL, 25, 0, 1, 1, 1, NULL, ?, ?)").bind(assetId, videoId, actorId, now),
    db.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES ('video_review', 1, ?), ('video_review_all_projects', 1, ?), ('video_review_notify_staff', 1, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1").bind(now, now, now),
    db.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, delivery_attempts, created_at, updated_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)").bind(outboxId, VIDEO_REVIEW_NOTIFICATION_EVENT, sourceKey, projectId, actorId, recipientId, JSON.stringify(payload), now - 1, now, now),
    db.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'in_app', ?, 0, ?, ?), (?, ?, ?, ?, ?, 'email', 'pending', 0, ?, ?)")
      .bind(crypto.randomUUID(), outboxId, VIDEO_REVIEW_NOTIFICATION_EVENT, sourceKey, recipientId, options.inApp ?? "pending", now, now, crypto.randomUUID(), outboxId, VIDEO_REVIEW_NOTIFICATION_EVENT, sourceKey, recipientId, now, now),
  ]);
  return { now, recipientId, projectId, assetId: assetId!, outboxId: outboxId!, sourceKey };
}

/** Remove the Version, then Undo it: the removal's suppression statements run, and the Video stays live (an Undo adds nothing to the notification tables). */
async function removeThenUndo(f: Fixture): Promise<void> {
  const auditId = crypto.randomUUID();
  await database.DB.prepare("INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) VALUES (?, NULL, 'video_version.remove', 'asset', ?, '{}', ?)").bind(auditId, f.assetId, Date.now()).run();
  await database.DB.batch(videoRemovalSuppressionStatements(database.DB, { projectId: f.projectId, path: "$.video.assetId", subjectId: f.assetId, auditId, now: Date.now() }));
}

/** A DB whose next batch after the notification INSERT is prepared (the in-app admission batch) first runs `before`: the worker has claimed and re-resolved, and has not yet inserted. */
function interleavedDb(before: () => Promise<void>): D1Database {
  let armed = false; let fired = false;
  return new Proxy(database.DB, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => { if (/^\s*INSERT INTO notifications\b/.test(sql)) armed = true; return target.prepare(sql); };
      if (key === "batch") return async (statements: D1PreparedStatement[]) => { if (armed && !fired) { fired = true; await before(); } return target.batch(statements); };
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const message = (outboxId: string) => ({ body: { type: "notification_outbox", outboxId } as NotificationOutboxMessage, attempts: 0, ack: vi.fn(), retry: vi.fn() });
const deliveryEnv = (send?: ReturnType<typeof vi.fn>, db: D1Database = database.DB): Env => ({ DB: db, APP_ENV: "test", APP_ORIGIN: "https://portal.test", NOTIFICATION_QUEUE: { send: vi.fn().mockResolvedValue(undefined) }, EMAIL: send ? { send } : undefined, NOTIFICATIONS_FROM_ADDRESS: send ? "studio@example.test" : undefined }) as unknown as Env;
const ledger = (outboxId: string, channel: "in_app" | "email") => database.DB.prepare("SELECT status, last_error_code, email_message_id FROM notification_delivery_ledger WHERE outbox_id = ? AND channel = ?").bind(outboxId, channel).first<{ status: string; last_error_code: string | null; email_message_id: string | null }>();
const notificationCount = async (f: Fixture) => (await database.DB.prepare("SELECT COUNT(*) AS n FROM notifications WHERE source_key = ? AND user_id = ?").bind(f.sourceKey, f.recipientId).first<{ n: number }>())!.n;
const outboxStatus = async (id: string) => (await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(id).first<{ status: string }>())!.status;

describe("#776 C: a delivery claimed before a removal never goes out after the Undo", () => {
  beforeAll(async () => { await executeSql(__PORTAL_MIGRATION_SQL__); });

  it("control: with no removal the in-app notification is inserted and the email is sent", async () => {
    const f = await seed(); const send = vi.fn().mockResolvedValue({ messageId: "mail-1" });
    await processNotificationMessage(deliveryEnv(send), message(f.outboxId) as never);
    expect(await notificationCount(f)).toBe(1);
    expect(await ledger(f.outboxId, "in_app")).toMatchObject({ status: "sent" });
    expect(await ledger(f.outboxId, "email")).toMatchObject({ status: "sent", email_message_id: "mail-1" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("in-app: claim, remove, Undo, the worker resumes: no notification is inserted and nothing is sent", async () => {
    const f = await seed(); const send = vi.fn().mockResolvedValue({ messageId: "mail-2" });
    const m = message(f.outboxId);
    await processNotificationMessage(deliveryEnv(send, interleavedDb(() => removeThenUndo(f))), m as never);
    expect(await notificationCount(f)).toBe(0);
    expect(await ledger(f.outboxId, "in_app")).toMatchObject({ status: "suppressed", last_error_code: "video_removed" });
    expect(await ledger(f.outboxId, "email")).toMatchObject({ status: "suppressed", last_error_code: "video_removed" });
    expect(send).not.toHaveBeenCalled();
    expect(await outboxStatus(f.outboxId)).toBe("completed");
    expect(m.ack).toHaveBeenCalledOnce(); expect(m.retry).not.toHaveBeenCalled();
  });

  it("email: claim, remove, Undo, quota rejection: the quota retry does not rearm it, and a later run never sends", async () => {
    const f = await seed({ inApp: "sent" });
    const send = vi.fn(async () => { await removeThenUndo(f); throw { code: "E_RATE_LIMIT_EXCEEDED" }; });
    await processNotificationMessage(deliveryEnv(send), message(f.outboxId) as never);
    expect(send).toHaveBeenCalledOnce();
    expect(await ledger(f.outboxId, "email")).toMatchObject({ status: "suppressed", last_error_code: "video_removed" });
    // The queue retry (or Cron) that would have resent a rearmed row.
    await database.DB.prepare("UPDATE notification_outbox SET available_at = ? WHERE id = ? AND status = 'queued'").bind(Date.now() - 1, f.outboxId).run();
    await processNotificationMessage(deliveryEnv(send), message(f.outboxId) as never);
    expect(send).toHaveBeenCalledOnce();
    expect(await ledger(f.outboxId, "email")).toMatchObject({ status: "suppressed" });
    expect(await outboxStatus(f.outboxId)).toBe("completed");
  });

  it("email: a send already accepted, or ambiguous, keeps its recorded outcome after the removal", async () => {
    const accepted = await seed({ inApp: "sent" });
    await processNotificationMessage(deliveryEnv(vi.fn(async () => { await removeThenUndo(accepted); return { messageId: "mail-3" }; })), message(accepted.outboxId) as never);
    expect(await ledger(accepted.outboxId, "email")).toMatchObject({ status: "sent", email_message_id: "mail-3", last_error_code: null });

    const ambiguous = await seed({ inApp: "sent" });
    await processNotificationMessage(deliveryEnv(vi.fn(async () => { await removeThenUndo(ambiguous); throw new Error("uncoded"); })), message(ambiguous.outboxId) as never);
    expect(await ledger(ambiguous.outboxId, "email")).toMatchObject({ status: "unknown", last_error_code: "email_acceptance_unknown" });
  });
});
