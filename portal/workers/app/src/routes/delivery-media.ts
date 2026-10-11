import { Hono, type Context } from "hono";
import { z } from "zod";
import { createDb, schema } from "@quincy/db";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env";
import { terminalRoute } from "../lib/terminal-route";
import { readEligibleAssets } from "../lib/delivery-dto";
import { lockedSql } from "../lib/delivery-lock";
import { RENDITION_VARIANT_SPEC } from "@quincy/shared";
import { LIVE_VERSION, LIVE_VIDEO, versionIsLive } from "../lib/video-live-sql";
import { VIDEO_STREAM_HEADERS, serveR2Object } from "../lib/r2-serve";
import { serveAssetRendition, serveVideoPoster } from "./media";
import { admitDelivery } from "./delivery";

const uuid = z.string().uuid();
const HANDLE = /^[a-z0-9]{16}$/;

/**
 * Staff media for the Delivery tab (#787 slice 5). Both families admit through `admitDelivery` (Client Delivery gate, `viewClientPreview`, Project access) and need NOT pass the Video Review
 * gate, which guards Review links and the Video tab, not this page. An archived Project still serves.
 * - `items/:handle/{media,thumb}`: an item of the page's CURRENT set, by its handle. A superseded Asset that is still a member is served, which `/media/asset/:id/:variant` refuses.
 * - `preview-media/:assetId/{media,thumb}`: an unpublished selection, by Asset id, under the same eligibility as Publish.
 * `media` is a photo's web size, a PDF's original, or a Video's stream (Range, HEAD); `thumb` is a photo's thumbnail or a Video's poster, and 404 for a PDF.
 */
export const deliveryMediaRoutes = new Hono<AppEnv>();
type Ctx = Context<AppEnv>;
/** These `/api` routes sit outside `/media`'s cache default, so a refusal would carry no Cache-Control. Anything not already marked is `private, no-store`. Per route, not `.use(...)`, which leaks across sibling mounts. */
async function withNoStoreDefault(response: Response): Promise<Response> {
  if (response.headers.has("cache-control")) return response;
  const marked = new Response(response.body, response);
  marked.headers.set("cache-control", "private, no-store");
  return marked;
}
const notFound = (c: Ctx) => c.json({ error: "Not found" }, 404);

/** A locked photo is shown to staff as the client sees it: the watermarked `premium_preview`, else nothing. Never its web, thumb or original. */
async function servePremiumPreview(c: Ctx, assetId: string): Promise<Response> {
  const row = await c.env.DB.prepare("SELECT r2_key AS r2Key, content_type AS contentType FROM asset_renditions WHERE asset_id = ?1 AND variant = 'premium_preview' AND spec_version = ?2")
    .bind(assetId, RENDITION_VARIANT_SPEC.premium_preview).first<{ r2Key: string; contentType: string }>();
  if (!row || (row.contentType !== "image/jpeg" && row.contentType !== "image/webp")) return notFound(c);
  const object = await c.env.MEDIA.get(row.r2Key);
  if (!object || object.httpMetadata?.contentType !== row.contentType) return notFound(c);
  return new Response(object.body, { headers: { "content-type": row.contentType, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-length": String(object.size) } });
}

async function serveAsset(c: Ctx, projectId: string, assetId: string, part: "media" | "thumb"): Promise<Response> {
  const asset = await createDb(c.env.DB).select().from(schema.assets).where(eq(schema.assets.id, assetId)).get();
  if (!asset) return notFound(c);
  const lock = await c.env.DB.prepare(`SELECT ${lockedSql("a")} AS locked FROM assets a WHERE a.id = ?1`).bind(assetId).first<{ locked: number }>();
  if (lock?.locked === 1) return asset.kind === "photo" ? servePremiumPreview(c, assetId) : notFound(c);
  if (asset.kind === "photo") return serveAssetRendition(c, asset, part === "media" ? "web" : "thumb");
  if (asset.kind === "floorplan_pdf" || asset.kind === "copy_pdf") return part === "media" ? serveAssetRendition(c, asset, "original") : notFound(c);
  if (asset.kind !== "video") return notFound(c);
  const video = await c.env.DB.prepare(`SELECT a.r2_key AS r2Key, m.poster_key AS posterKey FROM assets a JOIN video_version_meta m ON m.asset_id = a.id JOIN videos v ON v.id = m.video_id
      WHERE a.id = ?1 AND v.project_id = ?2 AND ${LIVE_VERSION("m")} AND ${LIVE_VIDEO("v")}`).bind(assetId, projectId).first<{ r2Key: string; posterKey: string | null }>();
  if (!video) return notFound(c);
  const live = () => versionIsLive(c.env.DB, projectId, assetId);
  if (part === "media") return serveR2Object(c, video.r2Key, { ...VIDEO_STREAM_HEADERS }, "Video object not found", live);
  return video.posterKey ? serveVideoPoster(c, video.posterKey, live) : c.json({ error: "Poster not found" }, 404);
}

function itemRoute(part: "media" | "thumb") {
  const path = `/projects/:projectId/delivery/items/:handle/${part}`;
  deliveryMediaRoutes.get(path, terminalRoute(path, async (c) => withNoStoreDefault(await (async () => {
    const projectId = (c.req.param("projectId") ?? "");
    if (!uuid.safeParse(projectId).success) return c.json({ error: "Invalid id" }, 400);
    const refused = await admitDelivery(c, projectId, "viewClientPreview", false); if (refused) return refused;
    const handle = (c.req.param("handle") ?? "");
    if (!HANDLE.test(handle)) return notFound(c);
    const row = await c.env.DB.prepare(`SELECT i.asset_id AS assetId FROM delivery_set_items i JOIN delivery_sets s ON s.id = i.set_id
        JOIN delivery_pages p ON p.project_id = s.project_id AND p.latest_set_number = s.set_number WHERE s.project_id = ?1 AND i.handle = ?2`).bind(projectId, handle).first<{ assetId: string }>();
    return row ? serveAsset(c, projectId, row.assetId, part) : notFound(c);
  })())));
}
function previewRoute(part: "media" | "thumb") {
  const path = `/projects/:projectId/delivery/preview-media/:assetId/${part}`;
  deliveryMediaRoutes.get(path, terminalRoute(path, async (c) => withNoStoreDefault(await (async () => {
    const projectId = (c.req.param("projectId") ?? ""); const assetId = (c.req.param("assetId") ?? "");
    if (!uuid.safeParse(projectId).success || !uuid.safeParse(assetId).success) return c.json({ error: "Invalid id" }, 400);
    const refused = await admitDelivery(c, projectId, "viewClientPreview", false); if (refused) return refused;
    if (!(await readEligibleAssets(c.env.DB, projectId, [assetId])).has(assetId)) return notFound(c);
    return serveAsset(c, projectId, assetId, part);
  })())));
}
itemRoute("media"); itemRoute("thumb"); previewRoute("media"); previewRoute("thumb");
