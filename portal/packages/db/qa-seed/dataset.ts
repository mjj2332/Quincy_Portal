/**
 * QA scheduling fixture — the dataset (#220 follow-on, `harness/reui-scheduling/fixtures.ts`'s
 * sibling for local D1 rather than the ReUI mock harness). Pure: no filesystem, no environment, no
 * `Date.now()`/`unixepoch('now')` anywhere in the values it produces — everything is either a
 * fixed literal or derived from an explicit `anchor` civil date, so two runs against the same
 * anchor emit byte-identical statements (`qa-seed-wiring.guard.test.ts` and
 * `qa-seed-coverage.test.ts` both depend on that).
 *
 * Every subtask's `ChecklistScheduleStorage` is produced by `normalizeChecklistSchedule` (thrown on
 * `ok: false`) and round-tripped through `serializeChecklistSchedule` to assert the state it claims
 * to build — except the four deliberate `legacy_unresolved`/legacy `due_only` rows in the
 * schedule-edges project, which bypass normalization on purpose (the legacy free-text `due_date`
 * column was never normalized when the app itself wrote it) and are asserted the same way, directly
 * against `serializeChecklistSchedule`.
 */
import {
  PROJECT_ASSIGNMENT_ELIGIBLE_ROLES,
  PROJECT_DEADLINE_PRESETS,
  STAGE_KEYS,
  deadlineFireAt,
  isSydneyCalendarDate,
  normalizeChecklistSchedule,
  resolveSydneyCivilMinute,
  serializeChecklistSchedule,
  shiftSydneyCalendarDate,
  sydneyCivilParts,
  type ChecklistScheduleStorage,
  type InitialChecklistScheduleInput,
  type StageKey,
} from "@quincy/shared";
import { fixtureId } from "./ids";

export type QaTier = "core" | "density";
export { type StageKey };

/** The one user this fixture's rows are ever attributed to (`created_by`, `archived_by` is never
 * set). Matches `seed/0001_seed.sql`'s bootstrap admin — every environment that has run the shared
 * seed has this row, so every fixture-carrying database has a valid FK target. */
export const BOOTSTRAP_ADMIN_ID = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";

/** Re-exported so `cli.mjs`'s default-editor preflight query and
 * `qa-seed-wiring.guard.test.ts` both check the identical predicate the shared package defines —
 * neither one hand-copies the role list. */
export const DEFAULT_EDITOR_ELIGIBLE_ROLES: readonly string[] = PROJECT_ASSIGNMENT_ELIGIBLE_ROLES.editor;

// ---------------------------------------------------------------------------
// Anchor + DST transitions
// ---------------------------------------------------------------------------

function mustShift(date: string, deltaDays: number): string {
  const shifted = shiftSydneyCalendarDate(date, deltaDays);
  if (!shifted.ok) throw new Error(`Could not shift ${date} by ${deltaDays} days: ${shifted.error.message}`);
  return shifted.value;
}

/** Monday of the current Sydney ISO week, date-only (no time-of-day dependency beyond "which
 * calendar day is it in Sydney right now"). Not memoised — callers pass an explicit `--anchor` in
 * CI or for a reproducible run; this is only the zero-argument default for local interactive use. */
function currentSydneyMondayIso(now: Date): string {
  const parts = sydneyCivilParts(now);
  const dateStr = `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Australia/Sydney", weekday: "short" }).format(now);
  const isoWeekdayByShortName: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const isoWeekday = isoWeekdayByShortName[weekday];
  if (!isoWeekday) throw new Error(`Unrecognised Sydney weekday formatting: ${weekday}`);
  return mustShift(dateStr, -(isoWeekday - 1));
}

/** Validates and returns the anchor, or computes this week's Sydney Monday if omitted. */
export function resolveAnchor(anchorArg: string | undefined): string {
  if (anchorArg === undefined) return currentSydneyMondayIso(new Date());
  if (!isSydneyCalendarDate(anchorArg)) throw new Error(`--anchor must be a valid YYYY-MM-DD calendar date, got ${JSON.stringify(anchorArg)}.`);
  return anchorArg;
}

/** A small committed cross-check, not the source of truth — the source of truth is the Intl scan
 * below. Sydney/Melbourne DST: starts first Sunday in October, ends first Sunday in April. If the
 * scan below ever disagrees with this table for a year present here, that is a real bug (a change
 * to the underlying tzdata rules, or a defect in the scan), not something to silently trust either
 * side on — `resolveDstTransitions` throws rather than picking one. */
const KNOWN_SYDNEY_TRANSITIONS: ReadonlyArray<{ date: string; kind: "spring" | "fall" }> = [
  { date: "2024-10-06", kind: "spring" }, { date: "2025-04-06", kind: "fall" },
  { date: "2025-10-05", kind: "spring" }, { date: "2026-04-05", kind: "fall" },
  { date: "2026-10-04", kind: "spring" }, { date: "2027-04-04", kind: "fall" },
  { date: "2027-10-03", kind: "spring" }, { date: "2028-04-02", kind: "fall" },
];

function sydneyNoonUtcOffsetMinutes(dateIso: string): number {
  const resolved = resolveSydneyCivilMinute(`${dateIso}T12:00`);
  if (!resolved.ok) throw new Error(`Could not resolve a noon offset for ${dateIso}: ${resolved.message}`);
  return resolved.value.utcOffsetMinutes;
}

function findNextSydneyTransition(anchorDateIso: string, kind: "spring" | "fall"): string {
  let cursor = anchorDateIso;
  let previousOffset = sydneyNoonUtcOffsetMinutes(cursor);
  for (let step = 0; step < 400; step += 1) {
    cursor = mustShift(cursor, 1);
    const offset = sydneyNoonUtcOffsetMinutes(cursor);
    if (kind === "spring" && offset > previousOffset) return cursor;
    if (kind === "fall" && offset < previousOffset) return cursor;
    previousOffset = offset;
  }
  throw new Error(`No ${kind} DST transition found within 400 days of ${anchorDateIso}.`);
}

/** The next spring-forward and fall-back transition strictly after `anchor`, computed via `Intl`
 * (through `resolveSydneyCivilMinute`) rather than trusted from `KNOWN_SYDNEY_TRANSITIONS` — that
 * table is only a cross-check, thrown on disagreement. */
export function resolveDstTransitions(anchor: string): { spring: string; fall: string } {
  const spring = findNextSydneyTransition(anchor, "spring");
  const fall = findNextSydneyTransition(anchor, "fall");
  for (const [computed, kind] of [[spring, "spring"], [fall, "fall"]] as const) {
    const known = KNOWN_SYDNEY_TRANSITIONS.find((t) => t.date === computed);
    if (known && known.kind !== kind) throw new Error(`Computed ${kind} transition ${computed} disagrees with the committed cross-check table (which says ${known.kind}).`);
  }
  return { spring, fall };
}

// ---------------------------------------------------------------------------
// Schedule construction helpers
// ---------------------------------------------------------------------------

function normalizedSchedule(input: InitialChecklistScheduleInput, version: number, expectedState: "unscheduled" | "due_only" | "range"): ChecklistScheduleStorage {
  const result = normalizeChecklistSchedule(input, version);
  if (!result.ok) throw new Error(`normalizeChecklistSchedule rejected ${JSON.stringify(input)} (v${version}): ${result.error.message}`);
  const storage: ChecklistScheduleStorage = { ...result.value };
  const dto = serializeChecklistSchedule(storage);
  if (dto.state !== expectedState) throw new Error(`Round-trip mismatch building ${JSON.stringify(input)}: expected ${expectedState}, got ${dto.state}.`);
  return storage;
}

const EMPTY_SCHEDULE_FIELDS = {
  scheduleStartKind: null, scheduleStartCivil: null, scheduleStartAt: null, scheduleStartUtcOffsetMinutes: null, scheduleStartFold: null,
  scheduleEndKind: null, scheduleEndAt: null, scheduleEndUtcOffsetMinutes: null, scheduleEndFold: null, scheduleZone: null,
} as const;

function legacySchedule(dueDate: string, expectedState: "due_only" | "legacy_unresolved"): ChecklistScheduleStorage {
  const storage: ChecklistScheduleStorage = { dueDate, ...EMPTY_SCHEDULE_FIELDS, scheduleVersion: 0 };
  const dto = serializeChecklistSchedule(storage);
  if (dto.state !== expectedState) throw new Error(`Legacy round-trip mismatch for ${JSON.stringify(dueDate)}: expected ${expectedState}, got ${dto.state}.`);
  return storage;
}

const UNSCHEDULED_V0 = normalizedSchedule({ state: "unscheduled" }, 0, "unscheduled");

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export type FixtureDeadline = { localCivil: string; utcOffsetMinutes: number; fold: 0 | 1; epochMs: number; offsetsMinutes: readonly number[] };

export type FixtureProjectRow = {
  id: string; key: string; street: string; suburb: string; agencyName: string; stageKey: StageKey;
  priority: number | null; shootDate: string | null; boardRevision: number; notes: string;
  deadline: FixtureDeadline | null; services: readonly string[]; createdAtMs: number; updatedAtMs: number;
};

export type FixtureSubtaskRow = {
  id: string; projectId: string; projectKey: string; title: string; done: boolean; index: number;
  storage: ChecklistScheduleStorage; createdAtMs: number; updatedAtMs: number;
};

export type FixtureCollectionRow = { id: string; projectId: string; kind: string; createdAtMs: number; updatedAtMs: number };
export type FixtureOccurrenceRow = {
  id: string; projectId: string; scheduleVersion: number; kind: "advance" | "due_now"; reminderOffsetMinutes: number;
  fireAt: number; deadlineAt: number; deadlineLocalCivil: string; deadlineUtcOffsetMinutes: number; deadlineFold: 0 | 1;
  status: "pending" | "skipped"; terminalReason: "elapsed_at_save" | null; createdAtMs: number; updatedAtMs: number;
};
export type FixtureMemberRow = { id: string; projectId: string; userId: string; createdAtMs: number };

export type QaFixtureDataset = {
  anchor: string; tiers: QaTier[]; projects: FixtureProjectRow[]; subtasks: FixtureSubtaskRow[];
  collections: FixtureCollectionRow[]; deadlineOccurrences: FixtureOccurrenceRow[]; members: FixtureMemberRow[];
};

// ---------------------------------------------------------------------------
// Timing — every instant is anchor-relative, never Date.now(). `referenceInstantMs` (anchor's own
// 09:00 Sydney instant) stands in for "now" when classifying a deadline occurrence as pending vs.
// already-elapsed (mirrors `project-deadline.ts:~228`'s `fireAt <= now` check without ever reading
// the real clock) — accurate for any apply that runs the same week as its anchor, which every real
// run does, since a stale anchor is rejected nowhere but is always freshly resolved by default.
// ---------------------------------------------------------------------------

function anchorReferenceInstantMs(anchor: string): number {
  const resolved = resolveSydneyCivilMinute(`${anchor}T09:00`);
  if (!resolved.ok) throw new Error(`Could not resolve the anchor reference instant: ${resolved.message}`);
  return resolved.value.epochMs;
}

function projectCreatedAtMs(base: number, index: number): number {
  // Spaced an hour apart, always strictly before the anchor reference instant — a project cannot
  // have been created in the future relative to "now".
  return base - (200 - index) * 3_600_000;
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

function buildDeadline(localCivil: string): FixtureDeadline {
  const resolved = resolveSydneyCivilMinute(localCivil);
  if (!resolved.ok) throw new Error(`Could not resolve deadline ${localCivil}: ${resolved.message}`);
  return { localCivil, utcOffsetMinutes: resolved.value.utcOffsetMinutes, fold: resolved.value.fold, epochMs: resolved.value.epochMs, offsetsMinutes: PROJECT_DEADLINE_PRESETS };
}

function buildDeadlineOccurrences(projectId: string, deadline: FixtureDeadline, referenceInstantMs: number, createdAtMs: number): FixtureOccurrenceRow[] {
  const rows: FixtureOccurrenceRow[] = [];
  const push = (kind: "advance" | "due_now", offsetMinutes: number) => {
    const fireAt = deadlineFireAt(deadline.epochMs, offsetMinutes);
    const pending = fireAt > referenceInstantMs;
    rows.push({
      id: fixtureId(`occurrence:${projectId}:${kind}:${offsetMinutes}`), projectId, scheduleVersion: 1, kind, reminderOffsetMinutes: offsetMinutes,
      fireAt, deadlineAt: deadline.epochMs, deadlineLocalCivil: deadline.localCivil, deadlineUtcOffsetMinutes: deadline.utcOffsetMinutes, deadlineFold: deadline.fold,
      status: pending ? "pending" : "skipped", terminalReason: pending ? null : "elapsed_at_save", createdAtMs, updatedAtMs: createdAtMs,
    });
  };
  for (const offset of deadline.offsetsMinutes) push("advance", offset);
  push("due_now", 0);
  return rows;
}

// ---------------------------------------------------------------------------
// Bulk (board-shape) subtasks — deliberately plain: every schedule-state variety lives in the
// schedule-edges project below, so these can stay cheap to build at fixture scale (up to 260 rows).
// ---------------------------------------------------------------------------

function bulkSubtasks(projectId: string, projectKey: string, total: number, doneCount: number, baseCreatedAtMs: number): FixtureSubtaskRow[] {
  if (doneCount > total) throw new Error(`doneCount (${doneCount}) cannot exceed total (${total}) for ${projectKey}.`);
  const rows: FixtureSubtaskRow[] = [];
  for (let index = 0; index < total; index += 1) {
    const done = index < doneCount;
    const createdAtMs = baseCreatedAtMs + index * 1_000;
    rows.push({
      id: fixtureId(`subtask:${projectKey}:${index}`), projectId, projectKey,
      title: `QA fixture subtask ${String(index + 1).padStart(3, "0")}/${total}`,
      done, index, storage: UNSCHEDULED_V0, createdAtMs, updatedAtMs: done ? createdAtMs + 61_000 : createdAtMs,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The schedule-edges project — every state/endpoint-kind/legacy-reason combination the checklist
// schedule contract supports, per `checklist-schedule.ts` and the DST canary requirement.
// ---------------------------------------------------------------------------

type ScheduleEdgeRow = { titleSuffix: string; storage: ChecklistScheduleStorage; done?: boolean };

function buildScheduleEdgeRows(anchor: string, dst: { spring: string; fall: string }): ScheduleEdgeRow[] {
  const plus = (n: number) => mustShift(anchor, n);
  const dayBefore = (date: string) => mustShift(date, -1);
  return [
    { titleSuffix: "unscheduled (cleared, v1)", storage: normalizedSchedule({ state: "unscheduled" }, 1, "unscheduled") },
    { titleSuffix: "unscheduled (new, v0)", storage: UNSCHEDULED_V0 },
    { titleSuffix: "due date milestone", storage: normalizedSchedule({ state: "due_only", end: { kind: "date", localCivil: plus(10) } }, 1, "due_only"), done: true },
    { titleSuffix: "due timed milestone", storage: normalizedSchedule({ state: "due_only", end: { kind: "timed", localCivil: `${plus(10)}T14:00` } }, 1, "due_only") },
    { titleSuffix: "all-day range", storage: normalizedSchedule({ state: "range", start: { kind: "date", localCivil: plus(5) }, end: { kind: "date", localCivil: plus(8) } }, 1, "range"), done: true },
    { titleSuffix: "timed range", storage: normalizedSchedule({ state: "range", start: { kind: "timed", localCivil: `${plus(5)}T09:00` }, end: { kind: "timed", localCivil: `${plus(5)}T17:00` } }, 1, "range") },
    { titleSuffix: "spring-forward day range (23h)", storage: normalizedSchedule({ state: "range", start: { kind: "date", localCivil: dst.spring }, end: { kind: "date", localCivil: dst.spring } }, 1, "range") },
    { titleSuffix: "fall-back day range (25h)", storage: normalizedSchedule({ state: "range", start: { kind: "date", localCivil: dst.fall }, end: { kind: "date", localCivil: dst.fall } }, 1, "range"), done: true },
    { titleSuffix: "timed range across the gap (tight)", storage: normalizedSchedule({ state: "range", start: { kind: "timed", localCivil: `${dst.spring}T01:30` }, end: { kind: "timed", localCivil: `${dst.spring}T03:30` } }, 1, "range") },
    { titleSuffix: "timed range across the gap (overnight)", storage: normalizedSchedule({ state: "range", start: { kind: "timed", localCivil: `${dayBefore(dst.spring)}T22:00` }, end: { kind: "timed", localCivil: `${dst.spring}T06:00` } }, 1, "range") },
    { titleSuffix: "timed range across the fold", storage: normalizedSchedule({ state: "range", start: { kind: "timed", localCivil: `${dst.fall}T01:30` }, end: { kind: "timed", localCivil: `${dst.fall}T03:30` } }, 1, "range") },
    { titleSuffix: "Fold canary — earlier", storage: normalizedSchedule({ state: "due_only", end: { kind: "timed", localCivil: `${dst.fall}T02:30`, disambiguation: "earlier" } }, 1, "due_only") },
    { titleSuffix: "Fold canary — later", storage: normalizedSchedule({ state: "due_only", end: { kind: "timed", localCivil: `${dst.fall}T02:30`, disambiguation: "later" } }, 1, "due_only") },
    { titleSuffix: "legacy due date (stored, valid)", storage: legacySchedule(plus(40), "due_only") },
    { titleSuffix: "legacy due date (invalid literal)", storage: legacySchedule("next Tuesday", "legacy_unresolved") },
    { titleSuffix: "legacy due date (repeated local time)", storage: legacySchedule(`${dst.fall}T02:30`, "legacy_unresolved") },
    { titleSuffix: "legacy due date (nonexistent local time)", storage: legacySchedule(`${dst.spring}T02:30`, "legacy_unresolved") },
  ];
}

// ---------------------------------------------------------------------------
// Core tier — P01-P10
// ---------------------------------------------------------------------------

type ProjectBuild = { project: FixtureProjectRow; subtasks: FixtureSubtaskRow[] };

function buildCoreTier(anchor: string, referenceInstantMs: number): ProjectBuild[] {
  const dst = resolveDstTransitions(anchor);
  const builds: ProjectBuild[] = [];
  let projectIndex = 0;

  function project(key: string, street: string, stageKey: StageKey, opts: {
    priority?: number; shootDate?: string | null; deadlineLocalCivil?: string; deadlineBeforeStart?: boolean;
  } = {}): { project: FixtureProjectRow; createdAtMs: number } {
    const createdAtMs = projectCreatedAtMs(referenceInstantMs, projectIndex);
    projectIndex += 1;
    const deadline = opts.deadlineLocalCivil !== undefined ? buildDeadline(opts.deadlineLocalCivil) : null;
    const row: FixtureProjectRow = {
      id: fixtureId(`project:${key}`), key, street: `QA FIXTURE · ${street}`, suburb: "QA Fixtures",
      agencyName: "QA Fixture — synthetic data", stageKey, priority: opts.priority ?? null,
      shootDate: opts.shootDate === undefined ? null : opts.shootDate, boardRevision: stageKey === "awaiting_raw" ? 0 : 1,
      notes: `QA-FIXTURE-v1 · anchor=${anchor} · tier=core · key=${key}`, deadline, services: ["raw"],
      createdAtMs, updatedAtMs: createdAtMs,
    };
    return { project: row, createdAtMs };
  }

  // P01 — pagination: far more not-done rows than 2x the child page limit.
  {
    const { project: p, createdAtMs } = project("pagination", "Pagination 260", "awaiting_raw", { priority: 1, shootDate: mustShift(anchor, 3) });
    builds.push({ project: p, subtasks: bulkSubtasks(p.id, p.key, 260, 0, createdAtMs) });
  }
  // P02 — near-complete: completed === total - 1.
  {
    const { project: p, createdAtMs } = project("near-complete", "Near-complete 199 of 200", "raw_review", { priority: 2, shootDate: mustShift(anchor, 6) });
    builds.push({ project: p, subtasks: bulkSubtasks(p.id, p.key, 200, 199, createdAtMs) });
  }
  // P03 — complete: completed === total > 0.
  {
    const { project: p, createdAtMs } = project("complete", "Complete 40 of 40", "edited_review", { priority: 3, shootDate: mustShift(anchor, -4) });
    builds.push({ project: p, subtasks: bulkSubtasks(p.id, p.key, 40, 40, createdAtMs) });
  }
  // P04 — zero: completed === 0 && total > 0.
  {
    const { project: p, createdAtMs } = project("zero", "Zero progress", "editing_autohdr", { priority: 4, shootDate: mustShift(anchor, 1) });
    builds.push({ project: p, subtasks: bulkSubtasks(p.id, p.key, 12, 0, createdAtMs) });
  }
  // P05 — delivered: the app's own deadline UPDATE predicate excludes stage_key = 'delivered', so
  // a delivered project never carries a deadline through the normal app flow — this one doesn't either.
  {
    const { project: p, createdAtMs } = project("delivered", "Delivered", "delivered", { priority: 5, shootDate: mustShift(anchor, -10) });
    builds.push({ project: p, subtasks: bulkSubtasks(p.id, p.key, 6, 3, createdAtMs) });
  }
  // P06 — schedule-edges: the full checklist-schedule state/endpoint/legacy-reason/DST census.
  {
    const { project: p, createdAtMs } = project("schedule-edges", "Schedule edges", "raw_review", { shootDate: mustShift(anchor, 2) });
    const edgeRows = buildScheduleEdgeRows(anchor, dst);
    const subtasks: FixtureSubtaskRow[] = edgeRows.map((row, index) => {
      const rowCreatedAtMs = createdAtMs + index * 1_000;
      return {
        id: fixtureId(`subtask:schedule-edges:${index}`), projectId: p.id, projectKey: p.key,
        title: `QA fixture — ${row.titleSuffix}`, done: Boolean(row.done), index, storage: row.storage,
        createdAtMs: rowCreatedAtMs, updatedAtMs: row.done ? rowCreatedAtMs + 61_000 : rowCreatedAtMs,
      };
    });
    builds.push({ project: p, subtasks });
  }
  // P07 — no deadline, no shoot date.
  {
    const { project: p, createdAtMs } = project("no-deadline-no-shoot", "No deadline no shoot", "awaiting_raw", { shootDate: null });
    builds.push({ project: p, subtasks: bulkSubtasks(p.id, p.key, 5, 0, createdAtMs) });
  }
  // P08 — hollow start (no shoot date) with a deadline.
  {
    const { project: p, createdAtMs } = project("hollow-start", "Hollow start", "editing_autohdr", { shootDate: null, deadlineLocalCivil: `${mustShift(anchor, 14)}T17:00` });
    builds.push({ project: p, subtasks: bulkSubtasks(p.id, p.key, 5, 1, createdAtMs) });
  }
  // P09 — deadline strictly before the shoot-date start.
  {
    const { project: p, createdAtMs } = project("deadline-before-start", "Deadline before start", "edited_review", { shootDate: mustShift(anchor, 10), deadlineLocalCivil: `${mustShift(anchor, 2)}T09:00` });
    builds.push({ project: p, subtasks: bulkSubtasks(p.id, p.key, 5, 0, createdAtMs) });
  }
  // P10 — invalid shoot_date literal (2026 is not a leap year, so Feb 30 is always out of range).
  {
    const { project: p, createdAtMs } = project("invalid-shoot-date", "Invalid shoot date", "raw_review", { shootDate: "2026-02-30" });
    builds.push({ project: p, subtasks: bulkSubtasks(p.id, p.key, 5, 0, createdAtMs) });
  }

  return builds;
}

// ---------------------------------------------------------------------------
// Density tier — enough rows that `matchedRows` (projects + visible children, mirroring
// `production-gantt.ts`'s `density_candidates`) exceeds `PRODUCTION_GANTT_DRAW_CAP`, while a
// single-stage filter brings it back under the cap.
// ---------------------------------------------------------------------------

const DENSITY_PROJECT_COUNT = 30;
const DENSITY_SUBTASKS_PER_PROJECT = 70;

function buildDensityTier(anchor: string, referenceInstantMs: number): ProjectBuild[] {
  const builds: ProjectBuild[] = [];
  const densityBase = referenceInstantMs - 400 * 3_600_000; // strictly earlier than every core-tier createdAt
  for (let i = 0; i < DENSITY_PROJECT_COUNT; i += 1) {
    const key = `density-${String(i + 1).padStart(2, "0")}`;
    const stageKey = STAGE_KEYS[i % STAGE_KEYS.length]!;
    const createdAtMs = densityBase - (DENSITY_PROJECT_COUNT - i) * 3_600_000;
    const project: FixtureProjectRow = {
      id: fixtureId(`project:${key}`), key, street: `QA FIXTURE · Density ${String(i + 1).padStart(2, "0")}`, suburb: "QA Density",
      agencyName: "QA Fixture — synthetic data", stageKey, priority: null, shootDate: null,
      boardRevision: stageKey === "awaiting_raw" ? 0 : 1, notes: `QA-FIXTURE-v1 · anchor=${anchor} · tier=density · key=${key}`,
      deadline: null, services: ["raw"], createdAtMs, updatedAtMs: createdAtMs,
    };
    builds.push({ project, subtasks: bulkSubtasks(project.id, key, DENSITY_SUBTASKS_PER_PROJECT, 0, createdAtMs) });
  }
  return builds;
}

/** The row count a single-stage filter over the density tier alone leaves — pure arithmetic, no
 * need to build the full dataset to check it against `PRODUCTION_GANTT_DRAW_CAP`. */
export function densitySingleStageRowCount(): number {
  const projectsPerStage = DENSITY_PROJECT_COUNT / STAGE_KEYS.length;
  return projectsPerStage * (1 + DENSITY_SUBTASKS_PER_PROJECT);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function buildQaFixtureDataset(options: { anchor: string; tiers: readonly QaTier[]; defaultEditorIds?: readonly string[] }): QaFixtureDataset {
  const anchor = options.anchor;
  if (!isSydneyCalendarDate(anchor)) throw new Error(`buildQaFixtureDataset: anchor must be a valid calendar date, got ${JSON.stringify(anchor)}.`);
  const tiers = [...new Set(options.tiers)];
  if (tiers.length === 0) throw new Error("buildQaFixtureDataset: at least one tier is required.");
  const referenceInstantMs = anchorReferenceInstantMs(anchor);

  const builds: ProjectBuild[] = [];
  if (tiers.includes("core")) builds.push(...buildCoreTier(anchor, referenceInstantMs));
  if (tiers.includes("density")) builds.push(...buildDensityTier(anchor, referenceInstantMs));

  const projects = builds.map((b) => b.project);
  const subtasks = builds.flatMap((b) => b.subtasks);

  const collections: FixtureCollectionRow[] = builds.flatMap((b) =>
    b.project.services.map((kind) => ({
      id: fixtureId(`collection:${b.project.key}:${kind}`), projectId: b.project.id, kind,
      createdAtMs: b.project.createdAtMs, updatedAtMs: b.project.createdAtMs,
    })),
  );

  const deadlineOccurrences: FixtureOccurrenceRow[] = builds.flatMap((b) =>
    b.project.deadline ? buildDeadlineOccurrences(b.project.id, b.project.deadline, referenceInstantMs, b.project.createdAtMs) : [],
  );

  const defaultEditorIds = [...new Set(options.defaultEditorIds ?? [])];
  const members: FixtureMemberRow[] = builds.flatMap((b) =>
    defaultEditorIds.map((userId) => ({
      id: fixtureId(`member:${b.project.key}:${userId}`), projectId: b.project.id, userId, createdAtMs: b.project.createdAtMs,
    })),
  );

  return { anchor, tiers, projects, subtasks, collections, deadlineOccurrences, members };
}
