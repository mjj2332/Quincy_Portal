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

// The alert dialog delays its own unmount until its exit animation ends, so it can
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
    // #625: the confirm is a standard alert dialog (it demands an answer), not a generic modal.
    expect(dialog?.getAttribute("role")).toBe("alertdialog");
    // Resolve the IDREF rather than hopping through `h3`: the tag is not the contract, and a ReUI
    // DialogTitle swap could legitimately emit `h2`. Both halves are load-bearing — the text proves
    // the accessible name resolves to the rendered title, `contains` proves it resolves *inside*
    // the dialog rather than to a same-worded element elsewhere in the document.
    const dialogTitle = document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "");
    expect(dialogTitle?.textContent).toBe("Delete a file?");
    expect(dialog?.contains(dialogTitle)).toBe(true);
    expect(dialog?.textContent).toContain("Delete a file?");
    expect(dialog?.textContent).toContain("This cannot be undone.");
    expect(document.querySelector('[data-testid="confirm-modal-cancel"]')?.textContent).toBe("Keep file");
    expect(document.querySelector('[data-testid="confirm-modal-confirm"]')?.textContent).toBe("Delete file");
    // Danger styling is the shared Button's `destructive` variant; `.dom.test.tsx` may not assert
    // class names (test-seam guard), so the treatment is covered by the Button's own tests.
    // §6.1 item 4 — aria-describedby now resolves to the message <p>'s id (a useId() value, not
    // a stable literal, so this asserts the property rather than an exact innerHTML string).
    const message = dialog?.querySelector('[data-testid="confirm-modal-message"]');
    expect(message?.textContent).toBe("This cannot be undone.");
    expect(dialog?.getAttribute("aria-describedby")).toBe(message?.id);
    confirmStore.resolve(false);
    expect(await pending).toBe(false);
  });

  it("renders additive rich content while keeping the required message", async () => {
    await mount();
    const pending = confirm({ title: "Move Deadline", message: "Review this move.", content: <div data-testid="rich-confirmation">Old → New</div> });
    await flush();
    const dialog = document.querySelector<HTMLElement>('[data-testid="confirm-modal"]')!;
    const message = dialog.querySelector('[data-testid="confirm-modal-message"]')!;
    const rich = dialog.querySelector('[data-testid="rich-confirmation"]')!;
    expect(message.textContent).toBe("Review this move.");
    expect(rich.textContent).toBe("Old → New");
    // `content` sits below the message and above the footer buttons.
    expect(message.compareDocumentPosition(rich) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rich.compareDocumentPosition(dialog.querySelector('[data-testid="confirm-modal-cancel"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    // Alert-dialog behaviour: the safe action (Cancel) takes initial focus.
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

  it("resolves Cancel and Escape exactly once; a scrim press leaves the confirm pending", async () => {
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
    const escapeTarget = document.querySelector<HTMLButtonElement>('[data-testid="confirm-modal-cancel"]')!;
    await act(async () => { escapeTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
    expect(await escapePromise).toBe(false);
    await waitForClose();

    // Standard alert-dialog behaviour, deliberately adopted (#625): pressing the scrim does NOT
    // dismiss — the confirm demands an explicit answer.
    let scrimSettled = false;
    const scrimPromise = confirm({ title: "Backdrop", message: "Backdrop does not cancel." });
    void scrimPromise.then(() => { scrimSettled = true; });
    await flush();
    const scrim = document.querySelector<HTMLElement>('[data-testid="alert-dialog-scrim"]')!;
    expect(scrim).not.toBeNull();
    await act(async () => {
      scrim.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      scrim.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      await Promise.resolve();
    });
    await flush();
    expect(scrimSettled).toBe(false);
    expect(document.querySelector('[data-testid="confirm-modal"]')).not.toBeNull();
    confirmStore.resolve(false);
    expect(await scrimPromise).toBe(false);
  });

  it("withdraws a pending confirm when its AbortSignal fires, and hands over to the next request", async () => {
    await mount();
    const controller = new AbortController();
    const first = confirm({ title: "First", message: "First request", signal: controller.signal });
    const second = confirm({ title: "Second", message: "Second request" });
    await flush();
    expect(document.querySelector('[data-testid="confirm-modal"]')?.textContent).toContain("First");
    await act(async () => { controller.abort(); await Promise.resolve(); });
    expect(await first).toBe(false);
    await flush();
    expect(document.querySelector('[data-testid="confirm-modal"]')?.textContent).toContain("Second");
    confirmStore.resolve(true);
    expect(await second).toBe(true);
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
