/**
 * #221 PR C — the Gantt's Deadline confirmation (`ProductionGanttDeadlineDialog`), in isolation.
 * Guard F (`test-seam.guard.test.ts`): no vendor `data-slot` selectors — every hook is a
 * `data-testid` this component authors itself.
 */
if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => [];
}
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeadlineEffectsPreview } from "../lib/production-gantt-scheduling";
import { ProductionGanttDeadlineDialog, type ProductionGanttDeadlineConfirmState } from "./ProductionGanttDeadlineDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const basePreview: DeadlineEffectsPreview = { affected: [], clashes: [], loaded: 3, total: 3, truncated: false };

function state(overrides: Partial<ProductionGanttDeadlineConfirmState> = {}): ProductionGanttDeadlineConfirmState {
  return {
    street: "1 Writes Street",
    oldCivil: "2026-08-16T15:00",
    newCivil: "2026-08-12T15:00",
    scheduling: false,
    consequences: [],
    preview: basePreview,
    ...overrides,
  };
}

async function render(props: { open?: boolean; state: ProductionGanttDeadlineConfirmState; onResolve: (ok: boolean) => void }) {
  await act(async () => {
    root.render(<ProductionGanttDeadlineDialog open={props.open ?? true} state={props.state} onResolve={props.onResolve} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  host.remove();
  document.body.replaceChildren();
});

describe("ProductionGanttDeadlineDialog", () => {
  it("renders the title, the from → to block, the affected list and the clashes", async () => {
    await render({
      state: state({
        preview: {
          ...basePreview,
          affected: [
            { id: "a", title: "Edit hero set", before: "on-time", after: "after" },
            { id: "b", title: "Send preview", before: "after", after: "on-time" },
          ],
          clashes: [
            { kind: "subtask-after-deadline", id: "a", title: "Edit hero set" },
            { kind: "deadline-before-start", boundKind: "shoot" },
          ],
        },
      }),
      onResolve: vi.fn(),
    });
    const dialog = byTestId("gantt-deadline-confirm");
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Move Deadline");
    const description = document.body.querySelector('[data-testid="gantt-deadline-confirm-description"]');
    expect(description!.textContent).toBe("1 Writes Street");
    expect(dialog!.getAttribute("aria-describedby")).toBe(description!.id);
    expect(byTestId("calendar-move-confirmation")!.textContent).toContain("2026-08-16 15:00");
    expect(byTestId("calendar-move-confirmation")!.textContent).toContain("2026-08-12 15:00");

    const items = [...document.body.querySelectorAll('[data-testid="gantt-deadline-confirm-affected"] [role="listitem"]')].map((item) => item.textContent);
    expect(items).toEqual(["Edit hero setnow after the deadline", "Send previewno longer after the deadline"]);

    const clashes = byTestId("gantt-deadline-confirm-clashes")!.textContent;
    expect(clashes).toContain("Deadline before the shoot date.");
    expect(clashes).toContain("1 checklist item would end after the deadline.");
    expect(byTestId("gantt-deadline-confirm-truncated")).toBeNull();
    expect(byTestId("gantt-deadline-confirm-action")!.textContent).toBe("Move Deadline");
  });

  it("omits the affected and clash sections when there is nothing to list, and says Schedule when scheduling", async () => {
    await render({ state: state({ scheduling: true, oldCivil: "Not scheduled" }), onResolve: vi.fn() });
    expect(byTestId("gantt-deadline-confirm-affected")).toBeNull();
    expect(byTestId("gantt-deadline-confirm-clashes")).toBeNull();
    expect(byTestId("gantt-deadline-confirm")!.textContent).toContain("Schedule Deadline");
    expect(document.body.querySelector('[data-testid="gantt-deadline-confirm-description"]')!.textContent).toBe("1 Writes Street");
    expect(byTestId("gantt-deadline-confirm-action")!.textContent).toBe("Schedule Deadline");
  });

  it("says the preview is partial when the checklist is truncated", async () => {
    await render({ state: state({ preview: { ...basePreview, loaded: 4, total: 9, truncated: true } }), onResolve: vi.fn() });
    expect(byTestId("gantt-deadline-confirm-truncated")!.textContent).toBe("Based on 4 of 9 checklist items loaded.");
  });

  it("focuses Cancel by default", async () => {
    await render({ state: state(), onResolve: vi.fn() });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(document.activeElement).toBe(byTestId("gantt-deadline-confirm-cancel"));
  });

  it("Cancel resolves false", async () => {
    const onResolve = vi.fn();
    await render({ state: state(), onResolve });
    await click(byTestId("gantt-deadline-confirm-cancel")!);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(false);
  });

  it("Escape resolves false", async () => {
    const onResolve = vi.fn();
    await render({ state: state(), onResolve });
    await act(async () => {
      byTestId("gantt-deadline-confirm")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(onResolve).toHaveBeenCalledWith(false);
  });

  it("the action resolves true", async () => {
    const onResolve = vi.fn();
    await render({ state: state(), onResolve });
    await click(byTestId("gantt-deadline-confirm-action")!);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(true);
  });
});
