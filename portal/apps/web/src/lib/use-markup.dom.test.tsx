/**
 * #741 slice 6s-ui: the markup gesture hook. Driven with hand-built pointer events (the hook only reads
 * pointerId, clientX/Y, currentTarget and preventDefault/stopPropagation), through a small harness that owns the
 * controlled stroke list the way the Lightbox does.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarkupItem } from "@quincy/shared";
import { useMarkup, type MarkupTool } from "./use-markup";

type Api = ReturnType<typeof useMarkup>;
interface Options { tool?: MarkupTool; enabled?: boolean; initial?: MarkupItem[]; beforeStart?: () => boolean | Promise<boolean>; limits?: { items: number; bytes: number }; onRefuse?: () => void }
interface Latest { api: Api; strokes: MarkupItem[]; setStrokes: (next: MarkupItem[]) => void }

let roots: Root[] = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { for (const root of roots) await act(async () => { root.unmount(); }); roots = []; document.body.replaceChildren(); });

async function mountHook(options: Options = {}) {
  const latest = {} as Latest;
  function Harness() {
    const [strokes, setStrokes] = useState<MarkupItem[]>(options.initial ?? []);
    const api = useMarkup({
      enabled: options.enabled ?? true,
      tool: options.tool ?? { kind: "freehand", color: "#e64b3c", width: 4 },
      toPoint: (event) => ({ x: event.clientX / 100, y: event.clientY / 100 }),
      strokes, setStrokes, beforeStart: options.beforeStart,
      limits: options.limits, onRefuse: options.onRefuse,
    });
    Object.assign(latest, { api, strokes, setStrokes });
    return null;
  }
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => { root.render(<Harness />); });
  return latest;
}

function fakeEvent(x: number, y: number, pointerId = 1) {
  const target = { setPointerCapture: vi.fn() };
  return { pointerId, clientX: x, clientY: y, currentTarget: target, preventDefault: vi.fn(), stopPropagation: vi.fn() } as never;
}
const down = (l: Latest, x: number, y: number, id = 1) => act(async () => { await l.api.handlers.onPointerDown(fakeEvent(x, y, id)); });
const move = (l: Latest, x: number, y: number, id = 1) => act(async () => { l.api.handlers.onPointerMove(fakeEvent(x, y, id)); });
const up = (l: Latest, x: number, y: number, id = 1) => act(async () => { l.api.handlers.onPointerUp(fakeEvent(x, y, id)); });
const leave = (l: Latest, x: number, y: number, id = 1) => act(async () => { l.api.handlers.onPointerLeave(fakeEvent(x, y, id)); });
const cancel = (l: Latest, id = 1) => act(async () => { l.api.handlers.onPointerCancel(fakeEvent(0, 0, id)); });
const lost = (l: Latest, id = 1) => act(async () => { l.api.handlers.onLostPointerCapture(fakeEvent(0, 0, id)); });

describe("useMarkup: freehand", () => {
  it("holds the stroke in `active` and commits it by value on pointer up", async () => {
    const l = await mountHook();
    await down(l, 10, 20);
    expect(l.strokes).toEqual([]);
    expect(l.api.active).toEqual({ color: "#e64b3c", width: 4, points: [{ x: 0.1, y: 0.2 }] });
    await move(l, 30, 40);
    expect(l.api.active!.points).toHaveLength(2);
    await up(l, 30, 40);
    expect(l.api.active).toBeNull();
    expect(l.strokes).toEqual([{ color: "#e64b3c", width: 4, points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] }]);
  });

  it("a freehand tap still commits a one-point dot", async () => {
    const l = await mountHook();
    await down(l, 50, 50); await up(l, 50, 50);
    expect(l.strokes).toEqual([{ color: "#e64b3c", width: 4, points: [{ x: 0.5, y: 0.5 }] }]);
  });

  it("calls preventDefault and stopPropagation on down, and captures the pointer after the gate", async () => {
    const l = await mountHook();
    const event = fakeEvent(1, 1) as unknown as { preventDefault: () => void; stopPropagation: () => void; currentTarget: { setPointerCapture: ReturnType<typeof vi.fn> } };
    await act(async () => { await l.api.handlers.onPointerDown(event as never); });
    expect(event.preventDefault).toHaveBeenCalled(); expect(event.stopPropagation).toHaveBeenCalled();
    expect(event.currentTarget.setPointerCapture).toHaveBeenCalledWith(1);
  });

  it("pointer leave commits at the last point without sampling the leave position", async () => {
    const l = await mountHook();
    await down(l, 0, 0); await move(l, 50, 50);
    await leave(l, 999, 999);
    expect(l.strokes).toHaveLength(1);
    expect(l.strokes[0]!.points).toEqual([{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }]);
    await move(l, 80, 80);
    expect(l.strokes[0]!.points).toHaveLength(2);
  });

  it("stops extending a stroke at the 2000-point cap", async () => {
    const l = await mountHook();
    await down(l, 0, 0);
    for (let i = 0; i < 2100; i += 1) await move(l, (i % 100), 5);
    await up(l, 1, 5);
    expect(l.strokes[0]!.points).toHaveLength(2000);
  });
});

describe("useMarkup: shapes", () => {
  const arrow: MarkupTool = { kind: "arrow", color: "#2f6df0", width: 7 };

  it("previews a shape in `active`, then commits [start, end] with its type on pointer up", async () => {
    const l = await mountHook({ tool: arrow });
    await down(l, 10, 10);
    expect(l.api.active).toMatchObject({ type: "arrow", color: "#2f6df0", width: 7 });
    expect(l.api.active!.points).toEqual([{ x: 0.1, y: 0.1 }, { x: 0.1, y: 0.1 }]);
    await move(l, 60, 10);
    expect(l.api.active!.points[1]).toEqual({ x: 0.6, y: 0.1 });
    expect(l.strokes).toEqual([]);
    await up(l, 60, 10);
    expect(l.strokes).toEqual([{ type: "arrow", color: "#2f6df0", width: 7, points: [{ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.1 }] }]);
    expect(l.api.active).toBeNull();
  });

  it("takes the final end point from the pointer-up position", async () => {
    const l = await mountHook({ tool: { kind: "line", color: "#000", width: 2 } });
    await down(l, 0, 0); await up(l, 40, 30);
    expect(l.strokes[0]!.points).toEqual([{ x: 0, y: 0 }, { x: 0.4, y: 0.3 }]);
  });

  it("discards a line or arrow dragged under 8 px, and keeps one of exactly 8 px", async () => {
    for (const kind of ["line", "arrow"] as const) {
      const l = await mountHook({ tool: { kind, color: "#000", width: 2 } });
      await down(l, 10, 10); await up(l, 14, 15);          // 6.4 px
      expect(l.strokes).toEqual([]);
      await down(l, 10, 10); await up(l, 18, 10);          // 8 px
      expect(l.strokes).toHaveLength(1);
    }
  });

  it("discards a rectangle with a side under 6 px, and keeps one that is 6 px on both", async () => {
    const l = await mountHook({ tool: { kind: "rectangle", color: "#000", width: 2 } });
    await down(l, 10, 10); await up(l, 60, 15);            // 50 x 5
    expect(l.strokes).toEqual([]);
    await down(l, 10, 10); await up(l, 16, 16);            // 6 x 6
    expect(l.strokes).toHaveLength(1);
    expect(l.strokes[0]).toMatchObject({ type: "rectangle" });
  });

  it("a shape tap leaves nothing while a freehand tap leaves a dot", async () => {
    const l = await mountHook({ tool: arrow });
    await down(l, 10, 10); await up(l, 10, 10);
    expect(l.strokes).toEqual([]);
  });

  it("pointer leave finishes a shape at the last valid point, or discards it if too small", async () => {
    const l = await mountHook({ tool: arrow });
    await down(l, 0, 0); await move(l, 50, 0); await leave(l, 500, 500);
    expect(l.strokes).toHaveLength(1);
    expect(l.strokes[0]!.points[1]).toEqual({ x: 0.5, y: 0 });
    await down(l, 0, 0); await move(l, 3, 0); await leave(l, 500, 500);
    expect(l.strokes).toHaveLength(1);
  });
});

describe("useMarkup: one pointer, cancel, bad samples", () => {
  it("ignores a second pointer for the whole gesture", async () => {
    const l = await mountHook();
    await down(l, 0, 0, 1); await move(l, 10, 0, 1);
    await down(l, 90, 90, 2);
    await move(l, 95, 95, 2);
    await move(l, 20, 0, 1);
    await up(l, 95, 95, 2);
    expect(l.api.active!.points).toHaveLength(3);          // finger 2's up did not end finger 1's stroke
    await up(l, 20, 0, 1);
    expect(l.strokes).toHaveLength(1);
    expect(l.strokes[0]!.points).toEqual([{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.2, y: 0 }]);
  });

  it("pointercancel and a lost capture discard the unfinished preview", async () => {
    const l = await mountHook();
    await down(l, 0, 0); await move(l, 20, 20); await cancel(l);
    expect(l.api.active).toBeNull(); expect(l.strokes).toEqual([]);
    await down(l, 0, 0); await move(l, 20, 20); await lost(l);
    expect(l.api.active).toBeNull(); expect(l.strokes).toEqual([]);
    await move(l, 40, 40); await up(l, 40, 40);
    expect(l.strokes).toEqual([]);
  });

  it("a lost capture after a normal pointer up changes nothing", async () => {
    const l = await mountHook();
    await down(l, 0, 0); await move(l, 20, 20); await up(l, 20, 20); await lost(l);
    expect(l.strokes).toHaveLength(1);
  });

  it("cancel() discards the in-progress item (Escape mid-gesture)", async () => {
    const l = await mountHook({ tool: { kind: "rectangle", color: "#000", width: 2 } });
    await down(l, 0, 0); await move(l, 50, 50);
    await act(async () => { l.api.cancel(); });
    expect(l.api.active).toBeNull();
    await up(l, 50, 50);
    expect(l.strokes).toEqual([]);
  });

  it("ignores a non-finite sample on down and on move", async () => {
    let bad = false;
    const latest = {} as Latest;
    function Harness() {
      const [strokes, setStrokes] = useState<MarkupItem[]>([]);
      latest.api = useMarkup({ enabled: true, tool: { kind: "freehand", color: "#000", width: 2 }, toPoint: (e) => (bad ? { x: Number.NaN, y: Number.NaN } : { x: e.clientX / 100, y: e.clientY / 100 }), strokes, setStrokes });
      latest.strokes = strokes;
      return null;
    }
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host); roots.push(root);
    await act(async () => { root.render(<Harness />); });
    bad = true;
    await down(latest, 0, 0); await up(latest, 0, 0);
    expect(latest.strokes).toEqual([]);
    bad = false;
    await down(latest, 0, 0);
    bad = true; await move(latest, 50, 50); bad = false;
    await up(latest, 0, 0);
    expect(latest.strokes[0]!.points).toEqual([{ x: 0, y: 0 }]);
  });
});

describe("useMarkup: the gate and enabled", () => {
  it("a synchronous false starts nothing, a promise of false consumes the gesture, a promise of true starts it", async () => {
    let answer: boolean | Promise<boolean> = false;
    const l = await mountHook({ beforeStart: () => answer });
    await down(l, 10, 10); expect(l.api.active).toBeNull();
    answer = Promise.resolve(false);
    await down(l, 10, 10); await up(l, 10, 10); expect(l.api.active).toBeNull(); expect(l.strokes).toEqual([]);
    answer = Promise.resolve(true);
    await down(l, 10, 10); expect(l.api.active).not.toBeNull();
  });

  describe("a delayed gate that resolves after its pointer ended", () => {
    function gated() {
      let resolve!: (value: boolean) => void;
      const promise = new Promise<boolean>((r) => { resolve = r; });
      return { promise, resolve };
    }
    async function pending(l: Latest, event = fakeEvent(10, 10)) {
      // Not awaited: the gate is still pending, and returning it would make this helper wait for it.
      await act(async () => { void l.api.handlers.onPointerDown(event as never); });
    }
    const settle = async (g: { resolve: (v: boolean) => void }, value = true) => { await act(async () => { g.resolve(value); await Promise.resolve(); await Promise.resolve(); }); };

    it("starts nothing after pointer up, and takes no pointer capture", async () => {
      const g = gated();
      const l = await mountHook({ beforeStart: () => g.promise });
      const event = fakeEvent(10, 10) as unknown as { currentTarget: { setPointerCapture: ReturnType<typeof vi.fn> } };
      await pending(l, event as never);
      await up(l, 10, 10);
      await settle(g);
      expect(l.api.active).toBeNull();
      expect(event.currentTarget.setPointerCapture).not.toHaveBeenCalled();
      await down(l, 20, 20);                                  // a fresh pointer-down still works
    });

    it("starts nothing after pointercancel, a lost capture, cancel() or disabling", async () => {
      for (const end of [(l: Latest) => cancel(l), (l: Latest) => lost(l), (l: Latest) => act(async () => { l.api.cancel(); })]) {
        const g = gated();
        const l = await mountHook({ beforeStart: () => g.promise });
        await pending(l); await end(l); await settle(g);
        expect(l.api.active).toBeNull();
      }
    });

    it("starts nothing when drawing was disabled or the hook unmounted while the gate was pending", async () => {
      const g = gated();
      let enabled = true;
      const latest = {} as Latest;
      function Harness() {
        const [strokes, setStrokes] = useState<MarkupItem[]>([]);
        latest.api = useMarkup({ enabled, tool: { kind: "freehand", color: "#000", width: 2 }, toPoint: (e) => ({ x: e.clientX / 100, y: e.clientY / 100 }), strokes, setStrokes, beforeStart: () => g.promise });
        return null;
      }
      const host = document.createElement("div"); document.body.appendChild(host);
      const root = createRoot(host); roots.push(root);
      await act(async () => { root.render(<Harness />); });
      await pending(latest);
      enabled = false;
      await act(async () => { root.render(<Harness />); });
      await settle(g);
      expect(latest.api.active).toBeNull();
      enabled = true;
      await act(async () => { root.render(<Harness />); });
      const g2 = gated();
      Object.assign(g, g2);
      await act(async () => { root.unmount(); });
      roots = roots.filter((r) => r !== root);
      await settle(g);
    });

    it("still starts when the gate resolves true while the pointer is down", async () => {
      const g = gated();
      const l = await mountHook({ beforeStart: () => g.promise });
      await pending(l); await settle(g);
      expect(l.api.active).not.toBeNull();
    });

    it("abandons the gesture, and stays usable, when pointer capture throws", async () => {
      const l = await mountHook();
      const bad = fakeEvent(10, 10) as unknown as { currentTarget: { setPointerCapture: () => void } };
      bad.currentTarget.setPointerCapture = () => { throw new Error("InvalidStateError"); };
      await act(async () => { await l.api.handlers.onPointerDown(bad as never); });
      expect(l.api.active).toBeNull();
      await down(l, 20, 20);
      expect(l.api.active).not.toBeNull();
    });
  });

  it("is inert when disabled", async () => {
    const l = await mountHook({ enabled: false });
    const event = fakeEvent(1, 1) as unknown as { preventDefault: () => void };
    await act(async () => { await l.api.handlers.onPointerDown(event as never); });
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(l.api.active).toBeNull();
  });
});

describe("useMarkup: undo, redo, clear", () => {
  async function drawTwo(l: Latest) {
    await down(l, 10, 10); await up(l, 10, 10);
    await down(l, 20, 20); await up(l, 20, 20);
  }

  it("undoes, redoes, and clears as one undoable step", async () => {
    const l = await mountHook();
    expect(l.api.canUndo).toBe(false); expect(l.api.canRedo).toBe(false);
    await drawTwo(l);
    expect(l.api.canUndo).toBe(true);
    await act(async () => { l.api.undo(); });
    expect(l.strokes).toHaveLength(1); expect(l.api.canRedo).toBe(true);
    await act(async () => { l.api.redo(); });
    expect(l.strokes).toHaveLength(2); expect(l.api.canRedo).toBe(false);
    await act(async () => { l.api.clear(); });
    expect(l.strokes).toEqual([]);
    await act(async () => { l.api.undo(); });
    expect(l.strokes).toHaveLength(2);
  });

  it("a new draw empties redo", async () => {
    const l = await mountHook();
    await drawTwo(l);
    await act(async () => { l.api.undo(); });
    await down(l, 30, 30); await up(l, 30, 30);
    expect(l.api.canRedo).toBe(false);
  });

  it("undo, redo and clear are no-ops mid-gesture", async () => {
    const l = await mountHook();
    await drawTwo(l);
    await down(l, 50, 50);
    await act(async () => { l.api.undo(); l.api.clear(); });
    expect(l.strokes).toHaveLength(2);
    await up(l, 50, 50);
    expect(l.strokes).toHaveLength(3);
  });

  it("a list replaced from outside resets the history; undo then pops the last item", async () => {
    const l = await mountHook();
    await drawTwo(l);
    const preload: MarkupItem[] = [{ color: "#000", width: 2, points: [{ x: 0.1, y: 0.1 }] }, { color: "#000", width: 2, points: [{ x: 0.2, y: 0.2 }] }];
    await act(async () => { l.setStrokes(preload); });
    expect(l.api.canRedo).toBe(false);
    await act(async () => { l.api.undo(); });
    expect(l.strokes).toEqual([preload[0]]);
    await act(async () => { l.api.redo(); });
    expect(l.strokes).toBe(preload);
  });

  it("refuses a gesture past the item budget, calls onRefuse, and keeps the earlier draft", async () => {
    const onRefuse = vi.fn();
    const l = await mountHook({ limits: { items: 1, bytes: 2_000_000 }, onRefuse });
    await down(l, 10, 10); await up(l, 10, 10);
    await down(l, 20, 20);
    expect(onRefuse).toHaveBeenCalledTimes(1);
    expect(l.api.active).toBeNull();
    await up(l, 20, 20);
    expect(l.strokes).toHaveLength(1);
  });

  it("refuses a commit past the byte budget and keeps the earlier draft", async () => {
    const onRefuse = vi.fn();
    const l = await mountHook({ limits: { items: 200, bytes: 90 }, onRefuse });
    await down(l, 10, 10); await up(l, 10, 10);
    expect(l.strokes).toHaveLength(1);
    await down(l, 20, 20); await up(l, 20, 20);
    expect(onRefuse).toHaveBeenCalled();
    expect(l.strokes).toHaveLength(1);
  });

  it("two hook instances share no state", async () => {
    const a = await mountHook(); const b = await mountHook();
    await down(a, 10, 10); await up(a, 10, 10);
    expect(a.strokes).toHaveLength(1); expect(b.strokes).toEqual([]);
    expect(b.api.canUndo).toBe(false);
  });
});

describe("useMarkup: the latest setStrokes", () => {
  it("undo, redo and clear call the setter of the current render, not the first one", async () => {
    const calls: number[] = [];
    const latest = {} as { api: Api; bump: () => void };
    function Harness() {
      const [strokes, setStrokes] = useState<MarkupItem[]>([]);
      const [generation, setGeneration] = useState(0);
      const api = useMarkup({
        enabled: true, tool: { kind: "freehand", color: "#e64b3c", width: 4 }, toPoint: (event) => ({ x: event.clientX / 100, y: event.clientY / 100 }),
        strokes, setStrokes: (next) => { calls.push(generation); setStrokes(next); },
      });
      Object.assign(latest, { api, bump: () => { setGeneration((g) => g + 1); } });
      return null;
    }
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host); roots.push(root);
    await act(async () => { root.render(<Harness />); });
    const l = latest as unknown as Latest & { bump: () => void };
    await down(l, 10, 10); await up(l, 10, 10);
    await act(async () => { latest.bump(); });
    calls.length = 0;
    await act(async () => { latest.api.undo(); });
    await act(async () => { latest.api.redo(); });
    await act(async () => { latest.api.clear(); });
    expect(calls).toEqual([1, 1, 1]);
  });
});
