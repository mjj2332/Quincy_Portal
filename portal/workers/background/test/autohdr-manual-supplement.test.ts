import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  acquireManualIngestLease,
  ingestManualSupplement,
  refreshManualIngestLease,
  releaseManualIngestLease,
} from "../src/autohdr/manual-supplement";
import { routeAutoHdrDelta } from "../src/autohdr/mapping";
import {
  routeAutoHdrManualSupplementDelta,
} from "../src/autohdr/routers";
import { processManualSupplementRoutes, routeAutoHdrPage } from "../src/do/dropbox-sync";
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

async function fixture(
  stage = "editing_autohdr",
  withHandoff = true,
  mappingState: "active" | "pending_discovery" = "active",
): Promise<SupplementFixture> {
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
      bindings.DB.prepare("INSERT INTO autohdr_output_mappings (id, project_id, handoff_id, connection_id, generation, state, final_path, final_path_key, observed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, '/AutoHDR/Manual/04-FINAL-Photos', '/autohdr/manual/04-final-photos', ?, ?, ?)")
        .bind(mappingId, projectId, handoffId, connectionId, mappingState, now, now, now),
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

async function lease(context: SupplementFixture): Promise<string> {
  const ownerToken = await acquireManualIngestLease(localEnv(), context.mappingId);
  if (!ownerToken) throw new Error(`unable to acquire test lease for ${context.mappingId}`);
  return ownerToken;
}

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

  it("matches pending discovery, but still excludes blocked, wrong-stage, and blocked-handoff mappings", async () => {
    const pending = await fixture("editing_autohdr", true, "pending_discovery");
    await expect(routeAutoHdrManualSupplementDelta(localEnv(), pending.connectionId, [file(pending)])).resolves.toMatchObject({
      matched: 1,
      routes: [{ projectId: pending.projectId, mappingId: pending.mappingId }],
    });

    const wrongStage = await fixture("raw_review", true, "pending_discovery");
    await expect(routeAutoHdrManualSupplementDelta(localEnv(), wrongStage.connectionId, [file(wrongStage)])).resolves.toEqual({ matched: 0, routes: [] });

    const blockedHandoff = await fixture("editing_autohdr", true, "pending_discovery");
    await bindings.DB.prepare("UPDATE autohdr_handoffs SET state = 'blocked' WHERE id = ?").bind(blockedHandoff.handoffId).run();
    await expect(routeAutoHdrManualSupplementDelta(localEnv(), blockedHandoff.connectionId, [file(blockedHandoff)])).resolves.toEqual({ matched: 0, routes: [] });

    const blockedMapping = await fixture("editing_autohdr", true, "pending_discovery");
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
  it("enforces token-scoped mutual exclusion and release", async () => {
    const context = await fixture();
    const ownerToken = await lease(context);
    await expect(acquireManualIngestLease(localEnv(), context.mappingId)).resolves.toBeNull();
    await releaseManualIngestLease(localEnv(), context.mappingId, "wrong-token");
    await expect(bindings.DB.prepare("SELECT owner_token FROM autohdr_manual_ingest_leases WHERE mapping_id = ?").bind(context.mappingId).first())
      .resolves.toEqual({ owner_token: ownerToken });
    await releaseManualIngestLease(localEnv(), context.mappingId, ownerToken);
    await expect(bindings.DB.prepare("SELECT owner_token FROM autohdr_manual_ingest_leases WHERE mapping_id = ?").bind(context.mappingId).first())
      .resolves.toBeNull();
  });

  it("refreshes only a still-live lease and rejects the slow-download stale-lease commit", async () => {
    const context = await fixture();
    const ownerToken = await lease(context);
    const now = Date.now();
    await expect(refreshManualIngestLease(localEnv(), context.mappingId, ownerToken, now, now + 60_000)).resolves.toBe(true);
    await bindings.DB.prepare("UPDATE autohdr_manual_ingest_leases SET lease_expires_at = ? WHERE mapping_id = ?")
      .bind(Date.now() - 1, context.mappingId).run();
    await expect(refreshManualIngestLease(localEnv(), context.mappingId, ownerToken, Date.now(), Date.now() + 60_000)).resolves.toBe(false);

    const slowContext = await fixture();
    const slowToken = await lease(slowContext);
    await bindings.DB.prepare("UPDATE autohdr_manual_ingest_leases SET lease_expires_at = ? WHERE mapping_id = ?")
      .bind(Date.now() + 5, slowContext.mappingId).run();
    const slowDownload = vi.fn(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    });
    await expect(ingestManualSupplement(
      localEnv(),
      slowContext.projectId,
      slowContext.handoffId,
      slowContext.mappingId,
      slowContext.connectionId,
      file(slowContext),
      { download: slowDownload as never },
      slowToken,
    )).rejects.toThrow("expired before commit");
    await expect(bindings.DB.prepare("SELECT count(*) count FROM assets WHERE collection_id = ?").bind(slowContext.collectionId).first<{ count: number }>() )
      .resolves.toEqual({ count: 0 });
  });

  it("aborts the alarm-level manual page on a non-lease skipped result", async () => {
    const context = await fixture();
    await expect(processManualSupplementRoutes(
      localEnv(),
      [{ ...context, file: file(context) }],
      0,
      {
        download: fakeDownload as never,
        beforeBatch: () => bindings.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?")
          .bind(Date.now(), context.projectId).run().then(() => undefined),
      },
    )).rejects.toThrow("manual ingest fenced out");
    await expect(bindings.DB.prepare("SELECT count(*) count FROM autohdr_manual_ingest_leases WHERE mapping_id = ?").bind(context.mappingId).first<{ count: number }>() )
      .resolves.toEqual({ count: 0 });
  });

  it("holds one lease across a mapping's grouped batch and releases an earlier lease when a later acquire fails", async () => {
    const grouped = await fixture();
    const groupedResult = await processManualSupplementRoutes(localEnv(), [
      { ...grouped, file: file(grouped, "one.jpg", "one") },
      { ...grouped, file: file(grouped, "two.jpg", "two") },
    ], 0, deps);
    expect(groupedResult.routedProjectCount).toBe(2);
    await expect(bindings.DB.prepare("SELECT count(*) count FROM assets WHERE collection_id = ?").bind(grouped.collectionId).first<{ count: number }>() )
      .resolves.toEqual({ count: 2 });
    await expect(bindings.DB.prepare("SELECT count(*) count FROM autohdr_manual_ingest_leases WHERE mapping_id = ?").bind(grouped.mappingId).first<{ count: number }>() )
      .resolves.toEqual({ count: 0 });

    const first = await fixture();
    const second = await fixture();
    const secondToken = await lease(second);
    await expect(processManualSupplementRoutes(localEnv(), [
      { ...first, file: file(first) },
      { ...second, file: file(second) },
    ], 0, deps)).rejects.toThrow(`lease unavailable for mapping ${second.mappingId}`);
    await expect(bindings.DB.prepare("SELECT count(*) count FROM autohdr_manual_ingest_leases WHERE mapping_id = ?").bind(first.mappingId).first<{ count: number }>() )
      .resolves.toEqual({ count: 0 });
    await expect(bindings.DB.prepare("SELECT owner_token FROM autohdr_manual_ingest_leases WHERE mapping_id = ?").bind(second.mappingId).first())
      .resolves.toEqual({ owner_token: secondToken });
    await releaseManualIngestLease(localEnv(), second.mappingId, secondToken);
  });

  it("promotes a pending mapping to the manual folder and creates later files without re-promoting", async () => {
    const context = await fixture("editing_autohdr", true, "pending_discovery");
    const ownerToken = await lease(context);
    const send = vi.fn(async () => undefined);
    const firstFile = file(context, "first.jpg", "first-hash");
    const first = await ingestManualSupplement(localEnv(send), context.projectId, context.handoffId, context.mappingId, context.connectionId, firstFile, deps, ownerToken);
    expect(first).toMatchObject({ status: "created", assetId: expect.any(String) });

    const promoted = await bindings.DB.prepare("SELECT state, final_path, final_path_key FROM autohdr_output_mappings WHERE id = ?")
      .bind(context.mappingId).first();
    expect(promoted).toEqual({
      state: "active",
      final_path: `${context.scaffoldPath}/04-MANUAL-Photos`,
      final_path_key: `${context.scaffoldPathKey}/04-manual-photos`,
    });

    const second = await ingestManualSupplement(localEnv(send), context.projectId, context.handoffId, context.mappingId, context.connectionId, file(context, "second.jpg", "second-hash"), deps, ownerToken);
    expect(second).toMatchObject({ status: "created", assetId: expect.any(String) });
    await expect(bindings.DB.prepare("SELECT count(*) count FROM assets WHERE collection_id = ?").bind(context.collectionId).first<{ count: number }>()).resolves.toEqual({ count: 2 });
    await expect(bindings.DB.prepare("SELECT state, final_path, final_path_key FROM autohdr_output_mappings WHERE id = ?").bind(context.mappingId).first()).resolves.toEqual(promoted);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("still creates and enqueues a supplement for an already-active mapping", async () => {
    const context = await fixture();
    const ownerToken = await lease(context);
    const send = vi.fn(async () => undefined);
    const result = await ingestManualSupplement(localEnv(send), context.projectId, context.handoffId, context.mappingId, context.connectionId, file(context), deps, ownerToken);
    expect(result).toMatchObject({ status: "created", assetId: expect.any(String) });
    if (result.status !== "created") throw new Error("expected the active supplement to create an asset");
    expect(send).toHaveBeenCalledWith({ type: "generate_renditions", assetId: result.assetId });
  });

  it("creates one asset, identity, count update, and audit row, then replays idempotently", async () => {
    const context = await fixture();
    const ownerToken = await lease(context);
    const send = vi.fn(async () => undefined);
    const result = await ingestManualSupplement(localEnv(send), context.projectId, context.handoffId, context.mappingId, context.connectionId, file(context), deps, ownerToken);
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected the first supplement ingest to create an asset");
    const replay = await ingestManualSupplement(localEnv(send), context.projectId, context.handoffId, context.mappingId, context.connectionId, file(context), deps, ownerToken);
    expect(replay).toMatchObject({ status: "already_ingested", assetId: result.assetId });
    await expect(bindings.DB.prepare("SELECT count(*) count FROM assets WHERE collection_id = ?").bind(context.collectionId).first<{ count: number }>()).resolves.toEqual({ count: 1 });
    await expect(bindings.DB.prepare("SELECT count(*) count FROM asset_ingest_identities WHERE collection_id = ?").bind(context.collectionId).first<{ count: number }>()).resolves.toEqual({ count: 1 });
    await expect(bindings.DB.prepare("SELECT received_count FROM collections WHERE id = ?").bind(context.collectionId).first()).resolves.toEqual({ received_count: 1 });
    await expect(bindings.DB.prepare("SELECT count(*) count FROM audit_log WHERE target_id = ? AND action = 'autohdr.manual_supplement_imported'").bind(result.assetId).first<{ count: number }>()).resolves.toEqual({ count: 1 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("blocks a later FINAL delivery after manual promotion instead of overwriting the mapping", async () => {
    const context = await fixture("editing_autohdr", true, "pending_discovery");
    const ownerToken = await lease(context);
    await ingestManualSupplement(localEnv(), context.projectId, context.handoffId, context.mappingId, context.connectionId, file(context), deps, ownerToken);
    const now = Date.now();
    const finalPath = `${context.scaffoldPath}/04-FINAL-Photos`;
    const finalPathKey = `${context.scaffoldPathKey}/04-final-photos`;
    await bindings.DB.prepare("INSERT INTO autohdr_path_claims (id, mapping_id, handoff_id, project_id, connection_id, candidate, path, path_key, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'final', ?, ?, 'pending', ?, ?)")
      .bind(crypto.randomUUID(), context.mappingId, context.handoffId, context.projectId, context.connectionId, finalPath, finalPathKey, now, now).run();

    const result = await routeAutoHdrDelta(dbFor(localEnv()), context.connectionId, [{
      ".tag": "file",
      id: "id:final-after-manual",
      name: "final.jpg",
      size: 4,
      content_hash: "final-hash",
      path_lower: `${finalPathKey}/final.jpg`,
      path_display: `${finalPath}/final.jpg`,
    }]);
    expect(result).toMatchObject({ matched: 1, blocked: 1, routes: [] });
    await expect(bindings.DB.prepare("SELECT state, final_path, final_path_key FROM autohdr_output_mappings WHERE id = ?").bind(context.mappingId).first()).resolves.toEqual({
      state: "blocked_collision",
      final_path: `${context.scaffoldPath}/04-MANUAL-Photos`,
      final_path_key: `${context.scaffoldPathKey}/04-manual-photos`,
    });
  });

  it("allows edited_review and atomically skips when eligibility changes before the batch", async () => {
    const review = await fixture("edited_review");
    const reviewToken = await lease(review);
    await expect(ingestManualSupplement(localEnv(), review.projectId, review.handoffId, review.mappingId, review.connectionId, file(review), deps, reviewToken)).resolves.toMatchObject({ status: "created" });

    const raced = await fixture();
    const racedToken = await lease(raced);
    const send = vi.fn(async () => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await ingestManualSupplement(localEnv(send), raced.projectId, raced.handoffId, raced.mappingId, raced.connectionId, file(raced), {
        ...deps,
        beforeBatch: async () => {
          await bindings.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), raced.projectId).run();
        },
      }, racedToken);
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
      const ownerToken = await lease(context);
      const send = vi.fn(async () => undefined);
      const result = await ingestManualSupplement(localEnv(send), context.projectId, context.handoffId, context.mappingId, context.connectionId, file(context), {
        ...deps,
        beforeBatch: () => mutate(context),
      }, ownerToken);
      expect(result).toEqual({ status: "skipped" });
      expect(send).not.toHaveBeenCalled();
      await expect(bindings.DB.prepare("SELECT count(*) count FROM assets WHERE collection_id = ?").bind(context.collectionId).first<{ count: number }>()).resolves.toEqual({ count: 0 });
    }
  });

  it("resolves an assets source-key conflict to the current, non-superseded winner", async () => {
    const context = await fixture();
    const ownerToken = await lease(context);
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
    await expect(ingestManualSupplement(localEnv(), context.projectId, context.handoffId, context.mappingId, context.connectionId, target, deps, ownerToken))
      .resolves.toEqual({ status: "already_ingested", assetId: currentId });
  });

  it("resolves an identity conflict through the reservation's own asset_id", async () => {
    const context = await fixture();
    const ownerToken = await lease(context);
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
    await expect(ingestManualSupplement(localEnv(), context.projectId, context.handoffId, context.mappingId, context.connectionId, target, deps, ownerToken))
      .resolves.toEqual({ status: "already_ingested", assetId: reservationAssetId });
    await expect(bindings.DB.prepare("SELECT count(*) count FROM assets WHERE collection_id = ? AND source_path_key = ?").bind(context.collectionId, target.path_lower).first<{ count: number }>()).resolves.toEqual({ count: 0 });
  });
});
