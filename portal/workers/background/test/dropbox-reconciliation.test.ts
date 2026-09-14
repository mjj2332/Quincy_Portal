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
import { createDropboxClientContext, download, listFolder, listFolderContinue, recordDropboxSuccess } from "../src/dropbox/client";
import type { DropboxFile } from "../src/dropbox/client";
import { renewRawReconciliationClaim, syncProjectRawFolder } from "../src/dropbox/sync";

declare const __PORTAL_MIGRATION_SQL__: string;

const bindings = env as unknown as { DB: D1Database; MEDIA: R2Bucket };

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const flatStatements = chunk
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((statement) => statement.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    for (const statement of flatStatements) await bindings.DB.exec(`${statement};`);
  }
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql("UPDATE feature_flags SET enabled = 1 WHERE key = 'tb5a_board_contract_enabled'");
});

type Fixture = {
  projectId: string;
  collectionId: string;
  root: string;
  sourcePath: string;
  sourcePathKey: string;
  oldAssetId: string;
};

function localEnv(database: D1Database = bindings.DB): Env {
  return {
    DB: database,
    MEDIA: bindings.MEDIA,
    INGEST_QUEUE: { send: vi.fn(async () => undefined) },
    RENDITIONS_ENABLED: false,
  } as unknown as Env;
}

function fileFor(fixture: Fixture, hash: string | undefined, name = "capture.jpg"): DropboxFile {
  return {
    ".tag": "file",
    id: `id:${hash ?? name}`,
    name,
    size: 4,
    ...(hash ? { content_hash: hash } : {}),
    path_lower: `${fixture.sourcePathKey}`,
    path_display: `${fixture.sourcePath}`,
  };
}

function configureDropbox(files: DropboxFile[] = []) {
  vi.mocked(createDropboxClientContext).mockResolvedValue({ connectionId: "test-connection", accessToken: "test-token" });
  vi.mocked(listFolder).mockResolvedValue({ entries: files, cursor: "cursor", has_more: false });
  vi.mocked(listFolderContinue).mockResolvedValue({ entries: [], cursor: "cursor", has_more: false });
  // A new file is downloaded twice (full content, then an XMP header range) and both bodies are
  // read — mockResolvedValue would hand out the SAME Response instance to both calls, and a
  // Response body can only be read once ("Body has already been used"). Return a fresh Response
  // per call instead.
  vi.mocked(download).mockImplementation(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
    headers: { "content-type": "image/jpeg" },
  }));
  vi.mocked(recordDropboxSuccess).mockResolvedValue(undefined);
}

async function fixture(options: { archived?: boolean; stage?: string; seedOld?: boolean } = {}): Promise<Fixture> {
  const now = Date.now();
  const projectId = crypto.randomUUID();
  const collectionId = crypto.randomUUID();
  const oldAssetId = crypto.randomUUID();
  const root = `/Tonomo/Raw Files/Reconciliation/${projectId}`;
  const sourcePath = `${root}/capture.jpg`;
  const sourcePathKey = sourcePath.toLowerCase();
  await bindings.DB.batch([
    bindings.DB.prepare("INSERT INTO projects (id, street, stage_key, raw_folder_path, archived_at, created_at, updated_at) VALUES (?, 'Dropbox reconciliation', ?, ?, ?, ?, ?)")
      .bind(projectId, options.stage ?? "raw_review", root, options.archived ? now : null, now, now),
    bindings.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?)")
      .bind(collectionId, projectId, now, now),
    ...(options.seedOld === false ? [] : [
      bindings.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, created_at, updated_at) VALUES (?, ?, ?, 'capture.jpg', 4, 'hash-a', 'dropbox', ?, ?, ?, ?)")
        .bind(oldAssetId, collectionId, `tests/${oldAssetId}.jpg`, sourcePath, sourcePathKey, now, now),
    ]),
  ]);
  await bindings.DB.prepare("UPDATE collections SET received_count = (SELECT count(*) FROM assets WHERE collection_id = ? AND superseded_at IS NULL), status = 'received' WHERE id = ?")
    .bind(collectionId, collectionId).run();
  return { projectId, collectionId, root, sourcePath, sourcePathKey, oldAssetId };
}

async function rows(fixtureData: Fixture) {
  return bindings.DB.prepare("SELECT id, content_hash, source_path_key, supersedes_asset_id, superseded_at, replaced_by_asset_id FROM assets WHERE collection_id = ? ORDER BY id")
    .bind(fixtureData.collectionId).all<{
      id: string;
      content_hash: string | null;
      source_path_key: string | null;
      supersedes_asset_id: string | null;
      superseded_at: number | null;
      replaced_by_asset_id: string | null;
    }>();
}

async function receivedCount(collectionId: string) {
  return bindings.DB.prepare("SELECT received_count FROM collections WHERE id = ?")
    .bind(collectionId).first<{ received_count: number }>();
}

/** Runs a hook immediately after a specific `env.DB.batch()` call completes, keyed by its
 * 1-based position (1 = the first, always-attempted insert; 2 = the retry batch on collision).
 * Used to inject state that a real concurrent writer would have committed in between, without
 * it being visible to whichever batch runs before the hook fires. */
function withBatchHooks(hooks: Partial<Record<number, () => Promise<void>>>): D1Database {
  let batchNumber = 0;
  return new Proxy(bindings.DB, {
    get(target, property, receiver) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batchNumber += 1;
          const result = await target.batch(statements);
          await hooks[batchNumber]?.();
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

beforeEach(() => {
  vi.clearAllMocks();
  configureDropbox();
});

describe("Dropbox RAW delete-then-reupload reconciliation", () => {
  it("creates a replacement, preserves the old row, links both versions, audits, and counts one current asset", async () => {
    const context = await fixture();
    configureDropbox([fileFor(context, "hash-b")]);

    await expect(syncProjectRawFolder(localEnv(), context.projectId)).resolves.toMatchObject({ newlyImported: 1, claimed: true });
    const result = await rows(context);
    expect(result.results).toHaveLength(2);
    const old = result.results.find((row) => row.id === context.oldAssetId)!;
    const replacement = result.results.find((row) => row.id !== context.oldAssetId)!;
    expect(replacement).toMatchObject({ content_hash: "hash-b", supersedes_asset_id: context.oldAssetId, superseded_at: null });
    expect(old).toMatchObject({ content_hash: "hash-a", superseded_at: expect.any(Number), replaced_by_asset_id: replacement.id });
    await expect(receivedCount(context.collectionId)).resolves.toEqual({ received_count: 1 });
    await expect(bindings.DB.prepare("SELECT count(*) count FROM audit_log WHERE target_id = ? AND action = 'asset.ingested'").bind(replacement.id).first<{ count: number }>())
      .resolves.toEqual({ count: 1 });
  });

  it("keeps ordinary new-file and ordinary update paths unchanged", async () => {
    const newFileContext = await fixture({ seedOld: false });
    configureDropbox([fileFor(newFileContext, "hash-new")]);
    await expect(syncProjectRawFolder(localEnv(), newFileContext.projectId)).resolves.toMatchObject({ newlyImported: 1 });
    await expect(rows(newFileContext)).resolves.toMatchObject({ results: [expect.objectContaining({ content_hash: "hash-new", superseded_at: null })] });

    const updateContext = await fixture();
    const movedPath = `${updateContext.root}/renamed.jpg`;
    const movedKey = movedPath.toLowerCase();
    const moved = fileFor(updateContext, "hash-a", "renamed.jpg");
    moved.path_lower = movedKey;
    moved.path_display = movedPath;
    configureDropbox([moved]);
    await expect(syncProjectRawFolder(localEnv(), updateContext.projectId)).resolves.toMatchObject({ newlyImported: 0 });
    await expect(bindings.DB.prepare("SELECT source_path, source_path_key FROM assets WHERE id = ?").bind(updateContext.oldAssetId).first())
      .resolves.toEqual({ source_path: movedPath, source_path_key: movedPath.toLowerCase() });
  });

  it("refuses an archived project without changing the current row or leaving an orphan", async () => {
    const context = await fixture({ archived: true });
    configureDropbox([fileFor(context, "hash-b")]);
    await expect(syncProjectRawFolder(localEnv(), context.projectId)).rejects.toThrow(/archived/);
    await expect(rows(context)).resolves.toMatchObject({ results: [expect.objectContaining({ id: context.oldAssetId, superseded_at: null })] });
  });

  it("archives mid-flight, after the retry decision but before the retry batch commits, without a partial supersede", async () => {
    // The project is NOT archived when syncProjectRawFolder starts, so this exercises the retry
    // batch's own `WHERE EXISTS (project not archived)` guards on the supersede AND retry-insert
    // statements — not the top-level early-exit guard the sibling test above already covers.
    const context = await fixture();
    const database = withBatchHooks({
      1: async () => {
        await bindings.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), context.projectId).run();
      },
    });
    configureDropbox([fileFor(context, "hash-b")]);

    await expect(syncProjectRawFolder(localEnv(database), context.projectId)).resolves.toMatchObject({ newlyImported: 0 });
    // Both statements share the same guard, evaluated at the same instant within the retry
    // batch's single transaction — they must become no-ops together, not just the insert.
    await expect(rows(context)).resolves.toMatchObject({ results: [expect.objectContaining({ id: context.oldAssetId, superseded_at: null, replaced_by_asset_id: null })] });
    await expect(receivedCount(context.collectionId)).resolves.toEqual({ received_count: 1 });
  });

  it("restores the old row when supersede commits but retry insert loses to an unrelated R2 key", async () => {
    const context = await fixture();
    const collisionProjectId = crypto.randomUUID();
    const collisionCollectionId = crypto.randomUUID();
    const now = Date.now();
    const r2Key = `projects/${context.projectId}/raw/dropbox/hash-b/capture.jpg`;
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'R2 collision', 'raw_review', ?, ?)").bind(collisionProjectId, now, now),
      bindings.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'edited', 'received', 1, ?, ?)").bind(collisionCollectionId, collisionProjectId, now, now),
      bindings.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'collision.jpg', 4, 'upload', ?, ?)").bind(crypto.randomUUID(), collisionCollectionId, r2Key, now, now),
    ]);
    configureDropbox([fileFor(context, "hash-b")]);

    await expect(syncProjectRawFolder(localEnv(), context.projectId)).resolves.toMatchObject({ newlyImported: 0 });
    await expect(rows(context)).resolves.toMatchObject({ results: [expect.objectContaining({ id: context.oldAssetId, superseded_at: null, replaced_by_asset_id: null })] });
    await expect(receivedCount(context.collectionId)).resolves.toEqual({ received_count: 1 });
  });

  it("takes the compensation branch for a legitimate current occupant created before the check", async () => {
    const context = await fixture();
    const thirdId = crypto.randomUUID();
    const database = withBatchHooks({
      2: async () => {
        const now = Date.now();
        await bindings.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, created_at, updated_at) VALUES (?, ?, ?, 'third.jpg', 4, 'hash-third', 'dropbox', ?, ?, ?, ?)")
          .bind(thirdId, context.collectionId, `tests/${thirdId}.jpg`, `${context.root}/third.jpg`, context.sourcePathKey, now, now).run();
      },
    });
    const collisionProjectId = crypto.randomUUID();
    const collisionCollectionId = crypto.randomUUID();
    const now = Date.now();
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'R2 collision', 'raw_review', ?, ?)").bind(collisionProjectId, now, now),
      bindings.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'edited', 'received', 1, ?, ?)").bind(collisionCollectionId, collisionProjectId, now, now),
      bindings.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'collision.jpg', 4, 'upload', ?, ?)").bind(crypto.randomUUID(), collisionCollectionId, `projects/${context.projectId}/raw/dropbox/hash-b/capture.jpg`, now, now),
    ]);
    configureDropbox([fileFor(context, "hash-b")]);

    await expect(syncProjectRawFolder(localEnv(database), context.projectId)).resolves.toMatchObject({ newlyImported: 0 });
    // `rows()` orders `ORDER BY id`, and ids are random UUIDs — a positional array match here
    // would be order-dependent (flaky) rather than actually verifying each row's own state.
    const result = await rows(context);
    expect(result.results).toHaveLength(2);
    expect(result.results.find((row) => row.id === context.oldAssetId)).toMatchObject({ superseded_at: expect.any(Number), replaced_by_asset_id: thirdId });
    expect(result.results.find((row) => row.id === thirdId)).toMatchObject({ superseded_at: null });
    await expect(receivedCount(context.collectionId)).resolves.toEqual({ received_count: 1 });
  });

  it("deletes an identity-race orphan and repoints its predecessor to the collection winner atomically", async () => {
    // The winner asset can exist upfront (a different path, no source-path collision), but its
    // identity-key registration must NOT exist before syncProjectRawFolder is called: if it did,
    // the earlier, unrelated identity-match step (unchanged existing code, runs before any of
    // this scenario's logic) would intercept the file itself and take a different code path
    // entirely, never reaching the retry branch this test means to exercise. Inject the
    // competing identity row only after the first (expected-to-fail) batch, simulating another
    // writer's registration having landed in between — exactly the race the retry batch's own
    // `changes() = 1` guard on the identity insert exists to catch.
    const context = await fixture();
    const winnerId = crypto.randomUUID();
    const identityKey = "hash:hash-b";
    const now = Date.now();
    await bindings.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, created_at, updated_at) VALUES (?, ?, ?, 'winner.jpg', 4, 'hash-winner', 'dropbox', ?, ?, ?, ?)")
      .bind(winnerId, context.collectionId, `tests/${winnerId}.jpg`, `${context.root}/winner.jpg`, `${context.root}/winner.jpg`.toLowerCase(), now, now).run();
    // A decoy in a different collection registered under the exact same identity key — the
    // winner lookup is scoped by (collectionId, identityKey) together, and this proves it, not
    // just that a same-collection winner happens to be found.
    const decoyProjectId = crypto.randomUUID();
    const decoyCollectionId = crypto.randomUUID();
    const decoyAssetId = crypto.randomUUID();
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Decoy collection', 'raw_review', ?, ?)").bind(decoyProjectId, now, now),
      bindings.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'received', 1, ?, ?)").bind(decoyCollectionId, decoyProjectId, now, now),
      bindings.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, created_at, updated_at) VALUES (?, ?, ?, 'decoy.jpg', 4, 'hash-decoy', 'dropbox', '/decoy', '/decoy', ?, ?)")
        .bind(decoyAssetId, decoyCollectionId, `tests/${decoyAssetId}.jpg`, now, now),
      bindings.DB.prepare("INSERT INTO asset_ingest_identities (id, collection_id, identity_key, asset_id, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), decoyCollectionId, identityKey, decoyAssetId, now),
    ]);
    const database = withBatchHooks({
      1: async () => {
        await bindings.DB.prepare("INSERT INTO asset_ingest_identities (id, collection_id, identity_key, asset_id, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(crypto.randomUUID(), context.collectionId, identityKey, winnerId, Date.now()).run();
      },
    });
    configureDropbox([fileFor(context, "hash-b")]);

    await expect(syncProjectRawFolder(localEnv(database), context.projectId)).resolves.toMatchObject({ newlyImported: 0 });
    const result = await rows(context);
    // Atomicity: the orphaned candidate row must be gone entirely (not merely superseded, not
    // left as a second live row), the predecessor repoints at the correct in-collection winner
    // (never the decoy), and the collection count reflects exactly one live asset — all three
    // effects of the same follow-up batch, checked independently rather than only the row shape.
    expect(result.results).toHaveLength(2);
    expect(result.results.map((row) => row.id).sort()).toEqual([context.oldAssetId, winnerId].sort());
    await expect(bindings.DB.prepare("SELECT count(*) count FROM assets WHERE collection_id = ? AND content_hash = 'hash-b'").bind(context.collectionId).first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
    expect(result.results.find((row) => row.id === context.oldAssetId)).toMatchObject({ superseded_at: expect.any(Number), replaced_by_asset_id: winnerId });
    expect(result.results.find((row) => row.id === winnerId)).toMatchObject({ superseded_at: null });
    await expect(receivedCount(context.collectionId)).resolves.toEqual({ received_count: 1 });
    // The decoy's own collection is untouched by any of this.
    await expect(bindings.DB.prepare("SELECT superseded_at FROM assets WHERE id = ?").bind(decoyAssetId).first())
      .resolves.toEqual({ superseded_at: null });
  });

  it("does not overwrite a predecessor pointer with NULL when the identity winner disappears", async () => {
    // Same upfront/mid-flight split as above for the winner asset vs. its identity registration,
    // plus a second injection: the identity row is deleted again after the retry batch (batch 2)
    // has already lost to it, so that by the time the cleanup batch's winner lookup runs, there
    // is genuinely no winner to find — exercising the NULL-guard rather than a normal repoint.
    const context = await fixture();
    const winnerId = crypto.randomUUID();
    const identityId = crypto.randomUUID();
    const now = Date.now();
    await bindings.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, created_at, updated_at) VALUES (?, ?, ?, 'winner.jpg', 4, 'hash-winner', 'dropbox', ?, ?, ?, ?)")
      .bind(winnerId, context.collectionId, `tests/${winnerId}.jpg`, `${context.root}/winner.jpg`, `${context.root}/winner.jpg`.toLowerCase(), now, now).run();
    const database = withBatchHooks({
      1: async () => {
        await bindings.DB.prepare("INSERT INTO asset_ingest_identities (id, collection_id, identity_key, asset_id, created_at) VALUES (?, ?, 'hash:hash-b', ?, ?)")
          .bind(identityId, context.collectionId, winnerId, Date.now()).run();
      },
      2: async () => {
        await bindings.DB.prepare("DELETE FROM asset_ingest_identities WHERE id = ?").bind(identityId).run();
      },
    });
    configureDropbox([fileFor(context, "hash-b")]);

    await expect(syncProjectRawFolder(localEnv(database), context.projectId)).resolves.toMatchObject({ newlyImported: 0 });
    const result = await rows(context);
    const old = result.results.find((row) => row.id === context.oldAssetId)!;
    expect(old.replaced_by_asset_id).not.toBeNull();
    expect(result.results.find((row) => row.id !== context.oldAssetId && row.id !== winnerId)).toBeUndefined();
    await expect(receivedCount(context.collectionId)).resolves.toEqual({ received_count: 1 });
  });

  it("is idempotent across repeats, supports multiple replacements, and handles hashless files", async () => {
    const context = await fixture({ seedOld: false });
    const first = fileFor(context, "hash-one");
    configureDropbox([first]);
    await expect(syncProjectRawFolder(localEnv(), context.projectId)).resolves.toMatchObject({ newlyImported: 1 });
    configureDropbox([first]);
    await expect(syncProjectRawFolder(localEnv(), context.projectId)).resolves.toMatchObject({ newlyImported: 0 });
    const second = fileFor(context, "hash-two");
    configureDropbox([second]);
    await expect(syncProjectRawFolder(localEnv(), context.projectId)).resolves.toMatchObject({ newlyImported: 1 });
    const hashless = fileFor(context, undefined);
    configureDropbox([hashless]);
    await expect(syncProjectRawFolder(localEnv(), context.projectId)).resolves.toMatchObject({ newlyImported: 0 });
    const all = await rows(context);
    expect(all.results).toHaveLength(2);
    expect(all.results.filter((row) => row.superseded_at === null)).toHaveLength(1);
    await expect(receivedCount(context.collectionId)).resolves.toEqual({ received_count: 1 });
  });

  it("serializes two sync claim attempts with a deterministic barrier", async () => {
    const context = await fixture({ seedOld: false });
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(listFolder).mockImplementationOnce(async () => {
      entered();
      await releasePromise;
      return { entries: [], cursor: "cursor", has_more: false };
    });
    const first = syncProjectRawFolder(localEnv(), context.projectId);
    await enteredPromise;
    const second = await syncProjectRawFolder(localEnv(), context.projectId);
    expect(second).toMatchObject({ newlyImported: 0, claimed: false });
    release();
    await expect(first).resolves.toMatchObject({ newlyImported: 0, claimed: true });
  });

  it("reaps an admin-delete claim whose lease expired without renewal", async () => {
    // Baseline/boundary case: an un-renewed claim past its lease is not a permanent lock —
    // sync.ts's own stale-claim expiry (mirrors the mechanism an admin-delete-held claim would
    // rely on to eventually release if that route ever crashed without releasing it itself).
    const context = await fixture({ seedOld: false });
    const now = Date.now();
    const ownerJobId = crypto.randomUUID();
    const claimId = crypto.randomUUID();
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'admin_asset_delete', 'running', ?, ?, ?)").bind(ownerJobId, context.projectId, now, now),
      bindings.DB.prepare("INSERT INTO raw_reconciliation_claims (id, project_id, owner_job_id, state, lease_expires_at, trigger, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, 'asset_delete', ?, ?)").bind(claimId, context.projectId, ownerJobId, now - 5_000, now, now),
    ]);
    await expect(syncProjectRawFolder(localEnv(), context.projectId)).resolves.toMatchObject({ claimed: true });
    const reaped = await bindings.DB.prepare("SELECT state FROM raw_reconciliation_claims WHERE id = ?").bind(claimId).first<{ state: string }>();
    expect(reaped?.state).toBe("failed");
  });

  it("stays locked out by a claim kept alive through renewal, past what its original short lease alone would have covered", async () => {
    // The core claim under test: renewal — not merely an unexpired static lease — is what keeps
    // sync excluded. `renewRawReconciliationClaim`'s own guard (`lease_expires_at >= now`) can
    // only extend an ALREADY-valid lease, so this seeds one with a genuinely short real-world
    // window, renews it while still valid (extending it by the full `RAW_CLAIM_LEASE_MS`), then
    // really waits past the ORIGINAL window before attempting sync. Without the renewal this is
    // exactly the reaping scenario above and sync would proceed once that short window elapsed;
    // with it, sync must still lose, proving the renewal — not the original lease — is protecting
    // the claim at the moment sync actually checks.
    const context = await fixture({ seedOld: false });
    const now = Date.now();
    const ownerJobId = crypto.randomUUID();
    const claimId = crypto.randomUUID();
    const shortLeaseMs = 40;
    await bindings.DB.batch([
      bindings.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'admin_asset_delete', 'running', ?, ?, ?)").bind(ownerJobId, context.projectId, now, now),
      bindings.DB.prepare("INSERT INTO raw_reconciliation_claims (id, project_id, owner_job_id, state, lease_expires_at, trigger, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, 'asset_delete', ?, ?)").bind(claimId, context.projectId, ownerJobId, now + shortLeaseMs, now, now),
    ]);
    await expect(renewRawReconciliationClaim(bindings.DB, claimId, ownerJobId)).resolves.toBe(true);
    const renewedClaim = await bindings.DB.prepare("SELECT lease_expires_at FROM raw_reconciliation_claims WHERE id = ?").bind(claimId).first<{ lease_expires_at: number }>();
    expect(renewedClaim!.lease_expires_at).toBeGreaterThan(now + shortLeaseMs); // extended well past the original short window

    await new Promise((resolve) => setTimeout(resolve, shortLeaseMs * 2)); // real time passes the ORIGINAL window; the renewed one still has ~RAW_CLAIM_LEASE_MS left

    await expect(syncProjectRawFolder(localEnv(), context.projectId)).resolves.toMatchObject({ newlyImported: 0, claimed: false });
    const claim = await bindings.DB.prepare("SELECT state, owner_job_id FROM raw_reconciliation_claims WHERE id = ?").bind(claimId).first<{ state: string; owner_job_id: string }>();
    expect(claim?.state).toBe("running");
    expect(claim?.owner_job_id).toBe(ownerJobId); // still the admin-delete claim, not reaped and reacquired by sync
  });

  // True two-way concurrency against a real admin-delete claim acquisition/release is verified
  // in Admin-Asset-Deletion-Plan.md's own build (its testing requirement 6 specifically), against
  // the real route rather than a stand-in here — that plan's route uses this exact same
  // raw_reconciliation_claims table and insert-then-catch-unique-violation pattern this file's
  // own claim acquisition already uses (see "serializes two sync claim attempts" above for the
  // sync-vs-sync case, and both tests above for sync correctly respecting a claim it doesn't own),
  // so the two sides are proven compatible without duplicating a synthetic version of not-yet-
  // built code here.
});
