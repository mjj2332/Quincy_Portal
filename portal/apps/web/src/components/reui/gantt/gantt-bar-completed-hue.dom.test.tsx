/**
 * #219 PR A fix (dr-219a MEDIUM #5, the fix-219a-skin.md spec) — "dimmed when done" inverts.
 *
 * Before this fix, `data-completed` styling was an ALPHA STEP on the event's OWN per-stage hue
 * (`bg-(--gantt-event-color)/20` -> `/10` on the shell, `/40` -> `/20` on the progress-fill child)
 * - a per-hue treatment, not a hue-independent one. A 10% wash of a naturally dark/saturated stage
 * colour (e.g. `--signal-positive`, olive) can still read louder than a 20% wash of a naturally
 * light one (e.g. `--greige-400`) - the design reviewer measured a completed bar at Δ52 from paper
 * against Δ22 for an idle one, i.e. backwards: "done" must always be QUIETER than any active bar,
 * whatever its stage colour, and an alpha step derived from the hue itself cannot guarantee that
 * across arbitrary hues.
 *
 * The fix drops `--gantt-event-color` from the completed treatment entirely and uses the existing
 * `--color-border` token (`bg-border`) instead - one fixed, hue-independent value for EVERY stage,
 * proven quieter than the whole harness's stage palette by a real calculation (not eyeballed, and
 * not a browser measurement I have no way to take) - see this fix's own commit message for the
 * script and numbers. This test's job is narrower: given two bars of DIFFERENT event.color, both
 * done, does the DONE treatment actually render identically and NOT reference
 * `--gantt-event-color` at all - the literal thing "is not a per-hue alpha step" asks for.
 *
 * Real `<GanttView>` render, same infrastructure `gantt-adjust-ghost-marker.dom.test.tsx` already
 * uses (see that file's own `getAnimations` polyfill note, reused verbatim below - happy-dom does
 * not implement it, and ReUI's `ScrollArea` calls it on a delayed timer that can outlive
 * `root.unmount()`).
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

const RESOURCES: GanttResource[] = [{ id: "r1", title: "Row 1" }];

function findBar(title: string): HTMLButtonElement {
  const bar = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes(title));
  if (!bar) throw new Error(`no bar found for title ${title}`);
  return bar as HTMLButtonElement;
}

function findProgressFill(bar: HTMLElement): HTMLElement {
  const el = bar.querySelector<HTMLElement>('[data-testid="gantt-bar-progress"]');
  if (!el) throw new Error("no progress-fill span found");
  return el;
}

describe("a completed bar's fill is hue-independent, not a per-hue alpha step (#219 PR A, dr-219a MEDIUM #5)", () => {
  it("two completed events with DIFFERENT event.color render the IDENTICAL done treatment, and neither references --gantt-event-color", async () => {
    const events: GanttEvent[] = [
      {
        id: "olive-done",
        title: "Olive Done",
        start: START,
        end: END,
        resourceId: "r1",
        color: "var(--signal-positive)",
        progress: 100,
      },
      {
        id: "greige-done",
        title: "Greige Done",
        start: START,
        end: END,
        resourceId: "r1",
        color: "var(--greige-400)",
        progress: 100,
      },
    ];
    await render(
      <Gantt resources={RESOURCES} events={events} date={START} scale="day" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );

    const oliveBar = findBar("Olive Done");
    const greigeBar = findBar("Greige Done");
    expect(oliveBar.getAttribute("data-completed")).toBe("true");
    expect(greigeBar.getAttribute("data-completed")).toBe("true");

    // The literal "not a per-hue alpha step" assertion: the done variant of the shell's own
    // background must not read the event's own colour custom property at all.
    expect(oliveBar.className).not.toMatch(/data-completed:(?:hover:)?bg-\(--gantt-event-color\)/);
    expect(greigeBar.className).not.toMatch(/data-completed:(?:hover:)?bg-\(--gantt-event-color\)/);
    // Both bars carry the IDENTICAL fixed hue-independent treatment regardless of event.color.
    expect(oliveBar.className).toContain("data-completed:bg-border");
    expect(greigeBar.className).toContain("data-completed:bg-border");

    const oliveFill = findProgressFill(oliveBar);
    const greigeFill = findProgressFill(greigeBar);
    expect(oliveFill.className).not.toMatch(
      /group-data-completed\/gantt-bar-group:(?:border|bg)-\(--gantt-event-color\)/,
    );
    expect(greigeFill.className).not.toMatch(
      /group-data-completed\/gantt-bar-group:(?:border|bg)-\(--gantt-event-color\)/,
    );
    expect(oliveFill.className).toContain("group-data-completed/gantt-bar-group:border-border");
    expect(oliveFill.className).toContain("group-data-completed/gantt-bar-group:bg-border");
    expect(greigeFill.className).toBe(oliveFill.className);
  });

  it("an ACTIVE (not-done) bar keeps its per-hue fill, unaffected by this fix", async () => {
    const event: GanttEvent = {
      id: "active",
      title: "Still Going",
      start: START,
      end: END,
      resourceId: "r1",
      color: "var(--signal-positive)",
      progress: 40,
    };
    await render(
      <Gantt resources={RESOURCES} events={[event]} date={START} scale="day" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );
    const bar = findBar("Still Going");
    expect(bar.hasAttribute("data-completed")).toBe(false);
    expect(bar.className).toContain("bg-(--gantt-event-color)/20");
    const fill = findProgressFill(bar);
    expect(fill.className).toContain("bg-(--gantt-event-color)/40");
  });
});
