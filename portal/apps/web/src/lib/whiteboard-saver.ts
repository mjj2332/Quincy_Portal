import { WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE, WHITEBOARD_MAX_MESSAGE_BYTES } from "@quincy/shared";

/** The part of an Excalidraw element the saver needs; everything else is passed through untouched. */
export type SavedElement = { id: string; version: number; versionNonce: number } & Record<string, unknown>;

export type WhiteboardSaver = {
  /** Records the loaded scene as already stored, so it is not sent back. */
  seed: (elements: readonly SavedElement[]) => void;
  /** Sends every element whose version differs from what is stored or in flight. Rejects if any batch fails. */
  flush: () => Promise<void>;
};

// Room for the `{"type":"elements","seq":N,"elements":[]}` envelope around the batch.
const ENVELOPE_BYTES = 256;
/** Element types the server refuses (until images ship). Tombstones count: the whole batch is rejected. */
export const isUnsupportedElement = (element: { type?: unknown }) => element.type === "image";
/** A paste carrying an element the whiteboard cannot store is refused whole, before it reaches the scene. */
export const pasteIsUnsupported = (data: { elements?: readonly { type?: unknown }[] }) => data.elements?.some(isUnsupportedElement) === true;
/**
 * Whatever route an unsupported element took onto the board (file open, library insert, drag-drop,
 * paste, scene replace), it ends up in the scene. Returns the scene without those elements (the same
 * array when there are none), so a post-insert sweep can remove them and the board never shows
 * something that silently would not save.
 */
export function withoutUnsupported<T extends { type?: unknown; isDeleted?: boolean }>(elements: readonly T[]): { kept: readonly T[]; removed: number } {
  const kept = elements.filter((element) => !isUnsupportedElement(element));
  const removed = elements.filter((element) => isUnsupportedElement(element) && !element.isDeleted).length;
  return { kept: removed === 0 ? elements : kept, removed };
}
const encoder = new TextEncoder();
const keyOf = (element: SavedElement) => `${element.version}:${element.versionNonce}`;

/**
 * #498: decides what to send and when it counts as saved. The version recorded for an element is
 * the one that was TRANSMITTED (captured before the send), never whatever the live scene holds when
 * the ack arrives: an edit made while a save is in flight must still go out next time. Each batch is
 * recorded only after its own ack, and batches respect the protocol's element-count and byte caps.
 */
export function createWhiteboardSaver({ getElements, send }: {
  getElements: () => readonly SavedElement[];
  send: (batch: readonly SavedElement[]) => Promise<void>;
}): WhiteboardSaver {
  const stored = new Map<string, string>();
  // Last known form of every element the server holds, so one that vanishes without a tombstone can be deleted.
  const known = new Map<string, SavedElement>();
  const inflight = new Map<string, { key: string; promise: Promise<void> }>();

  const batchesOf = (changed: readonly SavedElement[]): SavedElement[][] => {
    const batches: SavedElement[][] = [];
    let current: SavedElement[] = []; let bytes = ENVELOPE_BYTES;
    for (const element of changed) {
      const size = encoder.encode(JSON.stringify(element)).byteLength + 1;
      if (current.length > 0 && (current.length >= WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE || bytes + size > WHITEBOARD_MAX_MESSAGE_BYTES)) { batches.push(current); current = []; bytes = ENVELOPE_BYTES; }
      current.push(element); bytes += size;
    }
    if (current.length > 0) batches.push(current);
    return batches;
  };

  return {
    seed(elements) { for (const element of elements) { stored.set(element.id, keyOf(element)); known.set(element.id, { ...element }); } },
    flush() {
      // Image elements (tombstones too) are never sent: the server refuses the whole batch.
      const candidates = getElements().filter((element) => !isUnsupportedElement(element));
      const waits: Promise<void>[] = [];
      // An id the server holds that is gone from the scene (a replaced canvas) gets a tombstone.
      const present = new Set(candidates.map((element) => element.id));
      const vanished: SavedElement[] = [];
      for (const [id, last] of known) {
        if (present.has(id) || last.isDeleted === true) continue;
        vanished.push({ ...last, isDeleted: true, version: last.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) });
      }

      const changed = [...candidates, ...vanished].filter((element) => {
        const key = keyOf(element);
        if (stored.get(element.id) === key) return false;
        const flying = inflight.get(element.id);
        if (flying?.key === key) { waits.push(flying.promise); return false; }  // join it: its failure is ours
        return true;
      });
      // Capture what is transmitted now; the scene objects may be mutated by later edits.
      const sends = batchesOf(changed.map((element) => ({ ...element }))).map((batch) => {
        const sentKeys = batch.map((element) => [element.id, keyOf(element)] as const);
        const promise = (async () => {
          try {
            await send(batch);
            for (const [id, key] of sentKeys) stored.set(id, key);
            for (const element of batch) known.set(element.id, element);
          } finally {
            for (const [id, key] of sentKeys) if (inflight.get(id)?.key === key) inflight.delete(id);
          }
        })();
        for (const [id, key] of sentKeys) inflight.set(id, { key, promise });
        return promise;
      });
      return Promise.all([...waits, ...sends]).then(() => undefined);
    },
  };
}
