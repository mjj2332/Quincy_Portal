/**
 * #344 / #678 / #679 — the vendored Gantt's per-Project add-task editor (`onCreateGroupTask`, gated
 * per group by `canCreateTask({ parentId })`). #679: no idle "+ Add task" rows; each creatable
 * group's name cell carries a `+` button that opens ONE editor row after the group's last visible
 * descendant (the group's own row when it has none). #678: the editor row keeps the tree row's cell
 * structure (name cell, then one cell per column carrying `GanttColumn.renderCreate`), and at phone
 * width (no column renders a create cell) the editor is a bottom sheet carrying `renderCreateStack`.
 * Also pinned: the tree/timeline spacer pairing, empty `children: []` groups (leaves with a `+`),
 * collapse and permission gating, off-by-default, Up/Down focus movement, and the input's Enter /
 * Esc / empty / failure / double-submit behaviour.
 *
 * happy-dom has no layout; cells are selected by `data-testid` / accessible name (test-seam
 * guard F). `getAnimations` polyfill: see `gantt-adjust-ghost-marker.dom.test.tsx`'s header.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, useContext, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayCollisionBoundaryContext, OverlayContainerContext } from "@/components/OverlayContainerContext";
import { Sheet, SheetContent } from "@/components/reui/sheet";
import { Gantt } from "@/components/reui/gantt/gantt";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import type { GanttColumn } from "@/components/reui/gantt/gantt";
import type { GanttResource } from "@/components/reui/gantt/gantt-types";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => {
    root!.render(value);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
      await Promise.resolve();
    });
  }
  root = null;
  host.remove();
});

const START = new Date("2026-03-02T00:00:00.000Z");
const RESOURCES: GanttResource[] = [
  { id: "a", title: "Alpha", children: [{ id: "a1", title: "A one" }, { id: "a2", title: "A two" }] },
  { id: "b", title: "Bravo", children: [] },
  { id: "c", title: "Charlie", children: [{ id: "c1", title: "C one" }] },
];

type Create = NonNullable<React.ComponentProps<typeof Gantt>["onCreateGroupTask"]>;
type Result = Awaited<ReturnType<Create>>;

function view(props: Partial<React.ComponentProps<typeof Gantt>> = {}, resources: GanttResource[] = RESOURCES): ReactNode {
  return (
    <Gantt resources={resources} events={[]} date={START} scale="day" timeZone="UTC" {...props}>
      <GanttView />
    </Gantt>
  );
}

const ok = async (): Promise<Result> => ({ ok: true });

function errorRegion(): HTMLElement {
  const el = host.querySelector<HTMLElement>('[data-testid="gantt-group-create-task-error"]');
  if (!el) throw new Error("no error region");
  return el;
}

function errorRegionIn(scope: HTMLElement): HTMLElement {
  const el = scope.querySelector<HTMLElement>('[data-testid="gantt-group-create-task-error"]');
  if (!el) throw new Error("no error region");
  return el;
}

function createButton(group: string): HTMLButtonElement | null {
  return [...host.querySelectorAll<HTMLButtonElement>('[data-testid="gantt-group-create-task"]')].find((el) => el.getAttribute("aria-label") === `Add task in ${group}`) ?? null;
}

function cancelButton(): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>('[data-testid="gantt-group-create-task-cancel"]');
}

function spacers(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[data-testid="gantt-group-create-task-spacer"]')];
}

function createRows(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[data-testid="gantt-group-create-task-row"]')];
}

/** The tree's row text in DOM order: name cells and create rows, so ordering is observable. */
function treeOrder(): string[] {
  const tree = host.querySelector<HTMLElement>('[data-testid="gantt-tree-name-cell"]')!.closest("[data-gantt-row-id]")!.parentElement!;
  return [...tree.children].map((el) => {
    const create = (el as HTMLElement).dataset.ganttCreateFor;
    return create ? `+${create}` : (el.textContent ?? "").trim();
  });
}

function input(): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>('[data-testid="gantt-group-create-task-input"]');
  if (!el) throw new Error("no create input");
  return el;
}

async function setValue(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function key(el: EventTarget, name: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: name }));
    await Promise.resolve();
  });
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

describe("gantt per-group add-task editor (#679)", () => {
  it("is off unless onCreateGroupTask is passed: no + buttons, no editor, and an empty group stays a leaf", async () => {
    await render(view());
    expect(createRows()).toHaveLength(0);
    expect(createButton("Alpha")).toBeNull();
    expect(host.querySelector('button[aria-label="Bravo"]')).toBeNull();
  });

  it("renders no idle rows and no spacers; every creatable group's row carries a + button, expanded or not", async () => {
    await render(view({ onCreateGroupTask: ok }));
    expect(treeOrder()).toEqual(["Alpha", "A one", "A two", "Bravo", "Charlie", "C one"]);
    expect(createRows()).toHaveLength(0);
    expect(spacers()).toHaveLength(0);
    for (const group of ["Alpha", "Bravo", "Charlie"]) {
      const plus = createButton(group)!;
      expect(plus).not.toBeNull();
      expect(plus.getAttribute("aria-expanded")).toBe("false");
      expect(plus.hasAttribute("data-gantt-tree-focus")).toBe(true);
      // the + lives in the group's own row, not in a row of its own
      expect(plus.closest("[data-gantt-row-id]")!.getAttribute("data-gantt-row-id")).toBe(group.toLowerCase().charAt(0));
    }
  });

  it("an empty creatable group is a leaf: no chevron promising hidden children, but it keeps its +", async () => {
    await render(view({ onCreateGroupTask: ok }));
    expect(host.querySelector('button[aria-label="Bravo"]')).toBeNull();
    expect(createButton("Bravo")).not.toBeNull();
  });

  it("the + is revealed on hover and focus, and stays visible on touch, on phones and while its editor is open", async () => {
    await render(view({ onCreateGroupTask: ok }));
    const cls = createButton("Alpha")!.className;
    expect(cls).toContain("opacity-0");
    expect(cls).toContain("group-hover/gantt-row:opacity-100");
    expect(cls).toContain("focus-visible:opacity-100");
    expect(cls).toContain("pointer-coarse:opacity-100");
    expect(cls).toContain("max-[720px]:opacity-100");
    expect(cls).toContain("aria-expanded:opacity-100");
    // a real 44px hit area on touch and phones
    expect(cls).toContain("pointer-coarse:min-h-[44px]");
    expect(cls).toContain("pointer-coarse:min-w-[44px]");
    expect(cls).toContain("max-[720px]:min-h-[44px]");
    expect(cls).toContain("max-[720px]:min-w-[44px]");
  });

  it("canCreateTask gates each group; a refused group has no + and stays a leaf", async () => {
    await render(view({ onCreateGroupTask: ok, canCreateTask: ({ parentId }) => parentId === "a" }));
    expect(createButton("Alpha")).not.toBeNull();
    expect(createButton("Bravo")).toBeNull();
    expect(createButton("Charlie")).toBeNull();
    expect(host.querySelector('button[aria-label="Bravo"]')).toBeNull();
  });

  it("pressing + opens exactly one editor after the group's last visible descendant, with one matching spacer", async () => {
    await render(view({ onCreateGroupTask: ok }));
    await click(createButton("Alpha")!);
    expect(treeOrder()).toEqual(["Alpha", "A one", "A two", "+a", "Bravo", "Charlie", "C one"]);
    expect(spacers()).toHaveLength(1);
    expect(createButton("Alpha")!.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute("aria-label")).toBe("New task title in Alpha");
  });

  it("an empty group's editor sits directly under the group's own row", async () => {
    await render(view({ onCreateGroupTask: ok }));
    await click(createButton("Bravo")!);
    expect(treeOrder()).toEqual(["Alpha", "A one", "A two", "Bravo", "+b", "Charlie", "C one"]);
  });

  it("pressing + on a collapsed group expands it first, then opens the editor", async () => {
    await render(view({ onCreateGroupTask: ok }));
    await click(host.querySelector<HTMLElement>('button[aria-label="Alpha"]')!);
    expect(treeOrder()).toEqual(["Alpha", "Bravo", "Charlie", "C one"]);
    expect(createButton("Alpha")).not.toBeNull();
    await click(createButton("Alpha")!);
    expect(treeOrder()).toEqual(["Alpha", "A one", "A two", "+a", "Bravo", "Charlie", "C one"]);
    expect(host.querySelector('button[aria-label="Alpha"]')!.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(input());
  });

  it("collapsing the group whose editor is open removes the editor and its spacer", async () => {
    await render(view({ onCreateGroupTask: ok }));
    await click(createButton("Alpha")!);
    await click(host.querySelector<HTMLElement>('button[aria-label="Alpha"]')!);
    expect(createRows()).toHaveLength(0);
    expect(spacers()).toHaveLength(0);
  });

  it("only one editor exists: pressing another group's + moves an EMPTY editor there", async () => {
    await render(view({ onCreateGroupTask: ok }));
    await click(createButton("Alpha")!);
    await click(createButton("Charlie")!);
    expect(createRows().map((row) => row.dataset.ganttCreateFor)).toEqual(["c"]);
    expect(spacers()).toHaveLength(1);
    expect(createButton("Alpha")!.getAttribute("aria-expanded")).toBe("false");
    expect(createButton("Charlie")!.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(input());
    expect(input().getAttribute("aria-label")).toBe("New task title in Charlie");
  });

  it("a draft with a typed title is never lost: another group's + keeps the open editor and focuses it", async () => {
    await render(view({ onCreateGroupTask: ok }));
    await click(createButton("Alpha")!);
    await setValue(input(), "Half typed");
    await act(async () => createButton("Charlie")!.focus());
    await click(createButton("Charlie")!);
    expect(createRows().map((row) => row.dataset.ganttCreateFor)).toEqual(["a"]);
    expect(input().value).toBe("Half typed");
    expect(document.activeElement).toBe(input());
  });

  it("a draft the consumer reports dirty (createTaskDirty) also keeps the editor on a switch", async () => {
    await render(view({ onCreateGroupTask: ok, createTaskDirty: true }));
    await click(createButton("Alpha")!);
    await click(createButton("Charlie")!);
    expect(createRows().map((row) => row.dataset.ganttCreateFor)).toEqual(["a"]);
    expect(document.activeElement).toBe(input());
  });

  it("Tab order is chevron, +, next group; Up/Down walk the same stops; Enter on + opens the input", async () => {
    await render(view({ onCreateGroupTask: ok, rowCheckboxes: false }));
    const focusOrder = ["Alpha", "Add task in Alpha", "Add task in Bravo", "Charlie", "Add task in Charlie"];
    const start = host.querySelector<HTMLElement>('button[aria-label="Alpha"]')!;
    await act(async () => start.focus());
    const seen = [(document.activeElement as HTMLElement).getAttribute("aria-label")];
    for (let i = 1; i < focusOrder.length; i += 1) {
      await key(document.activeElement!, "ArrowDown");
      seen.push((document.activeElement as HTMLElement).getAttribute("aria-label"));
    }
    expect(seen).toEqual(focusOrder);
    await key(document.activeElement!, "ArrowDown");
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("Add task in Charlie");
    await key(document.activeElement!, "ArrowUp");
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe("Charlie");
    await key(document.activeElement!, "ArrowDown");
    await key(document.activeElement!, "Enter");
    expect(input().getAttribute("aria-label")).toBe("New task title in Charlie");
    expect(document.activeElement).toBe(input());
  });

  it("Enter with a title calls onCreateGroupTask with the group id and the trimmed title, then closes and restores focus to the +", async () => {
    const create = vi.fn<Create>(ok);
    await render(view({ onCreateGroupTask: create }));
    await click(createButton("Bravo")!);
    await setValue(input(), "  Cull selects  ");
    await key(input(), "Enter");
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ parentId: "b", index: 0, title: "Cull selects" });
    expect(host.querySelector('[data-testid="gantt-group-create-task-input"]')).toBeNull();
    expect(spacers()).toHaveLength(0);
    expect(document.activeElement).toBe(createButton("Bravo"));
  });

  it("an empty or whitespace title is refused: nothing is sent and the input stays open", async () => {
    const create = vi.fn<Create>(ok);
    await render(view({ onCreateGroupTask: create }));
    await click(createButton("Alpha")!);
    await key(input(), "Enter");
    await setValue(input(), "   ");
    await key(input(), "Enter");
    expect(create).not.toHaveBeenCalled();
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(input().placeholder).toBe("Enter a task title.");
    expect(errorRegion().textContent).toBe("Enter a task title.");
  });

  it("an error can never be clipped by the tree: it is in the row's flow, not an absolutely positioned overlay", async () => {
    const create = vi.fn<Create>(async () => ({ ok: false, message: "Nope." }));
    await render(view({ onCreateGroupTask: create }));
    await click(createButton("Alpha")!);
    await setValue(input(), "Keep me");
    await key(input(), "Enter");
    await settle();
    const region = errorRegion();
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.closest('[data-testid="gantt-group-create-task-row"]')).not.toBeNull();
    expect(input().getAttribute("aria-describedby")).toBe(region.id);
    expect(region.className).not.toMatch(/\babsolute\b/);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("Esc cancels without a call, discards the draft, and returns focus to the group's +", async () => {
    const create = vi.fn<Create>(ok);
    await render(view({ onCreateGroupTask: create }));
    await click(createButton("Alpha")!);
    await setValue(input(), "Draft");
    await key(input(), "Escape");
    expect(create).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="gantt-group-create-task-input"]')).toBeNull();
    expect(document.activeElement).toBe(createButton("Alpha"));
    await click(createButton("Alpha")!);
    expect(input().value).toBe("");
  });

  it("the x in the name gutter cancels the same way, named for its group", async () => {
    const create = vi.fn<Create>(ok);
    await render(view({ onCreateGroupTask: create }));
    await click(createButton("Alpha")!);
    await setValue(input(), "Draft");
    const x = cancelButton()!;
    expect(x.getAttribute("aria-label")).toBe("Cancel adding task in Alpha");
    expect(x.closest('[data-testid="gantt-group-create-task-name-cell"]')).not.toBeNull();
    await click(x);
    expect(create).not.toHaveBeenCalled();
    expect(createRows()).toHaveLength(0);
    expect(document.activeElement).toBe(createButton("Alpha"));
  });

  it("a failed create shows the message and keeps the typed title and the input", async () => {
    const create = vi.fn<Create>(async () => ({ ok: false, message: "Nope." }));
    await render(view({ onCreateGroupTask: create }));
    await click(createButton("Alpha")!);
    await setValue(input(), "Keep me");
    await key(input(), "Enter");
    await settle();
    expect(input().value).toBe("Keep me");
    expect(errorRegion().textContent).toBe("Nope.");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(input().hasAttribute("readonly")).toBe(false);
    await setValue(input(), "Keep me 2");
    expect(errorRegion().textContent).toBe("");
    expect(input().hasAttribute("aria-invalid")).toBe(false);
  });

  it("ignores a second Enter while the first create is pending", async () => {
    let release!: (value: Result) => void;
    const create = vi.fn<Create>(() => new Promise<Result>((resolve) => { release = resolve; }));
    await render(view({ onCreateGroupTask: create }));
    await click(createButton("Alpha")!);
    await setValue(input(), "Once");
    await key(input(), "Enter");
    await key(input(), "Enter");
    expect(create).toHaveBeenCalledTimes(1);
    expect(input().getAttribute("aria-busy")).toBe("true");
    await act(async () => release({ ok: true }));
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="gantt-group-create-task-input"]')).toBeNull();
  });

  it("keeps a typed draft when the resources are re-supplied", async () => {
    await render(view({ onCreateGroupTask: ok }));
    await click(createButton("Alpha")!);
    await setValue(input(), "Half typed");
    await render(view({ onCreateGroupTask: ok }, [...RESOURCES]));
    expect(input().value).toBe("Half typed");
  });

  it("keeps a typed draft and the editor when a child is added above it", async () => {
    await render(view({ onCreateGroupTask: ok }));
    await click(createButton("Alpha")!);
    await setValue(input(), "Half typed");
    const grown = RESOURCES.map((r) => (r.id === "a" ? { ...r, children: [...r.children!, { id: "a3", title: "A three" }] } : r));
    await render(view({ onCreateGroupTask: ok }, grown));
    expect(treeOrder().slice(0, 5)).toEqual(["Alpha", "A one", "A two", "A three", "+a"]);
    expect(input().value).toBe("Half typed");
    expect(document.activeElement).toBe(input());
  });

  it("closes the editor and tells the consumer when its group leaves the data", async () => {
    const closed = vi.fn();
    await render(view({ onCreateGroupTask: ok, onCreateTaskClose: closed }));
    await click(createButton("Alpha")!);
    await render(view({ onCreateGroupTask: ok, onCreateTaskClose: closed }, RESOURCES.filter((r) => r.id !== "a")));
    expect(createRows()).toHaveLength(0);
    expect(closed).toHaveBeenCalledWith({ parentId: "a" });
  });

  it("closes the editor when createTaskResetKey changes (a filter or identity change)", async () => {
    const closed = vi.fn();
    await render(view({ onCreateGroupTask: ok, onCreateTaskClose: closed, createTaskResetKey: "one" }));
    await click(createButton("Alpha")!);
    await setValue(input(), "Draft");
    await render(view({ onCreateGroupTask: ok, onCreateTaskClose: closed, createTaskResetKey: "two" }));
    expect(createRows()).toHaveLength(0);
    expect(closed).toHaveBeenCalledWith({ parentId: "a" });
  });

  it("tells the consumer on cancel and on a successful create, so it can drop its half of the draft", async () => {
    const closed = vi.fn();
    await render(view({ onCreateGroupTask: ok, onCreateTaskClose: closed }));
    await click(createButton("Alpha")!);
    await key(input(), "Escape");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenLastCalledWith({ parentId: "a" });
    await click(createButton("Bravo")!);
    await setValue(input(), "Made");
    await key(input(), "Enter");
    await settle();
    expect(closed).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenLastCalledWith({ parentId: "b" });
  });

  it("moving focus into the input and back to the + never scrolls the tree pane (preventScroll)", async () => {
    await render(view({ onCreateGroupTask: ok }));
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await click(createButton("Alpha")!);
    const toInput = focus.mock.contexts.findIndex((el) => el === input());
    expect(toInput).toBeGreaterThanOrEqual(0);
    expect(focus.mock.calls[toInput]![0]).toEqual({ preventScroll: true });
    focus.mockClear();
    await key(input(), "Escape");
    const toPlus = focus.mock.contexts.findIndex((el) => el === createButton("Alpha"));
    expect(toPlus).toBeGreaterThanOrEqual(0);
    expect(focus.mock.calls[toPlus]![0]).toEqual({ preventScroll: true });
    expect(document.activeElement).toBe(createButton("Alpha"));
    focus.mockRestore();
  });

  it("the input is sized inside the row (h-7) and its placeholder reads as an error when invalid", async () => {
    await render(view({ onCreateGroupTask: ok }));
    await click(createButton("Alpha")!);
    expect(input().className).toMatch(/(^|\s)h-7(\s|$)/);
    expect(input().className).toContain("aria-invalid:placeholder:text-destructive");
  });

  it("maxLength comes from createTaskMaxLength", async () => {
    await render(view({ onCreateGroupTask: ok, createTaskMaxLength: 500 }));
    await click(createButton("Alpha")!);
    expect(input().maxLength).toBe(500);
  });
});

describe("gantt add-task editor keeps the row's columns (#678)", () => {
  type CreateCtx = Parameters<NonNullable<GanttColumn["renderCreate"]>>[0];
  const people: GanttColumn = {
    id: "people",
    title: "People",
    width: 88,
    render: () => null,
    renderCreate: (ctx: CreateCtx) => <span data-testid="draft-people" data-parent={ctx.parentId} data-title={ctx.parentTitle} data-pending={String(ctx.pending)} />,
  };
  const due: GanttColumn = {
    id: "due",
    title: "Due",
    width: 128,
    render: () => null,
    renderCreate: () => <button type="button" data-testid="draft-due">Due</button>,
  };
  const bare: GanttColumn = { id: "extra", width: 60, render: () => null };

  it("the title input is inside the name cell, not the whole row; one cell per column follows, in column order and width", async () => {
    await render(view({ onCreateGroupTask: ok, columns: [people, due, bare] }));
    await click(createButton("Alpha")!);
    const row = createRows()[0]!;
    const nameCell = row.querySelector<HTMLElement>('[data-testid="gantt-group-create-task-name-cell"]')!;
    expect(nameCell).not.toBeNull();
    expect(nameCell.contains(input())).toBe(true);
    // same cell structure as GanttTreeRow: name cell, then one cell per column
    const cells = [...row.querySelectorAll<HTMLElement>("[data-column]")];
    expect(cells.map((cell) => cell.dataset.column)).toEqual(["people", "due", "extra"]);
    expect(cells.map((cell) => cell.style.width)).toEqual(["88px", "128px", "60px"]);
    expect(cells[0]!.querySelector('[data-testid="draft-people"]')).not.toBeNull();
    expect(cells[1]!.querySelector('[data-testid="draft-due"]')).not.toBeNull();
    // a column without renderCreate keeps its (empty) cell so the others stay aligned
    expect(cells[2]!.textContent).toBe("");
    // the name cell takes the same inline width a tree row's name cell does
    const treeNameCell = host.querySelector<HTMLElement>('[data-testid="gantt-tree-name-cell"]')!;
    expect(nameCell.style.width).toBe(treeNameCell.style.width);
    expect(nameCell.contains(cells[0]!)).toBe(false);
  });

  it("hands renderCreate the group's id and title and the pending state", async () => {
    let release!: (value: Result) => void;
    const create = vi.fn<Create>(() => new Promise<Result>((resolve) => { release = resolve; }));
    await render(view({ onCreateGroupTask: create, columns: [people] }));
    await click(createButton("Alpha")!);
    const probe = () => host.querySelector<HTMLElement>('[data-testid="draft-people"]')!;
    expect(probe().dataset.parent).toBe("a");
    expect(probe().dataset.title).toBe("Alpha");
    expect(probe().dataset.pending).toBe("false");
    await setValue(input(), "Go");
    await key(input(), "Enter");
    expect(probe().dataset.pending).toBe("true");
    await act(async () => release({ ok: true }));
    await settle();
  });

  it("the editor row and its timeline spacer share one height", async () => {
    await render(view({ onCreateGroupTask: ok, columns: [people, due] }));
    await click(createButton("Alpha")!);
    expect(createRows()[0]!.style.height).toBe(spacers()[0]!.style.height);
  });

  it("a press, a key or an Escape inside a draft cell does not cancel the draft or move tree focus", async () => {
    await render(view({ onCreateGroupTask: ok, columns: [people, due], rowCheckboxes: false }));
    await click(createButton("Alpha")!);
    await setValue(input(), "Keep");
    const dueButton = host.querySelector<HTMLElement>('[data-testid="draft-due"]')!;
    await act(async () => dueButton.focus());
    await key(dueButton, "Escape");
    await key(dueButton, "ArrowDown");
    expect(createRows()).toHaveLength(1);
    expect(input().value).toBe("Keep");
    expect(document.activeElement).toBe(dueButton);
  });

  describe("with no column to align to (<= 720px) the editor is a bottom sheet", () => {
    const sheet = () => document.querySelector<HTMLElement>('[data-testid="gantt-group-create-task-sheet"]');
    const addButton = () => document.querySelector<HTMLButtonElement>('[data-testid="gantt-group-create-task-add"]')!;
    const sheetCancel = () => document.querySelector<HTMLButtonElement>('[data-testid="gantt-group-create-task-cancel"]')!;
    const sheetInput = () => document.querySelector<HTMLInputElement>('[data-testid="gantt-group-create-task-input"]')!;
    const stackView = (stack: (ctx: CreateCtx) => ReactNode = vi.fn((ctx: CreateCtx) => <span data-testid="draft-stack" data-parent={ctx.parentId} />), props: Partial<React.ComponentProps<typeof Gantt>> = {}) =>
      view({ onCreateGroupTask: ok, renderCreateStack: stack, ...props });

    it("opens a modal bottom sheet headed with the Project, instead of a row: no row, no spacer, no tree gap", async () => {
      await render(stackView());
      await click(createButton("Alpha")!);
      const popup = sheet()!;
      expect(popup).not.toBeNull();
      expect(popup.getAttribute("data-side")).toBe("bottom");
      expect(popup.textContent).toContain("New task in Alpha");
      expect(createRows()).toHaveLength(0);
      expect(spacers()).toHaveLength(0);
      expect(host.querySelector('[data-testid="gantt-group-create-task-tree-spacer"]')).toBeNull();
      expect(host.contains(popup)).toBe(false);
      expect(treeOrder()).toEqual(["Alpha", "A one", "A two", "Bravo", "Charlie", "C one"]);
      expect(popup.querySelector('[data-testid="gantt-group-create-task-stack"] [data-testid="draft-stack"]')).not.toBeNull();
      expect(createButton("Alpha")!.getAttribute("aria-expanded")).toBe("true");
    });

    it("focuses the title; Add is disabled while the title is empty and posts the trimmed title once", async () => {
      let release!: () => void;
      const create = vi.fn(() => new Promise<Result>((resolve) => { release = () => resolve({ ok: true }); }));
      await render(stackView(undefined, { onCreateGroupTask: create }));
      await click(createButton("Alpha")!);
      expect(document.activeElement).toBe(sheetInput());
      expect(sheetInput().placeholder).toBe("New task");
      expect(addButton().disabled).toBe(true);
      await setValue(sheetInput(), "  Hello  ");
      expect(addButton().disabled).toBe(false);
      await click(addButton());
      expect(addButton().disabled).toBe(true);
      await click(addButton());
      await act(async () => { release(); await Promise.resolve(); });
      await settle();
      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith({ parentId: "a", index: 2, title: "Hello" });
    });

    it("success closes the sheet and returns focus to the + that opened it", async () => {
      await render(stackView());
      await click(createButton("Alpha")!);
      await setValue(sheetInput(), "Done");
      await click(addButton());
      await settle();
      expect(sheet()).toBeNull();
      expect(document.activeElement).toBe(createButton("Alpha"));
    });

    it("a failed write keeps the sheet and the typed title", async () => {
      const create = vi.fn(async (): Promise<Result> => ({ ok: false, message: "No" }));
      await render(stackView(undefined, { onCreateGroupTask: create }));
      await click(createButton("Alpha")!);
      await setValue(sheetInput(), "Keep me");
      await click(addButton());
      await settle();
      expect(sheet()).not.toBeNull();
      expect(sheetInput().value).toBe("Keep me");
      expect(errorRegionIn(sheet()!).textContent).toBe("No");
      expect(addButton().disabled).toBe(false);
    });

    it("Cancel and Escape close it without a write and return focus to the +", async () => {
      const create = vi.fn(ok);
      await render(stackView(undefined, { onCreateGroupTask: create }));
      await click(createButton("Alpha")!);
      await setValue(sheetInput(), "Nope");
      await click(sheetCancel());
      await settle();
      expect(sheet()).toBeNull();
      expect(document.activeElement).toBe(createButton("Alpha"));
      await click(createButton("Alpha")!);
      expect(sheetInput().value).toBe("");
      await key(sheetInput(), "Escape");
      await settle();
      expect(sheet()).toBeNull();
      expect(document.activeElement).toBe(createButton("Alpha"));
      expect(create).not.toHaveBeenCalled();
    });

    it("a press on the scrim closes it and returns focus to the +", async () => {
      await render(stackView());
      await click(createButton("Alpha")!);
      const scrim = document.querySelector<HTMLElement>('[data-testid="gantt-group-create-task-scrim"]')!;
      await act(async () => {
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) scrim.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
        await Promise.resolve();
      });
      await settle();
      expect(sheet()).toBeNull();
      expect(document.activeElement).toBe(createButton("Alpha"));
    });

    it("the scrim mounts even when the Gantt itself sits inside another Sheet (a nested dialog gets no backdrop by default)", async () => {
      await render(
        <Sheet open>
          <SheetContent showCloseButton={false}>{stackView()}</SheetContent>
        </Sheet>
      );
      const plus = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="gantt-group-create-task"]')].find((el) => el.getAttribute("aria-label") === "Add task in Alpha")!;
      await click(plus);
      expect(sheet()).not.toBeNull();
      expect(document.querySelector('[data-testid="gantt-group-create-task-scrim"]')).not.toBeNull();
    });

    it("provides the sheet itself as the popups' collision boundary", async () => {
      let seen: HTMLElement | null | undefined;
      function Probe() {
        seen = useContext(OverlayCollisionBoundaryContext);
        return <span data-testid="draft-stack" />;
      }
      await render(stackView(() => <Probe />));
      await click(createButton("Alpha")!);
      expect(seen).toBe(sheet());
    });

    it("provides an overlay slot: the draft's controls get it through OverlayContainerContext", async () => {
      let seen: HTMLElement | null | undefined;
      function Probe() {
        seen = useContext(OverlayContainerContext);
        return <span data-testid="draft-stack" />;
      }
      await render(stackView(() => <Probe />));
      await click(createButton("Alpha")!);
      const slot = document.querySelector<HTMLElement>('[data-testid="gantt-group-create-task-overlay-slot"]')!;
      expect(slot).not.toBeNull();
      expect(sheet()!.contains(slot)).toBe(true);
      expect(seen).toBe(slot);
    });

    it("keeps the sticky + clear of its focus ring at <= 720px (inset by --space-1, not an inward ring)", async () => {
      await render(stackView());
      const cls = createButton("Alpha")!.className;
      expect(cls).toContain("max-[720px]:end-[var(--space-1)]");
      expect(cls).not.toContain("ring-inset");
    });
  });

  it("the title says New task; the x has the 44px coarse and phone targets; the + is sticky at the pane's right edge on a backing and shows when focused (#678)", async () => {
    await render(view({ onCreateGroupTask: ok, columns: [people, due] }));
    const plusButton = createButton("Alpha")!;
    for (const cls of ["sticky", "end-0", "bg-background", "focus:opacity-100", "focus-visible:opacity-100"]) expect(plusButton.className).toContain(cls);
    await click(plusButton);
    expect(input().placeholder).toBe("New task");
    const cancel = host.querySelector<HTMLElement>('[data-testid="gantt-group-create-task-cancel"]')!;
    for (const cls of ["pointer-coarse:min-h-[44px]", "pointer-coarse:min-w-[44px]", "max-[720px]:min-h-[44px]", "max-[720px]:min-w-[44px]"]) expect(cancel.className).toContain(cls);
  });

  it("renderCreateStack is ignored when a column carries a create cell", async () => {
    await render(view({ onCreateGroupTask: ok, columns: [people], renderCreateStack: () => <span data-testid="draft-stack" /> }));
    await click(createButton("Alpha")!);
    expect(document.querySelector('[data-testid="draft-stack"]')).toBeNull();
    expect(createRows()[0]!.style.height).toBe("2.5rem");
  });
});
