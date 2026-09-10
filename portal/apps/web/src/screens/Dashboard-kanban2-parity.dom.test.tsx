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
import { Dashboard } from "./Dashboard";
import { ConfirmModalHost } from "../components/ConfirmDialog";
import { ApiError } from "../lib/api";

// Captures the `DndContext` props the vendored ReUI Kanban renders, so a drop can be driven without
// a real pointer. Same technique as `Dashboard-stage-interactions.dom.test.tsx` and
// `components/kanban2/board.dom.test.tsx`; ReUI's Kanban resolves the move from its own internal
// state given only the active and over ids.
const dnd = vi.hoisted(() => ({ handlers: [] as Array<{ onDragEnd?: (event: unknown) => void }> }));
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: Parameters<typeof actual.DndContext>[0]) => {
      dnd.handlers.push({ onDragEnd: props.onDragEnd as (event: unknown) => void });
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
});
