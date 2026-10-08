/**
 * The only (method, path) pairs an MCP tool may dispatch to. Fixed list, no generic request tool.
 * Grows one entry at a time as tools land; `/api/auth/*` can never appear here.
 */
type AllowedRoute = { method: string; pattern: RegExp };

const ID = "[A-Za-z0-9_-]+";

const ALLOWED_ROUTES: readonly AllowedRoute[] = [
  { method: "GET", pattern: /^\/api\/me$/ },
  { method: "GET", pattern: /^\/api\/projects$/ },
  { method: "GET", pattern: new RegExp(`^/api/projects/${ID}$`) },
];

export function isAllowedMcpRoute(method: string, path: string): boolean {
  if (path.startsWith("/api/auth/") || path === "/api/auth") return false;
  return ALLOWED_ROUTES.some((route) => route.method === method && route.pattern.test(path));
}
