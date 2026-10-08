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

/** Reads (#703). */
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
  // Admin reads of the Dropbox integration (#709): the inputs the admin Dropbox writes need
  "/api/integrations/dropbox/editor-folders",
  "/api/integrations/dropbox/monitors/:scope",
  // Signed downloads (#707): the asset tool's visibility check, and the redemption of an asset URL.
  "/media/asset/:assetId/:variant",
] as const;

/** Reached only by redeeming a signed download URL (#707): no tool owns it, `mcp/downloads.ts` dispatches to it. */
export const REDEMPTION_ONLY_ROUTES = [
  ["GET", "/api/projects/:projectId/download-selection/:ticket/archive.zip"],
] as const;

/** Writes (#705 core, #706 collaboration). Each is one tool's one route; `mcp-writes.test.ts` checks the pairing both ways. */
const WRITE_ROUTES = [
  ["POST", "/api/projects"],
  ["PATCH", "/api/projects/:projectId"],
  ["POST", "/api/projects/:projectId/priority"],
  ["PUT", "/api/projects/:projectId/deadline"],
  ["PUT", "/api/projects/:projectId/editors/:userId"],
  ["DELETE", "/api/projects/:projectId/editors/:userId"],
  ["POST", "/api/projects/:projectId/stage"],
  ["POST", "/api/projects/:projectId/archive"],
  ["POST", "/api/projects/:projectId/restore"],
  ["POST", "/api/projects/:projectId/subtasks"],
  ["PATCH", "/api/projects/:projectId/subtasks/:subtaskId"],
  ["POST", "/api/projects/:projectId/subtasks/:subtaskId/reorder"],
  ["DELETE", "/api/projects/:projectId/subtasks/:subtaskId"],
  ["POST", "/api/projects/:projectId/comments"],
  ["PATCH", "/api/projects/:projectId/comments/:commentId"],
  ["DELETE", "/api/projects/:projectId/comments/:commentId"],
  ["POST", "/api/projects/:projectId/links"],
  ["PATCH", "/api/projects/:projectId/links/:linkId"],
  ["POST", "/api/projects/:projectId/links/:linkId/reorder"],
  ["DELETE", "/api/projects/:projectId/links/:linkId"],
  ["POST", "/api/notifications/:notificationId/read"],
  ["POST", "/api/notifications/read-all"],
  // Collaboration writes (#706)
  ["POST", "/api/assets/:assetId/annotations"],
  ["PATCH", "/api/annotations/:annotationId"],
  ["DELETE", "/api/annotations/:annotationId"],
  ["POST", "/api/notice-board/posts"],
  ["PATCH", "/api/notice-board/posts/:postId"],
  ["DELETE", "/api/notice-board/posts/:postId"],
  ["POST", "/api/assets/:assetId/review"],
  ["POST", "/api/assets/:assetId/select"],
  ["DELETE", "/api/assets/:assetId/select"],
  ["POST", "/api/projects/:projectId/link-previews"],
  ["POST", "/api/notice-board/link-previews"],
  // Signed downloads (#707): get_selection_download_url creates the zip ticket. It is a read-scope tool; the ticket is the only thing written.
  ["POST", "/api/projects/:projectId/download-selection"],
] as const;

/**
 * Admin-scope writes (#709). Each is one `admin` tool's one route; none is reachable with a `write` grant. The never-list
 * (users, flags and *-settings, Connected apps, impersonation, uploads, OAuth and /api/auth) can appear nowhere in this file:
 * `mcp-admin.test.ts` walks every entry against a denylist.
 */
const ADMIN_ROUTES = [
  ["POST", "/api/integrations/dropbox/monitors/:scope/reset"],
  ["POST", "/api/integrations/dropbox/editor-folders/link"],
  ["POST", "/api/integrations/dropbox/mappings/:mappingId/resolve"],
  ["POST", "/api/integrations/dropbox/path-claims/reassign"],
  ["POST", "/api/projects/:projectId/send-to-autohdr"],
  ["POST", "/api/projects/:projectId/fetch-edited"],
  ["POST", "/api/jobs/:jobId/retry"],
  ["POST", "/api/admin/renditions-dlq/:deadLetterId/replay"],
  ["POST", "/api/admin/webhook-events/:eventId/retry"],
  ["POST", "/api/admin/agencies"],
  ["PATCH", "/api/admin/agencies/:agencyId"],
  ["POST", "/api/admin/agents"],
  ["PATCH", "/api/admin/agents/:agentId"],
  ["PATCH", "/api/admin/stages/:key"],
  ["POST", "/api/admin/renditions/backfill"],
  ["POST", "/api/admin/autohdr/backfill"],
  ["POST", "/api/admin/autohdr/scaffold-backfill"],
  // Project delete: only through the confirm round trip in `tools/admin-writes.ts`.
  ["DELETE", "/api/projects/:projectId"],
] as const;

export const MCP_ALLOWED_ROUTES: readonly { method: string; template: string; pattern: RegExp }[] = [
  ...GET_TEMPLATES.map((template) => ({ method: "GET", template, pattern: patternFor(template) })),
  ...WRITE_ROUTES.map(([method, template]) => ({ method, template, pattern: patternFor(template) })),
  ...ADMIN_ROUTES.map(([method, template]) => ({ method, template, pattern: patternFor(template) })),
  ...REDEMPTION_ONLY_ROUTES.map(([method, template]) => ({ method, template, pattern: patternFor(template) })),
];

export function isAllowedMcpRoute(method: string, path: string): boolean {
  if (path.startsWith("/api/auth/") || path === "/api/auth") return false;
  return MCP_ALLOWED_ROUTES.some((route) => route.method === method && route.pattern.test(path));
}
