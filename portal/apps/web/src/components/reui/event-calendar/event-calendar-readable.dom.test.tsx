/**
 * #922 — two Quincy view-config keys reach the chip: `eventSize: "readable"` (14px titles, 12px times,
 * frame 3d of `design/prototypes/dashboard-views/`) and `renderAgendaEventTrailing` (the late label on
 * an agenda row, which renders the vendor's own content rather than `renderEvent`).
 *
 * A DOM test, not a unit test, for the reason `event-calendar-done-dim.dom.test.tsx` gives:
 * `VIEW_CONFIG_KEYS` in `event-calendar.tsx` is a RUNTIME allow-list, and a key declared on the type but
 * missing from it typechecks everywhere and renders nothing (docs/lessons.md, "A typed config key can be
 * silently dropped by a runtime allow-list").
 *
 * SELECTOR NOTE: chips are found by `data-ec-event-id`, the Quincy-added chip attribute (QUINCY EDIT
 * LOG #4 in `event-calendar-event.tsx`), never the vendor's own `data-slot` (guard F); the calendar
 * root is the host's only child.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { EventCalendar } from "./event-calendar";
import { EventCalendarContent } from "./event-calendar-content";
import type { CalendarEvent, CalendarView } from "./event-calendar-types";

const TZ = "Australia/Sydney";
const ANCHOR = new Date("2026-09-16T02:00:00.000Z");
const EVENTS: CalendarEvent<{ late: boolean }>[] = [
  { id: "late", title: "Retouch hero shots", start: new Date("2026-09-16T23:00:00.000Z"), end: new Date("2026-09-17T02:00:00.000Z"), color: "var(--stage-editing)", data: { late: true } },
  { id: "on-time", title: "Client revisions", start: new Date("2026-09-17T23:00:00.000Z"), end: new Date("2026-09-18T01:00:00.000Z"), color: "var(--stage-edited-review)", data: { late: false } },
];

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

function render(view: CalendarView, extra: { eventSize?: "compact" | "readable"; trailing?: boolean } = {}) {
  act(() => {
    root.render(
      <EventCalendar<{ late: boolean }>
        events={EVENTS}
        view={view}
        date={ANCHOR}
        timeZone={TZ}
        weekStartsOn={1}
        eventSize={extra.eventSize}
        renderAgendaEventTrailing={extra.trailing ? ({ occurrence }) => (occurrence.event.data?.late ? <span data-testid="late-label">1 day late</span> : undefined) : undefined}
      >
        <EventCalendarContent />
      </EventCalendar>,
    );
  });
}

const DROPPED = "If the type and the chip both look right, check VIEW_CONFIG_KEYS in event-calendar.tsx: a key missing there is silently dropped.";

function chip(title: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>("[data-ec-event-id]")].find((el) => el.textContent?.includes(title));
  if (!found) throw new Error(`no chip for ${title}`);
  return found;
}

describe("eventSize: readable", () => {
  it.each(["month", "week"] as const)("sets a grid chip's type to text-sm in %s", (view) => {
    render(view, { eventSize: "readable" });
    expect(chip("Client revisions").className.split(" "), DROPPED).toContain("text-sm");
  });

  it("prints a grid chip's time at text-xs", () => {
    render("week", { eventSize: "readable" });
    const time = [...chip("Client revisions").querySelectorAll("span")].find((span) => span.className.includes("text-muted-foreground"));
    expect(time?.className.split(" ")).toContain("text-xs");
  });

  it("prints the agenda row's time column at text-xs, the title staying text-sm", () => {
    render("agenda", { eventSize: "readable" });
    const [time] = [...chip("Client revisions").querySelectorAll("span")];
    expect(time!.className.split(" ")).toContain("text-xs");
    expect(chip("Client revisions").className.split(" ")).toContain("text-sm");
  });

  it("raises the bar lane to --space-6 (32px) so a 14px chip with its 20px avatar fits a month or all-day bar", () => {
    render("month", { eventSize: "readable" });
    const calendarRoot = () => {
      const el = host.firstElementChild as HTMLElement;
      // The root carries the calendar's own base type; a wrapper or a portal would not.
      expect(el.className.split(" ")).toContain("text-xs");
      return el;
    };
    expect(calendarRoot().className.split(" ")).toContain("[--ec-month-bar-h:var(--space-6)]");
    render("month");
    expect(calendarRoot().className).not.toContain("--ec-month-bar-h");
  });

  it("changes nothing by default: the chip inherits the calendar's text-xs", () => {
    render("week");
    expect(chip("Client revisions").className.split(" ")).not.toContain("text-sm");
    render("agenda");
    const [time] = [...chip("Client revisions").querySelectorAll("span")];
    expect(time!.className.split(" ")).not.toContain("text-xs");
  });
});

describe("renderAgendaEventTrailing", () => {
  it("adds the consumer's node to an agenda row, after the vendor's own content", () => {
    render("agenda", { trailing: true });
    const row = chip("Retouch hero shots");
    expect(row.querySelector('[data-testid="late-label"]')?.textContent, DROPPED).toBe("1 day late");
    expect(row.textContent).toContain("Retouch hero shots");
    expect(chip("Client revisions").querySelector('[data-testid="late-label"]')).toBeNull();
  });

  it("is agenda-only: grid chips never call it", () => {
    render("week", { trailing: true });
    expect(host.querySelector('[data-testid="late-label"]')).toBeNull();
  });
});
