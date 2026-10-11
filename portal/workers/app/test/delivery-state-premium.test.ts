import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { database, ids, request, seedFixture } from "./embedded-media-support";
import { seedVideoVersion } from "./video-review-support";
import { clearDeliveryFlags, openDelivery, seedAsset, seedPage, seedUnlock, wipeDelivery } from "./delivery-support";

/** The staff Delivery read carries each served item's premium state (#787 slice 10 round 1), so a superseded item still on the page can be unlocked from the tab. */
beforeAll(async () => { await seedFixture(); });
const wipe = async () => { await wipeDelivery(); await database.DB.batch([database.DB.prepare("DELETE FROM video_premium_unlocks"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets"), database.DB.prepare("DELETE FROM videos")]); };
beforeEach(async () => { await wipe(); await clearDeliveryFlags(); await openDelivery(ids.project); });
afterEach(async () => { await wipe(); await clearDeliveryFlags(); });

describe("premium state on the staff Delivery read", () => {
  it("reports premium and premiumUnlocked per set item, including a superseded Asset still in the current set", async () => {
    const plain = await seedAsset("photo");
    const locked = await seedAsset("photo", { deliveryPremium: true });
    const old = await seedAsset("photo", { deliveryPremium: true, superseded: true });
    await seedUnlock(old.id);
    await seedPage({ assetIds: [plain.id, locked.id, old.id] });
    const response = await request(`/api/projects/${ids.project}/delivery`, "admin");
    expect(response.status).toBe(200);
    const items = ((await response.json()) as { set: { items: Array<Record<string, unknown>> } }).set.items;
    const of = (id: string) => items.find((item) => item.assetId === id)!;
    expect(of(plain.id)).toMatchObject({ premium: false, premiumUnlocked: false, videoId: null });
    expect(of(locked.id)).toMatchObject({ premium: true, premiumUnlocked: false, locked: true });
    expect(of(old.id)).toMatchObject({ premium: true, premiumUnlocked: true, locked: false });
  });

  it("reports a Video Version's premium and unlock from its Video, not from the Asset", async () => {
    const locked = await seedVideoVersion({ title: "Locked film" });
    const open = await seedVideoVersion({ title: "Unlocked film" });
    const plain = await seedVideoVersion({ title: "Plain film" });
    await database.DB.prepare("UPDATE videos SET premium = 1 WHERE id IN (?, ?)").bind(locked.videoId, open.videoId).run();
    await database.DB.prepare("INSERT INTO video_premium_unlocks (video_id, project_id, unlocked_by, unlocked_at) VALUES (?, ?, ?, ?)").bind(open.videoId, ids.project, ids.admin, Date.now()).run();
    await seedPage({ assetIds: [locked.assetId, open.assetId, plain.assetId] });
    const response = await request(`/api/projects/${ids.project}/delivery`, "admin");
    const items = ((await response.json()) as { set: { items: Array<Record<string, unknown>> } }).set.items;
    const of = (id: string) => items.find((item) => item.assetId === id)!;
    expect(of(locked.assetId)).toMatchObject({ premium: true, premiumUnlocked: false, locked: true, videoId: locked.videoId });
    expect(of(open.assetId)).toMatchObject({ premium: true, premiumUnlocked: true, locked: false });
    expect(of(plain.assetId)).toMatchObject({ premium: false, premiumUnlocked: false, videoId: plain.videoId });
  });
});
