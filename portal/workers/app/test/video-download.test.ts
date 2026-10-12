import { SELF as workerSelf, createExecutionContext } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { videoVersionDownloadUrl } from "@quincy/shared";
import { createAuth } from "../src/auth";
import { app } from "../src/index";
import type { Env } from "../src/env";
import { baseEnv, cookie, database, ids, mp4Bytes, seedFixture, tokens, type Who } from "./embedded-media-support";
import { clearVideoFlags, markVersionRemoved, markVideoRemoved, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** Staff Version download (#818): the original bytes of one live Version as an attachment, behind the `download` part and the `downloadVideo` capability. */
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const SIZE = 4096; const BYTES = mp4Bytes(SIZE);
const OPEN = ["video_review", `video_review_pilot:${ids.project}`, "video_review_download"] as const;
const AUDIT = "video_version.download";

async function get(path: string, who: Who, headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET") {
  return workerSelf.fetch(`https://portal.test${path}`, { method, headers: { cookie: await cookie(who), ...headers } });
}
const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());
const audits = async () => (await database.DB.prepare("SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE action = ? ORDER BY created_at, id").bind(AUDIT).all<{ actor_id: string; action: string; target_type: string; target_id: string; meta_json: string }>()).results;
/** The real app against a bucket whose `get` and `head` run `after` once R2 has answered, so a Trash or a revocation can land between R2 answering and the first byte. */
async function racing(path: string, who: Who, after: () => Promise<void>, init: { method?: "GET" | "HEAD"; headers?: Record<string, string> } = {}) {
  const environment: Env = { ...baseEnv, MEDIA: new Proxy(baseEnv.MEDIA, { get: (target, property) => {
    const value = Reflect.get(target, property);
    if (typeof value !== "function") return value;
    if (property !== "get" && property !== "head") return value.bind(target);
    return async (...args: unknown[]) => { const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args); await after(); return result; };
  } }) };
  const context = await createAuth(environment).$context;
  const cookieValue = `${context.authCookies.sessionToken.name}=${tokens[who]}.${await makeSignature(tokens[who], authSecret)}`;
  return app.fetch(new Request(`https://portal.test${path}`, { method: init.method ?? "GET", headers: { cookie: cookieValue, ...init.headers } }), environment, createExecutionContext());
}

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => { await clearVideoFlags(); await setVideoFlags(...OPEN); await database.DB.prepare("DELETE FROM audit_log WHERE action = ?").bind(AUDIT).run(); });
afterEach(async () => { await clearVideoFlags(); await database.DB.prepare("DELETE FROM audit_log WHERE action = ?").bind(AUDIT).run(); });

describe("GET /api/projects/:projectId/video-versions/:assetId/download", () => {
  it("serves the original bytes with the exact headers and the RFC 5987 name, to admin, editor and an assigned External", async () => {
    const { assetId } = await seedVideoVersion({ title: "Hero cut", version: 2 });
    const path = videoVersionDownloadUrl(ids.project, assetId);
    for (const who of ["admin", "member", "external"] as const) {
      const response = await get(path, who);
      expect(response.status, who).toBe(200);
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(response.headers.get("content-disposition")).toBe(`attachment; filename="Hero cut v2.mp4"; filename*=UTF-8''Hero%20cut%20v2.mp4`);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("content-length")).toBe(String(SIZE));
      expect(await bytesOf(response)).toEqual(BYTES);
    }
  });

  it("names a stored .mov as .mp4 and sanitises the title", async () => {
    const { assetId } = await seedVideoVersion({ title: 'Café/"Tour"' });
    await database.DB.prepare("UPDATE assets SET original_filename = 'clip.mov' WHERE id = ?").bind(assetId).run();
    const disposition = (await get(videoVersionDownloadUrl(ids.project, assetId), "admin")).headers.get("content-disposition")!;
    expect(disposition).toContain("filename*=UTF-8''Caf%C3%A9%20Tour%20v1.mp4");
    expect(disposition).not.toContain(".mov");
    expect(disposition).not.toContain("/");
  });

  it("is 404 while the download part is off, whatever the role", async () => {
    const { assetId } = await seedVideoVersion();
    await setVideoFlags(["video_review_download", false]);
    for (const who of ["admin", "member", "external", "photographer"] as const) expect((await get(videoVersionDownloadUrl(ids.project, assetId), who)).status, who).toBe(404);
    await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.project}`);
    expect((await get(videoVersionDownloadUrl(ids.project, assetId), "admin")).status, "part row absent").toBe(404);
  });

  it("is 400 for a malformed id, 403 for a photographer, 404 for an unassigned External and 200 for an assigned one", async () => {
    const { assetId } = await seedVideoVersion();
    expect((await get(`/api/projects/not-a-uuid/video-versions/${assetId}/download`, "admin")).status).toBe(400);
    expect((await get(`/api/projects/${ids.project}/video-versions/nope/download`, "admin")).status).toBe(400);
    expect((await get(videoVersionDownloadUrl(ids.project, assetId), "photographer")).status).toBe(403);
    expect((await get(videoVersionDownloadUrl(ids.project, assetId), "externalOutsider")).status).toBe(404);
    expect((await get(videoVersionDownloadUrl(ids.project, assetId), "external")).status).toBe(200);
    expect(await audits()).toHaveLength(1);
  });

  it("is 404 for another Project's Version, a photo asset, and an unknown id", async () => {
    await setVideoFlags(`video_review_pilot:${ids.otherProject}`);
    const mine = await seedVideoVersion({ projectId: ids.otherProject });
    expect((await get(videoVersionDownloadUrl(ids.project, mine.assetId), "admin")).status).toBe(404);
    const photo = crypto.randomUUID(); const collectionId = mine.collectionId;
    await database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version_group_id, version, publish_status, created_at, updated_at) VALUES (?, ?, 'raw', 'k/photo', 'p.jpg', 1, 'upload', ?, 1, 'ready', ?, ?)").bind(photo, collectionId, photo, Date.now(), Date.now()).run();
    expect((await get(videoVersionDownloadUrl(ids.otherProject, photo), "admin")).status).toBe(404);
    expect((await get(videoVersionDownloadUrl(ids.project, crypto.randomUUID()), "admin")).status).toBe(404);
  });

  it("downloads a superseded, an unreleased and a premium-locked Version", async () => {
    const first = await seedVideoVersion({ title: "Locked" });
    const second = await seedVideoVersion({ projectId: first.projectId, videoId: first.videoId, version: 2 });
    await database.DB.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ? WHERE id = ?").bind(Date.now(), second.assetId, first.assetId).run();
    await database.DB.prepare("UPDATE videos SET premium = 1 WHERE id = ?").bind(first.videoId).run();
    for (const assetId of [first.assetId, second.assetId]) expect((await get(videoVersionDownloadUrl(ids.project, assetId), "member")).status, assetId).toBe(200);
  });

  it("is 404 for a trashed Version and for a Version of a trashed Video", async () => {
    const version = await seedVideoVersion(); await markVersionRemoved(version.assetId);
    expect((await get(videoVersionDownloadUrl(ids.project, version.assetId), "admin")).status).toBe(404);
    const video = await seedVideoVersion(); await markVideoRemoved(video.videoId);
    expect((await get(videoVersionDownloadUrl(ids.project, video.assetId), "admin")).status).toBe(404);
    expect(await audits()).toHaveLength(0);
  });

  it("is 404 when the Version is trashed after R2 answered and before the first byte, and writes no audit row", async () => {
    const { assetId } = await seedVideoVersion();
    const response = await racing(videoVersionDownloadUrl(ids.project, assetId), "admin", () => markVersionRemoved(assetId));
    expect(response.status).toBe(404);
    expect(await audits()).toHaveLength(0);
  });

  describe("a revocation that lands while R2 is answering is a 404 with no audit row", () => {
    const unassign = () => database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(ids.project, ids.external).run();
    const reassign = () => database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), ids.project, ids.external, Date.now()).run();
    const partOff = () => setVideoFlags(["video_review_download", false]);
    const shapes: Array<[string, "GET" | "HEAD", Record<string, string>]> = [["GET", "GET", {}], ["HEAD", "HEAD", {}], ["unsatisfiable Range", "GET", { range: `bytes=${SIZE + 10}-` }]];
    for (const [revocation, revoke, restore] of [["assignment removed", unassign, reassign], ["download part turned off", partOff, async () => {}]] as const)
      for (const [label, method, headers] of shapes) it(`${revocation}: ${label}`, async () => {
        const { assetId } = await seedVideoVersion();
        try {
          const response = await racing(videoVersionDownloadUrl(ids.project, assetId), "external", revoke, { method, headers });
          expect(response.status).toBe(404);
          expect(response.headers.get("content-range")).toBeNull();
          expect(response.headers.get("etag")).toBeNull();
        } finally { await restore(); }
        expect(await audits()).toHaveLength(0);
      });
  });

  it("answers a Range with 206 and no audit row, counts `bytes=0-` as a download, and answers HEAD with no body and no audit row", async () => {
    const { assetId } = await seedVideoVersion(); const path = videoVersionDownloadUrl(ids.project, assetId);
    const part = await get(path, "admin", { range: "bytes=10-19" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 10-19/${SIZE}`);
    expect(part.headers.get("content-disposition")).toContain("attachment");
    expect(await bytesOf(part)).toEqual(BYTES.slice(10, 20));
    expect(await audits()).toHaveLength(0);
    const head = await get(path, "admin", {}, "HEAD");
    expect(head.status).toBe(200); expect(head.headers.get("content-length")).toBe(String(SIZE)); expect(await bytesOf(head)).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
    const open = await get(path, "admin", { range: "bytes=0-" });
    expect(open.status).toBe(206); await open.arrayBuffer();
    expect(await audits()).toHaveLength(1);
  });

  it("answers an unsatisfiable Range 416 for a live Version and 404 for a trashed one", async () => {
    const live = await seedVideoVersion();
    expect((await get(videoVersionDownloadUrl(ids.project, live.assetId), "admin", { range: `bytes=${SIZE + 10}-` })).status).toBe(416);
    const gone = await seedVideoVersion(); await markVersionRemoved(gone.assetId);
    expect((await get(videoVersionDownloadUrl(ids.project, gone.assetId), "admin", { range: `bytes=${SIZE + 10}-` })).status).toBe(404);
  });

  it("writes one `video_version.download` row per full GET naming the actor, the Version and its size", async () => {
    const { assetId, videoId } = await seedVideoVersion({ title: "Audited", version: 3 });
    await (await get(videoVersionDownloadUrl(ids.project, assetId), "member")).arrayBuffer();
    const [row, ...rest] = await audits();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({ actor_id: ids.member, action: AUDIT, target_type: "asset", target_id: assetId });
    expect(JSON.parse(row!.meta_json)).toEqual({ projectId: ids.project, videoId, version: 3, bytes: 4096 });
  });

  it("stamps the Admin in `impersonatedBy` when an Admin downloads while impersonating", async () => {
    const { assetId } = await seedVideoVersion();
    await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'user_impersonation'").run();
    const started = await workerSelf.fetch("https://portal.test/api/auth/admin/impersonate-user", { method: "POST", headers: { cookie: await cookie("admin"), origin: baseEnv.APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ userId: ids.member }) });
    expect(started.status).toBe(200);
    const jar = new Map<string, string>();
    for (const value of (started.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []) { const pair = value.split(";", 1)[0]!; const at = pair.indexOf("="); if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1)); }
    const impersonating = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    await (await workerSelf.fetch(`https://portal.test${videoVersionDownloadUrl(ids.project, assetId)}`, { headers: { cookie: impersonating } })).arrayBuffer();
    const [row] = await audits();
    expect(row!.actor_id).toBe(ids.member);
    expect(JSON.parse(row!.meta_json)).toMatchObject({ impersonatedBy: ids.admin });
  });
});
