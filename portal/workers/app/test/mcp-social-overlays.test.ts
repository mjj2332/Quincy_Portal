import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { SOCIAL_OVERLAY_TOOLS } from "../src/mcp/tools/social-overlays";
import { mcpHarness } from "./mcp-oauth-support";

/** #970: the Social overlay library (Admin) and a Project's selection, all through /mcp, compared with the cookie routes. */

declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;
const testEnv = env as unknown as Env;
const h = mcpHarness(testEnv);
const DB = h.DB;

const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const editorId = "b9700000-0000-4000-8000-000000000001";
const photographerId = "b9700000-0000-4000-8000-000000000002";
const externalId = "b9700000-0000-4000-8000-000000000003";
const project = "c9700000-0000-4000-8000-000000000001";
const archivedProject = "c9700000-0000-4000-8000-000000000002";
const defaultId = "d9700000-0000-4000-8000-000000000001";
const otherId = "d9700000-0000-4000-8000-000000000002";
const thirdId = "d9700000-0000-4000-8000-000000000003";
const CLIENT = "Test Client";
const tokens: Record<string, { accessToken: string; connectionId: string }> = {};

const ADMIN_NAMES = ["admin_list_social_overlays", "admin_update_social_overlay", "admin_archive_social_overlay", "admin_unarchive_social_overlay"];
const ADMIN_SCOPE = ADMIN_NAMES.slice(1);

beforeAll(async () => {
  await h.executeSql(__PORTAL_MIGRATION_SQL__); await h.executeSql(__PORTAL_SEED_SQL__);
  await DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'mcp_access'").run();
  await h.addUser(editorId, "editor"); await h.addUser(photographerId, "photographer"); await h.addUser(externalId, "external_editor");
  for (const [name, id] of [["admin", adminId], ["editor", editorId], ["photographer", photographerId], ["external", externalId]] as const) await h.addSession(name, id);
  const now = Date.now();
  for (const id of [project, archivedProject]) {
    await DB.prepare("INSERT INTO projects (id, street, stage_key, archived_at, created_at, updated_at) VALUES (?, 'Overlay Street', 'awaiting_raw', ?, ?, ?)").bind(id, id === archivedProject ? now : null, now, now).run();
  }
  await DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), project, externalId, now).run();
  await DB.batch([
    DB.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES ('video_review', 1, ?)").bind(now),
    DB.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES (?, 1, ?)").bind(`video_review_pilot:${project}`, now),
    DB.prepare("INSERT INTO feature_flags (key, enabled, updated_at) VALUES (?, 1, ?)").bind(`video_review_pilot:${archivedProject}`, now),
  ]);
  for (const [id, name, isDefault] of [[defaultId, "Default", 1], [otherId, "Reels", 0], [thirdId, "Shorts", 0]] as const) {
    await DB.prepare("INSERT INTO social_overlays (id, name, platform_label, image_key, width, height, bytes, is_default, created_by, updated_by, created_at, updated_at) VALUES (?, ?, 'Platform', ?, 1080, 1920, 100, ?, ?, ?, ?, ?)")
      .bind(id, name, `social-overlays/${id}/${crypto.randomUUID()}.png`, isDefault, adminId, adminId, now, now).run();
  }
  tokens.adminReadOnly = await h.connect("read", "admin");
  tokens.adminRW = await h.connect("read write", "admin");
  tokens.admin = await h.connect("read write admin", "admin");
  for (const name of ["editor", "photographer", "external"] as const) tokens[name] = await h.connect("read write", name);
});
beforeEach(() => { delete (testEnv as { MCP_CALLS?: unknown }).MCP_CALLS; delete (testEnv as { MCP_WRITES?: unknown }).MCP_WRITES; });

const names = async (who: string) => (await h.toolsList(tokens[who]!.accessToken)).map((tool) => tool.name);
type Result = { content: { text: string }[]; isError?: boolean };
const text = (result?: Result) => result!.content[0]!.text;
const call = (who: string, tool: string, args: Record<string, unknown>) => h.callTool(tokens[who]!.accessToken, tool, args);
const json = (result?: Result) => JSON.parse(text(result)) as Record<string, any>;
const projectPath = (id = project) => `/api/projects/${id}/social-overlays`;
const cookiePut = (who: string, path: string, body: unknown) =>
  SELF.fetch(`${h.ORIGIN}${path}`, { method: "PUT", headers: { cookie: h.cookies[who]!, origin: h.ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
const refused = (r: { result?: Result; error?: unknown }) => r.error !== undefined || r.result?.isError === true;
const lastRowid = async () => (await DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log").first<{ n: number }>())!.n;

describe("tools/list", () => {
  it("offers the Admin library tools only to an admin; the three writes need the admin grant", async () => {
    expect(await names("admin")).toEqual(expect.arrayContaining(ADMIN_NAMES));
    const rw = await names("adminRW");
    expect(rw).toContain("admin_list_social_overlays");
    for (const name of ADMIN_SCOPE) expect(rw, name).not.toContain(name);
    const readOnly = await names("adminReadOnly");
    expect(readOnly).toContain("admin_list_social_overlays");
    for (const who of ["editor", "photographer", "external"]) for (const name of ADMIN_NAMES) expect(await names(who), `${who} ${name}`).not.toContain(name);
  });
  it("offers the Project selection per capability: read to whoever holds viewVideo, set to admin and editor", async () => {
    for (const who of ["admin", "editor", "external"]) expect(await names(who), who).toContain("get_project_social_overlays");
    expect(await names("photographer")).not.toContain("get_project_social_overlays");
    for (const who of ["admin", "editor"]) expect(await names(who), who).toContain("set_project_social_overlays");
    for (const who of ["photographer", "external"]) expect(await names(who), who).not.toContain("set_project_social_overlays");
    expect(await names("adminReadOnly")).not.toContain("set_project_social_overlays");
  });
  it("annotates the reads read-only, the admin writes destructive and the selection a non-destructive write", async () => {
    const list = await h.toolsList(tokens.admin!.accessToken) as { name: string; annotations?: Record<string, boolean> }[];
    for (const name of ["admin_list_social_overlays", "get_project_social_overlays"]) expect(list.find((tool) => tool.name === name)!.annotations?.readOnlyHint, name).toBe(true);
    for (const name of ADMIN_SCOPE) expect(list.find((tool) => tool.name === name)!.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(list.find((tool) => tool.name === "set_project_social_overlays")!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(SOCIAL_OVERLAY_TOOLS.filter((tool) => tool.scope === "admin").map((tool) => tool.name).sort()).toEqual([...ADMIN_SCOPE].sort());
  });
  it("has no tool that creates an overlay or replaces its image (an upload)", async () => {
    for (const name of await names("admin")) expect(name).not.toMatch(/create_social_overlay|overlay_image/);
  });
});

describe("the Admin library matches the cookie route", () => {
  it("admin_list_social_overlays returns the cookie route's body", async () => {
    const cookie = await h.asCookie("admin", "/api/admin/social-overlays");
    expect(cookie.status).toBe(200);
    const result = await call("adminReadOnly", "admin_list_social_overlays", {});
    expect(result.result?.isError).toBeUndefined();
    expect(JSON.parse(text(result.result))).toEqual(await cookie.json());
  });
  it("an editor is not offered the list and cannot call it", async () => {
    expect(refused(await call("editor", "admin_list_social_overlays", {}))).toBe(true);
  });
  it("a read+write admin cannot call the admin writes", async () => {
    expect(refused(await call("adminRW", "admin_archive_social_overlay", { id: otherId, expectedRevision: 1 }))).toBe(true);
    expect((await DB.prepare("SELECT archived_at FROM social_overlays WHERE id = ?").bind(otherId).first<{ archived_at: number | null }>())!.archived_at).toBeNull();
  });
  it("renames, then archives and unarchives, with the route's revisions, audited via mcp", async () => {
    const mark = await lastRowid();
    const renamed = await call("admin", "admin_update_social_overlay", { id: thirdId, name: "Shorts v2", platformLabel: "TikTok", expectedRevision: 1 });
    expect(renamed.result?.isError).toBeUndefined();
    expect(json(renamed.result).overlay).toMatchObject({ id: thirdId, name: "Shorts v2", platformLabel: "TikTok", revision: 2 });
    const archived = await call("admin", "admin_archive_social_overlay", { id: thirdId, expectedRevision: 2 });
    expect(json(archived.result).overlay).toMatchObject({ revision: 3 });
    expect(json(archived.result).overlay.archivedAt).not.toBeNull();
    const back = await call("admin", "admin_unarchive_social_overlay", { id: thirdId, expectedRevision: 3 });
    expect(json(back.result).overlay).toMatchObject({ revision: 4, archivedAt: null });
    const rows = (await DB.prepare("SELECT action, meta_json FROM audit_log WHERE rowid > ? AND action LIKE 'social_overlay.%' ORDER BY rowid").bind(mark).all<{ action: string; meta_json: string }>()).results;
    expect(rows.map((row) => row.action)).toEqual(["social_overlay.rename", "social_overlay.archive", "social_overlay.unarchive"]);
    for (const row of rows) expect(JSON.parse(row.meta_json), row.action).toMatchObject({ via: "mcp", client: CLIENT });
    const overlays = (await (await h.asCookie("admin", "/api/admin/social-overlays")).json() as { overlays: { id: string; name: string }[] }).overlays;
    expect(overlays.find((overlay) => overlay.id === thirdId)!.name).toBe("Shorts v2");
  });
  it("refuses to archive the Default overlay, and a stale revision, with the route's codes", async () => {
    const result = await call("admin", "admin_archive_social_overlay", { id: defaultId, expectedRevision: 1 });
    expect(result.result?.isError).toBe(true);
    expect(text(result.result)).toMatch(/^HTTP 409: .*default_overlay/s);
    expect((await DB.prepare("SELECT archived_at FROM social_overlays WHERE id = ?").bind(defaultId).first<{ archived_at: number | null }>())!.archived_at).toBeNull();
    const stale = await call("admin", "admin_update_social_overlay", { id: otherId, name: "Reels 2", expectedRevision: 99 });
    expect(stale.result?.isError).toBe(true);
    expect(text(stale.result)).toMatch(/^HTTP 409: .*overlay_conflict/s);
  });
  it("rejects an unknown argument and a rename with nothing to change", async () => {
    expect(refused(await call("admin", "admin_archive_social_overlay", { id: otherId, expectedRevision: 1, image: "x" }))).toBe(true);
    const empty = await call("admin", "admin_update_social_overlay", { id: otherId, expectedRevision: 1 });
    expect(empty.result?.isError).toBe(true);
    expect(text(empty.result)).toMatch(/^HTTP 400/);
  });
});

describe("a Project's selection matches the cookie route", () => {
  it("get_project_social_overlays returns the cookie route's body for admin, editor and external", async () => {
    for (const who of ["admin", "editor", "external"]) {
      const cookie = await h.asCookie(who, projectPath());
      expect(cookie.status, who).toBe(200);
      const result = await call(who, "get_project_social_overlays", { projectId: project });
      expect(result.result?.isError, who).toBeUndefined();
      expect(JSON.parse(text(result.result))).toEqual(await cookie.json());
    }
  });
  it("sets the selection with the read revision; the cookie route then reads it back, audited via mcp", async () => {
    const mark = await lastRowid();
    const before = json((await call("editor", "get_project_social_overlays", { projectId: project })).result);
    const set = await call("editor", "set_project_social_overlays", { projectId: project, overlayIds: [defaultId, otherId], expectedRevision: before.revision });
    expect(set.result?.isError).toBeUndefined();
    const after = await (await h.asCookie("admin", projectPath())).json() as { selected: { id: string }[] };
    expect(after.selected.map((row) => row.id).sort()).toEqual([defaultId, otherId].sort());
    expect(JSON.parse(text(set.result))).toEqual(after);
    const rows = (await DB.prepare("SELECT action, meta_json FROM audit_log WHERE rowid > ? AND action LIKE 'project.social_overlays%'").bind(mark).all<{ action: string; meta_json: string }>()).results;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(JSON.parse(row.meta_json), row.action).toMatchObject({ via: "mcp", client: CLIENT });
  });
  it("answers as the cookie route does for the same refused input (stale revision), and for an unknown overlay", async () => {
    const stale = { overlayIds: [otherId], expectedRevision: "a".repeat(64) };
    const viaCookie = await cookiePut("admin", projectPath(), stale);
    const viaMcp = await call("admin", "set_project_social_overlays", { projectId: project, ...stale });
    expect(viaCookie.status).toBe(409);
    expect(viaMcp.result?.isError).toBe(true);
    expect(text(viaMcp.result)).toBe(`HTTP 409: ${await viaCookie.text()}`);
    const current = json((await call("admin", "get_project_social_overlays", { projectId: project })).result);
    const missing = await call("admin", "set_project_social_overlays", { projectId: project, overlayIds: [crypto.randomUUID()], expectedRevision: current.revision });
    expect(missing.result?.isError).toBe(true);
    expect(text(missing.result)).toMatch(/^HTTP 409: .*overlay_unavailable/s);
  });
  it("an archived Project is read-only", async () => {
    const current = json((await call("admin", "get_project_social_overlays", { projectId: archivedProject })).result);
    const set = await call("admin", "set_project_social_overlays", { projectId: archivedProject, overlayIds: [defaultId], expectedRevision: current.revision });
    expect(set.result?.isError).toBe(true);
    expect(text(set.result)).toMatch(/^HTTP 409: .*project_archived/s);
  });
  it("rejects a malformed revision before dispatch", async () => {
    expect(refused(await call("admin", "set_project_social_overlays", { projectId: project, overlayIds: [], expectedRevision: "nope" }))).toBe(true);
  });
});
