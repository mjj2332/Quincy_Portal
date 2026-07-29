export type DashboardView = "kanban" | "list";
export type KanbanSortMode = "board" | "shootDate-asc" | "shootDate-desc";

export type DashboardPreferenceStorage = {
  read: () => string | null;
  write: (view: DashboardView) => void;
};

export type KanbanSortPreferenceStorage = {
  read: () => string | null;
  write: (value: KanbanSortMode) => void;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function normalizeDashboardView(value: string | null): DashboardView {
  return value === "list" || value === "kanban" ? value : "kanban";
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
  return value === "shootDate-asc" || value === "shootDate-desc" ? value : "board";
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
