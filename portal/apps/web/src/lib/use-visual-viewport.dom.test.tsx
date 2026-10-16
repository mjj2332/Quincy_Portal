import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisualViewport } from "./use-visual-viewport";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeViewport extends EventTarget { height = window.innerHeight; offsetTop = 0; scale = 1; }
let root: Root; let host: HTMLElement; let fake: FakeViewport; const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
function Probe({ enabled, onGone }: { enabled: boolean; onGone?: () => void }) { const box = useVisualViewport(enabled, onGone); return <output data-testid="box">{box ? `${box.height}/${box.offsetTop}` : "none"}</output>; }
const text = () => host.querySelector("output")!.textContent;
beforeEach(() => { fake = new FakeViewport(); Object.defineProperty(window, "visualViewport", { configurable: true, value: fake }); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
const fire = (type: "resize" | "scroll", next: Partial<Pick<FakeViewport, "height" | "offsetTop" | "scale">> = {}) => act(async () => { Object.assign(fake, next); fake.dispatchEvent(new Event(type)); });
afterEach(async () => { vi.useRealTimers(); await act(async () => { root.unmount(); }); if (original) Object.defineProperty(window, "visualViewport", original); else delete (window as unknown as Record<string, unknown>).visualViewport; document.body.replaceChildren(); });

describe("useVisualViewport (#879)", () => {
  it("is null while off, then follows the visual viewport's height and offset", async () => {
    await act(async () => { root.render(<Probe enabled={false} />); });
    expect(text()).toBe("none");
    await act(async () => { root.render(<Probe enabled />); });
    expect(text()).toBe(`${window.innerHeight}/0`);
    fake.height = 480; fake.offsetTop = 12;
    await act(async () => { fake.dispatchEvent(new Event("resize")); });
    expect(text()).toBe("480/12");
    await fire("resize", { height: window.innerHeight, offsetTop: 0 });
    await act(async () => { root.render(<Probe enabled={false} />); });
    expect(text()).toBe("none");
  });
  it("is null where there is no visual viewport", async () => {
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    await act(async () => { root.render(<Probe enabled />); });
    expect(text()).toBe("none");
  });

  it("ignores a pinch zoom: the last box is kept while the scale is above 1", async () => {
    await act(async () => { root.render(<Probe enabled />); });
    await fire("resize", { height: 420, offsetTop: 0 });
    expect(text()).toBe("420/0");
    await fire("resize", { height: 200, offsetTop: 90, scale: 2 });
    expect(text()).toBe("420/0");
    await fire("scroll", { scale: 1, height: 410, offsetTop: 0 });
    expect(text()).toBe("410/0");
  });

  it("leaving compose with the keyboard still up keeps following until it is gone, then puts back the page scroll", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    await act(async () => { root.render(<Probe enabled />); });
    await fire("resize", { height: 400, offsetTop: 0 });
    await act(async () => { root.render(<Probe enabled={false} />); });
    expect(text()).toBe("400/0");
    await fire("resize", { height: 600, offsetTop: 30 });
    expect(text()).toBe("600/30");
    await fire("resize", { height: window.innerHeight, offsetTop: 30 });
    expect(text()).toBe("none");
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    scrollTo.mockRestore();
  });

  it("stops following a second after leaving, even if the keyboard never reports it went", async () => {
    vi.useFakeTimers();
    await act(async () => { root.render(<Probe enabled />); });
    await fire("resize", { height: 400 });
    await act(async () => { root.render(<Probe enabled={false} />); });
    expect(text()).toBe("400/0");
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(text()).toBe("none");
  });

  it("reports the software keyboard going away while compose is still on, and never for a viewport that did not shrink by 150px", async () => {
    const gone = vi.fn();
    await act(async () => { root.render(<Probe enabled onGone={gone} />); });
    await fire("resize", { height: window.innerHeight - 100 });
    await fire("resize", { height: window.innerHeight });
    expect(gone).not.toHaveBeenCalled();
    await fire("resize", { height: window.innerHeight - 320 });
    await fire("resize", { height: window.innerHeight - 40 });
    expect(gone).not.toHaveBeenCalled();
    await fire("resize", { height: window.innerHeight });
    expect(gone).toHaveBeenCalledTimes(1);
  });
  it("writes the box onto its root inside the viewport event, before any render, and clears it when done (#879 fix r3)", async () => {
    const element = document.createElement("div"); document.body.appendChild(element);
    const ref = element;
    function Rooted({ enabled }: { enabled: boolean }) { useVisualViewport(enabled, undefined, ref); return null; }
    await act(async () => { root.render(<Rooted enabled />); });
    // Outside act: React has not rendered yet when the event returns, so only a write inside the event can have put the box there.
    Object.assign(fake, { height: 430, offsetTop: 120 });
    fake.dispatchEvent(new Event("scroll"));
    expect(element.style.height).toBe("430px");
    expect(element.style.transform).toBe("translateY(120px)");
    await act(async () => { await Promise.resolve(); });
    await act(async () => { root.render(<Rooted enabled={false} />); });
    await fire("resize", { height: window.innerHeight, offsetTop: 0 });
    expect(element.style.height).toBe("");
    expect(element.style.transform).toBe("");
  });
  it("its writes on the root never animate: transition is none while it drives the root, and cleared on release (#879 fix r8)", async () => {
    // The phone viewer's popup carried reui DialogContent's `duration-100` with transition-property left at `all`, so every height/transform write eased over 100ms.
    const element = document.createElement("div"); element.className = "duration-100"; document.body.appendChild(element);
    function Tracked({ track }: { track: boolean }) { useVisualViewport(false, undefined, element, track); return null; }
    await act(async () => { root.render(<Tracked track />); });
    expect(element.style.transition).toBe("none");
    Object.assign(fake, { height: 384, offsetTop: 330 });
    fake.dispatchEvent(new Event("scroll"));
    expect(element.style.transform).toBe("translateY(330px)");
    expect(element.style.transition).toBe("none");
    await act(async () => { root.render(<Tracked track={false} />); });
    expect(element.style.transition).toBe("");
    expect(element.style.height).toBe("");
    expect(element.style.transform).toBe("");
  });
  it("with tracking on, the root follows the viewport before compose mode turns on: a keyboard rise that beats React is still applied (#879 fix r5)", async () => {
    const element = document.createElement("div"); document.body.appendChild(element);
    const ref = element;
    function Tracked({ enabled }: { enabled: boolean }) { const box = useVisualViewport(enabled, undefined, ref, true); return <output>{box ? `${box.height}/${box.offsetTop}` : "none"}</output>; }
    await act(async () => { root.render(<Tracked enabled={false} />); });
    expect(element.style.height).toBe(`${window.innerHeight}px`);
    // iOS pans and shrinks on focus, before React has turned compose mode on: the root follows inside the event, with no render.
    Object.assign(fake, { height: 430, offsetTop: 120 });
    fake.dispatchEvent(new Event("resize"));
    expect(element.style.height).toBe("430px");
    expect(element.style.transform).toBe("translateY(120px)");
    expect(text()).toBe("none");
    // A scroll of the page itself is followed too.
    fake.offsetTop = 60;
    window.dispatchEvent(new Event("scroll"));
    expect(element.style.transform).toBe("translateY(60px)");
    await act(async () => { root.render(<Tracked enabled />); });
    expect(text()).toBe("430/60");
    // Leaving compose mode: the page scroll is put back while the box is still held, and only then is the box dropped; the root keeps following.
    let boxWhenScrolled: string | null = null;
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => { boxWhenScrolled = text(); });
    await act(async () => { root.render(<Tracked enabled={false} />); });
    await fire("resize", { height: window.innerHeight, offsetTop: 60 });
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(boxWhenScrolled).toBe("430/60");
    expect(text()).toBe("none");
    expect(element.style.height).toBe(`${window.innerHeight}px`);
    scrollTo.mockRestore();
    // Tracking off (the phone viewer closed, or a desktop width): the root is released.
    function Off() { useVisualViewport(false, undefined, ref, false); return null; }
    await act(async () => { root.render(<Off />); });
    expect(element.style.height).toBe("");
    expect(element.style.transform).toBe("");
  });
});
