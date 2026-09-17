import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createDb } from "@quincy/db";
import type { Env } from "../src/env";
import QuincyBackground from "../src/index";
import { editorFolderPath, editorFolderPathKey } from "../src/editor-folders/paths";
import { getEditorFolderMapping } from "../src/editor-folders/mapping";
import { JOB_STALE_MS } from "../src/editor-folders/move";
import { MOVE_COMMIT_ATTEMPT_LIMIT } from "../src/editor-folders/move-note";

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
  movedFromPath?: string | null;
  moveCompletedAt?: number | null;
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
      moved_from_path, move_completed_at, move_commit_attempts, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, 'ready', NULL, NULL, 0, ?, NULL, NULL, ?, NULL, ?, NULL, ?, ?, ?, ?, ?)
  `).bind(
    mappingId, projectId, connectionId, rootPath, editorFolderPathKey(rootPath), `id:root-${suffix}`, input.mappingShootDate, input.leaf,
    JSON.stringify([{ path: `${rootPath}/0. Input`, section: null, folderId: `id:input-${suffix}` }]),
    JSON.stringify([{ path: `${rootPath}/1. Output`, section: null, folderId: `id:output-${suffix}` }]),
    `${rootPath}/Editing Notes`, `id:notes-${suffix}`,
    input.moveStatus ?? null, input.moveTargetShootDate ?? null, input.moveExpiresAt ?? null,
    input.movedFromPath ?? null, input.moveCompletedAt ?? null, input.moveCommitAttempts ?? 0,
    now, input.updatedAt ?? now,
  ).run();
  return { projectId, mappingId };
}

async function insertReconcileJob(projectId: string, status: string, createdAt: number, updatedAt: number): Promise<void> {
  await database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'editor_reconcile', ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), status, projectId, createdAt, updatedAt).run();
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

  it("selects a mapping whose orphan-upload watch is due its +30 minute check, and not one still inside the window", async () => {
    const due = await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "orphan-due", movedFromPath: "/Editor/01_ACTIVE EDITS/2026-10 October/02/old", moveCompletedAt: Date.now() - 31 * 60_000 });
    const notYet = await createMapping({ shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "orphan-fresh", movedFromPath: "/Editor/01_ACTIVE EDITS/2026-10 October/02/old", moveCompletedAt: Date.now() - 5 * 60_000 });
    await worker().scheduled(controller(Date.now()));
    expect(await reconcileJobCount(due.projectId)).toBe(1);
    expect(await reconcileJobCount(notYet.projectId)).toBe(0);
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
    const { projectId } = await createMapping({
      shootDate: "2026-10-02", mappingShootDate: "2026-10-02", leaf: "stuck-with-watch", moveStatus: "moving",
      moveExpiresAt: Date.now() - 60_000, moveCommitAttempts: MOVE_COMMIT_ATTEMPT_LIMIT,
      movedFromPath: "/Editor/01_ACTIVE EDITS/2026-09 September/01/old", moveCompletedAt: Date.now() - 31 * 60_000,
    });
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
