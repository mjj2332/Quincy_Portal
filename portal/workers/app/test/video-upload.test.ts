import { createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTERNAL_API_RESPONSE_SCHEMAS, PHOTOGRAPHER_VISIBLE_STAGES, videoObjectKey, videoUploadCompleteResponseSchema, videoUploadReserveResponseSchema, type VideoUploadCompleteResponse } from "@quincy/shared";
import { buildMp4, videoTrack, type Mp4Spec } from "../../../packages/shared/src/testing/mp4-builder";
import { createAuth } from "../src/auth";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, database, ids, jpegBytes, seedFixture, tokens, type Who } from "./embedded-media-support";
import { clearVideoFlags, ensureCollection, reservationStatus, seedReservation, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** Staff video upload (#741 PR 4b): reserve, direct PUT (dev), complete with a server re-probe, abort and the poster. */
const S3_ENV: Env = { ...baseEnv, R2_ACCOUNT_ID: "acct", R2_S3_ACCESS_KEY_ID: "key", R2_S3_SECRET_ACCESS_KEY: "secret" };
const DEV_ENV: Env = { ...baseEnv, APP_ENV: "dev" };
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const photographerProject = "b4444444-4444-4444-8444-444444444444";
const IMPERSONATION_TOKEN = "vu-impersonation-token";
const ACTIVE = "('pending', 'completing', 'aborting')";

async function signedCookie(environment: Env, token: string) {
  const context = await createAuth(environment).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}
async function tokenRequest(environment: Env, path: string, token: string, method: "GET" | "POST" | "PUT", body?: unknown, rawBody?: BodyInit, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { cookie: await signedCookie(environment, token), origin: environment.APP_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : rawBody !== undefined ? { body: rawBody } : {}) };
  return app.fetch(new Request(`https://portal.test${path}`, init), environment, createExecutionContext());
}
const appRequest = (environment: Env, path: string, who: Who, method: "GET" | "POST" | "PUT", body?: unknown, rawBody?: BodyInit, headers: Record<string, string> = {}) => tokenRequest(environment, path, tokens[who], method, body, rawBody, headers);

const base = (projectId: string = ids.project) => `/api/projects/${projectId}/video-uploads`;
const reserve = (who: Who, body: unknown, environment: Env = S3_ENV, projectId?: string) => appRequest(environment, base(projectId), who, "POST", body);
const NO_PARTS = Symbol("no parts");
const complete = (who: Who, reservationId: string, environment: Env = S3_ENV, parts: unknown = [{ partNumber: 1, etag: "e1" }], projectId?: string) => appRequest(environment, `${base(projectId)}/${reservationId}/complete`, who, "POST", parts === NO_PARTS ? {} : { parts });
const abort = (who: Who, reservationId: string, environment: Env = S3_ENV, projectId?: string) => appRequest(environment, `${base(projectId)}/${reservationId}/abort`, who, "POST", {});
const putPoster = (who: Who, assetId: string, body: BodyInit | undefined, environment: Env = baseEnv, headers: Record<string, string> = {}, projectId: string = ids.project) => appRequest(environment, `/api/projects/${projectId}/video-versions/${assetId}/poster`, who, "PUT", undefined, body, headers);

const buildFile = async (spec: Mp4Spec) => { const source = buildMp4(spec); return source.read(0, source.size); };
const GOOD_25 = () => buildFile({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })] });
const wrapMedia = (override: (target: R2Bucket, property: string | symbol) => unknown): Env => ({ ...S3_ENV, MEDIA: new Proxy(baseEnv.MEDIA, { get: (target, property) => {
  const custom = override(target, property); if (custom !== undefined) return custom;
  const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
} }) });

function stubS3(options: { abortStatus?: number; completeStatus?: number; onCreate?: () => Promise<void> } = {}) {
  const calls: Array<{ url: string; method: string }> = []; let created = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); calls.push({ url: request.url, method: request.method });
    if (request.method === "POST" && request.url.includes("?uploads")) { created += 1; await options.onCreate?.(); return new Response(`<InitiateMultipartUploadResult><UploadId>s3-upload-${created}</UploadId></InitiateMultipartUploadResult>`); }
    if (request.method === "POST" && request.url.includes("uploadId=")) return new Response("<CompleteMultipartUploadResult/>", { status: options.completeStatus ?? 200 });
    if (request.method === "DELETE" && request.url.includes("uploadId=")) return new Response(null, { status: options.abortStatus ?? 204 });
    return new Response("unexpected", { status: 500 });
  });
  return calls;
}

type Reserved = { reservationId: string; videoId: string; version: number; key: string; assetId: string; bytes: number };
/** Reserves a Version (a new Video unless `videoId` is given) and stores `file` at the reserved key, as the browser's parts would have. */
async function reserveAndStore(who: Who, options: { file?: Uint8Array; videoId?: string; title?: string; clientProbe?: unknown; projectId?: string; store?: boolean; contentType?: string } = {}): Promise<Reserved> {
  const file = options.file ?? await GOOD_25();
  const response = await reserve(who, { ...(options.videoId ? { videoId: options.videoId } : { title: options.title ?? "Walkthrough" }), filename: "cut.mp4", bytes: file.byteLength, contentType: "video/mp4", ...(options.clientProbe ? { clientProbe: options.clientProbe } : {}) }, S3_ENV, options.projectId);
  expect(response.status, await response.clone().text()).toBe(201);
  const body = videoUploadReserveResponseSchema.parse(await response.json());
  const row = (await database.DB.prepare("SELECT r2_key AS key, asset_id AS assetId FROM video_upload_reservations WHERE id = ?").bind(body.reservationId).first<{ key: string; assetId: string }>())!;
  if (options.store !== false) await database.MEDIA.put(row.key, file, { httpMetadata: { contentType: options.contentType ?? "video/mp4" } });
  return { reservationId: body.reservationId, videoId: body.videoId, version: body.version, key: row.key, assetId: row.assetId, bytes: file.byteLength };
}
const completeBody = async (response: Response) => videoUploadCompleteResponseSchema.parse(await response.json());
const count = async (sql: string, ...binds: unknown[]) => (await database.DB.prepare(`SELECT count(*) AS n FROM ${sql}`).bind(...binds).first<{ n: number }>())!.n;
const queued = (key: string) => database.DB.prepare("SELECT storage_key AS storageKey, upload_id AS uploadId, project_id AS projectId FROM embedded_media_cleanup WHERE storage_key = ?").bind(key).first<{ storageKey: string; uploadId: string | null; projectId: string | null }>();
const reservation = (id: string) => database.DB.prepare("SELECT * FROM video_upload_reservations WHERE id = ?").bind(id).first<Record<string, unknown>>();
const auditRow = async (action: string, targetId: string) => { const row = await database.DB.prepare("SELECT actor_id AS actorId, meta_json AS meta FROM audit_log WHERE action = ? AND target_id = ?").bind(action, targetId).first<{ actorId: string; meta: string | null }>(); return row ? { actorId: row.actorId, meta: JSON.parse(row.meta ?? "{}") as Record<string, unknown> } : null; };
const openGate = () => setVideoFlags("video_review", "video_review_all_projects", "video_review_upload");

beforeAll(async () => {
  await seedFixture();
  await openGate();
  await ensureCollection(ids.project, "video"); await ensureCollection(ids.archivedProject, "video");
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Photographer Street', ?, ?, ?)").bind(photographerProject, PHOTOGRAPHER_VISIBLE_STAGES[0], now, now).run();
  await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(crypto.randomUUID(), photographerProject, ids.photographer, now).run();
  await ensureCollection(photographerProject, "video");
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1, updated_at = ? WHERE key = 'user_impersonation'").bind(now).run();
  await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, impersonated_by, created_at, updated_at) VALUES ('vu-impersonation-session', ?, ?, ?, ?, ?, ?)").bind(now + 3_600_000, IMPERSONATION_TOKEN, ids.member, ids.admin, now, now).run();
});
beforeEach(async () => {
  await openGate();
  await database.DB.prepare(`UPDATE video_upload_reservations SET status = 'failed' WHERE status IN ${ACTIVE}`).run();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("POST /video-uploads (reserve)", () => {
  it("reserves for admin, editor and an assigned External, and never returns the object key", async () => {
    stubS3();
    for (const who of ["admin", "member", "external"] as const) {
      const response = await reserve(who, { title: `Cut by ${who}`, filename: "cut.mp4", bytes: 3_000_000, contentType: "video/mp4" });
      expect(response.status, who).toBe(201);
      expect(response.headers.get("cache-control")).toMatch(/no-store/);
      const json = await response.json() as Record<string, unknown>; expect(Object.keys(json).filter((name) => /key|r2/i.test(name))).toEqual([]);
      const body = videoUploadReserveResponseSchema.parse(json);
      expect(EXTERNAL_API_RESPONSE_SCHEMAS["video-upload-reserve"].parse(body)).toEqual(body);
      expect(body).toMatchObject({ version: 1, partBytes: 64 * 1024 * 1024 }); expect(body.partUrls).toHaveLength(1);
      expect(await reservation(body.reservationId)).toMatchObject({ created_by: ids[who], status: "pending", version: 1, new_video_title: `Cut by ${who}`, bytes: 3_000_000, content_type: "video/mp4", upload_id: body.uploadId, project_id: ids.project });
      await database.DB.prepare(`UPDATE video_upload_reservations SET status = 'failed' WHERE id = ?`).bind(body.reservationId).run();
    }
  });

  it("refuses a photographer on a Project they can see (capability), a photographer who cannot see it, and an outsider External", async () => {
    stubS3(); const before = await count("video_upload_reservations");
    const body = { title: "Cut", filename: "cut.mp4", bytes: 1000, contentType: "video/mp4" };
    const refused = await reserve("photographer", body, S3_ENV, photographerProject);
    expect(refused.status).toBe(403); expect(await refused.json()).toMatchObject({ capability: "uploadVideo" });
    expect((await reserve("photographer", body)).status).toBe(403);
    expect((await reserve("externalOutsider", body)).status).toBe(404);
    expect(await count("video_upload_reservations")).toBe(before);
  });

  it("is a 404 whenever the gate is closed: no flags, no upload part, or only another Project's pilot", async () => {
    stubS3(); const body = { title: "Cut", filename: "cut.mp4", bytes: 1000, contentType: "video/mp4" }; const before = await count("video_upload_reservations");
    await clearVideoFlags(); expect((await reserve("admin", body)).status).toBe(404);
    await setVideoFlags("video_review", "video_review_all_projects"); expect((await reserve("admin", body)).status).toBe(404);
    await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.otherProject}`, "video_review_upload"); expect((await reserve("admin", body)).status).toBe(404);
    expect(await count("video_upload_reservations")).toBe(before);
  });

  it("answers 409 project_archived for an archived Project and 409 video_service_missing for a Project without a Video Collection", async () => {
    stubS3(); const body = { title: "Cut", filename: "cut.mp4", bytes: 1000, contentType: "video/mp4" }; const before = await count("video_upload_reservations");
    const archived = await reserve("admin", body, S3_ENV, ids.archivedProject);
    expect(archived.status).toBe(409); expect(await archived.json()).toMatchObject({ code: "project_archived" });
    const missing = await reserve("other", body, S3_ENV, ids.otherProject);
    expect(missing.status).toBe(409); expect(await missing.json()).toMatchObject({ code: "video_service_missing" });
    expect(await count("video_upload_reservations")).toBe(before);
  });

  it("takes exactly 2,000,000,000 bytes as 30 part URLs that live six hours, and refuses one byte more with 413 and no row", async () => {
    stubS3(); const before = await count("video_upload_reservations");
    const at = Date.now();
    const response = await reserve("member", { title: "Big", filename: "big.mp4", bytes: 2_000_000_000, contentType: "video/mp4" });
    expect(response.status).toBe(201);
    const body = videoUploadReserveResponseSchema.parse(await response.json());
    expect(body.partUrls).toHaveLength(30);
    for (const url of body.partUrls!) expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("21600");
    expect(Date.parse(body.expiresAt) - at).toBeGreaterThan(7 * 3_600_000 - 60_000); expect(Date.parse(body.expiresAt) - at).toBeLessThan(7 * 3_600_000 + 60_000);
    const over = await reserve("member", { title: "Bigger", filename: "big.mp4", bytes: 2_000_000_001, contentType: "video/mp4" });
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({ code: "too_large", message: expect.stringContaining("2 GB") });
    expect(await count("video_upload_reservations")).toBe(before + 1);
  });

  it("refuses a bad body with 400, a wrong content type with 415 and an unknown Video with 404, leaving no row", async () => {
    stubS3(); const before = await count("video_upload_reservations"); const good = { title: "Cut", filename: "cut.mp4", bytes: 1000, contentType: "video/mp4" };
    for (const bad of [{ ...good, title: undefined }, { ...good, videoId: crypto.randomUUID() }, { ...good, filename: "cut.mov" }, { ...good, bytes: 0 }, { ...good, bytes: 1.5 }, { ...good, title: "   " }, { ...good, extra: 1 }, { ...good, clientProbe: { blob: "x".repeat(9000) } }])
      expect((await reserve("member", bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    for (const contentType of ["video/quicktime", "video/webm", "VIDEO/MP4", "application/octet-stream"]) expect((await reserve("member", { ...good, contentType })).status, contentType).toBe(415);
    expect((await reserve("member", { videoId: crypto.randomUUID(), filename: "cut.mp4", bytes: 1000, contentType: "video/mp4" })).status).toBe(404);
    expect(await count("video_upload_reservations")).toBe(before);
  });

  it("lets two concurrent reservations for one Video race to exactly one 201 and one 409 naming the uploader", async () => {
    stubS3(); const seeded = await seedVideoVersion({ title: "Racing" });
    const body = { videoId: seeded.videoId, filename: "v2.mp4", bytes: 5000, contentType: "video/mp4" };
    const [a, b] = await Promise.all([reserve("member", body), reserve("admin", body)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b; const lost = await loser.json() as { code: string; uploader: { name: string }; expiresAt: string };
    expect(lost.code).toBe("upload_in_progress"); expect(lost.uploader.name).toMatch(/Member Person|Admin Person/); expect(Date.parse(lost.expiresAt)).toBeGreaterThan(Date.now());
    expect(await count(`video_upload_reservations WHERE video_id = ? AND status IN ${ACTIVE}`, seeded.videoId)).toBe(1);
  });

  it("numbers a second Version after the first, records what it supersedes, and gives an aborted Version's number back", async () => {
    stubS3(); const seeded = await seedVideoVersion({ title: "Two versions" });
    const first = videoUploadReserveResponseSchema.parse(await (await reserve("member", { videoId: seeded.videoId, filename: "v2.mp4", bytes: 5000, contentType: "video/mp4" })).json());
    expect(first.version).toBe(2);
    expect(await reservation(first.reservationId)).toMatchObject({ version: 2, new_video_title: null, supersedes_asset_id: seeded.assetId, video_id: seeded.videoId });
    expect((await abort("member", first.reservationId)).status).toBe(204);
    const second = videoUploadReserveResponseSchema.parse(await (await reserve("member", { videoId: seeded.videoId, filename: "v2b.mp4", bytes: 5000, contentType: "video/mp4" })).json());
    expect(second.version).toBe(2);
  });

  it("allows three active reservations per person per Project and answers 429 for the fourth", async () => {
    stubS3(); const body = (n: number) => ({ title: `Cap ${n}`, filename: "cut.mp4", bytes: 1000, contentType: "video/mp4" });
    for (let n = 0; n < 3; n += 1) expect((await reserve("member", body(n))).status).toBe(201);
    const fourth = await reserve("member", body(3)); expect(fourth.status).toBe(429); expect(await fourth.json()).toMatchObject({ code: "too_many_uploads" });
    expect((await reserve("admin", body(4))).status).toBe(201);
  });

  it("answers 503 and marks the reservation failed when R2 S3 credentials are missing (production)", async () => {
    const response = await reserve("member", { title: "No creds", filename: "cut.mp4", bytes: 1000, contentType: "video/mp4" }, baseEnv);
    expect(response.status).toBe(503);
    const rows = await database.DB.prepare("SELECT status FROM video_upload_reservations WHERE new_video_title = 'No creds'").all<{ status: string }>();
    expect(rows.results).toEqual([{ status: "failed" }]);
  });

  it("audits the reservation without any part URL", async () => {
    stubS3();
    const body = videoUploadReserveResponseSchema.parse(await (await reserve("member", { title: "Audited", filename: "cut.mp4", bytes: 1000, contentType: "video/mp4" })).json());
    const row = await auditRow("video.upload.reserve", body.reservationId);
    expect(row).toMatchObject({ actorId: ids.member, meta: { projectId: ids.project, bytes: 1000, version: 1 } });
    expect(JSON.stringify(row)).not.toMatch(/X-Amz|partUrls|uploadId/);
  });

  it("releases the reservation and aborts the upload when the Project is archived while R2 starts the upload", async () => {
    const calls = stubS3({ onCreate: async () => { await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run(); } });
    try {
      const response = await reserve("admin", { title: "Late archive", filename: "cut.mp4", bytes: 1000, contentType: "video/mp4" });
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "project_unavailable" });
      expect(calls.some((call) => call.method === "DELETE")).toBe(true);
      expect(await count(`video_upload_reservations WHERE new_video_title = 'Late archive' AND status = 'failed'`)).toBe(1);
    } finally { await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run(); }
  });
});

describe("PUT …/direct (dev only)", () => {
  it("is a 404 anywhere but dev", async () => {
    stubS3(); const { reservationId } = await reserveAndStore("member", { store: false });
    expect((await appRequest(S3_ENV, `${base()}/${reservationId}/direct`, "member", "PUT", undefined, new Uint8Array(10))).status).toBe(404);
  });

  it("reserves with devDirect and no upload id, takes the bytes from the owner only, and completes without parts", async () => {
    const file = await GOOD_25();
    const response = await reserve("member", { title: "Dev cut", filename: "cut.mp4", bytes: file.byteLength, contentType: "video/mp4" }, DEV_ENV);
    expect(response.status).toBe(201);
    const body = videoUploadReserveResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ devDirect: true }); expect(body.uploadId).toBeUndefined(); expect(body.partUrls).toBeUndefined();
    expect((await reservation(body.reservationId))!.upload_id).toBeNull();
    const direct = `${base()}/${body.reservationId}/direct`;
    expect((await appRequest(DEV_ENV, direct, "externalOutsider", "PUT", undefined, file)).status).toBe(404);
    expect((await appRequest(DEV_ENV, direct, "admin", "PUT", undefined, file)).status).toBe(404);
    expect((await appRequest(DEV_ENV, direct, "member", "PUT", undefined, new Uint8Array(file.byteLength + 1))).status).toBe(413);
    expect((await appRequest(DEV_ENV, direct, "member", "PUT", undefined, file)).status).toBe(204);
    const done = await complete("member", body.reservationId, DEV_ENV, NO_PARTS);
    expect(done.status, await done.clone().text()).toBe(201);
  });

  it("refuses bytes for an archived Project", async () => {
    const file = await GOOD_25();
    const body = videoUploadReserveResponseSchema.parse(await (await reserve("admin", { title: "Dev late", filename: "cut.mp4", bytes: file.byteLength, contentType: "video/mp4" }, DEV_ENV)).json());
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run();
    try { expect((await appRequest(DEV_ENV, `${base()}/${body.reservationId}/direct`, "admin", "PUT", undefined, file)).status).toBe(409); }
    finally { await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run(); }
  });
});

describe("POST …/complete", () => {
  it("creates the Video, its Asset and the probed meta for Version 1, answers 201 and repeats as 200 with the same body", async () => {
    stubS3(); const reserved = await reserveAndStore("member", { title: "First cut" });
    const response = await complete("member", reserved.reservationId);
    expect(response.status, await response.clone().text()).toBe(201);
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
    const body = await completeBody(response);
    expect(EXTERNAL_API_RESPONSE_SCHEMAS["video-upload-complete"].parse(body)).toEqual(body);
    expect(body.version).toMatchObject({ assetId: reserved.assetId, version: 1, current: true, fps: { num: 25, den: 1 }, frameCount: 300, durationMs: 12000, width: 1920, height: 1080, codec: "avc1", hasPoster: false, posterUrl: null, streamUrl: `/media/video/${reserved.assetId}`, originalFilename: "cut.mp4", bytes: reserved.bytes, uploadedBy: { id: ids.member, name: "Member Person", isExternal: false } });
    expect(body.video).toMatchObject({ id: reserved.videoId, title: "First cut", premium: false, currentAssetId: reserved.assetId, uploading: null });
    expect(body.video.versions).toHaveLength(1); expect(body.warnings).toEqual([]);
    const collectionId = await ensureCollection(ids.project, "video");
    expect(await database.DB.prepare("SELECT kind, collection_id AS collectionId, version_group_id AS versionGroupId, version, r2_key AS key, source, publish_status AS publishStatus, superseded_at AS supersededAt, width, height FROM assets WHERE id = ?").bind(reserved.assetId).first())
      .toEqual({ kind: "video", collectionId, versionGroupId: reserved.videoId, version: 1, key: videoObjectKey(ids.project, reserved.videoId, reserved.assetId), source: "upload", publishStatus: "ready", supersededAt: null, width: 1920, height: 1080 });
    expect(await database.DB.prepare("SELECT title, position, project_id AS projectId, collection_id AS collectionId, created_by AS createdBy FROM videos WHERE id = ?").bind(reserved.videoId).first()).toMatchObject({ title: "First cut", projectId: ids.project, collectionId, createdBy: ids.member });
    expect(await database.DB.prepare("SELECT fps_num, fps_den, uploaded_by, probe_version, fast_start, has_audio FROM video_version_meta WHERE asset_id = ?").bind(reserved.assetId).first()).toEqual({ fps_num: 25, fps_den: 1, uploaded_by: ids.member, probe_version: 1, fast_start: 1, has_audio: 0 });
    expect(await reservationStatus(reserved.reservationId)).toBe("completed");
    expect(await database.DB.prepare("SELECT received_count AS n FROM collections WHERE id = ?").bind(collectionId).first<{ n: number }>()).toBeTruthy();
    expect(await auditRow("video.version.upload", reserved.assetId)).toMatchObject({ actorId: ids.member, meta: { projectId: ids.project, videoId: reserved.videoId, version: 1, bytes: reserved.bytes, fps: { num: 25, den: 1 }, frameCount: 300, warnings: [], clientProbeDisagreed: [] } });
    const again = await complete("member", reserved.reservationId);
    expect(again.status).toBe(200); expect(await again.json()).toEqual(body);
    expect(await count("assets WHERE version_group_id = ?", reserved.videoId)).toBe(1);
    expect(await count("audit_log WHERE action = 'video.version.upload' AND target_id = ?", reserved.assetId)).toBe(1);
  });

  it("supersedes the previous Version with Version 2 and keeps the Collection count at one Video", async () => {
    stubS3(); const v1 = await reserveAndStore("member", { title: "Evolving" });
    expect((await complete("member", v1.reservationId)).status).toBe(201);
    const collectionId = await ensureCollection(ids.project, "video");
    const before = (await database.DB.prepare("SELECT received_count AS n FROM collections WHERE id = ?").bind(collectionId).first<{ n: number }>())!.n;
    const v2 = await reserveAndStore("admin", { videoId: v1.videoId });
    expect(v2.version).toBe(2);
    const response = await complete("admin", v2.reservationId); expect(response.status, await response.clone().text()).toBe(201);
    const body = await completeBody(response);
    expect(body.video.versions.map((v) => [v.version, v.current])).toEqual([[2, true], [1, false]]);
    expect(body.video.currentAssetId).toBe(v2.assetId);
    expect(await database.DB.prepare("SELECT superseded_at AS supersededAt, replaced_by_asset_id AS replacedBy FROM assets WHERE id = ?").bind(v1.assetId).first()).toEqual({ supersededAt: expect.any(Number), replacedBy: v2.assetId });
    expect(await database.DB.prepare("SELECT supersedes_asset_id AS s, superseded_at AS at FROM assets WHERE id = ?").bind(v2.assetId).first()).toEqual({ s: v1.assetId, at: null });
    expect((await database.DB.prepare("SELECT received_count AS n FROM collections WHERE id = ?").bind(collectionId).first<{ n: number }>())!.n).toBe(before);
    expect(await count("videos WHERE id = ?", v1.videoId)).toBe(1);
  });

  it("stores the server's frame rate whatever the client claims, and audits the disagreement", async () => {
    stubS3(); const reserved = await reserveAndStore("member", { title: "Forged", clientProbe: { fps: { num: 60, den: 1 }, frameCount: 300, width: 1920, height: 1080, durationMs: 12000, codec: "avc1" } });
    const response = await complete("member", reserved.reservationId); expect(response.status).toBe(201);
    expect(await database.DB.prepare("SELECT fps_num, fps_den FROM video_version_meta WHERE asset_id = ?").bind(reserved.assetId).first()).toEqual({ fps_num: 25, fps_den: 1 });
    expect((await auditRow("video.version.upload", reserved.assetId))!.meta).toMatchObject({ clientProbeDisagreed: ["fps"], fps: { num: 25, den: 1 } });
  });

  it("reports the probe's warnings, including on the repeat", async () => {
    stubS3(); const file = await buildFile({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })], moovFirst: false });
    const reserved = await reserveAndStore("member", { title: "Slow start", file });
    const body = await completeBody(await complete("member", reserved.reservationId)); expect(body.warnings).toEqual(["not_fast_start"]);
    expect(body.version.fastStart).toBe(false);
    expect((await completeBody(await complete("member", reserved.reservationId))).warnings).toEqual(["not_fast_start"]);
  });

  it("makes one Asset when two completions race, both answering 2xx", async () => {
    stubS3(); const reserved = await reserveAndStore("member", { title: "Raced" });
    const [a, b] = await Promise.all([complete("member", reserved.reservationId), complete("member", reserved.reservationId)]);
    expect([a.status, b.status].every((status) => status === 200 || status === 201), `${a.status} ${b.status}`).toBe(true);
    expect([a.status, b.status]).toContain(201);
    expect(await count("assets WHERE version_group_id = ?", reserved.videoId)).toBe(1);
    expect(await count("videos WHERE id = ?", reserved.videoId)).toBe(1);
    expect(await count("audit_log WHERE action = 'video.version.upload' AND target_id = ?", reserved.assetId)).toBe(1);
  });

  it.each<[string, Mp4Spec, string]>([
    ["variable frame rate", { tracks: [videoTrack({ timescale: 25000, stts: [[150, 1000], [150, 2000]] })] }, "variable_frame_rate"],
    ["HEVC", { tracks: [videoTrack({ codec: "hvc1" })] }, "hevc"],
    ["an edit list", { tracks: [videoTrack({ elst: [{ segmentDuration: 1000, mediaTime: -1 }] })] }, "unsupported_edit_list"],
    ["a fragmented file", { tracks: [videoTrack()], mvex: true }, "fragmented"],
  ])("rejects %s with 422, deletes the object, keeps no Video and answers the same on a repeat", async (_label, spec, reason) => {
    stubS3(); const reserved = await reserveAndStore("member", { title: `Bad ${reason}`, file: await buildFile(spec) });
    const response = await complete("member", reserved.reservationId); const body = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(422);
    expect(body).toMatchObject({ code: "video_rejected", reason, message: expect.any(String) });
    expect(await database.MEDIA.head(reserved.key)).toBeNull();
    expect(await queued(reserved.key)).toBeNull();
    expect(await reservation(reserved.reservationId)).toMatchObject({ status: "rejected", reject_reason: reason });
    expect(await count("videos WHERE id = ?", reserved.videoId)).toBe(0); expect(await count("assets WHERE id = ?", reserved.assetId)).toBe(0);
    const again = await complete("member", reserved.reservationId); expect(again.status).toBe(422); expect(await again.json()).toEqual(body);
  });

  it("rejects a stored size that is not the reserved size, and a stored type that is not video/mp4", async () => {
    stubS3();
    const short = await reserveAndStore("member", { title: "Short" }); await database.MEDIA.put(short.key, (await GOOD_25()).subarray(0, 100), { httpMetadata: { contentType: "video/mp4" } });
    const sized = await complete("member", short.reservationId); expect(sized.status).toBe(422); expect(await sized.json()).toMatchObject({ code: "video_rejected", reason: "size_mismatch" });
    const typed = await reserveAndStore("member", { title: "Typed", contentType: "video/quicktime" });
    const response = await complete("member", typed.reservationId); expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ reason: "content_type" });
    expect(await database.MEDIA.head(short.key)).toBeNull(); expect(await database.MEDIA.head(typed.key)).toBeNull();
  });

  it("answers 400 upload_missing while the object is absent, keeps the claim, and succeeds once it lands", async () => {
    stubS3(); const reserved = await reserveAndStore("member", { title: "Late bytes", store: false });
    const first = await complete("member", reserved.reservationId); expect(first.status).toBe(400); expect(await first.json()).toMatchObject({ code: "upload_missing" });
    expect(["pending", "completing"]).toContain(await reservationStatus(reserved.reservationId));
    await database.MEDIA.put(reserved.key, await GOOD_25(), { httpMetadata: { contentType: "video/mp4" } });
    expect((await complete("member", reserved.reservationId)).status).toBe(201);
  });

  it("validates multipart parts: missing or non-contiguous parts are 400 and retryable", async () => {
    stubS3(); const reserved = await reserveAndStore("member", { title: "Parts" });
    expect((await complete("member", reserved.reservationId, S3_ENV, NO_PARTS)).status).toBe(400);
    expect((await complete("member", reserved.reservationId, S3_ENV, [{ partNumber: 2, etag: "e" }])).status).toBe(400);
    expect((await complete("member", reserved.reservationId, S3_ENV, [{ partNumber: 1, etag: "e" }, { partNumber: 1, etag: "e" }])).status).toBe(400);
    expect((await complete("member", reserved.reservationId)).status).toBe(201);
  });

  it("carries on when R2 refuses the multipart completion but the object is already there", async () => {
    stubS3({ completeStatus: 403 }); const reserved = await reserveAndStore("member", { title: "Completed twice" });
    expect((await complete("member", reserved.reservationId)).status).toBe(201);
  });

  it("answers 503 and creates nothing when the object changes, or goes missing, between the HEAD and the probe's reads (ETag-pinned)", async () => {
    stubS3();
    for (const how of ["changed", "missing"] as const) {
      const reserved = await reserveAndStore("member", { title: `Moving ${how}` });
      const moving = wrapMedia((target, property) => property === "get" ? async (key: string, options?: R2GetOptions) => {
        if (how === "changed") await target.put(key, await target.get(key).then(async (object) => { const old = new Uint8Array(await object!.arrayBuffer()); old[old.length - 1] = (old[old.length - 1]! + 1) % 256; return old; }), { httpMetadata: { contentType: "video/mp4" } }); else await target.delete(key);
        return target.get(key, options);
      } : undefined);
      const response = await complete("member", reserved.reservationId, moving);
      expect(response.status, how).toBe(503);
      expect(await count("videos WHERE id = ?", reserved.videoId), how).toBe(0); expect(await count("assets WHERE id = ?", reserved.assetId), how).toBe(0);
      expect(await reservationStatus(reserved.reservationId), how).toBe("completing");
      await database.MEDIA.put(reserved.key, await GOOD_25(), { httpMetadata: { contentType: "video/mp4" } });
      expect((await complete("member", reserved.reservationId)).status, how).toBe(201);
    }
  });

  it("answers 503, not a rejection, when a probe read comes back short", async () => {
    stubS3(); const reserved = await reserveAndStore("member", { title: "Short read" });
    const short = wrapMedia((target, property) => property === "get" ? async (key: string, options?: R2GetOptions) => {
      const object = await target.get(key, options);
      if (!object || !("body" in object) || !object.body) return object;
      const bytes = new Uint8Array(await object.arrayBuffer());
      return { body: {}, arrayBuffer: async () => bytes.slice(0, Math.max(0, bytes.byteLength - 1)).buffer } as unknown as R2ObjectBody;
    } : undefined);
    expect((await complete("member", reserved.reservationId, short)).status).toBe(503);
    expect(await reservationStatus(reserved.reservationId)).toBe("completing"); expect(await database.MEDIA.head(reserved.key)).not.toBeNull();
  });

  it("creates nothing when the Project is archived between reserve and complete, and keeps the object for the sweep", async () => {
    stubS3(); const reserved = await reserveAndStore("admin", { title: "Archived mid-upload" });
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run();
    try {
      const response = await complete("admin", reserved.reservationId);
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "project_archived" });
      expect(await count("videos WHERE id = ?", reserved.videoId)).toBe(0); expect(await count("assets WHERE id = ?", reserved.assetId)).toBe(0);
      expect(await reservationStatus(reserved.reservationId)).toBe("pending");
    } finally { await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run(); }
  });

  it("fences the batch itself: a Project archived after the probe, or an abort that wins the claim, commits nothing", async () => {
    stubS3();
    const archiving = new Proxy(baseEnv.DB, { get: (target, property) => {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => { await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run(); return target.batch(statements); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const reserved = await reserveAndStore("admin", { title: "Fenced" });
    try {
      const response = await complete("admin", reserved.reservationId, { ...S3_ENV, DB: archiving });
      expect(response.status).toBe(409);
      expect(await count("assets WHERE id = ?", reserved.assetId)).toBe(0); expect(await count("videos WHERE id = ?", reserved.videoId)).toBe(0);
    } finally { await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project).run(); }
    const second = await reserveAndStore("member", { title: "Aborted under the batch" });
    const aborting = new Proxy(baseEnv.DB, { get: (target, property) => {
      if (property === "batch") return async (statements: D1PreparedStatement[]) => { await database.DB.prepare("UPDATE video_upload_reservations SET status = 'aborting' WHERE id = ?").bind(second.reservationId).run(); return target.batch(statements); };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const lost = await complete("member", second.reservationId, { ...S3_ENV, DB: aborting });
    expect(lost.status).toBe(409);
    expect(await count("assets WHERE id = ?", second.assetId)).toBe(0); expect(await reservationStatus(second.reservationId)).toBe("aborting");
  });

  it("is the reserver's alone (404 for anyone else), is a 404 for an External removed from the Project, and a 409 once expired", async () => {
    stubS3(); const reserved = await reserveAndStore("member", { title: "Mine" });
    expect((await complete("admin", reserved.reservationId)).status).toBe(404);
    expect((await complete("member", crypto.randomUUID())).status).toBe(404);
    const external = await reserveAndStore("external", { title: "External cut" });
    await database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(ids.project, ids.external).run();
    try { expect((await complete("external", external.reservationId)).status).toBe(404); expect(await count("videos WHERE id = ?", external.videoId)).toBe(0); }
    finally { await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), ids.project, ids.external, Date.now()).run(); }
    await database.DB.prepare("UPDATE video_upload_reservations SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, reserved.reservationId).run();
    const expired = await complete("member", reserved.reservationId); expect(expired.status).toBe(409); expect(await expired.json()).toMatchObject({ code: "upload_unavailable" });
    expect(await count("videos WHERE id = ?", reserved.videoId)).toBe(0);
  });

  it("is a 404 once the gate is closed or the upload part is switched off", async () => {
    stubS3(); const reserved = await reserveAndStore("member", { title: "Gated" });
    await clearVideoFlags(); expect((await complete("member", reserved.reservationId)).status).toBe(404);
    await openGate(); expect((await complete("member", reserved.reservationId)).status).toBe(201);
  });

  it("acts as the impersonated user for an Admin and audits who was behind it", async () => {
    stubS3(); const file = await GOOD_25();
    const response = await tokenRequest(S3_ENV, base(), IMPERSONATION_TOKEN, "POST", { title: "Impersonated", filename: "cut.mp4", bytes: file.byteLength, contentType: "video/mp4" });
    expect(response.status, await response.clone().text()).toBe(201);
    const body = videoUploadReserveResponseSchema.parse(await response.json());
    const row = (await reservation(body.reservationId))!; expect(row.created_by).toBe(ids.member);
    await database.MEDIA.put(row.r2_key as string, file, { httpMetadata: { contentType: "video/mp4" } });
    const done = await tokenRequest(S3_ENV, `${base()}/${body.reservationId}/complete`, IMPERSONATION_TOKEN, "POST", { parts: [{ partNumber: 1, etag: "e1" }] });
    expect(done.status, await done.clone().text()).toBe(201);
    expect((await completeBody(done)).version.uploadedBy.id).toBe(ids.member);
    expect(await auditRow("video.upload.reserve", body.reservationId)).toMatchObject({ actorId: ids.member, meta: { impersonatedBy: ids.admin } });
    expect(await auditRow("video.version.upload", row.asset_id as string)).toMatchObject({ actorId: ids.member, meta: { impersonatedBy: ids.admin } });
  });
});

describe("POST …/abort", () => {
  it("aborts the multipart upload, deletes the object and marks the reservation failed (204), idempotently, for the owner alone", async () => {
    const calls = stubS3(); const reserved = await reserveAndStore("member", { title: "Cancelled" });
    expect((await abort("admin", reserved.reservationId)).status).toBe(404);
    expect((await abort("member", reserved.reservationId)).status).toBe(204);
    expect(calls.some((call) => call.method === "DELETE" && call.url.includes("uploadId=s3-upload"))).toBe(true);
    expect(await database.MEDIA.head(reserved.key)).toBeNull(); expect(await reservationStatus(reserved.reservationId)).toBe("failed");
    expect((await abort("member", reserved.reservationId)).status).toBe(204);
    expect((await abort("member", crypto.randomUUID())).status).toBe(404);
  });

  it("refuses to abort a completed upload (409) and answers 204 for a rejected one", async () => {
    stubS3(); const done = await reserveAndStore("member", { title: "Done" });
    expect((await complete("member", done.reservationId)).status).toBe(201);
    expect((await abort("member", done.reservationId)).status).toBe(409);
    const rejected = await reserveAndStore("member", { title: "Rejected", file: await buildFile({ tracks: [videoTrack({ codec: "hvc1" })] }) });
    expect((await complete("member", rejected.reservationId)).status).toBe(422);
    expect((await abort("member", rejected.reservationId)).status).toBe(204);
  });

  it("answers 503 and leaves the row aborting when R2 refuses the abort, and finishes on a retry", async () => {
    stubS3({ abortStatus: 403 }); const reserved = await reserveAndStore("member", { title: "Stuck" });
    expect((await abort("member", reserved.reservationId)).status).toBe(503);
    expect(await reservationStatus(reserved.reservationId)).toBe("aborting");
    stubS3(); expect((await abort("member", reserved.reservationId)).status).toBe(204);
    expect(await reservationStatus(reserved.reservationId)).toBe("failed");
  });

  it("stops a completion that is in flight: the batch cannot commit once the abort won the claim", async () => {
    stubS3(); const reserved = await reserveAndStore("member", { title: "Abort wins" });
    expect((await abort("member", reserved.reservationId)).status).toBe(204);
    expect((await complete("member", reserved.reservationId)).status).toBe(409);
    expect(await count("assets WHERE id = ?", reserved.assetId)).toBe(0);
  });
});

describe("PUT /video-versions/:assetId/poster", () => {
  const url = (assetId: string) => `/api/projects/${ids.project}/video-versions/${assetId}/poster`;
  async function committed(who: Who = "member", title = "Posters") {
    stubS3(); const reserved = await reserveAndStore(who, { title });
    expect((await complete(who, reserved.reservationId)).status).toBe(201);
    return reserved;
  }
  const queuedPoster = (assetId: string, videoId: string) => database.DB.prepare("SELECT storage_key AS key FROM embedded_media_cleanup WHERE storage_key LIKE ?").bind(`projects/${ids.project}/video/${videoId}/${assetId}/poster-%`).all<{ key: string }>();

  it("takes one JPEG from the uploader inside the Project's video prefix, once", async () => {
    const reserved = await committed();
    expect((await putPoster("admin", reserved.assetId, jpegBytes(64))).status).toBe(404);
    expect((await putPoster("member", reserved.assetId, jpegBytes(64))).status).toBe(204);
    const row = await database.DB.prepare("SELECT poster_key AS key FROM video_version_meta WHERE asset_id = ?").bind(reserved.assetId).first<{ key: string }>();
    expect(row!.key).toMatch(new RegExp(`^projects/${ids.project}/video/${reserved.videoId}/${reserved.assetId}/poster-.+\\.jpg$`));
    expect(await database.MEDIA.head(row!.key)).not.toBeNull(); expect((await queuedPoster(reserved.assetId, reserved.videoId)).results).toEqual([]);
    const second = await putPoster("member", reserved.assetId, jpegBytes(64)); expect(second.status).toBe(409); expect(await second.json()).toMatchObject({ code: "poster_unavailable" });
    expect(await database.MEDIA.list({ prefix: `projects/${ids.project}/video/${reserved.videoId}/${reserved.assetId}/poster-` }).then((list) => list.objects.length)).toBe(1);
  });

  it("refuses a body over 2 MB (413), a non-JPEG (400), an unknown or other-Project Version (404), a closed gate (404) and an archived Project (409)", async () => {
    const reserved = await committed("member", "Poster refusals");
    expect((await putPoster("member", reserved.assetId, new Uint8Array(2 * 1024 * 1024 + 1).fill(0xff))).status).toBe(413);
    expect((await putPoster("member", reserved.assetId, new Uint8Array(100), baseEnv, { "content-length": String(3 * 1024 * 1024) })).status).toBe(413);
    expect((await putPoster("member", reserved.assetId, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).status).toBe(400);
    expect((await putPoster("member", crypto.randomUUID(), jpegBytes(64))).status).toBe(404);
    expect((await putPoster("member", reserved.assetId, jpegBytes(64), baseEnv, {}, ids.otherProject)).status).toBe(404);
    await clearVideoFlags(); expect((await putPoster("member", reserved.assetId, jpegBytes(64))).status).toBe(404); await openGate();
    expect((await putPoster("external", reserved.assetId, jpegBytes(64))).status).toBe(404);
    expect((await putPoster("photographer", reserved.assetId, jpegBytes(64))).status).toBe(403);
    expect((await queuedPoster(reserved.assetId, reserved.videoId)).results).toEqual([]);
    expect(await count("video_version_meta WHERE asset_id = ? AND poster_key IS NOT NULL", reserved.assetId)).toBe(0);
  });

  it("queues the key before writing it, so a crash after the write still has an owner", async () => {
    const reserved = await committed("member", "Poster queue"); let queuedBeforePut = false;
    const watching = wrapMedia((target, property) => property === "put" ? async (key: string, ...rest: unknown[]) => {
      queuedBeforePut = (await queued(key)) !== null; return (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest);
    } : undefined);
    expect((await putPoster("member", reserved.assetId, jpegBytes(64), watching)).status).toBe(204); expect(queuedBeforePut).toBe(true);
  });

  it("leaves no orphan when the Project cascades away mid-write: with R2 refusing the delete the key waits in the cleanup queue", async () => {
    const projectId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Cascade', 'editing_autohdr', ?, ?)").bind(projectId, now, now).run();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, ids.member, now).run();
    const seeded = await seedVideoVersion({ projectId, uploader: ids.member });
    let written = "";
    const racing = wrapMedia((target, property) => {
      if (property === "delete") return async () => { throw new Error("R2 down"); };
      if (property === "put") return async (key: string, ...rest: unknown[]) => {
        written = key; const result = await (target.put as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest);
        await database.DB.prepare("DELETE FROM projects WHERE id = ? AND ? > 0").bind(projectId, 1).run();
        return result;
      };
      return undefined;
    });
    const response = await putPoster("member", seeded.assetId, jpegBytes(64), racing, {}, projectId);
    expect(response.status).toBe(409);
    expect(await queued(written)).toMatchObject({ storageKey: written, projectId });
  });
});
