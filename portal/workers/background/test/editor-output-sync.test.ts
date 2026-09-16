import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/dropbox/client", () => ({
  createDropboxClientContext: vi.fn(),
  download: vi.fn(),
  listFolder: vi.fn(),
  listFolderContinue: vi.fn(),
  recordDropboxSuccess: vi.fn(),
}));

import type { Env } from "../src/env";
import {
  createDropboxClientContext,
  download,
  listFolder,
  listFolderContinue,
  recordDropboxSuccess,
  type DropboxFile,
} from "../src/dropbox/client";
import { syncProjectEditorOutput } from "../src/editor-folders/sync-output";
import { dropboxPathKey } from "../src/dropbox/paths";

declare const __PORTAL_MIGRATION_SQL__: string;

const bindings = env as unknown as { DB: D1Database; MEDIA: R2Bucket };
const editorRoot = "/Editor/01_ACTIVE EDITS/2026-10 October/02";

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const statements = chunk
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    for (const statement of statements) await bindings.DB.exec(`${statement};`);
  }
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'");
});

function localEnv(): Env {
  return {
    DB: bindings.DB,
    MEDIA: bindings.MEDIA,
    DROPBOX_EDITOR_AUTOMATION_ENABLED: "1",
    INGEST_QUEUE: { send: vi.fn(async () => undefined) },
    RENDITIONS_ENABLED: false,
  } as unknown as Env;
}

type Fixture = {
  projectId: string;
  connectionId: string;
  outputRoot: string;
  filePath: string;
};

async function fixture(): Promise<Fixture> {
  const now = Date.now();
  const projectId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const root = `${editorRoot}/${projectId}`;
  const outputRoot = `${root}/Output`;
  const filePath = `${outputRoot}/edited.jpg`;
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
    bindings.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Editor output', 'raw_review', ?, ?)").bind(projectId, now, now),
    bindings.DB.prepare("INSERT INTO editor_folder_mappings (id, project_id, connection_id, root_path, root_path_key, root_folder_id, shoot_date, project_folder_name, tonomo_raw_folder_path, photographer_evidence_json, input_roots_json, output_roots_json, editing_notes_path, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '2026-10-02', ?, NULL, '{}', ?, ?, ?, 'ready', ?, ?)")
      .bind(
        crypto.randomUUID(),
        projectId,
        connectionId,
        root,
        root.toLowerCase(),
        "id:root",
        projectId,
        JSON.stringify([{ path: `${root}/Input`, section: null, folderId: "id:input" }]),
        JSON.stringify([{ path: outputRoot, section: null, folderId: "id:output" }]),
        `${root}/Editing Notes`,
        now,
        now,
      ),
  ]);
  return { projectId, connectionId, outputRoot, filePath };
}

function outputFile(fixtureData: Fixture, hash: string): DropboxFile {
  return {
    ".tag": "file",
    id: `id:${hash}`,
    name: "edited.jpg",
    size: 4,
    content_hash: hash,
    path_lower: fixtureData.filePath.toLowerCase(),
    path_display: fixtureData.filePath,
  };
}

function configureFile(file: DropboxFile, downloadedHash = file.content_hash): void {
  vi.mocked(createDropboxClientContext).mockResolvedValue({
    connectionId: "unused-context-connection",
    accessToken: "test-token",
  });
  vi.mocked(listFolder).mockResolvedValue({ entries: [file], cursor: "cursor", has_more: false });
  vi.mocked(listFolderContinue).mockResolvedValue({ entries: [], cursor: "cursor", has_more: false });
  vi.mocked(download).mockImplementation(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
    headers: {
      "content-type": "image/jpeg",
      "Dropbox-API-Result": JSON.stringify({ content_hash: downloadedHash }),
    },
  }));
  vi.mocked(recordDropboxSuccess).mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Editor Output synchronization", () => {
  it("rejects a stale list before persisting bytes", async () => {
    const data = await fixture();
    configureFile(outputFile(data, "listed"), "downloaded");
    await expect(syncProjectEditorOutput(localEnv(), data.projectId, data.connectionId))
      .rejects.toThrow(/content hash no longer matches/);
    await expect(bindings.DB.prepare("SELECT count(*) AS count FROM assets a JOIN collections c ON c.id = a.collection_id WHERE c.project_id = ? AND c.kind = 'edited'").bind(data.projectId).first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
  });

  it("retains immutable A -> B -> A versions without an identity collision", async () => {
    const data = await fixture();
    const first = outputFile(data, "hash-a");
    configureFile(first);
    await expect(syncProjectEditorOutput(localEnv(), data.projectId, data.connectionId)).resolves.toMatchObject({ newlyImported: 1, hasMore: false });
    const second = outputFile(data, "hash-b");
    configureFile(second);
    await expect(syncProjectEditorOutput(localEnv(), data.projectId, data.connectionId)).resolves.toMatchObject({ newlyImported: 1 });
    configureFile(first);
    await expect(syncProjectEditorOutput(localEnv(), data.projectId, data.connectionId)).resolves.toMatchObject({ newlyImported: 1 });

    const versions = await bindings.DB.prepare("SELECT content_hash, version, superseded_at, supersedes_asset_id, replaced_by_asset_id FROM assets a JOIN collections c ON c.id = a.collection_id WHERE c.project_id = ? AND c.kind = 'edited' ORDER BY version").bind(data.projectId).all<{
      content_hash: string;
      version: number;
      superseded_at: number | null;
      supersedes_asset_id: string | null;
      replaced_by_asset_id: string | null;
    }>();
    expect(versions.results).toHaveLength(3);
    expect(versions.results.map((row) => row.content_hash)).toEqual(["hash-a", "hash-b", "hash-a"]);
    expect(versions.results.filter((row) => row.superseded_at === null)).toHaveLength(1);
    expect(versions.results[1]).toMatchObject({ supersedes_asset_id: expect.any(String), replaced_by_asset_id: versions.results[2] ? expect.any(String) : null });
    await expect(bindings.DB.prepare("SELECT received_count FROM collections c WHERE c.project_id = ? AND c.kind = 'edited'").bind(data.projectId).first())
      .resolves.toEqual({ received_count: 1 });
  });

  it("does not let concurrent stale listings supersede a newer current row", async () => {
    const data = await fixture();
    const initial = outputFile(data, "hash-a");
    configureFile(initial);
    await syncProjectEditorOutput(localEnv(), data.projectId, data.connectionId);

    const reached = new Promise<void>((resolve) => {
      let count = 0;
      vi.mocked(download).mockImplementation(async () => {
        count += 1;
        if (count === 2) resolve();
        await releasePromise;
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
          headers: { "Dropbox-API-Result": JSON.stringify({ content_hash: "hash-b" }) },
        });
      });
      vi.mocked(listFolder).mockResolvedValue({ entries: [outputFile(data, "hash-b")], cursor: "cursor", has_more: false });
    });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const first = syncProjectEditorOutput(localEnv(), data.projectId, data.connectionId);
    const second = syncProjectEditorOutput(localEnv(), data.projectId, data.connectionId);
    await reached;
    release();
    await Promise.all([first, second]);

    const current = await bindings.DB.prepare("SELECT content_hash, superseded_at FROM assets a JOIN collections c ON c.id = a.collection_id WHERE c.project_id = ? AND c.kind = 'edited' AND a.superseded_at IS NULL").bind(data.projectId).all<{ content_hash: string; superseded_at: number | null }>();
    expect(current.results).toHaveLength(1);
    expect(current.results[0]?.content_hash).toBe("hash-b");
    await expect(bindings.DB.prepare("SELECT count(*) AS count FROM assets a JOIN collections c ON c.id = a.collection_id WHERE c.project_id = ? AND c.kind = 'edited' AND a.superseded_at IS NULL").bind(data.projectId).first<{ count: number }>())
      .resolves.toEqual({ count: 1 });
  });
});

describe("Editor Output synchronization: move in progress (#153)", () => {
  it("is a no-op while the mapping is moving, without listing Dropbox", async () => {
    const data = await fixture();
    await bindings.DB.prepare("UPDATE editor_folder_mappings SET move_status = 'moving' WHERE project_id = ?").bind(data.projectId).run();
    configureFile(outputFile(data, "hash-moving"));

    await expect(syncProjectEditorOutput(localEnv(), data.projectId, data.connectionId))
      .resolves.toEqual({ newlyImported: 0, currentEditedAvailable: false, hasMore: false });
    expect(createDropboxClientContext).not.toHaveBeenCalled();
    expect(listFolder).not.toHaveBeenCalled();
    await expect(bindings.DB.prepare("SELECT count(*) AS count FROM assets a JOIN collections c ON c.id = a.collection_id WHERE c.project_id = ?").bind(data.projectId).first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
  });

  it("does not update an existing asset's recorded path if the mapping starts moving mid-listing", async () => {
    const data = await fixture();
    const hash = "hash-guard";
    const file = outputFile(data, hash);
    const collectionId = crypto.randomUUID();
    const existingId = crypto.randomUUID();
    const now = Date.now();
    const oldSourcePath = "/Editor/01_ACTIVE EDITS/2026-10 October/02/OLD-CASED-PROJECT/Output/edited.jpg";
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO collections (id, project_id, kind, status, created_at, updated_at) VALUES (?, ?, 'edited', 'received', ?, ?)").bind(collectionId, data.projectId, now, now),
      bindings.DB.prepare(
        "INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, section, is_premium, version, version_group_id, created_at, updated_at) VALUES (?, ?, 'photo', ?, 'edited.jpg', 4, ?, 'dropbox', ?, ?, NULL, 0, 1, ?, ?, ?)",
      ).bind(existingId, collectionId, `tests/${existingId}.jpg`, hash, oldSourcePath, dropboxPathKey(file.path_lower), existingId, now, now),
    ]);

    vi.mocked(createDropboxClientContext).mockResolvedValue({ connectionId: "unused-context-connection", accessToken: "test-token" });
    // The race: the listing call is what the moving claim races against — by the time it
    // resolves, another pass has already flipped this mapping to 'moving'.
    vi.mocked(listFolder).mockImplementation(async () => {
      await bindings.DB.prepare("UPDATE editor_folder_mappings SET move_status = 'moving' WHERE project_id = ?").bind(data.projectId).run();
      return { entries: [file], cursor: "cursor", has_more: false };
    });
    vi.mocked(listFolderContinue).mockResolvedValue({ entries: [], cursor: "cursor", has_more: false });
    vi.mocked(recordDropboxSuccess).mockResolvedValue(undefined);

    await expect(syncProjectEditorOutput(localEnv(), data.projectId, data.connectionId))
      .resolves.toMatchObject({ newlyImported: 0 });
    await expect(bindings.DB.prepare("SELECT source_path FROM assets WHERE id = ?").bind(existingId).first())
      .resolves.toEqual({ source_path: oldSourcePath });
  });

  it("writes nothing for a fresh INSERT when the mapping starts moving mid-listing", async () => {
    const data = await fixture();
    const hash = "hash-insert-race";
    const file = outputFile(data, hash);

    vi.mocked(createDropboxClientContext).mockResolvedValue({ connectionId: "unused-context-connection", accessToken: "test-token" });
    // Same race as the UPDATE-guard test above: the mapping flips to 'moving' while this listing
    // is still in flight, so this is a brand-new INSERT racing the move rather than an existing row.
    vi.mocked(listFolder).mockImplementation(async () => {
      await bindings.DB.prepare("UPDATE editor_folder_mappings SET move_status = 'moving' WHERE project_id = ?").bind(data.projectId).run();
      return { entries: [file], cursor: "cursor", has_more: false };
    });
    vi.mocked(listFolderContinue).mockResolvedValue({ entries: [], cursor: "cursor", has_more: false });
    vi.mocked(download).mockImplementation(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      headers: { "Dropbox-API-Result": JSON.stringify({ content_hash: hash }) },
    }));
    vi.mocked(recordDropboxSuccess).mockResolvedValue(undefined);

    await expect(syncProjectEditorOutput(localEnv(), data.projectId, data.connectionId))
      .resolves.toMatchObject({ newlyImported: 0 });
    await expect(bindings.DB.prepare("SELECT count(*) AS count FROM assets a JOIN collections c ON c.id = a.collection_id WHERE c.project_id = ? AND c.kind = 'edited'").bind(data.projectId).first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
  });

  it("writes nothing for a supersede (existing asset, different content hash) when the mapping starts moving mid-listing", async () => {
    const data = await fixture();
    const oldHash = "hash-supersede-old";
    const newHash = "hash-supersede-new";
    const file = outputFile(data, newHash);
    const collectionId = crypto.randomUUID();
    const existingId = crypto.randomUUID();
    const now = Date.now();
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO collections (id, project_id, kind, status, created_at, updated_at) VALUES (?, ?, 'edited', 'received', ?, ?)").bind(collectionId, data.projectId, now, now),
      bindings.DB.prepare(
        "INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, section, is_premium, version, version_group_id, created_at, updated_at) VALUES (?, ?, 'photo', ?, 'edited.jpg', 4, ?, 'dropbox', ?, ?, NULL, 0, 1, ?, ?, ?)",
      ).bind(existingId, collectionId, `tests/${existingId}.jpg`, oldHash, data.filePath, dropboxPathKey(file.path_lower), existingId, now, now),
    ]);

    vi.mocked(createDropboxClientContext).mockResolvedValue({ connectionId: "unused-context-connection", accessToken: "test-token" });
    // Same race again, but this time listing finds a different content hash than the current row,
    // so a successful pass would both supersede the old asset and insert a new version.
    vi.mocked(listFolder).mockImplementation(async () => {
      await bindings.DB.prepare("UPDATE editor_folder_mappings SET move_status = 'moving' WHERE project_id = ?").bind(data.projectId).run();
      return { entries: [file], cursor: "cursor", has_more: false };
    });
    vi.mocked(listFolderContinue).mockResolvedValue({ entries: [], cursor: "cursor", has_more: false });
    vi.mocked(download).mockImplementation(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      headers: { "Dropbox-API-Result": JSON.stringify({ content_hash: newHash }) },
    }));
    vi.mocked(recordDropboxSuccess).mockResolvedValue(undefined);

    await expect(syncProjectEditorOutput(localEnv(), data.projectId, data.connectionId))
      .resolves.toMatchObject({ newlyImported: 0 });
    await expect(bindings.DB.prepare("SELECT count(*) AS count FROM assets WHERE collection_id = ?").bind(collectionId).first<{ count: number }>())
      .resolves.toEqual({ count: 1 });
    await expect(bindings.DB.prepare("SELECT content_hash, superseded_at FROM assets WHERE id = ?").bind(existingId).first())
      .resolves.toEqual({ content_hash: oldHash, superseded_at: null });
  });
});
