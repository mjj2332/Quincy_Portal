/**
 * #916 / #919: frame 3a's bar content reaches the DOM through the real `ProductionGantt` render: the
 * Project bar's Stage label and treatment, a same-day Subtask's diamond, a done Subtask's tick, the
 * late chip beside a late bar, and the merged bar classes (lesson "A consumer `eventClassName` must
 * override every state the vendor tints"). Same render technique as `-completion.dom`; no
 * `[data-slot="…"]` selector (`test-seam.guard.test.ts` guard F).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { adminProductionGanttResponseSchema, PRODUCTION_GANTT_ZONE, type GanttChecklistRowDto, type GanttProjectRowDto } from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { ProductionGantt } from "./ProductionGantt";
import { DEFAULT_GANTT_FACET_FILTERS } from "../lib/production-gantt-filters";
import { startMoment, endMoment, subtaskReminders } from "@/testing/subtask-schedule";

const apiGetMock = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  apiGet: (path: string) => apiGetMock(path),
}));
vi.mock("../lib/stages", () => ({
  presentationStages: (stages: unknown[]) => stages,
  useStages: () => ({
    stages: [
      { key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1, active: true },
      { key: "raw_review", label: "RAW review", displayOrder: 2, active: true },
      { key: "editing", label: "Editing", displayOrder: 3, active: true },
      { key: "edited_review", label: "Edited review", displayOrder: 4, active: true },
      { key: "delivered", label: "Delivered", displayOrder: 5, active: true },
    ],
    presentationStageKey: (key: string) => key,
  }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

// Thursday 17 Sep 2026, 12:00 Sydney (+10, before the 4 Oct DST start).
const TODAY = new Date("2026-09-17T02:00:00.000Z");

const PROJECT_ID = "11111111-1111-4111-8111-919000000001";
const STREET = "14 Wattle Street";
const LATE_PROJECT_ID = "11111111-1111-4111-8111-919000000002";
const LATE_STREET = "3 Late Lane";
const AWAITING_PROJECT_ID = "11111111-1111-4111-8111-919000000003";
const AWAITING_STREET = "9 Waiting Way";

function makeProject(overrides: Partial<GanttProjectRowDto> & { id: string; street: string }): GanttProjectRowDto {
  return {
    suburb: null,
    agencyName: null,
    agentName: null,
    stageKey: "editing_autohdr",
    delivered: false,
    archived: false,
    shootDate: "2026-09-14",
    shootDateCivil: "2026-09-14",
    createdAt: "2026-09-01T00:00:00.000Z",
    barStartDate: "2026-09-14",
    deadline: { at: "2026-09-24T07:00:00.000Z", localCivil: "2026-09-24T17:00", version: 1, reminderOffsetsMinutes: [], overdue: false },
    deadlineVersion: 1,
    editors: [],
    checklist: { completed: 0, total: 0 },
    permissions: { canEditDeadline: true, canEditChildren: true },
    children: { rows: [], total: 0, returned: 0, truncated: false, nextCursor: null },
    ...overrides,
  };
}

function makeTask(overrides: Partial<GanttChecklistRowDto> & { id: string; projectId: string; title: string; from: string; to: string }): GanttChecklistRowDto {
  const { from, to, ...rest } = overrides;
  return {
    done: false,
    position: 0,
    assignees: [],
    otherAssigneeCount: 0,
    assignmentVersion: 0,
    schedule: { state: "range", version: 1, zone: PRODUCTION_GANTT_ZONE, start: startMoment(from), end: endMoment(to), due: to },
    reminders: subtaskReminders(),
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canEditAssignees: true },
    ...rest,
  };
}

function withChildren(project: GanttProjectRowDto, rows: GanttChecklistRowDto[]): GanttProjectRowDto {
  return {
    ...project,
    checklist: { completed: rows.filter((row) => row.done).length, total: rows.length },
    children: { rows, total: rows.length, returned: rows.length, truncated: false, nextCursor: null },
  };
}

function ganttResponse(projects: GanttProjectRowDto[]) {
  return adminProductionGanttResponseSchema.parse({
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], priorities: [], archived: "hide", includeDelivered: false, includeCompletedChecklist: false },
    projects,
    page: { limit: 100, returned: projects.length, nextCursor: null },
    density: { matchedProjects: projects.length, matchedRows: projects.length, drawCap: 2000, tooManyToDraw: false },
  });
}

const identity: DashboardIdentity = { principalId: "user-1", role: "admin", authorizationEpoch: 0 };

async function render(host: HTMLElement, root: Root, projects: GanttProjectRowDto[]) {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path: string) => (path.startsWith("/api/production-gantt") ? Promise.resolve(ganttResponse(projects)) : Promise.reject(new Error(`unexpected fetch: ${path}`))));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ProductionGantt identity={identity} q="" filters={DEFAULT_GANTT_FACET_FILTERS} onFiltersChange={() => {}} />
      </QueryClientProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  for (let i = 0; i < 2; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function barFor(host: HTMLElement, text: string): HTMLElement {
  const match = [...host.querySelectorAll<HTMLElement>("[data-gantt-resource] button")].find((candidate) => candidate.getAttribute("aria-label")?.includes(text));
  if (!match) throw new Error(`no bar with aria-label including "${text}"`);
  return match;
}

/** The bar's row in the timeline: the late chip sits beside the bar, not inside it. */
function rowOf(bar: HTMLElement): HTMLElement {
  return bar.closest<HTMLElement>("[data-gantt-resource]")!;
}

describe("ProductionGantt — frame 3a bar content (#919)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    host.remove();
    vi.useRealTimers();
  });

  it("a Project bar shows its Stage label and treatment, filled with the Stage tone, with no progress fill", async () => {
    await render(host, root, [
      makeProject({ id: PROJECT_ID, street: STREET }),
      makeProject({ id: AWAITING_PROJECT_ID, street: AWAITING_STREET, stageKey: "awaiting_raw" }),
    ]);
    const bar = barFor(host, STREET);
    const content = bar.querySelector<HTMLElement>('[data-testid="gantt-bar-face"]');
    expect(content?.getAttribute("data-treatment")).toBe("solid");
    expect(content?.textContent).toContain("Editing");
    expect(bar.style.getPropertyValue("--gantt-event-color")).toBe("var(--stage-editing)");
    expect(bar.className).toContain("bg-(--gantt-event-color)");
    // The vendor's rest wash is replaced, not stacked (tailwind-merge drops it: same variant chain).
    expect(bar.className).not.toMatch(/(^|\s)bg-\(--gantt-event-color\)\/20(\s|$)/);
    const awaiting = barFor(host, AWAITING_STREET);
    expect(awaiting.querySelector('[data-testid="gantt-bar-face"]')?.getAttribute("data-treatment")).toBe("hollow-dashed");
    expect(awaiting.className).toContain("border-dashed");
  });

  it("a same-day Subtask carries the diamond marker; a multi-day one does not", async () => {
    await render(host, root, [
      withChildren(makeProject({ id: PROJECT_ID, street: STREET }), [
        makeTask({ id: "22222222-2222-4222-8222-919000000001", projectId: PROJECT_ID, title: "Same day QA", from: "2026-09-18", to: "2026-09-18" }),
        makeTask({ id: "22222222-2222-4222-8222-919000000002", projectId: PROJECT_ID, title: "Edit photos", from: "2026-09-15", to: "2026-09-21" }),
      ]),
    ]);
    const diamond = barFor(host, "Same day QA");
    expect(diamond.querySelector('[data-testid="gantt-same-day-marker"]')).not.toBeNull();
    expect(diamond.querySelector('[data-testid="gantt-bar-face"]')?.getAttribute("data-shape")).toBe("diamond");
    expect(diamond.className).toContain("not-in-data-[scale=day]:bg-transparent!");
    const bar = barFor(host, "Edit photos");
    expect(bar.querySelector('[data-testid="gantt-same-day-marker"]')).toBeNull();
  });

  it("a done Subtask shows the tick and the D2 fill in its completed states", async () => {
    await render(host, root, [
      withChildren(makeProject({ id: PROJECT_ID, street: STREET }), [
        makeTask({ id: "22222222-2222-4222-8222-919000000003", projectId: PROJECT_ID, title: "Cull RAWs", from: "2026-09-14", to: "2026-09-16", done: true }),
      ]),
    ]);
    const bar = barFor(host, "Cull RAWs");
    expect(bar.getAttribute("data-completed")).toBe("true");
    expect(bar.querySelector('[data-testid="gantt-done-mark"]')).not.toBeNull();
    expect(bar.className).toContain("data-completed:bg-muted");
    expect(bar.className).toContain("data-completed:border-(--text-muted)");
    expect(bar.className).not.toContain("data-completed:bg-transparent");
  });

  it("a late Project and a late Subtask carry a late chip beside the bar with the late wording", async () => {
    await render(host, root, [
      withChildren(
        makeProject({
          id: LATE_PROJECT_ID,
          street: LATE_STREET,
          deadline: { at: "2026-09-15T07:00:00.000Z", localCivil: "2026-09-15T17:00", version: 1, reminderOffsetsMinutes: [], overdue: true },
        }),
        [makeTask({ id: "22222222-2222-4222-8222-919000000004", projectId: LATE_PROJECT_ID, title: "Overdue edit", from: "2026-09-14", to: "2026-09-16" })],
      ),
    ]);
    const projectBar = barFor(host, LATE_STREET);
    const projectChip = rowOf(projectBar).querySelector<HTMLElement>('[data-testid="gantt-late-chip"]');
    expect(projectChip?.textContent).toBe("2 days late");
    expect(projectBar.contains(projectChip)).toBe(false);
    const taskBar = barFor(host, "Overdue edit");
    expect(rowOf(taskBar).querySelector('[data-testid="gantt-late-chip"]')?.textContent).toBe("1 day late");
    expect(taskBar.className).toContain("border-(--late)");
  });

  it("an on-time bar carries no late chip", async () => {
    await render(host, root, [makeProject({ id: PROJECT_ID, street: STREET })]);
    expect(rowOf(barFor(host, STREET)).querySelector('[data-testid="gantt-late-chip"]')).toBeNull();
  });
});
