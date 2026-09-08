import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act, type ReactNode } from "react";

import { ICON_BUTTON, ICON_BUTTON_BASE, IconButton, META_TRIGGER } from "./icon-button";

let host: HTMLElement | null = null;
let root: Root | null = null;

async function render(node: ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  return host;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe("IconButton", () => {
  it("defaults to type=button so a grip inside a form never submits it", async () => {
    const element = await render(<IconButton aria-label="Reorder" />);
    expect(element.querySelector("button")?.getAttribute("type")).toBe("button");
  });

  it("forwards aria-disabled without setting the disabled property", async () => {
    // The drag grip is disabled via `aria-disabled`, not the real attribute: dnd-kit keeps the
    // activator focusable. Both paths must reach the element, which is why ICON_BUTTON_BASE
    // carries `disabled:` and `aria-disabled:` variants rather than only one.
    const element = await render(<IconButton aria-label="Reorder" aria-disabled />);
    const button = element.querySelector("button")!;
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(false);
  });

  it("forwards a callback ref to the real button element", async () => {
    // Load-bearing, and not obvious: `IconButton` is a plain function component with no
    // `forwardRef`. That works only because this app is on React 19 (ref-as-prop). The subtask
    // drag grip passes `setActivatorNodeRef` through this path — under React 18 semantics the
    // ref would be dropped silently and dragging a subtask would stop working with no error.
    let captured: HTMLButtonElement | null = null;
    await render(<IconButton ref={(node) => { captured = node; }} aria-label="Reorder" />);
    expect(captured).not.toBeNull();
    expect(captured!.tagName).toBe("BUTTON");
  });

  it("keeps the disabled state on colour-plus-background, never an opacity multiplier", async () => {
    // TB8-07 §2.1: an opacity multiplier stacked on an already-quiet colour is what took the
    // Kanban board's disabled drag handle to 1.72:1 and this surface's to 2.51:1. The recessed
    // `--bg-sunken` chip carries it instead, at 7.40:1. Guard the regression at the class level.
    expect(ICON_BUTTON_BASE).toContain("disabled:bg-surface-sunken");
    expect(ICON_BUTTON_BASE).toContain("aria-disabled:bg-surface-sunken");
    expect(ICON_BUTTON_BASE).not.toMatch(/\bopacity-/);
    expect(ICON_BUTTON).not.toMatch(/\bopacity-/);
    expect(META_TRIGGER).not.toMatch(/\bopacity-/);
  });

  it("keeps ICON_BUTTON square and lets META_TRIGGER grow", async () => {
    // The split that stops a schedule chip from overflowing a 390px row (§4.1). `META_TRIGGER`
    // must also override the base's `shrink-0`, or `max-w-full` is not a no-overflow guarantee.
    expect(ICON_BUTTON).toContain("w-[28px]");
    expect(META_TRIGGER).toContain("w-auto");
    expect(META_TRIGGER).toContain("shrink ");
    expect(META_TRIGGER).toContain("overflow-hidden");
  });
});
