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
 * Round 3 (Sol MEDIUM #6) added a solid `ring-ring ring-1` hairline for the keyboard-sourced ghost
 * only, layered on the dashed border every ghost already carried. Round 4 (dr-219a HIGH #4, the
 * fix-219a-skin.md spec) REMOVES that ring: a solid full-ink ring buried the dashed border
 * underneath it instead of merely accenting it. This round makes two changes instead:
 *
 * 1. `gantt-bar.tsx`'s `data-[drag-kind=move]:opacity-0` — which hid the ORIGIN bar completely
 *    for a move, keyboard or pointer alike — now only hides it for a pointer-sourced move
 *    (`data-[drag-source=pointer]`); a keyboard-sourced move instead keeps the bar visible at
 *    `opacity-40`, the same treatment a resize already got either way. A pointer move still has
 *    the smooth cursor clone (`gantt-dnd.tsx`) standing in for the origin, so hiding it there is
 *    still correct; a keyboard move has no clone, and DOM focus never leaves this exact bar, so
 *    hiding it left Adjust mode with nothing focused-and-visible on screen.
 * 2. The ghost itself now renders its event TITLE for a move, not just a resize (dr-219a HIGH #4,
 *    part 3) — previously a move-kind ghost rendered no label at all because the pointer path's
 *    cursor clone carried it; a keyboard move has no clone, so its ghost was the only on-screen
 *    representation of the move and had no name on it.
 *
 * Chosen distinguishing device (dr-219a HIGH #4, part 2's "if that leaves the keyboard ghost
 * indistinguishable from the pointer ghost, distinguish it some other way" — recorded here since
 * the spec asked to say what was chosen): NONE beyond what (1) and (2) already produce as a side
 * effect, because a keyboard-owned and a pointer-owned ghost can never be on screen at the same
 * time to confuse (`gantt.tsx`'s `beginAdjust` refuses outright while ANY pointer gesture anywhere
 * on the page is pending/active, via `isGanttGestureInFlight`; `gantt-dnd.tsx`'s `beginGesture`
 * cancels an active Adjust session on the same occurrence before a gesture starts - the two inputs
 * are structurally, globally mutually exclusive). A move-kind ghost showing a title now IS already
 * a real, if incidental, difference from a pointer move's titleless ghost (whose cursor clone shows
 * the title instead) - no extra marker is layered on top of it. `data-adjust-ghost` stays as a
 * data-only hook (no visual treatment of its own); the shared dashed border is the whole "this is a
 * preview" cue for both sources, exactly as dr-219a HIGH #4 asked ("let the dashed border carry the
 * keyboard cue").
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
 * narrower and different: given a `state.drag` of each source, does the RENDERED ghost (and its
 * origin bar) reflect it.
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
  // dr2-219a HIGH #2: `barLabel="auto"` moves a narrow bar's own title OUTSIDE the button (a
  // sibling span, not inside its textContent) - `aria-label` always leads with the raw event
  // title regardless of where the VISUAL label lands (`gantt-i18n.tsx`'s own
  // `formatEventAriaLabel`), so it is the placement-independent match.
  const bar = [...host.querySelectorAll("button")].find(
    (el) => el.textContent?.includes(title) || el.getAttribute("aria-label")?.includes(title),
  );
  if (!bar) throw new Error(`no bar found for title ${title}`);
  return bar as HTMLButtonElement;
}

function ghostEl(): HTMLElement | null {
  // Guard F (`test-seam.guard.test.ts`, issue #92) forbids selecting on the vendor's own
  // `data-slot="gantt-drag-ghost"` - `gantt-view.tsx` carries a `data-testid` alongside it for
  // exactly this, the same pattern `gantt-bar-resize-grips.dom.test.tsx` already uses.
  return host.querySelector<HTMLElement>('[data-testid="gantt-drag-ghost"]');
}

/**
 * #219 PR A fix (dr2-219a HIGH #1) — the class-string assertions below (`bar.className.toContain(…)`)
 * prove what rule is WRITTEN on the origin bar, not what a sighted user actually sees. The bar
 * renders inside `gantt-view.tsx`'s own per-segment wrapper `<div>`, a SEPARATE element in the same
 * ancestor chain that carried its own unconditional `data-[drag-kind=move]:opacity-0` — so a keyboard
 * move's bar-level `opacity-40` composited against a wrapper-level `opacity-0` painted at exactly
 * ZERO (CSS opacity is not inherited — a descendant's own opacity multiplies against whatever its
 * ancestors already composited, it never overrides it). A class-string assertion on the bar ALONE
 * cannot see that; `dr2-219a-report.md` HIGH #1 measured the painted result pixel-identical to an
 * empty grid cell. `effectiveOpacity` below answers the question a browser would instead: this suite
 * runs happy-dom with no CSS pipeline (`vitest.dom.config.ts` loads no stylesheet), so
 * `getComputedStyle` cannot see Tailwind's generated rules either — the only source of truth left is
 * the same class-string + data-attribute pairing a real cascade would resolve, walked one ancestor at
 * a time and multiplied. Deliberately narrow: it only models a bare `opacity-N` utility optionally
 * gated behind one or more chained `data-[attr=value]:` variants (AND-ed together, highest
 * attribute-count wins on a tie — the same "two-attribute selector beats one" specificity rule
 * `gantt-bar.tsx`'s own header documents for `data-completed:data-selected:`), because that is
 * EXACTLY the vocabulary every drag-state opacity rule in this ancestor chain uses; a general CSS
 * cascade engine is out of scope for a fixture this narrow. A modifier this helper does not model
 * (`hover:`, `group-data-…`, …) is conservatively treated as inactive, so it can never masquerade as
 * a rule this test verified.
 */
function elementOwnOpacity(el: Element): number {
  const ATTR_MODIFIER = /^data-\[([a-z-]+)=([a-z0-9-]+)\]$/;
  let winner: { opacity: number; specificity: number } | null = null;
  for (const token of el.className.split(/\s+/).filter(Boolean)) {
    const parts = token.split(":");
    const opacityMatch = /^opacity-(\d{1,3})$/.exec(parts[parts.length - 1]!);
    if (!opacityMatch) continue;
    const modifiers = parts.slice(0, -1);
    let active = true;
    for (const modifier of modifiers) {
      const match = ATTR_MODIFIER.exec(modifier);
      if (!match || el.getAttribute(`data-${match[1]}`) !== match[2]) {
        active = false;
        break;
      }
    }
    if (!active) continue;
    const specificity = modifiers.length;
    if (!winner || specificity >= winner.specificity) {
      winner = { opacity: Number(opacityMatch[1]) / 100, specificity };
    }
  }
  return winner ? winner.opacity : 1;
}

/**
 * Multiplies `elementOwnOpacity` from `start` up through every ancestor, `root` included — real CSS
 * compositing, not a single element's own rule. `root` is `host` itself (the test's own render
 * container), not a `[data-slot="gantt"]` lookup — Guard F forbids selecting on that vendor slot, and
 * nothing between the real `<Gantt>` root and `host` carries an opacity rule of its own, so walking
 * the extra step is inert.
 */
function effectiveOpacity(start: Element, root: Element): number {
  let node: Element | null = start;
  let product = 1;
  while (node) {
    product *= elementOwnOpacity(node);
    if (node === root) break;
    node = node.parentElement;
  }
  return product;
}

describe("the drag ghost carries data-adjust-ghost for a keyboard Adjust session, not a pointer drag, and (round 4) the origin bar stays visible-and-faded for a keyboard move while the ghost gets a title (#219 PR A, dr-219a HIGH #4)", () => {
  it("a real Adjust session (Space, then ArrowRight) renders a titled ghost with data-adjust-ghost, no ring, and keeps the origin bar visible at reduced opacity", async () => {
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
    expect(ghost!.className).toContain("border-dashed");
    // Round 4 (dr-219a HIGH #4, part 2): the round-3 ring is gone - it buried the dashed border
    // instead of accenting it. No replacement ring, keyboard or pointer.
    expect(ghost!.className).not.toMatch(/\bring-ring\b/);
    expect(ghost!.className).not.toMatch(/\bshadow/);
    expect(ghost!.className).not.toMatch(/\bdark:/);
    // Round 4 (dr-219a HIGH #4, part 3): a move-kind ghost now renders its event title - a
    // keyboard move has no cursor clone to carry it, unlike a pointer move.
    expect(ghost!.textContent).toContain("Ghost Me");
    // dr2-219a HIGH #2: `<Gantt>`'s own default is `barLabel: "inside"` (`gantt.tsx`), under which
    // EVERY bar's title sits inside regardless of width (`wantsOutside` only fires for
    // `barLabel: "outside"`/`"auto"`) - so under this suite's default config the ghost's title must
    // match every resting bar and sit inside too, not ride outside unconditionally the way the
    // pre-fix code did (see the dedicated `barLabel="auto"` tests below for the width-driven case).
    const titleSpan = ghost!.querySelector("span");
    expect(titleSpan?.textContent).toBe("Ghost Me");
    expect(titleSpan?.className).toContain("inset-0");
    expect(titleSpan?.className).not.toContain("start-full");

    // Round 4 (dr-219a HIGH #4, part 1): the origin bar stays visible at reduced opacity for a
    // KEYBOARD move (same occurrence.key, so still the same DOM node - no remount before commit).
    const stillTheBar = findBar("Ghost Me");
    expect(stillTheBar).toBe(bar);
    expect(bar.getAttribute("data-drag-kind")).toBe("move");
    expect(bar.getAttribute("data-drag-source")).toBe("keyboard");
    expect(bar.className).toContain("data-[drag-kind=move]:data-[drag-source=keyboard]:opacity-40");
    expect(bar.className).not.toContain("data-[drag-kind=move]:opacity-0");
    // dr2-219a HIGH #1: the class strings above are necessary but not sufficient - prove the
    // COMPOSITED result through the wrapper ancestor is actually visible, not zeroed out by a
    // sibling rule the bar's own class string says nothing about.
    expect(effectiveOpacity(bar, host)).toBeGreaterThan(0);

    await keydown(bar, { key: "Escape" });
    expect(ghostEl()).toBeNull();
  });

  it("a pointer-owned ghost (the identical shape gantt-dnd.tsx's applyProposal produces, source: 'pointer') renders with NO data-adjust-ghost, NO ring, NO title, and hides the origin bar entirely", async () => {
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
    expect(ghost!.className).toContain("border-dashed");
    expect(ghost!.className).not.toMatch(/\bring-ring\b/);
    // A pointer move's cursor clone carries the title, not the ghost - unlike the keyboard case
    // above, this ghost stays titleless.
    expect(ghost!.textContent).not.toContain("Pointer Ghost");

    // Round 4 (dr-219a HIGH #4, part 1): a POINTER move still hides the origin bar entirely - only
    // the keyboard path (above) changed.
    const bar = findBar("Pointer Ghost");
    expect(bar.getAttribute("data-drag-kind")).toBe("move");
    expect(bar.getAttribute("data-drag-source")).toBe("pointer");
    expect(bar.className).toContain("data-[drag-kind=move]:data-[drag-source=pointer]:opacity-0");
    // dr2-219a HIGH #1: a pointer-owned move must still composite to fully invisible - the cursor
    // clone carries the visual, so the origin bar staying hidden here is the correct outcome.
    expect(effectiveOpacity(bar, host)).toBe(0);
  });
});

describe("dr2-219a HIGH #2: the Adjust ghost's title follows the SAME width-driven inside/outside rule a resting bar's own label already uses (barLabel=\"auto\"), instead of always riding outside unconditionally", () => {
  it("sits INSIDE the ghost's own box when the ghost is wide enough to hold it", async () => {
    // 4 hours: (240/60)*5 = 20rem of ghostRemWidth at this suite's default metrics (interval 60,
    // unitWidthRem 5, zoom 1), well over the 7rem auto-label floor - the same rule a resting
    // segment's own `wantsOutside` already uses.
    const wideEnd = new Date(START.getTime() + 4 * 60 * 60000);
    const event: GanttEvent = { id: "wide-ghost", title: "Wide Ghost Title", start: START, end: wideEnd, resourceId: "r1" };
    await render(
      <Gantt resources={RESOURCES} events={[event]} date={START} scale="day" timeZone="UTC" barLabel="auto">
        <GanttView />
      </Gantt>,
    );

    const bar = findBar("Wide Ghost Title");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });

    const ghost = ghostEl();
    expect(ghost).not.toBeNull();
    const titleSpan = ghost!.querySelector("span");
    expect(titleSpan?.textContent).toBe("Wide Ghost Title");
    expect(titleSpan?.className).toContain("inset-0");
    expect(titleSpan?.className).not.toContain("start-full");
    expect(titleSpan?.className).not.toContain("bg-foreground");
  });

  it("sits OUTSIDE on an opaque bg-foreground/text-background chip - not bare text - when the ghost is too narrow to hold it", async () => {
    // 15 minutes: (15/60)*5 = 1.25rem, well under the 7rem floor.
    const narrowEnd = new Date(START.getTime() + 15 * 60000);
    const event: GanttEvent = { id: "narrow-ghost", title: "Narrow Ghost Title", start: START, end: narrowEnd, resourceId: "r1" };
    await render(
      <Gantt resources={RESOURCES} events={[event]} date={START} scale="day" timeZone="UTC" barLabel="auto">
        <GanttView />
      </Gantt>,
    );

    const bar = findBar("Narrow Ghost Title");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });

    const ghost = ghostEl();
    expect(ghost).not.toBeNull();
    const titleSpan = ghost!.querySelector("span");
    expect(titleSpan?.textContent).toBe("Narrow Ghost Title");
    expect(titleSpan?.className).not.toContain("inset-0");
    // dr2-219a HIGH #2: the pre-fix outside title had no background at all and ran straight over
    // whatever sat beside the ghost (dr2-219a-report.md measured it crossing both the neighbouring
    // bar and the now-line). It now carries the same opaque chip treatment `gantt-dnd.tsx`'s
    // resize-status chip and this file's own create-task draft label already use.
    expect(titleSpan?.className).toContain("bg-foreground");
    expect(titleSpan?.className).toContain("text-background");
  });
});

describe("dr3-219a MEDIUM #1: the INSIDE ghost title's truncating element is a CHILD of the flex/positioning box, not the box itself - `truncate` on a `display:flex` container does nothing (`text-overflow` does not apply to a flex container's own anonymous item), mirroring `gantt-bar.tsx:532`'s child-span pattern", () => {
  it("the element carrying `truncate` is NOT the flex container that carries `inset-0`/`flex` - it is a non-flex child of it", async () => {
    // Default (no barLabel="auto") config, same as the top "real Adjust session" test above: the
    // title always renders INSIDE (`gantt.tsx`'s own default is `barLabel: "inside"`), so this
    // exercises the exact box the MEDIUM defect lives in regardless of ghost width.
    const event: GanttEvent = {
      id: "clip-ghost",
      title: "A Title Far Too Long To Fit This Narrow Ghost Box",
      start: START,
      end: END,
      resourceId: "r1",
    };
    await render(
      <Gantt resources={RESOURCES} events={[event]} date={START} scale="day" timeZone="UTC">
        <GanttView />
      </Gantt>,
    );

    const bar = findBar("A Title Far Too Long To Fit This Narrow Ghost Box");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });

    const ghost = ghostEl();
    expect(ghost).not.toBeNull();

    const flexBox = ghost!.querySelector("span");
    expect(flexBox).not.toBeNull();
    expect(flexBox!.className).toContain("inset-0");
    expect(flexBox!.className).toMatch(/\bflex\b/);

    // Test-seam guard A (issue #50) forbids selecting an element by CSS class, so this walks the
    // tag structure instead of reaching for `.truncate` directly: BEFORE the fix, the flex box had
    // no element child at all (the title was its only, bare text node), so this would have
    // returned null and the fallback would read the bug's own home, `flexBox` itself - HEAD's own
    // shape (below) always has the inner span, so the fallback is a regression guard, not the path
    // this assertion actually exercises today.
    const truncateEl = flexBox!.querySelector("span") ?? flexBox;
    expect(truncateEl!.textContent).toBe("A Title Far Too Long To Fit This Narrow Ghost Box");
    // The bug this guards against: the SAME element carrying both `flex`/`inset-0` AND `truncate` -
    // a `display:flex` container's own `text-overflow` never applies to its anonymous box, so the
    // class does nothing and the text clips mid-glyph with no ellipsis instead. HEAD fixed this by
    // moving `truncate` onto a non-flex CHILD span of the flex/positioning box, exactly the way
    // `gantt-bar.tsx:532`'s resting-bar label already does it - these assertions prove that shape
    // holds, not that the bug is present.
    expect(truncateEl).not.toBe(flexBox);
    expect(truncateEl!.className).toContain("truncate");
    expect(truncateEl!.className).not.toMatch(/\bflex\b/);
    expect(truncateEl!.className).not.toContain("inset-0");
  });
});
