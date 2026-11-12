import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createDb } from "@quincy/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { jobs } from "@quincy/db/schema";
import { editorInitialSyncRecoveryQuery, editorMoveRecoveryQuery } from "../src/editor-folders/recovery-queries";

declare const __PORTAL_MIGRATION_SQL__: string;
const database = env as unknown as { DB: D1Database };
const db = createDb(database.DB);

async function executeSql(source: string) {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const text = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of text.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

beforeAll(() => executeSql(__PORTAL_MIGRATION_SQL__));

const NOW = 1_800_000_000_000;
const KIND_CREATED = "jobs_project_kind_created_idx";
const STATUS_KIND_UPDATED = "jobs_project_status_kind_updated_idx";

async function plan(query: { toSQL: () => { sql: string; params: unknown[] } }): Promise<string[]> {
  const { sql: text, params } = query.toSQL();
  const result = await database.DB.prepare(`EXPLAIN QUERY PLAN ${text}`).bind(...(params as never[])).all<{ detail: string }>();
  return result.results.map((row) => row.detail);
}

/** Every plan line that reads `jobs` (alias j, or the bare table for the delete guards). */
const jobLines = (lines: string[]) => lines.filter((line) => /\b(SCAN|SEARCH) (j|jobs)\b/u.test(line));

function expectNoScan(lines: string[]) {
  expect(lines.filter((line) => /\bSCAN (j|jobs)\b/u.test(line)), lines.join("\n")).toEqual([]);
}

function expectSearch(lines: string[], index: string, columns: RegExp) {
  const hit = lines.find((line) => line.includes(`INDEX ${index}`));
  expect(hit, lines.join("\n")).toBeDefined();
  expect(hit, "must bind the full column list, not a prefix").toMatch(columns);
}

async function seedPopulation() {
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('plan-p1', 'S', 'awaiting_raw', ?, ?)").bind(now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('plan-p2', 'S', 'awaiting_raw', ?, ?)").bind(now, now),
  ]);
  for (const [project, kind, status] of [["plan-p1", "editor_reconcile", "done"], ["plan-p2", "editor_reconcile", "done"], ["plan-p1", "dropbox_sync", "done"], ["plan-p2", "editor_sync", "queued"]] as const) {
    await database.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 199)
      INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) SELECT ? || i, ?, ?, ?, ? - i * 3600000, ? - i * 3600000 FROM n`)
      .bind(`${project}-${kind}-${status}-`, kind, status, project, NOW, NOW).run();
  }
}

describe("Editor folder recovery selects: query plan", () => {
  it("move select searches jobs through both new indexes with the time range bound, with no stats", async () => {
    const lines = await plan(editorMoveRecoveryQuery(db, NOW));
    expectNoScan(jobLines(lines));
    expectSearch(lines, KIND_CREATED, /project_id=\? AND kind=\? AND created_at>\?/u);
    expectSearch(lines, STATUS_KIND_UPDATED, /project_id=\? AND status=\? AND kind=\? AND updated_at>\?/u);
  });

  it("initial-sync select uses the status/kind/updated index without scanning jobs", async () => {
    const lines = await plan(editorInitialSyncRecoveryQuery(db, NOW));
    expectNoScan(jobLines(lines));
    expectSearch(lines, STATUS_KIND_UPDATED, /project_id=\? AND status=\? AND kind=\? AND updated_at>\?/u);
  });

  it("holds the same plans after ANALYZE on a populated jobs table", async () => {
    await seedPopulation();
    try {
      await database.DB.exec("ANALYZE;");
    } catch (error) {
      // Local D1 may refuse ANALYZE. The no-stats plans above are the ones that matter in production, so carry on.
      console.warn("ANALYZE refused by local D1; skipping the with-stats comparison", error instanceof Error ? error.message : error);
      return;
    }
    const move = await plan(editorMoveRecoveryQuery(db, NOW));
    expectNoScan(jobLines(move));
    expectSearch(move, KIND_CREATED, /project_id=\? AND kind=\? AND created_at>\?/u);
    expectSearch(move, STATUS_KIND_UPDATED, /project_id=\? AND status=\? AND kind=\? AND updated_at>\?/u);
    const initial = await plan(editorInitialSyncRecoveryQuery(db, NOW));
    expectNoScan(jobLines(initial));
  });

  it("keeps the bound-status delete guards off a jobs scan", async () => {
    const byProject = db.select({ count: sql<number>`count(*)` }).from(jobs).where(and(eq(jobs.projectId, "p"), inArray(jobs.status, ["queued", "running"])));
    const lines = await plan(byProject);
    expectNoScan(jobLines(lines));
    expect(jobLines(lines).join("\n")).toContain(STATUS_KIND_UPDATED);
    const withKind = db.select({ count: sql<number>`count(*)` }).from(jobs).where(and(eq(jobs.projectId, "p"), inArray(jobs.status, ["queued", "running"]), sql`${jobs.kind} != 'asset_delete'`));
    const kindLines = await plan(withKind);
    expectNoScan(jobLines(kindLines));
    expect(jobLines(kindLines).join("\n")).toContain(STATUS_KIND_UPDATED);
  });
});

describe("Editor folder move select: rows read", () => {
  it("reads under 300 rows with ~2,000 old done reconcile jobs on the project", async () => {
    const now = Date.now();
    const suffix = crypto.randomUUID();
    const connectionId = `rr-connection-${suffix}`;
    const projectId = `rr-project-${suffix}`;
    await database.DB.batch([
      database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
      database.DB.prepare("INSERT INTO projects (id, street, shoot_date, stage_key, created_at, updated_at) VALUES (?, 'S', '2027-01-15', 'awaiting_raw', ?, ?)").bind(projectId, now, now),
      database.DB.prepare(`INSERT INTO editor_folder_mappings (
        id, project_id, connection_id, root_path, root_path_key, root_folder_id, shoot_date, project_folder_name,
        photographer_evidence_json, input_roots_json, output_roots_json, editing_notes_path, editing_notes_folder_id,
        state, root_revision, move_commit_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, '/E/rr', ?, 'id:rr', '2026-10-02', 'rr', '{}', '[]', '[]', '/E/rr/n', 'id:n', 'ready', 0, 0, ?, ?)`)
        .bind(`rr-mapping-${suffix}`, projectId, connectionId, `/e/rr-${suffix}`, now, now),
    ]);
    await database.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 1999)
      INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) SELECT ? || i, 'editor_reconcile', 'done', ?, ? - 3600000 - i * 60000, ? - 3600000 - i * 60000 FROM n`)
      .bind(`rr-old-${suffix}-`, projectId, now, now).run();

    const { sql: text, params } = editorMoveRecoveryQuery(db, now).toSQL();
    const result = await database.DB.prepare(text).bind(...(params as never[])).all<{ project_id: string }>();
    expect(result.results.map((row) => row.project_id)).toContain(projectId);
    expect(result.meta.rows_read).toBeLessThan(300);
  });
});
