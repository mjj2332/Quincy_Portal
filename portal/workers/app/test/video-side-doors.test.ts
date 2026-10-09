import { SELF as workerSelf, createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { TRANSFORM_CACHE_VERSION } from "@quincy/shared";
import { app } from "../src/index";
import { createAuth } from "../src/auth";
import { coverMaps } from "../src/lib/project-covers";
import { createDb } from "@quincy/db";
import { issueTransformSource } from "../src/lib/transform-source";
import type { Env } from "../src/env";
import { baseEnv, database, ids, jpegBytes, request, seedFixture, tokens, type Who } from "./embedded-media-support";
import { ensureCollection, seedVideoVersion } from "./video-review-support";

/** Every route that reads or writes an Asset by id must treat a video-kind Asset like an unknown id (#741 PR 4a): the Video routes are the only door. */
const STAFF_AND_EXTERNAL: Who[] = ["admin", "member", "external", "photographer"];
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
let video: Awaited<ReturnType<typeof seedVideoVersion>>;

beforeAll(async () => {
  await seedFixture();
  video = await seedVideoVersion({ projectId: ids.project });
});

async function shape(response: Response) { return { status: response.status, body: await response.text() }; }
const unknownId = () => crypto.randomUUID();

async function appRequest(environment: Env, path: string, who: Who, method: "GET" | "POST" | "DELETE", body?: unknown) {
  const context = await createAuth(environment).$context;
  const cookieValue = `${context.authCookies.sessionToken.name}=${tokens[who]}.${await makeSignature(tokens[who], authSecret)}`;
  const init: RequestInit = { method, headers: { cookie: cookieValue, origin: environment.APP_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) };
  return app.fetch(new Request(`https://portal.test${path}`, init), environment, createExecutionContext());
}
/** An environment whose D1 runs `before` just ahead of every batch: the window a concurrent writer would use. */
function racingDb(before: () => Promise<unknown>): Env {
  const wrapped = new Proxy(baseEnv.DB, { get: (target, property) => {
    if (property === "batch") return async (statements: D1PreparedStatement[]) => { await before(); return target.batch(statements); };
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } });
  return { ...baseEnv, DB: wrapped };
}

describe("/media/asset/:id/:variant", () => {
  for (const variant of ["original", "web", "thumb"] as const) {
    it(`answers a video Asset's ${variant} exactly like an unknown id, for every role`, async () => {
      for (const who of STAFF_AND_EXTERNAL) {
        const real = await request(`/media/asset/${video.assetId}/${variant}`, who);
        const unknown = await request(`/media/asset/${unknownId()}/${variant}`, who);
        const [a, b] = [await shape(real), await shape(unknown)];
        expect(a, `${who} ${variant}`).toEqual(b);
        expect(a.status, `${who} ${variant}`).toBeGreaterThanOrEqual(400);
        expect(real.headers.get("content-type")).not.toMatch(/video|jpeg/);
      }
    });
  }

  it("keeps serving a photo Asset in the same Project (control)", async () => {
    const collectionId = await ensureCollection(ids.project, "raw"); const id = crypto.randomUUID(); const key = `projects/${ids.project}/raw/${id}.jpg`; const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, 'photo', ?, 'p.jpg', 32, 'upload', ?, ?)").bind(id, collectionId, key, now, now).run();
    await database.MEDIA.put(key, jpegBytes(32), { httpMetadata: { contentType: "image/jpeg" } });
    for (const who of ["admin", "member"] as const) expect((await request(`/media/asset/${id}/original`, who)).status, who).toBe(200);
  });
});

describe("GET /api/projects/:id/assets?collection=video", () => {
  it("lists no video-kind Asset for staff or an assigned External, and still lists any other kind in that Collection", async () => {
    const other = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, 'photo', ?, 'still.jpg', 8, 'upload', ?, ?)").bind(other, video.collectionId, `projects/${ids.project}/video-still/${other}.jpg`, now, now).run();
    for (const who of ["admin", "member", "external"] as const) {
      const response = await request(`/api/projects/${ids.project}/assets?collection=video`, who);
      expect(response.status, who).toBe(200);
      const listed = ((await response.json()) as { assets: Array<{ id: string }> }).assets.map((asset) => asset.id);
      expect(listed, who).not.toContain(video.assetId);
      expect(listed, who).toContain(other);
    }
  });
});

describe("POST /api/assets/:id/review", () => {
  it("answers 404 for a video Asset, writes no review state, and answers an unknown id the same way", async () => {
    for (const who of ["admin", "member", "external"] as const) {
      const real = await shape(await request(`/api/assets/${video.assetId}/review`, who, "POST", { stars: 3 }));
      const unknown = await shape(await request(`/api/assets/${unknownId()}/review`, who, "POST", { stars: 3 }));
      expect(real, who).toEqual(unknown);
      expect(real.status, who).toBe(404);
    }
    expect(await database.DB.prepare("SELECT 1 FROM asset_review_state WHERE asset_id = ?").bind(video.assetId).first()).toBeNull();
  });
});

describe("DELETE /api/assets/:id", () => {
  it("refuses to delete a video Version with 409 video_version_immutable, and keeps the row and the object", async () => {
    const response = await request(`/api/assets/${video.assetId}`, "admin", "DELETE");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "video_version_immutable" });
    expect(await database.DB.prepare("SELECT 1 FROM assets WHERE id = ?").bind(video.assetId).first()).not.toBeNull();
    expect(await database.MEDIA.head(video.key)).not.toBeNull();
  });

  it("repeats the guard in the SQL: an Asset that became a video Version after the route read it is not deleted", async () => {
    const collectionId = await ensureCollection(ids.project, "raw"); const id = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, 'photo', ?, 'r.jpg', 8, 'upload', ?, ?)").bind(id, collectionId, `projects/${ids.project}/raw/${id}.jpg`, now, now).run();
    const environment = racingDb(() => database.DB.prepare("UPDATE assets SET kind = 'video' WHERE id = ?").bind(id).run());
    const response = await appRequest(environment, `/api/assets/${id}`, "admin", "DELETE");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "video_version_immutable" });
    expect(await database.DB.prepare("SELECT kind FROM assets WHERE id = ?").bind(id).first()).toEqual({ kind: "video" });
  });
});

describe("annotations (already closed to video, pinned here)", () => {
  it("answers a video Asset 400 for staff and 404 for an External on read and write", async () => {
    for (const method of ["GET", "POST"] as const) {
      const body = method === "POST" ? { scope: "edited", noteText: "hello" } : undefined;
      expect((await request(`/api/assets/${video.assetId}/annotations`, "admin", method, body)).status, `admin ${method}`).toBe(400);
      expect((await request(`/api/assets/${video.assetId}/annotations`, "external", method, body)).status, `external ${method}`).toBe(404);
    }
  });
});

describe("/__transform-source/*", () => {
  async function source(key: string) {
    const issued = await issueTransformSource(baseEnv, key, ids.admin, 0);
    const query = new URLSearchParams({ v: TRANSFORM_CACHE_VERSION, exp: String(issued.expiresAt), p: ids.admin, ae: "0", sig: issued.signature });
    return workerSelf.fetch(`https://portal.test/__transform-source/${key.split("/").map(encodeURIComponent).join("/")}?${query}`);
  }

  it("refuses a correctly signed video key and serves the same signature for a photo key", async () => {
    const photoKey = `projects/${ids.project}/raw/signed-control.jpg`;
    await database.MEDIA.put(photoKey, jpegBytes(16), { httpMetadata: { contentType: "image/jpeg" } });
    expect((await source(photoKey)).status).toBe(200);
    expect((await source(video.key)).status).toBe(404);
    if (video.posterKey) expect((await source(video.posterKey)).status).toBe(404);
  });
});

describe("Project cover readers", () => {
  it("do not return a video Asset stored as a Project's cover, for staff or an External", async () => {
    const mine = await seedVideoVersion({ projectId: ids.otherProject });
    await database.DB.prepare("UPDATE projects SET cover_asset_id = ? WHERE id = ?").bind(mine.assetId, ids.otherProject).run();
    const maps = await coverMaps(createDb(database.DB), [ids.otherProject]);
    expect(maps.storedByProject.get(ids.otherProject)).toBeUndefined();
    const detail = await (await request(`/api/projects/${ids.otherProject}`, "admin")).json() as { effectiveCoverAssetId: string | null };
    expect(detail.effectiveCoverAssetId).toBeNull();
    await database.DB.prepare("UPDATE projects SET cover_asset_id = ? WHERE id = ?").bind(video.assetId, ids.project).run();
    const external = await (await request(`/api/projects/${ids.project}`, "external")).json() as { cover: { assetId: string } | null };
    expect(external.cover?.assetId).not.toBe(video.assetId);
    await database.DB.prepare("UPDATE projects SET cover_asset_id = NULL WHERE id IN (?, ?)").bind(ids.project, ids.otherProject).run();
  });

  it("refuses to set a video Asset as the cover (already closed, pinned here)", async () => {
    const response = await request(`/api/projects/${ids.project}/cover`, "admin", "POST", { assetId: video.assetId });
    expect(response.status).toBe(404);
  });
});
