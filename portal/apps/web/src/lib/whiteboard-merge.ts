/**
 * #499: merging another person's elements into the board without ever changing a revision.
 *
 * Excalidraw repairs a fractional-index clash (two people create a shape at the same index) with `mutateElement`, which
 * bumps `version` and draws a new `versionNonce` on whichever element it touches: a remote one, a local one, and inside
 * `restoreElements` as well as `reconcileElements`. That is a layout detail of THIS renderer, not an edit. Left alone it
 * looks like one: the saver sends it (overwriting the sender's real later edit), and the derived nonce can beat or lose
 * against the sender's genuine next version. So a merge puts every revision back: remote elements at the revision they
 * arrived in, local elements at the revision they had before. The repaired INDEX stays (it orders the board here) and goes
 * out only with a genuine edit of that element; a genuine reorder is an ordinary edit with a version of its own.
 *
 * `restore`/`reconcile` are parameters, so the canvas passes Excalidraw's and the tests pass the same installed
 * functions; this file imports nothing from Excalidraw and stays out of the entry chunk.
 */
type Revisioned = { id: string; version: number; versionNonce: number };
type Revision = { version: number; versionNonce: number };

export type MergeFns<E extends Revisioned> = {
  /** Excalidraw's `restoreElements(raw, null)`. */
  restore: (raw: readonly unknown[]) => E[];
  /** Excalidraw's `reconcileElements(local, remote, appState)`. Its result holds the very objects it was given. */
  reconcile: (local: E[], remote: E[]) => E[];
};

const setRevision = (element: Revisioned, revision: Revision) => {
  (element as { version: number }).version = revision.version;
  (element as { versionNonce: number }).versionNonce = revision.versionNonce;
};

/**
 * Returns the reconciled scene for `local` plus the `remote` batch, with every element at an un-repaired revision.
 * The caller installs the result with `updateScene` (which re-runs the index repair, a no-op by then).
 */
export function mergeRemote<E extends Revisioned>(local: readonly E[], remote: readonly Revisioned[], fns: MergeFns<E>): E[] {
  const arrived = new Map<string, Revision>(remote.map((element) => [element.id, { version: element.version, versionNonce: element.versionNonce }]));
  const restored = fns.restore(remote);
  const restoredObjects = new Set<object>(restored);
  for (const element of restored) { const revision = arrived.get(element.id); if (revision) setRevision(element, revision); }   // restore itself repairs indices
  const before = new Map<object, Revision>(local.map((element) => [element, { version: element.version, versionNonce: element.versionNonce }]));
  const merged = fns.reconcile([...local], restored);
  for (const element of merged) {
    if (restoredObjects.has(element)) { const revision = arrived.get(element.id); if (revision) setRevision(element, revision); continue; }
    const revision = before.get(element);
    if (revision) setRevision(element, revision);
  }
  return merged;
}

/**
 * The first load: `initialData` went through Excalidraw's own restore, which repairs indices exactly as above. Puts the
 * scene's elements back at the revisions the server sent, in place, so nothing the server holds reads as an edit.
 */
export function adoptArrivedRevisions(scene: readonly Revisioned[], arrived: readonly Revisioned[]): void {
  const byId = new Map(arrived.map((element) => [element.id, element]));
  for (const element of scene) { const revision = byId.get(element.id); if (revision) setRevision(element, revision); }
}
