import { DELIVERY_ITEM_KINDS, type DeliveryItemKind, type DeliveryItemDto, type DeliveryPageDto, type DeliveryState } from "@quincy/shared";
import { lockedSql } from "./delivery-lock";
import { LIVE_VERSION, LIVE_VERSION_EXISTS } from "./video-live-sql";

/**
 * The Client Delivery page as data (#787 slice 5). One builder turns set rows into the strict DTO for staff Preview, the staff read and (slice 6) the public read; the caller supplies
 * the URL resolver, so the public page can point at handle-based routes and staff at routes behind their session. Nothing here emits an Asset id, an R2 key, an original filename or a
 * Video title: an item is a random handle, a kind and a label such as "Photo 07".
 */
export type DeliveryItemRow = { assetId: string; handle: string; position: number; kind: DeliveryItemKind; width: number | null; height: number | null; durationMs: number | null; locked: boolean };
export type DeliveryUrlResolver = (row: DeliveryItemRow) => { url: string | null; thumbUrl: string | null };

const KIND_LABEL: Record<DeliveryItemKind, string> = { photo: "Photo", floorplan: "Floorplan", copy: "Copy", video: "Video" };
const KIND_OF_ASSET: Record<string, DeliveryItemKind> = { photo: "photo", floorplan_pdf: "floorplan", copy_pdf: "copy", video: "video" };

/** The staff URLs of an item: behind the session, by Asset id. A Floorplan or Copy PDF is its original; a Video streams, with a poster. */
export const staffDeliveryUrls: DeliveryUrlResolver = (row) => {
  if (row.kind === "photo") return { url: `/media/asset/${row.assetId}/web`, thumbUrl: `/media/asset/${row.assetId}/thumb` };
  if (row.kind === "video") return { url: `/media/video/${row.assetId}`, thumbUrl: `/media/video/${row.assetId}/poster` };
  return { url: `/media/asset/${row.assetId}/original`, thumbUrl: null };
};

/** Labels count within a kind in page order and are zero-padded to the width of that kind's total, at least two ("Photo 07", "Photo 007"). */
export function deliveryLabels(rows: readonly Pick<DeliveryItemRow, "kind">[]): string[] {
  const totals = new Map<DeliveryItemKind, number>(); for (const row of rows) totals.set(row.kind, (totals.get(row.kind) ?? 0) + 1);
  const seen = new Map<DeliveryItemKind, number>();
  return rows.map((row) => {
    const ordinal = (seen.get(row.kind) ?? 0) + 1; seen.set(row.kind, ordinal);
    return `${KIND_LABEL[row.kind]} ${String(ordinal).padStart(Math.max(2, String(totals.get(row.kind)).length), "0")}`;
  });
}

export function buildDeliveryDto(input: { property: { street: string; suburb: string | null }; setNumber: number; publishedAt: number | null; coverHandle: string | null; rows: readonly DeliveryItemRow[]; urls: DeliveryUrlResolver }): DeliveryPageDto {
  const labels = deliveryLabels(input.rows);
  const items: DeliveryItemDto[] = input.rows.map((row, index) => ({
    handle: row.handle, kind: row.kind, label: labels[index]!, position: row.position, locked: row.locked,
    width: row.width, height: row.height, durationMs: row.durationMs, ...input.urls(row),
  }));
  return { property: { street: input.property.street, suburb: input.property.suburb }, setNumber: input.setNumber, publishedAt: input.publishedAt, coverHandle: input.coverHandle, items };
}

/** The Assets a Delivery set may hold, as a predicate over `assets a` joined to `collections c`: a current, ready photo of the Edited collection, a Floorplan or Copy PDF of its own collection, or a live Video Version. Never RAW, never a Floorplan preview. */
export const DELIVERY_ELIGIBLE_SQL = `a.superseded_at IS NULL AND a.publish_status = 'ready' AND (
    (a.kind = 'photo' AND c.kind = 'edited') OR (a.kind = 'floorplan_pdf' AND c.kind = 'floorplan') OR (a.kind = 'copy_pdf' AND c.kind = 'copy')
    OR (a.kind = 'video' AND c.kind = 'video' AND ${LIVE_VERSION_EXISTS("a.id")}))`;
const DURATION_SQL = `(SELECT vm.duration_ms FROM video_version_meta vm WHERE vm.asset_id = a.id AND ${LIVE_VERSION("vm")})`;

type AssetFacts = { assetId: string; assetKind: string; width: number | null; height: number | null; durationMs: number | null; locked: number };
const rowOf = (facts: AssetFacts, handle: string, position: number): DeliveryItemRow => ({ assetId: facts.assetId, handle, position, kind: KIND_OF_ASSET[facts.assetKind]!, width: facts.width, height: facts.height, durationMs: facts.durationMs, locked: facts.locked === 1 });

/** The eligible Assets among `assetIds` for a Project, by id. An id that is missing from the map is not eligible: unknown, another Project's, superseded, RAW, a preview, or not live. */
export async function readEligibleAssets(db: D1Database, projectId: string, assetIds: readonly string[]): Promise<Map<string, AssetFacts>> {
  const rows = (await db.prepare(`SELECT a.id AS assetId, a.kind AS assetKind, a.width AS width, a.height AS height, ${DURATION_SQL} AS durationMs, ${lockedSql("a")} AS locked
      FROM assets a JOIN collections c ON c.id = a.collection_id WHERE a.id IN (SELECT value FROM json_each(?1)) AND c.project_id = ?2 AND ${DELIVERY_ELIGIBLE_SQL}`)
    .bind(JSON.stringify(assetIds), projectId).all<AssetFacts>()).results;
  return new Map(rows.map((row) => [row.assetId, row]));
}

export type SelectionVerdict = { ok: true; rows: DeliveryItemRow[] } | { ok: false; reason: "invalid_selection"; assetIds: string[] } | { ok: false; reason: "invalid_cover" };
/** Checks a selection (every Asset eligible; the cover, when given, one of the selected photos) and returns its rows in the order given, each with a fresh handle from `newHandle`. */
export async function checkSelection(db: D1Database, projectId: string, assetIds: readonly string[], coverAssetId: string | null, newHandle: () => string): Promise<SelectionVerdict> {
  const eligible = await readEligibleAssets(db, projectId, assetIds);
  const invalid = assetIds.filter((id) => !eligible.has(id));
  if (invalid.length) return { ok: false, reason: "invalid_selection", assetIds: invalid };
  if (coverAssetId !== null && eligible.get(coverAssetId)?.assetKind !== "photo") return { ok: false, reason: "invalid_cover" };
  const handles = new Set<string>(); const rows = assetIds.map((id, position) => {
    let handle = newHandle(); while (handles.has(handle)) handle = newHandle(); handles.add(handle);
    return rowOf(eligible.get(id)!, handle, position);
  });
  return { ok: true, rows };
}

type StoredRow = AssetFacts & { handle: string; position: number };
/** The items of one set, in page order, with the live lock state. A Video Version that is no longer live is left out (the backstop for #776; a published one cannot be trashed). */
export async function readSetRows(db: D1Database, setId: string): Promise<DeliveryItemRow[]> {
  const rows = (await db.prepare(`SELECT i.asset_id AS assetId, i.handle AS handle, i.position AS position, a.kind AS assetKind, a.width AS width, a.height AS height, ${DURATION_SQL} AS durationMs, ${lockedSql("a")} AS locked
      FROM delivery_set_items i JOIN assets a ON a.id = i.asset_id WHERE i.set_id = ?1 AND (a.kind <> 'video' OR ${LIVE_VERSION_EXISTS("a.id")}) AND a.kind IN ('photo', 'floorplan_pdf', 'copy_pdf', 'video') ORDER BY i.position`)
    .bind(setId).all<StoredRow>()).results;
  return rows.map((row) => rowOf(row, row.handle, row.position));
}

const STATE_KINDS: readonly string[] = DELIVERY_ITEM_KINDS;
/**
 * The staff read of a Project's Delivery page: the page, the set (the latest, or the numbered one for a replayed Publish) with the Asset behind each handle, and the page as a viewer sees
 * it. Everything is null before the first Publish.
 */
export async function readDeliveryState(db: D1Database, projectId: string, options: { setNumber?: number; urls?: DeliveryUrlResolver } = {}): Promise<DeliveryState> {
  const page = await db.prepare("SELECT slug, enabled, latest_set_number AS latestSetNumber FROM delivery_pages WHERE project_id = ?1").bind(projectId).first<{ slug: string; enabled: number; latestSetNumber: number }>();
  if (!page) return { page: null, set: null, dto: null };
  const set = await db.prepare("SELECT id, set_number AS setNumber, cover_asset_id AS coverAssetId, published_at AS publishedAt FROM delivery_sets WHERE project_id = ?1 AND set_number = ?2")
    .bind(projectId, options.setNumber ?? page.latestSetNumber).first<{ id: string; setNumber: number; coverAssetId: string | null; publishedAt: number }>();
  const pageState = { slug: page.slug, path: `/d/${page.slug}`, enabled: page.enabled === 1, latestSetNumber: page.latestSetNumber };
  if (!set) return { page: pageState, set: null, dto: null };
  const rows = await readSetRows(db, set.id);
  const project = (await db.prepare("SELECT street, suburb FROM projects WHERE id = ?1").bind(projectId).first<{ street: string; suburb: string | null }>())!;
  const coverHandle = rows.find((row) => row.assetId === set.coverAssetId)?.handle ?? null;
  const dto = buildDeliveryDto({ property: project, setNumber: set.setNumber, publishedAt: set.publishedAt, coverHandle, rows, urls: options.urls ?? staffDeliveryUrls });
  const items = rows.map((row, index) => ({ assetId: row.assetId, handle: row.handle, kind: row.kind, label: dto.items[index]!.label, position: row.position, locked: row.locked })).filter((item) => STATE_KINDS.includes(item.kind));
  return { page: pageState, set: { setNumber: set.setNumber, publishedAt: set.publishedAt, coverAssetId: set.coverAssetId, items }, dto };
}

/** Preview: the page as it would be if this selection were published next. Reads only; handles are fresh and never stored. `invalid` carries the refusal. */
export async function previewDelivery(db: D1Database, projectId: string, assetIds: readonly string[], coverAssetId: string | null, newHandle: () => string, urls: DeliveryUrlResolver = staffDeliveryUrls): Promise<{ ok: true; dto: DeliveryPageDto } | Exclude<SelectionVerdict, { ok: true }>> {
  const verdict = await checkSelection(db, projectId, assetIds, coverAssetId, newHandle);
  if (!verdict.ok) return verdict;
  const project = (await db.prepare("SELECT street, suburb FROM projects WHERE id = ?1").bind(projectId).first<{ street: string; suburb: string | null }>())!;
  const latest = (await db.prepare("SELECT latest_set_number AS latest FROM delivery_pages WHERE project_id = ?1").bind(projectId).first<{ latest: number }>())?.latest ?? 0;
  const coverHandle = verdict.rows.find((row) => row.assetId === coverAssetId)?.handle ?? null;
  return { ok: true, dto: buildDeliveryDto({ property: project, setNumber: latest + 1, publishedAt: null, coverHandle, rows: verdict.rows, urls }) };
}
