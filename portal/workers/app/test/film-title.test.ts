import { createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { filmTitleFromFilename, videoRemovalImpactSchema, videoUploadReserveResponseSchema, type VideoRemovalImpact } from "@quincy/shared";
import { FILM_TITLE_CASES } from "../../../packages/shared/src/testing/film-title-cases";
import { buildMp4, videoTrack } from "../../../packages/shared/src/testing/mp4-builder";
import { createAuth } from "../src/auth";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { FILM_TITLE_SQL } from "../src/lib/video-live-sql";
import { baseEnv, database, ids, seedFixture, tokens, type Who } from "./embedded-media-support";
import { clearVideoFlags, ensureCollection, seedVideoVersion, setVideoFlags } from "./video-review-support";

/**
 * #828: a film's title is the file name of its latest live Version. The SQL rule (`FILM_TITLE_SQL`) and `filmTitleFromFilename` are one rule in two languages and are run through
 * one table here against real D1; `RECOMPUTE_CURRENT_SQL` keeps `videos.title` equal to it on every upload, remove and restore.
 */
const DEV_ENV: Env = { ...baseEnv, APP_ENV: "dev" };
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
async function call(path: string, who: Who, method: "GET" | "POST" | "PUT", body?: unknown) {
  const context = await createAuth(DEV_ENV).$context;
  const cookie = `${context.authCookies.sessionToken.name}=${tokens[who]}.${await makeSignature(tokens[who], authSecret)}`;
  const init: RequestInit = { method, headers: { cookie, origin: DEV_ENV.APP_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
  return app.fetch(new Request(`https://portal.test${path}`, init), DEV_ENV, createExecutionContext());
}
const base = `/api/projects/${ids.project}`;
const file = async () => { const source = buildMp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })] }); return source.read(0, source.size); };
const titleOf = async (videoId: string) => (await database.DB.prepare("SELECT title FROM videos WHERE id = ?").bind(videoId).first<{ title: string }>())?.title;
const setTitle = (videoId: string, title: string) => database.DB.prepare("UPDATE videos SET title = ? WHERE id = ?").bind(title, videoId).run();

/** Reserves (a new film unless `videoId` is given) and stores the bytes as the browser's direct PUT would; returns the reservation. */
async function reserve(body: Record<string, unknown>) {
  const bytes = await file();
  const response = await call(`${base}/video-uploads`, "member", "POST", { filename: "cut.mp4", bytes: bytes.byteLength, contentType: "video/mp4", ...body });
  if (response.status !== 201) return { response, reserved: null, failure: await response.text() };
  const reserved = videoUploadReserveResponseSchema.parse(await response.json());
  const row = (await database.DB.prepare("SELECT r2_key AS key, new_video_title AS newVideoTitle, original_filename AS originalFilename FROM video_upload_reservations WHERE id = ?").bind(reserved.reservationId).first<{ key: string; newVideoTitle: string | null; originalFilename: string }>())!;
  await database.MEDIA.put(row.key, bytes, { httpMetadata: { contentType: "video/mp4" } });
  return { response, reserved: { ...reserved, ...row }, failure: null };
}
async function upload(body: Record<string, unknown>) {
  const { response, reserved, failure } = await reserve(body);
  expect(response.status, failure ?? "").toBe(201);
  const done = await call(`${base}/video-uploads/${reserved!.reservationId}/complete`, "member", "POST", {});
  expect(done.status, await done.clone().text()).toBe(201);
  return reserved!;
}

const wipe = async () => {
  await database.DB.batch([
    database.DB.prepare("UPDATE video_upload_reservations SET status = 'failed' WHERE status IN ('pending', 'completing', 'aborting')"),
    database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'video_version.%' OR action LIKE 'video.%'"),
    database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets WHERE kind = 'video'"), database.DB.prepare("DELETE FROM videos"),
  ]);
};
beforeAll(async () => { await seedFixture(); await ensureCollection(ids.project, "video"); });
beforeEach(async () => { await wipe(); await clearVideoFlags(); await setVideoFlags("video_review", "video_review_all_projects", "video_review_upload", "video_review_trash"); });
afterEach(async () => { await wipe(); await clearVideoFlags(); });

describe("FILM_TITLE_SQL equals filmTitleFromFilename (#828)", () => {
  it.each(FILM_TITLE_CASES.map((row, index) => [index, ...row] as const))("case %i (%j) -> %j in D1 and in TypeScript", async (_index, filename, title) => {
    const row = await database.DB.prepare(`SELECT ${FILM_TITLE_SQL("?1")} AS title`).bind(filename).first<{ title: string }>();
    expect(row!.title).toBe(title);
    expect(filmTitleFromFilename(filename)).toBe(title);
  });
});

describe("upload sets and moves the title", () => {
  it("reserves a new film with no title and stores the server-derived one on the reservation", async () => {
    const { response, reserved } = await reserve({ filename: "  Hero Walkthrough.MOV" });
    expect(response.status).toBe(201);
    expect(reserved).toMatchObject({ version: 1, originalFilename: "  Hero Walkthrough.mp4", newVideoTitle: "Hero Walkthrough" });
  });

  it("refuses a file name with a control character at reservation: 400, no reservation row", async () => {
    const before = (await database.DB.prepare("SELECT count(*) AS n FROM video_upload_reservations").first<{ n: number }>())!.n;
    for (const filename of ["\u0000.mp4", "a\u0000b.mov", "a\u0001.mp4"]) {
      const { response } = await reserve({ filename });
      expect(response.status, JSON.stringify(filename)).toBe(400);
    }
    expect((await database.DB.prepare("SELECT count(*) AS n FROM video_upload_reservations").first<{ n: number }>())!.n).toBe(before);
  });

  it("ignores a stale client title: Version 1 is titled from its file name", async () => {
    const reserved = await upload({ filename: "Real name.mp4", title: "Typed in an old tab" });
    expect(reserved.newVideoTitle).toBe("Real name");
    expect(await titleOf(reserved.videoId)).toBe("Real name");
  });

  it("a file name that is only an extension becomes Untitled film", async () => {
    const reserved = await upload({ filename: ".mp4" });
    expect(await titleOf(reserved.videoId)).toBe("Untitled film");
  });

  it("every later Version retitles the film, and a .mov is read as the .mp4 it is stored as", async () => {
    const first = await upload({ filename: "Rough cut.mp4" });
    expect(await titleOf(first.videoId)).toBe("Rough cut");
    await upload({ videoId: first.videoId, filename: "Final v2.MOV" });
    expect(await titleOf(first.videoId)).toBe("Final v2");
    await upload({ videoId: first.videoId, filename: "Final v3.mp4", title: "ignored" });
    expect(await titleOf(first.videoId)).toBe("Final v3");
  });
});

describe("remove and restore keep the title on the latest live Version (#828)", () => {
  const OPEN_TRASH = async () => { await setVideoFlags("video_review", "video_review_trash", "video_review_notes", "video_review_links", "video_review_delivery", `video_review_pilot:${ids.project}`); };
  /** A film with one Version per file name, the newest current and its title stored as the newest name gives it. */
  async function film(names: string[]) {
    const out = [];
    for (let i = 0; i < names.length; i += 1) out.push(await seedVideoVersion({ videoId: out[0]?.videoId, version: i + 1, filename: names[i], title: filmTitleFromFilename(names[0]!), poster: true }));
    const now = Date.now();
    for (let i = 0; i < out.length - 1; i += 1) await database.DB.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ? WHERE id = ?").bind(now, out[i + 1]!.assetId, out[i]!.assetId).run();
    await setTitle(out[0]!.videoId, filmTitleFromFilename(names[names.length - 1]!));
    return out;
  }
  const impactOf = async (assetId: string): Promise<VideoRemovalImpact> => { const r = await call(`${base}/video-versions/${assetId}/removal-impact`, "admin", "GET"); expect(r.status).toBe(200); return videoRemovalImpactSchema.parse(await r.json()); };
  const expectedOf = (i: VideoRemovalImpact) => ({ notes: i.notes, decisions: i.decisions, release: i.release, links: i.links.length });
  const removeAuto = async (assetId: string) => { const i = await impactOf(assetId); return call(`${base}/video-versions/${assetId}/remove`, "admin", "POST", { expected: expectedOf(i), removeVideo: i.lastVersion }); };
  const restoreVersion = (assetId: string) => call(`${base}/video-versions/${assetId}/restore`, "admin", "POST", {});
  const restoreVideo = (videoId: string) => call(`${base}/videos/${videoId}/restore`, "admin", "POST", {});
  beforeEach(OPEN_TRASH);

  it("trashing the newest Version falls back to the next one, and restoring it brings the title back", async () => {
    const [v1, v2, v3] = await film(["Alpha.mp4", "Beta.mp4", "Gamma.mp4"]);
    expect(await titleOf(v1!.videoId)).toBe("Gamma");
    expect((await removeAuto(v3!.assetId)).status).toBe(200);
    expect(await titleOf(v1!.videoId)).toBe("Beta");
    expect((await restoreVersion(v3!.assetId)).status).toBe(200);
    expect(await titleOf(v1!.videoId)).toBe("Gamma");
    void v2;
  });

  it("trashing an older Version leaves the title alone, and restoring it does too", async () => {
    const [v1, v2] = await film(["Alpha.mp4", "Beta.mp4"]);
    expect((await removeAuto(v1!.assetId)).status).toBe(200);
    expect(await titleOf(v2!.videoId)).toBe("Beta");
    expect((await restoreVersion(v1!.assetId)).status).toBe(200);
    expect(await titleOf(v2!.videoId)).toBe("Beta");
  });

  it("removing the whole film freezes the title, and restoring the film refreshes it from its latest live Version", async () => {
    const [v1, v2] = await film(["Alpha.mp4", "Beta.mp4"]);
    expect((await removeAuto(v1!.assetId)).status).toBe(200);
    expect((await removeAuto(v2!.assetId)).status).toBe(200);
    expect(await titleOf(v1!.videoId)).toBe("Beta");
    await setTitle(v1!.videoId, "Stale value");
    expect((await restoreVideo(v1!.videoId)).status).toBe(200);
    expect(await titleOf(v1!.videoId)).toBe("Beta");
  });

  it("a removal refused by the committing batch (the audit fence) leaves the title as it was", async () => {
    const [v1, v2] = await film(["Alpha.mp4", "Beta.mp4"]);
    await setTitle(v1!.videoId, "Stale value");
    // The preliminary read passes (the confirmed counts are the real ones), then a decision lands just before the batch, so only the batch's own conditions refuse it.
    const zero = { notes: 0, decisions: 0, release: false, links: 0 };
    expect(expectedOf(await impactOf(v2!.assetId))).toEqual(zero);
    let ran = false;
    const db = new Proxy(database.DB, { get(target, property) {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        if (!ran && statements.length >= 5) {
          ran = true;
          await database.DB.prepare("INSERT INTO video_approval_events (id, project_id, video_id, asset_id, link_id, revision, decision, note, actor_guest_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, NULL, 1, 'approved', NULL, NULL, ?, ?)").bind(crypto.randomUUID(), ids.project, v2!.videoId, v2!.assetId, ids.admin, Date.now()).run();
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } }) as D1Database;
    const context = await createAuth(DEV_ENV).$context;
    const cookie = `${context.authCookies.sessionToken.name}=${tokens.admin}.${await makeSignature(tokens.admin, authSecret)}`;
    const executionContext = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
    const response = await app.fetch(new Request(`https://portal.test${base}/video-versions/${v2!.assetId}/remove`, { method: "POST", headers: { cookie, origin: DEV_ENV.APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ expected: zero, removeVideo: false }) }), { ...DEV_ENV, DB: db } as Env, executionContext);
    expect(ran, "the committing batch ran through the proxy").toBe(true);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "impact_changed" });
    expect(await database.DB.prepare("SELECT removed_at FROM video_version_meta WHERE asset_id = ?").bind(v2!.assetId).first()).toEqual({ removed_at: null });
    expect(await titleOf(v1!.videoId)).toBe("Stale value");
  });

  it("a film in Trash is not retitled by a recompute", async () => {
    const [v1] = await film(["Alpha.mp4"]);
    expect((await removeAuto(v1!.assetId)).status).toBe(200);
    await setTitle(v1!.videoId, "Frozen");
    const { RECOMPUTE_CURRENT_SQL } = await import("../src/lib/video-live-sql");
    for (const sql of RECOMPUTE_CURRENT_SQL) await database.DB.prepare(sql).bind(v1!.videoId, Date.now()).run();
    expect(await titleOf(v1!.videoId)).toBe("Frozen");
  });
});

describe("readers show the stored title and never the file name (#828)", () => {
  it("the staff list reads videos.title, not the Version's original file name", async () => {
    const seeded = await seedVideoVersion({ title: "Stored Title", filename: "Different Name.mp4" });
    const list = await call(`${base}/videos`, "admin", "GET");
    expect(list.status).toBe(200);
    const body = await list.json() as { videos: Array<{ id: string; title: string }> };
    expect(body.videos.find((video) => video.id === seeded.videoId)?.title).toBe("Stored Title");
  });
});
