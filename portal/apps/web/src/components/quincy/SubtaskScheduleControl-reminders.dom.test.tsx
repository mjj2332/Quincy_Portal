/**
 * Seam E (#425): the Subtask range control carries the reminder set. Apply hands the offsets to `onSave` beside the range; a version
 * conflict names the latest reminders, keeps the retained draft's offsets for the reapply, and reapplies at the latest version.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKLIST_SCHEDULE_ZONE, type ChecklistScheduleDto } from "@quincy/shared";
import { SubtaskScheduleControl, type RangeScheduleRequest, type RetainedSchedule, type ScheduleError } from "./SubtaskScheduleControl";
import { startMoment, endMoment, subtaskReminders } from "@/testing/subtask-schedule";
import { applyPopup, dateTimePopup, popupButton, pressInPopup } from "@/testing/date-time-popup";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
const value: ChecklistScheduleDto = { state: "range", version: 3, zone: CHECKLIST_SCHEDULE_ZONE, start: startMoment("2026-10-08"), end: endMoment("2026-10-10"), due: "2026-10-10T17:00" };
const latest: ChecklistScheduleDto = { ...value, version: 4 };

let host: HTMLDivElement;
let root: Root;
let saved: RangeScheduleRequest[];

type Extra = Partial<Parameters<typeof SubtaskScheduleControl>[0]>;
function Harness({ extra = {} }: { extra?: Extra }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Like the real host, a save marks the control busy until the host reports the outcome (an error prop, or busy: false).
  return <SubtaskScheduleControl owner="t" label="Schedule for Row" value={value} reminders={{ offsets: [1440], next: null }} open={open} setOpen={setOpen} busy={extra.error ? false : busy} onSave={(request) => { saved.push(request); setBusy(true); }} {...extra} />;
}
async function mount(extra: Extra = {}) { await act(async () => { root.render(<Harness extra={extra} />); await Promise.resolve(); }); }
const trigger = () => host.querySelector<HTMLButtonElement>('[aria-label="Schedule for Row"]')!;
const popover = () => dateTimePopup("Schedule for Row");
const chip = (name: string) => [...popover()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === name);
async function click(el: HTMLElement) { await act(async () => { el.click(); await Promise.resolve(); }); }
async function settle(rounds = 4) { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); }
async function open() { await click(trigger()); await settle(); }

beforeEach(() => { saved = []; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => { root.unmount(); await Promise.resolve(); }); host.remove(); document.body.replaceChildren(); });

describe("SubtaskScheduleControl reminders (#425)", () => {
  it("R1 a reminders toggle alone is saved at the open version with the unchanged range", async () => {
    await mount();
    await open();
    await click(chip("4 hours")!);
    await applyPopup(popover()!);
    await settle();
    expect(saved).toEqual([{ expectedVersion: 3, schedule: { state: "range", start: { localCivil: "2026-10-08T09:00" }, end: { localCivil: "2026-10-10T17:00" } }, reminderOffsetsMinutes: [1440, 240] }]);
  });

  it("R2 without a reminders prop there is no strip and the request carries no offsets", async () => {
    await mount({ reminders: undefined });
    await open();
    expect(popover()!.textContent).not.toContain("Advance reminders");
    await pressInPopup(popover()!, "Tomorrow");
    await applyPopup(popover()!);
    await settle();
    expect(saved).toHaveLength(1);
    expect(saved[0]).not.toHaveProperty("reminderOffsetsMinutes");
  });

  it("R3 a version conflict names the latest reminders, and the popup's saved set is the latest, not the stale row's", async () => {
    const error: ScheduleError = { current: latest, currentReminders: subtaskReminders([60]) };
    await mount({ error });
    await open();
    expect(popover()!.textContent).toContain("Latest schedule · v4");
    const notice = [...popover()!.querySelectorAll("strong")].find((el) => el.textContent === "Latest schedule · v4")!.parentElement!;
    // Schedule and Reminders are separate term/definition pairs, not one run-together line.
    const pairs = [...notice.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.tagName, dt.nextElementSibling?.textContent]);
    expect(pairs).toEqual([["Schedule", "DD", expect.stringMatching(/\S/)], ["Reminders", "DD", "1 hour, Due now"]]);
    expect(chip("1 hour")!.getAttribute("aria-pressed")).toBe("true");
    expect(chip("1 day")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("R4 Use latest schedule hands back the latest schedule and the latest reminders", async () => {
    const onUseLatest = vi.fn();
    const currentReminders = subtaskReminders([60]);
    await mount({ error: { current: latest, currentReminders }, onUseLatest });
    await open();
    await pressInPopup(popover()!, "Use latest schedule (discard draft)");
    expect(onUseLatest).toHaveBeenCalledWith(latest, currentReminders);
  });

  it("R5 reapplying a failed save sends the retained range AND offsets at the latest version, never silently", async () => {
    const retained: RetainedSchedule = { draft: null, baseVersion: null };
    await mount({ retained });
    await open();
    await click(chip("4 hours")!);
    await applyPopup(popover()!);
    await settle();
    expect(saved).toHaveLength(1);
    // The save lost: the host passes the conflict. Reopening shows the retained draft, offsets included.
    await mount({ retained, error: { current: latest, currentReminders: subtaskReminders([60]) } });
    await open(); 
    expect(chip("4 hours")!.getAttribute("aria-pressed")).toBe("true");
    expect(chip("1 day")!.getAttribute("aria-pressed")).toBe("true");
    expect(chip("1 hour")!.getAttribute("aria-pressed")).toBe("false");
    expect(saved).toHaveLength(1);
    await applyPopup(popover()!);
    await settle();
    expect(saved).toHaveLength(2);
    expect(saved[1]).toEqual({ expectedVersion: 4, schedule: saved[0]!.schedule, reminderOffsetsMinutes: [1440, 240] });
  });

  it("R6 an item conflict also lists the latest item's reminders", async () => {
    const summary = { title: "Row", done: false, assignees: [], schedule: latest, reminders: subtaskReminders([240, 60]) };
    await mount({ error: { currentSubtask: summary } });
    await open();
    expect(popover()!.textContent).toContain("4 hours, 1 hour, Due now");
  });

  it("R7 the next-reminder line states the row's saved next reminder", async () => {
    await mount({ reminders: { offsets: [1440], next: { kind: "advance", offsetMinutes: 1440, firesAt: "2026-10-07T22:00:00.000Z" } } });
    await open();
    expect(popover()!.textContent).toContain("Currently saved: next reminder");
    expect(popover()!.textContent).toContain("1 day · Thu 8 Oct · 09:00");
  });

  it("R8 Cancel discards the draft offsets and the retained draft", async () => {
    const retained: RetainedSchedule = { draft: null, baseVersion: null };
    await mount({ retained });
    await open();
    await click(chip("4 hours")!);
    await click(popupButton(popover()!, "Cancel")!);
    await settle(12);
    expect(saved).toHaveLength(0);
    expect(retained.draft).toBeNull();
  });
});
