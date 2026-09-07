import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_CALENDAR_ZONE, type ChecklistCalendarUnscheduledEntryDto, type ProjectCalendarUnscheduledEntryDto } from "@quincy/shared";
import { ProductionCalendarUnscheduledPanel } from "./ProductionCalendarUnscheduledPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projectId = "11111111-1111-4111-8111-111111111111";
const assigneeId = "22222222-2222-4222-8222-222222222222";

const projectContext = (id = projectId, delivered = false) => ({
  id,
  street: `${id === projectId ? "12 Harbour Street" : "13 Harbour Street"}`,
  stageKey: "editing_autohdr" as const,
  checklist: { completed: 1, total: 3 },
  delivered,
});

function projectEntry(id = "project-deadline:one", delivered = false, canDrag = !delivered): ProjectCalendarUnscheduledEntryDto {
  return { id, kind: "project_deadline", reason: "unscheduled", title: "Project handoff", project: projectContext(projectId, delivered), permissions: { canDrag, canResize: false }, deadlineVersion: 3, reminderOffsetsMinutes: [] };
}

function checklistEntry(id = "checklist:one", canDrag = true, canScheduleRange = true): ChecklistCalendarUnscheduledEntryDto {
  return { id, kind: "checklist", reason: "unscheduled", title: "Select hero images", project: projectContext(), assignee: { id: assigneeId, name: "Maya Editor", roleLabel: "Editor", isExternal: false, active: true }, schedule: { state: "unscheduled", version: 4, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: null }, permissions: { canDrag, canResize: false, canOpenScheduleEditor: true, canScheduleRange } };
}

function legacyEntry(): ChecklistCalendarUnscheduledEntryDto {
  return { id: "checklist:legacy", kind: "checklist", reason: "schedule_needs_attention", attentionReason: "legacy_unresolved", title: "Repair legacy task", project: projectContext(), assignee: null, schedule: { state: "legacy_unresolved", version: 0, zone: PRODUCTION_CALENDAR_ZONE, start: null, end: null, due: "2026-10-04T02:30", error: { code: "subtask_schedule_legacy_unresolved", reason: "nonexistent_local_time" } }, permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: true, canScheduleRange: true } };
}

function invalidEntry(): ChecklistCalendarUnscheduledEntryDto {
  return { id: "checklist:invalid", kind: "checklist", reason: "schedule_needs_attention", attentionReason: "invalid", title: "Broken task", project: projectContext(), assignee: null, schedule: { state: "invalid", version: 2, zone: null, start: null, end: null, due: "bad", error: { code: "subtask_schedule_storage_invalid", reason: "shape_mismatch" } }, permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: false, canScheduleRange: false } };
}

function renderPanel(overrides: Partial<ComponentProps<typeof ProductionCalendarUnscheduledPanel>> = {}) {
  const projectEntries = overrides.projectEntries ?? [projectEntry()];
  const checklistEntries = overrides.checklistEntries ?? [checklistEntry()];
  const facets = overrides.facets ?? { project: { matched: projectEntries.length, returned: projectEntries.length, truncated: false }, checklist: { matched: checklistEntries.length, returned: checklistEntries.length, truncated: false } };
  return <ProductionCalendarUnscheduledPanel projectEntries={projectEntries} checklistEntries={checklistEntries} facets={facets} subview={overrides.subview ?? "month"} rangesEnabled={overrides.rangesEnabled ?? true} onScheduleProject={overrides.onScheduleProject ?? vi.fn()} onScheduleChecklist={overrides.onScheduleChecklist ?? vi.fn()} disabled={overrides.disabled} />;
}

describe("ProductionCalendarUnscheduledPanel", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  async function render(value: ReactElement) {
    await act(async () => { root.render(value); await Promise.resolve(); });
  }

  it("renders both bounded sections, exact counts, and the deterministic truncation copy", async () => {
    const projects = Array.from({ length: 50 }, (_, index) => projectEntry(`project-deadline:${index}`));
    const checklists = Array.from({ length: 50 }, (_, index) => checklistEntry(`checklist:${index}`));
    await render(renderPanel({ projectEntries: projects, checklistEntries: checklists, facets: { project: { matched: 63, returned: 50, truncated: true }, checklist: { matched: 63, returned: 50, truncated: true } } }));
    expect(host.querySelector('[aria-label="Unscheduled projects"]')?.textContent).toContain("Showing 50 of 63");
    expect(host.querySelector('[aria-label="Unscheduled projects"]')?.textContent).toContain("13 more — refine filters or search");
    expect(host.querySelectorAll('[aria-label="Unscheduled projects"] [data-unscheduled-kind="project"]')).toHaveLength(50);
    expect(host.querySelectorAll('[aria-label="Unscheduled checklist items"] [data-unscheduled-kind="checklist"]')).toHaveLength(50);
  });

  it("renders empty sections with meaningful facet counts", async () => {
    await render(renderPanel({ projectEntries: [], checklistEntries: [], facets: { project: { matched: 2, returned: 0, truncated: true }, checklist: { matched: 0, returned: 0, truncated: false } } }));
    expect(host.querySelector('[aria-label="Unscheduled projects"]')?.textContent).toContain("Showing 0 of 2");
    expect(host.querySelector('[aria-label="Unscheduled projects"]')?.textContent).toContain("2 more — refine filters or search");
    expect(host.querySelector('[aria-label="Unscheduled checklist items"]')?.textContent).toContain("Showing 0 of 0");
    expect(host.querySelectorAll('[data-testid="calendar-unscheduled-empty"]')).toHaveLength(2);
    expect(host.textContent).toContain("Nothing unscheduled");
  });

  it("carries external event data only for permitted project and checklist rows", async () => {
    await render(renderPanel({ projectEntries: [projectEntry()], checklistEntries: [checklistEntry()] }));
    const project = host.querySelector<HTMLElement>('[data-unscheduled-kind="project"]')!;
    const checklist = host.querySelector<HTMLElement>('[data-unscheduled-kind="checklist"]')!;
    const data = JSON.parse(project.getAttribute("data-event")!);
    expect(data.extendedProps).toEqual({ unscheduledId: projectEntry().id, unscheduledKind: "project" });
    expect(data.start).toBeUndefined();
    expect(JSON.parse(checklist.getAttribute("data-event")!).extendedProps.unscheduledKind).toBe("checklist");

    await act(async () => { root.render(renderPanel({ projectEntries: [projectEntry("project-deadline:delivered", true)], checklistEntries: [] })); await Promise.resolve(); });
    const delivered = host.querySelector<HTMLElement>('[data-unscheduled-id="project-deadline:delivered"]')!;
    expect(delivered.tagName).toBe("BUTTON");
    expect((delivered as HTMLButtonElement).disabled).toBe(true);
    expect(delivered.getAttribute("data-event")).toBeNull();
    expect(delivered.textContent).toContain("Deadline is read-only");
  });

  it("enforces checklist attention branches, Agenda actions, and inert mode", async () => {
    const onScheduleChecklist = vi.fn();
    await render(renderPanel({ checklistEntries: [checklistEntry(), legacyEntry(), invalidEntry()], onScheduleChecklist }));
    expect(host.querySelector('[data-unscheduled-id="checklist:one"]')?.getAttribute("data-event")).not.toBeNull();
    expect(host.querySelector('[data-unscheduled-id="checklist:legacy"]')?.getAttribute("data-event")).toBeNull();
    expect(host.querySelector('[data-unscheduled-id="checklist:legacy"]')?.textContent).toContain("Repair schedule");
    expect(host.querySelector('[data-unscheduled-id="checklist:invalid"]')?.querySelector("button")).toBeNull();
    expect(host.textContent).toContain("This checklist schedule needs repair. Repair is unavailable in Calendar.");

    await act(async () => { root.render(renderPanel({ subview: "agenda", projectEntries: [projectEntry()], checklistEntries: [checklistEntry(), legacyEntry()], onScheduleChecklist })); await Promise.resolve(); });
    expect(host.querySelectorAll("[data-event]")).toHaveLength(0);
    expect(host.textContent).toContain("Schedule Deadline");
    expect(host.textContent).toContain("Schedule");
    expect(host.textContent).toContain("Repair schedule");

    await act(async () => { root.render(renderPanel({ rangesEnabled: false, checklistEntries: [checklistEntry()] })); await Promise.resolve(); });
    const inertChecklist = host.querySelector('[data-unscheduled-id="checklist:one"]')!;
    expect(inertChecklist.getAttribute("data-event")).toBeNull();
    expect(inertChecklist.querySelector('[data-testid="calendar-unscheduled-action"]')?.textContent).toBe("Schedule");
    expect(onScheduleChecklist).not.toHaveBeenCalled();

    await act(async () => { root.render(renderPanel({ disabled: true, projectEntries: [projectEntry()], checklistEntries: [checklistEntry()] })); await Promise.resolve(); });
    expect(host.querySelectorAll("[data-event]")).toHaveLength(0);
    expect(host.querySelectorAll("button")).toHaveLength(2);
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled)).toBe(true);
  });
});
