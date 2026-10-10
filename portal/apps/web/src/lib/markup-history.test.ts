import { describe, expect, it } from "vitest";
import type { MarkupItem } from "@quincy/shared";
import { HISTORY_DEPTH, canRedo, canUndo, clearAll, commit, createHistory, redo, undo, withinLimits } from "./markup-history";

const BIG = { items: 200, bytes: 2_000_000 };
const dot = (n: number): MarkupItem => ({ points: [{ x: n / 100, y: 0 }], color: "#000", width: 2 });
const line = (n: number): MarkupItem => ({ type: "line", points: [{ x: 0, y: 0 }, { x: n / 100, y: 1 }], color: "#000", width: 2 });

/** Draw `items` one at a time from an empty list, returning the final list and history. */
function drawAll(items: MarkupItem[]) {
  let strokes: MarkupItem[] = [];
  let history = createHistory(strokes);
  for (const item of items) {
    const step = commit(history, strokes, [...strokes, item], BIG)!;
    strokes = step.strokes; history = step.history;
  }
  return { strokes, history };
}

describe("markup history", () => {
  it("undo restores the previous list by reference, and redo restores the next one", () => {
    const empty: MarkupItem[] = [];
    const h0 = createHistory(empty);
    const one = [dot(1)];
    const s1 = commit(h0, empty, one, BIG)!;
    expect(s1.strokes).toBe(one);
    const s2 = commit(s1.history, s1.strokes, [...one, dot(2)], BIG)!;
    const back = undo(s2.history, s2.strokes)!;
    expect(back.strokes).toBe(one);
    expect(canUndo(back.history, back.strokes)).toBe(true);
    expect(canRedo(back.history, back.strokes)).toBe(true);
    const forward = redo(back.history, back.strokes, BIG)!;
    expect(forward.strokes).toBe(s2.strokes);
    expect(canRedo(forward.history, forward.strokes)).toBe(false);
  });

  it("a new draw empties the redo stack", () => {
    const { strokes, history } = drawAll([dot(1), dot(2)]);
    const back = undo(history, strokes)!;
    expect(canRedo(back.history, back.strokes)).toBe(true);
    const drawn = commit(back.history, back.strokes, [...back.strokes, line(3)], BIG)!;
    expect(canRedo(drawn.history, drawn.strokes)).toBe(false);
    expect(redo(drawn.history, drawn.strokes, BIG)).toBeNull();
  });

  it("Clear is one undoable step that restores everything it cleared", () => {
    const { strokes, history } = drawAll([dot(1), line(2), dot(3)]);
    const cleared = clearAll(history, strokes, BIG)!;
    expect(cleared.strokes).toEqual([]);
    const restored = undo(cleared.history, cleared.strokes)!;
    expect(restored.strokes).toBe(strokes);
    const again = redo(restored.history, restored.strokes, BIG)!;
    expect(again.strokes).toEqual([]);
  });

  it("Clear on an empty list is a no-op", () => {
    const empty: MarkupItem[] = [];
    expect(clearAll(createHistory(empty), empty, BIG)).toBeNull();
  });

  it("a list replaced from outside invalidates the history, and undo falls back to popping the last item", () => {
    const { strokes, history } = drawAll([dot(1), dot(2)]);
    const preloaded = [dot(7), dot(8), dot(9)]; // e.g. an Edit-drawing preload: a different array than the anchor
    expect(canUndo(history, preloaded)).toBe(true);
    expect(canRedo(history, preloaded)).toBe(false);
    const popped = undo(history, preloaded)!;
    expect(popped.strokes).toEqual([dot(7), dot(8)]);
    const restored = redo(popped.history, popped.strokes, BIG)!;
    expect(restored.strokes).toBe(preloaded);
    expect(strokes).toHaveLength(2);
  });

  it("undo on an empty, history-less list is a no-op and redo with nothing ahead is a no-op", () => {
    const empty: MarkupItem[] = [];
    const h = createHistory(empty);
    expect(canUndo(h, empty)).toBe(false);
    expect(undo(h, empty)).toBeNull();
    expect(redo(h, empty, BIG)).toBeNull();
  });

  it("keeps at most HISTORY_DEPTH undo steps", () => {
    const items = Array.from({ length: HISTORY_DEPTH + 5 }, (_, i) => dot(i));
    const { history } = drawAll(items);
    expect(history.past).toHaveLength(HISTORY_DEPTH);
  });

  it("refuses a draw that would exceed the item budget, and keeps the earlier draft", () => {
    const limits = { items: 2, bytes: 2_000_000 };
    const two = [dot(1), dot(2)];
    const h = createHistory(two);
    expect(commit(h, two, [...two, dot(3)], limits)).toBeNull();
  });

  it("refuses a draw that would exceed the byte budget", () => {
    const limits = { items: 200, bytes: 100 };
    const empty: MarkupItem[] = [];
    expect(commit(createHistory(empty), empty, [dot(1), dot(2), dot(3)], limits)).toBeNull();
    expect(commit(createHistory(empty), empty, [dot(1)], limits)).not.toBeNull();
  });

  it("applies the budgets to redo too: a target over the cap is refused and the history is untouched", () => {
    const { strokes, history } = drawAll([dot(1), dot(2), dot(3)]);
    const back = undo(history, strokes)!;
    expect(redo(back.history, back.strokes, { items: 2, bytes: 2_000_000 })).toBeNull();
    expect(redo(back.history, back.strokes, { items: 200, bytes: 50 })).toBeNull();
    expect(canRedo(back.history, back.strokes)).toBe(true);
    expect(redo(back.history, back.strokes, BIG)!.strokes).toBe(strokes);
  });

  it("withinLimits counts items and JSON bytes", () => {
    expect(withinLimits([], { items: 0, bytes: 2 })).toBe(true);
    expect(withinLimits([dot(1)], { items: 0, bytes: 2_000_000 })).toBe(false);
    expect(withinLimits([dot(1)], { items: 1, bytes: JSON.stringify([dot(1)]).length })).toBe(true);
    expect(withinLimits([dot(1)], { items: 1, bytes: JSON.stringify([dot(1)]).length - 1 })).toBe(false);
  });
});
