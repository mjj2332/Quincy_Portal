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
import { buildProductionGanttModel, ganttLandingProject, type ProductionGanttAttention, type ProductionGanttEvent, type ProductionGanttRowData } from "./production-gantt-adapter";
import { STAGE_HATCH_CLASS } from "./stage-colors";
import { endMoment, startMoment } from "@/testing/subtask-schedule";

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
    archived: false,
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
    assignees: [],
    otherAssigneeCount: 0,
    assignmentVersion: 0,
    schedule: oneDayRange("2026-03-05"),
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canEditAssignees: true },
    ...overrides,
  };
}

function timedEndpoint(localCivil: string, instant: string, utcOffsetMinutes: number, fold: 0 | 1): ChecklistScheduleEndpointDto {
  return { localCivil, instant, utcOffsetMinutes, fold, resolution: "stored" };
}

/** A one-day date range: the shape every former due-only Subtask takes (ADR 0011). */
function oneDayRange(civil: string): ChecklistScheduleDto {
  return rangeSchedule(startMoment(civil), endMoment(civil));
}

function rangeSchedule(start: ChecklistScheduleEndpointDto, end: ChecklistScheduleEndpointDto): ChecklistScheduleDto {
  return { state: "range", version: 1, zone: "Australia/Sydney", start, end, due: end.instant ?? end.localCivil };
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
        rows: [makeTask({ schedule: oneDayRange("2026-03-05") })],
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

describe("schedule kind: one-day range", () => {
  it("a one-day range is a timed bar from its 09:00 start to its 17:00 end", () => {
    const task = makeTask({ schedule: oneDayRange("2026-03-05") });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `task:${task.id}`);
    expect(event).toBeDefined();
    expect(event!.allDay).toBe(false);
    expect(event!.start.toISOString()).toBe("2026-03-04T22:00:00.000Z");
    expect(event!.end.toISOString()).toBe("2026-03-05T06:00:00.000Z");
    expect(event!.end.getTime()).toBeGreaterThan(event!.start.getTime());
  });

  it("a Subtask is never drawn as a milestone: no task event has zero length", () => {
    const rows = [
      makeTask({ schedule: oneDayRange("2026-03-05") }),
      makeTask({ schedule: rangeSchedule(timedEndpoint("2026-03-05T09:00", "2026-03-04T22:00:00.000Z", 660, 0), timedEndpoint("2026-03-05T09:30", "2026-03-04T22:30:00.000Z", 660, 0)) }),
    ];
    const model = buildProductionGanttModel([makeProject({ children: { rows, total: 2, returned: 2, truncated: false, nextCursor: null } })], { now: NOW });
    const taskEvents = model.events.filter((event) => event.resourceId?.startsWith("task:"));
    expect(taskEvents).toHaveLength(2);
    for (const event of taskEvents) expect(event.end.getTime()).toBeGreaterThan(event.start.getTime());
  });
});

describe("schedule kind: range", () => {
  it("a multi-day range is a timed bar from its start moment to its end moment", () => {
    const task = makeTask({ schedule: rangeSchedule(startMoment("2026-03-01"), endMoment("2026-03-03")) });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `task:${task.id}`);
    expect(event).toBeDefined();
    expect(event!.allDay).toBe(false);
    expect(event!.start.toISOString()).toBe("2026-02-28T22:00:00.000Z");
    expect(event!.end.toISOString()).toBe("2026-03-03T06:00:00.000Z");
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
    const task = makeTask({ schedule: rangeSchedule(timedEndpoint(repeatedLocalCivil, earlierInstant, 660, 0), timedEndpoint("2026-04-05T03:30", "2026-04-04T17:30:00.000Z", 600, 0)) });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `task:${task.id}`);
    expect(event!.start.getTime()).toBe(new Date(earlierInstant).getTime());
  });

  it("fold 1 (later occurrence) resolves to ITS OWN stored instant, one hour after fold 0 — not dropped, not merged", () => {
    const task = makeTask({ schedule: rangeSchedule(timedEndpoint(repeatedLocalCivil, laterInstant, 600, 1), timedEndpoint("2026-04-05T03:30", "2026-04-04T17:30:00.000Z", 600, 0)) });
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

describe("a range across a daylight-saving change is drawn at its real duration", () => {
  const durationOf = (start: string, end: string) => {
    const task = makeTask({ schedule: rangeSchedule(startMoment(start), endMoment(end)) });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const [event] = eventsFor(buildProductionGanttModel([project], { now: NOW }), `task:${task.id}`);
    expect(event).toBeDefined();
    return event!.end.getTime() - event!.start.getTime();
  };

  it("spring-forward (2026-10-04): noon to noon across the change is 23h, not 24h", () => {
    expect(durationOf("2026-10-03T12:00", "2026-10-04T12:00")).toBe(23 * 60 * 60 * 1000);
  });

  it("fall-back (2026-04-05): noon to noon across the change is 25h, not 24h", () => {
    expect(durationOf("2026-04-04T12:00", "2026-04-05T12:00")).toBe(25 * 60 * 60 * 1000);
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
    const task = makeTask({ schedule: oneDayRange("2026-03-05") });
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
      makeTask({ position: 3, schedule: oneDayRange("2026-03-05") }),
      makeTask({ position: 1, schedule: oneDayRange("2026-03-01") }),
      makeTask({ position: 2, schedule: oneDayRange("2026-03-05") }),
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
    // Deterministic order: by range start, then position — same ids, same order, regardless of arrival order.
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
        rows: Array.from({ length: 5 }, () => makeTask({ schedule: oneDayRange("2026-03-05") })),
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

  it("#344: a budget-exempt (pinned, just-created) row never tips its project past the cap", () => {
    // 1998 childless projects + one project with one real child fill the cap exactly (2000 rows).
    // The project's pinned row would make 2001 — without the exemption the whole project (and the
    // new bar) would drop out; with it, inclusion is decided on the real rows alone.
    const bulk = makeChildlessProjects(PRODUCTION_GANTT_DRAW_CAP - 2);
    const real = makeTask({ schedule: oneDayRange("2026-03-05") });
    const pinned = makeTask({ schedule: oneDayRange("2026-03-05") });
    const edge = makeProject({
      shootDateCivil: "2026-01-01",
      children: { rows: [real, pinned], total: 2, returned: 2, truncated: false, nextCursor: null },
    });
    const without = buildProductionGanttModel([...bulk, edge], { now: NOW });
    expect(without.includedProjectIds.has(edge.id)).toBe(false);
    const model = buildProductionGanttModel([...bulk, edge], { now: NOW, budgetExemptRowIds: new Set([pinned.id]) });
    expect(model.includedProjectIds.has(edge.id)).toBe(true);
    expect(model.tooManyToDraw).toBe(false);
    const edgeResource = model.resources.find((resource) => resource.id === `project:${edge.id}`);
    const childIds = edgeResource?.children?.map((child) => child.id) ?? [];
    expect(childIds).toHaveLength(2);
    expect(childIds).toEqual(expect.arrayContaining([`task:${real.id}`, `task:${pinned.id}`]));
  });

  it("#344: an exempt row does not free budget for a project that would not fit on its real rows", () => {
    const bulk = makeChildlessProjects(PRODUCTION_GANTT_DRAW_CAP - 1);
    const pinned = makeTask({ schedule: oneDayRange("2026-03-05") });
    const real = makeTask({ schedule: oneDayRange("2026-03-05") });
    const over = makeProject({
      shootDateCivil: "2026-01-01",
      children: { rows: [real, pinned], total: 2, returned: 2, truncated: false, nextCursor: null },
    });
    const model = buildProductionGanttModel([...bulk, over], { now: NOW, budgetExemptRowIds: new Set([pinned.id]) });
    expect(model.includedProjectIds.has(over.id)).toBe(false);
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
    const task = makeTask({ done: true, schedule: oneDayRange("2026-03-05") });
    const project = makeProject({ children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], { now: NOW });
    const [event] = eventsFor(model, `task:${task.id}`);
    expect(event!.progress).toBe(100);
  });

  it("a not-done task's event carries no progress field at all", () => {
    const task = makeTask({ done: false, schedule: oneDayRange("2026-03-05") });
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

// ---------------------------------------------------------------------------
// #221 — interactive option
// ---------------------------------------------------------------------------

describe("interactive option (#221)", () => {
  function taskEvent(task: GanttChecklistRowDto, interactive?: boolean) {
    const project = makeProject({ shootDateCivil: "2026-03-01", children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null } });
    const model = buildProductionGanttModel([project], interactive === undefined ? { now: NOW } : { now: NOW, interactive });
    return eventsFor(model, `task:${task.id}`)[0]!;
  }

  it("interactive:false (and omitted) adds no interaction keys at all", () => {
    const task = makeTask({ schedule: oneDayRange("2026-06-10") });
    for (const event of [taskEvent(task), taskEvent(task, false)]) {
      expect(event.readOnly).toBe(true);
      expect(Object.keys(event)).not.toContain("draggable");
      expect(Object.keys(event)).not.toContain("resizable");
      expect(Object.keys(event)).not.toContain("resizableEdges");
    }
  });

  it("one-day range task: draggable per canDrag, resizable per canResize (a positive-width bar with both grips)", () => {
    const dragging = taskEvent(makeTask({ schedule: oneDayRange("2026-06-10") }), true);
    expect([dragging.readOnly, dragging.draggable, dragging.resizable]).toEqual([false, true, true]);
    const resizeOnly = taskEvent(makeTask({ schedule: oneDayRange("2026-06-10"), permissions: { canDrag: false, canResize: true, canOpenScheduleEditor: true, canEditAssignees: true } }), true);
    expect([resizeOnly.readOnly, resizeOnly.draggable, resizeOnly.resizable]).toEqual([false, false, true]);
    const locked = taskEvent(makeTask({ schedule: oneDayRange("2026-06-10"), permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: true, canEditAssignees: true } }), true);
    expect([locked.readOnly, locked.draggable, locked.resizable]).toEqual([true, false, false]);
  });

  it("range task: draggable per canDrag, resizable per canResize, readOnly only when neither", () => {
    const schedule = rangeSchedule(startMoment("2026-06-10"), endMoment("2026-06-12"));
    const perms = (canDrag: boolean, canResize: boolean) => ({ canDrag, canResize, canOpenScheduleEditor: true, canEditAssignees: true });
    const resizeOnly = taskEvent(makeTask({ schedule, permissions: perms(false, true) }), true);
    expect([resizeOnly.readOnly, resizeOnly.draggable, resizeOnly.resizable]).toEqual([false, false, true]);
    const neither = taskEvent(makeTask({ schedule, permissions: perms(false, false) }), true);
    expect([neither.readOnly, neither.draggable, neither.resizable]).toEqual([true, false, false]);
    const both = taskEvent(makeTask({ schedule, permissions: perms(true, true) }), true);
    expect([both.readOnly, both.draggable, both.resizable]).toEqual([false, true, true]);
  });

  it("project bar: interactive alone leaves it read-only with no interaction keys (deadline writes are opt-in)", () => {
    const editable = makeProject({ shootDateCivil: "2026-03-01" });
    const [bar] = eventsFor(buildProductionGanttModel([editable], { now: NOW, interactive: true }), `project:${editable.id}`);
    expect(bar!.readOnly).toBe(true);
    expect(Object.keys(bar!)).not.toContain("draggable");
    expect(Object.keys(bar!)).not.toContain("resizable");
    expect(Object.keys(bar!)).not.toContain("resizableEdges");
    const [ignored] = eventsFor(buildProductionGanttModel([editable], { now: NOW, deadlineInteractive: true }), `project:${editable.id}`);
    expect(ignored!.readOnly).toBe(true);
    expect(Object.keys(ignored!)).not.toContain("resizable");
  });

  it("project bar (deadlineInteractive): never draggable, end edge resizable per canEditDeadline", () => {
    const editable = makeProject({ shootDateCivil: "2026-03-01" });
    const [bar] = eventsFor(buildProductionGanttModel([editable], { now: NOW, interactive: true, deadlineInteractive: true }), `project:${editable.id}`);
    expect(bar).toMatchObject({ readOnly: false, draggable: false, resizable: true, resizableEdges: { start: false, end: true } });

    const locked = makeProject({ shootDateCivil: "2026-03-01", permissions: { canEditDeadline: false, canEditChildren: true } });
    const [lockedBar] = eventsFor(buildProductionGanttModel([locked], { now: NOW, interactive: true, deadlineInteractive: true }), `project:${locked.id}`);
    expect(lockedBar).toMatchObject({ readOnly: true, draggable: false, resizable: false, resizableEdges: { start: false, end: false } });
  });

  it("an inverted (deadline before start) project bar stays readOnly even when editable", () => {
    const inverted = makeProject({ shootDateCivil: "2026-07-01" });
    const [bar] = eventsFor(buildProductionGanttModel([inverted], { now: NOW, interactive: true, deadlineInteractive: true }), `project:${inverted.id}`);
    expect(bar!.readOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #257: Edited review bars carry the hatch (a secondary cue beside the shared caution colour)
// ---------------------------------------------------------------------------

describe("#257: stage pattern class", () => {
  function projectWithChildren(stageKey: GanttProjectRowDto["stageKey"]) {
    const projectId = `11111111-1111-4111-8111-${stageKey === "edited_review" ? "000000000257" : "000000000258"}`;
    const rows = [
      makeTask({ projectId, schedule: rangeSchedule(startMoment("2026-03-02"), endMoment("2026-03-04")) }),
      makeTask({ projectId, schedule: oneDayRange("2026-03-05") }),
    ];
    return makeProject({
      id: projectId,
      stageKey,
      shootDateCivil: "2026-03-01",
      children: { rows, total: rows.length, returned: rows.length, truncated: false, nextCursor: null },
    });
  }

  it("an edited_review project bar AND each of its child task events carry the hatch class", () => {
    const project = projectWithChildren("edited_review");
    const model = buildProductionGanttModel([project], { now: NOW });
    expect(model.events).toHaveLength(3);
    for (const event of model.events) expect(event.className, event.id).toBe(STAGE_HATCH_CLASS);
  });

  it("a raw_review project (same caution colour) carries no class on the bar or its children", () => {
    const project = projectWithChildren("raw_review");
    const model = buildProductionGanttModel([project], { now: NOW });
    expect(model.events).toHaveLength(3);
    for (const event of model.events) expect(event.className, event.id).toBeUndefined();
  });

  it("the hatch sheds itself on completed and zero-length (diamond) bars", () => {
    // A project whose Deadline precedes its start draws as a milestone diamond; without the opt-out
    // the stripes would paint the transparent shell behind it.
    expect(STAGE_HATCH_CLASS.split(" ")).toEqual(
      expect.arrayContaining(["data-completed:bg-none", "data-milestone:bg-none"]),
    );
  });
});

// ---------------------------------------------------------------------------
// #414 — Subtask order
// ---------------------------------------------------------------------------

describe("#414: Subtask child order", () => {
  function childIds(tasks: GanttChecklistRowDto[]): string[] {
    const project = makeProject({
      shootDateCivil: "2026-01-15",
      children: { rows: tasks, total: tasks.length, returned: tasks.length, truncated: false, nextCursor: null },
    });
    const model = buildProductionGanttModel([project], { now: NOW });
    return (model.resources[0]?.children ?? []).map((child) => child.id.replace("task:", ""));
  }

  it("range start beats position", () => {
    const late = makeTask({ position: 1, schedule: oneDayRange("2026-03-09") });
    const early = makeTask({ position: 9, schedule: oneDayRange("2026-03-02") });
    expect(childIds([late, early])).toEqual([early.id, late.id]);
  });

  it("the same start orders by the earlier end", () => {
    const long = makeTask({ position: 1, schedule: rangeSchedule(startMoment("2026-03-02"), endMoment("2026-03-06")) });
    const short = makeTask({ position: 2, schedule: rangeSchedule(startMoment("2026-03-02"), endMoment("2026-03-03")) });
    expect(childIds([long, short])).toEqual([short.id, long.id]);
  });

  it("an identical range falls back to position, then id", () => {
    const b = makeTask({ id: "b-task", position: 2, schedule: oneDayRange("2026-03-02") });
    const a = makeTask({ id: "a-task", position: 2, schedule: oneDayRange("2026-03-02") });
    const first = makeTask({ id: "z-task", position: 1, schedule: oneDayRange("2026-03-02") });
    expect(childIds([b, a, first])).toEqual(["z-task", "a-task", "b-task"]);
  });

  it("compares resolved instants: the earlier start first, and the earlier end on a tie", () => {
    // Sydney AEDT (+11) on 2026-03-02: 09:00 local = 2026-03-01T22:00Z.
    const nine = makeTask({ position: 2, schedule: oneDayRange("2026-03-02") });
    const ten = makeTask({ position: 1, schedule: rangeSchedule(startMoment("2026-03-02T10:00"), endMoment("2026-03-02T15:00")) });
    expect(childIds([ten, nine])).toEqual([nine.id, ten.id]);
    const sameStartLong = makeTask({ position: 1, schedule: oneDayRange("2026-03-02") });
    const sameStartShort = makeTask({ position: 2, schedule: rangeSchedule(startMoment("2026-03-02T09:00"), endMoment("2026-03-02T15:00")) });
    expect(childIds([sameStartLong, sameStartShort])).toEqual([sameStartShort.id, sameStartLong.id]);
  });

  it("an unresolvable endpoint sorts after every resolved one", () => {
    const broken = makeTask({
      position: 1,
      schedule: rangeSchedule(timedEndpoint("2026-03-01T09:00", null as unknown as string, 660, 0), endMoment("2026-03-09")),
    });
    const ok = makeTask({ position: 5, schedule: oneDayRange("2026-06-30") });
    expect(childIds([broken, ok])).toEqual([ok.id, broken.id]);
  });

  it("does not mutate the input array and leaves Project order alone", () => {
    const t1 = makeTask({ position: 1, schedule: oneDayRange("2026-03-09") });
    const t2 = makeTask({ position: 2, schedule: oneDayRange("2026-03-02") });
    const rows = [t1, t2];
    const p1 = makeProject({ shootDateCivil: "2026-01-20", children: { rows, total: 2, returned: 2, truncated: false, nextCursor: null } });
    const p2 = makeProject({ shootDateCivil: "2026-01-10" });
    const model = buildProductionGanttModel([p1, p2], { now: NOW });
    expect(rows).toEqual([t1, t2]);
    expect(model.resources.map((r) => r.id)).toEqual([`project:${p1.id}`, `project:${p2.id}`]);
  });
});

// ---------------------------------------------------------------------------
// #415 — landing Project
// ---------------------------------------------------------------------------

describe("#415: ganttLandingProject", () => {
  // NOW = 2026-06-15T00:00Z = 10:00 AEST on 2026-06-15.
  const done = { complete: true };
  const dl = (at: string) => makeDeadline({ at });

  it("covers-now: the first of two covering rows wins", () => {
    const a = makeProject({ shootDateCivil: "2026-06-10", barStartDate: "2026-06-10", deadline: dl("2026-06-20T00:00:00.000Z") });
    const b = makeProject({ shootDateCivil: "2026-06-12", barStartDate: "2026-06-12", deadline: dl("2026-06-25T00:00:00.000Z") });
    expect(ganttLandingProject([a, b], NOW, done)).toEqual({ status: "found", projectId: a.id, rule: "covers_now" });
  });

  it("the Deadline instant is inclusive", () => {
    const a = makeProject({ shootDateCivil: "2026-06-10", barStartDate: "2026-06-10", deadline: dl(NOW.toISOString()) });
    expect(ganttLandingProject([a], NOW, done)).toMatchObject({ projectId: a.id, rule: "covers_now" });
  });

  it("no Deadline: covers only its shoot day", () => {
    const today = makeProject({ shootDateCivil: "2026-06-15", barStartDate: "2026-06-15", deadline: null });
    expect(ganttLandingProject([today], NOW, done)).toMatchObject({ projectId: today.id, rule: "covers_now" });
    const yesterday = makeProject({ shootDateCivil: "2026-06-14", barStartDate: "2026-06-14", deadline: null });
    const tomorrow = makeProject({ shootDateCivil: "2026-06-16", barStartDate: "2026-06-16", deadline: null });
    expect(ganttLandingProject([yesterday, tomorrow], NOW, done)).toMatchObject({ projectId: tomorrow.id, rule: "upcoming" });
  });

  it("no shoot date: the creation instant starts the bar", () => {
    const a = makeProject({
      shootDateCivil: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      barStartDate: "2026-06-01",
      deadline: dl("2026-06-30T00:00:00.000Z"),
    });
    expect(ganttLandingProject([a], NOW, done)).toMatchObject({ projectId: a.id, rule: "covers_now" });
  });

  it("no shoot date and no Deadline: the Sydney creation day is its shoot day", () => {
    // created 2026-06-14T15:00Z = 01:00 AEST 15 June.
    const a = makeProject({ shootDateCivil: null, createdAt: "2026-06-14T15:00:00.000Z", barStartDate: "2026-06-14", deadline: null });
    expect(ganttLandingProject([a], NOW, done)).toMatchObject({ projectId: a.id, rule: "covers_now" });
  });

  it("an inverted Deadline never covers now", () => {
    const inverted = makeProject({ shootDateCivil: "2026-06-20", barStartDate: "2026-06-20", deadline: dl("2026-06-10T00:00:00.000Z") });
    expect(ganttLandingProject([inverted], NOW, done)).toMatchObject({ projectId: inverted.id, rule: "upcoming" });
  });

  it("all-future lands on the first row; all-past on the last when complete", () => {
    const f1 = makeProject({ shootDateCivil: "2026-07-01", barStartDate: "2026-07-01" });
    const f2 = makeProject({ shootDateCivil: "2026-08-01", barStartDate: "2026-08-01" });
    expect(ganttLandingProject([f1, f2], NOW, done)).toMatchObject({ projectId: f1.id, rule: "upcoming" });
    const p1 = makeProject({ shootDateCivil: "2026-01-01", barStartDate: "2026-01-01" });
    const p2 = makeProject({ shootDateCivil: "2026-02-01", barStartDate: "2026-02-01" });
    expect(ganttLandingProject([p1, p2], NOW, done)).toEqual({ status: "found", projectId: p2.id, rule: "last_row" });
  });

  it("all-past is undecided while a later page may exist", () => {
    const p1 = makeProject({ shootDateCivil: "2026-01-01", barStartDate: "2026-01-01" });
    expect(ganttLandingProject([p1], NOW, { complete: false })).toEqual({ status: "undecided" });
  });

  it("empty: empty when complete, undecided otherwise", () => {
    expect(ganttLandingProject([], NOW, done)).toEqual({ status: "empty" });
    expect(ganttLandingProject([], NOW, { complete: false })).toEqual({ status: "undecided" });
  });

  it("a loaded row starting after today decides even when incomplete; one starting today does not", () => {
    const past = makeProject({ shootDateCivil: "2026-01-01", barStartDate: "2026-01-01" });
    const future = makeProject({ shootDateCivil: "2026-07-01", barStartDate: "2026-07-01" });
    expect(ganttLandingProject([past, future], NOW, { complete: false })).toMatchObject({ projectId: future.id, rule: "upcoming" });
    const todayRow = makeProject({ shootDateCivil: "2026-06-15", barStartDate: "2026-06-15", deadline: dl("2026-06-15T01:00:00.000Z") });
    const todayNotCovering = makeProject({ shootDateCivil: "2026-06-15", barStartDate: "2026-06-15", deadline: dl("2026-06-14T00:00:00.000Z") });
    expect(ganttLandingProject([past, todayNotCovering], NOW, { complete: false })).toEqual({ status: "undecided" });
    expect(ganttLandingProject([past, todayRow], NOW, { complete: false })).toMatchObject({ rule: "covers_now" });
  });

  it("Sydney boundary: 00:30 AEST on 1 Oct is already the 1 Oct shoot day", () => {
    const boundary = new Date("2026-09-30T14:30:00.000Z");
    const a = makeProject({ shootDateCivil: "2026-10-01", barStartDate: "2026-10-01", deadline: null });
    expect(ganttLandingProject([a], boundary, done)).toMatchObject({ projectId: a.id, rule: "covers_now" });
  });

  it("returns only Project ids, never a Subtask id", () => {
    const task = makeTask({ schedule: oneDayRange("2026-06-15") });
    const a = makeProject({
      shootDateCivil: "2026-06-15",
      barStartDate: "2026-06-15",
      deadline: null,
      children: { rows: [task], total: 1, returned: 1, truncated: false, nextCursor: null },
    });
    const landing = ganttLandingProject([a], NOW, done);
    expect(landing).toMatchObject({ projectId: a.id });
    expect(landing).not.toMatchObject({ projectId: task.id });
  });
});
