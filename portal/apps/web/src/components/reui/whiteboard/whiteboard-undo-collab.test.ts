// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * #551 items 1 and 2, against the REAL editor (history, store and reconcile of the installed Excalidraw) and the production
 * controller (`applyRemote`, `applyLocal`), not a fake API. The history buttons are the editor's own, read the way the footer
 * reads them. Findings these pin:
 *  - a user CAN undo their own winning delete (the "undo greys out" in the #533 browser pass was the stale footer read, not the stack);
 *  - the zero-size sweep leaves a creation entry in the undo stack that undoes to nothing visible (not user-reachable: Stats clamps to 1x1).
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const proxy: unknown = new Proxy(function () {}, { get: (_t, key) => (key === "canvas" ? document.createElement("canvas") : key === "measureText" ? () => ({ width: 1 }) : proxy), apply: () => proxy });
(globalThis as { FontFace?: unknown }).FontFace = class { load() { return Promise.resolve(this); } };
(globalThis as { Path2D?: unknown }).Path2D = class {};
Object.defineProperty(document, "fonts", { configurable: true, value: { add() {}, has: () => true, load: async () => [], ready: Promise.resolve(), check: () => true, forEach() {} } });

type El = Record<string, unknown> & { id: string; version: number; versionNonce: number; isDeleted: boolean };
type Api = {
  updateScene: (s: Record<string, unknown>) => void;
  getSceneElementsIncludingDeleted: () => El[];
  getSceneElements: () => El[];
  getAppState: () => Record<string, unknown>;
};
let x: { Excalidraw: never; CaptureUpdateAction: { IMMEDIATELY: unknown; NEVER: unknown }; convertToExcalidrawElements: (e: unknown[]) => El[] };
let canvas: typeof import("./whiteboard-canvas");
beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() => proxy) as never;
  x = (await import("@excalidraw/excalidraw")) as never;
  canvas = await import("./whiteboard-canvas");
});

let root: Root | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); root = null; document.body.replaceChildren(); });

async function editor() {
  let api: Api | undefined;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(createElement(x.Excalidraw, { excalidrawAPI: (a: Api) => { api = a; } })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
  const controller = canvas.createController(api as never, {
    root: () => host, arm: () => undefined, panel: () => undefined, library: () => [], editable: () => true, remoteApplied: () => undefined,
  });
  const button = (which: "undo" | "redo") => document.querySelector<HTMLButtonElement>(`[data-testid=button-${which}]`)!;
  const press = async (which: "undo" | "redo") => { await act(async () => { button(which).click(); await new Promise((r) => setTimeout(r, 30)); }); };
  const live = () => api!.getSceneElements().map((e) => e.id);
  return { api: api!, controller, button, press, live };
}
const rect = (id: string, extra: Record<string, unknown> = {}) => ({ ...x.convertToExcalidrawElements([{ type: "rectangle", x: 0, y: 0, width: 100, height: 60, ...extra }])[0]!, id }) as El;
const none = () => ({ state: "none" }) as never;

describe("undo after a winning delete (#551 item 1)", () => {
  async function race(winner: "delete" | "move") {
    const e = await editor();
    const created = rect("a");
    await act(async () => { e.api.updateScene({ elements: [created], captureUpdate: x.CaptureUpdateAction.IMMEDIATELY }); });
    // The user's own Delete.
    const deleted = { ...created, isDeleted: true, version: created.version + 1, versionNonce: 5 };
    await act(async () => { e.api.updateScene({ elements: [deleted], captureUpdate: x.CaptureUpdateAction.IMMEDIATELY }); });
    // B's concurrent move of the same base revision, arriving after: it wins by version (or ties and loses on nonce).
    const move = winner === "move"
      ? { ...created, x: 40, version: deleted.version + 1, versionNonce: 9 }
      : { ...created, x: 40, version: deleted.version, versionNonce: 99999 };   // same version, higher nonce: the local delete wins
    await act(async () => { e.controller.applyRemote?.([move as never], none); });
    return e;
  }

  it("delete wins: the element stays deleted, and the person's own undo brings it back", async () => {
    const e = await race("delete");
    expect(e.live()).toEqual([]);
    expect(e.button("undo").disabled).toBe(false);
    await e.press("undo");
    expect(e.live()).toEqual(["a"]);
    await e.press("redo");
    expect(e.live()).toEqual([]);
  });

  it("move wins: the element is live again and undo is still available", async () => {
    const e = await race("move");
    expect(e.live()).toEqual(["a"]);
    expect(e.button("undo").disabled).toBe(false);
  });
});

describe("undo after the zero-size sweep (#551 item 2)", () => {
  it("a swept creation leaves a no-op undo entry; undo then redo restores nothing and nothing loops", async () => {
    const e = await editor();
    const zero = { ...rect("z"), width: 0, height: 0 };
    await act(async () => { e.api.updateScene({ elements: [zero], captureUpdate: x.CaptureUpdateAction.IMMEDIATELY }); });
    // What handleChange does on seeing it: drop it, never recorded.
    await act(async () => { e.api.updateScene({ elements: [], captureUpdate: x.CaptureUpdateAction.NEVER }); });
    // Undo is enabled: the creation entry is still on the stack although the element it made is gone.
    expect(e.button("undo").disabled).toBe(false);
    expect(e.button("redo").disabled).toBe(true);
    await e.press("undo");
    // Pressing it changes nothing visible and flips the pair: undo greys, redo lights (the #533 browser observation).
    expect(e.live()).toEqual([]);
    expect(e.button("undo").disabled).toBe(true);
    expect(e.button("redo").disabled).toBe(false);
    // Redo re-applies the creation, so the raw editor has the 0x0 shape back; the board's `handleChange` sweeps it again
    // (once, with NEVER), so a redo is a visible no-op there too and the pair settles. Recording the sweep as an undoable
    // step would make undo resurrect the 0x0 shape for the sweep to drop again, so it is not a clear fix. Unreachable today
    // (Stats clamps to 1x1), left as a finding.
    await e.press("redo");
    expect(e.api.getSceneElements().map((el) => el.width)).toEqual([0]);
  });
});
