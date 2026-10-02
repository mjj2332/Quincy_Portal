// happy-dom cannot exercise real PointerSensor/KeyboardSensor drag activation: real activation
// constraints, collision geometry, autoscroll, scroll containers, browser focus timing and
// active-drag overlay rendering are all real-browser acceptance items, not unit-level ones. This
// test drives the captured `DndContext` handlers directly instead — the technique the Board this
// one replaced (deleted in #83) also used.
import { createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyboardSensor, MeasuringStrategy, MouseSensor, TouchSensor, type DragEndEvent } from "@dnd-kit/core";
import { ProjectKanbanBoard2 } from "./board";
import { KanbanCard2 } from "./card";
import { STAR_GUARD_WINDOW_MS } from "../../lib/star-click-guard";
import type { ProjectKanbanBoardProps, ProjectSummary } from "../../lib/kanban-interaction";
import type { PipelineStage } from "../../lib/stages";
import { cardMenuTrigger, closeMenus, isMenuItemDisabled, menuItem, menuItems, moveToStage, moveToTrigger, openCardMenu, openContextMenu, openMoveTo, openMoveToSubmenu, stageRadio, stageRadios } from "./board-menu-test-helpers";

// happy-dom lacks `Element.getAnimations()`, which Base UI's ScrollArea (the Board's horizontal
// scroll, `board/board.tsx`) calls on a timer after mount. The no-op stub means "no active
// animations"; see `reui/gantt/gantt-adjust-ghost-marker.dom.test.tsx` for the same polyfill.
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}

const dnd = vi.hoisted(() => ({
  // The whole props object, not just `onDragEnd`: #98 asserts the `accessibility` contract the Board
  // hands dnd-kit, which is only observable here.
  handlers: [] as Array<{ onDragEnd?: (event: unknown) => void; props?: Record<string, unknown> }>,
}));

const dragOverlay = vi.hoisted(() => ({
  props: [] as Array<{ dropAnimation?: unknown }>,
}));

// One `DndContext` for the whole Board, one `SortableContext` per Stage column
// (`components/reui/kanban.tsx`'s `KanbanColumnContent`) — the technique is
// `screens/Dashboard-stage-interactions.dom.test.tsx`'s `sortable.contexts`.
const sortable = vi.hoisted(() => ({
  contexts: [] as Array<readonly string[]>,
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

vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>();
  return {
    ...actual,
    SortableContext: (props: Parameters<typeof actual.SortableContext>[0]) => {
      sortable.contexts.push(props.items.map(String));
      return createElement(actual.SortableContext, props);
    },
  };
});

// #83: drives a real cover-load failure through the actual `onFailedChange` callback `LazyImage`
// itself calls once a background image exhausts its retries, rather than adding a test-only
// `initialCoverFailed` prop to `KanbanCard2`. Only the failure path matters here, so the double
// never renders an `<img>`.
vi.mock("../LazyImage", () => ({
  LazyImage: ({ onFailedChange }: { onFailedChange?: (failed: boolean) => void }) => {
    useEffect(() => { onFailedChange?.(true); }, [onFailedChange]);
    return null;
  },
}));

// #304: happy-dom has no layout, so the FLIP's DOM writes are the seam's own tests
// (`lib/kanban-flip.test.ts`). Here only WHICH elements it is played on, and by how much, matters.
const flip = vi.hoisted(() => ({
  played: [] as Array<{ element: HTMLElement; dx: number; dy: number; lift: boolean }>,
}));

vi.mock("../../lib/kanban-flip", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/kanban-flip")>();
  return {
    ...actual,
    playFlip: (element: HTMLElement, dx: number, dy: number, lift: boolean) => {
      flip.played.push({ element, dx, dy, lift });
      return () => undefined;
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
    pendingMoves: new Set(),
    pendingOrdering: new Set(),
    terminal: false,
    onBoardMove: vi.fn(),
    onPriorityChange: vi.fn(),
    onMoveStage: vi.fn(),
    onAnnounce: vi.fn(),
    onInteractionStateChange: vi.fn(),
    ...overrides,
  };
}

let host: HTMLElement;
let root: Root;

/** The card's link is its drag handle (#432): a locked drag shows as `data-disabled`, never `disabled`. */
function isLocked(element: Element): boolean {
  return element.hasAttribute("disabled") || element.getAttribute("data-disabled") === "true";
}

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
    sortable.contexts.length = 0;
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
    const columns = host.querySelectorAll('[data-testid="board-column"]');
    expect(columns).toHaveLength(2);
    expect(columns[0]?.textContent).toContain("Awaiting RAW");
    expect(columns[1]?.textContent).toContain("RAW review");
    expect(host.querySelector('[data-testid="board-card-address"]')?.textContent).toBe("source Street");
  });

  // #83: nothing counted these after the old Board (the only caller with its own duplicated
  // drag/sort wiring) was deleted. `stages` above names exactly two active Stages; one
  // `SortableContext` per Stage column (`components/reui/kanban.tsx`'s `KanbanColumnContent`) and
  // exactly one `DndContext` for the whole Board are the contract, not an incidental count.
  it("renders exactly one DndContext and one SortableContext per Stage (#83)", async () => {
    await renderBoard();
    expect(dnd.handlers).toHaveLength(1);
    expect(sortable.contexts).toHaveLength(stages.length);
  });

  // #83: this is screen-reader copy, not a test id — the "test ids may keep the kanban2 spelling"
  // licence does not cover it. Leaving the old string would silently void
  // `Dashboard-kanban-sort.dom.test.tsx:129`'s assertion that the label is ABSENT in archived scope:
  // after the old Board is deleted that assertion would pass because the label changed, not because
  // the Board unmounted.
  it("labels the Board root 'Project pipeline board', with no internal-naming suffix (#83)", async () => {
    await renderBoard();
    const root = host.querySelector('[data-focus-key="board"]');
    expect(root, "no Board root rendered — the assertion below would be vacuous").not.toBeNull();
    expect(root!.getAttribute("aria-label")).toBe("Project pipeline board");
  });

  // Tempo layout (ReUI `tempo-tasks` Kanban board): every expanded column is one fixed 280px track
  // (`w-[17.5rem] shrink-0` on a flex row since #432, so a collapsed rail can be 48px beside them;
  // no minmax and no mobile/coarse variants), columns are separate
  // bordered surfaces with a `--space-4` gap between them (not a joined `bg-border` grid), and the
  // grid is a `w-max min-w-full` content box inside a Base UI scroll area (tempo's
  // `BoardScrollArea`), so it sits left-aligned and spare width is page background. The scroll area's
  // Viewport scrolls, not the grid.
  it("lays the Board out as fixed 280px, separated, bordered columns in a full-width scroll area", async () => {
    await renderBoard();
    const root = host.querySelector('[data-focus-key="board"]');
    expect(root, "no Board root rendered — the assertions below would be vacuous").not.toBeNull();
    const classes = [...root!.classList];
    for (const token of ["flex", "gap-[var(--space-4)]", "w-max", "min-w-full"]) expect(classes).toContain(token);
    expect(classes.filter((token) => token.startsWith("overflow"))).toEqual([]);
    expect(classes.filter((token) => token.includes("auto-cols-")), "the grid track is gone: widths live on the columns").toEqual([]);
    // grid -> Content -> Viewport -> Root, and the horizontal bar is the Viewport's sibling (not inside
    // it), so `position: sticky` resolves against the page rather than the Viewport's own overflow.
    const viewport = root!.closest<HTMLElement>('[data-testid="board-scroll-viewport"]');
    expect(viewport, "the grid is not inside the scroll area's viewport").not.toBeNull();
    expect(root!.parentElement!.getAttribute("data-slot")).toBe("scroll-area-content");
    expect(viewport!.parentElement!.getAttribute("data-slot")).toBe("scroll-area");
    expect(classes).not.toContain("bg-border");
    expect(classes).not.toContain("w-fit");
    const columns = [...host.querySelectorAll('[data-testid="board-column"]')];
    expect(columns.length, "no columns rendered — the per-column assertion would be vacuous").toBeGreaterThan(0);
    for (const column of columns) expect([...column.classList]).toContain("border-border");
    // The fixed 280px lives on each expanded column, and never shrinks.
    for (const column of columns) for (const token of ["w-[17.5rem]", "shrink-0"]) expect([...column.classList]).toContain(token);
  });

  it("each column scrolls on its own with its Stage heading pinned (#363)", async () => {
    await renderBoard();
    const root = host.querySelector('[data-focus-key="board"]')!;
    const gridClasses = [...root.classList];
    for (const token of ["h-full", "items-stretch"]) expect(gridClasses).toContain(token);
    expect(gridClasses).not.toContain("pb-[var(--space-2)]");
    expect(gridClasses.filter((token) => token.startsWith("overflow"))).toEqual([]);
    const boardViewport = host.querySelector<HTMLElement>('[data-testid="board-scroll-viewport"]')!;
    for (const token of ["flex-1", "min-h-0"]) expect([...boardViewport.classList]).toContain(token);
    const columns = [...host.querySelectorAll<HTMLElement>('[data-testid="board-column"]')];
    expect(columns.length, "no columns rendered — the per-column assertions would be vacuous").toBeGreaterThan(0);
    for (const column of columns) {
      expect([...column.classList]).toContain("min-h-0");
      const viewports = column.querySelectorAll<HTMLElement>('[data-slot="scroll-area-viewport"]');
      expect(viewports).toHaveLength(1);
      const viewport = viewports[0]!;
      for (const card of column.querySelectorAll("[data-flip-id]")) expect(viewport.contains(card)).toBe(true);
      const heading = column.querySelector('[data-focus-key^="stage-heading:"]');
      expect(heading, "no Stage heading").not.toBeNull();
      expect(viewport.contains(heading)).toBe(false);
    }
  });

  // happy-dom has no layout, so Base UI sees no overflow and never mounts the bar (it is not
  // `keepMounted`, deliberately: a wide screen with nothing to scroll gets no empty track). Stub the
  // Viewport's metrics to overflow sideways and fire `scroll`, which re-runs Base UI's measurement.
  it("mounts one sticky horizontal scrollbar beside the viewport once the Board overflows sideways", async () => {
    await renderBoard();
    const viewport = host.querySelector<HTMLElement>('[data-testid="board-scroll-viewport"]');
    expect(viewport, "no scroll-area viewport rendered").not.toBeNull();
    expect(host.querySelector('[data-testid="board-scrollbar"]'), "bar mounted with no overflow").toBeNull();
    const metrics = { scrollWidth: 2000, clientWidth: 800, scrollHeight: 600, clientHeight: 600 };
    for (const [key, value] of Object.entries(metrics)) Object.defineProperty(viewport!, key, { configurable: true, get: () => value });
    const { act } = await import("react");
    await act(async () => { viewport!.dispatchEvent(new Event("scroll")); await Promise.resolve(); await Promise.resolve(); });
    const bars = [...host.querySelectorAll<HTMLElement>('[data-testid="board-scrollbar"]')];
    expect(bars.map((bar) => bar.getAttribute("data-orientation"))).toEqual(["horizontal"]);
    const bar = bars[0]!;
    expect(bar.style.position).toBe("sticky");
    expect(bar.style.bottom).toBe("0px");
    expect(bar.parentElement).toBe(viewport!.parentElement);
    expect(viewport!.contains(bar)).toBe(false);
    expect([...bar.classList]).toContain("bg-[var(--bg-canvas)]");
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
    expect(host.querySelector('[data-testid="board-card-priority"]')).toBeNull();
    // Anchored: the card really did render, so the nulls above mean "no control", not "no card".
    expect(host.querySelector('[data-testid="board-card-address"]')?.textContent).toBe("source Street");
  });

  // Asserts the BEHAVIOUR #81 fixed (01f9c21), not the shape of the vendor's tree.
  //
  // dnd-kit defaults a draggable/sortable role to "button" (`core.esm.js:3385`). `KanbanItem` used to
  // spread those attributes on the card WRAPPER, and under ARIA 1.2 children-presentational a
  // role="button" ancestor prunes a nested radiogroup out of the accessibility tree entirely —
  // so every star control on the Board was invisible to screen readers. #81 moved `attributes`
  // onto `KanbanItemHandle`; #432 makes that handle the card's own link rather than a wrapper around
  // the whole card, so the attributes land on the link and the stars are never beneath them.
  //
  // Every query below is anchored non-null first, so this one can fail for the defect it names.
  it("puts the dnd-kit drag attributes on the link, never on the card wrapper; the link stays a link (#81, #432)", async () => {
    await renderBoard({ canPrioritize: true });

    const link = host.querySelector('[data-testid="board-card"]');
    expect(link, "no card link rendered — every assertion below would be vacuous").not.toBeNull();
    expect(link!.tagName).toBe("A");
    // dnd-kit's `role="button"`, `tabindex`, `aria-roledescription`, `aria-pressed` and
    // `aria-disabled` are all overridden off; `aria-describedby` (the keyboard instructions) stays.
    expect(link!.getAttribute("role")).toBeNull();
    expect(link!.getAttribute("tabindex")).toBeNull();
    expect(link!.getAttribute("aria-roledescription")).toBeNull();
    expect(link!.getAttribute("aria-pressed")).toBeNull();
    expect(link!.getAttribute("aria-disabled")).toBeNull();
    const describedBy = link!.getAttribute("aria-describedby");
    expect(describedBy, "the keyboard drag instructions are no longer attached to the card").not.toBeNull();
    expect(document.getElementById(describedBy!), "aria-describedby points at nothing").not.toBeNull();
    // And it still carries dnd-kit's listeners: a pointer-down on it must reach the sensors.
    expect(link!.getAttribute("href")).toBe("/projects/source");

    const wrap = host.querySelector('[data-testid="board-card-wrap"]');
    expect(wrap, "no card wrapper rendered — the assertions below would be vacuous").not.toBeNull();
    expect(wrap!.getAttribute("role")).not.toBe("button");
    expect(wrap!.getAttribute("aria-roledescription")).toBeNull();

    // The point of the whole exercise: no role="button" ancestor anywhere above the radiogroup, and
    // the stars are not inside the link either.
    const group = host.querySelector('[role="radiogroup"]');
    expect(group, "no radiogroup rendered").not.toBeNull();
    expect(host.querySelector('[role="button"] [role="radiogroup"]')).toBeNull();
    expect(link!.contains(group)).toBe(false);
    expect(group!.closest("a")).toBeNull();
  });

  // The link is the handle, so a press on a star or the card's controls can never start a drag:
  // they are outside it, structurally rather than by `stopPropagation`.
  it("keeps the stars and the card's controls outside the drag handle (#432)", async () => {
    await renderBoard({ canPrioritize: true });
    const link = host.querySelector('[data-testid="board-card"]')!;
    expect(link, "no card link rendered — the assertions below would be vacuous").not.toBeNull();
    const radios = [...host.querySelectorAll('[role="radio"][aria-label$="star"], [role="radio"][aria-label$="stars"]')];
    expect(radios.length, "no star radios rendered").toBeGreaterThan(0);
    for (const radio of radios) expect(link.contains(radio)).toBe(false);
    for (const button of host.querySelectorAll("button")) expect(link.contains(button)).toBe(false);
  });

  // The old handle suppressed browser scroll with `touch-action: none`. The whole card is the handle
  // now, so that would stop a column scrolling under a thumb anywhere on a card: the link takes
  // `manipulation`, and the 250ms touch delay (not the style) is what separates scroll from drag.
  it("lets the browser scroll under a touch: the link is touch-action: manipulation, nothing is none (#432)", async () => {
    await renderBoard();
    const link = host.querySelector('[data-testid="board-card"]');
    expect(link, "no card link rendered — the assertions below would be vacuous").not.toBeNull();
    expect(link!.className).toContain("[touch-action:manipulation]");
    expect(host.innerHTML).not.toContain("touch-action:none");
  });

  it("shows a grab cursor on the link only while a drag is possible (#432)", async () => {
    await renderBoard({ canMoveStages: true });
    const live = host.querySelector('[data-testid="board-card"]');
    expect(live, "no card link rendered — the assertions below would be vacuous").not.toBeNull();
    expect(live!.className).toContain("cursor-grab");
    expect(isLocked(live!)).toBe(false);
    await renderBoard({ canPrioritize: true, canMoveStages: false });
    const locked = host.querySelector('[data-testid="board-card"]');
    expect(locked, "no card link rendered after the re-render").not.toBeNull();
    expect(isLocked(locked!)).toBe(true);
    expect(locked!.className).not.toContain("cursor-grab");
  });

  // #83: the last assertion of `screens/dashboard-routing.test.ts`'s retired card-markup suite
  // (`expect(html).not.toContain("draggable=")`). The defect is specific: the native HTML5 drag
  // the attribute switches on is not dnd-kit's, and a card carrying it hands the browser a
  // competing drag that starts on mousedown with no activation constraint — dragging the card's
  // ghost image around instead of picking it up. An `<a href>` is natively draggable anyway, which
  // is why the invariant is "never sets the attribute", not "nothing here can be dragged".
  it("sets no native draggable attribute anywhere on the Board (#83)", async () => {
    await renderBoard({ canPrioritize: true });
    expect(host.querySelector('[data-testid="board-card-wrap"]'), "no card rendered — the assertion below would be vacuous").not.toBeNull();
    expect(host.querySelector("[draggable]")).toBeNull();
  });

  it("moves a card to a different column's Stage on drop, naming only the Stage", async () => {
    const props = await renderBoard();
    await endDrag("source", "raw_review");
    expect(props.onBoardMove).toHaveBeenCalledTimes(1);
    const call = (props.onBoardMove as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call.slice(0, 2)).toEqual(["source", "raw_review"]);
    expect(call).toHaveLength(3);
  });

  // #470: columns are sorted by data, so a drop names a Stage and never a position. Dropping on any
  // card, or on the column, is the same move, and the card lands at its sorted slot.
  describe("cross-Stage drops land at the sorted slot (#470)", () => {
    // t1 priority 5, t2 priority 3, t3 unset: sorted t1, t2, t3. The mover (priority 4) sorts between t1 and t2.
    const targets = (moverPriority: number | null = 4) => [
      project("source", "awaiting_raw", { priority: moverPriority }),
      project("t1", "raw_review", { priority: 5 }),
      project("t2", "raw_review", { priority: 3 }),
      project("t3", "raw_review"),
    ];
    const moveCalls = (props: ProjectKanbanBoardProps) => (props.onBoardMove as ReturnType<typeof vi.fn>).mock.calls;

    it("treats a drop on any card, and on the column itself, as the same Stage move", async () => {
      for (const over of ["t1", "t2", "t3", "raw_review"]) {
        const props = await renderBoard({ projects: targets() });
        await endDrag("source", over);
        expect(moveCalls(props), `the drop on ${over} was rejected`).toHaveLength(1);
        expect(moveCalls(props)[0]!.slice(0, 2)).toEqual(["source", "raw_review"]);
      }
    });

    it("narrates the sorted slot, not the hovered card's, once", async () => {
      await renderBoard({ projects: targets() });
      const { onDragOver } = capturedAnnouncements();
      const over = (id: string) => ({ active: { id: "source" }, over: { id } });
      expect(onDragOver(over("t3"))).toBe("source Street is over RAW review; it will land at position 2 of 4.");
      // Another card of the same Stage lands in the same slot: nothing new to say.
      expect(onDragOver(over("t1"))).toBeUndefined();
      expect(onDragOver(over("raw_review"))).toBeUndefined();
    });

    it("speaks the slot again after passing over a refused one", async () => {
      await renderBoard({ projects: [...targets(), project("sibling", "awaiting_raw")] });
      const { onDragOver } = capturedAnnouncements();
      const over = (id: string) => ({ active: { id: "source" }, over: { id } });
      const first = onDragOver(over("t2"));
      expect(first, "anchor").toBe("source Street is over RAW review; it will land at position 2 of 4.");
      // Its own Stage: refused.
      expect(onDragOver(over("sibling"))).toBeUndefined();
      expect(onDragOver(over("t2"))).toBe(first);
    });

    // An unset-priority mover sorts after every prioritised card, and ties break on street.
    const endTargets = () => [project("source", "awaiting_raw"), project("t1", "raw_review", { priority: 5 }), project("a3", "raw_review")];

    it("lands an unset-priority mover after the prioritised cards, at the end", async () => {
      await renderBoard({ projects: endTargets() });
      expect(capturedAnnouncements().onDragOver({ active: { id: "source" }, over: { id: "t1" } }))
        .toBe("source Street is over RAW review; it will land at position 3 of 3.");
    });

    // The drop indicator. These fire the DndContext's own `onDragOver` — the vendored primitive's
    // handler — so they also pin the `reui/kanban.tsx` pass-through: upstream returns before any
    // consumer hook whenever `onMove` is set, and with that early return the indicator never draws.
    describe("drop indicator", () => {
      const indicators = () => [...host.querySelectorAll<HTMLElement>('[data-testid="board-drop-indicator"]')];
      const hover = (overId: string) => fireDnd("onDragOver", { active: { id: "source" }, over: { id: overId } });

      it("marks the sorted slot, ahead of the card it sorts before, wherever in the column the pointer is", async () => {
        for (const over of ["t1", "t2", "t3", "raw_review"]) {
          await renderBoard({ projects: targets() });
          await fireDnd("onDragStart", { active: { id: "source" } });
          await hover(over);
          expect(indicators(), `no indicator drawn hovering ${over}`).toHaveLength(1);
          const item = indicators()[0]!.parentElement!;
          expect(item.textContent).toContain("t2 Street");
          expect(item.firstElementChild).toBe(indicators()[0]);
          await fireDnd("onDragCancel", { active: { id: "source" } });
        }
      });

      it("marks the end of the column when the card sorts last", async () => {
        await renderBoard({ projects: endTargets() });
        await hover("t1");
        expect(indicators()).toHaveLength(1);
        expect(indicators()[0]!.previousElementSibling?.textContent).toContain("a3 Street");
        expect(indicators()[0]!.nextElementSibling).toBeNull();
      });

      it("marks the target column as receiving, and clears it", async () => {
        await renderBoard({ projects: targets() });
        const receiving = () => [...host.querySelectorAll('[data-testid="board-column"]')].map((column) => column.className.split(" ").includes("border-[var(--ink-900)]"));
        expect(receiving(), "anchor: nothing receiving before the hover").toEqual([false, false]);
        await hover("t2");
        expect(receiving()).toEqual([false, true]);
        await fireDnd("onDragCancel", { active: { id: "source" } });
        expect(receiving()).toEqual([false, false]);
      });

      // happy-dom has no layout, so this pins the classes that take the indicator out of flow. An
      // in-flow indicator shifts the cards, and with the primitive's `MeasuringStrategy.Always` that
      // moves the collision target and flip-flops. The real geometry is a browser-pass claim.
      it("is out of flow, inert and hidden from assistive technology", async () => {
        await renderBoard({ projects: targets() });
        await hover("t1");
        const indicator = indicators()[0];
        expect(indicator, "no indicator drawn — nothing below is proved").not.toBeUndefined();
        expect(indicator!.className.split(" ")).toEqual(expect.arrayContaining(["absolute", "pointer-events-none"]));
        expect(indicator!.getAttribute("aria-hidden")).toBe("true");
        expect(indicator!.parentElement!.className.split(" ")).toContain("relative");
      });

      it("offers no slot in the card's own Stage, which refuses a drop", async () => {
        await renderBoard({ projects: [...targets(), project("sibling", "awaiting_raw")] });
        await hover("t1");
        expect(indicators(), "anchor: a cross-Stage hover draws one").toHaveLength(1);
        await hover("sibling");
        expect(indicators()).toHaveLength(0);
      });

      it("clears on drop and on cancel", async () => {
        await renderBoard({ projects: targets() });
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

  // #470: a column's order is data, not the user's to change. A same-column drop is refused, says so
  // in its own words, and hands the handle back.
  describe("same-column drops (#470)", () => {
    const column = () => [project("s1", "awaiting_raw"), project("s2", "awaiting_raw"), project("s3", "awaiting_raw"), project("other", "raw_review")];

    it("refuses a drop on a sibling card, and on the column, with the Stage-sorted copy", async () => {
      for (const over of ["s2", "s3", "awaiting_raw", "s1"]) {
        const props = await renderBoard({ projects: column(), canPrioritize: true });
        const handle = host.querySelector<HTMLAnchorElement>('[data-focus-key="card:s1"]');
        await endDrag("s1", over);
        expect(props.onBoardMove, `the drop on ${over} went through`).not.toHaveBeenCalled();
        expect(props.onAnnounce).toHaveBeenCalledWith("s1 Street stays in Awaiting RAW. Columns are sorted by priority and shoot date.");
        expect(document.activeElement).toBe(handle);
      }
    });

    it("offers no indicator and no narration over the card's own Stage", async () => {
      await renderBoard({ projects: column() });
      await fireDnd("onDragOver", { active: { id: "s3" }, over: { id: "s1" } });
      expect(host.querySelector('[data-testid="board-drop-indicator"]')).toBeNull();
      expect(capturedAnnouncements().onDragOver({ active: { id: "s1" }, over: { id: "s3" } })).toBeUndefined();
    });

    it("lets a prioritize-only principal do nothing with a drag", async () => {
      const props = await renderBoard({ projects: column(), canMoveStages: false, canPrioritize: true });
      const handle = host.querySelector<HTMLAnchorElement>('[data-focus-key="card:s3"]');
      expect(handle, "no handle rendered").not.toBeNull();
      expect(isLocked(handle!)).toBe(true);
      await endDrag("s1", "raw_review");
      expect(props.onBoardMove).not.toHaveBeenCalled();
    });
  });

  // #83: the old Board's equivalent pins die with its deletion
  // (`ProjectKanbanBoard.dom.test.tsx:228,235,275`), and the values genuinely differ now that this
  // Board is vendor-owned — these are re-pinned as divergences, not ports.
  //
  // `MeasuringStrategy.Always` re-enables the precondition of a shipped white-screen defect
  // (`docs/lessons.md` #185: "Pair any live-reordering board with `MeasuringStrategy.BeforeDragging`,
  // not `Always`.") — it is safe ONLY because this Board never rewrites the rendered column arrays
  // on hover (`board.tsx:316-318`); the drop indicator is absolutely positioned and zero-layout so it
  // cannot force a re-measure. That invariant, not this pin, is the actual safety argument.
  describe("DndContext configuration, vendor-owned (#83)", () => {
    it("measures every droppable on every change", async () => {
      await renderBoard();
      const props = dnd.handlers.at(-1)?.props;
      expect(props, "no DndContext props captured — the assertion below would be vacuous").not.toBeUndefined();
      expect(props!.measuring).toEqual({ droppable: { strategy: MeasuringStrategy.Always } });
    });

    it("pins the three sensors and their activation options", async () => {
      await renderBoard();
      const props = dnd.handlers.at(-1)?.props;
      expect(props, "no DndContext props captured — the assertion below would be vacuous").not.toBeUndefined();
      const sensors = props!.sensors as Array<{ sensor: unknown; options?: Record<string, unknown> }>;
      expect(sensors.map((descriptor) => descriptor.sensor)).toEqual([MouseSensor, TouchSensor, KeyboardSensor]);
      expect(sensors[0]?.options).toEqual({ activationConstraint: { distance: 10 } });
      expect(sensors[1]?.options).toEqual({ activationConstraint: { delay: 250, tolerance: 5 } });
      // #432: the Board narrows the keyboard pick-up to Space (Enter opens the card).
      expect(sensors[2]?.options).toEqual({
        coordinateGetter: expect.any(Function),
        keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter", "Tab"] },
      });
    });

    it("starts a keyboard drag on Space only, never Enter (#432)", async () => {
      await renderBoard();
      const props = dnd.handlers.at(-1)?.props;
      const keyboard = (props!.sensors as Array<{ sensor: { activators: Array<{ eventName: string; handler: (event: unknown, options: unknown, context: unknown) => boolean }> }; options: unknown }>)[2]!;
      const activator = keyboard.sensor.activators[0]!;
      expect(activator.eventName).toBe("onKeyDown");
      const target = document.createElement("a");
      const attempt = (code: string) => {
        const onActivation = vi.fn();
        const nativeEvent = { code };
        const handled = activator.handler(
          { nativeEvent, target, preventDefault: vi.fn() },
          { ...(keyboard.options as object), onActivation },
          { active: { activatorNode: { current: target } } },
        );
        return { handled, activated: onActivation.mock.calls.length };
      };
      expect(attempt("Space")).toEqual({ handled: true, activated: 1 });
      expect(attempt("Enter")).toEqual({ handled: false, activated: 0 });
    });

    it("passes no collisionDetection or autoScroll override — both stay the vendor's own defaults", async () => {
      await renderBoard();
      const props = dnd.handlers.at(-1)?.props;
      expect(props, "no DndContext props captured — the assertion below would be vacuous").not.toBeUndefined();
      expect(props).not.toHaveProperty("collisionDetection");
      expect(props).not.toHaveProperty("autoScroll");
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

  it("locks the drag handle of ONLY the card whose priority write is in flight (#306)", async () => {
    // #98 locked every card on any pending ordering write; #306 narrows that to the saving card,
    // so another card's handle and drag-end stay live. `pendingMoves` is still board-wide.
    const props = await renderBoard({ pendingOrdering: new Set(["other"]) });
    const handle = host.querySelector<HTMLElement>('[data-testid="board-card"]');
    expect(handle, "no drag handle rendered — the assertion below would be vacuous").not.toBeNull();
    expect(isLocked(handle!)).toBe(false);
    await endDrag("source", "raw_review");
    expect(props.onBoardMove).toHaveBeenCalledTimes(1);
  });

  it("refuses a drag-end and disables the handle for the card whose own priority write is in flight (#306)", async () => {
    const props = await renderBoard({ pendingOrdering: new Set(["source"]) });
    const handle = host.querySelector<HTMLElement>('[data-testid="board-card"]');
    expect(handle, "no drag handle rendered — the assertion below would be vacuous").not.toBeNull();
    expect(isLocked(handle!)).toBe(true);
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
    expect(host.querySelector('[data-testid="board-card-address"]'), "no card rendered — the assertion below would be vacuous").not.toBeNull();
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    expect(host.querySelector('[data-testid="board-card-priority"] [role="img"]')).not.toBeNull();
  });

  it("keeps every column at full opacity — the vendor renders every disabled column at 50% (#98)", async () => {
    await renderBoard();
    const column = host.querySelector('[data-testid="board-column"]');
    expect(column, "no column rendered — the assertion below would be vacuous").not.toBeNull();
    expect(column!.className).toContain("opacity-100");
    // Not merely present alongside the vendor's `opacity-50` — actually dedup'd out by
    // tailwind-merge, which runs in JS at render time, before either ever reaches the DOM.
    expect(column!.className).not.toContain("opacity-50");
  });

  it("keeps a card at full opacity while it is disabled by the pending-write lock, not just while it isn't dragging (#98)", async () => {
    await renderBoard({ pendingOrdering: new Set(["source"]) });
    const cardWrap = host.querySelector('[data-testid="board-card-wrap"]');
    expect(cardWrap, "no card wrapper rendered — the assertion below would be vacuous").not.toBeNull();
    // Two levels up: the FLIP wrapper (#304) sits between the `KanbanItem` and the card.
    const item = cardWrap!.parentElement?.parentElement ?? null;
    expect(item, "no KanbanItem wrapper found — the assertion below would be vacuous").not.toBeNull();
    expect(item!.getAttribute("data-disabled")).toBe("true");
    expect(item!.className).toContain("data-[disabled=true]:opacity-100");
  });

  // `KanbanOverlay`'s content only actually mounts under a real drag, which happy-dom's sensors
  // cannot produce (see this file's header) — so instead of driving the whole drag pipeline, this
  // renders `KanbanCard2` directly with `isOverlay`, exactly the way `board.tsx`'s
  // `<KanbanOverlay>` render-prop does, and separately proves the real card is unaffected.
  it("the drag overlay preview carries no interactive element but still shows the Deadline, while the real card keeps its link and controls (#98)", async () => {
    // The card renders "Due"/"Overdue" by comparing the Deadline against `Date.now()`, so
    // wall-clock time decides which word appears — freeze it before the fixture deadline (the
    // retired `KanbanCardPreview.dom.test.tsx`'s pattern), or this test passes only until that date.
    vi.useFakeTimers({ now: new Date("2026-08-27T00:00:00.000Z") });
    try {
      const summary = project("source", "awaiting_raw", {
        deadlineAt: Date.parse("2026-09-01T22:00:00.000Z"),
        deadlineLocalCivil: "2026-09-02T08:00",
        deadlineZone: "Australia/Sydney",
      });
      const overlayHost = document.createElement("div");
      document.body.appendChild(overlayHost);
      const overlayRoot = createRoot(overlayHost);
      const { act } = await import("react");
      await act(async () => { overlayRoot.render(createElement(KanbanCard2, { project: summary, isOverlay: true })); await Promise.resolve(); });

      // Positive anchor first: the overlay preview really renders the card's content, so the
      // absence assertions below cannot pass by the overlay having failed to render at all.
      const overlayAddress = overlayHost.querySelector('[data-testid="board-card-address"]');
      expect(overlayAddress, "no overlay content rendered — the assertions below would be vacuous").not.toBeNull();
      expect(overlayAddress!.textContent).toBe("source Street");
      expect(overlayHost.querySelector('[data-testid="board-card-overlay"]')).not.toBeNull();

      // #83: the retired `KanbanCardPreview.dom.test.tsx` proved the preview carries the Deadline;
      // `KanbanCard2(isOverlay)` is the only preview renderer now, so this re-pins it here.
      const overlayDeadline = overlayHost.querySelector('[data-testid="board-card-deadline"]');
      expect(overlayDeadline, "no Deadline rendered in the overlay preview — the assertion below would be vacuous").not.toBeNull();
      expect(overlayDeadline!.textContent).toBe("Due Wed 2 Sep · 08:00");

      expect(overlayHost.querySelector("a")).toBeNull();
      expect(overlayHost.querySelector("button")).toBeNull();
      expect(overlayHost.querySelector('[role="radiogroup"]')).toBeNull();
      expect(overlayHost.querySelector('input, select, textarea, [contenteditable="true"]')).toBeNull();
      expect(overlayHost.querySelector('[tabindex]:not([tabindex="-1"])')).toBeNull();
      // #83: the two checks `KanbanCardPreview.dom.test.tsx:49-50` had that this test did not — the
      // preview component it covered is retired along with the old Board, so these move here.
      expect(overlayHost.querySelector("[id]")).toBeNull();
      expect(overlayHost.querySelector("[data-focus-key]")).toBeNull();

      await act(async () => { overlayRoot.unmount(); await Promise.resolve(); });
      overlayHost.remove();

      // The real (non-overlay) card still has its actual navigable link and its drag handle — the
      // overlay fix must not have taken interactivity away from the card that produced it.
      await renderBoard({ canPrioritize: true });
      const realLink = host.querySelector('[data-testid="board-card"]');
      expect(realLink, "no real card link rendered — the anti-vacuity anchor for the real card").not.toBeNull();
      expect(realLink!.tagName).toBe("A");
      expect(host.querySelector('[data-testid="board-card"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
    expect(host.querySelector('[data-testid="board-card-address"]')).not.toBeNull();
    const time = host.querySelector('[data-testid="board-card-deadline"]')!;
    expect(time.textContent).toBe("Due Tue 1 Jan · 09:15");
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
      const time = host.querySelector('[data-testid="board-card-deadline"]')!;
      expect(time.textContent).toBe("Overdue Thu 27 Aug · 09:15");
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it("renders the literal word 'Overdue' and the critical colour token for an overdue deadline", async () => {
    const deadlineAt = Date.now() - 60 * 60 * 1000;
    await renderCard({ deadlineAt, deadlineLocalCivil: "2020-01-01T00:00", deadlineZone: "Australia/Sydney" });
    expect(host.querySelector('[data-testid="board-card-address"]')).not.toBeNull();
    const time = host.querySelector('[data-testid="board-card-deadline"]')!;
    expect(time.textContent).toContain("Overdue");
    expect(time.className).toContain("text-signal-critical");
  });

  it("renders 'Due', not 'Overdue', for a future deadline", async () => {
    const deadlineAt = Date.now() + 60 * 60 * 1000;
    await renderCard({ deadlineAt, deadlineLocalCivil: "2999-01-01T00:00", deadlineZone: "Australia/Sydney" });
    const time = host.querySelector('[data-testid="board-card-deadline"]')!;
    expect(time.textContent).toContain("Due");
    expect(time.textContent).not.toContain("Overdue");
    expect(time.className).not.toContain("text-signal-critical");
  });

  it("renders no Deadline element at all when the Project has none", async () => {
    await renderCard({ deadlineAt: null, deadlineLocalCivil: null, deadlineZone: null });
    expect(host.querySelector('[data-testid="board-card-address"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="board-card-deadline"]')).toBeNull();
  });

  it("renders no RAW count on the card at all (#432)", async () => {
    await renderCard({ receivedCount: 12, expectedCount: 40 });
    expect(host.querySelector('[data-testid="board-card-address"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="board-card-raw"]')).toBeNull();
    expect(host.querySelector('[data-testid="board-card-wrap"]')!.textContent).not.toMatch(/12\/40|RAW files/);
  });

  it("renders three Editor avatars and no overflow indicator for exactly three Editors", async () => {
    const editors = [{ id: "e1", name: "Jane Doe" }, { id: "e2", name: "Ana Maria Lopes" }, { id: "e3", name: "Sam Lee" }];
    await renderCard({ editors });
    expect(host.querySelector('[data-testid="board-card-address"]')).not.toBeNull();
    const meta = host.querySelector('[data-testid="board-card-meta"]')!;
    const avatars = meta.querySelectorAll('[role="img"]');
    expect(avatars).toHaveLength(3);
    for (const editor of editors) {
      expect(meta.querySelector(`[role="img"][aria-label="${editor.name}"]`)).not.toBeNull();
    }
    expect(meta.querySelector('[aria-label*="more Editor"]')).toBeNull();
  });

  it("renders two Editor avatars plus a '+3' overflow named '3 more Editors' for five Editors", async () => {
    const editors = [
      { id: "e1", name: "Jane Doe" },
      { id: "e2", name: "Ana Maria Lopes" },
      { id: "e3", name: "Sam Lee" },
      { id: "e4", name: "Kim Park" },
      { id: "e5", name: "Lee Nguyen" },
    ];
    await renderCard({ editors });
    const meta = host.querySelector('[data-testid="board-card-meta"]')!;
    // No `data-slot` selector (that's the vendor's own hook, not ours) — the overflow indicator is
    // distinguished by its accessible name instead.
    const allImgs = [...meta.querySelectorAll('[role="img"]')];
    const shown = allImgs.filter((element) => !(element.getAttribute("aria-label") ?? "").includes("more Editor"));
    expect(shown).toHaveLength(2);
    const overflow = meta.querySelector('[role="img"][aria-label="3 more Editors"]')!;
    expect(overflow).not.toBeNull();
    expect(overflow.querySelector('[aria-hidden="true"]')?.textContent).toBe("+3");
  });

  it("renders no overflow indicator for a single Editor", async () => {
    await renderCard({ editors: [{ id: "e1", name: "Jane Doe" }] });
    const meta = host.querySelector('[data-testid="board-card-meta"]')!;
    expect(meta.querySelectorAll('[role="img"]')).toHaveLength(1);
    expect(meta.querySelector('[aria-label*="more Editor"]')).toBeNull();
  });

  it("renders no avatar slot at all for an empty Editors array", async () => {
    await renderCard({ editors: [] });
    expect(host.querySelector('[data-testid="board-card-meta"]')).toBeNull();
    expect(host.querySelector('[aria-label="No Editor assigned"]')).toBeNull();
  });

  it("renders no avatar slot at all when Editors is absent", async () => {
    await renderCard({ editors: undefined });
    expect(host.querySelector('[data-testid="board-card-meta"]')).toBeNull();
    expect(host.querySelector('[aria-label="No Editor assigned"]')).toBeNull();
  });

  it("puts the Editor avatars in the footer row with the stars: stars first, avatars last, outside the link", async () => {
    await renderBoard({ projects: [project("source", "awaiting_raw", { editors: [{ id: "e1", name: "Jane Doe" }], priority: 3 })], canPrioritize: true });
    const footer = host.querySelector('[data-testid="board-card-footer-slot"]')!;
    const meta = footer.querySelector('[data-testid="board-card-meta"]');
    expect(meta, "avatars live in the footer row").not.toBeNull();
    expect(footer.lastElementChild).toBe(meta);
    expect(footer.firstElementChild).not.toBe(meta);
    expect(host.querySelector('[data-testid="board-card"]')!.contains(footer)).toBe(false);
  });

  // #432: the link is now the street alone and sits in the card's content block, so the slot is no
  // longer its next sibling; what #81 needed is unchanged — the star slot exists and is OUTSIDE the link.
  it("leaves the #81 footer-slot boundary present, empty and outside the card's link", async () => {
    await renderCard();
    const link = host.querySelector('[data-testid="board-card"]')!;
    const slot = host.querySelector('[data-testid="board-card-footer-slot"]')!;
    expect(slot).not.toBeNull();
    expect(slot.textContent).toBe("");
    expect(link.contains(slot)).toBe(false);
    expect(slot.closest("a")).toBeNull();
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
      // #99 gave this Board a Move-to control, so the instructions now point to it. (Before that they
      // deliberately did not: promising a control that does not exist sends a user looking for it.)
      // #432: Space picks up, Enter opens, and the rest lives in the card's Actions menu.
      expect(accessibility!.screenReaderInstructions?.draggable).toContain("Press Enter to open it");
      expect(accessibility!.screenReaderInstructions?.draggable).toContain("Actions menu");
      expect(host.querySelector('[data-focus-key="card-menu:source"]'), "the instructions promise a menu that is not rendered").not.toBeNull();
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
      expect(announcements.onDragOver(hover)).toBe("source Street is over RAW review; it will land at position 2 of 2.");
      // A stationary hover fires this repeatedly; a live region would read it every time.
      expect(announcements.onDragOver(hover)).toBeUndefined();
      // Back over its own column is not news either.
      expect(announcements.onDragOver({ active: { id: "source" }, over: { id: "awaiting_raw" } })).toBeUndefined();
    });

    it("tells the user a same-Stage drop did not move, and gives the handle back", async () => {
      const props = await renderBoard();
      const handle = host.querySelector<HTMLAnchorElement>('[data-focus-key="card:source"]');
      expect(handle, "no handle to restore focus to").not.toBeNull();
      await fireDnd("onDragStart", { active: { id: "source" } });
      await endDrag("source", "source");

      expect(props.onBoardMove).not.toHaveBeenCalled();
      expect(props.onAnnounce).toHaveBeenCalledTimes(1);
      expect(props.onAnnounce).toHaveBeenCalledWith("source Street stays in Awaiting RAW. Columns are sorted by priority and shoot date.");
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
      const handle = host.querySelector<HTMLAnchorElement>('[data-focus-key="card:source"]');
      await fireDnd("onDragStart", { active: { id: "source" } });
      // An outside drop never reaches `onMove`, so the Board must handle it in drag-end.
      await fireDnd("onDragEnd", { active: { id: "source" }, over: null });

      expect(props.onBoardMove).not.toHaveBeenCalled();
      expect(props.onAnnounce).toHaveBeenCalledWith("Cancelled moving source Street. It remains in Awaiting RAW.");
      expect(document.activeElement).toBe(handle);
    });

    it("restores the handle on an Escape cancel, which the library no longer does", async () => {
      const props = await renderBoard();
      const handle = host.querySelector<HTMLAnchorElement>('[data-focus-key="card:source"]');
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

// #83: ports of `screens/dashboard-routing.test.ts:17` and `:25` onto `KanbanCard2`, which
// replaces them — the defect class is real (an interactive control inside an `<a>` is invalid HTML,
// and a click navigates instead of doing what the control promised), so the invariant is ported
// rather than retired along with the old Board's markup. Test ids, not the old `kcard` class
// regexes; the cover-retry button is reached through the real `onFailedChange` callback, via the
// `LazyImage` test double above, not a test-only `initialCoverFailed` prop.
describe("KanbanCard2 — anchor and interactive-control siblings (#83)", () => {
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

  it("keeps the cover-retry button a sibling of the project link, not inside it", async () => {
    await renderBoard({ projects: [project("source", "awaiting_raw", { coverAssetId: "asset-1" })] });
    const link = host.querySelector('[data-testid="board-card"]');
    expect(link, "no card link rendered — the assertion below would be vacuous").not.toBeNull();
    const retry = [...host.querySelectorAll("button")].find((node) => node.textContent === "Retry cover image");
    expect(retry, "no retry button rendered — the mocked LazyImage failure never reached the card").not.toBeUndefined();
    expect(retry!.closest("a")).toBeNull();
  });

  it("keeps the Board's non-drag control (the ⋯ menu trigger) outside the project link", async () => {
    await renderBoard({ canPrioritize: true });
    const link = host.querySelector('[data-testid="board-card"]');
    expect(link, "no card link rendered — the assertion below would be vacuous").not.toBeNull();
    const menu = cardMenuTrigger(host, "source");
    expect(menu, "no ⋯ trigger rendered — the assertion below would be vacuous").not.toBeNull();
    expect(menu!.closest("a")).toBeNull();
    expect(link!.contains(menu)).toBe(false);
  });
});

describe("ProjectKanbanBoard2 — reorder animation and the star-click guard (#304)", () => {
  let now = 10_000;

  beforeEach(() => {
    dnd.handlers.length = 0;
    flip.played.length = 0;
    now = 10_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    // A card's rect is its slot: 100px per card down its column, 300px per column across.
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getBoundingClientRect(this: HTMLElement) {
      const id = this.dataset.flipId;
      if (!id) return original.call(this);
      const column = this.dataset.flipColumn ?? "";
      const inColumn = [...document.querySelectorAll<HTMLElement>("[data-flip-id]")].filter((node) => node.dataset.flipColumn === column);
      const columnIndex = stages.findIndex((stage) => stage.key === column);
      return new DOMRect(columnIndex * 300, inColumn.indexOf(this) * 100, 254, 90);
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    const { act } = await import("react");
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  // Priority sort, one column: a(3) b(2) c(1). Raising c to 5 re-sorts it to the top.
  const column = (cPriority: number) => [
    project("a", "awaiting_raw", { priority: 3 }),
    project("b", "awaiting_raw", { priority: 2 }),
    project("c", "awaiting_raw", { priority: cPriority }),
  ];
  /** A pointer commit on c's 5th star, then the optimistic re-sort that lifts c to the top. */
  async function commitAndResort(props: ProjectKanbanBoardProps, at = { x: 200, y: 230 }) {
    await clickStar("c Street", 5, at);
    now += 50;
    await renderBoard({ ...props, projects: column(5) });
  }
  const played = () => flip.played.map(({ element, dx, dy }) => ({ id: element.dataset.flipId, dx, dy }));

  async function clickStar(projectStreet: string, stars: number, at: { x: number; y: number }) {
    const { act } = await import("react");
    const group = [...host.querySelectorAll('[role="radiogroup"]')].find((node) => node.getAttribute("aria-label") === `Priority for ${projectStreet}`);
    const star = group?.querySelectorAll<HTMLElement>('[role="radio"]')[stars - 1];
    expect(star, `no ${stars}-star control for ${projectStreet}`).not.toBeNull();
    await act(async () => {
      star!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y }));
      await Promise.resolve();
    });
  }

  it("slides the re-sorted card from its old slot and the cards it passed, on the Board-owned wrapper", async () => {
    await renderBoard({ canPrioritize: true, projects: column(1) });
    await renderBoard({ canPrioritize: true, projects: column(5) });
    expect(played()).toEqual([
      { id: "c", dx: 0, dy: 200 },
      { id: "a", dx: 0, dy: -100 },
      { id: "b", dx: 0, dy: -100 },
    ]);
    // Never dnd-kit's own node: React owns `KanbanItem`'s transform, and dnd-kit measures it.
    expect(flip.played[0]!.element.getAttribute("data-slot")).toBeNull();
    const item = flip.played[0]!.element.parentElement as HTMLElement;
    expect(item.style.transform).toBe("");
  });

  it("animates a two-card swap from a data change the same way", async () => {
    const pair = (aPriority: number, bPriority: number) => [project("a", "awaiting_raw", { priority: aPriority }), project("b", "awaiting_raw", { priority: bPriority })];
    await renderBoard({ projects: pair(2, 1) });
    await renderBoard({ projects: pair(2, 3) });
    expect(played()).toEqual([{ id: "b", dx: 0, dy: 100 }, { id: "a", dx: 0, dy: -100 }]);
  });

  it("lifts only the card travelling farthest, so the one moving up passes over the ones moving down", async () => {
    await renderBoard({ canPrioritize: true, projects: column(1) });
    await renderBoard({ canPrioritize: true, projects: column(5) });
    expect(flip.played.map(({ element, lift }) => ({ id: element.dataset.flipId, lift }))).toEqual([
      { id: "c", lift: true },
      { id: "a", lift: false },
      { id: "b", lift: false },
    ]);
  });

  it("does not animate under reduced motion, but still guards the click that lands on the card that jumped in", async () => {
    const restore = mockMatchMedia(true);
    try {
      const props = await renderBoard({ canPrioritize: true, projects: column(1) });
      await commitAndResort(props);
      expect(played()).toEqual([]);
      now += 200;
      await clickStar("b Street", 4, { x: 202, y: 228 });
      expect(props.onPriorityChange).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("does not animate during a drag, nor in the drop's own commit — dnd-kit owns those", async () => {
    const { act } = await import("react");
    await renderBoard({ canPrioritize: true, projects: column(1) });
    await fireDnd("onDragStart", { active: { id: "c" } });
    await renderBoard({ canPrioritize: true, projects: column(4) });
    const props = baseProps({ canPrioritize: true, projects: column(5) });
    await act(async () => {
      (dnd.handlers.at(-1)?.props?.onDragEnd as (event: unknown) => void)({ active: { id: "c" }, over: null });
      root.render(createElement(ProjectKanbanBoard2, props));
      await Promise.resolve();
    });
    expect(played()).toEqual([]);
  });

  it("does not fly a card that changed column", async () => {
    await renderBoard({ projects: [project("a", "awaiting_raw", { boardRank: 0 }), project("b", "awaiting_raw", { boardRank: 1 })] });
    await renderBoard({ projects: [project("a", "raw_review", { boardRank: 0 }), project("b", "awaiting_raw", { boardRank: 1 })] });
    expect(played().map((entry) => entry.id)).not.toContain("a");
  });

  it("drops a quick second click at the same spot when it lands on the card that slid under it", async () => {
    const props = await renderBoard({ canPrioritize: true, projects: column(1) });
    await commitAndResort(props);
    expect(props.onPriorityChange).toHaveBeenCalledTimes(1);
    expect(played().length, "no re-sort played — the guard below would be vacuous").toBeGreaterThan(0);
    now += 200;
    // b slid into c's old slot; the pointer has not moved.
    await clickStar("b Street", 4, { x: 202, y: 228 });
    expect(props.onPriorityChange).toHaveBeenCalledTimes(1);
  });

  it("lets a deliberate click elsewhere and a later click through", async () => {
    const props = await renderBoard({ canPrioritize: true, projects: column(1) });
    await commitAndResort(props);
    await clickStar("b Street", 4, { x: 200, y: 330 });
    expect(props.onPriorityChange).toHaveBeenCalledTimes(2);

    await renderBoard({ ...props, projects: column(1) });
    await commitAndResort(props);
    now += STAR_GUARD_WINDOW_MS + 100;
    await clickStar("b Street", 4, { x: 200, y: 230 });
    expect(props.onPriorityChange).toHaveBeenCalledTimes(4);
  });

  it("never treats a keyboard commit as a pointer one, even after a click that stopped short of the Board", async () => {
    const { act } = await import("react");
    const props = await renderBoard({ canPrioritize: true, projects: column(1) });
    await commitAndResort(props);
    // A click inside the Board whose bubble never reaches it leaves its capture-phase point behind.
    const heading = host.querySelector('[data-focus-key="stage-heading:awaiting_raw"]') as HTMLElement;
    heading.addEventListener("click", (event) => event.stopPropagation(), { once: true });
    await act(async () => {
      heading.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 200, clientY: 230 }));
      await Promise.resolve();
    });
    const star = host.querySelector('[aria-label="Priority for b Street"] [role="radio"][tabindex="0"]') as HTMLElement;
    star.focus();
    await act(async () => {
      star.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(props.onPriorityChange).toHaveBeenCalledTimes(2);
  });

  it("does not arm when the move that played did not carry the committed card", async () => {
    const props = await renderBoard({ canPrioritize: true, projects: column(1) });
    // a stays first at 4 stars, while b and c swap in the same render (a refetch landing).
    await clickStar("a Street", 4, { x: 200, y: 230 });
    now += 50;
    await renderBoard({ ...props, projects: [project("a", "awaiting_raw", { priority: 4 }), project("b", "awaiting_raw", { priority: 1 }), project("c", "awaiting_raw", { priority: 2 })] });
    expect(played().map((entry) => entry.id), "no move played — the assertion below would be vacuous").toEqual(["c", "b"]);
    await clickStar("c Street", 3, { x: 200, y: 230 });
    expect(props.onPriorityChange).toHaveBeenCalledTimes(2);
  });

  it("disarms the guard on any scroll", async () => {
    const { act } = await import("react");
    const props = await renderBoard({ canPrioritize: true, projects: column(1) });
    await commitAndResort(props);
    const viewport = host.querySelector('[data-testid="board-scroll-viewport"]') as HTMLElement;
    await act(async () => {
      viewport.dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });
    await clickStar("b Street", 4, { x: 200, y: 230 });
    expect(props.onPriorityChange).toHaveBeenCalledTimes(2);
  });

  it("disarms the guard once the pointer moves away", async () => {
    const { act } = await import("react");
    const props = await renderBoard({ canPrioritize: true, projects: column(1) });
    await commitAndResort(props);
    const board = host.querySelector('[data-focus-key="board"]') as HTMLElement;
    await act(async () => {
      board.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 200, clientY: 300 }));
      board.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 200, clientY: 230 }));
      await Promise.resolve();
    });
    await clickStar("b Street", 4, { x: 200, y: 230 });
    expect(props.onPriorityChange).toHaveBeenCalledTimes(2);
  });
});

describe("Board card on ReUI frame (#432)", () => {
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
    vi.restoreAllMocks();
  });

  const cardOf = (id = "source") => host.querySelector<HTMLElement>(`[data-focus-key="card:${id}"]`)!.closest<HTMLElement>('[data-testid="board-card-wrap"]')!;

  it("shows exactly: cover, street (no suburb), Shoot date, Deadline, stars and avatars — no RAW", async () => {
    const future = Date.now() + 3 * 24 * 60 * 60 * 1000;
    await renderBoard({
      canPrioritize: true,
      projects: [project("source", "awaiting_raw", {
        street: "12 Example St",
        suburb: "Bondi",
        shootDate: "2027-03-12",
        deadlineAt: future,
        deadlineLocalCivil: "2999-01-01T09:15",
        deadlineZone: "Australia/Sydney",
        receivedCount: 12,
        expectedCount: 40,
        priority: 3,
        editors: [{ id: "e1", name: "Jane Doe" }],
      })],
    });
    const card = cardOf();
    expect(card.querySelector('[data-testid="board-card-address"]')?.textContent).toBe("12 Example St");
    expect(card.querySelector('[data-testid="board-card"]')?.textContent).toBe("12 Example St");
    expect(card.querySelector('[data-testid="board-card-shoot"]')?.textContent).toBe("Shoot 12 Mar 2027");
    expect(card.querySelector('[data-testid="board-card-deadline"]')?.textContent).toBe("Due Tue 1 Jan · 09:15");
    expect(card.querySelector('[role="radiogroup"][aria-label="Priority for 12 Example St"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="board-card-meta"] [role="img"][aria-label="Jane Doe"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="board-card-cover"]')?.textContent, "no cover rendered").toBe("1");
    expect(card.textContent).not.toContain("Bondi");
    expect(card.textContent).not.toMatch(/RAW|12\/40|⠿|↑|↓/);
    expect(card.querySelector('[data-testid="board-card-raw"]')).toBeNull();
  });

  it("omits the Shoot line when there is no Shoot date", async () => {
    await renderBoard({ projects: [project("source", "awaiting_raw", { shootDate: null })] });
    expect(cardOf().querySelector('[data-testid="board-card-address"]')).not.toBeNull();
    expect(cardOf().querySelector('[data-testid="board-card-shoot"]')).toBeNull();
    expect(cardOf().textContent).not.toContain("Shoot");
  });

  it("is red and says Overdue only for an active Project past its Deadline, judged against the `now` it is given", async () => {
    const deadlineAt = Date.parse("2026-09-01T00:00:00.000Z");
    const common = { deadlineAt, deadlineLocalCivil: "2026-09-01T10:00", deadlineZone: "Australia/Sydney" as const };
    const deadlineOf = (id: string) => cardOf(id).querySelector('[data-testid="board-card-deadline"]')!;
    await renderBoard({
      now: deadlineAt + 1000,
      projects: [
        project("active", "awaiting_raw", common),
        project("delivered", "delivered", common),
        project("archived", "awaiting_raw", { ...common, archivedAt: "2026-09-02T00:00:00.000Z" }),
      ],
      activeStages: [...stages, { key: "delivered", label: "Delivered", displayOrder: 3, active: true }],
    });
    expect(deadlineOf("active").textContent).toContain("Overdue");
    expect(deadlineOf("active").className).toContain("text-signal-critical");
    for (const id of ["delivered", "archived"]) {
      expect(deadlineOf(id).textContent, `${id} must not read Overdue`).toContain("Due");
      expect(deadlineOf(id).className, `${id} must not be red`).not.toContain("text-signal-critical");
    }
    // The same Project is not overdue against an earlier clock.
    await renderBoard({ now: deadlineAt - 1000, projects: [project("active", "awaiting_raw", common)] });
    expect(deadlineOf("active").textContent).toContain("Due");
  });

  it("marks an Archived card, keeps its link, and never lets it be dragged or prioritised (#428, #432)", async () => {
    const props = await renderBoard({
      canPrioritize: true,
      projects: [project("source", "awaiting_raw", { archivedAt: "2026-09-02T00:00:00.000Z", priority: 2 }), project("other", "raw_review")],
    });
    const card = cardOf();
    expect(card.querySelector('[data-testid="board-card-archived"]')?.textContent).toBe("Archived");
    const link = card.querySelector('[data-testid="board-card"]')!;
    expect(link.getAttribute("href")).toBe("/projects/source");
    expect(isLocked(link)).toBe(true);
    expect(link.className).not.toContain("cursor-grab");
    // Priority is read-only on an archived card: no radiogroup, an image instead.
    expect(card.querySelector('[role="radiogroup"]')).toBeNull();
    expect(card.querySelector('[role="img"][aria-label="Priority 2 of 5 stars"]')).not.toBeNull();
    await endDrag("source", "raw_review");
    expect(props.onBoardMove).not.toHaveBeenCalled();
  });

  describe("click after a drag (#432)", () => {
    // `InternalLink` only intercepts a destination the staff route grammar accepts, which needs a UUID.
    const guardId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
    it("is swallowed outright — default prevented, never reaching the anchor's own handler — then released", async () => {
      const { locationStore } = await import("../../lib/router");
      const push = vi.spyOn(locationStore(), "push").mockImplementation(() => undefined);
      await renderBoard({ projects: [project(guardId, "awaiting_raw"), project("other", "raw_review")] });
      const link = host.querySelector<HTMLAnchorElement>('[data-testid="board-card"]')!;
      const click = () => {
        const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
        link.dispatchEvent(event);
        return event;
      };
      // Before any drag: an ordinary click is the SPA navigation.
      expect(click().defaultPrevented).toBe(true);
      expect(push).toHaveBeenCalledTimes(1);
      push.mockClear();

      await fireDnd("onDragStart", { active: { id: guardId } });
      await fireDnd("onDragEnd", { active: { id: guardId }, over: { id: "raw_review" } });
      // The click that follows the drop: swallowed, no navigation of any kind.
      const swallowed = click();
      expect(swallowed.defaultPrevented).toBe(true);
      expect(push).not.toHaveBeenCalled();

      await new Promise((resolve) => setTimeout(resolve, 160));
      push.mockClear();
      click();
      expect(push, "the guard never released — every later click is dead").toHaveBeenCalledTimes(1);
    });

    it("swallows only a click on a link — the Board's other controls stay clickable while it is up", async () => {
      await renderBoard({ canPrioritize: true, projects: [project(guardId, "awaiting_raw"), project("other", "raw_review")] });
      await fireDnd("onDragStart", { active: { id: guardId } });
      await fireDnd("onDragEnd", { active: { id: guardId }, over: null });
      const star = host.querySelector<HTMLElement>('[role="radio"][aria-label="1 star"]')!;
      expect(star, "no star rendered — the assertion below would be vacuous").not.toBeNull();
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      star.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 160));
    });

    it("is swallowed after a cancelled drag as well, and removed when the Board unmounts mid-drag", async () => {
      const { locationStore } = await import("../../lib/router");
      const push = vi.spyOn(locationStore(), "push").mockImplementation(() => undefined);
      await renderBoard({ projects: [project(guardId, "awaiting_raw"), project("other", "raw_review")] });
      const link = host.querySelector<HTMLAnchorElement>('[data-testid="board-card"]')!;
      await fireDnd("onDragStart", { active: { id: guardId } });
      await fireDnd("onDragCancel", { active: { id: guardId } });
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(push).not.toHaveBeenCalled();

      await new Promise((resolve) => setTimeout(resolve, 160));
      await fireDnd("onDragStart", { active: { id: guardId } });
      const { act } = await import("react");
      await act(async () => root.unmount());
      root = createRoot(host);
      const afterUnmount = new MouseEvent("click", { bubbles: true, cancelable: true });
      document.body.dispatchEvent(afterUnmount);
      expect(afterUnmount.defaultPrevented, "the unmounted Board's guard is still on the window").toBe(false);
    });
  });
});

// #432: the card's ⋯ menu and right-click menu are one descriptor list through two renderers, so the
// two must always offer the same things, per capability.
describe("KanbanCard2 — ⋯ and right-click menus (#432)", () => {
  const column = () => [
    project("top", "awaiting_raw", {}),
    project("mid", "awaiting_raw", { boardRank: 1 }),
    project("low", "awaiting_raw", { boardRank: 2 }),
  ];
  const wrap = (id: string) => [...host.querySelectorAll('[data-testid="board-card-wrap"]')].find((node) => node.querySelector(`[data-focus-key="card:${id}"]`));
  const labels = () => menuItems().map((node) => node.textContent);

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

  const principals: Array<[string, Partial<ProjectKanbanBoardProps>]> = [
    ["Admin (Stage moves and Priority)", { canMoveStages: true, canPrioritize: true }],
    ["Editor (Stage moves only)", { canMoveStages: true }],
  ];

  for (const [name, overrides] of principals) {
    it(`offers only a Move to submenu from the ⋯ trigger and from a right-click: ${name}`, async () => {
      await renderBoard({ projects: column(), role: "admin", ...overrides });
      await openCardMenu(host, "mid");
      expect(labels()).toEqual(["Move to"]);
      await closeMenus();
      await openContextMenu(wrap("mid")!);
      expect(labels()).toEqual(["Move to"]);
      await closeMenus();
    });
  }

  it("lists every active Stage as a menuitemradio with the card's own Stage checked and disabled, from either menu", async () => {
    for (const open of [() => openCardMenu(host, "mid"), () => openContextMenu(wrap("mid")!)]) {
      await renderBoard({ projects: column(), role: "admin", canMoveStages: true });
      await open();
      await openMoveToSubmenu();
      expect(stageRadios().map((node) => node.textContent)).toEqual(["Awaiting RAW", "RAW review"]);
      const current = stageRadio("Awaiting RAW")!;
      expect(current.getAttribute("aria-checked")).toBe("true");
      expect(isMenuItemDisabled(current)).toBe(true);
      expect(stageRadio("RAW review")!.getAttribute("aria-checked")).toBe("false");
      expect(isMenuItemDisabled(stageRadio("RAW review")!)).toBe(false);
      await closeMenus();
    }
  });

  it("offers no Move up, Move down, dialog or position step", async () => {
    await renderBoard({ projects: column(), role: "admin", canMoveStages: true, canPrioritize: true });
    await openCardMenu(host, "mid");
    expect(menuItem("Move up")).toBeNull();
    expect(menuItem("Move down")).toBeNull();
    await openMoveToSubmenu();
    await act_(async () => { stageRadio("RAW review")!.click(); await Promise.resolve(); });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="option"]')).toBeNull();
  });

  it("selecting a Stage reports an append-style move to that Stage, from the ⋯ menu and from the right-click menu", async () => {
    const props = await renderBoard({ projects: column(), role: "admin", canMoveStages: true });
    await moveToStage(host, "mid", "RAW review");
    expect(props.onMoveStage).toHaveBeenCalledTimes(1);
    const [moved, target, descriptor] = (props.onMoveStage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect([moved.id, target]).toEqual(["mid", "raw_review"]);
    expect(descriptor).toMatchObject({ path: "move-to", projectId: "mid", control: "move-to", sourceStageKey: "awaiting_raw" });
    await openContextMenu(wrap("low")!);
    await openMoveToSubmenu();
    await act_(async () => { stageRadio("RAW review")!.click(); await Promise.resolve(); });
    expect((props.onMoveStage as ReturnType<typeof vi.fn>).mock.calls[1]![0].id).toBe("low");
  });

  it("selecting the card's current Stage moves nothing", async () => {
    const props = await renderBoard({ projects: column(), role: "admin", canMoveStages: true });
    await openMoveTo(host, "mid");
    await act_(async () => { stageRadio("Awaiting RAW")!.click(); await Promise.resolve(); });
    expect(props.onMoveStage).not.toHaveBeenCalled();
  });

  it("keeps the ⋯ visible but disabled while movement is switched off for a principal who can move Stages", async () => {
    await renderBoard({ projects: column(), role: "admin", canMoveStages: false, menuCapable: true });
    expect(cardMenuTrigger(host, "mid"), "no ⋯ trigger rendered").not.toBeNull();
    expect(cardMenuTrigger(host, "mid")!.disabled).toBe(true);
  });

  it("disables the Move to trigger when no Stage can be chosen", async () => {
    // One active Stage only: the card's own, so every choice is disabled.
    await renderBoard({ projects: column(), role: "admin", canMoveStages: true, activeStages: [stages[0]!] });
    await openCardMenu(host, "mid");
    expect(isMenuItemDisabled(moveToTrigger()!)).toBe(true);
  });

  // #306: a priority save locks only the saving card. Another card's pending write must not lock a
  // card's Move to, and its own must - from the ⋯ menu and from the right-click menu alike.
  describe("Move to under a pending priority write (#306)", () => {
    it("stays enabled on a card while ANOTHER card's priority write is pending, from the ⋯ and right-click menus", async () => {
      await renderBoard({ projects: column(), role: "admin", canMoveStages: true, pendingOrdering: new Set(["top"]) });
      expect(cardMenuTrigger(host, "mid"), "no ⋯ trigger rendered").not.toBeNull();
      expect(cardMenuTrigger(host, "mid")!.disabled).toBe(false);
      await openCardMenu(host, "mid");
      expect(moveToTrigger(), "no Move to rendered").not.toBeNull();
      expect(isMenuItemDisabled(moveToTrigger()!)).toBe(false);
      await openMoveToSubmenu();
      expect(isMenuItemDisabled(stageRadio("RAW review")!)).toBe(false);
      await closeMenus();
      await openContextMenu(wrap("mid")!);
      expect(moveToTrigger(), "no Move to rendered").not.toBeNull();
      expect(isMenuItemDisabled(moveToTrigger()!)).toBe(false);
      await closeMenus();
    });

    it("is unavailable on a card while its OWN priority write is pending, from the ⋯ and right-click menus", async () => {
      await renderBoard({ projects: column(), role: "admin", canMoveStages: true, pendingOrdering: new Set(["mid"]) });
      expect(cardMenuTrigger(host, "mid"), "no ⋯ trigger rendered").not.toBeNull();
      expect(cardMenuTrigger(host, "mid")!.disabled).toBe(true);
      await openContextMenu(wrap("mid")!);
      expect(moveToTrigger(), "no Move to rendered").not.toBeNull();
      expect(isMenuItemDisabled(moveToTrigger()!)).toBe(true);
      await closeMenus();
    });
  });

  it("renders no ⋯ and no right-click menu for a principal with nothing to offer", async () => {
    await renderBoard({ projects: column(), canMoveStages: false });
    expect(cardMenuTrigger(host, "mid")).toBeNull();
    await act_(async () => { wrap("mid")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("gives an Archived card no ⋯, no context menu and no drag, but keeps the Archived mark and the link", async () => {
    await renderBoard({ projects: [project("source", "awaiting_raw", { archivedAt: "2026-09-02T00:00:00.000Z" }), project("other", "raw_review")], canPrioritize: true });
    expect(cardMenuTrigger(host, "source")).toBeNull();
    expect(host.querySelector('[data-testid="board-card-archived"]')?.textContent).toBe("Archived");
    expect(host.querySelector('[data-focus-key="card:source"]'), "the link still opens the project").not.toBeNull();
    await act_(async () => { host.querySelector('[data-focus-key="card:source"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("disables the right-click menu for the whole of a drag", async () => {
    await renderBoard({ projects: column(), canMoveStages: true });
    await fireDnd("onDragStart", { active: { id: "top" } });
    await act_(async () => { wrap("mid")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await fireDnd("onDragCancel", { active: { id: "top" } });
  });
});

async function act_(callback: () => Promise<void> | void): Promise<void> {
  const { act } = await import("react");
  await act(async () => { await callback(); await Promise.resolve(); });
}

// #432: the column header's count and overdue figure, and the collapsed rail.
describe("ProjectKanbanBoard2 — column headers and collapse (#432)", () => {
  /** The class string of the Dashboard header's "N OVERDUE" Badge, rendered by `DashboardHeader` itself. */
  async function headerOverdueClass(): Promise<string> {
    const { act } = await import("react");
    const { DashboardHeader } = await import("../../screens/DashboardHeader");
    const probe = document.createElement("div");
    document.body.append(probe);
    const probeRoot = createRoot(probe);
    await act(async () => { probeRoot.render(createElement(DashboardHeader, { summary: { text: "x", overdue: 1 } as never, busy: false, canCreateProject: false })); await Promise.resolve(); });
    const className = probe.querySelector('[data-testid="dashboard-overdue-badge"]')!.className;
    await act(async () => probeRoot.unmount());
    probe.remove();
    return className;
  }

  const NOW = Date.UTC(2026, 8, 10);
  const PAST = NOW - 86_400_000;
  const FUTURE = NOW + 86_400_000;

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

  const column = (stage: string) => [...host.querySelectorAll<HTMLElement>('[data-testid="board-column"]')].find((node) => node.textContent?.includes(stage));
  const mixed = () => [
    project("late", "awaiting_raw", { deadlineAt: PAST }),
    project("later", "awaiting_raw", { deadlineAt: PAST - 1000 }),
    project("ontime", "awaiting_raw", { deadlineAt: FUTURE }),
    // Archived Projects are never overdue (`isOverdueProject`), however late their deadline.
    project("archived-late", "raw_review", { deadlineAt: PAST, archivedAt: "2026-09-02T00:00:00.000Z" }),
    project("review-late", "raw_review", { deadlineAt: PAST }),
  ];

  it("shows each column's project count and 'N overdue' only when N > 0, in the red signal token", async () => {
    await renderBoard({ projects: mixed(), now: NOW });
    const first = column("Awaiting RAW")!;
    expect(first.querySelector('[data-testid="board-column-count"]')?.textContent).toBe("3");
    const overdue = first.querySelector('[data-testid="board-column-overdue"]');
    expect(overdue?.textContent).toBe("2 overdue");
    // The Dashboard header's badge: same component and variant, so the two read as one signal.
    expect(overdue!.className).toBe(await headerOverdueClass());
    const second = column("RAW review")!;
    expect(second.querySelector('[data-testid="board-column-count"]')?.textContent).toBe("2");
    expect(second.querySelector('[data-testid="board-column-overdue"]')?.textContent, "an archived late Project counted as overdue").toBe("1 overdue");

    await renderBoard({ projects: [project("ontime", "awaiting_raw", { deadlineAt: FUTURE })], now: NOW });
    expect(column("Awaiting RAW")!.querySelector('[data-testid="board-column-overdue"]')).toBeNull();
  });

  it("lays each header out as two rows: index and full stage name, then count, overdue and the toggle", async () => {
    await renderBoard({ projects: mixed(), now: NOW, collapsedStageKeys: [], onToggleStageCollapsed: vi.fn() });
    const headers = [...host.querySelectorAll<HTMLElement>('[data-testid="board-column"] [data-focus-key^="stage-heading:"]')];
    expect(headers.length).toBeGreaterThan(1);
    for (const header of headers) {
      const titleRow = header.querySelector<HTMLElement>('[data-testid="board-column-title-row"]')!;
      const statsRow = header.querySelector<HTMLElement>('[data-testid="board-column-stats-row"]')!;
      expect(titleRow.firstElementChild!.textContent, "the index leads row 1").toMatch(/^\d\d$/);
      expect(titleRow.querySelector('[title]'), "the full stage name stays available on hover").not.toBeNull();
      expect(titleRow.querySelector('[data-testid="board-column-count"]')).toBeNull();
      expect(titleRow.querySelector("button")).toBeNull();
      expect(statsRow.querySelector('[data-testid="board-column-count"]')).not.toBeNull();
      expect(statsRow.lastElementChild!.querySelector('[aria-label^="Collapse "]'), "the toggle ends row 2").not.toBeNull();
      expect(statsRow.textContent).not.toContain(titleRow.querySelector('[title]')!.textContent!);
    }
    const lateStats = column("Awaiting RAW")!.querySelector('[data-testid="board-column-stats-row"]')!;
    expect(lateStats.querySelector('[data-testid="board-column-overdue"]'), "the overdue badge sits on row 2").not.toBeNull();
  });

  it("column overdue figures sum to the Dashboard header's figure under the same clock", async () => {
    const { dashboardSummary } = await import("../../lib/dashboard-summary");
    const projects = mixed();
    await renderBoard({ projects, now: NOW });
    const total = [...host.querySelectorAll('[data-testid="board-column-overdue"]')].reduce((sum, node) => sum + Number.parseInt(node.textContent ?? "0", 10), 0);
    const summary = dashboardSummary({ projects: projects as never, archived: "hide", searchActive: false, searchTotal: null, shown: projects.length, now: NOW });
    expect(total, "anchor: something is overdue").toBeGreaterThan(0);
    expect(total).toBe(summary!.overdue);
  });

  it("collapses to a rail that is still a column, with no cards, a vertical label, and the Stage heading focus key", async () => {
    const onToggleStageCollapsed = vi.fn();
    await renderBoard({ projects: mixed(), now: NOW, collapsedStageKeys: ["awaiting_raw"], onToggleStageCollapsed });
    const rail = column("Awaiting RAW")!;
    expect(rail.getAttribute("data-collapsed")).toBe("true");
    expect(rail.querySelector('[data-testid="board-card"]'), "a collapsed Stage still mounts its cards").toBeNull();
    expect(rail.querySelector('[data-testid="board-column-count"]')?.textContent).toBe("3");
    expect(rail.querySelector('[data-testid="board-column-overdue"]')?.textContent).toContain("2");
    expect(rail.querySelector('[data-focus-key="stage-heading:awaiting_raw"]')?.getAttribute("tabindex")).toBe("-1");
    expect([...rail.classList]).toContain("w-12");
    expect(column("RAW review")!.getAttribute("data-collapsed"), "the other column stays expanded").toBeNull();

    const { act } = await import("react");
    const expand = rail.querySelector<HTMLButtonElement>('[aria-label="Expand Awaiting RAW"]')!;
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    await act(async () => { expand.click(); await Promise.resolve(); });
    expect(onToggleStageCollapsed).toHaveBeenCalledWith("awaiting_raw");
  });

  it("keeps keyboard focus on the toggle across a real collapse and expand", async () => {
    const { act, useState } = await import("react");
    function Stateful() {
      const [collapsed, setCollapsed] = useState<NonNullable<ProjectKanbanBoardProps["collapsedStageKeys"]>>([]);
      return createElement(ProjectKanbanBoard2, baseProps({
        projects: mixed(),
        now: NOW,
        collapsedStageKeys: collapsed,
        onToggleStageCollapsed: (key: NonNullable<ProjectKanbanBoardProps["collapsedStageKeys"]>[number]) => setCollapsed((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key])),
      }));
    }
    await act(async () => { root.render(createElement(Stateful)); await Promise.resolve(); });
    const collapse = host.querySelector<HTMLButtonElement>('[aria-label="Collapse Awaiting RAW"]')!;
    collapse.focus();
    expect(document.activeElement, "anchor: the Collapse button holds focus").toBe(collapse);
    await act(async () => { collapse.click(); await Promise.resolve(); });
    const expand = host.querySelector<HTMLButtonElement>('[aria-label="Expand Awaiting RAW"]')!;
    expect(expand, "anchor: the column collapsed").not.toBeNull();
    expect(document.activeElement, "focus fell off the unmounted Collapse button").toBe(expand);
    await act(async () => { expand.click(); await Promise.resolve(); });
    const collapseAgain = host.querySelector<HTMLButtonElement>('[aria-label="Collapse Awaiting RAW"]')!;
    expect(collapseAgain, "anchor: the column expanded").not.toBeNull();
    expect(document.activeElement, "focus fell off the unmounted Expand button").toBe(collapseAgain);
  });

  it("drops onto a collapsed rail move to that Stage", async () => {
    const props = await renderBoard({ projects: mixed(), now: NOW, collapsedStageKeys: ["raw_review"], onToggleStageCollapsed: vi.fn() });
    await endDrag("late", "raw_review");
    expect(props.onBoardMove).toHaveBeenCalledTimes(1);
    expect((props.onBoardMove as ReturnType<typeof vi.fn>).mock.calls[0]!.slice(0, 2)).toEqual(["late", "raw_review"]);
  });

  it("disables the collapse and expand controls for the whole of a drag, then gives them back", async () => {
    await renderBoard({ projects: mixed(), now: NOW, collapsedStageKeys: ["raw_review"], onToggleStageCollapsed: vi.fn() });
    const collapse = () => host.querySelector<HTMLButtonElement>('[aria-label="Collapse Awaiting RAW"]')!;
    const expand = () => host.querySelector<HTMLButtonElement>('[aria-label="Expand RAW review"]')!;
    expect(collapse().disabled, "anchor: enabled before the drag").toBe(false);
    await fireDnd("onDragStart", { active: { id: "late" } });
    expect(collapse().disabled).toBe(true);
    expect(expand().disabled).toBe(true);
    await fireDnd("onDragCancel", { active: { id: "late" } });
    expect(collapse().disabled).toBe(false);
    expect(expand().disabled).toBe(false);
  });
});
