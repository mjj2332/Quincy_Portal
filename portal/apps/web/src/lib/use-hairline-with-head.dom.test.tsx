import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useHairlineWithHead } from "./use-hairline-with-head";

// The test runtime does no layout: each box's top and bottom come from data attributes, and ResizeObserver is a stub the test fires.
let root: Root | null = null;
let observers: Array<() => void> = [];
const held = { RO: globalThis.ResizeObserver, rect: HTMLElement.prototype.getBoundingClientRect };
beforeEach(() => {
  observers = [];
  globalThis.ResizeObserver = class { constructor(cb: () => void) { observers.push(cb); } observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const top = Number(this.dataset.top ?? 0); const bottom = Number(this.dataset.bottom ?? 0);
    return { top, bottom, height: bottom - top, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  };
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; document.body.replaceChildren();
  globalThis.ResizeObserver = held.RO;
  HTMLElement.prototype.getBoundingClientRect = held.rect;
});

// The list box from 100; the head row's text (the counts) from 110 to 130. Its 44px row box is taller than the text, which is what the hook reads.
function Panel({ on, listBottom }: { on: boolean; listBottom: number }) {
  const listRef = useRef<HTMLDivElement>(null); const textRef = useRef<HTMLSpanElement>(null); const composerRef = useRef<HTMLDivElement>(null);
  useHairlineWithHead(on, listRef, textRef, composerRef);
  return <><div ref={listRef} data-testid="list" data-top={100} data-bottom={listBottom}><span ref={textRef} data-testid="counts" data-top={110} data-bottom={130} /></div><div ref={composerRef} data-testid="composer" /></>;
}
async function render(on: boolean, listBottom: number) {
  if (!root) { const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); }
  await act(async () => { root!.render(<Panel on={on} listBottom={listBottom} />); });
}
const el = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const fire = async () => act(async () => { observers.forEach((cb) => cb()); });

describe("useHairlineWithHead (#879 fix r11): the composer's top line goes with the notes' head row", () => {
  it("keeps the line while the row's text shows, though the list is shorter than the row's 44px box and the text's line box overhangs its foot", async () => {
    await render(true, 126);
    expect(el("composer").dataset.headCut).toBeUndefined();
  });

  it("hides the line while the sheet squeezes the list below the text, and shows it once the text fits again", async () => {
    await render(true, 160);
    el("list").dataset.bottom = "115";
    await fire();
    expect(el("composer").dataset.headCut).toBe("true");
    el("list").dataset.bottom = "160";
    await fire();
    expect(el("composer").dataset.headCut).toBeUndefined();
  });

  it("a list scrolled past the text hides the line too", async () => {
    await render(true, 160);
    el("counts").dataset.top = "80"; el("counts").dataset.bottom = "98";
    await act(async () => { el("list").dispatchEvent(new Event("scroll")); });
    expect(el("composer").dataset.headCut).toBe("true");
  });

  it("does nothing off the phone, and clears its mark when it turns off", async () => {
    await render(false, 105);
    expect(el("composer").dataset.headCut).toBeUndefined();
    await render(true, 105);
    expect(el("composer").dataset.headCut).toBe("true");
    await render(false, 105);
    expect(el("composer").dataset.headCut).toBeUndefined();
  });
});
