/**
 * Follow-up to 0c8432aa (#219 dr3-219a MEDIUM #1), which fixed the Adjust ghost's inside title but
 * flagged a second instance of the SAME defect for later: `gantt-view.tsx`'s day/unit axis header
 * cell (~line 2584 at the time) reads `"flex min-w-0 items-center justify-center truncate px-1.5
 * text-center"` — `truncate` sits directly on a `display:flex` container, where `text-overflow`
 * never applies to a flex container's own anonymous item, so the class was inert. Harmless there
 * because the labels are short day/date strings, but structurally the same anti-pattern
 * 0c8432aa fixed on the ghost title and `gantt-bar.tsx:532` already gets right: `truncate` belongs
 * on a non-flex CHILD span, not the flex shell itself.
 *
 * Fix mirrors 0c8432aa exactly: the outer per-unit cell keeps its flex/layout classes, an inner
 * span wrapping the label text carries `truncate`. The pre-existing `unit.isToday` branch already
 * wrapped its label in a span (`bg-primary/10 truncate rounded-full …`); the bug lived in the
 * OTHER branch, where `unit.label` rendered as a bare text node directly inside the flex cell.
 *
 * This test asserts STRUCTURE — that the truncating element is not the flex container itself — not
 * merely that a `truncate` class exists somewhere, since a class-only check would have passed
 * BEFORE the fix (the flex container itself carried the class then). Test-seam guard A (issue #50)
 * forbids a DOM test from selecting an element by CSS class, so this walks the tag structure
 * (`dayCell.querySelector("span")`, a tag selector, falling back to the flex cell itself when it
 * has no element child — the pre-fix shape, where the bug lived) instead of
 * `querySelector(".truncate")`, the same discovery path c74971ad already established for the
 * ghost-title version of this same test. HEAD always has the inner span (below), so the fallback
 * is a regression guard here too, not the path these assertions exercise today.
 *
 * Real `<GanttView>` render, same infrastructure `gantt-adjust-ghost-marker.dom.test.tsx` and
 * `gantt-low-fixes.dom.test.tsx` already use (see either file's own `getAnimations` polyfill note —
 * happy-dom does not implement it, and ReUI's `ScrollArea` calls it on a delayed timer that can
 * outlive `root.unmount()`).
 *
 * `scale="week"` (not `"day"`) deliberately: the `"day"` scale's own units are intraday time ticks
 * that never set `isToday` at all (`gantt-view.tsx`'s own unit-building memo), which would exercise
 * only the bare-text branch trivially. `"week"`'s units are calendar days — the branch this bug
 * actually lives in, and the same one `unit.isToday` conditionally short-circuits — so `DATE` is
 * chosen far from the real wall clock to keep every rendered day on the non-today, bare-text path
 * this test targets.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gantt } from "@/components/reui/gantt/gantt";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import type { GanttResource } from "@/components/reui/gantt/gantt-types";

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

const RESOURCES: GanttResource[] = [{ id: "r1", title: "Row 1" }];

// A Monday nowhere near the sandbox's real wall-clock "today" — no rendered unit can land on the
// `isToday` branch, so every day cell exercises the bare-text path this test targets.
const DATE = new Date("2020-01-06T00:00:00.000Z");

describe("follow-up to 0c8432aa (#219 dr3-219a MEDIUM #1): the day/unit axis header cell's truncating element is NOT the flex container itself", () => {
  it("the label-carrying element is a non-flex CHILD of the per-unit flex cell, not the flex cell itself", async () => {
    await render(
      <Gantt resources={RESOURCES} events={[]} date={DATE} scale="week" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );

    const axis = host.querySelector<HTMLElement>("[data-gantt-axis]");
    expect(axis).not.toBeNull();

    // `[data-gantt-axis]`'s own children, in render order: [0] the off-day chrome underlay
    // (`aria-hidden`, `absolute inset-0`), [1] the `flex h-full` row of per-unit label cells, then
    // (conditionally) the vertical unit-line marks. Structural index, not a class selector.
    const unitRow = axis!.children[1] as HTMLElement | undefined;
    expect(unitRow).not.toBeUndefined();

    const dayCell = unitRow!.children[0] as HTMLElement | undefined;
    expect(dayCell).not.toBeUndefined();
    expect(dayCell!.className).toMatch(/\bflex\b/);
    expect(dayCell!.getAttribute("data-today")).toBeNull();
    expect(dayCell!.textContent).not.toBe("");

    // Walk the tag structure instead of reaching for `.truncate` directly (test-seam guard A):
    // BEFORE the fix, the label was a bare text node with no element wrapper, so this would find
    // nothing and the fallback would read the bug's own home, the flex cell itself - HEAD always
    // wraps the label in a span (below), so the fallback is a regression guard, not the path this
    // assertion actually exercises today.
    const labelEl = dayCell!.querySelector("span") ?? dayCell!;

    // The bug this guards against: the SAME element carrying both `flex` (a flex CONTAINER) and
    // `truncate` — `text-overflow` never applies to a `display:flex` box's own anonymous item, so
    // the class did nothing. HEAD fixed this by moving `truncate` onto a non-flex child span of the
    // flex cell, exactly the way `gantt-bar.tsx:532` and 0c8432aa's ghost-title fix already do it -
    // these assertions prove that shape holds, not that the bug is present.
    expect(labelEl).not.toBe(dayCell);
    expect(labelEl.className).toContain("truncate");
    expect(labelEl.className).not.toMatch(/\bflex\b/);
    expect(dayCell!.contains(labelEl)).toBe(true);
  });
});
