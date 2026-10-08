import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WHITEBOARD_SERVER_EDITS_MAX, whiteboardElementSchema, whiteboardMediaRef } from "@quincy/shared";
import type { Env } from "../src/env";
import { isAllowedMcpRoute } from "../src/mcp/route-allowlist";
import { MCP_TOOLS, strictInput, toolsFor } from "../src/mcp/tools/registry";
import { mcpHarness } from "./mcp-oauth-support";
import { alarmAt, cookie, element, fire, inject, failOnce, save, touchesAudit, farFuture, setClock, stubFor, join, memberId, member2Id, newProject, outsiderId, externalId, seedWhiteboardWorld, storedRows, tokens } from "./whiteboard-support";

/**
 * #708: the whiteboard tools. Two reads (the simplified board and its versions) and one edit tool whose edits the server expands
 * into full Excalidraw elements. Real WebSocket clients (the existing whiteboard harness) watch the broadcast; real MCP tokens
 * drive the tools, so the allowlist, the role gate and the route's access decision are the production ones.
 */
const testEnv = env as unknown as Env;
const h = mcpHarness(testEnv);
const DB = h.DB;
const CLIENT = "Test Client";
const mcp: Record<string, { accessToken: string; connectionId: string }> = {};
const WB_TOOLS = ["get_project_whiteboard", "list_whiteboard_versions", "edit_project_whiteboard"];

beforeAll(async () => {
  await seedWhiteboardWorld();
  await DB.prepare("INSERT INTO feature_flags (key, enabled, updated_by, updated_at) VALUES ('mcp_access', 1, NULL, ?) ON CONFLICT(key) DO UPDATE SET enabled = 1").bind(Date.now()).run();
  for (const [name, id, role] of [["member", memberId, "editor"], ["member2", member2Id, "editor"], ["outsider", outsiderId, "editor"], ["external", externalId, "external_editor"]] as const) { await h.addUser(id, role); await h.addSession(name, id); }
  for (const name of ["member", "member2", "outsider", "external"]) mcp[name] = await h.connect("read write", name);
  mcp.memberRead = await h.connect("read", "member");
});

beforeEach(() => { delete (testEnv as { MCP_CALLS?: unknown }).MCP_CALLS; delete (testEnv as { MCP_WRITES?: unknown }).MCP_WRITES; });

const plain = (result?: { content: { text: string }[] }) => result!.content[0]!.text;
async function call(who: string, name: string, args: unknown) { return h.callTool(mcp[who]!.accessToken, name, args); }
async function ok(who: string, name: string, args: unknown) {
  const outcome = await call(who, name, args);
  expect(outcome.error, JSON.stringify(outcome)).toBeUndefined();
  expect(outcome.result?.isError, plain(outcome.result)).toBeUndefined();
  return JSON.parse(plain(outcome.result)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function refused(who: string, name: string, args: unknown, status: number) {
  const outcome = await call(who, name, args);
  expect(outcome.result?.isError, JSON.stringify(outcome)).toBe(true);
  expect(plain(outcome.result)).toMatch(new RegExp(`^HTTP ${status}:`));
  return JSON.parse(plain(outcome.result).replace(/^HTTP \d+: /, "")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const read = (who: string, projectId: string) => ok(who, "get_project_whiteboard", { projectId });
const edit = (who: string, projectId: string, edits: unknown[], expectedGeneration = 1, requestId?: string) => ok(who, "edit_project_whiteboard", { projectId, expectedGeneration, edits, ...(requestId ? { requestId } : {}) });
const byId = async (projectId: string) => Object.fromEntries((await storedRows(projectId)).map((row) => [row.id as string, row]));
async function addMedia(projectId: string, extra: { ownerKind?: string; kind?: string; state?: string; width?: number | null; height?: number | null } = {}) {
  const id = crypto.randomUUID(); const now = Date.now(); const kind = extra.kind ?? "image";
  await DB.prepare("INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, state, created_at, updated_at, width, height) VALUES (?, ?, NULL, ?, ?, ?, ?, 10, ?, ?, ?, ?, ?, ?)")
    .bind(id, extra.ownerKind ?? "whiteboard", projectId, memberId, kind, kind === "video" ? "video/mp4" : "image/png", `wb708/${id}`, extra.state ?? "pending", now, now, extra.width === undefined ? 800 : extra.width, extra.height === undefined ? 400 : extra.height).run();
  return id;
}

describe("tools/list", () => {
  it("offers the two reads to a read grant and the edit tool only to a write grant", async () => {
    const names = async (who: string) => (await h.toolsList(mcp[who]!.accessToken)).map((tool) => tool.name).filter((name) => WB_TOOLS.includes(name)).sort();
    expect(await names("memberRead")).toEqual(["get_project_whiteboard", "list_whiteboard_versions"]);
    expect(await names("member")).toEqual([...WB_TOOLS].sort());
  });
  it("a role without the capability the routes check is offered none of them", () => {
    for (const name of WB_TOOLS) expect(MCP_TOOLS.find((tool) => tool.name === name)!.capability, name).toBe("collaborateOnProject");
    expect(toolsFor("nobody", ["read", "write", "admin"]).some((tool) => WB_TOOLS.includes(tool.name))).toBe(false);
    expect(toolsFor("admin", ["read", "write"]).filter((tool) => WB_TOOLS.includes(tool.name)).length).toBe(3);
  });
  it("has no restore tool for the whiteboard, over MCP or on the allowlist", async () => {
    const listed = (await h.toolsList(mcp.member!.accessToken)).map((tool) => tool.name);
    expect(listed.filter((name) => /whiteboard/i.test(name)).sort()).toEqual([...WB_TOOLS].sort());
    expect(listed.filter((name) => /restore/i.test(name) && /whiteboard|version/i.test(name))).toEqual([]);
    expect(isAllowedMcpRoute("POST", "/api/projects/p1/whiteboard/versions/v1/restore")).toBe(false);
    expect(isAllowedMcpRoute("GET", "/api/projects/p1/whiteboard/socket")).toBe(false);
  });
  it("marks the edit tool destructive and the reads read-only, and refuses unknown input", () => {
    const byName = (name: string) => MCP_TOOLS.find((tool) => tool.name === name)!;
    expect(byName("edit_project_whiteboard").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName("get_project_whiteboard").annotations.readOnlyHint).toBe(true);
    expect(byName("list_whiteboard_versions").annotations.readOnlyHint).toBe(true);
    expect(strictInput(byName("edit_project_whiteboard")).safeParse({ projectId: crypto.randomUUID(), expectedGeneration: 1, edits: [{ op: "add_text", x: 0, y: 0, text: "a" }], extra: 1 }).success).toBe(false);
  });
});

describe("every op expands into a schema-valid element", () => {
  it("adds text, a sticky, three shapes, an arrow between two of them and a media element", async () => {
    const projectId = await newProject();
    const media = await addMedia(projectId, { width: 1600, height: 800 });
    const empty = await read("member", projectId);
    expect(empty).toMatchObject({ generation: 1, elements: [] });

    const first = await edit("member", projectId, [
      { op: "add_text", x: 10, y: 20, text: "Hello board" },
      { op: "add_sticky", x: 100, y: 200, text: "Check the twilight shots", color: "yellow" },
      { op: "add_shape", shapeKind: "rectangle", x: 0, y: 300, w: 120, h: 80 },
      { op: "add_shape", shapeKind: "ellipse", x: 300, y: 300, w: 120, h: 80 },
      { op: "add_shape", shapeKind: "diamond", x: 600, y: 300, w: 120, h: 80 },
      { op: "place_media", embeddedMediaId: media, x: 50, y: 500 },
    ]);
    expect(first.generation).toBe(1);
    const applied = first.applied as Array<{ op: string; id: string }>;
    expect(applied.map((entry) => entry.op)).toEqual(["add_text", "add_sticky", "add_shape", "add_shape", "add_shape", "place_media"]);
    const [rectId, ellipseId] = [applied[2]!.id, applied[3]!.id];
    const arrow = await edit("member", projectId, [{ op: "add_arrow", from: rectId, to: ellipseId }, { op: "add_arrow", from: ellipseId, to: { x: 900, y: 900 } }]);
    const arrowIds = (arrow.applied as Array<{ id: string }>).map((entry) => entry.id);

    const rows = await byId(projectId);
    for (const row of Object.values(rows)) {
      expect(whiteboardElementSchema.safeParse(row).success, JSON.stringify(row)).toBe(true);
      expect(typeof row.index, `${row.type} gets an index from the store`).toBe("string");
      expect(row.isDeleted).toBe(false);
    }
    // New elements start at version 1 with server-drawn seeds; the arrows bumped the two shapes they attach to.
    const text = rows[applied[0]!.id]!;
    expect(text).toMatchObject({ type: "text", version: 1, text: "Hello board", originalText: "Hello board", x: 10, y: 20, containerId: null });
    expect(text.versionNonce).toBeGreaterThanOrEqual(0); expect(text.seed).toBeGreaterThan(0);
    const sticky = rows[applied[1]!.id]!;
    expect(sticky).toMatchObject({ type: "rectangle", backgroundColor: "#fff085", x: 100, y: 200, width: 240, height: 76, strokeColor: "transparent", roughness: 0 });
    const stickyText = Object.values(rows).find((row) => row.type === "text" && row.containerId === sticky.id)!;
    expect(stickyText).toMatchObject({ version: 1, textAlign: "center", verticalAlign: "middle", originalText: "Check the twilight shots", fontSize: 20, strokeColor: "#171717" });
    expect(sticky.boundElements).toEqual([{ id: stickyText.id, type: "text" }]);
    expect(sticky.version).toBe(1);
    expect(rows[rectId]).toMatchObject({ type: "rectangle", width: 120, height: 80, version: 2 });
    expect(rows[ellipseId]).toMatchObject({ type: "ellipse", version: 3 });
    expect(rows[applied[4]!.id]).toMatchObject({ type: "diamond", version: 1 });
    const image = rows[applied[5]!.id]!;
    expect(image).toMatchObject({ type: "image", fileId: media, status: "saved", width: 480, height: 240, version: 1, customData: { quincyMedia: { kind: "image" } } });
    expect(whiteboardMediaRef(image)).toEqual({ id: media, kind: "image" });
    expect(rows[arrowIds[0]!]).toMatchObject({ type: "arrow", startBinding: { elementId: rectId }, endBinding: { elementId: ellipseId }, version: 1 });
    expect(rows[arrowIds[1]!]).toMatchObject({ type: "arrow", startBinding: { elementId: ellipseId }, endBinding: null });
    expect(rows[rectId]!.boundElements).toEqual([{ id: arrowIds[0], type: "arrow" }]);

    const board = await read("member", projectId);
    const view = Object.fromEntries((board.elements as Array<Record<string, any>>).map((entry) => [entry.id, entry])); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(board.elements).toHaveLength(Object.values(rows).filter((row) => !(row.type === "text" && row.containerId)).length);
    expect(view[applied[0]!.id]).toMatchObject({ kind: "text", text: "Hello board", x: 10, y: 20 });
    expect(view[sticky.id as string]).toMatchObject({ kind: "sticky", text: "Check the twilight shots", color: "#fff085" });
    expect(view[stickyText.id as string]).toBeUndefined();
    expect(view[ellipseId]).toMatchObject({ kind: "shape", shapeKind: "ellipse", w: 120, h: 80 });
    expect(view[arrowIds[0]!]).toMatchObject({ kind: "arrow", from: rectId, to: ellipseId });
    expect(view[arrowIds[1]!]).toMatchObject({ kind: "arrow", from: ellipseId, to: { x: 900, y: 900 } });
    expect(view[applied[5]!.id]).toMatchObject({ kind: "media", embeddedMediaId: media });
  });

  it("falls back to a default size for media with no recorded size, and grows a sticky for long text", async () => {
    const projectId = await newProject();
    const video = await addMedia(projectId, { kind: "video", width: null, height: null });
    const result = await edit("member", projectId, [{ op: "place_media", embeddedMediaId: video, x: 0, y: 0 }, { op: "add_sticky", x: 0, y: 0, text: "x".repeat(400), color: "green" }]);
    const rows = await byId(projectId);
    expect(rows[result.applied[0].id]).toMatchObject({ width: 480, height: 270, customData: { quincyMedia: { kind: "video" } } });
    const sticky = rows[result.applied[1].id]!;
    expect(sticky).toMatchObject({ backgroundColor: "#b9f8cf" });
    expect(sticky.height as number).toBeGreaterThan(76);                       // the sticky grows from 76 to hold long text
  });

  it("accepts no raw Excalidraw element and no unknown field", async () => {
    const projectId = await newProject();
    for (const edits of [[{ op: "add_text", x: 0, y: 0, text: "a", type: "rectangle", version: 99 }], [{ type: "rectangle", id: "x", version: 1, versionNonce: 1, isDeleted: false }], [{ op: "add_text", x: 0, y: 0, text: "" }], [{ op: "edit", id: "x" }], [{ op: "add_shape", shapeKind: "star", x: 0, y: 0, w: 1, h: 1 }]]) {
      const outcome = await call("member", "edit_project_whiteboard", { projectId, expectedGeneration: 1, edits });
      expect(Boolean(outcome.error) || outcome.result?.isError === true, JSON.stringify(edits)).toBe(true);
    }
    expect(await storedRows(projectId)).toEqual([]);
  });
});

describe("editing and deleting an existing element", () => {
  it("bumps the version and redraws the nonce on edit, tombstones on delete, and moves a sticky with its text", async () => {
    const projectId = await newProject();
    const made = await edit("member", projectId, [{ op: "add_text", x: 0, y: 0, text: "Before" }, { op: "add_sticky", x: 100, y: 100, text: "Note", color: "blue" }, { op: "add_shape", shapeKind: "rectangle", x: 500, y: 500, w: 50, h: 50 }]);
    const [textId, stickyId, shapeId] = (made.applied as Array<{ id: string }>).map((entry) => entry.id) as [string, string, string];
    const before = await byId(projectId);
    const innerId = Object.values(before).find((row) => row.containerId === stickyId)!.id as string;

    await edit("member", projectId, [{ op: "edit", id: textId, text: "After", x: 40 }, { op: "edit", id: stickyId, text: "Changed note", x: 150, y: 120 }]);
    const edited = await byId(projectId);
    expect(edited[textId]).toMatchObject({ version: 2, text: "After", originalText: "After", x: 40, y: 0, isDeleted: false });
    expect(edited[textId]!.versionNonce).not.toBe(before[textId]!.versionNonce);
    expect(edited[stickyId]).toMatchObject({ version: 2, x: 150, y: 120 });
    expect(edited[innerId]).toMatchObject({ originalText: "Changed note" });
    expect(edited[innerId]!.version as number).toBeGreaterThan(before[innerId]!.version as number);
    expect((edited[innerId]!.x as number) - 150).toBeGreaterThan(0);          // still inside the moved sticky
    for (const row of Object.values(edited)) expect(whiteboardElementSchema.safeParse(row).success).toBe(true);

    // The bound text element stands for its sticky, so naming it edits the sticky.
    await edit("member", projectId, [{ op: "edit", id: innerId, text: "Via the text id" }]);
    expect((await byId(projectId))[innerId]).toMatchObject({ originalText: "Via the text id" });

    await edit("member", projectId, [{ op: "delete", id: textId }, { op: "delete", id: stickyId }]);
    const deleted = await byId(projectId);
    expect(deleted[textId]).toMatchObject({ isDeleted: true, version: 3 });
    expect(deleted[stickyId]).toMatchObject({ isDeleted: true });
    expect(deleted[innerId]).toMatchObject({ isDeleted: true });
    expect(deleted[shapeId]).toMatchObject({ isDeleted: false, version: 1 });
    expect(((await read("member", projectId)).elements as Array<{ id: string }>).map((entry) => entry.id)).toEqual([shapeId]);
  });

  it("refuses an unknown or deleted element, a text edit on an arrow, and applies nothing from a failed call", async () => {
    const projectId = await newProject();
    const made = await edit("member", projectId, [{ op: "add_shape", shapeKind: "ellipse", x: 0, y: 0, w: 10, h: 10 }, { op: "add_shape", shapeKind: "ellipse", x: 50, y: 0, w: 10, h: 10 }]);
    const [a, b] = (made.applied as Array<{ id: string }>).map((entry) => entry.id) as [string, string];
    const arrow = (await edit("member", projectId, [{ op: "add_arrow", from: a, to: b }])).applied[0].id as string;
    const before = await byId(projectId);
    const failed = await refused("member", "edit_project_whiteboard", { projectId, expectedGeneration: 1, edits: [{ op: "delete", id: a }, { op: "edit", id: "no-such-element", text: "x" }] }, 422);
    expect(failed).toMatchObject({ code: "unknown_element" });
    await refused("member", "edit_project_whiteboard", { projectId, expectedGeneration: 1, edits: [{ op: "edit", id: arrow, text: "label" }] }, 422);
    await refused("member", "edit_project_whiteboard", { projectId, expectedGeneration: 1, edits: [{ op: "add_arrow", from: a, to: a }] }, 422);
    expect(await byId(projectId)).toEqual(before);
    await edit("member", projectId, [{ op: "delete", id: b }]);
    await refused("member", "edit_project_whiteboard", { projectId, expectedGeneration: 1, edits: [{ op: "delete", id: b }] }, 422);
  });
});

describe("the fences", () => {
  it("refuses a stale generation and says to read the board again", async () => {
    const projectId = await newProject();
    const body = await refused("member", "edit_project_whiteboard", { projectId, expectedGeneration: 7, edits: [{ op: "add_text", x: 0, y: 0, text: "late" }] }, 409);
    expect(body).toMatchObject({ code: "stale_generation", generation: 1 });
    expect(body.error).toMatch(/board changed.*read it again/i);
    expect(await storedRows(projectId)).toEqual([]);
  });

  it("refuses media of another Project, a comment's media, an unfinished upload and a missing id", async () => {
    const projectId = await newProject(); const elsewhere = await newProject();
    const foreign = await addMedia(elsewhere);
    const comment = await addMedia(projectId, { ownerKind: "project_comment", state: "pending" });
    const uploading = await addMedia(projectId, { state: "uploading" });
    for (const embeddedMediaId of [foreign, comment, uploading, crypto.randomUUID()]) {
      const body = await refused("member", "edit_project_whiteboard", { projectId, expectedGeneration: 1, edits: [{ op: "add_text", x: 0, y: 0, text: "ok" }, { op: "place_media", embeddedMediaId, x: 0, y: 0 }] }, 422);
      expect(body).toMatchObject({ code: "media_unavailable" });
    }
    expect(await storedRows(projectId)).toEqual([]);
  });

  it("refuses a user without access to the Project", async () => {
    const projectId = await newProject();
    await refused("outsider", "edit_project_whiteboard", { projectId, expectedGeneration: 1, edits: [{ op: "add_text", x: 0, y: 0, text: "no" }] }, 403);
    await refused("outsider", "get_project_whiteboard", { projectId }, 403);
    await refused("outsider", "list_whiteboard_versions", { projectId }, 403);
    await refused("external", "edit_project_whiteboard", { projectId, expectedGeneration: 1, edits: [{ op: "add_text", x: 0, y: 0, text: "no" }] }, 404);
    expect(await storedRows(projectId)).toEqual([]);
  });

  it("refuses an edit on an Archived Project, which stays readable", async () => {
    const projectId = await newProject(undefined, true);
    const body = await refused("member", "edit_project_whiteboard", { projectId, expectedGeneration: 1, edits: [{ op: "add_text", x: 0, y: 0, text: "no" }] }, 409);
    expect(body).toMatchObject({ code: "archived" });
    expect(await read("member", projectId)).toMatchObject({ generation: 1, archived: true, elements: [] });
  });

  it("enforces the per-call edit cap, at the tool and at the route", async () => {
    const projectId = await newProject();
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ op: "add_text", x: index, y: 0, text: `n${index}` }));
    const over = await call("member", "edit_project_whiteboard", { projectId, expectedGeneration: 1, edits: many(WHITEBOARD_SERVER_EDITS_MAX + 1) });
    expect(Boolean(over.error) || over.result?.isError === true).toBe(true);
    const direct = await SELF.fetch(`${h.ORIGIN}/api/projects/${projectId}/whiteboard/server-edits`, { method: "POST", headers: { cookie: await cookie(tokens.member), origin: h.ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ expectedGeneration: 1, edits: many(WHITEBOARD_SERVER_EDITS_MAX + 1) }) });
    expect(direct.status).toBe(400);
    expect(await storedRows(projectId)).toEqual([]);
    expect((await edit("member", projectId, many(WHITEBOARD_SERVER_EDITS_MAX))).applied).toHaveLength(WHITEBOARD_SERVER_EDITS_MAX);
    expect(await storedRows(projectId)).toHaveLength(WHITEBOARD_SERVER_EDITS_MAX);
  });
});

describe("a connected browser sees the change", () => {
  it("receives a labelled presence peer, then the elements, from a synthetic session, and the peer then leaves", async () => {
    const projectId = await newProject();
    const watcher = await join(projectId, "member2");
    const self = await join(projectId, "member");
    const result = await edit("member", projectId, [{ op: "add_text", x: 5, y: 6, text: "From the AI" }]);
    for (const { client } of [watcher, self]) {
      const presence = await client.next();
      expect(presence).toMatchObject({ type: "presence", userId: memberId, button: "up", pointer: { x: 5, y: 6 }, selectedIds: [result.applied[0].id] });
      expect((presence as { name: string; sessionId: string }).name).toMatch(new RegExp(` via ${CLIENT}$`));
      expect((presence as { sessionId: string }).sessionId).not.toBe(watcher.init.sessionId);
      expect((presence as { sessionId: string }).sessionId).not.toBe(self.init.sessionId);
      const elements = await client.next();
      expect(elements).toMatchObject({ type: "elements", generation: 1, elements: [{ id: result.applied[0].id, type: "text", text: "From the AI", version: 1 }] });
    }
    // The browser's own save of the same element reconciles against the server's row (version 1 is a retry, not a loss).
    watcher.client.send({ type: "elements", seq: 1, generation: 1, elements: [{ ...(await byId(projectId))[result.applied[0].id]!, version: 2, versionNonce: 5, text: "Edited by a person" }] });
    expect(await watcher.client.next()).toEqual({ type: "ack", seq: 1, generation: 1 });
    expect(await self.client.next()).toMatchObject({ type: "elements", elements: [{ text: "Edited by a person", version: 2 }] });
    await new Promise((resolve) => setTimeout(resolve, 4500));
    expect(await watcher.client.next()).toMatchObject({ type: "peer-left" });
    watcher.client.ws.close(1000); self.client.ws.close(1000);
  }, 20_000);

  it("marks the board dirty and arms the snapshot alarm, so an edit with nobody connected still becomes a version", async () => {
    const projectId = await newProject();
    expect(await alarmAt(projectId)).toBeNull();
    await edit("member", projectId, [{ op: "add_text", x: 0, y: 0, text: "Quiet edit" }]);
    expect(await alarmAt(projectId)).toEqual(expect.any(Number));
  });
});

describe("audit and the versions listing", () => {
  it("writes an audit row stamped with the MCP provenance, and none for a refused call", async () => {
    const projectId = await newProject();
    const mark = (await DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log").first<{ n: number }>())!.n;
    await refused("member", "edit_project_whiteboard", { projectId, expectedGeneration: 9, edits: [{ op: "add_text", x: 0, y: 0, text: "x" }] }, 409);
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE rowid > ?").bind(mark).first<{ n: number }>())!.n).toBe(0);
    const result = await edit("member", projectId, [{ op: "add_text", x: 0, y: 0, text: "Audited" }, { op: "add_shape", shapeKind: "diamond", x: 0, y: 0, w: 5, h: 5 }]);
    const rows = (await DB.prepare("SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE rowid > ?").bind(mark).all<{ actor_id: string; action: string; target_type: string; target_id: string; meta_json: string }>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: memberId, action: "project_whiteboard.server_edit", target_type: "project", target_id: projectId });
    expect(JSON.parse(rows[0]!.meta_json)).toMatchObject({ via: "mcp", client: CLIENT, connectionId: mcp.member!.connectionId, editCount: 2, ops: { add_text: 1, add_shape: 1 }, elementIds: result.applied.map((entry: { id: string }) => entry.id) });
  });

  it("lists the versions through the existing route", async () => {
    const projectId = await newProject();
    expect(await ok("member", "list_whiteboard_versions", { projectId })).toMatchObject({ generation: 1, currentVersionId: null, versions: [] });
  });
});

describe("review round 1 (Sol)", () => {
  const text = (value: string) => ({ op: "add_text", x: 0, y: 0, text: value });
  const auditRows = (projectId: string) => DB.prepare("SELECT id, actor_id, meta_json FROM audit_log WHERE action = 'project_whiteboard.server_edit' AND target_id = ?").bind(projectId).all<{ id: string; actor_id: string; meta_json: string }>().then((r) => r.results);

  it("a purge that completes while the edit awaits its access read cannot be undone by the edit", async () => {
    const projectId = await newProject();
    await edit("member", projectId, [text("before purge")]);
    let release!: () => void; let hit = false; const open = new Promise<void>((resolve) => { release = resolve; });
    await inject(projectId, "DB", (real: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      prepare: (sql: string) => { const statement = real.prepare(sql); return { bind: (...args: unknown[]) => { const bound = statement.bind(...args); return new Proxy(bound, { get: (target, key) => key === "first" ? async (...a: unknown[]) => { if (!hit) { hit = true; await open; } return target.first(...a); } : Reflect.get(target, key).bind?.(target) ?? Reflect.get(target, key) }); } }; },
      batch: (...a: unknown[]) => real.batch(...a),
    }));
    const pending = call("member", "edit_project_whiteboard", { projectId, expectedGeneration: 1, edits: [text("after purge")] });
    await vi.waitFor(() => expect(hit).toBe(true), { timeout: 5000 });
    await stubFor(projectId).purge();
    release();
    const outcome = await pending;
    expect(outcome.result?.isError, JSON.stringify(outcome)).toBe(true);
    expect(plain(outcome.result)).toMatch(/^HTTP 404:/);
    // The purge dropped the storage; nothing may have recreated the table or any row (a missing table is the clean state).
    const left = await runInDurableObject(stubFor(projectId), async (_i, state) => state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('elements', 'wb_server_edits')").toArray().map((row) => row.name as string));
    for (const table of left) expect(await runInDurableObject(stubFor(projectId), async (_i, state) => state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n), table).toBe(0);
  });

  it("a retry with the same requestId returns the stored result and applies nothing again", async () => {
    const projectId = await newProject(); const requestId = crypto.randomUUID();
    const first = await edit("member", projectId, [text("once"), { op: "add_shape", shapeKind: "ellipse", x: 1, y: 1, w: 5, h: 5 }], 1, requestId);
    const rowsAfter = await storedRows(projectId);
    const retry = await edit("member", projectId, [text("once"), { op: "add_shape", shapeKind: "ellipse", x: 1, y: 1, w: 5, h: 5 }], 1, requestId);
    expect(retry).toEqual(first);
    expect(await storedRows(projectId)).toEqual(rowsAfter);
    expect(await auditRows(projectId)).toHaveLength(1);
  });
  it("the same requestId with different edits, or from someone else, is refused", async () => {
    const projectId = await newProject(); const requestId = crypto.randomUUID();
    await edit("member", projectId, [text("original")], 1, requestId);
    const rows = await storedRows(projectId);
    expect(await refused("member", "edit_project_whiteboard", { projectId, expectedGeneration: 1, requestId, edits: [text("different")] }, 409)).toMatchObject({ code: "request_id_reused" });
    expect(await refused("member2", "edit_project_whiteboard", { projectId, expectedGeneration: 1, requestId, edits: [text("original")] }, 409)).toMatchObject({ code: "request_id_reused" });
    expect(await storedRows(projectId)).toEqual(rows);
  });
  it("a retry still answers after the board moved on; after a day only the result is dropped, and the id is never forgotten", async () => {
    const projectId = await newProject(); const requestId = crypto.randomUUID();
    const first = await edit("member", projectId, [text("a")], 1, requestId);
    await edit("member", projectId, [text("b")]);
    expect(await edit("member", projectId, [text("a")], 1, requestId)).toEqual(first);
    const rowsBefore = await storedRows(projectId); const auditBefore = await auditRows(projectId);
    await setClock(projectId, farFuture() + 48 * 3_600_000);
    await fire(projectId);
    const kept = await runInDurableObject(stubFor(projectId), async (_i, state) => state.storage.sql.exec("SELECT request_id, actor_id, fingerprint, audit_done, result_json FROM wb_server_edits WHERE request_id = ?", requestId).toArray());
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ actor_id: memberId, audit_done: 1, result_json: "" });
    expect((kept[0]!.fingerprint as string).length).toBe(64);
    const expired = await refused("member", "edit_project_whiteboard", { projectId, expectedGeneration: 1, requestId, edits: [text("a")] }, 409);
    expect(expired).toMatchObject({ code: "request_expired" });
    expect(await refused("member", "edit_project_whiteboard", { projectId, expectedGeneration: 1, requestId, edits: [text("other")] }, 409)).toMatchObject({ code: "request_id_reused" });
    expect(await storedRows(projectId)).toEqual(rowsBefore);
    expect(await auditRows(projectId)).toEqual(auditBefore);
    expect(auditBefore).toHaveLength(2);
  });

  it("an audit write that fails stays pending and lands exactly once on the next alarm", async () => {
    const projectId = await newProject(); const requestId = crypto.randomUUID();
    await setClock(projectId, farFuture());
    await inject(projectId, "DB", failOnce("prepare", touchesAudit));
    const result = await edit("member", projectId, [text("audited later")], 1, requestId);
    expect(result.applied).toHaveLength(1);
    expect(await auditRows(projectId)).toEqual([]);
    await setClock(projectId, farFuture() + 24 * 3_600_000);
    await fire(projectId);
    const rows = await auditRows(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `whiteboard-edit:${projectId}:${requestId}`, actor_id: memberId });
    expect(JSON.parse(rows[0]!.meta_json)).toMatchObject({ via: "mcp", client: CLIENT, requestId });
    await fire(projectId);
    expect(await auditRows(projectId)).toHaveLength(1);
    await edit("member", projectId, [text("audited later")], 1, requestId);     // a retry cannot double-insert
    expect(await auditRows(projectId)).toHaveLength(1);
  });
});

describe("elbow arrows (#708 review round 4)", () => {
  /** A board drawn in the browser: two boxes and an elbow arrow between them, `fixedSegments` as given. */
  async function elbowBoard(fixedSegments: unknown) {
    const projectId = await newProject();
    const { client } = await join(projectId, "member");
    const box = (id: string, x: number) => element(id, 1, 1, { x, y: 0, width: 100, height: 100, angle: 0, boundElements: [{ id: "elbow", type: "arrow" }] });
    await save(client, 1, box("A", 0), box("B", 500), element("elbow", 1, 1, {
      type: "arrow", x: 101, y: 20, width: 398, height: 150, angle: 0, points: [[0, 0], [49, 0], [49, -120], [349, -120], [349, 30], [398, 30]], elbowed: true, fixedSegments,
      startIsSpecial: false, endIsSpecial: false, startArrowhead: null, endArrowhead: "arrow", lastCommittedPoint: null, boundElements: null,
      startBinding: { elementId: "A", focus: 0, gap: 1, fixedPoint: [1.01, 0.2] }, endBinding: { elementId: "B", focus: 0, gap: 1, fixedPoint: [-0.01, 0.5] },
    }));
    client.ws.close(1000);
    return projectId;
  }
  const boardState = (projectId: string) => runInDurableObject(stubFor(projectId), async (_instance, state) => state.storage.sql.exec("SELECT generation, scene_revision FROM wb_state WHERE id = 1").toArray()[0]);

  it("refuses to move a shape whose elbow arrow has a pinned segment: nothing applied, generation and revision unchanged", async () => {
    const projectId = await elbowBoard([{ start: [49, -120], end: [349, -120], index: 3 }]);
    const before = await byId(projectId); const stateBefore = await boardState(projectId);
    const mark = (await DB.prepare("SELECT COALESCE(MAX(rowid), 0) AS n FROM audit_log").first<{ n: number }>())!.n;
    for (const move of [{ op: "edit", id: "A", y: -120 }, { op: "edit", id: "B", y: 100 }]) {
      const body = await refused("member", "edit_project_whiteboard", { projectId, expectedGeneration: 1, edits: [{ op: "add_text", x: 0, y: 0, text: "first" }, move] }, 422);
      expect(body).toMatchObject({ code: "pinned_elbow_arrow", generation: 1 });
      expect(body.error).toBe("Edit 2: This shape has an elbow arrow with a pinned segment; move it in the board editor.");
    }
    expect(await byId(projectId)).toEqual(before);
    expect(await boardState(projectId)).toEqual(stateBefore);
    expect((await DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE rowid > ?").bind(mark).first<{ n: number }>())!.n).toBe(0);
    expect((await read("member", projectId)).generation).toBe(1);
  });

  it("still re-routes an un-pinned elbow arrow, and a curved arrow, when a shape moves", async () => {
    const projectId = await elbowBoard(null);
    const revision = (await boardState(projectId))!.scene_revision as number;
    await edit("member", projectId, [{ op: "edit", id: "B", y: 100 }]);
    const arrow = (await byId(projectId)).elbow!;
    const points = arrow.points as number[][];
    expect(points).toHaveLength(4);
    expect(arrow).toMatchObject({ elbowed: true, fixedSegments: null, x: 101, y: 20, version: 2 });
    expect((arrow.y as number) + points.at(-1)![1]!).toBeCloseTo(150.01, 6);
    expect((await boardState(projectId))!.scene_revision).toBeGreaterThan(revision);

    const made = await edit("member", projectId, [{ op: "add_shape", shapeKind: "rectangle", x: 0, y: 400, w: 100, h: 100 }, { op: "add_shape", shapeKind: "rectangle", x: 500, y: 400, w: 100, h: 100 }]);
    const [c, d] = (made.applied as Array<{ id: string }>).map((entry) => entry.id) as [string, string];
    const curved = (await edit("member", projectId, [{ op: "add_arrow", from: c, to: d }])).applied[0].id as string;
    await edit("member", projectId, [{ op: "edit", id: d, y: 700 }]);
    const moved = (await byId(projectId))[curved]!;
    expect(moved).toMatchObject({ elbowed: false, version: 2 });
    expect((moved.y as number) + (moved.points as number[][]).at(-1)![1]!).toBeGreaterThan(600);
  });
});
