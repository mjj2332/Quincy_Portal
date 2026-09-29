import { describe, expect, it } from "vitest";
import type { AnimateLayoutChanges } from "@dnd-kit/sortable";
import { boardAnimateLayoutChanges, flipDeltas, playFlip, type FlipSnapshot } from "./kanban-flip";

function snapshot(entries: Array<[string, string, number, number?]>): FlipSnapshot {
  return new Map(entries.map(([id, column, top, left = 0]) => [id, { column, top, left }]));
}

describe("flipDeltas (#304)", () => {
  it("gives the moved card and every card it passed, as old minus new", () => {
    // `c` (height 100) moves from third to first; `a` (80) and `b` (120) each drop by c's slot.
    const before = snapshot([["a", "s", 0], ["b", "s", 92], ["c", "s", 224]]);
    const after = snapshot([["c", "s", 0], ["a", "s", 112], ["b", "s", 204]]);
    expect(flipDeltas(before, after)).toEqual([
      { id: "c", dx: 0, dy: 224 },
      { id: "a", dx: 0, dy: -112 },
      { id: "b", dx: 0, dy: -112 },
    ]);
  });

  it("is empty when nothing moved, including sub-pixel noise", () => {
    const before = snapshot([["a", "s", 0], ["b", "s", 92.2]]);
    const after = snapshot([["a", "s", 0.3], ["b", "s", 92]]);
    expect(flipDeltas(before, after)).toEqual([]);
  });

  it("skips a card that changed column, and a card that did not exist before", () => {
    const before = snapshot([["a", "s", 0], ["b", "s", 92]]);
    const after = snapshot([["b", "s", 0], ["a", "t", 0], ["new", "s", 92]]);
    expect(flipDeltas(before, after)).toEqual([{ id: "b", dx: 0, dy: 92 }]);
  });
});

describe("playFlip (#304)", () => {
  function fakeElement() {
    const writes: string[] = [];
    const listeners = new Map<string, () => void>();
    const style = new Proxy({} as Record<string, string>, {
      set(target, key: string, value: string) {
        writes.push(`${key}=${value}`);
        target[key] = value;
        return true;
      },
    });
    const element = {
      style,
      getBoundingClientRect: () => { writes.push("reflow"); return {}; },
      addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); },
      removeEventListener: (type: string) => { listeners.delete(type); },
    };
    return { element: element as unknown as HTMLElement, writes, style, listeners };
  }

  it("inverts with no transition, forces a reflow, then eases back to rest on the motion tokens", () => {
    const { element, writes } = fakeElement();
    playFlip(element, 0, 224);
    expect(writes).toEqual([
      "transition=none",
      "transform=translate(0px, 224px)",
      "zIndex=1",
      "reflow",
      "transition=transform var(--dur-base) var(--ease-standard)",
      "transform=",
    ]);
  });

  it("clears its inline styles when the transition ends, and when cancelled", () => {
    const ended = fakeElement();
    playFlip(ended.element, 0, 10);
    ended.listeners.get("transitionend")?.();
    expect(ended.style.transition).toBe("");
    expect(ended.style.zIndex).toBe("");
    expect(ended.listeners.size).toBe(0);

    const cancelled = fakeElement();
    const cancel = playFlip(cancelled.element, 0, 10);
    cancel();
    expect(cancelled.style.transition).toBe("");
    expect(cancelled.style.transform).toBe("");
    expect(cancelled.style.zIndex).toBe("");
    expect(cancelled.listeners.size).toBe(0);
  });
});

describe("boardAnimateLayoutChanges (#304)", () => {
  const base: Parameters<AnimateLayoutChanges>[0] = {
    active: null,
    containerId: "s",
    isDragging: false,
    isSorting: false,
    id: "a",
    index: 0,
    items: ["a", "b"],
    newIndex: 1,
    previousItems: ["b", "a"],
    previousContainerId: "s",
    transition: { duration: 200, easing: "ease" },
    wasDragging: false,
  };

  it("never animates outside a drag and its settle window — the Board's FLIP owns that reorder", () => {
    // dnd-kit's `newIndex` outside a drag is whatever the last drag left behind, so the vendor's
    // forced `wasDragging: true` would offset this card from a stale rect.
    expect(boardAnimateLayoutChanges(base)).toBe(false);
  });

  it("defers to the vendor's behaviour while sorting and in the settle window after a drop", () => {
    expect(boardAnimateLayoutChanges({ ...base, isSorting: true })).toBe(true);
    expect(boardAnimateLayoutChanges({ ...base, wasDragging: true, previousItems: base.items })).toBe(true);
  });
});
