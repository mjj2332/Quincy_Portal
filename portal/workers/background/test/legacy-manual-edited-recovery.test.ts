import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import QuincyBackground from "../src";

const database = env as unknown as { DB: D1Database };
declare const __PORTAL_MIGRATION_SQL__: string;

type WorkflowInput = { id: string; params: { projectId: string; assetId: string; jobId: string } };

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

async function insertAsset(patch: Partial<{ publishStatus: string; sourcePath: string | null; source: string; collectionKind: string; archived: boolean; withRendition: boolean; rawFolderPath: string | null }> = {}) {
  const projectId = crypto.randomUUID(), collectionId = crypto.randomUUID(), assetId = crypto.randomUUID(), now = Date.now();
  const values = { publishStatus: "ready", sourcePath: null, source: "upload", collectionKind: "edited", archived: false, withRendition: false, rawFolderPath: "/RAW/Legacy listing", ...patch };
  await database.DB.batch([
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, raw_folder_path, archived_at, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?, ?, ?)").bind(projectId, assetId, values.rawFolderPath, values.archived ? now : null, now, now),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, ?, 'empty', 0, ?, ?)").bind(collectionId, projectId, values.collectionKind, now, now),
    database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, publish_status, source_path, created_at, updated_at) VALUES (?, ?, ?, 'legacy.jpg', 1, ?, ?, ?, ?, ?)").bind(assetId, collectionId, `test/${assetId}`, values.source, values.publishStatus, values.sourcePath, now, now),
  ]);
  if (values.withRendition) await database.DB.prepare("INSERT INTO asset_renditions (id, asset_id, variant, r2_key, bytes, content_type, width, height, spec_version, created_at) VALUES (?, ?, 'thumb', ?, 1, 'image/webp', 1, 1, 'v1', ?)").bind(crypto.randomUUID(), assetId, `rendition/${assetId}`, now).run();
  return { projectId, assetId };
}

function service(
  create: (input: WorkflowInput) => Promise<unknown>,
  appEnv = "development",
  allowProductionRecovery?: string,
) {
  return new QuincyBackground({} as ExecutionContext, {
    DB: database.DB,
    APP_ENV: appEnv,
    ALLOW_PRODUCTION_LEGACY_MANUAL_EDITED_RECOVERY: allowProductionRecovery,
    LEGACY_MANUAL_EDITED_RECOVERY_WORKFLOW: { create },
  } as never);
}

describe("legacy manual Edited recovery RPC", () => {
  it("queues every requested strict candidate as a batch", async () => {
    const one = await insertAsset(), two = await insertAsset(); const started: WorkflowInput[] = [];
    const result = await service(async (input) => { started.push(input); }).recoverLegacyManualEditedAssets({ assetIds: [one.assetId, two.assetId] });
    expect(result.jobIds).toHaveLength(2); expect(started.map((item) => item.params.assetId).sort()).toEqual([one.assetId, two.assetId].sort());
  });

  it("rejects a mixed batch before creating any job", async () => {
    const valid = await insertAsset(), invalid = await insertAsset({ sourcePath: "/already/published.jpg" });
    await expect(service(async () => {}).recoverLegacyManualEditedAssets({ assetIds: [valid.assetId, invalid.assetId] })).rejects.toThrow("strict legacy manual Edited recovery predicate");
    await expect(database.DB.prepare("SELECT count(*) AS count FROM jobs WHERE project_id = ?").bind(valid.projectId).first<{ count: number }>()).resolves.toEqual({ count: 0 });
  });

  it("requires the deployment flag before accepting production confirmation", async () => {
    const asset = await insertAsset();
    await expect(service(async () => {}, "production").recoverLegacyManualEditedAssets({ assetIds: [asset.assetId], confirmProduction: true })).rejects.toThrow("ALLOW_PRODUCTION_LEGACY_MANUAL_EDITED_RECOVERY=1");
  });

  it("requires explicit production confirmation even with the deployment flag", async () => {
    const asset = await insertAsset();
    await expect(service(async () => {}, "production", "1").recoverLegacyManualEditedAssets({ assetIds: [asset.assetId] })).rejects.toThrow("confirmProduction: true");
  });
});
