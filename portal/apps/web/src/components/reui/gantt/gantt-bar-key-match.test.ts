/**
 * #219 PR A (Adjust mode) — table test for `gantt-lib.tsx`'s `matchGanttBarKey`, the pure
 * replacement for `gantt-bar.tsx`'s old `matchGanttBarKeyChord`. Node suite: no DOM, no React -
 * every case is a plain object literal shaped like the subset of `KeyboardEvent` the matcher reads.
 */
import { describe, expect, it } from "vitest";
import { matchGanttBarKey } from "@/components/reui/gantt/gantt-lib";

interface KeyInit {
  key: string;
  altKey?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

function key(init: KeyInit) {
  return {
    key: init.key,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
  };
}

describe("matchGanttBarKey (#219 PR A)", () => {
  describe("idle (adjusting: false)", () => {
    it.each([
      ["bare Space", key({ key: " " }), { type: "enter" }],
      ["legacy Spacebar key value", key({ key: "Spacebar" }), { type: "enter" }],
      ["bare Enter -> null (native button activation handles it)", key({ key: "Enter" }), null],
      ["Shift+Space -> null", key({ key: " ", shiftKey: true }), null],
      ["Alt+Space -> null", key({ key: " ", altKey: true }), null],
      ["Ctrl+Space -> null", key({ key: " ", ctrlKey: true }), null],
      ["Meta+Space -> null", key({ key: " ", metaKey: true }), null],
      ["bare ArrowRight -> null", key({ key: "ArrowRight" }), null],
      ["bare ArrowLeft -> null", key({ key: "ArrowLeft" }), null],
      ["Alt+ArrowRight (old move chord) -> null", key({ key: "ArrowRight", altKey: true }), null],
      [
        "Ctrl+Alt+ArrowLeft (old resize-start chord) -> null",
        key({ key: "ArrowLeft", altKey: true, ctrlKey: true }),
        null,
      ],
      [
        "Shift+Alt+ArrowRight (old resize-end chord) -> null",
        key({ key: "ArrowRight", altKey: true, shiftKey: true }),
        null,
      ],
      ["bare Escape -> null", key({ key: "Escape" }), null],
      ["bare M -> null", key({ key: "m" }), null],
      ["bare S -> null", key({ key: "s" }), null],
      ["bare E -> null", key({ key: "e" }), null],
    ] as const)("%s", (_label, event, expected) => {
      expect(matchGanttBarKey(event, false, false)).toEqual(expected);
    });
  });

  describe("adjusting (adjusting: true), LTR", () => {
    it.each([
      ["bare ArrowRight -> step later, snap unit", key({ key: "ArrowRight" }), { type: "step", direction: 1, unit: "snap" }],
      ["bare ArrowLeft -> step earlier, snap unit", key({ key: "ArrowLeft" }), { type: "step", direction: -1, unit: "snap" }],
      [
        "Shift+ArrowRight -> step later, large unit",
        key({ key: "ArrowRight", shiftKey: true }),
        { type: "step", direction: 1, unit: "large" },
      ],
      [
        "Shift+ArrowLeft -> step earlier, large unit",
        key({ key: "ArrowLeft", shiftKey: true }),
        { type: "step", direction: -1, unit: "large" },
      ],
      ["Alt+ArrowRight -> null (no longer a chord)", key({ key: "ArrowRight", altKey: true }), null],
      [
        "Ctrl+Alt+ArrowLeft -> null (no longer a chord)",
        key({ key: "ArrowLeft", altKey: true, ctrlKey: true }),
        null,
      ],
      ["Meta+ArrowRight -> null", key({ key: "ArrowRight", metaKey: true }), null],
      ["bare M -> retarget move", key({ key: "m" }), { type: "retarget", target: "move" }],
      ["bare S -> retarget resize-start", key({ key: "s" }), { type: "retarget", target: "resize-start" }],
      ["bare E -> retarget resize-end", key({ key: "e" }), { type: "retarget", target: "resize-end" }],
      ["uppercase M (caps lock, no Shift) -> retarget move", key({ key: "M" }), { type: "retarget", target: "move" }],
      ["Shift+M -> null (Shift is reserved for the arrow's larger unit)", key({ key: "M", shiftKey: true }), null],
      ["Ctrl+S -> null (browser Save)", key({ key: "s", ctrlKey: true }), null],
      ["bare Enter -> commit", key({ key: "Enter" }), { type: "commit" }],
      ["bare Space -> commit", key({ key: " " }), { type: "commit" }],
      ["Shift+Enter -> null", key({ key: "Enter", shiftKey: true }), null],
      ["bare Escape -> cancel", key({ key: "Escape" }), { type: "cancel" }],
      ["Shift+Escape -> null", key({ key: "Escape", shiftKey: true }), null],
      ["an unrelated key (Tab) -> null", key({ key: "Tab" }), null],
    ] as const)("%s", (_label, event, expected) => {
      expect(matchGanttBarKey(event, true, false)).toEqual(expected);
    });
  });

  describe("adjusting, RTL mirroring", () => {
    it("ArrowRight steps EARLIER under rtl: true", () => {
      expect(matchGanttBarKey(key({ key: "ArrowRight" }), true, true)).toEqual({
        type: "step",
        direction: -1,
        unit: "snap",
      });
    });
    it("ArrowLeft steps LATER under rtl: true", () => {
      expect(matchGanttBarKey(key({ key: "ArrowLeft" }), true, true)).toEqual({
        type: "step",
        direction: 1,
        unit: "snap",
      });
    });
    it("Shift+ArrowRight steps EARLIER, large unit, under rtl: true", () => {
      expect(matchGanttBarKey(key({ key: "ArrowRight", shiftKey: true }), true, true)).toEqual({
        type: "step",
        direction: -1,
        unit: "large",
      });
    });
    it("M/S/E and commit/cancel are unaffected by rtl", () => {
      expect(matchGanttBarKey(key({ key: "m" }), true, true)).toEqual({ type: "retarget", target: "move" });
      expect(matchGanttBarKey(key({ key: "Enter" }), true, true)).toEqual({ type: "commit" });
      expect(matchGanttBarKey(key({ key: "Escape" }), true, true)).toEqual({ type: "cancel" });
    });
    it("idle Space -> enter is unaffected by rtl", () => {
      expect(matchGanttBarKey(key({ key: " " }), false, true)).toEqual({ type: "enter" });
    });
  });
});
