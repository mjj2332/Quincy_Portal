import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ObjectCrcMessage } from "@quincy/shared";
import { assessZip, NATIVE_ZIP_FLAG, ZIP_LEGACY_MAX_BYTES, type ZipAssessment } from "../src/lib/object-crc";
import { database, seedFixture } from "./embedded-media-support";
import { clearVideoFlags, setVideoFlags } from "./video-review-support";

/** The CRC gate of the native ZIP writer (#802): what a zip route does with a set of objects before it streams a byte or writes an audit row. */
const MiB = 1024 * 1024;
const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
function fakeQueue() {
  const sent: ObjectCrcMessage[] = [];
  return { sent, sendBatch: vi.fn(async (messages: Array<{ body: ObjectCrcMessage }>) => { for (const message of messages) sent.push(message.body); }) };
}
/** R2 as the gate sees it: HEAD only. A key not in the map is a missing object. */
function fakeMedia(objects: Record<string, { etag: string; size: number }>) {
  const heads: string[] = [];
  return { heads, head: vi.fn(async (key: string) => { heads.push(key); return objects[key] ?? null; }) };
}
const prefix = `crc-gate/${crypto.randomUUID()}/`;
const key = (name: string) => `${prefix}${name}`;
async function row(name: string, etag: string, bytes: number) { await database.DB.prepare("INSERT OR REPLACE INTO object_crc32 (r2_key, crc32, bytes, etag, computed_at) VALUES (?, 123, ?, ?, ?)").bind(key(name), bytes, etag, Date.now()).run(); }
async function work(name: string, state: "queued" | "running" | "failed", updatedAt: number) {
  await database.DB.prepare("INSERT OR REPLACE INTO object_crc32_work (r2_key, state, attempts, requested_at, updated_at) VALUES (?, ?, 0, ?, ?)").bind(key(name), state, updatedAt, updatedAt).run();
}
const workRows = async () => (await database.DB.prepare("SELECT r2_key FROM object_crc32_work WHERE r2_key LIKE ?").bind(`${prefix}%`).all<{ r2_key: string }>()).results.map((r) => r.r2_key);
async function assess(subjects: Array<{ name: string; bytes: number }>, media: ReturnType<typeof fakeMedia>, queue: ReturnType<typeof fakeQueue>, enqueue: "never" | "when_blocked" | "always" = "when_blocked", now = Date.now()): Promise<ZipAssessment> {
  return assessZip({ DB: database.DB, MEDIA: media as never, OBJECT_CRC_QUEUE: queue as never }, subjects.map((s) => ({ r2Key: key(s.name), bytes: s.bytes })), { source: "test", enqueue, now });
}
const setFlag = (on: boolean) => setVideoFlags([NATIVE_ZIP_FLAG, on]);

beforeAll(async () => { await seedFixture(); });
afterEach(async () => {
  consoleError.mockClear(); await clearVideoFlags(); await database.DB.prepare("DELETE FROM feature_flags WHERE key = ?").bind(NATIVE_ZIP_FLAG).run();
  await database.DB.batch([database.DB.prepare("DELETE FROM object_crc32 WHERE r2_key LIKE ?").bind(`${prefix}%`), database.DB.prepare("DELETE FROM object_crc32_work WHERE r2_key LIKE ?").bind(`${prefix}%`)]);
});

describe("flag off (missing = off)", () => {
  it("is legacy up to 256 MiB and does not touch R2", async () => {
    const media = fakeMedia({}); const queue = fakeQueue();
    expect(await assess([{ name: "a", bytes: ZIP_LEGACY_MAX_BYTES }], media, queue)).toEqual({ kind: "legacy" });
    expect(media.heads).toEqual([]); expect(queue.sent).toEqual([]);
  });
  it("is too_large one byte over 256 MiB, and a flag row that is present but off behaves the same", async () => {
    await setFlag(false);
    expect(await assess([{ name: "a", bytes: ZIP_LEGACY_MAX_BYTES + 1 }], fakeMedia({}), fakeQueue())).toEqual({ kind: "too_large" });
  });
});

describe("flag on", () => {
  it("is native when every object's row matches the etag R2 reports now", async () => {
    await setFlag(true); await row("a", "ea", 10); await row("b", "eb", 20);
    const media = fakeMedia({ [key("a")]: { etag: "ea", size: 10 }, [key("b")]: { etag: "eb", size: 20 } }); const queue = fakeQueue();
    const result = await assess([{ name: "a", bytes: 10 }, { name: "b", bytes: 20 }], media, queue);
    expect(result.kind).toBe("native");
    if (result.kind === "native") expect(result.ready.get(key("b"))).toEqual({ crc32: 123, bytes: 20, etag: "eb" });
    expect(media.heads.sort()).toEqual([key("a"), key("b")]);
  });
  it("HEADs every object, including ones a stale row would let through", async () => {
    await setFlag(true); await row("a", "old", 10);
    const media = fakeMedia({ [key("a")]: { etag: "new", size: 10 } });
    expect((await assess([{ name: "a", bytes: 10 }], media, fakeQueue(), "never")).kind).toBe("legacy");
    expect(media.heads).toEqual([key("a")]);
  });
  it("a row whose etag differs from R2's is pending, not ready (Dropbox RAW keys are reused across revisions)", async () => {
    await setFlag(true); await row("a", "old", 10);
    const media = fakeMedia({ [key("a")]: { etag: "new", size: 10 } }); const queue = fakeQueue();
    expect(await assess([{ name: "a", bytes: 10 }], media, queue, "always")).toMatchObject({ kind: "legacy" });
    expect(queue.sent).toEqual([{ type: "object_crc32", r2Key: key("a") }]);
  });
  it("does not compare the row's size with D1's: the etag decides", async () => {
    await setFlag(true); await row("a", "ea", 999);
    const result = await assess([{ name: "a", bytes: 10 }], fakeMedia({ [key("a")]: { etag: "ea", size: 10 } }), fakeQueue());
    expect(result.kind).toBe("native");
  });
  it("is unavailable when an object is missing from R2", async () => {
    await setFlag(true); await row("a", "ea", 10);
    expect(await assess([{ name: "a", bytes: 10 }], fakeMedia({}), fakeQueue())).toEqual({ kind: "unavailable", reason: "missing" });
  });
  it("is unavailable when R2's size differs from D1's, even with a ready row", async () => {
    await setFlag(true); await row("a", "ea", 10);
    expect(await assess([{ name: "a", bytes: 10 }], fakeMedia({ [key("a")]: { etag: "ea", size: 11 } }), fakeQueue())).toEqual({ kind: "unavailable", reason: "changed" });
  });
  it("is unavailable, not preparing forever, when a pending object's CRC job has failed", async () => {
    await setFlag(true); await work("a", "failed", Date.now());
    const queue = fakeQueue();
    expect(await assess([{ name: "a", bytes: 300 * MiB }], fakeMedia({ [key("a")]: { etag: "ea", size: 300 * MiB } }), queue)).toEqual({ kind: "unavailable", reason: "failed" });
    expect(queue.sent).toEqual([]);
  });
  it("a failed work row does not matter once the object has a matching row", async () => {
    await setFlag(true); await row("a", "ea", 10); await work("a", "failed", Date.now());
    expect((await assess([{ name: "a", bytes: 10 }], fakeMedia({ [key("a")]: { etag: "ea", size: 10 } }), fakeQueue())).kind).toBe("native");
  });
});

describe("pending objects", () => {
  const big = 300 * MiB;
  const objects = { [key("a")]: { etag: "ea", size: big }, [key("b")]: { etag: "eb", size: 1 } };

  it("answers preparing above 256 MiB, with the pending count, and queues each pending key once", async () => {
    await setFlag(true); await row("b", "eb", 1); const queue = fakeQueue();
    const result = await assess([{ name: "a", bytes: big }, { name: "b", bytes: 1 }], fakeMedia(objects), queue);
    expect(result).toEqual({ kind: "preparing", pending: [key("a")], retryAfterSeconds: 30 });
    expect(queue.sent).toEqual([{ type: "object_crc32", r2Key: key("a") }]);
    expect(await workRows()).toEqual([key("a")]);
  });
  it("does not queue it again while a work row is live, and does once the row has been quiet for ten minutes", async () => {
    await setFlag(true); const queue = fakeQueue(); const subjects = [{ name: "a", bytes: big }]; const now = Date.now();
    await assess(subjects, fakeMedia(objects), queue, "when_blocked", now); expect(queue.sent).toHaveLength(1);
    await assess(subjects, fakeMedia(objects), queue, "when_blocked", now + 60_000); expect(queue.sent).toHaveLength(1);
    await assess(subjects, fakeMedia(objects), queue, "when_blocked", now + 10 * 60_000 + 1); expect(queue.sent).toHaveLength(2);
  });
  it("two concurrent assessments queue it once", async () => {
    await setFlag(true); const queue = fakeQueue();
    await Promise.all([assess([{ name: "a", bytes: big }], fakeMedia(objects), queue), assess([{ name: "a", bytes: big }], fakeMedia(objects), queue)]);
    expect(queue.sent).toHaveLength(1);
  });
  it("is legacy at or under 256 MiB and, on when_blocked, queues nothing", async () => {
    await setFlag(true); const queue = fakeQueue();
    expect(await assess([{ name: "b", bytes: 1 }], fakeMedia(objects), queue)).toEqual({ kind: "legacy" });
    expect(queue.sent).toEqual([]); expect(await workRows()).toEqual([]);
  });
  it("queues under 256 MiB too when the caller asked to prepare", async () => {
    await setFlag(true); const queue = fakeQueue();
    expect(await assess([{ name: "b", bytes: 1 }], fakeMedia(objects), queue, "always")).toEqual({ kind: "legacy" });
    expect(queue.sent).toEqual([{ type: "object_crc32", r2Key: key("b") }]);
  });
  it("'never' is read-only: no queue send and no work row", async () => {
    await setFlag(true); const queue = fakeQueue();
    expect((await assess([{ name: "a", bytes: big }], fakeMedia(objects), queue, "never")).kind).toBe("preparing");
    expect(queue.sent).toEqual([]); expect(await workRows()).toEqual([]);
  });
});
