/**
 * ToastViewport `action` — #216. In-tree, no portal, no provider: `useSyncExternalStore` against
 * the module-level `toast-store`. Query only by `data-testid`, role, or inline text literals — see
 * `testing/test-seam.guard.test.ts`.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastViewport } from "./ToastViewport";
import { clearToasts, getToasts, pushToast } from "../../lib/toast-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function mount(node: React.ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); await Promise.resolve(); });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  host?.remove();
  root = undefined;
  host = undefined;
  clearToasts();
});

describe("ToastViewport action", () => {
  it("renders the action button and dismisses after invoking it", async () => {
    const container = await mount(<ToastViewport />);
    const onAction = vi.fn();
    await act(async () => { pushToast("Undo available", "success", { action: { label: "Undo", onAction } }); await Promise.resolve(); });
    await flush();
    const actionButton = container.querySelector('[data-testid="toast-action"]');
    expect(actionButton).not.toBeNull();
    expect(actionButton?.textContent).toBe("Undo");
    expect(getToasts()).toHaveLength(1);
    await act(async () => { actionButton!.dispatchEvent(new MouseEvent("click", { bubbles: true })); await Promise.resolve(); });
    await flush();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(getToasts()).toHaveLength(0);
    expect(container.querySelector('[data-testid="toast-action"]')).toBeNull();
  });

  it("renders no button without an action", async () => {
    const container = await mount(<ToastViewport />);
    await act(async () => { pushToast("No action here"); await Promise.resolve(); });
    await flush();
    expect(container.querySelector('[data-testid="toast-action"]')).toBeNull();
  });

  it("announcedElsewhere + action: wrapper has no aria-hidden, the message span is aria-hidden, and the action button is reachable by role/name (#216 fix round 1 item 1)", async () => {
    const container = await mount(<ToastViewport />);
    await act(async () => { pushToast("Undo available", "success", { announcedElsewhere: true, action: { label: "Undo", onAction: vi.fn() } }); await Promise.resolve(); });
    await flush();
    const wrapper = container.querySelector('[data-testid="toast"]');
    expect(wrapper?.hasAttribute("aria-hidden")).toBe(false);
    const spans = wrapper?.querySelectorAll("span") ?? [];
    const glyphSpan = spans[0];
    const messageSpan = spans[1];
    expect(glyphSpan?.getAttribute("aria-hidden")).toBe("true");
    expect(messageSpan?.getAttribute("aria-hidden")).toBe("true");
    expect(messageSpan?.textContent).toBe("Undo available");
    const actionButton = [...container.querySelectorAll("button")].find((button) => button.getAttribute("role") !== "presentation" && button.textContent === "Undo");
    expect(actionButton).toBeDefined();
    expect(actionButton?.getAttribute("data-testid")).toBe("toast-action");
    expect(actionButton?.hasAttribute("aria-hidden")).toBe(false);
  });

  it("action without announcedElsewhere: nothing is aria-hidden but the glyph", async () => {
    const container = await mount(<ToastViewport />);
    await act(async () => { pushToast("Undo available", "success", { action: { label: "Undo", onAction: vi.fn() } }); await Promise.resolve(); });
    await flush();
    const wrapper = container.querySelector('[data-testid="toast"]');
    expect(wrapper?.hasAttribute("aria-hidden")).toBe(false);
    const spans = wrapper?.querySelectorAll("span") ?? [];
    const glyphSpan = spans[0];
    const messageSpan = spans[1];
    expect(glyphSpan?.getAttribute("aria-hidden")).toBe("true");
    expect(messageSpan?.hasAttribute("aria-hidden")).toBe(false);
    const actionButton = container.querySelector('[data-testid="toast-action"]');
    expect(actionButton?.hasAttribute("aria-hidden")).toBe(false);
  });

  it("carries the inverse focus-ring override so focus-visible is readable on the toast (#216 fix round 5 item 4)", async () => {
    const container = await mount(<ToastViewport />);
    await act(async () => { pushToast("Undo available", "success", { action: { label: "Undo", onAction: vi.fn() } }); await Promise.resolve(); });
    await flush();
    const actionButton = container.querySelector<HTMLButtonElement>('[data-testid="toast-action"]');
    // Same fix as `ImpersonationBanner.tsx`'s `EXIT` — the global `:focus-visible` outline is ink,
    // unreadable on this inverse toast (and barely better on the destructive tone) without it.
    expect(actionButton?.classList.contains("focus-visible:!outline-on-inverse")).toBe(true);
  });
});
