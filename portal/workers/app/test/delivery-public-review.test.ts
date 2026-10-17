import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { deliveryItemDtoSchema, deliveryPageDtoSchema } from "@quincy/shared";
import { database, ids, request, seedFixture } from "./embedded-media-support";
import { clearDeliveryFlags, openDelivery, seedAsset, wipeDelivery } from "./delivery-support";
import { clearVideoFlags, clearVideoNotes, seedVideoNote, seedVideoVersion } from "./video-review-support";
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

describe("film title on the public Delivery page (#882)", () => {
  it("a film carries its Video title, trimmed, and a photo's title is null; the label stays", async () => {
    await published();
    await database.DB.prepare("UPDATE videos SET title = '  Hero  '").run();
    const items = (await page()).items;
    const film = items.find((item) => item.kind === "video")!; const photo = items.find((item) => item.kind === "photo")!;
    expect(film.title).toBe("Hero"); expect(film.label).toBe("Video 01");
    expect(photo.title).toBeNull(); expect(photo.label).toBe("Photo 01");
  });
  it("a locked Premium film shows its title too, with no review address, and an unlocked one still does", async () => {
    const v = await published();
    expect((await premium(v.videoId, true)).ok).toBe(true);
    const locked = (await page()).items.find((item) => item.kind === "video")!;
    expect(locked.locked).toBe(true); expect(locked.title).toBe("Hero"); expect(locked.review).toBeNull();
    expect((await unlock(v.videoId, true)).ok).toBe(true);
    expect((await page()).items.find((item) => item.kind === "video")!.title).toBe("Hero");
  });
});

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

/**
 * #882: the public page's film tile facts. `version` and `openNotes` are OPTIONAL keys of the shared item schema, emitted ONLY by the public read (always present there) and omitted by every
 * staff DTO, so an already-open staff tab with the old strict schema keeps parsing (deploy skew, lesson #858).
 */
describe("film tile facts on the public Delivery page (#882)", () => {
  afterEach(async () => { await clearVideoNotes(); });
  const filmOf = async () => (await page()).items.find((item) => item.kind === "video")!;
  /** A film with v1 (old, noisy) and v2 (the published Version), the Delivery link granted both. */
  async function twoVersions() {
    const v1 = await seedVideoVersion({ title: "Hero" }); const v2 = await seedVideoVersion({ videoId: v1.videoId, version: 2 });
    expect((await publish([v2.assetId])).ok).toBe(true);
    return { v1, v2 };
  }

  it("carries the published Version and the count of public open root notes on that Version only", async () => {
    const { v1, v2 } = await twoVersions();
    await seedVideoNote({ assetId: v1.assetId, body: "old version" });
    await seedVideoNote({ assetId: v2.assetId, body: "open" }); await seedVideoNote({ assetId: v2.assetId, body: "guest", guest: true });
    await seedVideoNote({ assetId: v2.assetId, visibility: "internal", body: "internal" });
    await seedVideoNote({ assetId: v2.assetId, resolvedBy: ids.member, body: "resolved" });
    const parent = await seedVideoNote({ assetId: v2.assetId, body: "open with reply" }); await seedVideoNote({ assetId: v2.assetId, parentId: parent.id, body: "a reply" });
    await seedVideoNote({ assetId: v2.assetId, deletedAt: Date.now(), body: "tombstone, no replies" });
    const kept = await seedVideoNote({ assetId: v2.assetId, deletedAt: Date.now(), body: "tombstone with a reply" }); await seedVideoNote({ assetId: v2.assetId, parentId: kept.id, body: "a reply" });
    const film = await filmOf();
    expect(film.version).toBe(2); expect(film.openNotes).toBe(4);
  });

  it("is 0 for a finished film (the page hides the count at 0)", async () => {
    await twoVersions(); const film = await filmOf(); expect(film.version).toBe(2); expect(film.openNotes).toBe(0);
  });

  it("both are null on a locked film, a non-film item, and a film with no review (gate shut, link revoked)", async () => {
    const v = await published(); await seedVideoNote({ assetId: v.assetId, body: "open" });
    expect((await filmOf()).openNotes).toBe(1);
    const photo = (await page()).items.find((item) => item.kind === "photo")!; expect(photo.version).toBeNull(); expect(photo.openNotes).toBeNull();
    await clearVideoFlags();
    let film = await filmOf(); expect(film.review).toBeNull(); expect(film.version).toBeNull(); expect(film.openNotes).toBeNull();
    await openGuestGate();
    expect((await premium(v.videoId, true)).ok).toBe(true);
    film = await filmOf(); expect(film.locked).toBe(true); expect(film.version).toBeNull(); expect(film.openNotes).toBeNull();
    expect((await unlock(v.videoId, true)).ok).toBe(true);
    expect((await filmOf()).openNotes).toBe(1);
    await database.DB.prepare("UPDATE client_links SET revoked_at = ? WHERE delivery_review = 1").bind(Date.now()).run();
    film = await filmOf(); expect(film.version).toBeNull(); expect(film.openNotes).toBeNull();
  });

  it("the public DTO ALWAYS has both keys, on every item", async () => {
    await published(); const response = await guestFetch(`/d/api/pages/${await slug()}`); const body = await response.json() as Json;
    for (const item of body.items) { expect(Object.keys(item)).toContain("version"); expect(Object.keys(item)).toContain("openNotes"); }
  });

  it("the public item key set includes title, version and openNotes", async () => {
    await published(); const body = await (await guestFetch(`/d/api/pages/${await slug()}`)).json() as Json;
    for (const item of body.items) expect(Object.keys(item).sort()).toEqual(["handle", "kind", "label", "position", "locked", "premium", "width", "height", "durationMs", "url", "thumbUrl", "review", "title", "version", "openNotes"].sort());
  });

  describe("staff Preview titles (#882)", () => {
    it("carries a top-level `titles` map for films only (trimmed) and no `title` key inside the dto", async () => {
      const v = await published(); await database.DB.prepare("UPDATE videos SET title = '  Hero  '").run();
      const preview = await (await request(`/api/projects/${ids.project}/delivery/preview`, "admin", "POST", { assetIds: [v.assetId, v.photo.id] })).json() as Json;
      for (const item of preview.dto.items) expect(Object.keys(item)).not.toContain("title");
      const [film, photo] = preview.dto.items as Json[];
      expect(preview.titles).toEqual({ [film.handle]: "Hero" });
      expect(Object.keys(preview.titles)).not.toContain(photo.handle);
    });
  });

  describe("staff DTOs omit the keys entirely", () => {
    const BASE_KEYS = ["handle", "kind", "label", "position", "locked", "premium", "width", "height", "durationMs", "url", "thumbUrl", "review"].sort();
    it("pins the staff read, Preview and Publish item key set, so a later change cannot leak the public-only facts", async () => {
      const v = await published(); await seedVideoNote({ assetId: v.assetId, body: "open" });
      const state = await (await request(`/api/projects/${ids.project}/delivery`, "admin")).json() as Json;
      const preview = await (await request(`/api/projects/${ids.project}/delivery/preview`, "admin", "POST", { assetIds: [v.assetId, v.photo.id] })).json() as Json;
      const republish = await (await request(`/api/projects/${ids.project}/delivery/publish`, "admin", "POST", { assetIds: [v.assetId, v.photo.id], expectedLatestSet: 1, operationId: crypto.randomUUID() })).json() as Json;
      for (const [name, items] of [["state", state.dto.items], ["preview", preview.dto.items], ["publish", republish.dto.items]] as Array<[string, Json[]]>) {
        expect(items.length, name).toBeGreaterThan(0);
        for (const item of items) expect(Object.keys(item).sort(), name).toEqual(BASE_KEYS);
      }
    });
    it("an old staff-style strict parse still accepts the staff DTO, and rejects the public one (the designed Reload screen)", async () => {
      const v = await published();
      const oldItem = deliveryItemDtoSchema.omit({ version: true, openNotes: true, title: true });
      const state = await (await request(`/api/projects/${ids.project}/delivery`, "admin")).json() as Json;
      expect(z.array(oldItem).safeParse(state.dto.items).success).toBe(true);
      const publicBody = await (await guestFetch(`/d/api/pages/${await slug()}`)).json() as Json;
      expect(z.array(oldItem).safeParse(publicBody.items).success).toBe(false);
      expect(v.photo.id).toBeTruthy();
    });
  });
});
