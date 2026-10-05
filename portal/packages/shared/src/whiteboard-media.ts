import { z } from "zod";

/**
 * #501: an image or video on a Project whiteboard is an Excalidraw `image` element that REFERENCES an embedded media row:
 * `fileId` is the `embedded_media` id and `customData.quincyMedia.kind` says whether it is an image or a video. No bytes, URL
 * or data URL ever travels over the socket or into the board. Both the Durable Object (shape only: ownership is enforced by the
 * attach SQL's Project scope and the read rule) and the snapshot's media bookkeeping use these helpers.
 */
export const WHITEBOARD_MEDIA_KINDS = ["image", "video"] as const;
export type WhiteboardMediaKind = (typeof WHITEBOARD_MEDIA_KINDS)[number];

export type WhiteboardMediaRef = { id: string; kind: WhiteboardMediaKind };

const mediaIdSchema = z.string().uuid();

/** The media an element references, or null unless it is a WELL-FORMED Quincy media element (an `image` with a UUID `fileId` and a known kind). */
export function whiteboardMediaRef(element: Record<string, unknown>): WhiteboardMediaRef | null {
  if (element.type !== "image") return null;
  const id = mediaIdSchema.safeParse(element.fileId);
  if (!id.success) return null;
  const customData = element.customData;
  if (typeof customData !== "object" || customData === null) return null;
  const media = (customData as Record<string, unknown>).quincyMedia;
  if (typeof media !== "object" || media === null) return null;
  const kind = (media as Record<string, unknown>).kind;
  if (kind !== "image" && kind !== "video") return null;
  return { id: id.data, kind };
}

/**
 * The sorted, unique media ids a scene holds. A deleted element (a tombstone) does not hold its media: "no longer on the board"
 * means removed, and an undo re-adds the element with a higher version so the next snapshot attaches it again.
 */
export function whiteboardMediaIds(rows: ReadonlyArray<Record<string, unknown>>): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.isDeleted === true) continue;
    const ref = whiteboardMediaRef(row);
    if (ref) ids.add(ref.id);
  }
  return [...ids].sort();
}
