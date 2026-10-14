import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { videoRenameResponseSchema, EXTERNAL_API_RESPONSE_SCHEMAS } from "@quincy/shared";
import { app } from "../src/index";
import { RECOMPUTE_CURRENT_SQL } from "../src/lib/video-live-sql";
import { renameVersion } from "../src/lib/video-rename";
import { baseEnv, database, ids, request, seedFixture, type Who } from "./embedded-media-support";
import { wipeDelivery } from "./delivery-support";
import { clearVideoFlags, markVersionRemoved, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** Rename a Video (#867): the latest Version's file name is the one write, the title follows through the statement-level recompute, and every refusal writes nothing. */
type Json = Record<string, any>;
const OPEN = ["video_review", `video_review_pilot:${ids.project}`, `video_review_pilot:${ids.archivedProject}`] as const;
const path = (assetId: string, projectId: string = ids.project) => `/api/projects/${projectId}/video-versions/${assetId}/file-name`;
const rename = (assetId: string, filename: unknown, who: Who = "admin", projectId?: string) => request(path(assetId, projectId), who, "PUT", { filename });
const rows = async (sql: string, ...binds: unknown[]) => (await database.DB.prepare(sql).bind(...binds).all<Json>()).results;
const titleOf = async (videoId: string) => (await database.DB.prepare("SELECT title FROM videos WHERE id = ?").bind(videoId).first<{ title: string }>())!.title;
const nameOf = async (assetId: string) => (await database.DB.prepare("SELECT original_filename AS n FROM assets WHERE id = ?").bind(assetId).first<{ n: string }>())!.n;
const audits = () => rows("SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE action = 'video_version.rename' ORDER BY created_at, rowid");
const metaOf = (row: Json) => JSON.parse(row.meta_json as string) as Json;

type Seeded = Awaited<ReturnType<typeof seedVideoVersion>>;
/** A Video with `count` Versions named `cut-N.mp4`, the newest current and the older ones superseded; the title is the newest name's. */
async function seedVideo(count: number, projectId?: string): Promise<Seeded[]> {
  const out: Seeded[] = [];
  for (let version = 1; version <= count; version += 1) out.push(await seedVideoVersion({ projectId, videoId: out[0]?.videoId, version, filename: `cut-${version}.mp4`, title: `cut-${count}` }));
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

describe("renaming", () => {
  it("lets Admin, Editor and an assigned External rename, and answers the fresh Video", async () => {
    for (const who of ["admin", "member", "external"] as const) {
      const [v1] = await seedVideo(1);
      const response = await rename(v1!.assetId, "New name.mp4", who); expect(response.status, await response.clone().text()).toBe(200);
      const body = videoRenameResponseSchema.parse(await response.json());
      expect(body.video).toMatchObject({ id: v1!.videoId, title: "New name" });
      expect(body.video.versions[0]).toMatchObject({ assetId: v1!.assetId, originalFilename: "New name.mp4" });
      expect(await nameOf(v1!.assetId)).toBe("New name.mp4"); expect(await titleOf(v1!.videoId)).toBe("New name");
      if (who === "external") expect(() => EXTERNAL_API_RESPONSE_SCHEMAS["video-rename"].parse(body)).not.toThrow();
      await wipe();
    }
  });

  it("trims, stores .MOV as .mp4, and treats the same name as a no-op that writes no audit row", async () => {
    const [v1] = await seedVideo(1);
    expect((await rename(v1!.assetId, "  Final Cut .MOV ")).status).toBe(200);
    expect(await nameOf(v1!.assetId)).toBe("Final Cut .mp4"); expect(await titleOf(v1!.videoId)).toBe("Final Cut");
    expect(await audits()).toHaveLength(1);
    expect((await rename(v1!.assetId, "Final Cut .mp4")).status).toBe(200);
    expect(await audits()).toHaveLength(1);
  });

  it("writes one audit row with the Version, before and after", async () => {
    const [v1, v2] = await seedVideo(2);
    await rename(v2!.assetId, "Second.mp4", "member");
    const [row, ...rest] = await audits(); expect(rest).toHaveLength(0);
    expect(row).toMatchObject({ actor_id: ids.member, target_type: "asset", target_id: v2!.assetId });
    expect(metaOf(row!)).toEqual({ projectId: ids.project, videoId: v1!.videoId, version: 2, before: "cut-2.mp4", after: "Second.mp4" });
  });

  it("records the impersonating Admin", async () => {
    const [v1] = await seedVideo(1);
    await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'user_impersonation'").run();
    try {
      const started = await request("/api/auth/admin/impersonate-user", "admin", "POST", { userId: ids.member }); expect(started.status).toBe(200);
      const cookies = new Map<string, string>();
      for (const value of (started.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()) { const pair = value.split(";", 1)[0]!; const at = pair.indexOf("="); if (at > 0) cookies.set(pair.slice(0, at), pair.slice(at + 1)); }
      const session = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
      const response = await app.fetch(new Request(`https://portal.test${path(v1!.assetId)}`, { method: "PUT", headers: { cookie: session, origin: baseEnv.APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ filename: "Viewed.mp4" }) }), baseEnv, { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext);
      expect(response.status).toBe(200);
      const [row] = await audits(); expect(row).toMatchObject({ actor_id: ids.member }); expect(metaOf(row!)).toMatchObject({ impersonatedBy: ids.admin, after: "Viewed.mp4" });
    } finally { await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'user_impersonation'").run(); }
  });
});

describe("the name it accepts", () => {
  it.each([
    ["no extension", "plain"], ["an unsupported extension", "clip.avi"], ["a control character", "a\tb.mp4"], ["an extension only", ".mp4"], ["spaces and an extension", "   .mp4"],
    ["a 201 code point stem", `${"a".repeat(201)}.mp4`], ["more than 255 characters", `${"a".repeat(256)}.mp4`], ["not a string", 7],
  ])("refuses %s with 400 and writes nothing", async (_label, filename) => {
    const [v1] = await seedVideo(1);
    expect((await rename(v1!.assetId, filename)).status).toBe(400);
    expect(await nameOf(v1!.assetId)).toBe("cut-1.mp4"); expect(await audits()).toHaveLength(0);
  });

  it("accepts a 200 code point stem and refuses an extra key", async () => {
    const [v1] = await seedVideo(1);
    expect((await request(path(v1!.assetId), "admin", "PUT", { filename: "x.mp4", extra: 1 })).status).toBe(400);
    expect((await rename(v1!.assetId, `${"é".repeat(200)}.mp4`)).status).toBe(200);
    expect(Array.from(await titleOf(v1!.videoId))).toHaveLength(200);
  });
});

describe("who and when", () => {
  it("refuses a Photographer 403 with the capability, and an unassigned External 404", async () => {
    const [v1] = await seedVideo(1);
    const denied = await rename(v1!.assetId, "x.mp4", "photographer"); expect(denied.status).toBe(403); expect(await denied.json()).toMatchObject({ capability: "uploadVideo" });
    expect((await rename(v1!.assetId, "x.mp4", "externalOutsider")).status).toBe(404);
    expect(await nameOf(v1!.assetId)).toBe("cut-1.mp4");
  });

  it("answers in the fixed order: malformed id 400, gate 404, capability 403, External visibility 404, archived 409 before the body 400, then the body and the Version", async () => {
    const [v1] = await seedVideo(1);
    const [a] = await seedVideo(1, ids.archivedProject);
    expect((await request(path("not-a-uuid"), "photographer", "PUT", { filename: 7 })).status).toBe(400);
    expect((await request(path(v1!.assetId), "externalOutsider", "PUT", { filename: 7 })).status).toBe(404);
    const archivedBadBody = await request(path(a!.assetId, ids.archivedProject), "admin", "PUT", { filename: 7 });
    expect(archivedBadBody.status).toBe(409); expect(await archivedBadBody.json()).toMatchObject({ code: "project_archived" });
    expect((await request(path(a!.assetId, ids.archivedProject), "photographer", "PUT", { filename: 7 })).status).toBe(403);
    expect((await request(path(v1!.assetId), "admin", "PUT", { filename: 7 })).status).toBe(400);
    await clearVideoFlags();
    expect((await request(path(v1!.assetId), "photographer", "PUT", { filename: 7 })).status).toBe(404);
  });

  it("answers a successful set from the Video the write touched: the outcome names it", async () => {
    const [v1] = await seedVideo(1);
    const outcome = await renameVersion(database.DB, { projectId: ids.project, assetId: v1!.assetId, filename: "Pinned.mp4", principal: { id: ids.admin, impersonatedBy: null }, now: Date.now() });
    expect(outcome).toEqual({ kind: "set", videoId: v1!.videoId });
  });

  it("answers 404 when the gate is closed, the id is unknown, the Project is another, and 400 for a malformed id", async () => {
    const [v1] = await seedVideo(1);
    expect((await request(path("not-a-uuid"), "admin", "PUT", { filename: "x.mp4" })).status).toBe(400);
    expect((await rename(crypto.randomUUID(), "x.mp4")).status).toBe(404);
    expect((await rename(v1!.assetId, "x.mp4", "admin", ids.otherProject)).status).toBe(404);
    await clearVideoFlags();
    expect((await rename(v1!.assetId, "x.mp4")).status).toBe(404);
    expect(await nameOf(v1!.assetId)).toBe("cut-1.mp4");
  });

  it("refuses an archived Project 409 project_archived for staff and 404 for an External, writing nothing", async () => {
    const [a] = await seedVideo(1, ids.archivedProject);
    const staff = await rename(a!.assetId, "x.mp4", "admin", ids.archivedProject); expect(staff.status).toBe(409); expect(await staff.json()).toMatchObject({ code: "project_archived" });
    expect((await rename(a!.assetId, "x.mp4", "external", ids.archivedProject)).status).toBe(404);
    expect(await nameOf(a!.assetId)).toBe("cut-1.mp4"); expect(await audits()).toHaveLength(0);
  });

  it("refuses a Version in Trash 409 not_latest_version, and a Video in Trash 404", async () => {
    const [v1, v2] = await seedVideo(2);
    await markVersionRemoved(v2!.assetId);
    await database.DB.prepare("UPDATE assets SET superseded_at = NULL WHERE id = ?").bind(v1!.assetId).run();
    const removed = await rename(v2!.assetId, "x.mp4"); expect(removed.status).toBe(409);
    expect(await removed.json()).toMatchObject({ code: "not_latest_version", video: { currentAssetId: v1!.assetId } });
    expect(await nameOf(v2!.assetId)).toBe("cut-2.mp4");
    const [lone] = await seedVideo(1);
    await database.DB.prepare("UPDATE videos SET removed_at = ? WHERE id = ?").bind(Date.now(), lone!.videoId).run();
    expect((await rename(lone!.assetId, "x.mp4")).status).toBe(404);
    expect(await audits()).toHaveLength(0);
  });

  it("refuses a Version that is no longer the latest 409 not_latest_version with the fresh Video, writing nothing", async () => {
    const [v1] = await seedVideo(2);
    const response = await rename(v1!.assetId, "Old.mp4"); expect(response.status).toBe(409);
    const body = await response.json() as Json; expect(body.code).toBe("not_latest_version"); expect(body.video).toMatchObject({ id: v1!.videoId });
    expect(await nameOf(v1!.assetId)).toBe("cut-1.mp4"); expect(await audits()).toHaveLength(0);
  });
});

describe("the title follows the stored name", () => {
  it("is overridden by the next Version and returns when that Version leaves", async () => {
    const [v1] = await seedVideo(1);
    await rename(v1!.assetId, "Renamed.mp4");
    const v2 = await seedVideoVersion({ videoId: v1!.videoId, version: 2, filename: "Cut 2.mp4" });
    const run = async () => { await database.DB.batch(RECOMPUTE_CURRENT_SQL.map((sql) => database.DB.prepare(sql).bind(v1!.videoId, Date.now()))); };
    await run(); expect(await titleOf(v1!.videoId)).toBe("Cut 2");
    expect(await nameOf(v1!.assetId)).toBe("Renamed.mp4");
    await markVersionRemoved(v2.assetId); await run();
    expect(await titleOf(v1!.videoId)).toBe("Renamed");
  });
});
