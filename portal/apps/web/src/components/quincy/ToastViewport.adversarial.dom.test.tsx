import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastViewport } from "./ToastViewport";
import { clearToasts, getToasts, pushToast } from "../../lib/toast-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ToastViewport adversarial action semantics", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
    clearToasts();
  });

  it("keeps an action reachable while hiding only the already-announced message", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root!.render(<ToastViewport />); await Promise.resolve(); });
    const onAction = vi.fn();
    await act(async () => { pushToast("Already announced", "success", { announcedElsewhere: true, action: { label: "Undo", onAction } }); await Promise.resolve(); });
    const toast = host.querySelector('[data-testid="toast"]')!;
    const message = toast.querySelectorAll("span")[1]!;
    const action = host.querySelector<HTMLButtonElement>('[data-testid="toast-action"]')!;
    expect(toast.getAttribute("aria-hidden")).toBeNull();
    expect(message.getAttribute("aria-hidden")).toBe("true");
    expect(action.tagName).toBe("BUTTON");
    expect(action.type).toBe("button");
    await act(async () => { action.click(); await Promise.resolve(); });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(getToasts()).toHaveLength(0);
  });

  it("dismisses only the activated toast when several actions are present", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root!.render(<ToastViewport />); await Promise.resolve(); });
    const first = vi.fn();
    const second = vi.fn();
    await act(async () => {
      pushToast("First", "success", { action: { label: "Undo first", onAction: first } });
      pushToast("Second", "success", { action: { label: "Undo second", onAction: second } });
      await Promise.resolve();
    });
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="toast-action"]')];
    await act(async () => { buttons[0]!.click(); await Promise.resolve(); });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(getToasts().map((toast) => toast.message)).toEqual(["Second"]);
  });
});
