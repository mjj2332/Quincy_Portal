/**
 * #916 design review, should-fix 6: the week header's today mark is a pill around the date number only (frame 3d,
 * `.wd.now b`), sized to its content. The vendor's default wrapped the whole "Sun 18" in an `inline-block max-w-full
 * truncate` chip, which ellipsised to "Sun…" when the column ran narrow. Runs through the real vendored calendar.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminProductionCalendarRangeResponseSchema, deriveProductionCalendarWindow, PRODUCTION_CALENDAR_ZONE, type DashboardCalendarState } from "@quincy/shared";
import { ProductionEventCalendar } from "./ProductionEventCalendar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("../lib/use-now", () => ({ useNow: () => Date.parse("2026-08-12T02:00:00.000Z") }));

const principal = "11111111-1111-4111-8111-111111111111";
const noFilters = { layers: ["project", "checklist"] as ("project" | "checklist")[], editorIds: [], includeUnassigned: false, stageKeys: [], priorities: [], archived: "hide" as const, shootRange: null, deadlineRange: null, showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false };

function calendarFor(subview: "week" | "month"): DashboardCalendarState {
  return { view: "calendar", date: "2026-08-12", subview, ...noFilters };
}

function responseFor(subview: "week" | "month") {
  const window = deriveProductionCalendarWindow("2026-08-12", subview);
  return adminProductionCalendarRangeResponseSchema.parse({
    range: { ...window, date: "2026-08-12", subview, zone: PRODUCTION_CALENDAR_ZONE, appliedFilters: noFilters },
    events: [],
    filterFacets: { projects: [], people: [], myTasksUserId: principal },
  });
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-08-12T02:00:00.000Z")); // Wed 12 Aug, noon in Sydney
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); await Promise.resolve(); });
  host.remove();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount(subview: "week" | "month") {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(responseFor(subview)), { status: 200, headers: { "content-type": "application/json" } })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><ProductionEventCalendar identity={{ principalId: principal, role: "admin", authorizationEpoch: 0 }} calendar={calendarFor(subview)} onNavigate={() => undefined} /></QueryClientProvider>);
    await Promise.resolve();
  });
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

const lines = () => [...host.querySelectorAll<HTMLElement>('[data-testid="event-calendar-day-header"]')];
const isToday = (line: HTMLElement) => line.querySelector('[data-testid="event-calendar-today-date"]') !== null;

describe("ProductionEventCalendar week header", () => {
  it("marks today with a content-sized pill around the date number only; the weekday sits outside it", async () => {
    await mount("week");
    const today = lines().filter(isToday);
    expect(today).toHaveLength(1);
    const pill = today[0]!.querySelector<HTMLElement>('[data-testid="event-calendar-today-date"]')!;
    expect(pill.textContent).toBe("12");
    const tokens = pill.className.split(/\s+/);
    expect(tokens).toContain("bg-primary");
    expect(tokens).not.toContain("truncate");
    expect(tokens).not.toContain("max-w-full");
    // The desktop line reads "Wed 12": the weekday is plain text before the pill.
    const line = today[0]!;
    expect(pill.parentElement).toBe(line);
    expect(line.textContent?.replace(/\s+/g, " ").trim()).toBe("Wed 12");
    expect(line.className.split(/\s+/)).not.toContain("bg-primary");
  });

  it("draws every other day as the plain weekday and date, and Monday leads the week", async () => {
    await mount("week");
    const all = lines();
    expect(all).toHaveLength(7);
    expect(all.filter((line) => !isToday(line))).toHaveLength(6);
    expect(all[0]!.textContent?.replace(/\s+/g, " ").trim()).toBe("Mon 10");
  });

  it("leaves the month view's weekday headers to the vendor", async () => {
    await mount("month");
    expect(host.querySelector('[data-testid="event-calendar-today-date"]')).toBeNull();
  });
});
