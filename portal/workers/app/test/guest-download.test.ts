import { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { guestVideoListResponseSchema } from "@quincy/shared";
import { GUEST_WINDOW_MS } from "../src/guest/rate-limit";
import { attachment, mountGuestDownloads, safeFileName } from "../src/guest/download";
import type { AppEnv } from "../src/env";
import { hashToken } from "../src/lib/opaque-token";
import { baseEnv, database, ids, mp4Bytes, seedFixture } from "./embedded-media-support";
import { addMember, clearGuestRows, grant, guestFetch, HYGIENE, linkPath, openGuestGate, seedGuestLink, startSession, type LinkInput } from "./guest-support";
import { box, buildMp4, videoTrack } from "../../../packages/shared/src/testing/mp4-builder";
import { seedPage, wipeDelivery } from "./delivery-support";
import { clearVideoFlags, markVersionRemoved, seedVideoVersion, setVideoFlags } from "./video-review-support";
import { NATIVE_ZIP_FLAG, ZIP_LEGACY_MAX_BYTES } from "../src/lib/object-crc";
import { crc32 } from "node:zlib";

/**
 * Guest downloads (#741 14b): one Version, the manifest and Download all. Rules: docs/plans/741-13-15.md section 4 and settled decision 8. A download is a READ, but every gate runs before
 * any R2 read, so GET, HEAD and Range are refused alike; an archived Project still downloads.
 */
type Json = Record<string, any>;
const MAX_ENTRIES = 20; const MAX_BYTES = 8 * 1024 ** 3;
const downloadPath = (linkId: string, assetId: string) => linkPath(linkId, `/versions/${assetId}/download`);
const manifestPath = (linkId: string) => linkPath(linkId, "/downloads");
const zipPath = (linkId: string) => linkPath(linkId, "/downloads/all.zip");

beforeAll(async () => { await seedFixture(); });
const wipe = async () => {
  await database.DB.batch([
    database.DB.prepare("DELETE FROM video_releases"), database.DB.prepare("DELETE FROM video_approval_events"), database.DB.prepare("DELETE FROM video_premium_unlocks"),
    database.DB.prepare("DELETE FROM audit_log WHERE action LIKE 'review_link.download%'"),
    database.DB.prepare("DELETE FROM guest_reviewers WHERE email_normalized LIKE '%@guest-14b.test'"),
    database.DB.prepare("DELETE FROM video_notes"), database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets WHERE kind = 'video'"), database.DB.prepare("DELETE FROM videos"),
    database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(ids.project),
  ]);
};
beforeEach(async () => { await clearGuestRows(); await wipe(); await openGuestGate(); });
afterEach(async () => { await clearGuestRows(); await wipe(); await clearVideoFlags(); });

async function verifyCookie(cookie: string, name = "Gina Guest"): Promise<string> {
  const guestId = crypto.randomUUID();
  await database.DB.prepare("INSERT INTO guest_reviewers (id, email_normalized, display_name, created_at) VALUES (?, ?, ?, ?)").bind(guestId, `${guestId}@guest-14b.test`, name, Date.now()).run();
  await database.DB.prepare("UPDATE guest_sessions SET guest_id = ?, verified_at = ? WHERE token_hash = ?").bind(guestId, Date.now(), await hashToken(cookie.split("=")[1]!)).run();
  return guestId;
}
async function verifiedLink(input: LinkInput = {}) {
  const link = await seedGuestLink(input); const { cookie } = await startSession(link);
  if (!cookie) throw new Error("no session");
  return { ...link, cookie, guestId: await verifyCookie(cookie) };
}
/** A staff approval and a live Release of one Version, straight in the database (14a has its own suite). */
async function release(version: { videoId: string; assetId: string }) {
  const eventId = crypto.randomUUID(); const releaseId = crypto.randomUUID(); const now = Date.now();
  const revision = ((await database.DB.prepare("SELECT MAX(revision) AS r FROM video_approval_events WHERE asset_id = ?").bind(version.assetId).first<{ r: number | null }>())!.r ?? 0) + 1;
  await database.DB.prepare("INSERT INTO video_approval_events (id, project_id, video_id, asset_id, link_id, revision, decision, note, actor_guest_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, NULL, ?, 'approved', NULL, NULL, ?, ?)")
    .bind(eventId, ids.project, version.videoId, version.assetId, revision, ids.admin, now).run();
  await database.DB.prepare("INSERT INTO video_releases (id, project_id, video_id, asset_id, approval_event_id, approval_revision, released_by, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(releaseId, ids.project, version.videoId, version.assetId, eventId, revision, ids.admin, now).run();
  return releaseId;
}
const withdraw = (assetId: string) => database.DB.prepare("UPDATE video_releases SET withdrawn_at = ?, withdrawn_by = ? WHERE asset_id = ? AND withdrawn_at IS NULL").bind(Date.now(), ids.admin, assetId).run();
const setPremium = (videoId: string, premium: boolean) => database.DB.prepare("UPDATE videos SET premium = ? WHERE id = ?").bind(premium ? 1 : 0, videoId).run();
const unlock = (videoId: string) => database.DB.prepare("INSERT INTO video_premium_unlocks (video_id, project_id, unlocked_by, unlocked_at, payment_ref) VALUES (?, ?, ?, ?, NULL)").bind(videoId, ids.project, ids.admin, Date.now()).run();
const setBytes = (assetId: string, bytes: number) => database.DB.prepare("UPDATE assets SET bytes = ? WHERE id = ?").bind(bytes, assetId).run();
const audits = async (action = "review_link.download") => (await database.DB.prepare("SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE action = ? ORDER BY created_at, id").bind(action).all<Json>()).results;
const allAudits = async () => (await database.DB.prepare("SELECT action FROM audit_log WHERE action LIKE 'review_link.download%'").all<Json>()).results;
const archive = () => database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), ids.project).run();

/** A verified link with one released Video on it. */
async function setup(input: LinkInput = {}, title = "Hero") {
  const link = await verifiedLink(input); const version = await seedVideoVersion({ title });
  await addMember(link.id, version.videoId, [version.assetId]); await release(version);
  return { link, version };
}
/** Another Video on the link with one granted Version, released or not. */
async function another(linkId: string, title: string, options: { released?: boolean; bytes?: number } = {}) {
  const version = await seedVideoVersion({ title }); await addMember(linkId, version.videoId, [version.assetId]);
  if (options.released !== false) await release(version);
  if (options.bytes !== undefined) await setBytes(version.assetId, options.bytes);
  return version;
}
const get = (link: { id: string }, cookie: string | null, assetId: string, headers: Record<string, string> = {}, method = "GET") => guestFetch(downloadPath(link.id, assetId), { method, cookie, headers });

const quickTimeBytes = async () => { const source = buildMp4({ tracks: [videoTrack({ timescale: 25000, stts: [[300, 1000]] })], ftyp: "qt  ", leading: [box("wide")] }); return new Uint8Array(await source.read(0, source.size)); };
const probe = async (response: Response) => ({ status: response.status, body: await response.text() });
const stubBody = async () => probe(await guestFetch("/d"));
const dispose = (response: Response) => response.body?.cancel().catch(() => undefined);

/** The files of a small, non-ZIP64 archive: name to bytes, read from its central directory. */
function readZip(archive: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let eocd = archive.length - 22; while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error("no end of central directory");
  const count = view.getUint16(eocd + 10, true); let at = view.getUint32(eocd + 16, true); const files = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("bad central header");
    const size = view.getUint32(at + 24, true); const nameLength = view.getUint16(at + 28, true); const extraLength = view.getUint16(at + 30, true); const commentLength = view.getUint16(at + 32, true); const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(archive.subarray(at + 46, at + 46 + nameLength));
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    files.set(name, archive.slice(start, start + size)); at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
const unzip = async (response: Response) => readZip(new Uint8Array(await response.arrayBuffer()));

describe("GET and HEAD .../versions/:assetId/download", () => {
  it("serves a released Version: 200 with an attachment disposition, hygiene headers, the object bytes and one audit row", async () => {
    const { link, version } = await setup({}, "Hero reel");
    const response = await get(link, link.cookie, version.assetId);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; /);
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''Hero%20reel%20v1.mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(mp4Bytes(4096));
    const [entry, ...rest] = await audits(); expect(rest).toEqual([]);
    expect(entry).toMatchObject({ actor_id: null, target_type: "review_link", target_id: link.id });
    expect(JSON.parse(entry!.meta_json)).toMatchObject({ guest: { guestId: link.guestId }, linkId: link.id, assetId: version.assetId, videoId: version.videoId, version: 1, bytes: 4096 });
  });

  it("downloads a QuickTime-container upload as an .mp4, bytes unchanged (#813)", async () => {
    const { link, version } = await setup({}, "Interview"); const file = await quickTimeBytes();
    await database.MEDIA.put(version.key, file, { httpMetadata: { contentType: "video/mp4" } }); await setBytes(version.assetId, file.byteLength);
    const response = await get(link, link.cookie, version.assetId);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''Interview%20v1.mp4");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(file);
  });

  it("answers a Range with 206, keeps the disposition and writes no audit row; `bytes=0-` counts as a download", async () => {
    const { link, version } = await setup();
    const ranged = await get(link, link.cookie, version.assetId, { range: "bytes=10-19" });
    expect(ranged.status).toBe(206); expect(ranged.headers.get("content-range")).toBe("bytes 10-19/4096"); expect(ranged.headers.get("content-disposition")).toMatch(/^attachment; /);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(mp4Bytes(4096).slice(10, 20));
    expect(await audits()).toHaveLength(0);
    const open = await get(link, link.cookie, version.assetId, { range: "bytes=0-" }); await dispose(open);
    expect(await audits()).toHaveLength(1);
    const resume = await get(link, link.cookie, version.assetId, { range: "bytes=2048-" }); await dispose(resume);
    expect(await audits()).toHaveLength(1);
  });

  it("answers HEAD from the headers alone and writes no audit row", async () => {
    const { link, version } = await setup();
    const response = await get(link, link.cookie, version.assetId, {}, "HEAD");
    expect(response.status).toBe(200); expect(response.headers.get("content-length")).toBe("4096"); expect(response.headers.get("content-disposition")).toMatch(/^attachment; /);
    expect(await response.text()).toBe(""); expect(await audits()).toHaveLength(0);
  });

  it("still downloads from an archived Project (a read)", async () => {
    const { link, version } = await setup(); await archive();
    const response = await get(link, link.cookie, version.assetId);
    expect(response.status).toBe(200); await dispose(response);
    expect(await audits()).toHaveLength(1);
  });

  const requests: Array<[string, Record<string, string>, string]> = [["GET", {}, "GET"], ["HEAD", {}, "HEAD"], ["GET", { range: "bytes=0-9" }, "Range"]];
  for (const [method, headers, label] of requests) {
    describe(`refused alike on ${label}`, () => {
      const call = (link: { id: string; cookie: string | null }, assetId: string) => get(link, link.cookie, assetId, headers, method);
      it("409 not_released while unreleased and after a Release is withdrawn", async () => {
        const link = await verifiedLink(); const version = await seedVideoVersion(); await addMember(link.id, version.videoId, [version.assetId]);
        let response = await call(link, version.assetId); expect(response.status).toBe(409); if (method !== "HEAD") expect(await response.json()).toEqual({ error: "not_released" });
        await release(version); response = await call(link, version.assetId); expect(response.status).toBe(label === "Range" ? 206 : 200); await dispose(response);
        await withdraw(version.assetId); response = await call(link, version.assetId); expect(response.status).toBe(409);
      });
      it("403 premium_locked while locked, served once unlocked", async () => {
        const { link, version } = await setup(); await setPremium(version.videoId, true);
        const locked = await call(link, version.assetId); expect(locked.status).toBe(403); if (method !== "HEAD") expect(await locked.json()).toEqual({ error: "premium_locked" });
        await unlock(version.videoId); const open = await call(link, version.assetId); expect(open.status).toBe(label === "Range" ? 206 : 200); await dispose(open);
      });
      it("403 download_disabled when the link flag is off", async () => {
        const { link, version } = await setup({ allow: [1, 1, 0] });
        const response = await call(link, version.assetId); expect(response.status).toBe(403); if (method !== "HEAD") expect(await response.json()).toEqual({ error: "download_disabled" });
      });
      it("401 verification_required for a session that has not verified an email", async () => {
        const link = await seedGuestLink(); const { cookie } = await startSession(link); const version = await seedVideoVersion();
        await addMember(link.id, version.videoId, [version.assetId]); await release(version);
        const response = await call({ id: link.id, cookie }, version.assetId); expect(response.status).toBe(401); if (method !== "HEAD") expect(await response.json()).toEqual({ error: "verification_required" });
      });
      it("is the byte-identical stub when access is lost or was never there", async () => {
        const stub = await stubBody();
        const { link, version } = await setup(); const other = await another(link.id, "Other");
        const ungranted = await seedVideoVersion(); await release(ungranted);
        const results: Array<[string, Response]> = [];
        results.push(["no cookie", await get(link, null, version.assetId, headers, method)]);
        results.push(["not a uuid", await call(link, "not-a-uuid")]);
        results.push(["unknown version", await call(link, crypto.randomUUID())]);
        results.push(["not granted to this link", await call(link, ungranted.assetId)]);
        await database.DB.prepare("UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE video_id = ?").bind(Date.now(), ids.member, other.videoId).run();
        results.push(["video removed", await call(link, other.assetId)]);
        await database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE asset_id = ?").bind(Date.now(), ids.member, version.assetId).run();
        results.push(["grant revoked", await call(link, version.assetId)]);
        for (const [name, response] of results) { expect(response.status, name).toBe(404); if (method !== "HEAD") expect(await response.text(), name).toBe(stub.body); }
        expect(await allAudits()).toHaveLength(0);
      });
      it("is the stub when the link is revoked, replaced or expired, or the delivery part is off", async () => {
        for (const mutate of [
          (id: string) => database.DB.prepare("UPDATE client_links SET revoked_at = ?, revoked_by = ? WHERE id = ?").bind(Date.now(), ids.member, id).run(),
          (id: string) => database.DB.prepare("UPDATE client_links SET token_generation = token_generation + 1 WHERE id = ?").bind(id).run(),
          (id: string) => database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, id).run(),
          () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_delivery'").run(),
        ]) {
          await clearGuestRows(); await wipe(); await openGuestGate();
          const { link, version } = await setup(); await mutate(link.id);
          const response = await call(link, version.assetId); expect(response.status).toBe(404);
        }
        expect(await allAudits()).toHaveLength(0);
      });
    });
  }

  it("is the stub for a staff cookie alone", async () => {
    const { link, version } = await setup();
    const response = await guestFetch(downloadPath(link.id, version.assetId), { headers: { cookie: "better-auth.session_token=staff" } });
    expect(response.status).toBe(404);
  });

  it("answers the stub when the object is missing after the gates", async () => {
    const link = await verifiedLink(); const version = await seedVideoVersion({ object: false }); await addMember(link.id, version.videoId, [version.assetId]); await release(version);
    expect((await get(link, link.cookie, version.assetId)).status).toBe(404);
  });

  it("builds a safe filename from a hostile title", async () => {
    const { link, version } = await setup({}, '../..\\"évil"; title.mp4');
    const response = await get(link, link.cookie, version.assetId); await dispose(response);
    const disposition = response.headers.get("content-disposition")!;
    expect(disposition).not.toMatch(/[/\\]/); expect(disposition.split("filename*=")[1]).not.toContain('"'); expect(disposition).toContain("%C3%A9");
  });
});

describe("GET .../downloads (the manifest)", () => {
  it("lists the newest released granted Version of each Video, and what is left out and why", async () => {
    const { link, version } = await setup({}, "Hero");
    const v2 = await seedVideoVersion({ videoId: version.videoId, version: 2 }); await grant(link.id, version.videoId, v2.assetId); // newer, granted, not released
    const locked = await another(link.id, "Locked"); await setPremium(locked.videoId, true);
    await another(link.id, "Waiting", { released: false });
    const unlocked = await another(link.id, "Paid", {}); await setPremium(unlocked.videoId, true); await unlock(unlocked.videoId);
    const ungranted = await seedVideoVersion({ videoId: version.videoId, version: 3 }); await release(ungranted); // released but not granted to this link
    const response = await guestFetch(manifestPath(link.id), { cookie: link.cookie });
    expect(response.status, await response.clone().text()).toBe(200);
    for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
    const body = await response.json() as Json;
    const byTitle = (x: Json, y: Json) => x.title.localeCompare(y.title);
    expect([...body.included].sort(byTitle).map((entry: Json) => ({ title: entry.title, version: entry.version, bytes: entry.bytes, videoId: entry.videoId }))).toEqual([
      { title: "Hero", version: 1, bytes: 4096, videoId: version.videoId }, { title: "Paid", version: 1, bytes: 4096, videoId: unlocked.videoId },
    ]);
    expect([...body.leftOut].sort(byTitle)).toEqual([{ title: "Locked", reason: "premium_locked" }, { title: "Waiting", reason: "not_released" }]);
    expect(body.totalBytes).toBe(8192); expect(body.tooLarge).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/r2|assetId|link/i);
    expect(await allAudits()).toHaveLength(0);
  });

  it("drops a Video removed from the link and a withdrawn Release", async () => {
    const { link, version } = await setup(); const other = await another(link.id, "Other");
    await database.DB.prepare("UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE video_id = ?").bind(Date.now(), ids.member, other.videoId).run(); await withdraw(version.assetId);
    const body = await (await guestFetch(manifestPath(link.id), { cookie: link.cookie })).json() as Json;
    expect(body.included).toEqual([]); expect(body.leftOut.map((entry: Json) => entry.title)).toEqual(["Hero"]);
  });

  it("is 401 unverified, 403 with download off, and the stub when access is lost", async () => {
    const unverified = await seedGuestLink(); const { cookie } = await startSession(unverified);
    const response = await guestFetch(manifestPath(unverified.id), { cookie }); expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: "verification_required" });
    const off = await verifiedLink({ allow: [1, 1, 0] });
    const refused = await guestFetch(manifestPath(off.id), { cookie: off.cookie }); expect(refused.status).toBe(403); expect(await refused.json()).toEqual({ error: "download_disabled" });
    const { link } = await setup(); const stub = await stubBody();
    expect((await probe(await guestFetch(manifestPath(link.id), { cookie: null }))).body).toBe(stub.body);
    await database.DB.prepare("UPDATE client_links SET revoked_at = ?, revoked_by = ? WHERE id = ?").bind(Date.now(), ids.member, link.id).run();
    expect(await probe(await guestFetch(manifestPath(link.id), { cookie: link.cookie }))).toEqual(stub);
  });

  it("still answers on an archived Project", async () => {
    const { link } = await setup(); await archive();
    expect((await guestFetch(manifestPath(link.id), { cookie: link.cookie })).status).toBe(200);
  });
});

const zipCounts = async (link: { id: string; guestId: string }) => {
  const count = async (bucket: string) => (await database.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM guest_rate_limits WHERE bucket = ?").bind(bucket).first<Json>())!.n as number;
  return { guest: await count(`zip:guest:${link.guestId}`), link: await count(`zip:link:${link.id}`) };
};
describe("GET .../downloads/all.zip", () => {
  it("streams exactly the released, unlocked live members, with Left out.txt naming the rest, and audits once", async () => {
    const { link, version } = await setup({}, "Hero");
    const v2 = await seedVideoVersion({ videoId: version.videoId, version: 2 }); await grant(link.id, version.videoId, v2.assetId); await release(v2);
    const locked = await another(link.id, "Locked"); await setPremium(locked.videoId, true);
    await another(link.id, "Waiting", { released: false });
    const response = await guestFetch(zipPath(link.id), { cookie: link.cookie });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip"); expect(response.headers.get("content-disposition")).toMatch(/^attachment; /);
    for (const [name, value] of Object.entries(HYGIENE)) expect(response.headers.get(name), name).toBe(value);
    const files = await unzip(response);
    expect([...files.keys()].sort()).toEqual(["Hero v2.mp4", "Left out.txt"]);
    expect(files.get("Hero v2.mp4")).toEqual(mp4Bytes(4096));
    const leftOut = new TextDecoder().decode(files.get("Left out.txt")!); expect(leftOut).toContain("Locked"); expect(leftOut).toContain("Waiting");
    const [entry, ...rest] = await audits("review_link.download_all"); expect(rest).toEqual([]);
    expect(entry).toMatchObject({ actor_id: null, target_type: "review_link", target_id: link.id });
    const meta = JSON.parse(entry!.meta_json); expect(meta).toMatchObject({ guest: { guestId: link.guestId }, linkId: link.id, assetIds: [v2.assetId], totalBytes: 4096 });
    expect(meta.leftOut).toHaveLength(2); expect(JSON.stringify(meta)).not.toContain("Locked");
    expect(await audits("review_link.download")).toHaveLength(0);
  });

  it("has no Left out.txt when nothing is left out, and dedupes two Videos with one title", async () => {
    const { link } = await setup({}, "Same"); await another(link.id, "Same");
    const files = await unzip(await guestFetch(zipPath(link.id), { cookie: link.cookie }));
    expect([...files.keys()].sort()).toEqual(["Same v1 (2).mp4", "Same v1.mp4"]);
  });

  it("409 nothing_to_download when nothing is released, and writes no audit row", async () => {
    const link = await verifiedLink(); const version = await seedVideoVersion(); await addMember(link.id, version.videoId, [version.assetId]);
    const response = await guestFetch(zipPath(link.id), { cookie: link.cookie }); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "nothing_to_download" });
    expect(await allAudits()).toHaveLength(0);
  });

  it("puts a QuickTime-container upload in the ZIP as an .mp4 entry, bytes unchanged (#813)", async () => {
    const { link, version } = await setup({}, "Interview"); const file = await quickTimeBytes();
    await database.MEDIA.put(version.key, file, { httpMetadata: { contentType: "video/mp4" } }); await setBytes(version.assetId, file.byteLength);
    const files = await unzip(await guestFetch(zipPath(link.id), { cookie: link.cookie }));
    expect([...files.keys()].sort()).toEqual(["Interview v1.mp4"]);
    expect(files.get("Interview v1.mp4")).toEqual(file);
  });

  it("allows 20 entries and refuses 21 with 422 zip_too_large", async () => {
    const { link } = await setup({}, "V0");
    for (let index = 1; index < MAX_ENTRIES; index += 1) await another(link.id, `V${index}`);
    const ok = await guestFetch(zipPath(link.id), { cookie: link.cookie }); expect(ok.status).toBe(200); expect((await unzip(ok)).size).toBe(MAX_ENTRIES);
    await another(link.id, "V20");
    const refused = await guestFetch(zipPath(link.id), { cookie: link.cookie }); expect(refused.status).toBe(422); expect(await refused.json()).toMatchObject({ error: "zip_too_large" });
    expect(await audits("review_link.download_all")).toHaveLength(1);
  });

  it("allows 8 GB and refuses a byte more, before any R2 read", async () => {
    const { link, version } = await setup();
    await setBytes(version.assetId, MAX_BYTES + 1);
    const refused = await guestFetch(zipPath(link.id), { cookie: link.cookie }); expect(refused.status).toBe(422); expect(await refused.json()).toMatchObject({ error: "zip_too_large" });
    expect(await allAudits()).toHaveLength(0);
    // Exactly at the cap passes the cap check and fails later, on the size mismatch with the stored object (data inconsistency, not a cap).
    await setBytes(version.assetId, MAX_BYTES);
    const atCap = await guestFetch(zipPath(link.id), { cookie: link.cookie }); expect(atCap.status).not.toBe(422); await dispose(atCap);
  });

  it("fails before the first byte when an object is missing or its size differs, with no audit row", async () => {
    const { link, version } = await setup(); const other = await another(link.id, "Other");
    await database.MEDIA.delete(other.key);
    let response = await guestFetch(zipPath(link.id), { cookie: link.cookie }); expect(response.status).toBeGreaterThanOrEqual(500); await dispose(response);
    await database.MEDIA.put(other.key, mp4Bytes(4096)); await setBytes(version.assetId, 4095);
    response = await guestFetch(zipPath(link.id), { cookie: link.cookie }); expect(response.status).toBeGreaterThanOrEqual(500); await dispose(response);
    expect(await allAudits()).toHaveLength(0);
  });

  it("rate-limits zip starts: 10 per guest and 30 per link per 15 minutes, 429 with Retry-After", async () => {
    const { link } = await setup();
    for (let index = 0; index < 10; index += 1) { const ok = await guestFetch(zipPath(link.id), { cookie: link.cookie }); expect(ok.status, `start ${index + 1}`).toBe(200); await dispose(ok); }
    const limited = await guestFetch(zipPath(link.id), { cookie: link.cookie });
    expect(limited.status).toBe(429); expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0); expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(GUEST_WINDOW_MS / 1000);
    expect(await limited.json()).toMatchObject({ error: "too_many_attempts" });
    expect(await audits("review_link.download_all")).toHaveLength(10);
    // The refused start spends nothing: both buckets are taken together or not at all (#824).
    expect(await zipCounts(link)).toEqual({ guest: 10, link: 10 });
  });

  describe("the guest and link buckets are taken together or not at all (#824)", () => {
    // The fixtures and the handler read the same frozen clock, one second before a window boundary, so no run can straddle two windows.
    const PINNED = (Math.floor(Date.now() / GUEST_WINDOW_MS) + 1) * GUEST_WINDOW_MS - 1000;
    const START = Math.floor(PINNED / GUEST_WINDOW_MS) * GUEST_WINDOW_MS;
    beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(PINNED); });
    afterEach(() => { vi.useRealTimers(); });
    const put = (bucket: string, count: number) => database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?, ?, ?)").bind(bucket, START, count).run();
    it("a start refused by the guest bucket leaves the link bucket untouched", async () => {
      const { link } = await setup(); await put(`zip:guest:${link.guestId}`, 10); await put(`zip:link:${link.id}`, 5);
      const limited = await guestFetch(zipPath(link.id), { cookie: link.cookie });
      expect(limited.status).toBe(429); await dispose(limited);
      expect(await zipCounts(link)).toEqual({ guest: 10, link: 5 });
    });
    it("a start refused by the link bucket leaves the guest bucket untouched", async () => {
      const { link } = await setup(); await put(`zip:guest:${link.guestId}`, 3); await put(`zip:link:${link.id}`, 30);
      const limited = await guestFetch(zipPath(link.id), { cookie: link.cookie });
      expect(limited.status).toBe(429); await dispose(limited);
      expect(await zipCounts(link)).toEqual({ guest: 3, link: 30 });
    });
    it("a refusal by the link bucket does not spend a slot of a guest with no row yet", async () => {
      const { link } = await setup(); await put(`zip:link:${link.id}`, 30);
      await dispose(await guestFetch(zipPath(link.id), { cookie: link.cookie }));
      expect(await zipCounts(link)).toEqual({ guest: 0, link: 30 });
    });
    it("two guests racing for the last slot of a link: exactly one is admitted", async () => {
      const { link } = await setup(); await put(`zip:link:${link.id}`, 29);
      const { cookie } = await startSession(link); if (!cookie) throw new Error("no session"); await verifyCookie(cookie, "Second Guest");
      const responses = await Promise.all([guestFetch(zipPath(link.id), { cookie: link.cookie }), guestFetch(zipPath(link.id), { cookie })]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
      for (const response of responses) await dispose(response);
      expect((await database.DB.prepare("SELECT count FROM guest_rate_limits WHERE bucket = ?").bind(`zip:link:${link.id}`).first<Json>())!.count).toBe(30);
      expect((await database.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM guest_rate_limits WHERE bucket LIKE 'zip:guest:%'").first<Json>())!.n).toBe(1);
      expect(await audits("review_link.download_all")).toHaveLength(1);
    });
    it("a start that fails after the reservation gives back exactly one slot in each bucket", async () => {
      const { link } = await setup(); await put(`zip:guest:${link.guestId}`, 3); await put(`zip:link:${link.id}`, 5);
      const { call } = interposed({ before: [[/INSERT INTO audit_log/, () => database.DB.prepare("UPDATE client_links SET allow_download = 0 WHERE id = ?").bind(link.id).run()]] });
      const response = await call(zipPath(link.id), link.cookie, "GET"); await dispose(response);
      expect(response.status).not.toBe(200); expect(response.status).not.toBe(429);
      expect(await audits("review_link.download_all")).toHaveLength(0);
      expect(await zipCounts(link)).toEqual({ guest: 3, link: 5 });
    });
    it("a failed start with no earlier usage leaves no bucket rows behind", async () => {
      const { link } = await setup();
      const { call } = interposed({ before: [[/INSERT INTO audit_log/, () => database.DB.prepare("UPDATE client_links SET allow_download = 0 WHERE id = ?").bind(link.id).run()]] });
      await dispose(await call(zipPath(link.id), link.cookie, "GET"));
      expect(await zipCounts(link)).toEqual({ guest: 0, link: 0 });
    });
  });

  it("limits a link to 30 starts across its guests", async () => {
    const { link } = await setup(); const now = Date.now(); const start = Math.floor(now / GUEST_WINDOW_MS) * GUEST_WINDOW_MS;
    await database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?, ?, 30)").bind(`zip:link:${link.id}`, start).run();
    const limited = await guestFetch(zipPath(link.id), { cookie: link.cookie }); expect(limited.status).toBe(429);
  });

  it("applies no limit to single downloads or Range reads", async () => {
    const { link, version } = await setup();
    for (let index = 0; index < 40; index += 1) { const response = await get(link, link.cookie, version.assetId, { range: `bytes=${index}-${index + 1}` }); expect(response.status).toBe(206); await dispose(response); }
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_rate_limits WHERE bucket LIKE 'zip:%'").first<Json>())!.n).toBe(0);
  });

  it("charges the zip bucket only for a start about to be audited, so a 409 costs nothing (#802)", async () => {
    const link = await verifiedLink(); const version = await seedVideoVersion(); await addMember(link.id, version.videoId, [version.assetId]);
    const response = await guestFetch(zipPath(link.id), { cookie: link.cookie }); expect(response.status).toBe(409);
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_rate_limits WHERE bucket LIKE 'zip:%'").first<Json>())!.n).toBe(0);
  });

  it("refuses HEAD without charging the limit, auditing or reading R2", async () => {
    const { link } = await setup();
    const response = await guestFetch(zipPath(link.id), { cookie: link.cookie, method: "HEAD" });
    expect(response.status).toBe(405);
    expect(await allAudits()).toHaveLength(0);
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_rate_limits WHERE bucket LIKE 'zip:%'").first<Json>())!.n).toBe(0);
  });

  it("is 401 unverified, 403 with download off, and the stub when access is lost or the part is off", async () => {
    const unverified = await seedGuestLink(); const { cookie } = await startSession(unverified);
    expect((await guestFetch(zipPath(unverified.id), { cookie })).status).toBe(401);
    const off = await verifiedLink({ allow: [1, 1, 0] }); expect((await guestFetch(zipPath(off.id), { cookie: off.cookie })).status).toBe(403);
    const { link } = await setup(); const stub = await stubBody();
    expect(await probe(await guestFetch(zipPath(link.id), { cookie: null }))).toEqual(stub);
    await database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_delivery'").run();
    expect(await probe(await guestFetch(zipPath(link.id), { cookie: link.cookie }))).toEqual(stub);
    expect(await allAudits()).toHaveLength(0);
  });

  it("still downloads from an archived Project", async () => {
    const { link } = await setup(); await archive();
    const response = await guestFetch(zipPath(link.id), { cookie: link.cookie }); expect(response.status).toBe(200); expect((await unzip(response)).size).toBe(1);
  });

  describe("re-authorises before each entry and aborts when access is lost", () => {
    /** Two Videos, the first large enough that the zip cannot have run ahead to the second entry's check when the first chunks arrive. */
    async function twoEntries() {
      const { link, version } = await setup({}, "Big"); const second = await another(link.id, "Small");
      const big = new Uint8Array(6 * 1024 * 1024); big.set(mp4Bytes(4096)); await database.MEDIA.put(version.key, big); await setBytes(version.assetId, big.length);
      return { link, version, second };
    }
    async function readUntilFirstChunk(response: Response) {
      const reader = response.body!.getReader(); const first = await reader.read(); expect(first.done).toBe(false); return reader;
    }
    async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<"complete" | "aborted"> {
      try { for (;;) { const { done } = await reader.read(); if (done) return "complete"; } } catch { return "aborted"; }
    }
    it("completes when nothing changes", async () => {
      const { link } = await twoEntries();
      const response = await guestFetch(zipPath(link.id), { cookie: link.cookie }); expect(response.status).toBe(200);
      expect(await drain(await readUntilFirstChunk(response))).toBe("complete");
    });
    for (const [name, change] of [
      ["a Release withdrawn", (context: { second: { assetId: string } }) => withdraw(context.second.assetId)],
      ["a Video relocked", (context: { second: { videoId: string } }) => setPremium(context.second.videoId, true)],
      ["the Video removed from the link", (context: { second: { videoId: string } }) => database.DB.prepare("UPDATE review_link_videos SET removed_at = ?, removed_by = ? WHERE video_id = ?").bind(Date.now(), ids.member, context.second.videoId).run()],
      ["the link revoked", (context: { link: { id: string } }) => database.DB.prepare("UPDATE client_links SET revoked_at = ?, revoked_by = ? WHERE id = ?").bind(Date.now(), ids.member, context.link.id).run()],
      ["downloads turned off on the link", (context: { link: { id: string } }) => database.DB.prepare("UPDATE client_links SET allow_download = 0 WHERE id = ?").bind(context.link.id).run()],
      ["the delivery part turned off", () => database.DB.prepare("DELETE FROM feature_flags WHERE key = 'video_review_delivery'").run()],
    ] as const) {
      it(`aborts the stream after ${name} between entries`, async () => {
        const context = await twoEntries();
        const response = await guestFetch(zipPath(context.link.id), { cookie: context.link.cookie }); expect(response.status).toBe(200);
        const reader = await readUntilFirstChunk(response);
        await (change as (c: typeof context) => Promise<unknown>)(context);
        expect(await drain(reader)).toBe("aborted");
      });
    }
  });
});

describe("guestVersionDto.downloadUrl", () => {
  const listed = async (link: { id: string; cookie: string }) => guestVideoListResponseSchema.parse(await (await guestFetch(linkPath(link.id, "/videos"), { cookie: link.cookie })).json());
  it("is the download route when released, allowed and not locked", async () => {
    const { link, version } = await setup();
    expect((await listed(link)).videos[0]!.versions[0]!.downloadUrl).toBe(`/d/api/links/${link.id}/versions/${version.assetId}/download`);
  });
  it("is null when unreleased, withdrawn, download is off, the delivery part is off, or the Video is locked", async () => {
    const link = await verifiedLink(); const version = await seedVideoVersion(); await addMember(link.id, version.videoId, [version.assetId]);
    const url = async () => (await listed(link)).videos[0]!.versions[0]!.downloadUrl;
    expect(await url()).toBeNull();
    await release(version); expect(await url()).not.toBeNull();
    await withdraw(version.assetId); expect(await url()).toBeNull();
    await release(version); await setPremium(version.videoId, true); expect(await url()).toBeNull();
    await unlock(version.videoId); expect(await url()).not.toBeNull();
    await database.DB.prepare("UPDATE client_links SET allow_download = 0 WHERE id = ?").bind(link.id).run(); expect(await url()).toBeNull();
    await database.DB.prepare("UPDATE client_links SET allow_download = 1 WHERE id = ?").bind(link.id).run(); expect(await url()).not.toBeNull();
    await setVideoFlags(["video_review_delivery", false]); expect(await url()).toBeNull();
  });
  it("only the released Version of a Video carries a URL", async () => {
    const { link, version } = await setup(); const v2 = await seedVideoVersion({ videoId: version.videoId, version: 2 }); await grant(link.id, version.videoId, v2.assetId);
    const versions = (await listed(link)).videos[0]!.versions;
    expect(versions.map((entry) => [entry.version, entry.downloadUrl !== null])).toEqual([[2, false], [1, true]]);
  });
});

describe("safeFileName and attachment with astral characters", () => {
  it("cuts by code point, never splitting a surrogate pair, so the header always encodes", () => {
    const name = safeFileName(`${"a".repeat(119)}😀tail`);
    expect([...name]).toHaveLength(120);
    expect(name.endsWith("😀")).toBe(true);
    expect(() => attachment(`${name} v1.mp4`)).not.toThrow();
  });

  it("replaces a lone surrogate in a stored title instead of throwing", () => {
    expect(() => attachment(`${safeFileName("bad \ud800 title")} v1.mp4`)).not.toThrow();
    expect(safeFileName("bad \ud800 title")).toBe("bad � title");
  });
});

/**
 * Interposed storage: the real database and bucket, with a hook that runs `before` or `after` a statement whose SQL matches, so a revoke can land BETWEEN two steps of one request (the
 * Worker under test is mounted in-process, because nothing across the SELF boundary can be paused). `reads` counts every R2 read.
 */
function interposed(hooks: { before?: Array<[RegExp, () => Promise<unknown>]>; after?: Array<[RegExp, () => Promise<unknown>]> }, extra: { heads?: Record<string, { etag: string; size: number }>; queue?: unknown } = {}) {
  const unwrap = new WeakMap<object, D1PreparedStatement>(); const fired = new Set<RegExp>(); const reads: string[] = [];
  const fire = async (list: Array<[RegExp, () => Promise<unknown>]> | undefined, sql: string) => { for (const [pattern, action] of list ?? []) if (!fired.has(pattern) && pattern.test(sql)) { fired.add(pattern); await action(); } };
  const wrap = (sql: string, statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(statement, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrap(sql, target.bind(...args));
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") return async (...args: unknown[]) => { await fire(hooks.before, sql); const result = await (target as any)[prop](...args); await fire(hooks.after, sql); return result; };
        return (target as any)[prop];
      },
    });
    unwrap.set(proxy, statement); return proxy;
  };
  const DB = new Proxy(database.DB, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(sql, target.prepare(sql));
      if (prop === "batch") return (statements: D1PreparedStatement[]) => target.batch(statements.map((statement) => unwrap.get(statement) ?? statement));
      return (target as any)[prop]?.bind(target);
    },
  });
  const MEDIA = new Proxy(database.MEDIA, { get(target, prop) { return (...args: unknown[]) => {
    if (prop === "get" || prop === "head") reads.push(String(prop));
    if (prop === "head" && extra.heads && String(args[0]) in extra.heads) return Promise.resolve(extra.heads[String(args[0])]);
    return (target as any)[prop](...args);
  }; } });
  const app = new Hono<AppEnv>(); mountGuestDownloads(app);
  const call = (path: string, cookie: string, method: string, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`https://portal.test${path}`, { method, headers: { cookie, ...headers } }), { ...baseEnv, DB, MEDIA, ...(extra.queue ? { OBJECT_CRC_QUEUE: extra.queue } : {}) } as never, { waitUntil() {}, passThroughOnException() {} } as never);
  return { call, reads };
}
const resolveSessionRead = /LEFT JOIN guest_reviewers g ON g\.id = s\.guest_id/;
const versionRead = /FROM video_version_meta m JOIN assets a/;

describe("the resolved session's gate and a revoke between the gates and the R2 read (Sol round 2)", () => {
  for (const [method, headers, label] of requests2()) {
    it(`${label}: delivery turned off between the link load and the session resolve is the stub, and no bytes are read`, async () => {
      const { link, version } = await setup(); const stub = await stubBody();
      const { call, reads } = interposed({ before: [[resolveSessionRead, () => setVideoFlags(["video_review_delivery", false])]] });
      const response = await call(downloadPath(link.id, version.assetId), link.cookie, method, headers);
      expect(response.status).toBe(404); if (method !== "HEAD") expect(await response.text()).toBe(stub.body);
      expect(reads).toEqual([]); expect(await allAudits()).toHaveLength(0);
    });
    if (label !== "GET") it(`${label}: a revoke that lands between the gates and the read is the stub, and R2 is never read`, async () => {
      const { link, version } = await setup();
      const { call, reads } = interposed({ after: [[versionRead, () => revokeGrant(version.assetId)]] });
      const response = await call(downloadPath(link.id, version.assetId), link.cookie, method, headers);
      expect(response.status).toBe(404); expect(reads).toEqual([]);
    });
  }
  it("GET (whole file): the same revoke lands before the audit row, so nothing is read or audited", async () => {
    const { link, version } = await setup();
    const { call, reads } = interposed({ after: [[versionRead, () => revokeGrant(version.assetId)]] });
    const response = await call(downloadPath(link.id, version.assetId), link.cookie, "GET");
    expect(response.status).toBeGreaterThanOrEqual(404); expect(reads).toEqual([]); expect(await allAudits()).toHaveLength(0);
  });
  it("a served HEAD and Range still pass the final check when nothing changes", async () => {
    const { link, version } = await setup(); const { call, reads } = interposed({});
    expect((await call(downloadPath(link.id, version.assetId), link.cookie, "HEAD")).status).toBe(200);
    const ranged = await call(downloadPath(link.id, version.assetId), link.cookie, "GET", { range: "bytes=100-" }); expect(ranged.status).toBe(206); await dispose(ranged);
    expect(reads.length).toBeGreaterThan(0);
  });
});
const revokeGrant = (assetId: string) => database.DB.prepare("UPDATE review_link_version_grants SET revoked_at = ?, revoked_by = ? WHERE asset_id = ?").bind(Date.now(), ids.member, assetId).run();
function requests2(): Array<[string, Record<string, string>, string]> { return [["GET", {}, "GET"], ["HEAD", {}, "HEAD"], ["GET", { range: "bytes=100-" }, "Range"]]; }

describe("a long CJK title stays inside the 255-byte filename limit", () => {
  it("cuts a 120-character CJK title by UTF-8 bytes, leaving room for the version, extension and dedupe suffix", async () => {
    const title = "漢".repeat(120);
    const { link } = await setup({}, title); await another(link.id, title);
    const names = [...(await unzip(await guestFetch(zipPath(link.id), { cookie: link.cookie }))).keys()].sort();
    expect(names).toHaveLength(2); expect(names.some((name) => / v1\.mp4$/.test(name))).toBe(true); expect(names.some((name) => / v1 \(2\)\.mp4$/.test(name))).toBe(true);
    for (const name of names) { expect(new TextEncoder().encode(name).length, name).toBeLessThanOrEqual(255); expect(name).not.toContain("\uFFFD"); }
    expect(safeFileName(title)).toMatch(/^漢+$/);
  });
});

describe("zipEntries", () => {
  it("re-authorises after the R2 fetch: a Version removed during MEDIA.get is cancelled, never yielded, and the archive errors", async () => {
    const { link, version } = await setup({}, "Hero");
    const { zipEntries } = await import("../src/guest/download");
    const row = (await database.DB.prepare("SELECT id FROM guest_sessions WHERE token_hash = ?").bind(await hashToken(link.cookie.split("=")[1]!)).first<{ id: string }>())!;
    const session = { id: row.id, tokenHash: await hashToken(link.cookie.split("=")[1]!), guestId: link.guestId } as never;
    let cancelled = false;
    const media = { get: async (key: string) => {
      await markVersionRemoved(version.assetId);
      const object = (await database.MEDIA.get(key))!;
      const [kept, spare] = object.body.tee(); void spare.cancel();
      return { size: object.size, body: Object.assign(kept, { cancel: async () => { cancelled = true; await kept.cancel(); } }) };
    } };
    const entries = zipEntries({ DB: database.DB, MEDIA: media } as never, session, [{ videoId: version.videoId, title: "Hero", assetId: version.assetId, version: 1, bytes: 4096, r2Key: version.key }], null);
    await expect(entries.next()).rejects.toThrow("download access lost");
    expect(cancelled).toBe(true);
  });
});

describe("GET .../downloads/all.zip behind the native_zip flag (#802)", () => {
  const BIG = ZIP_LEGACY_MAX_BYTES + 1;
  const flag = (on: boolean) => database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled").bind(NATIVE_ZIP_FLAG, on ? 1 : 0, Date.now()).run();
  afterEach(async () => { await database.DB.batch([database.DB.prepare("DELETE FROM feature_flags WHERE key = ?").bind(NATIVE_ZIP_FLAG), database.DB.prepare("DELETE FROM object_crc32"), database.DB.prepare("DELETE FROM object_crc32_work")]); });
  const fakeQueue = () => { const sent: unknown[] = []; return { sent, sendBatch: async (messages: Array<{ body: unknown }>) => { for (const message of messages) sent.push(message.body); } }; };
  const quota = async () => (await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_rate_limits WHERE bucket LIKE 'zip:%'").first<Json>())!.n as number;
  /** Stores the CRC row for a real object, so the gate finds it ready. */
  async function ready(key: string, data = mp4Bytes(4096)) { const head = (await database.MEDIA.head(key))!; await database.DB.prepare("INSERT OR REPLACE INTO object_crc32 (r2_key, crc32, bytes, etag, computed_at) VALUES (?, ?, ?, ?, ?)").bind(key, crc32(data), data.length, head.etag, Date.now()).run(); }
  const keyOf = async (assetId: string) => (await database.DB.prepare("SELECT r2_key FROM assets WHERE id = ?").bind(assetId).first<{ r2_key: string }>())!.r2_key;
  /** A big asset whose HEAD reports the size D1 records, without storing 256 MiB. */
  async function big(linkId: string, title: string) { const version = await another(linkId, title, { bytes: BIG }); const key = await keyOf(version.assetId); return { version, key, heads: { [key]: { etag: "big-etag", size: BIG } } }; }
  const zip = (link: { id: string; cookie: string }, extra: Parameters<typeof interposed>[1] = {}) => interposed({}, extra).call(zipPath(link.id), link.cookie, "GET");

  it("flag missing and over 256 MiB: 413 download_too_large, no audit and no quota spent", async () => {
    const { link } = await setup(); const b = await big(link.id, "Big");
    const response = await zip(link, { heads: b.heads });
    expect(response.status).toBe(413); expect(await response.json()).toMatchObject({ error: "download_too_large" });
    expect(await allAudits()).toHaveLength(0); expect(await quota()).toBe(0);
  });

  it("flag off keeps the legacy writer for a small archive: 200, no Content-Length", async () => {
    await flag(false); const { link } = await setup();
    const response = await zip(link); expect(response.status).toBe(200); expect(response.headers.get("content-length")).toBeNull(); expect((await unzip(response)).size).toBe(1);
  });

  it("flag on, every CRC ready: the native writer, an exact Content-Length and a valid archive, audited once", async () => {
    await flag(true); const { link, version } = await setup(); await ready(await keyOf(version.assetId));
    const response = await zip(link); expect(response.status, await response.clone().text()).toBe(200);
    const archive = new Uint8Array(await response.arrayBuffer());
    expect(Number(response.headers.get("content-length"))).toBe(archive.length);
    expect(readZip(archive).get("Hero v1.mp4")).toEqual(mp4Bytes(4096));
    expect(await audits("review_link.download_all")).toHaveLength(1); expect(await quota()).toBe(2);
  });

  it("flag on, a CRC not ready but 256 MiB or less: the legacy writer, no queue send", async () => {
    await flag(true); const { link } = await setup(); const queue = fakeQueue();
    const response = await zip(link, { queue }); expect(response.status).toBe(200); expect(response.headers.get("content-length")).toBeNull();
    expect((await unzip(response)).size).toBe(1); expect(queue.sent).toEqual([]);
  });

  it("flag on, a stale etag over 256 MiB: 409 download_preparing, queued once, no audit and no quota spent", async () => {
    await flag(true); const { link, version } = await setup(); await ready(await keyOf(version.assetId)); const b = await big(link.id, "Big"); const queue = fakeQueue();
    await database.DB.prepare("INSERT INTO object_crc32 (r2_key, crc32, bytes, etag, computed_at) VALUES (?, 1, ?, 'old-etag', ?)").bind(b.key, BIG, Date.now()).run();
    const response = await zip(link, { heads: b.heads, queue });
    expect(response.status).toBe(409); expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toEqual({ error: "download_preparing", pending: 1, retryAfterSeconds: 30 });
    expect(queue.sent).toEqual([{ type: "object_crc32", r2Key: b.key }]);
    expect(await allAudits()).toHaveLength(0); expect(await quota()).toBe(0);
  });

  it("flag on, a CRC job that failed: 502 download_unavailable, never an endless 'preparing'", async () => {
    await flag(true); const { link } = await setup(); const b = await big(link.id, "Big");
    await database.DB.prepare("INSERT INTO object_crc32_work (r2_key, state, attempts, requested_at, updated_at) VALUES (?, 'failed', 3, ?, ?)").bind(b.key, Date.now(), Date.now()).run();
    const response = await zip(link, { heads: b.heads, queue: fakeQueue() });
    expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: "download_unavailable" });
    expect(await allAudits()).toHaveLength(0); expect(await quota()).toBe(0);
  });

  it("a missing object, or a size R2 disagrees with D1 about, is 502 with no audit and no quota spent (flag on or off)", async () => {
    for (const on of [false, true]) {
      await flag(on); const { link, version } = await setup(); const key = await keyOf(version.assetId);
      await database.MEDIA.delete(key); let response = await zip(link); expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: "download_unavailable" });
      await database.MEDIA.put(key, mp4Bytes(4096)); await setBytes(version.assetId, 4095);
      response = await zip(link); expect(response.status).toBe(502); await dispose(response);
      expect(await allAudits()).toHaveLength(0); expect(await quota()).toBe(0);
      await clearGuestRows(); await wipe();
    }
  });

  it("the rate limit is checked after the gate: a 429 is a ready, authorised start that is over quota", async () => {
    await flag(true); const { link, version } = await setup(); await ready(await keyOf(version.assetId));
    const now = Date.now(); const start = Math.floor(now / GUEST_WINDOW_MS) * GUEST_WINDOW_MS;
    await database.DB.prepare("INSERT INTO guest_rate_limits (bucket, window_start, count) VALUES (?, ?, 30)").bind(`zip:link:${link.id}`, start).run();
    const limited = await zip(link); expect(limited.status).toBe(429); expect(await allAudits()).toHaveLength(0);
  });
});

describe("the archive state in the manifest and POST .../downloads/prepare (#802)", () => {
  const BIG = ZIP_LEGACY_MAX_BYTES + 1;
  const flag = (on: boolean) => database.DB.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled").bind(NATIVE_ZIP_FLAG, on ? 1 : 0, Date.now()).run();
  afterEach(async () => { await database.DB.batch([database.DB.prepare("DELETE FROM feature_flags WHERE key = ?").bind(NATIVE_ZIP_FLAG), database.DB.prepare("DELETE FROM object_crc32"), database.DB.prepare("DELETE FROM object_crc32_work")]); });
  const fakeQueue = () => { const sent: unknown[] = []; return { sent, sendBatch: async (messages: Array<{ body: unknown }>) => { for (const message of messages) sent.push(message.body); } }; };
  const zipQuota = async () => (await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_rate_limits WHERE bucket LIKE 'zip:%'").first<Json>())!.n as number;
  const prepQuota = async () => (await database.DB.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM guest_rate_limits WHERE bucket LIKE 'zipprep:%'").first<Json>())!.n as number;
  const workRows = async () => (await database.DB.prepare("SELECT COUNT(*) AS n FROM object_crc32_work").first<Json>())!.n as number;
  const keyOf = async (assetId: string) => (await database.DB.prepare("SELECT r2_key FROM assets WHERE id = ?").bind(assetId).first<{ r2_key: string }>())!.r2_key;
  async function big(linkId: string, title: string) { const version = await another(linkId, title, { bytes: BIG }); const key = await keyOf(version.assetId); return { version, key, heads: { [key]: { etag: "big-etag", size: BIG } } }; }
  /** The first Video's CRC row, so only the big one is pending. */
  async function readyHero(assetId: string) { const key = await keyOf(assetId); const head = (await database.MEDIA.head(key))!; await database.DB.prepare("INSERT OR REPLACE INTO object_crc32 (r2_key, crc32, bytes, etag, computed_at) VALUES (?, ?, 4096, ?, ?)").bind(key, crc32(mp4Bytes(4096)), head.etag, Date.now()).run(); }
  const manifestOf = async (link: { id: string; cookie: string }, extra: Parameters<typeof interposed>[1] = {}) => { const response = await interposed({}, extra).call(manifestPath(link.id), link.cookie, "GET"); expect(response.status).toBe(200); return (await response.json() as Json).archive; };
  const prepare = (link: { id: string; cookie: string }, extra: Parameters<typeof interposed>[1] = {}, headers: Record<string, string> = { origin: baseEnv.APP_ORIGIN, "content-type": "application/json" }) =>
    interposed({}, extra).call(linkPath(link.id, "/downloads/prepare"), link.cookie, "POST", headers);

  it("the manifest reports ready for a small archive, flag on or off", async () => {
    const { link } = await setup();
    expect(await manifestOf(link)).toEqual({ state: "ready", pending: 0 });
    await flag(true); expect(await manifestOf(link)).toEqual({ state: "ready", pending: 0 });
  });

  it("the manifest reports too_large over 256 MiB with the flag off", async () => {
    const { link } = await setup(); const b = await big(link.id, "Big");
    expect(await manifestOf(link, { heads: b.heads })).toEqual({ state: "too_large", pending: 0 });
  });

  it("the manifest is read-only: it reports preparing and the pending count but queues nothing and writes no work row", async () => {
    await flag(true); const { link, version } = await setup(); await readyHero(version.assetId); const b = await big(link.id, "Big"); const queue = fakeQueue();
    expect(await manifestOf(link, { heads: b.heads, queue })).toEqual({ state: "preparing", pending: 1 });
    expect(queue.sent).toEqual([]); expect(await workRows()).toBe(0);
  });

  it("the manifest reports unavailable for a failed CRC job", async () => {
    await flag(true); const { link } = await setup(); const b = await big(link.id, "Big");
    await database.DB.prepare("INSERT INTO object_crc32_work (r2_key, state, attempts, requested_at, updated_at) VALUES (?, 'failed', 3, ?, ?)").bind(b.key, Date.now(), Date.now()).run();
    expect(await manifestOf(link, { heads: b.heads })).toEqual({ state: "unavailable", pending: 0 });
  });

  it("prepare queues each pending object once, answers preparing, and spends no zip start", async () => {
    await flag(true); const { link, version } = await setup(); await readyHero(version.assetId); const b = await big(link.id, "Big"); const queue = fakeQueue();
    const response = await prepare(link, { heads: b.heads, queue });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ state: "preparing", pending: 1, retryAfterSeconds: 30 });
    expect(queue.sent).toEqual([{ type: "object_crc32", r2Key: b.key }]);
    await prepare(link, { heads: b.heads, queue }); expect(queue.sent).toHaveLength(1);
    expect(await zipQuota()).toBe(0); expect(await prepQuota()).toBe(4); expect(await allAudits()).toHaveLength(0);
  });

  it("prepare answers ready for a small archive and too_large with the flag off", async () => {
    const { link } = await setup();
    expect(await (await prepare(link)).json()).toEqual({ state: "ready", pending: 0 });
    const b = await big(link.id, "Big"); expect(await (await prepare(link, { heads: b.heads })).json()).toEqual({ state: "too_large", pending: 0 });
  });

  it("prepare is a POST with the guest fence and the Origin check, like every guest write", async () => {
    await flag(true); const { link } = await setup();
    expect((await prepare(link, {}, { "content-type": "application/json" })).status).toBe(403);
    expect((await prepare(link, {}, { origin: "https://evil.test", "content-type": "application/json" })).status).toBe(403);
    expect((await interposed({}).call(linkPath(link.id, "/downloads/prepare"), "", "POST", { origin: baseEnv.APP_ORIGIN, "content-type": "application/json" })).status).toBe(404);
    await database.DB.prepare("UPDATE client_links SET allow_download = 0 WHERE id = ?").bind(link.id).run();
    expect((await prepare(link)).status).toBe(403);
  });

  it("prepare says nothing_to_download when nothing is released", async () => {
    const link = await verifiedLink(); const version = await seedVideoVersion(); await addMember(link.id, version.videoId, [version.assetId]);
    const response = await prepare(link); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "nothing_to_download" });
  });

  it("prepare has its own rate limit: 20 per guest in 15 minutes, 429 with Retry-After", async () => {
    const { link } = await setup();
    for (let index = 0; index < 20; index += 1) expect((await prepare(link)).status, `prepare ${index + 1}`).toBe(200);
    const limited = await prepare(link); expect(limited.status).toBe(429); expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await zipQuota()).toBe(0);
  });
});

describe("the Delivery review link serves the published Version without a Release (#847)", () => {
  afterEach(async () => { await clearGuestRows(); await wipeDelivery(); });
  const listed = async (link: { id: string; cookie: string }) => guestVideoListResponseSchema.parse(await (await guestFetch(linkPath(link.id, "/videos"), { cookie: link.cookie })).json());
  /** A film with v1 and v2 (v2 published, in the latest set), on a Delivery review link, nothing released. */
  async function delivered(options: { ordinary?: boolean; title?: string } = {}) {
    const v1 = await seedVideoVersion({ title: options.title ?? "Hero" }); const v2 = await seedVideoVersion({ videoId: v1.videoId, version: 2 });
    await seedPage({ assetIds: [v2.assetId] });
    const link = await verifiedLink(options.ordinary ? {} : { deliveryReview: true });
    await addMember(link.id, v1.videoId, [v1.assetId, v2.assetId]);
    return { link, v1, v2 };
  }

  it("downloads the published Version, audits it, and refuses an older Version until it is released", async () => {
    const { link, v1, v2 } = await delivered();
    const published = await get(link, link.cookie, v2.assetId);
    expect(published.status, await published.clone().text()).toBe(200);
    expect(new Uint8Array(await published.arrayBuffer())).toEqual(mp4Bytes(4096));
    expect(await audits()).toHaveLength(1);
    const older = await get(link, link.cookie, v1.assetId); expect(older.status).toBe(409); expect(await older.json()).toEqual({ error: "not_released" });
    await release(v1);
    const released = await get(link, link.cookie, v1.assetId); expect(released.status).toBe(200); dispose(released);
    expect((await get(link, link.cookie, v2.assetId, {}, "HEAD")).status).toBe(200);
    expect((await get(link, link.cookie, v2.assetId, { range: "bytes=0-9" })).status).toBe(206);
    expect(await database.DB.prepare("SELECT count(*) AS n FROM video_releases WHERE asset_id = ?").bind(v2.assetId).first()).toEqual({ n: 0 });
  });

  it("an ordinary link with the same Version granted still needs a Release", async () => {
    const { link, v2 } = await delivered({ ordinary: true });
    const response = await get(link, link.cookie, v2.assetId); expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "not_released" });
  });

  it("stops serving a Version once a newer Publish replaces it, and never serves a premium film that is locked", async () => {
    const { link, v2 } = await delivered();
    expect((await get(link, link.cookie, v2.assetId, {}, "HEAD")).status).toBe(200);
    await setPremium((await database.DB.prepare("SELECT video_id FROM video_version_meta WHERE asset_id = ?").bind(v2.assetId).first<{ video_id: string }>())!.video_id, true);
    const locked = await get(link, link.cookie, v2.assetId); expect(locked.status).toBe(403); expect(await locked.json()).toEqual({ error: "premium_locked" });
    await database.DB.prepare("DELETE FROM delivery_set_items").run();
    const gone = await get(link, link.cookie, v2.assetId); expect([403, 409]).toContain(gone.status);
  });

  it("lists a download URL for the published Version only, with released still false, and Download all holds it", async () => {
    const { link, v1, v2 } = await delivered();
    const versions = (await listed(link)).videos[0]!.versions;
    expect(versions.map((entry) => [entry.version, entry.released, entry.downloadUrl])).toEqual([[2, false, `/d/api/links/${link.id}/versions/${v2.assetId}/download`], [1, false, null]]);
    const manifest = await (await guestFetch(manifestPath(link.id), { cookie: link.cookie })).json() as Json;
    expect(manifest.included.map((entry: Json) => entry.version)).toEqual([2]); expect(manifest.leftOut).toEqual([]);
    const zip = await guestFetch(zipPath(link.id), { cookie: link.cookie }); expect(zip.status).toBe(200);
    const files = await unzip(zip); expect([...files.keys()]).toEqual(["Hero v2.mp4"]);
    await release(v1);
    expect(((await listed(link)).videos[0]!.versions).map((entry) => entry.downloadUrl !== null)).toEqual([true, true]);
  });
});
