export type DashboardView = "kanban" | "list";

export type DashboardPreferenceStorage = {
  read: () => string | null;
  write: (view: DashboardView) => void;
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

export function formatDashboardDate(value: string | null): string {
  if (value === null) return "Shoot date pending";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return value;
  return `${day} ${MONTHS[month - 1]} ${year}`;
}
