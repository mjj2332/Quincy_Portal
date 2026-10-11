import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREPARE_MAX_MS, PREPARE_POLL_MS, usePreparedDownload, type PrepareOutcome, type PreparedDownload } from "./use-prepared-download";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The preparing -> ready flow behind both zip surfaces (#802): poll every 30 s for up to 5 minutes while open and visible, clean up on close or unmount, never download by itself. */
let host: HTMLElement; let root: Root; let latest: PreparedDownload;
let visibility: DocumentVisibilityState;
beforeEach(() => {
  vi.useFakeTimers(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

function Harness({ check, active }: { check: (reason: "start" | "poll") => Promise<PrepareOutcome>; active: boolean }) {
  latest = usePreparedDownload({ check, active });
  return <p data-testid="status">{latest.status}</p>;
}
const mount = (check: (reason: "start" | "poll") => Promise<PrepareOutcome>, active = true) => act(async () => { root.render(<Harness check={check} active={active} />); });
const status = () => host.querySelector("[data-testid=status]")!.textContent;
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const start = () => act(async () => { await latest.start(); });

describe("usePreparedDownload", () => {
  it("is idle until started, and start() resolves with the first answer", async () => {
    const check = vi.fn(async (): Promise<PrepareOutcome> => ({ state: "ready" }));
    await mount(check); expect(status()).toBe("idle"); expect(check).not.toHaveBeenCalled();
    let outcome: PrepareOutcome | undefined; await act(async () => { outcome = await latest.start(); });
    expect(outcome).toEqual({ state: "ready" }); expect(status()).toBe("ready"); expect(check).toHaveBeenCalledWith("start");
  });

  it("preparing, then polls every 30 s, then ready: it stops polling and does not call start again", async () => {
    const answers: PrepareOutcome[] = [{ state: "preparing" }, { state: "preparing" }, { state: "ready" }];
    const check = vi.fn(async () => answers.shift()!);
    await mount(check); await start(); expect(status()).toBe("preparing");
    await tick(PREPARE_POLL_MS - 1); expect(check).toHaveBeenCalledTimes(1);
    await tick(1); expect(check).toHaveBeenCalledTimes(2); expect(check).toHaveBeenLastCalledWith("poll");
    await tick(PREPARE_POLL_MS); expect(status()).toBe("ready"); expect(check).toHaveBeenCalledTimes(3);
    await tick(PREPARE_POLL_MS * 3); expect(check).toHaveBeenCalledTimes(3);
  });

  it("gives up after five minutes with 'timeout' and polls no more; checkAgain() starts a fresh round", async () => {
    const check = vi.fn(async (): Promise<PrepareOutcome> => ({ state: "preparing" }));
    await mount(check); await start();
    await tick(PREPARE_MAX_MS); expect(status()).toBe("timeout");
    const calls = check.mock.calls.length; await tick(PREPARE_POLL_MS * 4); expect(check).toHaveBeenCalledTimes(calls);
    await act(async () => { await latest.start(); }); expect(status()).toBe("preparing"); expect(check).toHaveBeenCalledTimes(calls + 1); expect(check).toHaveBeenLastCalledWith("start");
  });

  it("pauses while the page is hidden and checks straight away when it becomes visible again", async () => {
    const check = vi.fn(async (): Promise<PrepareOutcome> => ({ state: "preparing" }));
    await mount(check); await start(); visibility = "hidden";
    await tick(PREPARE_POLL_MS * 3); expect(check).toHaveBeenCalledTimes(1);
    visibility = "visible"; await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("stops and ignores a late answer when the surface closes, and when it unmounts", async () => {
    let resolve!: (outcome: PrepareOutcome) => void; const check = vi.fn((reason: "start" | "poll") => reason === "start" ? Promise.resolve<PrepareOutcome>({ state: "preparing" }) : new Promise<PrepareOutcome>((r) => { resolve = r; }));
    await mount(check); await start(); await tick(PREPARE_POLL_MS); expect(check).toHaveBeenCalledTimes(2);
    await mount(check, false); expect(status()).toBe("idle");
    await act(async () => { resolve({ state: "ready" }); await Promise.resolve(); }); expect(status()).toBe("idle");
    await tick(PREPARE_POLL_MS * 4); expect(check).toHaveBeenCalledTimes(2);
    await mount(check, true); await start(); expect(check).toHaveBeenCalledTimes(3);
    act(() => root.unmount()); await tick(PREPARE_POLL_MS * 4); expect(check).toHaveBeenCalledTimes(3);
    root = createRoot(host);
  });

  it("maps unavailable, too_large and a failed request without polling", async () => {
    for (const [outcome, expected] of [[{ state: "unavailable" }, "unavailable"], [{ state: "too_large" }, "too_large"], [{ state: "failed" }, "failed"]] as const) {
      const check = vi.fn(async (): Promise<PrepareOutcome> => outcome);
      await mount(check); await start(); expect(status()).toBe(expected); await tick(PREPARE_POLL_MS * 2); expect(check).toHaveBeenCalledTimes(1);
      await mount(check, false);
    }
  });

  it("a poll that fails keeps waiting: one dropped request does not end the preparation", async () => {
    const answers: PrepareOutcome[] = [{ state: "preparing" }, { state: "failed" }, { state: "ready" }];
    const check = vi.fn(async () => answers.shift()!);
    await mount(check); await start(); await tick(PREPARE_POLL_MS); expect(status()).toBe("preparing");
    await tick(PREPARE_POLL_MS); expect(status()).toBe("ready");
  });
});
