/**
 * #221 PR A — the two additive vendor seams a subtask's "outside shoot..deadline" drop needs:
 *
 * 1. `dropWarning(update) => string | null` — a reason-bearing ADVISORY verdict for an ALLOWED
 *    drop. Never blocks, never touches `valid`/`enforceCanDrop`; only consulted when the proposal is
 *    already valid (invalid wins). It drives the ghost's `data-drop-warning` caution styling, a
 *    reason hint inside the cursor-following move clone / resize chip, and a warning suffix on the
 *    accepted release / Adjust step / Adjust commit announcement.
 * 2. `onEventUpdate` returning `"deferred"` — accept-and-defer: the consumer took the proposal and
 *    owns what happens next (e.g. a confirmation dialog). The Gantt neither mutates `events` nor
 *    announces anything — distinct from `false`, which reverts AND announces "That change was
 *    rejected." for a drop the consumer actually accepted.
 *
 * Pointer cases render the REAL `<GanttView>` (the ghost only exists inside it) and stub
 * `Element.prototype.getBoundingClientRect` right before the gesture: happy-dom lays nothing out, so
 * the axis/row/bar rects are all zero by default, which leaves `surfaceMinutesAt` dividing by a
 * zero width and `createMoveOverlay` refusing to mount for a zero-width bar. One 1440x40 rect for
 * every element is enough geometry for a gesture: the axis maps 1440px across its own range, the
 * single row contains y=10, and the bar has a non-zero width. Restored after each test.
 *
 * `getAnimations` polyfill: same reason as `gantt-adjust-ghost-marker.dom.test.tsx`'s own header -
 * `<GanttView>`'s ScrollArea calls it from a timer happy-dom does not implement.
 *
 * Guard F (`test-seam.guard.test.ts`): nothing here selects on a vendor `data-slot` - the ghost,
 * the hint and the resize grip are reached through their `data-testid`s, the announcer through its
 * `aria-live` attribute.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gantt, useGantt, type GanttApi, type GanttInternals } from "@/components/reui/gantt/gantt";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import type {
  GanttEvent,
  GanttProposedUpdate,
  GanttResource,
  GanttUpdateResult,
} from "@/components/reui/gantt/gantt-types";

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

async function pointerEvent(target: EventTarget, type: string, init: PointerEventInit) {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

async function keydown(el: EventTarget, init: KeyboardEventInit) {
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
  vi.restoreAllMocks();
});

const START = new Date("2026-03-02T09:00:00.000Z");
const END = new Date("2026-03-02T10:00:00.000Z"); // 1 hour
const RESOURCES: GanttResource[] = [{ id: "r1", title: "Row 1" }];
const WARNING = "Ends after the deadline";

function stubGeometry() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({ left: 0, right: 1440, width: 1440, top: 0, bottom: 40, height: 40, x: 0, y: 0, toJSON() {} }) as DOMRect,
  );
}

function Probe({
  internalsRef,
  apiRef,
}: {
  internalsRef?: { current: GanttInternals | null };
  apiRef?: { current: GanttApi | null };
}) {
  const instance = useGantt();
  useEffect(() => {
    if (internalsRef) internalsRef.current = instance.internals;
    if (apiRef) apiRef.current = instance.api;
  });
  return null;
}

function findBar(title: string): HTMLButtonElement {
  const bar = [...host.querySelectorAll("button")].find(
    (el) => el.textContent?.includes(title) || el.getAttribute("aria-label")?.includes(title),
  );
  if (!bar) throw new Error(`no bar found for title ${title}`);
  return bar as HTMLButtonElement;
}

const ghostEl = () => host.querySelector<HTMLElement>('[data-testid="gantt-drag-ghost"]');
const hintEl = () => document.body.querySelector<HTMLElement>('[data-testid="gantt-drop-warning-hint"]');
const announcerText = () => host.querySelector<HTMLElement>('[aria-live="polite"]')?.textContent ?? null;

/** Counts every `textContent =` write on the announcer instance (same technique as
 * `gantt-dnd-refusal-announce.dom.test.tsx`), so "announced nothing" cannot pass on a write of the
 * identical string. */
function watchAnnouncerWrites(): { count: () => number } {
  const announcer = host.querySelector<HTMLElement>('[aria-live="polite"]')!;
  let cursor: object | null = announcer;
  let original: PropertyDescriptor | undefined;
  while (cursor && !original) {
    original = Object.getOwnPropertyDescriptor(cursor, "textContent");
    cursor = Object.getPrototypeOf(cursor);
  }
  let writes = 0;
  Object.defineProperty(announcer, "textContent", {
    configurable: true,
    get() {
      return original!.get!.call(announcer);
    },
    set(value: string) {
      writes++;
      original!.set!.call(announcer, value);
    },
  });
  return { count: () => writes };
}

function renderGantt(props: {
  event: GanttEvent;
  onEventUpdate?: (u: GanttProposedUpdate) => GanttUpdateResult;
  onEventsChange?: (events: GanttEvent[]) => void;
  canDropEvent?: (u: GanttProposedUpdate) => boolean;
  dropWarning?: (u: GanttProposedUpdate) => string | null;
  internalsRef?: { current: GanttInternals | null };
  apiRef?: { current: GanttApi | null };
}) {
  return render(
    <Gantt
      resources={RESOURCES}
      events={[props.event]}
      onEventUpdate={props.onEventUpdate}
      onEventsChange={props.onEventsChange}
      canDropEvent={props.canDropEvent}
      dropWarning={props.dropWarning}
      date={START}
      scale="day"
      timeZone="UTC"
    >
      <Probe internalsRef={props.internalsRef} apiRef={props.apiRef} />
      <GanttView />
    </Gantt>,
  );
}

async function pointerMove(bar: HTMLElement, pointerId: number, fromX: number, toX: number) {
  stubGeometry();
  await pointerEvent(bar, "pointerdown", { pointerId, button: 0, clientX: fromX, clientY: 10 });
  await pointerEvent(window, "pointermove", { pointerId, clientX: toX, clientY: 10 });
}

async function pointerRelease(pointerId: number, x: number) {
  await pointerEvent(window, "pointerup", { pointerId, clientX: x, clientY: 10 });
}

describe("dropWarning - pointer gestures (#221 PR A)", () => {
  it("a warned move: ghost carries data-drop-warning (not data-drop-invalid); the clone's hint shows the reason and is removed on release", async () => {
    const event: GanttEvent = { id: "w-move", title: "Warn Move", start: START, end: END, resourceId: "r1" };
    await renderGantt({ event, dropWarning: () => WARNING });
    const bar = findBar("Warn Move");

    await pointerMove(bar, 21, 100, 300);

    const ghost = ghostEl();
    expect(ghost).not.toBeNull();
    expect(ghost!.hasAttribute("data-drop-warning")).toBe(true);
    expect(ghost!.hasAttribute("data-drop-invalid")).toBe(false);
    const hint = hintEl();
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe(WARNING);
    expect(hint!.getAttribute("aria-hidden")).toBe("true");
    expect(hint!.style.display).not.toBe("none");

    await pointerRelease(21, 300);
    expect(hintEl()).toBeNull();
    expect(ghostEl()).toBeNull();
  });

  it("invalid wins: canDropEvent false too -> data-drop-invalid, no data-drop-warning, no visible hint, dropWarning ignored", async () => {
    const event: GanttEvent = { id: "w-invalid", title: "Warn Invalid", start: START, end: END, resourceId: "r1" };
    const dropWarning = vi.fn(() => WARNING);
    await renderGantt({ event, canDropEvent: () => false, dropWarning });
    const bar = findBar("Warn Invalid");

    await pointerMove(bar, 22, 100, 300);

    const ghost = ghostEl();
    expect(ghost).not.toBeNull();
    expect(ghost!.hasAttribute("data-drop-invalid")).toBe(true);
    expect(ghost!.hasAttribute("data-drop-warning")).toBe(false);
    expect(dropWarning).not.toHaveBeenCalled();
    // The hint is created lazily, on the first warning a gesture actually produces - never here.
    expect(hintEl()).toBeNull();

    await pointerRelease(22, 300);
  });

  it("a warned resize-end: the hint sits inside the resize chip with the reason; Escape removes it", async () => {
    const event: GanttEvent = { id: "w-resize", title: "Warn Resize", start: START, end: END, resourceId: "r1" };
    await renderGantt({ event, dropWarning: () => WARNING });
    const grip = host.querySelector<HTMLElement>('[data-testid="gantt-resize-handle-end"]');
    expect(grip).not.toBeNull();

    stubGeometry();
    await pointerEvent(grip!, "pointerdown", { pointerId: 23, button: 0, clientX: 300, clientY: 10 });
    await pointerEvent(window, "pointermove", { pointerId: 23, clientX: 700, clientY: 10 });

    const hint = hintEl();
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe(WARNING);
    expect(hint!.style.display).not.toBe("none");
    expect(ghostEl()!.hasAttribute("data-drop-warning")).toBe(true);

    await keydown(window, { key: "Escape" });
    expect(hintEl()).toBeNull();
  });

  it("releasing a warned drop that onEventUpdate accepts announces the accepted text plus the warning suffix", async () => {
    const event: GanttEvent = { id: "w-accept", title: "Warn Accept", start: START, end: END, resourceId: "r1" };
    const onEventUpdate = vi.fn((_u: GanttProposedUpdate) => true);
    await renderGantt({ event, onEventUpdate, dropWarning: () => WARNING });
    const bar = findBar("Warn Accept");
    const writes = watchAnnouncerWrites();

    await pointerMove(bar, 24, 100, 300);
    await pointerRelease(24, 300);

    expect(onEventUpdate).toHaveBeenCalledTimes(1);
    expect(announcerText()).toMatch(/^Warn Accept, .+ Warning: Ends after the deadline$/);
    expect(writes.count()).toBe(1);
  });

  it('onEventUpdate returning "deferred": called once with the proposal, events unchanged, nothing announced', async () => {
    const event: GanttEvent = { id: "w-defer", title: "Warn Defer", start: START, end: END, resourceId: "r1" };
    const onEventUpdate = vi.fn((_u: GanttProposedUpdate): GanttUpdateResult => "deferred");
    const apiRef: { current: GanttApi | null } = { current: null };
    await renderGantt({ event, onEventUpdate, apiRef });
    const bar = findBar("Warn Defer");
    const before = announcerText();
    const writes = watchAnnouncerWrites();

    await pointerMove(bar, 25, 100, 300);
    await pointerRelease(25, 300);

    expect(onEventUpdate).toHaveBeenCalledTimes(1);
    const update = onEventUpdate.mock.calls[0]![0];
    expect(update.event.id).toBe("w-defer");
    expect(update.source).toBe("drag");
    expect(update.start.getTime()).not.toBe(START.getTime());
    const stored = apiRef.current!.getEvent("w-defer")!;
    expect(stored.start.getTime()).toBe(START.getTime());
    expect(stored.end.getTime()).toBe(END.getTime());
    expect(announcerText()).toBe(before);
    expect(announcerText()).not.toBe("That change was rejected.");
    expect(writes.count()).toBe(0);
  });

  it("no dropWarning prop: no data-drop-warning attribute and no hint element (regression pin)", async () => {
    const event: GanttEvent = { id: "w-none", title: "No Warn", start: START, end: END, resourceId: "r1" };
    await renderGantt({ event });
    const bar = findBar("No Warn");

    await pointerMove(bar, 26, 100, 300);

    const ghost = ghostEl();
    expect(ghost).not.toBeNull();
    expect(ghost!.hasAttribute("data-drop-warning")).toBe(false);
    expect(ghost!.hasAttribute("data-drop-invalid")).toBe(false);
    expect(hintEl()).toBeNull();

    await pointerRelease(26, 300);
  });
});

describe("dropWarning / deferred - keyboard paths (#221 PR A)", () => {
  it("an Adjust step with a warning announces adjustStepped + the warning suffix; the ghost carries data-drop-warning", async () => {
    const event: GanttEvent = { id: "k-warn", title: "Key Warn", start: START, end: END, resourceId: "r1" };
    await renderGantt({ event, dropWarning: () => WARNING });
    const bar = findBar("Key Warn");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });

    expect(announcerText()).toMatch(/^Now .+\. Warning: Ends after the deadline$/);
    expect(ghostEl()!.hasAttribute("data-drop-warning")).toBe(true);
    expect(ghostEl()!.hasAttribute("data-drop-invalid")).toBe(false);
    await keydown(bar, { key: "Escape" });
  });

  it('an Adjust commit returning "deferred" announces nothing at commit and never says rejected', async () => {
    const event: GanttEvent = { id: "k-defer", title: "Key Defer", start: START, end: END, resourceId: "r1" };
    const onEventUpdate = vi.fn((_u: GanttProposedUpdate): GanttUpdateResult => "deferred");
    const apiRef: { current: GanttApi | null } = { current: null };
    await renderGantt({ event, onEventUpdate, apiRef });
    const bar = findBar("Key Defer");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    const afterStep = announcerText();
    expect(afterStep).toMatch(/^Now /);
    const writes = watchAnnouncerWrites();

    await keydown(bar, { key: "Enter" });

    expect(onEventUpdate).toHaveBeenCalledTimes(1);
    expect(writes.count()).toBe(0);
    expect(announcerText()).toBe(afterStep);
    expect(announcerText()).not.toBe("That change was rejected.");
    expect(apiRef.current!.getEvent("k-defer")!.start.getTime()).toBe(START.getTime());
  });

  it('commitAdjust returns { committed: false, deferred: true } when onEventUpdate defers', async () => {
    const event: GanttEvent = { id: "k-defer-direct", title: "Key Defer Direct", start: START, end: END, resourceId: "r1" };
    const internalsRef: { current: GanttInternals | null } = { current: null };
    const apiRef: { current: GanttApi | null } = { current: null };
    await renderGantt({ event, onEventUpdate: () => "deferred", internalsRef, apiRef });
    const occurrence = apiRef.current!.getOccurrences().find((occ) => occ.eventId === "k-defer-direct")!;

    let result: unknown;
    await act(async () => {
      expect(internalsRef.current!.beginAdjust("k-defer-direct", occurrence, "move")).toBe(true);
      expect(internalsRef.current!.stepAdjust(1, "snap").applied).toBe(true);
      result = internalsRef.current!.commitAdjust();
    });
    expect(result).toEqual({ committed: false, deferred: true });
  });

  it('nudgeEvent returns { applied: false, deferred: true } (no reason) when onEventUpdate defers', async () => {
    const event: GanttEvent = { id: "n-defer", title: "Nudge Defer", start: START, end: END, resourceId: "r1" };
    const apiRef: { current: GanttApi | null } = { current: null };
    await renderGantt({ event, onEventUpdate: () => "deferred", apiRef });

    let result: unknown;
    await act(async () => {
      result = apiRef.current!.nudgeEvent("n-defer", "move", 1);
    });
    expect(result).toEqual({ applied: false, deferred: true });
    expect(apiRef.current!.getEvent("n-defer")!.start.getTime()).toBe(START.getTime());
  });
});

describe("#221 design fixes - the source bar's own label hides while its ghost carries one", () => {
  const contentOf = (bar: HTMLElement) => bar.querySelector<HTMLElement>('[data-testid="gantt-bar-content"]');

  it("a held end-grip resize hides the source bar's content (visibility, so the box keeps its size); release restores it", async () => {
    const event: GanttEvent = { id: "p-resize", title: "Placeholder Resize", start: START, end: END, resourceId: "r1" };
    await renderGantt({ event });
    const bar = findBar("Placeholder Resize");
    expect(contentOf(bar)).not.toBeNull();
    expect(contentOf(bar)!.style.visibility).toBe("");
    const grip = host.querySelector<HTMLElement>('[data-testid="gantt-resize-handle-end"]')!;

    stubGeometry();
    await pointerEvent(grip, "pointerdown", { pointerId: 41, button: 0, clientX: 300, clientY: 10 });
    await pointerEvent(window, "pointermove", { pointerId: 41, clientX: 700, clientY: 10 });
    expect(contentOf(findBar("Placeholder Resize"))!.style.visibility).toBe("hidden");

    await pointerRelease(41, 700);
    expect(contentOf(findBar("Placeholder Resize"))!.style.visibility).toBe("");
  });

  it("a keyboard Adjust move hides the source bar's content while adjusting; Escape restores it", async () => {
    const event: GanttEvent = { id: "p-key", title: "Placeholder Key", start: START, end: END, resourceId: "r1" };
    await renderGantt({ event });
    const bar = findBar("Placeholder Key");
    await focusBar(bar);
    await keydown(bar, { key: " " });
    await keydown(bar, { key: "ArrowRight" });
    expect(contentOf(findBar("Placeholder Key"))!.style.visibility).toBe("hidden");

    await keydown(findBar("Placeholder Key"), { key: "Escape" });
    expect(contentOf(findBar("Placeholder Key"))!.style.visibility).toBe("");
  });
});

describe("#221 design fixes - the cursor-following overlays stay inside the visible timeline pane", () => {
  const PANE = { left: 600, right: 1400 };
  const rect = (left: number, right: number) =>
    ({ left, right, width: right - left, top: 0, bottom: 40, height: 40, x: left, y: 0, toJSON() {} }) as DOMRect;

  /**
   * The axis (the full scroll width) spans 0..1440 while the pane that shows it is only 600..1400
   * on screen. The pane is every ANCESTOR of the axis (the scroll viewport among them), found by
   * containment rather than by the viewport's vendor `data-slot` (Guard F). `bar`, when given,
   * gets its own rect so a grab offset can be measured.
   */
  function stubPaneGeometry(bar?: { el: Element; left: number; right: number }) {
    const axis = host.querySelector("[data-gantt-axis]");
    expect(axis).not.toBeNull();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (bar && this === bar.el) return rect(bar.left, bar.right);
      if (this !== axis && this.contains(axis)) return rect(PANE.left, PANE.right);
      return rect(0, 1440);
    });
  }

  it("the resize chip is shifted back inside the pane (8px pad) near its far edge; its arrow stays on the cursor", async () => {
    const event: GanttEvent = { id: "c-chip", title: "Chip Clamp", start: START, end: END, resourceId: "r1" };
    await renderGantt({ event, dropWarning: () => WARNING });
    const grip = host.querySelector<HTMLElement>('[data-testid="gantt-resize-handle-end"]')!;
    stubPaneGeometry();
    await pointerEvent(grip, "pointerdown", { pointerId: 51, button: 0, clientX: 700, clientY: 10 });
    await pointerEvent(window, "pointermove", { pointerId: 51, clientX: 900, clientY: 10 });
    const chip = hintEl()!.parentElement!;
    Object.defineProperty(chip, "offsetWidth", { configurable: true, value: 300 });

    await pointerEvent(window, "pointermove", { pointerId: 51, clientX: 1390, clientY: 10 });

    const overlayX = Number(/translate3d\(([-\d.]+)px/.exec(chip.parentElement!.style.transform)![1]);
    expect(overlayX).toBe(1390);
    const shift = Number.parseFloat(chip.style.left || "0");
    // The chip is centred on its own left (`-translate-x-1/2`), so its right edge is x + left + w/2.
    expect(overlayX + shift + 150).toBeLessThanOrEqual(PANE.right - 8);
    expect(overlayX + shift - 150).toBeGreaterThanOrEqual(PANE.left + 8);
    const arrow = [...chip.children].at(-2) as HTMLElement;
    expect(arrow.getAttribute("aria-hidden")).toBe("true");
    expect(arrow.style.left).toBe("290px");

    await pointerRelease(51, 1390);
  });

  it("the move clone is clipped on its inline-start side where it would pass over the resource column", async () => {
    const event: GanttEvent = { id: "c-clone", title: "Clone Clip", start: START, end: END, resourceId: "r1" };
    await renderGantt({ event });
    const bar = findBar("Clone Clip");
    stubPaneGeometry({ el: bar, left: 500, right: 900 });
    // Grabbed 300px into the bar (x 800), dragged to 750: the clone's left edge sits at 450,
    // 150px left of the pane.
    await pointerEvent(bar, "pointerdown", { pointerId: 52, button: 0, clientX: 800, clientY: 10 });
    await pointerEvent(window, "pointermove", { pointerId: 52, clientX: 750, clientY: 10 });

    const overlay = document.body.querySelector<HTMLElement>('[data-testid="gantt-drag-overlay"]');
    expect(overlay).not.toBeNull();
    const clip = /inset\(0(?:px)? 0(?:px)? 0(?:px)? ([\d.]+)px\)/.exec(overlay!.style.clipPath);
    expect(clip).not.toBeNull();
    expect(Number(clip![1])).toBeGreaterThanOrEqual(100);

    await pointerRelease(52, 750);
    expect(document.body.querySelector('[data-testid="gantt-drag-overlay"]')).toBeNull();
  });
});
