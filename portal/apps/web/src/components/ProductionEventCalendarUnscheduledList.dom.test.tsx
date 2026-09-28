/**
 * #222 step 6 — the event-calendar rail's unscheduled list. Ports
 * `ProductionCalendarUnscheduledPanel.dom.test.tsx`: bounded sections and counts, truncation copy,
 * drag affordance only for permitted rows (FullCalendar's `data-event` → a `beginDrag` pointer
 * source), attention branches, Agenda/action mode and inert mode. FullCalendar's `droppable`
 * assertion becomes "a row that may not be dragged has no drag affordance".
 * Guard F: Quincy `data-testid`s / data attributes this component authors, never a vendor `data-slot`.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTION_CALENDAR_ZONE, type ChecklistCalendarUnscheduledEntryDto, type ProjectCalendarUnscheduledEntryDto } from "@quincy/shared";
import { ProductionEventCalendarUnscheduledList } from "./ProductionEventCalendarUnscheduledList";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projectId = "11111111-1111-4111-8111-111111111111";
const assigneeId = "22222222-2222-4222-8222-222222222222";
const projectContext = (delivered = false) => ({ id: projectId, street: "12 Harbour Street", stageKey: "editing_autohdr" as const, checklist: { completed: 1, total: 3 }, delivered });

function projectEntry(id = "project-deadline:one", delivered = false, canDrag = !delivered): ProjectCalendarUnscheduledEntryDto {
  return { id, kind: "project_deadline", reason: "unscheduled", title: "Project handoff", project: projectContext(delivered), permissions: { canDrag, canResize: false }, deadlineVersion: 3, reminderOffsetsMinutes: [] };
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

type Props = ComponentProps<typeof ProductionEventCalendarUnscheduledList>;
function listProps(overrides: Partial<Props> = {}): Props {
  const projectEntries = overrides.projectEntries ?? [projectEntry()];
  const checklistEntries = overrides.checklistEntries ?? [checklistEntry()];
  return {
    projectEntries, checklistEntries,
    facets: overrides.facets ?? { project: { matched: projectEntries.length, returned: projectEntries.length, truncated: false }, checklist: { matched: checklistEntries.length, returned: checklistEntries.length, truncated: false } },
    subview: "month", rangesEnabled: true, onScheduleProject: vi.fn(), onScheduleChecklist: vi.fn(), beginDrag: vi.fn(),
    ...overrides,
  };
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); await Promise.resolve(); }); host.remove(); });

async function render(props: Props) {
  await act(async () => { root.render(<ProductionEventCalendarUnscheduledList {...props} />); await Promise.resolve(); });
}

const draggable = (kind?: "project" | "checklist") => [...host.querySelectorAll<HTMLElement>('[data-drag-source="true"]')].filter((row) => !kind || row.dataset.unscheduledKind === kind);
const section = (label: string) => host.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;

describe("ProductionEventCalendarUnscheduledList", () => {
  it("renders both bounded sections, exact counts, and the deterministic truncation copy", async () => {
    const projects = Array.from({ length: 50 }, (_, index) => projectEntry(`project-deadline:${index}`));
    const checklists = Array.from({ length: 50 }, (_, index) => checklistEntry(`checklist:${index}`));
    await render(listProps({ projectEntries: projects, checklistEntries: checklists, facets: { project: { matched: 63, returned: 50, truncated: true }, checklist: { matched: 63, returned: 50, truncated: true } } }));
    expect(section("Unscheduled projects").textContent).toContain("Showing 50 of 63");
    expect(section("Unscheduled projects").textContent).toContain("13 more — refine filters or search");
    expect(draggable("project")).toHaveLength(50);
    expect(draggable("checklist")).toHaveLength(50);
  });

  it("renders empty sections with meaningful facet counts", async () => {
    await render(listProps({ projectEntries: [], checklistEntries: [], facets: { project: { matched: 2, returned: 0, truncated: true }, checklist: { matched: 0, returned: 0, truncated: false } } }));
    expect(section("Unscheduled projects").textContent).toContain("Showing 0 of 2");
    expect(section("Unscheduled projects").textContent).toContain("2 more — refine filters or search");
    expect(section("Unscheduled checklist items").textContent).toContain("Showing 0 of 0");
    expect(host.querySelectorAll('[data-testid="event-calendar-unscheduled-empty"]')).toHaveLength(2);
    expect(host.textContent).toContain("Nothing unscheduled");
  });

  it("starts a drag from a permitted row with its entry, and a primary press only", async () => {
    const beginDrag = vi.fn();
    await render(listProps({ beginDrag }));
    const project = host.querySelector<HTMLElement>('[data-unscheduled-id="project-deadline:one"]')!;
    expect(project.dataset.dragSource).toBe("true");
    await act(async () => { project.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); });
    expect(beginDrag).toHaveBeenCalledOnce();
    expect(beginDrag.mock.calls[0]![1]).toMatchObject({ id: "project-deadline:one", kind: "project_deadline" });
    const checklist = host.querySelector<HTMLElement>('[data-unscheduled-id="checklist:one"]')!;
    await act(async () => { checklist.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); });
    expect(beginDrag.mock.calls[1]![1]).toMatchObject({ id: "checklist:one", kind: "checklist" });
  });

  it("a row that may not be dragged has no drag affordance (delivered project is read-only)", async () => {
    const beginDrag = vi.fn();
    await render(listProps({ projectEntries: [projectEntry("project-deadline:delivered", true)], checklistEntries: [], beginDrag }));
    const delivered = host.querySelector<HTMLElement>('[data-unscheduled-id="project-deadline:delivered"]')!;
    expect(delivered.dataset.dragSource).toBeUndefined();
    expect(delivered.textContent).toContain("Deadline is read-only");
    expect(delivered.querySelector("button")).toBeNull();
    await act(async () => { delivered.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); });
    expect(beginDrag).not.toHaveBeenCalled();
  });

  it("enforces checklist attention branches, Agenda actions, and inert mode", async () => {
    const onScheduleChecklist = vi.fn();
    await render(listProps({ checklistEntries: [checklistEntry(), legacyEntry(), invalidEntry()], onScheduleChecklist }));
    expect(host.querySelector<HTMLElement>('[data-unscheduled-id="checklist:one"]')?.dataset.dragSource).toBe("true");
    expect(host.querySelector<HTMLElement>('[data-unscheduled-id="checklist:legacy"]')?.dataset.dragSource).toBeUndefined();
    expect(host.querySelector('[data-unscheduled-id="checklist:legacy"]')?.textContent).toContain("Repair schedule");
    expect(host.querySelector('[data-unscheduled-id="checklist:invalid"]')?.querySelector("button")).toBeNull();
    expect(host.textContent).toContain("This checklist schedule needs repair. Repair is unavailable in Calendar.");
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-unscheduled-id="checklist:legacy"] [data-testid="event-calendar-unscheduled-action"]')!.click(); });
    expect(onScheduleChecklist).toHaveBeenCalledWith(expect.objectContaining({ id: "checklist:legacy" }));

    await render(listProps({ subview: "agenda", projectEntries: [projectEntry()], checklistEntries: [checklistEntry(), legacyEntry()], onScheduleChecklist }));
    expect(draggable()).toHaveLength(0);
    expect(host.textContent).toContain("Schedule Deadline");
    expect(host.textContent).toContain("Repair schedule");

    await render(listProps({ rangesEnabled: false, checklistEntries: [checklistEntry()] }));
    const inert = host.querySelector<HTMLElement>('[data-unscheduled-id="checklist:one"]')!;
    expect(inert.dataset.dragSource).toBeUndefined();
    expect(inert.querySelector('[data-testid="event-calendar-unscheduled-action"]')?.textContent).toBe("Schedule");
  });

  it("action mode (drag suppressed, or no drag source wired) shows Schedule buttons instead", async () => {
    const onScheduleProject = vi.fn();
    await render(listProps({ dragSuppressed: true, onScheduleProject }));
    expect(draggable()).toHaveLength(0);
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-unscheduled-id="project-deadline:one"] [data-testid="event-calendar-unscheduled-action"]')!.click(); });
    expect(onScheduleProject).toHaveBeenCalledWith(expect.objectContaining({ id: "project-deadline:one" }));

    await render(listProps({ beginDrag: undefined }));
    expect(draggable()).toHaveLength(0);
    expect(host.querySelectorAll('[data-testid="event-calendar-unscheduled-action"]')).toHaveLength(2);
  });

  it("disabled: no drag sources and every action disabled", async () => {
    await render(listProps({ disabled: true }));
    expect(draggable()).toHaveLength(0);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="event-calendar-unscheduled-action"]')];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(host.querySelector('[aria-label="Unscheduled work"]')?.getAttribute("aria-disabled")).toBe("true");
  });
});
