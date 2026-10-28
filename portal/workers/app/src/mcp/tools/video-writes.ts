import { z } from "zod";
import { readTool, writeTool, type McpTool } from "./define";

/**
 * Video and Version management (#965). Each tool is one cookie route, gated by the capability the route checks:
 *  - Review status: `annotateVideo` lists it (the route also refuses `approved_internal` without `approveVideoInternal`, so an External
 *    editor can set In review only). Setting `approved_internal` IS the internal approval decision; the Client-approval decisions route
 *    belongs to Release (`releaseVideo`), not here.
 *  - Rename: `uploadVideo`. Trash, removal impact, delete and restore: `manageVideoTrash` (Admin and Editor).
 *  - Delete and remove are restorable, so they do not confirm; they carry `destructiveHint`. The caller passes the impact it read
 *    (`expected`), and the route refuses with `impact_changed` and the fresh impact when the Video or Version has since changed.
 * There is no poster tool: the poster route is a raw JPEG upload (out of scope for MCP, ADR 0026).
 */

const projectId = z.string().uuid().describe("The Project's id.");
const videoId = z.string().uuid().describe("The Video's id (`id` in list_project_videos).");
const assetId = z.string().uuid().describe("The Version's id (`assetId` of a Version in list_project_videos).");
const count = z.number().int().nonnegative();
const reviewStatus = z.enum(["in_review", "approved_internal"]);

const setReviewStatus = writeTool({
  name: "set_version_review_status",
  method: "PUT",
  template: "/api/projects/:projectId/video-versions/:assetId/review-status",
  capability: "annotateVideo",
  idempotent: true,
  description: "Set a Version's Review status: in_review, or approved_internal (the internal approval decision; needs approveVideoInternal, so Admin and Editor only). `expectedStatus` is the status you read on the Version; the route answers 409 review_status_conflict if it changed, and 409 not_latest_version if a newer Version exists (set it on that one). Returns the Video.",
  inputSchema: { projectId, assetId, reviewStatus, expectedStatus: reviewStatus },
});

const renameVersion = writeTool({
  name: "rename_video_version",
  method: "PUT",
  template: "/api/projects/:projectId/video-versions/:assetId/file-name",
  capability: "uploadVideo",
  idempotent: true,
  description: "Rename a Version's file name (the Video's title follows the newest Version's name). A `.mov` is stored as `.mp4`. 409 not_latest_version if a newer Version exists. Returns the Video.",
  inputSchema: { projectId, assetId, filename: z.string().min(1).max(255).describe("The new file name, ending .mp4 or .mov.") },
});

const trashPath = "/api/projects/:projectId/video-trash";
const listTrash = readTool({
  name: "list_video_trash",
  template: trashPath,
  capability: "manageVideoTrash",
  description: "A Project's Video Trash: the Videos and Versions removed from sight and the days left before each is purged (`retentionDays`). Restore one with restore_video or restore_video_version.",
  inputSchema: { projectId },
});

const versionImpact = readTool({
  name: "get_version_removal_impact",
  template: "/api/projects/:projectId/video-versions/:assetId/removal-impact",
  capability: "manageVideoTrash",
  description: "What removing one Version takes out of sight: notes, decisions, whether it is released, the Review links that grant it, and whether it is the last Version (removing the last one removes the Video) or an upload is in progress. Read it before remove_video_version and pass it as `expected`.",
  inputSchema: { projectId, assetId },
});

const videoImpact = readTool({
  name: "get_video_removal_impact",
  template: "/api/projects/:projectId/videos/:videoId/removal-impact",
  capability: "manageVideoTrash",
  description: "What deleting a whole Video takes out of sight: the exact live Version set (assetIds), and the notes, decisions, releases and Review links across them; `uploading` or `published` (in Client Delivery) block the delete. Read it before delete_video and pass it as `expected`.",
  inputSchema: { projectId, videoId },
});

const removeVersion = writeTool({
  name: "remove_video_version",
  method: "POST",
  template: "/api/projects/:projectId/video-versions/:assetId/remove",
  capability: "manageVideoTrash",
  destructive: true,
  description: "Move one Version to the Video Trash (restorable with restore_video_version for the retention period). `expected` is the impact from get_version_removal_impact (notes, decisions, release, links as a count); `removeVideo` must be true exactly when it is the last Version (then the Video goes too). 409 impact_changed returns the fresh impact; 409 last_version, upload_in_progress and a Client Delivery lock are refusals. No confirmation step.",
  inputSchema: {
    projectId, assetId,
    expected: z.object({ notes: count, decisions: count, release: z.boolean(), links: count }).strict().describe("The impact you read; links is the number of Review links."),
    removeVideo: z.boolean().describe("true only when this is the last Version."),
  },
});

const deleteVideo = writeTool({
  name: "delete_video",
  method: "POST",
  template: "/api/projects/:projectId/videos/:videoId/remove",
  capability: "manageVideoTrash",
  destructive: true,
  description: "Move a whole Video, with every live Version, to the Video Trash (restorable with restore_video for the retention period). `expected` is the impact from get_video_removal_impact: its assetIds and the notes, decisions, releases and links counts. 409 impact_changed returns the fresh impact; a published or uploading Video is refused. No confirmation step.",
  inputSchema: {
    projectId, videoId,
    expected: z.object({ assetIds: z.array(z.string().uuid()).min(1), notes: count, decisions: count, releases: count, links: count }).strict().describe("The impact you read; links is the number of Review links."),
  },
});

const restoreVersion = writeTool({
  name: "restore_video_version",
  method: "POST",
  template: "/api/projects/:projectId/video-versions/:assetId/restore",
  capability: "manageVideoTrash",
  idempotent: true,
  description: "Bring a trashed Version back (find it with list_video_trash). 409 video_in_trash if its Video is in Trash too: restore the Video first. Returns the Video.",
  inputSchema: { projectId, assetId },
});

const restoreVideo = writeTool({
  name: "restore_video",
  method: "POST",
  template: "/api/projects/:projectId/videos/:videoId/restore",
  capability: "manageVideoTrash",
  idempotent: true,
  description: "Bring a trashed Video back with the Versions that were removed with it (find it with list_video_trash). Returns the Video.",
  inputSchema: { projectId, videoId },
});

export const VIDEO_WRITE_TOOLS: readonly McpTool[] = [
  setReviewStatus, renameVersion, removeVersion, deleteVideo, restoreVersion, restoreVideo,
  listTrash, versionImpact, videoImpact,
];
