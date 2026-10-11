import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runGuestDigests, sweepGuestDigests } from "../src/guest-digest";
import type { Env } from "../src/env";

/**
 * The client hourly digest flush (#741 15b). Rows are seeded straight into the tables (the producers have their own suite in the app Worker); every case pins `now`.
 * Settled decisions 10 and 11 of docs/plans/741-13-15.md apply: an ambiguous send counts as sent and is never resent.
 */
const database = env as unknown as { DB: D1Database };
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); }
  }
}

const ORIGIN = "https://portal.test";
const SENDER = "studio@example.test";
const HOUR = 3_600_000; const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 12, 10, 0, 0);
const OPEN_FLAGS = ["video_review", "video_review_all_projects", "video_review_guest", "video_review_notify_client"];
const SENTINEL = "INTERNAL-SENTINEL-7f3a91";

/** Runs the flush with the cron's scheduled time AND the real clock at `at` (the flush judges and records the real clock; a delayed run is its own case). */
const runAt = (target: Env, at: number) => { vi.setSystemTime(at); return runGuestDigests(target, at); };

type Sent = { from: string; to: string; subject: string; text?: string; html?: string; headers?: Record<string, string> };
function mailer(options: { fail?: unknown } = {}) {
  const sent: Sent[] = [];
  const send = vi.fn(async (message: Sent) => { if (options.fail !== undefined) throw options.fail; sent.push(message); return { messageId: `m-${sent.length}` }; });
  const configured = { DB: database.DB, APP_ORIGIN: ORIGIN, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: SENDER } as unknown as Env;
  return { sent, send, env: configured };
}

const ids = { user: crypto.randomUUID(), project: crypto.randomUUID(), collection: crypto.randomUUID() };
beforeAll(async () => {
  const applied = await database.DB.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'guest_notification_digest'").first();
  if (!applied) await executeSql(__PORTAL_MIGRATION_SQL__);
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Staff Person', ?, 1, 'editor', 1, ?, ?)").bind(ids.user, `${ids.user}@example.test`, now, now),
    database.DB.prepare("INSERT OR IGNORE INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Digest Street', 'editing_autohdr', ?, ?)").bind(ids.project, now, now),
    database.DB.prepare("INSERT OR IGNORE INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'video', 'empty', 0, ?, ?)").bind(ids.collection, ids.project, now, now),
  ]);
}, 60_000);

const wipe = () => database.DB.batch([
  "guest_notification_digest", "guest_unsubscribe_tokens", "guest_link_members", "video_releases", "video_approval_events", "review_link_version_grants", "review_link_videos", "client_links", "video_notes", "video_version_meta",
].map((table) => database.DB.prepare(`DELETE FROM ${table}`)).concat([database.DB.prepare("DELETE FROM assets WHERE kind = 'video'"), database.DB.prepare("DELETE FROM videos"), database.DB.prepare("DELETE FROM guest_reviewers"), database.DB.prepare("DELETE FROM feature_flags WHERE key LIKE 'video_review%'")]));
const openGate = async (flags: string[] = OPEN_FLAGS) => { for (const key of flags) await database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1").bind(key, Date.now()).run(); };
// The flush authorizes against the real clock (Date.now()), not the cron's scheduled time, so the clock is pinned to T0 for every case.
beforeEach(async () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0); await wipe(); await openGate(); });
afterEach(() => { vi.useRealTimers(); });

type Version = { videoId: string; assetId: string; version: number };
async function seedVideo(title: string, versions = 1): Promise<Version[]> {
  const videoId = crypto.randomUUID(); const now = Date.now(); const out: Version[] = [];
  await database.DB.prepare("INSERT INTO videos (id, project_id, collection_id, title, premium, position, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)").bind(videoId, ids.project, ids.collection, title, ids.user, now, now).run();
  for (let version = 1; version <= versions; version += 1) {
    const assetId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version_group_id, version, publish_status, created_at, updated_at) VALUES (?, ?, 'video', ?, 'cut.mp4', 4096, 'upload', ?, ?, 'ready', ?, ?)").bind(assetId, ids.collection, `k/${assetId}`, videoId, version, now, now).run();
    await database.DB.prepare("INSERT INTO video_version_meta (asset_id, video_id, fps_num, fps_den, media_timescale, frame_delta, frame_count, duration_ms, width, height, codec, codec_string, start_tc_frames, tc_nominal_fps, tc_drop_frame, fast_start, has_audio, probe_version, poster_key, uploaded_by, created_at) VALUES (?, ?, 25, 1, 25000, 1000, 5000, 200000, 1920, 1080, 'avc1', 'avc1.640028', NULL, 25, 0, 1, 1, 1, NULL, ?, ?)").bind(assetId, videoId, ids.user, now).run();
    out.push({ videoId, assetId, version });
  }
  return out;
}
async function seedLink(input: { label?: string | null; expiresAt?: number; revoked?: boolean; allowDownload?: number } = {}) {
  const id = crypto.randomUUID(); const now = Date.now(); const token = `link-token-${crypto.randomUUID()}`;
  await database.DB.prepare(`INSERT INTO client_links (id, project_id, token_hash, publish_version, expires_at, passcode_hash, created_at, kind, label, allow_comments, allow_approve, allow_download, created_by, token_generation, updated_at, revoked_at, revoked_by)
    VALUES (?, ?, ?, NULL, ?, NULL, ?, 'video_review', ?, 1, 1, ?, ?, 1, ?, ?, ?)`).bind(id, ids.project, `hash-of-${token}`, input.expiresAt ?? T0 + 30 * DAY, now, input.label === undefined ? "Smith family" : input.label, input.allowDownload ?? 1, ids.user, now, input.revoked ? now : null, input.revoked ? ids.user : null).run();
  return { id, token };
}
async function onLink(linkId: string, versions: Version[], granted = versions) {
  await database.DB.prepare("INSERT INTO review_link_videos (id, link_id, video_id, project_id, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), linkId, versions[0]!.videoId, ids.project, ids.user, Date.now()).run();
  for (const version of granted) await database.DB.prepare("INSERT INTO review_link_version_grants (id, link_id, video_id, asset_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), linkId, version.videoId, version.assetId, ids.user, Date.now()).run();
}
async function seedMember(linkId: string, input: { guestId?: string; email?: string; unsubscribed?: boolean; lastDigestSentAt?: number | null } = {}) {
  const guestId = input.guestId ?? crypto.randomUUID(); const memberId = crypto.randomUUID(); const now = Date.now(); const email = input.email ?? `${guestId}@guest-15b.test`;
  if (!input.guestId) await database.DB.prepare("INSERT INTO guest_reviewers (id, email_normalized, display_name, created_at) VALUES (?, ?, 'Gina Guest', ?)").bind(guestId, email, now).run();
  await database.DB.prepare("INSERT INTO guest_link_members (id, link_id, guest_id, first_verified_at, last_verified_at, last_seen_at, unsubscribed_at, last_digest_sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(memberId, linkId, guestId, now, now, now, input.unsubscribed ? now : null, input.lastDigestSentAt ?? null).run();
  return { guestId, memberId, email };
}
async function seedNote(version: Version, input: { visibility?: "public" | "internal"; parentId?: string; body?: string; guestAuthor?: string; deleted?: boolean; startFrame?: number } = {}) {
  const id = crypto.randomUUID(); const reply = input.parentId !== undefined; const guest = input.guestAuthor ?? null;
  await database.DB.prepare("INSERT INTO video_notes (id, project_id, video_id, asset_id, parent_id, author_user_id, author_guest_id, author_role, visibility, start_frame, end_frame, drawing_frame, body, resolved_at, resolved_by, revision, deleted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, 1, ?, ?)")
    .bind(id, ids.project, version.videoId, version.assetId, input.parentId ?? null, guest ? null : ids.user, guest, guest ? "guest" : "editor", guest ? "public" : input.visibility ?? "public", reply ? null : input.startFrame ?? 1804, input.body ?? "Please trim the intro", input.deleted ? Date.now() : null, Date.now()).run();
  return id;
}
async function release(version: Version, withdrawn = false) {
  const approval = crypto.randomUUID();
  await database.DB.prepare("INSERT INTO video_approval_events (id, project_id, video_id, asset_id, link_id, revision, decision, note, actor_guest_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, NULL, 1, 'approved', NULL, NULL, ?, ?)").bind(approval, ids.project, version.videoId, version.assetId, ids.user, Date.now()).run();
  await database.DB.prepare("INSERT INTO video_releases (id, project_id, video_id, asset_id, approval_event_id, approval_revision, released_by, released_at, withdrawn_at, withdrawn_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), ids.project, version.videoId, version.assetId, approval, ids.user, Date.now(), withdrawn ? Date.now() : null, withdrawn ? ids.user : null).run();
}
type EventType = "video_added" | "version_granted" | "public_note" | "staff_reply" | "video_released";
async function pend(member: { guestId: string }, linkId: string, event: EventType, version: Version, noteId: string | null = null, createdAt = T0 - HOUR / 2) {
  const id = crypto.randomUUID();
  await database.DB.prepare("INSERT INTO guest_notification_digest (id, guest_id, link_id, event_type, video_id, asset_id, note_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, member.guestId, linkId, event, version.videoId, event === "video_added" ? null : version.assetId, noteId, createdAt).run();
  return id;
}
const rowOf = (id: string) => database.DB.prepare("SELECT sent_at FROM guest_notification_digest WHERE id = ?").bind(id).first<{ sent_at: number | null }>();
const lastDigest = async (memberId: string) => (await database.DB.prepare("SELECT last_digest_sent_at FROM guest_link_members WHERE id = ?").bind(memberId).first<{ last_digest_sent_at: number | null }>())!.last_digest_sent_at;
const tokens = async (memberId: string) => (await database.DB.prepare("SELECT token_hash, created_at FROM guest_unsubscribe_tokens WHERE member_id = ?").bind(memberId).all<{ token_hash: string; created_at: number }>()).results;
const everything = (message: Sent) => JSON.stringify(message);
const urlOf = (message: Sent) => /https:\/\/portal\.test\/d\/unsubscribe#t=[A-Za-z0-9_-]+/.exec(message.text ?? "")?.[0] ?? null;
async function sha256Hex(value: string) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

/** One subscribed guest on a live link with one Video, ready for rows. */
async function basic(input: { label?: string | null } = {}) {
  const [version] = await seedVideo("Kitchen walkthrough"); const link = await seedLink(input); await onLink(link.id, [version!]); const member = await seedMember(link.id);
  return { version: version!, link, member };
}

describe("one email an hour", () => {
  it("several events in the hour make ONE email grouped by Video, mark every row sent, and a second flush within the hour sends nothing", async () => {
    const { version, link, member } = await basic(); const second = (await seedVideo("Garden tour"))[0]!; await onLink(link.id, [second]);
    const note = await seedNote(version);
    await release(version);
    const rows = [await pend(member, link.id, "video_added", second), await pend(member, link.id, "version_granted", version), await pend(member, link.id, "public_note", version, note), await pend(member, link.id, "video_released", version)];
    const mail = mailer();
    const summary = await runAt(mail.env, T0);
    expect(mail.sent).toHaveLength(1); expect(summary.sent).toBe(1);
    const [message] = mail.sent;
    expect(message).toMatchObject({ from: SENDER, to: member.email, subject: "Updates on Smith family" });
    expect(message!.text).toContain("Kitchen walkthrough"); expect(message!.text).toContain("Garden tour");
    expect(message!.text).toMatch(/New video added/); expect(message!.text).toMatch(/Version 1 is ready to review/); expect(message!.text).toMatch(/Released and ready to download/);
    expect(message!.text).toContain("The studio left a note at 00:01:12:04: “Please trim the intro”");
    for (const id of rows) expect((await rowOf(id))!.sent_at).not.toBeNull();
    expect(await lastDigest(member.memberId)).toBe(T0);
    // A new event 10 minutes later waits for the hour; the next hour sends it.
    const later = await pend(member, link.id, "version_granted", version, null, T0 + 600_000);
    await runAt(mail.env, T0 + 10 * 60_000); expect(mail.sent).toHaveLength(1); expect((await rowOf(later))!.sent_at).toBeNull();
    await runAt(mail.env, T0 + HOUR); expect(mail.sent).toHaveLength(2); expect((await rowOf(later))!.sent_at).not.toBeNull();
  });

  it("claims a member once: two flushes racing send one email", async () => {
    const { version, link, member } = await basic(); await pend(member, link.id, "version_granted", version);
    const mail = mailer();
    await Promise.all([runGuestDigests(mail.env, T0), runGuestDigests(mail.env, T0)]);
    expect(mail.sent).toHaveLength(1);
  });

  it("one email per membership: two guests get their own, and one guest on two links gets one per link with that link's own unsubscribe", async () => {
    const { version, link, member } = await basic(); const other = await seedMember(link.id);
    const second = await seedLink({ label: "Jones family" }); await onLink(second.id, [version]); const same = await seedMember(second.id, { guestId: member.guestId });
    for (const [who, linkId] of [[member, link.id], [other, link.id], [same, second.id]] as const) await pend(who, linkId, "version_granted", version);
    const mail = mailer(); await runAt(mail.env, T0);
    expect(mail.sent).toHaveLength(3);
    expect(mail.sent.map((message) => message.subject).sort()).toEqual(["Updates on Jones family", "Updates on Smith family", "Updates on Smith family"]);
    expect(new Set(mail.sent.map(urlOf)).size).toBe(3);
  });

  it("falls back to 'your video review' when the link has no label", async () => {
    const { version, link, member } = await basic({ label: null }); await pend(member, link.id, "version_granted", version);
    const mail = mailer(); await runAt(mail.env, T0);
    expect(mail.sent[0]!.subject).toBe("Updates on your video review");
  });
});

describe("re-filtering at send time", () => {
  const drops: Array<[string, (t: Awaited<ReturnType<typeof basic>>) => Promise<unknown>]> = [
    ["Video removed", (t) => database.DB.prepare("UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE link_id = ?").bind(Date.now(), ids.user, t.link.id).run()],
    ["link revoked", (t) => database.DB.prepare("UPDATE client_links SET revoked_at = ?, revoked_by = ? WHERE id = ?").bind(Date.now(), ids.user, t.link.id).run()],
    ["link expired", (t) => database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(T0 - 1, t.link.id).run()],
    ["grant revoked", (t) => database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE link_id = ?").bind(Date.now(), ids.user, t.link.id).run()],
    ["member unsubscribed", (t) => database.DB.prepare("UPDATE guest_link_members SET unsubscribed_at = ? WHERE id = ?").bind(Date.now(), t.member.memberId).run()],
    ["notify_client off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_notify_client'").run()],
    ["guest part off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_guest'").run()],
    ["master flag off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review'").run()],
    ["Project out of scope", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_all_projects'").run()],
  ];
  for (const [label, change] of drops) {
    it(`drops the item, sends nothing and marks the rows sent when: ${label}`, async () => {
      const t = await basic(); const id = await pend(t.member, t.link.id, "version_granted", t.version); await change(t);
      const mail = mailer(); const summary = await runAt(mail.env, T0);
      expect(mail.sent, label).toHaveLength(0); expect(summary.sent).toBe(0);
      expect((await rowOf(id))!.sent_at, label).not.toBeNull();
    });
  }

  it("drops a deleted note, a released Version whose Release was withdrawn, and a video_added whose Video lost every grant; keeps the rest", async () => {
    const t = await basic(); const gone = await seedNote(t.version, { deleted: true }); const kept = await seedNote(t.version, { body: "Keep this one" });
    await release(t.version, true);
    await pend(t.member, t.link.id, "public_note", t.version, gone); await pend(t.member, t.link.id, "video_released", t.version); await pend(t.member, t.link.id, "public_note", t.version, kept);
    const mail = mailer(); await runAt(mail.env, T0);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.text).toContain("Keep this one"); expect(mail.sent[0]!.text).not.toContain("Released and ready"); expect(mail.sent[0]!.text).not.toContain("Please trim the intro");
  });

  describe("Trash (#776): a removed Video or Version is never emailed", () => {
    const removeVersion = (assetId: string) => database.DB.prepare("UPDATE video_version_meta SET removed_at = ? WHERE asset_id = ?").bind(Date.now(), assetId).run();
    const removeVideo = (videoId: string) => database.DB.prepare("UPDATE videos SET removed_at = ? WHERE id = ?").bind(Date.now(), videoId).run();

    for (const event of ["version_granted", "public_note"] as const) {
      it(`a ${event} item whose Version was removed before the flush is not emailed and its row ends marked`, async () => {
        const t = await basic(); const note = event === "public_note" ? await seedNote(t.version) : null;
        const removedId = await pend(t.member, t.link.id, event, t.version, note);
        const second = await seedVideo("Garden tour"); await onLink(t.link.id, [second[0]!]);
        const liveId = await pend(t.member, t.link.id, "version_granted", second[0]!);
        await removeVersion(t.version.assetId);
        const mail = mailer(); await runAt(mail.env, T0);
        expect(mail.sent).toHaveLength(1);
        expect(mail.sent[0]!.text).toContain("Garden tour"); expect(mail.sent[0]!.text).not.toContain("Kitchen walkthrough");
        expect((await rowOf(removedId))!.sent_at).not.toBeNull(); expect((await rowOf(liveId))!.sent_at).not.toBeNull();
      });
    }

    it("a video_added item whose Video was removed is not emailed", async () => {
      const t = await basic(); const removedId = await pend(t.member, t.link.id, "video_added", t.version);
      const second = await seedVideo("Garden tour"); await onLink(t.link.id, [second[0]!]);
      await pend(t.member, t.link.id, "video_added", second[0]!);
      await removeVideo(t.version.videoId);
      const mail = mailer(); await runAt(mail.env, T0);
      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]!.text).toContain("Garden tour"); expect(mail.sent[0]!.text).not.toContain("Kitchen walkthrough");
      expect((await rowOf(removedId))!.sent_at).not.toBeNull();
    });

    it("a video_added item is not emailed when the only granted Version was removed, even though an ungranted Version is live", async () => {
      const [v1, v2] = await seedVideo("Kitchen walkthrough", 2); const link = await seedLink(); await onLink(link.id, [v1!, v2!], [v1!]); const member = await seedMember(link.id);
      const removedId = await pend(member, link.id, "video_added", v1!);
      await removeVersion(v1!.assetId);
      const mail = mailer(); await runAt(mail.env, T0);
      expect(mail.sent).toHaveLength(0);
      expect((await rowOf(removedId))!.sent_at).not.toBeNull();
    });

    for (const [label, remove] of [["Version", (t: Awaited<ReturnType<typeof basic>>) => removeVersion(t.version.assetId)], ["Video", (t: Awaited<ReturnType<typeof basic>>) => removeVideo(t.version.videoId)]] as const) {
      it(`when every item's ${label} is removed, no email is sent, the rows are marked and the slot is given back`, async () => {
        const t = await basic(); const ids2 = [await pend(t.member, t.link.id, label === "Video" ? "video_added" : "public_note", t.version, label === "Video" ? null : await seedNote(t.version)), await pend(t.member, t.link.id, "version_granted", t.version)];
        await remove(t);
        const mail = mailer(); const summary = await runAt(mail.env, T0);
        expect(mail.sent).toHaveLength(0); expect(summary.sent).toBe(0);
        for (const id of ids2) expect((await rowOf(id))!.sent_at).not.toBeNull();
        expect(await lastDigest(t.member.memberId)).toBeNull();
      });
    }
  });

  it("a Release on a link with downloads off is dropped", async () => {
    const [version] = await seedVideo("Final"); const link = await seedLink({ allowDownload: 0 }); await onLink(link.id, [version!]); const member = await seedMember(link.id);
    await release(version!);
    await pend(member, link.id, "video_released", version!);
    const mail = mailer(); await runAt(mail.env, T0); expect(mail.sent).toHaveLength(0);
  });
});

describe("what an email may contain", () => {
  it("never carries internal text: an internal note, a reply under an internal root and an internal reply are dropped, and the sentinel is in no field of any email", async () => {
    const t = await basic();
    const internal = await seedNote(t.version, { visibility: "internal", body: `${SENTINEL} note` });
    const underInternal = await seedNote(t.version, { parentId: internal, body: `${SENTINEL} reply under internal` });
    const publicRoot = await seedNote(t.version, { body: "Public root", guestAuthor: t.member.guestId });
    const internalReply = await seedNote(t.version, { parentId: publicRoot, visibility: "internal", body: `${SENTINEL} internal reply` });
    const goodReply = await seedNote(t.version, { parentId: publicRoot, body: "Studio public reply" });
    await pend(t.member, t.link.id, "public_note", t.version, internal); await pend(t.member, t.link.id, "staff_reply", t.version, underInternal);
    await pend(t.member, t.link.id, "staff_reply", t.version, internalReply); await pend(t.member, t.link.id, "staff_reply", t.version, goodReply);
    const mail = mailer(); await runAt(mail.env, T0);
    expect(mail.sent).toHaveLength(1); expect(mail.sent[0]!.text).toContain("The studio replied to your note: “Studio public reply”");
    expect(everything(mail.sent[0]!)).not.toContain(SENTINEL);
    // Only internal rows pending: no email at all.
    await wipe(); await openGate(); const only = await basic(); const hidden = await seedNote(only.version, { visibility: "internal", body: SENTINEL });
    await pend(only.member, only.link.id, "public_note", only.version, hidden);
    const quiet = mailer(); await runAt(quiet.env, T0); expect(quiet.sent).toHaveLength(0);
  });

  it("carries no Review link token and no link id: the only URL is the unsubscribe URL, the token only in the fragment, and List-Unsubscribe names the same URL", async () => {
    const t = await basic(); await pend(t.member, t.link.id, "version_granted", t.version);
    const mail = mailer(); await runAt(mail.env, T0);
    const [message] = mail.sent; const url = urlOf(message!)!;
    expect(url).toMatch(/^https:\/\/portal\.test\/d\/unsubscribe#t=[A-Za-z0-9_-]{43}$/);
    const token = url.split("#t=")[1]!;
    const blob = everything(message!);
    expect(blob).not.toContain(t.link.token); expect(blob).not.toContain(t.link.id); expect(blob).not.toContain("/d/review"); expect(blob).not.toContain("#t=" + t.link.token);
    // every URL in the email is the unsubscribe URL, and none has a query string
    const urls = blob.match(/https?:\/\/[^\s"'<>\\)]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0); for (const found of urls) { expect(found.startsWith("https://portal.test/d/unsubscribe#t=")).toBe(true); expect(found).not.toContain("?"); }
    expect(message!.headers).toEqual({ "List-Unsubscribe": `<${url}>` });
    expect(message!.text).toContain("Open the review link the studio sent you to see these. For your security this email doesn't include it.");
    // only the hash is stored, against this membership
    const stored = await tokens(t.member.memberId);
    expect(stored).toHaveLength(1); expect(stored[0]!.token_hash).toBe(await sha256Hex(token)); expect(stored[0]!.token_hash).not.toBe(token); expect(stored[0]!.created_at).toBe(T0);
    expect(JSON.stringify(await database.DB.prepare("SELECT * FROM guest_unsubscribe_tokens").all())).not.toContain(token);
  });

  it("mints a fresh token for every email, and every one of them stays valid", async () => {
    const t = await basic(); const mail = mailer();
    await pend(t.member, t.link.id, "version_granted", t.version); await runAt(mail.env, T0);
    await pend(t.member, t.link.id, "version_granted", t.version, null, T0 + 1); await runAt(mail.env, T0 + HOUR);
    const [first, second] = mail.sent.map(urlOf);
    expect(first).not.toBe(second);
    const stored = (await tokens(t.member.memberId)).map((row) => row.token_hash).sort();
    expect(stored).toEqual([await sha256Hex(first!.split("#t=")[1]!), await sha256Hex(second!.split("#t=")[1]!)].sort());
  });

  it("caps an email at 50 items, an excerpt at 280 characters, and marks every pending row sent", async () => {
    const t = await basic(); const long = `${"word ".repeat(300)}END`; const note = await seedNote(t.version, { body: long });
    const ids60: string[] = [];
    ids60.push(await pend(t.member, t.link.id, "public_note", t.version, note));
    for (let index = 0; index < 59; index += 1) ids60.push(await pend(t.member, t.link.id, "version_granted", t.version));
    const mail = mailer(); await runAt(mail.env, T0);
    const text = mail.sent[0]!.text!;
    const lines = text.split("\n").filter((line) => line.startsWith("- "));
    expect(lines.length).toBeLessThanOrEqual(50); expect(text).toMatch(/and \d+ more/);
    const excerpt = /“([^”]*)”/.exec(text)?.[1];
    expect(excerpt).toBeDefined(); expect(Array.from(excerpt!).length).toBeLessThanOrEqual(280);
    for (const id of ids60) expect((await rowOf(id))!.sent_at).not.toBeNull();
  });

  it("trims a note excerpt to 280 characters, ending in an ellipsis", async () => {
    const t = await basic(); const note = await seedNote(t.version, { body: `${"x".repeat(900)} END` }); await pend(t.member, t.link.id, "public_note", t.version, note);
    const mail = mailer(); await runAt(mail.env, T0);
    const excerpt = /“([^”]*)”/.exec(mail.sent[0]!.text!)![1]!;
    expect(Array.from(excerpt).length).toBeLessThanOrEqual(280); expect(excerpt.endsWith("…")).toBe(true); expect(mail.sent[0]!.text).not.toContain("END");
  });

  it("escapes staff text in the HTML part, and keeps a label out of the subject's line breaks", async () => {
    const t = await basic({ label: "Smith\r\nBcc: evil@example.test <b>" }); const note = await seedNote(t.version, { body: `<script>alert("x")</script> & more` }); await pend(t.member, t.link.id, "public_note", t.version, note);
    const mail = mailer(); await runAt(mail.env, T0);
    const [message] = mail.sent;
    expect(message!.html).not.toContain("<script>"); expect(message!.html).toContain("&lt;script&gt;"); expect(message!.html).toContain("&amp; more");
    expect(message!.subject).not.toMatch(/[\r\n]/);
  });

  it("names a Version with its number and a note without a start frame without a timecode", async () => {
    const versions = await seedVideo("Cut", 3); const link = await seedLink(); await onLink(link.id, versions); const member = await seedMember(link.id);
    await pend(member, link.id, "version_granted", versions[2]!);
    const mail = mailer(); await runAt(mail.env, T0);
    expect(mail.sent[0]!.text).toContain("Version 3 is ready to review");
  });
});

describe("sending", () => {
  it("an ambiguous send (the call throws) counts as sent and is never resent: rows are marked and the slot is spent", async () => {
    const t = await basic(); const id = await pend(t.member, t.link.id, "version_granted", t.version);
    const failing = mailer({ fail: new Error("socket closed after write") });
    const summary = await runAt(failing.env, T0);
    expect(failing.send).toHaveBeenCalledTimes(1); expect(summary.sent).toBe(1);
    expect((await rowOf(id))!.sent_at).not.toBeNull(); expect(await lastDigest(t.member.memberId)).toBe(T0);
    const healthy = mailer(); await runAt(healthy.env, T0 + HOUR); await runAt(healthy.env, T0 + 2 * HOUR);
    expect(healthy.sent).toHaveLength(0);
  });

  it("logs no address from a failed send: only a whitelisted Email Service code, else send_failed", async () => {
    const LEAK = "leak-sentinel@example.com";
    const CODES = ["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_DELIVERY_FAILED", "E_INVALID_FROM", "E_INVALID_TO", "E_INVALID_EMAIL", "E_DOMAIN_NOT_VERIFIED", "E_SENDER_NOT_ALLOWED", "E_RECIPIENT_SUPPRESSED", "E_MESSAGE_TOO_LARGE", "E_INVALID_HEADERS"];
    for (const [thrown, expected] of [
      [new Error(`recipient ${LEAK} rejected`), "send_failed"],
      [Object.assign(new Error(`recipient ${LEAK} rejected`), { code: "E_RECIPIENT_SUPPRESSED" }), "E_RECIPIENT_SUPPRESSED"],
      [Object.assign(new Error(`recipient ${LEAK} rejected`), { code: LEAK }), "send_failed"],
    ] as const) {
      const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
      try {
        const t = await basic(); await pend(t.member, t.link.id, "version_granted", t.version);
        await runAt(mailer({ fail: thrown }).env, T0);
        const logged = spies.flatMap((spy) => spy.mock.calls);
        expect(logged.length).toBeGreaterThan(0);
        expect(JSON.stringify(logged)).not.toContain(LEAK);
        const code = (logged.flat().find((arg) => typeof arg === "object" && arg !== null && "code" in arg) as { code: string } | undefined)?.code;
        expect(code).toBe(expected); expect([...CODES, "send_failed"]).toContain(code);
      } finally { spies.forEach((spy) => spy.mockRestore()); }
    }
  });

  it("a send that throws does not stop the other members", async () => {
    const t = await basic(); const other = await seedMember(t.link.id); await pend(t.member, t.link.id, "version_granted", t.version); await pend(other, t.link.id, "version_granted", t.version);
    let calls = 0; const sent: Sent[] = [];
    const flaky = { DB: database.DB, APP_ORIGIN: ORIGIN, NOTIFICATIONS_FROM_ADDRESS: SENDER, EMAIL: { send: async (message: Sent) => { calls += 1; if (calls === 1) throw new Error("boom"); sent.push(message); return { messageId: "m" }; } } } as unknown as Env;
    await runAt(flaky, T0);
    expect(calls).toBe(2); expect(sent).toHaveLength(1);
  });

  it("does nothing, and spends no slot, when the EMAIL binding or the sender address is missing", async () => {
    const t = await basic(); const id = await pend(t.member, t.link.id, "version_granted", t.version);
    await runAt({ DB: database.DB, APP_ORIGIN: ORIGIN } as unknown as Env, T0);
    expect((await rowOf(id))!.sent_at).toBeNull(); expect(await lastDigest(t.member.memberId)).toBeNull();
    const mail = mailer(); await runAt(mail.env, T0); expect(mail.sent).toHaveLength(1);
  });

  it("a member inside the 55 minute window is not touched; one past it is", async () => {
    const t = await basic(); const id = await pend(t.member, t.link.id, "version_granted", t.version);
    await database.DB.prepare("UPDATE guest_link_members SET last_digest_sent_at = ? WHERE id = ?").bind(T0 - 54 * 60_000, t.member.memberId).run();
    const mail = mailer(); await runAt(mail.env, T0);
    expect(mail.sent).toHaveLength(0); expect((await rowOf(id))!.sent_at).toBeNull(); expect(await lastDigest(t.member.memberId)).toBe(T0 - 54 * 60_000);
    await runAt(mail.env, T0 + 2 * 60_000); expect(mail.sent).toHaveLength(1);
  });

  it("a row that arrives while the email is being sent stays pending for the next hour", async () => {
    const t = await basic(); await pend(t.member, t.link.id, "version_granted", t.version); let late = "";
    const sent: Sent[] = [];
    const slow = { DB: database.DB, APP_ORIGIN: ORIGIN, NOTIFICATIONS_FROM_ADDRESS: SENDER, EMAIL: { send: async (message: Sent) => { late = await pend(t.member, t.link.id, "public_note", t.version, await seedNote(t.version), T0 + 5); sent.push(message); return { messageId: "m" }; } } } as unknown as Env;
    await runAt(slow, T0);
    expect((await rowOf(late))!.sent_at).toBeNull();
    const mail = mailer(); await runAt(mail.env, T0 + HOUR); expect(mail.sent).toHaveLength(1);
  });
});

describe("the cooldown clock restarts when the send completes (#741 15b)", () => {
  const MIN = 60_000;
  /** A mailer whose send resolves only after the clock has advanced to `completeAt`, optionally running `during` first. */
  function slowMailer(completeAt: number, during?: () => Promise<unknown>, db: unknown = database.DB) {
    const sent: Sent[] = [];
    const send = vi.fn(async (message: Sent) => { if (during) await during(); vi.setSystemTime(completeAt); sent.push(message); return { messageId: "m" }; });
    return { sent, send, env: { DB: db, APP_ORIGIN: ORIGIN, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: SENDER } as unknown as Env };
  }

  it("an ambiguous send that throws minutes after the stamp also moves the slot to the completion time, and its rows stay marked", async () => {
    const t = await basic(); const id = await pend(t.member, t.link.id, "version_granted", t.version);
    const send = vi.fn(async () => { vi.setSystemTime(T0 + 6 * MIN); throw new Error("socket closed"); });
    await runAt({ DB: database.DB, APP_ORIGIN: ORIGIN, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: SENDER } as unknown as Env, T0);
    expect((await rowOf(id))!.sent_at).not.toBeNull();
    expect(await lastDigest(t.member.memberId)).toBe(T0 + 6 * MIN);
  });

  it("a send that completes minutes after the stamp moves the slot to the completion time, so the next flush waits 55 minutes from the real send", async () => {
    const t = await basic(); await pend(t.member, t.link.id, "version_granted", t.version);
    await runAt(slowMailer(T0 + 6 * MIN).env, T0);
    expect(await lastDigest(t.member.memberId)).toBe(T0 + 6 * MIN);
    const mail = mailer();
    await pend(t.member, t.link.id, "version_granted", t.version, null, T0 + 7 * MIN);
    await runAt(mail.env, T0 + HOUR); expect(mail.sent).toHaveLength(0);
    await runAt(mail.env, T0 + 6 * MIN + 55 * MIN); expect(mail.sent).toHaveLength(1);
  });

  it("does not overwrite the slot when it no longer holds this run's stamp", async () => {
    const t = await basic(); const id = await pend(t.member, t.link.id, "version_granted", t.version);
    const other = T0 + 2 * MIN;
    await runAt(slowMailer(T0 + 6 * MIN, () => database.DB.prepare("UPDATE guest_link_members SET last_digest_sent_at = ? WHERE id = ?").bind(other, t.member.memberId).run()).env, T0);
    expect(await lastDigest(t.member.memberId)).toBe(other);
    expect((await rowOf(id))!.sent_at).toBe(T0);
  });

  it("a failing post-send stamp keeps the rows marked and the pre-send stamp, and logs no address", async () => {
    const t = await basic(); const id = await pend(t.member, t.link.id, "version_granted", t.version);
    const real = database.DB; let sendDone = false;
    const db = { prepare(sql: string) { if (sendDone) throw new Error(`boom ${t.member.email}`); return real.prepare(sql); }, batch: (s: D1PreparedStatement[]) => real.batch(s) };
    const mail = slowMailer(T0 + 6 * MIN, async () => { sendDone = true; }, db);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const summary = await runAt(mail.env, T0);
      expect(summary.sent).toBe(1); expect(summary.failed).toBe(0);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(t.member.email);
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    expect((await rowOf(id))!.sent_at).toBe(T0); expect(await lastDigest(t.member.memberId)).toBe(T0);
  });
});

/** A D1 wrapper for the ordering cases: `afterTokenInsert` runs right after the unsubscribe token INSERT (the last setup write before the send); `failAfterSend` makes every database call throw once `send` has been called. */
function hooked(options: { afterTokenInsert?: () => Promise<unknown>; failAfterSend?: boolean } = {}) {
  const sent: Sent[] = []; let sendCalled = false;
  const real = database.DB;
  const db = {
    prepare(sql: string) {
      if (sendCalled && options.failAfterSend) throw new Error("database unavailable after send");
      const statement = real.prepare(sql);
      if (!options.afterTokenInsert || !sql.includes("INSERT INTO guest_unsubscribe_tokens")) return statement;
      return { bind: (...values: unknown[]) => { const bound = statement.bind(...values); return { run: async () => { const result = await bound.run(); await options.afterTokenInsert!(); return result; } }; } };
    },
    batch(statements: D1PreparedStatement[]) { if (sendCalled && options.failAfterSend) throw new Error("database unavailable after send"); return real.batch(statements); },
  };
  const send = vi.fn(async (message: Sent) => { sendCalled = true; sent.push(message); return { messageId: "m" }; });
  return { sent, send, env: { DB: db, APP_ORIGIN: ORIGIN, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: SENDER } as unknown as Env };
}

describe("at most once, authorized at the last moment", () => {
  it("a database failure AFTER the send never causes a resend: the rows were fenced before the send", async () => {
    const t = await basic(); const id = await pend(t.member, t.link.id, "version_granted", t.version);
    const broken = hooked({ failAfterSend: true });
    await runAt(broken.env, T0);
    expect(broken.send).toHaveBeenCalledTimes(1);
    expect((await rowOf(id))!.sent_at).not.toBeNull(); expect(await lastDigest(t.member.memberId)).toBe(T0);
    const healthy = mailer(); await runAt(healthy.env, T0 + HOUR); await runAt(healthy.env, T0 + 2 * HOUR);
    expect(healthy.sent).toHaveLength(0);
  });

  it("a send that throws leaves the rows marked, and the next flushes send nothing for them", async () => {
    const t = await basic(); const ids2 = [await pend(t.member, t.link.id, "version_granted", t.version), await pend(t.member, t.link.id, "video_added", t.version)];
    const failing = mailer({ fail: "definite failure" });
    await runAt(failing.env, T0);
    for (const id of ids2) expect((await rowOf(id))!.sent_at).toBe(T0);
    const healthy = mailer(); await runAt(healthy.env, T0 + HOUR); expect(healthy.sent).toHaveLength(0);
  });

  it("a member who unsubscribes after the token is minted but before the send gets nothing", async () => {
    const t = await basic(); const id = await pend(t.member, t.link.id, "version_granted", t.version);
    const mail = hooked({ afterTokenInsert: () => database.DB.prepare("UPDATE guest_link_members SET unsubscribed_at = ? WHERE id = ?").bind(Date.now(), t.member.memberId).run() });
    const summary = await runAt(mail.env, T0);
    expect(mail.send).not.toHaveBeenCalled(); expect(summary.sent).toBe(0);
    expect((await rowOf(id))!.sent_at).not.toBeNull();
  });

  it("a link revoked after the token is minted but before the send gets nothing", async () => {
    const t = await basic(); await pend(t.member, t.link.id, "version_granted", t.version);
    const mail = hooked({ afterTokenInsert: () => database.DB.prepare("UPDATE client_links SET revoked_at = ?, revoked_by = ? WHERE id = ?").bind(Date.now(), ids.user, t.link.id).run() });
    await runAt(mail.env, T0);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("only the rows that pass the last-moment check are emailed and marked; a row that fails it is dropped", async () => {
    const t = await basic(); const note = await seedNote(t.version, { body: "Soon deleted" });
    const kept = await pend(t.member, t.link.id, "version_granted", t.version); const dropped = await pend(t.member, t.link.id, "public_note", t.version, note);
    const mail = hooked({ afterTokenInsert: () => database.DB.prepare("UPDATE video_notes SET deleted_at = ? WHERE id = ?").bind(Date.now(), note).run() });
    await runAt(mail.env, T0);
    expect(mail.sent).toHaveLength(1); expect(mail.sent[0]!.text).not.toContain("Soon deleted"); expect(mail.sent[0]!.text).toContain("Version 1 is ready to review");
    expect((await rowOf(kept))!.sent_at).toBe(T0); expect((await rowOf(dropped))!.sent_at).toBe(T0);
  });

  it("expiry is judged at the real current time: a link that expires after the cron's scheduled time but before the member is processed gets no email", async () => {
    const [version] = await seedVideo("Late"); const link = await seedLink({ expiresAt: T0 + 1_000 }); await onLink(link.id, [version!]); const member = await seedMember(link.id);
    const id = await pend(member, link.id, "version_granted", version!);
    vi.setSystemTime(T0 + 2_000);
    const mail = mailer(); await runGuestDigests(mail.env, T0);
    expect(mail.sent).toHaveLength(0); expect((await rowOf(id))!.sent_at).toBe(T0 + 2_000);
  });
});

const rejection = (code: string) => Object.assign(new Error("rejected for leak@example.com"), { code });

describe("a proven rejection is released for retry (#741 15b)", () => {
  it("a rate-limit rejection returns the rows to pending and the slot to the member, and the next run sends them", async () => {
    const t = await basic(); const ids2 = [await pend(t.member, t.link.id, "version_granted", t.version), await pend(t.member, t.link.id, "video_added", t.version)];
    const limited = mailer({ fail: rejection("E_RATE_LIMIT_EXCEEDED") });
    await runAt(limited.env, T0);
    expect(limited.send).toHaveBeenCalledTimes(1);
    for (const id of ids2) expect((await rowOf(id))!.sent_at).toBeNull();
    expect(await lastDigest(t.member.memberId)).toBeNull();
    const healthy = mailer(); await runAt(healthy.env, T0 + HOUR);
    expect(healthy.sent).toHaveLength(1);
    for (const id of ids2) expect((await rowOf(id))!.sent_at).toBe(T0 + HOUR);
  });

  it("restores the member's PRIOR slot value, not null", async () => {
    const t = await basic(); const id = await pend(t.member, t.link.id, "version_granted", t.version);
    const prior = T0 - 3 * HOUR;
    await database.DB.prepare("UPDATE guest_link_members SET last_digest_sent_at = ? WHERE id = ?").bind(prior, t.member.memberId).run();
    await runAt(mailer({ fail: rejection("E_INVALID_FROM") }).env, T0);
    expect((await rowOf(id))!.sent_at).toBeNull(); expect(await lastDigest(t.member.memberId)).toBe(prior);
  });

  it("a rejection that would repeat on every retry (recipient or message specific) stays marked sent", async () => {
    for (const code of ["E_RECIPIENT_SUPPRESSED", "E_INVALID_TO", "E_INVALID_EMAIL", "E_MESSAGE_TOO_LARGE", "E_INVALID_HEADERS"]) {
      const t = await basic(); const id = await pend(t.member, t.link.id, "version_granted", t.version);
      await runAt(mailer({ fail: rejection(code) }).env, T0);
      expect((await rowOf(id))!.sent_at, code).toBe(T0); expect(await lastDigest(t.member.memberId), code).toBe(T0);
    }
  });

  it("an ambiguous outcome stays marked sent: no code, an unknown code, E_DELIVERY_FAILED", async () => {
    for (const fail of [new Error("socket closed"), "timeout", rejection("E_SOMETHING_NEW"), rejection("E_DELIVERY_FAILED")]) {
      const t = await basic(); const id = await pend(t.member, t.link.id, "version_granted", t.version);
      await runAt(mailer({ fail }).env, T0);
      expect((await rowOf(id))!.sent_at, String(fail)).toBe(T0); expect(await lastDigest(t.member.memberId)).toBe(T0);
      const healthy = mailer(); await runAt(healthy.env, T0 + HOUR); expect(healthy.sent).toHaveLength(0);
    }
  });

  it("a release only touches this run's rows: earlier-sent rows, rows dropped by the re-filter, rows another run re-marked, and other members stay as they were", async () => {
    const t = await basic(); const other = await seedMember(t.link.id);
    const note = await seedNote(t.version, { deleted: true });
    const mine1 = await pend(t.member, t.link.id, "version_granted", t.version);
    const mine2 = await pend(t.member, t.link.id, "video_added", t.version);
    const remarked = await pend(t.member, t.link.id, "version_granted", t.version);
    const dropped = await pend(t.member, t.link.id, "public_note", t.version, note);
    const old = await pend(t.member, t.link.id, "version_granted", t.version, null, T0 - 2 * HOUR);
    await database.DB.prepare("UPDATE guest_notification_digest SET sent_at = ? WHERE id = ?").bind(T0 - HOUR, old).run();
    const theirs = await pend(other, t.link.id, "version_granted", t.version);
    await database.DB.prepare("UPDATE guest_link_members SET last_digest_sent_at = ? WHERE id = ?").bind(T0 - 2 * HOUR, other.memberId).run();
    // The send is rejected, but meanwhile another writer re-marks one of this run's rows (and the other member's slot is spent by a run of its own).
    const racing = {
      DB: database.DB, APP_ORIGIN: ORIGIN, NOTIFICATIONS_FROM_ADDRESS: SENDER,
      EMAIL: { send: async () => { await database.DB.prepare("UPDATE guest_notification_digest SET sent_at = ? WHERE id = ?").bind(T0 + 7, remarked).run(); throw rejection("E_RATE_LIMIT_EXCEEDED"); } },
    } as unknown as Env;
    await runAt(racing, T0);
    expect((await rowOf(mine1))!.sent_at).toBeNull(); expect((await rowOf(mine2))!.sent_at).toBeNull();
    expect((await rowOf(remarked))!.sent_at).toBe(T0 + 7);
    expect((await rowOf(dropped))!.sent_at).toBe(T0);
    expect((await rowOf(old))!.sent_at).toBe(T0 - HOUR);
    expect(await lastDigest(t.member.memberId)).toBeNull();
    // The other member was flushed by the same run, with its own rejected send: released too, with its own prior slot.
    expect((await rowOf(theirs))!.sent_at).toBeNull(); expect(await lastDigest(other.memberId)).toBe(T0 - 2 * HOUR);
  });

  it("the slot is restored only while it still holds this run's value", async () => {
    const t = await basic(); const id = await pend(t.member, t.link.id, "version_granted", t.version);
    const racing = {
      DB: database.DB, APP_ORIGIN: ORIGIN, NOTIFICATIONS_FROM_ADDRESS: SENDER,
      EMAIL: { send: async () => { await database.DB.prepare("UPDATE guest_link_members SET last_digest_sent_at = ? WHERE id = ?").bind(T0 + 99, t.member.memberId).run(); throw rejection("E_RATE_LIMIT_EXCEEDED"); } },
    } as unknown as Env;
    await runAt(racing, T0);
    expect((await rowOf(id))!.sent_at).toBeNull(); expect(await lastDigest(t.member.memberId)).toBe(T0 + 99);
  });

  it("a fence whose commit lands but whose reply is lost releases the rows, since nothing was sent", async () => {
    const t = await basic(); const id = await pend(t.member, t.link.id, "version_granted", t.version);
    const real = database.DB; let batches = 0;
    const db = { prepare: (sql: string) => real.prepare(sql), batch: async (statements: D1PreparedStatement[]) => { const result = await real.batch(statements); batches += 1; if (batches === 1) throw new Error("network lost"); return result; } };
    const send = vi.fn(async () => ({ messageId: "m" }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runAt({ DB: db, APP_ORIGIN: ORIGIN, NOTIFICATIONS_FROM_ADDRESS: SENDER, EMAIL: { send } } as unknown as Env, T0);
    expect(send).not.toHaveBeenCalled();
    expect((await rowOf(id))!.sent_at).toBeNull();
    expect(await lastDigest(t.member.memberId)).toBeNull();
    const mail = mailer(); await runAt(mail.env, T0 + 60_000); expect(mail.sent).toHaveLength(1);
  });

  it("if the release write itself fails, the rows stay marked and only a safe code is logged", async () => {
    const t = await basic(); const id = await pend(t.member, t.link.id, "version_granted", t.version);
    let sendCalled = false; const real = database.DB;
    const db = { prepare: (sql: string) => { if (sendCalled) throw new Error("database down for leak@example.com"); return real.prepare(sql); }, batch: (statements: D1PreparedStatement[]) => { if (sendCalled) throw new Error("database down for leak@example.com"); return real.batch(statements); } };
    const env2 = { DB: db, APP_ORIGIN: ORIGIN, NOTIFICATIONS_FROM_ADDRESS: SENDER, EMAIL: { send: async () => { sendCalled = true; throw rejection("E_RATE_LIMIT_EXCEEDED"); } } } as unknown as Env;
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
    try {
      await runAt(env2, T0);
      expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain("leak@example.com");
    } finally { spies.forEach((spy) => spy.mockRestore()); }
    expect((await rowOf(id))!.sent_at).toBe(T0);
    const healthy = mailer(); await runAt(healthy.env, T0 + HOUR); expect(healthy.sent).toHaveLength(0);
  });
});

describe("the cooldown runs on the real clock", () => {
  it("a delayed run (scheduled 10:00, real clock 10:10) records 10:10, and the 11:00 run is refused", async () => {
    const t = await basic(); const id = await pend(t.member, t.link.id, "version_granted", t.version);
    vi.setSystemTime(T0 + 10 * 60_000);
    const first = mailer(); await runGuestDigests(first.env, T0);
    expect(first.sent).toHaveLength(1);
    expect(await lastDigest(t.member.memberId)).toBe(T0 + 10 * 60_000); expect((await rowOf(id))!.sent_at).toBe(T0 + 10 * 60_000);
    const later = await pend(t.member, t.link.id, "version_granted", t.version, null, T0 + 30 * 60_000);
    vi.setSystemTime(T0 + HOUR);
    const second = mailer(); await runGuestDigests(second.env, T0 + HOUR);
    expect(second.sent).toHaveLength(0); expect((await rowOf(later))!.sent_at).toBeNull();
    vi.setSystemTime(T0 + 65 * 60_000);
    await runGuestDigests(second.env, T0 + 2 * HOUR); expect(second.sent).toHaveLength(1);
  });
});

describe("sweep", () => {
  it("deletes pending rows older than 7 days and tokens older than 180 days, and nothing newer", async () => {
    const t = await basic();
    const old = await pend(t.member, t.link.id, "version_granted", t.version, null, T0 - 7 * DAY - 1); const fresh = await pend(t.member, t.link.id, "version_granted", t.version, null, T0 - 6 * DAY);
    const sentOld = await pend(t.member, t.link.id, "version_granted", t.version, null, T0 - 30 * DAY); await database.DB.prepare("UPDATE guest_notification_digest SET sent_at = ? WHERE id = ?").bind(T0 - 29 * DAY, sentOld).run();
    for (const [hash, created] of [["old-token", T0 - 180 * DAY - 1], ["young-token", T0 - 179 * DAY]] as const) await database.DB.prepare("INSERT INTO guest_unsubscribe_tokens (token_hash, member_id, created_at) VALUES (?, ?, ?)").bind(hash, t.member.memberId, created).run();
    await sweepGuestDigests(database.DB, T0);
    expect(await rowOf(old)).toBeNull(); expect(await rowOf(fresh)).not.toBeNull(); expect(await rowOf(sentOld)).not.toBeNull();
    expect((await tokens(t.member.memberId)).map((row) => row.token_hash)).toEqual(["young-token"]);
  });
});
