import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VIDEO_REVIEW_NOTIFICATION_EVENT, type NotificationOutboxMessage, type VideoReviewNotificationType } from "@quincy/shared";
import { externalVisibleNotificationCte } from "@quincy/db";
import type { Env } from "../src/env";
import { processNotificationMessage } from "../src/notification-delivery";
import { runEmailDigests } from "../src/email-digest";

/** The staff video-review notification resolver and delivery (#741 15a). */
const database = env as unknown as { DB: D1Database };
declare const __PORTAL_MIGRATION_SQL__: string;
const SENTINEL = "SENTINEL-note-text-must-never-travel";

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); }
  }
}
const message = (outboxId: string) => ({ body: { type: "notification_outbox", outboxId } as NotificationOutboxMessage, attempts: 0, ack: vi.fn(), retry: vi.fn() }) as never;
const deliveryEnv = (send?: ReturnType<typeof vi.fn>): Env => ({ DB: database.DB, APP_ENV: "test", APP_ORIGIN: "https://portal.test", NOTIFICATION_QUEUE: { send: vi.fn().mockResolvedValue(undefined) }, EMAIL: send ? { send } : undefined, NOTIFICATIONS_FROM_ADDRESS: send ? "studio@example.test" : undefined }) as unknown as Env;
/** #489: a person with no preference row reads as Twice daily and gets a digest, so an inline email needs 'immediate'. */
const setCadence = (userId: string, cadence: string) => database.DB.prepare("INSERT INTO notification_preferences (user_id, email_digest_cadence, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET email_digest_cadence = excluded.email_digest_cadence").bind(userId, cadence, Date.now()).run();

type Role = "admin" | "editor" | "external_editor" | "photographer";
type Options = {
  kind?: VideoReviewNotificationType; actor?: "member" | "guest"; role?: Role; member?: boolean; recipientActive?: boolean; internal?: boolean; version?: number; decision?: "approved" | "changes_requested";
  authorization?: "member" | "admin"; notifyStaff?: boolean; gateOpen?: boolean; archived?: boolean; cadence?: string | null; noSource?: boolean; deletedNote?: boolean; videoTitle?: string; guestName?: string;
};

async function seed(options: Options = {}) {
  const kind = options.kind ?? "video_note"; const now = Date.now();
  const id = () => crypto.randomUUID();
  const projectId = id(); const collectionId = id(); const videoId = id(); const assetId = id(); const recipientId = id(); const actorUserId = id(); const guestId = id(); const membershipId = id(); const outboxId = id();
  const noteId = id(); const rootId = id(); const eventId = id();
  const role = options.role ?? "editor";
  const sourceId = kind === "video_version_uploaded" ? assetId : kind === "video_note" ? noteId : kind === "video_reply" ? noteId : eventId;
  const guestActor = (options.actor ?? "member") === "guest";
  const actorId = guestActor ? `guest:${guestId}` : actorUserId;
  const statements: D1PreparedStatement[] = [
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Recipient Person', ?, 1, ?, ?, ?, ?), (?, 'Alex Actor', ?, 1, 'editor', 1, ?, ?)").bind(recipientId, `${recipientId}@example.test`, role, options.recipientActive === false ? 0 : 1, now, now, actorUserId, `${actorUserId}@example.test`, now, now),
    database.DB.prepare("INSERT INTO guest_reviewers (id, email_normalized, display_name, created_at) VALUES (?, ?, ?, ?)").bind(guestId, `${guestId}@guest.test`, options.guestName ?? "Jane Smith", now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, archived_at, created_at, updated_at) VALUES (?, '1 Delivery Street', 'editing_autohdr', ?, ?, ?)").bind(projectId, options.archived ? now : null, now, now),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'video', 'empty', 0, ?, ?)").bind(collectionId, projectId, now, now),
    database.DB.prepare("INSERT INTO videos (id, project_id, collection_id, title, premium, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)").bind(videoId, projectId, collectionId, options.videoTitle ?? "Kitchen walkthrough", actorUserId, now, now),
    database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version_group_id, version, publish_status, created_at, updated_at) VALUES (?, ?, 'video', ?, 'cut.mp4', 4096, 'upload', ?, ?, 'ready', ?, ?)").bind(assetId, collectionId, `projects/${projectId}/video/${videoId}/${assetId}/original.mp4`, videoId, options.version ?? 3, now, now),
    database.DB.prepare("INSERT INTO video_version_meta (asset_id, video_id, fps_num, fps_den, media_timescale, frame_delta, frame_count, duration_ms, width, height, codec, codec_string, start_tc_frames, tc_nominal_fps, tc_drop_frame, fast_start, has_audio, probe_version, poster_key, uploaded_by, created_at) VALUES (?, ?, 25, 1, 25000, 1000, 250, 10000, 1920, 1080, 'avc1', 'avc1.640028', NULL, 25, 0, 1, 1, 1, NULL, ?, ?)").bind(assetId, videoId, actorUserId, now),
  ];
  if (options.member !== false) statements.push(database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(membershipId, projectId, recipientId, role === "photographer" ? "photographer" : "editor", now));
  const noteColumns = "(id, project_id, video_id, asset_id, parent_id, author_user_id, author_guest_id, author_role, visibility, start_frame, end_frame, drawing_frame, body, revision, deleted_at, created_at)";
  if (!options.noSource) {
    if (kind === "video_note" || kind === "video_reply") {
      const parent = kind === "video_reply" ? rootId : null;
      if (parent) statements.push(database.DB.prepare(`INSERT INTO video_notes ${noteColumns} VALUES (?, ?, ?, ?, NULL, ?, NULL, 'editor', 'public', 5, NULL, NULL, 'Root', 1, NULL, ?)`).bind(rootId, projectId, videoId, assetId, recipientId, now - 10));
      statements.push(database.DB.prepare(`INSERT INTO video_notes ${noteColumns} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1, ?, ?)`)
        .bind(noteId, projectId, videoId, assetId, parent, guestActor ? null : actorUserId, guestActor ? guestId : null, guestActor ? "guest" : "editor", guestActor ? "public" : options.internal ? "internal" : "public", parent ? null : 10, SENTINEL, options.deletedNote ? now : null, now));
    }
    if (kind === "video_decision") {
      // A guest's decision names its link (a CHECK); a staff-recorded one has none.
      const linkId = guestActor ? id() : null;
      if (linkId) statements.push(database.DB.prepare("INSERT INTO client_links (id, project_id, token_hash, publish_version, expires_at, passcode_hash, created_at, kind, label, allow_comments, allow_approve, allow_download, created_by, token_generation, updated_at) VALUES (?, ?, ?, NULL, ?, NULL, ?, 'video_review', 'Smith family', 1, 1, 1, ?, 1, ?)").bind(linkId, projectId, `hash-${linkId}`, now + 86_400_000, now, actorUserId, now));
      statements.push(database.DB.prepare("INSERT INTO video_approval_events (id, project_id, video_id, asset_id, link_id, revision, decision, note, actor_guest_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)").bind(eventId, projectId, videoId, assetId, linkId, options.decision ?? "approved", SENTINEL, guestActor ? guestId : null, guestActor ? null : actorUserId, now));
    }
  }
  const prefix = kind === "video_version_uploaded" ? "video_version" : kind;
  const sourceKey = `${prefix}:${sourceId}`;
  const payload = {
    schemaVersion: 1,
    event: { type: VIDEO_REVIEW_NOTIFICATION_EVENT, sourceKey, recipientId },
    authorizationAtOccurrence: options.authorization === "admin" || (role === "admin" && options.authorization !== "member") ? { kind: "admin" } : { kind: "project_member", membershipIds: [membershipId] },
    video: { kind, projectId, videoId, assetId, sourceId },
  };
  statements.push(
    database.DB.prepare("INSERT INTO notification_outbox (id, schema_version, event_type, source_key, project_id, actor_id, recipient_id, recipient_authorization_epoch, payload_json, status, available_at, created_at, updated_at) SELECT ?, 1, ?, ?, ?, ?, ?, authorization_epoch, ?, 'queued', ?, ?, ? FROM user WHERE id = ?").bind(outboxId, VIDEO_REVIEW_NOTIFICATION_EVENT, sourceKey, projectId, actorId, recipientId, JSON.stringify(payload), now - 1, now, now, recipientId),
    database.DB.prepare("INSERT INTO notification_delivery_ledger (id, outbox_id, event_type, source_key, recipient_id, channel, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'in_app', 'pending', ?, ?), (?, ?, ?, ?, ?, 'email', 'pending', ?, ?)").bind(id(), outboxId, VIDEO_REVIEW_NOTIFICATION_EVENT, sourceKey, recipientId, now, now, id(), outboxId, VIDEO_REVIEW_NOTIFICATION_EVENT, sourceKey, recipientId, now, now),
  );
  const flags = options.gateOpen === false ? [] : ["video_review", "video_review_all_projects", ...(options.notifyStaff === false ? [] : ["video_review_notify_staff"])];
  for (const key of flags) statements.push(database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1").bind(key, now));
  await database.DB.batch(statements);
  if (options.cadence !== null) await setCadence(recipientId, options.cadence ?? "immediate");
  return { outboxId, recipientId, projectId, membershipId, sourceKey, actorId, guestId, assetId };
}

async function deliver(fixture: { outboxId: string }, send: ReturnType<typeof vi.fn> | undefined = vi.fn().mockResolvedValue({ messageId: "m-1" })) {
  await processNotificationMessage(deliveryEnv(send), message(fixture.outboxId));
  return send;
}
const stored = (recipientId: string) => database.DB.prepare("SELECT type, title, body, source_key AS sourceKey, project_id AS projectId FROM notifications WHERE user_id = ?").bind(recipientId).all<{ type: string; title: string; body: string | null; sourceKey: string; projectId: string }>().then((result) => result.results);
const ledger = async (outboxId: string) => Object.fromEntries((await database.DB.prepare("SELECT channel, status FROM notification_delivery_ledger WHERE outbox_id = ?").bind(outboxId).all<{ channel: string; status: string }>()).results.map((row) => [row.channel, row.status]));
const outboxStatus = async (outboxId: string) => (await database.DB.prepare("SELECT status FROM notification_outbox WHERE id = ?").bind(outboxId).first<{ status: string }>())!.status;
const emailText = (send: ReturnType<typeof vi.fn>) => JSON.stringify(send.mock.calls);

beforeAll(async () => { await executeSql(__PORTAL_MIGRATION_SQL__); });
beforeEach(async () => { await database.DB.prepare("DELETE FROM feature_flags").run(); });

describe("delivery: copy and the sentinel", () => {
  it.each([
    ["a guest note", { kind: "video_note", actor: "guest" }, "Jane Smith (client) left a note on “Kitchen walkthrough” v3"],
    ["a staff note", { kind: "video_note", actor: "member" }, "Alex Actor left a note on “Kitchen walkthrough” v3"],
    ["an internal staff note", { kind: "video_note", actor: "member", internal: true }, "Alex Actor left a note on “Kitchen walkthrough” v3"],
    ["a staff reply", { kind: "video_reply", actor: "member" }, "Alex Actor replied on “Kitchen walkthrough” v3"],
    ["a guest reply", { kind: "video_reply", actor: "guest" }, "Jane Smith (client) replied on “Kitchen walkthrough” v3"],
    ["an upload", { kind: "video_version_uploaded", actor: "member", version: 4 }, "New Version 4 of “Kitchen walkthrough”"],
    ["an approval", { kind: "video_decision", actor: "guest", decision: "approved" }, "Jane Smith (client) approved “Kitchen walkthrough” v3"],
    ["a change request", { kind: "video_decision", actor: "guest", decision: "changes_requested" }, "Jane Smith (client) requested changes on “Kitchen walkthrough” v3"],
  ] as Array<[string, Options, string]>)("%s: composes the title at delivery, emails it, and carries no note text anywhere", async (_name, options, title) => {
    const fixture = await seed(options);
    const send = await deliver(fixture);
    const rows = await stored(fixture.recipientId);
    expect(rows).toEqual([{ type: options.kind, title, body: expect.any(String), sourceKey: fixture.sourceKey, projectId: fixture.projectId }]);
    expect(await ledger(fixture.outboxId)).toEqual({ in_app: "sent", email: "sent" });
    expect(await outboxStatus(fixture.outboxId)).toBe("completed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send!.mock.calls[0]![0]).toMatchObject({ to: expect.stringContaining("@example.test"), subject: title });
    // The sentinel is the note's own text (and a decision's note); it must be in no stored notification and no email field.
    expect(JSON.stringify(rows)).not.toContain(SENTINEL);
    expect(emailText(send!)).not.toContain(SENTINEL);
    expect(send!.mock.calls[0]![0].text).toContain(`https://portal.test/projects/${fixture.projectId}`);
  });

  it("escapes a hostile display name and Video title in the email HTML", async () => {
    const fixture = await seed({ kind: "video_note", actor: "guest", guestName: "<b>Jane</b>", videoTitle: "A & B <script>" });
    const send = await deliver(fixture);
    const html = send!.mock.calls[0]![0].html as string;
    expect(html).not.toContain("<b>Jane</b>"); expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;Jane&lt;/b&gt;");
  });

  it("emails nothing inline for a person on a digest cadence (the email follows the person's cadence), but still delivers in app", async () => {
    const fixture = await seed({ cadence: "twice_daily" });
    const send = await deliver(fixture);
    expect(send).not.toHaveBeenCalled();
    expect(await stored(fixture.recipientId)).toHaveLength(1);
    expect(await ledger(fixture.outboxId)).toMatchObject({ in_app: "sent", email: "deferred" });
  });
});

describe("delivery: who still gets it", () => {
  it("an Admin with an admin snapshot is delivered without a membership", async () => {
    const fixture = await seed({ role: "admin", member: false });
    await deliver(fixture);
    expect(await stored(fixture.recipientId)).toHaveLength(1);
  });

  it("an Admin who was demoted is suppressed", async () => {
    const fixture = await seed({ role: "editor", authorization: "admin", member: true });
    await deliver(fixture);
    expect(await stored(fixture.recipientId)).toEqual([]);
    expect(await outboxStatus(fixture.outboxId)).toBe("suppressed");
  });

  it("an assigned External is delivered in app and by email, and sees it in the External list; the list shows it only while assigned", async () => {
    const fixture = await seed({ role: "external_editor", kind: "video_note", actor: "guest" });
    const send = await deliver(fixture);
    expect(send).toHaveBeenCalledTimes(1);
    const visible = async () => { const cte = externalVisibleNotificationCte(fixture.recipientId); return (await database.DB.prepare(`${cte.sql} SELECT id FROM external_visible_notifications`).bind(...cte.bindings).all()).results.length; };
    expect(await visible()).toBe(1);
    await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(fixture.membershipId).run();
    expect(await visible()).toBe(0);
  });

  it("a member removed before delivery is suppressed: no notification, no email", async () => {
    const fixture = await seed({});
    await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(fixture.membershipId).run();
    const send = await deliver(fixture);
    expect(await stored(fixture.recipientId)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(await outboxStatus(fixture.outboxId)).toBe("suppressed");
    expect(Object.values(await ledger(fixture.outboxId))).toEqual(["suppressed", "suppressed"]);
  });

  it("an External removed from the Project is suppressed", async () => {
    const fixture = await seed({ role: "external_editor" });
    await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(fixture.membershipId).run();
    const send = await deliver(fixture);
    expect(await stored(fixture.recipientId)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["an inactive recipient", { recipientActive: false }],
    ["a Photographer", { role: "photographer" }],
    ["video review closed", { gateOpen: false }],
    ["notify_staff off", { notifyStaff: false }],
    ["an archived Project", { archived: true }],
    ["a deleted note", { deletedNote: true }],
    ["a note that no longer exists", { noSource: true }],
    ["a decision that no longer exists", { kind: "video_decision", noSource: true }],
  ] as Array<[string, Options]>)("suppresses %s", async (_name, options) => {
    const fixture = await seed(options);
    const send = await deliver(fixture);
    expect(await stored(fixture.recipientId)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(await outboxStatus(fixture.outboxId)).toBe("suppressed");
  });

  it("suppresses when the recipient's authorization epoch moved", async () => {
    const fixture = await seed({ role: "external_editor" });
    await database.DB.prepare("UPDATE user SET authorization_epoch = authorization_epoch + 1 WHERE id = ?").bind(fixture.recipientId).run();
    await deliver(fixture);
    expect(await stored(fixture.recipientId)).toEqual([]);
  });

  it("suppresses a payload that is not the strict shape", async () => {
    const fixture = await seed({});
    await database.DB.prepare("UPDATE notification_outbox SET payload_json = json_set(payload_json, '$.video.body', 'note text') WHERE id = ?").bind(fixture.outboxId).run();
    await deliver(fixture);
    expect(await stored(fixture.recipientId)).toEqual([]);
    expect(await outboxStatus(fixture.outboxId)).toBe("suppressed");
  });

  it("delivers once: a repeated message adds no second notification or email", async () => {
    const fixture = await seed({});
    const send = await deliver(fixture);
    await processNotificationMessage(deliveryEnv(send), message(fixture.outboxId));
    expect(await stored(fixture.recipientId)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

/** Sol finding on 15a: a deferred email is re-authorized when the digest composes and sends it, not only when it was deferred. */
describe("digest: a deferred video-review email is re-authorized before it is sent", () => {
  const EIGHT_AM = Date.UTC(2026, 6, 1, 22);
  const digestDefer = async (options: Options) => {
    const fixture = await seed({ cadence: "twice_daily", ...options });
    const send = vi.fn().mockResolvedValue({ messageId: "digest-1" });
    await processNotificationMessage(deliveryEnv(vi.fn()), message(fixture.outboxId));
    expect(await ledger(fixture.outboxId)).toMatchObject({ in_app: "sent", email: "deferred" });
    return { fixture, send };
  };
  const flush = async (send: ReturnType<typeof vi.fn>) => { await runEmailDigests(deliveryEnv(send), EIGHT_AM); };
  const exec = (sql: string, ...binds: unknown[]) => database.DB.prepare(sql).bind(...binds).run();

  it("control: nothing changed, the digest sends it", async () => {
    const { fixture, send } = await digestDefer({});
    await flush(send);
    // Items deferred by earlier tests in this file go out in the same run, so count only this recipient's email.
    expect(send.mock.calls.filter(([mail]) => mail.to === `${fixture.recipientId}@example.test`)).toHaveLength(1);
    expect(await ledger(fixture.outboxId)).toMatchObject({ email: "sent" });
  });

  it.each([
    ["membership removed", { role: "editor" }, (f: { membershipId: string }) => exec("DELETE FROM project_members WHERE id = ?", f.membershipId)],
    ["the role loses viewVideo", { role: "editor" }, (f: { recipientId: string }) => exec("UPDATE user SET role = 'photographer' WHERE id = ?", f.recipientId)],
    ["the epoch is bumped", { role: "editor" }, (f: { recipientId: string }) => exec("UPDATE user SET authorization_epoch = authorization_epoch + 1 WHERE id = ?", f.recipientId)],
    ["notify_staff is turned off", { role: "editor" }, () => exec("DELETE FROM feature_flags WHERE key = 'video_review_notify_staff'")],
    ["the note is deleted", { kind: "video_note" }, (f: { sourceKey: string }) => exec("UPDATE video_notes SET deleted_at = ? WHERE id = ?", Date.now(), f.sourceKey.split(":")[1])],
    ["the decision row is removed", { kind: "video_decision", actor: "guest" }, (f: { sourceKey: string }) => exec("DELETE FROM video_approval_events WHERE id = ?", f.sourceKey.split(":")[1])],
    ["an assigned External is unassigned", { role: "external_editor", kind: "video_note", actor: "guest" }, (f: { membershipId: string }) => exec("DELETE FROM project_members WHERE id = ?", f.membershipId)],
    ["notify_staff is turned off for an External", { role: "external_editor", kind: "video_note", actor: "guest" }, () => exec("DELETE FROM feature_flags WHERE key = 'video_review_notify_staff'")],
    ["the note is deleted for an External", { role: "external_editor", kind: "video_note", actor: "guest" }, (f: { sourceKey: string }) => exec("UPDATE video_notes SET deleted_at = ? WHERE id = ?", Date.now(), f.sourceKey.split(":")[1])],
  ] as Array<[string, Options, (fixture: any) => Promise<unknown>]>)("%s: no email", async (_name, options, change) => {
    const { fixture, send } = await digestDefer(options);
    await change(fixture);
    await flush(send);
    expect(send.mock.calls.filter(([mail]) => mail.to === `${fixture.recipientId}@example.test`)).toEqual([]);
    expect((await ledger(fixture.outboxId)).email).toBe("suppressed");
  });
});
