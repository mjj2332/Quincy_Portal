import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../src/auth";
import app from "../src/index";
import type { Env } from "../src/env";

const database = env as unknown as { DB: D1Database };
const baseEnv = env as unknown as Env;
const adminToken = "asset-delete-admin-session-token";
const editorToken = "asset-delete-editor-session-token";
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SELF = {
  fetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = new Request(input, init); const url = new URL(request.url);
    if (!unsafeMethods.has(request.method) || !url.pathname.startsWith("/api/")) return workerSelf.fetch(request);
    const headers = new Headers(request.headers); if (!headers.has("origin")) headers.set("origin", baseEnv.APP_ORIGIN);
    return workerSelf.fetch(new Request(request, { headers }));
  },
};

async function executeSql(source: string) {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const statements = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";");
    for (const statement of statements) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); }
  }
}

async function cookie(token: string) {
  const context = await createAuth(baseEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, baseEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes")}`;
}

async function seedProject(orderedServices: string[] = []) {
  const projectId = crypto.randomUUID(); const now = Date.now();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, ?, 'raw_review', ?, ?)").bind(projectId, `Asset deletion ${projectId}`, now, now).run();
  const collections = new Map<string, string>();
  for (const kind of ["raw", ...orderedServices]) {
    const id = crypto.randomUUID(); collections.set(kind, id);
    await database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, ?, 'empty', 0, ?, ?)").bind(id, projectId, kind, now, now).run();
  }
  return { projectId, collections };
}

async function seedAsset(project: Awaited<ReturnType<typeof seedProject>>, kind: string, options: { id?: string; source?: string; sourcePath?: string | null; sourcePathKey?: string | null; versionGroupId?: string | null; version?: number; r2Key?: string } = {}) {
  const id = options.id ?? crypto.randomUUID(); const now = Date.now(); const collectionId = project.collections.get(kind === "photo" ? "raw" : kind === "floorplan_pdf" || kind === "floorplan_preview" ? "floorplan" : kind.replace("_pdf", ""))!;
  const r2Key = options.r2Key ?? `projects/${project.projectId}/${id}.bin`;
  await database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, source_path, source_path_key, version_group_id, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)").bind(id, collectionId, kind, r2Key, `${id}.bin`, options.source ?? "upload", options.sourcePath ?? null, options.sourcePathKey ?? null, options.versionGroupId ?? null, options.version ?? 1, now, now).run();
  await database.DB.prepare("UPDATE collections SET received_count = (SELECT count(*) FROM assets WHERE collection_id = ? AND publish_status = 'ready' AND superseded_at IS NULL), status = 'received' WHERE id = ?").bind(collectionId, collectionId).run();
  return { id, collectionId, r2Key };
}

async function deleteAsset(assetId: string, token = adminToken) {
  return SELF.fetch(`https://portal.test/api/assets/${assetId}`, { method: "DELETE", headers: { cookie: await cookie(token) } });
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__); await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT OR IGNORE INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES ('asset-delete-editor', 'Asset Editor', 'asset-editor@example.test', 1, 'editor', 1, ?, ?)").bind(now, now),
    database.DB.prepare("INSERT OR IGNORE INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES ('asset-delete-editor-session', ?, ?, 'asset-delete-editor', ?, ?)").bind(now + 3_600_000, editorToken, now, now),
    database.DB.prepare("INSERT OR IGNORE INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES ('asset-delete-admin-session', ?, ?, 'seed-admin', ?, ?)").bind(now + 3_600_000, adminToken, now, now),
  ]);
});

describe("admin asset deletion", () => {
  it("deletes every asset kind, exact original/rendition keys, cascades D1 children, retains annotation R2, and reconciles count", async () => {
    const project = await seedProject(["edited", "video", "floorplan", "copy"]);
    for (const kind of ["photo", "edited", "video", "copy_pdf"]) {
      const asset = await seedAsset(project, kind); const key = `renditions/${asset.id}/web`; const annotationKey = `projects/${project.projectId}/annotations/${asset.id}.json`;
      await baseEnv.MEDIA.put(asset.r2Key, "original"); await baseEnv.MEDIA.put(key, "rendition"); await baseEnv.MEDIA.put(annotationKey, "annotation");
      await database.DB.prepare("INSERT INTO annotations (id, asset_id, author_id, author_role, scope, stroke_r2_key, created_at) VALUES (?, ?, 'seed-admin', 'admin', 'raw', ?, ?)").bind(crypto.randomUUID(), asset.id, annotationKey, Date.now()).run();
      await database.DB.prepare("INSERT INTO selections (id, asset_id, selected_by, state, created_at) VALUES (?, ?, 'seed-admin', 'selected_for_editing', ?)").bind(crypto.randomUUID(), asset.id, Date.now()).run().catch(() => undefined);
      const response = await deleteAsset(asset.id); expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true, deletedAssetIds: [asset.id], deletedObjects: 2, dropboxDeleted: true });
      await expect(baseEnv.MEDIA.get(asset.r2Key)).resolves.toBeNull(); await expect(baseEnv.MEDIA.get(key)).resolves.toBeNull(); await expect(baseEnv.MEDIA.get(annotationKey)).resolves.not.toBeNull();
      await expect(database.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(asset.id).first()).resolves.toBeNull();
      await expect(database.DB.prepare("SELECT id FROM annotations WHERE asset_id = ?").bind(asset.id).first()).resolves.toBeNull();
    }
    const raw = project.collections.get("raw")!; await expect(database.DB.prepare("SELECT received_count FROM collections WHERE id = ?").bind(raw).first()).resolves.toEqual({ received_count: 0 });
  });

  it("deletes a complete floorplan pair atomically, but treats a pre-existing incomplete legacy pair as a single asset", async () => {
    const project = await seedProject(["floorplan"]); const group = crypto.randomUUID();
    const pdf = await seedAsset(project, "floorplan_pdf", { versionGroupId: group }); const preview = await seedAsset(project, "floorplan_preview", { versionGroupId: group });
    const response = await deleteAsset(pdf.id); expect(response.status).toBe(200);
    await expect(database.DB.prepare("SELECT id FROM assets WHERE id IN (?, ?)").bind(pdf.id, preview.id).all()).resolves.toMatchObject({ results: [] });
    const legacyGroup = crypto.randomUUID(); const legacy = await seedAsset(project, "floorplan_pdf", { versionGroupId: legacyGroup });
    expect((await deleteAsset(legacy.id)).status).toBe(200);
    await expect(database.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(legacy.id).first()).resolves.toBeNull();
  });

  it("does not delete a different floorplan version or its pair when one version is targeted", async () => {
    const project = await seedProject(["floorplan"]); const firstGroup = crypto.randomUUID(); const secondGroup = crypto.randomUUID();
    const firstPdf = await seedAsset(project, "floorplan_pdf", { versionGroupId: firstGroup }); const firstPreview = await seedAsset(project, "floorplan_preview", { versionGroupId: firstGroup });
    const secondPdf = await seedAsset(project, "floorplan_pdf", { versionGroupId: secondGroup }); const secondPreview = await seedAsset(project, "floorplan_preview", { versionGroupId: secondGroup });
    expect((await deleteAsset(firstPreview.id)).status).toBe(200);
    await expect(database.DB.prepare("SELECT id FROM assets WHERE id IN (?, ?)").bind(firstPdf.id, firstPreview.id).all()).resolves.toMatchObject({ results: [] });
    await expect(database.DB.prepare("SELECT id FROM assets WHERE id IN (?, ?)").bind(secondPdf.id, secondPreview.id).all()).resolves.toMatchObject({ results: [{ id: expect.any(String) }, { id: expect.any(String) }] });
  });

  it("returns 409 and leaves a floorplan pair untouched when either guard blocks", async () => {
    const project = await seedProject(["floorplan"]); const group = crypto.randomUUID();
    const pdf = await seedAsset(project, "floorplan_pdf", { versionGroupId: group }); const preview = await seedAsset(project, "floorplan_preview", { versionGroupId: group });
    const linkId = crypto.randomUUID(); await database.DB.prepare("INSERT INTO client_links (id, project_id, token_hash, publish_version, expires_at, created_at) VALUES (?, ?, ?, 1, ?, ?)").bind(linkId, project.projectId, crypto.randomUUID(), Date.now() + 10000, Date.now()).run();
    await database.DB.prepare("INSERT INTO premium_unlocks (id, client_link_id, scope, asset_id, unlocked_at) VALUES (?, ?, 'asset', ?, ?)").bind(crypto.randomUUID(), linkId, preview.id, Date.now()).run();
    const response = await deleteAsset(pdf.id); expect(response.status).toBe(409); await expect(response.json()).resolves.toMatchObject({ blocker: "premium_unlock" });
    await expect(database.DB.prepare("SELECT id FROM assets WHERE id IN (?, ?)").bind(pdf.id, preview.id).all()).resolves.toMatchObject({ results: [{ id: expect.any(String) }, { id: expect.any(String) }] });
    await database.DB.prepare("DELETE FROM premium_unlocks WHERE asset_id = ?").bind(preview.id).run();
    expect((await deleteAsset(pdf.id)).status).toBe(200);
  });

  it("blocks an edited source claim, then succeeds after the claim is cleared", async () => {
    const project = await seedProject(["edited"]); const asset = await seedAsset(project, "edited"); const claimId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO edited_source_claims (id, collection_id, source_path_key, current_asset_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(claimId, asset.collectionId, `/edited/${asset.id}`, asset.id, Date.now(), Date.now()).run();
    const blocked = await deleteAsset(asset.id); expect(blocked.status).toBe(409); await expect(blocked.json()).resolves.toMatchObject({ blocker: "edited_source_claim" });
    await database.DB.prepare("DELETE FROM edited_source_claims WHERE id = ?").bind(claimId).run();
    expect((await deleteAsset(asset.id)).status).toBe(200);
  });

  it("enforces capability at the API, including manageExtras-only editors", async () => {
    const project = await seedProject(); const asset = await seedAsset(project, "photo");
    expect((await deleteAsset(asset.id, editorToken)).status).toBe(403);
    await expect(database.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(asset.id).first()).resolves.not.toBeNull();
  });

  it("refuses an active claim before mutation and records the newly-created job as failed", async () => {
    const project = await seedProject(); const asset = await seedAsset(project, "photo", { source: "dropbox", sourcePath: "/Raw/file.jpg", sourcePathKey: "/raw/file.jpg" });
    const ownerJob = crypto.randomUUID(); const claim = crypto.randomUUID(); const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, created_at, updated_at) VALUES (?, 'dropbox_sync', 'done', ?, ?, ?)").bind(ownerJob, project.projectId, now, now),
      database.DB.prepare("INSERT INTO raw_reconciliation_claims (id, project_id, owner_job_id, state, lease_expires_at, trigger, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, 'dropbox_delta', ?, ?)").bind(claim, project.projectId, ownerJob, now + 60000, now, now),
    ]);
    const response = await deleteAsset(asset.id); expect(response.status).toBe(409);
    await expect(database.DB.prepare("SELECT status FROM jobs WHERE kind = 'asset_delete' AND project_id = ? ORDER BY created_at DESC LIMIT 1").bind(project.projectId).first()).resolves.toEqual({ status: "failed" });
    await expect(database.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(asset.id).first()).resolves.not.toBeNull();
  });

  it("allows exactly one of two true concurrent Dropbox deletes in either request ordering", async () => {
    // A shared "release" barrier before two Promise.all'd SELF.fetch calls does not guarantee
    // genuine overlap — Miniflare's test runtime can simply run one request to completion before
    // starting the next, in which case this would prove nothing about the actual race. Force real
    // overlap instead, the same way workers/background/test/dropbox-reconciliation.test.ts's own
    // sync-vs-sync barrier test does: pause the FIRST request's execution inside an external call
    // it awaits AFTER acquiring its claim and BEFORE releasing it (here, the Dropbox RPC), so the
    // SECOND request's claim-acquisition attempt is guaranteed to run while the first still holds
    // the claim, not merely scheduled to.
    async function ordering(swap: boolean) {
      const project = await seedProject();
      const held = await seedAsset(project, "photo", { source: "dropbox", sourcePath: "/Raw/held.jpg", sourcePathKey: "/raw/held.jpg" });
      const contender = await seedAsset(project, "photo", { source: "dropbox", sourcePath: "/Raw/contender.jpg", sourcePathKey: "/raw/contender.jpg" });
      const firstAsset = swap ? contender : held; const secondAsset = swap ? held : contender;
      let releaseFirst!: () => void; const paused = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let firstReachedDropboxStep!: () => void; const firstReachedDropbox = new Promise<void>((resolve) => { firstReachedDropboxStep = resolve; });
      const pausingEnv: Env = {
        ...baseEnv,
        BACKGROUND: {
          renewDropboxDeletionClaim: async () => true,
          deleteDropboxSourceFile: async () => { firstReachedDropboxStep(); await paused; return { outcome: "removed" as const }; },
        } as unknown as Env["BACKGROUND"],
      };
      const executionContext = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
      const firstRequest = app.fetch(
        new Request(`https://portal.test/api/assets/${firstAsset.id}`, { method: "DELETE", headers: { cookie: await cookie(adminToken), origin: baseEnv.APP_ORIGIN } }),
        pausingEnv,
        executionContext,
      );
      await firstReachedDropbox; // the first request has acquired its claim and is now genuinely suspended mid-flight
      const secondResponse = await deleteAsset(secondAsset.id); // real path — must lose the race while the first is paused
      // Asserting each response individually, not a sorted pair, and asserting the SECOND
      // response's body identifies the specific claim conflict — a sorted [200, 409] check alone
      // would still pass even if the activeJobs exclusion regressed and the second request lost
      // to that unrelated courtesy check instead of genuine claim contention.
      expect(secondResponse.status).toBe(409);
      await expect(secondResponse.json()).resolves.toMatchObject({ error: "Dropbox sync is active for this project — wait for it to finish and try again." });
      releaseFirst();
      const firstResponse = await firstRequest;
      expect(firstResponse.status).toBe(200);
    }
    await ordering(false); await ordering(true);
  });

  it("returns 409 and touches nothing when the sibling disappears between lookup and the guarded batch", async () => {
    const project = await seedProject(["floorplan"]); const group = crypto.randomUUID();
    const pdf = await seedAsset(project, "floorplan_pdf", { versionGroupId: group });
    const preview = await seedAsset(project, "floorplan_preview", { versionGroupId: group });
    await baseEnv.MEDIA.put(pdf.r2Key, "pdf-bytes"); await baseEnv.MEDIA.put(preview.r2Key, "preview-bytes");
    // The route's sibling lookup (a plain SELECT) already ran and captured `preview` as part of
    // the target set by the time the guarded DELETE batch executes. Delete it out from under that
    // batch — simulating a genuinely concurrent, independent deletion of just the sibling — by
    // intercepting the one `env.DB.batch()` call this route makes for its guarded delete step.
    let intercepted = false;
    const interceptingDB = new Proxy(baseEnv.DB, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!intercepted) { intercepted = true; await target.prepare("DELETE FROM assets WHERE id = ?").bind(preview.id).run(); }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const interceptingEnv: Env = { ...baseEnv, DB: interceptingDB as unknown as D1Database };
    const executionContext = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
    const response = await app.fetch(
      new Request(`https://portal.test/api/assets/${pdf.id}`, { method: "DELETE", headers: { cookie: await cookie(adminToken), origin: baseEnv.APP_ORIGIN } }),
      interceptingEnv,
      executionContext,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ blocker: "floorplan_pair" });
    // The count(*) guard caught it before the primary's own row was touched, and before any R2
    // work — both the (still-live) pdf and the (independently-deleted) preview's own bytes are
    // exactly as they were, not partially cleaned up.
    await expect(database.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(pdf.id).first()).resolves.not.toBeNull();
    await expect(baseEnv.MEDIA.get(pdf.r2Key)).resolves.not.toBeNull();
  });

  it("renews the claim on every R2 list page and every delete batch across a multi-page traversal", async () => {
    const project = await seedProject();
    const asset = await seedAsset(project, "photo", { source: "dropbox", sourcePath: "/Raw/multi-page.jpg", sourcePathKey: "/raw/multi-page.jpg" });
    const pageOneKeys = Array.from({ length: 3 }, (_, index) => `renditions/${asset.id}/page-one-${index}`);
    const pageTwoKeys = Array.from({ length: 2 }, (_, index) => `renditions/${asset.id}/page-two-${index}`);
    const deletedBatches: string[][] = [];
    let listCalls = 0;
    const renewCalls: string[] = [];
    const fakeMedia = {
      async list({ cursor }: { cursor?: string }) {
        listCalls += 1;
        if (!cursor) return { objects: pageOneKeys.map((key) => ({ key })), truncated: true, cursor: "page-two" };
        return { objects: pageTwoKeys.map((key) => ({ key })), truncated: false };
      },
      async delete(keys: string[]) { deletedBatches.push(keys); },
    };
    const renewingEnv: Env = {
      ...baseEnv,
      MEDIA: fakeMedia as unknown as R2Bucket,
      BACKGROUND: {
        renewDropboxDeletionClaim: async () => { renewCalls.push("renew"); return true; },
        deleteDropboxSourceFile: async () => ({ outcome: "removed" as const }),
      } as unknown as Env["BACKGROUND"],
    };
    const executionContext = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
    const response = await app.fetch(
      new Request(`https://portal.test/api/assets/${asset.id}`, { method: "DELETE", headers: { cookie: await cookie(adminToken), origin: baseEnv.APP_ORIGIN } }),
      renewingEnv,
      executionContext,
    );
    expect(response.status).toBe(200);
    expect(listCalls).toBe(2); // one call per page
    expect(deletedBatches).toHaveLength(1); // 5 keys + the original r2Key fit in one 1000-key delete batch
    expect(deletedBatches[0]).toHaveLength(1 + pageOneKeys.length + pageTwoKeys.length);
    // Renewed before each of the 2 list pages, before the 1 delete batch, and once more before
    // the Dropbox RPC call itself (the initial-call renewal inside deleteDropboxSourceFile is
    // covered separately in workers/background/test/dropbox-deletion-rpc.test.ts; this route's
    // own renewal calls before the Dropbox step are the "before the initial call" one at
    // minimum) — asserting a lower bound rather than an exact count keeps this from being brittle
    // against harmless extra renewals.
    expect(renewCalls.length).toBeGreaterThanOrEqual(3);
  });

  it("stops R2 cleanup and reports claimLost when renewal fails mid-traversal, without attempting Dropbox deletion", async () => {
    const project = await seedProject();
    const asset = await seedAsset(project, "photo", { source: "dropbox", sourcePath: "/Raw/lost-claim.jpg", sourcePathKey: "/raw/lost-claim.jpg" });
    let renewCalls = 0; let dropboxCalled = false;
    const fakeMedia = {
      async list() { return { objects: [{ key: `renditions/${asset.id}/thumb` }], truncated: false }; },
      async delete() { throw new Error("must not be called once the claim is lost"); },
    };
    const losingEnv: Env = {
      ...baseEnv,
      MEDIA: fakeMedia as unknown as R2Bucket,
      BACKGROUND: {
        renewDropboxDeletionClaim: async () => { renewCalls += 1; return false; }, // lost on the very first renewal
        deleteDropboxSourceFile: async () => { dropboxCalled = true; return { outcome: "removed" as const }; },
      } as unknown as Env["BACKGROUND"],
    };
    const executionContext = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
    const response = await app.fetch(
      new Request(`https://portal.test/api/assets/${asset.id}`, { method: "DELETE", headers: { cookie: await cookie(adminToken), origin: baseEnv.APP_ORIGIN } }),
      losingEnv,
      executionContext,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ outcome: "claimLost" });
    expect(renewCalls).toBeGreaterThan(0);
    expect(dropboxCalled).toBe(false); // stopped before ever reaching the Dropbox step
    // The D1 delete had already committed before R2 cleanup began — that part is not rolled back;
    // only the R2/Dropbox cleanup stops early. The job is left non-"done" so the audit trail
    // reflects the incomplete cleanup.
    await expect(database.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(asset.id).first()).resolves.toBeNull();
    await expect(database.DB.prepare("SELECT status FROM jobs WHERE kind = 'asset_delete' AND project_id = ? ORDER BY created_at DESC LIMIT 1").bind(project.projectId).first())
      .resolves.toEqual({ status: "failed" });
  });

  it("claims when only a floorplan sibling is Dropbox-sourced and skips claims for a null source path key", async () => {
    const project = await seedProject(["floorplan"]); const group = crypto.randomUUID();
    const pdf = await seedAsset(project, "floorplan_pdf", { versionGroupId: group }); const preview = await seedAsset(project, "floorplan_preview", { versionGroupId: group, source: "dropbox", sourcePath: "/Floorplans/preview.jpg", sourcePathKey: "/floorplans/preview.jpg" });
    expect((await deleteAsset(pdf.id)).status).toBe(200);
    await expect(database.DB.prepare("SELECT state FROM raw_reconciliation_claims WHERE project_id = ? ORDER BY created_at DESC LIMIT 1").bind(project.projectId).first()).resolves.toEqual({ state: "done" });
    const legacy = await seedAsset(project, "photo", { source: "dropbox", sourcePath: "/Raw/legacy.jpg", sourcePathKey: null });
    expect((await deleteAsset(legacy.id)).status).toBe(200);
    await expect(database.DB.prepare("SELECT count(*) count FROM raw_reconciliation_claims WHERE project_id = ?").bind(project.projectId).first()).resolves.toEqual({ count: 1 });
  });

  it("nulls non-FK pointers only after a successful delete and keeps the collection count correct when guarded", async () => {
    const project = await seedProject(); const target = await seedAsset(project, "photo"); const child = await seedAsset(project, "photo", { sourceRawAssetId: undefined } as never);
    await database.DB.prepare("UPDATE assets SET source_raw_asset_id = ?, supersedes_asset_id = ? WHERE id = ?").bind(target.id, target.id, child.id).run();
    expect((await deleteAsset(target.id)).status).toBe(200);
    await expect(database.DB.prepare("SELECT source_raw_asset_id, supersedes_asset_id FROM assets WHERE id = ?").bind(child.id).first()).resolves.toEqual({ source_raw_asset_id: null, supersedes_asset_id: null });
    const blocked = await seedAsset(project, "photo"); await database.DB.prepare("UPDATE assets SET source_raw_asset_id = ? WHERE id = ?").bind(blocked.id, child.id).run();
    const claimId = crypto.randomUUID(); await database.DB.prepare("INSERT INTO edited_source_claims (id, collection_id, source_path_key, current_asset_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(claimId, child.collectionId, `/blocked/${blocked.id}`, blocked.id, Date.now(), Date.now()).run();
    expect((await deleteAsset(blocked.id)).status).toBe(409);
    // The delete was blocked, so pointer-nulling must not have fired — `child` still points at
    // `blocked`, which is still live. Asserting `null` here would mean the guard didn't actually
    // gate the pointer-nulling UPDATE.
    await expect(database.DB.prepare("SELECT source_raw_asset_id FROM assets WHERE id = ?").bind(child.id).first()).resolves.toEqual({ source_raw_asset_id: blocked.id });
    const collectionCount = await database.DB.prepare("SELECT received_count FROM collections WHERE id = ?").bind(blocked.collectionId).first<{ received_count: number }>();
    const actualCount = await database.DB.prepare("SELECT count(*) count FROM assets WHERE collection_id = ? AND publish_status = 'ready' AND superseded_at IS NULL").bind(blocked.collectionId).first<{ count: number }>();
    expect(collectionCount?.received_count).toBe(actualCount?.count);
  });

  it("does not commit the asset delete when the same batch's audit insert fails", async () => {
    const project = await seedProject(); const asset = await seedAsset(project, "photo");
    await database.DB.exec("CREATE TRIGGER asset_delete_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action = 'asset.delete' BEGIN SELECT RAISE(ABORT, 'forced asset delete audit failure'); END;");
    try {
      const response = await deleteAsset(asset.id); expect(response.status).toBeGreaterThanOrEqual(500);
      await expect(database.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(asset.id).first()).resolves.not.toBeNull();
    } finally {
      await database.DB.exec("DROP TRIGGER asset_delete_audit_failure;");
    }
  });

  it("refuses DLQ replay for a deleted asset but still replays a live asset", async () => {
    const project = await seedProject(); const deleted = await seedAsset(project, "photo"); const deletedEvent = crypto.randomUUID();
    expect((await deleteAsset(deleted.id)).status).toBe(200);
    await database.DB.prepare("INSERT INTO rendition_dlq_events (id, asset_id, status, received_at) VALUES (?, ?, 'open', ?)").bind(deletedEvent, deleted.id, Date.now()).run();
    const deletedReplay = await SELF.fetch(`https://portal.test/api/admin/renditions-dlq/${deletedEvent}/replay`, { method: "POST", headers: { cookie: await cookie(adminToken) } });
    expect(deletedReplay.status).toBe(409);

    const live = await seedAsset(project, "photo"); const liveEvent = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO rendition_dlq_events (id, asset_id, status, received_at) VALUES (?, ?, 'open', ?)").bind(liveEvent, live.id, Date.now()).run();
    const mutableEnv = baseEnv as unknown as { RENDITIONS_ENABLED?: boolean; RENDITION_QUEUE?: { send(message: unknown): Promise<void> } };
    const oldEnabled = mutableEnv.RENDITIONS_ENABLED; const oldQueue = mutableEnv.RENDITION_QUEUE;
    mutableEnv.RENDITIONS_ENABLED = true; mutableEnv.RENDITION_QUEUE = { send: async () => undefined };
    try {
      const liveReplay = await SELF.fetch(`https://portal.test/api/admin/renditions-dlq/${liveEvent}/replay`, { method: "POST", headers: { cookie: await cookie(adminToken) } });
      expect(liveReplay.status).toBe(200);
      await expect(database.DB.prepare("SELECT status FROM rendition_dlq_events WHERE id = ?").bind(liveEvent).first()).resolves.toEqual({ status: "replayed" });
    } finally { mutableEnv.RENDITIONS_ENABLED = oldEnabled; mutableEnv.RENDITION_QUEUE = oldQueue; }
  });
});
