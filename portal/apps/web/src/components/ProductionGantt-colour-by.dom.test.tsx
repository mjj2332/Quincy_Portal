/**
 * #916 / #920: frame 3b, Colour by People, through the real `ProductionGantt` render: the switch in
 * the Timeline's nav, the three People tones on Subtask bars (one assignee, shared, unassigned), the
 * initials printed in every People-mode bar, the neutral Project bar and its shoot → Deadline label,
 * the People key row, and the choice remembered across a remount with storage seeded, written and
 * blocked. Same render technique as `-appearance.dom`; no `[data-slot="…"]` selector
 * (`test-seam.guard.test.ts` guard F).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { adminProductionGanttResponseSchema, PRODUCTION_GANTT_ZONE, type GanttChecklistRowDto, type GanttProjectRowDto } from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { personColor } from "../lib/dashboard-appearance";
import { resetUiPrefMemory } from "../lib/ui-prefs";
import { TIMELINE_COLOUR_BY_KEY } from "../lib/timeline-colour-by";
import { ProductionGantt } from "./ProductionGantt";
import { DEFAULT_GANTT_FACET_FILTERS } from "../lib/production-gantt-filters";
import { startMoment, endMoment, subtaskReminders } from "@/testing/subtask-schedule";
import { installLocalStorageShim } from "@/testing/local-storage";

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

const PROJECT_ID = "11111111-1111-4111-8111-920000000001";
const STREET = "14 Wattle Street";
const ANIKA = { id: "33333333-3333-4333-8333-920000000001", name: "Anika Nair", roleLabel: "Editor", isExternal: false, active: true } as GanttChecklistRowDto["assignees"][number];
const ROB = { id: "33333333-3333-4333-8333-920000000002", name: "Rob Keane", roleLabel: "Editor", isExternal: false, active: true } as GanttChecklistRowDto["assignees"][number];

function makeTask(overrides: Partial<GanttChecklistRowDto> & { id: string; title: string }): GanttChecklistRowDto {
  return {
    projectId: PROJECT_ID,
    done: false,
    position: 0,
    assignees: [],
    otherAssigneeCount: 0,
    assignmentVersion: 0,
    schedule: { state: "range", version: 1, zone: PRODUCTION_GANTT_ZONE, start: startMoment("2026-09-15"), end: endMoment("2026-09-21"), due: "2026-09-21" },
    reminders: subtaskReminders(),
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canEditAssignees: true },
    ...overrides,
  };
}

const ROWS = [
  makeTask({ id: "22222222-2222-4222-8222-920000000001", title: "HDR blend", assignees: [ANIKA] }),
  makeTask({ id: "22222222-2222-4222-8222-920000000002", title: "Client revisions", assignees: [ANIKA, ROB] }),
  makeTask({ id: "22222222-2222-4222-8222-920000000003", title: "Agent copy review" }),
  makeTask({ id: "22222222-2222-4222-8222-920000000004", title: "Cull RAWs", assignees: [ROB], done: true }),
];

const PROJECT: GanttProjectRowDto = {
  id: PROJECT_ID,
  street: STREET,
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
  checklist: { completed: 1, total: ROWS.length },
  permissions: { canEditDeadline: true, canEditChildren: true },
  children: { rows: ROWS, total: ROWS.length, returned: ROWS.length, truncated: false, nextCursor: null },
};

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

async function render(root: Root) {
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((path: string) => (path.startsWith("/api/production-gantt") ? Promise.resolve(ganttResponse([PROJECT])) : Promise.reject(new Error(`unexpected fetch: ${path}`))));
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

function option(host: HTMLElement, value: "stage" | "people"): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="timeline-colour-by-${value}"]`);
  if (!button) throw new Error(`no Colour by ${value} option`);
  return button;
}

async function choose(host: HTMLElement, value: "stage" | "people") {
  await act(async () => {
    option(host, value).click();
    await Promise.resolve();
  });
}

const colourOf = (bar: HTMLElement) => bar.style.getPropertyValue("--gantt-event-color");

describe("ProductionGantt — Colour by People, frame 3b (#920)", () => {
  let host: HTMLDivElement;
  let root: Root;
  let shim: ReturnType<typeof installLocalStorageShim>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
    shim = installLocalStorageShim();
    resetUiPrefMemory();
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
    shim.restore();
    resetUiPrefMemory();
  });

  it("offers Colour by: Stage | People in the nav, Stage pressed by default", async () => {
    await render(root);
    const group = host.querySelector<HTMLElement>('[data-testid="timeline-colour-by"]');
    expect(group?.getAttribute("aria-label")).toBe("Colour by");
    expect(option(host, "stage").getAttribute("aria-pressed")).toBe("true");
    expect(option(host, "people").getAttribute("aria-pressed")).toBe("false");
    expect(colourOf(barFor(host, "HDR blend"))).toBe("var(--stage-editing)");
    expect(host.querySelector('[data-testid="stage-key-row"]')).not.toBeNull();
  });

  it("People fills a sole assignee's Subtask with their colour and prints their initials", async () => {
    await render(root);
    await choose(host, "people");
    expect(option(host, "people").getAttribute("aria-pressed")).toBe("true");
    const bar = barFor(host, "HDR blend");
    expect(colourOf(bar)).toBe(personColor(ANIKA.id));
    expect(bar.className).toContain("bg-(--gantt-event-color)");
    expect(bar.className).toContain("text-[var(--paper-000)]");
    expect(bar.querySelector('[data-testid="gantt-bar-initials"]')?.textContent).toBe("AN");
  });

  it("a shared Subtask is neutral with every assignee's avatar; an unassigned one is dashed with none", async () => {
    await render(root);
    await choose(host, "people");
    const shared = barFor(host, "Client revisions");
    expect(colourOf(shared)).toBe("var(--text-muted)");
    expect(shared.className).toContain("bg-surface-sunken");
    expect(shared.querySelector('[data-testid="gantt-bar-avatars"]')?.textContent).toBe("ANRK");
    const unassigned = barFor(host, "Agent copy review");
    expect(colourOf(unassigned)).toBe("var(--stage-awaiting-raw)");
    expect(unassigned.className).toContain("border-dashed");
    expect(unassigned.querySelector('[data-testid="gantt-bar-initials"], [data-testid="gantt-bar-avatars"]')).toBeNull();
  });

  it("a done Subtask keeps the done look and still prints its assignee's initials", async () => {
    await render(root);
    await choose(host, "people");
    const done = barFor(host, "Cull RAWs");
    expect(done.className).toContain("data-completed:bg-muted");
    expect(done.querySelector('[data-testid="gantt-done-mark"]')).not.toBeNull();
    expect(done.querySelector('[data-testid="gantt-bar-initials"]')?.textContent).toBe("RK");
  });

  it("the Project bar goes neutral and reads shoot → Deadline", async () => {
    await render(root);
    await choose(host, "people");
    const bar = barFor(host, STREET);
    expect(colourOf(bar)).toBe("var(--text-muted)");
    expect(bar.className).toContain("bg-surface-sunken");
    expect(bar.querySelector('[data-testid="gantt-bar-face"]')?.textContent).toBe("Mon 14 → Thu 24");
  });

  it("the key row lists each person's open Subtasks and Unassigned, display-only", async () => {
    await render(root);
    await choose(host, "people");
    expect(host.querySelector('[data-testid="stage-key-row"]')).toBeNull();
    const row = host.querySelector<HTMLElement>('[data-testid="people-key-row"]');
    expect(row).not.toBeNull();
    const chips = [...row!.querySelectorAll<HTMLElement>('[data-testid="people-key-chip"]')].map((chip) => chip.textContent);
    expect(chips).toEqual(["ANAnika Nair2 open", "RKRob Keane1 open", "Unassigned1 open"]);
    expect(row!.querySelector("button")).toBeNull();
  });

  it("Stage again restores the Stage look", async () => {
    await render(root);
    await choose(host, "people");
    await choose(host, "stage");
    const bar = barFor(host, "HDR blend");
    expect(colourOf(bar)).toBe("var(--stage-editing)");
    expect(bar.querySelector('[data-testid="gantt-bar-initials"]')).toBeNull();
    expect(barFor(host, STREET).querySelector('[data-testid="gantt-bar-face"]')?.textContent).toBe("Editing");
  });

  it("opens in People when storage already says so", async () => {
    shim.values.set(TIMELINE_COLOUR_BY_KEY, '"people"');
    await render(root);
    expect(option(host, "people").getAttribute("aria-pressed")).toBe("true");
    expect(colourOf(barFor(host, "HDR blend"))).toBe(personColor(ANIKA.id));
  });

  it("remembers the choice across a remount", async () => {
    await render(root);
    await choose(host, "people");
    expect(shim.values.get(TIMELINE_COLOUR_BY_KEY)).toBe('"people"');
    await act(async () => {
      root.unmount();
    });
    resetUiPrefMemory();
    root = createRoot(host);
    await render(root);
    expect(option(host, "people").getAttribute("aria-pressed")).toBe("true");
    expect(colourOf(barFor(host, "HDR blend"))).toBe(personColor(ANIKA.id));
  });

  it("with storage blocked, the choice still holds for the session", async () => {
    // Blocked site data: the accessor itself throws.
    Object.defineProperty(window, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
    await render(root);
    expect(option(host, "stage").getAttribute("aria-pressed")).toBe("true");
    await choose(host, "people");
    await act(async () => {
      root.unmount();
    });
    root = createRoot(host);
    await render(root);
    expect(option(host, "people").getAttribute("aria-pressed")).toBe("true");
    expect(colourOf(barFor(host, "HDR blend"))).toBe(personColor(ANIKA.id));
  });
});
