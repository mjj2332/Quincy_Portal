/**
 * The only (method, path) pairs an MCP tool may dispatch to. Fixed list, no generic request tool,
 * no wildcard. Grows one entry at a time as tools land; `/api/auth/*` can never appear here.
 * Each entry is a route template (`:name` is one path segment); `mcp-reads.test.ts` checks the list
 * against the tool registry both ways, so an entry with no tool, or a tool with no entry, fails.
 */
const ID = "[A-Za-z0-9_-]+";

function patternFor(template: string): RegExp {
  const body = template.split("/").map((segment) => segment.startsWith(":") ? ID : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/");
  return new RegExp(`^${body}$`);
}

/** GETs only in this ticket (#703). */
const GET_TEMPLATES = [
  "/api/me",
  // Projects
  "/api/projects",
  "/api/projects/:projectId",
  "/api/stages",
  "/api/project-assignment-candidates",
  "/api/projects/:projectId/subtask-assignee-options",
  "/api/projects/:projectId/subtasks",
  "/api/projects/:projectId/links",
  "/api/dashboard/people",
  // Collaboration
  "/api/projects/:projectId/comments",
  "/api/projects/:projectId/activity",
  "/api/projects/:projectId/collaboration-summary",
  // Assets
  "/api/projects/:projectId/assets",
  "/api/assets/:assetId/annotations",
  // Other
  "/api/notifications",
  "/api/notice-board/posts",
  // Admin reads, enumerated one by one
  "/api/users",
  "/api/admin/tonomo-health",
  "/api/admin/webhook-events",
  "/api/admin/webhook-events/:eventId",
  "/api/admin/renditions-dlq",
  "/api/admin/notification-deliveries",
  "/api/admin/agencies",
  "/api/admin/agents",
  "/api/admin/stages",
  "/api/admin/attention",
  "/api/projects/:projectId/jobs",
] as const;

export const MCP_ALLOWED_ROUTES: readonly { method: string; template: string; pattern: RegExp }[] =
  GET_TEMPLATES.map((template) => ({ method: "GET", template, pattern: patternFor(template) }));

export function isAllowedMcpRoute(method: string, path: string): boolean {
  if (path.startsWith("/api/auth/") || path === "/api/auth") return false;
  return MCP_ALLOWED_ROUTES.some((route) => route.method === method && route.pattern.test(path));
}
