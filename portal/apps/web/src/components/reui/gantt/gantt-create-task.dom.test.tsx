/**
 * #344 — the vendored Gantt's per-group "+ Add task" row (`onCreateGroupTask`, gated per group by
 * `canCreateTask({ parentId })`). Pins: row placement after each EXPANDED group's last descendant,
 * the tree/timeline pane spacer pairing, an empty `children: []` group, collapse and permission
 * gating, off-by-default (root-only consumers unchanged), Up/Down focus movement including create
 * rows, and the input's Enter / Esc / empty / failure / double-submit behaviour.
 *
 * happy-dom has no layout; cells are selected by `data-testid` / accessible name (test-seam
 * guard F). `getAnimations` polyfill: see `gantt-adjust-ghost-marker.dom.test.tsx`'s header.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gantt } from "@/components/reui/gantt/gantt";
import { GanttView } from "@/components/reui/gantt/gantt-view";
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

function createButton(group: string): HTMLButtonElement | null {
  return [...host.querySelectorAll<HTMLButtonElement>('[data-testid="gantt-group-create-task"]')].find((el) => el.getAttribute("aria-label") === `Add task in ${group}`) ?? null;
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

describe("gantt per-group create row (#344)", () => {
  it("is off unless onCreateGroupTask is passed: no create rows, and an empty group stays a leaf", async () => {
    await render(view());
    expect(createRows()).toHaveLength(0);
    expect(host.querySelector('button[aria-label="Bravo"]')).toBeNull();
  });

  it("places a create row after each expanded group's last descendant, with a matching timeline spacer, and makes an empty group a group", async () => {
    await render(view({ onCreateGroupTask: ok }));
    expect(treeOrder()).toEqual(["Alpha", "A one", "A two", "+a", "Bravo", "+b", "Charlie", "C one", "+c"]);
    expect(host.querySelectorAll('[data-testid="gantt-group-create-task-spacer"]')).toHaveLength(3);
    // the empty group is expandable: it has a toggle named for it
    expect(host.querySelector('button[aria-label="Bravo"][aria-expanded="true"]')).not.toBeNull();
  });

  it("removes a group's create row when it is collapsed, and restores it on expand", async () => {
    await render(view({ onCreateGroupTask: ok }));
    await click(host.querySelector<HTMLElement>('button[aria-label="Alpha"]')!);
    expect(treeOrder()).toEqual(["Alpha", "Bravo", "+b", "Charlie", "C one", "+c"]);
    expect(host.querySelectorAll('[data-testid="gantt-group-create-task-spacer"]')).toHaveLength(2);
    await click(host.querySelector<HTMLElement>('button[aria-label="Alpha"]')!);
    expect(createButton("Alpha")).not.toBeNull();
  });

  it("canCreateTask gates each group; a refused empty group stays a leaf", async () => {
    await render(view({ onCreateGroupTask: ok, canCreateTask: ({ parentId }) => parentId === "a" }));
    expect(createRows().map((row) => row.dataset.ganttCreateFor)).toEqual(["a"]);
    expect(host.querySelector('button[aria-label="Bravo"]')).toBeNull();
  });

  it("names each row for its group and keeps the visible label", async () => {
    await render(view({ onCreateGroupTask: ok }));
    const button = createButton("Bravo")!;
    expect(button.textContent).toBe("Add task");
  });

  it("Up/Down move focus through group toggles and create rows in order; Enter opens the input", async () => {
    await render(view({ onCreateGroupTask: ok, rowCheckboxes: false }));
    const focusOrder = ["Alpha", "Add task in Alpha", "Bravo", "Add task in Bravo", "Charlie", "Add task in Charlie"];
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

  it("Enter with a title calls onCreateGroupTask with the group id and the trimmed title, then closes and restores focus", async () => {
    const create = vi.fn<Create>(ok);
    await render(view({ onCreateGroupTask: create }));
    await click(createButton("Bravo")!);
    await setValue(input(), "  Cull selects  ");
    await key(input(), "Enter");
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ parentId: "b", index: 0, title: "Cull selects" });
    expect(host.querySelector('[data-testid="gantt-group-create-task-input"]')).toBeNull();
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
    // visible in the row itself (the input is empty by definition, so the message is its placeholder)
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
    // a polite live region inside the create row, described by the input — never an overlay
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.closest('[data-testid="gantt-group-create-task-row"]')).not.toBeNull();
    expect(input().getAttribute("aria-describedby")).toBe(region.id);
    expect(region.className).not.toMatch(/\babsolute\b/);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("Esc cancels without a call, discards the draft, and returns focus to the row", async () => {
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
    // typing clears the message
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

  it("keeps a typed draft and the input when a child is added above the row", async () => {
    await render(view({ onCreateGroupTask: ok }));
    await click(createButton("Alpha")!);
    await setValue(input(), "Half typed");
    const grown = RESOURCES.map((r) => (r.id === "a" ? { ...r, children: [...r.children!, { id: "a3", title: "A three" }] } : r));
    await render(view({ onCreateGroupTask: ok }, grown));
    expect(treeOrder().slice(0, 5)).toEqual(["Alpha", "A one", "A two", "A three", "+a"]);
    expect(input().value).toBe("Half typed");
    expect(document.activeElement).toBe(input());
  });

  it("maxLength comes from createTaskMaxLength", async () => {
    await render(view({ onCreateGroupTask: ok, createTaskMaxLength: 500 }));
    await click(createButton("Alpha")!);
    expect(input().maxLength).toBe(500);
  });
});
