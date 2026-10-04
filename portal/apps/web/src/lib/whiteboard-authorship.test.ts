// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { whiteboardIncomingWins } from "@quincy/shared";
import { mergeRemote, type MergeFns } from "./whiteboard-merge";
import { createRemoteApplier } from "./whiteboard-remote";
import { createWhiteboardSaver, type SavedElement } from "./whiteboard-saver";

/**
 * #499 (Sol 13/14, re-plan 2): the SAVER NEVER AUTHORS A REVISION. It writes no version or nonce into the scene and transmits no
 * revision the scene does not hold; the editor (or code that behaves exactly like an editor operation) authors every one. These run
 * the production saver, applier and merge against the INSTALLED Excalidraw `restoreElements` / `reconcileElements`.
 */
type El = Record<string, unknown> & SavedElement;
type Fns = { reconcileElements: (l: never, r: never, a: never) => El[]; restoreElements: (e: never, o: null) => El[] };
let excalidraw: Fns;
let fns: MergeFns<El>;
const appState = { editingTextElement: null, resizingElement: null, newElement: null } as never;
beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
  excalidraw = (await import("@excalidraw/excalidraw")) as unknown as Fns;
  fns = {
    restore: (raw) => excalidraw.restoreElements(raw as never, null),
    reconcile: (local, remote) => excalidraw.reconcileElements(local as never, remote as never, appState),
  };
});

const rect = (id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, index: "a0", version, versionNonce, isDeleted: false, seed: 1, ...extra });
/** What the saver is shown: copies nobody can write to, so an attempt to author a revision throws. */
const frozen = (elements: readonly SavedElement[]): SavedElement[] => elements.map((element) => Object.freeze({ ...element }) as SavedElement);

/** One tab against an in-memory server that keeps the winner per id by the rule the real one uses. Every revision the tab transmits is recorded. */
function tab(initial: Array<Record<string, unknown>>, rows: Map<string, El>) {
  let scene = excalidraw.restoreElements(initial as never, null);
  const sent: El[] = [];
  const saver = createWhiteboardSaver({
    getElements: () => frozen(scene),
    send: async (batch) => { for (const element of batch) { sent.push({ ...element } as El); const held = rows.get(element.id); if (!held || whiteboardIncomingWins(held as never, element as never)) rows.set(element.id, { ...element } as El); } },
  });
  saver.seed(initial as unknown as SavedElement[]);
  const applier = createRemoteApplier({
    saver,
    merge: () => (remote, hold) => { scene = mergeRemote(scene, remote as never, fns, (element) => hold(element as SavedElement)); return scene; },
    setScene: () => undefined,
    getScene: () => scene,
    interactingIds: () => new Set<string>(),
  });
  return { saver, applier, sent, get scene() { return scene; }, set scene(next: El[]) { scene = next; } };
}

describe("the saver never mutates the scene (frozen scene elements before every saver call)", () => {
  it("sends an older scene re-imported over a higher stored revision exactly as the scene holds it", async () => {
    const rows = new Map<string, El>();
    const w = tab([rect("e", 5, 50)], rows);
    w.scene = [{ ...w.scene[0]!, version: 1, versionNonce: 99 } as El];   // an older scene is loaded over e
    await w.saver.flush();                                              // frozen: a write into the scene would throw
    expect(w.sent).toEqual([expect.objectContaining({ id: "e", version: 1, versionNonce: 99 })]);
  });

  it("records a remote loser and saves without writing into the scene", async () => {
    const rows = new Map<string, El>();
    const w = tab([rect("e", 1, 5)], rows);
    w.scene = [{ ...w.scene[0]!, version: 2, versionNonce: 10, x: 5 } as El];   // A's own edit, not yet reported to anyone
    w.applier.apply([rect("e", 2, 20, { x: 9 })]);                            // B's v2/20 loses to A's v2/10
    await w.saver.flush();
    expect(w.sent).toEqual([expect.objectContaining({ id: "e", version: 2, versionNonce: 10, x: 5 })]);
  });
});

describe("a remote revision that loses never changes the winner (Sol 14 #1)", () => {
  /** A, B and C each author e:v2 at once (nonces 20, 30, 10). Delivery and A's saves run in every order. */
  const permutations = <T,>(items: readonly T[]): T[][] => (items.length <= 1 ? [[...items]] : items.flatMap((item, at) => permutations([...items.slice(0, at), ...items.slice(at + 1)]).map((rest) => [item, ...rest])));
  const authored = [rect("e", 2, 20, { x: 1 }), rect("e", 2, 30, { x: 2 }), rect("e", 2, 10, { x: 3 })] as unknown as El[];
  const [fromA, fromB, fromC] = authored as [El, El, El];
  const pick = (best: El, next: El): El => excalidraw.reconcileElements([best] as never, [next] as never, appState)[0]!;

  for (const order of permutations(["B", "C", "S"] as const)) {
    it(`order ${order.join(" ")}: every transmitted revision stays v2 and the stored winner is the one Excalidraw's reconcile picks`, async () => {
      const winner = authored.reduce(pick);
      const rows = new Map<string, El>([["e", { ...rect("e", 1, 5) } as El]]);
      const a = tab([rect("e", 1, 5)], rows);
      a.scene = [{ ...fromA } as El];                                       // A's own edit, authored v2/20
      for (const event of [...order, "S"] as const) {
        if (event === "S") await a.saver.flush();
        else { const arrived = event === "B" ? fromB : fromC; const held = rows.get("e")!; if (whiteboardIncomingWins(held as never, arrived as never)) rows.set("e", { ...arrived }); a.applier.apply([{ ...arrived }]); }   // the server stores the winner and relays it to A
      }
      for (const element of a.sent) expect(element.version, `transmitted v${element.version}/${element.versionNonce}`).toBe(2);
      expect(rows.get("e")).toMatchObject({ version: 2, versionNonce: winner.versionNonce });
      expect(a.scene[0]).toMatchObject({ version: 2, versionNonce: winner.versionNonce });
      expect(winner.versionNonce).toBe(10);
    });
  }
});
