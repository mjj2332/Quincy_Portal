import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/dropbox/client", () => ({
  createDropboxClientContext: vi.fn(),
  download: vi.fn(),
  getSharedLinkMetadata: vi.fn(),
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
import { syncProjectRawFolder } from "../src/dropbox/sync";

declare const __PORTAL_MIGRATION_SQL__: string;

const bindings = env as unknown as { DB: D1Database; MEDIA: R2Bucket };

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
  mappingId: string;
  inputRoot: string;
  legacyRoot: string;
};

async function fixture(mappingState: "ready" | "pending" | "needs_review" = "ready", withLegacy = true): Promise<Fixture> {
  const now = Date.now();
  const projectId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  const mappingId = crypto.randomUUID();
  const root = `/Editor/01_ACTIVE EDITS/2026-10 October/02/${projectId}`;
  const inputRoot = `${root}/Day/Input`;
  const legacyRoot = `/Tonomo/Raw Files/${projectId}`;
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
    bindings.DB.prepare("INSERT INTO projects (id, street, stage_key, raw_folder_path, raw_folder_link, created_at, updated_at) VALUES (?, 'Editor input', 'awaiting_raw', ?, NULL, ?, ?)").bind(projectId, withLegacy ? legacyRoot : null, now, now),
    bindings.DB.prepare("INSERT INTO editor_folder_mappings (id, project_id, connection_id, root_path, root_path_key, root_folder_id, shoot_date, project_folder_name, tonomo_raw_folder_path, photographer_evidence_json, input_roots_json, output_roots_json, editing_notes_path, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '2026-10-02', ?, ?, '{}', ?, ?, ?, ?, ?, ?)")
      .bind(
        mappingId,
        projectId,
        connectionId,
        root,
        root.toLowerCase(),
        "id:root",
        projectId,
        legacyRoot,
        JSON.stringify([{ path: inputRoot, section: "Day", folderId: "id:input" }]),
        JSON.stringify([{ path: `${root}/Output`, section: "Day", folderId: "id:output" }]),
        `${root}/Editing Notes`,
        mappingState,
        now,
        now,
      ),
  ]);
  return { projectId, connectionId, mappingId, inputRoot, legacyRoot };
}

function file(path: string, name: string, id = name): DropboxFile {
  return {
    ".tag": "file",
    id,
    name,
    size: 4,
    content_hash: `hash-${id}`,
    path_lower: path.toLowerCase(),
    path_display: path,
  };
}

function configure(files: DropboxFile[]): void {
  vi.mocked(createDropboxClientContext).mockResolvedValue({ connectionId: "mock-context", accessToken: "test-token" });
  vi.mocked(listFolder).mockResolvedValue({ entries: files, cursor: "cursor", has_more: false });
  vi.mocked(listFolderContinue).mockResolvedValue({ entries: [], cursor: "cursor", has_more: false });
  vi.mocked(download).mockImplementation(async (_env, _db, path) => {
    const file = files.find((candidate) => (candidate.path_display ?? candidate.path_lower).toLowerCase() === path.toLowerCase());
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      headers: {
        "content-type": "image/jpeg",
        ...(file?.content_hash ? { "Dropbox-API-Result": JSON.stringify({ content_hash: file.content_hash }) } : {}),
      },
    });
  });
  vi.mocked(recordDropboxSuccess).mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Editor Input synchronization", () => {
  it("restores a returning A revision as a new current asset after A -> B -> A", async () => {
    const data = await fixture();
    for (const revision of ["a", "b", "a"]) {
      configure([file(`${data.inputRoot}/frame.jpg`, "frame.jpg", revision)]);
      await syncProjectRawFolder(localEnv(), data.projectId, undefined, data.connectionId);
    }
    const result = await bindings.DB.prepare("SELECT a.id, a.content_hash, a.superseded_at FROM assets a JOIN collections c ON c.id=a.collection_id WHERE c.project_id=? ORDER BY a.created_at").bind(data.projectId).all<{id:string;content_hash:string;superseded_at:number|null}>();
    expect(result.results).toHaveLength(3);
    expect(result.results.filter((row) => row.superseded_at === null).map((row) => row.content_hash)).toEqual(["hash-a"]);
    expect(new Set(result.results.map((row) => row.id)).size).toBe(3);
  });

  it("does not commit a legacy download after a ready mapping takes over", async () => {
    const data = await fixture("pending");
    configure([file(`${data.legacyRoot}/frame.jpg`, "frame.jpg", "legacy")]);
    vi.mocked(download).mockImplementation(async () => {
      await bindings.DB.prepare("UPDATE editor_folder_mappings SET state='ready' WHERE id=?").bind(data.mappingId).run();
      return new Response(new Uint8Array([0xff,0xd8,0xff,0xd9]));
    });
    await syncProjectRawFolder(localEnv(), data.projectId, undefined, data.connectionId);
    expect(await bindings.DB.prepare("SELECT count(*) n FROM assets a JOIN collections c ON c.id=a.collection_id WHERE c.project_id=?").bind(data.projectId).first()).toEqual({n:0});
  });

  it("rejects a stale mapped Input list before persisting bytes", async () => {
    const data = await fixture();
    const input = file(`${data.inputRoot}/stale.jpg`, "stale.jpg", "stale-input");
    configure([input]);
    vi.mocked(download).mockImplementation(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      headers: {
        "content-type": "image/jpeg",
        "Dropbox-API-Result": JSON.stringify({ content_hash: "downloaded-after-list" }),
      },
    }));
    await expect(syncProjectRawFolder(localEnv(), data.projectId, undefined, data.connectionId, "manual_dropbox_sync"))
      .rejects.toThrow(/content hash no longer matches/);
    await expect(bindings.DB.prepare("SELECT count(*) AS count FROM assets a JOIN collections c ON c.id = a.collection_id WHERE c.project_id = ? AND c.kind = 'raw'").bind(data.projectId).first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
  });

  it("imports nested DNG/JPEG files, preserves mapped sections, and skips DNG XMP scanning", async () => {
    const data = await fixture();
    configure([
      file(`${data.inputRoot}/Interior/one.DNG`, "one.DNG", "dng-one"),
      file(`${data.inputRoot}/Interior/two.jpg`, "two.jpg", "jpg-two"),
      file(`${data.inputRoot}/Manual-Uploads/asset/echo.jpg`, "echo.jpg", "echo"),
    ]);
    const result = await syncProjectRawFolder(localEnv(), data.projectId, undefined, data.connectionId, "manual_dropbox_sync");
    expect(result).toMatchObject({ newlyImported: 2, currentRawAvailable: true, claimed: true, hasMore: false });
    expect(download).toHaveBeenCalledTimes(3);
    const rows = await bindings.DB.prepare("SELECT original_filename, section, source_path, r2_key FROM assets a JOIN collections c ON c.id = a.collection_id WHERE c.project_id = ? ORDER BY original_filename").bind(data.projectId).all<{ original_filename: string; section: string | null; source_path: string; r2_key: string }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ original_filename: "one.DNG", section: "Day/Interior", source_path: `${data.inputRoot}/Interior/one.DNG` }),
      expect.objectContaining({ original_filename: "two.jpg", section: "Day/Interior", source_path: `${data.inputRoot}/Interior/two.jpg` }),
    ]));
    const dng = rows.results.find((row) => row.original_filename === "one.DNG")!;
    await expect(bindings.MEDIA.head(dng.r2_key)).resolves.toMatchObject({ httpMetadata: { contentType: "image/x-adobe-dng" } });
    await expect(bindings.DB.prepare("SELECT raw_folder_path FROM projects WHERE id = ?").bind(data.projectId).first())
      .resolves.toEqual({ raw_folder_path: data.legacyRoot });
  });

  it("keeps legacy Tonomo sync available while a mapping is pending or needs review", async () => {
    for (const mappingState of ["pending", "needs_review"] as const) {
      const data = await fixture(mappingState);
      const legacyFile = file(`${data.legacyRoot}/capture.jpg`, "capture.jpg", `${mappingState}-capture`);
      configure([legacyFile]);
      await expect(syncProjectRawFolder(localEnv(), data.projectId, undefined, data.connectionId, "manual_dropbox_sync"))
        .resolves.toMatchObject({ newlyImported: 1, claimed: true });
    }
  });

  it("fails closed when a non-ready mapping has no legacy path", async () => {
    const data = await fixture("needs_review", false);
    configure([]);
    await expect(syncProjectRawFolder(localEnv(), data.projectId, undefined, data.connectionId, "manual_dropbox_sync"))
      .rejects.toThrow(/needs review/);
    expect(listFolder).not.toHaveBeenCalled();
  });

  it("refuses a ready mapping when a caller supplies the wrong Dropbox connection", async () => {
    const data = await fixture();
    configure([]);
    await expect(syncProjectRawFolder(localEnv(), data.projectId, undefined, "wrong-connection", "manual_dropbox_sync"))
      .rejects.toThrow(/requires Dropbox connection/);
    expect(listFolder).not.toHaveBeenCalled();
  });

  it("does not rewrite an upload asset when a provider copy reuses its identity", async () => {
    const data = await fixture();
    const now = Date.now();
    const collectionId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const providerPath = `${data.inputRoot}/copy.jpg`;
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO collections (id, project_id, kind, status, created_at, updated_at) VALUES (?, ?, 'raw', 'received', ?, ?)").bind(collectionId, data.projectId, now, now),
      bindings.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, content_hash, source, source_path, created_at, updated_at) VALUES (?, ?, ?, 'upload.jpg', 4, 'hash-upload', 'upload', NULL, ?, ?)").bind(assetId, collectionId, `tests/${assetId}.jpg`, now, now),
      bindings.DB.prepare("INSERT INTO asset_ingest_identities (id, collection_id, identity_key, asset_id, created_at) VALUES (?, ?, 'hash:hash-upload', ?, ?)").bind(crypto.randomUUID(), collectionId, assetId, now),
    ]);
    configure([file(providerPath, "copy.jpg", "upload")]);
    await expect(syncProjectRawFolder(localEnv(), data.projectId, undefined, data.connectionId, "manual_dropbox_sync"))
      .resolves.toMatchObject({ newlyImported: 0, claimed: true });
    await expect(bindings.DB.prepare("SELECT source, source_path FROM assets WHERE id = ?").bind(assetId).first())
      .resolves.toEqual({ source: "upload", source_path: null });
  });
});

describe("Editor Input synchronization: move in progress (#153)", () => {
  it("is a no-op while the mapping is moving, without listing Dropbox, and leaves no stuck claim or job", async () => {
    const data = await fixture();
    await bindings.DB.prepare("UPDATE editor_folder_mappings SET move_status = 'moving' WHERE id = ?").bind(data.mappingId).run();
    configure([file(`${data.inputRoot}/frame.jpg`, "frame.jpg", "moving")]);

    await expect(syncProjectRawFolder(localEnv(), data.projectId, undefined, data.connectionId))
      .resolves.toEqual({ newlyImported: 0, currentRawAvailable: false, claimed: false, hasMore: false });
    expect(listFolder).not.toHaveBeenCalled();
    await expect(bindings.DB.prepare("SELECT state FROM raw_reconciliation_claims WHERE project_id = ?").bind(data.projectId).first())
      .resolves.toEqual({ state: "done" });
    await expect(bindings.DB.prepare("SELECT status FROM jobs WHERE project_id = ? AND kind = 'dropbox_sync'").bind(data.projectId).first<{ status: string }>())
      .resolves.toMatchObject({ status: "done" });
  });

  it("does not update an existing identity's path or insert a fresh asset once the mapping starts moving mid-listing", async () => {
    const data = await fixture();
    const returning = file(`${data.inputRoot}/returning.jpg`, "returning.jpg", "returning");
    const fresh = file(`${data.inputRoot}/fresh.jpg`, "fresh.jpg", "fresh");
    const collectionId = crypto.randomUUID();
    const existingAssetId = crypto.randomUUID();
    const now = Date.now();
    const oldSourcePath = `${data.inputRoot}/OLD-CASED-returning.jpg`;
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO collections (id, project_id, kind, status, created_at, updated_at) VALUES (?, ?, 'raw', 'received', ?, ?)").bind(collectionId, data.projectId, now, now),
      bindings.DB.prepare(
        "INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, source_path, section, is_premium, created_at, updated_at) VALUES (?, ?, 'photo', ?, 'returning.jpg', 4, ?, 'dropbox', ?, NULL, 1, ?, ?)",
      ).bind(existingAssetId, collectionId, `tests/${existingAssetId}.jpg`, returning.content_hash, oldSourcePath, now, now),
      bindings.DB.prepare(
        "INSERT INTO asset_ingest_identities (id, collection_id, identity_key, asset_id, created_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), collectionId, `hash:${returning.content_hash!.toLowerCase()}`, existingAssetId, now),
    ]);

    vi.mocked(createDropboxClientContext).mockResolvedValue({ connectionId: "mock-context", accessToken: "test-token" });
    vi.mocked(listFolder).mockImplementation(async () => {
      await bindings.DB.prepare("UPDATE editor_folder_mappings SET move_status = 'moving' WHERE id = ?").bind(data.mappingId).run();
      return { entries: [returning, fresh], cursor: "cursor", has_more: false };
    });
    vi.mocked(listFolderContinue).mockResolvedValue({ entries: [], cursor: "cursor", has_more: false });
    vi.mocked(download).mockImplementation(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      headers: { "Dropbox-API-Result": JSON.stringify({ content_hash: fresh.content_hash }) },
    }));
    vi.mocked(recordDropboxSuccess).mockResolvedValue(undefined);

    await expect(syncProjectRawFolder(localEnv(), data.projectId, undefined, data.connectionId))
      .resolves.toMatchObject({ newlyImported: 0 });

    await expect(bindings.DB.prepare("SELECT is_premium, source_path FROM assets WHERE id = ?").bind(existingAssetId).first())
      .resolves.toEqual({ is_premium: 1, source_path: oldSourcePath });
    await expect(bindings.DB.prepare("SELECT count(*) AS count FROM assets a JOIN collections c ON c.id = a.collection_id WHERE c.project_id = ? AND a.original_filename = 'fresh.jpg'").bind(data.projectId).first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
  });
});
