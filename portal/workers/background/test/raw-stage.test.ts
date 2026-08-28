import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { guardedStageTransition } from "@quincy/db";
import { renewRawReconciliationClaim } from "../src/dropbox/sync";

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
beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'");
});

async function project(stage = "awaiting_raw", archived = false) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, archived_at, created_at, updated_at) VALUES (?, 'RAW stage race', ?, ?, ?, ?)")
    .bind(id, stage, archived ? now : null, now, now).run();
  return id;
}

describe("durable RAW stage commit", () => {
  it("concurrent qualifying intake advances once with exactly one system audit", async () => {
    const projectId = await project();
    const attempts = await Promise.all([
      guardedStageTransition(database.DB, { projectId, from: "awaiting_raw", to: "raw_review", meta: { trigger: "dropbox_delta", durableRawEvidence: { newlyImported: 1, currentRawAvailable: true } } }),
      guardedStageTransition(database.DB, { projectId, from: "awaiting_raw", to: "raw_review", meta: { trigger: "direct_upload", durableRawEvidence: { newlyImported: 1, currentRawAvailable: true } } }),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const row = await database.DB.prepare("SELECT stage_key, board_position, board_revision FROM projects WHERE id = ?").bind(projectId).first();
    expect(row).toMatchObject({ stage_key: "raw_review", board_revision: 1 });
    const audits = await database.DB.prepare("SELECT actor_id, action, meta_json FROM audit_log WHERE target_id = ?").bind(projectId).all();
    expect(audits.results).toHaveLength(1);
    expect(audits.results[0]).toMatchObject({ actor_id: null, action: "stage.auto_advance" });
  });

  it("archive and later-stage races lose safely without regressions or audits", async () => {
    for (const [stage, archived] of [["delivered", false], ["awaiting_raw", true]] as const) {
      const projectId = await project(stage, archived);
      await expect(guardedStageTransition(database.DB, {
        projectId, from: "awaiting_raw", to: "raw_review",
        meta: { trigger: "manual_dropbox_sync", durableRawEvidence: { newlyImported: 0, currentRawAvailable: true } },
      })).resolves.toBe(false);
      const row = await database.DB.prepare("SELECT stage_key FROM projects WHERE id = ?").bind(projectId).first();
      expect(row).toEqual({ stage_key: stage });
      const audit = await database.DB.prepare("SELECT count(*) count FROM audit_log WHERE target_id = ?").bind(projectId).first<{ count: number }>();
      expect(audit?.count).toBe(0);
    }
  });

  it("does not let an expired reconciliation owner renew after a replacement owner takes the lease", async () => {
    const projectId = await project();
    const now = Date.now();
    const oldJobId = crypto.randomUUID();
    const newJobId = crypto.randomUUID();
    const oldClaimId = crypto.randomUUID();
    const newClaimId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'dropbox_sync', 'running', ?, ?, ?)").bind(oldJobId, projectId, now, now),
      database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'dropbox_sync', 'running', ?, ?, ?)").bind(newJobId, projectId, now, now),
      database.DB.prepare("INSERT INTO raw_reconciliation_claims (id, project_id, owner_job_id, state, lease_expires_at, trigger, created_at, updated_at) VALUES (?, ?, ?, 'failed', ?, 'dropbox_delta', ?, ?)").bind(oldClaimId, projectId, oldJobId, now - 1, now, now),
      database.DB.prepare("INSERT INTO raw_reconciliation_claims (id, project_id, owner_job_id, state, lease_expires_at, trigger, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, 'dropbox_delta', ?, ?)").bind(newClaimId, projectId, newJobId, now + 60_000, now, now),
    ]);
    await expect(renewRawReconciliationClaim(database.DB, oldClaimId, oldJobId, now)).resolves.toBe(false);
    await expect(renewRawReconciliationClaim(database.DB, newClaimId, newJobId, now)).resolves.toBe(true);
    const claims = await database.DB.prepare("SELECT id, state FROM raw_reconciliation_claims WHERE project_id = ? ORDER BY id")
      .bind(projectId).all<{ id: string; state: string }>();
    expect(new Map(claims.results.map((row) => [row.id, row.state]))).toEqual(new Map([
      [oldClaimId, "failed"],
      [newClaimId, "running"],
    ]));
  });
});
