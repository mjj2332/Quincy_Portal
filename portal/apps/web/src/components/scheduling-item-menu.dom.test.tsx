import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSchedulingItemMenu, type SchedulingMenuContent } from "./scheduling-item-menu";
import type { SchedulingItemActionId } from "../lib/scheduling-item-actions";

/**
 * #463 — the shared menu host both the Calendar and the Timeline wire their items to, driven against a
 * plain host (two ordinary buttons standing in for a vendor chip and bar). The surface suites then pin
 * what each surface adds on top. Queries go by role and accessible name only (guard F).
 */
let root: Root | null = null;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

const CONTENT: SchedulingMenuContent = {
  label: "Deadline · 12 Smith St",
  caution: "Overlaps another task",
  actions: [
    { id: "open-project", label: "Open project", disabled: false },
    { id: "reschedule", label: "Reschedule…", disabled: false },
  ],
};

type HostProps = {
  keys?: string[];
  describe?: (key: string) => SchedulingMenuContent | null;
  onAction?: (id: SchedulingItemActionId, key: string) => void;
  followOnOpen?: boolean;
  closeKey?: string;
};

let latest: { isOpenFor: (key: string) => boolean } | null = null;
const actionLog: Array<{ id: string; key: string; focusedChip: boolean }> = [];

function Host({ keys = ["a"], describe = () => CONTENT, onAction, followOnOpen, closeKey }: HostProps) {
  const menu = useSchedulingItemMenu({
    describe,
    resolveElement: (key) => document.getElementById(`chip-${key}`),
    onAction: (id, key) => {
      actionLog.push({ id, key, focusedChip: document.activeElement === document.getElementById(`chip-${key}`) });
      onAction?.(id, key);
    },
    followOnOpen,
    closeKey,
  });
  latest = menu;
  return (
    <div {...menu.wrapperProps}>
      {keys.map((key) => (
        <button
          key={key}
          id={`chip-${key}`}
          type="button"
          aria-haspopup="menu"
          aria-expanded={menu.isOpenFor(key)}
          onClick={(event) => menu.openFromClick(event, key)}
          onContextMenu={(event) => menu.openFromContextMenu(event, key)}
        >
          Chip {key}
        </button>
      ))}
      <button type="button">Elsewhere</button>
      {menu.menu}
    </div>
  );
}

function Wrapper(props: HostProps & { children?: ReactNode }) {
  const [, setTick] = useState(0);
  void setTick;
  return <Host {...props} />;
}

async function mount(props: HostProps = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await render(props);
}
async function render(props: HostProps) {
  await act(async () => { root!.render(<Wrapper {...props} />); await Promise.resolve(); await Promise.resolve(); });
}
async function flush(ms = 30) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); await Promise.resolve(); });
}

const chip = (key = "a") => document.getElementById(`chip-${key}`) as HTMLButtonElement;
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const item = (label: string) => items().find((node) => node.textContent === label) ?? null;

/** A keyboard-style click: focused chip, `detail` 0. */
async function keyboardOpen(key = "a") {
  await act(async () => { chip(key).focus(); await Promise.resolve(); });
  await act(async () => { chip(key).click(); await Promise.resolve(); await Promise.resolve(); });
  await flush();
}
async function pointerDown(target: HTMLElement, init: { x: number; y: number; type?: string }) {
  await act(async () => { target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: init.x, clientY: init.y, pointerType: init.type ?? "mouse" })); await Promise.resolve(); });
}
async function pointerClick(target: HTMLElement, x: number, y: number) {
  await act(async () => { target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: x, clientY: y })); await Promise.resolve(); await Promise.resolve(); });
  await flush();
}
async function contextmenu(target: HTMLElement): Promise<MouseEvent> {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 });
  await act(async () => { target.dispatchEvent(event); await Promise.resolve(); await Promise.resolve(); });
  await flush();
  return event;
}
async function escape() {
  await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
  await flush(60);
}

beforeEach(() => { actionLog.length = 0; latest = null; });
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  document.body.replaceChildren();
});

describe("the scheduling item menu host (#463)", () => {
  it("opens labelled, with the caution line and the items, and focuses the first row on a keyboard open", async () => {
    await mount();
    await keyboardOpen();
    expect(menu()).not.toBeNull();
    expect(menu()!.textContent).toContain("Deadline · 12 Smith St");
    expect(menu()!.textContent).toContain("Overlaps another task");
    expect(items().map((node) => node.textContent)).toEqual(["Open project", "Reschedule…"]);
    expect(document.activeElement).toBe(item("Open project"));
    expect(chip().getAttribute("aria-expanded")).toBe("true");
  });

  it("opens from a pointer click and from a right-click, and a right-click's native menu is prevented", async () => {
    await mount();
    await pointerDown(chip(), { x: 4, y: 4 });
    await pointerClick(chip(), 4, 4);
    expect(menu()).not.toBeNull();
    await escape();
    expect(menu()).toBeNull();

    const event = await contextmenu(chip());
    expect(event.defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
  });

  it("suppresses a touch-origin contextmenu without opening anything (long-press is the drag)", async () => {
    await mount();
    await pointerDown(chip(), { x: 4, y: 4, type: "touch" });
    const event = await contextmenu(chip());
    expect(event.defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
  });

  it("ignores a click whose pointer travelled 4px or more, and opens for a smaller wiggle", async () => {
    await mount();
    await pointerDown(chip(), { x: 10, y: 10 });
    await pointerClick(chip(), 20, 10);
    expect(menu()).toBeNull();
    await pointerDown(chip(), { x: 10, y: 10 });
    await pointerClick(chip(), 12, 11);
    expect(menu()).not.toBeNull();
  });

  it("Escape returns focus to the item, even when a click never focused it (Safari)", async () => {
    await mount();
    await pointerDown(chip(), { x: 4, y: 4 });
    await pointerClick(chip(), 4, 4);
    expect(document.activeElement).not.toBe(chip());
    await escape();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(chip());
    expect(actionLog).toEqual([]);
  });

  it("hands off: the item holds focus when the action runs, and the menu does not refocus it afterwards", async () => {
    await mount();
    await keyboardOpen();
    await act(async () => { item("Reschedule…")!.click(); await Promise.resolve(); await Promise.resolve(); });
    await flush(60);
    expect(menu()).toBeNull();
    expect(actionLog).toEqual([{ id: "reschedule", key: "a", focusedChip: true }]);
    // The action opens a dialog that takes focus; the menu's own focus return must not steal it back.
    await act(async () => { document.querySelectorAll("button")[1]!.focus(); await Promise.resolve(); });
    await flush(60);
    expect(document.activeElement).toBe(document.querySelectorAll("button")[1]);
  });

  it("restores focus to the re-resolved item when a follow-on dialog closed and focus was lost", async () => {
    await mount({ followOnOpen: false });
    await keyboardOpen();
    await act(async () => { item("Reschedule…")!.click(); await Promise.resolve(); });
    await flush(80);
    expect(actionLog).toHaveLength(1);
    await render({ followOnOpen: true });
    await act(async () => { (document.activeElement as HTMLElement | null)?.blur(); await Promise.resolve(); });
    await render({ followOnOpen: false });
    await flush(700);
    expect(document.activeElement).toBe(chip());
  });

  it("does not take focus back from a control that legitimately has it after the dialog closed", async () => {
    await mount({ followOnOpen: false });
    await keyboardOpen();
    await act(async () => { item("Reschedule…")!.click(); await Promise.resolve(); });
    await flush(80);
    await render({ followOnOpen: true });
    const elsewhere = [...document.querySelectorAll("button")].find((node) => node.textContent === "Elsewhere")!;
    await act(async () => { elsewhere.focus(); await Promise.resolve(); });
    await render({ followOnOpen: false });
    await flush(700);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("closes without running anything when its item leaves the data", async () => {
    await mount({ keys: ["a", "b"] });
    await keyboardOpen("a");
    expect(menu()).not.toBeNull();
    await render({ keys: ["b"] });
    await flush(60);
    expect(menu()).toBeNull();
    expect(actionLog).toEqual([]);
  });

  it("closes when describe stops knowing the item, and when the close key changes", async () => {
    await mount({ closeKey: "one" });
    await keyboardOpen();
    await render({ closeKey: "two" });
    await flush(60);
    expect(menu()).toBeNull();
    await keyboardOpen();
    await render({ closeKey: "two", describe: () => null });
    await flush(60);
    expect(menu()).toBeNull();
    expect(actionLog).toEqual([]);
  });

  it("never runs a disabled row", async () => {
    await mount({ describe: () => ({ ...CONTENT, actions: CONTENT.actions.map((action) => ({ ...action, disabled: true })) }) });
    await keyboardOpen();
    await act(async () => { item("Open project")!.click(); await Promise.resolve(); await Promise.resolve(); });
    await flush(60);
    expect(actionLog).toEqual([]);
  });

  it("sizes the rows to 44px at a phone or coarse pointer through its classes only, and the menu to the Board's surface width", async () => {
    await mount();
    await keyboardOpen();
    // Class strings are not selectors (guard F): assert the contract through the className value.
    expect(item("Open project")!.className).toContain("min-h-11");
    expect(menu()!.className).toContain("w-48");
  });
});
