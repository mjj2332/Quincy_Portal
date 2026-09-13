import { useContext, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Sheet } from "../reui/sheet";
import { RailSheet } from "./RailSheet";
import { OverlayContainerContext } from "../OverlayContainerContext";

/**
 * `RailSheet` in isolation — #112. `App-navigation-rail-shell.dom.test.tsx` proves it wired
 * into the real shell; this file proves the composition itself: the nested-overlay slot lands
 * inside the popup, the title names the dialog "Navigation" with no close button, the scrim
 * `overlayProps` passthrough actually reaches the DOM, and Escape reaches the caller's
 * `onOpenChange` — all independent of `RailedShell`'s own state.
 */

function ContainerProbe() {
  const container = useContext(OverlayContainerContext);
  return <div data-testid="rail-sheet-probe" data-has-container={container ? "yes" : "no"} />;
}

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(children: React.ReactNode) {
  await act(async () => {
    root!.render(children);
    await Promise.resolve();
    await Promise.resolve();
  });
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
  document.body.replaceChildren();
});

describe("RailSheet", () => {
  it("provides a non-null overlay slot inside its own popup", async () => {
    await render(
      <Sheet open onOpenChange={() => {}}>
        <RailSheet>
          <ContainerProbe />
        </RailSheet>
      </Sheet>,
    );

    const popup = document.querySelector('[data-testid="rail-sheet"]');
    const probe = document.querySelector('[data-testid="rail-sheet-probe"]');
    expect(probe?.getAttribute("data-has-container")).toBe("yes");
    expect(popup?.contains(probe)).toBe(true);
  });

  it("names the dialog Navigation and renders no close button", async () => {
    await render(
      <Sheet open onOpenChange={() => {}}>
        <RailSheet>
          <div>content</div>
        </RailSheet>
      </Sheet>,
    );

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const titleId = dialog?.getAttribute("aria-labelledby") ?? "";
    const title = document.getElementById(titleId);
    expect(title?.textContent).toBe("Navigation");
    expect(dialog?.contains(title)).toBe(true);
    expect(dialog?.querySelector("button")).toBeNull();
  });

  it("passes overlayProps through to the backdrop, proving the scrim test id", async () => {
    await render(
      <Sheet open onOpenChange={() => {}}>
        <RailSheet>
          <div>content</div>
        </RailSheet>
      </Sheet>,
    );

    expect(document.querySelector('[data-testid="rail-sheet-scrim"]')).not.toBeNull();
  });

  it("calls onOpenChange(false) on Escape", async () => {
    const onOpenChange = vi.fn();
    await render(
      <Sheet open onOpenChange={onOpenChange}>
        <RailSheet>
          <div>content</div>
        </RailSheet>
      </Sheet>,
    );

    const popup = document.querySelector('[data-testid="rail-sheet"]')!;
    await act(async () => {
      popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onOpenChange).toHaveBeenCalled();
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
  });
});
