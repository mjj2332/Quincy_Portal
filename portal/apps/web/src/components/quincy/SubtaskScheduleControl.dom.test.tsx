/**
 * #372 — the Checklist's range picker, extracted to `quincy/SubtaskScheduleControl.tsx`, gains three opt-in
 * presentation props for the Gantt's Subtask Due cell (a caller-supplied trigger, initial focus on End, focus
 * returned to the trigger) and a caller-supplied validation message. Every default reproduces the Checklist.
 */
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKLIST_SCHEDULE_ZONE, type ChecklistScheduleDto } from "@quincy/shared";
import { SubtaskScheduleControl, type RangeScheduleRequest, type ScheduleError } from "./SubtaskScheduleControl";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];

const endpoint = (civil: string) => ({ kind: "date" as const, localCivil: civil, instant: null, utcOffsetMinutes: null, fold: null, resolution: "stored" as const });
const value: ChecklistScheduleDto = { state: "range", version: 3, zone: CHECKLIST_SCHEDULE_ZONE, start: endpoint("2026-10-08"), end: endpoint("2026-10-10"), due: "2026-10-10" };

let host: HTMLDivElement;
let root: Root;
let saved: RangeScheduleRequest[];

type Extra = Partial<Parameters<typeof SubtaskScheduleControl>[0]>;
function Harness({ extra = {} }: { extra?: Extra }) {
  const [open, setOpen] = useState(false);
  return (
    <SubtaskScheduleControl owner="t" label="Schedule for Row" value={value} open={open} setOpen={setOpen} busy={false} onSave={(request) => saved.push(request)} {...extra} />
  );
}

async function mount(extra: Extra = {}, wrap: (node: ReactNode) => ReactNode = (node) => node) {
  await act(async () => { root.render(wrap(<Harness extra={extra} />)); await Promise.resolve(); });
}
const popover = () => document.querySelector<HTMLElement>('[role="group"][aria-label="Schedule for Row"]');
const endDate = () => [...(popover()?.querySelectorAll("fieldset") ?? [])].find((set) => set.querySelector("legend")?.textContent === "End")?.querySelector<HTMLInputElement>('input[type="date"]') ?? null;
const button = (name: string) => [...(popover()?.querySelectorAll("button") ?? [])].find((el) => el.textContent === name) as HTMLButtonElement;
async function click(el: HTMLElement) { await act(async () => { el.click(); await Promise.resolve(); }); }
async function settle(rounds = 4) { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); }

beforeEach(() => {
  saved = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); await Promise.resolve(); });
  host.remove();
  document.body.replaceChildren();
});

const customTrigger: NonNullable<Extra["trigger"]> = ({ ref, ...props }) => <button ref={ref} type="button" data-testid="custom-trigger" aria-label="Due for Row" {...props}>Sat 10 Oct</button>;

describe("SubtaskScheduleControl (#372)", () => {
  it("S1 a caller-supplied trigger replaces the built-in one, is wired to the popover and opens it", async () => {
    await mount({ trigger: customTrigger });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="custom-trigger"]');
    expect(trigger).not.toBeNull();
    expect(host.querySelector('[aria-label="Schedule for Row"]')).toBeNull();
    expect(trigger!.getAttribute("aria-expanded")).toBe("false");
    await click(trigger!);
    await settle();
    expect(trigger!.getAttribute("aria-expanded")).toBe("true");
    expect(popover()).not.toBeNull();
    expect(trigger!.getAttribute("aria-controls")).toBe(popover()!.id);
  });

  it("S1b with no trigger prop the built-in Checklist trigger is unchanged", async () => {
    await mount();
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Schedule for Row"]');
    expect(trigger).not.toBeNull();
    expect(trigger!.textContent).toContain("10 Oct 2026");
  });

  it("S2 initialFocus='end' focuses the End date input; the default focuses the first field", async () => {
    await mount({ trigger: customTrigger, initialFocus: "end" });
    await click(host.querySelector<HTMLButtonElement>('[data-testid="custom-trigger"]')!);
    await settle();
    expect(endDate()).not.toBeNull();
    expect(document.activeElement).toBe(endDate());
  });

  it("S2b without initialFocus the picker does not land on the End field", async () => {
    await mount({ trigger: customTrigger });
    await click(host.querySelector<HTMLButtonElement>('[data-testid="custom-trigger"]')!);
    await settle();
    // (happy-dom lays nothing out, so floating-ui's index-based initial focus cannot pick a control here; the
    // claim is only that the End field is not the default landing.)
    expect(document.activeElement).not.toBe(endDate());
  });

  it("S5 returnFocusOnClose returns focus to the trigger on Save and on Cancel", async () => {
    await mount({ trigger: customTrigger, returnFocusOnClose: true });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="custom-trigger"]')!;
    await click(trigger);
    await settle();
    await click(button("Cancel"));
    await settle(12);
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await click(trigger);
    await settle();
    await click(button("Save"));
    await settle();
    expect(saved).toHaveLength(1);
    expect(document.activeElement).toBe(trigger);
  });

  it("S7 a caller-supplied message is shown in the critical notice instead of the generic sentence", async () => {
    const error: ScheduleError = { message: "The End must not be before the Start." };
    await mount({ trigger: customTrigger, error });
    await click(host.querySelector<HTMLButtonElement>('[data-testid="custom-trigger"]')!);
    await settle();
    const alert = popover()!.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("The End must not be before the Start.");
    expect(popover()!.textContent).not.toContain("Review the highlighted fields");
  });

  it("S7b an error with no message keeps the Checklist's generic sentence", async () => {
    await mount({ error: {} });
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Schedule for Row"]')!);
    await settle();
    expect(popover()!.querySelector('[role="alert"]')?.textContent).toBe("The schedule could not be saved. Review the highlighted fields.");
  });

  it("S8 a caller-supplied latest-item summary renders and hands the same value back on Use latest item", async () => {
    const onUseLatestItem = vi.fn();
    const summary = { title: "Row", done: true, assignees: [{ name: "Ada Smith" }], otherAssigneeCount: 2, schedule: value };
    await mount({ trigger: customTrigger, error: { currentSubtask: summary }, onUseLatestItem });
    await click(host.querySelector<HTMLButtonElement>('[data-testid="custom-trigger"]')!);
    await settle();
    expect(popover()!.textContent).toContain("Ada Smith and 2 others");
    await click(button("Use latest item (discard draft)"));
    expect(onUseLatestItem).toHaveBeenCalledWith(summary);
  });
});
