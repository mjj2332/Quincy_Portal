import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inCurrentSetSql, lockedSql } from "../src/lib/delivery-lock";
import { database, ids, seedFixture } from "./embedded-media-support";
import { seedAsset, seedPage, seedUnlock, wipeDelivery } from "./delivery-support";
import { seedVideoVersion } from "./video-review-support";

/** `lockedSql(alias)` (#787): one answer to "is this item locked" for every kind of Asset. Nothing public uses it yet. */
beforeAll(async () => { await seedFixture(); });
beforeEach(async () => {
  await wipeDelivery();
  await database.DB.batch([database.DB.prepare("DELETE FROM video_premium_unlocks"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets"), database.DB.prepare("DELETE FROM videos")]);
});

const lockedOf = async (assetId: string, alias = "a") => (await database.DB.prepare(`SELECT ${lockedSql(alias)} AS locked FROM assets ${alias} WHERE ${alias}.id = ?`).bind(assetId).first<{ locked: number }>())!.locked;

describe("lockedSql: photos and documents", () => {
  it("is 0 for an unflagged Asset of every kind", async () => {
    for (const kind of ["photo", "floorplan_pdf", "floorplan_preview", "copy_pdf"] as const) expect(await lockedOf((await seedAsset(kind)).id), kind).toBe(0);
  });

  it("is 1 for a flagged photo and a flagged Copy document, and 0 once an unlock row exists", async () => {
    for (const kind of ["photo", "copy_pdf"] as const) {
      const asset = await seedAsset(kind, { deliveryPremium: true });
      expect(await lockedOf(asset.id), kind).toBe(1);
      await seedUnlock(asset.id);
      expect(await lockedOf(asset.id), `${kind} unlocked`).toBe(0);
    }
  });

  it("keeps an unlock row without the flag unlocked, and answers for a superseded Asset the same way", async () => {
    const unflagged = await seedAsset("photo"); await seedUnlock(unflagged.id);
    expect(await lockedOf(unflagged.id)).toBe(0);
    expect(await lockedOf((await seedAsset("photo", { deliveryPremium: true, superseded: true })).id)).toBe(1);
  });

  it("works under any alias", async () => {
    expect(await lockedOf((await seedAsset("photo", { deliveryPremium: true })).id, "item")).toBe(1);
  });
});

describe("lockedSql: a Floorplan preview resolves to its PDF", () => {
  const pair = async (input: { deliveryPremium?: boolean; version?: number; group?: string } = {}) => {
    const versionGroupId = input.group ?? crypto.randomUUID(); const version = input.version ?? 1;
    return { pdf: await seedAsset("floorplan_pdf", { versionGroupId, version, deliveryPremium: input.deliveryPremium }), preview: await seedAsset("floorplan_preview", { versionGroupId, version }), versionGroupId };
  };

  it("locks the preview when its PDF is locked, and unlocks it with the PDF's unlock", async () => {
    const { pdf, preview } = await pair({ deliveryPremium: true });
    expect(await lockedOf(pdf.id)).toBe(1);
    expect(await lockedOf(preview.id)).toBe(1);
    await seedUnlock(pdf.id);
    expect(await lockedOf(pdf.id)).toBe(0);
    expect(await lockedOf(preview.id)).toBe(0);
  });

  it("does not lock a preview whose PDF is not premium, and reads only the same version of the group", async () => {
    const { pdf, preview, versionGroupId } = await pair();
    expect(await lockedOf(preview.id)).toBe(0);
    const v2 = await pair({ group: versionGroupId, version: 2, deliveryPremium: true });
    expect(await lockedOf(v2.preview.id)).toBe(1);
    expect(await lockedOf(preview.id)).toBe(0);
    expect(await lockedOf(pdf.id)).toBe(0);
  });

  it("uses an unlock on the preview's own id for nothing: the PDF decides", async () => {
    const { preview } = await pair({ deliveryPremium: true });
    await seedUnlock(preview.id);
    expect(await lockedOf(preview.id)).toBe(1);
  });

  it("falls back to the preview's own flag when no PDF is found", async () => {
    expect(await lockedOf((await seedAsset("floorplan_preview", { deliveryPremium: true })).id)).toBe(1);
    expect(await lockedOf((await seedAsset("floorplan_preview")).id)).toBe(0);
  });
});

describe("lockedSql: a Video Version", () => {
  it("is 1 for every Version of a premium Video until the Video is unlocked, and 0 when the Video is not premium", async () => {
    const v1 = await seedVideoVersion({ title: "Hero" }); const v2 = await seedVideoVersion({ videoId: v1.videoId, version: 2 });
    expect(await lockedOf(v1.assetId)).toBe(0);
    await database.DB.prepare("UPDATE videos SET premium = 1 WHERE id = ?").bind(v1.videoId).run();
    expect(await lockedOf(v1.assetId)).toBe(1);
    expect(await lockedOf(v2.assetId)).toBe(1);
    await database.DB.prepare("INSERT INTO video_premium_unlocks (video_id, project_id, unlocked_by, unlocked_at) VALUES (?, ?, ?, ?)").bind(v1.videoId, ids.project, ids.admin, Date.now()).run();
    expect(await lockedOf(v1.assetId)).toBe(0);
    expect(await lockedOf(v2.assetId)).toBe(0);
  });

  it("ignores assets.delivery_premium and asset_premium_unlocks for a Video Version", async () => {
    const v = await seedVideoVersion({});
    await database.DB.prepare("UPDATE assets SET delivery_premium = 1 WHERE id = ?").bind(v.assetId).run();
    expect(await lockedOf(v.assetId)).toBe(0);
    await database.DB.prepare("UPDATE videos SET premium = 1 WHERE id = ?").bind(v.videoId).run();
    await seedUnlock(v.assetId);
    expect(await lockedOf(v.assetId)).toBe(1);
  });

  it("does not let another Video's unlock open this one", async () => {
    const a = await seedVideoVersion({}); const b = await seedVideoVersion({});
    await database.DB.prepare("UPDATE videos SET premium = 1").run();
    await database.DB.prepare("INSERT INTO video_premium_unlocks (video_id, project_id, unlocked_by, unlocked_at) VALUES (?, ?, ?, ?)").bind(a.videoId, ids.project, ids.admin, Date.now()).run();
    expect(await lockedOf(a.assetId)).toBe(0);
    expect(await lockedOf(b.assetId)).toBe(1);
  });
});

describe("inCurrentSetSql", () => {
  const inCurrent = async (...assetIds: string[]) => (await database.DB.prepare(`SELECT ${inCurrentSetSql(`IN (${assetIds.map(() => "?").join(", ")})`)} AS hit`).bind(...assetIds).first<{ hit: number }>())!.hit;

  it("is 1 only for an Asset in the latest set of a page, and 0 for one only in an older set", async () => {
    const older = await seedAsset("photo"); const current = await seedAsset("photo"); const never = await seedAsset("photo");
    await seedPage({ assetIds: [current.id], olderSets: [[older.id]] });
    expect(await inCurrent(current.id)).toBe(1);
    expect(await inCurrent(older.id)).toBe(0);
    expect(await inCurrent(never.id)).toBe(0);
    expect(await inCurrent(never.id, current.id)).toBe(1);
  });
});
