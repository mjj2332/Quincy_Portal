import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { MCP_ALLOWED_ROUTES, isAllowedMcpRoute } from "../src/mcp/route-allowlist";
import { MCP_TOOLS, strictInput, toolsFor } from "../src/mcp/tools/registry";
import { mcpHarness } from "./mcp-oauth-support";

declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;
const testEnv = env as unknown as Env;
const h = mcpHarness(testEnv);
const DB = h.DB;

/** Collaboration writes (#706): annotations, Notice board, review and selection, link previews. Each tool is one route; the route enforces the rules. */
const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const editorId = "b7000000-0000-4000-8000-000000000001";
const editor2Id = "b7000000-0000-4000-8000-000000000002";
const photographerId = "b7000000-0000-4000-8000-000000000003";
const externalId = "b7000000-0000-4000-8000-000000000004";
const projectId = "c7000000-0000-4000-8000-000000000001";
const archivedProjectId = "c7000000-0000-4000-8000-000000000002";
const collectionId = "d7000000-0000-4000-8000-000000000001";
const tokens: Record<string, { accessToken: string; connectionId: string }> = {};
const CLIENT = "Test Client";

const ANNOTATION = ["create_annotation", "edit_annotation", "delete_annotation"];
const NOTICE = ["create_notice_post", "edit_notice_post", "delete_notice_post"];
const REVIEW = ["set_asset_review", "select_asset_for_editing", "unselect_asset_for_editing"];
const PREVIEW = ["request_project_link_preview", "request_notice_link_preview"];
const COLLAB_NAMES = [...ANNOTATION, ...NOTICE, ...REVIEW, ...PREVIEW];
const DESTRUCTIVE = ["delete_annotation", "delete_notice_post", "unselect_asset_for_editing"];

beforeAll(async () => {
  await h.executeSql(__PORTAL_MIGRATION_SQL__); await h.executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await DB.batch([
    DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'mcp_access'"),
    DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'"),
  ]);
  for (const [id, role] of [[editorId, "editor"], [editor2Id, "editor"], [photographerId, "photographer"], [externalId, "external_editor"]] as const) await h.addUser(id, role);
  for (const [name, id] of [["admin", adminId], ["editor", editorId], ["editor2", editor2Id], ["photographer", photographerId], ["external", externalId]] as const) await h.addSession(name, id);
  for (const name of ["admin", "editor", "editor2", "photographer", "external"]) tokens[name] = await h.connect("read write", name);
  tokens.adminReadOnly = await h.connect("read", "admin");
  for (const [id, archived] of [[projectId, null], [archivedProjectId, now]] as const) await DB.prepare("INSERT INTO projects (id, street, stage_key, board_revision, archived_at, created_at, updated_at) VALUES (?, 'Collab Street', 'awaiting_raw', 0, ?, ?, ?)").bind(id, archived, now, now).run();
  for (const [userId, role] of [[photographerId, "photographer"], [externalId, "editor"], [editorId, "editor"], [editor2Id, "editor"]]) await DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), projectId, userId, role, now).run();
  await DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)").bind(crypto.randomUUID(), archivedProjectId, editorId, now).run();
  await DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?)").bind(collectionId, projectId, now, now).run();
});
beforeEach(() => { delete (testEnv as { MCP_CALLS?: unknown }).MCP_CALLS; delete (testEnv as { MCP_WRITES?: unknown }).MCP_WRITES; });

const call = (who: string, name: string, args: unknown = {}) => h.callTool(tokens[who]!.accessToken, name, args);
const plain = (result?: { content: { text: string }[] }) => result!.content[0]!.text;
const body = (result?: { content: { text: string }[] }) => JSON.parse(plain(result)) as Record<string, any>;
async function ok(who: string, name: string, args: unknown = {}) {
  const outcome = await call(who, name, args);
  expect(outcome.error, JSON.stringify(outcome)).toBeUndefined();
  expect(outcome.result?.isError, plain(outcome.result)).toBeUndefined();
  return outcome.result!;
}
const failure = async (who: string, name: string, args: unknown, status: number) => {
  const outcome = await call(who, name, args);
  expect(outcome.result?.isError, JSON.stringify(outcome)).toBe(true);
  expect(plain(outcome.result)).toMatch(new RegExp(`^HTTP ${status}:`));
  return outcome.result!;
};
async function viaCookie(who: string, method: string, path: string, payload?: unknown) {
  const response = await SELF.fetch(`${h.ORIGIN}${path}`, { method, headers: { cookie: h.cookies[who]!, origin: h.ORIGIN, ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
  return { status: response.status, text: await response.text() };
}
const normalize = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<id>").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<ts>");

async function newAsset() {
  const id = crypto.randomUUID(); const now = Date.now();
  await DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'c.jpg', 10, 'upload', ?, ?)").bind(id, collectionId, `mcp-collab/${id}.jpg`, now, now).run();
  return id;
}
const maxRowid = async () => (await DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log").first<{ n: number }>())!.n;
/** Every audit row created since the mark carries the provenance the MCP door stamps. */
async function expectProvenance(mark: number, actions: string[]) {
  const rows = (await DB.prepare("SELECT action, meta_json FROM audit_log WHERE rowid > ?").bind(mark).all<{ action: string; meta_json: string | null }>()).results;
  for (const action of actions) expect(rows.map((row) => row.action), action).toContain(action);
  for (const row of rows) expect(JSON.parse(row.meta_json ?? "{}"), row.action).toMatchObject({ via: "mcp", client: CLIENT });
}
const names = async (who: string) => (await h.toolsList(tokens[who]!.accessToken)).map((tool) => tool.name).filter((name) => COLLAB_NAMES.includes(name)).sort();
/** A tool the role does not hold is not registered for the connection: calling it fails before any route is reached. */
async function notOffered(who: string, name: string, args: unknown) {
  const outcome = await call(who, name, args);
  expect(Boolean(outcome.error) || outcome.result?.isError === true, JSON.stringify(outcome)).toBe(true);
  expect(plain(outcome.result ?? { content: [{ text: JSON.stringify(outcome.error) }] })).not.toMatch(/^HTTP \d+:/);
}
const strokes = [{ points: [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.5 }], color: "#ff0000", width: 4 }];

describe("tools/list follows the grant and the role", () => {
  it("a read-only grant lists none of them, even for an admin", async () => {
    expect(await names("adminReadOnly")).toEqual([]);
    expect(toolsFor("admin", ["read"]).some((tool) => COLLAB_NAMES.includes(tool.name))).toBe(false);
  });
  it("admin and editor see all eleven", async () => {
    expect(await names("admin")).toEqual([...COLLAB_NAMES].sort());
    expect(await names("editor")).toEqual([...COLLAB_NAMES].sort());
  });
  it("photographer: no selection tools", async () => {
    expect(await names("photographer")).toEqual(COLLAB_NAMES.filter((name) => !["select_asset_for_editing", "unselect_asset_for_editing"].includes(name)).sort());
  });
  it("external editor: no Notice board tools and no selection tools", async () => {
    expect(await names("external")).toEqual(COLLAB_NAMES.filter((name) => !NOTICE.includes(name) && name !== "request_notice_link_preview" && !["select_asset_for_editing", "unselect_asset_for_editing"].includes(name)).sort());
  });
  it("annotates every tool: not read-only, destructive exactly for the removals, strict input, no admin capability", () => {
    const tools = MCP_TOOLS.filter((tool) => COLLAB_NAMES.includes(tool.name));
    expect(tools.map((tool) => tool.name).sort()).toEqual([...COLLAB_NAMES].sort());
    for (const tool of tools) {
      expect(tool.scope, tool.name).toBe("write");
      expect(tool.annotations.readOnlyHint, tool.name).toBe(false);
      expect(tool.annotations.destructiveHint, tool.name).toBe(DESTRUCTIVE.includes(tool.name));
      expect(tool.capability, tool.name).not.toBe("adminBackend");
      expect(tool.anyCapability ?? [], tool.name).not.toContain("adminBackend");
      const sample = Object.fromEntries(Object.keys(tool.inputSchema).map((key) => [key, undefined]));
      expect(strictInput(tool).safeParse({ ...sample, notARealKey: 1 }).success, tool.name).toBe(false);
    }
  });
  it("tells the caller which read tool supplies each id", () => {
    const byName = Object.fromEntries(MCP_TOOLS.map((tool) => [tool.name, tool.inputSchema]));
    expect(JSON.stringify(Object.keys(byName.edit_annotation!))).toContain("annotationId");
    const described = (name: string) => MCP_TOOLS.find((tool) => tool.name === name)!.description;
    expect(described("edit_annotation")).toMatch(/list_asset_annotations/);
    expect(described("delete_annotation")).toMatch(/list_asset_annotations/);
    expect(described("edit_notice_post")).toMatch(/list_notice_board/);
    expect(described("delete_notice_post")).toMatch(/list_notice_board/);
    expect(described("create_annotation")).toMatch(/list_project_assets/);
  });
});

describe("Annotations", () => {
  it("create, edit and delete an annotation by its author, audited via mcp", async () => {
    const assetId = await newAsset(); const mark = await maxRowid();
    const created = body(await ok("editor", "create_annotation", { assetId, noteText: "Check the window", strokes }));
    expect(created).toMatchObject({ noteText: "Check the window", scope: "raw" });
    expect(await DB.prepare("SELECT author_id FROM annotations WHERE id = ?").bind(created.id).first<{ author_id: string }>()).toEqual({ author_id: editorId });
    const edited = body(await ok("editor", "edit_annotation", { annotationId: created.id, noteText: "Window and door" }));
    expect(edited.noteText).toBe("Window and door");
    await ok("editor", "delete_annotation", { annotationId: created.id });
    expect(await DB.prepare("SELECT 1 FROM annotations WHERE id = ?").bind(created.id).first()).toBeNull();
    await expectProvenance(mark, ["asset.annotate", "annotation.edit", "annotation.delete"]);
  });
  it("create_annotation matches the cookie route's shape", async () => {
    const [a, b] = [await newAsset(), await newAsset()];
    const mcp = await ok("editor", "create_annotation", { assetId: a, noteText: "Twin" });
    const cookie = await viaCookie("editor", "POST", `/api/assets/${b}/annotations`, { noteText: "Twin" });
    expect(cookie.status).toBe(201);
    expect(normalize(plain(mcp))).toBe(normalize(cookie.text));
  });
  it("an annotation needs a note or markup, and a photographer may annotate a RAW asset", async () => {
    const assetId = await newAsset();
    await failure("editor", "create_annotation", { assetId }, 400);
    await ok("photographer", "create_annotation", { assetId, noteText: "From the shoot" });
  });
  it("author-only: another user, an admin included, cannot edit or delete it", async () => {
    const assetId = await newAsset();
    const created = body(await ok("editor", "create_annotation", { assetId, noteText: "Mine" }));
    await failure("editor2", "edit_annotation", { annotationId: created.id, noteText: "Hijack" }, 403);
    await failure("admin", "edit_annotation", { annotationId: created.id, noteText: "Hijack" }, 403);
    await failure("editor2", "delete_annotation", { annotationId: created.id }, 403);
    await failure("admin", "delete_annotation", { annotationId: created.id }, 403);
    expect((await DB.prepare("SELECT note_text FROM annotations WHERE id = ?").bind(created.id).first<{ note_text: string }>())!.note_text).toBe("Mine");
  });
  it("an assigned External editor annotates through the same tool", async () => {
    const assetId = await newAsset();
    const created = body(await ok("external", "create_annotation", { assetId, noteText: "External note" }));
    await ok("external", "delete_annotation", { annotationId: created.id });
  });
});

describe("Notice board", () => {
  it("create, edit and delete a post by its author, audited via mcp", async () => {
    const mark = await maxRowid();
    const created = body(await ok("editor", "create_notice_post", { text: "Studio closed Friday.\n\nBack Monday." }));
    expect(created.post.body).toContain("Studio closed Friday.");
    const postId = created.post.id as string;
    const edited = body(await ok("editor", "edit_notice_post", { postId, text: "Studio closed Thursday." }));
    expect(edited.post.body).toBe("Studio closed Thursday.");
    await ok("editor", "delete_notice_post", { postId });
    expect(await DB.prepare("SELECT 1 FROM notice_board_posts WHERE id = ?").bind(postId).first()).toBeNull();
    await expectProvenance(mark, ["notice_board.post", "notice_board.edit", "notice_board.delete"]);
  });
  it("create_notice_post matches the cookie route's shape", async () => {
    const mcp = await ok("photographer", "create_notice_post", { text: "Twin notice" });
    const cookie = await viaCookie("photographer", "POST", "/api/notice-board/posts", { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Twin notice" }] }] } });
    expect(cookie.status).toBe(201);
    expect(normalize(plain(mcp)).replace(/"readState":\{[^}]*\}/, "")).toBe(normalize(cookie.text).replace(/"readState":\{[^}]*\}/, ""));
  });
  it("author-only: another user, an admin included, cannot edit or delete the post", async () => {
    const created = body(await ok("editor", "create_notice_post", { text: "Not yours" }));
    const postId = created.post.id as string;
    await failure("editor2", "edit_notice_post", { postId, text: "Hijack" }, 403);
    await failure("admin", "edit_notice_post", { postId, text: "Hijack" }, 403);
    await failure("editor2", "delete_notice_post", { postId }, 403);
    await failure("admin", "delete_notice_post", { postId }, 403);
    expect((await DB.prepare("SELECT body FROM notice_board_posts WHERE id = ?").bind(postId).first<{ body: string }>())!.body).toBe("Not yours");
  });
  it("an External editor does not see the tools and the route refuses a direct call", async () => {
    await notOffered("external", "create_notice_post", { text: "Nope" });
  });
});

describe("Review and selection", () => {
  it("set_asset_review stores the state, audited via mcp", async () => {
    const assetId = await newAsset(); const mark = await maxRowid();
    await ok("editor", "set_asset_review", { assetId, stars: 4, colorLabel: "select" });
    expect(await DB.prepare("SELECT stars, color_label FROM asset_review_state WHERE asset_id = ?").bind(assetId).first()).toEqual({ stars: 4, color_label: "select" });
    await ok("editor", "set_asset_review", { assetId, stars: null });
    expect((await DB.prepare("SELECT stars FROM asset_review_state WHERE asset_id = ?").bind(assetId).first<{ stars: number | null }>())!.stars).toBeNull();
    await expectProvenance(mark, ["asset.review"]);
  });
  it("set_asset_review matches the cookie route's shape and needs at least one field", async () => {
    const [a, b] = [await newAsset(), await newAsset()];
    const mcp = await ok("editor", "set_asset_review", { assetId: a, decision: "approved" });
    const cookie = await viaCookie("editor", "POST", `/api/assets/${b}/review`, { decision: "approved" });
    expect(normalize(plain(mcp))).toBe(normalize(cookie.text));
    const empty = await call("editor", "set_asset_review", { assetId: a });
    expect(empty.result?.isError).toBe(true);
  });
  it("a photographer may only recommend; the route refuses anything else", async () => {
    const assetId = await newAsset();
    await ok("photographer", "set_asset_review", { assetId, recommended: true });
    await failure("photographer", "set_asset_review", { assetId, stars: 5 }, 403);
  });
  it("select and unselect an asset for editing, audited via mcp", async () => {
    const assetId = await newAsset(); const mark = await maxRowid();
    await ok("editor", "select_asset_for_editing", { assetId });
    expect(await DB.prepare("SELECT selected_by FROM selections WHERE asset_id = ?").bind(assetId).first()).toEqual({ selected_by: editorId });
    await ok("admin", "unselect_asset_for_editing", { assetId });
    expect(await DB.prepare("SELECT 1 FROM selections WHERE asset_id = ?").bind(assetId).first()).toBeNull();
    await expectProvenance(mark, ["asset.select", "asset.unselect"]);
  });
  it("a role without selectForEditing is refused by the route when it reaches it directly", async () => {
    const assetId = await newAsset();
    await notOffered("photographer", "select_asset_for_editing", { assetId });
    expect((await viaCookie("photographer", "POST", `/api/assets/${assetId}/select`)).status).toBe(403);
  });
});

describe("Link previews", () => {
  it("a Project member requests a preview and gets the cookie route's shape", async () => {
    const url = "https://example.com/collab";
    const mcp = await ok("editor", "request_project_link_preview", { projectId, url });
    expect(body(mcp)).toHaveProperty("preview");
    const cookie = await viaCookie("editor", "POST", `/api/projects/${projectId}/link-previews`, { url });
    expect(cookie.status).toBe(200);
    expect(Object.keys(JSON.parse(cookie.text))).toEqual(Object.keys(body(mcp)));
  });
  it("the route refuses a blocked address, an archived Project, and a non-member", async () => {
    await failure("editor", "request_project_link_preview", { projectId, url: "http://localhost/x" }, 400);
    await failure("editor", "request_project_link_preview", { projectId: archivedProjectId, url: "https://example.com/a" }, 409);
    await failure("photographer", "request_project_link_preview", { projectId: archivedProjectId, url: "https://example.com/a" }, 403);
  });
  it("a Notice board preview works for a member and is not offered to an External editor", async () => {
    expect(body(await ok("editor", "request_notice_link_preview", { url: "https://example.com/notice" }))).toHaveProperty("preview");
    await notOffered("external", "request_notice_link_preview", { url: "https://example.com/notice" });
  });
});

describe("route allowlist and the tool registry agree", () => {
  it("each tool dispatches to one allowlisted (method, path) and the list holds nothing broader", () => {
    const tools = MCP_TOOLS.filter((tool) => COLLAB_NAMES.includes(tool.name));
    for (const tool of tools) {
      const path = tool.route.template.replace(/:[A-Za-z]+/g, "x1");
      expect(isAllowedMcpRoute(tool.route.method, path), tool.name).toBe(true);
      expect(MCP_ALLOWED_ROUTES.some((route) => route.method === tool.route.method && route.template === tool.route.template), tool.name).toBe(true);
    }
    expect(new Set(tools.map((tool) => `${tool.route.method} ${tool.route.template}`)).size).toBe(tools.length);
    // Embedded media is all uploads (or the follow-up of one): none of its routes is open to MCP.
    expect(isAllowedMcpRoute("POST", "/api/projects/x1/embedded-media")).toBe(false);
    expect(isAllowedMcpRoute("PUT", "/api/projects/x1/embedded-media/x2/direct")).toBe(false);
    expect(isAllowedMcpRoute("POST", "/api/projects/x1/embedded-media/x2/complete")).toBe(false);
    expect(isAllowedMcpRoute("POST", "/api/notice-board/embedded-media")).toBe(false);
    expect(isAllowedMcpRoute("PATCH", "/api/notice-board/read-marker")).toBe(false);
  });
});
