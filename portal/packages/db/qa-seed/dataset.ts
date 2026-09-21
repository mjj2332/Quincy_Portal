/**
 * QA scheduling fixture — pure dataset builder (#220 follow-on). NEVER imports `node:child_process`
 * and never reaches an environment: this file, `sql.ts` and `ids.ts` build a fully-resolved,
 * in-memory dataset; `cli.mjs` is the only file allowed to spawn `wrangler`.
 *
 * Validity by construction: every subtask schedule is produced by `normalizeChecklistSchedule`
 * (thrown on `ok === false`) and round-tripped through `serializeChecklistSchedule`, asserted to
 * match the state it was declared to be. Legacy rows bypass the normalizer by design (the real
 * legacy create path never calls it either — `lib/project-subtasks.ts`'s `legacyDueDateRequested`
 * branch stores the literal text directly) and are instead round-tripped through
 * `serializeChecklistSchedule` alone.
 */
import {
  deadlineFireAt,
  isSydneyCalendarDate,
  normalizeChecklistSchedule,
  normalizeReminderOffsets,
  PROJECT_DEADLINE_PRESETS,
  PROJECT_DEADLINE_ZONE,
  resolveSydneyCivilMinute,
  serializeChecklistSchedule,
  shiftSydneyCalendarDate,
  sydneyCivilParts,
  SYDNEY_TIME_ZONE,
  type ChecklistScheduleDto,
  type ChecklistScheduleStorage,
  type InitialChecklistScheduleInput,
} from "@quincy/shared";
import { fixtureId } from "./ids";

export type QaTier = "core" | "density";
export const QA_TIERS: readonly QaTier[] = ["core", "density"];

/** Bootstrap admin, `packages/db/seed/0001_seed.sql`. Read-only: the generator never inserts,
 * updates or deletes this row. */
export const BOOTSTRAP_ADMIN_ID = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";

const HOUR_MS = 3_600_000;

export type StageKey = "awaiting_raw" | "raw_review" | "editing_autohdr" | "edited_review" | "delivered";

export type FixtureProjectDeadline = {
  localCivil: string;
  utcOffsetMinutes: number;
  fold: 0 | 1;
  epochMs: number;
  offsetsMinutes: number[];
};

export type FixtureProjectRow = {
  id: string;
  key: string;
  tier: QaTier;
  street: string;
  suburb: string;
  agencyName: string;
  stageKey: StageKey;
  priority: number | null;
  shootDate: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  notes: string;
  deadline: FixtureProjectDeadline | null;
  services: string[];
  boardRevision: number;
};

export type FixtureSubtaskRow = {
  id: string;
  projectId: string;
  projectKey: string;
  title: string;
  done: boolean;
  index: number;
  createdAtMs: number;
  updatedAtMs: number;
  storage: ChecklistScheduleStorage;
};

export type FixtureDeadlineOccurrenceRow = {
  id: string;
  projectId: string;
  scheduleVersion: number;
  kind: "advance" | "due_now";
  reminderOffsetMinutes: number;
  fireAt: number;
  deadlineAt: number;
  deadlineLocalCivil: string;
  deadlineUtcOffsetMinutes: number;
  deadlineFold: 0 | 1;
  status: "pending" | "skipped";
  terminalReason: "elapsed_at_save" | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type FixtureCollectionRow = {
  id: string;
  projectId: string;
  kind: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type FixtureMemberRow = {
  id: string;
  projectId: string;
  userId: string;
  createdAtMs: number;
};

export type QaFixtureDataset = {
  anchor: string;
  tiers: QaTier[];
  dst: { spring: string; fall: string };
  projects: FixtureProjectRow[];
  subtasks: FixtureSubtaskRow[];
  collections: FixtureCollectionRow[];
  deadlineOccurrences: FixtureDeadlineOccurrenceRow[];
  members: FixtureMemberRow[];
};

// ---------------------------------------------------------------------------
// Date/anchor helpers — integer day offsets via `shiftSydneyCalendarDate`, never ms arithmetic.
// ---------------------------------------------------------------------------

function mustShiftDate(date: string, deltaDays: number): string {
  const shifted = shiftSydneyCalendarDate(date, deltaDays);
  if (!shifted.ok) throw new Error(`Could not shift ${date} by ${deltaDays} days: ${shifted.message}`);
  return shifted.value;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Monday of the current Sydney ISO week — the default anchor when `--anchor` is omitted. */
export function currentSydneyMondayISO(now: Date = new Date()): string {
  const parts = sydneyCivilParts(now);
  const dateISO = `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
  const weekdayShort = new Intl.DateTimeFormat("en-US", { timeZone: SYDNEY_TIME_ZONE, weekday: "short" }).format(now);
  const isoWeekdayByShortName: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const isoWeekday = isoWeekdayByShortName[weekdayShort];
  if (!isoWeekday) throw new Error(`Unrecognised Sydney weekday short name: ${weekdayShort}`);
  return mustShiftDate(dateISO, -(isoWeekday - 1));
}

const ANCHOR_RE = /^\d{4}-\d{2}-\d{2}$/;

export function resolveAnchor(anchorArg: string | undefined, now: Date = new Date()): string {
  if (anchorArg === undefined) return currentSydneyMondayISO(now);
  if (!ANCHOR_RE.test(anchorArg) || !isSydneyCalendarDate(anchorArg)) {
    throw new Error(`--anchor must be a real YYYY-MM-DD calendar date, got ${JSON.stringify(anchorArg)}.`);
  }
  return anchorArg;
}

/** A handful of verified Sydney AEST/AEDT transition dates, used only to cross-check the `Intl`-
 * computed transitions below — never trusted on their own past 2028. */
const KNOWN_SYDNEY_TRANSITIONS: ReadonlyArray<{ date: string; kind: "spring" | "fall" }> = [
  { date: "2024-10-06", kind: "spring" },
  { date: "2025-04-06", kind: "fall" },
  { date: "2025-10-05", kind: "spring" },
  { date: "2026-04-05", kind: "fall" },
  { date: "2026-10-04", kind: "spring" },
  { date: "2027-04-04", kind: "fall" },
  { date: "2027-10-03", kind: "spring" },
  { date: "2028-04-02", kind: "fall" },
];

function sydneyNoonOffsetMinutes(dateISO: string): number {
  const resolved = resolveSydneyCivilMinute(`${dateISO}T12:00`);
  if (!resolved.ok) throw new Error(`Could not resolve the Sydney offset for ${dateISO} at noon: ${resolved.message}`);
  return resolved.value.utcOffsetMinutes;
}

function findNextSydneyTransition(anchorDateISO: string, kind: "spring" | "fall"): string {
  let cursor = anchorDateISO;
  let previousOffset = sydneyNoonOffsetMinutes(cursor);
  for (let step = 0; step < 400; step += 1) {
    cursor = mustShiftDate(cursor, 1);
    const offset = sydneyNoonOffsetMinutes(cursor);
    if (kind === "spring" && offset > previousOffset) return cursor;
    if (kind === "fall" && offset < previousOffset) return cursor;
    previousOffset = offset;
  }
  throw new Error(`No ${kind} transition found within 400 days after ${anchorDateISO}.`);
}

/** The first spring-forward and first fall-back strictly after `anchorDateISO`, computed from
 * `Intl` and cross-checked against `KNOWN_SYDNEY_TRANSITIONS` whenever the computed date is one of
 * the years that table covers. */
export function resolveDstTransitions(anchorDateISO: string): { spring: string; fall: string } {
  const spring = findNextSydneyTransition(anchorDateISO, "spring");
  const fall = findNextSydneyTransition(anchorDateISO, "fall");
  for (const [computedDate, kind] of [[spring, "spring"], [fall, "fall"]] as const) {
    const known = KNOWN_SYDNEY_TRANSITIONS.find((entry) => entry.date === computedDate);
    if (known && known.kind !== kind) {
      throw new Error(`Computed ${kind} transition ${computedDate} disagrees with the committed transition table (expected ${known.kind}).`);
    }
  }
  return { spring, fall };
}

// ---------------------------------------------------------------------------
// Schedule construction — validity by construction (Decision 2).
// ---------------------------------------------------------------------------

function normalizedStorage(input: InitialChecklistScheduleInput, version: number, expectedState: ChecklistScheduleDto["state"], describe: string): ChecklistScheduleStorage {
  const result = normalizeChecklistSchedule(input, version);
  if (!result.ok) throw new Error(`normalizeChecklistSchedule rejected ${describe}: ${result.error.message}`);
  const storage: ChecklistScheduleStorage = { ...result.value };
  const dto = serializeChecklistSchedule(storage);
  if (dto.state !== expectedState) throw new Error(`${describe}: expected state "${expectedState}" but serializeChecklistSchedule produced "${dto.state}".`);
  return storage;
}

function legacyStorage(dueDate: string, expectedState: ChecklistScheduleDto["state"], describe: string): ChecklistScheduleStorage {
  const storage: ChecklistScheduleStorage = {
    dueDate,
    scheduleStartKind: null, scheduleStartCivil: null, scheduleStartAt: null, scheduleStartUtcOffsetMinutes: null, scheduleStartFold: null,
    scheduleEndKind: null, scheduleEndAt: null, scheduleEndUtcOffsetMinutes: null, scheduleEndFold: null,
    scheduleZone: null, scheduleVersion: 0,
  };
  const dto = serializeChecklistSchedule(storage);
  if (dto.state !== expectedState) throw new Error(`${describe}: expected state "${expectedState}" but serializeChecklistSchedule produced "${dto.state}".`);
  return storage;
}

const UNSCHEDULED_V0 = normalizedStorage({ state: "unscheduled" }, 0, "unscheduled", "bulk unscheduled row");

/** The 17-row schedule-edge matrix (main spec "Dataset": Opus §3.3 rows 1-16, merged with Codex's
 * matrix rows 8/9/13). Every non-legacy row goes through `normalizeChecklistSchedule`; legacy rows
 * bypass it exactly like the app's own legacy create branch does. */
function scheduleEdgeRows(anchor: string, dst: { spring: string; fall: string }): Array<{ title: string; storage: ChecklistScheduleStorage; done: boolean }> {
  const plus = (days: number) => mustShiftDate(anchor, days);
  const rows: Array<{ title: string; storage: ChecklistScheduleStorage; done: boolean }> = [
    { title: "Unscheduled (cleared, v1)", storage: normalizedStorage({ state: "unscheduled" }, 1, "unscheduled", "R1 unscheduled v1"), done: false },
    { title: "Unscheduled (new, v0)", storage: normalizedStorage({ state: "unscheduled" }, 0, "unscheduled", "R2 unscheduled v0"), done: false },
    { title: "Due date milestone", storage: normalizedStorage({ state: "due_only", end: { kind: "date", localCivil: plus(10) } }, 1, "due_only", "R3 due date"), done: true },
    { title: "Due timed milestone", storage: normalizedStorage({ state: "due_only", end: { kind: "timed", localCivil: `${plus(10)}T14:00` } }, 1, "due_only", "R4 due timed"), done: false },
    { title: "All-day range", storage: normalizedStorage({ state: "range", start: { kind: "date", localCivil: plus(5) }, end: { kind: "date", localCivil: plus(8) } }, 1, "range", "R5 all-day range"), done: true },
    { title: "Timed range", storage: normalizedStorage({ state: "range", start: { kind: "timed", localCivil: `${plus(5)}T09:00` }, end: { kind: "timed", localCivil: `${plus(5)}T17:00` } }, 1, "range", "R6 timed range"), done: false },
    { title: "Spring-forward day range (23h bar)", storage: normalizedStorage({ state: "range", start: { kind: "date", localCivil: dst.spring }, end: { kind: "date", localCivil: dst.spring } }, 1, "range", "R7 spring range"), done: false },
    { title: "Fall-back day range (25h bar)", storage: normalizedStorage({ state: "range", start: { kind: "date", localCivil: dst.fall }, end: { kind: "date", localCivil: dst.fall } }, 1, "range", "R8 fall range"), done: true },
    { title: "Timed range across the gap (tight)", storage: normalizedStorage({ state: "range", start: { kind: "timed", localCivil: `${dst.spring}T01:30` }, end: { kind: "timed", localCivil: `${dst.spring}T03:30` } }, 1, "range", "R9 gap tight range"), done: false },
    { title: "Timed range across the gap (overnight)", storage: normalizedStorage({ state: "range", start: { kind: "timed", localCivil: `${mustShiftDate(dst.spring, -1)}T22:00` }, end: { kind: "timed", localCivil: `${dst.spring}T06:00` } }, 1, "range", "R10 gap overnight range"), done: false },
    { title: "Timed range across the fold", storage: normalizedStorage({ state: "range", start: { kind: "timed", localCivil: `${dst.fall}T01:30` }, end: { kind: "timed", localCivil: `${dst.fall}T03:30` } }, 1, "range", "R11 fold range"), done: false },
    { title: "Fold canary — earlier", storage: normalizedStorage({ state: "due_only", end: { kind: "timed", localCivil: `${dst.fall}T02:30`, disambiguation: "earlier" } }, 1, "due_only", "R12 fold earlier"), done: false },
    { title: "Fold canary — later", storage: normalizedStorage({ state: "due_only", end: { kind: "timed", localCivil: `${dst.fall}T02:30`, disambiguation: "later" } }, 1, "due_only", "R13 fold later"), done: false },
    { title: "Legacy due date (stored, valid)", storage: legacyStorage(plus(40), "due_only", "R14 legacy valid"), done: false },
    { title: "Legacy due date (invalid literal)", storage: legacyStorage("next Tuesday", "legacy_unresolved", "R15 legacy invalid literal"), done: false },
    { title: "Legacy due date (repeated local time)", storage: legacyStorage(`${dst.fall}T02:30`, "legacy_unresolved", "R16 legacy repeated"), done: false },
    { title: "Legacy due date (nonexistent local time)", storage: legacyStorage(`${dst.spring}T02:30`, "legacy_unresolved", "R17 legacy nonexistent"), done: false },
  ];
  return rows;
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

function buildDeadline(localCivil: string): FixtureProjectDeadline {
  const resolved = resolveSydneyCivilMinute(localCivil);
  if (!resolved.ok) throw new Error(`Could not resolve deadline civil time ${localCivil}: ${resolved.message}`);
  const offsetsMinutes = normalizeReminderOffsets([...PROJECT_DEADLINE_PRESETS]);
  return { localCivil, utcOffsetMinutes: resolved.value.utcOffsetMinutes, fold: resolved.value.fold, epochMs: resolved.value.epochMs, offsetsMinutes };
}

/** `referenceInstantMs` stands in for "now" without ever calling `Date.now()` (Decision 6) — the
 * anchor's own 09:00 Sydney instant, which is always within the same week a real apply runs in. */
function deadlineOccurrencesFor(project: FixtureProjectRow, referenceInstantMs: number): FixtureDeadlineOccurrenceRow[] {
  if (!project.deadline) return [];
  const deadline = project.deadline;
  const rows: FixtureDeadlineOccurrenceRow[] = [];
  for (const offset of deadline.offsetsMinutes) {
    const fireAt = deadlineFireAt(deadline.epochMs, offset);
    const pending = fireAt > referenceInstantMs;
    rows.push({
      id: fixtureId(`occurrence:${project.key}:advance:${offset}`),
      projectId: project.id, scheduleVersion: 1, kind: "advance", reminderOffsetMinutes: offset, fireAt,
      deadlineAt: deadline.epochMs, deadlineLocalCivil: deadline.localCivil, deadlineUtcOffsetMinutes: deadline.utcOffsetMinutes, deadlineFold: deadline.fold,
      status: pending ? "pending" : "skipped", terminalReason: pending ? null : "elapsed_at_save",
      createdAtMs: project.createdAtMs, updatedAtMs: project.createdAtMs,
    });
  }
  const dueNowPending = deadline.epochMs > referenceInstantMs;
  rows.push({
    id: fixtureId(`occurrence:${project.key}:due_now`),
    projectId: project.id, scheduleVersion: 1, kind: "due_now", reminderOffsetMinutes: 0, fireAt: deadline.epochMs,
    deadlineAt: deadline.epochMs, deadlineLocalCivil: deadline.localCivil, deadlineUtcOffsetMinutes: deadline.utcOffsetMinutes, deadlineFold: deadline.fold,
    status: dueNowPending ? "pending" : "skipped", terminalReason: dueNowPending ? null : "elapsed_at_save",
    createdAtMs: project.createdAtMs, updatedAtMs: project.createdAtMs,
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Bulk (non-edge-case) subtasks
// ---------------------------------------------------------------------------

function bulkSubtasks(project: FixtureProjectRow, total: number, doneCount: number): FixtureSubtaskRow[] {
  if (doneCount > total) throw new Error(`${project.key}: doneCount (${doneCount}) exceeds total (${total}).`);
  const rows: FixtureSubtaskRow[] = [];
  for (let index = 0; index < total; index += 1) {
    const done = index < doneCount;
    const createdAtMs = project.createdAtMs + index * 1_000;
    rows.push({
      id: fixtureId(`subtask:${project.key}:${pad(index, 4)}`),
      projectId: project.id, projectKey: project.key, title: `${project.street} · item ${pad(index + 1, 4)}`,
      done, index, createdAtMs, updatedAtMs: done ? createdAtMs + 61_000 : createdAtMs, storage: UNSCHEDULED_V0,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Project assembly
// ---------------------------------------------------------------------------

type ProjectSpecCore = {
  key: string;
  title: string;
  stageKey: StageKey;
  priority: number | null;
  shootDate: string | null;
  deadlineLocalCivil: string | null;
};

function projectRow(spec: ProjectSpecCore, anchor: string, index: number, referenceInstantMs: number, tier: QaTier): FixtureProjectRow {
  const createdAtMs = referenceInstantMs - (400 - index) * HOUR_MS;
  return {
    id: fixtureId(`project:${spec.key}`),
    key: spec.key,
    tier,
    street: `QA FIXTURE · ${spec.title}`,
    suburb: tier === "density" ? "QA Density" : "QA Fixtures",
    agencyName: "QA Fixture — synthetic data",
    stageKey: spec.stageKey,
    priority: spec.priority,
    shootDate: spec.shootDate,
    createdAtMs,
    updatedAtMs: createdAtMs,
    notes: `QA-FIXTURE-v1 · anchor=${anchor} · tier=${tier} · key=${spec.key}`,
    deadline: spec.deadlineLocalCivil ? buildDeadline(spec.deadlineLocalCivil) : null,
    services: ["raw"],
    boardRevision: spec.stageKey === "awaiting_raw" ? 0 : 1,
  };
}

function collectionsFor(project: FixtureProjectRow): FixtureCollectionRow[] {
  return project.services.map((kind) => ({
    id: fixtureId(`collection:${project.key}:${kind}`),
    projectId: project.id, kind, createdAtMs: project.createdAtMs, updatedAtMs: project.createdAtMs,
  }));
}

function membersFor(project: FixtureProjectRow, defaultEditorIds: readonly string[]): FixtureMemberRow[] {
  return defaultEditorIds.map((userId) => ({
    id: fixtureId(`member:${project.key}:${userId}`), projectId: project.id, userId, createdAtMs: project.createdAtMs,
  }));
}

// ---------------------------------------------------------------------------
// Tier builders
// ---------------------------------------------------------------------------

function buildCoreTier(anchor: string, dst: { spring: string; fall: string }, referenceInstantMs: number): { projects: FixtureProjectRow[]; subtasks: FixtureSubtaskRow[] } {
  const specs: ProjectSpecCore[] = [
    { key: "pagination", title: "Pagination 260", stageKey: "awaiting_raw", priority: 1, shootDate: mustShiftDate(anchor, 3), deadlineLocalCivil: `${mustShiftDate(anchor, 20)}T17:00` },
    { key: "near-complete", title: "Near-complete 199 of 200", stageKey: "raw_review", priority: 2, shootDate: mustShiftDate(anchor, 4), deadlineLocalCivil: `${mustShiftDate(anchor, 21)}T17:00` },
    { key: "complete", title: "Complete 40 of 40", stageKey: "edited_review", priority: 3, shootDate: mustShiftDate(anchor, 5), deadlineLocalCivil: `${mustShiftDate(anchor, 22)}T17:00` },
    { key: "zero", title: "Zero progress", stageKey: "editing_autohdr", priority: 4, shootDate: mustShiftDate(anchor, 6), deadlineLocalCivil: `${mustShiftDate(anchor, 23)}T17:00` },
    { key: "delivered", title: "Delivered", stageKey: "delivered", priority: 5, shootDate: mustShiftDate(anchor, -2), deadlineLocalCivil: null },
    { key: "schedule-edges", title: "Schedule edges", stageKey: "raw_review", priority: null, shootDate: mustShiftDate(anchor, 7), deadlineLocalCivil: `${mustShiftDate(anchor, 24)}T17:00` },
    { key: "no-deadline", title: "No deadline no shoot date", stageKey: "awaiting_raw", priority: null, shootDate: null, deadlineLocalCivil: null },
    { key: "hollow-start", title: "Hollow start", stageKey: "editing_autohdr", priority: null, shootDate: null, deadlineLocalCivil: `${mustShiftDate(anchor, 25)}T17:00` },
    { key: "deadline-before-start", title: "Deadline before start", stageKey: "edited_review", priority: null, shootDate: mustShiftDate(anchor, 10), deadlineLocalCivil: `${mustShiftDate(anchor, 2)}T09:00` },
    { key: "invalid-shoot-date", title: "Invalid shoot date", stageKey: "raw_review", priority: null, shootDate: "2026-02-30", deadlineLocalCivil: `${mustShiftDate(anchor, 26)}T17:00` },
  ];
  const projects = specs.map((spec, index) => projectRow(spec, anchor, index, referenceInstantMs, "core"));
  const byKey = Object.fromEntries(projects.map((p) => [p.key, p] as const));

  const subtasks: FixtureSubtaskRow[] = [
    ...bulkSubtasks(byKey.pagination!, 260, 0),
    ...bulkSubtasks(byKey["near-complete"]!, 200, 199),
    ...bulkSubtasks(byKey.complete!, 40, 40),
    ...bulkSubtasks(byKey.zero!, 12, 0),
    ...bulkSubtasks(byKey.delivered!, 6, 3),
    ...bulkSubtasks(byKey["no-deadline"]!, 5, 0),
    ...bulkSubtasks(byKey["hollow-start"]!, 5, 1),
    ...bulkSubtasks(byKey["deadline-before-start"]!, 5, 0),
    ...bulkSubtasks(byKey["invalid-shoot-date"]!, 5, 0),
  ];

  const edgeProject = byKey["schedule-edges"]!;
  const edgeRows = scheduleEdgeRows(anchor, dst);
  edgeRows.forEach((row, index) => {
    const createdAtMs = edgeProject.createdAtMs + index * 1_000;
    subtasks.push({
      id: fixtureId(`subtask:schedule-edges:${pad(index, 4)}`),
      projectId: edgeProject.id, projectKey: edgeProject.key, title: `${edgeProject.street} · ${row.title}`,
      done: row.done, index, createdAtMs, updatedAtMs: row.done ? createdAtMs + 61_000 : createdAtMs, storage: row.storage,
    });
  });

  return { projects, subtasks };
}

const DENSITY_STAGES: StageKey[] = ["awaiting_raw", "raw_review", "editing_autohdr", "edited_review", "delivered"];
const DENSITY_PROJECT_COUNT = 30;
const DENSITY_SUBTASKS_PER_PROJECT = 70;

function buildDensityTier(anchor: string, referenceInstantMs: number): { projects: FixtureProjectRow[]; subtasks: FixtureSubtaskRow[] } {
  const projects: FixtureProjectRow[] = [];
  const subtasks: FixtureSubtaskRow[] = [];
  for (let index = 0; index < DENSITY_PROJECT_COUNT; index += 1) {
    const stageKey = DENSITY_STAGES[index % DENSITY_STAGES.length]!;
    const key = `density-${pad(index + 1, 2)}`;
    const spec: ProjectSpecCore = {
      key, title: `Density ${pad(index + 1, 2)}`, stageKey, priority: null,
      shootDate: mustShiftDate(anchor, index % 14), deadlineLocalCivil: `${mustShiftDate(anchor, 30 + (index % 14))}T17:00`,
    };
    const project = projectRow(spec, anchor, 1000 + index, referenceInstantMs, "density");
    projects.push(project);
    subtasks.push(...bulkSubtasks(project, DENSITY_SUBTASKS_PER_PROJECT, 0));
  }
  return { projects, subtasks };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export type BuildQaFixtureDatasetOptions = {
  anchor: string;
  tiers: QaTier[];
  defaultEditorIds?: readonly string[];
};

export function buildQaFixtureDataset(options: BuildQaFixtureDatasetOptions): QaFixtureDataset {
  const anchor = options.anchor;
  if (!ANCHOR_RE.test(anchor) || !isSydneyCalendarDate(anchor)) throw new Error(`Invalid anchor: ${JSON.stringify(anchor)}`);
  const tiers = [...new Set(options.tiers)];
  if (tiers.length === 0) throw new Error("At least one tier is required.");
  for (const tier of tiers) if (!QA_TIERS.includes(tier)) throw new Error(`Unknown tier: ${tier}`);

  const dst = resolveDstTransitions(anchor);
  const referenceResolved = resolveSydneyCivilMinute(`${anchor}T09:00`);
  if (!referenceResolved.ok) throw new Error(`Could not resolve the anchor reference instant: ${referenceResolved.message}`);
  const referenceInstantMs = referenceResolved.value.epochMs;

  const projects: FixtureProjectRow[] = [];
  const subtasks: FixtureSubtaskRow[] = [];
  if (tiers.includes("core")) {
    const core = buildCoreTier(anchor, dst, referenceInstantMs);
    projects.push(...core.projects);
    subtasks.push(...core.subtasks);
  }
  if (tiers.includes("density")) {
    const density = buildDensityTier(anchor, referenceInstantMs);
    projects.push(...density.projects);
    subtasks.push(...density.subtasks);
  }

  const defaultEditorIds = [...new Set(options.defaultEditorIds ?? [])].sort();
  const collections = projects.flatMap(collectionsFor);
  const deadlineOccurrences = projects.flatMap((project) => deadlineOccurrencesFor(project, referenceInstantMs));
  const members = projects.flatMap((project) => membersFor(project, defaultEditorIds));

  return { anchor, tiers, dst, projects, subtasks, collections, deadlineOccurrences, members };
}

/** Density's own not-done checklist rows for a single stage — used by the coverage test to prove
 * a single-stage filter drops the density tier back under `PRODUCTION_GANTT_DRAW_CAP`. */
export function densitySingleStageRowCount(): number {
  const projectsInOneStage = Math.ceil(DENSITY_PROJECT_COUNT / DENSITY_STAGES.length);
  return projectsInOneStage * (1 + DENSITY_SUBTASKS_PER_PROJECT);
}
