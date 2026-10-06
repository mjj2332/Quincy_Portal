import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScrollArea } from "./scroll-area";

/**
 * #657 — `viewportProps` reaches the viewport element. happy-dom never overflows, so Base UI's own
 * `tabIndex` default cannot be observed here; a pass-through attribute proves the spread.
 */

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no Web Animations API; Base UI's viewport timer calls `getAnimations()`.
beforeEach(() => { (HTMLElement.prototype as { getAnimations?: () => unknown[] }).getAnimations ??= () => []; host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root?.unmount()); root = null; host.remove(); });

async function render(node: React.ReactNode) {
  await act(async () => { root!.render(node); await Promise.resolve(); });
}

describe("ScrollArea viewportProps", () => {
  it("spreads viewportProps onto the viewport element", async () => {
    await render(
      <ScrollArea viewportProps={{ "data-testid": "vp", tabIndex: -1 } as never}>
        <p>content</p>
      </ScrollArea>,
    );
    const vp = host.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement;
    expect(vp.getAttribute("data-testid")).toBe("vp");
    expect(vp.getAttribute("tabindex")).toBe("-1");
  });

  it("renders without viewportProps", async () => {
    await render(<ScrollArea><p>content</p></ScrollArea>);
    expect(host.querySelector('[data-slot="scroll-area-viewport"]')).not.toBeNull();
  });
});
