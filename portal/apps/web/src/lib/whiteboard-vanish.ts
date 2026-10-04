import { IndexSpace } from "@quincy/shared";
import { isUnsupportedElement, type SavedElement } from "./whiteboard-saver";

/**
 * #499: an element the editor drops from the scene with no tombstone (a resize to zero size) is DELETED at observation time,
 * the way the editor itself would delete it, so the saver never has to invent a revision.
 *
 * On every editor change (before any debounce) this keeps `lastScene`: id -> the latest element OBJECT the editor held (the
 * object, not a copy, so a mutation the editor has not reported yet still counts). When an id the server may hold is no longer
 * in the scene, it authors `newElementWith(lastSceneCopy, { isDeleted: true })`: the version after the last one the editor
 * authored, a fresh nonce, exactly what Excalidraw authors for any delete, with the last valid geometry kept so a later restore
 * does not drop a zero-size tombstone. That tombstone is put on the board as a LOCAL change (through `install`, a merge, never a
 * raw append, whose index repair would bump it), so the board is dirty and autosave sends it, and it is an ordinary scene
 * element to the saver, which never authors anything.
 *
 * Not covered, by design: teardown (`stop`) and unsupported elements, which are never on the server.
 * Accepted gap (docs/lessons.md): a remote edit deferred during a gesture is not in the scene, so a concurrent deletion at
 * lastScene + 1 may tie or lose to it. That is concurrent edit-versus-delete under Excalidraw's own rule.
 */
export type VanishObserver = {
  /** The editor's scene (deleted elements included) after a change. Authors and installs a deletion for each element that vanished. */
  observe: (scene: readonly SavedElement[]) => void;
  /** The board is going away: its scene is empty and nothing it dropped is a deletion. */
  stop: () => void;
  /** The scene never took these ids (a remote winner the renderer dropped): they are the server's, so this tab must never author a deletion for them. */
  forget: (ids: readonly string[]) => void;
};

type Geometry = { width: number; height: number; points?: unknown };
const asNumber = (value: unknown) => (typeof value === "number" ? value : undefined);
/** Excalidraw's own test (`isInvisiblySmallElement`): a linear element needs two points, any other a width or a height. */
const invisible = (element: SavedElement) => (Array.isArray(element.points) ? element.points.length < 2 : asNumber(element.width) === 0 && asNumber(element.height) === 0);

/**
 * The ids of live elements the editor holds at an invisible size (a width and height of 0, or a line of fewer than two points) that
 * no gesture holds. `holding` is the ids a pointer gesture is still drawing, resizing or editing (the canvas adds the multi-point
 * line being drawn). Excalidraw finalizes such an element itself when a pointer gesture ends; one that reaches here by any other
 * path was never finalized, would be sent as an ordinary edit, and is dropped by every other tab's restore. The canvas drops it from
 * the scene and the observer then authors its deletion like any other vanish.
 */
export function unfinalized(elements: readonly SavedElement[], holding: ReadonlySet<string>): string[] {
  return elements.filter((element) => element.isDeleted !== true && !holding.has(element.id) && invisible(element)).map((element) => element.id);
}

export function createVanishObserver({ mayHold, deletion, install, ready = () => true }: {
  /** Could the server hold a revision of this id? (The saver's `mayHold`.) One it never could needs no deletion. */
  mayHold: (id: string) => boolean;
  /** The editor's own delete: `newElementWith(element, { isDeleted: true, ...patch })`. */
  deletion: (last: SavedElement, patch: Partial<Geometry> & { index?: string }) => SavedElement;
  /** Puts the deletions on the board as a local change (a merge) and returns the scene as it is afterwards. */
  install: (deletions: readonly SavedElement[]) => readonly SavedElement[] | void;
  /** False until the editor can author and merge; what vanished meanwhile is handled by the first observation after. */
  ready?: () => boolean;
}): VanishObserver {
  const lastScene = new Map<string, SavedElement>();
  const lastValid = new Map<string, Geometry>();
  let stopped = false;

  const remember = (scene: readonly SavedElement[]) => {
    for (const element of scene) {
      lastScene.set(element.id, element);
      const { width, height } = element; const points = element.points;
      if (!invisible(element) && typeof width === "number" && typeof height === "number") lastValid.set(element.id, { width, height, ...(points === undefined ? {} : { points }) });
    }
  };

  return {
    observe(scene) {
      if (stopped) return;
      const present = new Set(scene.map((element) => element.id));
      const absent = ready() ? [...lastScene.values()].filter((last) => !present.has(last.id)) : [];
      // What is absent and was never sent (or is already deleted) needs nothing; it is simply forgotten.
      const gone = absent.filter((last) => last.isDeleted !== true && !isUnsupportedElement(last) && mayHold(last.id));
      remember(scene);
      for (const last of absent) lastScene.delete(last.id);
      if (gone.length === 0) { for (const last of absent) lastValid.delete(last.id); return; }
      // The deletion takes a place on the board that no other element holds (the one the element had, else just above it).
      const space = new IndexSpace();
      for (const element of scene) space.claim(element.index, element.id);
      const deletions = gone.map((last) => {
        const wanted = typeof last.index === "string" ? last.index : undefined;
        const index = space.claim(wanted, last.id) ? wanted : space.place(wanted, last.id);
        // Never seen at a valid size (it arrived at zero size): a restorable 1x1 (a line gets two points) at its own x/y, since restore also drops a zero-size tombstone.
        const valid = invisible(last) ? lastValid.get(last.id) ?? (Array.isArray(last.points) ? { width: 1, height: 1, points: [[0, 0], [1, 1]] } : { width: 1, height: 1 }) : undefined;
        return deletion(last, { ...(index === undefined ? {} : { index }), ...(valid ?? {}) });
      });
      for (const last of absent) lastValid.delete(last.id);
      remember(install(deletions) ?? deletions);
    },
    stop() { stopped = true; },
    forget(ids) { for (const id of ids) { lastScene.delete(id); lastValid.delete(id); } },
  };
}
