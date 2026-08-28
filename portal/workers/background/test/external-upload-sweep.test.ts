import { env } from "cloudflare:test";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { sweepExternalEditedUploads } from "../src/external-upload-sweep";

const database = env as unknown as { DB: D1Database };
const media = env as unknown as { MEDIA: R2Bucket };
declare const __PORTAL_MIGRATION_SQL__: string;

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) {
      const flat = statement.replace(/\s+/g, " ").trim();
      if (flat) await database.DB.exec(`${flat};`);
    }
  }
}

type SessionFixture = {
  sessionId: string;
  projectId: string;
  collectionId: string;
  assetId: string;
  userId: string;
  membershipId: string;
  r2Key: string;
  r2UploadId: string;
};

async function seedSession(status: "open" | "completing" | "aborting", now: number, options: { active?: boolean; finalObject?: boolean; expiresAt?: number } = {}): Promise<SessionFixture> {
  const sessionId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const collectionId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const r2Key = `projects/${projectId}/edited/${assetId}/upload.jpg`;
  const r2UploadId = `upload-${sessionId}`;
  const bytes = 3;
  await database.DB.batch([
    database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, authorization_epoch, created_at, updated_at) VALUES (?, 'Sweep External', ?, 1, 'external_editor', ?, 0, ?, ?)")
      .bind(userId, `${userId}@example.test`, options.active === false ? 0 : 1, now, now),
    database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Sweep Project', 'editing_autohdr', ?, ?)")
      .bind(projectId, now, now),
    database.DB.prepare("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, 'edited', 'empty', 0, ?, ?)")
      .bind(collectionId, projectId, now, now),
    database.DB.prepare("INSERT INTO project_members (id, project_id, user_id, role_on_project, created_at) VALUES (?, ?, ?, 'editor', ?)")
      .bind(membershipId, projectId, userId, now),
    database.DB.prepare(`INSERT INTO external_edited_upload_sessions
      (id, token_hash, project_id, collection_id, asset_id, created_by, membership_cycle_id, authorization_epoch,
       original_filename, bytes, r2_key, r2_upload_id, part_bytes, part_count, status,
       completion_lease_token, completion_lease_expires_at, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'upload.jpg', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`)
      .bind(sessionId, crypto.randomUUID().replaceAll("-", ""), projectId, collectionId, assetId, userId, membershipId, bytes, r2Key, r2UploadId, bytes, status,
        status === "completing" ? `lease-${sessionId}` : null,
        status === "completing" ? now - 1 : null,
        options.expiresAt ?? now - 1, now - 10, now - 1),
  ]);
  if (options.finalObject) await media.MEDIA.put(r2Key, "xyz", { httpMetadata: { contentType: "image/jpeg" } });
  return { sessionId, projectId, collectionId, assetId, userId, membershipId, r2Key, r2UploadId };
}

beforeAll(async () => { await executeSql(__PORTAL_MIGRATION_SQL__); });

// Each test asserts on the global sweep totals, and some tests intentionally leave a session
// mid-lifecycle (e.g. a completing session whose authorization was lost). Reset every table the
// fixtures touch so a leftover row from one test cannot be re-swept by the next. Child rows
// first — external_edited_upload_sessions is RESTRICT-referenced by created_by.
beforeEach(async () => {
  for (const table of ["external_edited_upload_parts", "external_edited_upload_sessions", "assets", "project_members", "collections", "projects", "user"]) {
    await database.DB.exec(`DELETE FROM ${table};`);
  }
});

const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

afterAll(() => { consoleError.mockRestore(); });

describe("external edited upload sweep", () => {
  it("claims an expired open session, aborts it once, and frees its cap slot", async () => {
    const now = Date.now();
    const fixture = await seedSession("open", now);
    const abort = vi.fn().mockResolvedValue(undefined);
    const sweptMedia = {
      head: vi.fn().mockResolvedValue(null),
      resumeMultipartUpload: vi.fn().mockReturnValue({ abort }),
    } as unknown as R2Bucket;

    await expect(sweepExternalEditedUploads({ DB: database.DB, MEDIA: sweptMedia }, now)).resolves.toEqual({ scanned: 1, reclaimed: 1, reopened: 0 });
    await expect(database.DB.prepare("SELECT status FROM external_edited_upload_sessions WHERE id = ?").bind(fixture.sessionId).first()).resolves.toEqual({ status: "expired" });
    expect(abort).toHaveBeenCalledOnce();
    await expect(sweepExternalEditedUploads({ DB: database.DB, MEDIA: sweptMedia }, now)).resolves.toEqual({ scanned: 0, reclaimed: 0, reopened: 0 });
    expect(abort).toHaveBeenCalledOnce();
    await expect(database.DB.prepare("SELECT count(*) AS count FROM external_edited_upload_sessions WHERE created_by = ? AND status = 'open' AND expires_at > ?").bind(fixture.userId, now).first()).resolves.toEqual({ count: 0 });
  });

  it("leaves a completing session recoverable when authorization is lost before recovery", async () => {
    const now = Date.now();
    const fixture = await seedSession("completing", now, { finalObject: true });
    await database.DB.prepare("UPDATE user SET active = 0 WHERE id = ?").bind(fixture.userId).run();

    await expect(sweepExternalEditedUploads({ DB: database.DB, MEDIA: media.MEDIA }, now)).resolves.toMatchObject({ scanned: 1, reclaimed: 0, reopened: 0 });
    await expect(database.DB.prepare("SELECT status, completed_at AS completedAt, terminal_at AS terminalAt FROM external_edited_upload_sessions WHERE id = ?").bind(fixture.sessionId).first()).resolves.toEqual({ status: "completing", completedAt: null, terminalAt: null });
    await expect(database.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(fixture.assetId).first()).resolves.toBeNull();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("External upload recovery left session completing"), { sessionId: fixture.sessionId });
  });

  it("treats a missing multipart upload as an idempotent abort", async () => {
    const now = Date.now();
    const fixture = await seedSession("aborting", now, { expiresAt: now + 1_000 });
    const sweptMedia = {
      head: vi.fn().mockResolvedValue(null),
      resumeMultipartUpload: vi.fn().mockReturnValue({ abort: vi.fn().mockRejectedValue(Object.assign(new Error("No such upload"), { code: "NoSuchUpload" })) }),
    } as unknown as R2Bucket;

    await expect(sweepExternalEditedUploads({ DB: database.DB, MEDIA: sweptMedia }, now)).resolves.toMatchObject({ scanned: 1, reclaimed: 1 });
    await expect(database.DB.prepare("SELECT status FROM external_edited_upload_sessions WHERE id = ?").bind(fixture.sessionId).first()).resolves.toEqual({ status: "aborted" });
  });
});
