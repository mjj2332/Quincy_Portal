import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import QuincyBackground from "../src";
import { enqueueManualEditedRenditions } from "../src/manual-edited-renditions";

declare const __PORTAL_MIGRATION_SQL__: string;

const database = env as unknown as { DB: D1Database };

type WorkflowInput = {
  id: string;
  params: { projectId: string; assetId: string; jobId: string };
};
type WorkflowBinding = { create(input: WorkflowInput): Promise<unknown> };

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

async function insertManualAsset(publishStatus: "pending" | "ready") {
  const projectId = crypto.randomUUID();
  const collectionId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare(
      "INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?)",
    ).bind(projectId, `Manual publication ${assetId}`, now, now),
    database.DB.prepare(
      "INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'edited', 'empty', 0, ?, ?)",
    ).bind(collectionId, projectId, now, now),
    database.DB.prepare(
      "INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, publish_status, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'upload', ?, ?, ?)",
    ).bind(assetId, collectionId, `tests/${assetId}.jpg`, "manual.jpg", publishStatus, now, now),
  ]);
  return { projectId, assetId };
}

async function insertFailedHandoff(projectId: string, assetId: string) {
  const now = Date.now();
  await database.DB.prepare(
    "INSERT INTO jobs (id, kind, status, project_id, correlation_id, payload_json, error, created_at, updated_at) VALUES (?, 'manual_edited_publish', 'failed', ?, ?, ?, 'rendition handoff failed', ?, ?)",
  ).bind(
    crypto.randomUUID(),
    projectId,
    `manual_edited_publish:${assetId}`,
    JSON.stringify({ projectId, assetId }),
    now,
    now,
  ).run();
}

function service(create: WorkflowBinding["create"]) {
  return new QuincyBackground(
    {} as ExecutionContext,
    { DB: database.DB, MANUAL_EDITED_PUBLISH_WORKFLOW: { create } } as never,
  );
}

async function assetStatus(assetId: string) {
  return database.DB.prepare("SELECT publish_status FROM assets WHERE id = ?")
    .bind(assetId)
    .first<{ publish_status: string }>();
}

async function job(jobId: string) {
  return database.DB.prepare("SELECT id, status FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<{ id: string; status: string }>();
}

async function latestFailedJobId(projectId: string, assetId: string): Promise<string> {
  const latest = await database.DB.prepare(
    "SELECT id FROM jobs WHERE project_id = ? AND correlation_id = ? AND status = 'failed' ORDER BY created_at DESC, id DESC LIMIT 1",
  ).bind(projectId, `manual_edited_publish:${assetId}`).first<{ id: string }>();
  expect(latest).toBeDefined();
  return latest!.id;
}

describe("manual edited publication retries", () => {
  it("keeps a ready asset ready and fails its new job when retry workflow creation rejects", async () => {
    const { projectId, assetId } = await insertManualAsset("ready");
    await insertFailedHandoff(projectId, assetId);

    await expect(service(async () => {
      throw new Error("workflow unavailable");
    }).publishManualEditedUpload(projectId, assetId)).rejects.toThrow("workflow unavailable");

    await expect(assetStatus(assetId)).resolves.toEqual({ publish_status: "ready" });
    await expect(job(await latestFailedJobId(projectId, assetId))).resolves.toMatchObject({ status: "failed" });
  });

  it("marks a pending asset failed with its job when workflow creation rejects", async () => {
    const { projectId, assetId } = await insertManualAsset("pending");

    await expect(service(async () => {
      throw new Error("workflow unavailable");
    }).publishManualEditedUpload(projectId, assetId)).rejects.toThrow("workflow unavailable");

    await expect(assetStatus(assetId)).resolves.toEqual({ publish_status: "failed" });
    await expect(job(await latestFailedJobId(projectId, assetId))).resolves.toMatchObject({ status: "failed" });
  });

  it("starts a new workflow after a prior failed ready handoff", async () => {
    const { projectId, assetId } = await insertManualAsset("ready");
    await insertFailedHandoff(projectId, assetId);
    const started: WorkflowInput[] = [];

    const result = await service(async (input) => {
      started.push(input);
    }).publishManualEditedUpload(projectId, assetId);

    expect(started).toEqual([{
      id: result.jobId,
      params: { projectId, assetId, jobId: result.jobId },
    }]);
    await expect(assetStatus(assetId)).resolves.toEqual({ publish_status: "ready" });
    await expect(job(result.jobId)).resolves.toEqual({ id: result.jobId, status: "queued" });
  });

  it("fails rather than completing publication when rendition enqueue is unavailable", async () => {
    await expect(
      enqueueManualEditedRenditions({ RENDITIONS_ENABLED: false } as never, crypto.randomUUID()),
    ).rejects.toThrow("Rendition queue handoff failed");
  });
});
