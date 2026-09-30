/**
 * fix-220-sol1 #4 — a real render proving `production-gantt-adapter.ts`'s new `progress` mapping
 * actually reaches the DOM through `ProductionGantt.tsx`'s `renderGanttEventContent`, and that the
 * renderer reproduces the pieces `gantt-bar.tsx`'s own `consumerOwnsContent` suppresses (the
 * selected-milestone ring, the done checkmark) without duplicating a hollow bar's title when the
 * vendor's own layout places it outside the bar.
 *
 * `data-progress`/`data-completed`/the aria-label's "N% complete" clause are set by `gantt-bar.tsx`
 * itself from `event.progress` BEFORE it ever asks `renderEvent` for content — they are the most
 * reliable proof the adapter's mapping reached the vendor, independent of anything this file's own
 * renderer chooses to draw. Same rendering technique as the sibling `.dom.test.tsx` files beside
 * this one; no `[data-slot="…"]` selector (`test-seam.guard.test.ts` guard F).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { adminProductionGanttResponseSchema, PRODUCTION_GANTT_ZONE, type GanttChecklistRowDto, type GanttProjectRowDto } from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { ProductionGantt } from "./ProductionGantt";
import { DEFAULT_GANTT_FACET_FILTERS } from "../lib/production-gantt-filters";

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

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

// The Gantt draws the month of `new Date()`, so a fixture anchored to the real "today" left the
// month once `isoDate(n)` crossed it (the widest bar spans `isoDate(20)`). The first block pins
// `Date` alone (timers stay real: `render` awaits real timeouts) early in a month so every
// `isoDate(0..20)` stays inside it.
const TODAY = new Date("2026-09-03T02:00:00.000Z");
function isoDate(daysFromToday: number): string {
  const date = new Date(TODAY);
  date.setDate(date.getDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

const DONE_TASK_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DONE_TASK_ID = "22222222-2222-4222-8222-111111111111";
const DONE_TASK_TITLE = "Done checklist task";

const NOT_DONE_PROJECT_ID = "11111111-1111-4111-8111-222222222222";
const NOT_DONE_TASK_ID = "22222222-2222-4222-8222-222222222222";
const NOT_DONE_TASK_TITLE = "Not-done range task";

const INVERTED_PROJECT_ID = "11111111-1111-4111-8111-777777777777";
const INVERTED_STREET = "7 Inverted Deadline Street";

const PARTIAL_PROGRESS_PROJECT_ID = "11111111-1111-4111-8111-333333333333";
const PARTIAL_PROGRESS_STREET = "3 Partial Progress Street";

const COMPLETED_BAR_PROJECT_ID = "11111111-1111-4111-8111-444444444444";
const COMPLETED_BAR_STREET = "4 Completed Bar Street";

const WIDE_HOLLOW_PROJECT_ID = "11111111-1111-4111-8111-555555555555";
const WIDE_HOLLOW_STREET = "5 Wide Hollow Street";

const NARROW_HOLLOW_PROJECT_ID = "11111111-1111-4111-8111-666666666666";
const NARROW_HOLLOW_STREET = "6 Narrow Hollow Street";

function makeProject(overrides: Partial<GanttProjectRowDto> & { id: string; street: string }): GanttProjectRowDto {
  return {
    suburb: null,
    agencyName: null,
    agentName: null,
    stageKey: "editing_autohdr",
    delivered: false,
    shootDate: isoDate(0),
    shootDateCivil: isoDate(0),
    createdAt: isoDate(0) + "T00:00:00.000Z",
    barStartDate: isoDate(0),
    deadline: { at: `${isoDate(10)}T05:00:00.000Z`, localCivil: `${isoDate(10)}T15:00`, version: 1, reminderOffsetsMinutes: [], overdue: false },
    deadlineVersion: 1,
    editors: [],
    checklist: { completed: 0, total: 0 },
    permissions: { canEditDeadline: true, canEditChildren: true },
    children: { rows: [], total: 0, returned: 0, truncated: false, nextCursor: null },
    ...overrides,
  };
}

function makeTask(overrides: Partial<GanttChecklistRowDto> & { id: string; projectId: string; title: string }): GanttChecklistRowDto {
  return {
    done: false,
    position: 0,
    assignees: [],
    otherAssigneeCount: 0,
    assignmentVersion: 0,
    schedule: {
      state: "range",
      version: 1,
      zone: PRODUCTION_GANTT_ZONE,
      start: { kind: "date", localCivil: isoDate(2), instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" },
      end: { kind: "date", localCivil: isoDate(2), instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" },
      due: isoDate(2),
    },
    permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canEditAssignees: true },
    ...overrides,
  };
}

function ganttResponse(projects: GanttProjectRowDto[]) {
  return adminProductionGanttResponseSchema.parse({
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], includeDelivered: false, includeCompletedChecklist: false },
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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function findByAriaLabelIncluding(host: HTMLElement, text: string): HTMLElement {
  // #344: bars only — a childless Project is now a group, so its tree toggle (named for the street)
  // and "Add task in <street>" row precede the bar in DOM order. Bars live in the timeline rows.
  const match = [...host.querySelectorAll<HTMLElement>("[data-gantt-resource] button")].find((candidate) => candidate.getAttribute("aria-label")?.includes(text));
  if (!match) throw new Error(`no bar button found with aria-label including "${text}"`);
  return match;
}

describe("ProductionGantt — completion reaches the DOM (fix-220-sol1 #4)", () => {
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

  it("a done checklist task's bar carries data-completed, and the reproduced done checkmark", async () => {
    const project = makeProject({
      id: DONE_TASK_PROJECT_ID,
      street: "1 Done Task Street",
      children: {
        rows: [
          makeTask({
            id: DONE_TASK_ID,
            projectId: DONE_TASK_PROJECT_ID,
            title: DONE_TASK_TITLE,
            done: true,
            schedule: {
              state: "range",
              version: 1,
              zone: PRODUCTION_GANTT_ZONE,
              start: { kind: "date", localCivil: isoDate(1), instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" },
              end: { kind: "date", localCivil: isoDate(3), instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" },
              due: isoDate(3),
            },
          }),
        ],
        total: 1,
        returned: 1,
        truncated: false,
        nextCursor: null,
      },
    });
    await render(host, root, [project]);
    const bar = findByAriaLabelIncluding(host, DONE_TASK_TITLE);
    expect(bar.getAttribute("data-completed")).toBe("true");
    expect(bar.getAttribute("aria-label")).toContain("100% complete");
    expect(bar.querySelector('[data-testid="gantt-done-mark"]')).not.toBeNull();
  });

  it("a not-done checklist task's bar carries no data-completed and no done checkmark", async () => {
    const project = makeProject({
      id: NOT_DONE_PROJECT_ID,
      street: "2 Not Done Street",
      children: {
        rows: [makeTask({ id: NOT_DONE_TASK_ID, projectId: NOT_DONE_PROJECT_ID, title: NOT_DONE_TASK_TITLE, done: false })],
        total: 1,
        returned: 1,
        truncated: false,
        nextCursor: null,
      },
    });
    await render(host, root, [project]);
    const bar = findByAriaLabelIncluding(host, NOT_DONE_TASK_TITLE);
    expect(bar.getAttribute("data-completed")).toBeNull();
    expect(bar.querySelector('[data-testid="gantt-done-mark"]')).toBeNull();
  });

  it("selecting an inverted-Deadline Project bar adds the reproduced selected ring to its diamond", async () => {
    const project = makeProject({
      id: INVERTED_PROJECT_ID,
      street: INVERTED_STREET,
      deadline: { at: `${isoDate(-2)}T05:00:00.000Z`, localCivil: `${isoDate(-2)}T15:00`, version: 1, reminderOffsetsMinutes: [], overdue: false },
    });
    await render(host, root, [project]);
    const bar = findByAriaLabelIncluding(host, INVERTED_STREET);
    const markers = host.querySelectorAll('[data-testid="gantt-milestone-marker"]');
    expect(markers.length).toBe(1);
    const marker = bar.querySelector('[data-testid="gantt-milestone-marker"]');
    expect(marker).not.toBeNull();
    expect(marker!.className).not.toMatch(/ring-ring\/50/);

    await act(async () => {
      bar.click();
      await Promise.resolve();
    });

    expect(bar.getAttribute("aria-pressed")).toBe("true");
    expect(marker!.className).toMatch(/ring-ring\/50/);
    expect(marker!.className).toMatch(/ring-2/);
  });

  it("a project bar's partial checklist completion reaches data-progress and the aria-label", async () => {
    const project = makeProject({
      id: PARTIAL_PROGRESS_PROJECT_ID,
      street: PARTIAL_PROGRESS_STREET,
      checklist: { completed: 1, total: 3 },
    });
    await render(host, root, [project]);
    const bar = findByAriaLabelIncluding(host, PARTIAL_PROGRESS_STREET);
    expect(bar.getAttribute("data-progress")).toBe("33");
    expect(bar.getAttribute("aria-label")).toContain("33% complete");
    expect(bar.getAttribute("data-completed")).toBeNull();
  });

  it("a fully-complete project bar carries data-completed and the reproduced done checkmark", async () => {
    const project = makeProject({
      id: COMPLETED_BAR_PROJECT_ID,
      street: COMPLETED_BAR_STREET,
      checklist: { completed: 4, total: 4 },
    });
    await render(host, root, [project]);
    const bar = findByAriaLabelIncluding(host, COMPLETED_BAR_STREET);
    expect(bar.getAttribute("data-completed")).toBe("true");
    expect(bar.getAttribute("aria-label")).toContain("100% complete");
    expect(bar.querySelector('[data-testid="gantt-done-mark"]')).not.toBeNull();
  });

  it("a WIDE hollow-start bar (no shoot date, long duration) places its title/time INSIDE — no data-label-outside on the bar", async () => {
    const project = makeProject({
      id: WIDE_HOLLOW_PROJECT_ID,
      street: WIDE_HOLLOW_STREET,
      shootDate: null,
      shootDateCivil: null,
      createdAt: isoDate(0) + "T00:00:00.000Z",
      deadline: { at: `${isoDate(20)}T05:00:00.000Z`, localCivil: `${isoDate(20)}T15:00`, version: 1, reminderOffsetsMinutes: [], overdue: false },
    });
    await render(host, root, [project]);
    const bar = findByAriaLabelIncluding(host, WIDE_HOLLOW_STREET);
    expect(bar.getAttribute("data-label-outside")).toBeNull();
    expect(bar.querySelector('[data-testid="gantt-hollow-start"]')).not.toBeNull();
    const titleSpan = [...bar.querySelectorAll("span")].find((candidate) => candidate.textContent === WIDE_HOLLOW_STREET);
    expect(titleSpan).toBeDefined();
    // Structural proof the hide-on-label-outside mechanism is wired to the SAME ancestor attribute
    // `gantt-bar.tsx` sets (`data-label-outside`, gantt-bar.tsx:732) — real visual hiding requires
    // compiled Tailwind CSS this jsdom-style test environment does not load, so this asserts the
    // selector is present and targets the right attribute name, not the computed style.
    expect(titleSpan!.className).toContain("group-data-[label-outside]/gantt-bar-group:hidden");
  });

  it("a NARROW hollow-start bar (no shoot date, short duration) is placed label-outside by the vendor's own layout, and the vendor's own outside label carries the title", async () => {
    const project = makeProject({
      id: NARROW_HOLLOW_PROJECT_ID,
      street: NARROW_HOLLOW_STREET,
      shootDate: null,
      shootDateCivil: null,
      createdAt: isoDate(0) + "T00:00:00.000Z",
      deadline: { at: `${isoDate(1)}T05:00:00.000Z`, localCivil: `${isoDate(1)}T15:00`, version: 1, reminderOffsetsMinutes: [], overdue: false },
    });
    await render(host, root, [project]);
    const bar = findByAriaLabelIncluding(host, NARROW_HOLLOW_STREET);
    expect(bar.getAttribute("data-label-outside")).toBe("true");
    expect(bar.querySelector('[data-testid="gantt-hollow-start"]')).not.toBeNull();
    // The vendor's own layout renders a SIBLING title label next to a label-outside bar
    // (`gantt-view.tsx`'s own `placement !== "inside"` branch) — this test does not select it by
    // its `data-slot` (guard F), it just proves a second occurrence of the street text exists
    // outside this bar's own subtree, confirming the fixture is really exercising the
    // label-outside layout path and not merely asserting the attribute in isolation.
    const outsideOccurrences = [...host.querySelectorAll("span")].filter((candidate) => candidate.textContent === NARROW_HOLLOW_STREET && !bar.contains(candidate));
    expect(outsideOccurrences.length).toBeGreaterThan(0);
  });
});

/**
 * #258 — a hollow-start or completed bar's inline time label is the vendor's own
 * `formatEventTime` string (dated on both ends for a multi-day timed bar, upper-case AM/PM), not a
 * Quincy lookalike. `Date` alone is pinned (never `setTimeout`: `render` awaits real timeouts) so
 * the Gantt's month view — seeded from `new Date()` — always shows these fixed fixture dates. Both
 * bars sit inside September 2026 and before Sydney's DST start (Sun 4 Oct), so every instant is +10.
 */
describe("ProductionGantt — hollow/completed bars use the vendor's dated time label (#258)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T02:00:00.000Z"));
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

  function fixedProject(overrides: Partial<GanttProjectRowDto> & { id: string; street: string }): GanttProjectRowDto {
    return makeProject({
      shootDate: "2026-09-08",
      shootDateCivil: "2026-09-08",
      createdAt: "2026-09-01T00:00:00.000Z",
      barStartDate: "2026-09-08",
      deadline: { at: "2026-09-18T07:00:00.000Z", localCivil: "2026-09-18T17:00", version: 1, reminderOffsetsMinutes: [], overdue: false },
      ...overrides,
    });
  }

  function timeLabelOf(bar: HTMLElement): string {
    const label = bar.querySelector<HTMLElement>('[data-testid="gantt-event-time"]');
    if (!label) throw new Error("bar has no inline time label");
    return label.textContent ?? "";
  }

  it("a WIDE hollow-start bar's time label is the vendor's dated string, and is part of its aria-label", async () => {
    const project = fixedProject({
      id: WIDE_HOLLOW_PROJECT_ID,
      street: WIDE_HOLLOW_STREET,
      shootDate: null,
      shootDateCivil: null,
      // Sep 11, 00:00 Sydney (+10) — the hollow bar starts at `createdAt`.
      createdAt: "2026-09-10T14:00:00.000Z",
      barStartDate: "2026-09-11",
      deadline: { at: "2026-09-25T07:00:00.000Z", localCivil: "2026-09-25T17:00", version: 1, reminderOffsetsMinutes: [], overdue: false },
    });
    await render(host, root, [project]);
    const bar = findByAriaLabelIncluding(host, WIDE_HOLLOW_STREET);
    expect(bar.querySelector('[data-testid="gantt-hollow-start"]')).not.toBeNull();
    const label = timeLabelOf(bar);
    expect(label).toBe("Sep 11, 12:00 AM - Sep 25, 5:00 PM");
    expect(bar.getAttribute("aria-label")).toContain(label);
  });

  it("a fully-complete bar's time label is the vendor's dated string, and is part of its aria-label", async () => {
    const project = fixedProject({
      id: COMPLETED_BAR_PROJECT_ID,
      street: COMPLETED_BAR_STREET,
      checklist: { completed: 4, total: 4 },
    });
    await render(host, root, [project]);
    const bar = findByAriaLabelIncluding(host, COMPLETED_BAR_STREET);
    expect(bar.querySelector('[data-testid="gantt-done-mark"]')).not.toBeNull();
    const label = timeLabelOf(bar);
    expect(label).toBe("Sep 8, 12:00 AM - Sep 18, 5:00 PM");
    expect(bar.getAttribute("aria-label")).toContain(label);
  });
});

/**
 * #256 — the tree panel's name column fills the panel, and its header names what the rows are.
 * Lives here for this file's render helper; the vendor-level fill contract itself is pinned by
 * `reui/gantt/gantt-tree-name-fill.dom.test.tsx`.
 */
describe("ProductionGantt — tree header says Projects and the name column fills (#256)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
  });

  it("the tree header reads Projects, not Resources, and grows to fill the panel", async () => {
    await render(host, root, [makeProject({ id: PARTIAL_PROGRESS_PROJECT_ID, street: PARTIAL_PROGRESS_STREET })]);
    const header = host.querySelector<HTMLElement>('[data-testid="gantt-tree-name-header"]');
    expect(header).not.toBeNull();
    expect(header!.textContent?.trim()).toBe("Projects");
    expect(header!.textContent).not.toContain("Resources");
    expect(header!.style.flexGrow).toBe("1");
    expect(header!.style.width).toBe("180px");
  });
});
