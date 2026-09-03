import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabStrip, type TabItem } from "./tabs";

let root: Root | null = null;
let host: HTMLElement;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function render(value: ReactNode) {
  await act(async () => { root!.render(value); await Promise.resolve(); });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null;
  host.remove();
});

const ITEMS: TabItem[] = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
  { value: "c", label: "C" },
];

async function renderStrip(value: string, onValueChange: (next: string) => void) {
  await render(
    <TabStrip items={ITEMS} value={value} onValueChange={onValueChange} idPrefix="test" label="Test tabs" />,
  );
  return host.querySelector('[role="tablist"]') as HTMLElement;
}

function dispatchKey(target: Element, key: string) {
  act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
}

describe("TabStrip", () => {
  it("renders a tablist whose immediate children are the tab buttons", async () => {
    const tablist = await renderStrip("a", () => undefined);
    expect(tablist.getAttribute("aria-label")).toBe("Test tabs");
    expect(tablist.querySelectorAll(":scope > [role=tab]")).toHaveLength(3);
  });

  it("marks exactly one tab selected", async () => {
    const tablist = await renderStrip("b", () => undefined);
    const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
  });

  it("gives aria-controls only to the selected tab", async () => {
    const tablist = await renderStrip("b", () => undefined);
    const withControls = tablist.querySelectorAll('[role="tab"][aria-controls]');
    expect(withControls).toHaveLength(1);
    expect(withControls[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("gives a roving tabindex, with the selected tab at 0 and the rest at -1", async () => {
    const tablist = await renderStrip("b", () => undefined);
    const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });

  it("moves selection and focus with ArrowRight, and wraps ArrowLeft from the first item to the last", async () => {
    const onValueChange = vi.fn();
    const tablist = await renderStrip("a", onValueChange);
    const tabB = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')][1]!;

    dispatchKey(tablist, "ArrowRight");
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith("b");
    expect(document.activeElement).toBe(tabB);

    onValueChange.mockClear();
    const wrapTablist = await renderStrip("a", onValueChange);
    const tabC = [...wrapTablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')][2]!;
    dispatchKey(wrapTablist, "ArrowLeft");
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith("c");
    expect(document.activeElement).toBe(tabC);
  });

  it("jumps to the first item on Home and the last on End", async () => {
    const onValueChange = vi.fn();
    const tablist = await renderStrip("b", onValueChange);
    const tabA = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')][0]!;

    dispatchKey(tablist, "Home");
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith("a");
    expect(document.activeElement).toBe(tabA);

    onValueChange.mockClear();
    const endTablist = await renderStrip("b", onValueChange);
    const tabC = [...endTablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')][2]!;
    dispatchKey(endTablist, "End");
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith("c");
    expect(document.activeElement).toBe(tabC);
  });

  it("gives every tab button an explicit type=button", async () => {
    const tablist = await renderStrip("a", () => undefined);
    const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.every((tab) => tab.getAttribute("type") === "button")).toBe(true);
  });
});
