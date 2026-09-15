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
export type DashboardView = "kanban" | "list" | "calendar";
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
};

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
  return value === "list" || value === "kanban" || value === "calendar" ? value : "kanban";
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
 * This is now only the pre-mount fallback (#119): once a Dashboard instance exists it publishes
 * the view it is actually rendering (`lib/dashboard-view-store.ts`), and the shell follows that
 * publication instead of resolving this per location. Before #119 the shell called this on every
 * location change instead — a snapshot taken once at mount went stale the moment a Staff member
 * switched view — which is why it is still a read with no caching of its own rather than a value
 * computed once; the caller that has stopped calling it every render is the change, not this.
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

function sydneyToday(now: Date | number | string): string {
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
  { now, isPhone }: DashboardCalendarInitializationOptions,
): DashboardCalendarInitialState {
  const calendar = route.kind === "dashboard" && "calendar" in route ? route.calendar : undefined;
  if (calendar) return calendar;

  const savedSubview = normalizeDashboardCalendarSubview(readCalendarPreference(storage, DASHBOARD_CALENDAR_SUBVIEW_KEY));
  const savedDate = readCalendarPreference(storage, DASHBOARD_CALENDAR_LAST_DATE_KEY);
  const subview = savedSubview ?? (isPhone ? "agenda" : "month");
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
