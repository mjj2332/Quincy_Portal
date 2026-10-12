import { compareByStreetThenId } from "./dashboard-order";
import type { StageKey } from "./stages";

/** What the fixed Board order reads off a card. Nothing else may influence column order. */
export type BoardCardOrderKey = {
  id: string;
  street: string;
  priority: number | null;
  /** Civil `YYYY-MM-DD`; anything else (null, malformed, impossible date) sorts as "no date". */
  shootDate: string | null;
  /** Epoch ms of the Deadline (#830); null, undefined and non-finite sort as "no deadline". */
  deadlineAt?: number | null;
};

export type BoardCardOrderOptions = {
  /** `false` for viewers whose DTO carries no priority (External Editor): priority must not leak into the order. */
  priorityVisible: boolean;
  /**
   * #830: the viewer's chosen date. When given, Priority does not order the column at all and the
   * chosen date runs oldest first. Omitted only by the deprecated server order maps (removed under
   * #476), which keep the #470 rule.
   */
  date?: "shoot" | "due";
  /**
   * #832: which way the chosen date runs. Omitted = "asc" (oldest first). Applies to the date step
   * only: undated cards stay last and equal dates stay street then id ascending in both directions.
   */
  direction?: "asc" | "desc";
};

/** #832: the one per-Stage source for the date direction (and #833's hint wording). Delivered runs newest first. */
export function boardSortDirectionFor(stageKey: StageKey): "asc" | "desc" {
  return stageKey === "delivered" ? "desc" : "asc";
}

/**
 * #833: the Sort menu's one-line direction hint, built from the same per-Stage source as the order
 * itself and the LIVE Stage labels (the column headings). "Oldest first" is the default direction;
 * each Stage that runs the other way follows by label.
 */
export function boardSortHint(stages: readonly { key: StageKey; label: string }[]): string {
  const reversed = stages.filter((stage) => boardSortDirectionFor(stage.key) === "desc").map((stage) => `${stage.label} newest first`);
  return ["Oldest first", ...reversed].join(" · ");
}

function isLeapYear(year: number) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isCivilShootDate(value: string | null): value is string {
  if (value === null) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day <= days;
}

function isFiniteDeadline(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The Board column order (#470, #830): by default priority 5 down to 1 then unset, then Shoot date oldest first (newest first with `direction: "desc"`, #832)
 * (missing or invalid last), then street and id; with `date` the chosen date alone, then street and id. The server builds the authorised order map with
 * this and the client renders with it, so both sides agree by construction.
 */
export function compareBoardCards(left: BoardCardOrderKey, right: BoardCardOrderKey, options: BoardCardOrderOptions): number {
  const flip = options.direction === "desc" ? -1 : 1;
  if (options.date === "due") {
    const leftDue = isFiniteDeadline(left.deadlineAt);
    const rightDue = isFiniteDeadline(right.deadlineAt);
    if (leftDue !== rightDue) return leftDue ? -1 : 1;
    if (leftDue && rightDue && left.deadlineAt !== right.deadlineAt) return (left.deadlineAt! < right.deadlineAt! ? -1 : 1) * flip;
    return compareByStreetThenId(left, right);
  }
  if (options.priorityVisible && options.date === undefined) {
    const byPriority = (right.priority ?? 0) - (left.priority ?? 0);
    if (byPriority !== 0) return byPriority;
  }
  const leftDated = isCivilShootDate(left.shootDate);
  const rightDated = isCivilShootDate(right.shootDate);
  if (leftDated !== rightDated) return leftDated ? -1 : 1;
  if (leftDated && rightDated && left.shootDate !== right.shootDate) return (left.shootDate! < right.shootDate! ? -1 : 1) * flip;
  return compareByStreetThenId(left, right);
}
