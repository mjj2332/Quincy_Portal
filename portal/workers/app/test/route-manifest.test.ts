import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { EXTERNAL_API_RESPONSE_SCHEMAS } from "@quincy/shared";
import { app } from "../src/index";
import { createAuth } from "../src/auth";
import {
  assertNoCustomOnError,
  assertSecurityRouteManifest,
  CHECKED_IN_MIDDLEWARE_REGISTRATIONS,
  PROJECT_SECURITY_ROUTE_CLASSIFICATION,
  normalizeSecurityRoutes,
} from "../src/lib/terminal-route";
import type { AppEnv, Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const externalToken = "route-manifest-external-session-token";
const externalUserId = "55555555-5555-4555-8555-555555555555";
const manifestProjectId = "66666666-6666-4666-8666-666666666666";
const manifestRawCollectionId = "77777777-7777-4777-8777-777777777777";
const manifestEditedCollectionId = "88888888-8888-4888-8888-888888888888";
const manifestMembershipId = "99999999-9999-4999-8999-999999999999";
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

async function externalCookie(): Promise<string> {
  const context = await createAuth(baseEnv).$context;
  return `${context.authCookies.sessionToken.name}=${externalToken}.${await makeSignature(externalToken, baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes")}`;
}

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SELF = {
  fetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = new Request(input, init);
    if (!unsafeMethods.has(request.method)) return workerSelf.fetch(request);
    const headers = new Headers(request.headers);
    if (!headers.has("origin")) headers.set("origin", baseEnv.APP_ORIGIN);
    return workerSelf.fetch(new Request(request, { headers }));
  },
};

const stagesResponseSchema = z.object({
  stages: z.array(z.object({ key: z.string(), label: z.string(), displayOrder: z.number().int(), active: z.boolean() }).strict()),
}).strict();

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Manifest External', ?, 1, 'external_editor', 1, 0, ?, ?)")
      .bind(externalUserId, `${externalUserId}@example.test`, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), now + 3_600_000, externalToken, externalUserId, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, raw_folder_path, created_at, updated_at) VALUES (?, 'Manifest Project', 'editing_autohdr', '/Raw/Manifest', ?, ?)")
      .bind(manifestProjectId, now, now),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?), (?, ?, 'edited', 'empty', 0, ?, ?)")
      .bind(manifestRawCollectionId, manifestProjectId, now, now, manifestEditedCollectionId, manifestProjectId, now, now),
    database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)")
      .bind(manifestMembershipId, manifestProjectId, externalUserId, now),
  ]);
});

function concreteManifestPath(path: string): string {
  return path
    .replaceAll(":projectId", manifestProjectId)
    .replaceAll(":id", manifestProjectId)
    .replaceAll(":userId", externalUserId)
    .replaceAll(":assetId", crypto.randomUUID())
    .replaceAll(":annotationId", crypto.randomUUID())
    .replaceAll(":commentId", crypto.randomUUID())
    .replaceAll(":subtaskId", crypto.randomUUID())
    .replaceAll(":linkId", crypto.randomUUID())
    .replaceAll(":sessionId", crypto.randomUUID())
    .replaceAll(":ticket", crypto.randomUUID())
    .replaceAll(":partNumber", "1")
    .replaceAll(":sessionToken", "A".repeat(43))
    .replaceAll("/*", "/manifest-probe");
}

describe("terminal route manifest", () => {
  it("covers every composed app registration and has no custom router error wrapper", () => {
    assertNoCustomOnError([app]);
    assertSecurityRouteManifest(app.routes);
  });

  it("fails closed when a terminal marker is removed", () => {
    const health = app.routes.find((route) => route.method === "GET" && route.path === "/api/health");
    expect(health).toBeDefined();
    const routes = app.routes.map((route) => route === health ? { ...route, handler: () => new Response() } : route);
    expect(() => assertSecurityRouteManifest(routes)).toThrow(/Unmarked terminal route/);
  });

  it("fails closed when a new route is registered without a marker", () => {
    const routes = [...app.routes, { method: "GET", path: "/api/new-unclassified", handler: () => new Response() }];
    expect(() => assertSecurityRouteManifest(routes)).toThrow(/Unmarked terminal route/);
  });

  it("unwraps composed handlers while normalizing", () => {
    const normalized = normalizeSecurityRoutes(app.routes);
    const middleware = new Set(CHECKED_IN_MIDDLEWARE_REGISTRATIONS.map(([method, path]) => `${method} ${path}`));
    expect(normalized.filter((route) => route.terminal)).toHaveLength(app.routes.length - CHECKED_IN_MIDDLEWARE_REGISTRATIONS.length);
    expect(normalized.filter((route) => !route.terminal).every((route) => middleware.has(`${route.method} ${route.path}`))).toBe(true);
  });

  it("keeps a per-route security contract and reconciles duplicate contributors", () => {
    expect(PROJECT_SECURITY_ROUTE_CLASSIFICATION.every((route) => route.scope && route.projection && route.response)).toBe(true);
    const marked = app.routes.find((route) => route.method === "GET" && route.path === "/api/health");
    expect(marked).toBeDefined();
    const duplicate = [...app.routes, marked!];
    expect(() => assertSecurityRouteManifest(duplicate)).not.toThrow();
  });

  it("drives every manifest-declared External projection through its live route and schema", async () => {
    const probes = {
      "ingest-status": {
        path: `/api/projects/${manifestProjectId}/ingest-status`,
        parse: (body: unknown) => EXTERNAL_API_RESPONSE_SCHEMAS["ingest-status"].parse(body),
      },
      "collection-links": {
        path: `/api/projects/${manifestProjectId}/links?collection=video`,
        parse: (body: unknown) => EXTERNAL_API_RESPONSE_SCHEMAS["collection-links"].parse(body),
      },
      stages: {
        path: "/api/stages",
        parse: (body: unknown) => stagesResponseSchema.parse(body),
      },
    } as const;
    const declared = PROJECT_SECURITY_ROUTE_CLASSIFICATION.filter((route) => route.externalSurface);
    expect(new Set(declared.map((route) => route.externalSurface))).toEqual(new Set(Object.keys(probes)));
    const cookie = await externalCookie();
    for (const route of declared) {
      const probe = probes[route.externalSurface!];
      expect(route.scope, `${route.method} ${route.path}`).toBe("assigned-project");
      expect(route.projection, `${route.method} ${route.path}`).toBe("external-safe");
      expect(route.response, `${route.method} ${route.path}`).toBe("scoped");
      const response = await SELF.fetch(`https://portal.test${probe.path}`, { headers: { cookie } });
      expect(response.status, `${route.method} ${route.path}`).toBeGreaterThanOrEqual(200);
      expect(response.status, `${route.method} ${route.path}`).toBeLessThan(300);
      probe.parse(await response.json());
    }
  });

  it("returns a non-success response for every withheld manifest route", async () => {
    const cookie = await externalCookie();
    // Health is intentionally public and remains a terminal marker in the manifest; all
    // authenticated/privileged withheld entries must fail for an External session.
    const withheld = PROJECT_SECURITY_ROUTE_CLASSIFICATION.filter((route) => route.class === "withheld" && route.path !== "/api/health");
    expect(withheld.length).toBeGreaterThan(0);
    for (const route of withheld) {
      const path = concreteManifestPath(route.path);
      const init: RequestInit = { method: route.method === "ALL" ? "GET" : route.method, headers: { cookie } };
      if (["POST", "PUT", "PATCH"].includes(init.method!)) {
        const headers = new Headers(init.headers); headers.set("content-type", "application/json"); headers.set("origin", baseEnv.APP_ORIGIN);
        init.headers = headers; init.body = "{}";
      }
      const response = await SELF.fetch(`https://portal.test${path}`, init);
      expect(response.status, `${route.method} ${route.path}`).toBeGreaterThanOrEqual(300);
    }
  });

  it("rejects a structurally custom Hono error handler", () => {
    const router = new Hono<AppEnv>();
    router.onError((_error, c) => c.json({ error: "custom" }, 500));
    expect(() => assertNoCustomOnError([router])).toThrow(/custom Hono onError/);
  });
});
