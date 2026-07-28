import { describe, expect, it } from "vitest";
import { createImagePreloadScheduler, type PendingRequest, type Priority } from "./image-preload-scheduler";

function settled(request: PendingRequest) {
  let value = false;
  void request.promise.then(() => { value = true; });
  return () => value;
}

describe("image preload scheduler", () => {
  it("grants backgrounds immediately under both caps and queues when either is reached", async () => {
    const scheduler = createImagePreloadScheduler(3, 2);
    const first = scheduler.acquire("background");
    const second = scheduler.acquire("background");
    const third = scheduler.acquire("background");
    const visible = scheduler.acquire("visible");
    expect(await first.promise).toBeTypeOf("function");
    expect(await second.promise).toBeTypeOf("function");
    expect(await visible.promise).toBeTypeOf("function");
    expect(settled(third)()).toBe(false);
    (await first.promise)();
    expect(await third.promise).toBeTypeOf("function");
    (await second.promise)();
    (await third.promise)();
    (await visible.promise)();
  });

  it("keeps a queued background request blocked while three backgrounds remain active", async () => {
    const scheduler = createImagePreloadScheduler(4, 3);
    const backgrounds = [scheduler.acquire("background"), scheduler.acquire("background"), scheduler.acquire("background")];
    const visible = scheduler.acquire("visible");
    const queued = scheduler.acquire("background");
    const queuedSettled = settled(queued);
    const releases = await Promise.all([...backgrounds, visible].map((request) => request.promise));
    releases[3]!();
    await Promise.resolve();
    expect(queuedSettled()).toBe(false);
    releases[0]!();
    expect(await queued.promise).toBeTypeOf("function");
    (await queued.promise)();
    releases.slice(1).forEach((release) => release?.());
  });

  it("drains a promoted background request immediately when a slot is already free", async () => {
    const scheduler = createImagePreloadScheduler(3, 1);
    const background = scheduler.acquire("background");
    const visible = scheduler.acquire("visible");
    const queued = scheduler.acquire("background");
    const queuedSettled = settled(queued);
    const releaseVisible = await visible.promise;
    releaseVisible();
    expect(queuedSettled()).toBe(false);
    queued.promote();
    expect(await queued.promise).toBeTypeOf("function");
    (await background.promise)();
    (await queued.promise)();
  });

  it("lets a promoted request win ahead of older background entries", async () => {
    const scheduler = createImagePreloadScheduler(2, 1);
    const background = scheduler.acquire("background");
    const visible = scheduler.acquire("visible");
    const older = scheduler.acquire("background");
    const promoted = scheduler.acquire("background");
    promoted.promote();
    const releaseBackground = await background.promise;
    releaseBackground();
    const granted = await promoted.promise;
    expect(granted).toBeTypeOf("function");
    let olderSettled = false;
    void older.promise.then(() => { olderSettled = true; });
    expect(olderSettled).toBe(false);
    (await promoted.promise)();
    (await visible.promise)();
    expect(await older.promise).toBeTypeOf("function");
    (await older.promise)();
  });

  it("cancels a queued request and ignores cancellation after grant", async () => {
    const scheduler = createImagePreloadScheduler(1);
    const active = scheduler.acquire("visible");
    const queued = scheduler.acquire("visible");
    queued.cancel();
    let queuedSettled = false;
    void queued.promise.then(() => { queuedSettled = true; });
    (await active.promise)();
    await Promise.resolve();
    expect(queuedSettled).toBe(false);

    const granted = scheduler.acquire("visible");
    const release = await granted.promise;
    granted.cancel();
    granted.cancel();
    release();
  });

  it("uses isolated scheduler state when each test creates its own factory", () => {
    const first = createImagePreloadScheduler(1);
    const second = createImagePreloadScheduler(1);
    const firstRequest = first.acquire("visible");
    const secondRequest = second.acquire("visible");
    expect(firstRequest).not.toBe(secondRequest);
  });
});
