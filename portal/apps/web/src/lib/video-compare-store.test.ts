import { describe, expect, it, vi } from "vitest";
import { createCompareStore, offsetOf } from "./video-compare-store";

describe("createCompareStore (#741 7b)", () => {
  it("starts with no pair, offset 0, side-by-side, A audible", () => {
    const s = createCompareStore("p");
    expect(s.getState()).toMatchObject({ pair: null, mode: "side-by-side", wipe: 0.5, audible: "a", muted: false, notesOpen: false, activeTab: "a" });
    expect(offsetOf(s.getState())).toBe(0);
  });

  it("keeps an offset per pair and restores it after switching away and back", () => {
    const s = createCompareStore("p");
    s.setPair("v3", "v2");
    s.setOffset(12);
    expect(offsetOf(s.getState())).toBe(12);
    s.setPair("v3", "v1");
    expect(offsetOf(s.getState())).toBe(0);
    s.setOffset(-4);
    s.setPair("v3", "v2");
    expect(offsetOf(s.getState())).toBe(12);
    s.setPair("v3", "v1");
    expect(offsetOf(s.getState())).toBe(-4);
    // the pair is ordered: (v2, v3) is a different pair from (v3, v2)
    s.setPair("v2", "v3");
    expect(offsetOf(s.getState())).toBe(0);
  });

  it("rejects a non-integer offset and an offset with no pair open", () => {
    const s = createCompareStore("p");
    s.setOffset(3);
    expect(s.getState().offsets).toEqual({});
    s.setPair("a", "b");
    s.setOffset(1.5);
    expect(offsetOf(s.getState())).toBe(0);
  });

  it("clamps the wipe and notifies only on a change", () => {
    const s = createCompareStore("p");
    const listener = vi.fn();
    s.subscribe(listener);
    s.setWipe(2);
    expect(s.getState().wipe).toBe(1);
    s.setWipe(1);
    s.setMode("wipe"); s.setMode("wipe");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("holds audible, mute, notes and tab, and returns a new snapshot only on change", () => {
    const s = createCompareStore("p");
    const before = s.getState();
    s.setAudible("b"); s.setMuted(true); s.setNotesOpen(true); s.setActiveTab("b");
    expect(s.getState()).toMatchObject({ audible: "b", muted: true, notesOpen: true, activeTab: "b" });
    expect(s.getState()).not.toBe(before);
    const now = s.getState();
    s.setAudible("b");
    expect(s.getState()).toBe(now);
  });

  it("retire drops state, listeners and later writes", () => {
    const s = createCompareStore("p");
    const listener = vi.fn();
    s.subscribe(listener);
    s.setPair("a", "b"); s.setOffset(5);
    listener.mockClear();
    s.retire();
    s.setOffset(9); s.setMode("wipe");
    expect(listener).not.toHaveBeenCalled();
    expect(s.getState().pair).toBeNull();
    expect(offsetOf(s.getState())).toBe(0);
  });
});
