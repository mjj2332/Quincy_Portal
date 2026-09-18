import { act, createRef } from "react";
import type { ReactNode, RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/reui/sidebar";
import { TooltipProvider } from "@/components/reui/tooltip";
import { ShellSearch, type ShellSearchHandle, type ShellSearchProps } from "./ShellSearch";
import { __resetDashboardSearchStoreForTest, getDashboardSearchSnapshot } from "../../lib/dashboard-search-store";

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
    expect(getDashboardSearchSnapshot().draft).toBe("");

    await keydown(input, { key: "Escape" });

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
    expect(getDashboardSearchSnapshot().query).toBe("smith");
  });

  it("off the Dashboard: commits the search and pushes the Dashboard route carrying it", async () => {
    await renderInProvider({ variant: "expanded", isDashboard: false });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await type(input, "smith");
    await keydown(input, { key: "Enter" });
    expect(getDashboardSearchSnapshot().query).toBe("smith");
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith("/?q=smith");
  });

  it("off the Dashboard: a 201-character draft pushes the committed, 200-character-capped value, not the raw draft (#217 fix round 1, item 5)", async () => {
    await renderInProvider({ variant: "expanded", isDashboard: false });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await type(input, "a".repeat(201));
    await keydown(input, { key: "Enter" });
    expect(getDashboardSearchSnapshot().query.length).toBe(200);
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
    expect(getDashboardSearchSnapshot().query).toBe("");
    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(routerMock.push).toHaveBeenCalledWith("/");
  });
});

describe("ShellSearch — Escape", () => {
  it("clears a non-empty draft without preventing the keystroke's default", async () => {
    await renderInProvider({ variant: "expanded" });
    const input = host.querySelector<HTMLInputElement>('[data-testid="shell-search"]')!;
    await type(input, "smith");
    expect(getDashboardSearchSnapshot().draft).toBe("smith");

    // `stopPropagation` alone, never `preventDefault` — the seam under test is that a listener
    // ABOVE the React root never sees the event, checked next; `dispatchEvent`'s return value
    // (false only when `preventDefault` was called on a cancelable event) stays `true`.
    const defaultPrevented = await keydown(input, { key: "Escape" });
    expect(getDashboardSearchSnapshot()).toMatchObject({ draft: "", query: "" });
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
