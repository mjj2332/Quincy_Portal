/**
 * 2026-09-28 — the `gantt-view` wrapper was an `overflow-hidden` scroll container whose
 * scrollWidth ran 145–445px past its clientWidth, so `bar.scrollIntoView({inline})` slid the whole
 * view sideways (resource column cropped to "esources", stuck until reload). See
 * `gantt-view.tsx`'s and `reui/scroll-area.tsx`'s headers, same date.
 *
 * happy-dom has no layout, so neither the overflow nor the scroll can be measured here (that was
 * verified in a real browser at 1440×900). What this pins is the two class contracts the fix rests
 * on, against the real rendered DOM:
 *
 * 1. The wrapper is `overflow-clip` — clipped, but not a scroll container.
 * 2. Every `ScrollBar` orientation variant is written against the attribute Base UI actually emits
 *    (`data-orientation="horizontal|vertical"`). The registry's `data-horizontal:` form matched
 *    nothing, which left the horizontal scrollbar `flex-row` and its thumb filling the whole track.
 *
 * `getAnimations` polyfill: see `gantt-adjust-ghost-marker.dom.test.tsx`'s header.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gantt } from "@/components/reui/gantt/gantt";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import { ScrollArea, ScrollBar } from "@/components/reui/scroll-area";

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

describe("gantt-view is clipped, not a scroll container (2026-09-28)", () => {
  it("the wrapper carries overflow-clip and no overflow-hidden/auto/scroll", async () => {
    await render(
      <Gantt resources={[{ id: "r1", title: "Row 1" }]} events={[]} date={START} scale="day" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );
    const view = host.querySelector<HTMLElement>('[data-testid="gantt-view"]');
    expect(view).not.toBeNull();
    const classes = view!.className.split(/\s+/);
    expect(classes).toContain("overflow-clip");
    expect(classes.filter((c) => /^overflow(-[xy])?-(hidden|auto|scroll)$/.test(c))).toEqual([]);
  });

  it("the tree column is sticky and clipped on x (clip, never hidden/auto/scroll)", async () => {
    await render(
      <Gantt resources={[{ id: "r1", title: "Row 1" }]} events={[]} date={START} scale="day" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );
    const tree = host.querySelector<HTMLElement>('[data-testid="gantt-tree-column"]');
    expect(tree).not.toBeNull();
    const classes = tree!.className.split(/\s+/);
    expect(classes).toContain("sticky");
    expect(classes).toContain("overflow-x-clip");
    expect(classes.filter((c) => /^overflow(-[xy])?-(hidden|auto|scroll)$/.test(c))).toEqual([]);
  });
});

describe("ScrollBar orientation variants match the attribute Base UI emits (2026-09-28)", () => {
  for (const orientation of ["horizontal", "vertical"] as const) {
    it(`a ${orientation} scrollbar's variants all target data-orientation=${orientation}, which it carries`, async () => {
      await render(
        <ScrollArea>
          <div />
          {/* keepMounted: with no layout, Base UI never sees overflow and would not mount it */}
          <ScrollBar orientation={orientation} keepMounted />
        </ScrollArea>,
      );
      // selected by Base UI's own attribute - the one every variant must be written against
      const bar = host.querySelector<HTMLElement>(`[data-orientation="${orientation}"]`);
      expect(bar).not.toBeNull();
      // Base UI emits data-orientation, never a bare data-horizontal/data-vertical attribute
      expect(bar!.hasAttribute(`data-${orientation}`)).toBe(false);
      const classes = bar!.className.split(/\s+/);
      expect(classes.filter((c) => /^data-(horizontal|vertical):/.test(c))).toEqual([]);
      if (orientation === "horizontal") {
        // the one that caused the bug: without flex-col the thumb's flex-1 overrides its width
        expect(classes).toContain("data-[orientation=horizontal]:flex-col");
        expect(classes).toContain("data-[orientation=horizontal]:h-2.5");
      } else {
        expect(classes).toContain("data-[orientation=vertical]:w-2.5");
        expect(classes).toContain("data-[orientation=vertical]:h-full");
      }
    });
  }
});
