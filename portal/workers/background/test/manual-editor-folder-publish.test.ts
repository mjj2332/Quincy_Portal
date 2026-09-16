import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/dropbox/client", () => ({
  createFolder: vi.fn(),
  upload: vi.fn(),
}));

import type { Env } from "../src/env";
import { createFolder, upload, type DropboxFile } from "../src/dropbox/client";
import { ManualEditedPublish } from "../src/workflows/manual-edited-publish";

declare const __PORTAL_MIGRATION_SQL__: string;

const database = env as unknown as { DB: D1Database; MEDIA: R2Bucket };

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const statements = chunk
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    for (const statement of statements) await database.DB.exec(`${statement};`);
  }
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createFolder).mockResolvedValue(undefined);
  vi.mocked(upload).mockResolvedValue({
    ".tag": "file",
    id: "id:manual-upload",
    name: "manual.jpg",
    path_lower: "/editor/manual.jpg",
    size: 4,
  } satisfies DropboxFile);
});

function directStep(after?: (name: string) => Promise<void>) {
  return {
    do: async (name: string, callback: () => Promise<unknown>) => {
      const result = await callback();
      await after?.(name);
      return result;
    },
    sleep: async () => undefined,
  };
}

function workflow(envForRun: Env): ManualEditedPublish {
  const instance = Object.create(ManualEditedPublish.prototype) as ManualEditedPublish;
  Object.defineProperty(instance, "env", { value: envForRun, writable: true });
  return instance;
}

async function fixture(options: { mappingState?: "pending" | "ready" | "needs_review"; withLegacyPath?: boolean; collectionKind?: "raw" | "edited" } = {}) {
  const now = Date.now();
  const projectId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const mappingId = crypto.randomUUID();
  const collectionId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const root = `/Editor/01_ACTIVE EDITS/2026-10 October/02/${projectId}`;
  const inputRoot = `${root}/Input`;
  const outputRoot = `${root}/Output`;
  const legacyRoot = `/Tonomo/Raw Files/${projectId}`;
  const mappingState = options.mappingState ?? "ready";
  const collectionKind = options.collectionKind ?? "raw";
  const jobKind = collectionKind === "raw" ? "manual_raw_publish" : "manual_edited_publish";
  const assetPublishStatus = collectionKind === "raw" ? "ready" : "pending";
  await database.DB.batch([
    database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, raw_folder_path, created_at, updated_at) VALUES (?, 'Mapped manual publication', 'awaiting_raw', ?, ?, ?)").bind(projectId, options.withLegacyPath ? legacyRoot : null, now, now),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, ?, 'empty', 0, ?, ?)").bind(collectionId, projectId, collectionKind, now, now),
    database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, source_path, publish_status, created_at, updated_at) VALUES (?, ?, ?, 'manual.jpg', 4, 'upload', NULL, ?, ?, ?)").bind(assetId, collectionId, `tests/${assetId}.jpg`, assetPublishStatus, now, now),
    database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, correlation_id, payload_json, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)").bind(jobId, jobKind, projectId, `${jobKind}:${assetId}`, JSON.stringify({ projectId, assetId }), now, now),
    database.DB.prepare("INSERT INTO editor_folder_mappings (id, project_id, connection_id, root_path, root_path_key, root_folder_id, shoot_date, project_folder_name, photographer_evidence_json, input_roots_json, output_roots_json, editing_notes_path, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'id:root', '2026-10-02', ?, '{}', ?, ?, ?, ?, ?, ?)").bind(
      mappingId,
      projectId,
      connectionId,
      root,
      root.toLowerCase(),
      projectId,
      JSON.stringify([{ path: inputRoot, section: null, folderId: "id:input" }]),
      JSON.stringify([{ path: outputRoot, section: null, folderId: "id:output" }]),
      `${root}/Editing Notes`,
      mappingState,
      now,
      now,
    ),
  ]);
  await database.MEDIA.put(`tests/${assetId}.jpg`, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { httpMetadata: { contentType: "image/jpeg" } });
  const localEnv = {
    DB: database.DB,
    MEDIA: database.MEDIA,
    DROPBOX_EDITOR_AUTOMATION_ENABLED: "1",
    RENDITIONS_ENABLED: false,
  } as unknown as Env;
  return { projectId, connectionId, mappingId, collectionId, assetId, jobId, inputRoot, outputRoot, legacyRoot, localEnv };
}

async function tableExists(name: string): Promise<boolean> {
  const row = await database.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(name)
    .first<{ name: string }>();
  return row?.name === name;
}

describe("legacy manual Dropbox publication compatibility", () => {
  it("publishes a RAW upload when Editor automation is disabled before the mapping table exists", async () => {
    const data = await fixture({ withLegacyPath: true });
    const legacyEnv = { ...data.localEnv, DROPBOX_EDITOR_AUTOMATION_ENABLED: "0" } as Env;
    const renamedTable = "editor_folder_mappings_legacy_publish_regression";
    const destination = `${data.legacyRoot}/Manual-Uploads/manual.jpg`;

    await expect(tableExists("editor_folder_mappings")).resolves.toBe(true);
    await database.DB.exec(`ALTER TABLE editor_folder_mappings RENAME TO ${renamedTable};`);
    try {
      await expect(tableExists("editor_folder_mappings")).resolves.toBe(false);
      await workflow(legacyEnv).run({ payload: { projectId: data.projectId, assetId: data.assetId, jobId: data.jobId }, timestamp: new Date(), instanceId: "legacy-manual-test", workflowName: "manual-edited-publish" }, directStep() as never);
    } finally {
      await database.DB.exec(`ALTER TABLE ${renamedTable} RENAME TO editor_folder_mappings;`);
    }

    await expect(tableExists("editor_folder_mappings")).resolves.toBe(true);
    expect(createFolder).toHaveBeenCalledTimes(1);
    expect(createFolder.mock.calls[0]?.[2]).toBe(`${data.legacyRoot}/Manual-Uploads`);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[2]).toBe(destination);
    await expect(database.DB.prepare("SELECT source_path FROM assets WHERE id = ?").bind(data.assetId).first())
      .resolves.toEqual({ source_path: destination });
    await expect(database.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(data.jobId).first())
      .resolves.toEqual({ status: "done" });
  });
});

describe("mapped manual Dropbox publication", () => {
  it("publishes a RAW upload to mapped Input/Manual-Uploads without a legacy path", async () => {
    const data = await fixture();
    await workflow(data.localEnv).run({ payload: { projectId: data.projectId, assetId: data.assetId, jobId: data.jobId }, timestamp: new Date(), instanceId: "mapped-manual-test", workflowName: "manual-edited-publish" }, directStep() as never);

    const destination = `${data.inputRoot}/Manual-Uploads/${data.assetId}/manual.jpg`;
    expect(createFolder).toHaveBeenCalledTimes(2);
    expect(createFolder.mock.calls.map((call) => call[2])).toEqual([
      `${data.inputRoot}/Manual-Uploads`,
      `${data.inputRoot}/Manual-Uploads/${data.assetId}`,
    ]);
    expect(createFolder.mock.calls.every((call) => call[3] === data.connectionId)).toBe(true);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[2]).toBe(destination);
    expect(upload.mock.calls[0]?.[4]).toBe(data.connectionId);
    await expect(database.DB.prepare("SELECT source_path FROM assets WHERE id = ?").bind(data.assetId).first())
      .resolves.toEqual({ source_path: destination });
    await expect(database.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(data.jobId).first())
      .resolves.toEqual({ status: "done" });
  });

  it("refuses a cached legacy destination after the Editor mapping becomes ready", async () => {
    const data = await fixture({ mappingState: "pending", withLegacyPath: true });
    const steps = directStep(async (name) => {
      if (name === "resolve-manual-destination") {
        await database.DB.prepare("UPDATE editor_folder_mappings SET state = 'ready' WHERE id = ?").bind(data.mappingId).run();
      }
    });

    await expect(workflow(data.localEnv).run({ payload: { projectId: data.projectId, assetId: data.assetId, jobId: data.jobId }, timestamp: new Date(), instanceId: "cached-legacy-destination", workflowName: "manual-edited-publish" }, steps as never))
      .rejects.toThrow(/mapping .* changed before manual publishing/i);
    expect(createFolder).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    await expect(database.DB.prepare("SELECT source_path FROM assets WHERE id = ?").bind(data.assetId).first())
      .resolves.toEqual({ source_path: null });
    await expect(database.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(data.jobId).first())
      .resolves.toEqual({ status: "failed" });
  });

  it("does not commit a legacy RAW mirror when the mapping becomes ready after Dropbox accepts it", async () => {
    const data = await fixture({ mappingState: "pending", withLegacyPath: true });
    const steps = directStep(async (name) => {
      if (name === "publish-manual-upload") {
        await database.DB.prepare("UPDATE editor_folder_mappings SET state = 'ready' WHERE id = ?").bind(data.mappingId).run();
      }
    });

    await expect(workflow(data.localEnv).run({ payload: { projectId: data.projectId, assetId: data.assetId, jobId: data.jobId }, timestamp: new Date(), instanceId: "legacy-publish-cutover", workflowName: "manual-edited-publish" }, steps as never))
      .rejects.toThrow(/could not record its Dropbox mirror/i);
    expect(createFolder).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    await expect(database.DB.prepare("SELECT source_path FROM assets WHERE id = ?").bind(data.assetId).first())
      .resolves.toEqual({ source_path: null });
    await expect(database.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(data.jobId).first())
      .resolves.toEqual({ status: "failed" });
  });
});

describe("mapped manual Dropbox publication: move in progress (#153)", () => {
  const movingMessage = (projectId: string) => `Editor folder for project ${projectId} is moving; manual publishing resumes after the move`;

  async function markMoving(mappingId: string) {
    await database.DB.prepare("UPDATE editor_folder_mappings SET move_status = 'moving', move_token = 'test-token', move_expires_at = ? WHERE id = ?")
      .bind(Date.now() + 10 * 60 * 1000, mappingId).run();
  }

  it("refuses to resolve a destination while the Editor folder is already moving", async () => {
    const data = await fixture();
    await markMoving(data.mappingId);

    await expect(workflow(data.localEnv).run({ payload: { projectId: data.projectId, assetId: data.assetId, jobId: data.jobId }, timestamp: new Date(), instanceId: "moving-manual-test", workflowName: "manual-edited-publish" }, directStep() as never))
      .rejects.toThrow(movingMessage(data.projectId));
    expect(createFolder).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    await expect(database.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(data.jobId).first())
      .resolves.toEqual({ status: "failed" });
  });

  it("fails an in-flight publish (not left pending) when the mapping starts moving before folder creation", async () => {
    const data = await fixture({ collectionKind: "edited" });
    const steps = directStep(async (name) => {
      if (name === "resolve-manual-destination") await markMoving(data.mappingId);
    });

    await expect(workflow(data.localEnv).run({ payload: { projectId: data.projectId, assetId: data.assetId, jobId: data.jobId }, timestamp: new Date(), instanceId: "moving-mid-run", workflowName: "manual-edited-publish" }, steps as never))
      .rejects.toThrow(movingMessage(data.projectId));
    expect(createFolder).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    await expect(database.DB.prepare("SELECT publish_status FROM assets WHERE id = ?").bind(data.assetId).first())
      .resolves.toEqual({ publish_status: "failed" });
    await expect(database.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(data.jobId).first())
      .resolves.toEqual({ status: "failed" });
  });

  it("blocks the final promotion write (not left pending) when the mapping starts moving after Dropbox accepts the upload", async () => {
    const data = await fixture({ collectionKind: "edited" });
    const steps = directStep(async (name) => {
      if (name === "publish-manual-upload") await markMoving(data.mappingId);
    });

    await expect(workflow(data.localEnv).run({ payload: { projectId: data.projectId, assetId: data.assetId, jobId: data.jobId }, timestamp: new Date(), instanceId: "moving-after-upload", workflowName: "manual-edited-publish" }, steps as never))
      .rejects.toThrow(/could not be published/);
    expect(upload).toHaveBeenCalledTimes(1);
    await expect(database.DB.prepare("SELECT publish_status FROM assets WHERE id = ?").bind(data.assetId).first())
      .resolves.toEqual({ publish_status: "failed" });
    await expect(database.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(data.jobId).first())
      .resolves.toEqual({ status: "failed" });
  });

  it("resolves the moved mapping's new root on a later publish attempt", async () => {
    const data = await fixture({ collectionKind: "edited" });
    const newRoot = `/Editor/01_ACTIVE EDITS/2026-11 November/05/${data.projectId}`;
    // Simulate a move that already landed: root/output rebased, move_status cleared.
    await database.DB.prepare(
      "UPDATE editor_folder_mappings SET root_path = ?, root_path_key = ?, input_roots_json = ?, output_roots_json = ?, shoot_date = '2026-11-05' WHERE id = ?",
    ).bind(
      newRoot, newRoot.toLowerCase(),
      JSON.stringify([{ path: `${newRoot}/Input`, section: null, folderId: "id:input" }]),
      JSON.stringify([{ path: `${newRoot}/Output`, section: null, folderId: "id:output" }]),
      data.mappingId,
    ).run();

    await workflow(data.localEnv).run({ payload: { projectId: data.projectId, assetId: data.assetId, jobId: data.jobId }, timestamp: new Date(), instanceId: "post-move-retry", workflowName: "manual-edited-publish" }, directStep() as never).catch(() => undefined);

    const destination = `${newRoot}/Output/Manual-Uploads/${data.assetId}/manual.jpg`;
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[2]).toBe(destination);
    await expect(database.DB.prepare("SELECT publish_status, source_path FROM assets WHERE id = ?").bind(data.assetId).first())
      .resolves.toEqual({ publish_status: "ready", source_path: destination });
  });
});
