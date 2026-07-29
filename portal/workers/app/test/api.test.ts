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
import { RENDITION_SPEC_VERSION } from "@quincy/shared";
import { createDb } from "@quincy/db";
import { uniqueVersionError } from "../src/routes/collections";
import { finalizeIngest } from "../src/lib/ingest";
import { notifyProjectAssignments } from "../src/lib/notifications";
import { insertProjectMembers, syncMembers } from "../src/lib/project-members";

const database = env as unknown as { DB: D1Database };
const authEnv = env as unknown as Env;
const authSecret = authEnv.BETTER_AUTH_SECRET ?? "dev-only-replace-better-auth-secret-32-bytes";
const photographerToken = "test-photographer-session-token";
const adminToken = "test-admin-session-token";
const secondPhotographerToken = "test-second-photographer-session-token";
const editorToken = "test-editor-session-token";
const otherAdminToken = "test-other-admin-session-token";
// First photographer IS a member of the editable-comment project; the plain
// photographerToken user is deliberately NOT (D-02 assigned-only scoping).
const firstPhotographerToken = "test-first-photographer-session-token";
const firstPhotographerId = "11111111-1111-4111-8111-111111111111";
const secondPhotographerId = "22222222-2222-4222-8222-222222222222";
const editorId = "33333333-3333-4333-8333-333333333333";
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
    database.DB.prepare("INSERT INTO autohdr_handoffs (id, project_id, connection_id, generation, manifest_version, selection_hash, selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path, initiated_by, state, workflow_id, job_id, lease_expires_at, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 'selection', ?, ?, ?, 'seed-admin', 'starting', ?, ?, ?, ?, ?)")
      .bind(handoffId, projectId, connectionId, JSON.stringify([assetId]), JSON.stringify([{ key: `asset:${assetId}`, assetIds: [assetId] }]), `/Raw/${projectId}`, `send:${handoffId}`, jobId, now + 60_000, now, now),
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
  ).bind("test-admin-session", now + 60 * 60 * 1000, adminToken, "seed-admin", now, now).run();
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
    "INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("test-second-photographer-session", now + 60 * 60 * 1000, secondPhotographerToken, secondPhotographerId, now, now).run();
  await database.DB.prepare(
    "INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("test-first-photographer-session", now + 60 * 60 * 1000, firstPhotographerToken, firstPhotographerId, now, now).run();
  await database.DB.prepare(
    "INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind("test-editor-session", now + 60 * 60 * 1000, editorToken, editorId, now, now).run();
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
        body: JSON.stringify({ street, shootDate, orderedServices: [], photographerUserIds: [firstPhotographerId] }),
      });
      expect(response.status).toBe(201);
      return (await response.json() as { id: string }).id;
    };
    const newer = await create("Duplicate membership newer", "2026-07-25");
    const older = await create("Duplicate membership older", "2026-07-24");
    await database.DB.prepare("UPDATE collections SET received_count = ?, expected_count = ? WHERE project_id = ? AND kind = 'raw'").bind(4, 6, newer).run();
    await database.DB.prepare("UPDATE collections SET received_count = ?, expected_count = ? WHERE project_id = ? AND kind = 'raw'").bind(2, 3, older).run();

    // The unique key includes role_on_project, so this is a distinct, valid membership row.
    const secondRole = await SELF.fetch(`https://portal.test/api/projects/${newer}`, {
      method: "PATCH",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ editorUserIds: [firstPhotographerId] }),
    });
    expect(secondRole.status).toBe(200);

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
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const sig = await signTransformSource(env as unknown as Parameters<typeof signTransformSource>[0], key, expiresAt);
    const encodedPath = "/__transform-source/" + key.split("/").map(encodeURIComponent).join("/");
    expect(encodedPath).toContain(encodeURIComponent("se.CR527827_4 EV #20Jul.jpg"));
    const source = await SELF.fetch(`https://portal.test${encodedPath}?v=v2&exp=${expiresAt}&sig=${sig}`);
    expect(source.status).toBe(200); await expect(source.text()).resolves.toBe(body);
    expect(source.headers.get("cache-control")).toBe("private, no-store");
    expect((await SELF.fetch(`https://portal.test${encodedPath}?exp=${expiresAt}&sig=tampered`)).status).toBe(404);
    expect((await SELF.fetch(`https://portal.test${encodedPath}?v=v-tampered&exp=${expiresAt}&sig=${sig}`)).status).toBe(404);
    expect((await SELF.fetch(`https://portal.test${encodedPath}?v=v2&exp=${expiresAt}&sig=${sig}&extra=1`)).status).toBe(404);
    expect((await SELF.fetch("https://portal.test/__transform-source/bad%ZZ?exp=1&sig=tampered")).status).toBe(404);
  });

  it("builds the production live-transform redirect with encoded source, cache version, and expiry", () => {
    const key = "projects/a raw/asset/space #?.jpg";
    const location = liveTransformLocation("https://portal.test/media/asset/x/thumb", key, "thumb", { expiresAt: 1_800_000_300, signature: "a".repeat(64) });
    expect(location).toContain("width=640,height=640,fit=scale-down,quality=75,format=auto/");
    expect(location).toContain("__transform-source/projects/a%20raw/asset/space%20%23%3F.jpg");
    expect(location).toContain("?v=v2&exp=1800000300&sig=");
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
    expect(result.data?.user.id).toBe("seed-admin");
    expect(result.data?.session.userId).toBe("seed-admin");
    const users = await database.DB.prepare("SELECT id FROM user WHERE email = ?").bind("mjj2332@gmail.com").all();
    const accounts = await database.DB.prepare("SELECT provider_id, account_id, user_id FROM account WHERE user_id = ?").bind("seed-admin").all();
    expect(users.results).toHaveLength(1);
    expect(accounts.results).toEqual([expect.objectContaining({ provider_id: "google", account_id: "google-admin-subject", user_id: "seed-admin" })]);
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

  it("adds service collections and synchronizes only the requested project role", async () => {
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

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ orderedServices: ["edited", "video"], photographerUserIds: [secondPhotographerId] }),
    });
    expect(response.status).toBe(200);
    const updated = await response.json() as { collections: Array<{ kind: string }>; members: Array<{ userId: string; roleOnProject: string }> };
    expect(updated.collections).toHaveLength(project.collections.length + 1);
    expect(updated.collections.map((collection) => collection.kind).sort()).toEqual(["edited", "raw", "video"]);
    expect(updated.members.filter((member) => member.roleOnProject === "photographer").map((member) => member.userId)).toEqual([secondPhotographerId]);
    expect(updated.members.filter((member) => member.roleOnProject === "editor").map((member) => member.userId)).toEqual([editorId]);
  });

  it("emits assignment alerts only for confirmed active role assignments", async () => {
    const cookie = await sessionCookie(adminToken);
    const inactiveId = crypto.randomUUID();
    const now = Date.now();
    await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Inactive assignee', ?, 1, 'editor', 0, ?, ?)")
      .bind(inactiveId, `${inactiveId}@example.test`, now, now).run();
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        street: "Assignment alerts",
        orderedServices: [],
        photographerUserIds: [firstPhotographerId, inactiveId],
        editorUserIds: [editorId, firstPhotographerId],
      }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const assignmentRows = async () => database.DB.prepare("SELECT user_id, body FROM notifications WHERE project_id = ? AND type = 'assigned_to_project' ORDER BY user_id, body").bind(project.id).all<{ user_id: string; body: string }>();
    expect((await assignmentRows()).results).toEqual([
      { user_id: firstPhotographerId, body: "You have been assigned as the editor for Assignment alerts." },
      { user_id: firstPhotographerId, body: "You have been assigned as the photographer for Assignment alerts." },
      { user_id: editorId, body: "You have been assigned as the editor for Assignment alerts." },
    ]);
    expect((await assignmentRows()).results.map((row) => row.user_id)).not.toContain("seed-admin");
    expect((await assignmentRows()).results.map((row) => row.user_id)).not.toContain(inactiveId);
    expect((await database.DB.prepare("SELECT user_id FROM project_members WHERE project_id = ? AND user_id = ?").bind(project.id, inactiveId).all()).results).toHaveLength(1);

    const same = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ photographerUserIds: [firstPhotographerId, inactiveId], editorUserIds: [editorId, firstPhotographerId] }),
    });
    expect(same.status).toBe(200);
    expect((await assignmentRows()).results).toHaveLength(3);

    const added = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ photographerUserIds: [firstPhotographerId, secondPhotographerId], editorUserIds: [editorId, firstPhotographerId] }),
    });
    expect(added.status).toBe(200);
    expect((await assignmentRows()).results.filter((row) => row.user_id === secondPhotographerId)).toEqual([
      { user_id: secondPhotographerId, body: "You have been assigned as the photographer for Assignment alerts." },
    ]);

    const removed = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ photographerUserIds: [secondPhotographerId], editorUserIds: [editorId] }),
    });
    expect(removed.status).toBe(200);
    expect((await assignmentRows()).results).toHaveLength(4);
  });

  it("returns database-confirmed membership inserts and emits one matching assignment alert", async () => {
    const now = Date.now();
    const projectId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Contested target', ?, 1, 'editor', 1, ?, ?)").bind(userId, `${userId}@example.test`, now, now),
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Contested assignment', 'awaiting_raw', ?, ?)").bind(projectId, now, now),
    ]);
    const db = createDb(database.DB);
    const first = await insertProjectMembers(db, projectId, [userId], "editor");
    const second = await insertProjectMembers(db, projectId, [userId], "editor");
    expect([...first, ...second]).toEqual([userId]);
    expect((await database.DB.prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ? AND role_on_project = 'editor'").bind(projectId, userId).all()).results).toHaveLength(1);
    const send = vi.fn().mockResolvedValue({ messageId: "test-message" });
    const testEnv = { DB: database.DB, EMAIL: { send }, NOTIFICATIONS_FROM_ADDRESS: "studio@example.test" } as unknown as Env;
    for (const userIds of [first, second]) {
      await notifyProjectAssignments(testEnv, projectId, userIds.map((assignedUserId) => ({ userId: assignedUserId, roleOnProject: "editor" as const })));
    }
    expect((await database.DB.prepare("SELECT id FROM notifications WHERE project_id = ? AND type = 'assigned_to_project'").bind(projectId).all()).results).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not report an addition from a stale empty syncMembers snapshot", async () => {
    const now = Date.now();
    const projectId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Stale target', ?, 1, 'editor', 1, ?, ?)").bind(userId, `${userId}@example.test`, now, now),
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Stale membership', 'awaiting_raw', ?, ?)").bind(projectId, now, now),
    ]);
    const db = createDb(database.DB);
    expect(await insertProjectMembers(db, projectId, [userId], "editor")).toEqual([userId]);
    expect(await syncMembers(db, projectId, [], [userId], "editor")).toEqual({ added: [], removed: [] });
    expect((await database.DB.prepare("SELECT id FROM project_members WHERE project_id = ? AND user_id = ? AND role_on_project = 'editor'").bind(projectId, userId).all()).results).toHaveLength(1);
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
      .bind(crypto.randomUUID(), edited!.id, 1, "[\"pending.jpg\"]", "seed-admin", Date.now()).run();

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
    await database.DB.prepare("INSERT INTO document_uploads (id, project_id, collection_id, created_by, kind, version_group_id, version, pdf_asset_id, pdf_key, pdf_filename, pdf_bytes, pdf_content_type, status, expires_at, completion_audit_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), project.id, copy!.id, "seed-admin", "copy_pdf", crypto.randomUUID(), 1, crypto.randomUUID(), `projects/${project.id}/copy/pending.pdf`, "pending.pdf", 1, "application/pdf", "pending", now + 60_000, crypto.randomUUID(), now, now).run();

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
      actorId: "seed-admin",
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

  it("seeds stages on first read, serves them to photographers, and protects the system stage", async () => {
    const cookie = await sessionCookie(adminToken);
    await database.DB.exec("DELETE FROM pipeline_stages;");
    const seeded = await SELF.fetch("https://portal.test/api/admin/stages", { headers: { cookie } });
    expect(seeded.status).toBe(200); await expect(seeded.json()).resolves.toMatchObject({ stages: expect.arrayContaining([expect.objectContaining({ key: "awaiting_raw", displayOrder: 1 })]) });
    const photographerStages = await SELF.fetch("https://portal.test/api/stages", { headers: { cookie: await sessionCookie(photographerToken) } });
    expect(photographerStages.status).toBe(200); await expect(photographerStages.json()).resolves.toMatchObject({ stages: expect.arrayContaining([expect.objectContaining({ key: "awaiting_raw" })]) });
    const label = await SELF.fetch("https://portal.test/api/admin/stages/raw_review", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "Raw triage" }) });
    await expect(label.json()).resolves.toMatchObject({ label: "Raw triage" });
    const moved = await SELF.fetch("https://portal.test/api/admin/stages/raw_review/move", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ direction: "up" }) });
    expect(moved.status).toBe(200);
    const movedStages = (await moved.json() as { stages: { key: string; displayOrder: number }[] }).stages;
    expect(movedStages[0]).toMatchObject({ key: "raw_review", displayOrder: 1 });
    expect(movedStages[1]).toMatchObject({ key: "awaiting_raw", displayOrder: 2 });
    const systemBlocked = await SELF.fetch("https://portal.test/api/admin/stages/awaiting_raw", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ active: false }) });
    expect(systemBlocked.status).toBe(409); await expect(systemBlocked.json()).resolves.toEqual({ error: "The awaiting_raw stage is required for new projects." });
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Stage guard", orderedServices: [] }) });
    expect(created.status).toBe(201);
    await database.DB.prepare("UPDATE pipeline_stages SET active = 0 WHERE key = ?").bind("raw_review").run();
    const inactiveTarget = await SELF.fetch(`https://portal.test/api/projects/${(await created.json() as { id: string }).id}/stage`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ stageKey: "raw_review" }) });
    expect(inactiveTarget.status).toBe(409); await expect(inactiveTarget.json()).resolves.toEqual({ error: "Stage is deactivated" });
    await database.DB.prepare("UPDATE pipeline_stages SET active = 1 WHERE key = ?").bind("raw_review").run();
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

  it("manages manual collection links while preserving immutable Tonomo links", async () => {
    const adminCookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Link collection", orderedServices: ["video"], photographerUserIds: [firstPhotographerId] }) });
    expect(created.status).toBe(201); const project = await created.json() as { id: string };
    const manual = await SELF.fetch(`https://portal.test/api/projects/${project.id}/links`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ collection: "video", url: "https://vimeo.com/123456", label: "Walkthrough" }) });
    expect(manual.status).toBe(201); const manualLink = await manual.json() as { id: string; source: string };
    expect(manualLink.source).toBe("manual");
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = ? AND target_id = ?").bind("collection_link.create", manualLink.id).first()).toEqual({ count: 1 });
    const video = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = ?").bind(project.id, "video").first<{ id: string }>();
    expect(await database.DB.prepare("SELECT received_count, status FROM collections WHERE id = ?").bind(video!.id).first()).toEqual({ received_count: 1, status: "received" });
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/links/${manualLink.id}`, { method: "DELETE", headers: { cookie: adminCookie } })).status).toBe(204);
    expect(await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE action = ? AND target_id = ?").bind("collection_link.delete", manualLink.id).first()).toEqual({ count: 1 });
    expect(await database.DB.prepare("SELECT status FROM collections WHERE id = ?").bind(video!.id).first()).toEqual({ status: "empty" });
    const replacement = await SELF.fetch(`https://portal.test/api/projects/${project.id}/links`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ collection: "video", url: "https://vimeo.com/123456", label: "Walkthrough" }) });
    expect(replacement.status).toBe(201); const replacementLink = await replacement.json() as { id: string };
    const tonomoId = crypto.randomUUID(); const now = Date.now();
    await database.DB.prepare("INSERT INTO collection_links (id, collection_id, url, label, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(tonomoId, video!.id, "https://dropbox.com/s/finished", "Tonomo floor", "tonomo", now, now).run();
    const listed = await SELF.fetch(`https://portal.test/api/projects/${project.id}/links?collection=video`, { headers: { cookie: adminCookie } });
    await expect(listed.json()).resolves.toMatchObject({ links: expect.arrayContaining([expect.objectContaining({ id: replacementLink.id, source: "manual" }), expect.objectContaining({ id: tonomoId, source: "tonomo" })]) });
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/links/${replacementLink.id}`, { method: "DELETE", headers: { cookie: adminCookie } })).status).toBe(204);
    expect(await database.DB.prepare("SELECT received_count, status FROM collections WHERE id = ?").bind(video!.id).first()).toEqual({ received_count: 1, status: "received" });
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/links/${tonomoId}`, { method: "DELETE", headers: { cookie: adminCookie } })).status).toBe(409);
    const photographer = await SELF.fetch(`https://portal.test/api/projects/${project.id}/links`, { method: "POST", headers: { cookie: await sessionCookie(firstPhotographerToken), "content-type": "application/json" }, body: JSON.stringify({ collection: "video", url: "https://vimeo.com/forbidden" }) });
    expect(photographer.status).toBe(403);
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
