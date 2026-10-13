import { Hono, type Context } from "hono";
import { roleHasCapability, socialOverlayFieldSchemas, socialOverlayPatchInput, socialOverlayRevisionInput } from "@quincy/shared";
import { z } from "zod";
import type { AppEnv } from "../env";
import { terminalRoute } from "../lib/terminal-route";
import { newId } from "../lib/ids";
import { discardUnreferencedObject, settleThrownAdoption } from "../lib/embedded-media";
import { serveR2Object } from "../lib/r2-serve";
import {
  fencedAudit, getOverlay, inspectUpload, isUnique, listOverlays, nameTaken, overlayDto, overlayError, overlayKey, readOverlayForm, type OverlayError, type OverlayRow,
} from "../lib/social-overlays";
import { jsonInput } from "./helpers";

/**
 * The Social overlay library (#869). Admin only (`adminBackend`, 403 first, then 400 id, then the body). Create and replace write the PNG to a fresh R2 key, then one D1 batch (row plus a
 * `changes()`-fenced audit row), and delete the previous key only after that commits. A refused or thrown batch never deletes bytes a live row points at (`settleThrownAdoption`).
 */
const uuid = z.string().uuid();
const NAME_CONFLICT = /name_unique|social_overlays\.name/i;
const conflict = (c: Context<AppEnv>): Response => overlayError(c, { status: 409, code: "overlay_conflict", message: "Someone else changed this overlay. Reload and try again." });
const nameTakenResponse = (c: Context<AppEnv>): Response => overlayError(c, { status: 409, code: "name_taken", message: "An overlay with that name already exists." });
const forbidden = (c: Context<AppEnv>): Response | null => roleHasCapability(c.get("user").role, "adminBackend") ? null : c.json({ error: "Forbidden", capability: "adminBackend" }, 403);
const respond = (c: Context<AppEnv>, row: OverlayRow, status: 200 | 201 = 200): Response => c.json({ overlay: overlayDto(row) }, status);
const fieldErrors = (c: Context<AppEnv>, fields: Record<string, string>): { name: string; platformLabel: string } | Response => {
  const name = socialOverlayFieldSchemas.name.safeParse(fields.name), platformLabel = socialOverlayFieldSchemas.platformLabel.safeParse(fields.platformLabel);
  if (!name.success || !platformLabel.success) return overlayError(c, { status: 400, code: "invalid_input", message: "Give the overlay a name (up to 80 characters) and a platform (up to 40)." });
  return { name: name.data, platformLabel: platformLabel.data };
};
const revisionOf = (fields: Record<string, string>): number | null => /^[1-9]\d{0,9}$/.test(fields.expectedRevision ?? "") ? Number(fields.expectedRevision) : null;
const asError = (value: unknown): value is OverlayError => typeof value === "object" && value !== null && "code" in value && "status" in value;

export const socialOverlayAdminRoutes = new Hono<AppEnv>();

socialOverlayAdminRoutes.get("/admin/social-overlays", terminalRoute("/admin/social-overlays", async (c) => {
  const denied = forbidden(c); if (denied) return denied;
  return c.json({ overlays: (await listOverlays(c.env.DB)).map(overlayDto) });
}));

socialOverlayAdminRoutes.post("/admin/social-overlays", terminalRoute("/admin/social-overlays", async (c) => {
  const denied = forbidden(c); if (denied) return denied;
  const form = await readOverlayForm(c); if (asError(form)) return overlayError(c, form);
  const fields = fieldErrors(c, form.fields); if (fields instanceof Response) return fields;
  const size = inspectUpload(form.image); if (asError(size)) return overlayError(c, size);
  if (await nameTaken(c.env.DB, fields.name, null)) return nameTakenResponse(c);
  const user = c.get("user"), id = newId(), key = overlayKey(id, crypto.randomUUID()), now = Date.now();
  await c.env.MEDIA.put(key, form.image!, { httpMetadata: { contentType: "image/png" } });
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO social_overlays (id, name, platform_label, image_key, image_rev, width, height, bytes, is_default, created_by, updated_by, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, CASE WHEN NOT EXISTS (SELECT 1 FROM social_overlays WHERE is_default = 1) THEN 1 ELSE 0 END, ?8, ?8, ?9, ?9)`)
        .bind(id, fields.name, fields.platformLabel, key, size.width, size.height, form.image!.byteLength, user.id, now),
      fencedAudit(c.env, user, "social_overlay.create", id, { name: fields.name, platformLabel: fields.platformLabel, width: size.width, height: size.height, bytes: form.image!.byteLength, revision: 1 }, now),
    ]);
  } catch (error) {
    if (isUnique(error, NAME_CONFLICT)) { await discardUnreferencedObject(c.env, key, null); return nameTakenResponse(c); }
    const outcome = await settleThrownAdoption(c.env, { key, projectId: null, mediaId: id, what: "Social overlay", error, isAdopted: async () => (await getOverlay(c.env.DB, id))?.image_key === key });
    if (outcome !== "adopted") throw error;
  }
  return respond(c, (await getOverlay(c.env.DB, id))!, 201);
}));

socialOverlayAdminRoutes.patch("/admin/social-overlays/:id", terminalRoute("/admin/social-overlays/:id", async (c) => {
  const denied = forbidden(c); if (denied) return denied;
  const id = c.req.param("id"); if (!uuid.safeParse(id).success) return overlayError(c, { status: 400, code: "invalid_id", message: "Invalid overlay id." });
  const data = await jsonInput(c, socialOverlayPatchInput); if (data instanceof Response) return data;
  const row = await getOverlay(c.env.DB, id); if (!row) return overlayError(c, { status: 404, code: "not_found", message: "Overlay not found." });
  const name = data.name ?? row.name, platformLabel = data.platformLabel ?? row.platform_label;
  if (name === row.name && platformLabel === row.platform_label) return respond(c, row);
  if (row.image_rev !== data.expectedRevision) return conflict(c);
  if (name !== row.name && await nameTaken(c.env.DB, name, id)) return nameTakenResponse(c);
  const user = c.get("user"), now = Date.now();
  let results: D1Result[];
  try {
    results = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE social_overlays SET name = ?1, platform_label = ?2, image_rev = image_rev + 1, updated_by = ?3, updated_at = ?4 WHERE id = ?5 AND image_rev = ?6")
        .bind(name, platformLabel, user.id, now, id, data.expectedRevision),
      fencedAudit(c.env, user, "social_overlay.rename", id, { from: { name: row.name, platformLabel: row.platform_label }, to: { name, platformLabel }, revision: data.expectedRevision + 1 }, now),
    ]);
  } catch (error) {
    if (isUnique(error, NAME_CONFLICT)) return nameTakenResponse(c);
    throw error;
  }
  if (results[0]!.meta.changes === 0) return conflict(c);
  return respond(c, (await getOverlay(c.env.DB, id))!);
}));

socialOverlayAdminRoutes.post("/admin/social-overlays/:id/image", terminalRoute("/admin/social-overlays/:id/image", async (c) => {
  const denied = forbidden(c); if (denied) return denied;
  const id = c.req.param("id"); if (!uuid.safeParse(id).success) return overlayError(c, { status: 400, code: "invalid_id", message: "Invalid overlay id." });
  const form = await readOverlayForm(c); if (asError(form)) return overlayError(c, form);
  const expected = revisionOf(form.fields); if (expected === null) return overlayError(c, { status: 400, code: "invalid_input", message: "expectedRevision is required." });
  const row = await getOverlay(c.env.DB, id); if (!row) return overlayError(c, { status: 404, code: "not_found", message: "Overlay not found." });
  if (row.image_rev !== expected) return conflict(c);
  const size = inspectUpload(form.image); if (asError(size)) return overlayError(c, size);
  const user = c.get("user"), key = overlayKey(id, crypto.randomUUID()), now = Date.now();
  await c.env.MEDIA.put(key, form.image!, { httpMetadata: { contentType: "image/png" } });
  let results: D1Result[];
  try {
    results = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE social_overlays SET image_key = ?1, width = ?2, height = ?3, bytes = ?4, image_rev = image_rev + 1, updated_by = ?5, updated_at = ?6 WHERE id = ?7 AND image_rev = ?8")
        .bind(key, size.width, size.height, form.image!.byteLength, user.id, now, id, expected),
      fencedAudit(c.env, user, "social_overlay.replace_image", id, { width: size.width, height: size.height, bytes: form.image!.byteLength, previousBytes: row.bytes, revision: expected + 1 }, now),
    ]);
  } catch (error) {
    const outcome = await settleThrownAdoption(c.env, { key, projectId: null, mediaId: id, what: "Social overlay", error, isAdopted: async () => (await getOverlay(c.env.DB, id))?.image_key === key });
    if (outcome !== "adopted") throw error;
    results = [];
  }
  if (results.length && results[0]!.meta.changes === 0) { await discardUnreferencedObject(c.env, key, null); return conflict(c); }
  await discardUnreferencedObject(c.env, row.image_key, null);
  return respond(c, (await getOverlay(c.env.DB, id))!);
}));

function setArchived(archive: boolean) {
  const path = archive ? "/admin/social-overlays/:id/archive" : "/admin/social-overlays/:id/unarchive";
  return terminalRoute(path, async (c) => {
    const denied = forbidden(c); if (denied) return denied;
    const id = c.req.param("id"); if (!uuid.safeParse(id).success) return overlayError(c, { status: 400, code: "invalid_id", message: "Invalid overlay id." });
    const data = await jsonInput(c, socialOverlayRevisionInput); if (data instanceof Response) return data;
    const row = await getOverlay(c.env.DB, id); if (!row) return overlayError(c, { status: 404, code: "not_found", message: "Overlay not found." });
    if (archive && row.is_default === 1) return overlayError(c, { status: 409, code: "default_overlay", message: "The Default overlay cannot be archived." });
    if ((row.archived_at !== null) === archive) return respond(c, row);
    if (row.image_rev !== data.expectedRevision) return conflict(c);
    const user = c.get("user"), now = Date.now();
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE social_overlays SET archived_at = ?1, archived_by = ?2, image_rev = image_rev + 1, updated_by = ?3, updated_at = ?4
        WHERE id = ?5 AND image_rev = ?6 AND is_default = 0 AND archived_at IS ${archive ? "NULL" : "NOT NULL"}`)
        .bind(archive ? now : null, archive ? user.id : null, user.id, now, id, data.expectedRevision),
      fencedAudit(c.env, user, archive ? "social_overlay.archive" : "social_overlay.unarchive", id, { name: row.name, revision: data.expectedRevision + 1 }, now),
    ]);
    if (results[0]!.meta.changes === 0) return conflict(c);
    return respond(c, (await getOverlay(c.env.DB, id))!);
  });
}
socialOverlayAdminRoutes.post("/admin/social-overlays/:id/archive", setArchived(true));
socialOverlayAdminRoutes.post("/admin/social-overlays/:id/unarchive", setArchived(false));

/**
 * The one image URL (#869), public on purpose: generic platform graphics with no client data, so staff and guests share it and it is cacheable. The URL names the image uuid, which changes on
 * every replace, so a current URL is immutable. Only the row's CURRENT key is served (archived overlays included). Anything else is a no-store JSON 404, never the SPA shell.
 */
const IMAGE_HEADERS = {
  "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox", "cross-origin-resource-policy": "same-origin",
} as const;
const imageMiss = (): Response => new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store" } });

export function mountSocialOverlayImages(app: Hono<AppEnv>): void {
  app.get("/social-overlay-images/:overlayId/:imageUuid", terminalRoute("/social-overlay-images/:overlayId/:imageUuid", async (c) => {
    const overlayId = c.req.param("overlayId"), imageUuid = c.req.param("imageUuid");
    if (!uuid.safeParse(overlayId).success || !uuid.safeParse(imageUuid).success) return imageMiss();
    const key = overlayKey(overlayId, imageUuid);
    const row = await c.env.DB.prepare("SELECT 1 AS hit FROM social_overlays WHERE id = ?1 AND image_key = ?2").bind(overlayId, key).first();
    if (!row) return imageMiss();
    const response = await serveR2Object(c, key, IMAGE_HEADERS, "Not found");
    if (response.status === 404) { await response.body?.cancel(); return imageMiss(); }
    return response;
  }));
  app.all("/social-overlay-images", terminalRoute("/social-overlay-images", () => imageMiss()));
  app.all("/social-overlay-images/*", terminalRoute("/social-overlay-images/*", () => imageMiss()));
}
