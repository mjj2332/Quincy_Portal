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
 * the server keeps that index unless it answers, before the ack, with the stored row at a new index (same revision), so a local move of one is only
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

/** The ids Excalidraw will not replace right now: the element being text-edited, resized or drawn. */
export function interactingIds(appState: { editingTextElement?: { id: string } | null; resizingElement?: { id: string } | null; newElement?: { id: string } | null }): ReadonlySet<string> {
  return new Set([appState.editingTextElement?.id, appState.resizingElement?.id, appState.newElement?.id].filter((id): id is string => typeof id === "string"));
}

/**
 * Returns the reconciled scene for `local` plus the `remote` batch, with every element at an un-repaired revision.
 * `interacting` is the ids Excalidraw keeps as they are (it skips an element being edited): an incoming winner for one of those
 * is not applied now, but it is the server's, so its index is still claimed, and the local copy shown meanwhile yields. `hold` says what the server holds of each local element (the saver's `hold`). The caller installs the
 * result with `updateScene` (which re-runs Excalidraw's index repair, a no-op by then).
 */
export function mergeRemote<E extends Revisioned>(allLocal: readonly E[], remote: readonly Revisioned[], fns: MergeFns<E>, hold: (element: E) => ServerHold, interacting: ReadonlySet<string> = new Set()): E[] {
  const restored = fns.restore(remote);
  // A remote winner the renderer DROPS (`restoreElements` discards a live 0x0 element, and a 0x0 tombstone) is still the server's: it
  // claims its index, and a local copy it beats is not on the board any more, exactly as on a fresh load. Under interaction the local
  // copy stays (the gesture holds it) and the replay settles it once the gesture ends. Nothing here is deferred: the renderer will
  // never take that revision, so waiting for it would only re-run the merge forever.
  const restoredIds = new Set(restored.map((element) => element.id));
  const localOf = new Map(allLocal.map((element) => [element.id, element]));
  const dropped = remote.filter((element) => !restoredIds.has(element.id) && whiteboardIncomingWins(localOf.get(element.id), element));
  const omitted = new Set(dropped.filter((element) => !interacting.has(element.id)).map((element) => element.id));
  const droppedHeld = new Set(dropped.filter((element) => interacting.has(element.id) && localOf.has(element.id)).map((element) => element.id));
  const local = omitted.size === 0 ? allLocal : allLocal.filter((element) => !omitted.has(element.id));
  const arrived = new Map<string, Revision & { index: string | undefined }>(remote.map((element) => [element.id, { version: element.version, versionNonce: element.versionNonce, index: indexOf(element) }]));
  const restoredObjects = new Set<object>(restored);
  for (const element of restored) {
    const revision = arrived.get(element.id);
    if (!revision) continue;
    setRevision(element, revision);                                                   // restore itself repairs indices
    if (revision.index !== undefined) setIndex(element, revision.index);              // ...but what the server holds is what counts
  }

  // Who keeps their index, in priority order (see the header).
  const localById = new Map(local.map((element) => [element.id, element]));
  // An INDEX CORRECTION: the server holds exactly this revision, at the index it sends (a re-key sent back at the revision it
  // was authored with, a reconnect's stored rows, or the stored form of a revision this copy was sent as). A copy of exactly that
  // revision takes the server's index, claims it first (an in-flight copy must not undo a provisional move back onto an index the
  // server has given away), and changes nothing else (never a revision, so never an edit); one that holds
  // another revision ignores it, and the revision it holds is decided, and re-keyed again if need be, when it reaches the server.
  const corrections = new Map(restored.filter((element) => {
    const mine = localById.get(element.id);
    const index = indexOf(element);
    return mine !== undefined && index !== undefined && mine.version === element.version && mine.versionNonce === element.versionNonce;
  }).map((element) => [element.id, element]));
  const winning = restored.filter((element) => { const mine = localById.get(element.id); return !mine || whiteboardIncomingWins(mine, element) || corrections.has(element.id); });
  const skipped = new Set([...winning.filter((element) => interacting.has(element.id) && localById.has(element.id) && !corrections.has(element.id)).map((element) => element.id), ...droppedHeld]);
  const incomingTaken = winning.filter((element) => !skipped.has(element.id));
  const superseded = new Set(incomingTaken.map((element) => element.id));
  const held = new Map<E, ServerHold>();
  // A skipped element's local copy is mid-edit, whatever the saver last saw: it holds nothing of the server's now.
  for (const element of local) if (!superseded.has(element.id)) held.set(element, skipped.has(element.id) ? { state: "none" } : hold(element));
  const withState = (state: ServerHold["state"]) => local.filter((element) => held.get(element)?.state === state);
  const space = new IndexSpace();
  for (const element of winning) space.claim(indexOf(element), element.id);      // skipped ones too: the server's index, applied when the edit ends
  for (const element of dropped) space.claim(indexOf(element), element.id);      // and the ones the renderer will never take
  for (const element of withState("stored")) space.claim(indexOf(element), element.id);

  // In-flight, then unsent or edited ones: those whose index is free keep it (so nothing moves that need not), and each one in
  // the way goes just above what it hit: a copy with a new index, revision untouched.
  const moved = new Map<E, E>();
  // An element under interaction is re-keyed IN PLACE. Excalidraw's `appState.newElement` / `resizingElement` /
  // `editingTextElement` are references to the scene's own object, and the next pointer event mutates THAT object: a copy
  // installed in its place would stop receiving the rest of the gesture, and the scene and the saver would keep its first
  // frame. `index` is a plain field Excalidraw only reads (to sort and validate), nothing else holds a snapshot that must
  // differ, and a direct write bumps no revision (unlike `mutateElement`). Every other element is copied, as before.
  const rekeyed = (element: E, index: string): E => {
    if (interacting.has(element.id)) { setIndex(element, index); return element; }
    const copy = { ...element } as E;
    setIndex(copy, index);
    return copy;
  };
  const wanted = new Map<E, string | undefined>();
  const blocked: E[] = [];
  for (const element of withState("in-flight")) {
    const sent = (held.get(element) as { index: string | undefined }).index ?? indexOf(element);
    wanted.set(element, sent);
    if (!space.claim(sent, element.id)) blocked.push(element);
    else if (sent !== indexOf(element)) moved.set(element, rekeyed(element, sent!));   // undoes an earlier provisional move
  }
  for (const element of withState("none")) { wanted.set(element, indexOf(element)); if (!space.claim(indexOf(element), element.id)) blocked.push(element); }
  for (const [id, correction] of corrections) { const mine = localById.get(id)!; if (indexOf(mine) !== indexOf(correction)) moved.set(mine, rekeyed(mine, indexOf(correction)!)); }   // in place for what a gesture holds
  for (const element of blocked) moved.set(element, rekeyed(element, space.place(wanted.get(element), element.id)));
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
 * scene's elements back at the revisions the server sent, in place, so nothing the server holds reads as an edit. Returns the elements it left
 * alone because `edited` says the person has already changed them.
 */
export function adoptArrivedRevisions(scene: readonly Revisioned[], arrived: readonly Revisioned[], edited: (element: Revisioned) => boolean = () => false): Revisioned[] {
  const byId = new Map(arrived.map((element) => [element.id, element]));
  const left: Revisioned[] = [];
  for (const element of scene) {
    const incoming = byId.get(element.id);
    // An element the person edited since the load carries THEIR revision (an edit can land before the shell's onReady): putting the server's back would
    // erase it, the saver would see the stored key, and the edit would show Saved without ever being sent.
    if (incoming && edited(element)) left.push(element);
    else if (incoming) setRevision(element, incoming);
  }
  return left;
}
