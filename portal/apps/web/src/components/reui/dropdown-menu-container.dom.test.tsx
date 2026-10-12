import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { OverlayContainerContext } from "@/components/OverlayContainerContext";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";

/**
 * #826 — `DropdownMenuContent` portals into `OverlayContainerContext` (a QUINCY ADAPTATION, recorded
 * in the file's header), the same normalisation as `reui/popover.dom.test.tsx` and
 * `reui/tooltip.dom.test.tsx`. Without it a menu opened inside the Project sheet lands on `body` at
 * `--z-menu` (92), under the sheet's `--z-dialog` (95). Queries go by role / test id only.
 */
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
});

async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); await Promise.resolve(); await Promise.resolve(); });
  return host;
}

const Menu = () => (
  <DropdownMenu open>
    <DropdownMenuTrigger>Open</DropdownMenuTrigger>
    <DropdownMenuContent data-testid="menu-content">
      <DropdownMenuItem>Alpha</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

describe("DropdownMenuContent — portals inside OverlayContainerContext (#826)", () => {
  it("portals into the provided container instead of document.body", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    await mount(<OverlayContainerContext.Provider value={container}><Menu /></OverlayContainerContext.Provider>);
    const content = document.querySelector('[data-testid="menu-content"]');
    expect(content).not.toBeNull();
    expect(container.contains(content)).toBe(true);
  });

  it("falls back to document.body when no container is provided (the page-level default)", async () => {
    const host = await mount(<Menu />);
    const content = document.querySelector('[data-testid="menu-content"]');
    expect(content).not.toBeNull();
    expect(host.contains(content)).toBe(false);
    expect(document.body.contains(content)).toBe(true);
  });
});
