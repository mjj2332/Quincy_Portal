/**
 * #551 item 4: on a view-only board the View Only toggle is disabled (the library's pressed fill read as a grey
 * button). A disabled toggle carries the no-fill classes; an enabled one keeps its pressed fill.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhiteboardChrome, type ChromeState } from "./whiteboard-controls";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement;
const noop = vi.fn();
const state = (over: Partial<ChromeState> = {}): ChromeState => ({
  tool: "selection", zoom: 1, grid: true, snap: false, viewMode: true, selected: false,
  penMode: false, penDetected: false, phone: false, narrow: false, frameAt: null, ...over,
});

async function render(viewOnlyLocked: boolean) {
  await act(async () => {
    root!.render(
      <WhiteboardChrome
        state={state()} history={{ undo: false, redo: false }} frames={[]} viewOnlyLocked={viewOnlyLocked} imageTool={false}
        platform="other" loading={false} menuFocus={undefined} actions={[]}
        onTool={noop} onZoom={noop} onFit={noop} onPreference={noop} onViewOnly={noop} onHistory={noop}
        onFrame={noop} onFind={noop} onShortcuts={noop} footerRef={noop} layerRef={noop}
      />,
    );
    await Promise.resolve();
  });
}
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root!.unmount(); await Promise.resolve(); }); host.remove(); root = null; });

const viewOnly = () => host.querySelector<HTMLButtonElement>('button[aria-label="View Only"]')!;

describe("a disabled toggle draws no fill (#551)", () => {
  it("a locked board's View Only is disabled and carries the no-fill classes", async () => {
    await render(true);
    expect(viewOnly().disabled || viewOnly().getAttribute("aria-disabled") === "true" || viewOnly().hasAttribute("data-disabled")).toBe(true);
    for (const cls of ["disabled:bg-transparent", "disabled:aria-pressed:bg-transparent", "disabled:data-[state=on]:bg-transparent"]) expect(viewOnly().className).toContain(cls);
  });
});
