import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhiteboardChrome, type ChromeState } from "./whiteboard-controls";

/** #501: the host's Image or video tool takes the toolbar's Image slot while the editor's own image tool is off, and picking it reaches the host as the "image" tool. */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement;
const noop = vi.fn();
const state: ChromeState = { tool: "selection", zoom: 1, grid: true, snap: false, viewMode: false, selected: false, penMode: false, penDetected: false, phone: false, narrow: false, frameAt: null };

async function render(props: { imageTool: boolean; mediaToolLabel?: string }, onTool = noop) {
  await act(async () => {
    root!.render(
      <WhiteboardChrome state={state} history={{ undo: true, redo: true }} frames={[]} viewOnlyLocked={false} platform="other" loading={false} menuFocus={undefined}
        {...props} onTool={onTool} onZoom={noop} onFit={noop} onPreference={noop} onViewOnly={noop} onHistory={noop} onFrame={noop} onFind={noop} onShortcuts={noop} footerRef={noop} layerRef={noop} />,
    );
    await Promise.resolve();
  });
}
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root!.unmount(); await Promise.resolve(); }); host.remove(); root = null; });

describe("the Image or video tool (#501)", () => {
  it("shows the Image slot as Image or video, without the editor's key hint, when the host provides the tool", async () => {
    await render({ imageTool: false, mediaToolLabel: "Image or video" });
    const button = host.querySelector<HTMLElement>('button[aria-label="Image or video"]')!;
    expect(button).not.toBeNull();
    expect(button.hasAttribute("aria-keyshortcuts")).toBe(false);            // the editor's key 9 is its own (disabled) image tool
    expect(host.querySelector('button[aria-label="Image"]')).toBeNull();
  });

  it("hides the slot when neither the editor's image tool nor the host's tool is on, and keeps the editor's own Image tool and key when it is", async () => {
    await render({ imageTool: false });
    expect(host.querySelector('button[aria-label="Image or video"], button[aria-label="Image"]')).toBeNull();
    await render({ imageTool: true });
    expect(host.querySelector('button[aria-label="Image"]')?.getAttribute("aria-keyshortcuts")).toBe("9");
  });

  it("picking it reaches the host as the image tool", async () => {
    const onTool = vi.fn();
    await render({ imageTool: false, mediaToolLabel: "Image or video" }, onTool);
    await act(async () => { host.querySelector<HTMLElement>('button[aria-label="Image or video"]')!.click(); });
    expect(onTool).toHaveBeenCalledWith("image", null);
  });
});
