import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createDb } from "@quincy/db";
import { DropboxPathNotFoundError, DropboxRelocationConflictError, DropboxRelocationRefusedError, type DropboxEntry, type DropboxFolder } from "../src/dropbox/client";
import { dropboxPathKey } from "../src/dropbox/paths";
import { EDITOR_ROOT, editorDayFolderName, editorFolderPath, editorFolderPathKey, editorMonthFolderName } from "../src/editor-folders/paths";
import { getEditorFolderMapping, type EditorFolderMapping } from "../src/editor-folders/mapping";
import { attemptEditorFolderMove, resumeEditorFolderMove, type EditorFolderMoveDependencies } from "../src/editor-folders/move";
import { editorReconcileNote, reconcileEditorFolderOutcome } from "../src/editor-folders/scaffold";
import QuincyBackground from "../src/index";
import type { Env } from "../src/env";

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

/** The fixed clock every test's `deps()` uses; job/upload timestamps are set relative to this,
 * not the real wall clock, so "in flight" / "stale" / "recent" all mean what each test intends. */
const FIXED_NOW = new Date("2026-10-02T00:00:00.000Z");

function folder(path: string, id: string): DropboxFolder {
  return { ".tag": "folder", id, name: path.split("/").at(-1)!, path_lower: path.toLowerCase(), path_display: path };
}

type Setup = {
  suffix: string;
  connectionId: string;
  projectId: string;
  mapping: EditorFolderMapping;
};

/** Project + a `ready` Editor folder mapping inserted directly, so each test controls exactly the
 * move-relevant fields it needs without paying for a full scaffold provisioning pass. */
async function setup(input: {
  shootDate?: string;
  mappingShootDate?: string;
  leaf?: string;
  rootPath?: string;
  archived?: boolean;
  stageKey?: string;
  overrides?: Record<string, unknown>;
} = {}): Promise<Setup> {
  const suffix = crypto.randomUUID();
  const connectionId = `connection-${suffix}`;
  const projectId = `project-${suffix}`;
  const mappingShootDate = input.mappingShootDate ?? input.shootDate ?? "2026-10-02";
  const leaf = input.leaf ?? suffix;
  const rootPath = input.rootPath ?? editorFolderPath({ shootDate: mappingShootDate, projectFolderName: leaf });
  const rootPathKey = editorFolderPathKey(rootPath);
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, shoot_date, stage_key, archived_at, created_at, updated_at) VALUES (?, '123 Example St', ?, ?, ?, ?, ?)")
      .bind(projectId, input.shootDate ?? mappingShootDate, input.stageKey ?? "awaiting_raw", input.archived ? now : null, now, now),
  ]);
  const row: Record<string, unknown> = {
    id: `mapping-${suffix}`,
    project_id: projectId,
    connection_id: connectionId,
    root_path: rootPath,
    root_path_key: rootPathKey,
    root_folder_id: `id:root-${suffix}`,
    shoot_date: mappingShootDate,
    project_folder_name: leaf,
    tonomo_raw_folder_path: null,
    photographer_evidence_json: "{}",
    input_roots_json: JSON.stringify([{ path: `${rootPath}/0. Input`, section: null, folderId: `id:input-${suffix}` }]),
    output_roots_json: JSON.stringify([{ path: `${rootPath}/1. Output`, section: null, folderId: `id:output-${suffix}` }]),
    editing_notes_path: `${rootPath}/Editing Notes`,
    editing_notes_folder_id: `id:notes-${suffix}`,
    state: "ready",
    recovery_proof_json: JSON.stringify({ version: 1, rootPath, rootPathKey, attempts: 1, created: [] }),
    provision_lease_token: null,
    provision_lease_expires_at: null,
    initial_sync_completed_at: now,
    reviewed_at: null,
    reviewed_by: null,
    root_revision: 0,
    move_status: null,
    move_target_path: null,
    move_target_path_key: null,
    move_target_shoot_date: null,
    move_token: null,
    move_expires_at: null,
    move_note: null,
    moved_from_path: null,
    move_completed_at: null,
    created_at: now,
    updated_at: now,
    ...input.overrides,
  };
  const columns = Object.keys(row);
  await database.DB.prepare(`INSERT INTO editor_folder_mappings (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .bind(...columns.map((column) => row[column])).run();
  const mapping = (await getEditorFolderMapping(db, projectId))!;
  return { suffix, connectionId, projectId, mapping };
}

function deps(overrides: Partial<EditorFolderMoveDependencies> = {}): EditorFolderMoveDependencies {
  return {
    getMetadata: overrides.getMetadata ?? (async () => { throw new Error("unexpected getMetadata call in this test"); }),
    createFolder: overrides.createFolder ?? (async () => {}),
    moveFolderStrict: overrides.moveFolderStrict ?? (async () => { throw new Error("unexpected moveFolderStrict call in this test"); }),
    listFolderRecursive: overrides.listFolderRecursive ?? (async () => []),
    now: overrides.now ?? (() => FIXED_NOW),
  };
}

const connectionState = (id: string) => database.DB.prepare("SELECT status, last_error FROM integration_connections WHERE id = ?").bind(id).first<{ status: string; last_error: string | null }>();
const auditRows = (action: string, targetId: string) => database.DB.prepare("SELECT meta_json FROM audit_log WHERE action = ? AND target_id = ? ORDER BY created_at").bind(action, targetId).all<{ meta_json: string }>();
const jobRow = (id: string) => database.DB.prepare("SELECT status, error, updated_at FROM jobs WHERE id = ?").bind(id).first<{ status: string; error: string | null; updated_at: number }>();

async function insertJob(input: { projectId: string; kind: string; status: string; updatedAt: number }): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, input.kind, input.status, input.projectId, now, input.updatedAt).run();
  return id;
}

describe("Editor folder move: derived happy path", () => {
  it("rebases every recorded Dropbox path, bumps the revision, audits the move, and queues a resync", async () => {
    const { suffix, connectionId, projectId, mapping } = await setup();
    const oldRoot = mapping.rootPath;
    const oldRootKey = mapping.rootPathKey;

    await database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', ?, ?)")
      .bind(`collection-${suffix}`, projectId, Date.now(), Date.now()).run();
    // A differently-cased root prefix proves the rebase compares by key, not by string.
    const casedOldRootPrefix = `/editor/01_active edits/${editorMonthFolderName("2026-10-02").toLowerCase()}/02/${suffix}`;
    const assetSourcePath = `${casedOldRootPrefix}/0. Input/DSC001.CR2`;
    const assetSourcePathKey = dropboxPathKey(assetSourcePath);
    await database.DB.prepare(
      "INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, source_path, source_path_key, publish_status, created_at, updated_at) VALUES (?, ?, 'photo', ?, ?, 100, 'dropbox', ?, ?, 'ready', ?, ?)",
    ).bind(`asset-${suffix}`, `collection-${suffix}`, `r2/${suffix}`, "DSC001.CR2", assetSourcePath, assetSourcePathKey, Date.now(), Date.now()).run();
    await database.DB.prepare("INSERT INTO asset_ingest_identities (id, collection_id, identity_key, asset_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(`identity-${suffix}`, `collection-${suffix}`, `path:${assetSourcePathKey}`, `asset-${suffix}`, Date.now()).run();
    const claimSourcePathKey = dropboxPathKey(`${oldRoot}/1. Output/final.jpg`);
    await database.DB.prepare("INSERT INTO edited_source_claims (id, collection_id, source_path_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(`claim-${suffix}`, `collection-${suffix}`, claimSourcePathKey, Date.now(), Date.now()).run();

    // A RAW folder, so the move queues the RAW re-sync as well as the Editor one.
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15', raw_folder_path = '/Tonomo/Raw Files/123 Example St' WHERE id = ?").bind(projectId).run();
    const newRoot = editorFolderPath({ shootDate: "2027-01-15", projectFolderName: suffix });
    const created: string[] = [];
    const outcome = await attemptEditorFolderMove(
      env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping,
      deps({
        getMetadata: async (_env, _db, path) => folder(oldRoot, `id:root-${suffix}`),
        createFolder: async (_env, _db, path) => { created.push(path); },
        moveFolderStrict: async (_env, _db, from, to) => {
          expect(from).toBe(oldRoot);
          expect(to).toBe(newRoot);
          return folder(to, `id:root-${suffix}`);
        },
      }),
    );

    expect(outcome).toMatchObject({
      status: "moved", from: oldRoot, to: newRoot, previousShootDate: "2026-10-02",
      mapping: { rootPath: newRoot, rootPathKey: editorFolderPathKey(newRoot), shootDate: "2027-01-15", rootRevision: 1, movedFromPath: oldRoot },
    });
    expect(created).toEqual([
      newRoot.split("/").slice(0, -2).join("/"),
      newRoot.split("/").slice(0, -1).join("/"),
    ]);
    const committed = (outcome as { mapping: EditorFolderMapping }).mapping;
    expect(committed.inputRoots[0]?.path).toBe(`${newRoot}/0. Input`);
    expect(committed.outputRoots[0]?.path).toBe(`${newRoot}/1. Output`);
    expect(committed.editingNotesPath).toBe(`${newRoot}/Editing Notes`);

    const asset = await database.DB.prepare("SELECT source_path, source_path_key FROM assets WHERE id = ?").bind(`asset-${suffix}`).first<{ source_path: string; source_path_key: string }>();
    expect(asset?.source_path).toBe(`${newRoot}/0. Input/DSC001.CR2`);
    expect(asset?.source_path_key).toBe(dropboxPathKey(`${newRoot}/0. Input/DSC001.CR2`));

    const identity = await database.DB.prepare("SELECT identity_key FROM asset_ingest_identities WHERE id = ?").bind(`identity-${suffix}`).first<{ identity_key: string }>();
    expect(identity?.identity_key).toBe(`path:${dropboxPathKey(`${newRoot}/0. Input/DSC001.CR2`)}`);

    const claim = await database.DB.prepare("SELECT source_path_key FROM edited_source_claims WHERE id = ?").bind(`claim-${suffix}`).first<{ source_path_key: string }>();
    expect(claim?.source_path_key).toBe(dropboxPathKey(`${newRoot}/1. Output/final.jpg`));

    expect(editorReconcileNote(outcome as never)).toBe(`editor_folder_moved: Moved the Editor tree from ${oldRoot} to ${newRoot} after the shoot date changed from 2026-10-02 to 2027-01-15`);

    const started = await auditRows("editor_folder.move.started", projectId);
    expect(started.results).toHaveLength(1);
    const moved = await auditRows("editor_folder.moved", projectId);
    expect(moved.results).toHaveLength(1);
    expect(JSON.parse(moved.results[0]!.meta_json)).toMatchObject({ mappingId: mapping.id, from: oldRoot, to: newRoot, previousShootDate: "2026-10-02", shootDate: "2027-01-15", rootRevision: 1, handLinked: false, staleJobIds: [] });

    expect(await database.DB.prepare("SELECT count(*) AS n FROM jobs WHERE project_id = ? AND kind = 'editor_sync'").bind(projectId).first<{ n: number }>()).toEqual({ n: 1 });
    expect(await database.DB.prepare("SELECT count(*) AS n FROM jobs WHERE project_id = ? AND kind = 'dropbox_sync'").bind(projectId).first<{ n: number }>()).toEqual({ n: 1 });
    expect(await connectionState(connectionId)).toEqual({ status: "connected", last_error: null });
  });
});

describe("Editor folder move: corrupt mapping state", () => {
  it("blocks a ready mapping with no Dropbox folder ID instead of calling Dropbox with nothing to follow", async () => {
    const { projectId, mapping } = await setup({ shootDate: "2026-09-01", mappingShootDate: "2026-09-01" });
    await database.DB.prepare("UPDATE editor_folder_mappings SET root_folder_id = NULL WHERE id = ?").bind(mapping.id).run();
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    let dropboxCalled = false;
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-01-15" }, (await getEditorFolderMapping(db, projectId))!, deps({
      getMetadata: async () => { dropboxCalled = true; throw new Error("must not be called"); },
      listFolderRecursive: async () => { dropboxCalled = true; throw new Error("must not be called"); },
    }));
    expect(dropboxCalled).toBe(false);
    expect(outcome).toMatchObject({ status: "skipped", reason: "editor_folder_move_source_missing", mapping: { moveStatus: "blocked", moveTargetShootDate: "2027-01-15" } });
    expect((await auditRows("editor_folder.move.blocked", projectId)).results).toHaveLength(1);
  });

  it("leaves a mapping with no Dropbox folder ID alone when there is no reschedule to act on", async () => {
    const { projectId, mapping } = await setup({ shootDate: "2026-09-01", mappingShootDate: "2026-09-01" });
    await database.DB.prepare("UPDATE editor_folder_mappings SET root_folder_id = NULL WHERE id = ?").bind(mapping.id).run();
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2026-09-01" }, (await getEditorFolderMapping(db, projectId))!, deps());
    expect(outcome).toBeNull();
    expect((await auditRows("editor_folder.move.blocked", projectId)).results).toHaveLength(0);
    expect(await database.DB.prepare("SELECT move_status FROM editor_folder_mappings WHERE id = ?").bind(mapping.id).first<{ move_status: string | null }>()).toEqual({ move_status: null });
  });
});

describe("Editor folder move: hand-linked mapping", () => {
  it("blocks a non-standard parent with a note and audit, makes no Dropbox call, and a later reschedule retries", async () => {
    const { projectId, mapping } = await setup({ shootDate: "2026-09-01", mappingShootDate: "2026-09-01", leaf: "Legacy Name", rootPath: `${EDITOR_ROOT}/Somewhere Else/Legacy Name` });
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    let dropboxCalled = false;
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping, deps({
      getMetadata: async () => { dropboxCalled = true; throw new Error("must not be called"); },
    }));
    expect(dropboxCalled).toBe(false);
    expect(outcome).toMatchObject({ status: "skipped", reason: "editor_folder_move_nonstandard_parent", mapping: { moveStatus: "blocked", moveTargetShootDate: "2027-01-15" } });
    const blocked = await auditRows("editor_folder.move.blocked", projectId);
    expect(blocked.results).toHaveLength(1);

    // The cron selection (section E) must not re-enqueue for the same target date...
    const worker = Object.create(QuincyBackground.prototype) as QuincyBackground;
    Object.defineProperty(worker, "env", { value: { ...(env as unknown as Env), DROPBOX_EDITOR_AUTOMATION_ENABLED: "1" } });
    await worker.scheduled({ cron: "* * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController);
    expect(await database.DB.prepare("SELECT count(*) AS n FROM jobs WHERE project_id = ? AND kind = 'editor_reconcile'").bind(projectId).first<{ n: number }>()).toEqual({ n: 0 });

    // ...but a genuinely new reschedule (a different target date) is retried.
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-02-20' WHERE id = ?").bind(projectId).run();
    const retried = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-02-20" }, (await getEditorFolderMapping(db, projectId))!, deps());
    expect(retried).toMatchObject({ status: "skipped", reason: "editor_folder_move_nonstandard_parent", mapping: { moveTargetShootDate: "2027-02-20" } });
  });

  it("moves a hand-linked root, keeping its leaf casing and review fields intact", async () => {
    const { projectId, mapping } = await setup({ shootDate: "2026-09-01", mappingShootDate: "2026-09-01", leaf: "Legacy Name", overrides: { reviewed_by: null } });
    await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Reviewer', ?, 1, 'admin', 1, ?, ?)")
      .bind(`reviewer-${mapping.id}`, `${mapping.id}@test.invalid`, Date.now(), Date.now()).run();
    await database.DB.prepare("UPDATE editor_folder_mappings SET reviewed_by = ?, reviewed_at = ? WHERE id = ?").bind(`reviewer-${mapping.id}`, Date.now(), mapping.id).run();
    const handLinked = (await getEditorFolderMapping(db, projectId))!;
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    const newRoot = `${EDITOR_ROOT}/${editorMonthFolderName("2027-01-15")}/${editorDayFolderName("2027-01-15")}/Legacy Name`;
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-01-15" }, handLinked, deps({
      getMetadata: async () => folder(handLinked.rootPath, handLinked.rootFolderId!),
      moveFolderStrict: async (_env, _db, from, to) => folder(to, handLinked.rootFolderId!),
    }));
    expect(outcome).toMatchObject({ status: "moved", from: handLinked.rootPath, to: newRoot, mapping: { rootPath: newRoot, reviewedBy: `reviewer-${mapping.id}` } });
    expect((outcome as { mapping: EditorFolderMapping }).mapping.reviewedAt).not.toBeNull();
  });
});

describe("Editor folder move: jobs and the quiet period", () => {
  it.each(["editor_sync", "dropbox_sync", "manual_edited_publish", "manual_raw_publish", "autohdr", "autohdr_api_send"] as const)(
    "defers while a %s job is queued or running for the Project",
    async (kind) => {
      const { projectId, mapping } = await setup();
      const jobId = await insertJob({ projectId, kind, status: "queued", updatedAt: FIXED_NOW.getTime() });
      await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
      const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping, deps());
      expect(outcome).toMatchObject({ status: "skipped", reason: "editor_folder_move_deferred", detail: expect.stringContaining(`${kind} job ${jobId} is in flight`) });
      expect((await getEditorFolderMapping(db, projectId))?.moveStatus).toBeNull();
    },
  );

  it("does not block on a job stuck for over two hours, marks it with a stale note, and leaves updated_at untouched", async () => {
    const { projectId, mapping, suffix } = await setup();
    const staleUpdatedAt = FIXED_NOW.getTime() - 3 * 60 * 60 * 1000;
    const jobId = await insertJob({ projectId, kind: "dropbox_sync", status: "running", updatedAt: staleUpdatedAt });
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    const newRoot = editorFolderPath({ shootDate: "2027-01-15", projectFolderName: suffix });
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping, deps({
      getMetadata: async () => folder(mapping.rootPath, mapping.rootFolderId!),
      moveFolderStrict: async (_env, _db, _from, to) => folder(to, mapping.rootFolderId!),
    }));
    expect(outcome).toMatchObject({ status: "moved" });
    expect((outcome as { mapping: EditorFolderMapping & { staleJobIds?: string[] } }).mapping).toBeTruthy();
    const meta = JSON.parse((await auditRows("editor_folder.moved", projectId)).results[0]!.meta_json);
    expect(meta.staleJobIds).toEqual([jobId]);
    const after = await jobRow(jobId);
    expect(after).toEqual({ status: "running", error: "stale_job: no progress for 2h; no longer blocks the Editor folder move", updated_at: staleUpdatedAt });
    void newRoot;
  });

  it("defers on a recent upload and again releases a fresh claim that hits the quiet period a second time", async () => {
    const { projectId, mapping } = await setup();
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    const recentEntry: DropboxEntry = { ".tag": "file", id: "id:file1", name: "a.jpg", path_lower: "/root/0. input/a.jpg", path_display: "/root/0. Input/a.jpg", size: 1, server_modified: new Date("2026-10-02T00:00:00.000Z").toISOString() };
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping, deps({
      listFolderRecursive: async () => [recentEntry],
    }));
    expect(outcome).toMatchObject({ status: "skipped", reason: "editor_folder_move_deferred", detail: expect.stringContaining("recent upload /root/0. Input/a.jpg") });
    expect((await getEditorFolderMapping(db, projectId))?.moveStatus).toBeNull();
  });

  it("releases a fresh claim when the post-claim quiet check finds an upload", async () => {
    const { projectId, mapping } = await setup();
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    let call = 0;
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping, deps({
      listFolderRecursive: async () => {
        call += 1;
        if (call === 1) return [];
        return [{ ".tag": "file", id: "id:file1", name: "a.jpg", path_lower: "/root/a.jpg", path_display: "/root/a.jpg", size: 1, server_modified: new Date("2026-10-02T00:00:00.000Z").toISOString() }];
      },
    }));
    expect(call).toBe(2);
    expect(outcome).toMatchObject({ status: "skipped", reason: "editor_folder_move_deferred", detail: expect.stringContaining("recent upload /root/a.jpg") });
    const released = await getEditorFolderMapping(db, projectId);
    expect(released?.moveStatus).toBeNull();
    expect(released?.moveToken).toBeNull();
    const releasedAudit = await auditRows("editor_folder.move.released", projectId);
    expect(releasedAudit.results).toHaveLength(1);
  });
});

describe("Editor folder move: Dropbox outcomes while holding the claim token", () => {
  it("blocks on a destination conflict, keeps the mapping ready at the old root, and never errors the connection", async () => {
    const { connectionId, projectId, mapping, suffix } = await setup();
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    const newRoot = editorFolderPath({ shootDate: "2027-01-15", projectFolderName: suffix });
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping, deps({
      getMetadata: async (_env, _db, path) => {
        if (path === mapping.rootFolderId) return folder(mapping.rootPath, mapping.rootFolderId!);
        throw new Error("unexpected getMetadata call");
      },
      moveFolderStrict: async () => { throw new DropboxRelocationConflictError("conflict"); },
    }));
    expect(outcome).toMatchObject({ status: "skipped", reason: "editor_folder_move_conflict", detail: expect.stringContaining(newRoot.split("/").at(-1)!) });
    const after = await getEditorFolderMapping(db, projectId);
    expect(after).toMatchObject({ state: "ready", rootPath: mapping.rootPath, moveStatus: "blocked", moveTargetShootDate: "2027-01-15", moveToken: null });
    expect(await connectionState(connectionId)).toEqual({ status: "connected", last_error: null });
  });

  it("blocks when the source folder is gone", async () => {
    const { projectId, mapping } = await setup();
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping, deps({
      getMetadata: async () => { throw new DropboxPathNotFoundError("Dropbox get_metadata failed (409): path/not_found/.."); },
    }));
    expect(outcome).toMatchObject({ status: "skipped", reason: "editor_folder_move_source_missing" });
    expect((await getEditorFolderMapping(db, projectId))?.moveStatus).toBe("blocked");
  });

  it("blocks, and never adopts, when the tree is found somewhere else entirely (e.g. an archive path)", async () => {
    const { projectId, mapping } = await setup();
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    const elsewhere = "/Archive/2026/Somewhere Else";
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping, deps({
      getMetadata: async () => folder(elsewhere, mapping.rootFolderId!),
    }));
    expect(outcome).toMatchObject({ status: "skipped", reason: "editor_folder_move_moved_elsewhere", detail: expect.stringContaining(elsewhere) });
    const after = await getEditorFolderMapping(db, projectId);
    expect(after).toMatchObject({ rootPath: mapping.rootPath, state: "ready" });
  });
});

describe("Editor folder move: claiming and takeover", () => {
  it("blocks when the target root key is already held by another mapping on the connection", async () => {
    const { connectionId, projectId, mapping, suffix } = await setup();
    const holderTarget = editorFolderPath({ shootDate: "2027-01-15", projectFolderName: suffix });
    const other = await setup({ leaf: `other-${suffix}` });
    await database.DB.prepare("UPDATE editor_folder_mappings SET connection_id = ?, root_path = ?, root_path_key = ? WHERE id = ?")
      .bind(connectionId, holderTarget, editorFolderPathKey(holderTarget), other.mapping.id).run();

    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping, deps());
    expect(outcome).toMatchObject({ status: "skipped", reason: "editor_folder_move_conflict" });
  });

  it("takes over an expired claim: found at the target commits with no second Dropbox move call", async () => {
    const { suffix, projectId, mapping } = await setup();
    const newRoot = editorFolderPath({ shootDate: "2027-01-15", projectFolderName: suffix });
    const token = crypto.randomUUID();
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    await database.DB.prepare(`UPDATE editor_folder_mappings SET move_status = 'moving', move_token = ?, move_expires_at = ?,
        move_target_path = ?, move_target_path_key = ?, move_target_shoot_date = ? WHERE id = ?`)
      .bind(token, Date.now() - 1000, newRoot, editorFolderPathKey(newRoot), "2027-01-15", mapping.id).run();
    const takingOver = (await getEditorFolderMapping(db, projectId))!;
    let moveCalls = 0;
    const outcome = await resumeEditorFolderMove(env as never, db, takingOver, deps({
      getMetadata: async () => folder(newRoot, mapping.rootFolderId!),
      moveFolderStrict: async () => { moveCalls += 1; throw new Error("must not be called"); },
    }));
    expect(moveCalls).toBe(0);
    expect(outcome).toMatchObject({ status: "moved", from: mapping.rootPath, to: newRoot, mapping: { rootPath: newRoot, moveStatus: null } });
  });

  it("takes over an expired claim: found at the old root releases, and a normal pass then moves it", async () => {
    const { suffix, projectId, mapping } = await setup();
    const newRoot = editorFolderPath({ shootDate: "2027-01-15", projectFolderName: suffix });
    const token = crypto.randomUUID();
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    await database.DB.prepare(`UPDATE editor_folder_mappings SET move_status = 'moving', move_token = ?, move_expires_at = ?,
        move_target_path = ?, move_target_path_key = ?, move_target_shoot_date = ? WHERE id = ?`)
      .bind(token, Date.now() - 1000, newRoot, editorFolderPathKey(newRoot), "2027-01-15", mapping.id).run();
    const takingOver = (await getEditorFolderMapping(db, projectId))!;
    const released = await resumeEditorFolderMove(env as never, db, takingOver, deps({
      getMetadata: async () => folder(mapping.rootPath, mapping.rootFolderId!),
    }));
    expect(released).toMatchObject({ status: "skipped", reason: "editor_folder_move_deferred" });
    const afterRelease = await getEditorFolderMapping(db, projectId);
    expect(afterRelease).toMatchObject({ moveStatus: null, moveToken: null, rootPath: mapping.rootPath });

    const moved = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-01-15" }, afterRelease!, deps({
      getMetadata: async () => folder(mapping.rootPath, mapping.rootFolderId!),
      moveFolderStrict: async (_env, _db, _from, to) => folder(to, mapping.rootFolderId!),
    }));
    expect(moved).toMatchObject({ status: "moved", to: newRoot });
  });

  it("takes over a moving mapping with no lease expiry instead of reporting it in flight forever (#194)", async () => {
    const { suffix, projectId, mapping } = await setup({ leaf: "null-expiry" });
    const newRoot = editorFolderPath({ shootDate: "2027-01-15", projectFolderName: suffix });
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    await database.DB.prepare(`UPDATE editor_folder_mappings SET move_status = 'moving', move_token = ?, move_expires_at = NULL,
        move_target_path = ?, move_target_path_key = ?, move_target_shoot_date = ? WHERE id = ?`)
      .bind(crypto.randomUUID(), newRoot, editorFolderPathKey(newRoot), "2027-01-15", mapping.id).run();
    const takingOver = (await getEditorFolderMapping(db, projectId))!;
    expect(takingOver.moveExpiresAt).toBeNull();
    const outcome = await resumeEditorFolderMove(env as never, db, takingOver, deps({
      getMetadata: async () => folder(newRoot, mapping.rootFolderId!),
    }));
    expect(outcome).toMatchObject({ status: "moved", to: newRoot, mapping: { rootPath: newRoot, moveStatus: null } });
  });

  it("takes over a moving mapping whose token and expiry are both missing (#194)", async () => {
    const { suffix, projectId, mapping } = await setup({ leaf: "null-token" });
    const newRoot = editorFolderPath({ shootDate: "2027-01-15", projectFolderName: suffix });
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    await database.DB.prepare(`UPDATE editor_folder_mappings SET move_status = 'moving', move_token = NULL, move_expires_at = NULL,
        move_target_path = ?, move_target_path_key = ?, move_target_shoot_date = ? WHERE id = ?`)
      .bind(newRoot, editorFolderPathKey(newRoot), "2027-01-15", mapping.id).run();
    const takingOver = (await getEditorFolderMapping(db, projectId))!;
    const outcome = await resumeEditorFolderMove(env as never, db, takingOver, deps({
      getMetadata: async () => folder(newRoot, mapping.rootFolderId!),
    }));
    expect(outcome).toMatchObject({ status: "moved", to: newRoot, mapping: { rootPath: newRoot, moveStatus: null } });
  });

  // The takeover CAS is the only fence between a stale snapshot and a lease another pass has since
  // taken. Each case changes exactly one of token/expiry so each half of the CAS is proven on its own.
  async function staleTakeover(leaf: string, snapshotExpiresAt: number | null, rowChange: { token: boolean; expiresAt: number }) {
    const { suffix, projectId, mapping } = await setup({ leaf });
    const newRoot = editorFolderPath({ shootDate: "2027-01-15", projectFolderName: suffix });
    const snapshotToken = crypto.randomUUID();
    await database.DB.prepare(`UPDATE editor_folder_mappings SET move_status = 'moving', move_token = ?, move_expires_at = ?,
        move_target_path = ?, move_target_path_key = ?, move_target_shoot_date = '2027-01-15' WHERE id = ?`)
      .bind(snapshotToken, snapshotExpiresAt, newRoot, editorFolderPathKey(newRoot), mapping.id).run();
    const stale = (await getEditorFolderMapping(db, projectId))!;
    const otherToken = rowChange.token ? crypto.randomUUID() : snapshotToken;
    await database.DB.prepare("UPDATE editor_folder_mappings SET move_token = ?, move_expires_at = ? WHERE id = ?")
      .bind(otherToken, rowChange.expiresAt, mapping.id).run();
    const outcome = await resumeEditorFolderMove(env as never, db, stale, deps({
      getMetadata: async () => { throw new Error("a fenced-out takeover must not touch Dropbox"); },
    }));
    expect(outcome).toMatchObject({ status: "skipped", reason: "editor_folder_move_in_flight" });
    const row = await getEditorFolderMapping(db, projectId);
    expect(row).toMatchObject({ moveStatus: "moving", moveToken: otherToken });
    expect(row!.moveExpiresAt?.getTime()).toBe(rowChange.expiresAt);
  }

  it("does not take over from a stale snapshot once another pass has extended the lease (#194)", async () => {
    await staleTakeover("cas-expiry", FIXED_NOW.getTime() - 1000, { token: false, expiresAt: FIXED_NOW.getTime() + 60_000 });
  });

  it("does not take over from a stale snapshot once another pass holds a new token (#194)", async () => {
    const expiresAt = FIXED_NOW.getTime() - 1000;
    await staleTakeover("cas-token", expiresAt, { token: true, expiresAt });
  });

  it("does not take over from a NULL-expiry snapshot once the row has a real lease (#194)", async () => {
    await staleTakeover("cas-null-expiry", null, { token: false, expiresAt: FIXED_NOW.getTime() + 60_000 });
  });

  it("reports an unexpired claim held by another pass as in flight", async () => {
    const first = await setup({ leaf: "in-flight" });
    const newRoot = editorFolderPath({ shootDate: "2027-01-15", projectFolderName: first.suffix });
    await database.DB.prepare(`UPDATE editor_folder_mappings SET move_status = 'moving', move_token = ?, move_expires_at = ?,
        move_target_path = ?, move_target_path_key = ?, move_target_shoot_date = '2027-01-15' WHERE id = ?`)
      .bind(crypto.randomUUID(), FIXED_NOW.getTime() + 60_000, newRoot, editorFolderPathKey(newRoot), first.mapping.id).run();
    const mapping = (await getEditorFolderMapping(db, first.projectId))!;
    const outcome = await resumeEditorFolderMove(env as never, db, mapping, deps());
    expect(outcome).toMatchObject({ status: "skipped", reason: "editor_folder_move_in_flight" });
  });
});

describe("Editor folder move: rescheduling and archival", () => {
  it("moves A to B and back to A", async () => {
    const { suffix, projectId, mapping } = await setup({ shootDate: "2026-10-02" });
    const rootB = editorFolderPath({ shootDate: "2027-01-15", projectFolderName: suffix });
    const rootA = mapping.rootPath;
    const moveDependencies = () => deps({
      getMetadata: async (_env, _db, path) => {
        const known = await getEditorFolderMapping(db, projectId);
        return folder(known!.rootPath, mapping.rootFolderId!);
      },
      moveFolderStrict: async (_env, _db, _from, to) => folder(to, mapping.rootFolderId!),
    });
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    const toB = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping, moveDependencies());
    expect(toB).toMatchObject({ status: "moved", from: rootA, to: rootB });
    const atB = await getEditorFolderMapping(db, projectId);
    await database.DB.prepare("UPDATE projects SET shoot_date = '2026-10-02' WHERE id = ?").bind(projectId).run();
    const toA = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2026-10-02" }, atB!, moveDependencies());
    expect(toA).toMatchObject({ status: "moved", from: rootB, to: rootA });
    expect((await getEditorFolderMapping(db, projectId))?.rootRevision).toBe(2);
  });

  it("still completes a move claimed before the Project was archived", async () => {
    const { suffix, projectId, mapping } = await setup();
    const newRoot = editorFolderPath({ shootDate: "2027-01-15", projectFolderName: suffix });
    const token = crypto.randomUUID();
    await database.DB.prepare(`UPDATE editor_folder_mappings SET move_status = 'moving', move_token = ?, move_expires_at = ?,
        move_target_path = ?, move_target_path_key = ?, move_target_shoot_date = ? WHERE id = ?`)
      .bind(token, Date.now() - 1000, newRoot, editorFolderPathKey(newRoot), "2027-01-15", mapping.id).run();
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), projectId).run();
    const outcome = await reconcileEditorFolderOutcome(env as never, projectId, {
      db,
      ...deps({
        getMetadata: async () => folder(newRoot, mapping.rootFolderId!),
      }),
    });
    expect(outcome).toMatchObject({ status: "moved", to: newRoot });
  });
});

describe("Editor folder move: orphan-upload sweep", () => {
  it("reports files found at the old root, and never adopts them", async () => {
    const { projectId, mapping } = await setup({ overrides: { moved_from_path: "/Editor/01_ACTIVE EDITS/2026-10 October/02/old-leaf", move_completed_at: FIXED_NOW.getTime() } });
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: mapping.shootDate }, mapping, deps({
      getMetadata: async () => folder("/Editor/01_ACTIVE EDITS/2026-10 October/02/old-leaf", "id:orphan"),
    }));
    expect(outcome).toMatchObject({ status: "skipped", reason: "editor_folder_move_orphan_upload", detail: expect.stringContaining("old-leaf") });
    const audits = await auditRows("editor_folder.move.orphan_upload", projectId);
    expect(audits.results).toHaveLength(1);
    expect((await getEditorFolderMapping(db, projectId))?.movedFromPath).not.toBeNull();
  });

  it("reports nothing when the old root is empty, and clears the watch once 30 minutes have passed", async () => {
    const oldPath = "/Editor/01_ACTIVE EDITS/2026-10 October/02/old-leaf";
    const { projectId, mapping } = await setup({ overrides: { moved_from_path: oldPath, move_completed_at: Date.now() - 40 * 60_000 } });
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: mapping.shootDate }, mapping, deps({
      getMetadata: async () => { throw new DropboxPathNotFoundError("Dropbox get_metadata failed (409): path/not_found/.."); },
      now: () => new Date(),
    }));
    expect(outcome).toBeNull();
    const after = await getEditorFolderMapping(db, projectId);
    expect(after?.movedFromPath).toBeNull();
    expect(after?.moveCompletedAt).toBeNull();
  });

  it("still audits an orphan upload and clears watch bookkeeping for a mapping blocked by a SECOND reschedule, while the outcome stays the stored block note", async () => {
    const oldPath = "/Editor/01_ACTIVE EDITS/2026-10 October/02/old-leaf";
    const storedNote = "editor_folder_move_conflict: A folder named old-leaf already exists in /Editor/01_ACTIVE EDITS/2027-01 January/15";
    const { projectId, mapping } = await setup({
      overrides: {
        move_status: "blocked",
        move_target_shoot_date: "2027-01-15",
        move_note: storedNote,
        moved_from_path: oldPath,
        move_completed_at: FIXED_NOW.getTime() - 40 * 60_000,
      },
    });
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping, deps({
      getMetadata: async () => folder(oldPath, "id:orphan"),
    }));
    // The block note (durable until an operator acts) is still what's reported, not the orphan note.
    expect(outcome).toMatchObject({
      status: "skipped", reason: "editor_folder_move_conflict",
      detail: "A folder named old-leaf already exists in /Editor/01_ACTIVE EDITS/2027-01 January/15",
    });
    const audits = await auditRows("editor_folder.move.orphan_upload", projectId);
    expect(audits.results).toHaveLength(1);
    const after = await getEditorFolderMapping(db, projectId);
    expect(after?.movedFromPath).toBeNull();
    expect(after?.moveCompletedAt).toBeNull();
    expect(after).toMatchObject({ moveStatus: "blocked", moveTargetShootDate: "2027-01-15", moveNote: storedNote });
  });
});

describe("Editor folder move: blocked mapping with a missing note", () => {
  it("returns a usable outcome, not an empty reason, when a blocked mapping's note is NULL", async () => {
    const { projectId, mapping } = await setup({
      overrides: { move_status: "blocked", move_target_shoot_date: "2026-10-02", move_note: null },
    });
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2026-10-02" }, mapping, deps());
    expect(outcome).toMatchObject({ status: "skipped", reason: "editor_folder_move_deferred" });
    expect((outcome as { detail: string }).detail.length).toBeGreaterThan(0);
  });
});

describe("Editor folder move: clearStaleBlock", () => {
  it("clears a blocked mapping's status, target date, and note when the Project reschedules back to the mapping's own stored shoot date", async () => {
    const { projectId, mapping } = await setup({
      shootDate: "2026-10-02",
      overrides: { move_status: "blocked", move_target_shoot_date: "2027-01-15", move_note: "editor_folder_move_conflict: some detail" },
    });
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2026-10-02" }, mapping, deps());
    expect(outcome).toBeNull();
    const after = await getEditorFolderMapping(db, projectId);
    expect(after).toMatchObject({ moveStatus: null, moveTargetShootDate: null, moveNote: null });
  });
});

describe("Editor folder move: commit rebase with a NULL display path", () => {
  it("rebases an asset's source_path_key but leaves a NULL source_path NULL, not a lower-cased key", async () => {
    const { suffix, projectId, mapping } = await setup();
    const oldRoot = mapping.rootPath;

    await database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', ?, ?)")
      .bind(`collection-${suffix}`, projectId, Date.now(), Date.now()).run();
    const assetSourcePathKey = dropboxPathKey(`${oldRoot}/0. Input/DSC001.CR2`);
    await database.DB.prepare(
      "INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, source_path, source_path_key, publish_status, created_at, updated_at) VALUES (?, ?, 'photo', ?, ?, 100, 'dropbox', NULL, ?, 'ready', ?, ?)",
    ).bind(`asset-${suffix}`, `collection-${suffix}`, `r2/${suffix}`, "DSC001.CR2", assetSourcePathKey, Date.now(), Date.now()).run();

    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    const newRoot = editorFolderPath({ shootDate: "2027-01-15", projectFolderName: suffix });
    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping, deps({
      getMetadata: async () => folder(oldRoot, mapping.rootFolderId!),
      moveFolderStrict: async (_env, _db, _from, to) => folder(to, mapping.rootFolderId!),
    }));
    expect(outcome).toMatchObject({ status: "moved", from: oldRoot, to: newRoot });

    const asset = await database.DB.prepare("SELECT source_path, source_path_key FROM assets WHERE id = ?").bind(`asset-${suffix}`).first<{ source_path: string | null; source_path_key: string }>();
    expect(asset?.source_path).toBeNull();
    expect(asset?.source_path_key).toBe(dropboxPathKey(`${newRoot}/0. Input/DSC001.CR2`));
  });
});

describe("Editor folder move: Dropbox refuses the relocation", () => {
  // #148 and #149 were both a path-level Dropbox error taken as a connection fault. A move_v2 409
  // that is neither a conflict nor a missing path must still leave every other project working.
  it("blocks the mapping with a visible note and leaves the studio connection connected", async () => {
    const { suffix, connectionId, projectId, mapping } = await setup();
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();

    const outcome = await attemptEditorFolderMove(
      env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping,
      deps({
        getMetadata: async () => folder(mapping.rootPath, `id:root-${suffix}`),
        moveFolderStrict: async () => {
          throw new DropboxRelocationRefusedError("Dropbox /files/move_v2 failed (409): to/no_write_permission/..");
        },
      }),
    );

    expect(outcome).toMatchObject({ status: "skipped", reason: "editor_folder_move_refused" });
    expect((outcome as { detail: string }).detail).toContain("no_write_permission");
    expect(await connectionState(connectionId)).toEqual({ status: "connected", last_error: null });

    const stored = (await getEditorFolderMapping(db, projectId))!;
    expect(stored.moveStatus).toBe("blocked");
    expect(stored.rootPath).toBe(mapping.rootPath);
    expect(stored.moveNote).toContain("editor_folder_move_refused");
  });
});

describe("Editor folder move: a commit that keeps failing after Dropbox has already moved the tree", () => {
  /** Occupies the destination's `root_path_key` on the same connection, so the commit batch hits
   * the connection-scoped UNIQUE index and rolls back — deterministically, every attempt. */
  async function blockDestination(connectionId: string, targetPath: string) {
    const other = await setup();
    await database.DB.prepare("UPDATE editor_folder_mappings SET connection_id = ?, root_path = ?, root_path_key = ? WHERE id = ?")
      .bind(connectionId, targetPath, editorFolderPathKey(targetPath), other.mapping.id).run();
  }

  it("counts each failure, then stops retrying and escalates with a note and an audit row", async () => {
    const { suffix, projectId, connectionId, mapping } = await setup();
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    const newRoot = editorFolderPath({ shootDate: "2027-01-15", projectFolderName: suffix });

    // The pre-claim guard already refuses a destination that is taken, so the collision is
    // introduced after the claim — the race the guard cannot close — and is deterministic after
    // that, which is exactly the shape that would otherwise retry forever.
    // Dropbox's own state: once the tree has moved, every later lookup by folder ID finds it at
    // the new root — which is the whole danger, since the database still says otherwise.
    let dropboxPath = mapping.rootPath;
    const moveDeps = (onMove?: () => Promise<void>) => deps({
      getMetadata: async () => folder(dropboxPath, `id:root-${suffix}`),
      moveFolderStrict: async (_env, _db, _from, to) => {
        await onMove?.();
        dropboxPath = to;
        return folder(to, `id:root-${suffix}`);
      },
    });

    // Attempt 1: the tree moves in Dropbox, the commit rolls back, the mapping stays `moving`.
    await expect(attemptEditorFolderMove(
      env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping,
      moveDeps(() => blockDestination(connectionId, newRoot)),
    )).rejects.toThrow();
    let stored = (await getEditorFolderMapping(db, projectId))!;
    expect(stored.moveStatus).toBe("moving");
    expect(stored.moveCommitAttempts).toBe(1);
    expect(stored.moveNote).toBeNull();
    expect((await auditRows("editor_folder.move.commit_stuck", projectId)).results).toHaveLength(0);

    // Attempts 2 and 3, taken over after each lease expires, reach the limit.
    for (const attempt of [2, 3]) {
      await database.DB.prepare("UPDATE editor_folder_mappings SET move_expires_at = ? WHERE id = ?")
        .bind(FIXED_NOW.getTime() - 1000, mapping.id).run();
      const expired = (await getEditorFolderMapping(db, projectId))!;
      await expect(resumeEditorFolderMove(env as never, db, expired, moveDeps())).rejects.toThrow();
      stored = (await getEditorFolderMapping(db, projectId))!;
      expect(stored.moveCommitAttempts).toBe(attempt);
    }

    // Escalated: the note names the disagreement between Dropbox and the database, and an operator
    // has an audit row to find it by.
    expect(stored.moveNote).toContain("editor_folder_move_stuck");
    expect(stored.moveNote).toContain(newRoot);
    const audits = (await auditRows("editor_folder.move.commit_stuck", projectId)).results;
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!.meta_json)).toMatchObject({ to: newRoot, attempts: 3 });

    // And the next pass stops rather than repeating a failure that has proved deterministic —
    // still `moving`, so nothing syncs against a path that is no longer there.
    await database.DB.prepare("UPDATE editor_folder_mappings SET move_expires_at = ? WHERE id = ?")
      .bind(FIXED_NOW.getTime() - 1000, mapping.id).run();
    const wedged = (await getEditorFolderMapping(db, projectId))!;
    const outcome = await resumeEditorFolderMove(env as never, db, wedged, deps());
    expect(outcome).toMatchObject({ status: "skipped", reason: "editor_folder_move_stuck" });
    expect((await getEditorFolderMapping(db, projectId))!.moveStatus).toBe("moving");
  });
});

describe("Editor folder move: Unicode normalisation", () => {
  // macOS hands Dropbox NFD filenames, so `assets.source_path_key` (written by `dropboxPathKey`,
  // which does not normalise) can be decomposed while the mapping's root is composed. Comparing
  // the raw forms silently dropped the row from the rebase, leaving it pointing at a tree that
  // had gone — with no error anywhere.
  it("rebases an asset whose stored key is decomposed while the mapping root is composed", async () => {
    const leaf = "Caf\u00e9 Project";
    const { suffix, projectId, mapping } = await setup({ leaf });
    expect(mapping.rootPath).toContain(leaf);

    await database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', ?, ?)")
      .bind(`collection-${suffix}`, projectId, Date.now(), Date.now()).run();
    const decomposedPath = `${mapping.rootPath}/0. Input/DSC001.CR2`.normalize("NFD");
    const decomposedKey = dropboxPathKey(decomposedPath);
    expect(decomposedKey).not.toBe(dropboxPathKey(`${mapping.rootPath}/0. Input/DSC001.CR2`));
    await database.DB.prepare(
      "INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, source_path, source_path_key, publish_status, created_at, updated_at) VALUES (?, ?, 'photo', ?, ?, 100, 'dropbox', ?, ?, 'ready', ?, ?)",
    ).bind(`asset-${suffix}`, `collection-${suffix}`, `r2/${suffix}`, "DSC001.CR2", decomposedPath, decomposedKey, Date.now(), Date.now()).run();

    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    const newRoot = editorFolderPath({ shootDate: "2027-01-15", projectFolderName: leaf });
    const outcome = await attemptEditorFolderMove(
      env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping,
      deps({
        getMetadata: async () => folder(mapping.rootPath, `id:root-${suffix}`),
        moveFolderStrict: async (_env, _db, _from, to) => folder(to, `id:root-${suffix}`),
      }),
    );
    expect(outcome).toMatchObject({ status: "moved" });

    const asset = await database.DB.prepare("SELECT source_path, source_path_key FROM assets WHERE id = ?").bind(`asset-${suffix}`).first<{ source_path: string; source_path_key: string }>();
    expect(asset?.source_path).toBe(`${newRoot}/0. Input/DSC001.CR2`);
    expect(asset?.source_path_key).toBe(dropboxPathKey(`${newRoot}/0. Input/DSC001.CR2`));
  });
});

describe("Editor folder move: the RAW re-sync it queues", () => {
  it("queues no dropbox_sync for a project with no Tonomo RAW folder, so the jobs list shows no RAW pass that never ran", async () => {
    const { suffix, projectId, mapping } = await setup();
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();
    expect((await database.DB.prepare("SELECT raw_folder_path FROM projects WHERE id = ?").bind(projectId).first<{ raw_folder_path: string | null }>())?.raw_folder_path).toBeNull();

    const outcome = await attemptEditorFolderMove(
      env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping,
      deps({
        getMetadata: async () => folder(mapping.rootPath, `id:root-${suffix}`),
        moveFolderStrict: async (_env, _db, _from, to) => folder(to, `id:root-${suffix}`),
      }),
    );
    expect(outcome).toMatchObject({ status: "moved" });

    const kinds = await database.DB.prepare("SELECT kind, count(*) AS n FROM jobs WHERE project_id = ? GROUP BY kind").bind(projectId).all<{ kind: string; n: number }>();
    expect(kinds.results).toEqual([{ kind: "editor_sync", n: 1 }]);
  });
});

describe("Editor folder move: the stale-job note and moves that never happen", () => {
  it("leaves a stuck job unstamped when the move defers on the quiet period, so no note claims a move that did not occur", async () => {
    const { projectId, mapping, suffix } = await setup();
    const staleUpdatedAt = FIXED_NOW.getTime() - 3 * 60 * 60 * 1000;
    const jobId = await insertJob({ projectId, kind: "dropbox_sync", status: "running", updatedAt: staleUpdatedAt });
    await database.DB.prepare("UPDATE projects SET shoot_date = '2027-01-15' WHERE id = ?").bind(projectId).run();

    const outcome = await attemptEditorFolderMove(env as never, db, { id: projectId, shootDate: "2027-01-15" }, mapping, deps({
      getMetadata: async () => folder(mapping.rootPath, mapping.rootFolderId!),
      listFolderRecursive: async () => [{
        ".tag": "file", name: "DSC900.CR2", id: `id:upload-${suffix}`, size: 100,
        path_lower: `${mapping.rootPath.toLowerCase()}/0. input/dsc900.cr2`,
        path_display: `${mapping.rootPath}/0. Input/DSC900.CR2`,
        server_modified: new Date(FIXED_NOW.getTime() - 60 * 1000).toISOString(),
      } as DropboxEntry],
    }));

    expect(outcome).toMatchObject({ status: "skipped", reason: "editor_folder_move_deferred" });
    expect((await jobRow(jobId))?.error).toBeNull();
  });
});
