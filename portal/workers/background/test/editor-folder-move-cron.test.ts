import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createDb } from "@quincy/db";
import type { Env } from "../src/env";
import QuincyBackground from "../src/index";
import { editorFolderPath, editorFolderPathKey } from "../src/editor-folders/paths";
import { getEditorFolderMapping } from "../src/editor-folders/mapping";
import { JOB_STALE_MS, sweepEditorFolderOrphanUploads } from "../src/editor-folders/move";
import type { JobStatus } from "../src/lib/jobs";
import { MOVE_COMMIT_ATTEMPT_LIMIT } from "../src/editor-folders/move-note";
import { editorInitialSyncRecoveryQuery, editorMoveRecoveryQuery } from "../src/editor-folders/recovery-queries";

declare const __PORTAL_MIGRATION_SQL__: string;
const database = env as unknown as { DB: D1Database };
const db = createDb(database.DB);

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

function worker(): QuincyBackground {
  const instance = Object.create(QuincyBackground.prototype) as QuincyBackground;
  Object.defineProperty(instance, "env", { value: { ...(env as unknown as Env), DROPBOX_EDITOR_AUTOMATION_ENABLED: "1" } });
  return instance;
}

function controller(scheduledTime: number): ScheduledController {
  return { cron: "* * * * *", scheduledTime, noRetry() {} } as ScheduledController;
}

async function createMapping(input: {
  shootDate: string;
  mappingShootDate: string;
  leaf: string;
  moveStatus?: "moving" | "blocked" | null;
  moveExpiresAt?: number | null;
  moveCommitAttempts?: number;
  moveTargetShootDate?: string | null;
  archived?: boolean;
  updatedAt?: number;
}): Promise<{ projectId: string; mappingId: string }> {
  const suffix = crypto.randomUUID();
  const connectionId = `connection-${suffix}`;
  const projectId = `project-${suffix}`;
  const rootPath = editorFolderPath({ shootDate: input.mappingShootDate, projectFolderName: input.leaf });
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, shoot_date, stage_key, archived_at, created_at, updated_at) VALUES (?, '123 Example St', ?, 'awaiting_raw', ?, ?, ?)")
      .bind(projectId, input.shootDate, input.archived ? now : null, now, now),
  ]);
  const mappingId = `mapping-${suffix}`;
  await database.DB.prepare(`
    INSERT INTO editor_folder_mappings (
      id, project_id, connection_id, root_path, root_path_key, root_folder_id, shoot_date, project_folder_name,
      photographer_evidence_json, input_roots_json, output_roots_json, editing_notes_path, editing_notes_folder_id,
      state, provision_lease_token, provision_lease_expires_at, root_revision,
      move_status, move_target_path, move_target_path_key, move_target_shoot_date, move_token, move_expires_at, move_note,
      move_commit_attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 'ready', NULL, NULL, 0, ?, NULL, NULL, ?, NULL, ?, NULL, ?, ?, ?)
  `).bind(
    mappingId, projectId, connectionId, rootPath, editorFolderPathKey(rootPath), `id:root-${suffix}`, input.mappingShootDate, input.leaf,
    JSON.stringify([{ path: `${rootPath}/0. Input`, section: null, folderId: `id:input-${suffix}` }]),
    JSON.stringify([{ path: `${rootPath}/1. Output`, section: null, folderId: `id:output-${suffix}` }]),
    `${rootPath}/Editing Notes`, `id:notes-${suffix}`,
    input.moveStatus ?? null, input.moveTargetShootDate ?? null, input.moveExpiresAt ?? null,
    input.moveCommitAttempts ?? 0,
    now, input.updatedAt ?? now,
  ).run();
  return { projectId, mappingId };
}

async function insertReconcileJob(projectId: string, status: JobStatus, createdAt: number, updatedAt: number): Promise<void> {
  await database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'editor_reconcile', ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), status, projectId, createdAt, updatedAt).run();
}

async function insertWatch(mappingId: string, input: { watchUntil: number; status?: "watching" | "found" }): Promise<void> {
  await database.DB.prepare("INSERT INTO editor_folder_orphan_watches (id, mapping_id, move_revision, old_path, old_path_key, status, watch_until, created_at, updated_at) VALUES (?, ?, 0, '/Editor/old', '/editor/old', ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), mappingId, input.status ?? "watching", input.watchUntil, Date.now(), Date.now()).run();
}

async function reconcileJobCount(projectId: string): Promise<number> {
  const row = await database.DB.prepare("SELECT count(*) AS n FROM jobs WHERE project_id = ? AND kind = 'editor_reconcile'").bind(projectId).first<{ n: number }>();
  return row!.n;
}

describe("Minute cron: Editor folder move selection", () => {
  it("selects a mapping whose move lease has expired", async () => {
    const { projectId } = await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "expired-lease", moveStatus: "moving", moveExpiresAt: Date.now() - 1000 });
    await worker().scheduled(controller(Date.now()));
    expect(await reconcileJobCount(projectId)).toBe(1);
  });

  it("does not select a mapping whose move lease has not expired yet", async () => {
    const { projectId } = await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "live-lease", moveStatus: "moving", moveExpiresAt: Date.now() + 60_000 });
    await worker().scheduled(controller(Date.now()));
    expect(await reconcileJobCount(projectId)).toBe(0);
  });

  it("selects a mapping whose Project shoot date has drifted from its own placement date", async () => {
    const { projectId } = await createMapping({ shootDate: "2027-01-15", mappingShootDate: "2026-10-02", leaf: "drifted" });
    await worker().scheduled(controller(Date.now()));
    expect(await reconcileJobCount(projectId)).toBe(1);
  });

  it("does not select a mapping with no drift, or one blocked for the exact date it is already blocked on", async () => {
    const noDrift = await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "no-drift" });
    const sameBlock = await createMapping({ shootDate: "2027-01-15", mappingShootDate: "2026-10-02", leaf: "same-block", moveStatus: "blocked", moveTargetShootDate: "2027-01-15" });
    await worker().scheduled(controller(Date.now()));
    expect(await reconcileJobCount(noDrift.projectId)).toBe(0);
    expect(await reconcileJobCount(sameBlock.projectId)).toBe(0);
  });

  it("selects a blocked mapping once the Project has rescheduled to a different date than the block", async () => {
    const { projectId } = await createMapping({ shootDate: "2027-02-20", mappingShootDate: "2026-10-02", leaf: "reblock", moveStatus: "blocked", moveTargetShootDate: "2027-01-15" });
    await worker().scheduled(controller(Date.now()));
    expect(await reconcileJobCount(projectId)).toBe(1);
  });

  it("does not select an archived or delivered Project's drift", async () => {
    const { projectId } = await createMapping({ shootDate: "2027-01-15", mappingShootDate: "2026-10-02", leaf: "archived-drift", archived: true });
    await worker().scheduled(controller(Date.now()));
    expect(await reconcileJobCount(projectId)).toBe(0);
  });

  it("selects a mapping with an orphan-upload watch that is due, and not one still inside its window or already found", async () => {
    const due = await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "orphan-due" });
    const notYet = await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "orphan-fresh" });
    const found = await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "orphan-found" });
    await insertWatch(due.mappingId, { watchUntil: Date.now() - 60_000 });
    await insertWatch(notYet.mappingId, { watchUntil: Date.now() + 25 * 60_000 });
    await insertWatch(found.mappingId, { watchUntil: Date.now() - 60_000, status: "found" });
    await worker().scheduled(controller(Date.now()));
    expect(await reconcileJobCount(due.projectId)).toBe(1);
    expect(await reconcileJobCount(notYet.projectId)).toBe(0);
    expect(await reconcileJobCount(found.projectId)).toBe(0);
  });

  it("selects a due orphan-upload watch on an archived or delivered Project too, whose pass still sweeps it", async () => {
    const archived = await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "orphan-archived", archived: true });
    const delivered = await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "orphan-delivered" });
    await database.DB.prepare("UPDATE projects SET stage_key = 'delivered' WHERE id = ?").bind(delivered.projectId).run();
    await insertWatch(archived.mappingId, { watchUntil: Date.now() - 60_000 });
    await insertWatch(delivered.mappingId, { watchUntil: Date.now() - 60_000 });
    await worker().scheduled(controller(Date.now()));
    expect(await reconcileJobCount(archived.projectId)).toBe(1);
    expect(await reconcileJobCount(delivered.projectId)).toBe(1);
  });

  it("stops selecting a due watch whose Dropbox check failed, so it cannot fill the page", async () => {
    const failing = await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "orphan-failing" });
    await insertWatch(failing.mappingId, { watchUntil: Date.now() - 60_000 });
    const mapping = (await getEditorFolderMapping(db, failing.projectId))!;
    const now = new Date();
    await sweepEditorFolderOrphanUploads(env as never, db, mapping, {
      now: () => now,
      getMetadata: async () => { throw new Error("Dropbox get_metadata failed (401): expired_access_token"); },
      listFolderRecursive: async () => { throw new Error("unexpected"); },
    } as never);
    await worker().scheduled(controller(now.getTime()));
    expect(await reconcileJobCount(failing.projectId)).toBe(0);
    // Retried once the backoff is due.
    await worker().scheduled(controller(now.getTime() + 30 * 60_000 + 11 * 60_000));
    expect(await reconcileJobCount(failing.projectId)).toBe(1);
  });

  it("throttles on an editor_reconcile job already queued/running or created within the last 10 minutes", async () => {
    const running = await createMapping({ shootDate: "2027-01-15", mappingShootDate: "2026-10-02", leaf: "already-running" });
    await database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'editor_reconcile', 'running', ?, ?, ?)")
      .bind(crypto.randomUUID(), running.projectId, Date.now() - 20 * 60_000, Date.now() - 20 * 60_000).run();

    const recentlyDone = await createMapping({ shootDate: "2027-01-15", mappingShootDate: "2026-10-02", leaf: "recently-done" });
    await database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'editor_reconcile', 'done', ?, ?, ?)")
      .bind(crypto.randomUUID(), recentlyDone.projectId, Date.now() - 5 * 60_000, Date.now() - 5 * 60_000).run();

    const eligible = await createMapping({ shootDate: "2027-01-15", mappingShootDate: "2026-10-02", leaf: "long-done" });
    await database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'editor_reconcile', 'done', ?, ?, ?)")
      .bind(crypto.randomUUID(), eligible.projectId, Date.now() - 20 * 60_000, Date.now() - 20 * 60_000).run();

    await worker().scheduled(controller(Date.now()));
    expect(await reconcileJobCount(running.projectId)).toBe(1); // the pre-existing job only, no new one
    expect(await reconcileJobCount(recentlyDone.projectId)).toBe(1); // throttled by recency alone, despite being done
    expect(await reconcileJobCount(eligible.projectId)).toBe(2); // the old done job, plus a fresh enqueue
  });

  it("bounds the selection to 10 per pass", async () => {
    const mappings = [];
    for (let i = 0; i < 11; i += 1) {
      mappings.push(await createMapping({ shootDate: "2027-01-15", mappingShootDate: "2026-10-02", leaf: `bounded-${i}`, updatedAt: Date.now() + i }));
    }
    await worker().scheduled(controller(Date.now()));
    let selected = 0;
    for (const mapping of mappings) selected += await reconcileJobCount(mapping.projectId);
    expect(selected).toBe(10);
  });

  it("never selects a commit-stuck mapping, so ten of them cannot starve a live expired lease (#194)", async () => {
    const now = Date.now();
    const stuck = [];
    for (let i = 0; i < 10; i += 1) {
      stuck.push(await createMapping({
        shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: `stuck-${i}`, moveStatus: "moving",
        moveExpiresAt: now - 60_000, moveCommitAttempts: MOVE_COMMIT_ATTEMPT_LIMIT, updatedAt: now - 1_000_000 + i,
      }));
    }
    const live = await createMapping({
      shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "behind-the-stuck", moveStatus: "moving",
      moveExpiresAt: now - 60_000, moveCommitAttempts: MOVE_COMMIT_ATTEMPT_LIMIT - 1, updatedAt: now,
    });
    await worker().scheduled(controller(now));
    for (const mapping of stuck) expect(await reconcileJobCount(mapping.projectId)).toBe(0);
    expect(await reconcileJobCount(live.projectId)).toBe(1);
  });

  it("does not select a commit-stuck mapping through its orphan-upload watch either (#194)", async () => {
    const { projectId, mappingId } = await createMapping({
      shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "stuck-with-watch", moveStatus: "moving",
      moveExpiresAt: Date.now() - 60_000, moveCommitAttempts: MOVE_COMMIT_ATTEMPT_LIMIT,
    });
    await insertWatch(mappingId, { watchUntil: Date.now() - 60_000 });
    await worker().scheduled(controller(Date.now()));
    expect(await reconcileJobCount(projectId)).toBe(0);
  });

  it("selects a moving mapping with no lease expiry, which no pass can be holding (#194)", async () => {
    const { projectId } = await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "null-expiry", moveStatus: "moving", moveExpiresAt: null });
    await worker().scheduled(controller(Date.now()));
    expect(await reconcileJobCount(projectId)).toBe(1);
  });

  it("stops treating a queued/running reconcile job as in flight once it has made no progress for JOB_STALE_MS (#194)", async () => {
    const now = Date.now();
    const abandonedRunning = await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "abandoned-running", moveStatus: "moving", moveExpiresAt: now - 60_000 });
    await insertReconcileJob(abandonedRunning.projectId, "running", now - JOB_STALE_MS - 60_000, now - JOB_STALE_MS - 1);
    const abandonedQueued = await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "abandoned-queued", moveStatus: "moving", moveExpiresAt: now - 60_000 });
    await insertReconcileJob(abandonedQueued.projectId, "queued", now - JOB_STALE_MS - 1, now - JOB_STALE_MS - 1);
    // Created long ago, but its status changed recently: a retried delivery that is still live.
    const oldButProgressing = await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "old-but-progressing", moveStatus: "moving", moveExpiresAt: now - 60_000 });
    await insertReconcileJob(oldButProgressing.projectId, "running", now - 3 * JOB_STALE_MS, now - 5 * 60_000);

    await worker().scheduled(controller(now));
    expect(await reconcileJobCount(abandonedRunning.projectId)).toBe(2);
    expect(await reconcileJobCount(abandonedQueued.projectId)).toBe(2);
    expect(await reconcileJobCount(oldButProgressing.projectId)).toBe(1);
  });
});

describe("Editor folder recovery selects: throttle boundaries", () => {
  // The two builders are the ones scheduled() runs. Mappings sort first (oldest updatedAt) so the bounded page always holds them.
  const TEN_MINUTES = 10 * 60_000;
  const TWENTY_MINUTES = 20 * 60_000;

  async function driftedMapping(leaf: string): Promise<string> {
    const { projectId } = await createMapping({ shootDate: "2027-01-15", mappingShootDate: "2026-10-02", leaf, updatedAt: 1 });
    return projectId;
  }
  async function moveSelected(now: number): Promise<string[]> {
    return (await editorMoveRecoveryQuery(db, now)).map((row) => row.projectId);
  }
  async function insertSyncJob(projectId: string, status: JobStatus, createdAt: number, updatedAt: number): Promise<void> {
    await database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'editor_sync', ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), status, projectId, createdAt, updatedAt).run();
  }

  it("an in-flight reconcile throttles while updated_at is strictly inside JOB_STALE_MS, and stops at exactly JOB_STALE_MS", async () => {
    const now = Date.now();
    const justInside = await driftedMapping("stale-inside");
    const exactly = await driftedMapping("stale-equal");
    const justOutside = await driftedMapping("stale-outside");
    // created_at is old, so only the in-flight clause can throttle.
    for (const [projectId, updatedAt] of [[justInside, now - JOB_STALE_MS + 1], [exactly, now - JOB_STALE_MS], [justOutside, now - JOB_STALE_MS - 1]] as const) {
      await insertReconcileJob(projectId, "running", now - 5 * JOB_STALE_MS, updatedAt);
    }
    const selected = await moveSelected(now);
    expect(selected).not.toContain(justInside);
    expect(selected).toContain(exactly);
    expect(selected).toContain(justOutside);
  });

  it("a reconcile created within 10 minutes throttles, and one created exactly 10 minutes ago does not", async () => {
    const now = Date.now();
    const justInside = await driftedMapping("created-inside");
    const exactly = await driftedMapping("created-equal");
    const justOutside = await driftedMapping("created-outside");
    for (const [projectId, createdAt] of [[justInside, now - TEN_MINUTES + 1], [exactly, now - TEN_MINUTES], [justOutside, now - TEN_MINUTES - 1]] as const) {
      await insertReconcileJob(projectId, "done", createdAt, createdAt);
    }
    const selected = await moveSelected(now);
    expect(selected).not.toContain(justInside);
    expect(selected).toContain(exactly);
    expect(selected).toContain(justOutside);
  });

  it("a recent done or failed or stuck reconcile still throttles, because the created_at clause ignores status", async () => {
    const now = Date.now();
    const projects = new Map<JobStatus, string>();
    for (const status of ["done", "failed", "stuck"] as const) {
      const projectId = await driftedMapping(`recent-${status}`);
      projects.set(status, projectId);
      await insertReconcileJob(projectId, status, now - 60_000, now - 60_000);
    }
    const selected = await moveSelected(now);
    for (const projectId of projects.values()) expect(selected).not.toContain(projectId);
  });

  it("another job kind, or another Project's reconcile, never throttles", async () => {
    const now = Date.now();
    const target = await driftedMapping("other-kind");
    const neighbour = await driftedMapping("neighbour");
    await insertSyncJob(target, "running", now - 60_000, now - 60_000);
    await insertReconcileJob(neighbour, "running", now - 60_000, now - 60_000);
    const selected = await moveSelected(now);
    expect(selected).toContain(target);
    expect(selected).not.toContain(neighbour);
  });

  it("the initial-sync select throttles on a queued/running sync updated within 20 minutes, and stops at exactly 20", async () => {
    const now = Date.now();
    const justInside = (await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "sync-inside", updatedAt: 1 })).projectId;
    const exactly = (await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "sync-equal", updatedAt: 1 })).projectId;
    const justOutside = (await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "sync-outside", updatedAt: 1 })).projectId;
    const finished = (await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "sync-done", updatedAt: 1 })).projectId;
    await insertSyncJob(justInside, "queued", now - 5 * TWENTY_MINUTES, now - TWENTY_MINUTES + 1);
    await insertSyncJob(exactly, "running", now - 5 * TWENTY_MINUTES, now - TWENTY_MINUTES);
    await insertSyncJob(justOutside, "running", now - 5 * TWENTY_MINUTES, now - TWENTY_MINUTES - 1);
    await insertSyncJob(finished, "done", now - 60_000, now - 60_000);
    const selected = (await editorInitialSyncRecoveryQuery(db, now)).map((row) => row.projectId);
    expect(selected).not.toContain(justInside);
    expect(selected).toContain(exactly);
    expect(selected).toContain(justOutside);
    expect(selected).toContain(finished);
  });
});
