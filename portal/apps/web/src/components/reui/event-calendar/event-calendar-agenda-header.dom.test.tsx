/**
 * #614: the agenda's day header and group aria-label are driven by `i18n.formats.agendaDayWeekday` /
 * `agendaDayDate`, not the vendor's literals. A rendered assertion because the view reads the
 * formats through the merged settings: a key added to the type but not consumed typechecks and
 * renders the vendor text.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_EVENT_CALENDAR_I18N } from "@/lib/production-event-calendar-adapter";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { EventCalendar } from "./event-calendar";
import { EventCalendarContent } from "./event-calendar-content";
import type { CalendarEvent } from "./event-calendar-types";

let host: HTMLDivElement;
let root: Root;

const TZ = "Australia/Sydney";
// 2026-10-07 is a Wednesday.
const ANCHOR = new Date("2026-10-06T22:00:00.000Z");

const EVENTS: CalendarEvent[] = [
  {
    id: "e1",
    title: "Shoot at the house",
    start: new Date("2026-10-07T04:00:00.000Z"),
    end: new Date("2026-10-07T05:00:00.000Z"),
  },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: ANCHOR });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

function renderAgenda(i18n?: Parameters<typeof EventCalendar>[0]["i18n"]) {
  act(() => {
    root.render(
      <EventCalendar events={EVENTS} view="agenda" date={ANCHOR} timeZone={TZ} i18n={i18n}>
        <EventCalendarContent />
      </EventCalendar>
    );
  });
}

function wednesdayGroup(): HTMLElement {
  const groups = [...host.querySelectorAll<HTMLElement>("[role='group']")];
  const group = groups.find((g) => /Wed|Wednesday/.test(g.getAttribute("aria-label") ?? ""));
  if (!group) throw new Error(`no agenda day group for Wednesday; labels: ${groups.map((g) => g.getAttribute("aria-label")).join(" | ")}`);
  return group;
}

describe("agenda day header uses the i18n formats (#614)", () => {
  it("renders the Quincy short weekday and date in the header and the group aria-label", () => {
    renderAgenda(PRODUCTION_EVENT_CALENDAR_I18N);
    const group = wednesdayGroup();
    const header = group.querySelector<HTMLElement>("[role='heading']")!;
    expect(header.textContent).toBe("Wed7 Oct 2026");
    expect(group.getAttribute("aria-label")).toMatch(/^Wed, 7 Oct 2026, /);
  });

  it("keeps the vendor text when the consumer overrides nothing", () => {
    renderAgenda(undefined);
    const group = wednesdayGroup();
    expect(group.querySelector<HTMLElement>("[role='heading']")!.textContent).toBe("WednesdayOctober 7, 2026");
    expect(group.getAttribute("aria-label")).toMatch(/^Wednesday, October 7, 2026, /);
  });
});
