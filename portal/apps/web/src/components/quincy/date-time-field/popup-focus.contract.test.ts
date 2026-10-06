/**
 * Popup body focus contract (#658, item 1 of #656). The date/time popup body's scroll viewport is a real Tab stop
 * (Base UI gives every overflowing viewport tabIndex 0), but it carries its own mask and sits inside FramePanel's
 * `overflow-hidden`, so any ring drawn outside it is clipped. The ring is an INSET outline on the PopupFrame's
 * ScrollArea root (the `ProjectFields.tsx` CHECK_TILE shape). Source-text guard: happy-dom resolves no cascade.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openingTag } from "../container-focus.guard.test";

const source = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "PopupFrame.tsx"), "utf8");
const VIEWPORT = "[data-slot=scroll-area-viewport]:focus-visible";

describe("PopupFrame body's keyboard focus ring is inset, not an outside ring", () => {
  const tag = openingTag(source, "ScrollArea", "[--fade-size:var(--space-6)]");

  it("finds the body ScrollArea", () => {
    expect(tag).not.toBeNull();
  });
  it("draws no outside ring (clipped by FramePanel's overflow-hidden)", () => {
    expect(tag).not.toContain("ring-[3px]");
  });
  it("silences the viewport's own outline (the mask would clip it)", () => {
    expect(tag).toContain(`*:data-[slot=scroll-area-viewport]:focus-visible:!outline-none`);
  });
  it("outlines the root inset while the viewport is focus-visible", () => {
    expect(tag).toContain(`has-[${VIEWPORT}]:outline-solid`);
    expect(tag).toContain(`has-[${VIEWPORT}]:outline-[length:var(--border-width-bold)]`);
    expect(tag).toContain(`has-[${VIEWPORT}]:outline-[var(--focus-ring)]`);
    expect(tag).toContain(`has-[${VIEWPORT}]:-outline-offset-2`);
    expect(tag).toContain("-outline-offset-2");
    expect(tag).toContain("rounded-[inherit]");
  });
});
