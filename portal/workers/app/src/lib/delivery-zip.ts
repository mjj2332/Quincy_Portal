import { DELIVERY_SLUG_SUFFIX_LENGTH, DELIVERY_ZIP_MAX_BYTES, DELIVERY_ZIP_MAX_PHOTOS, RENDITION_VARIANT_SPEC, rawMediaContentType, type DeliveryZipArchive, type DeliveryZipSize } from "@quincy/shared";
import { clientDeliveryGateSql } from "./client-delivery-gate";
import { deliveryLabels, readSetRows } from "./delivery-dto";
import { lockedSql } from "./delivery-lock";
import { ZIP_RETRY_AFTER_SECONDS, type CrcSubject, type ZipAssessment } from "./object-crc";
import type { NativeZipEntry } from "./zip-native";

/**
 * The data side of the public photo zips (#787 slice 7): which photos a zip holds, under what names, and whether the archive can be served now. Everything is read from D1 before any R2 call, and the
 * names are public labels only ("Photo 07.jpg"): never an id, an R2 key or the stored filename, which can hold a person's name.
 */
export type ZipPhoto = { assetId: string; label: string; name: string; subject: CrcSubject };
export type ZipSet = {
  size: DeliveryZipSize;
  /** The unlocked photos of the page's current set, whether or not their Web-size derivative exists yet. */
  count: number;
  /** The photos that have bytes to put in the archive now, in published order. */
  entries: ZipPhoto[];
  /** Web-size only: unlocked photos whose current-spec derivative is missing or not an image. */
  missing: string[];
  /** Public labels of the photos left out because they are locked premium, in published order. */
  leftOut: string[];
  totalBytes: number;
  tooLarge: boolean;
};

/** The extension a Full-res entry keeps: `jpg` for a JPEG, otherwise the original's own safe extension. */
export function photoExtension(filename: string): string {
  const contentType = rawMediaContentType(filename) ?? "image/jpeg";
  return contentType === "image/jpeg" ? "jpg" : (/\.([A-Za-z0-9]{1,5})$/.exec(filename)?.[1]?.toLowerCase() ?? "bin");
}

/** "12-test-street-photos-web-size.zip": the address part of the slug, never the suffix. */
export function zipArchiveName(slug: string, size: DeliveryZipSize): string {
  return `${slug.slice(0, -(DELIVERY_SLUG_SUFFIX_LENGTH + 1))}-photos-${size === "web" ? "web-size" : "full-res"}.zip`;
}

type AssetFacts = { id: string; r2Key: string; bytes: number; filename: string };
type Rendition = { assetId: string; r2Key: string; bytes: number; contentType: string };

/**
 * The photos of one set (`setId`), labelled before anything is excluded so the numbers are stable, split into what the zip holds and what is left out. The lock is read here, in D1, before any R2 call.
 * Web-size streams the current-spec `delivery_web` derivative and never the original: a photo without one is `missing`, not substituted and not dropped.
 */
export async function readZipSet(db: D1Database, setId: string, size: DeliveryZipSize): Promise<ZipSet> {
  const rows = await readSetRows(db, setId); const labels = deliveryLabels(rows);
  const photos = rows.map((row, index) => ({ row, label: labels[index]! })).filter(({ row }) => row.kind === "photo");
  const leftOut = photos.filter(({ row }) => row.locked).map(({ label }) => label);
  const open = photos.filter(({ row }) => !row.locked);
  const ids = JSON.stringify(open.map(({ row }) => row.assetId));
  const facts = open.length === 0 ? [] : (await db.prepare("SELECT id, r2_key AS r2Key, bytes, original_filename AS filename FROM assets WHERE id IN (SELECT value FROM json_each(?1)) AND kind = 'photo'").bind(ids).all<AssetFacts>()).results;
  const factsOf = new Map(facts.map((fact) => [fact.id, fact]));
  const renditions = size === "web" && open.length > 0
    ? (await db.prepare("SELECT asset_id AS assetId, r2_key AS r2Key, bytes, content_type AS contentType FROM asset_renditions WHERE variant = 'delivery_web' AND spec_version = ?2 AND asset_id IN (SELECT value FROM json_each(?1))")
      .bind(ids, RENDITION_VARIANT_SPEC.delivery_web).all<Rendition>()).results
    : [];
  const renditionOf = new Map(renditions.map((rendition) => [rendition.assetId, rendition]));
  const entries: ZipPhoto[] = []; const missing: string[] = [];
  for (const { row, label } of open) {
    const original = factsOf.get(row.assetId);
    if (!original) continue;
    if (size === "full") { entries.push({ assetId: row.assetId, label, name: `${label}.${photoExtension(original.filename)}`, subject: { r2Key: original.r2Key, bytes: original.bytes } }); continue; }
    const rendition = renditionOf.get(row.assetId);
    const extension = rendition?.contentType === "image/jpeg" ? "jpg" : rendition?.contentType === "image/webp" ? "webp" : null;
    if (!rendition || extension === null) { missing.push(row.assetId); continue; }
    entries.push({ assetId: row.assetId, label, name: `${label}.${extension}`, subject: { r2Key: rendition.r2Key, bytes: rendition.bytes } });
  }
  const count = entries.length + missing.length;
  const totalBytes = entries.reduce((total, entry) => total + entry.subject.bytes, 0);
  return { size, count, entries, missing, leftOut, totalBytes, tooLarge: count > DELIVERY_ZIP_MAX_PHOTOS || totalBytes > DELIVERY_ZIP_MAX_BYTES };
}

/** The gate's answer as the page sees it. A missing Web-size derivative keeps the archive `preparing` whatever else is ready. */
export function zipArchiveState(set: ZipSet, assessed: ZipAssessment | null): DeliveryZipArchive {
  if (set.count === 0) return { state: "ready", pending: 0 };
  if (set.tooLarge) return { state: "too_large", pending: 0 };
  if (assessed?.kind === "unavailable") return { state: "unavailable", pending: 0 };
  if (assessed?.kind === "too_large") return { state: "too_large", pending: 0 };
  const pending = set.missing.length + (assessed?.kind === "preparing" ? assessed.pending.length : 0);
  return pending > 0 ? { state: "preparing", pending, retryAfterSeconds: assessed?.kind === "preparing" ? assessed.retryAfterSeconds : ZIP_RETRY_AFTER_SECONDS } : { state: "ready", pending: 0 };
}

const REASON_TEXT = "premium photo, not unlocked yet";
/** `Left out.txt`: public labels only. Null when nothing is left out. */
export function leftOutNotice(labels: readonly string[]): Uint8Array | null {
  if (labels.length === 0) return null;
  return new TextEncoder().encode(`These photos are not in this download.\r\n\r\n${labels.map((label) => `- ${label}: ${REASON_TEXT}`).join("\r\n")}\r\n`);
}

/**
 * The writer's re-authorisation (`authorize` of `planNativeZip`): ONE D1 statement per check. The page is still on, its Client Delivery gate still open and its current set still `setNumber`; for an object entry the
 * asset is still in that set, still a photo and still not locked. A memory entry (the notice) and the trailer (`null`) re-check the page alone. Any failure aborts the stream.
 */
export function zipAuthorizer(db: D1Database, slug: string, setNumber: number, assetByKey: ReadonlyMap<string, string>): (entry: NativeZipEntry | null) => Promise<boolean> {
  const page = `FROM delivery_pages p JOIN delivery_sets s ON s.project_id = p.project_id AND s.set_number = p.latest_set_number`;
  const pageWhere = `p.slug = ?1 AND p.enabled = 1 AND s.set_number = ?2 AND ${clientDeliveryGateSql("p.project_id")}`;
  const pageOnly = `SELECT 1 AS ok ${page} WHERE ${pageWhere}`;
  const withAsset = `SELECT 1 AS ok ${page} JOIN delivery_set_items i ON i.set_id = s.id AND i.asset_id = ?3 JOIN assets a ON a.id = i.asset_id WHERE ${pageWhere} AND a.kind = 'photo' AND ${lockedSql("a")} = 0`;
  return async (entry) => {
    if (entry === null || "data" in entry) return (await db.prepare(pageOnly).bind(slug, setNumber).first()) !== null;
    const assetId = assetByKey.get(entry.r2Key);
    return assetId !== undefined && (await db.prepare(withAsset).bind(slug, setNumber, assetId).first()) !== null;
  };
}
