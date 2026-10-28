import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { toolsFor } from "../src/mcp/tools/registry";
import { database, ids, seedFixture } from "./embedded-media-support";
import { mcpHarness } from "./mcp-oauth-support";
import { clearVideoFlags, seedVideoNote, seedVideoVersion, setVideoFlags } from "./video-review-support";

/**
 * Staff video downloads through /mcp (#972): tools/list per role and scope, a signed link that serves the same file and headers as the browser's
 * download or export, an audit row per redemption marked as through MCP, and every way an issued link must stop working.
 */
const testEnv = env as unknown as Env;
const h = mcpHarness(testEnv);
const DB = database.DB;
const TOOLS = ["get_marker_export_download_url", "get_video_version_download_url"];
const OPEN = ["video_review", "video_review_all_projects", "video_review_notes", "video_review_export", "video_review_download"] as const;
const CLIENT = "Test Client";
const project = ids.project;
const bumpedId = "a7777777-7777-4777-8777-777777777777";
const tokens: Record<string, { accessToken: string; connectionId: string }> = {};
let film: { videoId: string; v1: string; v2: string };

beforeAll(async () => {
  await seedFixture();
  await DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'mcp_access'").run();
  await h.addUser(bumpedId, "editor");
  await DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), project, bumpedId, Date.now()).run();
  for (const [name, id] of [["admin", ids.admin], ["editor", ids.member], ["photographer", ids.photographer], ["external", ids.external], ["outsider", ids.externalOutsider], ["bumped", bumpedId]] as const) await h.addSession(name, id);
  for (const [name, who, scope] of [
    ["admin", "admin", "read write admin"], ["adminRead", "admin", "read"], ["editor", "editor", "read"], ["revoked", "editor", "read"],
    ["photographer", "photographer", "read"], ["external", "external", "read"], ["outsider", "outsider", "read"], ["bumped", "bumped", "read"],
  ] as const) tokens[name] = await h.connect(scope, who);
  const v1 = await seedVideoVersion({ title: "Hero Film" });
  const v2 = await seedVideoVersion({ projectId: v1.projectId, videoId: v1.videoId, version: 2 });
  film = { videoId: v1.videoId, v1: v1.assetId, v2: v2.assetId };
  await seedVideoNote({ assetId: v2.assetId, startFrame: 10, endFrame: 40, body: "Lift the shadows" });
  await seedVideoNote({ assetId: v2.assetId, visibility: "internal", startFrame: 100, body: "Internal: check the licence" });
});
beforeEach(async () => {
  delete (testEnv as { MCP_CALLS?: unknown }).MCP_CALLS; delete (testEnv as { MCP_WRITES?: unknown }).MCP_WRITES;
  await clearVideoFlags(); await setVideoFlags(...OPEN);
});
afterEach(() => { vi.useRealTimers(); });

const call = (who: string, name: string, args: Record<string, unknown>) => h.callTool(tokens[who]!.accessToken, name, args);
const text = (outcome: Awaited<ReturnType<typeof call>>) => outcome.result!.content[0]!.text;
type Issued = { url: string; expiresAt: string };
async function issue(who: string, name: string, args: Record<string, unknown>): Promise<Issued> {
  const outcome = await call(who, name, args);
  expect(outcome.error, JSON.stringify(outcome)).toBeUndefined();
  expect(outcome.result?.isError, text(outcome)).toBeUndefined();
  return JSON.parse(text(outcome)) as Issued;
}
const issueVersion = (who: string, assetId = film.v2) => issue(who, "get_video_version_download_url", { projectId: project, assetId });
const issueExport = (who: string, extra: Record<string, unknown> = {}) => issue(who, "get_marker_export_download_url", { projectId: project, assetId: film.v2, format: "fcpxml", ...extra });
const redeem = (url: string) => SELF.fetch(url, { redirect: "manual" });
const cookieGet = (who: string, path: string) => SELF.fetch(`${h.ORIGIN}${path}`, { headers: { cookie: h.cookies[who]! } });
const versionPath = (assetId: string) => `/api/projects/${project}/video-versions/${assetId}/download`;
const exportPath = (query: string) => `/api/projects/${project}/video-versions/${film.v2}/marker-export?${query}`;
const mark = async () => (await DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS id FROM audit_log").first<{ id: number }>())!.id;
const auditSince = async (since: number) => (await DB.prepare("SELECT action, actor_id, target_id, meta_json FROM audit_log WHERE rowid > ? ORDER BY rowid").bind(since).all<{ action: string; actor_id: string; target_id: string; meta_json: string }>()).results;
const SAME_HEADERS = ["content-type", "content-disposition", "content-length", "cache-control", "x-content-type-options"];

describe("tools/list shows the video download tools to roles that can download video, under read", () => {
  const listed = async (who: string) => (await h.toolsList(tokens[who]!.accessToken)).map((tool) => tool.name).filter((name) => TOOLS.includes(name)).sort();
  it("Admin, Editor and External editor see both; a Photographer sees neither", async () => {
    for (const who of ["admin", "adminRead", "editor", "external", "outsider"]) expect(await listed(who), who).toEqual(TOOLS);
    expect(await listed("photographer")).toEqual([]);
  });
  it("only the read scope carries them, and both are read-only", async () => {
    expect(toolsFor("admin", ["write", "admin"]).filter((tool) => TOOLS.includes(tool.name))).toEqual([]);
    const tools = (await h.toolsList(tokens.editor!.accessToken)).filter((tool) => TOOLS.includes(tool.name));
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });
  it("a Photographer calling one is refused", async () => {
    const outcome = await call("photographer", "get_video_version_download_url", { projectId: project, assetId: film.v2 });
    expect(outcome.error !== undefined || outcome.result?.isError === true).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("/dl/");
  });
});

describe("get_video_version_download_url", () => {
  it("issues a 15-minute /dl/video-version link without downloading anything", async () => {
    const since = await mark();
    const before = Date.now();
    const issued = await issueVersion("editor");
    expect(issued.url.startsWith(`${testEnv.APP_ORIGIN}/dl/video-version/${project}/${film.v2}?`)).toBe(true);
    expect([...new URL(issued.url).searchParams.keys()].sort()).toEqual(["c", "e", "exp", "sig", "u"]);
    expect(Date.parse(issued.expiresAt) - before).toBeLessThanOrEqual(15 * 60_000 + 1000);
    const rows = await auditSince(since);
    expect(rows.map((row) => row.action)).toEqual(["mcp_download.issue"]);
    expect(JSON.parse(rows[0]!.meta_json)).toMatchObject({ via: "mcp", client: CLIENT, projectId: project, connectionId: tokens.editor!.connectionId });
  });
  it("redeems to the same bytes and headers as the browser download, and audits video_version.download as through MCP", async () => {
    const cookie = await cookieGet("editor", versionPath(film.v2));
    expect(cookie.status).toBe(200);
    const cookieBytes = new Uint8Array(await cookie.arrayBuffer());
    const issued = await issueVersion("editor");
    const since = await mark();
    const response = await redeem(issued.url);
    expect(response.status).toBe(200);
    for (const name of SAME_HEADERS) expect(response.headers.get(name), name).toBe(cookie.headers.get(name));
    expect(response.headers.get("content-disposition")).toMatch(/attachment/);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(cookieBytes);
    const rows = await auditSince(since);
    const download = rows.filter((row) => row.action === "video_version.download");
    expect(download).toHaveLength(1);
    expect(download[0]!.target_id).toBe(film.v2); expect(download[0]!.actor_id).toBe(ids.member);
    expect(JSON.parse(download[0]!.meta_json)).toMatchObject({ via: "mcp", client: CLIENT, connectionId: tokens.editor!.connectionId, projectId: project, version: 2 });
    expect(rows.some((row) => row.action === "mcp_download.redeem")).toBe(true);
  });
  it("downloads a superseded Version too", async () => {
    const response = await redeem((await issueVersion("external", film.v1)).url);
    expect(response.status).toBe(200); await response.arrayBuffer();
  });
  it("refuses, and signs nothing, for an External outside the Project, an unknown Version or a closed download gate", async () => {
    const outsider = await call("outsider", "get_video_version_download_url", { projectId: project, assetId: film.v2 });
    expect(outsider.result?.isError).toBe(true); expect(text(outsider)).toMatch(/^HTTP 404:/); expect(text(outsider)).not.toContain("/dl/");
    const unknown = await call("editor", "get_video_version_download_url", { projectId: project, assetId: crypto.randomUUID() });
    expect(unknown.result?.isError).toBe(true); expect(text(unknown)).toMatch(/^HTTP 404:/);
    await clearVideoFlags(); await setVideoFlags("video_review", "video_review_all_projects", "video_review_notes");
    const closed = await call("editor", "get_video_version_download_url", { projectId: project, assetId: film.v2 });
    expect(closed.result?.isError).toBe(true); expect(text(closed)).toMatch(/^HTTP 404:/);
  });
});

describe("get_marker_export_download_url", () => {
  it("issues a link whose options are in the path, and exports nothing until redeemed", async () => {
    const since = await mark();
    const issued = await issueExport("editor", { includeInternal: true, status: "open" });
    expect(issued.url.startsWith(`${testEnv.APP_ORIGIN}/dl/marker-export/${project}/${film.v2}/fcpxml/true/open?`)).toBe(true);
    expect([...new URL(issued.url).searchParams.keys()].sort()).toEqual(["c", "e", "exp", "sig", "u"]);
    expect((await auditSince(since)).map((row) => row.action)).toEqual(["mcp_download.issue"]);
  });
  for (const [format, includeInternal, status] of [["fcpxml", true, "all"], ["edl", false, "open"]] as const) {
    it(`redeems a ${format} export to the same file and headers as the browser, audited as video_note.export through MCP`, async () => {
      const cookie = await cookieGet("editor", exportPath(`format=${format}&includeInternal=${includeInternal}&status=${status}`));
      expect(cookie.status).toBe(200);
      const cookieText = await cookie.text();
      const issued = await issueExport("editor", { format, includeInternal, status });
      const since = await mark();
      const response = await redeem(issued.url);
      expect(response.status).toBe(200);
      for (const name of [...SAME_HEADERS, "x-marker-count"]) expect(response.headers.get(name), name).toBe(cookie.headers.get(name));
      expect(await response.text()).toBe(cookieText);
      const exported = (await auditSince(since)).filter((row) => row.action === "video_note.export");
      expect(exported).toHaveLength(1);
      expect(JSON.parse(exported[0]!.meta_json)).toMatchObject({ via: "mcp", client: CLIENT, connectionId: tokens.editor!.connectionId, format, includeInternal, status });
    });
  }
  it("defaults to public notes of every status", async () => {
    const issued = await issueExport("editor");
    expect(new URL(issued.url).pathname).toBe(`/dl/marker-export/${project}/${film.v2}/fcpxml/false/all`);
    const response = await redeem(issued.url);
    expect(await response.text()).not.toContain("check the licence");
  });
  it("reports a note outside the Version as an error, and signs nothing", async () => {
    const outside = await seedVideoVersion({ projectId: project, title: "Short" });
    await seedVideoNote({ assetId: outside.assetId, startFrame: 10 });
    await DB.prepare("UPDATE video_version_meta SET frame_count = 5 WHERE asset_id = ?").bind(outside.assetId).run();
    const outcome = await call("editor", "get_marker_export_download_url", { projectId: project, assetId: outside.assetId, format: "edl" });
    expect(outcome.result?.isError).toBe(true); expect(text(outcome)).toMatch(/^HTTP 422:/); expect(text(outcome)).not.toContain("/dl/");
  });
  it("is refused when the export gate is closed", async () => {
    await clearVideoFlags(); await setVideoFlags("video_review", "video_review_all_projects", "video_review_notes", "video_review_download");
    const outcome = await call("editor", "get_marker_export_download_url", { projectId: project, assetId: film.v2, format: "fcpxml" });
    expect(outcome.result?.isError).toBe(true); expect(text(outcome)).toMatch(/^HTTP 404:/);
  });
  it("rejects an unknown option at the schema", async () => {
    const outcome = await call("editor", "get_marker_export_download_url", { projectId: project, assetId: film.v2, format: "xml" });
    expect(outcome.error !== undefined || outcome.result?.isError === true).toBe(true);
  });
});

describe("an issued link stops working", () => {
  const both = async (who: string) => [(await issueVersion(who)).url, (await issueExport(who)).url];
  it("tampered: another Version, another export option or a flipped signature is 403", async () => {
    const [version, exported] = await both("editor");
    expect((await redeem(version!.replace(`/${film.v2}?`, `/${film.v1}?`))).status).toBe(403);
    expect((await redeem(exported!.replace("/fcpxml/false/all?", "/fcpxml/true/all?"))).status).toBe(403);
    expect((await redeem(exported!.replace("/fcpxml/false/all?", "/edl/false/all?"))).status).toBe(403);
    expect((await redeem(exported!.replace("/fcpxml/false/all?", "/fcpxml/maybe/all?"))).status).toBe(403);
    const u = new URL(version!); const sig = u.searchParams.get("sig")!; u.searchParams.set("sig", sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0"));
    expect((await redeem(u.href)).status).toBe(403);
    const extra = new URL(exported!); extra.searchParams.set("format", "edl");
    expect((await redeem(extra.href)).status).toBe(403);
  });
  it("expired: 410", async () => {
    const [version, exported] = await both("editor");
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 16 * 60_000);
    for (const url of [version!, exported!]) expect((await redeem(url)).status).toBe(410);
  });
  it("the app revoked: 403", async () => {
    const [version, exported] = await both("revoked");
    await DB.prepare("UPDATE mcp_connections SET revoked_at = ? WHERE id = ?").bind(Date.now(), tokens.revoked!.connectionId).run();
    for (const url of [version!, exported!]) expect((await redeem(url)).status).toBe(403);
  });
  it("an authorization epoch bump: 403", async () => {
    const [version, exported] = await both("bumped");
    await DB.prepare("UPDATE user SET authorization_epoch = authorization_epoch + 1 WHERE id = ?").bind(bumpedId).run();
    for (const url of [version!, exported!]) expect((await redeem(url)).status).toBe(403);
  });
  it("mcp_access off: 403, and nothing is audited", async () => {
    const [version, exported] = await both("adminRead");
    await DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'mcp_access'").run();
    try {
      const since = await mark();
      for (const url of [version!, exported!]) expect((await redeem(url)).status).toBe(403);
      expect(await auditSince(since)).toEqual([]);
    } finally { await DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'mcp_access'").run(); }
    const response = await redeem(version!); expect(response.status).toBe(200); await response.arrayBuffer();
  });
  it("the gate closed after issue: 403", async () => {
    const [version, exported] = await both("editor");
    await clearVideoFlags();
    for (const url of [version!, exported!]) expect((await redeem(url)).status).toBe(403);
  });
});
