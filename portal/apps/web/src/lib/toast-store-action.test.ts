import { afterEach, describe, expect, it, vi } from "vitest";
import { clearToasts, getToasts, pushToast, registerToastViewport, TOAST_TTL_MS } from "./toast-store";

afterEach(() => {
  clearToasts();
  vi.useRealTimers();
});

describe("toast-store action", () => {
  it("carries an action through pushToast", () => {
    const unregister = registerToastViewport();
    const onAction = vi.fn();
    pushToast("Undo available", "success", { action: { label: "Undo", onAction } });
    expect(getToasts()[0]?.action).toMatchObject({ label: "Undo" });
    expect(getToasts()[0]?.action?.onAction).toBe(onAction);
    unregister();
  });

  it("an action does not change the TTL", () => {
    vi.useFakeTimers();
    const unregister = registerToastViewport();
    pushToast("Undo available", "success", { action: { label: "Undo", onAction: () => {} } });
    vi.advanceTimersByTime(TOAST_TTL_MS - 1);
    expect(getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(getToasts()).toHaveLength(0);
    unregister();
  });
});
