import type { DeliveryItemDto, DeliveryPageDto } from "@quincy/shared";

/** The item links the page may offer. `null` (Preview) means there is nothing to download: no download anchor of any kind is rendered. */
export type DeliveryHrefs = {
  /** The page-sized derivative (a photo's 2048 px JPEG, a PDF inline). The DTO's `url` is this same address. */
  media(handle: string): string;
  thumb(handle: string): string;
  /** The original file, as an attachment. Refused (403) for a locked item, which the page never links. */
  download(handle: string): string;
};

/** What the page shows for one item's unlock request. Held above the page (keyed by handle) so it survives a tab or lightbox change. */
export type UnlockState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "requested" }
  /** A 429: the button waits until `until` (epoch ms), then is idle again. */
  | { kind: "limited"; until: number }
  | { kind: "failed" };
export type UnlockStates = Readonly<Record<string, UnlockState>>;

export type DeliveryTabId = "photos" | "film" | "floorplan" | "description" | "premium";
export type DeliveryTab = { id: DeliveryTabId; label: string; items: DeliveryItemDto[] };

/** A paid extra: flagged premium (locked or since unlocked), or locked for any reason. These live on the Premium tab, not under their kind. */
export const isExtra = (item: DeliveryItemDto): boolean => item.premium || item.locked;

const KIND_TAB: Record<DeliveryItemDto["kind"], Exclude<DeliveryTabId, "premium">> = { photo: "photos", video: "film", floorplan: "floorplan", copy: "description" };
const LABELS: Record<DeliveryTabId, string> = { photos: "Gallery", film: "Film", floorplan: "Floorplan", description: "Copywriting", premium: "Premium" };
const ORDER: readonly DeliveryTabId[] = ["photos", "film", "floorplan", "description", "premium"];

/** The tabs in PRD order, items in published order, empty tabs left out. Premium holds every extra of every kind, and keeps holding it after an unlock. */
export function tabsOf(dto: DeliveryPageDto): DeliveryTab[] {
  const buckets = new Map<DeliveryTabId, DeliveryItemDto[]>(ORDER.map((id) => [id, []]));
  for (const item of dto.items) buckets.get(isExtra(item) ? "premium" : KIND_TAB[item.kind])!.push(item);
  return ORDER.filter((id) => buckets.get(id)!.length > 0).map((id) => ({ id, label: LABELS[id], items: buckets.get(id)! }));
}

/** The hero photo: the cover when it is a photo the client may see in full, else the first such photo, else none (a text-only hero). A locked photo is only ever a watermarked preview, never a hero. */
export function heroOf(dto: DeliveryPageDto): DeliveryItemDto | null {
  const usable = (item: DeliveryItemDto): boolean => item.kind === "photo" && !item.locked && item.url !== null;
  const cover = dto.coverHandle === null ? undefined : dto.items.find((item) => item.handle === dto.coverHandle);
  if (cover && usable(cover)) return cover;
  return dto.items.find(usable) ?? null;
}

/** What the hero prints besides the street: the eyebrow parts (suburb, postcode, delivered date; whichever exist), the agency, and the counts. Frames are the Gallery's photos (paid extras live on Premium); films are every film. */
export function heroMetaOf(dto: DeliveryPageDto): { eyebrow: string[]; agency: string | null; frames: number; films: number } {
  const { suburb, postcode, agency } = dto.property;
  const eyebrow = [suburb, postcode, formatDelivered(dto.publishedAt)].filter((part): part is string => part !== null && part !== "");
  return { eyebrow, agency, frames: dto.items.filter((item) => item.kind === "photo" && !isExtra(item)).length, films: dto.items.filter((item) => item.kind === "video").length };
}

/** A box ratio from the stored dimensions, so a tile holds its shape before its image arrives. 3 / 2 when unknown. */
export const aspectOf = (item: Pick<DeliveryItemDto, "width" | "height">): string => (item.width !== null && item.height !== null ? `${item.width} / ${item.height}` : "3 / 2");

/** "11 October 2026" in the studio's own time zone, or null for a Preview, which is not published. */
export function formatDelivered(publishedAt: number | null): string | null {
  if (publishedAt === null) return null;
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "Australia/Sydney" }).format(new Date(publishedAt));
}

/** "1:02" or "1:02:03". */
export function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  const total = Math.round(durationMs / 1000); const h = Math.floor(total / 3600); const m = Math.floor((total % 3600) / 60); const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export const unlockOf = (states: UnlockStates, handle: string): UnlockState => states[handle] ?? { kind: "idle" };
