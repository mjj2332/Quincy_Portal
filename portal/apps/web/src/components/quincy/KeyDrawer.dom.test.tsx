/**
 * #916 design review: the phone's Key drawer, shared by the Timeline (frame 3c) and the Calendar (owner decision, item 4).
 * The trigger is detached (it sits in each view's nav row, apart from the drawer's root), and a press on the backdrop
 * while the drawer is still sliding in never dismisses it (session row 16: a tap meant for Colour by closed the drawer).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyDrawer, KeyDrawerTrigger, useKeyDrawer } from "./KeyDrawer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const originalGetAnimations = Element.prototype.getAnimations;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); await Promise.resolve(); });
  document.body.replaceChildren();
  Element.prototype.getAnimations = originalGetAnimations;
});

async function frames(count = 4) {
  for (let i = 0; i < count; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

/** The drawer's root and its trigger in different subtrees: the trigger in a nav row, the root in an always-mounted band. */
function Harness({ withTrigger = true }: { withTrigger?: boolean }) {
  const drawer = useKeyDrawer();
  return (
    <div>
      <nav>{withTrigger && <KeyDrawerTrigger drawer={drawer} testIdPrefix="test" />}</nav>
      <section>
        <KeyDrawer drawer={drawer} testIdPrefix="test" colourBySlot={<button type="button" data-testid="colour-by-slot">Colour by</button>}>
          <span data-testid="stage-key-row" />
        </KeyDrawer>
      </section>
    </div>
  );
}

const trigger = () => host.querySelector<HTMLButtonElement>('[data-testid="test-key-button"]');
const drawerEl = () => document.querySelector<HTMLElement>('[data-testid="test-key-drawer"]');

function pressOutside(target: Element) {
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
    const init = { bubbles: true, cancelable: true, button: 0, pointerType: "touch" } as PointerEventInit;
    target.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, init) : new MouseEvent(type, init));
  }
}

describe("KeyDrawer", () => {
  it("is a 44px Key button, apart from the drawer, that opens the key row and the Colour by slot", async () => {
    await act(async () => { root.render(<Harness />); });
    const button = trigger()!;
    expect(button.textContent).toBe("Key");
    expect(button.className.split(/\s+/)).toContain("h-11");
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(drawerEl()).toBeNull();
    await act(async () => { button.click(); await Promise.resolve(); });
    await frames();
    const drawer = drawerEl()!;
    expect(drawer).not.toBeNull();
    expect(drawer.querySelector('[data-testid="stage-key-row"]')).not.toBeNull();
    expect(drawer.querySelector('[data-testid="colour-by-slot"]')).not.toBeNull();
  });

  it("a press on the backdrop while the drawer is still opening leaves it open; once it has opened, the same press closes it", async () => {
    // Hold the opening animation: Base UI reports the open complete only when the popup's animations finish.
    let finish!: () => void;
    const opening = new Promise<void>((resolve) => { finish = resolve; });
    Element.prototype.getAnimations = function getAnimations() {
      return [{ finished: opening, pending: false, playState: "running" } as unknown as Animation];
    };
    await act(async () => { root.render(<Harness />); });
    await act(async () => { trigger()!.click(); await Promise.resolve(); });
    await frames();
    const backdrop = () => document.querySelector<HTMLElement>('[data-testid="test-key-drawer"]')?.parentElement;
    expect(backdrop()).toBeTruthy();
    await act(async () => { pressOutside(backdrop()!); await Promise.resolve(); });
    await frames();
    expect(drawerEl()?.hasAttribute("data-open")).toBe(true);

    await act(async () => { finish(); await opening; });
    await frames();
    await act(async () => { pressOutside(backdrop()!); await Promise.resolve(); });
    await frames();
    expect(drawerEl()?.hasAttribute("data-open") ?? false).toBe(false);
  });
});
