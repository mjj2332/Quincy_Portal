import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { usePlayerKeys, type PlayerKeyTarget } from "./use-player-keys";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A target that records every call, with the shuttle rate and mark frame the test sets. */
function fakeTarget(rate = 0, frame = 7) {
  const calls: string[] = [];
  const target = {
    rate, frame,
    play: () => { calls.push("play"); },
    pause: () => { calls.push("pause"); },
    setRate: (r: number) => { calls.push(`setRate:${r}`); },
    reverse: (s: number) => { calls.push(`reverse:${s}`); },
    step: (d: number) => { calls.push(`step:${d}`); },
    home: () => { calls.push("home"); },
    end: () => { calls.push("end"); },
    markFrame: () => frame,
  } satisfies PlayerKeyTarget & { frame: number };
  return { calls, target };
}

let root: Root | null = null;
let handler!: (event: KeyboardEvent) => boolean;
const marks: Array<[string, number]> = [];

async function mount(target: PlayerKeyTarget, withMarks = false) {
  function Probe() {
    handler = usePlayerKeys(target, withMarks ? (kind, frame) => { marks.push([kind, frame]); } : undefined);
    return <input data-testid="field" />;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Probe />); });
}
const down = (k: string, init: KeyboardEventInit = {}, target: Element = document.body) => {
  const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: target });
  let handled = false;
  act(() => { handled = handler(event); });
  return { handled, event };
};
const up = (k: string) => act(() => { document.dispatchEvent(new KeyboardEvent("keyup", { key: k, bubbles: true })); });

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; marks.length = 0; document.body.replaceChildren();
});

describe("usePlayerKeys (#741 7a)", () => {
  it("Space toggles by the target's rate: plays from paused, pauses while playing in either direction", async () => {
    const paused = fakeTarget(0); await mount(paused.target);
    expect(down(" ").handled).toBe(true);
    expect(paused.calls).toEqual(["play"]);
    await act(async () => { root!.unmount(); }); root = null;
    for (const rate of [1, 4, -2]) {
      const moving = fakeTarget(rate); await mount(moving.target);
      down(" ");
      expect(moving.calls).toEqual(["pause"]);
      await act(async () => { root!.unmount(); }); root = null;
    }
  });

  it("L climbs the ladder 1, 2, 4, 8 and holds at 8", async () => {
    const seen: string[] = [];
    for (const rate of [0, 1, 2, 4, 8]) {
      const { calls, target } = fakeTarget(rate); await mount(target);
      down("l"); seen.push(calls[0]!);
      await act(async () => { root!.unmount(); }); root = null;
    }
    expect(seen).toEqual(["setRate:1", "setRate:2", "setRate:4", "setRate:8", "setRate:8"]);
  });

  it("J climbs reverse 1, 2, 4, 8, and each key slows the opposite direction one step toward paused", async () => {
    const seen: string[] = [];
    for (const [key, rate] of [["j", 0], ["j", -1], ["j", -2], ["j", -4], ["j", -8], ["j", 2], ["j", 1], ["l", -4], ["l", -1]] as const) {
      const { calls, target } = fakeTarget(rate); await mount(target);
      down(key); seen.push(calls[0]!);
      await act(async () => { root!.unmount(); }); root = null;
    }
    expect(seen).toEqual(["reverse:1", "reverse:2", "reverse:4", "reverse:8", "reverse:8", "setRate:1", "pause", "reverse:2", "pause"]);
  });

  it("arrows step one frame, Home and End go to the ends", async () => {
    const { calls, target } = fakeTarget(); await mount(target);
    down("ArrowLeft"); down("ArrowRight"); down("Home"); down("End");
    expect(calls).toEqual(["step:-1", "step:1", "home", "end"]);
  });

  it("K while playing pauses at once and its keyup does not resume", async () => {
    const { calls, target } = fakeTarget(2); await mount(target);
    down("k"); await up("k");
    expect(calls).toEqual(["pause"]);
  });

  it("K from paused waits for keyup and then plays", async () => {
    const { calls, target } = fakeTarget(0); await mount(target);
    down("k");
    expect(calls).toEqual([]);
    await up("k");
    expect(calls).toEqual(["play"]);
  });

  it("held K + J / L steps a frame back / forward, pauses first, and never plays on release", async () => {
    const { calls, target } = fakeTarget(0); await mount(target);
    down("k"); down("l"); down("j"); await up("k");
    expect(calls).toEqual(["pause", "step:1", "pause", "step:-1"]);
  });

  it("window blur releases K without toggling; J / L shuttle again afterwards", async () => {
    const { calls, target } = fakeTarget(0); await mount(target);
    down("k");
    act(() => { window.dispatchEvent(new Event("blur")); });
    await up("k");
    expect(calls).toEqual([]);
    down("l");
    expect(calls).toEqual(["setRate:1"]);
  });

  it("a held key does not walk the ladder, but a held arrow keeps stepping", async () => {
    const { calls, target } = fakeTarget(0); await mount(target);
    expect(down("l", { repeat: true }).handled).toBe(false);
    expect(down("ArrowRight", { repeat: true }).handled).toBe(true);
    expect(calls).toEqual(["step:1"]);
  });

  it("I and O mark the target's frame only when the host takes marks", async () => {
    const without = fakeTarget(); await mount(without.target);
    expect(down("i").handled).toBe(false);
    await act(async () => { root!.unmount(); }); root = null;
    const withMarks = fakeTarget(0, 42); await mount(withMarks.target, true);
    expect(down("i").handled).toBe(true);
    expect(down("o").handled).toBe(true);
    expect(marks).toEqual([["in", 42], ["out", 42]]);
    expect(withMarks.calls).toEqual([]);
  });

  it("yields to editable fields, a focused slider's arrows, a focused button's Space, and modified keys", async () => {
    const { calls, target } = fakeTarget(); await mount(target);
    const field = document.querySelector<HTMLInputElement>("[data-testid=field]")!;
    expect(down(" ", {}, field).handled).toBe(false);
    expect(down("ArrowLeft", {}, field).handled).toBe(false);
    const slider = document.createElement("div"); slider.setAttribute("role", "slider"); document.body.appendChild(slider);
    expect(down("ArrowRight", {}, slider).handled).toBe(false);
    expect(down("Home", {}, slider).handled).toBe(false);
    expect(down("l", {}, slider).handled).toBe(true);
    const button = document.createElement("button"); document.body.appendChild(button);
    expect(down(" ", {}, button).handled).toBe(false);
    expect(down("ArrowRight", {}, button).handled).toBe(true);
    expect(down("k", { metaKey: true }).handled).toBe(false);
    expect(calls).toEqual(["setRate:1", "step:1"]);
  });

  it("preventDefaults a handled key and leaves an unbound one alone", async () => {
    const { target } = fakeTarget(); await mount(target);
    expect(down("l").event.defaultPrevented).toBe(true);
    const other = down("x");
    expect(other.handled).toBe(false);
    expect(other.event.defaultPrevented).toBe(false);
  });

  it("reads the target at keydown, so a later render's rate wins", async () => {
    const first = fakeTarget(0);
    function Probe({ target }: { target: PlayerKeyTarget }) { handler = usePlayerKeys(target); return null; }
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => { root!.render(<Probe target={first.target} />); });
    const stableHandler = handler;
    const second = fakeTarget(2);
    await act(async () => { root!.render(<Probe target={second.target} />); });
    expect(handler).toBe(stableHandler);
    down(" ");
    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual(["pause"]);
  });
});
