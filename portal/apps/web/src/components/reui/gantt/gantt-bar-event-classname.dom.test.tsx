/**
 * 2026-09-28, #257 — `GanttEvent.className` (additive): a per-event class that `gantt-bar.tsx`
 * puts on the bar shell, in the same `cn()` as the shell's own classes, before
 * `viewConfig.classNames?.event`. Production uses it for Edited review's hatch.
 *
 * The shell is reached from the bar's own content seam (`data-testid="gantt-bar-content"`), never
 * a vendor `data-slot` (test-seam guard F). `getAnimations` polyfill: see
 * `gantt-adjust-ghost-marker.dom.test.tsx`'s header.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Gantt } from "@/components/reui/gantt/gantt";
import { GanttView } from "@/components/reui/gantt/gantt-view";
import type { GanttEvent } from "@/components/reui/gantt/gantt-types";

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

/**
 * A Tailwind-utility-shaped probe the shell never carries on its own (test-seam guard C counts a
 * Quincy-BEM-shaped class-presence assertion; a utility is a design contract and is not counted).
 */
const PROBE_CLASS = "tracking-[0.123em]";
const DATE = new Date("2026-03-02T00:00:00.000Z");
const RESOURCES = [
  { id: "r1", title: "Row 1" },
  { id: "r2", title: "Row 2" },
];

function event(id: string, resourceId: string, extra: Partial<GanttEvent> = {}): GanttEvent {
  return {
    id,
    title: `Bar ${id}`,
    start: new Date("2026-03-03T00:00:00.000Z"),
    end: new Date("2026-03-10T00:00:00.000Z"),
    allDay: true,
    resourceId,
    ...extra,
  };
}

function shellOf(title: string): HTMLElement {
  const content = [...host.querySelectorAll<HTMLElement>('[data-testid="gantt-bar-content"]')].find((candidate) => candidate.textContent?.includes(title));
  if (!content) throw new Error(`no bar content for "${title}"`);
  const shell = content.closest<HTMLElement>("button");
  if (!shell) throw new Error(`no bar shell around "${title}"`);
  return shell;
}

describe("GanttEvent.className reaches the bar shell (#257, 2026-09-28)", () => {
  it("puts the event's own class on its bar shell, and not on another event's", async () => {
    await render(
      <Gantt
        resources={RESOURCES}
        events={[event("a", "r1", { className: PROBE_CLASS }), event("b", "r2")]}
        date={DATE}
        scale="month"
        timeZone="UTC"
      >
        <GanttView />
      </Gantt>,
    );
    expect(shellOf("Bar a").className.split(/\s+/)).toContain(PROBE_CLASS);
    expect(shellOf("Bar b").className.split(/\s+/)).not.toContain(PROBE_CLASS);
  });
});
