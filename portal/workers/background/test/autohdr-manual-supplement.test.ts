import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ingestManualSupplement } from "../src/autohdr/manual-supplement";
import { routeAutoHdrDelta } from "../src/autohdr/mapping";
import {
  routeAutoHdrManualSupplementDelta,
} from "../src/autohdr/routers";
import { routeAutoHdrPage } from "../src/do/dropbox-sync";
import type { DropboxFile } from "../src/dropbox/client";
import { dbFor } from "../src/lib/db";

declare const __PORTAL_MIGRATION_SQL__: string;

const bindings = env as unknown as { DB: D1Database; MEDIA: R2Bucket };

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const flatStatements = chunk
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    for (const statement of flatStatements) await bindings.DB.exec(`${statement};`);
  }
}

beforeAll(() => executeSql(__PORTAL_MIGRATION_SQL__));

const fakeDownload = vi.fn(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
  headers: { "content-type": "image/jpeg" },
}));

function file(context: SupplementFixture, name = "supplement.jpg", hash = "supplement-hash"): DropboxFile {
  return {
    ".tag": "file",
    id: `id:${hash}`,
    name,
    size: 4,
    content_hash: hash,
    path_lower: `${context.scaffoldPathKey}/04-manual-photos/${name}`,
    path_display: `${context.scaffoldPath}/04-MANUAL-Photos/${name}`,
  };
}

type SupplementFixture = {
  projectId: string;
  connectionId: string;
  handoffId: string;
  mappingId: string;
  collectionId: string;
  scaffoldPath: string;
  scaffoldPathKey: string;
};

async function fixture(stage = "editing_autohdr", withHandoff = true): Promise<SupplementFixture> {
  const now = Date.now();
  const projectId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const collectionId = crypto.randomUUID();
  const handoffId = crypto.randomUUID();
  const mappingId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const scaffoldPath = `/AutoHDR/Manual-${projectId}`;
  const scaffoldPathKey = scaffoldPath.toLowerCase();
  const statements = [
    bindings.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)")
      .bind(connectionId, now, now),
    bindings.DB.prepare("INSERT INTO projects (id, street, stage_key, raw_folder_path, created_at, updated_at) VALUES (?, 'Manual supplement', ?, '/Tonomo/Raw Files/Manual supplement', ?, ?)")
      .bind(projectId, stage, now, now),
    bindings.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'edited', 'empty', 0, ?, ?)")
      .bind(collectionId, projectId, now, now),
    bindings.DB.prepare("INSERT INTO autohdr_scaffold_claims (id, project_id, connection_id, scaffold_path, scaffold_path_key, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)")
      .bind(crypto.randomUUID(), projectId, connectionId, scaffoldPath, scaffoldPathKey, now, now),
  ];
  if (withHandoff) {
    statements.push(
      bindings.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'autohdr', 'done', ?, ?, ?)")
        .bind(jobId, projectId, now, now),
      bindings.DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, manifest_version, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, initiated_by, state, workflow_id, job_id, lease_expires_at, started_at, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 'manual-supplement', '[]', '[]', '/Tonomo/Raw Files/Manual supplement', NULL, 'started', ?, ?, ?, ?, ?, ?)")
        .bind(handoffId, projectId, connectionId, `handoff-${handoffId}`, jobId, now + 60_000, now, now, now),
      bindings.DB.prepare("INSERT INTO autohdr_output_mappings (id, project_id, handoff_id, connection_id, generation, state, final_path, final_path_key, observed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'active', '/AutoHDR/Manual/04-FINAL-Photos', '/autohdr/manual/04-final-photos', ?, ?, ?)")
        .bind(mappingId, projectId, handoffId, connectionId, now, now, now),
    );
  }
  await bindings.DB.batch(statements);
  return { projectId, connectionId, handoffId, mappingId, collectionId, scaffoldPath, scaffoldPathKey };
}

function localEnv(send = vi.fn(async () => undefined)) {
  return {
    DB: bindings.DB,
    MEDIA: bindings.MEDIA,
    RENDITIONS_ENABLED: true,
    RENDITION_QUEUE: { send },
  } as never;
}

const deps = { download: fakeDownload as never };

describe("AutoHDR manual supplement router", () => {
  it("matches an active handoff in editing_review, but excludes blocked state", async () => {
    const review = await fixture("edited_review");
    const reviewResult = await routeAutoHdrManualSupplementDelta(localEnv(), review.connectionId, [file(review)]);
    expect(reviewResult).toMatchObject({ matched: 1 });
    expect(reviewResult.routes[0]).toMatchObject({
      projectId: review.projectId,
      handoffId: review.handoffId,
      mappingId: review.mappingId,
    });

    const blocked = await fixture();
    await bindings.DB.prepare("UPDATE autohdr_handoffs SET state = 'blocked' WHERE id = ?").bind(blocked.handoffId).run();
    await expect(routeAutoHdrManualSupplementDelta(localEnv(), blocked.connectionId, [file(blocked)])).resolves.toEqual({ matched: 0, routes: [] });

    const blockedMapping = await fixture();
    await bindings.DB.prepare("UPDATE autohdr_output_mappings SET state = 'blocked_collision' WHERE id = ?").bind(blockedMapping.mappingId).run();
    await expect(routeAutoHdrManualSupplementDelta(localEnv(), blockedMapping.connectionId, [file(blockedMapping)])).resolves.toEqual({ matched: 0, routes: [] });
  });

  it("runs the supplement pass before implicit handoff creation in one page", async () => {
    const context = await fixture("raw_review", false);
    const result = await routeAutoHdrPage(localEnv(), dbFor(localEnv()), context.connectionId, [file(context)]);
    expect(result.manualSupplementRouted).toEqual({ matched: 0, routes: [] });
    expect(result.manualRouted.matched).toBe(1);
    expect(result.manualRouted.routes).toHaveLength(1);
    await expect(bindings.DB.prepare("SELECT count(*) count FROM autohdr_handoffs WHERE project_id = ?").bind(context.projectId).first<{ count: number }>())
      .resolves.toEqual({ count: 1 });
  });

  it("routes a manual claim only through the supplement router", async () => {
    const context = await fixture();
    const now = Date.now();
    await bindings.DB.prepare("INSERT INTO autohdr_path_claims (id, mapping_id, handoff_id, project_id, connection_id, candidate, path, path_key, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, 'active', ?, ?)")
      .bind(crypto.randomUUID(), context.mappingId, context.handoffId, context.projectId, context.connectionId, `${context.scaffoldPath}/04-MANUAL-Photos`, `${context.scaffoldPathKey}/04-manual-photos`, now, now).run();
    const supplement = await routeAutoHdrManualSupplementDelta(localEnv(), context.connectionId, [file(context)]);
    const explicit = await routeAutoHdrDelta(dbFor(localEnv()), context.connectionId, [file(context)]);
    expect(supplement.matched).toBe(1);
    expect(explicit).toMatchObject({ matched: 0, routes: [] });
  });

  it("does not match a missing or retired scaffold claim", async () => {
    const missing = await fixture();
    await bindings.DB.prepare("UPDATE autohdr_scaffold_claims SET state = 'retired' WHERE project_id = ?").bind(missing.projectId).run();
    await expect(routeAutoHdrManualSupplementDelta(localEnv(), missing.connectionId, [file(missing)])).resolves.toEqual({ matched: 0, routes: [] });
  });
});

describe("AutoHDR manual supplement writer", () => {
  it("creates one asset, identity, count update, and audit row, then replays idempotently", async () => {
    const context = await fixture();
    const send = vi.fn(async () => undefined);
    const result = await ingestManualSupplement(localEnv(send), context.projectId, context.handoffId, context.mappingId, context.connectionId, file(context), deps);
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected the first supplement ingest to create an asset");
    const replay = await ingestManualSupplement(localEnv(send), context.projectId, context.handoffId, context.mappingId, context.connectionId, file(context), deps);
    expect(replay).toMatchObject({ status: "already_ingested", assetId: result.assetId });
    await expect(bindings.DB.prepare("SELECT count(*) count FROM assets WHERE collection_id = ?").bind(context.collectionId).first<{ count: number }>()).resolves.toEqual({ count: 1 });
    await expect(bindings.DB.prepare("SELECT count(*) count FROM asset_ingest_identities WHERE collection_id = ?").bind(context.collectionId).first<{ count: number }>()).resolves.toEqual({ count: 1 });
    await expect(bindings.DB.prepare("SELECT received_count FROM collections WHERE id = ?").bind(context.collectionId).first()).resolves.toEqual({ received_count: 1 });
    await expect(bindings.DB.prepare("SELECT count(*) count FROM audit_log WHERE target_id = ? AND action = 'autohdr.manual_supplement_imported'").bind(result.assetId).first<{ count: number }>()).resolves.toEqual({ count: 1 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("allows edited_review and atomically skips when eligibility changes before the batch", async () => {
    const review = await fixture("edited_review");
    await expect(ingestManualSupplement(localEnv(), review.projectId, review.handoffId, review.mappingId, review.connectionId, file(review), deps)).resolves.toMatchObject({ status: "created" });

    const raced = await fixture();
    const send = vi.fn(async () => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await ingestManualSupplement(localEnv(send), raced.projectId, raced.handoffId, raced.mappingId, raced.connectionId, file(raced), {
        ...deps,
        beforeBatch: async () => {
          await bindings.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), raced.projectId).run();
        },
      });
      expect(result).toEqual({ status: "skipped" });
      expect("assetId" in result).toBe(false);
      expect(send).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(
        "AutoHDR manual supplement skipped: write-time guard rejected",
        {
          projectId: raced.projectId,
          handoffId: raced.handoffId,
          mappingId: raced.mappingId,
          sourcePathKey: file(raced).path_lower,
        },
      );
      await expect(bindings.DB.prepare("SELECT count(*) count FROM assets WHERE collection_id = ?").bind(raced.collectionId).first<{ count: number }>()).resolves.toEqual({ count: 0 });
    } finally {
      warning.mockRestore();
    }
  });

  it("rejects every other eligibility transition inside the guarded batch", async () => {
    const cases: Array<(context: SupplementFixture) => Promise<void>> = [
      async (context) => bindings.DB.prepare("UPDATE projects SET stage_key = 'delivered' WHERE id = ?").bind(context.projectId).run().then(() => undefined),
      async (context) => bindings.DB.prepare("UPDATE autohdr_handoffs SET state = 'blocked' WHERE id = ?").bind(context.handoffId).run().then(() => undefined),
      async (context) => bindings.DB.prepare("UPDATE autohdr_output_mappings SET state = 'blocked_collision' WHERE id = ?").bind(context.mappingId).run().then(() => undefined),
      async (context) => bindings.DB.prepare("UPDATE autohdr_scaffold_claims SET state = 'retired' WHERE project_id = ?").bind(context.projectId).run().then(() => undefined),
    ];
    for (const mutate of cases) {
      const context = await fixture();
      const send = vi.fn(async () => undefined);
      const result = await ingestManualSupplement(localEnv(send), context.projectId, context.handoffId, context.mappingId, context.connectionId, file(context), {
        ...deps,
        beforeBatch: () => mutate(context),
      });
      expect(result).toEqual({ status: "skipped" });
      expect(send).not.toHaveBeenCalled();
      await expect(bindings.DB.prepare("SELECT count(*) count FROM assets WHERE collection_id = ?").bind(context.collectionId).first<{ count: number }>()).resolves.toEqual({ count: 0 });
    }
  });

  it("resolves an assets source-key conflict to the current, non-superseded winner", async () => {
    const context = await fixture();
    const target = file(context);
    const oldId = crypto.randomUUID();
    const currentId = crypto.randomUUID();
    const now = Date.now();
    const sourceKey = target.path_lower;
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, superseded_at, created_at, updated_at) VALUES (?, ?, ?, 'old.jpg', 4, 'old', 'dropbox', ?, ?, ?, ?, ?)")
        .bind(oldId, context.collectionId, `tests/${oldId}.jpg`, target.path_display, sourceKey, now - 2, now - 2, now - 2),
      bindings.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, created_at, updated_at) VALUES (?, ?, ?, 'current.jpg', 4, 'current', 'dropbox', ?, ?, ?, ?)")
        .bind(currentId, context.collectionId, `tests/${currentId}.jpg`, target.path_display, sourceKey, now - 1, now - 1),
      bindings.DB.prepare("UPDATE assets SET superseded_at = ?, replaced_by_asset_id = ? WHERE id = ?")
        .bind(now - 1, currentId, oldId),
    ]);
    await expect(ingestManualSupplement(localEnv(), context.projectId, context.handoffId, context.mappingId, context.connectionId, target, deps))
      .resolves.toEqual({ status: "already_ingested", assetId: currentId });
  });

  it("resolves an identity conflict through the reservation's own asset_id", async () => {
    const context = await fixture();
    const target = file(context);
    const reservationAssetId = crypto.randomUUID();
    const now = Date.now();
    const identityKey = `manual-supplement:${target.path_lower}`;
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, source_path, source_path_key, created_at, updated_at) VALUES (?, ?, ?, 'reservation.jpg', 4, 'dropbox', '/other', '/other', ?, ?)")
        .bind(reservationAssetId, context.collectionId, `tests/${reservationAssetId}.jpg`, now, now),
      bindings.DB.prepare("INSERT INTO asset_ingest_identities (id, collection_id, identity_key, asset_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), context.collectionId, identityKey, reservationAssetId, now),
    ]);
    await expect(ingestManualSupplement(localEnv(), context.projectId, context.handoffId, context.mappingId, context.connectionId, target, deps))
      .resolves.toEqual({ status: "already_ingested", assetId: reservationAssetId });
    await expect(bindings.DB.prepare("SELECT count(*) count FROM assets WHERE collection_id = ? AND source_path_key = ?").bind(context.collectionId, target.path_lower).first<{ count: number }>()).resolves.toEqual({ count: 0 });
  });
});
