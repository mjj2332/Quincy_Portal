/**
 * 2026-09-28, #256 — `treePanel.nameColumnFill`: the tree's name column grows to fill the panel
 * (its `nameColumnWidth` becomes a floor) instead of stopping at a fixed width and leaving a blank
 * spacer to its right. In fill mode the trailing `min-w-0 flex-1` spacer is dropped in both the
 * header and every row — kept, it would split the slack 50/50 with the grown name cell. The
 * default config is unchanged: fixed width, no grow, spacer present.
 *
 * happy-dom has no layout, so this pins the inline style and the DOM shape, not a measured width.
 * Cells are selected by `data-testid` (test-seam guard F). `getAnimations` polyfill: see
 * `gantt-adjust-ghost-marker.dom.test.tsx`'s header.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gantt } from "@/components/reui/gantt/gantt";
import { GanttView } from "@/components/reui/gantt/gantt-view";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => {
    root!.render(value);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
      await Promise.resolve();
    });
  }
  root = null;
  host.remove();
});

const START = new Date("2026-03-02T00:00:00.000Z");
const RESOURCES = [
  { id: "r1", title: "Row 1" },
  { id: "r2", title: "Row 2" },
];

function nameCells(): HTMLElement[] {
  const header = host.querySelector<HTMLElement>('[data-testid="gantt-tree-name-header"]');
  expect(header).not.toBeNull();
  const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="gantt-tree-name-cell"]')];
  expect(rows).toHaveLength(RESOURCES.length);
  return [header!, ...rows];
}

/** The trailing spacer: a bare, empty `min-w-0 flex-1` div as the cell's last sibling. */
function hasTrailingSpacer(cell: HTMLElement): boolean {
  const last = cell.parentElement?.lastElementChild as HTMLElement | null;
  if (!last || last === cell) return false;
  const classes = last.className.split(/\s+/);
  return classes.includes("min-w-0") && classes.includes("flex-1") && last.childElementCount === 0;
}

describe("gantt tree name column fill (#256, 2026-09-28)", () => {
  it("nameColumnFill: the header and every row name cell grow, keep nameColumnWidth as the floor, and have no spacer", async () => {
    await render(
      <Gantt resources={RESOURCES} events={[]} date={START} scale="day" timeZone="UTC" treePanel={{ nameColumnFill: true, nameColumnWidth: 180 }}>
        <GanttView />
      </Gantt>,
    );
    for (const cell of nameCells()) {
      expect(cell.style.flexGrow).toBe("1");
      expect(cell.style.width).toBe("180px");
      expect(hasTrailingSpacer(cell)).toBe(false);
    }
  });

  it("default config is unchanged: fixed-width name cells, no grow, spacer present", async () => {
    await render(
      <Gantt resources={RESOURCES} events={[]} date={START} scale="day" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );
    for (const cell of nameCells()) {
      expect(cell.style.flexGrow).toBe("");
      expect(cell.style.width).toBe("208px");
      expect(hasTrailingSpacer(cell)).toBe(true);
    }
  });
});
