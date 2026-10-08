import { z } from "zod";
import { LINK_PREVIEW_URL_MAX, NOTICE_BODY_MAX_LENGTH } from "@quincy/shared";
import { jsonResult, writeTool, type McpTool } from "./define";
import { plainTextDoc } from "./writes";

/**
 * Collaboration write tools (#706, plan #699 ticket 6): annotations, Notice board posts, review and selection, link previews.
 * Same contract as `writes.ts`: one tool, one allowlisted route, and the route does the permission checks, the author-only rules
 * (an admin is not exempt), the audit and the notifications. Visibility mirrors the route's own capability check.
 * Embedded media has no tool: every one of its routes uploads bytes, or follows an upload that MCP cannot make (no uploads in MCP).
 */

const assetId = z.string().uuid().describe("The asset's id, from list_project_assets.");
const annotationId = z.string().uuid().describe("The annotation's id, from list_asset_annotations.");
const postId = z.string().uuid().describe("The Notice board post's id, from list_notice_board.");
const projectId = z.string().uuid().describe("The Project's id.");

// The same stroke contract as the route: coordinates are fractions of the image (0 to 1).
const stroke = z.object({
  points: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict()).min(1).max(2000),
  color: z.string().trim().min(1).max(32),
  width: z.number().positive().max(100),
}).strict();
const strokes = z.array(stroke).max(200);

const annotationTools: McpTool[] = [
  writeTool({
    name: "create_annotation",
    method: "POST", template: "/api/assets/:assetId/annotations", anyCapability: ["annotateRaw", "annotateEdited"],
    description: "Add an annotation to a RAW or edited photo asset as this user: a note, markup strokes, or both (at least one). The asset id comes from list_project_assets. Notifies the Project's Editors. Refused on an asset you cannot annotate.",
    inputSchema: {
      assetId,
      noteText: z.string().trim().max(10_000).optional().describe("The note text."),
      strokes: strokes.optional().describe("Markup as strokes over the image; each point is a fraction of the image width and height (0 to 1)."),
    },
  }),
  writeTool({
    name: "edit_annotation",
    method: "PATCH", template: "/api/annotations/:annotationId", anyCapability: ["annotateRaw", "annotateEdited"], idempotent: true,
    description: "Change an annotation's note or markup. annotationId comes from list_asset_annotations. Only its author can edit it; anyone else, an admin included, gets 403. Send noteText (null clears it), strokes (an empty list clears the markup), or both.",
    inputSchema: {
      annotationId,
      noteText: z.string().trim().max(10_000).nullable().optional().describe("The new note. Null clears it; omit to leave it as it is."),
      strokes: strokes.optional().describe("The new markup, replacing the old. An empty list removes the markup; omit to leave it as it is."),
    },
  }),
  writeTool({
    name: "delete_annotation",
    method: "DELETE", template: "/api/annotations/:annotationId", anyCapability: ["annotateRaw", "annotateEdited"], destructive: true,
    description: "Delete an annotation, with its markup, for good. annotationId comes from list_asset_annotations. Only its author can delete it; anyone else, an admin included, gets 403.",
    inputSchema: { annotationId },
  }),
];

const noticeText = z.string().min(1).max(NOTICE_BODY_MAX_LENGTH).describe("The post as plain text. A blank line starts a new paragraph. Mentions, images, tables and link previews are not supported here.");
const noticeTools: McpTool[] = [
  writeTool({
    name: "create_notice_post",
    method: "POST", template: "/api/notice-board/posts", capability: "viewNoticeBoard",
    description: "Post to the studio Notice board as this user (it shows 'via' this app). Returns the post and the caller's read state.",
    inputSchema: { text: noticeText },
    run: async (send, input) => jsonResult(await send({ content: plainTextDoc(String(input.text)) })),
  }),
  writeTool({
    name: "edit_notice_post",
    method: "PATCH", template: "/api/notice-board/posts/:postId", capability: "viewNoticeBoard", idempotent: true,
    description: "Replace the text of a Notice board post. postId comes from list_notice_board. Only its author can edit it; anyone else, an admin included, gets 403. Returns the post.",
    inputSchema: { postId, text: noticeText },
    run: async (send, input) => jsonResult(await send({ content: plainTextDoc(String(input.text)) })),
  }),
  writeTool({
    name: "delete_notice_post",
    method: "DELETE", template: "/api/notice-board/posts/:postId", capability: "viewNoticeBoard", destructive: true,
    description: "Delete a Notice board post for good. postId comes from list_notice_board. Only its author can delete it; anyone else, an admin included, gets 403.",
    inputSchema: { postId },
  }),
];

const reviewFields = {
  stars: z.number().int().min(1).max(5).nullable().optional().describe("1 to 5 stars. Null clears it; omit to leave it as it is."),
  colorLabel: z.enum(["select", "maybe", "cut", "hero"]).nullable().optional().describe("The color label. Null clears it; omit to leave it as it is."),
  decision: z.enum(["approved", "flagged"]).nullable().optional().describe("Approve or flag the asset. Null clears it; omit to leave it as it is."),
  recommended: z.boolean().optional().describe("Recommend a RAW asset for editing. A Photographer may set only this."),
};
const reviewTools: McpTool[] = [
  writeTool({
    name: "set_asset_review",
    method: "POST", template: "/api/assets/:assetId/review", anyCapability: ["selectForEditing", "reviewEdited", "recommendRaw"], idempotent: true,
    description: "Set an asset's review state: stars, color label, decision, and (RAW only) recommended. The asset id comes from list_project_assets, which also shows the current state. Send only what changes; at least one field is required. The route decides which fields this user may set: a Photographer may only recommend, and edited assets cannot be recommended.",
    inputSchema: { assetId, ...reviewFields },
    run: async (send, input) => {
      const { assetId: _assetId, ...fields } = input;
      if (!Object.values(fields).some((value) => value !== undefined)) return { content: [{ type: "text", text: "Input error: send at least one of stars, colorLabel, decision or recommended." }], isError: true };
      return jsonResult(await send(Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))));
    },
  }),
  writeTool({
    name: "select_asset_for_editing",
    method: "POST", template: "/api/assets/:assetId/select", capability: "selectForEditing", idempotent: true,
    description: "Select a RAW asset for editing. The asset id comes from list_project_assets. Only RAW assets can be selected; selecting one that is already selected changes nothing.",
    inputSchema: { assetId },
  }),
  writeTool({
    name: "unselect_asset_for_editing",
    method: "DELETE", template: "/api/assets/:assetId/select", capability: "selectForEditing", destructive: true, idempotent: true,
    description: "Remove a RAW asset's selection for editing (it drops out of the edit set, whoever selected it). The asset id comes from list_project_assets.",
    inputSchema: { assetId },
  }),
];

const previewUrl = z.string().min(1).max(LINK_PREVIEW_URL_MAX).describe("The address to preview. Must be a public HTTPS link; the Portal's own addresses are refused.");
const previewTools: McpTool[] = [
  writeTool({
    name: "request_project_link_preview",
    method: "POST", template: "/api/projects/:projectId/link-previews", capability: "collaborateOnProject", openWorld: true,
    description: "Ask the Portal to fetch a link preview card (title, description, image) for an address, for a Project's discussion. Fetches the address from the Portal's servers. The card is returned only: comment and Notice board tools take plain text and cannot attach it. Refused on an archived Project.",
    inputSchema: { projectId, url: previewUrl },
  }),
  writeTool({
    name: "request_notice_link_preview",
    method: "POST", template: "/api/notice-board/link-previews", capability: "viewNoticeBoard", openWorld: true,
    description: "Ask the Portal to fetch a link preview card (title, description, image) for an address, for the Notice board. Fetches the address from the Portal's servers. The card is returned only: comment and Notice board tools take plain text and cannot attach it.",
    inputSchema: { url: previewUrl },
  }),
];

export const COLLAB_WRITE_TOOLS: readonly McpTool[] = [...annotationTools, ...noticeTools, ...reviewTools, ...previewTools];
