/**
 * #734 - the Production Gantt's breakpoints, at the four widths that matter: 720 / 721 / 1023 / 1024.
 * `namesOnly` (< 1024px) is the names-only task list: no People/Due columns, no zoom buttons (Ctrl/Cmd-wheel
 * and pinch still zoom), the attention badge on the name cell, the add-task bottom sheet. `phone` (<= 720px) only
 * picks the 44px row metric; a coarse pointer picks it at every width (#695). happy-dom has no layout, so
 * this pins which branch renders; how it paints is the browser pass.
 *
 * Guard F (`test-seam.guard.test.ts`): everything is found by `data-testid`, accessible name or text.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { adminProductionGanttResponseSchema, PRODUCTION_GANTT_ZONE, type GanttProjectRowDto } from "@quincy/shared";
import type { DashboardIdentity } from "../lib/dashboard-projects";
import { DEFAULT_GANTT_FACET_FILTERS } from "../lib/production-gantt-filters";
import { clearToasts } from "../lib/toast-store";
import { ProductionGantt } from "./ProductionGantt";
import { startMoment, endMoment, subtaskReminders } from "@/testing/subtask-schedule";
import { mockViewport, type MockViewport } from "@/testing/viewport";

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
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

const PROJECT = "11111111-1111-4111-8111-111111111111";
const STREET = "1 Alpha Street";
const isoDate = (days: number) => { const date = new Date(); date.setDate(date.getDate() + days); return date.toISOString().slice(0, 10); };

function project(): GanttProjectRowDto {
  const row = {
    id: "22222222-2222-4222-8222-000000000001", projectId: PROJECT, title: "Row one", done: false, position: 0, assignees: [], otherAssigneeCount: 0, assignmentVersion: 1,
    schedule: { state: "range" as const, version: 1, zone: PRODUCTION_GANTT_ZONE, start: startMoment(isoDate(2)), end: endMoment(isoDate(3)), due: isoDate(3) },
    reminders: subtaskReminders(), permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canEditAssignees: true },
  };
  return {
    id: PROJECT, street: STREET, suburb: null, agencyName: null, agentName: null, stageKey: "editing_autohdr", delivered: false, archived: false,
    shootDate: isoDate(0), shootDateCivil: isoDate(0), createdAt: `${isoDate(0)}T00:00:00.000Z`, barStartDate: isoDate(0),
    // no deadline: the attention reason is "missing_deadline", which an admin's Due cell shows as an action on a wide layout
    deadline: null, deadlineVersion: 1, editors: [], checklist: { completed: 0, total: 1 },
    permissions: { canEditDeadline: true, canEditChildren: true },
    children: { rows: [row], total: 1, returned: 1, truncated: false, nextCursor: null },
  };
}

const identity: DashboardIdentity = { principalId: "user-1", role: "admin", authorizationEpoch: 0 };
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
let viewport: MockViewport | null = null;

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

async function mountAt(width: number, coarse = false) {
  viewport = mockViewport({ width, coarse });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ProductionGantt identity={identity} q="" filters={DEFAULT_GANTT_FACET_FILTERS} onFiltersChange={() => {}} projectHrefFor={(id) => `/projects/${id}`} onOpenProject={() => {}} />
      </QueryClientProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await settle();
}

beforeEach(() => {
  apiGetMock.mockReset().mockImplementation(() => Promise.resolve(adminProductionGanttResponseSchema.parse({
    scope: "active", zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], priorities: [], archived: "hide", includeDelivered: false, includeCompletedChecklist: false },
    projects: [project()],
    page: { limit: 100, returned: 1, nextCursor: null },
    density: { matchedProjects: 1, matchedRows: 1, drawCap: 2000, tooManyToDraw: false },
  })));
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
  viewport?.restore();
  viewport = null;
});

const has = (testId: string) => host.querySelector(`[data-testid="${testId}"]`) !== null;
const columnsShown = () => host.textContent!.includes("People") && host.textContent!.includes("Due");
const zoomShown = () => has("gantt-zoom");
const rowHeights = () => new Set(Array.from(host.querySelectorAll<HTMLElement>("[data-gantt-row-id]")).map((el) => el.style.height).filter(Boolean));
const plus = () => host.querySelector<HTMLButtonElement>(`button[aria-label="Add task in ${STREET}"]`)!;
const sheet = () => document.querySelector('[data-testid="gantt-group-create-task-sheet"]');
const editorRow = () => host.querySelector('[data-testid="gantt-group-create-task-row"]');

describe("ProductionGantt breakpoints (#734)", () => {
  describe.each([
    { width: 720, narrow: true, rows: "2.75rem" },
    { width: 721, narrow: true, rows: "2.5rem" },
    { width: 1023, narrow: true, rows: "2.5rem" },
    { width: 1024, narrow: false, rows: "2.5rem" },
  ])("at $width px (fine pointer)", ({ width, narrow, rows }) => {
    it(`columns, zoom control and row height: ${narrow ? "names only, no zoom buttons" : "full layout"}, ${rows} rows`, async () => {
      await mountAt(width);
      expect(columnsShown()).toBe(!narrow);
      expect(zoomShown()).toBe(!narrow);
      expect([...rowHeights()]).toEqual([rows]);
      // the Project link is how a names-only layout reaches People and Due
      expect(has("gantt-project-link")).toBe(true);
    });

    it(`attention badge ${narrow ? "stays on the name cell (the Due cell is gone)" : "moves to the Due cell"}`, async () => {
      await mountAt(width);
      expect(has("gantt-row-attention-missing_deadline")).toBe(narrow);
      if (narrow) {
        const cls = document.querySelector<HTMLElement>('[data-testid="gantt-row-attention-missing_deadline"]')!.className;
        expect(cls).toContain("min-[1024px]:shrink-0"); // shrinkable in the 288px names-only cell
        expect(cls).not.toContain("min-[721px]:shrink-0");
      }
    });

    it(`the add-task editor is ${narrow ? "a bottom sheet" : "an inline row"}`, async () => {
      await mountAt(width);
      await act(async () => { plus().click(); await Promise.resolve(); });
      await settle();
      expect(sheet() !== null).toBe(narrow);
      // #734: on the dialog ladder from 721px (560px, centred); a phone stays full-bleed.
      if (narrow) expect(sheet()!.className).toContain("min-[721px]:max-w-[560px]");
      if (narrow) expect(sheet()!.className).toContain("min-[721px]:rounded-t-[var(--radius-lg)]");
      expect(editorRow() !== null).toBe(!narrow);
    });
  });

  it("a coarse pointer gets 44px rows at 800px too, and still the sheet (the metric follows the pointer, not the width)", async () => {
    await mountAt(800, true);
    expect([...rowHeights()]).toEqual(["2.75rem"]);
    expect(columnsShown()).toBe(false);
    expect(zoomShown()).toBe(false);
  });

  it("crossing 1024 swaps the layout in place, in both directions, and keeps an open draft title", async () => {
    await mountAt(1280);
    expect(columnsShown()).toBe(true);
    await act(async () => { plus().click(); await Promise.resolve(); });
    await settle();
    const title = () => document.querySelector<HTMLInputElement>('input[aria-label^="New task title in"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title(), "Keep me");
      title().dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    await viewport!.set({ width: 900 });
    await settle();
    expect(columnsShown()).toBe(false);
    expect(zoomShown()).toBe(false);
    expect(sheet()).not.toBeNull();
    expect(title().value).toBe("Keep me");
    await viewport!.set({ width: 1100 });
    await settle();
    expect(columnsShown()).toBe(true);
    expect(zoomShown()).toBe(true);
    expect(editorRow()).not.toBeNull();
    expect(title().value).toBe("Keep me");
  });
});
