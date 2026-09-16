import { beforeEach, describe, expect, it } from "vitest";
import { confirm, confirmStore } from "./confirm";

// #152: a component that opens a confirm and then unmounts must be able to withdraw it —
// otherwise the modal stays open over whatever view replaced it, and the interaction it belonged
// to (its own component-instance state) is gone, so nothing can ever resolve it.
describe("confirm abort (#152)", () => {
  beforeEach(() => {
    // Drain anything a previous, failed assertion might have left queued so tests stay isolated.
    while (confirmStore.getSnapshot()) confirmStore.resolve(false);
  });

  it("aborting the active confirm resolves false and advances to the next", async () => {
    const controllerA = new AbortController();
    const promiseA = confirm({ title: "A", message: "a", signal: controllerA.signal });
    const promiseB = confirm({ title: "B", message: "b" });
    expect(confirmStore.getSnapshot()?.options.title).toBe("A");

    controllerA.abort();
    await expect(promiseA).resolves.toBe(false);
    expect(confirmStore.getSnapshot()?.options.title).toBe("B");

    confirmStore.resolve(true);
    await expect(promiseB).resolves.toBe(true);
    expect(confirmStore.getSnapshot()).toBeNull();
  });

  it("aborting a queued confirm removes it without touching the active one", async () => {
    const controllerB = new AbortController();
    const promiseA = confirm({ title: "A", message: "a" });
    const promiseB = confirm({ title: "B", message: "b", signal: controllerB.signal });
    expect(confirmStore.getSnapshot()?.options.title).toBe("A");

    controllerB.abort();
    await expect(promiseB).resolves.toBe(false);
    // The active confirm is untouched — still A, not advanced.
    expect(confirmStore.getSnapshot()?.options.title).toBe("A");

    confirmStore.resolve(true);
    await expect(promiseA).resolves.toBe(true);
    expect(confirmStore.getSnapshot()).toBeNull();
  });

  it("a pre-aborted signal resolves false and never becomes active", async () => {
    const controller = new AbortController();
    controller.abort();
    const promise = confirm({ title: "Pre-aborted", message: "x", signal: controller.signal });
    await expect(promise).resolves.toBe(false);
    expect(confirmStore.getSnapshot()).toBeNull();
  });

  it("abort after a normal resolve is a no-op", async () => {
    const controller = new AbortController();
    const promise = confirm({ title: "A", message: "a", signal: controller.signal });
    confirmStore.resolve(true);
    await expect(promise).resolves.toBe(true);
    expect(confirmStore.getSnapshot()).toBeNull();

    // Must not throw, must not touch the (now empty) queue.
    expect(() => controller.abort()).not.toThrow();
    expect(confirmStore.getSnapshot()).toBeNull();
  });

  it("plain confirm without options still works", async () => {
    const promise = confirm({ title: "A", message: "a" });
    expect(confirmStore.getSnapshot()?.options.title).toBe("A");
    confirmStore.resolve(true);
    await expect(promise).resolves.toBe(true);
  });

  it("never stores the signal on the request `ConfirmDialog` renders — it spreads `options` onto a DOM component", async () => {
    const controller = new AbortController();
    const promise = confirm({ title: "A", message: "a", signal: controller.signal });
    expect(confirmStore.getSnapshot()?.options).not.toHaveProperty("signal");
    confirmStore.resolve(true);
    await expect(promise).resolves.toBe(true);
  });

  it("a subscriber that synchronously aborts on its first notification still resolves false", async () => {
    const controller = new AbortController();
    // Subscribe before calling `confirm()` so this listener runs inside `confirm()`'s own
    // synchronous `emit()`, not on some later tick.
    const unsubscribe = confirmStore.subscribe(() => {
      controller.abort();
    });
    const promise = confirm({ title: "A", message: "a", signal: controller.signal });
    unsubscribe();

    await expect(promise).resolves.toBe(false);
    expect(confirmStore.getSnapshot()).toBeNull();
  });

  it("a subscriber that synchronously resolves on its first notification settles through the wrapped resolver and leaves no abort listener behind", async () => {
    const controller = new AbortController();
    const unsubscribe = confirmStore.subscribe(() => {
      confirmStore.resolve(true);
    });
    const promise = confirm({ title: "A", message: "a", signal: controller.signal });
    unsubscribe();

    await expect(promise).resolves.toBe(true);
    expect(confirmStore.getSnapshot()).toBeNull();

    // If the abort listener installed inside `confirm()` were still attached, this would be
    // the only way to observe it: aborting afterward must be a complete no-op.
    expect(() => controller.abort()).not.toThrow();
    expect(confirmStore.getSnapshot()).toBeNull();
    await expect(promise).resolves.toBe(true);
  });
});
