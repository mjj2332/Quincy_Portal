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
import { addDays, format } from "date-fns";
import type { GanttEvent, GanttResource, GanttScale } from "@/components/reui/gantt/gantt-types";

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

/** Existing app-wide stage/semantic tokens (`components/atoms.tsx`'s `stageColors`) — never invented ones. */
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
