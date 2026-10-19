// happy-dom cannot exercise real PointerSensor/KeyboardSensor drag activation: real activation
// constraints, collision geometry, autoscroll, scroll containers, browser focus timing and
// active-drag overlay rendering are all real-browser acceptance items, not unit-level ones. This
// test drives the captured `DndContext` handlers directly instead — the technique the Board this
// one replaced (deleted in #83) also used.
import { createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyboardSensor, MeasuringStrategy, MouseSensor, TouchSensor, type DragEndEvent } from "@dnd-kit/core";
import { ProjectKanbanBoard2, type ProjectKanbanBoard2Props } from "./board";
import { BoardSkeleton } from "./board-skeleton";
import { KanbanCard2 } from "./card";
import { STAR_GUARD_WINDOW_MS } from "../../lib/star-click-guard";
import { stageTone } from "../../lib/dashboard-appearance";
import { projectAppearance, stageGroupAppearance } from "../../lib/dashboard-project-appearance";
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
    ...overrides,
  };
}

function baseProps(overrides: Partial<ProjectKanbanBoard2Props> = {}): ProjectKanbanBoard2Props {
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
    sortMode: "shoot-date",
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

async function renderBoard(overrides: Partial<ProjectKanbanBoard2Props> = {}) {
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

  // Frame 4e (#923): the working columns are fluid (`flex-1`) over a 280px floor, so four of them fill a
  // 1440 screen beside the resting Delivered rail. `[contain:inline-size]` keeps a long street from widening
  // a column (its intrinsic width is the floor), so the `w-max min-w-full` row is exactly the screen until
  // the floors overflow it, and then it scrolls. Columns are separate bordered surfaces with a `--space-4`
  // gap (not a joined `bg-border` grid), inside a Base UI scroll area (tempo's `BoardScrollArea`). On a
  // phone each column is the viewport's width (`100cqw` of the `@container` viewport) and snaps.
  it("lays the Board out as fluid columns over a 280px floor, separated and bordered, in a full-width scroll area", async () => {
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
    // Fluid over a 280px floor, its intrinsic width contained; a phone column is the viewport's width.
    for (const column of columns) {
      for (const token of ["flex-1", "min-w-[17.5rem]", "[contain:inline-size]", "max-[721px]:w-[100cqw]", "max-[721px]:flex-none", "snap-start"]) expect([...column.classList]).toContain(token);
      expect([...column.classList]).not.toContain("w-[17.5rem]");
    }
    for (const token of ["@container", "max-[721px]:snap-x", "max-[721px]:snap-mandatory"]) expect([...viewport!.classList]).toContain(token);
  });

  // A phone snap would fight dnd-kit's auto-scroll, which steps the viewport a few pixels at a time; the
  // snap is off for the whole of a drag. Scroll-snap is not layout, so nothing in-flow changes.
  it("turns the phone column snap off for the whole of a drag", async () => {
    await renderBoard();
    const viewport = host.querySelector<HTMLElement>('[data-testid="board-scroll-viewport"]')!;
    expect(viewport.getAttribute("data-dragging")).toBeNull();
    expect([...viewport.classList]).toContain("data-[dragging=true]:snap-none");
    await fireDnd("onDragStart", { active: { id: "source" } });
    expect(viewport.getAttribute("data-dragging")).toBe("true");
    await fireDnd("onDragCancel", { active: { id: "source" } });
    expect(viewport.getAttribute("data-dragging")).toBeNull();
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

  // #923 D4: the compact card draws PriorityStars' small glyph; the hit cells are PriorityStars' own (its tests).
  it("draws the compact card's stars with the small glyph, editable and read-only alike (#923 D4)", async () => {
    await renderBoard({ canPrioritize: true, projects: [project("source", "awaiting_raw")] });
    const radios = [...host.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.length, "anchor: the editable stars").toBe(5);
    expect(radios.every((radio) => radio.classList.contains("text-sm"))).toBe(true);
    await renderBoard({ canPrioritize: false, projects: [project("source", "awaiting_raw", { priority: 3 })] });
    expect(host.querySelector<HTMLElement>('[role="img"][aria-label="Priority 3 of 5 stars"]')?.classList.contains("text-sm")).toBe(true);
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
    // t1 shoots Jan, t2 Mar, t3 undated: sorted t1, t2, t3. The mover (Feb) sorts between t1 and t2. Deadlines run the
    // other way round (t2 first, then t1, then the mover, t3 undated), so the chosen mode decides the slot.
    const targets = (moverDate: string | null = "2026-02-01") => [
      project("source", "awaiting_raw", { shootDate: moverDate, deadlineAt: 3_500 }),
      project("t1", "raw_review", { shootDate: "2026-01-01", deadlineAt: 3_000 }),
      project("t2", "raw_review", { shootDate: "2026-03-01", deadlineAt: 1_000 }),
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

    it("narrates the slot of the chosen date: the same hover lands elsewhere by Deadline (#830)", async () => {
      await renderBoard({ projects: targets(), sortMode: "due-date" });
      expect(capturedAnnouncements().onDragOver({ active: { id: "source" }, over: { id: "t3" } }))
        .toBe("source Street is over RAW review; it will land at position 3 of 4.");
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

    // #832: Delivered runs newest first, so a drop there lands at the newest-first slot.
    describe("into Delivered (#832)", () => {
      const withDelivered = { activeStages: [...stages, { key: "delivered" as const, label: "Delivered", displayOrder: 3, active: true }] };
      const deliveredTargets = () => [
        project("source", "awaiting_raw", { shootDate: "2026-06-01" }),
        project("d-old", "delivered", { shootDate: "2026-01-01" }),
        project("d-new", "delivered", { shootDate: "2026-09-01" }),
        project("d-none", "delivered"),
      ];

      it("narrates position N of M in newest-first order", async () => {
        await renderBoard({ projects: deliveredTargets(), ...withDelivered });
        expect(capturedAnnouncements().onDragOver({ active: { id: "source" }, over: { id: "d-none" } }))
          .toBe("source Street is over Delivered; it will land at position 2 of 4.");
      });

      it("marks the indicator ahead of the older card, not the newer one", async () => {
        await renderBoard({ projects: deliveredTargets(), ...withDelivered });
        await fireDnd("onDragStart", { active: { id: "source" } });
        await fireDnd("onDragOver", { active: { id: "source" }, over: { id: "d-new" } });
        const marks = [...host.querySelectorAll<HTMLElement>('[data-testid="board-drop-indicator"]')];
        expect(marks).toHaveLength(1);
        expect(marks[0]!.parentElement!.textContent).toContain("d-old Street");
        await fireDnd("onDragCancel", { active: { id: "source" } });
      });
    });

    // An undated mover sorts after every dated card, and ties break on street.
    const endTargets = () => [project("source", "awaiting_raw"), project("t1", "raw_review", { shootDate: "2026-01-01" }), project("a3", "raw_review")];

    it("lands an undated mover after the dated cards, at the end", async () => {
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

      it("marks the slot of the chosen date: by Deadline the mover sorts ahead of t3, not t2 (#830)", async () => {
        await renderBoard({ projects: targets(), sortMode: "due-date" });
        await fireDnd("onDragStart", { active: { id: "source" } });
        await hover("t3");
        expect(indicators()).toHaveLength(1);
        expect(indicators()[0]!.parentElement!.textContent).toContain("t3 Street");
        await fireDnd("onDragCancel", { active: { id: "source" } });
        await renderBoard({ projects: targets(), sortMode: "shoot-date" });
        await hover("t3");
        expect(indicators()[0]!.parentElement!.textContent).toContain("t2 Street");
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
        expect(props.onAnnounce).toHaveBeenCalledWith("s1 Street stays in Awaiting RAW. Columns are sorted by shoot date.");
        expect(document.activeElement).toBe(handle);
      }
    });

    it("names the chosen date in the refusal (#830)", async () => {
      const props = await renderBoard({ projects: column(), sortMode: "due-date" });
      await endDrag("s1", "s2");
      expect(props.onAnnounce).toHaveBeenCalledWith("s1 Street stays in Awaiting RAW. Columns are sorted by deadline.");
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

  it("offers editable Priority with the Board mutation flag off and no map fields at all; only the capability, a terminal Stage or an archived card make it read-only (#98, #475)", async () => {
    // Priority must NOT depend on `boardMutationEnabled` — that is the movement flag — and, since the Board
    // order is derived from the data (#470, #475), it does not depend on any server order map either.
    await renderBoard({ boardMutationEnabled: false, canPrioritize: true, projects: [project("source", "awaiting_raw", { priority: 2 })] });
    expect(host.querySelector('[data-testid="board-card-address"]'), "no card rendered — the assertions below would be vacuous").not.toBeNull();
    expect(host.querySelector('[role="radiogroup"]'), "Priority is gated on the movement flag or a map again").not.toBeNull();

    // Without the capability the stars are read-only: no radiogroup, a static image.
    await renderBoard({ boardMutationEnabled: true, canPrioritize: false, projects: [project("source", "awaiting_raw", { priority: 2 })] });
    expect(host.querySelector('[data-testid="board-card-address"]')).not.toBeNull();
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
      expect(time.textContent).toBe("Due Thu 27 Aug · 09:15");
    } finally {
      process.env.TZ = originalTz;
    }
  });

  // Frame 4e `.cd`: the date alone on screen ("Due" is for a screen reader), in the late colour with the
  // appearance module's "N days late" chip beside it once late. The chip's words are `lateLabel`'s.
  it("draws a late deadline in the late colour with the module's chip, and an on-time one in ink with no chip", async () => {
    const now = Date.parse("2026-10-19T03:00:00.000Z");
    const deadlineAt = Date.parse("2026-10-15T01:00:00.000Z");
    const late = project("source", "awaiting_raw", { deadlineAt, deadlineLocalCivil: "2026-10-15T12:00", deadlineZone: "Australia/Sydney" });
    await renderBoard({ now, projects: [late] });
    const time = host.querySelector('[data-testid="board-card-deadline"]')!;
    expect(time.querySelector('[data-testid="board-card-deadline-prefix"]')?.textContent).toBe("Due ");
    expect(time.textContent).toBe("Due Thu 15 Oct · 12:00");
    expect([...time.classList]).toContain("text-late");
    const chip = host.querySelector('[data-testid="board-card-wrap"] [data-testid="late-chip"]');
    expect(chip?.textContent).toBe(projectAppearance(late, now).lateLabel);
    expect(chip?.textContent).toBe("4 days late");
    expect(host.querySelector('[data-testid="board-card-wrap"]')!.getAttribute("data-late")).toBe("true");

    await renderBoard({ now, projects: [project("source", "awaiting_raw", { deadlineAt: now + 3 * 86_400_000, deadlineLocalCivil: "2026-10-22T14:00", deadlineZone: "Australia/Sydney" })] });
    const onTime = host.querySelector('[data-testid="board-card-deadline"]')!;
    expect(onTime.textContent).toBe("Due Thu 22 Oct · 14:00");
    expect([...onTime.classList]).not.toContain("text-late");
    expect(host.querySelector('[data-testid="board-card-wrap"] [data-testid="late-chip"]')).toBeNull();
    expect(host.querySelector('[data-testid="board-card-wrap"]')!.getAttribute("data-late")).toBeNull();
  });

  // Frame 4e `.due.is-today`: a Deadline later today reads "Today · 17:00" behind an ink dot.
  it("reads a Deadline later today as 'Today · HH:MM' with the dot, never late", async () => {
    const now = Date.parse("2026-10-19T01:00:00.000Z"); // 12:00 Sydney
    const deadlineAt = Date.parse("2026-10-19T06:00:00.000Z"); // 17:00 Sydney
    await renderBoard({ now, projects: [project("source", "editing", { deadlineAt, deadlineLocalCivil: "2026-10-19T17:00", deadlineZone: "Australia/Sydney" })], activeStages: [{ key: "editing", label: "Editing", displayOrder: 3, active: true }] });
    const time = host.querySelector('[data-testid="board-card-deadline"]')!;
    expect(time.textContent).toBe("Due Today · 17:00");
    expect(time.getAttribute("data-today")).toBe("true");
    expect(time.querySelector('[data-testid="board-card-today-dot"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="board-card-wrap"] [data-testid="late-chip"]')).toBeNull();
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
      expect(props.onAnnounce).toHaveBeenCalledWith("source Street stays in Awaiting RAW. Columns are sorted by shoot date.");
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

  // Shoot-date sort, one column: a, b, c. `column(true)` moves c's shoot date to the front, which re-sorts it to the top
  // (a refetch or another editor's change: a star click itself no longer moves a card, #830).
  const column = (cFirst: boolean) => [
    project("a", "awaiting_raw", { priority: 3, shootDate: "2026-01-02" }),
    project("b", "awaiting_raw", { priority: 2, shootDate: "2026-01-03" }),
    project("c", "awaiting_raw", { priority: cFirst ? 5 : 1, shootDate: cFirst ? "2026-01-01" : "2026-01-09" }),
  ];
  /** A pointer commit on c's 5th star, then the optimistic re-sort that lifts c to the top. */
  async function commitAndResort(props: ProjectKanbanBoardProps, at = { x: 200, y: 230 }) {
    await clickStar("c Street", 5, at);
    now += 50;
    await renderBoard({ ...props, projects: column(true) });
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
    await renderBoard({ canPrioritize: true, projects: column(false) });
    await renderBoard({ canPrioritize: true, projects: column(true) });
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
    const pair = (aDate: string, bDate: string) => [project("a", "awaiting_raw", { shootDate: aDate }), project("b", "awaiting_raw", { shootDate: bDate })];
    await renderBoard({ projects: pair("2026-01-01", "2026-01-02") });
    await renderBoard({ projects: pair("2026-01-01", "2025-12-01") });
    expect(played()).toEqual([{ id: "b", dx: 0, dy: 100 }, { id: "a", dx: 0, dy: -100 }]);
  });

  it("lifts only the card travelling farthest, so the one moving up passes over the ones moving down", async () => {
    await renderBoard({ canPrioritize: true, projects: column(false) });
    await renderBoard({ canPrioritize: true, projects: column(true) });
    expect(flip.played.map(({ element, lift }) => ({ id: element.dataset.flipId, lift }))).toEqual([
      { id: "c", lift: true },
      { id: "a", lift: false },
      { id: "b", lift: false },
    ]);
  });

  it("does not animate under reduced motion, but still guards the click that lands on the card that jumped in", async () => {
    const restore = mockMatchMedia(true);
    try {
      const props = await renderBoard({ canPrioritize: true, projects: column(false) });
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
    await renderBoard({ canPrioritize: true, projects: column(false) });
    await fireDnd("onDragStart", { active: { id: "c" } });
    await renderBoard({ canPrioritize: true, projects: column(true) });
    const props = baseProps({ canPrioritize: true, projects: column(true) });
    await act(async () => {
      (dnd.handlers.at(-1)?.props?.onDragEnd as (event: unknown) => void)({ active: { id: "c" }, over: null });
      root.render(createElement(ProjectKanbanBoard2, props));
      await Promise.resolve();
    });
    expect(played()).toEqual([]);
  });

  it("a sort-mode change snaps into place: no FLIP, and a flight in progress is cancelled (#830)", async () => {
    // Shoot-date order a, b, c; Deadline order c, a, b: switching the mode moves c to the top.
    const withDeadlines = (cDeadline: number) => column(false).map((item) => ({ ...item, deadlineAt: item.id === "c" ? cDeadline : item.id === "a" ? 5 : 6 }));
    const ids = () => [...host.querySelectorAll<HTMLElement>("[data-flip-id]")].map((node) => node.dataset.flipId);
    await renderBoard({ projects: withDeadlines(1), sortMode: "shoot-date" });
    expect(ids(), "anchor: shoot-date order").toEqual(["a", "b", "c"]);
    await renderBoard({ projects: withDeadlines(1), sortMode: "due-date" });
    expect(ids()).toEqual(["c", "a", "b"]);
    expect(played(), "the mode change must not play a FLIP").toEqual([]);
    // A data-driven re-sort inside one mode still animates.
    await renderBoard({ projects: withDeadlines(9), sortMode: "due-date" });
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(played().map((entry) => entry.id)).toContain("c");
  });

  it("a star click updates the stars and never moves a card (#830)", async () => {
    const props = await renderBoard({ canPrioritize: true, projects: column(false) });
    const order = () => [...host.querySelectorAll<HTMLElement>("[data-flip-id]")].map((node) => node.dataset.flipId);
    const before = order();
    await clickStar("c Street", 5, { x: 200, y: 230 });
    expect(props.onPriorityChange).toHaveBeenCalledTimes(1);
    await renderBoard({ ...props, projects: column(false).map((item) => (item.id === "c" ? { ...item, priority: 5 } : item)) });
    expect(order()).toEqual(before);
    expect(played()).toEqual([]);
    expect(host.querySelector('[aria-label="Priority for c Street"] [role="radio"][aria-checked="true"]')).not.toBeNull();
  });

  it("does not fly a card that changed column", async () => {
    await renderBoard({ projects: [project("a", "awaiting_raw", {}), project("b", "awaiting_raw", {})] });
    await renderBoard({ projects: [project("a", "raw_review", {}), project("b", "awaiting_raw", {})] });
    expect(played().map((entry) => entry.id)).not.toContain("a");
  });

  it("drops a quick second click at the same spot when it lands on the card that slid under it", async () => {
    const props = await renderBoard({ canPrioritize: true, projects: column(false) });
    await commitAndResort(props);
    expect(props.onPriorityChange).toHaveBeenCalledTimes(1);
    expect(played().length, "no re-sort played — the guard below would be vacuous").toBeGreaterThan(0);
    now += 200;
    // b slid into c's old slot; the pointer has not moved.
    await clickStar("b Street", 4, { x: 202, y: 228 });
    expect(props.onPriorityChange).toHaveBeenCalledTimes(1);
  });

  it("lets a deliberate click elsewhere and a later click through", async () => {
    const props = await renderBoard({ canPrioritize: true, projects: column(false) });
    await commitAndResort(props);
    await clickStar("b Street", 4, { x: 200, y: 330 });
    expect(props.onPriorityChange).toHaveBeenCalledTimes(2);

    await renderBoard({ ...props, projects: column(false) });
    await commitAndResort(props);
    now += STAR_GUARD_WINDOW_MS + 100;
    await clickStar("b Street", 4, { x: 200, y: 230 });
    expect(props.onPriorityChange).toHaveBeenCalledTimes(4);
  });

  it("never treats a keyboard commit as a pointer one, even after a click that stopped short of the Board", async () => {
    const { act } = await import("react");
    const props = await renderBoard({ canPrioritize: true, projects: column(false) });
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
    const props = await renderBoard({ canPrioritize: true, projects: column(false) });
    // a stays first at 4 stars, while b and c swap in the same render (a refetch landing).
    await clickStar("a Street", 4, { x: 200, y: 230 });
    now += 50;
    await renderBoard({ ...props, projects: [project("a", "awaiting_raw", { priority: 4, shootDate: "2026-01-02" }), project("b", "awaiting_raw", { priority: 1, shootDate: "2026-01-09" }), project("c", "awaiting_raw", { priority: 2, shootDate: "2026-01-03" })] });
    expect(played().map((entry) => entry.id), "no move played — the assertion below would be vacuous").toEqual(["c", "b"]);
    await clickStar("c Street", 3, { x: 200, y: 230 });
    expect(props.onPriorityChange).toHaveBeenCalledTimes(2);
  });

  it("disarms the guard on any scroll", async () => {
    const { act } = await import("react");
    const props = await renderBoard({ canPrioritize: true, projects: column(false) });
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
    const props = await renderBoard({ canPrioritize: true, projects: column(false) });
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

  // Frame 4e `cardCompact`: row 1 is a 44x30 thumb, the street and "Suburb · Shoot Tue 20 Oct", and the ⋯;
  // row 2 the Deadline; the footer the task progress, stars and avatars. No large cover, no RAW count.
  it("shows exactly: thumb, street, suburb and Shoot day, Deadline, progress, stars and avatars — no RAW", async () => {
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
        checklist: { completed: 2, total: 5 },
      })],
    });
    const card = cardOf();
    expect(card.querySelector('[data-testid="board-card-address"]')?.textContent).toBe("12 Example St");
    expect(card.querySelector('[data-testid="board-card"]')?.textContent).toBe("12 Example St");
    expect(card.querySelector('[data-testid="board-card-shoot"]')?.textContent).toBe("Bondi · Shoot Fri 12 Mar");
    expect(card.querySelector('[data-testid="board-card-deadline"]')?.textContent).toBe("Due Tue 1 Jan · 09:15");
    // Base UI's Progress root adds a visually hidden "x", so the label is read from its own span.
    expect(card.querySelector('[data-testid="done-progress"] > span')?.textContent).toBe("2 of 5 done");
    expect(card.querySelector('[data-testid="board-card-footer-slot"] [data-testid="done-progress"]'), "progress has its own row (D4's star cells)").toBeNull();
    expect(card.querySelector('[role="radiogroup"][aria-label="Priority for 12 Example St"]')).not.toBeNull();
    expect(card.querySelector('[data-testid="board-card-meta"] [role="img"][aria-label="Jane Doe"]')).not.toBeNull();
    const cover = card.querySelector<HTMLElement>('[data-testid="board-card-cover"]');
    expect(cover?.textContent, "no thumb rendered").toBe("1");
    for (const token of ["w-11", "h-7.5", "shrink-0", "rounded-sm"]) expect([...cover!.classList]).toContain(token);
    expect(cover!.className).not.toContain("aspect-video");
    // The thumb, the street block and the ⋯ share row 1.
    const row = card.querySelector('[data-testid="board-card-title-row"]')!;
    expect(row.contains(cover)).toBe(true);
    expect(row.contains(card.querySelector('[data-testid="board-card"]'))).toBe(true);
    expect(row.contains(card.querySelector('[data-testid="board-card-menu"]'))).toBe(true);
    expect(card.textContent).not.toMatch(/RAW|12\/40|⠿|↑|↓/);
    expect(card.querySelector('[data-testid="board-card-raw"]')).toBeNull();
  });

  it("puts the suburb alone on the meta line when there is no Shoot date, and omits the line with neither", async () => {
    await renderBoard({ projects: [project("source", "awaiting_raw", { shootDate: null, suburb: "Glebe" })] });
    expect(cardOf().querySelector('[data-testid="board-card-shoot"]')?.textContent).toBe("Glebe");
    expect(cardOf().textContent).not.toContain("Shoot");
    await renderBoard({ projects: [project("source", "awaiting_raw", { shootDate: null, suburb: null })] });
    expect(cardOf().querySelector('[data-testid="board-card-address"]')).not.toBeNull();
    expect(cardOf().querySelector('[data-testid="board-card-shoot"]')).toBeNull();
  });

  // #923 D1: progress renders only when the API sent `checklist`; `{0,0}` is "No tasks", absent is nothing.
  it("draws 'N of M done' in the Stage tone, 'No tasks' for none, and nothing when the count is unknown", async () => {
    const counted = project("source", "raw_review", { checklist: { completed: 1, total: 4 } });
    await renderBoard({ projects: [counted] });
    const progress = cardOf().querySelector<HTMLElement>('[data-testid="done-progress"]')!;
    expect(progress.querySelector(":scope > span")?.textContent).toBe("1 of 4 done");
    expect(progress.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("25");
    expect(progress.querySelector(":scope > span")?.textContent).toBe(projectAppearance(counted, Date.now()).done?.label);
    expect(progress.style.getPropertyValue("--progress-tone")).toBe(projectAppearance(counted, Date.now()).tone.color);
    await renderBoard({ projects: [project("source", "raw_review", { checklist: { completed: 0, total: 0 } })] });
    expect(cardOf().querySelector('[data-testid="done-progress"]')?.textContent).toBe("No tasks");
    await renderBoard({ projects: [project("source", "raw_review")] });
    expect(cardOf().querySelector('[data-testid="done-progress"]')).toBeNull();
  });

  // Frame 4e `.card::before`: a 3px edge in the Stage tone ties the card to its column; Awaiting RAW's is dashed.
  it("tops each card with its Stage tone, dashed for Awaiting RAW", async () => {
    await renderBoard({ projects: [project("source", "awaiting_raw"), project("other", "raw_review")] });
    const edge = (id: string) => cardOf(id).querySelector<HTMLElement>('[data-testid="board-card-edge"]')!;
    expect(edge("source").getAttribute("data-treatment")).toBe("hollow-dashed");
    expect(edge("other").getAttribute("data-treatment")).toBe("solid");
    expect(edge("other").style.getPropertyValue("--card-tone")).toBe(projectAppearance(project("other", "raw_review"), Date.now()).tone.color);
    expect(edge("other").getAttribute("aria-hidden")).toBe("true");
  });

  it("is late only for an active Project past its Deadline, judged against the `now` it is given", async () => {
    const deadlineAt = Date.parse("2026-09-01T00:00:00.000Z");
    const common = { deadlineAt, deadlineLocalCivil: "2026-09-01T10:00", deadlineZone: "Australia/Sydney" as const };
    const deadlineOf = (id: string) => cardOf(id).querySelector('[data-testid="board-card-deadline"]')!;
    const chipOf = (id: string) => cardOf(id).querySelector('[data-testid="late-chip"]');
    await renderBoard({
      now: deadlineAt + 1000,
      projects: [
        project("active", "awaiting_raw", common),
        project("delivered", "delivered", common),
        project("archived", "awaiting_raw", { ...common, archivedAt: "2026-09-02T00:00:00.000Z" }),
      ],
      activeStages: [...stages, { key: "delivered", label: "Delivered", displayOrder: 3, active: true }],
    });
    expect(chipOf("active")?.textContent).toBe("Late today");
    expect(deadlineOf("active").className).toContain("text-late");
    for (const id of ["delivered", "archived"]) {
      expect(chipOf(id), `${id} must not be late`).toBeNull();
      expect(deadlineOf(id).className, `${id} must not be in the late colour`).not.toContain("text-late");
    }
    // The same Project is not late against an earlier clock.
    await renderBoard({ now: deadlineAt - 1000, projects: [project("active", "awaiting_raw", common)] });
    expect(chipOf("active")).toBeNull();
  });

  it("an Edited review card past its Deadline is late like any working Stage (the module's answer, not the ochre)", async () => {
    const deadlineAt = Date.parse("2026-09-01T00:00:00.000Z");
    const now = deadlineAt + 3 * 86_400_000;
    const review = project("review", "edited_review", { deadlineAt, deadlineLocalCivil: "2026-09-01T10:00", deadlineZone: "Australia/Sydney" });
    await renderBoard({ now, projects: [review], activeStages: [...stages, { key: "edited_review", label: "Edited review", displayOrder: 4, active: true }] });
    const appearance = projectAppearance(review, now);
    expect(appearance.lateness.late).toBe(true);
    expect(appearance.lateLabel).not.toBeNull();
    expect(cardOf("review").querySelector('[data-testid="late-chip"]')?.textContent).toBe(appearance.lateLabel);
    expect(cardOf("review").closest('[data-testid="board-card-wrap"]')?.getAttribute("data-late")).toBe("true");
    expect(cardOf("review").querySelector<HTMLElement>('[data-testid="board-card-edge"]')!.style.getPropertyValue("--card-tone")).toBe(appearance.tone.color);
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
    project("mid", "awaiting_raw", {}),
    project("low", "awaiting_raw", {}),
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

  it("gives both Move to sub-triggers the 44px touch-row classes the Stage radios carry", async () => {
    await renderBoard({ projects: column(), role: "admin", canMoveStages: true });
    const touchClasses = ["max-[641px]:min-h-11", "pointer-coarse:min-h-11"];
    await openCardMenu(host, "mid");
    for (const cls of touchClasses) expect(moveToTrigger()!.classList.contains(cls), `⋯ Move to lacks ${cls}`).toBe(true);
    await closeMenus();
    await openContextMenu(wrap("mid")!);
    for (const cls of touchClasses) expect(moveToTrigger()!.classList.contains(cls), `right-click Move to lacks ${cls}`).toBe(true);
    await closeMenus();
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

// #432: the column header's count and late figure, and the collapsed rail (#923: from the appearance module).
describe("ProjectKanbanBoard2 — column headers and collapse (#432, #923)", () => {
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
    // Archived Projects are never late (`projectLateness`), however late their deadline.
    project("archived-late", "raw_review", { deadlineAt: PAST, archivedAt: "2026-09-02T00:00:00.000Z" }),
    project("review-late", "raw_review", { deadlineAt: PAST }),
  ];

  // Frame 4e `colHead`: the column's count and "N late" come from the appearance module's group summary.
  it("shows each column's project count and 'N late' only when N > 0, from stageGroupAppearance", async () => {
    const projects = mixed();
    await renderBoard({ projects, now: NOW });
    const first = column("Awaiting RAW")!;
    const firstGroup = stageGroupAppearance(projects.filter((item) => item.stageKey === "awaiting_raw"), NOW);
    expect(first.querySelector('[data-testid="board-column-count"]')?.textContent).toBe(String(firstGroup.count));
    const late = first.querySelector('[data-testid="board-column-late"]');
    expect(late?.textContent).toBe(`${firstGroup.lateCount} late`);
    expect(late?.textContent).toBe("2 late");
    expect([...late!.classList]).toEqual(expect.arrayContaining(["text-late", "border-late"]));
    const second = column("RAW review")!;
    expect(second.querySelector('[data-testid="board-column-count"]')?.textContent).toBe("2");
    expect(second.querySelector('[data-testid="board-column-late"]')?.textContent, "an archived late Project counted as late").toBe("1 late");

    await renderBoard({ projects: [project("ontime", "awaiting_raw", { deadlineAt: FUTURE })], now: NOW });
    expect(column("Awaiting RAW")!.querySelector('[data-testid="board-column-late"]')).toBeNull();
  });

  // One 44px row: the Stage swatch and sentence-case name, the count, the late chip, then the toggle.
  it("lays each header out as one row: Stage label, count, late chip, then the toggle at the end", async () => {
    await renderBoard({ projects: mixed(), now: NOW, collapsedStageKeys: [], onToggleStageCollapsed: vi.fn() });
    const headers = [...host.querySelectorAll<HTMLElement>('[data-testid="board-column"] [data-focus-key^="stage-heading:"]')];
    expect(headers.length).toBeGreaterThan(1);
    for (const header of headers) {
      const row = header.querySelector<HTMLElement>('[data-testid="board-column-title-row"]')!;
      const label = row.querySelector<HTMLElement>('[data-testid="stage-label"]')!;
      expect(row.firstElementChild, "the Stage label leads the row").toBe(label);
      expect(row.querySelector('[data-testid="board-column-count"]')).not.toBeNull();
      expect(row.lastElementChild!.querySelector('[aria-label^="Collapse "]'), "the toggle ends the row").not.toBeNull();
      expect(header.querySelector('[data-testid="board-column-stats-row"]'), "no second row").toBeNull();
      expect(row.textContent).not.toMatch(/\b0\d\b/);
    }
    const awaiting = column("Awaiting RAW")!.querySelector<HTMLElement>('[data-testid="stage-label"]')!;
    expect(awaiting.getAttribute("data-stage")).toBe("awaiting_raw");
    const swatch = awaiting.querySelector<HTMLElement>('[data-testid="stage-key-swatch"]')!;
    expect(swatch.getAttribute("data-treatment")).toBe(stageTone("awaiting_raw").treatment);
    expect(swatch.style.getPropertyValue("--swatch-color")).toBe(stageTone("awaiting_raw").color);
    expect(column("Awaiting RAW")!.querySelector('[data-testid="board-column-title-row"] [data-testid="board-column-late"]'), "the late chip sits on the row").not.toBeNull();
  });

  it("names Editing without the autoHDR suffix on its column, which is a Project's variant, not the Stage's", async () => {
    await renderBoard({ projects: [project("hdr", "editing_autohdr")], activeStages: [{ key: "editing_autohdr", label: "Editing", displayOrder: 3, active: true }] });
    const label = host.querySelector('[data-testid="board-column"] [data-testid="stage-label"]')!;
    expect(label.textContent).toBe("Editing");
  });

  it("column late figures sum to the module's late count over the same rows and clock", async () => {
    const projects = mixed();
    await renderBoard({ projects, now: NOW });
    const total = [...host.querySelectorAll('[data-testid="board-column-late"]')].reduce((sum, node) => sum + Number.parseInt(node.textContent ?? "0", 10), 0);
    expect(total, "anchor: something is late").toBeGreaterThan(0);
    expect(total).toBe(stageGroupAppearance(projects, NOW).lateCount);
  });

  it("collapses to a rail that is still a column, with no cards, a vertical label, and the Stage heading focus key", async () => {
    const onToggleStageCollapsed = vi.fn();
    await renderBoard({ projects: mixed(), now: NOW, collapsedStageKeys: ["awaiting_raw"], onToggleStageCollapsed });
    const rail = column("Awaiting RAW")!;
    expect(rail.getAttribute("data-collapsed")).toBe("true");
    expect(rail.querySelector('[data-testid="board-card"]'), "a collapsed Stage still mounts its cards").toBeNull();
    expect(rail.querySelector('[data-testid="board-column-count"]')?.textContent).toBe("3");
    expect(rail.querySelector('[data-testid="board-column-late"]')?.textContent).toBe("2 late");
    expect(rail.querySelector('[data-focus-key="stage-heading:awaiting_raw"]')?.getAttribute("tabindex")).toBe("-1");
    expect(rail.querySelector('[data-testid="stage-key-swatch"]'), "the rail carries the Stage swatch").not.toBeNull();
    expect([...rail.classList]).toContain("w-12");
    expect(rail.textContent).not.toMatch(/overdue/i);
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

describe("ProjectKanbanBoard2 — column actions, empty columns and Stage menu swatches (#923)", () => {
  beforeEach(() => {
    dnd.handlers.length = 0;
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

  const column = (stageKey: string) => host.querySelector<HTMLElement>(`[data-testid="board-column"][data-stage-key="${stageKey}"]`)!;
  const allStages: readonly PipelineStage[] = [
    ...stages,
    { key: "editing", label: "Editing", displayOrder: 3, active: true },
    { key: "edited_review", label: "Edited review", displayOrder: 4, active: true },
    { key: "delivered", label: "Delivered", displayOrder: 5, active: true },
  ];

  // #923 D3: "+ New shoot" only in Awaiting RAW, only with `createProject`, to /projects/new with no Stage preset.
  it("offers '+ New shoot' at the end of Awaiting RAW only, for a viewer who can create a Project", async () => {
    await renderBoard({ canCreateProject: true, activeStages: allStages, projects: [project("a", "awaiting_raw"), project("b", "raw_review")] });
    const links = [...host.querySelectorAll<HTMLAnchorElement>('[data-testid="board-column-new-shoot"]')];
    expect(links).toHaveLength(1);
    expect(column("awaiting_raw").contains(links[0]!)).toBe(true);
    expect(links[0]!.tagName).toBe("A");
    expect(links[0]!.getAttribute("href")).toBe("/projects/new");
    expect(links[0]!.textContent).toBe("New shoot");
    // Outside the SortableContext's list, so it never sits between the cards and the end drop indicator.
    const list = column("awaiting_raw").querySelector('[data-testid="board-column-list"]');
    expect(list, "anchor: the list").not.toBeNull();
    expect(list!.contains(links[0]!)).toBe(false);

    await renderBoard({ canCreateProject: false, activeStages: allStages, projects: [project("a", "awaiting_raw")] });
    expect(host.querySelector('[data-testid="board-column-new-shoot"]')).toBeNull();
    await renderBoard({ activeStages: allStages, projects: [project("a", "awaiting_raw")] });
    expect(host.querySelector('[data-testid="board-column-new-shoot"]')).toBeNull();
  });

  // Frame 4h "empty": each empty column says so in its own words; Awaiting RAW's carries New shoot as its action.
  it("gives each empty column its own copy, with New shoot as Awaiting RAW's action", async () => {
    await renderBoard({ canCreateProject: true, activeStages: allStages, projects: [project("b", "raw_review")], collapsedStageKeys: [] });
    const empty = (stageKey: string) => column(stageKey).querySelector('[data-testid="board-column-empty"]');
    expect(empty("awaiting_raw")?.textContent).toContain("No shoots waiting for RAW.");
    expect(empty("awaiting_raw")?.querySelector('[data-testid="board-column-new-shoot"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="board-column-new-shoot"]'), "one New shoot, not a slot as well").toHaveLength(1);
    expect(empty("raw_review"), "a column with a card is not empty").toBeNull();
    expect(empty("editing")?.textContent).toBe("Nothing in editing.");
    expect(empty("edited_review")?.textContent).toBe("Nothing waiting for review.");
    expect(empty("delivered")?.textContent).toBe("Nothing delivered yet.");
    expect(host.textContent).not.toContain("—");
  });

  // card-menu's swatches are the appearance module's tones, not the retired caution + hatch pair (#257).
  it("draws each Move to Stage with its tone swatch and no hatch", async () => {
    await renderBoard({ activeStages: allStages, projects: [project("a", "awaiting_raw")], canMoveStages: true, role: "admin" });
    await openCardMenu(host, "a");
    await openMoveToSubmenu();
    expect(stageRadios().length, "anchor: Stage radios").toBe(allStages.length);
    for (const radio of stageRadios()) {
      const key = allStages.find((stage) => stage.label === radio.textContent)!.key;
      const swatch = radio.querySelector<HTMLElement>('[data-testid="stage-key-swatch"]');
      expect(swatch, `${key} has a tone swatch`).not.toBeNull();
      expect(swatch!.style.getPropertyValue("--swatch-color")).toBe(stageTone(key).color);
    }
    expect(document.querySelector('[data-pattern="hatch"]')).toBeNull();
    await closeMenus();
  });
});

describe("ProjectKanbanBoard2 — phone Stage pills (#923, frame 4f)", () => {
  let scrolled: Element[] = [];
  const original = Element.prototype.scrollIntoView;

  beforeEach(() => {
    dnd.handlers.length = 0;
    sortable.contexts.length = 0;
    scrolled = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    Element.prototype.scrollIntoView = original;
    const { act } = await import("react");
    await act(async () => root.unmount());
    host.remove();
  });

  const pills = () => [...host.querySelectorAll<HTMLButtonElement>('[data-testid="board-stage-pills"] [data-stage-key]')];

  it("draws one pill per Stage with its swatch and count, shown on a phone only, as one labelled group", async () => {
    await renderBoard({ projects: [project("a", "awaiting_raw"), project("b", "raw_review"), project("c", "raw_review")] });
    const group = host.querySelector<HTMLElement>('[data-testid="board-stage-pills"]')!;
    expect(group.getAttribute("aria-label")).toBe("Stages");
    expect([...group.classList]).toEqual(expect.arrayContaining(["hidden", "max-[721px]:flex"]));
    expect(pills().map((pill) => pill.getAttribute("data-stage-key"))).toEqual(["awaiting_raw", "raw_review"]);
    expect(pills().map((pill) => pill.textContent)).toEqual(["Awaiting RAW1", "RAW review2"]);
    for (const pill of pills()) expect(pill.querySelector('[data-testid="stage-key-swatch"]')).not.toBeNull();
    expect(pills()[0]!.getAttribute("aria-pressed"), "the first Stage shows first").toBe("true");
    expect(pills()[1]!.getAttribute("aria-pressed")).toBe("false");
  });

  // Every column stays mounted: a pill scrolls the strip, it never swaps which droppables exist.
  it("scrolls the strip to the pill's column without mounting or unmounting a column", async () => {
    await renderBoard({ projects: [project("a", "awaiting_raw"), project("b", "raw_review")] });
    const columnsBefore = [...host.querySelectorAll('[data-testid="board-column"]')];
    const { act } = await import("react");
    await act(async () => { pills()[1]!.click(); await Promise.resolve(); });
    const target = host.querySelector('[data-testid="board-column"][data-stage-key="raw_review"]');
    expect(target, "anchor: the target column").not.toBeNull();
    expect(scrolled).toContain(target);
    expect(pills()[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(pills()[0]!.getAttribute("aria-pressed")).toBe("false");
    const columnsAfter = [...host.querySelectorAll('[data-testid="board-column"]')];
    expect(columnsAfter).toHaveLength(columnsBefore.length);
    columnsAfter.forEach((node, index) => expect(node, "a column was remounted").toBe(columnsBefore[index]));
  });

  it("keeps the active pill when it is pressed again, rather than showing no Stage", async () => {
    await renderBoard();
    const { act } = await import("react");
    await act(async () => { pills()[0]!.click(); await Promise.resolve(); });
    expect(pills()[0]!.getAttribute("aria-pressed")).toBe("true");
  });

  // #923 S5: a pill must land on real cards, so a phone never draws the 48px rail. The stored choice is the viewer's
  // wide-screen preference and stays as it is: no toggle is offered on a phone, and nothing writes it.
  describe("Delivered on a phone", () => {
    const withDelivered = [...stages, { key: "delivered", label: "Delivered", displayOrder: 5, active: true }] as const;
    let media: { set(phone: boolean): void; restore(): void };

    function phoneMedia(initial: boolean) {
      const original = window.matchMedia;
      const listeners = new Set<() => void>();
      let phone = initial;
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: (query: string) => ({
          get matches() { return phone && query === "(width < 721px)"; },
          media: query,
          onchange: null,
          addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
          removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
          addListener: (listener: () => void) => listeners.add(listener),
          removeListener: (listener: () => void) => listeners.delete(listener),
          dispatchEvent: () => false,
        }),
      });
      return {
        set(next: boolean) { phone = next; for (const listener of [...listeners]) listener(); },
        restore() { Object.defineProperty(window, "matchMedia", { configurable: true, value: original }); },
      };
    }

    afterEach(() => media.restore());

    const delivered = () => host.querySelector<HTMLElement>('[data-testid="board-column"][data-stage-key="delivered"]')!;
    const toggles = () => host.querySelectorAll('[data-testid="board-column-collapse"], [data-testid="board-column-expand"]');

    it("is a full column with its cards, though the viewer keeps it collapsed, and offers no collapse control", async () => {
      media = phoneMedia(true);
      const onToggleStageCollapsed = vi.fn();
      await renderBoard({ activeStages: withDelivered, projects: [project("a", "awaiting_raw"), project("d", "delivered")], collapsedStageKeys: ["delivered"], onToggleStageCollapsed });
      expect(delivered().hasAttribute("data-collapsed")).toBe(false);
      expect(delivered().querySelector('[data-testid="board-card"]')?.textContent).toContain("d Street");
      expect(toggles()).toHaveLength(0);

      const { act } = await import("react");
      await act(async () => { media.set(false); await Promise.resolve(); });
      expect(delivered().getAttribute("data-collapsed"), "wide again: the stored choice still holds").toBe("true");
      expect(toggles().length).toBeGreaterThan(0);
      expect(onToggleStageCollapsed).not.toHaveBeenCalled();
    });

    it("keeps the columns it had for the whole of a drag when the width crosses the phone breakpoint", async () => {
      media = phoneMedia(true);
      await renderBoard({ activeStages: withDelivered, projects: [project("source", "awaiting_raw"), project("d", "delivered")], collapsedStageKeys: ["delivered"], onToggleStageCollapsed: vi.fn() });
      await fireDnd("onDragStart", { active: { id: "source" } });
      const { act } = await import("react");
      await act(async () => { media.set(false); await Promise.resolve(); });
      expect(delivered().hasAttribute("data-collapsed"), "no droppable changes mid-drag").toBe(false);
      await fireDnd("onDragCancel", { active: { id: "source" } });
      expect(delivered().getAttribute("data-collapsed")).toBe("true");
    });
  });

  it("disables the pills for the whole of a drag, then gives them back", async () => {
    await renderBoard();
    expect(pills().length, "anchor: pills").toBeGreaterThan(0);
    expect(pills().every((pill) => !pill.disabled), "anchor: enabled").toBe(true);
    await fireDnd("onDragStart", { active: { id: "source" } });
    expect(pills().every((pill) => pill.disabled)).toBe(true);
    await fireDnd("onDragCancel", { active: { id: "source" } });
    expect(pills().every((pill) => !pill.disabled)).toBe(true);
  });
});

describe("BoardSkeleton (#923, frame 4h)", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    const { act } = await import("react");
    await act(async () => root.unmount());
    host.remove();
  });

  it("draws one column shell per Stage with its label, and two skeleton compact cards in each", async () => {
    const { act } = await import("react");
    await act(async () => { root.render(createElement(BoardSkeleton, { stages })); await Promise.resolve(); });
    const skeleton = host.querySelector<HTMLElement>('[data-testid="board-skeleton"]')!;
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    expect(skeleton.textContent).toContain("Loading projects");
    const columns = [...skeleton.querySelectorAll<HTMLElement>('[data-testid="board-skeleton-column"]')];
    expect(columns).toHaveLength(stages.length);
    expect(columns.map((node) => node.querySelector('[data-testid="stage-label"]')?.textContent)).toEqual(["Awaiting RAW", "RAW review"]);
    for (const node of columns) {
      expect(node.querySelectorAll('[data-testid="board-skeleton-card"]')).toHaveLength(2);
      for (const card of node.querySelectorAll('[data-testid="board-skeleton-card"]')) expect(card.querySelector('[data-testid="board-skeleton-thumb"]'), "the 44x30 thumb's skeleton").not.toBeNull();
    }
    expect(skeleton.querySelector("a, button, [tabindex]")).toBeNull();
  });

  it("draws unlabelled column shells when the Stages are not known yet", async () => {
    const { act } = await import("react");
    await act(async () => { root.render(createElement(BoardSkeleton, {})); await Promise.resolve(); });
    expect(host.querySelectorAll('[data-testid="board-skeleton-column"]')).toHaveLength(4);
    expect(host.querySelector('[data-testid="stage-label"]')).toBeNull();
  });
});

// #923 browser pass, round 2 (design review): rows 3, 4, 7, 8 and 9.
describe("ProjectKanbanBoard2 — browser pass round 2 (#923)", () => {
  beforeEach(() => {
    dnd.handlers.length = 0;
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

  const column = (stageKey: string) => host.querySelector<HTMLElement>(`[data-testid="board-column"][data-stage-key="${stageKey}"]`)!;

  it("row 3: writes New shoot in sentence case, in the add slot and as the empty column's action", async () => {
    await renderBoard({ canCreateProject: true, projects: [project("a", "awaiting_raw")] });
    const slot = host.querySelector<HTMLElement>('[data-testid="board-column-new-shoot"]')!;
    expect(slot.className).toContain("normal-case");
    expect(slot.className).toContain("tracking-[var(--tracking-normal)]");

    await renderBoard({ canCreateProject: true, projects: [project("b", "raw_review")] });
    const action = column("awaiting_raw").querySelector<HTMLElement>('[data-testid="board-column-empty"] [data-testid="board-column-new-shoot"]')!;
    expect(action.className).toContain("normal-case");
  });

  it("row 4: draws a failed cover as the street's initial, and a sentence-case retry sized to its words", async () => {
    await renderBoard({ projects: [project("source", "awaiting_raw", { coverAssetId: "asset-1" })] });
    const cover = host.querySelector<HTMLElement>('[data-testid="board-card-cover"]')!;
    expect(cover.textContent).toBe("S");
    expect(cover.querySelector('[aria-hidden="true"]')?.textContent, "the initial placeholder").toBe("S");
    expect(cover.querySelector('[role="status"]'), "no failed-image status box in the 44x30 thumb").toBeNull();
    const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === "Retry cover image")!;
    expect(retry, "anchor: the retry").toBeDefined();
    expect(retry.className).toContain("normal-case");
    expect(retry.className).toContain("self-start");
  });

  it("row 7: lines the phone Stage pills up with the column's edge, with no rule of their own above its border", async () => {
    await renderBoard();
    const pills = host.querySelector<HTMLElement>('[data-testid="board-stage-pills"]')!;
    const classes = [...pills.classList];
    expect(classes.some((name) => /^px-/.test(name)), "no inline padding past the page gutter").toBe(false);
    expect(classes.some((name) => /^border-b/.test(name)), "the column's top border is the only rule").toBe(false);
  });

  it("row 8: pulls interactive stars up by their hit cell's inset, so the glyphs sit a --space-2 under the progress", async () => {
    await renderBoard({ canPrioritize: true, projects: [project("source", "awaiting_raw", { checklist: { completed: 1, total: 4 } })] });
    const footer = host.querySelector<HTMLElement>('[data-testid="board-card-footer-slot"]')!;
    expect(footer.getAttribute("data-star-inset")).toBe("pulled");
    await renderBoard({ canPrioritize: false, projects: [project("source", "awaiting_raw", { checklist: { completed: 1, total: 4 }, priority: 3 })] });
    expect(host.querySelector('[data-testid="board-card-footer-slot"]')!.hasAttribute("data-star-inset"), "read-only stars have no cell to pull").toBe(false);
  });

  it("row 9: gives a scrolling column's list a gutter for its scrollbar", async () => {
    await renderBoard();
    const list = column("awaiting_raw").querySelector<HTMLElement>('[data-testid="board-column-list"]')!;
    expect(list.className).toContain("group-data-[has-overflow-y]/column-scroll:pe-[var(--space-5)]");
    let scope: HTMLElement | null = list.parentElement;
    while (scope && !scope.classList.contains("group/column-scroll")) scope = scope.parentElement;
    expect(scope, "the column's ScrollArea is the group").not.toBeNull();
    expect(column("awaiting_raw").contains(scope)).toBe(true);
  });
});
