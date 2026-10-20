import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installVideoElementStub, type VideoElementStub } from "../../testing/video-element";
import { VideoStage } from "./VideoStage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let stub: VideoElementStub;
let root: Root | null = null;
let host: HTMLElement;
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function withLayout(width: number, height: number, run: () => Promise<void>) {
  const original = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
  for (const [prop, value] of [["offsetWidth", width], ["offsetHeight", height], ["offsetLeft", 0], ["offsetTop", 0]] as const) Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
  try { await run(); } finally {
    for (const prop of ["offsetWidth", "offsetHeight", "offsetLeft", "offsetTop"] as const) {
      const d = original[prop];
      if (d) Object.defineProperty(HTMLElement.prototype, prop, d); else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
    }
  }
}

async function mount(props: Partial<React.ComponentProps<typeof VideoStage>> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<VideoStage streamUrl="/media/video/x" title="Walkthrough" width={1920} height={1080} {...props} />); });
  const video = host.querySelector("video")!;
  await act(async () => { stub.loadMetadata(video, { duration: 4, videoWidth: 1920, videoHeight: 1080 }); });
}

beforeEach(() => { stub = installVideoElementStub(); });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null; stub.dispose(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

describe("VideoStage (#927: no timecode chip on the picture)", () => {
  it("draws no timecode chip at any size, with or without the picture box measured", async () => {
    await withLayout(800, 800, async () => {
      await mount();
      expect(byTestId("video-picture-box")).not.toBeNull();
      expect(byTestId("video-timecode-chip")).toBeNull();
    });
    await act(async () => { root!.unmount(); }); root = null; document.body.replaceChildren();
    await mount();
    expect(byTestId("video-timecode-chip")).toBeNull();
  });

  it("keeps the picture box as a measured, empty, inert marker the watermark and overlay share", async () => {
    await withLayout(800, 800, async () => {
      await mount();
      const picture = byTestId("video-picture-box")!;
      expect(picture.children.length).toBe(0);
      expect(picture.getAttribute("aria-hidden")).toBe("true");
      expect(picture.className).toContain("pointer-events-none");
      expect(picture.style.height).toBe("450px");
    });
  });

  it("hands a function overlay the picture box and draws a watermark inside it", async () => {
    await withLayout(800, 800, async () => {
      const overlay = vi.fn(() => <div data-testid="overlay" />);
      await mount({ overlay, watermark: () => <div data-testid="mark" /> });
      expect(byTestId("overlay")).not.toBeNull();
      expect(byTestId("mark")).not.toBeNull();
      expect(overlay).toHaveBeenLastCalledWith(expect.objectContaining({ width: 800, height: 450 }));
    });
  });

  it("shows its own notice when the film cannot play", async () => {
    await mount();
    await act(async () => { host.querySelector("video")!.dispatchEvent(new Event("error")); });
    expect(document.body.textContent).toContain("This version can't play in this browser.");
  });
});
