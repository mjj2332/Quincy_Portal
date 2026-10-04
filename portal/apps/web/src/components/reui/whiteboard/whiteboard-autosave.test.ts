// @vitest-environment happy-dom
import { act, createElement, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #499: a save the server refused as `stale` (or that failed in transit) is retried by the autosave itself, with
 * a growing but bounded delay, with no further edit from the person. Without that, the edit stays "Not saved" until
 * they touch the board again or leave it.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let useAutosave: typeof import("./whiteboard-canvas").useAutosave;
beforeAll(async () => { HTMLCanvasElement.prototype.getContext = (() => ({})) as never; ({ useAutosave } = await import("./whiteboard-canvas")); });
const fakeApi = { getSceneElementsIncludingDeleted: () => [], getFiles: () => ({}), getAppState: () => ({}) } as never;

function mount(onSave: () => Promise<void>) {
  let dirty: () => void = () => undefined;
  function Harness() {
    const options = useRef({ onSave, changeDelay: 10, autosaveDelay: 100 } as never);
    const { markDirty } = useAutosave(fakeApi, options);
    useEffect(() => { dirty = markDirty; }, [markDirty]);
    return null;
  }
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  act(() => { root!.render(createElement(Harness)); });
  return { edit: () => act(() => { dirty(); }) };
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { if (root) act(() => root!.unmount()); root = null; document.body.replaceChildren(); vi.useRealTimers(); });

describe("autosave liveness (#499)", () => {
  it("retries a rejected save on its own, with no new edit, until it goes through", async () => {
    const onSave = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("stale")).mockRejectedValueOnce(new Error("stale")).mockResolvedValue(undefined);
    const board = mount(onSave);
    board.edit();
    await advance(100);
    expect(onSave).toHaveBeenCalledTimes(1);
    await advance(30_000);
    expect(onSave).toHaveBeenCalledTimes(3);
    await advance(120_000);
    expect(onSave).toHaveBeenCalledTimes(3);                 // saved: the retries stop
  });

  it("backs off between retries and never waits longer than the bound", async () => {
    const onSave = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("not connected"));
    const board = mount(onSave);
    board.edit();
    await advance(100);
    expect(onSave).toHaveBeenCalledTimes(1);
    const callsAfter = async (ms: number) => { const before = onSave.mock.calls.length; await advance(ms); return onSave.mock.calls.length - before; };
    expect(await callsAfter(500)).toBe(0);                    // the first retry is not immediate
    await advance(40_000);
    const settled = onSave.mock.calls.length;
    expect(settled).toBeGreaterThan(3);
    expect(await callsAfter(31_000)).toBeGreaterThanOrEqual(1);   // still trying: no retry waits longer than the bound
    expect(await callsAfter(31_000)).toBeLessThanOrEqual(2);      // and it does not hammer: roughly one per bound
  });

  it("stops retrying once the board is closed", async () => {
    const onSave = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("stale"));
    const board = mount(onSave);
    board.edit();
    await advance(100);
    const calls = onSave.mock.calls.length;
    act(() => root!.unmount()); root = null;
    await advance(120_000);
    expect(onSave.mock.calls.length).toBeLessThanOrEqual(calls + 1);   // the unmount's own final flush at most
  });
});
