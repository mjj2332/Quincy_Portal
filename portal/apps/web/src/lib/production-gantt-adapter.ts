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
 * resource; id/title/start/end/allDay/color/readOnly/resourceId/data for an event), every field
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
  shiftSydneyCalendarDate,
  type GanttChecklistRowDto,
  type GanttProjectRowDto,
} from "@quincy/shared";
import { stageColorFor } from "./stage-colors";

// ---------------------------------------------------------------------------
// Local, structurally-`GanttResource`/`GanttEvent`-compatible shapes — see header.
// ---------------------------------------------------------------------------

export interface ProductionGanttResource {
  id: string;
  title: string;
  color?: string;
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
  data?: TData;
}

/** The facts every project/task row carries, whether it produced an event or landed in `attention`. */
export type ProductionGanttRowFacts =
  | { kind: "project"; dto: GanttProjectRowDto; hollowStart: boolean; missingDeadline: boolean }
  | { kind: "task"; dto: GanttChecklistRowDto; hollowStart: false; missingDeadline: false };

/** `GanttEvent.data`'s shape for every event this adapter emits. */
export type ProductionGanttRowData = ProductionGanttRowFacts;

/**
 * Why a row produced no event. Facts, not copy — the surface decides the displayed label
 * ("the adapter does not decide copy").
 */
export type ProductionGanttAttentionReason =
  | "unscheduled"
  | "legacy_unresolved"
  | "invalid"
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

type EndpointResolution = { ok: true; date: Date } | { ok: false };

/** `resolve(localCivil + "T00:00")` — a Sydney calendar date's civil midnight, as an instant. */
function resolveCivilDayStart(localCivilDate: string): EndpointResolution {
  const resolved = resolveSydneyCivilMinute(`${localCivilDate}T00:00`);
  return resolved.ok ? { ok: true, date: new Date(resolved.value.epochMs) } : { ok: false };
}

/** `resolve(shiftSydneyCalendarDate(localCivil, 1) + "T00:00")` — the exclusive end of a date range. */
function resolveExclusiveEndOfDay(localCivilDate: string): EndpointResolution {
  const shifted = shiftSydneyCalendarDate(localCivilDate, 1);
  if (!shifted.ok) return { ok: false };
  return resolveCivilDayStart(shifted.value);
}

/** A stored `timed` endpoint's `instant` — already carries the fold; never re-resolve `localCivil`. */
function resolveStoredInstant(instant: string | null): EndpointResolution {
  if (instant === null) return { ok: false };
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? { ok: false } : { ok: true, date };
}

// ---------------------------------------------------------------------------
// Per-row builders
// ---------------------------------------------------------------------------

interface RowBuildResult {
  event: ProductionGanttEvent<ProductionGanttRowData> | null;
  attention: ProductionGanttAttention | null;
}

function buildTaskResult(row: GanttChecklistRowDto, color: string): RowBuildResult {
  const schedule = row.schedule;
  const resourceId = `task:${row.id}`;
  const attentionFor = (reason: ProductionGanttAttentionReason): ProductionGanttAttention => ({
    kind: "task",
    dto: row,
    hollowStart: false,
    missingDeadline: false,
    reason,
    resourceId,
  });

  if (schedule.state === "unscheduled") return { event: null, attention: attentionFor("unscheduled") };
  if (schedule.state === "legacy_unresolved") return { event: null, attention: attentionFor("legacy_unresolved") };
  if (schedule.state === "invalid") return { event: null, attention: attentionFor("invalid") };

  if (schedule.state === "due_only") {
    const end = schedule.end;
    if (!end) return { event: null, attention: attentionFor("invalid") };
    const resolved = end.kind === "date" ? resolveCivilDayStart(end.localCivil) : resolveStoredInstant(end.instant);
    if (!resolved.ok) return { event: null, attention: attentionFor("resolution_failed") };
    return {
      event: {
        id: resourceId,
        title: row.title,
        start: resolved.date,
        end: resolved.date,
        allDay: end.kind === "date",
        color,
        readOnly: true,
        resourceId,
        // fix-220-sol1 #4: a task carries no partial-progress field, only `done` — map it to the
        // binary 100/omitted `GanttEvent.progress` the renderer's done-check reads, rather than
        // never populating it at all.
        ...(row.done ? { progress: 100 } : {}),
        data: { kind: "task", dto: row, hollowStart: false, missingDeadline: false },
      },
      attention: null,
    };
  }

  // schedule.state === "range" — start/end always share a kind.
  const { start, end } = schedule;
  if (!start || !end) return { event: null, attention: attentionFor("invalid") };
  const startResolved =
    start.kind === "date" ? resolveCivilDayStart(start.localCivil) : resolveStoredInstant(start.instant);
  if (!startResolved.ok) return { event: null, attention: attentionFor("resolution_failed") };
  const endResolved =
    end.kind === "date" ? resolveExclusiveEndOfDay(end.localCivil) : resolveStoredInstant(end.instant);
  if (!endResolved.ok) return { event: null, attention: attentionFor("resolution_failed") };
  return {
    event: {
      id: resourceId,
      title: row.title,
      start: startResolved.date,
      end: endResolved.date,
      allDay: start.kind === "date",
      color,
      readOnly: true,
      resourceId,
      ...(row.done ? { progress: 100 } : {}),
      data: { kind: "task", dto: row, hollowStart: false, missingDeadline: false },
    },
    attention: null,
  };
}

function buildProjectBar(project: GanttProjectRowDto, color: string): RowBuildResult {
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
  // `Math.round((199 / 200) * 100)` is `100` — which then renders the completed styling and the
  // done checkmark (`renderGanttEventContent` in `ProductionGantt.tsx`, `progress === 100`) on a
  // project that still has work outstanding. `100` is now emitted only when every row is actually
  // done; every other ratio is rounded normally and then capped at `99`, so "nearly done" and
  // "actually done" can never collide on the one value the UI treats as a completion signal.
  const progress =
    project.checklist.total > 0
      ? project.checklist.completed === project.checklist.total
        ? 100
        : Math.min(99, Math.round((project.checklist.completed / project.checklist.total) * 100))
      : undefined;
  const event: ProductionGanttEvent<ProductionGanttRowData> = {
    id: `project-bar:${project.id}`,
    title: project.street,
    start: barStart,
    end: endDate,
    allDay: false,
    color,
    readOnly: true,
    resourceId,
    ...(progress !== undefined ? { progress } : {}),
    data: { kind: "project", dto: project, hollowStart, missingDeadline: false },
  };
  return {
    event,
    attention: inverted
      ? { kind: "project", dto: project, hollowStart, missingDeadline: false, reason: "deadline_before_start", resourceId }
      : null,
  };
}

/** Deterministic child order, independent of page-arrival order: `position`, then `id` as a tiebreak. */
function compareChecklistRows(a: GanttChecklistRowDto, b: GanttChecklistRowDto): number {
  if (a.position !== b.position) return a.position - b.position;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `now` is accepted (not `Date.now()` read internally) for determinism/testability, matching this
 * codebase's other builders — nothing in this pass's contract is `now`-relative (no "today"
 * marker, no client-side overdue recompute: `GanttProjectDeadlineDto.overdue` is already
 * server-computed), so it is intentionally unused today. Kept for signature stability into pass B.
 */
export function buildProductionGanttModel(
  projects: readonly GanttProjectRowDto[],
  _opts: { now: Date },
): ProductionGanttModel {
  const resources: ProductionGanttResource[] = [];
  const events: ProductionGanttEvent<ProductionGanttRowData>[] = [];
  const attention: ProductionGanttAttention[] = [];
  const includedProjectIds = new Set<string>();
  let rowBudget = 0;
  let tooManyToDraw = false;

  for (const project of projects) {
    const sortedChildren = [...project.children.rows].sort(compareChecklistRows);
    const rowCount = 1 + sortedChildren.length;
    if (rowBudget + rowCount > PRODUCTION_GANTT_DRAW_CAP) {
      tooManyToDraw = true;
      break;
    }
    rowBudget += rowCount;
    includedProjectIds.add(project.id);

    const color = stageColorFor(project.stageKey);
    const projectResourceId = `project:${project.id}`;
    const childResources: ProductionGanttResource[] = [];

    for (const row of sortedChildren) {
      const taskResourceId = `task:${row.id}`;
      childResources.push({ id: taskResourceId, title: row.title, color });
      const result = buildTaskResult(row, color);
      if (result.event) events.push(result.event);
      if (result.attention) attention.push(result.attention);
    }

    resources.push({ id: projectResourceId, title: project.street, color, children: childResources });

    const barResult = buildProjectBar(project, color);
    if (barResult.event) events.push(barResult.event);
    if (barResult.attention) attention.push(barResult.attention);
  }

  return { resources, events, attention, tooManyToDraw, includedProjectIds };
}
