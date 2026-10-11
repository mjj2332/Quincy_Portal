import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { database, ids, request, seedFixture } from "./embedded-media-support";
import { clearDeliveryFlags, openDelivery, seedAsset, seedUnlock, wipeDelivery } from "./delivery-support";

/** The staff assets list carries each paid-extra Asset's premium state (#787 slice 10), so the Delivery tab can show Mark, Unlock and Re-lock without a second read. */
type Json = Record<string, any>;
beforeAll(async () => { await seedFixture(); });
const wipe = async () => { await wipeDelivery(); await database.DB.batch([database.DB.prepare("DELETE FROM assets")]); };
beforeEach(async () => { await wipe(); await clearDeliveryFlags(); await openDelivery(ids.project); });
afterEach(async () => { await wipe(); await clearDeliveryFlags(); });

const list = async (collection: string, who: "admin" | "member" | "external" = "admin") => {
  const response = await request(`/api/projects/${ids.project}/assets?collection=${collection}`, who);
  expect(response.status).toBe(200);
  return ((await response.json()) as { assets: Json[] }).assets;
};
const find = (assets: Json[], id: string) => assets.find((asset) => asset.id === id)!;

describe("premium state on the staff assets list", () => {
  it("reports premium and premiumUnlocked for a photo, tracking the PUT routes", async () => {
    const photo = await seedAsset("photo");
    expect(find(await list("edited"), photo.id)).toMatchObject({ premium: false, premiumUnlocked: false });
    expect((await request(`/api/projects/${ids.project}/assets/${photo.id}/delivery-premium`, "admin", "PUT", { premium: true })).status).toBe(200);
    expect(find(await list("edited"), photo.id)).toMatchObject({ premium: true, premiumUnlocked: false });
    expect((await request(`/api/projects/${ids.project}/assets/${photo.id}/delivery-premium-unlock`, "admin", "PUT", { unlocked: true })).status).toBe(200);
    expect(find(await list("edited"), photo.id)).toMatchObject({ premium: true, premiumUnlocked: true });
    expect((await request(`/api/projects/${ids.project}/assets/${photo.id}/delivery-premium-unlock`, "admin", "PUT", { unlocked: false })).status).toBe(200);
    expect(find(await list("edited"), photo.id)).toMatchObject({ premium: true, premiumUnlocked: false });
  });

  it("reports an unlock row only as unlocked, for a Floorplan PDF and a Copy PDF", async () => {
    const plan = await seedAsset("floorplan_pdf", { deliveryPremium: true }); const copy = await seedAsset("copy_pdf", { deliveryPremium: true });
    await seedUnlock(copy.id);
    expect(find(await list("floorplan"), plan.id)).toMatchObject({ premium: true, premiumUnlocked: false });
    expect(find(await list("copy"), copy.id)).toMatchObject({ premium: true, premiumUnlocked: true });
  });

  it("states the PDF's premium only on the PDF: a Floorplan preview answers false and false", async () => {
    const group = crypto.randomUUID();
    const pdf = await seedAsset("floorplan_pdf", { deliveryPremium: true, versionGroupId: group });
    const preview = await seedAsset("floorplan_preview", { versionGroupId: group });
    const assets = await list("floorplan");
    expect(find(assets, pdf.id)).toMatchObject({ premium: true });
    expect(find(assets, preview.id)).toMatchObject({ premium: false, premiumUnlocked: false });
  });

  it("never sends the fields to an External Editor", async () => {
    await database.DB.prepare("UPDATE assets SET delivery_premium = 0").run();
    const photo = await seedAsset("photo", { deliveryPremium: true });
    const response = await request(`/api/projects/${ids.project}/assets?collection=edited`, "external");
    if (response.status === 200) for (const asset of ((await response.json()) as { assets: Json[] }).assets) { expect(asset).not.toHaveProperty("premium"); expect(asset).not.toHaveProperty("premiumUnlocked"); }
    expect(find(await list("edited"), photo.id)).toHaveProperty("premium", true);
  });
});
