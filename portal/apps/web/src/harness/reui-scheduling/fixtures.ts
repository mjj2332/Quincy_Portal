/**
 * #219 stage 3 harness fixtures. Quincy-owned (not a ReUI vendored file). Pure data + pure builder
 * functions, no React — so `fixtures.test.ts` can assert the DST invariants below without a DOM.
 *
 * Every instant here is built from Sydney CIVIL date/time components via `@date-fns/tz`'s `TZDate`
 * constructor (or `date-fns` arithmetic — `addDays` etc. — applied to a `TZDate`, exactly how
 * `gantt-lib.tsx` itself builds zoned dates). Never `new Date("YYYY-MM-DD")` (parsed as UTC
 * midnight, not Sydney midnight) and never `.setDate()` on a plain `Date` (mutates in the machine's
 * OWN local zone, whatever that happens to be in CI or a developer's laptop — silently wrong on
 * principle here, since the fixture is Sydney-specific, and catastrophically wrong across a DST
 * transition, which is the one thing `dst-spring`/`dst-autumn` exist to exercise).
 *
 * The three scenarios all use the "month" scale (see `buildScenario`'s own comment for why: the
 * default Sunday-start week window cannot hold the DST scenarios' 3-civil-day project bar without
 * clipping it, since that bar starts the day before a Sunday and ends the Tuesday after — split
 * across two default week windows either way. A calendar month comfortably contains it regardless
 * of where in the month the anchor Sunday falls, so "month" is used uniformly across all three
 * scenarios rather than switching scale per scenario.
 */
import { TZDate } from "@date-fns/tz";
import { addDays, differenceInMinutes, format } from "date-fns";
import type { GanttEvent, GanttResource, GanttScale } from "@/components/reui/gantt/gantt-types";
// `event-calendar-types.tsx` exports all of these publicly (checked directly in that file before
// writing this import) — no fallback import path was needed.
import type {
  CalendarEvent,
  EventCalendarResource,
} from "@/components/reui/event-calendar/event-calendar-types";

export const SYDNEY_TZ = "Australia/Sydney";

export type ScenarioId = "today" | "dst-spring" | "dst-autumn";

export const SCENARIOS: ReadonlyArray<{ id: ScenarioId; label: string }> = [
  { id: "today", label: "Today" },
  { id: "dst-spring", label: "DST spring-forward — Sun 2026-10-04 (23h day)" },
  { id: "dst-autumn", label: "DST autumn — Sun 2026-04-05 (25h day)" },
];

/** Sydney civil midnight of the given Y/M/D (month is 1-based, unlike `Date`'s own constructor). */
function sydneyMidnight(year: number, month: number, day: number): TZDate {
  return new TZDate(year, month - 1, day, 0, 0, 0, 0, SYDNEY_TZ);
}

/** Sydney civil Y/M/D + H:M for a timed (non-all-day) instant. */
function sydneyTime(year: number, month: number, day: number, hour: number, minute: number): TZDate {
  return new TZDate(year, month - 1, day, hour, minute, 0, 0, SYDNEY_TZ);
}

/**
 * The same semantic tokens `components/atoms.tsx`'s `stageColors` maps each stage to — never
 * invented ones — but HAND-COPIED, not imported: `stageColors` there is not exported, and
 * `atoms.tsx` pulls in `lib/stages.tsx` (React hooks, an API client, `useCapabilities`) that this
 * file's own header rules out ("Pure data + pure builder functions, no React"). #219 PR A
 * standards review item 11: exporting `stageColors` and importing it here was considered and
 * rejected on exactly that ground — not a clean one-line change, since it would drag that whole
 * dependency chain into a module `fixtures.test.ts` runs with no DOM. These four literals can
 * drift from `atoms.tsx`'s six-entry map silently; if that happens, this is the place to notice it
 * and re-copy, not a signal that either side is wrong.
 */
const STAGE_COLORS = {
  awaitingRaw: "var(--greige-400)",
  rawReview: "var(--signal-caution)",
  editing: "var(--signal-info)",
  delivered: "var(--signal-positive)",
} as const;

const RESOURCES: GanttResource[] = [
  {
    id: "team-alpha",
    title: "Team Alpha",
    children: [
      { id: "shoot-auckland", title: "Auckland Shoot" },
      { id: "shoot-wellington", title: "Wellington Shoot" },
    ],
  },
];

export interface ScenarioFixture {
  date: Date;
  scale: GanttScale;
  resources: GanttResource[];
  events: GanttEvent[];
  /** Fixed cutoff for the `canDropEvent` fixture below: rejects any proposed range ending after it. */
  deadline: Date;
}

/**
 * One scenario's fixture set, all anchored on a Sydney civil midnight (`anchor`) so every relative
 * offset below stays a whole-day, DST-safe `addDays` call. `anchor` is also the resolved anchor
 * date the caller hands to `<Gantt date=…>`.
 */
function buildFromAnchor(anchor: TZDate): Omit<ScenarioFixture, "date" | "scale"> {
  const day = (offset: number) => addDays(anchor, offset);

  const events: GanttEvent[] = [
    {
      // Owner decision on #215: the shoot (start) edge is fixed, only the deadline (end) edge
      // drags — exactly 3 civil days, midnight to midnight, straddling the anchor.
      id: "project-bar",
      title: "Project Bar (start locked — #215)",
      start: day(-1),
      end: day(2),
      resourceId: "shoot-wellington",
      resizableEdges: { start: false },
      color: STAGE_COLORS.editing,
    },
    {
      id: "unlocked-task",
      title: "Unlocked task",
      start: day(-2),
      end: day(-1),
      resourceId: "shoot-auckland",
      color: STAGE_COLORS.awaitingRaw,
    },
    {
      // "on the DST day itself" for dst-spring/dst-autumn — the anchor IS the DST Sunday there;
      // for "today" the anchor is just today, so this is a same-shaped timed fixture rather than
      // a literal DST occurrence (see this module's header).
      id: "timed-task",
      title: "Client call",
      start: sydneyTime(anchor.getFullYear(), anchor.getMonth() + 1, anchor.getDate(), 9, 0),
      end: sydneyTime(anchor.getFullYear(), anchor.getMonth() + 1, anchor.getDate(), 11, 0),
      resourceId: "shoot-auckland",
      color: STAGE_COLORS.rawReview,
    },
    {
      id: "milestone",
      title: "Client sign-off",
      start: day(3),
      end: day(3),
      resourceId: "shoot-wellington",
      color: STAGE_COLORS.delivered,
    },
    {
      id: "completed-task",
      title: "Upload to client portal",
      start: day(-4),
      end: day(-3),
      resourceId: "shoot-auckland",
      progress: 100,
      color: STAGE_COLORS.delivered,
    },
    {
      // Deliberately unfinished and dated before every other fixture in this set, so it reads as
      // overdue within the scenario regardless of the real wall clock (the `dst-*` scenarios sit
      // in a fixed calendar month that can land on either side of "now" depending when this runs,
      // so the vendor's own real-`Date.now()`-based `data-past` attribute cannot be relied on to be
      // true there; the title and relative position carry the "overdue" story instead).
      id: "overdue-task",
      title: "Overdue: location permit",
      start: day(-6),
      end: day(-5),
      resourceId: "shoot-wellington",
      progress: 40,
      color: STAGE_COLORS.rawReview,
    },
  ];

  return {
    resources: RESOURCES,
    events,
    deadline: day(5),
  };
}

function buildToday(): ScenarioFixture {
  const now = new TZDate(Date.now(), SYDNEY_TZ);
  const anchor = sydneyMidnight(now.getFullYear(), now.getMonth() + 1, now.getDate());
  return { date: anchor, scale: "month", ...buildFromAnchor(anchor) };
}

function buildDstSpring(): ScenarioFixture {
  // First Sunday of October 2026 — Sydney's spring-forward transition (2am -> 3am), a 23-hour day.
  const anchor = sydneyMidnight(2026, 10, 4);
  return { date: anchor, scale: "month", ...buildFromAnchor(anchor) };
}

function buildDstAutumn(): ScenarioFixture {
  // First Sunday of April 2026 — Sydney's autumn transition (3am -> 2am), a 25-hour day.
  const anchor = sydneyMidnight(2026, 4, 5);
  return { date: anchor, scale: "month", ...buildFromAnchor(anchor) };
}

export function buildScenario(id: ScenarioId): ScenarioFixture {
  if (id === "dst-spring") return buildDstSpring();
  if (id === "dst-autumn") return buildDstAutumn();
  return buildToday();
}

/**
 * ISO local date-time + UTC offset, rendered in Sydney — e.g. "2026-10-04T09:00:00+11:00" outside
 * the transition and "…+10:00" on the other side of it, so a one-hour drift across DST is visible
 * as TEXT in the event log, not just as a number a reader has to already know to distrust.
 */
export function formatZonedInstant(date: Date): string {
  return format(new TZDate(date.getTime(), SYDNEY_TZ), "yyyy-MM-dd'T'HH:mm:ssxxx");
}

/**
 * Civil-day span between two instants, counted from their Sydney wall-clock Y/M/D (never from
 * elapsed milliseconds, which is exactly what the DST scenarios' 71h/73h real-time spans would
 * otherwise corrupt into "2.9 days" / "3.04 days"). A bar from one zoned midnight to the zoned
 * midnight N days later reads as exactly N, regardless of how many real hours those days held.
 */
export function civilDaySpan(start: Date, end: Date): number {
  const from = new TZDate(start.getTime(), SYDNEY_TZ);
  const to = new TZDate(end.getTime(), SYDNEY_TZ);
  const fromDay = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const toDay = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((toDay - fromDay) / 86_400_000);
}

// ---------------------------------------------------------------------------------------------
// #219 stage 3 (PR B) calendar fixtures — `CalendarPreview.tsx`'s data. Same anchor convention as
// the Gantt fixtures above (`sydneyMidnight` + `addDays` for whole-day offsets, `sydneyTime` for
// timed instants), reusing the same `SYDNEY_TZ`, `ScenarioId`, `SCENARIOS` and `STAGE_COLORS`. Kept
// in this file (not a sibling) so `fixtures.test.ts` can assert both surfaces' DST invariants
// against one canonical anchor-building implementation.

const CALENDAR_RESOURCES: EventCalendarResource[] = [
  {
    id: "team-alpha",
    title: "Team Alpha",
    children: [
      { id: "shoot-auckland", title: "Auckland Shoot" },
      { id: "shoot-wellington", title: "Wellington Shoot" },
    ],
  },
];

export interface UnscheduledItem {
  id: string;
  title: string;
  durationMinutes: number;
  color: string;
}

export interface CalendarFixture {
  date: Date;
  events: CalendarEvent[];
  resources: EventCalendarResource[];
  /** Items not yet on the calendar — the external-drag tray's source (stage 3 wires the drag). */
  unscheduled: UnscheduledItem[];
}

const UNSCHEDULED: UnscheduledItem[] = [
  { id: "unsched-scout", title: "Location scout", durationMinutes: 90, color: STAGE_COLORS.awaitingRaw },
  { id: "unsched-grade", title: "Colour grade", durationMinutes: 60, color: STAGE_COLORS.editing },
  { id: "unsched-review", title: "Client review", durationMinutes: 30, color: STAGE_COLORS.rawReview },
];

/**
 * One scenario's calendar fixture, anchored the same way `buildFromAnchor` above anchors the
 * Gantt fixture — every whole-day offset via `addDays` on `anchor`, every timed instant via
 * `sydneyTime` on the anchor's own civil Y/M/D (or an `addDays`-derived day's Y/M/D).
 */
function buildCalendarFromAnchor(anchor: TZDate): Omit<CalendarFixture, "date"> {
  const day = (offset: number) => addDays(anchor, offset);
  const y = anchor.getFullYear();
  const m = anchor.getMonth() + 1;
  const d = anchor.getDate();

  const events: CalendarEvent[] = [
    {
      // Multi-day all-day lane packing: an all-day bar spanning the anchor, half-open per
      // `CalendarEvent.end`'s own contract (start inclusive, end exclusive).
      id: "all-day-bar",
      title: "All-day shoot block",
      start: day(-1),
      end: day(2),
      allDay: true,
      resourceId: "shoot-wellington",
      color: STAGE_COLORS.editing,
    },
    {
      // THE vendor defect probe. On the 25-hour autumn day (`dst-autumn`), 23:15 Sydney wall-clock
      // is 1455 elapsed minutes from that day's own Sydney zoned midnight (verified: the autumn
      // day repeats the 2–3am hour, adding 60 minutes on top of 23:15's ordinary 1395; see
      // `fixtures.test.ts`), NOT the wall-clock-looking 1395 and NOT the spec's originally assumed
      // 1440 — that number was checked against a real `node` run before being written here (see
      // this harness's PR B report). `event-calendar-time-grid.tsx` clamps the day's visible bound
      // to `boundsEndMin = Math.min(dayEndHour * 60, totalMinutes)`; with the default
      // `dayEndHour = 24` that is `Math.min(1440, 1500) = 1440`. Since this event's `startMin`
      // (1455) is >= that 1440 bound, `event-calendar-time-grid.tsx`'s own visibility test
      // (`startMin < boundsEndMin`) is false and THE EVENT IS INVISIBLE — on this one calendar day
      // only. This probe exists to make that vendor defect observable; stage 3 (a later PR) fixes
      // it, not this one.
      id: "dst-late-night",
      title: "DST probe: late-night edit (may be invisible — see comment)",
      start: sydneyTime(y, m, d, 23, 15),
      end: sydneyTime(y, m, d, 23, 45),
      resourceId: "shoot-auckland",
      color: STAGE_COLORS.rawReview,
    },
    {
      // Elapsed-vs-wall-clock split. 1:30am -> 3:30am wall clock is always 2 wall-clock hours, but
      // the REAL elapsed span differs by scenario: on `dst-spring` (23h day, clocks skip 2am-3am)
      // it is 1 real hour; on `dst-autumn` (25h day, clocks repeat 2am-3am) it is 3 real hours.
      // Rendered pixel height in a time-grid view that positions by elapsed minutes (not by naive
      // wall-clock difference) should visibly differ between the two scenarios for this same
      // "1:30–3:30" event. Numbers verified with a real `node` run — see `fixtures.test.ts`.
      id: "dst-transition-span",
      title: "DST probe: transition-hour edit",
      start: sydneyTime(y, m, d, 1, 30),
      end: sydneyTime(y, m, d, 3, 30),
      resourceId: "shoot-auckland",
      color: STAGE_COLORS.editing,
    },
    {
      // Segment split across the zoned midnight: built from the anchor day's 22:00 to the NEXT
      // civil day's (via `addDays`, never `+2.5 hours`) 00:30 — so this instant is always the
      // correct Sydney midnight-plus-thirty regardless of which side of a DST transition the
      // anchor day sits on.
      id: "cross-midnight",
      title: "Cross-midnight wrap",
      start: sydneyTime(y, m, d, 22, 0),
      end: (() => {
        const next = day(1);
        return sydneyTime(next.getFullYear(), next.getMonth() + 1, next.getDate(), 0, 30);
      })(),
      resourceId: "shoot-wellington",
      color: STAGE_COLORS.awaitingRaw,
    },
    {
      // Wall-clock 09:00 must survive the transition: `recurrence` steps this weekly series with
      // `addWeeks` on a zoned start, so the fourth (and every) occurrence should still read as
      // 09:00 Sydney wall-clock even though one of the intervening weeks crosses the DST boundary.
      id: "weekly-standup",
      title: "Weekly standup",
      start: sydneyTime(day(-7).getFullYear(), day(-7).getMonth() + 1, day(-7).getDate(), 9, 0),
      end: sydneyTime(day(-7).getFullYear(), day(-7).getMonth() + 1, day(-7).getDate(), 9, 30),
      recurrence: { freq: "weekly", interval: 1, count: 4 },
      resourceId: "shoot-auckland",
      color: STAGE_COLORS.delivered,
    },
    {
      // The vendor's `data-past` chip attribute is derived from the clock alone (see
      // `event-calendar-types.tsx`'s own header). This event IS in the past relative to a real
      // wall clock most of the time this scenario is viewed, but it is deliberately UNFINISHED —
      // completion rides in `data.done`, a Quincy concern, never in the vendor's clock-derived
      // `data-past`.
      id: "past-not-done",
      title: "Past but not done",
      start: sydneyTime(day(-3).getFullYear(), day(-3).getMonth() + 1, day(-3).getDate(), 10, 0),
      end: sydneyTime(day(-3).getFullYear(), day(-3).getMonth() + 1, day(-3).getDate(), 11, 0),
      resourceId: "shoot-wellington",
      color: STAGE_COLORS.awaitingRaw,
      data: { done: false },
    },
    {
      // The other half of the pair: DONE, and deliberately in the FUTURE, so it cannot be
      // confused with the vendor's clock-derived `data-past`. A task finished early is done
      // while still ahead of the clock; this fixture is what proves the harness dims on
      // `data.done` and not on time.
      id: "future-and-done",
      title: "Done ahead of schedule",
      start: sydneyTime(day(2).getFullYear(), day(2).getMonth() + 1, day(2).getDate(), 14, 0),
      end: sydneyTime(day(2).getFullYear(), day(2).getMonth() + 1, day(2).getDate(), 15, 30),
      resourceId: "shoot-auckland",
      color: STAGE_COLORS.delivered,
      data: { done: true },
    },
  ];

  return {
    events,
    resources: CALENDAR_RESOURCES,
    unscheduled: UNSCHEDULED,
  };
}

export function buildCalendarScenario(id: ScenarioId): CalendarFixture {
  if (id === "dst-spring") {
    // First Sunday of October 2026 — Sydney's spring-forward transition (2am -> 3am), 23h day.
    const anchor = sydneyMidnight(2026, 10, 4);
    return { date: anchor, ...buildCalendarFromAnchor(anchor) };
  }
  if (id === "dst-autumn") {
    // First Sunday of April 2026 — Sydney's autumn transition (3am -> 2am), 25h day.
    const anchor = sydneyMidnight(2026, 4, 5);
    return { date: anchor, ...buildCalendarFromAnchor(anchor) };
  }
  const now = new TZDate(Date.now(), SYDNEY_TZ);
  const anchor = sydneyMidnight(now.getFullYear(), now.getMonth() + 1, now.getDate());
  return { date: anchor, ...buildCalendarFromAnchor(anchor) };
}

/**
 * Elapsed minutes from the event's own Sydney zoned midnight — the same quantity the vendor's
 * segmentation computes (`differenceInMinutes(segStart, zonedStartOfDay)` in
 * `event-calendar-lib.tsx`), NOT wall-clock minutes. On an ordinary 24h day these coincide; on a
 * DST transition day they diverge, which is exactly what the `dst-*` probes above exist to show.
 */
export function elapsedMinutesFromZonedMidnight(instant: Date): number {
  const zoned = new TZDate(instant.getTime(), SYDNEY_TZ);
  const midnight = new TZDate(zoned.getFullYear(), zoned.getMonth(), zoned.getDate(), 0, 0, 0, 0, SYDNEY_TZ);
  return differenceInMinutes(zoned, midnight);
}
