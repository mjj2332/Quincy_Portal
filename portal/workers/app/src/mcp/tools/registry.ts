import { z } from "zod";
import { roleHasCapability } from "@quincy/shared";
import type { McpScope } from "../authority";
import { readTool, type McpTool } from "./define";
import { READ_TOOLS } from "./reads";
import { ADMIN_READ_TOOLS } from "./admin-reads";
import { WRITE_TOOLS } from "./writes";
import { COLLAB_WRITE_TOOLS } from "./collab-writes";
import { DOWNLOAD_TOOLS } from "./downloads";
import { WHITEBOARD_TOOLS } from "./whiteboard";
import { ADMIN_WRITE_TOOLS } from "./admin-writes";
import { VIDEO_READ_TOOLS } from "./video-reads"; // #963
import { PLANNING_TOOLS } from "./planning"; // #971
import { ADMIN_MORE_TOOLS } from "./admin-more"; // #973
import { VIDEO_WRITE_TOOLS } from "./video-writes"; // #965
import { VIDEO_NOTE_TOOLS } from "./video-notes"; // #964
import { REVIEW_LINK_TOOLS } from "./review-links"; // #966
import { DELIVERY_TOOLS } from "./delivery"; // #968
import { SOCIAL_OVERLAY_TOOLS } from "./social-overlays"; // #970
import { VIDEO_DOWNLOAD_TOOLS } from "./video-downloads"; // #972
import { PREMIUM_TOOLS } from "./premium"; // #969

export type { McpTool, McpToolContext, McpToolResult } from "./define";

const getMe = readTool({ name: "get_me", template: "/api/me", description: "The Portal staff member this connection acts as: their profile, role and capabilities." });

/** One module per group, one spread per line: a new group appends its own line (commented with its ticket). */
export const MCP_TOOLS: readonly McpTool[] = [
  getMe,
  ...READ_TOOLS,
  ...ADMIN_READ_TOOLS,
  ...WRITE_TOOLS,
  ...COLLAB_WRITE_TOOLS,
  ...DOWNLOAD_TOOLS,
  ...WHITEBOARD_TOOLS,
  ...ADMIN_WRITE_TOOLS,
  ...VIDEO_READ_TOOLS, // #963
  ...PLANNING_TOOLS, // #971
  ...ADMIN_MORE_TOOLS, // #973
  ...VIDEO_WRITE_TOOLS, // #965
  ...VIDEO_NOTE_TOOLS, // #964
  ...REVIEW_LINK_TOOLS, // #966
  ...DELIVERY_TOOLS, // #968
  ...SOCIAL_OVERLAY_TOOLS, // #970
  ...VIDEO_DOWNLOAD_TOOLS, // #972
  ...PREMIUM_TOOLS, // #969
];

/** A tool's input as the strict object its callers are held to: unknown arguments are an error. */
export const strictInput = (tool: McpTool) => z.object(tool.inputSchema).strict();

/** Only the tools the role and the granted scopes allow. `admin` implies nothing else: scopes are explicit. The route still enforces everything. */
export function toolsFor(role: string, scopes: readonly McpScope[]): McpTool[] {
  return MCP_TOOLS.filter((tool) =>
    scopes.includes(tool.scope)
    && (!tool.capability || roleHasCapability(role as never, tool.capability))
    && (!tool.anyCapability || tool.anyCapability.some((capability) => roleHasCapability(role as never, capability))));
}
