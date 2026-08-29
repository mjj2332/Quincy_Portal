import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectKanbanBoard, type BoardInteractionState } from "./ProjectKanbanBoard";
import type { ProjectSummary } from "../lib/kanban-interaction";
import type { PipelineStage } from "../lib/stages";

type DndTestEvent = { active: { id: string; data?: unknown }; over: { id: string; data?: unknown } | null };
const dnd = vi.hoisted(() => ({
  handlers: [] as Array<{ props: Parameters<typeof import("@dnd-kit/core").DndContext>[0]; start?: (event: DndTestEvent) => void; over?: (event: DndTestEvent) => void; end?: (event: DndTestEvent) => void; cancel?: (event: DndTestEvent) => void }>,
}));
const sortable = vi.hoisted(() => ({ contexts: [] as Array<readonly string[]> }));

vi.mock("../lib/capabilities", () => ({
  useCapabilities: () => ({ role: "admin", capabilities: ["adminBackend"], can: (capability: string) => capability === "adminBackend" }),
}));
vi.mock("../lib/stages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/stages")>();
  return { ...actual, useStages: () => ({ stages: [], presentationStageKey: (key: string) => key }) };
});
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: (props: Parameters<typeof actual.DndContext>[0]) => {
      dnd.handlers.push({ props, start: props.onDragStart as ((event: DndTestEvent) => void) | undefined, over: props.onDragOver as ((event: DndTestEvent) => void) | undefined, end: props.onDragEnd as ((event: DndTestEvent) => void) | undefined, cancel: props.onDragCancel as ((event: DndTestEvent) => void) | undefined });
      return createElement(actual.DndContext, props);
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

const stages: readonly PipelineStage[] = [
  { key: "awaiting_raw", label: "Awaiting RAW", displayOrder: 1, active: true },
  { key: "raw_review", label: "RAW review", displayOrder: 2, active: true },
  { key: "editing_autohdr", label: "Editing", displayOrder: 3, active: true },
];

function project(id: string, stageKey: ProjectSummary["stageKey"], boardRevision: number, priority: number | null = null): ProjectSummary {
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
    priority,
    authorizedBoardOrder: { awaiting_raw: ["source"], raw_review: ["visual-second", "visual-first"] },
    boardMapPresent: true,
    boardRevision,
    deadlineAt: null,
    deadlineLocalCivil: null,
    deadlineZone: null,
  };
}

const source = project("source", "awaiting_raw", 3);
const visualFirst = project("visual-first", "raw_review", 8, 1);
const visualSecond = project("visual-second", "raw_review", 9, 2);

function cardData(stageKey: "awaiting_raw" | "raw_review", projectId: string) {
  return { current: { kind: "card", stageKey, projectId } };
}

function columnData(stageKey: "awaiting_raw" | "raw_review") {
  return { current: { kind: "column", stageKey } };
}

const callbacks = {
  onCrossStageMove: vi.fn(),
  onBoardPosition: vi.fn(),
  onPriorityChange: vi.fn(),
  onMoveStage: vi.fn(),
  onInteractionStateChange: vi.fn<(state: BoardInteractionState) => void>(),
  onAnnounce: vi.fn(),
};

let root: Root;
let host: HTMLDivElement;

async function renderBoard(overrides: Partial<React.ComponentProps<typeof ProjectKanbanBoard>> = {}) {
  await act(async () => {
    root.render(createElement(ProjectKanbanBoard, {
      projects: [source, visualFirst, visualSecond],
      activeStages: stages,
      canMoveStages: true,
      canPrioritize: true,
      boardMutationEnabled: true,
      effectiveKanbanSort: "board",
      pendingMoves: new Set<string>(),
      pendingOrdering: new Set<string>(),
      terminal: false,
      ...callbacks,
      ...overrides,
    }));
    await Promise.resolve();
  });
}

function event(activeId: string, activeData: unknown, over: { id: string; data: unknown } | null): DndTestEvent {
  return { active: { id: activeId, data: activeData }, over };
}

async function start() {
  const handler = dnd.handlers.at(-1)?.start;
  if (!handler) throw new Error("No drag-start handler");
  await act(async () => { handler(event("source", cardData("awaiting_raw", "source"), null)); await Promise.resolve(); });
}

async function startProject(projectId: string, stageKey: "awaiting_raw" | "raw_review") {
  const handler = dnd.handlers.at(-1)?.start;
  if (!handler) throw new Error("No drag-start handler");
  await act(async () => { handler(event(projectId, cardData(stageKey, projectId), null)); await Promise.resolve(); });
}

async function over(overId: string, overData: unknown) {
  const handler = dnd.handlers.at(-1)?.over;
  if (!handler) throw new Error("No drag-over handler");
  await act(async () => { handler(event("source", cardData("awaiting_raw", "source"), { id: overId, data: overData })); await Promise.resolve(); });
}

async function overProject(activeId: string, activeStage: "awaiting_raw" | "raw_review", overId: string, overData: unknown) {
  const handler = dnd.handlers.at(-1)?.over;
  if (!handler) throw new Error("No drag-over handler");
  await act(async () => { handler(event(activeId, cardData(activeStage, activeId), { id: overId, data: overData })); await Promise.resolve(); });
}

async function end(overTarget: { id: string; data: unknown } | null) {
  const handler = dnd.handlers.at(-1)?.end;
  if (!handler) throw new Error("No drag-end handler");
  await act(async () => { handler(event("source", cardData("awaiting_raw", "source"), overTarget)); await Promise.resolve(); });
}

async function endProject(activeId: string, activeStage: "awaiting_raw" | "raw_review", overTarget: { id: string; data: unknown } | null) {
  const handler = dnd.handlers.at(-1)?.end;
  if (!handler) throw new Error("No drag-end handler");
  await act(async () => { handler(event(activeId, cardData(activeStage, activeId), overTarget)); await Promise.resolve(); });
}

describe("ProjectKanbanBoard", () => {
  beforeEach(() => {
    dnd.handlers.length = 0;
    sortable.contexts.length = 0;
    Object.values(callbacks).forEach((callback) => callback.mockReset());
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("composes one DndContext, one SortableContext per Stage, and a non-restoring accessibility policy", async () => {
    await renderBoard();
    expect(dnd.handlers).toHaveLength(1);
    expect(sortable.contexts).toEqual([["source"], ["visual-second", "visual-first"], []]);
    expect(dnd.handlers[0]?.props.accessibility?.restoreFocus).toBe(false);
    expect(dnd.handlers[0]?.props.accessibility?.screenReaderInstructions?.draggable).toContain("focus its Move project handle");
  });

  it("keeps the handle as a disabled button sibling of a plain project anchor", async () => {
    await renderBoard({ boardMutationEnabled: false, canMoveStages: false });
    const anchor = host.querySelector<HTMLAnchorElement>('[href="/projects/source"]');
    const handle = host.querySelector<HTMLButtonElement>('[aria-label="Move source Street"]');
    expect(anchor?.getAttribute("draggable")).toBeNull();
    expect(anchor?.parentElement?.contains(handle)).toBe(true);
    expect(handle?.tagName).toBe("BUTTON");
    expect(handle?.disabled).toBe(true);
  });

  it("registers empty column bodies and routes a cross-Stage end to the semantic gap", async () => {
    await renderBoard();
    expect(host.querySelector('[data-droppable-id="column:editing_autohdr"]')).not.toBeNull();
    await start();
    await end({ id: "visual-first", data: cardData("raw_review", "visual-first") });
    expect(callbacks.onCrossStageMove).toHaveBeenCalledWith("source", { targetStageKey: "raw_review", successor: "visual-first" }, expect.objectContaining({ control: "handle", projectId: "source" }));
  });

  it("uses the visual successor when Priority sorting changes the canonical Board order", async () => {
    await renderBoard({ effectiveKanbanSort: "priority" });
    await start();
    await over("visual-first", cardData("raw_review", "visual-first"));
    const state = callbacks.onInteractionStateChange.mock.calls.at(-1)?.[0];
    expect(state?.proposal).toEqual({ targetStageKey: "raw_review", successor: "visual-first" });
    await end({ id: "visual-first", data: cardData("raw_review", "visual-first") });
    expect(callbacks.onCrossStageMove).toHaveBeenCalledWith("source", { targetStageKey: "raw_review", successor: "visual-first" }, expect.anything());
  });

  it("treats a same-Stage drop as a no-op", async () => {
    await renderBoard();
    await start();
    await end({ id: "source", data: cardData("awaiting_raw", "source") });
    expect(callbacks.onCrossStageMove).not.toHaveBeenCalled();
    expect(callbacks.onAnnounce).toHaveBeenCalledWith(expect.stringContaining("Cancelled moving source Street"));
  });

  it("routes an eligible same-Stage drag through the general Board movement callback", async () => {
    const onBoardMove = vi.fn();
    await renderBoard({ sameStageReorderEnabled: true, onBoardMove });
    await startProject("visual-first", "raw_review");
    await overProject("visual-first", "raw_review", "visual-second", cardData("raw_review", "visual-second"));
    await endProject("visual-first", "raw_review", { id: "visual-second", data: cardData("raw_review", "visual-second") });
    expect(onBoardMove).toHaveBeenCalledWith("visual-first", { targetStageKey: "raw_review", successor: "visual-second" }, "same", expect.objectContaining({ projectId: "visual-first" }));
  });

  it("captures the empty-column semantic gap", async () => {
    await renderBoard();
    await start();
    await over("column:raw_review", columnData("raw_review"));
    await end({ id: "column:raw_review", data: columnData("raw_review") });
    expect(callbacks.onCrossStageMove).toHaveBeenCalledWith("source", { targetStageKey: "raw_review", successor: "end" }, expect.anything());
  });
});
