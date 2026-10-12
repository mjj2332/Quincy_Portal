import type { Context, Hono } from "hono";
import { DELIVERY_SLUG_PATTERN as SLUG_PATTERN, DELIVERY_ZIP_MAX_BYTES, DELIVERY_ZIP_MAX_PHOTOS, deliveryZipManifestSchema, deliveryZipPrepareInputSchema, deliveryZipPrepareResponseSchema, enqueueDeliveryDerivativesSafely, type DeliveryZipSize } from "@quincy/shared";
import type { AppEnv } from "../env";
import { attachment } from "../guest/download";
import { INVALID, TOO_LARGE, guestNotFound, guestRoute, originRejection, readJson, tooMany } from "../guest/http";
import { GUEST_LIMITS, clientAddress, ipBucket, reserveAttempts, windowStart } from "../guest/rate-limit";
import { clientDeliveryGateSql } from "../lib/client-delivery-gate";
import { leftOutNotice, readZipSet, zipArchiveName, zipArchiveState, zipAuthorizer, type ZipSet } from "../lib/delivery-zip";
import { newId } from "../lib/ids";
import { assessZip, objectEntry, type ZipAssessment } from "../lib/object-crc";
import { nativeZipResponse, planNativeZip, type NativeZipEntry } from "../lib/zip-native";
import { admitPage, rawPath, slugOk } from "./admit";

/**
 * The photo zips of the public Client Delivery page (#787 slice 7), docs/plans/787-7.md:
 * - `GET  /d/api/pages/:slug/zips/:size`: the manifest, read-only (never queues work).
 * - `POST /d/api/pages/:slug/zips/:size/prepare`: queues what is missing (CRC-32s, Web-size derivatives) and says where that stands.
 * - `GET  /d/api/pages/:slug/zips/:size/photos.zip`: the archive, native writer only, exact Content-Length.
 * `size` is `web` or `full`; anything else, and every miss, is the `/d` stub. Every answer carries the guest hygiene headers.
 */
export const deliveryZipTestHooks: { beforeStream?: () => Promise<void> } = {};

const PREFIX = `^/d/api/pages/(${SLUG_PATTERN})/zips/(web|full)`;
const MANIFEST_PATH = new RegExp(`${PREFIX}$`);
const PREPARE_PATH = new RegExp(`${PREFIX}/prepare$`);
const FILE_PATH = new RegExp(`${PREFIX}/photos\\.zip$`);
const PREPARE_BODY_MAX = 1024;
const ZIP_HEADERS = { "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cross-origin-resource-policy": "same-origin" } as const;

type Ctx = Context<AppEnv, string>;
const plain = (c: Ctx) => c as unknown as Context<AppEnv>;
type Page = { projectId: string; setId: string; setNumber: number };

/** A check is a manifest read or a zip GET that will HEAD every object: spent before the first HEAD. */
async function spend(c: Ctx, kind: "dlcheck" | "dlprep" | "dlzip", projectId: string, limits: { ip: number; page: number }, now: number): Promise<Response | null> {
  const address = await ipBucket(kind, clientAddress(c.req.raw), windowStart(now));
  const spent = await reserveAttempts(c.env.DB, [{ bucket: address, limit: limits.ip }, { bucket: `${kind}:page:${projectId}`, limit: limits.page }], now);
  return spent.limited ? tooMany(spent.retryAfterSeconds) : null;
}
const CHECK = { ip: GUEST_LIMITS.deliveryCheckIp, page: GUEST_LIMITS.deliveryCheckPage };

const assess = (c: Ctx, set: ZipSet, source: string, enqueue: "never" | "when_blocked" | "always", headWhenOff?: boolean): Promise<ZipAssessment | null> =>
  set.entries.length === 0 ? Promise.resolve(null) : assessZip(c.env, set.entries.map((entry) => entry.subject), { source, enqueue, nativeOnly: true, ...(headWhenOff === undefined ? {} : { headWhenOff }) });

/** The page is still the one admitted: on, its gate open, and the same set. Anything else is a miss. */
async function stillThere(c: Ctx, slug: string, page: Page): Promise<boolean> {
  const again = await admitPage(c.env.DB, slug);
  return again !== null && again.projectId === page.projectId && again.setNumber === page.setNumber;
}

async function manifest(c: Ctx, slug: string, size: DeliveryZipSize): Promise<Response> {
  const page = await admitPage(c.env.DB, slug); if (!page) return guestNotFound(plain(c));
  const set = await readZipSet(c.env.DB, page.setId, size);
  let assessed: ZipAssessment | null = null;
  if (set.count > 0 && !set.tooLarge && set.entries.length > 0) {
    const limited = await spend(c, "dlcheck", page.projectId, CHECK, Date.now()); if (limited) return limited;
    assessed = await assess(c, set, "delivery-zip-manifest", "never", false);
  }
  await deliveryZipTestHooks.beforeStream?.();
  if (!await stillThere(c, slug, page)) return guestNotFound(plain(c));
  return c.json(deliveryZipManifestSchema.parse({
    size, setNumber: page.setNumber, photos: set.count, totalBytes: set.totalBytes, tooLarge: set.tooLarge,
    leftOut: set.leftOut.map((label) => ({ label, reason: "premium_locked" as const })), archive: zipArchiveState(set, assessed),
  }));
}

/**
 * `POST .../prepare`, in this order: the page is admitted (a miss is the stub and the body and Origin are never looked at), the bounded body is READ, Origin + JSON (403), the prepare buckets are reserved (429, so an
 * invalid body is charged to them), the body is judged (413, 400), the set is read (409 `nothing_to_download`, 422), then the missing CRC-32s are queued and, for Web-size, the missing derivatives are queued again.
 * It streams nothing, writes no audit row and never spends a zip start.
 */
async function prepare(c: Ctx, slug: string, size: DeliveryZipSize): Promise<Response> {
  const page = await admitPage(c.env.DB, slug); if (!page) return guestNotFound(plain(c));
  const raw = await readJson(plain(c), PREPARE_BODY_MAX);
  const rejected = originRejection(plain(c)); if (rejected) return rejected;
  const limited = await spend(c, "dlprep", page.projectId, { ip: GUEST_LIMITS.deliveryPrepareIp, page: GUEST_LIMITS.deliveryPreparePage }, Date.now()); if (limited) return limited;
  if (raw === TOO_LARGE) return c.json({ error: "payload_too_large" }, 413);
  if (raw === INVALID || !deliveryZipPrepareInputSchema.safeParse(raw).success) return c.json({ error: "invalid_request" }, 400);
  const set = await readZipSet(c.env.DB, page.setId, size);
  if (set.count === 0) return c.json({ error: "nothing_to_download" }, 409);
  if (set.tooLarge) return c.json({ error: "zip_too_large", maxPhotos: DELIVERY_ZIP_MAX_PHOTOS, maxBytes: DELIVERY_ZIP_MAX_BYTES }, 422);
  if (set.missing.length > 0) await enqueueDeliveryDerivativesSafely(c.env, set.missing, "delivery-zip-prepare");
  const assessed = await assess(c, set, "delivery-zip-prepare", "always");
  if (!await stillThere(c, slug, page)) return guestNotFound(plain(c));
  return c.json(deliveryZipPrepareResponseSchema.parse(zipArchiveState(set, assessed)));
}

/** Records the start of a zip, fenced in SQL on everything the stream will rely on. Zero rows changed means the page, its gate or its set moved since admission. */
async function auditStart(c: Ctx, slug: string, page: Page, size: DeliveryZipSize, set: ZipSet, now: number): Promise<boolean> {
  const meta = JSON.stringify({ via: "public_delivery", size, setNumber: page.setNumber, count: set.entries.length, totalBytes: set.totalBytes });
  const written = await c.env.DB.prepare(`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?1, NULL, 'delivery.download_all', 'project', p.project_id, ?2, ?3 FROM delivery_pages p JOIN delivery_sets s ON s.project_id = p.project_id AND s.set_number = p.latest_set_number
      WHERE p.slug = ?4 AND p.enabled = 1 AND s.set_number = ?5 AND ${clientDeliveryGateSql("p.project_id")}`).bind(newId(), meta, now, slug, page.setNumber).run();
  return written.meta.changes === 1;
}

/**
 * `GET .../photos.zip`, in this order: path -> page admitted (a miss is the stub) -> HEAD 405 / Range 416 (no side effects) -> the set is read, so the lock is settled before R2 (409 `nothing_to_download`, 422)
 * -> the check buckets (429) -> the gate (502 `download_unavailable`, 409 `download_preparing` + Retry-After) -> the page is admitted again, same set -> the archive is planned -> the start buckets (429) -> the
 * audit row -> the stream. Preparing and refusals never spend a start.
 */
async function photosZip(c: Ctx, slug: string, size: DeliveryZipSize): Promise<Response> {
  const page = await admitPage(c.env.DB, slug); if (!page) return guestNotFound(plain(c));
  if (c.req.method === "HEAD") return c.json({ error: "method_not_allowed" }, 405, { allow: "GET" });
  if (c.req.header("range") !== undefined) return c.json({ error: "range_not_satisfiable" }, 416);
  const set = await readZipSet(c.env.DB, page.setId, size);
  if (set.count === 0) return c.json({ error: "nothing_to_download" }, 409);
  if (set.tooLarge) return c.json({ error: "zip_too_large", maxPhotos: DELIVERY_ZIP_MAX_PHOTOS, maxBytes: DELIVERY_ZIP_MAX_BYTES }, 422);
  if (set.entries.length > 0) { const limited = await spend(c, "dlcheck", page.projectId, CHECK, Date.now()); if (limited) return limited; }
  const assessed = await assess(c, set, "delivery-zip", "when_blocked");
  if (assessed?.kind === "unavailable" || assessed?.kind === "too_large" || assessed?.kind === "legacy") return c.json({ error: "download_unavailable" }, 502);
  const state = zipArchiveState(set, assessed);
  if (state.state === "preparing") return c.json({ error: "download_preparing", pending: state.pending, retryAfterSeconds: state.retryAfterSeconds }, 409, { "retry-after": String(state.retryAfterSeconds) });
  if (assessed?.kind !== "native") return c.json({ error: "download_unavailable" }, 502);
  await deliveryZipTestHooks.beforeStream?.();
  if (!await stillThere(c, slug, page)) return guestNotFound(plain(c));
  const notice = leftOutNotice(set.leftOut);
  const entries: NativeZipEntry[] = set.entries.map((entry) => objectEntry(entry.name, entry.subject.r2Key, assessed.ready));
  if (notice) entries.push({ name: "Left out.txt", data: notice });
  // Plan before the audit row, so an archive that cannot be built leaves no audit row behind it.
  const planned = planNativeZip({ bucket: c.env.MEDIA, entries, authorize: zipAuthorizer(c.env.DB, slug, page.setNumber, new Map(set.entries.map((entry) => [entry.subject.r2Key, entry.assetId]))) });
  const now = Date.now();
  const started = await spend(c, "dlzip", page.projectId, { ip: GUEST_LIMITS.deliveryZipIp, page: GUEST_LIMITS.deliveryZipPage }, now); if (started) return started;
  if (!await auditStart(c, slug, page, size, set, now)) return guestNotFound(plain(c));
  return nativeZipResponse(planned.open(), (promise) => c.executionCtx.waitUntil(promise), { ...ZIP_HEADERS, "content-disposition": attachment(zipArchiveName(slug, size)) });
}

export function mountDeliveryZips(app: Hono<AppEnv>): void {
  const match = (pattern: RegExp, c: Ctx) => { const found = pattern.exec(rawPath(c)); return found && slugOk(found[1]) ? { slug: found[1], size: found[2] as DeliveryZipSize } : null; };
  app.get("/d/api/pages/:slug/zips/:size", guestRoute("/d/api/pages/:slug/zips/:size", (c) => { const m = match(MANIFEST_PATH, c); return m ? manifest(c, m.slug, m.size) : guestNotFound(plain(c)); }));
  app.post("/d/api/pages/:slug/zips/:size/prepare", guestRoute("/d/api/pages/:slug/zips/:size/prepare", (c) => { const m = match(PREPARE_PATH, c); return m ? prepare(c, m.slug, m.size) : guestNotFound(plain(c)); }));
  app.get("/d/api/pages/:slug/zips/:size/photos.zip", guestRoute("/d/api/pages/:slug/zips/:size/photos.zip", (c) => { const m = match(FILE_PATH, c); return m ? photosZip(c, m.slug, m.size) : guestNotFound(plain(c)); }));
}
