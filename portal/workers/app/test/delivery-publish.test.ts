import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RENDITION_SPEC_VERSION } from "@quincy/shared";
import app from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, cookie, database, ids, pngBytes, request, seedFixture, type Who } from "./embedded-media-support";
import { publishTestHooks } from "../src/routes/delivery";
import { clearDeliveryFlags, openDelivery, seedAsset, seedOpenProject, seedPage, seedRawPhoto, seedUnlock, setDeliveryFlags, wipeDelivery } from "./delivery-support";
import { seedVideoVersion } from "./video-review-support";

/**
 * Client Delivery Publish, Preview, page switch and staff read (#787 slice 5): the route order, the capabilities, the selection rules, the set and address minting, idempotence, the
 * First-Publish Stage move and the shape of the DTO. Concurrency and the slug retry are in `delivery-publish-race.test.ts`.
 */
type Json = Record<string, any>;
const d = (rest: string, projectId: string = ids.project) => `/api/projects/${projectId}/delivery${rest}`;
const publish = (body: unknown, who: Who = "admin", projectId?: string) => request(d("/publish", projectId), who, "POST", body);
const preview = (body: unknown, who: Who = "admin", projectId?: string) => request(d("/preview", projectId), who, "POST", body);
const switchPage = (enabled: unknown, who: Who = "admin", projectId?: string) => request(d("/page", projectId), who, "PUT", { enabled });
const read = (who: Who = "admin", projectId?: string) => request(d("", projectId), who);
const op = () => crypto.randomUUID();
const body = (assetIds: string[], extra: Json = {}) => ({ assetIds, expectedLatestSet: null, operationId: op(), ...extra });
const SLUG_SUFFIX = "[23456789bcdfghjkmnpqrstvwxz]{6}";

beforeAll(async () => {
  await seedFixture();
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
});
const wipe = async () => {
  await wipeDelivery();
  await database.DB.batch([database.DB.prepare("DELETE FROM video_premium_unlocks"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets"), database.DB.prepare("DELETE FROM videos")]);
};
beforeEach(async () => { await wipe(); await clearDeliveryFlags(); await openDelivery(ids.project, ids.archivedProject); });
afterEach(async () => { await wipe(); await clearDeliveryFlags(); });

const seedRenditions = async (assetId: string) => {
  for (const variant of ["web", "thumb"] as const) {
    const key = `renditions/${assetId}/${variant}`; await database.MEDIA.put(key, pngBytes(40), { httpMetadata: { contentType: "image/webp" } });
    await database.DB.prepare("INSERT INTO asset_renditions (id, asset_id, variant, r2_key, bytes, content_type, width, height, spec_version, created_at) VALUES (?, ?, ?, ?, 40, 'image/webp', 1, 1, ?, ?)").bind(crypto.randomUUID(), assetId, variant, key, RENDITION_SPEC_VERSION, Date.now()).run();
  }
};
const staffGet = async (url: string, who: Who = "admin") => (await import("cloudflare:test")).SELF.fetch(`https://portal.test${url}`, { headers: { cookie: await cookie(who) } });

const counts = async () => {
  const one = async (sql: string) => (await database.DB.prepare(sql).first<{ n: number }>())!.n;
  return { pages: await one("SELECT count(*) AS n FROM delivery_pages"), sets: await one("SELECT count(*) AS n FROM delivery_sets"), items: await one("SELECT count(*) AS n FROM delivery_set_items"), audits: await one("SELECT count(*) AS n FROM audit_log") };
};
const pageRow = (projectId: string = ids.project) => database.DB.prepare("SELECT * FROM delivery_pages WHERE project_id = ?").bind(projectId).first<Json>();
const stageOf = async (projectId: string) => (await database.DB.prepare("SELECT stage_key AS stage, board_revision AS revision FROM projects WHERE id = ?").bind(projectId).first<{ stage: string; revision: number }>())!;
const audits = async (projectId: string, ...actions: string[]) => (await database.DB.prepare(`SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE target_id = ? AND action IN (${actions.map(() => "?").join(",")}) ORDER BY created_at, rowid`).bind(projectId, ...actions).all<Json>()).results;

describe("the gate and the route order", () => {
  const calls = (projectId?: string): Array<[string, string, Json | undefined]> => [
    ["POST", d("/publish", projectId), body([crypto.randomUUID()])], ["POST", d("/preview", projectId), { assetIds: [crypto.randomUUID()] }], ["PUT", d("/page", projectId), { enabled: false }], ["GET", d("", projectId), undefined],
  ];
  const call = (method: string, path: string, who: Who, payload?: Json) => request(path, who, method as "GET", payload);

  it("answers 400 for a malformed Project id before anything else, even with the gate closed", async () => {
    await clearDeliveryFlags();
    for (const [method, path, payload] of calls("not-a-uuid")) expect((await call(method, path, "photographer", payload)).status, `${method} ${path}`).toBe(400);
  });

  it("answers one 404 for every route when the master, the scope or the Project's pilot row is off", async () => {
    for (const flags of [[], ["client_delivery"], [`client_delivery_pilot:${ids.project}`], ["client_delivery", `client_delivery_pilot:${ids.otherProject}`], ["client_delivery", [`client_delivery_pilot:${ids.project}`, false]]] as Array<Array<string | [string, boolean]>>) {
      await clearDeliveryFlags(); await setDeliveryFlags(...flags);
      for (const [method, path, payload] of calls()) for (const who of ["admin", "member", "photographer", "external"] as const) {
        const response = await call(method, path, who, payload);
        expect(response.status, `${who} ${method} ${path} ${JSON.stringify(flags)}`).toBe(404);
        expect(await response.json()).toEqual({ error: "Not found" });
      }
    }
    expect(await counts()).toMatchObject({ pages: 0, sets: 0 });
  });

  it("checks the capability after the gate: Admin and Editor publish, preview and read; only the Admin switches; a Photographer and an External may do none", async () => {
    const photo = await seedAsset("photo"); await seedPage({ assetIds: [photo.id] });
    for (const who of ["admin", "member"] as const) {
      expect((await preview({ assetIds: [photo.id] }, who)).status, `${who} preview`).toBe(200);
      expect((await read(who)).status, `${who} read`).toBe(200);
    }
    expect((await publish(body([photo.id], { expectedLatestSet: 1 }), "member")).status).toBe(201);
    expect((await switchPage(false, "admin")).status).toBe(200);
    expect((await switchPage(true, "member")).status).toBe(403);
    for (const who of ["photographer", "external", "externalOutsider"] as const) {
      expect((await publish(body([photo.id], { expectedLatestSet: 2 }), who)).status, `${who} publish`).toBe(403);
      expect((await preview({ assetIds: [photo.id] }, who)).status, `${who} preview`).toBe(403);
      expect((await read(who)).status, `${who} read`).toBe(403);
      expect((await switchPage(true, who)).status, `${who} switch`).toBe(403);
    }
    expect((await pageRow())!.latest_set_number).toBe(2);
  });

  it("refuses only Publish on an archived Project", async () => {
    const photo = await seedAsset("photo", { projectId: ids.archivedProject }); await seedPage({ projectId: ids.archivedProject, assetIds: [photo.id] });
    expect((await publish(body([photo.id], { expectedLatestSet: 1 }), "admin", ids.archivedProject)).status).toBe(409);
    const refused = await publish(body([crypto.randomUUID()], { nonsense: 1 }), "admin", ids.archivedProject);
    expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ code: "project_archived" });
    expect((await preview({ assetIds: [photo.id] }, "admin", ids.archivedProject)).status).toBe(200);
    expect((await read("admin", ids.archivedProject)).status).toBe(200);
    expect((await switchPage(false, "admin", ids.archivedProject)).status).toBe(200);
    expect((await pageRow(ids.archivedProject))!.enabled).toBe(0);
  });

  it("validates the body (strict) after the Project checks and before the state", async () => {
    const photo = await seedAsset("photo");
    for (const bad of [{}, { assetIds: [] }, { ...body([photo.id]), extra: 1 }, { ...body([photo.id]), operationId: "" }, { ...body([photo.id]), operationId: "x".repeat(65) }, { ...body([photo.id]), expectedLatestSet: 0 }, { ...body([photo.id]), expectedLatestSet: "1" },
      { ...body([photo.id]), assetIds: ["nope"] }, { ...body([photo.id]), assetIds: [photo.id, photo.id] }, { ...body([photo.id]), coverAssetId: "nope" }, { ...body(Array.from({ length: 501 }, () => crypto.randomUUID())) }, { assetIds: [photo.id], operationId: op() }])
      expect((await publish(bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    expect((await switchPage("yes")).status).toBe(400);
    expect((await preview({ assetIds: [photo.id], operationId: op() })).status).toBe(400);
    expect(await counts()).toMatchObject({ pages: 0, sets: 0 });
  });
});

describe("the selection", () => {
  it("publishes photos, a Floorplan PDF, a Copy PDF and a Video Version, in the order given", async () => {
    const [p1, p2] = [await seedAsset("photo"), await seedAsset("photo")]; const plan = await seedAsset("floorplan_pdf", { versionGroupId: crypto.randomUUID() }); const copy = await seedAsset("copy_pdf"); const video = await seedVideoVersion();
    const order = [video.assetId, p2.id, copy.id, p1.id, plan.id];
    const response = await publish(body(order, { coverAssetId: p1.id }));
    expect(response.status).toBe(201);
    const items = (await database.DB.prepare("SELECT i.asset_id, i.position FROM delivery_set_items i ORDER BY i.position").all<Json>()).results;
    expect(items.map((item) => item.asset_id)).toEqual(order);
    expect((await database.DB.prepare("SELECT cover_asset_id FROM delivery_sets").first<Json>())!.cover_asset_id).toBe(p1.id);
  });

  it("refuses with 400 invalid_selection, naming the ids, and writes nothing, for each way an Asset is not eligible", async () => {
    const good = await seedAsset("photo");
    const foreign = await seedAsset("photo", { projectId: ids.otherProject }); const old = await seedAsset("photo", { superseded: true }); const raw = await seedRawPhoto();
    const preview_ = await seedAsset("floorplan_preview", { versionGroupId: crypto.randomUUID() });
    const trashed = await seedVideoVersion(); await database.DB.prepare("UPDATE video_version_meta SET removed_at = ? WHERE asset_id = ?").bind(Date.now(), trashed.assetId).run();
    const trashedVideo = await seedVideoVersion(); await database.DB.prepare("UPDATE videos SET removed_at = ? WHERE id = ?").bind(Date.now(), trashedVideo.videoId).run();
    const oldVideo = await seedVideoVersion({ videoId: crypto.randomUUID(), version: 1 }); await database.DB.prepare("UPDATE assets SET superseded_at = ? WHERE id = ?").bind(Date.now(), oldVideo.assetId).run();
    const unready = await seedAsset("photo"); await database.DB.prepare("UPDATE assets SET publish_status = 'pending' WHERE id = ?").bind(unready.id).run();
    const unknown = crypto.randomUUID();
    const before = await counts();
    for (const bad of [foreign.id, old.id, raw.id, preview_.id, trashed.assetId, trashedVideo.assetId, oldVideo.assetId, unready.id, unknown]) {
      const response = await publish(body([good.id, bad]));
      expect(response.status, bad).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_selection", assetIds: [bad] });
      expect((await preview({ assetIds: [good.id, bad] })).status, `preview ${bad}`).toBe(400);
    }
    expect(await counts()).toEqual(before);
    expect(await pageRow()).toBeNull();
  });

  it("refuses a cover that is not a selected photo", async () => {
    const [photo, other, plan] = [await seedAsset("photo"), await seedAsset("photo"), await seedAsset("floorplan_pdf", { versionGroupId: crypto.randomUUID() })];
    for (const cover of [other.id, plan.id, crypto.randomUUID()]) {
      const response = await publish(body([photo.id, plan.id], { coverAssetId: cover }));
      expect(response.status, cover).toBe(400); expect(await response.json()).toMatchObject({ code: "invalid_cover" });
    }
    expect((await publish(body([photo.id, plan.id], { coverAssetId: null }))).status).toBe(201);
  });
});

describe("Publish", () => {
  it("mints the page, the address, the set and the items, and answers the staff state", async () => {
    const projectId = await seedOpenProject({ street: "12 Königs Street", suburb: "Bondi Beach" });
    const [a, b] = [await seedAsset("photo", { projectId }), await seedAsset("photo", { projectId })];
    const operationId = op();
    const response = await publish({ assetIds: [a.id, b.id], coverAssetId: b.id, expectedLatestSet: null, operationId }, "admin", projectId);
    expect(response.status).toBe(201);
    const json = await response.json() as Json;
    expect(json).toMatchObject({ replayed: false, page: { enabled: true, latestSetNumber: 1 }, set: { setNumber: 1, coverAssetId: b.id } });
    expect(json.page.slug).toMatch(new RegExp(`^12-konigs-street-bondi-beach-${SLUG_SUFFIX}$`));
    expect(json.page.path).toBe(`/d/${json.page.slug}`);
    expect(json.set.items.map((item: Json) => [item.assetId, item.kind, item.label, item.position, item.locked])).toEqual([[a.id, "photo", "Photo 01", 0, false], [b.id, "photo", "Photo 02", 1, false]]);
    for (const item of json.set.items) expect(item.handle).toMatch(/^[a-z0-9]{16}$/);
    expect(new Set(json.set.items.map((item: Json) => item.handle)).size).toBe(2);
    const page = (await pageRow(projectId))!;
    expect(page).toMatchObject({ slug: json.page.slug, enabled: 1, latest_set_number: 1 });
    const set = (await database.DB.prepare("SELECT * FROM delivery_sets WHERE project_id = ?").bind(projectId).first<Json>())!;
    expect(set).toMatchObject({ set_number: 1, operation_id: operationId, cover_asset_id: b.id, published_by: ids.admin });
    const [audit] = await audits(projectId, "delivery.publish");
    expect(audit).toMatchObject({ actor_id: ids.admin, target_type: "project" });
    expect(JSON.parse(audit!.meta_json)).toMatchObject({ setNumber: 1, itemCount: 2, firstPublish: true });
  });

  it("falls back to `property` for an address with no usable letters, and caps the base at 60 characters", async () => {
    const empty = await seedOpenProject({ street: "###", suburb: null }); const long = await seedOpenProject({ street: "1 " + "Wollongong ".repeat(12), suburb: "Sydney" });
    for (const projectId of [empty, long]) { const a = await seedAsset("photo", { projectId }); expect((await publish(body([a.id]), "admin", projectId)).status).toBe(201); }
    expect((await pageRow(empty))!.slug).toMatch(new RegExp(`^property-${SLUG_SUFFIX}$`));
    const slug = (await pageRow(long))!.slug as string;
    expect(slug).toMatch(new RegExp(`^[a-z0-9-]{1,60}-${SLUG_SUFFIX}$`)); expect(slug).not.toMatch(/--/);
  });

  it("numbers the next set from the expected latest set, keeps the address and an off page off", async () => {
    const a = await seedAsset("photo"); const b = await seedAsset("photo");
    const first = await (await publish(body([a.id]))).json() as Json;
    expect((await switchPage(false)).status).toBe(200);
    const stale = await publish(body([a.id], { expectedLatestSet: null }));
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: "stale_set", latestSetNumber: 1 });
    const wrong = await publish(body([a.id], { expectedLatestSet: 5 }));
    expect(wrong.status).toBe(409); expect(await wrong.json()).toMatchObject({ code: "stale_set", latestSetNumber: 1 });
    const second = await publish(body([a.id, b.id], { expectedLatestSet: 1 }));
    expect(second.status).toBe(201);
    const json = await second.json() as Json;
    expect(json).toMatchObject({ page: { slug: first.page.slug, enabled: false, latestSetNumber: 2 }, set: { setNumber: 2 } });
    expect(await counts()).toMatchObject({ sets: 2, items: 3 });
    expect((await audits(ids.project, "delivery.publish")).map((row) => JSON.parse(row.meta_json).firstPublish)).toEqual([true, false]);
  });

  it("answers a replay of an older Publish with the CURRENT set, usable URLs, and the set its operation landed as", async () => {
    const photos = [await seedAsset("photo"), await seedAsset("photo"), await seedAsset("photo")];
    for (const photo of photos) await seedRenditions(photo.id);
    const operationId = op();
    expect((await publish({ assetIds: [photos[0]!.id], expectedLatestSet: null, operationId })).status).toBe(201);
    expect((await publish(body([photos[1]!.id, photos[2]!.id], { expectedLatestSet: 1 }))).status).toBe(201);
    const retry = await publish({ assetIds: [photos[0]!.id], expectedLatestSet: null, operationId }); expect(retry.status).toBe(200);
    const json = await retry.json() as Json;
    expect(json).toMatchObject({ replayed: true, operationSetNumber: 1, page: { latestSetNumber: 2 }, set: { setNumber: 2 }, dto: { setNumber: 2 } });
    const urls = json.dto.items.flatMap((item: Json) => [item.url, item.thumbUrl].filter(Boolean)) as string[];
    expect(urls).toHaveLength(4);
    for (const url of urls) expect((await staffGet(url)).status, url).toBe(200);
  });

  it("answers a Publish that another Publish overtakes before its response is read with the CURRENT state, and its own set as the receipt", async () => {
    const photos = [await seedAsset("photo"), await seedAsset("photo")];
    for (const photo of photos) await seedRenditions(photo.id);
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; }); let reached!: () => void; const arrived = new Promise<void>((resolve) => { reached = resolve; });
    publishTestHooks.afterCommit = async () => { publishTestHooks.afterCommit = undefined; reached(); await held; };
    try {
      // In-process, so the hook (module state) is the one the route reads; the HTTP helper runs the worker in its own module graph.
      const slow = (async () => app.fetch(new Request(`https://portal.test${d("/publish")}`, { method: "POST", headers: { cookie: await cookie("admin"), origin: baseEnv.APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body([photos[0]!.id])) }), baseEnv as Env, { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext))();
      await arrived;
      expect((await publish(body([photos[1]!.id], { expectedLatestSet: 1 }))).status).toBe(201);
      release();
      const response = await slow; expect(response.status).toBe(201);
      const json = await response.json() as Json;
      expect(json).toMatchObject({ replayed: false, operationSetNumber: 1, page: { latestSetNumber: 2 }, set: { setNumber: 2 }, dto: { setNumber: 2 } });
      const urls = json.dto.items.flatMap((item: Json) => [item.url, item.thumbUrl].filter(Boolean)) as string[];
      expect(urls).toHaveLength(2);
      for (const url of urls) expect((await staffGet(url)).status, url).toBe(200);
    } finally { publishTestHooks.afterCommit = undefined; }
  });

  it("answers a retried operation id with the original set, never a second one, even after a later Publish or with a stale expectation", async () => {
    const a = await seedAsset("photo"); const b = await seedAsset("photo");
    const operationId = op();
    const payload = { assetIds: [a.id], coverAssetId: a.id, expectedLatestSet: null, operationId };
    const first = await publish(payload); expect(first.status).toBe(201); const original = await first.json() as Json;
    const again = await publish(payload); expect(again.status).toBe(200);
    expect(original.operationSetNumber).toBe(1);
    expect(await again.json()).toEqual({ ...original, replayed: true });
    expect((await publish(body([a.id, b.id], { expectedLatestSet: 1 }))).status).toBe(201);
    const late = await publish(payload); expect(late.status).toBe(200);
    expect(((await late.json()) as Json)).toMatchObject({ replayed: true, operationSetNumber: 1, set: { setNumber: 2 } });
    expect(await counts()).toMatchObject({ sets: 2 });
    expect(await audits(ids.project, "delivery.publish")).toHaveLength(2);
  });

  it("scopes an operation id to its Project", async () => {
    const operationId = op(); const other = await seedOpenProject();
    const a = await seedAsset("photo"); const b = await seedAsset("photo", { projectId: other });
    expect((await publish({ assetIds: [a.id], expectedLatestSet: null, operationId })).status).toBe(201);
    expect((await publish({ assetIds: [b.id], expectedLatestSet: null, operationId }, "admin", other)).status).toBe(201);
  });
});

describe("the First-Publish Stage move", () => {
  const moveEnabled = async () => (await database.DB.prepare("SELECT enabled FROM feature_flags WHERE key = 'tb5a_board_contract_enabled'").first<{ enabled: number }>())!.enabled;

  it("moves a Project to Delivered on the first Publish only, with the Stage audit and activity in the same batch", async () => {
    expect(await moveEnabled()).toBe(1);
    const projectId = await seedOpenProject({ stageKey: "edited_review" }); const a = await seedAsset("photo", { projectId });
    const before = await stageOf(projectId);
    expect((await publish(body([a.id]), "admin", projectId)).status).toBe(201);
    expect(await stageOf(projectId)).toEqual({ stage: "delivered", revision: before.revision + 1 });
    const [stage] = await audits(projectId, "stage.set");
    expect(stage).toMatchObject({ actor_id: ids.admin }); expect(JSON.parse(stage!.meta_json)).toMatchObject({ from: "edited_review", to: "delivered", trigger: "delivery_publish" });
    expect((await database.DB.prepare("SELECT count(*) AS n FROM project_activity_events WHERE project_id = ? AND event_type = 'project.stage.changed'").bind(projectId).first<{ n: number }>())!.n).toBe(1);
    await database.DB.prepare("UPDATE projects SET stage_key = 'edited_review', board_revision = board_revision + 1 WHERE id = ?").bind(projectId).run();
    expect((await publish(body([a.id], { expectedLatestSet: 1 }), "admin", projectId)).status).toBe(201);
    expect(await audits(projectId, "stage.set")).toHaveLength(1);
    expect((await stageOf(projectId)).stage).toBe("edited_review");
  });

  const nothingWritten = async (projectId: string, before: Awaited<ReturnType<typeof counts>>, stage: string) => {
    expect(await counts()).toEqual(before); expect(await pageRow(projectId)).toBeNull();
    expect((await stageOf(projectId)).stage).toBe(stage);
    expect((await database.DB.prepare("SELECT count(*) AS n FROM project_activity_events WHERE project_id = ?").bind(projectId).first<{ n: number }>())!.n).toBe(0);
  };
  const withDeliveredInactive = async (run: () => Promise<void>) => {
    await database.DB.prepare("UPDATE pipeline_stages SET active = 0 WHERE key = 'delivered'").run();
    try { await run(); } finally { await database.DB.prepare("UPDATE pipeline_stages SET active = 1 WHERE key = 'delivered'").run(); }
  };

  it("publishes a Project that is already Delivered without a move", async () => {
    const delivered = await seedOpenProject({ stageKey: "delivered" }); const a = await seedAsset("photo", { projectId: delivered });
    const response = await publish(body([a.id]), "admin", delivered); expect(response.status).toBe(201);
    expect(await audits(delivered, "stage.set")).toHaveLength(0);
  });

  it("refuses a first Publish with 409 delivered_stage_unavailable, writing nothing, when the board contract is off", async () => {
    await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'tb5a_board_contract_enabled'").run();
    try {
      const off = await seedOpenProject({ stageKey: "edited_review" }); const b = await seedAsset("photo", { projectId: off });
      const before = await counts();
      const result = await publish(body([b.id]), "admin", off);
      expect(result.status).toBe(409); expect(await result.json()).toMatchObject({ code: "delivered_stage_unavailable" });
      await nothingWritten(off, before, "edited_review");
    } finally { await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run(); }
  });

  it("refuses a first Publish with 409 delivered_stage_unavailable, writing nothing, when the Delivered Stage is inactive", async () => {
    await withDeliveredInactive(async () => {
      const projectId = await seedOpenProject({ stageKey: "edited_review" }); const a = await seedAsset("photo", { projectId });
      const before = await counts();
      const result = await publish(body([a.id]), "admin", projectId);
      expect(result.status).toBe(409); expect(await result.json()).toMatchObject({ code: "delivered_stage_unavailable" });
      await nothingWritten(projectId, before, "edited_review");
    });
  });

  it("still publishes an already-Delivered Project, and a re-Publish, while the Delivered Stage is inactive", async () => {
    await withDeliveredInactive(async () => {
      const delivered = await seedOpenProject({ stageKey: "delivered" }); const a = await seedAsset("photo", { projectId: delivered });
      expect((await publish(body([a.id]), "admin", delivered)).status).toBe(201);
      const other = await seedOpenProject({ stageKey: "edited_review" }); const b = await seedAsset("photo", { projectId: other });
      await seedPage({ projectId: other, assetIds: [b.id] });
      expect((await publish(body([b.id], { expectedLatestSet: 1 }), "admin", other)).status).toBe(201);
    });
  });

  it("leaves the Stage alone, and writes no Stage audit, when a refused Publish would otherwise have moved it", async () => {
    const projectId = await seedOpenProject({ stageKey: "edited_review" }); const a = await seedAsset("photo", { projectId });
    expect((await publish(body([a.id, crypto.randomUUID()]), "admin", projectId)).status).toBe(400);
    expect((await publish(body([a.id], { expectedLatestSet: 4 }), "admin", projectId)).status).toBe(409);
    expect((await stageOf(projectId)).stage).toBe("edited_review"); expect(await audits(projectId, "stage.set")).toHaveLength(0);
  });
});

describe("Preview: property", () => {
  it("carries the postcode and the agency name, never the agent", async () => {
    const projectId = await seedOpenProject({ street: "9 Elm St", suburb: "Glebe", postcode: "2037", agencyName: "Elm Realty", agentName: "Agent Smith-Zed" });
    const photo = await seedAsset("photo", { projectId });
    const response = await preview({ assetIds: [photo.id] }, "admin", projectId);
    expect(response.status).toBe(200);
    const raw = JSON.stringify(await response.json());
    expect(JSON.parse(raw).dto.property).toEqual({ street: "9 Elm St", suburb: "Glebe", postcode: "2037", agency: "Elm Realty" });
    expect(raw).not.toContain("Smith-Zed");
  });
  it("shows the same property on the staff read of a published page", async () => {
    const projectId = await seedOpenProject({ postcode: "2000", directoryAgency: "Dir Realty" });
    const photo = await seedAsset("photo", { projectId });
    expect((await publish(body([photo.id]), "admin", projectId)).status).toBe(201);
    const state = await (await read("admin", projectId)).json() as Json;
    expect(state.dto.property).toMatchObject({ postcode: "2000", agency: "Dir Realty" });
  });
});

describe("Preview", () => {
  it("renders the DTO for an unpublished selection and creates nothing", async () => {
    const [photo, plan, copy] = [await seedAsset("photo"), await seedAsset("floorplan_pdf", { versionGroupId: crypto.randomUUID() }), await seedAsset("copy_pdf")]; const video = await seedVideoVersion({ poster: true });
    const before = await counts(); const stage = await stageOf(ids.project);
    const response = await preview({ assetIds: [photo.id, plan.id, copy.id, video.assetId], coverAssetId: photo.id });
    expect(response.status).toBe(200);
    const { dto } = await response.json() as Json;
    expect(dto).toMatchObject({ property: { street: "Media Street", suburb: null, postcode: null, agency: null }, setNumber: 1, publishedAt: null });
    expect(dto.items.map((item: Json) => [item.kind, item.label])).toEqual([["photo", "Photo 01"], ["floorplan", "Floorplan 01"], ["copy", "Copy 01"], ["video", "Video 01"]]);
    expect(dto.coverHandle).toBe(dto.items[0].handle);
    expect(dto.items.map((item: Json) => [item.url, item.thumbUrl])).toEqual([photo.id, plan.id, copy.id, video.assetId].map((assetId, index) => [`${d(`/preview-media/${assetId}/media`)}`, index === 0 || index === 3 ? d(`/preview-media/${assetId}/thumb`) : null]));
    expect(await counts()).toEqual(before); expect(await stageOf(ids.project)).toEqual(stage);
  });

  it("numbers the preview after the page's latest set", async () => {
    const photo = await seedAsset("photo"); await seedPage({ assetIds: [photo.id], olderSets: [[photo.id]] });
    expect(((await (await preview({ assetIds: [photo.id] })).json()) as Json).dto.setNumber).toBe(3);
  });
});

describe("the staff read and the public DTO", () => {
  it("answers page null and set null before the first Publish", async () => {
    const response = await read(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ page: null, set: null, dto: null });
  });

  it("reads the latest set only, with a DTO that exposes handles and labels and never an id, a key or a filename, and, on the staff read, no title key at all (#882)", async () => {
    const photo = await seedAsset("photo"); const video = await seedVideoVersion({ title: "Secret Walkthrough" }); const premium = await seedAsset("photo", { deliveryPremium: true }); const paid = await seedAsset("photo", { deliveryPremium: true }); await seedUnlock(paid.id);
    expect((await publish(body([photo.id], { coverAssetId: photo.id }))).status).toBe(201);
    const second = await publish(body([photo.id, video.assetId, premium.id, paid.id], { expectedLatestSet: 1, coverAssetId: photo.id }));
    expect(second.status).toBe(201);
    const state = await (await read()).json() as Json;
    expect(state.page).toMatchObject({ latestSetNumber: 2, enabled: true }); expect(state.set.setNumber).toBe(2); expect(state.set.items).toHaveLength(4);
    expect(state.set.items.map((item: Json) => [item.label, item.locked])).toEqual([["Photo 01", false], ["Video 01", false], ["Photo 02", true], ["Photo 03", false]]);
    expect(state.dto.items.map((item: Json) => item.locked)).toEqual([false, false, true, false]);
    // `premium` is the item's own paid-extra flag and survives an Unlock (the Premium tab keeps listing an unlocked item); it says nothing about unlocks or payment.
    expect(state.dto.items.map((item: Json) => item.premium)).toEqual([false, false, true, true]);
    // #882: the staff read carries NO title key (a deployed staff tab parses strictly, lesson #858); only the public read does.
    for (const item of state.dto.items) expect(Object.keys(item)).not.toContain("title");
    const wire = JSON.stringify({ ...state.dto, items: state.dto.items.map((item: Json) => ({ ...item, url: null, thumbUrl: null })) });
    for (const secret of [photo.id, video.assetId, video.videoId, premium.id, "Secret Walkthrough", ".bin", "projects/", "delivery-test", ids.admin, "Admin Person", ids.project]) expect(wire, secret).not.toContain(secret);
    expect(Object.keys(state.dto).sort()).toEqual(["coverHandle", "items", "property", "publishedAt", "setNumber"]);
    expect(Object.keys(state.dto.items[0]).sort()).toEqual(["durationMs", "handle", "height", "kind", "label", "locked", "position", "premium", "review", "thumbUrl", "url", "width"]);
    expect(state.dto.coverHandle).toBe(state.set.items[0].handle);
  });

  it("reflects a live Unlock in the DTO at once while the set stays as published", async () => {
    const premium = await seedAsset("photo", { deliveryPremium: true });
    await publish(body([premium.id]));
    expect(((await (await read()).json()) as Json).dto.items[0].locked).toBe(true);
    await seedUnlock(premium.id);
    expect(((await (await read()).json()) as Json).dto.items[0].locked).toBe(false);
  });
});

describe("the page switch", () => {
  it("switches off and on, audits a change once and nothing for a repeat", async () => {
    const a = await seedAsset("photo"); await publish(body([a.id]));
    const off = await switchPage(false); expect(off.status).toBe(200); expect(await off.json()).toMatchObject({ page: { enabled: false, latestSetNumber: 1 } });
    expect((await switchPage(false)).status).toBe(200);
    expect((await switchPage(true)).status).toBe(200);
    expect((await audits(ids.project, "delivery.page_off", "delivery.page_on")).map((row) => [row.action, row.actor_id])).toEqual([["delivery.page_off", ids.admin], ["delivery.page_on", ids.admin]]);
    expect((await pageRow())!.enabled).toBe(1);
  });

  it("answers 404 no_page before the first Publish", async () => {
    const response = await switchPage(false); expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ code: "no_page" });
  });
});

describe("the Delivery activity (project.delivery.published)", () => {
  const activities = (projectId: string) => database.DB.prepare("SELECT id, actor_id, safe_payload_json, deep_link_kind, deep_link_path, source_key FROM project_activity_events WHERE project_id = ? AND event_type = 'project.delivery.published' ORDER BY occurred_at, rowid").bind(projectId).all<Json>().then((r) => r.results);
  const recipients = async (activityId: string) => (await database.DB.prepare("SELECT recipient_id FROM notification_outbox WHERE source_key = ?").bind(activityId).all<Json>()).results.map((row) => row.recipient_id as string);

  it("writes the activity and its outbox rows on every Publish, first or later, to the Project's internal Editors only", async () => {
    const a = await seedAsset("photo"); const b = await seedAsset("photo");
    expect((await publish(body([a.id]))).status).toBe(201);
    expect((await publish(body([a.id, b.id], { expectedLatestSet: 1 }))).status).toBe(201);
    const rows = await activities(ids.project);
    expect(rows.map((row) => JSON.parse(row.safe_payload_json))).toEqual([{ setNumber: 1, itemCount: 1, firstPublish: true }, { setNumber: 2, itemCount: 2, firstPublish: false }]);
    for (const row of rows) {
      expect(row).toMatchObject({ actor_id: ids.admin, deep_link_kind: "project", deep_link_path: `/projects/${ids.project}` });
      const to = await recipients(row.id);
      expect(to).toContain(ids.member); expect(to).not.toContain(ids.external); expect(to).not.toContain(ids.photographer);
    }
  });

  it("writes nothing for a refused Publish and a replayed one", async () => {
    const a = await seedAsset("photo"); const operationId = op();
    expect((await publish(body([a.id, crypto.randomUUID()]))).status).toBe(400);
    expect(await activities(ids.project)).toHaveLength(0);
    const payload = { assetIds: [a.id], expectedLatestSet: null, operationId };
    await publish(payload); await publish(payload);
    expect(await activities(ids.project)).toHaveLength(1);
  });
});
