import { describe, expect, it } from "vitest";
import { isSearchShortcut } from "./shell-search";
import type { RailShortcutEvent } from "./shell-rail";

/**
 * #217 rewrite: `isSearchShortcut` is all that is left of this module — the one-shot latched
 * focus request (`requestProjectSearchFocus`/`consumeProjectSearchFocus`/etc.) and
 * `activateProjectSearch` are deleted along with the Dashboard's now-retired second search input.
 * `lib/dashboard-search-store.test.ts` covers the store that replaced them.
 */

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

describe("isSearchShortcut — ⌘K/Ctrl+K", () => {
  it("fires on Meta+K", () => {
    expect(isSearchShortcut({ ...BASE_EVENT, metaKey: true })).toBe(true);
  });

  it("fires on Ctrl+K", () => {
    expect(isSearchShortcut({ ...BASE_EVENT, ctrlKey: true })).toBe(true);
  });

  it("rejects a bare K with no modifier", () => {
    expect(isSearchShortcut(BASE_EVENT)).toBe(false);
  });

  it("rejects a different key even with the modifier held", () => {
    expect(isSearchShortcut({ ...BASE_EVENT, metaKey: true, key: "b" })).toBe(false);
  });

  it("rejects a repeat (held key)", () => {
    expect(isSearchShortcut({ ...BASE_EVENT, metaKey: true, repeat: true })).toBe(false);
  });

  it("rejects while an IME composition is in progress", () => {
    expect(isSearchShortcut({ ...BASE_EVENT, metaKey: true, isComposing: true })).toBe(false);
  });

  it("rejects an editable target", () => {
    expect(isSearchShortcut({ ...BASE_EVENT, metaKey: true, target: { tagName: "INPUT" } })).toBe(false);
  });
});
