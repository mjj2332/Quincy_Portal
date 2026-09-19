import { act, createRef } from "react";
import type { ReactNode, RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/reui/sidebar";
import { TooltipProvider } from "@/components/reui/tooltip";
import { DASHBOARD_SEARCH_MAX_CHARS } from "@quincy/shared";
import { ShellSearch, type ShellSearchHandle, type ShellSearchProps } from "./ShellSearch";
import {
  __resetDashboardSearchStoreForTest,
  __getDashboardSearchSnapshotForTest,
  DASHBOARD_SEARCH_DEBOUNCE_MS,
  setDashboardSearchUrlWriter,
} from "../../lib/dashboard-search-store";

/**
 * The rail's project-search control — #217 rewrite. A real input now, backed by
 * `lib/dashboard-search-store.ts` directly, across the three `variant` modes. Mirrors
 * `NavigationRail.dom.test.tsx`'s own `renderInProvider`: `reui/sidebar.tsx`'s primitives throw
 * outside a `SidebarProvider`, and the collapsed tooltip/popover need a zero-delay
 * `TooltipProvider` rather than a real hover-intent wait.
 */

const routerMock = vi.hoisted(() => ({ push: vi.fn<(location: string) => void>() }));
vi.mock("../../lib/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/router")>();
  return { ...actual, locationStore: () => ({ getLocation: () => "/", push: routerMock.push }) };
});

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); });
}

async function renderInProvider(
  props: Partial<ShellSearchProps> & { variant: ShellSearchProps["variant"] },
  ref?: RefObject<ShellSearchHandle | null>,
) {
  const { variant, isDashboard = false } = props;
  await render(
    <SidebarProvider open={variant !== "collapsed"} onOpenChange={() => {}}>
      <TooltipProvider delay={0}>
        <ShellSearch ref={ref} variant={variant} isDashboard={isDashboard} />
      </TooltipProvider>
    </SidebarProvider>,
  );
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

/** Sets the input's value without dispatching `input`, mirroring a composed keystroke still
 *  mid-IME-composition -- `handleChange` alone must NOT cap it. */
async function typeWithoutInputEvent(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    await Promise.resolve();
  });
}

async function compositionStart(input: HTMLInputElement) {
  await act(async () => {
    input.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    await Promise.resolve();
  });
}

async function compositionEnd(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("compositionend", { bubbles: true }));
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

/** Real-timer poll, mirroring `NavigationRail.dom.test.tsx`'s own `waitFor`. */
async function waitFor(assertion: () => void, timeoutMs = 1000) {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  __resetDashboardSearchStoreForTest();
  routerMock.push.mockClear();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host.remove();
  document.body.replaceChildren();
  __resetDashboardSearchStoreForTest();
});

describe("ShellSearch — expanded", () => {
  it("shows the input, its shortcut hint and no touch-target seam", async () => {
    await renderInProvider({ variant: "expanded" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    expect(input.getAttribute("aria-label")).toBe("Search projects");
    expect(host.querySelector('[data-testid="shell-search-shortcut"]')?.textContent).toBe("⌘K");
    expect(input.closest('[data-testid="shell-search-field"]')?.getAttribute("data-touch-target")).toBeNull();
  });

  // #217 design-review, item 7: the long placeholder clipped mid-word in a rail this narrow.
  it("uses the short placeholder, not the one clipped mid-word at this width", async () => {
    await renderInProvider({ variant: "expanded" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    expect(input.placeholder).toBe("Search projects");
    expect(input.getAttribute("aria-label")).toBe("Search projects");
  });
});

describe("ShellSearch — one focus indicator, not two (#217 design-review, item 4; scoped to the input #217 design-fix round 2, item 2)", () => {
  it("suppresses the input's own :focus-visible outline in the expanded rail, leaving the group's own scoped outline as the single indicator", async () => {
    await renderInProvider({ variant: "expanded" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    expect(input.className).toContain("focus-visible:!outline-none");
    const group = input.closest('[data-testid="shell-search-field"]')!;
    // `has-[input:focus-visible]:`, not `focus-within:` (round 2, item 2) -- the wrapper's own
    // outline now activates only for the INPUT, not for a focused button elsewhere in the group,
    // so a Combobox trigger/clear inside the same primitive shows only its own indicator.
    expect(group.className).toContain("has-[input:focus-visible]:outline-solid");
    expect(group.className).toContain("has-[input:focus-visible]:outline-ring");
    expect(group.className).not.toContain("focus-within:outline");
    // Unaffected by round 2, item 2 -- the ⌘K hint has nothing to do with the focus-ring scoping.
    expect(host.querySelector('[data-testid="shell-search-shortcut"]')?.textContent).toBe("⌘K");
  });

  it("carries the same scoped outline in the collapsed popover's field, once opened", async () => {
    await renderInProvider({ variant: "collapsed" });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="shell-search-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      await Promise.resolve();
    });
    await waitFor(() => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]');
      expect(input).not.toBeNull();
      expect(input!.className).toContain("focus-visible:!outline-none");
      const group = input!.closest('[data-testid="shell-search-field"]')!;
      expect(group.className).toContain("has-[input:focus-visible]:outline-ring");
    });
    // The collapsed popover drops the ⌘K hint entirely (nothing persistent for it to point at) --
    // confirming its absence here, not just its presence in `expanded`, is the OTHER half of
    // "unaffected".
    expect(document.querySelector('[data-testid="shell-search-shortcut"]')).toBeNull();
  });

  it("carries the same scoped outline in the Sheet's inline field", async () => {
    await renderInProvider({ variant: "sheet" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    expect(input.className).toContain("focus-visible:!outline-none");
    const group = input.closest('[data-testid="shell-search-field"]')!;
    expect(group.className).toContain("has-[input:focus-visible]:outline-ring");
    expect(host.querySelector('[data-testid="shell-search-shortcut"]')).toBeNull();
  });
});

describe("ShellSearch — field attributes the input throws its own text away without (#217 design-review, item 6)", () => {
  it("carries an id/name, expanded", async () => {
    await renderInProvider({ variant: "expanded" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    // No native `maxLength` (#217 design-fix round 2, item 3): it counts UTF-16 code units, not
    // the shared contract's Unicode code points -- see the "code-point cap" describe block below
    // for the replacement, enforced in the change/composition handlers instead. `-1` is the DOM's
    // own "unset" value for the `maxLength` IDL property.
    expect(input.maxLength).toBe(-1);
    expect(input.id).toBe("shell-search-expanded");
    expect(input.name).toBe("q");
  });

  it("derives a per-mode id, sheet", async () => {
    await renderInProvider({ variant: "sheet" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    expect(input.id).toBe("shell-search-sheet");
  });

  // `RailedShell.tsx` keeps the Sheet's own `ShellSearch` mounted in every mode, so the rail's
  // expanded/collapsed instance and the Sheet's instance can both be in the DOM at once -- the
  // per-mode id is what keeps that from being a duplicate id.
  it("never renders two elements sharing an id when the rail and Sheet instances are both mounted", async () => {
    await render(
      <SidebarProvider open onOpenChange={() => {}}>
        <TooltipProvider delay={0}>
          <ShellSearch variant="expanded" isDashboard={false} />
          <ShellSearch variant="sheet" isDashboard={false} />
        </TooltipProvider>
      </SidebarProvider>,
    );
    const ids = [...host.querySelectorAll('[data-testid="shell-search"]')].map((node) => node.id);
    expect(ids).toEqual(["shell-search-expanded", "shell-search-sheet"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("ShellSearch — the draft is capped by Unicode code point, not UTF-16 code unit (#217 design-fix round 2, item 3)", () => {
  it("caps 250 ASCII characters to 200", async () => {
    await renderInProvider({ variant: "expanded" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await type(input, "a".repeat(250));
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("a".repeat(DASHBOARD_SEARCH_MAX_CHARS));
    expect(__getDashboardSearchSnapshotForTest().draft.length).toBe(200);
  });

  it("caps 250 astral emoji to 200 CODE POINTS, not ~100 (a native maxLength=200 would have counted UTF-16 units)", async () => {
    await renderInProvider({ variant: "expanded" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    const emoji = "🎉".repeat(250); // 250 code points, 500 UTF-16 code units (each emoji is a surrogate pair)
    await type(input, emoji);
    const draft = __getDashboardSearchSnapshotForTest().draft;
    expect([...draft].length).toBe(200);
    expect(draft).toBe("🎉".repeat(200));
  });

  it("does not truncate mid-composition — the cap applies only once compositionend reports the final value", async () => {
    await renderInProvider({ variant: "expanded" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await compositionStart(input);
    // A composition still in progress, already past the cap -- must survive untouched while the
    // composition is open, unlike a real (non-composed) keystroke of the same length.
    await typeWithoutInputEvent(input, "a".repeat(250));
    await act(async () => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    expect(__getDashboardSearchSnapshotForTest().draft.length).toBe(250);

    await compositionEnd(input, "a".repeat(250));
    expect(__getDashboardSearchSnapshotForTest().draft.length).toBe(200);
  });
});

describe("ShellSearch — strips unsafe characters BEFORE capping, not after (#217 design-fix round 3, item 2)", () => {
  it("a leading backslash followed by 200 'a' yields all 200 'a', not 199", async () => {
    await renderInProvider({ variant: "expanded" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    // Capping a 201-character raw value ("\\" + 200 "a") BEFORE stripping keeps the first 200
    // characters -- the backslash plus 199 "a" -- and only THEN strips the backslash, losing an
    // "a" that should have survived. Strip-then-cap keeps all 200 "a".
    await type(input, "\\" + "a".repeat(200));
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("a".repeat(200));
  });

  it("applies the same strip-then-cap order at compositionend", async () => {
    await renderInProvider({ variant: "expanded" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await compositionStart(input);
    await compositionEnd(input, "\\" + "a".repeat(200));
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("a".repeat(200));
  });
});

describe("ShellSearch — an IME composition never arms or fires a stray commit (#217 design-fix round 3, item 3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("1s of composition: no commit, no URL write", async () => {
    const writes: string[] = [];
    const unregister = setDashboardSearchUrlWriter((q) => writes.push(q));
    await renderInProvider({ variant: "expanded" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;

    await compositionStart(input);
    await typeWithoutInputEvent(input, "s");
    await act(async () => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(writes).toEqual([]);
    expect(__getDashboardSearchSnapshotForTest().query).toBe("");
    unregister();
  });

  it("compositionend schedules exactly one commit, which fires after the debounce elapses", async () => {
    const writes: string[] = [];
    const unregister = setDashboardSearchUrlWriter((q) => writes.push(q));
    await renderInProvider({ variant: "expanded" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;

    await compositionStart(input);
    await compositionEnd(input, "smith");
    // Not yet -- the commit is scheduled (debounced), not immediate.
    expect(writes).toEqual([]);

    await act(async () => {
      vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS);
    });
    expect(writes).toEqual(["smith"]);
    unregister();
  });

  it("cancels a timer armed by a real keystroke just before the composition begins", async () => {
    const writes: string[] = [];
    const unregister = setDashboardSearchUrlWriter((q) => writes.push(q));
    await renderInProvider({ variant: "expanded" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;

    await type(input, "smith"); // a normal keystroke -- arms the 300ms debounce
    await compositionStart(input); // must cancel that pending commit, not leave it to fire mid-composition
    await act(async () => {
      vi.advanceTimersByTime(DASHBOARD_SEARCH_DEBOUNCE_MS + 100);
    });

    expect(writes).toEqual([]);
    unregister();
  });
});

describe("ShellSearch — Enter mid-IME-composition neither commits nor navigates (#217 build, step 1)", () => {
  it("an Enter that is still part of the composition (native isComposing) is ignored", async () => {
    await renderInProvider({ variant: "expanded", isDashboard: false });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await compositionStart(input);
    await typeWithoutInputEvent(input, "す");
    await act(async () => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", isComposing: true });
      input.dispatchEvent(event);
      await Promise.resolve();
    });
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(__getDashboardSearchSnapshotForTest().query).toBe("");
  });

  it("the browser's own 229 keyCode Enter (Process) is also ignored", async () => {
    await renderInProvider({ variant: "expanded", isDashboard: false });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await compositionStart(input);
    await typeWithoutInputEvent(input, "す");
    await act(async () => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Process" });
      input.dispatchEvent(event);
      await Promise.resolve();
    });
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(__getDashboardSearchSnapshotForTest().query).toBe("");
  });
});

describe("ShellSearch — collapsed", () => {
  it("renders only the icon trigger, keeping the accessible name, until opened", async () => {
    await renderInProvider({ variant: "collapsed" });
    expect(host.querySelector('[data-testid="shell-search"]')).toBeNull();
    const trigger = host.querySelector('[data-testid="shell-search-trigger"]')!;
    expect(trigger.getAttribute("aria-label")).toBe("Search projects");
  });

  it("shows a tooltip on hover", async () => {
    await renderInProvider({ variant: "collapsed" });
    const trigger = host.querySelector('[data-testid="shell-search-trigger"]')!;
    expect(document.querySelector('[data-testid="rail-tooltip-search"]')).toBeNull();

    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }));
      trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      trigger.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      const tooltip = document.querySelector('[data-testid="rail-tooltip-search"]');
      expect(tooltip).not.toBeNull();
      expect(tooltip?.textContent).toBe("Search projects");
    });
  });

  it("a click on the trigger opens the popover and focuses the field", async () => {
    await renderInProvider({ variant: "collapsed" });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="shell-search-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      await Promise.resolve();
    });
    await waitFor(() => {
      const input = document.querySelector('[data-testid="shell-search"]');
      expect(input).not.toBeNull();
      expect(document.activeElement).toBe(input);
    });
  });

  // #217 design-review, item 7: the collapsed popover is the same narrow width as the expanded
  // rail's own field, so it gets the same short placeholder.
  it("uses the short placeholder once the popover is open", async () => {
    await renderInProvider({ variant: "collapsed" });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="shell-search-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      await Promise.resolve();
    });
    await waitFor(() => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]');
      expect(input?.placeholder).toBe("Search projects");
    });
  });

  // #217 fix round 1, item 8 (test gap Sol listed): the trigger's own `aria-expanded`/
  // `aria-haspopup` and the popup's `role="dialog"` semantics, not just presence/absence.
  it("the trigger carries aria-haspopup=dialog and aria-expanded reflects open state", async () => {
    await renderInProvider({ variant: "collapsed" });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="shell-search-trigger"]')!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });
  });

  // Restores real-popover Escape/focus-return coverage: the earlier Escape suite only proves the
  // keystroke bubbles past a synthetic listener, not that an ACTUAL popover closes and returns
  // focus to its trigger, the behaviour a Sheet/dialog ancestor relies on in production.
  it("Escape on an empty draft closes the real popover and returns focus to the trigger", async () => {
    await renderInProvider({ variant: "collapsed" });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="shell-search-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      await Promise.resolve();
    });
    const input = await new Promise<HTMLInputElement>((resolve) => {
      void waitFor(() => {
        const element = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]');
        expect(element).not.toBeNull();
        resolve(element!);
      });
    });
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("");

    await keydown(input, { key: "Escape" });

    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });
    expect(document.activeElement).toBe(trigger);
  });

  // #217 design-review, item 8: previously the FIRST Escape only cleared (and stopped
  // propagation, so the popover never saw the keystroke) and a SECOND Escape was needed to close
  // it. One Escape now does both.
  it("a single Escape on a non-empty draft both clears it and closes the popover, returning focus to the trigger", async () => {
    await renderInProvider({ variant: "collapsed" });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="shell-search-trigger"]')!;
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      await Promise.resolve();
    });
    const input = await new Promise<HTMLInputElement>((resolve) => {
      void waitFor(() => {
        const element = document.querySelector<HTMLInputElement>('[data-testid="shell-search"]');
        expect(element).not.toBeNull();
        resolve(element!);
      });
    });
    await type(input, "smith");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");

    await keydown(input, { key: "Escape" });

    expect(__getDashboardSearchSnapshotForTest().draft).toBe("");
    await waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });
    expect(document.activeElement).toBe(trigger);
  });
});

describe("ShellSearch — sheet", () => {
  it("shows the input inline, drops the ⌘K hint (nothing persistent for it to point at), and carries the touch-target seam", async () => {
    await renderInProvider({ variant: "sheet" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    expect(input.getAttribute("aria-label")).toBe("Search projects");
    expect(host.querySelector('[data-testid="shell-search-shortcut"]')).toBeNull();
    expect(input.closest('[data-testid="shell-search-field"]')?.getAttribute("data-touch-target")).toBe("true");
  });

  // #217 design-review, item 7: the Sheet is the one mode with room for the long placeholder.
  it("keeps the long placeholder, the one mode with room for it", async () => {
    await renderInProvider({ variant: "sheet" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    expect(input.placeholder).toBe("Search address, suburb, client…");
    expect(input.getAttribute("aria-label")).toBe("Search projects");
  });
});

describe("ShellSearch — the ref handle (⌘K)", () => {
  it("expanded: focus() focuses the input directly", async () => {
    const ref = createRef<ShellSearchHandle>();
    await renderInProvider({ variant: "expanded" }, ref);
    await act(async () => { ref.current?.focus(); });
    expect(document.activeElement).toBe(host.querySelector('[data-testid="shell-search"]'));
  });

  it("sheet: focus() focuses the input directly", async () => {
    const ref = createRef<ShellSearchHandle>();
    await renderInProvider({ variant: "sheet" }, ref);
    await act(async () => { ref.current?.focus(); });
    expect(document.activeElement).toBe(host.querySelector('[data-testid="shell-search"]'));
  });

  it("collapsed: focus() opens the popover, then focuses the field once it mounts", async () => {
    const ref = createRef<ShellSearchHandle>();
    await renderInProvider({ variant: "collapsed" }, ref);
    expect(host.querySelector('[data-testid="shell-search"]')).toBeNull();
    await act(async () => { ref.current?.focus(); });
    await waitFor(() => {
      const input = document.querySelector('[data-testid="shell-search"]');
      expect(input).not.toBeNull();
      expect(document.activeElement).toBe(input);
    });
  });
});

describe("ShellSearch — Enter", () => {
  it("on the Dashboard: commits the search without navigating", async () => {
    await renderInProvider({ variant: "expanded", isDashboard: true });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await type(input, "smith");
    await keydown(input, { key: "Enter" });
    expect(routerMock.push).not.toHaveBeenCalled();
    expect(__getDashboardSearchSnapshotForTest().query).toBe("smith");
  });

  it("off the Dashboard: commits the search and pushes the Dashboard route carrying it", async () => {
    await renderInProvider({ variant: "expanded", isDashboard: false });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await type(input, "smith");
    await keydown(input, { key: "Enter" });
    expect(__getDashboardSearchSnapshotForTest().query).toBe("smith");
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith("/?q=smith");
  });

  it("off the Dashboard: a 201-character draft pushes the committed, 200-character-capped value, not the raw draft (#217 fix round 1, item 5)", async () => {
    await renderInProvider({ variant: "expanded", isDashboard: false });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await type(input, "a".repeat(201));
    await keydown(input, { key: "Enter" });
    expect(__getDashboardSearchSnapshotForTest().query.length).toBe(200);
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    const pushed = routerMock.push.mock.calls[0]?.[0] as string;
    const pushedQuery = new URL(pushed, "https://example.test").searchParams.get("q");
    expect(pushedQuery?.length).toBe(200);
  });

  it("off the Dashboard: a whitespace-only draft navigates to the Dashboard with no q (#217 fix round 1, item 5)", async () => {
    await renderInProvider({ variant: "expanded", isDashboard: false });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await type(input, "   ");
    await keydown(input, { key: "Enter" });
    expect(__getDashboardSearchSnapshotForTest().query).toBe("");
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith("/");
  });
});

describe("ShellSearch — Escape", () => {
  it("clears a non-empty draft without preventing the keystroke's default", async () => {
    await renderInProvider({ variant: "expanded" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await type(input, "smith");
    expect(__getDashboardSearchSnapshotForTest().draft).toBe("smith");

    // `stopPropagation` alone, never `preventDefault` — the seam under test is that a listener
    // ABOVE the React root never sees the event, checked next; `dispatchEvent`'s return value
    // (false only when `preventDefault` was called on a cancelable event) stays `true`.
    const defaultPrevented = await keydown(input, { key: "Escape" });
    expect(__getDashboardSearchSnapshotForTest()).toMatchObject({ draft: "", query: "" });
    expect(defaultPrevented).toBe(false);
  });

  it("lets an empty draft's Escape bubble, so an ancestor (Sheet/dialog) can close on it", async () => {
    await renderInProvider({ variant: "expanded" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    // A listener on `document`, genuinely ABOVE the React root (`host`) in the real DOM tree —
    // `host` itself is where React 18+ attaches its own root-delegated listeners, so a listener
    // registered there instead would fire regardless of `stopPropagation` (same node, same
    // phase, not stopped by anything short of `stopImmediatePropagation`).
    const ancestorListener = vi.fn();
    document.addEventListener("keydown", ancestorListener);
    await keydown(input, { key: "Escape" });
    expect(ancestorListener).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", ancestorListener);
  });

  it("a non-empty draft's Escape does not reach a listener above the React root", async () => {
    await renderInProvider({ variant: "expanded" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await type(input, "smith");
    const ancestorListener = vi.fn();
    document.addEventListener("keydown", ancestorListener);
    await keydown(input, { key: "Escape" });
    expect(ancestorListener).not.toHaveBeenCalled();
    document.removeEventListener("keydown", ancestorListener);
  });
});
