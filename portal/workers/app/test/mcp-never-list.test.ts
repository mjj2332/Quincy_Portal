import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { app } from "../src/index";
import { MCP_ALLOWED_ROUTES, isAllowedMcpRoute, patternFor } from "../src/mcp/route-allowlist";
import { MCP_TOOLS } from "../src/mcp/tools/registry";
import { mcpHarness } from "./mcp-oauth-support";

/**
 * ADR 0026's never-list, mechanised (#961). Admins reach every admin capability through MCP except these: nothing here may be a
 * tool, and nothing here may be on the route allowlist under any scope. Moved here from mcp-admin.test.ts so it has one home.
 */
declare const __PORTAL_MIGRATION_SQL__: string; declare const __PORTAL_SEED_SQL__: string;
const testEnv = env as unknown as Env;
const h = mcpHarness(testEnv);
const adminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";

type NeverRoute = { method: string; template: string; kind: "role-or-active" | "flag-settings" | "connected-app-revoke" | "impersonation" };
/** Each real route that changes a role or active status, reads or writes a feature-flag setting, revokes a Connected app, or impersonates. */
const NEVER_ROUTES: readonly NeverRoute[] = [
  { method: "POST", template: "/api/users", kind: "role-or-active" },
  { method: "PATCH", template: "/api/users/:id", kind: "role-or-active" },
  { method: "GET", template: "/api/users/mcp-settings", kind: "flag-settings" },
  { method: "PATCH", template: "/api/users/mcp-settings", kind: "flag-settings" },
  { method: "GET", template: "/api/users/impersonation-settings", kind: "flag-settings" },
  { method: "PATCH", template: "/api/users/impersonation-settings", kind: "flag-settings" },
  { method: "GET", template: "/api/users/embedded-heic-settings", kind: "flag-settings" },
  { method: "PATCH", template: "/api/users/embedded-heic-settings", kind: "flag-settings" },
  { method: "GET", template: "/api/users/external-provisioning-freeze", kind: "flag-settings" },
  { method: "PATCH", template: "/api/users/external-provisioning-freeze", kind: "flag-settings" },
  // Reports the embedded-HEIC flag's effect to the uploader.
  { method: "GET", template: "/api/embedded-media/settings", kind: "flag-settings" },
  { method: "DELETE", template: "/api/connected-apps/:id", kind: "connected-app-revoke" },
  { method: "POST", template: "/api/admin/connected-apps/revoke-all", kind: "connected-app-revoke" },
  { method: "POST", template: "/api/auth/admin/impersonate-user", kind: "impersonation" },
  { method: "POST", template: "/api/auth/admin/impersonate-user/", kind: "impersonation" },
];
const sample = (template: string) => template.replace(/:[A-Za-z]+/g, "x1");

/** The guard: every never-list route an allowlist would let through, by template or by pattern (so an alias like `:userId` is caught). */
function neverListViolations(allowlist: readonly { method: string; template: string; pattern: RegExp }[]) {
  return NEVER_ROUTES.filter((never) => allowlist.some((route) => route.method === never.method && (route.template === never.template || route.pattern.test(sample(never.template)))))
    .map((never) => `${never.method} ${never.template}`);
}
const withRoute = (method: string, template: string) => [...MCP_ALLOWED_ROUTES, { method, template, pattern: patternFor(template) }];

/** The wider spec-699 sweep: patterns over whole route families, so a new route in one is caught before anyone lists it. */
const DENYLIST: ReadonlyArray<{ id: string; method: "ANY" | "NON_GET"; path: RegExp; why: string }> = [
  { id: "auth", method: "ANY", path: /^\/api\/auth(\/|$)/, why: "OAuth, sessions and impersonation start/stop live under /api/auth" },
  { id: "oauth-and-mcp", method: "ANY", path: /^\/(oauth|mcp|\.well-known)(\/|$)/, why: "the authorization server and the MCP door itself" },
  { id: "users-writes", method: "NON_GET", path: /^\/api\/users(\/|$)/, why: "role, active and provisioning changes" },
  { id: "users-subroutes", method: "ANY", path: /^\/api\/users\//, why: "every settings, flag and freeze toggle sits under /api/users/" },
  { id: "connected-apps", method: "ANY", path: /connected-apps/, why: "Connected apps, including revoke-all" },
  { id: "impersonation", method: "ANY", path: /impersonat/, why: "impersonation" },
  { id: "dropbox-oauth", method: "ANY", path: /^\/api\/integrations\/dropbox\/(connect-url|callback)$/, why: "Dropbox OAuth" },
  { id: "uploads", method: "ANY", path: /^\/api\/(uploads|external-uploads)(\/|$)/, why: "upload transfers" },
  { id: "upload-manifest", method: "ANY", path: /\/upload-manifest$/, why: "upload manifests" },
  { id: "documents", method: "ANY", path: /^\/api\/projects\/[^/]+\/documents(\/|$)/, why: "document uploads" },
  { id: "embedded-media-writes", method: "NON_GET", path: /^\/api\/projects\/[^/]+\/embedded-media(\/|$)/, why: "embedded media uploads" },
];
const denied = (method: string, path: string) => DENYLIST.filter((rule) => rule.path.test(path) && (rule.method === "ANY" || method !== "GET"));
/** Tool names that would advertise a never-list capability. `revoke` and `setting` are not here: Review links are revoked and Delivery and notification settings are set legitimately. */
const NAME_DENY = /role|impersonat|flag|upload/;
/** A tool whose name trips NAME_DENY legitimately would be listed here with a reason. None does. */
const NAME_EXCEPTIONS: readonly string[] = [];

const realRoutes = () => app.routes.map((route) => ({ method: route.method.toUpperCase(), path: route.path }));

let adminToken = "";
beforeAll(async () => {
  await h.executeSql(__PORTAL_MIGRATION_SQL__); await h.executeSql(__PORTAL_SEED_SQL__);
  await h.DB.prepare("UPDATE feature_flags SET enabled = 1 WHERE key = 'mcp_access'").run();
  await h.addSession("admin", adminId);
  adminToken = (await h.connect("read write admin", "admin")).accessToken;
});
beforeEach(() => { delete (testEnv as { MCP_CALLS?: unknown }).MCP_CALLS; delete (testEnv as { MCP_WRITES?: unknown }).MCP_WRITES; });

describe("the never-list guard (ADR 0026): role and active status, flag settings, Connected-app revoke, impersonation", () => {
  it("passes on today's allowlist", () => {
    expect(neverListViolations(MCP_ALLOWED_ROUTES)).toEqual([]);
  });

  it("fails when any never-list route is added to the allowlist, including under another parameter name", () => {
    for (const never of NEVER_ROUTES) {
      // A parameterised route also matches the fixed ones beside it (PATCH /api/users/:id would expose every PATCH settings route).
      expect(neverListViolations(withRoute(never.method, never.template)), `${never.method} ${never.template}`).toContain(`${never.method} ${never.template}`);
    }
    expect(neverListViolations(withRoute("PATCH", "/api/users/:userId"))).toContain("PATCH /api/users/:id");
    expect(neverListViolations(withRoute("DELETE", "/api/connected-apps/:connectionId"))).toEqual(["DELETE /api/connected-apps/:id"]);
  });

  it("lists real routes only, so the list cannot rot into a typo", () => {
    const real = realRoutes();
    for (const never of NEVER_ROUTES) expect(real.some((route) => route.method === never.method && route.path === never.template), `${never.method} ${never.template}`).toBe(true);
  });

  it("covers every flag-settings, Connected-app revoke and impersonation route the app has", () => {
    const listed = new Set(NEVER_ROUTES.map((never) => `${never.method} ${never.template}`));
    const isFlagSetting = (path: string) => /^\/api\/users\/[a-z-]+-(settings|freeze)$/.test(path) || /feature-flags?/.test(path) || path === "/api/embedded-media/settings";
    const isRevoke = (method: string, path: string) => path.includes("connected-apps") && (method === "DELETE" || path.includes("revoke"));
    for (const route of realRoutes().filter((r) => !["HEAD", "OPTIONS", "ALL"].includes(r.method))) {
      if (isFlagSetting(route.path) || isRevoke(route.method, route.path) || route.path.includes("impersonat")) {
        expect(listed.has(`${route.method} ${route.path}`), `${route.method} ${route.path} is never-list but not in NEVER_ROUTES`).toBe(true);
      }
    }
  });

  it("the dispatcher refuses every never-list route even when called directly", () => {
    for (const never of NEVER_ROUTES) expect(isAllowedMcpRoute(never.method, sample(never.template)), `${never.method} ${never.template}`).toBe(false);
  });

  it("no tool an admin with every scope lists over /mcp dispatches to a never-list route", async () => {
    const listed = new Set((await h.toolsList(adminToken)).map((tool) => tool.name));
    expect(listed.size).toBe(MCP_TOOLS.length);
    const routes = MCP_TOOLS.filter((tool) => listed.has(tool.name)).map((tool) => ({ method: tool.route.method, template: tool.route.template, pattern: patternFor(tool.route.template) }));
    expect(neverListViolations(routes)).toEqual([]);
  });
});

describe("the wider never-list sweep (spec 699 \"Never through MCP\")", () => {
  it("no allowlisted route, under any scope, matches a denied pattern", () => {
    for (const route of MCP_ALLOWED_ROUTES) {
      // GET /api/users is the one allowlisted read under the users prefix (admin_list_users); it carries no write.
      expect(denied(route.method, route.template).map((rule) => rule.id), `${route.method} ${route.template}`).toEqual([]);
    }
  });

  it("every denied pattern matches a real route, so the list cannot rot into a typo", () => {
    for (const rule of DENYLIST) {
      const hit = realRoutes().some((route) => rule.path.test(route.path) && (rule.method === "ANY" || !["GET", "HEAD", "OPTIONS"].includes(route.method)));
      expect(hit, `${rule.id}: ${rule.why}`).toBe(true);
    }
  });

  it("the real routes the spec names are caught", () => {
    for (const [method, path] of [
      ["PATCH", "/api/users/x1"], ["POST", "/api/users"], ["PATCH", "/api/users/mcp-settings"], ["PATCH", "/api/users/impersonation-settings"],
      ["PATCH", "/api/users/embedded-heic-settings"], ["PATCH", "/api/users/external-provisioning-freeze"], ["DELETE", "/api/connected-apps/x1"],
      ["POST", "/api/admin/connected-apps/revoke-all"], ["POST", "/api/auth/admin/impersonate-user"], ["POST", "/api/auth/admin/stop-impersonating"],
      ["POST", "/api/uploads/presign"], ["PUT", "/api/uploads/direct"], ["POST", "/api/external-uploads"], ["POST", "/api/projects/x1/upload-manifest"],
      ["POST", "/api/projects/x1/embedded-media"], ["POST", "/api/projects/x1/documents/presign"], ["POST", "/api/integrations/dropbox/connect-url"],
      ["GET", "/api/integrations/dropbox/callback"], ["POST", "/oauth/token"], ["POST", "/mcp"],
    ] as const) expect(denied(method, path).length, `${method} ${path}`).toBeGreaterThan(0);
    // A legitimate admin read under the users prefix is not caught by the write rules.
    expect(denied("GET", "/api/users").map((rule) => rule.id)).toEqual([]);
  });

  it("no tool is named for a forbidden capability, and legitimate revoke and settings names are allowed", () => {
    for (const tool of MCP_TOOLS) {
      if (NAME_EXCEPTIONS.includes(tool.name)) continue;
      expect(NAME_DENY.test(tool.name), tool.name).toBe(false);
    }
    for (const name of ["revoke_review_link", "update_delivery_page_settings", "update_notification_settings"]) expect(NAME_DENY.test(name), name).toBe(false);
    for (const name of ["set_user_role", "impersonate_user", "toggle_feature_flag", "upload_photos"]) expect(NAME_DENY.test(name), name).toBe(true);
  });

  it("the dispatcher refuses every denied route even when called directly", () => {
    for (const [method, path] of [["PATCH", "/api/users/x1"], ["POST", "/api/users"], ["PATCH", "/api/users/mcp-settings"], ["DELETE", "/api/connected-apps/x1"], ["POST", "/api/admin/connected-apps/revoke-all"], ["POST", "/api/auth/admin/impersonate-user"], ["POST", "/api/uploads/presign"], ["POST", "/api/integrations/dropbox/connect-url"]] as const) {
      expect(isAllowedMcpRoute(method, path), `${method} ${path}`).toBe(false);
    }
  });
});
