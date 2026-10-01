/**
 * #220 pass B, build spec S6 — proves the read-only boundary in a real render, not just by
 * inspecting props: `Space` on a focused project bar must not open Adjust mode, and no bar may
 * render a resize grip. Since #221 PR B2 checklist rows and the project's deadline edge are
 * writable, so this pins what stays read-only: a PROJECT bar whose viewer lacks
 * `permissions.canEditDeadline`, and a checklist task locked read-only, which never renders grips — the
 * writable paths are covered by `ProductionGantt.writes.dom.test.tsx`. (Until #224 the fixture
 * granted `canEditDeadline` and passed only while its deadline fell past the visible month, which
 * clipped the bar's end edge; the diamond test failed in the last two days of every month.)
 * `gantt-bar-adjust-keyboard.dom.test.tsx` and `gantt-bar-resize-grips.dom.test.tsx` already prove the VENDOR's own `readOnly`/`interactions`
 * contract in isolation; this proves `ProductionGantt.tsx`'s actual composition of it — the real
 * props this file passes to `<Gantt>`, through the real adapter, end to end.
 *
 * No `[data-slot="…"]` selectors here (`test-seam.guard.test.ts` guard F forbids a DOM test
 * outside `components/reui/` from selecting a vendor-authored one) — the bar is located by its own
 * rendered text instead, the same way `ProductionGantt.tsx`'s own `renderEvent` puts it there.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { adminProductionGanttResponseSchema, PRODUCTION_GANTT_ZONE } from "@quincy/shared";
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

// happy-dom has no `Element#getAnimations`; base-ui's ScrollArea viewport (composed by
// `<GanttView>`) calls it on a timer. Same polyfill `gantt-adjust-ghost-marker.dom.test.tsx` and
// siblings under `components/reui/gantt/` already use.
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_STREET = "1 Readonly Street";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const TASK_TITLE = "Deliver preview gallery";

// `ProductionGantt` defaults its visible `date` state to `new Date()` and draws that month, with no
// way for a caller to override it. Anchoring the fixture to the real "today" broke in the last two
// days of every month: `isoDate(2)` landed in the next month and the task bar never rendered. So
// `Date` is pinned (only `Date`: timers stay real) to a mid-month instant, and every fixture date
// sits inside that month.
const TODAY = new Date("2026-09-15T02:00:00.000Z");
function isoDate(daysFromToday: number): string {
  const date = new Date(TODAY);
  date.setDate(date.getDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}
const SHOOT_DATE = isoDate(0);
const DEADLINE_DATE = isoDate(5);

function ganttResponse(deadlineDate: string = DEADLINE_DATE) {
  return adminProductionGanttResponseSchema.parse({
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], priorities: [], archived: "hide", includeDelivered: false, includeCompletedChecklist: false },
    projects: [
      {
        id: PROJECT_ID,
        street: PROJECT_STREET,
        suburb: null,
        agencyName: null,
        agentName: null,
        stageKey: "editing_autohdr",
        delivered: false,
        archived: false,
        shootDate: SHOOT_DATE,
        shootDateCivil: SHOOT_DATE,
        createdAt: SHOOT_DATE + "T00:00:00.000Z",
        barStartDate: SHOOT_DATE,
        deadline: { at: `${deadlineDate}T05:00:00.000Z`, localCivil: `${deadlineDate}T15:00`, version: 1, reminderOffsetsMinutes: [], overdue: false },
        deadlineVersion: 1,
        editors: [],
        checklist: { completed: 0, total: 1 },
        permissions: { canEditDeadline: false, canEditChildren: true },
        children: {
          rows: [
            {
              id: TASK_ID,
              projectId: PROJECT_ID,
              title: TASK_TITLE,
              done: false,
              position: 0,
              assignees: [],
              otherAssigneeCount: 0,
              assignmentVersion: 0,
              schedule: {
                state: "range",
                version: 1,
                zone: PRODUCTION_GANTT_ZONE, start: { kind: "date", localCivil: isoDate(2), instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" }, end: { kind: "date", localCivil: isoDate(2), instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" },
                due: isoDate(2),
              },
              // The task itself is locked so the panel's only possible grip would be the Project's
              // (which `canEditDeadline: false` withholds).
              permissions: { canDrag: false, canResize: false, canOpenScheduleEditor: true, canEditAssignees: false },
            },
          ],
          total: 1,
          returned: 1,
          truncated: false,
          nextCursor: null,
        },
      },
    ],
    page: { limit: 100, returned: 1, nextCursor: null },
    density: { matchedProjects: 1, matchedRows: 1, drawCap: 2000, tooManyToDraw: false },
  });
}

const identity: DashboardIdentity = { principalId: "user-1", role: "admin", authorizationEpoch: 0 };

async function render(host: HTMLElement, root: Root) {
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

function findBarButton(host: HTMLElement): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(PROJECT_STREET));
  if (!button) throw new Error(`no bar button found for "${PROJECT_STREET}"`);
  return button;
}

describe("ProductionGantt — read-only boundary", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(TODAY);
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path: string) => (path.startsWith("/api/production-gantt") ? Promise.resolve(ganttResponse()) : Promise.reject(new Error(`unexpected fetch: ${path}`))));
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

  it("renders the project bar with no aria-keyshortcuts, and Space does not open Adjust mode", async () => {
    await render(host, root);
    const bar = findBarButton(host);

    // A genuinely adjustable bar advertises "Space" — this one, `readOnly: true` from the
    // adapter, must advertise nothing at all (gantt-bar.tsx's own `keyShortcuts` computation).
    expect(bar.getAttribute("aria-keyshortcuts")).toBeNull();

    await act(async () => {
      bar.focus();
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(bar);

    await act(async () => {
      bar.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: " " }));
      await Promise.resolve();
    });

    expect(bar.getAttribute("data-adjusting")).toBeNull();
    expect(host.querySelector('[aria-label="Adjusting"]')).toBeNull();
  });

  it("renders no resize grip anywhere in the panel", async () => {
    await render(host, root);
    findBarButton(host); // sanity: the bar itself did render
    expect(host.querySelector('[data-testid="gantt-resize-handle-start"]')).toBeNull();
    expect(host.querySelector('[data-testid="gantt-resize-handle-end"]')).toBeNull();
  });

  it("renders the stage legend and no draw-cap notice for a small result", async () => {
    await render(host, root);
    expect(host.querySelector('[data-testid="production-gantt-legend"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="production-gantt-too-many"]')).toBeNull();
  });

  // Checklist tasks are always ranges (ADR 0011), so a task row never paints the milestone diamond;
  // the only diamond left is the inverted-Deadline Project one. This Project's Deadline sits BEFORE
  // its shoot date, so exactly one `gantt-milestone-marker` is painted, on the Project row.
  it("paints exactly one milestone diamond, on the inverted-Deadline Project row, and none on the task row", async () => {
    apiGetMock.mockImplementation((path: string) => (path.startsWith("/api/production-gantt") ? Promise.resolve(ganttResponse(isoDate(-3))) : Promise.reject(new Error(`unexpected fetch: ${path}`))));
    await render(host, root);

    const markers = host.querySelectorAll('[data-testid="gantt-milestone-marker"]');
    expect(markers.length).toBe(1);
    const projectBar = [...host.querySelectorAll<HTMLElement>("[data-gantt-resource] button")].find((b) => b.getAttribute("aria-label")?.includes(PROJECT_STREET));
    expect(projectBar).toBeDefined();
    expect(projectBar!.contains(markers[0]!)).toBe(true);
    const taskBar = [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")?.includes(TASK_TITLE));
    expect(taskBar).toBeDefined();
    expect(taskBar!.querySelector('[data-testid="gantt-milestone-marker"]')).toBeNull();
  });

  it("paints no milestone diamond when the Project's Deadline is not inverted", async () => {
    await render(host, root);
    findBarButton(host);
    expect(host.querySelectorAll('[data-testid="gantt-milestone-marker"]').length).toBe(0);
  });
});
