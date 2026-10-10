import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addLinkVideo, setLinkGrants } from "../src/lib/review-links";
import { releaseVersion } from "../src/lib/video-approval";
import { createVideoNote, createVideoNoteReply, findNoteHead, userAuthor, type Principal } from "../src/lib/video-notes";
import { database, ids, seedFixture } from "./embedded-media-support";
import { addMember, clearGuestRows, grant, openGuestGate, seedGuestLink } from "./guest-support";
import { clearVideoFlags, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** The client digest PRODUCERS (#741 15b): every staff write that a subscribed guest should hear about leaves one `guest_notification_digest` row per subscribed member, and nothing else does. */
const staff = { id: ids.member, role: "editor" } as unknown as Principal;
type Row = { guest_id: string; link_id: string; event_type: string; video_id: string; asset_id: string | null; note_id: string | null; sent_at: number | null };
const digestRows = async () => (await database.DB.prepare("SELECT guest_id, link_id, event_type, video_id, asset_id, note_id, sent_at FROM guest_notification_digest ORDER BY created_at, rowid").all<Row>()).results;

beforeAll(async () => { await seedFixture(); });
const wipe = async () => {
  await database.DB.batch([
    database.DB.prepare("DELETE FROM guest_notification_digest"), database.DB.prepare("DELETE FROM guest_link_members"), database.DB.prepare("DELETE FROM video_releases"), database.DB.prepare("DELETE FROM video_approval_events"),
    database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'video_%' OR action LIKE 'review_link.%'"),
    database.DB.prepare("DELETE FROM video_notes"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets WHERE kind = 'video'"), database.DB.prepare("DELETE FROM videos"),
    database.DB.prepare("DELETE FROM guest_reviewers WHERE email_normalized LIKE '%@digest-15b.test' OR email_normalized LIKE '%@guest.test'"),
  ]);
};
beforeEach(async () => { await clearGuestRows(); await wipe(); await openGuestGate(); await setVideoFlags("video_review_notify_client"); });
afterEach(async () => { await clearGuestRows(); await wipe(); await clearVideoFlags(); });

/** A verified guest with a membership on the link, straight into the tables (the email flow has its own suite). */
async function member(linkId: string, input: { unsubscribed?: boolean } = {}) {
  const guestId = crypto.randomUUID(); const memberId = crypto.randomUUID(); const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO guest_reviewers (id, email_normalized, display_name, created_at) VALUES (?, ?, 'Gina Guest', ?)").bind(guestId, `${guestId}@digest-15b.test`, now),
    database.DB.prepare("INSERT INTO guest_link_members (id, link_id, guest_id, first_verified_at, last_verified_at, last_seen_at, unsubscribed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(memberId, linkId, guestId, now, now, now, input.unsubscribed ? now : null),
  ]);
  return { guestId, memberId };
}
async function setup(linkInput: Parameters<typeof seedGuestLink>[0] = {}) {
  const link = await seedGuestLink(linkInput); const version = await seedVideoVersion({ title: "Hero" });
  await addMember(link.id, version.videoId, [version.assetId]);
  return { link, version, guest: await member(link.id) };
}
const note = (assetId: string, visibility: "public" | "internal", body = "Trim the intro") =>
  createVideoNote(database.DB, { projectId: ids.project, assetId, author: userAuthor(staff), visibility, startFrame: 10, endFrame: null, body, now: Date.now() });
async function reply(rootId: string, body = "Done") {
  const parent = (await findNoteHead(database.DB, ids.project, rootId))!;
  return createVideoNoteReply(database.DB, { projectId: ids.project, parent, author: userAuthor(staff), body, now: Date.now() });
}
const noteIdOf = async (assetId: string, body: string) => (await database.DB.prepare("SELECT id FROM video_notes WHERE asset_id = ? AND body = ?").bind(assetId, body).first<{ id: string }>())!.id;

describe("public_note", () => {
  it("a staff public root note leaves one row per subscribed member, naming the note", async () => {
    const { link, version, guest } = await setup(); const second = await member(link.id);
    expect((await note(version.assetId, "public")).kind).toBe("ok");
    const rows = await digestRows();
    expect(rows.map((row) => row.guest_id).sort()).toEqual([guest.guestId, second.guestId].sort());
    for (const row of rows) expect(row).toMatchObject({ link_id: link.id, event_type: "public_note", video_id: version.videoId, asset_id: version.assetId, sent_at: null, note_id: await noteIdOf(version.assetId, "Trim the intro") });
  });

  it("an INTERNAL note and an internal thread's reply produce nothing", async () => {
    const { version } = await setup();
    expect((await note(version.assetId, "internal", "Secret")).kind).toBe("ok");
    expect(await digestRows()).toEqual([]);
    expect((await reply(await noteIdOf(version.assetId, "Secret"), "Secret reply")).kind).toBe("ok");
    expect(await digestRows()).toEqual([]);
  });

  it("an unsubscribed member, a revoked or expired link, a removed Video, a revoked grant and notify_client off each produce nothing", async () => {
    const cases: Array<{ name: string; prepare: (t: Awaited<ReturnType<typeof setup>>) => Promise<void> }> = [
      { name: "unsubscribed", prepare: async (t) => { await database.DB.prepare("UPDATE guest_link_members SET unsubscribed_at = ? WHERE guest_id = ?").bind(Date.now(), t.guest.guestId).run(); } },
      { name: "revoked", prepare: async (t) => { await database.DB.prepare("UPDATE client_links SET revoked_at = ?, revoked_by = ? WHERE id = ?").bind(Date.now(), ids.member, t.link.id).run(); } },
      { name: "expired", prepare: async (t) => { await database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, t.link.id).run(); } },
      { name: "removed Video", prepare: async (t) => { await database.DB.prepare("UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE link_id = ?").bind(Date.now(), ids.member, t.link.id).run(); } },
      { name: "revoked grant", prepare: async (t) => { await database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE link_id = ?").bind(Date.now(), ids.member, t.link.id).run(); } },
      { name: "notify_client off", prepare: async () => { await database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_notify_client'").run(); } },
      { name: "guest part off", prepare: async () => { await database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_guest'").run(); } },
      { name: "delivery link kind", prepare: async (t) => { await database.DB.prepare("UPDATE client_links SET kind = 'delivery', publish_version = 1 WHERE id = ?").bind(t.link.id).run(); } },
    ];
    for (const { name, prepare } of cases) {
      await wipe(); await clearGuestRows(); await openGuestGate(); await setVideoFlags("video_review_notify_client");
      const t = await setup(); await prepare(t);
      expect((await note(t.version.assetId, "public")).kind, name).toBe("ok");
      expect(await digestRows(), name).toEqual([]);
    }
  });

  it("another link that does not reach the Version gets nothing", async () => {
    const { version } = await setup(); const other = await seedGuestLink(); const elsewhere = await seedVideoVersion({ title: "Other cut" });
    await addMember(other.id, elsewhere.videoId, [elsewhere.assetId]); await member(other.id);
    await note(version.assetId, "public");
    expect((await digestRows()).map((row) => row.link_id)).toEqual([expect.not.stringMatching(other.id)]);
  });
});

describe("staff_reply", () => {
  it("goes to the guests who wrote the root or a reply in the thread, and to no other member", async () => {
    const { link, version } = await setup();
    const root = await seedVideoNote({ assetId: version.assetId, guest: true, body: "Guest root" });
    const bystander = await member(link.id);
    const author = await member(link.id); await database.DB.prepare("UPDATE video_notes SET author_guest_id = ? WHERE id = ?").bind(author.guestId, root.id).run();
    expect((await reply(root.id, "We fixed it")).kind).toBe("ok");
    const rows = await digestRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ guest_id: author.guestId, event_type: "staff_reply", link_id: link.id, asset_id: version.assetId, note_id: await noteIdOf(version.assetId, "We fixed it") });
    expect(rows.some((row) => row.guest_id === bystander.guestId)).toBe(false);
  });

  it("a staff reply under a public staff root with no guest in the thread produces nothing", async () => {
    const { version } = await setup();
    await note(version.assetId, "public"); await database.DB.prepare("DELETE FROM guest_notification_digest").run();
    await reply(await noteIdOf(version.assetId, "Trim the intro"));
    expect(await digestRows()).toEqual([]);
  });
});

describe("video_added and version_granted", () => {
  it("adding a Video to a link tells that link's subscribers once, whatever number of Versions came with it", async () => {
    const link = await seedGuestLink(); const first = await seedVideoVersion({ title: "First" }); await addMember(link.id, first.videoId, [first.assetId]); const guest = await member(link.id);
    const other = await seedGuestLink(); const otherGuest = await member(other.id);
    const added = await seedVideoVersion({ title: "Second" }); const added2 = await seedVideoVersion({ projectId: ids.project, videoId: added.videoId, version: 2 });
    expect(await addLinkVideo(database.DB, { projectId: ids.project, linkId: link.id, principal: staff, videoId: added.videoId, assetIds: [added.assetId, added2.assetId], now: Date.now() })).toBe(true);
    const rows = await digestRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ guest_id: guest.guestId, link_id: link.id, event_type: "video_added", video_id: added.videoId, asset_id: null, note_id: null });
    expect(rows.some((row) => row.guest_id === otherGuest.guestId)).toBe(false);
  });

  it("setting the grants names only the NEW Versions: a kept grant says nothing, and an unchanged set produces nothing", async () => {
    const link = await seedGuestLink(); const v1 = await seedVideoVersion({ title: "Cut" }); await addMember(link.id, v1.videoId, [v1.assetId]); const guest = await member(link.id);
    const v2 = await seedVideoVersion({ projectId: ids.project, videoId: v1.videoId, version: 2 });
    expect(await setLinkGrants(database.DB, { projectId: ids.project, linkId: link.id, principal: staff, videoId: v1.videoId, assetIds: [v1.assetId, v2.assetId], now: Date.now() })).toBe(true);
    let rows = await digestRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ guest_id: guest.guestId, event_type: "version_granted", video_id: v1.videoId, asset_id: v2.assetId });
    await database.DB.prepare("DELETE FROM guest_notification_digest").run();
    expect(await setLinkGrants(database.DB, { projectId: ids.project, linkId: link.id, principal: staff, videoId: v1.videoId, assetIds: [v1.assetId, v2.assetId], now: Date.now() })).toBe(true);
    rows = await digestRows(); expect(rows).toEqual([]);
  });
});

describe("video_released", () => {
  async function approved(assetId: string, videoId: string) {
    await database.DB.prepare("INSERT INTO video_approval_events (id, project_id, video_id, asset_id, link_id, revision, decision, note, actor_guest_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, NULL, 1, 'approved', NULL, NULL, ?, ?)")
      .bind(crypto.randomUUID(), ids.project, videoId, assetId, ids.member, Date.now()).run();
  }
  it("tells subscribers of links that grant the Version with downloads on, and not a link with downloads off", async () => {
    const version = await seedVideoVersion({ title: "Final" });
    const on = await seedGuestLink(); await addMember(on.id, version.videoId, [version.assetId]); const onGuest = await member(on.id);
    const off = await seedGuestLink({ allow: [1, 1, 0] }); await addMember(off.id, version.videoId, [version.assetId]); await member(off.id);
    await approved(version.assetId, version.videoId);
    const outcome = await releaseVersion(database.DB, { projectId: ids.project, assetId: version.assetId, principal: staff, approvalRevision: 1, now: Date.now() });
    expect("release" in outcome).toBe(true);
    const rows = await digestRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ guest_id: onGuest.guestId, link_id: on.id, event_type: "video_released", video_id: version.videoId, asset_id: version.assetId });
  });

  it("a refused Release (stale approval) leaves nothing", async () => {
    const version = await seedVideoVersion({ title: "Final" }); const link = await seedGuestLink(); await addMember(link.id, version.videoId, [version.assetId]); await member(link.id);
    await approved(version.assetId, version.videoId);
    const outcome = await releaseVersion(database.DB, { projectId: ids.project, assetId: version.assetId, principal: staff, approvalRevision: 9, now: Date.now() });
    expect("release" in outcome).toBe(false);
    expect(await digestRows()).toEqual([]);
  });
});
void grant;
