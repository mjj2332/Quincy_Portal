import type { Context, Hono } from "hono";
import { DELIVERY_HANDLE_LENGTH, DELIVERY_SLUG_PATTERN as SLUG_PATTERN, DELIVERY_SLUG_SUFFIX_LENGTH, DELIVERY_UNLOCK_NOTIFICATION_EVENT, RENDITION_VARIANT_SPEC, deliveryPageDtoSchema, isDeliveryPagePath, deliveryUnlockRequestInputSchema, deliveryUnlockSourceKey, rawMediaContentType, type DeliveryItemKind } from "@quincy/shared";
import type { AppEnv } from "../env";
import { clientDeliveryGate } from "../lib/client-delivery-gate";
import { deliveryLabels, readDeliveryState, readSetRows, type DeliveryUrlResolver } from "../lib/delivery-dto";
import { newId } from "../lib/ids";
import { lockedSql } from "../lib/delivery-lock";
import { LIVE_VERSION, LIVE_VERSION_EXISTS, LIVE_VIDEO } from "../lib/video-live-sql";
import { VIDEO_STREAM_HEADERS, serveR2Object } from "../lib/r2-serve";
import { attachment } from "../guest/download";
import { INVALID, TOO_LARGE, guestNotFound, guestRoute, originRejection, readJson, tooMany } from "../guest/http";
import { GUEST_DAY_MS, GUEST_LIMITS, clientAddress, ipBucket, reserveAttempts, windowStart } from "../guest/rate-limit";
import { publishUnlockOutbox, unlockItemBucket, writeUnlockRequest } from "../lib/delivery-unlock-request";
import { guestShell } from "../guest";
import { admitPage, rawPath, slugOk } from "./admit";
import { mountDeliveryZips } from "./zips";

/**
 * The public Client Delivery page (#787 slice 6): no session, no cookie, no staff principal (`test/delivery-public-boundary.guard.test.ts` scans this directory). It shares a Worker with the staff app and
 * nothing else, and mounts after the Review routes and before the `/d` stubs.
 * - `GET /d/:slug`: the SPA shell for ANY well-formed slug, so the shell is never an oracle for whether a page exists.
 * - `GET /d/api/pages/:slug`: the strict DTO of the page's LATEST set, with handle URLs.
 * - `GET /d/api/pages/:slug/items/:handle/{media,thumb,download}`: one item. GET, HEAD and Range alike.
 * - `POST /d/api/pages/:slug/items/:handle/unlock-request` (slice 8): a client asks for ONE locked item to be unlocked. It only notifies staff; see `requestUnlock`.
 * Every miss (malformed path, unknown slug, page off, Client Delivery gate shut, stale handle, a Video no longer live, a derivative that is not there) is `guestNotFound`: the same bytes as the `/d/*` fallback.
 * The slug is matched on the RAW path segment: no decoding, trailing slash or extra segment is normalised into a match. Every response is `private, no-store` with the guest hygiene headers.
 */
export const publicDeliveryTestHooks: { beforeServe?: () => Promise<void>; beforeWrite?: () => Promise<void>; afterWrite?: () => Promise<void>; beforeVerify?: () => Promise<void> } = {};

const HANDLE_PATTERN = `[a-z0-9]{${DELIVERY_HANDLE_LENGTH}}`;
const PAGE_PATH = new RegExp(`^/d/api/pages/(${SLUG_PATTERN})$`);
const ITEM_PATH = new RegExp(`^/d/api/pages/(${SLUG_PATTERN})/items/(${HANDLE_PATTERN})/(media|thumb|download)$`);
const UNLOCK_PATH = new RegExp(`^/d/api/pages/(${SLUG_PATTERN})/items/(${HANDLE_PATTERN})/unlock-request$`);
/** The request body is `{}`; anything over this is refused without being read further. */
const UNLOCK_BODY_MAX = 1024;

type Ctx = Context<AppEnv, string>;
type ItemFacts = { projectId: string; setId: string; setNumber: number; assetId: string; assetKind: string; r2Key: string; originalFilename: string; locked: boolean };

/**
 * One item of the page's LATEST set by handle, with its live lock state. A Video Version that is not live (#776, Trash) is not there; a locked answer is read in the same statement as the rest,
 * so admission and lock can never disagree. Called again as the last admission, just before the first byte.
 */
async function admitItem(db: D1Database, slug: string, handle: string): Promise<ItemFacts | null> {
  const row = await db.prepare(`SELECT p.project_id AS projectId, s.id AS setId, s.set_number AS setNumber, a.id AS assetId, a.kind AS assetKind, a.r2_key AS r2Key, a.original_filename AS originalFilename, ${lockedSql("a")} AS locked
      FROM delivery_pages p JOIN delivery_sets s ON s.project_id = p.project_id AND s.set_number = p.latest_set_number
      JOIN delivery_set_items i ON i.set_id = s.id JOIN assets a ON a.id = i.asset_id
      WHERE p.slug = ?1 AND p.enabled = 1 AND i.handle = ?2 AND a.kind IN ('photo', 'floorplan_pdf', 'copy_pdf', 'video') AND (a.kind <> 'video' OR ${LIVE_VERSION_EXISTS("a.id")})`)
    .bind(slug, handle).first<Omit<ItemFacts, "locked"> & { locked: number }>();
  if (!row || !await clientDeliveryGate(db, row.projectId)) return null;
  return { ...row, locked: row.locked === 1 };
}

/** Handle URLs under this page. A locked item that has no safe image (a Video, a PDF) has no URL at all, not a link that would answer 403. */
const publicUrls = (slug: string): DeliveryUrlResolver => (row) => {
  const base = `/d/api/pages/${slug}/items/${row.handle}`;
  if (row.locked && row.kind !== "photo") return { url: null, thumbUrl: null };
  return { url: `${base}/media`, thumbUrl: row.kind === "photo" || row.kind === "video" ? `${base}/thumb` : null };
};

type Derivative = { r2Key: string; contentType: string };
/** A stored derivative at the variant's current spec, or null. There is no fallback to any other object. */
async function derivative(c: Ctx, assetId: string, variant: "delivery_web" | "premium_preview" | "thumb"): Promise<Derivative | null> {
  const row = await c.env.DB.prepare("SELECT r2_key AS r2Key, content_type AS contentType FROM asset_renditions WHERE asset_id = ?1 AND variant = ?2 AND spec_version = ?3")
    .bind(assetId, variant, RENDITION_VARIANT_SPEC[variant]).first<Derivative>();
  if (!row || (row.contentType !== "image/jpeg" && row.contentType !== "image/webp")) return null;
  const head = await c.env.MEDIA.head(row.r2Key);
  return head && head.httpMetadata?.contentType === row.contentType ? row : null;
}
async function posterKey(c: Ctx, assetId: string): Promise<string | null> {
  const row = await c.env.DB.prepare(`SELECT m.poster_key AS posterKey FROM video_version_meta m JOIN videos v ON v.id = m.video_id WHERE m.asset_id = ?1 AND ${LIVE_VERSION("m")} AND ${LIVE_VIDEO("v")}`).bind(assetId).first<{ posterKey: string | null }>();
  return row?.posterKey ?? null;
}

const OBJECT_HEADERS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" } as const;
const IMAGE_HEADERS = { ...OBJECT_HEADERS, "content-security-policy": "default-src 'none'; sandbox" } as const;
const locked = (c: Ctx): Response => c.json({ error: "premium_locked" }, 403);

/** The name a client sees: the address part of the slug and the item's label ("12-test-street-photo-01.jpg"). Never the stored filename, which can hold a person's name. */
function publicFileName(slug: string, label: string, extension: string): string {
  return `${slug.slice(0, -(DELIVERY_SLUG_SUFFIX_LENGTH + 1))}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.${extension}`;
}
type Original = { contentType: string; extension: string; headers: Record<string, string> };
function originalOf(kind: DeliveryItemKind, filename: string): Original {
  if (kind === "floorplan" || kind === "copy") return { contentType: "application/pdf", extension: "pdf", headers: OBJECT_HEADERS };
  if (kind === "video") return { contentType: "video/mp4", extension: "mp4", headers: { ...VIDEO_STREAM_HEADERS } };
  const contentType = rawMediaContentType(filename) ?? "image/jpeg";
  const extension = contentType === "image/jpeg" ? "jpg" : (/\.([A-Za-z0-9]{1,5})$/.exec(filename)?.[1]?.toLowerCase() ?? "bin");
  return { contentType, extension, headers: IMAGE_HEADERS };
}
const KIND_OF_ASSET: Record<string, DeliveryItemKind> = { photo: "photo", floorplan_pdf: "floorplan", copy_pdf: "copy", video: "video" };

async function serveItem(c: Ctx, slug: string, handle: string, part: "media" | "thumb" | "download"): Promise<Response> {
  const item = await admitItem(c.env.DB, slug, handle);
  if (!item) return guestNotFound(c);
  const kind = KIND_OF_ASSET[item.assetKind]!;
  let key: string; let headers: Record<string, string>;
  if (part === "download") {
    // The lock is read before any R2 call: GET, HEAD and Range all answer the same 403.
    if (item.locked) return locked(c);
    const original = originalOf(kind, item.originalFilename);
    const rows = await readSetRows(c.env.DB, item.setId); const position = rows.findIndex((row) => row.assetId === item.assetId);
    const label = deliveryLabels(rows)[position];
    if (position < 0 || label === undefined) return guestNotFound(c);
    key = item.r2Key; headers = { ...original.headers, "content-type": original.contentType, "content-disposition": attachment(publicFileName(slug, label, original.extension)) };
  } else if (kind === "photo") {
    const row = await derivative(c, item.assetId, item.locked ? "premium_preview" : part === "media" ? "delivery_web" : "thumb");
    if (!row) return guestNotFound(c);
    key = row.r2Key; headers = { ...IMAGE_HEADERS, "content-type": row.contentType };
  } else if (item.locked) {
    return part === "thumb" && kind !== "video" ? guestNotFound(c) : locked(c);
  } else if (kind === "video") {
    if (part === "media") { key = item.r2Key; headers = { ...VIDEO_STREAM_HEADERS }; }
    else { const poster = await posterKey(c, item.assetId); if (!poster) return guestNotFound(c); key = poster; headers = { ...IMAGE_HEADERS, "content-type": "image/jpeg" }; }
  } else {
    // A PDF has no thumbnail; its media is the document, shown inline under a generated name.
    if (part === "thumb") return guestNotFound(c);
    const rows = await readSetRows(c.env.DB, item.setId); const label = deliveryLabels(rows)[rows.findIndex((row) => row.assetId === item.assetId)];
    if (label === undefined) return guestNotFound(c);
    key = item.r2Key; headers = { ...OBJECT_HEADERS, "content-type": "application/pdf", "content-disposition": attachment(publicFileName(slug, label, "pdf")).replace(/^attachment/, "inline") };
  }
  await publicDeliveryTestHooks.beforeServe?.();
  // The last admission, after R2 has answered and before a header or byte leaves: the page still on, the item still in the latest set, a Video still live, and what is being sent still allowed by the lock now.
  const sentUnlocked = !item.locked;
  const authorize = async (): Promise<boolean> => {
    const again = await admitItem(c.env.DB, slug, handle);
    return again !== null && again.assetId === item.assetId && !(sentUnlocked && again.locked);
  };
  const response = await serveR2Object(c as unknown as Context<AppEnv>, key, headers, "Not found", authorize);
  return response.status === 404 ? guestNotFound(c) : response;
}

/**
 * `POST .../items/:handle/unlock-request`, in this order (docs/plans/787.md section 1): the item resolves through the same admission as a read (any miss, the body and the Origin NOT looked at,
 * is the stub), the bounded body is READ (not judged), a fresh time is taken and the item admitted again, Origin and content type (403), the item must be locked (409 `not_locked`), the address
 * and page buckets are reserved (429, so an invalid body is charged to them), the body is judged (400, 413), then the write: one fenced batch (`lib/delivery-unlock-request.ts`) that also takes the item's daily slot, so the slot and the request land together or not at all (no pre-batch reservation, no refund).
 * When it lands nothing the answer is the state found: the stub, `not_locked`, or 202 `already_requested` when the slot was taken.
 */
async function unlockLanded(db: D1Database, auditId: string): Promise<boolean> {
  await publicDeliveryTestHooks.beforeVerify?.();
  return (await db.prepare("SELECT 1 AS present FROM audit_log WHERE id = ?").bind(auditId).first()) !== null;
}

async function requestUnlock(c: Ctx, slug: string, handle: string): Promise<Response> {
  const item = await admitItem(c.env.DB, slug, handle);
  if (!item) return guestNotFound(c);
  const raw = await readJson(c as unknown as Context<AppEnv>, UNLOCK_BODY_MAX);
  const now = Date.now();
  const current = await admitItem(c.env.DB, slug, handle);
  if (!current || current.assetId !== item.assetId) return guestNotFound(c);
  const rejected = originRejection(c as unknown as Context<AppEnv>); if (rejected) return rejected;
  if (!current.locked) return c.json({ error: "not_locked" }, 409);
  const address = await ipBucket("unlock", clientAddress(c.req.raw), windowStart(now));
  const spent = await reserveAttempts(c.env.DB, [{ bucket: address, limit: GUEST_LIMITS.unlockIp }, { bucket: `unlock:page:${current.projectId}`, limit: GUEST_LIMITS.unlockPage, windowMs: GUEST_DAY_MS }], now);
  if (spent.limited) return tooMany(spent.retryAfterSeconds);
  if (raw === TOO_LARGE) return c.json({ error: "payload_too_large" }, 413);
  if (raw === INVALID || !deliveryUnlockRequestInputSchema.safeParse(raw).success) return c.json({ error: "invalid_request" }, 400);
  // The item's daily slot is NOT reserved here: it is taken inside the write batch, with the audit and outbox rows, so it lands with the request or not at all (lib/delivery-unlock-request.ts).
  const auditId = newId();
  try {
    await publicDeliveryTestHooks.beforeWrite?.();
    const rows = await readSetRows(c.env.DB, current.setId);
    const label = deliveryLabels(rows)[rows.findIndex((row) => row.assetId === current.assetId)];
    if (label === undefined) return guestNotFound(c);
    const written = await writeUnlockRequest(c.env.DB, { auditId, slug, handle, projectId: current.projectId, setId: current.setId, setNumber: current.setNumber, assetId: current.assetId, label, ipBucket: address, now });
    await publicDeliveryTestHooks.afterWrite?.();
    if (written.landed) {
      if (written.outboxIds.length) c.executionCtx.waitUntil(publishUnlockOutbox(c.env.NOTIFICATION_QUEUE, c.env.DB, written.outboxIds));
      return c.json({ status: "requested" }, 202);
    }
  } catch (error) {
    // A throw does not say whether D1 committed (the reply can be lost after the batch landed). The attempt's own audit row does: present, the request landed (its slot is in the same batch) and staff are told once;
    // absent, nothing was stored (a rolled-back batch takes its slot with it). A check that cannot be read fails the request; a retry then answers from what is stored.
    if (!(await unlockLanded(c.env.DB, auditId).catch(() => false))) throw error;
    const pending = await c.env.DB.prepare("SELECT id FROM notification_outbox WHERE event_type = ? AND source_key = ? AND status = 'pending'").bind(DELIVERY_UNLOCK_NOTIFICATION_EVENT, deliveryUnlockSourceKey(auditId)).all<{ id: string }>().then((rows) => rows.results.map((row) => row.id)).catch(() => []);
    if (pending.length) c.executionCtx.waitUntil(publishUnlockOutbox(c.env.NOTIFICATION_QUEUE, c.env.DB, pending));
    return c.json({ status: "requested" }, 202);
  }
  // The fence wrote nothing: the page, the gate, the set or the lock changed since admission, or the item's slot is already taken today. Answer what is true now.
  const after = await admitItem(c.env.DB, slug, handle);
  if (!after || after.assetId !== current.assetId) return guestNotFound(c);
  if (!after.locked) return c.json({ error: "not_locked" }, 409);
  const taken = await c.env.DB.prepare("SELECT 1 AS taken FROM guest_rate_limits WHERE bucket = ? AND window_start = ?").bind(unlockItemBucket(current.assetId), windowStart(now, GUEST_DAY_MS)).first();
  return taken ? c.json({ status: "already_requested" }, 202) : guestNotFound(c);
}

export function mountDelivery(app: Hono<AppEnv>): void {
  mountDeliveryZips(app);
  app.get("/d/:slug", guestRoute("/d/:slug", (c) => (isDeliveryPagePath(rawPath(c)) ? guestShell(c) : guestNotFound(c))));

  app.get("/d/api/pages/:slug", guestRoute("/d/api/pages/:slug", async (c) => {
    const match = PAGE_PATH.exec(rawPath(c)); const slug = match?.[1];
    if (!slugOk(slug)) return guestNotFound(c);
    const page = await admitPage(c.env.DB, slug); if (!page) return guestNotFound(c);
    const state = await readDeliveryState(c.env.DB, page.projectId, { urls: publicUrls(slug) });
    await publicDeliveryTestHooks.beforeServe?.();
    // The page was read after admission: if it was switched off, the gate shut or a newer set published meanwhile, it is a miss, not a stale page.
    const again = await admitPage(c.env.DB, slug);
    if (!state.dto || !again || again.setNumber !== state.dto.setNumber) return guestNotFound(c);
    return c.json(deliveryPageDtoSchema.parse(state.dto));
  }));

  app.post("/d/api/pages/:slug/items/:handle/unlock-request", guestRoute("/d/api/pages/:slug/items/:handle/unlock-request", (c) => {
    const match = UNLOCK_PATH.exec(rawPath(c));
    if (!match || !slugOk(match[1])) return guestNotFound(c);
    return requestUnlock(c, match[1], match[2]!);
  }));

  for (const part of ["media", "thumb", "download"] as const) {
    const path = `/d/api/pages/:slug/items/:handle/${part}`;
    app.get(path, guestRoute(path, (c) => {
      const match = ITEM_PATH.exec(rawPath(c));
      if (!match || !slugOk(match[1]) || match[3] !== part) return guestNotFound(c);
      return serveItem(c, match[1], match[2]!, part);
    }));
  }
}
