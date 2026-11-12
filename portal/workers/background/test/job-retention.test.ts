import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  JOB_RETENTION_CANDIDATES_SQL,
  JOB_RETENTION_DELETE_SQL,
  JOB_RETENTION_MS,
  JOB_RETENTION_PAGE,
  pruneJobHistory,
} from "../src/lib/job-retention";

declare const __PORTAL_MIGRATION_SQL__: string;
const database = env as unknown as { DB: D1Database };
const DB = database.DB;

async function executeSql(source: string) {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const text = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of text.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await DB.exec(`${flat};`);
    }
  }
}

beforeAll(() => executeSql(__PORTAL_MIGRATION_SQL__));

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const OLD = NOW - 120 * DAY;

beforeEach(async () => {
  await DB.batch([
    DB.prepare("DELETE FROM raw_reconciliation_claims"),
    DB.prepare("DELETE FROM autohdr_fetch_claims"),
    DB.prepare("DELETE FROM autohdr_handoffs"),
    DB.prepare("DELETE FROM jobs"),
    DB.prepare("DELETE FROM projects"),
  ]);
  await DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES ('p1', 'S', 'awaiting_raw', ?, ?)").bind(NOW, NOW).run();
});

async function addProject(id: string) {
  await DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'S', 'awaiting_raw', ?, ?)").bind(id, NOW, NOW).run();
}

type Seed = { id: string; kind?: string; status?: string; project?: string | null; created?: number; updated?: number };
async function seed(...rows: Seed[]) {
  await DB.batch(rows.map((row) => DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.kind ?? "editor_reconcile", row.status ?? "done", row.project === undefined ? "p1" : row.project, row.created ?? OLD, row.updated ?? OLD)));
}

/** An old deletable row needs a newer sibling (same project and kind) so it is not the newest. */
async function newest(project = "p1", kind = "editor_reconcile") {
  await seed({ id: `newest-${project}-${kind}`, kind, project, created: NOW, updated: NOW });
}

const ids = async () => (await DB.prepare("SELECT id FROM jobs ORDER BY id").all<{ id: string }>()).results.map((r) => r.id);

describe("pruneJobHistory", () => {
  it("deletes done editor_reconcile and editor_sync rows older than 90 days, keeping the newest per project and kind", async () => {
    await seed({ id: "r-old" }, { id: "s-old", kind: "editor_sync" });
    await newest("p1", "editor_reconcile");
    await newest("p1", "editor_sync");
    expect(await pruneJobHistory(DB, NOW)).toEqual({ deleted: 2 });
    expect(await ids()).toEqual(["newest-p1-editor_reconcile", "newest-p1-editor_sync"]);
  });

  it("compares updated_at strictly: exactly 90 days is kept, one millisecond older is deleted", async () => {
    const cutoff = NOW - JOB_RETENTION_MS;
    await seed({ id: "at-cutoff", updated: cutoff }, { id: "just-inside", updated: cutoff + 1 }, { id: "just-outside", updated: cutoff - 1 });
    await newest();
    expect(await pruneJobHistory(DB, NOW)).toEqual({ deleted: 1 });
    expect(await ids()).toEqual(["at-cutoff", "just-inside", "newest-p1-editor_reconcile"]);
  });

  it.each(["failed", "stuck", "queued", "running"])("keeps an old %s row", async (status) => {
    await seed({ id: "x", status });
    await newest();
    expect(await pruneJobHistory(DB, NOW)).toEqual({ deleted: 0 });
    expect(await ids()).toContain("x");
  });

  it("keeps other kinds however old", async () => {
    await seed({ id: "dropbox", kind: "dropbox_sync" }, { id: "autohdr", kind: "autohdr" }, { id: "fetch", kind: "fetch_edited" });
    await newest("p1", "dropbox_sync");
    await newest("p1", "autohdr");
    await newest("p1", "fetch_edited");
    expect(await pruneJobHistory(DB, NOW)).toEqual({ deleted: 0 });
    expect(await ids()).toEqual(expect.arrayContaining(["dropbox", "autohdr", "fetch"]));
  });

  it("keeps the newest row per project and kind even when it is the only one and very old", async () => {
    await addProject("p2");
    await seed({ id: "only-p1" }, { id: "only-p2", project: "p2" }, { id: "only-p1-sync", kind: "editor_sync" });
    expect(await pruneJobHistory(DB, NOW)).toEqual({ deleted: 0 });
    expect(await ids()).toEqual(["only-p1", "only-p1-sync", "only-p2"]);
  });

  it("keeps every row tied at the newest created_at (the reader orders by created_at only, so an id tie-break could delete its row)", async () => {
    await seed({ id: "z", created: OLD, updated: OLD }, { id: "a", created: OLD, updated: OLD });
    expect(await pruneJobHistory(DB, NOW)).toEqual({ deleted: 0 });
    expect(await ids()).toEqual(["a", "z"]);
  });

  it("deletes both old twins once a strictly newer row exists", async () => {
    await seed({ id: "z", created: OLD, updated: OLD }, { id: "a", created: OLD, updated: OLD });
    await newest();
    expect(await pruneJobHistory(DB, NOW)).toEqual({ deleted: 2 });
    expect(await ids()).toEqual(["newest-p1-editor_reconcile"]);
  });

  it("keeps a row whose project_id is NULL", async () => {
    await seed({ id: "orphan-1", project: null }, { id: "orphan-2", project: null, created: NOW, updated: NOW });
    expect(await pruneJobHistory(DB, NOW)).toEqual({ deleted: 0 });
    expect(await ids()).toEqual(["orphan-1", "orphan-2"]);
  });

  it("keeps a row any FK to jobs.id references", async () => {
    await seed({ id: "by-handoff" }, { id: "by-fetch" }, { id: "by-claim" }, { id: "free" });
    await newest();
    await DB.batch([
      DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES ('c', 'dropbox', 'connected', ?, ?)").bind(NOW, NOW),
      DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, state, workflow_id, job_id, lease_expires_at, created_at, updated_at) VALUES ('h1', 'p1', 'c', 1, 'h', '[]', '[]', '/r', 'started', 'wf-h', 'by-handoff', ?, ?, ?)").bind(NOW, NOW, NOW),
      DB.prepare("INSERT INTO autohdr_output_mappings (id, project_id, handoff_id, connection_id, generation, state, final_path, final_path_key, observed_at, created_at, updated_at) VALUES ('m1', 'p1', 'h1', 'c', 1, 'active', '/A/04-FINAL-Photos', '/a/04-final-photos', ?, ?, ?)").bind(NOW, NOW, NOW),
      DB.prepare("INSERT INTO autohdr_fetch_claims (id, project_id, handoff_id, mapping_id, mapping_generation, connection_id, workflow_id, job_id, state, lease_expires_at, trigger, trigger_json, created_at, updated_at) VALUES ('f1', 'p1', 'h1', 'm1', 1, 'c', 'wf-f', 'by-fetch', 'done', ?, 'manual', '{}', ?, ?)").bind(NOW, NOW, NOW),
      DB.prepare("INSERT INTO raw_reconciliation_claims (id, project_id, owner_job_id, state, lease_expires_at, trigger, created_at, updated_at) VALUES ('rc1', 'p1', 'by-claim', 'done', ?, 'manual', ?, ?)").bind(NOW, NOW, NOW),
    ]);
    expect(await pruneJobHistory(DB, NOW)).toEqual({ deleted: 1 });
    expect(await ids()).toEqual(["by-claim", "by-fetch", "by-handoff", "newest-p1-editor_reconcile"]);
  });

  it("deletes at most 250 per run, with no drain loop", async () => {
    await DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 599)
      INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) SELECT 'old-' || i, 'editor_reconcile', 'done', 'p1', ? + i, ? + i FROM n`).bind(OLD, OLD).run();
    await newest();
    expect(JOB_RETENTION_PAGE).toBe(250);
    expect(await pruneJobHistory(DB, NOW)).toEqual({ deleted: 250 });
    expect(await pruneJobHistory(DB, NOW)).toEqual({ deleted: 250 });
    expect(await pruneJobHistory(DB, NOW)).toEqual({ deleted: 100 });
    expect(await pruneJobHistory(DB, NOW)).toEqual({ deleted: 0 });
    expect(await ids()).toEqual(["newest-p1-editor_reconcile"]);
  });

  it("does not starve: more than 250 protected old rows never keep the page from reaching deletable ones", async () => {
    // 300 old rows each the sole row of its project (newest-per-project, protected) plus 300 FK-referenced old rows.
    await DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 299)
      INSERT INTO projects (id, street, stage_key, created_at, updated_at) SELECT 'sole-' || i, 'S', 'awaiting_raw', ?, ? FROM n`).bind(NOW, NOW).run();
    await DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 299)
      INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) SELECT 'sole-' || i, 'editor_reconcile', 'done', 'sole-' || i, ?, ? FROM n`).bind(OLD, OLD).run();
    await DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 299)
      INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) SELECT 'ref-' || i, 'editor_sync', 'done', 'p1', ? + i, ? + i FROM n`).bind(OLD, OLD).run();
    await DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 299)
        INSERT INTO raw_reconciliation_claims (id, project_id, owner_job_id, state, lease_expires_at, trigger, created_at, updated_at) SELECT 'claim-' || i, 'p1', 'ref-' || i, 'done', ?, 'manual', ?, ?  FROM n`).bind(NOW, NOW, NOW).run();
    // The ref rows are all but the newest editor_sync; make one more, unreferenced and deletable, plus a newest sibling.
    await seed({ id: "deletable-1", kind: "editor_sync", created: OLD - 1, updated: OLD - 1 }, { id: "deletable-2", kind: "editor_sync", created: OLD - 2, updated: OLD - 2 }, { id: "deletable-3", kind: "editor_reconcile", created: OLD - 3, updated: OLD - 3 });
    await newest("p1", "editor_reconcile");
    expect(await pruneJobHistory(DB, NOW)).toEqual({ deleted: 3 });
    const remaining = await ids();
    expect(remaining).not.toContain("deletable-1");
    expect(remaining).not.toContain("deletable-2");
    expect(remaining).not.toContain("deletable-3");
    expect(remaining.filter((id) => id.startsWith("sole-"))).toHaveLength(300);
    expect(remaining.filter((id) => id.startsWith("ref-"))).toHaveLength(300);
  });
});

/** Seed ~36k jobs over 91 projects: the shape production has today. `aged` makes most editor rows older than 90 days. */
async function seedWorld(aged: boolean) {
  await DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 90)
    INSERT INTO projects (id, street, stage_key, created_at, updated_at) SELECT 'w' || i, 'S', 'awaiting_raw', ?, ? FROM n`).bind(NOW, NOW).run();
  // 91 projects x 400 rows: 340 done editor_reconcile (3h apart), 40 done editor_sync, 20 done dropbox_sync.
  const spacing = aged ? 8 * 3_600_000 : 3 * 3_600_000;
  for (const [kind, count, space] of [["editor_reconcile", 340, spacing], ["editor_sync", 40, spacing * 4], ["dropbox_sync", 20, spacing * 4]] as const) {
    await DB.prepare(`WITH RECURSIVE p(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM p WHERE i < 90),
      n(j) AS (SELECT 0 UNION ALL SELECT j + 1 FROM n WHERE j < ?)
      INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at)
      SELECT 'w' || p.i || '-' || ? || '-' || n.j, ?, 'done', 'w' || p.i, ? - n.j * ?, ? - n.j * ? FROM p, n`)
      .bind(count - 1, kind, kind, NOW, space, NOW, space).run();
  }
}

describe("job retention candidate selection (rows read)", () => {
  const plan = async () => (await DB.prepare(`EXPLAIN QUERY PLAN ${JOB_RETENTION_CANDIDATES_SQL}`).bind(NOW - JOB_RETENTION_MS, JOB_RETENTION_PAGE).all<{ detail: string }>()).results.map((r) => r.detail);

  it.each([["nothing yet older than 90 days (today)", false], ["most rows older than 90 days (steady state)", true]] as const)("reads a bounded number of rows with %s", async (_label, aged) => {
    await seedWorld(aged);
    // 2,000 reconciliation claims owned by other-kind jobs: the FK guards must not cost rows per candidate.
    await DB.prepare(`WITH RECURSIVE n(j) AS (SELECT 0 UNION ALL SELECT j + 1 FROM n WHERE j < 19), p(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM p WHERE i < 99)
      INSERT INTO raw_reconciliation_claims (id, project_id, owner_job_id, state, lease_expires_at, trigger, created_at, updated_at)
      SELECT 'c' || p.i || '-' || n.j, 'w' || (p.i % 91), 'w' || (p.i % 91) || '-dropbox_sync-' || n.j, 'done', ?, 'manual', ?, ? FROM p, n`).bind(NOW, NOW, NOW).run();
    const total = (await DB.prepare("SELECT count(*) AS c FROM jobs").first<{ c: number }>())!.c;
    expect(total).toBeGreaterThan(36_000);
    const result = await DB.prepare(JOB_RETENTION_CANDIDATES_SQL).bind(NOW - JOB_RETENTION_MS, JOB_RETENTION_PAGE).all();
    console.log("job-retention", { aged, total, rowsRead: result.meta.rows_read, returned: result.results.length, plan: await plan() });
    expect(result.results.length).toBe(aged ? 250 : 0);
    expect(result.meta.rows_read).toBeLessThan(ROWS_READ_BOUND);
  });
});

const ROWS_READ_BOUND = 5_000;

describe("job retention with foreign keys on and a large reconciliation claims table", () => {
  async function seedClaimsWorld() {
    expect((await DB.prepare("PRAGMA foreign_keys").first<{ foreign_keys: number }>())!.foreign_keys).toBe(1);
    // 4,000 other-kind jobs each owning a done reconciliation claim, then 600 deletable editor_reconcile rows and a newest sibling.
    await DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 3999)
      INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) SELECT 'owner-' || i, 'dropbox_sync', 'done', 'p1', ? + i, ? + i FROM n`).bind(OLD, OLD).run();
    await DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 3999)
      INSERT INTO raw_reconciliation_claims (id, project_id, owner_job_id, state, lease_expires_at, trigger, created_at, updated_at)
      SELECT 'claim-' || i, 'p1', 'owner-' || i, 'done', ?, 'manual', ?, ? FROM n`).bind(NOW, NOW, NOW).run();
    await DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 599)
      INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) SELECT 'old-' || i, 'editor_reconcile', 'done', 'p1', ? + i, ? + i FROM n`).bind(OLD, OLD).run();
    await newest();
  }

  it("probes each FK table through its job index, not a scan", async () => {
    const lines = (await DB.prepare(`EXPLAIN QUERY PLAN ${JOB_RETENTION_CANDIDATES_SQL}`).bind(NOW - JOB_RETENTION_MS, JOB_RETENTION_PAGE).all<{ detail: string }>()).results.map((r) => r.detail);
    const text = lines.join("\n");
    expect(text).toMatch(/SEARCH r USING (COVERING )?INDEX autohdr_handoffs_job_idx \(job_id=\?\)/u);
    expect(text).toMatch(/SEARCH r USING (COVERING )?INDEX autohdr_fetch_claims_job_idx \(job_id=\?\)/u);
    expect(text).toMatch(/SEARCH r USING (COVERING )?INDEX raw_reconciliation_claims_owner_job_idx \(owner_job_id=\?\)/u);
    expect(text).not.toMatch(/SCAN r/u);
    expect(text, "newer-sibling probe is a created_at range, with no id tie-break").toMatch(/SEARCH n EXISTS USING (COVERING )?INDEX jobs_project_kind_created_idx \(project_id=\? AND kind=\? AND created_at>\?\)/u);
  });

  it("deletes a full 250-row page for a bounded number of rows read, FK enforcement included", async () => {
    await seedClaimsWorld();
    const result = await DB.prepare(JOB_RETENTION_DELETE_SQL).bind(NOW - JOB_RETENTION_MS, JOB_RETENTION_PAGE).run();
    console.log("job-retention delete", { changes: result.meta.changes, rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written });
    expect(result.meta.changes).toBe(250);
    expect(result.meta.rows_read).toBeLessThan(DELETE_ROWS_READ_BOUND);
  });
});

const DELETE_ROWS_READ_BOUND = 5_000;
