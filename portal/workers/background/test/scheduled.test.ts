import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const scheduledJobs = vi.hoisted(() => ({
  deadline: vi.fn(),
  recovery: vi.fn(),
  manualPublish: vi.fn(),
  raw: vi.fn(),
  editedArrival: vi.fn(),
  stalled: vi.fn(),
  subtaskScan: vi.fn(),
  subtasks: vi.fn(),
  prune: vi.fn(),
  embeddedMedia: vi.fn(),
  trashPurge: vi.fn(),
  digest: vi.fn(),
  guestDigest: vi.fn(),
  guestSweep: vi.fn(),
  jobRetention: vi.fn(),
  // The four jobs the old every-minute branch ran that this file did not mock: with them unmocked they threw on `{}`, so the
  // old error assertion could never fail (docs/lessons.md, "A grep gate that cannot fail is not a gate").
  extUpload: vi.fn(),
  videoUpload: vi.fn(),
  rolePurge: vi.fn(),
  renditionRecovery: vi.fn(),
  objectCrc: vi.fn(),
  // The Editor recovery pieces.
  initialSync: vi.fn(),
  moveRecovery: vi.fn(),
  enqueueEditor: vi.fn(),
  connection: vi.fn(),
  kick: vi.fn(),
  triggerSync: vi.fn(),
}));
vi.mock("../src/lib/job-retention", () => ({ pruneJobHistory: scheduledJobs.jobRetention }));
vi.mock("../src/embedded-media-sweep", () => ({ sweepEmbeddedMedia: scheduledJobs.embeddedMedia }));
vi.mock("../src/video-trash-purge", () => ({ purgeVideoTrash: scheduledJobs.trashPurge }));
vi.mock("../src/external-upload-sweep", () => ({ sweepExternalEditedUploads: scheduledJobs.extUpload }));
vi.mock("../src/video-upload-sweep", () => ({ sweepVideoUploads: scheduledJobs.videoUpload }));
vi.mock("../src/external-role-cache-purge", () => ({ processExternalRoleCachePurges: scheduledJobs.rolePurge }));
vi.mock("../src/embedded-display-recovery", () => ({ recoverEmbeddedRenditions: scheduledJobs.renditionRecovery }));
vi.mock("../src/object-crc-sweep", () => ({ sweepObjectCrcs: scheduledJobs.objectCrc }));
vi.mock("../src/editor-folders/recovery-queries", () => ({
  editorInitialSyncRecoveryQuery: scheduledJobs.initialSync,
  editorMoveRecoveryQuery: scheduledJobs.moveRecovery,
}));
vi.mock("../src/editor-folders/queue", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/editor-folders/queue")>(),
  enqueueEditorReconcile: scheduledJobs.enqueueEditor,
}));
vi.mock("../src/dropbox/connection", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/dropbox/connection")>(),
  canonicalDropboxConnectionId: scheduledJobs.connection,
}));
// `dbFor` feeds the rotating Editor page (a select) and the initial-sync rotation (an update); both are awaited chains.
vi.mock("../src/lib/db", async (importOriginal) => {
  const rows = [{ id: "page-project" }];
  const select = () => {
    const chain: Record<string, unknown> = {};
    for (const step of ["from", "where"]) chain[step] = () => chain;
    chain.orderBy = async () => rows;
    return chain;
  };
  const update = () => ({ set: () => ({ where: async () => undefined }) });
  return { ...await importOriginal<typeof import("../src/lib/db")>(), dbFor: () => ({ select, update }) };
});
vi.mock("@quincy/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@quincy/db")>(),
  boardSchemaVariant: vi.fn().mockResolvedValue("current"),
}));

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
vi.mock("../src/guest-digest", () => ({ runGuestDigests: scheduledJobs.guestDigest, sweepGuestDigests: scheduledJobs.guestSweep }));
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
vi.spyOn(console, "log").mockImplementation(() => undefined);

const NOW = 1_725_000_000_000;
const HALF_HOUR = "*/30 * * * *";
const HOURLY = "0 * * * *";
// The guest session sweep batches straight onto `env.DB`.
const dbStub = { prepare: () => ({ bind: () => ({}) }), batch: async () => [] };

function worker(editorAutomation = false): QuincyBackground {
  const env = { DB: dbStub, ...(editorAutomation ? { DROPBOX_EDITOR_AUTOMATION_ENABLED: "1", DROPBOX_SYNC: { getByName: () => ({ kick: scheduledJobs.kick }) } } : {}) };
  const instance = new QuincyBackground({} as ExecutionContext, env as never);
  vi.spyOn(instance, "triggerEditorSync").mockImplementation(scheduledJobs.triggerSync);
  return instance;
}

function controller(cron: string, scheduledTime = NOW): ScheduledController {
  return { cron, scheduledTime, noRetry() {} } as ScheduledController;
}

type Job = keyof typeof scheduledJobs;

/** Every task of the 30-minute tier, with the log line its own try/catch writes when it throws. */
const HALF_HOUR_JOBS = {
  deadline: "Project Deadline occurrence scan failed",
  subtaskScan: "Subtask reminder occurrence scan failed",
  rolePurge: "External role cache purge failed",
  editedArrival: "Edited arrival reconciliation failed",
  recovery: "Notification outbox recovery scan failed",
} as const satisfies Partial<Record<Job, string>>;

/** The hourly tier outside the Editor automation flag. */
const HOURLY_JOBS = {
  renditionRecovery: "Embedded display recovery failed",
  manualPublish: "Manual publish stuck sweep failed",
  extUpload: "External upload sweep failed",
  videoUpload: "Video upload sweep failed",
  raw: "RAW reconciliation scan failed",
  stalled: "AutoHDR stalled notification scan failed",
  subtasks: "Subtask reminder reconcile failed",
  digest: "Email digest run failed",
  guestSweep: "Guest digest sweep failed",
  guestDigest: "Guest digest run failed",
  prune: "Notification pruning failed",
  jobRetention: "Job history retention failed",
  trashPurge: "Video Trash purge failed",
  objectCrc: "Object CRC sweep failed",
} as const satisfies Partial<Record<Job, string>>;

/** The hourly Editor recovery, behind the automation flag. */
const EDITOR_JOBS = {
  initialSync: "Editor initial sync recovery failed",
  moveRecovery: "Editor folder move recovery failed",
  connection: "Editor reconciliation recovery failed",
} as const satisfies Partial<Record<Job, string>>;

const errorLines = () => consoleError.mock.calls.map(([line]) => line);

beforeEach(() => {
  for (const job of Object.values(scheduledJobs)) job.mockReset().mockResolvedValue(undefined);
  scheduledJobs.triggerSync.mockResolvedValue({ jobId: "job" });
  scheduledJobs.deadline.mockResolvedValue({ scanned: 0, fired: 0, published: 0 });
  scheduledJobs.subtaskScan.mockResolvedValue({ scanned: 0, fired: 0, published: 0 });
  scheduledJobs.manualPublish.mockResolvedValue({ scanned: 0, recovered: 0, skipped: 0 });
  scheduledJobs.raw.mockResolvedValue({ attempted: 0, advanced: 0, skipped: 0, failures: 0 });
  scheduledJobs.editedArrival.mockResolvedValue({ scanned: 0, moved: 0, kept: 0, cleared: 0, failures: 0 });
  scheduledJobs.embeddedMedia.mockResolvedValue({ scanned: 0, reclaimed: 0, failed: 0 });
  scheduledJobs.trashPurge.mockResolvedValue({ scanned: 0, purged: 0, failed: 0 });
  scheduledJobs.digest.mockResolvedValue({ recipients: 0, sent: 0, empty: 0, released: 0, failed: 0, unknown: 0, skipped: 0 });
  scheduledJobs.guestDigest.mockResolvedValue({ candidates: 0, claimed: 0, sent: 0, dropped: 0, failed: 0, skipped: false });
  scheduledJobs.jobRetention.mockResolvedValue({ deleted: 0 });
  scheduledJobs.extUpload.mockResolvedValue({ scanned: 0, reclaimed: 0, reopened: 0 });
  scheduledJobs.videoUpload.mockResolvedValue({ scanned: 0, reclaimed: 0 });
  scheduledJobs.rolePurge.mockResolvedValue(0);
  scheduledJobs.renditionRecovery.mockResolvedValue({ resent: 0, failed: 0 });
  scheduledJobs.objectCrc.mockResolvedValue({ candidates: 0, queued: 0 });
  scheduledJobs.initialSync.mockResolvedValue([]);
  scheduledJobs.moveRecovery.mockResolvedValue([]);
  scheduledJobs.connection.mockResolvedValue("connection");
  consoleError.mockClear();
  consoleWarn.mockClear();
});

afterAll(() => {
  consoleError.mockRestore();
  consoleWarn.mockRestore();
});

describe("background scheduled Cron dispatch", () => {
  it("runs exactly the five 30-minute jobs for the half-hour trigger and none of the hourly work", async () => {
    await worker(true).scheduled(controller(HALF_HOUR));
    for (const name of Object.keys(HALF_HOUR_JOBS)) expect(scheduledJobs[name as Job], name).toHaveBeenCalledOnce();
    for (const name of [...Object.keys(HOURLY_JOBS), ...Object.keys(EDITOR_JOBS), "enqueueEditor", "kick", "triggerSync", "embeddedMedia"]) {
      expect(scheduledJobs[name as Job], name).not.toHaveBeenCalled();
    }
    expect(errorLines()).toEqual([]);
  });

  it("passes the scheduled instant to the 30-minute jobs", async () => {
    await worker().scheduled(controller(HALF_HOUR));
    for (const name of Object.keys(HALF_HOUR_JOBS)) expect(scheduledJobs[name as Job], name).toHaveBeenCalledWith(expect.anything(), NOW);
  });

  it("runs the hourly jobs exactly once for the hourly trigger, including minute zero, and none of the 30-minute work", async () => {
    await worker(true).scheduled(controller(HOURLY));
    for (const name of [...Object.keys(HOURLY_JOBS), "initialSync", "moveRecovery", "connection"]) {
      expect(scheduledJobs[name as Job], name).toHaveBeenCalledOnce();
    }
    for (const name of Object.keys(HALF_HOUR_JOBS)) expect(scheduledJobs[name as Job], name).not.toHaveBeenCalled();
    expect(scheduledJobs.embeddedMedia).not.toHaveBeenCalled();
    expect(scheduledJobs.digest).toHaveBeenCalledExactlyOnceWith(expect.anything(), NOW);
    // The client hourly digest (#741 15b): swept first so stale news is never mailed, then flushed, both at the scheduled instant.
    expect(scheduledJobs.guestSweep).toHaveBeenCalledExactlyOnceWith(dbStub, NOW);
    expect(scheduledJobs.guestDigest).toHaveBeenCalledExactlyOnceWith(expect.anything(), NOW);
    expect(scheduledJobs.guestSweep.mock.invocationCallOrder[0]).toBeLessThan(scheduledJobs.guestDigest.mock.invocationCallOrder[0]!);
    // Job history retention: every hour (not gated on the Editor automation flag), at the scheduled instant.
    expect(scheduledJobs.jobRetention).toHaveBeenCalledExactlyOnceWith(dbStub, NOW);
    expect(scheduledJobs.trashPurge).toHaveBeenCalledExactlyOnceWith(expect.anything(), NOW);
    expect(errorLines()).toEqual([]);
  });

  it("runs the recovery tier first, then the rotating Editor page before initial-sync and move recovery, then the existing hourly work", async () => {
    scheduledJobs.initialSync.mockResolvedValue([{ projectId: "stale-sync" }]);
    scheduledJobs.moveRecovery.mockResolvedValue([{ projectId: "due-move" }]);
    await worker(true).scheduled(controller(HOURLY));
    const order = (job: Job, call = 0) => scheduledJobs[job].mock.invocationCallOrder[call]!;
    // enqueueEditor: call 0 is the rotating page's candidate, call 1 is the move-recovery row.
    expect(scheduledJobs.enqueueEditor.mock.calls.map(([, projectId]) => projectId)).toEqual(["page-project", "due-move"]);
    expect(scheduledJobs.triggerSync).toHaveBeenCalledOnce();
    for (const early of ["renditionRecovery", "manualPublish", "extUpload", "videoUpload"] as const) {
      expect(order(early), early).toBeLessThan(order("enqueueEditor", 0));
    }
    expect(order("enqueueEditor", 0)).toBeLessThan(order("kick"));
    expect(order("kick")).toBeLessThan(order("initialSync"));
    expect(order("initialSync")).toBeLessThan(order("triggerSync"));
    expect(order("triggerSync")).toBeLessThan(order("moveRecovery"));
    expect(order("moveRecovery")).toBeLessThan(order("enqueueEditor", 1));
    for (const late of ["jobRetention", "raw", "stalled", "subtasks", "digest", "guestSweep", "guestDigest", "prune", "trashPurge", "objectCrc"] as const) {
      expect(order("enqueueEditor", 1), late).toBeLessThan(order(late));
    }
  });

  it("leaves the Editor recovery out of the hourly tier while Editor automation is off, and runs everything else", async () => {
    await worker(false).scheduled(controller(HOURLY));
    for (const name of ["initialSync", "moveRecovery", "connection", "enqueueEditor", "kick", "triggerSync"]) {
      expect(scheduledJobs[name as Job], name).not.toHaveBeenCalled();
    }
    for (const name of Object.keys(HOURLY_JOBS)) expect(scheduledJobs[name as Job], name).toHaveBeenCalledOnce();
  });

  it.each(Object.entries(HALF_HOUR_JOBS))("isolates a failure in the %s job from its siblings on the half-hour tier", async (name, message) => {
    scheduledJobs[name as Job].mockRejectedValueOnce(new Error(`${name} failed`));
    await expect(worker(true).scheduled(controller(HALF_HOUR))).resolves.toBeUndefined();
    for (const sibling of Object.keys(HALF_HOUR_JOBS)) expect(scheduledJobs[sibling as Job], sibling).toHaveBeenCalledOnce();
    expect(errorLines()).toEqual([message]);
  });

  it.each([...Object.entries(HOURLY_JOBS), ...Object.entries(EDITOR_JOBS)])("isolates a failure in the %s job from its siblings on the hourly tier", async (name, message) => {
    scheduledJobs[name as Job].mockRejectedValueOnce(new Error(`${name} failed`));
    await expect(worker(true).scheduled(controller(HOURLY))).resolves.toBeUndefined();
    for (const sibling of [...Object.keys(HOURLY_JOBS), "initialSync", "moveRecovery"]) {
      expect(scheduledJobs[sibling as Job], sibling).toHaveBeenCalledOnce();
    }
    expect(errorLines()).toEqual([message]);
  });

  it("runs the manual publish stuck sweep on the hourly trigger only", async () => {
    await worker().scheduled(controller(HALF_HOUR));
    expect(scheduledJobs.manualPublish).not.toHaveBeenCalled();
    await worker().scheduled(controller(HOURLY));
    expect(scheduledJobs.manualPublish).toHaveBeenCalledOnce();
  });

  it("runs the Edited arrival pass on the half-hour trigger with the scheduled instant, and with Editor automation off", async () => {
    await worker(false).scheduled(controller(HALF_HOUR));
    expect(scheduledJobs.editedArrival).toHaveBeenCalledWith(expect.anything(), NOW);
    scheduledJobs.editedArrival.mockClear();
    await worker(false).scheduled(controller(HOURLY));
    expect(scheduledJobs.editedArrival).not.toHaveBeenCalled();
  });

  it("runs the embedded media sweep once a day, on the hourly trigger at 19:00 UTC (03:00 Malaysia), and never on the half-hour trigger", async () => {
    const at = (hour: number) => controller(HOURLY, Date.UTC(2026, 9, 4, hour, 0));
    for (let hour = 0; hour < 24; hour += 1) await worker().scheduled(at(hour));
    expect(scheduledJobs.embeddedMedia).toHaveBeenCalledOnce();
    expect(scheduledJobs.embeddedMedia).toHaveBeenCalledWith(expect.anything(), Date.UTC(2026, 9, 4, 19, 0));
    scheduledJobs.embeddedMedia.mockClear();
    await worker().scheduled(controller(HALF_HOUR, Date.UTC(2026, 9, 4, 19, 0)));
    await worker().scheduled(controller(HALF_HOUR, Date.UTC(2026, 9, 4, 19, 30)));
    expect(scheduledJobs.embeddedMedia).not.toHaveBeenCalled();
  });

  it("isolates a failing embedded media sweep, and runs it after the other hourly jobs", async () => {
    scheduledJobs.embeddedMedia.mockRejectedValueOnce(new Error("sweep failed"));
    await expect(worker().scheduled(controller(HOURLY, Date.UTC(2026, 9, 4, 19, 0)))).resolves.toBeUndefined();
    for (const job of [scheduledJobs.raw, scheduledJobs.stalled, scheduledJobs.subtasks, scheduledJobs.prune]) expect(job).toHaveBeenCalledOnce();
    expect(errorLines()).toEqual(["Embedded media sweep failed"]);
  });

  it.each(["* * * * *", "15 * * * *", "*/15 * * * *"])("warns and runs nothing for the unrecognized trigger %s", async (cron) => {
    await expect(worker(true).scheduled(controller(cron))).resolves.toBeUndefined();
    for (const [name, job] of Object.entries(scheduledJobs)) expect(job, name).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith("Ignored unknown Cron trigger", { cron });
  });
});
