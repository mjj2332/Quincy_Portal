import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { buildDownloadUrl, signDownload, type DownloadTarget } from "../src/mcp/download-signature";
import { MCP_TOOLS } from "../src/mcp/tools/registry";
import { mcpHarness } from "./mcp-oauth-support";

declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;
const testEnv = env as unknown as Env & { MEDIA: R2Bucket };
const h = mcpHarness(testEnv);
const DB = h.DB;

/** Signed downloads (#707): the issue tools, the /dl/* redemption routes and every way a URL must stop working. */
const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const ids = {
  editor: "e7070000-0000-4000-8000-000000000001", editor2: "e7070000-0000-4000-8000-000000000002",
  revoked: "e7070000-0000-4000-8000-000000000003", deactivated: "e7070000-0000-4000-8000-000000000004",
  bumped: "e7070000-0000-4000-8000-000000000005", flagged: "e7070000-0000-4000-8000-000000000006",
  bound: "e7070000-0000-4000-8000-000000000007",
};
const projectId = "c7070000-0000-4000-8000-000000000001";
const collectionId = "d7070000-0000-4000-8000-000000000001";
const assetId = "a7070000-0000-4000-8000-000000000001";
const otherAssetId = "a7070000-0000-4000-8000-000000000002";
const BYTES = "signed-download-asset-bytes";
const tokens: Record<string, { accessToken: string; connectionId: string }> = {};
const CLIENT = "Test Client";

beforeAll(async () => {
  await h.executeSql(__PORTAL_MIGRATION_SQL__); await h.executeSql(__PORTAL_SEED_SQL__);
  await DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'mcp_access'").run();
  for (const [name, id] of Object.entries(ids)) { await h.addUser(id, name === "editor2" ? "photographer" : "editor"); await h.addSession(name, id); } // editor2: an unassigned photographer, who cannot see the Project
  await h.addSession("admin", adminId);
  const now = Date.now();
  await DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Download Street', 'awaiting_raw', ?, ?)").bind(projectId, now, now).run();
  for (const [name, id] of Object.entries(ids)) if (name !== "editor2") await DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, id, now).run();
  await DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?)").bind(collectionId, projectId, now, now).run();
  for (const [id, key, name, body] of [[assetId, "mcp-dl/a.jpg", "a.jpg", BYTES], [otherAssetId, "mcp-dl/b.jpg", "b.jpg", "other-bytes"]] as const) {
    await testEnv.MEDIA.put(key, body, { httpMetadata: { contentType: "image/jpeg" } });
    await DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'upload', ?, ?)").bind(id, collectionId, key, name, body.length, now, now).run();
  }
  for (const name of Object.keys(ids)) tokens[name] = await h.connect("read", name);
  tokens.admin = await h.connect("read", "admin");
});

const call = (who: string, name: string, args: unknown = {}) => h.callTool(tokens[who]!.accessToken, name, args);
const plain = (result?: { content: { text: string }[] }) => result!.content[0]!.text;
type Issued = { url: string; expiresAt: string };
async function issueAsset(who: string, variant = "original", id = assetId): Promise<Issued> {
  const outcome = await call(who, "get_asset_download_url", { assetId: id, variant });
  expect(outcome.error, JSON.stringify(outcome)).toBeUndefined();
  expect(outcome.result?.isError, plain(outcome.result)).toBeUndefined();
  return JSON.parse(plain(outcome.result)) as Issued;
}
async function issueZip(who: string, assetIds = [assetId]): Promise<Issued> {
  const outcome = await call(who, "get_selection_download_url", { projectId, assetIds });
  expect(outcome.error, JSON.stringify(outcome)).toBeUndefined();
  expect(outcome.result?.isError, plain(outcome.result)).toBeUndefined();
  return JSON.parse(plain(outcome.result)) as Issued;
}
const redeem = (url: string, init?: RequestInit) => SELF.fetch(url, { redirect: "manual", ...init });
const withParam = (url: string, key: string, value: string) => { const u = new URL(url); u.searchParams.set(key, value); return u.href; };
async function claimsFor(who: string, target: DownloadTarget, exp: number) {
  const user = await DB.prepare("SELECT authorization_epoch AS epoch FROM user WHERE id = ?").bind(ids[who as keyof typeof ids]).first<{ epoch: number }>();
  const claims = { target, exp, userId: ids[who as keyof typeof ids], authorizationEpoch: user!.epoch, connectionId: tokens[who]!.connectionId };
  return { claims, url: buildDownloadUrl(testEnv.APP_ORIGIN, claims, await signDownload(testEnv.MCP_DOWNLOAD_SECRET!, claims)) };
}
const nowSec = () => Math.floor(Date.now() / 1000);
type AuditRow = { action: string; target_id: string | null; meta_json: string | null };
const auditRows = async (action: string, target: string) => (await DB.prepare("SELECT action, target_id, meta_json FROM audit_log WHERE action = ? AND target_id = ? ORDER BY rowid").bind(action, target).all<AuditRow>()).results;

describe("the issue tools", () => {
  it("are read-scope, read-only tools", () => {
    for (const name of ["get_asset_download_url", "get_selection_download_url"]) {
      const tool = MCP_TOOLS.find((candidate) => candidate.name === name)!;
      expect(tool.scope).toBe("read"); expect(tool.annotations.readOnlyHint).toBe(true);
    }
  });
  it("return a /dl/asset url that expires within 15 minutes", async () => {
    const before = Date.now();
    const issued = await issueAsset("editor");
    expect(issued.url.startsWith(`${testEnv.APP_ORIGIN}/dl/asset/${assetId}/original?`)).toBe(true);
    expect([...new URL(issued.url).searchParams.keys()].sort()).toEqual(["c", "e", "exp", "sig", "u"]);
    const expiresAt = Date.parse(issued.expiresAt);
    expect(expiresAt).toBeGreaterThan(before); expect(expiresAt - before).toBeLessThanOrEqual(15 * 60_000 + 1000);
    expect(Number(new URL(issued.url).searchParams.get("exp"))).toBe(Math.floor(expiresAt / 1000));
  });
  it("refuse an asset this user cannot see, and never sign it", async () => {
    const outcome = await call("editor2", "get_asset_download_url", { assetId, variant: "original" });
    expect(outcome.result?.isError).toBe(true); expect(plain(outcome.result)).toMatch(/^HTTP 403:/); expect(plain(outcome.result)).not.toContain("/dl/");
    const missing = await call("editor", "get_asset_download_url", { assetId: crypto.randomUUID(), variant: "original" });
    expect(missing.result?.isError).toBe(true);
  });
  it("write an mcp_download.issue audit row carrying via and client", async () => {
    await issueAsset("admin");
    const [row] = await auditRows("mcp_download.issue", assetId);
    expect(row).toBeDefined();
    expect(JSON.parse(row!.meta_json!)).toMatchObject({ via: "mcp", client: CLIENT, variant: "original" });
  });
});

describe("redeeming an asset url", () => {
  it("streams the asset bytes with no cookie, and audits mcp_download.redeem", async () => {
    const issued = await issueAsset("editor");
    const response = await redeem(issued.url);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(BYTES);
    const rows = await auditRows("mcp_download.redeem", assetId);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.parse(rows.at(-1)!.meta_json!)).toMatchObject({ via: "mcp", client: CLIENT });
  });
  it("answers 403 to a tampered sig, assetId, variant, exp, user, connection or epoch", async () => {
    const issued = await issueAsset("editor");
    const u = new URL(issued.url);
    const sig = u.searchParams.get("sig")!;
    const flipped = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    expect((await redeem(withParam(issued.url, "sig", flipped))).status).toBe(403);
    expect((await redeem(issued.url.replace(`/asset/${assetId}/`, `/asset/${otherAssetId}/`))).status).toBe(403);
    expect((await redeem(issued.url.replace("/original?", "/web?"))).status).toBe(403);
    expect((await redeem(withParam(issued.url, "exp", String(Number(u.searchParams.get("exp")) + 60)))).status).toBe(403);
    expect((await redeem(withParam(issued.url, "u", ids.editor2))).status).toBe(403);
    expect((await redeem(withParam(issued.url, "c", tokens.editor2!.connectionId))).status).toBe(403);
    expect((await redeem(withParam(issued.url, "e", "99"))).status).toBe(403);
  });
  it("answers 403 to a missing signature, an extra parameter or a cookie-only request", async () => {
    const issued = await issueAsset("editor");
    const bare = `${testEnv.APP_ORIGIN}/dl/asset/${assetId}/original`;
    expect((await redeem(bare, { headers: { cookie: h.cookies.editor! } })).status).toBe(403);
    expect((await redeem(bare)).status).toBe(403);
    expect((await redeem(withParam(issued.url, "extra", "1"))).status).toBe(403);
    expect((await redeem(issued.url, { headers: { cookie: h.cookies.editor2! } })).status).toBe(200); // a cookie neither helps nor hurts: the grant decides
  });
  it("answers 410 to an expired url that is otherwise validly signed", async () => {
    const { url } = await claimsFor("editor", { kind: "asset", assetId, variant: "original" }, nowSec() - 5);
    expect((await redeem(url)).status).toBe(410);
  });
  it("answers 403 to a validly signed url that expires more than 15 minutes out", async () => {
    const { url } = await claimsFor("editor", { kind: "asset", assetId, variant: "original" }, nowSec() + 3600);
    expect((await redeem(url)).status).toBe(403);
  });
  it("answers 403 when the signed user can no longer see the asset", async () => {
    const { url } = await claimsFor("editor2", { kind: "asset", assetId, variant: "original" }, nowSec() + 300);
    expect((await redeem(url)).status).toBe(403);
  });
});

describe("redemption re-checks the grant", () => {
  it("revoked connection", async () => {
    const issued = await issueAsset("revoked");
    expect((await redeem(issued.url)).status).toBe(200);
    await DB.prepare("UPDATE mcp_connections SET revoked_at = ? WHERE id = ?").bind(Date.now(), tokens.revoked!.connectionId).run();
    expect((await redeem(issued.url)).status).toBe(403);
  });
  it("deactivated user", async () => {
    const issued = await issueAsset("deactivated");
    await DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(ids.deactivated).run();
    expect((await redeem(issued.url)).status).toBe(403);
  });
  it("authorization epoch bump", async () => {
    const issued = await issueAsset("bumped");
    await DB.prepare("UPDATE user SET authorization_epoch = authorization_epoch + 1 WHERE id = ?").bind(ids.bumped).run();
    expect((await redeem(issued.url)).status).toBe(403);
  });
  it("mcp_access flag turned off", async () => {
    const issued = await issueAsset("flagged");
    expect((await redeem(issued.url)).status).toBe(200);
    await DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'mcp_access'").run();
    try { expect((await redeem(issued.url)).status).toBe(403); }
    finally { await DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'mcp_access'").run(); }
    expect((await redeem(issued.url)).status).toBe(200);
  });
});

describe("selection zips", () => {
  it("creates a ticket as the user and the url streams a zip", async () => {
    const issued = await issueZip("editor");
    expect(issued.url.startsWith(`${testEnv.APP_ORIGIN}/dl/zip/${projectId}/`)).toBe(true);
    const response = await redeem(issued.url);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("application/zip");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    expect(new TextDecoder().decode(bytes)).toContain(BYTES);
    const ticket = new URL(issued.url).pathname.split("/").pop()!;
    const row = await DB.prepare("SELECT user_id FROM download_selection_tickets WHERE id = ?").bind(ticket).first<{ user_id: string }>();
    expect(row?.user_id).toBe(ids.editor);
    expect((await auditRows("mcp_download.issue", projectId)).length).toBeGreaterThan(0);
    expect(JSON.parse((await auditRows("mcp_download.redeem", projectId)).at(-1)!.meta_json!)).toMatchObject({ via: "mcp", client: CLIENT });
  });
  it("keeps the ticket bound to the user: another member's signature over it gets nothing", async () => {
    const issued = await issueZip("editor");
    const ticket = new URL(issued.url).pathname.split("/").pop()!;
    const { url } = await claimsFor("bound", { kind: "zip", projectId, ticket }, nowSec() + 200);
    expect((await redeem(url)).status).toBe(403);
  });
  it("refuses to issue for a selection the user cannot download", async () => {
    const outcome = await call("editor2", "get_selection_download_url", { projectId, assetIds: [assetId] });
    expect(outcome.result?.isError).toBe(true); expect(plain(outcome.result)).not.toContain("/dl/");
  });
  it("answers 403 to a tampered ticket", async () => {
    const issued = await issueZip("editor");
    expect((await redeem(issued.url.replace(/[0-9a-f]\?/, (m) => (m[0] === "0" ? "1" : "0") + "?"))).status).toBe(403);
  });
});

describe("renditions are served from storage only", () => {
  it("a cold web variant is refused at issue and answers 409 at redemption, with no Location", async () => {
    const outcome = await call("editor", "get_asset_download_url", { assetId: otherAssetId, variant: "web" });
    expect(outcome.result?.isError).toBe(true);
    expect(plain(outcome.result)).toContain("This size isn't ready yet; request variant 'original' or try again later");
    expect(plain(outcome.result)).not.toContain("/dl/");
    const { url } = await claimsFor("editor", { kind: "asset", assetId: otherAssetId, variant: "web" }, nowSec() + 300);
    const response = await redeem(url);
    expect(response.status).toBe(409); expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toEqual({ error: "rendition_not_ready" });
  });
  it("a warm stored rendition streams", async () => {
    await testEnv.MEDIA.put("mcp-dl/a-thumb.webp", "stored-thumb-bytes", { httpMetadata: { contentType: "image/webp" } });
    await DB.prepare("INSERT INTO asset_renditions (id, asset_id, variant, r2_key, bytes, content_type, width, height, spec_version, created_at) VALUES (?, ?, 'thumb', 'mcp-dl/a-thumb.webp', 18, 'image/webp', 1, 1, 'v1', ?)").bind(crypto.randomUUID(), assetId, Date.now()).run();
    const issued = await issueAsset("editor", "thumb");
    const response = await redeem(issued.url);
    expect(response.status).toBe(200); expect(response.headers.get("location")).toBeNull();
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("stored-thumb-bytes");
  });
  it("no /dl response ever carries a Location header", async () => {
    const issued = await issueAsset("editor");
    const cold = await claimsFor("editor", { kind: "asset", assetId: otherAssetId, variant: "thumb" }, nowSec() + 300);
    for (const url of [issued.url, cold.url, withParam(issued.url, "sig", "0".repeat(64)), `${testEnv.APP_ORIGIN}/dl/asset/${assetId}/web`, `${testEnv.APP_ORIGIN}/dl/nope`]) {
      const response = await redeem(url);
      expect(response.headers.get("location"), url).toBeNull(); await response.body?.cancel();
    }
  });
});

describe("zip lifetime and provenance", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("an MCP zip ticket and URL last 15 minutes: still streams at 6 minutes, 410 past 15", async () => {
    const issued = await issueZip("editor");
    const exp = Number(new URL(issued.url).searchParams.get("exp"));
    expect(exp - nowSec()).toBeGreaterThan(14 * 60); expect(exp - nowSec()).toBeLessThanOrEqual(15 * 60);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 6 * 60_000);
    const later = await redeem(issued.url);
    expect(later.status).toBe(200); await later.body?.cancel();
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect((await redeem(issued.url)).status).toBe(410);
  });
  it("a cookie user's ticket keeps its 5 minutes", async () => {
    const response = await SELF.fetch(`${h.ORIGIN}/api/projects/${projectId}/download-selection`, { method: "POST", headers: { cookie: h.cookies.editor!, origin: h.ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ assetIds: [assetId] }) });
    expect(response.status).toBe(201);
    const ticket = ((await response.json()) as { downloadUrl: string }).downloadUrl.split("/").at(-2)!;
    const row = await DB.prepare("SELECT expires_at, created_at FROM download_selection_tickets WHERE id = ?").bind(ticket).first<{ expires_at: number; created_at: number }>();
    expect(row!.expires_at - row!.created_at).toBe(5 * 60_000);
  });
  it("project.download_selection and mcp_download.redeem both carry via: mcp, client and the connection", async () => {
    const issued = await issueZip("admin");
    const response = await redeem(issued.url); expect(response.status).toBe(200); await response.arrayBuffer();
    const rows = await DB.prepare("SELECT action, meta_json FROM audit_log WHERE target_id = ? AND action IN ('project.download_selection','mcp_download.redeem') AND actor_id = ? ORDER BY rowid DESC").bind(projectId, adminId).all<{ action: string; meta_json: string }>();
    for (const action of ["project.download_selection", "mcp_download.redeem"]) {
      const row = rows.results.find((r) => r.action === action);
      expect(row, action).toBeDefined();
      expect(JSON.parse(row!.meta_json), action).toMatchObject({ via: "mcp", client: CLIENT, connectionId: tokens.admin!.connectionId });
    }
  });
});
