// happy-dom does not prove PointerSensor / TouchSensor / KeyboardSensor activation, real collision
// geometry, autoscroll, scroll containers, link-click suppression, screen-reader delivery, browser
// focus timing, or active-drag DragOverlay rendering; those are QA-phase real-browser acceptance
// items.
//
// This file is the `view=kanban2` Dashboard seam for #98: nothing else in the repo renders the
// Dashboard at `view=kanban2`, so every gap in #98 that is a Dashboard-level behaviour (not a
// standalone-Board behaviour covered by `kanban2/board.dom.test.tsx`) was unpinned until this file
// existed. Routing is read-only history (`lib/staff-history.ts`) — `useNavigate`/`<Link>` do
// nothing — so, like every other Dashboard DOM test, this sets the URL directly with
// `window.history.replaceState` before render and restores it afterward.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Dashboard } from "./Dashboard";
import { createDashboardBoardInvalidatedMessage, ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import { ConfirmModalHost } from "../components/ConfirmDialog";
import { ApiError } from "../lib/api";

// Captures the `DndContext` props the vendored ReUI Kanban renders, so a drop can be driven without
// a real pointer. Same technique as `Dashboard-stage-interactions.dom.test.tsx` and
// `components/kanban2/board.dom.test.tsx`; ReUI's Kanban resolves the move from its own internal
// state given only the active and over ids.
const dnd = vi.hoisted(() => ({ handlers: [] as Array<{ onDragEnd?: (event: unknown) => void; props?: Record<string, unknown> }> }));
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: Parameters<typeof actual.DndContext>[0]) => {
      dnd.handlers.push({ onDragEnd: props.onDragEnd as (event: unknown) => void, props: props as unknown as Record<string, unknown> });
      return createElement(actual.DndContext, props);
    },
  };
});

const apiGetMock = vi.fn<(path: string) => Promise<unknown>>();
const apiPostMock = vi.fn<(path: string, body: unknown) => Promise<unknown>>();
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiGet: (path: string) => apiGetMock(path), apiPost: (path: string, body: unknown) => apiPostMock(path, body) };
});
vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ role: "admin", capabilities: ["prioritizeProjects", "moveProjectStage", "adminBackend"], can: (capability: string) => capability === "prioritizeProjects" || capability === "moveProjectStage" || capability === "adminBackend" }),
}));
vi.mock("../lib/stages", () => ({
  useStages: () => ({
    stages: [
      { key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 0, active: true },
      { key: "raw_review", label: "RAW review", displayOrder: 1, active: true },
    ],
    presentationStageKey: (stageKey: string) => stageKey,
  }),
}));

let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function projectFixture(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, street: `${id} Street`, suburb: null, postcode: null, agencyName: null, agentName: null,
    stageKey: "awaiting_raw", shootDate: null, coverAssetId: null, receivedCount: 0, expectedCount: null,
    priority: null, boardPosition: 0, deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null,
    boardRevision: 0,
    ...overrides,
  };
}

describe("Dashboard at view=kanban2 (#98)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/?view=kanban2");
    dnd.handlers.length = 0;
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve({
      projects: [projectFixture("kb2-source")],
      board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["kb2-source"] } },
    }) : Promise.resolve({ stages: [] }));
    apiPostMock.mockReset().mockResolvedValue({ changed: true, project: { stageKey: "awaiting_raw", boardRevision: 1 } });
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
      },
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
    root = null;
    document.body.replaceChildren();
    window.history.replaceState(null, "", "/");
  });

  it("renders the new Board, not the old one, when the route requests view=kanban2", async () => {
    await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); });
    await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-column"]')).not.toBeNull());
    // Anti-vacuity anchor for the whole file: a Board that silently fell back to the old
    // implementation would still satisfy a bare "kanban2-column exists" check if that id ever
    // leaked onto the old Board, so this also asserts the old Board's own test id is absent.
    expect(document.querySelector('[data-testid="kanban-card"]')).toBeNull();
    expect(document.querySelector('[data-testid="kanban2-card-address"]')?.textContent).toBe("kb2-source Street");
  });

  // AC 7. The old Board's equivalent regression lives in `Dashboard-kanban-sort.dom.test.tsx` and
  // only ever proved a Priority control *exists*; it also renders the old Board, so it could never
  // have failed for this Board. These assert an actual write reaches the Priority endpoint.
  describe("Priority while the Board mutation flag is off", () => {
    function flagOffProjects() {
      apiGetMock.mockReset();
      apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve({
        projects: [projectFixture("kb2-flag-off", { priority: 1, boardMapPresent: true })],
        board: { contractEnabled: false, orderedProjectIdsByStage: { awaiting_raw: ["kb2-flag-off"] } },
      }) : Promise.resolve({ stages: [] }));
    }

    it("keeps Priority editable, and a commit reaches the Priority endpoint", async () => {
      flagOffProjects();
      await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); });
      await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-column"]')).not.toBeNull());

      const group = document.querySelector('[role="radiogroup"]');
      expect(group, "Priority is not editable with the Board mutation flag off — every assertion below would be vacuous").not.toBeNull();

      const third = [...group!.querySelectorAll<HTMLElement>('[role="radio"]')][2];
      expect(third, "fewer than three star targets rendered").not.toBeUndefined();
      await act(async () => { third!.click(); await Promise.resolve(); });

      // The write itself, not merely the presence of a control.
      expect(apiPostMock).toHaveBeenCalledWith("/api/projects/kb2-flag-off/priority", { priority: 3 });
    });

    // The missing-board-map case is NOT testable from this seam, and that is a finding, not a
    // gap: `lib/dashboard-projects.ts:48-50` derives `boardRank`, `boardMapPresent` and
    // `authorizedBoardOrder` from the payload's `orderedProjectIdsByStage`, and without that key
    // the Board does not render at all. So any Dashboard state in which this Board is on screen
    // already carries map evidence. The Board-level predicate is covered in
    // `components/kanban2/board.dom.test.tsx`, where props are passed directly.
  });

  // The confirmation round trip. Every cross-Stage move on real data answers `409`
  // `stage_confirmation_required` first (`workers/app/src/routes/projects.ts:1122`), so the
  // two-step confirm is the NORMAL path, not an edge case — a browser pass tripped over it
  // immediately. `Dashboard-stage-interactions.dom.test.tsx` proves it only at the default view
  // (old Board), and its Move-to trigger does not exist on this Board's card, so for this Board
  // the path was entirely unproven: the new Board could have dropped the confirmation and the
  // suite would have stayed green.
  describe("cross-Stage confirmation round trip", () => {
    function twoStageProjects() {
      apiGetMock.mockReset();
      apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve({
        projects: [
          projectFixture("kb2-source", { boardMapPresent: true }),
          projectFixture("kb2-target", { stageKey: "raw_review", boardPosition: 1, boardMapPresent: true }),
        ],
        board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["kb2-source"], raw_review: ["kb2-target"] } },
      }) : Promise.resolve({ stages: [] }));
    }

    it("holds the 409 at the confirm modal, then resubmits once carrying the confirmation reasons", async () => {
      twoStageProjects();
      apiPostMock.mockReset()
        .mockRejectedValueOnce(new ApiError("Confirmation required", 409, {
          code: "stage_confirmation_required",
          requiredConfirmation: { reasons: ["backward"] },
        }))
        .mockResolvedValueOnce({
          changed: true,
          project: { projectId: "kb2-source", stageKey: "raw_review", boardRevision: 1 },
          board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", orderedVisibleProjectIds: ["kb2-target", "kb2-source"] },
        });
      await act(async () => { root!.render(<><Dashboard currentUserId="admin-1" /><ConfirmModalHost /></>); await Promise.resolve(); await Promise.resolve(); });
      await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-column"]')).not.toBeNull());

      const handler = dnd.handlers.at(-1)?.onDragEnd;
      expect(handler, "no drag-end handler captured — the Board did not mount a DndContext").not.toBeUndefined();
      await act(async () => { handler!({ active: { id: "kb2-source" }, over: { id: "kb2-target" } }); await Promise.resolve(); });
      await vi.waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));

      expect(apiPostMock).toHaveBeenNthCalledWith(1, "/api/projects/kb2-source/stage", expect.objectContaining({ targetStageKey: "raw_review" }));
      // The first request must NOT pre-carry a confirmation: that would make the server's
      // gate unreachable from this Board.
      expect(apiPostMock.mock.calls[0]![1]).not.toHaveProperty("confirmation");

      const confirm = document.querySelector<HTMLButtonElement>('[data-testid="confirm-modal-confirm"]');
      expect(confirm, "the 409 did not open a confirm modal — the move was dropped or silently retried").not.toBeNull();
      await act(async () => { confirm!.click(); await Promise.resolve(); });
      await vi.waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(2));

      expect(apiPostMock).toHaveBeenNthCalledWith(2, "/api/projects/kb2-source/stage", expect.objectContaining({
        targetStageKey: "raw_review",
        confirmation: { reasons: ["backward"] },
      }));

      // #99: the card was dropped ON kb2-target, so it lands before it — and the confirmed retry must
      // resend that exact placement, not fall back to an append once the modal has intervened.
      const exact = { kind: "between", before: null, after: { projectId: "kb2-target", boardRevision: 0 } };
      expect(apiPostMock.mock.calls[0]![1]).toHaveProperty("placement", exact);
      expect(apiPostMock.mock.calls[1]![1]).toHaveProperty("placement", exact);
    });

    // #99 at the seam that reaches the server: a drop on a MIDDLE card resolves to both real
    // neighbours, so neither an append nor a "first" placement can satisfy it.
    it("sends the exact neighbours of a middle-card drop to /stage", async () => {
      apiGetMock.mockReset();
      apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve({
        projects: [
          projectFixture("kb2-source", { boardMapPresent: true }),
          projectFixture("kb2-t1", { stageKey: "raw_review", boardPosition: 1, boardRevision: 3, boardMapPresent: true }),
          projectFixture("kb2-t2", { stageKey: "raw_review", boardPosition: 2, boardRevision: 5, boardMapPresent: true }),
          projectFixture("kb2-t3", { stageKey: "raw_review", boardPosition: 3, boardRevision: 7, boardMapPresent: true }),
        ],
        board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["kb2-source"], raw_review: ["kb2-t1", "kb2-t2", "kb2-t3"] } },
      }) : Promise.resolve({ stages: [] }));
      apiPostMock.mockReset().mockReturnValue(new Promise(() => undefined));
      await act(async () => { root!.render(<><Dashboard currentUserId="admin-1" /><ConfirmModalHost /></>); await Promise.resolve(); await Promise.resolve(); });
      await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="kanban2-card-address"]')).toHaveLength(4));

      const handler = dnd.handlers.at(-1)?.onDragEnd;
      expect(handler, "no drag-end handler captured — the Board did not mount a DndContext").not.toBeUndefined();
      await act(async () => { handler!({ active: { id: "kb2-source" }, over: { id: "kb2-t2" } }); await Promise.resolve(); });
      await vi.waitFor(() => expect(apiPostMock, "the drop never reached the server — nothing below is proved").toHaveBeenCalledTimes(1));

      expect(apiPostMock).toHaveBeenCalledWith("/api/projects/kb2-source/stage", expect.objectContaining({
        targetStageKey: "raw_review",
        placement: { kind: "between", before: { projectId: "kb2-t1", boardRevision: 3 }, after: { projectId: "kb2-t2", boardRevision: 5 } },
      }));
    });
  });

  // #99. A same-column drop is a Board-position command, never a Stage command: it must reach
  // `/board-position` with exact neighbours and no confirmation — that branch forbids one.
  describe("same-column reordering", () => {
    it("sends an upward reorder to /board-position with exact neighbours and no confirmation", async () => {
      apiGetMock.mockReset();
      apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve({
        projects: [
          projectFixture("kb2-a", { boardPosition: 0, boardRevision: 2, boardMapPresent: true }),
          projectFixture("kb2-b", { boardPosition: 1, boardRevision: 4, boardMapPresent: true }),
          projectFixture("kb2-c", { boardPosition: 2, boardRevision: 6, boardMapPresent: true }),
        ],
        board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["kb2-a", "kb2-b", "kb2-c"] } },
      }) : Promise.resolve({ stages: [] }));
      apiPostMock.mockReset().mockReturnValue(new Promise(() => undefined));
      await act(async () => { root!.render(<><Dashboard currentUserId="admin-1" /><ConfirmModalHost /></>); await Promise.resolve(); await Promise.resolve(); });
      await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="kanban2-card-address"]')).toHaveLength(3));

      const handler = dnd.handlers.at(-1)?.onDragEnd;
      expect(handler, "no drag-end handler captured — the Board did not mount a DndContext").not.toBeUndefined();
      await act(async () => { handler!({ active: { id: "kb2-c" }, over: { id: "kb2-b" } }); await Promise.resolve(); });
      await vi.waitFor(() => expect(apiPostMock, "the reorder never reached the server — nothing below is proved").toHaveBeenCalledTimes(1));

      const [path, body] = apiPostMock.mock.calls[0]!;
      expect(path).toBe("/api/projects/kb2-c/board-position");
      expect(body).toHaveProperty("placement", { kind: "between", before: { projectId: "kb2-a", boardRevision: 2 }, after: { projectId: "kb2-b", boardRevision: 4 } });
      expect(body).not.toHaveProperty("confirmation");
    });

    // The arrows reach the same `/board-position` orchestrator as a drag, one slot at a time, and the
    // focus comes back to the arrow that was pressed.
    it("sends an up-arrow press to /board-position one slot up, and refocuses that arrow", async () => {
      apiGetMock.mockReset();
      apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve({
        projects: [
          projectFixture("kb2-a", { boardPosition: 0, boardRevision: 2, boardMapPresent: true }),
          projectFixture("kb2-b", { boardPosition: 1, boardRevision: 4, boardMapPresent: true }),
          projectFixture("kb2-c", { boardPosition: 2, boardRevision: 6, boardMapPresent: true }),
        ],
        board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["kb2-a", "kb2-b", "kb2-c"] } },
      }) : Promise.resolve({ stages: [] }));
      apiPostMock.mockReset().mockResolvedValue({
        changed: true,
        project: { projectId: "kb2-c", stageKey: "awaiting_raw", boardRevision: 7 },
        board: { sourceStageKey: "awaiting_raw", targetStageKey: "awaiting_raw", orderedVisibleProjectIds: ["kb2-a", "kb2-c", "kb2-b"] },
      });
      await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); });
      await vi.waitFor(() => expect(document.querySelector('[data-focus-key="arrow-up:kb2-c"]'), "no up arrow rendered — nothing below is proved").not.toBeNull());

      await act(async () => { document.querySelector<HTMLButtonElement>('[data-focus-key="arrow-up:kb2-c"]')!.click(); await Promise.resolve(); });
      await vi.waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));

      const [path, body] = apiPostMock.mock.calls[0]!;
      expect(path).toBe("/api/projects/kb2-c/board-position");
      expect(body).toHaveProperty("placement", { kind: "between", before: { projectId: "kb2-a", boardRevision: 2 }, after: { projectId: "kb2-b", boardRevision: 4 } });
      expect(body).not.toHaveProperty("confirmation");
      await vi.waitFor(() => expect(document.activeElement?.getAttribute("data-focus-key")).toBe("arrow-up:kb2-c"));
    });
  });

  // #99's non-drag path at the seam that reaches the server. The chooser does no confirming of its
  // own: a cross-Stage submit must go through the same 409 modal round trip as a drop.
  describe("Move-to chooser", () => {
    const twoStages = () => ({
      projects: [
        projectFixture("kb2-source", { boardMapPresent: true }),
        projectFixture("kb2-target", { stageKey: "raw_review", boardPosition: 1, boardRevision: 5, boardMapPresent: true }),
      ],
      board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["kb2-source"], raw_review: ["kb2-target"] } },
    });
    const click = async (element: HTMLElement | null | undefined, what: string) => {
      if (!element) throw new Error(`Missing ${what}`);
      await act(async () => { element.click(); await Promise.resolve(); });
    };
    // Literal selectors only (test-seam guard B), so one finder per role rather than a shared one.
    const radio = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((node) => node.textContent?.startsWith(text));
    const option = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) => node.textContent?.startsWith(text));
    const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.startsWith(text));
    const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    async function chooseBeforeTarget() {
      await click(document.querySelector<HTMLButtonElement>('[data-focus-key="move-to:kb2-source"]'), "Move-to trigger");
      await click(radio("RAW review"), "RAW review Stage");
      await click(option("Before kb2-target Street"), "Before kb2-target position");
    }

    it("sends the chosen position, confirms through the 409 modal, and gives the trigger back", async () => {
      apiGetMock.mockReset();
      apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve(twoStages()) : Promise.resolve({ stages: [] }));
      apiPostMock.mockReset()
        .mockRejectedValueOnce(new ApiError("Confirmation required", 409, { code: "stage_confirmation_required", requiredConfirmation: { reasons: ["backward"] } }))
        .mockResolvedValueOnce({
          changed: true,
          project: { projectId: "kb2-source", stageKey: "raw_review", boardRevision: 1 },
          board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", orderedVisibleProjectIds: ["kb2-source", "kb2-target"] },
        });
      await act(async () => { root!.render(<><Dashboard currentUserId="admin-1" /><ConfirmModalHost /></>); await Promise.resolve(); await Promise.resolve(); });
      await vi.waitFor(() => expect(document.querySelector('[data-focus-key="move-to:kb2-source"]')).not.toBeNull());

      await chooseBeforeTarget();
      await click(document.querySelector('[data-testid="kanban2-move-to-submit"]'), "submit");
      await vi.waitFor(() => expect(apiPostMock, "the Move-to submit never reached the server").toHaveBeenCalledTimes(1));

      const exact = { kind: "between", before: null, after: { projectId: "kb2-target", boardRevision: 5 } };
      expect(apiPostMock.mock.calls[0]![0]).toBe("/api/projects/kb2-source/stage");
      expect(apiPostMock.mock.calls[0]![1]).toHaveProperty("placement", exact);
      expect(apiPostMock.mock.calls[0]![1]).not.toHaveProperty("confirmation");

      await click(document.querySelector('[data-testid="confirm-modal-confirm"]'), "confirm modal — the 409 was dropped or silently retried");
      await vi.waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(2));
      expect(apiPostMock.mock.calls[1]![1]).toEqual(expect.objectContaining({ placement: exact, confirmation: { reasons: ["backward"] } }));

      await flush(); await flush();
      await vi.waitFor(() => expect(document.activeElement?.getAttribute("data-focus-key")).toBe("move-to:kb2-source"));
    });

    // Ported from the default-view scenario in `Dashboard-stage-interactions.dom.test.tsx`: the chosen
    // neighbour disappears between choosing and submitting, so the move must abort locally — no
    // request, no guess at a new position — refetch once, and hand the trigger back.
    it("aborts a stale position locally, refetches, and restores its trigger", async () => {
      let projectFetches = 0;
      const stale = { ...twoStages(), projects: [projectFixture("kb2-source", { boardMapPresent: true })], board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["kb2-source"] } } };
      apiGetMock.mockReset();
      apiGetMock.mockImplementation((path) => path === "/api/projects"
        ? Promise.resolve(projectFetches++ === 0 ? twoStages() : stale)
        : Promise.resolve({ stages: [] }));
      apiPostMock.mockReset();
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const runtime = new ProjectQueryRuntime(queryClient, "kanban2-move-to-stale-test");
      await act(async () => {
        root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><Dashboard currentUserId="admin-1" /></QueryClientProvider></ProjectQueryRuntimeProvider>);
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(document.querySelector('[data-focus-key="move-to:kb2-source"]')).not.toBeNull());

      await chooseBeforeTarget();
      runtime.markProjectRemoved("kb2-target");
      await flush();
      await click(document.querySelector('[data-testid="kanban2-move-to-submit"]'), "submit");
      await flush(); await flush();

      expect(apiPostMock).not.toHaveBeenCalled();
      expect(document.querySelector('[data-testid="dashboard-live-region"]')?.textContent).toContain("That position changed");
      expect(projectFetches).toBe(2);
      expect(document.activeElement?.getAttribute("data-focus-key")).toBe("move-to:kb2-source");
      runtime.dispose();
      queryClient.clear();
    });
  });

  // AC 1 / §2.2. Publishing `data-focus-key="board"` on this Board makes the Dashboard's tier-3
  // restore reachable here for the first time — and tier 3 fires after ANY refresh that was not tied
  // to a Board control, including the one a Priority write queues itself. Without the key-less guard
  // in `Dashboard.tsx`, adding the focus identifiers above would rip focus off the star row on every
  // Priority change. The two changes are one unit; neither ships alone.
  //
  // The equivalent old-Board assertion cannot carry this claim: `ProjectKanbanBoard.tsx:575` folds
  // `!pendingOrdering.has(id)` into `canPrioritize`, so the old Board unmounts its own Priority
  // control mid-write and focus is destroyed before any restore runs. This Board deliberately does
  // not (pass 1), so the restore tiers are the only thing that can move focus here.
  describe("focus identifiers", () => {
    it("publishes the three restore tiers the Dashboard looks for", async () => {
      await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); });
      await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-column"]')).not.toBeNull());

      const boardRoot = document.querySelector<HTMLElement>('[data-focus-key="board"]');
      expect(boardRoot, "tier 3 target missing — every focus restore on this Board is a silent no-op").not.toBeNull();
      // Without tabIndex the element is not focusable and tier 3 does nothing, which is the exact
      // failure this key is meant to end.
      expect(boardRoot!.getAttribute("tabindex")).toBe("-1");

      const heading = document.querySelector<HTMLElement>('[data-focus-key="stage-heading:awaiting_raw"]');
      expect(heading, "tier 2 target missing for the semantic Stage key").not.toBeNull();
      expect(heading!.getAttribute("tabindex")).toBe("-1");

      expect(document.querySelector('[data-focus-key="move-handle:kb2-source"]'), "tier 1 target missing on the card handle").not.toBeNull();
    });

    it("leaves focus on the Priority control after its own write refreshes the Board", async () => {
      await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); });
      await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-column"]')).not.toBeNull());
      // Anchor: tier 3 must be reachable, or this test would pass because there was nothing to
      // steal focus to.
      expect(document.querySelector('[data-focus-key="board"]'), "no tier-3 target — the steal could not be observed").not.toBeNull();

      const third = [...document.querySelectorAll<HTMLElement>('[role="radio"]')][2];
      expect(third, "fewer than three star targets rendered").not.toBeUndefined();
      third!.focus();
      expect(document.activeElement).toBe(third);

      await act(async () => { third!.click(); await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(apiPostMock).toHaveBeenCalledWith("/api/projects/kb2-source/priority", { priority: 3 });

      expect(document.contains(third!), "the Priority control was unmounted mid-write — focus cannot survive that").toBe(true);
      expect(
        document.activeElement === third!,
        `focus moved to ${document.activeElement?.getAttribute("data-focus-key") ?? document.activeElement?.tagName} after the Priority write`,
      ).toBe(true);
    });
  });

  // AC 9 / AC 10. Deliberately NOT a source-text guard: a baseline-free grep for `preventScroll`
  // merged after the code it governs has already turned this repo's main red once. This spies on
  // `focus` while still performing the real focus, so the tier-1 assertions above keep working in
  // the same file, and it fails today because the option is `undefined`.
  //
  // `scrollLeft` itself is unobservable in happy-dom. The evidence for the *mechanism* is the live
  // browser measurement (#98 probe rounds 3/4: focus-induced scroll to 0, fully suppressed by
  // `preventScroll: true`); this test is the evidence for the *call*.
  it("restores focus without letting it scroll the Board (#98 AC 9)", async () => {
    const realFocus = HTMLElement.prototype.focus;
    const calls: Array<{ element: HTMLElement; options: unknown }> = [];
    const spy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      calls.push({ element: this, options });
      realFocus.call(this, options);
    });
    try {
      apiGetMock.mockReset();
      apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve({
        projects: [
          projectFixture("kb2-source", { boardMapPresent: true }),
          projectFixture("kb2-target", { stageKey: "raw_review", boardPosition: 1, boardMapPresent: true }),
        ],
        board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["kb2-source"], raw_review: ["kb2-target"] } },
      }) : Promise.resolve({ stages: [] }));
      apiPostMock.mockReset().mockResolvedValue({
        changed: true,
        project: { projectId: "kb2-source", stageKey: "raw_review", boardRevision: 1 },
        board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", orderedVisibleProjectIds: ["kb2-target", "kb2-source"] },
      });
      await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); });
      await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-column"]')).not.toBeNull());

      const handle = document.querySelector<HTMLElement>('[data-focus-key="move-handle:kb2-source"]');
      expect(handle, "no handle to restore to — the assertion below would be vacuous").not.toBeNull();
      handle!.focus();
      calls.length = 0;

      // A committed cross-Stage move: the Dashboard captures the handle descriptor and restores it.
      const handler = dnd.handlers.at(-1)?.onDragEnd;
      expect(handler).not.toBeUndefined();
      await act(async () => { handler!({ active: { id: "kb2-source" }, over: { id: "kb2-target" } }); await Promise.resolve(); });
      await vi.waitFor(() => expect(apiPostMock).toHaveBeenCalled());
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(calls.length, "nothing called focus during the restore").toBeGreaterThan(0);
      for (const call of calls) {
        expect(
          (call.options as FocusOptions | undefined)?.preventScroll,
          `focus() on ${call.element.getAttribute("data-focus-key") ?? call.element.tagName} omitted preventScroll, so it can scroll the Board`,
        ).toBe(true);
      }
    } finally {
      spy.mockRestore();
    }
  });

  // AC 6 at the Dashboard seam: the new Board arms the Dashboard's refresh barrier and — the part
  // that actually breaks — releases it.
  //
  // Scope of this test, stated precisely because it is narrower than it first looks. The deferral
  // LOGIC lives in the Dashboard and is shared by both Boards; the old Board already pins it
  // ("defers a cross-tab Board invalidation during drag…" in
  // `Dashboard-stage-interactions.dom.test.tsx`). What is new for this Board is that it publishes the
  // lifecycle at all, which `components/kanban2/board.dom.test.tsx` pins directly. So what this adds
  // is the end-to-end consequence: a cross-tab invalidation mid-drag still FETCHES (the barrier
  // blocks acceptance, not fetching), and once the drag ends the queued refresh runs and the Board
  // converges instead of latching forever.
  //
  // It deliberately does NOT assert that fresh data is withheld from the screen mid-drag. Three
  // attempts at that assertion (a window `focus` event, a `setQueryData` push, and this cross-tab
  // refetch) all passed with the barrier disarmed, so none of them could prove the hold at this seam;
  // asserting it anyway would have been a vacuous test of the kind this repo has already shipped
  // twice. The latch assertion below IS load-bearing: removing the lifecycle clear turns it red.
  it("arms the Dashboard refresh barrier and releases it without latching (#98 AC 6)", async () => {
    class FakeChannel {
      static channels: FakeChannel[] = [];
      readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
      constructor(readonly name: string) { FakeChannel.channels.push(this); }
      addEventListener(_type: string, listener: (event: MessageEvent<unknown>) => void) { this.listeners.add(listener); }
      postMessage(data: unknown) { for (const channel of FakeChannel.channels.filter((item) => item.name === this.name)) for (const listener of channel.listeners) listener({ data } as MessageEvent<unknown>); }
      close() { FakeChannel.channels = FakeChannel.channels.filter((item) => item !== this); this.listeners.clear(); }
    }
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    let reads = 0;
    apiGetMock.mockReset();
    apiGetMock.mockImplementation((path) => {
      if (path !== "/api/projects") return Promise.resolve({ stages: [] });
      reads += 1;
      return Promise.resolve({
        projects: [{ ...projectFixture("kb2-source", { boardMapPresent: true }), street: reads === 1 ? "kb2-source Street" : "Fresh Street" }],
        board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["kb2-source"] } },
      });
    });
    const dragClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const dragRuntime = new ProjectQueryRuntime(dragClient, "kanban2-drag-tab");
    const otherClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const otherRuntime = new ProjectQueryRuntime(otherClient, "kanban2-other-tab");
    dragRuntime.start(); otherRuntime.start();
    try {
      await act(async () => {
        root!.render(
          <ProjectQueryRuntimeProvider runtime={dragRuntime}>
            <QueryClientProvider client={dragClient}><Dashboard currentUserId="admin-1" /></QueryClientProvider>
          </ProjectQueryRuntimeProvider>,
        );
        await Promise.resolve();
      });
      await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-column"]')).not.toBeNull());
      expect(reads).toBe(1);

      const onDragStart = dnd.handlers.at(-1)?.props?.onDragStart as ((event: unknown) => void) | undefined;
      expect(onDragStart, "the Board published no onDragStart — the barrier can never arm").not.toBeUndefined();
      await act(async () => { onDragStart!({ active: { id: "kb2-source" } }); await Promise.resolve(); });

      await act(async () => { otherRuntime.publish(createDashboardBoardInvalidatedMessage()); await Promise.resolve(); });
      // The fetch is deliberately NOT blocked by the barrier.
      await vi.waitFor(() => expect(reads).toBeGreaterThan(1));

      const onDragCancel = dnd.handlers.at(-1)?.props?.onDragCancel as ((event: unknown) => void) | undefined;
      await act(async () => { onDragCancel!({ active: { id: "kb2-source" } }); await Promise.resolve(); await Promise.resolve(); });
      // And it must not latch.
      await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-card-address"]')?.textContent).toBe("Fresh Street"));
    } finally {
      dragRuntime.dispose(); otherRuntime.dispose(); dragClient.clear(); otherClient.clear();
      vi.unstubAllGlobals();
    }
  });

  // #99 AC (added by the owner): a successful move must be announced exactly ONCE. The Dashboard has
  // two polite live regions on screen at the same time — its own (`dashboard-live-region`) and the
  // toast viewport — and the move-commit path writes to both, so a screen reader heard the same event
  // twice. It is not a new-Board defect: `onMoveStage` is shared by both Boards, which is why it was
  // left out of #98 rather than smuggled into a Board-parity PR.
  //
  // The fix is a subtraction, and the toast stays on SCREEN: suppressed toasts are `aria-hidden`, not
  // unrendered. Both halves are asserted here, because "fixed it by deleting the toast" would
  // otherwise pass.
  describe("announce a successful move exactly once (#99)", () => {
    function twoStages() {
      apiGetMock.mockReset();
      apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve({
        projects: [
          projectFixture("kb2-source", { boardMapPresent: true }),
          projectFixture("kb2-target", { stageKey: "raw_review", boardPosition: 1, boardMapPresent: true }),
        ],
        board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["kb2-source"], raw_review: ["kb2-target"] } },
      }) : Promise.resolve({ stages: [] }));
    }

    it("speaks the move in the Dashboard region and keeps the toast visible but silent", async () => {
      twoStages();
      // Resolves 200 on the first call, so this is the settled-success path with no confirm modal.
      apiPostMock.mockReset().mockResolvedValue({
        changed: true,
        project: { projectId: "kb2-source", stageKey: "raw_review", boardRevision: 1 },
        board: { sourceStageKey: "awaiting_raw", targetStageKey: "raw_review", orderedVisibleProjectIds: ["kb2-target", "kb2-source"] },
      });
      await act(async () => { root!.render(<><Dashboard currentUserId="admin-1" /><ConfirmModalHost /></>); await Promise.resolve(); await Promise.resolve(); });
      await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-column"]')).not.toBeNull());

      const handler = dnd.handlers.at(-1)?.onDragEnd;
      expect(handler, "no drag-end handler captured — the Board did not mount a DndContext").not.toBeUndefined();
      await act(async () => { handler!({ active: { id: "kb2-source" }, over: { id: "kb2-target" } }); await Promise.resolve(); });
      await vi.waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      // Anchor: if the move did not actually succeed there is no success toast to be silent, and every
      // assertion below would pass vacuously.
      const toast = await vi.waitFor(() => {
        const found = [...document.querySelectorAll<HTMLElement>('[data-testid="dashboard-toast"]')]
          .find((node) => node.textContent?.includes("Moved to"));
        expect(found, "no success toast rendered — the move did not settle, so nothing here is proved").not.toBeUndefined();
        return found!;
      });

      expect(document.querySelector('[data-testid="dashboard-live-region"]')?.textContent)
        .toContain("Moved kb2-source Street to");

      // The toast is still on screen for sighted users...
      expect(document.contains(toast)).toBe(true);
      // ...and out of the accessibility tree, so the toast viewport's live region has nothing new to
      // announce. An aria-hidden subtree mutating inside a live region produces no announcement.
      expect(
        toast.getAttribute("aria-hidden"),
        "the success toast is still in the accessibility tree, so this event is announced twice",
      ).toBe("true");
    });

    // Sol review: a silenced toast must not carry information the live region lacks. The priority
    // failure used to speak a generic line while its now-silent toast showed the specific reason.
    it("speaks the same specific reason a silenced error toast shows", async () => {
      apiGetMock.mockReset();
      apiGetMock.mockImplementation((path) => path === "/api/projects" ? Promise.resolve({
        projects: [projectFixture("kb2-prio", { priority: 1, boardMapPresent: true })],
        board: { contractEnabled: true, orderedProjectIdsByStage: { awaiting_raw: ["kb2-prio"] } },
      }) : Promise.resolve({ stages: [] }));
      apiPostMock.mockReset().mockRejectedValue(new Error("Priority is locked for this project."));
      await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); });
      await vi.waitFor(() => expect(document.querySelector('[role="radiogroup"]'), "no Priority control rendered").not.toBeNull());

      const third = [...document.querySelectorAll<HTMLElement>('[role="radiogroup"] [role="radio"]')][2];
      await act(async () => { third!.click(); await Promise.resolve(); });
      const toast = await vi.waitFor(() => {
        const found = [...document.querySelectorAll<HTMLElement>('[data-testid="dashboard-toast"]')].find((node) => node.textContent?.includes("Priority is locked"));
        expect(found, "anchor: the failure toast never rendered").not.toBeUndefined();
        return found!;
      });
      expect(toast.getAttribute("aria-hidden")).toBe("true");
      expect(document.querySelector('[data-testid="dashboard-live-region"]')?.textContent).toContain("Priority is locked for this project.");
    });

    // The opt-out is per toast, NOT a removal of the viewport's `aria-live`: every Dashboard toast
    // happens to pair with an announcement today, so dropping the attribute would look green while
    // silently making any future unpaired toast unannounceable. This pins the capability rather than
    // an observed behaviour, and says so.
    it("leaves the toast viewport live for toasts that are not announced elsewhere", async () => {
      await act(async () => { root!.render(<Dashboard currentUserId="admin-1" />); await Promise.resolve(); await Promise.resolve(); });
      await vi.waitFor(() => expect(document.querySelector('[data-testid="kanban2-column"]')).not.toBeNull());
      expect(document.querySelector('[data-testid="dashboard-toast-viewport"]')?.getAttribute("aria-live")).toBe("polite");
    });
  });
});
