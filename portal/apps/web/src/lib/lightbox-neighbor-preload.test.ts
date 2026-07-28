import { describe, expect, it } from "vitest";
import { createNeighborScheduler, type NeighborPendingRequest } from "./lightbox-neighbor-preload";

function isSettled(request: NeighborPendingRequest): () => boolean {
  let settled = false;
  void request.promise.then(() => { settled = true; });
  return () => settled;
}

describe("lightbox neighbor scheduler", () => {
  it("grants immediately under the cap and queues at the cap", async () => {
    const scheduler = createNeighborScheduler(1);
    const first = scheduler.acquire();
    const second = scheduler.acquire();
    expect(await first.promise).toBeTypeOf("function");
    expect(isSettled(second)()).toBe(false);
    (await first.promise)();
    expect(await second.promise).toBeTypeOf("function");
    (await second.promise)();
  });

  it("cancels a queued request so the next request fills the freed slot", async () => {
    const scheduler = createNeighborScheduler(1);
    const active = scheduler.acquire();
    const canceled = scheduler.acquire();
    canceled.cancel();
    const later = scheduler.acquire();
    expect(isSettled(canceled)()).toBe(false);
    (await active.promise)();
    expect(await later.promise).toBeTypeOf("function");
    (await later.promise)();
    expect(isSettled(canceled)()).toBe(false);
  });

  it("keeps scheduler state isolated when each test creates its own instance", async () => {
    const first = createNeighborScheduler(1);
    const second = createNeighborScheduler(1);
    const firstRequest = first.acquire();
    const secondRequest = second.acquire();
    expect(firstRequest).not.toBe(secondRequest);
    (await firstRequest.promise)();
    (await secondRequest.promise)();
  });
});
