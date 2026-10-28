import { env, SELF as workerSelf } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import type { McpPrincipal } from "../src/lib/mcp-dispatch-context";
import { signConfirmToken } from "../src/mcp/confirm-token";
import type { McpFetchApp } from "../src/mcp/dispatch";
import { MCP_TOOLS, toolsFor } from "../src/mcp/tools/registry";
import { mcpHarness } from "./mcp-oauth-support";

/**
 * Client Delivery page and Publish through /mcp (#968): visibility by role and scope, parity with the cookie routes, and Publish's
 * signed summary-and-token round trip (action `publish`): nothing on the first call, refused when the page or the selection changed,
 * for a stale, foreign or other action's token, and on an archived Project; the route's own `stale_set` fence surfaces as an error.
 */
declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;
const testEnv = env as unknown as Env;
const h = mcpHarness(testEnv);
const DB = h.DB;
const SECRET = "test-mcp-download-secret-32-bytes!!";
const CLIENT = "Test Client";

const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const editorId = "b9680000-0000-4000-8000-000000000001";
const photographerId = "b9680000-0000-4000-8000-000000000002";
const externalId = "b9680000-0000-4000-8000-000000000003";
const tokens: Record<string, { accessToken: string; connectionId: string }> = {};

const READS = ["get_delivery_page", "list_delivery_candidates", "preview_delivery"];
const ALL = [...READS, "publish_delivery", "set_delivery_page_enabled"];

type Json = Record<string, any>;
const d = (projectId: string, rest = "") => `/api/projects/${projectId}/delivery${rest}`;
const cookieSend = (who: string, method: string, path: string, body?: unknown) =>
  workerSelf.fetch(`${h.ORIGIN}${path}`, { method, headers: { cookie: h.cookies[who]!, origin: h.ORIGIN, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const call = (who: string, name: string, args: Record<string, unknown>) => h.callTool(tokens[who]!.accessToken, name, args);
const textOf = (outcome: { result?: { content: { text: string }[] } }) => outcome.result!.content[0]!.text;
const tokenFrom = (text: string) => /"confirmToken":\s*"([^"]+)"/.exec(text)![1]!;
const one = async (sql: string, ...binds: unknown[]) => (await DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const setCount = (projectId: string) => one("SELECT count(*) AS n FROM delivery_sets WHERE project_id = ?", projectId);

/** A Project behind an open Client Delivery gate, with the Editor assigned and `photos` current edited photos. */
async function openProject(input: { photos?: number; premium?: number[]; archived?: boolean; stage?: string } = {}) {
  const projectId = crypto.randomUUID(); const now = Date.now(); const collectionId = crypto.randomUUID();
  await DB.batch([
    DB.prepare("INSERT INTO projects (id, street, suburb, stage_key, board_revision, archived_at, created_at, updated_at) VALUES (?, '9 Delivery Street', 'Testville', ?, 0, ?, ?, ?)").bind(projectId, input.stage ?? "edited_review", input.archived ? now : null, now, now),
    DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), projectId, editorId, now),
    DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'edited', 'empty', 0, ?, ?)").bind(collectionId, projectId, now, now),
    DB.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1").bind(`client_delivery_pilot:${projectId}`, now),
  ]);
  const photos: string[] = [];
  for (let i = 0; i < (input.photos ?? 3); i++) {
    const id = crypto.randomUUID();
    await DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, version, delivery_premium, publish_status, created_at, updated_at) VALUES (?, ?, 'photo', ?, ?, 10, 'upload', 1, ?, 'ready', ?, ?)")
      .bind(id, collectionId, `projects/${projectId}/mcp-delivery/${id}`, `photo-${i}.jpg`, input.premium?.includes(i) ? 1 : 0, now + i, now + i).run();
    photos.push(id);
  }
  return { projectId, photos };
}

beforeAll(async () => {
  await h.executeSql(__PORTAL_MIGRATION_SQL__); await h.executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await DB.batch([
    DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'mcp_access'"),
    DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'"),
    DB.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES ('client_delivery', 1, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1").bind(now),
  ]);
  await h.addUser(editorId, "editor"); await h.addUser(photographerId, "photographer"); await h.addUser(externalId, "external_editor");
  for (const [name, id] of [["admin", adminId], ["editor", editorId], ["photographer", photographerId], ["external", externalId]] as const) await h.addSession(name, id);
  tokens.admin = await h.connect("read write admin", "admin");
  tokens.adminRW = await h.connect("read write", "admin");
  tokens.adminReadOnly = await h.connect("read", "admin");
  for (const name of ["editor", "photographer", "external"]) tokens[name] = await h.connect("read write", name);
});
beforeEach(() => { delete (testEnv as { MCP_CALLS?: unknown }).MCP_CALLS; delete (testEnv as { MCP_WRITES?: unknown }).MCP_WRITES; });
afterEach(() => { vi.useRealTimers(); });

const listed = async (who: string) => (await h.toolsList(tokens[who]!.accessToken)).map((tool) => tool.name).filter((name) => ALL.includes(name)).sort();

describe("tools/list follows the role and the granted scopes", () => {
  it("admin with admin scope sees all five; without it, no page switch; read-only sees the reads", async () => {
    expect(await listed("admin")).toEqual([...ALL].sort());
    expect(await listed("adminRW")).toEqual(ALL.filter((name) => name !== "set_delivery_page_enabled").sort());
    expect(await listed("adminReadOnly")).toEqual([...READS].sort());
  });
  it("editor sees the reads and Publish, never the page switch; Photographer and External editor see none", async () => {
    expect(await listed("editor")).toEqual(ALL.filter((name) => name !== "set_delivery_page_enabled").sort());
    expect(toolsFor("editor", ["read", "write", "admin"]).map((tool) => tool.name)).not.toContain("set_delivery_page_enabled");
    expect(await listed("photographer")).toEqual([]);
    expect(await listed("external")).toEqual([]);
  });
  it("annotates the reads read-only, Publish a non-destructive write and the page switch an admin write", () => {
    const tool = (name: string) => MCP_TOOLS.find((candidate) => candidate.name === name)!;
    for (const name of READS) expect(tool(name).annotations, name).toMatchObject({ readOnlyHint: true });
    expect(tool("preview_delivery").scope).toBe("read");
    expect(tool("publish_delivery")).toMatchObject({ scope: "write", capability: "publish", annotations: { readOnlyHint: false, destructiveHint: false } });
    expect(tool("set_delivery_page_enabled")).toMatchObject({ scope: "admin", capability: "switchDeliveryPage", annotations: { readOnlyHint: false, destructiveHint: true } });
  });
});

describe("reads return what the cookie routes return", () => {
  it("get_delivery_page and list_delivery_candidates, for admin and editor, before and after a Publish", async () => {
    const { projectId, photos } = await openProject({ premium: [1] });
    const same = async (who: string, name: string, path: string) => {
      const cookie = await h.asCookie(who, path);
      expect(cookie.status, `${who} ${name}`).toBe(200);
      const outcome = await call(who, name, { projectId });
      expect(outcome.result?.isError, textOf(outcome)).toBeUndefined();
      expect(JSON.parse(textOf(outcome))).toEqual(await cookie.json());
    };
    for (const who of ["admin", "editor"]) { await same(who, "get_delivery_page", d(projectId)); await same(who, "list_delivery_candidates", d(projectId, "/candidates")); }
    expect((await cookieSend("admin", "POST", d(projectId, "/publish"), { assetIds: photos, coverAssetId: photos[0], expectedLatestSet: null, operationId: crypto.randomUUID() })).status).toBe(201);
    for (const who of ["admin", "editor"]) await same(who, "get_delivery_page", d(projectId));
  });
  it("preview_delivery matches the cookie Preview except for its throwaway handles, and writes nothing", async () => {
    const { projectId, photos } = await openProject({ premium: [2] });
    const strip = (body: Json) => JSON.parse(JSON.stringify(body).replace(/"[A-Za-z0-9_-]{16}"/g, '"HANDLE"')) as Json;
    const cookie = await cookieSend("editor", "POST", d(projectId, "/preview"), { assetIds: photos, coverAssetId: photos[0] });
    expect(cookie.status).toBe(200);
    const outcome = await call("editor", "preview_delivery", { projectId, assetIds: photos, coverAssetId: photos[0] });
    expect(outcome.result?.isError, textOf(outcome)).toBeUndefined();
    expect(strip(JSON.parse(textOf(outcome)))).toEqual(strip(await cookie.json() as Json));
    expect(await setCount(projectId)).toBe(0);
  });
  it("route refusals pass through: gate closed 404, bad selection 400", async () => {
    const closed = crypto.randomUUID();
    await DB.prepare("INSERT INTO projects (id, street, stage_key, board_revision, created_at, updated_at) VALUES (?, 'Closed', 'edited_review', 0, ?, ?)").bind(closed, Date.now(), Date.now()).run();
    const gate = await call("admin", "get_delivery_page", { projectId: closed });
    expect(gate.result?.isError).toBe(true);
    expect(textOf(gate)).toMatch(/^HTTP 404/);
    const { projectId } = await openProject();
    const bad = await call("admin", "preview_delivery", { projectId, assetIds: [crypto.randomUUID()] });
    expect(textOf(bad)).toMatch(/^HTTP 400: .*invalid_selection/s);
  });
});

describe("publish_delivery: the summary-and-token round trip", () => {
  it("the first call publishes nothing and returns the next set's summary and a token", async () => {
    const { projectId, photos } = await openProject({ premium: [1] });
    const audits = await one("SELECT count(*) AS n FROM audit_log");
    const outcome = await call("editor", "publish_delivery", { projectId, assetIds: photos, coverAssetId: photos[0] });
    expect(outcome.result?.isError).toBeUndefined();
    const text = textOf(outcome);
    expect(text).toMatch(/^Confirmation required: /);
    const summary = JSON.parse(text.slice(text.indexOf("\n") + 1)) as Json;
    expect(summary).toMatchObject({ firstPublish: true, page: null, project: { id: projectId, street: "9 Delivery Street" }, nextSet: { setNumber: 1, coverAssetId: photos[0], itemCount: 3, lockedCount: 1 } });
    expect(summary.nextSet.items.map((item: Json) => item.assetId)).toEqual(photos);
    expect(summary.nextSet.items[1]).toMatchObject({ kind: "photo", locked: true, premium: true });
    expect(JSON.stringify(summary.nextSet)).not.toMatch(/handle|url/i);
    expect(summary.confirmToken).toMatch(/^\d+\.[0-9a-f]{64}\.[0-9a-f]{64}$/);
    expect(await setCount(projectId)).toBe(0);
    expect(await one("SELECT count(*) AS n FROM audit_log")).toBe(audits);
    // Preview's random handles never move the hash: the same page and selection summarise the same.
    const again = await call("editor", "publish_delivery", { projectId, assetIds: photos, coverAssetId: photos[0] });
    expect(tokenFrom(textOf(again)).split(".")[1]).toBe(summary.confirmToken.split(".")[1]);
  });

  it("the confirmed call produces the same Published set, Stage move, notifications and audit as the cookie route", async () => {
    const viaCookie = await openProject({ premium: [1] });
    const viaMcp = await openProject({ premium: [1] });
    const cookie = await cookieSend("editor", "POST", d(viaCookie.projectId, "/publish"), { assetIds: viaCookie.photos, coverAssetId: viaCookie.photos[0], expectedLatestSet: null, operationId: crypto.randomUUID() });
    expect(cookie.status).toBe(201);
    const token = tokenFrom(textOf(await call("editor", "publish_delivery", { projectId: viaMcp.projectId, assetIds: viaMcp.photos, coverAssetId: viaMcp.photos[0] })));
    const outcome = await call("editor", "publish_delivery", { projectId: viaMcp.projectId, assetIds: viaMcp.photos, coverAssetId: viaMcp.photos[0], confirm: true, confirmToken: token });
    expect(outcome.result?.isError, textOf(outcome)).toBeUndefined();
    const published = JSON.parse(textOf(outcome)) as Json;
    const cookieBody = await cookie.json() as Json;
    expect(published).toMatchObject({ replayed: false, operationSetNumber: 1, page: { enabled: true, latestSetNumber: 1 }, set: { setNumber: 1, coverAssetId: viaMcp.photos[0] } });
    const shape = (body: Json, ids: string[]) => ({ page: { enabled: body.page.enabled, latestSetNumber: body.page.latestSetNumber }, cover: ids.indexOf(body.set.coverAssetId), items: body.set.items.map((item: Json) => ({ at: ids.indexOf(item.assetId), kind: item.kind, label: item.label, position: item.position, locked: item.locked, premium: item.premium })) });
    expect(shape(published, viaMcp.photos)).toEqual(shape(cookieBody, viaCookie.photos));
    const { replayed: _replayed, operationSetNumber: _set, ...state } = published;
    expect(state).toEqual(await (await h.asCookie("editor", d(viaMcp.projectId))).json());

    const effects = async (projectId: string) => ({
      stage: (await DB.prepare("SELECT stage_key AS s FROM projects WHERE id = ?").bind(projectId).first<{ s: string }>())!.s,
      audit: (await DB.prepare("SELECT action, meta_json FROM audit_log WHERE target_id = ? ORDER BY rowid").bind(projectId).all<{ action: string; meta_json: string | null }>()).results,
      activity: (await DB.prepare("SELECT event_type, via_client FROM project_activity_events WHERE project_id = ? ORDER BY rowid").bind(projectId).all<{ event_type: string; via_client: string | null }>()).results,
      outbox: (await DB.prepare("SELECT event_type, recipient_id FROM notification_outbox WHERE project_id = ? ORDER BY event_type, recipient_id").bind(projectId).all<{ event_type: string; recipient_id: string }>()).results,
    });
    const [a, b] = [await effects(viaCookie.projectId), await effects(viaMcp.projectId)];
    expect(b.stage).toBe("delivered");
    expect(b.stage).toBe(a.stage);
    expect(b.audit.map((row) => row.action)).toEqual(a.audit.map((row) => row.action));
    expect(b.audit.map((row) => row.action)).toContain("delivery.publish");
    expect(b.activity.map((row) => row.event_type)).toEqual(a.activity.map((row) => row.event_type));
    expect(b.outbox).toEqual(a.outbox);
    for (const row of b.audit) {
      if (row.action === "project.deadline.automatic_set") continue;
      expect(JSON.parse(row.meta_json ?? "{}"), row.action).toMatchObject({ via: "mcp", client: CLIENT, connectionId: tokens.editor!.connectionId });
    }
    for (const row of b.activity) expect(row.via_client, row.event_type).toBe(CLIENT);
    const strip = (meta: string | null) => { const { via: _v, client: _c, connectionId: _id, ...rest } = JSON.parse(meta ?? "{}") as Json; return rest; };
    const publishMeta = (rows: typeof a.audit) => strip(rows.find((row) => row.action === "delivery.publish")!.meta_json);
    expect(publishMeta(b.audit)).toEqual(publishMeta(a.audit));
  });

  it("a later Publish shows the set it replaces and passes the page's set as expectedLatestSet", async () => {
    const { projectId, photos } = await openProject();
    expect((await cookieSend("admin", "POST", d(projectId, "/publish"), { assetIds: [photos[0]], expectedLatestSet: null, operationId: crypto.randomUUID() })).status).toBe(201);
    const first = textOf(await call("admin", "publish_delivery", { projectId, assetIds: photos }));
    expect(JSON.parse(first.slice(first.indexOf("\n") + 1))).toMatchObject({ firstPublish: false, page: { latestSetNumber: 1, enabled: true }, nextSet: { setNumber: 2, coverAssetId: null } });
    const outcome = await call("admin", "publish_delivery", { projectId, assetIds: photos, confirm: true, confirmToken: tokenFrom(first) });
    expect(JSON.parse(textOf(outcome))).toMatchObject({ operationSetNumber: 2, set: { setNumber: 2 } });
    expect(await setCount(projectId)).toBe(2);
  });

  it("refuses when the page changed in between, or when the selection differs from the one confirmed", async () => {
    const { projectId, photos } = await openProject();
    const token = tokenFrom(textOf(await call("editor", "publish_delivery", { projectId, assetIds: photos })));
    const otherOrder = await call("editor", "publish_delivery", { projectId, assetIds: [...photos].reverse(), confirm: true, confirmToken: token });
    expect(otherOrder.result?.isError).toBe(true);
    expect(textOf(otherOrder)).toMatch(/changed; re-confirm/);
    const withCover = await call("editor", "publish_delivery", { projectId, assetIds: photos, coverAssetId: photos[0], confirm: true, confirmToken: token });
    expect(textOf(withCover)).toMatch(/changed; re-confirm/);
    expect((await cookieSend("admin", "POST", d(projectId, "/publish"), { assetIds: [photos[0]], expectedLatestSet: null, operationId: crypto.randomUUID() })).status).toBe(201);
    const outcome = await call("editor", "publish_delivery", { projectId, assetIds: photos, confirm: true, confirmToken: token });
    expect(outcome.result?.isError).toBe(true);
    expect(textOf(outcome)).toMatch(/changed; re-confirm/);
    expect(await setCount(projectId)).toBe(1);
  });

  it("refuses a missing, tampered, expired, other Project's, other connection's or other action's token", async () => {
    const { projectId, photos } = await openProject();
    const other = await openProject();
    const args = { projectId, assetIds: photos };
    const confirmWith = (who: string, confirmToken?: string) => call(who, "publish_delivery", { ...args, confirm: true, ...(confirmToken === undefined ? {} : { confirmToken }) });
    expect(textOf(await confirmWith("editor"))).toMatch(/confirmToken is required/);
    const token = tokenFrom(textOf(await call("editor", "publish_delivery", args)));
    const foreignProject = tokenFrom(textOf(await call("editor", "publish_delivery", { projectId: other.projectId, assetIds: other.photos })));
    const [exp, hash, signature] = token.split(".");
    const tampered = `${exp}.${hash}.${signature!.replace(/^./, (c) => (c === "0" ? "1" : "0"))}`;
    const now = Math.floor(Date.now() / 1000);
    const otherAction = await signConfirmToken(SECRET, { action: "delete_project", connectionId: tokens.editor!.connectionId, projectId, summaryHash: hash!, exp: now + 300 });
    for (const [who, bad] of [["editor", tampered], ["editor", foreignProject], ["editor", otherAction], ["admin", token]] as const) {
      const outcome = await confirmWith(who, bad);
      expect(outcome.result?.isError, bad).toBe(true);
      expect(textOf(outcome)).toMatch(/not valid for this Project and connection/);
    }
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 301_000);
    const expired = await confirmWith("editor", token);
    expect(textOf(expired)).toMatch(/expired/);
    vi.useRealTimers();
    expect(await setCount(projectId)).toBe(0);
  });

  it("an archived Project refuses Publish with project_archived", async () => {
    const { projectId, photos } = await openProject({ archived: true });
    const token = tokenFrom(textOf(await call("admin", "publish_delivery", { projectId, assetIds: photos })));
    const outcome = await call("admin", "publish_delivery", { projectId, assetIds: photos, confirm: true, confirmToken: token });
    expect(outcome.result?.isError).toBe(true);
    expect(textOf(outcome)).toMatch(/^HTTP 409: .*project_archived/s);
    expect(await setCount(projectId)).toBe(0);
  });

  it("a Publish that lands between the check and the dispatch meets the route's stale_set, as a tool error", async () => {
    const { projectId, photos } = await openProject();
    const principal: McpPrincipal = { userId: editorId, connectionId: tokens.editor!.connectionId, clientName: CLIENT, authorizationEpoch: 0 };
    const executionCtx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
    let raced = false;
    const fetchApp: McpFetchApp = async (request, e, c) => {
      if (!raced && request.method === "POST" && new URL(request.url).pathname.endsWith("/delivery/publish")) {
        raced = true;
        const competitor = new Request(`${h.ORIGIN}${d(projectId, "/publish")}`, { method: "POST", headers: { cookie: h.cookies.admin!, origin: h.ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ assetIds: [photos[0]], expectedLatestSet: null, operationId: crypto.randomUUID() }) });
        expect((await app.fetch(competitor, e, c)).status).toBe(201);
      }
      return app.fetch(request, e, c);
    };
    const tool = MCP_TOOLS.find((candidate) => candidate.name === "publish_delivery")!;
    const ctx = { env: testEnv, executionCtx, fetchApp, principal, role: "editor" };
    const first = await tool.call(ctx, { projectId, assetIds: photos });
    const outcome = await tool.call(ctx, { projectId, assetIds: photos, confirm: true, confirmToken: tokenFrom(first.content[0]!.text) });
    expect(raced).toBe(true);
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]!.text).toMatch(/^HTTP 409: .*stale_set/s);
    expect(await setCount(projectId)).toBe(1);
  });

  it("a read-only grant, a Photographer and an External editor cannot Publish", async () => {
    const { projectId, photos } = await openProject();
    for (const who of ["adminReadOnly", "photographer", "external"]) {
      const outcome = await call(who, "publish_delivery", { projectId, assetIds: photos });
      expect(outcome.error ?? outcome.result?.isError, who).toBeTruthy();
    }
  });
});

describe("set_delivery_page_enabled: admin scope and switchDeliveryPage", () => {
  it("switches the page off and on like the cookie route, audited via mcp", async () => {
    const { projectId, photos } = await openProject();
    const none = await call("admin", "set_delivery_page_enabled", { projectId, enabled: false });
    expect(textOf(none)).toMatch(/^HTTP 404: .*no_page/s);
    expect((await cookieSend("admin", "POST", d(projectId, "/publish"), { assetIds: photos, expectedLatestSet: null, operationId: crypto.randomUUID() })).status).toBe(201);
    const mark = await one("SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log");
    const off = await call("admin", "set_delivery_page_enabled", { projectId, enabled: false });
    expect(off.result?.isError, textOf(off)).toBeUndefined();
    expect(JSON.parse(textOf(off))).toEqual(await (await h.asCookie("admin", d(projectId))).json());
    expect(JSON.parse(textOf(off))).toMatchObject({ page: { enabled: false } });
    const rows = (await DB.prepare("SELECT action, meta_json FROM audit_log WHERE rowid > ? AND target_id = ?").bind(mark, projectId).all<{ action: string; meta_json: string }>()).results;
    expect(rows.map((row) => row.action)).toEqual(["delivery.page_off"]);
    expect(JSON.parse(rows[0]!.meta_json)).toMatchObject({ via: "mcp", client: CLIENT, connectionId: tokens.admin!.connectionId });
    const cookieOn = await cookieSend("admin", "PUT", d(projectId, "/page"), { enabled: true });
    expect(cookieOn.status).toBe(200);
    expect(JSON.parse(textOf(await call("admin", "set_delivery_page_enabled", { projectId, enabled: true })))).toEqual(await cookieOn.json());
  });
  it("is refused without the admin grant and to an Editor", async () => {
    const { projectId } = await openProject();
    for (const who of ["adminRW", "editor"]) {
      const outcome = await call(who, "set_delivery_page_enabled", { projectId, enabled: false });
      expect(outcome.error ?? outcome.result?.isError, who).toBeTruthy();
    }
  });
});
