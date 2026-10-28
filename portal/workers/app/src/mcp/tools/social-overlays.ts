import { z } from "zod";
import { readTool, writeTool, type McpTool } from "./define";

/**
 * Social overlays (#970, spec #959). The agency library is Admin only (`adminBackend`): the list is a `read`-scope tool like the
 * other admin reads, rename / archive / unarchive are `admin`-scope writes. Creating an overlay and replacing its image are
 * multipart PNG uploads, so there is no tool for them (owner decision); the Default overlay's archive refusal is the route's
 * (409 `default_overlay`). A Project's selection is the staff route: `viewVideo` reads it, `chooseSocialOverlays` sets it.
 * Every route audits through `auditMeta`, so the writes carry the `via: "mcp"` marker with no help from here.
 */

const overlayId = z.string().uuid().describe("The overlay's id, from admin_list_social_overlays.");
const expectedRevision = z.number().int().positive().describe("The overlay's `revision` from admin_list_social_overlays. A stale one is refused (overlay_conflict): list again.");
const admin = { scope: "admin" } as const;

export const SOCIAL_OVERLAY_TOOLS: readonly McpTool[] = [
  readTool({
    name: "admin_list_social_overlays",
    template: "/api/admin/social-overlays",
    capability: "adminBackend",
    description: "Admin: the agency's Social overlays (library for Video review), with id, name, platform, whether it is the Default, archived time, image URL, size and revision. Read-only.",
  }),
  writeTool({
    ...admin, name: "admin_update_social_overlay", method: "PATCH", template: "/api/admin/social-overlays/:id", capability: "adminBackend", idempotent: true,
    description: "Admin: rename a Social overlay or change its platform label. Send only what changes, with the revision you listed. Returns the overlay. The image cannot be changed through MCP.",
    inputSchema: {
      id: overlayId,
      name: z.string().trim().min(1).max(80).optional().describe("The overlay's name."),
      platformLabel: z.string().trim().min(1).max(40).optional().describe("The platform it mimics, e.g. Instagram."),
      expectedRevision,
    },
  }),
  writeTool({
    ...admin, name: "admin_archive_social_overlay", method: "POST", template: "/api/admin/social-overlays/:id/archive", capability: "adminBackend", idempotent: true,
    description: "Admin: archive a Social overlay so Projects stop offering it. The Default overlay cannot be archived (refused). Reversible with admin_unarchive_social_overlay.",
    inputSchema: { id: overlayId, expectedRevision },
  }),
  writeTool({
    ...admin, name: "admin_unarchive_social_overlay", method: "POST", template: "/api/admin/social-overlays/:id/unarchive", capability: "adminBackend", idempotent: true,
    description: "Admin: bring an archived Social overlay back into the library.",
    inputSchema: { id: overlayId, expectedRevision },
  }),
  readTool({
    name: "get_project_social_overlays",
    template: "/api/projects/:projectId/social-overlays",
    capability: "viewVideo",
    description: "The Social overlays a Project offers: the `available` library, the `selected` ones, the `resolved` previews and the `revision` to pass to set_project_social_overlays. Answers 404 while Video review is off for the Project.",
    inputSchema: { projectId: z.string().uuid().describe("The Project's id.") },
  }),
  writeTool({
    name: "set_project_social_overlays", method: "PUT", template: "/api/projects/:projectId/social-overlays", capability: "chooseSocialOverlays", idempotent: true,
    description: "Set which Social overlays a Project offers (replaces the whole selection, in order). Pass the `revision` from get_project_social_overlays as expectedRevision; if the selection moved the route answers social_overlays_conflict with the current state. Archived Projects are read-only.",
    inputSchema: {
      projectId: z.string().uuid().describe("The Project's id."),
      overlayIds: z.array(z.string().uuid()).max(50).describe("Overlay ids from `available`, in the order to offer them. Empty clears the selection."),
      expectedRevision: z.string().regex(/^[0-9a-f]{64}$/).describe("The `revision` from get_project_social_overlays."),
    },
  }),
];
