/**
 * #219 PR A fix (dr-219a HIGH #1 / luna-219a #9) — a refused POINTER drop announced nothing.
 * `gantt-dnd.tsx`'s `onPointerUp` used to write to `[data-slot=gantt-announcer]` only on
 * `accepted`; a drop refused by the overlap policy, an enforced `canDropEvent`, or `onEventUpdate`
 * released the pointer, reverted the ghost, and told a screen-reader user nothing, while the
 * keyboard path (`gantt-bar.tsx`'s Adjust `stepAdjust`/commit) already announced one of three
 * reasons. `keyboardNudgeLocked`/`Invalid`/`Rejected` are renamed here to `changeBlockedLocked`/
 * `Invalid`/`Rejected` (string VALUES unchanged — only the label keys move) since both the pointer
 * and keyboard paths now share them; see `gantt-i18n.tsx`'s header for the full rename note.
 *
 * Design choice (not decided by the spec, recorded here): the pointer release path can only ever
 * reach the "rejected" bucket. A locked bar (`readOnly`/`draggable: false`/a locked resize edge)
 * never starts a pointer gesture in the first place (`gantt-dnd.tsx`'s `canResize`/`canMove` gate
 * the listeners themselves, before any drop), and `computeProposal`'s clamping means a pointer drag
 * can never produce the inverted/zero-duration proposal that earns "invalid" on the keyboard path.
 * So every reachable pointer refusal (`overlapRejected`, an enforced `canDropEvent` veto, or
 * `onEventUpdate` returning `false`) announces `changeBlockedRejected` — the same bucket
 * `nudgeEvent`'s identical three refusal sources collapse to (`gantt.tsx`'s `proposeNudge`,
 * confirmed against `gantt-nudge-event.dom.test.tsx`'s own `{ applied: false, reason: "rejected" }`
 * assertions). The pointer path still routes through a `reason`-typed helper (not a single hardcoded
 * string) so `locked`/`invalid` are wired for the day a future refusal source reaches them, but no
 * such source exists today.
 */
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gantt, useGantt, useGanttSelector, type GanttApi, type GanttInternals } from "@/components/reui/gantt/gantt";
import { GanttBar } from "@/components/reui/gantt/gantt-bar";
import type { GanttEvent, GanttOccurrence, GanttProposedUpdate, GanttSegment } from "@/components/reui/gantt/gantt-types";

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

/** Same minimal geometry harness as `gantt-adjust-pointer-ownership.dom.test.tsx` — see that
 * file's own doc comment on the 1px = 1 minute axis mock. */
function GeometryHost({ eventId }: { eventId: string }) {
  const instance = useGantt();
  const occurrence = useGanttSelector(
    () => instance.api.getOccurrences().find((occ) => occ.eventId === eventId) ?? null,
  );
  const axisRef = (el: HTMLDivElement | null) => {
    if (!el) return;
    el.getBoundingClientRect = () =>
      ({ left: 0, right: 1440, width: 1440, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  };
  if (!occurrence) return null;
  const segment: GanttSegment = {
    occurrence,
    day: occurrence.start,
    isStart: true,
    isEnd: true,
    continuesBefore: false,
    continuesAfter: false,
  };
  return (
    <div data-slot="gantt">
      <div data-slot="gantt-announcer" aria-live="polite" />
      <div data-slot="gantt-view">
        <div
          ref={axisRef}
          data-gantt-axis=""
          data-gantt-range-start={START.getTime()}
          data-gantt-range-end={START.getTime() + 1440 * 60000}
          data-gantt-snap={15}
        />
        <div data-gantt-row="" data-gantt-resource="r1">
          <div key={occurrence.key}>
            <GanttBar segment={segment} />
          </div>
        </div>
      </div>
    </div>
  );
}

function InternalsProbe({
  internalsRef,
  apiRef,
}: {
  internalsRef: { current: GanttInternals | null };
  apiRef: { current: GanttApi | null };
}) {
  const instance = useGantt();
  useEffect(() => {
    internalsRef.current = instance.internals;
    apiRef.current = instance.api;
  });
  return null;
}

function findBar(title: string): HTMLButtonElement {
  const bar = [...host.querySelectorAll("button")].find((el) => el.textContent?.includes(title));
  if (!bar) throw new Error(`no bar found for title ${title}`);
  return bar;
}

function announcerText(): string | null {
  return host.querySelector<HTMLElement>('[aria-live="polite"]')?.textContent ?? null;
}

/** Same live-region write counter as `gantt-adjust-session-ownership.dom.test.tsx`'s
 * `watchAnnouncerWrites` — an own accessor on the announcer INSTANCE that counts every
 * `textContent =` assignment, so "announces exactly once" cannot pass on a duplicate write of the
 * identical string. */
function findAccessorDescriptor(obj: object, prop: string): PropertyDescriptor {
  let cursor: object | null = obj;
  while (cursor) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, prop);
    if (descriptor) return descriptor;
    cursor = Object.getPrototypeOf(cursor);
  }
  throw new Error(`no "${prop}" descriptor found on the prototype chain`);
}

function watchAnnouncerWrites(): { count: () => number } {
  const announcer = host.querySelector<HTMLElement>("[data-slot=gantt-announcer]")!;
  const original = findAccessorDescriptor(announcer, "textContent");
  let writes = 0;
  Object.defineProperty(announcer, "textContent", {
    configurable: true,
    get() {
      return original.get!.call(announcer);
    },
    set(value: string) {
      writes++;
      original.set!.call(announcer, value);
    },
  });
  return { count: () => writes };
}

/** Drags the given bar by dispatching a real pointerdown/pointermove(activate)/pointerup
 * sequence far enough to clear the 5px activation threshold, then releases. */
async function dragBar(bar: HTMLButtonElement, pointerId: number, fromX: number, toX: number) {
  await pointerEvent(bar, "pointerdown", { pointerId, button: 0, clientX: fromX, clientY: 10 });
  await pointerEvent(window, "pointermove", { pointerId, clientX: toX, clientY: 10 });
  await pointerEvent(window, "pointerup", { pointerId, clientX: toX, clientY: 10 });
}

describe("a refused pointer drop announces (dr-219a HIGH #1)", () => {
  it("an enforced canDropEvent veto announces changeBlockedRejected and never calls onEventUpdate", async () => {
    const onEventUpdate = vi.fn((_u: GanttProposedUpdate) => true);
    const onEventsChange = vi.fn();
    const canDropEvent = vi.fn(() => false);
    const event: GanttEvent = { id: "enforced", title: "Enforced", start: START, end: END };
    await render(
      <Gantt
        events={[event]}
        onEventUpdate={onEventUpdate}
        onEventsChange={onEventsChange}
        canDropEvent={canDropEvent}
        enforceCanDrop
        date={START}
        timeZone="UTC"
      >
        <GeometryHost eventId="enforced" />
      </Gantt>,
    );
    const bar = findBar("Enforced");
    const writes = watchAnnouncerWrites();

    await dragBar(bar, 11, 100, 300);

    expect(onEventUpdate).not.toHaveBeenCalled();
    expect(onEventsChange).not.toHaveBeenCalled();
    expect(announcerText()).toBe("That change was rejected.");
    expect(writes.count()).toBe(1);
  });

  it("onEventUpdate returning false announces changeBlockedRejected; onEventUpdate itself is still called once", async () => {
    const onEventUpdate = vi.fn((_u: GanttProposedUpdate) => false);
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "consumer-refused", title: "Consumer Refused", start: START, end: END };
    await render(
      <Gantt events={[event]} onEventUpdate={onEventUpdate} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <GeometryHost eventId="consumer-refused" />
      </Gantt>,
    );
    const bar = findBar("Consumer Refused");
    const writes = watchAnnouncerWrites();

    await dragBar(bar, 12, 100, 300);

    expect(onEventUpdate).toHaveBeenCalledTimes(1);
    expect(onEventsChange).not.toHaveBeenCalled();
    expect(announcerText()).toBe("That change was rejected.");
    expect(writes.count()).toBe(1);
  });

  it("an accepted drop still announces the accepted range exactly once (no regression from the rename)", async () => {
    const onEventUpdate = vi.fn((_u: GanttProposedUpdate) => true);
    const onEventsChange = vi.fn();
    const event: GanttEvent = { id: "accepted", title: "Accepted", start: START, end: END };
    await render(
      <Gantt events={[event]} onEventUpdate={onEventUpdate} onEventsChange={onEventsChange} date={START} timeZone="UTC">
        <GeometryHost eventId="accepted" />
      </Gantt>,
    );
    const bar = findBar("Accepted");
    const writes = watchAnnouncerWrites();

    await dragBar(bar, 13, 100, 300);

    expect(onEventUpdate).toHaveBeenCalledTimes(1);
    expect(onEventsChange).toHaveBeenCalledTimes(1);
    expect(announcerText()).not.toBeNull();
    expect(announcerText()).not.toBe("That change was rejected.");
    expect(writes.count()).toBe(1);
  });
});

describe("the renamed labels (changeBlockedLocked/Invalid/Rejected) are wired through, string values unchanged", () => {
  it("gantt-i18n's DEFAULT_GANTT_I18N no longer exposes keyboardNudge*, and exposes changeBlocked* with the same strings", async () => {
    const { DEFAULT_GANTT_I18N } = await import("@/components/reui/gantt/gantt-i18n");
    const labels = DEFAULT_GANTT_I18N.labels as Record<string, unknown>;
    expect(labels.keyboardNudgeLocked).toBeUndefined();
    expect(labels.keyboardNudgeInvalid).toBeUndefined();
    expect(labels.keyboardNudgeRejected).toBeUndefined();
    expect(labels.changeBlockedLocked).toBe("That can't be changed.");
    expect(labels.changeBlockedInvalid).toBe("That change isn't possible.");
    expect(labels.changeBlockedRejected).toBe("That change was rejected.");
  });
});
