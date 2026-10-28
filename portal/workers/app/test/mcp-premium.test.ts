import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { toolsFor } from "../src/mcp/tools/registry";
import { PREMIUM_TOOLS } from "../src/mcp/tools/premium";
import { signConfirmToken } from "../src/mcp/confirm-token";
import { database, ids, seedFixture } from "./embedded-media-support";
import { mcpHarness } from "./mcp-oauth-support";
import { seedVideoVersion, setVideoFlags } from "./video-review-support";
import { openDelivery, seedAsset, seedPage } from "./delivery-support";

/** Premium and Unlock through /mcp (#969): visibility, parity with the cookie routes, late Premium's confirm: true, and Unlock's confirm token. */
const testEnv = env as unknown as Env;
const h = mcpHarness(testEnv);
const PREMIUM = [
  "set_asset_premium", "set_asset_premium_unlock",
  "set_delivery_video_premium", "set_delivery_video_premium_unlock",
  "set_video_premium", "set_video_premium_unlock",
];
const tokens: Record<string, { accessToken: string; connectionId: string }> = {};
const project = ids.project;
let setId = "";

beforeAll(async () => {
  await seedFixture();
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'mcp_access'").run();
  await setVideoFlags("video_review", "video_review_all_projects", "video_review_delivery");
  await openDelivery(project);
  for (const [name, id] of [["admin", ids.admin], ["editor", ids.member], ["photographer", ids.photographer], ["external", ids.external]] as const) await h.addSession(name, id);
  for (const [name, who, scope] of [["admin", "admin", "read write admin"], ["editor", "editor", "read write"], ["editorRead", "editor", "read"], ["photographer", "photographer", "read write"], ["external", "external", "read write"]] as const) tokens[name] = await h.connect(scope, who);
  const placeholder = await seedAsset("photo");
  await seedPage({ assetIds: [placeholder.id] });
  setId = (await database.DB.prepare("SELECT id FROM delivery_sets WHERE project_id = ?").bind(project).first<{ id: string }>())!.id;
});
beforeEach(() => { delete (testEnv as { MCP_CALLS?: unknown }).MCP_CALLS; delete (testEnv as { MCP_WRITES?: unknown }).MCP_WRITES; });

/** Puts an Asset (a photo, or a Video's Version) into the Project's published set. */
const publish = async (assetId: string) => {
  await database.DB.prepare("INSERT INTO delivery_set_items (set_id, asset_id, handle, position) VALUES (?, ?, ?, 99)").bind(setId, assetId, crypto.randomUUID().replaceAll("-", "").slice(0, 16)).run();
};
const photo = async (input: { premium?: boolean; published?: boolean } = {}) => { const asset = await seedAsset("photo", { deliveryPremium: input.premium }); if (input.published) await publish(asset.id); return asset.id; };
const film = async (input: { premium?: boolean; published?: boolean } = {}) => {
  const version = await seedVideoVersion({ title: "Hero film" });
  if (input.premium) await database.DB.prepare("UPDATE videos SET premium = 1 WHERE id = ?").bind(version.videoId).run();
  if (input.published) await publish(version.assetId);
  return version.videoId;
};

const call = (who: string, name: string, args: Record<string, unknown>) => h.callTool(tokens[who]!.accessToken, name, args);
const textOf = (outcome: Awaited<ReturnType<typeof call>>) => outcome.result!.content[0]!.text;
const ok = (outcome: Awaited<ReturnType<typeof call>>) => { expect(outcome.result?.isError, outcome.result?.content[0]?.text).toBeUndefined(); return JSON.parse(textOf(outcome)) as Record<string, unknown>; };
const cookiePut = async (who: string, path: string, body: unknown) => {
  const response = await SELF.fetch(`${h.ORIGIN}${path}`, { method: "PUT", headers: { cookie: h.cookies[who]!, origin: h.ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const videoPremium = async (videoId: string) => (await database.DB.prepare("SELECT premium FROM videos WHERE id = ?").bind(videoId).first<{ premium: number }>())!.premium === 1;
const assetPremium = async (assetId: string) => (await database.DB.prepare("SELECT delivery_premium AS p FROM assets WHERE id = ?").bind(assetId).first<{ p: number }>())!.p === 1;
const videoUnlocked = async (videoId: string) => Boolean(await database.DB.prepare("SELECT 1 FROM video_premium_unlocks WHERE video_id = ?").bind(videoId).first());
const assetUnlocked = async (assetId: string) => Boolean(await database.DB.prepare("SELECT 1 FROM asset_premium_unlocks WHERE asset_id = ?").bind(assetId).first());
const tokenOf = (text: string) => /"confirmToken":\s*"([^"]+)"/.exec(text)![1]!;

/** The three surfaces: each pairs a premium tool and its unlock tool with the cookie routes they wrap. */
const SURFACES = [
  { label: "Video review", premiumTool: "set_video_premium", unlockTool: "set_video_premium_unlock", key: "videoId", seed: film, path: (id: string) => `/api/projects/${project}/videos/${id}/premium`, isPremium: videoPremium, isUnlocked: videoUnlocked },
  { label: "Delivery tab", premiumTool: "set_delivery_video_premium", unlockTool: "set_delivery_video_premium_unlock", key: "videoId", seed: film, path: (id: string) => `/api/projects/${project}/delivery/videos/${id}/premium`, isPremium: videoPremium, isUnlocked: videoUnlocked },
  { label: "photo", premiumTool: "set_asset_premium", unlockTool: "set_asset_premium_unlock", key: "assetId", seed: photo, path: (id: string) => `/api/projects/${project}/assets/${id}/delivery-premium`, isPremium: assetPremium, isUnlocked: assetUnlocked },
] as const;

describe("tools/list shows the premium tools to Admins and Editors, under write", () => {
  it("Admin and Editor see all six; Photographer and External editor none; a read-only grant none", async () => {
    const listed = async (who: string) => (await h.toolsList(tokens[who]!.accessToken)).map((tool) => tool.name).filter((name) => PREMIUM.includes(name)).sort();
    expect(await listed("admin")).toEqual(PREMIUM);
    expect(await listed("editor")).toEqual(PREMIUM);
    expect(await listed("photographer")).toEqual([]);
    expect(await listed("external")).toEqual([]);
    expect(await listed("editorRead")).toEqual([]);
  });
  it("all are write-scope writes, none admin-scope", () => {
    expect(PREMIUM_TOOLS.map((tool) => tool.name).sort()).toEqual(PREMIUM);
    expect(PREMIUM_TOOLS.every((tool) => tool.scope === "write" && tool.annotations.readOnlyHint === false)).toBe(true);
    expect(toolsFor("admin", ["admin"]).some((tool) => PREMIUM.includes(tool.name))).toBe(false);
  });
});

describe.each(SURFACES)("$label premium", (surface) => {
  it("marks and unmarks an unpublished item, as the cookie route does", async () => {
    const [mine, twin] = [await surface.seed(), await surface.seed()];
    const tool = ok(await call("editor", surface.premiumTool, { projectId: project, [surface.key]: mine, premium: true }));
    const cookie = await cookiePut("editor", surface.path(twin), { premium: true });
    expect(cookie.status).toBe(200);
    expect(tool).toEqual(cookie.body);
    expect(tool).toEqual({ premium: true, premiumUnlocked: false });
    expect(ok(await call("editor", surface.premiumTool, { projectId: project, [surface.key]: mine, premium: false }))).toEqual({ premium: false, premiumUnlocked: false });
    expect(await surface.isPremium(mine)).toBe(false);
  });
  it("refuses to unmark a published Premium item, as the browser does", async () => {
    const [mine, twin] = [await surface.seed({ premium: true, published: true }), await surface.seed({ premium: true, published: true })];
    const outcome = await call("editor", surface.premiumTool, { projectId: project, [surface.key]: mine, premium: false, confirm: true });
    expect(outcome.result?.isError).toBe(true);
    const cookie = await cookiePut("editor", surface.path(twin), { premium: false });
    expect(cookie.status).toBe(409);
    expect(textOf(outcome)).toBe(`HTTP 409: ${JSON.stringify(cookie.body)}`);
    expect(await surface.isPremium(mine)).toBe(true);
  });
  it("late Premium changes nothing without confirm: true, and marks with it", async () => {
    const mine = await surface.seed({ published: true });
    const first = await call("editor", surface.premiumTool, { projectId: project, [surface.key]: mine, premium: true });
    expect(first.result?.isError).toBeUndefined();
    expect(textOf(first)).toMatch(/^Confirmation required: .*published.*stays premium/);
    expect(await surface.isPremium(mine)).toBe(false);
    expect(ok(await call("editor", surface.premiumTool, { projectId: project, [surface.key]: mine, premium: true, confirm: true }))).toEqual({ premium: true, premiumUnlocked: false });
    expect(await surface.isPremium(mine)).toBe(true);
  });
});

describe.each(SURFACES)("$label Unlock", (surface) => {
  const unlock = (who: string, id: string, extra: Record<string, unknown> = {}) => call(who, surface.unlockTool, { projectId: project, [surface.key]: id, unlocked: true, ...extra });

  it("the first call unlocks nothing and returns a summary and a token", async () => {
    const mine = await surface.seed({ premium: true, published: true });
    const first = await unlock("editor", mine, { paymentRef: "INV-1" });
    expect(first.result?.isError).toBeUndefined();
    const text = textOf(first);
    expect(text).toMatch(/^Confirmation required: /);
    const summary = JSON.parse(text.slice(text.indexOf("\n") + 1)) as Record<string, unknown>;
    expect(summary).toMatchObject({ willBecomeViewableAndDownloadableInFull: { id: mine, premium: true, unlocked: false, onPublishedPage: true }, paymentRef: "INV-1" });
    expect(await surface.isUnlocked(mine)).toBe(false);
  });
  it("the confirmed second call unlocks, as the cookie route does", async () => {
    const [mine, twin] = [await surface.seed({ premium: true, published: true }), await surface.seed({ premium: true, published: true })];
    const token = tokenOf(textOf(await unlock("editor", mine)));
    const tool = ok(await unlock("editor", mine, { confirm: true, confirmToken: token }));
    const cookie = await cookiePut("editor", `${surface.path(twin)}-unlock`, { unlocked: true });
    expect(cookie.status).toBe(200);
    expect(tool).toEqual(cookie.body);
    expect(tool).toEqual({ premium: true, premiumUnlocked: true });
    expect(await surface.isUnlocked(mine)).toBe(true);
  });
  it("refuses confirm: true without a token, a token for another item, connection or action, an expired one, and a stale one", async () => {
    const [mine, other] = [await surface.seed({ premium: true }), await surface.seed({ premium: true })];
    expect((await unlock("editor", mine, { confirm: true })).result?.isError).toBe(true);
    const otherToken = tokenOf(textOf(await unlock("editor", other)));
    const foreign = await unlock("editor", mine, { confirm: true, confirmToken: otherToken });
    expect(foreign.result?.isError).toBe(true);
    expect(textOf(foreign)).toMatch(/changed; re-confirm/);
    const adminToken = tokenOf(textOf(await unlock("admin", mine)));
    const crossConnection = await unlock("editor", mine, { confirm: true, confirmToken: adminToken });
    expect(textOf(crossConnection)).toMatch(/not valid/);
    const myToken = tokenOf(textOf(await unlock("editor", mine)));
    const [, hash] = myToken.split(".");
    const now = Math.floor(Date.now() / 1000);
    const wrongAction = await signConfirmToken(testEnv.MCP_DOWNLOAD_SECRET!, { action: "delete_project", connectionId: tokens.editor!.connectionId, projectId: project, summaryHash: hash!, exp: now + 300 });
    expect(textOf(await unlock("editor", mine, { confirm: true, confirmToken: wrongAction }))).toMatch(/not valid/);
    const expired = await signConfirmToken(testEnv.MCP_DOWNLOAD_SECRET!, { action: "unlock", connectionId: tokens.editor!.connectionId, projectId: project, summaryHash: hash!, exp: now - 1 });
    expect(textOf(await unlock("editor", mine, { confirm: true, confirmToken: expired }))).toMatch(/expired/);
    // The paymentRef is part of what the user agreed to.
    expect(textOf(await unlock("editor", mine, { confirm: true, confirmToken: myToken, paymentRef: "INV-9" }))).toMatch(/changed; re-confirm/);
    expect(await surface.isUnlocked(mine)).toBe(false);
  });
  it("Re-lock needs no token", async () => {
    const mine = await surface.seed({ premium: true, published: true });
    await unlock("editor", mine, { confirm: true, confirmToken: tokenOf(textOf(await unlock("editor", mine))) });
    expect(ok(await call("editor", surface.unlockTool, { projectId: project, [surface.key]: mine, unlocked: false }))).toEqual({ premium: true, premiumUnlocked: false });
    expect(await surface.isUnlocked(mine)).toBe(false);
  });
});

describe("audited as through MCP", () => {
  it("premium, Unlock and Re-lock rows carry the via marker", async () => {
    const mark = (await database.DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log").first<{ n: number }>())!.n;
    const videoId = await film(); const assetId = await photo();
    ok(await call("editor", "set_video_premium", { projectId: project, videoId, premium: true }));
    ok(await call("editor", "set_asset_premium", { projectId: project, assetId, premium: true }));
    ok(await call("editor", "set_video_premium_unlock", { projectId: project, videoId, unlocked: true, confirm: true, confirmToken: tokenOf(textOf(await call("editor", "set_video_premium_unlock", { projectId: project, videoId, unlocked: true }))) }));
    ok(await call("editor", "set_asset_premium_unlock", { projectId: project, assetId, unlocked: true, confirm: true, confirmToken: tokenOf(textOf(await call("editor", "set_asset_premium_unlock", { projectId: project, assetId, unlocked: true }))) }));
    ok(await call("editor", "set_video_premium_unlock", { projectId: project, videoId, unlocked: false }));
    const rows = (await database.DB.prepare("SELECT action, meta_json FROM audit_log WHERE rowid > ? AND (action LIKE 'video.premium%' OR action LIKE 'asset.%premium%') ORDER BY rowid").bind(mark).all<{ action: string; meta_json: string }>()).results;
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows) expect(JSON.parse(row.meta_json), row.action).toMatchObject({ via: "mcp", client: "Test Client", connectionId: tokens.editor!.connectionId });
  });
});
