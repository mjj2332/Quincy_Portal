import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKLIST_SCHEDULE_ZONE, type ChecklistScheduleDto } from "@quincy/shared";
import { ProjectSheet } from "./quincy/ProjectSheet";
import { ProjectHeaderDropbox } from "./ProjectHeaderDropbox";
import { SubtaskScheduleControl } from "./quincy/SubtaskScheduleControl";
import { DateTimeField } from "./quincy/DateTimeField";
import { Popover, PopoverContent, PopoverTrigger } from "./reui/popover";
import type { ProjectDetail } from "../lib/project-data";
import { startMoment, endMoment } from "@/testing/subtask-schedule";
import { dateTimePopup, popupButton } from "@/testing/date-time-popup";
import { emulateSheetRestoreFocus } from "@/testing/sheet-restore-focus";

/**
 * #669 — every `reui/popover.tsx` popover rendered inside the modal Project sheet returns focus to
 * its trigger on close, immediately and a frame later, without each consumer carrying its own
 * trigger-refocus. The sheet's `restoreFocus: "popup"` is EMULATED (`testing/sheet-restore-focus.ts`),
 * so a pass here is not proof against the real sheet: the browser pass is.
 */

vi.mock("../lib/shell-chrome", () => ({ shellChromeBottom: () => 0 }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = { monitoredRawFolder: null, rawFolderPath: null, rawFolderLink: null } as unknown as ProjectDetail;
const range: ChecklistScheduleDto = { state: "range", version: 3, zone: CHECKLIST_SCHEDULE_ZONE, start: startMoment("2026-10-08"), end: endMoment("2026-10-10"), due: "2026-10-10T17:00" };

let root: Root | null = null;
let host: HTMLElement;
let stop: (() => void) | null = null;
let popupLabel = "";

const frame = () => act(async () => { await new Promise<void>((r) => requestAnimationFrame(() => r())); await new Promise<void>((r) => setTimeout(r, 30)); });
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const popup = () => dateTimePopup(popupLabel);
const triggerByLabel = (prefix: string) => [...document.querySelectorAll<HTMLElement>("button")].find((b) => (b.getAttribute("aria-label") ?? "").startsWith(prefix))!;

async function mount(node: ReactNode, label: string, inSheet = true, kind: "project" | "edit" = "project") {
  popupLabel = label;
  stop = emulateSheetRestoreFocus(popup);
  root = createRoot(host);
  await act(async () => {
    root!.render(inSheet
      ? <ProjectSheet open kind={kind} sheetKey="p:1" backdropHref="/" onRequestClose={() => {}}>{node}</ProjectSheet>
      : <>{node}</>);
    await Promise.resolve();
    await Promise.resolve();
  });
}
async function openFrom(trigger: HTMLElement) {
  await act(async () => { trigger.focus(); trigger.click(); await Promise.resolve(); await Promise.resolve(); });
  expect(popup()).not.toBeNull();
  await act(async () => { popup()!.focus(); await Promise.resolve(); });
}
async function escape() {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
}
async function cancel() {
  const button = popupButton(popup()!, "Cancel")!;
  await act(async () => { button.focus(); button.click(); });
}
async function expectOnTrigger(trigger: HTMLElement) {
  expect(popup()).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await frame();
  expect(document.activeElement).toBe(trigger);
}

beforeEach(() => { (HTMLElement.prototype as unknown as { getAnimations: () => unknown[] }).getAnimations = () => []; host = document.createElement("div"); document.body.appendChild(host); });
afterEach(async () => {
  stop?.(); stop = null;
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  root = null; host.remove(); document.body.replaceChildren();
});

function Dropbox() {
  return <ProjectHeaderDropbox project={project} isSyncing={false} autohdrBlocked={false} onSyncDropbox={() => {}} />;
}

function Checklist() {
  const [open, setOpen] = useState(false);
  return <SubtaskScheduleControl owner="t" label="Schedule for Row" value={range} open={open} setOpen={setOpen} busy={false} onSave={() => {}} />;
}

describe("a popover inside the Project sheet returns focus to its trigger (#669)", () => {
  it("Dropbox: Escape", async () => {
    await mount(<Dropbox />, "Dropbox");
    const trigger = triggerByLabel("Dropbox:");
    await openFrom(trigger);
    await escape();
    await expectOnTrigger(trigger);
  });

  it("Checklist schedule: Escape", async () => {
    await mount(<Checklist />, "Schedule for Row");
    const trigger = triggerByLabel("Schedule for Row");
    await openFrom(trigger);
    await escape();
    await expectOnTrigger(trigger);
  });

  it("Checklist schedule: Cancel", async () => {
    await mount(<Checklist />, "Schedule for Row");
    const trigger = triggerByLabel("Schedule for Row");
    await openFrom(trigger);
    await cancel();
    await expectOnTrigger(trigger);
  });

  it("Shoot date (DateTimeField, date variant): Escape", async () => {
    await mount(<DateTimeField variant="date" id="shoot" label="Shoot date" clearable value="2026-10-08" onApply={() => {}} />, "Shoot date", true, "edit");
    const trigger = document.getElementById("shoot")!;
    await openFrom(trigger);
    await escape();
    await expectOnTrigger(trigger);
  });

  it("Shoot date (DateTimeField, date variant): Cancel", async () => {
    await mount(<DateTimeField variant="date" id="shoot" label="Shoot date" clearable value="2026-10-08" onApply={() => {}} />, "Shoot date", true, "edit");
    const trigger = document.getElementById("shoot")!;
    await openFrom(trigger);
    await cancel();
    await expectOnTrigger(trigger);
  });
});

describe("negative cases (#669)", () => {
  it("Dropbox outside a sheet behaves as before: focus is not forced by the Popover", async () => {
    await mount(<Dropbox />, "Dropbox", false);
    const trigger = triggerByLabel("Dropbox:");
    await openFrom(trigger);
    await escape();
    await settle();
    expect(popup()).toBeNull();
    // Base UI's own default return handles it; nothing here moved focus onto <body>.
    expect(document.activeElement === trigger || document.activeElement === document.body).toBe(true);
  });

  it("a caller's finalFocus inside a sheet wins over the trigger", async () => {
    let target: HTMLButtonElement | null = null;
    function WithFinalFocus() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" ref={(node) => { target = node; }}>elsewhere</button>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger type="button" aria-label="Opener">open</PopoverTrigger>
          <PopoverContent aria-label="Own" finalFocus={() => target}>content</PopoverContent>
        </Popover>
      </>;
    }
    await mount(<WithFinalFocus />, "Own");
    // The emulated sheet reclaims focus whenever it is homeless at close, which would mask a finalFocus hand-off Base UI performs itself.
    stop?.(); stop = null;
    const trigger = triggerByLabel("Opener");
    await openFrom(trigger);
    await escape();
    await frame();
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(target);
  });

  it("an outside press onto a real button keeps focus there", async () => {
    let other: HTMLButtonElement | null = null;
    await mount(<><button type="button" ref={(node) => { other = node; }}>elsewhere</button><Dropbox /></>, "Dropbox");
    const trigger = triggerByLabel("Dropbox:");
    await openFrom(trigger);
    await act(async () => {
      other!.focus();
      other!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      other!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      other!.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      other!.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      other!.click();
      await Promise.resolve();
    });
    await frame();
    expect(document.activeElement).toBe(other);
  });
});
