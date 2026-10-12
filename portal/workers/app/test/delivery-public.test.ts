import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deliveryPageDtoSchema } from "@quincy/shared";
import { database, ids, seedFixture } from "./embedded-media-support";
import { clearDeliveryFlags, openDelivery, seedAsset, seedOpenProject, seedPage, seedUnlock, setDeliveryFlags, wipeDelivery } from "./delivery-support";
import { seedVideoVersion } from "./video-review-support";
import { guestFetch, HYGIENE } from "./guest-support";
import { publicDeliveryTestHooks } from "../src/delivery";

/**
 * The public read of a Delivery page (#787 slice 6): `/d/:slug`, `/d/api/pages/:slug` and `items/:handle/{media,thumb,download}`. No session, no cookie. Every miss (unknown, off, gate shut,
 * stale handle) is the one `/d` stub; a locked item never yields original bytes; a derivative that is not there is a 404, never the original.
 */
const SLUG = "12-test-street-bcdfgh";
const WEB = "DELIVERY-WEB-BYTES"; const PREVIEW = "PREMIUM-PREVIEW-BYTES"; const THUMB = "THUMB-RENDITION-BYTES"; const ORIGINAL = "ORIGINAL-FULL-RES-BYTES"; const SECRET_NAME = "SECRET-ORIGINAL-NAME.jpg";
const text = (value: string) => new TextEncoder().encode(value);
const snapshot = async (response: Response) => ({ status: response.status, body: await response.text(), headers: [...response.headers].filter(([name]) => name !== "server-timing").sort() });
const pageUrl = (slug = SLUG) => `/d/api/pages/${slug}`;
const itemUrl = (handle: string, part: "media" | "thumb" | "download", slug = SLUG) => `${pageUrl(slug)}/items/${handle}/${part}`;
const get = (path: string, init: { method?: string; range?: string } = {}) => guestFetch(path, { method: init.method, headers: init.range ? { range: init.range } : undefined });

beforeAll(async () => { await seedFixture(); });
const wipe = async () => { await wipeDelivery(); await database.DB.batch([database.DB.prepare("DELETE FROM asset_renditions"), database.DB.prepare("DELETE FROM video_premium_unlocks"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM videos"), database.DB.prepare("DELETE FROM assets WHERE r2_key LIKE '%delivery-test%' OR kind = 'video'")]); };
beforeEach(async () => { await wipe(); await clearDeliveryFlags(); await openDelivery(ids.project); publicDeliveryTestHooks.beforeServe = undefined; });
afterEach(async () => { publicDeliveryTestHooks.beforeServe = undefined; await wipe(); await clearDeliveryFlags(); });

const handleOf = async (assetId: string) => (await database.DB.prepare("SELECT handle FROM delivery_set_items WHERE asset_id = ? ORDER BY rowid DESC").bind(assetId).first<{ handle: string }>())!.handle;
async function putRendition(assetId: string, variant: "delivery_web" | "premium_preview" | "thumb", body: string, specVersion = "v1") {
  const key = `renditions/${assetId}/${variant}`; await database.MEDIA.put(key, text(body), { httpMetadata: { contentType: "image/jpeg" } });
  await database.DB.prepare("INSERT INTO asset_renditions (id, asset_id, variant, r2_key, bytes, content_type, width, height, spec_version, created_at) VALUES (?, ?, ?, ?, ?, 'image/jpeg', 1, 1, ?, ?)").bind(crypto.randomUUID(), assetId, variant, key, body.length, specVersion, Date.now()).run();
}
async function photo(input: { premium?: boolean; unlocked?: boolean; web?: boolean; preview?: boolean; thumb?: boolean } = {}) {
  const asset = await seedAsset("photo", { deliveryPremium: input.premium });
  await database.DB.prepare("UPDATE assets SET original_filename = ? WHERE id = ?").bind(SECRET_NAME, asset.id).run();
  await database.MEDIA.put(`projects/${asset.projectId}/delivery-test/${asset.id}`, text(ORIGINAL), { httpMetadata: { contentType: "image/jpeg" } });
  if (input.web !== false) await putRendition(asset.id, "delivery_web", WEB);
  if (input.preview) await putRendition(asset.id, "premium_preview", PREVIEW);
  if (input.thumb !== false) await putRendition(asset.id, "thumb", THUMB);
  if (input.unlocked) await seedUnlock(asset.id);
  return asset;
}
const body = async (response: Response) => await response.text();
const expectStub = async (response: Response) => expect(await snapshot(response)).toEqual(await snapshot(await guestFetch("/d")));

describe("page read: property", () => {
  const read = async (projectId: string, slug: string) => { const response = await get(pageUrl(slug)); expect(response.status).toBe(200); return { text: await response.text() }; };
  it("carries the postcode and the agency's business name, and nothing about the agent or a photographer", async () => {
    const projectId = await seedOpenProject({ street: "5 Rose Rd", suburb: "Newtown", postcode: "2042", agencyName: "Snapshot Realty", agentName: "Agent Smith-Zed", agentEmail: "smith.zed@example.com" });
    const a = await seedAsset("photo", { projectId }); await putRendition(a.id, "delivery_web", WEB);
    await seedPage({ projectId, slug: "5-rose-rd-bcdfgh", assetIds: [a.id] });
    const { text: raw } = await read(projectId, "5-rose-rd-bcdfgh");
    const dto = deliveryPageDtoSchema.parse(JSON.parse(raw));
    expect(dto.property).toEqual({ street: "5 Rose Rd", suburb: "Newtown", postcode: "2042", agency: "Snapshot Realty" });
    expect(raw).not.toMatch(/Smith-Zed|smith\.zed@example\.com|photographer/i);
  });
  it("prefers the directory agency's name over the snapshot name", async () => {
    const projectId = await seedOpenProject({ agencyName: "Old Snapshot Name", directoryAgency: "Directory Realty Pty" });
    const a = await seedAsset("photo", { projectId });
    await seedPage({ projectId, slug: "dir-agency-bcdfgh", assetIds: [a.id] });
    expect(deliveryPageDtoSchema.parse(JSON.parse((await read(projectId, "dir-agency-bcdfgh")).text)).property.agency).toBe("Directory Realty Pty");
  });
  it("is null for a postcode or agency that is unset or blank", async () => {
    const projectId = await seedOpenProject({ postcode: "  ", agencyName: "   " });
    const a = await seedAsset("photo", { projectId });
    await seedPage({ projectId, slug: "blank-bcdfgh", assetIds: [a.id] });
    expect(deliveryPageDtoSchema.parse(JSON.parse((await read(projectId, "blank-bcdfgh")).text)).property).toMatchObject({ postcode: null, agency: null });
  });
});

describe("page read", () => {
  it("answers the strict DTO for an enabled page with hygiene headers and handle URLs only", async () => {
    const a = await photo(); const b = await photo();
    await seedPage({ slug: SLUG, assetIds: [a.id, b.id] });
    const response = await get(pageUrl()); expect(response.status).toBe(200);
    for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
    const dto = deliveryPageDtoSchema.parse(await response.json());
    expect(dto.items.map((item) => item.label)).toEqual(["Photo 01", "Photo 02"]);
    const handle = await handleOf(a.id);
    expect(dto.items[0]).toMatchObject({ handle, url: itemUrl(handle, "media"), thumbUrl: itemUrl(handle, "thumb") });
  });

  it("serves only the latest set: an older set's handle is a stub", async () => {
    const oldOnly = await photo(); const kept = await photo();
    await seedPage({ slug: SLUG, assetIds: [kept.id], olderSets: [[oldOnly.id]] });
    const dto = deliveryPageDtoSchema.parse(await (await get(pageUrl())).json());
    expect(dto.setNumber).toBe(2); expect(dto.items).toHaveLength(1);
    await expectStub(await get(itemUrl(await handleOf(oldOnly.id), "media")));
  });

  it("answers off, unknown, unpublished-gate and handle misses with the byte-identical /d stub", async () => {
    const a = await photo();
    await seedPage({ slug: SLUG, assetIds: [a.id], enabled: false });
    const handle = await handleOf(a.id);
    await expectStub(await get(pageUrl())); await expectStub(await get(itemUrl(handle, "media")));
    await database.DB.prepare("UPDATE delivery_pages SET enabled = 1").run();
    expect((await get(pageUrl())).status).toBe(200);
    await expectStub(await get(pageUrl("unknown-page-bcdfgh")));
    await expectStub(await get(itemUrl("0123456789abcdef", "media")));
    await expectStub(await get(itemUrl("NOT-A-HANDLE", "media")));
    // The gate: master off, then master on without an all-projects or pilot row.
    await clearDeliveryFlags(); await expectStub(await get(pageUrl())); await expectStub(await get(itemUrl(handle, "media")));
    await setDeliveryFlags("client_delivery"); await expectStub(await get(pageUrl())); await expectStub(await get(itemUrl(handle, "media")));
    await setDeliveryFlags(["client_delivery_pilot:" + ids.project, false]); await expectStub(await get(pageUrl()));
    await clearDeliveryFlags(); await setDeliveryFlags("client_delivery", "client_delivery_all_projects"); expect((await get(pageUrl())).status).toBe(200);
  });

  it("keeps serving an archived Project", async () => {
    const projectId = await seedOpenProject({ archived: true }); const a = await seedAsset("photo", { projectId });
    await seedPage({ projectId, slug: "9-archived-road-cdfghj", assetIds: [a.id] });
    expect((await get(pageUrl("9-archived-road-cdfghj"))).status).toBe(200);
  });

  it("serves the SPA shell for ANY well-formed slug, live, off or unknown, and the stub for anything else", async () => {
    const a = await photo(); await seedPage({ slug: SLUG, assetIds: [a.id], enabled: false });
    const live = await snapshot(await guestFetch(`/d/${SLUG}`)); const unknown = await snapshot(await guestFetch("/d/no-such-page-bcdfgh"));
    expect(live.status).toBe(200); expect(unknown).toEqual(live);
    expect(live.headers.find(([name]) => name === "content-security-policy")?.[1]).toContain("frame-ancestors 'none'");
    expect(live.headers.find(([name]) => name === "x-robots-tag")?.[1]).toBe("noindex");
    // No hyphen, the reserved words, an encoded spelling, a trailing slash, an extra segment, upper case, a short suffix and a vowel in the suffix are all the stub.
    for (const path of ["/d/api", "/d/%31%32-test-street-bcdfgh", `/d/${SLUG}/`, `/d/${SLUG}/extra`, "/d/12-Test-Street-bcdfgh", "/d/12-test-street-bcdfg", "/d/12-test-street-bcdfga", "/d/12-test-street-bcdfgh%2F"]) {
      expect(await snapshot(await guestFetch(path)), path).toEqual(await snapshot(await guestFetch("/d")));
    }
  });

  it("answers an unsafe method on a public route with the stub, and never routes the media paths for other segments", async () => {
    const a = await photo(); await seedPage({ slug: SLUG, assetIds: [a.id] }); const handle = await handleOf(a.id);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      await expectStub(await guestFetch(pageUrl(), { method, body: {} })); await expectStub(await guestFetch(itemUrl(handle, "media"), { method, body: {} }));
    }
    await expectStub(await get(`${itemUrl(handle, "media")}/`)); await expectStub(await get(`${pageUrl()}/items/${handle}/original`)); await expectStub(await get(`${pageUrl()}/items/${handle}`));
  });
});

describe("single items", () => {
  it("serves an unlocked photo's media from delivery_web and its thumb from the thumb rendition, never the original", async () => {
    const a = await photo(); await seedPage({ slug: SLUG, assetIds: [a.id] }); const handle = await handleOf(a.id);
    const media = await get(itemUrl(handle, "media")); expect(media.status).toBe(200); expect(media.headers.get("content-type")).toBe("image/jpeg"); expect(await body(media)).toBe(WEB);
    for (const [name, value] of Object.entries(HYGIENE)) expect(media.headers.get(name), name).toBe(value);
    expect(await body(await get(itemUrl(handle, "thumb")))).toBe(THUMB);
  });

  it("answers 404 (the stub) when the derivative is missing or at a stale spec, and never falls back to the original", async () => {
    const noWeb = await photo({ web: false, thumb: false }); const stale = await photo({ web: false, thumb: false }); await putRendition(stale.id, "delivery_web", WEB, "legacy");
    await seedPage({ slug: SLUG, assetIds: [noWeb.id, stale.id] });
    for (const asset of [noWeb, stale]) {
      const handle = await handleOf(asset.id);
      for (const part of ["media", "thumb"] as const) { const response = await get(itemUrl(handle, part)); expect(response.status, part).toBe(404); expect(await body(response)).not.toContain(ORIGINAL); }
    }
  });

  it("shows a locked photo only as premium_preview on media and thumb, and refuses download with 403 premium_locked", async () => {
    const locked = await photo({ premium: true, preview: true }); await seedPage({ slug: SLUG, assetIds: [locked.id] }); const handle = await handleOf(locked.id);
    expect(await body(await get(itemUrl(handle, "media")))).toBe(PREVIEW); expect(await body(await get(itemUrl(handle, "thumb")))).toBe(PREVIEW);
    // The item address is the same locked or open, so nothing about it may be cached: a browser must ask again after an Unlock.
    for (const part of ["media", "thumb"] as const) expect((await get(itemUrl(handle, part))).headers.get("cache-control")).toBe("private, no-store");
    const refused = await get(itemUrl(handle, "download")); expect(refused.status).toBe(403); expect(await refused.json()).toEqual({ error: "premium_locked" });
    const dto = deliveryPageDtoSchema.parse(await (await get(pageUrl())).json()); expect(dto.items[0]!.locked).toBe(true); expect(dto.items[0]!.premium).toBe(true);
  });

  it("keeps `premium` true after an Unlock while `locked` goes false, and leaks nothing about the unlock", async () => {
    const paid = await photo({ premium: true, unlocked: true, preview: true }); const free = await photo(); await seedPage({ slug: SLUG, assetIds: [paid.id, free.id] });
    const text_ = await body(await get(pageUrl())); const dto = deliveryPageDtoSchema.parse(JSON.parse(text_));
    expect(dto.items.map((item) => [item.locked, item.premium])).toEqual([[false, true], [false, false]]);
    expect(text_).not.toMatch(/unlock|payment|paymentRef/i);
  });

  it("never serves a locked photo's web, thumb or original when premium_preview is missing", async () => {
    const locked = await photo({ premium: true, preview: false }); await seedPage({ slug: SLUG, assetIds: [locked.id] }); const handle = await handleOf(locked.id);
    for (const part of ["media", "thumb", "download"] as const) { const response = await get(itemUrl(handle, part)); expect([403, 404], part).toContain(response.status); const text_ = await body(response); for (const secret of [WEB, THUMB, ORIGINAL]) expect(text_).not.toContain(secret); }
  });

  it("answers the stub until the derivative is generated, then serves it, for a locked and an unlocked photo alike (#787 slice 4)", async () => {
    const locked = await photo({ premium: true, web: false, thumb: false }); const open = await photo({ web: false, thumb: false });
    await seedPage({ slug: SLUG, assetIds: [locked.id, open.id] }); const lockedHandle = await handleOf(locked.id); const openHandle = await handleOf(open.id);
    for (const handle of [lockedHandle, openHandle]) expect((await get(itemUrl(handle, "media"))).status).toBe(404);
    await putRendition(locked.id, "premium_preview", PREVIEW); await putRendition(open.id, "delivery_web", WEB);
    expect(await body(await get(itemUrl(lockedHandle, "media")))).toBe(PREVIEW);
    expect(await body(await get(itemUrl(openHandle, "media")))).toBe(WEB);
  });

  it("answers 403 on GET, HEAD and Range for a locked item BEFORE any R2 call (no object seeded at all)", async () => {
    const bare = await seedAsset("photo", { deliveryPremium: true }); await seedPage({ slug: SLUG, assetIds: [bare.id] }); const handle = await handleOf(bare.id);
    for (const init of [{}, { method: "HEAD" }, { range: "bytes=0-3" }, { method: "HEAD", range: "bytes=0-3" }]) expect((await get(itemUrl(handle, "download"), init)).status, JSON.stringify(init)).toBe(403);
  });

  it("goes live with an Unlock: the download serves the original as an attachment named from the address, never the original filename", async () => {
    const a = await photo({ premium: true, preview: true }); await seedPage({ slug: SLUG, assetIds: [a.id] }); const handle = await handleOf(a.id);
    expect((await get(itemUrl(handle, "download"))).status).toBe(403);
    await seedUnlock(a.id);
    expect(await body(await get(itemUrl(handle, "media")))).toBe(WEB);
    const download = await get(itemUrl(handle, "download")); expect(download.status).toBe(200); expect(await body(download)).toBe(ORIGINAL);
    const disposition = download.headers.get("content-disposition")!;
    expect(disposition).toMatch(/^attachment; filename="12-test-street-photo-01\.jpg"/); expect(disposition).not.toContain("SECRET");
    expect(download.headers.get("content-type")).toBe("image/jpeg");
    await database.DB.prepare("DELETE FROM asset_premium_unlocks WHERE asset_id = ?").bind(a.id).run();
    expect((await get(itemUrl(handle, "download"))).status).toBe(403);
    expect(await body(await get(itemUrl(handle, "media")))).toBe(PREVIEW);
  });

  it("serves an unlocked photo's download with HEAD and Range support", async () => {
    const a = await photo(); await seedPage({ slug: SLUG, assetIds: [a.id] }); const handle = await handleOf(a.id);
    const head = await get(itemUrl(handle, "download"), { method: "HEAD" }); expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe(String(ORIGINAL.length)); expect(await head.text()).toBe("");
    const ranged = await get(itemUrl(handle, "download"), { range: "bytes=0-7" }); expect(ranged.status).toBe(206); expect(await body(ranged)).toBe(ORIGINAL.slice(0, 8));
  });

  it("serves a Floorplan PDF inline and as a download when unlocked, and refuses every route while locked", async () => {
    const plan = await seedAsset("floorplan_pdf", { versionGroupId: crypto.randomUUID() });
    await database.MEDIA.put(`projects/${plan.projectId}/delivery-test/${plan.id}`, text("%PDF-1.4 floorplan"));
    await seedPage({ slug: SLUG, assetIds: [plan.id] }); const handle = await handleOf(plan.id);
    const inline = await get(itemUrl(handle, "media")); expect(inline.status).toBe(200); expect(inline.headers.get("content-type")).toBe("application/pdf"); expect(inline.headers.get("content-disposition")).toMatch(/^inline; filename="12-test-street-floorplan-01\.pdf"/);
    const download = await get(itemUrl(handle, "download")); expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="12-test-street-floorplan-01\.pdf"/);
    expect((await get(itemUrl(handle, "thumb"))).status).toBe(404);
    await database.DB.prepare("UPDATE assets SET delivery_premium = 1 WHERE id = ?").bind(plan.id).run();
    for (const part of ["media", "thumb", "download"] as const) { const response = await get(itemUrl(handle, part)); expect([403, 404], part).toContain(response.status); expect(await body(response)).not.toContain("%PDF"); }
    expect((await get(itemUrl(handle, "media"))).status).toBe(403);
  });
});

describe("videos", () => {
  it("streams a live Version with Range and HEAD, serves its poster, and downloads the original named from the address", async () => {
    const video = await seedVideoVersion({ poster: true }); await seedPage({ slug: SLUG, assetIds: [video.assetId] }); const handle = await handleOf(video.assetId);
    const ranged = await get(itemUrl(handle, "media"), { range: "bytes=0-9" }); expect(ranged.status).toBe(206); expect(ranged.headers.get("content-range")).toMatch(/^bytes 0-9\/4096$/); expect(ranged.headers.get("content-type")).toBe("video/mp4");
    expect(ranged.headers.get("content-disposition")).toBeNull();
    const head = await get(itemUrl(handle, "media"), { method: "HEAD" }); expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe("4096");
    expect((await get(itemUrl(handle, "thumb"))).headers.get("content-type")).toBe("image/jpeg");
    const download = await get(itemUrl(handle, "download")); expect(download.status).toBe(200); expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="12-test-street-video-01\.mp4"/);
  });

  it("is a stub for a Version that is no longer live (the #776 backstop), on every route and in the DTO", async () => {
    const video = await seedVideoVersion({ poster: true }); const keep = await photo(); await seedPage({ slug: SLUG, assetIds: [video.assetId, keep.id] }); const handle = await handleOf(video.assetId);
    await database.DB.prepare("UPDATE video_version_meta SET removed_at = ? WHERE asset_id = ?").bind(Date.now(), video.assetId).run();
    for (const part of ["media", "thumb", "download"] as const) await expectStub(await get(itemUrl(handle, part)));
    expect(deliveryPageDtoSchema.parse(await (await get(pageUrl())).json()).items.map((item) => item.kind)).toEqual(["photo"]);
  });

  it("refuses a locked Video on every route and lets an Unlock open it", async () => {
    const video = await seedVideoVersion({ poster: true }); await seedPage({ slug: SLUG, assetIds: [video.assetId] }); const handle = await handleOf(video.assetId);
    await database.DB.prepare("UPDATE videos SET premium = 1 WHERE id = ?").bind(video.videoId).run();
    for (const part of ["media", "thumb", "download"] as const) for (const init of [{}, { method: "HEAD" }, { range: "bytes=0-3" }]) expect((await get(itemUrl(handle, part), init)).status, `${part} ${JSON.stringify(init)}`).toBe(403);
    const dto = deliveryPageDtoSchema.parse(await (await get(pageUrl())).json()); expect(dto.items[0]).toMatchObject({ locked: true, url: null, thumbUrl: null });
    await database.DB.prepare("INSERT INTO video_premium_unlocks (video_id, project_id, unlocked_by, unlocked_at) VALUES (?, ?, ?, ?)").bind(video.videoId, ids.project, ids.admin, Date.now()).run();
    expect((await get(itemUrl(handle, "media"), { range: "bytes=0-3" })).status).toBe(206);
  });
});

describe("state that changes between the read and the serve", () => {
  it("serves nothing when the page is switched off after admission", async () => {
    const a = await photo(); await seedPage({ slug: SLUG, assetIds: [a.id] }); const handle = await handleOf(a.id);
    publicDeliveryTestHooks.beforeServe = async () => { await database.DB.prepare("UPDATE delivery_pages SET enabled = 0").run(); };
    for (const part of ["media", "download"] as const) {
      await database.DB.prepare("UPDATE delivery_pages SET enabled = 1").run();
      const response = await get(itemUrl(handle, part)); expect(response.status, part).toBe(404); expect(await body(response)).not.toContain("BYTES");
    }
  });

  it("serves nothing when a republish replaces the set after admission", async () => {
    const a = await photo(); await seedPage({ slug: SLUG, assetIds: [a.id] }); const handle = await handleOf(a.id);
    publicDeliveryTestHooks.beforeServe = async () => {
      const set = (await database.DB.prepare("SELECT id FROM delivery_sets WHERE set_number = 1").first<{ id: string }>())!;
      const next = crypto.randomUUID(); const other = (await photo()).id;
      await database.DB.prepare("INSERT INTO delivery_sets (id, project_id, set_number, operation_id, published_by, published_at) VALUES (?, ?, 2, ?, ?, ?)").bind(next, ids.project, crypto.randomUUID().slice(0, 32), ids.admin, Date.now()).run();
      await database.DB.prepare("INSERT INTO delivery_set_items (set_id, asset_id, handle, position) VALUES (?, ?, 'zzzzzzzzzzzzzzzz', 0)").bind(next, other).run();
      await database.DB.prepare("UPDATE delivery_pages SET latest_set_number = 2").run(); void set;
    };
    const response = await get(itemUrl(handle, "media")); expect(response.status).toBe(404); expect(await body(response)).not.toContain("BYTES");
  });

  it("serves no original when the item is re-locked after admission", async () => {
    const a = await photo({ premium: true, unlocked: true, preview: true }); await seedPage({ slug: SLUG, assetIds: [a.id] }); const handle = await handleOf(a.id);
    publicDeliveryTestHooks.beforeServe = async () => { await database.DB.prepare("DELETE FROM asset_premium_unlocks WHERE asset_id = ?").bind(a.id).run(); };
    const response = await get(itemUrl(handle, "download")); expect([403, 404]).toContain(response.status); expect(await body(response)).not.toContain(ORIGINAL);
  });

  it("stops a video stream when the Version is trashed after admission", async () => {
    const video = await seedVideoVersion({}); await seedPage({ slug: SLUG, assetIds: [video.assetId] }); const handle = await handleOf(video.assetId);
    publicDeliveryTestHooks.beforeServe = async () => { await database.DB.prepare("UPDATE video_version_meta SET removed_at = ? WHERE asset_id = ?").bind(Date.now(), video.assetId).run(); };
    expect((await get(itemUrl(handle, "media"), { range: "bytes=0-9" })).status).toBe(404);
  });
});

describe("leak sweep", () => {
  it("no public body or header carries an Asset id, R2 key, original filename, email, staff name, payment ref or internal id", async () => {
    const free = await photo({ preview: true }); const locked = await photo({ premium: true, preview: true }); const paid = await photo({ premium: true, preview: true });
    await seedUnlock(paid.id, ids.project, "PAYREF-SECRET-4242");
    const plan = await seedAsset("floorplan_pdf", { versionGroupId: crypto.randomUUID() }); const video = await seedVideoVersion({ poster: true, title: "Internal staff title" });
    await seedPage({ slug: SLUG, assetIds: [free.id, locked.id, paid.id, plan.id, video.assetId] });
    const secrets: string[] = [SECRET_NAME, "PAYREF-SECRET-4242", ids.project, ids.admin, ids.member, "renditions/", "projects/", "delivery-test", video.videoId, plan.id, free.id, locked.id, paid.id, video.assetId];
    const people = (await database.DB.prepare("SELECT name, email FROM user").all<{ name: string | null; email: string | null }>()).results;
    for (const person of people) { if (person.email) secrets.push(person.email); if (person.name && person.name.length > 3) secrets.push(person.name); }
    const handles = await Promise.all([free, locked, paid, plan, { id: video.assetId }].map((asset) => handleOf(asset.id)));
    const paths = [`/d/${SLUG}`, pageUrl(), pageUrl("unknown-page-bcdfgh"), "/d/api/pages/zz", itemUrl("0123456789abcdef", "media")];
    for (const handle of handles) for (const part of ["media", "thumb", "download"] as const) paths.push(itemUrl(handle, part));
    let served = 0;
    for (const path of paths) for (const init of [{}, { method: "HEAD" }, { range: "bytes=0-5" }]) {
      const response = await get(path, init); served += response.status === 200 || response.status === 206 ? 1 : 0;
      const haystack = `${[...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n")}\n${await response.text()}`;
      for (const secret of secrets) expect(haystack, `${path} ${JSON.stringify(init)} leaks ${secret}`).not.toContain(secret);
      if (!path.includes("/items/")) expect(haystack, path).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), `${path} ${name}`).toBe(value);
    }
    expect(served).toBeGreaterThan(10);
    // The unlock request (slice 8) answers through the same hygiene and leaks nothing either, for a locked item, an unlocked one and a miss.
    for (const handle of [...handles, "0123456789abcdef"]) {
      const response = await guestFetch(`${pageUrl()}/items/${handle}/unlock-request`, { method: "POST", body: {} });
      const haystack = `${[...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n")}\n${await response.text()}`;
      for (const secret of secrets) expect(haystack, `unlock-request ${handle} leaks ${secret}`).not.toContain(secret);
      for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), `unlock-request ${name}`).toBe(value);
    }
    // Locked items yield preview bytes only, on every route that serves bytes.
    for (const route of ["media", "thumb"] as const) expect(await body(await get(itemUrl(handles[1]!, route)))).toBe(PREVIEW);
    expect((await get(itemUrl(handles[1]!, "download"))).status).toBe(403);
  });
});
