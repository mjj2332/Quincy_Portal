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

    cancel.focus();
    cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    await flush();
    expect(document.activeElement === cancel || document.activeElement === confirmButton).toBe(true);
    confirmButton.focus();
    confirmButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: false, bubbles: true, cancelable: true }));
    await flush();
    expect(document.activeElement === cancel || document.activeElement === confirmButton).toBe(true);

    confirmButton.click();
    expect(await pending).toBe(true);
    await flush();
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
    await flush();
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
    document.querySelector<HTMLElement>(".scrim")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
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
    confirmStore.resolve(false);
    expect(await second).toBe(false);
    await flush();
    expect(document.querySelector('[data-testid="confirm-modal"]')).toBeNull();
  });
});
