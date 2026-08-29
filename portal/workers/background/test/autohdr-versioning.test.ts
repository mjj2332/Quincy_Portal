import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { writeAutoHdrFinal, type FinalWriteContext } from "../src/autohdr/finals";
import { workflowTailAgrees } from "../src/lib/automatic-stage";
import type { DropboxFile } from "../src/dropbox/client";

declare const __PORTAL_MIGRATION_SQL__: string;
const bindings = env as unknown as { DB: D1Database; MEDIA: R2Bucket };

async function executeSql(source: string) {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await bindings.DB.exec(`${flat};`);
    }
  }
}
beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'");
});

const fakeDownload = vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
  headers: { "content-type": "image/jpeg" },
}));
const fakeEnqueue = vi.fn(async () => true);

async function fixture(stage = "editing_autohdr") {
  const now = Date.now();
  const connectionId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const rawCollectionId = crypto.randomUUID();
  const editedCollectionId = crypto.randomUUID();
  const rawAssetId = crypto.randomUUID();
  const secondRawAssetId = crypto.randomUUID();
  const sendJobId = crypto.randomUUID();
  const fetchJobId = crypto.randomUUID();
  const handoffId = crypto.randomUUID();
  const mappingId = crypto.randomUUID();
  const fetchClaimId = crypto.randomUUID();
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
    bindings.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Admin', ?, 1, 'admin', 1, ?, ?)").bind(userId, `${userId}@test.invalid`, now, now),
    bindings.DB.prepare("INSERT INTO projects (id, street, stage_key, raw_folder_path, created_at, updated_at) VALUES (?, 'Versioning', ?, '/Tonomo/Raw Files/Versioning', ?, ?)").bind(projectId, stage, now, now),
    bindings.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'received', 2, ?, ?)").bind(rawCollectionId, projectId, now, now),
    bindings.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'edited', 'empty', 0, ?, ?)").bind(editedCollectionId, projectId, now, now),
    bindings.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'capture.jpg', 4, 'dropbox', ?, ?)").bind(rawAssetId, rawCollectionId, `tests/${rawAssetId}.jpg`, now, now),
    bindings.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'second.jpg', 4, 'dropbox', ?, ?)").bind(secondRawAssetId, rawCollectionId, `tests/${secondRawAssetId}.jpg`, now, now),
    bindings.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'autohdr', 'done', ?, ?, ?)").bind(sendJobId, projectId, now, now),
    bindings.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'fetch_edited', 'running', ?, ?, ?)").bind(fetchJobId, projectId, now, now),
    bindings.DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, manifest_version, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, initiated_by, state, workflow_id, job_id, lease_expires_at, started_at, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 'selection', ?, ?, '/Tonomo/Raw Files/Versioning', ?, 'started', ?, ?, ?, ?, ?, ?)")
      .bind(handoffId, projectId, connectionId, JSON.stringify([rawAssetId, secondRawAssetId]), JSON.stringify([{ key: `asset:${rawAssetId}`, assetIds: [rawAssetId] }, { key: `asset:${secondRawAssetId}`, assetIds: [secondRawAssetId] }]), userId, `send:${handoffId}`, sendJobId, now + 60_000, now, now, now),
    bindings.DB.prepare("INSERT INTO autohdr_output_mappings (id, project_id, handoff_id, connection_id, generation, state, final_path, final_path_key, observed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', '/AutoHDR/Versioning/04-FINAL-Photos', '/autohdr/versioning/04-final-photos', ?, ?, ?)")
      .bind(mappingId, projectId, handoffId, connectionId, now, now, now),
    bindings.DB.prepare("INSERT INTO autohdr_fetch_claims (id, project_id, handoff_id, mapping_id, mapping_generation, connection_id, workflow_id, job_id, state, lease_expires_at, trigger, trigger_json, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'running', ?, 'dropbox_delta', '{}', ?, ?, ?)")
      .bind(fetchClaimId, projectId, handoffId, mappingId, connectionId, `fetch:${fetchClaimId}`, fetchJobId, now + 60_000, now, now, now),
  ]);
  // This fixture represents a handoff that already won Editing entry. Production writes this
  // token as the final statement of the entry bundle before any final can arrive.
  await bindings.DB.prepare("UPDATE autohdr_handoffs SET editing_entry_board_revision = 0 WHERE id = ?")
    .bind(handoffId).run();
  const context: FinalWriteContext = {
    projectId, jobId: fetchJobId, claimId: fetchClaimId, handoffId, manifestVersion: 1,
    mappingId, mappingGeneration: 1, connectionId,
    finalPath: "/AutoHDR/Versioning/04-FINAL-Photos",
    finalPathKey: "/autohdr/versioning/04-final-photos",
    trigger: "dropbox_delta",
  };
  return { ...context, editedCollectionId, rawAssetId, secondRawAssetId };
}

function file(hash: string, name = "capture.jpg", folder = "04-final-photos"): DropboxFile {
  return {
    ".tag": "file", id: `id:${hash}`, name, size: 4, content_hash: hash,
    path_lower: `/autohdr/versioning/${folder}/${name}`,
    path_display: `/AutoHDR/Versioning/${folder}/${name}`,
  };
}

const deps = { download: fakeDownload as never, enqueue: fakeEnqueue as never };

async function seedCurrent(context: Awaited<ReturnType<typeof fixture>>, hash: string) {
  const assetId = crypto.randomUUID();
  const now = Date.now();
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, autohdr_handoff_id, created_at, updated_at) VALUES (?, ?, ?, 'capture.jpg', 4, ?, 'dropbox', '/AutoHDR/Versioning/04-FINAL-Photos/capture.jpg', '/autohdr/versioning/04-final-photos/capture.jpg', ?, ?, ?)")
      .bind(assetId, context.editedCollectionId, `tests/${assetId}.jpg`, hash, context.handoffId, now, now),
    bindings.DB.prepare("INSERT INTO edited_source_claims (id, collection_id, source_path_key, current_asset_id, content_hash, handoff_id, created_at, updated_at) VALUES (?, ?, '/autohdr/versioning/04-final-photos/capture.jpg', ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), context.editedCollectionId, assetId, hash, context.handoffId, now, now),
  ]);
  return assetId;
}

describe("immutable AutoHDR final writer", () => {
  it("uses N+1 for an editing-entry token and N for a completion token", () => {
    const result = (rows: Record<string, unknown>[]) => ({ results: rows, meta: { changes: 0 } }) as never;
    expect(workflowTailAgrees(
      [result([{ id: "handoff" }]), result([{ editing_entry_board_revision: 6 }])],
      "autohdr_handoff_entry",
      { kind: "autohdr_handoff_entry", prerequisiteMarker: 0, editingEntryToken: 1 },
      5,
    )).toBe(true);
    expect(workflowTailAgrees(
      [result([{ id: "handoff" }]), result([{ editing_entry_board_revision: 5 }])],
      "autohdr_handoff_entry",
      { kind: "autohdr_handoff_entry", prerequisiteMarker: 0, editingEntryToken: 1 },
      5,
    )).toBe(false);
    expect(workflowTailAgrees(
      [result([{ id: "completion" }]), result([{ stage_entry_board_revision: 5 }]), result([{ id: "completion", status: "done" }])],
      "autohdr_job_completion",
      { kind: "autohdr_job_completion", prerequisiteMarker: 0, sourceEntryJob: 1, completionJobState: 2 },
      5,
    )).toBe(true);
    expect(workflowTailAgrees(
      [result([{ id: "completion" }]), result([{ stage_entry_board_revision: 6 }]), result([{ id: "completion", status: "done" }])],
      "autohdr_job_completion",
      { kind: "autohdr_job_completion", prerequisiteMarker: 0, sourceEntryJob: 1, completionJobState: 2 },
      5,
    )).toBe(false);
  });

  it("advances the final writer and emits edited_landed after the corrected completion fence", async () => {
    const context = await fixture();
    const result = await writeAutoHdrFinal(bindings as never, context, file("edited-landed"), deps);
    expect(result).toMatchObject({ status: "created", stageAdvanced: true });
    const notification = await bindings.DB.prepare("SELECT count(*) count FROM notifications WHERE project_id = ? AND type = 'edited_landed'")
      .bind(context.projectId).first<{ count: number }>();
    expect(notification?.count).toBe(1);
  });

  it("creates the first current covered final, advances once, and replays same hash as a no-op", async () => {
    const context = await fixture();
    const first = await writeAutoHdrFinal(bindings as never, context, file("hash-one"), deps);
    expect(first).toMatchObject({ status: "created", stageAdvanced: true, coveredUnit: `asset:${context.rawAssetId}` });
    const replay = await writeAutoHdrFinal(bindings as never, context, file("hash-one"), deps);
    expect(replay).toMatchObject({ status: "same_hash", stageAdvanced: false, assetId: first.assetId });
    const project = await bindings.DB.prepare("SELECT stage_key FROM projects WHERE id = ?").bind(context.projectId).first();
    expect(project).toEqual({ stage_key: "edited_review" });
    const audit = await bindings.DB.prepare("SELECT count(*) count FROM audit_log WHERE target_id = ? AND action = 'stage.auto_advance'").bind(context.projectId).first<{ count: number }>();
    expect(audit?.count).toBe(1);
    const importAudit = await bindings.DB.prepare("SELECT actor_id, meta_json FROM audit_log WHERE target_id = ? AND action = 'autohdr.final_imported'")
      .bind(first.assetId).first<{ actor_id: string | null; meta_json: string }>();
    expect(importAudit?.actor_id).toBeNull();
    expect(JSON.parse(importAudit!.meta_json)).toMatchObject({
      trigger: "dropbox_delta", handoffId: context.handoffId, connectionId: context.connectionId,
    });
    const readiness = await bindings.DB.prepare("SELECT count(*) count FROM autohdr_final_associations WHERE handoff_id = ?").bind(context.handoffId).first<{ count: number }>();
    expect(readiness?.count).toBe(1);
  });

  it("replaces one current version immutably, retains old R2, and does not inherit review state", async () => {
    const context = await fixture();
    const first = await writeAutoHdrFinal(bindings as never, context, file("hash-old"), deps);
    await bindings.DB.prepare("INSERT INTO asset_review_state (id, asset_id, recommended, updated_at) VALUES (?, ?, 0, ?)")
      .bind(crypto.randomUUID(), first.assetId, Date.now()).run();
    const oldKey = await bindings.DB.prepare("SELECT r2_key FROM assets WHERE id = ?").bind(first.assetId).first<{ r2_key: string }>();
    const replacement = await writeAutoHdrFinal(bindings as never, context, file("hash-new"), deps);
    expect(replacement).toMatchObject({ status: "replaced", stageAdvanced: false });
    const versions = await bindings.DB.prepare("SELECT id, superseded_at FROM assets WHERE collection_id = ? AND source_path_key = ? ORDER BY created_at")
      .bind(context.editedCollectionId, "/autohdr/versioning/04-final-photos/capture.jpg").all<{ id: string; superseded_at: number | null }>();
    expect(versions.results).toHaveLength(2);
    expect(versions.results.filter((row) => row.superseded_at === null)).toEqual([{ id: replacement.assetId, superseded_at: null }]);
    const collection = await bindings.DB.prepare("SELECT received_count FROM collections WHERE id = ?").bind(context.editedCollectionId).first();
    expect(collection).toEqual({ received_count: 1 });
    await expect(bindings.MEDIA.head(oldKey!.r2_key)).resolves.not.toBeNull();
    const inherited = await bindings.DB.prepare("SELECT count(*) count FROM asset_review_state WHERE asset_id = ?").bind(replacement.assetId).first<{ count: number }>();
    expect(inherited?.count).toBe(0);
    const currentReadiness = await bindings.DB.prepare("SELECT count(*) count FROM autohdr_final_associations a JOIN assets x ON x.id = a.asset_id WHERE a.handoff_id = ? AND x.superseded_at IS NULL")
      .bind(context.handoffId).first<{ count: number }>();
    expect(currentReadiness?.count).toBe(1);
  });

  it("advances from credible replay-repair and replacement commits when no earlier final advanced the handoff", async () => {
    const replayContext = await fixture();
    const replayAssetId = await seedCurrent(replayContext, "seeded-replay");
    const replay = await writeAutoHdrFinal(bindings as never, replayContext, file("seeded-replay"), deps);
    expect(replay).toMatchObject({ status: "same_hash", assetId: replayAssetId, stageAdvanced: true });

    const replacementContext = await fixture();
    await seedCurrent(replacementContext, "seeded-old");
    const replacement = await writeAutoHdrFinal(bindings as never, replacementContext, file("seeded-new"), deps);
    expect(replacement).toMatchObject({ status: "replaced", stageAdvanced: true });

    for (const context of [replayContext, replacementContext]) {
      await expect(bindings.DB.prepare("SELECT stage_key FROM projects WHERE id = ?").bind(context.projectId).first())
        .resolves.toEqual({ stage_key: "edited_review" });
      const audit = await bindings.DB.prepare("SELECT count(*) count FROM audit_log WHERE target_id = ? AND action = 'stage.auto_advance'")
        .bind(context.projectId).first<{ count: number }>();
      expect(audit?.count).toBe(1);
    }
  });

  it("keeps same filenames at different source paths as independent current identities", async () => {
    const context = await fixture();
    await writeAutoHdrFinal(bindings as never, context, file("hash-a"), deps);
    const second = file("hash-b", "capture.jpg");
    second.path_lower = "/autohdr/versioning/04-final-photos/subfolder/capture.jpg";
    second.path_display = "/AutoHDR/Versioning/04-FINAL-Photos/Subfolder/capture.jpg";
    await writeAutoHdrFinal(bindings as never, context, second, deps);
    const count = await bindings.DB.prepare("SELECT count(*) count FROM edited_source_claims WHERE collection_id = ?").bind(context.editedCollectionId).first<{ count: number }>();
    expect(count?.count).toBe(2);
  });

  it("recovers replay faults after R2 and after D1 and accepts a lost same-hash race", async () => {
    const context = await fixture();
    await expect(writeAutoHdrFinal(bindings as never, context, file("hash-fault"), {
      ...deps, afterR2Write: () => { throw new Error("fault after R2"); },
    })).rejects.toThrow("fault after R2");
    await expect(writeAutoHdrFinal(bindings as never, context, file("hash-fault"), deps)).resolves.toMatchObject({ status: "created" });

    const postCommit = await fixture();
    await expect(writeAutoHdrFinal(bindings as never, postCommit, file("hash-post-commit"), {
      ...deps, afterD1Commit: () => { throw new Error("fault after D1"); },
    })).resolves.toMatchObject({ status: "lost_race" });
    const enqueueReplay = vi.fn(async () => true);
    await expect(writeAutoHdrFinal(bindings as never, postCommit, file("hash-post-commit"), {
      ...deps, enqueue: enqueueReplay as never,
    })).resolves.toMatchObject({ status: "same_hash" });
    expect(enqueueReplay).toHaveBeenCalledWith(expect.anything(), expect.any(String), "autohdr-existing-final");

    const sameReplacement = file("hash-race");
    const results = await Promise.all([
      writeAutoHdrFinal(bindings as never, context, sameReplacement, deps),
      writeAutoHdrFinal(bindings as never, context, sameReplacement, deps),
    ]);
    expect(new Set(results.map((result) => result.status)).has("replaced")).toBe(true);
    const current = await bindings.DB.prepare("SELECT count(*) count FROM assets WHERE collection_id = ? AND source_path_key = ? AND superseded_at IS NULL")
      .bind(context.editedCollectionId, sameReplacement.path_lower).first<{ count: number }>();
    expect(current?.count).toBe(1);
  });

  it("rolls back the losing candidate row when distinct replacements race for one current source key", async () => {
    const context = await fixture();
    await writeAutoHdrFinal(bindings as never, context, file("race-base"), deps);
    const results = await Promise.all([
      writeAutoHdrFinal(bindings as never, context, file("race-left"), deps),
      writeAutoHdrFinal(bindings as never, context, file("race-right"), deps),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["lost_race", "replaced"]);
    const versions = await bindings.DB.prepare(
      "SELECT id, superseded_at FROM assets WHERE collection_id = ? AND source_path_key = ? ORDER BY created_at",
    ).bind(context.editedCollectionId, "/autohdr/versioning/04-final-photos/capture.jpg")
      .all<{ id: string; superseded_at: number | null }>();
    expect(versions.results).toHaveLength(2);
    expect(versions.results.filter((row) => row.superseded_at === null)).toHaveLength(1);
  });

  it("quarantines archived/delivered fence changes, unmatched first finals, and legacy source ambiguity", async () => {
    const delivered = await fixture("delivered");
    await expect(writeAutoHdrFinal(bindings as never, delivered, file("delivered-hash"), deps)).resolves.toMatchObject({ status: "quarantined" });
    const deliveredAssets = await bindings.DB.prepare("SELECT count(*) count FROM assets WHERE collection_id = ?").bind(delivered.editedCollectionId).first<{ count: number }>();
    expect(deliveredAssets?.count).toBe(0);

    const deliveredReplacement = await fixture();
    const original = await writeAutoHdrFinal(bindings as never, deliveredReplacement, file("before-delivery"), deps);
    await bindings.DB.prepare("UPDATE projects SET stage_key = 'delivered' WHERE id = ?").bind(deliveredReplacement.projectId).run();
    await expect(writeAutoHdrFinal(bindings as never, deliveredReplacement, file("after-delivery"), deps))
      .resolves.toMatchObject({ status: "quarantined" });
    const deliveredCurrent = await bindings.DB.prepare("SELECT current_asset_id, content_hash FROM edited_source_claims WHERE collection_id = ?")
      .bind(deliveredReplacement.editedCollectionId).first();
    expect(deliveredCurrent).toEqual({ current_asset_id: original.assetId, content_hash: "before-delivery" });

    const unmatched = await fixture();
    await expect(writeAutoHdrFinal(bindings as never, unmatched, file("unmatched-hash", "unknown.jpg"), deps)).resolves.toMatchObject({ status: "created", stageAdvanced: false });
    const unmatchedStage = await bindings.DB.prepare("SELECT stage_key FROM projects WHERE id = ?").bind(unmatched.projectId).first();
    expect(unmatchedStage).toEqual({ stage_key: "editing_autohdr" });

    const legacy = await fixture();
    const now = Date.now();
    await bindings.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'capture.jpg', 4, 'dropbox', ?, ?)")
      .bind(crypto.randomUUID(), legacy.editedCollectionId, `tests/legacy-${crypto.randomUUID()}.jpg`, now, now).run();
    await expect(writeAutoHdrFinal(bindings as never, legacy, file("legacy-new"), deps)).resolves.toMatchObject({ status: "quarantined" });
  });

  it("fences archive, mapping generation/path, and connection changes before metadata", async () => {
    const cases: ((context: Awaited<ReturnType<typeof fixture>>) => Promise<void>)[] = [
      async (context) => { await bindings.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), context.projectId).run(); },
      async (context) => { await bindings.DB.prepare("UPDATE autohdr_output_mappings SET generation = 2 WHERE id = ?").bind(context.mappingId).run(); },
      async (context) => { await bindings.DB.prepare("UPDATE autohdr_output_mappings SET final_path_key = '/autohdr/other/04-final-photos' WHERE id = ?").bind(context.mappingId).run(); },
      async (context) => {
        const now = Date.now(); const other = crypto.randomUUID();
        await bindings.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(other, now, now).run();
        await bindings.DB.prepare("UPDATE autohdr_output_mappings SET connection_id = ? WHERE id = ?").bind(other, context.mappingId).run();
      },
    ];
    for (const mutate of cases) {
      const context = await fixture();
      await mutate(context);
      await expect(writeAutoHdrFinal(bindings as never, context, file(`fence-${crypto.randomUUID()}`), deps))
        .resolves.toMatchObject({ status: "quarantined" });
      const count = await bindings.DB.prepare("SELECT count(*) count FROM assets WHERE collection_id = ?").bind(context.editedCollectionId).first<{ count: number }>();
      expect(count?.count).toBe(0);
    }
  });
});
