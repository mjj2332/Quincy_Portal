import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import type { McpPrincipal } from "../src/lib/mcp-dispatch-context";
import type { McpFetchApp } from "../src/mcp/dispatch";
import { signConfirmToken, CONFIRM_TTL_SECONDS } from "../src/mcp/confirm-token";
import { MCP_ALLOWED_ROUTES } from "../src/mcp/route-allowlist";
import { MCP_TOOLS, strictInput, toolsFor } from "../src/mcp/tools/registry";
import { mcpHarness } from "./mcp-oauth-support";

declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;
const testEnv = env as unknown as Env;
const h = mcpHarness(testEnv);
const DB = h.DB;

const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const editorId = "b7000000-0000-4000-8000-000000000001";
const demotedId = "b7000000-0000-4000-8000-000000000002";
const CLIENT = "Admin Client";
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;
const fetchApp: McpFetchApp = (request, e, c) => app.fetch(request, e, c);
const principalOf = (connectionId: string): McpPrincipal => ({ userId: adminId, connectionId, clientName: CLIENT, authorizationEpoch: 0 });

/** Every admin-scope write tool, with the route it dispatches to and the capability that route checks. */
const ADMIN_TOOLS: Record<string, { method: string; template: string; capability: string }> = {
  admin_reset_dropbox_monitor: { method: "POST", template: "/api/integrations/dropbox/monitors/:scope/reset", capability: "manageIntegrations" },
  admin_link_editor_folder: { method: "POST", template: "/api/integrations/dropbox/editor-folders/link", capability: "manageIntegrations" },
  admin_resolve_autohdr_mapping: { method: "POST", template: "/api/integrations/dropbox/mappings/:mappingId/resolve", capability: "manageIntegrations" },
  admin_reassign_autohdr_path_claim: { method: "POST", template: "/api/integrations/dropbox/path-claims/reassign", capability: "manageIntegrations" },
  admin_send_to_autohdr: { method: "POST", template: "/api/projects/:projectId/send-to-autohdr", capability: "adminBackend" },
  admin_fetch_edited_from_autohdr: { method: "POST", template: "/api/projects/:projectId/fetch-edited", capability: "adminBackend" },
  admin_retry_job: { method: "POST", template: "/api/jobs/:jobId/retry", capability: "adminBackend" },
  admin_replay_dead_letter: { method: "POST", template: "/api/admin/renditions-dlq/:deadLetterId/replay", capability: "adminBackend" },
  admin_retry_webhook_event: { method: "POST", template: "/api/admin/webhook-events/:eventId/retry", capability: "adminBackend" },
  admin_create_agency: { method: "POST", template: "/api/admin/agencies", capability: "adminBackend" },
  admin_update_agency: { method: "PATCH", template: "/api/admin/agencies/:agencyId", capability: "adminBackend" },
  admin_create_agent: { method: "POST", template: "/api/admin/agents", capability: "adminBackend" },
  admin_update_agent: { method: "PATCH", template: "/api/admin/agents/:agentId", capability: "adminBackend" },
  admin_update_stage: { method: "PATCH", template: "/api/admin/stages/:key", capability: "adminBackend" },
  admin_backfill_renditions: { method: "POST", template: "/api/admin/renditions/backfill", capability: "adminBackend" },
  admin_backfill_autohdr: { method: "POST", template: "/api/admin/autohdr/backfill", capability: "adminBackend" },
  admin_backfill_autohdr_scaffolds: { method: "POST", template: "/api/admin/autohdr/scaffold-backfill", capability: "adminBackend" },
  delete_project: { method: "DELETE", template: "/api/projects/:projectId", capability: "adminBackend" },
};
const ADMIN_WRITE_NAMES = Object.keys(ADMIN_TOOLS);
const ADMIN_READ_ADDITIONS = ["admin_preview_editor_folders", "admin_inspect_dropbox_monitor"];

/** A recording stand-in for the background Worker's RPC surface. */
type BackgroundCall = { name: string; args: unknown[] };
let bgCalls: BackgroundCall[] = [];
const BACKGROUND_RESULTS: Record<string, (...args: unknown[]) => unknown> = {
  sendSelectedToAutoHdr: () => ({ ok: true, jobId: "job-send" }),
  fetchEditedFromAutoHdr: () => ({ ok: true, jobId: "job-fetch" }),
  triggerEditorSync: () => ({ jobId: "job-editor-sync" }),
  resetDropboxMonitor: (scope) => ({ scope, reset: true }),
  linkEditorFolder: () => ({ mappingId: "m1", state: "active" }),
  resolveAutoHdrMapping: () => ({ state: "active" }),
  reassignAutoHdrPathClaim: () => ({ state: "active" }),
  backfillRenditions: () => ({ scanned: 0, wouldEnqueue: 0, enqueued: 0, skipped: 0, nextCursor: null, dryRun: true }),
  backfillAutoHdrV2: () => ({ scanned: 0 }),
  ensureAutoHdrScaffold: () => ({ jobId: "job-scaffold" }),
  previewEditorFolders: () => ({ items: [], nextCursor: null }),
  inspectDropboxMonitor: (scope) => ({ scope }),
  processTonomoEvents: () => undefined,
};
const fakeBackground = new Proxy({}, {
  get: (_target, name) => typeof name !== "string" || name === "then" ? undefined : async (...args: unknown[]) => { bgCalls.push({ name, args }); return BACKGROUND_RESULTS[name]?.(...args) ?? {}; },
});
const holder = testEnv as unknown as { BACKGROUND: unknown; RENDITIONS_ENABLED?: boolean; RENDITION_QUEUE?: unknown };
const realBackground = holder.BACKGROUND;
const renditionSends: unknown[] = [];

const tokens: Record<string, { accessToken: string; connectionId: string; expiresIn: number; refreshToken: string | undefined }> = {};
const callOver = (who: string, name: string, args: unknown = {}) => h.callTool(tokens[who]!.accessToken, name, args);
const mcpTool = (name: string) => MCP_TOOLS.find((tool) => tool.name === name)!;

/** A tool call in-process under a chosen connection, the way the parity test does. */
async function run(name: string, args: Record<string, unknown>, connectionId = "conn-a") {
  holder.BACKGROUND = fakeBackground;
  try { return await mcpTool(name).call({ env: testEnv, executionCtx: ctx, fetchApp, principal: principalOf(connectionId), role: "admin" }, args); }
  finally { holder.BACKGROUND = realBackground; }
}
async function ok(name: string, args: Record<string, unknown>, connectionId = "conn-a") {
  const result = await run(name, args, connectionId);
  expect(result.isError, `${name}: ${result.content[0]!.text}`).toBeUndefined();
  return result.content[0]!.text;
}
const refused = async (name: string, args: Record<string, unknown>, connectionId = "conn-a") => {
  const result = await run(name, args, connectionId);
  expect(result.isError, `${name}: ${result.content[0]!.text}`).toBe(true);
  return result.content[0]!.text;
};
const json = (text: string) => JSON.parse(text) as Record<string, any>;

const maxRowid = async () => (await DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log").first<{ n: number }>())!.n;
async function auditSince(mark: number, action: string) {
  const rows = (await DB.prepare("SELECT meta_json FROM audit_log WHERE rowid > ? AND action = ?").bind(mark, action).all<{ meta_json: string | null }>()).results;
  expect(rows.length, action).toBeGreaterThan(0);
  return rows.map((row) => JSON.parse(row.meta_json ?? "{}") as Record<string, unknown>);
}
const viaMcp = { via: "mcp", client: CLIENT, connectionId: "conn-a" };

async function newProject(options: { archived?: boolean; orderId?: string } = {}) {
  const id = crypto.randomUUID(); const now = Date.now();
  await DB.prepare("INSERT INTO projects (id, street, stage_key, board_revision, archived_at, order_id, created_at, updated_at) VALUES (?, 'Admin Street', 'edited_review', 0, ?, ?, ?, ?)").bind(id, options.archived ? now : null, options.orderId ?? null, now, now).run();
  return id;
}

beforeAll(async () => {
  await h.executeSql(__PORTAL_MIGRATION_SQL__); await h.executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await DB.batch([
    DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'mcp_access'"),
    DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'"),
  ]);
  await h.addUser(editorId, "editor"); await h.addUser(demotedId, "admin");
  await h.addSession("admin", adminId); await h.addSession("editor", editorId); await h.addSession("demoted", demotedId);
  for (const id of ["conn-a", "conn-b"]) {
    await DB.prepare("INSERT INTO mcp_connections (id, user_id, client_id, client_name, redirect_host, scopes, authorization_epoch, created_at) VALUES (?, ?, ?, ?, 'client.example.test', '[\"read\",\"write\",\"admin\"]', 0, ?)").bind(id, adminId, `client-${id}`, CLIENT, now).run();
  }
  tokens.adminFull = await h.connect("read write admin", "admin");
  tokens.adminRW = await h.connect("read write", "admin");
  tokens.editorRW = await h.connect("read write", "editor");
  tokens.demotedFull = await h.connect("read write admin", "demoted");
});
beforeEach(() => {
  bgCalls = [];
  delete (testEnv as { MCP_CALLS?: unknown }).MCP_CALLS; delete (testEnv as { MCP_WRITES?: unknown }).MCP_WRITES;
});

describe("the admin scope: grants, lifetimes and visibility", () => {
  it("lists exactly the admin tools, each destructive, each tied to its route and capability", () => {
    const adminScope = MCP_TOOLS.filter((tool) => tool.scope === "admin");
    expect(adminScope.map((tool) => tool.name).sort()).toEqual([...ADMIN_WRITE_NAMES].sort());
    for (const tool of adminScope) {
      expect(tool.annotations, tool.name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
      expect({ method: tool.route.method, template: tool.route.template, capability: tool.capability }, tool.name).toEqual(ADMIN_TOOLS[tool.name]);
    }
  });

  it("an admin with read and write but no admin grant sees no admin write tool and no delete_project", async () => {
    const list = (await h.toolsList(tokens.adminRW!.accessToken)).map((tool) => tool.name);
    for (const name of ADMIN_WRITE_NAMES) expect(list, name).not.toContain(name);
    expect(list).toContain("admin_list_users");
    const full = (await h.toolsList(tokens.adminFull!.accessToken)).map((tool) => tool.name);
    for (const name of [...ADMIN_WRITE_NAMES, ...ADMIN_READ_ADDITIONS]) expect(full, name).toContain(name);
    const called = await callOver("adminRW", "delete_project", { projectId: crypto.randomUUID() });
    expect(called.error !== undefined || called.result?.isError === true).toBe(true);
  });

  it("only an admin holding the admin grant is offered the tools, whatever the scopes say", () => {
    for (const role of ["editor", "photographer", "external_editor"]) expect(toolsFor(role, ["read", "write", "admin"]).filter((tool) => tool.scope === "admin"), role).toEqual([]);
    expect(toolsFor("admin", ["read", "write"]).filter((tool) => tool.scope === "admin")).toEqual([]);
    expect(toolsFor("admin", ["read", "write", "admin"]).filter((tool) => tool.scope === "admin").length).toBe(ADMIN_WRITE_NAMES.length);
  });

  it("an editor cannot get admin at consent, and an admin grant on a demoted user lists nothing", async () => {
    const client = await h.register(); const a = await h.authorize(client, "read admin");
    expect((await h.consentFetch(a.handle, "editor", a.binding, { decision: "approve", scopes: ["read", "admin"] })).status).toBe(403);
    // Asked for admin, granted only read: the token's scope carries no admin and no admin tool is listed.
    const readOnly = await h.connect("read admin", "editor", ["read"]);
    const names = (await h.toolsList(readOnly.accessToken)).map((tool) => tool.name);
    for (const name of ADMIN_WRITE_NAMES) expect(names, name).not.toContain(name);
    // A demotion needs no epoch bump to take effect on the tool list: the capability gate is live.
    await DB.prepare("UPDATE user SET role = 'editor' WHERE id = ?").bind(demotedId).run();
    const after = (await h.toolsList(tokens.demotedFull!.accessToken)).map((tool) => tool.name);
    for (const name of ADMIN_WRITE_NAMES) expect(after, name).not.toContain(name);
  });

  it("admin grants live 15 minutes with no refresh; other grants live an hour and refresh", () => {
    expect(tokens.adminFull!.expiresIn).toBe(900);
    expect(tokens.adminFull!.refreshToken).toBeUndefined();
    expect(tokens.adminRW!.expiresIn).toBe(3600);
    expect(tokens.adminRW!.refreshToken).toBeTypeOf("string");
  });

  it("every admin tool's input is strict", () => {
    for (const name of ADMIN_WRITE_NAMES) {
      const tool = mcpTool(name);
      const sample = Object.fromEntries(Object.keys(tool.inputSchema).map((key) => [key, undefined]));
      expect(strictInput(tool).safeParse({ ...sample, notARealKey: 1 }).success, name).toBe(false);
    }
    const agency = mcpTool("admin_update_agency");
    expect(strictInput(agency).safeParse({ agencyId: crypto.randomUUID(), role: "admin" }).success).toBe(false);
  });

  it("over the wire an admin grant runs an admin tool and the row says via MCP", async () => {
    const mark = await maxRowid();
    const outcome = await callOver("adminFull", "admin_create_agency", { name: "Wire Agency", notes: null });
    expect(outcome.result?.isError, JSON.stringify(outcome)).toBeUndefined();
    const created = json(outcome.result!.content[0]!.text);
    expect(created.name).toBe("Wire Agency");
    const metas = await auditSince(mark, "agency.create");
    expect(metas[0]).toMatchObject({ via: "mcp", client: "Test Client", connectionId: tokens.adminFull!.connectionId });
  });
});

describe("each admin tool's happy path", () => {
  it("Dropbox: monitor reset, Editor-folder link, AutoHDR mapping resolve and path-claim reassign", async () => {
    const mark = await maxRowid();
    await ok("admin_reset_dropbox_monitor", { scope: "autohdr" });
    expect(bgCalls.find((call) => call.name === "resetDropboxMonitor")?.args).toEqual(["autohdr"]);
    expect((await auditSince(mark, "integration.dropbox_monitor_reset"))[0]).toMatchObject(viaMcp);

    const candidate = {
      projectId: crypto.randomUUID(), connectionId: "dbx-1", expectedShootDate: "2037-01-02", expectedRawFolderPath: null, expectedRawFolderLink: null,
      rootPath: "/Editors/Admin Street", rootFolderId: "id:root",
      inputRoots: [{ path: "/Editors/Admin Street/Input", section: null, folderId: "id:in" }],
      outputRoots: [{ path: "/Editors/Admin Street/Output", section: null, folderId: "id:out" }],
    };
    await ok("admin_link_editor_folder", { reviewed: true, candidate });
    expect(bgCalls.find((call) => call.name === "linkEditorFolder")?.args[1]).toBe(adminId);
    expect((await auditSince(mark, "integration.editor_folder.link"))[0]).toMatchObject(viaMcp);

    const mappingId = crypto.randomUUID();
    await ok("admin_resolve_autohdr_mapping", { mappingId, chosenPathKey: "/final/x", verifiedFolderId: "id:f" });
    await ok("admin_reassign_autohdr_path_claim", { pathKey: "/final/x", targetMappingId: mappingId, verifiedFolderId: "id:f" });
    const resolve = bgCalls.find((call) => call.name === "resolveAutoHdrMapping")!;
    const reassign = bgCalls.find((call) => call.name === "reassignAutoHdrPathClaim")!;
    expect(resolve.args.slice(0, 4)).toEqual([mappingId, "/final/x", "id:f", adminId]);
    expect(reassign.args.slice(0, 4)).toEqual(["/final/x", mappingId, "id:f", adminId]);
  });

  it("AutoHDR: send, fetch edited, and job retry", async () => {
    const projectId = await newProject(); const mark = await maxRowid();
    expect(json(await ok("admin_send_to_autohdr", { projectId })).jobId).toBe("job-send");
    expect(bgCalls.find((call) => call.name === "sendSelectedToAutoHdr")?.args).toEqual([projectId, adminId]);
    expect((await auditSince(mark, "project.send_to_autohdr"))[0]).toMatchObject(viaMcp);
    expect(json(await ok("admin_fetch_edited_from_autohdr", { projectId })).jobId).toBe("job-fetch");
    expect((await auditSince(mark, "project.fetch_edited"))[0]).toMatchObject(viaMcp);

    const jobId = crypto.randomUUID(); const now = Date.now();
    await DB.prepare("INSERT INTO jobs (id, kind, status, project_id, retries, created_at, updated_at) VALUES (?, 'editor_sync', 'failed', ?, 0, ?, ?)").bind(jobId, projectId, now, now).run();
    expect(json(await ok("admin_retry_job", { jobId })).jobId).toBe("job-editor-sync");
    expect((await auditSince(mark, "job.retry"))[0]).toMatchObject(viaMcp);
  });

  it("dead-letter replay re-queues the asset and marks the event replayed", async () => {
    const projectId = await newProject(); const now = Date.now();
    const collection = crypto.randomUUID(); const assetId = crypto.randomUUID(); const eventId = crypto.randomUUID();
    await DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?)").bind(collection, projectId, now, now).run();
    await DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'dlq.jpg', 10, 'upload', ?, ?)").bind(assetId, collection, `admin/${assetId}.jpg`, now, now).run();
    await DB.prepare("INSERT INTO rendition_dlq_events (id, asset_id, status, received_at) VALUES (?, ?, 'open', ?)").bind(eventId, assetId, now).run();
    const mark = await maxRowid(); const previous = [holder.RENDITIONS_ENABLED, holder.RENDITION_QUEUE];
    holder.RENDITIONS_ENABLED = true; holder.RENDITION_QUEUE = { send: async (message: unknown) => { renditionSends.push(message); } };
    try { await ok("admin_replay_dead_letter", { deadLetterId: eventId }); }
    finally { [holder.RENDITIONS_ENABLED, holder.RENDITION_QUEUE] = previous as [boolean | undefined, unknown]; }
    expect(renditionSends).toContainEqual({ type: "generate_renditions", assetId });
    expect((await DB.prepare("SELECT status FROM rendition_dlq_events WHERE id = ?").bind(eventId).first<{ status: string }>())!.status).toBe("replayed");
    expect((await auditSince(mark, "rendition.dlq.replay"))[0]).toMatchObject(viaMcp);
  });

  it("webhook-event replay puts a poison event back and wakes the Tonomo processor", async () => {
    const eventId = crypto.randomUUID(); const mark = await maxRowid();
    await DB.prepare("INSERT INTO webhook_events (id, source, event_id, payload_json, status, error, received_at, processed_at) VALUES (?, 'tonomo', ?, '{}', 'poison', 'boom', ?, ?)").bind(eventId, `poison-${eventId}`, Date.now(), Date.now()).run();
    await ok("admin_retry_webhook_event", { eventId });
    expect((await DB.prepare("SELECT status FROM webhook_events WHERE id = ?").bind(eventId).first<{ status: string }>())!.status).toBe("received");
    expect(bgCalls.some((call) => call.name === "processTonomoEvents")).toBe(true);
    expect((await auditSince(mark, "tonomo_event.retry"))[0]).toMatchObject(viaMcp);
  });

  it("Agencies, agents and Stages", async () => {
    const mark = await maxRowid();
    const agency = json(await ok("admin_create_agency", { name: "Harbour Realty", notes: "VIP" }));
    expect(agency).toMatchObject({ name: "Harbour Realty", notes: "VIP" });
    expect(json(await ok("admin_update_agency", { agencyId: agency.id, notes: null }))).toMatchObject({ id: agency.id, notes: null });
    const agent = json(await ok("admin_create_agent", { agencyId: agency.id, name: "Pat Agent", email: "pat@example.test", phone: null }));
    expect(agent).toMatchObject({ name: "Pat Agent", agencyId: agency.id });
    expect(json(await ok("admin_update_agent", { agentId: agent.id, phone: "0400 000 000" }))).toMatchObject({ id: agent.id, phone: "0400 000 000" });
    for (const action of ["agency.create", "agency.update", "agent.create", "agent.update"]) expect((await auditSince(mark, action))[0], action).toMatchObject(viaMcp);

    const key = "raw_review";
    const before = (await DB.prepare("SELECT label FROM pipeline_stages WHERE key = ?").bind(key).first<{ label: string }>())?.label;
    const renamed = json(await ok("admin_update_stage", { key, label: "Raw review (renamed)" }));
    expect(renamed).toMatchObject({ key, label: "Raw review (renamed)" });
    await ok("admin_update_stage", { key, label: before ?? "Raw review" });
    expect((await auditSince(mark, "pipeline_stage.update"))[0]).toMatchObject(viaMcp);
  });

  it("backfills pass their plain JSON through", async () => {
    const mark = await maxRowid();
    await ok("admin_backfill_renditions", { dryRun: true, limit: 5 });
    expect(bgCalls.find((call) => call.name === "backfillRenditions")?.args[0]).toEqual({ dryRun: true, limit: 5 });
    await ok("admin_backfill_autohdr", { dryRun: true });
    expect(bgCalls.some((call) => call.name === "backfillAutoHdrV2")).toBe(true);
    expect(json(await ok("admin_backfill_autohdr_scaffolds", { dryRun: true, limit: 3 }))).toMatchObject({ dryRun: true });
    expect((await auditSince(mark, "rendition.backfill.request"))[0]).toMatchObject(viaMcp);
    expect((await auditSince(mark, "admin.autohdr_scaffold_backfill.dry_run"))[0]).toMatchObject(viaMcp);
  });
});

/** The never-list (spec 699 "Never through MCP"): nothing here may be a tool, and nothing here may be on the allowlist under any scope. */
const DENYLIST: ReadonlyArray<{ id: string; method: "ANY" | "NON_GET"; path: RegExp; why: string }> = [
  { id: "auth", method: "ANY", path: /^\/api\/auth(\/|$)/, why: "OAuth, sessions and impersonation start/stop live under /api/auth" },
  { id: "oauth-and-mcp", method: "ANY", path: /^\/(oauth|mcp|\.well-known)(\/|$)/, why: "the authorization server and the MCP door itself" },
  { id: "users-writes", method: "NON_GET", path: /^\/api\/users(\/|$)/, why: "role, active and provisioning changes" },
  { id: "users-subroutes", method: "ANY", path: /^\/api\/users\//, why: "every settings, flag and freeze toggle sits under /api/users/" },
  { id: "settings-flags-freeze", method: "ANY", path: /(^|\/)[a-z-]*(settings?|flags?|freeze)(\/|$)/, why: "feature flags and *-settings toggles (mcp_access, impersonation, HEIC, external freeze)" },
  { id: "connected-apps", method: "ANY", path: /connected-apps/, why: "Connected apps, including revoke-all" },
  { id: "impersonation", method: "ANY", path: /impersonat/, why: "impersonation" },
  { id: "dropbox-oauth", method: "ANY", path: /^\/api\/integrations\/dropbox\/(connect-url|callback)$/, why: "Dropbox OAuth" },
  { id: "uploads", method: "ANY", path: /^\/api\/(uploads|external-uploads)(\/|$)/, why: "upload transfers" },
  { id: "upload-manifest", method: "ANY", path: /\/upload-manifest$/, why: "upload manifests" },
  { id: "documents", method: "ANY", path: /^\/api\/projects\/[^/]+\/documents(\/|$)/, why: "document uploads" },
  { id: "embedded-media-writes", method: "NON_GET", path: /^\/api\/projects\/[^/]+\/embedded-media(\/|$)/, why: "embedded media uploads" },
];
const NAME_DENY = /role|impersonat|flag|setting|revoke|upload/;
/** A tool whose name trips NAME_DENY legitimately would be listed here with a reason. None does. */
const NAME_EXCEPTIONS: readonly string[] = [];
const denied = (method: string, path: string) => DENYLIST.filter((rule) => rule.path.test(path) && (rule.method === "ANY" || method !== "GET"));

describe("the never-list", () => {
  it("no allowlisted route, under any scope, matches a denied pattern", () => {
    for (const route of MCP_ALLOWED_ROUTES) {
      // GET /api/users is the one allowlisted read under the users prefix (admin_list_users); it carries no write.
      expect(denied(route.method, route.template).map((rule) => rule.id), `${route.method} ${route.template}`).toEqual([]);
    }
  });

  it("every denied pattern matches a real route, so the list cannot rot into a typo", () => {
    const real = app.routes.map((route) => ({ method: route.method.toUpperCase(), path: route.path }));
    for (const rule of DENYLIST) {
      const hit = real.some((route) => rule.path.test(route.path) && (rule.method === "ANY" || !["GET", "HEAD", "OPTIONS"].includes(route.method)));
      expect(hit, `${rule.id}: ${rule.why}`).toBe(true);
    }
  });

  it("the real routes the spec names are caught", () => {
    for (const [method, path] of [
      ["PATCH", "/api/users/x1"], ["POST", "/api/users"], ["PATCH", "/api/users/mcp-settings"], ["PATCH", "/api/users/impersonation-settings"],
      ["PATCH", "/api/users/embedded-heic-settings"], ["PATCH", "/api/users/external-provisioning-freeze"], ["DELETE", "/api/connected-apps/x1"],
      ["POST", "/api/admin/connected-apps/revoke-all"], ["POST", "/api/auth/admin/impersonate-user"], ["POST", "/api/auth/admin/stop-impersonating"],
      ["POST", "/api/uploads/presign"], ["PUT", "/api/uploads/direct"], ["POST", "/api/external-uploads"], ["POST", "/api/projects/x1/upload-manifest"],
      ["POST", "/api/projects/x1/embedded-media"], ["POST", "/api/projects/x1/documents/presign"], ["POST", "/api/integrations/dropbox/connect-url"],
      ["GET", "/api/integrations/dropbox/callback"], ["POST", "/oauth/token"], ["POST", "/mcp"],
    ] as const) expect(denied(method, path).length, `${method} ${path}`).toBeGreaterThan(0);
    // A legitimate admin read under the users prefix is not caught by the write rules.
    expect(denied("GET", "/api/users").map((rule) => rule.id)).toEqual([]);
  });

  it("no tool is named for a forbidden capability", () => {
    for (const tool of MCP_TOOLS) {
      if (NAME_EXCEPTIONS.includes(tool.name)) continue;
      expect(NAME_DENY.test(tool.name), tool.name).toBe(false);
    }
  });

  it("the dispatcher refuses every denied route even when called directly", async () => {
    const { isAllowedMcpRoute } = await import("../src/mcp/route-allowlist");
    for (const [method, path] of [["PATCH", "/api/users/x1"], ["POST", "/api/users"], ["PATCH", "/api/users/mcp-settings"], ["DELETE", "/api/connected-apps/x1"], ["POST", "/api/admin/connected-apps/revoke-all"], ["POST", "/api/auth/admin/impersonate-user"], ["POST", "/api/uploads/presign"], ["POST", "/api/integrations/dropbox/connect-url"]] as const) {
      expect(isAllowedMcpRoute(method, path), `${method} ${path}`).toBe(false);
    }
  });
});

describe("delete_project: the server-enforced confirm round trip", () => {
  /** An archived Project holding two RAW assets, a comment, a Subtask and a Tonomo order id. */
  async function doomed() {
    const projectId = await newProject({ orderId: `ORD-${crypto.randomUUID().slice(0, 8)}` });
    const now = Date.now(); const collectionId = crypto.randomUUID();
    await DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 2, ?, ?)").bind(collectionId, projectId, now, now).run();
    for (const name of ["a.jpg", "b.jpg"]) await DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, 10, 'upload', ?, ?)").bind(crypto.randomUUID(), collectionId, `doomed/${projectId}/${name}`, name, now, now).run();
    await ok("add_project_comment", { projectId, text: "Remember the gate code" });
    await ok("create_subtask", { projectId, title: "Colour grade" });
    await ok("archive_project", { projectId });
    return { projectId, collectionId };
  }
  const exists = async (projectId: string) => (await DB.prepare("SELECT 1 AS n FROM projects WHERE id = ?").bind(projectId).first()) !== null;
  const tokenFrom = (text: string) => /"confirmToken":\s*"([^"]+)"/.exec(text)?.[1] ?? /confirmToken[^A-Za-z0-9_.-]+([A-Za-z0-9_.-]+)/.exec(text)?.[1] ?? "";

  it("the first call destroys nothing and reports what would be destroyed, with a token", async () => {
    const { projectId } = await doomed(); const mark = await maxRowid();
    const result = await run("delete_project", { projectId });
    const text = result.content[0]!.text;
    expect(result.isError).toBeUndefined();
    expect(text).toMatch(/^Confirmation required/);
    const token = tokenFrom(text);
    expect(token.length).toBeGreaterThan(20);
    expect(text).toContain("Admin Street");
    expect(text).toMatch(/"raw":\s*2/);
    expect(text).toMatch(/"comments":\s*1/);
    expect(text).toMatch(/"subtasks":\s*1/);
    expect(text).toMatch(/whiteboard/i);
    expect(text).toMatch(/Tonomo/i);
    expect(await exists(projectId)).toBe(true);
    const deletes = (await DB.prepare("SELECT 1 FROM audit_log WHERE rowid > ? AND action = 'project.delete'").bind(mark).all()).results;
    expect(deletes).toEqual([]);
  });

  it("a Project that is not archived is refused up front, with nothing to confirm", async () => {
    const projectId = await newProject();
    expect(await refused("delete_project", { projectId })).toMatch(/Only an archived Project/i);
    expect(await exists(projectId)).toBe(true);
  });

  it("confirm without a token, or a token without confirm, deletes nothing", async () => {
    const { projectId } = await doomed();
    expect(await refused("delete_project", { projectId, confirm: true })).toMatch(/confirmToken/);
    const token = tokenFrom(await ok("delete_project", { projectId }));
    const again = await run("delete_project", { projectId, confirmToken: token });
    expect(again.content[0]!.text).toMatch(/^Confirmation required/);
    expect(await exists(projectId)).toBe(true);
  });

  it("a token minted on another connection or for another Project is refused", async () => {
    const first = await doomed(); const second = await doomed();
    const token = tokenFrom(await ok("delete_project", { projectId: first.projectId }, "conn-a"));
    expect(await refused("delete_project", { projectId: first.projectId, confirm: true, confirmToken: token }, "conn-b")).toMatch(/not valid|does not match|re-confirm/i);
    expect(await refused("delete_project", { projectId: second.projectId, confirm: true, confirmToken: token }, "conn-a")).toMatch(/not valid|does not match|re-confirm/i);
    expect(await refused("delete_project", { projectId: first.projectId, confirm: true, confirmToken: `${token}x` }, "conn-a")).toMatch(/not valid|does not match|re-confirm/i);
    expect(await exists(first.projectId)).toBe(true); expect(await exists(second.projectId)).toBe(true);
  });

  it("an expired token is refused", async () => {
    const { projectId } = await doomed();
    const first = await ok("delete_project", { projectId });
    const live = tokenFrom(first);
    const summaryHash = live.split(".")[1]!;
    const expired = await signConfirmToken(testEnv.MCP_DOWNLOAD_SECRET!, { connectionId: "conn-a", projectId, summaryHash, exp: Math.floor(Date.now() / 1000) - 1 });
    expect(await refused("delete_project", { projectId, confirm: true, confirmToken: expired })).toMatch(/expired/i);
    expect(CONFIRM_TTL_SECONDS).toBe(300);
    const exp = Number(live.split(".")[0]);
    expect(exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(300);
    expect(exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(290);
    expect(await exists(projectId)).toBe(true);
  });

  it("a Project that changed after the summary is refused, and nothing is deleted", async () => {
    const { projectId, collectionId } = await doomed();
    const token = tokenFrom(await ok("delete_project", { projectId }));
    const now = Date.now();
    await DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'late.jpg', 10, 'upload', ?, ?)").bind(crypto.randomUUID(), collectionId, `doomed/${projectId}/late.jpg`, now, now).run();
    expect(await refused("delete_project", { projectId, confirm: true, confirmToken: token })).toMatch(/Project changed; re-confirm/i);
    expect(await exists(projectId)).toBe(true);
    // The fresh summary now sees three assets and issues a token that works.
    const fresh = await ok("delete_project", { projectId });
    expect(fresh).toMatch(/"raw":\s*3/);
  });

  it("the confirmed call dispatches the real delete: purge, tombstone and an audit row that says via MCP", async () => {
    const { projectId } = await doomed(); const mark = await maxRowid();
    const orderId = (await DB.prepare("SELECT order_id FROM projects WHERE id = ?").bind(projectId).first<{ order_id: string }>())!.order_id;
    const token = tokenFrom(await ok("delete_project", { projectId }));
    const done = json(await ok("delete_project", { projectId, confirm: true, confirmToken: token }));
    expect(done).toMatchObject({ ok: true });
    expect(await exists(projectId)).toBe(false);
    expect((await DB.prepare("SELECT deleted_project_id FROM tonomo_order_tombstones WHERE order_id = ?").bind(orderId).first<{ deleted_project_id: string }>())?.deleted_project_id).toBe(projectId);
    const metas = await auditSince(mark, "project.delete");
    expect(metas[0]).toMatchObject({ ...viaMcp, assetCount: 2 });
    // The token cannot be replayed: the Project is gone.
    expect(await refused("delete_project", { projectId, confirm: true, confirmToken: token })).toMatch(/^HTTP (403|404):/);
  });
});

describe("a background call carries via", () => {
  it("the app hands the MCP provenance to the background Worker on the audited AutoHDR mapping calls", async () => {
    const mappingId = crypto.randomUUID();
    await ok("admin_resolve_autohdr_mapping", { mappingId, chosenPathKey: "/final/y", verifiedFolderId: "id:y" });
    await ok("admin_reassign_autohdr_path_claim", { pathKey: "/final/y", targetMappingId: mappingId, verifiedFolderId: "id:y" });
    const expectedVia = { clientName: CLIENT, connectionId: "conn-a" };
    expect(bgCalls.find((call) => call.name === "resolveAutoHdrMapping")?.args[4]).toEqual(expectedVia);
    expect(bgCalls.find((call) => call.name === "reassignAutoHdrPathClaim")?.args[4]).toEqual(expectedVia);
  });
});
