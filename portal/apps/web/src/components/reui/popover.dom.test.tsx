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
