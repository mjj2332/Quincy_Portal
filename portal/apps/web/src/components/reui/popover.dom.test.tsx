import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OverlayContainerContext } from "@/components/OverlayContainerContext";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

/**
 * base-nova's `popover.tsx`, vendored for #122 P2 (ADR 0005 addendum). The z-token conformance
 * edit (`z-50` → `z-[var(--z-popover)]`) is non-behavioural and not re-tested here — this covers
 * the one behavioural-looking edit a DOM test can actually see, the container normalisation,
 * mirroring `reui/tooltip.dom.test.tsx`.
 */

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); await Promise.resolve(); });
}

/** Real-timer poll — Base UI's open-state transition lands a tick removed from the triggering render. */
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
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  host.remove();
});

describe("PopoverContent — portals inside OverlayContainerContext (#122 P2)", () => {
  it("portals into the provided container instead of document.body", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    try {
      await render(
        <OverlayContainerContext.Provider value={container}>
          <Popover open modal={false}>
            <PopoverTrigger data-testid="trigger">Open</PopoverTrigger>
            <PopoverContent data-testid="popover-content">Hello</PopoverContent>
          </Popover>
        </OverlayContainerContext.Provider>,
      );

      await waitFor(() => {
        const content = document.querySelector('[data-testid="popover-content"]');
        expect(content).not.toBeNull();
        expect(container.contains(content)).toBe(true);
      });
    } finally {
      container.remove();
    }
  });

  it("falls back to document.body when no container is provided (the page-level default)", async () => {
    await render(
      <Popover open modal={false}>
        <PopoverTrigger data-testid="trigger">Open</PopoverTrigger>
        <PopoverContent data-testid="popover-content">Hello</PopoverContent>
      </Popover>,
    );

    await waitFor(() => {
      const content = document.querySelector('[data-testid="popover-content"]');
      expect(content).not.toBeNull();
      expect(host.contains(content)).toBe(false);
      expect(document.body.contains(content)).toBe(true);
    });
  });
});

describe("PopoverContent — anchor and positionMethod reach the Positioner (#113)", () => {
  /**
   * happy-dom cannot lay a real page out, so this does not assert final pixel coordinates —
   * it proves the two PROPS actually reach `Popover.Positioner` rather than being silently
   * dropped, the same way the container test above proves normalisation reaches the Portal. Both
   * assertions read floating-ui's own inline `style` on the Positioner element, which is the
   * thing that would stay wrong (default `absolute`, positioned against the trigger) if either
   * prop were declared in the widened `Pick` but never forwarded.
   */
  it("forwards positionMethod, switching the Positioner's own CSS position", async () => {
    await render(
      <Popover open modal={false}>
        <PopoverTrigger data-testid="trigger">Open</PopoverTrigger>
        <PopoverContent data-testid="popover-content" positionMethod="fixed">Hello</PopoverContent>
      </Popover>,
    );

    await waitFor(() => {
      const content = document.querySelector('[data-testid="popover-content"]')!;
      expect(content).not.toBeNull();
      const positioner = content.parentElement!;
      // Base UI's own default is "absolute" — an unforwarded prop would leave this unchanged.
      expect(positioner.style.position).toBe("fixed");
    });
  });

  it("forwards anchor, positioning against the given element rather than the trigger", async () => {
    const anchorEl = document.createElement("div");
    document.body.appendChild(anchorEl);
    // happy-dom's default `getBoundingClientRect` is an all-zero rect (same as the trigger's own
    // default) — an explicit, distinct rect on the anchor is what makes an unforwarded `anchor`
    // prop distinguishable from a forwarded one that just happens to anchor at (0, 0).
    anchorEl.getBoundingClientRect = () => ({
      top: 500, left: 500, bottom: 520, right: 520, width: 20, height: 20, x: 500, y: 500,
      toJSON() { return this; },
    });

    try {
      await render(
        <Popover open modal={false}>
          <PopoverTrigger data-testid="trigger">Open</PopoverTrigger>
          <PopoverContent data-testid="popover-content" anchor={{ current: anchorEl }} positionMethod="fixed">
            Hello
          </PopoverContent>
        </Popover>,
      );

      await waitFor(() => {
        const content = document.querySelector('[data-testid="popover-content"]')!;
        expect(content).not.toBeNull();
        const positioner = content.parentElement!;
        // floating-ui's `transform: translate(x, y)` strategy places the popup at the anchor's
        // own rect — (500, 500) — rather than the trigger's (0, 0). An unforwarded `anchor` prop
        // would leave this at the trigger's coordinates instead.
        expect(positioner.style.transform).toMatch(/translate\(500px, \d+px\)/);
      });
    } finally {
      anchorEl.remove();
    }
  });
});
