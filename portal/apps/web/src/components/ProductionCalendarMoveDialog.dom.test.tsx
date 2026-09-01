import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDeadlineCalendarEventDto } from "@quincy/shared";
import { ProductionCalendarMoveDialog } from "./ProductionCalendarMoveDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const event: ProjectDeadlineCalendarEventDto = {
  id: "project-deadline:11111111-1111-4111-8111-111111111111", kind: "project_deadline", title: "Deadline",
  project: { id: "11111111-1111-4111-8111-111111111111", street: "12 Harbour Street", stageKey: "editing_autohdr", checklist: { completed: 1, total: 2 }, delivered: false },
  timing: { allDay: false, start: "2026-08-10T23:30:00.000Z", end: null }, status: { overdue: false, delivered: false, completed: false, sameAssigneeOverlap: false },
  permissions: { canDrag: true, canResize: false }, deadlineLocalCivil: "2026-08-11T09:30", deadlineVersion: 7, reminderOffsetsMinutes: [1440, 60],
};

describe("ProductionCalendarMoveDialog", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); });

  async function render(props: Partial<React.ComponentProps<typeof ProductionCalendarMoveDialog>> = {}) {
    await act(async () => { root.render(<ProductionCalendarMoveDialog open event={event} onSubmit={vi.fn()} onCancel={vi.fn()} {...props} />); await Promise.resolve(); });
  }

  it("seeds inputs from Sydney civil components", async () => {
    await render();
    expect(document.querySelector<HTMLInputElement>('[aria-label="Deadline date"]')?.value).toBe("2026-08-11");
    expect(document.querySelector<HTMLInputElement>('[aria-label="Deadline time"]')?.value).toBe("09:30");
  });

  it("disables submit for a malformed civil value", async () => {
    await render({ initialCivil: "not-a-civil" });
    expect(document.querySelector<HTMLButtonElement>('[data-testid="calendar-move-submit"]')?.disabled).toBe(true);
  });

  it("requires a fold choice and passes civil value plus disambiguation", async () => {
    const onSubmit = vi.fn();
    await render({ foldChoices: [{ disambiguation: "earlier", utcOffsetMinutes: 660 }, { disambiguation: "later", utcOffsetMinutes: 600 }], onSubmit });
    expect(document.body.textContent).toContain("Earlier");
    expect(document.body.textContent).toContain("Later");
    expect(document.querySelector<HTMLButtonElement>('[data-testid="calendar-move-submit"]')?.disabled).toBe(true);
    const later = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((input) => input.value === "later")!;
    await act(async () => { later.click(); });
    await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="calendar-move-submit"]')!.click(); });
    expect(onSubmit).toHaveBeenCalledWith("2026-08-11T09:30", "later");
  });

  it("cancels through the modal action", async () => {
    const onCancel = vi.fn();
    await render({ onCancel });
    document.querySelector<HTMLButtonElement>('[data-testid="calendar-move-cancel"]')!.click();
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
