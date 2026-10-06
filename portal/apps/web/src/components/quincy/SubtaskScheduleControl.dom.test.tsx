/**
 * #372, rebuilt in #423 on the shared range popup (`quincy/DateTimeField` range form) — the Checklist's range picker, extracted to `quincy/SubtaskScheduleControl.tsx`, gains three opt-in
 * presentation props for the Gantt's Subtask Due cell (a caller-supplied trigger, initial focus on End, focus
 * returned to the trigger) and a caller-supplied validation message. Every default reproduces the Checklist.
 */
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKLIST_SCHEDULE_ZONE, type ChecklistScheduleDto } from "@quincy/shared";
import { SubtaskScheduleControl, type RangeScheduleRequest, type ScheduleError } from "./SubtaskScheduleControl";
import { startMoment, endMoment } from "@/testing/subtask-schedule";
import { applyPopup, dateTimePopup, pickPopupDay, popupButton, pressInPopup, rangeToggles } from "@/testing/date-time-popup";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!Element.prototype.getAnimations) Element.prototype.getAnimations = () => [];
const value: ChecklistScheduleDto = { state: "range", version: 3, zone: CHECKLIST_SCHEDULE_ZONE, start: startMoment("2026-10-08"), end: endMoment("2026-10-10"), due: "2026-10-10T17:00" };

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
const popover = () => dateTimePopup("Schedule for Row");
const button = (name: string) => popupButton(popover()!, name);
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

describe("SubtaskScheduleControl (#372, #423)", () => {
  it("S1 a caller-supplied trigger replaces the built-in one, is wired to the popup and opens it", async () => {
    await mount({ trigger: customTrigger });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="custom-trigger"]');
    expect(trigger).not.toBeNull();
    expect(host.querySelector('[aria-label="Schedule for Row"]')).toBeNull();
    expect(trigger!.getAttribute("aria-expanded")).toBe("false");
    await click(trigger!);
    await settle();
    expect(trigger!.getAttribute("aria-expanded")).toBe("true");
    expect(popover()).not.toBeNull();
  });

  it("S1b with no trigger prop the built-in Checklist trigger names the range with both moments", async () => {
    await mount();
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Schedule for Row"]');
    expect(trigger).not.toBeNull();
    expect(trigger!.textContent).toContain("Thu 8 Oct 09:00 → Sat 10 Oct 17:00");
  });

  it("S2 initialFocus='end' opens the popup on End; the default opens on Start", async () => {
    await mount({ trigger: customTrigger, initialFocus: "end" });
    await click(host.querySelector<HTMLButtonElement>('[data-testid="custom-trigger"]')!);
    await settle();
    expect(rangeToggles(popover()!).active).toBe("End");
    await click(button("Cancel")!);
    await settle(12);
    await mount({ trigger: customTrigger });
    await click(host.querySelector<HTMLButtonElement>('[data-testid="custom-trigger"]')!);
    await settle();
    expect(rangeToggles(popover()!).active).toBe("Start");
  });

  it("S3 Apply hands the new range to onSave at the open version, both ends as civil minutes", async () => {
    await mount();
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Schedule for Row"]')!);
    await settle();
    await pickPopupDay(popover()!, "2026-10-12");
    await applyPopup(popover()!);
    await settle();
    expect(saved).toEqual([{ expectedVersion: 3, schedule: { state: "range", start: { localCivil: "2026-10-12T09:00" }, end: { localCivil: "2026-10-12T17:00" } } }]);
  });

  it("S4 Cancel closes without calling onSave", async () => {
    await mount();
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Schedule for Row"]')!);
    await settle();
    await pressInPopup(popover()!, "Cancel");
    await settle(12);
    expect(saved).toHaveLength(0);
    expect(popover()).toBeNull();
  });

  it("S5 the Project default shortcut appears only when the caller has one, and applies it", async () => {
    await mount();
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Schedule for Row"]')!);
    await settle();
    expect(button("Project default")).toBeUndefined();
    await click(button("Cancel")!);
    await settle(12);
    await mount({ projectDefault: { start: { localCivil: "2026-11-02T09:00", fold: 0 }, end: { localCivil: "2026-11-06T17:00", fold: 0 } } });
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Schedule for Row"]')!);
    await settle();
    await pressInPopup(popover()!, "Project default");
    await applyPopup(popover()!);
    await settle();
    expect(saved[0]!.schedule).toEqual({ state: "range", start: { localCivil: "2026-11-02T09:00" }, end: { localCivil: "2026-11-06T17:00" } });
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
    await pressInPopup(popover()!, "Use latest item (discard draft)");
    expect(onUseLatestItem).toHaveBeenCalledWith(summary);
  });

  it("readOnly (#450) shows the schedule as a pill with no trigger button and no popup", async () => {
    await mount({ readOnly: true });
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).toContain("Thu 8 Oct");
    expect(host.textContent).toContain("Sat 10 Oct");
    expect(popover()).toBeNull();
  });
  it("readOnly renders nothing when there is no schedule and no default label", async () => {
    await mount({ readOnly: true, value: null });
    expect(host.textContent).toBe("");
  });

  describe("external anchor, no trigger (#582)", () => {
    function AnchoredHarness({ onClose, finalFocus }: { onClose: (open: boolean) => void; finalFocus?: () => boolean | HTMLElement | null | void }) {
      const [open, setOpenState] = useState(true);
      const setOpen = (next: boolean) => { onClose(next); setOpenState(next); };
      return <>
        <div data-testid="bar" tabIndex={-1} style={{ position: "fixed", left: 40, top: 40, width: 300, height: 20 }}>bar</div>
        <button type="button" data-testid="outside">elsewhere</button>
        <SubtaskScheduleControl owner="t" label="Schedule for Row" value={value} open={open} setOpen={setOpen} busy={false} onSave={(request) => saved.push(request)}
          anchor={() => document.querySelector('[data-testid="bar"]')!} finalFocus={finalFocus ?? (() => document.querySelector<HTMLElement>('[data-testid="bar"]') ?? true)} />
      </>;
    }
    it("A1 renders no trigger and no button of its own, and the popup is open on Start", async () => {
      await act(async () => { root.render(<AnchoredHarness onClose={() => undefined} />); await Promise.resolve(); });
      await settle();
      expect(host.querySelector('[aria-label="Schedule for Row"]')).toBeNull();
      expect(document.querySelectorAll('[role="dialog"][aria-label="Schedule for Row"]')).toHaveLength(1);
      expect(rangeToggles(popover()!).active).toBe("Start");
    });
    it("A2 Cancel closes it and hands focus to finalFocus's element, not a trigger", async () => {
      const closes: boolean[] = [];
      await act(async () => { root.render(<AnchoredHarness onClose={(next) => closes.push(next)} />); await Promise.resolve(); });
      await settle();
      await pressInPopup(popover()!, "Cancel");
      await settle(12);
      expect(closes).toEqual([false]);
      expect(popover()).toBeNull();
      expect(document.activeElement).toBe(document.querySelector('[data-testid="bar"]'));
    });
    it("A3 Escape closes it", async () => {
      const closes: boolean[] = [];
      await act(async () => { root.render(<AnchoredHarness onClose={(next) => closes.push(next)} />); await Promise.resolve(); });
      await settle();
      await act(async () => { popover()!.querySelector<HTMLElement>("button")!.focus(); document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); await Promise.resolve(); });
      await settle(12);
      expect(closes).toEqual([false]);
      expect(popover()).toBeNull();
    });
    it("A4 an outside press closes it and finalFocus can leave focus where the press landed", async () => {
      const closes: boolean[] = [];
      const outsideKept = () => (document.activeElement?.getAttribute("data-testid") === "outside" ? false : true);
      await act(async () => { root.render(<AnchoredHarness onClose={(next) => closes.push(next)} finalFocus={outsideKept} />); await Promise.resolve(); });
      await settle();
      const outside = host.querySelector<HTMLButtonElement>('[data-testid="outside"]')!;
      await act(async () => {
        outside.focus();
        outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse" }));
        outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        outside.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerType: "mouse" }));
        outside.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      await settle(12);
      expect(closes).toContain(false);
      expect(popover()).toBeNull();
      expect(document.activeElement).toBe(outside);
    });
    it("A5 anchor and trigger together is refused", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      await expect(act(async () => { root.render(<Harness extra={{ trigger: customTrigger, anchor: () => document.body }} />); await Promise.resolve(); })).rejects.toThrow(/mutually exclusive/);
      spy.mockRestore();
    });
  });
});

describe("SubtaskScheduleControl collision padding (#587)", () => {
  it("calls a padding function once per open, never while closed, and again on a reopen", async () => {
    const padding = vi.fn(() => ({ top: 66, right: 16, bottom: 16, left: 16 }));
    await mount({ trigger: customTrigger, popupCollisionPadding: padding });
    expect(padding).not.toHaveBeenCalled();
    await click(host.querySelector<HTMLButtonElement>('[data-testid="custom-trigger"]')!);
    await settle();
    expect(padding).toHaveBeenCalledTimes(1);
    await click(button("Cancel")!);
    await settle(12);
    expect(popover()).toBeNull();
    expect(padding).toHaveBeenCalledTimes(1);
    await click(host.querySelector<HTMLButtonElement>('[data-testid="custom-trigger"]')!);
    await settle();
    expect(padding).toHaveBeenCalledTimes(2);
  });

  it("calls it once for a picker an external host mounts already open (the bar picker has no onOpenChange edge)", async () => {
    const padding = vi.fn(() => 16);
    await act(async () => {
      root.render(<SubtaskScheduleControl owner="t" label="Schedule for Row" value={value} open setOpen={() => {}} busy={false} onSave={() => {}} anchor={host} popupCollisionPadding={padding} />);
      await Promise.resolve();
    });
    await settle();
    expect(padding).toHaveBeenCalledTimes(1);
    expect(popover()).not.toBeNull();
    // Re-renders while open do not ask again.
    await act(async () => {
      root.render(<SubtaskScheduleControl owner="t" label="Schedule for Row" value={value} open setOpen={() => {}} busy={false} onSave={() => {}} anchor={host} popupCollisionPadding={padding} />);
      await Promise.resolve();
    });
    expect(padding).toHaveBeenCalledTimes(1);
  });

  it("keeps the focus rules: Start opens on the Start toggle's day, End on the End toggle", async () => {
    await mount({ trigger: customTrigger, popupCollisionPadding: () => 16 });
    await click(host.querySelector<HTMLButtonElement>('[data-testid="custom-trigger"]')!);
    await settle();
    expect(rangeToggles(popover()!).active).toBe("Start");
    expect(document.activeElement?.closest('[aria-selected="true"]')).not.toBeNull();
  });
});
