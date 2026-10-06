/**
 * #643: the week / days / agenda title, the day title and the agenda group's aria-label read in the Portal's
 * day-first form ("28 Sep – 4 Oct 2026"), not the vendor's US "Sep 28 - Oct 4, 2026". Rendered against the real
 * vendor tree, because the title and aria-label reach the formatters only through the merged settings.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_EVENT_CALENDAR_I18N, PRODUCTION_EVENT_CALENDAR_VIEW_SETTINGS } from "@/lib/production-event-calendar-adapter";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { EventCalendar } from "./event-calendar";
import { EventCalendarContent } from "./event-calendar-content";
import { EventCalendarNav } from "./event-calendar-nav";
import type { CalendarView } from "./event-calendar-types";

if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

let host: HTMLDivElement;
let root: Root;
const TZ = "Australia/Sydney";

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

/** `i18n` is explicit: passing `undefined` must mean "no override", never a default. */
function render(view: CalendarView, date: string, i18n: Parameters<typeof EventCalendar>[0]["i18n"]) {
  act(() => {
    root.render(
      <EventCalendar events={[]} view={view} date={new Date(date)} {...PRODUCTION_EVENT_CALENDAR_VIEW_SETTINGS} timeZone={TZ} i18n={i18n}>
        <EventCalendarNav showViewSwitcher={false} />
        <EventCalendarContent />
      </EventCalendar>
    );
  });
}
const title = () => host.querySelector<HTMLElement>("[aria-live='polite']")!.textContent;

describe("range titles (#643)", () => {
  it("week across a month boundary", () => {
    render("week", "2026-09-30T02:00:00.000Z", PRODUCTION_EVENT_CALENDAR_I18N);
    expect(title()).toBe("28 Sep – 4 Oct 2026");
  });

  it("week within one month", () => {
    render("week", "2026-10-14T02:00:00.000Z", PRODUCTION_EVENT_CALENDAR_I18N);
    expect(title()).toBe("12–18 Oct 2026");
  });

  it("week across a year boundary", () => {
    render("week", "2026-12-30T02:00:00.000Z", PRODUCTION_EVENT_CALENDAR_I18N);
    expect(title()).toBe("28 Dec 2026 – 3 Jan 2027");
  });

  it("day title", () => {
    render("day", "2026-10-07T02:00:00.000Z", PRODUCTION_EVENT_CALENDAR_I18N);
    expect(title()).toBe("Wed 7 Oct 2026");
  });

  it("month title is unchanged", () => {
    render("month", "2026-10-07T02:00:00.000Z", PRODUCTION_EVENT_CALENDAR_I18N);
    expect(title()).toBe("October 2026");
  });

  it("agenda title and aria-label share the day-first range", () => {
    render("agenda", "2026-10-06T22:00:00.000Z", PRODUCTION_EVENT_CALENDAR_I18N);
    expect(title()).toBe("7–20 Oct 2026");
    // The agenda's own group is the outermost one.
    expect(host.querySelector("[role='group']")!.getAttribute("aria-label")).toBe("7–20 Oct 2026");
  });

  it("keeps the vendor text when the consumer overrides nothing", () => {
    render("week", "2026-09-30T02:00:00.000Z", undefined);
    expect(title()).toBe("Sep 28 - Oct 4, 2026");
  });
});
