import { z } from "zod";
import { WHITEBOARD_SERVER_EDITS_MAX, whiteboardServerEditSchema } from "@quincy/shared";
import { readTool, writeTool, type McpTool } from "./define";

/**
 * Whiteboard tools (#708, plan #699 ticket 8). Two reads and ONE edit tool; there is no restore tool, on purpose (a restore replaces
 * everyone's board). The edit is a strict, simplified command set: the server expands each edit into the full Excalidraw element,
 * so a client never sends or sees one. Every tool needs the same capability the whiteboard routes check.
 */
const projectId = z.string().uuid().describe("The Project's id.");

export const WHITEBOARD_TOOLS: McpTool[] = [
  readTool({
    name: "get_project_whiteboard",
    template: "/api/projects/:projectId/whiteboard",
    capability: "collaborateOnProject",
    description: "The Project's whiteboard as a simplified list, one entry per element: id, kind (text, sticky, shape, arrow, media or other), x, y, w, h (top-left corner and size, in board units), and where they apply text, color, shapeKind (rectangle, ellipse or diamond), from and to (an element id or an {x,y} point, for arrows) and embeddedMediaId (for media). Also returns the board `generation`: pass it to edit_project_whiteboard as expectedGeneration. Read it again before each edit round.",
    inputSchema: { projectId },
  }),
  readTool({
    name: "list_whiteboard_versions",
    template: "/api/projects/:projectId/whiteboard/versions",
    capability: "collaborateOnProject",
    description: "The whiteboard's saved versions, newest first (when, who, why, how many elements), plus the current board generation. Read-only: restoring a version is a person's action in the Portal.",
    inputSchema: { projectId },
  }),
  writeTool({
    name: "edit_project_whiteboard",
    method: "POST", template: "/api/projects/:projectId/whiteboard/server-edits", capability: "collaborateOnProject", destructive: true,
    description: `Change the Project's whiteboard as this user; everyone with the board open sees it at once, labelled as made by this app. Read the board first with get_project_whiteboard and pass its \`generation\` as expectedGeneration: if the board was restored since, the call is refused and you must read it again. Send up to ${WHITEBOARD_SERVER_EDITS_MAX} edits; they apply in order and all-or-nothing. Edits: add_text {x,y,text}; add_sticky {x,y,text,color} (color is yellow, green, blue, pink, purple or #rrggbb); add_shape {shapeKind: rectangle|ellipse|diamond, x,y,w,h}; add_arrow {from,to} (each an existing element id or an {x,y} point); place_media {embeddedMediaId,x,y} (media already on this Project's board only: no uploads); edit {id, text?, x?, y?} (moving a shape re-routes the arrows attached to it; a move is refused when an attached elbow arrow has a pinned segment: that shape must be moved in the board editor); delete {id} (removes the element for everyone; a person can undo it). x,y are the top-left corner. New element ids come back in \`applied\`. Refused on an Archived Project.`,
    inputSchema: {
      projectId,
      requestId: z.string().uuid().optional().describe("Make one up per logical edit and REUSE it if you retry the same call (after a timeout or an error you are unsure about): the board then applies the edits once and answers the retry with the first result. A new requestId means new edits."),
      expectedGeneration: z.number().int().min(1).describe("The `generation` from get_project_whiteboard."),
      edits: z.array(whiteboardServerEditSchema).min(1).max(WHITEBOARD_SERVER_EDITS_MAX).describe(`The edits, in order (1 to ${WHITEBOARD_SERVER_EDITS_MAX}).`),
    },
  }),
];
