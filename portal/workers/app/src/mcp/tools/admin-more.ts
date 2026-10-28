import { z } from "zod";
import { readTool, writeTool, type McpTool } from "./define";
import { confirmInput, removeProjectMember } from "./confirm";

/**
 * The remaining admin tools (#973, spec #959, ADR 0026): the admin routes that an audit against the route allowlist found with no
 * tool (docs/plans/959-admin-mcp-audit.md). Each dispatches to exactly one allowlisted route and carries the capability that route
 * checks. Writes are `admin` scope (so destructive); reads are `read` scope like the other admin reads. The never-list stays out.
 */

const admin = { scope: "admin" } as const;
const projectId = z.string().uuid().describe("The Project's id.");

const writes: McpTool[] = [
  writeTool({
    ...admin, name: "admin_sync_delivery_review_links", method: "POST", template: "/api/admin/delivery-review-links/sync", capability: "adminBackend",
    description: "Admin: bring Projects with a Delivery page onto their Delivery review link (create it when the latest Published set holds a film, then align its Videos and Versions), one page of Projects per call, archived Projects included. Start with dryRun: true, which writes nothing and counts what a real run would create. Pass the returned nextCursor as cursor for the next page. Safe to run again: a second run reports changed: 0. The result never carries a link address.",
    inputSchema: {
      dryRun: z.boolean().optional().describe("true counts what would be created and changes nothing. Do this first."),
      limit: z.number().int().min(1).max(100).optional().describe("Projects per page (1 to 100, default 50)."),
      cursor: z.string().uuid().optional().describe("The previous page's nextCursor."),
    },
  }),
  writeTool({
    ...admin, name: "admin_reprobe_video_versions", method: "POST", template: "/api/admin/video-versions/reprobe", capability: "adminBackend",
    description: "Admin: re-probe stored video Versions that were measured by an older probe, from their stored files, and raise a frame count the old probe undercounted. One page per call. dryRun defaults to true here (as on the route): it reports each Version's outcome and writes nothing. Only dryRun: false writes, and then only where the frame count rises. Pass the returned nextCursor as cursor for the next page.",
    inputSchema: {
      dryRun: z.boolean().optional().describe("Omitted or true: report only. false: write the raised frame counts."),
      limit: z.number().int().min(1).max(10).optional().describe("Versions per page (1 to 10, default 5)."),
      cursor: z.string().min(1).max(64).optional().describe("The previous page's nextCursor."),
    },
  }),
  writeTool({
    ...admin, name: "admin_set_project_cover", method: "POST", template: "/api/projects/:projectId/cover", capability: "editProject",
    description: "Admin: choose the Project's cover photo, or clear it with assetId: null (the Project then uses its first RAW frame). The photo must be a current photo in this Project, from list_project_assets. An archived Project is refused. Returns { coverAssetId }.",
    inputSchema: { projectId, assetId: z.string().uuid().nullable().describe("The photo's id, or null to clear the cover.") },
  }),
  writeTool({
    ...admin, name: "admin_add_project_photographer", method: "PUT", template: "/api/projects/:projectId/photographers/:userId", capability: "editProject", idempotent: true,
    description: "Admin: make a person a Photographer on a Project (they are notified as in the Portal). Candidates come from list_project_assignment_candidates (photographers). Adding someone who already is one changes nothing. An archived Project's team is read-only.",
    inputSchema: { projectId, userId: z.string().uuid().describe("The person's user id, from list_project_assignment_candidates.") },
  }),
  writeTool({
    ...admin, name: "admin_remove_project_photographer", method: "DELETE", template: "/api/projects/:projectId/photographers/:userId", capability: "editProject",
    description: "Admin: remove a Photographer from a Project. membershipCycle is the membership's id from get_project (the Photographer's entry in members): a stale one is refused. If the person holds Subtasks on the Project, or this is their last role there so they lose access, the first call returns 'Confirmation required' without changing anything. Ask the user, then call again with confirm: true (and confirmedAssignmentCount when the message states a number of Subtasks).",
    inputSchema: {
      projectId, userId: z.string().uuid().describe("The Photographer's user id."),
      membershipCycle: z.string().uuid().describe("The membership's id, from get_project (members)."),
      confirm: confirmInput,
      confirmedAssignmentCount: z.number().int().nonnegative().optional().describe("With confirm: true, the number of Subtask assignments the confirmation message said will be cleared."),
    },
    // The same two-step as remove_project_editor: the route's own 422 is the confirmation, relayed rather than an error.
    run: removeProjectMember,
  }),
];

const reads: McpTool[] = [
  readTool({
    name: "admin_list_integrations", template: "/api/integrations", capability: "manageIntegrations",
    description: "Admin: the Portal's integration connections (Dropbox and the like) with status, granted scopes, token expiry, last event and last error. Never the credentials. Connecting Dropbox is done in the browser.",
  }),
  readTool({
    name: "admin_get_autohdr_status", template: "/api/projects/:projectId/autohdr-status", capability: "adminBackend",
    description: "Admin: the Project's latest AutoHDR handoff: its state, readiness units, output mapping and which edited photos cover which unit. null when the Project has none. Use it before admin_resolve_autohdr_coverage.",
    inputSchema: { projectId },
  }),
];

export const ADMIN_MORE_TOOLS: readonly McpTool[] = [...writes, ...reads];
