import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reviewLinkListResponseSchema, reviewLinkResponseSchema, reviewLinkRevealResponseSchema, type ReviewLinkDto } from "@quincy/shared";
import { hashToken } from "../src/lib/opaque-token";
import { baseEnv, database, ids, request, seedFixture, type Who } from "./embedded-media-support";
import { clearVideoFlags, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/** Staff Review link API (#741 11a): the full order matrix, the 0069 cross-column invariants (route SQL, not CHECKs), and the token rules. */
const OPEN = ["video_review", "video_review_links", `video_review_pilot:${ids.project}`] as const;
const base = (projectId: string = ids.project) => `/api/projects/${projectId}/review-links`;
type Json = Record<string, any>;
const json = async (response: Response) => await response.json() as Json;
const DAY = 86_400_000;

async function create(body: Json, who: Who = "admin", projectId: string = ids.project) { return request(base(projectId), who, "POST", body); }
async function createOk(body: Json, who: Who = "admin") {
  const response = await create(body, who); expect(response.status, await response.clone().text()).toBe(201);
  const parsed = reviewLinkRevealResponseSchema.parse(await response.json());
  return { ...parsed, token: new URL(parsed.url).hash.slice(3) };
}
async function listOk(who: Who = "admin"): Promise<ReviewLinkDto[]> { const response = await request(base(), who); expect(response.status).toBe(200); return reviewLinkListResponseSchema.parse(await response.json()).links; }
async function linkOf(linkId: string) { const links = await listOk(); const found = links.find((link) => link.id === linkId); if (!found) throw new Error("link not listed"); return found; }

const row = (linkId: string) => database.DB.prepare("SELECT * FROM client_links WHERE id = ?").bind(linkId).first<Record<string, any>>();
const members = async (linkId: string) => (await database.DB.prepare("SELECT * FROM review_link_videos WHERE link_id = ? ORDER BY added_at, id").bind(linkId).all<Record<string, any>>()).results;
const grants = async (linkId: string) => (await database.DB.prepare("SELECT * FROM review_link_version_grants WHERE link_id = ? ORDER BY granted_at, id").bind(linkId).all<Record<string, any>>()).results;
const liveGrantAssets = async (linkId: string, videoId: string) => (await database.DB.prepare("SELECT asset_id FROM review_link_version_grants WHERE link_id = ? AND video_id = ? AND revoked_at IS NULL ORDER BY asset_id").bind(linkId, videoId).all<{ asset_id: string }>()).results.map((entry) => entry.asset_id).sort();
const audits = async (action?: string) => (await database.DB.prepare(`SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE target_type = 'review_link'${action ? " AND action = ?" : ""} ORDER BY created_at, id`).bind(...(action ? [action] : [])).all<{ actor_id: string; action: string; target_type: string; target_id: string; meta_json: string | null }>()).results;

async function seedSession(linkId: string, generation = 1) {
  const now = Date.now(); const id = crypto.randomUUID();
  await database.DB.prepare("INSERT INTO guest_sessions (id, token_hash, link_id, link_generation, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, await hashToken(id), linkId, generation, now, now + DAY, now).run();
  return id;
}
const sessionCount = async (linkId: string) => (await database.DB.prepare("SELECT COUNT(*) AS n FROM guest_sessions WHERE link_id = ?").bind(linkId).first<{ n: number }>())!.n;
async function seedDeliveryLink(projectId: string = ids.project) {
  const id = crypto.randomUUID(); const now = Date.now();
  await database.DB.prepare("INSERT INTO client_links (id, project_id, token_hash, publish_version, expires_at, created_at) VALUES (?, ?, ?, 3, ?, ?)").bind(id, projectId, await hashToken(id), now + DAY, now).run();
  return id;
}

/** A member Video always has at least one live grant (settled #2); a removed member has none. Run after every case that wrote. */
async function expectGrantInvariant() {
  const orphans = (await database.DB.prepare(`SELECT m.link_id, m.video_id FROM review_link_videos m WHERE m.removed_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM review_link_version_grants g WHERE g.link_id = m.link_id AND g.video_id = m.video_id AND g.revoked_at IS NULL)`).all()).results;
  expect(orphans, "member Videos with no live grant").toEqual([]);
  const stray = (await database.DB.prepare(`SELECT g.id FROM review_link_version_grants g WHERE g.revoked_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM review_link_videos m WHERE m.link_id = g.link_id AND m.video_id = g.video_id AND m.removed_at IS NULL)`).all()).results;
  expect(stray, "live grants on a non-member Video").toEqual([]);
}

/** The 0069 invariants that no CHECK can state, over every row the routes wrote. */
async function expectLinkInvariants() {
  const bad = async (where: string) => (await database.DB.prepare(`SELECT id FROM client_links WHERE ${where}`).all()).results;
  expect(await bad("kind = 'video_review' AND (created_by IS NULL OR updated_at IS NULL)"), "video link without created_by/updated_at").toEqual([]);
  expect(await bad("kind = 'video_review' AND ((revoked_at IS NULL) <> (revoked_by IS NULL))"), "revoked_at/revoked_by pair").toEqual([]);
  expect(await bad("kind = 'delivery' AND publish_version IS NULL"), "delivery link without publish_version").toEqual([]);
  expect(await bad("kind = 'video_review' AND publish_version IS NOT NULL"), "video link with publish_version").toEqual([]);
}

let v1: Awaited<ReturnType<typeof seedVideoVersion>>;
let v2: Awaited<ReturnType<typeof seedVideoVersion>>;
let v2b: Awaited<ReturnType<typeof seedVideoVersion>>;
let v3: Awaited<ReturnType<typeof seedVideoVersion>>;
let otherProjectVideo: Awaited<ReturnType<typeof seedVideoVersion>>;

beforeAll(async () => { await seedFixture(); });
beforeEach(async () => {
  await clearVideoFlags(); await setVideoFlags(...OPEN);
  await database.DB.batch([
    database.DB.prepare("DELETE FROM guest_sessions"), database.DB.prepare("DELETE FROM review_link_version_grants"), database.DB.prepare("DELETE FROM review_link_videos"),
    database.DB.prepare("DELETE FROM client_links"), database.DB.prepare("DELETE FROM audit_log WHERE target_type = 'review_link'"), database.DB.prepare("DELETE FROM video_notes"),
    database.DB.prepare("DELETE FROM video_version_meta"), database.DB.prepare("DELETE FROM assets WHERE kind = 'video'"), database.DB.prepare("DELETE FROM videos"),
  ]);
  v1 = await seedVideoVersion({ title: "Hero" });
  v2 = await seedVideoVersion({ title: "Walkthrough" });
  v2b = await seedVideoVersion({ projectId: ids.project, videoId: v2.videoId, version: 2 });
  v3 = await seedVideoVersion({ title: "Teaser" });
  otherProjectVideo = await seedVideoVersion({ projectId: ids.otherProject, title: "Elsewhere" });
  await setVideoFlags(`video_review_pilot:${ids.otherProject}`, `video_review_pilot:${ids.archivedProject}`);
});
afterEach(async () => { await expectGrantInvariant(); await expectLinkInvariants(); await clearVideoFlags(); });

describe("the links gate and the route order", () => {
  it("answers one 404 for a real and an unknown id on every route when the master, the links part or the Project's pilot is off", async () => {
    const { link } = await createOk({ videoIds: [v1.videoId] });
    const calls = (linkId: string, videoId: string): Array<[string, string, Json?]> => [
      ["GET", base()], ["POST", base(), { videoIds: [videoId] }], ["PATCH", `${base()}/${linkId}`, { label: "x" }],
      ["POST", `${base()}/${linkId}/videos`, { videoId, assetIds: [crypto.randomUUID()] }], ["DELETE", `${base()}/${linkId}/videos/${videoId}`],
      ["PUT", `${base()}/${linkId}/videos/${videoId}/grants`, { assetIds: [crypto.randomUUID()] }], ["POST", `${base()}/${linkId}/replace`, {}],
    ];
    const closings: Array<[string, () => Promise<void>]> = [
      ["master off", async () => { await clearVideoFlags(); await setVideoFlags("video_review_links", `video_review_pilot:${ids.project}`); }],
      ["links off", async () => { await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.project}`); }],
      ["another Project's pilot", async () => { await clearVideoFlags(); await setVideoFlags("video_review", "video_review_links", `video_review_pilot:${ids.otherProject}`); }],
    ];
    for (const [label, close] of closings) {
      await close();
      for (const who of ["admin", "member", "photographer", "external"] as const) {
        const real = calls(link.id, v1.videoId); const unknown = calls(crypto.randomUUID(), crypto.randomUUID());
        for (let i = 0; i < real.length; i += 1) {
          const [method, path, body] = real[i]!; const [, unknownPath] = unknown[i]!;
          const a = await request(path, who, method as "GET", body); const b = await request(unknownPath, who, method as "GET", body);
          expect([a.status, b.status], `${label} ${who} ${method} ${path}`).toEqual([404, 404]);
          expect(await json(a), label).toEqual(await json(b));
        }
      }
    }
  });

  it("answers 400 for a malformed id before the gate", async () => {
    await clearVideoFlags();
    expect((await request(`/api/projects/nope/review-links`, "admin")).status).toBe(400);
    expect((await request(`${base()}/nope`, "admin", "PATCH", { label: "x" })).status).toBe(400);
    expect((await request(`${base()}/nope/revoke`, "admin", "POST", {})).status).toBe(400);
    expect((await request(`${base()}/${crypto.randomUUID()}/videos/nope`, "admin", "DELETE")).status).toBe(400);
  });

  it("checks the capability after the gate: Admin and Editors pass, a Photographer and every External get 403 (and the closed gate wins over the capability)", async () => {
    for (const who of ["admin", "member", "other"] as const) expect((await request(base(), who)).status, who).toBe(200);
    for (const who of ["photographer", "external", "externalOutsider"] as const) {
      expect((await request(base(), who)).status, `list ${who}`).toBe(403);
      expect((await create({ videoIds: [v1.videoId] }, who)).status, `create ${who}`).toBe(403);
      expect((await request(`${base()}/${crypto.randomUUID()}/revoke`, who, "POST", {})).status, `revoke ${who}`).toBe(403);
    }
    expect(await audits()).toEqual([]);
  });

  it("refuses an archived Project's writes 409 project_archived, but still reads and revokes", async () => {
    await setVideoFlags(`video_review_pilot:${ids.archivedProject}`);
    const archivedVideo = await seedVideoVersion({ projectId: ids.archivedProject, title: "Archived cut" });
    const archivedPath = base(ids.archivedProject);
    const { link } = await createOk({ videoIds: [v1.videoId] });
    // Park a link on the archived Project directly, as if it had been made before the archive.
    const parked = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO client_links (id, project_id, token_hash, kind, expires_at, created_by, created_at, updated_at) VALUES (?, ?, ?, 'video_review', ?, ?, ?, ?)").bind(parked, ids.archivedProject, await hashToken("parked"), now + DAY, ids.admin, now, now).run();
    await database.DB.prepare("INSERT INTO review_link_videos (id, link_id, video_id, project_id, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), parked, archivedVideo.videoId, ids.archivedProject, ids.admin, now).run();
    await database.DB.prepare("INSERT INTO review_link_version_grants (id, link_id, video_id, asset_id, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), parked, archivedVideo.videoId, archivedVideo.assetId, ids.admin, now).run();
    await seedSession(parked);
    const writes: Array<[string, string, Json?]> = [
      ["POST", archivedPath, { videoIds: [archivedVideo.videoId] }], ["PATCH", `${archivedPath}/${parked}`, { label: "x" }],
      ["POST", `${archivedPath}/${parked}/videos`, { videoId: archivedVideo.videoId, assetIds: [archivedVideo.assetId] }],
      ["DELETE", `${archivedPath}/${parked}/videos/${archivedVideo.videoId}`], ["PUT", `${archivedPath}/${parked}/videos/${archivedVideo.videoId}/grants`, { assetIds: [archivedVideo.assetId] }],
      ["POST", `${archivedPath}/${parked}/replace`, {}],
    ];
    for (const [method, path, body] of writes) {
      const response = await request(path, "admin", method as "POST", body);
      expect(response.status, `${method} ${path}`).toBe(409); expect(await json(response)).toMatchObject({ code: "project_archived" });
    }
    expect(await audits()).toHaveLength(1); // only the live Project's create
    expect((await request(archivedPath, "admin")).status).toBe(200);
    expect(await sessionCount(parked)).toBe(1);
    const revoked = await request(`${archivedPath}/${parked}/revoke`, "admin", "POST", {});
    expect(revoked.status).toBe(200); expect(reviewLinkResponseSchema.parse(await revoked.json()).link.status).toBe("revoked");
    expect(await sessionCount(parked)).toBe(0);
    expect(link.status).toBe("active");
  });
});

describe("POST create", () => {
  it("creates a link: 201, no-store, the URL carries the token in the fragment only, and only the hash is stored", async () => {
    const response = await create({ videoIds: [v1.videoId], label: "  Smith family  " });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const { link, url } = reviewLinkRevealResponseSchema.parse(await response.json());
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(`${baseEnv.APP_ORIGIN}/d/review`);
    expect(parsed.searchParams.get("link")).toBe(link.id); expect([...parsed.searchParams.keys()]).toEqual(["link"]);
    const token = parsed.hash.slice(3); expect(parsed.hash.startsWith("#t=")).toBe(true); expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = (await row(link.id))!;
    expect(stored.token_hash).toBe(await hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored).toMatchObject({ kind: "video_review", project_id: ids.project, label: "Smith family", created_by: ids.admin, token_generation: 1, publish_version: null, revoked_at: null, revoked_by: null, passcode_hash: null, allow_comments: 1, allow_approve: 1, allow_download: 1 });
    expect(stored.updated_at).toBe(stored.created_at);
    expect(link).toMatchObject({ label: "Smith family", status: "active", hasPasscode: false, allow: { comments: true, approve: true, download: true }, createdBy: { id: ids.admin } });
  });

  it("defaults the expiry to 30 days and bounds it to one hour through 365 days (422 expiry_out_of_range)", async () => {
    const before = Date.now();
    const { link } = await createOk({ videoIds: [v1.videoId] });
    expect(Date.parse(link.expiresAt)).toBeGreaterThanOrEqual(before + 30 * DAY - 1000); expect(Date.parse(link.expiresAt)).toBeLessThanOrEqual(Date.now() + 30 * DAY + 1000);
    for (const offset of [-DAY, 30 * 60_000, 366 * DAY]) {
      const refused = await create({ videoIds: [v1.videoId], expiresAt: new Date(Date.now() + offset).toISOString() });
      expect(refused.status, String(offset)).toBe(422); expect(await json(refused)).toMatchObject({ code: "expiry_out_of_range" });
    }
    for (const offset of [2 * 3_600_000, 364 * DAY]) expect((await create({ videoIds: [v1.videoId], expiresAt: new Date(Date.now() + offset).toISOString() })).status).toBe(201);
    expect((await create({ videoIds: [v1.videoId], expiresAt: "tomorrow" })).status).toBe(400);
  });

  it("grants each Video's current Version by default, or exactly the Versions named", async () => {
    const { link } = await createOk({ videoIds: [v1.videoId, v2.videoId] });
    expect(await liveGrantAssets(link.id, v1.videoId)).toEqual([v1.assetId]);
    expect(await liveGrantAssets(link.id, v2.videoId)).toEqual([v2b.assetId]); // version 2 is current
    const named = await createOk({ videoIds: [v2.videoId], grants: { [v2.videoId]: [v2.assetId, v2b.assetId] } });
    expect(await liveGrantAssets(named.link.id, v2.videoId)).toEqual([v2.assetId, v2b.assetId].sort());
    expect(named.link.videos[0]!.grants).toEqual([{ assetId: v2.assetId, version: 1 }, { assetId: v2b.assetId, version: 2 }]);
    expect(link.videos.map((video) => video.title)).toEqual(["Hero", "Walkthrough"]);
  });

  it("refuses a grant that is not a Version of that Video (422 grant_not_version), an empty grant list (422 grant_required) and a grants key outside videoIds (400), writing nothing", async () => {
    const wrong = await create({ videoIds: [v1.videoId], grants: { [v1.videoId]: [v3.assetId] } });
    expect(wrong.status).toBe(422); expect(await json(wrong)).toMatchObject({ code: "grant_not_version" });
    const empty = await create({ videoIds: [v1.videoId], grants: { [v1.videoId]: [] } });
    expect(empty.status).toBe(422); expect(await json(empty)).toMatchObject({ code: "grant_required" });
    expect((await create({ videoIds: [v1.videoId], grants: { [v3.videoId]: [v3.assetId] } })).status).toBe(400);
    expect((await database.DB.prepare("SELECT COUNT(*) AS n FROM client_links").first<{ n: number }>())!.n).toBe(0);
    expect(await audits()).toEqual([]);
  });

  it("refuses a Video from another Project, or an unknown one (422 video_other_project), and writes no link, member, grant or audit row", async () => {
    for (const videoIds of [[v1.videoId, otherProjectVideo.videoId], [crypto.randomUUID()]]) {
      const refused = await create({ videoIds });
      expect(refused.status).toBe(422); expect(await json(refused)).toMatchObject({ code: "video_other_project" });
    }
    const crossGrant = await create({ videoIds: [v1.videoId], grants: { [v1.videoId]: [otherProjectVideo.assetId] } });
    expect(crossGrant.status).toBe(422);
    for (const table of ["client_links", "review_link_videos", "review_link_version_grants"]) expect((await database.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n, table).toBe(0);
    expect(await audits()).toEqual([]);
  });

  it("validates the body strictly: 1 to 50 distinct-looking uuids, passcode 6 to 64, label 1 to 80, unknown keys 400", async () => {
    for (const body of [{ videoIds: [] }, { videoIds: ["x"] }, { videoIds: Array.from({ length: 51 }, () => crypto.randomUUID()) }, { videoIds: [v1.videoId], passcode: "12345" }, { videoIds: [v1.videoId], passcode: "x".repeat(65) },
      { videoIds: [v1.videoId], label: "   " }, { videoIds: [v1.videoId], label: "y".repeat(81) }, { videoIds: [v1.videoId], token: "mine" }, { videoIds: [v1.videoId], allow: { sneak: true } }]) {
      expect((await create(body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    expect((await request(base(), "admin", "POST", undefined)).status).toBe(400);
  });

  it("hashes the passcode (pbkdf2-sha256, 100k, per-row salt) and never returns or audits it; sets the permissions", async () => {
    const a = await createOk({ videoIds: [v1.videoId], passcode: "  correct horse  ", allow: { download: false, approve: false } });
    const b = await createOk({ videoIds: [v1.videoId], passcode: "correct horse" });
    const [rowA, rowB] = [(await row(a.link.id))!, (await row(b.link.id))!];
    expect(rowA.passcode_hash).toMatch(/^pbkdf2-sha256\$100000\$[A-Za-z0-9+/=_-]+\$[A-Za-z0-9+/=_-]+$/);
    expect(rowA.passcode_hash).not.toBe(rowB.passcode_hash);
    expect(JSON.stringify(rowA.passcode_hash)).not.toContain("correct horse");
    expect(a.link).toMatchObject({ hasPasscode: true, allow: { comments: true, approve: false, download: false } });
    expect(rowA).toMatchObject({ allow_comments: 1, allow_approve: 0, allow_download: 0 });
  });

  it("writes one review_link.create audit row with ids and no secret", async () => {
    const { link, token } = await createOk({ videoIds: [v1.videoId, v2.videoId], passcode: "secret-pass" });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: ids.admin, action: "review_link.create", target_type: "review_link", target_id: link.id });
    const meta = JSON.parse(rows[0]!.meta_json!);
    expect(meta).toMatchObject({ projectId: ids.project, linkId: link.id, videoIds: [v1.videoId, v2.videoId], hasPasscode: true });
    expect(rows[0]!.meta_json).not.toContain(token); expect(rows[0]!.meta_json).not.toContain(await hashToken(token)); expect(rows[0]!.meta_json).not.toContain("secret-pass");
  });
});

describe("GET list", () => {
  it("lists this Project's Review links only, newest first, derived status, with members and live grants, and never a secret", async () => {
    const a = await createOk({ videoIds: [v1.videoId], passcode: "secret-pass" });
    const b = await createOk({ videoIds: [v2.videoId] });
    await database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, a.link.id).run();
    const deliveryId = await seedDeliveryLink(); await seedDeliveryLink(ids.otherProject);
    await setVideoFlags(`video_review_pilot:${ids.otherProject}`);
    await database.DB.prepare("UPDATE client_links SET created_at = created_at + 10 WHERE id = ?").bind(b.link.id).run();
    const raw = await request(base(), "admin"); const text = await raw.clone().text();
    const links = reviewLinkListResponseSchema.parse(await raw.json()).links;
    expect(links.map((link) => link.id)).toEqual([b.link.id, a.link.id]);
    expect(links.map((link) => link.status)).toEqual(["active", "expired"]);
    expect(text).not.toContain(deliveryId);
    for (const secret of [a.token, b.token, await hashToken(a.token), await hashToken(b.token), (await row(a.link.id))!.passcode_hash, "token_hash", "passcode_hash", "tokenHash"]) expect(text, String(secret)).not.toContain(secret);
    expect(links[1]!.hasPasscode).toBe(true);
    expect(links[0]!.activity).toEqual({ openSessions: 0, lastOpenedAt: null, verifiedGuests: [] });
    const revoked = await request(`${base()}/${b.link.id}/revoke`, "admin", "POST", {}); expect(revoked.status).toBe(200);
    expect((await linkOf(b.link.id)).status).toBe("revoked");
  });

  it("hides a removed member and a revoked grant, and counts open sessions", async () => {
    const { link } = await createOk({ videoIds: [v1.videoId, v2.videoId] });
    await seedSession(link.id);
    expect((await request(`${base()}/${link.id}/videos/${v2.videoId}`, "admin", "DELETE")).status).toBe(204);
    const after = await linkOf(link.id);
    expect(after.videos.map((video) => video.videoId)).toEqual([v1.videoId]);
    expect(after.activity.openSessions).toBe(1); expect(after.activity.lastOpenedAt).not.toBeNull();
  });
});

describe("PATCH", () => {
  it("changes only the named fields, bumps updated_at, keeps created_by and the token, and audits field names only", async () => {
    const { link, token } = await createOk({ videoIds: [v1.videoId], label: "Old", passcode: "first-pass" });
    const before = (await row(link.id))!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const expiresAt = new Date(Date.now() + 10 * DAY).toISOString();
    const response = await request(`${base()}/${link.id}`, "member", "PATCH", { label: "New", expiresAt, passcode: "second-pass", allow: { comments: false } });
    expect(response.status, await response.clone().text()).toBe(200);
    const dto = reviewLinkResponseSchema.parse(await response.json()).link;
    expect(dto).toMatchObject({ label: "New", expiresAt, hasPasscode: true, allow: { comments: false, approve: true, download: true } });
    const after = (await row(link.id))!;
    expect(after.token_hash).toBe(await hashToken(token)); expect(after.created_by).toBe(ids.admin); expect(after.token_generation).toBe(1);
    expect(after.updated_at).toBeGreaterThan(before.updated_at); expect(after.passcode_hash).not.toBe(before.passcode_hash);
    const [entry] = await audits("review_link.update");
    expect(entry).toMatchObject({ actor_id: ids.member, target_id: link.id });
    expect(JSON.parse(entry!.meta_json!)).toMatchObject({ projectId: ids.project, linkId: link.id, fields: ["label", "expiresAt", "passcode", "allow"] });
    expect(entry!.meta_json).not.toContain("second-pass"); expect(entry!.meta_json).not.toContain(after.passcode_hash);
  });

  it("clears the passcode and the label with null; refuses an empty body, bad bounds and unknown keys", async () => {
    const { link } = await createOk({ videoIds: [v1.videoId], label: "L", passcode: "first-pass" });
    const cleared = await request(`${base()}/${link.id}`, "admin", "PATCH", { passcode: null, label: null });
    expect(cleared.status).toBe(200);
    expect(await row(link.id)).toMatchObject({ passcode_hash: null, label: null });
    for (const body of [{}, { allow: {} }, { token: "x" }, { passcode: "short" }, { label: "" }]) expect((await request(`${base()}/${link.id}`, "admin", "PATCH", body)).status, JSON.stringify(body)).toBe(400);
    const out = await request(`${base()}/${link.id}`, "admin", "PATCH", { expiresAt: new Date(Date.now() + 400 * DAY).toISOString() });
    expect(out.status).toBe(422); expect(await json(out)).toMatchObject({ code: "expiry_out_of_range" });
  });

  it("answers 409 link_revoked on a revoked link and 404 for an unknown link, another Project's link and a delivery link (whose publish_version is untouched)", async () => {
    const { link } = await createOk({ videoIds: [v1.videoId] });
    const deliveryId = await seedDeliveryLink();
    const other = await seedVideoVersion({ projectId: ids.otherProject, title: "o" });
    const otherLink = await createOk({ videoIds: [other.videoId] }, "admin").catch(() => null);
    expect(otherLink).toBeNull(); // created through the wrong Project path: 422
    expect((await request(`${base()}/${crypto.randomUUID()}`, "admin", "PATCH", { label: "x" })).status).toBe(404);
    const deliveryPatch = await request(`${base()}/${deliveryId}`, "admin", "PATCH", { label: "x" });
    expect(deliveryPatch.status).toBe(404);
    for (const [method, path, body] of [["POST", `${base()}/${deliveryId}/revoke`, {}], ["POST", `${base()}/${deliveryId}/replace`, {}], ["POST", `${base()}/${deliveryId}/videos`, { videoId: v1.videoId, assetIds: [v1.assetId] }]] as const) {
      expect((await request(path, "admin", method, body)).status, path).toBe(404);
    }
    expect(await row(deliveryId)).toMatchObject({ kind: "delivery", publish_version: 3, revoked_at: null, label: null });
    // Another Project's link, addressed through this Project's path.
    const foreign = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO client_links (id, project_id, token_hash, kind, expires_at, created_by, created_at, updated_at) VALUES (?, ?, ?, 'video_review', ?, ?, ?, ?)").bind(foreign, ids.otherProject, await hashToken("foreign"), now + DAY, ids.admin, now, now).run();
    expect((await request(`${base()}/${foreign}`, "admin", "PATCH", { label: "x" })).status).toBe(404);
    expect((await request(`${base()}/${foreign}/revoke`, "admin", "POST", {})).status).toBe(404);
    expect((await row(foreign))!.revoked_at).toBeNull();
    await request(`${base()}/${link.id}/revoke`, "admin", "POST", {});
    const revoked = await request(`${base()}/${link.id}`, "admin", "PATCH", { label: "late" });
    expect(revoked.status).toBe(409); expect(await json(revoked)).toMatchObject({ code: "link_revoked" });
  });
});

describe("Videos on a link", () => {
  it("adds a Video with its Versions (201), refuses a repeat (409 already_on_link), another Project's Video (422) and a non-Version (422)", async () => {
    const { link } = await createOk({ videoIds: [v1.videoId] });
    const added = await request(`${base()}/${link.id}/videos`, "admin", "POST", { videoId: v2.videoId, assetIds: [v2.assetId] });
    expect(added.status, await added.clone().text()).toBe(201);
    expect(reviewLinkResponseSchema.parse(await added.json()).link.videos.map((video) => video.videoId).sort()).toEqual([v1.videoId, v2.videoId].sort());
    expect(await liveGrantAssets(link.id, v2.videoId)).toEqual([v2.assetId]);
    const again = await request(`${base()}/${link.id}/videos`, "admin", "POST", { videoId: v2.videoId, assetIds: [v2.assetId] });
    expect(again.status).toBe(409); expect(await json(again)).toMatchObject({ code: "already_on_link" });
    const cross = await request(`${base()}/${link.id}/videos`, "admin", "POST", { videoId: otherProjectVideo.videoId, assetIds: [otherProjectVideo.assetId] });
    expect(cross.status).toBe(422); expect(await json(cross)).toMatchObject({ code: "video_other_project" });
    const wrong = await request(`${base()}/${link.id}/videos`, "admin", "POST", { videoId: v3.videoId, assetIds: [v1.assetId] });
    expect(wrong.status).toBe(422); expect(await json(wrong)).toMatchObject({ code: "grant_not_version" });
    const none = await request(`${base()}/${link.id}/videos`, "admin", "POST", { videoId: v3.videoId, assetIds: [] });
    expect(none.status).toBe(422); expect(await json(none)).toMatchObject({ code: "grant_required" });
    expect(await members(link.id)).toHaveLength(2);
    expect((await audits("review_link.video_add"))).toHaveLength(1);
  });

  it("removes a Video: membership and its live grants close, notes survive, a re-add is a new row (history kept)", async () => {
    const { link } = await createOk({ videoIds: [v1.videoId, v2.videoId] });
    const note = await seedVideoNote({ assetId: v1.assetId });
    const removed = await request(`${base()}/${link.id}/videos/${v1.videoId}`, "member", "DELETE");
    expect(removed.status).toBe(204);
    const [gone] = (await members(link.id)).filter((entry) => entry.video_id === v1.videoId);
    expect(gone).toMatchObject({ removed_by: ids.member }); expect(gone!.removed_at).not.toBeNull();
    expect(await liveGrantAssets(link.id, v1.videoId)).toEqual([]);
    expect((await grants(link.id)).find((entry) => entry.video_id === v1.videoId)).toMatchObject({ revoked_by: ids.member });
    expect(await database.DB.prepare("SELECT id FROM video_notes WHERE id = ?").bind(note.id).first()).not.toBeNull();
    expect((await request(`${base()}/${link.id}/videos/${v1.videoId}`, "admin", "DELETE")).status).toBe(404);
    expect((await request(`${base()}/${link.id}/videos/${v3.videoId}`, "admin", "DELETE")).status).toBe(404);
    const readded = await request(`${base()}/${link.id}/videos`, "admin", "POST", { videoId: v1.videoId, assetIds: [v1.assetId] });
    expect(readded.status).toBe(201);
    expect((await members(link.id)).filter((entry) => entry.video_id === v1.videoId)).toHaveLength(2);
    expect((await grants(link.id)).filter((entry) => entry.video_id === v1.videoId)).toHaveLength(2);
    expect((await audits("review_link.video_remove"))).toHaveLength(1);
  });

  it("answers 409 link_revoked for video changes on a revoked link", async () => {
    const { link } = await createOk({ videoIds: [v1.videoId] });
    await request(`${base()}/${link.id}/revoke`, "admin", "POST", {});
    for (const [method, path, body] of [["POST", `${base()}/${link.id}/videos`, { videoId: v2.videoId, assetIds: [v2.assetId] }], ["DELETE", `${base()}/${link.id}/videos/${v1.videoId}`, undefined], ["PUT", `${base()}/${link.id}/videos/${v1.videoId}/grants`, { assetIds: [v1.assetId] }]] as const) {
      const response = await request(path, "admin", method, body);
      expect(response.status, path).toBe(409); expect(await json(response)).toMatchObject({ code: "link_revoked" });
    }
  });
});

describe("PUT grants", () => {
  it("replaces the full set by diff: revokes what left, grants what arrived, keeps the rest untouched, keeps history", async () => {
    const { link } = await createOk({ videoIds: [v2.videoId], grants: { [v2.videoId]: [v2.assetId] } });
    const kept = (await grants(link.id))[0]!;
    const put = (assetIds: string[]) => request(`${base()}/${link.id}/videos/${v2.videoId}/grants`, "admin", "PUT", { assetIds });
    const widened = await put([v2.assetId, v2b.assetId]);
    expect(widened.status, await widened.clone().text()).toBe(200);
    expect(await liveGrantAssets(link.id, v2.videoId)).toEqual([v2.assetId, v2b.assetId].sort());
    expect((await grants(link.id)).find((entry) => entry.id === kept.id)).toMatchObject({ revoked_at: null, granted_at: kept.granted_at });
    const narrowed = await put([v2b.assetId]);
    expect(reviewLinkResponseSchema.parse(await narrowed.json()).link.videos[0]!.grants).toEqual([{ assetId: v2b.assetId, version: 2 }]);
    expect(await liveGrantAssets(link.id, v2.videoId)).toEqual([v2b.assetId]);
    await put([v2.assetId, v2.assetId]); // a duplicate in the set is one grant
    expect(await liveGrantAssets(link.id, v2.videoId)).toEqual([v2.assetId]);
    expect((await grants(link.id)).filter((entry) => entry.asset_id === v2.assetId)).toHaveLength(2); // revoked once, re-granted
    expect((await audits("review_link.grants_set")).length).toBe(3);
  });

  it("refuses an empty set (422 grant_required), a non-Version (422 grant_not_version) and a Video not on the link (404), changing nothing", async () => {
    const { link } = await createOk({ videoIds: [v2.videoId] });
    const before = await liveGrantAssets(link.id, v2.videoId);
    const empty = await request(`${base()}/${link.id}/videos/${v2.videoId}/grants`, "admin", "PUT", { assetIds: [] });
    expect(empty.status).toBe(422); expect(await json(empty)).toMatchObject({ code: "grant_required" });
    const wrong = await request(`${base()}/${link.id}/videos/${v2.videoId}/grants`, "admin", "PUT", { assetIds: [v1.assetId] });
    expect(wrong.status).toBe(422); expect(await json(wrong)).toMatchObject({ code: "grant_not_version" });
    expect((await request(`${base()}/${link.id}/videos/${v1.videoId}/grants`, "admin", "PUT", { assetIds: [v1.assetId] })).status).toBe(404);
    expect(await liveGrantAssets(link.id, v2.videoId)).toEqual(before);
    expect(await audits("review_link.grants_set")).toEqual([]);
  });

  it("never auto-grants a Version uploaded after the link was made", async () => {
    const { link } = await createOk({ videoIds: [v1.videoId] });
    const v1b = await seedVideoVersion({ videoId: v1.videoId, version: 2 });
    expect(await liveGrantAssets(link.id, v1.videoId)).toEqual([v1.assetId]);
    expect((await linkOf(link.id)).videos[0]!.grants.map((grant) => grant.assetId)).not.toContain(v1b.assetId);
  });
});

describe("revoke", () => {
  it("revokes: revoked_at and revoked_by together, the generation bumps, sessions are deleted, idempotent with one audit row", async () => {
    const { link } = await createOk({ videoIds: [v1.videoId] });
    await seedSession(link.id); await seedSession(link.id);
    const first = await request(`${base()}/${link.id}/revoke`, "member", "POST", {});
    expect(first.status).toBe(200);
    expect(reviewLinkResponseSchema.parse(await first.json()).link).toMatchObject({ status: "revoked", revokedBy: { id: ids.member } });
    const stored = (await row(link.id))!;
    expect(stored).toMatchObject({ revoked_by: ids.member, token_generation: 2 }); expect(stored.revoked_at).not.toBeNull(); expect(stored.updated_at).toBeGreaterThanOrEqual(stored.revoked_at);
    expect(await sessionCount(link.id)).toBe(0);
    const second = await request(`${base()}/${link.id}/revoke`, "admin", "POST", {});
    expect(second.status).toBe(200);
    expect(await row(link.id)).toMatchObject({ revoked_by: ids.member, revoked_at: stored.revoked_at, token_generation: 2 });
    expect(await audits("review_link.revoke")).toHaveLength(1);
    expect((await request(`${base()}/${crypto.randomUUID()}/revoke`, "admin", "POST", {})).status).toBe(404);
  });

  it("works with the links part off (the master and the Project's pilot still open), and not when the master is off", async () => {
    const { link } = await createOk({ videoIds: [v1.videoId] });
    const other = await createOk({ videoIds: [v2.videoId] });
    await clearVideoFlags(); await setVideoFlags("video_review", `video_review_pilot:${ids.project}`);
    expect((await request(base(), "admin")).status).toBe(404);
    expect((await create({ videoIds: [v1.videoId] })).status).toBe(404);
    const revoked = await request(`${base()}/${link.id}/revoke`, "admin", "POST", {});
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect((await row(link.id))!.revoked_at).not.toBeNull();
    await clearVideoFlags(); await setVideoFlags("video_review_links", `video_review_pilot:${ids.project}`);
    expect((await request(`${base()}/${other.link.id}/revoke`, "admin", "POST", {})).status).toBe(404);
    expect((await row(other.link.id))!.revoked_at).toBeNull();
  });
});

describe("replace", () => {
  it("rotates the token: new token once, old hash gone, generation +1, sessions deleted, no-store, one audit row", async () => {
    const { link, token } = await createOk({ videoIds: [v1.videoId], passcode: "keep-this-one" });
    const sessions = [await seedSession(link.id), await seedSession(link.id)]; expect(sessions).toHaveLength(2);
    const before = (await row(link.id))!;
    const response = await request(`${base()}/${link.id}/replace`, "member", "POST", {});
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const { url, link: dto } = reviewLinkRevealResponseSchema.parse(await response.json());
    const next = new URL(url); const newToken = next.hash.slice(3);
    expect(next.searchParams.get("link")).toBe(link.id); expect(newToken).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(newToken).not.toBe(token);
    const after = (await row(link.id))!;
    expect(after.token_hash).toBe(await hashToken(newToken)); expect(after.token_hash).not.toBe(before.token_hash);
    expect(await database.DB.prepare("SELECT 1 FROM client_links WHERE token_hash = ?").bind(before.token_hash).first()).toBeNull();
    expect(JSON.stringify(after)).not.toContain(newToken);
    expect(after).toMatchObject({ token_generation: 2, passcode_hash: before.passcode_hash, created_by: ids.admin, revoked_at: null, label: before.label });
    expect(after.updated_at).toBeGreaterThanOrEqual(before.updated_at);
    expect(await sessionCount(link.id)).toBe(0);
    expect(dto.status).toBe("active");
    const rows = await audits("review_link.replace");
    expect(rows).toHaveLength(1); expect(rows[0]!.meta_json).not.toContain(newToken); expect(rows[0]!.meta_json).not.toContain(after.token_hash);
    // The list never shows the new token either.
    expect(await (await request(base(), "admin")).text()).not.toContain(newToken);
  });

  it("is refused on a revoked link (409 link_revoked) and an expired one (409 link_expired)", async () => {
    const revoked = await createOk({ videoIds: [v1.videoId] }); await request(`${base()}/${revoked.link.id}/revoke`, "admin", "POST", {});
    const expired = await createOk({ videoIds: [v2.videoId] }); await database.DB.prepare("UPDATE client_links SET expires_at = ? WHERE id = ?").bind(Date.now() - 1000, expired.link.id).run();
    const a = await request(`${base()}/${revoked.link.id}/replace`, "admin", "POST", {}); expect(a.status).toBe(409); expect(await json(a)).toMatchObject({ code: "link_revoked" });
    const b = await request(`${base()}/${expired.link.id}/replace`, "admin", "POST", {}); expect(b.status).toBe(409); expect(await json(b)).toMatchObject({ code: "link_expired" });
    expect(await audits("review_link.replace")).toEqual([]);
    expect((await row(expired.link.id))!.token_generation).toBe(1);
  });
});

describe("cross-column invariants (0069 leaves them to route SQL)", () => {
  it("keeps created_by, updated_at, the revoked pair and publish_version consistent through every mutation, beside an untouched delivery link", async () => {
    const deliveryId = await seedDeliveryLink();
    const { link } = await createOk({ videoIds: [v1.videoId] });
    expect(await row(link.id)).toMatchObject({ revoked_at: null, revoked_by: null, publish_version: null });
    await request(`${base()}/${link.id}`, "admin", "PATCH", { label: "a" });
    await request(`${base()}/${link.id}/videos`, "admin", "POST", { videoId: v2.videoId, assetIds: [v2.assetId] });
    await request(`${base()}/${link.id}/videos/${v2.videoId}/grants`, "admin", "PUT", { assetIds: [v2.assetId, v2b.assetId] });
    await request(`${base()}/${link.id}/videos/${v2.videoId}`, "admin", "DELETE");
    const replaced = await request(`${base()}/${link.id}/replace`, "admin", "POST", {}); expect(replaced.status).toBe(200);
    expect(await row(link.id)).toMatchObject({ created_by: ids.admin, revoked_at: null, revoked_by: null });
    await request(`${base()}/${link.id}/revoke`, "admin", "POST", {});
    const stored = (await row(link.id))!;
    expect(stored.updated_at).not.toBeNull(); expect(stored.revoked_at).not.toBeNull(); expect(stored.revoked_by).toBe(ids.admin);
    expect(await row(deliveryId)).toMatchObject({ kind: "delivery", publish_version: 3, created_by: null, updated_at: null, revoked_at: null, revoked_by: null, token_generation: 1 });
    expect(await audits()).toHaveLength(7);
  });

  it("no route response, list or audit row anywhere carries a token or its hash", async () => {
    const { link, token } = await createOk({ videoIds: [v1.videoId], passcode: "secret-pass" });
    const replaced = await request(`${base()}/${link.id}/replace`, "admin", "POST", {}); const { url } = reviewLinkRevealResponseSchema.parse(await replaced.json());
    const tokens = [token, new URL(url).hash.slice(3)];
    const dump = JSON.stringify((await database.DB.prepare("SELECT * FROM audit_log").all()).results) + await (await request(base(), "admin")).text();
    for (const secret of [...tokens, ...await Promise.all(tokens.map(hashToken)), "secret-pass"]) expect(dump).not.toContain(secret);
  });
});
