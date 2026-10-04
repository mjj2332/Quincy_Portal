/**
 * #499: keeps another person's elements at the revision they arrived in.
 *
 * Excalidraw's `reconcileElements` repairs a fractional-index clash (two people create a shape at the same index) with
 * `mutateElement`, which bumps `version` and draws a new `versionNonce` on the REMOTE element, locally. Left alone,
 * that derived revision looks like a local edit: the saver sends it back (overwriting the sender's real later edit)
 * and it can beat or lose against the sender's genuine next version. So the revision each remote winner arrived with
 * is recorded before the merge and restored after it. The repaired INDEX is kept (it orders the board here); the
 * server's copy keeps the sender's index, and the next genuine edit of that element carries ours.
 *
 * No Excalidraw import: the canvas passes its own elements in, so this stays out of the entry chunk and is testable.
 */
type Revisioned = { id: string; version: number; versionNonce: number };
export type RemotePin = { element: Revisioned; version: number; versionNonce: number };

/** BEFORE reconcile: records the revision each restored remote element arrived at. */
export function pinRemoteRevisions(remote: readonly Revisioned[]): RemotePin[] {
  return remote.map((element) => ({ element, version: element.version, versionNonce: element.versionNonce }));
}

/**
 * AFTER the scene has been updated (and any index repair done): puts the remote elements the scene took back at the
 * revision they arrived in. Only the remote batch's own objects count (a loser is not in the scene; a local winner is
 * never touched): the object itself, or a scene copy of it that still carries its repaired nonce.
 */
export function restorePinnedRevisions(pins: readonly RemotePin[], scene: readonly Revisioned[]): void {
  const byId = new Map(scene.map((element) => [element.id, element]));
  for (const pin of pins) {
    const repairedNonce = pin.element.versionNonce;
    const copy = byId.get(pin.element.id);
    for (const target of new Set([pin.element, copy !== undefined && copy.versionNonce === repairedNonce ? copy : undefined])) {
      if (!target) continue;
      (target as { version: number }).version = pin.version;
      (target as { versionNonce: number }).versionNonce = pin.versionNonce;
    }
  }
}
