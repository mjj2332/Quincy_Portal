import { env, runDurableObjectAlarm, runInDurableObject, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { generateKeyBetween } from "fractional-indexing";
import { expect, vi } from "vitest";
import { WHITEBOARD_PROTOCOL, type WhiteboardServerMessage } from "@quincy/shared";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";

/**
 * Shared harness for the Project whiteboard worker tests (#498 onward, extracted for #501): real WebSocket upgrades through `SELF.fetch`,
 * a queueing client, the users and Projects both files seed, and reads of the Durable Object's own storage.
 */
export const database = env as unknown as { DB: D1Database };
export const baseEnv = env as unknown as Env;
export const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;

export const adminId = "11111111-1111-4111-8111-111111111111";
export const memberId = "22222222-2222-4222-8222-222222222222";
export const outsiderId = "33333333-3333-4333-8333-333333333333";
export const externalId = "44444444-4444-4444-8444-444444444444";
export const member2Id = "55555555-5555-4555-8555-555555555555";
export const unicodeId = "66666666-6666-4666-8666-666666666666";
export const unicodeName = "Zo\u00eb \u5c71\u7530 \ud83c\udfa8";
export const liveProject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const otherProject = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const archivedProject = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const deleteProject = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const hiddenProject = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const archiveLater = "99999999-9999-4999-8999-999999999999";
export const orderProject = "88888888-8888-4888-8888-888888888888";
export const missingProject = "ffffffff-ffff-4fff-8fff-ffffffffffff";
export const tokens = { admin: "wb-admin-token", member: "wb-member-token", outsider: "wb-outsider-token", external: "wb-external-token", member2: "wb-member2-token", unicode: "wb-unicode-token", imposter: "wb-imposter-token" } as const;

export async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); } }
export async function cookie(token: string) { const context = await createAuth(baseEnv).$context; return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`; }

export type Who = keyof typeof tokens;
export type Options = { who?: Who | null; origin?: string | null; upgrade?: boolean; headers?: Record<string, string>; /** #501: the `protocol` query a socket upgrade declares (default: the current one), or null to omit it like a tab loaded before #501. */ protocol?: string | null };
export async function upgrade(projectId: string, options: Options = {}) {
  const headers = new Headers(options.headers);
  if (options.upgrade !== false) headers.set("Upgrade", "websocket");
  if (options.origin !== null) headers.set("Origin", options.origin ?? baseEnv.APP_ORIGIN);
  if (options.who !== null) headers.set("cookie", await cookie(tokens[options.who ?? "member"]));
  const protocol = options.protocol === undefined ? String(WHITEBOARD_PROTOCOL) : options.protocol;
  return workerSelf.fetch(`https://portal.test/api/projects/${projectId}/whiteboard/socket${protocol === null ? "" : `?protocol=${protocol}`}`, { headers });
}

/** A connected client: every server message is queued, and `next` waits for one. */
export type Client = { ws: WebSocket; next: () => Promise<WhiteboardServerMessage>; send: (message: unknown) => void; closed: Promise<{ code: number }>; drain: (ms?: number) => Promise<WhiteboardServerMessage[]> };
export async function connect(projectId: string, options: Options = {}): Promise<Client> {
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
export const defaultIndexes = new Map<string, string>(); let lastDefaultIndex: string | null = null;
export const defaultIndex = (id: string) => { let key = defaultIndexes.get(id); if (!key) { key = generateKeyBetween(lastDefaultIndex, null); lastDefaultIndex = key; defaultIndexes.set(id, key); } return key; };
export const element = (id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", version, versionNonce, isDeleted: false, x: 0, y: 0, index: defaultIndex(id), ...extra });
export const batch = (seq: number, ...elements: unknown[]) => ({ type: "elements", seq, generation: 1, elements });
export async function initOf(projectId: string, options: Options = {}) { const client = await connect(projectId, options); const init = await client.next(); client.ws.close(1000); return init as Extract<WhiteboardServerMessage, { type: "init" }>; }
export async function save(client: Client, seq: number, ...elements: unknown[]) { client.send(batch(seq, ...elements)); expect(await client.next()).toEqual({ type: "ack", seq, generation: 1 }); }
/** A batch the sender LOSES: the stored row comes back first (so it converges), then the ack. */
export async function saveLosing(client: Client, seq: number, ...elements: unknown[]) { client.send(batch(seq, ...elements)); expect(await client.next()).toMatchObject({ type: "elements" }); expect(await client.next()).toEqual({ type: "ack", seq, generation: 1 }); }
export const storedRow = (projectId: string, id: string) => runInDurableObject(stubFor(projectId), async (_instance, state) => state.storage.sql.exec("SELECT json FROM elements WHERE id = ?", id).toArray().map((row) => JSON.parse(row.json as string) as Record<string, unknown>)[0]);
export const storedIds = (projectId: string) => runInDurableObject(stubFor(projectId), async (_instance, state) => state.storage.sql.exec("SELECT id, version, version_nonce FROM elements").toArray().map((row) => ({ id: row.id as string, version: row.version as number, nonce: row.version_nonce as number })));
export const stubFor = (projectId: string) => baseEnv.PROJECT_WHITEBOARD.get(baseEnv.PROJECT_WHITEBOARD.idFromName(projectId));
export const byId = (init: { elements: Array<Record<string, unknown>> }) => Object.fromEntries(init.elements.map((entry) => [entry.id as string, entry]));


// ---- live co-editing helpers (#499) and version-history helpers (#500) ----------------------------------------------------
export type Members = ReadonlyArray<readonly [string, string]>;
export const staff: Members = [[memberId, "editor"], [member2Id, "editor"], [unicodeId, "editor"]];
/** A fresh Project (so one test's sockets never meet another's) with the given team. */
export async function newProject(members: Members = staff, archived = false): Promise<string> {
  const id = crypto.randomUUID(); const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at, archived_at) VALUES (?, 'Live Street', 'editing_autohdr', 0, ?, ?, ?)").bind(id, now, now, archived ? now : null).run();
  for (const [userId, role] of members) await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), id, userId, role, now).run();
  return id;
}
export async function api(who: Who, method: "POST" | "DELETE", path: string, body?: unknown) {
  const headers = new Headers({ cookie: await cookie(tokens[who]), origin: baseEnv.APP_ORIGIN });
  if (body !== undefined) headers.set("content-type", "application/json");
  return workerSelf.fetch(`https://portal.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
export type Init = Extract<WhiteboardServerMessage, { type: "init" }>;
/** Connects and returns the client with its own `init` already read. */
export async function join(projectId: string, who: Who = "member") { const client = await connect(projectId, { who }); const init = await client.next() as Init; return { client, init }; }
export const INTERVAL = 30_000;
export const farFuture = () => Date.now() + 3_600_000;
export type Tunable = { clock: () => number; env: Record<string, unknown> };
export const setClock = (projectId: string, at: number) => runInDurableObject(stubFor(projectId), async (instance) => { (instance as unknown as Tunable).clock = () => at; });
export const alarmAt = (projectId: string) => runInDurableObject(stubFor(projectId), async (_instance, state) => state.storage.getAlarm());
export const fire = (projectId: string) => runDurableObjectAlarm(stubFor(projectId));
export type VersionRow = { id: string; ordinal: number; generation: number; sceneRevision: number; reason: string; state: string; elementCount: number; byteCount: number; sha: string; r2Key: string; createdBy: string | null };
export const versionsOf = async (projectId: string) => (await database.DB.prepare("SELECT id, ordinal, generation, scene_revision AS sceneRevision, reason, state, element_count AS elementCount, byte_count AS byteCount, scene_sha256 AS sha, r2_key AS r2Key, created_by AS createdBy FROM project_whiteboard_versions WHERE project_id = ? ORDER BY ordinal").bind(projectId).all<VersionRow>()).results;
export const objectKeys = async (projectId: string) => (await baseEnv.MEDIA.list({ prefix: `projects/${projectId}/whiteboard/versions/` })).objects.map((entry) => entry.key).sort();
export type Envelope = { schema: number; projectId: string; versionId: string; generation: number; reason: string; elements: Array<Record<string, unknown>> };
export const envelopeOf = async (key: string) => JSON.parse(await (await baseEnv.MEDIA.get(key))!.text()) as Envelope;
export const storedRows = (projectId: string) => runInDurableObject(stubFor(projectId), async (_instance, state) => state.storage.sql.exec("SELECT json FROM elements ORDER BY id").toArray().map((row) => JSON.parse(row.json as string) as Record<string, unknown>));
export const byIdSorted = (rows: Array<Record<string, unknown>>) => [...rows].sort((left, right) => String(left.id) < String(right.id) ? -1 : 1);
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Swaps one binding of a live Durable Object for a wrapped one (eviction undoes it). */
export type Wrap = (real: any) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
export const inject = (projectId: string, name: "MEDIA" | "DB", wrap: Wrap) => runInDurableObject(stubFor(projectId), async (instance) => {
  const holder = instance as unknown as Tunable; const wrapped = wrap(holder.env[name]);
  holder.env = new Proxy(holder.env, { get: (target, key) => key === name ? wrapped : Reflect.get(target, key) });
});
export const intercept = (method: string, behave: (args: unknown[], run: () => unknown) => unknown): Wrap => (real) => new Proxy(real, {
  get: (target, key) => { const value = Reflect.get(target, key); if (typeof value !== "function") return value; return key === method ? (...args: unknown[]) => behave(args, () => value.apply(target, args)) : value.bind(target); },
});
export const failOnce = (method: string, when: (args: unknown[]) => boolean = () => true, times = 1): Wrap => { let left = times; return intercept(method, (args, run) => { if (left > 0 && when(args)) { left -= 1; throw new Error(`injected ${method} failure`); } return run(); }); };
/** Holds a binding call open. `reached` is polled (a continuation resumed from inside the Durable Object could not touch the test's own sockets). */
export const gate = (method: string) => { let release!: () => void; let hit = false; const open = new Promise<void>((resolve) => { release = resolve; }); return { reached: () => vi.waitFor(() => expect(hit).toBe(true), { timeout: 5000 }), release, wrap: intercept(method, async (_args, run) => { hit = true; await open; return run(); }) }; };
export const touchesVersions = (args: unknown[]) => /project_whiteboard_versions/i.test(String(args[0]));
export const touchesAudit = (args: unknown[]) => /audit_log/i.test(String(args[0])) && /insert/i.test(String(args[0]));

/** One snapshot cycle: an edit at `at`, then the alarm at the +30 s deadline. */
export async function cycle(project: string, client: Client, step: number, base: number, seqBase = 0) {
  const at = base + step * 100_000;
  await setClock(project, at);
  await save(client, seqBase + step + 1, element(`e${step}`, 1, step + 1));
  await setClock(project, at + INTERVAL);
  await fire(project);
}

/** The users, sessions, Projects and memberships every whiteboard worker suite starts from. */
export async function seedWhiteboardWorld(): Promise<void> {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__); const now = Date.now();
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();   // the archive/restore routes sit behind the Board contract
  for (const [id, role] of [[adminId, "admin"], [memberId, "editor"], [outsiderId, "editor"], [externalId, "external_editor"], [member2Id, "editor"], [unicodeId, "editor"]]) await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 1, 0, ?, ?)").bind(id, id === unicodeId ? unicodeName : `${role} ${id.slice(0, 4)}`, `${id}@example.test`, role, now, now).run();
  for (const [who, userId] of [["admin", adminId], ["member", memberId], ["outsider", outsiderId], ["external", externalId], ["member2", member2Id], ["unicode", unicodeId]] as const) await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(`wb-${who}`, now + 3_600_000, tokens[who], userId, now, now).run();
  for (const [id, street] of [[liveProject, "Whiteboard Street"], [otherProject, "Other Street"], [archivedProject, "Archived Street"], [deleteProject, "Delete Street"], [hiddenProject, "Hidden Street"], [archiveLater, "Archive Later Street"], [orderProject, "Order Street"]]) await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, ?, 'editing_autohdr', 0, ?, ?)").bind(id, street, now, now).run();
  await database.DB.prepare("UPDATE projects SET archived_at = ?, archived_by = ? WHERE id IN (?, ?)").bind(now, adminId, archivedProject, deleteProject).run();
  for (const [userId, project, role] of [[memberId, liveProject, "editor"], [memberId, otherProject, "editor"], [memberId, archivedProject, "editor"], [memberId, deleteProject, "editor"], [memberId, archiveLater, "editor"], [memberId, orderProject, "editor"], [externalId, liveProject, "editor"]] as const) await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), project, userId, role, now).run();
}
