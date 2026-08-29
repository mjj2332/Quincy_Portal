import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/dropbox/client", () => ({
  copyBatch: vi.fn(),
  copyBatchCheck: vi.fn(),
  createFolder: vi.fn(),
  deleteBatch: vi.fn(),
  deleteBatchCheck: vi.fn(),
  getMetadata: vi.fn(),
  isDropboxPathNotFound: vi.fn(),
  listFolderContinue: vi.fn(),
  listFolderIfExists: vi.fn(),
  upload: vi.fn(),
}));

import { claimAutoHdrHandoff } from "../src/autohdr/claims";
import { copyBatch, createFolder, listFolderIfExists, upload } from "../src/dropbox/client";
import type { Env } from "../src/env";
import { AutoHdrSend, type AutoHdrInput } from "../src/workflows/autohdr";

declare const __PORTAL_MIGRATION_SQL__: string;
const database = env as unknown as { DB: D1Database; MEDIA: R2Bucket };

async function executeSql(source: string) {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'");
});
beforeEach(() => vi.clearAllMocks());

async function round() {
  const now = Date.now();
  const connectionId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const collectionId = crypto.randomUUID();
  const assetIds = [crypto.randomUUID(), crypto.randomUUID()];
  await database.DB.batch([
    database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Admin', ?, 1, 'admin', 1, ?, ?)").bind(userId, `${userId}@test.invalid`, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, raw_folder_path, created_at, updated_at) VALUES (?, 'Run wiring', 'raw_review', ?, ?, ?)")
      .bind(projectId, `/Tonomo/Raw Files/Studio/${projectId}`, now, now),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'received', 2, ?, ?)").bind(collectionId, projectId, now, now),
    database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)")
      .bind(assetIds[0], collectionId, `tests/${assetIds[0]}.jpg`, "copy.jpg", "dropbox", `/Tonomo/Raw Files/Studio/${projectId}/copy.jpg`, now, now),
    database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'upload', ?, ?)")
      .bind(assetIds[1], collectionId, `tests/${assetIds[1]}.jpg`, "fallback.jpg", now, now),
    ...assetIds.map((assetId) => database.DB.prepare("INSERT INTO selections (id, asset_id, selected_by, state, created_at) VALUES (?, ?, ?, 'selected_for_editing', ?)")
      .bind(crypto.randomUUID(), assetId, userId, now)),
  ]);

  const localEnv = { DB: database.DB, MEDIA: database.MEDIA } as unknown as Env;
  const owner = await claimAutoHdrHandoff(localEnv, projectId, userId);
  const handoff = await database.DB.prepare("SELECT connection_id, generation FROM autohdr_handoffs WHERE id = ?")
    .bind(owner.handoffId).first<{ connection_id: string; generation: number }>();
  await database.DB.batch([
    // This fixture pre-positions the project as an already-entered destination. Keep the
    // board revision and handoff entry token aligned so the confirmation recheck can prove
    // that identity instead of treating this as a tokenless stage jump.
    database.DB.prepare("UPDATE projects SET stage_key = 'editing_autohdr', board_revision = 5 WHERE id = ?").bind(projectId),
    database.DB.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").bind(owner.jobId),
    database.DB.prepare("UPDATE autohdr_handoffs SET state = 'started', editing_entry_board_revision = 5 WHERE id = ?").bind(owner.handoffId),
    database.DB.prepare("UPDATE autohdr_output_mappings SET state = 'active' WHERE handoff_id = ?").bind(owner.handoffId),
    database.DB.prepare("UPDATE autohdr_path_claims SET state = 'active' WHERE handoff_id = ?").bind(owner.handoffId),
  ]);
  return {
    localEnv,
    input: {
      projectId,
      assetIds,
      jobId: owner.jobId,
      handoffId: owner.handoffId,
      connectionId: handoff!.connection_id,
      mappingGeneration: handoff!.generation,
      initiatedBy: userId,
    } satisfies AutoHdrInput,
  };
}

function workflow(envForRun: Env) {
  const instance = Object.create(AutoHdrSend.prototype) as AutoHdrSend;
  Object.defineProperty(instance, "env", { value: envForRun, writable: true });
  return instance;
}

function directStep(onAfter?: (name: string) => Promise<void>) {
  return {
    do: async (name: string, callback: () => Promise<unknown>) => {
      const result = await callback();
      await onAfter?.(name);
      return result;
    },
    sleep: async () => undefined,
  };
}

describe("AutoHdrSend.run orchestration", () => {
  it("records both copy-loop and fallback-loop writes through the real run method", async () => {
    const { localEnv, input } = await round();
    vi.mocked(createFolder).mockResolvedValue(undefined);
    vi.mocked(listFolderIfExists).mockResolvedValue({ entries: [], has_more: false, cursor: "empty" } as never);
    vi.mocked(copyBatch).mockResolvedValue({ ".tag": "complete", entries: [{ ".tag": "success" }] } as never);
    vi.mocked(upload).mockResolvedValue({ ".tag": "file", id: "id:fallback", name: "fallback.jpg", path_lower: "/autohdr/run/fallback.jpg", size: 1 } as never);
    await database.MEDIA.put(`tests/${input.assetIds[1]}.jpg`, new Uint8Array([1]));

    await workflow(localEnv).run({ payload: input, timestamp: new Date(), instanceId: "run-test", workflowName: "autohdr" }, directStep() as never);

    expect(copyBatch).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    const sent = await database.DB.prepare("SELECT asset_id, dropbox_path FROM autohdr_sent_files WHERE handoff_id = ? ORDER BY asset_id")
      .bind(input.handoffId).all();
    // Row order follows the query's ORDER BY asset_id (a random UUID per test run), not
    // insertion order, so the expected pairs must be sorted the same way rather than assumed.
    expect(sent.results).toEqual([
      { asset_id: input.assetIds[0], dropbox_path: expect.stringContaining("/copy.jpg") },
      { asset_id: input.assetIds[1], dropbox_path: expect.stringContaining("/fallback.jpg") },
    ].sort((a, b) => a.asset_id.localeCompare(b.asset_id)));
  });

  it("stops copy and upload work when the handoff retires between transfer steps", async () => {
    const { localEnv, input } = await round();
    const calls: string[] = [];
    vi.mocked(createFolder).mockResolvedValue(undefined);
    vi.mocked(listFolderIfExists).mockResolvedValue({ entries: [], has_more: false, cursor: "empty" } as never);
    vi.mocked(copyBatch).mockImplementation(async () => {
      calls.push("copy");
      return { ".tag": "complete", entries: [{ ".tag": "success" }] } as never;
    });
    vi.mocked(upload).mockImplementation(async () => {
      calls.push("upload");
      return { ".tag": "file", id: "id:fallback", name: "fallback.jpg", path_lower: "/autohdr/run/fallback.jpg", size: 1 } as never;
    });
    await database.MEDIA.put(`tests/${input.assetIds[1]}.jpg`, new Uint8Array([1]));

    await workflow(localEnv).run(
      { payload: input, timestamp: new Date(), instanceId: "run-retire-mid-step", workflowName: "autohdr" },
      directStep(async (name) => {
        if (name === "record-sent-files") {
          calls.push("retire");
          await database.DB.prepare("UPDATE autohdr_handoffs SET state = 'retired' WHERE id = ?").bind(input.handoffId).run();
        }
      }) as never,
    );

    expect(calls).toEqual(["copy", "retire"]);
    const sent = await database.DB.prepare("SELECT asset_id FROM autohdr_sent_files WHERE handoff_id = ?")
      .bind(input.handoffId).all();
    expect(sent.results).toEqual([{ asset_id: input.assetIds[0] }]);
  });

  it("continues an idempotent legacy guard miss when the project is already editing", async () => {
    const { localEnv, input } = await round();
    const legacyInput = { ...input, handoffId: undefined, connectionId: undefined, mappingGeneration: undefined, initiatedBy: undefined };
    vi.mocked(createFolder).mockResolvedValue(undefined);
    vi.mocked(listFolderIfExists).mockResolvedValue({ entries: [], has_more: false, cursor: "empty" } as never);
    vi.mocked(copyBatch).mockResolvedValue({ ".tag": "complete", entries: [{ ".tag": "success" }] } as never);
    vi.mocked(upload).mockResolvedValue({ ".tag": "file", id: "id:fallback", name: "fallback.jpg", path_lower: "/autohdr/run/fallback.jpg", size: 1 } as never);
    // assetIds[0] has a Dropbox source_path (goes via copyBatch); assetIds[1] is an "upload"
    // source with no source_path (goes via the fallback R2-read-then-upload path) — the
    // continuing Workflow processes both, so both transfer paths' fixtures are needed here,
    // matching the "records both copy-loop and fallback-loop writes" test's setup.
    await database.MEDIA.put(`tests/${input.assetIds[1]}.jpg`, new Uint8Array([1]));
    await workflow(localEnv).run({ payload: legacyInput, timestamp: new Date(), instanceId: "legacy-idempotent", workflowName: "autohdr" }, directStep() as never);
    expect(copyBatch).toHaveBeenCalled();
  });

  it("throws on a stale legacy guard miss and does not start the transfer", async () => {
    const { localEnv, input } = await round();
    const legacyInput = { ...input, handoffId: undefined, connectionId: undefined, mappingGeneration: undefined, initiatedBy: undefined };
    await database.DB.prepare("UPDATE projects SET stage_key = 'edited_review' WHERE id = ?").bind(input.projectId).run();
    await expect(workflow(localEnv).run({ payload: legacyInput, timestamp: new Date(), instanceId: "legacy-stale", workflowName: "autohdr" }, directStep() as never)).rejects.toThrow("stage guard");
    expect(copyBatch).not.toHaveBeenCalled();
  });
});
