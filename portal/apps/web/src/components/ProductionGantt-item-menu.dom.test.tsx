/**
 * #463 — the item menu on the Production Gantt, through the REAL vendored Gantt: a bar click, Enter
 * or right-click opens the shared menu (Open project and Reschedule… on a Project bar, Open project
 * and Edit schedule… on a checklist bar); a drag never does; Space still starts keyboard Adjust
 * (ADR 0009). Edit schedule… opens the sheet at every width (not the inline popover).
 *
 * Guard F: bars are found by their accessible name, the menu by role, dialogs by Quincy test ids.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { adminProductionGanttResponseSchema, PRODUCTION_GANTT_ZONE } from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { DEFAULT_GANTT_FACET_FILTERS } from "../lib/production-gantt-filters";
import { ProductionGantt } from "./ProductionGantt";
import { dateTimePopup, popupButton } from "@/testing/date-time-popup";
import { endMoment, startMoment, subtaskReminders } from "@/testing/subtask-schedule";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  apiGet: (path: string) => apiGetMock(path),
}));
vi.mock("../lib/stages", () => ({
  presentationStages: (stages: unknown[]) => stages,
  useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_STREET = "1 Menu Street";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const TASK_TITLE = "Deliver preview gallery";

// Only `Date` is pinned (timers stay real) to a mid-month instant, as `ProductionGantt-readonly` does.
const TODAY = new Date("2026-09-15T02:00:00.000Z");
function isoDate(daysFromToday: number): string {
  const date = new Date(TODAY);
  date.setDate(date.getDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

type Fixture = { canEditDeadline: boolean; taskCanDrag: boolean };
function ganttResponse({ canEditDeadline, taskCanDrag }: Fixture) {
  const shoot = isoDate(0);
  return adminProductionGanttResponseSchema.parse({
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], priorities: [], archived: "hide", includeDelivered: false, includeCompletedChecklist: false },
    projects: [{
      id: PROJECT_ID, street: PROJECT_STREET, suburb: null, agencyName: null, agentName: null, stageKey: "editing_autohdr", delivered: false, archived: false,
      shootDate: shoot, shootDateCivil: shoot, createdAt: `${shoot}T00:00:00.000Z`, barStartDate: shoot,
      deadline: { at: `${isoDate(5)}T05:00:00.000Z`, localCivil: `${isoDate(5)}T15:00`, version: 1, reminderOffsetsMinutes: [], overdue: false },
      deadlineVersion: 1, editors: [], checklist: { completed: 0, total: 1 },
      permissions: { canEditDeadline, canEditChildren: true },
      children: {
        rows: [{
          id: TASK_ID, projectId: PROJECT_ID, title: TASK_TITLE, done: false, position: 0, assignees: [], otherAssigneeCount: 0, assignmentVersion: 0,
          schedule: { state: "range", version: 1, zone: PRODUCTION_GANTT_ZONE, start: startMoment(isoDate(2)), end: endMoment(isoDate(3)), due: isoDate(3) },
          reminders: subtaskReminders(), permissions: { canDrag: taskCanDrag, canResize: taskCanDrag, canOpenScheduleEditor: true, canEditAssignees: false },
        }],
        total: 1, returned: 1, truncated: false, nextCursor: null,
      },
    }],
    page: { limit: 100, returned: 1, nextCursor: null },
    density: { matchedProjects: 1, matchedRows: 2, drawCap: 2000, tooManyToDraw: false },
  });
}

const identity: DashboardIdentity = { principalId: "user-1", role: "admin", authorizationEpoch: 0 };

let host: HTMLDivElement;
let root: Root;
let fixture: Fixture;
let onOpenProject: ReturnType<typeof vi.fn<(id: string) => void>>;

async function flush(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function mount(props: { withOpenProject?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ProductionGantt identity={identity} q="" filters={DEFAULT_GANTT_FACET_FILTERS} onFiltersChange={() => {}} onOpenProject={props.withOpenProject === false ? undefined : onOpenProject} />
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
  await flush();
}

function projectBar(): HTMLButtonElement {
  const row = host.querySelector<HTMLElement>(`[data-gantt-resource="project:${PROJECT_ID}"]`);
  const bar = row && [...row.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.getAttribute("aria-label")?.startsWith(`${PROJECT_STREET},`));
  if (!bar) throw new Error("no project bar");
  return bar;
}
function taskBar(): HTMLButtonElement {
  const bar = [...host.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.getAttribute("aria-label")?.startsWith(TASK_TITLE));
  if (!bar) throw new Error("no task bar");
  return bar;
}
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const menuLabels = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((node) => node.textContent);
const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((node) => node.textContent === label) ?? null;
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function activate(bar: HTMLElement) {
  await act(async () => { bar.focus(); await Promise.resolve(); });
  await act(async () => { bar.click(); await Promise.resolve(); await Promise.resolve(); });
  await flush(3);
}
async function pick(label: string) {
  await act(async () => { menuItem(label)!.click(); await Promise.resolve(); await Promise.resolve(); });
  await flush(6);
}
async function keydown(element: Element, key: string) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(TODAY);
  fixture = { canEditDeadline: true, taskCanDrag: true };
  onOpenProject = vi.fn<(id: string) => void>();
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path: string) => (path.startsWith("/api/production-gantt") ? Promise.resolve(ganttResponse(fixture)) : Promise.reject(new Error(`unexpected fetch: ${path}`))));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); await Promise.resolve(); });
  host.remove();
  vi.useRealTimers();
});

describe("ProductionGantt item menu (#463)", () => {
  it("a Project bar click opens Open project and Reschedule…", async () => {
    await mount();
    await activate(projectBar());
    expect(menu()).not.toBeNull();
    expect(menuLabels()).toEqual(["Open project", "Reschedule…"]);
  });

  it("a checklist bar click opens Open project and Edit schedule…", async () => {
    await mount();
    await activate(taskBar());
    expect(menuLabels()).toEqual(["Open project", "Edit schedule…"]);
  });

  it("a bar is a menu button, not a pressed toggle", async () => {
    await mount();
    const bar = projectBar();
    expect(bar.getAttribute("aria-haspopup")).toBe("menu");
    expect(bar.getAttribute("aria-expanded")).toBe("false");
    expect(bar.hasAttribute("aria-pressed")).toBe(false);
    await activate(bar);
    expect(bar.getAttribute("aria-expanded")).toBe("true");
  });

  it("a user who may not edit the Deadline gets Open project only on the Project bar", async () => {
    fixture.canEditDeadline = false;
    await mount();
    await activate(projectBar());
    expect(menuLabels()).toEqual(["Open project"]);
  });

  it("offers no Open project when the surface was given no way to open one", async () => {
    await mount({ withOpenProject: false });
    await activate(taskBar());
    expect(menuLabels()).toEqual(["Edit schedule…"]);
  });

  it("Open project calls onOpenProject with the bar focused", async () => {
    await mount();
    const bar = projectBar();
    let focusedAtCall: Element | null = null;
    onOpenProject.mockImplementation(() => { focusedAtCall = document.activeElement; });
    await activate(bar);
    await pick("Open project");
    expect(onOpenProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(focusedAtCall).toBe(bar);
  });

  it("Reschedule… opens the move dialog, and Cancel returns focus to the bar", async () => {
    await mount();
    await activate(projectBar());
    await pick("Reschedule…");
    expect(byTestId("event-calendar-move-dialog")).not.toBeNull();
    await act(async () => { byTestId("event-calendar-move-cancel")!.click(); await Promise.resolve(); });
    await flush(30);
    expect(document.activeElement).toBe(projectBar());
  });

  it("Edit schedule… opens the schedule sheet, and Cancel returns focus to the bar", async () => {
    await mount();
    await activate(taskBar());
    await pick("Edit schedule…");
    expect(byTestId("event-calendar-schedule-editor")).not.toBeNull();
    await act(async () => { byTestId("event-calendar-schedule-cancel")!.click(); await Promise.resolve(); });
    await flush(30);
    expect(document.activeElement).toBe(taskBar());
  });

  it("Edit schedule… gives the sheet the Project default shortcut", async () => {
    await mount();
    await activate(taskBar());
    await pick("Edit schedule…");
    const sheet = byTestId("event-calendar-schedule-editor")!;
    const trigger = [...sheet.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-haspopup") === "dialog");
    expect(trigger, "the sheet's Schedule field").toBeDefined();
    await act(async () => { trigger!.click(); await Promise.resolve(); await Promise.resolve(); });
    await flush(30);
    expect(popupButton(dateTimePopup("Schedule")!, "Project default"), "the Project default shortcut").toBeDefined();
  });

  it("Escape closes the menu and returns focus to the bar", async () => {
    await mount();
    const bar = taskBar();
    await activate(bar);
    await keydown(document.activeElement!, "Escape");
    await flush(30);
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(bar);
  });

  it("a right-click opens the same menu and prevents the browser's", async () => {
    await mount();
    const bar = projectBar();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 10 });
    await act(async () => { bar.dispatchEvent(event); await Promise.resolve(); await Promise.resolve(); });
    await flush(3);
    expect(event.defaultPrevented).toBe(true);
    expect(menuLabels()).toEqual(["Open project", "Reschedule…"]);
  });

  it("a click on a read-only bar whose pointer travelled 4px or more opens nothing; the same click without travel does", async () => {
    fixture.canEditDeadline = false;
    await mount();
    const bar = projectBar();
    const press = (x: number) => act(async () => { bar.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 9, button: 0, clientX: x, clientY: 10 })); await Promise.resolve(); });
    const click = (x: number) => act(async () => { bar.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: x, clientY: 10 })); await Promise.resolve(); await Promise.resolve(); });
    await press(100);
    await click(160);
    await flush(3);
    expect(menu()).toBeNull();
    await press(100);
    await click(101);
    await flush(3);
    expect(menu()).not.toBeNull();
  });

  it("Space on an adjustable bar starts keyboard Adjust and opens no menu; Enter commits it with no menu either", async () => {
    await mount();
    const bar = taskBar();
    await act(async () => { bar.focus(); await Promise.resolve(); });
    await keydown(bar, " ");
    expect(bar.getAttribute("data-adjusting")).not.toBeNull();
    expect(menu()).toBeNull();
    await keydown(bar, "Enter");
    await flush(3);
    expect(menu()).toBeNull();
  });

  it("Space on a bar nothing can adjust is left to the browser: a native click opens the menu", async () => {
    fixture.taskCanDrag = false;
    await mount();
    const bar = taskBar();
    await activate(bar);
    expect(menu()).not.toBeNull();
  });
});
