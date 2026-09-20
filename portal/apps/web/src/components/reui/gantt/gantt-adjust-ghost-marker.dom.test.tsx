/**
 * #219 PR A fix (Sol re-review round 2, MEDIUM #7) — visible Adjust state.
 *
 * Before this fix, the ONLY visible marker of an active keyboard Adjust session was a dashed
 * `outline` on the bar itself (`gantt-bar.tsx`'s `data-adjusting:outline-dashed`). That lost on
 * two fronts: it visually competed with (and lost to) the ordinary `focus-visible:ring` the SAME
 * element already carries, and once a step actually moved the schedule, a move gesture hides the
 * bar entirely (`data-[drag-kind=move]:opacity-0`) while keyboard focus stays on it — nothing
 * visible said "you are adjusting this" at all. The fix moves the marker onto `gantt-view.tsx`'s
 * own drag ghost (`data-adjust-ghost`), which is never hidden and never competes with a focus
 * ring, tagged from `state.drag.source` (added #219 PR A HIGH #4) - "keyboard" for an Adjust
 * session's own `stepAdjust`, absent for a pointer gesture's `applyProposal`. Round 2's fix left
 * the ghost's actual LOOK identical either way — `data-adjust-ghost` marked WHICH source drove it
 * for a DOM test/affordance hook only, no different treatment.
 *
 * Round 3 (Sol MEDIUM #6) closed that gap: `data-adjust-ghost` now ALSO carries a solid hairline
 * ring in the existing focus-ring token (`ring-ring`, the SAME one `gantt-bar.tsx`'s own
 * `focus-visible:ring-ring/50` already uses), layered on top of the dashed hairline border every
 * ghost still carries either way — not a different border, not a new colour, no shadow class, no
 * `dark:`, so `gantt-skin.guard.test.ts` stays green. A pointer-sourced ghost keeps the dashed
 * border alone.
 *
 * This renders the REAL `<GanttView>` (not a hand-built row/axis stand-in — the ghost element
 * only exists inside it) to observe the actual DOM. The keyboard case drives a real Adjust session
 * (Space, then ArrowRight) through `gantt-bar.tsx`'s own keyboard handler, exactly as a user would.
 * The "pointer-drag ghost does not carry it" case sets `state.drag` directly via
 * `GanttInternals.setDrag` with `source: "pointer"` — the identical shape `gantt-dnd.tsx`'s own
 * `applyProposal` produces for a real gesture — rather than simulating actual PointerEvents against
 * the real axis's zero-rect-by-default geometry in this environment; the pointer-vs-keyboard
 * `source` tagging ITSELF (that a real gesture only ever produces one or the other) is already
 * exhaustively covered by `gantt-adjust-pointer-ownership.dom.test.tsx`. This file's own job is
 * narrower and different: given a `state.drag` of each source, does the RENDERED ghost reflect it.
 *
 * `getAnimations` polyfill below: happy-dom (this suite's DOM environment) does not implement
 * `Element.getAnimations()`. `<GanttView>` composes ReUI's `ScrollArea`
 * (`@base-ui/react/scroll-area`), whose internal scrollbar-auto-hide timer calls it on a delayed
 * `setTimeout` that can still fire after this test's own `root.unmount()` - an unhandled exception
 * in that timer callback, unrelated to anything this file asserts, otherwise fails the whole run.
 * A benign no-op stub (real behavior: "no active Web Animations on this element") is the honest fix
 * for a missing environment API, not a workaround for anything this test itself is asserting.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gantt, useGantt, type GanttInternals } from "@/components/reui/gantt/gantt";
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

async function keydown(el: HTMLElement, init: KeyboardEventInit): Promise<void> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
    await Promise.resolve();
  });
}

async function focusBar(el: HTMLElement) {
  await act(async () => {
    el.focus();
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
const END = new Date("2026-03-02T01:00:00.000Z"); // 1 hour

const RESOURCES: GanttResource[] = [{ id: "r1", title: "Row 1" }];

function InternalsProbe({ internalsRef }: { internalsRef: { current: GanttInternals | null } }) {
  const instance = useGantt();
  useEffect(() => {
    internalsRef.current = instance.internals;
  });
  return null;
}

function findBar(title: string): HTMLButtonElement {
  const bar = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes(title));
  if (!bar) throw new Error(`no bar found for title ${title}`);
  return bar as HTMLButtonElement;
}

function ghostEl(): HTMLElement | null {
  // Guard F (`test-seam.guard.test.ts`, issue #92) forbids selecting on the vendor's own
  // `data-slot="gantt-drag-ghost"` - `gantt-view.tsx` carries a `data-testid` alongside it for
  // exactly this, the same pattern `gantt-bar-resize-grips.dom.test.tsx` already uses.
  return host.querySelector<HTMLElement>('[data-testid="gantt-drag-ghost"]');
}

describe("the drag ghost carries data-adjust-ghost (and, round 3, a distinct ring treatment) for a keyboard Adjust session, not a pointer drag (#219 PR A, Sol re-review round 2 MEDIUM #7 / round 3 MEDIUM #6)", () => {
  it("a real Adjust session (Space, then ArrowRight) renders a ghost with data-adjust-ghost and a ring-ring hairline ring distinct from a pointer ghost's", async () => {
    const event: GanttEvent = { id: "kb-ghost", title: "Ghost Me", start: START, end: END, resourceId: "r1" };
    await render(
      <Gantt resources={RESOURCES} events={[event]} date={START} scale="day" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );
    expect(ghostEl()).toBeNull();

    const bar = findBar("Ghost Me");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    // No step yet - the committed bar's own position IS the preview, no ghost yet (see
    // `GanttInternals.stepAdjust`'s own doc comment).
    expect(ghostEl()).toBeNull();

    await keydown(bar, { key: "ArrowRight" });
    const ghost = ghostEl();
    expect(ghost).not.toBeNull();
    expect(ghost!.getAttribute("data-adjust-ghost")).toBe("true");
    expect(ghost!.getAttribute("data-kind")).toBe("move");
    // Round 3, Sol MEDIUM #6: a keyboard-sourced ghost now ALSO carries a solid hairline ring in
    // the existing focus-ring token, distinct from a pointer ghost (see the test below) - layered
    // on top of the SAME dashed hairline border either source already carried (round 2's fix).
    expect(ghost!.className).toContain("border-dashed");
    expect(ghost!.className).toMatch(/\bring-ring\b/);
    expect(ghost!.className).toMatch(/\bring-1\b/);
    expect(ghost!.className).not.toMatch(/\bshadow/);
    expect(ghost!.className).not.toMatch(/\bdark:/);

    await keydown(bar, { key: "Escape" });
    expect(ghostEl()).toBeNull();
  });

  it("a pointer-owned ghost (the identical shape gantt-dnd.tsx's applyProposal produces, source: 'pointer') renders with NO data-adjust-ghost and NO ring-ring treatment", async () => {
    const event: GanttEvent = { id: "ptr-ghost", title: "Pointer Ghost", start: START, end: END, resourceId: "r1" };
    const internalsRef: { current: GanttInternals | null } = { current: null };
    await render(
      <Gantt resources={RESOURCES} events={[event]} date={START} scale="day" timeZone="UTC">
        <InternalsProbe internalsRef={internalsRef} />
        <GanttView />
      </Gantt>,
    );
    expect(ghostEl()).toBeNull();

    await act(async () => {
      internalsRef.current!.setDrag({
        kind: "move",
        occurrence: {
          key: `ptr-ghost::${START.toISOString()}`,
          eventId: "ptr-ghost",
          event,
          start: START,
          end: END,
          allDay: false,
          isRecurring: false,
        },
        proposedStart: new Date(START.getTime() + 15 * 60000),
        proposedEnd: new Date(END.getTime() + 15 * 60000),
        proposedAllDay: false,
        proposedResourceId: "r1",
        valid: true,
        source: "pointer",
      });
      await Promise.resolve();
    });

    const ghost = ghostEl();
    expect(ghost).not.toBeNull();
    expect(ghost!.getAttribute("data-kind")).toBe("move");
    expect(ghost!.hasAttribute("data-adjust-ghost")).toBe(false);
    // Same dashed-hairline border either way, but round 3 (Sol MEDIUM #6) adds the ring ONLY for
    // the keyboard-sourced ghost above - this is the class/marker-set difference that fix asserts.
    expect(ghost!.className).toContain("border-dashed");
    expect(ghost!.className).not.toMatch(/\bring-ring\b/);
  });
});
