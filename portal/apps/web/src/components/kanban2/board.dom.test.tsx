// happy-dom cannot exercise real PointerSensor/KeyboardSensor drag activation — see
// `ProjectKanbanBoard.dom.test.tsx`'s header. This test drives the captured `DndContext`
// `onDragEnd` handler directly, the same technique the existing Board's test suite uses.
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DragEndEvent } from "@dnd-kit/core";
import { ProjectKanbanBoard2 } from "./board";
import type { ProjectKanbanBoardProps, ProjectSummary } from "../../lib/kanban-interaction";
import type { PipelineStage } from "../../lib/stages";

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
});
