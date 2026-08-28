import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { createZipStream } from "../src/lib/zip-stream";
import { signTransformSource } from "../src/lib/transform-source";
import { liveTransformLocation } from "../src/routes/media";
import { PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID, RENDITION_SPEC_VERSION } from "@quincy/shared";
import { createDb } from "@quincy/db";
import { collectionLinkUrlConflict, uniqueVersionError } from "../src/routes/collections";
import { finalizeIngest } from "../src/lib/ingest";

const database = env as unknown as { DB: D1Database };
const authEnv = env as unknown as Env;
const authSecret = authEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const photographerToken = "test-photographer-session-token";
const adminToken = "test-admin-session-token";
const secondPhotographerToken = "test-second-photographer-session-token";
const editorToken = "test-editor-session-token";
const externalEditorToken = "test-external-editor-session-token";
const otherAdminToken = "test-other-admin-session-token";
const seedAdminId = "6b851dc8-14cf-4f90-bd29-ce6c27f86385";
// First photographer IS a member of the editable-comment project; the plain
// photographerToken user is deliberately NOT (D-02 assigned-only scoping).
const firstPhotographerToken = "test-first-photographer-session-token";
const firstPhotographerId = "11111111-1111-4111-8111-111111111111";
const secondPhotographerId = "22222222-2222-4222-8222-222222222222";
const editorId = "33333333-3333-4333-8333-333333333333";
const externalEditorId = "44444444-4444-4444-8444-444444444444";
declare const __PORTAL_MIGRATION_SQL__: string;
declare const __PORTAL_SEED_SQL__: string;

// Browser fetch supplies Origin for unsafe same-origin requests. Keep the existing
// integration corpus realistic rather than weakening the production middleware.
const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SELF = {
  fetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (!unsafeMethods.has(request.method) || !url.pathname.startsWith("/api/") || url.pathname.startsWith("/api/auth/")) return workerSelf.fetch(request);
    const headers = new Headers(request.headers);
    if (!headers.has("origin")) headers.set("origin", authEnv.APP_ORIGIN);
    return workerSelf.fetch(new Request(request, { headers }));
  },
};

async function executeSql(sql: string): Promise<void> {
  // D1's exec() processes line-by-line. Strip comment lines FIRST (comments may
  // contain `;`), then split on drizzle breakpoints and `;`, then flatten each
  // statement to a single line. (No string literals with `;` exist in our SQL.)
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const withoutComments = chunk
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    for (const statement of withoutComments.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

async function sessionCookie(token: string): Promise<string> {
  const context = await createAuth(authEnv).$context;
  return `${context.authCookies.sessionToken.name}=${token}.${await makeSignature(token, authSecret)}`;
}

async function createUploadProject(cookie: string, street: string): Promise<{ id: string }> {
  const response = await SELF.fetch("https://portal.test/api/projects", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ street, orderedServices: [] }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string }>;
}

async function seedSyncDropboxProject(id: string, rawFolderPath: string | null, photographerId?: string) {
  const now = Date.now();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, raw_folder_path, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?, ?)")
      .bind(id, `Unified Dropbox ${id.slice(-4)}`, rawFolderPath, now, now),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?)")
      .bind(crypto.randomUUID(), id, now, now),
    ...(photographerId ? [database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)")
      .bind(crypto.randomUUID(), id, photographerId, now)] : []),
  ]);
}

async function syncDropbox(cookie: string, projectId: string): Promise<{ response: Response; body: unknown }> {
  const response = await SELF.fetch(`https://portal.test/api/projects/${projectId}/sync-dropbox`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
  });
  return { response, body: await response.json() };
}

async function createRawManifest(cookie: string, projectId: string, filenames: string[]): Promise<string> {
  const response = await SELF.fetch(`https://portal.test/api/projects/${projectId}/upload-manifest`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ filenames }),
  });
  expect(response.status).toBe(200);
  return (await response.json() as { manifestId: string }).manifestId;
}

async function completeRawUpload(cookie: string, projectId: string, filename: string, manifestId?: string): Promise<Response> {
  const assetId = crypto.randomUUID();
  const key = `projects/${projectId}/raw/${assetId}/${filename}`;
  await authEnv.MEDIA.put(key, `raw-${filename}`, { httpMetadata: { contentType: "image/jpeg" } });
  return SELF.fetch("https://portal.test/api/uploads/complete", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ projectId, key, originalFilename: filename, collection: "raw", manifestId }),
  });
}

async function ingestStatus(cookie: string, projectId: string): Promise<{ expectedCount: number | null; receivedCount: number; mismatch: boolean }> {
  const response = await SELF.fetch(`https://portal.test/api/projects/${projectId}/ingest-status`, { headers: { cookie } });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ expectedCount: number | null; receivedCount: number; mismatch: boolean }>;
}

async function seedAutoHdrGraph(projectId: string, assetId: string) {
  const now = Date.now();
  const connectionId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const handoffId = crypto.randomUUID();
  const mappingId = crypto.randomUUID();
  const fetchClaimId = crypto.randomUUID();
  const collection = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'")
    .bind(projectId).first<{ id: string }>();
  await database.DB.batch([
    database.DB.prepare("INSERT INTO integration_connections (id, provider, status, created_at, updated_at) VALUES (?, 'dropbox', 'connected', ?, ?)").bind(connectionId, now, now),
    database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, retries, created_at, updated_at) VALUES (?, 'autohdr', 'done', ?, 0, ?, ?)").bind(jobId, projectId, now, now),
    database.DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, manifest_version, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, initiated_by, state, workflow_id, job_id, lease_expires_at, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 'selection', ?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?)")
      .bind(handoffId, projectId, connectionId, JSON.stringify([assetId]), JSON.stringify([{ key: `asset:${assetId}`, assetIds: [assetId] }]), `/Raw/${projectId}`, seedAdminId, `send:${handoffId}`, jobId, now + 60_000, now, now),
    database.DB.prepare("INSERT INTO autohdr_output_mappings (id, project_id, handoff_id, connection_id, generation, state, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'pending_discovery', ?, ?)")
      .bind(mappingId, projectId, handoffId, connectionId, now, now),
    database.DB.prepare("INSERT INTO autohdr_path_claims (id, mapping_id, handoff_id, project_id, connection_id, candidate, path, path_key, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'final', ?, ?, 'pending', ?, ?)")
      .bind(crypto.randomUUID(), mappingId, handoffId, projectId, connectionId, `/AutoHDR/${projectId}/04-FINAL-Photos`, `/autohdr/${projectId}/04-final-photos`, now, now),
    database.DB.prepare("INSERT INTO autohdr_path_claims (id, mapping_id, handoff_id, project_id, connection_id, candidate, path, path_key, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'finals', ?, ?, 'pending', ?, ?)")
      .bind(crypto.randomUUID(), mappingId, handoffId, projectId, connectionId, `/AutoHDR/${projectId}/04-FINALS-Photos`, `/autohdr/${projectId}/04-finals-photos`, now, now),
    database.DB.prepare("INSERT INTO autohdr_fetch_claims (id, project_id, handoff_id, mapping_id, mapping_generation, connection_id, workflow_id, job_id, state, lease_expires_at, trigger, trigger_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'done', ?, 'manual', '{}', ?, ?)")
      .bind(fetchClaimId, projectId, handoffId, mappingId, connectionId, `fetch:${fetchClaimId}`, jobId, now + 60_000, now, now),
    database.DB.prepare("INSERT INTO autohdr_final_associations (id, handoff_id, asset_id, readiness_unit_key, match_kind, created_at) VALUES (?, ?, ?, ?, 'exact', ?)")
      .bind(crypto.randomUUID(), handoffId, assetId, `asset:${assetId}`, now),
    database.DB.prepare("INSERT INTO edited_source_claims (id, collection_id, source_path_key, current_asset_id, content_hash, handoff_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'delete-hash', ?, ?, ?)")
      .bind(crypto.randomUUID(), collection!.id, `/autohdr/${projectId}/04-final-photos/delete.jpg`, assetId, handoffId, now, now),
    database.DB.prepare("INSERT INTO raw_reconciliation_claims (id, project_id, owner_job_id, state, lease_expires_at, trigger, created_at, updated_at) VALUES (?, ?, ?, 'done', ?, 'dropbox_delta', ?, ?)")
      .bind(crypto.randomUUID(), projectId, jobId, now, now, now),
  ]);
  return { connectionId, jobId, handoffId, mappingId };
}

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await executeSql(__PORTAL_SEED_SQL__);
  const now = Date.now();
  await database.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind("test-photographer", "Test Photographer", "photographer@example.test", 1, "photographer", 1, now, now).run();
  await database.DB.prepare(
    "INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("test-photographer-session", now + 60 * 60 * 1000, photographerToken, "test-photographer", now, now).run();
  await database.DB.prepare(
    "INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("test-admin-session", now + 60 * 60 * 1000, adminToken, seedAdminId, now, now).run();
  for (const [id, name, email, role] of [
    [firstPhotographerId, "First Photographer", "first-photographer@example.test", "photographer"],
    [secondPhotographerId, "Second Photographer", "second-photographer@example.test", "photographer"],
    [editorId, "Test Editor", "test-editor@example.test", "editor"],
  ]) {
    await database.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, name, email, 1, role, 1, now, now).run();
  }
  await database.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)",
  ).bind(externalEditorId, "External Editor", "external-editor@example.test", 1, "external_editor", 1, now, now).run();
  await database.DB.prepare(
    "INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("test-second-photographer-session", now + 60 * 60 * 1000, secondPhotographerToken, secondPhotographerId, now, now).run();
  await database.DB.prepare(
    "INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("test-first-photographer-session", now + 60 * 60 * 1000, firstPhotographerToken, firstPhotographerId, now, now).run();
  await database.DB.prepare(
    "INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("test-editor-session", now + 60 * 60 * 1000, editorToken, editorId, now, now).run();
  await database.DB.prepare(
    "INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("test-external-editor-session", now + 60 * 60 * 1000, externalEditorToken, externalEditorId, now, now).run();
  await database.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind("test-other-admin", "Other Admin", "other-admin@example.test", 1, "admin", 1, now, now).run();
  await database.DB.prepare(
    "INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("test-other-admin-session", now + 60 * 60 * 1000, otherAdminToken, "test-other-admin", now, now).run();
});

async function createEditableAnnotation(strokes: Array<{ points: Array<{ x: number; y: number }>; color: string; width: number }>) {
  const adminCookie = await sessionCookie(adminToken);
  const projectResponse = await SELF.fetch("https://portal.test/api/projects", {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: JSON.stringify({
      street: `Edit annotation ${crypto.randomUUID()}`,
      orderedServices: [],
      photographerUserIds: [firstPhotographerId, secondPhotographerId],
    }),
  });
  expect(projectResponse.status).toBe(201);
  const project = await projectResponse.json() as { id: string };
  const collection = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
  expect(collection).toBeDefined();
  const assetId = crypto.randomUUID();
  const now = Date.now();
  await database.DB.prepare(
    "INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(assetId, collection!.id, `tests/${assetId}.jpg`, "edit-annotation.jpg", 1024, "upload", now, now).run();
  const annotationResponse = await SELF.fetch(`https://portal.test/api/assets/${assetId}/annotations`, {
    method: "POST",
    headers: { cookie: await sessionCookie(firstPhotographerToken), "content-type": "application/json" },
    body: JSON.stringify({ strokes }),
  });
  expect(annotationResponse.status).toBe(201);
  const created = await annotationResponse.json() as { id: string; strokeR2Key: string | null };
  return { projectId: project.id, assetId, annotationId: created.id, strokeR2Key: created.strokeR2Key };
}

type VisibilityFixture = { projectId: string; assetId: string; annotationId: string };

async function createVisibilityFixture(): Promise<VisibilityFixture> {
  const adminCookie = await sessionCookie(adminToken);
  const projectResponse = await SELF.fetch("https://portal.test/api/projects", {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: JSON.stringify({
      street: `Stage visibility ${crypto.randomUUID()}`,
      orderedServices: ["video", "floorplan", "copy"],
      photographerUserIds: [firstPhotographerId],
      editorUserIds: [editorId],
    }),
  });
  expect(projectResponse.status).toBe(201);
  const project = await projectResponse.json() as { id: string };
  const collection = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'")
    .bind(project.id).first<{ id: string }>();
  expect(collection).toBeDefined();
  const assetId = crypto.randomUUID();
  const key = `projects/${project.id}/raw/${assetId}/visibility.jpg`;
  const now = Date.now();
  await authEnv.MEDIA.put(key, "stage-visibility-asset", { httpMetadata: { contentType: "image/jpeg" } });
  await database.DB.prepare(
    "INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(assetId, collection!.id, key, "visibility.jpg", 22, "upload", now, now).run();

  const photographerCookie = await sessionCookie(firstPhotographerToken);
  const annotationResponse = await SELF.fetch(`https://portal.test/api/assets/${assetId}/annotations`, {
    method: "POST",
    headers: { cookie: photographerCookie, "content-type": "application/json" },
    body: JSON.stringify({ strokes: [{ points: [{ x: 0.1, y: 0.2 }], color: "#3f5b3a", width: 2 }], noteText: "Stage visibility annotation" }),
  });
  expect(annotationResponse.status).toBe(201);
  const annotation = await annotationResponse.json() as { id: string };
  return { projectId: project.id, assetId, annotationId: annotation.id };
}

async function setFixtureStage(fixture: VisibilityFixture, stageKey: string) {
  await database.DB.prepare("UPDATE projects SET stage_key = ?, updated_at = ? WHERE id = ?")
    .bind(stageKey, Date.now(), fixture.projectId).run();
}

async function jsonRequest(path: string, cookie: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown) {
  return SELF.fetch(`https://portal.test${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const testExecutionContext = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;

async function requestWithDbBatchFault(path: string, cookie: string, body: unknown, fault: (db: D1Database) => Promise<void>, method: "POST" | "PATCH" | "DELETE" = "PATCH") {
  let injected = false;
  const faultDb = new Proxy(authEnv.DB, {
    get(target, property, receiver) {
      if (property !== "batch") return Reflect.get(target, property, receiver);
      return async (statements: unknown[]) => {
        if (!injected) {
          injected = true;
          await fault(database.DB);
        }
        return (target.batch as unknown as (items: unknown[]) => Promise<unknown>)(statements);
      };
    },
  }) as unknown as D1Database;
  return app.fetch(
    new Request(`https://portal.test${path}`, {
      method,
      headers: { cookie, origin: authEnv.APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { ...authEnv, DB: faultDb },
    testExecutionContext,
  );
}

async function requestWithPreparedStatementFault(path: string, cookie: string, body: unknown, matches: (sql: string) => boolean, method: "POST" | "PUT" | "PATCH" = "PATCH") {
  let injected = false;
  const faultDb = new Proxy(authEnv.DB, {
    get(target, property, receiver) {
      if (property !== "prepare") return Reflect.get(target, property, receiver);
      return (sql: string) => {
        if (!injected && matches(sql)) {
          injected = true;
          return target.prepare("SELECT * FROM tb4_missing_fault_injection_table");
        }
        return target.prepare(sql);
      };
    },
  }) as unknown as D1Database;
  return app.fetch(
    new Request(`https://portal.test${path}`, {
      method,
      headers: { cookie, origin: authEnv.APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { ...authEnv, DB: faultDb },
    testExecutionContext,
  );
}

async function requestWithRebaseBindSpy(path: string, cookie: string, body: unknown, bindCounts: number[]) {
  const spyDb = new Proxy(authEnv.DB, {
    get(target, property, receiver) {
      if (property !== "prepare") return Reflect.get(target, property, receiver);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("UPDATE collection_links SET position = (SELECT CAST(json_extract(value, '$.newPosition')")) return statement;
        return new Proxy(statement, {
          get(statementTarget, statementProperty, statementReceiver) {
            if (statementProperty !== "bind") return Reflect.get(statementTarget, statementProperty, statementReceiver);
            return (...values: unknown[]) => { bindCounts.push(values.length); return statementTarget.bind(...values); };
          },
        }) as unknown as D1PreparedStatement;
      };
    },
  }) as unknown as D1Database;
  return app.fetch(
    new Request(`https://portal.test${path}`, {
      method: "POST",
      headers: { cookie, origin: authEnv.APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { ...authEnv, DB: spyDb },
    testExecutionContext,
  );
}

describe("staff app API", () => {
  it("returns annotations without comments and removes the comment routes", async () => {
    const cookie = await sessionCookie(adminToken);
    const { assetId, annotationId } = await createEditableAnnotation([{ points: [{ x: 0.1, y: 0.1 }], color: "#000", width: 2 }]);
    const annotationsResponse = await SELF.fetch(`https://portal.test/api/assets/${assetId}/annotations`, { headers: { cookie } });
    expect(annotationsResponse.status).toBe(200);
    const body = await annotationsResponse.json() as { annotations: Array<{ id: string }> };
    expect(Object.keys(body)).toEqual(["annotations"]);
    expect(body).toEqual({ annotations: [expect.objectContaining({ id: annotationId })] });

    const [post, patch, del] = await Promise.all([
      SELF.fetch(`https://portal.test/api/assets/${assetId}/comments`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "gone" }) }),
      SELF.fetch(`https://portal.test/api/comments/${crypto.randomUUID()}`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "gone" }) }),
      SELF.fetch(`https://portal.test/api/comments/${crypto.randomUUID()}`, { method: "DELETE", headers: { cookie } }),
    ]);
    expect(post.status).toBe(404);
    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);
  });

  it("verifies a fresh manual RAW batch from its durable manifest attribution", async () => {
    const cookie = await sessionCookie(adminToken);
    const project = await createUploadProject(cookie, `Fresh manifest ${crypto.randomUUID()}`);
    const filenames = ["fresh-1.jpg", "fresh-2.jpeg", "fresh-3.jpg"];
    const manifestId = await createRawManifest(cookie, project.id, filenames);

    for (const filename of filenames) {
      const response = await completeRawUpload(cookie, project.id, filename, manifestId);
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({
        publishStatus: "ready",
        mirrorStatus: "pending",
        jobId: expect.any(String),
      });
    }

    await expect(ingestStatus(cookie, project.id)).resolves.toEqual({
      expectedCount: 3,
      receivedCount: 3,
      mismatch: false,
    });
    await expect(database.DB.prepare("SELECT status FROM upload_manifests WHERE id = ?").bind(manifestId).first()).resolves.toEqual({ status: "complete" });
    await expect(database.DB.prepare("SELECT count(*) AS n FROM assets WHERE manifest_id = ?").bind(manifestId).first()).resolves.toEqual({ n: 3 });
  });

  it("compares a new one-file manifest with its own asset instead of ten older collection assets", async () => {
    const cookie = await sessionCookie(adminToken);
    const project = await createUploadProject(cookie, `Manifest delta ${crypto.randomUUID()}`);
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const now = Date.now();
    const statements = Array.from({ length: 10 }, (_, index) => {
      const assetId = crypto.randomUUID();
      return database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'dropbox', ?, ?)")
        .bind(assetId, raw!.id, `tests/${assetId}.jpg`, `existing-${index}.jpg`, now, now);
    });
    statements.push(database.DB.prepare("UPDATE collections SET received_count = 10 WHERE id = ?").bind(raw!.id));
    await database.DB.batch(statements);

    const manifestId = await createRawManifest(cookie, project.id, ["new-only.jpg"]);
    expect((await completeRawUpload(cookie, project.id, "new-only.jpg", manifestId)).status).toBe(201);
    await expect(ingestStatus(cookie, project.id)).resolves.toEqual({
      expectedCount: 1,
      receivedCount: 1,
      mismatch: false,
    });
  });

  it("keeps a genuine active-manifest shortfall visible", async () => {
    const cookie = await sessionCookie(adminToken);
    const project = await createUploadProject(cookie, `Manifest shortfall ${crypto.randomUUID()}`);
    const manifestId = await createRawManifest(cookie, project.id, ["short-1.jpg", "short-2.jpg", "short-3.jpg"]);
    expect((await completeRawUpload(cookie, project.id, "short-1.jpg", manifestId)).status).toBe(201);
    expect((await completeRawUpload(cookie, project.id, "short-2.jpg", manifestId)).status).toBe(201);

    await expect(ingestStatus(cookie, project.id)).resolves.toEqual({
      expectedCount: 3,
      receivedCount: 2,
      mismatch: true,
    });
    await expect(database.DB.prepare("SELECT status FROM upload_manifests WHERE id = ?").bind(manifestId).first()).resolves.toEqual({ status: "active" });
  });

  it("aggregates every active manifest so a newer batch cannot hide an older shortfall", async () => {
    const cookie = await sessionCookie(adminToken);
    const project = await createUploadProject(cookie, `Manifest aggregate ${crypto.randomUUID()}`);
    const older = await createRawManifest(cookie, project.id, ["old-1.jpg", "old-2.jpg", "old-3.jpg"]);
    expect((await completeRawUpload(cookie, project.id, "old-1.jpg", older)).status).toBe(201);
    expect((await completeRawUpload(cookie, project.id, "old-2.jpg", older)).status).toBe(201);
    const newer = await createRawManifest(cookie, project.id, ["new-1.jpg", "new-2.jpg"]);
    expect((await completeRawUpload(cookie, project.id, "new-1.jpg", newer)).status).toBe(201);

    await expect(ingestStatus(cookie, project.id)).resolves.toEqual({
      expectedCount: 5,
      receivedCount: 3,
      mismatch: true,
    });
  });

  it("preserves collection-level count verification for a Dropbox-only project with no manifests", async () => {
    const cookie = await sessionCookie(adminToken);
    const project = await createUploadProject(cookie, `Dropbox-only count ${crypto.randomUUID()}`);
    await database.DB.prepare("UPDATE collections SET expected_count = 8, received_count = 7 WHERE project_id = ? AND kind = 'raw'").bind(project.id).run();
    await expect(ingestStatus(cookie, project.id)).resolves.toEqual({
      expectedCount: 8,
      receivedCount: 7,
      mismatch: true,
    });
  });

  it("does not let manifest creation clobber Dropbox's collection expected count", async () => {
    const cookie = await sessionCookie(adminToken);
    const project = await createUploadProject(cookie, `Manifest writer isolation ${crypto.randomUUID()}`);
    await database.DB.prepare("UPDATE collections SET expected_count = 37 WHERE project_id = ? AND kind = 'raw'").bind(project.id).run();
    await createRawManifest(cookie, project.id, ["manual-1.jpg", "manual-2.jpg"]);
    await expect(database.DB.prepare("SELECT expected_count FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first()).resolves.toEqual({ expected_count: 37 });
  });

  it("rejects manifest creation for an archived project", async () => {
    const cookie = await sessionCookie(adminToken);
    const project = await createUploadProject(cookie, `Archived manifest ${crypto.randomUUID()}`);
    await database.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(Date.now(), project.id).run();
    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}/upload-manifest`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ filenames: ["archived.jpg"] }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Project is archived" });
  });

  it("rejects a manifest that does not belong to the completed upload's RAW collection", async () => {
    const cookie = await sessionCookie(adminToken);
    const owner = await createUploadProject(cookie, `Manifest owner ${crypto.randomUUID()}`);
    const other = await createUploadProject(cookie, `Manifest other ${crypto.randomUUID()}`);
    const manifestId = await createRawManifest(cookie, owner.id, ["owner.jpg"]);
    const response = await completeRawUpload(cookie, other.id, "other.jpg", manifestId);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Upload manifest does not belong to this project's RAW collection" });
    await expect(database.DB.prepare("SELECT count(*) AS n FROM assets WHERE manifest_id = ?").bind(manifestId).first()).resolves.toEqual({ n: 0 });
  });

  it("recognizes a D1 version collision carried by error.cause", () => {
    expect(uniqueVersionError(new Error("Failed query", {
      cause: new Error("UNIQUE constraint failed: assets.version_group_id, assets.kind, assets.version"),
    }))).toBe(true);
    expect(uniqueVersionError(new Error("Failed query"))).toBe(false);
  });

  it("writes a streaming STORE ZIP with descriptors and a valid central directory", async () => {
    const encoder = new TextEncoder();
    async function* entries() {
      yield { name: "frame.jpg", size: 5, stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode("hello")); controller.close(); } }) };
      yield { name: "frame.jpg", size: 5, stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode("world")); controller.close(); } }) };
    }
    const reader = createZipStream(entries()).getReader(); const chunks: Uint8Array[] = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value!); }
    const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    const signatureCount = (signature: number[]) => output.reduce((count, _, index) => signature.every((byte, part) => output[index + part] === byte) ? count + 1 : count, 0);
    expect([...output.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(signatureCount([0x50, 0x4b, 0x01, 0x02])).toBe(2);
    expect([...output.slice(-22, -18)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
    expect(new DataView(output.buffer, output.byteOffset + output.length - 22).getUint16(10, true)).toBe(2);
    const descriptor = output.findIndex((_, index) => output[index] === 0x50 && output[index + 1] === 0x4b && output[index + 2] === 0x07 && output[index + 3] === 0x08);
    expect(new DataView(output.buffer, output.byteOffset + descriptor + 4).getUint32(0, true)).toBe(0x3610a686);
  });

  it("writes ZIP64 local-header sentinels and end records", async () => {
    const encoder = new TextEncoder();
    async function* entries() {
      yield { name: "frame.jpg", size: 5, stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode("hello")); controller.close(); } }) };
    }
    const reader = createZipStream(entries(), 1).getReader(); const chunks: Uint8Array[] = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value!); }
    const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    expect(view.getUint16(4, true)).toBe(45);
    expect(view.getUint32(18, true)).toBe(0xffff_ffff);
    expect(view.getUint32(22, true)).toBe(0xffff_ffff);
    expect(view.getUint16(30 + encoder.encode("frame.jpg").length, true)).toBe(0x0001);
    expect([...output.slice(-98, -94)]).toEqual([0x50, 0x4b, 0x06, 0x06]);
    expect([...output.slice(-42, -38)]).toEqual([0x50, 0x4b, 0x06, 0x07]);
    expect([...output.slice(-22, -18)]).toEqual([0x50, 0x4b, 0x05, 0x06]);
  });

  it("reports its health", async () => {
    const response = await SELF.fetch("https://portal.test/api/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("orders active and archived projects by shoot date for every dashboard role without exposing archives to photographers", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const create = async (street: string, shootDate: string | null, photographer = false) => {
      const response = await SELF.fetch("https://portal.test/api/projects", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({ street, shootDate, orderedServices: [], ...(photographer ? { photographerUserIds: [firstPhotographerId] } : {}) }),
      });
      expect(response.status).toBe(201);
      return (await response.json() as { id: string }).id;
    };
    const alpha = await create("alpha Avenue", "2026-07-22", true);
    const beta = await create("Beta Avenue", "2026-07-22", true);
    const tieA = await create("Tie Street", "2026-07-22", true);
    const tieB = await create("Tie Street", "2026-07-22", true);
    const older = await create("Older Road", "2026-07-21", true);
    const noDate = await create("Pending Place", null);
    const archivedRecent = await create("Archived Recent", "2026-07-23", true);
    const archivedOlder = await create("Archived Older", "2026-07-20", true);
    for (const id of [archivedRecent, archivedOlder]) {
      expect((await SELF.fetch(`https://portal.test/api/projects/${id}/archive`, { method: "POST", headers: { cookie: adminCookie } })).status).toBe(200);
    }

    // Accent-sensitive ordering keeps Élan distinct from elan, while case
    // variants of Élan remain an ID tie. IDs deliberately oppose insertion
    // order and the accented-vs-plain collation result.
    const unicodeActiveAccentedUpper = "00000000-0000-4000-8000-000000000101";
    const unicodeActiveAccentedLower = "00000000-0000-4000-8000-000000000102";
    const unicodeActivePlain = "00000000-0000-4000-8000-000000000103";
    const unicodeArchivedAccentedUpper = "00000000-0000-4000-8000-000000000201";
    const unicodeArchivedAccentedLower = "00000000-0000-4000-8000-000000000202";
    const unicodeArchivedPlain = "00000000-0000-4000-8000-000000000203";
    const insertUnicodeTie = async (id: string, street: string, archivedAt: number | null) => {
      const now = Date.now();
      await database.DB.prepare("INSERT INTO projects (id, street, shoot_date, stage_key, archived_at, created_at, updated_at) VALUES (?, ?, '2026-07-22', 'awaiting_raw', ?, ?, ?)").bind(id, street, archivedAt, now, now).run();
      await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(crypto.randomUUID(), id, firstPhotographerId, now).run();
    };
    await insertUnicodeTie(unicodeActiveAccentedLower, "ÉLAN Avenue", null);
    await insertUnicodeTie(unicodeActivePlain, "elan avenue", null);
    await insertUnicodeTie(unicodeActiveAccentedUpper, "Élan Avenue", null);
    await insertUnicodeTie(unicodeArchivedAccentedLower, "ÉLAN Archive", Date.now());
    await insertUnicodeTie(unicodeArchivedPlain, "elan archive", Date.now());
    await insertUnicodeTie(unicodeArchivedAccentedUpper, "Élan Archive", Date.now());

    const listed = await SELF.fetch("https://portal.test/api/projects", { headers: { cookie: adminCookie } });
    expect(listed.status).toBe(200);
    const activeIds = (await listed.json() as { projects: Array<{ id: string }> }).projects.map((project) => project.id).filter((id) => [alpha, beta, tieA, tieB, older, noDate].includes(id));
    expect(activeIds).toEqual([alpha, beta, ...[tieA, tieB].sort(), older, noDate]);
    const activeUnicodeIds = (await (await SELF.fetch("https://portal.test/api/projects", { headers: { cookie: adminCookie } })).json() as { projects: Array<{ id: string }> }).projects.map((project) => project.id).filter((id) => [unicodeActiveAccentedUpper, unicodeActiveAccentedLower, unicodeActivePlain].includes(id));
    expect(activeUnicodeIds).toEqual([unicodeActivePlain, unicodeActiveAccentedUpper, unicodeActiveAccentedLower]);

    const archived = await SELF.fetch("https://portal.test/api/projects?archived=1", { headers: { cookie: adminCookie } });
    expect(archived.status).toBe(200);
    const archivedIds = (await archived.json() as { projects: Array<{ id: string }> }).projects.map((project) => project.id).filter((id) => [archivedRecent, archivedOlder].includes(id));
    expect(archivedIds).toEqual([archivedRecent, archivedOlder]);
    const archivedUnicodeIds = (await (await SELF.fetch("https://portal.test/api/projects?archived=1", { headers: { cookie: adminCookie } })).json() as { projects: Array<{ id: string }> }).projects.map((project) => project.id).filter((id) => [unicodeArchivedAccentedUpper, unicodeArchivedAccentedLower, unicodeArchivedPlain].includes(id));
    expect(archivedUnicodeIds).toEqual([unicodeArchivedPlain, unicodeArchivedAccentedUpper, unicodeArchivedAccentedLower]);

    const photographerCookie = await sessionCookie(firstPhotographerToken);
    const photographer = await SELF.fetch("https://portal.test/api/projects", { headers: { cookie: photographerCookie } });
    const photographerIds = (await photographer.json() as { projects: Array<{ id: string }> }).projects.map((project) => project.id).filter((id) => [alpha, beta, tieA, tieB, older, noDate, archivedRecent, archivedOlder].includes(id));
    expect(photographerIds).toEqual([alpha, beta, ...[tieA, tieB].sort(), older]);
    const photographerUnicodeIds = (await (await SELF.fetch("https://portal.test/api/projects", { headers: { cookie: photographerCookie } })).json() as { projects: Array<{ id: string }> }).projects.map((project) => project.id).filter((id) => [unicodeActiveAccentedUpper, unicodeActiveAccentedLower, unicodeActivePlain].includes(id));
    expect(photographerUnicodeIds).toEqual([unicodeActivePlain, unicodeActiveAccentedUpper, unicodeActiveAccentedLower]);

    const unauthorizedArchived = await SELF.fetch("https://portal.test/api/projects?archived=1", { headers: { cookie: photographerCookie } });
    expect(unauthorizedArchived.status).toBe(200);
    const unauthorizedIds = (await unauthorizedArchived.json() as { projects: Array<{ id: string }> }).projects.map((project) => project.id);
    expect(unauthorizedIds).not.toContain(archivedRecent);
    expect(unauthorizedIds).not.toContain(archivedOlder);
  });

  it("lists a multiply-assigned photographer project once while retaining dashboard order and counts", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const create = async (street: string, shootDate: string) => {
      const response = await SELF.fetch("https://portal.test/api/projects", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({ street, shootDate, orderedServices: [], photographerUserIds: [firstPhotographerId, editorId] }),
      });
      expect(response.status).toBe(201);
      return (await response.json() as { id: string }).id;
    };
    const newer = await create("Duplicate membership newer", "2026-07-25");
    const older = await create("Duplicate membership older", "2026-07-24");
    await database.DB.prepare("UPDATE collections SET received_count = ?, expected_count = ? WHERE project_id = ? AND kind = 'raw'").bind(4, 6, newer).run();
    await database.DB.prepare("UPDATE collections SET received_count = ?, expected_count = ? WHERE project_id = ? AND kind = 'raw'").bind(2, 3, older).run();

    // editorId is globally an Editor, so their Photographer and Editor rows are both eligible.
    const secondRole = await SELF.fetch(`https://portal.test/api/projects/${newer}/editors/${editorId}`, {
      method: "PUT",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(secondRole.status).toBe(201);

    const response = await SELF.fetch("https://portal.test/api/projects", { headers: { cookie: await sessionCookie(firstPhotographerToken) } });
    expect(response.status).toBe(200);
    const assigned = (await response.json() as { projects: Array<{ id: string; receivedCount: number; expectedCount: number | null }> }).projects
      .filter((project) => project.id === newer || project.id === older);
    expect(assigned).toEqual([
      expect.objectContaining({ id: newer, receivedCount: 4, expectedCount: 6 }),
      expect.objectContaining({ id: older, receivedCount: 2, expectedCount: 3 }),
    ]);
  });

  it("enforces photographer stage visibility across every access-gated route family", async () => {
    const fixture = await createVisibilityFixture();
    const photographerCookie = await sessionCookie(firstPhotographerToken);
    const nonMemberCookie = await sessionCookie(photographerToken);
    const stages = ["awaiting_raw", "raw_review", "editing_autohdr", "edited_review", "delivered"] as const;
    const expectStageStatus = (response: Response, allowed: number | number[]) => {
      const expected = Array.isArray(allowed) ? allowed : [allowed];
      expect(expected).toContain(response.status);
    };
    const annotationBody = { strokes: [{ points: [{ x: 0.2, y: 0.3 }], color: "#9a6a1f", width: 2 }] };

    for (const [index, stageKey] of stages.entries()) {
      await setFixtureStage(fixture, stageKey);
      const visible = index < 2;
      const accessStatus = visible ? 200 : 403;
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}`, photographerCookie, "GET"), accessStatus);
      expectStageStatus(await jsonRequest(`/media/asset/${fixture.assetId}/original`, photographerCookie, "GET"), accessStatus);
      expectStageStatus(await jsonRequest(`/api/assets/${fixture.assetId}/annotations`, photographerCookie, "GET"), accessStatus);
      expectStageStatus(await jsonRequest(`/media/annotation/${fixture.annotationId}`, photographerCookie, "GET"), accessStatus);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/assets?collection=raw`, photographerCookie, "GET"), accessStatus);
      expectStageStatus(await jsonRequest(`/api/assets/${fixture.assetId}/review`, photographerCookie, "POST", { recommended: true }), accessStatus);

      const createdAnnotation = await jsonRequest(`/api/assets/${fixture.assetId}/annotations`, photographerCookie, "POST", { ...annotationBody, noteText: `stage ${stageKey}` });
      expectStageStatus(createdAnnotation, visible ? 201 : 403);
      if (visible) {
        const created = await createdAnnotation.json() as { id: string };
        expectStageStatus(await jsonRequest(`/api/annotations/${created.id}`, photographerCookie, "DELETE"), 200);
      }
      expectStageStatus(await jsonRequest(`/api/annotations/${fixture.annotationId}`, photographerCookie, "PATCH", { noteText: `edited ${stageKey}` }), visible ? 200 : 403);
      if (!visible) expectStageStatus(await jsonRequest(`/api/annotations/${fixture.annotationId}`, photographerCookie, "DELETE"), 403);

      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/upload-manifest`, photographerCookie, "POST", { filenames: [`stage-${stageKey}.jpg`] }), visible ? 200 : 403);
      expectStageStatus(await jsonRequest("/api/uploads/presign", photographerCookie, "POST", { projectId: fixture.projectId, filename: "stage.jpg", bytes: 10, collection: "raw" }), visible ? 503 : 403);
      const uploadAssetId = crypto.randomUUID();
      expectStageStatus(await jsonRequest("/api/uploads/complete", photographerCookie, "POST", { projectId: fixture.projectId, key: `projects/${fixture.projectId}/raw/${uploadAssetId}/stage.jpg`, originalFilename: "stage.jpg", collection: "raw" }), visible ? 409 : 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/ingest-status`, photographerCookie, "GET"), visible ? 200 : 403);
      // Production intentionally rejects the dev-only direct PUT before authorization;
      // retain this assertion so the fifth upload route cannot silently drift into production.
      const directUpload = await SELF.fetch(`https://portal.test/api/uploads/direct?key=projects/${fixture.projectId}/raw/${crypto.randomUUID()}/stage.jpg`, {
        method: "PUT", headers: { cookie: photographerCookie }, body: "stage",
      });
      expect(directUpload.status).toBe(404);

      // Photographers reach these collection routes only while assigned, then fail their
      // existing capability check; after the cutoff the central access check is the first 403.
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/links?collection=video`, photographerCookie, "GET"), 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/links`, photographerCookie, "POST", { collection: "video", url: `https://example.com/${crypto.randomUUID()}` }), 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/links/${crypto.randomUUID()}`, photographerCookie, "DELETE"), 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/documents/presign`, photographerCookie, "POST", { kind: "copy_pdf", pdf: { filename: "stage.pdf", bytes: 10, contentType: "application/pdf" } }), 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/documents/complete`, photographerCookie, "POST", { sessionId: crypto.randomUUID(), pdf: {} }), 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/documents/${crypto.randomUUID()}/abort`, photographerCookie, "POST"), 403);
      const directDocument = await SELF.fetch(`https://portal.test/api/projects/${fixture.projectId}/documents/direct/${crypto.randomUUID()}/pdf`, {
        method: "PUT", headers: { cookie: photographerCookie }, body: "stage",
      });
      expect(directDocument.status).toBe(404);

      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}`, photographerCookie, "PATCH", { notes: `stage ${stageKey}` }), 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/cover`, photographerCookie, "POST", { assetId: null }), 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/dropbox-sync`, photographerCookie, "POST"), visible ? 400 : 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/sync-dropbox`, photographerCookie, "POST"), visible ? 409 : 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/manual-upload-jobs`, photographerCookie, "GET"), visible ? 200 : 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/selected-raw.zip`, photographerCookie, "GET"), 403);

      // These routes retain their existing adminBackend middleware; the photographer is denied
      // before that route's hasProjectAccess call, but every live call site remains exercised.
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/send-to-autohdr`, photographerCookie, "POST", {}), 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/fetch-edited`, photographerCookie, "POST"), 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/autohdr-status`, photographerCookie, "GET"), 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/autohdr-history`, photographerCookie, "GET"), 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/autohdr-coverage`, photographerCookie, "POST", { handoffId: crypto.randomUUID(), assetId: fixture.assetId, readinessUnitKey: "stage" }), 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/jobs`, photographerCookie, "GET"), 403);
      expectStageStatus(await jsonRequest(`/api/projects/${fixture.projectId}/stage`, photographerCookie, "POST", { stageKey: "raw_review" }), 403);
      expectStageStatus(await jsonRequest(`/api/jobs/${crypto.randomUUID()}/retry`, photographerCookie, "POST"), 403);

      // Non-members must remain denied at every stage, even while the project itself is visible
      // to an assigned photographer in the first two stages.
      for (const response of await Promise.all([
        jsonRequest(`/api/projects/${fixture.projectId}`, nonMemberCookie, "GET"),
        jsonRequest(`/media/asset/${fixture.assetId}/original`, nonMemberCookie, "GET"),
        jsonRequest(`/media/annotation/${fixture.annotationId}`, nonMemberCookie, "GET"),
        jsonRequest(`/api/assets/${fixture.assetId}/annotations`, nonMemberCookie, "GET"),
        jsonRequest(`/api/annotations/${fixture.annotationId}`, nonMemberCookie, "PATCH", { noteText: "non-member" }),
        jsonRequest(`/api/annotations/${fixture.annotationId}`, nonMemberCookie, "DELETE"),
        jsonRequest(`/api/projects/${fixture.projectId}/assets?collection=raw`, nonMemberCookie, "GET"),
        jsonRequest(`/api/assets/${fixture.assetId}/review`, nonMemberCookie, "POST", { recommended: true }),
        jsonRequest(`/api/assets/${fixture.assetId}/annotations`, nonMemberCookie, "POST", { noteText: "non-member" }),
        jsonRequest(`/api/projects/${fixture.projectId}/upload-manifest`, nonMemberCookie, "POST", { filenames: ["non-member.jpg"] }),
        jsonRequest(`/api/projects/${fixture.projectId}/ingest-status`, nonMemberCookie, "GET"),
        jsonRequest(`/api/projects/${fixture.projectId}/links?collection=video`, nonMemberCookie, "GET"),
        jsonRequest(`/api/projects/${fixture.projectId}/documents/presign`, nonMemberCookie, "POST", { kind: "copy_pdf", pdf: { filename: "non-member.pdf", bytes: 10, contentType: "application/pdf" } }),
      ])) expect(response.status).toBe(403);
    }

    // Admin's explicit backward stage change must be observed immediately by the next request.
    await setFixtureStage(fixture, "editing_autohdr");
    expect((await jsonRequest(`/api/projects/${fixture.projectId}`, photographerCookie, "GET")).status).toBe(403);
    const reverted = await jsonRequest(`/api/projects/${fixture.projectId}/stage`, await sessionCookie(adminToken), "POST", { stageKey: "raw_review" });
    expect(reverted.status).toBe(200);
    expect((await jsonRequest(`/api/projects/${fixture.projectId}`, photographerCookie, "GET")).status).toBe(200);

    // Editor and admin retain access at every stage; this guards the viewAllProjects short-circuit
    // and the editor's existing unrestricted project visibility.
    for (const stageKey of stages) {
      await setFixtureStage(fixture, stageKey);
      for (const cookie of [await sessionCookie(editorToken), await sessionCookie(adminToken)]) {
        expect((await jsonRequest(`/api/projects/${fixture.projectId}`, cookie, "GET")).status).toBe(200);
        expect((await jsonRequest(`/media/asset/${fixture.assetId}/original`, cookie, "GET")).status).toBe(200);
        expect((await jsonRequest(`/api/assets/${fixture.assetId}/annotations`, cookie, "GET")).status).toBe(200);
        expect((await jsonRequest(`/api/projects/${fixture.projectId}/assets?collection=raw`, cookie, "GET")).status).toBe(200);
        expect((await jsonRequest(`/api/projects/${fixture.projectId}/ingest-status`, cookie, "GET")).status).toBe(200);
        expect((await jsonRequest(`/api/assets/${fixture.assetId}/review`, cookie, "POST", { recommended: true })).status).toBe(200);
        expect((await jsonRequest(`/api/assets/${fixture.assetId}/select`, cookie, "POST")).status).toBe(200);
        expect((await jsonRequest(`/api/assets/${fixture.assetId}/select`, cookie, "DELETE")).status).toBe(200);
      }
    }

    // Final author cleanup is deliberately performed while the photographer is still in a
    // visible stage, proving delete routes are live for assigned photographers before cutoff.
    await setFixtureStage(fixture, "raw_review");
    expect((await jsonRequest(`/api/annotations/${fixture.annotationId}`, photographerCookie, "DELETE")).status).toBe(200);
    expect((await jsonRequest(`/api/projects/${fixture.projectId}`, photographerCookie, "GET")).status).toBe(200);
  }, 30_000);

  it("filters the photographer dashboard by live stage while leaving editor/admin lists intact", async () => {
    const fixture = await createVisibilityFixture();
    const adminCookie = await sessionCookie(adminToken);
    const editorCookie = await sessionCookie(editorToken);
    const photographerCookie = await sessionCookie(firstPhotographerToken);
    const listedIds = async (cookie: string) => (await (await jsonRequest("/api/projects", cookie, "GET")).json() as { projects: Array<{ id: string }> }).projects.map((project) => project.id);

    for (const [index, stageKey] of ["awaiting_raw", "raw_review", "editing_autohdr", "edited_review", "delivered"].entries()) {
      await setFixtureStage(fixture, stageKey);
      if (index < 2) expect(await listedIds(photographerCookie)).toContain(fixture.projectId);
      else expect(await listedIds(photographerCookie)).not.toContain(fixture.projectId);
      expect(await listedIds(editorCookie)).toContain(fixture.projectId);
      expect(await listedIds(adminCookie)).toContain(fixture.projectId);
    }
    await setFixtureStage(fixture, "editing_autohdr");
    const reverted = await jsonRequest(`/api/projects/${fixture.projectId}/stage`, adminCookie, "POST", { stageKey: "raw_review" });
    expect(reverted.status).toBe(200);
    expect(await listedIds(photographerCookie)).toContain(fixture.projectId);
  }, 15_000);

  it("enforces External Editor assigned-scope projection, media, review, and upload boundaries", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const externalCookie = await sessionCookie(externalEditorToken);
    const createProject = async (street: string, assigned: boolean) => {
      const response = await SELF.fetch("https://portal.test/api/projects", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({ street, orderedServices: [], ...(assigned ? { editorUserIds: [externalEditorId] } : {}) }),
      });
      expect(response.status).toBe(201);
      return (await response.json() as { id: string }).id;
    };
    const assigned = await createProject(`External assigned ${crypto.randomUUID()}`, true);
    const delivered = await createProject(`External delivered ${crypto.randomUUID()}`, true);
    const unassigned = await createProject(`External unassigned ${crypto.randomUUID()}`, false);
    const archived = await createProject(`External archived ${crypto.randomUUID()}`, true);
    await database.DB.prepare("UPDATE projects SET stage_key = 'delivered', notes = ?, production_notes = ?, raw_folder_path = ? WHERE id = ?")
      .bind("INTERNAL_SENTINEL", "External-safe production note", "/Raw/External", delivered).run();
    await database.DB.prepare("UPDATE projects SET notes = ?, production_notes = ? WHERE id = ?")
      .bind("INTERNAL_SENTINEL", "Assigned production note", assigned).run();
    expect((await SELF.fetch(`https://portal.test/api/projects/${archived}/archive`, { method: "POST", headers: { cookie: adminCookie } })).status).toBe(200);

    const listed = await SELF.fetch("https://portal.test/api/projects", { headers: { cookie: externalCookie } });
    expect(listed.status).toBe(200);
    const listedProjects = (await listed.json() as { projects: Array<{ id: string }> }).projects;
    expect(listedProjects.map((project) => project.id)).toEqual(expect.arrayContaining([assigned, delivered]));
    expect(listedProjects.map((project) => project.id)).not.toEqual(expect.arrayContaining([unassigned, archived]));

    const detail = await SELF.fetch(`https://portal.test/api/projects/${assigned}`, { headers: { cookie: externalCookie } });
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as Record<string, unknown> & { productionNotes?: string | null; members?: Array<{ email: string; roleLabel: string }> };
    expect(detailBody.productionNotes).toBe("Assigned production note");
    expect(detailBody.notes).toBeUndefined();
    expect(detailBody.members).toEqual(expect.arrayContaining([expect.objectContaining({ email: "external-editor@example.test", roleLabel: "External editor" })]));
    const me = await SELF.fetch("https://portal.test/api/me", { headers: { cookie: externalCookie } });
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({ user: { role: "external_editor", authorizationEpoch: 0 }, capabilities: ["uploadEdited", "viewRaw", "annotateRaw", "recommendRaw", "compareFrames", "viewEdited", "reviewEdited", "annotateEdited", "collaborateOnProject"] });

    const nonexistent = crypto.randomUUID();
    const projectMisses = await Promise.all([assigned, unassigned, archived, nonexistent].map((id) => SELF.fetch(`https://portal.test/api/projects/${id}`, { headers: { cookie: externalCookie } })));
    expect(projectMisses.map((response) => response.status)).toEqual([200, 404, 404, 404]);
    for (const id of [unassigned, archived, nonexistent]) {
      const childMisses = await Promise.all([
        SELF.fetch(`https://portal.test/api/projects/${id}/assets?collection=raw`, { headers: { cookie: externalCookie } }),
        SELF.fetch(`https://portal.test/api/projects/${id}/links?collection=video`, { headers: { cookie: externalCookie } }),
        SELF.fetch(`https://portal.test/api/projects/${id}/comments`, { headers: { cookie: externalCookie } }),
        SELF.fetch(`https://portal.test/api/projects/${id}/subtasks`, { headers: { cookie: externalCookie } }),
        SELF.fetch(`https://portal.test/api/projects/${id}/collaboration-summary`, { headers: { cookie: externalCookie } }),
        SELF.fetch(`https://portal.test/api/mentionable-users?projectId=${id}`, { headers: { cookie: externalCookie } }),
      ]);
      expect(childMisses.map((response) => response.status)).toEqual([404, 404, 404, 404, 404, 404]);
    }

    const rawCollection = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(assigned).first<{ id: string }>();
    const assetId = crypto.randomUUID();
    const key = `projects/${assigned}/raw/${assetId}/external-raw.jpg`;
    const now = Date.now();
    await authEnv.MEDIA.put(key, "external-raw", { httpMetadata: { contentType: "image/jpeg" } });
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(assetId, rawCollection!.id, key, "external-raw.jpg", 12, "upload", now, now).run();
    const assets = await SELF.fetch(`https://portal.test/api/projects/${assigned}/assets?collection=raw`, { headers: { cookie: externalCookie } });
    expect(assets.status).toBe(200);
    const assetBody = await assets.json() as { assets: Array<Record<string, unknown>> };
    expect(assetBody.assets).toEqual(expect.arrayContaining([expect.objectContaining({ id: assetId, originalFilename: "external-raw.jpg" })]));
    expect(JSON.stringify(assetBody)).not.toContain(key);
    const original = await SELF.fetch(`https://portal.test/media/asset/${assetId}/original`, { headers: { cookie: externalCookie } });
    expect(original.status).toBe(200);
    expect(original.headers.get("cache-control")).toBe("private, no-store");
    expect(original.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await SELF.fetch(`https://portal.test/media/asset/${assetId}/thumb`, { headers: { cookie: externalCookie } })).status).toBe(409);
    expect((await SELF.fetch(`https://portal.test/media/asset/${crypto.randomUUID()}/original`, { headers: { cookie: externalCookie } })).status).toBe(403);

    const review = await SELF.fetch(`https://portal.test/api/assets/${assetId}/review`, { method: "POST", headers: { cookie: externalCookie, "content-type": "application/json" }, body: JSON.stringify({ recommended: true }) });
    expect(review.status).toBe(200);
    expect((await SELF.fetch(`https://portal.test/api/assets/${assetId}/review`, { method: "POST", headers: { cookie: externalCookie, "content-type": "application/json" }, body: JSON.stringify({ stars: 5 }) })).status).toBe(403);
    const annotation = await SELF.fetch(`https://portal.test/api/assets/${assetId}/annotations`, { method: "POST", headers: { cookie: externalCookie, "content-type": "application/json" }, body: JSON.stringify({ noteText: "External annotation", strokes: [{ points: [{ x: 0.1, y: 0.2 }], color: "#3f5b3a", width: 2 }] }) });
    expect(annotation.status).toBe(201);
    const annotationBody = await annotation.json() as Record<string, unknown>;
    expect(annotationBody.strokeR2Key).toBeUndefined();
    expect(annotationBody.author).toMatchObject({ roleLabel: "External editor", isExternal: true });

    const createUpload = async () => SELF.fetch("https://portal.test/api/external-uploads", {
      method: "POST", headers: { cookie: externalCookie, origin: authEnv.APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ projectId: delivered, filename: "edited.jpg", bytes: 1, collection: "edited" }),
    });
    const sessions = [] as Array<{ sessionToken: string }>;
    for (let index = 0; index < 3; index += 1) {
      const response = await createUpload();
      expect(response.status).toBe(201);
      sessions.push(await response.json() as { sessionToken: string });
    }
    expect((await createUpload()).status).toBe(409);
    for (const session of sessions) expect((await SELF.fetch(`https://portal.test/api/external-uploads/${session.sessionToken}`, { method: "DELETE", headers: { cookie: externalCookie, origin: authEnv.APP_ORIGIN } })).status).toBe(200);
    expect((await SELF.fetch("https://portal.test/api/uploads/presign", { method: "POST", headers: { cookie: externalCookie, origin: authEnv.APP_ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ projectId: delivered, filename: "raw.jpg", bytes: 1, collection: "raw" }) })).status).toBe(403);
  }, 30_000);

  it("requires the exact configured Origin for custom API mutations while leaving safe and auth routes alone", async () => {
    const cookie = await sessionCookie(adminToken);
    const body = JSON.stringify({ street: `Origin guard ${crypto.randomUUID()}`, orderedServices: [] });
    const exact = await workerSelf.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie, origin: authEnv.APP_ORIGIN, "content-type": "application/json" }, body,
    });
    expect(exact.status).toBe(201);

    const [wrong, missing, safe, auth] = await Promise.all([
      workerSelf.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, origin: "https://attacker.example", "content-type": "application/json" }, body }),
      workerSelf.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body }),
      workerSelf.fetch("https://portal.test/api/projects", { headers: { cookie } }),
      workerSelf.fetch("https://portal.test/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
    ]);
    expect(wrong.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(safe.status).toBe(200);
    expect(auth.status).not.toBe(403);
  });

  it("requires authentication for staff endpoints", async () => {
    const [me, projects] = await Promise.all([
      SELF.fetch("https://portal.test/api/me"),
      SELF.fetch("https://portal.test/api/projects"),
    ]);

    expect(me.status).toBe(401);
    expect(projects.status).toBe(401);
  });

  it("accepts a signed Better Auth session for a photographer", async () => {
    const response = await SELF.fetch("https://portal.test/api/projects", {
      headers: { cookie: await sessionCookie(photographerToken) },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ projects: [] });
  });

  it("returns the migrated UUID from the existing signed Quincy Admin session", async () => {
    const response = await SELF.fetch("https://portal.test/api/auth/get-session", {
      headers: { cookie: await sessionCookie(adminToken) },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ user: { id: seedAdminId }, session: { userId: seedAdminId } });
  });

  it("keeps API and media misses out of the SPA fallback", async () => {
    const cookie = await sessionCookie(photographerToken);
    const [api, media, spa] = await Promise.all([
      SELF.fetch("https://portal.test/api/does-not-exist", { headers: { cookie } }),
      SELF.fetch("https://portal.test/media/does-not-exist", { headers: { cookie } }),
      SELF.fetch("https://portal.test/client-side-route"),
    ]);

    expect(api.status).toBe(404);
    expect(media.status).toBe(404);
    expect(api.headers.get("content-type")).toContain("application/json");
    expect(media.headers.get("content-type")).toContain("application/json");
    expect(spa.status).toBe(200);
    expect(spa.headers.get("content-type")).toContain("text/html");
  });

  it("reserves delivery and backend roots before the SPA fallback", async () => {
    const cookie = await sessionCookie(photographerToken);
    const staffPaths = ["/", "/projects/new", `/projects/${crypto.randomUUID()}`, `/projects/${crypto.randomUUID()}/edit`, "/admin"];
    const [apiRoot, mediaRoot, sourceRoot, api, media, staffResponses, deliveryRoot, deliverySlash, deliveryToken, deliveryPost] = await Promise.all([
      SELF.fetch("https://portal.test/api", { headers: { cookie } }),
      SELF.fetch("https://portal.test/media", { headers: { cookie } }),
      SELF.fetch("https://portal.test/__transform-source"),
      SELF.fetch("https://portal.test/api/does-not-exist", { headers: { cookie } }),
      SELF.fetch("https://portal.test/media/does-not-exist", { headers: { cookie } }),
      Promise.all(staffPaths.map((path) => SELF.fetch(`https://portal.test${path}`))),
      SELF.fetch("https://portal.test/d"),
      SELF.fetch("https://portal.test/d/"),
      SELF.fetch("https://portal.test/d/token"),
      SELF.fetch("https://portal.test/d", { method: "POST" }),
    ]);
    for (const response of [apiRoot, mediaRoot, sourceRoot, api, media, deliveryRoot, deliverySlash, deliveryToken, deliveryPost]) expect(response.status).toBe(404);
    expect(apiRoot.headers.get("content-type")).toContain("application/json");
    expect(mediaRoot.headers.get("content-type")).toContain("application/json");
    for (const staffResponse of staffResponses) {
      expect(staffResponse.status).toBe(200);
      expect(staffResponse.headers.get("content-type")).toContain("text/html");
    }
  });

  it("allows only canonical staff callbacks through the actual Better Auth sign-in endpoint", async () => {
    const request = (callbackURL: string) => SELF.fetch("https://portal.test/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "google", callbackURL, disableRedirect: true }),
    });
    const allowed = await request(`/projects/${firstPhotographerId}/edit`);
    expect(allowed.status).toBe(200);
    const provider = new URL((await allowed.json() as { url: string }).url);
    expect(provider.searchParams.getAll("state")).toHaveLength(1);
    expect(provider.searchParams.get("state")).toBeTruthy();
    expect(provider.searchParams.get("code_challenge")).toBeTruthy();
    expect(provider.searchParams.get("code_challenge_method")).toBe("S256");
    for (const callbackURL of ["/api/projects", "/d/token", "/unknown", `${authEnv.APP_ORIGIN}/admin`]) {
      expect((await request(callbackURL)).status).toBe(400);
    }
  });

  it("serves signed transform sources for R2 keys with encoded filename characters", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Transform source", orderedServices: [] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const assetId = crypto.randomUUID(); const key = `projects/${project.id}/raw/${assetId}/se.CR527827_4 EV #20Jul.jpg`; const body = "spaced capture"; const now = Date.now();
    const media = env as unknown as { MEDIA: R2Bucket };
    await media.MEDIA.put(key, body);
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(assetId, raw!.id, key, "se.CR527827_4 EV #20Jul.jpg", body.length, "upload", now, now).run();

    // Primary config is production-shaped: assert the redirect itself instead of following
    // a Cloudflare Images URL in Miniflare.
    const rendition = await SELF.fetch(`https://portal.test/media/asset/${assetId}/thumb`, { headers: { cookie }, redirect: "manual" });
    expect(rendition.status).toBe(302);
    expect(rendition.headers.get("location")).toContain("/cdn-cgi/image/");
    const expiresAt = Math.floor(Date.now() / 1000) + 120;
    const sig = await signTransformSource(env as unknown as Parameters<typeof signTransformSource>[0], key, expiresAt, seedAdminId, 0);
    const encodedPath = "/__transform-source/" + key.split("/").map(encodeURIComponent).join("/");
    expect(encodedPath).toContain(encodeURIComponent("se.CR527827_4 EV #20Jul.jpg"));
    const source = await SELF.fetch(`https://portal.test${encodedPath}?v=v2&exp=${expiresAt}&p=${seedAdminId}&ae=0&sig=${sig}`);
    expect(source.status).toBe(200); await expect(source.text()).resolves.toBe(body);
    expect(source.headers.get("cache-control")).toBe("private, no-store");
    expect((await SELF.fetch(`https://portal.test${encodedPath}?exp=${expiresAt}&p=${seedAdminId}&ae=0&sig=tampered`)).status).toBe(404);
    expect((await SELF.fetch(`https://portal.test${encodedPath}?v=v-tampered&exp=${expiresAt}&p=${seedAdminId}&ae=0&sig=${sig}`)).status).toBe(404);
    expect((await SELF.fetch(`https://portal.test${encodedPath}?v=v2&exp=${expiresAt}&p=${seedAdminId}&ae=0&sig=${sig}&extra=1`)).status).toBe(404);
    expect((await SELF.fetch("https://portal.test/__transform-source/bad%ZZ?exp=1&sig=tampered")).status).toBe(404);
  });

  it("rejects replay of an internal transform URL after the principal epoch changes", async () => {
    const principalId = crypto.randomUUID();
    const key = `projects/epoch-replay/${principalId}/source.jpg`;
    const now = Date.now();
    const media = env as unknown as { MEDIA: R2Bucket };
    await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Transform principal', ?, 1, 'editor', 1, 0, ?, ?)")
      .bind(principalId, `${principalId}@example.test`, now, now).run();
    await media.MEDIA.put(key, "epoch-bound-source", { httpMetadata: { contentType: "image/jpeg" } });
    const expiresAt = Math.floor(now / 1000) + 120;
    const signature = await signTransformSource(authEnv as unknown as Parameters<typeof signTransformSource>[0], key, expiresAt, principalId, 0);
    const encodedPath = "/__transform-source/" + key.split("/").map(encodeURIComponent).join("/");
    const valid = await SELF.fetch(`https://portal.test${encodedPath}?v=v2&exp=${expiresAt}&p=${principalId}&ae=0&sig=${signature}`);
    expect(valid.status).toBe(200);
    await database.DB.prepare("UPDATE user SET role = 'external_editor', authorization_epoch = 1 WHERE id = ?").bind(principalId).run();
    const replay = await SELF.fetch(`https://portal.test${encodedPath}?v=v2&exp=${expiresAt}&p=${principalId}&ae=0&sig=${signature}`);
    expect(replay.status).toBe(404);
  });

  it("builds the production live-transform redirect with encoded source, cache version, and expiry", () => {
    const key = "projects/a raw/asset/space #?.jpg";
    const location = liveTransformLocation("https://portal.test/media/asset/x/thumb", key, "thumb", { expiresAt: 1_800_000_300, signature: "a".repeat(64), principalId: seedAdminId, authorizationEpoch: 0 });
    expect(location).toContain("width=640,height=640,fit=scale-down,quality=75,format=auto/");
    expect(location).toContain("__transform-source/projects/a%20raw/asset/space%20%23%3F.jpg");
    expect(location).toContain(`?v=v2&exp=1800000300&p=${seedAdminId}&ae=0&sig=`);
  });

  it("serves only an authorized current stored rendition and falls back when it is stale or absent", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Rendition cache", orderedServices: [] }),
    });
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const assetId = crypto.randomUUID(); const sourceKey = `projects/${project.id}/raw/${assetId}/source.jpg`; const renditionKey = `renditions/${assetId}/content/${RENDITION_SPEC_VERSION}/thumb.webp`; const now = Date.now();
    const media = env as unknown as { MEDIA: R2Bucket };
    await media.MEDIA.put(sourceKey, "original-kept", { httpMetadata: { contentType: "image/jpeg" } }); await media.MEDIA.put(renditionKey, "stored-webp", { httpMetadata: { contentType: "image/webp" } });
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(assetId, raw!.id, sourceKey, "source.jpg", 13, "upload", now, now).run();
    await database.DB.prepare("INSERT INTO asset_renditions (id, asset_id, variant, r2_key, bytes, content_type, width, height, spec_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), assetId, "thumb", renditionKey, 11, "image/webp", 1, 1, RENDITION_SPEC_VERSION, now).run();
    const cached = await SELF.fetch(`https://portal.test/media/asset/${assetId}/thumb`, { headers: { cookie } });
    expect(cached.status).toBe(200); expect(cached.headers.get("content-type")).toBe("image/webp"); expect(cached.headers.get("cache-control")).toBe("private, no-store"); await expect(cached.text()).resolves.toBe("stored-webp");
    expect(await media.MEDIA.get(sourceKey)).not.toBeNull();
    const jpegRenditionKey = `renditions/${assetId}/content/${RENDITION_SPEC_VERSION}/web.jpg`;
    await media.MEDIA.put(jpegRenditionKey, "stored-jpeg", { httpMetadata: { contentType: "image/jpeg" } });
    await database.DB.prepare("INSERT INTO asset_renditions (id, asset_id, variant, r2_key, bytes, content_type, width, height, spec_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), assetId, "web", jpegRenditionKey, 11, "image/jpeg", null, null, RENDITION_SPEC_VERSION, now).run();
    const cachedJpeg = await SELF.fetch(`https://portal.test/media/asset/${assetId}/web`, { headers: { cookie } });
    expect(cachedJpeg.status).toBe(200); expect(cachedJpeg.headers.get("content-type")).toBe("image/jpeg"); expect(cachedJpeg.headers.get("cache-control")).toBe("private, no-store"); await expect(cachedJpeg.text()).resolves.toBe("stored-jpeg");
    const forbidden = await SELF.fetch(`https://portal.test/media/asset/${assetId}/thumb`, { headers: { cookie: await sessionCookie(photographerToken) } });
    expect(forbidden.status).toBe(403);
    await database.DB.prepare("UPDATE asset_renditions SET spec_version = 'old' WHERE asset_id = ?").bind(assetId).run();
    const stale = await SELF.fetch(`https://portal.test/media/asset/${assetId}/thumb`, { headers: { cookie }, redirect: "manual" });
    expect(stale.status).toBe(302); expect(stale.headers.get("cache-control")).toBe("private, no-store"); expect(stale.headers.get("location")).toContain("/cdn-cgi/image/");
    await database.DB.prepare("UPDATE asset_renditions SET spec_version = ? WHERE asset_id = ?").bind(RENDITION_SPEC_VERSION, assetId).run(); await media.MEDIA.delete(renditionKey);
    const missing = await SELF.fetch(`https://portal.test/media/asset/${assetId}/thumb`, { headers: { cookie }, redirect: "manual" });
    expect(missing.status).toBe(302); expect(missing.headers.get("cache-control")).toBe("private, no-store"); expect(missing.headers.get("location")).toContain("/cdn-cgi/image/");
    await media.MEDIA.put(renditionKey, "wrong-r2-type", { httpMetadata: { contentType: "text/plain" } });
    const wrongR2Type = await SELF.fetch(`https://portal.test/media/asset/${assetId}/thumb`, { headers: { cookie }, redirect: "manual" });
    expect(wrongR2Type.status).toBe(302); expect(wrongR2Type.headers.get("cache-control")).toBe("private, no-store"); expect(wrongR2Type.headers.get("location")).toContain("/cdn-cgi/image/");
    await media.MEDIA.delete(renditionKey);
    await database.DB.prepare("UPDATE asset_renditions SET content_type = 'text/plain' WHERE asset_id = ?").bind(assetId).run();
    const wrongRowType = await SELF.fetch(`https://portal.test/media/asset/${assetId}/thumb`, { headers: { cookie }, redirect: "manual" });
    expect(wrongRowType.status).toBe(302); expect(wrongRowType.headers.get("cache-control")).toBe("private, no-store"); expect(wrongRowType.headers.get("location")).toContain("/cdn-cgi/image/");
    await media.MEDIA.delete(sourceKey);
    const missingOriginal = await SELF.fetch(`https://portal.test/media/asset/${assetId}/thumb`, { headers: { cookie }, redirect: "manual" });
    expect(missingOriginal.status).toBe(404);
  });

  it("does not expose delivery links to an assigned photographer", async () => {
    const { projectId } = await createEditableAnnotation([{ points: [{ x: 0.1, y: 0.1 }], color: "#000", width: 2 }]);
    const response = await SELF.fetch(`https://portal.test/api/projects/${projectId}/links?collection=video`, {
      headers: { cookie: await sessionCookie(firstPhotographerToken) },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ capability: "viewEdited" });
  });

  it("implicitly links a verified Google identity to the pre-provisioned admin", async () => {
    const auth = createAuth({
      ...authEnv,
      GOOGLE_CLIENT_ID: "test-google-client",
      GOOGLE_CLIENT_SECRET: "test-google-secret",
    });
    const context = await auth.$context;
    const result = await handleOAuthUserInfo({ context } as Parameters<typeof handleOAuthUserInfo>[0], {
      userInfo: {
        id: "google-admin-subject",
        name: "Quincy Admin",
        email: "mjj2332@gmail.com",
        emailVerified: true,
        image: null,
      },
      account: {
        providerId: "google",
        accountId: "google-admin-subject",
        accessToken: "test-access-token",
      },
      callbackURL: "/",
      disableSignUp: true,
    });

    expect(result.error).toBeNull();
    expect(result.data?.user.id).toBe(seedAdminId);
    expect(result.data?.session.userId).toBe(seedAdminId);
    const users = await database.DB.prepare("SELECT id FROM user WHERE email = ?").bind("mjj2332@gmail.com").all();
    const accounts = await database.DB.prepare("SELECT provider_id, account_id, user_id FROM account WHERE user_id = ?").bind(seedAdminId).all();
    expect(users.results).toHaveLength(1);
    expect(accounts.results).toEqual([expect.objectContaining({ provider_id: "google", account_id: "google-admin-subject", user_id: seedAdminId })]);
  });

  it("does not create an unknown Google user when signup is disabled", async () => {
    const auth = createAuth({
      ...authEnv,
      GOOGLE_CLIENT_ID: "test-google-client",
      GOOGLE_CLIENT_SECRET: "test-google-secret",
    });
    const context = await auth.$context;
    const result = await handleOAuthUserInfo({ context } as Parameters<typeof handleOAuthUserInfo>[0], {
      userInfo: {
        id: "unknown-google-subject",
        name: "Unknown User",
        email: "unknown@example.test",
        emailVerified: true,
        image: null,
      },
      account: { providerId: "google", accountId: "unknown-google-subject" },
      callbackURL: "/",
      disableSignUp: true,
    });

    expect(result).toMatchObject({ error: "signup disabled", data: null, isRegister: false });
    const unknown = await database.DB.prepare("SELECT id FROM user WHERE email = ?").bind("unknown@example.test").all();
    expect(unknown.results).toHaveLength(0);
  });

  it("rejects session creation for an inactive pre-provisioned user", async () => {
    const now = Date.now();
    await database.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind("inactive-user", "Inactive User", "inactive@example.test", 0, "editor", 0, now, now).run();
    const auth = createAuth({
      ...authEnv,
      GOOGLE_CLIENT_ID: "test-google-client",
      GOOGLE_CLIENT_SECRET: "test-google-secret",
    });
    const context = await auth.$context;
    await expect(handleOAuthUserInfo({ context } as Parameters<typeof handleOAuthUserInfo>[0], {
      userInfo: {
        id: "inactive-google-subject",
        name: "Inactive User",
        email: "inactive@example.test",
        emailVerified: true,
        image: null,
      },
      account: { providerId: "google", accountId: "inactive-google-subject" },
      callbackURL: "/",
      disableSignUp: true,
    })).rejects.toMatchObject({ message: "This staff account is inactive." });

    const sessions = await database.DB.prepare("SELECT id FROM session WHERE user_id = ?").bind("inactive-user").all();
    expect(sessions.results).toHaveLength(0);
  });

  it("keeps the project-activity system sentinel out of users and rejects it in provisioning", async () => {
    expect(await database.DB.prepare("SELECT id FROM user WHERE id = ?").bind(PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID).first()).toBeNull();
    const randomUuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID as ReturnType<typeof crypto.randomUUID>);
    try {
      const response = await SELF.fetch("https://portal.test/api/users", {
        method: "POST",
        headers: { cookie: await sessionCookie(adminToken), "content-type": "application/json" },
        body: JSON.stringify({ email: `sentinel-${crypto.randomUUID()}@example.test`, name: "Reserved sentinel", role: "editor" }),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "Reserved user identifier" });
    } finally {
      randomUuid.mockRestore();
    }
    expect(await database.DB.prepare("SELECT id FROM user WHERE id = ?").bind(PROJECT_ACTIVITY_SYSTEM_OUTBOX_ACTOR_ID).first()).toBeNull();
  });

  it("adds service collections while PATCH remains roster-free", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        street: "12 Kings Road",
        orderedServices: ["edited"],
        photographerUserIds: [firstPhotographerId],
        editorUserIds: [editorId],
      }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string; collections: Array<{ kind: string }> };
    expect(project.collections.map((collection) => collection.kind).sort()).toEqual(["edited", "raw"]);

    const beforeNoOp = await Promise.all([
      database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'project.update' AND target_id = ?").bind(project.id).first(),
      database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ?").bind(project.id).first(),
      database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(project.id).first(),
    ]);
    const unchanged = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ street: "12 Kings Road", orderedServices: ["edited"] }),
    });
    expect(unchanged.status).toBe(200);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'project.update' AND target_id = ?").bind(project.id).first()).toEqual(beforeNoOp[0]);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ?").bind(project.id).first()).toEqual(beforeNoOp[1]);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(project.id).first()).toEqual(beforeNoOp[2]);

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderedServices: ["edited", "video"] }),
    });
    expect(response.status).toBe(200);
    const updated = await response.json() as { collections: Array<{ kind: string }>; members: Array<{ userId: string; roleOnProject: string }> };
    expect(updated.collections).toHaveLength(project.collections.length + 1);
    expect(updated.collections.map((collection) => collection.kind).sort()).toEqual(["edited", "raw", "video"]);
    expect(updated.members.filter((member) => member.roleOnProject === "photographer").map((member) => member.userId)).toEqual([firstPhotographerId]);
    expect(updated.members.filter((member) => member.roleOnProject === "editor").map((member) => member.userId)).toEqual([editorId]);
    const beforeServiceRetry = await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ?").bind(project.id).first();
    const serviceRetry = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ orderedServices: ["edited", "video"] }) });
    expect(serviceRetry.status).toBe(200);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ?").bind(project.id).first()).toEqual(beforeServiceRetry);
    const rosterPatch = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ photographerUserIds: [secondPhotographerId] }),
    });
    expect(rosterPatch.status).toBe(400);
  });

  it("accepts the migrated UUID in photographer and editor membership inputs", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ street: "UUID membership seed", orderedServices: [], photographerUserIds: [seedAdminId] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string; members: Array<{ userId: string; roleOnProject: string }> };
    expect(project.members).toContainEqual(expect.objectContaining({ userId: seedAdminId, roleOnProject: "photographer" }));

    const updated = await SELF.fetch(`https://portal.test/api/projects/${project.id}/editors/${seedAdminId}`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(updated.status).toBe(201);
    const body = await updated.json() as { outcome: string; membership: { userId: string; roleOnProject: string } };
    expect(body).toMatchObject({ outcome: "created", membership: { userId: seedAdminId, roleOnProject: "editor" } });
    const detail = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { headers: { cookie } });
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as { members: Array<{ userId: string; roleOnProject: string }> };
    expect(detailBody.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: seedAdminId, roleOnProject: "photographer" }),
      expect.objectContaining({ userId: seedAdminId, roleOnProject: "editor" }),
    ]));
  });

  it("emits assignment outbox occurrences only for eligible Create slots", async () => {
    const cookie = await sessionCookie(adminToken);
    const inactiveId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Inactive assignee', ?, 1, 'editor', 0, ?, ?)")
      .bind(inactiveId, `${inactiveId}@example.test`, now, now).run();
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ street: "Assignment outbox", orderedServices: [], photographerUserIds: [firstPhotographerId, editorId], editorUserIds: [editorId] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    expect((await database.DB.prepare("SELECT id FROM project_members WHERE project_id = ?").bind(project.id).all()).results).toHaveLength(3);
    expect((await database.DB.prepare("SELECT id FROM audit_log WHERE action = 'project.member.add' AND target_id IN (SELECT id FROM project_members WHERE project_id = ?)").bind(project.id).all()).results).toHaveLength(3);
    expect((await database.DB.prepare("SELECT id FROM notification_outbox WHERE project_id = ? AND event_type = 'project.assignment.created'").bind(project.id).all()).results).toHaveLength(3);
    expect((await database.DB.prepare("SELECT id FROM notification_delivery_ledger WHERE event_type = 'project.assignment.created' AND source_key IN (SELECT id FROM project_members WHERE project_id = ?)").bind(project.id).all()).results).toHaveLength(6);
    expect((await database.DB.prepare("SELECT id FROM notifications WHERE project_id = ? AND type = 'assigned_to_project'").bind(project.id).all()).results).toHaveLength(0);

    const rejected = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ street: "Rejected assignment outbox", orderedServices: [], photographerUserIds: [inactiveId] }),
    });
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({ code: "ineligible_project_assignments", ineligibleSlots: [{ userId: inactiveId, roleOnProject: "photographer" }] });
    expect(await database.DB.prepare("SELECT id FROM projects WHERE street = 'Rejected assignment outbox'").first()).toBeNull();
  });

  it("proves the initial-roster broad suppression matrix and post-create assignment fan-out", async () => {
    const cookie = await sessionCookie(adminToken);
    const create = async (body: Record<string, unknown>) => {
      const response = await SELF.fetch("https://portal.test/api/projects", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ street: `Initial roster ${crypto.randomUUID()}`, orderedServices: [], ...body }),
      });
      expect(response.status).toBe(201);
      return await response.json() as { id: string };
    };

    // Editor A and Editor C are eligible Editors; Photographer B is a separate,
    // photographer-only user. The photographer activity reaches both Editors, then
    // each Editor's own activity is suppressed only for that Editor: 2 + 1 + 1 = 4.
    const threeSlot = await create({ photographerUserIds: [firstPhotographerId], editorUserIds: [editorId, seedAdminId] });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ? AND event_type = 'project.team.member_added'").bind(threeSlot.id).first()).toEqual({ count: 3 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ? AND event_type = 'project.assignment.created'").bind(threeSlot.id).first()).toEqual({ count: 3 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ? AND event_type = 'project.activity.broad'").bind(threeSlot.id).first()).toEqual({ count: 4 });
    expect(await database.DB.prepare("SELECT recipient_id, count(*) AS count FROM notification_outbox WHERE project_id = ? AND event_type = 'project.activity.broad' GROUP BY recipient_id ORDER BY recipient_id").bind(threeSlot.id).all()).toMatchObject({ results: [{ recipient_id: editorId, count: 2 }, { recipient_id: seedAdminId, count: 2 }] });

    // Editor A is also assigned in the Photographer slot. User-ID suppression
    // removes both of A's own roster rows, while C still receives both and A receives C's.
    const dualRole = await create({ photographerUserIds: [editorId], editorUserIds: [editorId, seedAdminId] });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ? AND event_type = 'project.activity.broad'").bind(dualRole.id).first()).toEqual({ count: 3 });
    expect(await database.DB.prepare("SELECT recipient_id, count(*) AS count FROM notification_outbox WHERE project_id = ? AND event_type = 'project.activity.broad' GROUP BY recipient_id ORDER BY recipient_id").bind(dualRole.id).all()).toMatchObject({ results: [{ recipient_id: editorId, count: 1 }, { recipient_id: seedAdminId, count: 2 }] });

    const oneEditor = await create({ editorUserIds: [editorId] });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ? AND event_type = 'project.team.member_added'").bind(oneEditor.id).first()).toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ? AND event_type = 'project.activity.broad'").bind(oneEditor.id).first()).toEqual({ count: 0 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ? AND event_type = 'project.assignment.created'").bind(oneEditor.id).first()).toEqual({ count: 1 });

    const postCreate = await create({ editorUserIds: [editorId] });
    const added = await SELF.fetch(`https://portal.test/api/projects/${postCreate.id}/editors/${seedAdminId}`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    expect(added.status).toBe(201);
    const addedMembership = (await added.json() as { membership: { id: string } }).membership.id;
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ? AND event_type = 'project.assignment.created' AND recipient_id = ? AND source_key = ?").bind(postCreate.id, seedAdminId, addedMembership).first()).toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT recipient_id FROM notification_outbox WHERE project_id = ? AND event_type = 'project.activity.broad' ORDER BY recipient_id").bind(postCreate.id).all()).toMatchObject({ results: [{ recipient_id: editorId }] });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ? AND event_type = 'project.activity.broad' AND recipient_id = ?").bind(postCreate.id, seedAdminId).first()).toEqual({ count: 0 });
  });

  it("gates assignment candidates and returns only the collaboration-safe summary projection", async () => {
    const photographerCookie = await sessionCookie(photographerToken);
    const candidateForbidden = await jsonRequest("/api/project-assignment-candidates", photographerCookie, "GET");
    expect(candidateForbidden.status).toBe(403);
    await expect(candidateForbidden.json()).resolves.toEqual({ error: "Forbidden", capability: "editProject" });

    const inactiveId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Candidate inactive', ?, 1, 'editor', 0, ?, ?)")
      .bind(inactiveId, `${inactiveId}@example.test`, now, now).run();
    const stableIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const stableEmails = ["z-stable@example.test", "a-stable-1@example.test", "a-stable-2@example.test"];
    await database.DB.batch(stableIds.map((id, index) => database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, 'editor', 1, ?, ?)")
      .bind(id, "Stable Candidate", stableEmails[index], now, now)));
    const candidateResponse = await jsonRequest("/api/project-assignment-candidates", await sessionCookie(adminToken), "GET");
    expect(candidateResponse.status).toBe(200);
    const candidates = await candidateResponse.json() as { photographers: Array<Record<string, unknown>>; editors: Array<Record<string, unknown>> };
    expect(Object.keys(candidates).sort()).toEqual(["editors", "photographers"]);
    for (const list of [candidates.photographers, candidates.editors]) {
      for (const candidate of list) {
        expect(Object.keys(candidate).sort()).toEqual(["active", "email", "globalRole", "id", "name"]);
        expect(candidate.active).toBe(true);
      }
    }
    expect(candidates.photographers.map((candidate) => candidate.id)).toContain(editorId);
    expect(candidates.editors.map((candidate) => candidate.id)).toContain(editorId);
    expect(candidates.editors.map((candidate) => candidate.id)).not.toContain(firstPhotographerId);
    expect(candidates.photographers.map((candidate) => candidate.id)).not.toContain(inactiveId);
    const compareCandidates = (left: Record<string, unknown>, right: Record<string, unknown>) => {
      for (const field of ["name", "email", "id"] as const) {
        const leftValue = String(left[field]).toLowerCase(); const rightValue = String(right[field]).toLowerCase();
        if (leftValue < rightValue) return -1;
        if (leftValue > rightValue) return 1;
      }
      return 0;
    };
    for (const list of [candidates.photographers, candidates.editors]) {
      expect(list).toEqual([...list].sort(compareCandidates));
      expect(list.filter((candidate) => stableIds.includes(String(candidate.id))).map((candidate) => candidate.id))
        .toEqual([...list].filter((candidate) => stableIds.includes(String(candidate.id))).sort(compareCandidates).map((candidate) => candidate.id));
    }

    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie: await sessionCookie(adminToken), "content-type": "application/json" },
      body: JSON.stringify({
        street: `Collaboration-safe summary ${crypto.randomUUID()}`, suburb: "Withheld suburb", postcode: "99999",
        agencyName: "Withheld Agency", agentName: "Withheld Agent", agentEmail: "agent@withheld.test", agentPhone: "+60 1111",
        shootDate: "2026-08-30", timeWindow: "09:00-10:00", orderNo: "ORDER-1", orderId: "ORDER-ID-1", invoiceAmount: 123,
        paymentStatus: "unpaid", notes: "Withheld notes", rawFolderLink: "https://dropbox.test/private", rawFolderPath: "/private",
        orderedServices: ["edited"], photographerUserIds: [firstPhotographerId], editorUserIds: [editorId],
      }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const authorized = await jsonRequest(`/api/projects/${project.id}/collaboration-summary`, await sessionCookie(firstPhotographerToken), "GET");
    expect(authorized.status).toBe(200);
    const summary = await authorized.json() as { project: Record<string, unknown>; members: Array<Record<string, unknown>> };
    expect(Object.keys(summary).sort()).toEqual(["members", "project"]);
    expect(Object.keys(summary.project).sort()).toEqual(["id", "stageKey", "street"]);
    expect(summary.project).toMatchObject({ id: project.id, street: expect.stringContaining("Collaboration-safe summary") });
    expect(summary.members).toHaveLength(2);
    for (const member of summary.members) expect(Object.keys(member).sort()).toEqual(["active", "id", "name", "roleOnProject", "userId"]);
    for (const forbidden of ["email", "suburb", "postcode", "shootDate", "timeWindow", "agencyName", "agentName", "agentEmail", "agentPhone", "invoiceAmount", "paymentStatus", "orderNo", "orderId", "notes", "rawFolderLink", "rawFolderPath", "collections", "assets", "assignedSubtaskCount", "mutationCandidates"]) {
      expect(Object.keys(summary.project)).not.toContain(forbidden);
      expect(summary.members.flatMap((member) => Object.keys(member))).not.toContain(forbidden);
    }

    const existingDenied = await jsonRequest(`/api/projects/${project.id}/collaboration-summary`, photographerCookie, "GET");
    const missingDenied = await jsonRequest(`/api/projects/${crypto.randomUUID()}/collaboration-summary`, photographerCookie, "GET");
    expect(existingDenied.status).toBe(403); expect(missingDenied.status).toBe(403);
    expect(await existingDenied.json()).toEqual(await missingDenied.json());
    const adminMissing = await jsonRequest(`/api/projects/${crypto.randomUUID()}/collaboration-summary`, await sessionCookie(adminToken), "GET");
    expect(adminMissing.status).toBe(404);
    expect((await jsonRequest(`/api/projects/${project.id}/collaboration-summary`, "", "GET")).status).toBe(401);
  });

  it("rolls back Create when eligibility drifts before its conditional batch executes", async () => {
    const cookie = await sessionCookie(adminToken); const userId = crypto.randomUUID(); const now = Date.now();
    const street = `Create eligibility race ${crypto.randomUUID()}`;
    await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Create race target', ?, 1, 'editor', 1, ?, ?)")
      .bind(userId, `${userId}@example.test`, now, now).run();
    try {
      const response = await requestWithDbBatchFault("/api/projects", cookie, { street, orderedServices: ["edited"], photographerUserIds: [userId] }, async () => {
        await database.DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(userId).run();
      }, "POST");
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ code: "ineligible_project_assignments", ineligibleSlots: [{ userId, roleOnProject: "photographer" }] });
      const project = await database.DB.prepare("SELECT id FROM projects WHERE street = ?").bind(street).first();
      expect(project).toBeNull();
      expect((await database.DB.prepare("SELECT count(*) AS count FROM collections WHERE project_id IN (SELECT id FROM projects WHERE street = ?)").bind(street).first<{ count: number }>())!.count).toBe(0);
      expect((await database.DB.prepare("SELECT count(*) AS count FROM project_members WHERE project_id IN (SELECT id FROM projects WHERE street = ?)").bind(street).first<{ count: number }>())!.count).toBe(0);
      // A bound `street` LIKE pattern can exceed D1/SQLite's default 50-byte LIKE-pattern
      // length limit ("LIKE or GLOB pattern too complex"); the fixed-length userId UUID stays
      // well under it and is what a real orphaned project.member.add audit row would reference.
      expect((await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id IN (SELECT id FROM projects WHERE street = ?) OR meta_json LIKE ?").bind(street, `%${userId}%`).first<{ count: number }>())!.count).toBe(0);
      expect((await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id IN (SELECT id FROM projects WHERE street = ?)").bind(street).first<{ count: number }>())!.count).toBe(0);
      expect((await database.DB.prepare("SELECT count(*) AS count FROM notification_delivery_ledger WHERE outbox_id IN (SELECT id FROM notification_outbox WHERE project_id IN (SELECT id FROM projects WHERE street = ?))").bind(street).first<{ count: number }>())!.count).toBe(0);
    } finally {
      await database.DB.prepare("UPDATE user SET active = 1 WHERE id = ?").bind(userId).run();
    }
  });

  it("rolls back every statement-level failure point in the Create assignment batch", async () => {
    const points = [
      { name: "diagnostic", diagnostic: true },
      { name: "project", diagnostic: false, table: "projects", when: "" },
      { name: "collection-raw", diagnostic: false, table: "collections", when: "WHEN NEW.kind = 'raw'" },
      { name: "collection-edited", diagnostic: false, table: "collections", when: "WHEN NEW.kind = 'edited'" },
      { name: "collection-video", diagnostic: false, table: "collections", when: "WHEN NEW.kind = 'video'" },
      { name: "membership", diagnostic: false, table: "project_members", when: "" },
      { name: "member-audit", diagnostic: false, table: "audit_log", when: "WHEN NEW.action = 'project.member.add'" },
      { name: "outbox", diagnostic: false, table: "notification_outbox", when: "WHEN NEW.event_type = 'project.assignment.created'" },
      { name: "in-app-ledger", diagnostic: false, table: "notification_delivery_ledger", when: "WHEN NEW.channel = 'in_app'" },
      { name: "email-ledger", diagnostic: false, table: "notification_delivery_ledger", when: "WHEN NEW.channel = 'email'" },
      { name: "project-audit", diagnostic: false, table: "audit_log", when: "WHEN NEW.action = 'project.create'" },
    ];
    const cookie = await sessionCookie(adminToken);
    const countRows = async () => {
      const [projects, collections, members, audits, outbox, ledger] = await Promise.all([
        database.DB.prepare("SELECT count(*) AS count FROM projects").first<{ count: number }>(),
        database.DB.prepare("SELECT count(*) AS count FROM collections").first<{ count: number }>(),
        database.DB.prepare("SELECT count(*) AS count FROM project_members").first<{ count: number }>(),
        database.DB.prepare("SELECT count(*) AS count FROM audit_log").first<{ count: number }>(),
        database.DB.prepare("SELECT count(*) AS count FROM notification_outbox").first<{ count: number }>(),
        database.DB.prepare("SELECT count(*) AS count FROM notification_delivery_ledger").first<{ count: number }>(),
      ]);
      return { projects: projects!.count, collections: collections!.count, members: members!.count, audits: audits!.count, outbox: outbox!.count, ledger: ledger!.count };
    };

    for (const point of points) {
      const street = `Create fault ${point.name} ${crypto.randomUUID()}`;
      const before = await countRows();
      const trigger = `tb4_create_fault_${point.name.replaceAll("-", "_")}`;
      if (!point.diagnostic) await database.DB.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${point.table} ${point.when} BEGIN SELECT RAISE(ABORT, 'forced Create fault'); END`);
      try {
        const response = point.diagnostic
          ? await requestWithPreparedStatementFault("/api/projects", cookie, { street, orderedServices: ["edited", "video"], photographerUserIds: [editorId] }, (sql) => sql.includes("SELECT ? AS userId"), "POST")
          : await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street, orderedServices: ["edited", "video"], photographerUserIds: [editorId] }) });
        expect(response.status, point.name).toBe(500);
      } finally {
        if (!point.diagnostic) await database.DB.exec(`DROP TRIGGER ${trigger}`);
      }
      expect(await countRows(), point.name).toEqual(before);
      expect(await database.DB.prepare("SELECT id FROM projects WHERE street = ?").bind(street).first(), point.name).toBeNull();
    }
  });

  it("rolls back every statement-level failure point in the PUT assignment batch", async () => {
    const points = [
      { name: "diagnostic", diagnostic: true },
      { name: "membership", diagnostic: false, table: "project_members", when: "" },
      { name: "audit", diagnostic: false, table: "audit_log", when: "" },
      { name: "outbox", diagnostic: false, table: "notification_outbox", when: "" },
      { name: "in-app-ledger", diagnostic: false, table: "notification_delivery_ledger", when: "WHEN NEW.channel = 'in_app'" },
      { name: "email-ledger", diagnostic: false, table: "notification_delivery_ledger", when: "WHEN NEW.channel = 'email'" },
    ];
    const cookie = await sessionCookie(adminToken);
    for (const point of points) {
      const projectId = crypto.randomUUID(); const userId = crypto.randomUUID(); const now = Date.now(); const trigger = `tb4_put_fault_${point.name.replaceAll("-", "_")}`;
      await database.DB.batch([
        database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'PUT fault target', ?, 1, 'editor', 1, ?, ?)").bind(userId, `${userId}@example.test`, now, now),
        database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?)").bind(projectId, `PUT fault ${point.name} ${projectId}`, now, now),
      ]);
      if (!point.diagnostic) await database.DB.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${point.table} ${point.when} BEGIN SELECT RAISE(ABORT, 'forced PUT fault'); END`);
      try {
        const response = point.diagnostic
          ? await requestWithPreparedStatementFault(`/api/projects/${projectId}/editors/${userId}`, cookie, {}, (sql) => sql.includes("targetUserId"), "PUT")
          : await SELF.fetch(`https://portal.test/api/projects/${projectId}/editors/${userId}`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: "{}" });
        expect(response.status, point.name).toBe(500);
      } finally {
        if (!point.diagnostic) await database.DB.exec(`DROP TRIGGER ${trigger}`);
      }
      expect((await database.DB.prepare("SELECT count(*) AS count FROM project_members WHERE project_id = ?").bind(projectId).first<{ count: number }>())!.count, point.name).toBe(0);
      expect((await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'project.member.add' AND meta_json LIKE ?").bind(`%${projectId}%`).first<{ count: number }>())!.count, point.name).toBe(0);
      expect((await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(projectId).first<{ count: number }>())!.count, point.name).toBe(0);
      expect((await database.DB.prepare("SELECT count(*) AS count FROM notification_delivery_ledger WHERE outbox_id IN (SELECT id FROM notification_outbox WHERE project_id = ?)").bind(projectId).first<{ count: number }>())!.count, point.name).toBe(0);
    }
  });

  it("returns database-confirmed membership inserts and one matching durable occurrence", async () => {
    const now = Date.now();
    const projectId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Contested target', ?, 1, 'editor', 1, ?, ?)").bind(userId, `${userId}@example.test`, now, now),
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Contested assignment', 'awaiting_raw', ?, ?)").bind(projectId, now, now),
    ]);
    const cookie = await sessionCookie(adminToken);
    const responses = await Promise.all([1, 2].map(() => SELF.fetch(`https://portal.test/api/projects/${projectId}/editors/${userId}`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: "{}" })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect((await database.DB.prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ? AND role_on_project = 'editor'").bind(projectId, userId).all()).results).toHaveLength(1);
    expect((await database.DB.prepare("SELECT id FROM audit_log WHERE action = 'project.member.add' AND target_id IN (SELECT id FROM project_members WHERE project_id = ?)").bind(projectId).all()).results).toHaveLength(1);
    expect((await database.DB.prepare("SELECT id FROM notification_outbox WHERE project_id = ? AND event_type = 'project.assignment.created'").bind(projectId).all()).results).toHaveLength(1);
    expect((await database.DB.prepare("SELECT id FROM notification_delivery_ledger WHERE event_type = 'project.assignment.created' AND source_key IN (SELECT id FROM project_members WHERE project_id = ?)").bind(projectId).all()).results).toHaveLength(2);
  });

  it("does not use a full-roster snapshot for concurrent exact-role PUTs", async () => {
    const now = Date.now();
    const projectId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Concurrent role membership', 'awaiting_raw', ?, ?)").bind(projectId, now, now).run();
    const cookie = await sessionCookie(adminToken);
    const responses = await Promise.all([firstPhotographerId, secondPhotographerId].map((userId) => SELF.fetch(`https://portal.test/api/projects/${projectId}/photographers/${userId}`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: "{}" })));
    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect((await database.DB.prepare("SELECT user_id FROM project_members WHERE project_id = ? AND role_on_project = 'photographer' ORDER BY user_id").bind(projectId).all<{ user_id: string }>()).results.map((row) => row.user_id)).toEqual([firstPhotographerId, secondPhotographerId].sort());
  });

  it("accepts an editor-role user in the photographer slot, and confirms their access is unaffected by that membership row", async () => {
    const adminCookie = await sessionCookie(adminToken);

    // (a) Data correctness: an editor-role user's id is accepted in photographerUserIds and
    // produces a project_members row tagged with the photographer slot for that user — not
    // silently rejected or coerced into the editor slot.
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ street: "Editor as photographer", orderedServices: [], photographerUserIds: [editorId] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string; members: Array<{ userId: string; roleOnProject: string }> };
    expect(project.members.filter((member) => member.roleOnProject === "photographer").map((member) => member.userId)).toEqual([editorId]);

    // (b) Access, kept as a separate assertion: an editor already has project access via
    // viewAllProjects regardless of any project_members row, not because of it — proven here
    // against a project the editor is NOT assigned to in either slot.
    const unassigned = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ street: "Editor not assigned", orderedServices: [] }),
    });
    expect(unassigned.status).toBe(201);
    const unassignedProject = await unassigned.json() as { id: string };
    const editorAccess = await SELF.fetch(`https://portal.test/api/projects/${unassignedProject.id}`, {
      headers: { cookie: await sessionCookie(editorToken) },
    });
    expect(editorAccess.status).toBe(200);
  });

  it("sets a project cover, reflects it in the project list, and can clear it", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Cover set and clear", orderedServices: [] }) });
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const assetId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(assetId, raw!.id, `tests/${assetId}.jpg`, "cover.jpg", 1024, "upload", now, now).run();

    const set = await SELF.fetch(`https://portal.test/api/projects/${project.id}/cover`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ assetId }) });
    expect(set.status).toBe(200); await expect(set.json()).resolves.toEqual({ coverAssetId: assetId });
    const listed = await SELF.fetch("https://portal.test/api/projects", { headers: { cookie } });
    expect((await listed.json() as { projects: Array<{ id: string; coverAssetId: string | null }> }).projects.find((item) => item.id === project.id)?.coverAssetId).toBe(assetId);

    const cleared = await SELF.fetch(`https://portal.test/api/projects/${project.id}/cover`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ assetId: null }) });
    expect(cleared.status).toBe(200); await expect(cleared.json()).resolves.toEqual({ coverAssetId: null });
  });

  it("rejects a cover asset from another project", async () => {
    const cookie = await sessionCookie(adminToken);
    const create = async (street: string) => SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street, orderedServices: [] }) });
    const target = await (await create("Cover target")).json() as { id: string };
    const source = await (await create("Cover source")).json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(source.id).first<{ id: string }>();
    const assetId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(assetId, raw!.id, `tests/${assetId}.jpg`, "other-project.jpg", 1024, "upload", now, now).run();

    const response = await SELF.fetch(`https://portal.test/api/projects/${target.id}/cover`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ assetId }) });
    expect(response.status).toBe(404); await expect(response.json()).resolves.toEqual({ error: "Asset not in this project" });
  });

  it("requires editProject to set a cover after confirming project access", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Photographer cover", orderedServices: [], photographerUserIds: [firstPhotographerId] }) });
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const assetId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(assetId, raw!.id, `tests/${assetId}.jpg`, "photographer-cover.jpg", 1024, "upload", now, now).run();

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}/cover`, { method: "POST", headers: { cookie: await sessionCookie(firstPhotographerToken), "content-type": "application/json" }, body: JSON.stringify({ assetId }) });
    expect(response.status).toBe(403); await expect(response.json()).resolves.toEqual({ error: "Forbidden", capability: "editProject" });
  });

  it("returns project assets in deterministic case-insensitive filename order", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Asset filename ordering", orderedServices: [] }) });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const rows = [
      ["ffffffff-ffff-4fff-8fff-ffffffffffff", "zebra.jpg", 1],
      ["00000000-0000-4000-8000-000000000002", "alpha.jpg", 2],
      ["00000000-0000-4000-8000-000000000001", "alpha.jpg", 3],
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Alpha.jpg", 4],
      ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Bravo.jpg", 5],
    ] as const;
    await database.DB.batch(rows.map(([id, filename, createdAt]) => database.DB.prepare(
      "INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, raw!.id, `tests/${id}.jpg`, filename, 1024, "upload", createdAt, createdAt)));

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}/assets?collection=raw`, { headers: { cookie } });
    expect(response.status).toBe(200);
    expect((await response.json() as { assets: Array<{ id: string; originalFilename: string }> }).assets.map(({ id, originalFilename }) => [originalFilename, id])).toEqual([
      ["Alpha.jpg", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      ["alpha.jpg", "00000000-0000-4000-8000-000000000001"],
      ["alpha.jpg", "00000000-0000-4000-8000-000000000002"],
      ["Bravo.jpg", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      ["zebra.jpg", "ffffffff-ffff-4fff-8fff-ffffffffffff"],
    ]);
  });

  it("uses the alphabetically first RAW asset as the automatic cover", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Automatic cover", orderedServices: [] }) });
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const laterId = crypto.randomUUID(); const firstId = crypto.randomUUID(); const now = Date.now();
    for (const [assetId, filename] of [[laterId, "zebra.jpg"], [firstId, "alpha.jpg"]]) await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(assetId, raw!.id, `tests/${assetId}.jpg`, filename, 1024, "upload", now, now).run();

    const response = await SELF.fetch("https://portal.test/api/projects", { headers: { cookie } });
    expect((await response.json() as { projects: Array<{ id: string; coverAssetId: string | null }> }).projects.find((item) => item.id === project.id)?.coverAssetId).toBe(firstId);
    const details = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { headers: { cookie } });
    expect((await details.json() as { effectiveCoverAssetId: string | null }).effectiveCoverAssetId).toBe(firstId);
  });

  it("chunks cover lookups when listing more than 100 projects", async () => {
    const now = Date.now();
    const projectIds = Array.from({ length: 110 }, () => crypto.randomUUID());
    await database.DB.batch(projectIds.map((id, index) => database.DB.prepare(
      "INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(id, `Chunked cover ${index}`, "awaiting_raw", now, now)));

    const response = await SELF.fetch("https://portal.test/api/projects", { headers: { cookie: await sessionCookie(adminToken) } });
    expect(response.status).toBe(200);
    const listed = new Map((await response.json() as { projects: Array<{ id: string; coverAssetId: string | null }> }).projects.map((project) => [project.id, project.coverAssetId]));
    expect(projectIds.map((id) => listed.get(id))).toEqual(Array<string | null>(110).fill(null));
  });

  it("uses a RAW fallback cover for photographers when an admin stores an edited cover", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Role-aware cover", orderedServices: ["edited"], photographerUserIds: [firstPhotographerId] }) });
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const edited = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'edited'").bind(project.id).first<{ id: string }>();
    const rawAssetId = crypto.randomUUID(); const editedAssetId = crypto.randomUUID(); const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(rawAssetId, raw!.id, `tests/${rawAssetId}.jpg`, "raw-cover.jpg", 1024, "upload", now, now),
      database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(editedAssetId, edited!.id, `tests/${editedAssetId}.jpg`, "edited-cover.jpg", 1024, "upload", now, now),
    ]);

    const set = await SELF.fetch(`https://portal.test/api/projects/${project.id}/cover`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ assetId: editedAssetId }) });
    expect(set.status).toBe(200);
    const [adminList, photographerList] = await Promise.all([
      SELF.fetch("https://portal.test/api/projects", { headers: { cookie: adminCookie } }),
      SELF.fetch("https://portal.test/api/projects", { headers: { cookie: await sessionCookie(firstPhotographerToken) } }),
    ]);
    expect((await adminList.json() as { projects: Array<{ id: string; coverAssetId: string | null }> }).projects.find((item) => item.id === project.id)?.coverAssetId).toBe(editedAssetId);
    expect((await photographerList.json() as { projects: Array<{ id: string; coverAssetId: string | null }> }).projects.find((item) => item.id === project.id)?.coverAssetId).toBe(rawAssetId);
  });

  it("removes an empty service collection when ordered services are de-selected", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ street: "Empty service removal", orderedServices: ["edited"] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderedServices: [] }),
    });
    expect(response.status).toBe(200);
    const edited = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'edited'").bind(project.id).first();
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first();
    expect(edited).toBeNull();
    expect(raw).not.toBeNull();
  });

  it("keeps a de-selected service collection when it contains an asset", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ street: "Protected service removal", orderedServices: ["edited"] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const edited = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'edited'").bind(project.id).first<{ id: string }>();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), edited!.id, `tests/${crypto.randomUUID()}.jpg`, "protected.jpg", 1024, "upload", now, now).run();

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderedServices: [] }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ blocked: [{ kind: "edited", assetCount: 1 }] });
    const remaining = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'edited'").bind(project.id).first();
    expect(remaining).not.toBeNull();
  });

  it("removes nothing when a mixed de-selection includes a protected service", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ street: "Mixed service removal", orderedServices: ["edited", "video"] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const edited = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'edited'").bind(project.id).first<{ id: string }>();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), edited!.id, `tests/${crypto.randomUUID()}.jpg`, "mixed-protected.jpg", 1024, "upload", now, now).run();

    // De-select BOTH: edited is protected (has an asset), video is empty. The pre-screen must
    // block the whole request with NO partial removal — video must survive.
    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderedServices: [] }),
    });
    expect(response.status).toBe(409);
    const payload = await response.json() as { blocked: Array<{ kind: string }>; removed?: string[] };
    expect(payload.blocked).toEqual([expect.objectContaining({ kind: "edited", assetCount: 1 })]);
    expect(payload.removed).toBeUndefined();
    const video = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'video'").bind(project.id).first();
    expect(video).not.toBeNull();
  });

  it("fences a service removal race before the project PATCH winner and leaves no downstream rows", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: `Service race ${crypto.randomUUID()}`, orderedServices: ["edited", "video"] }) });
    expect(created.status).toBe(201); const project = await created.json() as { id: string };
    const video = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'video'").bind(project.id).first<{ id: string }>();
    const assetId = crypto.randomUUID(); const now = Date.now();
    const beforeProject = await database.DB.prepare("SELECT street FROM projects WHERE id = ?").bind(project.id).first();
    const response = await requestWithDbBatchFault(`/api/projects/${project.id}`, cookie, { street: "Must not partially save", orderedServices: [] }, async (db) => {
      await db.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'race.jpg', 1, 'upload', ?, ?)").bind(assetId, video!.id, `tests/${assetId}.jpg`, now, now).run();
    });
    expect(response.status).toBe(409);
    expect(await database.DB.prepare("SELECT street FROM projects WHERE id = ?").bind(project.id).first()).toEqual(beforeProject);
    expect(await database.DB.prepare("SELECT kind FROM collections WHERE project_id = ? ORDER BY kind").bind(project.id).all()).toMatchObject({ results: [{ kind: "edited" }, { kind: "raw" }, { kind: "video" }] });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'project.update' AND target_id = ?").bind(project.id).first()).toEqual({ count: 0 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ?").bind(project.id).first()).toEqual({ count: 0 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(project.id).first()).toEqual({ count: 0 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_delivery_ledger WHERE outbox_id IN (SELECT id FROM notification_outbox WHERE project_id = ?)").bind(project.id).first()).toEqual({ count: 0 });
  });

  it("rejects a checklist delete after a concurrent rename without stale title activity", async () => {
    const cookie = await sessionCookie(adminToken);
    const project = await createUploadProject(cookie, `Checklist delete race ${crypto.randomUUID()}`);
    const created = await SELF.fetch(`https://portal.test/api/projects/${project.id}/subtasks`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ title: "Original checklist title" }) });
    expect(created.status).toBe(201); const task = await created.json() as { id: string };
    const beforeActivity = await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ?").bind(project.id).first();
    const response = await requestWithDbBatchFault(`/api/projects/${project.id}/subtasks/${task.id}`, cookie, undefined, async (db) => {
      await db.prepare("UPDATE project_subtasks SET title = ?, updated_at = ? WHERE id = ?").bind("Concurrent renamed title", Date.now(), task.id).run();
    }, "DELETE");
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "subtask_changed" });
    expect(await database.DB.prepare("SELECT title FROM project_subtasks WHERE id = ?").bind(task.id).first()).toEqual({ title: "Concurrent renamed title" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'project_subtask.delete' AND target_id = ?").bind(task.id).first()).toEqual({ count: 0 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ?").bind(project.id).first()).toEqual(beforeActivity);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(project.id).first()).toEqual({ count: 0 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_delivery_ledger WHERE outbox_id IN (SELECT id FROM notification_outbox WHERE project_id = ?)").bind(project.id).first()).toEqual({ count: 0 });
  });

  it("keeps a de-selected service collection with a pending upload manifest", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ street: "Manifest-protected service removal", orderedServices: ["edited"] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const edited = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'edited'").bind(project.id).first<{ id: string }>();
    await database.DB.prepare("INSERT INTO upload_manifests (id, collection_id, expected_count, filenames_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), edited!.id, 1, "[\"pending.jpg\"]", seedAdminId, Date.now()).run();

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderedServices: [] }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ blocked: [{ kind: "edited", manifestCount: 1 }] });
    const remaining = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'edited'").bind(project.id).first();
    expect(remaining).not.toBeNull();
  });

  it("allows an editor to move an assigned project backwards through the pipeline", async () => {
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie: await sessionCookie(adminToken), "content-type": "application/json" },
      body: JSON.stringify({ street: "Backward stage move", orderedServices: [], editorUserIds: [editorId] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    await database.DB.prepare("UPDATE projects SET stage_key = ? WHERE id = ?").bind("edited_review", project.id).run();

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}/stage`, {
      method: "POST",
      headers: { cookie: await sessionCookie(editorToken), "content-type": "application/json" },
      body: JSON.stringify({ stageKey: "raw_review" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ stageKey: "raw_review" });
    const stored = await database.DB.prepare("SELECT stage_key FROM projects WHERE id = ?").bind(project.id).first<{ stage_key: string }>();
    expect(stored).toEqual(expect.objectContaining({ stage_key: "raw_review" }));
  });

  it("streams selected RAW files as a ZIP for an assigned editor and rejects a member without the capability", async () => {
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie: await sessionCookie(adminToken), "content-type": "application/json" },
      body: JSON.stringify({ street: "14 Zip Street", orderedServices: [], photographerUserIds: [firstPhotographerId], editorUserIds: [editorId] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const media = env as unknown as { MEDIA: R2Bucket }; const now = Date.now();
    for (const [suffix, body] of [["one", "first RAW"], ["two", "second RAW"]] as const) {
      const assetId = crypto.randomUUID(); const key = `tests/${project.id}/${suffix}.jpg`;
      await media.MEDIA.put(key, body);
      await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(assetId, raw!.id, key, "capture.jpg", body.length, "upload", now, now).run();
      await database.DB.prepare("INSERT INTO selections (id, asset_id, selected_by, state, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), assetId, editorId, "selected_for_editing", now).run();
    }
    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}/selected-raw.zip`, { headers: { cookie: await sessionCookie(editorToken) } });
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("application/zip"); expect(new Uint8Array(await response.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const nonMember = await SELF.fetch(`https://portal.test/api/projects/${project.id}/selected-raw.zip`, { headers: { cookie: await sessionCookie(photographerToken) } });
    expect(nonMember.status).toBe(403);
    const forbidden = await SELF.fetch(`https://portal.test/api/projects/${project.id}/selected-raw.zip`, { headers: { cookie: await sessionCookie(firstPhotographerToken) } });
    expect(forbidden.status).toBe(403);
  });

  it("creates a revalidated ticket and streams exactly the selected RAW or Edited bytes", async () => {
    const adminCookie = await sessionCookie(adminToken); const editorCookie = await sessionCookie(editorToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ street: "Selection ticket street", orderedServices: ["edited"], photographerUserIds: [firstPhotographerId], editorUserIds: [editorId] }),
    });
    expect(created.status).toBe(201); const project = await created.json() as { id: string };
    const collections = await database.DB.prepare("SELECT id, kind FROM collections WHERE project_id = ?").bind(project.id).all<{ id: string; kind: string }>();
    const rawId = collections.results.find((row) => row.kind === "raw")!.id;
    const editedId = collections.results.find((row) => row.kind === "edited")!.id;
    const media = env as unknown as { MEDIA: R2Bucket }; const now = Date.now();
    const rawAssets: Array<{ id: string; body: string; name: string }> = [];
    for (const [name, body] of [["first.jpg", "first distinct RAW payload"], ["second.jpg", "second distinct RAW payload"]] as const) {
      const id = crypto.randomUUID(); const key = `tests/${project.id}/${id}`; rawAssets.push({ id, body, name }); await media.MEDIA.put(key, body);
      await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'upload', ?, ?)").bind(id, rawId, key, name, body.length, now, now).run();
    }
    const editedIdAsset = crypto.randomUUID(); const editedBody = "distinct final edited payload"; const editedKey = `tests/${project.id}/${editedIdAsset}`;
    await media.MEDIA.put(editedKey, editedBody);
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, publish_status, created_at, updated_at) VALUES (?, ?, ?, 'final.jpg', ?, 'upload', 'ready', ?, ?)").bind(editedIdAsset, editedId, editedKey, editedBody.length, now, now).run();
    const post = async (cookie: string, assetIds: string[]) => SELF.fetch(`https://portal.test/api/projects/${project.id}/download-selection`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ assetIds }) });

    const rawTicket = await post(editorCookie, rawAssets.map((asset) => asset.id));
    expect(rawTicket.status).toBe(201); const rawPayload = await rawTicket.json() as { downloadUrl: string };
    expect(rawPayload.downloadUrl).toMatch(new RegExp(`^/api/projects/${project.id}/download-selection/[0-9a-f-]{36}/archive\\.zip$`));
    const rawZip = await SELF.fetch(`https://portal.test${rawPayload.downloadUrl}`, { headers: { cookie: editorCookie } });
    expect(rawZip.status).toBe(200); expect(rawZip.headers.get("content-type")).toContain("application/zip"); expect(rawZip.headers.get("content-disposition")).toContain("selection-raw.zip");
    const rawBytes = new Uint8Array(await rawZip.arrayBuffer()); expect(rawBytes.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const rawText = new TextDecoder().decode(rawBytes); for (const asset of rawAssets) { expect(rawText).toContain(asset.name); expect(rawText).toContain(asset.body); }
    const audit = await database.DB.prepare("SELECT action, meta_json FROM audit_log WHERE target_id = ? AND action = 'project.download_selection' ORDER BY created_at DESC LIMIT 1").bind(project.id).first<{ action: string; meta_json: string }>();
    expect(audit?.action).toBe("project.download_selection"); expect(JSON.parse(audit!.meta_json)).toEqual(expect.objectContaining({ collection: "raw", count: 2, totalBytes: rawAssets.reduce((sum, asset) => sum + asset.body.length, 0), assetIds: rawAssets.map((asset) => asset.id) }));

    const editedTicket = await post(editorCookie, [editedIdAsset]); expect(editedTicket.status).toBe(201);
    const editedZip = await SELF.fetch(`https://portal.test${(await editedTicket.json() as { downloadUrl: string }).downloadUrl}`, { headers: { cookie: editorCookie } });
    expect(editedZip.status).toBe(200); expect(editedZip.headers.get("content-disposition")).toContain("selection-edited.zip"); expect(new TextDecoder().decode(await editedZip.arrayBuffer())).toContain(editedBody);

    expect((await post(await sessionCookie(photographerToken), [rawAssets[0]!.id])).status).toBe(403); // specifically unassigned photographer
    const photographerRaw = await post(await sessionCookie(firstPhotographerToken), [rawAssets[0]!.id]); expect(photographerRaw.status).toBe(403); await expect(photographerRaw.json()).resolves.toMatchObject({ capability: "selectForEditing" });
    const photographerEdited = await post(await sessionCookie(firstPhotographerToken), [editedIdAsset]); expect(photographerEdited.status).toBe(403); await expect(photographerEdited.json()).resolves.toMatchObject({ capability: "downloadFinal" });
    expect((await post(adminCookie, [rawAssets[0]!.id])).status).toBe(201); expect((await post(adminCookie, [editedIdAsset])).status).toBe(201);
    await database.DB.prepare("UPDATE projects SET stage_key = 'editing_autohdr' WHERE id = ?").bind(project.id).run();
    const pastPhotographerCutoff = await post(await sessionCookie(firstPhotographerToken), [rawAssets[0]!.id]);
    expect(pastPhotographerCutoff.status).toBe(403); await expect(pastPhotographerCutoff.json()).resolves.toEqual({ error: "Forbidden: you are not assigned to this project" });
  });

  it("keeps selection validation all-or-nothing through chunks, limits, tickets, and fresh principals", async () => {
    const adminCookie = await sessionCookie(adminToken); const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Selection validation", orderedServices: ["edited", "video"], editorUserIds: [editorId] }) });
    expect(created.status).toBe(201); const project = await created.json() as { id: string }; const editorCookie = await sessionCookie(editorToken);
    const rows = await database.DB.prepare("SELECT id, kind FROM collections WHERE project_id = ?").bind(project.id).all<{ id: string; kind: string }>(); const rawId = rows.results.find((row) => row.kind === "raw")!.id; const editedId = rows.results.find((row) => row.kind === "edited")!.id; const videoId = rows.results.find((row) => row.kind === "video")!.id; const now = Date.now(); const media = env as unknown as { MEDIA: R2Bucket };
    const add = async (collectionId: string, options: { body?: string; bytes?: number; publish?: string; kind?: string; superseded?: number | null } = {}) => { const id = crypto.randomUUID(); const key = `tests/${id}`; const body = options.body ?? "x"; await media.MEDIA.put(key, body); await database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, publish_status, superseded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'upload', ?, ?, ?, ?)").bind(id, collectionId, options.kind ?? "photo", key, `${id}.jpg`, options.bytes ?? body.length, options.publish ?? "ready", options.superseded ?? null, now, now).run(); return id; };
    const raw = await add(rawId); const pending = await add(editedId, { publish: "pending" }); const superseded = await add(rawId, { superseded: now }); const nonPhoto = await add(videoId, { kind: "video" }); const overLimit = await add(rawId, { bytes: 256 * 1024 * 1024 + 1 });
    const post = async (assetIds: unknown, cookie = editorCookie) => SELF.fetch(`https://portal.test/api/projects/${project.id}/download-selection`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ assetIds }) });
    const expectNoPostSideEffects = async () => {
      await expect(database.DB.prepare("SELECT count(*) AS count FROM download_selection_tickets WHERE project_id = ?").bind(project.id).first<{ count: number }>()).resolves.toEqual({ count: 0 });
      await expect(database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'project.download_selection'").bind(project.id).first<{ count: number }>()).resolves.toEqual({ count: 0 });
    };
    const expectPostFailure = async (assetIds: unknown, status: number) => { expect((await post(assetIds)).status).toBe(status); await expectNoPostSideEffects(); };
    const malformed = await SELF.fetch(`https://portal.test/api/projects/${project.id}/download-selection`, { method: "POST", headers: { cookie: editorCookie, "content-type": "application/json" }, body: "{not valid json" });
    expect(malformed.status).toBe(400); await expectNoPostSideEffects();
    for (const ids of [[], [raw, raw], Array.from({ length: 501 }, () => crypto.randomUUID())]) await expectPostFailure(ids, 400);
    const extraKey = await SELF.fetch(`https://portal.test/api/projects/${project.id}/download-selection`, { method: "POST", headers: { cookie: editorCookie, "content-type": "application/json" }, body: JSON.stringify({ assetIds: [raw], unexpected: true }) });
    expect(extraKey.status).toBe(400); await expectNoPostSideEffects();
    const otherCreated = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Other selection project", orderedServices: [] }) }); const otherProject = await otherCreated.json() as { id: string }; const otherRaw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(otherProject.id).first<{ id: string }>(); const foreign = await add(otherRaw!.id);
    await expectPostFailure([raw, foreign], 404); await expectPostFailure([raw, crypto.randomUUID()], 404); await expectPostFailure([raw, pending], 404); await expectPostFailure([superseded], 404);
    await expectPostFailure([raw, await add(editedId)], 400); await expectPostFailure([nonPhoto], 400); await expectPostFailure([overLimit], 413);

    const chunkAssets: Array<{ id: string; body: string }> = []; for (let index = 0; index < 500; index += 1) { const body = `chunk-payload-${index}`; chunkAssets.push({ id: await add(rawId, { body }), body }); }
    const chunkIds = chunkAssets.map((asset) => asset.id);
    // Submitted in non-DB-natural order (reversed) so this proves the response is re-ordered by
    // the submitted assetIds, not merely reflecting query/insertion order.
    for (const ids of [[...chunkIds.slice(0, 100)].reverse(), [...chunkIds].reverse()]) { const ticket = await post(ids); expect(ticket.status).toBe(201); const url = (await ticket.json() as { downloadUrl: string }).downloadUrl; const zip = await SELF.fetch(`https://portal.test${url}`, { headers: { cookie: editorCookie } }); expect(zip.status).toBe(200); const text = new TextDecoder().decode(await zip.arrayBuffer()); let previous = -1; for (const id of ids) { const asset = chunkAssets.find((candidate) => candidate.id === id)!; const position = text.indexOf(`${id}.jpg`); expect(position).toBeGreaterThan(previous); expect(text).toContain(asset.body); previous = position; } }
    const valid = await post([raw]); const validUrl = (await valid.json() as { downloadUrl: string }).downloadUrl; const ticketId = validUrl.split("/")[5]!;
    expect((await SELF.fetch(`https://portal.test${validUrl}`, { headers: { cookie: adminCookie } })).status).toBe(404); // wrong user
    await database.DB.prepare("UPDATE download_selection_tickets SET expires_at = ? WHERE id = ?").bind(now - 1, ticketId).run(); expect((await SELF.fetch(`https://portal.test${validUrl}`, { headers: { cookie: editorCookie } })).status).toBe(404);
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/download-selection/${crypto.randomUUID()}/archive.zip`, { headers: { cookie: editorCookie } })).status).toBe(404);
    const replay = await post([raw]); const replayUrl = (await replay.json() as { downloadUrl: string }).downloadUrl; await database.DB.prepare("UPDATE assets SET superseded_at = ? WHERE id = ?").bind(Date.now(), raw).run(); expect((await SELF.fetch(`https://portal.test${replayUrl}`, { headers: { cookie: editorCookie } })).status).toBe(404);
    const becomesPending = await add(editedId); const pendingReplay = await post([becomesPending]); const pendingReplayUrl = (await pendingReplay.json() as { downloadUrl: string }).downloadUrl; await database.DB.prepare("UPDATE assets SET publish_status = 'pending' WHERE id = ?").bind(becomesPending).run(); expect((await SELF.fetch(`https://portal.test${pendingReplayUrl}`, { headers: { cookie: editorCookie } })).status).toBe(404);
    const deletedAsset = await add(rawId); const deletedReplay = await post([deletedAsset]); const deletedReplayUrl = (await deletedReplay.json() as { downloadUrl: string }).downloadUrl; await database.DB.prepare("DELETE FROM assets WHERE id = ?").bind(deletedAsset).run(); const deletedGet = await SELF.fetch(`https://portal.test${deletedReplayUrl}`, { headers: { cookie: editorCookie } }); expect(deletedGet.status).toBe(404); await expect(deletedGet.json()).resolves.toEqual({ error: "One or more selected assets are not available in this project" });

    const changingUserId = crypto.randomUUID(); const changingToken = `selection-revalidate-${crypto.randomUUID()}`;
    await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Selection Editor', ?, 1, 'editor', 1, ?, ?)").bind(changingUserId, `${changingUserId}@example.test`, now, now).run();
    await database.DB.prepare("INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), now + 60 * 60 * 1000, changingToken, changingUserId, now, now).run();
    await database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'photographer', ?)").bind(crypto.randomUUID(), project.id, changingUserId, now).run();
    const changingCookie = await sessionCookie(changingToken); const changingPost = async () => SELF.fetch(`https://portal.test/api/projects/${project.id}/download-selection`, { method: "POST", headers: { cookie: changingCookie, "content-type": "application/json" }, body: JSON.stringify({ assetIds: [chunkIds[0]] }) });
    const downgradeTicket = await changingPost(); expect(downgradeTicket.status).toBe(201); const downgradeUrl = (await downgradeTicket.json() as { downloadUrl: string }).downloadUrl;
    await database.DB.prepare("UPDATE user SET role = 'photographer' WHERE id = ?").bind(changingUserId).run(); const downgraded = await SELF.fetch(`https://portal.test${downgradeUrl}`, { headers: { cookie: changingCookie } }); expect(downgraded.status).toBe(403); await expect(downgraded.json()).resolves.toMatchObject({ capability: "selectForEditing" });
    await database.DB.prepare("UPDATE user SET role = 'editor' WHERE id = ?").bind(changingUserId).run(); const inactiveTicket = await changingPost(); expect(inactiveTicket.status).toBe(201); const inactiveUrl = (await inactiveTicket.json() as { downloadUrl: string }).downloadUrl;
    await database.DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(changingUserId).run(); expect((await SELF.fetch(`https://portal.test${inactiveUrl}`, { headers: { cookie: changingCookie } })).status).toBe(401);
  }, 20_000);

  it("permanently deletes an archived project, its jobs, project R2 media, and asset renditions", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Delete me", orderedServices: [] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const media = env as unknown as { MEDIA: R2Bucket }; const now = Date.now();
    const projectKeys = [`projects/${project.id}/originals/one.jpg`, `projects/${project.id}/annotations/two.json`];
    const assetIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const [index, key] of projectKeys.entries()) {
      await media.MEDIA.put(key, key);
      await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(assetIds[index], raw!.id, key, "delete.jpg", key.length, "upload", now, now).run();
    }
    const renditionKeys = assetIds.flatMap((assetId, index) => [
      `renditions/${assetId}/content-${index}/${RENDITION_SPEC_VERSION}/thumb/${"a".repeat(64)}.webp`,
      `renditions/${assetId}/content-${index}/${RENDITION_SPEC_VERSION}/web/${"b".repeat(64)}.webp`,
    ]);
    for (const key of renditionKeys) await media.MEDIA.put(key, key);
    const { jobId, handoffId } = await seedAutoHdrGraph(project.id, assetIds[0]!);
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/archive`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status).toBe(200);
    await expect(database.DB.prepare("SELECT state FROM autohdr_path_claims WHERE project_id = ? LIMIT 1").bind(project.id).first()).resolves.toEqual({ state: "tombstone" });

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { method: "DELETE", headers: { cookie } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, deletedObjects: projectKeys.length + renditionKeys.length });
    expect(await database.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(project.id).first()).toBeNull();
    expect(await database.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first()).toBeNull();
    await expect(database.DB.prepare("SELECT count(*) count FROM autohdr_path_claims WHERE project_id = ?").bind(project.id).first()).resolves.toEqual({ count: 0 });
    await expect(database.DB.prepare("SELECT count(*) count FROM autohdr_fetch_claims WHERE project_id = ?").bind(project.id).first()).resolves.toEqual({ count: 0 });
    await expect(database.DB.prepare("SELECT count(*) count FROM autohdr_output_mappings WHERE project_id = ?").bind(project.id).first()).resolves.toEqual({ count: 0 });
    await expect(database.DB.prepare("SELECT count(*) count FROM autohdr_final_associations WHERE handoff_id = ?").bind(handoffId).first()).resolves.toEqual({ count: 0 });
    await expect(database.DB.prepare("SELECT count(*) count FROM autohdr_handoffs WHERE project_id = ?").bind(project.id).first()).resolves.toEqual({ count: 0 });
    for (const key of [...projectKeys, ...renditionKeys]) expect(await media.MEDIA.get(key)).toBeNull();
  });

  it("does not purge another project's asset renditions", async () => {
    const cookie = await sessionCookie(adminToken);
    const create = async (street: string) => {
      const response = await SELF.fetch("https://portal.test/api/projects", {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street, orderedServices: [] }),
      });
      expect(response.status).toBe(201);
      const project = await response.json() as { id: string };
      const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
      return { ...project, rawId: raw!.id };
    };
    const [deletedProject, retainedProject] = await Promise.all([create("Delete rendition project"), create("Retain rendition project")]);
    const media = env as unknown as { MEDIA: R2Bucket }; const now = Date.now();
    const deletedAssetId = crypto.randomUUID(); const retainedAssetId = crypto.randomUUID();
    const deletedProjectKey = `projects/${deletedProject.id}/originals/delete.jpg`;
    const retainedProjectKey = `projects/${retainedProject.id}/originals/retain.jpg`;
    const deletedRenditionKey = `renditions/${deletedAssetId}/content/${RENDITION_SPEC_VERSION}/thumb/${"c".repeat(64)}.webp`;
    const retainedRenditionKey = `renditions/${retainedAssetId}/content/${RENDITION_SPEC_VERSION}/thumb/${"d".repeat(64)}.webp`;
    for (const key of [deletedProjectKey, retainedProjectKey, deletedRenditionKey, retainedRenditionKey]) await media.MEDIA.put(key, key);
    await Promise.all([
      database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(deletedAssetId, deletedProject.rawId, deletedProjectKey, "delete.jpg", 1, "upload", now, now).run(),
      database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(retainedAssetId, retainedProject.rawId, retainedProjectKey, "retain.jpg", 1, "upload", now, now).run(),
      database.DB.prepare("INSERT INTO asset_renditions (id, asset_id, variant, r2_key, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), deletedAssetId, "thumb", deletedRenditionKey, now).run(),
      database.DB.prepare("INSERT INTO asset_renditions (id, asset_id, variant, r2_key, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), retainedAssetId, "thumb", retainedRenditionKey, now).run(),
    ]);
    expect((await SELF.fetch(`https://portal.test/api/projects/${deletedProject.id}/archive`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status).toBe(200);

    const response = await SELF.fetch(`https://portal.test/api/projects/${deletedProject.id}`, { method: "DELETE", headers: { cookie } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, deletedObjects: 2 });
    expect(await media.MEDIA.get(deletedRenditionKey)).toBeNull();
    expect(await database.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(deletedAssetId).first()).toBeNull();
    expect(await media.MEDIA.get(retainedProjectKey)).not.toBeNull();
    expect(await media.MEDIA.get(retainedRenditionKey)).not.toBeNull();
    expect(await database.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(retainedAssetId).first()).not.toBeNull();
    expect(await database.DB.prepare("SELECT asset_id FROM asset_renditions WHERE asset_id = ?").bind(retainedAssetId).first()).toEqual({ asset_id: retainedAssetId });
  });

  it("deletes a project asset that has no renditions", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "No renditions", orderedServices: [] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const key = `projects/${project.id}/originals/no-rendition.jpg`; const media = env as unknown as { MEDIA: R2Bucket };
    await media.MEDIA.put(key, "no rendition");
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), raw!.id, key, "no-rendition.jpg", 12, "upload", Date.now(), Date.now()).run();
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/archive`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status).toBe(200);

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { method: "DELETE", headers: { cookie } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, deletedObjects: 1 });
    expect(await media.MEDIA.get(key)).toBeNull();
  });

  it("retains the active-document deletion guard", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Active document deletion", orderedServices: ["copy"] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const copy = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'copy'").bind(project.id).first<{ id: string }>();
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/archive`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status).toBe(200);
    const now = Date.now();
    await database.DB.prepare("INSERT INTO document_uploads (id, project_id, collection_id, created_by, kind, version_group_id, version, pdf_asset_id, pdf_key, pdf_filename, pdf_bytes, pdf_content_type, status, expires_at, completion_audit_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), project.id, copy!.id, seedAdminId, "copy_pdf", crypto.randomUUID(), 1, crypto.randomUUID(), `projects/${project.id}/copy/pending.pdf`, "pending.pdf", 1, "application/pdf", "pending", now + 60_000, crypto.randomUUID(), now, now).run();

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { method: "DELETE", headers: { cookie } });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Active document uploads were aborted. Confirm deletion again after the sessions are terminal.", activeDocuments: 1 });
    expect(await database.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(project.id).first()).not.toBeNull();
    expect(await database.DB.prepare("SELECT status FROM document_uploads WHERE project_id = ?").bind(project.id).first()).toEqual({ status: "failed" });
  });

  it("rolls back project archive when claim tombstoning fails in the same transaction", async () => {
    const cookie = await sessionCookie(adminToken);
    const project = await createUploadProject(cookie, `Atomic archive ${crypto.randomUUID()}`);
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'")
      .bind(project.id).first<{ id: string }>();
    const assetId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, 'archive.jpg', 1, 'upload', ?, ?)")
      .bind(assetId, raw!.id, `tests/${assetId}.jpg`, now, now).run();
    await seedAutoHdrGraph(project.id, assetId);
    await database.DB.exec(
      `CREATE TRIGGER fail_${project.id.replaceAll("-", "_")} BEFORE UPDATE OF state ON autohdr_path_claims ` +
      `WHEN NEW.project_id = '${project.id}' BEGIN SELECT RAISE(ABORT, 'forced tombstone failure'); END;`,
    );
    const failed = await SELF.fetch(`https://portal.test/api/projects/${project.id}/archive`, { method: "POST", headers: { cookie } });
    expect(failed.status).toBe(500);
    await expect(database.DB.prepare("SELECT archived_at FROM projects WHERE id = ?").bind(project.id).first()).resolves.toEqual({ archived_at: null });
    await expect(database.DB.prepare("SELECT state FROM autohdr_output_mappings WHERE project_id = ?").bind(project.id).first()).resolves.toEqual({ state: "pending_discovery" });
    await expect(database.DB.prepare("SELECT state FROM autohdr_path_claims WHERE project_id = ? LIMIT 1").bind(project.id).first()).resolves.toEqual({ state: "pending" });
    await expect(database.DB.prepare("SELECT state FROM autohdr_handoffs WHERE project_id = ?").bind(project.id).first()).resolves.toEqual({ state: "starting" });
    await database.DB.exec(`DROP TRIGGER fail_${project.id.replaceAll("-", "_")};`);
  });

  it("treats archiving an already archived project as a no-op", async () => {
    const cookie = await sessionCookie(adminToken);
    const project = await createUploadProject(cookie, `Archive retry ${crypto.randomUUID()}`);
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/archive`, { method: "POST", headers: { cookie } })).status).toBe(200);
    const before = await Promise.all([
      database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'project.archive' AND target_id = ?").bind(project.id).first(),
      database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ? AND event_type = 'project.archived'").bind(project.id).first(),
      database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(project.id).first(),
    ]);
    const retry = await SELF.fetch(`https://portal.test/api/projects/${project.id}/archive`, { method: "POST", headers: { cookie } });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({ ok: true });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'project.archive' AND target_id = ?").bind(project.id).first()).toEqual(before[0]);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ? AND event_type = 'project.archived'").bind(project.id).first()).toEqual(before[1]);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(project.id).first()).toEqual(before[2]);
  });

  it("refuses to delete an archived project while background work is active", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Active work", orderedServices: [] }),
    });
    const project = await created.json() as { id: string };
    const media = env as unknown as { MEDIA: R2Bucket }; const now = Date.now(); const key = `projects/${project.id}/originals/intact.jpg`; const jobId = crypto.randomUUID();
    await media.MEDIA.put(key, "intact");
    await database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, retries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(jobId, "dropbox_sync", "running", project.id, 0, now, now).run();
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/archive`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status).toBe(200);

    const blocked = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { method: "DELETE", headers: { cookie } });
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toEqual({ error: "Background work is still running for this project — wait for it to finish and try again.", activeJobs: 1 });
    expect(await database.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(project.id).first()).not.toBeNull();
    expect(await media.MEDIA.get(key)).not.toBeNull();

    await database.DB.prepare("UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?").bind(Date.now(), jobId).run();
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { method: "DELETE", headers: { cookie } })).status).toBe(200);
    expect(await media.MEDIA.get(key)).toBeNull();
  });

  it("refuses to delete a non-archived project without changing its media or rows", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Not archived", orderedServices: [] }),
    });
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const key = `projects/${project.id}/originals/intact.jpg`; const media = env as unknown as { MEDIA: R2Bucket }; const now = Date.now();
    await media.MEDIA.put(key, "intact");
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), raw!.id, key, "intact.jpg", 6, "upload", now, now).run();

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { method: "DELETE", headers: { cookie } });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Archive the project before deleting it." });
    expect(await database.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(project.id).first()).not.toBeNull();
    expect(await database.DB.prepare("SELECT r2_key FROM assets WHERE collection_id = ?").bind(raw!.id).first()).toEqual({ r2_key: key });
    expect(await media.MEDIA.get(key)).not.toBeNull();
  });

  it("prevents an editor from permanently deleting a project", async () => {
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie: await sessionCookie(adminToken), "content-type": "application/json" }, body: JSON.stringify({ street: "Editor cannot delete", orderedServices: [] }),
    });
    const project = await created.json() as { id: string };
    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { method: "DELETE", headers: { cookie: await sessionCookie(editorToken) } });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden", capability: "adminBackend" });
    expect(await database.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(project.id).first()).not.toBeNull();
  });

  it("allows an author to replace their annotation's strokes and republishes a new R2 object", async () => {
    const initialStrokes = [{ points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.3 }], color: "#e64b3c", width: 4 }];
    const { annotationId, strokeR2Key: originalKey } = await createEditableAnnotation(initialStrokes);
    expect(originalKey).toBeTruthy();

    const replacementStrokes = [{ points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.55 }, { x: 0.7, y: 0.6 }], color: "#2f6df0", width: 7 }];
    const response = await SELF.fetch(`https://portal.test/api/annotations/${annotationId}`, {
      method: "PATCH",
      headers: { cookie: await sessionCookie(firstPhotographerToken), "content-type": "application/json" },
      body: JSON.stringify({ strokes: replacementStrokes }),
    });

    expect(response.status).toBe(200);
    const updated = await response.json() as { id: string; strokeR2Key: string | null; editedAt: string | number | null };
    expect(updated.strokeR2Key).toBeTruthy();
    expect(updated.strokeR2Key).not.toBe(originalKey);
    expect(updated.editedAt).toBeTruthy();

    const mediaEnv = env as unknown as { MEDIA: R2Bucket };
    const object = await mediaEnv.MEDIA.get(updated.strokeR2Key!);
    expect(object).not.toBeNull();
    const stored = JSON.parse(await object!.text());
    expect(stored).toEqual(replacementStrokes);

    const storedRow = await database.DB.prepare("SELECT stroke_r2_key, edited_at FROM annotations WHERE id = ?").bind(annotationId).first<{ stroke_r2_key: string; edited_at: number }>();
    expect(storedRow?.stroke_r2_key).toBe(updated.strokeR2Key);
    expect(storedRow?.edited_at).toEqual(expect.any(Number));
  });

  it("rejects malformed or excessive annotation creation before it writes D1 or R2", async () => {
    const { assetId, strokeR2Key } = await createEditableAnnotation([{ points: [{ x: 0.1, y: 0.1 }], color: "#e64b3c", width: 4 }]);
    const before = await database.DB.prepare("SELECT count(*) AS count FROM annotations WHERE asset_id = ?").bind(assetId).first<{ count: number }>();
    const media = env as unknown as { MEDIA: R2Bucket };
    const prefix = strokeR2Key!.slice(0, strokeR2Key!.lastIndexOf("/") + 1);
    const initialObjects = (await media.MEDIA.list({ prefix })).objects.length;
    const cookie = await sessionCookie(firstPhotographerToken);
    const [invalidPoint, tooMany] = await Promise.all([
      SELF.fetch(`https://portal.test/api/assets/${assetId}/annotations`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ strokes: [{ points: [{ x: 1.1, y: 0 }], color: "#000", width: 2 }] }) }),
      SELF.fetch(`https://portal.test/api/assets/${assetId}/annotations`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ strokes: Array.from({ length: 201 }, () => ({ points: [{ x: 0, y: 0 }], color: "#000", width: 2 })) }) }),
    ]);
    expect(invalidPoint.status).toBe(400);
    expect(tooMany.status).toBe(400);
    await expect(database.DB.prepare("SELECT count(*) AS count FROM annotations WHERE asset_id = ?").bind(assetId).first<{ count: number }>()).resolves.toEqual(before);
    expect((await media.MEDIA.list({ prefix })).objects.length).toBe(initialObjects);

    const noteOnly = await SELF.fetch(`https://portal.test/api/assets/${assetId}/annotations`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ noteText: "A note without drawing" }) });
    expect(noteOnly.status).toBe(201);
  });

  it("prevents a different project member from editing another author's annotation strokes", async () => {
    const initialStrokes = [{ points: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.25 }], color: "#3f8f5a", width: 4 }];
    const { annotationId, strokeR2Key: originalKey } = await createEditableAnnotation(initialStrokes);
    expect(originalKey).toBeTruthy();

    const response = await SELF.fetch(`https://portal.test/api/annotations/${annotationId}`, {
      method: "PATCH",
      headers: { cookie: await sessionCookie(secondPhotographerToken), "content-type": "application/json" },
      body: JSON.stringify({ strokes: [{ points: [{ x: 0.9, y: 0.9 }], color: "#000000", width: 2 }] }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden: only the author can edit this annotation." });
    const storedRow = await database.DB.prepare("SELECT stroke_r2_key, edited_at FROM annotations WHERE id = ?").bind(annotationId).first<{ stroke_r2_key: string; edited_at: number | null }>();
    expect(storedRow).toEqual({ stroke_r2_key: originalKey, edited_at: null });
  });

  it("clears an annotation's drawing on PATCH strokes: [] while preserving the old R2 object", async () => {
    const initialStrokes = [{ points: [{ x: 0.4, y: 0.4 }, { x: 0.45, y: 0.42 }], color: "#f0a020", width: 4 }];
    const { annotationId, strokeR2Key: originalKey } = await createEditableAnnotation(initialStrokes);
    expect(originalKey).toBeTruthy();

    const response = await SELF.fetch(`https://portal.test/api/annotations/${annotationId}`, {
      method: "PATCH",
      headers: { cookie: await sessionCookie(firstPhotographerToken), "content-type": "application/json" },
      body: JSON.stringify({ strokes: [] }),
    });

    expect(response.status).toBe(200);
    const updated = await response.json() as { strokeR2Key: string | null; editedAt: string | number | null };
    expect(updated.strokeR2Key).toBeNull();
    expect(updated.editedAt).toBeTruthy();

    const mediaEnv = env as unknown as { MEDIA: R2Bucket };
    const oldObject = await mediaEnv.MEDIA.get(originalKey!);
    expect(oldObject).not.toBeNull();

    const storedRow = await database.DB.prepare("SELECT stroke_r2_key, edited_at FROM annotations WHERE id = ?").bind(annotationId).first<{ stroke_r2_key: string | null; edited_at: number }>();
    expect(storedRow?.stroke_r2_key).toBeNull();
    expect(storedRow?.edited_at).toEqual(expect.any(Number));
  });

  it("deletes an author's annotation while retaining its stroke object", async () => {
    const strokes = [{ points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.3 }], color: "#e64b3c", width: 4 }];
    const { annotationId, strokeR2Key } = await createEditableAnnotation(strokes);
    expect(strokeR2Key).toBeTruthy();

    const response = await SELF.fetch(`https://portal.test/api/annotations/${annotationId}`, {
      method: "DELETE",
      headers: { cookie: await sessionCookie(firstPhotographerToken) },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    const storedRow = await database.DB.prepare("SELECT id FROM annotations WHERE id = ?").bind(annotationId).first<{ id: string }>();
    expect(storedRow).toBeNull();
    const mediaEnv = env as unknown as { MEDIA: R2Bucket };
    expect(await mediaEnv.MEDIA.get(strokeR2Key!)).not.toBeNull();
  });

  it("prevents a fellow project member from deleting another author's annotation", async () => {
    const strokes = [{ points: [{ x: 0.2, y: 0.2 }, { x: 0.3, y: 0.25 }], color: "#3f8f5a", width: 4 }];
    const { annotationId } = await createEditableAnnotation(strokes);
    const response = await SELF.fetch(`https://portal.test/api/annotations/${annotationId}`, {
      method: "DELETE",
      headers: { cookie: await sessionCookie(secondPhotographerToken) },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden: only the author can delete this annotation." });
    const storedRow = await database.DB.prepare("SELECT id FROM annotations WHERE id = ?").bind(annotationId).first<{ id: string }>();
    expect(storedRow).toEqual({ id: annotationId });
  });

  it("creates and updates agencies and agents, while rejecting non-admin directory access", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/admin/agencies", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Harbour Realty", notes: "North shore" }) });
    expect(created.status).toBe(201); const agency = await created.json() as { id: string; name: string };
    const agentCreated = await SELF.fetch("https://portal.test/api/admin/agents", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ agencyId: agency.id, name: "Ava Agent", email: "ava@example.test", phone: "0400 000 000" }) });
    expect(agentCreated.status).toBe(201); const agent = await agentCreated.json() as { id: string };
    const [agencyUpdated, agentUpdated, listed, forbidden] = await Promise.all([
      SELF.fetch(`https://portal.test/api/admin/agencies/${agency.id}`, { method: "PATCH", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ notes: "Updated note" }) }),
      SELF.fetch(`https://portal.test/api/admin/agents/${agent.id}`, { method: "PATCH", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ phone: "0411 111 111" }) }),
      SELF.fetch(`https://portal.test/api/admin/agencies`, { headers: { cookie: adminCookie } }),
      SELF.fetch("https://portal.test/api/admin/agencies", { headers: { cookie: await sessionCookie(photographerToken) } }),
    ]);
    expect(agencyUpdated.status).toBe(200); expect(agentUpdated.status).toBe(200); expect(forbidden.status).toBe(403);
    await expect(listed.json()).resolves.toMatchObject({ agencies: [expect.objectContaining({ id: agency.id, agentCount: 1 })] });
    const filtered = await SELF.fetch(`https://portal.test/api/admin/agents?agencyId=${agency.id}`, { headers: { cookie: adminCookie } });
    await expect(filtered.json()).resolves.toMatchObject({ agents: [expect.objectContaining({ id: agent.id, phone: "0411 111 111" })] });
  });

  it("queues edited uploads for Dropbox before exposing them", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Manual publish queue", orderedServices: [], rawFolderPath: "/Tonomo/Raw Files/Manual publish queue" }) });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const assetId = crypto.randomUUID();
    const key = `projects/${project.id}/edited/${assetId}/manual.jpg`;
    await authEnv.MEDIA.put(key, "manual-jpeg", { httpMetadata: { contentType: "image/jpeg" } });
    const completed = await SELF.fetch("https://portal.test/api/uploads/complete", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, key, originalFilename: "manual.jpg", collection: "edited" }),
    });
    expect(completed.status).toBe(202);
    await expect(completed.json()).resolves.toMatchObject({ assetId, jobId: expect.any(String), publishStatus: "pending" });
    expect(await database.DB.prepare("SELECT publish_status FROM assets WHERE id = ?").bind(assetId).first()).toEqual({ publish_status: "pending" });
    expect(await database.DB.prepare("SELECT received_count FROM collections WHERE project_id = ? AND kind = 'edited'").bind(project.id).first()).toEqual({ received_count: 0 });
    expect(await authEnv.MEDIA.get(key)).not.toBeNull();
    const listed = await SELF.fetch(`https://portal.test/api/projects/${project.id}/assets?collection=edited`, { headers: { cookie } });
    await expect(listed.json()).resolves.toEqual({ assets: [] });
  });

  it("refuses edited uploads before any bytes land when the project has no Dropbox RAW folder", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "No Dropbox folder", orderedServices: [] }) });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };

    const presigned = await SELF.fetch("https://portal.test/api/uploads/presign", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, filename: "manual.jpg", bytes: 1024, collection: "edited" }),
    });
    expect(presigned.status).toBe(409);
    await expect(presigned.json()).resolves.toMatchObject({ code: "raw_folder_missing" });

    // A client that skips presign must not get further: the asset would be committed as pending
    // and then be hidden forever once the publish Workflow fails.
    const assetId = crypto.randomUUID();
    const key = `projects/${project.id}/edited/${assetId}/manual.jpg`;
    await authEnv.MEDIA.put(key, "manual-jpeg", { httpMetadata: { contentType: "image/jpeg" } });
    const completed = await SELF.fetch("https://portal.test/api/uploads/complete", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, key, originalFilename: "manual.jpg", collection: "edited" }),
    });
    expect(completed.status).toBe(409);
    await expect(completed.json()).resolves.toMatchObject({ code: "raw_folder_missing" });
    expect(await database.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(assetId).first()).toBeNull();
    expect(await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'edited'").bind(project.id).first()).toBeNull();
  });

  it("refuses edited uploads when the RAW folder path yields no AutoHDR shoot folder", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Underivable folder", orderedServices: [], rawFolderPath: "/Listing Images" }) });
    const project = await created.json() as { id: string };
    const presigned = await SELF.fetch("https://portal.test/api/uploads/presign", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ projectId: project.id, filename: "manual.jpg", bytes: 1024, collection: "edited" }),
    });
    expect(presigned.status).toBe(409);
    await expect(presigned.json()).resolves.toMatchObject({ code: "raw_folder_invalid" });
  });

  it("accepts edited uploads on a link-only project and never gates RAW uploads on the folder", async () => {
    const cookie = await sessionCookie(adminToken);
    const [linkOnly, noFolder] = await Promise.all([
      SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Link only", orderedServices: [], rawFolderLink: "https://www.dropbox.com/scl/fo/link-only" }) }),
      SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "RAW upload without folder", orderedServices: [] }) }),
    ]);
    const linkProject = await linkOnly.json() as { id: string };
    const rawProject = await noFolder.json() as { id: string };

    // Only the background worker can resolve a share link to a path, so link-only projects stay
    // allowed here and are still checked by the publish Workflow.
    const editedId = crypto.randomUUID();
    const editedKey = `projects/${linkProject.id}/edited/${editedId}/manual.jpg`;
    await authEnv.MEDIA.put(editedKey, "manual-jpeg", { httpMetadata: { contentType: "image/jpeg" } });
    const edited = await SELF.fetch("https://portal.test/api/uploads/complete", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ projectId: linkProject.id, key: editedKey, originalFilename: "manual.jpg", collection: "edited" }),
    });
    expect(edited.status).toBe(202);
    await expect(edited.json()).resolves.toMatchObject({ assetId: editedId, publishStatus: "pending" });

    // A failed RAW mirror never hides the asset, so RAW keeps working with no Dropbox folder.
    const rawId = crypto.randomUUID();
    const rawKey = `projects/${rawProject.id}/raw/${rawId}/capture.jpg`;
    await authEnv.MEDIA.put(rawKey, "raw-jpeg", { httpMetadata: { contentType: "image/jpeg" } });
    const raw = await SELF.fetch("https://portal.test/api/uploads/complete", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ projectId: rawProject.id, key: rawKey, originalFilename: "capture.jpg", collection: "raw" }),
    });
    expect(raw.status).toBe(201);
  });

  it("hides pending manual edited uploads until Dropbox publishing is ready", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Manual publish visibility", orderedServices: [] }) });
    const project = await created.json() as { id: string };
    const collectionId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'edited', 'empty', 0, ?, ?)").bind(collectionId, project.id, now, now).run();
    const pendingId = crypto.randomUUID(); const readyId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, publish_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'upload', 'pending', ?, ?)").bind(pendingId, collectionId, `tests/${pendingId}.jpg`, "pending.jpg", 1, now, now),
      database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, publish_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'upload', 'ready', ?, ?)").bind(readyId, collectionId, `tests/${readyId}.jpg`, "ready.jpg", 1, now, now),
    ]);
    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}/assets?collection=edited`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const assets = (await response.json() as { assets: Array<{ id: string; renditionStatus: string }> }).assets;
    expect(assets).toEqual([expect.objectContaining({ id: readyId, renditionStatus: "processing" })]);

    const legacyRenditionId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO asset_renditions (id, asset_id, variant, r2_key, content_type, spec_version, created_at) VALUES (?, ?, 'thumb', ?, 'image/webp', ?, ?)").bind(legacyRenditionId, readyId, `renditions/${readyId}/thumb.webp`, RENDITION_SPEC_VERSION, now).run();
    const thumbOnly = await SELF.fetch(`https://portal.test/api/projects/${project.id}/assets?collection=edited`, { headers: { cookie } });
    await expect(thumbOnly.json()).resolves.toMatchObject({ assets: [expect.objectContaining({ id: readyId, renditionStatus: "processing" })] });

    const webRenditionId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO asset_renditions (id, asset_id, variant, r2_key, content_type, spec_version, created_at) VALUES (?, ?, 'web', ?, 'image/jpeg', ?, ?)").bind(webRenditionId, readyId, `renditions/${readyId}/web.jpg`, RENDITION_SPEC_VERSION, now).run();
    const afterBoth = await SELF.fetch(`https://portal.test/api/projects/${project.id}/assets?collection=edited`, { headers: { cookie } });
    await expect(afterBoth.json()).resolves.toMatchObject({ assets: [expect.objectContaining({ id: readyId, renditionStatus: "ready" })] });

    await database.DB.prepare("UPDATE asset_renditions SET content_type = 'application/octet-stream', spec_version = 'legacy' WHERE id = ?").bind(webRenditionId).run();
    const afterLegacy = await SELF.fetch(`https://portal.test/api/projects/${project.id}/assets?collection=edited`, { headers: { cookie } });
    await expect(afterLegacy.json()).resolves.toMatchObject({ assets: [expect.objectContaining({ id: readyId, renditionStatus: "processing" })] });
  });

  it("blocks direct unpublished edited asset media and mutations without gating ready assets", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Unpublished direct-id guard", orderedServices: [] }) });
    const project = await created.json() as { id: string };
    const editedId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'edited', 'empty', 0, ?, ?)").bind(editedId, project.id, now, now).run();
    const pendingId = crypto.randomUUID(); const readyId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, publish_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'upload', 'pending', ?, ?)").bind(pendingId, editedId, `tests/${pendingId}.jpg`, "pending.jpg", 1, now, now),
      database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, publish_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'upload', 'ready', ?, ?)").bind(readyId, editedId, `tests/${readyId}.jpg`, "ready.jpg", 1, now, now),
    ]);
    await authEnv.MEDIA.put(`tests/${readyId}.jpg`, "ready", { httpMetadata: { contentType: "image/jpeg" } });
    const blocked = await Promise.all([
      ...["original", "thumb", "web"].map((variant) => SELF.fetch(`https://portal.test/media/asset/${pendingId}/${variant}`, { headers: { cookie } })),
      SELF.fetch(`https://portal.test/api/assets/${pendingId}/review`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ stars: 5 }) }),
      SELF.fetch(`https://portal.test/api/assets/${pendingId}/annotations`, { headers: { cookie } }),
      SELF.fetch(`https://portal.test/api/projects/${project.id}/cover`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ assetId: pendingId }) }),
    ]);
    for (const response of blocked) expect(response.status).toBe(404);
    const readyOriginal = await SELF.fetch(`https://portal.test/media/asset/${readyId}/original`, { headers: { cookie } });
    expect(readyOriginal.status).toBe(200);
    expect(await readyOriginal.text()).toBe("ready");
    const readyReview = await SELF.fetch(`https://portal.test/api/assets/${readyId}/review`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ stars: 5 }) });
    expect(readyReview.status).toBe(200);
  });

  it("keeps a manual RAW asset immediately usable when Dropbox mirror startup fails", async () => {
    const cookie = await sessionCookie(adminToken);
    const projectId = "00000000-0000-4000-8000-0000000000fe";
    const collectionId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, raw_folder_path, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?, ?)")
        .bind(projectId, "RAW mirror service failure", "/Tonomo/Raw Files/Terry/2026-07-24/RAW mirror service failure", now, now),
      database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?)")
        .bind(collectionId, projectId, now, now),
    ]);
    const key = `projects/${projectId}/raw/${assetId}/service-failure.jpg`;
    await authEnv.MEDIA.put(key, "manual-raw-jpeg", { httpMetadata: { contentType: "image/jpeg" } });

    const response = await SELF.fetch("https://portal.test/api/uploads/complete", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ projectId, key, originalFilename: "service-failure.jpg", collection: "raw" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { assetId: string; jobId: string; publishStatus: string; mirrorStatus: string };
    expect(body).toMatchObject({ assetId, jobId: expect.any(String), publishStatus: "ready", mirrorStatus: "failed" });
    await expect(database.DB.prepare("SELECT publish_status, source_path FROM assets WHERE id = ?").bind(assetId).first())
      .resolves.toEqual({ publish_status: "ready", source_path: null });
    await expect(database.DB.prepare("SELECT status FROM jobs WHERE correlation_id = ?").bind(`manual_raw_publish:${assetId}`).first())
      .resolves.toEqual({ status: "failed" });
    await expect(database.DB.prepare("SELECT stage_key FROM projects WHERE id = ?").bind(projectId).first())
      .resolves.toEqual({ stage_key: "raw_review" });
    const stageAudits = await database.DB.prepare("SELECT actor_id, meta_json FROM audit_log WHERE target_id = ? AND action = 'stage.auto_advance'").bind(projectId).all<{ actor_id: string | null; meta_json: string }>();
    expect(stageAudits.results).toHaveLength(1);
    expect(stageAudits.results[0]?.actor_id).toBeNull();
    expect(JSON.parse(stageAudits.results[0]!.meta_json)).toMatchObject({ trigger: "direct_upload", durableRawEvidence: { newlyImported: true, currentRawAvailable: true } });
    expect(await authEnv.MEDIA.get(key)).not.toBeNull();

    const listed = await SELF.fetch(`https://portal.test/api/projects/${projectId}/assets?collection=raw`, { headers: { cookie } });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({ assets: [expect.objectContaining({ id: assetId })] });
  });

  it("atomically loses a direct-upload identity race to a Dropbox-style asset transaction", async () => {
    const cookie = await sessionCookie(adminToken);
    const project = await createUploadProject(cookie, `Identity race ${crypto.randomUUID()}`);
    const collection = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'")
      .bind(project.id).first<{ id: string }>();
    const directAssetId = crypto.randomUUID();
    const dropboxAssetId = crypto.randomUUID();
    const directKey = `projects/${project.id}/raw/${directAssetId}/race.jpg`;
    const dropboxKey = `projects/${project.id}/raw/dropbox/race/race.jpg`;
    await authEnv.MEDIA.put(directKey, "direct-race", { httpMetadata: { contentType: "image/jpeg" } });
    await authEnv.MEDIA.put(dropboxKey, "dropbox-race", { httpMetadata: { contentType: "image/jpeg" } });
    const completed = await finalizeIngest(authEnv, {
      actorId: seedAdminId,
      projectId: project.id,
      assetId: directAssetId,
      key: directKey,
      originalFilename: "race.jpg",
      contentHash: "same-content-hash",
      collection: "raw",
    }, {
      beforeMetadataBatch: async () => {
        const now = Date.now();
        await database.DB.batch([
          database.DB.prepare("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, created_at, updated_at) VALUES (?, ?, 'photo', ?, 'race.jpg', 12, 'same-content-hash', 'dropbox', '/Raw/race.jpg', '/raw/race.jpg', ?, ?)")
            .bind(dropboxAssetId, collection!.id, dropboxKey, now, now),
          database.DB.prepare("INSERT INTO asset_ingest_identities (id, collection_id, identity_key, asset_id, created_at) VALUES (?, ?, 'hash:same-content-hash', ?, ?)")
            .bind(crypto.randomUUID(), collection!.id, dropboxAssetId, now),
        ]);
      },
    });
    expect(completed).toMatchObject({ assetId: dropboxAssetId, durableRawEvidence: { newlyImported: false, currentRawAvailable: true } });
    await expect(database.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(directAssetId).first()).resolves.toBeNull();
    await expect(database.DB.prepare("SELECT asset_id FROM asset_ingest_identities WHERE collection_id = ? AND identity_key = 'hash:same-content-hash'").bind(collection!.id).first())
      .resolves.toEqual({ asset_id: dropboxAssetId });
    await expect(database.DB.prepare("SELECT count(*) count FROM assets WHERE collection_id = ?").bind(collection!.id).first()).resolves.toEqual({ count: 1 });
    expect(await authEnv.MEDIA.get(directKey)).not.toBeNull();
  });

  it("allows an administrator to retry a failed manual RAW mirror job", async () => {
    const cookie = await sessionCookie(adminToken);
    const project = await createUploadProject(cookie, `RAW mirror retry ${crypto.randomUUID()}`);
    const collection = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'")
      .bind(project.id).first<{ id: string }>();
    const assetId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, publish_status, created_at, updated_at) VALUES (?, ?, ?, 'retry.jpg', 1, 'upload', 'ready', ?, ?)")
        .bind(assetId, collection!.id, `tests/${assetId}.jpg`, now, now),
      database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, correlation_id, payload_json, error, created_at, updated_at) VALUES (?, 'manual_raw_publish', 'failed', ?, ?, ?, 'Dropbox unavailable', ?, ?)")
        .bind(jobId, project.id, `manual_raw_publish:${assetId}`, JSON.stringify({ projectId: project.id, assetId, collection: "raw" }), now, now),
    ]);

    const response = await SELF.fetch(`https://portal.test/api/jobs/${jobId}/retry`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ jobId: expect.any(String) });
  });

  it("routes the RAW-review AutoHDR button through the send-only API RPC", async () => {
    const cookie = await sessionCookie(adminToken);
    const project = await createUploadProject(cookie, `AutoHDR API send ${crypto.randomUUID()}`);
    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}/send-to-autohdr`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ jobId: `api-send-${project.id}` });
  });

  it("routes a failed AutoHDR retry through startAutoHdr with resumeExisting", async () => {
    const cookie = await sessionCookie(adminToken);
    const project = await createUploadProject(cookie, `AutoHDR route retry ${crypto.randomUUID()}`);
    const jobId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, correlation_id, payload_json, retries, error, created_at, updated_at) VALUES (?, 'autohdr', 'failed', ?, ?, '{}', 0, 'Workflow failed', ?, ?)")
      .bind(jobId, project.id, `autohdr:${project.id}`, now, now).run();

    const response = await SELF.fetch(`https://portal.test/api/jobs/${jobId}/retry`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ jobId: `resumed-${project.id}` });
  });

  it("uses current-only edited readers while keeping history explicitly available to staff", async () => {
    const cookie = await sessionCookie(adminToken);
    const project = await createUploadProject(cookie, `Current edited ${crypto.randomUUID()}`);
    const collectionId = crypto.randomUUID();
    const oldId = crypto.randomUUID();
    const currentId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'edited', 'received', 1, ?, ?)")
        .bind(collectionId, project.id, now, now),
      database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, superseded_at, replaced_by_asset_id, created_at, updated_at) VALUES (?, ?, ?, 'final.jpg', 1, 'old', 'dropbox', '/AutoHDR/Test/04-FINAL-Photos/final.jpg', '/autohdr/test/04-final-photos/final.jpg', ?, ?, ?, ?)")
        .bind(oldId, collectionId, `tests/${oldId}.jpg`, now, currentId, now - 1, now),
      database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, content_hash, source, source_path, source_path_key, created_at, updated_at) VALUES (?, ?, ?, 'final.jpg', 1, 'new', 'dropbox', '/AutoHDR/Test/04-FINAL-Photos/final.jpg', '/autohdr/test/04-final-photos/final.jpg', ?, ?)")
        .bind(currentId, collectionId, `tests/${currentId}.jpg`, now, now),
    ]);
    const listed = await SELF.fetch(`https://portal.test/api/projects/${project.id}/assets?collection=edited`, { headers: { cookie } });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({ assets: [expect.objectContaining({ id: currentId })] });
    const oldDirect = await SELF.fetch(`https://portal.test/media/asset/${oldId}/original`, { headers: { cookie } });
    expect(oldDirect.status).toBe(404);
    const history = await SELF.fetch(`https://portal.test/api/projects/${project.id}/autohdr-history`, { headers: { cookie } });
    expect(history.status).toBe(200);
    const historyBody = await history.json() as { assets: { id: string }[] };
    expect(new Set(historyBody.assets.map((asset) => asset.id))).toEqual(new Set([oldId, currentId]));
  });

  it("marks a manual upload failed when its publication service cannot start", async () => {
    const cookie = await sessionCookie(adminToken);
    const projectId = "00000000-0000-4000-8000-0000000000ff"; const collectionId = crypto.randomUUID(); const assetId = crypto.randomUUID(); const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, raw_folder_path, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?, ?)").bind(projectId, "Manual service failure", "/Tonomo/Raw Files/Manual service failure", now, now),
      database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'raw', 'empty', 0, ?, ?)").bind(crypto.randomUUID(), projectId, now, now),
      database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'edited', 'empty', 0, ?, ?)").bind(collectionId, projectId, now, now),
    ]);
    const key = `projects/${projectId}/edited/${assetId}/service-failure.jpg`;
    await authEnv.MEDIA.put(key, "manual-jpeg", { httpMetadata: { contentType: "image/jpeg" } });
    const response = await SELF.fetch("https://portal.test/api/uploads/complete", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ projectId, key, originalFilename: "service-failure.jpg", collection: "edited" }) });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ assetId, publishStatus: "failed", jobId: expect.any(String) });
    await expect(database.DB.prepare("SELECT publish_status FROM assets WHERE id = ?").bind(assetId).first()).resolves.toEqual({ publish_status: "failed" });
    await expect(database.DB.prepare("SELECT status FROM jobs WHERE correlation_id = ?").bind(`manual_edited_publish:${assetId}`).first()).resolves.toEqual({ status: "failed" });
    expect(await authEnv.MEDIA.get(key)).not.toBeNull();
  });

  describe("unified Dropbox fetch", () => {
    it("queues RAW only for an editor and never calls the admin-only edited fetch", async () => {
      const projectId = "00000000-0000-4000-8000-0000000000e9";
      await seedSyncDropboxProject(projectId, "/Tonomo/Raw Files/Editor only");
      const { response, body } = await syncDropbox(await sessionCookie(editorToken), projectId);
      expect(response.status).toBe(200);
      expect(body).toEqual({ raw: { jobId: `raw-${projectId}` }, edited: { skipped: "not_admin" } });
    });

    it("queues RAW only for an assigned photographer", async () => {
      const projectId = "00000000-0000-4000-8000-0000000000ea";
      await seedSyncDropboxProject(projectId, "/Tonomo/Raw Files/Photographer only", firstPhotographerId);
      const { response, body } = await syncDropbox(await sessionCookie(firstPhotographerToken), projectId);
      expect(response.status).toBe(200);
      expect(body).toEqual({ raw: { jobId: `raw-${projectId}` }, edited: { skipped: "not_admin" } });
    });

    it("queues both sources for an administrator with an active AutoHDR mapping and audits both jobs", async () => {
      const projectId = "00000000-0000-4000-8000-0000000000e2";
      await seedSyncDropboxProject(projectId, "/Tonomo/Raw Files/Active mapping");
      const { response, body } = await syncDropbox(await sessionCookie(adminToken), projectId);
      expect(response.status).toBe(200);
      expect(body).toEqual({ raw: { jobId: `raw-${projectId}` }, edited: { jobId: `edited-${projectId}` } });
      const audits = await database.DB.prepare("SELECT action FROM audit_log WHERE target_id = ? AND action IN ('project.dropbox_sync', 'project.fetch_edited') ORDER BY action")
        .bind(projectId).all<{ action: string }>();
      expect(audits.results.map((audit) => audit.action)).toEqual(["project.dropbox_sync", "project.fetch_edited"]);
    });

    it("keeps a blocked AutoHDR result visible while returning the accepted RAW job", async () => {
      const projectId = "00000000-0000-4000-8000-0000000000e3";
      await seedSyncDropboxProject(projectId, "/Tonomo/Raw Files/Blocked mapping");
      const { response, body } = await syncDropbox(await sessionCookie(adminToken), projectId);
      expect(response.status).toBe(200);
      expect(body).toEqual({
        raw: { jobId: `raw-${projectId}` },
        edited: { blocked: { code: "ERR_MAPPING_BLOCKED", message: "AutoHDR output mapping is blocked for staff resolution" } },
      });
    });

    it("reports an AutoHDR handoff that is not ready without turning the RAW success into a 409", async () => {
      const projectId = "00000000-0000-4000-8000-0000000000e4";
      await seedSyncDropboxProject(projectId, "/Tonomo/Raw Files/No handoff");
      const { response, body } = await syncDropbox(await sessionCookie(adminToken), projectId);
      expect(response.status).toBe(200);
      expect(body).toEqual({ raw: { jobId: `raw-${projectId}` }, edited: { skipped: "not_ready" } });
    });

    it("returns 409 only when neither source is applicable", async () => {
      const projectId = "00000000-0000-4000-8000-0000000000e5";
      await seedSyncDropboxProject(projectId, null);
      const { response, body } = await syncDropbox(await sessionCookie(editorToken), projectId);
      expect(response.status).toBe(409);
      expect(body).toEqual({
        error: "Nothing available to sync right now",
        result: { raw: { skipped: "no_raw_folder" }, edited: { skipped: "not_admin" } },
      });
    });

    it("allows an administrator to queue edited-only fetch when no RAW folder is configured", async () => {
      const projectId = "00000000-0000-4000-8000-0000000000e6";
      await seedSyncDropboxProject(projectId, null);
      const { response, body } = await syncDropbox(await sessionCookie(adminToken), projectId);
      expect(response.status).toBe(200);
      expect(body).toEqual({ raw: { skipped: "no_raw_folder" }, edited: { jobId: `edited-${projectId}` } });
    });

    it("returns a RAW runtime failure as a structured 200 result", async () => {
      const projectId = "00000000-0000-4000-8000-0000000000e1";
      await seedSyncDropboxProject(projectId, "/Tonomo/Raw Files/RAW failure");
      const { response, body } = await syncDropbox(await sessionCookie(adminToken), projectId);
      expect(response.status).toBe(200);
      expect(body).toEqual({ raw: { skipped: "error", message: "RAW Dropbox unavailable" }, edited: { jobId: `edited-${projectId}` } });
    });

    it("does not let a RAW audit failure erase the accepted job and preserves fetch-claim errors", async () => {
      const projectId = "00000000-0000-4000-8000-0000000000e8";
      await seedSyncDropboxProject(projectId, "/Tonomo/Raw Files/Audit failure");
      await database.DB.exec(`CREATE TRIGGER sync_raw_audit_failure BEFORE INSERT ON audit_log WHEN NEW.action = 'project.dropbox_sync' AND NEW.target_id = '${projectId}' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
      try {
        const { response, body } = await syncDropbox(await sessionCookie(adminToken), projectId);
        expect(response.status).toBe(200);
        expect(body).toEqual({ raw: { jobId: `raw-${projectId}` }, edited: { skipped: "error", message: "Dropbox fetch claim failed" } });
      } finally {
        await database.DB.exec("DROP TRIGGER sync_raw_audit_failure;");
      }
    });

    it("surfaces a blocked AutoHDR mapping even when RAW is not applicable", async () => {
      const projectId = "00000000-0000-4000-8000-0000000000e7";
      await seedSyncDropboxProject(projectId, null);
      const { response, body } = await syncDropbox(await sessionCookie(adminToken), projectId);
      expect(response.status).toBe(200);
      expect(body).toEqual({
        raw: { skipped: "no_raw_folder" },
        edited: { blocked: { code: "ERR_MAPPING_BLOCKED", message: "AutoHDR output mapping is blocked for staff resolution" } },
      });
    });
  });

  it("projects AutoHDR state and restricts operational routes to the admin backend", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ street: "AutoHDR privacy", orderedServices: [], editorUserIds: [editorId], photographerUserIds: [firstPhotographerId] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string; stageKey: string };
    await database.DB.prepare("UPDATE projects SET stage_key = ? WHERE id = ?").bind("editing_autohdr", project.id).run();

    const [adminList, editorList, photographerList, adminDetail, editorDetail, photographerDetail, adminStages, editorStages, photographerStages] = await Promise.all([
      SELF.fetch("https://portal.test/api/projects", { headers: { cookie: adminCookie } }),
      SELF.fetch("https://portal.test/api/projects", { headers: { cookie: await sessionCookie(editorToken) } }),
      SELF.fetch("https://portal.test/api/projects", { headers: { cookie: await sessionCookie(firstPhotographerToken) } }),
      SELF.fetch(`https://portal.test/api/projects/${project.id}`, { headers: { cookie: adminCookie } }),
      SELF.fetch(`https://portal.test/api/projects/${project.id}`, { headers: { cookie: await sessionCookie(editorToken) } }),
      SELF.fetch(`https://portal.test/api/projects/${project.id}`, { headers: { cookie: await sessionCookie(firstPhotographerToken) } }),
      SELF.fetch("https://portal.test/api/stages", { headers: { cookie: adminCookie } }),
      SELF.fetch("https://portal.test/api/stages", { headers: { cookie: await sessionCookie(editorToken) } }),
      SELF.fetch("https://portal.test/api/stages", { headers: { cookie: await sessionCookie(firstPhotographerToken) } }),
    ]);
    const stageFor = async (response: Response) => (await response.json() as { projects: Array<{ id: string; stageKey: string }> }).projects.find((item) => item.id === project.id)?.stageKey;
    await expect(stageFor(adminList)).resolves.toBe("editing_autohdr");
    await expect(stageFor(editorList)).resolves.toBe("editing");
    // Per Photographer-Stage-Visibility-Plan.md, a photographer's assigned project drops out of
    // their dashboard list entirely once it passes raw_review — editing_autohdr is well beyond
    // that cutoff, so the project is absent from their list rather than present with a mapped
    // "editing" stage key.
    await expect(stageFor(photographerList)).resolves.toBeUndefined();
    await expect(adminDetail.json()).resolves.toMatchObject({ stageKey: "editing_autohdr" });
    await expect(editorDetail.json()).resolves.toMatchObject({ stageKey: "editing" });
    // Same cutoff applies to the direct-fetch route: the photographer is denied outright rather
    // than seeing the project's (mapped) stage.
    expect(photographerDetail.status).toBe(403);
    for (const response of [adminStages, editorStages, photographerStages]) expect(response.status).toBe(200);
    const stageKeys = async (response: Response) => (await response.json() as { stages: Array<{ key: string; label: string }> }).stages;
    await expect(stageKeys(adminStages)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ key: "editing_autohdr" })]));
    for (const response of [editorStages, photographerStages]) {
      const stages = await stageKeys(response);
      expect(stages).toEqual(expect.arrayContaining([expect.objectContaining({ key: "editing", label: "Editing" })]));
      expect(stages).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: "editing_autohdr" })]));
    }

    const editorCookie = await sessionCookie(editorToken); const photographerCookie = await sessionCookie(firstPhotographerToken);
    const denied = await Promise.all([
      ...[editorCookie, photographerCookie].flatMap((cookie) => [
        SELF.fetch(`https://portal.test/api/projects/${project.id}/send-to-autohdr`, { method: "POST", headers: { cookie } }),
        SELF.fetch(`https://portal.test/api/projects/${project.id}/fetch-edited`, { method: "POST", headers: { cookie } }),
        SELF.fetch(`https://portal.test/api/projects/${project.id}/jobs`, { headers: { cookie } }),
        SELF.fetch(`https://portal.test/api/jobs/${crypto.randomUUID()}/retry`, { method: "POST", headers: { cookie } }),
      ]),
    ]);
    for (const response of denied) {
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "Forbidden", capability: "adminBackend" });
    }
    const internalStageDenied = await SELF.fetch(`https://portal.test/api/projects/${project.id}/stage`, { method: "POST", headers: { cookie: editorCookie, "content-type": "application/json" }, body: JSON.stringify({ stageKey: "editing_autohdr" }) });
    expect(internalStageDenied.status).toBe(403);
    await expect(internalStageDenied.json()).resolves.toEqual({ error: "Forbidden" });

    const persisted = await database.DB.prepare("SELECT stage_key FROM projects WHERE id = ?").bind(project.id).first<{ stage_key: string }>();
    expect(persisted).toEqual({ stage_key: "editing_autohdr" });
    const adminMutation = await SELF.fetch(`https://portal.test/api/projects/${project.id}/stage`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ stageKey: "editing" }) });
    expect(adminMutation.status).toBe(400);
    await expect(adminMutation.json()).resolves.toEqual({ error: "Unknown stage" });
  });

  it("keeps global Stage order developer-managed while preserving label and activation management", async () => {
    type StageRow = { key: string; label: string; displayOrder: number; active: boolean };
    const cookie = await sessionCookie(adminToken);
    const photographerCookie = await sessionCookie(photographerToken);
    const readStages = async (path: string, requestCookie: string): Promise<StageRow[]> => {
      const response = await SELF.fetch(`https://portal.test${path}`, { headers: { cookie: requestCookie } });
      expect(response.status).toBe(200);
      return (await response.json() as { stages: StageRow[] }).stages;
    };
    const orderTuples = (stages: StageRow[]) => stages.map(({ key, displayOrder }) => ({ key, displayOrder }));
    const moveAuditCount = async () => (await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = ?").bind("pipeline_stage.move").first<{ count: number }>())?.count ?? 0;

    await database.DB.exec("DELETE FROM pipeline_stages;");
    const seededStages = await readStages("/api/admin/stages", cookie);
    expect(orderTuples(seededStages)).toEqual([
      { key: "awaiting_raw", displayOrder: 1 },
      { key: "raw_review", displayOrder: 2 },
      { key: "editing_autohdr", displayOrder: 3 },
      { key: "edited_review", displayOrder: 4 },
      { key: "delivered", displayOrder: 5 },
    ]);

    const beforeOrder = orderTuples(seededStages);
    const moveAuditsBefore = await moveAuditCount();
    const move = await SELF.fetch("https://portal.test/api/admin/stages/raw_review/move", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ direction: "up" }) });
    expect(move.status).toBe(404);
    await expect(move.json()).resolves.toEqual({ error: "Not found" });
    const afterMoveStages = await readStages("/api/admin/stages", cookie);
    expect(JSON.stringify(orderTuples(afterMoveStages))).toBe(JSON.stringify(beforeOrder));
    expect(await moveAuditCount()).toBe(moveAuditsBefore);

    const label = await SELF.fetch("https://portal.test/api/admin/stages/raw_review", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "Raw triage" }) });
    expect(label.status).toBe(200);
    await expect(label.json()).resolves.toMatchObject({ key: "raw_review", label: "Raw triage", displayOrder: 2 });
    const adminAfterLabel = await readStages("/api/admin/stages", cookie);
    const publicAfterLabel = await readStages("/api/stages", photographerCookie);
    expect(adminAfterLabel.find((stage) => stage.key === "raw_review")).toMatchObject({ label: "Raw triage", displayOrder: 2 });
    expect(publicAfterLabel.find((stage) => stage.key === "raw_review")).toMatchObject({ label: "Raw triage", displayOrder: 2 });
    expect(JSON.stringify(orderTuples(adminAfterLabel))).toBe(JSON.stringify(beforeOrder));

    const activationKey = "delivered";
    const unusedStage = await database.DB.prepare("SELECT count(*) AS count FROM projects WHERE stage_key = ? AND archived_at IS NULL").bind(activationKey).first<{ count: number }>();
    expect(unusedStage).toEqual({ count: 0 });
    const deactivated = await SELF.fetch(`https://portal.test/api/admin/stages/${activationKey}`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ active: false }) });
    expect(deactivated.status).toBe(200);
    await expect(deactivated.json()).resolves.toMatchObject({ key: activationKey, active: false });
    const adminDeactivated = await readStages("/api/admin/stages", cookie);
    const publicDeactivated = await readStages("/api/stages", photographerCookie);
    expect(adminDeactivated.find((stage) => stage.key === activationKey)).toMatchObject({ active: false });
    expect(publicDeactivated.find((stage) => stage.key === activationKey)).toMatchObject({ active: false });
    const reactivated = await SELF.fetch(`https://portal.test/api/admin/stages/${activationKey}`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ active: true }) });
    expect(reactivated.status).toBe(200);
    await expect(reactivated.json()).resolves.toMatchObject({ key: activationKey, active: true });
    const adminReactivated = await readStages("/api/admin/stages", cookie);
    const publicReactivated = await readStages("/api/stages", photographerCookie);
    expect(adminReactivated.find((stage) => stage.key === activationKey)).toMatchObject({ active: true });
    expect(publicReactivated.find((stage) => stage.key === activationKey)).toMatchObject({ active: true });

    const systemBlocked = await SELF.fetch("https://portal.test/api/admin/stages/awaiting_raw", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ active: false }) });
    expect(systemBlocked.status).toBe(409);
    await expect(systemBlocked.json()).resolves.toEqual({ error: "The awaiting_raw stage is required for new projects." });

    const guardProject = await createUploadProject(cookie, "Stage guard");
    await database.DB.prepare("UPDATE projects SET stage_key = ?, updated_at = ? WHERE id = ?").bind("raw_review", Date.now(), guardProject.id).run();
    const projectCountRow = await database.DB.prepare("SELECT count(*) AS count FROM projects WHERE stage_key = ? AND archived_at IS NULL").bind("raw_review").first<{ count: number }>();
    const expectedProjectCount = projectCountRow?.count ?? 0;
    expect(expectedProjectCount).toBeGreaterThan(0);
    const activeProjectBlocked = await SELF.fetch("https://portal.test/api/admin/stages/raw_review", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ active: false }) });
    expect(activeProjectBlocked.status).toBe(409);
    await expect(activeProjectBlocked.json()).resolves.toEqual({ error: "This stage is used by active projects and cannot be deactivated.", projectCount: expectedProjectCount });
    const adminAfterGuard = await readStages("/api/admin/stages", cookie);
    const publicAfterGuard = await readStages("/api/stages", photographerCookie);
    expect(adminAfterGuard.find((stage) => stage.key === "raw_review")).toMatchObject({ active: true });
    expect(publicAfterGuard.find((stage) => stage.key === "raw_review")).toMatchObject({ active: true });
  });

  it("rejects project movement into an inactive Stage", async () => {
    const cookie = await sessionCookie(adminToken);
    await database.DB.prepare("UPDATE pipeline_stages SET active = 0 WHERE key = ?").bind("raw_review").run();
    try {
      const created = await createUploadProject(cookie, "Inactive target stage");
      const inactiveTarget = await SELF.fetch(`https://portal.test/api/projects/${created.id}/stage`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ stageKey: "raw_review" }) });
      expect(inactiveTarget.status).toBe(409);
      await expect(inactiveTarget.json()).resolves.toEqual({ error: "Stage is deactivated" });
    } finally {
      await database.DB.prepare("UPDATE pipeline_stages SET active = 1 WHERE key = ?").bind("raw_review").run();
    }
  });

  it("filters Tonomo events and lets operators retry or discard only poison rows", async () => {
    const cookie = await sessionCookie(adminToken); const poisonId = crypto.randomUUID(); const receivedId = crypto.randomUUID(); const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO webhook_events (id, source, event_id, payload_json, status, error, received_at, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(poisonId, "tonomo", `poison-${poisonId}`, JSON.stringify({ id: "order-poison", property_address: "7 Poison Road" }), "poison", "Cannot reconcile", now, now),
      database.DB.prepare("INSERT INTO webhook_events (id, source, event_id, payload_json, status, received_at) VALUES (?, ?, ?, ?, ?, ?)").bind(receivedId, "tonomo", `received-${receivedId}`, "{}", "received", now + 1),
    ]);
    const filtered = await SELF.fetch("https://portal.test/api/admin/webhook-events?source=tonomo&status=poison&limit=1&offset=0", { headers: { cookie } });
    await expect(filtered.json()).resolves.toMatchObject({ events: [expect.objectContaining({ id: poisonId, error: "Cannot reconcile" })], total: expect.any(Number) });
    const notPoison = await SELF.fetch(`https://portal.test/api/admin/webhook-events/${receivedId}/retry`, { method: "POST", headers: { cookie } });
    expect(notPoison.status).toBe(409);
    const retried = await SELF.fetch(`https://portal.test/api/admin/webhook-events/${poisonId}/retry`, { method: "POST", headers: { cookie } });
    expect(retried.status).toBe(200);
    expect(await database.DB.prepare("SELECT status, error FROM webhook_events WHERE id = ?").bind(poisonId).first()).toEqual({ status: "received", error: null });
    await database.DB.prepare("UPDATE webhook_events SET status = ?, error = ? WHERE id = ?").bind("poison", "Still broken", poisonId).run();
    const discarded = await SELF.fetch(`https://portal.test/api/admin/webhook-events/${poisonId}/discard`, { method: "POST", headers: { cookie } });
    expect(discarded.status).toBe(200);
    expect(await database.DB.prepare("SELECT status, error FROM webhook_events WHERE id = ?").bind(poisonId).first()).toEqual({ status: "processed", error: "Still broken — discarded by operator" });
    const auditCount = await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = ? AND target_id = ?").bind("tonomo_event.discard", poisonId).first<{ count: number }>();
    const discardedAgain = await SELF.fetch(`https://portal.test/api/admin/webhook-events/${poisonId}/discard`, { method: "POST", headers: { cookie } });
    expect(discardedAgain.status).toBe(409); await expect(discardedAgain.json()).resolves.toEqual({ error: "Event is no longer poison" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = ? AND target_id = ?").bind("tonomo_event.discard", poisonId).first()).toEqual(auditCount);
  });

  // `rendition_dlq_events.assetId` carries no FK — DLQ events can be recorded for a malformed
  // payload with no real asset behind it at all — but the replay endpoint now requires the asset
  // to actually still exist (see the DLQ replay asset-existence guard), so these tests need a real
  // seeded row, not just a synthetic UUID standing in for one.
  async function seedMinimalAsset() {
    const adminCookie = await sessionCookie(adminToken);
    const projectResponse = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ street: `DLQ replay ${crypto.randomUUID()}`, orderedServices: [], photographerUserIds: [firstPhotographerId] }),
    });
    expect(projectResponse.status).toBe(201);
    const project = await projectResponse.json() as { id: string };
    const collection = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const assetId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(assetId, collection!.id, `tests/${assetId}.jpg`, "dlq-replay.jpg", 1024, "upload", now, now).run();
    return assetId;
  }

  it("lists, replays, and discards rendition dead-letter events, gated to admin", async () => {
    const cookie = await sessionCookie(adminToken);
    const openId = crypto.randomUUID(); const assetId = await seedMinimalAsset(); const now = Date.now();
    await database.DB.prepare("INSERT INTO rendition_dlq_events (id, asset_id, status, received_at) VALUES (?, ?, 'open', ?)").bind(openId, assetId, now).run();

    const photographerCookie = await sessionCookie(photographerToken);
    const forbidden = await SELF.fetch("https://portal.test/api/admin/renditions-dlq", { headers: { cookie: photographerCookie } });
    expect(forbidden.status).toBe(403);
    const replayForbidden = await SELF.fetch(`https://portal.test/api/admin/renditions-dlq/${openId}/replay`, { method: "POST", headers: { cookie: photographerCookie } });
    expect(replayForbidden.status).toBe(403);
    const discardForbidden = await SELF.fetch(`https://portal.test/api/admin/renditions-dlq/${openId}/discard`, { method: "POST", headers: { cookie: photographerCookie } });
    expect(discardForbidden.status).toBe(403);

    const listed = await SELF.fetch("https://portal.test/api/admin/renditions-dlq", { headers: { cookie } });
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({ events: expect.arrayContaining([expect.objectContaining({ id: openId, assetId, status: "open" })]), openCount: expect.any(Number) });

    const replayed = await SELF.fetch(`https://portal.test/api/admin/renditions-dlq/${openId}/replay`, { method: "POST", headers: { cookie } });
    expect(replayed.status).toBe(200);
    expect(await database.DB.prepare("SELECT status FROM rendition_dlq_events WHERE id = ?").bind(openId).first()).toEqual({ status: "replayed" });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = ? AND target_id = ?").bind("rendition.dlq.replay", openId).first()).toEqual({ count: 1 });

    const replayAgain = await SELF.fetch(`https://portal.test/api/admin/renditions-dlq/${openId}/replay`, { method: "POST", headers: { cookie } });
    expect(replayAgain.status).toBe(409);

    const secondId = crypto.randomUUID(); const secondAsset = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO rendition_dlq_events (id, asset_id, status, received_at) VALUES (?, ?, 'open', ?)").bind(secondId, secondAsset, now + 1).run();
    const discarded = await SELF.fetch(`https://portal.test/api/admin/renditions-dlq/${secondId}/discard`, { method: "POST", headers: { cookie } });
    expect(discarded.status).toBe(200);
    expect(await database.DB.prepare("SELECT status FROM rendition_dlq_events WHERE id = ?").bind(secondId).first()).toEqual({ status: "discarded" });
    const discardAgain = await SELF.fetch(`https://portal.test/api/admin/renditions-dlq/${secondId}/discard`, { method: "POST", headers: { cookie } });
    expect(discardAgain.status).toBe(409);
  });

  it("lets only one of two concurrent rendition-DLQ replays claim the same open row", async () => {
    const cookie = await sessionCookie(adminToken);
    const raceId = crypto.randomUUID(); const raceAsset = await seedMinimalAsset();
    await database.DB.prepare("INSERT INTO rendition_dlq_events (id, asset_id, status, received_at) VALUES (?, ?, 'open', ?)").bind(raceId, raceAsset, Date.now()).run();
    const replay = () => SELF.fetch(`https://portal.test/api/admin/renditions-dlq/${raceId}/replay`, { method: "POST", headers: { cookie } });
    const [first, second] = await Promise.all([replay(), replay()]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await database.DB.prepare("SELECT status FROM rendition_dlq_events WHERE id = ?").bind(raceId).first()).toEqual({ status: "replayed" });
  });

  // The HTTP-level race above depends on the two fetches actually interleaving, which isn't
  // guaranteed by Promise.all alone. This asserts the underlying guarantee directly: D1/SQLite
  // serializes writes to the same row, so of two concurrent `UPDATE ... WHERE status = 'open'`
  // statements issued against the same row, exactly one can ever report a changed row.
  it("guarantees the guarded status-transition UPDATE only ever wins for one concurrent writer", async () => {
    const raceId = crypto.randomUUID(); const raceAsset = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO rendition_dlq_events (id, asset_id, status, received_at) VALUES (?, ?, 'open', ?)").bind(raceId, raceAsset, Date.now()).run();
    const attempt = () => database.DB.prepare("UPDATE rendition_dlq_events SET status = 'replayed', resolved_at = ? WHERE id = ? AND status = 'open'").bind(Date.now(), raceId).run();
    const [a, b] = await Promise.all([attempt(), attempt()]);
    expect([a.meta.changes, b.meta.changes].sort()).toEqual([0, 1]);
  });

  it("refuses to replay a DLQ event with no valid asset id, but allows discarding it", async () => {
    const cookie = await sessionCookie(adminToken);
    const brokenId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO rendition_dlq_events (id, asset_id, status, received_at) VALUES (?, 'unparseable-dlq-body', 'open', ?)").bind(brokenId, Date.now()).run();
    const replay = await SELF.fetch(`https://portal.test/api/admin/renditions-dlq/${brokenId}/replay`, { method: "POST", headers: { cookie } });
    expect(replay.status).toBe(409);
    expect(await database.DB.prepare("SELECT status FROM rendition_dlq_events WHERE id = ?").bind(brokenId).first()).toEqual({ status: "open" });
    const discarded = await SELF.fetch(`https://portal.test/api/admin/renditions-dlq/${brokenId}/discard`, { method: "POST", headers: { cookie } });
    expect(discarded.status).toBe(200);
  });

  it("reverts a claimed rendition-DLQ replay back to open when the queue send itself fails", async () => {
    const cookie = await sessionCookie(adminToken);
    const failId = crypto.randomUUID(); const failAsset = await seedMinimalAsset();
    await database.DB.prepare("INSERT INTO rendition_dlq_events (id, asset_id, status, received_at) VALUES (?, ?, 'open', ?)").bind(failId, failAsset, Date.now()).run();
    // A per-request env override (bypassing SELF.fetch's fixed worker binding) is the only way
    // to make just this one request's queue send throw while every other test keeps a working
    // binding — same pattern as workers/app/test/integrations.test.ts.
    const throwingQueueEnv: Env = { ...authEnv, RENDITION_QUEUE: { send: async () => { throw new Error("queue unavailable"); } } as never };
    const executionContext = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: undefined } as unknown as ExecutionContext;
    const response = await app.fetch(
      new Request(`https://portal.test/api/admin/renditions-dlq/${failId}/replay`, { method: "POST", headers: { cookie, origin: authEnv.APP_ORIGIN } }),
      throwingQueueEnv,
      executionContext,
    );
    expect(response.status).toBe(502);
    expect(await database.DB.prepare("SELECT status, resolved_at FROM rendition_dlq_events WHERE id = ?").bind(failId).first()).toEqual({ status: "open", resolved_at: null });
  });

  it("manages and edits manual collection links while preserving immutable Tonomo links", async () => {
    type LinkRow = { id: string; collection_id: string; url: string; label: string | null; source: string; position: number; created_at: number; updated_at: number };
    type UpdateAudit = { actor_id: string | null; action: string; target_type: string; target_id: string | null; meta_json: string | null };
    const adminCookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: `Link collection ${crypto.randomUUID()}`, orderedServices: ["video"], photographerUserIds: [firstPhotographerId] }) });
    expect(created.status).toBe(201); const project = await created.json() as { id: string };
    const patchLink = (projectId: string, linkId: string, body: unknown, cookie = adminCookie) => SELF.fetch(`https://portal.test/api/projects/${projectId}/links/${linkId}`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    const addLink = async (projectId: string, collection: "video" | "floorplan" | "copy", url: string, label?: string) => {
      const response = await SELF.fetch(`https://portal.test/api/projects/${projectId}/links`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ collection, url, ...(label === undefined ? {} : { label }) }) });
      expect(response.status).toBe(201);
      return response.json() as Promise<{ id: string; url: string; label: string | null; source: string; position: number; createdAt: string }>;
    };
    const readLink = (linkId: string) => database.DB.prepare("SELECT id, collection_id, url, label, source, position, created_at, updated_at FROM collection_links WHERE id = ?").bind(linkId).first<LinkRow>();
    const updateAudits = (linkId: string) => database.DB.prepare("SELECT actor_id, action, target_type, target_id, meta_json FROM audit_log WHERE action = 'collection_link.update' AND target_id = ? ORDER BY rowid").bind(linkId).all<UpdateAudit>();
    const expectUnchanged = async (projectId: string, linkId: string, body: unknown, status: number, cookie = adminCookie) => {
      const before = await readLink(linkId); const beforeAudits = (await updateAudits(linkId)).results.length;
      const response = await patchLink(projectId, linkId, body, cookie);
      expect(response.status).toBe(status);
      expect(await readLink(linkId)).toEqual(before);
      expect((await updateAudits(linkId)).results).toHaveLength(beforeAudits);
      return response;
    };
    const manual = await addLink(project.id, "video", "https://vimeo.com/123456", "Walkthrough");
    expect(manual.source).toBe("manual");
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = ? AND target_id = ?").bind("collection_link.create", manual.id).first()).toEqual({ count: 1 });
    const video = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = ?").bind(project.id, "video").first<{ id: string }>();
    const initialCollectionState = await database.DB.prepare("SELECT received_count, status FROM collections WHERE id = ?").bind(video!.id).first<{ received_count: number; status: string }>();
    expect(initialCollectionState).toEqual({ received_count: 1, status: "received" });

    const fixedCreatedAt = Date.UTC(2020, 0, 2);
    const updatedUrl = "https://vimeo.com/123457";
    await database.DB.prepare("UPDATE collection_links SET created_at = ?, updated_at = ? WHERE id = ?").bind(fixedCreatedAt, 1, manual.id).run();
    const firstPatch = await patchLink(project.id, manual.id, { url: updatedUrl, label: "Final walkthrough" });
    expect(firstPatch.status).toBe(200);
    await expect(firstPatch.json()).resolves.toEqual({ id: manual.id, url: updatedUrl, label: "Final walkthrough", source: "manual", position: manual.position, createdAt: new Date(fixedCreatedAt).toISOString() });
    const firstSaved = await readLink(manual.id);
    expect(firstSaved).toMatchObject({ id: manual.id, url: updatedUrl, label: "Final walkthrough", source: "manual", created_at: fixedCreatedAt });
    expect(firstSaved!.updated_at).toBeGreaterThan(1);
    expect(await database.DB.prepare("SELECT received_count, status FROM collections WHERE id = ?").bind(video!.id).first()).toEqual(initialCollectionState);
    const firstAudits = await updateAudits(manual.id);
    expect(firstAudits.results).toHaveLength(1);
    expect(firstAudits.results[0]).toMatchObject({ actor_id: seedAdminId, action: "collection_link.update", target_type: "collection_link", target_id: manual.id });
    expect(JSON.parse(firstAudits.results[0]!.meta_json!)).toEqual({ projectId: project.id, previous: { url: "https://vimeo.com/123456", label: "Walkthrough" }, updated: { url: updatedUrl, label: "Final walkthrough" } });

    await database.DB.prepare("UPDATE collection_links SET updated_at = ? WHERE id = ?").bind(1, manual.id).run();
    const clearLabel = await patchLink(project.id, manual.id, { url: updatedUrl });
    expect(clearLabel.status).toBe(200);
    await expect(clearLabel.json()).resolves.toMatchObject({ id: manual.id, url: updatedUrl, label: null, source: "manual", position: manual.position, createdAt: new Date(fixedCreatedAt).toISOString() });
    expect((await readLink(manual.id))!.label).toBeNull();
    expect((await updateAudits(manual.id)).results).toHaveLength(2);
    expect(JSON.parse((await updateAudits(manual.id)).results[1]!.meta_json!)).toEqual({ projectId: project.id, previous: { url: updatedUrl, label: "Final walkthrough" }, updated: { url: updatedUrl, label: null } });

    await database.DB.prepare("UPDATE collection_links SET updated_at = ? WHERE id = ?").bind(1, manual.id).run();
    const labelOnly = await patchLink(project.id, manual.id, { url: updatedUrl, label: "Corrected label" });
    expect(labelOnly.status).toBe(200);
    const labelOnlySaved = await readLink(manual.id);
    expect(labelOnlySaved).toMatchObject({ url: updatedUrl, label: "Corrected label", created_at: fixedCreatedAt });
    expect(labelOnlySaved!.updated_at).toBeGreaterThan(1);
    const labelOnlyAudits = await updateAudits(manual.id);
    expect(labelOnlyAudits.results).toHaveLength(3);
    expect(JSON.parse(labelOnlyAudits.results[2]!.meta_json!)).toEqual({ projectId: project.id, previous: { url: updatedUrl, label: null }, updated: { url: updatedUrl, label: "Corrected label" } });

    for (const invalidLabel of ["", "   ", null]) {
      await expectUnchanged(project.id, manual.id, { url: updatedUrl, label: invalidLabel }, 400);
    }
    await expectUnchanged(project.id, manual.id, { url: "http://vimeo.com/not-https", label: "Still valid" }, 400);
    await expectUnchanged(project.id, manual.id, { url: updatedUrl, label: "Photographer cannot edit" }, 403, await sessionCookie(firstPhotographerToken));

    const outsideProjectResponse = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: `Outside link ${crypto.randomUUID()}`, orderedServices: ["video"] }) });
    expect(outsideProjectResponse.status).toBe(201); const outsideProject = await outsideProjectResponse.json() as { id: string };
    const outsideLink = await addLink(outsideProject.id, "video", "https://vimeo.com/outside", "Outside");
    await expectUnchanged(project.id, outsideLink.id, { url: "https://vimeo.com/outside-new", label: "No access" }, 404);

    const floorplanLink = await addLink(project.id, "floorplan", "https://example.com/floorplan", "Floorplan");
    await expectUnchanged(project.id, floorplanLink.id, { url: "https://example.com/floorplan-new", label: "Still floorplan" }, 404);

    const tonomoId = crypto.randomUUID(); const tonomoNow = Date.now();
    await database.DB.prepare("INSERT INTO collection_links (id, collection_id, url, label, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(tonomoId, video!.id, "https://dropbox.com/s/finished", "Tonomo delivery", "tonomo", tonomoNow, tonomoNow).run();
    const tonomoPatch = await expectUnchanged(project.id, tonomoId, { url: "https://dropbox.com/s/finished-new", label: "No edit" }, 409);
    await expect(tonomoPatch.json()).resolves.toEqual({ error: "Tonomo delivery links are immutable" });

    const collision = await addLink(project.id, "video", "https://vimeo.com/collision", "Other link");
    const manualBeforeCollision = await readLink(manual.id); const collisionBefore = await readLink(collision.id);
    const manualCollisionAudits = (await updateAudits(manual.id)).results.length; const collisionAudits = (await updateAudits(collision.id)).results.length;
    const collisionResponse = await patchLink(project.id, manual.id, { url: collision.url, label: "Collision" });
    expect(collisionResponse.status).toBe(409);
    await expect(collisionResponse.json()).resolves.toEqual({ error: "A link with this URL already exists in this collection" });
    expect(await readLink(manual.id)).toEqual(manualBeforeCollision);
    expect(await readLink(collision.id)).toEqual(collisionBefore);
    expect((await updateAudits(manual.id)).results).toHaveLength(manualCollisionAudits);
    expect((await updateAudits(collision.id)).results).toHaveLength(collisionAudits);

    const deletedRace = await addLink(project.id, "video", "https://vimeo.com/race-delete", "Delete me");
    const deletedRaceResponse = await requestWithDbBatchFault(`/api/projects/${project.id}/links/${deletedRace.id}`, adminCookie, { url: "https://vimeo.com/race-delete-new", label: "Too late" }, async (db) => {
      await db.prepare("DELETE FROM collection_links WHERE id = ?").bind(deletedRace.id).run();
    });
    expect(deletedRaceResponse.status).toBe(404);
    await expect(deletedRaceResponse.json()).resolves.toEqual({ error: "Link not found" });
    expect(await readLink(deletedRace.id)).toBeNull();
    expect((await updateAudits(deletedRace.id)).results).toHaveLength(0);

    const sourceRace = await addLink(project.id, "video", "https://vimeo.com/race-source", "Source changes");
    const sourceBeforeRace = await readLink(sourceRace.id);
    const sourceRaceResponse = await requestWithDbBatchFault(`/api/projects/${project.id}/links/${sourceRace.id}`, adminCookie, { url: "https://vimeo.com/race-source-new", label: "Too late" }, async (db) => {
      await db.prepare("UPDATE collection_links SET source = 'tonomo' WHERE id = ?").bind(sourceRace.id).run();
    });
    expect(sourceRaceResponse.status).toBe(409);
    await expect(sourceRaceResponse.json()).resolves.toEqual({ error: "Tonomo delivery links are immutable" });
    expect(await readLink(sourceRace.id)).toEqual({ ...sourceBeforeRace, source: "tonomo" });
    expect((await updateAudits(sourceRace.id)).results).toHaveLength(0);

    const snapshotRace = await addLink(project.id, "video", "https://vimeo.com/race-snapshot", "Snapshot before");
    const snapshotRaceResponse = await requestWithDbBatchFault(`/api/projects/${project.id}/links/${snapshotRace.id}`, adminCookie, { url: "https://vimeo.com/race-snapshot-new", label: "Request value" }, async (db) => {
      await db.prepare("UPDATE collection_links SET label = ?, updated_at = ? WHERE id = ?").bind("Concurrent value", 7, snapshotRace.id).run();
    });
    expect(snapshotRaceResponse.status).toBe(409);
    await expect(snapshotRaceResponse.json()).resolves.toEqual({ error: "This link changed while you were editing; reload and try again" });
    expect(await readLink(snapshotRace.id)).toMatchObject({ url: "https://vimeo.com/race-snapshot", label: "Concurrent value", source: "manual" });
    expect((await updateAudits(snapshotRace.id)).results).toHaveLength(0);

    const concurrentCollision = await addLink(project.id, "video", "https://vimeo.com/race-collision-original", "Original");
    const concurrentCollisionTarget = "https://vimeo.com/race-collision-target";
    const concurrentCollisionResponse = await requestWithDbBatchFault(`/api/projects/${project.id}/links/${concurrentCollision.id}`, adminCookie, { url: concurrentCollisionTarget, label: "Request value" }, async (db) => {
      const now = Date.now();
      await db.prepare("INSERT INTO collection_links (id, collection_id, url, label, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'manual', ?, ?)").bind(crypto.randomUUID(), video!.id, concurrentCollisionTarget, "Concurrent winner", now, now).run();
    });
    expect(concurrentCollisionResponse.status).toBe(409);
    await expect(concurrentCollisionResponse.json()).resolves.toEqual({ error: "A link with this URL already exists in this collection" });
    expect(await readLink(concurrentCollision.id)).toMatchObject({ url: "https://vimeo.com/race-collision-original", label: "Original", source: "manual" });
    expect((await updateAudits(concurrentCollision.id)).results).toHaveLength(0);

    // The concurrentCollision race case above injects an extra row directly via raw SQL
    // (simulating a concurrent writer), which never passes through a receivedCount recompute.
    // The cached `collections.received_count` is therefore stale by that one row, so the
    // post-delete expectation must be derived from a live row count, not `cached - 1`.
    const linksBeforeManualDelete = await database.DB.prepare("SELECT count(*) AS count FROM collection_links WHERE collection_id = ?").bind(video!.id).first<{ count: number }>();
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/links/${manual.id}`, { method: "DELETE", headers: { cookie: adminCookie } })).status).toBe(204);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = ? AND target_id = ?").bind("collection_link.delete", manual.id).first()).toEqual({ count: 1 });
    const beforeManualDelete = { received_count: linksBeforeManualDelete!.count - 1 };
    expect(await database.DB.prepare("SELECT received_count FROM collections WHERE id = ?").bind(video!.id).first()).toEqual({ received_count: beforeManualDelete.received_count });
    const replacement = await SELF.fetch(`https://portal.test/api/projects/${project.id}/links`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ collection: "video", url: "https://vimeo.com/123456", label: "Walkthrough" }) });
    expect(replacement.status).toBe(201); const replacementLink = await replacement.json() as { id: string };
    const listed = await SELF.fetch(`https://portal.test/api/projects/${project.id}/links?collection=video`, { headers: { cookie: adminCookie } });
    await expect(listed.json()).resolves.toMatchObject({ links: expect.arrayContaining([expect.objectContaining({ id: replacementLink.id, source: "manual" }), expect.objectContaining({ id: tonomoId, source: "tonomo" })]) });
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/links/${replacementLink.id}`, { method: "DELETE", headers: { cookie: adminCookie } })).status).toBe(204);
    // replacement was added then deleted, netting to the same count as right after manual's delete.
    expect(await database.DB.prepare("SELECT received_count, status FROM collections WHERE id = ?").bind(video!.id).first()).toEqual({ received_count: beforeManualDelete.received_count, status: "received" });
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/links/${tonomoId}`, { method: "DELETE", headers: { cookie: adminCookie } })).status).toBe(409);
    const photographer = await SELF.fetch(`https://portal.test/api/projects/${project.id}/links`, { method: "POST", headers: { cookie: await sessionCookie(firstPhotographerToken), "content-type": "application/json" }, body: JSON.stringify({ collection: "video", url: "https://vimeo.com/forbidden" }) });
    expect(photographer.status).toBe(403);
  });

  it("recognizes a collection-link unique conflict in a nested D1 cause", () => {
    const nested = Object.assign(new Error("Failed query"), { cause: new Error("UNIQUE constraint failed: collection_links.collection_id, collection_links.url") });
    expect(collectionLinkUrlConflict(nested)).toBe(true);
    expect(collectionLinkUrlConflict(new Error("UNIQUE constraint failed: other_table.value"))).toBe(false);
  });

  it("treats an already-current Video link reorder as a successful no-op", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: `Current link order ${crypto.randomUUID()}`, orderedServices: ["video"] }) });
    expect(created.status).toBe(201); const project = await created.json() as { id: string };
    const add = async (suffix: string) => {
      const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}/links`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ collection: "video", url: `https://example.test/current-order-${suffix}` }) });
      expect(response.status).toBe(201); return response.json() as Promise<{ id: string }>;
    };
    const first = await add("first"); const second = await add("second");
    const reorder = () => SELF.fetch(`https://portal.test/api/projects/${project.id}/links/${second.id}/reorder`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ beforeId: null, afterId: first.id }) });
    expect((await reorder()).status).toBe(200);
    const beforeAudit = await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'collection_link.reorder' AND target_id = ?").bind(second.id).first();
    const beforeActivity = await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ? AND event_type = 'project.collection.video_links_reordered'").bind(project.id).first();
    const beforeOutbox = await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(project.id).first();
    const retry = await reorder();
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual({ position: 0 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'collection_link.reorder' AND target_id = ?").bind(second.id).first()).toEqual(beforeAudit);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM project_activity_events WHERE project_id = ? AND event_type = 'project.collection.video_links_reordered'").bind(project.id).first()).toEqual(beforeActivity);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM notification_outbox WHERE project_id = ?").bind(project.id).first()).toEqual(beforeOutbox);
  });

  it("reorders mixed Video links with guarded canonical positions and rejects stale snapshots", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: `Reorder collection ${crypto.randomUUID()}`, orderedServices: ["video"], photographerUserIds: [firstPhotographerId] }) });
    expect(created.status).toBe(201); const project = await created.json() as { id: string };
    const add = async (url: string) => {
      const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}/links`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ collection: "video", url }) });
      expect(response.status).toBe(201); return response.json() as Promise<{ id: string; position: number }>;
    };
    const first = await add("https://example.test/first"); const second = await add("https://example.test/second");
    const video = await database.DB.prepare("SELECT id, received_count FROM collections WHERE project_id = ? AND kind = 'video'").bind(project.id).first<{ id: string; received_count: number }>();
    const tonomoId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO collection_links (id, collection_id, url, label, source, position, created_at, updated_at) VALUES (?, ?, ?, 'Tonomo', 'tonomo', 3072, ?, ?)").bind(tonomoId, video!.id, "https://example.test/tonomo", now, now).run();
    await database.DB.prepare("UPDATE collections SET received_count = 3 WHERE id = ?").bind(video!.id).run();
    const reorder = (linkId: string, beforeId: string | null, afterId: string | null) => SELF.fetch(`https://portal.test/api/projects/${project.id}/links/${linkId}/reorder`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ beforeId, afterId }) });
    const middle = await reorder(tonomoId, first.id, second.id);
    expect(middle.status).toBe(200); await expect(middle.json()).resolves.toEqual({ position: 1536 });
    const listed = await SELF.fetch(`https://portal.test/api/projects/${project.id}/links?collection=video`, { headers: { cookie: adminCookie } });
    await expect(listed.json()).resolves.toMatchObject({ links: [{ id: first.id, position: 1024 }, { id: tonomoId, position: 1536 }, { id: second.id, position: 2048 }] });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'collection_link.reorder' AND target_id = ?").bind(tonomoId).first()).toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT url, label, source FROM collection_links WHERE id = ?").bind(tonomoId).first()).toEqual({ url: "https://example.test/tonomo", label: "Tonomo", source: "tonomo" });
    expect(await database.DB.prepare("SELECT received_count FROM collections WHERE id = ?").bind(video!.id).first()).toEqual({ received_count: 3 });
    expect((await reorder(tonomoId, second.id, null)).status).toBe(200);
    expect((await reorder(tonomoId, null, first.id)).status).toBe(200);
    expect((await reorder(tonomoId, first.id, tonomoId)).status).toBe(400);
    expect((await reorder(tonomoId, first.id, first.id)).status).toBe(400);
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/links/${tonomoId}`, { method: "PATCH", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ url: "https://example.test/no", label: "No" }) })).status).toBe(409);
    const stale = await requestWithDbBatchFault(`/api/projects/${project.id}/links/${first.id}/reorder`, adminCookie, { beforeId: null, afterId: second.id }, async (db) => {
      await db.prepare("UPDATE collection_links SET position = 9999 WHERE id = ?").bind(second.id).run();
    }, "POST");
    expect(stale.status).toBe(409);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'collection_link.reorder' AND target_id = ?").bind(first.id).first()).toEqual({ count: 0 });

    // Equal adjacent positions can arrive from concurrent appends. A single UPDATE uses the
    // JSON mapping only to assign the rebase positions; its guards validate the captured rows
    // and require at least one row to move, rather than comparing serialized whole-sequence JSON.
    await database.DB.prepare("UPDATE collection_links SET position = 1024 WHERE collection_id = ?").bind(video!.id).run();
    const tiedRows = await database.DB.prepare("SELECT id FROM collection_links WHERE collection_id = ? ORDER BY position, id").bind(video!.id).all<{ id: string }>();
    const unchangedId = tiedRows.results[1]!.id;
    const unchangedBefore = await database.DB.prepare("SELECT position, updated_at FROM collection_links WHERE id = ?").bind(unchangedId).first<{ position: number; updated_at: number }>();
    const rebase = await reorder(tiedRows.results[0]!.id, tiedRows.results[1]!.id, tiedRows.results[2]!.id);
    expect(rebase.status).toBe(200);
    expect(await database.DB.prepare("SELECT position FROM collection_links WHERE collection_id = ? ORDER BY position, id").bind(video!.id).all()).toMatchObject({ results: [{ position: 1024 }, { position: 2048 }, { position: 3072 }] });
    expect(await database.DB.prepare("SELECT position, updated_at FROM collection_links WHERE id = ?").bind(unchangedId).first()).toEqual(unchangedBefore);
  });

  it("rebases tied Video links with a constant parameter count independent of row count", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const createTiedCollection = async (count: number) => {
      const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: `Bound rebase ${count} ${crypto.randomUUID()}`, orderedServices: ["video"], photographerUserIds: [firstPhotographerId] }) });
      expect(created.status).toBe(201); const project = await created.json() as { id: string };
      const collection = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'video'").bind(project.id).first<{ id: string }>();
      const now = Date.now(); const ids = Array.from({ length: count }, () => crypto.randomUUID());
      await database.DB.batch(ids.map((id, index) => database.DB.prepare("INSERT INTO collection_links (id, collection_id, url, label, source, position, created_at, updated_at) VALUES (?, ?, ?, ?, 'manual', 1024, ?, ?)").bind(id, collection!.id, `https://example.test/bound-${count}-${index}`, `Bound ${index}`, now, now)));
      return { project, collection: collection!, ids: (await database.DB.prepare("SELECT id FROM collection_links WHERE collection_id = ? ORDER BY position, id").bind(collection!.id).all<{ id: string }>()).results };
    };
    const small = await createTiedCollection(3); const large = await createTiedCollection(24);
    const bindCounts: number[] = [];
    const reorder = async ({ project, ids }: { project: { id: string }; ids: { id: string }[] }) => requestWithRebaseBindSpy(`/api/projects/${project.id}/links/${ids[0]!.id}/reorder`, adminCookie, { beforeId: ids[1]!.id, afterId: ids[2]!.id }, bindCounts);

    expect((await reorder(small)).status).toBe(200);
    expect((await reorder(large)).status).toBe(200);
    expect(bindCounts).toHaveLength(2);
    expect(bindCounts[1]).toBe(bindCounts[0]);
    expect(bindCounts[0]).toBeGreaterThan(0);
    const ordered = await database.DB.prepare("SELECT id, position FROM collection_links WHERE collection_id = ? ORDER BY position, id").bind(large.collection.id).all<{ id: string; position: number }>();
    expect(ordered.results).toEqual([
      { id: large.ids[1]!.id, position: 1024 },
      { id: large.ids[0]!.id, position: 2048 },
      ...large.ids.slice(2).map((row, index) => ({ id: row.id, position: (index + 3) * 1024 })),
    ]);
  });

  it("rejects a tied-rebase race atomically without changing positions or writing an audit record", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: `Tied rebase race ${crypto.randomUUID()}`, orderedServices: ["video"], photographerUserIds: [firstPhotographerId] }) });
    expect(created.status).toBe(201); const project = await created.json() as { id: string };
    const video = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'video'").bind(project.id).first<{ id: string }>();
    const now = Date.now(); const ids = Array.from({ length: 3 }, () => crypto.randomUUID());
    await database.DB.batch(ids.map((id, index) => database.DB.prepare("INSERT INTO collection_links (id, collection_id, url, label, source, position, created_at, updated_at) VALUES (?, ?, ?, ?, 'manual', 1024, ?, ?)").bind(id, video!.id, `https://example.test/tied-race-${index}`, null, now, now)));
    const orderedIds = (await database.DB.prepare("SELECT id FROM collection_links WHERE collection_id = ? ORDER BY position, id").bind(video!.id).all<{ id: string }>()).results.map((row) => row.id);
    let positionsAtUpdate: { id: string; position: number }[] = [];
    const response = await requestWithDbBatchFault(`/api/projects/${project.id}/links/${orderedIds[0]!}/reorder`, adminCookie, { beforeId: orderedIds[1]!, afterId: orderedIds[2]! }, async (db) => {
      await db.prepare("INSERT INTO collection_links (id, collection_id, url, label, source, position, created_at, updated_at) VALUES (?, ?, ?, NULL, 'manual', 1024, ?, ?)").bind(crypto.randomUUID(), video!.id, "https://example.test/tied-race-concurrent", now, now).run();
      positionsAtUpdate = (await db.prepare("SELECT id, position FROM collection_links WHERE collection_id = ? ORDER BY position, id").bind(video!.id).all<{ id: string; position: number }>()).results;
    }, "POST");

    expect(response.status).toBe(409);
    expect((await database.DB.prepare("SELECT id, position FROM collection_links WHERE collection_id = ? ORDER BY position, id").bind(video!.id).all<{ id: string; position: number }>()).results).toEqual(positionsAtUpdate);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'collection_link.reorder' AND target_id = ?").bind(orderedIds[0]!).first()).toEqual({ count: 0 });
  });

  it("validates Video reorder inputs, access, scope, and stale non-adjacent neighbor pairs", async () => {
    const adminCookie = await sessionCookie(adminToken); const photographerCookie = await sessionCookie(firstPhotographerToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: `Reorder validation ${crypto.randomUUID()}`, orderedServices: ["video"], photographerUserIds: [firstPhotographerId] }) });
    expect(created.status).toBe(201); const project = await created.json() as { id: string };
    const add = async (collection: "video" | "floorplan" | "copy", suffix: string) => {
      const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}/links`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ collection, url: `https://example.test/${suffix}` }) });
      expect(response.status).toBe(201); return response.json() as Promise<{ id: string }>;
    };
    const first = await add("video", "validation-first"); const second = await add("video", "validation-second"); const third = await add("video", "validation-third"); const fourth = await add("video", "validation-fourth");
    const floorplan = await add("floorplan", "validation-floorplan"); const copy = await add("copy", "validation-copy");
    const reorder = (linkId: string, body: unknown, cookie = adminCookie) => SELF.fetch(`https://portal.test/api/projects/${project.id}/links/${linkId}/reorder`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await reorder(first.id, {})).status).toBe(400);
    expect((await reorder(first.id, { beforeId: "not-a-uuid", afterId: null })).status).toBe(400);
    expect((await reorder(first.id, { beforeId: null, afterId: null }, photographerCookie)).status).toBe(403);
    expect((await reorder(first.id, { beforeId: crypto.randomUUID(), afterId: null })).status).toBe(404);
    // Both-null claims "I'm the only link left" — reject it against this 4-link collection
    // instead of only exercising both-null via the 403/404 cases above.
    expect((await reorder(first.id, { beforeId: null, afterId: null })).status).toBe(409);
    const otherCreated = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: `Cross-project neighbor ${crypto.randomUUID()}`, orderedServices: ["video"], photographerUserIds: [firstPhotographerId] }) });
    expect(otherCreated.status).toBe(201); const otherProject = await otherCreated.json() as { id: string };
    const otherLinkResponse = await SELF.fetch(`https://portal.test/api/projects/${otherProject.id}/links`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ collection: "video", url: "https://example.test/cross-project-neighbor" }) });
    expect(otherLinkResponse.status).toBe(201); const otherLink = await otherLinkResponse.json() as { id: string };
    expect((await reorder(first.id, { beforeId: otherLink.id, afterId: null })).status).toBe(404);
    expect((await reorder(floorplan.id, { beforeId: null, afterId: null })).status).toBe(404);
    expect((await reorder(copy.id, { beforeId: null, afterId: null })).status).toBe(404);
    await database.DB.prepare("UPDATE collection_links SET position = 1536 WHERE id = ?").bind(third.id).run();
    const stale = await reorder(fourth.id, { beforeId: first.id, afterId: second.id });
    expect(stale.status).toBe(409);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'collection_link.reorder' AND target_id = ?").bind(fourth.id).first()).toEqual({ count: 0 });
  });

  it("rejects an ordinary guarded-update race without changing any positions or writing an audit record", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: `Ordinary reorder race ${crypto.randomUUID()}`, orderedServices: ["video"], photographerUserIds: [firstPhotographerId] }) });
    expect(created.status).toBe(201); const project = await created.json() as { id: string };
    const add = async (suffix: string) => {
      const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}/links`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ collection: "video", url: `https://example.test/ordinary-race-${suffix}` }) });
      expect(response.status).toBe(201); return response.json() as Promise<{ id: string }>;
    };
    const first = await add("first"); await add("second"); const third = await add("third");
    const video = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'video'").bind(project.id).first<{ id: string }>();
    let positionsAtUpdate: { id: string; position: number }[] = [];
    const response = await requestWithDbBatchFault(`/api/projects/${project.id}/links/${third.id}/reorder`, adminCookie, { beforeId: null, afterId: first.id }, async (db) => {
      await db.prepare("INSERT INTO collection_links (id, collection_id, url, label, source, position, created_at, updated_at) VALUES (?, ?, ?, NULL, 'manual', 4096, ?, ?)").bind(crypto.randomUUID(), video!.id, "https://example.test/ordinary-race-concurrent", Date.now(), Date.now()).run();
      positionsAtUpdate = (await db.prepare("SELECT id, position FROM collection_links WHERE collection_id = ? ORDER BY position, id").bind(video!.id).all<{ id: string; position: number }>()).results;
    }, "POST");

    expect(response.status).toBe(409);
    expect((await database.DB.prepare("SELECT id, position FROM collection_links WHERE collection_id = ? ORDER BY position, id").bind(video!.id).all<{ id: string; position: number }>()).results).toEqual(positionsAtUpdate);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = 'collection_link.reorder' AND target_id = ?").bind(third.id).first()).toEqual({ count: 0 });
  });

  const documentDirectIt = process.env.DOCUMENT_DIRECT_TEST === "true" ? it : it.skip;
  documentDirectIt("reserves direct R2 document uploads, atomically pairs floorplan versions, and reconciles delivery counts", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Document collection", orderedServices: [], photographerUserIds: [firstPhotographerId] }) });
    expect(created.status).toBe(201); const project = await created.json() as { id: string };
    type Reserved = { sessionId: string; version: number; versionGroupId: string; files: { pdf: { key: string; assetId: string }; preview?: { key: string; assetId: string } } };
    const reserve = async (body: Record<string, unknown>, cookie = adminCookie) => SELF.fetch(`https://portal.test/api/projects/${project.id}/documents/presign`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    const put = (sessionId: string, slot: "pdf" | "preview", body: string, cookie = adminCookie) => SELF.fetch(`https://portal.test/api/projects/${project.id}/documents/direct/${sessionId}/${slot}`, { method: "PUT", headers: { cookie, "content-type": slot === "pdf" ? "application/pdf" : "image/jpeg" }, body });
    const complete = (sessionId: string, preview = false, cookie = adminCookie) => SELF.fetch(`https://portal.test/api/projects/${project.id}/documents/complete`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ sessionId, pdf: {}, ...(preview ? { preview: {} } : {}) }) });
    const floorplanInput = (pdf: string, preview: string, versionGroupId?: string) => ({ kind: "floorplan", versionGroupId, pdf: { filename: `floorplan-${pdf}.pdf`, bytes: pdf.length, contentType: "application/pdf" }, preview: { filename: `floorplan-${preview}.jpg`, bytes: preview.length, contentType: "image/jpeg" } });
    const copyInput = (pdf: string, versionGroupId?: string) => ({ kind: "copy_pdf", versionGroupId, pdf: { filename: `copy-${pdf}.pdf`, bytes: pdf.length, contentType: "application/pdf" } });

    expect((await reserve({ kind: "copy_pdf", pdf: { filename: "not-pdf.txt", bytes: 2, contentType: "text/plain" } })).status).toBe(400);
    expect((await reserve({ kind: "copy_pdf", pdf: { filename: "too-big.pdf", bytes: 50 * 1024 * 1024 + 1, contentType: "application/pdf" } })).status).toBe(400);
    expect((await reserve(copyInput("deny"), await sessionCookie(firstPhotographerToken))).status).toBe(403);

    const invalid = await reserve(copyInput("four")); expect(invalid.status).toBe(201); const invalidSession = await invalid.json() as Reserved;
    expect((await put(invalidSession.sessionId, "pdf", "bad")).status).toBe(204);
    expect((await complete(invalidSession.sessionId)).status).toBe(409); // R2 head bytes are server-verified before metadata exists.
    expect(await database.DB.prepare("SELECT count(*) AS count FROM assets WHERE r2_key = ?").bind(invalidSession.files.pdf.key).first()).toEqual({ count: 0 });
    const wrongMimeResponse = await reserve(copyInput("mime")); expect(wrongMimeResponse.status).toBe(201); const wrongMime = await wrongMimeResponse.json() as Reserved;
    await authEnv.MEDIA.put(wrongMime.files.pdf.key, "mime", { httpMetadata: { contentType: "text/plain" } });
    expect((await complete(wrongMime.sessionId)).status).toBe(409); // R2 content type is also checked against server-owned metadata.

    const missing = await reserve(floorplanInput("pdf", "jpg")); expect(missing.status).toBe(201); const missingSession = await missing.json() as Reserved;
    expect((await complete(missingSession.sessionId)).status).toBe(400); // The pair is a logical floorplan version.
    expect((await complete(missingSession.sessionId, true, await sessionCookie(otherAdminToken))).status).toBe(404); // session belongs to its presigning user.

    const floorplan1Response = await reserve(floorplanInput("one", "one")); expect(floorplan1Response.status).toBe(201); const floorplan1 = await floorplan1Response.json() as Reserved;
    expect((await put(floorplan1.sessionId, "pdf", "one")).status).toBe(204); expect((await put(floorplan1.sessionId, "preview", "one")).status).toBe(204);
    const v1Response = await complete(floorplan1.sessionId, true); expect(v1Response.status).toBe(201); const v1 = await v1Response.json() as { id: string; version: number; versionGroupId: string; preview: { id: string; version: number } };
    expect(v1).toMatchObject({ version: 1, versionGroupId: floorplan1.versionGroupId, preview: { version: 1 } });
    expect((await complete(floorplan1.sessionId, true)).status).toBe(200); // retry-safe completion

    const expiryRaceResponse = await reserve(copyInput("expiry-race")); expect(expiryRaceResponse.status).toBe(201); const expiryRace = await expiryRaceResponse.json() as Reserved;
    await put(expiryRace.sessionId, "pdf", "expiry-race");
    await database.DB.prepare("UPDATE document_uploads SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, expiryRace.sessionId).run();
    const expiryResults = await Promise.all([complete(expiryRace.sessionId), complete(expiryRace.sessionId)]);
    expect(expiryResults.map((response) => response.status)).toEqual([409, 409]);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM assets WHERE r2_key = ?").bind(expiryRace.files.pdf.key).first()).toEqual({ count: 0 });

    // Completing is leased, not a permanent version-group lock. The next presign acts as the
    // bounded reaper in this request-driven system and retries its (dev-direct) abort safely.
    const stalledResponse = await reserve(copyInput("stalled")); expect(stalledResponse.status).toBe(201); const stalled = await stalledResponse.json() as Reserved;
    await put(stalled.sessionId, "pdf", "stalled"); expect((await complete(stalled.sessionId)).status).toBe(409);
    await database.DB.prepare("UPDATE document_uploads SET completing_at = ? WHERE id = ?").bind(Date.now() - 16 * 60 * 1000, stalled.sessionId).run();
    expect((await reserve(copyInput("reaper-kick"))).status).toBe(201);
    expect(await database.DB.prepare("SELECT status FROM document_uploads WHERE id = ?").bind(stalled.sessionId).first()).toEqual({ status: "expired" });

    const archiveBlockResponse = await reserve(copyInput("archive-block")); expect(archiveBlockResponse.status).toBe(201); const archiveBlocked = await SELF.fetch(`https://portal.test/api/projects/${project.id}/archive`, { method: "POST", headers: { cookie: adminCookie } });
    expect(archiveBlocked.status).toBe(409);
    const archiveSession = await archiveBlockResponse.json() as Reserved;
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/documents/${archiveSession.sessionId}/abort`, { method: "POST", headers: { cookie: adminCookie } })).status).toBe(204);
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/archive`, { method: "POST", headers: { cookie: adminCookie } })).status).toBe(200);
    expect((await complete(archiveSession.sessionId)).status).toBe(409);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM assets WHERE id = ?").bind(archiveSession.files.pdf.assetId).first()).toEqual({ count: 0 });
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/restore`, { method: "POST", headers: { cookie: adminCookie } })).status).toBe(200);

    const simultaneousResponse = await reserve(copyInput("simultaneous")); expect(simultaneousResponse.status).toBe(201); const simultaneous = await simultaneousResponse.json() as Reserved;
    await put(simultaneous.sessionId, "pdf", "simultaneous");
    const simultaneousResults = await Promise.all([complete(simultaneous.sessionId), complete(simultaneous.sessionId)]);
    expect(simultaneousResults.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM assets WHERE id = ?").bind(simultaneous.files.pdf.assetId).first()).toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'document.complete'").bind(simultaneous.sessionId).first()).toEqual({ count: 1 });

    const floorplan2Response = await reserve(floorplanInput("two", "two", v1.versionGroupId)); expect(floorplan2Response.status).toBe(201); const floorplan2 = await floorplan2Response.json() as Reserved;
    expect(floorplan2.version).toBe(2); expect((await put(floorplan2.sessionId, "pdf", "two")).status).toBe(204); expect((await put(floorplan2.sessionId, "preview", "two")).status).toBe(204);
    const v2Response = await complete(floorplan2.sessionId, true); expect(v2Response.status).toBe(201); const v2 = await v2Response.json() as { id: string; version: number; versionGroupId: string; preview: { id: string; version: number } };
    expect(v2).toMatchObject({ version: 2, versionGroupId: v1.versionGroupId, preview: { version: 2 } });
    const concurrent = await Promise.all([reserve(floorplanInput("three", "three", v1.versionGroupId)), reserve(floorplanInput("four", "four", v1.versionGroupId))]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([201, 409]);

    const copy1Response = await reserve(copyInput("copy")); expect(copy1Response.status).toBe(201); const copy1 = await copy1Response.json() as Reserved; await put(copy1.sessionId, "pdf", "copy"); expect((await complete(copy1.sessionId)).status).toBe(201);
    const copy2Response = await reserve(copyInput("next", copy1.versionGroupId)); expect(copy2Response.status).toBe(201); const copy2 = await copy2Response.json() as Reserved; expect(copy2.version).toBe(2); await put(copy2.sessionId, "pdf", "next"); expect((await complete(copy2.sessionId)).status).toBe(201);

    const approved = await SELF.fetch(`https://portal.test/api/assets/${v2.id}/review`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ decision: "approved" }) });
    expect(approved.status).toBe(200);
    const listed = await SELF.fetch(`https://portal.test/api/projects/${project.id}/assets?collection=floorplan`, { headers: { cookie: adminCookie } });
    await expect(listed.json()).resolves.toMatchObject({ assets: expect.arrayContaining([expect.objectContaining({ id: v2.id, kind: "floorplan_pdf", version: 2, versionGroupId: v1.versionGroupId, review: expect.objectContaining({ decision: "approved" }) }), expect.objectContaining({ id: v2.preview.id, kind: "floorplan_preview", version: 2, versionGroupId: v1.versionGroupId })]) });
    expect(await database.DB.prepare("SELECT received_count, status FROM collections WHERE project_id = ? AND kind = 'floorplan'").bind(project.id).first()).toEqual({ received_count: 4, status: "received" });
    const projectDetails = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { headers: { cookie: adminCookie } });
    await expect(projectDetails.json()).resolves.toMatchObject({ collections: expect.arrayContaining([expect.objectContaining({ kind: "floorplan", receivedCount: 4, status: "received" }), expect.objectContaining({ kind: "copy", receivedCount: 2, status: "received" })]) });
    const original = await SELF.fetch(`https://portal.test/media/asset/${v2.id}/original`, { headers: { cookie: adminCookie } });
    expect(original.status).toBe(200); expect(original.headers.get("content-type")).toContain("application/pdf");
    expect(original.headers.get("content-disposition")).toBe('inline; filename="floorplan-two.pdf"');
    await database.DB.prepare("UPDATE assets SET original_filename = ? WHERE id = ?").bind("floorplan-two.pdf\r\nInjected: no", v2.id).run();
    const sanitized = await SELF.fetch(`https://portal.test/media/asset/${v2.id}/original`, { headers: { cookie: adminCookie } });
    expect(sanitized.headers.get("content-disposition")).toBe('inline; filename="floorplan-two.pdfInjected: no"');
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/documents`, { method: "POST", headers: { cookie: adminCookie } })).status).toBe(410);
  });

  it("keeps direct document PUT unavailable in the production-shaped suite", async () => {
    const path = `https://portal.test/api/projects/${crypto.randomUUID()}/documents/direct/${crypto.randomUUID()}/pdf`;
    expect((await SELF.fetch(path, { method: "PUT" })).status).toBe(401);
    expect((await SELF.fetch(path, { method: "PUT", headers: { cookie: await sessionCookie(adminToken) } })).status).toBe(404);
  });
});
