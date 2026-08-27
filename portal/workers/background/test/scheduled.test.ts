import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const scheduledJobs = vi.hoisted(() => ({
  deadline: vi.fn().mockResolvedValue({ scanned: 0, fired: 0, published: 0 }),
  recovery: vi.fn().mockResolvedValue(0),
  raw: vi.fn().mockResolvedValue({ attempted: 0, advanced: 0, skipped: 0, failures: 0 }),
  stalled: vi.fn().mockResolvedValue(0),
  subtasks: vi.fn().mockResolvedValue(0),
  prune: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/project-deadline", () => ({ scanProjectDeadlineOccurrences: scheduledJobs.deadline }));
vi.mock("../src/notification-delivery", () => ({
  processNotificationDlqMessage: vi.fn(),
  processNotificationMessage: vi.fn(),
  recoverNotificationOutbox: scheduledJobs.recovery,
}));
vi.mock("../src/reconcile-awaiting-raw", () => ({ reconcileAwaitingRawProjects: scheduledJobs.raw }));
vi.mock("../src/notifications", () => ({
  notifyProject: vi.fn(),
  pruneNotifications: scheduledJobs.prune,
  scanDueSubtasks: scheduledJobs.subtasks,
  scanStalledAutoHdr: scheduledJobs.stalled,
}));

import QuincyBackground from "../src";

const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

function worker(): QuincyBackground {
  return new QuincyBackground({} as ExecutionContext, {} as never);
}

function controller(cron: string): ScheduledController {
  return { cron, scheduledTime: 1_725_000_000_000, noRetry() {} } as ScheduledController;
}

beforeEach(() => {
  for (const job of Object.values(scheduledJobs)) job.mockReset().mockResolvedValue(undefined);
  scheduledJobs.deadline.mockResolvedValue({ scanned: 0, fired: 0, published: 0 });
  scheduledJobs.raw.mockResolvedValue({ attempted: 0, advanced: 0, skipped: 0, failures: 0 });
  consoleError.mockClear();
  consoleWarn.mockClear();
});

afterAll(() => {
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

describe("background scheduled Cron dispatch", () => {
  it("runs only the two minute jobs for the every-minute trigger", async () => {
    await worker().scheduled(controller("* * * * *"));
    expect(scheduledJobs.deadline).toHaveBeenCalledOnce();
    expect(scheduledJobs.recovery).toHaveBeenCalledOnce();
    expect(scheduledJobs.raw).not.toHaveBeenCalled();
    expect(scheduledJobs.stalled).not.toHaveBeenCalled();
    expect(scheduledJobs.subtasks).not.toHaveBeenCalled();
    expect(scheduledJobs.prune).not.toHaveBeenCalled();
  });

  it("runs only the four hourly jobs for the hourly trigger, including minute zero", async () => {
    await worker().scheduled(controller("0 * * * *"));
    expect(scheduledJobs.deadline).not.toHaveBeenCalled();
    expect(scheduledJobs.recovery).not.toHaveBeenCalled();
    expect(scheduledJobs.raw).toHaveBeenCalledOnce();
    expect(scheduledJobs.stalled).toHaveBeenCalledOnce();
    expect(scheduledJobs.subtasks).toHaveBeenCalledOnce();
    expect(scheduledJobs.prune).toHaveBeenCalledOnce();
  });

  it.each([
    ["deadline", "* * * * *"],
    ["recovery", "* * * * *"],
    ["raw", "0 * * * *"],
    ["stalled", "0 * * * *"],
    ["subtasks", "0 * * * *"],
    ["prune", "0 * * * *"],
  ] as const)("isolates a failure in the %s job from its siblings", async (name, cron) => {
    scheduledJobs[name].mockRejectedValueOnce(new Error(`${name} failed`));
    await expect(worker().scheduled(controller(cron))).resolves.toBeUndefined();
    const siblings = cron === "* * * * *" ? [scheduledJobs.deadline, scheduledJobs.recovery] : [scheduledJobs.raw, scheduledJobs.stalled, scheduledJobs.subtasks, scheduledJobs.prune];
    for (const job of siblings) expect(job).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalled();
  });

  it("warns and runs nothing for an unrecognized trigger", async () => {
    await expect(worker().scheduled(controller("15 * * * *"))).resolves.toBeUndefined();
    for (const job of Object.values(scheduledJobs)) expect(job).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith("Ignored unknown Cron trigger", { cron: "15 * * * *" });
  });
});
