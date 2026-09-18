import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectDeadlineSchedule } from "@quincy/shared";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import { ApiError } from "../lib/api";
import { ProjectHeaderDeadline, deadlineTriggerText } from "./ProjectHeaderDeadline";
import { ConfirmModalHost } from "./ConfirmDialog";
import { confirmStore } from "../lib/confirm";

/**
 * #205 — the Deadline trigger/popover wrapper. Mocks `lib/api` the same way
 * `ProjectDeadlineControl.dom.test.tsx` does, but leaves `lib/confirm` real: the Clear-with-a-
 * real-confirm test below needs an actual `ConfirmModalHost` mounted alongside, not a stubbed
 * `confirm()`, to prove the popover survives Cancel/Escape/outside-press events routed at the
 * confirm dialog (its buttons and its scrim) rather than at itself.
 */

const apiPutMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiPut: (path: string, body: unknown) => apiPutMock(path, body) };
});

const projectId = "11111111-1111-4111-8111-111111111111";
const emptySchedule: ProjectDeadlineSchedule = { version: 0, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false };

function scheduleAt(instant: string, overrides: Partial<ProjectDeadlineSchedule> = {}): ProjectDeadlineSchedule {
  return {
    version: 1,
    deadline: { localCivil: "2027-01-15T09:00", zone: "Australia/Sydney", utcOffsetMinutes: 660, fold: 0, instant },
    reminderOffsetsMinutes: [1440],
    state: "scheduled",
    nextOccurrence: null,
    canResume: false,
    ...overrides,
  };
}

let root: Root | null = null;
let queryClient: QueryClient;
let runtime: ProjectQueryRuntime;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

async function mount(schedule: ProjectDeadlineSchedule, canEdit = true, withConfirmHost = false) {
  const host = document.createElement("div"); document.body.appendChild(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  runtime = new ProjectQueryRuntime(queryClient);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ProjectQueryRuntimeProvider runtime={runtime}>
        <QueryClientProvider client={queryClient}>
          {withConfirmHost && <ConfirmModalHost />}
          <ProjectHeaderDeadline projectId={projectId} schedule={schedule} canEdit={canEdit} />
        </QueryClientProvider>
      </ProjectQueryRuntimeProvider>,
    );
    await Promise.resolve();
  });
  return host;
}

async function rerenderSchedule(schedule: ProjectDeadlineSchedule, canEdit = true) {
  await act(async () => {
    root!.render(
      <ProjectQueryRuntimeProvider runtime={runtime}>
        <QueryClientProvider client={queryClient}>
          <ProjectHeaderDeadline projectId={projectId} schedule={schedule} canEdit={canEdit} />
        </QueryClientProvider>
      </ProjectQueryRuntimeProvider>,
    );
    await Promise.resolve();
  });
}

async function openTrigger(host: HTMLElement) {
  const trigger = host.querySelector<HTMLButtonElement>('[data-testid="project-deadline-trigger"]')!;
  await act(async () => { trigger.click(); await Promise.resolve(); await Promise.resolve(); });
  return document.querySelector<HTMLElement>('[role="dialog"][aria-label="Deadline"]')!;
}

/** A real mouse click on an element outside the popover, then the tick Base UI's outside-press dismiss needs to settle. */
async function pressOutside(element: Element) {
  await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); await Promise.resolve(); });
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)); });
}

/** Opens Set Deadline inside the popover and types a date, leaving an unsaved draft. */
async function dirtyDraft(dialog: HTMLElement) {
  const setButton = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Set Deadline")!;
  await act(async () => { setButton.click(); await Promise.resolve(); });
  await setInput(dialog.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')!, "2027-01-15");
}

/** Reopens the popover and checks the earlier draft is gone: the editor is closed again. */
async function expectDraftDiscarded(host: HTMLElement) {
  const reopened = await openTrigger(host);
  expect(reopened.querySelector('input[aria-label="Deadline date"]')).toBeNull();
  expect([...reopened.querySelectorAll("button")].some((button) => button.textContent === "Set Deadline")).toBe(true);
}

async function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); });
}

// `Modal` (behind `ConfirmDialog`) delays its own unmount by 120ms (`--dur-fast`) after `open`
// goes false, so it can animate closed — same idiom as `ConfirmDialog.dom.test.tsx`.
async function waitForConfirmClose() {
  await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 150)); });
}

beforeEach(() => {
  apiPutMock.mockReset().mockResolvedValue({ changed: true, current: scheduleAt("2027-01-14T22:00:00.000Z"), eventIntent: null, publicationIds: [] });
});

afterEach(async () => {
  confirmStore.resolve(false);
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  runtime?.dispose(); queryClient?.clear(); root = null;
  // Popover content (and the confirm dialog) portal to `document.body`, outside `host`.
  document.body.replaceChildren();
});

describe("ProjectHeaderDeadline", () => {
  it("names only role-bearing or natively-named elements in the popover, and nests no interactive element inside another (#206)", async () => {
    const host = await mount(scheduleAt("2027-01-15T09:00:00.000Z", { state: "overdue" }));
    const dialog = await openTrigger(host);

    // `ProjectDeadlineControl.tsx`'s reminder-summary block used to be `aria-label` on a plain
    // `<div>` — html-aria naming rules do not let a generic div carry an accessible name — so it
    // needs `role="group"` (or similar) to be a legal target for `aria-label`.
    const unnamed = [...dialog.querySelectorAll<HTMLElement>("[aria-label]")]
      .filter((el) => el.getAttribute("aria-label") && !el.hasAttribute("role")
        && !["BUTTON", "INPUT", "A", "SELECT", "TEXTAREA"].includes(el.tagName));
    expect(unnamed).toEqual([]);
    // The scan above is a net; this is the specific catch it was cast for.
    expect(dialog.querySelector('[role="group"][aria-label="Deadline reminder summary"]')).not.toBeNull();

    const interactive = [...dialog.querySelectorAll<HTMLElement>("button, a, input, select, textarea")];
    for (const element of interactive) expect(element.querySelector("button, a, input, select, textarea")).toBeNull();
  });


  // #213: the accessible name is the visible text with the cell's key in front (WCAG 2.5.3 — the
  // name must contain what a speech-control user reads); "Deadline: Set deadline" is frozen in
  // the external-visibility inventory.
  it("shows Set deadline and no pill when there is no deadline, with the accessible name Deadline: Set deadline", async () => {
    const host = await mount(emptySchedule);
    const trigger = host.querySelector('[data-testid="project-deadline-trigger"]')!;
    expect(trigger.textContent).toContain("Set deadline");
    expect(trigger.textContent).not.toContain("Not set");
    expect(trigger.textContent).not.toContain("Overdue");
    expect(trigger.textContent).not.toContain("Due in");
    expect(trigger.getAttribute("aria-label")).toBe("Deadline: Set deadline");
  });

  // #213: prototype 2a prints the scheduled Deadline as "Thu 18 Sep · 17:00" — weekday, day,
  // three-letter month, no year, then the civil time. Built from `localCivil`, never from the
  // instant, so the viewer's own zone cannot shift the date. September is the trap: recent ICU
  // data abbreviates it "Sept" for en-AU, so the month must not come from Intl.
  it("prints a scheduled Deadline as weekday, day, three-letter month and civil time", async () => {
    const host = await mount(scheduleAt("2027-01-14T22:00:00.000Z"));
    const trigger = host.querySelector('[data-testid="project-deadline-trigger"]')!;
    expect(trigger.textContent).toContain("Fri 15 Jan · 09:00");
    expect(trigger.textContent).not.toContain("2027");
    expect(trigger.getAttribute("aria-label")).toMatch(/^Deadline: Fri 15 Jan · 09:00/);
    await rerenderSchedule(scheduleAt("2026-09-17T07:00:00.000Z", {
      deadline: { localCivil: "2026-09-17T17:00", zone: "Australia/Sydney", utcOffsetMinutes: 600, fold: 0, instant: "2026-09-17T07:00:00.000Z" },
    }));
    expect(trigger.textContent).toContain("Thu 17 Sep · 17:00");
  });

  // Sol (#213 review): the twelve-entry month table and the weekday lookup are user-visible data;
  // one January and one September case would let ten of them regress unnoticed. Known dates only.
  it.each([
    ["2026-01-01T00:00", "Thu 1 Jan · 00:00"],
    ["2026-02-28T09:05", "Sat 28 Feb · 09:05"],
    ["2024-02-29T12:00", "Thu 29 Feb · 12:00"],
    ["2026-03-31T23:59", "Tue 31 Mar · 23:59"],
    ["2026-04-06T08:30", "Mon 6 Apr · 08:30"],
    ["2026-05-10T17:00", "Sun 10 May · 17:00"],
    ["2026-06-19T11:45", "Fri 19 Jun · 11:45"],
    ["2026-07-04T13:00", "Sat 4 Jul · 13:00"],
    ["2026-08-12T07:15", "Wed 12 Aug · 07:15"],
    ["2026-09-18T17:00", "Fri 18 Sep · 17:00"],
    ["2026-10-04T02:30", "Sun 4 Oct · 02:30"],
    ["2026-11-25T18:20", "Wed 25 Nov · 18:20"],
    ["2026-12-31T22:00", "Thu 31 Dec · 22:00"],
  ])("deadlineTriggerText(%s) is %s", (localCivil, expected) => {
    expect(deadlineTriggerText(localCivil)).toBe(expected);
  });

  it("falls back to the raw civil string when it is not an ISO local date-time", () => {
    expect(deadlineTriggerText("tomorrow")).toBe("tomorrow");
  });

  it("shows a critical Overdue pill once the deadline has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-01-15T10:00:00.000Z"));
    try {
      const host = await mount(scheduleAt("2027-01-15T09:00:00.000Z", { state: "overdue" }));
      const trigger = host.querySelector('[data-testid="project-deadline-trigger"]')!;
      expect(trigger.textContent).toContain("Overdue");
      expect(trigger.getAttribute("aria-label")).toContain(", Overdue");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a caution Due-in pill inside the 72-hour window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-01-14T00:00:00.000Z"));
    try {
      const host = await mount(scheduleAt("2027-01-15T09:00:00.000Z"));
      const trigger = host.querySelector('[data-testid="project-deadline-trigger"]')!;
      expect(trigger.textContent).toContain("Due in");
      expect(trigger.getAttribute("aria-label")).toMatch(/, Due in \d+[dhm]$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the Due-in pill after its 60-second interval ticks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-15T00:00:00.000Z"));
    try {
      const host = await mount(scheduleAt("2027-01-15T00:59:30.000Z"));
      const trigger = host.querySelector('[data-testid="project-deadline-trigger"]')!;
      expect(trigger.textContent).toContain("Due in 59m");

      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

      expect(trigger.textContent).toContain("Due in 58m");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a dialog labelled Deadline showing Set Deadline for an unset schedule", async () => {
    const host = await mount(emptySchedule);
    const dialog = await openTrigger(host);
    expect(dialog.textContent).toContain("Set Deadline");

    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Set Deadline")!.click(); await Promise.resolve(); });
    expect(dialog.querySelector('input[aria-label="Deadline date"]')).not.toBeNull();
    expect(dialog.querySelector('input[aria-label="Deadline time"]')).not.toBeNull();
    expect(dialog.querySelector('input[aria-label="Custom reminder minutes"]')).not.toBeNull();
    expect(dialog.textContent).toContain("Due-now reminder is mandatory.");
    expect([...dialog.querySelectorAll<HTMLButtonElement>("button")].some((button) => button.textContent === "Save Deadline")).toBe(true);
  });

  it("shows no Set/Edit Deadline control when canEdit is false", async () => {
    const host = await mount(emptySchedule, false);
    const dialog = await openTrigger(host);
    expect(dialog.textContent).not.toContain("Set Deadline");
    expect(dialog.textContent).not.toContain("Edit Deadline");
    expect(dialog.querySelectorAll("button")).toHaveLength(0);
  });

  it("keeps a dirty draft through a rerender with a new schedule object of the same version", async () => {
    const host = await mount(emptySchedule);
    const dialog = await openTrigger(host);
    const setButton = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Set Deadline")!;
    await act(async () => { setButton.click(); await Promise.resolve(); });
    await setInput(dialog.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')!, "2027-01-15");

    // A new object, same version — an ordinary background refresh, not a save conflict.
    await rerenderSchedule({ ...emptySchedule });

    expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')?.value).toBe("2027-01-15");
    expect(apiPutMock).not.toHaveBeenCalled();
  });

  it("keeps a 409 conflict inside the popover with the draft and recovery actions visible", async () => {
    apiPutMock.mockRejectedValueOnce(new ApiError("Project deadline changed; reload before saving.", 409, {
      current: scheduleAt("2027-02-20T23:00:00.000Z", { version: 2 }),
    }));
    const host = await mount(emptySchedule);
    const dialog = await openTrigger(host);
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Set Deadline")!.click(); await Promise.resolve(); });
    await setInput(dialog.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')!, "2027-01-15");
    await setInput(dialog.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')!, "09:00");
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save Deadline")!.click(); await Promise.resolve(); });
    await flush();

    expect(document.querySelector('[role="dialog"][aria-label="Deadline"]')).not.toBeNull();
    // Two alerts render on a 409: the API error notice, then the conflict recovery block.
    const alerts = [...dialog.querySelectorAll('[role="alert"]')].map((el) => el.textContent ?? "");
    expect(alerts.some((text) => text.includes("Project deadline changed; reload before saving."))).toBe(true);
    expect(alerts.some((text) => text.includes("Deadline changed elsewhere."))).toBe(true);
    expect(dialog.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')?.value).toBe("2027-01-15");
    expect(dialog.textContent).toContain("Reload latest");
    expect(dialog.textContent).toContain("Review and reapply my draft");
  });

  it("closes on Escape without saving, discards the open draft, and returns focus to the trigger (#206)", async () => {
    const host = await mount(emptySchedule);
    await dirtyDraft(await openTrigger(host));
    expect(document.querySelector('[role="dialog"][aria-label="Deadline"]')).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector('[role="dialog"][aria-label="Deadline"]')).toBeNull();
    expect(apiPutMock).not.toHaveBeenCalled();
    // Base UI's focus-return lands a tick after the close — same 20ms wait the outside-click
    // test below already uses for its own dismiss.
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)); });
    expect(document.activeElement).toBe(host.querySelector('[data-testid="project-deadline-trigger"]'));
    await expectDraftDiscarded(host);
  });

  it("closes on an outside click without saving, and discards the open draft", async () => {
    const host = await mount(emptySchedule);
    await dirtyDraft(await openTrigger(host));
    expect(document.querySelector('[role="dialog"][aria-label="Deadline"]')).not.toBeNull();
    await act(async () => { document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); await Promise.resolve(); });
    // Base UI's Popover outside-press is "intentional" (docs/lessons.md P2): same click shape as
    // NotificationBell's test. It settles a tick later, hence the 20ms wait.
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)); });
    expect(document.querySelector('[role="dialog"][aria-label="Deadline"]')).toBeNull();
    expect(apiPutMock).not.toHaveBeenCalled();
    await expectDraftDiscarded(host);
  });

  it("keeps the popover open behind a real Clear confirm, and only saves once the confirm is accepted", async () => {
    const host = await mount(scheduleAt("2027-01-15T09:00:00.000Z"), true, true);
    const dialog = await openTrigger(host);
    const editButton = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Edit Deadline")!;
    await act(async () => { editButton.click(); await Promise.resolve(); });

    async function clickClear() {
      const clearButton = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Clear")!;
      await act(async () => { clearButton.click(); await Promise.resolve(); });
      await flush();
    }

    await clickClear();
    expect(document.querySelector('[data-testid="confirm-modal"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"][aria-label="Deadline"]')).not.toBeNull();

    // Cancel: the popover stays open, and nothing is saved.
    // A dispatched mouse click, not `.click()`: only this shape reaches Base UI's outside-press
    // handling in happy-dom, so it is the one that could dismiss the popover.
    await pressOutside(document.querySelector<HTMLButtonElement>('[data-testid="confirm-modal-cancel"]')!);
    await waitForConfirmClose();
    expect(apiPutMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"][aria-label="Deadline"]')).not.toBeNull();

    // Dismiss the confirm by pressing its scrim. Modal's panel stops click propagation, but its
    // scrim does not, so this click reaches Base UI as an outside press of the Deadline popover.
    await clickClear();
    const scrim = document.querySelector<HTMLElement>('[data-testid="modal-scrim"]')!;
    await act(async () => { scrim.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await Promise.resolve(); });
    await pressOutside(scrim);
    await waitForConfirmClose();
    expect(document.querySelector('[data-testid="confirm-modal"]')).toBeNull();
    expect(apiPutMock).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"][aria-label="Deadline"]')).not.toBeNull();

    // Redo, this time confirming.
    await clickClear();
    expect(document.querySelector('[data-testid="confirm-modal"]')).not.toBeNull();
    await pressOutside(document.querySelector<HTMLButtonElement>('[data-testid="confirm-modal-confirm"]')!);
    await flush();
    expect(document.querySelector('[role="dialog"][aria-label="Deadline"]')).not.toBeNull();
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${projectId}/deadline`, expect.objectContaining({ deadline: null }));
  });
});
