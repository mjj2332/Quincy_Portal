import { SELF as workerSelf, createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { EXTERNAL_API_RESPONSE_SCHEMAS, videoListResponseSchema } from "@quincy/shared";
import { createAuth } from "../src/auth";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, cookie, database, ids, mp4Bytes, seedFixture, tokens, type Who } from "./embedded-media-support";
import { clearVideoFlags, ensureCollection, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** Staff video review (#741, 4c): the Video list, the Version stream (range, HEAD, If-Range) and the poster. */
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const SIZE = 4096; const BYTES = mp4Bytes(SIZE);
const OPEN = ["video_review", `video_review_pilot:${ids.project}`] as const;

async function get(path: string, who: Who, headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET") {
  return workerSelf.fetch(`https://portal.test${path}`, { method, headers: { cookie: await cookie(who), ...headers } });
}
/** Same, against an Env whose bucket records which operations ran. */
async function recorded(path: string, who: Who, method: "GET" | "HEAD", headers: Record<string, string> = {}) {
  const calls: string[] = [];
  const environment: Env = { ...baseEnv, MEDIA: new Proxy(baseEnv.MEDIA, { get: (target, property) => {
    const value = Reflect.get(target, property);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => { calls.push(String(property)); return (value as (...a: unknown[]) => unknown).apply(target, args); };
  } }) };
  const context = await createAuth(environment).$context;
  const cookieValue = `${context.authCookies.sessionToken.name}=${tokens[who]}.${await makeSignature(tokens[who], authSecret)}`;
  const response = await app.fetch(new Request(`https://portal.test${path}`, { method, headers: { cookie: cookieValue, ...headers } }), environment, createExecutionContext());
  return { response, calls };
}
const consume = async (response: Response) => new Uint8Array(await response.arrayBuffer());

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearVideoFlags(); await setVideoFlags(...OPEN); });
afterEach(async () => { await clearVideoFlags(); });

describe("GET /api/projects/:projectId/videos", () => {
  it("returns each Video with its Versions newest first, the uploader, ISO dates and the server's probed values, to admin, editor and an assigned External", async () => {
    const first = await seedVideoVersion({ title: "Hero cut", uploader: ids.member, poster: true });
    await seedVideoVersion({ projectId: first.projectId, videoId: first.videoId, version: 2, uploader: ids.external });
    const [v1, v2] = (await database.DB.prepare("SELECT id FROM assets WHERE version_group_id = ? ORDER BY version").bind(first.videoId).all<{ id: string }>()).results;
    await database.DB.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ? WHERE id = ?").bind(Date.now(), v2!.id, v1!.id).run();
    for (const who of ["admin", "member", "external"] as const) {
      const response = await get(`/api/projects/${ids.project}/videos`, who);
      expect(response.status, who).toBe(200);
      const body = videoListResponseSchema.parse(await response.json());
      const video = body.videos.find((entry) => entry.id === first.videoId)!;
      expect(video, who).toMatchObject({ title: "Hero cut", premium: false, position: 0, currentAssetId: v2!.id, uploading: null });
      expect(Number.isNaN(Date.parse(video.createdAt))).toBe(false);
      expect(video.versions.map((version) => version.version), who).toEqual([2, 1]);
      expect(video.versions[0]).toMatchObject({ assetId: v2!.id, current: true, uploadedBy: { id: ids.external, name: "External Person", isExternal: true, active: true }, fps: { num: 25, den: 1 }, frameCount: 250, durationMs: 10000, width: 1920, height: 1080, codec: "avc1", startTimecodeFrames: null, tcNominalFps: 25, tcDropFrame: false, fastStart: true, hasAudio: true, hasPoster: false, posterUrl: null, bytes: 4096, originalFilename: "cut.mp4", streamUrl: `/media/video/${v2!.id}` });
      expect(video.versions[1]).toMatchObject({ assetId: v1!.id, current: false, uploadedBy: { id: ids.member, name: "Member Person", isExternal: false }, hasPoster: true, posterUrl: `/media/video/${v1!.id}/poster`, streamUrl: `/media/video/${v1!.id}` });
      expect(Number.isNaN(Date.parse(video.versions[0]!.createdAt))).toBe(false);
      expect(JSON.stringify(body), who).not.toContain("projects/");
    }
  });

  it("parses the External `video-list` surface for every role, empty or not", async () => {
    await setVideoFlags(`video_review_pilot:${ids.otherProject}`);
    const empty = await get(`/api/projects/${ids.otherProject}/videos`, "other");
    expect(EXTERNAL_API_RESPONSE_SCHEMAS["video-list"].parse(await empty.json())).toEqual({ videos: [] });
    const seeded = await seedVideoVersion({ projectId: ids.otherProject, title: "Other cut" });
    const body = EXTERNAL_API_RESPONSE_SCHEMAS["video-list"].parse(await (await get(`/api/projects/${ids.otherProject}/videos`, "admin")).json()) as { videos: Array<{ id: string }> };
    expect(body.videos.map((video) => video.id)).toContain(seeded.videoId);
  });

  it("orders Videos by position, then creation, then id", async () => {
    const collectionId = await ensureCollection(ids.project, "video");
    const a = await seedVideoVersion({ title: "A late" }); const b = await seedVideoVersion({ title: "B early" });
    await database.DB.prepare("UPDATE videos SET position = 5 WHERE id = ?").bind(a.videoId).run();
    await database.DB.prepare("UPDATE videos SET position = 1 WHERE id = ?").bind(b.videoId).run();
    const body = videoListResponseSchema.parse(await (await get(`/api/projects/${ids.project}/videos`, "admin")).json());
    const mine = body.videos.filter((video) => [a.videoId, b.videoId].includes(video.id));
    expect(mine.map((video) => video.id)).toEqual([b.videoId, a.videoId]);
    expect(collectionId).toBeTruthy();
  });

  it("reports an upload in flight on the Video, and ignores a finished or lapsed one", async () => {
    const seeded = await seedVideoVersion({ title: "Being replaced" });
    const reserve = async (status: string, expiresAt: number, creator: string) => {
      const id = crypto.randomUUID(); const assetId = crypto.randomUUID(); const now = Date.now();
      await database.DB.prepare("INSERT INTO video_upload_reservations (id, project_id, collection_id, created_by, video_id, new_video_title, version, asset_id, r2_key, original_filename, bytes, content_type, status, expires_at, completion_audit_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, 2, ?, ?, 'v2.mp4', 1000, 'video/mp4', ?, ?, ?, ?, ?)")
        .bind(id, seeded.projectId, seeded.collectionId, creator, seeded.videoId, assetId, `projects/${seeded.projectId}/video/${seeded.videoId}/${assetId}/original.mp4`, status, expiresAt, crypto.randomUUID(), now, now).run();
      return id;
    };
    const find = async () => videoListResponseSchema.parse(await (await get(`/api/projects/${ids.project}/videos`, "member")).json()).videos.find((video) => video.id === seeded.videoId)!;
    const expired = await reserve("expired", Date.now() + 3_600_000, ids.admin); expect((await find()).uploading).toBeNull();
    await database.DB.prepare("DELETE FROM video_upload_reservations WHERE id = ?").bind(expired).run();
    const lapsed = await reserve("pending", Date.now() - 1000, ids.admin); expect((await find()).uploading).toBeNull();
    await database.DB.prepare("DELETE FROM video_upload_reservations WHERE id = ?").bind(lapsed).run();
    const expiresAt = Date.now() + 3_600_000; await reserve("pending", expiresAt, ids.admin);
    const live = (await find()).uploading!;
    expect(live).toMatchObject({ version: 2, uploader: { id: ids.admin, name: "Admin Person" } });
    expect(Date.parse(live.expiresAt)).toBe(expiresAt);
  });

  it("answers 400 for a bad id, 403 to a photographer, 404 to an outsider External, and 404 once the gate is off", async () => {
    expect((await get("/api/projects/not-a-uuid/videos", "admin")).status).toBe(400);
    expect((await get(`/api/projects/${ids.project}/videos`, "photographer")).status).toBe(403);
    expect((await get(`/api/projects/${ids.project}/videos`, "externalOutsider")).status).toBe(404);
    for (const who of ["admin", "member", "external"] as const) expect((await get(`/api/projects/${ids.project}/videos`, who)).status, who).toBe(200);
    await clearVideoFlags();
    for (const who of ["admin", "member", "external"] as const) expect((await get(`/api/projects/${ids.project}/videos`, who)).status, `${who} gate off`).toBe(404);
    await setVideoFlags("video_review");
    expect((await get(`/api/projects/${ids.project}/videos`, "admin")).status, "master without scope").toBe(404);
  });

  it("reaches the capability check for a photographer who is on the Project at a stage they can see, and refuses with 403", async () => {
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(crypto.randomUUID(), ids.project, ids.photographer, Date.now()).run();
    await database.DB.prepare("UPDATE projects SET stage_key = 'raw_review' WHERE id = ?").bind(ids.project).run();
    try {
      const { assetId } = await seedVideoVersion({ poster: true });
      expect((await get(`/api/projects/${ids.project}/videos`, "photographer")).status).toBe(403);
      expect((await get(`/media/video/${assetId}`, "photographer")).status).toBe(403);
      expect((await get(`/media/video/${assetId}/poster`, "photographer")).status).toBe(403);
    } finally {
      await database.DB.prepare("UPDATE projects SET stage_key = 'editing_autohdr' WHERE id = ?").bind(ids.project).run();
      await database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(ids.project, ids.photographer).run();
    }
  });

  it("keeps listing when the upload part is switched off (there is no view part)", async () => {
    await setVideoFlags(["video_review_upload", false]);
    expect((await get(`/api/projects/${ids.project}/videos`, "member")).status).toBe(200);
  });
});

describe("GET /media/video/:assetId", () => {
  it("streams the whole file with the exact headers, and never a content-disposition even for ?download=1", async () => {
    const { assetId } = await seedVideoVersion();
    for (const path of [`/media/video/${assetId}`, `/media/video/${assetId}?download=1`]) for (const who of ["admin", "member", "external"] as const) {
      const response = await get(path, who);
      expect(response.status, `${who} ${path}`).toBe(200);
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("content-length")).toBe(String(SIZE));
      expect(response.headers.get("etag")).toMatch(/^"/);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(await consume(response)).toEqual(BYTES);
    }
  });

  it("answers a range with 206 and the exact bytes, including a suffix range", async () => {
    const { assetId } = await seedVideoVersion();
    for (const [range, from, to] of [["bytes=0-99", 0, 99], ["bytes=-100", SIZE - 100, SIZE - 1], ["bytes=4000-", 4000, SIZE - 1]] as const) {
      const response = await get(`/media/video/${assetId}`, "member", { range });
      expect(response.status, range).toBe(206);
      expect(response.headers.get("content-range"), range).toBe(`bytes ${from}-${to}/${SIZE}`);
      expect(response.headers.get("content-length"), range).toBe(String(to - from + 1));
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(await consume(response), range).toEqual(BYTES.slice(from, to + 1));
    }
  });

  it("answers an unsatisfiable range with 416 and Content-Range */size", async () => {
    const { assetId } = await seedVideoVersion();
    const response = await get(`/media/video/${assetId}`, "member", { range: `bytes=${SIZE}-` });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${SIZE}`);
    expect((await consume(response)).byteLength).toBe(0);
  });

  it("honours If-Range only on the exact strong ETag", async () => {
    const { assetId } = await seedVideoVersion();
    const full = await get(`/media/video/${assetId}`, "member"); await consume(full); const etag = full.headers.get("etag")!;
    const same = await get(`/media/video/${assetId}`, "member", { range: "bytes=0-9", "if-range": etag });
    expect(same.status).toBe(206); expect((await consume(same)).byteLength).toBe(10);
    const stale = await get(`/media/video/${assetId}`, "member", { range: "bytes=0-9", "if-range": '"stale"' });
    expect(stale.status).toBe(200); expect((await consume(stale)).byteLength).toBe(SIZE);
    const staleBeyond = await get(`/media/video/${assetId}`, "member", { range: `bytes=${SIZE + 5}-`, "if-range": '"stale"' });
    expect(staleBeyond.status).toBe(200); await consume(staleBeyond);
  });

  it("answers HEAD from head() alone: the headers, no body, and no object read", async () => {
    const { assetId } = await seedVideoVersion();
    const { response, calls } = await recorded(`/media/video/${assetId}`, "member", "HEAD");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(SIZE));
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("etag")).toMatch(/^"/);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBeNull();
    expect((await consume(response)).byteLength).toBe(0);
    expect(calls).toContain("head"); expect(calls).not.toContain("get");
  });

  it("ignores Range on HEAD (RFC 9110 section 14.2): 200 with the full length, never 206 or 416, and no object read", async () => {
    const { assetId } = await seedVideoVersion();
    for (const range of ["bytes=0-9", `bytes=${SIZE}-`]) {
      const { response, calls } = await recorded(`/media/video/${assetId}`, "member", "HEAD", { range });
      expect(response.status, range).toBe(200);
      expect(response.headers.get("content-length"), range).toBe(String(SIZE));
      expect(response.headers.get("content-range"), range).toBeNull();
      expect(response.headers.get("accept-ranges"), range).toBe("bytes");
      expect(response.headers.get("etag"), range).toMatch(/^"/);
      expect(response.headers.get("cache-control"), range).toBe("private, no-store");
      expect((await consume(response)).byteLength).toBe(0);
      expect(calls, range).toEqual(["head"]);
    }
  });

  it("with the gate closed, an unassigned Photographer and an outsider External get the same 404 for a real Video as for an unknown id, on the list, stream and poster", async () => {
    const { assetId } = await seedVideoVersion({ poster: true });
    await clearVideoFlags();
    for (const who of ["photographer", "externalOutsider"] as const) {
      for (const suffix of ["", "/poster"]) {
        const real = await get(`/media/video/${assetId}${suffix}`, who); const unknown = await get(`/media/video/${crypto.randomUUID()}${suffix}`, who);
        expect(real.status, `${who} ${suffix}`).toBe(404); expect(unknown.status).toBe(404);
        expect(await real.json(), `${who} ${suffix}`).toEqual(await unknown.json());
      }
      const realList = await get(`/api/projects/${ids.project}/videos`, who); const unknownList = await get(`/api/projects/${crypto.randomUUID()}/videos`, who);
      expect(realList.status, `${who} list`).toBe(404);
      expect(await realList.json(), `${who} list`).toEqual(await unknownList.json());
    }
  });

  it("streams a superseded Version too (compare needs it)", async () => {
    const first = await seedVideoVersion();
    const second = await seedVideoVersion({ projectId: first.projectId, videoId: first.videoId, version: 2 });
    await database.DB.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ? WHERE id = ?").bind(Date.now(), second.assetId, first.assetId).run();
    const response = await get(`/media/video/${first.assetId}`, "member");
    expect(response.status).toBe(200); expect(await consume(response)).toEqual(BYTES);
  });

  it("answers 404 for the next request once the gate is switched off, and once an External is removed from the Project", async () => {
    const { assetId } = await seedVideoVersion();
    expect((await get(`/media/video/${assetId}`, "member")).status).toBe(200);
    expect((await get(`/media/video/${assetId}`, "external")).status).toBe(200);
    await clearVideoFlags();
    for (const who of ["admin", "member", "external"] as const) expect((await get(`/media/video/${assetId}`, who)).status, `${who} gate off`).toBe(404);
    await setVideoFlags(...OPEN);
    expect((await get(`/media/video/${assetId}`, "external")).status).toBe(200);
    const membership = await database.DB.prepare("SELECT id, project_id, user_id, role_on_project, created_at FROM project_members WHERE project_id = ? AND user_id = ?").bind(ids.project, ids.external).first<{ id: string; project_id: string; user_id: string; role_on_project: string; created_at: number }>();
    await database.DB.prepare("DELETE FROM project_members WHERE id = ?").bind(membership!.id).run();
    try { expect((await get(`/media/video/${assetId}`, "external")).status).toBe(404); }
    finally { await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(membership!.id, membership!.project_id, membership!.user_id, membership!.role_on_project, membership!.created_at).run(); }
    expect((await get(`/media/video/${assetId}`, "external")).status).toBe(200);
  });

  it("refuses a photographer with 403, an outsider External with 404, and bad or unknown ids", async () => {
    const { assetId } = await seedVideoVersion();
    expect((await get(`/media/video/${assetId}`, "photographer")).status).toBe(403);
    expect((await get(`/media/video/${assetId}`, "externalOutsider")).status).toBe(404);
    expect((await get("/media/video/not-a-uuid", "admin")).status).toBe(400);
    expect((await get(`/media/video/${crypto.randomUUID()}`, "admin")).status).toBe(404);
  });

  it("answers 404 for a photo Asset id, for every role", async () => {
    const collectionId = await ensureCollection(ids.project, "raw"); const id = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, 'photo', ?, 'r.jpg', 8, 'upload', ?, ?)").bind(id, collectionId, `projects/${ids.project}/raw/${id}.jpg`, now, now).run();
    await database.MEDIA.put(`projects/${ids.project}/raw/${id}.jpg`, new Uint8Array(8));
    for (const who of ["admin", "member", "external"] as const) {
      expect((await get(`/media/video/${id}`, who)).status, who).toBe(404);
      expect((await get(`/media/video/${id}/poster`, who)).status, `${who} poster`).toBe(404);
    }
  });

  it("answers 404 when the stored object is gone", async () => {
    const { assetId } = await seedVideoVersion({ object: false });
    expect((await get(`/media/video/${assetId}`, "member")).status).toBe(404);
    expect((await get(`/media/video/${assetId}`, "member", { range: "bytes=0-9" })).status).toBe(404);
  });
});

describe("GET /media/video/:assetId/poster", () => {
  it("serves the poster as a JPEG to anyone who can stream, and 404s a Version without one", async () => {
    const withPoster = await seedVideoVersion({ poster: true }); const without = await seedVideoVersion();
    for (const who of ["admin", "member", "external"] as const) {
      const response = await get(`/media/video/${withPoster.assetId}/poster`, who);
      expect(response.status, who).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      expect(response.headers.get("cache-control")).toBe("private, max-age=300");
      expect(response.headers.get("vary")).toBe("Cookie");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(response.headers.get("content-disposition")).toBeNull();
      expect((await consume(response)).byteLength).toBe(32);
      expect((await get(`/media/video/${without.assetId}/poster`, who)).status, `${who} none`).toBe(404);
    }
  });

  it("follows the same access rules: gate off 404, photographer 403, outsider External 404", async () => {
    const { assetId } = await seedVideoVersion({ poster: true });
    expect((await get(`/media/video/${assetId}/poster`, "photographer")).status).toBe(403);
    expect((await get(`/media/video/${assetId}/poster`, "externalOutsider")).status).toBe(404);
    expect((await get("/media/video/not-a-uuid/poster", "admin")).status).toBe(400);
    await clearVideoFlags();
    expect((await get(`/media/video/${assetId}/poster`, "member")).status).toBe(404);
  });
});
