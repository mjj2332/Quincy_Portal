// #152: dnd-kit does not detach an active sensor when `DndContext` unmounts, so a drag left
// running when this Board unmounts (Back, a rail link) can still deliver drag end/cancel to
// handlers closed over a dead board's `onBoardMove`. This file drives the captured `DndContext`
// handlers directly — the same technique as `board.dom.test.tsx`, which this harness is lifted
// from — rather than real PointerSensor activation, which happy-dom cannot exercise.
import { createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectKanbanBoard2 } from "./board";
import type { ProjectKanbanBoardProps, ProjectSummary } from "../../lib/kanban-interaction";
import type { PipelineStage } from "../../lib/stages";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dnd = vi.hoisted(() => ({
  handlers: [] as Array<{ props: Record<string, unknown> }>,
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
      dnd.handlers.push({ props: props as unknown as Record<string, unknown> });
      return createElement(actual.DndContext, props);
    },
  };
});

vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>();
  return { ...actual, SortableContext: (props: Parameters<typeof actual.SortableContext>[0]) => createElement(actual.SortableContext, props) };
});

vi.mock("../LazyImage", () => ({ LazyImage: () => null }));

const stages: readonly PipelineStage[] = [
  { key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1, active: true },
  { key: "raw_review", label: "RAW review", displayOrder: 2, active: true },
];

function project(id: string, stageKey: ProjectSummary["stageKey"]): ProjectSummary {
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
    boardMapPresent: true,
    boardRank: 0,
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
    onMoveToProposalChange: vi.fn(),
    onAnnounce: vi.fn(),
    onInteractionStateChange: vi.fn(),
    ...overrides,
  };
}

let host: HTMLElement;
let root: Root;

async function renderBoard(overrides: Partial<ProjectKanbanBoardProps> = {}, strict = false) {
  const props = baseProps(overrides);
  const { act } = await import("react");
  const element = strict
    ? createElement(StrictMode, null, createElement(ProjectKanbanBoard2, props))
    : createElement(ProjectKanbanBoard2, props);
  await act(async () => { root.render(element); await Promise.resolve(); });
  return props;
}

async function fireDnd(name: "onDragStart" | "onDragOver" | "onDragCancel" | "onDragEnd", event: unknown) {
  const { act } = await import("react");
  const handler = dnd.handlers.at(-1)?.props[name] as ((event: unknown) => void) | undefined;
  if (!handler) throw new Error(`No ${name} handler captured`);
  await act(async () => { handler(event); await Promise.resolve(); });
}

async function unmount() {
  const { act } = await import("react");
  await act(async () => root.unmount());
}

describe("ProjectKanbanBoard2 releases the Dashboard's barrier on unmount (#152)", () => {
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

  it("releases the barrier on unmount mid-drag", async () => {
    const props = await renderBoard();
    await fireDnd("onDragStart", { active: { id: "source" } });
    (props.onInteractionStateChange as ReturnType<typeof vi.fn>).mockClear();

    await unmount();

    expect(props.onInteractionStateChange).toHaveBeenCalledTimes(1);
    expect(props.onInteractionStateChange).toHaveBeenLastCalledWith({ activeId: undefined, proposal: null });
  });

  it("makes no call on an idle unmount", async () => {
    const props = await renderBoard();
    (props.onInteractionStateChange as ReturnType<typeof vi.fn>).mockClear();

    await unmount();

    expect(props.onInteractionStateChange).not.toHaveBeenCalled();
  });

  it("under StrictMode, a mount/drag-start/unmount releases the barrier exactly once", async () => {
    const props = await renderBoard({}, true);
    await fireDnd("onDragStart", { active: { id: "source" } });
    (props.onInteractionStateChange as ReturnType<typeof vi.fn>).mockClear();

    await unmount();

    expect(props.onInteractionStateChange).toHaveBeenCalledTimes(1);
    expect(props.onInteractionStateChange).toHaveBeenLastCalledWith({ activeId: undefined, proposal: null });
  });

  it("fences a captured onDragEnd after unmount: neither onBoardMove nor onAnnounce fire", async () => {
    const props = await renderBoard();
    await fireDnd("onDragStart", { active: { id: "source" } });
    const handler = dnd.handlers.at(-1)?.props.onDragEnd as ((event: unknown) => void) | undefined;
    if (!handler) throw new Error("No onDragEnd handler captured");

    await unmount();

    const { act } = await import("react");
    await act(async () => { handler({ active: { id: "source" }, over: { id: "raw_review" } }); await Promise.resolve(); });

    expect(props.onBoardMove).not.toHaveBeenCalled();
    expect(props.onAnnounce).not.toHaveBeenCalled();
  });

  it("fences a captured onDragCancel after unmount: neither onBoardMove nor onAnnounce fire", async () => {
    const props = await renderBoard();
    await fireDnd("onDragStart", { active: { id: "source" } });
    const handler = dnd.handlers.at(-1)?.props.onDragCancel as ((event: unknown) => void) | undefined;
    if (!handler) throw new Error("No onDragCancel handler captured");

    await unmount();

    const { act } = await import("react");
    await act(async () => { handler({ active: { id: "source" } }); await Promise.resolve(); });

    expect(props.onBoardMove).not.toHaveBeenCalled();
    expect(props.onAnnounce).not.toHaveBeenCalled();
  });
});
