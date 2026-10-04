import { IndexSpace, whiteboardIncomingWins } from "@quincy/shared";
import type { ServerHold } from "./whiteboard-saver";

/**
 * #499: merging another person's elements into the board without ever changing a revision.
 *
 * Excalidraw repairs a fractional-index clash with `mutateElement`, which bumps `version` and draws a new `versionNonce`
 * on whichever element it touches: a remote one, a local one, and inside `restoreElements` as well as `reconcileElements`.
 * That is a layout detail of THIS renderer, not an edit. Left alone it looks like one: the saver sends it (overwriting the
 * sender's real later edit), and the derived nonce can beat or lose against the sender's genuine next version.
 *
 * The server therefore guarantees that the indices it stores are unique (`@quincy/shared` `whiteboard-index.ts`), so what
 * arrives never clashes with itself. Two things can still clash HERE: an element this person has not sent yet (or edited
 * since), against a stored one. The merge moves THAT one, before Excalidraw sees it, with the same key generator the server
 * uses and no change of revision. Who keeps an index, in this order: incoming elements; local elements that are exactly what
 * the server holds ("stored"); local elements SENT and not yet acknowledged, at the index they were sent with ("in-flight":
 * the server keeps that index unless it answers, before the ack, with a re-keyed copy, so a local move of one is only
 * provisional and the next merge that frees the index undoes it); and last the unsent or edited ones. Whatever is in the
 * way goes just above what it hit, and the saver sends it with its new index. Excalidraw's own repair then has nothing to
 * do. Every revision is also put back afterwards, as a guard.
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
const indexOf = (element: object): string | undefined => { const index = (element as { index?: unknown }).index; return typeof index === "string" ? index : undefined; };
const setIndex = (element: object, index: string) => { (element as { index: string }).index = index; };

/**
 * Returns the reconciled scene for `local` plus the `remote` batch, with every element at an un-repaired revision.
 * `hold` says what the server holds of each local element (the saver's `hold`). The caller installs the
 * result with `updateScene` (which re-runs Excalidraw's index repair, a no-op by then).
 */
export function mergeRemote<E extends Revisioned>(local: readonly E[], remote: readonly Revisioned[], fns: MergeFns<E>, hold: (element: E) => ServerHold): E[] {
  const arrived = new Map<string, Revision & { index: string | undefined }>(remote.map((element) => [element.id, { version: element.version, versionNonce: element.versionNonce, index: indexOf(element) }]));
  const restored = fns.restore(remote);
  const restoredObjects = new Set<object>(restored);
  for (const element of restored) {
    const revision = arrived.get(element.id);
    if (!revision) continue;
    setRevision(element, revision);                                                   // restore itself repairs indices
    if (revision.index !== undefined) setIndex(element, revision.index);              // ...but what the server holds is what counts
  }

  // Who keeps their index, in priority order (see the header).
  const localById = new Map(local.map((element) => [element.id, element]));
  const incomingTaken = restored.filter((element) => { const mine = localById.get(element.id); return !mine || whiteboardIncomingWins(mine, element); });
  const superseded = new Set(incomingTaken.map((element) => element.id));
  const held = new Map<E, ServerHold>();
  for (const element of local) if (!superseded.has(element.id)) held.set(element, hold(element));
  const withState = (state: ServerHold["state"]) => local.filter((element) => held.get(element)?.state === state);
  const space = new IndexSpace();
  for (const element of incomingTaken) space.claim(indexOf(element), element.id);
  for (const element of withState("stored")) space.claim(indexOf(element), element.id);

  // In-flight, then unsent or edited ones: those whose index is free keep it (so nothing moves that need not), and each one in
  // the way goes just above what it hit: a copy with a new index, revision untouched.
  const moved = new Map<E, E>();
  const wanted = new Map<E, string | undefined>();
  const blocked: E[] = [];
  for (const element of withState("in-flight")) {
    const sent = (held.get(element) as { index: string | undefined }).index ?? indexOf(element);
    wanted.set(element, sent);
    if (!space.claim(sent, element.id)) blocked.push(element);
    else if (sent !== indexOf(element)) { const copy = { ...element } as E; setIndex(copy, sent!); moved.set(element, copy); }   // undoes an earlier provisional move
  }
  for (const element of withState("none")) { wanted.set(element, indexOf(element)); if (!space.claim(indexOf(element), element.id)) blocked.push(element); }
  for (const element of blocked) { const copy = { ...element } as E; setIndex(copy, space.place(wanted.get(element), element.id)); moved.set(element, copy); }
  const before = new Map<object, Revision>();
  const inputs = local.map((element) => {
    const input = moved.get(element) ?? element;
    before.set(input, { version: element.version, versionNonce: element.versionNonce });
    return input;
  });
  const merged = fns.reconcile(inputs, restored);
  for (const element of merged) {
    const revision = restoredObjects.has(element) ? arrived.get(element.id) : before.get(element);
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
  for (const element of scene) {
    const incoming = byId.get(element.id);
    if (incoming) setRevision(element, incoming);
  }
}
