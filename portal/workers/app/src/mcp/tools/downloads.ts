import { z } from "zod";
import type { AuditPrincipal } from "../../lib/audit";
import { audit } from "../../lib/audit";
import { dispatchToApi } from "../dispatch";
import { DOWNLOAD_MAX_TTL_SECONDS, buildDownloadUrl, signDownload, type DownloadTarget } from "../download-signature";
import { jsonResult, type McpTool, type McpToolContext, type McpToolResult } from "./define";
import type { McpPrincipal } from "../../lib/mcp-dispatch-context";

/**
 * Signed downloads (#707, plan #699 ticket 7). A tool never returns bytes: it proves the user can get the thing through the same
 * route the UI uses, signs a short-lived URL for it, and the redemption (`mcp/downloads.ts`) dispatches to that route again.
 */

export const auditPrincipalOf = (principal: McpPrincipal): AuditPrincipal => ({ id: principal.userId, impersonatedBy: null, via: { kind: "mcp", clientName: principal.clientName, connectionId: principal.connectionId } });

async function signedUrl(ctx: McpToolContext, target: DownloadTarget, ttlSeconds: number): Promise<{ url: string; expiresAt: string } | null> {
  const secret = ctx.env.MCP_DOWNLOAD_SECRET;
  if (!secret) return null;
  const exp = Math.floor(Date.now() / 1000) + Math.min(ttlSeconds, DOWNLOAD_MAX_TTL_SECONDS);
  const claims = { target, exp, userId: ctx.principal.userId, authorizationEpoch: ctx.principal.authorizationEpoch, connectionId: ctx.principal.connectionId };
  return { url: buildDownloadUrl(ctx.env.APP_ORIGIN, claims, await signDownload(secret, claims)), expiresAt: new Date(exp * 1000).toISOString() };
}

const notConfigured = (): McpToolResult => ({ content: [{ type: "text", text: "Downloads are not configured on this server." }], isError: true });
const issued = (value: { url: string; expiresAt: string }): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

const getAssetDownloadUrl: McpTool = {
  name: "get_asset_download_url",
  description: "A signed, short-lived (15 minutes) download link for one asset: the original file, or its web or thumb rendition. assetId comes from list_project_assets. Returns { url, expiresAt }; open the url to fetch the bytes, no sign-in needed. Refused when this user cannot open the asset. The link is a bearer: do not share or store it.",
  scope: "read",
  anyCapability: ["viewRaw", "viewEdited"],
  route: { method: "GET", template: "/media/asset/:assetId/:variant" },
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    assetId: z.string().uuid().describe("The asset's id, from list_project_assets."),
    variant: z.enum(["original", "web", "thumb"]).describe("original is the file as uploaded; web and thumb are the smaller stored renditions; if one is not ready yet the tool says so, and original always works."),
  },
  call: async (ctx, input) => {
    const assetId = String(input.assetId), variant = String(input.variant);
    // The visibility proof: the same route the UI opens, run as this user. Its body is never read.
    const probe = await dispatchToApi(ctx.fetchApp, ctx.env, ctx.executionCtx, ctx.principal, { method: "GET", path: `/media/asset/${encodeURIComponent(assetId)}/${encodeURIComponent(variant)}` });
    // A 3xx is the route's hand-off to the image transformer for a rendition not stored yet. MCP serves stored renditions only.
    if (probe.status >= 300 && probe.status < 400) {
      await probe.body?.cancel();
      return { content: [{ type: "text", text: "This size isn't ready yet; request variant 'original' or try again later" }], isError: true };
    }
    if (probe.status >= 400) return jsonResult(probe);
    await probe.body?.cancel();
    const url = await signedUrl(ctx, { kind: "asset", assetId, variant }, DOWNLOAD_MAX_TTL_SECONDS);
    if (!url) return notConfigured();
    await audit(ctx.env, auditPrincipalOf(ctx.principal), "mcp_download.issue", "asset", assetId, { variant, expiresAt: url.expiresAt });
    return issued(url);
  },
};

const getSelectionDownloadUrl: McpTool = {
  name: "get_selection_download_url",
  description: "A signed, short-lived (15 minutes) download link for a zip of chosen photo assets in one Project (all RAW, or all edited; up to 500 assets and 256 MiB). Creates the zip selection as this user, then returns { url, expiresAt }. Refused when this user may not download that selection. The link is a bearer: do not share or store it.",
  scope: "read",
  anyCapability: ["selectForEditing", "downloadFinal"],
  route: { method: "POST", template: "/api/projects/:projectId/download-selection" },
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    projectId: z.string().uuid().describe("The Project's id."),
    assetIds: z.array(z.string().uuid()).min(1).max(500).describe("The assets to zip, from list_project_assets. All from one Collection, RAW or edited, no repeats."),
  },
  call: async (ctx, input) => {
    const projectId = String(input.projectId);
    const created = await dispatchToApi(ctx.fetchApp, ctx.env, ctx.executionCtx, ctx.principal, { method: "POST", path: `/api/projects/${encodeURIComponent(projectId)}/download-selection`, body: { assetIds: input.assetIds } });
    if (!created.ok) return jsonResult(created);
    const downloadUrl = ((await created.json().catch(() => null)) as { downloadUrl?: unknown } | null)?.downloadUrl;
    const ticket = typeof downloadUrl === "string" ? /\/download-selection\/([A-Za-z0-9_-]+)\/archive\.zip$/.exec(downloadUrl)?.[1] : undefined;
    if (!ticket) return { content: [{ type: "text", text: "The download selection could not be created." }], isError: true };
    const url = await signedUrl(ctx, { kind: "zip", projectId, ticket }, DOWNLOAD_MAX_TTL_SECONDS);
    if (!url) return notConfigured();
    await audit(ctx.env, auditPrincipalOf(ctx.principal), "mcp_download.issue", "project", projectId, { count: (input.assetIds as unknown[]).length, expiresAt: url.expiresAt });
    return issued(url);
  },
};

export const DOWNLOAD_TOOLS: readonly McpTool[] = [getAssetDownloadUrl, getSelectionDownloadUrl];
