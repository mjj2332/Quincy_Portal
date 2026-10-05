import { WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE, WHITEBOARD_MAX_MESSAGE_BYTES, whiteboardMediaRef } from "@quincy/shared";

/** What the server holds of one scene element: exactly this revision, acknowledged ("stored": its index is the server's);
 * this revision, sent and not yet acknowledged ("in-flight": the index it was SENT with is the one the server will keep,
 * unless it answers with a re-keyed copy first); or nothing of this revision ("none": never sent, or edited since). */
export type ServerHold = { state: "stored" } | { state: "in-flight"; index: string | undefined } | { state: "none" };

/** The part of an Excalidraw element the saver needs; everything else is passed through untouched. */
export type SavedElement = { id: string; version: number; versionNonce: number } & Record<string, unknown>;

export type WhiteboardSaver = {
  /** Records the loaded scene as already stored, so it is not sent back. */
  seed: (elements: readonly SavedElement[]) => void;
  /** #499: records elements that arrived from another person (and were applied to the scene) as stored AND transmitted
   * at exactly the version they came in, so they are never echoed back or re-sent at a higher version. */
  adoptRemote: (elements: readonly SavedElement[]) => void;
  /** #499: what the server holds, or is about to hold, of this scene element (see `ServerHold`). A merge must not move the
   * index of an element the server holds, and must put back one it was sent with. */
  hold: (element: SavedElement) => ServerHold;
  /** #499: the server holds SOME revision of these ids (it sent them, whether or not the scene took them: a local copy may have beaten the remote one). An id only; never a revision. */
  serverHas: (ids: Iterable<string>) => void;
  /** #499: could the server hold a revision of this id (seeded, adopted, sent by it, transmitted or acked)? An element it never could hold needs no deletion when the editor drops it. */
  mayHold: (id: string) => boolean;
  /** Sends every element whose version differs from what is stored or in flight. Rejects if any batch fails. */
  flush: () => Promise<void>;
};

// Room for the `{"type":"elements","seq":N,"elements":[]}` envelope around the batch.
const ENVELOPE_BYTES = 256;
/**
 * #501: the only `image` elements the server stores are Quincy media: a UUID `fileId` plus `customData.quincyMedia.kind`. An image
 * without that shape (a foreign Excalidraw image with a hashed fileId or a data URL) is refused, tombstones included: the whole
 * batch is rejected. A WELL-FORMED media element is never unsupported, whatever its id: a peer's freshly placed image has an id this
 * client has never seen, and sweeping it would make the vanish observer delete it for everyone.
 */
export const isUnsupportedElement = (element: object): boolean => "type" in element && element.type === "image" && whiteboardMediaRef(element as Record<string, unknown>) === null;
/** #501: a well-formed media element whose media this board does not hold (the id is not referenced by this board and was not uploaded in this session): it came from another board or file. */
export const isForeignMedia = (element: object, known: (mediaId: string) => boolean): boolean => {
  const ref = whiteboardMediaRef(element as Record<string, unknown>);
  return ref !== null && !known(ref.id);
};
/** A paste carrying an element the whiteboard cannot store is refused whole, before it reaches the scene. With `known`, media from another board is refused too (a LOCAL entry point only: remote elements are never judged by it). */
export const pasteIsUnsupported = (data: { elements?: readonly object[] }, known?: (mediaId: string) => boolean) => data.elements?.some((element) => isUnsupportedElement(element) || (known !== undefined && isForeignMedia(element, known))) === true;
/**
 * Whatever route a malformed image took onto the board (file open, library insert, drag-drop,
 * paste, scene replace), it ends up in the scene. Returns the scene without those elements (the same
 * array when there are none), so a post-insert sweep can remove them and the board never shows
 * something that silently would not save. Never removes a well-formed media element (see `isUnsupportedElement`).
 */
export function withoutUnsupported<T extends { type?: unknown; isDeleted?: boolean }>(elements: readonly T[]): { kept: readonly T[]; removed: number } {
  const kept = elements.filter((element) => !isUnsupportedElement(element));
  const removed = elements.filter((element) => isUnsupportedElement(element) && !element.isDeleted).length;
  return { kept: removed === 0 ? elements : kept, removed };
}
/** #501: the scene-file load path's filter: media elements this board does not hold are dropped before they reach the scene. */
export function withoutForeignMedia<T extends { type?: unknown }>(elements: readonly T[], known: (mediaId: string) => boolean): { kept: readonly T[]; removed: number } {
  const kept = elements.filter((element) => !isForeignMedia(element, known));
  return { kept, removed: elements.length - kept.length };
}
const MEDIA_FILE_NAME = /\.(jpe?g|png|webp|mp4|mov)$/i;
/** A dropped or pasted file the board's media pipeline should look at (the pipeline's own checks give the reason for a refusal). */
export const isMediaCandidate = (file: Pick<File, "type" | "name">): boolean => (file.type ?? "").startsWith("image/") || (file.type ?? "").startsWith("video/") || MEDIA_FILE_NAME.test(file.name ?? "");
/** What to do with files dropped on the board: a scene or library file is loaded through the controller
 * (which tombstones what it replaces), image and video files go to the media pipeline (#501), and every file is refused
 * in view-only mode. Anything else is Excalidraw's. */
export function planSceneDrop(files: Iterable<File>, viewOnly: boolean): "ignore" | "refuse" | { load: File } | { media: File[] } {
  const all = [...files];
  if (viewOnly) return all.length > 0 ? "refuse" : "ignore";   // nothing may be dropped on a view-only board
  const file = all.find((item) => /\.(excalidraw|excalidrawlib|json)$/i.test(item.name));
  if (file) return { load: file };
  const media = all.filter(isMediaCandidate);
  return media.length > 0 ? { media } : "ignore";
}
/**
 * #499: after a remote batch is reconciled into the scene, which of those remote elements is now what the
 * scene holds? The ones the local copy beat (a higher version, or an equal version with a lower nonce) are not,
 * so they are not recorded as stored: the local one is still the thing to send. Returns the scene's elements.
 */
export function appliedFromRemote<T extends { id: string; version: number; versionNonce: number }>(remote: ReadonlyArray<{ id: string; version: number; versionNonce: number }>, scene: readonly T[]): T[] {
  const byId = new Map(scene.map((element) => [element.id, element]));
  return remote.flatMap((incoming) => {
    const held = byId.get(incoming.id);
    return held && held.version === incoming.version && held.versionNonce === incoming.versionNonce ? [held] : [];
  });
}
const encoder = new TextEncoder();
const keyOf = (element: SavedElement) => `${element.version}:${element.versionNonce}`;

/**
 * #498: decides what to send and when it counts as saved. #499: it is a PURE SENDER. It never authors a revision: it never
 * writes a version or nonce into the scene and never transmits a revision the scene does not hold. The editor (or code that
 * behaves exactly like an editor operation: `whiteboard-vanish.ts`, `replaceContent`) authors every revision; this diffs the
 * scene by exact (id, version, nonce) keys and sends snapshots of it unchanged.
 *
 * Whatever differs from what is stored or in flight goes out. Flushes run one after another. Each batch counts as stored only
 * after its own ack, keyed by the SCENE element it came from (a remote edit adopted while it was in flight stays recorded, a
 * stale ack never marks a newer revision stored), a retry sends the same revision again, and batches respect the protocol's
 * element-count and byte caps.
 */
export function createWhiteboardSaver({ getElements, send }: {
  getElements: () => readonly SavedElement[];
  send: (batch: readonly SavedElement[]) => Promise<void>;
}): WhiteboardSaver {
  /** The scene key last acknowledged per id. */
  const stored = new Map<string, string>();
  /** The scene key last transmitted per id (and the index it went out with), so a retry is idempotent. */
  const transmitted = new Map<string, { key: string; index?: string }>();
  /** Ids the server told us it holds, taken or not (see `serverHas`). */
  const onServer = new Set<string>();
  let active: Promise<void> | null = null;

  const batchesOf = (changed: readonly SavedElement[]): number[][] => {
    const batches: number[][] = [];
    let current: number[] = []; let bytes = ENVELOPE_BYTES;
    changed.forEach((element, index) => {
      const size = encoder.encode(JSON.stringify(element)).byteLength + 1;
      if (current.length > 0 && (current.length >= WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE || bytes + size > WHITEBOARD_MAX_MESSAGE_BYTES)) { batches.push(current); current = []; bytes = ENVELOPE_BYTES; }
      current.push(index); bytes += size;
    });
    if (current.length > 0) batches.push(current);
    return batches;
  };

  const run = async (): Promise<void> => {
    const outgoing: Array<{ element: SavedElement; sceneKey: string }> = [];
    for (const element of getElements()) {
      if (isUnsupportedElement(element)) continue;
      const sceneKey = keyOf(element);
      // Skip only when the desired revision is both acknowledged and the last thing transmitted.
      const last = transmitted.get(element.id);
      if (stored.get(element.id) === sceneKey && (last === undefined || last.key === sceneKey)) continue;
      outgoing.push({ element: { ...element }, sceneKey });
    }
    // Transmit time: remember what went out before anything is awaited.
    for (const { element, sceneKey } of outgoing) transmitted.set(element.id, { key: sceneKey, index: typeof element.index === "string" ? element.index : undefined });
    const sends = batchesOf(outgoing.map(({ element }) => element)).map(async (indexes) => {
      await send(indexes.map((index) => outgoing[index]!.element));
      // A remote edit adopted while this batch was in flight is newer than what this ack confirms: it stays recorded.
      for (const index of indexes) { const { element, sceneKey } = outgoing[index]!; if (transmitted.get(element.id)?.key === sceneKey) stored.set(element.id, sceneKey); }
    });
    const results = await Promise.allSettled(sends);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  };

  return {
    seed(elements) {
      for (const element of elements) stored.set(element.id, keyOf(element));
    },
    adoptRemote(elements) {
      for (const element of elements) {
        const key = keyOf(element);
        stored.set(element.id, key);
        transmitted.set(element.id, { key });
      }
    },
    hold(element) {
      const key = keyOf(element);
      const last = transmitted.get(element.id);
      if (stored.get(element.id) === key && (last === undefined || last.key === key)) return { state: "stored" };
      return last?.key === key ? { state: "in-flight", index: last.index } : { state: "none" };
    },
    serverHas(ids) { for (const id of ids) onServer.add(id); },
    mayHold: (id) => onServer.has(id) || stored.has(id) || transmitted.has(id),
    flush() {
      // One flush at a time: a later one joins the earlier save (and its failure) before it diffs.
      const previous = active;
      const current = (async () => { if (previous) await previous; await run(); })();
      active = current;
      const clear = () => { if (active === current) active = null; };
      current.then(clear, clear);
      return current;
    },
  };
}
