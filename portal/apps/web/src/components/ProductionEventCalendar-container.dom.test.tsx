/**
 * #222 step 7 — the read-only event-calendar surface, ported from
 * `ProductionCalendar-container.dom.test.tsx` (loading / errors / empty / views / External), with the
 * FullCalendar month disclosure replaced by "a day click opens the day view". The vendor tree is the
 * shared fake (`testing/event-calendar-fake.tsx`): props are recorded, callbacks are invoked with
 * crafted arguments. Guard F: only Quincy `data-testid`s are selected.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adminProductionCalendarRangeResponseSchema,
  externalCalendarRangeSchema,
  PRODUCTION_CALENDAR_ZONE,
  type DashboardCalendarState,
} from "@quincy/shared";
import { eventCalendarFake } from "../testing/event-calendar-fake";
import { ProductionEventCalendar } from "./ProductionEventCalendar";
import { Sheet } from "./reui/sheet";
import { startMoment, endMoment, subtaskReminders } from "@/testing/subtask-schedule";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/auth", () => ({ useSession: () => ({ data: null, isPending: false }) }));
vi.mock("./reui/event-calendar/event-calendar", async () => (await import("../testing/event-calendar-fake")).eventCalendarModule);
vi.mock("./reui/event-calendar/event-calendar-nav", async () => (await import("../testing/event-calendar-fake")).eventCalendarNavModule);
vi.mock("./reui/event-calendar/event-calendar-content", async () => (await import("../testing/event-calendar-fake")).eventCalendarContentModule);

const principal = "11111111-1111-4111-8111-111111111111";
const assignee = "22222222-2222-4222-8222-222222222222";
const calendar = (subview: DashboardCalendarState["subview"] = "month", date = "2026-08-12"): DashboardCalendarState => ({
  view: "calendar", date, subview, layers: ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], priorities: [], archived: "hide" as const,
  shootRange: null, deadlineRange: null,
  showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false,
});

function rawResponse(stageKey: "editing_autohdr" | "editing", events = true) {
  return {
    range: {
      start: "2026-08-10", end: "2026-08-17", date: "2026-08-12", subview: "month" as const, zone: PRODUCTION_CALENDAR_ZONE,
      appliedFilters: { layers: ["project", "checklist"] as ["project", "checklist"], editorIds: [], includeUnassigned: false, stageKeys: [], priorities: [], archived: "hide" as const, shootRange: null, deadlineRange: null, showCompletedChecklist: false, showDeliveredProjects: false, overdueOnly: false, search: "", myTasks: false },
    },
    events: events ? [
      { id: "project-deadline:project", kind: "project_deadline" as const, title: "Project handoff", project: { id: principal, street: "12 Harbour Street", stageKey, checklist: { completed: 3, total: 5 }, delivered: false, archived: false }, timing: { allDay: false as const, start: "2026-08-12T00:00:00.000Z", end: null }, status: { overdue: true, delivered: false, completed: false as const, sameAssigneeOverlap: false as const }, permissions: { canDrag: true, canResize: false as const }, deadlineLocalCivil: "2026-08-12T10:00", deadlineVersion: 3, reminderOffsetsMinutes: [] },
      { id: "checklist:item", kind: "checklist" as const, title: "Select hero images", project: { id: principal, street: "12 Harbour Street", stageKey, checklist: { completed: 3, total: 5 }, delivered: false, archived: false }, assignees: [{ id: assignee, name: "Maya Editor", roleLabel: "Editor", isExternal: stageKey === "editing", active: true }], otherAssigneeCount: 0, timing: { allDay: true as const, start: "2026-08-12", end: null }, status: { overdue: false, delivered: false, completed: true, sameAssigneeOverlap: false }, schedule: { state: "range" as const, version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: startMoment("2026-08-12"), end: endMoment("2026-08-12"), due: "2026-08-12" }, reminders: subtaskReminders(), permissions: { canDrag: true, canResize: false as const, canOpenScheduleEditor: true } },
    ] : [],
    filterFacets: { projects: [{ id: principal, street: "12 Harbour Street" }], people: [], myTasksUserId: assignee },
  };
}

function stubMedia(matching: string[]) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({ matches: matching.includes(query), media: query, onchange: null, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false })),
  });
}

describe("ProductionEventCalendar container", () => {
  let host: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    eventCalendarFake.reset();
    stubMedia([]);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

  async function renderCalendar(value: DashboardCalendarState, body: unknown, status = 200, options: { role?: "admin" | "external_editor"; onNavigate?: (next: DashboardCalendarState) => void; onOpenProject?: (id: string) => void; inShellSheet?: boolean } = {}) {
    fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => {
      const surface = <ProductionEventCalendar identity={{ principalId: principal, role: options.role ?? "admin", authorizationEpoch: 0 }} calendar={value} onNavigate={options.onNavigate ?? (() => undefined)} onOpenProject={options.onOpenProject} />;
      // `inShellSheet`: every page sits inside RailedShell's (closed) Sheet Root, as in the app.
      root.render(<QueryClientProvider client={client}>{options.inShellSheet ? <Sheet open={false}>{surface}</Sheet> : surface}</QueryClientProvider>);
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); await Promise.resolve(); await Promise.resolve(); });
  }

  const requestedPaths = () => fetchMock.mock.calls.map(([input]) => String(input));

  it("shows a loading status before the range resolves", async () => {
    let release!: () => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = () => resolve(new Response(JSON.stringify(adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr"))), { status: 200, headers: { "content-type": "application/json" } })); })));
    await act(async () => { root.render(<QueryClientProvider client={client}><ProductionEventCalendar identity={{ principalId: principal, role: "admin", authorizationEpoch: 0 }} calendar={calendar()} onNavigate={() => undefined} /></QueryClientProvider>); });
    expect(host.querySelector('[data-testid="event-calendar-loading"]')?.textContent).toContain("Loading calendar");
    expect(host.querySelector('[data-testid="event-calendar-fake"]')).toBeNull();
    // #363: the skeleton fills the region instead of a fixed 480px block.
    const loading = host.querySelector<HTMLElement>('[data-testid="event-calendar-loading"]')!;
    expect(loading.className.split(/\s+/)).toContain("flex-1");
    expect(loading.innerHTML).not.toContain("h-[480px]");
    release();
  });

  it("renders generic and dense errors distinctly", async () => {
    await renderCalendar(calendar(), { message: "offline" }, 400);
    expect(host.querySelector('[data-testid="event-calendar-error"]')?.textContent).toContain("Try again");
    await act(async () => { root.unmount(); root = createRoot(host); });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await renderCalendar(calendar(), { code: "calendar_range_too_dense", refinement: "Narrow Stage filters." }, 422);
    const error = host.querySelector('[data-testid="event-calendar-error"]');
    expect(error?.textContent).toContain("too dense");
    expect(error?.textContent).toContain("Narrow Stage filters.");
    expect(error?.textContent).not.toContain("Try again");
  });

  it("renders the empty state", async () => {
    const empty = rawResponse("editing_autohdr", false);
    await renderCalendar(calendar(), adminProductionCalendarRangeResponseSchema.parse(empty));
    const status = host.querySelector<HTMLElement>('[data-testid="event-calendar-empty"]')!;
    expect(status.textContent).toBe("No scheduled work in this range.");
    expect(status.getAttribute("role")).toBe("status");
    // A quiet one-line status in the toolbar row, not a serif EmptyState heading above the grid.
    expect(status.querySelector("h1, h2, h3, h4")).toBeNull();
    expect(status.className).toContain("text-[length:var(--text-xs)]");
    expect(status.className).toContain("text-muted-foreground");
    expect(status.parentElement).toBe(host.querySelector('[data-testid="event-calendar-fake-nav"]')?.parentElement ?? null);
    const rail = host.querySelector('[data-testid="event-calendar-rail"]')!;
    expect(rail.textContent).not.toContain("Unscheduled");
  });

  it.each([
    ["week", "2026-10-14", "AEDT"],
    ["day", "2026-10-14", "AEDT"],
    ["week", "2026-07-15", "AEST"],
    ["day", "2026-07-15", "AEST"],
    ["month", "2026-10-14", "AEST/AEDT"],
  ] as const)("labels the visible %s of %s as Sydney time · %s, beside the nav (#222)", async (subview, date, expected) => {
    await renderCalendar(calendar(subview, date), adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr")));
    const zone = host.querySelector<HTMLElement>('[data-testid="event-calendar-zone"]')!;
    expect(zone.textContent).toBe(`Sydney time · ${expected}`);
    // The FullCalendar toolbar's eyebrow treatment, in the same toolbar row as the nav.
    expect(zone.className).toContain("[font:var(--type-eyebrow)]");
    expect(zone.className).toContain("text-muted-foreground");
    expect(zone.parentElement).toBe(host.querySelector('[data-testid="event-calendar-fake-nav"]')?.parentElement ?? null);
  });

  it("keeps the zone label and the quiet empty status side by side in the toolbar row", async () => {
    await renderCalendar(calendar("week", "2026-07-15"), adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr", false)));
    const zone = host.querySelector<HTMLElement>('[data-testid="event-calendar-zone"]')!;
    const status = host.querySelector<HTMLElement>('[data-testid="event-calendar-empty"]')!;
    expect(zone.textContent).toBe("Sydney time · AEST");
    expect(status.textContent).toBe("No scheduled work in this range.");
    expect(zone.parentElement).toBe(status.parentElement);
    // The zone never shrinks away; the empty status is the one that truncates.
    expect(zone.className).toContain("shrink-0");
    expect(zone.className).toContain("whitespace-nowrap");
  });

  describe("phone toolbar (#385)", () => {
    const PHONE = ["(max-width: 720px)", "(max-width: 1100px)"];
    const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

    it("puts the full title and the zone on the period row, before the controls row", async () => {
      stubMedia(PHONE);
      await renderCalendar(calendar("month", "2026-09-15"), adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr")));
      const period = q("event-calendar-period");
      const controls = q("event-calendar-controls");
      expect(period).not.toBeNull();
      expect(controls).not.toBeNull();
      expect(period.contains(q("event-calendar-fake-title"))).toBe(true);
      expect(q("event-calendar-zone").parentElement).toBe(period);
      expect(controls.contains(q("event-calendar-fake-title"))).toBe(false);
      expect(controls.contains(q("event-calendar-zone"))).toBe(false);
      expect(period.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("keeps Filters, Today, the view switcher and the arrows in the controls row, each 44px tall", async () => {
      stubMedia(PHONE);
      await renderCalendar(calendar("month", "2026-09-15"), adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr")));
      const controls = q("event-calendar-controls");
      const ids = ["event-calendar-rail-toggle", "event-calendar-fake-today", "event-calendar-fake-view-switcher", "event-calendar-fake-prev", "event-calendar-fake-next"];
      const parts = ids.map(q);
      parts.forEach((part) => { expect(controls.contains(part)).toBe(true); expect(part.className.split(/\s+/)).toContain("min-h-[44px]"); });
      const order = Array.from(controls.querySelectorAll<HTMLElement>("[data-testid]")).map((el) => el.dataset.testid).filter((id) => ids.includes(id!));
      expect(order).toEqual(ids);
    });

    it("keeps the empty status beside the zone on the period row", async () => {
      stubMedia(PHONE);
      await renderCalendar(calendar("week", "2026-07-15"), adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr", false)));
      expect(q("event-calendar-empty").parentElement).toBe(q("event-calendar-zone").parentElement);
      expect(q("event-calendar-period").contains(q("event-calendar-empty"))).toBe(true);
    });

    it("leaves the wider layout on the default nav", async () => {
      stubMedia(["(max-width: 1100px)"]);
      await renderCalendar(calendar("month", "2026-09-15"), adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr")));
      expect(host.querySelector('[data-testid="event-calendar-period"]')).toBeNull();
      expect(host.querySelector('[data-testid="event-calendar-controls"]')).toBeNull();
      expect(q("event-calendar-zone").parentElement).toBe(q("event-calendar-fake-nav").parentElement);
    });
  });

  it("requests bounds, maps the subview to the controlled view and Sydney date, and defers writes", async () => {
    const parsed = adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr"));
    await renderCalendar(calendar("month"), parsed);
    expect(requestedPaths().some((path) => path.includes("bounds=1") && path.includes("sub=month"))).toBe(true);
    const props = eventCalendarFake.lastProps!;
    expect(props.view).toBe("month");
    expect(props.timeZone).toBe("Australia/Sydney");
    expect(props.weekStartsOn).toBe(1);
    expect(props.fixedWeeks).toBe(true);
    expect(props.agendaDayCount).toBe(14);
    expect(props.dayCount).toBe(3);
    expect(props.dayCountPresets).toEqual([3]);
    // Week / Day / 3-day open scrolled to the working day (8 AM Sydney), not midnight.
    expect(props.scrollToHour).toBe(8);
    expect(props.views).toEqual(["month", "week", "day", "days", "agenda"]);
    // Sydney noon of the civil date: 12:00 AEST = 02:00Z.
    expect((props.date as Date).toISOString()).toBe("2026-08-12T02:00:00.000Z");
    expect(props.interactions).toEqual({ drag: true, resize: true, selectSlot: false });
    // A write for an event that isn't rendered is refused synchronously, with no request.
    const unknown = { id: "not-rendered", title: "x", start: new Date("2026-08-12T00:00:00Z"), end: new Date("2026-08-12T01:00:00Z") };
    const callsBefore = fetchMock.mock.calls.length;
    const refused = (props.onEventUpdate as (update: unknown) => unknown)({
      event: unknown, start: new Date("2026-08-13T00:00:00Z"), end: new Date("2026-08-13T01:00:00Z"), allDay: false, source: "drag", granularity: "minute",
    });
    expect(refused).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect("onEventsChange" in props).toBe(false);
    expect("canDropEvent" in props).toBe(false);
    expect("enforceCanDrop" in props).toBe(false);
    const chips = [...host.querySelectorAll<HTMLElement>('[data-testid="event-calendar-fake-event"]')];
    expect(chips.map((chip) => chip.textContent)).toEqual([expect.stringContaining("12 Harbour Street"), expect.stringContaining("Select hero images")]);

    for (const subview of ["week", "day", "days", "agenda"] as const) {
      await act(async () => { root.unmount(); root = createRoot(host); });
      await renderCalendar(calendar(subview), parsed);
      expect(eventCalendarFake.lastProps?.view).toBe(subview);
    }
  });

  it("a day click in month opens the day view for that Sydney date", async () => {
    const onNavigate = vi.fn();
    await renderCalendar(calendar("month"), adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr")), 200, { onNavigate });
    // The vendor's month cell hands back the Sydney zoned midnight of the 14th (13th 14:00Z).
    await act(async () => { (eventCalendarFake.lastProps!.onSlotClick as (slot: unknown, e: unknown) => void)({ date: new Date("2026-08-13T14:00:00.000Z"), allDay: true, view: "month" }, {}); });
    expect(onNavigate).toHaveBeenCalledWith(expect.objectContaining({ view: "calendar", subview: "day", date: "2026-08-14" }));
  });

  it("navigation and view changes flow back through onNavigate as Sydney civil dates", async () => {
    const onNavigate = vi.fn();
    await renderCalendar(calendar("week"), adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr")), 200, { onNavigate });
    await act(async () => { (eventCalendarFake.lastProps!.onDateChange as (date: Date) => void)(new Date("2026-08-18T22:30:00.000Z")); });
    expect(onNavigate).toHaveBeenLastCalledWith(expect.objectContaining({ subview: "week", date: "2026-08-19" }));
    await act(async () => { (eventCalendarFake.lastProps!.onViewChange as (view: string) => void)("agenda"); });
    expect(onNavigate).toHaveBeenLastCalledWith(expect.objectContaining({ subview: "agenda", date: "2026-08-12" }));
    const calls = onNavigate.mock.calls.length;
    // Re-announcing the current date or view is not a navigation.
    await act(async () => { (eventCalendarFake.lastProps!.onDateChange as (date: Date) => void)(new Date("2026-08-12T02:00:00.000Z")); });
    await act(async () => { (eventCalendarFake.lastProps!.onViewChange as (view: string) => void)("week"); });
    expect(onNavigate).toHaveBeenCalledTimes(calls);
  });

  it("the phone gate turns direct manipulation off in week, day and days, not in month", async () => {
    stubMedia(["(pointer: coarse)", "(max-width: 720px)"]);
    const parsed = adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr"));
    for (const subview of ["week", "day", "days"] as const) {
      await renderCalendar(calendar(subview), parsed);
      expect(eventCalendarFake.lastProps?.interactions).toEqual({ drag: false, resize: false, selectSlot: false });
      await act(async () => { root.unmount(); root = createRoot(host); });
    }
    await renderCalendar(calendar("month"), parsed);
    expect(eventCalendarFake.lastProps?.interactions).toEqual({ drag: true, resize: true, selectSlot: false });
  });

  it("fills the remaining height with a bounded rail + grid row, so the rail scrolls inside its column", async () => {
    await renderCalendar(calendar("month"), adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr")));
    const body = host.querySelector<HTMLElement>('[data-testid="event-calendar-body"]')!;
    expect(body).not.toBeNull();
    expect(body.querySelector('[data-testid="event-calendar-rail"]')).not.toBeNull();
    // jsdom cannot lay out: pin the class contract. The body is a flexed item of a definite-height
    // column (#363) with a `minmax(0,1fr)` row, so a long rail cannot grow the row (an `auto` row would).
    const classes = body.className.split(/\s+/);
    for (const token of ["min-h-0", "flex-1", "grid-rows-[minmax(0,1fr)]"]) expect(classes).toContain(token);
    expect(classes).not.toContain("h-[min(760px,calc(100svh-220px))]");
    expect(classes).not.toContain("min-h-[480px]");
    expect(host.querySelector<HTMLElement>('[data-testid="event-calendar-rail"]')!.className.split(/\s+/)).toContain("min-h-0");
    const screen = host.querySelector<HTMLElement>('[data-testid="event-calendar-screen"]')!;
    for (const token of ["flex", "flex-col", "flex-1", "min-h-0"]) expect(screen.className.split(/\s+/)).toContain(token);
  });

  it("the narrow rail sheet renders the Portal scrim even inside the shell's Sheet", async () => {
    stubMedia(["(max-width: 1100px)"]);
    await renderCalendar(calendar(), adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr")), 200, { inShellSheet: true });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="event-calendar-rail-toggle"]')!.click(); await Promise.resolve(); });
    const scrim = document.querySelector<HTMLElement>('[data-testid="event-calendar-rail-sheet-scrim"]');
    expect(scrim).not.toBeNull();
    expect(scrim!.className).toContain("bg-[var(--scrim-overlay)]");
    expect(document.querySelector<HTMLElement>('[data-testid="event-calendar-rail-sheet"]')!.className).toContain("z-[var(--z-dialog)]");
  });

  it("moves the rail into a sheet below the rail breakpoint", async () => {
    stubMedia(["(max-width: 1100px)"]);
    await renderCalendar(calendar(), adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr")));
    expect(host.querySelector('[data-testid="event-calendar-rail"]')).toBeNull();
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="event-calendar-rail-toggle"]')!;
    expect(toggle).not.toBeNull();
    // #430: the sheet holds the mini month and Up next only, so the button is named for the sheet, not for filters.
    expect(toggle.textContent).toBe("Calendar");
    await act(async () => { toggle.click(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="event-calendar-rail-sheet"] [data-testid="event-calendar-rail"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="event-calendar-rail-sheet"]')!.textContent).not.toMatch(/filters/i);
  });

  describe("rail sheet close control (#462)", () => {
    const sheetEl = () => document.querySelector<HTMLElement>('[data-testid="event-calendar-rail-sheet"]');
    const toggleEl = () => host.querySelector<HTMLButtonElement>('[data-testid="event-calendar-rail-toggle"]')!;
    async function openRail() {
      stubMedia(["(max-width: 1100px)"]);
      await renderCalendar(calendar(), adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr")));
      await act(async () => { toggleEl().click(); await Promise.resolve(); });
    }

    it("has exactly one Close calendar control, after the rail in document order", async () => {
      await openRail();
      const closes = sheetEl()!.querySelectorAll<HTMLButtonElement>('button[aria-label="Close calendar"]');
      expect(closes).toHaveLength(1);
      expect(sheetEl()!.querySelector('[data-testid="event-calendar-rail"]')!.compareDocumentPosition(closes[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect([...sheetEl()!.querySelectorAll("button")].filter((b) => b.textContent === "Close")).toHaveLength(0);
    });

    it("closes on click and reopens", async () => {
      await openRail();
      expect(toggleEl().getAttribute("aria-expanded")).toBe("true");
      await act(async () => { sheetEl()!.querySelector<HTMLButtonElement>('[data-testid="event-calendar-rail-sheet-close"]')!.click(); await Promise.resolve(); });
      expect(toggleEl().getAttribute("aria-expanded")).toBe("false");
      await act(async () => { toggleEl().click(); await Promise.resolve(); });
      expect(toggleEl().getAttribute("aria-expanded")).toBe("true");
    });

    it("closes on Escape", async () => {
      await openRail();
      await act(async () => { sheetEl()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
      expect(toggleEl().getAttribute("aria-expanded")).toBe("false");
    });

    it("renders no sheet at the wide layout", async () => {
      await renderCalendar(calendar(), adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr")));
      expect(sheetEl()).toBeNull();
    });
  });

  it("Up next runs a second read-only agenda query from today, with the same filters", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-20T01:00:00.000Z"));
    try {
      await renderCalendar(calendar("month"), adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr")));
    } finally {
      vi.useRealTimers();
    }
    const agenda = requestedPaths().find((path) => path.includes("sub=agenda"));
    expect(agenda).toBeDefined();
    const params = new URLSearchParams(agenda!.split("?", 2)[1]);
    expect(params.get("date")).toBe("2026-08-20");
    expect(params.get("layers")).toBe("project,checklist");
    expect(params.get("bounds")).toBeNull();
  });

  it("uses the strict External fixture", async () => {
    const external = externalCalendarRangeSchema.parse(rawResponse("editing"));
    await renderCalendar(calendar(), external, 200, { role: "external_editor" });
    expect([...host.querySelectorAll('[data-testid="event-calendar-fake-event"]')].map((chip) => chip.textContent).join(" ")).toContain("Select hero images");
  });

  it("keeps the Dashboard's focus and live-region hooks", async () => {
    await renderCalendar(calendar(), adminProductionCalendarRangeResponseSchema.parse(rawResponse("editing_autohdr")));
    expect(host.querySelector('[data-focus-key="calendar-safe-fallback"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="dashboard-live-region"]')?.getAttribute("aria-live")).toBe("polite");
  });
});
