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
 * A repaired index is also never an INPUT to a later merge. The server orders by (index, id) and a fresh tab repairs clashes
 * from that order, so a tab that fed its own repairs back into `reconcileElements` would order overlapping shapes
 * differently from a fresh tab. The `IndexLedger` therefore keeps each element's CANONICAL index (as last received, or as
 * authored here) beside the index the renderer repaired it to; every merge reconciles on canonical indices (Excalidraw
 * orders ties by id, exactly as the server does) and only then lets Excalidraw derive the repair.
 *
 * `restore`/`reconcile` are parameters, so the canvas passes Excalidraw's and the tests pass the same installed
 * functions; this file imports nothing from Excalidraw and stays out of the entry chunk.
 */
type Revisioned = { id: string; version: number; versionNonce: number };
type Revision = { version: number; versionNonce: number };
/** Per element id: the index the server holds (or this person authored), and the index the renderer put it at. */
export type IndexLedger = Map<string, { canonical: string; rendered: string }>;
export const createIndexLedger = (): IndexLedger => new Map();

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
const indexOf = (element: object): string | undefined => { const index = (element as { index?: unknown }).index; return typeof index === "string" ? index : undefined; };
const setIndex = (element: object, index: string) => { (element as { index: string }).index = index; };

/**
 * Returns the reconciled scene for `local` plus the `remote` batch, with every element at an un-repaired revision and
 * the scene's order derived from canonical indices (so it matches a fresh load of the same stored rows).
 * The caller installs the result with `updateScene` (which re-runs the index repair, a no-op by then).
 */
export function mergeRemote<E extends Revisioned>(local: readonly E[], remote: readonly Revisioned[], fns: MergeFns<E>, ledger: IndexLedger): E[] {
  const arrived = new Map<string, Revision & { index: string | undefined }>(remote.map((element) => [element.id, { version: element.version, versionNonce: element.versionNonce, index: indexOf(element) }]));
  const restored = fns.restore(remote);
  const restoredObjects = new Set<object>(restored);
  const canonicalOf = new Map<string, string | undefined>();
  for (const element of restored) {
    const revision = arrived.get(element.id);
    if (!revision) continue;
    setRevision(element, revision);                                                   // restore itself repairs indices
    if (revision.index !== undefined) setIndex(element, revision.index);              // ...but what the server holds is what orders the merge
    canonicalOf.set(element.id, revision.index ?? indexOf(element));
  }
  const before = new Map<object, Revision>();
  const localCanonical = new Map<string, string | undefined>();
  const localInputs = local.map((element) => {
    const known = ledger.get(element.id);
    const current = indexOf(element);
    // An index the renderer repaired is not a decision of this person; any other index (a new shape, a reorder) is.
    const canonical = known && known.rendered === current ? known.canonical : current;
    localCanonical.set(element.id, canonical);
    const input = canonical !== undefined && canonical !== current ? ({ ...element } as E) : element;
    if (input !== element) setIndex(input, canonical!);
    before.set(input, { version: element.version, versionNonce: element.versionNonce });
    return input;
  });
  const merged = fns.reconcile(localInputs, restored);
  for (const element of merged) {
    if (restoredObjects.has(element)) {
      const revision = arrived.get(element.id);
      if (revision) setRevision(element, revision);
      const canonical = canonicalOf.get(element.id); const rendered = indexOf(element);
      if (canonical !== undefined && rendered !== undefined) ledger.set(element.id, { canonical, rendered });
      continue;
    }
    const revision = before.get(element);
    if (revision) setRevision(element, revision);
    const canonical = localCanonical.get(element.id); const rendered = indexOf(element);
    // Only elements the server holds have a canonical index apart from the rendered one; a shape not yet sent goes out with whatever index it now has.
    if (ledger.has(element.id) && canonical !== undefined && rendered !== undefined) ledger.set(element.id, { canonical, rendered });
  }
  return merged;
}

/**
 * The first load: `initialData` went through Excalidraw's own restore, which repairs indices exactly as above. Puts the
 * scene's elements back at the revisions the server sent, in place, so nothing the server holds reads as an edit, and
 * records the server's indices as canonical.
 */
export function adoptArrivedRevisions(scene: readonly Revisioned[], arrived: readonly Revisioned[], ledger: IndexLedger): void {
  const byId = new Map(arrived.map((element) => [element.id, element]));
  for (const element of scene) {
    const incoming = byId.get(element.id);
    if (!incoming) continue;
    setRevision(element, incoming);
    const canonical = indexOf(incoming); const rendered = indexOf(element);
    if (canonical !== undefined && rendered !== undefined) ledger.set(element.id, { canonical, rendered });
  }
}
