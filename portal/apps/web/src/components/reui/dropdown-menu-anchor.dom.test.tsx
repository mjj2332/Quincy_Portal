import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "./dropdown-menu";

/**
 * #463 — `DropdownMenuContent`'s additive `anchor` passthrough (a QUINCY ADDITION, recorded in the
 * file's header). A menu with no Trigger can only position against something the consumer hands it:
 * an element (a keyboard open) or a virtual element (a pointer open). Quincy-authored test, not a
 * vendored file. Queries go by role only.
 */
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
});

type Anchor = Element | { getBoundingClientRect: () => DOMRect };

function Harness({ anchor, finalFocus, initiallyOpen = true }: { anchor: Anchor; finalFocus?: () => HTMLElement | null; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <button type="button" id="return-target">Return here</button>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuContent anchor={anchor} finalFocus={finalFocus}>
          <DropdownMenuItem>Alpha</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

async function mount(props: Parameters<typeof Harness>[0]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness {...props} />); await Promise.resolve(); await Promise.resolve(); });
}

const menu = () => document.querySelector<HTMLElement>('[role="menu"]');

describe("DropdownMenuContent anchor (#463)", () => {
  it("opens a Trigger-less menu against an element", async () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    let reads = 0;
    element.getBoundingClientRect = () => { reads += 1; return { x: 10, y: 10, top: 10, left: 10, right: 110, bottom: 30, width: 100, height: 20, toJSON() { return {}; } } as DOMRect; };
    await mount({ anchor: element });
    expect(menu()).not.toBeNull();
    expect(document.querySelector('[role="menuitem"]')?.textContent).toBe("Alpha");
    expect(reads).toBeGreaterThan(0);
  });

  it("opens a Trigger-less menu against a virtual element, reading its rect live", async () => {
    let reads = 0;
    const virtual = { getBoundingClientRect: () => { reads += 1; return { x: 40, y: 20, top: 20, left: 40, right: 41, bottom: 36, width: 1, height: 16, toJSON() { return {}; } } as DOMRect; } };
    await mount({ anchor: virtual });
    expect(menu()).not.toBeNull();
    expect(reads).toBeGreaterThan(0);
  });

  it("honours finalFocus when the menu closes", async () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    await mount({ anchor: element, finalFocus: () => document.getElementById("return-target") });
    await act(async () => { document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(document.getElementById("return-target"));
  });
});
