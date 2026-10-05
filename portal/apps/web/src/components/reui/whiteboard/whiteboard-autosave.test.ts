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

function mount(onSave: () => Promise<void | "skipped">, paused = false, discardSave?: () => boolean) {
  let dirty: () => void = () => undefined;
  const statuses: string[] = [];
  function Harness({ paused: isPaused }: { paused: boolean }) {
    const options = useRef({ onSave, changeDelay: 10, autosaveDelay: 100, discardSave, onSaveStatusChange: (status: string) => statuses.push(status) } as never);
    const { markDirty } = useAutosave(fakeApi, options, isPaused);
    useEffect(() => { dirty = markDirty; }, [markDirty]);
    return null;
  }
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  const render = (isPaused: boolean) => act(() => { root!.render(createElement(Harness, { paused: isPaused })); });
  render(paused);
  return { statuses, setPaused: render, edit: () => act(() => { dirty(); }) };
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

describe("autosave while the board is view-only (#499)", () => {
  it("does not save or report Saved while paused, keeps the edit dirty, and sends it when the pause ends with no new edit", async () => {
    const onSave = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const board = mount(onSave);
    board.edit();                                            // a pending edit...
    board.setPaused(true);                                   // ...and the Project is archived before the idle save
    await advance(5_000);
    expect(onSave).not.toHaveBeenCalled();
    expect(board.statuses).not.toContain("saved");
    expect(board.statuses.at(-1)).toBe("unsaved");
    board.setPaused(false);                                  // restored
    await advance(0);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(board.statuses.at(-1)).toBe("saved");
  });

  it("a save that reports it was skipped (the board went view-only before the pause committed) is not Saved: the edit stays dirty and goes out when the pause ends", async () => {
    // Sol round 11: the archive frame flips the shell's mode at once, but React's pause reaches the hook later. The
    // due autosave runs in between, and the shell's save declines to send.
    let sending = true;
    const onSave = vi.fn<() => Promise<void | "skipped">>(async () => (sending ? undefined : "skipped"));
    const board = mount(onSave);
    board.edit();
    sending = false;                                         // the archive frame landed; the hook is not paused yet
    await advance(100);                                      // the idle save is due and is skipped
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(board.statuses).not.toContain("saved");
    expect(board.statuses.at(-1)).toBe("unsaved");
    board.setPaused(true);                                   // React catches up
    await advance(5_000);
    expect(board.statuses).not.toContain("saved");
    sending = true;                                          // restored: the pause ends
    board.setPaused(false);
    await advance(0);
    expect(onSave).toHaveBeenCalledTimes(2);                 // the edit was never lost
    expect(board.statuses.at(-1)).toBe("saved");
  });
  it("a skipped save is retried on its own when the restore lands before the pause ever commits: exactly one send of the pending edit, no double-send", async () => {
    // Sol round 12: archive -> due autosave skipped -> restore, all before React commits paused=true. paused never
    // flips, so the resume effect never runs; the skipped outcome itself must arm the bounded retry.
    let sending = true;
    const onSave = vi.fn<() => Promise<void | "skipped">>(async () => (sending ? undefined : "skipped"));
    const board = mount(onSave);
    board.edit();
    sending = false;                                         // the archive frame landed; the hook is not paused yet
    await advance(100);                                      // the idle save is due and is skipped
    expect(onSave).toHaveBeenCalledTimes(1);
    sending = true;                                          // restored before paused=true was ever committed
    await advance(1_000);                                    // within the first retry window
    expect(onSave).toHaveBeenCalledTimes(2);                 // the pending edit went out exactly once
    expect(board.statuses.at(-1)).toBe("saved");
    await advance(120_000);
    expect(onSave).toHaveBeenCalledTimes(2);                 // saved: the retries stop
  });

  it("a skipped retry and the resume effect firing together send the edit once", async () => {
    let sending = true;
    const onSave = vi.fn<() => Promise<void | "skipped">>(async () => (sending ? undefined : "skipped"));
    const board = mount(onSave);
    board.edit();
    sending = false;
    await advance(100);
    board.setPaused(true);
    sending = true;
    board.setPaused(false);                                  // the resume effect flushes now; the armed retry must not resend
    await advance(120_000);
    expect(onSave).toHaveBeenCalledTimes(2);
  });
});

describe("autosave discard (#500)", () => {
  it("drops a pending edit instead of flushing it when the editor is torn down for a board reset", async () => {
    const onSave = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    let resetting = false;
    const board = mount(onSave, false, () => resetting);
    board.edit();                                            // an edit the restored scene replaces...
    resetting = true;
    act(() => root!.unmount()); root = null;                 // ...and the editor goes away: the teardown flush must be skipped
    await advance(120_000);
    expect(onSave).not.toHaveBeenCalled();
    expect(board.statuses).not.toContain("saving");
  });

  it("still flushes on an ordinary teardown", async () => {
    const onSave = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const board = mount(onSave, false, () => false);
    board.edit();
    act(() => root!.unmount()); root = null;
    await advance(10);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("does not retry or timer-flush a discarded edit", async () => {
    const onSave = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("stale"));
    let resetting = false;
    const board = mount(onSave, false, () => resetting);
    board.edit();
    await advance(100);                                      // failed once, retry armed
    const calls = onSave.mock.calls.length;
    resetting = true;
    act(() => root!.unmount()); root = null;
    await advance(120_000);
    expect(onSave.mock.calls.length).toBe(calls);
  });
});
