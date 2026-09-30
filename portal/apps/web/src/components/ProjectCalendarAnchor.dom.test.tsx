// Happy-dom proves anchor callback wiring only; it cannot prove real pointer-drag recognition.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ProjectCalendarAnchor } from "./ProjectCalendarAnchor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProjectCalendarAnchor", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onOpenProject: Mock<() => void>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    onOpenProject = vi.fn();
    act(() => root.render(<ProjectCalendarAnchor href="/projects/11111111-1111-4111-8111-111111111111" onOpenProject={onOpenProject}>12 Harbour Street</ProjectCalendarAnchor>));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const anchor = () => host.querySelector<HTMLAnchorElement>('[data-testid="calendar-project-link"]')!;
  const click = (init: MouseEventInit = {}) => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1, ...init });
    anchor().dispatchEvent(event);
    return event;
  };
  const drag = (dx: number) => {
    anchor().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 10 }));
    anchor().dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 10 + dx, clientY: 10 }));
    anchor().dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 10 + dx, clientY: 10 }));
    click();
  };

  it("renders a real anchor with the project href and label", () => {
    expect(anchor().getAttribute("href")).toBe("/projects/11111111-1111-4111-8111-111111111111");
    expect(anchor().textContent).toBe("12 Harbour Street");
  });

  it("opens the project for a plain click and prevents native navigation", () => {
    const event = click();
    expect(onOpenProject).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("opens the project for Enter", () => {
    anchor().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });

  it("ignores a held (repeating) Enter", () => {
    anchor().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true }));
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it("leaves Space native: no activation and no preventDefault", () => {
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    anchor().dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["middle button", { button: 1 }],
  ])("lets a %s click fall through to the browser", (_name, init) => {
    const event = click(init);
    expect(onOpenProject).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("falls through to native navigation when there is no onOpenProject", () => {
    act(() => root.render(<ProjectCalendarAnchor href="/projects/x">Street</ProjectCalendarAnchor>));
    expect(click().defaultPrevented).toBe(false);
  });

  it("suppresses the click that ends a drag of 20px", () => {
    drag(20);
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it("suppresses the click at exactly the 4px threshold, below FullCalendar's 5px drag start", () => {
    drag(4);
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it("still opens for a 2px wobble under the threshold", () => {
    drag(2);
    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });

  it("suppresses only the one click after a drag", () => {
    drag(20);
    click();
    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });

  it("suppresses a touch drag the same way", () => {
    const touch = (type: string, x: number) => anchor().dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { touches: [{ clientX: x, clientY: 10 }] }));
    touch("touchstart", 10);
    touch("touchmove", 30);
    anchor().dispatchEvent(new Event("touchend", { bubbles: true }));
    click();
    expect(onOpenProject).not.toHaveBeenCalled();
  });

  it("takes a testId and className override without changing behaviour (#365)", () => {
    act(() => root.render(<ProjectCalendarAnchor testId="gantt-project-link" className="truncate" href="/projects/x" onOpenProject={onOpenProject}>Row</ProjectCalendarAnchor>));
    const custom = host.querySelector<HTMLAnchorElement>('[data-testid="gantt-project-link"]')!;
    expect(custom).not.toBeNull();
    expect(host.querySelector('[data-testid="calendar-project-link"]')).toBeNull();
    expect(custom.classList.contains("truncate")).toBe(true);
    custom.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });
});
