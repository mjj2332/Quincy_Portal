import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assetPremiumResponseSchema } from "@quincy/shared";
import { database, ids, request, seedFixture, type Who } from "./embedded-media-support";
import { clearDeliveryFlags, openDelivery, seedAsset, seedPage, seedUnlock, setDeliveryFlags, wipeDelivery } from "./delivery-support";
import { seedVideoVersion } from "./video-review-support";

/** Photo and document premium, Unlock and Re-lock (#787 slice 2): the order matrix, the capabilities, idempotence, the audit rows and the live-premium rule. */
type Json = Record<string, any>;
const p = (rest: string, projectId: string = ids.project) => `/api/projects/${projectId}${rest}`;
const premiumPath = (assetId: string, projectId?: string) => p(`/assets/${assetId}/delivery-premium`, projectId);
const unlockPath = (assetId: string, projectId?: string) => p(`/assets/${assetId}/delivery-premium-unlock`, projectId);
const mark = (assetId: string, premium: unknown, who: Who = "admin") => request(premiumPath(assetId), who, "PUT", { premium });
const unlock = (assetId: string, body: unknown, who: Who = "admin") => request(unlockPath(assetId), who, "PUT", body);

beforeAll(async () => { await seedFixture(); });
const wipe = async () => {
  await wipeDelivery();
  await database.DB.batch([database.DB.prepare("DELETE FROM video_premium_unlocks"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets"), database.DB.prepare("DELETE FROM videos")]);
};
beforeEach(async () => { await wipe(); await clearDeliveryFlags(); await openDelivery(ids.project, ids.archivedProject); });
afterEach(async () => { await wipe(); await clearDeliveryFlags(); });

const flagOf = async (assetId: string) => (await database.DB.prepare("SELECT delivery_premium AS d, is_premium AS legacy FROM assets WHERE id = ?").bind(assetId).first<{ d: number; legacy: number }>())!;
const unlockRow = (assetId: string) => database.DB.prepare("SELECT * FROM asset_premium_unlocks WHERE asset_id = ?").bind(assetId).first<Json>();
const audits = async (...actions: string[]) => (await database.DB.prepare(`SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE action IN (${actions.map(() => "?").join(",")}) ORDER BY created_at, rowid`).bind(...actions).all<Json>()).results;

describe("the gate and the route order", () => {
  const calls = (assetId: string, projectId?: string): Array<[string, Json]> => [[premiumPath(assetId, projectId), { premium: true }], [unlockPath(assetId, projectId), { unlocked: true }]];

  it("answers 400 for a malformed id before anything else, even with the gate closed", async () => {
    await clearDeliveryFlags();
    for (const path of ["/api/projects/not-a-uuid/assets/" + crypto.randomUUID() + "/delivery-premium", p("/assets/nope/delivery-premium"), p("/assets/nope/delivery-premium-unlock")])
      expect((await request(path, "photographer", "PUT", { premium: true })).status, path).toBe(400);
  });

  it("answers one 404 for a real and an unknown id when the master, the scope or the Project's pilot row is off", async () => {
    const asset = await seedAsset("photo");
    for (const flags of [[], ["client_delivery"], [`client_delivery_pilot:${ids.project}`], ["client_delivery", `client_delivery_pilot:${ids.otherProject}`], ["client_delivery", [`client_delivery_pilot:${ids.project}`, false]]] as Array<Array<string | [string, boolean]>>) {
      await clearDeliveryFlags(); await setDeliveryFlags(...flags);
      for (const [path, body] of [...calls(asset.id), ...calls(crypto.randomUUID())]) {
        for (const who of ["admin", "member", "photographer", "external"] as const) {
          const response = await request(path, who, "PUT", body);
          expect(response.status, `${who} ${path} ${JSON.stringify(flags)}`).toBe(404);
          expect(await response.json()).toEqual({ error: "Not found" });
        }
      }
    }
    expect((await flagOf(asset.id)).d).toBe(0);
  });

  it("opens with the master flag and either the all-projects flag or the Project's pilot row", async () => {
    const asset = await seedAsset("photo");
    await clearDeliveryFlags(); await setDeliveryFlags("client_delivery", "client_delivery_all_projects");
    expect((await mark(asset.id, true)).status).toBe(200);
  });

  it("checks the capability after the gate: Admin and Editor may, a Photographer and an External may not", async () => {
    const asset = await seedAsset("photo");
    for (const [path, body] of calls(asset.id)) {
      for (const who of ["admin", "member"] as const) expect((await request(path, who, "PUT", body)).status, `${who} ${path}`).toBe(200);
      for (const who of ["photographer", "external", "externalOutsider"] as const) expect((await request(path, who, "PUT", body)).status, `${who} ${path}`).toBe(403);
    }
  });

  it("answers 409 project_archived on an archived Project before the row lookup and the body, and 404 for an unknown asset on a live Project before the body", async () => {
    const unknown = crypto.randomUUID();
    for (const [path, body] of [...calls(unknown, ids.archivedProject), [premiumPath(unknown, ids.archivedProject), { nonsense: 1 }] as [string, Json]]) {
      const response = await request(path, "admin", "PUT", body);
      expect(response.status, path).toBe(409); expect(await response.json()).toMatchObject({ code: "project_archived" });
    }
    for (const path of [premiumPath(unknown), unlockPath(unknown)]) expect((await request(path, "admin", "PUT", { nonsense: 1 })).status, path).toBe(404);
  });

  it("answers 404 for an asset of another Project or one that is not current", async () => {
    const other = await seedAsset("photo", { projectId: ids.otherProject }); const old = await seedAsset("photo", { superseded: true });
    await openDelivery(ids.otherProject);
    for (const asset of [other, old]) for (const path of [premiumPath(asset.id), unlockPath(asset.id)]) expect((await request(path, "admin", "PUT", { premium: true, unlocked: true })).status, path).toBe(404);
    expect((await request(premiumPath(other.id, ids.otherProject), "admin", "PUT", { premium: true })).status).toBe(200);
  });

  it("answers 400 for a body that is not exactly the contract", async () => {
    const asset = await seedAsset("photo");
    for (const body of [{}, { premium: "yes" }, { premium: true, extra: 1 }, []]) expect((await request(premiumPath(asset.id), "admin", "PUT", body)).status, JSON.stringify(body)).toBe(400);
    for (const body of [{}, { unlocked: 1 }, { unlocked: true, extra: 1 }, { unlocked: true, paymentRef: "" }, { unlocked: true, paymentRef: "x".repeat(201) }, { unlocked: true, paymentRef: 5 }]) expect((await request(unlockPath(asset.id), "admin", "PUT", body)).status, JSON.stringify(body)).toBe(400);
    expect((await flagOf(asset.id)).d).toBe(0); expect(await unlockRow(asset.id)).toBeNull();
  });
});

describe("which Assets can be premium", () => {
  it("accepts a photo, a Floorplan PDF and a Copy document", async () => {
    for (const kind of ["photo", "floorplan_pdf", "copy_pdf"] as const) {
      const asset = await seedAsset(kind, { versionGroupId: crypto.randomUUID() });
      expect((await mark(asset.id, true)).status, kind).toBe(200);
      expect((await flagOf(asset.id)).d, kind).toBe(1);
    }
  });

  it("refuses a Floorplan preview (its PDF carries the state) and a Video Version (the Video carries it) with 409 not_premium_eligible, writing nothing", async () => {
    const preview = await seedAsset("floorplan_preview", { versionGroupId: crypto.randomUUID() }); const video = await seedVideoVersion({});
    for (const id of [preview.id, video.assetId]) {
      for (const response of [await mark(id, true), await unlock(id, { unlocked: true })]) { expect(response.status, id).toBe(409); expect(await response.json()).toMatchObject({ code: "not_premium_eligible" }); }
      expect((await flagOf(id)).d).toBe(0); expect(await unlockRow(id)).toBeNull();
    }
    expect(await audits("asset.delivery_premium_set", "asset.premium_unlock")).toHaveLength(0);
  });
});

describe("mark and unmark", () => {
  it("sets delivery_premium: 200 with the state, idempotent (no audit when nothing changes), audited as an asset, and never touches the deprecated is_premium", async () => {
    const asset = await seedAsset("photo");
    const response = await mark(asset.id, true);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(assetPremiumResponseSchema.parse(await response.json())).toEqual({ premium: true, premiumUnlocked: false });
    expect(await flagOf(asset.id)).toEqual({ d: 1, legacy: 0 });
    expect((await mark(asset.id, true)).status).toBe(200);
    expect(await audits("asset.delivery_premium_set")).toHaveLength(1);
    expect((await mark(asset.id, false, "member")).status).toBe(200);
    expect((await flagOf(asset.id)).d).toBe(0);
    const rows = await audits("asset.delivery_premium_set");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor_id: ids.admin, target_type: "asset", target_id: asset.id }); expect(rows[1]).toMatchObject({ actor_id: ids.member });
    expect(rows.map((row) => JSON.parse(row.meta_json).premium)).toEqual([true, false]);
    expect(JSON.parse(rows[0]!.meta_json)).toMatchObject({ projectId: ids.project });
  });

  it("is live: marking an Asset in the current set takes effect at once and leaves the set's membership alone", async () => {
    const asset = await seedAsset("photo"); await seedPage({ assetIds: [asset.id] });
    expect((await mark(asset.id, true)).status).toBe(200);
    expect((await flagOf(asset.id)).d).toBe(1);
    expect(await database.DB.prepare("SELECT COUNT(*) AS n FROM delivery_set_items WHERE asset_id = ?").bind(asset.id).first()).toEqual({ n: 1 });
  });

  it("unmarking is refused with 409 premium_published once the Asset is in the current set; Unlock and Re-lock still work, and a mis-mark before publishing can be undone", async () => {
    const asset = await seedAsset("photo", { deliveryPremium: true }); await seedPage({ assetIds: [asset.id] });
    const response = await mark(asset.id, false);
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "premium_published" });
    expect((await flagOf(asset.id)).d).toBe(1);
    expect(await audits("asset.delivery_premium_set")).toHaveLength(0);
    expect((await mark(asset.id, true)).status).toBe(200);
    expect((await unlock(asset.id, { unlocked: true })).status).toBe(200);
    expect((await unlock(asset.id, { unlocked: false })).status).toBe(200);
    expect((await flagOf(asset.id)).d).toBe(1);
  });

  it("an older set pins premium too: once published in any set, always premium", async () => {
    const asset = await seedAsset("photo", { deliveryPremium: true }); const other = await seedAsset("photo");
    await seedPage({ assetIds: [other.id], olderSets: [[asset.id]] });
    const response = await mark(asset.id, false);
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "premium_published" });
    expect((await flagOf(asset.id)).d).toBe(1);
  });

  it("the mutation SQL repeats the published fence, so a Publish racing the request cannot slip through", async () => {
    const asset = await seedAsset("photo", { deliveryPremium: true });
    const { setAssetPremium } = await import("../src/lib/asset-premium");
    const db = database.DB;
    const racing = new Proxy(db, { get(target, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => { await seedPage({ assetIds: [asset.id] }); return target.batch(statements); };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
    const result = await setAssetPremium(racing as D1Database, { projectId: ids.project, assetId: asset.id, principal: { id: ids.admin } as never, premium: false, now: Date.now() });
    expect(result).toBe("published");
    expect((await flagOf(asset.id)).d).toBe(1);
  });

  it("unmarking keeps an existing unlock row and reports it", async () => {
    const asset = await seedAsset("photo", { deliveryPremium: true }); await seedUnlock(asset.id);
    const response = await mark(asset.id, false);
    expect(assetPremiumResponseSchema.parse(await response.json())).toEqual({ premium: false, premiumUnlocked: true });
    expect(await unlockRow(asset.id)).not.toBeNull();
  });
});

describe("Unlock and Re-lock", () => {
  it("unlocks idempotently: one row with who, when and the Project, a payment reference change audited, a Re-lock deleting the row; the reference never reaches the audit row", async () => {
    const asset = await seedAsset("photo", { deliveryPremium: true });
    const unlocked = await unlock(asset.id, { unlocked: true, paymentRef: "INV-1001" });
    expect(unlocked.status, await unlocked.clone().text()).toBe(200);
    expect(assetPremiumResponseSchema.parse(await unlocked.json())).toEqual({ premium: true, premiumUnlocked: true });
    expect(await unlockRow(asset.id)).toMatchObject({ project_id: ids.project, unlocked_by: ids.admin, payment_ref: "INV-1001", unlocked_at: expect.any(Number) });

    expect((await unlock(asset.id, { unlocked: true, paymentRef: "INV-1001" })).status).toBe(200);
    expect(await audits("asset.premium_unlock")).toHaveLength(1);
    expect((await unlock(asset.id, { unlocked: true, paymentRef: "INV-2002" }, "member")).status).toBe(200);
    expect(await unlockRow(asset.id)).toMatchObject({ payment_ref: "INV-2002", unlocked_by: ids.admin });
    const rows = await audits("asset.premium_unlock");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor_id: ids.admin, target_type: "asset", target_id: asset.id });
    expect(JSON.parse(rows[0]!.meta_json)).toMatchObject({ projectId: ids.project, hasPaymentRef: true, paymentRefChanged: false });
    expect(JSON.parse(rows[1]!.meta_json)).toMatchObject({ hasPaymentRef: true, paymentRefChanged: true });
    expect(rows.map((row) => row.meta_json).join("")).not.toContain("INV-");

    const relocked = await unlock(asset.id, { unlocked: false }, "member");
    expect(relocked.status).toBe(200); expect(await relocked.json()).toEqual({ premium: true, premiumUnlocked: false });
    expect(await unlockRow(asset.id)).toBeNull();
    expect(await audits("asset.premium_relock")).toHaveLength(1);
    expect((await unlock(asset.id, { unlocked: false })).status).toBe(200);
    expect(await audits("asset.premium_relock")).toHaveLength(1);
  });

  it("records an Unlock with no payment reference as NULL and audits hasPaymentRef false", async () => {
    const asset = await seedAsset("copy_pdf", { deliveryPremium: true });
    expect((await unlock(asset.id, { unlocked: true })).status).toBe(200);
    expect((await unlockRow(asset.id))!.payment_ref).toBeNull();
    expect(JSON.parse((await audits("asset.premium_unlock"))[0]!.meta_json).hasPaymentRef).toBe(false);
  });

  it("allows unlocking an Asset that is not premium, as a Video does: the row matters once it is", async () => {
    const asset = await seedAsset("photo");
    expect((await unlock(asset.id, { unlocked: true })).status).toBe(200);
    expect(await unlockRow(asset.id)).not.toBeNull();
  });

  it("Unlocks and Re-locks a superseded Asset that is still a member of the current set; a superseded Asset outside it stays 404", async () => {
    const a = await seedAsset("photo", { deliveryPremium: true, superseded: true }); await seedPage({ assetIds: [a.id] });
    const response = await unlock(a.id, { unlocked: true });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ premium: true, premiumUnlocked: true });
    expect(await unlockRow(a.id)).not.toBeNull();
    expect((await unlock(a.id, { unlocked: false })).status).toBe(200);
    expect(await unlockRow(a.id)).toBeNull();
    const gone = await seedAsset("photo", { superseded: true });
    expect((await unlock(gone.id, { unlocked: true })).status).toBe(404);
  });

  it("a Re-lock whose Asset stops being eligible between the read and the DELETE writes nothing: no delete, no audit", async () => {
    const a = await seedAsset("photo", { deliveryPremium: true, superseded: true }); await seedPage({ assetIds: [a.id] });
    await seedUnlock(a.id);
    const { setAssetUnlock } = await import("../src/lib/asset-premium");
    const racing = new Proxy(database.DB, { get(target, key) {
      if (key === "batch") return async (statements: D1PreparedStatement[]) => { await wipeDelivery(); await seedUnlock(a.id); await seedPage({ assetIds: [] }); return target.batch(statements); };
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
    const result = await setAssetUnlock(racing as D1Database, { projectId: ids.project, assetId: a.id, principal: { id: ids.admin } as never, unlocked: false, paymentRef: null, now: Date.now() });
    expect(result).toBe("not_found");
    expect(await unlockRow(a.id)).not.toBeNull();
    expect(await audits("asset.premium_relock")).toHaveLength(0);
  });

  it("is live on a published Asset and keeps the set as it was", async () => {
    const asset = await seedAsset("floorplan_pdf", { deliveryPremium: true, versionGroupId: crypto.randomUUID() }); await seedPage({ assetIds: [asset.id] });
    expect((await unlock(asset.id, { unlocked: true, paymentRef: "INV-9" })).status).toBe(200);
    expect((await unlock(asset.id, { unlocked: false })).status).toBe(200);
    expect(await database.DB.prepare("SELECT COUNT(*) AS n FROM delivery_set_items WHERE asset_id = ?").bind(asset.id).first()).toEqual({ n: 1 });
  });
});
