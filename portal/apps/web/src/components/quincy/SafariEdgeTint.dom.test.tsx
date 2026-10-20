import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EDGE_TINT_HOLD_MS, SafariEdgeTint } from "./SafariEdgeTint";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const strips = () => [...document.querySelectorAll<HTMLElement>('[data-testid="safari-edge-tint"]')];

beforeEach(() => { vi.useFakeTimers(); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; host.remove(); vi.useRealTimers();
});

describe("SafariEdgeTint (#927 follow-up)", () => {
  it("puts one hidden, non-interactive strip on each edge, bar-shaped (8px, the measured floor is between 4 and 6)", async () => {
    await act(async () => { root!.render(<SafariEdgeTint paint="card" />); });
    const [top, bottom] = strips();
    expect(strips()).toHaveLength(2);
    for (const strip of [top!, bottom!]) {
      expect(strip.getAttribute("aria-hidden")).toBe("true");
      expect(strip.className.split(/\s+/)).toEqual(expect.arrayContaining(["pointer-events-none", "fixed", "inset-x-0", "h-[var(--space-2)]", "bg-card"]));
    }
    expect(top!.className.split(/\s+/)).toContain("top-0");
    expect(bottom!.className.split(/\s+/)).toContain("bottom-0");
  });

  it("paints the page background for the light restore", async () => {
    await act(async () => { root!.render(<SafariEdgeTint paint="background" />); });
    for (const strip of strips()) expect(strip.className.split(/\s+/)).toContain("bg-background");
  });

  it("leaves the DOM after the hold: Safari keeps the tint it took, so nothing stays over the page", async () => {
    await act(async () => { root!.render(<SafariEdgeTint paint="card" />); });
    await act(async () => { vi.advanceTimersByTime(EDGE_TINT_HOLD_MS - 1); });
    expect(strips()).toHaveLength(2);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(strips()).toHaveLength(0);
  });

  it("a new key mounts fresh strips (Safari only samples newly inserted elements)", async () => {
    await act(async () => { root!.render(<SafariEdgeTint key={1} paint="card" />); });
    const first = strips()[0];
    await act(async () => { root!.render(<SafariEdgeTint key={2} paint="card" />); });
    expect(strips()).toHaveLength(2);
    expect(strips()[0]).not.toBe(first);
  });
});
