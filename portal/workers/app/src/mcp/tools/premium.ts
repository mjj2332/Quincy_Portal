import { z } from "zod";
import { VIDEO_PAYMENT_REF_MAX, type Capability } from "@quincy/shared";
import { findVideo, videoPublished } from "../../lib/video-approval";
import { findPremiumAsset } from "../../lib/asset-premium";
import { LIVE_VIDEO } from "../../lib/video-live-sql";
import { text, writeTool, type McpTool, type McpToolContext } from "./define";
import { confirmInput, requireConfirm, signedConfirm } from "./confirm";

/**
 * Premium and Unlock (#969), for a Video from the Video review routes and from the Delivery tab's routes, and for a photo or document.
 * Every tool dispatches to one cookie route, which does everything it does for the browser (gate, capability, Project visibility,
 * archived, the `premium_published` refusal of an unmark, audit). Two steps are added here, because the routes have none:
 *
 * - Late Premium: marking an item that is already on a published Client Delivery page (after which it stays premium for good) returns
 *   `Confirmation required` and changes nothing unless the call carries `confirm: true`.
 * - Unlock: the first call unlocks nothing and returns a summary of what becomes viewable and downloadable in full plus a confirm token
 *   (action `unlock`, 5 minutes, this Project and connection, over the summary's hash); only the second call with that token unlocks.
 *   Re-lock (`unlocked: false`) needs neither.
 *
 * Both steps read the item's state from D1 with the routes' own lookups. Only Admins and Editors hold `manageVideoPremium` and
 * `manageExtras`, and both see every Project (`viewAllProjects`), so the confirmation tells them nothing the routes would not.
 */

const projectId = z.string().uuid().describe("The Project's id.");
const videoId = z.string().uuid().describe("The Video's id (`id` in list_project_videos).");
const assetId = z.string().uuid().describe("The photo's or document's Asset id (from list_project_assets).");
const premium = z.boolean().describe("true marks it Premium (a paid extra, locked on the Client Delivery page until Unlocked); false unmarks it.");
const unlocked = z.boolean().describe("true Unlocks it (two steps, see the description); false Re-locks it.");
const paymentRef = z.string().trim().min(1).max(VIDEO_PAYMENT_REF_MAX).optional().describe("Optional payment reference recorded with an Unlock.");
const confirmToken = z.string().optional().describe("The confirmToken the first Unlock call returned. Required with confirm: true when unlocking.");

const UNLOCK_ACTION = "unlock";

/** What an item looks like right now, read from D1 with the routes' own lookups. Null when it is not an item of this Project. */
type ItemState = { kind: string; id: string; label: string; premium: boolean; unlocked: boolean; paymentRef: string | null; onPublishedPage: boolean };
type Item = { noun: string; key: "videoId" | "assetId"; idInput: z.ZodTypeAny; read: (ctx: McpToolContext, project: string, id: string) => Promise<ItemState | null> };

const VIDEO: Item = {
  noun: "Video",
  key: "videoId",
  idInput: videoId,
  read: async (ctx, project, id) => {
    const video = await findVideo(ctx.env.DB, project, id);
    if (!video) return null;
    const title = (await ctx.env.DB.prepare(`SELECT v.title FROM videos v WHERE v.id = ?1 AND ${LIVE_VIDEO("v")}`).bind(id).first<{ title: string | null }>())?.title ?? "";
    return { kind: "video", id, label: title, premium: video.premium, unlocked: video.unlocked, paymentRef: video.paymentRef, onPublishedPage: await videoPublished(ctx.env.DB, id) };
  },
};
const ASSET: Item = {
  noun: "Asset",
  key: "assetId",
  idInput: assetId,
  read: async (ctx, project, id) => {
    const asset = await findPremiumAsset(ctx.env.DB, project, id);
    if (!asset) return null;
    const name = (await ctx.env.DB.prepare("SELECT original_filename FROM assets WHERE id = ?1").bind(id).first<{ original_filename: string | null }>())?.original_filename ?? "";
    return { kind: asset.kind, id, label: name, premium: asset.premium, unlocked: asset.unlocked, paymentRef: asset.paymentRef, onPublishedPage: asset.published };
  },
};

function premiumTool(def: { name: string; description: string; template: string; capability: Capability; item: Item }): McpTool {
  const base = writeTool({
    name: def.name, description: def.description, method: "PUT", template: def.template, capability: def.capability, idempotent: true,
    inputSchema: { projectId, [def.item.key]: def.item.idInput, premium, confirm: confirmInput },
  });
  return {
    ...base,
    call: async (ctx, input) => {
      const project = String(input.projectId); const id = String(input[def.item.key]);
      if (input.premium === true) {
        const state = await def.item.read(ctx, project, id);
        const late = state !== null && !state.premium && state.onPublishedPage;
        const refused = late ? requireConfirm(input, `this ${def.item.noun} is already on a published Client Delivery page, so once marked Premium it stays premium for good: it can then only be Unlocked or Re-locked, never unmarked, and the client sees it locked until it is Unlocked`) : null;
        if (refused) return refused;
      }
      return base.call(ctx, { projectId: project, [def.item.key]: id, premium: input.premium });
    },
  };
}

/** Canonical summary: fixed key order, strings, booleans and null only, so the same item and request hash the same. */
const canonical = (state: ItemState, ref: string | null) => JSON.stringify([state.kind, state.id, state.label, state.premium, state.unlocked, state.paymentRef, state.onPublishedPage, ref]);

function unlockTool(def: { name: string; description: string; template: string; capability: Capability; item: Item }): McpTool {
  const base = writeTool({
    name: def.name, description: def.description, method: "PUT", template: def.template, capability: def.capability, idempotent: true,
    inputSchema: { projectId, [def.item.key]: def.item.idInput, unlocked, paymentRef, confirm: confirmInput, confirmToken },
  });
  return {
    ...base,
    call: async (ctx, input) => {
      const project = String(input.projectId); const id = String(input[def.item.key]);
      const ref = typeof input.paymentRef === "string" ? input.paymentRef.trim() : null;
      const forward = () => base.call(ctx, { projectId: project, [def.item.key]: id, unlocked: input.unlocked, ...(ref !== null && input.unlocked === true ? { paymentRef: ref } : {}) });
      if (input.unlocked !== true) return forward();

      return signedConfirm<ItemState>(ctx, input, {
        action: UNLOCK_ACTION, tool: def.name, projectId: project, feature: "Unlock",
        firstCall: "with unlocked: true", again: "without confirm", changed: { what: def.item.noun, verb: "unlocked" },
        summarize: async () => {
          const state = await def.item.read(ctx, project, id);
          return state ? { ok: true, summary: state, canonical: canonical(state, ref) } : { ok: false, result: text(`${def.item.noun} not found in this Project.`, true) };
        },
        propose: (state, token) => {
          const summary = {
            ...token,
            willBecomeViewableAndDownloadableInFull: { kind: state.kind, id: state.id, label: state.label, premium: state.premium, unlocked: state.unlocked, onPublishedPage: state.onPublishedPage },
            paymentRef: ref,
            effect: "The client can view and download it in full on the Client Delivery page, without the Premium lock, until it is Re-locked.",
          };
          return text(`Confirmation required: Unlocking "${state.label}" makes it viewable and downloadable in full by the client. Show the user this summary, and only if they agree call ${def.name} again with confirm: true and this confirmToken.\n${JSON.stringify(summary, null, 2)}`);
        },
        act: forward,
      });
    },
  };
}

const PREMIUM_DESC = (what: string) => `Mark ${what} Premium (a paid extra the client sees locked on the Client Delivery page) or unmark it. Unmarking is refused (premium_published) once it has been on a published page. Marking one that is already on a published page returns 'Confirmation required' (it then stays premium for good) and changes nothing until called again with confirm: true.`;
const UNLOCK_DESC = (what: string, tool: string) => `Unlock ${what} (unlocked: true), so the client can view and download it in full, or Re-lock it (unlocked: false, one step). Unlock is two steps. Call ${tool} with unlocked: true and no confirm: nothing is unlocked, and you get a 'Confirmation required' summary plus a confirmToken. Show the summary to the user, and only if they agree call again with the same arguments plus confirm: true and that confirmToken (valid 5 minutes, this Project and this connection). If the item changed in between you are asked to re-confirm.`;

const setVideoPremium = premiumTool({ name: "set_video_premium", template: "/api/projects/:projectId/videos/:videoId/premium", capability: "manageVideoPremium", item: VIDEO, description: `${PREMIUM_DESC("a Video")} Video review route; set_delivery_video_premium is the same from the Delivery tab.` });
const setVideoUnlock = unlockTool({ name: "set_video_premium_unlock", template: "/api/projects/:projectId/videos/:videoId/premium-unlock", capability: "manageVideoPremium", item: VIDEO, description: `${UNLOCK_DESC("a Premium Video", "set_video_premium_unlock")} Video review route.` });
const setDeliveryVideoPremium = premiumTool({ name: "set_delivery_video_premium", template: "/api/projects/:projectId/delivery/videos/:videoId/premium", capability: "manageVideoPremium", item: VIDEO, description: `${PREMIUM_DESC("a Video")} Delivery tab route (open while Client Delivery is on).` });
const setDeliveryVideoUnlock = unlockTool({ name: "set_delivery_video_premium_unlock", template: "/api/projects/:projectId/delivery/videos/:videoId/premium-unlock", capability: "manageVideoPremium", item: VIDEO, description: `${UNLOCK_DESC("a Premium Video", "set_delivery_video_premium_unlock")} Delivery tab route.` });
const setAssetPremium = premiumTool({ name: "set_asset_premium", template: "/api/projects/:projectId/assets/:assetId/delivery-premium", capability: "manageExtras", item: ASSET, description: `${PREMIUM_DESC("a photo, Floorplan PDF or Copy document")} Not for Videos (use set_video_premium).` });
const setAssetUnlock = unlockTool({ name: "set_asset_premium_unlock", template: "/api/projects/:projectId/assets/:assetId/delivery-premium-unlock", capability: "manageExtras", item: ASSET, description: UNLOCK_DESC("a Premium photo, Floorplan PDF or Copy document", "set_asset_premium_unlock") });

export const PREMIUM_TOOLS: readonly McpTool[] = [setVideoPremium, setVideoUnlock, setDeliveryVideoPremium, setDeliveryVideoUnlock, setAssetPremium, setAssetUnlock];
