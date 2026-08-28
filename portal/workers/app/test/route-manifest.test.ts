import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import {
  assertNoCustomOnError,
  assertSecurityRouteManifest,
  CHECKED_IN_MIDDLEWARE_REGISTRATIONS,
  PROJECT_SECURITY_ROUTE_CLASSIFICATION,
  normalizeSecurityRoutes,
} from "../src/lib/terminal-route";
import type { AppEnv } from "../src/env";

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

  it("rejects a structurally custom Hono error handler", () => {
    const router = new Hono<AppEnv>();
    router.onError((_error, c) => c.json({ error: "custom" }, 500));
    expect(() => assertNoCustomOnError([router])).toThrow(/custom Hono onError/);
  });
});
