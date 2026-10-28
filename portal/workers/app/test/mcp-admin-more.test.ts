import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { ADMIN_MORE_TOOLS } from "../src/mcp/tools/admin-more";
import { toolsFor } from "../src/mcp/tools/registry";
import { mcpHarness } from "./mcp-oauth-support";
import { seedAsset, seedCoverage } from "./mcp-admin-fixtures";

/**
 * The remaining admin tools (#973): the admin routes an audit against the allowlist found with no tool
 * (docs/plans/959-admin-mcp-audit.md). Exercised through `/mcp` only: tools/list per role and scope, and tools/call results that
 * equal the cookie route's for the same input, with the route's audit row marked via MCP.
 */
declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;
const testEnv = env as unknown as Env;
const h = mcpHarness(testEnv);
const DB = h.DB;

const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const editorId = "b9730000-0000-4000-8000-000000000001";
const photographerId = "b9730000-0000-4000-8000-000000000002";
const externalId = "b9730000-0000-4000-8000-000000000003";
const WRITES = ["admin_sync_delivery_review_links", "admin_reprobe_video_versions", "admin_set_project_cover", "admin_add_project_photographer", "admin_remove_project_photographer"];
const READS = ["admin_list_integrations", "admin_get_autohdr_status"];
const tokens: Record<string, { accessToken: string; connectionId: string }> = {};

const names = async (who: string) => (await h.toolsList(tokens[who]!.accessToken)).map((tool) => tool.name);
const maxRowid = async () => (await DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log").first<{ n: number }>())!.n;
async function auditSince(mark: number, action: string) {
  const rows = (await DB.prepare("SELECT meta_json FROM audit_log WHERE rowid > ? AND action = ?").bind(mark, action).all<{ meta_json: string | null }>()).results;
  expect(rows.length, action).toBeGreaterThan(0);
  return rows.map((row) => JSON.parse(row.meta_json ?? "{}") as Record<string, unknown>);
}
const viaMcp = () => ({ via: "mcp", client: "Test Client", connectionId: tokens.admin!.connectionId });
async function newProject(archived = false) {
  const id = crypto.randomUUID(); const now = Date.now();
  await DB.prepare("INSERT INTO projects (id, street, stage_key, board_revision, archived_at, created_at, updated_at) VALUES (?, 'More Street', 'edited_review', 0, ?, ?, ?)").bind(id, archived ? now : null, now, now).run();
  return id;
}
/** The tool's JSON, with the call asserted not to be an error. */
async function call(name: string, args: Record<string, unknown>, who = "admin") {
  const outcome = await h.callTool(tokens[who]!.accessToken, name, args);
  expect(outcome.result?.isError, `${name}: ${JSON.stringify(outcome)}`).toBeUndefined();
  return JSON.parse(outcome.result!.content[0]!.text) as unknown;
}
/** The cookie route's answer for the same input. */
async function cookie(method: string, path: string, body?: unknown) {
  const response = method === "GET" ? await h.asCookie("admin", path)
    : await SELF.fetch(`${h.ORIGIN}${path}`, { method, headers: { cookie: h.cookies.admin!, origin: h.ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  expect(response.status, await response.clone().text()).toBe(200);
  return await response.json() as unknown;
}

beforeAll(async () => {
  await h.executeSql(__PORTAL_MIGRATION_SQL__); await h.executeSql(__PORTAL_SEED_SQL__);
  await DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'mcp_access'").run();
  await h.addUser(editorId, "editor"); await h.addUser(photographerId, "photographer"); await h.addUser(externalId, "external_editor");
  for (const [name, id] of [["admin", adminId], ["editor", editorId], ["photographer", photographerId], ["external", externalId]] as const) await h.addSession(name, id);
  tokens.admin = await h.connect("read write admin", "admin");
  tokens.adminRW = await h.connect("read write", "admin");
  tokens.adminRead = await h.connect("read", "admin");
  for (const who of ["editor", "photographer", "external"]) tokens[who] = await h.connect("read write", who);
});
beforeEach(() => { delete (testEnv as { MCP_CALLS?: unknown }).MCP_CALLS; delete (testEnv as { MCP_WRITES?: unknown }).MCP_WRITES; });

describe("tools/list: the #973 tools follow the role and the granted scopes", () => {
  it("an admin with the admin grant sees all of them; each write is admin scope and destructive, each read is read-only", async () => {
    const list = await h.toolsList(tokens.admin!.accessToken);
    for (const name of [...WRITES, ...READS]) expect(list.map((tool) => tool.name), name).toContain(name);
    for (const name of WRITES) expect(list.find((tool) => tool.name === name)!.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    for (const name of READS) expect(list.find((tool) => tool.name === name)!.annotations, name).toMatchObject({ readOnlyHint: true });
    expect(ADMIN_MORE_TOOLS.map((tool) => tool.name).sort()).toEqual([...WRITES, ...READS].sort());
    for (const tool of ADMIN_MORE_TOOLS) expect(tool.scope, tool.name).toBe(WRITES.includes(tool.name) ? "admin" : "read");
  });
  it("without the admin grant an admin keeps the reads but sees no #973 write", async () => {
    for (const who of ["adminRW", "adminRead"]) {
      const list = await names(who);
      for (const name of WRITES) expect(list, `${who} ${name}`).not.toContain(name);
      for (const name of READS) expect(list, `${who} ${name}`).toContain(name);
    }
  });
  it("Editors, Photographers and External editors see none of them, whatever the scopes say", async () => {
    for (const who of ["editor", "photographer", "external"]) {
      const list = await names(who);
      for (const name of [...WRITES, ...READS]) expect(list, `${who} ${name}`).not.toContain(name);
    }
    for (const role of ["editor", "photographer", "external_editor"]) {
      expect(toolsFor(role, ["read", "write", "admin"]).filter((tool) => [...WRITES, ...READS].includes(tool.name)), role).toEqual([]);
    }
  });
});

describe("tools/call: each tool returns what its cookie route returns, audited via MCP", () => {
  it("admin_sync_delivery_review_links: a dry run equals the route's, and a real run is audited via MCP", async () => {
    const projectId = await newProject(); const now = Date.now();
    await DB.prepare("INSERT INTO delivery_pages (project_id, slug, enabled, latest_set_number, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)").bind(projectId, `more-${projectId}`, now, now).run();
    const dry = await call("admin_sync_delivery_review_links", { dryRun: true, limit: 10 });
    expect(dry).toEqual(await cookie("POST", "/api/admin/delivery-review-links/sync", { dryRun: true, limit: 10 }));
    expect(dry).toMatchObject({ dryRun: true, scanned: 1, wouldCreate: 0, nextCursor: null });

    // A cursor past every page: the real run scans nothing, so the parity holds, and the summary audit row still lands.
    const mark = await maxRowid(); const pastAll = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const real = await call("admin_sync_delivery_review_links", { cursor: pastAll });
    expect(real).toEqual({ dryRun: false, scanned: 0, created: 0, changed: 0, nextCursor: null });
    expect(real).toEqual(await cookie("POST", "/api/admin/delivery-review-links/sync", { cursor: pastAll }));
    expect((await auditSince(mark, "admin.delivery_review_backfill"))[0]).toMatchObject(viaMcp());
  });

  it("admin_reprobe_video_versions: a dry run (the default) equals the route's and writes nothing; a real run is audited via MCP", async () => {
    const mark = await maxRowid();
    const dry = await call("admin_reprobe_video_versions", {});
    expect(dry).toEqual(await cookie("POST", "/api/admin/video-versions/reprobe", {}));
    expect(dry).toMatchObject({ dryRun: true, scanned: 0, items: [], nextCursor: null });
    expect(await maxRowid()).toBe(mark);

    const real = await call("admin_reprobe_video_versions", { dryRun: false, limit: 2 });
    expect(real).toEqual({ dryRun: false, scanned: 0, items: [], nextCursor: null });
    expect((await auditSince(mark, "admin.video_probe_backfill"))[0]).toMatchObject(viaMcp());
  });

  it("admin_set_project_cover: sets and clears the cover as the route does, audited via MCP; an archived Project is refused", async () => {
    const projectId = await newProject(); const { assetId } = await seedAsset(DB, projectId);
    const mark = await maxRowid();
    expect(await call("admin_set_project_cover", { projectId, assetId })).toEqual({ coverAssetId: assetId });
    expect((await DB.prepare("SELECT cover_asset_id AS cover FROM projects WHERE id = ?").bind(projectId).first<{ cover: string | null }>())!.cover).toBe(assetId);
    expect((await auditSince(mark, "project.cover.set"))[0]).toMatchObject(viaMcp());
    expect(await call("admin_set_project_cover", { projectId, assetId: null })).toEqual(await cookie("POST", `/api/projects/${projectId}/cover`, { assetId: null }));

    const archived = await newProject(true);
    const refused = await h.callTool(tokens.admin!.accessToken, "admin_set_project_cover", { projectId: archived, assetId: null });
    expect(refused.result?.isError).toBe(true);
    expect(refused.result!.content[0]!.text).toMatch(/^HTTP 409: .*cover_project_archived/);
  });

  it("admin_list_integrations and admin_get_autohdr_status equal their cookie routes", async () => {
    const projectId = await newProject();
    await seedCoverage(DB, projectId, adminId);
    expect(await call("admin_list_integrations", {})).toEqual(await cookie("GET", "/api/integrations"));
    expect(await call("admin_get_autohdr_status", { projectId })).toEqual(await cookie("GET", `/api/projects/${projectId}/autohdr-status`));
    const listed = await call("admin_list_integrations", {}) as { integrations: Record<string, unknown>[] };
    expect(listed.integrations.length).toBeGreaterThan(0);
    for (const row of listed.integrations) expect(row).not.toHaveProperty("encryptedCredentials");
  });

  it("admin_add_project_photographer and admin_remove_project_photographer: add, then remove behind the route's confirmation, audited via MCP", async () => {
    const projectId = await newProject(); const mark = await maxRowid();
    const added = await call("admin_add_project_photographer", { projectId, userId: photographerId }) as { outcome: string; membership: { id: string } };
    expect(added.outcome).toBe("created");
    expect(await call("admin_add_project_photographer", { projectId, userId: photographerId })).toMatchObject({ outcome: "unchanged", membership: { id: added.membership.id } });
    const membershipCycle = added.membership.id;
    expect((await auditSince(mark, "project.member.add"))[0]).toMatchObject(viaMcp());

    // The Photographer holds a Subtask, so the route asks before clearing it: the first call relays that and changes nothing.
    await call("create_subtask", { projectId, title: "Drone shots", assigneeIds: [photographerId] });
    const first = await h.callTool(tokens.admin!.accessToken, "admin_remove_project_photographer", { projectId, userId: photographerId, membershipCycle });
    expect(first.result?.isError).toBeUndefined();
    expect(first.result!.content[0]!.text).toMatch(/^Confirmation required: .*Pass confirmedAssignmentCount: 1 with it\.$/s);
    const member = () => DB.prepare("SELECT 1 AS one FROM project_members WHERE project_id = ? AND user_id = ? AND role_on_project = 'photographer'").bind(projectId, photographerId).first();
    expect(await member()).not.toBeNull();
    expect(await call("admin_remove_project_photographer", { projectId, userId: photographerId, membershipCycle, confirm: true, confirmedAssignmentCount: 1 }))
      .toMatchObject({ outcome: "removed", removed: { membershipCycle, userId: photographerId, roleOnProject: "photographer" }, subtaskAssignmentsCleared: 1 });
    expect(await member()).toBeNull();
    expect((await auditSince(mark, "project.member.remove"))[0]).toMatchObject(viaMcp());

    // An archived Project's team is read-only: the route's refusal passes through unchanged.
    const archived = await newProject(true);
    const refused = await h.callTool(tokens.admin!.accessToken, "admin_add_project_photographer", { projectId: archived, userId: photographerId });
    expect(refused.result?.isError).toBe(true);
    expect(refused.result!.content[0]!.text).toMatch(/^HTTP 409: .*membership_project_archived/);
  });

  it("an admin without the admin grant cannot call a #973 write", async () => {
    const outcome = await h.callTool(tokens.adminRW!.accessToken, "admin_reprobe_video_versions", {});
    expect(outcome.error !== undefined || outcome.result?.isError === true).toBe(true);
  });
});
