import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { LegacyManualEditedRecovery } from "../src/workflows/legacy-manual-edited-recovery";

declare const __PORTAL_MIGRATION_SQL__: string;
const database = env as unknown as { DB: D1Database; MEDIA: R2Bucket };

type FixturePatch = Partial<{
  archived: boolean;
  source: string;
  sourcePath: string | null;
  withRendition: boolean;
}>;

type DropboxUpload = {
  path: string;
  body: ReadableStream<Uint8Array>;
};

async function executeSql(sql: string): Promise<void> {
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const withoutComments = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of withoutComments.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

beforeAll(async () => executeSql(__PORTAL_MIGRATION_SQL__));

async function fixture(patch: FixturePatch = {}) {
  const projectId = crypto.randomUUID();
  const collectionId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const now = Date.now();
  const values = { archived: false, source: "upload", sourcePath: null, withRendition: false, ...patch };
  const r2Key = `workflow-tests/${assetId}.jpg`;
  const jobId = crypto.randomUUID();

  await database.DB.batch([
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, raw_folder_path, archived_at, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', '/RAW/Legacy listing', ?, ?, ?)").bind(projectId, assetId, values.archived ? now : null, now, now),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'edited', 'empty', 0, ?, ?)").bind(collectionId, projectId, now, now),
    database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, publish_status, source_path, created_at, updated_at) VALUES (?, ?, ?, 'legacy.jpg', 3, ?, 'ready', ?, ?, ?)").bind(assetId, collectionId, r2Key, values.source, values.sourcePath, now, now),
    database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, correlation_id, payload_json, retries, created_at, updated_at) VALUES (?, 'legacy_manual_edited_recovery', 'queued', ?, ?, ?, 0, ?, ?)").bind(jobId, projectId, `legacy_manual_edited_recovery:${assetId}`, JSON.stringify({ projectId, assetId }), now, now),
  ]);
  if (values.withRendition) {
    await database.DB.prepare("INSERT INTO asset_renditions (id, asset_id, variant, r2_key, bytes, content_type, width, height, spec_version, created_at) VALUES (?, ?, 'thumb', ?, 1, 'image/webp', 1, 1, 'v1', ?)").bind(crypto.randomUUID(), assetId, `rendition/${assetId}`, now).run();
  }
  await database.MEDIA.put(r2Key, new Uint8Array([1, 2, 3]));
  return { projectId, assetId, jobId };
}

function step() {
  return { do: async <T>(_name: string, callback: () => Promise<T>) => callback() };
}

function workflow(overrides: Record<string, unknown> = {}) {
  const uploads: DropboxUpload[] = [];
  const queuedAssetIds: string[] = [];
  const instance = Object.create(LegacyManualEditedRecovery.prototype) as LegacyManualEditedRecovery & {
    env: Record<string, unknown>;
    uploadToDropbox: (env: unknown, db: unknown, path: string, body: ReadableStream<Uint8Array>) => Promise<unknown>;
  };
  Object.assign(instance, {
    env: {
      DB: database.DB,
      MEDIA: database.MEDIA,
      RENDITIONS_ENABLED: true,
      RENDITION_QUEUE: { send: async (message: { assetId: string }) => { queuedAssetIds.push(message.assetId); } },
      ...overrides,
    },
    uploadToDropbox: async (_env: unknown, _db: unknown, path: string, body: ReadableStream<Uint8Array>) => {
      uploads.push({ path, body });
      return { ".tag": "file", name: "legacy.jpg", path_lower: path.toLowerCase(), id: "id:test", size: 3 };
    },
  });
  return { instance, uploads, queuedAssetIds };
}

async function run(instance: LegacyManualEditedRecovery, data: Awaited<ReturnType<typeof fixture>>) {
  return instance.run({ payload: { projectId: data.projectId, assetId: data.assetId, jobId: data.jobId } } as never, step() as never);
}

async function asset(assetId: string) {
  return database.DB.prepare("SELECT publish_status, source_path FROM assets WHERE id = ?").bind(assetId).first<{ publish_status: string; source_path: string | null }>();
}

async function job(jobId: string) {
  return database.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
}

async function auditCount(assetId: string) {
  const row = await database.DB.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE target_id = ?").bind(assetId).first<{ count: number }>();
  return row?.count ?? 0;
}

describe("LegacyManualEditedRecovery workflow", () => {
  it.each([
    ["a non-object payload", null, "must be an object"],
    ["an array payload", [], "must be an object"],
    ["a missing projectId", { assetId: "asset", jobId: "job" }, "projectId"],
    ["a missing assetId", { projectId: "project", jobId: "job" }, "assetId"],
    ["a missing jobId", { projectId: "project", assetId: "asset" }, "jobId"],
    ["a non-string projectId", { projectId: 1, assetId: "asset", jobId: "job" }, "projectId"],
    ["a non-string assetId", { projectId: "project", assetId: 1, jobId: "job" }, "assetId"],
    ["a blank jobId", { projectId: "project", assetId: "asset", jobId: "  " }, "jobId"],
  ])("rejects %s before any job, audit, or upload write", async (_label, payload, error) => {
    const data = await fixture();
    const { instance, uploads, queuedAssetIds } = workflow();
    const noWriteStep = { do: async () => { throw new Error("Workflow step must not run for malformed input"); } };

    await expect(instance.run({ payload } as never, noWriteStep as never)).rejects.toThrow(error);

    expect(uploads).toHaveLength(0);
    expect(queuedAssetIds).toEqual([]);
    await expect(job(data.jobId)).resolves.toEqual({ status: "queued" });
    await expect(auditCount(data.assetId)).resolves.toBe(0);
  });

  it("copies to the deterministic Dropbox overwrite path, repairs source_path, and queues renditions", async () => {
    const data = await fixture();
    const { instance, uploads, queuedAssetIds } = workflow();
    const destination = `/AutoHDR/Legacy listing/Manual-Uploads/${data.assetId}/legacy.jpg`;

    await run(instance, data);

    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.path).toBe(destination);
    await expect(new Response(uploads[0]?.body).bytes()).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(queuedAssetIds).toEqual([data.assetId]);
    await expect(asset(data.assetId)).resolves.toEqual({ publish_status: "ready", source_path: destination });
    await expect(job(data.jobId)).resolves.toEqual({ status: "done" });
  });

  it.each([
    ["archived project", { archived: true }],
    ["existing source path", { sourcePath: "/already/published.jpg" }],
    ["existing rendition", { withRendition: true }],
    ["non-upload source", { source: "dropbox" }],
  ] as const)("refuses %s predicate conflicts without copying or overwriting linkage", async (_label, patch) => {
    const data = await fixture(patch);
    const { instance, uploads } = workflow();

    await expect(run(instance, data)).rejects.toThrow("strict legacy manual Edited recovery predicate");

    expect(uploads).toHaveLength(0);
    await expect(asset(data.assetId)).resolves.toMatchObject({ publish_status: "ready", source_path: patch.sourcePath ?? null });
    await expect(job(data.jobId)).resolves.toEqual({ status: "failed" });
  });

  it("preserves ready state and repaired source path if rendition enqueue fails", async () => {
    const data = await fixture();
    const { instance, uploads } = workflow({
      RENDITION_QUEUE: { send: async () => { throw new Error("queue unavailable"); } },
    });
    const destination = `/AutoHDR/Legacy listing/Manual-Uploads/${data.assetId}/legacy.jpg`;

    await expect(run(instance, data)).rejects.toThrow("Rendition queue handoff failed");

    expect(uploads).toHaveLength(1);
    await expect(asset(data.assetId)).resolves.toEqual({ publish_status: "ready", source_path: destination });
    await expect(job(data.jobId)).resolves.toEqual({ status: "failed" });
  });

  it("replay writes the same deterministic Dropbox destination", async () => {
    const data = await fixture();
    const first = workflow();
    const destination = `/AutoHDR/Legacy listing/Manual-Uploads/${data.assetId}/legacy.jpg`;

    await run(first.instance, data);
    expect(first.uploads).toHaveLength(1);
    expect(first.uploads[0]?.path).toBe(destination);

    await database.DB.prepare("UPDATE assets SET source_path = NULL WHERE id = ?").bind(data.assetId).run();
    await database.DB.prepare("DELETE FROM asset_renditions WHERE asset_id = ?").bind(data.assetId).run();
    await database.DB.prepare("UPDATE jobs SET status = 'queued' WHERE id = ?").bind(data.jobId).run();

    const replay = workflow();
    await run(replay.instance, data);

    expect(replay.uploads).toHaveLength(1);
    expect(replay.uploads[0]?.path).toBe(destination);
    await expect(asset(data.assetId)).resolves.toEqual({ publish_status: "ready", source_path: destination });
    await expect(job(data.jobId)).resolves.toEqual({ status: "done" });
  });
});
