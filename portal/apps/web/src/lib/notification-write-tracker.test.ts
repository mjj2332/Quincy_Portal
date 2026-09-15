/**
 * The write barrier in isolation — issue #115. Node-environment tests (this is `*.test.ts`, so no
 * `window`/DOM); `use-notifications.dom.test.tsx` covers the hook that consumes it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeWrites, trackWrite, writeSnapshot } from "./notification-write-tracker";

afterEach(() => {
  vi.useRealTimers();
});

describe("notification-write-tracker", () => {
  it("bumps pending and generation before the write starts, and settles both after", async () => {
    const before = writeSnapshot();
    let resolveWrite!: () => void;
    const write = () => new Promise<void>((resolve) => { resolveWrite = resolve; });
    const done = trackWrite(write);
    const during = writeSnapshot();
    expect(during.pending).toBe(before.pending + 1);
    expect(during.generation).toBe(before.generation + 1);
    resolveWrite();
    await done;
    const after = writeSnapshot();
    expect(after.pending).toBe(before.pending);
    expect(after.generation).toBe(before.generation + 2);
  });

  it("notifies listeners in order: once before the write, once after it settles", async () => {
    const events: string[] = [];
    let resolveWrite!: () => void;
    const write = () => new Promise<void>((resolve) => { resolveWrite = resolve; });
    const unsubscribe = subscribeWrites(() => events.push(`pending=${writeSnapshot().pending}`));
    const done = trackWrite(write);
    resolveWrite();
    await done;
    expect(events).toEqual(["pending=1", "pending=0"]);
    unsubscribe();
  });

  it("a rejected write still settles the barrier and never throws", async () => {
    const before = writeSnapshot();
    const write = () => Promise.reject(new Error("boom"));
    await expect(trackWrite(write)).resolves.toBeUndefined();
    const after = writeSnapshot();
    expect(after.pending).toBe(before.pending);
    expect(after.generation).toBe(before.generation + 2);
  });

  it("a hung write releases the barrier at the timeout via fake timers", async () => {
    vi.useFakeTimers();
    const before = writeSnapshot();
    const write = () => new Promise<void>(() => { /* never resolves */ });
    const done = trackWrite(write, 15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await done;
    const after = writeSnapshot();
    expect(after.pending).toBe(before.pending);
    expect(after.generation).toBe(before.generation + 2);
  });

  it("a write that completes before its timeout does not produce a late extra bump", async () => {
    vi.useFakeTimers();
    const before = writeSnapshot();
    let resolveWrite!: () => void;
    const write = () => new Promise<void>((resolve) => { resolveWrite = resolve; });
    const done = trackWrite(write, 15_000);
    resolveWrite();
    await done;
    const settledGeneration = writeSnapshot().generation;
    expect(settledGeneration).toBe(before.generation + 2);
    // Advancing well past the timeout must not bump generation again — the write already settled
    // inside the race, so no late-resolve handler was ever attached.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writeSnapshot().generation).toBe(settledGeneration);
  });

  it("timeout then late resolve: pending unchanged at the timeout's post-release count, generation bumped once more, listener notified again", async () => {
    vi.useFakeTimers();
    const before = writeSnapshot();
    let resolveWrite!: () => void;
    const write = () => new Promise<void>((resolve) => { resolveWrite = resolve; });
    const events: number[] = [];
    const unsubscribe = subscribeWrites(() => events.push(writeSnapshot().generation));
    const done = trackWrite(write, 15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await done;
    const afterTimeout = writeSnapshot();
    expect(afterTimeout.pending).toBe(before.pending);
    expect(afterTimeout.generation).toBe(before.generation + 2);
    expect(events).toEqual([before.generation + 1, before.generation + 2]);

    resolveWrite();
    await vi.advanceTimersByTimeAsync(0);
    // Let the late-resolve microtask chain run.
    await Promise.resolve();
    await Promise.resolve();

    const afterLateResolve = writeSnapshot();
    expect(afterLateResolve.pending).toBe(before.pending);
    expect(afterLateResolve.generation).toBe(before.generation + 3);
    expect(events).toEqual([before.generation + 1, before.generation + 2, before.generation + 3]);
    unsubscribe();
  });
});
