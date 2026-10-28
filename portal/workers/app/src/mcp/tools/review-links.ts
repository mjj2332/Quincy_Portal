import { z } from "zod";
import {
  REVIEW_LINK_LABEL_MAX, REVIEW_LINK_MAX_GRANTS_PER_VIDEO, REVIEW_LINK_MAX_VIDEOS, REVIEW_LINK_PASSCODE_MAX, REVIEW_LINK_PASSCODE_MIN,
} from "@quincy/shared";
import { jsonResult, readTool, writeTool, type McpTool } from "./define";
import { confirmInput, requireConfirm } from "./confirm";

/**
 * Review links (#966, spec #959). Every tool needs `shareVideo`, the capability the routes check (Admin, Editor, External editor; a
 * Photographer sees none), and the routes' own Project visibility keeps an External editor to assigned Projects (#834). One tool, one
 * allowlisted route; the route does the gate, the archived refusal, the Delivery review link's refusals and the audit.
 * The DTO carries `hasPasscode`, never the passcode, and `url` (the address) while the link is not revoked.
 * Revoke, Replace, Delete and End guest sessions have no confirmation step in the route, so the tool refuses without `confirm: true`
 * and dispatches nothing until then.
 */

const LINKS = "/api/projects/:projectId/review-links";
const LINK = `${LINKS}/:linkId`;

const projectId = z.string().uuid().describe("The Project's id.");
const linkId = z.string().uuid().describe("The Review link's id (`id` in list_review_links).");
const videoId = z.string().uuid().describe("The Video's id (`id` in list_project_videos).");
const assetIds = z.array(z.string().uuid()).max(REVIEW_LINK_MAX_GRANTS_PER_VIDEO)
  .describe("The Versions to grant: `assetId` of Versions of that Video in list_project_videos. At least one.");
const expiresAt = z.string().datetime({ offset: true }).describe("When the link stops working, as an ISO 8601 date-time. Between one hour and 365 days from now.");
const allow = z.object({
  comments: z.boolean().optional().describe("Guests may leave notes."),
  approve: z.boolean().optional().describe("Guests may approve."),
  download: z.boolean().optional().describe("Guests may download the granted Versions."),
}).strict();
const label = z.string().trim().min(1).max(REVIEW_LINK_LABEL_MAX);
const passcode = z.string().trim().min(REVIEW_LINK_PASSCODE_MIN).max(REVIEW_LINK_PASSCODE_MAX);

const listReviewLinks = readTool({
  name: "list_review_links",
  template: LINKS,
  capability: "shareVideo",
  description: "A Project's Review links, the Delivery review link (`delivery: true`) pinned first: label, status (active, expired or revoked), expiry, `url` (the address, null once revoked), `hasPasscode` (the passcode itself is never returned), what guests may do (`allow`), each Video with the Versions it grants, and guest activity. 404 while Review links are off for the Project.",
  inputSchema: { projectId },
});

const createReviewLink = writeTool({
  name: "create_review_link",
  method: "POST",
  template: LINKS,
  capability: "shareVideo",
  description: "Create a Review link for chosen Videos of a Project. Each Video grants its current Version unless `grants` names others. Expiry defaults to 30 days. Returns `{ link, url }`: `url` is the address to send the client. The passcode is never returned.",
  inputSchema: {
    projectId,
    videoIds: z.array(z.string().uuid()).min(1).max(REVIEW_LINK_MAX_VIDEOS).describe("The Videos on the link (`id` in list_project_videos)."),
    grants: z.record(z.string().uuid(), assetIds).optional().describe("Per Video id (one of videoIds), the Versions to grant instead of its current one."),
    expiresAt: expiresAt.optional(),
    passcode: passcode.optional().describe(`A passcode guests must enter (${REVIEW_LINK_PASSCODE_MIN} to ${REVIEW_LINK_PASSCODE_MAX} characters).`),
    label: label.optional().describe(`A label staff see (at most ${REVIEW_LINK_LABEL_MAX} characters).`),
    allow: allow.optional().describe("What guests may do; each defaults to true."),
  },
});

const updateReviewLink = writeTool({
  name: "update_review_link",
  method: "PATCH",
  template: LINK,
  capability: "shareVideo",
  idempotent: true,
  description: "Edit a Review link's label, expiry, passcode or what guests may do. Send at least one; the rest keep their value. Refused on a revoked link and on the Delivery review link. Returns `{ link }`.",
  inputSchema: {
    projectId,
    linkId,
    label: label.nullable().optional().describe("The new label. Null clears it."),
    expiresAt: expiresAt.optional(),
    passcode: passcode.nullable().optional().describe("A new passcode. Null removes it."),
    allow: allow.optional().describe("What guests may do; only the keys sent change."),
  },
});

const addReviewLinkVideo = writeTool({
  name: "add_review_link_video",
  method: "POST",
  template: `${LINK}/videos`,
  capability: "shareVideo",
  description: "Add a Video to a Review link, granting the chosen Versions. Refused when the Video is already on the link, on a revoked link and on the Delivery review link. Returns `{ link }`.",
  inputSchema: { projectId, linkId, videoId, assetIds },
});

const removeReviewLinkVideo = writeTool({
  name: "remove_review_link_video",
  method: "DELETE",
  template: `${LINK}/videos/:videoId`,
  capability: "shareVideo",
  destructive: true,
  description: "Take a Video off a Review link: its guests can no longer watch it there. Refused on a revoked link and on the Delivery review link.",
  inputSchema: { projectId, linkId, videoId },
});

const setReviewLinkGrants = writeTool({
  name: "set_review_link_grants",
  method: "PUT",
  template: `${LINK}/videos/:videoId/grants`,
  capability: "shareVideo",
  idempotent: true,
  description: "Set which Versions of a Video on a Review link guests can watch. Replaces the whole set; at least one. Returns `{ link }`.",
  inputSchema: { projectId, linkId, videoId, assetIds },
});

/** A write whose route acts at once: the tool asks for `confirm: true` first and sends no body (none of these routes reads one). */
const confirmedLinkAction = (def: { name: string; method: "POST" | "DELETE"; template: string; description: string; reason: string }): McpTool => writeTool({
  name: def.name,
  method: def.method,
  template: def.template,
  capability: "shareVideo",
  destructive: true,
  description: `${def.description} The first call changes nothing and returns 'Confirmation required'; call again with confirm: true once the user agrees.`,
  inputSchema: { projectId, linkId, confirm: confirmInput },
  run: async (send, input) => requireConfirm(input, def.reason) ?? jsonResult(await send()),
});

const revokeReviewLink = confirmedLinkAction({
  name: "revoke_review_link",
  method: "POST",
  template: `${LINK}/revoke`,
  description: "Revoke a Review link: its address stops working for good and every guest session on it ends. Allowed on an archived Project. The Delivery review link cannot be revoked. Returns `{ link }`.",
  reason: "revoking a Review link stops its address working for good and ends every guest session on it; it cannot be undone",
});

const replaceReviewLink = confirmedLinkAction({
  name: "replace_review_link",
  method: "POST",
  template: `${LINK}/replace`,
  description: "Replace a Review link's address: the old address stops working and its guest sessions end. Refused on an expired or revoked link and on the Delivery review link. Returns `{ link, url }` with the new address.",
  reason: "replacing the address stops the old one working and ends every guest session on it; guests need the new address",
});

const deleteReviewLink = confirmedLinkAction({
  name: "delete_review_link",
  method: "DELETE",
  template: LINK,
  description: "Delete a revoked Review link so it no longer lists. Revoke it first. Allowed on an archived Project. The Delivery review link cannot be deleted.",
  reason: "deleting a Review link removes it from the Project's list for good",
});

const endReviewLinkGuestSessions = confirmedLinkAction({
  name: "end_review_link_guest_sessions",
  method: "POST",
  template: `${LINK}/end-sessions`,
  description: "End every guest session on the Project's Delivery review link (`delivery: true`): guests have to open the link again. Works only on the Delivery review link; an ordinary link ends its sessions by replace_review_link or revoke_review_link. Returns `{ link }`.",
  reason: "this signs every guest out of the Delivery review link; they have to open it again",
});

export const REVIEW_LINK_TOOLS: readonly McpTool[] = [
  listReviewLinks, createReviewLink, updateReviewLink, addReviewLinkVideo, removeReviewLinkVideo, setReviewLinkGrants,
  revokeReviewLink, replaceReviewLink, deleteReviewLink, endReviewLinkGuestSessions,
];
