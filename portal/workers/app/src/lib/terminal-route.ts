import { COMPOSED_HANDLER } from "hono/utils/constants";
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

export type SecurityRouteClass = "scoped" | "constant-capability-denial" | "global-self" | "withheld" | "terminal-fallback";
export type SecurityRouteRegistration = { method: string; path: string; class: SecurityRouteClass };

/**
 * The route list is intentionally checked in. A new Hono terminal registration must be marked
 * and classified; the count reconciliation below prevents an unmarked route from silently
 * entering both the actual and expected sets.
 */
export const PROJECT_SECURITY_ROUTE_CLASSIFICATION = [
  { method: "ALL", path: "*", class: "terminal-fallback" },
  { method: "GET", path: "/__transform-source/*", class: "terminal-fallback" },
  { method: "ALL", path: "/__transform-source", class: "terminal-fallback" },
  { method: "ALL", path: "/api/*", class: "terminal-fallback" },
  { method: "PATCH", path: "/api/admin/agencies/:id", class: "withheld" },
  { method: "GET", path: "/api/admin/agencies", class: "withheld" },
  { method: "POST", path: "/api/admin/agencies", class: "withheld" },
  { method: "PATCH", path: "/api/admin/agents/:id", class: "withheld" },
  { method: "GET", path: "/api/admin/agents", class: "withheld" },
  { method: "POST", path: "/api/admin/agents", class: "withheld" },
  { method: "POST", path: "/api/admin/autohdr/backfill", class: "withheld" },
  { method: "POST", path: "/api/admin/autohdr/scaffold-backfill", class: "withheld" },
  { method: "POST", path: "/api/admin/backfill-board-position", class: "withheld" },
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
  { method: "POST", path: "/api/projects/:id/documents/:sessionId/abort", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/documents/complete", class: "withheld" },
  { method: "PUT", path: "/api/projects/:id/documents/direct/:sessionId/:slot", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/documents/presign", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/documents", class: "withheld" },
  { method: "GET", path: "/api/projects/:id/download-selection/:ticket/archive.zip", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/download-selection", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/dropbox-sync", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/fetch-edited", class: "withheld" },
  { method: "GET", path: "/api/projects/:id/ingest-status", class: "withheld" },
  { method: "GET", path: "/api/projects/:id/jobs", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/links/:linkId/reorder", class: "withheld" },
  { method: "DELETE", path: "/api/projects/:id/links/:linkId", class: "withheld" },
  { method: "PATCH", path: "/api/projects/:id/links/:linkId", class: "withheld" },
  { method: "GET", path: "/api/projects/:id/links", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/links", class: "withheld" },
  { method: "GET", path: "/api/projects/:id/manual-upload-jobs", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/priority", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/restore", class: "withheld" },
  { method: "GET", path: "/api/projects/:id/selected-raw.zip", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/send-to-autohdr", class: "withheld" },
  { method: "POST", path: "/api/projects/:id/stage", class: "withheld" },
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
  { method: "POST", path: "/api/projects/:projectId/subtasks/:subtaskId/reorder", class: "scoped" },
  { method: "DELETE", path: "/api/projects/:projectId/subtasks/:subtaskId", class: "scoped" },
  { method: "PATCH", path: "/api/projects/:projectId/subtasks/:subtaskId", class: "scoped" },
  { method: "GET", path: "/api/projects/:projectId/subtasks", class: "scoped" },
  { method: "POST", path: "/api/projects/:projectId/subtasks", class: "scoped" },
  { method: "GET", path: "/api/projects", class: "scoped" },
  { method: "POST", path: "/api/projects", class: "scoped" },
  { method: "GET", path: "/api/stages", class: "withheld" },
  { method: "POST", path: "/api/uploads/complete", class: "withheld" },
  { method: "PUT", path: "/api/uploads/direct", class: "withheld" },
  { method: "POST", path: "/api/uploads/presign", class: "withheld" },
  { method: "PATCH", path: "/api/users/:id", class: "withheld" },
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
] as const satisfies readonly SecurityRouteRegistration[];

export const CHECKED_IN_MIDDLEWARE_REGISTRATIONS = [
  ["ALL", "/api/*"], ["ALL", "/api"], ["ALL", "/api/*"], ["ALL", "/api/*"],
  ["ALL", "/media/*"], ["ALL", "/api/assets/:id"], ["ALL", "/api/integrations"],
  ["ALL", "/api/integrations/*"], ["ALL", "/api/notice-board"], ["ALL", "/api/notice-board/*"],
  ["ALL", "/api/users"], ["ALL", "/api/users/*"],
] as const;

export type HonoRouteLike = { method: string; path: string; handler: unknown };

/**
 * A mounted Hono router with a custom onError handler re-wraps every terminal
 * handler. The manifest deliberately rejects that shape: the error wrapper
 * would be the only handler visible to the route table and could hide a
 * missing terminal marker.
 */
export function assertNoCustomOnError(routers: readonly unknown[]): void {
  for (const router of routers) {
    const errorHandler = (router as { errorHandler?: unknown }).errorHandler;
    if (typeof errorHandler === "function" && errorHandler.name !== "errorHandler") {
      throw new Error("Route manifest does not permit a custom Hono onError handler");
    }
  }
}

export function normalizeSecurityRoutes(routes: readonly HonoRouteLike[]) {
  return routes.map((route) => ({ method: route.method.toUpperCase(), path: route.path, terminal: hasTerminalRouteMarker(route.handler) }));
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
  const expected = new Set(PROJECT_SECURITY_ROUTE_CLASSIFICATION.map((route) => `${route.method.toUpperCase()} ${route.path}`));
  const actualTerminal = new Set(marked.map((route) => `${route.method} ${route.path}`));
  if (expected.size !== actualTerminal.size || [...expected].some((route) => !actualTerminal.has(route))) throw new Error("Route manifest classification mismatch");
}
