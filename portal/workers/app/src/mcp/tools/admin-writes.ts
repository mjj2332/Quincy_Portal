import { z } from "zod";
import { COLLECTION_KINDS } from "@quincy/shared";
import { dispatchToApi } from "../dispatch";
import { CONFIRM_TTL_SECONDS, sha256Hex, signConfirmToken, verifyConfirmToken } from "../confirm-token";
import { jsonResult, writeTool, type McpTool, type McpToolContext, type McpToolResult } from "./define";

/**
 * Admin-scope write tools (#709, plan #699 ticket 9). Each one dispatches to exactly one allowlisted route, is visible only to a role
 * holding the route's own capability AND a connection holding the `admin` grant, and is marked `destructiveHint` (the factory forces
 * it for `scope: "admin"`). The route does everything it does for the cookie UI: permission check, audit, activity, background hand-off.
 *
 * Never here, under any scope (see `mcp-admin.test.ts`): user role or active changes and provisioning, feature flags and `*-settings`
 * toggles, Connected apps, impersonation, uploads, Dropbox OAuth, and `/api/auth/*` or `/oauth/*`.
 */

const uuid = (what: string) => z.string().uuid().describe(what);
const projectId = uuid("The Project's id.");
const dryRun = z.boolean().optional().describe("true counts what would happen and changes nothing. Always do this first.");

const subtreeRoot = z.object({ path: z.string().min(1).max(2000), section: z.string().max(200).nullable(), folderId: z.string().min(1).max(200) }).strict();
const editorCandidate = z.object({
  projectId: z.string().uuid(), connectionId: z.string().min(1).max(200),
  expectedShootDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expectedRawFolderPath: z.string().nullable(), expectedRawFolderLink: z.string().nullable(),
  rootPath: z.string().min(1).max(2000), rootFolderId: z.string().min(1).max(200),
  inputRoots: z.array(subtreeRoot).min(1).max(10), outputRoots: z.array(subtreeRoot).min(1).max(10),
}).strict();

const admin = { scope: "admin" } as const;

const dropboxTools: McpTool[] = [
  writeTool({
    ...admin, name: "admin_reset_dropbox_monitor", method: "POST", template: "/api/integrations/dropbox/monitors/:scope/reset", capability: "manageIntegrations",
    description: "Admin: reset the cursor of one Dropbox monitor so it re-scans from the start (a re-sync). Look at it first with admin_inspect_dropbox_monitor.",
    inputSchema: { scope: z.enum(["raw", "autohdr", "editor"]).describe("Which monitor to reset.") },
  }),
  writeTool({
    ...admin, name: "admin_link_editor_folder", method: "POST", template: "/api/integrations/dropbox/editor-folders/link", capability: "manageIntegrations",
    description: "Admin: link a Project to a reviewed Dropbox Editor folder. candidate comes from admin_preview_editor_folders and must be reviewed by a person first (reviewed: true is that statement). The Portal re-verifies the folders against Dropbox and refuses if the Project changed since.",
    inputSchema: { reviewed: z.literal(true).describe("true: a person reviewed this exact candidate."), candidate: editorCandidate },
  }),
  writeTool({
    ...admin, name: "admin_resolve_autohdr_mapping", method: "POST", template: "/api/integrations/dropbox/mappings/:mappingId/resolve", capability: "manageIntegrations",
    description: "Admin: unblock an AutoHDR output mapping stopped by a folder-name collision, by choosing which verified Dropbox folder it owns.",
    inputSchema: { mappingId: uuid("The blocked AutoHDR mapping's id."), chosenPathKey: z.string().min(1).describe("The path key of the claim to take."), verifiedFolderId: z.string().min(1).describe("The Dropbox folder id of that path, which the Portal verifies.") },
  }),
  writeTool({
    ...admin, name: "admin_reassign_autohdr_path_claim", method: "POST", template: "/api/integrations/dropbox/path-claims/reassign", capability: "manageIntegrations",
    description: "Admin: move an AutoHDR path claim (a tombstoned or blocked Dropbox folder) onto a blocked mapping that is allowed to use it.",
    inputSchema: { pathKey: z.string().min(1).describe("The path key of the claim to move."), targetMappingId: uuid("The blocked mapping that receives the claim."), verifiedFolderId: z.string().min(1).describe("The Dropbox folder id of that path, which the Portal verifies.") },
  }),
];

const autoHdrTools: McpTool[] = [
  writeTool({
    ...admin, name: "admin_send_to_autohdr", method: "POST", template: "/api/projects/:projectId/send-to-autohdr", capability: "adminBackend",
    description: "Admin: send a Project's selected RAW photos to AutoHDR for processing. Returns the job id; follow it with admin_list_project_jobs.",
    inputSchema: { projectId },
  }),
  writeTool({
    ...admin, name: "admin_fetch_edited_from_autohdr", method: "POST", template: "/api/projects/:projectId/fetch-edited", capability: "adminBackend",
    description: "Admin: fetch the finished edits for a Project back from AutoHDR. Returns the job id.",
    inputSchema: { projectId },
  }),
  writeTool({
    ...admin, name: "admin_retry_job", method: "POST", template: "/api/jobs/:jobId/retry", capability: "adminBackend",
    description: "Admin: retry one stuck or failed background job (AutoHDR, fetch edited, Editor sync and the like). Find the id with admin_list_project_jobs.",
    inputSchema: { jobId: uuid("The job's id, from admin_list_project_jobs.") },
  }),
];

const replayTools: McpTool[] = [
  writeTool({
    ...admin, name: "admin_replay_dead_letter", method: "POST", template: "/api/admin/renditions-dlq/:deadLetterId/replay", capability: "adminBackend",
    description: "Admin: queue an Asset's preview build again from one open rendition dead letter. The id comes from admin_list_dead_letters.",
    inputSchema: { deadLetterId: uuid("The dead letter's id, from admin_list_dead_letters.") },
  }),
  writeTool({
    ...admin, name: "admin_retry_webhook_event", method: "POST", template: "/api/admin/webhook-events/:eventId/retry", capability: "adminBackend",
    description: "Admin: put one poison Tonomo webhook event back to received and wake the processor. The id comes from admin_list_webhook_events.",
    inputSchema: { eventId: uuid("The webhook event's id, from admin_list_webhook_events.") },
  }),
];

const optionalText = (what: string) => z.string().trim().nullable().optional().describe(`${what} Null clears it; omit to leave it as it is.`);
const directoryTools: McpTool[] = [
  writeTool({
    ...admin, name: "admin_create_agency", method: "POST", template: "/api/admin/agencies", capability: "adminBackend",
    description: "Admin: create an Agency that orders Projects. Returns the new Agency.",
    inputSchema: { name: z.string().trim().min(1).describe("The Agency's name."), notes: optionalText("Notes about the Agency.") },
  }),
  writeTool({
    ...admin, name: "admin_update_agency", method: "PATCH", template: "/api/admin/agencies/:agencyId", capability: "adminBackend", idempotent: true,
    description: "Admin: change an Agency's name or notes. Send only what changes. Returns the Agency.",
    inputSchema: { agencyId: uuid("The Agency's id, from admin_list_agencies."), name: z.string().trim().min(1).optional().describe("The Agency's name."), notes: optionalText("Notes about the Agency.") },
  }),
  writeTool({
    ...admin, name: "admin_create_agent", method: "POST", template: "/api/admin/agents", capability: "adminBackend",
    description: "Admin: create a client contact (a real-estate agent), optionally at an Agency. Returns the new contact.",
    inputSchema: {
      agencyId: z.string().uuid().nullable().optional().describe("The Agency's id, from admin_list_agencies. Null or omitted for none."),
      name: z.string().trim().min(1).describe("The agent's name."),
      email: z.string().trim().email().nullable().optional().describe("The agent's email. Null or omitted for none."),
      phone: optionalText("The agent's phone number."),
    },
  }),
  writeTool({
    ...admin, name: "admin_update_agent", method: "PATCH", template: "/api/admin/agents/:agentId", capability: "adminBackend", idempotent: true,
    description: "Admin: change a client contact's Agency, name, email or phone. Send only what changes. Returns the contact.",
    inputSchema: {
      agentId: uuid("The contact's id, from admin_list_agency_contacts."),
      agencyId: z.string().uuid().nullable().optional().describe("The Agency's id. Null clears it; omit to leave it as it is."),
      name: z.string().trim().min(1).optional().describe("The agent's name."),
      email: z.string().trim().email().nullable().optional().describe("The agent's email. Null clears it; omit to leave it as it is."),
      phone: optionalText("The agent's phone number."),
    },
  }),
  writeTool({
    ...admin, name: "admin_update_stage", method: "PATCH", template: "/api/admin/stages/:key", capability: "adminBackend", idempotent: true,
    description: "Admin: rename a pipeline Stage or switch it on or off. A Stage that active Projects sit in cannot be switched off. Keys come from admin_list_stages. Returns the Stage.",
    inputSchema: { key: z.string().min(1).describe("The Stage key, from admin_list_stages."), label: z.string().trim().min(1).optional().describe("The Stage's name."), active: z.boolean().optional().describe("false switches the Stage off for new moves.") },
  }),
];

const backfillTools: McpTool[] = [
  writeTool({
    ...admin, name: "admin_backfill_renditions", method: "POST", template: "/api/admin/renditions/backfill", capability: "adminBackend",
    description: "Admin: queue preview builds for Assets that lack them, one page per call. Start with dryRun: true. Pass the returned nextCursor as cursor for the next page. Production runs need confirmProduction: true.",
    inputSchema: { dryRun, cursor: z.string().uuid().optional().describe("The previous page's nextCursor."), limit: z.number().int().min(1).max(100).optional().describe("Page size (1 to 100)."), confirmProduction: z.literal(true).optional().describe("true: a person agreed to run this against production.") },
  }),
  writeTool({
    ...admin, name: "admin_backfill_autohdr", method: "POST", template: "/api/admin/autohdr/backfill", capability: "adminBackend",
    description: "Admin: backfill AutoHDR v2 records, one page per call. Start with dryRun: true. Pass the returned cursor on for the next page.",
    inputSchema: { dryRun, limit: z.number().int().min(1).max(100).optional().describe("Page size (1 to 100)."), cursor: z.string().uuid().optional().describe("The previous page's cursor.") },
  }),
  writeTool({
    ...admin, name: "admin_backfill_autohdr_scaffolds", method: "POST", template: "/api/admin/autohdr/scaffold-backfill", capability: "adminBackend",
    description: "Admin: create the AutoHDR Dropbox folder scaffolding for Projects that have a RAW folder path but no scaffold yet. Start with dryRun: true. Safe to run again.",
    inputSchema: { dryRun, limit: z.number().int().min(1).max(200).optional().describe("How many Projects to scaffold (1 to 200).") },
  }),
];

/**
 * Project delete: a server-enforced confirm round trip, because `destructiveHint` is only advice to the AI client.
 * First call: read what the delete will destroy, return it with a token, delete nothing. Second call (`confirm: true` plus the token):
 * verify the token, recompute the summary, refuse if it changed, otherwise dispatch the existing delete route as the user, so its own
 * authorization, audit, purge and tombstone run unchanged.
 */
type Summary = { street: string; orderId: string | null; collections: Record<string, { assets: number; received: number }>; comments: number; subtasks: number };
type Read = { ok: true; summary: Summary } | { ok: false; result: McpToolResult };

const COMMENT_PAGE = 50;
const COMMENT_PAGE_CAP = 400;
const text = (message: string, isError = false): McpToolResult => ({ content: [{ type: "text", text: message }], ...(isError ? { isError: true as const } : {}) });
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

async function readSummary(ctx: McpToolContext, projectId: string): Promise<Read> {
  const get = (path: string, query?: Record<string, string>) => dispatchToApi(ctx.fetchApp, ctx.env, ctx.executionCtx, ctx.principal, { method: "GET", path, ...(query ? { query } : {}) });
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const detailResponse = await get(base);
  if (!detailResponse.ok) return { ok: false, result: await jsonResult(detailResponse) };
  const detail = asRecord(await detailResponse.json());
  if (detail.archivedAt === null || detail.archivedAt === undefined) {
    return { ok: false, result: text("Only an archived Project can be deleted. Archive it first with archive_project, then call delete_project again.", true) };
  }
  const collections: Summary["collections"] = {};
  const declared = Array.isArray(detail.collections) ? detail.collections.map(asRecord) : [];
  for (const kind of COLLECTION_KINDS) {
    const collection = declared.find((candidate) => candidate.kind === kind);
    if (!collection) continue;
    const assetsResponse = await get(`${base}/assets`, { collection: kind });
    if (!assetsResponse.ok) return { ok: false, result: await jsonResult(assetsResponse) };
    const assets = asRecord(await assetsResponse.json()).assets;
    collections[kind] = { assets: Array.isArray(assets) ? assets.length : 0, received: Number(collection.receivedCount ?? 0) };
  }
  let comments = 0;
  for (let before: string | undefined, page = 0; page < COMMENT_PAGE_CAP; page++) {
    const response = await get(`${base}/comments`, { limit: String(COMMENT_PAGE), ...(before ? { before } : {}) });
    if (!response.ok) return { ok: false, result: await jsonResult(response) };
    const body = asRecord(await response.json());
    comments += Array.isArray(body.comments) ? body.comments.length : 0;
    if (typeof body.nextCursor !== "string") break;
    before = body.nextCursor;
  }
  const subtasksResponse = await get(`${base}/subtasks`);
  if (!subtasksResponse.ok) return { ok: false, result: await jsonResult(subtasksResponse) };
  const subtasks = asRecord(await subtasksResponse.json()).subtasks;
  return { ok: true, summary: { street: String(detail.street ?? ""), orderId: typeof detail.orderId === "string" && detail.orderId.trim() !== "" ? detail.orderId : null, collections, comments, subtasks: Array.isArray(subtasks) ? subtasks.length : 0 } };
}

/** Canonical form of the summary: fixed key order, only strings and integers, no timestamps, so the same Project hashes the same. */
function canonicalSummary(summary: Summary): string {
  const kinds = Object.keys(summary.collections).sort();
  return JSON.stringify({ street: summary.street, orderId: summary.orderId, collections: kinds.map((kind) => [kind, summary.collections[kind]!.assets, summary.collections[kind]!.received]), comments: summary.comments, subtasks: summary.subtasks });
}

const deleteProject: McpTool = {
  name: "delete_project",
  description: "Admin: PERMANENTLY delete an archived Project with everything in it: its photos and files, comments, Subtasks, links, whiteboard and activity. Two steps. Call with just projectId: nothing is deleted, and you get a 'Confirmation required' summary of what would be destroyed plus a confirmToken. Show that summary to the user, and only if they agree call again with confirm: true and that confirmToken (valid 5 minutes, for this Project and this connection). If the Project changed in between you are asked to re-confirm. The Project must be archived first (archive_project).",
  scope: "admin",
  capability: "adminBackend",
  route: { method: "DELETE", template: "/api/projects/:projectId" },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  inputSchema: {
    projectId,
    confirm: z.boolean().optional().describe("true only after the user has seen the summary and agreed. Never set it on the first call."),
    confirmToken: z.string().optional().describe("The confirmToken the first call returned. Required with confirm: true."),
  },
  call: async (ctx, input) => {
    const id = String(input.projectId);
    const secret = ctx.env.MCP_DOWNLOAD_SECRET;
    if (!secret) return text("Project delete is not configured on this server.", true);
    const confirmToken = typeof input.confirmToken === "string" ? input.confirmToken : "";
    if (input.confirm === true && confirmToken === "") return text("confirmToken is required with confirm: true. Call delete_project with just projectId first, show the user the summary, then pass the token it returns.", true);

    const read = await readSummary(ctx, id);
    if (!read.ok) return read.result;
    const summaryHash = await sha256Hex(canonicalSummary(read.summary));
    const now = Math.floor(Date.now() / 1000);

    if (input.confirm !== true) {
      const exp = now + CONFIRM_TTL_SECONDS;
      const token = await signConfirmToken(secret, { connectionId: ctx.principal.connectionId, projectId: id, summaryHash, exp });
      const { summary } = read;
      const destroyed = {
        confirmToken: token,
        expiresAt: new Date(exp * 1000).toISOString(),
        project: { id, street: summary.street },
        willBeDestroyed: {
          assetsByCollection: Object.fromEntries(Object.entries(summary.collections).map(([kind, counts]) => [kind, counts.assets])),
          comments: summary.comments,
          subtasks: summary.subtasks,
          whiteboard: "the Project whiteboard and its saved versions",
          other: "the Project's files in storage, links, activity and notifications",
        },
        tonomoOrder: summary.orderId ? `Tonomo order ${summary.orderId} is tombstoned, so a resend of that order will not recreate the Project` : "no Tonomo order id on this Project",
      };
      return text(`Confirmation required: deleting "${summary.street}" is permanent and cannot be undone. Show the user what will be destroyed, and only if they agree call delete_project again with confirm: true and this confirmToken.\n${JSON.stringify(destroyed, null, 2)}`);
    }

    const verdict = await verifyConfirmToken(secret, confirmToken, { connectionId: ctx.principal.connectionId, projectId: id }, now);
    if (!verdict.ok) {
      return text(verdict.reason === "expired"
        ? "That confirmToken has expired. Call delete_project again with just projectId for a new summary and token."
        : "That confirmToken is not valid for this Project and connection. Call delete_project again with just projectId to get one.", true);
    }
    if (verdict.summaryHash !== summaryHash) {
      return text("The Project changed; re-confirm. What would be destroyed is no longer what the user was shown. Call delete_project again with just projectId, show the new summary, and ask again.", true);
    }
    return jsonResult(await dispatchToApi(ctx.fetchApp, ctx.env, ctx.executionCtx, ctx.principal, { method: "DELETE", path: `/api/projects/${encodeURIComponent(id)}` }));
  },
};

export const ADMIN_WRITE_TOOLS: readonly McpTool[] = [...dropboxTools, ...autoHdrTools, ...replayTools, ...directoryTools, ...backfillTools, deleteProject];
