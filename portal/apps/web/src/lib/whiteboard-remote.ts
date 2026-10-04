import { whiteboardIncomingWins } from "@quincy/shared";
import { appliedFromRemote, type SavedElement, type ServerHold, type WhiteboardSaver } from "./whiteboard-saver";

/**
 * #499: how other people's elements reach the board and the saver, in one place so the component and the model test run the
 * same code. A batch is merged into the scene (`merge`, the controller's `applyRemote`), and exactly what the scene took of it
 * is recorded as stored. Excalidraw never replaces an element that is being edited, resized or drawn: a remote winner it
 * skipped for that reason is DEFERRED (the highest version per id) and replayed once the interaction ends. Batches that arrive before the
 * editor is ready wait, each as the batch it arrived in (two versions of one id in one reconcile make Excalidraw rename the
 * duplicate and keep both).
 */
export type RemoteApplierOptions = {
  saver: WhiteboardSaver;
  /** Merges a batch into the board and returns every element now on it; null while the editor is not ready. */
  merge: () => ((remote: Array<Record<string, unknown>>, hold: (element: SavedElement) => ServerHold) => readonly SavedElement[]) | null;
  /** Records the scene the board now holds, before the editor's own change event, so nothing looks "gone". */
  setScene: (scene: SavedElement[]) => void;
  getScene: () => readonly SavedElement[];
  /** The ids being edited, resized or drawn right now: the only winners worth deferring (Excalidraw keeps those elements as they are). */
  interactingIds: () => ReadonlySet<string>;
  /** Ids a winner of which the scene never took (the renderer dropped it, e.g. a live 0x0 element): they are the server's, so this tab must never author a deletion for them. */
  forget?: (ids: readonly string[]) => void;
  /** Called before every merge reads the scene: the host settles anything the editor did that it has not reported yet (a vanished element's deletion, `whiteboard-vanish.ts`). */
  settle?: () => void;
};

export function createRemoteApplier({ saver, merge, setScene, getScene, interactingIds, forget, settle }: RemoteApplierOptions) {
  const pending: Array<Array<Record<string, unknown>>> = [];
  const deferred = new Map<string, Record<string, unknown>>();
  let applying = false;

  const apply = (remote: Array<Record<string, unknown>>) => {
    const into = merge();
    if (!into) { pending.push(remote); return; }
    settle?.();                                    // what the editor dropped without telling us is settled before the merge reads the scene
    // A deferred winner means the server holds something else of that element than the copy shown (an ack of the shown
    // revision does not change that), so what is shown is not "stored" and may yield its index until the winner is applied.
    const scene = into(remote, (element) => (deferred.has(element.id) ? { state: "none" } : saver.hold(element))) as SavedElement[];
    setScene(scene);
    saver.serverHas(remote.map((element) => String(element.id)));   // the server holds these, whether or not the scene took them
    saver.adoptRemote(appliedFromRemote(remote as unknown as SavedElement[], scene));
    // A remote winner the scene did not take is deferred ONLY when an interaction holds that element right now (Excalidraw skips
    // it): it replays once no interaction is left, so it can never be deferred again. One the renderer simply dropped (it is not in
    // the scene at all) will never be taken: it is forgotten, never replayed. One the local copy beats is rightly dropped.
    const busy = interactingIds();
    const never: string[] = [];
    const held = new Map(scene.map((element) => [element.id, element]));
    for (const incoming of remote as unknown as SavedElement[]) {
      const local = held.get(incoming.id);
      // Accepted gap (docs/lessons.md, #499 round 10): an exact version + versionNonce tie is read as "same element", as in Excalidraw's own
      // reconcileElements; two different payloads tying needs the same 31-bit nonce drawn twice (~1 in 2^31) and gains a writer nothing.
      const taken = local !== undefined && local.version === incoming.version && local.versionNonce === incoming.versionNonce;
      const queued = deferred.get(incoming.id) as SavedElement | undefined;
      if (taken) { if (queued && !whiteboardIncomingWins(incoming, queued)) deferred.delete(incoming.id); continue; }
      if (local && !whiteboardIncomingWins(local, incoming)) continue;
      if (!busy.has(incoming.id)) { if (!local) never.push(incoming.id); if (queued && whiteboardIncomingWins(queued, incoming)) deferred.delete(incoming.id); continue; }
      if (!queued || whiteboardIncomingWins(queued, incoming)) deferred.set(incoming.id, incoming);
    }
    if (never.length > 0) forget?.(never);
  };
  /** After every editor change: once no interaction holds an element, replay what was deferred. */
  const replay = () => {
    if (applying || deferred.size === 0 || !merge() || interactingIds().size > 0) return;
    // Whatever the person has since made newer than a deferred winner no longer needs it.
    const local = new Map(getScene().map((element) => [element.id, element]));
    for (const [id, incoming] of deferred) { const mine = local.get(id); if (mine && !whiteboardIncomingWins(mine, incoming as unknown as SavedElement)) deferred.delete(id); }
    if (deferred.size === 0) return;
    applying = true;
    try { const batch = [...deferred.values()]; deferred.clear(); apply(batch); }
    finally { applying = false; }
  };
  const drain = () => { for (const batch of pending.splice(0)) apply(batch); };
  return { apply, replay, drain };
}
