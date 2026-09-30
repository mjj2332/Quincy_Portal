import { AsyncLocalStorage } from "node:async_hooks";
import { publishNotificationOutbox } from "@quincy/shared";
import type { Env } from "../env";

/**
 * Load-time measurement (#361): a `Server-Timing` header plus one structured log line per
 * `/api` and `/media` request. See `docs/Guides/Load-Time-Measurement.md` for how to read it.
 *
 * Identity contract (#358 cross-cutting): `env` and `env.DB` must keep a stable identity per
 * isolate, because `getAuth` (#360) and `boardSchemaVariant` cache on them. So the metered D1 is
 * built ONCE per raw binding (`meteredD1`) and the derived env ONCE per raw env (`derivedEnv`),
 * and per-request attribution travels through `AsyncLocalStorage`, never through a per-request
 * env or DB wrapper.
 */

export type D1Timing = { count: number; durMs: number; metaCount: number; rowsRead: number; region?: string };
export type RequestTiming = {
  auth?: number;
  principal?: number;
  handler?: number;
  /** Set once the principal is accepted. Everything but `auth` is withheld until then. */
  authenticated: boolean;
  d1: D1Timing;
};

export const timingStorage = new AsyncLocalStorage<RequestTiming>();

export function newRequestTiming(): RequestTiming {
  return { authenticated: false, d1: { count: 0, durMs: 0, metaCount: 0, rowsRead: 0 } };
}

/** Adds the time elapsed since `startedAt` to a stage (accumulates: a route may re-run a stage). */
export function mark(stage: "auth" | "principal" | "handler", startedAt: number): void {
  const store = timingStorage.getStore();
  if (store) store[stage] = (store[stage] ?? 0) + (performance.now() - startedAt);
}

/** D1's documented `served_by_region` values. Anything else is dropped, never echoed. */
const D1_REGIONS = new Set(["WNAM", "ENAM", "WEUR", "EEUR", "APAC", "OC"]);

type MetaResult = { meta?: { rows_read?: unknown; served_by_region?: unknown } };

function recordMeta(d1: D1Timing, result: unknown): void {
  const meta = (result as MetaResult | null | undefined)?.meta;
  if (!meta || typeof meta !== "object") return;
  d1.metaCount += 1;
  if (typeof meta.rows_read === "number" && Number.isFinite(meta.rows_read)) d1.rowsRead += meta.rows_read;
  if (typeof meta.served_by_region === "string" && D1_REGIONS.has(meta.served_by_region)) d1.region = meta.served_by_region;
}

async function timed<T>(queries: number, run: () => Promise<T>, metaOf?: (result: T) => unknown[]): Promise<T> {
  const store = timingStorage.getStore();
  if (!store) return run();
  const startedAt = performance.now();
  try {
    const result = await run();
    if (metaOf) for (const item of metaOf(result)) recordMeta(store.d1, item);
    return result;
  } finally {
    store.d1.count += queries;
    store.d1.durMs += performance.now() - startedAt;
  }
}

const STATEMENT_METHODS = ["first", "all", "run", "raw"] as const;

/**
 * Shadows methods on the GENUINE statement instance. No Proxy: `DB.batch()` must receive real
 * `D1PreparedStatement`s. `first`/`raw` results carry no `meta`; `all`/`run` do.
 */
function instrumentStatement(statement: D1PreparedStatement): D1PreparedStatement {
  const target = statement as unknown as Record<string, (this: D1PreparedStatement, ...args: unknown[]) => unknown>;
  // A statement someone else already wrapped (a test's Proxy overriding `bind`, say) answers with
  // a method that is not the prototype's. Shadowing it would call back into that wrapper through
  // the real statement's own property and recurse, so leave it unmetered.
  const proto = Object.getPrototypeOf(statement) as Record<string, unknown> | null;
  for (const name of [...STATEMENT_METHODS, "bind"]) if (proto && name in proto && target[name] !== proto[name]) return statement;
  for (const name of STATEMENT_METHODS) {
    const original = target[name]!;
    Object.defineProperty(statement, name, {
      configurable: true, writable: true, enumerable: false,
      value: (...args: unknown[]) => timed(1, () => original.apply(statement, args) as Promise<unknown>, name === "all" || name === "run" ? (result) => [result] : undefined),
    });
  }
  const originalBind = target.bind!;
  Object.defineProperty(statement, "bind", {
    configurable: true, writable: true, enumerable: false,
    value: (...args: unknown[]) => instrumentStatement(originalBind.apply(statement, args) as D1PreparedStatement),
  });
  return statement;
}

const meteredByDb = new WeakMap<D1Database, D1Database>();

export function meteredD1(db: D1Database): D1Database {
  const existing = meteredByDb.get(db);
  if (existing) return existing;
  const metered = {
    prepare: (query: string) => instrumentStatement(db.prepare(query)),
    batch: <T>(statements: D1PreparedStatement[]) => timed(statements.length, () => db.batch<T>(statements), (results) => results),
    exec: (query: string) => timed(1, () => db.exec(query)),
    dump: () => db.dump(),
    withSession: (...args: Parameters<D1Database["withSession"]>) => db.withSession(...args),
  } as unknown as D1Database;
  meteredByDb.set(db, metered);
  return metered;
}

const derivedByEnv = new WeakMap<Env, Env>();

export function derivedEnv(env: Env): Env {
  const existing = derivedByEnv.get(env);
  if (existing) return existing;
  const derived = { ...env, DB: meteredD1(env.DB) } as Env;
  derivedByEnv.set(env, derived);
  return derived;
}

const round = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0).toFixed(1);

/**
 * The allow-list grammar: metric names are fixed, params are only `dur` (a number) or `desc` (digits
 * or a known D1 region). No route, id, query text or user detail can be expressed here.
 * `d1*` and the post-auth stages are withheld from callers that never authenticated, so a 401
 * carries `auth` only (and learns nothing about query shape).
 */
export function formatServerTiming(timing: RequestTiming, options: { authRoute?: boolean } = {}): string {
  const parts: string[] = [];
  if (timing.auth !== undefined) parts.push(`auth;dur=${round(timing.auth)}`);
  if (timing.authenticated) {
    if (timing.principal !== undefined) parts.push(`principal;dur=${round(timing.principal)}`);
    if (timing.handler !== undefined) parts.push(`handler;dur=${round(timing.handler)}`);
  }
  if (timing.authenticated || options.authRoute) {
    const { d1 } = timing;
    parts.push(`d1;dur=${round(d1.durMs)}`, `d1-queries;desc="${Math.trunc(d1.count)}"`, `d1-meta;desc="${Math.trunc(d1.metaCount)}"`);
    if (d1.metaCount > 0) parts.push(`d1-rows;desc="${Math.trunc(d1.rowsRead)}"`);
    if (d1.region && D1_REGIONS.has(d1.region)) parts.push(`d1-region;desc="${d1.region}"`);
  }
  return parts.join(", ");
}

/** Ids never reach a log line: UUIDs, digit runs and long opaque segments become `:id`. */
export function normalizeRoute(pathname: string): string {
  return pathname
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\d+/g, ":id")
    .replace(/[A-Za-z0-9_-]{20,}/g, ":id");
}

const isTimedPath = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/") || pathname === "/media" || pathname.startsWith("/media/");
const MEDIA_SAMPLE_RATE = 0.1;
const MEDIA_SLOW_MS = 500;

function withHeader(response: Response, value: string): Response {
  try { response.headers.append("server-timing", value); return response; }
  catch { const clone = new Response(response.body, response); clone.headers.append("server-timing", value); return clone; }
}

type Fetcher = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

/**
 * Wraps the app outside Hono (no new `app.use`, no route-manifest churn). Any other path runs the
 * raw env untouched. The header measures up to the handler's `return`: bytes streamed after that
 * (zip downloads) and `ctx.waitUntil` work fall outside it.
 */
export async function fetchWithServerTiming(fetcher: Fetcher, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (!isTimedPath(url.pathname)) return fetcher(request, env, ctx);
  const store = newRequestTiming();
  const isAuthRoute = url.pathname.startsWith("/api/auth/");
  const startedAt = performance.now();
  const response = await timingStorage.run(store, async () => fetcher(request, derivedEnv(env), ctx));
  const totalMs = performance.now() - startedAt;
  if (isAuthRoute) { store.auth = totalMs; store.handler = undefined; store.principal = undefined; }
  // Health checks, preflights and origin rejections never reach the session middleware: they get
  // the total only, which names no route, id or query shape.
  const header = formatServerTiming(store, { authRoute: isAuthRoute }) || `total;dur=${round(totalMs)}`;
  logServerTiming(url, request.method, response.status, store, totalMs);
  return withHeader(response, header);
}

function logServerTiming(url: URL, method: string, status: number, t: RequestTiming, totalMs: number): void {
  const isMedia = url.pathname === "/media" || url.pathname.startsWith("/media/");
  if (isMedia && status < 400 && totalMs <= MEDIA_SLOW_MS && Math.random() >= MEDIA_SAMPLE_RATE) return;
  const ms = (n: number | undefined) => (n === undefined ? null : Math.round(n * 10) / 10);
  console.log(JSON.stringify({
    event: "server_timing", route: normalizeRoute(url.pathname), method, status,
    auth: ms(t.auth), principal: ms(t.principal), handler: ms(t.handler), total: ms(totalMs),
    d1Ms: ms(t.d1.durMs), d1Queries: t.d1.count, d1Rows: t.d1.metaCount > 0 ? t.d1.rowsRead : null, d1Meta: t.d1.metaCount, region: t.d1.region ?? null,
  }));
}

/**
 * Background work (`ctx.waitUntil`) must not inherit the request's timing store: its D1 time would
 * leak into the response totals whenever it overlaps the foreground. A promise starts in the
 * context of whoever created it, so the detaching has to happen where the work is created, not
 * inside `waitUntil`. Running with an undefined store (Workers' ALS has no typed `exit`) leaves `getStore()` empty for the whole async chain the callback starts.
 */
export const publishOutboxDetached: typeof publishNotificationOutbox = (...args) => timingStorage.run(undefined as unknown as RequestTiming, () => publishNotificationOutbox(...args));
