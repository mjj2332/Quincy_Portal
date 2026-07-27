import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { claimAutoHdrFetch, claimAutoHdrHandoff, claimBackfillAutoHdrHandoff, claimImplicitAutoHdrHandoff, confirmAutoHdrHandoff } from "../src/autohdr/claims";
import { acquireManualIngestLease, refreshManualIngestLease, releaseManualIngestLease } from "../src/autohdr/manual-supplement";
import { routeAutoHdrDelta, type RoutedAutoHdrMapping } from "../src/autohdr/mapping";
import { routeAutoHdrManualDropDelta, routeAutoHdrProviderDelta } from "../src/autohdr/routers";
import { ensureScaffold } from "../src/autohdr/scaffold";
import { recordSentFiles, removeDeselected, throwOnCopyFailures } from "../src/workflows/autohdr";
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
  return { connectionId: canonicalConnectionId, userId, projectId, assetIds };
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
    await database.DB.prepare("UPDATE autohdr_output_mappings SET state = 'active' WHERE handoff_id = ?").bind(owner.handoffId).run();
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
    if ("routeNoLongerValid" in fetchOwner) throw new Error(fetchOwner.reason);
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
    await database.DB.prepare("UPDATE autohdr_output_mappings SET state = 'active' WHERE handoff_id = ?").bind(owner.handoffId).run();
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
    const validCallers = callers.map((claim) => {
      if ("routeNoLongerValid" in claim) throw new Error(claim.reason);
      return claim;
    });
    expect(new Set(validCallers.map((claim) => claim.claimId)).size).toBe(1);
    await database.DB.prepare("UPDATE autohdr_fetch_claims SET lease_expires_at = 0 WHERE id = ?").bind(validCallers[0]!.claimId).run();
    const recovered = await claimAutoHdrFetch({ DB: database.DB } as never, route, { trigger: "dropbox_delta" });
    if ("routeNoLongerValid" in recovered) throw new Error(recovered.reason);
    expect(recovered).toMatchObject({ claimId: validCallers[0]!.claimId, workflowId: validCallers[0]!.workflowId, reused: true });
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

describe("repeat AutoHDR sends", () => {
  async function activeRound(stage = "editing_autohdr", closeAssociations = true) {
    const data = await fixture();
    const localEnv = { DB: database.DB } as never;
    const first = await claimAutoHdrHandoff(localEnv, data.projectId, data.userId);
    const now = Date.now();
    const setup = [
      database.DB.prepare("UPDATE projects SET stage_key = ? WHERE id = ?").bind(stage, data.projectId),
      database.DB.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").bind(first.jobId),
      database.DB.prepare("UPDATE autohdr_handoffs SET state = 'started' WHERE id = ?").bind(first.handoffId),
      database.DB.prepare("UPDATE autohdr_output_mappings SET state = 'active', final_path = '/AutoHDR/Repeat/04-FINAL-Photos', final_path_key = '/autohdr/repeat/04-final-photos' WHERE handoff_id = ?").bind(first.handoffId),
      database.DB.prepare("UPDATE autohdr_path_claims SET state = 'active' WHERE handoff_id = ?").bind(first.handoffId),
    ];
    if (closeAssociations) {
      setup.push(...data.assetIds.map((assetId, index) => database.DB.prepare(
        "INSERT INTO autohdr_final_associations (id, handoff_id, asset_id, readiness_unit_key, match_kind, created_at) VALUES (?, ?, ?, ?, 'exact', ?)",
      ).bind(crypto.randomUUID(), first.handoffId, assetId, index === 0 ? "bracket:bracket-a" : `asset:${assetId}`, now)));
    }
    await database.DB.batch(setup);
    return { data, localEnv, first, now };
  }

  async function emptyRemovalHash() {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("[]"));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function insertSentFile(handoffId: string, assetId: string, filename: string) {
    await database.DB.prepare(
      "INSERT INTO autohdr_sent_files (id, handoff_id, asset_id, dropbox_path, dropbox_path_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), handoffId, assetId, `/AutoHDR/Repeat/${filename}`, `/autohdr/repeat/${filename.toLowerCase()}`, Date.now()).run();
  }

  async function insertNextLiveHandoff(data: Awaited<ReturnType<typeof fixture>>, first: { handoffId: string }, connectionId: string) {
    const now = Date.now();
    const jobId = crypto.randomUUID();
    const handoffId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("UPDATE autohdr_handoffs SET state = 'retired', updated_at = ? WHERE id = ?").bind(now, first.handoffId),
      database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, retries, created_at, updated_at) VALUES (?, 'autohdr', 'done', ?, 0, ?, ?)").bind(jobId, data.projectId, now, now),
      database.DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, manifest_version, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, initiated_by, expected_origin_stage, state, workflow_id, job_id, lease_expires_at, created_at, updated_at) VALUES (?, ?, ?, 2, 1, 'next', '[]', '[]', ?, ?, 'editing_autohdr', 'started', ?, ?, ?, ?, ?)")
        .bind(handoffId, data.projectId, connectionId, `/Tonomo/Raw Files/Studio/${data.projectId}`, data.userId, `autohdr-send-${handoffId}`, jobId, now + 600000, now, now),
    ]);
    return { handoffId, jobId };
  }

  it("keeps a same-selection started handoff idempotent and resumes selection drift explicitly", async () => {
    const { data, localEnv, first } = await activeRound();
    await expect(claimAutoHdrHandoff(localEnv, data.projectId, data.userId)).resolves.toMatchObject({ handoffId: first.handoffId, reused: true });
    await database.DB.prepare("DELETE FROM selections WHERE asset_id = (SELECT asset_id FROM selections WHERE selected_by = ? LIMIT 1)").bind(data.userId).run();
    await expect(claimAutoHdrHandoff(localEnv, data.projectId, data.userId, { resumeExisting: true })).resolves.toMatchObject({ handoffId: first.handoffId, reused: true });
  });

  it("persists repeat-send retirement provenance when the starting handoff is resumed", async () => {
    const { data, localEnv, first } = await activeRound("edited_review");
    const next = await claimAutoHdrHandoff(localEnv, data.projectId, data.userId, {
      startNewRound: true,
      removalSetHash: await emptyRemovalHash(),
    });
    expect(next.retiredHandoffId).toBe(first.handoffId);

    await expect(claimAutoHdrHandoff(localEnv, data.projectId, data.userId, { resumeExisting: true }))
      .resolves.toMatchObject({
        handoffId: next.handoffId,
        jobId: next.jobId,
        reused: true,
        retiredHandoffId: first.handoffId,
      });
  });

  it("does not infer retirement provenance for a normal first-time handoff", async () => {
    const data = await fixture();
    const localEnv = { DB: database.DB } as never;
    const first = await claimAutoHdrHandoff(localEnv, data.projectId, data.userId);

    await expect(claimAutoHdrHandoff(localEnv, data.projectId, data.userId, { resumeExisting: true }))
      .resolves.toMatchObject({ handoffId: first.handoffId, reused: true, retiredHandoffId: undefined });
  });

  it("returns one confirmation outcome for a changed selection and refuses pending discovery", async () => {
    const { data, localEnv, first } = await activeRound();
    await database.DB.prepare("DELETE FROM selections WHERE asset_id = (SELECT asset_id FROM selections WHERE selected_by = ? LIMIT 1)").bind(data.userId).run();
    await expect(claimAutoHdrHandoff(localEnv, data.projectId, data.userId)).rejects.toMatchObject({ code: "ERR_HANDOFF_ALREADY_ACTIVE" });
    await database.DB.prepare("UPDATE autohdr_output_mappings SET state = 'pending_discovery' WHERE handoff_id = ?").bind(first.handoffId).run();
    await expect(claimAutoHdrHandoff(localEnv, data.projectId, data.userId, { startNewRound: true, removalSetHash: await emptyRemovalHash() }))
      .rejects.toMatchObject({ code: "ERR_HANDOFF_BLOCKED" });
  });

  it("fences an in-flight fetch before retirement and reclaims the same path rows after coverage closes", async () => {
    const { data, localEnv, first } = await activeRound("edited_review");
    const mapping = await database.DB.prepare("SELECT id, generation, connection_id FROM autohdr_output_mappings WHERE handoff_id = ?").bind(first.handoffId).first<{ id: string; generation: number; connection_id: string }>();
    const route = { projectId: data.projectId, handoffId: first.handoffId, mappingId: mapping!.id, generation: mapping!.generation, connectionId: mapping!.connection_id, finalPath: "/AutoHDR/Repeat/04-FINAL-Photos", finalPathKey: "/autohdr/repeat/04-final-photos", representativeChangedPath: "/AutoHDR/Repeat/04-FINAL-Photos/a.jpg" };
    const fetch = await claimAutoHdrFetch(localEnv, route, { trigger: "dropbox_delta" });
    if ("routeNoLongerValid" in fetch) throw new Error(fetch.reason);
    await expect(claimAutoHdrHandoff(localEnv, data.projectId, data.userId, { startNewRound: true, removalSetHash: await emptyRemovalHash() }))
      .rejects.toMatchObject({ code: "ERR_FETCH_IN_PROGRESS" });
    await database.DB.prepare("UPDATE autohdr_fetch_claims SET state = 'done' WHERE id = ?").bind(fetch.claimId).run();
    const next = await claimAutoHdrHandoff(localEnv, data.projectId, data.userId, { startNewRound: true, removalSetHash: await emptyRemovalHash() });
    expect(next.reused).toBe(false);
    expect(next.retiredHandoffId).toBe(first.handoffId);
    const state = await database.DB.prepare("SELECT state FROM autohdr_handoffs WHERE id = ?").bind(first.handoffId).first();
    expect(state).toEqual({ state: "retired" });
    const claims = await database.DB.prepare("SELECT id, state, handoff_id FROM autohdr_path_claims WHERE project_id = ? ORDER BY candidate").bind(data.projectId).all<{ id: string; state: string; handoff_id: string }>();
    expect(claims.results).toHaveLength(2);
    expect(claims.results.every((claim) => claim.state === "pending" && claim.handoff_id === next.handoffId)).toBe(true);
  });

  it("fences an in-flight manual ingest, reports its pinned error, and retires after release", async () => {
    const { data, localEnv, first } = await activeRound("edited_review");
    const mapping = await database.DB.prepare("SELECT id FROM autohdr_output_mappings WHERE handoff_id = ?")
      .bind(first.handoffId).first<{ id: string }>();
    const ownerToken = await acquireManualIngestLease(localEnv, mapping!.id);
    expect(ownerToken).toEqual(expect.any(String));
    await expect(claimAutoHdrHandoff(localEnv, data.projectId, data.userId, {
      startNewRound: true,
      removalSetHash: await emptyRemovalHash(),
    })).rejects.toMatchObject({ code: "ERR_MANUAL_INGEST_IN_PROGRESS" });
    await releaseManualIngestLease(localEnv, mapping!.id, ownerToken!);
    await expect(claimAutoHdrHandoff(localEnv, data.projectId, data.userId, {
      startNewRound: true,
      removalSetHash: await emptyRemovalHash(),
    })).resolves.toMatchObject({ retiredHandoffId: first.handoffId });
  });

  it("does not acquire for a mapping retired before acquisition", async () => {
    const { data, localEnv, first } = await activeRound("edited_review");
    const mapping = await database.DB.prepare("SELECT id FROM autohdr_output_mappings WHERE handoff_id = ?")
      .bind(first.handoffId).first<{ id: string }>();
    await expect(claimAutoHdrHandoff(localEnv, data.projectId, data.userId, {
      startNewRound: true,
      removalSetHash: await emptyRemovalHash(),
    })).resolves.toMatchObject({ retiredHandoffId: first.handoffId });
    await expect(acquireManualIngestLease(localEnv, mapping!.id)).resolves.toBeNull();
  });

  it("lets an unrelated mapping retire and lets an expired lease recover", async () => {
    const firstCase = await activeRound("edited_review");
    const firstMapping = await database.DB.prepare("SELECT id FROM autohdr_output_mappings WHERE handoff_id = ?")
      .bind(firstCase.first.handoffId).first<{ id: string }>();
    const firstToken = await acquireManualIngestLease(firstCase.localEnv, firstMapping!.id);

    const secondCase = await activeRound("edited_review");
    await expect(claimAutoHdrHandoff(secondCase.localEnv, secondCase.data.projectId, secondCase.data.userId, {
      startNewRound: true,
      removalSetHash: await emptyRemovalHash(),
    })).resolves.toMatchObject({ retiredHandoffId: secondCase.first.handoffId });

    await database.DB.prepare("UPDATE autohdr_manual_ingest_leases SET lease_expires_at = ? WHERE mapping_id = ?")
      .bind(Date.now() - 1, firstMapping!.id).run();
    await expect(refreshManualIngestLease(firstCase.localEnv, firstMapping!.id, firstToken!, Date.now(), Date.now() + 60_000)).resolves.toBe(false);
    await expect(claimAutoHdrHandoff(firstCase.localEnv, firstCase.data.projectId, firstCase.data.userId, {
      startNewRound: true,
      removalSetHash: await emptyRemovalHash(),
    })).resolves.toMatchObject({ retiredHandoffId: firstCase.first.handoffId });
  });

  it("returns route-no-longer-valid and leaves no orphan job for a retired fetch route", async () => {
    const { data, localEnv, first } = await activeRound();
    const mapping = await database.DB.prepare("SELECT id, generation, connection_id FROM autohdr_output_mappings WHERE handoff_id = ?").bind(first.handoffId).first<{ id: string; generation: number; connection_id: string }>();
    const route = { projectId: data.projectId, handoffId: first.handoffId, mappingId: mapping!.id, generation: mapping!.generation, connectionId: mapping!.connection_id, finalPath: "/AutoHDR/Repeat/04-FINAL-Photos", finalPathKey: "/autohdr/repeat/04-final-photos", representativeChangedPath: "/AutoHDR/Repeat/04-FINAL-Photos/a.jpg" };
    await database.DB.batch([
      database.DB.prepare("UPDATE autohdr_output_mappings SET state = 'retired' WHERE id = ?").bind(mapping!.id),
      database.DB.prepare("UPDATE autohdr_handoffs SET state = 'retired' WHERE id = ?").bind(first.handoffId),
    ]);
    const result = await claimAutoHdrFetch(localEnv, route, { trigger: "manual" });
    expect(result).toMatchObject({ routeNoLongerValid: true });
    const jobs = await database.DB.prepare("SELECT count(*) count FROM jobs WHERE project_id = ? AND kind = 'fetch_edited'").bind(data.projectId).first<{ count: number }>();
    expect(jobs?.count).toBe(0);
  });

  it("returns the distinct removal-set-changed code for a stale confirmation hash", async () => {
    const { data, localEnv } = await activeRound();
    await expect(claimAutoHdrHandoff(localEnv, data.projectId, data.userId, {
      startNewRound: true, removalSetHash: "stale-confirmation-hash",
    })).rejects.toMatchObject({ code: "ERR_REMOVAL_SET_CHANGED" });
  });

  it("allows a repeat send that overlaps an open prior delivery once the prior send job has finished", async () => {
    const { data, localEnv, first } = await activeRound("edited_review", false);
    const next = await claimAutoHdrHandoff(localEnv, data.projectId, data.userId, {
      startNewRound: true, removalSetHash: await emptyRemovalHash(),
    });
    expect(next.reused).toBe(false);
    expect(next.retiredHandoffId).toBe(first.handoffId);
  });

  it("fences retirement when the old send job is still active and when its sent-file count changed", async () => {
    const firstCase = await activeRound();
    await database.DB.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").bind(firstCase.first.jobId).run();
    await expect(claimAutoHdrHandoff(firstCase.localEnv, firstCase.data.projectId, firstCase.data.userId, {
      startNewRound: true, removalSetHash: await emptyRemovalHash(),
    })).rejects.toMatchObject({ code: "ERR_SEND_IN_PROGRESS" });
    await expect(database.DB.prepare("SELECT state FROM autohdr_handoffs WHERE id = ?").bind(firstCase.first.handoffId).first())
      .resolves.toEqual({ state: "started" });

    const secondCase = await activeRound();
    await database.DB.prepare("DELETE FROM selections WHERE asset_id = ?").bind(secondCase.data.assetIds[0]).run();
    await insertSentFile(secondCase.first.handoffId, secondCase.data.assetIds[0]!, "capture-0.jpg");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([secondCase.data.assetIds[0]])));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    await expect(claimAutoHdrHandoff(secondCase.localEnv, secondCase.data.projectId, secondCase.data.userId, {
      startNewRound: true, removalSetHash: hash,
    }, {
      beforeRepeatBatch: async () => { await insertSentFile(secondCase.first.handoffId, secondCase.data.assetIds[1]!, "capture-1.jpg"); },
    })).rejects.toMatchObject({ code: "ERR_HANDOFF_BLOCKED" });
    await expect(database.DB.prepare("SELECT state FROM autohdr_handoffs WHERE id = ?").bind(secondCase.first.handoffId).first())
      .resolves.toEqual({ state: "started" });
  });

  it("records successful copy entries before a mixed batch failure and is safe to retry", async () => {
    const { data, first } = await activeRound();
    const input = { projectId: data.projectId, assetIds: data.assetIds, jobId: first.jobId, handoffId: first.handoffId };
    const entries = [
      { ".tag": "success" as const },
      { ".tag": "failure" as const, failure: { ".tag": "from_lookup", reason: "missing source" } },
    ];
    await recordSentFiles({ DB: database.DB } as never, input, entries, [
      { assetId: data.assetIds[0]!, toPath: "/AutoHDR/Repeat/capture-0.jpg" },
      { assetId: data.assetIds[1]!, toPath: "/AutoHDR/Repeat/capture-1.jpg" },
    ]);
    expect(() => throwOnCopyFailures(entries, [
      { from_path: "/raw/capture-0.jpg", to_path: "/AutoHDR/Repeat/capture-0.jpg" },
      { from_path: "/raw/capture-1.jpg", to_path: "/AutoHDR/Repeat/capture-1.jpg" },
    ])).toThrow("copy_batch_v2 failed");
    await recordSentFiles({ DB: database.DB } as never, input, entries, [
      { assetId: data.assetIds[0]!, toPath: "/AutoHDR/Repeat/capture-0.jpg" },
      { assetId: data.assetIds[1]!, toPath: "/AutoHDR/Repeat/capture-1.jpg" },
    ]);
    await expect(database.DB.prepare("SELECT asset_id, dropbox_path FROM autohdr_sent_files WHERE handoff_id = ? ORDER BY asset_id").bind(first.handoffId).all())
      .resolves.toMatchObject({ results: [{ asset_id: data.assetIds[0], dropbox_path: "/AutoHDR/Repeat/capture-0.jpg" }] });
  });

  it("records a fallback upload immediately after upload success", async () => {
    const { data, first } = await activeRound();
    await recordSentFiles({ DB: database.DB } as never, {
      projectId: data.projectId, assetIds: data.assetIds, jobId: first.jobId, handoffId: first.handoffId,
    }, [{ ".tag": "success" }], [{ assetId: data.assetIds[1]!, toPath: "/AutoHDR/Repeat/fallback.jpg" }]);
    await expect(database.DB.prepare("SELECT asset_id, dropbox_path FROM autohdr_sent_files WHERE handoff_id = ?").bind(first.handoffId).all())
      .resolves.toMatchObject({ results: [{ asset_id: data.assetIds[1], dropbox_path: "/AutoHDR/Repeat/fallback.jpg" }] });
  });

  it("stops writer-side provenance after the handoff is retired", async () => {
    const { data, first } = await activeRound();
    await database.DB.prepare("UPDATE autohdr_handoffs SET state = 'retired' WHERE id = ?").bind(first.handoffId).run();
    await recordSentFiles({ DB: database.DB } as never, {
      projectId: data.projectId, assetIds: data.assetIds, jobId: first.jobId, handoffId: first.handoffId,
    }, [{ ".tag": "success" }], [{ assetId: data.assetIds[0]!, toPath: "/AutoHDR/Repeat/late.jpg" }]);
    await expect(database.DB.prepare("SELECT count(*) count FROM autohdr_sent_files WHERE handoff_id = ?").bind(first.handoffId).first())
      .resolves.toEqual({ count: 0 });
  });

  it("deletes only deselected provenance, uses the retiring connection, and audits the outcome", async () => {
    const { data, first } = await activeRound();
    await insertSentFile(first.handoffId, data.assetIds[0]!, "capture-0.jpg");
    await insertSentFile(first.handoffId, data.assetIds[1]!, "capture-1.jpg");
    const folder = new Set(["/autohdr/repeat/capture-0.jpg", "/autohdr/repeat/capture-1.jpg"]);
    const calls: { path: string; connectionId?: string }[] = [];
    const audit: unknown[] = [];
    const result = await removeDeselected({ DB: database.DB } as never, {
      projectId: data.projectId, assetIds: [data.assetIds[1]!], jobId: first.jobId,
      handoffId: first.handoffId, retiredHandoffId: first.handoffId,
    }, {
      getMetadata: async (_env, _db, path, connectionId) => {
        calls.push({ path, connectionId });
        if (!folder.has(path)) throw new Error("path_lookup/not_found");
        return { ".tag": "file", name: "capture-0.jpg", path_lower: path, id: "id:file", size: 1 };
      },
      deleteBatch: async (_env, _db, entries, connectionId) => {
        calls.push({ path: entries[0]!.path, connectionId });
        for (const entry of entries) folder.delete(entry.path.toLowerCase());
        return { ".tag": "complete", entries: [{ ".tag": "success" }] };
      },
      writeAuditLog: async (summary) => { audit.push(summary); },
    });
    expect(result).toEqual({ removed: 1, alreadyGone: 0, failed: 0 });
    expect(calls).toEqual([
      { path: "/autohdr/repeat/capture-0.jpg", connectionId: data.connectionId },
      { path: "/AutoHDR/Repeat/capture-0.jpg", connectionId: data.connectionId },
    ]);
    expect(audit).toMatchObject([{ removed: 1, alreadyGone: 0, failed: [] }]);
    expect([...folder]).toEqual(["/autohdr/repeat/capture-1.jpg"]);
  });

  it("uses the retiring generation connection when generations have different connections", async () => {
    const { data, first } = await activeRound();
    const retiringConnection = data.connectionId;
    const nextConnection = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)")
      .bind(nextConnection, Date.now(), Date.now()).run();
    const next = await insertNextLiveHandoff(data, first, nextConnection);
    await insertSentFile(first.handoffId, data.assetIds[0]!, "capture-0.jpg");
    const used: string[] = [];
    await removeDeselected({ DB: database.DB } as never, {
      projectId: data.projectId, assetIds: [], jobId: next.jobId,
      handoffId: next.handoffId, retiredHandoffId: first.handoffId,
    }, {
      getMetadata: async (_env, _db, _path, connectionId) => {
        used.push(connectionId ?? "missing");
        return { ".tag": "file", name: "capture-0.jpg", path_lower: "/autohdr/repeat/capture-0.jpg", id: "id:file", size: 1 };
      },
      deleteBatch: async (_env, _db, _entries, connectionId) => {
        used.push(connectionId ?? "missing");
        return { ".tag": "complete", entries: [{ ".tag": "success" }] };
      },
      writeAuditLog: async () => undefined,
    });
    expect(used).toEqual([retiringConnection, retiringConnection]);
    expect(used).not.toContain(nextConnection);
  });

  it("excludes an existing filename collision, buckets not-found as alreadyGone, and never deletes a folder", async () => {
    const { data, first } = await activeRound();
    const collidingId = crypto.randomUUID();
    const now = Date.now();
    const collection = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(data.projectId).first<{ id: string }>();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'capture-0.jpg', 1, 'upload', ?, ?)")
      .bind(collidingId, collection!.id, `tests/${collidingId}.jpg`, now, now).run();
    await insertSentFile(first.handoffId, data.assetIds[0]!, "capture-0.jpg");
    await insertSentFile(first.handoffId, data.assetIds[1]!, "capture-1.jpg");
    const metadataLookups: string[] = [];
    const deleted: string[] = [];
    const result = await removeDeselected({ DB: database.DB } as never, {
      projectId: data.projectId, assetIds: [collidingId], jobId: first.jobId,
      handoffId: first.handoffId, retiredHandoffId: first.handoffId,
    }, {
      getMetadata: async (_env, _db, path) => {
        metadataLookups.push(path);
        if (path.toLowerCase().endsWith("/capture-0.jpg")) {
          return { ".tag": "file", name: "capture-0.jpg", path_lower: path.toLowerCase(), id: "id:collision", size: 1 };
        }
        throw new Error("path_lookup/not_found");
      },
      deleteBatch: async (_env, _db, entries) => { deleted.push(...entries.map((entry) => entry.path)); return { ".tag": "complete", entries: entries.map(() => ({ ".tag": "success" as const })) }; },
      writeAuditLog: async () => undefined,
    });
    expect(result).toEqual({ removed: 0, alreadyGone: 1, failed: 0 });
    expect(metadataLookups).toEqual(["/autohdr/repeat/capture-1.jpg"]);
    expect(metadataLookups).not.toContain("/autohdr/repeat/capture-0.jpg");
    expect(deleted).toEqual([]);
  });

  it("treats a recorded folder as failed and never sends it to delete_batch", async () => {
    const { data, first } = await activeRound();
    await insertSentFile(first.handoffId, data.assetIds[0]!, "capture-0.jpg");
    const deleted: string[] = [];
    const result = await removeDeselected({ DB: database.DB } as never, {
      projectId: data.projectId, assetIds: [], jobId: first.jobId,
      handoffId: first.handoffId, retiredHandoffId: first.handoffId,
    }, {
      getMetadata: async (_env, _db, path) => ({ ".tag": "folder", name: "capture-0.jpg", path_lower: path, id: "id:folder" }),
      deleteBatch: async (_env, _db, entries) => { deleted.push(...entries.map((entry) => entry.path)); return { ".tag": "complete", entries: [] }; },
      writeAuditLog: async () => undefined,
    });
    expect(result).toEqual({ removed: 0, alreadyGone: 0, failed: 1 });
    expect(deleted).toEqual([]);
  });

  it("skips cleanup after archive and contains its audit-write failure", async () => {
    const { data, first } = await activeRound();
    await insertSentFile(first.handoffId, data.assetIds[0]!, "capture-0.jpg");
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), data.projectId).run();
    const deleteBatch = vi.fn(async () => ({ ".tag": "async_job_id" as const, async_job_id: "never" }));
    const deleteBatchCheck = vi.fn(async () => ({ ".tag": "in_progress" as const }));
    const getMetadata = vi.fn(async (_env: unknown, _db: unknown, path: string) => ({ ".tag": "file" as const, name: "capture-0.jpg", path_lower: path, id: "id:file", size: 1 }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await removeDeselected({ DB: database.DB } as never, {
        projectId: data.projectId, assetIds: [], jobId: first.jobId,
        handoffId: first.handoffId, retiredHandoffId: first.handoffId,
      }, { getMetadata, deleteBatch, deleteBatchCheck, writeAuditLog: async () => { throw new Error("audit unavailable"); } });
      expect(result.failed).toBe(1);
      expect(getMetadata).toHaveBeenCalledTimes(1);
      expect(deleteBatch).not.toHaveBeenCalled();
      expect(deleteBatchCheck).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("contains delete poll exhaustion and its audit-write failure", async () => {
    const { data, first } = await activeRound();
    await insertSentFile(first.handoffId, data.assetIds[0]!, "capture-0.jpg");
    const deleteBatch = vi.fn(async () => ({ ".tag": "async_job_id" as const, async_job_id: "never" }));
    const deleteBatchCheck = vi.fn(async () => ({ ".tag": "in_progress" as const }));
    const getMetadata = vi.fn(async (_env: unknown, _db: unknown, path: string) => ({ ".tag": "file" as const, name: "capture-0.jpg", path_lower: path, id: "id:file", size: 1 }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await removeDeselected({ DB: database.DB } as never, {
        projectId: data.projectId, assetIds: [], jobId: first.jobId,
        handoffId: first.handoffId, retiredHandoffId: first.handoffId,
      }, { getMetadata, deleteBatch, deleteBatchCheck, writeAuditLog: async () => { throw new Error("audit unavailable"); } });
      expect(result).toEqual({ removed: 0, alreadyGone: 0, failed: 1 });
      expect(getMetadata).toHaveBeenCalledTimes(1);
      expect(deleteBatch).toHaveBeenCalledTimes(1);
      expect(deleteBatchCheck).toHaveBeenCalledTimes(45);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("audits a removal-set query failure instead of returning before the summary write", async () => {
    const { data, first } = await activeRound();
    const audit: unknown[] = [];
    const result = await removeDeselected({ DB: database.DB } as never, {
      projectId: data.projectId, assetIds: data.assetIds, jobId: first.jobId,
      handoffId: first.handoffId, retiredHandoffId: first.handoffId,
    }, {
      loadSent: async () => { throw new Error("sent-file query failed"); },
      writeAuditLog: async (summary) => { audit.push(summary); },
    });
    expect(result).toEqual({ removed: 0, alreadyGone: 0, failed: 1 });
    expect(audit).toMatchObject([{ failed: [{ assetId: "remove-deselected", reason: "sent-file query failed" }] }]);
  });
});
