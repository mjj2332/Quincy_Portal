import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../lib/api";
import { ProjectQueryRuntime, ProjectQueryRuntimeProvider } from "../lib/project-query-sync";
import type { ProjectDeadlineSchedule } from "@quincy/shared";

const apiPutMock = vi.hoisted(() => vi.fn<(path: string, body: unknown) => Promise<unknown>>());
const confirmMock = vi.hoisted(() => vi.fn<(options: unknown) => Promise<boolean>>());

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, apiPut: (path: string, body: unknown) => apiPutMock(path, body) };
});
vi.mock("../lib/confirm", () => ({ confirm: confirmMock }));

const projectId = "11111111-1111-4111-8111-111111111111";
const deadline = { localCivil: "2027-01-15T09:00", zone: "Australia/Sydney" as const, utcOffsetMinutes: 600, fold: 0 as const, instant: "2027-01-14T22:00:00.000Z" };
const emptySchedule: ProjectDeadlineSchedule = { version: 0, deadline: null, reminderOffsetsMinutes: [], state: "unset", nextOccurrence: null, canResume: false };
const activeSchedule: ProjectDeadlineSchedule = { version: 1, deadline, reminderOffsetsMinutes: [1440], state: "scheduled", nextOccurrence: { kind: "advance", offsetMinutes: 1440, firesAt: "2027-01-13T22:00:00.000Z" }, canResume: false };
const authorityAfterConflict: ProjectDeadlineSchedule = { version: 2, deadline: { localCivil: "2027-02-20T10:00", zone: "Australia/Sydney", utcOffsetMinutes: 660, fold: 0, instant: "2027-02-19T23:00:00.000Z" }, reminderOffsetsMinutes: [240], state: "scheduled", nextOccurrence: { kind: "advance", offsetMinutes: 240, firesAt: "2027-02-19T19:00:00.000Z" }, canResume: false };
const savedDraftSchedule: ProjectDeadlineSchedule = { version: 3, deadline: { localCivil: "2026-04-05T02:30", zone: "Australia/Sydney", utcOffsetMinutes: 600, fold: 1, instant: "2026-04-04T16:30:00.000Z" }, reminderOffsetsMinutes: [1440], state: "scheduled", nextOccurrence: { kind: "advance", offsetMinutes: 1440, firesAt: "2026-04-03T16:30:00.000Z" }, canResume: false };
const summarySchedule: ProjectDeadlineSchedule = { ...activeSchedule, reminderOffsetsMinutes: [1440, 240, 60], skippedReminderOffsetsMinutes: [1440, 240] };

let root: Root | null = null;
let queryClient: QueryClient;
let runtime: ProjectQueryRuntime;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

async function mount(schedule: ProjectDeadlineSchedule, canEdit = true) {
  const host = document.createElement("div"); document.body.appendChild(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  runtime = new ProjectQueryRuntime(queryClient);
  root = createRoot(host);
  const { ProjectDeadlineControl } = await import("./ProjectDeadlineControl");
  await act(async () => { root!.render(<ProjectQueryRuntimeProvider runtime={runtime}><QueryClientProvider client={queryClient}><ProjectDeadlineControl projectId={projectId} schedule={schedule} canEdit={canEdit} /></QueryClientProvider></ProjectQueryRuntimeProvider>); await Promise.resolve(); });
  return host;
}

async function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); await Promise.resolve(); });
}

beforeEach(() => {
  apiPutMock.mockReset().mockResolvedValue({ changed: true, current: activeSchedule, eventIntent: null, publicationIds: [] });
  confirmMock.mockReset().mockResolvedValue(true);
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); await Promise.resolve(); });
  runtime.dispose(); queryClient.clear(); root = null; document.body.replaceChildren();
});

describe("ProjectDeadlineControl", () => {
  it("renders the two rail rows read-only and hides write controls for Delivered", async () => {
    const host = await mount({ ...activeSchedule, state: "inactive_delivered" }, true);
    expect(host.querySelectorAll(".kv")).toHaveLength(2);
    expect(host.textContent).toContain("Sydney (Australia/Sydney)");
    expect(host.textContent).toContain("Reminders inactive while Delivered. Move the project out of Delivered before changing or resuming them.");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("keeps the combined editor draft and sends the dedicated versioned route", async () => {
    const host = await mount(emptySchedule);
    const set = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Set Deadline")!;
    await act(async () => { set.click(); await Promise.resolve(); });
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')!, "2027-01-15");
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')!, "09:00");
    const preset = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) => input.parentElement?.textContent?.includes("1 day"))!;
    await act(async () => { preset.click(); await Promise.resolve(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(apiPutMock).toHaveBeenCalledWith(`/api/projects/${projectId}/deadline`, { expectedVersion: 0, deadline: { localCivil: "2027-01-15T09:00" }, reminderOffsetsMinutes: [1440] });
    expect(host.textContent).toContain("2027-01-15 09:00");
  });

  it("keeps the exact draft and exposes reapply controls on a version conflict", async () => {
    apiPutMock.mockRejectedValueOnce(new ApiError("Project deadline changed; reload before saving.", 409, { current: { ...activeSchedule, version: 2 } }));
    const host = await mount(emptySchedule);
    await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')!, "2027-01-15");
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')!, "09:00");
    await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(host.textContent).toContain("Deadline changed elsewhere.");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')?.value).toBe("2027-01-15");
    expect(host.textContent).toContain("Reload latest");
    expect(host.textContent).toContain("Review and reapply my draft");
  });

  it("retains an exact draft through Reload latest and resubmits it against the new version", async () => {
    apiPutMock
      .mockRejectedValueOnce(new ApiError("That Sydney time occurs twice. Choose Earlier or Later.", 400, {
        code: "deadline_repeated_local_time",
        choices: [{ disambiguation: "earlier", utcOffsetMinutes: 660 }, { disambiguation: "later", utcOffsetMinutes: 600 }],
      }))
      .mockRejectedValueOnce(new ApiError("Project deadline changed; reload before saving.", 409, { current: authorityAfterConflict }))
      .mockResolvedValueOnce({ changed: true, current: savedDraftSchedule, eventIntent: null, publicationIds: [] });
    const host = await mount(emptySchedule);
    await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')!, "2026-04-05");
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')!, "02:30");
    await act(async () => { host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); await Promise.resolve(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    await flush();
    await act(async () => { host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click(); await Promise.resolve(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(host.textContent).toContain("Deadline changed elsewhere.");
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Reload latest")!.click(); await Promise.resolve(); });
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')?.value).toBe("2027-02-20");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')?.value).toBe("10:00");
    expect(host.textContent).toContain("Review and reapply my draft");
    expect(host.textContent).toContain("Authoritative: 2027-02-20 10:00 · 4 hours");
    expect(host.textContent).toContain("Saved draft: 2026-04-05 02:30 (later) · 1 day");
    await act(async () => { [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Review and reapply my draft")!.click(); await Promise.resolve(); });
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')?.value).toBe("2026-04-05");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')?.value).toBe("02:30");
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
    await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(apiPutMock).toHaveBeenLastCalledWith(`/api/projects/${projectId}/deadline`, { expectedVersion: 2, deadline: { localCivil: "2026-04-05T02:30", disambiguation: "later" }, reminderOffsetsMinutes: [1440] });
  });

  it.each([
    ["scheduled", { ...summarySchedule, state: "scheduled" as const }, true],
    ["overdue", { ...summarySchedule, state: "overdue" as const }, true],
    ["delivered", { ...summarySchedule, state: "inactive_delivered" as const }, false],
    ["archived", { ...summarySchedule, state: "inactive_archived" as const }, false],
  ])("shows every configured and skipped reminder offset for the %s rail state", async (_name, schedule, canWrite) => {
    const host = await mount(schedule, canWrite);
    expect(host.textContent).toContain("Configured advance reminders: 1 day, 4 hours, 1 hour");
    expect(host.textContent).toContain("Skipped elapsed advances: 1 day, 4 hours");
    if (_name === "overdue") expect(host.textContent).toContain("Overdue");
  });

  it("shows the complete reminder summary to a read-only viewer", async () => {
    const host = await mount(summarySchedule, false);
    expect(host.textContent).toContain("Configured advance reminders: 1 day, 4 hours, 1 hour");
    expect(host.textContent).toContain("Skipped elapsed advances: 1 day, 4 hours");
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });

  it("keeps a repeated Sydney time draft until an explicit fold is chosen", async () => {
    apiPutMock.mockRejectedValueOnce(new ApiError("That Sydney time occurs twice. Choose Earlier or Later.", 400, {
      code: "deadline_repeated_local_time",
      choices: [{ disambiguation: "earlier", utcOffsetMinutes: 660 }, { disambiguation: "later", utcOffsetMinutes: 600 }],
    }));
    const host = await mount(emptySchedule);
    await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')!, "2026-04-05");
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')!, "02:30");
    await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(host.textContent).toContain("Earlier (+660 minutes)");
    expect(host.textContent).toContain("Later (+600 minutes)");
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await act(async () => { host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click(); await Promise.resolve(); });
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });

  it("keeps the date and time draft attached when Sydney rejects a DST gap", async () => {
    apiPutMock.mockRejectedValueOnce(new ApiError("That Sydney time does not exist because the clocks move forward.", 400, { code: "deadline_nonexistent_local_time" }));
    const host = await mount(emptySchedule);
    await act(async () => { host.querySelector<HTMLButtonElement>("button")!.click(); await Promise.resolve(); });
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')!, "2026-10-04");
    await setInput(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')!, "02:30");
    await act(async () => { host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await Promise.resolve(); });
    await flush();
    expect(host.textContent).toContain("That Sydney time does not exist");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Deadline date"]')?.value).toBe("2026-10-04");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Deadline time"]')?.value).toBe("02:30");
  });
});
