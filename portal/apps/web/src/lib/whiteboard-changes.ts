type Revisioned = { id: string; version: number; versionNonce: number };

const keyOf = (element: Revisioned) => `${element.version}:${element.versionNonce}`;

/**
 * #499: tells the editor's own change event apart from the echo of a remote merge, per ELEMENT.
 *
 * A remote merge must not read as an edit (a remote tick would flash "Unsaved changes"), but the editor's change event
 * arrives after the merge, and a local edit that Excalidraw has not reported yet can land in that same event. So nothing is
 * suppressed scene-wide: the tracker remembers the revision (version and versionNonce) of every element it has seen, and a
 * merge records only the elements actually TAKEN from the remote batch. A change event is remote only when every element
 * whose revision moved is one of those; any other moved element is the person's own edit and must mark the board dirty.
 */
export function createChangeTracker() {
  const seen = new Map<string, string>();
  const loaded = new Map<string, string>();
  /** Revisions a merge took from someone else (id:key): they moved an element off the loaded revision without the person editing it. */
  const remote = new Set<string>();
  const remember = (elements: readonly Revisioned[]) => { for (const element of elements) seen.set(element.id, keyOf(element)); };
  let remoteHash: number | null = null;
  return {
    /** The scene as loaded: everything in it is already accounted for. */
    seed(elements: readonly Revisioned[]) { seen.clear(); remember(elements); loaded.clear(); remote.clear(); for (const element of elements) loaded.set(element.id, keyOf(element)); },
    /** Has the person changed this element since the load? (Its revision moved off the loaded one, by anything but a merge adopted through `remoteApplied`.) */
    editedSinceLoad(element: Revisioned) { const was = loaded.get(element.id); return was !== undefined && was !== keyOf(element) && !remote.has(`${element.id}:${keyOf(element)}`); },
    /** A merge (or a revision adoption) just ran: `taken` are the scene's elements that came from the remote batch. */
    remoteApplied(hash: number, _scene: readonly Revisioned[], taken: readonly Revisioned[]) { remember(taken); for (const element of taken) remote.add(`${element.id}:${keyOf(element)}`); remoteHash = hash; },
    /** The editor's change event: "remote" when no element moved except by a remote merge, otherwise "local". */
    classify(elements: readonly Revisioned[], hash: number): "remote" | "local" {
      let moved = 0;
      for (const element of elements) if (seen.get(element.id) !== keyOf(element)) moved += 1;
      remember(elements);
      const echo = moved === 0 && remoteHash === hash;
      remoteHash = null;
      return echo ? "remote" : "local";
    },
  };
}
