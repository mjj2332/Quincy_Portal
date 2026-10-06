import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { processTonomoEvent } from "../src/tonomo/process";
import { commitAutomaticStage } from "../src/lib/automatic-stage";

/**
 * #475 (Board order Stage B): the background Worker reads and writes no `projects.board_position`. The proof is
 * this suite: the migration chain (0064) drops the index and the column, then it drives a Tonomo create (a drizzle
 * insert that used to name the column) and `commitAutomaticStage` under a `raw_reconciliation` premise and an
 * AutoHDR handoff premise. Any `no such column: board_position` throws and fails a test here, which makes Stage B
 * the proof for #476's DROP COLUMN (migration 0064). Same pattern as #373's subtask-assignee-column-dropped.test.ts.
 */
const database = env as unknown as { DB: D1Database };
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(source: string): Promise<void> {
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
}, 60_000);

async function project(stage: string) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Dropped position street', ?, ?, ?)").bind(id, stage, now, now).run();
  return id;
}

describe("with projects.board_position dropped", () => {
  it("the column and its index are really gone", async () => {
    const columns = (await database.DB.prepare("SELECT name FROM pragma_table_info('projects')").all<{ name: string }>()).results.map((row) => row.name);
    expect(columns).not.toContain("board_position");
    expect(columns).toContain("board_revision");
    expect((await database.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'projects_stage_archive_board_order_idx'").all()).results).toEqual([]);
  });

  it("creates a Project from a Tonomo order", async () => {
    const orderId = `order-${crypto.randomUUID()}`;
    const eventId = crypto.randomUUID();
    const payloadJson = JSON.stringify({ id: orderId, street: `${orderId} Dropped Ave` });
    await database.DB.prepare("INSERT INTO webhook_events (id, source, event_id, payload_json, status, received_at) VALUES (?, 'tonomo', ?, ?, 'received', ?)").bind(eventId, `event-${eventId}`, payloadJson, Date.now()).run();
    await processTonomoEvent(env, { id: eventId, payloadJson });
    expect(await database.DB.prepare("SELECT stage_key, board_revision FROM projects WHERE order_id = ?").bind(orderId).first()).toEqual({ stage_key: "awaiting_raw", board_revision: 0 });
  });

  it("commits an Awaiting RAW exit under a raw_reconciliation premise and reports a winner", async () => {
    const projectId = await project("awaiting_raw");
    const outcome = await commitAutomaticStage({
      env: { DB: database.DB }, projectId, from: "awaiting_raw", to: "raw_review", auditId: crypto.randomUUID(),
      auditMetaJson: JSON.stringify({ trigger: "dropbox_delta" }),
      workflow: { kind: "raw_reconciliation", projectId, claimId: null, claimStates: ["running"], shootDate: null },
      alreadyAtDestination: { allowed: true, effect: { kind: "none" } },
    });
    expect(outcome).toMatchObject({ kind: "winner", shootDateFilled: true });
    expect(await database.DB.prepare("SELECT stage_key, board_revision FROM projects WHERE id = ?").bind(projectId).first()).toEqual({ stage_key: "raw_review", board_revision: 1 });
  });

  it("commits a RAW Review to Editing move under an AutoHDR handoff premise and reports a winner", async () => {
    const projectId = await project("raw_review");
    const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES ('conn-dropped', 'dropbox', 'connected', ?, ?) ON CONFLICT(id) DO NOTHING").bind(now, now),
      database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, payload_json, created_at, updated_at) VALUES ('job-dropped', 'autohdr', 'done', ?, '{}', ?, ?)").bind(projectId, now, now),
      database.DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, state, workflow_id, job_id, lease_expires_at, created_at, updated_at) VALUES ('handoff-dropped', ?, 'conn-dropped', 1, 'hash', '[]', '[]', '/Raw/dropped', 'starting', 'workflow', 'job-dropped', ?, ?, ?)").bind(projectId, now + 60_000, now, now),
    ]);
    const outcome = await commitAutomaticStage({
      env: { DB: database.DB }, projectId, from: "raw_review", to: "editing_autohdr", auditId: crypto.randomUUID(),
      auditMetaJson: JSON.stringify({ trigger: "autohdr" }),
      workflow: { kind: "autohdr_handoff", projectId, handoffId: "handoff-dropped", jobId: null, generation: 1, connectionId: "conn-dropped", expectedStates: ["starting"], expectedPriorToken: null },
      coupling: { kind: "handoff_start", handoffId: "handoff-dropped", connectionId: "conn-dropped", generation: 1 },
      alreadyAtDestination: { allowed: false },
    } as never);
    expect(outcome.kind).toBe("winner");
    expect(await database.DB.prepare("SELECT stage_key, board_revision FROM projects WHERE id = ?").bind(projectId).first()).toEqual({ stage_key: "editing_autohdr", board_revision: 1 });
  });
});
