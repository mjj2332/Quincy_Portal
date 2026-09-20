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

/**
 * #219 PR A fix (dr-219a r6 HIGH #1) — a completed bar SELECTED brought the stage hue back.
 *
 * Before this fix, the shell carried `data-completed:bg-border/15` and, a few classes later,
 * `data-selected:bg-(--gantt-event-color)/30` — two rules with EQUAL specificity (one
 * single-attribute selector each), so which one painted depended entirely on which Tailwind
 * emitted later in the generated stylesheet. `data-selected` happened to come after
 * `data-completed` in source order, so selecting an already-done bar re-painted it in its own
 * stage colour — the exact hue-dependence the sibling describe block above exists to rule out,
 * just reachable through an ordinary click instead of through two different event.color values.
 *
 * The fix gives the completed+selected COMBINATION its own two-attribute-selector rule
 * (`data-completed:data-selected:bg-border/15`), which Tailwind compiles to a selector of
 * strictly HIGHER specificity (0,0,2,0) than either single-attribute rule (0,0,1,0) — the neutral
 * wash wins by CSS SPECIFICITY, not by which class happens to sit later in the array, so swapping
 * the two single-attribute classes' order can never flip the outcome back. This test's job is
 * narrower than a real browser paint: given the actual className string that ships, prove (a) the
 * higher-specificity override rule is present and pins the SAME neutral value the plain
 * `data-completed` rule uses, so a completed+selected bar cannot resolve to anything else, and (b)
 * a distinct, hue-independent selection indicator exists that ONLY activates when BOTH
 * `data-completed` and `data-selected` are true (so an unselected completed bar — same background
 * rule present in its className either way, since Tailwind ships the whole utility set regardless
 * of which data-* attributes happen to be set on THIS element — never matches the compound
 * selector and stays undecorated).
 */
describe("a completed bar that is ALSO selected keeps the neutral completed background, distinguished by something other than hue (#219 PR A, dr-219a r6 HIGH #1)", () => {
  it("selecting a completed bar does not bring its stage hue back, and the selection stays visible some other way", async () => {
    const event: GanttEvent = {
      id: "done-and-selected",
      title: "Done And Selected",
      start: START,
      end: END,
      resourceId: "r1",
      color: "var(--signal-positive)",
      progress: 100,
    };
    await render(
      <Gantt resources={RESOURCES} events={[event]} date={START} scale="day" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );

    const bar = findBar("Done And Selected");
    expect(bar.getAttribute("data-completed")).toBe("true");
    expect(bar.hasAttribute("data-selected")).toBe(false);

    // A completed-but-NOT-selected bar already carries whatever selection-indicator utility the
    // fix adds — Tailwind's variant classes are static, present regardless of which data-*
    // attributes are actually set on this particular element — so the class TEXT alone can't
    // distinguish "selected" from "not". What CAN is the compound selector requiring BOTH
    // attributes: this bar has only one of them, so it can never match a
    // `data-completed:data-selected:…` rule.
    const unselectedClassName = bar.className;
    expect(unselectedClassName).toMatch(/data-completed:data-selected:bg-border\/15/);

    await act(async () => {
      bar.click();
      await Promise.resolve();
    });

    expect(bar.getAttribute("data-completed")).toBe("true");
    expect(bar.getAttribute("data-selected")).toBe("true");

    // The className itself is unchanged by selection (it's the same static Tailwind variant
    // list either way) — what matters is that the OVERRIDE rule pins the identical neutral value
    // the plain `data-completed` rule already uses, at a selector Tailwind compiles with strictly
    // higher specificity (two attribute selectors) than the single-attribute `data-selected`
    // background rule below it, so it wins regardless of which of the two was emitted last.
    expect(bar.className).toContain("data-completed:bg-border/15");
    expect(bar.className).toMatch(/data-completed:data-selected:bg-border\/15/);
    expect(bar.className).toContain("data-selected:bg-(--gantt-event-color)/30");

    // Selection must still be visible on a completed bar, by some means OTHER than the
    // background (which the fix pins to the neutral completed treatment either way) — and that
    // means must be gated on the SAME two-attribute compound, not on `data-selected` alone,
    // otherwise it would just be the plain (already-correct) non-completed selected treatment
    // and prove nothing about THIS bug.
    const selectionIndicator = /data-completed:data-selected:(?:ring-|border-|font-)\S+/;
    expect(bar.className).toMatch(selectionIndicator);

    // Hue-independence still holds for whatever that indicator is: it must not reference the
    // event's own colour custom property.
    const [indicatorClass] = bar.className.match(selectionIndicator) ?? [];
    expect(indicatorClass).toBeDefined();
    expect(indicatorClass).not.toContain("--gantt-event-color");
  });
});
