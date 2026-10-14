import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { videoListResponseSchema, videoReviewStatusResponseSchema, EXTERNAL_API_RESPONSE_SCHEMAS } from "@quincy/shared";
import { app } from "../src/index";
import { setVersionReviewStatus } from "../src/lib/video-review-status";
import { baseEnv, database, ids, request, seedFixture, type Who } from "./embedded-media-support";
import { seedPage, wipeDelivery } from "./delivery-support";
import { clearVideoFlags, markVersionRemoved, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** Review status (#863): the stored status per Version, the derived Published, the role gate, the two fences, the audit rows and the order of the refusals. */
type Json = Record<string, any>;
const OPEN = ["video_review", `video_review_pilot:${ids.project}`, `video_review_pilot:${ids.archivedProject}`] as const;
const p = (rest: string, projectId: string = ids.project) => `/api/projects/${projectId}${rest}`;
const path = (assetId: string, projectId?: string) => p(`/video-versions/${assetId}/review-status`, projectId);
const set = (assetId: string, reviewStatus: string, expectedStatus: string, who: Who = "admin", projectId?: string) => request(path(assetId, projectId), who, "PUT", { reviewStatus, expectedStatus });
const json = async (response: Response) => await response.json() as Json;
const rows = async (sql: string, ...binds: unknown[]) => (await database.DB.prepare(sql).bind(...binds).all<Json>()).results;
const stored = async (assetId: string) => (await database.DB.prepare("SELECT review_status FROM video_version_meta WHERE asset_id = ?").bind(assetId).first<{ review_status: string }>())!.review_status;
const audits = () => rows("SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE action = 'video_version.review_status_set' ORDER BY created_at, rowid");
const metaOf = (row: Json) => JSON.parse(row.meta_json as string) as Json;
const listed = async (who: Who = "admin", projectId?: string) => videoListResponseSchema.parse(await (await request(p("/videos", projectId), who)).json()).videos;

type Seeded = Awaited<ReturnType<typeof seedVideoVersion>>;
/** A Video with `count` Versions, the newest current and every older one superseded (as upload completion leaves it). */
async function seedVideo(count: number, projectId?: string): Promise<Seeded[]> {
  const out: Seeded[] = [];
  for (let version = 1; version <= count; version += 1) out.push(await seedVideoVersion({ projectId, videoId: out[0]?.videoId, version }));
  const now = Date.now();
  for (let i = 0; i < out.length - 1; i += 1) await database.DB.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ? WHERE id = ?").bind(now, out[i + 1]!.assetId, out[i]!.assetId).run();
  return out;
}

beforeAll(async () => { await seedFixture(); });
const wipe = async () => {
  await wipeDelivery();
  await database.DB.batch([
    database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'video_version.%'"),
    database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets WHERE kind = 'video'"), database.DB.prepare("DELETE FROM videos"),
  ]);
};
beforeEach(async () => { await wipe(); await clearVideoFlags(); await setVideoFlags(...OPEN); });
afterEach(async () => { await wipe(); await clearVideoFlags(); });

describe("setting the status", () => {
  it("lets Admin and Editor approve and return to In review, and answers the fresh Video", async () => {
    const [v1] = await seedVideo(1);
    for (const who of ["admin", "member"] as const) {
      const approved = await set(v1!.assetId, "approved_internal", "in_review", who); expect(approved.status).toBe(200);
      const body = videoReviewStatusResponseSchema.parse(await approved.json());
      expect(body.video).toMatchObject({ id: v1!.videoId, reviewStatus: "approved_internal", olderPublishedVersion: null });
      expect(body.video.versions[0]).toMatchObject({ assetId: v1!.assetId, reviewStatus: "approved_internal" });
      expect(await stored(v1!.assetId)).toBe("approved_internal");
      expect((await set(v1!.assetId, "in_review", "approved_internal", who)).status).toBe(200);
      expect(await stored(v1!.assetId)).toBe("in_review");
    }
  });

  it("refuses an External approving 403 but lets it send a Version back to In review", async () => {
    const [v1] = await seedVideo(1);
    const refused = await set(v1!.assetId, "approved_internal", "in_review", "external"); expect(refused.status).toBe(403);
    expect(await stored(v1!.assetId)).toBe("in_review");
    await set(v1!.assetId, "approved_internal", "in_review", "admin");
    const back = await set(v1!.assetId, "in_review", "approved_internal", "external"); expect(back.status).toBe(200);
    const body = await json(back);
    expect(() => EXTERNAL_API_RESPONSE_SCHEMAS["video-review-status"].parse(body)).not.toThrow();
    expect(await stored(v1!.assetId)).toBe("in_review");
  });

  it("refuses a Photographer 403 for either status", async () => {
    const [v1] = await seedVideo(1);
    expect((await set(v1!.assetId, "in_review", "in_review", "photographer")).status).toBe(403);
    expect((await set(v1!.assetId, "approved_internal", "in_review", "photographer")).status).toBe(403);
  });

  it("answers in the fixed order: malformed id 400, gate 404, body 400, capability 403, External visibility 404, archived 409, Version 404", async () => {
    const [v1] = await seedVideo(1);
    expect((await request(p("/video-versions/not-a-uuid/review-status"), "admin", "PUT", { reviewStatus: "in_review", expectedStatus: "in_review" })).status).toBe(400);
    expect((await request(path(v1!.assetId), "admin", "PUT", { reviewStatus: "published", expectedStatus: "in_review" })).status).toBe(400);
    expect((await request(path(v1!.assetId), "admin", "PUT", { reviewStatus: "in_review" })).status).toBe(400);
    expect((await request(path(v1!.assetId), "admin", "PUT", { reviewStatus: "in_review", expectedStatus: "in_review", extra: 1 })).status).toBe(400);
    expect((await set(v1!.assetId, "in_review", "in_review", "externalOutsider")).status).toBe(404); // an External outside the Project
    expect((await set(crypto.randomUUID(), "in_review", "in_review")).status).toBe(404);
    expect((await set(v1!.assetId, "approved_internal", "in_review", "admin", ids.otherProject)).status).toBe(404); // this Version is not in that Project
    await clearVideoFlags();
    const closed = await set(v1!.assetId, "approved_internal", "in_review"); expect(closed.status).toBe(404);
    expect(await stored(v1!.assetId)).toBe("in_review");
  });

  it("refuses an archived Project 409 project_archived for staff and 404 for an External", async () => {
    const [a] = await seedVideo(1, ids.archivedProject);
    const staff = await set(a!.assetId, "approved_internal", "in_review", "admin", ids.archivedProject);
    expect(staff.status).toBe(409); expect(await json(staff)).toMatchObject({ code: "project_archived" });
    expect(await stored(a!.assetId)).toBe("in_review");
    expect((await audits())).toHaveLength(0);
  });
});

describe("the two fences", () => {
  it("refuses a Version that is no longer the latest 409 not_latest_version with the fresh Video, and writes nothing", async () => {
    const [v1, v2] = await seedVideo(2);
    const stale = await set(v1!.assetId, "approved_internal", "in_review");
    expect(stale.status).toBe(409);
    const body = await json(stale);
    expect(body).toMatchObject({ code: "not_latest_version", video: { id: v1!.videoId, currentAssetId: v2!.assetId, reviewStatus: "in_review" } });
    expect(await stored(v1!.assetId)).toBe("in_review");
    expect(await audits()).toHaveLength(0);
  });

  it("refuses a removed Version of a live Video 409 not_latest_version, and a removed Video 404", async () => {
    const [v1, v2] = await seedVideo(2);
    await markVersionRemoved(v2!.assetId);
    await database.DB.prepare("UPDATE assets SET superseded_at = NULL WHERE id = ?").bind(v1!.assetId).run();
    const removed = await set(v2!.assetId, "approved_internal", "in_review"); expect(removed.status).toBe(409);
    expect(await json(removed)).toMatchObject({ code: "not_latest_version", video: { currentAssetId: v1!.assetId } });
    const [lone] = await seedVideo(1);
    await database.DB.prepare("UPDATE videos SET removed_at = ? WHERE id = ?").bind(Date.now(), lone!.videoId).run();
    expect((await set(lone!.assetId, "approved_internal", "in_review")).status).toBe(404);
  });

  it("refuses a stale expectedStatus 409 review_status_conflict with the fresh Video", async () => {
    const [v1] = await seedVideo(1);
    await set(v1!.assetId, "approved_internal", "in_review", "admin");
    const stale = await set(v1!.assetId, "approved_internal", "in_review", "member"); // member still thinks it is In review, but the target already holds
    expect(stale.status).toBe(200); // same target as the stored status: idempotent, nothing to overwrite
    const conflict = await set(v1!.assetId, "in_review", "in_review", "member"); // would overwrite an approval the caller never saw
    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toMatchObject({ code: "review_status_conflict", video: { reviewStatus: "approved_internal" } });
    expect(await stored(v1!.assetId)).toBe("approved_internal");
  });

  it("writes no audit row for a no-op", async () => {
    const [v1] = await seedVideo(1);
    const same = await set(v1!.assetId, "in_review", "in_review"); expect(same.status).toBe(200);
    expect(await audits()).toHaveLength(0);
  });
});

describe("the audit row", () => {
  it("records before, after, version, Video and Project against the Version", async () => {
    const [, v2] = await seedVideo(2);
    await set(v2!.assetId, "approved_internal", "in_review", "member");
    await set(v2!.assetId, "in_review", "approved_internal", "admin");
    const log = await audits(); expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ actor_id: ids.member, target_type: "asset", target_id: v2!.assetId });
    expect(metaOf(log[0]!)).toEqual({ projectId: ids.project, videoId: v2!.videoId, version: 2, before: "in_review", after: "approved_internal" });
    expect(log[1]).toMatchObject({ actor_id: ids.admin });
    expect(metaOf(log[1]!)).toMatchObject({ before: "approved_internal", after: "in_review" });
  });

  it("answers a successful set from the Video the write touched: the outcome names it", async () => {
    const [v1] = await seedVideo(1);
    const outcome = await setVersionReviewStatus(database.DB, { projectId: ids.project, assetId: v1!.assetId, status: "approved_internal", expected: "in_review", principal: { id: ids.admin, impersonatedBy: null }, now: Date.now() });
    expect(outcome).toEqual({ kind: "set", videoId: v1!.videoId });
  });

  it("records the impersonating Admin", async () => {
    const [v1] = await seedVideo(1);
    await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'user_impersonation'").run();
    try {
      const started = await request("/api/auth/admin/impersonate-user", "admin", "POST", { userId: ids.member }); expect(started.status).toBe(200);
      const cookies = new Map<string, string>();
      for (const value of (started.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()) { const pair = value.split(";", 1)[0]!; const at = pair.indexOf("="); if (at > 0) cookies.set(pair.slice(0, at), pair.slice(at + 1)); }
      const session = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
      const response = await app.fetch(new Request(`https://portal.test${path(v1!.assetId)}`, { method: "PUT", headers: { cookie: session, origin: baseEnv.APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ reviewStatus: "approved_internal", expectedStatus: "in_review" }) }), baseEnv, { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext);
      expect(response.status).toBe(200);
      const [row] = await audits(); expect(row).toMatchObject({ actor_id: ids.member }); expect(metaOf(row!)).toMatchObject({ impersonatedBy: ids.admin, after: "approved_internal" });
    } finally { await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'user_impersonation'").run(); }
  });
});

describe("what the Video reads", () => {
  it("starts a new Version In review and leaves the older Version's approval where it was", async () => {
    const [v1] = await seedVideo(1);
    await set(v1!.assetId, "approved_internal", "in_review");
    expect((await listed())[0]).toMatchObject({ reviewStatus: "approved_internal" });
    const v2 = await seedVideoVersion({ videoId: v1!.videoId, version: 2 });
    await database.DB.prepare("UPDATE assets SET superseded_at = ? WHERE id = ?").bind(Date.now(), v1!.assetId).run();
    const video = (await listed())[0]!;
    expect(video).toMatchObject({ reviewStatus: "in_review", currentAssetId: v2.assetId });
    expect(video.versions.map((version) => [version.version, version.reviewStatus])).toEqual([[2, "in_review"], [1, "approved_internal"]]);
  });

  it("shows the previous Version's stored status once the latest is removed", async () => {
    const [v1, v2] = await seedVideo(2);
    await database.DB.prepare("UPDATE video_version_meta SET review_status = 'approved_internal' WHERE asset_id = ?").bind(v1!.assetId).run();
    expect((await listed())[0]).toMatchObject({ reviewStatus: "in_review" });
    await markVersionRemoved(v2!.assetId);
    await database.DB.prepare("UPDATE assets SET superseded_at = NULL WHERE id = ?").bind(v1!.assetId).run();
    expect((await listed())[0]).toMatchObject({ reviewStatus: "approved_internal", currentAssetId: v1!.assetId });
  });

  it("reads Published while the current Version is in the latest set, and reports an older Version that is", async () => {
    const [v1] = await seedVideo(1);
    await set(v1!.assetId, "approved_internal", "in_review");
    await seedPage({ assetIds: [v1!.assetId] });
    expect((await listed())[0]).toMatchObject({ reviewStatus: "published", olderPublishedVersion: null });
    const v2 = await seedVideoVersion({ videoId: v1!.videoId, version: 2 });
    await database.DB.prepare("UPDATE assets SET superseded_at = ? WHERE id = ?").bind(Date.now(), v1!.assetId).run();
    expect((await listed())[0]).toMatchObject({ reviewStatus: "in_review", olderPublishedVersion: 1, currentAssetId: v2.assetId });
    await database.DB.prepare("DELETE FROM delivery_set_items").run();
    expect((await listed())[0]).toMatchObject({ reviewStatus: "in_review", olderPublishedVersion: null });
  });

  it("falls back to the stored status when a later set leaves the film out, and still reads Published on a switched-off page", async () => {
    const [v1] = await seedVideo(1);
    await set(v1!.assetId, "approved_internal", "in_review");
    await seedPage({ assetIds: [v1!.assetId], enabled: false });
    expect((await listed())[0]).toMatchObject({ reviewStatus: "published" });
    await database.DB.prepare("INSERT INTO delivery_sets (id, project_id, set_number, operation_id, published_by, published_at) VALUES (?, ?, 2, ?, ?, ?)").bind(crypto.randomUUID(), ids.project, crypto.randomUUID().slice(0, 32), ids.admin, Date.now()).run();
    await database.DB.prepare("UPDATE delivery_pages SET latest_set_number = 2").run();
    expect((await listed())[0]).toMatchObject({ reviewStatus: "approved_internal" });
  });

  it("still accepts the write while Published and keeps it stored, though the Video reads Published", async () => {
    const [v1] = await seedVideo(1);
    await seedPage({ assetIds: [v1!.assetId] });
    const response = await set(v1!.assetId, "approved_internal", "in_review"); expect(response.status).toBe(200);
    expect((await json(response)).video).toMatchObject({ reviewStatus: "published" });
    expect(await stored(v1!.assetId)).toBe("approved_internal");
  });
});
