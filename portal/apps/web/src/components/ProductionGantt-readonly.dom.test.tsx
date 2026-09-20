/**
 * #220 pass B, build spec S6 — proves the read-only boundary in a real render, not just by
 * inspecting props: `Space` on a focused project bar must not open Adjust mode, and no bar may
 * render a resize grip. `gantt-bar-adjust-keyboard.dom.test.tsx` and
 * `gantt-bar-resize-grips.dom.test.tsx` already prove the VENDOR's own `readOnly`/`interactions`
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

// `ProductionGantt` defaults its visible `date` state to `new Date()` (today, whenever the test
// actually runs) with no way for a caller to override it — so the fixture's shoot/deadline dates
// must be anchored to "today", not a fixed date, or the bar falls outside the initially-visible
// month and never renders.
const TODAY = new Date();
function isoDate(daysFromToday: number): string {
  const date = new Date(TODAY);
  date.setDate(date.getDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}
const SHOOT_DATE = isoDate(0);
const DEADLINE_DATE = isoDate(5);

function ganttResponse() {
  return adminProductionGanttResponseSchema.parse({
    scope: "active",
    zone: PRODUCTION_GANTT_ZONE,
    appliedFilters: { q: "", editorIds: [], stageKeys: [], includeDelivered: false, includeCompletedChecklist: false },
    projects: [
      {
        id: PROJECT_ID,
        street: PROJECT_STREET,
        suburb: null,
        agencyName: null,
        agentName: null,
        stageKey: "editing_autohdr",
        delivered: false,
        shootDate: SHOOT_DATE,
        shootDateCivil: SHOOT_DATE,
        createdAt: SHOOT_DATE + "T00:00:00.000Z",
        barStartDate: SHOOT_DATE,
        deadline: { at: `${DEADLINE_DATE}T05:00:00.000Z`, localCivil: `${DEADLINE_DATE}T15:00`, version: 1, reminderOffsetsMinutes: [], overdue: false },
        deadlineVersion: 1,
        editors: [],
        checklist: { completed: 0, total: 1 },
        permissions: { canEditDeadline: true, canEditChildren: true },
        children: {
          rows: [
            {
              id: TASK_ID,
              projectId: PROJECT_ID,
              title: TASK_TITLE,
              done: false,
              position: 0,
              assignee: null,
              schedule: {
                state: "due_only",
                version: 1,
                zone: PRODUCTION_GANTT_ZONE,
                start: null,
                end: { kind: "date", localCivil: isoDate(2), instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" },
                due: isoDate(2),
              },
              permissions: { canDrag: true, canResize: true, canOpenScheduleEditor: true, canScheduleRange: true },
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
        <ProductionGantt identity={identity} q="" />
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

  // Proves `renderGanttEventContent` (see that function's own header comment in
  // `ProductionGantt.tsx`) actually paints the milestone diamond in a real render: a `due_only`
  // child task shows exactly one `gantt-milestone-marker`, and it is on the task's own bar, not
  // the project's ranged bar (which must fall through to the vendor's stock `defaultContent`
  // instead, per that same header's `undefined`-fallthrough contract).
  it("paints exactly one milestone diamond, on the due-only task row and not the project's range bar", async () => {
    await render(host, root);
    findBarButton(host); // sanity: the project's own range bar still rendered

    // A milestone bar is `labelOutside` (this file's own header comment on `defaultContent`'s
    // fallthrough): the vendor paints its title in a SIBLING span positioned `after` the button,
    // not inside it, so `textContent` (used for the project's own ranged bar above) can't find it
    // here — `aria-label` (`gantt-bar.tsx`'s own accessible name, which always includes the title
    // regardless of where the visible label paints) is the reliable seam for a milestone bar.
    const taskBar = [...host.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label")?.includes(TASK_TITLE));
    if (!taskBar) throw new Error(`no bar button found for "${TASK_TITLE}"`);

    const markers = host.querySelectorAll('[data-testid="gantt-milestone-marker"]');
    expect(markers.length).toBe(1);
    expect(taskBar.contains(markers[0]!)).toBe(true);
  });
});
