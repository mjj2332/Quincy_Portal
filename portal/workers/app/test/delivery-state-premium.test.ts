import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { database, ids, request, seedFixture } from "./embedded-media-support";
import { clearDeliveryFlags, openDelivery, seedAsset, seedPage, seedUnlock, wipeDelivery } from "./delivery-support";

/** The staff Delivery read carries each served item's premium state (#787 slice 10 round 1), so a superseded item still on the page can be unlocked from the tab. */
beforeAll(async () => { await seedFixture(); });
const wipe = async () => { await wipeDelivery(); await database.DB.batch([database.DB.prepare("DELETE FROM assets")]); };
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
    expect(of(plain.id)).toMatchObject({ premium: false, premiumUnlocked: false });
    expect(of(locked.id)).toMatchObject({ premium: true, premiumUnlocked: false, locked: true });
    expect(of(old.id)).toMatchObject({ premium: true, premiumUnlocked: true, locked: false });
  });
});
