/**
 * #559: the History sheet's chrome. `MetaLine` keeps each separator dot with the part after it (a phone's wrap never leaves a dot hanging),
 * and the tab strip appears only when there is more than one tab (a lone "History" tab repeated the sheet's own title).
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { BoardPanel, MetaLine } from "./board-panel";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); document.body.replaceChildren(); });

const panel = (panes: Record<string, React.ReactNode>, description?: string) => (
  <BoardPanel
    title="History"
    description={description}
    panelId="p"
    tabRef={createRef<HTMLButtonElement>()}
    docked={false}
    measured
    dockOpen={false}
    sheetOpen
    onSheetOpenChange={() => undefined}
    tab="history"
    onTabChange={() => undefined}
    panes={panes}
  />
);

describe("MetaLine (#559)", () => {
  it("wraps every dot together with the part after it in one nowrap span, and the first part carries none", async () => {
    await act(async () => { root.render(<MetaLine parts={[<b key="a" data-testid="first">Terry</b>, "10 Mar 2020", "7 elements"]} />); });
    const dots = [...host.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')];
    expect(dots).toHaveLength(2);
    // Each dot's parent is its own group: the dot plus the part after it, nothing else.
    expect(dots.map((dot) => dot.parentElement!.textContent)).toEqual([", 10 Mar 2020", ", 7 elements"]);
    expect(new Set(dots.map((dot) => dot.parentElement)).size).toBe(2);
    expect(dots.every((dot) => dot.parentElement!.className.includes("whitespace-nowrap"))).toBe(true);
  });
});

describe("the sheet's tab strip (#559)", () => {
  it("shows no tab strip for a single pane", async () => {
    await act(async () => { root.render(panel({ history: <p>rows</p> }, "1 Writes Street")); });
    expect(document.body.querySelector('[role="tablist"]')).toBeNull();
    expect(document.body.querySelector('[role="tabpanel"]')).toBeNull();
    expect(document.body.textContent).toContain("rows");
  });

  it("shows the strip with every tab once there is more than one", async () => {
    await act(async () => { root.render(panel({ frames: <p>f</p>, history: <p>rows</p> })); });
    const labels = [...document.body.querySelectorAll('[role="tab"]')].map((node) => node.textContent);
    expect(labels).toEqual(["Frames", "History"]);
    // Every tabpanel is named by its tab.
    for (const panel of document.body.querySelectorAll('[role="tabpanel"]')) expect(document.getElementById(panel.getAttribute("aria-labelledby") ?? "")).not.toBeNull();
  });

  it("without a description the subtitle is a sentence naming the panes, not a bare lowercase word", async () => {
    await act(async () => { root.render(panel({ frames: <p>f</p>, history: <p>h</p> })); });
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent).toBe("The board's frames, history.");
  });
});
