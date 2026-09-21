/**
 * #220 pass A — `production-gantt-adapter.ts` is pure (no React, no network), so this is a node
 * test with zero DOM, run against real `@quincy/shared` DTO shapes.
 *
 * DST fixture dates are real Sydney transitions, chosen to match the build spec's own worked
 * example: Sunday 5 April 2026 is the AEDT→AEST fall-back (25h day, and the repeated 02:00-02:59
 * local hour used for the fold tests); Sunday 4 October 2026 is the AEST→AEDT spring-forward (23h
 * day, and the nonexistent 02:00-02:59 local hour). Verified independently against
 * `Intl.DateTimeFormat` before writing these fixtures (not just asserted from memory of the AU DST
 * rule).
 */
import { describe, expect, it } from "vitest";
import type {
  ChecklistScheduleDto,
  ChecklistScheduleEndpointDto,
  GanttChecklistRowDto,
  GanttProjectDeadlineDto,
  GanttProjectRowDto,
} from "@quincy/shared";
import { PRODUCTION_GANTT_DRAW_CAP } from "@quincy/shared";
import { buildProductionGanttModel, type ProductionGanttAttention, type ProductionGanttEvent, type ProductionGanttRowData } from "./production-gantt-adapter";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeDeadline(overrides: Partial<NonNullable<GanttProjectDeadlineDto>> = {}): GanttProjectDeadlineDto {
  return {
    at: "2026-06-01T05:00:00.000Z",
    localCivil: "2026-06-01T15:00",
    version: 1,
    reminderOffsetsMinutes: [],
    overdue: false,
    ...overrides,
  };
}

let projectSeq = 0;
function makeProject(overrides: Partial<GanttProjectRowDto> = {}): GanttProjectRowDto {
  projectSeq += 1;
  const id = overrides.id ?? `11111111-1111-4111-8111-${String(projectSeq).padStart(12, "0")}`;
  return {
    id,
    street: `${projectSeq} Test St`,
    suburb: null,
    agencyName: null,
    agentName: null,
    stageKey: "awaiting_raw",
    delivered: false,
    shootDate: null,
    shootDateCivil: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    barStartDate: "2026-01-01",
    deadline: makeDeadline(),
    deadlineVersion: 1,
    editors: [],
    checklist: { completed: 0, total: 0 },
    permissions: { canEditDeadline: true, canEditChildren: true },
    children: { rows: [], total: 0, returned: 0, truncated: false, nextCursor: null },
    ...overrides,
  };
}

let taskSeq = 0;
function makeTask(overrides: Partial<GanttChecklistRowDto> = {}): GanttChecklistRowDto {
  taskSeq += 1;
  const id = overrides.id ?? `22222222-2222-4222-8222-${String(taskSeq).padStart(12, "0")}`;
  return {
    id,
    projectId: "11111111-1111-4111-8111-000000000001",
    title: `Task ${taskSeq}`,
    done: false,
    position: taskSeq,
    assignee: null,
    schedule: unscheduledSchedule(),
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true },
    ...overrides,
  };
}

function dateEndpoint(localCivil: string): ChecklistScheduleEndpointDto {
  return { kind: "date", localCivil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" };
}

function timedEndpoint(localCivil: string, instant: string, utcOffsetMinutes: number, fold: 0 | 1): ChecklistScheduleEndpointDto {
  return { kind: "timed", localCivil, instant, utcOffsetMinutes, fold, resolution: "stored" };
}

function unscheduledSchedule(): ChecklistScheduleDto {
  return { state: "unscheduled", version: 1, zone: "Australia/Sydney", start: null, end: null, due: null };
}

function dueOnlySchedule(end: ChecklistScheduleEndpointDto): ChecklistScheduleDto {
  return { state: "due_only", version: 1, zone: "Australia/Sydney", start: null, end, due: end.instant ?? end.localCivil };
}

function rangeSchedule(start: ChecklistScheduleEndpointDto, end: ChecklistScheduleEndpointDto): ChecklistScheduleDto {
  return { state: "range", version: 1, zone: "Australia/Sydney", start, end, due: end.instant ?? end.localCivil };
}

function legacyUnresolvedSchedule(): ChecklistScheduleDto {
  return {
    state: "legacy_unresolved",
    version: 0,
    zone: "Australia/Sydney",
    start: null,
    end: null,
    due: "2026-04-05T02:30",
    error: { code: "subtask_schedule_legacy_unresolved", reason: "repeated_local_time" },
  };
}

function invalidSchedule(): ChecklistScheduleDto {
  return {
    state: "invalid",
    version: 1,
    zone: null,
    start: null,
    end: null,
    due: null,
    error: { code: "subtask_schedule_storage_invalid", reason: "shape_mismatch" },
  };
}

const NOW = new Date("2026-06-15T00:00:00.000Z");

function eventsFor(model: ReturnType<typeof buildProductionGanttModel>, resourceId: string) {
  return model.events.filter((event) => event.resourceId === resourceId);
}

function attentionFor(model: ReturnType<typeof buildProductionGanttModel>, resourceId: string): ProductionGanttAttention | undefined {
  return model.attention.find((entry) => entry.resourceId === resourceId);
}

// ---------------------------------------------------------------------------
// readOnly invariant
// ---------------------------------------------------------------------------

describe("readOnly invariant", () => {
  it("every emitted event is readOnly, project bars and task bars alike", () => {
    const project = makeProject({
      shootDateCivil: "2026-03-01",
      children: {
        rows: [makeTask({ schedule: dueOnlySchedule(dateEndpoint("2026-03-05")) })],
        total: 1,
        returned: 1,
        truncated: false,
        nextCursor: null,
      },
    });
    const model = buildProductionGanttModel([project], { now: NOW });
    expect(model.events.length).toBeGreaterThan(0);
    for (const event of model.events) expect(event.readOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Five schedule kinds
// ---------------------------------------------------------------------------

describe("schedule kind: unscheduled", () => {
  it("produces a resource node, no event, and an 'unscheduled' attention entry", () => {
    const task = makeTask({ schedule: unscheduledSchedule() });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const taskResourceId = `task:${task.id}`;
    expect(eventsFor(model, taskResourceId)).toEqual([]);
    expect(attentionFor(model, taskResourceId)).toMatchObject({ kind: "task", reason: "unscheduled" });
    expect(model.resources[0]?.children?.some((child) => child.id === taskResourceId)).toBe(true);
  });
});

describe("schedule kind: legacy_unresolved", () => {
  it("produces a resource node, no event, and a 'legacy_unresolved' attention entry", () => {
    const task = makeTask({ schedule: legacyUnresolvedSchedule() });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const taskResourceId = `task:${task.id}`;
    expect(eventsFor(model, taskResourceId)).toEqual([]);
    expect(attentionFor(model, taskResourceId)).toMatchObject({ kind: "task", reason: "legacy_unresolved" });
  });
});

describe("schedule kind: invalid", () => {
  it("produces a resource node, no event, and an 'invalid' attention entry", () => {
    const task = makeTask({ schedule: invalidSchedule() });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const taskResourceId = `task:${task.id}`;
    expect(eventsFor(model, taskResourceId)).toEqual([]);
    expect(attentionFor(model, taskResourceId)).toMatchObject({ kind: "task", reason: "invalid" });
  });
});

describe("schedule kind: due_only", () => {
  it("date endpoint produces a zero-length allDay event (gantt-bar.tsx renders start===end as a milestone)", () => {
    const task = makeTask({ schedule: dueOnlySchedule(dateEndpoint("2026-03-05")) });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `task:${task.id}`);
    expect(event).toBeDefined();
    expect(event!.start.getTime()).toBe(event!.end.getTime());
    expect(event!.allDay).toBe(true);
  });

  it("timed endpoint produces a zero-length non-allDay event anchored on the stored instant", () => {
    const instant = "2026-03-05T04:30:00.000Z";
    const task = makeTask({ schedule: dueOnlySchedule(timedEndpoint("2026-03-05T15:30", instant, 660, 0)) });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `task:${task.id}`);
    expect(event).toBeDefined();
    expect(event!.start.getTime()).toBe(new Date(instant).getTime());
    expect(event!.end.getTime()).toBe(new Date(instant).getTime());
    expect(event!.allDay).toBe(false);
  });
});

describe("schedule kind: range", () => {
  it("date endpoints produce an allDay event with an exclusive, civil-shifted end", () => {
    const task = makeTask({ schedule: rangeSchedule(dateEndpoint("2026-03-01"), dateEndpoint("2026-03-03")) });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `task:${task.id}`);
    expect(event).toBeDefined();
    expect(event!.allDay).toBe(true);
    // Inclusive last day 2026-03-03 -> exclusive end is civil midnight of 2026-03-04, not
    // 2026-03-03 (pitfall 4: forgetting the advance) and not the sum of raw milliseconds.
    expect(event!.end.getTime()).toBeGreaterThan(event!.start.getTime());
  });

  it("timed endpoints produce a non-allDay event using each endpoint's own stored instant", () => {
    const startInstant = "2026-03-01T00:00:00.000Z";
    const endInstant = "2026-03-01T06:00:00.000Z";
    const task = makeTask({
      schedule: rangeSchedule(
        timedEndpoint("2026-03-01T11:00", startInstant, 660, 0),
        timedEndpoint("2026-03-01T17:00", endInstant, 660, 0),
      ),
    });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `task:${task.id}`);
    expect(event).toBeDefined();
    expect(event!.allDay).toBe(false);
    expect(event!.start.getTime()).toBe(new Date(startInstant).getTime());
    expect(event!.end.getTime()).toBe(new Date(endInstant).getTime());
  });
});

// ---------------------------------------------------------------------------
// Pitfall 1 — never construct a Date from date-only text
// ---------------------------------------------------------------------------

describe("pitfall 1: date-only civil text is resolved through the Sydney resolver, never `new Date(dateOnly)`", () => {
  it("a project's shoot-date bar start is NOT UTC midnight of that date", () => {
    const project = makeProject({ shootDateCivil: "2026-04-05" });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `project:${project.id}`);
    expect(event).toBeDefined();
    const naiveWrongValue = new Date("2026-04-05").getTime();
    expect(event!.start.getTime()).not.toBe(naiveWrongValue);
    // Sydney civil midnight of 2026-04-05 (AEDT, +11:00 — before that day's fall-back at 3am).
    expect(event!.start.toISOString()).toBe("2026-04-04T13:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Pitfall 2 — both fold instants of a repeated local time
// ---------------------------------------------------------------------------

describe("pitfall 2: a stored timed endpoint always uses its own instant, never a re-resolved localCivil", () => {
  const repeatedLocalCivil = "2026-04-05T02:30";
  // AEDT (fold 0, first occurrence) and AEST (fold 1, second occurrence) of the same local text,
  // one hour apart in real time despite an identical `localCivil` string.
  const earlierInstant = "2026-04-04T15:30:00.000Z";
  const laterInstant = "2026-04-04T16:30:00.000Z";

  it("fold 0 (earlier occurrence) resolves to its own stored instant", () => {
    const task = makeTask({ schedule: dueOnlySchedule(timedEndpoint(repeatedLocalCivil, earlierInstant, 660, 0)) });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `task:${task.id}`);
    expect(event!.start.getTime()).toBe(new Date(earlierInstant).getTime());
  });

  it("fold 1 (later occurrence) resolves to ITS OWN stored instant, one hour after fold 0 — not dropped, not merged", () => {
    const task = makeTask({ schedule: dueOnlySchedule(timedEndpoint(repeatedLocalCivil, laterInstant, 600, 1)) });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `task:${task.id}`);
    expect(event!.start.getTime()).toBe(new Date(laterInstant).getTime());
    expect(event!.start.getTime() - new Date(earlierInstant).getTime()).toBe(60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Pitfalls 3 & 4 — civil-date advance, both DST directions
// ---------------------------------------------------------------------------

describe("pitfalls 3 & 4: inclusive->exclusive end is a civil-date shift, not a millisecond add", () => {
  it("23h spring-forward day (2026-10-04): a single-day range's real duration is 23h, not 24h", () => {
    const task = makeTask({ schedule: rangeSchedule(dateEndpoint("2026-10-04"), dateEndpoint("2026-10-04")) });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `task:${task.id}`);
    expect(event).toBeDefined();
    const durationMs = event!.end.getTime() - event!.start.getTime();
    expect(durationMs).toBe(23 * 60 * 60 * 1000);
    expect(durationMs).not.toBe(24 * 60 * 60 * 1000); // pitfall 3: naive +86_400_000ms overhangs
  });

  it("25h fall-back day (2026-04-05): a single-day range's real duration is 25h, not 24h", () => {
    const task = makeTask({ schedule: rangeSchedule(dateEndpoint("2026-04-05"), dateEndpoint("2026-04-05")) });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `task:${task.id}`);
    expect(event).toBeDefined();
    const durationMs = event!.end.getTime() - event!.start.getTime();
    expect(durationMs).toBe(25 * 60 * 60 * 1000);
    expect(durationMs).not.toBe(24 * 60 * 60 * 1000);
  });

  it("pitfall 4: the exclusive-end advance is never skipped — end is always strictly after start for a date range", () => {
    const task = makeTask({ schedule: rangeSchedule(dateEndpoint("2026-03-01"), dateEndpoint("2026-03-01")) });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `task:${task.id}`);
    expect(event!.end.getTime()).toBeGreaterThan(event!.start.getTime());
  });
});

// ---------------------------------------------------------------------------
// Missing shoot date / missing deadline / end < start
// ---------------------------------------------------------------------------

describe("project bar edge cases", () => {
  it("missing shoot date: bar starts at createdAt with hollowStart: true", () => {
    const project = makeProject({ shootDateCivil: null, createdAt: "2026-02-10T04:00:00.000Z" });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `project:${project.id}`);
    expect(event).toBeDefined();
    expect(event!.start.getTime()).toBe(new Date("2026-02-10T04:00:00.000Z").getTime());
    const data = event!.data as ProductionGanttRowData;
    expect(data).toMatchObject({ kind: "project", hollowStart: true, missingDeadline: false });
  });

  it("present shoot date: hollowStart is false", () => {
    const project = makeProject({ shootDateCivil: "2026-02-10" });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `project:${project.id}`);
    const data = event!.data as ProductionGanttRowData;
    expect(data).toMatchObject({ hollowStart: false });
  });

  it("missing deadline: no project event, and an attention entry with missingDeadline: true", () => {
    const project = makeProject({ deadline: null });
    const model = buildProductionGanttModel([project], { now: NOW });
    const resourceId = `project:${project.id}`;
    expect(eventsFor(model, resourceId)).toEqual([]);
    expect(attentionFor(model, resourceId)).toMatchObject({ kind: "project", reason: "missing_deadline", missingDeadline: true });
    // The resource node itself still exists — store nothing, mutate nothing, but never drop the row.
    expect(model.resources.some((resource) => resource.id === resourceId)).toBe(true);
  });

  it("deadline before the derived start: a zero-length diamond at the deadline, never an inverted or clamped bar, plus attention", () => {
    const project = makeProject({
      shootDateCivil: "2026-06-10",
      deadline: makeDeadline({ at: "2026-06-01T00:00:00.000Z" }),
    });
    const model = buildProductionGanttModel([project], { now: NOW });
    const resourceId = `project:${project.id}`;
    const [event] = eventsFor(model, resourceId);
    expect(event).toBeDefined();
    expect(event!.start.getTime()).toBe(event!.end.getTime());
    expect(event!.start.getTime()).toBe(new Date("2026-06-01T00:00:00.000Z").getTime());
    expect(attentionFor(model, resourceId)).toMatchObject({ kind: "project", reason: "deadline_before_start" });
  });
});

// ---------------------------------------------------------------------------
// Id stability
// ---------------------------------------------------------------------------

describe("id stability across repeated input", () => {
  it("the same input produces the same resource/event ids on every call", () => {
    const task = makeTask({ schedule: dueOnlySchedule(dateEndpoint("2026-03-05")) });
    const project = makeProject({
      shootDateCivil: "2026-03-01",
      children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null },
    });
    const first = buildProductionGanttModel([project], { now: NOW });
    const second = buildProductionGanttModel([project], { now: new Date("2026-07-01T00:00:00.000Z") });
    expect(second.resources.map((resource) => resource.id)).toEqual(first.resources.map((resource) => resource.id));
    expect(second.events.map((event) => event.id)).toEqual(first.events.map((event) => event.id));
    expect(first.resources[0]?.id).toBe(`project:${project.id}`);
    expect(first.events.find((event) => event.resourceId === `project:${project.id}`)?.id).toBe(`project-bar:${project.id}`);
    expect(first.resources[0]?.children?.[0]?.id).toBe(`task:${task.id}`);
    expect(first.events.find((event) => event.resourceId === `task:${task.id}`)?.id).toBe(`task:${task.id}`);
  });
});

// ---------------------------------------------------------------------------
// S5 — pagination merge-order independence
// ---------------------------------------------------------------------------

/**
 * Signature projections for the merge-order test below: they compare everything the adapter
 * itself guarantees (ids, order, resolved dates, attention reasons) without tripping over
 * `event.data.dto`/`resource` echoing the CALLER's raw `children.rows` array — which the adapter
 * never reorders or clones ("store nothing, mutate nothing"), so its element order is a property
 * of the input, not something the adapter promises to normalize.
 */
function resourceSignature(resources: ReturnType<typeof buildProductionGanttModel>["resources"]): unknown {
  return resources.map((resource) => ({
    id: resource.id,
    title: resource.title,
    children: resource.children ? resourceSignature(resource.children) : undefined,
  }));
}

function eventSignatures(model: ReturnType<typeof buildProductionGanttModel>) {
  return model.events.map((event) => ({
    id: event.id,
    resourceId: event.resourceId,
    startMs: event.start.getTime(),
    endMs: event.end.getTime(),
    allDay: event.allDay,
    kind: (event.data as ProductionGanttRowData).kind,
  }));
}

function attentionSignatures(model: ReturnType<typeof buildProductionGanttModel>) {
  return model.attention.map((entry) => ({ resourceId: entry.resourceId, kind: entry.kind, reason: entry.reason }));
}

describe("S5: merge-order independence", () => {
  it("a project's children produce the same model regardless of the order they arrived in", () => {
    const tasks = [
      makeTask({ position: 3, schedule: dueOnlySchedule(dateEndpoint("2026-03-05")) }),
      makeTask({ position: 1, schedule: dueOnlySchedule(dateEndpoint("2026-03-01")) }),
      makeTask({ position: 2, schedule: unscheduledSchedule() }),
    ];
    const projectAllAtOnce = makeProject({
      shootDateCivil: "2026-01-15",
      children: { rows: tasks, total: 3, returned: 3, truncated: false, nextCursor: null },
    });
    // Same rows, arrived in a different order (e.g. a later page merged ahead of an earlier one).
    const projectPaged = makeProject({
      id: projectAllAtOnce.id,
      street: projectAllAtOnce.street,
      shootDateCivil: "2026-01-15",
      children: { rows: [tasks[1]!, tasks[2]!, tasks[0]!], total: 3, returned: 3, truncated: false, nextCursor: null },
    });

    const modelAllAtOnce = buildProductionGanttModel([projectAllAtOnce], { now: NOW });
    const modelPaged = buildProductionGanttModel([projectPaged], { now: NOW });

    expect(resourceSignature(modelPaged.resources)).toEqual(resourceSignature(modelAllAtOnce.resources));
    expect(eventSignatures(modelPaged)).toEqual(eventSignatures(modelAllAtOnce));
    expect(attentionSignatures(modelPaged)).toEqual(attentionSignatures(modelAllAtOnce));
    // Deterministic order: by position, ascending — same ids, same order, regardless of arrival order.
    expect(modelAllAtOnce.resources[0]?.children?.map((child) => child.id)).toEqual([
      `task:${tasks[1]!.id}`,
      `task:${tasks[2]!.id}`,
      `task:${tasks[0]!.id}`,
    ]);
    expect(modelPaged.resources[0]?.children?.map((child) => child.id)).toEqual(
      modelAllAtOnce.resources[0]?.children?.map((child) => child.id),
    );
  });
});

// ---------------------------------------------------------------------------
// S5 — draw cap
// ---------------------------------------------------------------------------

describe("S5: PRODUCTION_GANTT_DRAW_CAP", () => {
  function makeChildlessProjects(count: number): GanttProjectRowDto[] {
    return Array.from({ length: count }, () => makeProject({ shootDateCivil: "2026-01-01" }));
  }

  it("at exactly the cap, every project is included and tooManyToDraw is false", () => {
    const projects = makeChildlessProjects(PRODUCTION_GANTT_DRAW_CAP);
    const model = buildProductionGanttModel(projects, { now: NOW });
    expect(model.resources).toHaveLength(PRODUCTION_GANTT_DRAW_CAP);
    expect(model.tooManyToDraw).toBe(false);
  });

  it("one row past the cap: the model signals tooManyToDraw rather than silently truncating unmarked", () => {
    const projects = makeChildlessProjects(PRODUCTION_GANTT_DRAW_CAP + 1);
    const model = buildProductionGanttModel(projects, { now: NOW });
    expect(model.resources).toHaveLength(PRODUCTION_GANTT_DRAW_CAP);
    expect(model.tooManyToDraw).toBe(true);
  });

  it("stops at the first project that would exceed the cap, even if a later project would have fit alone", () => {
    // 1999 childless projects (1 row each) + one project with 5 children (6 rows) tips the budget
    // to 2004 at that project, past the cap — it is excluded WHOLESALE, not partially, and the
    // scan stops there rather than resuming with later, smaller projects.
    const bulk = makeChildlessProjects(PRODUCTION_GANTT_DRAW_CAP - 1);
    const tippingProject = makeProject({
      shootDateCivil: "2026-01-01",
      children: {
        rows: Array.from({ length: 5 }, () => makeTask({ schedule: unscheduledSchedule() })),
        total: 5,
        returned: 5,
        truncated: false,
        nextCursor: null,
      },
    });
    const trailingSmallProject = makeProject({ shootDateCivil: "2026-01-01" });
    const model = buildProductionGanttModel([...bulk, tippingProject, trailingSmallProject], { now: NOW });
    expect(model.resources).toHaveLength(PRODUCTION_GANTT_DRAW_CAP - 1);
    expect(model.resources.some((resource) => resource.id === `project:${tippingProject.id}`)).toBe(false);
    expect(model.resources.some((resource) => resource.id === `project:${trailingSmallProject.id}`)).toBe(false);
    expect(model.tooManyToDraw).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fix-220-sol1 #3 — includedProjectIds tracks the draw-cap walk
// ---------------------------------------------------------------------------

describe("fix-220-sol1 #3: includedProjectIds", () => {
  function makeChildlessProjects(count: number): GanttProjectRowDto[] {
    return Array.from({ length: count }, () => makeProject({ shootDateCivil: "2026-01-01" }));
  }

  it("at exactly the cap, every project id is included", () => {
    const projects = makeChildlessProjects(PRODUCTION_GANTT_DRAW_CAP);
    const model = buildProductionGanttModel(projects, { now: NOW });
    expect(model.includedProjectIds.size).toBe(PRODUCTION_GANTT_DRAW_CAP);
    for (const project of projects) expect(model.includedProjectIds.has(project.id)).toBe(true);
  });

  it("one row past the cap: the tipping project and everything after it is excluded from includedProjectIds, matching resources", () => {
    const projects = makeChildlessProjects(PRODUCTION_GANTT_DRAW_CAP + 1);
    const model = buildProductionGanttModel(projects, { now: NOW });
    expect(model.includedProjectIds.size).toBe(PRODUCTION_GANTT_DRAW_CAP);
    const lastProject = projects[projects.length - 1]!;
    expect(model.includedProjectIds.has(lastProject.id)).toBe(false);
    // Every included id has a matching resource, and vice versa — the two never disagree.
    expect([...model.includedProjectIds].sort()).toEqual(
      model.resources.map((resource) => resource.id.replace(/^project:/, "")).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// fix-220-sol1 #4 — completion maps into GanttEvent.progress
// ---------------------------------------------------------------------------

describe("fix-220-sol1 #4: progress mapping", () => {
  it("a done task's event carries progress: 100", () => {
    const task = makeTask({ done: true, schedule: dueOnlySchedule(dateEndpoint("2026-03-05")) });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `task:${task.id}`);
    expect(event!.progress).toBe(100);
  });

  it("a not-done task's event carries no progress field at all", () => {
    const task = makeTask({ done: false, schedule: dueOnlySchedule(dateEndpoint("2026-03-05")) });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `task:${task.id}`);
    expect(event).toBeDefined();
    expect("progress" in event!).toBe(false);
  });

  it("a project's bar progress is checklist.completed / checklist.total, rounded to the nearest percent", () => {
    const project = makeProject({ shootDateCivil: "2026-03-01", checklist: { completed: 1, total: 3 } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `project:${project.id}`);
    expect(event!.progress).toBe(33); // 1/3 = 33.33...% rounds to 33
  });

  it("a project with checklist.total 0 carries no progress field", () => {
    const project = makeProject({ shootDateCivil: "2026-03-01", checklist: { completed: 0, total: 0 } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `project:${project.id}`);
    expect(event).toBeDefined();
    expect("progress" in event!).toBe(false);
  });

  it("a fully-complete project's bar progress is exactly 100", () => {
    const project = makeProject({ shootDateCivil: "2026-03-01", checklist: { completed: 4, total: 4 } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `project:${project.id}`);
    expect(event!.progress).toBe(100);
  });

  // fix-220-sol2 #6: Math.round((199 / 200) * 100) === 100 — a genuinely incomplete project must
  // never report 100 (which the UI reads as "done": completed styling, a done checkmark).
  it("199/200 (incomplete, rounds to 100 unmitigated) reports 99, not 100", () => {
    const project = makeProject({ shootDateCivil: "2026-03-01", checklist: { completed: 199, total: 200 } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `project:${project.id}`);
    expect(event!.progress).toBe(99);
  });

  it("200/200 (genuinely complete) reports exactly 100", () => {
    const project = makeProject({ shootDateCivil: "2026-03-01", checklist: { completed: 200, total: 200 } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `project:${project.id}`);
    expect(event!.progress).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Type-level: this module's output must remain assignable to the real vendored Gantt types
// without a cast (see production-gantt-adapter.ts's header for why it does not import them).
// ---------------------------------------------------------------------------

describe("structural shape", () => {
  it("an event's own fields are exactly the ones ProductionGanttEvent declares (id/title/start/end/allDay/color/readOnly/resourceId/data)", () => {
    const project = makeProject({ shootDateCivil: "2026-03-01" });
    const model = buildProductionGanttModel([project], { now: NOW });
    const event: ProductionGanttEvent<ProductionGanttRowData> = model.events[0]!;
    expect(Object.keys(event).sort()).toEqual(
      ["allDay", "color", "data", "end", "id", "readOnly", "resourceId", "start", "title"].sort(),
    );
  });
});
