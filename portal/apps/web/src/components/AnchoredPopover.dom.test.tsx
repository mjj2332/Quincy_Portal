import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { AnchoredPopover, useAnchoredPopover } from "./AnchoredPopover";
import { ConfirmModalHost } from "./ConfirmDialog";
import { confirm, confirmStore } from "../lib/confirm";

// The alert-dialog press exemption (`lib/alert-dialog-press.ts`, used by `AnchoredPopover.tsx`;
// shipped by `f2d3700`) — a `confirm()` raised from *inside* an open popover must not dismiss
// that popover when the confirm dialog itself is interacted with. TB8-02 §7.1 preserves this
// verbatim; acceptance criterion 6 requires it asserted end-to-end, not just that the attribute
// exists (ConfirmDialog.dom.test.tsx already covers the latter).

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness() {
  const [open, setOpen] = useState(true);
  const floating = useAnchoredPopover({ open, onClose: () => setOpen(false), placement: "bottom-end" });
  return (
    <>
      <button ref={(node) => floating.refs.setReference(node)} type="button">Trigger</button>
      {floating.mounted && (
        <AnchoredPopover context={floating.context} floatingStyles={floating.floatingStyles} initialFocus={0} onKeyDown={floating.onKeyDown} status={floating.status}>
          <button
            type="button"
            onClick={() => {
              void confirm({ title: "Delete?", message: "Really delete this?", danger: true });
            }}
          >
            Delete (raises confirm)
          </button>
        </AnchoredPopover>
      )}
      <ConfirmModalHost />
    </>
  );
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

afterEach(async () => {
  confirmStore.resolve(false);
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
});

describe("AnchoredPopover — confirm-from-inside interlock (criterion 6)", () => {
  it("a confirm() raised from inside an open popover, then interacted with, leaves the popover open", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<Harness />); await Promise.resolve(); });

    const popoverButtonText = "Delete (raises confirm)";
    const deleteButton = [...document.querySelectorAll("button")].find((button) => button.textContent === popoverButtonText)!;
    expect(deleteButton).not.toBeUndefined();
    await act(async () => { deleteButton.click(); await Promise.resolve(); });
    await flush();

    // Raising confirm() from inside the popover must not close the popover itself.
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === popoverButtonText)).toBe(true);

    const confirmDialog = document.querySelector<HTMLElement>('[data-testid="confirm-modal"]')!;
    expect(confirmDialog).not.toBeNull();
    const confirmButton = document.querySelector<HTMLButtonElement>('[data-testid="confirm-modal-confirm"]')!;
    await act(async () => { confirmButton.click(); await Promise.resolve(); });
    await flush();

    // Interacting with the confirm dialog (a click inside it) must not count as "outside" the
    // popover via `AnchoredPopover`'s alert-dialog exemption — the popover is
    // still present after the confirm dialog resolves.
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === popoverButtonText)).toBe(true);
  });

  it("focus wrapping onto the alert dialog's focus guards (Shift+Tab from Cancel, Tab past Confirm) leaves the popover open", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<Harness />); await Promise.resolve(); });
    const deleteButton = [...document.querySelectorAll("button")].find((button) => button.textContent === "Delete (raises confirm)")!;
    await act(async () => { deleteButton.click(); await Promise.resolve(); });
    await flush();
    const guards = [...document.querySelector<HTMLElement>('[data-testid="alert-dialog-scrim"]')!.parentElement!.querySelectorAll<HTMLElement>("[data-base-ui-focus-guard]")];
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) {
      await act(async () => { guard.dispatchEvent(new FocusEvent("focusin", { bubbles: true })); await Promise.resolve(); });
      await flush();
    }
    // The popover stays mounted through its close transition, so wait it out before asserting.
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 300)); });
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Delete (raises confirm)")).toBe(true);
  });
});

describe("AnchoredPopover — initial focus (#663)", () => {
  it("opening focuses the first control in the panel, and the panel itself is not a Tab stop", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<Harness />); await Promise.resolve(); });
    // floating-ui applies initial focus a frame after mount.
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    await flush();

    const deleteButton = [...document.querySelectorAll("button")].find((button) => button.textContent === "Delete (raises confirm)")!;
    expect(document.activeElement).toBe(deleteButton);
    const panel = document.querySelector<HTMLElement>("[data-quincy-layer]")!;
    expect(panel).not.toBeNull();
    expect(panel.getAttribute("tabindex")).not.toBe("0");
  });
});

describe("AnchoredPopover — Escape", () => {
  it("returns focus to the trigger and closes the popover", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<Harness />); await Promise.resolve(); });
    await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())); });
    await flush();
    const deleteButton = [...document.querySelectorAll("button")].find((button) => button.textContent === "Delete (raises confirm)")!;
    expect(document.activeElement).toBe(deleteButton);

    await act(async () => { deleteButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 300)); });
    const trigger = [...document.querySelectorAll("button")].find((button) => button.textContent === "Trigger")!;
    expect(document.activeElement).toBe(trigger);
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Delete (raises confirm)")).toBe(false);
  });
});
