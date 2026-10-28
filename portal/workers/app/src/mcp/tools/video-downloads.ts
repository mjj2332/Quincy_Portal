import { z } from "zod";
import { audit } from "../../lib/audit";
import { dispatchToApi } from "../dispatch";
import { DOWNLOAD_MAX_TTL_SECONDS, type DownloadTarget } from "../download-signature";
import type { McpTool, McpToolContext, McpToolResult } from "./define";
import { auditPrincipalOf, issued, notConfigured, signedUrl } from "./downloads";

/**
 * Staff video downloads (#972, spec #959). Like the #707 tools, a tool never returns bytes: it proves the user can get the file through the route the
 * browser uses, then signs a 15-minute URL that `mcp/downloads.ts` redeems by dispatching a GET to that same route.
 *
 * The proof is a HEAD, never a GET: on these two routes a GET IS the download or the export and writes its `video_version.download` / `video_note.export`
 * audit row, while a HEAD runs the same admission (gate, capability, Project visibility, the Version, and for the export its frame and EDL checks) and writes
 * nothing. A HEAD answer has no body, so a refusal is reported from its status alone.
 */

const e = encodeURIComponent;

async function probe(ctx: McpToolContext, path: string, query: Record<string, string> | undefined, refusals: Record<number, string>): Promise<McpToolResult | null> {
  const response = await dispatchToApi(ctx.fetchApp, ctx.env, ctx.executionCtx, ctx.principal, { method: "HEAD", path, query });
  await response.body?.cancel();
  if (response.ok) return null;
  return { content: [{ type: "text", text: `HTTP ${response.status}: ${refusals[response.status] ?? "The file cannot be downloaded."}` }], isError: true };
}

const REFUSED = {
  400: "Invalid id.",
  403: "Forbidden: this user may not download from this Project.",
  404: "Not found: no live Version with this id in this Project, or this video feature is off for the Project.",
};

async function issue(ctx: McpToolContext, target: DownloadTarget & { assetId: string; projectId: string }, meta: Record<string, unknown>): Promise<McpToolResult> {
  const url = await signedUrl(ctx, target, DOWNLOAD_MAX_TTL_SECONDS);
  if (!url) return notConfigured();
  await audit(ctx.env, auditPrincipalOf(ctx.principal), "mcp_download.issue", "asset", target.assetId, { projectId: target.projectId, ...meta, expiresAt: url.expiresAt });
  return issued(url);
}

const versionInput = {
  projectId: z.string().uuid().describe("The Project's id."),
  assetId: z.string().uuid().describe("The Version's assetId, from list_project_videos (each Video's versions)."),
};

const getVideoVersionDownloadUrl: McpTool = {
  name: "get_video_version_download_url",
  description: "A signed, short-lived (15 minutes) download link for one Video Version's original file, named as the browser's Download names it. Any live Version can be downloaded, including superseded or unreleased ones. Returns { url, expiresAt }; open the url to fetch the bytes, no sign-in needed. Each opening is one audited download (the link always serves the whole file). Refused when this user cannot download the Version. The link is a bearer: do not share or store it.",
  scope: "read",
  capability: "downloadVideo",
  route: { method: "HEAD", template: "/api/projects/:projectId/video-versions/:assetId/download" },
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: versionInput,
  call: async (ctx, input) => {
    const projectId = String(input.projectId), assetId = String(input.assetId);
    const refused = await probe(ctx, `/api/projects/${e(projectId)}/video-versions/${e(assetId)}/download`, undefined, REFUSED);
    if (refused) return refused;
    return issue(ctx, { kind: "video-version", projectId, assetId }, { video: "version" });
  },
};

const getMarkerExportDownloadUrl: McpTool = {
  name: "get_marker_export_download_url",
  description: "A signed, short-lived (15 minutes) download link for a Marker export of one Version's notes: a DaVinci Resolve EDL (at most 999 markers) or an FCPXML file, named as the browser's export names it. includeInternal adds internal notes (default false); status picks all, open or resolved notes (default all). Returns { url, expiresAt }; open the url to fetch the file, no sign-in needed. Each opening is one audited export. Refused when this user cannot export this Version's notes, when a note falls outside the Version, or when an EDL would exceed 999 markers (use fcpxml). The link is a bearer: do not share or store it.",
  scope: "read",
  capability: "viewVideo",
  route: { method: "HEAD", template: "/api/projects/:projectId/video-versions/:assetId/marker-export" },
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    ...versionInput,
    format: z.enum(["edl", "fcpxml"]).describe("edl is a DaVinci Resolve marker EDL; fcpxml is Final Cut Pro XML 1.9."),
    includeInternal: z.boolean().optional().describe("Include internal (staff-only) notes. Default false."),
    status: z.enum(["all", "open", "resolved"]).optional().describe("Which notes by resolution. Default all."),
  },
  call: async (ctx, input) => {
    const projectId = String(input.projectId), assetId = String(input.assetId);
    const format = input.format as "edl" | "fcpxml";
    const includeInternal = input.includeInternal === true;
    const status = (input.status ?? "all") as "all" | "open" | "resolved";
    const refused = await probe(ctx, `/api/projects/${e(projectId)}/video-versions/${e(assetId)}/marker-export`, { format, includeInternal: includeInternal ? "true" : "false", status }, {
      ...REFUSED,
      422: format === "edl"
        ? "The export cannot be built: a note falls outside this Version's frames, or the EDL would hold more than 999 markers (fcpxml has no limit)."
        : "The export cannot be built: a note falls outside this Version's frames.",
    });
    if (refused) return refused;
    return issue(ctx, { kind: "marker-export", projectId, assetId, format, includeInternal, status }, { video: "marker-export", format, includeInternal, status });
  },
};

export const VIDEO_DOWNLOAD_TOOLS: readonly McpTool[] = [getVideoVersionDownloadUrl, getMarkerExportDownloadUrl];
