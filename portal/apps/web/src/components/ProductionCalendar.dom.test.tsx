import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProductionCalendar, PRODUCTION_CALENDAR_PLUGINS } from "./ProductionCalendar";
import "../styles/production-calendar.css";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("ProductionCalendar", () => {
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
        <ProductionCalendar
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
});
