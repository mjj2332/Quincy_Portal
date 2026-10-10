import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const scheduledJobs = vi.hoisted(() => ({
  deadline: vi.fn().mockResolvedValue({ scanned: 0, fired: 0, published: 0 }),
  recovery: vi.fn().mockResolvedValue(0),
  manualPublish: vi.fn().mockResolvedValue({ scanned: 0, recovered: 0, skipped: 0 }),
  raw: vi.fn().mockResolvedValue({ attempted: 0, advanced: 0, skipped: 0, failures: 0 }),
  editedArrival: vi.fn().mockResolvedValue({ scanned: 0, moved: 0, kept: 0, cleared: 0, failures: 0 }),
  stalled: vi.fn().mockResolvedValue(0),
  subtaskScan: vi.fn().mockResolvedValue({ scanned: 0, fired: 0, published: 0 }),
  subtasks: vi.fn().mockResolvedValue({ inserted: 0 }),
  prune: vi.fn().mockResolvedValue(undefined),
  embeddedMedia: vi.fn().mockResolvedValue({ scanned: 0, reclaimed: 0, failed: 0 }),
  trashPurge: vi.fn().mockResolvedValue({ scanned: 0, purged: 0, failed: 0 }),
  digest: vi.fn().mockResolvedValue({ recipients: 0, sent: 0, empty: 0, released: 0, failed: 0, unknown: 0, skipped: 0 }),
}));
vi.mock("../src/embedded-media-sweep", () => ({ sweepEmbeddedMedia: scheduledJobs.embeddedMedia }));
vi.mock("../src/video-trash-purge", () => ({ purgeVideoTrash: scheduledJobs.trashPurge }));

vi.mock("../src/subtask-reminders", () => ({
  scanSubtaskReminderOccurrences: scheduledJobs.subtaskScan,
  reconcileSubtaskReminderOccurrences: scheduledJobs.subtasks,
}));
vi.mock("../src/project-deadline", () => ({ scanProjectDeadlineOccurrences: scheduledJobs.deadline }));
vi.mock("../src/notification-delivery", () => ({
  processNotificationDlqMessage: vi.fn(),
  processNotificationMessage: vi.fn(),
  recoverNotificationOutbox: scheduledJobs.recovery,
}));
vi.mock("../src/email-digest", () => ({ runEmailDigests: scheduledJobs.digest }));
vi.mock("../src/manual-publish-recovery", () => ({ sweepStuckManualPublishes: scheduledJobs.manualPublish }));
vi.mock("../src/reconcile-awaiting-raw", () => ({ reconcileAwaitingRawProjects: scheduledJobs.raw }));
vi.mock("../src/edited-arrival", () => ({ reconcileEditedArrivals: scheduledJobs.editedArrival }));
vi.mock("../src/notifications", () => ({
  notifyProject: vi.fn(),
  pruneNotifications: scheduledJobs.prune,
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
  scheduledJobs.subtaskScan.mockResolvedValue({ scanned: 0, fired: 0, published: 0 });
  scheduledJobs.manualPublish.mockResolvedValue({ scanned: 0, recovered: 0, skipped: 0 });
  scheduledJobs.raw.mockResolvedValue({ attempted: 0, advanced: 0, skipped: 0, failures: 0 });
  scheduledJobs.editedArrival.mockResolvedValue({ scanned: 0, moved: 0, kept: 0, cleared: 0, failures: 0 });
  scheduledJobs.embeddedMedia.mockResolvedValue({ scanned: 0, reclaimed: 0, failed: 0 });
  scheduledJobs.trashPurge.mockResolvedValue({ scanned: 0, purged: 0, failed: 0 });
  scheduledJobs.digest.mockResolvedValue({ recipients: 0, sent: 0, empty: 0, released: 0, failed: 0, unknown: 0, skipped: 0 });
  consoleError.mockClear();
  consoleWarn.mockClear();
});

afterAll(() => {
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

describe("background scheduled Cron dispatch", () => {
  it("runs only the minute jobs for the every-minute trigger", async () => {
    await worker().scheduled(controller("* * * * *"));
    expect(scheduledJobs.deadline).toHaveBeenCalledOnce();
    expect(scheduledJobs.subtaskScan).toHaveBeenCalledOnce();
    expect(scheduledJobs.recovery).toHaveBeenCalledOnce();
    expect(scheduledJobs.editedArrival).toHaveBeenCalledOnce();
    expect(scheduledJobs.raw).not.toHaveBeenCalled();
    expect(scheduledJobs.stalled).not.toHaveBeenCalled();
    expect(scheduledJobs.subtasks).not.toHaveBeenCalled();
    expect(scheduledJobs.prune).not.toHaveBeenCalled();
    expect(scheduledJobs.digest).not.toHaveBeenCalled();
  });

  it("runs only the six hourly jobs for the hourly trigger, including minute zero", async () => {
    await worker().scheduled(controller("0 * * * *"));
    expect(scheduledJobs.deadline).not.toHaveBeenCalled();
    expect(scheduledJobs.subtaskScan).not.toHaveBeenCalled();
    expect(scheduledJobs.recovery).not.toHaveBeenCalled();
    expect(scheduledJobs.editedArrival).not.toHaveBeenCalled();
    expect(scheduledJobs.raw).toHaveBeenCalledOnce();
    expect(scheduledJobs.stalled).toHaveBeenCalledOnce();
    expect(scheduledJobs.subtasks).toHaveBeenCalledOnce();
    expect(scheduledJobs.digest).toHaveBeenCalledExactlyOnceWith(expect.anything(), 1_725_000_000_000);
    expect(scheduledJobs.prune).toHaveBeenCalledOnce();
    expect(scheduledJobs.trashPurge).toHaveBeenCalledExactlyOnceWith(expect.anything(), 1_725_000_000_000);
  });

  it.each([
    ["deadline", "* * * * *"],
    ["subtaskScan", "* * * * *"],
    ["recovery", "* * * * *"],
    ["manualPublish", "* * * * *"],
    ["editedArrival", "* * * * *"],
    ["raw", "0 * * * *"],
    ["stalled", "0 * * * *"],
    ["subtasks", "0 * * * *"],
    ["digest", "0 * * * *"],
    ["prune", "0 * * * *"],
    ["trashPurge", "0 * * * *"],
  ] as const)("isolates a failure in the %s job from its siblings", async (name, cron) => {
    scheduledJobs[name].mockRejectedValueOnce(new Error(`${name} failed`));
    await expect(worker().scheduled(controller(cron))).resolves.toBeUndefined();
    const siblings = cron === "* * * * *"
      ? [scheduledJobs.deadline, scheduledJobs.subtaskScan, scheduledJobs.recovery, scheduledJobs.manualPublish, scheduledJobs.editedArrival]
      : [scheduledJobs.raw, scheduledJobs.stalled, scheduledJobs.subtasks, scheduledJobs.digest, scheduledJobs.prune, scheduledJobs.trashPurge];
    for (const job of siblings) expect(job).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalled();
  });

  it("runs the manual publish stuck sweep for the every-minute trigger only", async () => {
    await worker().scheduled(controller("* * * * *"));
    expect(scheduledJobs.manualPublish).toHaveBeenCalledOnce();

    scheduledJobs.manualPublish.mockClear();
    await worker().scheduled(controller("0 * * * *"));
    expect(scheduledJobs.manualPublish).not.toHaveBeenCalled();
  });

  it("runs the Edited arrival pass with the scheduled instant, and with Editor automation off", async () => {
    await worker().scheduled(controller("* * * * *"));
    expect(scheduledJobs.editedArrival).toHaveBeenCalledWith(expect.anything(), 1_725_000_000_000);
  });

  it("runs the embedded media sweep once a day, on the hourly trigger at 19:00 UTC (03:00 Malaysia), and never on the minute trigger", async () => {
    const at = (hour: number) => ({ cron: "0 * * * *", scheduledTime: Date.UTC(2026, 9, 4, hour, 0), noRetry() {} }) as ScheduledController;
    for (let hour = 0; hour < 24; hour += 1) await worker().scheduled(at(hour));
    expect(scheduledJobs.embeddedMedia).toHaveBeenCalledOnce();
    expect(scheduledJobs.embeddedMedia).toHaveBeenCalledWith(expect.anything(), Date.UTC(2026, 9, 4, 19, 0));
    scheduledJobs.embeddedMedia.mockClear();
    await worker().scheduled({ cron: "* * * * *", scheduledTime: Date.UTC(2026, 9, 4, 19, 0), noRetry() {} } as ScheduledController);
    expect(scheduledJobs.embeddedMedia).not.toHaveBeenCalled();
  });

  it("isolates a failing embedded media sweep, and runs it after the other hourly jobs", async () => {
    scheduledJobs.embeddedMedia.mockRejectedValueOnce(new Error("sweep failed"));
    await expect(worker().scheduled({ cron: "0 * * * *", scheduledTime: Date.UTC(2026, 9, 4, 19, 0), noRetry() {} } as ScheduledController)).resolves.toBeUndefined();
    for (const job of [scheduledJobs.raw, scheduledJobs.stalled, scheduledJobs.subtasks, scheduledJobs.prune]) expect(job).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalled();
  });

  it("warns and runs nothing for an unrecognized trigger", async () => {
    await expect(worker().scheduled(controller("15 * * * *"))).resolves.toBeUndefined();
    for (const job of Object.values(scheduledJobs)) expect(job).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith("Ignored unknown Cron trigger", { cron: "15 * * * *" });
  });
});
