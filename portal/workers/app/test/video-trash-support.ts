import { expect } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { baseEnv, cookie, database, ids, type Who } from "./embedded-media-support";
import { addMember, clearGuestRows, seedGuestLink } from "./guest-support";
import { clearVideoNotes, seedVideoVersion } from "./video-review-support";

/** Shared by the Video Trash test files (`video-trash.test.ts`, `video-delete.test.ts`): seeds, tiny SQL readers and the interleaving proxy. */
export type Json = Record<string, any>;
export const OPEN = ["video_review", "video_review_trash", "video_review_notes", "video_review_links", "video_review_delivery", `video_review_pilot:${ids.project}`, `video_review_pilot:${ids.archivedProject}`] as const;
export const p = (rest: string, projectId: string = ids.project) => `/api/projects/${projectId}${rest}`;
export type Seeded = Awaited<ReturnType<typeof seedVideoVersion>>;
/** A Video with `count` Versions, the newest current and every older one superseded (as upload completion leaves it). A given `title` is also every Version's file name, because the title follows the newest live one (#828). */
export async function seedVideo(count: number, input: { projectId?: string; title?: string } = {}): Promise<Seeded[]> {
  const out: Seeded[] = [];
  for (let version = 1; version <= count; version += 1) out.push(await seedVideoVersion({ projectId: input.projectId, videoId: out[0]?.videoId, version, title: input.title, filename: input.title ? `${input.title}.mp4` : undefined, poster: true }));
  const now = Date.now();
  for (let i = 0; i < out.length - 1; i += 1) await database.DB.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ? WHERE id = ?").bind(now, out[i + 1]!.assetId, out[i]!.assetId).run();
  return out;
}
export const rows = async (sql: string, ...binds: unknown[]) => (await database.DB.prepare(sql).bind(...binds).all<Json>()).results;
export const first = async (sql: string, ...binds: unknown[]) => (await rows(sql, ...binds))[0] ?? null;
export async function seedEvent(seed: Seeded, decision: "approved" | "changes_requested" = "approved") {
  const id = crypto.randomUUID();
  const revision = (await first("SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM video_approval_events WHERE asset_id = ?", seed.assetId))!.next as number;
  await database.DB.prepare("INSERT INTO video_approval_events (id, project_id, video_id, asset_id, link_id, revision, decision, note, actor_guest_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, 'secret decision note', NULL, ?, ?)")
    .bind(id, seed.projectId, seed.videoId, seed.assetId, revision, decision, ids.admin, Date.now()).run();
  return { id, revision };
}
export async function seedRelease(seed: Seeded) {
  const event = await seedEvent(seed); const id = crypto.randomUUID();
  await database.DB.prepare("INSERT INTO video_releases (id, project_id, video_id, asset_id, approval_event_id, approval_revision, released_by, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, seed.projectId, seed.videoId, seed.assetId, event.id, event.revision, ids.admin, Date.now()).run();
  return { id, event };
}
/** A Review link with the Video as a member and the Versions granted. */
export async function seedLink(seed: Seeded, assets: string[], input: { label?: string | null; expiresAt?: number; revoked?: boolean } = {}) {
  const link = await seedGuestLink({ label: input.label === undefined ? "Smith family" : input.label, expiresAt: input.expiresAt, revoked: input.revoked });
  await addMember(link.id, seed.videoId, assets);
  return link;
}

export const wipe = async () => {
  await clearGuestRows(); await clearVideoNotes();
  await database.DB.batch([
    database.DB.prepare("DELETE FROM notification_digest_items"), database.DB.prepare("DELETE FROM notification_delivery_ledger"), database.DB.prepare("DELETE FROM notification_outbox"),
    database.DB.prepare("DELETE FROM video_upload_reservations"),
    database.DB.prepare("DELETE FROM video_releases"), database.DB.prepare("DELETE FROM video_approval_events"), database.DB.prepare("DELETE FROM video_premium_unlocks"),
    database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'video_version.%' OR action LIKE 'video.%' OR action LIKE 'review_link.%'"),
    database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets WHERE kind = 'video'"), database.DB.prepare("DELETE FROM videos"),
  ]);
};
/** The real app against a D1 whose first batch of at least `min` statements runs `before` just ahead of itself: the handler's reads are done, its committing batch is not. */
export async function racing(method: string, path: string, body: unknown, before: () => Promise<unknown>, options: { who?: Who; min?: number } = {}) {
  let ran = false;
  const db = new Proxy(database.DB, {
    get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => { if (!ran && statements.length >= (options.min ?? 5)) { ran = true; await before(); } return target.batch(statements); };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
  const headers = new Headers({ cookie: await cookie(options.who ?? "admin"), origin: baseEnv.APP_ORIGIN, "content-type": "application/json" });
  const executionContext = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
  const response = await app.fetch(new Request(`https://portal.test${path}`, { method, headers, body: JSON.stringify(body) }), { ...baseEnv, DB: db } as Env, executionContext);
  expect(ran, "the committing batch ran through the proxy").toBe(true);
  return response;
}

// ---- notifications ----
export type Target = { assetId: string; videoId: string };
export async function seedDelivery(target: Target, status: "pending" | "queued" | "processing" | "completed", ledger: "pending" | "deferred" | "processing" | "sent", digest: "pending" | "sent" | null, tag: string) {
  const outboxId = crypto.randomUUID(); const now = Date.now(); const sourceKey = `video_note:${tag}`;
  const payload = JSON.stringify({ schemaVersion: 1, video: { kind: "video_note", projectId: ids.project, videoId: target.videoId, assetId: target.assetId, sourceId: tag } });
  const lease = status === "processing";
  await database.DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, payload_json, status, available_at, lease_token, lease_expires_at, created_at, updated_at) VALUES (?, 1, 'project.video_review.notification', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(outboxId, sourceKey, ids.project, ids.admin, ids.member, payload, status, now, lease ? "lease" : null, lease ? now + 60_000 : null, now, now).run();
  const ledgerId = crypto.randomUUID();
  await database.DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at) VALUES (?, ?, 'project.video_review.notification', ?, ?, 'email', ?, ?, ?)").bind(ledgerId, outboxId, sourceKey, ids.member, ledger, now, now).run();
  let digestId: string | null = null;
  if (digest) { digestId = crypto.randomUUID(); await database.DB.prepare("INSERT INTO notification_digest_items (id, recipient_id, ledger_id, project_id, notification_type, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'project_video_review', ?, ?, ?)").bind(digestId, ids.member, ledgerId, ids.project, digest, now, now).run(); }
  return { outboxId, ledgerId, digestId };
}
export const states = async (d: { outboxId: string; ledgerId: string; digestId: string | null }) => ({
  outbox: (await first("SELECT status FROM notification_outbox WHERE id = ?", d.outboxId))!.status,
  ledger: (await first("SELECT status FROM notification_delivery_ledger WHERE id = ?", d.ledgerId))!.status,
  digest: d.digestId ? (await first("SELECT state FROM notification_digest_items WHERE id = ?", d.digestId))!.state : null,
});
