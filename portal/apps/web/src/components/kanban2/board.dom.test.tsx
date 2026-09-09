// happy-dom cannot exercise real PointerSensor/KeyboardSensor drag activation — see
// `ProjectKanbanBoard.dom.test.tsx`'s header. This test drives the captured `DndContext`
// `onDragEnd` handler directly, the same technique the existing Board's test suite uses.
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DragEndEvent } from "@dnd-kit/core";
import { ProjectKanbanBoard2 } from "./board";
import type { ProjectSummary } from "../../lib/kanban-interaction";
import type { PipelineStage } from "../../lib/stages";
import type { ProjectKanbanBoardProps } from "../ProjectKanbanBoard";

const dnd = vi.hoisted(() => ({
  handlers: [] as Array<{ onDragEnd?: (event: unknown) => void }>,
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
      dnd.handlers.push({ onDragEnd: props.onDragEnd as (event: unknown) => void });
      return createElement(actual.DndContext, props);
    },
  };
});

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

describe("ProjectKanbanBoard2 (#80)", () => {
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

  it("renders one column per active Stage, in the given order and labelled, with cards showing street", async () => {
    await renderBoard();
    const columns = host.querySelectorAll('[data-slot="kanban-column"]');
    expect(columns).toHaveLength(2);
    expect(columns[0]?.textContent).toContain("Awaiting RAW");
    expect(columns[1]?.textContent).toContain("RAW review");
    expect(host.querySelector('[data-testid="kanban2-card-address"]')?.textContent).toBe("source Street");
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
});
