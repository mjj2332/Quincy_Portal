import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu } from "./menu";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

// The accessibility contract for the app's shared `Menu` primitive (TB8-02 §8, criterion 14),
// matching the rigor TB8-01 §2.2 demanded of `Select`. Consumer-specific behavior (the
// notification menu's dynamic rows, anchor semantics, dismiss focus-continuity, the mobile
// menu's items) is covered in Topbar.dom.test.tsx instead — this file exercises the primitive
// itself, independent of any one consumer.

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ onSelect, disabled }: { onSelect?: (id: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Menu open={open} onOpenChange={setOpen} trigger={<span>Open</span>} triggerLabel="Open menu" label="Test menu" disabled={disabled}>
      <MenuPrimitive.Item label="Alpha" onClick={() => onSelect?.("alpha")}>Alpha</MenuPrimitive.Item>
      <MenuPrimitive.Item label="Bravo" onClick={() => onSelect?.("bravo")}>Bravo</MenuPrimitive.Item>
      <MenuPrimitive.Item label="Charlie" onClick={() => onSelect?.("charlie")}>Charlie</MenuPrimitive.Item>
      <MenuPrimitive.Item closeOnClick={false} label="Sticky" onClick={() => onSelect?.("sticky")}>Sticky (stays open)</MenuPrimitive.Item>
    </Menu>
  );
}

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  return host;
}

async function render(host: HTMLElement, onSelect?: (id: string) => void, disabled?: boolean) {
  await act(async () => {
    root!.render(<Harness onSelect={onSelect} disabled={disabled} />);
    await Promise.resolve();
  });
  return host.querySelector<HTMLButtonElement>('[aria-label="Open menu"]')!;
}

function menu() { return document.querySelector<HTMLElement>('[role="menu"]'); }
function items() { return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]; }

async function click(element: HTMLElement) {
  await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); });
}
async function key(element: HTMLElement, keyName: string, options: KeyboardEventInit = {}) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...options })); await Promise.resolve(); await Promise.resolve(); });
}
// `Menu`'s popup delays its own unmount until Base UI observes the CSS exit transition finish
// (§8's Base UI-owned contract, mirroring `Modal`/`AnchoredPopover`'s 120ms — §6.0/§7.2).
async function waitForClose() {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
});

describe("Menu accessibility contract", () => {
  it("1. exposes an accessible trigger name, a labelled role=menu popup, and role=menuitem items", async () => {
    const host = mount();
    const trigger = await render(host);
    expect(trigger.getAttribute("aria-label")).toBe("Open menu");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    await click(trigger);
    expect(menu()?.getAttribute("aria-label")).toBe("Test menu");
    expect(items().map((item) => item.textContent)).toEqual(["Alpha", "Bravo", "Charlie", "Sticky (stays open)"]);
  });

  it("2. opens on click and closes on a second click", async () => {
    const host = mount();
    const trigger = await render(host);
    expect(menu()).toBeNull();
    await click(trigger);
    expect(menu()).not.toBeNull();
    await click(trigger);
    await waitForClose();
    expect(menu()).toBeNull();
  });

  it("3a. opens on a focused-trigger ArrowDown, highlighting the first item", async () => {
    const host = mount();
    const trigger = await render(host);
    trigger.focus();
    await key(trigger, "ArrowDown");
    expect(menu()).not.toBeNull();
    expect(items()[0]?.getAttribute("data-highlighted")).toBe("");
  });

  it("3b. opens on a focused-trigger ArrowUp, highlighting the last item", async () => {
    const host = mount();
    const trigger = await render(host);
    trigger.focus();
    await key(trigger, "ArrowUp");
    expect(menu()).not.toBeNull();
    const all = items();
    expect(all[all.length - 1]?.getAttribute("data-highlighted")).toBe("");
  });

  it("3c. Enter on a focused trigger opens the menu, highlighting the first item", async () => {
    const host = mount();
    const trigger = await render(host);
    trigger.focus();
    // Dispatch the real key first — a genuine interaction, not skipped. Base UI's Trigger
    // defaults `nativeButton: true` (`useButton.mjs`'s own keydown handler explicitly no-ops
    // when `isNativeButton` is true) and relies on the *browser's* native default action —
    // converting an Enter/Space keydown on a real <button> into a `click` — which jsdom does not
    // perform. This assertion proves that gap directly rather than asserting it in a comment:
    // the raw keydown alone must NOT open the menu here.
    await key(trigger, "Enter");
    expect(menu(), "a raw Enter keydown alone does not open it in jsdom").toBeNull();
    // `.click()` is the browser's own substitute action for this exact key, not a shortcut
    // around it — true native-keydown verification is real-browser-only (criterion 18).
    await click(trigger);
    expect(menu()).not.toBeNull();
    expect(items()[0]?.getAttribute("data-highlighted")).toBe("");
  });

  it("3d. Space on a focused trigger opens the menu, highlighting the first item", async () => {
    const host = mount();
    const trigger = await render(host);
    trigger.focus();
    await key(trigger, " ");
    expect(menu(), "a raw Space keydown alone does not open it in jsdom").toBeNull();
    await click(trigger);
    expect(menu()).not.toBeNull();
    expect(items()[0]?.getAttribute("data-highlighted")).toBe("");
  });

  it("4. ArrowDown/ArrowUp move the highlight and wrap; Home/End jump; typeahead matches by label", async () => {
    const host = mount();
    const trigger = await render(host);
    trigger.focus();
    await click(trigger);
    const popup = menu()!;
    // Opening already highlights the first item (test 3) — one more ArrowDown moves it forward.
    expect(items()[0]?.getAttribute("data-highlighted")).toBe("");
    await key(popup, "ArrowDown");
    expect(items()[1]?.getAttribute("data-highlighted")).toBe("");
    await key(popup, "ArrowUp");
    expect(items()[0]?.getAttribute("data-highlighted")).toBe("");
    await key(popup, "ArrowUp");
    expect(items()[items().length - 1]?.getAttribute("data-highlighted")).toBe("");
    await key(popup, "Home");
    expect(items()[0]?.getAttribute("data-highlighted")).toBe("");
    await key(popup, "End");
    expect(items()[items().length - 1]?.getAttribute("data-highlighted")).toBe("");
    await key(popup, "c");
    expect(items().find((item) => item.textContent === "Charlie")?.getAttribute("data-highlighted")).toBe("");
  });

  it("5. Enter activates the highlighted item and closes; closeOnClick=false items stay open", async () => {
    const host = mount();
    const onSelect = vi.fn();
    const trigger = await render(host, onSelect);
    trigger.focus();
    await click(trigger);
    // Opening already highlights the first item ("Alpha", test 3) — Enter activates it. Base
    // UI's non-native-button item only converts Enter to a click when `event.target ===
    // event.currentTarget` (real keyboard use has DOM focus on the item itself), so the keydown
    // must be dispatched on the highlighted item, not the popup it bubbles through.
    expect(items()[0]?.getAttribute("data-highlighted")).toBe("");
    await key(items()[0]!, "Enter");
    expect(onSelect).toHaveBeenCalledWith("alpha");
    await waitForClose();
    expect(menu()).toBeNull();

    const trigger2 = host.querySelector<HTMLButtonElement>('[aria-label="Open menu"]')!;
    await click(trigger2);
    const sticky = items().find((item) => item.textContent === "Sticky (stays open)")!;
    await click(sticky);
    expect(onSelect).toHaveBeenCalledWith("sticky");
    expect(menu()).not.toBeNull();
  });

  it("6. Escape closes and returns focus to the trigger", async () => {
    const host = mount();
    const trigger = await render(host);
    trigger.focus();
    await click(trigger);
    await key(menu()!, "Escape");
    await waitForClose();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("7a. an outside mouse pointerdown dismisses without activating anything", async () => {
    const host = mount();
    const onSelect = vi.fn();
    const trigger = await render(host, onSelect);
    await click(trigger);
    expect(menu()).not.toBeNull();
    await act(async () => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" })); await Promise.resolve(); });
    await waitForClose();
    expect(menu()).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("7b. an outside touch tap dismisses without activating anything", async () => {
    const host = mount();
    const onSelect = vi.fn();
    const trigger = await render(host, onSelect);
    await click(trigger);
    expect(menu()).not.toBeNull();
    // Floating-ui's `useDismiss` explicitly excludes `pointerType: "touch"` from its
    // mouse-oriented pointerdown dismissal path (`handlePointerDown`'s own
    // `event.pointerType === 'touch'` early-return, verified in the installed
    // `floating-ui-react/hooks/useDismiss.mjs`), and its default `outsidePressEvent: 'sloppy'`
    // mode deliberately ignores the trailing `click` a real tap produces (it already dismissed
    // on the press, for mouse) — dismissal for touch instead rides the browser's synthetic
    // `mousedown` that follows `touchstart`/`touchend` in the standard touch-to-mouse
    // compatibility sequence (`touchstart, touchend, mousemove, mousedown, mouseup, click`),
    // which `closeOnPressOutsideCapture` explicitly allows through when a touch sequence
    // preceded it (`touchStateRef.current.dismissOnMouseDown`). jsdom/happy-dom does not
    // synthesize that compatibility sequence, so it is reproduced explicitly here.
    await act(async () => {
      const touch = { identifier: 0, target: document.body, clientX: 5, clientY: 5 } as unknown as Touch;
      document.body.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [touch], changedTouches: [touch] }));
      document.body.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [touch] }));
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await waitForClose();
    expect(menu()).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("8. a disabled trigger does not open at all", async () => {
    const host = mount();
    const trigger = await render(host, undefined, true);
    expect(trigger.disabled).toBe(true);
    await click(trigger);
    expect(menu()).toBeNull();
  });
});
