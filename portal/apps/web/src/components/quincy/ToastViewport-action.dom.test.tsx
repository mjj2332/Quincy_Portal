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
});
