import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyProductionCalendarEventMirrorA11y, PRODUCTION_CALENDAR_PLUGINS, ProductionCalendarSurface } from "./ProductionCalendarSurface";
import { SUPPRESS_FULLCALENDAR_DROP_ANNOUNCEMENT } from "../lib/production-calendar-interaction";
import "../styles/production-calendar.css";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("ProductionCalendarSurface", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("mounts the Standard wrapper with the scoped stylesheet and four plugins", async () => {
    await act(async () => {
      root.render(
        <ProductionCalendarSurface
          initialDate="2026-04-05"
          initialView="dayGridMonth"
          headerToolbar={false}
          height={420}
          events={[{ id: "fold", title: "Fold", start: "2026-04-04T16:30:00Z" }]}
        />,
      );
      await Promise.resolve();
    });

    expect(PRODUCTION_CALENDAR_PLUGINS).toHaveLength(4);
    expect(host.querySelector(".production-calendar")).not.toBeNull();
    expect(host.querySelector('[role="grid"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="April 2026"]')).not.toBeNull();
  });

  it("marks a FullCalendar mirror inert without changing a normal event", () => {
    const mirror = document.createElement("div");
    const button = document.createElement("button");
    mirror.append(button);
    applyProductionCalendarEventMirrorA11y({ el: mirror, isMirror: true });
    expect(mirror.getAttribute("aria-hidden")).toBe("true");
    expect(mirror.hasAttribute("inert")).toBe(true);
    expect(mirror.tabIndex).toBe(-1);
    expect(button.tabIndex).toBe(-1);

    const normal = document.createElement("div");
    applyProductionCalendarEventMirrorA11y({ el: normal, isMirror: false });
    expect(normal.getAttribute("aria-hidden")).toBeNull();
  });

  it("reflects reduced motion on the wrapper and leaves drop-announcement suppression off", async () => {
    await act(async () => {
      root.render(<ProductionCalendarSurface initialDate="2026-04-05" initialView="dayGridMonth" headerToolbar={false} height={420} reducedMotion events={[]} />);
      await Promise.resolve();
    });
    expect(host.querySelector<HTMLElement>(".production-calendar")?.dataset.reducedMotion).toBe("true");
    expect(SUPPRESS_FULLCALENDAR_DROP_ANNOUNCEMENT).toBe(false);
  });
});
