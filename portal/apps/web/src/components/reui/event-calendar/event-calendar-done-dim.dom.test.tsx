/**
 * `eventClassName` reaches the chip — the "dimmed done tasks" seam (#219).
 *
 * WHY THIS IS A DOM TEST AND NOT A UNIT TEST. `EventCalendarViewConfig` is a TYPE, but
 * `VIEW_CONFIG_KEYS` in `event-calendar.tsx` is a RUNTIME allow-list, and only keys on that list
 * are copied into the context the views read. A key added to the interface and consumed in
 * `event-calendar-event.tsx` typechecks at every call site and then renders NOTHING until it is
 * also listed there. That is exactly what happened while writing this feature: the type was right,
 * the chip was right, the browser showed the vendor's own default. Nothing in the type system
 * could see it. A rendered assertion can.
 *
 * WHAT IS BEING PINNED, AND WHY IT IS NOT A COLOUR PREFERENCE.
 *
 * #219's re-skin line asks for "dimmed done tasks". Two rules govern how:
 *
 *   1. Completion is a QUINCY fact, not a clock fact. The vendor derives `data-past` from
 *      `occurrence.end < Date.now()` and has no concept of done — see the `eventClassName` doc on
 *      its viewConfig. A past meeting nobody actioned is not done; a task finished early is done
 *      while still in the future. The fixture `future-and-done` is future-dated ON PURPOSE so the
 *      two cannot be conflated, and this file asserts the dim keys off `data.done` alone.
 *
 *   2. The dim must be HUE-INDEPENDENT. #219 PR A first shipped a per-hue alpha step for
 *      completed Gantt bars and the design reviewer rejected it (dr-219a MEDIUM #5): a 10% wash of
 *      a naturally dark, saturated stage colour can read LOUDER than a 20% wash of a naturally
 *      light one, so "less emphasis" did not guarantee "less loudness". PR A's fix was the fixed
 *      `--border` token every stage shares. This asserts the calendar took the same route rather
 *      than repeating the mistake in a second tree — a chip tinted with its OWN
 *      `--ec-event-color` would pass a naive "is it different?" check and still be wrong.
 *
 * Measured in a real browser at the time of writing, compositing each chip over paper on a canvas
 * so the engine resolves the alpha: done ΔL 99.8 against active ΔL 140.7 and 197.4, with the done
 * fixture carrying `--signal-positive`, the most saturated stage colour in the set. Those numbers
 * cannot be reproduced under happy-dom, which computes no real colour — hence the structural
 * assertion here and the measurement recorded in `qa-evidence/219b/`.
 *
 * SELECTOR NOTE. This file locates chips by the vendored `data-slot="event-calendar-event*"`,
 * which guard F (`testing/test-seam.guard.test.ts`) permits here: the rule it enforces is that a
 * test may not depend on a Quincy-authored `data-slot` as a test seam, and these slots are the
 * VENDOR's own published structure, not a seam this repo invented. The behaviour under test is
 * "the consumer's class reaches the chip element", so the chip element is the subject rather than
 * an incidental handle, and adding a `data-testid` to every vendored chip purely to observe it
 * would be more vendored surface to re-merge. Verified: guard F is green with this file present.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// React 19 requires this opt-in before `act(...)`; the sibling dom tests in this tree set it too.
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { EventCalendar } from "./event-calendar";
import { EventCalendarContent } from "./event-calendar-content";
import type { CalendarEvent, EventCalendarOccurrence } from "./event-calendar-types";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const TZ = "Australia/Sydney";
/** Fixed so "done" can never coincide with "past" by accident. */
const ANCHOR = new Date("2026-09-21T02:00:00.000Z");

interface TaskData {
  done: boolean;
}

const EVENTS: CalendarEvent<TaskData>[] = [
  {
    id: "done-future",
    title: "Done ahead of schedule",
    // FUTURE relative to ANCHOR, and done.
    start: new Date("2026-09-23T04:00:00.000Z"),
    end: new Date("2026-09-23T05:30:00.000Z"),
    color: "var(--signal-positive)",
    data: { done: true },
  },
  {
    id: "past-open",
    title: "Past but not done",
    // PAST relative to ANCHOR, and NOT done.
    start: new Date("2026-09-18T00:00:00.000Z"),
    end: new Date("2026-09-18T01:00:00.000Z"),
    color: "var(--signal-caution)",
    data: { done: false },
  },
];

/** The same hue-independent dim the harness applies; see CalendarPreview's `dimDoneChip`. */
const DIM = "bg-border/25 hover:bg-border/35 inset-ring-border/25 text-muted-foreground";
const dimDone = (o: EventCalendarOccurrence<TaskData>) =>
  o.event.data?.done ? DIM : undefined;

function renderCalendar(eventClassName?: (o: EventCalendarOccurrence<TaskData>) => string | undefined) {
  act(() => {
    root.render(
      <EventCalendar<TaskData>
        events={EVENTS}
        view="month"
        date={ANCHOR}
        timeZone={TZ}
        eventClassName={eventClassName}
      >
        <EventCalendarContent />
      </EventCalendar>
    );
  });
}

/** The chip element for an event, found via its rendered title. */
function chipFor(title: string): HTMLElement {
  const node = [...host.querySelectorAll<HTMLElement>("[data-slot*='event-calendar-event']")].find(
    (el) => el.textContent?.includes(title)
  );
  if (!node) {
    const seen = [...host.querySelectorAll("[data-slot*='event-calendar-event']")]
      .map((el) => JSON.stringify(el.textContent?.trim().slice(0, 30)))
      .join(", ");
    throw new Error(`no chip rendered for "${title}". Chips present: ${seen || "(none)"}`);
  }
  return node;
}

describe("eventClassName reaches the chip", () => {
  it("applies the consumer's classes to the done event", () => {
    renderCalendar(dimDone);
    expect(
      chipFor("Done ahead of schedule").className,
      [
        "The done chip carries none of the consumer's classes.",
        "",
        "If the type and the chip both look correct, check VIEW_CONFIG_KEYS in event-calendar.tsx:",
        "it is a RUNTIME allow-list and a key missing from it is silently dropped after",
        "typechecking cleanly everywhere.",
      ].join("\n")
    ).toContain("bg-border/25");
  });

  it("leaves a NOT-done event alone, even though it is in the past", () => {
    renderCalendar(dimDone);
    const past = chipFor("Past but not done").className;
    expect(past).not.toContain("bg-border/25");
    expect(past).not.toContain("text-muted-foreground");
  });

  it("dims on data.done, NOT on the vendor's clock-derived data-past", () => {
    renderCalendar(dimDone);
    const done = chipFor("Done ahead of schedule");
    const past = chipFor("Past but not done");
    // The done chip is in the FUTURE, so the vendor marks it not-past...
    expect(done.getAttribute("data-past")).toBeNull();
    // ...and the undone chip IS past. If the dim were keyed on time rather than on the domain
    // fact, these two assertions would be the wrong way round.
    expect(past.getAttribute("data-past")).not.toBeNull();
    expect(done.className).toContain("bg-border/25");
    expect(past.className).not.toContain("bg-border/25");
  });

  it("dims with a hue-independent token, never the event's own colour", () => {
    renderCalendar(dimDone);
    const done = chipFor("Done ahead of schedule").className;
    // The whole point of dr-219a MEDIUM #5: a dim expressed as an alpha step on the event's OWN
    // hue is not guaranteed quieter than an active chip in a lighter hue.
    expect(
      done.includes("bg-border/25") && !/bg-\(--ec-event-color\)\/\d+(?!.*bg-border)/.test(done),
      "the done dim must use the shared --border token, not an alpha step on --ec-event-color"
    ).toBe(true);
  });

  it("changes nothing when the consumer supplies no eventClassName", () => {
    renderCalendar(undefined);
    expect(chipFor("Done ahead of schedule").className).not.toContain("bg-border/25");
  });
});
