/**
 * ToastViewport host handoff (#776 E). Moving the viewport between the page and a modal's host remounts the toast nodes, and a node removed while it holds focus fires no blur, so
 * a toast paused by that focus must be resumed by the move or it never expires.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewport } from "./ToastViewport";
import { registerToastHost } from "../../lib/toast-host";
import { clearToasts, getToasts, pushToast } from "../../lib/toast-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let page: HTMLElement | undefined;
let modal: HTMLElement | undefined;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  page?.remove(); modal?.remove(); root = undefined; page = undefined; modal = undefined;
  clearToasts(); vi.useRealTimers();
});

describe("ToastViewport host handoff", () => {
  it("a toast paused inside the modal host still expires after the modal closes", async () => {
    page = document.createElement("div"); modal = document.createElement("div");
    document.body.append(page, modal);
    root = createRoot(page);
    await act(async () => { root!.render(<ToastViewport />); await Promise.resolve(); });
    const unregister = registerToastHost(modal);
    await act(async () => { pushToast("Removed", "success", { ttlMs: 1000, action: { label: "Undo", onAction: () => {} } }); await Promise.resolve(); });
    const undo = modal.querySelector<HTMLElement>('[data-testid="toast-action"]');
    expect(undo, "the Undo action inside the modal host").not.toBeNull();
    await act(async () => { undo!.focus(); await Promise.resolve(); });
    // Focused: the expiry is held, however long the person takes.
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(getToasts()).toHaveLength(1);
    // Escape closes the modal: its host goes, the focused node leaves with no blur.
    await act(async () => { unregister(); await Promise.resolve(); });
    expect(page.querySelector('[data-testid="toast"]')).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(1100); });
    expect(getToasts()).toHaveLength(0);
  });
});
