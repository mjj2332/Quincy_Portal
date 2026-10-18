/**
 * #734 - the Production Gantt's breakpoints, at the four widths that matter: 720 / 721 / 1023 / 1024.
 * `namesOnly` (< 1024px) is the names-only task list: no People/Due columns, no zoom buttons (Ctrl/Cmd-wheel
 * and pinch still zoom), the attention badge on the name cell, the add-task bottom sheet. `phone` (<= 720px) only
 * picks the 44px row metric; a coarse pointer picks it at every width (#695). happy-dom has no layout, so
 * this pins which branch renders; how it paints is the browser pass.
 *
 * #921 (frame 3c): at <= 720px the Timeline is the phone view. The vendor's inline placement draws no tree column;
 * each row's label (name + meta) sits above its bar, every row is the same height, there is no add-task affordance,
 * and the Stage key collapses to a 44px "Key" button that opens a Drawer. 721 keeps the names-only side tree.
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
import { resetUiPrefMemory } from "../lib/ui-prefs";
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
  // #920's Colour by choice is a remembered UI pref; every test starts at the default (Stage).
  try { localStorage.clear(); } catch { /* storage blocked: memory only */ }
  resetUiPrefMemory();
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
// #738: the buttons render into the nav row's zoom slot, no longer a floating box in the lane.
const zoomShown = () => host.querySelector('[data-testid="gantt-nav-zoom"] [data-testid="gantt-zoom"]') !== null;
const rowHeights = () => new Set(Array.from(host.querySelectorAll<HTMLElement>("[data-gantt-row-id]")).map((el) => el.style.height).filter(Boolean));
const plus = () => host.querySelector<HTMLButtonElement>(`button[aria-label="Add task in ${STREET}"]`)!;
const sheet = () => document.querySelector('[data-testid="gantt-group-create-task-sheet"]');
const editorRow = () => host.querySelector('[data-testid="gantt-group-create-task-row"]');

describe("ProductionGantt breakpoints (#734)", () => {
  describe.each([
    { width: 721, narrow: true, rows: "2.5rem" },
    { width: 1023, narrow: true, rows: "2.5rem" },
    { width: 1024, narrow: false, rows: "2.5rem" },
  ])("at $width px (fine pointer)", ({ width, narrow, rows }) => {
    it(`columns, zoom control and row height: ${narrow ? "names only, no zoom buttons" : "full layout"}, ${rows} rows`, async () => {
      await mountAt(width);
      expect(columnsShown()).toBe(!narrow);
      expect(zoomShown()).toBe(!narrow);
      // #919: a Project row is 48px (frame 3a); the Subtask rows take the pointer's floor.
      expect([...rowHeights()]).toEqual(["3rem", rows]);
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
    expect([...rowHeights()]).toEqual(["3rem", "2.75rem"]);
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

describe("ProductionGantt phone view (#921, frame 3c)", () => {
  const inlineLabels = () => Array.from(host.querySelectorAll<HTMLElement>('[data-testid="gantt-inline-label"]'));
  const keyButton = () => host.querySelector<HTMLButtonElement>('[data-testid="production-gantt-key-button"]');
  const keyDrawer = () => document.querySelector<HTMLElement>('[data-testid="production-gantt-key-drawer"]');
  const inlineKeyRow = () => host.querySelector('[data-testid="production-gantt-key"] [data-testid="stage-key-row"]');

  describe.each([{ coarse: false }, { coarse: true }])("at 720px (coarse pointer: $coarse)", ({ coarse }) => {
    it("draws no tree column; each row's label sits above its bar, and every row is one height", async () => {
      await mountAt(720, coarse);
      expect(has("gantt-tree-column")).toBe(false);
      const labels = inlineLabels();
      expect(labels).toHaveLength(2);
      expect(labels[0]!.textContent).toContain(STREET);
      expect(labels[1]!.textContent).toContain("Row one");
      // The task's meta line: its due day (frame 3c `.pm`).
      expect(labels[1]!.querySelector('[data-testid="gantt-phone-meta"]')!.textContent).toMatch(/^Due (today|\w{3} \d{1,2})$/);
      // The Project has no Deadline: its label still carries the reason (no Due cell on a phone).
      expect(labels[0]!.querySelector('[data-testid="gantt-row-attention-missing_deadline"]')).not.toBeNull();
      expect(labels[0]!.querySelector('[data-testid="gantt-project-link"]')).not.toBeNull();
      const taskRow = labels[1]!.closest<HTMLElement>("[data-gantt-row-id]")!;
      const bar = [...taskRow.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")?.includes("Row one"));
      expect(bar).toBeDefined();
      expect(labels[1]!.compareDocumentPosition(bar!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // 6px padding, a 26px label, 6px, a 28px bar, 6px: 72px, the frame's row.
      expect([...rowHeights()]).toEqual(["4.5rem"]);
      // No People/Due columns: they live in the tree column, which is gone (the meta's "Due" and #920's hidden nav
      // switch's "People" make the text check meaningless here).
      expect(zoomShown()).toBe(false);
    });

    it("offers no add-task affordance (view-only)", async () => {
      await mountAt(720, coarse);
      expect(host.querySelector(`button[aria-label="Add task in ${STREET}"]`)).toBeNull();
      expect(sheet()).toBeNull();
      expect(editorRow()).toBeNull();
    });

    it("the Stage key is a 44px Key button that opens a Drawer holding the key row and the symbols", async () => {
      await mountAt(720, coarse);
      expect(inlineKeyRow()).toBeNull();
      // #916 design review (should-fix 5, nit 3): the Key button sits in the nav row beside Today and the arrows; the
      // key band (its own row between two hairlines) is gone on a phone.
      expect(has("production-gantt-key")).toBe(false);
      const button = keyButton()!;
      expect(button).not.toBeNull();
      expect(button.closest('[data-testid="production-gantt-nav"]')).not.toBeNull();
      expect(button.textContent).toContain("Key");
      expect(button.className).toContain("h-11");
      expect(button.getAttribute("aria-haspopup")).toBe("dialog");
      expect(keyDrawer()).toBeNull();
      await act(async () => { button.click(); await Promise.resolve(); });
      await settle();
      const drawer = keyDrawer()!;
      expect(drawer).not.toBeNull();
      expect(drawer.querySelector('[data-testid="stage-key-row"]')).not.toBeNull();
      expect(drawer.querySelector('[data-testid="gantt-key-same-day"]')).not.toBeNull();
      // #920's Colour by switch lives in the drawer (D7); choosing People swaps the drawer's key row in place.
      const people = drawer.querySelector<HTMLElement>('[data-testid="timeline-colour-by-people"]')!;
      expect(people).not.toBeNull();
      await act(async () => { people.click(); await Promise.resolve(); });
      await settle();
      expect(keyDrawer()!.querySelector('[data-testid="people-key-row"]')).not.toBeNull();
      expect(keyDrawer()!.querySelector('[data-testid="stage-key-row"]')).toBeNull();
    });
  });

  it("at 721px the side tree, the inline key row and the add-task affordance are back, and there is no Key button", async () => {
    await mountAt(721);
    expect(has("gantt-tree-column")).toBe(true);
    expect(inlineLabels()).toHaveLength(0);
    expect(inlineKeyRow()).not.toBeNull();
    expect(has("production-gantt-key")).toBe(true);
    expect(keyButton()).toBeNull();
    expect(plus()).not.toBeNull();
  });

  it("crossing 720 swaps between the phone view and the side tree in place", async () => {
    await mountAt(1024);
    expect(inlineLabels()).toHaveLength(0);
    await viewport!.set({ width: 390 });
    await settle();
    expect(has("gantt-tree-column")).toBe(false);
    expect(inlineLabels()).toHaveLength(2);
    expect(keyButton()).not.toBeNull();
    await viewport!.set({ width: 768 });
    await settle();
    expect(has("gantt-tree-column")).toBe(true);
    expect(keyButton()).toBeNull();
  });
});
