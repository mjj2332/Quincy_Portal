/**
 * #222 — the vendored event calendar's visible range must sit inside the server's query window,
 * or a chip the grid paints could be missing from the response. Checked for all five views on
 * every date of both 2026 Sydney DST weeks (clocks back Sun 5 Apr, forward Sun 4 Oct), with the
 * EXACT settings and anchor `ProductionEventCalendar` passes (`PRODUCTION_EVENT_CALENDAR_VIEW_SETTINGS`,
 * `productionEventCalendarAnchor`).
 *
 * Test-only vendor import (the import-boundary guards exempt test files).
 */
import { describe, expect, it } from "vitest";
import { deriveProductionCalendarWindow, resolveSydneyCivilMinute, shiftSydneyCalendarDate, type ProductionCalendarSubview } from "@quincy/shared";
import { getViewDateRange } from "../components/reui/event-calendar/event-calendar-lib";
import { PRODUCTION_EVENT_CALENDAR_VIEW_SETTINGS, productionEventCalendarAnchor, subviewToCalendarView } from "./production-event-calendar-adapter";

const VIEWS: ProductionCalendarSubview[] = ["month", "week", "day", "days", "agenda"];

function sydneyMidnight(date: string): number {
  const resolved = resolveSydneyCivilMinute(`${date}T00:00`, "earlier");
  if (!resolved.ok) throw new Error(`no Sydney midnight on ${date}`);
  return resolved.value.epochMs;
}

function datesAround(center: string, before: number, after: number): string[] {
  const dates: string[] = [];
  for (let offset = -before; offset <= after; offset += 1) {
    const shifted = shiftSydneyCalendarDate(center, offset);
    if (!shifted.ok) throw new Error(`could not shift ${center} by ${offset}`);
    dates.push(shifted.value);
  }
  return dates;
}

describe("event-calendar visible range ⊆ server window across the 2026 Sydney DST weeks", () => {
  for (const [label, transition] of [["autumn (5 Apr)", "2026-04-05"], ["spring (4 Oct)", "2026-10-04"]] as const) {
    for (const subview of VIEWS) {
      it(`${subview} — ${label}`, () => {
        for (const date of datesAround(transition, 7, 7)) {
          const server = deriveProductionCalendarWindow(date, subview);
          const { visibleRange } = getViewDateRange(subviewToCalendarView(subview), productionEventCalendarAnchor(date), { ...PRODUCTION_EVENT_CALENDAR_VIEW_SETTINGS });
          const context = `${subview} ${date}: vendor ${visibleRange.start.toISOString()}–${visibleRange.end.toISOString()} vs server ${server.start}–${server.end}`;
          expect(visibleRange.start.getTime(), context).toBeGreaterThanOrEqual(sydneyMidnight(server.start));
          expect(visibleRange.end.getTime(), context).toBeLessThanOrEqual(sydneyMidnight(server.end));
          // And not narrower than the window by a whole day: the two agree on the civil span.
          expect(visibleRange.end.getTime() - visibleRange.start.getTime(), context).toBeGreaterThan(sydneyMidnight(server.end) - sydneyMidnight(server.start) - 86_400_000);
        }
      });
    }
  }
});
