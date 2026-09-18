import { COMPOSED_HANDLER } from "hono/utils/constants";
import { Hono } from "hono";
import type { Handler } from "hono";
import type { AppEnv } from "../env";

/** Marker attached at the source registration site, before Hono composes middleware. */
export const TERMINAL_ROUTE_MARKER = Symbol.for("quincy.portal.terminal-route");

export function terminalRoute<P extends string>(path: P, handler: Handler<AppEnv, P>): Handler<AppEnv, P> {
  Object.defineProperty(handler, TERMINAL_ROUTE_MARKER, { configurable: false, enumerable: false, value: true });
  return handler;
}

function composedHandlers(handler: unknown): unknown[] {
  if (typeof handler !== "function") return [];
  const composed = (handler as unknown as Record<string, unknown>)[COMPOSED_HANDLER];
  if (Array.isArray(composed)) return composed;
  return composed ? [composed] : [];
}

/** Hono's custom onError composition hides the source handler behind COMPOSED_HANDLER. */
export function hasTerminalRouteMarker(handler: unknown): boolean {
  if (typeof handler !== "function") return false;
  if ((handler as unknown as Record<PropertyKey, unknown>)[TERMINAL_ROUTE_MARKER] === true) return true;
  return composedHandlers(handler).some((child) => hasTerminalRouteMarker(child));
}

export type SecurityRouteClass =
  | "scoped-project"
  | "scoped-child-resource"
  | "constant-capability-denial"
  | "principal-global"
  | "auth-protocol"
  | "bearer-protocol"
  | "withheld"
  | "terminal-fallback";
export type SecurityRouteScope = "assigned-project" | "global-self" | "capability" | "none";
export type SecurityRouteProjection = "external-safe" | "internal" | "none";
export type SecurityRouteResponse = "scoped" | "constant-403" | "protocol-404" | "fallback";
export type SecurityRouteRegistration = {
  method: string;
  path: string;
  class: SecurityRouteClass;
  scope: SecurityRouteScope;
  projection: SecurityRouteProjection;
  response: SecurityRouteResponse;
  externalSurface?: "ingest-status" | "collection-links" | "stage" | "stages" | "activity" | "calendar" | "gantt";
};
type LegacySecurityRouteClass = "scoped" | "constant-capability-denial" | "global-self" | "withheld" | "terminal-fallback";
type LegacySecurityRouteRegistrationSeed = { method: string; path: string; class: LegacySecurityRouteClass; externalSurface?: SecurityRouteRegistration["externalSurface"] };

function securityContractForClass(routeClass: SecurityRouteClass): Omit<SecurityRouteRegistration, "method" | "path" | "class"> {
  switch (routeClass) {
    case "scoped-project": return { scope: "assigned-project", projection: "external-safe", response: "scoped" };
    case "scoped-child-resource": return { scope: "assigned-project", projection: "external-safe", response: "scoped" };
    case "constant-capability-denial": return { scope: "capability", projection: "none", response: "constant-403" };
    case "principal-global": return { scope: "global-self", projection: "external-safe", response: "scoped" };
    case "auth-protocol": return { scope: "none", projection: "none", response: "protocol-404" };
    case "bearer-protocol": return { scope: "none", projection: "none", response: "protocol-404" };
    case "withheld": return { scope: "none", projection: "internal", response: "constant-403" };
    case "terminal-fallback": return { scope: "none", projection: "none", response: "fallback" };
  }
}

/**
 * The route list is intentionally checked in. A new Hono terminal registration must be marked
 * and classified; the count reconciliation below prevents an unmarked route from silently
 * entering both the actual and expected sets.
 */
const PROJECT_SECURITY_ROUTE_CLASSIFICATION_SEED = [
  { method: "GET", path: "/api/integrations/dropbox/editor-folders", class: "withheld" },
  { method: "POST", path: "/api/integrations/dropbox/editor-folders/inspect", class: "withheld" },
  { method: "POST", path: "/api/integrations/dropbox/editor-folders/link", class: "withheld" },
  { method: "ALL", path: "/*", class: "terminal-fallback" },
  { method: "GET", path: "/__transform-source/*", class: "withheld" },
  { method: "ALL", path: "/__transform-source", class: "withheld" },
  { method: "ALL", path: "/api/*", class: "terminal-fallback" },
  { method: "PATCH", path: "/api/admin/agencies/:id", class: "withheld" },
  { method: "GET", path: "/api/admin/agencies", class: "withheld" },
  { method: "POST", path: "/api/admin/agencies", class: "withheld" },
  { method: "PATCH", path: "/api/admin/agents/:id", class: "withheld" },
  { method: "GET", path: "/api/admin/agents", class: "withheld" },
  { method: "POST", path: "/api/admin/agents", class: "withheld" },
  { method: "GET", path: "/api/admin/attention", class: "withheld" },
  { method: "POST", path: "/api/admin/attention/orphan-uploads/:id/acknowledge", class: "withheld" },
  { method: "POST", path: "/api/admin/autohdr/backfill", class: "withheld" },
  { method: "POST", path: "/api/admin/autohdr/scaffold-backfill", class: "withheld" },
  { method: "POST", path: "/api/admin/notification-deliveries/:outboxId/discard", class: "withheld" },
  { method: "POST", path: "/api/admin/notification-deliveries/:outboxId/replay", class: "withheld" },
  { method: "GET", path: "/api/admin/notification-deliveries", class: "withheld" },
  { method: "POST", path: "/api/admin/renditions-dlq/:id/discard", class: "withheld" },
  { method: "POST", path: "/api/admin/renditions-dlq/:id/replay", class: "withheld" },
  { method: "GET", path: "/api/admin/renditions-dlq", class: "withheld" },
  { method: "POST", path: "/api/admin/renditions/backfill", class: "withheld" },
  { method: "PATCH", path: "/api/admin/stages/:key", class: "withheld" },
  { method: "GET", path: "/api/admin/stages", class: "withheld" },
  { method: "GET", path: "/api/admin/tonomo-health", class: "withheld" },
  { method: "POST", path: "/api/admin/webhook-events/:id/discard", class: "withheld" },
  { method: "POST", path: "/api/admin/webhook-events/:id/retry", class: "withheld" },
  { method: "GET", path: "/api/admin/webhook-events/:id", class: "withheld" },
  { method: "GET", path: "/api/admin/webhook-events", class: "withheld" },
  { method: "DELETE", path: "/api/annotations/:id", class: "withheld" },
  { method: "PATCH", path: "/api/annotations/:id", class: "withheld" },
  { method: "GET", path: "/api/assets/:id/annotations", class: "scoped" },
  { method: "POST", path: "/api/assets/:id/annotations", class: "scoped" },
  { method: "POST", path: "/api/assets/:id/review", class: "scoped" },
  { method: "DELETE", path: "/api/assets/:id/select", class: "withheld" },
  { method: "POST", path: "/api/assets/:id/select", class: "withheld" },
  { method: "DELETE", path: "/api/assets/:id", class: "withheld" },
  { method: "ALL", path: "/api/auth/*", class: "withheld" },
  { method: "POST", path: "/api/auth/admin/impersonate-user/", class: "withheld" },
  { method: "POST", path: "/api/auth/admin/impersonate-user", class: "withheld" },
  { method: "ALL", path: "/api/auth/sign-in/social", class: "withheld" },
  { method: "POST", path: "/api/external-uploads/:sessionToken/complete", class: "scoped" },
  { method: "PUT", path: "/api/external-uploads/:sessionToken/parts/:partNumber", class: "scoped" },
  { method: "DELETE", path: "/api/external-uploads/:sessionToken", class: "scoped" },
  { method: "POST", path: "/api/external-uploads", class: "scoped" },
  { method: "GET", path: "/api/health", class: "withheld" },
  { method: "GET", path: "/api/integrations/dropbox/callback", class: "withheld" },
  { method: "POST", path: "/api/integrations/dropbox/connect-url", class: "withheld" },
  { method: "POST", path: "/api/integrations/dropbox/mappings/:mappingId/resolve", class: "withheld" },
  { method: "POST", path: "/api/integrations/dropbox/monitors/:scope/reset", class: "withheld" },
  { method: "GET", path: "/api/integrations/dropbox/monitors/:scope", class: "withheld" },
  { method: "POST", path: "/api/integrations/dropbox/path-claims/reassign", class: "withheld" },
  { method: "GET", path: "/api/integrations", class: "withheld" },
  { method: "POST", path: "/api/jobs/:id/retry", class: "withheld" },
  { method: "GET", path: "/api/me", class: "global-self" },
  { method: "GET", path: "/api/project-access-snapshot", class: "global-self" },
  { method: "GET", path: "/api/mentionable-users", class: "scoped" },
  { method: "DELETE", path: "/api/notice-board/posts/:id", class: "withheld" },
  { method: "PATCH", path: "/api/notice-board/posts/:id", class: "withheld" },
  { method: "PATCH", path: "/api/notice-board/read-marker", class: "withheld" },
  { method: "PATCH", path: "/api/notice-board/read-marker/", class: "withheld" },
  { method: "GET", path: "/api/notice-board/read-marker", class: "withheld" },
  { method: "GET", path: "/api/notice-board/read-marker/", class: "withheld" },
  { method: "GET", path: "/api/notice-board/posts/latest", class: "withheld" },
  { method: "GET", path: "/api/notice-board/posts", class: "withheld" },
  { method: "POST", path: "/api/notice-board/posts", class: "withheld" },
  { method: "GET", path: "/api/notification-preferences", class: "global-self" },
  { method: "PATCH", path: "/api/notification-preferences", class: "global-self" },
  { method: "POST", path: "/api/notifications/:id/read", class: "global-self" },
  { method: "DELETE", path: "/api/notifications/:id", class: "global-self" },
  { method: "POST", path: "/api/notifications/read-all", class: "global-self" },
  { method: "GET", path: "/api/notifications", class: "global-self" },
  { method: "GET", path: "/api/project-assignment-candidates", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/archive", class: "withheld" },
  { method: "GET", path: "/api/projects/:id/assets", class: "scoped" },
  { method: "PUT", path: "/api/projects/:projectId/photographers/:userId", class: "scoped" },
  { method: "DELETE", path: "/api/projects/:projectId/photographers/:userId", class: "scoped" },
  { method: "PUT", path: "/api/projects/:projectId/editors/:userId", class: "scoped" },
  { method: "DELETE", path: "/api/projects/:projectId/editors/:userId", class: "scoped" },
  { method: "POST", path: "/api/projects/:id/autohdr-coverage", class: "withheld" },
  { method: "GET", path: "/api/projects/:id/autohdr-history", class: "withheld" },
  { method: "GET", path: "/api/projects/:id/autohdr-status", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/board-position", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/cover", class: "withheld" },
  { method: "PUT", path: "/api/projects/:id/deadline", class: "withheld" },
  // These scoped collection routes are assignment-scoped; the untagged entries intentionally
  // retain the manifest's derived external-safe label. This preserves the approved internal-shaped
  // document-upload response contract and follows the GET media precedent.
  { method: "POST", path: "/api/projects/:id/documents/:sessionId/abort", class: "scoped" },
  { method: "POST", path: "/api/projects/:id/documents/complete", class: "scoped" },
  { method: "PUT", path: "/api/projects/:id/documents/direct/:sessionId/:slot", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/documents/presign", class: "scoped" },
  { method: "POST", path: "/api/projects/:id/documents", class: "withheld" },
  { method: "GET", path: "/api/projects/:id/download-selection/:ticket/archive.zip", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/download-selection", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/dropbox-sync", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/fetch-edited", class: "withheld" },
  { method: "GET", path: "/api/projects/:id/ingest-status", class: "scoped", externalSurface: "ingest-status" },
  { method: "GET", path: "/api/projects/:id/jobs", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/links/:linkId/reorder", class: "scoped" },
  { method: "DELETE", path: "/api/projects/:id/links/:linkId", class: "scoped" },
  { method: "PATCH", path: "/api/projects/:id/links/:linkId", class: "scoped" },
  { method: "GET", path: "/api/projects/:id/links", class: "scoped", externalSurface: "collection-links" },
  { method: "POST", path: "/api/projects/:id/links", class: "scoped" },
  { method: "GET", path: "/api/projects/:id/manual-upload-jobs", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/priority", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/restore", class: "withheld" },
  { method: "GET", path: "/api/projects/:id/selected-raw.zip", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/send-to-autohdr", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/stage", class: "scoped", externalSurface: "stage" },
  { method: "POST", path: "/api/projects/:id/stage/", class: "scoped", externalSurface: "stage" },
  { method: "POST", path: "/api/projects/:id/sync-dropbox", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/upload-manifest", class: "withheld" },
  { method: "DELETE", path: "/api/projects/:id", class: "scoped" },
  { method: "GET", path: "/api/projects/:id", class: "scoped" },
  { method: "PATCH", path: "/api/projects/:id", class: "scoped" },
  { method: "GET", path: "/api/projects/:projectId/collaboration-summary", class: "scoped" },
  { method: "GET", path: "/api/projects/:projectId/comment-read-marker", class: "scoped" },
  { method: "PATCH", path: "/api/projects/:projectId/comment-read-marker", class: "scoped" },
  { method: "DELETE", path: "/api/projects/:projectId/comments/:commentId", class: "scoped" },
  { method: "PATCH", path: "/api/projects/:projectId/comments/:commentId", class: "scoped" },
  { method: "GET", path: "/api/projects/:projectId/comments", class: "scoped" },
  { method: "POST", path: "/api/projects/:projectId/comments", class: "scoped" },
  { method: "GET", path: "/api/projects/:projectId/activity", class: "scoped", externalSurface: "activity" },
  { method: "GET", path: "/api/projects/:projectId/activity/", class: "scoped", externalSurface: "activity" },
  { method: "POST", path: "/api/projects/:projectId/subtasks/:subtaskId/reorder", class: "scoped" },
  { method: "DELETE", path: "/api/projects/:projectId/subtasks/:subtaskId", class: "scoped" },
  { method: "PATCH", path: "/api/projects/:projectId/subtasks/:subtaskId", class: "scoped" },
  { method: "GET", path: "/api/projects/:projectId/subtasks", class: "scoped" },
  { method: "POST", path: "/api/projects/:projectId/subtasks", class: "scoped" },
  { method: "GET", path: "/api/projects", class: "scoped" },
  { method: "GET", path: "/api/production-calendar", class: "scoped", externalSurface: "calendar" },
  { method: "GET", path: "/api/production-calendar/", class: "scoped", externalSurface: "calendar" },
  { method: "POST", path: "/api/projects", class: "withheld" },
  { method: "GET", path: "/api/stages", class: "global-self", externalSurface: "stages" },
  { method: "POST", path: "/api/uploads/complete", class: "withheld" },
  { method: "POST", path: "/api/uploads/complete/", class: "withheld" },
  { method: "PUT", path: "/api/uploads/direct", class: "withheld" },
  { method: "PUT", path: "/api/uploads/direct/", class: "withheld" },
  { method: "POST", path: "/api/uploads/presign", class: "withheld" },
  { method: "POST", path: "/api/uploads/presign/", class: "withheld" },
  { method: "PATCH", path: "/api/users/:id", class: "withheld" },
  { method: "GET", path: "/api/users/external-provisioning-freeze", class: "withheld" },
  { method: "PATCH", path: "/api/users/external-provisioning-freeze", class: "withheld" },
  { method: "GET", path: "/api/users/impersonation-settings", class: "withheld" },
  { method: "PATCH", path: "/api/users/impersonation-settings", class: "withheld" },
  { method: "GET", path: "/api/users", class: "withheld" },
  { method: "POST", path: "/api/users", class: "withheld" },
  { method: "ALL", path: "/api", class: "terminal-fallback" },
  { method: "ALL", path: "/d/*", class: "terminal-fallback" },
  { method: "ALL", path: "/d", class: "terminal-fallback" },
  { method: "ALL", path: "/media/*", class: "terminal-fallback" },
  { method: "GET", path: "/media/annotation/:annotationId", class: "scoped" },
  { method: "GET", path: "/media/asset/:assetId/:variant", class: "scoped" },
  { method: "ALL", path: "/media", class: "terminal-fallback" },
] as const satisfies readonly LegacySecurityRouteRegistrationSeed[];

const CONSTANT_CAPABILITY_DENIAL_KEYS = new Set([
  "DELETE /api/assets/:id",
  "DELETE /api/assets/:id/select",
  "POST /api/assets/:id/select",
  "POST /api/projects",
  "DELETE /api/projects/:id",
  "POST /api/projects/:id/autohdr-coverage",
  "GET /api/projects/:id/autohdr-history",
  "GET /api/projects/:id/autohdr-status",
  "POST /api/projects/:id/fetch-edited",
  "GET /api/projects/:id/jobs",
  "GET /api/projects/:id/manual-upload-jobs",
  "POST /api/projects/:id/send-to-autohdr",
  "POST /api/jobs/:id/retry",
]);

function securityClassForSeed(route: LegacySecurityRouteRegistrationSeed): SecurityRouteClass {
  const key = `${route.method.toUpperCase()} ${route.path}`;
  if (route.path === "/api/auth/*" || route.path === "/api/auth/sign-in/social") return "auth-protocol";
  if (CONSTANT_CAPABILITY_DENIAL_KEYS.has(key)) return "constant-capability-denial";
  if (route.class === "scoped") {
    return route.path === "/api/projects" || route.path === "/api/production-calendar" || route.path === "/api/production-calendar/" || route.path === "/api/projects/:id" && (route.method === "GET" || route.method === "PATCH")
      ? "scoped-project"
      : "scoped-child-resource";
  }
  if (route.class === "global-self") return "principal-global";
  if (route.class === "terminal-fallback") return "terminal-fallback";
  return "withheld";
}

export const PROJECT_SECURITY_ROUTE_CLASSIFICATION = PROJECT_SECURITY_ROUTE_CLASSIFICATION_SEED.map((route) => ({
  ...route,
  class: securityClassForSeed(route),
  ...securityContractForClass(securityClassForSeed(route)),
})) satisfies readonly SecurityRouteRegistration[];

export const CHECKED_IN_MIDDLEWARE_REGISTRATIONS = [
  ["ALL", "/api/*"], ["ALL", "/api"], ["ALL", "/api"], ["ALL", "/api/*"], ["ALL", "/api/*"], ["ALL", "/api/*"],
  ["ALL", "/media/*"], ["ALL", "/api/assets/:id"], ["ALL", "/api/integrations"],
  ["ALL", "/api/integrations/*"], ["ALL", "/api/notice-board"], ["ALL", "/api/notice-board/*"],
  ["ALL", "/api/users"], ["ALL", "/api/users/*"],
  ["POST", "/api/auth/admin/impersonate-user"], ["POST", "/api/auth/admin/impersonate-user"], ["POST", "/api/auth/admin/impersonate-user"],
  ["POST", "/api/auth/admin/impersonate-user/"], ["POST", "/api/auth/admin/impersonate-user/"], ["POST", "/api/auth/admin/impersonate-user/"],
  ["POST", "/api/projects"],
  ["POST", "/api/projects/:id/send-to-autohdr"], ["POST", "/api/projects/:id/fetch-edited"],
  ["GET", "/api/projects/:id/autohdr-status"], ["GET", "/api/projects/:id/autohdr-history"],
  ["POST", "/api/projects/:id/autohdr-coverage"],
  ["GET", "/api/projects/:id/jobs"], ["POST", "/api/jobs/:id/retry"],
  ["POST", "/api/projects/:id/upload-manifest"],
  ["GET", "/api/projects/:id/manual-upload-jobs"],
  ["POST", "/api/assets/:id/select"], ["DELETE", "/api/assets/:id/select"],
  ["ALL", "/api/production-calendar"], ["ALL", "/api/production-calendar/"],
] as const;

export type HonoRouteLike = { method: string; path: string; handler: unknown };

const DEFAULT_HONO_ERROR_HANDLER = (new Hono() as unknown as { errorHandler?: unknown }).errorHandler;

/**
 * A mounted Hono router with a custom onError handler re-wraps every terminal
 * handler. The manifest deliberately rejects that shape: the error wrapper
 * would be the only handler visible to the route table and could hide a
 * missing terminal marker.
 */
export function assertNoCustomOnError(routers: readonly unknown[]): void {
  for (const router of routers) {
    const errorHandler = (router as { errorHandler?: unknown }).errorHandler;
    if (typeof errorHandler === "function" && errorHandler !== DEFAULT_HONO_ERROR_HANDLER) {
      throw new Error("Route manifest does not permit a custom Hono onError handler");
    }
  }
}

export function normalizeSecurityRoutes(routes: readonly HonoRouteLike[]) {
  return routes.map((route) => ({ method: route.method.toUpperCase(), path: route.path, terminal: hasTerminalRouteMarker(route.handler) }));
}

function routeKey(route: { method: string; path: string }) {
  return `${route.method.toUpperCase()} ${route.path}`;
}

function routeGroups<T extends { method: string; path: string }>(routes: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const route of routes) {
    const key = routeKey(route);
    const group = groups.get(key) ?? [];
    group.push(route);
    groups.set(key, group);
  }
  return groups;
}

export function assertSecurityRouteManifest(routes: readonly HonoRouteLike[]): void {
  const actual = normalizeSecurityRoutes(routes);
  const middleware = new Set(CHECKED_IN_MIDDLEWARE_REGISTRATIONS.map(([method, path]) => `${method} ${path}`));
  const marked = actual.filter((route) => route.terminal);
  const unmarked = actual.filter((route) => !route.terminal && !middleware.has(`${route.method} ${route.path}`));
  if (unmarked.length) throw new Error(`Unmarked terminal route registration(s): ${unmarked.map((route) => `${route.method} ${route.path}`).join(", ")}`);
  if (actual.length !== marked.length + CHECKED_IN_MIDDLEWARE_REGISTRATIONS.length) {
    throw new Error("Route manifest count reconciliation failed");
  }
  // Reconcile duplicate terminal contributors by route key, but retain the grouped contributors
  // above for the count gate. A duplicate registration is safe only when it resolves to the same
  // checked-in contract; it must not be silently erased before terminality/count validation.
  const actualGroups = routeGroups(marked);
  const expectedGroups = routeGroups(PROJECT_SECURITY_ROUTE_CLASSIFICATION);
  const actualOnly = [...actualGroups.keys()].filter((key) => !expectedGroups.has(key)).sort();
  const expectedOnly = [...expectedGroups.keys()].filter((key) => !actualGroups.has(key)).sort();
  if (actualOnly.length || expectedOnly.length) {
    throw new Error([
      "Route manifest classification mismatch",
      `Registered but unclassified: ${actualOnly.length ? actualOnly.join(", ") : "none"}`,
      `Classified but not registered: ${expectedOnly.length ? expectedOnly.join(", ") : "none"}`,
    ].join("\n"));
  }
}
