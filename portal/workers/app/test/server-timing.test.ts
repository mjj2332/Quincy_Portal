import { env, SELF } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { authInstanceBuildCount, createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { derivedEnv, formatServerTiming, publishOutboxDetached, meteredD1, newRequestTiming, normalizeRoute, timingStorage, type RequestTiming } from "../src/lib/server-timing";

// Own file: a fresh isolate, so the auth build counter starts at 0 (#360) and the header is
// exercised end to end through SELF (#361).
const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const authSecret = baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const token = "server-timing-session-token";
const userId = "server-timing-user-id";
const userEmail = "server-timing-person@example.test";
const projectId = "5a1d7c36-0b8e-4c52-9f0e-3e2a6b7c8d91";
declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;

async function executeSql(sql: string) { for (const chunk of sql.split("--> statement-breakpoint")) for (const statement of chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); } }

let cookie = "";
beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, 'admin', 1, ?, ?)").bind(userId, "Timing Person", userEmail, now, now).run();
  await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind("server-timing-session", now + 3_600_000, token, userId, now, now).run();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Timing Street', 'editing_autohdr', ?, ?)").bind(projectId, now, now).run();
  const context = await createAuth(baseEnv).$context;
  cookie = `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
});

const ALLOWED_METRICS = new Set(["total", "auth", "principal", "handler", "d1", "d1-queries", "d1-meta", "d1-rows", "d1-region"]);
const REGIONS = new Set(["WNAM", "ENAM", "WEUR", "EEUR", "APAC", "OC"]);

/** Parses `name;param=value, ...` and asserts the strict grammar while doing so. */
function parseServerTiming(header: string | null): Map<string, Record<string, string>> {
  const metrics = new Map<string, Record<string, string>>();
  expect(header).toBeTruthy();
  for (const entry of header!.split(", ")) {
    const [name, ...params] = entry.split(";");
    expect(ALLOWED_METRICS.has(name), `metric ${name}`).toBe(true);
    const parsed: Record<string, string> = {};
    for (const param of params) {
      const [key, raw] = param.split("=");
      if (key === "dur") { expect(Number.isFinite(Number(raw)), `dur ${raw}`).toBe(true); parsed.dur = raw; }
      else if (key === "desc") {
        const value = raw.replace(/^"|"$/g, "");
        expect(/^\d+$/.test(value) || REGIONS.has(value), `desc ${raw}`).toBe(true);
        parsed.desc = value;
      } else expect.unreachable(`unexpected param ${key}`);
    }
    metrics.set(name, parsed);
  }
  return metrics;
}

describe("Server-Timing on /api and /media (#361)", () => {
  it("authenticated /api/projects carries auth, principal, handler and d1 with a query count", async () => {
    const response = await SELF.fetch("https://portal.test/api/projects", { headers: { cookie } });
    expect(response.status).toBe(200);
    const header = response.headers.get("server-timing");
    const metrics = parseServerTiming(header);
    for (const name of ["auth", "principal", "handler", "d1", "d1-queries", "d1-meta"]) expect(metrics.has(name), name).toBe(true);
    expect(Number(metrics.get("d1-queries")!.desc)).toBeGreaterThanOrEqual(1);
    // The header is readable by anyone who can send a request: it must express no data value.
    for (const secret of [userEmail, userId, projectId, "Timing Street", "Timing Person", "select", "from", "@"]) expect(header!.toLowerCase()).not.toContain(secret.toLowerCase());
  });

  it("an unauthenticated 401 carries the auth segment only", async () => {
    // Twice: the first request in an isolate runs the board-schema probe before auth, which must never surface.
    for (let i = 0; i < 2; i++) {
      const response = await SELF.fetch("https://portal.test/api/projects");
      expect(response.status).toBe(401);
      expect([...parseServerTiming(response.headers.get("server-timing")).keys()]).toEqual(["auth"]);
    }
  });

  it("a stale principal (valid cookie, inactive user) is a 401 with the auth segment only", async () => {
    const now = Date.now();
    await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('st-inactive', 'Inactive', 'st-inactive@example.test', 1, 'editor', 0, ?, ?)").bind(now, now).run();
    await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES ('st-inactive-s', ?, 'st-inactive-token', 'st-inactive', ?, ?)").bind(now + 3_600_000, now, now).run();
    const inactiveCookie = `${cookie.split("=")[0]}=st-inactive-token.${await makeSignature("st-inactive-token", authSecret)}`;
    const response = await SELF.fetch("https://portal.test/api/projects", { headers: { cookie: inactiveCookie } });
    expect(response.status).toBe(401);
    expect([...parseServerTiming(response.headers.get("server-timing")).keys()]).toEqual(["auth"]);
  });

  it("/media carries the same grammar", async () => {
    const response = await SELF.fetch(`https://portal.test/media/asset/${crypto.randomUUID()}/thumb`, { headers: { cookie } });
    const metrics = parseServerTiming(response.headers.get("server-timing"));
    expect(metrics.has("auth")).toBe(true);
    expect(metrics.has("d1")).toBe(true);
  });

  it("/api/auth/get-session carries auth (whole handler) and d1, and no post-auth stages", async () => {
    const response = await SELF.fetch("https://portal.test/api/auth/get-session", { headers: { cookie } });
    expect(response.status).toBe(200);
    const metrics = parseServerTiming(response.headers.get("server-timing"));
    expect(metrics.has("auth")).toBe(true);
    expect(metrics.has("principal")).toBe(false);
    expect(metrics.has("handler")).toBe(false);
  });

  it("/api/health, a CORS preflight and an origin-rejected request carry a total-only fallback", async () => {
    const health = await SELF.fetch("https://portal.test/api/health");
    expect(health.status).toBe(200);
    const preflight = await SELF.fetch("https://portal.test/api/projects", { method: "OPTIONS", headers: { origin: baseEnv.APP_ORIGIN, "access-control-request-method": "POST" } });
    expect(preflight.status).toBeLessThan(300);
    const rejected = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { origin: "https://evil.test", "content-type": "application/json" }, body: "{}" });
    expect(rejected.status).toBe(403);
    for (const response of [health, preflight, rejected]) {
      const header = response.headers.get("server-timing");
      expect([...parseServerTiming(header).keys()]).toEqual(["total"]);
      expect(header).toMatch(/^total;dur=\d+\.\d$/);
    }
  });

  it("non-API paths get no header and the raw env", async () => {
    const response = await SELF.fetch("https://portal.test/some-spa-route");
    expect(response.headers.get("server-timing")).toBeNull();
  });

  it("metering does not defeat the per-isolate auth instance (#360)", async () => {
    // Everything above already went through SELF with metering on; keep going across route kinds.
    const before = authInstanceBuildCount();
    for (const path of ["/api/me", "/api/projects", "/api/auth/get-session", "/media/nope"]) {
      const response = await SELF.fetch(`https://portal.test${path}`, { headers: { cookie } });
      expect(response.headers.get("server-timing"), path).toBeTruthy();
    }
    expect(before).toBe(1);
    expect(authInstanceBuildCount()).toBe(1);
  });
});

describe("boot-timing beacon (#361)", () => {
  const body = JSON.stringify({ sessionMs: 812.4, dashboardMs: 1650.2, view: "board", hidden: false });
  const post = (payload: string, headers: Record<string, string>) => SELF.fetch("https://portal.test/api/boot-timing", { method: "POST", body: payload, headers: { "content-type": "application/json", ...headers } });

  it("accepts a valid beacon with 204", async () => {
    expect((await post(body, { cookie, origin: baseEnv.APP_ORIGIN })).status).toBe(204);
  });
  it("accepts both the current and the retired view spellings, and logs only the current ones (#427)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const expected: Record<string, string> = { table: "table", board: "board", calendar: "calendar", timeline: "timeline", list: "table", kanban: "board", gantt: "timeline" };
      for (const [sent, logged] of Object.entries(expected)) {
        log.mockClear();
        const response = await post(JSON.stringify({ ...JSON.parse(body), view: sent }), { cookie, origin: baseEnv.APP_ORIGIN });
        expect(response.status, sent).toBe(204);
        const beacon = log.mock.calls.map(([line]) => String(line)).find((line) => line.includes("boot_timing"));
        expect(beacon, sent).toBeDefined();
        expect(JSON.parse(beacon!).view, sent).toBe(logged);
      }
    } finally {
      log.mockRestore();
    }
  });
  it("rejects extra fields and out-of-range values with 400", async () => {
    expect((await post(JSON.stringify({ ...JSON.parse(body), extra: 1 }), { cookie, origin: baseEnv.APP_ORIGIN })).status).toBe(400);
    expect((await post(JSON.stringify({ ...JSON.parse(body), sessionMs: 600_001 }), { cookie, origin: baseEnv.APP_ORIGIN })).status).toBe(400);
    expect((await post(JSON.stringify({ ...JSON.parse(body), dashboardMs: -1 }), { cookie, origin: baseEnv.APP_ORIGIN })).status).toBe(400);
    expect((await post(JSON.stringify({ ...JSON.parse(body), view: "somewhere" }), { cookie, origin: baseEnv.APP_ORIGIN })).status).toBe(400);
  });
  it("requires a session (401) and the app origin (403)", async () => {
    expect((await post(body, { origin: baseEnv.APP_ORIGIN })).status).toBe(401);
    expect((await post(body, { cookie })).status).toBe(403);
  });
});

function fakeStatement(log: string[], results: Record<string, unknown> = {}) {
  const statement: Record<string, unknown> = {
    bind: () => fakeStatement(log, results),
    first: async () => { log.push("first"); return results.first ?? null; },
    all: async () => { log.push("all"); return results.all; },
    run: async () => { log.push("run"); return results.run; },
    raw: async () => { log.push("raw"); return results.raw ?? []; },
  };
  return statement as unknown as D1PreparedStatement;
}

describe("D1 metering", () => {
  function fakeDb(results: Record<string, unknown> = {}) {
    const log: string[] = [];
    const batched: unknown[][] = [];
    const db = {
      prepare: () => fakeStatement(log, results),
      batch: async (statements: unknown[]) => { batched.push(statements); return statements.map(() => ({ meta: { rows_read: 3, served_by_region: "OC" } })); },
      exec: async () => ({ count: 1, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
      withSession: () => ({}),
    } as unknown as D1Database;
    return { db, log, batched };
  }
  const inScope = async <T,>(run: (store: RequestTiming) => Promise<T>) => { const store = newRequestTiming(); await timingStorage.run(store, () => run(store)); return store; };

  it("raw() and first() count but add no rows; all() and run() add rows and region", async () => {
    const meta = { rows_read: 7, served_by_region: "APAC" };
    const { db } = fakeDb({ all: { results: [], meta }, run: { meta: { rows_read: 2, served_by_region: "APAC" } } });
    const metered = meteredD1(db);
    const store = await inScope(async () => {
      await metered.prepare("x").raw(); await metered.prepare("x").first();
    });
    expect(store.d1).toMatchObject({ count: 2, metaCount: 0, rowsRead: 0 });
    expect(store.d1.region).toBeUndefined();
    const withMeta = await inScope(async () => { await metered.prepare("x").bind(1).all(); await metered.prepare("x").run(); });
    expect(withMeta.d1).toMatchObject({ count: 2, metaCount: 2, rowsRead: 9, region: "APAC" });
  });

  it("batch() receives the genuine statements, not wrappers", async () => {
    const { db, batched } = fakeDb();
    const metered = meteredD1(db);
    const statements = [metered.prepare("a"), metered.prepare("b").bind(1)];
    const store = await inScope(async () => { await metered.batch(statements); });
    expect(batched).toHaveLength(1);
    expect(batched[0]).toHaveLength(2);
    expect(batched[0]![0]).toBe(statements[0]);
    expect(batched[0]![1]).toBe(statements[1]);
    expect(Object.getPrototypeOf(statements[0])).toBe(Object.prototype); // an own-property shadow, not a Proxy
    expect(store.d1).toMatchObject({ count: 2, metaCount: 2, rowsRead: 6, region: "OC" });
  });

  it("ignores an unknown region and does nothing outside a request scope", async () => {
    const { db } = fakeDb({ all: { meta: { rows_read: 1, served_by_region: "'; DROP" } } });
    const metered = meteredD1(db);
    await metered.prepare("x").all();
    const store = await inScope(async () => { await metered.prepare("x").all(); });
    expect(store.d1.region).toBeUndefined();
  });

  it("D1 work started by a detached background task is not counted, even when it overlaps the foreground", async () => {
    const { db } = fakeDb({ run: { meta: { rows_read: 1, served_by_region: "OC" } } });
    const metered = meteredD1(db);
    const sent: string[] = [];
    const queue = { send: async (message: { outboxId: string }) => { sent.push(message.outboxId); } };
    let background: Promise<void> | undefined;
    const store = await inScope(async () => {
      background = publishOutboxDetached(queue as never, metered as never, ["outbox-1"]);
      await metered.prepare("SELECT 1").first(); // foreground D1 that runs alongside the background UPDATE
      await background;
    });
    expect(sent).toEqual(["outbox-1"]);
    expect(store.d1).toMatchObject({ count: 1, metaCount: 0, rowsRead: 0 });
  });

  it("the metered DB and derived env are memoised (stable identity per isolate)", () => {
    const { db } = fakeDb();
    expect(meteredD1(db)).toBe(meteredD1(db));
    expect(derivedEnv(baseEnv)).toBe(derivedEnv(baseEnv));
    expect(derivedEnv(baseEnv).DB).toBe(meteredD1(baseEnv.DB));
    expect(derivedEnv({ ...baseEnv })).not.toBe(derivedEnv(baseEnv));
  });

  it("leaves an already-wrapped statement (a Proxy overriding bind) unmetered instead of recursing", async () => {
    const wrapped = new Proxy(database.DB, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => new Proxy(target.prepare(sql), {
          get(statement, key, statementReceiver) {
            if (key !== "bind") return Reflect.get(statement, key, statementReceiver);
            return (...values: unknown[]) => statement.bind(...values);
          },
        });
      },
    }) as unknown as D1Database;
    const store = await inScope(async () => { expect((await meteredD1(wrapped).prepare("SELECT ? AS one").bind(1).first<{ one: number }>())!.one).toBe(1); });
    expect(store.d1.count).toBe(0);
  });

  it("wraps a real D1 statement in place and still batches", async () => {
    const metered = meteredD1(database.DB);
    const statement = metered.prepare("SELECT 1 AS one").bind();
    const store = await inScope(async () => {
      expect((await statement.all<{ one: number }>()).results[0]!.one).toBe(1);
      await metered.batch([metered.prepare("SELECT 1"), metered.prepare("SELECT 2")]);
    });
    expect(store.d1.count).toBe(3);
    expect(store.d1.metaCount).toBe(3);
  });
});

describe("formatServerTiming / normalizeRoute", () => {
  const timing = (patch: Partial<RequestTiming> = {}): RequestTiming => ({ ...newRequestTiming(), auth: 1.234, principal: 2, handler: 3, authenticated: true, ...patch });

  it("emits only allow-listed metrics and withholds everything but auth from the unauthenticated", () => {
    const t = timing({ d1: { count: 4, durMs: 9.87, metaCount: 2, rowsRead: 40, region: "OC" } });
    expect(formatServerTiming(t)).toBe('auth;dur=1.2, principal;dur=2.0, handler;dur=3.0, d1;dur=9.9, d1-queries;desc="4", d1-meta;desc="2", d1-rows;desc="40", d1-region;desc="OC"');
    expect(formatServerTiming(timing({ authenticated: false, d1: { ...t.d1 } }))).toBe("auth;dur=1.2");
    expect(formatServerTiming(timing({ authenticated: false, principal: undefined, handler: undefined }), { authRoute: true })).toMatch(/^auth;dur=1\.2, d1;dur=/);
  });
  it("omits rows when no call carried meta, and a region that is not a D1 region", () => {
    const out = formatServerTiming(timing({ d1: { count: 3, durMs: 1, metaCount: 0, rowsRead: 0, region: "evil\"" } }));
    expect(out).not.toContain("d1-rows");
    expect(out).not.toContain("d1-region");
  });
  it("normalizes ids out of log routes", () => {
    expect(normalizeRoute("/api/projects/5a1d7c36-0b8e-4c52-9f0e-3e2a6b7c8d91/assets/12")).toBe("/api/projects/:id/assets/:id");
    expect(normalizeRoute("/media/asset/abcdefghijklmnopqrstuvwx/thumb")).toBe("/media/asset/:id/thumb");
    expect(normalizeRoute("/api/me")).toBe("/api/me");
  });
});
