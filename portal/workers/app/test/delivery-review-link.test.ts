import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { baseEnv, database, ids, request, seedFixture, type Who } from "./embedded-media-support";
import { clearDeliveryFlags, openDelivery, seedAsset, wipeDelivery } from "./delivery-support";
import { clearVideoFlags, seedVideoVersion, setVideoFlags } from "./video-review-support";
import { openGuestGate } from "./guest-support";
import { syncDeliveryReviewLink } from "../src/lib/delivery-review-link";

/**
 * The Delivery review link follows Publish, Unlock, Re-lock and a premium mark (#847, ADR 0023). Everything is observed through the HTTP API, and the rows are read only where the
 * guarantee IS the rows: the link's fixed settings and the history that survives (soft-removed memberships, revoked grants).
 */
type Json = Record<string, any>;
const d = (rest: string, projectId: string = ids.project) => `/api/projects/${projectId}/delivery${rest}`;
const publish = (assetIds: string[], expectedLatestSet: number | null, who: Who = "admin", projectId?: string) => request(d("/publish", projectId), who, "POST", { assetIds, expectedLatestSet, operationId: crypto.randomUUID() });
const premium = (videoId: string, value: boolean) => request(`/api/projects/${ids.project}/delivery/videos/${videoId}/premium`, "admin", "PUT", { premium: value });
const unlock = (videoId: string, unlocked: boolean) => request(`/api/projects/${ids.project}/delivery/videos/${videoId}/premium-unlock`, "admin", "PUT", { unlocked, ...(unlocked ? { paymentRef: "INV-1" } : {}) });

beforeAll(async () => {
  await seedFixture();
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
});
const wipe = async () => {
  await wipeDelivery();
  await database.DB.batch([
    database.DB.prepare("DELETE FROM guest_notification_digest"), database.DB.prepare("DELETE FROM guest_link_members"), database.DB.prepare("DELETE FROM guest_reviewers"),
    database.DB.prepare("DELETE FROM review_link_version_grants"), database.DB.prepare("DELETE FROM review_link_videos"), database.DB.prepare("DELETE FROM client_links"),
    database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'review_link.%' OR action LIKE 'video.premium%'"),
    database.DB.prepare("DELETE FROM video_premium_unlocks"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets"), database.DB.prepare("DELETE FROM videos"),
  ]);
};
beforeEach(async () => { await wipe(); await clearDeliveryFlags(); await openDelivery(ids.project); });
afterEach(async () => { await wipe(); await clearDeliveryFlags(); });

const links = async (projectId: string = ids.project) => (await database.DB.prepare("SELECT * FROM client_links WHERE project_id = ? AND delivery_review = 1").bind(projectId).all<Json>()).results;
const members = async (linkId: string) => (await database.DB.prepare("SELECT video_id, removed_at FROM review_link_videos WHERE link_id = ? ORDER BY added_at, rowid").bind(linkId).all<Json>()).results;
const grants = async (linkId: string) => (await database.DB.prepare("SELECT g.id, g.asset_id, a.version, g.revoked_at FROM review_link_version_grants g JOIN assets a ON a.id = g.asset_id WHERE g.link_id = ? ORDER BY a.version, g.rowid").bind(linkId).all<Json>()).results;
const liveGrantVersions = async (linkId: string) => (await grants(linkId)).filter((row) => row.revoked_at === null).map((row) => row.version);
const liveVideos = async (linkId: string) => (await members(linkId)).filter((row) => row.removed_at === null).map((row) => row.video_id);
const auditCount = async (action: string) => (await database.DB.prepare("SELECT count(*) AS n FROM audit_log WHERE action = ?").bind(action).first<{ n: number }>())!.n;
/** A film with Versions 1..n, only the newest current (as upload completion leaves it). */
async function film(versions: number, over: { title?: string } = {}) {
  const videoId = crypto.randomUUID(); const assets: string[] = [];
  for (let version = 1; version <= versions; version += 1) {
    const seeded = await seedVideoVersion({ videoId, version, title: over.title ?? "Walkthrough" }); assets.push(seeded.assetId);
    if (version < versions) await database.DB.prepare("UPDATE assets SET superseded_at = ? WHERE id = ?").bind(Date.now(), seeded.assetId).run();
  }
  return { videoId, assets, current: assets[versions - 1]! };
}
const addVersion = async (f: { videoId: string; assets: string[]; current: string }, version: number) => {
  await database.DB.prepare("UPDATE assets SET superseded_at = ? WHERE id = ?").bind(Date.now(), f.current).run();
  const seeded = await seedVideoVersion({ videoId: f.videoId, version }); f.assets.push(seeded.assetId); f.current = seeded.assetId; return seeded.assetId;
};

describe("Publish creates and follows the Delivery review link", () => {
  it("the first Publish with a film creates the link with its fixed settings, the film, its published Version and every older one", async () => {
    const f = await film(2);
    const response = await publish([f.current], null); expect(response.ok).toBe(true);
    const [link, ...rest] = await links(); expect(rest).toEqual([]);
    expect(link).toMatchObject({ kind: "video_review", label: "Delivery", passcode_hash: null, expires_at: null, allow_comments: 1, allow_approve: 1, allow_download: 1, token_generation: 1, delivery_review: 1, revoked_at: null, deleted_at: null, created_by: ids.admin });
    expect(link!.token_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await liveVideos(link!.id)).toEqual([f.videoId]);
    expect(await liveGrantVersions(link!.id)).toEqual([1, 2]);
    expect(await auditCount("review_link.create")).toBe(1); expect(await auditCount("review_link.delivery_sync")).toBe(1);
    const meta = JSON.parse((await database.DB.prepare("SELECT meta_json FROM audit_log WHERE action = 'review_link.delivery_sync'").first<{ meta_json: string }>())!.meta_json);
    expect(meta).toMatchObject({ projectId: ids.project, linkId: link!.id, trigger: "publish", videoIds: [f.videoId], assetIds: expect.arrayContaining(f.assets) });
    expect(JSON.stringify(meta)).not.toContain(link!.token_secret);
    // Publishing is not a Release.
    expect((await database.DB.prepare("SELECT count(*) AS n FROM video_releases").first<{ n: number }>())!.n).toBe(0);
  });

  it("a Publish with photos only creates no link", async () => {
    const photo = await seedAsset("photo");
    expect((await publish([photo.id], null)).ok).toBe(true);
    expect(await links()).toEqual([]);
  });

  it("a later Publish swaps the published Version, keeps the older grants, and never grants a Version uploaded after the Publish", async () => {
    const f = await film(2);
    await publish([f.current], null);
    const [link] = await links(); const before = await grants(link!.id);
    const v3 = await addVersion(f, 3);
    expect(await liveGrantVersions(link!.id)).toEqual([1, 2]); // an upload alone changes nothing
    await addVersion(f, 4); // a Version that is newer than the one about to be published
    await database.DB.prepare("UPDATE assets SET superseded_at = NULL WHERE id = ?").bind(v3).run();
    await database.DB.prepare("UPDATE assets SET superseded_at = ? WHERE id = ?").bind(Date.now(), f.current).run();
    f.current = v3;
    expect((await publish([v3], 1)).ok).toBe(true);
    expect(await liveGrantVersions(link!.id)).toEqual([1, 2, 3]);
    const after = await grants(link!.id);
    expect(after.filter((row) => row.version <= 2).map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(await links()).toHaveLength(1);
  });

  it("a film left out of a later Publish drops off with its history kept, and the link stays", async () => {
    const a = await film(1, { title: "A" }); const b = await film(1, { title: "B" });
    await publish([a.current, b.current], null);
    const [link] = await links();
    expect((await liveVideos(link!.id)).sort()).toEqual([a.videoId, b.videoId].sort());
    expect((await publish([b.current], 1)).ok).toBe(true);
    expect(await liveVideos(link!.id)).toEqual([b.videoId]);
    const rows = await members(link!.id); expect(rows).toHaveLength(2); expect(rows.find((row) => row.video_id === a.videoId)!.removed_at).not.toBeNull();
    const gone = (await grants(link!.id)).filter((row) => row.revoked_at !== null); expect(gone).toHaveLength(1);
    // Nothing left to carry: the link is kept, empty.
    const photo = await seedAsset("photo");
    expect((await publish([photo.id], 2)).ok).toBe(true);
    expect(await liveVideos(link!.id)).toEqual([]);
    expect(await links()).toHaveLength(1);
    // The film comes back as a new membership.
    expect((await publish([a.current], 3)).ok).toBe(true);
    expect(await liveVideos(link!.id)).toEqual([a.videoId]);
    expect(await members(link!.id)).toHaveLength(3);
  });

  it("a Version in Trash stays granted (a restore needs no sync) and a film newer than the set is never granted", async () => {
    const f = await film(2);
    await database.DB.prepare("UPDATE video_version_meta SET removed_at = ? WHERE asset_id = ?").bind(Date.now(), f.assets[0]).run();
    await publish([f.current], null);
    const [link] = await links();
    expect(await liveGrantVersions(link!.id)).toEqual([1, 2]);
  });

  it("running the sync again writes nothing and audits nothing", async () => {
    const f = await film(2); await publish([f.current], null);
    const [link] = await links(); const before = await grants(link!.id);
    const result = await syncDeliveryReviewLink(baseEnv.DB, { projectId: ids.project, principal: { id: ids.admin, impersonatedBy: undefined, via: undefined }, now: Date.now(), trigger: "backfill" });
    expect(result).toEqual({ created: false, changed: false });
    expect(await grants(link!.id)).toEqual(before);
    expect(await auditCount("review_link.delivery_sync")).toBe(1); expect(await auditCount("review_link.create")).toBe(1);
  });
});

describe("Premium films join only once Unlocked", () => {
  it("a locked film is excluded, Unlock adds it, Re-lock and a premium mark remove it, and none of it creates a link", async () => {
    const open = await film(1, { title: "Open" }); const paid = await film(1, { title: "Paid" });
    expect((await premium(paid.videoId, true)).status).toBe(200);
    expect(await links()).toEqual([]); // a premium mark never creates
    await publish([open.current, paid.current], null);
    const [link] = await links();
    expect(await liveVideos(link!.id)).toEqual([open.videoId]);
    expect((await unlock(paid.videoId, true)).status).toBe(200);
    expect((await liveVideos(link!.id)).sort()).toEqual([open.videoId, paid.videoId].sort());
    expect(await liveGrantVersions(link!.id)).toEqual([1, 1]);
    expect((await unlock(paid.videoId, false)).status).toBe(200);
    expect(await liveVideos(link!.id)).toEqual([open.videoId]);
    expect((await unlock(paid.videoId, true)).status).toBe(200);
    expect((await premium(open.videoId, true)).status).toBe(200);
    expect(await liveVideos(link!.id)).toEqual([paid.videoId]);
    expect(await links()).toHaveLength(1);
  });

  it("an Unlock on a Project with no Delivery review link creates none", async () => {
    const f = await film(1); await database.DB.prepare("UPDATE videos SET premium = 1 WHERE id = ?").bind(f.videoId).run();
    expect((await unlock(f.videoId, true)).status).toBe(200);
    expect(await links()).toEqual([]);
  });

  it("a locked-only first Publish still creates the link, empty, and the Unlock then fills it", async () => {
    const paid = await film(1); await premium(paid.videoId, true);
    await publish([paid.current], null);
    const [link] = await links(); expect(link).toBeDefined();
    expect(await liveVideos(link!.id)).toEqual([]);
    await unlock(paid.videoId, true);
    expect(await liveVideos(link!.id)).toEqual([paid.videoId]);
  });
});

describe("the Admin backfill route (POST /api/admin/delivery-review-links/sync)", () => {
  const sync = (body: Json, who: Who = "admin") => request("/api/admin/delivery-review-links/sync", who, "POST", body);
  /** A Delivery page published with a film but NO link, as production is before the backfill. */
  async function unlinkedProject() {
    const f = await film(2); expect((await publish([f.current], null)).ok).toBe(true);
    await database.DB.batch([database.DB.prepare("DELETE FROM review_link_version_grants"), database.DB.prepare("DELETE FROM review_link_videos"), database.DB.prepare("DELETE FROM client_links"), database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'review_link.%'")]);
    return f;
  }
  it("is Admin only", async () => {
    expect((await sync({}, "member")).status).toBe(403);
  });
  it("a dry run writes nothing and counts what it would create", async () => {
    await unlinkedProject();
    const response = await sync({ dryRun: true }); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dryRun: true, scanned: 1, wouldCreate: 1, nextCursor: null });
    expect(await links()).toEqual([]);
  });
  it("creates the link with its film and Versions, reports counts without any secret, and a second run changes nothing", async () => {
    const f = await unlinkedProject();
    const first = await sync({}); expect(first.status).toBe(200);
    const body = await first.json() as Json; expect(body).toEqual({ dryRun: false, scanned: 1, created: 1, changed: 1, nextCursor: null });
    const [link] = await links(); expect(link).toMatchObject({ delivery_review: 1, expires_at: null, label: "Delivery" });
    expect(JSON.stringify(body)).not.toContain(link!.token_secret);
    expect(await liveVideos(link!.id)).toEqual([f.videoId]); expect(await liveGrantVersions(link!.id)).toEqual([1, 2]);
    const again = await (await sync({})).json() as Json; expect(again).toMatchObject({ scanned: 1, created: 0, changed: 0 });
    expect(await links()).toHaveLength(1); expect((await links())[0]!.token_secret).toBe(link!.token_secret);
    expect(await auditCount("admin.delivery_review_backfill")).toBe(2);
  });
  it("pages by cursor", async () => {
    await unlinkedProject();
    const a = await (await sync({ limit: 1 })).json() as Json; expect(a.scanned).toBe(1); expect(a.nextCursor).toBeNull();
    expect((await sync({ cursor: ids.project })).status).toBe(200);
    expect((await sync({ limit: 0 })).status).toBe(400);
  });
});

describe("the client digest names only what THIS sync added (#847)", () => {
  type Row = { event_type: string; video_id: string; asset_id: string | null };
  const digest = async () => (await database.DB.prepare("SELECT event_type, video_id, asset_id FROM guest_notification_digest ORDER BY rowid").all<Row>()).results;
  const subscribe = async (linkId: string) => {
    const guestId = crypto.randomUUID(); const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO guest_reviewers (id, email_normalized, display_name, created_at) VALUES (?, ?, 'Gina Guest', ?)").bind(guestId, `${guestId}@guest.test`, now),
      database.DB.prepare("INSERT INTO guest_link_members (id, link_id, guest_id, first_verified_at, last_verified_at, last_seen_at, unsubscribed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)").bind(crypto.randomUUID(), linkId, guestId, now, now, now),
    ]);
  };
  beforeEach(async () => { await openGuestGate(); await setVideoFlags("video_review_notify_client"); });
  afterEach(async () => { vi.useRealTimers(); await database.DB.prepare("DELETE FROM guest_reviewers WHERE email_normalized LIKE '%@guest.test'").run(); await clearVideoFlags(); });

  it("two syncs by one staff member in the same millisecond tell the subscriber of each film exactly once", async () => {
    const a = await film(1, { title: "A" }); const b = await film(1, { title: "B" }); const c = await film(1, { title: "C" });
    await publish([a.current], null);
    const [link] = await links(); await subscribe(link!.id);
    await database.DB.prepare("DELETE FROM guest_notification_digest").run();
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 5_000);
    expect((await publish([a.current, b.current], 1)).ok).toBe(true); // B joins; A is already on the link
    expect((await publish([a.current, b.current, c.current], 2)).ok).toBe(true); // a second sync, same millisecond and actor: C joins
    expect((await digest()).filter((row) => row.event_type === "video_added").map((row) => row.video_id).sort()).toEqual([b.videoId, c.videoId].sort());
  });

  it("two syncs in the same millisecond do not repeat a Version grant", async () => {
    const a = await film(1, { title: "A" }); const c = await film(1, { title: "C" });
    await publish([a.current], null);
    const [link] = await links(); await subscribe(link!.id);
    await database.DB.prepare("DELETE FROM guest_notification_digest").run();
    const second = await addVersion(a, 2);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 5_000);
    expect((await publish([second], 1)).ok).toBe(true); // A's Version 2 is granted
    expect((await publish([second, c.current], 2)).ok).toBe(true); // C joins in the same millisecond
    const rows = await digest();
    expect(rows.filter((row) => row.event_type === "version_granted")).toEqual([{ event_type: "version_granted", video_id: a.videoId, asset_id: second }]);
    expect(rows.filter((row) => row.event_type === "video_added")).toEqual([{ event_type: "video_added", video_id: c.videoId, asset_id: null }]);
  });
});
