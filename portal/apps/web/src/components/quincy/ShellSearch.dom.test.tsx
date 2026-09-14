import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProvider } from "@/components/reui/sidebar";
import { TooltipProvider } from "@/components/reui/tooltip";
import { ShellSearch, type ShellSearchProps } from "./ShellSearch";

/**
 * The rail's project-search control — #122 P3. Mirrors `NavigationRail.dom.test.tsx`'s own
 * `renderInProvider`: `reui/sidebar.tsx`'s primitives throw outside a `SidebarProvider`, and the
 * collapsed tooltip needs a zero-delay `TooltipProvider` rather than a real hover-intent wait.
 */

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); });
}

async function renderInProvider(props: Partial<ShellSearchProps> & { variant: ShellSearchProps["variant"] }) {
  const { variant, onActivate = () => {} } = props;
  await render(
    <SidebarProvider open={variant !== "collapsed"} onOpenChange={() => {}}>
      <TooltipProvider delay={0}>
        <ShellSearch variant={variant} onActivate={onActivate} />
      </TooltipProvider>
    </SidebarProvider>,
  );
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    await Promise.resolve();
  });
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
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host.remove();
});

describe("ShellSearch — expanded", () => {
  it("shows the label and the ⌘K hint", async () => {
    await renderInProvider({ variant: "expanded" });
    const control = host.querySelector('[data-testid="shell-search"]')!;
    expect(control.textContent).toContain("Search projects");
    expect(host.querySelector('[data-testid="shell-search-shortcut"]')?.textContent).toBe("⌘K");
  });

  it("carries no touch-target seam", async () => {
    await renderInProvider({ variant: "expanded" });
    expect(host.querySelector('[data-testid="shell-search"]')?.getAttribute("data-touch-target")).toBeNull();
  });
});

describe("ShellSearch — collapsed", () => {
  it("hides the visible label and the ⌘K hint, keeping the accessible name", async () => {
    await renderInProvider({ variant: "collapsed" });
    const control = host.querySelector('[data-testid="shell-search"]')!;
    expect(control.getAttribute("aria-label")).toBe("Search projects");
    expect(host.querySelector('[data-testid="shell-search-shortcut"]')).toBeNull();
  });

  it("shows a tooltip on hover", async () => {
    await renderInProvider({ variant: "collapsed" });
    const control = host.querySelector('[data-testid="shell-search"]')!;
    expect(document.querySelector('[data-testid="rail-tooltip-search"]')).toBeNull();

    await act(async () => {
      control.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }));
      control.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      control.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      const tooltip = document.querySelector('[data-testid="rail-tooltip-search"]');
      expect(tooltip).not.toBeNull();
      expect(tooltip?.textContent).toBe("Search projects");
    });
  });
});

describe("ShellSearch — sheet", () => {
  it("shows the label, drops the ⌘K hint (inert there), and carries the touch-target seam", async () => {
    await renderInProvider({ variant: "sheet" });
    const control = host.querySelector('[data-testid="shell-search"]')!;
    expect(control.textContent).toContain("Search projects");
    expect(host.querySelector('[data-testid="shell-search-shortcut"]')).toBeNull();
    expect(control.getAttribute("data-touch-target")).toBe("true");
  });
});

describe("ShellSearch — activation", () => {
  it("calls onActivate when clicked", async () => {
    const onActivate = vi.fn();
    await renderInProvider({ variant: "expanded", onActivate });
    await click(host.querySelector('[data-testid="shell-search"]')!);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});
