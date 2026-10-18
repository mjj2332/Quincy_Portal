/**
 * #916 / #919 — `renderEventTrailing` (additive view config): content drawn beside a bar, outside the
 * bar's own clipped box. The Dashboard Timeline's late chip sits there (frame 3a `.chipbad`): after
 * the bar, and after the bar's outside title when the bar is too narrow to hold it. Unset, or
 * returning nothing for a bar, the bar and its outside title render exactly as before.
 *
 * Reached through `data-testid`s (test-seam guard F). `getAnimations` polyfill: see
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

const DATE = new Date("2026-03-02T00:00:00.000Z");
const RESOURCES = [
  { id: "r1", title: "Row 1" },
  { id: "r2", title: "Row 2" },
];
const EVENTS: GanttEvent[] = [
  { id: "late", title: "Late bar", start: new Date("2026-03-02T09:00:00.000Z"), end: new Date("2026-03-02T15:00:00.000Z"), resourceId: "r1" },
  { id: "fine", title: "Fine bar", start: new Date("2026-03-02T09:00:00.000Z"), end: new Date("2026-03-02T15:00:00.000Z"), resourceId: "r2" },
];

const chipFor = ({ occurrence }: { occurrence: { event: GanttEvent } }) =>
  occurrence.event.id === "late" ? <span data-testid="probe-chip">2 days late</span> : null;

async function renderGantt(props: { barLabel?: "inside" | "outside"; trailing?: boolean }) {
  await render(
    <Gantt
      resources={RESOURCES}
      events={EVENTS}
      date={DATE}
      scale="day"
      timeZone="UTC"
      barLabel={props.barLabel ?? "inside"}
      renderEventTrailing={props.trailing === false ? undefined : chipFor}
    >
      <GanttView />
    </Gantt>,
  );
}

/** The bar content seam of the row's bar, and the segment wrapper that holds it. */
function segmentOf(row: string): HTMLElement {
  const content = host.querySelector<HTMLElement>(`[data-gantt-resource="${row}"] [data-testid="gantt-bar-content"]`);
  expect(content, `bar content for ${row}`).not.toBeNull();
  const segment = content!.closest<HTMLElement>("[data-lane]");
  expect(segment).not.toBeNull();
  return segment!;
}

describe("gantt renderEventTrailing (#919)", () => {
  it("draws the trailing content beside the bar, outside the bar's own box", async () => {
    await renderGantt({ barLabel: "inside" });
    const segment = segmentOf("r1");
    const chip = segment.querySelector<HTMLElement>('[data-testid="probe-chip"]');
    expect(chip?.textContent).toBe("2 days late");
    const bar = segment.querySelector<HTMLElement>('[data-testid="gantt-bar-content"]')!.closest("button, [role]");
    expect(bar?.contains(chip!)).toBe(false);
    expect(chip!.closest('[data-testid="gantt-bar-trailing"]')).not.toBeNull();
  });

  it("follows the bar's outside title: the title first, then the trailing content, in one line", async () => {
    await renderGantt({ barLabel: "outside" });
    const segment = segmentOf("r1");
    const label = segment.querySelector<HTMLElement>('[data-testid="gantt-bar-label"]');
    const trailing = segment.querySelector<HTMLElement>('[data-testid="gantt-bar-trailing"]');
    expect(label?.textContent).toBe("Late bar");
    expect(trailing).not.toBeNull();
    expect(label!.parentElement).toBe(trailing!.parentElement);
    expect(label!.compareDocumentPosition(trailing!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a bar the callback returns nothing for, and a Gantt without the callback, draw no trailing slot", async () => {
    await renderGantt({ barLabel: "outside" });
    expect(segmentOf("r2").querySelector('[data-testid="gantt-bar-trailing"]')).toBeNull();
    await renderGantt({ barLabel: "outside", trailing: false });
    expect(host.querySelector('[data-testid="gantt-bar-trailing"]')).toBeNull();
    expect(host.querySelector('[data-testid="probe-chip"]')).toBeNull();
    // The outside title keeps its own placement when nothing trails it.
    expect(segmentOf("r1").querySelector('[data-testid="gantt-bar-label"]')?.getAttribute("data-placement")).toBe("after");
  });
});
