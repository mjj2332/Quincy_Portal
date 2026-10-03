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
const liveProject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherProject = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const archivedProject = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const deleteProject = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const hiddenProject = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const missingProject = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const tokens = { admin: "wb-admin-token", member: "wb-member-token", outsider: "wb-outsider-token", external: "wb-external-token" } as const;

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
type Client = { ws: WebSocket; next: () => Promise<WhiteboardServerMessage>; send: (message: unknown) => void; closed: Promise<{ code: number }> };
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
  };
}
const element = (id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", version, versionNonce, isDeleted: false, x: 0, y: 0, ...extra });
const batch = (seq: number, ...elements: unknown[]) => ({ type: "elements", seq, elements });
async function initOf(projectId: string, options: Options = {}) { const client = await connect(projectId, options); const init = await client.next(); client.ws.close(1000); return init as Extract<WhiteboardServerMessage, { type: "init" }>; }
async function save(client: Client, seq: number, ...elements: unknown[]) { client.send(batch(seq, ...elements)); expect(await client.next()).toEqual({ type: "ack", seq }); }
const stubFor = (projectId: string) => baseEnv.PROJECT_WHITEBOARD.get(baseEnv.PROJECT_WHITEBOARD.idFromName(projectId));
const byId = (init: { elements: Array<Record<string, unknown>> }) => Object.fromEntries(init.elements.map((entry) => [entry.id as string, entry]));

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__); const now = Date.now();
  for (const [id, role] of [[adminId, "admin"], [memberId, "editor"], [outsiderId, "editor"], [externalId, "external_editor"]]) await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(id, `${role} ${id.slice(0, 4)}`, `${id}@example.test`, role, now, now).run();
  for (const [who, userId] of [["admin", adminId], ["member", memberId], ["outsider", outsiderId], ["external", externalId]] as const) await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(`wb-${who}`, now + 3_600_000, tokens[who], userId, now, now).run();
  for (const [id, street] of [[liveProject, "Whiteboard Street"], [otherProject, "Other Street"], [archivedProject, "Archived Street"], [deleteProject, "Delete Street"], [hiddenProject, "Hidden Street"]]) await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', 0, ?, ?)").bind(id, street, now, now).run();
  await database.DB.prepare("UPDATE projects SET archived_at = ?, archived_by = ? WHERE id IN (?, ?)").bind(now, adminId, archivedProject, deleteProject).run();
  for (const [userId, project, role] of [[memberId, liveProject, "editor"], [memberId, otherProject, "editor"], [memberId, archivedProject, "editor"], [memberId, deleteProject, "editor"], [externalId, liveProject, "editor"]] as const) await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), project, userId, role, now).run();
});

describe("project whiteboard WebSocket route", () => {
  it("upgrades a collaborator's request through the full middleware stack and sends the empty scene", async () => {
    const client = await connect(liveProject, { who: "member" });
    expect(await client.next()).toEqual({ type: "init", mode: "edit", elements: [] });
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
    await save(client, 2, element("e", 1, 1, { x: 99 }));            // stale: ignored
    await save(client, 3, element("e", 2, 60, { x: 98 }));           // equal version, higher nonce: ignored
    expect(byId(await initOf(otherProject))["e"]).toMatchObject({ x: 1, versionNonce: 50 });
    await save(client, 4, element("e", 2, 40, { x: 2 }));            // equal version, lower nonce: wins
    await save(client, 5, element("e", 3, 70, { x: 3 }));            // higher version: wins
    expect(byId(await initOf(otherProject))["e"]).toMatchObject({ x: 3 });
    await save(client, 6, element("e", 4, 80, { isDeleted: true }));
    await save(client, 7, element("e", 2, 1, { x: 7 }));             // an old edit cannot resurrect it
    expect(byId(await initOf(otherProject))["e"]).toMatchObject({ isDeleted: true });
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
