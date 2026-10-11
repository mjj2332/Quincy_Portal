import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RENDITION_VARIANT_SPEC, enqueueDeliveryDerivativesSafely } from "@quincy/shared";
import { baseEnv, database, ids, request, seedFixture, type Who } from "./embedded-media-support";
import { clearDeliveryFlags, openDelivery, seedAsset, seedPage, wipeDelivery } from "./delivery-support";

/**
 * Delivery derivative enqueue (#787 slice 4). One rule for every trigger: a PHOTO needs `premium_preview` when it is premium and `delivery_web` when it is in a Delivery set, each unless a
 * row at the variant's current spec exists. Publish and marking premium call it from the routes; the Dropbox, Editor-output and AutoHDR carry sites call it after their batch.
 */
type Sent = { type: string; assetId: string; variants?: string[] };
const holder = baseEnv as unknown as { RENDITIONS_ENABLED?: boolean; RENDITION_QUEUE?: { send(message: unknown): Promise<void> } };
let sent: Sent[] = []; let failSends = false;
const queue = { send: async (message: unknown) => { if (failSends) throw new Error("queue down"); sent.push(message as Sent); } }; let saved: [boolean | undefined, typeof holder.RENDITION_QUEUE];
const op = () => crypto.randomUUID();
const publish = (assetIds: string[]) => request(`/api/projects/${ids.project}/delivery/publish`, "admin", "POST", { assetIds, expectedLatestSet: null, operationId: op() });
const mark = (assetId: string, premium: boolean) => request(`/api/projects/${ids.project}/assets/${assetId}/delivery-premium`, "admin", "PUT", { premium });
/** The route sends from `waitUntil`, after the response: wait for the sends to settle. */
const settled = async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return sent; };
const byAsset = (id: string) => sent.filter((message) => message.assetId === id);
const putRow = (assetId: string, variant: "delivery_web" | "premium_preview", specVersion: string = RENDITION_VARIANT_SPEC[variant]) =>
  database.DB.prepare("INSERT INTO asset_renditions (id, asset_id, variant, r2_key, bytes, content_type, width, height, spec_version, created_at) VALUES (?, ?, ?, ?, 40, 'image/jpeg', 1, 1, ?, ?)").bind(crypto.randomUUID(), assetId, variant, `renditions/${assetId}/${variant}`, specVersion, Date.now()).run();

beforeAll(async () => {
  await seedFixture();
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
});
const wipe = async () => {
  await wipeDelivery();
  await database.DB.batch([database.DB.prepare("DELETE FROM asset_renditions"), database.DB.prepare("DELETE FROM assets WHERE r2_key LIKE '%delivery-test%'")]);
};
beforeEach(async () => {
  await wipe(); await clearDeliveryFlags(); await openDelivery(ids.project);
  // One queue object for the whole file (the Worker keeps the first binding it sees), recording into the current test's array.
  sent = []; failSends = false; saved = [holder.RENDITIONS_ENABLED, holder.RENDITION_QUEUE];
  holder.RENDITIONS_ENABLED = true; holder.RENDITION_QUEUE = queue;
});
afterEach(async () => { [holder.RENDITIONS_ENABLED, holder.RENDITION_QUEUE] = saved; await wipe(); await clearDeliveryFlags(); });

describe("Publish", () => {
  it("asks for delivery_web for every photo, adds premium_preview for a premium one, and nothing for a PDF", async () => {
    const plain = await seedAsset("photo"); const premium = await seedAsset("photo", { deliveryPremium: true }); const plan = await seedAsset("floorplan_pdf"); const copy = await seedAsset("copy_pdf");
    const response = await publish([plain.id, premium.id, plan.id, copy.id]);
    expect(response.status).toBe(201);
    await settled();
    expect(byAsset(plain.id)).toEqual([{ type: "generate_renditions", assetId: plain.id, variants: ["delivery_web"] }]);
    expect(byAsset(premium.id)).toEqual([{ type: "generate_renditions", assetId: premium.id, variants: ["delivery_web", "premium_preview"] }]);
    expect(byAsset(plan.id)).toEqual([]); expect(byAsset(copy.id)).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it("skips a variant that already has a row at its current spec and re-asks for a stale one", async () => {
    const current = await seedAsset("photo"); const stale = await seedAsset("photo", { deliveryPremium: true });
    await putRow(current.id, "delivery_web"); await putRow(stale.id, "delivery_web", "legacy"); await putRow(stale.id, "premium_preview");
    expect((await publish([current.id, stale.id])).status).toBe(201);
    await settled();
    expect(byAsset(current.id)).toEqual([]);
    expect(byAsset(stale.id)).toEqual([{ type: "generate_renditions", assetId: stale.id, variants: ["delivery_web"] }]);
  });

  it("does not fail the Publish when the queue send fails", async () => {
    const photo = await seedAsset("photo"); failSends = true;
    expect((await publish([photo.id])).status).toBe(201); await settled();
    expect(sent).toEqual([]);
  });
});

describe("marking premium", () => {
  it("asks for premium_preview for a photo even before it is published", async () => {
    const photo = await seedAsset("photo");
    expect((await mark(photo.id, true)).status).toBe(200); await settled();
    expect(sent).toEqual([{ type: "generate_renditions", assetId: photo.id, variants: ["premium_preview"] }]);
  });

  it("also asks for delivery_web when the photo is already in a set", async () => {
    const photo = await seedAsset("photo"); await seedPage({ assetIds: [photo.id] });
    expect((await mark(photo.id, true)).status).toBe(200); await settled();
    expect(sent).toEqual([{ type: "generate_renditions", assetId: photo.id, variants: ["delivery_web", "premium_preview"] }]);
  });

  it("sends nothing for a PDF, for un-marking, or when the preview is already current", async () => {
    const plan = await seedAsset("floorplan_pdf"); expect((await mark(plan.id, true)).status).toBe(200);
    const photo = await seedAsset("photo", { deliveryPremium: true }); await putRow(photo.id, "premium_preview");
    expect((await mark(photo.id, true)).status).toBe(200);
    const off = await seedAsset("photo"); expect((await mark(off.id, false)).status).toBe(200);
    await settled(); expect(sent).toEqual([]);
  });
});

describe("the shared enqueue rule (also the carry sites')", () => {
  const env = () => ({ DB: database.DB, RENDITIONS_ENABLED: holder.RENDITIONS_ENABLED, RENDITION_QUEUE: holder.RENDITION_QUEUE });

  it("asks for premium_preview for a carried-premium successor that is in no set, and not for an ordinary new photo", async () => {
    const carried = await seedAsset("photo", { deliveryPremium: true }); const ordinary = await seedAsset("photo");
    expect(await enqueueDeliveryDerivativesSafely(env(), [carried.id, ordinary.id], "test")).toBe(1);
    expect(sent).toEqual([{ type: "generate_renditions", assetId: carried.id, variants: ["premium_preview"] }]);
  });

  it("ignores ids that are not photos or do not exist, and never sends while the gate is shut or the queue is unbound", async () => {
    const plan = await seedAsset("floorplan_pdf", { deliveryPremium: true });
    expect(await enqueueDeliveryDerivativesSafely(env(), [plan.id, crypto.randomUUID()], "test")).toBe(0);
    const photo = await seedAsset("photo", { deliveryPremium: true });
    expect(await enqueueDeliveryDerivativesSafely({ ...env(), RENDITIONS_ENABLED: false }, [photo.id], "test")).toBe(0);
    expect(await enqueueDeliveryDerivativesSafely({ ...env(), RENDITION_QUEUE: undefined }, [photo.id], "test")).toBe(0);
    expect(sent).toEqual([]);
  });
});
