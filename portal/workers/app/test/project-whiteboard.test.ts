import { env, evictDurableObject, listDurableObjectIds, runDurableObjectAlarm, runInDurableObject, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { generateKeyBetween } from "fractional-indexing";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
const tokens = { admin: "wb-admin-token", member: "wb-member-token", outsider: "wb-outsider-token", external: "wb-external-token", member2: "wb-member2-token", unicode: "wb-unicode-token", imposter: "wb-imposter-token" } as const;

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
// #499: the server keeps stored indices unique, so an element with no index (or a taken one) is re-keyed and sent back to its sender. Excalidraw always
// gives an element an index; each id here gets its own, in first-use order, unless a test passes one.
const defaultIndexes = new Map<string, string>(); let lastDefaultIndex: string | null = null;
const defaultIndex = (id: string) => { let key = defaultIndexes.get(id); if (!key) { key = generateKeyBetween(lastDefaultIndex, null); lastDefaultIndex = key; defaultIndexes.set(id, key); } return key; };
const element = (id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", version, versionNonce, isDeleted: false, x: 0, y: 0, index: defaultIndex(id), ...extra });
const batch = (seq: number, ...elements: unknown[]) => ({ type: "elements", seq, generation: 1, elements });
async function initOf(projectId: string, options: Options = {}) { const client = await connect(projectId, options); const init = await client.next(); client.ws.close(1000); return init as Extract<WhiteboardServerMessage, { type: "init" }>; }
async function save(client: Client, seq: number, ...elements: unknown[]) { client.send(batch(seq, ...elements)); expect(await client.next()).toEqual({ type: "ack", seq, generation: 1 }); }
/** A batch the sender LOSES: the stored row comes back first (so it converges), then the ack. */
async function saveLosing(client: Client, seq: number, ...elements: unknown[]) { client.send(batch(seq, ...elements)); expect(await client.next()).toMatchObject({ type: "elements" }); expect(await client.next()).toEqual({ type: "ack", seq, generation: 1 }); }
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
    expect(await client.next()).toEqual({ type: "init", mode: "edit", generation: 1, elements: [], sessionId: expect.any(String), peers: [] });
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
    expect(await client.next()).toEqual({ type: "rejected", seq: 1, reason: "view-only", generation: 1 });
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
    expect(await client.next()).toEqual({ type: "rejected", seq: 9, reason: "invalid", generation: 1 });
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
    expect(await client.next()).toEqual({ type: "rejected", seq: 2, reason: "view-only", generation: 1 });
    await database.DB.prepare("UPDATE projects SET archived_at = NULL, archived_by = NULL WHERE id = ?").bind(archiveLater).run();
    // A write never upgrades a socket (a delayed read could be stale): only a refresh does.
    client.send(batch(3, element("early", 1, 1)));
    expect(await client.next()).toEqual({ type: "rejected", seq: 3, reason: "view-only", generation: 1 });
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
    // An element with no usable index is given one at the end of the board (#499), and sent back to its sender before the ack.
    client.send(batch(1, element("a", 1, 1, { index: "a1" }), element("b", 1, 2, { index: "a2" }), element("c", 1, 3, { index: "a3" }), { ...element("noindex", 1, 4), index: undefined }, element("bad", 1, 5, { index: 7 })));
    expect(await client.next()).toMatchObject({ type: "elements", elements: [{ id: "noindex", version: 1 }, { id: "bad", version: 1 }] });
    expect(await client.next()).toEqual({ type: "ack", seq: 1, generation: 1 });
    await save(client, 2, element("c", 2, 9, { index: "Zz" })); // sent to back
    client.ws.close(1000);
    expect((await initOf(orderProject)).elements.map((entry) => entry.id)).toEqual(["c", "a", "b", "noindex", "bad"]);
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
    expect(await a.client.next()).toEqual({ type: "ack", seq: 1, generation: 1 });
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
    expect(seenByA).toContainEqual({ type: "ack", seq: 1, generation: 1 }); expect(seenByB).toContainEqual({ type: "ack", seq: 1, generation: 1 });
    expect(seenByA).toContainEqual(expect.objectContaining({ type: "elements", elements: [expect.objectContaining({ id: "from-b" })] }));
    expect(seenByB).toContainEqual(expect.objectContaining({ type: "elements", elements: [expect.objectContaining({ id: "from-a" })] }));
    expect(Object.keys(byId(await initOf(project)))).toEqual(expect.arrayContaining(["from-a", "from-b"]));
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("converges on a same-element conflict: the loser gets the stored row BEFORE its ack, the winner's side hears nothing more", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    b.client.send(batch(1, element("e", 3, 40, { x: 2 })));
    expect(await b.client.next()).toEqual({ type: "ack", seq: 1, generation: 1 });
    expect(await a.client.next()).toMatchObject({ type: "elements", elements: [{ id: "e", x: 2, versionNonce: 40 }] });
    a.client.send(batch(1, element("e", 3, 50, { x: 1 })));                       // equal version, higher nonce: loses
    expect(await a.client.next()).toMatchObject({ type: "elements", elements: [{ id: "e", x: 2, versionNonce: 40 }] });
    expect(await a.client.next()).toEqual({ type: "ack", seq: 1, generation: 1 });
    expect(await b.client.drain()).toEqual([]);                                    // nothing won, so nothing is relayed
    expect(await storedIds(project)).toContainEqual({ id: "e", version: 3, nonce: 40 });
    // the other way round: the lower nonce arrives second and wins
    a.client.send(batch(2, element("f", 4, 90, { x: 1 })));
    expect(await a.client.next()).toEqual({ type: "ack", seq: 2, generation: 1 });
    expect(await b.client.next()).toMatchObject({ elements: [{ id: "f", x: 1 }] });
    b.client.send(batch(2, element("f", 4, 20, { x: 9 })));
    expect(await b.client.next()).toEqual({ type: "ack", seq: 2, generation: 1 });
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
    expect(await a.client.next()).toEqual({ type: "ack", seq: 1, generation: 1 });
    expect(await b.client.next()).toMatchObject({ type: "elements", elements: [{ id: "new", x: 7 }] });
    expect(await b.client.drain()).toEqual([]);
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("treats a retried batch as idempotent: acknowledged, never relayed again, no correction", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    a.client.send(batch(1, element("r", 1, 10)));
    expect(await a.client.next()).toEqual({ type: "ack", seq: 1, generation: 1 }); await b.client.next();
    a.client.send(batch(2, element("r", 1, 10)));
    expect(await a.client.next()).toEqual({ type: "ack", seq: 2, generation: 1 });
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
    expect(await b.client.next()).toEqual({ type: "ack", seq: 1, generation: 1 });
    expect(await a.client.drain()).toEqual([]);
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("keeps relaying across a Durable Object eviction, and a reconnect catches up on what it missed", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    a.client.send(batch(1, element("one", 1, 1))); await a.client.next(); await b.client.next();
    await evictDurableObject(stubFor(project));
    a.client.send(batch(2, element("two", 1, 2)));
    expect(await a.client.next()).toEqual({ type: "ack", seq: 2, generation: 1 });
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
    expect(await a.client.next()).toEqual({ type: "rejected", seq: 1, reason: "view-only", generation: 1 });
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
    expect(await a.client.next()).toEqual({ type: "ack", seq: 1, generation: 1 });
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
    expect(await a.client.next()).toEqual({ type: "rejected", seq: 1, reason: "view-only", generation: 1 });
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
    expect(await a.client.next()).toEqual({ type: "rejected", seq: 1, reason: "view-only", generation: 1 });
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
    expect(rest).toContainEqual({ type: "rejected", seq: 1, reason: "view-only", generation: 1 });
    expect(rest).not.toContainEqual({ type: "mode", mode: "edit" });
    expect(rest).not.toContainEqual({ type: "ack", seq: 1, generation: 1 });
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
    expect(rest).toContainEqual({ type: "rejected", seq: 1, reason: "view-only", generation: 1 });
    expect(rest).not.toContainEqual({ type: "ack", seq: 1, generation: 1 });
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
    expect(rest).toContainEqual({ type: "rejected", seq: 1, reason: "stale", generation: 1 });
    expect(rest).not.toContainEqual({ type: "ack", seq: 1, generation: 1 });
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
    expect(early).not.toContainEqual({ type: "ack", seq: 1, generation: 1 });
    held.release(); await settleRefreshes(project);
    const rest = [...early, ...(await a.client.drain(200))];
    expect(rest).toContainEqual({ type: "mode", mode: "view" });
    expect(rest).toContainEqual({ type: "rejected", seq: 1, reason: "view-only", generation: 1 });
    expect(rest).not.toContainEqual({ type: "ack", seq: 1, generation: 1 });
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
    expect(await a.client.next()).toEqual({ type: "rejected", seq: 1, reason: "view-only", generation: 1 });
    expect((await storedIds(project)).map((row) => row.id)).not.toContain("inflight");
    a.client.ws.close(1000);
  });

  it("A5: with no refresh in play a slow read is never 'stale': the write commits and is relayed", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    const held = await holdNextProjectRead(project);
    a.client.send(batch(1, element("slow", 1, 1)));
    await held.hit(); await tick(); held.release();
    expect(await a.client.next()).toEqual({ type: "ack", seq: 1, generation: 1 });
    expect(await b.client.next()).toMatchObject({ type: "elements", elements: [{ id: "slow" }] });
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("an older refresh never applies its stale denial to a socket admitted after it started (Sol round 11)", async () => {
    const project = await newProject([[memberId, "editor"], [externalId, "editor"]]);
    const first = await join(project, "external");                                    // the External editor's first socket
    await archiveNow(project);
    // Refresh 1 reads the archived Project, so it denies the External editor, and is held before it applies that.
    await runInDurableObject(stubFor(project), async (instance) => {
      const target = instance as unknown as { userHasAccess: (userId: string, projectId: string) => Promise<boolean>; heldAccess?: number; releaseAccess?: () => void };
      const real = target.userHasAccess.bind(target); let calls = 0;
      const gate = new Promise<void>((resolve) => { target.releaseAccess = resolve; });
      target.userHasAccess = async (userId, projectId) => { calls += 1; const answer = await real(userId, projectId); if (calls === 1) { target.heldAccess = 1; await gate; } return answer; };
    });
    await startRefresh(project);
    for (let attempt = 0; attempt < 100 && !(await runInDurableObject(stubFor(project), async (instance) => (instance as unknown as { heldAccess?: number }).heldAccess)); attempt += 1) await tick(20);
    // The Project is restored and its refresh queued behind the held one; the External editor opens a new socket.
    await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(project).run();
    await startRefresh(project);
    const second = await join(project, "external");
    expect(second.init.mode).toBe("edit");
    await runInDurableObject(stubFor(project), async (instance) => (instance as unknown as { releaseAccess: () => void }).releaseAccess());
    await settleRefreshes(project);
    expect((await first.client.closed).code).toBe(4403);                              // the older socket was in that refresh's snapshot
    await tick(100);
    second.client.send(batch(1, element("after-refresh", 1, 1)));
    const rest = await second.client.drain(300);
    expect(rest).toContainEqual({ type: "ack", seq: 1, generation: 1 });                              // the new socket was never closed or rejected
    expect(rest).not.toContainEqual({ type: "mode", mode: "view" });
    second.client.ws.close(1000);
  });

  it("refreshAccess skips a closing socket ordered before an open one: the open socket still gets its mode", async () => {
    const project = await newProject();
    await archiveNow(project);
    const a = await join(project, "member");
    expect(a.init.mode).toBe("view");
    await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(project).run();
    await runInDurableObject(stubFor(project), async (instance, state) => {
      const real = state.getWebSockets();
      const attachment = real[0]!.deserializeAttachment();
      const closing = { readyState: 2, deserializeAttachment: () => ({ ...attachment, sessionId: "closing", mode: "view" }), serializeAttachment: () => undefined, send: () => { throw new Error("socket is closing"); }, close: () => undefined } as unknown as WebSocket;
      (state as unknown as { getWebSockets: () => WebSocket[] }).getWebSockets = () => [closing, ...real];
      await (instance as unknown as { refreshAccess: () => Promise<void> }).refreshAccess();
    });
    expect(await a.client.next()).toEqual({ type: "mode", mode: "edit" });
    a.client.ws.close(1000);
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

// ----------------------------------------------------------------------------------------------------------------------
// #499: the server guarantees unique, valid stored indices (the model test runs the same rules, `whiteboard-index.ts`, over
// a Map; these pin the SQLite adapter and the Durable Object around it).
const BASE62 = /^[0-9A-Za-z]+$/;
const indexesOf = (projectId: string) => runInDurableObject(stubFor(projectId), async (_instance, state) => state.storage.sql.exec("SELECT id, json_extract(json, '$.index') AS idx, version, version_nonce FROM elements ORDER BY id").toArray().map((row) => ({ id: row.id as string, index: row.idx as unknown, version: row.version as number, nonce: row.version_nonce as number })));
const expectUnique = (rows: Array<{ index: unknown }>) => { const indices = rows.map((row) => row.index); expect(indices.every((index) => typeof index === "string" && BASE62.test(index))).toBe(true); expect(new Set(indices).size).toBe(indices.length); };
const plant = (projectId: string, rows: Array<Record<string, unknown>>) => runInDurableObject(stubFor(projectId), async (_instance, state) => { for (const row of rows) state.storage.sql.exec("INSERT INTO elements (id, version, version_nonce, is_deleted, json, updated_at) VALUES (?, ?, ?, 0, ?, ?)", row.id as string, row.version as number, row.versionNonce as number, JSON.stringify(row), Date.now()); });

describe("stored indices are unique (#499)", () => {
  it("re-keys an element that takes a stored index: its sender hears the stored copy before its ack, the others get the stored form", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    a.client.send(batch(1, element("a", 1, 10, { index: "a0" }))); expect(await a.client.next()).toEqual({ type: "ack", seq: 1, generation: 1 }); await b.client.next();
    b.client.send(batch(1, element("b", 1, 20, { index: "a0", x: 7 })));
    const rewritten = { id: "b", index: "a1", x: 7, version: 1, versionNonce: 20 };   // the SAME authored revision, at the stored index
    expect(await b.client.next()).toMatchObject({ type: "elements", elements: [rewritten] });
    expect(await b.client.next()).toEqual({ type: "ack", seq: 1, generation: 1 });
    expect(await a.client.next()).toMatchObject({ type: "elements", elements: [rewritten] });          // peers receive what was STORED, not what was sent
    expect(await indexesOf(project)).toEqual([expect.objectContaining({ id: "a", index: "a0" }), expect.objectContaining({ id: "b", index: "a1", version: 1, nonce: 20 })]);
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("keeps the first of several elements that collide inside one batch and re-keys the rest in order", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    a.client.send(batch(1, element("x", 1, 1, { index: "a0" }), element("y", 1, 2, { index: "a0" }), element("z", 1, 3, { index: "a0" })));
    expect(await a.client.next()).toMatchObject({ type: "elements", elements: [{ id: "y", index: "a1", version: 1 }, { id: "z", index: "a0V", version: 1 }] });
    expect(await a.client.next()).toEqual({ type: "ack", seq: 1, generation: 1 });
    expect(await b.client.next()).toMatchObject({ elements: [{ id: "x", index: "a0", version: 1 }, { id: "y", index: "a1" }, { id: "z", index: "a0V" }] });
    expectUnique(await indexesOf(project));
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("an element moving off an index frees it for another element in the same batch", async () => {
    const project = await newProject();
    const a = await join(project, "member");
    await save(a.client, 1, element("m", 1, 1, { index: "a0" }));
    await save(a.client, 2, element("m", 2, 2, { index: "a5" }), element("n", 1, 3, { index: "a0" }));    // n takes what m just left: nothing is re-keyed
    expect((await indexesOf(project)).map((row) => [row.id, row.index, row.version])).toEqual([["m", "a5", 2], ["n", "a0", 1]]);
    a.client.ws.close(1000);
  });

  it("a re-key keeps the authored revision: the sender's correction carries it, and a concurrent deletion with the lower nonce still wins (Sol round 9)", async () => {
    const project = await newProject();
    const a = await join(project, "member"); const b = await join(project, "member2");
    await save(a.client, 1, element("e", 1, 10, { index: "a0" }), element("y", 1, 11, { index: "a1" }), element("x", 1, 12, { index: "a2" }));
    await b.client.drain();
    a.client.send(batch(2, element("e", 2, 50, { index: "a2", x: 5 })));                                 // collides with x
    expect(await a.client.next()).toMatchObject({ type: "elements", elements: [{ id: "e", index: "a3", version: 2, versionNonce: 50, x: 5 }] });
    expect(await a.client.next()).toEqual({ type: "ack", seq: 2, generation: 1 });
    b.client.send(batch(1, { ...element("e", 2, 40, { index: "a0" }), isDeleted: true }));            // concurrent delete, lower nonce
    await b.client.drain();
    expect(await storedRow(project, "e")).toMatchObject({ isDeleted: true, version: 2, versionNonce: 40 });
    expectUnique(await indexesOf(project));
    a.client.ws.close(1000); b.client.ws.close(1000);
  });

  it("stores a missing, malformed or empty index as a valid unique one and keeps the element's content", async () => {
    const project = await newProject();
    const a = await join(project, "member");
    a.client.send(batch(1, { ...element("m1", 1, 1, { x: 11 }), index: undefined }, element("m2", 1, 2, { x: 12, index: "!!" }), element("m3", 1, 3, { x: 13, index: "a0 " }), element("m4", 1, 4, { x: 14, index: 7 }), element("m5", 1, 5, { x: 15, index: "" }), element("m6", 1, 6, { x: 16, index: "a00" })));
    const back = await a.client.next() as { type: "elements"; elements: Array<Record<string, unknown>> };
    expect(back.elements.map((entry) => [entry.id, entry.x, entry.version])).toEqual([["m1", 11, 1], ["m2", 12, 1], ["m3", 13, 1], ["m4", 14, 1], ["m5", 15, 1], ["m6", 16, 1]]);
    expect(await a.client.next()).toEqual({ type: "ack", seq: 1, generation: 1 });
    expectUnique(await indexesOf(project));
    a.client.ws.close(1000);
  });

  it("re-keys a container above where it was and keeps it below its bound text (they may no longer sit side by side)", async () => {
    const project = await newProject();
    const a = await join(project, "member");
    await save(a.client, 1, element("s1", 1, 1, { index: "a0" }), element("s2", 1, 2, { index: "a1" }));
    a.client.send(batch(2, element("box", 1, 3, { index: "a0", boundElements: [{ id: "label", type: "text" }] }), element("label", 1, 4, { index: "a1", containerId: "box" })));
    await a.client.next(); expect(await a.client.next()).toEqual({ type: "ack", seq: 2, generation: 1 });
    const rows = await runInDurableObject(stubFor(project), async (_instance, state) => state.storage.sql.exec("SELECT json FROM elements").toArray().map((row) => JSON.parse(row.json as string) as Record<string, unknown>));
    const box = rows.find((row) => row.id === "box")!; const label = rows.find((row) => row.id === "label")!;
    expect(box.boundElements).toEqual([{ id: "label", type: "text" }]); expect(label.containerId).toBe("box");
    expect(box.index as string < (label.index as string)).toBe(true);
    expectUnique(await indexesOf(project));
    a.client.ws.close(1000);
  });

  it("normalises a table written before indices were unique when the object wakes, and tells the sockets that survived", async () => {
    const project = await newProject();
    const a = await join(project, "member");
    await plant(project, [{ ...element("p", 1, 1), index: "a0" }, { ...element("q", 1, 2), index: "a0" }, { ...element("r", 1, 3), index: undefined }, { ...element("s", 1, 4), index: "bad index" }, { ...element("t", 1, 5), index: "a1" }]);
    await evictDurableObject(stubFor(project));
    const b = await join(project, "member2");                                                            // the wake: normalises before serving this init
    expectUnique(b.init.elements as Array<{ index: unknown }>);
    expect(b.init.elements.map((entry) => entry.id)).toContain("p");
    const told = await a.client.next() as { type: "elements"; elements: Array<Record<string, unknown>> };
    expect(told.type).toBe("elements");
    expect(told.elements.map((entry) => entry.id).sort()).toEqual(["q", "r", "s"]);                      // p kept a0 (lowest id), t was already unique
    expect(told.elements.every((entry) => entry.version === 1)).toBe(true);
    expectUnique(await indexesOf(project));
    expect(await a.client.drain()).toEqual([]);
    // An already-unique table is a scan, not a rewrite: the next wake changes and announces nothing.
    await evictDurableObject(stubFor(project));
    const c = await join(project, "member"); expect(await a.client.drain()).toEqual([]);
    a.client.ws.close(1000); b.client.ws.close(1000); c.client.ws.close(1000);
  });
});

// ---- #500: version history -------------------------------------------------------------------------------------------
// The durable-object clock is overridden with a time FAR in the future, so the REAL alarm never fires while a test runs: the tests arm and fire
// the alarm by hand (`runDurableObjectAlarm`) and assert what `getAlarm()` says. Tests that leave the clock alone use the real one.

const INTERVAL = 30_000;
const farFuture = () => Date.now() + 3_600_000;
type Tunable = { clock: () => number; env: Record<string, unknown> };
const setClock = (projectId: string, at: number) => runInDurableObject(stubFor(projectId), async (instance) => { (instance as unknown as Tunable).clock = () => at; });
const alarmAt = (projectId: string) => runInDurableObject(stubFor(projectId), async (_instance, state) => state.storage.getAlarm());
const fire = (projectId: string) => runDurableObjectAlarm(stubFor(projectId));
type VersionRow = { id: string; ordinal: number; generation: number; sceneRevision: number; reason: string; state: string; elementCount: number; byteCount: number; sha: string; r2Key: string; createdBy: string | null };
const versionsOf = async (projectId: string) => (await database.DB.prepare("SELECT id, ordinal, generation, scene_revision AS sceneRevision, reason, state, element_count AS elementCount, byte_count AS byteCount, scene_sha256 AS sha, r2_key AS r2Key, created_by AS createdBy FROM project_whiteboard_versions WHERE project_id = ? ORDER BY ordinal").bind(projectId).all<VersionRow>()).results;
const objectKeys = async (projectId: string) => (await baseEnv.MEDIA.list({ prefix: `projects/${projectId}/whiteboard/versions/` })).objects.map((entry) => entry.key).sort();
type Envelope = { schema: number; projectId: string; versionId: string; generation: number; reason: string; elements: Array<Record<string, unknown>> };
const envelopeOf = async (key: string) => JSON.parse(await (await baseEnv.MEDIA.get(key))!.text()) as Envelope;
const storedRows = (projectId: string) => runInDurableObject(stubFor(projectId), async (_instance, state) => state.storage.sql.exec("SELECT json FROM elements ORDER BY id").toArray().map((row) => JSON.parse(row.json as string) as Record<string, unknown>));
const byIdSorted = (rows: Array<Record<string, unknown>>) => [...rows].sort((left, right) => String(left.id) < String(right.id) ? -1 : 1);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Swaps one binding of a live Durable Object for a wrapped one (eviction undoes it). */
type Wrap = (real: any) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
const inject = (projectId: string, name: "MEDIA" | "DB", wrap: Wrap) => runInDurableObject(stubFor(projectId), async (instance) => {
  const holder = instance as unknown as Tunable; const wrapped = wrap(holder.env[name]);
  holder.env = new Proxy(holder.env, { get: (target, key) => key === name ? wrapped : Reflect.get(target, key) });
});
const intercept = (method: string, behave: (args: unknown[], run: () => unknown) => unknown): Wrap => (real) => new Proxy(real, {
  get: (target, key) => { const value = Reflect.get(target, key); if (typeof value !== "function") return value; return key === method ? (...args: unknown[]) => behave(args, () => value.apply(target, args)) : value.bind(target); },
});
const failOnce = (method: string, when: (args: unknown[]) => boolean = () => true, times = 1): Wrap => { let left = times; return intercept(method, (args, run) => { if (left > 0 && when(args)) { left -= 1; throw new Error(`injected ${method} failure`); } return run(); }); };
/** Holds a binding call open. `reached` is polled (a continuation resumed from inside the Durable Object could not touch the test's own sockets). */
const gate = (method: string) => { let release!: () => void; let hit = false; const open = new Promise<void>((resolve) => { release = resolve; }); return { reached: () => vi.waitFor(() => expect(hit).toBe(true), { timeout: 5000 }), release, wrap: intercept(method, async (_args, run) => { hit = true; await open; return run(); }) }; };
const touchesVersions = (args: unknown[]) => /project_whiteboard_versions/i.test(String(args[0]));
const touchesAudit = (args: unknown[]) => /audit_log/i.test(String(args[0])) && /insert/i.test(String(args[0]));

/** One snapshot cycle: an edit at `at`, then the alarm at the +30 s deadline. */
async function cycle(project: string, client: Client, step: number, base: number, seqBase = 0) {
  const at = base + step * 100_000;
  await setClock(project, at);
  await save(client, seqBase + step + 1, element(`e${step}`, 1, step + 1));
  await setClock(project, at + INTERVAL);
  await fire(project);
}

describe("version snapshots: cadence (#500)", () => {
  it("arms an alarm exactly 30 s after the first winning change; presence, a duplicate and a losing batch arm nothing", async () => {
    const project = await newProject(); const t0 = farFuture(); await setClock(project, t0);
    const { client } = await join(project);
    client.send(presence()); await client.drain();
    expect(await alarmAt(project)).toBeNull();
    await save(client, 1, element("e", 2, 50));
    expect(await alarmAt(project)).toBe(t0 + INTERVAL);
    await setClock(project, t0 + INTERVAL); expect(await fire(project)).toBe(true);
    expect(await alarmAt(project)).toBeNull();                                  // clean boards stop cadence work
    await save(client, 2, element("e", 2, 50));                                   // the same batch again
    await saveLosing(client, 3, element("e", 1, 1));                              // a stale one
    expect(await alarmAt(project)).toBeNull();
    client.ws.close(1000);
  });

  it("does not snapshot at 29,999 ms and does at 30,000 ms", async () => {
    const project = await newProject(); const t0 = farFuture(); await setClock(project, t0);
    const { client } = await join(project);
    await save(client, 1, element("e", 1, 1));
    await setClock(project, t0 + INTERVAL - 1);
    await fire(project);
    expect(await versionsOf(project)).toEqual([]);
    expect(await alarmAt(project)).toBe(t0 + INTERVAL);                          // woken early: re-armed for the same deadline
    await setClock(project, t0 + INTERVAL);
    await fire(project);
    expect(await versionsOf(project)).toMatchObject([{ ordinal: 1, reason: "interval", generation: 1, state: "ready", elementCount: 1, createdBy: memberId }]);
    expect(await alarmAt(project)).toBeNull();
    client.ws.close(1000);
  });

  it("never slides the deadline: later edits keep the first one, and the next change after a snapshot arms the next 30 s", async () => {
    const project = await newProject(); const t0 = farFuture(); await setClock(project, t0);
    const { client } = await join(project);
    await save(client, 1, element("a", 1, 1));
    await setClock(project, t0 + 10_000); await save(client, 2, element("b", 1, 2));
    await setClock(project, t0 + 29_000); await save(client, 3, element("c", 1, 3));
    expect(await alarmAt(project)).toBe(t0 + INTERVAL);
    await setClock(project, t0 + INTERVAL); await fire(project);
    const [first] = await versionsOf(project);
    expect((await envelopeOf(first!.r2Key)).elements.map((entry) => entry.id).sort()).toEqual(["a", "b", "c"]);
    await setClock(project, t0 + 31_000); await save(client, 4, element("d", 1, 4));
    expect(await alarmAt(project)).toBe(t0 + 31_000 + INTERVAL);
    client.ws.close(1000);
  });

  it("keeps the deadline and the dirty mark across an eviction", async () => {
    const project = await newProject(); const t0 = farFuture(); await setClock(project, t0);
    const { client } = await join(project);
    await save(client, 1, element("e", 1, 1));
    await evictDurableObject(stubFor(project));
    expect(await alarmAt(project)).toBe(t0 + INTERVAL);
    await setClock(project, t0 + INTERVAL); await fire(project);
    expect(await versionsOf(project)).toMatchObject([{ reason: "interval", elementCount: 1 }]);
    client.ws.close(1000);
  });

  it("publishes the object first, then a ready row whose hash, counts and generation describe it; tombstones are in the object and in the hash", async () => {
    const project = await newProject(); const base = farFuture();
    const { client } = await join(project);
    await cycle(project, client, 0, base);                                       // {e0}
    await setClock(project, base + 200_000); await save(client, 50, element("e0", 2, 9, { isDeleted: true }));
    await setClock(project, base + 200_000 + INTERVAL); await fire(project);       // {e0 deleted}
    const [live, dead] = await versionsOf(project);
    expect(live).toMatchObject({ ordinal: 1, elementCount: 1 }); expect(dead).toMatchObject({ ordinal: 2, elementCount: 0 });
    expect(live!.sha).toMatch(/^[0-9a-f]{64}$/); expect(dead!.sha).not.toBe(live!.sha);
    expect(live!.r2Key).toBe(`projects/${project}/whiteboard/versions/${live!.id}.json`);
    const envelope = await envelopeOf(dead!.r2Key);
    expect(envelope).toMatchObject({ schema: 1, projectId: project, versionId: dead!.id, generation: 1, reason: "interval" });
    expect(envelope.elements).toMatchObject([{ id: "e0", version: 2, isDeleted: true }]);
    expect(dead!.byteCount).toBe((await baseEnv.MEDIA.head(dead!.r2Key))!.size);
    client.ws.close(1000);
  });

  it("does not publish an unchanged scene twice, yet still advances past the change that made the board dirty", async () => {
    const project = await newProject(); const base = farFuture();
    const { client } = await join(project);
    await cycle(project, client, 0, base);
    await runInDurableObject(stubFor(project), async (_instance, state) => { state.storage.sql.exec("UPDATE wb_state SET scene_revision = scene_revision + 1, snapshot_due_at = " + (base + 500_000) + ", last_author = last_author"); await state.storage.setAlarm(base + 500_000); });
    await setClock(project, base + 500_000); await fire(project);
    expect(await versionsOf(project)).toHaveLength(1);
    expect(await alarmAt(project)).toBeNull();
    client.ws.close(1000);
  });
});

describe("version snapshots: the last person to leave (#500)", () => {
  it("snapshots when the LAST socket leaves, not while another tab of anyone is still open", async () => {
    const project = await newProject();
    const one = await join(project, "member"); const two = await join(project, "member");
    await save(one.client, 1, element("e", 1, 1));
    expect(await two.client.next()).toMatchObject({ type: "elements" });
    one.client.ws.close(1000);
    expect(await two.client.next()).toMatchObject({ type: "peer-left" });
    await sleep(250);
    expect(await versionsOf(project)).toEqual([]);                                  // another connection remains
    expect(await alarmAt(project)).toBeGreaterThan(Date.now() + 20_000);             // still only the 30 s cadence
    two.client.ws.close(1000);
    await vi.waitFor(async () => expect(await versionsOf(project)).toMatchObject([{ reason: "last_leave", elementCount: 1 }]), { timeout: 5000 });
  });

  it("snapshots a board whose last viewer leaves too, and a clean board leaves no version", async () => {
    const project = await newProject();
    const clean = await join(project, "member"); clean.client.ws.close(1000);
    await sleep(300);
    expect(await versionsOf(project)).toEqual([]);
    expect(await alarmAt(project)).toBeNull();
  });

  it("snapshots exactly once when the last socket is revoked (revocation and the close event share one departure path)", async () => {
    const project = await newProject();
    const a = await join(project, "member");
    await save(a.client, 1, element("e", 1, 1));
    expect((await removeEditor(project, memberId)).status).toBe(200);
    expect((await a.client.closed).code).toBe(4403);
    await vi.waitFor(async () => expect(await versionsOf(project)).toHaveLength(1), { timeout: 5000 });
    await sleep(400);
    expect(await versionsOf(project)).toMatchObject([{ reason: "last_leave" }]);
  });
});

describe("version snapshots: publication, retries and retention (#500)", () => {
  it("retries a failed R2 PUT with the same ordinal and leaves the board dirty meanwhile", async () => {
    const project = await newProject(); const t0 = farFuture(); await setClock(project, t0);
    const { client } = await join(project);
    await save(client, 1, element("e", 1, 1));
    await inject(project, "MEDIA", failOnce("put"));
    await setClock(project, t0 + INTERVAL); await fire(project);
    expect(await versionsOf(project)).toEqual([]); expect(await objectKeys(project)).toEqual([]);
    const retry = await alarmAt(project);
    expect(retry).toBeGreaterThan(t0 + INTERVAL);
    await setClock(project, retry!); await fire(project);
    expect(await versionsOf(project)).toMatchObject([{ ordinal: 1, reason: "interval" }]);
    expect(await objectKeys(project)).toHaveLength(1);
    client.ws.close(1000);
  });

  it("retries a failed index insert reusing the same R2 object: no orphan, no ready row before the object exists", async () => {
    const project = await newProject(); const t0 = farFuture(); await setClock(project, t0);
    const { client } = await join(project);
    await save(client, 1, element("e", 1, 1));
    await inject(project, "DB", failOnce("prepare", (args) => touchesVersions(args) && /insert/i.test(String(args[0]))));
    await setClock(project, t0 + INTERVAL); await fire(project);
    expect(await versionsOf(project)).toEqual([]);
    expect(await objectKeys(project)).toHaveLength(1);                              // the object was put first
    const retry = await alarmAt(project); expect(retry).not.toBeNull();
    await setClock(project, retry!); await fire(project);
    const rows = await versionsOf(project);
    expect(rows).toMatchObject([{ ordinal: 1, state: "ready" }]);
    expect(await objectKeys(project)).toEqual([rows[0]!.r2Key]);
    client.ws.close(1000);
  });

  it("keeps an edit made DURING publication dirty: the first version excludes it and the next deadline captures it", async () => {
    const project = await newProject(); const t0 = farFuture(); await setClock(project, t0);
    const { client } = await join(project);
    await save(client, 1, element("before", 1, 1));
    const held = gate("put"); await inject(project, "MEDIA", held.wrap);
    await setClock(project, t0 + INTERVAL);
    const running = fire(project);
    await held.reached();
    await save(client, 2, element("during", 1, 2));                                 // lands while the PUT is in flight
    held.release(); await running;
    const [first] = await versionsOf(project);
    expect((await envelopeOf(first!.r2Key)).elements.map((entry) => entry.id)).toEqual(["before"]);
    const next = await alarmAt(project); expect(next).not.toBeNull();               // still dirty: a new deadline was armed
    await setClock(project, next!); await fire(project);
    const rows = await versionsOf(project);
    expect(rows).toHaveLength(2);
    expect((await envelopeOf(rows[1]!.r2Key)).elements.map((entry) => entry.id).sort()).toEqual(["before", "during"]);
    client.ws.close(1000);
  });

  it("keeps the newest 30 ready versions: the 31st prunes the oldest object and row", async () => {
    const project = await newProject(); const base = farFuture();
    const { client } = await join(project);
    for (let step = 0; step < 31; step += 1) await cycle(project, client, step, base);
    const rows = await versionsOf(project);
    expect(rows).toHaveLength(30);
    expect(rows.map((row) => row.ordinal)).toEqual(Array.from({ length: 30 }, (_, index) => index + 2));
    expect(rows.every((row) => row.state === "ready")).toBe(true);
    expect(await objectKeys(project)).toEqual(rows.map((row) => row.r2Key).sort());
    client.ws.close(1000);
  }, 60_000);

  it("keeps a pruning row and its object when the delete fails, retries on the next alarm, and treats a missing object as deleted", async () => {
    const project = await newProject(); const base = farFuture();
    const { client } = await join(project);
    for (let step = 0; step < 30; step += 1) await cycle(project, client, step, base);
    const oldest = (await versionsOf(project))[0]!;
    await inject(project, "MEDIA", failOnce("delete"));
    await cycle(project, client, 30, base);
    expect((await versionsOf(project)).find((row) => row.id === oldest.id)).toMatchObject({ state: "pruning" });
    expect(await baseEnv.MEDIA.head(oldest.r2Key)).not.toBeNull();
    const listed = await (await getVersions("member", project)).json() as { versions: unknown[] };
    expect(listed.versions).toHaveLength(30);                                       // a pruning version is never offered
    const retry = await alarmAt(project); expect(retry).not.toBeNull();
    await baseEnv.MEDIA.delete(oldest.r2Key);                                       // already gone: counts as deleted
    await setClock(project, retry!); await fire(project);
    expect((await versionsOf(project)).find((row) => row.id === oldest.id)).toBeUndefined();
    expect(await versionsOf(project)).toHaveLength(30);
    client.ws.close(1000);
  }, 60_000);
});

describe("version snapshots: hard delete (#500)", () => {
  async function archiveAndDelete(project: string) {
    expect((await api("admin", "POST", `/api/projects/${project}/archive`)).status).toBe(200);
    return api("admin", "DELETE", `/api/projects/${project}`);
  }

  it("removes every version object and row, and leaves no alarm to resurrect them", async () => {
    const project = await newProject(); const base = farFuture();
    const { client } = await join(project);
    await cycle(project, client, 0, base);
    await save(client, 99, element("pending", 1, 1)); // dirty with an armed deadline
    expect(await objectKeys(project)).toHaveLength(1);
    expect((await archiveAndDelete(project)).status).toBe(200);
    expect(await objectKeys(project)).toEqual([]);
    expect(await versionsOf(project)).toEqual([]);
    expect(await alarmAt(project)).toBeNull();
    await setClock(project, base + 9_000_000); await fire(project);                 // a late alarm finds nothing to do
    expect(await objectKeys(project)).toEqual([]);
  });

  it("drains a publication that is in flight, so a late PUT cannot recreate an object after the purge", async () => {
    const project = await newProject(); const t0 = farFuture(); await setClock(project, t0);
    const { client } = await join(project);
    await save(client, 1, element("e", 1, 1));
    const held = gate("put"); await inject(project, "MEDIA", held.wrap);
    await setClock(project, t0 + INTERVAL);
    const running = fire(project);
    await held.reached();
    const purging = stubFor(project).purge();
    await sleep(50); held.release();
    await Promise.all([running, purging]);
    expect(await objectKeys(project)).toEqual([]);
    expect(await alarmAt(project)).toBeNull();
    expect(await versionsOf(project)).toEqual([]);
  });
});

// ---- versions listing and restore over HTTP ------------------------------------------------------------------------------

async function getVersions(who: Who | null, projectId: string, versionsPath = "versions") {
  const headers = new Headers(); if (who) headers.set("cookie", await cookie(tokens[who]));
  return workerSelf.fetch(`https://portal.test/api/projects/${projectId}/whiteboard/${versionsPath}`, { headers });
}
const restorePath = (projectId: string, versionId: string) => `/api/projects/${projectId}/whiteboard/versions/${versionId}/restore`;
const restoreBody = (expectedGeneration = 1, requestId: string = crypto.randomUUID()) => ({ expectedGeneration, requestId });
const auditRows = async (projectId: string) => (await database.DB.prepare("SELECT actor_id AS actorId, action, target_type AS targetType, target_id AS targetId, meta_json AS meta FROM audit_log WHERE action = 'project_whiteboard.restore' AND target_id = ?").bind(projectId).all<{ actorId: string; action: string; targetType: string; targetId: string; meta: string }>()).results;

/** V1 = {a, b}; the board then moves on to {a edited, b deleted, c, d} = V2. */
async function boardWithHistory() {
  const project = await newProject(); const base = farFuture();
  const { client } = await join(project);
  await setClock(project, base);
  await save(client, 1, element("a", 1, 11, { x: 1 }), element("b", 1, 12, { x: 2 }));
  await setClock(project, base + INTERVAL); await fire(project);
  await setClock(project, base + 100_000);
  await save(client, 2, element("a", 2, 21, { x: 10 }), element("b", 2, 22, { isDeleted: true }), element("c", 1, 23, { x: 3 }), element("d", 1, 24, { x: 4 }));
  await setClock(project, base + 100_000 + INTERVAL); await fire(project);
  const [v1, v2] = await versionsOf(project);
  return { project, client, v1: v1!, v2: v2!, base };
}

describe("GET whiteboard versions (#500)", () => {
  it("lists ready versions newest first with author, reason and counts, and the board's generation", async () => {
    const { project, client, v1, v2 } = await boardWithHistory();
    const response = await getVersions("member", project);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      generation: 1,
      versions: [
        { id: v2.id, createdAt: expect.any(Number), createdBy: { id: memberId, name: expect.any(String) }, reason: "interval", elementCount: 3, byteCount: v2.byteCount },
        { id: v1.id, createdAt: expect.any(Number), createdBy: { id: memberId, name: expect.any(String) }, reason: "interval", elementCount: 2, byteCount: v1.byteCount },
      ],
    });
    client.ws.close(1000);
  });

  it("follows the collaboration rules: collaborators and admins see it, outsiders and unseen External editors do not, and a view-only (archived) board can still be browsed", async () => {
    const { project, client } = await boardWithHistory();
    expect((await getVersions("admin", project)).status).toBe(200);
    expect((await getVersions("outsider", project)).status).toBe(403);
    expect((await getVersions(null, project)).status).toBe(401);
    expect((await getVersions("member", "not-a-uuid")).status).toBe(400);
    expect((await getVersions("member", missingProject)).status).toBe(403);
    expect((await getVersions("external", hiddenProject)).status).toBe(404);
    expect((await getVersions("external", liveProject)).status).toBe(200);
    expect((await api("admin", "POST", `/api/projects/${project}/archive`)).status).toBe(200);
    expect((await getVersions("member", project)).status).toBe(200);
    client.ws.close(1000);
  });

  it("addresses no Durable Object for a refused caller", async () => {
    const before = (await listDurableObjectIds(baseEnv.PROJECT_WHITEBOARD)).length;
    expect((await getVersions("outsider", liveProject)).status).toBe(403);
    expect((await getVersions("external", hiddenProject)).status).toBe(404);
    expect((await listDurableObjectIds(baseEnv.PROJECT_WHITEBOARD)).length).toBe(before);
  });
});

describe("POST whiteboard version restore (#500)", () => {
  it("installs the version's rows EXACTLY, bumps the generation, backs the current scene up first, and resets every socket", async () => {
    const { project, client, v1, v2 } = await boardWithHistory();
    const other = await join(project, "member2");
    const before = byIdSorted(await storedRows(project));
    const response = await api("member", "POST", restorePath(project, v1.id), restoreBody());
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; generation: number; backupVersionId: string };
    expect(body).toEqual({ ok: true, generation: 2, versionId: v1.id, backupVersionId: expect.any(String) });
    const snapshot = (await envelopeOf(v1.r2Key)).elements;
    expect(byIdSorted(await storedRows(project))).toEqual(byIdSorted(snapshot));       // the captured versions and nonces, no revision inflation
    expect(byIdSorted(await storedRows(project)).map((row) => row.id)).toEqual(["a", "b"]);   // c and d are gone, not tombstoned
    expect(await storedRows(project)).toContainEqual(expect.objectContaining({ id: "a", version: 1, versionNonce: 11, x: 1 }));
    for (const socket of [client, other.client]) {
      expect(await socket.next()).toEqual({ type: "reset", generation: 2, elements: expect.any(Array) });
    }
    const backup = (await versionsOf(project)).find((row) => row.id === body.backupVersionId)!;
    expect(backup).toMatchObject({ reason: "pre_restore", createdBy: memberId, ordinal: 3, generation: 1 });
    expect(byIdSorted((await envelopeOf(backup.r2Key)).elements)).toEqual(before);        // the scene as it stood, tombstones and all
    expect((await versionsOf(project)).find((row) => row.id === v2.id)).toBeDefined();
    expect(await (await getVersions("member", project)).json()).toMatchObject({ generation: 2 });
    expect((await initOf(project)).generation).toBe(2);
    client.ws.close(1000); other.client.ws.close(1000);
  });

  it("refuses stale and absent generations after a restore, and accepts the new one", async () => {
    const { project, client, v1 } = await boardWithHistory();
    const other = await join(project, "member2");
    expect((await api("member", "POST", restorePath(project, v1.id), restoreBody())).status).toBe(200);
    await client.next(); await other.client.next();                                  // the reset frames
    client.send({ type: "elements", seq: 5, generation: 1, elements: [element("late", 5, 5)] });
    expect(await client.next()).toEqual({ type: "rejected", seq: 5, reason: "generation", generation: 2 });
    client.send({ type: "elements", seq: 6, elements: [element("legacy", 1, 1)] });  // a tab that predates generations
    expect(await client.next()).toEqual({ type: "rejected", seq: 6, reason: "generation", generation: 2 });
    expect(byIdSorted(await storedRows(project)).map((row) => row.id)).toEqual(["a", "b"]);
    client.send({ type: "elements", seq: 7, generation: 2, elements: [element("fresh", 1, 1)] });
    expect(await client.next()).toEqual({ type: "ack", seq: 7, generation: 2 });
    expect(await other.client.next()).toMatchObject({ type: "elements", generation: 2, elements: [{ id: "fresh" }] });
    client.ws.close(1000); other.client.ws.close(1000);
  });

  it("is idempotent for one request id: one backup, one generation step, one audit row, the same answer", async () => {
    const { project, client, v1, v2 } = await boardWithHistory();
    const body = restoreBody();
    const first = await api("member", "POST", restorePath(project, v1.id), body);
    const second = await api("member", "POST", restorePath(project, v1.id), body);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect((await versionsOf(project)).filter((row) => row.reason === "pre_restore")).toHaveLength(1);
    expect(await (await getVersions("member", project)).json()).toMatchObject({ generation: 2 });
    expect(await auditRows(project)).toHaveLength(1);
    const reused = await api("member", "POST", restorePath(project, v2.id), body);
    expect(reused.status).toBe(409); expect(await reused.json()).toMatchObject({ code: "request_id_reused" });
    client.ws.close(1000);
  });

  it("refuses a stale expectedGeneration with the current one and leaves the board alone", async () => {
    const { project, client, v1, v2 } = await boardWithHistory();
    expect((await api("member", "POST", restorePath(project, v1.id), restoreBody())).status).toBe(200);
    const rows = byIdSorted(await storedRows(project));
    const stale = await api("member", "POST", restorePath(project, v2.id), restoreBody(1));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "stale_generation", generation: 2 });
    expect(byIdSorted(await storedRows(project))).toEqual(rows);
    expect((await versionsOf(project)).filter((row) => row.reason === "pre_restore")).toHaveLength(1);
    client.ws.close(1000);
  });

  it("validates the request: a UUID request id, a positive generation, nothing extra, and UUID path ids", async () => {
    const { project, client, v1 } = await boardWithHistory();
    for (const bad of [undefined, {}, { expectedGeneration: 1 }, { requestId: crypto.randomUUID() }, restoreBody(0), { ...restoreBody(), requestId: "nope" }, { ...restoreBody(), extra: 1 }]) {
      expect((await api("member", "POST", restorePath(project, v1.id), bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await api("member", "POST", restorePath(project, "not-a-uuid"), restoreBody())).status).toBe(400);
    expect((await api("member", "POST", restorePath("not-a-uuid", v1.id), restoreBody())).status).toBe(400);
    client.ws.close(1000);
  });

  it("authorises like a write: collaborators and admins may restore; outsiders, unseen External editors, other origins and anonymous callers may not", async () => {
    const { project, client, v1 } = await boardWithHistory();
    const rows = byIdSorted(await storedRows(project));
    expect((await api("outsider", "POST", restorePath(project, v1.id), restoreBody())).status).toBe(403);
    expect((await api("external", "POST", restorePath(hiddenProject, v1.id), restoreBody())).status).toBe(404);
    const evil = await workerSelf.fetch(`https://portal.test${restorePath(project, v1.id)}`, { method: "POST", headers: { cookie: await cookie(tokens.member), origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify(restoreBody()) });
    expect(evil.status).toBe(403);
    const anonymous = await workerSelf.fetch(`https://portal.test${restorePath(project, v1.id)}`, { method: "POST", headers: { origin: baseEnv.APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify(restoreBody()) });
    expect(anonymous.status).toBe(401);
    expect(byIdSorted(await storedRows(project))).toEqual(rows);
    expect((await api("admin", "POST", restorePath(project, v1.id), restoreBody())).status).toBe(200);
    client.ws.close(1000);
  });

  it("cannot restore an Archived Project, though its history can be browsed", async () => {
    const { project, client, v1 } = await boardWithHistory();
    expect((await api("admin", "POST", `/api/projects/${project}/archive`)).status).toBe(200);
    const rows = byIdSorted(await storedRows(project));
    const response = await api("member", "POST", restorePath(project, v1.id), restoreBody());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "archived" });
    expect(byIdSorted(await storedRows(project))).toEqual(rows);
    expect((await versionsOf(project)).filter((row) => row.reason === "pre_restore")).toEqual([]);
    expect(await (await getVersions("member", project)).json()).toMatchObject({ generation: 1 });
    client.ws.close(1000);
  });

  it("re-checks access and archive state inside the Durable Object, whatever the route saw", async () => {
    const { project, client, v1 } = await boardWithHistory();
    const actor = { id: memberId, impersonatedBy: null };
    const input = (requestId = crypto.randomUUID()) => ({ projectId: project, versionId: v1.id, expectedGeneration: 1, requestId, actor });
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), project).run();
    expect(await stubFor(project).restoreVersion(input())).toMatchObject({ ok: false, status: 409, code: "archived" });
    await database.DB.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").bind(project).run();
    await database.DB.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?").bind(project, memberId).run();
    expect(await stubFor(project).restoreVersion(input())).toMatchObject({ ok: false, status: 403, code: "forbidden" });
    await database.DB.prepare("DELETE FROM projects WHERE id = ?").bind(project).run();
    expect(await stubFor(project).restoreVersion(input())).toMatchObject({ ok: false, status: 404 });
    client.ws.close(1000);
  });

  it("answers 404 for a version of another Project or one that does not exist, changing nothing", async () => {
    const mine = await boardWithHistory(); const theirs = await boardWithHistory();
    const rows = byIdSorted(await storedRows(mine.project));
    for (const versionId of [theirs.v1.id, crypto.randomUUID()]) {
      const response = await api("member", "POST", restorePath(mine.project, versionId), restoreBody());
      expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ code: "version_not_found" });
    }
    expect(byIdSorted(await storedRows(mine.project))).toEqual(rows);
    expect((await versionsOf(mine.project)).filter((row) => row.reason === "pre_restore")).toEqual([]);
    mine.client.ws.close(1000); theirs.client.ws.close(1000);
  });

  it.each([
    ["a missing object", "snapshot_unavailable", async () => undefined],
    ["an object that is not JSON", "snapshot_corrupt", async (key: string) => { await baseEnv.MEDIA.put(key, "not json"); }],
    ["an object whose rows no longer match the recorded hash", "snapshot_corrupt", async (key: string) => { const envelope = await envelopeOf(key); envelope.elements[0] = { ...envelope.elements[0]!, x: 12345 }; await baseEnv.MEDIA.put(key, JSON.stringify(envelope)); }],
    ["an object with an invalid element", "snapshot_corrupt", async (key: string) => { const envelope = await envelopeOf(key); envelope.elements.push({ id: "bad" }); await baseEnv.MEDIA.put(key, JSON.stringify(envelope)); }],
  ])("refuses %s with %s, writes no backup and leaves the board and generation alone", async (_name, code, corrupt) => {
    const { project, client, v1 } = await boardWithHistory();
    if (code === "snapshot_unavailable") await baseEnv.MEDIA.delete(v1.r2Key); else await corrupt(v1.r2Key);
    const rows = byIdSorted(await storedRows(project));
    const response = await api("member", "POST", restorePath(project, v1.id), restoreBody());
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ code });
    expect(byIdSorted(await storedRows(project))).toEqual(rows);
    expect((await versionsOf(project)).filter((row) => row.reason === "pre_restore")).toEqual([]);
    expect(await (await getVersions("member", project)).json()).toMatchObject({ generation: 1 });
    client.ws.close(1000);
  });

  it("leaves the board unchanged and its socket alive when the backup cannot be written, and the same request id can be retried", async () => {
    const { project, client, v1 } = await boardWithHistory();
    const rows = byIdSorted(await storedRows(project));
    await inject(project, "MEDIA", failOnce("put"));
    const body = restoreBody();
    const failed = await api("member", "POST", restorePath(project, v1.id), body);
    expect(failed.status).toBe(502); expect(await failed.json()).toMatchObject({ code: "backup_failed" });
    expect(byIdSorted(await storedRows(project))).toEqual(rows);
    expect((await versionsOf(project)).filter((row) => row.reason === "pre_restore")).toEqual([]);
    expect(await auditRows(project)).toEqual([]);
    await save(client, 9, element("still-works", 1, 1));                              // the object was not reset: same socket, same generation
    const retried = await api("member", "POST", restorePath(project, v1.id), body);
    expect(retried.status).toBe(200);
    client.ws.close(1000);
  });

  it("audits project_whiteboard.restore as the effective user with the request, versions and generations", async () => {
    const { project, client, v1 } = await boardWithHistory();
    const body = restoreBody();
    const response = await api("member", "POST", restorePath(project, v1.id), body);
    const { backupVersionId } = await response.json() as { backupVersionId: string };
    const [row] = await auditRows(project);
    expect(row).toMatchObject({ actorId: memberId, action: "project_whiteboard.restore", targetType: "project", targetId: project });
    const meta = JSON.parse(row!.meta) as Record<string, unknown>;
    expect(meta).toEqual({ requestId: body.requestId, versionId: v1.id, backupVersionId, oldGeneration: 1, newGeneration: 2 });
    client.ws.close(1000);
  });

  it("records impersonatedBy and acts as the impersonated user, with no admin override", async () => {
    const { project, client, v1 } = await boardWithHistory();
    const now = Date.now();
    await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'user_impersonation'").run();
    await database.DB.prepare("INSERT OR REPLACE INTO session (id, expires_at, token, user_id, created_at, updated_at, impersonated_by) VALUES ('wb-imposter', ?, ?, ?, ?, ?, ?)").bind(now + 3_600_000, tokens.imposter, memberId, now, now, adminId).run();
    try {
      const body = restoreBody();
      expect((await api("imposter", "POST", restorePath(project, v1.id), body)).status).toBe(200);
      const [row] = await auditRows(project);
      expect(row).toMatchObject({ actorId: memberId });
      expect(JSON.parse(row!.meta)).toMatchObject({ impersonatedBy: adminId, requestId: body.requestId, versionId: v1.id });
      // acting AS the member: the member's own access decides, so a Project the member is not on stays closed
      expect((await api("imposter", "POST", restorePath(hiddenProject, v1.id), restoreBody())).status).toBe(403);
    } finally {
      await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'user_impersonation'").run();
      await database.DB.prepare("DELETE FROM session WHERE id = 'wb-imposter'").run();
    }
    client.ws.close(1000);
  });

  it("does not lose the audit when its write fails: the restore stands and a later alarm delivers it exactly once", async () => {
    const { project, client, v1 } = await boardWithHistory();
    await inject(project, "DB", failOnce("prepare", touchesAudit));
    const body = restoreBody();
    expect((await api("member", "POST", restorePath(project, v1.id), body)).status).toBe(200);
    expect(await auditRows(project)).toEqual([]);
    const retry = await alarmAt(project); expect(retry).not.toBeNull();
    await setClock(project, retry!); await fire(project);
    expect(await auditRows(project)).toHaveLength(1);
    expect((await api("member", "POST", restorePath(project, v1.id), body)).status).toBe(200);   // a repeat delivers nothing more
    await setClock(project, retry! + 100_000); await fire(project);
    expect(await auditRows(project)).toHaveLength(1);
    client.ws.close(1000);
  });

  it("marks the restored board dirty so it is snapshotted on the normal cadence", async () => {
    const { project, client, v1, base } = await boardWithHistory();
    await setClock(project, base + 500_000);
    expect((await api("member", "POST", restorePath(project, v1.id), restoreBody())).status).toBe(200);
    expect(await alarmAt(project)).toBe(base + 500_000 + INTERVAL);
    client.ws.close(1000);
  });
});
