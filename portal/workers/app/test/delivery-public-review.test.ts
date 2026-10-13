import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deliveryPageDtoSchema } from "@quincy/shared";
import { database, ids, request, seedFixture } from "./embedded-media-support";
import { clearDeliveryFlags, openDelivery, seedAsset, wipeDelivery } from "./delivery-support";
import { clearVideoFlags, seedVideoVersion } from "./video-review-support";
import { guestFetch, openGuestGate } from "./guest-support";

/** The public Delivery page carries the way into review per film (#847, ADR 0023), only while every condition holds. */
type Json = Record<string, any>;
beforeAll(async () => { await seedFixture(); await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run(); });
const wipe = async () => {
  await wipeDelivery();
  await database.DB.batch([
    database.DB.prepare("DELETE FROM guest_notification_digest"), database.DB.prepare("DELETE FROM guest_link_members"), database.DB.prepare("DELETE FROM guest_reviewers"),
    database.DB.prepare("DELETE FROM review_link_version_grants"), database.DB.prepare("DELETE FROM review_link_videos"), database.DB.prepare("DELETE FROM client_links"),
    database.DB.prepare("DELETE FROM video_premium_unlocks"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets"), database.DB.prepare("DELETE FROM videos"),
  ]);
};
beforeEach(async () => { await wipe(); await clearDeliveryFlags(); await openDelivery(ids.project); await openGuestGate(); });
afterEach(async () => { await wipe(); await clearDeliveryFlags(); await clearVideoFlags(); });

const publish = (assetIds: string[]) => request(`/api/projects/${ids.project}/delivery/publish`, "admin", "POST", { assetIds, expectedLatestSet: null, operationId: crypto.randomUUID() });
const premium = (videoId: string, value: boolean) => request(`/api/projects/${ids.project}/delivery/videos/${videoId}/premium`, "admin", "PUT", { premium: value });
const unlock = (videoId: string, unlocked: boolean) => request(`/api/projects/${ids.project}/delivery/videos/${videoId}/premium-unlock`, "admin", "PUT", { unlocked, ...(unlocked ? { paymentRef: "INV-1" } : {}) });
const slug = async () => (await database.DB.prepare("SELECT slug FROM delivery_pages WHERE project_id = ?").bind(ids.project).first<{ slug: string }>())!.slug;
async function page() {
  const response = await guestFetch(`/d/api/pages/${await slug()}`); expect(response.status).toBe(200);
  return deliveryPageDtoSchema.parse(await response.json());
}
const link = async () => (await database.DB.prepare("SELECT id, token_secret FROM client_links WHERE project_id = ? AND delivery_review = 1").bind(ids.project).first<Json>())!;
async function published() {
  const v = await seedVideoVersion({ title: "Hero" }); const photo = await seedAsset("photo");
  expect((await publish([v.assetId, photo.id])).ok).toBe(true);
  return { ...v, photo };
}

describe("review entry on the public Delivery page", () => {
  it("a film carries the link address with its Video id in the fragment; photos carry none", async () => {
    const v = await published(); const l = await link();
    const items = (await page()).items;
    const film = items.find((item) => item.kind === "video")!; const photo = items.find((item) => item.kind === "photo")!;
    expect(film.review).toEqual({ url: `/d/review?link=${l.id}#t=${l.token_secret}&v=${v.videoId}` });
    expect(photo.review).toBeNull();
  });

  it("a locked Premium film has none, and gets one once unlocked", async () => {
    const v = await published();
    expect((await premium(v.videoId, true)).ok).toBe(true);
    expect((await page()).items.find((item) => item.kind === "video")!.review).toBeNull();
    expect((await unlock(v.videoId, true)).ok).toBe(true);
    expect((await page()).items.find((item) => item.kind === "video")!.review).not.toBeNull();
    expect((await unlock(v.videoId, false)).ok).toBe(true);
    expect((await page()).items.find((item) => item.kind === "video")!.review).toBeNull();
  });

  it("none while the guest part of the gate is shut, the link is revoked, or the page is a miss", async () => {
    await published();
    await clearVideoFlags();
    expect((await page()).items.every((item) => item.review === null)).toBe(true);
    await openGuestGate();
    expect((await page()).items.find((item) => item.kind === "video")!.review).not.toBeNull();
    await database.DB.prepare("UPDATE client_links SET revoked_at = ? WHERE delivery_review = 1").bind(Date.now()).run();
    expect((await page()).items.every((item) => item.review === null)).toBe(true);
  });

  it("none when the film's published Version is no longer granted", async () => {
    await published();
    await database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ?").bind(Date.now(), ids.admin).run();
    expect((await page()).items.every((item) => item.review === null)).toBe(true);
  });

  it("staff Preview and the staff read carry none", async () => {
    const v = await published();
    const staff = await (await request(`/api/projects/${ids.project}/delivery`, "admin")).json() as Json;
    expect(JSON.stringify(staff)).not.toContain("/d/review");
    const preview = await request(`/api/projects/${ids.project}/delivery/preview`, "admin", "POST", { assetIds: [v.assetId] });
    expect(await preview.text()).not.toContain("/d/review");
  });
});

describe("leak sweep with a review entry", () => {
  it("the only credential on the page is the review address of the system link, nothing else leaks", async () => {
    const v = await published(); const l = await link();
    const response = await guestFetch(`/d/api/pages/${await slug()}`); const raw = await response.text();
    const dto = deliveryPageDtoSchema.parse(JSON.parse(raw));
    const entry = dto.items.find((item) => item.kind === "video")!.review!;
    expect(entry.url).toBe(`/d/review?link=${l.id}#t=${l.token_secret}&v=${v.videoId}`);
    // Redact that one field, then nothing internal may remain.
    const rest = raw.replace(JSON.stringify(entry.url), '""');
    for (const secret of [l.token_secret, l.id, v.videoId, v.assetId, ids.project, ids.admin, "projects/", "renditions/"]) expect(rest, `leaks ${secret}`).not.toContain(secret);
    // The review address is on the page route only: no item route carries it.
    const handle = dto.items.find((item) => item.kind === "video")!.handle;
    for (const part of ["media", "thumb", "download"]) {
      const item = await guestFetch(`/d/api/pages/${await slug()}/items/${handle}/${part}`);
      const text = `${[...item.headers].map(([n, x]) => `${n}: ${x}`).join("\n")}${await item.text()}`;
      expect(text).not.toContain(l.token_secret);
    }
  });
});
