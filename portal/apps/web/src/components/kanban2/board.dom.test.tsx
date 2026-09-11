// happy-dom cannot exercise real PointerSensor/KeyboardSensor drag activation — see
// `ProjectKanbanBoard.dom.test.tsx`'s header. This test drives the captured `DndContext`
// `onDragEnd` handler directly, the same technique the existing Board's test suite uses.
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DragEndEvent } from "@dnd-kit/core";
import { ProjectKanbanBoard2 } from "./board";
import { KanbanCard2 } from "./card";
import type { ProjectKanbanBoardProps, ProjectSummary } from "../../lib/kanban-interaction";
import type { PipelineStage } from "../../lib/stages";

const dnd = vi.hoisted(() => ({
  // The whole props object, not just `onDragEnd`: #98 asserts the `accessibility` contract the Board
  // hands dnd-kit, which is only observable here.
  handlers: [] as Array<{ onDragEnd?: (event: unknown) => void; props?: Record<string, unknown> }>,
}));

const dragOverlay = vi.hoisted(() => ({
  props: [] as Array<{ dropAnimation?: unknown }>,
}));

vi.mock("../../lib/stages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/stages")>();
  return {
    ...actual,
    useStages: () => ({
      stages: [
        { key: "awaiting_raw" as const, label: "Awaiting RAW", displayOrder: 1, active: true },
        { key: "raw_review" as const, label: "RAW review", displayOrder: 2, active: true },
      ],
      presentationStageKey: (key: string) => key,
    }),
  };
});

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: Parameters<typeof actual.DndContext>[0]) => {
      dnd.handlers.push({ onDragEnd: props.onDragEnd as (event: unknown) => void, props: props as unknown as Record<string, unknown> });
      return createElement(actual.DndContext, props);
    },
    // `KanbanOverlay` creates its own `<DragOverlay>` element deep inside its own render function
    // (behind a `createPortal`), so it is not a literal sibling of `<DndContext>` in the element
    // tree the way the old Board's is — intercepting the component itself is the only way to
    // capture the actual `dropAnimation` prop it renders with, regardless of drag state.
    DragOverlay: (props: Parameters<typeof actual.DragOverlay>[0]) => {
      dragOverlay.props.push({ dropAnimation: props.dropAnimation });
      return createElement(actual.DragOverlay, props);
    },
  };
});

const stages: readonly PipelineStage[] = [
  { key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1, active: true },
  { key: "raw_review", label: "RAW review", displayOrder: 2, active: true },
];

function project(id: string, stageKey: ProjectSummary["stageKey"], overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id,
    street: `${id} Street`,
    suburb: null,
    postcode: null,
    agencyName: null,
    agentName: null,
    stageKey,
    shootDate: null,
    coverAssetId: null,
    receivedCount: 0,
    expectedCount: null,
    priority: null,
    boardRevision: 1,
    deadlineAt: null,
    deadlineLocalCivil: null,
    deadlineZone: null,
    // The Dashboard derives these from the payload's `orderedProjectIdsByStage` for every project
    // it hands either Board (`lib/dashboard-projects.ts:48-50`), so a fixture without them is not a
    // state the app can reach. Priority eligibility reads them (#98); the missing-map case below
    // strips them deliberately.
    boardMapPresent: true,
    boardRank: 0,
    ...overrides,
  };
}

function baseProps(overrides: Partial<ProjectKanbanBoardProps> = {}): ProjectKanbanBoardProps {
  return {
    projects: [project("source", "awaiting_raw"), project("other", "raw_review")],
    activeStages: stages,
    canMoveStages: true,
    canPrioritize: false,
    boardMutationEnabled: true,
    movementDisabled: false,
    effectiveKanbanSort: "board",
    pendingMoves: new Set(),
    pendingOrdering: new Set(),
    terminal: false,
    onBoardMove: vi.fn(),
    onBoardPosition: vi.fn(),
    onPriorityChange: vi.fn(),
    onMoveStage: vi.fn(),
    onAnnounce: vi.fn(),
    onInteractionStateChange: vi.fn(),
    ...overrides,
  };
}

let host: HTMLElement;
let root: Root;

async function renderBoard(overrides: Partial<ProjectKanbanBoardProps> = {}) {
  const props = baseProps(overrides);
  const { act } = await import("react");
  await act(async () => { root.render(createElement(ProjectKanbanBoard2, props)); await Promise.resolve(); });
  return props;
}

async function endDrag(activeId: string, overId: string) {
  const { act } = await import("react");
  const handler = dnd.handlers.at(-1)?.onDragEnd;
  if (!handler) throw new Error("No drag-end handler captured");
  const event = { active: { id: activeId }, over: { id: overId } } as unknown as DragEndEvent;
  await act(async () => { handler(event); await Promise.resolve(); });
}

type CapturedAnnouncements = {
  onDragStart: (arg: unknown) => string | undefined;
  onDragOver: (arg: unknown) => string | undefined;
  onDragEnd: (arg: unknown) => string | undefined;
  onDragCancel: (arg: unknown) => string | undefined;
};

/** The `accessibility.announcements` the Board handed dnd-kit; throws rather than silently passing. */
function capturedAnnouncements(): CapturedAnnouncements {
  const accessibility = dnd.handlers.at(-1)?.props?.accessibility as { announcements?: CapturedAnnouncements } | undefined;
  const announcements = accessibility?.announcements;
  if (!announcements) throw new Error("No accessibility.announcements reached DndContext");
  return announcements;
}

async function fireDnd(name: "onDragStart" | "onDragOver" | "onDragCancel" | "onDragEnd", event: unknown) {
  const { act } = await import("react");
  const handler = dnd.handlers.at(-1)?.props?.[name] as ((event: unknown) => void) | undefined;
  if (!handler) throw new Error(`No ${name} handler captured`);
  await act(async () => { handler(event); await Promise.resolve(); });
}

function mockMatchMedia(reducedMotion: boolean) {
  const originalMatchMedia = window.matchMedia;
  const matchMedia = vi.fn(() => ({
    matches: reducedMotion,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  Object.defineProperty(window, "matchMedia", { configurable: true, value: matchMedia });
  return () => Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
}

describe("ProjectKanbanBoard2 (#80)", () => {
  beforeEach(() => {
    dnd.handlers.length = 0;
    dragOverlay.props.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    const { act } = await import("react");
    await act(async () => root.unmount());
    host.remove();
  });

  it("renders one column per active Stage, in the given order and labelled, with cards showing street", async () => {
    await renderBoard();
    const columns = host.querySelectorAll('[data-testid="kanban2-column"]');
    expect(columns).toHaveLength(2);
    expect(columns[0]?.textContent).toContain("Awaiting RAW");
    expect(columns[1]?.textContent).toContain("RAW review");
    expect(host.querySelector('[data-testid="kanban2-card-address"]')?.textContent).toBe("source Street");
  });

  it("renders the Admin ghost star row on an unset Project, reaching the coordinator on commit (#81)", async () => {
    const props = await renderBoard({ canPrioritize: true });
    const cardGroup = host.querySelector('[role="radiogroup"]');
    expect(cardGroup?.getAttribute("aria-label")).toBe("Priority for source Street");

    const first = host.querySelector('[role="radio"][aria-label="1 star"]') as HTMLElement;
    const { act } = await import("react");
    first.focus();
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    // Arrow traversal must not reach the coordinator — see PriorityStars' header comment.
    expect(props.onPriorityChange).not.toHaveBeenCalled();
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(props.onPriorityChange).toHaveBeenCalledTimes(1);
    const [project, value] = (props.onPriorityChange as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(project.id).toBe("source");
    expect(value).toBe(2);
  });

  it("gives a non-Admin no priority control, and no ghost row where none is set (#81)", async () => {
    await renderBoard({ canPrioritize: false });
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    expect(host.querySelector('[data-testid="kanban2-card-priority"]')).toBeNull();
    // Anchored: the card really did render, so the nulls above mean "no control", not "no card".
    expect(host.querySelector('[data-testid="kanban2-card-address"]')?.textContent).toBe("source Street");
  });

  // Asserts the BEHAVIOUR #81 fixed (01f9c21), not the shape of the vendor's tree.
  //
  // dnd-kit defaults a draggable/sortable role to "button" (`core.esm.js:3385`). `KanbanItem` used to
  // spread those attributes on the card WRAPPER, and under ARIA 1.2 children-presentational a
  // role="button" ancestor prunes a nested radiogroup out of the accessibility tree entirely —
  // so every star control on the Board was invisible to screen readers. #81 moved `attributes`
  // onto `KanbanItemHandle`.
  //
  // The previous version of this test reached for `.closest('[data-slot="kanban-item"]')` — the
  // vendor's own hook, which `test-seam.guard` guard F now rejects — and then fell back to
  // `parentElement` and optional-chained the result, so a lookup that found nothing asserted
  // `expect(undefined).not.toBe("button")` and passed. It could not fail for the defect it names.
  // Every query below is anchored non-null first, so this one can.
  it("puts the dnd-kit drag attributes on the handle, never on the card wrapper (#81)", async () => {
    await renderBoard({ canPrioritize: true });

    const handle = host.querySelector('[data-testid="kanban2-card-handle"]');
    expect(handle, "no drag handle rendered — every assertion below would be vacuous").not.toBeNull();
    expect(handle!.getAttribute("aria-roledescription")).toBe("sortable");

    const wrap = host.querySelector('[data-testid="kanban2-card-wrap"]');
    expect(wrap, "no card wrapper rendered — the assertions below would be vacuous").not.toBeNull();
    expect(wrap!.getAttribute("role")).not.toBe("button");
    expect(wrap!.getAttribute("aria-roledescription")).toBeNull();

    // The point of the whole exercise: no role="button" ancestor anywhere above the radiogroup.
    expect(host.querySelector('[role="radiogroup"]'), "no radiogroup rendered").not.toBeNull();
    expect(host.querySelector('[role="button"] [role="radiogroup"]')).toBeNull();
  });

  it("moves a card to a different column's Stage on drop", async () => {
    const props = await renderBoard();
    await endDrag("source", "raw_review");
    expect(props.onBoardMove).toHaveBeenCalledTimes(1);
    const [projectId, gap, kind] = (props.onBoardMove as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(projectId).toBe("source");
    expect(gap).toEqual({ targetStageKey: "raw_review", successor: "end" });
    expect(kind).toBe("cross");
  });

  // #99: a drop lands where it was released, not appended. Three targets, so the middle one is a
  // card that is neither first nor last — an "append" or "first" shortcut cannot pass this.
  describe("exact cross-Stage placement (#99)", () => {
    const threeTargets = () => [project("source", "awaiting_raw"), project("t1", "raw_review"), project("t2", "raw_review"), project("t3", "raw_review")];

    it("lands a card dropped on a middle card before that card", async () => {
      const props = await renderBoard({ projects: threeTargets() });
      await endDrag("source", "t2");
      expect(props.onBoardMove, "the drop was rejected — the gap below is never produced").toHaveBeenCalledTimes(1);
      expect((props.onBoardMove as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual({ targetStageKey: "raw_review", successor: "t2" });
    });

    it("lands a card dropped on the column itself at the end", async () => {
      const props = await renderBoard({ projects: threeTargets() });
      await endDrag("source", "raw_review");
      expect(props.onBoardMove).toHaveBeenCalledTimes(1);
      expect((props.onBoardMove as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual({ targetStageKey: "raw_review", successor: "end" });
    });

    // The hover copy must describe the gap the drop would commit, card by card — de-duplicating by
    // container (the #98 behaviour) would swallow the second card's position entirely.
    it("narrates each card-relative position in a Stage, once each", async () => {
      await renderBoard({ projects: threeTargets() });
      const { onDragOver } = capturedAnnouncements();
      const over = (id: string) => ({ active: { id: "source" }, over: { id } });
      expect(onDragOver(over("t1"))).toBe("source Street is over RAW review, position 1 of 4.");
      expect(onDragOver(over("t2"))).toBe("source Street is over RAW review, position 2 of 4.");
      // A stationary hover repeats the event; the live region must not re-read it.
      expect(onDragOver(over("t2"))).toBeUndefined();
      expect(onDragOver(over("raw_review"))).toBe("source Street is over the end of RAW review, position 4 of 4.");
    });

    // The drop indicator. These fire the DndContext's own `onDragOver` — the vendored primitive's
    // handler — so they also pin the `reui/kanban.tsx` pass-through: upstream returns before any
    // consumer hook whenever `onMove` is set, and with that early return the indicator never draws.
    describe("drop indicator", () => {
      const indicators = () => [...host.querySelectorAll<HTMLElement>('[data-testid="kanban2-drop-indicator"]')];
      const hover = (overId: string) => fireDnd("onDragOver", { active: { id: "source" }, over: { id: overId } });

      it("marks the gap before a hovered middle card, and nowhere else", async () => {
        await renderBoard({ projects: threeTargets() });
        await fireDnd("onDragStart", { active: { id: "source" } });
        await hover("t2");
        expect(indicators(), "no indicator drawn — the hover never reached the Board").toHaveLength(1);
        // It sits in t2's item, ahead of t2's card — the gap between t1 and t2.
        const item = indicators()[0]!.parentElement!;
        expect(item.textContent).toContain("t2 Street");
        expect(item.firstElementChild).toBe(indicators()[0]);
      });

      it("marks the end of a hovered column, after its last card", async () => {
        await renderBoard({ projects: threeTargets() });
        await hover("raw_review");
        expect(indicators()).toHaveLength(1);
        expect(indicators()[0]!.previousElementSibling?.textContent).toContain("t3 Street");
        expect(indicators()[0]!.nextElementSibling).toBeNull();
      });

      // happy-dom has no layout, so this pins the classes that take the indicator out of flow. An
      // in-flow indicator shifts the cards, and with the primitive's `MeasuringStrategy.Always` that
      // moves the collision target and flip-flops. The real geometry is a browser-pass claim.
      it("is out of flow, inert and hidden from assistive technology", async () => {
        await renderBoard({ projects: threeTargets() });
        await hover("t1");
        const indicator = indicators()[0];
        expect(indicator, "no indicator drawn — nothing below is proved").not.toBeUndefined();
        expect(indicator!.className.split(" ")).toEqual(expect.arrayContaining(["absolute", "pointer-events-none"]));
        expect(indicator!.getAttribute("aria-hidden")).toBe("true");
        expect(indicator!.parentElement!.className.split(" ")).toContain("relative");
      });

      it("offers no gap in the card's own Stage, which still rejects a drop", async () => {
        await renderBoard({ projects: [...threeTargets(), project("sibling", "awaiting_raw")] });
        await hover("t1");
        expect(indicators(), "anchor: a cross-Stage hover draws one").toHaveLength(1);
        await hover("sibling");
        expect(indicators()).toHaveLength(0);
      });

      it("clears on drop and on cancel", async () => {
        await renderBoard({ projects: threeTargets() });
        await hover("t2");
        expect(indicators(), "anchor").toHaveLength(1);
        await fireDnd("onDragEnd", { active: { id: "source" }, over: null });
        expect(indicators()).toHaveLength(0);

        await hover("t2");
        expect(indicators(), "anchor").toHaveLength(1);
        await fireDnd("onDragCancel", { active: { id: "source" } });
        expect(indicators()).toHaveLength(0);
      });
    });
  });

  it("does not move a card dropped back onto its own column", async () => {
    const props = await renderBoard();
    await endDrag("source", "awaiting_raw");
    expect(props.onBoardMove).not.toHaveBeenCalled();
  });

  it("does not move a card when Stage moves are disallowed", async () => {
    const props = await renderBoard({ canMoveStages: false });
    await endDrag("source", "raw_review");
    expect(props.onBoardMove).not.toHaveBeenCalled();
  });

  it("does not move a card the caller marked pending", async () => {
    const props = await renderBoard({ pendingMoves: new Set(["source"]) });
    await endDrag("source", "raw_review");
    expect(props.onBoardMove).not.toHaveBeenCalled();
  });

  it("locks movement for every card while ANY move or ordering write is in flight, not just the dragged one (#98)", async () => {
    // "other" has a pending ordering write, not "source" — the old check ("only the dragged
    // card") would leave source's own handle enabled and its own drag-end reaching onBoardMove.
    const props = await renderBoard({ pendingOrdering: new Set(["other"]) });
    const handle = host.querySelector<HTMLButtonElement>('[data-testid="kanban2-card-handle"]');
    expect(handle, "no drag handle rendered — the assertion below would be vacuous").not.toBeNull();
    expect(handle!.disabled).toBe(true);
    await endDrag("source", "raw_review");
    expect(props.onBoardMove).not.toHaveBeenCalled();
  });

  it("offers editable Priority with the Board mutation flag off, but not without board-map evidence (#98)", async () => {
    // Priority must NOT depend on `boardMutationEnabled` — that is the movement flag. This is the
    // regression #98 names, and this is the only seam that can express the second half: the
    // Dashboard always supplies map evidence whenever this Board is on screen
    // (`lib/dashboard-projects.ts:48-50`), so a missing-map Dashboard state does not exist.
    await renderBoard({ boardMutationEnabled: false, canPrioritize: true });
    expect(host.querySelector('[role="radiogroup"]'), "Priority is gated on the movement flag again").not.toBeNull();

    // Same props, map evidence stripped from every project: read-only stars, no radiogroup.
    await renderBoard({
      boardMutationEnabled: false,
      canPrioritize: true,
      projects: [project("source", "awaiting_raw", { boardMapPresent: undefined, boardRank: undefined, priority: 2 })],
    });
    expect(host.querySelector('[data-testid="kanban2-card-address"]'), "no card rendered — the assertion below would be vacuous").not.toBeNull();
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    expect(host.querySelector('[data-testid="kanban2-card-priority"] [role="img"]')).not.toBeNull();
  });

  it("keeps every column at full opacity — the vendor renders every disabled column at 50% (#98)", async () => {
    await renderBoard();
    const column = host.querySelector('[data-testid="kanban2-column"]');
    expect(column, "no column rendered — the assertion below would be vacuous").not.toBeNull();
    expect(column!.className).toContain("opacity-100");
    // Not merely present alongside the vendor's `opacity-50` — actually dedup'd out by
    // tailwind-merge, which runs in JS at render time, before either ever reaches the DOM.
    expect(column!.className).not.toContain("opacity-50");
  });

  it("keeps a card at full opacity while it is disabled by the pending-write lock, not just while it isn't dragging (#98)", async () => {
    await renderBoard({ pendingOrdering: new Set(["source"]) });
    const cardWrap = host.querySelector('[data-testid="kanban2-card-wrap"]');
    expect(cardWrap, "no card wrapper rendered — the assertion below would be vacuous").not.toBeNull();
    const item = cardWrap!.parentElement;
    expect(item, "no KanbanItem wrapper found — the assertion below would be vacuous").not.toBeNull();
    expect(item!.getAttribute("data-disabled")).toBe("true");
    expect(item!.className).toContain("data-[disabled=true]:opacity-100");
  });

  // `KanbanOverlay`'s content only actually mounts under a real drag, which happy-dom's sensors
  // cannot produce (see this file's header) — so instead of driving the whole drag pipeline, this
  // renders `KanbanCard2` directly with `isOverlay`, exactly the way `board.tsx`'s
  // `<KanbanOverlay>` render-prop does, and separately proves the real card is unaffected.
  it("the drag overlay preview carries no interactive element, while the real card keeps its link and controls (#98)", async () => {
    const summary = project("source", "awaiting_raw");
    const overlayHost = document.createElement("div");
    document.body.appendChild(overlayHost);
    const overlayRoot = createRoot(overlayHost);
    const { act } = await import("react");
    await act(async () => { overlayRoot.render(createElement(KanbanCard2, { project: summary, isOverlay: true })); await Promise.resolve(); });

    // Positive anchor first: the overlay preview really renders the card's content, so the
    // absence assertions below cannot pass by the overlay having failed to render at all.
    const overlayAddress = overlayHost.querySelector('[data-testid="kanban2-card-address"]');
    expect(overlayAddress, "no overlay content rendered — the assertions below would be vacuous").not.toBeNull();
    expect(overlayAddress!.textContent).toBe("source Street");
    expect(overlayHost.querySelector('[data-testid="kanban2-card-overlay"]')).not.toBeNull();

    expect(overlayHost.querySelector("a")).toBeNull();
    expect(overlayHost.querySelector("button")).toBeNull();
    expect(overlayHost.querySelector('[role="radiogroup"]')).toBeNull();
    expect(overlayHost.querySelector('input, select, textarea, [contenteditable="true"]')).toBeNull();
    expect(overlayHost.querySelector('[tabindex]:not([tabindex="-1"])')).toBeNull();

    await act(async () => { overlayRoot.unmount(); await Promise.resolve(); });
    overlayHost.remove();

    // The real (non-overlay) card still has its actual navigable link and its drag handle — the
    // overlay fix must not have taken interactivity away from the card that produced it.
    await renderBoard({ canPrioritize: true });
    const realLink = host.querySelector('[data-testid="kanban2-card"]');
    expect(realLink, "no real card link rendered — the anti-vacuity anchor for the real card").not.toBeNull();
    expect(realLink!.tagName).toBe("A");
    expect(host.querySelector('[data-testid="kanban2-card-handle"]')).not.toBeNull();
  });

  it("suppresses the drag overlay's drop animation for reduced-motion users (#98)", async () => {
    const restoreMatchMedia = mockMatchMedia(true);
    try {
      await renderBoard();
      const captured = dragOverlay.props.at(-1);
      expect(captured, "no DragOverlay props captured — the assertion below would be vacuous").not.toBeUndefined();
      expect(captured!.dropAnimation).toBeNull();
    } finally {
      restoreMatchMedia();
    }
  });

  it("does not suppress the drag overlay's drop animation for everyone else (#98)", async () => {
    const restoreMatchMedia = mockMatchMedia(false);
    try {
      await renderBoard();
      const captured = dragOverlay.props.at(-1);
      expect(captured, "no DragOverlay props captured — the assertion below would be vacuous").not.toBeUndefined();
      // Neither `null` (that's what stops the test passing for a Board that always disables
      // animation) nor `undefined` — passing an explicit `dropAnimation={undefined}` on this
      // branch is the exact trap: it still silently overrides the vendor's own default config
      // with dnd-kit's raw built-in one, via the spread inside `KanbanOverlay`. The value itself
      // is the vendor's own default config object, opaque to this test; only its
      // defined-and-non-null-ness is our contract.
      expect(captured!.dropAnimation).not.toBeNull();
      expect(captured!.dropAnimation).not.toBeUndefined();
    } finally {
      restoreMatchMedia();
    }
  });
});

describe("KanbanCard2 — Editor avatars, Deadline and RAW counts (#82)", () => {
  beforeEach(() => {
    dnd.handlers.length = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    const { act } = await import("react");
    await act(async () => root.unmount());
    host.remove();
  });

  async function renderCard(overrides: Partial<ProjectSummary> = {}) {
    return renderBoard({ projects: [project("source", "awaiting_raw", overrides)] });
  }

  it("renders the Deadline in the studio civil time, with the ISO epoch on dateTime", async () => {
    // A day in the future — not overdue — so this asserts the "Due" rendering path, not the
    // "Overdue" one (covered separately below).
    const deadlineAt = Date.now() + 24 * 60 * 60 * 1000;
    await renderCard({ deadlineAt, deadlineLocalCivil: "2999-01-01T09:15", deadlineZone: "Australia/Sydney" });
    expect(host.querySelector('[data-testid="kanban2-card-address"]')).not.toBeNull();
    const time = host.querySelector('[data-testid="kanban2-card-deadline"]')!;
    expect(time.textContent).toBe("Due 2999-01-01 09:15 Sydney");
    expect(time.getAttribute("dateTime")).toBe(new Date(deadlineAt).toISOString());
  });

  it("shows the studio's Sydney civil time even for a viewer in a different timezone", async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      // No `deadlineLocalCivil` from the server — exercises the `formatSydneyCivil(deadlineAt)`
      // fallback, the path most at risk of drifting to the viewer's host timezone.
      const deadlineAt = Date.parse("2026-08-26T23:15:00.000Z"); // a fixed instant, so the
      // expected Sydney civil string below is deterministic regardless of when this test runs.
      await renderCard({ deadlineAt, deadlineLocalCivil: null, deadlineZone: "Australia/Sydney" });
      const time = host.querySelector('[data-testid="kanban2-card-deadline"]')!;
      expect(time.textContent).toBe("Overdue 2026-08-27 09:15 Sydney");
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it("renders the literal word 'Overdue' and the critical colour token for an overdue deadline", async () => {
    const deadlineAt = Date.now() - 60 * 60 * 1000;
    await renderCard({ deadlineAt, deadlineLocalCivil: "2020-01-01T00:00", deadlineZone: "Australia/Sydney" });
    expect(host.querySelector('[data-testid="kanban2-card-address"]')).not.toBeNull();
    const time = host.querySelector('[data-testid="kanban2-card-deadline"]')!;
    expect(time.textContent).toContain("Overdue");
    expect(time.className).toContain("text-[var(--signal-critical)]");
  });

  it("renders 'Due', not 'Overdue', for a future deadline", async () => {
    const deadlineAt = Date.now() + 60 * 60 * 1000;
    await renderCard({ deadlineAt, deadlineLocalCivil: "2999-01-01T00:00", deadlineZone: "Australia/Sydney" });
    const time = host.querySelector('[data-testid="kanban2-card-deadline"]')!;
    expect(time.textContent).toContain("Due");
    expect(time.textContent).not.toContain("Overdue");
    expect(time.className).not.toContain("text-[var(--signal-critical)]");
  });

  it("renders no Deadline element at all when the Project has none", async () => {
    await renderCard({ deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null });
    expect(host.querySelector('[data-testid="kanban2-card-address"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="kanban2-card-deadline"]')).toBeNull();
  });

  it("renders '12/40' with a spoken 'of' form when both counts are known", async () => {
    await renderCard({ receivedCount: 12, expectedCount: 40 });
    expect(host.querySelector('[data-testid="kanban2-card-address"]')).not.toBeNull();
    const raw = host.querySelector('[data-testid="kanban2-card-raw"]')!;
    expect(raw.querySelector('[aria-hidden="true"]')?.textContent).toBe("12/40");
    // The spoken counterpart is the visible span's next sibling — structural access, not a class
    // selector (guard: `components/testing/test-seam.guard.test.ts` bans `.sr-only` as a query).
    expect(raw.lastElementChild?.textContent).toBe("12 of 40 RAW files received");
  });

  it("renders the received count alone with an 'unknown' spoken form when expected is null", async () => {
    await renderCard({ receivedCount: 12, expectedCount: null });
    const raw = host.querySelector('[data-testid="kanban2-card-raw"]')!;
    expect(raw.querySelector('[aria-hidden="true"]')?.textContent).toBe("12");
    expect(raw.lastElementChild?.textContent).toBe("12 RAW files received, expected count unknown");
  });

  it("renders '0/0' when both received and expected are zero — expectedCount: 0 is meaningful, not falsy", async () => {
    await renderCard({ receivedCount: 0, expectedCount: 0 });
    const raw = host.querySelector('[data-testid="kanban2-card-raw"]')!;
    expect(raw.querySelector('[aria-hidden="true"]')?.textContent).toBe("0/0");
    expect(raw.lastElementChild?.textContent).toBe("0 of 0 RAW files received");
  });

  it("renders three Editor avatars and no overflow indicator for exactly three Editors", async () => {
    const editors = [{ id: "e1", name: "Jane Doe" }, { id: "e2", name: "Ana Maria Lopes" }, { id: "e3", name: "Sam Lee" }];
    await renderCard({ editors });
    expect(host.querySelector('[data-testid="kanban2-card-address"]')).not.toBeNull();
    const meta = host.querySelector('[data-testid="kanban2-card-meta"]')!;
    const avatars = meta.querySelectorAll('[role="img"]');
    expect(avatars).toHaveLength(3);
    for (const editor of editors) {
      expect(meta.querySelector(`[role="img"][aria-label="${editor.name}"]`)).not.toBeNull();
    }
    expect(meta.querySelector('[aria-label*="more Editor"]')).toBeNull();
  });

  it("renders three Editor avatars plus a '+2' overflow named '2 more Editors' for five Editors", async () => {
    const editors = [
      { id: "e1", name: "Jane Doe" },
      { id: "e2", name: "Ana Maria Lopes" },
      { id: "e3", name: "Sam Lee" },
      { id: "e4", name: "Kim Park" },
      { id: "e5", name: "Lee Nguyen" },
    ];
    await renderCard({ editors });
    const meta = host.querySelector('[data-testid="kanban2-card-meta"]')!;
    // No `data-slot` selector (that's the vendor's own hook, not ours) — the overflow indicator is
    // distinguished by its accessible name instead.
    const allImgs = [...meta.querySelectorAll('[role="img"]')];
    const shown = allImgs.filter((element) => !(element.getAttribute("aria-label") ?? "").includes("more Editor"));
    expect(shown).toHaveLength(3);
    const overflow = meta.querySelector('[role="img"][aria-label="2 more Editors"]')!;
    expect(overflow).not.toBeNull();
    expect(overflow.querySelector('[aria-hidden="true"]')?.textContent).toBe("+2");
  });

  it("renders no overflow indicator for a single Editor", async () => {
    await renderCard({ editors: [{ id: "e1", name: "Jane Doe" }] });
    const meta = host.querySelector('[data-testid="kanban2-card-meta"]')!;
    expect(meta.querySelectorAll('[role="img"]')).toHaveLength(1);
    expect(meta.querySelector('[aria-label*="more Editor"]')).toBeNull();
  });

  it("renders the empty avatar slot, named 'No Editor assigned', for an empty Editors array", async () => {
    await renderCard({ editors: [] });
    const meta = host.querySelector('[data-testid="kanban2-card-meta"]')!;
    const slot = meta.querySelector('[role="img"][aria-label="No Editor assigned"]');
    expect(slot).not.toBeNull();
    expect(meta.querySelectorAll('[role="img"]')).toHaveLength(1);
  });

  it("renders the empty avatar slot, named 'No Editor assigned', when Editors is absent", async () => {
    await renderCard({ editors: undefined });
    const meta = host.querySelector('[data-testid="kanban2-card-meta"]')!;
    const slot = meta.querySelector('[role="img"][aria-label="No Editor assigned"]');
    expect(slot).not.toBeNull();
    expect(meta.querySelectorAll('[role="img"]')).toHaveLength(1);
  });

  it("leaves the #81 footer-slot boundary present and empty, immediately after the card's link", async () => {
    await renderCard();
    const link = host.querySelector('[data-testid="kanban2-card"]')!;
    const slot = host.querySelector('[data-testid="kanban2-card-footer-slot"]')!;
    expect(slot).not.toBeNull();
    expect(slot.textContent).toBe("");
    expect(link.nextElementSibling).toBe(slot);
  });

  // AC 2 / AC 3 / AC 10. These assert the contract the Board hands dnd-kit and the copy it sends to
  // the Dashboard's live region. They are one group on purpose: `restoreFocus: false` alone REMOVES
  // the keyboard-cancel focus restore dnd-kit was doing, and the Board-owned refocus alone leaves
  // two live regions narrating the same drop.
  describe("focus policy and announcements (#98)", () => {
    it("turns off the library's focus restoration and keeps Quincy's keyboard instructions", async () => {
      await renderBoard();
      const accessibility = dnd.handlers.at(-1)?.props?.accessibility as {
        restoreFocus?: unknown;
        screenReaderInstructions?: { draggable?: string };
      } | undefined;
      expect(accessibility, "no accessibility object reached DndContext").not.toBeUndefined();
      // dnd-kit's RestoreFocus fires only for keyboard drags and calls a bare .focus(); the Board
      // does it itself with preventScroll, so this must be explicitly false, not merely absent.
      expect(accessibility!.restoreFocus).toBe(false);
      expect(accessibility!.screenReaderInstructions?.draggable).toContain("press Space");
      // The old Board advertises "Move to…"; this Board has no such control, so promising it would
      // send a screen-reader user looking for a button that does not exist.
      expect(accessibility!.screenReaderInstructions?.draggable).not.toContain("Move to");
    });

    it("suppresses the library's own drop and cancel announcements", async () => {
      await renderBoard();
      const announcements = capturedAnnouncements();
      // Not stylistic: the Board's rejection copy goes to the Dashboard's region via onAnnounce, so
      // a vendor default here would contradict it in a second region on every rejected drop.
      expect(announcements.onDragEnd({ active: { id: "source" }, over: null })).toBeUndefined();
      expect(announcements.onDragCancel({ active: { id: "source" } })).toBeUndefined();
    });

    it("announces a pick-up with Quincy copy in the library's region", async () => {
      await renderBoard();
      const announcements = capturedAnnouncements();
      expect(announcements.onDragStart({ active: { id: "source" } })).toBe("Picked up source Street. Current Stage: Awaiting RAW. Position 1 of 1.");
    });

    it("announces a hover over another Stage once, not on every repeat of the same container", async () => {
      await renderBoard();
      const announcements = capturedAnnouncements();
      const hover = { active: { id: "source" }, over: { id: "raw_review" } };
      expect(announcements.onDragOver(hover)).toBe("source Street is over the end of RAW review, position 2 of 2.");
      // A stationary hover fires this repeatedly; a live region would read it every time.
      expect(announcements.onDragOver(hover)).toBeUndefined();
      // Back over its own column is not news either.
      expect(announcements.onDragOver({ active: { id: "source" }, over: { id: "awaiting_raw" } })).toBeUndefined();
    });

    it("tells the user a same-Stage drop did not move, and gives the handle back", async () => {
      const props = await renderBoard();
      const handle = host.querySelector<HTMLButtonElement>('[data-focus-key="move-handle:source"]');
      expect(handle, "no handle to restore focus to").not.toBeNull();
      await fireDnd("onDragStart", { active: { id: "source" } });
      await endDrag("source", "source");

      expect(props.onBoardMove).not.toHaveBeenCalled();
      expect(props.onAnnounce).toHaveBeenCalledTimes(1);
      expect(props.onAnnounce).toHaveBeenCalledWith("Cancelled moving source Street. It remains in Awaiting RAW.");
      expect(document.activeElement).toBe(handle);
    });

    it("says nothing itself on a valid drop — the Dashboard owns success copy", async () => {
      const props = await renderBoard();
      await fireDnd("onDragStart", { active: { id: "source" } });
      await endDrag("source", "other");

      expect(props.onBoardMove).toHaveBeenCalledTimes(1);
      // Two regions announcing one successful move is the defect this prevents.
      expect(props.onAnnounce).not.toHaveBeenCalled();
    });

    it("treats a drop outside any column as a rejection, not a silent no-op", async () => {
      const props = await renderBoard();
      const handle = host.querySelector<HTMLButtonElement>('[data-focus-key="move-handle:source"]');
      await fireDnd("onDragStart", { active: { id: "source" } });
      // An outside drop never reaches `onMove`, so the Board must handle it in drag-end.
      await fireDnd("onDragEnd", { active: { id: "source" }, over: null });

      expect(props.onBoardMove).not.toHaveBeenCalled();
      expect(props.onAnnounce).toHaveBeenCalledWith("Cancelled moving source Street. It remains in Awaiting RAW.");
      expect(document.activeElement).toBe(handle);
    });

    it("restores the handle on an Escape cancel, which the library no longer does", async () => {
      const props = await renderBoard();
      const handle = host.querySelector<HTMLButtonElement>('[data-focus-key="move-handle:source"]');
      await fireDnd("onDragStart", { active: { id: "source" } });
      await fireDnd("onDragCancel", { active: { id: "source" } });

      expect(document.activeElement).toBe(handle);
      expect(props.onAnnounce).toHaveBeenCalledWith("Cancelled moving source Street. It remains in Awaiting RAW.");
    });

    it("stays silent for a terminal principal", async () => {
      const props = await renderBoard({ terminal: true });
      await fireDnd("onDragStart", { active: { id: "source" } });
      await fireDnd("onDragCancel", { active: { id: "source" } });
      // `announce` returns undefined when terminal and the Dashboard drops undefined, so terminal
      // suppression must not need a second branch in the Board.
      expect(props.onAnnounce).not.toHaveBeenCalledWith(expect.stringContaining("Cancelled moving"));
    });
  });

  // AC 6. The refresh barrier the Dashboard uses to hold replacement data while a drag is live.
  describe("drag lifecycle (#98)", () => {
    it("opens the barrier on pick-up", async () => {
      const props = await renderBoard();
      await fireDnd("onDragStart", { active: { id: "source" } });
      expect(props.onInteractionStateChange).toHaveBeenCalledWith({ activeId: "source", proposal: null });
    });

    // The ordering pin. The primitive calls `onDragEnd` BEFORE `onMove`, so a builder who "fixes"
    // the clear by resetting something `handleMove` reads will stop delegating the move entirely.
    // Both facts are asserted, not their order: a legitimate clear-after-move refactor must stay
    // green.
    it("still delegates a valid move even though the barrier clears in drag-end", async () => {
      const props = await renderBoard();
      await fireDnd("onDragStart", { active: { id: "source" } });
      await endDrag("source", "other");

      expect(props.onBoardMove).toHaveBeenCalledTimes(1);
      expect((props.onInteractionStateChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toEqual({ activeId: undefined, proposal: null });
    });

    // Clearing ONLY in `onMove` is the real bug: neither of the next two paths reaches it, so the
    // barrier would latch forever — every refetch queued permanently, the view control disabled for
    // the rest of the session, and nothing in happy-dom failing.
    it("clears the barrier on a drop outside any column", async () => {
      const props = await renderBoard();
      await fireDnd("onDragStart", { active: { id: "source" } });
      await fireDnd("onDragEnd", { active: { id: "source" }, over: null });

      expect(props.onBoardMove).not.toHaveBeenCalled();
      expect((props.onInteractionStateChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toEqual({ activeId: undefined, proposal: null });
    });

    it("clears the barrier on an Escape cancel", async () => {
      const props = await renderBoard();
      await fireDnd("onDragStart", { active: { id: "source" } });
      await fireDnd("onDragCancel", { active: { id: "source" } });

      expect(props.onBoardMove).not.toHaveBeenCalled();
      expect((props.onInteractionStateChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toEqual({ activeId: undefined, proposal: null });
    });

    it("re-announces a hover after a new pick-up, rather than suppressing it as a repeat", async () => {
      await renderBoard();
      await fireDnd("onDragStart", { active: { id: "source" } });
      const first = capturedAnnouncements().onDragOver({ active: { id: "source" }, over: { id: "raw_review" } });
      expect(first).not.toBeUndefined();
      await fireDnd("onDragCancel", { active: { id: "source" } });

      // The de-duplication key is reset by the lifecycle clear, not by pick-up: without that, the
      // second drag's first hover is silently swallowed as a repeat of the first drag's. (An extra
      // reset in `onDragStart` was removed after proving it could not fail a test — a drag always
      // ends through drag-end or cancel first.)
      await fireDnd("onDragStart", { active: { id: "source" } });
      expect(capturedAnnouncements().onDragOver({ active: { id: "source" }, over: { id: "raw_review" } })).toBe(first);
    });
  });
});
