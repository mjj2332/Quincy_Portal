import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { EXTERNAL_API_RESPONSE_SCHEMAS, moveProjectStageResponseSchema } from "@quincy/shared";
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
const manifestUnassignedProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const manifestArchivedProjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Manifest External', ?, 1, 'external_editor', 1, 0, ?, ?)")
      .bind(externalUserId, `${externalUserId}@example.test`, now, now),
    database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), now + 3_600_000, externalToken, externalUserId, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, raw_folder_path, created_at, updated_at) VALUES (?, 'Manifest Project', 'editing_autohdr', '/Raw/Manifest', ?, ?)")
      .bind(manifestProjectId, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Manifest Unassigned', 'editing_autohdr', ?, ?), (?, 'Manifest Archived', 'editing_autohdr', ?, ?)")
      .bind(manifestUnassignedProjectId, now, now, manifestArchivedProjectId, now, now),
    database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?")
      .bind(now, manifestArchivedProjectId),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?), (?, ?, 'edited', 'empty', 0, ?, ?)")
      .bind(manifestRawCollectionId, manifestProjectId, now, now, manifestEditedCollectionId, manifestProjectId, now, now),
    database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)")
      .bind(manifestMembershipId, manifestProjectId, externalUserId, now),
  ]);
});

function concreteManifestPath(path: string, projectId = manifestProjectId): string {
  return path
    .replaceAll(":projectId", projectId)
    .replaceAll(":id", projectId)
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
        parse: (body: unknown) => EXTERNAL_API_RESPONSE_SCHEMAS.stages.parse(body),
      },
      calendar: {
        path: "/api/production-calendar?start=2026-08-24&end=2026-09-05&date=2026-08-27&sub=month&scope=active&layers=project,checklist",
        parse: (body: unknown) => EXTERNAL_API_RESPONSE_SCHEMAS.calendar.parse(body),
      },
      stage: {
        path: `/api/projects/${manifestProjectId}/stage`,
        method: "POST" as const,
        body: JSON.stringify({
          expected: { stageKey: "editing", boardRevision: 0 },
          targetStageKey: "edited_review",
          placement: { kind: "append" },
          confirmation: { reasons: ["editing_boundary"] },
        }),
        parse: (body: unknown) => moveProjectStageResponseSchema.parse(body),
      },
      activity: {
        path: `/api/projects/${manifestProjectId}/activity`,
        parse: (body: unknown) => EXTERNAL_API_RESPONSE_SCHEMAS.activity.parse(body),
      },
    } as const;
    // Each surface's honest scope: a project-child route resolves an assigned project;
    // /api/stages is a principal-global configuration read with no project in the path.
    const expectedScope: Record<keyof typeof probes, string> = {
      "ingest-status": "assigned-project",
      "collection-links": "assigned-project",
      stages: "global-self",
      calendar: "assigned-project",
      stage: "assigned-project",
      activity: "assigned-project",
    };
    const declared = PROJECT_SECURITY_ROUTE_CLASSIFICATION.filter((route) => route.externalSurface);
    expect(new Set(declared.map((route) => route.externalSurface))).toEqual(new Set(Object.keys(probes)));
    const cookie = await externalCookie();
    for (const route of declared) {
      const probe = probes[route.externalSurface!];
      expect(route.scope, `${route.method} ${route.path}`).toBe(expectedScope[route.externalSurface!]);
      expect(route.projection, `${route.method} ${route.path}`).toBe("external-safe");
      expect(route.response, `${route.method} ${route.path}`).toBe("scoped");
      if (route.externalSurface === "stage") {
        await database.DB.prepare("UPDATE projects SET stage_key = 'editing_autohdr', archived_at = NULL, board_revision = 0 WHERE id = ?").bind(manifestProjectId).run();
      }
      const method = "method" in probe ? probe.method : "GET";
      const body = "body" in probe ? probe.body : undefined;
      const init: RequestInit = { method, headers: { cookie } };
      if (body) {
        const headers = new Headers(init.headers); headers.set("content-type", "application/json"); headers.set("origin", baseEnv.APP_ORIGIN);
        init.headers = headers; init.body = body;
      }
      const probePath = route.externalSurface === "stage" || route.externalSurface === "activity" ? concreteManifestPath(route.path) : probe.path;
      const response = await SELF.fetch(`https://portal.test${probePath}`, init);
      expect(response.status, `${route.method} ${route.path}`).toBeGreaterThanOrEqual(200);
      expect(response.status, `${route.method} ${route.path}`).toBeLessThan(300);
      probe.parse(await response.json());
    }
  });

  it("keeps assigned-project Stage misses generic for External Editors", async () => {
    const cookie = await externalCookie();
    const body = JSON.stringify({
      expected: { stageKey: "editing", boardRevision: 0 },
      targetStageKey: "edited_review",
      placement: { kind: "append" },
      confirmation: { reasons: ["editing_boundary"] },
    });
    for (const projectId of [manifestUnassignedProjectId, manifestArchivedProjectId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"]) {
      const response = await SELF.fetch(`https://portal.test/api/projects/${projectId}/stage`, {
        method: "POST", headers: { cookie, "content-type": "application/json", origin: baseEnv.APP_ORIGIN }, body,
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Project not found" });
    }
  });

  it("checks External capability before flag-off Board operational responses", async () => {
    const cookie = await externalCookie();
    await database.DB.prepare("UPDATE projects SET stage_key = 'editing_autohdr', archived_at = NULL, board_revision = 0 WHERE id = ?").bind(manifestProjectId).run();
    await database.DB.prepare("UPDATE feature_flags SET enabled = 0 WHERE key = 'tb5a_board_contract_enabled'").run();
    try {
      const boardPosition = await SELF.fetch(`https://portal.test/api/projects/${manifestProjectId}/board-position`, {
        method: "POST", headers: { cookie, "content-type": "application/json", origin: baseEnv.APP_ORIGIN },
        body: JSON.stringify({ expected: { stageKey: "editing", boardRevision: 0 }, targetStageKey: "editing", placement: { kind: "append" } }),
      });
      expect(boardPosition.status).toBe(403);
      await expect(boardPosition.json()).resolves.toEqual({ error: "Forbidden", capability: "prioritizeProjects" });
      for (const path of ["archive", "restore"]) {
        const response = await SELF.fetch(`https://portal.test/api/projects/${manifestProjectId}/${path}`, { method: "POST", headers: { cookie, origin: baseEnv.APP_ORIGIN } });
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({ error: "Forbidden", capability: "archiveProject" });
      }
    } finally {
      await database.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'").run();
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
      // A withheld route must deny outright (401/403/404) — a 3xx redirect to a signed URL
      // would be a successful disclosure that a `>= 300` check would wave through.
      expect(response.status, `${route.method} ${route.path}`).toBeGreaterThanOrEqual(400);
    }
  });

  it("rejects a structurally custom Hono error handler", () => {
    const router = new Hono<AppEnv>();
    router.onError((_error, c) => c.json({ error: "custom" }, 500));
    expect(() => assertNoCustomOnError([router])).toThrow(/custom Hono onError/);
  });
});
