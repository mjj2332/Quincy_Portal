// @vitest-environment happy-dom
import { act, createElement, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { whiteboardIncomingWins } from "@quincy/shared";
import { createChangeTracker } from "@/lib/whiteboard-changes";
import { createRemoteApplier } from "@/lib/whiteboard-remote";
import { createWhiteboardSaver, type SavedElement } from "@/lib/whiteboard-saver";

/**
 * #499 browser pass (B-11): after Archive -> Restore a board mounted afresh (new socket, `init` in edit mode), the user moved a shape ONCE, no
 * elements frame went out and the status stayed "Saved". Production controller, change tracker, saver, applier and `useAutosave`, wired as
 * `ProjectWhiteboard` and the canvas's `handleChange` wire them, over a fake editor API and the installed Excalidraw functions. The first edit
 * after a mount must be classified local, mark the board dirty, be sent, and show Saved only after the acknowledgement.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type El = SavedElement & Record<string, unknown>;
let canvas: typeof import("./whiteboard-canvas");
let excalidraw: { hashElementsVersion: (elements: readonly unknown[]) => number; restoreElements: (e: never, o: null) => El[] };
beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
  canvas = await import("./whiteboard-canvas");
  excalidraw = (await import("@excalidraw/excalidraw")) as unknown as typeof excalidraw;
});
const row = (id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}) => ({ id, type: "rectangle", x: 0, y: 0, width: 10, height: 10, index: "a0", version, versionNonce, isDeleted: false, seed: 1, ...extra });

let root: Root | null = null;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { if (root) act(() => root!.unmount()); root = null; document.body.replaceChildren(); vi.useRealTimers(); });

/** A board that mounts now with the server's `rows`, in `mode`. */
function mountBoard(rows: Array<Record<string, unknown>>, mode: "edit" | "view") {
  const server = new Map<string, El>(rows.map((entry) => [String(entry.id), { ...entry } as El]));
  let elements = excalidraw.restoreElements(structuredClone(rows) as never, null);   // initialData: the editor's own restore (repairs indices, bumping revisions)
  const tracker = createChangeTracker();
  let seen: SavedElement[] = elements;
  const sent: El[] = []; const acks: Array<() => void> = [];
  let modeNow = mode; let armed = false; let loaded = false; let lastHash: number | null = null;
  let dirty: () => void = () => undefined;
  const statuses: string[] = [];
  const saver = createWhiteboardSaver({
    getElements: () => seen,
    send: (batch) => new Promise<void>((resolve) => { for (const element of batch) sent.push({ ...element } as El); acks.push(() => { for (const element of batch) { const held = server.get(element.id); if (!held || whiteboardIncomingWins(held as never, element as never)) server.set(element.id, { ...element } as El); } resolve(); }); }),
  });
  saver.seed(structuredClone(rows) as unknown as SavedElement[]);   // `init`: what the server sent
  // handleChange, as the canvas runs it (the part that decides what an edit is).
  const handleChange = () => {
    const scene = elements; seen = scene as unknown as SavedElement[];
    const hash = excalidraw.hashElementsVersion(scene);
    if (hash === lastHash) return;
    lastHash = hash;
    if (!loaded) { tracker.seed(scene); loaded = true; return; }
    if (tracker.classify(scene, hash) === "remote") return;
    if (armed) dirty();
  };
  const api = {
    getSceneElementsIncludingDeleted: () => elements, getSceneElements: () => elements, getAppState: () => ({}), getFiles: () => ({}),
    updateScene: (update: { elements?: El[] }) => { if (update.elements) { elements = update.elements; handleChange(); } },
  };
  const controller = canvas.createController(api as never, { root: () => null, arm: () => { armed = true; }, panel: () => undefined, library: () => [], editable: () => true, remoteApplied: (hash, taken) => tracker.remoteApplied(hash, [], taken), edited: (element) => tracker.editedSinceLoad(element) });
  const applier = createRemoteApplier({
    saver,
    merge: () => (remote, hold) => controller.applyRemote(remote, (element) => hold(element as unknown as SavedElement)) as unknown as SavedElement[],
    setScene: (scene) => { seen = scene; },
    getScene: () => seen,
    interactingIds: () => new Set<string>(),
  });
  function Harness({ paused }: { paused: boolean }) {
    const options = useRef({ onSave: async () => { if (modeNow === "view") return "skipped" as const; await saver.flush(); }, changeDelay: 10, autosaveDelay: 100, onSaveStatusChange: (status: string) => statuses.push(status) } as never);
    const { markDirty } = canvas.useAutosave(api as never, options, paused);
    useEffect(() => { dirty = markDirty; }, [markDirty]);
    return null;
  }
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const render = (paused: boolean) => act(() => { root!.render(createElement(Harness, { paused })); });
  render(mode === "view");
  handleChange();                                            // the editor's first change event (loaded)
  return {
    server, sent, statuses, applier,
    get scene() { return elements; },
    /** onReady: the shell puts the server's revisions back in place. */
    ready: () => { controller.adoptRevisions(structuredClone(rows) as never); },
    /** The server's `mode` frame (or an init in that mode). */
    setMode: (next: "edit" | "view") => { modeNow = next; render(next === "view"); },
    /** The person moves a shape: the editor's pointer handler mutates it in place (version + 1, a new nonce), then reports a change. */
    move: (id: string, x: number, nonce: number) => { armed = true; const element = elements.find((entry) => entry.id === id)!; Object.assign(element, { x, version: element.version + 1, versionNonce: nonce }); handleChange(); },
    /** The same move, but the editor has not reported it yet when `ready` runs (the edit lands in the same window). */
    moveSilently: (id: string, x: number, nonce: number) => { armed = true; const element = elements.find((entry) => entry.id === id)!; Object.assign(element, { x, version: element.version + 1, versionNonce: nonce }); },
    report: () => handleChange(),
    ack: () => acks.splice(0).forEach((resolve) => resolve()),
    advance: (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); }),
  };
}

const rows = () => [row("a", 3, 31, { index: "a0" }), row("b", 2, 22, { index: "a1" })];
async function expectEditSynced(board: ReturnType<typeof mountBoard>, x: number, nonce: number) {
  await board.advance(100);
  expect(board.sent, "an elements frame carrying the move").toEqual([expect.objectContaining({ id: "a", x, versionNonce: nonce, version: 4 })]);
  expect(board.statuses).not.toContain("saved");               // sent, not acknowledged
  board.ack();
  await board.advance(0);
  expect(board.statuses.at(-1)).toBe("saved");
  expect(board.server.get("a")).toMatchObject({ x, version: 4, versionNonce: nonce });
}

describe("a board mounted after a restore: the first edit is a local, dirty, sent edit (#499 browser pass B-11)", () => {
  it("init in edit mode, onReady, then one move", async () => {
    const board = mountBoard(rows(), "edit");
    board.ready();
    board.move("a", 50, 77);
    await expectEditSynced(board, 50, 77);
  });

  it("variant: the mount follows a view-only init and a mode:edit frame arrives before the first edit", async () => {
    const board = mountBoard(rows(), "view");
    board.ready();
    board.setMode("edit");
    board.move("a", 50, 77);
    await expectEditSynced(board, 50, 77);
  });

  it("variant: view-only, an edit-time autosave skipped, then mode:edit (the restore frame)", async () => {
    const board = mountBoard(rows(), "view");
    board.ready();
    board.move("a", 50, 77);
    await board.advance(100);
    expect(board.sent).toEqual([]);
    expect(board.statuses).not.toContain("saved");
    board.setMode("edit");
    await expectEditSynced(board, 50, 77);
  });

  it("variant: the first change after the mount carries the initial-load repair together with the user's edit", async () => {
    // Legacy rows share an index: the editor's restore of initialData repairs it, bumping revisions; the shell puts the server's back in place.
    const clashing = [row("a", 3, 31, { index: "a0" }), row("b", 2, 22, { index: "a0" })];
    const board = mountBoard(clashing, "edit");
    board.moveSilently("a", 50, 77);                           // the edit lands before the editor reports anything
    board.ready();                                             // onReady: the server's revisions go back in place
    board.report();                                            // one change event for both
    expect(board.scene.find((element) => element.id === "a")).toMatchObject({ x: 50, version: 4, versionNonce: 77 });   // the edit's revision survives
    await expectEditSynced(board, 50, 77);
  });

  it("variant: the move was already reported by the editor when onReady runs", async () => {
    const board = mountBoard(rows(), "edit");
    board.move("a", 50, 77);                                   // reported, classified, autosave armed
    board.ready();                                             // the server's revisions go back in place: not over the person's edit
    expect(board.scene.find((element) => element.id === "a")).toMatchObject({ x: 50, version: 4, versionNonce: 77 });
    await expectEditSynced(board, 50, 77);
  });

  it("variant: a remote edit of ANOTHER shape arrives between the mount and the first move", async () => {
    const board = mountBoard(rows(), "edit");
    board.ready();
    board.applier.apply([row("b", 3, 33, { index: "a1", x: 9 })]);
    board.move("a", 50, 77);
    await expectEditSynced(board, 50, 77);
  });
});
