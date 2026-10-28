import { z } from "zod";
import { DELIVERY_SELECTION_MAX, type DeliveryPageDto, type DeliveryState } from "@quincy/shared";
import { sha256Hex } from "../confirm-token";
import { dispatchToApi } from "../dispatch";
import { projectIsArchived } from "../../lib/project-archive";
import { PUBLISH_ARCHIVED_BODY } from "../../routes/delivery";
import { jsonResult, readTool, text, writeTool, type McpTool, type McpToolContext, type McpToolResult } from "./define";
import { signedConfirm } from "./confirm";

/**
 * Client Delivery page and Publish (#968, spec #959). Every tool dispatches to the Delivery routes the staff Delivery tab uses, so the
 * Client Delivery gate (closed: 404), the capability, Project visibility and the archived refusal are the routes' own.
 *
 * Publish is a confirm round trip on a server-signed token (action `publish`, `confirm-token.ts`). The first call reads the page and
 * Previews the proposed selection, and returns a summary of exactly what the next Published set will contain plus a token; nothing is
 * published. The second call (`confirm: true` and the token) recomputes the summary, refuses if it changed, then dispatches the Publish
 * route with the summary's `expectedLatestSet`, so a Publish that lands in between still meets the route's own `stale_set` fence.
 *
 * Preview hands out fresh random item handles on every call (`randomItemHandle`), and its URLs vary with derivative state, so the
 * summary is built from the selection itself (Asset ids in page order, kind, label, title, lock and premium) and never from handles or URLs.
 */

const projectId = z.string().uuid().describe("The Project's id.");
const assetIds = z.array(z.string().uuid()).min(1).max(DELIVERY_SELECTION_MAX)
  .describe("The Asset ids to put on the page, in the order the page shows them, from list_delivery_candidates (assetId). Unique.");
const coverAssetId = z.string().uuid().nullable().optional().describe("The cover: one of the selected photos. Omit or null for no cover.");

const DELIVERY = "/api/projects/:projectId/delivery";
const PREVIEW = "/api/projects/:projectId/delivery/preview";
const PUBLISH = "/api/projects/:projectId/delivery/publish";
const pathOf = (template: string, project: string) => template.replace(":projectId", encodeURIComponent(project));
const previewOf = (ctx: McpToolContext, project: string, body: { assetIds: string[]; coverAssetId: string | null }) =>
  dispatchToApi(ctx.fetchApp, ctx.env, ctx.executionCtx, ctx.principal, { method: "POST", path: pathOf(PREVIEW, project), body });

const getDeliveryPage = readTool({
  name: "get_delivery_page",
  template: DELIVERY,
  capability: "viewClientPreview",
  description: "A Project's Client Delivery page as staff see it: the page (address path, on or off, latest set number; null before the first Publish), the latest Published set (set number, when, cover Asset, and each item's Asset id, kind, label, position, locked and premium state), and the page as the client sees it. 404 while Client Delivery is off for the Project.",
  inputSchema: { projectId },
});

const listDeliveryCandidates = readTool({
  name: "list_delivery_candidates",
  template: `${DELIVERY}/candidates`,
  capability: "viewClientPreview",
  description: "What may be published on a Project's Delivery page right now, in page order (photos, Floorplans, Copy documents, then each Video at its current Version): Asset id, kind, name, Video id, premium and unlocked state, and a Video's Review status. 404 while Client Delivery is off for the Project.",
  inputSchema: { projectId },
});

/** A read on a POST route: the Preview route writes nothing (it only builds the page the selection would make). */
const previewDelivery: McpTool = {
  name: "preview_delivery",
  description: "Preview a proposed Publish: the Delivery page as the client would see it with these Assets in this order and this cover, without publishing anything. Item handles in the result are throwaway and differ on every call. Refuses an Asset that cannot be on the page (invalid_selection, with the ids) or a cover that is not a selected photo (invalid_cover).",
  scope: "read",
  capability: "viewClientPreview",
  route: { method: "POST", template: PREVIEW },
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { projectId, assetIds, coverAssetId },
  call: async (ctx, input) => jsonResult(await previewOf(ctx, String(input.projectId), { assetIds: input.assetIds as string[], coverAssetId: (input.coverAssetId as string | null | undefined) ?? null })),
};

type PreviewBody = { dto: DeliveryPageDto; titles: Record<string, string> };
type PublishSummary = {
  project: { street: string };
  page: { path: string; enabled: boolean; latestSetNumber: number } | null;
  nextSet: { setNumber: number; coverAssetId: string | null; items: { assetId: string; kind: string; label: string; title: string | null; locked: boolean; premium: boolean }[] };
};
type SummaryRead = { ok: true; summary: PublishSummary } | { ok: false; result: McpToolResult };

/**
 * What the next Published set will contain, from the page read and a Preview of the selection. Preview keeps the selection's order (item `i`
 * is `assetIds[i]`), so each item is named by its Asset id. Built in a fixed key order with no handle, URL or timestamp, so the same page and
 * selection always hash the same.
 */
async function readPublishSummary(ctx: McpToolContext, project: string, selection: string[], cover: string | null): Promise<SummaryRead> {
  const stateResponse = await dispatchToApi(ctx.fetchApp, ctx.env, ctx.executionCtx, ctx.principal, { method: "GET", path: pathOf(DELIVERY, project) });
  if (!stateResponse.ok) return { ok: false, result: await jsonResult(stateResponse) };
  // The page read has passed the gate and the Project visibility; an archived Project is refused here, as the Publish route refuses it,
  // so the first call mints no token for a Publish the route would never accept.
  if (await projectIsArchived(ctx.env, project)) return { ok: false, result: text(`HTTP 409: ${JSON.stringify(PUBLISH_ARCHIVED_BODY)}`, true) };
  const state = (await stateResponse.json()) as DeliveryState;
  const previewResponse = await previewOf(ctx, project, { assetIds: selection, coverAssetId: cover });
  if (!previewResponse.ok) return { ok: false, result: await jsonResult(previewResponse) };
  const { dto, titles } = (await previewResponse.json()) as PreviewBody;
  return {
    ok: true,
    summary: {
      project: { street: dto.property.street },
      page: state.page ? { path: state.page.path, enabled: state.page.enabled, latestSetNumber: state.page.latestSetNumber } : null,
      nextSet: {
        setNumber: dto.setNumber,
        coverAssetId: cover,
        items: dto.items.map((item, index) => ({ assetId: selection[index]!, kind: item.kind, label: item.label, title: titles[item.handle] ?? null, locked: item.locked, premium: item.premium })),
      },
    },
  };
}

const publishDelivery: McpTool = {
  name: "publish_delivery",
  description: "Publish a Project's Delivery page: the client sees exactly these Assets, in this order, as the next Published set. Two steps. Call with projectId, assetIds and optional coverAssetId: nothing is published, and you get a 'Confirmation required' summary of what the next set will contain (each item, which are locked premium extras, the cover, whether this is the first Publish) plus a confirmToken. Show that summary to the user, and only if they agree call again with the same arguments plus confirm: true and that confirmToken (valid 5 minutes, for this Project and this connection). If the page or the selection changed in between you are asked to re-confirm. The first Publish creates the page and moves the Project to Delivered, which notifies the team. Archived Projects refuse (project_archived).",
  scope: "write",
  capability: "publish",
  route: { method: "POST", template: PUBLISH },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  inputSchema: {
    projectId,
    assetIds,
    coverAssetId,
    confirm: z.boolean().optional().describe("true only after the user has seen the summary and agreed. Never set it on the first call."),
    confirmToken: z.string().optional().describe("The confirmToken the first call returned. Required with confirm: true."),
  },
  call: async (ctx, input) => {
    const project = String(input.projectId);
    const selection = input.assetIds as string[];
    const cover = (input.coverAssetId as string | null | undefined) ?? null;
    return signedConfirm<PublishSummary>(ctx, input, {
      action: "publish", tool: "publish_delivery", projectId: project, feature: "Publish",
      firstCall: "without confirm", again: "without confirm", changed: { what: "Delivery page or the selection", verb: "published" },
      summarize: async () => { const read = await readPublishSummary(ctx, project, selection, cover); return read.ok ? { ok: true, summary: read.summary, canonical: JSON.stringify(read.summary) } : read; },
      propose: (summary, token) => {
        const lockedCount = summary.nextSet.items.filter((item) => item.locked).length;
        const willPublish = {
          ...token,
          project: { id: project, street: summary.project.street },
          page: summary.page,
          firstPublish: summary.page === null,
          nextSet: { ...summary.nextSet, itemCount: summary.nextSet.items.length, lockedCount },
          consequences: summary.page === null
            ? "The first Publish creates the client's Delivery page and moves the Project to Delivered, which notifies the team."
            : `Set ${summary.nextSet.setNumber} replaces set ${summary.page.latestSetNumber} as what the client sees${summary.page.enabled ? "" : " (the page is currently switched off, so the client sees nothing until an Admin switches it on)"}.`,
        };
        return text(`Confirmation required: publishing shows these ${summary.nextSet.items.length} item(s) to the client on "${summary.project.street}". Show the user what the next set will contain, and only if they agree call publish_delivery again with the same arguments, confirm: true and this confirmToken.\n${JSON.stringify(willPublish, null, 2)}`);
      },
      act: async (summary, confirmToken) => {
        // The operation id is derived from the token, so a retried confirmed call is the route's replay, never a second set.
        const operationId = `mcp-${(await sha256Hex(confirmToken)).slice(0, 48)}`;
        return jsonResult(await dispatchToApi(ctx.fetchApp, ctx.env, ctx.executionCtx, ctx.principal, {
          method: "POST",
          path: pathOf(PUBLISH, project),
          body: { assetIds: selection, coverAssetId: cover, expectedLatestSet: summary.page?.latestSetNumber ?? null, operationId },
        }));
      },
    });
  },
};

const setDeliveryPageEnabled = writeTool({
  name: "set_delivery_page_enabled",
  scope: "admin",
  method: "PUT",
  template: `${DELIVERY}/page`,
  capability: "switchDeliveryPage",
  idempotent: true,
  description: "Admin: switch a Project's client Delivery page on or off. Off hides the page from the client without unpublishing anything; on shows the latest Published set again. Refused with no_page before the first Publish. Returns the page as get_delivery_page does.",
  inputSchema: { projectId, enabled: z.boolean().describe("true shows the page to the client, false hides it.") },
});

export const DELIVERY_TOOLS: readonly McpTool[] = [getDeliveryPage, listDeliveryCandidates, previewDelivery, publishDelivery, setDeliveryPageEnabled];
