import { describe, expect, it } from "vitest";
import * as shellRail from "./shell-rail";
import { isShellShortcut, SHELL_NARROW_QUERY, type RailShortcutEvent } from "./shell-rail";

const BASE_EVENT: RailShortcutEvent = {
  key: "k",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  defaultPrevented: false,
  target: null,
};

describe("shell-rail — the constants", () => {
  it("folds at 771px, the boundary the retired Topbar already folded at — not 1007/1008", () => {
    expect(SHELL_NARROW_QUERY).toBe("(max-width: 771px)");
  });
});

describe("shell-rail — the retired collapse API (#426, ADR 0015)", () => {
  // The rail is always icon-only: no stored preference, no mode fold, no collapse shortcut.
  it.each(["RAIL_PREFERENCE_KEY", "readRailPreference", "writeRailPreference", "railMode", "isRailShortcut"])(
    "no longer exports %s",
    (name) => {
      expect(name in shellRail).toBe(false);
    },
  );
});

// The predicate's whole rejection matrix, ported from the retired `isRailShortcut` suite onto the
// shared `isShellShortcut` (the one predicate ⌘K still goes through) so no case was dropped when ⌘B
// left. `lib/shell-search.test.ts` runs the same matrix through `isSearchShortcut`.
describe("isShellShortcut", () => {
  const fires = (event: RailShortcutEvent, key = "k") => isShellShortcut(event, key);

  it("fires on Meta+<key>", () => {
    expect(fires({ ...BASE_EVENT, metaKey: true })).toBe(true);
  });

  it("fires on Ctrl+<key>", () => {
    expect(fires({ ...BASE_EVENT, ctrlKey: true })).toBe(true);
  });

  it("is case-insensitive on the event's key", () => {
    expect(fires({ ...BASE_EVENT, metaKey: true, key: "K" })).toBe(true);
  });

  it("matches whichever letter it is asked about", () => {
    expect(fires({ ...BASE_EVENT, metaKey: true, key: "j" }, "j")).toBe(true);
    expect(fires({ ...BASE_EVENT, metaKey: true, key: "j" }, "k")).toBe(false);
  });

  it("rejects a bare key with no modifier", () => {
    expect(fires(BASE_EVENT)).toBe(false);
  });

  it("rejects a different key even with the modifier held", () => {
    expect(fires({ ...BASE_EVENT, metaKey: true, key: "b" })).toBe(false);
  });

  it("rejects Alt+Meta+<key> — Tiptap binds Mod-<key> chords, this must not fight them", () => {
    expect(fires({ ...BASE_EVENT, metaKey: true, altKey: true })).toBe(false);
  });

  it("rejects Shift+Meta+<key>", () => {
    expect(fires({ ...BASE_EVENT, metaKey: true, shiftKey: true })).toBe(false);
  });

  it("rejects a repeat (held key)", () => {
    expect(fires({ ...BASE_EVENT, metaKey: true, repeat: true })).toBe(false);
  });

  it("rejects while an IME composition is in progress", () => {
    expect(fires({ ...BASE_EVENT, metaKey: true, isComposing: true })).toBe(false);
  });

  it("rejects when the event was already handled", () => {
    expect(fires({ ...BASE_EVENT, metaKey: true, defaultPrevented: true })).toBe(false);
  });

  it("rejects a target that is an input", () => {
    expect(fires({ ...BASE_EVENT, metaKey: true, target: { tagName: "INPUT" } })).toBe(false);
  });

  it("rejects a target that is a textarea", () => {
    expect(fires({ ...BASE_EVENT, metaKey: true, target: { tagName: "TEXTAREA" } })).toBe(false);
  });

  it("rejects a target that is a select", () => {
    expect(fires({ ...BASE_EVENT, metaKey: true, target: { tagName: "SELECT" } })).toBe(false);
  });

  it("rejects a contenteditable target (Tiptap's ProseMirror root)", () => {
    expect(fires({ ...BASE_EVENT, metaKey: true, target: { tagName: "DIV", isContentEditable: true } })).toBe(false);
  });

  it("fires on a plain, non-editable target", () => {
    expect(fires({ ...BASE_EVENT, metaKey: true, target: { tagName: "BODY" } })).toBe(true);
  });
});
