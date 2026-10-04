import { WHITEBOARD_MAX_ELEMENTS_PER_MESSAGE, WHITEBOARD_MAX_MESSAGE_BYTES } from "@quincy/shared";

/** The part of an Excalidraw element the saver needs; everything else is passed through untouched. */
export type SavedElement = { id: string; version: number; versionNonce: number } & Record<string, unknown>;

export type WhiteboardSaver = {
  /** Records the loaded scene as already stored, so it is not sent back. */
  seed: (elements: readonly SavedElement[]) => void;
  /** #499: records elements that arrived from another person (and were applied to the scene) as stored AND transmitted
   * at exactly the version they came in, so they are never echoed back or re-sent at a higher version. */
  adoptRemote: (elements: readonly SavedElement[]) => void;
  /** Sends every element whose version differs from what is stored or in flight. Rejects if any batch fails. */
  flush: () => Promise<void>;
};

// Room for the `{"type":"elements","seq":N,"elements":[]}` envelope around the batch.
const ENVELOPE_BYTES = 256;
/** Element types the server refuses (until images ship). Tombstones count: the whole batch is rejected. */
export const isUnsupportedElement = (element: object): boolean => "type" in element && element.type === "image";
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
/** What to do with files dropped on the board: a scene or library file is loaded through the controller
 * (which tombstones what it replaces), and every file is refused in view-only mode. Anything else is Excalidraw's. */
export function planSceneDrop(files: Iterable<File>, viewOnly: boolean): "ignore" | "refuse" | { load: File } {
  const all = [...files];
  if (viewOnly) return all.length > 0 ? "refuse" : "ignore";   // nothing may be dropped on a view-only board
  const file = all.find((item) => /\.(excalidraw|excalidrawlib|json)$/i.test(item.name));
  return file ? { load: file } : "ignore";
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
 * #498: decides what to send and when it counts as saved, around one invariant.
 *
 * `floor[id]` is the highest version ever TRANSMITTED or acked for that id (synthetic tombstones
 * included), raised at transmit time, never at ack time. Whatever goes out is sent at a version above
 * the floor, so a newer state always beats an older one the server may already hold: a tombstone for an
 * element whose v5 is still in flight is v6, and an element re-imported at an old version after its
 * tombstone is re-sent above it. Flushes run one after another, so removal diffing only ever happens
 * once every earlier save has settled, against everything transmitted or acked. Each batch counts as
 * stored only after its own ack, keyed by the SCENE element it came from, and batches respect the
 * protocol's element-count and byte caps.
 */
export function createWhiteboardSaver({ getElements, send }: {
  getElements: () => readonly SavedElement[];
  send: (batch: readonly SavedElement[]) => Promise<void>;
}): WhiteboardSaver {
  const floor = new Map<string, number>();
  /** The scene key last acknowledged per id (a synthetic tombstone records its own key). */
  const stored = new Map<string, string>();
  /** Last form transmitted or acked per id; the base of a synthetic tombstone. */
  const known = new Map<string, SavedElement>();
  /** The scene key last transmitted per id and the version it went out at, so a retry is idempotent. */
  const transmitted = new Map<string, { key: string; version: number }>();
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
    const scene = getElements().filter((element) => !isUnsupportedElement(element));
    const present = new Set(scene.map((element) => element.id));
    const outgoing: Array<{ element: SavedElement; sceneKey: string }> = [];

    for (const element of scene) {
      const sceneKey = keyOf(element);
      // Skip only when the desired state is both acknowledged and the last thing transmitted: a newer
      // state (a tombstone whose ack was lost) may be on the server.
      const last = transmitted.get(element.id);
      if (stored.get(element.id) === sceneKey && (last === undefined || last.key === sceneKey)) continue;
      const before = transmitted.get(element.id);
      const f = floor.get(element.id);
      const version = before?.key === sceneKey ? before.version : f !== undefined && element.version <= f ? f + 1 : element.version;
      outgoing.push({ element: { ...element, version }, sceneKey });
    }
    // Gone from the scene without a tombstone (a replaced canvas, an unacknowledged create that vanished).
    for (const [id, last] of known) {
      if (present.has(id)) continue;
      if (last.isDeleted === true) {
        // A tombstone the server has acknowledged is done; one that failed to send goes out again as it was.
        if (stored.get(id) !== keyOf(last)) outgoing.push({ element: last, sceneKey: keyOf(last) });
        continue;
      }
      const version = (floor.get(id) ?? last.version) + 1;
      const tombstone = { ...last, isDeleted: true, version, versionNonce: Math.floor(Math.random() * 2 ** 31) };
      outgoing.push({ element: tombstone, sceneKey: keyOf(tombstone) });
    }

    // Transmit time: raise the floor and remember what went out before anything is awaited.
    for (const { element, sceneKey } of outgoing) {
      floor.set(element.id, Math.max(floor.get(element.id) ?? 0, element.version));
      known.set(element.id, element);
      transmitted.set(element.id, { key: sceneKey, version: element.version });
    }
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
      for (const element of elements) {
        stored.set(element.id, keyOf(element));
        known.set(element.id, { ...element });
        floor.set(element.id, Math.max(floor.get(element.id) ?? 0, element.version));
      }
    },
    adoptRemote(elements) {
      for (const element of elements) {
        const key = keyOf(element);
        stored.set(element.id, key);
        known.set(element.id, { ...element });
        floor.set(element.id, Math.max(floor.get(element.id) ?? 0, element.version));
        transmitted.set(element.id, { key, version: element.version });
      }
    },
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
