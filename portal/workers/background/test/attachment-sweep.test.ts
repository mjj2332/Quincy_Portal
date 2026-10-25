import { env } from "cloudflare:test";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { sweepEmbeddedMedia } from "../src/embedded-media-sweep";

const database = env as unknown as { DB: D1Database; MEDIA: R2Bucket };
declare const __PORTAL_MIGRATION_SQL__: string;
const day = 24 * 60 * 60 * 1000;
const now = 1_800_000_000_000;
const projectId = "d1111111-1111-4111-8111-111111111111";
const userId = "d2222222-2222-4222-8222-222222222222";

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); }
  }
}

type Seed = { state: "uploading" | "pending" | "attached" | "detached"; createdAt?: number; detachedAt?: number | null; uploadId?: string | null; ownerId?: string; ownerKind?: "project_comment" | "notice_post" | "video_note" };
async function seed(input: Seed) {
  const id = crypto.randomUUID(); const ownerKind = input.ownerKind ?? "project_comment";
  const notice = ownerKind === "notice_post";
  const key = notice ? `notice-board/attachments/${id}/original` : `projects/${projectId}/attachments/${id}/original`;
  const detachedAt = input.state === "detached" ? (input.detachedAt ?? now) : null;
  const ownerId = input.state === "attached" || input.state === "detached" ? (input.ownerId ?? crypto.randomUUID()) : null;
  await database.DB.prepare("INSERT INTO attachments (id, owner_kind, owner_id, project_id, uploader_id, file_name, content_type, bytes, storage_key, upload_id, state, detached_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'plan.pdf', 'application/pdf', 3, ?, ?, ?, ?, ?, ?)")
    .bind(id, ownerKind, ownerId, notice ? null : projectId, userId, key, input.uploadId ?? null, input.state, detachedAt, input.createdAt ?? now, input.createdAt ?? now).run();
  await database.MEDIA.put(key, "xyz");
  return { id, key, ownerId };
}
const exists = async (id: string) => (await database.DB.prepare("SELECT 1 AS one FROM attachments WHERE id = ?").bind(id).first()) !== null;
const objectExists = async (key: string) => (await database.MEDIA.head(key)) !== null;
const queueRow = (key: string) => database.DB.prepare("SELECT storage_key AS storageKey, project_id AS projectId FROM embedded_media_cleanup WHERE storage_key = ?").bind(key).first<{ storageKey: string; projectId: string | null }>();
const wrapMedia = (override: (target: R2Bucket, property: string | symbol) => unknown) => ({ ...env, MEDIA: new Proxy(database.MEDIA, { get: (target, property) => {
  const custom = override(target, property); if (custom !== undefined) return custom;
  const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
} }) });

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'U', 'u2@example.test', 1, 'editor', 1, ?, ?)").bind(userId, now, now).run();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'S', 'editing_autohdr', ?, ?)").bind(projectId, now, now).run();
});
beforeEach(async () => { await database.DB.exec("DELETE FROM attachments; DELETE FROM embedded_media_cleanup; DELETE FROM project_comments; DELETE FROM notice_board_posts;"); });
const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
afterAll(() => { consoleError.mockRestore(); });

describe("attachment sweep (#953)", () => {
  it("deletes an Attachment removed from its post a week ago, and not before", async () => {
    const due = await seed({ state: "detached", detachedAt: now - 7 * day });
    const early = await seed({ state: "detached", detachedAt: now - 7 * day + 1 });
    const result = await sweepEmbeddedMedia(env, now);
    expect(result.attachments).toMatchObject({ scanned: 1, reclaimed: 1 });
    expect(await exists(due.id)).toBe(false); expect(await objectExists(due.key)).toBe(false);
    expect(await exists(early.id)).toBe(true); expect(await objectExists(early.key)).toBe(true);
  });

  it("deletes a never-posted Attachment (pending or uploading) after a week, and not before", async () => {
    const stalePending = await seed({ state: "pending", createdAt: now - 7 * day });
    const staleUploading = await seed({ state: "uploading", createdAt: now - 8 * day });
    const freshPending = await seed({ state: "pending", createdAt: now - 7 * day + 1 });
    const freshUploading = await seed({ state: "uploading", createdAt: now - 7 * day + 1 });
    await sweepEmbeddedMedia(env, now);
    for (const row of [stalePending, staleUploading]) { expect(await exists(row.id)).toBe(false); expect(await objectExists(row.key)).toBe(false); }
    for (const row of [freshPending, freshUploading]) { expect(await exists(row.id)).toBe(true); expect(await objectExists(row.key)).toBe(true); }
  });

  it("deletes the Attachments of a deleted comment (detached at 0, due now)", async () => {
    const row = await seed({ state: "detached", detachedAt: 0 });
    await sweepEmbeddedMedia(env, now);
    expect(await exists(row.id)).toBe(false); expect(await objectExists(row.key)).toBe(false);
  });

  it("never touches an attached Attachment however old while its post exists", async () => {
    const commentId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO project_comments (id, project_id, author_id, body, content_json, created_at) VALUES (?, ?, ?, 'x', '{}', ?)").bind(commentId, projectId, userId, now).run();
    const row = await seed({ state: "attached", createdAt: now - 400 * day, ownerId: commentId });
    await sweepEmbeddedMedia(env, now);
    expect(await exists(row.id)).toBe(true); expect(await objectExists(row.key)).toBe(true);
  });

  it("backstop: an attached Attachment whose comment or Notice board post is gone is reclaimed", async () => {
    const comment = await seed({ state: "attached", createdAt: now - 400 * day });
    const notice = await seed({ state: "attached", ownerKind: "notice_post" });
    await sweepEmbeddedMedia(env, now);
    for (const row of [comment, notice]) { expect(await exists(row.id)).toBe(false); expect(await objectExists(row.key)).toBe(false); }
  });

  it("deletes a Project's Attachment objects once the Project delete has queued their keys", async () => {
    const row = await seed({ state: "attached" });
    await database.DB.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at) VALUES (?, NULL, ?, ?)").bind(row.key, projectId, now).run();
    await database.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(row.id).run();
    const result = await sweepEmbeddedMedia(env, now);
    expect(result.drained).toBe(1);
    expect(await objectExists(row.key)).toBe(false); expect(await queueRow(row.key)).toBeNull();
  });

  it("aborts the multipart upload of an expired uploading Attachment through the queue", async () => {
    const row = await seed({ state: "uploading", createdAt: now - 8 * day, uploadId: "up-1" });
    const aborted: string[][] = [];
    const wrapped = wrapMedia((_target, property) => property === "resumeMultipartUpload" ? (key: string, uploadId: string) => ({ abort: async () => { aborted.push([key, uploadId]); } }) : undefined);
    await sweepEmbeddedMedia(wrapped as never, now);
    expect(aborted).toEqual([[row.key, "up-1"]]);
    expect(await exists(row.id)).toBe(false); expect(await queueRow(row.key)).toBeNull(); expect(await objectExists(row.key)).toBe(false);
  });

  it("queues an object R2 will not delete, with the row gone, and drains it once R2 recovers", async () => {
    const stuck = await seed({ state: "pending", createdAt: now - 8 * day });
    let failing = true;
    const flaky = wrapMedia((target, property) => property === "delete" ? async (keys: string | string[]) => { if (failing) throw new Error("R2 down"); return target.delete(keys); } : undefined);
    await sweepEmbeddedMedia(flaky as never, now);
    expect(await exists(stuck.id)).toBe(false);
    expect(await queueRow(stuck.key)).toMatchObject({ projectId });
    failing = false; await sweepEmbeddedMedia(flaky as never, now + 1);
    expect(await queueRow(stuck.key)).toBeNull(); expect(await objectExists(stuck.key)).toBe(false);
  });

  it("skips a pending Attachment that was attached between the read and the claim, leaving the object alone", async () => {
    const commentId = crypto.randomUUID();
    await database.DB.prepare("INSERT INTO project_comments (id, project_id, author_id, body, content_json, created_at) VALUES (?, ?, ?, 'x', '{}', ?)").bind(commentId, projectId, userId, now).run();
    const row = await seed({ state: "pending", createdAt: now - 8 * day });
    const racing = { ...env, DB: new Proxy(database.DB, { get: (target, property) => {
      if (property !== "prepare") { const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.includes("FROM attachments") || !sql.includes("ORDER BY id LIMIT")) return statement;
        return { bind: (...values: unknown[]) => { const bound = statement.bind(...values); return { all: async () => {
          const read = await bound.all();
          await database.DB.prepare("UPDATE attachments SET state = 'attached', owner_id = ? WHERE id = ?").bind(commentId, row.id).run();
          return read;
        } }; } };
      };
    } }) };
    expect(await sweepEmbeddedMedia(racing as unknown as typeof env, now)).toMatchObject({ attachments: { scanned: 1, reclaimed: 0, failed: 0 } });
    expect(await exists(row.id)).toBe(true); expect(await objectExists(row.key)).toBe(true);
  });

  it("takes at most 100 rows a run, and a rerun finishes the rest", async () => {
    for (let i = 0; i < 101; i += 1) await seed({ state: "detached", detachedAt: 0 });
    expect((await sweepEmbeddedMedia(env, now)).attachments).toMatchObject({ scanned: 100, reclaimed: 100 });
    expect((await sweepEmbeddedMedia(env, now)).attachments).toMatchObject({ scanned: 1, reclaimed: 1 });
  });
});
