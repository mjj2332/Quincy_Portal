/**
 * #498 design review: the phone sets `--wb-control-size:44px` on the chrome layer, and every custom
 * control must read it (32px on desktop, 44px at <=721px, uniform). happy-dom has no layout, so this pins
 * the class contract on the real rendered DOM, including what tailwind-merge leaves of `button.tsx`'s
 * own `size-8` / `min-h-[38px]` and `toggle.tsx`'s `h-8 min-w-8`.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhiteboardChrome, type ChromeState } from "./whiteboard-controls";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement;
const noop = vi.fn();

const state = (over: Partial<ChromeState> = {}): ChromeState => ({
  tool: "selection", zoom: 1, grid: true, snap: false, viewMode: false, selected: false,
  penMode: false, penDetected: false, phone: false, narrow: false, frameAt: null, ...over,
});

async function render(over: Partial<ChromeState> = {}) {
  await act(async () => {
    root!.render(
      <WhiteboardChrome
        state={state(over)} history={{ undo: true, redo: true }} frames={[{ id: "f1", name: "One" }, { id: "f2", name: "Two" }]}
        viewOnlyLocked={false} imageTool={false} platform="other" loading={false} menuFocus={undefined}
        actions={[{ id: "act", label: "Action", icon: <i />, disabled: false, onSelect: noop } as never]}
        onTool={noop} onZoom={noop} onFit={noop} onPreference={noop} onViewOnly={noop} onHistory={noop}
        onFrame={noop} onFind={noop} onShortcuts={noop} footerRef={noop} layerRef={noop}
      />,
    );
    await Promise.resolve();
  });
}

beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root!.unmount(); await Promise.resolve(); }); host.remove(); root = null; });

// A tooltip trigger's render prop replaces the child's `data-slot`, so controls are told apart by class.
const buttons = () => [...host.querySelectorAll<HTMLElement>("button[aria-label]")];

const SQUARE = "size-[var(--wb-control-size,2rem)]";
const TOGGLE_H = "h-[var(--wb-control-size,2rem)]";
const TOGGLE_W = "min-w-[var(--wb-control-size,2rem)]";

describe("whiteboard controls follow --wb-control-size (#498)", () => {
  for (const phone of [false, true]) {
    it(`every icon button reads the token (phone=${phone})`, async () => {
      await render({ phone });
      const icons = buttons().filter((b) => !b.className.includes("group/toggle") && !b.textContent?.trim());
      expect(icons.length).toBeGreaterThan(3);
      for (const button of icons) {
        expect(button.className, button.getAttribute("aria-label") ?? "").toContain(SQUARE);
        expect(button.className).not.toMatch(/(^|\s)size-8(\s|$)/);
      }
    });

    it(`toggle items (tools, More, view toggles) read the token (phone=${phone})`, async () => {
      await render({ phone });
      const items = buttons().filter((b) => b.className.includes("group/toggle"));
      expect(items.length).toBeGreaterThan(3);
      for (const item of items) {
        expect(item.className, item.getAttribute("aria-label") ?? "").toContain(TOGGLE_H);
        expect(item.className).toContain(TOGGLE_W);
        expect(item.className).not.toMatch(/(^|\s)h-8(\s|$)/);
        expect(item.className).not.toMatch(/(^|\s)min-w-8(\s|$)/);
      }
    });

    it(`the zoom percentage button's height reads the token and beats the 38px floor (phone=${phone})`, async () => {
      await render({ phone });
      const zoom = host.querySelector<HTMLElement>('[aria-label^="Zoom 100%"]')!;
      expect(zoom.className).toContain("min-h-[var(--wb-control-size,2rem)]");
      expect(zoom.className).not.toContain("min-h-[38px]");
      expect(zoom.className).not.toMatch(/(^|\s)h-8(\s|$)/);
    });
  }
});
