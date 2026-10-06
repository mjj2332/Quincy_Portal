import { env } from "cloudflare:test";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { embeddedMediaDisplayKey, embeddedMediaObjectKey, embeddedMediaPosterKey, noticeEmbeddedMediaObjectKey } from "@quincy/shared";
import { sweepEmbeddedMedia } from "../src/embedded-media-sweep";
import { sweepEmbeddedMediaOrphans } from "../src/embedded-media-orphan-sweep";

const database = env as unknown as { DB: D1Database; MEDIA: R2Bucket };
declare const __PORTAL_MIGRATION_SQL__: string;
const day = 24 * 60 * 60 * 1000;
/** Day index 16 * 1300 + 3: shard "3". */
const now = (16 * 1300 + 3) * day;
const userId = "c2222222-2222-4222-8222-222222222222";
/** Project ids and media ids that start with the shard's character, so they sit under shard "3". */
const shardId = (shard: string) => `${shard}${crypto.randomUUID().slice(1)}`;
const projectId = shardId("3");

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); }
  }
}

/** What `uploaded` the fake bucket reports for a key; anything not listed is eight days old. */
const uploadedAt = new Map<string, number>();
type Paging = { limit?: number; emptyFirstPage?: boolean };
function bucket(paging: Paging = {}, calls: { list: number } = { list: 0 }) {
  const seenEmpty = new Set<string>();
  return { calls, env: { ...env, MEDIA: new Proxy(database.MEDIA, { get: (target, property) => {
    if (property === "list") {
      return async (options: R2ListOptions = {}) => {
        calls.list += 1;
        const marker = `${options.prefix ?? ""}|${options.delimiter ?? ""}`;
        if (paging.emptyFirstPage && options.cursor === undefined && !seenEmpty.has(marker)) { seenEmpty.add(marker); return { objects: [], delimitedPrefixes: [], truncated: true, cursor: `empty:${marker}` }; }
        const cursor = options.cursor?.startsWith("empty:") ? undefined : options.cursor;
        const result = await target.list({ ...options, cursor, limit: Math.min(options.limit ?? 1000, paging.limit ?? 1000) });
        return { objects: result.objects.map((object) => ({ key: object.key, size: object.size, uploaded: new Date(uploadedAt.get(object.key) ?? now - 8 * day) })), delimitedPrefixes: result.delimitedPrefixes, truncated: result.truncated, cursor: result.truncated ? result.cursor : undefined };
      };
    }
    const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
  } }) } as never };
}
const mode = (value: string | undefined, base: { env: object }) => ({ ...base.env, EMBEDDED_MEDIA_ORPHAN_SWEEP: value }) as never;

async function put(key: string, uploaded?: number) { await database.MEDIA.put(key, "xyz"); if (uploaded !== undefined) uploadedAt.set(key, uploaded); }
async function row(input: { id: string; notice?: boolean; state?: "uploading" | "pending" | "attached"; display?: string; poster?: string }) {
  const original = input.notice ? noticeEmbeddedMediaObjectKey(input.id) : embeddedMediaObjectKey(projectId, input.id);
  const state = input.state ?? "attached";
  await database.DB.prepare("INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, display_key, poster_key, upload_id, state, detached_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'image', 'image/png', 3, ?, ?, ?, NULL, ?, NULL, ?, ?)")
    .bind(input.id, input.notice ? "notice_post" : "project_comment", state === "attached" ? crypto.randomUUID() : null, input.notice ? null : projectId, userId, original, input.display ?? null, input.poster ?? null, state, now, now).run();
  return original;
}
const queueRow = (key: string) => database.DB.prepare("SELECT storage_key AS storageKey, upload_id AS uploadId, project_id AS projectId, queued_at AS queuedAt, attempts, claimed_until AS claimedUntil FROM embedded_media_cleanup WHERE storage_key = ?").bind(key).first<{ storageKey: string; uploadId: string | null; projectId: string | null; queuedAt: number; attempts: number; claimedUntil: number | null }>();
const queueSize = async () => (await database.DB.prepare("SELECT count(*) AS n FROM embedded_media_cleanup").first<{ n: number }>())!.n;
const audits = () => database.DB.prepare("SELECT actor_id AS actorId, action, target_type AS targetType, target_id AS targetId, meta_json AS metaJson FROM audit_log WHERE action = 'embedded_media.orphan_reclaimed' ORDER BY target_id").all<{ actorId: string | null; action: string; targetType: string; targetId: string; metaJson: string }>().then((result) => result.results);
const objectExists = async (key: string) => (await database.MEDIA.head(key)) !== null;
const listAll = async () => (await database.MEDIA.list({ limit: 1000 })).objects.map((object) => object.key);

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'U', 'u@example.test', 1, 'editor', 1, ?, ?)").bind(userId, now, now).run();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'S', 'editing_autohdr', 0, ?, ?)").bind(projectId, now, now).run();
});
beforeEach(async () => {
  await database.DB.exec("DELETE FROM embedded_media; DELETE FROM embedded_media_cleanup; DELETE FROM audit_log;");
  for (const key of await listAll()) await database.MEDIA.delete(key);
  uploadedAt.clear();
});
const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
afterAll(() => { consoleError.mockRestore(); consoleLog.mockRestore(); });

describe("embedded media orphan sweep (#549)", () => {
  it("keeps an original, a poster and a display copy that a row references", async () => {
    const id = shardId("3"); const poster = embeddedMediaPosterKey(projectId, id, crypto.randomUUID()); const display = embeddedMediaDisplayKey(projectId, id, crypto.randomUUID());
    const original = await row({ id, poster, display });
    for (const key of [original, poster, display]) await put(key);
    const { env: media } = bucket();
    expect(await sweepEmbeddedMediaOrphans(mode("reclaim", { env: media }), now)).toMatchObject({ shard: "3", listed: 3, referenced: 3, reclaimed: 0, truncated: false });
    expect(await queueSize()).toBe(0);
    expect(await audits()).toEqual([]);
  });

  it("queues an old unreferenced object with an audit row, and the cleanup drain then deletes it", async () => {
    const orphan = embeddedMediaObjectKey(projectId, shardId("3")); await put(orphan);
    const { env: media } = bucket();
    expect(await sweepEmbeddedMediaOrphans(mode("reclaim", { env: media }), now)).toMatchObject({ reclaimed: 1, referenced: 0, young: 0 });
    expect(await queueRow(orphan)).toMatchObject({ uploadId: null, projectId, queuedAt: now, attempts: 0, claimedUntil: null });
    expect(await objectExists(orphan)).toBe(true);
    const [audit] = await audits();
    expect(audit).toMatchObject({ actorId: null, action: "embedded_media.orphan_reclaimed", targetType: "r2_object", targetId: orphan });
    expect(JSON.parse(audit!.metaJson)).toMatchObject({ bytes: 3, shard: "3", mode: "reclaim" });
    expect(await sweepEmbeddedMedia(env, now)).toMatchObject({ drained: 1 });
    expect(await objectExists(orphan)).toBe(false);
    expect(await queueSize()).toBe(0);
  });

  it("leaves an object younger than the retention window", async () => {
    const young = embeddedMediaObjectKey(projectId, shardId("3")); const edge = embeddedMediaObjectKey(projectId, shardId("3")); const old = embeddedMediaObjectKey(projectId, shardId("3"));
    await put(young, now - 7 * day + 1000); await put(edge, now - 7 * day); await put(old, now - 7 * day - 1);
    const { env: media } = bucket();
    expect(await sweepEmbeddedMediaOrphans(mode("reclaim", { env: media }), now)).toMatchObject({ young: 2, reclaimed: 1 });
    expect(await queueRow(old)).not.toBeNull(); expect(await queueRow(young)).toBeNull(); expect(await queueRow(edge)).toBeNull();
  });

  it("leaves an object already in the cleanup queue untouched, claimed or not, and does not count it as reclaimed", async () => {
    const free = embeddedMediaObjectKey(projectId, shardId("3")); const leased = embeddedMediaObjectKey(projectId, shardId("3"));
    await put(free); await put(leased);
    await database.DB.prepare("INSERT INTO embedded_media_cleanup (storage_key, upload_id, project_id, queued_at, attempts, claimed_until) VALUES (?, 'up1', ?, 5, 2, NULL), (?, NULL, ?, 6, 3, ?)").bind(free, projectId, leased, projectId, now + 1000).run();
    const { env: media } = bucket();
    expect(await sweepEmbeddedMediaOrphans(mode("reclaim", { env: media }), now)).toMatchObject({ queued: 2, reclaimed: 0 });
    expect(await queueRow(free)).toMatchObject({ uploadId: "up1", queuedAt: 5, attempts: 2, claimedUntil: null });
    expect(await queueRow(leased)).toMatchObject({ queuedAt: 6, attempts: 3, claimedUntil: now + 1000 });
    expect(await audits()).toEqual([]);
  });

  it("queues a stale poster and display copy beside a live row, and keeps the keys the row references", async () => {
    const id = shardId("3"); const livePoster = embeddedMediaPosterKey(projectId, id, crypto.randomUUID()); const staleDisplay = embeddedMediaDisplayKey(projectId, id, crypto.randomUUID()); const stalePoster = embeddedMediaPosterKey(projectId, id, crypto.randomUUID());
    const original = await row({ id, poster: livePoster });
    for (const key of [original, livePoster, staleDisplay, stalePoster]) await put(key);
    const { env: media } = bucket();
    expect(await sweepEmbeddedMediaOrphans(mode("reclaim", { env: media }), now)).toMatchObject({ referenced: 2, reclaimed: 2 });
    expect(await queueRow(staleDisplay)).not.toBeNull(); expect(await queueRow(stalePoster)).not.toBeNull();
    expect(await queueRow(original)).toBeNull(); expect(await queueRow(livePoster)).toBeNull();
  });

  it("does nothing for an uploading row that has no object yet, and keeps a completed original under an uploading row", async () => {
    const waiting = shardId("3"); const finished = shardId("3");
    await row({ id: waiting, state: "uploading" }); const original = await row({ id: finished, state: "uploading" });
    await put(original);
    const { env: media } = bucket();
    expect(await sweepEmbeddedMediaOrphans(mode("reclaim", { env: media }), now)).toMatchObject({ listed: 1, referenced: 1, reclaimed: 0 });
    expect(await queueSize()).toBe(0);
  });

  it("never touches keys it does not recognise", async () => {
    const id = shardId("3");
    const strangers = [`projects/${projectId}/whiteboard/${id}/original`, `projects/${projectId}/raw/IMG_0001.CR3`, `projects/${projectId}/embedded-media/${id}/surprise`, `projects/${projectId}/embedded-media/${id}/poster-not-a-uuid`, `projects/${projectId}/embedded-media/${id}/original/extra`, `projects/${projectId}/embedded-media/not-a-uuid/original`, `notice-board/embedded-media/${id}/poster-${crypto.randomUUID()}`, `notice-board/embedded-media/${id}/whatever.jpg`];
    for (const key of strangers) await put(key);
    const { env: media } = bucket();
    expect(await sweepEmbeddedMediaOrphans(mode("reclaim", { env: media }), now)).toMatchObject({ reclaimed: 0 });
    expect(await queueSize()).toBe(0);
    for (const key of strangers) expect(await objectExists(key)).toBe(true);
  });

  it("covers the Notice board prefix, and a deleted Project's leftover folder", async () => {
    const notice = noticeEmbeddedMediaObjectKey(shardId("3")); const noticeDisplay = embeddedMediaDisplayKey(null, shardId("3"), crypto.randomUUID());
    const gone = shardId("3"); const leftover = embeddedMediaObjectKey(gone, shardId("3"));
    const otherShard = noticeEmbeddedMediaObjectKey(shardId("4"));
    for (const key of [notice, noticeDisplay, leftover, otherShard]) await put(key);
    const { env: media } = bucket();
    expect(await sweepEmbeddedMediaOrphans(mode("reclaim", { env: media }), now)).toMatchObject({ reclaimed: 3 });
    expect(await queueRow(notice)).toMatchObject({ projectId: null }); expect(await queueRow(noticeDisplay)).toMatchObject({ projectId: null });
    expect(await queueRow(leftover)).toMatchObject({ projectId: gone });
    expect(await queueRow(otherShard)).toBeNull();
  });

  it("follows every page of a folder, including an empty truncated page", async () => {
    const keys = Array.from({ length: 5 }, () => embeddedMediaObjectKey(projectId, shardId("3")));
    for (const key of keys) await put(key);
    const { env: media, calls } = bucket({ limit: 2, emptyFirstPage: true });
    expect(await sweepEmbeddedMediaOrphans(mode("reclaim", { env: media }), now)).toMatchObject({ listed: 5, reclaimed: 5, truncated: false, listCalls: calls.list });
    for (const key of keys) expect(await queueRow(key)).not.toBeNull();
  });

  it("stops at its list-call bound and its enqueue bound and reports truncated", async () => {
    for (let index = 0; index < 4; index += 1) await put(embeddedMediaObjectKey(projectId, shardId("3")));
    const enqueueBound = bucket();
    expect(await sweepEmbeddedMediaOrphans(mode("reclaim", { env: enqueueBound.env }), now, { maxEnqueues: 2 })).toMatchObject({ reclaimed: 2, truncated: true });
    expect(await queueSize()).toBe(2);
    const listBound = bucket();
    const result = await sweepEmbeddedMediaOrphans(mode("reclaim", { env: listBound.env }), now, { maxListCalls: 2 });
    expect(result).toMatchObject({ truncated: true, listCalls: 2 });
    expect(listBound.calls.list).toBe(2);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("orphan"), expect.objectContaining({ shard: "3" }));
  });

  it("observe reports wouldReclaim and writes nothing; off lists nothing", async () => {
    const orphan = embeddedMediaObjectKey(projectId, shardId("3")); await put(orphan);
    const observed = bucket();
    const result = await sweepEmbeddedMediaOrphans(mode("observe", { env: observed.env }), now);
    expect(result).toMatchObject({ wouldReclaim: 1, reclaimed: 0 });
    expect(await queueSize()).toBe(0); expect(await audits()).toEqual([]); expect(await objectExists(orphan)).toBe(true);
    for (const value of ["off", undefined, "nonsense"]) {
      const off = bucket();
      expect(await sweepEmbeddedMediaOrphans(mode(value, { env: off.env }), now)).toMatchObject({ listCalls: 0, reclaimed: 0, wouldReclaim: 0 });
      expect(off.calls.list).toBe(0); expect(await queueSize()).toBe(0);
    }
  });

  it("walks one shard a day, rotating through all sixteen", async () => {
    const byShard: Record<string, string> = {};
    for (const shard of "0123456789abcdef") { byShard[shard] = embeddedMediaObjectKey(shardId(shard), shardId(shard)); await put(byShard[shard]!, -10 * day); }
    const { env: media } = bucket();
    const result = await sweepEmbeddedMediaOrphans(mode("reclaim", { env: media }), 0);
    expect(result).toMatchObject({ shard: "0", reclaimed: 1 });
    expect(await queueRow(byShard["0"]!)).not.toBeNull(); expect(await queueSize()).toBe(1);
    expect((await sweepEmbeddedMediaOrphans(mode("observe", { env: media }), 10 * day + 5)).shard).toBe("a");
    expect((await sweepEmbeddedMediaOrphans(mode("observe", { env: media }), 15 * day)).shard).toBe("f");
    expect((await sweepEmbeddedMediaOrphans(mode("observe", { env: media }), 16 * day)).shard).toBe("0");
  });

  it("does not queue an object whose row appears between the listing and the enqueue", async () => {
    const id = shardId("3"); const original = embeddedMediaObjectKey(projectId, id); await put(original);
    const base = bucket();
    const racing = { ...base.env, MEDIA: new Proxy(base.env.MEDIA, { get: (target, property) => property === "list" ? async (options: R2ListOptions) => { const listed = await target.list(options); if (options.prefix?.endsWith("embedded-media/")) await row({ id }); return listed; } : Reflect.get(target, property) }) };
    // `row` is inserted after the listing returned but before the enqueue statement runs.
    expect(await sweepEmbeddedMediaOrphans(mode("reclaim", { env: racing }), now)).toMatchObject({ reclaimed: 0, referenced: 1 });
    expect(await queueSize()).toBe(0);
  });
});
