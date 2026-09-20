/**
 * #219 PR A fix (dr-219a LOW #7, the fix-219a-skin.md spec) — three small ones, one commit.
 *
 * 1. A resize grip is absolutely positioned, so it never pushes the label - it just overlays the
 *    label's own `px-1.5` (6px) padding. The grip spans `start-0.5`/`end-0.5` (2px inset) plus
 *    `w-2` (8px wide), reaching 10px in from the edge - 4px past the padding - so a hovered bar
 *    with a short title read as "|Unlocke…|". Fixed by reserving the grip's width from the label
 *    box (`ps-3`/`pe-3`, 12px) ONLY on the side(s) that actually render a grip.
 * 2. The group progress rail (`gantt-view.tsx`'s collapsed-group rollup) used the same taupe,
 *    height, and `rounded-full` shape as the horizontal scrollbar thumb
 *    (`components/reui/scroll-area.tsx`'s `rounded-full bg-border`). Fixed with a squarer
 *    (`rounded-xs`), hairline-bounded (`border-border`, transparent track) treatment, and the
 *    "NN%" label raised from `text-muted-foreground` to `text-foreground`.
 * 3. The floating zoom control was a `rounded-md` capsule with `size-5` (20px) hit targets over a
 *    square grid. Fixed: `rounded-none` (matching `styles/tokens/spacing.css`'s own
 *    `--radius-card: 0` - "cards are square by default" - chosen over a smaller-but-still-rounded
 *    rung, since the grid it floats over has no rounding at all either) and `size-11!` (44px,
 *    WCAG 2.5.5/2.5.8's minimum target size) on both buttons; the icon itself stays `size-3`.
 *
 * Real `<GanttView>` render, same infrastructure `gantt-adjust-ghost-marker.dom.test.tsx` and
 * `gantt-bar-completed-hue.dom.test.tsx` already use (see either file's own `getAnimations`
 * polyfill note - happy-dom does not implement it, and ReUI's `ScrollArea` calls it on a delayed
 * timer that can outlive `root.unmount()`).
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gantt } from "@/components/reui/gantt/gantt";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import type { GanttEvent, GanttResource } from "@/components/reui/gantt/gantt-types";

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
const END = new Date("2026-03-03T00:00:00.000Z");

function findBar(title: string): HTMLButtonElement {
  const bar = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes(title));
  if (!bar) throw new Error(`no bar found for title ${title}`);
  return bar as HTMLButtonElement;
}

describe("part 1: a resize grip reserves its width from the label box (#219 PR A, dr-219a LOW #7)", () => {
  it("a bar with BOTH edges resizable gets ps-3 and pe-3, not the tighter px-1.5, on the start/end side", async () => {
    const event: GanttEvent = {
      id: "resizable",
      title: "Unlocked Task",
      start: START,
      end: END,
      resourceId: "r1",
    };
    await render(
      <Gantt
        resources={[{ id: "r1", title: "Row 1" }]}
        events={[event]}
        date={START}
        scale="day"
        timeZone="UTC"
      >
        <GanttView />
      </Gantt>,
    );
    const bar = findBar("Unlocked Task");
    expect(bar.className).toContain("ps-3");
    expect(bar.className).toContain("pe-3");
  });
});

describe("part 2: the group progress rail is squarer and hairline-bounded, not scrollbar-identical (#219 PR A, dr-219a LOW #7)", () => {
  it("a collapsed-group rollup renders a rounded-xs, border-border-outlined, transparent-track rail, and the % label at text-foreground", async () => {
    const resources: GanttResource[] = [
      {
        id: "team",
        title: "Team",
        children: [{ id: "child", title: "Child" }],
      },
    ];
    const events: GanttEvent[] = [
      { id: "child-event", title: "Child Event", start: START, end: END, resourceId: "child", progress: 40 },
    ];
    await render(
      <Gantt resources={resources} events={events} date={START} scale="day" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );
    const rail = host.querySelector<HTMLElement>('[data-testid="gantt-summary-rail"]');
    expect(rail).not.toBeNull();
    expect(rail!.className).toContain("rounded-xs");
    expect(rail!.className).not.toMatch(/\brounded-full\b/);
    expect(rail!.className).toContain("border-border");
    expect(rail!.className).toContain("border");
    expect(rail!.className).toContain("bg-transparent");

    const label = host.querySelector<HTMLElement>('[data-testid="gantt-summary-label"]');
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("40%");
    expect(label!.className).toContain("text-foreground");
    expect(label!.className).not.toMatch(/\btext-muted-foreground\b/);
  });
});

describe("part 3: the zoom control is a square capsule with 44px hit targets (#219 PR A, dr-219a LOW #7)", () => {
  it("the zoom-in/zoom-out buttons are size-11 (44px) and rounded-none, and the outer capsule is rounded-none too", async () => {
    await render(
      <Gantt
        resources={[{ id: "r1", title: "Row 1" }]}
        events={[]}
        date={START}
        scale="day"
        timeZone="UTC"
      >
        <GanttView />
      </Gantt>,
    );
    const zoomIn = host.querySelector<HTMLElement>('[aria-label="Zoom in"]');
    const zoomOut = host.querySelector<HTMLElement>('[aria-label="Zoom out"]');
    expect(zoomIn).not.toBeNull();
    expect(zoomOut).not.toBeNull();
    for (const btn of [zoomIn!, zoomOut!]) {
      expect(btn.className).toContain("size-11!");
      expect(btn.className).not.toMatch(/\bsize-5!/);
      expect(btn.className).toContain("rounded-none");
      expect(btn.className).not.toMatch(/\brounded-[tb]-none\b/);
    }
    // the icon itself stays small - a bigger hit target does not mean a bigger glyph
    const plusIcon = zoomIn!.parentElement!.querySelector("svg");
    expect(plusIcon?.getAttribute("class")).toContain("size-3");

    const capsule = zoomIn!.closest('[data-testid="gantt-zoom"]');
    expect(capsule).not.toBeNull();
    expect((capsule as HTMLElement).className).toContain("rounded-none");
    expect((capsule as HTMLElement).className).not.toMatch(/\brounded-md\b/);
  });
});
