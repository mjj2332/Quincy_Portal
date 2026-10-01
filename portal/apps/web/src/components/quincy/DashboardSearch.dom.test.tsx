import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DASHBOARD_SEARCH_MAX_CHARS } from "@quincy/shared";
import { DashboardSearch, type DashboardSearchProps } from "./DashboardSearch";
import {
  __resetDashboardSearchStoreForTest,
  __getDashboardSearchSnapshotForTest,
  DASHBOARD_SEARCH_DEBOUNCE_MS,
  setDashboardSearchUrlWriter,
} from "../../lib/dashboard-search-store";

/**
 * The Dashboard toolbar's project search — #217, rewritten as `DashboardSearch` by #427 (ADR 0015)
 * from the rail's `ShellSearch` tests. A real input backed by `lib/dashboard-search-store.ts`: there
 * are no `rail`/`sheet` variants, no popover, no Sidebar wrapper and no off-Dashboard Enter branch
 * left (the field only exists while a Dashboard is mounted). What carries over unchanged is the part
 * that guards real bugs: the code-point cap, strip-then-cap, IME handling, Enter, Escape, and the
 * input's own attributes. The ⌘K focus request is new.
 */

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); });
}

async function renderSearch(props: DashboardSearchProps = {}) {
  await render(<DashboardSearch {...props} />);
}

const input = () => host.querySelector<HTMLInputElement>('[data-testid="dashboard-search"]')!;

async function type(target: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

/** Sets the input's value without dispatching `input`, mirroring a composed keystroke still
 *  mid-IME-composition -- `handleChange` alone must NOT cap it. */
async function typeWithoutInputEvent(target: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value);
    await Promise.resolve();
  });
}

async function compositionStart(target: HTMLInputElement) {
  await act(async () => { target.dispatchEvent(new Event("compositionstart", { bubbles: true })); await Promise.resolve(); });
}

async function compositionEnd(target: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(target, value);
    target.dispatchEvent(new Event("compositionend", { bubbles: true }));
    await Promise.resolve();
  });
}

async function keydown(target: EventTarget, init: KeyboardEventInit) {
  let defaultPrevented = false;
  await act(async () => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    defaultPrevented = !target.dispatchEvent(event);
    await Promise.resolve();
  });
  return defaultPrevented;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  __resetDashboardSearchStoreForTest();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host.remove();
  document.body.replaceChildren();
  __resetDashboardSearchStoreForTest();
});

describe("DashboardSearch — the field", () => {
  it("is a named search input with the long placeholder, an id and a name, and no native maxLength", async () => {
    await renderSearch();
    const field = input();
    expect(field.getAttribute("aria-label")).toBe("Search projects");
    expect(field.placeholder).toBe("Search address, suburb, client…");
    // No native `maxLength`: it counts UTF-16 code units, not the shared contract's Unicode code
    // points -- see the "code-point cap" describe below. `-1` is the DOM's "unset" value.
    expect(field.maxLength).toBe(-1);
    expect(field.id).toBe("dashboard-search");
    expect(field.name).toBe("q");
    expect(host.querySelector('[data-testid="dashboard-search-field"]')!.contains(field)).toBe(true);
  });

  it("renders no ⌘K hint, no rail trigger and no popover", async () => {
    await renderSearch();
    expect(host.querySelector('[data-testid="shell-search-trigger"]')).toBeNull();
    expect(host.querySelector('[data-testid="shell-search-shortcut"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows the Clear button only while the field holds text, and clearing keeps focus in the input", async () => {
    await renderSearch();
    expect(host.querySelector('button[aria-label="Clear search"]')).toBeNull();
    await type(input(), "smith");
    const clear = host.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!;
    expect(clear).not.toBeNull();
    clear.focus();
    await act(async () => { clear.click(); await Promise.resolve(); });
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("");
    expect(input().value).toBe("");
    expect(host.querySelector('button[aria-label="Clear search"]')).toBeNull();
    expect(document.activeElement).toBe(input());
  });
});

describe("DashboardSearch — the draft is capped by Unicode code point, not UTF-16 code unit (#217 design-fix round 2, item 3)", () => {
  it("caps 250 ASCII characters to 200", async () => {
    await renderSearch();
    await type(input(), "a".repeat(250));
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("a".repeat(DASHBOARD_SEARCH_MAX_CHARS));
    expect(__getDashboardSearchSnapshotForTest().draft.length).toBe(200);
  });

  it("caps 250 astral emoji to 200 CODE POINTS, not ~100 (a native maxLength=200 would have counted UTF-16 units)", async () => {
    await renderSearch();
    await type(input(), "🎉".repeat(250)); // 250 code points, 500 UTF-16 code units
    const draft = __getDashboardSearchSnapshotForTest().draft;
    expect([...draft].length).toBe(200);
    expect(draft).toBe("🎉".repeat(200));
  });

  it("does not truncate mid-composition — the cap applies only once compositionend reports the final value", async () => {
    await renderSearch();
    const field = input();
    await compositionStart(field);
    await typeWithoutInputEvent(field, "a".repeat(250));
    await act(async () => { field.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); });
    expect(__getDashboardSearchSnapshotForTest().draft.length).toBe(250);

    await compositionEnd(field, "a".repeat(250));
    expect(__getDashboardSearchSnapshotForTest().draft.length).toBe(200);
  });
});

describe("DashboardSearch — strips unsafe characters BEFORE capping, not after (#217 design-fix round 3, item 2)", () => {
  it("a leading backslash followed by 200 'a' yields all 200 'a', not 199", async () => {
    await renderSearch();
    await type(input(), "\\" + "a".repeat(200));
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("a".repeat(200));
  });

  it("applies the same strip-then-cap order at compositionend", async () => {
    await renderSearch();
    await compositionStart(input());
    await compositionEnd(input(), "\\" + "a".repeat(200));
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("a".repeat(200));
  });
});

describe("DashboardSearch — an IME composition never arms or fires a stray commit (#217 design-fix round 3, item 3)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("1s of composition: no commit, no URL write", async () => {
    const writes: string[] = [];
    const unregister = setDashboardSearchUrlWriter((q) => writes.push(q));
    await renderSearch();
    await compositionStart(input());
    await typeWithoutInputEvent(input(), "s");
    await act(async () => { input().dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(writes).toEqual([]);
    unregister();
  });

  it("compositionend schedules exactly one commit, which fires after the debounce elapses", async () => {
    const writes: string[] = [];
    const unregister = setDashboardSearchUrlWriter((q) => writes.push(q));
    await renderSearch();
    await compositionStart(input());
    await compositionEnd(input(), "smith");
    expect(writes).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS); });
    expect(writes).toEqual(["smith"]);
    unregister();
  });

  it("cancels a timer armed by a real keystroke just before the composition begins", async () => {
    const writes: string[] = [];
    const unregister = setDashboardSearchUrlWriter((q) => writes.push(q));
    await renderSearch();
    await type(input(), "smith"); // arms the 300ms debounce
    await compositionStart(input()); // must cancel that pending commit
    await act(async () => { vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS + 100); });
    expect(writes).toEqual([]);
    unregister();
  });

  it("a normal keystroke commits through the writer once the debounce elapses", async () => {
    const writes: string[] = [];
    const unregister = setDashboardSearchUrlWriter((q) => writes.push(q));
    await renderSearch();
    await type(input(), "smith");
    expect(writes).toEqual([]);
    await act(async () => { vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS); });
    expect(writes).toEqual(["smith"]);
    unregister();
  });
});

describe("DashboardSearch — Enter", () => {
  it("commits the search through the Dashboard's registered writer, immediately", async () => {
    const writes: string[] = [];
    const unregister = setDashboardSearchUrlWriter((q) => writes.push(q));
    await renderSearch();
    await type(input(), "smith");
    await keydown(input(), { key: "Enter" });
    expect(writes).toEqual(["smith"]);
    unregister();
  });

  it("mid-IME-composition (native isComposing) is ignored", async () => {
    const writes: string[] = [];
    const unregister = setDashboardSearchUrlWriter((q) => writes.push(q));
    await renderSearch();
    await compositionStart(input());
    await typeWithoutInputEvent(input(), "す");
    await keydown(input(), { key: "Enter", isComposing: true });
    expect(writes).toEqual([]);
    unregister();
  });

  it("the browser's own 229 keyCode Enter (Process) is also ignored", async () => {
    const writes: string[] = [];
    const unregister = setDashboardSearchUrlWriter((q) => writes.push(q));
    await renderSearch();
    await compositionStart(input());
    await typeWithoutInputEvent(input(), "す");
    await keydown(input(), { key: "Process" });
    expect(writes).toEqual([]);
    unregister();
  });
});

describe("DashboardSearch — Escape", () => {
  it("clears a non-empty draft without preventing the keystroke's default", async () => {
    await renderSearch();
    await type(input(), "smith");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");
    // `stopPropagation` alone, never `preventDefault` — `dispatchEvent`'s return value stays `true`.
    const defaultPrevented = await keydown(input(), { key: "Escape" });
    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "" });
    expect(defaultPrevented).toBe(false);
  });

  it("lets an empty draft's Escape bubble, so an ancestor (a dialog) can close on it", async () => {
    await renderSearch();
    // A listener on `document`, genuinely ABOVE the React root in the real DOM tree.
    const ancestorListener = vi.fn();
    document.addEventListener("keydown", ancestorListener);
    await keydown(input(), { key: "Escape" });
    expect(ancestorListener).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", ancestorListener);
  });

  it("a non-empty draft's Escape does not reach a listener above the React root", async () => {
    await renderSearch();
    await type(input(), "smith");
    const ancestorListener = vi.fn();
    document.addEventListener("keydown", ancestorListener);
    await keydown(input(), { key: "Escape" });
    expect(ancestorListener).not.toHaveBeenCalled();
    document.removeEventListener("keydown", ancestorListener);
  });

  it("mid-IME-composition, Escape neither clears nor stops propagation", async () => {
    await renderSearch();
    await type(input(), "smith");
    await compositionStart(input());
    await keydown(input(), { key: "Escape", isComposing: true });
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");
  });
});

describe("DashboardSearch — the ⌘K focus request (#427)", () => {
  it("focuses and selects the field when a request arrives, then hands the signal back exactly once", async () => {
    const handled = vi.fn();
    await renderSearch({ principalId: "u1" });
    await type(input(), "smith");
    expect(document.activeElement).not.toBe(input());

    await renderSearch({ principalId: "u1", focusRequest: { signal: 1 }, onFocusRequestHandled: handled });
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe(input().value.length);
    expect(handled).toHaveBeenCalledTimes(1);
    expect(handled).toHaveBeenCalledWith(1);
  });

  it("does nothing without a request, and a spent request cannot refocus the field later", async () => {
    const handled = vi.fn();
    const request = { signal: 7 };
    await renderSearch({ focusRequest: request, onFocusRequestHandled: handled });
    expect(handled).toHaveBeenCalledWith(7);

    const other = document.createElement("button");
    document.body.appendChild(other);
    other.focus();
    // A re-render with the SAME request object (the shell has not cleared it yet) must not refocus.
    await renderSearch({ focusRequest: request, onFocusRequestHandled: handled });
    expect(document.activeElement).toBe(other);
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("a repeat request with a fresh signal focuses again", async () => {
    const handled = vi.fn();
    await renderSearch({ focusRequest: { signal: 1 }, onFocusRequestHandled: handled });
    const other = document.createElement("button");
    document.body.appendChild(other);
    other.focus();
    await renderSearch({ focusRequest: { signal: 2 }, onFocusRequestHandled: handled });
    expect(document.activeElement).toBe(input());
    expect(handled).toHaveBeenLastCalledWith(2);
  });
});
