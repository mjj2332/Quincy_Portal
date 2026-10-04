import { env, evictDurableObject, listDurableObjectIds, runInDurableObject, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { WhiteboardServerMessage } from "@quincy/shared";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * #498: the Project whiteboard's Durable Object reached through the app worker's WebSocket
 * upgrade route. This is the repo's first Durable-Object-via-WebSocket seam: tests drive real
 * upgrades through `SELF.fetch` (so `fetchWithServerTiming`, CORS and Hono's response handling are
 * all in the path) and assert what a client receives and what is stored. The one internal
 * assertion is that hard delete leaves the DO's element table empty.
 */
const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;

const adminId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const outsiderId = "33333333-3333-4333-8333-333333333333";
const externalId = "44444444-4444-4444-8444-444444444444";
const member2Id = "55555555-5555-4555-8555-555555555555";
const unicodeId = "66666666-6666-4666-8666-666666666666";
const unicodeName = "Zo\u00eb \u5c71\u7530 \ud83c\udfa8";
const liveProject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherProject = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const archivedProject = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const deleteProject = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const hiddenProject = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const archiveLater = "99999999-9999-4999-8999-999999999999";
const orderProject = "88888888-8888-4888-8888-888888888888";
const missingProject = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const tokens = { admin: "wb-admin-token", member: "wb-member-token", outsider: "wb-outsider-token", external: "wb-external-token", member2: "wb-member2-token", unicode: "wb-unicode-token" } as const;

async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); } }
async function cookie(token: string) { const context = await createAuth(baseEnv).$context; return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`; }

type Who = keyof typeof tokens;
type Options = { who?: Who | null; origin?: string | null; upgrade?: boolean; headers?: Record<string, string> };
async function upgrade(projectId: string, options: Options = {}) {
  const headers = new Headers(options.headers);
  if (options.upgrade !== false) headers.set("Upgrade", "websocket");
  if (options.origin !== null) headers.set("Origin", options.origin ?? baseEnv.APP_ORIGIN);
  if (options.who !== null) headers.set("cookie", await cookie(tokens[options.who ?? "member"]));
  return workerSelf.fetch(`https://portal.test/api/projects/${projectId}/whiteboard/socket`, { headers });
}

/** A connected client: every server message is queued, and `next` waits for one. */
type Client = { ws: WebSocket; next: () => Promise<WhiteboardServerMessage>; send: (message: unknown) => void; closed: Promise<{ code: number }>; drain: (ms?: number) => Promise<WhiteboardServerMessage[]> };
async function connect(projectId: string, options: Options = {}): Promise<Client> {
  const response = await upgrade(projectId, options);
  expect(response.status, "upgrade status").toBe(101);
  const ws = response.webSocket!;
  expect(ws).toBeTruthy();
  const queue: WhiteboardServerMessage[] = []; const waiters: Array<(message: WhiteboardServerMessage) => void> = [];
  ws.addEventListener("message", (event) => { const message = JSON.parse(event.data as string) as WhiteboardServerMessage; const waiter = waiters.shift(); if (waiter) waiter(message); else queue.push(message); });
  const closed = new Promise<{ code: number }>((resolve) => ws.addEventListener("close", (event) => resolve({ code: event.code })));
  ws.accept();
  return {
    ws, closed,
    next: () => new Promise((resolve, reject) => { const queued = queue.shift(); if (queued) return resolve(queued); const timer = setTimeout(() => reject(new Error("timed out waiting for a server message")), 3000); waiters.push((message) => { clearTimeout(timer); resolve(message); }); }),
    send: (message) => ws.send(typeof message === "string" ? message : JSON.stringify(message)),
    drain: async (ms = 150) => { await new Promise((resolve) => setTimeout(resolve, ms)); return queue.splice(0); },
  };
}
const element = (id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", version, versionNonce, isDeleted: false, x: 0, y: 0, ...extra });
const batch = (seq: number, ...elements: unknown[]) => ({ type: "elements", seq, elements });
async function initOf(projectId: string, options: Options = {}) { const client = await connect(projectId, options); const init = await client.next(); client.ws.close(1000); return init as Extract<WhiteboardServerMessage, { type: "init" }>; }
async function save(client: Client, seq: number, ...elements: unknown[]) { client.send(batch(seq, ...elements)); expect(await client.next()).toEqual({ type: "ack", seq }); }
/** A batch the sender LOSES: the stored row comes back first (so it converges), then the ack. */
async function saveLosing(client: Client, seq: number, ...elements: unknown[]) { client.send(batch(seq, ...elements)); expect(await client.next()).toMatchObject({ type: "elements" }); expect(await client.next()).toEqual({ type: "ack", seq }); }
const storedRow = (projectId: string, id: string) => runInDurableObject(stubFor(projectId), async (_instance, state) => state.storage.sql.exec("SELECT json FROM elements WHERE id = ?", id).toArray().map((row) => JSON.parse(row.json as string) as Record<string, unknown>)[0]);
const storedIds = (projectId: string) => runInDurableObject(stubFor(projectId), async (_instance, state) => state.storage.sql.exec("SELECT id, version, version_nonce FROM elements").toArray().map((row) => ({ id: row.id as string, version: row.version as number, nonce: row.version_nonce as number })));
const stubFor = (projectId: string) => baseEnv.PROJECT_WHITEBOARD.get(baseEnv.PROJECT_WHITEBOARD.idFromName(projectId));
const byId = (init: { elements: Array<Record<string, unknown>> }) => Object.fromEntries(init.elements.map((entry) => [entry.id as string, entry]));

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__); const now = Date.now();
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();   // the archive/restore routes sit behind the Board contract
  for (const [id, role] of [[adminId, "admin"], [memberId, "editor"], [outsiderId, "editor"], [externalId, "external_editor"], [member2Id, "editor"], [unicodeId, "editor"]]) await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(id, id === unicodeId ? unicodeName : `${role} ${id.slice(0, 4)}`, `${id}@example.test`, role, now, now).run();
  for (const [who, userId] of [["admin", adminId], ["member", memberId], ["outsider", outsiderId], ["external", externalId], ["member2", member2Id], ["unicode", unicodeId]] as const) await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(`wb-${who}`, now + 3_600_000, tokens[who], userId, now, now).run();
  for (const [id, street] of [[liveProject, "Whiteboard Street"], [otherProject, "Other Street"], [archivedProject, "Archived Street"], [deleteProject, "Delete Street"], [hiddenProject, "Hidden Street"], [archiveLater, "Archive Later Street"], [orderProject, "Order Street"]]) await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', 0, ?, ?)").bind(id, street, now, now).run();
  await database.DB.prepare("UPDATE projects SET archived_at = ?, archived_by = ? WHERE id IN (?, ?)").bind(now, adminId, archivedProject, deleteProject).run();
  for (const [userId, project, role] of [[memberId, liveProject, "editor"], [memberId, otherProject, "editor"], [memberId, archivedProject, "editor"], [memberId, deleteProject, "editor"], [memberId, archiveLater, "editor"], [memberId, orderProject, "editor"], [externalId, liveProject, "editor"]] as const) await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), project, userId, role, now).run();
});

describe("project whiteboard WebSocket route", () => {
  it("upgrades a collaborator's request through the full middleware stack and sends the empty scene", async () => {
    const client = await connect(liveProject, { who: "member" });
    expect(await client.next()).toEqual({ type: "init", mode: "edit", elements: [], sessionId: expect.any(String), peers: [] });
    client.ws.close(1000);
  });

  it("lets an admin and an assigned External editor open the board", async () => {
    expect((await initOf(liveProject, { who: "admin" })).mode).toBe("edit");
    expect((await initOf(liveProject, { who: "external" })).mode).toBe("edit");
  });

  it("refuses without an upgrade and creates no Durable Object for any refusal", async () => {
    const before = (await listDurableObjectIds(baseEnv.PROJECT_WHITEBOARD)).length;
    expect((await upgrade(liveProject, { who: null })).status).toBe(401);
    expect((await upgrade(liveProject, { origin: "https://evil.example" })).status).toBe(403);
    expect((await upgrade(liveProject, { origin: null })).status).toBe(403);
    expect((await upgrade(liveProject, { upgrade: false })).status).toBe(426);
    expect((await upgrade(liveProject, { who: "outsider" })).status).toBe(403);
    expect((await upgrade(hiddenProject, { who: "external" })).status).toBe(404);
    expect((await upgrade("not-a-uuid")).status).toBe(400);
    expect((await upgrade(missingProject, { who: "admin" })).status).toBe(404);
    expect((await listDurableObjectIds(baseEnv.PROJECT_WHITEBOARD)).length).toBe(before);
  });

  it("stores elements across a reload, including after the Durable Object is evicted", async () => {
    const first = await connect(liveProject);
    await first.next();
    await save(first, 1, element("rect-1", 1, 10, { x: 5 }), element("rect-2", 1, 20));
    first.ws.close(1000);
    await evictDurableObject(stubFor(liveProject));
    const again = byId(await initOf(liveProject, { who: "admin" }));
    expect(again["rect-1"]).toMatchObject({ x: 5, version: 1 });
    expect(Object.keys(again)).toEqual(expect.arrayContaining(["rect-1", "rect-2"]));
  });

  it("reconciles by version, then nonce, and keeps a deletion", async () => {
    const client = await connect(otherProject);
    await client.next();
    await save(client, 1, element("e", 2, 50, { x: 1 }));
    await saveLosing(client, 2, element("e", 1, 1, { x: 99 }));      // stale: ignored (and corrected)
    await saveLosing(client, 3, element("e", 2, 60, { x: 98 }));     // equal version, higher nonce: ignored (and corrected)
    expect(await storedRow(otherProject, "e")).toMatchObject({ x: 1, versionNonce: 50 });
    await save(client, 4, element("e", 2, 40, { x: 2 }));            // equal version, lower nonce: wins
    await save(client, 5, element("e", 3, 70, { x: 3 }));            // higher version: wins
    expect(await storedRow(otherProject, "e")).toMatchObject({ x: 3 });
    await save(client, 6, element("e", 4, 80, { isDeleted: true }));
    await saveLosing(client, 7, element("e", 2, 1, { x: 7 }));       // an old edit cannot resurrect it
    expect(await storedRow(otherProject, "e")).toMatchObject({ isDeleted: true });
    client.ws.close(1000);
  });

  it("keeps each Project's board separate", async () => {
    const live = byId(await initOf(liveProject)); const other = byId(await initOf(otherProject));
    expect(live["rect-1"]).toBeDefined(); expect(other["rect-1"]).toBeUndefined();
    expect(live["e"]).toBeUndefined();
  });

  it("opens an Archived Project's board view-only: edits are rejected and nothing is stored", async () => {
    const client = await connect(archivedProject, { who: "member" });
    expect(await client.next()).toMatchObject({ type: "init", mode: "view" });
    client.send(batch(1, element("nope", 1, 1)));
    expect(await client.next()).toEqual({ type: "rejected", seq: 1, reason: "view-only" });
    client.ws.close(1000);
    expect((await initOf(archivedProject, { who: "admin" })).elements).toEqual([]);
  });

  it("discards a client-supplied identity or mode header", async () => {
    const forged = await connect(archivedProject, { who: "member", headers: { "x-wb-mode": "edit", "x-wb-user": adminId } });
    expect(await forged.next()).toMatchObject({ mode: "view" });
    forged.ws.close(1000);
  });

  it("rejects an image element and closes on malformed or oversized frames", async () => {
    const client = await connect(liveProject);
    await client.next();
    client.send(batch(9, element("img", 1, 1, { type: "image", fileId: "f" })));
    expect(await client.next()).toEqual({ type: "rejected", seq: 9, reason: "invalid" });
    client.send("{not json");
    expect((await client.closed).code).toBe(4400);
    const big = await connect(liveProject);
    await big.next();
    big.send(batch(1, element("big", 1, 1, { text: "x".repeat(1024 * 1024 + 1) })));
    expect((await big.closed).code).toBe(4400);
    expect(byId(await initOf(liveProject))["big"]).toBeUndefined();
  });
});

describe("server-side write guards", () => {
  it("refuses a write on a socket opened before the Project was archived, and again once restored", async () => {
    const client = await connect(archiveLater, { who: "member" });
    expect(await client.next()).toMatchObject({ type: "init", mode: "edit" });
    await save(client, 1, element("before", 1, 1));
    await database.DB.prepare("UPDATE projects SET archived_at = ?, archived_by = ? WHERE id = ?").bind(Date.now(), adminId, archiveLater).run();
    client.send(batch(2, element("after", 1, 1)));
    expect(await client.next()).toEqual({ type: "mode", mode: "view" });          // a missed notification is healed by the write itself
    expect(await client.next()).toEqual({ type: "rejected", seq: 2, reason: "view-only" });
    await database.DB.prepare("UPDATE projects SET archived_at = NULL, archived_by = NULL WHERE id = ?").bind(archiveLater).run();
    // A write never upgrades a socket (a delayed read could be stale): only a refresh does.
    client.send(batch(3, element("early", 1, 1)));
    expect(await client.next()).toEqual({ type: "rejected", seq: 3, reason: "view-only" });
    await stubFor(archiveLater).refreshAccess();
    expect(await client.next()).toEqual({ type: "mode", mode: "edit" });
    await save(client, 4, element("restored", 1, 1));
    client.ws.close(1000);
    const stored = byId(await initOf(archiveLater));
    expect(stored["before"]).toBeDefined(); expect(stored["restored"]).toBeDefined(); expect(stored["after"]).toBeUndefined(); expect(stored["early"]).toBeUndefined();
  });

  it("returns elements in Excalidraw's fractional index order, so send-to-back survives a reload", async () => {
    const client = await connect(orderProject, { who: "member" });
    await client.next();
    await save(client, 1, element("a", 1, 1, { index: "a1" }), element("b", 1, 2, { index: "a2" }), element("c", 1, 3, { index: "a3" }), element("noindex", 1, 4), element("bad", 1, 5, { index: 7 }));
    await save(client, 2, element("c", 2, 9, { index: "Zz" })); // sent to back
    client.ws.close(1000);
    expect((await initOf(orderProject)).elements.map((entry) => entry.id)).toEqual(["c", "a", "b", "bad", "noindex"]);
  });

  it("purges twice without error and still serves an empty board afterwards", async () => {
    const stub = stubFor(missingProject);
    await stub.purge(); await stub.purge();
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { purge(): Promise<void> }).purge();
    });
    const client = await connect(liveProject, { who: "member" });
    expect(await client.next()).toMatchObject({ type: "init", mode: "edit" });
    client.ws.close(1000);
  });
});

describe("hard delete clears the board", () => {
  it("closes open sockets with 4404, clears the Durable Object's storage and refuses a reconnect", async () => {
    const writer = await connect(deleteProject, { who: "admin" });
    // Archived boards are view-only, so seed through the Durable Object itself.
    await runInDurableObject(stubFor(deleteProject), async (_instance, state) => {
      state.storage.sql.exec("INSERT INTO elements (id, version, version_nonce, is_deleted, json, updated_at) VALUES ('seed', 1, 1, 0, '{}', 0)");
    });
    await writer.next();
    const response = await workerSelf.fetch(`https://portal.test/api/projects/${deleteProject}`, { method: "DELETE", headers: { cookie: await cookie(tokens.admin), origin: baseEnv.APP_ORIGIN } });
    expect(response.status).toBe(200);
    expect((await writer.closed).code).toBe(4404);
    await runInDurableObject(stubFor(deleteProject), async (_instance, state) => {
      // deleteAll() drops the SQL tables themselves, so nothing of the board is left to read.
      expect(state.storage.sql.exec("SELECT count(*) AS n FROM sqlite_master WHERE name = 'elements'").one().n).toBe(0);
    });
    expect((await upgrade(deleteProject, { who: "admin" })).status).toBe(404);
  });
});

// ---- #499: live co-editing, presence and access changes -------------------------------------------------

type Members = ReadonlyArray<readonly [string, string]>;
const staff: Members = [[memberId, "editor"], [member2Id, "editor"], [unicodeId, "editor"]];
/** A fresh Project (so one test's sockets never meet another's) with the given team. */
async function newProject(members: Members = staff, archived = false): Promise<string> {
  const id = crypto.randomUUID(); const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at, archived_at) VALUES (?, 'Live Street', 'editing_autohdr', 0, ?, ?, ?)").bind(id, now, now, archived ? now : null).run();
  for (const [userId, role] of members) await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), id, userId, role, now).run();
  return id;
}
async function api(who: Who, method: "POST" | "DELETE", path: string, body?: unknown) {
  const headers = new Headers({ cookie: await cookie(tokens[who]), origin: baseEnv.APP_ORIGIN });
  if (body !== undefined) headers.set("content-type", "application/json");
  return workerSelf.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const cycleOf = async (projectId: string, userId: string) => (await database.DB.prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ?").bind(projectId, userId).first<{ id: string }>())!.id;
const removeEditor = async (projectId: string, userId: string) => api("admin", "DELETE", `/api/projects/${projectId}/editors/${userId}`, { membershipCycle: await cycleOf(projectId, userId), clearSubtaskAssignments: false, confirmedAssignmentCount: 0, confirmAccessLoss: true });
type Init = Extract<WhiteboardServerMessage, { type: "init" }>;
/** Connects and returns the client with its own `init` already read. */
async function join(projectId: string, who: Who = "member") { const client = await connect(projectId, { who }); const init = await client.next() as Init; return { client, init }; }
const presence = (overrides: Record<string, unknown> = {}) => ({ type: "presence", pointer: { x: 10, y: 20 }, button: "up", selectedIds: [], ...overrides });

describe("live relay between two sockets (#499)", () => {
  it("relays a batch's winners to the other client and acknowledges only the sender, with no echo", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    a.client.send(batch(1, element("r1", 1, 10, { x: 5 })));
    expect(await a.client.next()).toEqual({ type: "ack", seq: 1 });
    expect(await b.client.next()).toMatchObject({ type: "elements", elements: [{ id: "r1", x: 5, version: 1 }] });
    expect(await a.client.drain()).toEqual([]);
    expect(await b.client.drain()).toEqual([]);
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("merges edits to different elements made at the same time", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    a.client.send(batch(1, element("from-a", 1, 1))); b.client.send(batch(1, element("from-b", 1, 2)));
    const seenByA = await a.client.drain(); const seenByB = await b.client.drain();
    expect(seenByA).toContainEqual({ type: "ack", seq: 1 }); expect(seenByB).toContainEqual({ type: "ack", seq: 1 });
    expect(seenByA).toContainEqual(expect.objectContaining({ type: "elements", elements: [expect.objectContaining({ id: "from-b" })] }));
    expect(seenByB).toContainEqual(expect.objectContaining({ type: "elements", elements: [expect.objectContaining({ id: "from-a" })] }));
    expect(Object.keys(byId(await initOf(project)))).toEqual(expect.arrayContaining(["from-a", "from-b"]));
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("converges on a same-element conflict: the loser gets the stored row BEFORE its ack, the winner's side hears nothing more", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    b.client.send(batch(1, element("e", 3, 40, { x: 2 })));
    expect(await b.client.next()).toEqual({ type: "ack", seq: 1 });
    expect(await a.client.next()).toMatchObject({ type: "elements", elements: [{ id: "e", x: 2, versionNonce: 40 }] });
    a.client.send(batch(1, element("e", 3, 50, { x: 1 })));                       // equal version, higher nonce: loses
    expect(await a.client.next()).toMatchObject({ type: "elements", elements: [{ id: "e", x: 2, versionNonce: 40 }] });
    expect(await a.client.next()).toEqual({ type: "ack", seq: 1 });
    expect(await b.client.drain()).toEqual([]);                                    // nothing won, so nothing is relayed
    expect(await storedIds(project)).toContainEqual({ id: "e", version: 3, nonce: 40 });
    // the other way round: the lower nonce arrives second and wins
    a.client.send(batch(2, element("f", 4, 90, { x: 1 })));
    expect(await a.client.next()).toEqual({ type: "ack", seq: 2 });
    expect(await b.client.next()).toMatchObject({ elements: [{ id: "f", x: 1 }] });
    b.client.send(batch(2, element("f", 4, 20, { x: 9 })));
    expect(await b.client.next()).toEqual({ type: "ack", seq: 2 });
    expect(await a.client.next()).toMatchObject({ elements: [{ id: "f", x: 9, versionNonce: 20 }] });
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("relays only the winners of a mixed batch and corrects only its losers", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    b.client.send(batch(1, element("old", 5, 5, { x: 5 })));
    await b.client.next(); await a.client.next();
    a.client.send(batch(1, element("old", 2, 1, { x: 1 }), element("new", 1, 1, { x: 7 })));
    expect(await a.client.next()).toMatchObject({ type: "elements", elements: [{ id: "old", x: 5, version: 5 }] });
    expect(await a.client.next()).toEqual({ type: "ack", seq: 1 });
    expect(await b.client.next()).toMatchObject({ type: "elements", elements: [{ id: "new", x: 7 }] });
    expect(await b.client.drain()).toEqual([]);
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("treats a retried batch as idempotent: acknowledged, never relayed again, no correction", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    a.client.send(batch(1, element("r", 1, 10)));
    expect(await a.client.next()).toEqual({ type: "ack", seq: 1 }); await b.client.next();
    a.client.send(batch(2, element("r", 1, 10)));
    expect(await a.client.next()).toEqual({ type: "ack", seq: 2 });
    expect(await a.client.drain()).toEqual([]); expect(await b.client.drain()).toEqual([]);
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("keeps a deletion: a stale edit cannot resurrect it and its sender is told the tombstone", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    a.client.send(batch(1, element("d", 4, 8, { isDeleted: true })));
    await a.client.next(); await b.client.next();
    b.client.send(batch(1, element("d", 2, 1, { x: 3 })));
    expect(await b.client.next()).toMatchObject({ type: "elements", elements: [{ id: "d", isDeleted: true, version: 4 }] });
    expect(await b.client.next()).toEqual({ type: "ack", seq: 1 });
    expect(await a.client.drain()).toEqual([]);
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("keeps relaying across a Durable Object eviction, and a reconnect catches up on what it missed", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    a.client.send(batch(1, element("one", 1, 1))); await a.client.next(); await b.client.next();
    await evictDurableObject(stubFor(project));
    a.client.send(batch(2, element("two", 1, 2)));
    expect(await a.client.next()).toEqual({ type: "ack", seq: 2 });
    expect(await b.client.next()).toMatchObject({ elements: [{ id: "two" }] });
    b.client.ws.close(1000);
    a.client.send(batch(3, element("while-away", 1, 3))); await a.client.next();
    const back = await join(project, "member2");
    expect(back.init.elements.map((entry) => entry.id).sort()).toEqual(["one", "two", "while-away"]);
    a.client.ws.close(1000); back.client.ws.close(1000);
  });

  it("sends a scene far larger than one client batch in a single init", async () => {
    // The 1 MiB cap bounds what a client SENDS; a stored scene is the sum of many batches. Workers
    // accept WebSocket messages up to 32 MiB, so a 3 MiB scene (3x the cap) needs no chunking.
    const project = await newProject();
    await runInDurableObject(stubFor(project), async (_instance, state) => {
      for (let index = 0; index < 20; index += 1) state.storage.sql.exec("INSERT INTO elements (id, version, version_nonce, is_deleted, json, updated_at) VALUES (?, 1, 1, 0, ?, 0)", `big-${index}`, JSON.stringify({ id: `big-${index}`, type: "rectangle", version: 1, versionNonce: 1, isDeleted: false, pad: "x".repeat(150 * 1024) }));
    });
    const { client, init } = await join(project, "member");
    expect(init.elements).toHaveLength(20);
    client.ws.close(1000);
  });
});

describe("presence (#499)", () => {
  it("relays a pointer and selection to the other client with the server's name and the connection's session, never echoing to the sender", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    a.client.send(presence({ pointer: { x: 1.5, y: 2 }, button: "down", selectedIds: ["s1", "s2"] }));
    expect(await b.client.next()).toEqual({ type: "presence", sessionId: a.init.sessionId, userId: memberId, name: `editor ${memberId.slice(0, 4)}`, pointer: { x: 1.5, y: 2 }, button: "down", selectedIds: ["s1", "s2"] });
    expect(await a.client.drain()).toEqual([]);
    expect(a.init.sessionId).not.toBe(b.init.sessionId);
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("ignores a client-supplied name, user or session: identity is the connection's", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    a.client.send(presence({ name: "Admin", userId: adminId, sessionId: "forged", color: "red" }));
    const relayed = await b.client.next();
    expect(relayed).toMatchObject({ userId: memberId, sessionId: a.init.sessionId, name: `editor ${memberId.slice(0, 4)}` });
    expect(relayed).not.toHaveProperty("color");
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("round-trips a non-ASCII name", async () => {
    const project = await newProject();
    const a = await join(project, "unicode"); const b = await join(project, "member2");
    a.client.send(presence());
    expect(await b.client.next()).toMatchObject({ name: unicodeName });
    expect(((await join(project, "member")).init.peers.find((peer) => peer.userId === unicodeId))?.name).toBe(unicodeName);
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("lets a view-only socket send presence but never elements", async () => {
    const project = await newProject(staff, true);
    const a = await join(project, "member"); const b = await join(project, "member2");
    expect(a.init.mode).toBe("view");
    a.client.send(presence({ selectedIds: ["x"] }));
    expect(await b.client.next()).toMatchObject({ type: "presence", userId: memberId, selectedIds: ["x"] });
    a.client.send(batch(1, element("nope", 1, 1)));
    expect(await a.client.next()).toEqual({ type: "rejected", seq: 1, reason: "view-only" });
    expect(await b.client.drain()).toEqual([]);
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("tells a late joiner who is already here, and tells the others when someone leaves", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    a.client.send(presence({ pointer: { x: 3, y: 4 }, selectedIds: ["q"] })); await b.client.next();
    const late = await join(project, "unicode");
    expect(late.init.peers).toHaveLength(2);
    expect(late.init.peers.find((peer) => peer.sessionId === a.init.sessionId)).toMatchObject({ userId: memberId, pointer: { x: 3, y: 4 }, selectedIds: ["q"] });
    expect(late.init.peers.some((peer) => peer.sessionId === late.init.sessionId)).toBe(false);
    a.client.ws.close(1000);
    expect(await b.client.next()).toEqual({ type: "peer-left", sessionId: a.init.sessionId });
    expect(await late.client.next()).toEqual({ type: "peer-left", sessionId: a.init.sessionId });
    b.client.ws.close(1000); late.client.ws.close(1000);
  });

  it("keeps two tabs of one person apart: each its own session, each seeing the other", async () => {
    const project = await newProject();
    const one = await join(project, "member"); const two = await join(project, "member");
    expect(one.init.sessionId).not.toBe(two.init.sessionId);
    one.client.send(presence());
    expect(await two.client.next()).toMatchObject({ type: "presence", sessionId: one.init.sessionId, userId: memberId });
    expect(await one.client.drain()).toEqual([]);
    one.client.ws.close(1000);
    expect(await two.client.next()).toEqual({ type: "peer-left", sessionId: one.init.sessionId });
    two.client.ws.close(1000);
  });

  it("drops presence frames beyond about 30 per second per socket, and ignores a malformed one without closing", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    a.client.send(presence({ pointer: { x: "left", y: 0 } }));
    for (let index = 0; index < 100; index += 1) a.client.send(presence({ pointer: { x: index, y: 0 } }));
    const relayed = (await b.client.drain(400)).filter((message) => message.type === "presence");
    expect(relayed.length).toBeGreaterThan(0); expect(relayed.length).toBeLessThanOrEqual(31);
    expect(relayed[0]).toMatchObject({ pointer: { x: 0 } });
    a.client.send(batch(1, element("still-open", 1, 1)));
    expect(await a.client.next()).toEqual({ type: "ack", seq: 1 });
    a.client.ws.close(1000); b.client.ws.close(1000);
  });
});

describe("access changes reach live sockets (#499)", () => {
  it("archiving switches every staff socket to view-only at once, and restoring switches them back", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const admin = await join(project, "admin");
    expect((await api("admin", "POST", `/api/projects/${project}/archive`)).status).toBe(200);
    expect(await a.client.next()).toEqual({ type: "mode", mode: "view" });
    expect(await admin.client.next()).toEqual({ type: "mode", mode: "view" });
    a.client.send(batch(1, element("blocked", 1, 1)));
    expect(await a.client.next()).toEqual({ type: "rejected", seq: 1, reason: "view-only" });
    expect((await api("admin", "POST", `/api/projects/${project}/restore`)).status).toBe(200);
    expect(await a.client.next()).toEqual({ type: "mode", mode: "edit" });
    expect(await admin.client.next()).toEqual({ type: "mode", mode: "edit" });
    await save(a.client, 2, element("allowed", 1, 1));
    expect((await admin.client.next())).toMatchObject({ type: "elements", elements: [{ id: "allowed" }] });
    expect(byId(await initOf(project))["blocked"]).toBeUndefined();
    a.client.ws.close(1000); admin.client.ws.close(1000);
  });

  it("re-sends the mode when archive is retried after the Project was already archived (a heal for a lost notification)", async () => {
    const project = await newProject();
    const a = await join(project, "member");
    await database.DB.prepare("UPDATE projects SET archived_at = ?, archived_by = ? WHERE id = ?").bind(Date.now(), adminId, project).run();   // committed, notification lost
    expect((await api("admin", "POST", `/api/projects/${project}/archive`)).status).toBe(200);                                       // already_done
    expect(await a.client.next()).toEqual({ type: "mode", mode: "view" });
    await database.DB.prepare("UPDATE projects SET archived_at = NULL, archived_by = NULL WHERE id = ?").bind(project).run();
    expect((await api("admin", "POST", `/api/projects/${project}/restore`)).status).toBe(200);
    expect(await a.client.next()).toEqual({ type: "mode", mode: "edit" });
    a.client.ws.close(1000);
  });

  it("converges when notifications arrive out of order: the reread state decides, not the notification", async () => {
    const project = await newProject();
    const a = await join(project, "member");
    const stub = stubFor(project);
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), project).run();
    await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(project).run();   // restored after the archive...
    await stub.refreshAccess();                                                                             // ...but the archive's notification arrives last
    expect(await a.client.drain()).toEqual([]);                                                              // still editable: no flip
    await save(a.client, 1, element("fine", 1, 1));
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), project).run();
    await stub.refreshAccess(); await stub.refreshAccess();
    expect(await a.client.drain()).toEqual([{ type: "mode", mode: "view" }]);                                // a second notification changes nothing
    a.client.ws.close(1000);
  });

  it("removing a member closes only that person's sockets with 4403; the others keep editing", async () => {
    const project = await newProject();
    const removed = await join(project, "member"); const kept = await join(project, "member2"); const admin = await join(project, "admin");
    expect((await removeEditor(project, memberId)).status).toBe(200);
    expect((await removed.client.closed).code).toBe(4403);
    expect(await kept.client.next()).toEqual({ type: "peer-left", sessionId: removed.init.sessionId });
    await save(kept.client, 1, element("after-removal", 1, 1));
    expect(await admin.client.next()).toMatchObject({ type: "peer-left" });
    expect(await admin.client.next()).toMatchObject({ elements: [{ id: "after-removal" }] });
    kept.client.ws.close(1000); admin.client.ws.close(1000);
  });

  it("keeps an Admin's access when only their membership row is removed", async () => {
    const project = await newProject([[memberId, "editor"], [adminId, "editor"]]);
    const admin = await join(project, "admin");
    expect((await removeEditor(project, adminId)).status).toBe(200);
    expect(await admin.client.drain(300)).toEqual([]);
    await save(admin.client, 1, element("still-here", 1, 1));
    admin.client.ws.close(1000);
  });

  it("closes an assigned External editor's socket when the Project is archived, and switches staff to view-only", async () => {
    const project = await newProject([[memberId, "editor"], [externalId, "editor"]]);
    const staffSocket = await join(project, "member"); const external = await join(project, "external");
    expect((await api("admin", "POST", `/api/projects/${project}/archive`)).status).toBe(200);
    expect((await external.client.closed).code).toBe(4403);
    expect(await staffSocket.client.drain()).toContainEqual({ type: "mode", mode: "view" });
    staffSocket.client.ws.close(1000);
  });

  it("rejects a write on a socket whose access was revoked before any notification, closing it and storing nothing", async () => {
    const project = await newProject();
    const gone = await join(project, "member"); const other = await join(project, "member2");
    await database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(project, memberId).run();
    gone.client.send(batch(1, element("ghost", 1, 1)));
    expect((await gone.client.closed).code).toBe(4403);
    expect((await storedIds(project)).map((row) => row.id)).not.toContain("ghost");
    expect((await other.client.drain()).some((message) => message.type === "elements")).toBe(false);
    other.client.ws.close(1000);
  });

  it("closes sockets of a deactivated user at the next refresh", async () => {
    const project = await newProject();
    const a = await join(project, "member2"); const b = await join(project, "member");
    await database.DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(member2Id).run();
    try {
      await stubFor(project).refreshAccess();
      expect((await a.client.closed).code).toBe(4403);
    } finally { await database.DB.prepare("UPDATE user SET active = 1 WHERE id = ?").bind(member2Id).run(); }
    b.client.ws.close(1000);
  });
});


/** Makes the next `count` Project reads inside the Durable Object return their answer (read BEFORE the hold) only when that gate's `release` is called.
 * `hit()` polls until the read has been reached: awaiting a promise the object resolved would carry this test into the object's I/O context. */
async function holdProjectReads(projectId: string, count: number) {
  const gates = Array.from({ length: count }, () => { let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); return { gate, release }; });
  await runInDurableObject(stubFor(projectId), async (instance) => {
    const target = instance as unknown as { env: { DB: D1Database }; heldReads?: number }; const real = target.env.DB; let next = 0; target.heldReads = 0;
    const db = { prepare(sql: string) {
      const statement = real.prepare(sql);
      if (next >= count || !sql.includes("archived_at")) return statement;
      const mine = gates[next]!; next += 1;
      return { bind: (...values: unknown[]) => ({ first: async () => { const answer = await statement.bind(...values).first(); target.heldReads = (target.heldReads ?? 0) + 1; await mine.gate; return answer; } }) };
    } };
    target.env = Object.create(target.env, { DB: { value: db } });
  });
  return gates.map(({ release }, index) => ({
    release,
    hit: async () => { for (let attempt = 0; attempt < 100; attempt += 1) { if (await runInDurableObject(stubFor(projectId), async (instance) => ((instance as unknown as { heldReads?: number }).heldReads ?? 0) > index)) return; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error("the held read was never reached"); },
  }));
}
const holdNextProjectRead = async (projectId: string) => (await holdProjectReads(projectId, 1))[0]!;
const archiveNow = (project: string) => database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), project).run();
/** Invokes `refreshAccess()` inside the Durable Object without waiting for it (a pending cross-object call would block the test's own socket I/O); `settleRefreshes` waits. */
const startRefresh = (projectId: string) => runInDurableObject(stubFor(projectId), async (instance) => { const target = instance as unknown as { refreshAccess: () => Promise<void>; pendingRefreshes?: Array<Promise<void>> }; (target.pendingRefreshes ??= []).push(target.refreshAccess()); });
const settleRefreshes = (projectId: string) => runInDurableObject(stubFor(projectId), async (instance) => { const target = instance as unknown as { pendingRefreshes?: Array<Promise<void>> }; await Promise.all(target.pendingRefreshes ?? []); target.pendingRefreshes = []; });
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));


describe("admission and stale reads (Sol review)", () => {
  const trusted = (userId: string, projectId: string, mode = "edit") => ({ Upgrade: "websocket", "x-wb-user": userId, "x-wb-mode": mode, "x-wb-project": projectId, "x-wb-name": "Someone" });

  it("rechecks access and archive state at admission, even when the route authorised earlier", async () => {
    const project = await newProject();
    await database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(project, memberId).run();   // removed after the route's check
    expect((await stubFor(project).fetch(new Request("https://whiteboard.internal/socket", { headers: trusted(memberId, project) }))).status).toBe(403);
    const archived = await newProject(staff, true);
    const response = await stubFor(archived).fetch(new Request("https://whiteboard.internal/socket", { headers: trusted(memberId, archived, "edit") }));   // route saw it unarchived
    expect(response.status).toBe(101);
    const ws = response.webSocket!; const messages: WhiteboardServerMessage[] = [];
    ws.addEventListener("message", (event) => messages.push(JSON.parse(event.data as string))); ws.accept();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(messages[0]).toMatchObject({ type: "init", mode: "view" });
    ws.close(1000);
    expect((await stubFor(crypto.randomUUID()).fetch(new Request("https://whiteboard.internal/socket", { headers: trusted(memberId, crypto.randomUUID()) }))).status).toBe(404);
  });

  it("refuses admission when the reread is overtaken too: a removed member never receives 101 or init", async () => {
    const project = await newProject();
    const other = await join(project, "member2");                                     // a connected socket, so a refresh really reads
    const [firstRead, refreshRead, reread] = await holdProjectReads(project, 3);
    await runInDurableObject(stubFor(project), async (instance) => {                  // admission of `member`, started inside the object so the test never awaits it
      const target = instance as unknown as { fetch: (request: Request) => Promise<Response>; admission?: Promise<{ status: number; messages: unknown[] }> };
      target.admission = target.fetch(new Request("https://whiteboard.internal/socket", { headers: trusted(memberId, project) })).then((response) => {
        const messages: unknown[] = [];
        if (response.webSocket) { response.webSocket.addEventListener("message", (event) => messages.push(JSON.parse(event.data as string))); response.webSocket.accept(); }
        return { status: response.status, messages };
      });
    });
    await firstRead.hit();                                                            // read 1 (held): still a member
    await startRefresh(project);                                                      // overtakes read 1 (already_done: nothing changed)
    await refreshRead.hit(); refreshRead.release();
    firstRead.release();                                                              // admission waits for the refresh tail, then rereads (read 3)
    await reread.hit();                                                               // held: still a member
    await database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(project, memberId).run();   // removal commits...
    await startRefresh(project);                                                      // ...and its refresh is invoked during the reread
    reread.release();
    await settleRefreshes(project);
    const outcome = await runInDurableObject(stubFor(project), async (instance) => {
      const result = await (instance as unknown as { admission: Promise<{ status: number; messages: unknown[] }> }).admission;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return result;
    });
    expect(outcome.status).toBe(403);
    expect(outcome.messages).toEqual([]);
    other.client.ws.close(1000);
  });

  it("never commits a batch whose archive-state read was overtaken by an archive refresh", async () => {
    const project = await newProject();
    const a = await join(project, "member");
    const held = await holdNextProjectRead(project);
    a.client.send(batch(1, element("stale", 1, 1)));                              // reads "not archived", then waits
    await held.hit();
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), project).run();
    await stubFor(project).refreshAccess();
    expect(await a.client.next()).toEqual({ type: "mode", mode: "view" });
    held.release();
    expect(await a.client.next()).toEqual({ type: "rejected", seq: 1, reason: "view-only" });
    expect((await storedIds(project)).map((row) => row.id)).not.toContain("stale");
    a.client.ws.close(1000);
  });

  it("never upgrades a view-only socket from a write's read: a stale 'restored' answer cannot commit while archived", async () => {
    const project = await newProject(staff, true);
    const a = await join(project, "member");
    expect(a.init.mode).toBe("view");
    await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(project).run();     // restored, notification not yet delivered
    a.client.send(batch(1, element("stale", 1, 1)));                                                           // a read could say "restored"; it must not be used
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), project).run();   // archived again
    await stubFor(project).refreshAccess();                                                                   // confirms view
    const rest = await a.client.drain(200);
    expect(rest).toContainEqual({ type: "rejected", seq: 1, reason: "view-only" });
    expect(rest).not.toContainEqual({ type: "mode", mode: "edit" });
    expect(rest).not.toContainEqual({ type: "ack", seq: 1 });
    expect((await storedIds(project)).map((row) => row.id)).not.toContain("stale");
    a.client.ws.close(1000);
  });
})

describe("write authorization against refreshAccess (#499, epoch at invocation)", () => {
  it("A1: a refresh queued behind a held refresh still invalidates a write that read 'unarchived' meanwhile", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    const [r0, writeRead] = await holdProjectReads(project, 2);
    await startRefresh(project);                                                      // R0: its read is held
    await r0.hit();
    a.client.send(batch(1, element("stale", 1, 1)));                                 // starts during R0, reads "not archived", held
    await writeRead.hit();
    await archiveNow(project);                                                        // archive commits...
    await startRefresh(project);                                                      // ...and its notification queues behind R0
    writeRead.release(); await tick();                                               // the write's read returns
    r0.release();
    await settleRefreshes(project);
    const rest = await a.client.drain(300);
    expect(rest).toContainEqual({ type: "rejected", seq: 1, reason: "view-only" });
    expect(rest).not.toContainEqual({ type: "ack", seq: 1 });
    expect((await storedIds(project)).map((row) => row.id)).not.toContain("stale");
    expect((await b.client.drain(100)).filter((message) => message.type === "elements")).toEqual([]);
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("A2: a write whose reads are overtaken twice is rejected as stale and never commits from the stale read", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    const [firstRead, refreshRead, reread] = await holdProjectReads(project, 3);
    a.client.send(batch(1, element("stale", 1, 1)));                                 // read 1 (held): unarchived
    await firstRead.hit();
    await startRefresh(project);                                                      // overtakes read 1; its own read is read 2
    await refreshRead.hit(); refreshRead.release();
    firstRead.release();                                                              // the write awaits the refresh queue, then rereads (read 3)
    await reread.hit();                                                               // the reread: unarchived, held
    await archiveNow(project);
    await startRefresh(project);                                                      // overtakes the reread
    reread.release();
    await settleRefreshes(project);
    const rest = await a.client.drain(300);
    expect(rest).toContainEqual({ type: "rejected", seq: 1, reason: "stale" });
    expect(rest).not.toContainEqual({ type: "ack", seq: 1 });
    expect((await storedIds(project)).map((row) => row.id)).not.toContain("stale");
    expect((await b.client.drain(100)).filter((message) => message.type === "elements")).toEqual([]);
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("A3: a write that starts after a refresh was invoked (still held) sees the archive and is refused, not committed", async () => {
    const project = await newProject();
    const a = await join(project, "member");
    await archiveNow(project);
    const [held] = await holdProjectReads(project, 1);
    await startRefresh(project);                                                      // invoked, its read held
    await held.hit();
    a.client.send(batch(1, element("late", 1, 1)));
    const early = await a.client.drain(150);
    expect(early).not.toContainEqual({ type: "ack", seq: 1 });
    held.release(); await settleRefreshes(project);
    const rest = [...early, ...(await a.client.drain(200))];
    expect(rest).toContainEqual({ type: "mode", mode: "view" });
    expect(rest).toContainEqual({ type: "rejected", seq: 1, reason: "view-only" });
    expect(rest).not.toContainEqual({ type: "ack", seq: 1 });
    expect((await storedIds(project)).map((row) => row.id)).not.toContain("late");
    a.client.ws.close(1000);
  });

  it("A4: once `await refreshAccess()` returns, no write that was in flight before it commits", async () => {
    const project = await newProject();
    const a = await join(project, "member");
    const held = await holdNextProjectRead(project);
    a.client.send(batch(1, element("inflight", 1, 1)));                              // read "not archived", held
    await held.hit();
    await archiveNow(project);
    await stubFor(project).refreshAccess();                                          // the socket is view-only from here on
    held.release();
    expect(await a.client.next()).toEqual({ type: "mode", mode: "view" });
    expect(await a.client.next()).toEqual({ type: "rejected", seq: 1, reason: "view-only" });
    expect((await storedIds(project)).map((row) => row.id)).not.toContain("inflight");
    a.client.ws.close(1000);
  });

  it("A5: with no refresh in play a slow read is never 'stale': the write commits and is relayed", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    const held = await holdNextProjectRead(project);
    a.client.send(batch(1, element("slow", 1, 1)));
    await held.hit(); await tick(); held.release();
    expect(await a.client.next()).toEqual({ type: "ack", seq: 1 });
    expect(await b.client.next()).toMatchObject({ type: "elements", elements: [{ id: "slow" }] });
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("keeps the refresh queue alive after a refresh fails: later refreshes and writes still work", async () => {
    const project = await newProject();
    const a = await join(project, "member");
    await runInDurableObject(stubFor(project), async (instance) => {
      const target = instance as unknown as { env: { DB: D1Database } }; const real = target.env.DB; let failed = false;
      const db = { prepare(sql: string) { if (!failed && sql.includes("archived_at")) { failed = true; throw new Error("D1 unavailable"); } return real.prepare(sql); } };
      target.env = Object.create(target.env, { DB: { value: db } });
    });
    const outcome = await runInDurableObject(stubFor(project), async (instance) => (instance as unknown as { refreshAccess: () => Promise<void> }).refreshAccess().then(() => "ok", (error: Error) => error.message));
    expect(outcome).toBe("D1 unavailable");
    await save(a.client, 1, element("alive", 1, 1));                                 // a write that awaits the (failed) queue tail still commits
    await archiveNow(project);
    await stubFor(project).refreshAccess();                                          // and the queue still runs later refreshes
    expect(await a.client.next()).toEqual({ type: "mode", mode: "view" });
    a.client.ws.close(1000);
  });
});
