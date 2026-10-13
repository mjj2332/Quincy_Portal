import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DELIVERY_SLUG_ALPHABET, deliveryPageDtoSchema } from "@quincy/shared";
import { baseEnv, database, ids, request, seedFixture } from "./embedded-media-support";
import { clearDeliveryFlags, openDelivery, seedAsset, seedOpenProject, seedPage, wipeDelivery } from "./delivery-support";
import { seedVideoVersion } from "./video-review-support";
import { publishDelivery, type PublishDeps, type PublishOutcome } from "../src/lib/delivery-publish";
import { buildDeliveryDto } from "../src/lib/delivery-dto";
import { syncDeliveryReviewLink } from "../src/lib/delivery-review-link";

/**
 * Client Delivery Publish under contention (#787 slice 5). The batch is the only writer, so every case here is a way two writers, or a writer and a stale read, can meet: two Publishes
 * with different operations, the same operation twice, an address collision, a selection that changes between the read and the batch, a Stage move that loses its compare-and-swap.
 */
type Json = Record<string, any>;
const principal = { id: ids.admin, impersonatedBy: null, via: undefined } as const;
const op = () => crypto.randomUUID();
const send = (projectId: string, assetIds: string[], extra: Partial<Parameters<typeof publishDelivery>[1]> = {}, deps?: PublishDeps) =>
  publishDelivery(baseEnv, { projectId, principal, assetIds, coverAssetId: null, expectedLatestSet: null, operationId: op(), ...extra }, deps);
const http = (projectId: string, assetIds: string[], expectedLatestSet: number | null, operationId = op()) => request(`/api/projects/${projectId}/delivery/publish`, "admin", "POST", { assetIds, expectedLatestSet, operationId });
/** A promise to hold a Publish between its read and its batch, and the function that lets it go. */
function gate() { let release!: () => void; const open = new Promise<void>((resolve) => { release = resolve; }); return { open, release }; }

beforeAll(async () => {
  await seedFixture();
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
});
const wipe = async () => { await wipeDelivery(); await database.DB.batch([database.DB.prepare("DELETE FROM video_premium_unlocks"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets"), database.DB.prepare("DELETE FROM videos")]); };
beforeEach(async () => { await wipe(); await clearDeliveryFlags(); await openDelivery(ids.project); });
afterEach(async () => { await wipe(); await clearDeliveryFlags(); });
const n = async (sql: string, ...binds: unknown[]) => (await database.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const setsOf = (projectId: string) => n("SELECT count(*) AS n FROM delivery_sets WHERE project_id = ?", projectId);
const stageOf = async (projectId: string) => (await database.DB.prepare("SELECT stage_key AS stage, board_revision AS revision, archived_at AS archivedAt FROM projects WHERE id = ?").bind(projectId).first<Json>())!;

describe("two different Publishes", () => {
  it("lets exactly one first Publish win when both read an empty page", async () => {
    const a = await seedAsset("photo"); const b = await seedAsset("photo");
    const results = await Promise.all([http(ids.project, [a.id], null), http(ids.project, [b.id], null)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(await loser.json()).toMatchObject({ code: "stale_set", latestSetNumber: 1 });
    expect(await setsOf(ids.project)).toBe(1);
    expect(await n("SELECT count(*) AS n FROM delivery_pages")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM delivery_set_items")).toBe(1);
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE action = 'delivery.publish'")).toBe(1);
  });

  it("lets exactly one re-Publish win when both expect the same latest set, and leaves no partial write from the loser", async () => {
    const a = await seedAsset("photo"); const b = await seedAsset("photo"); const c = await seedAsset("photo");
    await seedPage({ assetIds: [a.id] });
    const results = await Promise.all([http(ids.project, [a.id, b.id], 1), http(ids.project, [a.id, b.id, c.id], 1)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await setsOf(ids.project)).toBe(2);
    expect(await n("SELECT latest_set_number AS n FROM delivery_pages")).toBe(2);
    const winnerItems = await n("SELECT count(*) AS n FROM delivery_set_items i JOIN delivery_sets s ON s.id = i.set_id WHERE s.set_number = 2");
    expect(winnerItems).toBe(((await (await results.find((r) => r.status === 201)!.clone().json()) as Json).set.items as unknown[]).length);
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE action = 'delivery.publish'")).toBe(1);
  });

  it("answers stale_set to a Publish held between its read and its batch while another lands", async () => {
    const a = await seedAsset("photo"); const b = await seedAsset("photo");
    const held = gate(); let reached!: () => void; const arrived = new Promise<void>((resolve) => { reached = resolve; });
    const slow = send(ids.project, [a.id], {}, { beforeBatch: async () => { reached(); await held.open; } });
    await arrived;
    expect((await http(ids.project, [b.id], null)).status).toBe(201);
    held.release();
    expect(await slow).toEqual({ kind: "stale_set", latestSetNumber: 1 });
    expect(await setsOf(ids.project)).toBe(1);
  });
});

describe("the same operation twice", () => {
  it("answers the second of two concurrent identical requests with the original set", async () => {
    const a = await seedAsset("photo"); const operationId = op();
    const held = gate(); let reached!: () => void; const arrived = new Promise<void>((resolve) => { reached = resolve; });
    const slow = send(ids.project, [a.id], { operationId }, { beforeBatch: async () => { reached(); await held.open; } });
    await arrived;
    expect((await http(ids.project, [a.id], null, operationId)).status).toBe(201);
    held.release();
    expect(await slow).toEqual({ kind: "replayed", setNumber: 1 });
    expect(await setsOf(ids.project)).toBe(1);
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE action = 'delivery.publish'")).toBe(1);
  });

  it("returns identical handles on the retry", async () => {
    const a = await seedAsset("photo"); const operationId = op();
    const first = await (await http(ids.project, [a.id], null, operationId)).json() as Json; const again = await (await http(ids.project, [a.id], null, operationId)).json() as Json;
    expect(again.set.items.map((item: Json) => item.handle)).toEqual(first.set.items.map((item: Json) => item.handle));
  });
});

describe("the address", () => {
  it("retries with a fresh suffix when the first one is already taken, and writes nothing from the failed attempt", async () => {
    const projectId = await seedOpenProject({ street: "9 Collision Rd", suburb: "Clash" }); const other = await seedOpenProject();
    const a = await seedAsset("photo", { projectId }); const taken = await seedAsset("photo", { projectId: other });
    await seedPage({ projectId: other, slug: "9-collision-rd-clash-bcdfgh", assetIds: [taken.id] });
    const suffixes = ["bcdfgh", "jkmnpq"]; let calls = 0;
    const outcome = await send(projectId, [a.id], {}, { slugSuffix: () => suffixes[calls++]! });
    expect(outcome).toMatchObject({ kind: "published", setNumber: 1 });
    expect(calls).toBe(2);
    expect((await database.DB.prepare("SELECT slug FROM delivery_pages WHERE project_id = ?").bind(projectId).first<Json>())!.slug).toBe("9-collision-rd-clash-jkmnpq");
    expect(await setsOf(projectId)).toBe(1);
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE action = 'delivery.publish' AND target_id = ?", projectId)).toBe(1);
  });

  it("gives up after a bounded number of collisions without writing", async () => {
    const projectId = await seedOpenProject({ street: "1 Stuck St", suburb: "Loop" }); const other = await seedOpenProject();
    const a = await seedAsset("photo", { projectId }); const taken = await seedAsset("photo", { projectId: other });
    await seedPage({ projectId: other, slug: "1-stuck-st-loop-bcdfgh", assetIds: [taken.id] });
    await expect(send(projectId, [a.id], {}, { slugSuffix: () => "bcdfgh" })).rejects.toThrow(/address/i);
    expect(await setsOf(projectId)).toBe(0);
  });

  it("draws suffixes from the 27-character alphabet only", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const projectId = await seedOpenProject(); const a = await seedAsset("photo", { projectId });
      await send(projectId, [a.id]);
      const slug = (await database.DB.prepare("SELECT slug FROM delivery_pages WHERE project_id = ?").bind(projectId).first<Json>())!.slug as string;
      const suffix = slug.slice(slug.lastIndexOf("-") + 1); expect(suffix).toHaveLength(6); for (const ch of suffix) expect(DELIVERY_SLUG_ALPHABET).toContain(ch); seen.add(suffix);
    }
    expect(seen.size).toBe(40);
  });
});

describe("a selection or Project that changes between the read and the batch", () => {
  it("writes nothing, and moves no Stage, when a selected Video is trashed in the gap", async () => {
    const projectId = await seedOpenProject({ stageKey: "edited_review" }); const photo = await seedAsset("photo", { projectId }); const video = await seedVideoVersion({ projectId });
    const before = await stageOf(projectId);
    const outcome = await send(projectId, [photo.id, video.assetId], {}, { beforeBatch: async () => { await database.DB.prepare("UPDATE video_version_meta SET removed_at = ? WHERE asset_id = ?").bind(Date.now(), video.assetId).run(); } });
    expect(outcome).toEqual({ kind: "invalid_selection", assetIds: [video.assetId] });
    expect(await setsOf(projectId)).toBe(0); expect(await stageOf(projectId)).toEqual(before);
    expect(await n("SELECT count(*) AS n FROM project_activity_events WHERE project_id = ?", projectId)).toBe(0);
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action IN ('stage.set', 'delivery.publish')", projectId)).toBe(0);
  });

  it("writes nothing when a selected photo is superseded in the gap", async () => {
    const projectId = await seedOpenProject({ stageKey: "edited_review" }); const photo = await seedAsset("photo", { projectId });
    const outcome = await send(projectId, [photo.id], {}, { beforeBatch: async () => { await database.DB.prepare("UPDATE assets SET superseded_at = ? WHERE id = ?").bind(Date.now(), photo.id).run(); } });
    expect(outcome).toEqual({ kind: "invalid_selection", assetIds: [photo.id] });
    expect(await setsOf(projectId)).toBe(0); expect((await stageOf(projectId)).stage).toBe("edited_review");
  });

  it("writes nothing when the Project is archived in the gap", async () => {
    const projectId = await seedOpenProject({ stageKey: "edited_review" }); const photo = await seedAsset("photo", { projectId });
    const outcome = await send(projectId, [photo.id], {}, { beforeBatch: async () => { await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), projectId).run(); } });
    expect(outcome).toEqual({ kind: "archived" });
    expect(await setsOf(projectId)).toBe(0); expect(await n("SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action = 'stage.set'", projectId)).toBe(0);
  });

  it("refuses with delivered_stage_unavailable, writing nothing, when the Delivered Stage is deactivated in the gap", async () => {
    const projectId = await seedOpenProject({ stageKey: "edited_review" }); const photo = await seedAsset("photo", { projectId });
    try {
      const outcome = await send(projectId, [photo.id], {}, { beforeBatch: async () => { await database.DB.prepare("UPDATE pipeline_stages SET active = 0 WHERE key = 'delivered'").run(); } });
      expect(outcome).toEqual({ kind: "delivered_stage_unavailable" });
      expect(await setsOf(projectId)).toBe(0); expect((await stageOf(projectId)).stage).toBe("edited_review");
      expect(await n("SELECT count(*) AS n FROM delivery_pages WHERE project_id = ?", projectId)).toBe(0);
      expect(await n("SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action IN ('stage.set', 'delivery.publish')", projectId)).toBe(0);
      expect(await n("SELECT count(*) AS n FROM project_activity_events WHERE project_id = ?", projectId)).toBe(0);
    } finally { await database.DB.prepare("UPDATE pipeline_stages SET active = 1 WHERE key = 'delivered'").run(); }
  });

  describe("the batch's own Delivered fence (acting after the move is composed)", () => {
    const flagOn = () => database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
    const cases: Array<[string, string, () => Promise<unknown>]> = [
      ["the Delivered Stage is deactivated", "UPDATE pipeline_stages SET active = 0 WHERE key = 'delivered'", () => database.DB.prepare("UPDATE pipeline_stages SET active = 1 WHERE key = 'delivered'").run()],
      ["the board contract is turned off", "UPDATE feature_flags SET enabled = 0 WHERE key = 'tb5a_board_contract_enabled'", flagOn],
    ];
    for (const [name, change, restore] of cases) {
      it(`refuses with delivered_stage_unavailable, writing nothing, when ${name} just before the batch`, async () => {
        const projectId = await seedOpenProject({ stageKey: "edited_review" }); const photo = await seedAsset("photo", { projectId });
        try {
          const outcome = await send(projectId, [photo.id], {}, { beforeCommit: async () => { await database.DB.prepare(change).run(); } });
          expect(outcome).toEqual({ kind: "delivered_stage_unavailable" });
          expect(await setsOf(projectId)).toBe(0); expect((await stageOf(projectId)).stage).toBe("edited_review");
          expect(await n("SELECT count(*) AS n FROM delivery_pages WHERE project_id = ?", projectId)).toBe(0);
          expect(await n("SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action IN ('stage.set', 'delivery.publish')", projectId)).toBe(0);
          expect(await n("SELECT count(*) AS n FROM project_activity_events WHERE project_id = ?", projectId)).toBe(0);
        } finally { await restore(); }
      });
    }
  });

  it("publishes and leaves the Stage where it is when another Stage move wins the compare-and-swap", async () => {
    const projectId = await seedOpenProject({ stageKey: "edited_review" }); const photo = await seedAsset("photo", { projectId });
    const outcome = await send(projectId, [photo.id], {}, { beforeBatch: async () => { await database.DB.prepare("UPDATE projects SET stage_key = 'editing_autohdr', board_revision = board_revision + 1 WHERE id = ?").bind(projectId).run(); } });
    expect(outcome).toMatchObject({ kind: "published", setNumber: 1, stageMoved: false });
    expect((await stageOf(projectId)).stage).toBe("editing_autohdr");
    expect(await setsOf(projectId)).toBe(1);
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE target_id = ? AND action = 'stage.set'", projectId)).toBe(0);
    expect(await n("SELECT count(*) AS n FROM project_activity_events WHERE project_id = ? AND event_type = 'project.stage.changed'", projectId)).toBe(0);
  });
});

describe("the committed publication ids", () => {
  it("returns the Delivery activity's outbox ids with the Stage move's, for dispatch after the commit", async () => {
    const photo = await seedAsset("photo");
    const outcome = await send(ids.project, [photo.id]);
    expect(outcome.kind).toBe("published");
    if (outcome.kind !== "published") return;
    const delivery = (await database.DB.prepare("SELECT o.id FROM notification_outbox o JOIN project_activity_events a ON a.id = o.source_key WHERE a.event_type = 'project.delivery.published'").all<Json>()).results.map((row) => row.id);
    expect(delivery.length).toBeGreaterThan(0);
    for (const id of delivery) expect(outcome.publicationIds).toContain(id);
  });
});

describe("the shared DTO builder", () => {
  it("builds a strict DTO from rows with whatever URLs the caller resolves, and numbers labels per kind", () => {
    const row = (position: number, kind: "photo" | "floorplan" | "copy" | "video", extra: Json = {}) => ({ assetId: crypto.randomUUID(), handle: `h${String(position).padStart(15, "0")}`, position, kind, width: null, height: null, durationMs: null, locked: false, premium: false, ...extra });
    const rows = [row(0, "photo", { width: 6000, height: 4000 }), row(1, "video", { durationMs: 61000 }), row(2, "photo", { locked: true }), row(3, "floorplan"), ...Array.from({ length: 98 }, (_, i) => row(4 + i, "photo"))];
    const dto = buildDeliveryDto({ property: { street: "1 A St", suburb: "B", postcode: null, agency: null }, setNumber: 3, publishedAt: 1_700_000_000_000, coverHandle: rows[0]!.handle, rows, urls: (item: { handle: string }) => ({ url: `/d/x/items/${item.handle}`, thumbUrl: null }) });
    expect(deliveryPageDtoSchema.parse(dto)).toEqual(dto);
    expect(dto.items.slice(0, 4).map((item) => item.label)).toEqual(["Photo 001", "Video 01", "Photo 002", "Floorplan 01"]);
    expect(dto.items[2]!.locked).toBe(true);
    expect(dto.items.map((item) => item.premium).slice(0, 3)).toEqual([false, false, false]);
    expect(JSON.stringify(dto)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe("the Delivery review link under contention (#847)", () => {
  const linkRows = () => database.DB.prepare("SELECT id, token_secret FROM client_links WHERE project_id = ? AND delivery_review = 1").bind(ids.project).all<Json>().then((r) => r.results);
  const liveFilms = async () => (await database.DB.prepare("SELECT v.video_id AS id FROM review_link_videos v WHERE removed_at IS NULL ORDER BY video_id").all<{ id: string }>()).results.map((r) => r.id);
  const cleanLinks = () => database.DB.batch([database.DB.prepare("DELETE FROM review_link_version_grants"), database.DB.prepare("DELETE FROM review_link_videos"), database.DB.prepare("DELETE FROM guest_notification_digest"), database.DB.prepare("DELETE FROM client_links")]);
  afterEach(cleanLinks);

  it("two first Publishes of different films leave exactly one link, carrying the winner's film only", async () => {
    const a = await seedVideoVersion({ title: "A" }); const b = await seedVideoVersion({ title: "B" });
    const results = await Promise.all([http(ids.project, [a.assetId], null), http(ids.project, [b.assetId], null)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await linkRows()).toHaveLength(1);
    const winner = results[0]!.status === 201 ? a : b;
    expect(await liveFilms()).toEqual([winner.videoId]);
    expect(await n("SELECT count(*) AS n FROM audit_log WHERE action = 'review_link.create'")).toBe(1);
  });

  it("a backfill that runs while a re-Publish is held neither duplicates the link nor changes its address, and the link ends on the new set", async () => {
    const a = await seedVideoVersion({ title: "A" }); const b = await seedVideoVersion({ title: "B" });
    expect((await http(ids.project, [a.assetId], null)).status).toBe(201);
    const [before] = await linkRows();
    const held = gate(); let reached!: () => void; const arrived = new Promise<void>((resolve) => { reached = resolve; });
    const slow = send(ids.project, [b.assetId], { expectedLatestSet: 1 }, { beforeBatch: async () => { reached(); await held.open; } });
    await arrived;
    expect(await syncDeliveryReviewLink(baseEnv.DB, { projectId: ids.project, principal, now: Date.now(), trigger: "backfill" })).toEqual({ created: false, changed: false });
    held.release();
    expect((await slow).kind).toBe("published");
    const rows = await linkRows(); expect(rows).toEqual([before]);
    expect(await liveFilms()).toEqual([b.videoId]);
    expect(await syncDeliveryReviewLink(baseEnv.DB, { projectId: ids.project, principal, now: Date.now(), trigger: "backfill" })).toEqual({ created: false, changed: false });
  });
});
