/**
 * #678 + #679 — the Production Gantt's add-task editor, end to end: a `+` on each Project row opens ONE editor row whose
 * Assignees and Due cells line up with the People and Due columns beside the title (#678), and a single
 * `POST /api/projects/:id/subtasks` carries the draft. A real `ProductionGantt` render; only `apiGet` / `apiPost`
 * (never a real `fetch`, per `src/testing/no-unmocked-fetch.ts`) and `invalidateProjectSurfaces` are faked.
 *
 * Guard F (`test-seam.guard.test.ts`): nothing here selects a vendor `data-slot` or a class. Cells are found by
 * `data-testid`, controls by accessible name, options by ARIA role.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { adminProductionGanttResponseSchema, PRODUCTION_GANTT_ZONE, type CalendarPerson, type GanttProjectRowDto } from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { ApiError } from "../lib/api";
import { DEFAULT_GANTT_FACET_FILTERS } from "../lib/production-gantt-filters";
import { clearToasts } from "../lib/toast-store";
import { ToastViewport } from "./quincy/ToastViewport";
import { ProductionGantt } from "./ProductionGantt";
import { CELL_TRIGGER } from "./ProjectDeadlineCell";
import { applyPopup, dateTimePopup, pickPopupDay } from "@/testing/date-time-popup";
import { startMoment, endMoment, subtaskReminders } from "@/testing/subtask-schedule";
import { mockViewport } from "@/testing/viewport";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
const apiPostMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const invalidateMock = vi.hoisted(() => vi.fn<(client: unknown, options: Record<string, unknown>) => Promise<void>>());
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  apiGet: (path: string) => apiGetMock(path),
  apiPost: (path: string, body: unknown) => apiPostMock(path, body),
}));
vi.mock("../lib/project-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/project-data")>()),
  invalidateProjectSurfaces: (client: unknown, options: Record<string, unknown>) => invalidateMock(client, options),
}));
vi.mock("../lib/stages", () => ({
  presentationStages: (stages: unknown[]) => stages,
  useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "11111111-1111-4111-8111-222222222222";
const STREET_A = "1 Alpha Street";
const STREET_B = "2 Bravo Street";
const CREATED_ID = "77777777-7777-4777-8777-777777777777";

const person = (n: number, name: string): CalendarPerson => ({ id: `33333333-3333-4333-8333-00000000000${n}`, name, roleLabel: "Editor", isExternal: false, active: true });
const ada = person(1, "Ada Smith");
const cy = person(3, "Cy Young");
const candidates = [ada, person(2, "Ben Ortiz"), cy].map(({ id, name }) => ({ id, name, role: "editor" }));

const isoDate = (days: number) => { const date = new Date(); date.setDate(date.getDate() + days); return date.toISOString().slice(0, 10); };
const schedule = () => ({ state: "range" as const, version: 1, zone: PRODUCTION_GANTT_ZONE, start: startMoment(isoDate(2)), end: endMoment(isoDate(3)), due: isoDate(3) });

function project(id: string, street: string, children: Array<{ id: string; title: string }>): GanttProjectRowDto {
  const rows = children.map((child, index) => ({
    id: child.id, projectId: id, title: child.title, done: false, position: index, assignees: [], otherAssigneeCount: 0, assignmentVersion: 1,
    schedule: schedule(), reminders: subtaskReminders(), permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canEditAssignees: true },
  }));
  return {
    id, street, suburb: null, agencyName: null, agentName: null, stageKey: "editing_autohdr", delivered: false, archived: false,
    shootDate: isoDate(0), shootDateCivil: isoDate(0), createdAt: `${isoDate(0)}T00:00:00.000Z`, barStartDate: isoDate(0),
    deadline: { at: `${isoDate(5)}T05:00:00.000Z`, localCivil: `${isoDate(5)}T15:00`, version: 1, reminderOffsetsMinutes: [], overdue: false },
    deadlineVersion: 1, editors: [], checklist: { completed: 0, total: rows.length },
    permissions: { canEditDeadline: true, canEditChildren: true },
    children: { rows, total: rows.length, returned: rows.length, truncated: false, nextCursor: null },
  };
}

const created = (title: string, assignees: CalendarPerson[] = []) => ({
  id: CREATED_ID, title, done: false, position: 5, assignees, assignmentVersion: 1, dueDate: isoDate(3), schedule: schedule(), reminders: subtaskReminders(),
  createdBy: "user-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});

const identity: DashboardIdentity = { principalId: "user-1", role: "admin", authorizationEpoch: 0 };
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function waitFor(assertion: () => void, timeoutMs = 1500) {
  const start = Date.now();
  for (;;) {
    try { assertion(); return; } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
  }
}

function tree(q = "") {
  return (
    <QueryClientProvider client={client}>
      <ProductionGantt identity={identity} q={q} filters={DEFAULT_GANTT_FACET_FILTERS} onFiltersChange={() => {}} />
      <ToastViewport />
    </QueryClientProvider>
  );
}

async function mount(q = "") {
  await act(async () => {
    root.render(tree(q));
    await Promise.resolve();
    await Promise.resolve();
  });
  await settle();
}

const plus = (street: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="Add task in ${street}"]`);
const input = () => document.querySelector<HTMLInputElement>('input[aria-label^="New task title in"]');
const editorRow = () => host.querySelector<HTMLElement>('[data-testid="gantt-group-create-task-row"]');
const draftAssignees = () => document.querySelector<HTMLButtonElement>('[aria-label="Assignees for new task"]');
const draftDue = () => document.querySelector<HTMLButtonElement>('[aria-label^="Schedule for new task"]');
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

async function click(el: HTMLElement) {
  await act(async () => { el.click(); await Promise.resolve(); });
}
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}
async function key(el: EventTarget, name: string) {
  await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); await Promise.resolve(); });
}
async function openPicker() {
  const button = draftAssignees()!;
  await act(async () => { button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); button.click(); await Promise.resolve(); });
  await waitFor(() => expect(document.querySelector('[role="listbox"]')).not.toBeNull());
  await waitFor(() => expect(options().map((option) => option.textContent).join("|")).toContain("Cy Young"));
}
async function pick(name: string) {
  const option = options().find((candidate) => candidate.textContent?.includes(name));
  if (!option) throw new Error(`No option ${name}`);
  await act(async () => { option.click(); await Promise.resolve(); });
}
async function closePickerWithEscape() {
  const target = document.activeElement ?? document.body;
  await act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
  await waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());
  await settle();
}
async function choose(...names: string[]) {
  await openPicker();
  for (const name of names) await pick(name);
  await closePickerWithEscape();
}
async function submit(title: string) {
  await type(input()!, title);
  await key(input()!, "Enter");
  await settle();
}

beforeEach(() => {
  apiGetMock.mockReset().mockImplementation((path: string) => {
    if (path.includes("/subtask-assignee-options")) return Promise.resolve({ candidates });
    return Promise.resolve(adminProductionGanttResponseSchema.parse({
      scope: "active", zone: PRODUCTION_GANTT_ZONE,
      appliedFilters: { q: "", editorIds: [], stageKeys: [], priorities: [], archived: "hide", includeDelivered: false, includeCompletedChecklist: false },
      projects: [project(PROJECT_A, STREET_A, [{ id: "22222222-2222-4222-8222-000000000001", title: "Row one" }]), project(PROJECT_B, STREET_B, [])],
      page: { limit: 100, returned: 2, nextCursor: null },
      density: { matchedProjects: 2, matchedRows: 2, drawCap: 2000, tooManyToDraw: false },
    }));
  });
  apiPostMock.mockReset().mockImplementation((_path, body) => Promise.resolve(created((body as { title: string }).title)));
  invalidateMock.mockReset().mockResolvedValue(undefined);
  clearToasts();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => { root.unmount(); await Promise.resolve(); });
  client.clear();
  host.remove();
  document.body.replaceChildren();
});

describe("ProductionGantt — + on a Project row (#679)", () => {
  it("renders no idle add-task rows: each Project row has a + named for it, and nothing else", async () => {
    await mount();
    expect(plus(STREET_A)).not.toBeNull();
    expect(plus(STREET_B)).not.toBeNull();
    expect(editorRow()).toBeNull();
    expect(host.textContent).not.toContain("Add task");
    // an empty Project is a leaf: no chevron, but it keeps its +
    expect(host.querySelector(`button[aria-label="${STREET_B}"]`)).toBeNull();
  });

  it("pressing + opens one editor under that Project's last subtask and focuses its title", async () => {
    await mount();
    await click(plus(STREET_A)!);
    expect(editorRow()).not.toBeNull();
    expect(editorRow()!.getAttribute("data-gantt-create-for")).toBe(`project:${PROJECT_A}`);
    expect(document.activeElement).toBe(input());
    expect(plus(STREET_A)!.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("ProductionGantt — the editor row keeps the row's columns (#678)", () => {
  it("the title is in the name cell; Assignees and Due are in the People and Due cells beside it, never in the name cell", async () => {
    await mount();
    await click(plus(STREET_A)!);
    const row = editorRow()!;
    const nameCell = row.querySelector<HTMLElement>('[data-testid="gantt-group-create-task-name-cell"]')!;
    expect(nameCell.contains(input())).toBe(true);
    const peopleCell = row.querySelector<HTMLElement>('[data-column="people"]')!;
    const dueCell = row.querySelector<HTMLElement>('[data-column="due"]')!;
    expect(peopleCell.contains(draftAssignees())).toBe(true);
    expect(dueCell.contains(draftDue())).toBe(true);
    expect(nameCell.contains(draftAssignees())).toBe(false);
    expect(nameCell.contains(draftDue())).toBe(false);
  });

  it("the Due trigger is the Due column's own trigger: the same CELL_TRIGGER classes, no uppercase or letter-spacing treatment", async () => {
    await mount();
    await click(plus(STREET_A)!);
    const trigger = draftDue()!;
    const columnTrigger = [...host.querySelectorAll<HTMLElement>('[data-column="due"] button')].find((button) => !editorRow()!.contains(button))!;
    expect(columnTrigger).toBeDefined();
    for (const token of CELL_TRIGGER.split(" ")) {
      expect(trigger.className, token).toContain(token);
      expect(columnTrigger.className, token).toContain(token);
    }
    expect(trigger.className).not.toContain("uppercase");
    expect(trigger.className).toContain("normal-case");
  });

  it("choosing a Due date keeps ONE trigger node and focus returns to it (not to Assignees)", async () => {
    await mount();
    await click(plus(STREET_A)!);
    const trigger = draftDue()!;
    await act(async () => { trigger.focus(); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); await Promise.resolve(); });
    await waitFor(() => expect(dateTimePopup("Schedule for new task")).not.toBeNull());
    await pickPopupDay(dateTimePopup("Schedule for new task")!, isoDate(40));
    await applyPopup(dateTimePopup("Schedule for new task")!);
    await waitFor(() => expect(dateTimePopup("Schedule for new task")).toBeNull());
    await settle();
    expect(draftDue()).toBe(trigger);
    expect(trigger.isConnected).toBe(true);
    expect(document.activeElement).toBe(trigger);
    // the chosen range really is the draft: it rides along in the one POST
    await submit("Dated");
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect((apiPostMock.mock.calls[0]![1] as { schedule?: unknown }).schedule).toBeDefined();
  });

  it("a chosen range shows its END the way the Due column does; the accessible name keeps the whole range", async () => {
    await mount();
    await click(plus(STREET_A)!);
    const trigger = draftDue()!;
    await act(async () => { trigger.focus(); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); await Promise.resolve(); });
    await waitFor(() => expect(dateTimePopup("Schedule for new task")).not.toBeNull());
    await pickPopupDay(dateTimePopup("Schedule for new task")!, isoDate(40));
    await applyPopup(dateTimePopup("Schedule for new task")!);
    await waitFor(() => expect(dateTimePopup("Schedule for new task")).toBeNull());
    await settle();
    expect(draftDue()!.textContent).toMatch(/^\w{3} \d{1,2} \w{3} · \d{2}:\d{2}$/);
    expect(draftDue()!.textContent).not.toContain("→");
    expect(draftDue()!.getAttribute("aria-label")).toContain("→");
  });

  describe("on a phone (<= 720px) the editor is a bottom sheet with 44px rows", () => {
    let viewport: ReturnType<typeof mockViewport>;
    beforeEach(() => { viewport = mockViewport({ width: 720 }); });
    afterEach(() => { viewport.restore(); });
    const sheet = () => document.querySelector<HTMLElement>('[data-testid="gantt-group-create-task-sheet"]');

    it("project rows are 2.75rem (44px) so each 44px + fits its own row, and both panes agree (#693)", async () => {
      await mount();
      const heights = Array.from(host.querySelectorAll<HTMLElement>("[data-gantt-resource]")).map((el) => el.style.height).filter(Boolean);
      expect(heights.length).toBeGreaterThan(0);
      expect(new Set(heights)).toEqual(new Set(["2.75rem"]));
    });

    it("tapping + opens the sheet (no editor row, no spacer): heading names the Project; Title, Assignees, Due, Cancel and Add are in it", async () => {
      await mount();
      await click(plus(STREET_A)!);
      const popup = sheet()!;
      expect(popup).not.toBeNull();
      expect(popup.textContent).toContain(`New task in ${STREET_A}`);
      expect(editorRow()).toBeNull();
      expect(host.querySelector('[data-testid="gantt-group-create-task-spacer"]')).toBeNull();
      expect(host.querySelector('[data-testid="gantt-group-create-task-tree-spacer"]')).toBeNull();
      expect(popup.contains(input())).toBe(true);
      expect(popup.contains(draftAssignees())).toBe(true);
      expect(popup.contains(draftDue())).toBe(true);
      expect(document.activeElement).toBe(input());
      const add = popup.querySelector<HTMLButtonElement>('[data-testid="gantt-group-create-task-add"]')!;
      expect(add.disabled).toBe(true);
      expect(popup.querySelector('[data-testid="gantt-group-create-task-cancel"]')).not.toBeNull();
    });

    it("the name cell is capped at the pane (no 208px floor), so the + sits in flow at its end and the title truncates before it (#686)", async () => {
      await mount();
      const cell = host.querySelector<HTMLElement>('[data-testid="gantt-tree-name-cell"]')!;
      expect(cell.style.width).toBe("0px");
      expect(cell.style.flexGrow).toBe("1");
    });

    it("every field has a real <label> above it: Title, Assignees and Due are each named by (and associated with) their control", async () => {
      await mount();
      await click(plus(STREET_A)!);
      const popup = sheet()!;
      for (const [text, control] of [["Title", input()!], ["Assignees", draftAssignees()!], ["Due", draftDue()!]] as const) {
        const label = [...popup.querySelectorAll<HTMLLabelElement>("label")].find((candidate) => candidate.textContent?.trim() === text)!;
        expect(label, text).toBeDefined();
        expect(label.htmlFor, text).toBe(control.id);
        expect(control.id, text).not.toBe("");
        expect(label.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING, text).toBeTruthy();
      }
    });

    it("the Due trigger is an outlined, full-width field the Title's height; its popup still portals inside the sheet", async () => {
      await mount();
      await click(plus(STREET_A)!);
      const trigger = draftDue()!;
      for (const token of ["flex-1", "justify-start", "border-input", "min-h-[38px]"]) expect(trigger.className, token).toContain(token);
      await act(async () => { trigger.focus(); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); await Promise.resolve(); });
      await waitFor(() => expect(dateTimePopup("Schedule for new task")).not.toBeNull());
      const popup = dateTimePopup("Schedule for new task")!;
      expect(sheet()!.querySelector('[data-testid="gantt-group-create-task-overlay-slot"]')!.contains(popup)).toBe(true);
    });

    it("the sheet's Due shows a real date in the Title's ink, not muted (#686); the desktop row keeps its muted default", async () => {
      await mount();
      await click(plus(STREET_A)!);
      const cls = draftDue()!.className.split(/\s+/);
      expect(cls).toContain("text-foreground");
      expect(cls).not.toContain("text-muted-foreground");
    });

    it("the Project's name in the heading is its own body-type element; the Due trigger takes the Title input's radius, background and size; the footer is ruled off", async () => {
      await mount();
      await click(plus(STREET_A)!);
      const popup = sheet()!;
      const name = popup.querySelector<HTMLElement>('[data-testid="gantt-group-create-task-sheet-project"]')!;
      expect(name.textContent).toBe(STREET_A);
      expect(name.className).toContain("font-[family-name:var(--font-sans)]");
      for (const token of ["rounded-[var(--radius-sm)]", "bg-[var(--field-bg)]", "text-base!"]) expect(draftDue()!.className, token).toContain(token);
      expect(popup.querySelector('[data-testid="gantt-group-create-task-add"]')!.parentElement!.className).toContain("border-t-[length:var(--border-width-hair)]");
    });

    it("the sheet is capped at the viewport with a scrolling body; heading and the Cancel/Add footer sit outside the scroller", async () => {
      await mount();
      await click(plus(STREET_A)!);
      const popup = sheet()!;
      expect(popup.className).toContain("max-h-[calc(100dvh-var(--space-4))]");
      const body = popup.querySelector<HTMLElement>('[data-testid="gantt-group-create-task-body"]')!;
      expect(body.className).toContain("overflow-y-auto");
      expect(body.contains(input())).toBe(true);
      expect(body.contains(draftAssignees())).toBe(true);
      expect(body.contains(draftDue())).toBe(true);
      expect(body.contains(popup.querySelector('[data-testid="gantt-group-create-task-add"]'))).toBe(false);
      expect(body.contains(popup.querySelector('[data-testid="gantt-group-create-task-cancel"]'))).toBe(false);
    });

    it("Escape on a picker's CLOSED trigger closes the sheet; while its popup is open Escape closes only the popup", async () => {
      await mount();
      await click(plus(STREET_A)!);
      await openPicker();
      await pick("Ada Smith");
      await closePickerWithEscape();
      expect(sheet()).not.toBeNull();
      const trigger = draftAssignees()!;
      await act(async () => { trigger.focus(); });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
      await settle();
      expect(sheet()).toBeNull();
      expect(apiPostMock).not.toHaveBeenCalled();
    });

    it("one POST carries title and assignees; success closes the sheet, returns focus to the + and pins the row", async () => {
      await mount();
      await click(plus(STREET_A)!);
      await choose("Ada Smith");
      await type(input()!, "Phone task");
      const add = sheet()!.querySelector<HTMLButtonElement>('[data-testid="gantt-group-create-task-add"]')!;
      expect(add.disabled).toBe(false);
      await click(add);
      await settle();
      expect(apiPostMock).toHaveBeenCalledTimes(1);
      expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_A}/subtasks`, { title: "Phone task", assigneeIds: [ada.id] });
      expect(sheet()).toBeNull();
      expect(document.activeElement).toBe(plus(STREET_A));
    });

    it("a failed create keeps the sheet, the title and the assignees", async () => {
      apiPostMock.mockRejectedValueOnce(new ApiError("Nope from the server", 500));
      await mount();
      await click(plus(STREET_A)!);
      await choose("Ada Smith");
      await type(input()!, "Keep me");
      await click(sheet()!.querySelector<HTMLButtonElement>('[data-testid="gantt-group-create-task-add"]')!);
      await settle();
      expect(sheet()).not.toBeNull();
      expect(input()!.value).toBe("Keep me");
      expect(draftAssignees()!.getAttribute("title")).toContain("Ada Smith");
    });

    it("the assignee popover portals INSIDE the sheet, and its Escape closes only the popover", async () => {
      await mount();
      await click(plus(STREET_A)!);
      await type(input()!, "Half typed");
      await openPicker();
      const slot = sheet()!.querySelector<HTMLElement>('[data-testid="gantt-group-create-task-overlay-slot"]')!;
      expect(slot.contains(document.querySelector('[role="listbox"]'))).toBe(true);
      await pick("Ada Smith");
      await closePickerWithEscape();
      expect(sheet()).not.toBeNull();
      expect(input()!.value).toBe("Half typed");
      expect(draftAssignees()!.getAttribute("title")).toContain("Ada Smith");
    });

    it("the Due popover closes on Escape without closing the sheet, and Cancel returns focus to the +", async () => {
      await mount();
      await click(plus(STREET_A)!);
      const trigger = draftDue()!;
      await act(async () => { trigger.focus(); trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); trigger.click(); await Promise.resolve(); });
      await waitFor(() => expect(document.querySelector('[role="dialog"][data-testid]') ?? document.querySelectorAll('[role="dialog"]').length > 1).toBeTruthy());
      const dialogs = () => [...document.querySelectorAll('[role="dialog"]')].filter((dialog) => dialog !== sheet());
      expect(dialogs().length).toBeGreaterThan(0);
      const slot = sheet()!.querySelector<HTMLElement>('[data-testid="gantt-group-create-task-overlay-slot"]')!;
      expect(slot.contains(dialogs()[0]!)).toBe(true);
      await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
      await waitFor(() => expect(dialogs()).toHaveLength(0));
      expect(sheet()).not.toBeNull();
      await click(sheet()!.querySelector<HTMLButtonElement>('[data-testid="gantt-group-create-task-cancel"]')!);
      await settle();
      expect(sheet()).toBeNull();
      expect(document.activeElement).toBe(plus(STREET_A));
      expect(apiPostMock).not.toHaveBeenCalled();
    });
  });

  it("a group title beside the + can shrink and ends in an ellipsis: truncate and min-w-0 below 721px, the 96px floor only above (#686)", async () => {
    await mount();
    // The label span beside the + holds the title span first.
    const title = plus(STREET_A)!.previousElementSibling!.firstElementChild as HTMLElement;
    expect(title.textContent).toBe(STREET_A);
    const tokens = title.className.split(/\s+/);
    expect(tokens).toContain("truncate");
    expect(tokens).toContain("min-w-0");
    expect(tokens).toContain("min-[721px]:min-w-[var(--space-9)]");
    expect(tokens).not.toContain("min-w-[var(--space-9)]");
  });

  it("the Due control shows the Project default until a range is applied", async () => {
    await mount();
    await click(plus(STREET_A)!);
    expect(draftDue()!.textContent).toMatch(/\S/);
  });

  it("a Project default that has gone past shows today's 17:00 instead of the stale Deadline (#736)", async () => {
    // Ten days on at 10:00 Sydney: the fixture's shoot date and Deadline (+5 days, 15:00) are both behind us.
    const later = new Date(`${isoDate(10)}T10:00:00+11:00`).getTime();
    vi.spyOn(Date, "now").mockReturnValue(later);
    await mount();
    await click(plus(STREET_A)!);
    expect(draftDue()!.getAttribute("aria-label")).toContain("17:00");
    expect(draftDue()!.getAttribute("aria-label")).not.toContain("15:00");
  });

  it("the Due default is muted text naming the default's end like the Due column, not a pill; its name keeps the text", async () => {
    await mount();
    await click(plus(STREET_A)!);
    const trigger = draftDue()!;
    expect(trigger.className).toContain("text-muted-foreground");
    expect(trigger.querySelector('[data-slot="status-pill"]')).toBeNull();
    expect(trigger.textContent).not.toContain("→");
    expect(trigger.getAttribute("aria-label")).toBe(`Schedule for new task: ${trigger.textContent}`);
  });
});

describe("ProductionGantt — one create carries the draft", () => {
  it("a title alone posts exactly { title }, to the Project whose + opened the editor", async () => {
    await mount();
    await click(plus(STREET_B)!);
    await submit("  Cull selects ");
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_B}/subtasks`, { title: "Cull selects" });
    expect(editorRow()).toBeNull();
    expect(document.activeElement).toBe(plus(STREET_B));
  });

  it("chosen assignees ride along in the same single POST", async () => {
    await mount();
    await click(plus(STREET_A)!);
    await choose("Ada Smith", "Cy Young");
    expect(apiPostMock).not.toHaveBeenCalled();
    await submit("Retouch");
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_A}/subtasks`, { title: "Retouch", assigneeIds: [ada.id, cy.id] });
  });

  it("a successful create resets the draft: the next editor opens with nobody chosen", async () => {
    await mount();
    await click(plus(STREET_A)!);
    await choose("Ada Smith");
    await submit("One");
    await click(plus(STREET_A)!);
    await submit("Two");
    expect(apiPostMock).toHaveBeenLastCalledWith(`/api/projects/${PROJECT_A}/subtasks`, { title: "Two" });
  });

  it("a failed create keeps the title and the chosen assignees, then a retry sends them", async () => {
    apiPostMock.mockRejectedValueOnce(new ApiError("Nope from the server", 500));
    await mount();
    await click(plus(STREET_A)!);
    await choose("Ada Smith");
    await submit("Keep me");
    expect(input()!.value).toBe("Keep me");
    expect(draftAssignees()).not.toBeNull();
    await key(input()!, "Enter");
    await settle();
    expect(apiPostMock).toHaveBeenCalledTimes(2);
    expect(apiPostMock).toHaveBeenLastCalledWith(`/api/projects/${PROJECT_A}/subtasks`, { title: "Keep me", assigneeIds: [ada.id] });
    expect(editorRow()).toBeNull();
  });

  it("Escape in the title cancels without a POST and drops the chosen assignees", async () => {
    await mount();
    await click(plus(STREET_A)!);
    await choose("Ada Smith");
    await key(input()!, "Escape");
    expect(apiPostMock).not.toHaveBeenCalled();
    expect(editorRow()).toBeNull();
    await click(plus(STREET_A)!);
    await submit("Fresh");
    expect(apiPostMock).toHaveBeenCalledWith(`/api/projects/${PROJECT_A}/subtasks`, { title: "Fresh" });
  });

  it("closing the assignee popup with Escape closes only the popup: the editor and the draft stay (#585)", async () => {
    await mount();
    await click(plus(STREET_A)!);
    await type(input()!, "Half typed");
    await openPicker();
    await pick("Ada Smith");
    await closePickerWithEscape();
    expect(editorRow()).not.toBeNull();
    expect(input()!.value).toBe("Half typed");
    expect(draftAssignees()!.getAttribute("title")).toContain("Ada Smith");
  });

  for (const [name, get, open] of [
    ["Assignees", () => draftAssignees()!, async () => { await openPicker(); }],
    ["Due", () => draftDue()!, async () => { const t = draftDue()!; await act(async () => { t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); t.click(); await Promise.resolve(); }); await waitFor(() => expect(draftDue()!.getAttribute("aria-expanded")).toBe("true")); }],
  ] as const) {
    it(`${name}: the first Escape closes only the popup, the second on the closed trigger closes the row (#688)`, async () => {
      await mount();
      await click(plus(STREET_A)!);
      await type(input()!, "Half typed");
      await open();
      await closePickerWithEscape();
      expect(editorRow()).not.toBeNull();
      const trigger = get();
      await act(async () => { trigger.focus(); });
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      await key(trigger, "Escape");
      await settle();
      expect(editorRow()).toBeNull();
      expect(apiPostMock).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(plus(STREET_A));
      await click(plus(STREET_A)!);
      expect(input()!.value).toBe("");
    });
  }

  it("the draft's controls never move tree focus or collapse the Project: a key in them stays out of the row", async () => {
    await mount();
    await click(plus(STREET_A)!);
    const seen: string[] = [];
    document.body.addEventListener("keydown", (event) => { if ((event.target as Element | null)?.closest?.('[aria-label="Assignees for new task"]')) seen.push(event.key); });
    const button = draftAssignees()!;
    await act(async () => { button.focus(); });
    await key(button, "ArrowDown");
    expect(editorRow()).not.toBeNull();
    expect(host.querySelector(`button[aria-label="${STREET_A}"]`)!.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("ProductionGantt — one editor at a time", () => {
  it("another Project's + moves an empty editor there", async () => {
    await mount();
    await click(plus(STREET_A)!);
    await click(plus(STREET_B)!);
    expect(editorRow()!.getAttribute("data-gantt-create-for")).toBe(`project:${PROJECT_B}`);
  });

  it("a draft with an assignee chosen keeps its editor when another + is pressed, and nothing is lost", async () => {
    await mount();
    await click(plus(STREET_A)!);
    await choose("Ada Smith");
    await click(plus(STREET_B)!);
    expect(editorRow()!.getAttribute("data-gantt-create-for")).toBe(`project:${PROJECT_A}`);
    expect(document.activeElement).toBe(input());
    expect(draftAssignees()!.getAttribute("title")).toContain("Ada Smith");
  });

  it("a filter or search change drops the open draft", async () => {
    await mount();
    await click(plus(STREET_A)!);
    await choose("Ada Smith");
    await mount("zzz");
    expect(editorRow()).toBeNull();
    await click(plus(STREET_A)!);
    await submit("After");
    expect(apiPostMock).toHaveBeenLastCalledWith(`/api/projects/${PROJECT_A}/subtasks`, { title: "After" });
  });
});

describe("ProductionGantt — a coarse-pointer tablet (>= 1024px) gets 44px rows and keeps the inline create row (#695)", () => {
  let viewport: ReturnType<typeof mockViewport>;
  beforeEach(() => { viewport = mockViewport({ width: 1280, coarse: true }); });
  afterEach(() => { viewport.restore(); });
  const setCoarse = async (value: boolean) => {
    await viewport.set({ coarse: value });
    await settle();
  };
  const rowHeights = () => Array.from(host.querySelectorAll<HTMLElement>("[data-gantt-row-id]")).map((el) => el.style.height).filter(Boolean);
  const rowHeightsById = () => {
    const byId = new Map<string, Set<string>>();
    for (const el of host.querySelectorAll<HTMLElement>("[data-gantt-row-id]")) {
      if (!el.style.height) continue;
      const id = el.getAttribute("data-gantt-row-id")!;
      byId.set(id, (byId.get(id) ?? new Set()).add(el.style.height));
    }
    return byId;
  };

  it("Project and Subtask rows are 2.75rem in both panes, paired by row id", async () => {
    await mount();
    const byId = rowHeightsById();
    expect(byId.size).toBeGreaterThan(1);
    for (const [id, set] of byId) expect([...set], id).toEqual(["2.75rem"]);
    // both panes render each Project row
    const projectEls = Array.from(host.querySelectorAll<HTMLElement>("[data-gantt-row-id]")).filter((el) => el.getAttribute("data-gantt-row-id") === `project:${PROJECT_A}`);
    expect(projectEls.length).toBeGreaterThanOrEqual(2);
  });

  it("tapping + opens the inline row, not a sheet; the tree row and the chart-pane spacer are 2.75rem", async () => {
    await mount();
    await click(plus(STREET_A)!);
    expect(document.querySelector('[data-testid="gantt-group-create-task-sheet"]')).toBeNull();
    expect(editorRow()).not.toBeNull();
    expect(editorRow()!.style.height).toBe("2.75rem");
    const spacer = host.querySelector<HTMLElement>('[data-testid="gantt-group-create-task-spacer"]');
    expect(spacer).not.toBeNull();
    expect(spacer!.style.height).toBe("2.75rem");
  });

  it("a fine pointer at 1280px stays at 2.5rem", async () => {
    await viewport.set({ coarse: false });
    await mount();
    expect(new Set(rowHeights())).toEqual(new Set(["2.5rem"]));
  });

  it("switching coarse -> fine -> coarse updates the heights and keeps an open draft", async () => {
    await mount();
    await click(plus(STREET_A)!);
    await type(input()!, "Keep me");
    await setCoarse(false);
    expect(new Set(rowHeights())).toEqual(new Set(["2.5rem"]));
    expect(input()!.value).toBe("Keep me");
    await setCoarse(true);
    expect(new Set(rowHeights())).toEqual(new Set(["2.75rem"]));
    expect(input()!.value).toBe("Keep me");
  });
});
