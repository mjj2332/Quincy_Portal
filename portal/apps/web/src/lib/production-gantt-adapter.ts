/**
 * #220 pass A — pure `GanttProjectRowDto[]` → Gantt model adapter. No React, no network, no
 * storage: given a page (or merged pages) of production rows, returns the resources/events/
 * attention list the ReUI Gantt surface renders in pass B. Every function here is a pure
 * transform over its arguments.
 *
 * **Why this does not import `components/reui/gantt/gantt-types`, type-only or otherwise, despite
 * the pass-A build spec naming `GanttResource`/`GanttEvent` in this function's signature:**
 * `src/harness/harness-reachability.guard.test.ts`'s `extractSpecifiers` walks every
 * `ImportDeclaration` and records its string specifier without ever reading Babel's
 * `importKind` — so `import type { X } from "@/components/reui/gantt/gantt-types"` is captured
 * identically to a value import, and trips the same "no production consumer of
 * components/reui/gantt" guard as a real one (verified empirically against this exact guard
 * before writing this file — a planted `import type` in `src/lib/` fails
 * `finds no real production consumer today`). That guard, and the `ALLOWED_VENDOR_SCHEDULING_
 * CONSUMERS` relaxation that would fix it, are explicitly pass B's job, not this pass's — this
 * pass may not touch `harness-reachability.guard.test.ts`. So `ProductionGanttResource` and
 * `ProductionGanttEvent<TData>` below are LOCAL types, not imports: every field pass A populates
 * is a subset of `GanttResource`/`GanttEvent<TData>`'s own fields (id/title/color/children for a
 * resource; id/title/start/end/allDay/color/className/readOnly/resourceId/data for an event), every field
 * `GanttResource`/`GanttEvent` declare beyond that subset is optional there, so pass B can assign
 * this module's output directly to a `GanttResource[]` / `GanttEvent<ProductionGanttRowData>[]`
 * — TypeScript's structural typing accepts it with no cast. If a future pass widens
 * `GanttResource`/`GanttEvent` with a new REQUIRED field, that assignment (not this file) is where
 * it will surface as a type error.
 *
 * **Pass B (#220 S8) confirmed rather than fixed this:** the guard now has a real value-import
 * consumer (`components/ProductionGantt.tsx`, added to `ALLOWED_VENDOR_SCHEDULING_CONSUMERS`), but
 * this file is not that consumer and was deliberately left off that list too — pass B chose NOT to
 * make `extractSpecifiers` importKind-aware (see `harness-reachability.guard.test.ts`'s own S8
 * decision record, and its "import type { X } from vendored gantt is STILL caught..." self-tests),
 * so `import type { GanttResource, GanttEvent } from "@/components/reui/gantt/gantt-types"` here
 * would still trip the guard exactly like a value import would. The local types below stay as they
 * are: they work, they are unit-tested for the exact field subset that makes the structural
 * assignment in `ProductionGantt.tsx` succeed, and replacing them would be a cosmetic single-
 * source-of-truth cleanup, not a correctness fix for anything broken today.
 */

import {
  PRODUCTION_GANTT_DRAW_CAP,
  resolveSydneyCivilMinute,
  type GanttChecklistRowDto,
  type GanttProjectRowDto,
} from "@quincy/shared";
import { sydneyDayKey } from "./date-format";
import { doneCount, projectLateness, stageTone, subtaskLateness, subtaskPeopleTone, subtaskShape, type StageTone } from "./dashboard-appearance";
import {
  ganttProjectBarClass,
  ganttTaskBarClass,
  type GanttProjectAppearance,
  type GanttTaskAppearance,
} from "./production-gantt-appearance-classes";

// ---------------------------------------------------------------------------
// Local, structurally-`GanttResource`/`GanttEvent`-compatible shapes — see header.
// ---------------------------------------------------------------------------

export interface ProductionGanttResource {
  id: string;
  title: string;
  color?: string;
  /** #919: the row's own height floor in rem (`GanttResource.minRowHeight`, a Quincy vendor addition). */
  minRowHeight?: number;
  children?: ProductionGanttResource[];
}

export interface ProductionGanttEvent<TData = unknown> {
  id: string;
  title: string;
  /** Plain instants. `end` is exclusive except for a zero-length (start === end) milestone. */
  start: Date;
  end: Date;
  allDay?: boolean;
  color?: string;
  readOnly?: boolean;
  resourceId?: string;
  /** 0-100, matching `GanttEvent.progress` (`components/reui/gantt/gantt-types.tsx`) — never set to
   * `undefined` explicitly (only omitted) so the "structural shape" unit test's exact-key check
   * stays meaningful for an event with no progress to report (fix-220-sol1 #4). */
  progress?: number;
  /** #221 — set only when the model is built `interactive: true`; omitted (never `undefined`)
   * otherwise, so the default output stays byte-identical. Mirror `GanttEvent`'s own fields. */
  draggable?: boolean;
  resizable?: boolean;
  resizableEdges?: { start?: boolean; end?: boolean };
  /** #919 — the frame 3a bar class (`production-gantt-appearance-classes.ts`), mirroring
   * `GanttEvent.className`. Every event carries one (#257's Edited review hatch is gone). */
  className?: string;
  data?: TData;
}

/** The facts every project/task row carries, whether it produced an event or landed in `attention`. */
export type ProductionGanttRowFacts =
  | { kind: "project"; dto: GanttProjectRowDto; hollowStart: boolean; missingDeadline: boolean }
  | { kind: "task"; dto: GanttChecklistRowDto; hollowStart: false; missingDeadline: false };

/**
 * `GanttEvent.data`'s shape for every event this adapter emits: the row's facts plus its frame 3a
 * appearance (#919). Attention entries carry facts only; they draw no bar.
 */
export type ProductionGanttRowData =
  | (Extract<ProductionGanttRowFacts, { kind: "project" }> & { appearance: GanttProjectAppearance })
  | (Extract<ProductionGanttRowFacts, { kind: "task" }> & { appearance: GanttTaskAppearance });

/**
 * Why a row produced no event. Facts, not copy — the surface decides the displayed label
 * ("the adapter does not decide copy").
 */
export type ProductionGanttAttentionReason =
  | "missing_deadline"
  | "deadline_before_start"
  | "resolution_failed";

export type ProductionGanttAttention = ProductionGanttRowFacts & {
  reason: ProductionGanttAttentionReason;
  resourceId: string;
};

export interface ProductionGanttModel {
  resources: ProductionGanttResource[];
  events: ProductionGanttEvent<ProductionGanttRowData>[];
  attention: ProductionGanttAttention[];
  /** True when `projects` was truncated against `PRODUCTION_GANTT_DRAW_CAP` before building rows. */
  tooManyToDraw: boolean;
  /**
   * Ids of every project actually included in `resources`/`events` — i.e. within
   * `PRODUCTION_GANTT_DRAW_CAP`'s row budget (fix-220-sol1 #3). A project excluded here contributed
   * no resource/event and never will while `tooManyToDraw` stays true for this same `projects`
   * input, so a caller eagerly paginating a truncated project's children should walk only the ids in
   * this set — fetching more child pages for an excluded project produces rows nothing ever draws.
   */
  includedProjectIds: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Sydney civil-time endpoint resolution — see the build spec's timezone table. `resolve` below
// is `resolveSydneyCivilMinute`, read via `.value.epochMs`. On `ok === false`, the row routes to
// `attention`; this module never falls back to a bare `new Date(dateOnlyText)`.
// ---------------------------------------------------------------------------

export type EndpointResolution = { ok: true; date: Date } | { ok: false };

/** `resolve(localCivil + "T00:00")` — a Sydney calendar date's civil midnight, as an instant. */
export function resolveCivilDayStart(localCivilDate: string): EndpointResolution {
  const resolved = resolveSydneyCivilMinute(`${localCivilDate}T00:00`);
  return resolved.ok ? { ok: true, date: new Date(resolved.value.epochMs) } : { ok: false };
}

/** A stored `timed` endpoint's `instant` — already carries the fold; never re-resolve `localCivil`. */
function resolveStoredInstant(instant: string | null): EndpointResolution {
  if (instant === null) return { ok: false };
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? { ok: false } : { ok: true, date };
}

// ---------------------------------------------------------------------------
// #916 / #919: frame 3a appearance. Every rule is `dashboard-appearance.ts`'s; this only feeds it the
// DRAWN range, so an optimistic or pending range draws with the look it will have once saved.
// ---------------------------------------------------------------------------

function projectAppearance(project: GanttProjectRowDto, drawnDeadline: Date, now: Date): GanttProjectAppearance {
  return {
    tone: stageTone(project.stageKey),
    lateness: projectLateness({ stageKey: project.stageKey, deadlineAt: drawnDeadline.getTime(), archived: project.archived }, now),
    done: doneCount(project.checklist),
  };
}

function taskAppearance(row: GanttChecklistRowDto, tone: StageTone, start: Date, end: Date, now: Date): GanttTaskAppearance {
  return {
    tone,
    lateness: subtaskLateness({ dueAt: end, complete: row.done }, now),
    shape: subtaskShape({ start, end }),
    people: subtaskPeopleTone(row),
    complete: row.done,
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Re-derives every event's appearance from its DRAWN range and `now`: the per-minute clock (`useNow`)
 * and the optimistic/pending ranges change lateness and shape without rebuilding the model, so query
 * generations, child pagination and pins never see the clock. An event whose appearance is unchanged
 * keeps its identity, so a tick that changes nothing re-renders nothing.
 */
export function applyGanttAppearance(model: ProductionGanttModel, now: Date): ProductionGanttModel {
  let changed = false;
  const events = model.events.map((event) => {
    const data = event.data;
    if (!data) return event;
    let next: ProductionGanttEvent<ProductionGanttRowData>;
    if (data.kind === "project") {
      const appearance = projectAppearance(data.dto, event.end, now);
      if (sameJson(appearance, data.appearance)) return event;
      const milestone = event.start.getTime() === event.end.getTime();
      next = { ...event, className: ganttProjectBarClass(appearance, { milestone }), data: { ...data, appearance } };
    } else {
      const appearance = taskAppearance(data.dto, data.appearance.tone, event.start, event.end, now);
      if (sameJson(appearance, data.appearance)) return event;
      next = { ...event, className: ganttTaskBarClass(appearance), data: { ...data, appearance } };
    }
    changed = true;
    return next;
  });
  return changed ? { ...model, events } : model;
}

/** Frame 3a's row heights: a Project row 48px, a Subtask row 40px. A coarse pointer's 44px view floor still lifts the shorter. */
const PROJECT_ROW_REM = 3;
const SUBTASK_ROW_REM = 2.5;

// ---------------------------------------------------------------------------
// Per-row builders
// ---------------------------------------------------------------------------

interface RowBuildResult {
  event: ProductionGanttEvent<ProductionGanttRowData> | null;
  attention: ProductionGanttAttention | null;
}

/** #221: the interaction fields for a task event, appended after the default keys. */
function taskInteraction(row: GanttChecklistRowDto): Pick<ProductionGanttEvent, "readOnly" | "draggable" | "resizable"> {
  const { canDrag, canResize } = row.permissions;
  return { readOnly: !(canDrag || canResize), draggable: canDrag, resizable: canResize };
}

/**
 * A Subtask's drawn span as resolved instants: each end is its stored instant (every end is a
 * moment, ADR 0016). Shared by the bar builder
 * and the #414 child-row order, so the order is exactly what is drawn.
 */
function resolveTaskSpan(row: GanttChecklistRowDto): { ok: true; start: Date; end: Date } | { ok: false } {
  const { start, end } = row.schedule;
  const startResolved = resolveStoredInstant(start.instant);
  if (!startResolved.ok) return { ok: false };
  const endResolved = resolveStoredInstant(end.instant);
  if (!endResolved.ok) return { ok: false };
  return { ok: true, start: startResolved.date, end: endResolved.date };
}

function buildTaskResult(row: GanttChecklistRowDto, tone: StageTone, now: Date, interactive: boolean): RowBuildResult {
  const resourceId = `task:${row.id}`;
  const attentionFor = (reason: ProductionGanttAttentionReason): ProductionGanttAttention => ({
    kind: "task",
    dto: row,
    hollowStart: false,
    missingDeadline: false,
    reason,
    resourceId,
  });

  // Every Subtask is a timed range (ADR 0011, ADR 0016): the bar is [start, end) in stored instants.
  const span = resolveTaskSpan(row);
  if (!span.ok) return { event: null, attention: attentionFor("resolution_failed") };
  const appearance = taskAppearance(row, tone, span.start, span.end, now);
  return {
    event: {
      id: resourceId,
      title: row.title,
      start: span.start,
      end: span.end,
      allDay: false,
      color: tone.color,
      className: ganttTaskBarClass(appearance),
      readOnly: true,
      resourceId,
      ...(row.done ? { progress: 100 } : {}),
      data: { kind: "task", dto: row, hollowStart: false, missingDeadline: false, appearance },
      ...(interactive ? taskInteraction(row) : {}),
    },
    attention: null,
  };
}

function buildProjectBar(project: GanttProjectRowDto, tone: StageTone, now: Date, interactive: boolean): RowBuildResult {
  const resourceId = `project:${project.id}`;

  if (!project.deadline) {
    return {
      event: null,
      attention: {
        kind: "project",
        dto: project,
        hollowStart: !project.shootDateCivil,
        missingDeadline: true,
        reason: "missing_deadline",
        resourceId,
      },
    };
  }

  const endDate = new Date(project.deadline.at);
  if (Number.isNaN(endDate.getTime())) {
    return {
      event: null,
      attention: {
        kind: "project",
        dto: project,
        hollowStart: !project.shootDateCivil,
        missingDeadline: false,
        reason: "resolution_failed",
        resourceId,
      },
    };
  }

  let startDate: Date;
  let hollowStart: boolean;
  if (project.shootDateCivil) {
    const resolved = resolveCivilDayStart(project.shootDateCivil);
    if (!resolved.ok) {
      return {
        event: null,
        attention: {
          kind: "project",
          dto: project,
          hollowStart: false,
          missingDeadline: false,
          reason: "resolution_failed",
          resourceId,
        },
      };
    }
    startDate = resolved.date;
    hollowStart = false;
  } else {
    const created = new Date(project.createdAt);
    if (Number.isNaN(created.getTime())) {
      return {
        event: null,
        attention: {
          kind: "project",
          dto: project,
          hollowStart: true,
          missingDeadline: false,
          reason: "resolution_failed",
          resourceId,
        },
      };
    }
    startDate = created;
    hollowStart = true;
  }

  // #220 pitfall 6: deadline earlier than the derived bar start must never invert or clamp — emit
  // a zero-length diamond at the deadline plus an attention entry instead.
  const inverted = endDate.getTime() < startDate.getTime();
  const barStart = inverted ? endDate : startDate;
  // fix-220-sol1 #4: `checklist.total` is the project's full checklist count (not just this page's
  // downloaded `children.rows.length`, which may still be a truncated first page) — the one field
  // that is always the complete denominator regardless of child pagination state.
  //
  // fix-220-sol2 #6: `Math.round` alone reports 100 for a genuinely INCOMPLETE project —
  // `Math.round((199 / 200) * 100)` is `100` — which then renders the completed styling (the vendor shell's `data-completed`, `progress === 100`) on a
  // project that still has work outstanding. `100` is now emitted only when every row is actually
  // done; every other ratio is rounded normally and then capped at `99`, so "nearly done" and
  // "actually done" can never collide on the one value the UI treats as a completion signal.
  const progress =
    project.checklist.total > 0
      ? project.checklist.completed === project.checklist.total
        ? 100
        : Math.min(99, Math.round((project.checklist.completed / project.checklist.total) * 100))
      : undefined;
  const appearance = projectAppearance(project, endDate, now);
  // #919: a Delivered Project's Deadline is history, so its bar carries no Deadline grip.
  const canEditDeadline = project.permissions.canEditDeadline && project.stageKey !== "delivered";
  const event: ProductionGanttEvent<ProductionGanttRowData> = {
    id: `project-bar:${project.id}`,
    title: project.street,
    start: barStart,
    end: endDate,
    allDay: false,
    color: tone.color,
    className: ganttProjectBarClass(appearance, { milestone: barStart.getTime() === endDate.getTime() }),
    readOnly: true,
    resourceId,
    ...(progress !== undefined ? { progress } : {}),
    data: { kind: "project", dto: project, hollowStart, missingDeadline: false, appearance },
    // #221: only the deadline (end edge) is editable from the Gantt; the start is derived.
    ...(interactive
      ? {
          readOnly: !canEditDeadline || inverted,
          draggable: false,
          resizable: canEditDeadline,
          resizableEdges: { start: false, end: canEditDeadline },
        }
      : {}),
  };
  return {
    event,
    attention: inverted
      ? { kind: "project", dto: project, hollowStart, missingDeadline: false, reason: "deadline_before_start", resourceId }
      : null,
  };
}

interface SubtaskSortKey {
  row: GanttChecklistRowDto;
  resolved: boolean;
  startMs: number;
  endMs: number;
}

function subtaskSortKey(row: GanttChecklistRowDto): SubtaskSortKey {
  const span = resolveTaskSpan(row);
  return span.ok
    ? { row, resolved: true, startMs: span.start.getTime(), endMs: span.end.getTime() }
    : { row, resolved: false, startMs: 0, endMs: 0 };
}

/**
 * #414: deterministic child order, independent of page-arrival order — resolved range start, then
 * resolved range end, then Collaboration `position`, then `id`. Unresolved spans sort after every
 * resolved one. `<`/`>` only: a subtraction would turn a non-finite key into `NaN`.
 */
function compareSubtaskKeys(a: SubtaskSortKey, b: SubtaskSortKey): number {
  if (a.resolved !== b.resolved) return a.resolved ? -1 : 1;
  if (a.resolved) {
    if (a.startMs !== b.startMs) return a.startMs < b.startMs ? -1 : 1;
    if (a.endMs !== b.endMs) return a.endMs < b.endMs ? -1 : 1;
  }
  if (a.row.position !== b.row.position) return a.row.position < b.row.position ? -1 : 1;
  return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
}

/** Keys are computed once per row, never inside the comparator. */
function sortSubtasksByRange(rows: readonly GanttChecklistRowDto[]): GanttChecklistRowDto[] {
  return rows
    .map(subtaskSortKey)
    .sort(compareSubtaskKeys)
    .map((key) => key.row);
}

// ---------------------------------------------------------------------------
// #415: which Project row the Gantt lands on
// ---------------------------------------------------------------------------

export type GanttLanding =
  | { status: "found"; projectId: string; rule: "covers_now" | "upcoming" | "last_row" }
  /** A page not yet loaded could still change the answer. */
  | { status: "undecided" }
  | { status: "empty" };

/**
 * The Project row the Gantt opens on, over the DRAWN Project rows in display order (never a
 * Subtask). Rule 1: the first Project whose span [bar start, Deadline] contains `now` (no Deadline:
 * only its shoot day; no shoot date: the Sydney creation day, matching the bar start). Rule 2: the
 * first whose shoot day is today or later. Rule 3: the last row. `complete` says no further page
 * can arrive; while incomplete the answer may be `undecided`.
 */
export function ganttLandingProject(
  projects: readonly GanttProjectRowDto[],
  now: Date,
  opts: { complete: boolean },
): GanttLanding {
  if (projects.length === 0) return opts.complete ? { status: "empty" } : { status: "undecided" };
  const today = sydneyDayKey(now);
  const nowMs = now.getTime();

  const startDayOf = (project: GanttProjectRowDto): string | null => {
    if (project.shootDateCivil) return project.shootDateCivil;
    const created = new Date(project.createdAt);
    return Number.isNaN(created.getTime()) ? null : sydneyDayKey(created);
  };
  /** The bar start instant, exactly as `buildProjectBar` derives it. */
  const startInstantOf = (project: GanttProjectRowDto): Date | null => {
    if (project.shootDateCivil) {
      const resolved = resolveCivilDayStart(project.shootDateCivil);
      return resolved.ok ? resolved.date : null;
    }
    const created = new Date(project.createdAt);
    return Number.isNaN(created.getTime()) ? null : created;
  };
  const coversNow = (project: GanttProjectRowDto): boolean => {
    if (project.deadline) {
      const start = startInstantOf(project);
      const end = new Date(project.deadline.at);
      if (!start || Number.isNaN(end.getTime())) return false;
      return start.getTime() <= nowMs && nowMs <= end.getTime() && start.getTime() <= end.getTime();
    }
    return startDayOf(project) === today;
  };

  const covering = projects.find(coversNow);
  if (covering) return { status: "found", projectId: covering.id, rule: "covers_now" };

  // Loaded rows are a prefix of the display order. A row starting strictly after today means every
  // unloaded row starts after now too (`barStartDate === today` does not decide: a later row could
  // still cover now). A no-shoot-date row's `barStartDate` is a UTC date, never after the Sydney one.
  const decided = opts.complete || projects.some((project) => project.barStartDate > today);
  if (!decided) return { status: "undecided" };

  const upcoming = projects.find((project) => {
    const day = startDayOf(project);
    return day !== null && day >= today;
  });
  if (upcoming) return { status: "found", projectId: upcoming.id, rule: "upcoming" };
  return { status: "found", projectId: projects[projects.length - 1]!.id, rule: "last_row" };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `now` is accepted (not `Date.now()` read internally) for determinism/testability, matching this
 * codebase's other builders. Since #919 it decides each bar's lateness (frame 3a's late edge and
 * chip); a caller holding a model across a clock tick refreshes it with `applyGanttAppearance`
 * rather than rebuilding. The landing row is `ganttLandingProject`, which takes its own `now`.
 *
 * `interactive` (#221, default false) adds the per-event drag/resize vetoes the writable Gantt
 * needs; when false the output is exactly what it was before the option existed.
 * `deadlineInteractive` (#221 PR B2, default false) additionally opens the project bar's deadline
 * grip; it has no effect without `interactive`. Off, project bars keep the read-only output.
 */
export function buildProductionGanttModel(
  projects: readonly GanttProjectRowDto[],
  opts: {
    now: Date;
    interactive?: boolean;
    deadlineInteractive?: boolean;
    /**
     * #344: child row ids drawn but not counted against `PRODUCTION_GANTT_DRAW_CAP` — the Gantt's
     * display-only pins of just-created Subtasks. Inclusion and `tooManyToDraw` are decided on the
     * real rows alone, so a pin can never push its own project (and itself) out of the model.
     */
    budgetExemptRowIds?: ReadonlySet<string>;
  },
): ProductionGanttModel {
  const interactive = opts.interactive === true;
  const deadlineInteractive = interactive && opts.deadlineInteractive === true;
  const resources: ProductionGanttResource[] = [];
  const events: ProductionGanttEvent<ProductionGanttRowData>[] = [];
  const attention: ProductionGanttAttention[] = [];
  const includedProjectIds = new Set<string>();
  let rowBudget = 0;
  let tooManyToDraw = false;

  for (const project of projects) {
    const sortedChildren = sortSubtasksByRange(project.children.rows);
    const exempt = opts.budgetExemptRowIds;
    const rowCount = 1 + (exempt && exempt.size > 0 ? sortedChildren.filter((row) => !exempt.has(row.id)).length : sortedChildren.length);
    if (rowBudget + rowCount > PRODUCTION_GANTT_DRAW_CAP) {
      tooManyToDraw = true;
      break;
    }
    rowBudget += rowCount;
    includedProjectIds.add(project.id);

    // #919: the Stage tone drives `--gantt-event-color` on the Project bar and every Subtask bar.
    const tone = stageTone(project.stageKey);
    const color = tone.color;
    const projectResourceId = `project:${project.id}`;
    const childResources: ProductionGanttResource[] = [];

    for (const row of sortedChildren) {
      const taskResourceId = `task:${row.id}`;
      childResources.push({ id: taskResourceId, title: row.title, color, minRowHeight: SUBTASK_ROW_REM });
      const result = buildTaskResult(row, tone, opts.now, interactive);
      if (result.event) events.push(result.event);
      if (result.attention) attention.push(result.attention);
    }

    resources.push({ id: projectResourceId, title: project.street, color, minRowHeight: PROJECT_ROW_REM, children: childResources });

    // #429: a Project listed only as the parent of a matching checklist row (`deadlineInScope === false`)
    // draws no shoot -> Deadline bar and raises no attention entry: the filter did not select its Deadline.
    if (project.deadlineInScope === false) continue;
    const barResult = buildProjectBar(project, tone, opts.now, deadlineInteractive);
    if (barResult.event) events.push(barResult.event);
    if (barResult.attention) attention.push(barResult.attention);
  }

  return { resources, events, attention, tooManyToDraw, includedProjectIds };
}
