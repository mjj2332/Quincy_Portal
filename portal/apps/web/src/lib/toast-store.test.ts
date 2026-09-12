/**
 * Toast store — issue #110. Node-environment tests (this is `*.test.ts`, so no `window`/DOM).
 *
 * Covers the module-level store in isolation: append/dismiss/clear semantics, id stability,
 * `getToasts()` identity, the 3600ms expiry timer, and the viewport registration lifecycle that
 * `ToastViewport` relies on for its "toasts die with the screen" reset.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearToasts,
  dismissToast,
  getToasts,
  mountedToastViewports,
  pushToast,
  registerToastViewport,
  subscribeToasts,
  TOAST_TTL_MS,
} from "./toast-store";

afterEach(() => {
  clearToasts();
  vi.useRealTimers();
});

describe("toast-store", () => {
  it("push appends, in order, and returns an id", () => {
    const firstId = pushToast("First");
    const secondId = pushToast("Second");
    expect(getToasts().map((item) => item.message)).toEqual(["First", "Second"]);
    expect(typeof firstId).toBe("number");
    expect(typeof secondId).toBe("number");
    expect(secondId).not.toBe(firstId);
  });

  it("getToasts() identity is stable between mutations and changes after one", () => {
    const before = getToasts();
    expect(getToasts()).toBe(before);
    pushToast("Changes it");
    const after = getToasts();
    expect(after).not.toBe(before);
    expect(getToasts()).toBe(after);
  });

  it("retains options.announcedElsewhere on the record", () => {
    pushToast("Silent one", "success", { announcedElsewhere: true });
    expect(getToasts()[0]?.announcedElsewhere).toBe(true);
  });

  it("expires a toast after TOAST_TTL_MS and not a moment before", () => {
    vi.useFakeTimers();
    pushToast("Expires");
    vi.advanceTimersByTime(TOAST_TTL_MS - 1);
    expect(getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(getToasts()).toHaveLength(0);
  });

  it("clearToasts() empties the list and cancels pending timers", () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    const unsubscribe = subscribeToasts(listener);
    pushToast("Cleared before it fires");
    clearToasts();
    listener.mockClear();
    vi.advanceTimersByTime(TOAST_TTL_MS);
    expect(listener).not.toHaveBeenCalled();
    expect(getToasts()).toHaveLength(0);
    unsubscribe();
  });

  it("dismissToast(id) removes just that one", () => {
    const keepId = pushToast("Keep");
    const dismissId = pushToast("Dismiss");
    dismissToast(dismissId);
    expect(getToasts().map((item) => item.id)).toEqual([keepId]);
  });

  it("clears toasts a microtask after the last viewport unregisters", async () => {
    pushToast("Dies with the screen");
    const unregister = registerToastViewport();
    unregister();
    expect(getToasts()).toHaveLength(1);
    await Promise.resolve();
    expect(getToasts()).toHaveLength(0);
  });

  it("subscribeToasts returns a working unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToasts(listener);
    pushToast("Notifies");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    pushToast("Does not notify");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  describe("orphaned-toast rule (#110 fix round item 1)", () => {
    it("push with zero viewports mounted is discarded on the microtask that follows", async () => {
      pushToast("No home for this one");
      expect(getToasts()).toHaveLength(1);
      await Promise.resolve();
      expect(getToasts()).toHaveLength(0);
    });

    it("push with zero viewports survives if a viewport registers before the microtask runs", async () => {
      pushToast("Mounts in the same commit");
      const unregister = registerToastViewport();
      await Promise.resolve();
      expect(getToasts()).toHaveLength(1);
      unregister();
    });

    it("unregister the last viewport, then push, then the microtask: toast gone and the store is empty", async () => {
      const firstUnregister = registerToastViewport();
      firstUnregister();
      pushToast("Would otherwise leak to the next screen");
      await Promise.resolve();
      expect(getToasts()).toHaveLength(0);
    });

    // Pre-existing (was "does not clear toasts if a viewport re-registers before the microtask
    // runs", top-level) — relocated here rather than duplicated, since it already pins the exact
    // "existing register → unregister → re-register" case the fix spec asks to keep pinned.
    it("register → unregister → re-register within the microtask still keeps toasts already on screen", async () => {
      pushToast("Survives the handoff");
      const unregister = registerToastViewport();
      unregister();
      const secondUnregister = registerToastViewport();
      await Promise.resolve();
      expect(getToasts()).toHaveLength(1);
      secondUnregister();
    });

    it("a push discarded for lack of a viewport also cancels its own expiry timer", async () => {
      vi.useFakeTimers();
      const listener = vi.fn();
      const unsubscribe = subscribeToasts(listener);
      pushToast("Never seen");
      await Promise.resolve();
      expect(getToasts()).toHaveLength(0);
      listener.mockClear();
      vi.advanceTimersByTime(TOAST_TTL_MS);
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    });
  });

  describe("registerToastViewport / mountedToastViewports", () => {
    it("tracks the mounted count across register/unregister", () => {
      expect(mountedToastViewports()).toBe(0);
      const unregisterA = registerToastViewport();
      expect(mountedToastViewports()).toBe(1);
      const unregisterB = registerToastViewport();
      expect(mountedToastViewports()).toBe(2);
      unregisterA();
      expect(mountedToastViewports()).toBe(1);
      unregisterB();
      expect(mountedToastViewports()).toBe(0);
    });
  });
});
