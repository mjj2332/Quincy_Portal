import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { claimAutoHdrFetch, claimAutoHdrHandoff, claimBackfillAutoHdrHandoff, claimImplicitAutoHdrHandoff, confirmAutoHdrHandoff } from "../src/autohdr/claims";
import { routeAutoHdrDelta, type RoutedAutoHdrMapping } from "../src/autohdr/mapping";
import { routeAutoHdrManualDropDelta, routeAutoHdrProviderDelta } from "../src/autohdr/routers";
import { ensureScaffold } from "../src/autohdr/scaffold";
import { dbFor } from "../src/lib/db";
import { canonicalDropboxConnectionId } from "../src/dropbox/connection";
import QuincyBackground from "../src";

declare const __PORTAL_MIGRATION_SQL__: string;
const database = env as unknown as { DB: D1Database };

async function executeSql(source: string) {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

beforeAll(() => executeSql(__PORTAL_MIGRATION_SQL__));

async function fixture() {
  const now = Date.now();
  const connectionId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const collectionId = crypto.randomUUID();
  const assetIds = [crypto.randomUUID(), crypto.randomUUID()];
  await database.DB.batch([
    database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Admin', ?, 1, 'admin', 1, ?, ?)").bind(userId, `${userId}@test.invalid`, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, raw_folder_path, created_at, updated_at) VALUES (?, 'Claim race', 'raw_review', ?, ?, ?)")
      .bind(projectId, `/Tonomo/Raw Files/Studio/${projectId}`, now, now),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'received', 2, ?, ?)").bind(collectionId, projectId, now, now),
    ...assetIds.map((assetId, index) => database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'dropbox', ?, ?)")
      .bind(assetId, collectionId, `tests/${assetId}.jpg`, `capture-${index}.jpg`, now, now)),
    ...assetIds.map((assetId, index) => database.DB.prepare("INSERT INTO selections (id, asset_id, selected_by, state, bracket_group, created_at) VALUES (?, ?, ?, 'selected_for_editing', ?, ?)")
      .bind(crypto.randomUUID(), assetId, userId, index === 0 ? "bracket-a" : null, now)),
  ]);
  // Production code under test resolves its own connection via canonicalDropboxConnectionId()
  // ("oldest live Dropbox connection"), not via whatever id this fixture happened to generate.
  // Across a full-file run, many fixture() calls each insert their own connection row with none
  // ever cleaned up, so the canonical one is whichever ran first in the file — not necessarily
  // this call's own row. Return the ACTUAL canonical id so callers that assert against it match
  // what the code under test really resolves, regardless of test execution order.
  const canonicalConnectionId = await canonicalDropboxConnectionId(dbFor({ DB: database.DB } as never));
  return { connectionId: canonicalConnectionId, userId, projectId };
}

/** Cloudflare rejects Workflow instance ids outside this alphabet at create() time with
 *  "(instance.invalid_id) Instance has invalid id" — a ":" separator shipped and broke every V2
 *  send and fetch in production. Guard both id builders here so it cannot silently return. */
const WORKFLOW_INSTANCE_ID = /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/;

describe("AutoHDR workflow instance ids", () => {
  it("send and fetch ids use only characters Cloudflare accepts", async () => {
    const data = await fixture();
    const localEnv = { DB: database.DB } as never;

    const owner = await claimAutoHdrHandoff(localEnv, data.projectId, data.userId);
    expect(owner.workflowId).toMatch(WORKFLOW_INSTANCE_ID);

    await database.DB.prepare("UPDATE autohdr_handoffs SET state = 'started' WHERE id = ?").bind(owner.handoffId).run();
    const mapping = await database.DB.prepare("SELECT id, generation, connection_id FROM autohdr_output_mappings WHERE handoff_id = ?")
      .bind(owner.handoffId).first<{ id: string; generation: number; connection_id: string }>();
    const route: RoutedAutoHdrMapping = {
      projectId: data.projectId,
      handoffId: owner.handoffId,
      mappingId: mapping!.id,
      generation: mapping!.generation,
      connectionId: mapping!.connection_id,
      finalPath: "/AutoHDR/Id guard/04-FINAL-Photos",
      finalPathKey: "/autohdr/id guard/04-final-photos",
      representativeChangedPath: "/autohdr/id guard/04-final-photos/a.jpg",
    };
    const fetchOwner = await claimAutoHdrFetch(localEnv, route, { trigger: "dropbox_delta" });
    expect(fetchOwner.workflowId).toMatch(WORKFLOW_INSTANCE_ID);
  });
});

describe("atomic AutoHDR ownership", () => {
  it("deduplicates an implicit manual drop by folder and advances the project once", async () => {
    const data = await fixture();
    const scaffoldPath = `/AutoHDR/Implicit-${data.projectId}`;
    const scaffoldPathKey = scaffoldPath.toLowerCase();
    const now = Date.now();
    await database.DB.prepare(
      "INSERT INTO autohdr_scaffold_claims (id, project_id, connection_id, scaffold_path, scaffold_path_key, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
    ).bind(
      crypto.randomUUID(),
      data.projectId,
      data.connectionId,
      scaffoldPath,
      scaffoldPathKey,
      now,
      now,
    ).run();
    const entries = ["one.jpg", "two.jpg"].map((name, index) => ({
      ".tag": "file" as const,
      id: `id:manual-${index}`,
      name,
      size: 1,
      path_lower: `${scaffoldPathKey}/04-manual-photos/${name}`,
      path_display: `${scaffoldPath}/04-MANUAL-Photos/${name}`,
    }));

    const manual = await routeAutoHdrManualDropDelta(
      { DB: database.DB } as never,
      data.connectionId,
      entries,
    );
    expect(manual).toMatchObject({ matched: 1 });
    expect(manual.routes).toHaveLength(1);
    const provider = await routeAutoHdrProviderDelta(
      { DB: database.DB } as never,
      data.connectionId,
      [{
        ".tag": "file",
        id: "id:provider",
        name: "final.jpg",
        size: 1,
        path_lower: `${scaffoldPathKey}/04-final-photos/final.jpg`,
        path_display: `${scaffoldPath}/04-FINAL-Photos/final.jpg`,
      }],
    );
    expect(provider).toEqual({ matched: 0, routes: [] });

    const state = await database.DB.prepare(
      "SELECT p.stage_key, h.initiated_by, h.expected_origin_stage, h.state, h.readiness_units_json, m.state mapping_state, pc.candidate " +
      "FROM projects p JOIN autohdr_handoffs h ON h.project_id = p.id JOIN autohdr_output_mappings m ON m.handoff_id = h.id " +
      "JOIN autohdr_path_claims pc ON pc.handoff_id = h.id WHERE p.id = ?",
    ).bind(data.projectId).first();
    expect(state).toEqual({
      stage_key: "editing_autohdr",
      initiated_by: null,
      expected_origin_stage: "raw_review",
      state: "started",
      readiness_units_json: "[]",
      mapping_state: "active",
      candidate: "manual",
    });
    const audits = await database.DB.prepare(
      "SELECT count(*) count FROM audit_log WHERE target_id = ? AND action = 'stage.auto_advance'",
    ).bind(data.projectId).first<{ count: number }>();
    expect(audits?.count).toBe(1);
  });

  it("retires an implicit collision without advancing Raw Review", async () => {
    const owner = await fixture();
    const explicit = await claimAutoHdrHandoff(
      { DB: database.DB } as never,
      owner.projectId,
      owner.userId,
    );
    const occupied = await database.DB.prepare(
      "SELECT path FROM autohdr_path_claims WHERE handoff_id = ? ORDER BY candidate LIMIT 1",
    ).bind(explicit.handoffId).first<{ path: string }>();
    const contender = await fixture();

    const result = await claimImplicitAutoHdrHandoff(
      { DB: database.DB } as never,
      contender.projectId,
      owner.connectionId,
      occupied!.path,
    );
    expect(result).toMatchObject({ isCollision: true });
    const state = await database.DB.prepare(
      "SELECT p.stage_key, h.state, m.state mapping_state FROM projects p " +
      "JOIN autohdr_handoffs h ON h.project_id = p.id JOIN autohdr_output_mappings m ON m.handoff_id = h.id WHERE p.id = ?",
    ).bind(contender.projectId).first();
    expect(state).toEqual({
      stage_key: "raw_review",
      state: "retired",
      mapping_state: "blocked_collision",
    });
  });

  it("backfill reactivates a tombstoned claim onto a new generation atomically", async () => {
    const data = await fixture();
    const first = await claimAutoHdrHandoff(
      { DB: database.DB } as never,
      data.projectId,
      data.userId,
    );
    const oldClaim = await database.DB.prepare(
      "SELECT id, path FROM autohdr_path_claims WHERE handoff_id = ? ORDER BY candidate LIMIT 1",
    ).bind(first.handoffId).first<{ id: string; path: string }>();
    await database.DB.batch([
      database.DB.prepare("UPDATE autohdr_handoffs SET state = 'failed' WHERE id = ?").bind(first.handoffId),
      database.DB.prepare("UPDATE autohdr_output_mappings SET state = 'retired' WHERE handoff_id = ?").bind(first.handoffId),
      database.DB.prepare("UPDATE autohdr_path_claims SET state = 'tombstone' WHERE handoff_id = ?").bind(first.handoffId),
    ]);

    const result = await claimBackfillAutoHdrHandoff(
      { DB: database.DB } as never,
      data.projectId,
      data.connectionId,
      oldClaim!.path,
      "id:observed-folder",
    );
    expect(result).toMatchObject({ ok: true, handoff: { generation: 2 } });
    if (!result.ok) throw new Error(result.reason);
    const rebound = await database.DB.prepare(
      "SELECT id, handoff_id, mapping_id, folder_id, state FROM autohdr_path_claims WHERE id = ?",
    ).bind(oldClaim!.id).first();
    expect(rebound).toEqual({
      id: oldClaim!.id,
      handoff_id: result.handoff.handoffId,
      mapping_id: result.handoff.mappingId,
      folder_id: "id:observed-folder",
      state: "active",
    });
    const project = await database.DB.prepare(
      "SELECT stage_key FROM projects WHERE id = ?",
    ).bind(data.projectId).first();
    expect(project).toEqual({ stage_key: "editing_autohdr" });
  });

  it("retires a stale scaffold when the live project path is cleared", async () => {
    const data = await fixture();
    const now = Date.now();
    const jobId = crypto.randomUUID();
    const claimId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("UPDATE projects SET raw_folder_path = NULL WHERE id = ?").bind(data.projectId),
      database.DB.prepare(
        "INSERT INTO jobs (id, kind, status, project_id, retries, created_at, updated_at) VALUES (?, 'autohdr_scaffold', 'queued', ?, 0, ?, ?)",
      ).bind(jobId, data.projectId, now, now),
      database.DB.prepare(
        "INSERT INTO autohdr_scaffold_claims (id, project_id, connection_id, scaffold_path, scaffold_path_key, state, created_at, updated_at) VALUES (?, ?, ?, '/AutoHDR/Stale', '/autohdr/stale', 'active', ?, ?)",
      ).bind(claimId, data.projectId, data.connectionId, now, now),
    ]);
    await ensureScaffold(
      { DB: database.DB } as never,
      jobId,
      data.projectId,
    );
    const state = await database.DB.prepare(
      "SELECT sc.state, j.status FROM autohdr_scaffold_claims sc JOIN jobs j ON j.id = ? WHERE sc.id = ?",
    ).bind(jobId, claimId).first();
    expect(state).toEqual({ state: "retired", status: "done" });
  });

  it("concurrent sends create one frozen handoff/mapping and return its owner", async () => {
    const data = await fixture();
    const localEnv = { DB: database.DB } as never;
    const owners = await Promise.all([
      claimAutoHdrHandoff(localEnv, data.projectId, data.userId),
      claimAutoHdrHandoff(localEnv, data.projectId, data.userId),
    ]);
    expect(new Set(owners.map((owner) => owner.handoffId)).size).toBe(1);
    expect(new Set(owners.map((owner) => owner.jobId)).size).toBe(1);
    const counts = await database.DB.prepare(
      "SELECT (SELECT count(*) FROM autohdr_handoffs WHERE project_id = ?) handoffs, " +
      "(SELECT count(*) FROM autohdr_output_mappings WHERE project_id = ?) mappings, " +
      "(SELECT count(*) FROM autohdr_path_claims WHERE project_id = ?) claims",
    ).bind(data.projectId, data.projectId, data.projectId).first<{ handoffs: number; mappings: number; claims: number }>();
    expect(counts).toEqual({ handoffs: 1, mappings: 1, claims: 2 });
  });

  it("blocks a handoff without path claims when archive or stage eligibility changes before its claim batch", async () => {
    for (const mutation of ["archive", "move"] as const) {
      const data = await fixture();
      const localEnv = { DB: database.DB } as never;
      await expect(claimAutoHdrHandoff(localEnv, data.projectId, data.userId, {
        beforeClaimBatch: async () => {
          if (mutation === "archive") {
            await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), data.projectId).run();
          } else {
            await database.DB.prepare("UPDATE projects SET stage_key = 'edited_review' WHERE id = ?").bind(data.projectId).run();
          }
        },
      })).rejects.toThrow("eligibility changed");
      const state = await database.DB.prepare(
        "SELECT h.state, h.last_error, j.status job_status, " +
        "(SELECT count(*) FROM autohdr_output_mappings WHERE project_id = ?) mappings, " +
        "(SELECT count(*) FROM autohdr_path_claims WHERE project_id = ?) claims " +
        "FROM autohdr_handoffs h JOIN jobs j ON j.id = h.job_id WHERE h.project_id = ?",
      ).bind(data.projectId, data.projectId, data.projectId).first<{
        state: string; last_error: string; job_status: string; mappings: number; claims: number;
      }>();
      expect(state).toMatchObject({
        state: "blocked",
        job_status: "failed",
        mappings: 0,
        claims: 0,
      });
      expect(state?.last_error).toContain("active in Raw Review");
    }
  });

  it("manual/webhook/retry callers share one fetch claim and an expired starting owner is recoverable", async () => {
    const data = await fixture();
    const owner = await claimAutoHdrHandoff({ DB: database.DB } as never, data.projectId, data.userId);
    await database.DB.prepare("UPDATE autohdr_handoffs SET state = 'started' WHERE id = ?").bind(owner.handoffId).run();
    const mapping = await database.DB.prepare("SELECT id, generation, connection_id FROM autohdr_output_mappings WHERE handoff_id = ?")
      .bind(owner.handoffId).first<{ id: string; generation: number; connection_id: string }>();
    const route: RoutedAutoHdrMapping = {
      projectId: data.projectId,
      handoffId: owner.handoffId,
      mappingId: mapping!.id,
      generation: mapping!.generation,
      connectionId: mapping!.connection_id,
      finalPath: "/AutoHDR/Claim race/04-FINAL-Photos",
      finalPathKey: "/autohdr/claim race/04-final-photos",
      representativeChangedPath: "/autohdr/claim race/04-final-photos/a.jpg",
    };
    const callers = await Promise.all([
      claimAutoHdrFetch({ DB: database.DB } as never, route, { trigger: "manual" }),
      claimAutoHdrFetch({ DB: database.DB } as never, route, { trigger: "dropbox_delta" }),
      claimAutoHdrFetch({ DB: database.DB } as never, route, { trigger: "dropbox_delta" }),
    ]);
    expect(new Set(callers.map((claim) => claim.claimId)).size).toBe(1);
    await database.DB.prepare("UPDATE autohdr_fetch_claims SET lease_expires_at = 0 WHERE id = ?").bind(callers[0]!.claimId).run();
    const recovered = await claimAutoHdrFetch({ DB: database.DB } as never, route, { trigger: "dropbox_delta" });
    expect(recovered).toMatchObject({ claimId: callers[0]!.claimId, workflowId: callers[0]!.workflowId, reused: true });
  });

  it("a v2 Workflow start failure leaves Raw Review unchanged", async () => {
    const data = await fixture();
    const create = vi.fn(async () => { throw new Error("Workflow unavailable"); });
    const service = new QuincyBackground({} as ExecutionContext, {
      DB: database.DB,
      AUTOHDR_WORKFLOW: { create },
    } as never);
    await expect(service.startAutoHdr(data.projectId, data.userId)).resolves.toMatchObject({
      ok: false,
      message: "Workflow unavailable",
    });
    const project = await database.DB.prepare("SELECT stage_key FROM projects WHERE id = ?").bind(data.projectId).first();
    expect(project).toEqual({ stage_key: "raw_review" });
    const job = await database.DB.prepare("SELECT status, error FROM jobs WHERE project_id = ? AND kind = 'autohdr'").bind(data.projectId).first();
    expect(job).toEqual({ status: "failed", error: "Workflow unavailable" });
    expect(create).toHaveBeenCalledOnce();
  });

  it("confirms a handoff once with one attributed audit and never regresses a later staff stage", async () => {
    const data = await fixture();
    const owner = await claimAutoHdrHandoff({ DB: database.DB } as never, data.projectId, data.userId);
    const handoff = await database.DB.prepare("SELECT connection_id, generation FROM autohdr_handoffs WHERE id = ?")
      .bind(owner.handoffId).first<{ connection_id: string; generation: number }>();
    const input = {
      projectId: data.projectId,
      handoffId: owner.handoffId,
      connectionId: handoff!.connection_id,
      mappingGeneration: handoff!.generation,
      initiatedBy: data.userId,
      jobId: owner.jobId,
    };
    const confirmed = await Promise.all([
      confirmAutoHdrHandoff({ DB: database.DB } as never, input),
      confirmAutoHdrHandoff({ DB: database.DB } as never, input),
    ]);
    expect(confirmed).toEqual([true, true]);
    const audits = await database.DB.prepare("SELECT actor_id FROM audit_log WHERE target_id = ? AND action = 'stage.auto_advance'").bind(data.projectId).all();
    expect(audits.results).toEqual([{ actor_id: data.userId }]);
    await database.DB.prepare("UPDATE projects SET stage_key = 'delivered' WHERE id = ?").bind(data.projectId).run();
    await confirmAutoHdrHandoff({ DB: database.DB } as never, input);
    const project = await database.DB.prepare("SELECT stage_key FROM projects WHERE id = ?").bind(data.projectId).first();
    expect(project).toEqual({ stage_key: "delivered" });
    const auditCount = await database.DB.prepare("SELECT count(*) count FROM audit_log WHERE target_id = ? AND action = 'stage.auto_advance'").bind(data.projectId).first<{ count: number }>();
    expect(auditCount?.count).toBe(1);
  });

  it("atomically promotes one pending candidate and blocks if its sibling appears later", async () => {
    const data = await fixture();
    const localEnv = { DB: database.DB } as never;
    const owner = await claimAutoHdrHandoff(localEnv, data.projectId, data.userId);
    const handoff = await database.DB.prepare("SELECT connection_id, generation FROM autohdr_handoffs WHERE id = ?")
      .bind(owner.handoffId).first<{ connection_id: string; generation: number }>();
    await confirmAutoHdrHandoff(localEnv, {
      projectId: data.projectId, handoffId: owner.handoffId,
      connectionId: handoff!.connection_id, mappingGeneration: handoff!.generation,
      initiatedBy: data.userId, jobId: owner.jobId,
    });
    const claims = await database.DB.prepare("SELECT path, path_key FROM autohdr_path_claims WHERE handoff_id = ? ORDER BY candidate")
      .bind(owner.handoffId).all<{ path: string; path_key: string }>();
    const first = claims.results[0]!;
    const promoted = await routeAutoHdrDelta(dbFor(localEnv), handoff!.connection_id, [{
      ".tag": "file", id: "id:first", name: "first.jpg", size: 1,
      path_lower: `${first.path_key}/first.jpg`, path_display: `${first.path}/first.jpg`,
    }]);
    expect(promoted.routes).toHaveLength(1);
    const sibling = claims.results[1]!;
    const blocked = await routeAutoHdrDelta(dbFor(localEnv), handoff!.connection_id, [{
      ".tag": "folder", id: "id:sibling", name: sibling.path.split("/").at(-1)!,
      path_lower: sibling.path_key, path_display: sibling.path,
    }]);
    expect(blocked.routes).toHaveLength(0);
    expect(blocked.blocked).toBe(1);
    const mapping = await database.DB.prepare("SELECT state FROM autohdr_output_mappings WHERE handoff_id = ?").bind(owner.handoffId).first();
    expect(mapping).toEqual({ state: "blocked_collision" });
  });

  it("blocks rather than overwriting when opposite candidates promote concurrently", async () => {
    const data = await fixture();
    const localEnv = { DB: database.DB } as never;
    const owner = await claimAutoHdrHandoff(localEnv, data.projectId, data.userId);
    const handoff = await database.DB.prepare("SELECT connection_id, generation FROM autohdr_handoffs WHERE id = ?")
      .bind(owner.handoffId).first<{ connection_id: string; generation: number }>();
    await confirmAutoHdrHandoff(localEnv, {
      projectId: data.projectId, handoffId: owner.handoffId,
      connectionId: handoff!.connection_id, mappingGeneration: handoff!.generation,
      initiatedBy: data.userId, jobId: owner.jobId,
    });
    const claims = await database.DB.prepare("SELECT path, path_key FROM autohdr_path_claims WHERE handoff_id = ? ORDER BY candidate")
      .bind(owner.handoffId).all<{ path: string; path_key: string }>();
    await Promise.all(claims.results.map((claim, index) => routeAutoHdrDelta(
      dbFor(localEnv),
      handoff!.connection_id,
      [{
        ".tag": "file",
        id: `id:concurrent-${index}`,
        name: `candidate-${index}.jpg`,
        size: 1,
        path_lower: `${claim.path_key}/candidate-${index}.jpg`,
        path_display: `${claim.path}/candidate-${index}.jpg`,
      }],
    )));
    const mapping = await database.DB.prepare("SELECT state, diagnostic FROM autohdr_output_mappings WHERE handoff_id = ?")
      .bind(owner.handoffId).first<{ state: string; diagnostic: string | null }>();
    expect(mapping?.state).toBe("blocked_collision");
    expect(mapping?.diagnostic).toMatch(/concurrently|Both AutoHDR/);
  });

  it("blocks both affected mappings on a permanent connection/path collision", async () => {
    const first = await fixture();
    const second = await fixture();
    const localEnv = { DB: database.DB } as never;
    await claimAutoHdrHandoff(localEnv, first.projectId, first.userId);
    const firstPath = await database.DB.prepare("SELECT raw_folder_path FROM projects WHERE id = ?")
      .bind(first.projectId).first<{ raw_folder_path: string }>();
    await database.DB.prepare("UPDATE projects SET raw_folder_path = ? WHERE id = ?")
      .bind(firstPath!.raw_folder_path, second.projectId).run();
    await expect(claimAutoHdrHandoff(localEnv, second.projectId, second.userId))
      .rejects.toThrow("path claim collision");
    const blocked = await database.DB.prepare(
      "SELECT count(*) count FROM autohdr_output_mappings WHERE project_id in (?, ?) AND state = 'blocked_collision'",
    ).bind(first.projectId, second.projectId).first<{ count: number }>();
    expect(blocked?.count).toBe(2);
  });
});
