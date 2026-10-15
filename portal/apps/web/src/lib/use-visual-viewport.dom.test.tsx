import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useVisualViewport } from "./use-visual-viewport";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeViewport extends EventTarget { height = 800; offsetTop = 0; }
let root: Root; let host: HTMLElement; let fake: FakeViewport; const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
function Probe({ enabled }: { enabled: boolean }) { const box = useVisualViewport(enabled); return <output data-testid="box">{box ? `${box.height}/${box.offsetTop}` : "none"}</output>; }
const text = () => host.querySelector("output")!.textContent;
beforeEach(() => { fake = new FakeViewport(); Object.defineProperty(window, "visualViewport", { configurable: true, value: fake }); host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); }); if (original) Object.defineProperty(window, "visualViewport", original); else delete (window as unknown as Record<string, unknown>).visualViewport; document.body.replaceChildren(); });

describe("useVisualViewport (#879)", () => {
  it("is null while off, then follows the visual viewport's height and offset", async () => {
    await act(async () => { root.render(<Probe enabled={false} />); });
    expect(text()).toBe("none");
    await act(async () => { root.render(<Probe enabled />); });
    expect(text()).toBe("800/0");
    fake.height = 480; fake.offsetTop = 12;
    await act(async () => { fake.dispatchEvent(new Event("resize")); });
    expect(text()).toBe("480/12");
    await act(async () => { root.render(<Probe enabled={false} />); });
    expect(text()).toBe("none");
  });
  it("is null where there is no visual viewport", async () => {
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    await act(async () => { root.render(<Probe enabled />); });
    expect(text()).toBe("none");
  });
});
