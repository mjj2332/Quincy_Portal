import {
  formatSydneyCivilMinute,
  isSydneyCalendarDate,
  normalizeProductionCalendarSearch,
  productionCalendarFiltersSchema,
  PRODUCTION_CALENDAR_SUBVIEWS,
  type DashboardCalendarFacetRoute,
  type DashboardCalendarState,
  type StaffRoute,
} from "@quincy/shared";

/**
 * The Board rendered at `view=kanban` (and the Dashboard's default) is `ProjectKanbanBoard2`
 * (`components/kanban2/board.tsx`), ReUI `kanban-board-3`, cut over in #83. The original Board it
 * replaced, and the `kanban2` comparison value this type and the route grammar once carried for
 * #80, are both retired — see `docs/lessons.md` for the cutover.
 */
export type DashboardView = "kanban" | "list" | "gantt" | "calendar";
export type KanbanSortMode = "board" | "priority" | "shootDate-asc" | "shootDate-desc";

export const DASHBOARD_CALENDAR_SUBVIEW_KEY = "quincy:dashboard:calendar:subview";
export const DASHBOARD_CALENDAR_LAST_DATE_KEY = "quincy:dashboard:calendar:last-date";

export type DashboardCalendarPreferenceStorage = {
  read: (key: string) => string | null;
  write?: (key: string, value: string) => void;
};

export type DashboardCalendarInitialState = DashboardCalendarState;

export type DashboardCalendarInitializationOptions = {
  now: Date | number | string;
  isPhone: boolean;
  /** #222: which renderer will draw the state; defaults to `CALENDAR_RENDERER_DEFAULT`. */
  renderer?: CalendarRenderer;
};

/**
 * #222: which component renders the Dashboard Calendar. A RENDERER preference — not a route, not a
 * capability: both renderers read the same URL facet and the same `/api/production-calendar`. The
 * new ReUI event-calendar is opt-in per browser via `localStorage[DASHBOARD_CALENDAR_RENDERER_KEY]
 * = "event-calendar"`; #223 flips `CALENDAR_RENDERER_DEFAULT`.
 */
export type CalendarRenderer = "fullcalendar" | "event-calendar";
export const CALENDAR_RENDERER_DEFAULT: CalendarRenderer = "fullcalendar";
export const DASHBOARD_CALENDAR_RENDERER_KEY = "quincy:dashboard:calendar:renderer";

export type DashboardPreferenceStorage = {
  read: () => string | null;
  write: (view: DashboardView) => void;
};

export type KanbanSortPreferenceStorage = {
  read: () => string | null;
  write: (value: KanbanSortMode) => void;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dashboardCalendarFilterDefaults = productionCalendarFiltersSchema.parse({});

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function normalizeDashboardView(value: string | null): DashboardView {
  return value === "list" || value === "kanban" || value === "gantt" || value === "calendar" ? value : "kanban";
}

export const DASHBOARD_VIEW_KEY = "quincy:dashboard:view";

/**
 * The read half of the remembered Dashboard view, with no write of any kind (#111).
 *
 * `initializeDashboardView` below performs a one-time grid-to-kanban migration write, which is
 * correct for the Dashboard — it owns the preference — but wrong for a second caller: the
 * navigation model must read no storage at all, and the shell that feeds it must not race the
 * Dashboard for the same migration. So the shell resolves the view through this function and
 * passes the value in, leaving `initializeDashboardView` exactly one caller and exactly one write.
 *
 * This is now only the pre-mount fallback (#119). The shell still calls this on every model
 * recompute — it has not stopped — but the value it returns is used only while nothing has
 * published (`lib/dashboard-view-store.ts`): once a Dashboard instance exists, its own publication
 * is authoritative and this read is ignored.
 */
export function readRememberedDashboardView(storage: Pick<DashboardPreferenceStorage, "read">): DashboardView {
  try {
    return normalizeDashboardView(storage.read());
  } catch {
    // Browser storage can be unavailable or throw on read under privacy settings; the default view
    // is a better answer than propagating that into navigation chrome.
    return "kanban";
  }
}

/**
 * Reads the preference before attempting its one-time grid-to-kanban migration.
 * Browser storage can be partially available (a read may succeed while a write
 * fails), so a failed migration must not discard a valid saved preference.
 */
export function initializeDashboardView(storage: DashboardPreferenceStorage): DashboardView {
  let view: DashboardView;
  try {
    view = normalizeDashboardView(storage.read());
  } catch {
    return "kanban";
  }
  try {
    storage.write(view);
  } catch {
    // Storage quotas/privacy settings can reject writes after a successful read.
  }
  return view;
}

export function normalizeKanbanSortMode(value: string | null): KanbanSortMode {
  return value === "priority" || value === "shootDate-asc" || value === "shootDate-desc" ? value : "board";
}

export function initializeKanbanSortMode(storage: KanbanSortPreferenceStorage): KanbanSortMode {
  let mode: KanbanSortMode;
  try {
    mode = normalizeKanbanSortMode(storage.read());
  } catch {
    return "board";
  }
  try {
    storage.write(mode);
  } catch {
    // Storage quotas/privacy settings can reject writes after a successful read.
  }
  return mode;
}

export function normalizeDashboardCalendarSubview(value: string | null): DashboardCalendarState["subview"] | null {
  return value !== null && PRODUCTION_CALENDAR_SUBVIEWS.includes(value as DashboardCalendarState["subview"])
    ? value as DashboardCalendarState["subview"]
    : null;
}

export function isCanonicalCalendarDate(value: string | null): value is string {
  return value !== null && isSydneyCalendarDate(value);
}

/** Strip only the route contract's unsafe characters from live input state. */
export function sanitizeDashboardCalendarSearch(value: string): string {
  return value.replace(/[\\\u0000-\u001f\u007f]/gu, "");
}

/** Normalize only the debounced/API query value; live input keeps its spaces. */
export function normalizeDashboardCalendarSearch(value: string): string {
  return normalizeProductionCalendarSearch(value);
}

function readCalendarPreference(storage: DashboardCalendarPreferenceStorage, key: string): string | null {
  try {
    return storage.read(key);
  } catch {
    return null;
  }
}

function writeCalendarPreference(storage: DashboardCalendarPreferenceStorage, key: string, value: string): void {
  try {
    storage.write?.(key, value);
  } catch {
    // A valid read must survive a quota/privacy failure during migration.
  }
}

/** #222: only the exact opt-in value selects the new renderer; anything else (or a throwing read) is the default. */
export function readCalendarRenderer(storage: DashboardCalendarPreferenceStorage): CalendarRenderer {
  return readCalendarPreference(storage, DASHBOARD_CALENDAR_RENDERER_KEY) === "event-calendar" ? "event-calendar" : CALENDAR_RENDERER_DEFAULT;
}

/** #222: best-effort, like every other Calendar preference write. */
export function writeCalendarRenderer(storage: DashboardCalendarPreferenceStorage, renderer: CalendarRenderer): void {
  writeCalendarPreference(storage, DASHBOARD_CALENDAR_RENDERER_KEY, renderer);
}

/**
 * #222: FullCalendar has no `day`/`days` view (its `viewForSubview` would fall through to a list),
 * so with the flag off those two subviews — from a URL shared by an opted-in browser, or a
 * remembered preference — read as `week`, the nearest view it does draw.
 */
export function coerceCalendarSubviewForRenderer(
  subview: DashboardCalendarState["subview"],
  renderer: CalendarRenderer,
): DashboardCalendarState["subview"] {
  return renderer === "fullcalendar" && (subview === "day" || subview === "days") ? "week" : subview;
}

/** Sydney's civil date (`YYYY-MM-DD`) at `now`. */
export function sydneyToday(now: Date | number | string): string {
  const value = formatSydneyCivilMinute(now instanceof Date ? now.getTime() : now).slice(0, 10);
  return isSydneyCalendarDate(value) ? value : "1970-01-01";
}

/**
 * Resolve the first Calendar date/subview without touching browser globals.
 * A parsed URL owns both values. Without one, remembered client preferences win
 * over the phone/desktop defaults and Sydney today. The optional writes mirror
 * the existing dashboard preference migration and are deliberately best-effort.
 */
export function initializeDashboardCalendarState(
  route: StaffRoute | DashboardCalendarFacetRoute,
  storage: DashboardCalendarPreferenceStorage,
  { now, isPhone, renderer = CALENDAR_RENDERER_DEFAULT }: DashboardCalendarInitializationOptions,
): DashboardCalendarInitialState {
  const calendar = route.kind === "dashboard" && "calendar" in route ? route.calendar : undefined;
  if (calendar) {
    const subview = coerceCalendarSubviewForRenderer(calendar.subview, renderer);
    return subview === calendar.subview ? calendar : { ...calendar, subview };
  }

  const savedSubview = normalizeDashboardCalendarSubview(readCalendarPreference(storage, DASHBOARD_CALENDAR_SUBVIEW_KEY));
  const savedDate = readCalendarPreference(storage, DASHBOARD_CALENDAR_LAST_DATE_KEY);
  const subview = savedSubview ? coerceCalendarSubviewForRenderer(savedSubview, renderer) : (isPhone ? "agenda" : "month");
  const date = isCanonicalCalendarDate(savedDate) ? savedDate : sydneyToday(now);
  writeCalendarPreference(storage, DASHBOARD_CALENDAR_SUBVIEW_KEY, subview);
  writeCalendarPreference(storage, DASHBOARD_CALENDAR_LAST_DATE_KEY, date);
  return { view: "calendar", date, subview, ...dashboardCalendarFilterDefaults };
}

function parseCanonicalShootDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function isCanonicalShootDate(value: string | null): value is string {
  return value !== null && parseCanonicalShootDate(value) !== null;
}

export function formatDashboardDate(value: string | null): string {
  if (value === null) return "Shoot date pending";
  const parsed = parseCanonicalShootDate(value);
  if (!parsed) return value;
  return `${parsed.day} ${MONTHS[parsed.month - 1]} ${parsed.year}`;
}

/**
 * #217. Where focus goes after the search chip's Clear button unmounts itself: a control that
 * SURVIVES the clear. The active view button first; it is absent in archived scope and
 * unfocusable while disabled (`interactionBlocked`), so the active scope button is next, and the
 * toolbar itself (`tabIndex={-1}`) is the target that always exists.
 */
export function focusTargetAfterClearingSearch(toolbar: HTMLElement | null): HTMLElement | null {
  if (!toolbar) return null;
  return toolbar.querySelector<HTMLElement>('[data-focus-key^="dashboard-view-"][data-active="true"]:not(:disabled)')
    ?? toolbar.querySelector<HTMLElement>("button.is-active:not(:disabled)")
    ?? toolbar;
}
