import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/dropbox/client", () => ({
  createDropboxClientContext: vi.fn(),
  download: vi.fn(),
  listFolder: vi.fn(),
  listFolderContinue: vi.fn(),
  recordDropboxSuccess: vi.fn(),
}));
vi.mock("../src/dropbox/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dropbox/sync")>()),
  syncProjectRawFolder: vi.fn(async () => ({ claimed: false, hasMore: false, newlyImported: 0 })),
}));

import QuincyBackground from "../src";
import type { Env } from "../src/env";
import { createDropboxClientContext, download, listFolder, listFolderContinue, recordDropboxSuccess, type DropboxFile } from "../src/dropbox/client";
import { commitAutomaticStage } from "../src/lib/automatic-stage";
import { EDITED_ARRIVAL_PAGE_SIZE, reconcileEditedArrivals } from "../src/edited-arrival";

declare const __PORTAL_MIGRATION_SQL__: string;
const bindings = env as unknown as { DB: D1Database; MEDIA: R2Bucket };
const MINUTE = 60_000;
const T0 = Date.parse("2026-10-02T01:00:00.000Z"); // 12:00 in Sydney, 2026-10-02

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const statements = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim()).filter(Boolean);
    for (const statement of statements) await bindings.DB.exec(`${statement};`);
  }
}

let sendMock = vi.fn(async () => undefined);
function localEnv(flag = "1"): Env {
  return {
    DB: bindings.DB,
    MEDIA: bindings.MEDIA,
    DROPBOX_EDITOR_AUTOMATION_ENABLED: flag,
    INGEST_QUEUE: { send: sendMock },
    NOTIFICATION_QUEUE: { send: vi.fn(async () => undefined) },
    APP_ORIGIN: "https://portal.test",
    RENDITIONS_ENABLED: false,
  } as unknown as Env;
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'");
  const now = Date.now();
  await bindings.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('arrival-admin', 'Admin', 'arrival-admin@test.invalid', 1, 'admin', 1, ?, ?)").bind(now, now).run();
});

beforeEach(async () => {
  // The D1 database is shared by every test in this file; a leftover due Project would take page slots.
  await bindings.DB.prepare("UPDATE projects SET edited_arrived_at = NULL").run();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  sendMock = vi.fn(async () => undefined);
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Fixture = { projectId: string; connectionId: string; filePath: string };

async function fixture(stage = "editing_autohdr", options: { shootDate?: string | null } = {}): Promise<Fixture> {
  const now = Date.now();
  const projectId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const root = `/Editor/01_ACTIVE EDITS/2026-10 October/02/${projectId}`;
  const outputRoot = `${root}/Output`;
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
    bindings.DB.prepare("INSERT INTO projects (id, street, stage_key, shoot_date, created_at, updated_at) VALUES (?, 'Arrival', ?, ?, ?, ?)").bind(projectId, stage, options.shootDate === undefined ? "2026-10-01" : options.shootDate, now, now),
    bindings.DB.prepare("INSERT INTO editor_folder_mappings (id, project_id, connection_id, root_path, root_path_key, root_folder_id, shoot_date, project_folder_name, tonomo_raw_folder_path, photographer_evidence_json, input_roots_json, output_roots_json, editing_notes_path, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'id:root', '2026-10-02', ?, NULL, '{}', ?, ?, ?, 'ready', ?, ?)")
      .bind(crypto.randomUUID(), projectId, connectionId, root, root.toLowerCase(), projectId, JSON.stringify([{ path: `${root}/Input`, section: null, folderId: "id:input" }]), JSON.stringify([{ path: outputRoot, section: null, folderId: "id:output" }]), `${root}/Editing Notes`, now, now),
  ]);
  return { projectId, connectionId, filePath: `${outputRoot}/edited.jpg` };
}

function dropboxFile(data: Fixture, hash: string, name = "edited.jpg"): DropboxFile {
  const path = data.filePath.replace("edited.jpg", name);
  return { ".tag": "file", id: `id:${hash}`, name, size: 4, content_hash: hash, path_lower: path.toLowerCase(), path_display: path };
}

function configureFile(file: DropboxFile): void {
  vi.mocked(createDropboxClientContext).mockResolvedValue({ connectionId: "unused", accessToken: "t" });
  vi.mocked(listFolder).mockResolvedValue({ entries: [file], cursor: "c", has_more: false });
  vi.mocked(listFolderContinue).mockResolvedValue({ entries: [], cursor: "c", has_more: false });
  vi.mocked(download).mockImplementation(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
    headers: { "Dropbox-API-Result": JSON.stringify({ content_hash: file.content_hash }) },
  }));
  vi.mocked(recordDropboxSuccess).mockResolvedValue(undefined);
}

/** A real `editor_sync` queue message through the Worker's queue handler. */
async function importFile(data: Fixture, hash: string, name?: string): Promise<void> {
  configureFile(dropboxFile(data, hash, name));
  const ack = vi.fn(); const retry = vi.fn();
  await new QuincyBackground({} as ExecutionContext, localEnv()).queue({
    queue: "quincy-ingest",
    messages: [{ body: { type: "editor_sync", projectId: data.projectId, connectionId: data.connectionId }, ack, retry }],
  } as never);
  expect(retry).not.toHaveBeenCalled();
  expect(ack).toHaveBeenCalledOnce();
}

async function cron(atMs: number, flag = "1"): Promise<void> {
  vi.setSystemTime(atMs);
  await new QuincyBackground({} as ExecutionContext, localEnv(flag)).scheduled({ cron: "* * * * *", scheduledTime: atMs, noRetry() {} } as ScheduledController);
}

const project = (id: string) => bindings.DB.prepare("SELECT stage_key AS stage, shoot_date AS shootDate, edited_arrived_at AS arrived FROM projects WHERE id = ?").bind(id).first<{ stage: string; shootDate: string | null; arrived: number | null }>();
const count = async (sql: string, ...values: unknown[]) => (await bindings.DB.prepare(sql).bind(...values).first<{ n: number }>())!.n;
const advances = (id: string) => count("SELECT count(*) n FROM audit_log WHERE action = 'stage.auto_advance' AND target_type = 'project' AND target_id = ?", id);
const backoff = (id: string) => bindings.DB.prepare("SELECT edited_arrival_attempts AS attempts, edited_arrival_retry_at AS retry FROM projects WHERE id = ?").bind(id).first<{ attempts: number; retry: number | null }>().then((row) => row!);
const landed = (id: string) => count("SELECT count(*) n FROM notifications WHERE project_id = ? AND type = 'edited_landed'", id);

describe("an automatic Stage commit straight to Edited review (#486)", () => {
  it.each(["awaiting_raw", "raw_review", "editing_autohdr"])("is a winner from %s with no workflow tail", async (stage) => {
    const data = await fixture(stage);
    const outcome = await commitAutomaticStage({
      env: { DB: bindings.DB }, projectId: data.projectId, from: stage as never, to: "edited_review", auditId: crypto.randomUUID(), auditActorId: null,
      auditMetaJson: "{}", workflow: { kind: "none" }, alreadyAtDestination: { allowed: true, effect: { kind: "none" } },
    });
    expect(outcome.kind).toBe("winner");
    expect((await project(data.projectId))?.stage).toBe("edited_review");
  });
});

describe("Editor Output import to Edited review after 15 quiet minutes (#486)", () => {
  it("moves exactly at 15 minutes with one audit and one notification, and a second pass changes nothing", async () => {
    const data = await fixture();
    await importFile(data, "hash-a");
    expect((await project(data.projectId))?.arrived).toBe(T0);

    await cron(T0 + 15 * MINUTE - 1);
    expect((await project(data.projectId))?.stage).toBe("editing_autohdr");
    expect(await advances(data.projectId)).toBe(0);

    await cron(T0 + 15 * MINUTE);
    expect((await project(data.projectId))?.stage).toBe("edited_review");
    expect(await advances(data.projectId)).toBe(1);
    expect(await landed(data.projectId)).toBe(1);
    const audit = await bindings.DB.prepare("SELECT actor_id, meta_json FROM audit_log WHERE action = 'stage.auto_advance' AND target_id = ?").bind(data.projectId).first<{ actor_id: string | null; meta_json: string }>();
    expect(audit?.actor_id).toBeNull();
    expect(JSON.parse(audit!.meta_json)).toMatchObject({ trigger: "edited_arrival", from: "editing_autohdr", to: "edited_review" });

    await cron(T0 + 16 * MINUTE);
    expect(await advances(data.projectId)).toBe(1);
    expect(await landed(data.projectId)).toBe(1);
  });

  it("restarts the quiet period with every new arrival", async () => {
    const data = await fixture("raw_review");
    await importFile(data, "hash-a");
    vi.setSystemTime(T0 + 10 * MINUTE);
    await importFile(data, "hash-b", "second.jpg");
    await cron(T0 + 15 * MINUTE);
    expect((await project(data.projectId))?.stage).toBe("raw_review");
    await cron(T0 + 25 * MINUTE);
    expect((await project(data.projectId))?.stage).toBe("edited_review");
  });

  it("never re-notifies for Edited files arriving after the move, and never moves Edited review or Delivered", async () => {
    const data = await fixture();
    await importFile(data, "hash-a");
    await cron(T0 + 15 * MINUTE);
    expect(await landed(data.projectId)).toBe(1);

    vi.setSystemTime(T0 + 20 * MINUTE);
    await importFile(data, "hash-b", "later.jpg");
    expect((await project(data.projectId))?.arrived).toBeNull();
    await cron(T0 + 40 * MINUTE);
    expect(await landed(data.projectId)).toBe(1);
    expect(await advances(data.projectId)).toBe(1);

    const delivered = await fixture("delivered");
    await importFile(delivered, "hash-d");
    await cron(T0 + 60 * MINUTE);
    expect((await project(delivered.projectId))?.stage).toBe("delivered");
    expect(await advances(delivered.projectId)).toBe(0);
  });

  it("does not move a Project archived after its arrival, and clears the marker", async () => {
    const data = await fixture();
    await importFile(data, "hash-a");
    await bindings.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(T0 + MINUTE, data.projectId).run();
    await cron(T0 + 20 * MINUTE);
    expect(await advances(data.projectId)).toBe(0);
    expect((await project(data.projectId))?.stage).toBe("editing_autohdr");
    expect((await project(data.projectId))?.arrived).toBeNull();
  });

  it("does not move again after a human moves it back to Editing", async () => {
    const data = await fixture();
    await importFile(data, "hash-a");
    await cron(T0 + 15 * MINUTE);
    expect((await project(data.projectId))?.stage).toBe("edited_review");
    await bindings.DB.prepare("UPDATE projects SET stage_key = 'editing_autohdr' WHERE id = ?").bind(data.projectId).run();
    await cron(T0 + 30 * MINUTE);
    await cron(T0 + 45 * MINUTE);
    expect((await project(data.projectId))?.stage).toBe("editing_autohdr");
    expect(await advances(data.projectId)).toBe(1);
    expect(await landed(data.projectId)).toBe(1);
  });

  it("applies the shoot-date fill when leaving Awaiting RAW and reconciles the Editor folders", async () => {
    const data = await fixture("awaiting_raw", { shootDate: null });
    await importFile(data, "hash-a");
    await cron(T0 + 15 * MINUTE);
    const moved = await project(data.projectId);
    expect(moved?.stage).toBe("edited_review");
    expect(moved?.shootDate).toBe("2026-10-02");
    expect(await count("SELECT count(*) n FROM audit_log WHERE action = 'project.shoot_date.changed' AND target_id = ?", data.projectId)).toBe(1);
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ type: "editor_reconcile", projectId: data.projectId }));
  });

  it("moves with Editor automation off, because Portal uploads count too", async () => {
    const data = await fixture();
    await importFile(data, "hash-a");
    await cron(T0 + 15 * MINUTE, "0");
    expect((await project(data.projectId))?.stage).toBe("edited_review");
  });
});

describe("the pass itself (#486)", () => {
  async function dueProject(stage = "editing_autohdr"): Promise<string> {
    const data = await fixture(stage);
    const collectionId = crypto.randomUUID(); const assetId = crypto.randomUUID(); const now = Date.now();
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'edited', 'received', 1, ?, ?)").bind(collectionId, data.projectId, now, now),
      bindings.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, 'photo', ?, 'e.jpg', 4, 'upload', ?, ?)").bind(assetId, collectionId, `tests/${assetId}.jpg`, now, now),
      bindings.DB.prepare("UPDATE projects SET edited_arrived_at = ? WHERE id = ?").bind(T0, data.projectId),
    ]);
    return data.projectId;
  }

  it("does not move an arrival that lands between the scan and the commit", async () => {
    const id = await dueProject();
    const stale = { kind: "edited_arrival_quiet" as const, projectId: id, latestArrivalAt: T0, cutoffAt: T0 + 15 * MINUTE };
    await bindings.DB.prepare("UPDATE projects SET edited_arrived_at = ? WHERE id = ?").bind(T0 + 16 * MINUTE, id).run();
    const outcome = await commitAutomaticStage({
      env: { DB: bindings.DB }, projectId: id, from: "editing_autohdr", to: "edited_review", auditId: crypto.randomUUID(), auditActorId: null,
      auditMetaJson: "{}", workflow: stale, alreadyAtDestination: { allowed: true, effect: { kind: "none" } },
    });
    expect(outcome.kind).toBe("loser");
    expect((await project(id))?.stage).toBe("editing_autohdr");
    expect(await advances(id)).toBe(0);
  });

  it("does not move a Project whose arrival is not yet quiet when the commit runs", async () => {
    const id = await dueProject();
    const outcome = await commitAutomaticStage({
      env: { DB: bindings.DB }, projectId: id, from: "editing_autohdr", to: "edited_review", auditId: crypto.randomUUID(), auditActorId: null,
      auditMetaJson: "{}", workflow: { kind: "edited_arrival_quiet", projectId: id, latestArrivalAt: T0, cutoffAt: T0 - 1 }, alreadyAtDestination: { allowed: true, effect: { kind: "none" } },
    });
    expect(outcome.kind).toBe("loser");
    expect(await advances(id)).toBe(0);
  });

  it("works through a page of due Projects fairly, without a failing one hiding the rest", async () => {
    const ids: string[] = [];
    for (let index = 0; index < EDITED_ARRIVAL_PAGE_SIZE + 5; index += 1) ids.push(await dueProject());
    const poisoned = ids[0]!;
    // Oldest arrival, so it is first on the page whatever the random ids are.
    await bindings.DB.prepare("UPDATE projects SET edited_arrived_at = ? WHERE id = ?").bind(T0 - 1, poisoned).run();
    const realCommit = commitAutomaticStage;
    const commit = (async (input: Parameters<typeof commitAutomaticStage>[0]) => {
      if (input.projectId === poisoned) throw new Error("boom");
      return realCommit(input);
    }) as typeof commitAutomaticStage;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = await reconcileEditedArrivals(localEnv(), T0 + 15 * MINUTE, { commit });
    expect(first.scanned).toBe(EDITED_ARRIVAL_PAGE_SIZE);
    expect(first.failures).toBe(1);
    expect(first.moved).toBe(EDITED_ARRIVAL_PAGE_SIZE - 1);
    // The arrival is kept, with a backoff, so the failing row neither holds the page nor is lost.
    expect((await project(poisoned))?.arrived).toBe(T0 - 1);
    expect(await backoff(poisoned)).toEqual({ attempts: 1, retry: T0 + 16 * MINUTE });
    const second = await reconcileEditedArrivals(localEnv(), T0 + 15 * MINUTE + 30_000, { commit });
    expect(second.moved).toBe(5);
    for (const id of ids.slice(1)) expect((await project(id))?.stage).toBe("edited_review");
    expect((await project(poisoned))?.stage).toBe("editing_autohdr");
    // A transient failure recovers: once the error clears and the backoff passes, the Project moves.
    const third = await reconcileEditedArrivals(localEnv(), T0 + 16 * MINUTE);
    expect(third.moved).toBe(1);
    expect((await project(poisoned))?.stage).toBe("edited_review");
  });

  it("keeps the arrival through two lost commits and a transient D1 error, then moves", async () => {
    const id = await dueProject();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const lose = (async () => ({ kind: "loser" })) as never;
    await reconcileEditedArrivals(localEnv(), T0 + 15 * MINUTE, { commit: lose });
    expect((await project(id))?.arrived).toBe(T0);
    await reconcileEditedArrivals(localEnv(), T0 + 16 * MINUTE, { commit: (async () => { throw new Error("D1 unavailable"); }) as never });
    expect((await project(id))?.arrived).toBe(T0);
    expect((await backoff(id)).attempts).toBe(2);
    expect((await reconcileEditedArrivals(localEnv(), T0 + 17 * MINUTE)).moved).toBe(0);
    expect((await reconcileEditedArrivals(localEnv(), T0 + 18 * MINUTE)).moved).toBe(1);
    expect((await project(id))?.stage).toBe("edited_review");
  });

  it("waits for a ready Edited asset: a pending or failed publish keeps the arrival and moves nothing", async () => {
    const id = await dueProject();
    await bindings.DB.prepare("UPDATE assets SET publish_status = 'failed' WHERE collection_id IN (SELECT id FROM collections WHERE project_id = ?)").bind(id).run();
    expect((await reconcileEditedArrivals(localEnv(), T0 + 15 * MINUTE)).moved).toBe(0);
    expect((await project(id))?.arrived).toBe(T0);
    expect(await landed(id)).toBe(0);
    await bindings.DB.prepare("UPDATE assets SET publish_status = 'ready' WHERE collection_id IN (SELECT id FROM collections WHERE project_id = ?)").bind(id).run();
    expect((await reconcileEditedArrivals(localEnv(), T0 + 16 * MINUTE)).moved).toBe(1);
    expect(await landed(id)).toBe(1);
  });

  it("does not move when the ready asset is deleted between the scan and the commit", async () => {
    const id = await dueProject();
    const realCommit = commitAutomaticStage;
    const commit = (async (input: Parameters<typeof commitAutomaticStage>[0]) => {
      await bindings.DB.prepare("DELETE FROM assets WHERE collection_id IN (SELECT id FROM collections WHERE project_id = ?)").bind(id).run();
      return realCommit(input);
    }) as typeof commitAutomaticStage;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await reconcileEditedArrivals(localEnv(), T0 + 15 * MINUTE, { commit });
    expect((await project(id))?.stage).toBe("editing_autohdr");
    expect(await advances(id)).toBe(0);
    expect(await landed(id)).toBe(0);
  });

  it("leaves a Project in place when its Edited set is gone", async () => {
    const id = await dueProject();
    await bindings.DB.prepare("UPDATE assets SET superseded_at = ? WHERE collection_id IN (SELECT id FROM collections WHERE project_id = ?)").bind(T0, id).run();
    const summary = await reconcileEditedArrivals(localEnv(), T0 + 15 * MINUTE);
    expect(summary.moved).toBe(0);
    expect((await project(id))?.stage).toBe("editing_autohdr");
    expect((await project(id))?.arrived).toBeNull();
  });

  it("does nothing, and keeps the arrival, while automatic board writes are off", async () => {
    const id = await dueProject();
    await executeSql("UPDATE feature_flags SET enabled = 0 WHERE key = 'tb5a_board_contract_enabled'");
    try {
      const summary = await reconcileEditedArrivals(localEnv(), T0 + 15 * MINUTE);
      expect(summary).toMatchObject({ scanned: 0, moved: 0 });
      expect((await project(id))?.arrived).toBe(T0);
    } finally {
      await executeSql("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'");
    }
  });
});
