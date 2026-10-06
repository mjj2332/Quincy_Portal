/**
 * #463 — the item menu on the Production Gantt, through the REAL vendored Gantt: a bar click, Enter
 * or right-click opens the shared menu (Open project and Reschedule… on a Project bar, Open project
 * and Edit schedule… on a checklist bar); a drag never does; Space still starts keyboard Adjust
 * (ADR 0009). Edit schedule… opens the bar-anchored picker (#582), no sheet, at every width.
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
import { dateTimePopup, popupButton, pressInPopup, rangeToggles } from "@/testing/date-time-popup";
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
let onAcceptGateChange: ReturnType<typeof vi.fn<(blocked: boolean) => void>>;

async function flush(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function mount(props: { withOpenProject?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ProductionGantt identity={identity} q="" filters={DEFAULT_GANTT_FACET_FILTERS} onFiltersChange={() => {}} onAcceptGateChange={onAcceptGateChange} onOpenProject={props.withOpenProject === false ? undefined : onOpenProject} />
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
  onAcceptGateChange = vi.fn<(blocked: boolean) => void>();
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

  describe("Edit schedule… opens the bar's own picker (#582)", () => {
    const pickerName = `Schedule for ${TASK_TITLE}, ${PROJECT_STREET}`;
    const picker = () => dateTimePopup(pickerName);
    const gateStates = () => onAcceptGateChange.mock.calls.map(([blocked]) => blocked);

    async function openPicker() {
      await mount();
      await activate(taskBar());
      await pick("Edit schedule…");
      await flush(3);
    }

    it("opens exactly one dialog, the picker, and no sheet; it opens on Start with the Project default and reminders", async () => {
      await openPicker();
      expect(picker()).not.toBeNull();
      expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
      expect(byTestId("event-calendar-schedule-editor")).toBeNull();
      expect(rangeToggles(picker()!).active).toBe("Start");
      expect(popupButton(picker()!, "Project default"), "the Project default shortcut").toBeDefined();
      expect(popupButton(picker()!, "1 day"), "a reminder chip").toBeDefined();
      expect(gateStates().at(-1)).toBe(true);
    });

    it("Cancel sends no PATCH, releases the gate and puts focus on the bar before the menu's restore timer", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await openPicker();
      await pressInPopup(picker()!, "Cancel");
      // Asserted before the item menu's 200ms restore-if-lost could run: the popover's own finalFocus did it.
      await flush(3);
      expect(document.activeElement).toBe(taskBar());
      expect(picker()).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(gateStates().at(-1)).toBe(false);
      vi.unstubAllGlobals();
    });

    it("Escape sends no PATCH and releases the gate", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await openPicker();
      await keydown(document.activeElement ?? document.body, "Escape");
      await flush(3);
      expect(picker()).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(gateStates().at(-1)).toBe(false);
      expect(document.activeElement).toBe(taskBar());
      vi.unstubAllGlobals();
    });

    it("an outside press sends no PATCH and releases the gate", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await openPicker();
      const outside = document.createElement("button");
      outside.type = "button";
      document.body.append(outside);
      await act(async () => {
        outside.focus();
        outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
        outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
        outside.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
        outside.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
        outside.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
        await Promise.resolve();
      });
      await flush(3);
      outside.remove();
      expect(picker()).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(gateStates().at(-1)).toBe(false);
      vi.unstubAllGlobals();
    });

    describe("opening focus lands inside the picker, on the Start day", () => {
      const describeActive = () => {
        const el = document.activeElement as HTMLElement | null;
        return { tag: el?.tagName, ariaLabel: el?.getAttribute("aria-label"), text: el?.textContent?.slice(0, 40), isDialog: el?.getAttribute("role") === "dialog", inPicker: !!(el && picker()?.contains(el)) };
      };
      const sleep = (ms: number) => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, ms)); });
      function expectOnPickerButton(when: string) {
        const active = document.activeElement as HTMLElement | null;
        const report = `${when}: ${JSON.stringify(describeActive())}`;
        expect(picker(), report).not.toBeNull();
        expect(active, report).not.toBeNull();
        expect(picker()!.contains(active), `inside the picker. ${report}`).toBe(true);
        expect(active, `not the dialog itself. ${report}`).not.toBe(picker());
        expect(active!.tagName, `a button. ${report}`).toBe("BUTTON");
      }

      it("keyboard: Enter on the bar -> ArrowDown -> Enter on Edit schedule… puts focus inside the picker on the Start day", async () => {
        await mount();
        const bar = taskBar();
        await act(async () => { bar.focus(); await Promise.resolve(); });
        // Enter on a button: keydown, then the browser's native keyboard click (detail 0).
        await keydown(bar, "Enter");
        await act(async () => { bar.click(); await Promise.resolve(); await Promise.resolve(); });
        await flush(6);
        expect(menu()).not.toBeNull();
        await keydown(document.activeElement!, "ArrowDown");
        await flush(3);
        const row = document.activeElement as HTMLElement;
        expect(row.textContent).toBe("Edit schedule…");
        await keydown(row, "Enter");
        await act(async () => { row.click(); await Promise.resolve(); await Promise.resolve(); });
        await flush(6);
        expectOnPickerButton("keyboard, after settle");
        await sleep(250);
        await flush(3);
        expectOnPickerButton("keyboard, after 250ms (past the restore timer)");
        await sleep(400);
        expectOnPickerButton("keyboard, after 650ms");
      });

      it("pointer: clicking the bar then Edit schedule… puts focus inside the picker on the Start day", async () => {
        await openPicker();
        expectOnPickerButton("pointer, after settle");
        await sleep(250);
        await flush(3);
        expectOnPickerButton("pointer, after 250ms (past the restore timer)");
        await sleep(400);
        expectOnPickerButton("pointer, after 650ms");
      });
    });

    it("stays open at a 720px-wide viewport (a bar session is not cancelled by narrowing)", async () => {
      const original = window.matchMedia;
      window.matchMedia = ((query: string) => ({
        matches: query === "(max-width: 720px)",
        media: query,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
      try {
        await openPicker();
        await flush(4);
        expect(picker()).not.toBeNull();
        expect(gateStates().at(-1)).toBe(true);
      } finally { window.matchMedia = original; }
    });
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
    await act(async () => { bar.focus(); await Promise.resolve(); });
    // Press Space for real: the bar must not consume it (a consumed Space cancels the browser's native
    // click), and nothing opens on the keydown itself.
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    await act(async () => { bar.dispatchEvent(space); await Promise.resolve(); });
    expect(space.defaultPrevented, "Space is left to the browser").toBe(false);
    expect(bar.getAttribute("data-adjusting")).toBeNull();
    expect(menu()).toBeNull();
    // The browser's native activation (what happens when Space is not prevented) is a keyboard click.
    await act(async () => { bar.click(); await Promise.resolve(); await Promise.resolve(); });
    await flush(30);
    expect(menu()).not.toBeNull();
  });
});
