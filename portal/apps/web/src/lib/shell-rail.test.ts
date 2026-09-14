import { describe, expect, it } from "vitest";
import {
  isRailShortcut,
  railMode,
  readRailPreference,
  RAIL_PREFERENCE_KEY,
  SHELL_NARROW_QUERY,
  writeRailPreference,
  type RailShortcutEvent,
} from "./shell-rail";

/** A minimal `Storage`-shaped fake — no `window`, so this stays a node test. */
function fakeStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    peek: () => store,
  };
}

function throwingStorage() {
  return {
    getItem: () => { throw new Error("storage unavailable"); },
    setItem: () => { throw new Error("storage unavailable"); },
  };
}

const BASE_EVENT: RailShortcutEvent = {
  key: "b",
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
  it("keys the preference under the quincy: namespace", () => {
    expect(RAIL_PREFERENCE_KEY).toBe("quincy:shell:rail");
  });

  it("folds at 771px, the boundary the retired Topbar already folded at — not 1007/1008", () => {
    expect(SHELL_NARROW_QUERY).toBe("(max-width: 771px)");
  });
});

describe("readRailPreference / writeRailPreference — round trip", () => {
  it("reads back exactly what was written", () => {
    const storage = fakeStorage();
    writeRailPreference(storage, "collapsed");
    expect(readRailPreference(storage)).toBe("collapsed");
    writeRailPreference(storage, "expanded");
    expect(readRailPreference(storage)).toBe("expanded");
  });

  it("writes under RAIL_PREFERENCE_KEY specifically", () => {
    const storage = fakeStorage();
    writeRailPreference(storage, "collapsed");
    expect(storage.peek().get(RAIL_PREFERENCE_KEY)).toBe("collapsed");
  });

  it("defaults to expanded with nothing stored", () => {
    expect(readRailPreference(fakeStorage())).toBe("expanded");
  });

  it("reads a garbage value as expanded", () => {
    expect(readRailPreference(fakeStorage({ [RAIL_PREFERENCE_KEY]: "sideways" }))).toBe("expanded");
  });

  it("reads expanded rather than throwing when storage.getItem throws", () => {
    expect(readRailPreference(throwingStorage())).toBe("expanded");
  });

  it("does not throw when storage.setItem throws — the in-memory state carries on", () => {
    expect(() => writeRailPreference(throwingStorage(), "collapsed")).not.toThrow();
  });
});

describe("railMode — the truth table", () => {
  it("is always sheet when narrow, regardless of preference", () => {
    expect(railMode(true, "expanded")).toBe("sheet");
    expect(railMode(true, "collapsed")).toBe("sheet");
  });

  it("follows the preference when not narrow", () => {
    expect(railMode(false, "expanded")).toBe("expanded");
    expect(railMode(false, "collapsed")).toBe("collapsed");
  });
});

describe("isRailShortcut", () => {
  it("fires on Meta+B", () => {
    expect(isRailShortcut({ ...BASE_EVENT, metaKey: true })).toBe(true);
  });

  it("fires on Ctrl+B", () => {
    expect(isRailShortcut({ ...BASE_EVENT, ctrlKey: true })).toBe(true);
  });

  it("is case-insensitive on the key", () => {
    expect(isRailShortcut({ ...BASE_EVENT, metaKey: true, key: "B" })).toBe(true);
  });

  it("rejects a bare B with no modifier", () => {
    expect(isRailShortcut(BASE_EVENT)).toBe(false);
  });

  it("rejects a different key even with the modifier held", () => {
    expect(isRailShortcut({ ...BASE_EVENT, metaKey: true, key: "k" })).toBe(false);
  });

  it("rejects Alt+Meta+B — Tiptap binds Mod-B to bold, this must not fight it either", () => {
    expect(isRailShortcut({ ...BASE_EVENT, metaKey: true, altKey: true })).toBe(false);
  });

  it("rejects Shift+Meta+B", () => {
    expect(isRailShortcut({ ...BASE_EVENT, metaKey: true, shiftKey: true })).toBe(false);
  });

  it("rejects a repeat (held key)", () => {
    expect(isRailShortcut({ ...BASE_EVENT, metaKey: true, repeat: true })).toBe(false);
  });

  it("rejects while an IME composition is in progress", () => {
    expect(isRailShortcut({ ...BASE_EVENT, metaKey: true, isComposing: true })).toBe(false);
  });

  it("rejects when the event was already handled", () => {
    expect(isRailShortcut({ ...BASE_EVENT, metaKey: true, defaultPrevented: true })).toBe(false);
  });

  it("rejects a target that is an input", () => {
    expect(isRailShortcut({ ...BASE_EVENT, metaKey: true, target: { tagName: "INPUT" } })).toBe(false);
  });

  it("rejects a target that is a textarea", () => {
    expect(isRailShortcut({ ...BASE_EVENT, metaKey: true, target: { tagName: "TEXTAREA" } })).toBe(false);
  });

  it("rejects a target that is a select", () => {
    expect(isRailShortcut({ ...BASE_EVENT, metaKey: true, target: { tagName: "SELECT" } })).toBe(false);
  });

  it("rejects a contenteditable target (Tiptap's ProseMirror root)", () => {
    expect(isRailShortcut({ ...BASE_EVENT, metaKey: true, target: { tagName: "DIV", isContentEditable: true } })).toBe(false);
  });

  it("fires on a plain, non-editable target", () => {
    expect(isRailShortcut({ ...BASE_EVENT, metaKey: true, target: { tagName: "BODY" } })).toBe(true);
  });
});
