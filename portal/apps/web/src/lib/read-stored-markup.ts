import { MARKUP_SHAPES, type FreehandPoint, type MarkupItem } from "@quincy/shared";

/**
 * The tolerant reader for saved photo markup (#741 slice 6s-api). The annotation JSON in R2 was written by this
 * or an older or newer build, so it is checked rather than cast. A well-formed item is returned as the SAME object (old data
 * cannot drift). Anything else is not rendered and flags the annotation `unsupported`: a `type` this build does not know
 * (a newer writer), or an entry that is malformed. The Lightbox keeps the data and blocks drawing edits on a flagged
 * annotation, because an edit would save the unrenderable part away.
 */
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isPoint = (value: unknown): value is FreehandPoint => typeof value === "object" && value !== null && isNumber((value as FreehandPoint).x) && isNumber((value as FreehandPoint).y);

function isMarkupItem(value: unknown): value is MarkupItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as { type?: unknown; points?: unknown; color?: unknown; width?: unknown };
  if (typeof item.color !== "string" || !isNumber(item.width) || !Array.isArray(item.points) || !item.points.every(isPoint)) return false;
  if (item.type === undefined) return item.points.length >= 1;
  return typeof item.type === "string" && (MARKUP_SHAPES as readonly string[]).includes(item.type) && item.points.length === 2;
}

export function readStoredMarkup(raw: readonly unknown[]): { items: MarkupItem[]; unsupported: boolean } {
  const items = raw.filter(isMarkupItem);
  return { items, unsupported: items.length !== raw.length };
}

/** A deep copy for the Edit drawing preload. It keeps `type` and a shape's two-point tuple, and adds no key a typeless stroke lacks. */
export function cloneMarkupItem(item: MarkupItem): MarkupItem {
  const points = item.points.map((point) => ({ ...point }));
  return (item.type === undefined ? { ...item, points } : { ...item, points: [points[0]!, points[1]!] }) as MarkupItem;
}
