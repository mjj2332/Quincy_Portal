import { env, SELF as workerSelf } from "cloudflare:test";
import { makeSignature } from "better-auth/crypto";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { beforeAll, describe, expect, it } from "vitest";
import app from "../src/index";
import { createAuth } from "../src/auth";
import type { Env } from "../src/env";
import { createZipStream } from "../src/lib/zip-stream";
import { signTransformSource } from "../src/lib/transform-source";
import { liveTransformLocation } from "../src/routes/media";
import { RENDITION_SPEC_VERSION } from "@quincy/shared";
import { uniqueVersionError } from "../src/routes/collections";
import {
  RECONCILE_AWAITING_RAW_BATCH_SIZE,
  RECONCILE_AWAITING_RAW_UPDATE_SQL,
  advanceAwaitingRawProject,
  scanAwaitingRawProjects,
} from "../../background/src/reconcile-awaiting-raw";

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

async function createEditableComment() {
  const adminCookie = await sessionCookie(adminToken);
  const projectResponse = await SELF.fetch("https://portal.test/api/projects", {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: JSON.stringify({
      street: `Edit comment ${crypto.randomUUID()}`,
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
  ).bind(assetId, collection!.id, `tests/${assetId}.jpg`, "edit-comment.jpg", 1024, "upload", now, now).run();
  const commentResponse = await SELF.fetch(`https://portal.test/api/assets/${assetId}/comments`, {
    method: "POST",
    headers: { cookie: await sessionCookie(firstPhotographerToken), "content-type": "application/json" },
    body: JSON.stringify({ body: "Original comment" }),
  });
  expect(commentResponse.status).toBe(201);
  return { projectId: project.id, assetId, commentId: (await commentResponse.json() as { id: string }).id };
}

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
  return { assetId, annotationId: created.id, strokeR2Key: created.strokeR2Key };
}

describe("staff app API", () => {
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

  it("advances awaiting RAW projects with the real D1 batch guards, audit, and rollback semantics", async () => {
    const now = 1_784_678_400_000;
    const insertProject = async (id: string, shootDate: string, stageKey = "awaiting_raw", archivedAt: number | null = null) => {
      await database.DB.prepare(
        "INSERT INTO projects (id, street, shoot_date, stage_key, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(id, `Reconciliation ${id}`, shootDate, stageKey, archivedAt, now - 1, now - 1).run();
    };
    const candidateFor = (id: string, shootDate = "2026-07-22") => ({ id, shootDate, stageKey: "awaiting_raw", archivedAt: null } as const);
    const auditCount = async (id: string) => (await database.DB.prepare("SELECT count(*) AS count FROM audit_log WHERE target_id = ? AND action = 'stage.auto_advance'").bind(id).first<{ count: number }>())!.count;

    const advancedId = crypto.randomUUID();
    await insertProject(advancedId, "2026-07-22");
    await expect(advanceAwaitingRawProject(database.DB, candidateFor(advancedId), "2026-07-22", now)).resolves.toBe(true);
    await expect(database.DB.prepare("SELECT stage_key AS stageKey, updated_at AS updatedAt FROM projects WHERE id = ?").bind(advancedId).first()).resolves.toEqual({ stageKey: "raw_review", updatedAt: now });
    const audit = await database.DB.prepare("SELECT actor_id AS actorId, action, target_type AS targetType, target_id AS targetId, meta_json AS metaJson, created_at AS createdAt FROM audit_log WHERE target_id = ? AND action = 'stage.auto_advance'").bind(advancedId).first<{ actorId: string | null; action: string; targetType: string; targetId: string; metaJson: string; createdAt: number }>();
    expect(audit).toEqual({
      actorId: null,
      action: "stage.auto_advance",
      targetType: "project",
      targetId: advancedId,
      metaJson: JSON.stringify({ actor: "system", trigger: "hourly-awaiting-raw-reconciliation", businessDate: "2026-07-22", shootDate: "2026-07-22", from: "awaiting_raw", to: "raw_review" }),
      createdAt: now,
    });
    await expect(advanceAwaitingRawProject(database.DB, candidateFor(advancedId), "2026-07-22", now + 1)).resolves.toBe(false);
    await expect(auditCount(advancedId)).resolves.toBe(1);

    const movedId = crypto.randomUUID(); const archivedId = crypto.randomUUID(); const staleDateId = crypto.randomUUID();
    await insertProject(movedId, "2026-07-22", "edited_review");
    await insertProject(archivedId, "2026-07-22", "awaiting_raw", now - 1);
    await insertProject(staleDateId, "2026-07-23");
    await expect(advanceAwaitingRawProject(database.DB, candidateFor(movedId), "2026-07-22", now)).resolves.toBe(false);
    await expect(advanceAwaitingRawProject(database.DB, candidateFor(archivedId), "2026-07-22", now)).resolves.toBe(false);
    await expect(advanceAwaitingRawProject(database.DB, candidateFor(staleDateId), "2026-07-22", now)).resolves.toBe(false);
    await expect(Promise.all([auditCount(movedId), auditCount(archivedId), auditCount(staleDateId)])).resolves.toEqual([0, 0, 0]);

    const rollbackId = crypto.randomUUID();
    await insertProject(rollbackId, "2026-07-22");
    await expect(database.DB.batch([
      database.DB.prepare(RECONCILE_AWAITING_RAW_UPDATE_SQL).bind(now, rollbackId, "2026-07-22"),
      database.DB.prepare("INSERT INTO audit_log (id, action, target_type, created_at) VALUES (?, NULL, 'project', ?)").bind(crypto.randomUUID(), now),
    ])).rejects.toThrow();
    await expect(database.DB.prepare("SELECT stage_key AS stageKey FROM projects WHERE id = ?").bind(rollbackId).first()).resolves.toEqual({ stageKey: "awaiting_raw" });
  });

  it("scans only canonical due active awaiting RAW projects in stable bounded D1 batches", async () => {
    const now = 1_784_678_400_000;
    const prefix = "00000000-0000-4000-8001-";
    const dueIds = Array.from({ length: RECONCILE_AWAITING_RAW_BATCH_SIZE + 2 }, (_, index) => `${prefix}${String(index + 1).padStart(12, "0")}`);
    const excludedIds = {
      malformed: `${prefix}000000000201`,
      impossible: `${prefix}000000000202`,
      nonPadded: `${prefix}000000000203`,
      nullDate: `${prefix}000000000204`,
      future: `${prefix}000000000205`,
      archived: `${prefix}000000000206`,
      nonAwaiting: `${prefix}000000000207`,
    };
    const allIds = [...dueIds, ...Object.values(excludedIds)];
    const insertProject = async (id: string, shootDate: string | null, stageKey = "awaiting_raw", archivedAt: number | null = null) => {
      await database.DB.prepare(
        "INSERT INTO projects (id, street, shoot_date, stage_key, archived_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(id, `Scan reconciliation ${id}`, shootDate, stageKey, archivedAt, now, now).run();
    };

    try {
      for (const id of dueIds) await insertProject(id, "2026-07-22");
      await insertProject(excludedIds.malformed, "22/07/2026");
      await insertProject(excludedIds.impossible, "2026-02-29");
      await insertProject(excludedIds.nonPadded, "2026-7-02");
      await insertProject(excludedIds.nullDate, null);
      await insertProject(excludedIds.future, "2026-07-23");
      await insertProject(excludedIds.archived, "2026-07-21", "awaiting_raw", now);
      await insertProject(excludedIds.nonAwaiting, "2026-07-21", "raw_review");

      const firstBatch = await scanAwaitingRawProjects(database.DB, "2026-07-22");
      expect(firstBatch.map((project) => project.id)).toEqual(dueIds.slice(0, RECONCILE_AWAITING_RAW_BATCH_SIZE));
      expect(firstBatch.every((project) => project.shootDate === "2026-07-22" && project.stageKey === "awaiting_raw" && project.archivedAt === null)).toBe(true);

      await database.DB.batch(firstBatch.map((project) => database.DB.prepare(
        "UPDATE projects SET stage_key = 'raw_review', updated_at = ? WHERE id = ?",
      ).bind(now + 1, project.id)));

      const secondBatch = await scanAwaitingRawProjects(database.DB, "2026-07-22");
      const remainingTestIds = secondBatch.map((project) => project.id).filter((id) => id.startsWith(prefix));
      expect(remainingTestIds).toEqual(dueIds.slice(RECONCILE_AWAITING_RAW_BATCH_SIZE));
      expect(remainingTestIds).toHaveLength(2);
      expect(remainingTestIds.some((id) => Object.values(excludedIds).includes(id))).toBe(false);
    } finally {
      for (let offset = 0; offset < allIds.length; offset += 80) {
        const ids = allIds.slice(offset, offset + 80);
        const placeholders = ids.map(() => "?").join(", ");
        await database.DB.prepare(`DELETE FROM audit_log WHERE target_id IN (${placeholders})`).bind(...ids).run();
        await database.DB.prepare(`DELETE FROM projects WHERE id IN (${placeholders})`).bind(...ids).run();
      }
    }
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
    const { projectId } = await createEditableComment();
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

  it("permanently deletes an archived project, its jobs, and all project R2 media", async () => {
    const cookie = await sessionCookie(adminToken);
    const created = await SELF.fetch("https://portal.test/api/projects", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Delete me", orderedServices: [] }),
    });
    expect(created.status).toBe(201);
    const project = await created.json() as { id: string };
    const raw = await database.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND kind = 'raw'").bind(project.id).first<{ id: string }>();
    const media = env as unknown as { MEDIA: R2Bucket }; const now = Date.now();
    const keys = [`projects/${project.id}/originals/one.jpg`, `projects/${project.id}/annotations/two.json`];
    for (const key of keys) {
      await media.MEDIA.put(key, key);
      await database.DB.prepare("INSERT INTO assets (id, collection_id, r2_key, original_filename, bytes, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), raw!.id, key, "delete.jpg", key.length, "upload", now, now).run();
    }
    const jobId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO jobs (id, kind, status, project_id, retries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(jobId, "delete-test", "done", project.id, 0, now, now).run();
    expect((await SELF.fetch(`https://portal.test/api/projects/${project.id}/archive`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" })).status).toBe(200);

    const response = await SELF.fetch(`https://portal.test/api/projects/${project.id}`, { method: "DELETE", headers: { cookie } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, deletedObjects: 2 });
    expect(await database.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(project.id).first()).toBeNull();
    expect(await database.DB.prepare("SELECT id FROM jobs WHERE id = ?").bind(jobId).first()).toBeNull();
    for (const key of keys) expect(await media.MEDIA.get(key)).toBeNull();
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

  it("allows an author to edit their own comment", async () => {
    const { commentId } = await createEditableComment();
    const response = await SELF.fetch(`https://portal.test/api/comments/${commentId}`, {
      method: "PATCH",
      headers: { cookie: await sessionCookie(firstPhotographerToken), "content-type": "application/json" },
      body: JSON.stringify({ body: "Updated comment" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: commentId, body: "Updated comment", editedAt: expect.any(String) });
    const stored = await database.DB.prepare("SELECT body, edited_at FROM comments WHERE id = ?").bind(commentId).first<{ body: string; edited_at: number | null }>();
    expect(stored).toEqual(expect.objectContaining({ body: "Updated comment", edited_at: expect.any(Number) }));
  });

  it("prevents a different user from editing another author's comment", async () => {
    const { commentId } = await createEditableComment();
    const response = await SELF.fetch(`https://portal.test/api/comments/${commentId}`, {
      method: "PATCH",
      headers: { cookie: await sessionCookie(secondPhotographerToken), "content-type": "application/json" },
      body: JSON.stringify({ body: "Attempted overwrite" }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden: only the author can edit this comment." });
    const stored = await database.DB.prepare("SELECT body, edited_at FROM comments WHERE id = ?").bind(commentId).first<{ body: string; edited_at: number | null }>();
    expect(stored).toEqual({ body: "Original comment", edited_at: null });
  });

  it("deletes an author's comment and its reply subtree", async () => {
    const { assetId, commentId } = await createEditableComment();
    const replyResponse = await SELF.fetch(`https://portal.test/api/assets/${assetId}/comments`, {
      method: "POST",
      headers: { cookie: await sessionCookie(secondPhotographerToken), "content-type": "application/json" },
      body: JSON.stringify({ body: "Reply", parentId: commentId }),
    });
    expect(replyResponse.status).toBe(201);
    const replyId = (await replyResponse.json() as { id: string }).id;

    const response = await SELF.fetch(`https://portal.test/api/comments/${commentId}`, {
      method: "DELETE",
      headers: { cookie: await sessionCookie(firstPhotographerToken) },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, deletedCount: 2 });
    const stored = await database.DB.prepare("SELECT id FROM comments WHERE id IN (?, ?)").bind(commentId, replyId).all();
    expect(stored.results).toHaveLength(0);
  });

  it("prevents a fellow project member from deleting another author's comment", async () => {
    const { commentId } = await createEditableComment();
    const response = await SELF.fetch(`https://portal.test/api/comments/${commentId}`, {
      method: "DELETE",
      headers: { cookie: await sessionCookie(secondPhotographerToken) },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden: only the author can delete this comment." });
    const stored = await database.DB.prepare("SELECT id FROM comments WHERE id = ?").bind(commentId).first<{ id: string }>();
    expect(stored).toEqual({ id: commentId });
  });

  it("returns not found before checking access for an unknown comment deletion", async () => {
    const response = await SELF.fetch(`https://portal.test/api/comments/${crypto.randomUUID()}`, {
      method: "DELETE",
      headers: { cookie: await sessionCookie(firstPhotographerToken) },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "Comment not found" });
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
    const created = await SELF.fetch("https://portal.test/api/projects", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ street: "Manual publish queue", orderedServices: [] }) });
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
      SELF.fetch(`https://portal.test/api/assets/${pendingId}/comments`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ body: "not yet" }) }),
      SELF.fetch(`https://portal.test/api/projects/${project.id}/cover`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ assetId: pendingId }) }),
    ]);
    for (const response of blocked) expect(response.status).toBe(404);
    const readyOriginal = await SELF.fetch(`https://portal.test/media/asset/${readyId}/original`, { headers: { cookie } });
    expect(readyOriginal.status).toBe(200);
    expect(await readyOriginal.text()).toBe("ready");
    const readyReview = await SELF.fetch(`https://portal.test/api/assets/${readyId}/review`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ stars: 5 }) });
    expect(readyReview.status).toBe(200);
  });

  it("marks a manual upload failed when its publication service cannot start", async () => {
    const cookie = await sessionCookie(adminToken);
    const projectId = "00000000-0000-4000-8000-0000000000ff"; const collectionId = crypto.randomUUID(); const assetId = crypto.randomUUID(); const now = Date.now();
    await database.DB.batch([
      database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, ?, 'awaiting_raw', ?, ?)").bind(projectId, "Manual service failure", now, now),
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
    await expect(stageFor(photographerList)).resolves.toBe("editing");
    await expect(adminDetail.json()).resolves.toMatchObject({ stageKey: "editing_autohdr" });
    await expect(editorDetail.json()).resolves.toMatchObject({ stageKey: "editing" });
    await expect(photographerDetail.json()).resolves.toMatchObject({ stageKey: "editing" });
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

  it("lists, replays, and discards rendition dead-letter events, gated to admin", async () => {
    const cookie = await sessionCookie(adminToken);
    const openId = crypto.randomUUID(); const assetId = crypto.randomUUID(); const now = Date.now();
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
    const raceId = crypto.randomUUID(); const raceAsset = crypto.randomUUID();
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
    const failId = crypto.randomUUID(); const failAsset = crypto.randomUUID();
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
