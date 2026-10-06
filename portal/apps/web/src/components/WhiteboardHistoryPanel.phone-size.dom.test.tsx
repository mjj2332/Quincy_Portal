/**
 * #564: the History sheet's 44px targets follow the SAME predicate as the canvas (`isPhoneLayout`, surfaced as
 * `data-phone-layout` on the board root), not a viewport query, so a landscape phone or a 722-800px window never
 * shows 44px canvas controls beside 32px panel controls. The sheet is portaled to body, outside the board root, so
 * it matches `body:has([data-phone-layout])`. happy-dom neither applies Tailwind nor evaluates `:has()`, so this pins
 * the class contract (conditional on the attribute, no viewport query); the rendered pixel sizes, with and without a
 * phone-layout board, are measured in the browser pass.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...(await original<typeof import("../lib/api")>()), apiGet: h.get, apiPost: vi.fn() }));
vi.mock("../lib/toast-store", () => ({ pushToast: () => undefined }));

import { createRef } from "react";
import { WhiteboardHistoryPanel } from "./WhiteboardHistoryPanel";
import { BoardPanel } from "./reui/whiteboard/board-panel";

const PHONE = "[body:has([data-phone-layout])_&]";
let host: HTMLDivElement;
let root: Root;
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); };

beforeEach(async () => {
  h.get.mockResolvedValue({ generation: 1, versions: [{ id: "v1", createdAt: 1_000_000, createdBy: null, reason: "interval", elementCount: 2, byteCount: 10 }] });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => {
    root.render(<WhiteboardHistoryPanel projectId="p1" title="Board" open onOpenChange={() => undefined} readOnly={false} onRestoreStarted={vi.fn()} onRestoreFailed={vi.fn()} />);
  });
  await flush();
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); document.body.replaceChildren(); });

const panel = (panes: Record<string, React.ReactNode>) => (
  <BoardPanel
    title="History" panelId="p" tabRef={createRef<HTMLButtonElement>()} docked={false} measured dockOpen={false} sheetOpen onSheetOpenChange={() => undefined}
    tab="history" onTabChange={() => undefined} panes={panes}
  />
);

describe("the History sheet follows the board's phone layout (#564)", () => {
  it("History is one pane, so the sheet has no tab strip; its row actions switch to 44px on the phone-layout predicate, with no viewport query", () => {
    expect(document.body.querySelector('[role="tab"]')).toBeNull();
    expect(document.body.querySelector('[role="tablist"]')).toBeNull();
    const action = document.body.querySelector<HTMLElement>('[aria-label^="Restore "]')!;
    expect(action.className).toContain(`${PHONE}:min-h-[44px]`);
    expect(action.className).toContain(`${PHONE}:min-w-[44px]`);
    expect(action.className).not.toContain("721px");
  });

  it("the tab strip, when a panel has more than one pane, switches to 44px on the same predicate, with no viewport query", async () => {
    await act(async () => { root.render(panel({ frames: <p>f</p>, history: <p>h</p> })); });
    const tab = document.body.querySelector<HTMLElement>('[role="tab"]')!;
    const list = document.body.querySelector<HTMLElement>('[role="tablist"]')!;
    expect(tab.className).toContain(`${PHONE}:h-11`);
    expect(list.className).toContain(`${PHONE}:group-data-[orientation=horizontal]/tabs:h-[3.125rem]`);
    for (const el of [tab, list]) expect(el.className).not.toContain("721px");
  });

  it("the targets are conditional: a board that is not in the phone layout leaves the 32px defaults", async () => {
    const action = document.body.querySelector<HTMLElement>('[aria-label^="Restore "]')!;
    expect(action.className).not.toMatch(/(^|\s)min-h-\[44px\](\s|$)/);
    await act(async () => { root.render(panel({ frames: <p>f</p>, history: <p>h</p> })); });
    expect(document.body.querySelector<HTMLElement>('[role="tab"]')!.className).not.toMatch(/(^|\s)h-11(\s|$)/);
  });
});
