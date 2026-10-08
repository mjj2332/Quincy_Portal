import { env, SELF as workerSelf } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { MCP_ALLOWED_ROUTES, isAllowedMcpRoute } from "../src/mcp/route-allowlist";
import { MCP_TOOLS, toolsFor } from "../src/mcp/tools/registry";
import { COLLAB_WRITE_TOOLS } from "../src/mcp/tools/collab-writes";
import { WRITE_TOOLS as CORE_WRITE_TOOLS } from "../src/mcp/tools/writes";
import { mcpHarness } from "./mcp-oauth-support";

const WRITE_TOOLS = [...CORE_WRITE_TOOLS, ...COLLAB_WRITE_TOOLS];

declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;
const testEnv = env as unknown as Env;
const h = mcpHarness(testEnv);
const DB = h.DB;

const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const editorId = "b3000000-0000-4000-8000-000000000001";
const photographerId = "b3000000-0000-4000-8000-000000000002";
const externalId = "b3000000-0000-4000-8000-000000000003";
const visibleProject = "c3000000-0000-4000-8000-000000000001";
const hiddenProject = "c3000000-0000-4000-8000-000000000002";
const collectionId = "d3000000-0000-4000-8000-000000000001";
const assetId = "e3000000-0000-4000-8000-000000000001";
const annotationId = "f3000000-0000-4000-8000-000000000001";
const tokens: Record<string, { accessToken: string; connectionId: string }> = {};

const READ_NAMES = [
  "get_me", "list_projects", "my_tasks", "get_project", "list_stages", "list_project_assignment_candidates", "list_subtask_assignee_options",
  "get_project_subtasks", "get_project_links", "list_people_for_filters", "list_project_comments", "get_project_activity", "get_collaboration_summary",
  "list_project_assets", "list_asset_annotations", "list_notifications", "list_notice_board",
];
const WRITE_NAMES = WRITE_TOOLS.map((tool) => tool.name);
const ADMIN_NAMES = [
  "admin_list_users", "admin_tonomo_health", "admin_list_webhook_events", "admin_get_webhook_event", "admin_list_dead_letters",
  "admin_list_notification_deliveries", "admin_list_agencies", "admin_list_agency_contacts", "admin_list_stages", "admin_get_attention", "admin_list_project_jobs",
];

beforeAll(async () => {
  await h.executeSql(__PORTAL_MIGRATION_SQL__); await h.executeSql(__PORTAL_SEED_SQL__);
  await DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'mcp_access'").run();
  await h.addUser(editorId, "editor"); await h.addUser(photographerId, "photographer"); await h.addUser(externalId, "external_editor");
  for (const [name, id] of [["admin", adminId], ["editor", editorId], ["photographer", photographerId], ["external", externalId]] as const) await h.addSession(name, id);
  const now = Date.now();
  for (const [id, street] of [[visibleProject, "Visible Street"], [hiddenProject, "Hidden Street"]]) await DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?)").bind(id, street, now, now).run();
  for (const [userId, role] of [[photographerId, "photographer"], [externalId, "editor"]]) await DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), visibleProject, userId, role, now).run();
  await DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?)").bind(collectionId, visibleProject, now, now).run();
  await DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, 'mcp-reads/a.jpg', 'a.jpg', 10, 'upload', ?, ?)").bind(assetId, collectionId, now, now).run();
  await DB.prepare("INSERT INTO annotations (id, asset_id, author_id, author_role, scope, note_text, created_at) VALUES (?, ?, ?, 'editor', 'raw', 'Check the window', ?)").bind(annotationId, assetId, editorId, now).run();
  tokens.adminReadOnly = await h.connect("read", "admin");
  for (const [name, scope] of [["admin", "read write admin"], ["editor", "read"], ["photographer", "read"], ["external", "read"]] as const) tokens[name] = await h.connect(scope, name);
});
beforeEach(() => { delete (testEnv as { MCP_CALLS?: unknown }).MCP_CALLS; delete (testEnv as { MCP_WRITES?: unknown }).MCP_WRITES; });

const names = async (who: string) => (await h.toolsList(tokens[who]!.accessToken)).map((tool) => tool.name).sort();
const text = (result?: { content: { text: string }[] }) => JSON.parse(result!.content[0]!.text) as unknown;

describe("tools/list follows the role and the granted scopes", () => {
  it("admin with every scope sees every read tool, every admin read and every write tool", async () => {
    expect(await names("admin")).toEqual([...READ_NAMES, ...ADMIN_NAMES, ...WRITE_NAMES].sort());
    expect(await names("adminReadOnly")).toEqual([...READ_NAMES, ...ADMIN_NAMES].sort());
  });
  it("editor and photographer see no admin tools; photographer lacks Edited-only tools", async () => {
    const editor = await names("editor"); const photographer = await names("photographer");
    expect(editor.filter((n) => n.startsWith("admin_"))).toEqual([]);
    expect(photographer.filter((n) => n.startsWith("admin_"))).toEqual([]);
    expect(editor).toEqual(READ_NAMES.filter((n) => n !== "list_project_assignment_candidates").sort());
    expect(photographer).toEqual(READ_NAMES.filter((n) => !["list_project_assignment_candidates", "get_project_links"].includes(n)).sort());
  });
  it("external_editor sees only the subset its routes serve", async () => {
    expect(await names("external")).toEqual(READ_NAMES.filter((n) => !["list_project_assignment_candidates", "list_notice_board"].includes(n)).sort());
  });
  it("a read-only grant lists only read-only tools; no read scope lists none", async () => {
    const list = await h.toolsList(tokens.adminReadOnly!.accessToken);
    expect(list.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(toolsFor("admin", ["write"]).every((tool) => tool.annotations.readOnlyHint === false)).toBe(true);
    expect(toolsFor("admin", ["admin"]).map((tool) => tool.name)).toEqual([]);
  });
});

describe("tools/call returns what the cookie route returns for that user", () => {
  const same = async (who: string, name: string, args: Record<string, unknown>, path: string) => {
    const cookie = await h.asCookie(who, path);
    expect(cookie.status).toBe(200);
    const call = await h.callTool(tokens[who]!.accessToken, name, args);
    expect(call.result?.isError).toBeUndefined();
    expect(text(call.result)).toEqual(await cookie.json());
  };
  it("projects: list, filtered list, my tasks, detail, stages", async () => {
    await same("admin", "list_projects", {}, "/api/projects");
    await same("admin", "list_projects", { q: "Visible", stages: "awaiting_raw" }, "/api/projects?q=Visible&stages=awaiting_raw");
    await same("editor", "my_tasks", {}, "/api/projects?mine=1");
    await same("editor", "get_project", { projectId: visibleProject }, `/api/projects/${visibleProject}`);
    await same("photographer", "list_stages", {}, "/api/stages");
    await same("admin", "list_people_for_filters", {}, "/api/dashboard/people");
  });
  it("external_editor gets the same projection as the cookie route for the project and its comments", async () => {
    await same("external", "list_projects", {}, "/api/projects");
    await same("external", "get_project", { projectId: visibleProject }, `/api/projects/${visibleProject}`);
    await same("external", "list_project_comments", { projectId: visibleProject }, `/api/projects/${visibleProject}/comments`);
    await same("external", "get_collaboration_summary", { projectId: visibleProject }, `/api/projects/${visibleProject}/collaboration-summary`);
    await same("external", "get_project_activity", { projectId: visibleProject, limit: 5 }, `/api/projects/${visibleProject}/activity?limit=5`);
  });
  it("collaboration, subtasks and links", async () => {
    await same("admin", "list_project_comments", { projectId: visibleProject, limit: 10 }, `/api/projects/${visibleProject}/comments?limit=10`);
    await same("admin", "get_project_activity", { projectId: visibleProject }, `/api/projects/${visibleProject}/activity`);
    await same("admin", "get_collaboration_summary", { projectId: visibleProject }, `/api/projects/${visibleProject}/collaboration-summary`);
    await same("admin", "get_project_subtasks", { projectId: visibleProject }, `/api/projects/${visibleProject}/subtasks`);
    await same("admin", "list_subtask_assignee_options", { projectId: visibleProject }, `/api/projects/${visibleProject}/subtask-assignee-options`);
    await same("editor", "get_project_links", { projectId: visibleProject, collection: "video" }, `/api/projects/${visibleProject}/links?collection=video`);
  });
  it("assets and annotations carry metadata only", async () => {
    await same("editor", "list_project_assets", { projectId: visibleProject, collection: "raw" }, `/api/projects/${visibleProject}/assets?collection=raw`);
    await same("photographer", "list_asset_annotations", { assetId }, `/api/assets/${assetId}/annotations`);
    const body = JSON.stringify(text((await h.callTool(tokens.editor!.accessToken, "list_project_assets", { projectId: visibleProject, collection: "raw" })).result));
    expect(body).toContain("a.jpg");
    expect(body).not.toMatch(/data:image|base64/);
  });
  it("notifications, notice board, assignment candidates", async () => {
    await same("editor", "list_notifications", {}, "/api/notifications");
    await same("photographer", "list_notice_board", { limit: 5 }, "/api/notice-board/posts?limit=5");
    await same("admin", "list_project_assignment_candidates", {}, "/api/project-assignment-candidates");
  });
  it("admin reads", async () => {
    await same("admin", "admin_list_users", {}, "/api/users");
    await same("admin", "admin_tonomo_health", {}, "/api/admin/tonomo-health");
    await same("admin", "admin_list_webhook_events", { status: "poison", limit: 10 }, "/api/admin/webhook-events?status=poison&limit=10");
    await same("admin", "admin_list_dead_letters", {}, "/api/admin/renditions-dlq");
    await same("admin", "admin_list_notification_deliveries", { view: "failed" }, "/api/admin/notification-deliveries?view=failed");
    await same("admin", "admin_list_agencies", {}, "/api/admin/agencies");
    await same("admin", "admin_list_agency_contacts", {}, "/api/admin/agents");
    await same("admin", "admin_list_stages", {}, "/api/admin/stages");
    await same("admin", "admin_get_attention", {}, "/api/admin/attention");
    await same("admin", "admin_list_project_jobs", { projectId: visibleProject }, `/api/projects/${visibleProject}/jobs`);
  });
  it("a route error becomes isError with the status and the route's body", async () => {
    const call = await h.callTool(tokens.admin!.accessToken, "admin_get_webhook_event", { eventId: "00000000-0000-4000-8000-000000000000" });
    expect(call.result?.isError).toBe(true);
    expect(call.result!.content[0]!.text).toMatch(/^HTTP 404: .*Webhook event not found/);
  });
});

describe("a Project the user cannot see is an error, not data", () => {
  it("photographer: 403; external_editor: 404", async () => {
    for (const [who, status] of [["photographer", 403], ["external", 404]] as const) {
      for (const [name, args] of [["get_project", {}], ["get_project_subtasks", {}], ["list_project_comments", {}], ["get_collaboration_summary", {}]] as const) {
        const call = await h.callTool(tokens[who]!.accessToken, name, { projectId: hiddenProject, ...args });
        expect(call.result?.isError, `${who} ${name}`).toBe(true);
        expect(call.result!.content[0]!.text).toMatch(new RegExp(`^HTTP ${status}:`));
        expect(call.result!.content[0]!.text).not.toContain("Hidden Street");
      }
    }
  });
});

describe("input schemas are strict", () => {
  it("rejects unknown arguments, bad ids and missing required arguments", async () => {
    const outcomes = await Promise.all([
      h.callTool(tokens.editor!.accessToken, "get_project", { projectId: visibleProject, extra: "x" }),
      h.callTool(tokens.editor!.accessToken, "get_project", { projectId: "../admin" }),
      h.callTool(tokens.editor!.accessToken, "get_project", {}),
      h.callTool(tokens.editor!.accessToken, "list_stages", { sneaky: 1 }),
    ]);
    for (const outcome of outcomes) {
      const rejected = outcome.error !== undefined || outcome.result?.isError === true;
      expect(rejected).toBe(true);
      expect(JSON.stringify(outcome)).toMatch(/Input validation|Unrecognized|Invalid|Required/i);
    }
  });
});

describe("rate limit per Connected app", () => {
  const fake = (success: boolean, seen: string[] = []) => ({ limit: async ({ key }: { key: string }) => { seen.push(key); return { success }; } });
  it("is allowed when the binding is absent or allows", async () => {
    expect((await h.callTool(tokens.editor!.accessToken, "list_stages")).result?.isError).toBeUndefined();
    const seen: string[] = [];
    (testEnv as unknown as { MCP_CALLS: unknown }).MCP_CALLS = fake(true, seen);
    expect((await h.callTool(tokens.editor!.accessToken, "list_stages")).result?.isError).toBeUndefined();
    expect(seen).toEqual([tokens.editor!.connectionId]);
  });
  it("a denied tools/call is a readable isError with retryAfterSeconds", async () => {
    (testEnv as unknown as { MCP_CALLS: unknown }).MCP_CALLS = fake(false);
    const call = await h.callTool(tokens.editor!.accessToken, "list_stages");
    expect(call.result?.isError).toBe(true);
    expect(call.result!.content[0]!.text).toBe("Rate limit: 60 calls/min for this Connected app; retry in about 60 s");
    expect(call.result!._meta?.retryAfterSeconds).toBe(60);
  });
  it("only tools/call is counted, and a read never touches the writes limiter", async () => {
    const seen: string[] = []; const writes: string[] = [];
    (testEnv as unknown as { MCP_CALLS: unknown; MCP_WRITES: unknown }).MCP_CALLS = fake(true, seen);
    (testEnv as unknown as { MCP_WRITES: unknown }).MCP_WRITES = fake(false, writes);
    await h.toolsList(tokens.editor!.accessToken);
    expect(seen).toEqual([]);
    expect((await h.callTool(tokens.editor!.accessToken, "list_stages")).result?.isError).toBeUndefined();
    expect(writes).toEqual([]);
  });
  it("the writes wording exists for the writes limiter", async () => {
    const { rateLimitedResult } = await import("../src/mcp/rate-limit");
    expect(rateLimitedResult("writes").content[0]!.text).toBe("Rate limit: 20 writes/min for this Connected app; retry in about 60 s");
  });
});

describe("the /mcp body is bounded and parsed once", () => {
  const post = (body: BodyInit, extra: RequestInit = {}) => workerSelf.fetch(`${h.ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokens.editor!.accessToken}` }, body, ...extra });
  const counting = () => { const seen: string[] = []; (testEnv as unknown as { MCP_CALLS: unknown }).MCP_CALLS = { limit: async ({ key }: { key: string }) => { seen.push(key); return { success: true }; } }; return seen; };
  const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_stages", arguments: {} } });
  it("a body over 1 MiB is 413 (Content-Length and chunked), before any limiter call", async () => {
    const seen = counting();
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_stages", arguments: { pad: "x".repeat(1024 * 1024 + 10) } } });
    expect((await post(big)).status).toBe(413);
    const chunk = new TextEncoder().encode(big);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < chunk.length; i += 65536) controller.enqueue(chunk.slice(i, i + 65536)); controller.close(); } });
    expect((await post(stream, { duplex: "half" } as RequestInit)).status).toBe(413);
    expect(seen).toEqual([]);
  });
  it("a batch array is -32600 with HTTP 400, before any limiter call", async () => {
    const seen = counting();
    const res = await post(`[${call},${call}]`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32600, message: "Batching is not supported" } });
    expect(seen).toEqual([]);
  });
  it("a single call is counted exactly once and still answered", async () => {
    const seen = counting();
    const res = await post(call);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { isError?: boolean } }).result.isError).toBeUndefined();
    expect(seen).toEqual([tokens.editor!.connectionId]);
  });
});

describe("get_project_links takes the route's collection enum", () => {
  it("rejects raw and edited at the schema, accepts video, floorplan and copy", async () => {
    for (const collection of ["raw", "edited"]) {
      const outcome = await h.callTool(tokens.editor!.accessToken, "get_project_links", { projectId: visibleProject, collection });
      expect(outcome.error !== undefined || outcome.result?.isError === true).toBe(true);
      expect(JSON.stringify(outcome)).toMatch(/Input validation|Invalid/i);
    }
    for (const collection of ["video", "floorplan", "copy"]) expect((await h.callTool(tokens.editor!.accessToken, "get_project_links", { projectId: visibleProject, collection })).result?.isError).toBeUndefined();
  });
});

describe("route allowlist and the tool registry agree", () => {
  it("every tool dispatches to an allowlisted route, and every allowlist entry belongs to a tool", () => {
    const toolTemplates = new Set(MCP_TOOLS.map((tool) => `${tool.route.method} ${tool.route.template}`));
    for (const tool of MCP_TOOLS.filter((candidate) => candidate.annotations.readOnlyHint === true)) {
      const path = tool.route.template.replace(/:[A-Za-z]+/g, "x1");
      expect(isAllowedMcpRoute(tool.route.method, path), tool.name).toBe(true);
      expect(MCP_ALLOWED_ROUTES.some((route) => route.method === tool.route.method && route.template === tool.route.template), tool.name).toBe(true);
    }
    for (const route of MCP_ALLOWED_ROUTES) expect(toolTemplates.has(`${route.method} ${route.template}`), `${route.method} ${route.template}`).toBe(true);
    expect(new Set(MCP_TOOLS.map((tool) => tool.name)).size).toBe(MCP_TOOLS.length);
  });
  it("has no wildcard, only reads outside the write tools' routes, and keeps /api/auth out", () => {
    const writeRoutes = new Set(WRITE_TOOLS.map((tool) => `${tool.route.method} ${tool.route.template}`));
    expect(MCP_ALLOWED_ROUTES.every((route) => !route.template.includes("*") && (route.method === "GET" || writeRoutes.has(`${route.method} ${route.template}`)))).toBe(true);
    expect(isAllowedMcpRoute("GET", "/api/auth/get-session")).toBe(false);
    expect(isAllowedMcpRoute("GET", "/api/projects/x/jobs/extra")).toBe(false);
    expect(isAllowedMcpRoute("POST", "/api/projects/x1/send-to-autohdr")).toBe(false);
  });
});
