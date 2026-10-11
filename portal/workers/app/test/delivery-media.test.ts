import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RENDITION_SPEC_VERSION } from "@quincy/shared";
import { database, ids, pngBytes, request, seedFixture, type Who } from "./embedded-media-support";
import { clearDeliveryFlags, openDelivery, seedAsset, seedPage, seedRawPhoto, setDeliveryFlags, wipeDelivery } from "./delivery-support";
import { seedVideoVersion } from "./video-review-support";

/**
 * Staff media for the Delivery tab (#787 slice 5). Set items are keyed by their handle and served while they are in the page's CURRENT set (a superseded member included, which
 * `/media/asset/:id/:variant` refuses). Preview media is keyed by Asset id for an unpublished selection, gated by Client Delivery rather than the Video Review gate.
 */
type Json = Record<string, any>;
const base = (projectId: string = ids.project) => `/api/projects/${projectId}/delivery`;
const item = (handle: string, part: "media" | "thumb", who: Who = "admin", projectId?: string, init?: { range?: string; method?: string }) => raw(`${base(projectId)}/items/${handle}/${part}`, who, init);
const previewMedia = (assetId: string, part: "media" | "thumb", who: Who = "admin", projectId?: string, init?: { range?: string; method?: string }) => raw(`${base(projectId)}/preview-media/${assetId}/${part}`, who, init);
async function raw(path: string, who: Who, init: { range?: string; method?: string } = {}) {
  const { cookie } = await import("./embedded-media-support");
  const headers = new Headers({ cookie: await cookie(who) }); if (init.range) headers.set("range", init.range);
  const { SELF } = await import("cloudflare:test");
  return SELF.fetch(`https://portal.test${path}`, { method: init.method ?? "GET", headers });
}

beforeAll(async () => { await seedFixture(); });
const wipe = async () => { await wipeDelivery(); await database.DB.batch([database.DB.prepare("DELETE FROM asset_renditions"), database.DB.prepare("DELETE FROM video_premium_unlocks"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets"), database.DB.prepare("DELETE FROM videos")]); };
beforeEach(async () => { await wipe(); await clearDeliveryFlags(); await openDelivery(ids.project, ids.archivedProject); });
afterEach(async () => { await wipe(); await clearDeliveryFlags(); });

/** A photo with a cached web and thumb rendition, so the staff variant route answers bytes without the Images service. */
async function photoWithRenditions(extra: { superseded?: boolean } = {}) {
  const photo = await seedAsset("photo", { superseded: extra.superseded });
  for (const variant of ["web", "thumb"] as const) {
    const key = `renditions/${photo.id}/${variant}`; await database.MEDIA.put(key, pngBytes(40), { httpMetadata: { contentType: "image/webp" } });
    await database.DB.prepare("INSERT INTO asset_renditions (id, asset_id, variant, r2_key, bytes, content_type, width, height, spec_version, created_at) VALUES (?, ?, ?, ?, 40, 'image/webp', 1, 1, ?, ?)").bind(crypto.randomUUID(), photo.id, variant, key, RENDITION_SPEC_VERSION, Date.now()).run();
  }
  return photo;
}
const handleOf = async (assetId: string) => (await database.DB.prepare("SELECT handle FROM delivery_set_items WHERE asset_id = ? ORDER BY rowid DESC").bind(assetId).first<{ handle: string }>())!.handle;
const stateDto = async () => ((await (await request(base(), "admin")).json()) as Json).dto;

describe("set item media", () => {
  it("serves a current-set photo, its thumb, a PDF original, and a Video with Range and its poster", async () => {
    const photo = await photoWithRenditions(); const plan = await seedAsset("floorplan_pdf", { versionGroupId: crypto.randomUUID() }); const video = await seedVideoVersion({ poster: true });
    await database.MEDIA.put((await database.DB.prepare("SELECT r2_key AS k FROM assets WHERE id = ?").bind(plan.id).first<{ k: string }>())!.k, new Uint8Array([37, 80, 68, 70]));
    await seedPage({ assetIds: [photo.id, plan.id, video.assetId] });
    const [p, f, v] = [await handleOf(photo.id), await handleOf(plan.id), await handleOf(video.assetId)];
    expect((await item(p, "media")).status).toBe(200); expect((await item(p, "thumb")).headers.get("content-type")).toBe("image/webp");
    const pdf = await item(f, "media"); expect(pdf.status).toBe(200); expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect((await item(f, "thumb")).status).toBe(404);
    const ranged = await item(v, "media", "admin", undefined, { range: "bytes=0-9" });
    expect(ranged.status).toBe(206); expect(ranged.headers.get("content-range")).toMatch(/^bytes 0-9\/4096$/); expect((await ranged.arrayBuffer()).byteLength).toBe(10);
    expect((await item(v, "thumb")).headers.get("content-type")).toBe("image/jpeg");
  });

  it("serves a superseded member of the current set, which the by-id route refuses", async () => {
    const photo = await photoWithRenditions({ superseded: true });
    await seedPage({ assetIds: [photo.id] });
    expect((await request(`/media/asset/${photo.id}/web`, "admin")).status).toBe(404);
    expect((await item(await handleOf(photo.id), "media")).status).toBe(200);
  });

  it("answers 404 for a handle of an older set, an unknown handle, and a malformed one", async () => {
    const old = await photoWithRenditions(); const current = await photoWithRenditions();
    await seedPage({ assetIds: [current.id], olderSets: [[old.id]] });
    expect((await item(await handleOf(current.id), "media")).status).toBe(200);
    expect((await item(await handleOf(old.id), "media")).status).toBe(404);
    for (const handle of ["0123456789abcdef", "short", "UPPERCASE0123456", "../etc/passwd"]) expect((await item(handle, "media")).status, handle).toBe(404);
  });

  it("answers 404 for a Video that is no longer live, even from the current set", async () => {
    const video = await seedVideoVersion({ poster: true }); await seedPage({ assetIds: [video.assetId] });
    const handle = await handleOf(video.assetId);
    await database.DB.prepare("UPDATE video_version_meta SET removed_at = ? WHERE asset_id = ?").bind(Date.now(), video.assetId).run();
    expect((await item(handle, "media")).status).toBe(404); expect((await item(handle, "thumb")).status).toBe(404);
  });

  it("follows the route order: 400 id, gate 404, capability 403, then the item", async () => {
    const photo = await photoWithRenditions(); await seedPage({ assetIds: [photo.id] }); const handle = await handleOf(photo.id);
    expect((await item(handle, "media", "admin", "not-a-uuid")).status).toBe(400);
    await clearDeliveryFlags();
    for (const who of ["admin", "photographer", "external"] as const) expect((await item(handle, "media", who)).status, `closed ${who}`).toBe(404);
    await openDelivery(ids.project);
    for (const who of ["photographer", "external", "externalOutsider"] as const) expect((await item(handle, "media", who)).status, who).toBe(403);
    expect((await item(handle, "media", "member")).status).toBe(200);
  });

  it("marks every refusal private, no-store, and leaves a successful response's own header alone", async () => {
    const photo = await photoWithRenditions(); await seedPage({ assetIds: [photo.id] }); const handle = await handleOf(photo.id);
    const ok = await item(handle, "media"); expect(ok.status).toBe(200);
    const okHeader = ok.headers.get("cache-control");
    const missing = await item("0123456789abcdef", "media"); expect(missing.status).toBe(404); expect(missing.headers.get("cache-control")).toBe("private, no-store");
    const forbidden = await item(handle, "media", "photographer"); expect(forbidden.status).toBe(403); expect(forbidden.headers.get("cache-control")).toBe("private, no-store");
    const badId = await item(handle, "media", "admin", "not-a-uuid"); expect(badId.status).toBe(400); expect(badId.headers.get("cache-control")).toBe("private, no-store");
    const noPoster = await item(handle, "thumb", "admin"); expect(noPoster.status).toBe(200);
    const preview = await previewMedia(crypto.randomUUID(), "media"); expect(preview.status).toBe(404); expect(preview.headers.get("cache-control")).toBe("private, no-store");
    expect(okHeader).not.toBeNull();
    expect((await item(handle, "media")).headers.get("cache-control")).toBe(okHeader);
  });

  it("serves from an archived Project", async () => {
    const photo = await photoWithRenditions(); await seedPage({ projectId: ids.archivedProject, assetIds: [photo.id] });
    expect((await item(await handleOf(photo.id), "media", "admin", ids.archivedProject)).status).toBe(200);
  });

  it("is where the staff read points its DTO urls", async () => {
    const photo = await photoWithRenditions(); const plan = await seedAsset("copy_pdf"); await seedPage({ assetIds: [photo.id, plan.id] });
    const dto = await stateDto();
    for (const entry of dto.items) { expect(entry.url).toBe(`${base()}/items/${entry.handle}/media`); expect(entry.thumbUrl).toBe(entry.kind === "photo" ? `${base()}/items/${entry.handle}/thumb` : null); }
    expect(JSON.stringify(dto)).not.toContain(photo.id);
  });
});

describe("preview media", () => {
  it("serves an eligible photo, PDF and live Video Version by Asset id without the Video Review gate", async () => {
    const photo = await photoWithRenditions(); const video = await seedVideoVersion({ poster: true });
    await database.DB.prepare("DELETE FROM feature_flags WHERE key LIKE 'video_review%'").run();
    expect((await previewMedia(photo.id, "media")).status).toBe(200); expect((await previewMedia(photo.id, "thumb")).status).toBe(200);
    const ranged = await previewMedia(video.assetId, "media", "admin", undefined, { range: "bytes=10-19" });
    expect(ranged.status).toBe(206); expect(ranged.headers.get("content-range")).toBe("bytes 10-19/4096");
    expect((await previewMedia(video.assetId, "thumb")).headers.get("content-type")).toBe("image/jpeg");
    expect((await previewMedia(video.assetId, "media", "admin", undefined, { method: "HEAD" })).status).toBe(200);
  });

  it("refuses everything Publish would refuse with the same 404", async () => {
    const raw = await seedRawPhoto(); const other = await seedAsset("photo", { projectId: ids.otherProject }); const old = await photoWithRenditions({ superseded: true });
    const trashed = await seedVideoVersion(); await database.DB.prepare("UPDATE video_version_meta SET removed_at = ? WHERE asset_id = ?").bind(Date.now(), trashed.assetId).run();
    const preview = await seedAsset("floorplan_preview", { versionGroupId: crypto.randomUUID() });
    for (const id of [raw.id, other.id, old.id, trashed.assetId, preview.id, crypto.randomUUID()]) { expect((await previewMedia(id, "media")).status, id).toBe(404); expect((await previewMedia(id, "thumb")).status, id).toBe(404); }
    expect((await previewMedia("nope", "media")).status).toBe(400);
  });

  it("is gated by Client Delivery and viewClientPreview", async () => {
    const photo = await photoWithRenditions();
    for (const who of ["photographer", "external", "externalOutsider"] as const) expect((await previewMedia(photo.id, "media", who)).status, who).toBe(403);
    expect((await previewMedia(photo.id, "media", "member")).status).toBe(200);
    await clearDeliveryFlags(); await setDeliveryFlags("client_delivery");
    expect((await previewMedia(photo.id, "media")).status).toBe(404);
  });
});

describe("a locked item is shown to staff as the client sees it (#787 slice 9)", () => {
  const PREVIEW = "WATERMARKED-PREVIEW";
  const putPreview = async (assetId: string) => {
    const key = `renditions/${assetId}/premium_preview`; await database.MEDIA.put(key, new TextEncoder().encode(PREVIEW), { httpMetadata: { contentType: "image/jpeg" } });
    const { RENDITION_VARIANT_SPEC } = await import("@quincy/shared");
    await database.DB.prepare("INSERT INTO asset_renditions (id, asset_id, variant, r2_key, bytes, content_type, width, height, spec_version, created_at) VALUES (?, ?, 'premium_preview', ?, 19, 'image/jpeg', 1, 1, ?, ?)").bind(crypto.randomUUID(), assetId, key, RENDITION_VARIANT_SPEC.premium_preview, Date.now()).run();
  };
  const previewDto = async (assetIds: string[]) => ((await (await request(`${base()}/preview`, "admin", "POST", { assetIds })).json()) as Json).dto as Json;
  it("points a locked photo at premium_preview when it exists, serves only that, and never the clean web or thumb", async () => {
    const photo = await photoWithRenditions(); await database.DB.prepare("UPDATE assets SET delivery_premium = 1 WHERE id = ?").bind(photo.id).run(); await putPreview(photo.id);
    const dto = await previewDto([photo.id]);
    expect(dto.items[0].locked).toBe(true); expect(dto.items[0].url).toBe(`${base()}/preview-media/${photo.id}/media`);
    for (const part of ["media", "thumb"] as const) { const response = await previewMedia(photo.id, part); expect(response.status).toBe(200); expect(await response.text()).toBe(PREVIEW); }
  });
  it("has null urls for a locked photo with no premium_preview, and its staff routes answer 404", async () => {
    const photo = await photoWithRenditions(); await database.DB.prepare("UPDATE assets SET delivery_premium = 1 WHERE id = ?").bind(photo.id).run();
    const dto = await previewDto([photo.id]);
    expect([dto.items[0].url, dto.items[0].thumbUrl]).toEqual([null, null]);
    for (const part of ["media", "thumb"] as const) expect((await previewMedia(photo.id, part)).status).toBe(404);
  });
});
