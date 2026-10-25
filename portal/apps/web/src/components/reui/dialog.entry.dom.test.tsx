import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "./dialog";

/**
 * #933 fix round 1: `DialogContent`'s scoped `entry="none"` opt-in (the staff review viewer reached by a step, #936) draws the popup and its backdrop with no open animation,
 * and leaves the close animation alone. A caller that passes nothing gets the registry's fade and zoom exactly as before.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  document.body.replaceChildren();
});

async function mount(entry?: "none") {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => {
    root!.render(<Dialog open onOpenChange={() => undefined}>
      <DialogContent data-testid="popup" showCloseButton={false} {...(entry ? { entry } : {})} overlayProps={{ "data-testid": "backdrop" }}><DialogTitle>Film</DialogTitle></DialogContent>
    </Dialog>);
  });
  return {
    popup: document.querySelector<HTMLElement>('[data-testid="popup"]')!,
    backdrop: document.querySelector<HTMLElement>('[data-testid="backdrop"]')!,
  };
}

describe("DialogContent entry", () => {
  it("animates in by default: fade and zoom on the popup, fade on the backdrop", async () => {
    const { popup, backdrop } = await mount();
    expect(popup.className).toContain("data-open:animate-in");
    expect(popup.className).toContain("data-open:zoom-in-95");
    expect(backdrop.className).toContain("data-open:animate-in");
  });

  it('entry="none" drops the open animation on both, keeping the close animation', async () => {
    const { popup, backdrop } = await mount("none");
    for (const part of [popup, backdrop]) {
      expect(part.className).not.toContain("animate-in");
      expect(part.className).not.toContain("fade-in-0");
      expect(part.className).toContain("data-closed:animate-out");
    }
    expect(popup.className).not.toContain("zoom-in-95");
  });
});
