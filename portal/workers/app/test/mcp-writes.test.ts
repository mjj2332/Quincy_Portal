import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { MCP_ALLOWED_ROUTES, REDEMPTION_ONLY_ROUTES, isAllowedMcpRoute } from "../src/mcp/route-allowlist";
import { MCP_TOOLS, strictInput, toolsFor } from "../src/mcp/tools/registry";
import { COLLAB_WRITE_TOOLS } from "../src/mcp/tools/collab-writes";
import { WHITEBOARD_TOOLS } from "../src/mcp/tools/whiteboard";
import { mcpHarness } from "./mcp-oauth-support";

declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;
const testEnv = env as unknown as Env;
const h = mcpHarness(testEnv);
const DB = h.DB;

const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
const editorId = "b5000000-0000-4000-8000-000000000001";
const editor2Id = "b5000000-0000-4000-8000-000000000002";
const photographerId = "b5000000-0000-4000-8000-000000000003";
const externalId = "b5000000-0000-4000-8000-000000000004";
const tokens: Record<string, { accessToken: string; connectionId: string }> = {};
const CLIENT = "Test Client";

const WRITE_NAMES = [
  "create_project", "update_project_details", "set_project_priority", "set_project_deadline", "add_project_editor", "remove_project_editor",
  "move_project_stage", "archive_project", "restore_project",
  "create_subtask", "update_subtask", "reorder_subtask", "delete_subtask",
  "add_project_comment", "edit_project_comment", "delete_project_comment",
  "add_video_link", "update_video_link", "reorder_video_link", "remove_video_link",
  "mark_notification_read", "mark_all_notifications_read",
];
const DESTRUCTIVE = ["remove_project_editor", "delete_subtask", "delete_project_comment", "remove_video_link"];
const ADMIN_ONLY = ["create_project", "update_project_details", "set_project_priority", "set_project_deadline", "add_project_editor", "remove_project_editor", "archive_project", "restore_project"];
const VIDEO = ["add_video_link", "update_video_link", "reorder_video_link", "remove_video_link"];

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
  void now;
});
beforeEach(() => { delete (testEnv as { MCP_CALLS?: unknown }).MCP_CALLS; delete (testEnv as { MCP_WRITES?: unknown }).MCP_WRITES; });

const call = (who: string, name: string, args: unknown = {}) => h.callTool(tokens[who]!.accessToken, name, args);
const body = (result?: { content: { text: string }[] }) => JSON.parse(result!.content[0]!.text) as Record<string, any>;
const plain = (result?: { content: { text: string }[] }) => result!.content[0]!.text;
/** A write that must succeed: returns the parsed JSON body. */
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

/** The same request as the browser makes it: session cookie plus the app Origin. */
async function viaCookie(who: string, method: string, path: string, payload?: unknown) {
  const response = await SELF.fetch(`${h.ORIGIN}${path}`, { method, headers: { cookie: h.cookies[who]!, origin: h.ORIGIN, ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
  const text = await response.text();
  return { status: response.status, text };
}
/** Ids and timestamps differ between two equal operations; everything else must match. */
const normalize = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<id>").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<ts>").replace(/"(createdAt|updatedAt|editedAt)":\d+/g, '"$1":<ms>');

type Fixture = { stage?: string; members?: { userId: string; role: "photographer" | "editor" }[]; archived?: boolean };
async function newProject(fixture: Fixture = {}) {
  const id = crypto.randomUUID(); const now = Date.now();
  await DB.prepare("INSERT INTO projects (id, street, stage_key, board_revision, archived_at, created_at, updated_at) VALUES (?, 'Write Street', ?, 0, ?, ?, ?)").bind(id, fixture.stage ?? "awaiting_raw", fixture.archived ? now : null, now, now).run();
  for (const member of fixture.members ?? []) await DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), id, member.userId, member.role, now).run();
  return id;
}
const maxRowid = async (table: "audit_log" | "project_activity_events") => (await DB.prepare(`SELECT COALESCE(MAX(rowid), 0) AS n FROM ${table}`).first<{ n: number }>())!.n;
/** Every audit row and activity row created since the marks carries the provenance the MCP door stamps. */
async function expectProvenance(marks: [number, number], expectedActions: string[] = []) {
  return assertProvenance(await captureRows(marks), expectedActions);
}
type Captured = { audit: { action: string; meta_json: string | null }[]; activity: { event_type: string; via_client: string | null }[] };
async function captureRows(marks: [number, number]): Promise<Captured> {
  const audit = (await DB.prepare("SELECT action, meta_json FROM audit_log WHERE rowid > ?").bind(marks[0]).all<{ action: string; meta_json: string | null }>()).results;
  const activity = (await DB.prepare("SELECT event_type, via_client FROM project_activity_events WHERE rowid > ?").bind(marks[1]).all<{ event_type: string; via_client: string | null }>()).results;
  return { audit, activity };
}
function assertProvenance({ audit, activity }: Captured, expectedActions: string[] = []) {
  expect(audit.length).toBeGreaterThan(0);
  for (const action of expectedActions) expect(audit.map((row) => row.action), action).toContain(action);
  for (const row of audit) {
    if (row.action === "project.deadline.automatic_set") continue;
    expect(JSON.parse(row.meta_json ?? "{}"), row.action).toMatchObject({ via: "mcp", client: CLIENT });
  }
  for (const row of activity) expect(row.via_client, row.event_type).toBe(CLIENT);
  return { audit, activity };
}
const marks = async (): Promise<[number, number]> => [await maxRowid("audit_log"), await maxRowid("project_activity_events")];

const names = async (who: string) => (await h.toolsList(tokens[who]!.accessToken)).map((tool) => tool.name).filter((name) => WRITE_NAMES.includes(name)).sort();

describe("tools/list follows the grant and the role", () => {
  it("a read-only grant lists no write tools, even for an admin", async () => {
    const list = await h.toolsList(tokens.adminReadOnly!.accessToken);
    expect(list.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    expect(toolsFor("admin", ["read"]).some((tool) => WRITE_NAMES.includes(tool.name))).toBe(false);
    expect(toolsFor("admin", ["write"]).map((tool) => tool.name).sort()).toEqual([...WRITE_NAMES, ...COLLAB_WRITE_TOOLS.map((tool) => tool.name), ...WHITEBOARD_TOOLS.filter((tool) => tool.scope === "write").map((tool) => tool.name)].sort());
  });
  it("admin sees every write tool", async () => { expect(await names("admin")).toEqual([...WRITE_NAMES].sort()); });
  it("editor: no create, details, priority, Deadline, team or archive tools", async () => {
    expect(await names("editor")).toEqual(WRITE_NAMES.filter((n) => !ADMIN_ONLY.includes(n)).sort());
  });
  it("photographer: Subtasks, comments and notifications only", async () => {
    expect(await names("photographer")).toEqual(WRITE_NAMES.filter((n) => !ADMIN_ONLY.includes(n) && !VIDEO.includes(n) && n !== "move_project_stage").sort());
  });
  it("external_editor: Stage moves and Video links, but no admin-held tools", async () => {
    expect(await names("external")).toEqual(WRITE_NAMES.filter((n) => !ADMIN_ONLY.includes(n)).sort());
  });
  it("annotates every write tool: not read-only, destructive exactly for the removals", () => {
    const writes = MCP_TOOLS.filter((tool) => WRITE_NAMES.includes(tool.name));
    expect(writes.map((tool) => tool.name).sort()).toEqual([...WRITE_NAMES].sort());
    for (const tool of writes) {
      expect(tool.scope, tool.name).toBe("write");
      expect(tool.annotations.readOnlyHint, tool.name).toBe(false);
      expect(tool.annotations.destructiveHint, tool.name).toBe(DESTRUCTIVE.includes(tool.name));
      expect(tool.capability, tool.name).not.toBe("adminBackend");
      expect(tool.anyCapability ?? [], tool.name).not.toContain("adminBackend");
    }
  });
});

describe("Projects", () => {
  it("create_project creates it, audited via mcp", async () => {
    const m = await marks();
    const result = body(await ok("admin", "create_project", { street: "1 Created Street", suburb: "Sydney", editorUserIds: [editorId], priority: 3 }));
    const row = await DB.prepare("SELECT street, priority, stage_key FROM projects WHERE id = ?").bind(result.project?.id ?? result.id).first<{ street: string; priority: number; stage_key: string }>();
    expect(row).toMatchObject({ street: "1 Created Street", priority: 3, stage_key: "awaiting_raw" });
    await expectProvenance(m, ["project.create"]);
  });
  it("create_project matches the cookie route's shape", async () => {
    const mcp = await ok("admin", "create_project", { street: "2 Twin Street" });
    const cookie = await viaCookie("admin", "POST", "/api/projects", { street: "2 Twin Street" });
    expect(cookie.status).toBe(201);
    expect(normalize(plain(mcp))).toBe(normalize(cookie.text));
  });
  it("update details and priority return what the cookie route returns, with provenance", async () => {
    const [a, b] = [await newProject(), await newProject()];
    const m = await marks();
    const details = await ok("admin", "update_project_details", { projectId: a, suburb: "Bondi", notes: "Gate code 1234" });
    const priority = await ok("admin", "set_project_priority", { projectId: a, priority: 4 });
    const { activity } = await expectProvenance(m, ["project.update", "project.priority_set"]);
    expect(activity.length).toBeGreaterThan(0);
    expect((await DB.prepare("SELECT suburb FROM projects WHERE id = ?").bind(a).first<{ suburb: string }>())!.suburb).toBe("Bondi");
    const twin = await viaCookie("admin", "PATCH", `/api/projects/${b}`, { suburb: "Bondi", notes: "Gate code 1234" });
    expect(normalize(plain(details))).toBe(normalize(twin.text));
    expect(normalize(plain(priority))).toBe(normalize((await viaCookie("admin", "POST", `/api/projects/${b}/priority`, { priority: 4 })).text));
  });
  it("set_project_deadline needs the schedule version the caller read, and refuses a stale one", async () => {
    const [a, b] = [await newProject(), await newProject()];
    const m = await marks();
    const args = { expectedVersion: 0, deadline: { localCivil: "2037-03-02T09:00" }, reminderOffsetsMinutes: [60] };
    const mcp = await ok("admin", "set_project_deadline", { projectId: a, ...args });
    await expectProvenance(m, ["project.deadline.schedule_saved"]);
    expect(normalize(plain(mcp))).toBe(normalize((await viaCookie("admin", "PUT", `/api/projects/${b}/deadline`, args)).text));
    await failure("admin", "set_project_deadline", { projectId: a, ...args }, 409);
    expect((await call("admin", "set_project_deadline", { projectId: a, deadline: null })).result?.isError).toBe(true);
  });
  it("add_project_editor and remove_project_editor, with the membership id the caller read", async () => {
    const projectId = await newProject();
    const m = await marks();
    const added = body(await ok("admin", "add_project_editor", { projectId, userId: editorId }));
    expect(added.outcome).toBe("created");
    const membership = await DB.prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ? AND role_on_project = 'editor'").bind(projectId, editorId).first<{ id: string }>();
    expect(membership).not.toBeNull();
    expect(body(await ok("admin", "add_project_editor", { projectId, userId: editorId })).outcome).toBe("unchanged");
    const removed = body(await ok("admin", "remove_project_editor", { projectId, userId: editorId, membershipCycle: membership!.id }));
    expect(removed.outcome).toBe("removed");
    expect(await DB.prepare("SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?").bind(projectId, editorId).first()).toBeNull();
    await expectProvenance(m, ["project.member.remove"]);
  });
  it("remove_project_editor asks for confirmation when Subtasks would be cleared, and does not auto-confirm", async () => {
    // Removing an External editor's last role on a Project cuts their access: the route asks for confirmation first.
    const external = await newProject({ members: [{ userId: externalId, role: "editor" }] });
    const externalMembership = (await DB.prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ?").bind(external, externalId).first<{ id: string }>())!;
    const first = await call("admin", "remove_project_editor", { projectId: external, userId: externalId, membershipCycle: externalMembership.id });
    expect(first.result?.isError).toBeUndefined();
    expect(plain(first.result)).toMatch(/^Confirmation required: .*Ask the user, then call again with confirm: true\./);
    expect(await DB.prepare("SELECT 1 FROM project_members WHERE id = ?").bind(externalMembership.id).first()).not.toBeNull();
    const second = body(await ok("admin", "remove_project_editor", { projectId: external, userId: externalId, membershipCycle: externalMembership.id, confirm: true }));
    expect(second.outcome).toBe("removed");
    expect(await DB.prepare("SELECT 1 FROM project_members WHERE id = ?").bind(externalMembership.id).first()).toBeNull();
  });
  it("archive_project and restore_project", async () => {
    const [a, b] = [await newProject(), await newProject()];
    const m = await marks();
    const archived = await ok("admin", "archive_project", { projectId: a });
    expect((await DB.prepare("SELECT archived_at FROM projects WHERE id = ?").bind(a).first<{ archived_at: number | null }>())!.archived_at).not.toBeNull();
    await ok("admin", "restore_project", { projectId: a });
    expect((await DB.prepare("SELECT archived_at FROM projects WHERE id = ?").bind(a).first<{ archived_at: number | null }>())!.archived_at).toBeNull();
    await expectProvenance(m, ["project.archive", "project.restore"]);
    expect(normalize(plain(archived))).toBe(normalize((await viaCookie("admin", "POST", `/api/projects/${b}/archive`)).text));
  });
  it("an editor is refused what only admins may do, even by direct call", async () => {
    const projectId = await newProject();
    const outcome = await call("editor", "archive_project", { projectId });
    expect(outcome.error ?? outcome.result?.isError).toBeTruthy();
    expect((await DB.prepare("SELECT archived_at FROM projects WHERE id = ?").bind(projectId).first<{ archived_at: number | null }>())!.archived_at).toBeNull();
  });
});

describe("Stage moves", () => {
  it("a plain move equals the cookie route and carries provenance", async () => {
    const [a, b] = [await newProject(), await newProject()];
    const m = await marks();
    const args = { expectedStageKey: "awaiting_raw", expectedBoardRevision: 0, targetStageKey: "raw_review" };
    const mcp = await ok("editor", "move_project_stage", { projectId: a, ...args });
    await expectProvenance(m);
    const cookie = await viaCookie("editor", "POST", `/api/projects/${b}/stage`, { expected: { stageKey: "awaiting_raw", boardRevision: 0 }, targetStageKey: "raw_review", placement: { kind: "append" }, confirmation: { reasons: [] } });
    // The Board order lists the Stage's other Projects, which differ by then; everything else must be equal.
    const sansBoardOrder = (text: string) => normalize(text).replace(/"orderedVisibleProjectIds":\[[^\]]*\]/, "");
    expect(sansBoardOrder(plain(mcp))).toBe(sansBoardOrder(cookie.text));
  });
  it("a move that needs confirmation changes nothing until confirm: true", async () => {
    const projectId = await newProject();
    const args = { projectId, expectedStageKey: "awaiting_raw", expectedBoardRevision: 0, targetStageKey: "delivered" };
    const first = await call("editor", "move_project_stage", args);
    expect(first.result?.isError).toBeUndefined();
    expect(plain(first.result)).toMatch(/^Confirmation required: .*skips a Stage.*Ask the user, then call again with confirm: true\.$/);
    expect((await DB.prepare("SELECT stage_key FROM projects WHERE id = ?").bind(projectId).first<{ stage_key: string }>())!.stage_key).toBe("awaiting_raw");
    const m = await marks();
    const second = body(await ok("editor", "move_project_stage", { ...args, confirm: true }));
    expect(second.changed).toBe(true);
    expect((await DB.prepare("SELECT stage_key FROM projects WHERE id = ?").bind(projectId).first<{ stage_key: string }>())!.stage_key).toBe("delivered");
    await expectProvenance(m);
  });
  it("a stale board revision is an error, not a confirmation", async () => {
    const projectId = await newProject();
    const outcome = await call("editor", "move_project_stage", { projectId, expectedStageKey: "awaiting_raw", expectedBoardRevision: 7, targetStageKey: "raw_review" });
    expect(outcome.result?.isError).toBe(true);
    expect(plain(outcome.result)).toMatch(/^HTTP 409:.*project_stage_conflict/);
  });
});

describe("Subtasks", () => {
  it("create, update (title, done, assignees), reorder and delete", async () => {
    const projectId = await newProject({ members: [{ userId: photographerId, role: "photographer" }] });
    const m = await marks();
    const created = body(await ok("admin", "create_subtask", { projectId, title: "First" }));
    const second = body(await ok("admin", "create_subtask", { projectId, title: "Second" }));
    const firstId = created.subtask?.id ?? created.id;
    const secondId = second.subtask?.id ?? second.id;
    expect(firstId).toBeTruthy();
    expect(await DB.prepare("SELECT COUNT(*) AS n FROM project_subtasks WHERE project_id = ?").bind(projectId).first<{ n: number }>()).toEqual({ n: 2 });

    await ok("admin", "update_subtask", { projectId, subtaskId: firstId, title: "First renamed", done: true });
    expect(await DB.prepare("SELECT title, done FROM project_subtasks WHERE id = ?").bind(firstId).first()).toEqual({ title: "First renamed", done: 1 });

    const list = body(await ok("admin", "get_project_subtasks", { projectId }));
    const version = (list.subtasks ?? list.items).find((item: any) => item.id === firstId).assignmentVersion;
    await ok("admin", "update_subtask", { projectId, subtaskId: firstId, assignees: { expectedVersion: version, add: [adminId], remove: [] } });
    expect(await DB.prepare("SELECT 1 FROM project_subtask_assignees WHERE subtask_id = ? AND user_id = ?").bind(firstId, adminId).first()).not.toBeNull();
    await failure("admin", "update_subtask", { projectId, subtaskId: firstId, assignees: { expectedVersion: version, add: [], remove: [adminId] } }, 409);

    await ok("admin", "reorder_subtask", { projectId, subtaskId: secondId, beforeId: null, afterId: firstId });
    const order = (await DB.prepare("SELECT id FROM project_subtasks WHERE project_id = ? ORDER BY position, id").bind(projectId).all<{ id: string }>()).results.map((row) => row.id);
    expect(order).toEqual([secondId, firstId]);

    await ok("admin", "delete_subtask", { projectId, subtaskId: firstId });
    expect(await DB.prepare("SELECT 1 FROM project_subtasks WHERE id = ?").bind(firstId).first()).toBeNull();
    await expectProvenance(m, ["project_subtask.create", "project_subtask.delete", "project_subtask.reorder"]);
  });
  it("create returns what the cookie route returns", async () => {
    const members = [{ userId: editorId, role: "editor" as const }];
    const [a, b] = [await newProject({ members }), await newProject({ members })];
    const mcp = await ok("editor", "create_subtask", { projectId: a, title: "Twin" });
    const cookie = await viaCookie("editor", "POST", `/api/projects/${b}/subtasks`, { title: "Twin" });
    expect(normalize(plain(mcp))).toBe(normalize(cookie.text));
  });
  it("an archived Project refuses Subtask writes as the route does", async () => {
    const projectId = await newProject({ archived: true });
    const route = await viaCookie("admin", "POST", `/api/projects/${projectId}/subtasks`, { title: "Nope" });
    const outcome = await call("admin", "create_subtask", { projectId, title: "Nope" });
    expect(outcome.result?.isError).toBe(true);
    expect(plain(outcome.result)).toBe(`HTTP ${route.status}: ${route.text}`);
    expect(route.status).toBe(409);
  });
});

describe("comments", () => {
  it("add, edit and delete as the author, with provenance and the 'via' marker", async () => {
    const projectId = await newProject();
    const m = await marks();
    const added = body(await ok("admin", "add_project_comment", { projectId, text: "First line\nsecond line\n\nNew paragraph" }));
    expect(added.viaClient).toBe(CLIENT);
    expect(added.content.content).toHaveLength(2);
    expect(await DB.prepare("SELECT body FROM project_comments WHERE id = ?").bind(added.id).first()).toEqual({ body: "First line\nsecond line\nNew paragraph" });
    const edited = body(await ok("admin", "edit_project_comment", { projectId, commentId: added.id, text: "Edited" }));
    expect(edited.viaClient).toBe(CLIENT);
    await ok("admin", "delete_project_comment", { projectId, commentId: added.id });
    expect(await DB.prepare("SELECT 1 FROM project_comments WHERE id = ?").bind(added.id).first()).toBeNull();
    await expectProvenance(m);
  });
  it("add returns the cookie route's shape", async () => {
    const [a, b] = [await newProject(), await newProject()];
    const mcp = body(await ok("admin", "add_project_comment", { projectId: a, text: "Same words" }));
    const cookie = JSON.parse((await viaCookie("admin", "POST", `/api/projects/${b}/comments`, { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Same words" }] }] } })).text);
    expect(Object.keys(mcp).sort()).toEqual(Object.keys(cookie).sort());
    expect(mcp.content).toEqual(cookie.content);
    expect(mcp.viaClient).toBe(CLIENT);
    expect(cookie.viaClient).toBeNull();
  });
  it("only the author may edit or delete: someone else's comment is a 403 isError", async () => {
    const projectId = await newProject({ members: [{ userId: editorId, role: "editor" }] });
    const added = body(await ok("admin", "add_project_comment", { projectId, text: "Mine" }));
    expect(plain(await failure("editor", "delete_project_comment", { projectId, commentId: added.id }, 403))).toContain("only the author can delete");
    expect(plain(await failure("editor", "edit_project_comment", { projectId, commentId: added.id, text: "Hijack" }, 403))).toContain("only the author can edit");
    expect(await DB.prepare("SELECT body FROM project_comments WHERE id = ?").bind(added.id).first()).toEqual({ body: "Mine" });
  });
  it("an archived Project refuses comment writes as the route does", async () => {
    const projectId = await newProject();
    const added = body(await ok("admin", "add_project_comment", { projectId, text: "Before archive" }));
    await ok("admin", "archive_project", { projectId });
    const route = await viaCookie("admin", "POST", `/api/projects/${projectId}/comments`, { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Nope" }] }] } });
    const outcome = await call("admin", "add_project_comment", { projectId, text: "Nope" });
    expect(outcome.result?.isError).toBe(true);
    expect(plain(outcome.result)).toBe(`HTTP ${route.status}: ${route.text}`);
    expect(route.status).toBe(409);
    await failure("admin", "delete_project_comment", { projectId, commentId: added.id }, 409);
  });
  it("an empty comment is the route's 400", async () => {
    const projectId = await newProject();
    const outcome = await call("admin", "add_project_comment", { projectId, text: "" });
    expect(outcome.error ?? outcome.result?.isError).toBeTruthy();
  });
});

describe("Video Collection links", () => {
  it("add, update, reorder and remove", async () => {
    const projectId = await newProject();
    const m = await marks();
    const first = body(await ok("editor", "add_video_link", { projectId, url: "https://example.test/one", label: "One" }));
    const second = body(await ok("editor", "add_video_link", { projectId, url: "https://example.test/two" }));
    expect(first.url).toBe("https://example.test/one");
    const rows = async () => (await DB.prepare("SELECT l.id, l.url, l.label FROM collection_links l JOIN collections c ON c.id = l.collection_id WHERE c.project_id = ? AND c.kind = 'video' ORDER BY l.position, l.id").bind(projectId).all<{ id: string; url: string; label: string | null }>()).results;
    expect((await rows()).map((row) => row.url)).toEqual(["https://example.test/one", "https://example.test/two"]);
    const updated = body(await ok("editor", "update_video_link", { projectId, linkId: first.id, url: "https://example.test/one-b", label: "One B" }));
    expect(updated).toMatchObject({ url: "https://example.test/one-b", label: "One B" });
    await ok("editor", "reorder_video_link", { projectId, linkId: second.id, beforeId: null, afterId: first.id });
    expect((await rows()).map((row) => row.id)).toEqual([second.id, first.id]);
    await ok("editor", "remove_video_link", { projectId, linkId: second.id });
    expect((await rows()).map((row) => row.id)).toEqual([first.id]);
    await expectProvenance(m, ["collection_link.create", "collection_link.update", "collection_link.reorder", "collection_link.delete"]);
  });
  it("add returns the cookie route's response", async () => {
    const [a, b] = [await newProject(), await newProject()];
    const mcp = await ok("editor", "add_video_link", { projectId: a, url: "https://example.test/same" });
    const cookie = await viaCookie("editor", "POST", `/api/projects/${b}/links`, { collection: "video", url: "https://example.test/same" });
    expect(normalize(plain(mcp))).toBe(normalize(cookie.text));
  });
});

describe("Video link tools only act on Video Collection links", () => {
  it("a Copy or Floorplan link id is refused by remove, update and reorder, and the link survives", async () => {
    const projectId = await newProject();
    const now = Date.now();
    const video = body(await ok("editor", "add_video_link", { projectId, url: "https://example.test/video" }));
    for (const kind of ["copy", "floorplan"] as const) {
      const collectionId = crypto.randomUUID(); const linkId = crypto.randomUUID();
      await DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, ?, 'empty', 0, ?, ?)").bind(collectionId, projectId, kind, now, now).run();
      await DB.prepare("INSERT INTO collection_links (id, collection_id, url, label, source, position, created_at, updated_at) VALUES (?, ?, ?, NULL, 'manual', 1024, ?, ?)").bind(linkId, collectionId, `https://example.test/${kind}`, now, now).run();
      for (const [name, args] of [
        ["remove_video_link", {}],
        ["update_video_link", { url: "https://example.test/hijack" }],
        ["reorder_video_link", { beforeId: null, afterId: video.id }],
      ] as const) {
        const outcome = await call("editor", name, { projectId, linkId, ...args });
        expect(outcome.result?.isError, `${kind} ${name}`).toBe(true);
        expect(plain(outcome.result), `${kind} ${name}`).toMatch(/^HTTP 404:/);
      }
      expect(await DB.prepare("SELECT url, position FROM collection_links WHERE id = ?").bind(linkId).first()).toEqual({ url: `https://example.test/${kind}`, position: 1024 });
    }
  });
});

describe("notifications", () => {
  async function notify(userId: string) {
    const id = crypto.randomUUID();
    await DB.prepare("INSERT INTO notifications (id, user_id, type, title, created_at) VALUES (?, ?, 'test', 'Hello', ?)").bind(id, userId, Date.now()).run();
    return id;
  }
  it("mark one read, then all, for the user who owns them", async () => {
    const [one, two, other] = [await notify(editorId), await notify(editorId), await notify(editor2Id)];
    const out = await ok("editor", "mark_notification_read", { notificationId: one });
    expect(body(out)).toEqual({ ok: true });
    expect((await DB.prepare("SELECT read_at FROM notifications WHERE id = ?").bind(one).first<{ read_at: number | null }>())!.read_at).not.toBeNull();
    await failure("editor", "mark_notification_read", { notificationId: other }, 404);
    expect((await DB.prepare("SELECT read_at FROM notifications WHERE id = ?").bind(other).first<{ read_at: number | null }>())!.read_at).toBeNull();
    await ok("editor", "mark_all_notifications_read");
    expect((await DB.prepare("SELECT read_at FROM notifications WHERE id = ?").bind(two).first<{ read_at: number | null }>())!.read_at).not.toBeNull();
    expect((await DB.prepare("SELECT read_at FROM notifications WHERE id = ?").bind(other).first<{ read_at: number | null }>())!.read_at).toBeNull();
  });
});

describe("rate limit", () => {
  it("the 21st write in a minute is a readable isError with the writes wording", async () => {
    let writes = 0; const keys: string[] = [];
    (testEnv as unknown as { MCP_WRITES: unknown }).MCP_WRITES = { limit: async ({ key }: { key: string }) => { keys.push(key); writes += 1; return { success: writes <= 20 }; } };
    for (let index = 0; index < 20; index += 1) expect((await call("editor", "mark_all_notifications_read")).result?.isError, `write ${index + 1}`).toBeUndefined();
    const blocked = await call("editor", "mark_all_notifications_read");
    expect(blocked.result?.isError).toBe(true);
    expect(plain(blocked.result)).toBe("Rate limit: 20 writes/min for this Connected app; retry in about 60 s");
    expect(blocked.result!._meta?.retryAfterSeconds).toBe(60);
    expect(new Set(keys)).toEqual(new Set([tokens.editor!.connectionId]));
  });
  it("reads never touch the writes limiter", async () => {
    const seen: string[] = [];
    (testEnv as unknown as { MCP_WRITES: unknown }).MCP_WRITES = { limit: async ({ key }: { key: string }) => { seen.push(key); return { success: false }; } };
    expect((await call("editor", "list_stages")).result?.isError).toBeUndefined();
    expect(seen).toEqual([]);
  });
});

describe("inputs are strict", () => {
  it("rejects unknown keys, bad ids and missing required inputs, and nothing is written", async () => {
    const projectId = await newProject();
    const outcomes = await Promise.all([
      call("admin", "set_project_priority", { projectId, priority: 3, sneaky: true }),
      call("admin", "set_project_priority", { projectId: "../admin", priority: 3 }),
      call("admin", "set_project_priority", { projectId }),
      call("admin", "set_project_priority", { projectId, priority: 9 }),
      call("editor", "move_project_stage", { projectId, targetStageKey: "raw_review" }),
      call("editor", "mark_all_notifications_read", { sneaky: 1 }),
      call("admin", "create_subtask", { projectId, title: "x", position: 0 }),
    ]);
    for (const outcome of outcomes) {
      expect(outcome.error !== undefined || outcome.result?.isError === true, JSON.stringify(outcome)).toBe(true);
      expect(JSON.stringify(outcome)).toMatch(/Input validation|Unrecognized|Invalid|Required|Too big/i);
    }
    expect((await DB.prepare("SELECT priority FROM projects WHERE id = ?").bind(projectId).first<{ priority: number | null }>())!.priority).toBeNull();
  });
  it("every write tool's schema is strict", () => {
    for (const tool of MCP_TOOLS.filter((candidate) => WRITE_NAMES.includes(candidate.name))) {
      const sample = Object.fromEntries(Object.keys(tool.inputSchema).map((key) => [key, undefined]));
      expect(strictInput(tool).safeParse({ ...sample, notARealKey: 1 }).success, tool.name).toBe(false);
    }
  });
});

describe("route allowlist and the tool registry agree", () => {
  it("every write tool dispatches to one allowlisted (method, path) and every non-GET entry belongs to a tool", () => {
    const toolRoutes = new Set([...MCP_TOOLS.map((tool) => `${tool.route.method} ${tool.route.template}`), ...REDEMPTION_ONLY_ROUTES.map(([method, template]) => `${method} ${template}`)]);
    for (const tool of MCP_TOOLS.filter((candidate) => WRITE_NAMES.includes(candidate.name))) {
      const path = tool.route.template.replace(/:[A-Za-z]+/g, "x1");
      expect(isAllowedMcpRoute(tool.route.method, path), tool.name).toBe(true);
      expect(MCP_ALLOWED_ROUTES.some((route) => route.method === tool.route.method && route.template === tool.route.template), tool.name).toBe(true);
    }
    for (const route of MCP_ALLOWED_ROUTES) expect(toolRoutes.has(`${route.method} ${route.template}`), `${route.method} ${route.template}`).toBe(true);
    const writes = MCP_TOOLS.filter((candidate) => WRITE_NAMES.includes(candidate.name));
    expect(new Set(writes.map((tool) => `${tool.route.method} ${tool.route.template}`)).size).toBe(writes.length);
  });
  it("never opens /api/auth or a wildcard, and refuses routes no tool owns", () => {
    expect(MCP_ALLOWED_ROUTES.every((route) => !route.template.includes("*") && !route.template.startsWith("/api/auth"))).toBe(true);
    expect(isAllowedMcpRoute("POST", "/api/auth/sign-out")).toBe(false);
    expect(isAllowedMcpRoute("DELETE", "/api/projects/x1")).toBe(false);
    expect(isAllowedMcpRoute("PATCH", "/api/users/x1")).toBe(false);
    expect(isAllowedMcpRoute("POST", "/api/projects/x1/send-to-autohdr")).toBe(false);
  });
});
