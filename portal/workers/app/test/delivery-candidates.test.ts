import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deliveryCandidatesResponseSchema } from "@quincy/shared";
import { database, ids, request, seedFixture, type Who } from "./embedded-media-support";
import { clearDeliveryFlags, openDelivery, seedAsset, seedOpenProject, seedPage, seedRawPhoto, seedUnlock, setDeliveryFlags, wipeDelivery } from "./delivery-support";
import { clearVideoFlags, seedVideoVersion, setVideoFlags } from "./video-review-support";

/**
 * The Client Delivery tab's own reads and Video premium writes (#787 slice 10 round 3). They sit behind the Client Delivery gate alone: the Video Review gate is NOT consulted, so a Project
 * with Client Delivery on and Video Review off can still list, publish and lock its items.
 */
type Json = Record<string, any>;
const d = (rest: string, projectId: string = ids.project) => `/api/projects/${projectId}/delivery${rest}`;
beforeAll(async () => { await seedFixture(); await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run(); });
const wipe = async () => { await wipeDelivery(); await database.DB.batch([database.DB.prepare("DELETE FROM video_premium_unlocks"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets"), database.DB.prepare("DELETE FROM videos")]); };
beforeEach(async () => { await wipe(); await clearDeliveryFlags(); await clearVideoFlags(); await openDelivery(ids.project, ids.archivedProject); });
afterEach(async () => { await wipe(); await clearDeliveryFlags(); await clearVideoFlags(); });

const candidates = async (who: Who = "admin") => (await request(d("/candidates"), who));
const listed = async () => deliveryCandidatesResponseSchema.parse(await (await candidates()).json()).candidates;
const publish = (assetIds: string[], expectedLatestSet: number | null = null) => request(d("/publish"), "admin", "POST", { assetIds, expectedLatestSet, operationId: crypto.randomUUID() });

describe("GET /delivery/candidates", () => {
  it("lists exactly what Publish accepts, with Video Review closed: a listed item publishes, an omitted one is invalid_selection", async () => {
    const projectId = await seedOpenProject({ stageKey: "edited_review" });
    const photo = await seedAsset("photo", { projectId }); const plan = await seedAsset("floorplan_pdf", { projectId }); const copy = await seedAsset("copy_pdf", { projectId });
    const oldVersion = await seedVideoVersion({ projectId, title: "Hero" });
    const film = await seedVideoVersion({ projectId, videoId: oldVersion.videoId, version: 2 });
    await database.DB.prepare("UPDATE assets SET superseded_at = ? WHERE id = ?").bind(Date.now(), oldVersion.assetId).run();
    const unready = await seedAsset("photo", { projectId });
    await database.DB.prepare("UPDATE assets SET publish_status = 'pending' WHERE id = ?").bind(unready.id).run();
    const omitted = [oldVersion.assetId, unready.id, (await seedRawPhoto(projectId)).id, (await seedAsset("floorplan_preview", { projectId })).id, (await seedAsset("photo", { projectId, superseded: true })).id, (await seedAsset("photo", { projectId: ids.otherProject })).id, crypto.randomUUID()];
    const listedIds = ((await (await request(d("/candidates", projectId), "admin")).json()) as { candidates: Array<{ assetId: string }> }).candidates.map((item) => item.assetId);
    expect(listedIds.sort()).toEqual([photo.id, plan.id, copy.id, film.assetId].sort());
    const publishTo = (assetIds: string[]) => request(d("/publish", projectId), "admin", "POST", { assetIds, expectedLatestSet: null, operationId: crypto.randomUUID() });
    for (const id of omitted) {
      const response = await publishTo([id]);
      expect(response.status, id).toBe(400);
      expect(((await response.json()) as Json).code, id).toBe("invalid_selection");
    }
    const accepted = await publishTo(listedIds);
    expect(accepted.status, JSON.stringify(await accepted.clone().json())).toBe(201);
  });

  it("orders photos, Floorplans, Copy documents then Videos, and carries the name, the Video and the premium state", async () => {
    const photo = await seedAsset("photo", { deliveryPremium: true }); await seedUnlock(photo.id);
    const plan = await seedAsset("floorplan_pdf"); const copy = await seedAsset("copy_pdf");
    const film = await seedVideoVersion({ title: "Hero" });
    await database.DB.prepare("UPDATE videos SET premium = 1 WHERE id = ?").bind(film.videoId).run();
    const items = await listed();
    expect(items.map((item) => item.kind)).toEqual(["photo", "floorplan", "copy", "video"]);
    expect(items[0]).toMatchObject({ assetId: photo.id, name: `${photo.id}.bin`, videoId: null, premium: true, premiumUnlocked: true });
    expect(items[1]).toMatchObject({ assetId: plan.id, premium: false, premiumUnlocked: false });
    expect(items[2]!.assetId).toBe(copy.id);
    expect(items[3]).toMatchObject({ assetId: film.assetId, name: "Hero", videoId: film.videoId, premium: true, premiumUnlocked: false });
  });

  it("is a 404 with the gate closed, 403 without viewClientPreview, and 400 for a malformed id; an Editor may read it", async () => {
    expect((await request(d("/candidates", "not-a-uuid"), "photographer")).status).toBe(400);
    expect((await candidates("photographer")).status).toBe(403);
    expect((await candidates("external")).status).toBe(403);
    expect((await candidates("member")).status).toBe(200);
    await clearDeliveryFlags(); await setDeliveryFlags("client_delivery");
    expect((await candidates()).status).toBe(404);
  });
});

describe("GET /delivery/candidates reviewStatus (#864)", () => {
  const status = (assetId: string, value: string) => database.DB.prepare("UPDATE video_version_meta SET review_status = ? WHERE asset_id = ?").bind(value, assetId).run();
  const openReview = () => setVideoFlags("video_review", "video_review_all_projects");

  it("carries a Video's Review status while Video Review is open, Published while its Version is in the latest set, and null for everything else", async () => {
    await openReview();
    const photo = await seedAsset("photo"); const plan = await seedAsset("floorplan_pdf"); const copy = await seedAsset("copy_pdf");
    const film = await seedVideoVersion({ title: "Hero" });
    expect((await listed()).find((item) => item.kind === "video")?.reviewStatus).toBe("in_review");
    await status(film.assetId, "approved_internal");
    expect((await listed()).find((item) => item.kind === "video")?.reviewStatus).toBe("approved_internal");
    expect((await publish([film.assetId])).status).toBe(201);
    const items = await listed();
    expect(items.find((item) => item.kind === "video")?.reviewStatus).toBe("published");
    expect(items.filter((item) => item.kind !== "video").map((item) => item.reviewStatus)).toEqual([null, null, null]);
    expect([photo.id, plan.id, copy.id].length).toBe(3);
  });

  it("reads a new Version as In review after the previous one was published", async () => {
    await openReview();
    const v1 = await seedVideoVersion({ title: "Hero" });
    expect((await publish([v1.assetId])).status).toBe(201);
    const v2 = await seedVideoVersion({ videoId: v1.videoId, version: 2 });
    await database.DB.prepare("UPDATE assets SET superseded_at = ? WHERE id = ?").bind(Date.now(), v1.assetId).run();
    expect((await listed()).find((item) => item.assetId === v2.assetId)?.reviewStatus).toBe("in_review");
  });

  it("is null for a Video while Video Review is closed, and the list is still served", async () => {
    const film = await seedVideoVersion({ title: "Hero" });
    await status(film.assetId, "approved_internal");
    const response = await candidates();
    expect(response.status).toBe(200);
    expect((await listed()).find((item) => item.kind === "video")?.reviewStatus).toBeNull();
  });
});

describe("PUT /delivery/videos/:videoId/premium and /premium-unlock", () => {
  const premiumPath = (videoId: string, projectId?: string) => d(`/videos/${videoId}/premium`, projectId);
  const unlockPath = (videoId: string, projectId?: string) => d(`/videos/${videoId}/premium-unlock`, projectId);
  const videoRow = (videoId: string) => database.DB.prepare("SELECT premium FROM videos WHERE id = ?").bind(videoId).first<{ premium: number }>();
  const unlockRow = (videoId: string) => database.DB.prepare("SELECT * FROM video_premium_unlocks WHERE video_id = ?").bind(videoId).first<Json>();

  it("marks, unlocks and re-locks with Video Review closed, answering like the Video Review routes", async () => {
    const film = await seedVideoVersion({ title: "Hero" });
    const marked = await request(premiumPath(film.videoId), "admin", "PUT", { premium: true });
    expect(marked.status).toBe(200);
    expect(await marked.json()).toEqual({ premium: true, premiumUnlocked: false });
    expect((await videoRow(film.videoId))?.premium).toBe(1);
    const unlocked = await request(unlockPath(film.videoId), "member", "PUT", { unlocked: true, paymentRef: "INV-1" });
    expect(await unlocked.json()).toEqual({ premium: true, premiumUnlocked: true });
    expect((await unlockRow(film.videoId))?.payment_ref).toBe("INV-1");
    const relocked = await request(unlockPath(film.videoId), "admin", "PUT", { unlocked: false });
    expect(await relocked.json()).toEqual({ premium: true, premiumUnlocked: false });
    expect(await unlockRow(film.videoId)).toBeNull();
  });

  it("is refused for a role without manageVideoPremium (403), an unknown Video (404), a closed gate (404), an archived Project (409) and a published Video's unmark (409)", async () => {
    const film = await seedVideoVersion({ title: "Hero" });
    expect((await request(premiumPath(film.videoId), "photographer", "PUT", { premium: true })).status).toBe(403);
    expect((await request(premiumPath(crypto.randomUUID()), "admin", "PUT", { premium: true })).status).toBe(404);
    expect((await request(premiumPath(film.videoId, "not-a-uuid"), "admin", "PUT", { premium: true })).status).toBe(400);
    const archivedFilm = await seedVideoVersion({ projectId: ids.archivedProject, title: "Old" });
    const archived = await request(premiumPath(archivedFilm.videoId, ids.archivedProject), "admin", "PUT", { premium: true });
    expect(archived.status).toBe(409); expect(((await archived.json()) as Json).code).toBe("project_archived");
    await request(premiumPath(film.videoId), "admin", "PUT", { premium: true });
    await seedPage({ assetIds: [film.assetId] });
    const published = await request(premiumPath(film.videoId), "admin", "PUT", { premium: false });
    expect(published.status).toBe(409); expect(((await published.json()) as Json).code).toBe("premium_published");
    await clearDeliveryFlags(); await setDeliveryFlags("client_delivery");
    expect((await request(premiumPath(film.videoId), "admin", "PUT", { premium: true })).status).toBe(404);
    expect((await request(unlockPath(film.videoId), "admin", "PUT", { unlocked: true })).status).toBe(404);
  });
});
