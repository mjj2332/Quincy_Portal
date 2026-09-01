import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmModalHost } from "./ConfirmDialog";
import { confirm, confirmStore } from "../lib/confirm";

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

// `Modal` delays its own unmount by 120ms (`--dur-fast`) after `open` goes false, so it can
// animate closed (§6.0) — a closed dialog is still in the DOM until that transition completes.
async function waitForClose() {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
}

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<ConfirmModalHost />); await Promise.resolve(); });
  return host;
}

async function unmount() {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(async () => {
  confirmStore.resolve(false);
  await unmount();
});

describe("ConfirmModalHost", () => {
  it("renders accessible selectors, copy, labels, and danger treatment", async () => {
    await mount();
    const pending = confirm({ title: "Delete a file?", message: "This cannot be undone.", confirmLabel: "Delete file", cancelLabel: "Keep file", danger: true });
    await flush();

    const dialog = document.querySelector<HTMLElement>('[data-testid="confirm-modal"]');
    expect(dialog).not.toBeNull();
    expect(document.querySelector('[data-testid="confirm-modal-cancel"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="confirm-modal-confirm"]')).not.toBeNull();
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-labelledby")).toBe(dialog?.querySelector("h3")?.id);
    expect(dialog?.textContent).toContain("Delete a file?");
    expect(dialog?.textContent).toContain("This cannot be undone.");
    expect(document.querySelector('[data-testid="confirm-modal-cancel"]')?.textContent).toBe("Keep file");
    expect(document.querySelector('[data-testid="confirm-modal-confirm"]')?.textContent).toBe("Delete file");
    expect(document.querySelector('[data-testid="confirm-modal-confirm"]')?.classList.contains("button--danger")).toBe(true);
    expect(document.querySelector("[data-confirm-modal-root]")).not.toBeNull();
    // §6.1 item 4 — aria-describedby now resolves to the message <p>'s id (a useId() value, not
    // a stable literal, so this asserts the property rather than an exact innerHTML string).
    const message = dialog?.querySelector(".modal__body p");
    expect(message?.textContent).toBe("This cannot be undone.");
    expect(dialog?.getAttribute("aria-describedby")).toBe(message?.id);
    confirmStore.resolve(false);
    expect(await pending).toBe(false);
  });

  it("renders additive rich content while keeping the required message", async () => {
    await mount();
    const pending = confirm({ title: "Move Deadline", message: "Review this move.", content: <div data-testid="rich-confirmation">Old → New</div> });
    await flush();
    const body = document.querySelector<HTMLElement>(".modal__body")!;
    expect(body.querySelector("p")?.textContent).toBe("Review this move.");
    expect(body.querySelector('[data-testid="rich-confirmation"]')?.textContent).toBe("Old → New");
    confirmStore.resolve(false);
    expect(await pending).toBe(false);
  });

  it("uses default labels and keeps focus trapped, then returns focus to the trigger", async () => {
    const host = await mount();
    const trigger = document.createElement("button");
    trigger.textContent = "Open confirmation";
    host.prepend(trigger);
    trigger.focus();
    const pending = confirm({ title: "Continue?", message: "Proceed with this action?" });
    await flush();

    const cancel = document.querySelector<HTMLButtonElement>('[data-testid="confirm-modal-cancel"]')!;
    const confirmButton = document.querySelector<HTMLButtonElement>('[data-testid="confirm-modal-confirm"]')!;
    expect(cancel.textContent).toBe("Cancel");
    expect(confirmButton.textContent).toBe("Confirm");
    expect(confirmButton.classList.contains("button--danger")).toBe(false);
    expect(document.activeElement).toBe(cancel);

    // Real Tab/Shift-Tab wraparound is a browser-native focus-traversal behavior that jsdom does
    // not simulate; a synthetic keydown here cannot genuinely exercise it (confirmed empirically:
    // dispatching one does not move focus in this environment, regardless of what the trap does).
    // Cyclical trapping itself is owned by @floating-ui/react's FloatingFocusManager (`modal`
    // prop), an upstream-tested library, not hand-rolled here. It's verified with a real browser
    // in manual QA (plan §11.1) rather than faked with an assertion that can't actually fail.

    confirmButton.click();
    expect(await pending).toBe(true);
    await waitForClose();
    expect(document.activeElement).toBe(trigger);
  });

  it("resolves Cancel, Escape, and scrim close exactly once without closing on panel clicks", async () => {
    await mount();
    const panelPromise = confirm({ title: "Panel", message: "Clicking inside stays open." });
    await flush();
    const dialog = document.querySelector<HTMLElement>('[data-testid="confirm-modal"]')!;
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flush();
    expect(document.querySelector('[data-testid="confirm-modal"]')).not.toBeNull();

    const cancel = document.querySelector<HTMLButtonElement>('[data-testid="confirm-modal-cancel"]')!;
    cancel.click();
    cancel.click();
    expect(await panelPromise).toBe(false);
    await waitForClose();
    expect(document.querySelector('[data-testid="confirm-modal"]')).toBeNull();

    const escapePromise = confirm({ title: "Escape", message: "Escape cancels." });
    await flush();
    const underlying = vi.fn();
    document.addEventListener("keydown", underlying);
    const escapeTarget = document.querySelector<HTMLButtonElement>('[data-testid="confirm-modal-cancel"]')!;
    escapeTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    document.removeEventListener("keydown", underlying);
    expect(await escapePromise).toBe(false);
    expect(underlying).not.toHaveBeenCalled();

    const scrimPromise = confirm({ title: "Backdrop", message: "Backdrop cancels." });
    await flush();
    // Press-contained dismissal (defect F, §6.1 item 2): a pointerdown that started on the scrim
    // itself, then a click also on the scrim — a bare click with no preceding pointerdown does
    // not close it (that is exactly the fix: a press that began inside the panel and is released
    // past its edge must not dismiss).
    const scrim = document.querySelector<HTMLElement>(".scrim")!;
    scrim.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    scrim.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(await scrimPromise).toBe(false);
  });

  it("shows concurrent requests FIFO without orphaning either promise", async () => {
    await mount();
    const first = confirm({ title: "First", message: "First request" });
    const second = confirm({ title: "Second", message: "Second request" });
    await flush();
    expect(document.querySelector('[data-testid="confirm-modal"]')?.textContent).toContain("First");
    confirmStore.resolve(true);
    expect(await first).toBe(true);
    await flush();
    expect(document.querySelector('[data-testid="confirm-modal"]')?.textContent).toContain("Second");
    expect(document.activeElement).toBe(document.querySelector('[data-testid="confirm-modal-cancel"]'));
    confirmStore.resolve(false);
    expect(await second).toBe(false);
    await waitForClose();
    expect(document.querySelector('[data-testid="confirm-modal"]')).toBeNull();
  });
});
