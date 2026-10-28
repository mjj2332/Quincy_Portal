import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { database, ids, seedFixture } from "./embedded-media-support";
import { toolsFor } from "../src/mcp/tools/registry";
import { VIDEO_WRITE_TOOLS } from "../src/mcp/tools/video-writes";
import { mcpHarness } from "./mcp-oauth-support";
import { seedVideoVersion, setVideoFlags } from "./video-review-support";

/** Video and Version management through /mcp (#965): visibility by role and scope, parity with the cookie routes, the impact-then-remove round trip, restore, and provenance. */
const testEnv = env as unknown as Env;
const h = mcpHarness(testEnv);
const READS = ["get_version_removal_impact", "get_video_removal_impact", "list_video_trash"];
const WRITES = ["delete_video", "remove_video_version", "rename_video_version", "restore_video", "restore_video_version", "set_version_review_status"];
const TRASH_ONLY = ["delete_video", "remove_video_version", "restore_video", "restore_video_version"];
const OPEN = ["video_review", "video_review_all_projects", "video_review_trash", "video_review_notes"] as const;
const tokens: Record<string, { accessToken: string; connectionId: string }> = {};
const ZERO = { notes: 0, decisions: 0, release: false, links: 0 };

beforeAll(async () => {
  await seedFixture();
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'mcp_access'").run();
  await setVideoFlags(...OPEN);
  for (const [name, id] of [["admin", ids.admin], ["editor", ids.member], ["photographer", ids.photographer], ["external", ids.external], ["outsider", ids.externalOutsider]] as const) await h.addSession(name, id);
  for (const [name, who, scope] of [["admin", "admin", "read write admin"], ["adminRead", "admin", "read"], ["editor", "editor", "read write"], ["editorRead", "editor", "read"], ["photographer", "photographer", "read write"], ["external", "external", "read write"], ["outsider", "outsider", "read write"]] as const) tokens[name] = await h.connect(scope, who);
});
beforeEach(() => { delete (testEnv as { MCP_CALLS?: unknown }).MCP_CALLS; delete (testEnv as { MCP_WRITES?: unknown }).MCP_WRITES; });

const project = ids.project;
const listed = async (who: string) => (await h.toolsList(tokens[who]!.accessToken)).map((tool) => tool.name).filter((name) => [...READS, ...WRITES].includes(name)).sort();
const call = (who: string, name: string, args: Record<string, unknown>) => h.callTool(tokens[who]!.accessToken, name, args);
const json = (outcome: Awaited<ReturnType<typeof call>>) => { expect(outcome.error, JSON.stringify(outcome)).toBeUndefined(); expect(outcome.result?.isError, outcome.result?.content[0]?.text).toBeUndefined(); return JSON.parse(outcome.result!.content[0]!.text) as Record<string, any>; };
const failure = (outcome: Awaited<ReturnType<typeof call>>, status: number) => { expect(outcome.result?.isError, JSON.stringify(outcome)).toBe(true); const text = outcome.result!.content[0]!.text; expect(text).toMatch(new RegExp(`^HTTP ${status}:`)); return text; };
const viaCookie = async (who: string, method: string, path: string, payload?: unknown) => {
  const response = await SELF.fetch(`${h.ORIGIN}${path}`, { method, headers: { cookie: h.cookies[who]!, origin: h.ORIGIN, ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};
const base = `/api/projects/${project}`;

/** A Video of `count` Versions, older ones superseded as upload completion leaves them. */
async function film(count: number, title = "Hero") {
  const first = await seedVideoVersion({ title, filename: `${title}.mp4` });
  const all = [first];
  for (let version = 2; version <= count; version += 1) all.push(await seedVideoVersion({ projectId: first.projectId, videoId: first.videoId, version, filename: `${title}.mp4` }));
  for (let i = 0; i < all.length - 1; i += 1) await database.DB.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ? WHERE id = ?").bind(Date.now(), all[i + 1]!.assetId, all[i]!.assetId).run();
  return { videoId: first.videoId, assets: all.map((version) => version.assetId), latest: all[all.length - 1]!.assetId };
}
const auditSince = async (mark: number) => (await database.DB.prepare("SELECT action, meta_json FROM audit_log WHERE rowid > ? ORDER BY rowid").bind(mark).all<{ action: string; meta_json: string | null }>()).results;
const auditMark = async () => (await database.DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log").first<{ n: number }>())!.n;

describe("tools/list follows the role and the scopes", () => {
  it("Admin and Editor with write see all nine; an External editor sees the Version writes only; a Photographer none", async () => {
    expect(await listed("admin")).toEqual([...READS, ...WRITES].sort());
    expect(await listed("editor")).toEqual([...READS, ...WRITES].sort());
    expect(await listed("external")).toEqual(["rename_video_version", "set_version_review_status"]);
    expect(await listed("photographer")).toEqual([]);
  });
  it("a read-only grant lists the three reads and no write", async () => {
    expect(await listed("adminRead")).toEqual(READS);
    expect(await listed("editorRead")).toEqual(READS);
  });
  it("the writes sit under write, never admin", () => {
    expect(toolsFor("admin", ["admin"]).filter((tool) => WRITES.includes(tool.name))).toEqual([]);
    expect(toolsFor("admin", ["write"]).filter((tool) => WRITES.includes(tool.name)).map((tool) => tool.name).sort()).toEqual(WRITES);
    expect(toolsFor("admin", ["read"]).filter((tool) => READS.includes(tool.name)).map((tool) => tool.name).sort()).toEqual(READS);
  });
  it("annotates: delete and remove are destructive, nothing confirms, reads are read-only", () => {
    for (const tool of VIDEO_WRITE_TOOLS) {
      const read = READS.includes(tool.name);
      expect(tool.annotations.readOnlyHint, tool.name).toBe(read);
      if (!read) expect(tool.annotations.destructiveHint, tool.name).toBe(["delete_video", "remove_video_version"].includes(tool.name));
    }
    expect(TRASH_ONLY.every((name) => VIDEO_WRITE_TOOLS.find((tool) => tool.name === name)!.capability === "manageVideoTrash")).toBe(true);
  });
  it("there is no poster tool", () => { expect(VIDEO_WRITE_TOOLS.some((tool) => /poster/.test(tool.name))).toBe(false); });
});

describe("Review status and rename", () => {
  it("set_version_review_status returns what the cookie route returns, and an External editor may set In review only", async () => {
    const cut = await film(1);
    const set = json(await call("editor", "set_version_review_status", { projectId: project, assetId: cut.latest, reviewStatus: "approved_internal", expectedStatus: "in_review" }));
    expect(set.video.id).toBe(cut.videoId);
    const cookie = await viaCookie("editor", "PUT", `${base}/video-versions/${cut.latest}/review-status`, { reviewStatus: "approved_internal", expectedStatus: "approved_internal" });
    expect(cookie.status).toBe(200);
    expect(set).toEqual(cookie.body);
    // The route refuses the target status the role may not set, and the tool passes it through.
    failure(await call("external", "set_version_review_status", { projectId: project, assetId: cut.latest, reviewStatus: "approved_internal", expectedStatus: "approved_internal" }), 403);
    const back = json(await call("external", "set_version_review_status", { projectId: project, assetId: cut.latest, reviewStatus: "in_review", expectedStatus: "approved_internal" }));
    expect(back.video.versions.find((version: { assetId: string }) => version.assetId === cut.latest).reviewStatus).toBe("in_review");
  });
  it("a stale expectedStatus and a superseded Version surface the route's 409 codes", async () => {
    const cut = await film(2);
    expect(failure(await call("editor", "set_version_review_status", { projectId: project, assetId: cut.latest, reviewStatus: "approved_internal", expectedStatus: "approved_internal" }), 409)).toContain("review_status_conflict");
    expect(failure(await call("editor", "set_version_review_status", { projectId: project, assetId: cut.assets[0], reviewStatus: "approved_internal", expectedStatus: "in_review" }), 409)).toContain("not_latest_version");
  });
  it("rename_video_version returns the cookie route's Video, and refuses a name that is not .mp4 or .mov", async () => {
    const cut = await film(1);
    const renamed = json(await call("external", "rename_video_version", { projectId: project, assetId: cut.latest, filename: "Final cut.mp4" }));
    const cookie = await viaCookie("editor", "PUT", `${base}/video-versions/${cut.latest}/file-name`, { filename: "Final cut.mp4" });
    expect(cookie.status).toBe(200);
    expect(renamed).toEqual(cookie.body);
    failure(await call("editor", "rename_video_version", { projectId: project, assetId: cut.latest, filename: "notes.txt" }), 400);
    const old = await film(2);
    expect(failure(await call("editor", "rename_video_version", { projectId: project, assetId: old.assets[0], filename: "x.mp4" }), 409)).toContain("not_latest_version");
  });
  it("an External editor outside the Project gets the route's 404", async () => {
    const cut = await film(1);
    failure(await call("outsider", "rename_video_version", { projectId: project, assetId: cut.latest, filename: "x.mp4" }), 404);
  });
});

describe("Trash: impact, remove, list, restore", () => {
  it("impact reads match the cookie routes", async () => {
    const cut = await film(2);
    const version = json(await call("editor", "get_version_removal_impact", { projectId: project, assetId: cut.assets[0] }));
    expect(version).toEqual((await viaCookie("editor", "GET", `${base}/video-versions/${cut.assets[0]}/removal-impact`)).body);
    expect(version).toMatchObject({ lastVersion: false, notes: 0, release: false });
    const video = json(await call("admin", "get_video_removal_impact", { projectId: project, videoId: cut.videoId }));
    expect(video).toEqual((await viaCookie("admin", "GET", `${base}/videos/${cut.videoId}/removal-impact`)).body);
    expect(video.assetIds).toHaveLength(2);
  });
  it("remove a Version after reading its impact; it lands in the Trash list and restore brings it back", async () => {
    const cut = await film(2);
    const impact = json(await call("editor", "get_version_removal_impact", { projectId: project, assetId: cut.assets[0] }));
    const mark = await auditMark();
    const removed = json(await call("editor", "remove_video_version", { projectId: project, assetId: cut.assets[0], expected: { notes: impact.notes, decisions: impact.decisions, release: impact.release, links: impact.links.length }, removeVideo: impact.lastVersion }));
    expect(removed.video.versions.map((version: { assetId: string }) => version.assetId)).toEqual([cut.latest]);
    const trash = json(await call("editor", "list_video_trash", { projectId: project }));
    expect(trash).toEqual((await viaCookie("editor", "GET", `${base}/video-trash`)).body);
    expect(JSON.stringify(trash)).toContain(cut.assets[0]!);
    const restored = json(await call("editor", "restore_video_version", { projectId: project, assetId: cut.assets[0] }));
    expect(restored.video.versions.map((version: { assetId: string }) => version.assetId).sort()).toEqual([...cut.assets].sort());
    expect(JSON.stringify(json(await call("editor", "list_video_trash", { projectId: project })))).not.toContain(cut.assets[0]!);
    const rows = await auditSince(mark);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(JSON.parse(row.meta_json ?? "{}"), row.action).toMatchObject({ via: "mcp", client: "Test Client", connectionId: tokens.editor!.connectionId });
  });
  it("delete a Video and restore it; a changed Video is refused with the fresh impact", async () => {
    const cut = await film(2, "Teaser");
    const impact = json(await call("admin", "get_video_removal_impact", { projectId: project, videoId: cut.videoId }));
    const stale = await call("admin", "delete_video", { projectId: project, videoId: cut.videoId, expected: { assetIds: impact.assetIds, notes: 5, decisions: 0, releases: 0, links: 0 } });
    const text = failure(stale, 409);
    expect(text).toContain("impact_changed");
    expect(await database.DB.prepare("SELECT removed_at FROM videos WHERE id = ?").bind(cut.videoId).first<{ removed_at: number | null }>()).toMatchObject({ removed_at: null });
    const mark = await auditMark();
    const deleted = json(await call("admin", "delete_video", { projectId: project, videoId: cut.videoId, expected: { assetIds: impact.assetIds, notes: impact.notes, decisions: impact.decisions, releases: impact.releases, links: impact.links.length } }));
    expect(deleted).toEqual({ videoId: cut.videoId, versionCount: 2 });
    for (const row of await auditSince(mark)) expect(JSON.parse(row.meta_json ?? "{}"), row.action).toMatchObject({ via: "mcp", client: "Test Client" });
    expect(JSON.stringify(json(await call("admin", "list_video_trash", { projectId: project })))).toContain(cut.videoId);
    const restored = json(await call("admin", "restore_video", { projectId: project, videoId: cut.videoId }));
    expect(restored.video.id).toBe(cut.videoId);
    expect(restored.video.versions).toHaveLength(2);
  });
  it("removing the last Version needs removeVideo, as the route says", async () => {
    const cut = await film(1, "Solo");
    const text = failure(await call("editor", "remove_video_version", { projectId: project, assetId: cut.latest, expected: ZERO, removeVideo: false }), 409);
    expect(text).toContain("last_version");
    expect(json(await call("editor", "remove_video_version", { projectId: project, assetId: cut.latest, expected: ZERO, removeVideo: true })).video).toBeNull();
    json(await call("editor", "restore_video", { projectId: project, videoId: cut.videoId }));
  });
  it("restoring a Version whose Video is in Trash answers 409 video_in_trash", async () => {
    const cut = await film(2, "Both");
    const impact = json(await call("admin", "get_video_removal_impact", { projectId: project, videoId: cut.videoId }));
    json(await call("admin", "remove_video_version", { projectId: project, assetId: cut.assets[0], expected: ZERO, removeVideo: false }));
    json(await call("admin", "delete_video", { projectId: project, videoId: cut.videoId, expected: { assetIds: [cut.latest], notes: impact.notes, decisions: 0, releases: 0, links: 0 } }));
    expect(failure(await call("admin", "restore_video_version", { projectId: project, assetId: cut.assets[0] }), 409)).toContain("video_in_trash");
  });
  it("the Trash tools refuse what the route refuses: unknown keys, an External editor, and the gate being closed", async () => {
    const cut = await film(1, "Gate");
    const sneaky = await call("admin", "delete_video", { projectId: project, videoId: cut.videoId, expected: { assetIds: [cut.latest], notes: 0, decisions: 0, releases: 0, links: 0 }, sneaky: true });
    expect(sneaky.error !== undefined || sneaky.result?.isError === true).toBe(true);
    expect(await database.DB.prepare("SELECT removed_at FROM videos WHERE id = ?").bind(cut.videoId).first<{ removed_at: number | null }>()).toMatchObject({ removed_at: null });
    await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'video_review_trash'").run();
    try { failure(await call("editor", "list_video_trash", { projectId: project }), 404); }
    finally { await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'video_review_trash'").run(); }
  });
});
