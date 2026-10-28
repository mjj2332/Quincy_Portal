import type { Context, Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import { terminalRoute } from "../lib/terminal-route";
import type { AppEnv } from "../env";
import { audit } from "../lib/audit";
import { isMcpAccessEnabled } from "../lib/mcp-access";
import { loadMcpAuthority } from "./authority";
import { DOWNLOAD_MAX_TTL_SECONDS, parseDownloadQuery, verifyDownload, type DownloadTarget } from "./download-signature";
import { dispatchToApi, type McpFetchApp } from "./dispatch";
import { auditPrincipalOf } from "./tools/downloads";

/**
 * Redemption of a signed download URL (#707). `/dl/*` sits outside `/api`, so no cookie CORS applies, and a cookie
 * is never consulted: the signature and the live grant are the whole authority. Every failure is a bare 403 (410 once
 * expired) with no detail. A valid URL is dispatched in-process, as the connection's user, to the existing media or zip-ticket
 * route, so that route's own authorization, caps and ticket binding apply unchanged.
 */
const forbidden = () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
const gone = () => new Response(JSON.stringify({ error: "Gone" }), { status: 410, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });

/** The existing route a target is served by. Video targets (#972) reach the staff routes, which write their own `video_version.download` / `video_note.export` rows. */
function redemptionRequest(target: DownloadTarget): { path: string; query?: Record<string, string> } {
  const e = encodeURIComponent;
  switch (target.kind) {
    case "asset": return { path: `/media/asset/${e(target.assetId)}/${e(target.variant)}` };
    case "zip": return { path: `/api/projects/${e(target.projectId)}/download-selection/${e(target.ticket)}/archive.zip` };
    case "video-version": return { path: `/api/projects/${e(target.projectId)}/video-versions/${e(target.assetId)}/download` };
    case "marker-export": return {
      path: `/api/projects/${e(target.projectId)}/video-versions/${e(target.assetId)}/marker-export`,
      query: { format: target.format, includeInternal: target.includeInternal ? "true" : "false", status: target.status },
    };
  }
}

function redemptionAuditOf(target: DownloadTarget): [string, string, Record<string, unknown>] {
  switch (target.kind) {
    case "asset": return ["asset", target.assetId, { variant: target.variant }];
    case "zip": return ["project", target.projectId, { ticket: target.ticket }];
    case "video-version": return ["asset", target.assetId, { projectId: target.projectId, video: "version" }];
    case "marker-export": return ["asset", target.assetId, { projectId: target.projectId, video: "marker-export", format: target.format, includeInternal: target.includeInternal, status: target.status }];
  }
}

async function redeem(c: Context<AppEnv>, fetchApp: McpFetchApp, target: DownloadTarget): Promise<Response> {
  try {
    const secret = c.env.MCP_DOWNLOAD_SECRET;
    const parsed = secret ? parseDownloadQuery(target, new URL(c.req.url).searchParams) : null;
    if (!secret || !parsed || !await verifyDownload(secret, parsed.claims, parsed.signature)) return forbidden();
    const { claims } = parsed;
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp <= now) return gone();
    if (claims.exp - now > DOWNLOAD_MAX_TTL_SECONDS) return forbidden();

    // The grant, reloaded: flag on, connection live, user active, epoch unchanged, and the connection still holds `read`.
    if (!await isMcpAccessEnabled(c.env)) return forbidden();
    const connection = await createDb(c.env.DB).select({ clientName: schema.mcpConnections.clientName }).from(schema.mcpConnections).where(eq(schema.mcpConnections.id, claims.connectionId)).get();
    if (!connection) return forbidden();
    const principal = { userId: claims.userId, connectionId: claims.connectionId, clientName: connection.clientName, authorizationEpoch: claims.authorizationEpoch };
    const authority = await loadMcpAuthority(c.env, principal);
    if (!authority || !authority.connectionScopes.includes("read")) return forbidden();

    const response = await dispatchToApi(fetchApp, c.env, c.executionCtx as ExecutionContext, principal, { method: "GET", ...redemptionRequest(target) });
    // Stored renditions only: a 3xx is the hand-off to the image transformer, whose bearer outlives revocation. Never forward it.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return new Response(JSON.stringify({ error: "rendition_not_ready" }), { status: 409, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
    }
    if (response.status >= 400) { await response.body?.cancel(); return forbidden(); }
    // Written before the bytes flow, like the zip route's own audit: a stream cannot show that every byte arrived.
    const [targetType, targetId, meta] = redemptionAuditOf(target);
    await audit(c.env, auditPrincipalOf(principal), "mcp_download.redeem", targetType, targetId, meta);
    return response;
  } catch {
    return forbidden();
  }
}

export function mountMcpDownloads(app: Hono<AppEnv>, fetchApp: McpFetchApp) {
  app.get("/dl/asset/:assetId/:variant", terminalRoute("/dl/asset/:assetId/:variant", (c) =>
    redeem(c, fetchApp, { kind: "asset", assetId: c.req.param("assetId"), variant: c.req.param("variant") })));
  app.get("/dl/zip/:projectId/:ticket", terminalRoute("/dl/zip/:projectId/:ticket", (c) =>
    redeem(c, fetchApp, { kind: "zip", projectId: c.req.param("projectId"), ticket: c.req.param("ticket") })));
  // Staff video downloads (#972). The export's options are path segments; an unknown value is refused before the signature is even checked.
  app.get("/dl/video-version/:projectId/:assetId", terminalRoute("/dl/video-version/:projectId/:assetId", (c) =>
    redeem(c, fetchApp, { kind: "video-version", projectId: c.req.param("projectId"), assetId: c.req.param("assetId") })));
  app.get("/dl/marker-export/:projectId/:assetId/:format/:includeInternal/:status", terminalRoute("/dl/marker-export/:projectId/:assetId/:format/:includeInternal/:status", (c) => {
    const format = c.req.param("format"), includeInternal = c.req.param("includeInternal"), status = c.req.param("status");
    if ((format !== "edl" && format !== "fcpxml") || (includeInternal !== "true" && includeInternal !== "false") || (status !== "all" && status !== "open" && status !== "resolved")) return forbidden();
    return redeem(c, fetchApp, { kind: "marker-export", projectId: c.req.param("projectId"), assetId: c.req.param("assetId"), format, includeInternal: includeInternal === "true", status });
  }));
  app.all("/dl", terminalRoute("/dl", (c) => c.json({ error: "Not found" }, 404)));
  app.all("/dl/*", terminalRoute("/dl/*", (c) => c.json({ error: "Not found" }, 404)));
}
