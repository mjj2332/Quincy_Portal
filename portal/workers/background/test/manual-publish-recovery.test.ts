import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isWorkflowInstanceNotFound,
  MANUAL_PUBLISH_STALE_MS,
  manualPublishFailureStatements,
  sweepStuckManualPublishes,
} from "../src/manual-publish-recovery";
import QuincyBackground from "../src";

declare const __PORTAL_MIGRATION_SQL__: string;

const database = env as unknown as { DB: D1Database };

async function executeSql(sql: string): Promise<void> {
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const withoutComments = chunk
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    for (const statement of withoutComments.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
});

// The sweep scans the whole `jobs` table, and several tests deliberately leave a job still
// `queued`/`running` (the "skip" cases). Reset every table the fixtures touch before each test so
// a leftover aged row from one test cannot be re-swept by the next. Children first — `jobs` and
// `assets` are both referenced by other rows in this suite's fixtures.
beforeEach(async () => {
  for (const table of ["audit_log", "jobs", "assets", "collections", "projects"]) {
    await database.DB.exec(`DELETE FROM ${table};`);
  }
});

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const AGED_UPDATED_AT = NOW - MANUAL_PUBLISH_STALE_MS - 60_000;
const FRESH_UPDATED_AT = NOW - 60_000;

type JobKind = "manual_edited_publish" | "manual_raw_publish";

async function insertManualPublishFixture(options: {
  jobKind: JobKind;
  assetPublishStatus: "pending" | "ready" | "failed";
  jobStatus?: "queued" | "running";
  updatedAt?: number;
}): Promise<{ projectId: string; collectionId: string; assetId: string; jobId: string }> {
  const projectId = crypto.randomUUID();
  const collectionId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const collectionKind = options.jobKind === "manual_raw_publish" ? "raw" : "edited";
  const jobStatus = options.jobStatus ?? "running";
  const updatedAt = options.updatedAt ?? AGED_UPDATED_AT;
  await database.DB.batch([
    database.DB.prepare(
      "INSERT INTO projects (id, street, stage_key, raw_folder_path, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?, ?)",
    ).bind(projectId, `Sweep fixture ${assetId}`, `/Tonomo/Raw Files/Terry/2026-07-24/${assetId}`, NOW, NOW),
    database.DB.prepare(
      "INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, ?, 'empty', 0, ?, ?)",
    ).bind(collectionId, projectId, collectionKind, NOW, NOW),
    database.DB.prepare(
      "INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, publish_status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'upload', ?, ?, ?)",
    ).bind(assetId, collectionId, `tests/${assetId}.jpg`, "manual.jpg", options.assetPublishStatus, NOW, NOW),
    database.DB.prepare(
      "INSERT INTO jobs (id, kind, status, project_id, correlation_id, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      jobId,
      options.jobKind,
      jobStatus,
      projectId,
      `${options.jobKind}:${assetId}`,
      JSON.stringify({ projectId, assetId, collection: collectionKind }),
      NOW,
      updatedAt,
    ),
  ]);
  return { projectId, collectionId, assetId, jobId };
}

async function jobRow(jobId: string) {
  return database.DB.prepare("SELECT status, error, updated_at FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ status: string; error: string | null; updated_at: number }>();
}

async function assetRow(assetId: string) {
  return database.DB.prepare("SELECT publish_status FROM assets WHERE id = ?")
    .bind(assetId)
    .first<{ publish_status: string }>();
}

async function auditRows(action: string, targetId: string) {
  return database.DB.prepare("SELECT meta_json FROM audit_log WHERE action = ? AND target_id = ?")
    .bind(action, targetId)
    .all<{ meta_json: string }>();
}

function fakeWorkflow(get: (id: string) => Promise<{ status(): Promise<{ status: string }> }>) {
  return { DB: database.DB, MANUAL_EDITED_PUBLISH_WORKFLOW: { get } } as never as Parameters<typeof sweepStuckManualPublishes>[0];
}

describe("isWorkflowInstanceNotFound", () => {
  it("is true only when instance.not_found appears somewhere in the cause chain", () => {
    expect(isWorkflowInstanceNotFound(new Error("instance.not_found"))).toBe(true);
    expect(isWorkflowInstanceNotFound(new Error("outer failure", { cause: new Error("instance.not_found") }))).toBe(true);
    expect(isWorkflowInstanceNotFound(new Error("network down"))).toBe(false);
    expect(isWorkflowInstanceNotFound("instance.not_found")).toBe(false);
    expect(isWorkflowInstanceNotFound(undefined)).toBe(false);
  });
});

describe("sweepStuckManualPublishes", () => {
  it.each(["errored", "terminated", "complete"] as const)(
    "recovers an aged edited job whose Workflow instance reports %s",
    async (workflowStatus) => {
      const { assetId, jobId } = await insertManualPublishFixture({ jobKind: "manual_edited_publish", assetPublishStatus: "pending" });
      const result = await sweepStuckManualPublishes(fakeWorkflow(async () => ({ status: async () => ({ status: workflowStatus }) })), NOW);

      expect(result).toEqual({ scanned: 1, recovered: 1, skipped: 0 });
      await expect(jobRow(jobId)).resolves.toMatchObject({ status: "stuck", error: expect.stringContaining(`workflow_${workflowStatus}`) });
      await expect(assetRow(assetId)).resolves.toEqual({ publish_status: "failed" });
      const rows = await auditRows("asset.manual_publish.failed", assetId);
      expect(rows.results).toHaveLength(1);
    },
  );

  it("recovers an aged raw job whose Workflow instance reports terminated, leaving the asset row untouched", async () => {
    const { assetId, jobId } = await insertManualPublishFixture({ jobKind: "manual_raw_publish", assetPublishStatus: "ready" });
    const result = await sweepStuckManualPublishes(fakeWorkflow(async () => ({ status: async () => ({ status: "terminated" }) })), NOW);

    expect(result).toEqual({ scanned: 1, recovered: 1, skipped: 0 });
    await expect(jobRow(jobId)).resolves.toMatchObject({ status: "stuck", error: expect.stringContaining("workflow_terminated") });
    await expect(assetRow(assetId)).resolves.toEqual({ publish_status: "ready" });
    const rows = await auditRows("asset.manual_raw_mirror.failed", assetId);
    expect(rows.results).toHaveLength(1);
  });

  it("marks an aged edited job stuck without an audit row when its asset is already ready", async () => {
    const { assetId, jobId } = await insertManualPublishFixture({ jobKind: "manual_edited_publish", assetPublishStatus: "ready" });
    const result = await sweepStuckManualPublishes(fakeWorkflow(async () => ({ status: async () => ({ status: "complete" }) })), NOW);

    expect(result).toEqual({ scanned: 1, recovered: 1, skipped: 0 });
    await expect(jobRow(jobId)).resolves.toMatchObject({ status: "stuck" });
    await expect(assetRow(assetId)).resolves.toEqual({ publish_status: "ready" });
    const rows = await auditRows("asset.manual_publish.failed", assetId);
    expect(rows.results).toHaveLength(0);
  });

  it.each(["queued", "running", "paused", "waiting", "waitingForPause", "unknown"] as const)(
    "leaves an aged job untouched while its Workflow instance still reports %s",
    async (workflowStatus) => {
      const { assetId, jobId } = await insertManualPublishFixture({ jobKind: "manual_edited_publish", assetPublishStatus: "pending" });
      const before = await jobRow(jobId);
      const result = await sweepStuckManualPublishes(fakeWorkflow(async () => ({ status: async () => ({ status: workflowStatus }) })), NOW);

      expect(result).toEqual({ scanned: 1, recovered: 0, skipped: 1 });
      await expect(jobRow(jobId)).resolves.toEqual(before);
      await expect(assetRow(assetId)).resolves.toEqual({ publish_status: "pending" });
      const rows = await auditRows("asset.manual_publish.failed", assetId);
      expect(rows.results).toHaveLength(0);
    },
  );

  it("never checks a job that has not been stale for the full window", async () => {
    const get = vi.fn(async () => ({ status: async () => ({ status: "terminated" }) }));
    const { jobId } = await insertManualPublishFixture({
      jobKind: "manual_raw_publish",
      assetPublishStatus: "ready",
      updatedAt: FRESH_UPDATED_AT,
    });

    const result = await sweepStuckManualPublishes(fakeWorkflow(get), NOW);

    expect(result).toEqual({ scanned: 0, recovered: 0, skipped: 0 });
    expect(get).not.toHaveBeenCalled();
    await expect(jobRow(jobId)).resolves.toMatchObject({ status: "running" });
  });

  it("recovers a queued job whose Workflow instance lookup throws instance.not_found", async () => {
    const { assetId, jobId } = await insertManualPublishFixture({
      jobKind: "manual_edited_publish",
      assetPublishStatus: "pending",
      jobStatus: "queued",
    });

    const result = await sweepStuckManualPublishes(fakeWorkflow(async () => {
      throw new Error("instance.not_found");
    }), NOW);

    expect(result).toEqual({ scanned: 1, recovered: 1, skipped: 0 });
    await expect(jobRow(jobId)).resolves.toMatchObject({ status: "stuck", error: expect.stringContaining("workflow_not_found") });
    await expect(assetRow(assetId)).resolves.toEqual({ publish_status: "failed" });
  });

  it("skips a row whose Workflow lookup throws an unrelated error, and still recovers a later row in the same page", async () => {
    const first = await insertManualPublishFixture({ jobKind: "manual_edited_publish", assetPublishStatus: "pending", updatedAt: AGED_UPDATED_AT - 2000 });
    const second = await insertManualPublishFixture({ jobKind: "manual_edited_publish", assetPublishStatus: "pending", updatedAt: AGED_UPDATED_AT - 1000 });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const get = vi.fn(async (id: string) => {
      if (id === first.jobId) throw new Error("network down");
      return { status: async () => ({ status: "errored" }) };
    });
    const result = await sweepStuckManualPublishes(fakeWorkflow(get), NOW);

    expect(result).toEqual({ scanned: 2, recovered: 1, skipped: 1 });
    await expect(jobRow(first.jobId)).resolves.toMatchObject({ status: "running" });
    await expect(jobRow(second.jobId)).resolves.toMatchObject({ status: "stuck" });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("skips a not-found row whose recovery itself fails, and still recovers a later row in the same page", async () => {
    const broken = await insertManualPublishFixture({ jobKind: "manual_edited_publish", assetPublishStatus: "pending", updatedAt: AGED_UPDATED_AT - 2000 });
    const healthy = await insertManualPublishFixture({ jobKind: "manual_edited_publish", assetPublishStatus: "pending", updatedAt: AGED_UPDATED_AT - 1000 });
    await database.DB.prepare("UPDATE jobs SET payload_json = '{not json' WHERE id = ?").bind(broken.jobId).run();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await sweepStuckManualPublishes(fakeWorkflow(async () => {
      throw new Error("instance.not_found");
    }), NOW);

    expect(result).toEqual({ scanned: 2, recovered: 1, skipped: 1 });
    await expect(jobRow(broken.jobId)).resolves.toMatchObject({ status: "running", updated_at: AGED_UPDATED_AT - 2000 });
    await expect(assetRow(broken.assetId)).resolves.toEqual({ publish_status: "pending" });
    await expect(jobRow(healthy.jobId)).resolves.toMatchObject({ status: "stuck" });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("leaves everything untouched when the job or asset row changes underneath the status() call", async () => {
    const edited = await insertManualPublishFixture({ jobKind: "manual_edited_publish", assetPublishStatus: "pending" });
    const raced = await insertManualPublishFixture({ jobKind: "manual_edited_publish", assetPublishStatus: "pending", updatedAt: AGED_UPDATED_AT - 1000 });

    const get = vi.fn(async (id: string) => ({
      status: async () => {
        if (id === edited.jobId) {
          await database.DB.prepare("UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?").bind(NOW, edited.jobId).run();
        } else if (id === raced.jobId) {
          await database.DB.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").bind(NOW, raced.jobId).run();
        }
        return { status: "errored" };
      },
    }));
    const result = await sweepStuckManualPublishes(fakeWorkflow(get), NOW);

    expect(result).toEqual({ scanned: 2, recovered: 0, skipped: 2 });
    await expect(jobRow(edited.jobId)).resolves.toMatchObject({ status: "done" });
    await expect(assetRow(edited.assetId)).resolves.toEqual({ publish_status: "pending" });
    await expect(auditRows("asset.manual_publish.failed", edited.assetId)).resolves.toMatchObject({ results: [] });

    await expect(jobRow(raced.jobId)).resolves.toMatchObject({ status: "running", updated_at: NOW });
    await expect(assetRow(raced.assetId)).resolves.toEqual({ publish_status: "pending" });
    await expect(auditRows("asset.manual_publish.failed", raced.assetId)).resolves.toMatchObject({ results: [] });
  });

  it("checks at most 25 Workflow instances even when 30 jobs are aged", async () => {
    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await insertManualPublishFixture({ jobKind: "manual_edited_publish", assetPublishStatus: "pending", updatedAt: AGED_UPDATED_AT - i * 1000 });
    }
    const get = vi.fn(async () => ({ status: async () => ({ status: "running" }) }));

    const result = await sweepStuckManualPublishes(fakeWorkflow(get), NOW);

    expect(result).toEqual({ scanned: 25, recovered: 0, skipped: 25 });
    expect(get).toHaveBeenCalledTimes(25);
  });
});

describe("manualPublishFailureStatements replay", () => {
  // A duplicate delivery of the same sweep (same scheduledTime) builds an identical batch. Its job
  // CAS changes nothing, so it must not touch an asset a retry has since reset, nor re-audit.
  it.each(["edited", "raw"] as const)("a replayed %s batch whose job transition changes nothing writes nothing else", async (collectionKind) => {
    const { projectId, assetId, jobId } = await insertManualPublishFixture({
      jobKind: collectionKind === "raw" ? "manual_raw_publish" : "manual_edited_publish",
      assetPublishStatus: "pending",
    });
    const input = {
      jobId, projectId, assetId, collectionKind, status: "stuck" as const, error: "workflow_errored: replay",
      meta: {}, now: NOW, expectedJobStatus: "running", expectedJobUpdatedAt: AGED_UPDATED_AT,
    };
    await database.DB.batch(manualPublishFailureStatements(database.DB, input));
    // An operator retry resets the Edited asset for a new attempt between the two deliveries.
    await database.DB.prepare("UPDATE assets SET publish_status = 'pending' WHERE id = ?").bind(assetId).run();

    await database.DB.batch(manualPublishFailureStatements(database.DB, input));

    await expect(jobRow(jobId)).resolves.toMatchObject({ status: "stuck", updated_at: NOW });
    await expect(assetRow(assetId)).resolves.toEqual({ publish_status: "pending" });
    const action = collectionKind === "raw" ? "asset.manual_raw_mirror.failed" : "asset.manual_publish.failed";
    await expect(auditRows(action, assetId)).resolves.toMatchObject({ results: [expect.anything()] });
  });
});

describe("sweepStuckManualPublishes page rotation", () => {
  it("eventually reaches a dead instance behind more than a page of aged live ones", async () => {
    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await insertManualPublishFixture({ jobKind: "manual_edited_publish", assetPublishStatus: "pending", updatedAt: AGED_UPDATED_AT - 10_000 - i * 1000 });
    }
    const dead = await insertManualPublishFixture({ jobKind: "manual_edited_publish", assetPublishStatus: "pending" });
    const get = async (id: string) => ({ status: async () => ({ status: id === dead.jobId ? "errored" : "running" }) });

    // Each sweep leaves out 6 of 31 rows; the chance a given row is left out 20 times running is ~1e-14.
    for (let sweep = 0; sweep < 20; sweep += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await sweepStuckManualPublishes(fakeWorkflow(get), NOW + sweep * 60_000);
      expect(result.scanned).toBe(25);
      if (result.recovered === 1) break;
    }

    await expect(jobRow(dead.jobId)).resolves.toMatchObject({ status: "stuck" });
  });
});

describe("retry after a sweep-recovered stuck job", () => {
  function service(create: (input: { id: string; params: unknown }) => Promise<unknown>) {
    return new QuincyBackground(
      {} as ExecutionContext,
      { DB: database.DB, MANUAL_EDITED_PUBLISH_WORKFLOW: { create } } as never,
    );
  }

  it("starts a new job for a stuck pending asset and leaves it pending, exactly as a failed job would", async () => {
    const { projectId, assetId, jobId } = await insertManualPublishFixture({ jobKind: "manual_edited_publish", assetPublishStatus: "pending" });
    await sweepStuckManualPublishes(fakeWorkflow(async () => ({ status: async () => ({ status: "errored" }) })), NOW);
    await expect(jobRow(jobId)).resolves.toMatchObject({ status: "stuck" });

    const started: { id: string; params: unknown }[] = [];
    const result = await service(async (input) => { started.push(input); }).publishManualUpload(projectId, assetId);

    expect(result.jobId).not.toBe(jobId);
    expect(started).toEqual([{ id: result.jobId, params: { projectId, assetId, jobId: result.jobId } }]);
    await expect(assetRow(assetId)).resolves.toEqual({ publish_status: "pending" });
  });

  it("starts a new job for a stuck ready asset and leaves it ready, exactly as a failed job would", async () => {
    const { projectId, assetId, jobId } = await insertManualPublishFixture({ jobKind: "manual_edited_publish", assetPublishStatus: "ready" });
    await sweepStuckManualPublishes(fakeWorkflow(async () => ({ status: async () => ({ status: "complete" }) })), NOW);
    await expect(jobRow(jobId)).resolves.toMatchObject({ status: "stuck" });

    const started: { id: string; params: unknown }[] = [];
    const result = await service(async (input) => { started.push(input); }).publishManualUpload(projectId, assetId);

    expect(result.jobId).not.toBe(jobId);
    expect(started).toEqual([{ id: result.jobId, params: { projectId, assetId, jobId: result.jobId } }]);
    await expect(assetRow(assetId)).resolves.toEqual({ publish_status: "ready" });
  });
});

describe("sweepStuckManualPublishes against the real Workflows binding", () => {
  it("recovers a job whose Workflow instance was terminated out from under it", async () => {
    const { projectId, assetId, jobId } = await insertManualPublishFixture({ jobKind: "manual_raw_publish", assetPublishStatus: "ready", jobStatus: "queued" });
    const realEnv = env as unknown as { DB: D1Database; MANUAL_EDITED_PUBLISH_WORKFLOW: Workflow<unknown> };

    await realEnv.MANUAL_EDITED_PUBLISH_WORKFLOW.create({ id: jobId, params: { projectId, assetId, jobId } });
    const instance = await realEnv.MANUAL_EDITED_PUBLISH_WORKFLOW.get(jobId);
    await instance.terminate();
    await expect(instance.status()).resolves.toMatchObject({ status: "terminated" });
    // The instance may have run its first step before termination; re-age whatever it left.
    await database.DB.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").bind(AGED_UPDATED_AT, jobId).run();

    const result = await sweepStuckManualPublishes(realEnv, NOW);

    expect(result).toEqual({ scanned: 1, recovered: 1, skipped: 0 });
    await expect(jobRow(jobId)).resolves.toMatchObject({ status: "stuck", error: expect.stringContaining("workflow_terminated") });
  });
});
