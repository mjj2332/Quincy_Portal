import { env } from "cloudflare:test";
import { crc32 } from "node:zlib";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectCrcMessage } from "@quincy/shared";
import QuincyBackground from "../src";
import { CRC_MAX_ATTEMPTS, CRC_RANGE_BYTES, CRC_STALE_MS, crcOfBody, processObjectCrc } from "../src/object-crc";

/** The resumable object CRC-32 job (#802): one queue message is one range of one object, the running CRC and offset live in object_crc32_work, and the last range upserts object_crc32. */
declare const __PORTAL_MIGRATION_SQL__: string;
const database = env as unknown as { DB: D1Database; MEDIA: R2Bucket };
const prefix = `object-crc-test/${crypto.randomUUID()}/`;
const MIB = 1024 * 1024;

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); }
  }
}
const row = (key: string) => database.DB.prepare("SELECT r2_key, crc32, bytes, etag, computed_at FROM object_crc32 WHERE r2_key = ?").bind(key).first<{ r2_key: string; crc32: number; bytes: number; etag: string; computed_at: number }>();
const work = (key: string) => database.DB.prepare('SELECT r2_key, etag, bytes, "offset", crc_partial, state, attempts, last_error, claim_token FROM object_crc32_work WHERE r2_key = ?').bind(key).first<{ r2_key: string; etag: string | null; bytes: number | null; offset: number; crc_partial: number; state: string; attempts: number; last_error: string | null; claim_token: string | null }>();
const random = (length: number) => { const out = new Uint8Array(length); for (let at = 0; at < length; at += 65_536) crypto.getRandomValues(out.subarray(at, Math.min(length, at + 65_536))); return out; };
const start = (r2Key: string): ObjectCrcMessage => ({ type: "object_crc32", r2Key });

/** A queue that records what the job sends to itself. */
function fakeQueue() {
  const sent: ObjectCrcMessage[] = [];
  return { sent, sendBatch: vi.fn(async (messages: Array<{ body: ObjectCrcMessage }>) => { for (const message of messages) sent.push(message.body); }) };
}
const jobEnv = (queue = fakeQueue(), media: unknown = database.MEDIA) => ({ env: { DB: database.DB, MEDIA: media as R2Bucket, OBJECT_CRC_QUEUE: queue as never }, queue });

/** Runs a start message and every continuation it produces, one range at a time, as the queue would. */
async function runChain(key: string, options: { rangeBytes: number; media?: unknown; between?: (step: number) => Promise<void> }): Promise<string[]> {
  const { env: job, queue } = jobEnv(undefined, options.media); const outcomes: string[] = []; let step = 0;
  let next: ObjectCrcMessage | undefined = start(key);
  while (next) { outcomes.push(await processObjectCrc(job, next, { rangeBytes: options.rangeBytes })); await options.between?.(step); step += 1; next = queue.sent.shift(); if (step > 50) throw new Error("runaway chain"); }
  return outcomes;
}

const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
beforeAll(async () => { await executeSql(__PORTAL_MIGRATION_SQL__); });
beforeEach(async () => { await database.DB.exec("DELETE FROM object_crc32; DELETE FROM object_crc32_work;"); });
afterEach(() => consoleError.mockClear());

describe("constants", () => {
  it("reads in ranges of at most 512 MiB and gives up after three attempts", () => {
    expect(CRC_RANGE_BYTES).toBe(512 * MIB); expect(CRC_MAX_ATTEMPTS).toBe(3);
  });
});

describe("processObjectCrc, one range", () => {
  it("stores the known CRC-32 check value, the size and the etag, and leaves no work row", async () => {
    const key = `${prefix}check`; const stored = await database.MEDIA.put(key, "123456789");
    expect(await runChain(key, { rangeBytes: CRC_RANGE_BYTES })).toEqual(["stored"]);
    expect(await row(key)).toMatchObject({ r2_key: key, crc32: 0xcbf43926, bytes: 9, etag: stored.etag });
    expect(await work(key)).toBeNull();
  });

  it("matches node's CRC-32 for an object spanning several read buffers and a ragged tail", async () => {
    const key = `${prefix}big`; const data = random(3 * MIB + 4099); await database.MEDIA.put(key, data);
    await runChain(key, { rangeBytes: CRC_RANGE_BYTES });
    expect(await row(key)).toMatchObject({ crc32: crc32(data), bytes: data.length });
  });

  it("stores zero for an empty object without a ranged read", async () => {
    const key = `${prefix}empty`; await database.MEDIA.put(key, new Uint8Array());
    const get = vi.spyOn(database.MEDIA, "get");
    expect(await runChain(key, { rangeBytes: CRC_RANGE_BYTES })).toEqual(["stored"]);
    expect(await row(key)).toMatchObject({ crc32: 0, bytes: 0 }); expect(get).not.toHaveBeenCalled(); get.mockRestore();
  });

  it("reads with a range and an etag condition", async () => {
    const key = `${prefix}options`; const stored = await database.MEDIA.put(key, "abcdefghij");
    const get = vi.spyOn(database.MEDIA, "get");
    await runChain(key, { rangeBytes: 4 });
    expect(get.mock.calls.map((call) => call[1])).toEqual([
      { range: { offset: 0, length: 4 }, onlyIf: { etagMatches: stored.etag } }, { range: { offset: 4, length: 4 }, onlyIf: { etagMatches: stored.etag } }, { range: { offset: 8, length: 2 }, onlyIf: { etagMatches: stored.etag } }]);
    get.mockRestore();
  });

  it("stores no CRC for an object that is gone, and records it as failed so the sweep does not queue it every hour", async () => {
    expect(await runChain(`${prefix}gone`, { rangeBytes: CRC_RANGE_BYTES })).toEqual(["missing"]);
    expect(await row(`${prefix}gone`)).toBeNull(); expect(await work(`${prefix}gone`)).toMatchObject({ state: "failed", last_error: "The object is not in R2" });
  });

  it("records an object deleted between ranges as failed too", async () => {
    const key = `${prefix}deleted-midway`; await database.MEDIA.put(key, random(2 * MIB)); const { env: job, queue } = jobEnv();
    await processObjectCrc(job, start(key), { rangeBytes: MIB }); await database.MEDIA.delete(key);
    expect(await processObjectCrc(job, queue.sent.shift()!, { rangeBytes: MIB })).toBe("missing");
    expect(await work(key)).toMatchObject({ state: "failed" }); expect(await row(key)).toBeNull();
  });
});

describe("processObjectCrc, many ranges", () => {
  it("carries the CRC and offset in the work row and re-enqueues itself until the end", async () => {
    const key = `${prefix}ranges`; const data = random(3 * MIB + 4099); const stored = await database.MEDIA.put(key, data);
    const { env: job, queue } = jobEnv();
    expect(await processObjectCrc(job, start(key), { rangeBytes: MIB })).toBe("advanced");
    expect(await work(key)).toMatchObject({ etag: stored.etag, bytes: data.length, offset: MIB, crc_partial: crc32(data.subarray(0, MIB)), state: "queued" });
    expect(queue.sent).toEqual([{ type: "object_crc32", r2Key: key, etag: stored.etag, offset: MIB }]);
    expect(await row(key)).toBeNull();
    expect(await processObjectCrc(job, queue.sent.shift()!, { rangeBytes: MIB })).toBe("advanced");
    expect(await processObjectCrc(job, queue.sent.shift()!, { rangeBytes: MIB })).toBe("advanced");
    expect(await processObjectCrc(job, queue.sent.shift()!, { rangeBytes: MIB })).toBe("stored");
    expect(queue.sent).toEqual([]);
    expect(await row(key)).toMatchObject({ crc32: crc32(data), bytes: data.length, etag: stored.etag }); expect(await work(key)).toBeNull();
  });

  it("an object that is an exact multiple of the range ends on the last full range", async () => {
    const key = `${prefix}exact`; const data = random(2 * MIB); await database.MEDIA.put(key, data);
    expect(await runChain(key, { rangeBytes: MIB })).toEqual(["advanced", "stored"]);
    expect(await row(key)).toMatchObject({ crc32: crc32(data), bytes: data.length });
  });

  it("restarts at offset 0 with the new etag when the object changes between ranges", async () => {
    const key = `${prefix}changes`; const first = random(2 * MIB + 10); const second = random(MIB + 77);
    const original = await database.MEDIA.put(key, first); let replaced = ""; const outcomes: string[] = [];
    const { env: job, queue } = jobEnv(); let next: ObjectCrcMessage | undefined = start(key);
    for (let step = 0; next; step += 1, next = queue.sent.shift()) {
      outcomes.push(await processObjectCrc(job, next, { rangeBytes: MIB }));
      if (step === 0) replaced = (await database.MEDIA.put(key, second)).etag;
    }
    expect(replaced).not.toBe(original.etag);
    expect(outcomes).toEqual(["advanced", "restarted", "advanced", "stored"]);
    expect(await row(key)).toMatchObject({ crc32: crc32(second), bytes: second.length, etag: replaced }); expect(await work(key)).toBeNull();
  });

  it("restarts when the object changed before a continuation looks at it", async () => {
    const key = `${prefix}changes-head`; await database.MEDIA.put(key, random(2 * MIB)); const second = random(100);
    const { env: job, queue } = jobEnv(); await processObjectCrc(job, start(key), { rangeBytes: MIB });
    const replaced = await database.MEDIA.put(key, second);
    expect(await processObjectCrc(job, queue.sent.shift()!, { rangeBytes: MIB })).toBe("restarted");
    expect(await work(key)).toMatchObject({ etag: replaced.etag, bytes: 100, offset: 0, crc_partial: 0 });
    expect(queue.sent).toEqual([{ type: "object_crc32", r2Key: key, etag: replaced.etag, offset: 0 }]);
  });
});

describe("processObjectCrc, duplicate and stale deliveries", () => {
  it("acks a continuation whose offset is behind the row, with no write", async () => {
    const key = `${prefix}stale-offset`; await database.MEDIA.put(key, random(3 * MIB));
    const { env: job, queue } = jobEnv(); await processObjectCrc(job, start(key), { rangeBytes: MIB });
    const first = queue.sent.shift()!; await processObjectCrc(job, first, { rangeBytes: MIB });
    const before = await work(key);
    expect(await processObjectCrc(job, first, { rangeBytes: MIB })).toBe("stale");
    expect(await work(key)).toEqual(before); expect(queue.sent).toHaveLength(1);
  });

  it("acks a continuation for another etag, or for a key with no work row, with no write", async () => {
    const key = `${prefix}stale-etag`; await database.MEDIA.put(key, random(2 * MIB));
    const { env: job, queue } = jobEnv(); await processObjectCrc(job, start(key), { rangeBytes: MIB });
    await database.MEDIA.put(`${prefix}no-row`, "x"); const before = await work(key); queue.sent.length = 0;
    expect(await processObjectCrc(job, { type: "object_crc32", r2Key: key, etag: "someone-elses", offset: MIB }, { rangeBytes: MIB })).toBe("stale");
    expect(await processObjectCrc(job, { type: "object_crc32", r2Key: `${prefix}no-row`, etag: "e", offset: 0 }, { rangeBytes: MIB })).toBe("stale");
    expect(await work(key)).toEqual(before); expect(await work(`${prefix}no-row`)).toBeNull(); expect(queue.sent).toEqual([]);
  });

  it("a second start while a range is running is dropped, even on a retry", async () => {
    const key = `${prefix}dedupe`; const stored = await database.MEDIA.put(key, random(2 * MIB));
    const { env: job } = jobEnv();
    await database.DB.prepare(`INSERT INTO object_crc32_work (r2_key, etag, bytes, "offset", crc_partial, state, attempts, requested_at, updated_at) VALUES (?1, ?2, ?3, 0, 0, 'running', 1, ?4, ?4)`).bind(key, stored.etag, 2 * MIB, Date.now()).run();
    expect(await processObjectCrc(job, start(key), { rangeBytes: MIB })).toBe("stale");
    expect(await work(key)).toMatchObject({ state: "running", offset: 0 });
    expect(await processObjectCrc(job, start(key), { rangeBytes: MIB, attempts: 2 })).toBe("stale");
  });

  it("takes over a running row nobody has touched for ten minutes", async () => {
    const key = `${prefix}abandoned`; const stored = await database.MEDIA.put(key, random(100)); const now = Date.now();
    await database.DB.prepare(`INSERT INTO object_crc32_work (r2_key, etag, bytes, "offset", crc_partial, state, attempts, requested_at, updated_at) VALUES (?1, ?2, 100, 0, 0, 'running', 1, ?3, ?3)`).bind(key, stored.etag, now - 11 * 60_000).run();
    expect(await processObjectCrc(jobEnv().env, start(key), { rangeBytes: MIB, now })).toBe("stored");
  });

  it("a start for an object whose CRC is already stored does nothing but clear a leftover work row", async () => {
    const key = `${prefix}done`; await database.MEDIA.put(key, "done");
    await runChain(key, { rangeBytes: MIB }); const stored = await row(key);
    await database.DB.prepare(`INSERT INTO object_crc32_work (r2_key, state, requested_at, updated_at) VALUES (?1, 'queued', 1, 1)`).bind(key).run();
    const get = vi.spyOn(database.MEDIA, "get");
    expect(await processObjectCrc(jobEnv().env, start(key), { rangeBytes: MIB })).toBe("skipped");
    expect(await row(key)).toEqual(stored); expect(await work(key)).toBeNull(); expect(get).not.toHaveBeenCalled(); get.mockRestore();
  });

  it("a start for an overwritten object recomputes it", async () => {
    const key = `${prefix}overwritten`; await database.MEDIA.put(key, "first"); await runChain(key, { rangeBytes: MIB });
    const second = await database.MEDIA.put(key, "second!"); await runChain(key, { rangeBytes: MIB });
    expect(await row(key)).toMatchObject({ crc32: crc32(new TextEncoder().encode("second!")), bytes: 7, etag: second.etag });
  });

  it("a start for a failed object is left alone", async () => {
    const key = `${prefix}failed-start`; await database.MEDIA.put(key, "x");
    await database.DB.prepare(`INSERT INTO object_crc32_work (r2_key, state, attempts, requested_at, updated_at, last_error) VALUES (?1, 'failed', 3, 1, 1, 'boom')`).bind(key).run();
    expect(await processObjectCrc(jobEnv().env, start(key), { rangeBytes: MIB })).toBe("stale");
    expect(await work(key)).toMatchObject({ state: "failed", last_error: "boom" }); expect(await row(key)).toBeNull();
  });
});

describe("processObjectCrc, failures", () => {
  const failingMedia = (message: string) => ({ head: (key: string) => database.MEDIA.head(key), get: async () => { throw new Error(message); } });

  it("rethrows on the first two attempts so the queue retries, and records the failure on the third", async () => {
    const key = `${prefix}fails`; await database.MEDIA.put(key, "abc"); const { env: job } = jobEnv(undefined, failingMedia("R2 is down"));
    await expect(processObjectCrc(job, start(key), { rangeBytes: MIB, attempts: 1 })).rejects.toThrow("R2 is down");
    expect(await work(key)).toMatchObject({ state: "queued", attempts: 1, last_error: "R2 is down" });
    await expect(processObjectCrc(job, start(key), { rangeBytes: MIB, attempts: 2 })).rejects.toThrow("R2 is down");
    expect(await processObjectCrc(job, start(key), { rangeBytes: MIB, attempts: 3 })).toBe("failed");
    expect(await work(key)).toMatchObject({ state: "failed", attempts: 3, last_error: "R2 is down" }); expect(await row(key)).toBeNull();
  });

  it("records a failure even when no work row exists yet", async () => {
    const key = `${prefix}fails-early`; const broken = { head: async () => { throw new Error("head failed"); }, get: async () => null };
    expect(await processObjectCrc(jobEnv(undefined, broken).env, start(key), { rangeBytes: MIB, attempts: 3 })).toBe("failed");
    expect(await work(key)).toMatchObject({ state: "failed", attempts: 3, last_error: "head failed", etag: null });
  });

  it("a short read is a failure, not a checksum", async () => {
    const key = `${prefix}short`; await database.MEDIA.put(key, "0123456789");
    const media = { head: (k: string) => database.MEDIA.head(k), get: async (k: string, o: R2GetOptions) => { const object = await database.MEDIA.get(k, o); return object && "body" in object ? { etag: object.etag, size: object.size, body: new Blob(["012"]).stream() } : object; } };
    await expect(processObjectCrc(jobEnv(undefined, media).env, start(key), { rangeBytes: MIB, attempts: 1 })).rejects.toThrow(/read 3 of 10 bytes/);
    expect(await row(key)).toBeNull();
  });

  it("a failure on a stale continuation does not mark the newer run failed", async () => {
    const key = `${prefix}stale-fail`; await database.MEDIA.put(key, random(2 * MIB)); const { env: job } = jobEnv(); await processObjectCrc(job, start(key), { rangeBytes: MIB });
    const media = { head: () => { throw new Error("late failure"); }, get: async () => null };
    expect(await processObjectCrc(jobEnv(undefined, media).env, { type: "object_crc32", r2Key: key, etag: "old", offset: 0 }, { rangeBytes: MIB, attempts: 3 })).toBe("stale");
    expect(await work(key)).toMatchObject({ state: "queued" });
  });
});

describe("processObjectCrc, ownership of a failure", () => {
  const plant = (key: string, etag: string, offset: number, state = "queued", token = "planted", updatedAt = Date.now()) =>
    database.DB.prepare(`INSERT INTO object_crc32_work (r2_key, etag, bytes, "offset", crc_partial, state, attempts, requested_at, updated_at, claim_token) VALUES (?1, ?2, 100, ?3, 0, ?4, 0, 1, ?6, ?5)`).bind(key, etag, offset, state, token, updatedAt).run();

  it("a start that cannot claim a live run writes nothing, whatever it would have hit", async () => {
    const key = `${prefix}own-start`; await database.MEDIA.put(key, "x"); await plant(key, "newer-etag", 40, "running");
    const before = await work(key); const broken = { head: async () => { throw new Error("head failed"); }, get: async () => null };
    expect(await processObjectCrc(jobEnv(undefined, broken).env, start(key), { rangeBytes: MIB, attempts: 3 })).toBe("stale");
    expect(await work(key)).toEqual(before);
  });

  it("an owner displaced by a takeover cannot fail, advance or finish the run that took over", async () => {
    const key = `${prefix}own-displaced`; const data = random(2 * MIB); await database.MEDIA.put(key, data);
    const takeover = { head: (k: string) => database.MEDIA.head(k), get: async () => { await database.DB.prepare("UPDATE object_crc32_work SET claim_token = 'takeover', attempts = 0 WHERE r2_key = ?").bind(key).run(); throw new Error("late failure"); } };
    expect(await processObjectCrc(jobEnv(undefined, takeover).env, start(key), { rangeBytes: MIB, attempts: 3 })).toBe("failed");
    expect(await work(key)).toMatchObject({ state: "running", last_error: null, claim_token: "takeover" });
    const slow = { head: (k: string) => database.MEDIA.head(k), get: async (k: string, o: R2GetOptions) => { await database.DB.prepare("UPDATE object_crc32_work SET claim_token = 'takeover' WHERE r2_key = ?").bind(key).run(); return database.MEDIA.get(k, o); } };
    const { env: job, queue } = jobEnv(undefined, slow); await database.DB.prepare("UPDATE object_crc32_work SET state = 'queued' WHERE r2_key = ?").bind(key).run();
    expect(await processObjectCrc(job, start(key), { rangeBytes: MIB })).toBe("stale");
    expect(queue.sent).toEqual([]); expect(await row(key)).toBeNull();
  });

  it("an obsolete continuation that sees the object gone does not fail the run that replaced it", async () => {
    const key = `${prefix}own-obsolete`; await plant(key, "replacement", 40, "queued");
    const before = await work(key);
    expect(await processObjectCrc(jobEnv().env, { type: "object_crc32", r2Key: key, etag: "old", offset: 0 }, { rangeBytes: MIB })).toBe("stale");
    expect(await processObjectCrc(jobEnv().env, { type: "object_crc32", r2Key: key, etag: "replacement", offset: 0 }, { rangeBytes: MIB })).toBe("stale");
    expect(await work(key)).toEqual(before);
  });

  it("a start for a gone object fails a row nobody has begun, and leaves a live run to its own continuation", async () => {
    const fresh = `${prefix}own-gone-fresh`; await database.DB.prepare("INSERT INTO object_crc32_work (r2_key, state, requested_at, updated_at) VALUES (?, 'queued', 1, 1)").bind(fresh).run();
    expect(await processObjectCrc(jobEnv().env, start(fresh), { rangeBytes: MIB })).toBe("missing"); expect(await work(fresh)).toMatchObject({ state: "failed" });
    const running = `${prefix}own-gone-running`; await plant(running, "e", 40); const before = await work(running);
    expect(await processObjectCrc(jobEnv().env, start(running), { rangeBytes: MIB })).toBe("stale"); expect(await work(running)).toEqual(before);
  });
});

describe("processObjectCrc, claim first (Sol r2)", () => {
  const plant = (key: string, fields: { etag?: string | null; offset?: number; state?: string; updatedAt: number; token?: string }) =>
    database.DB.prepare(`INSERT INTO object_crc32_work (r2_key, etag, bytes, "offset", crc_partial, state, attempts, requested_at, updated_at, claim_token) VALUES (?1, ?2, ?3, ?4, 0, ?5, 0, 1, ?6, ?7)`)
      .bind(key, fields.etag ?? null, fields.etag ? 100 : null, fields.offset ?? 0, fields.state ?? "queued", fields.updatedAt, fields.token ?? "planted").run();
  const NOW = Date.now(); const QUIET = NOW - CRC_STALE_MS - 1;

  it("1. a start that finds a stored CRC does not delete the work row of a live run", async () => {
    const key = `${prefix}r2-cached`; await database.MEDIA.put(key, "done"); await runChain(key, { rangeBytes: MIB }); const stored = (await database.MEDIA.head(key))!.etag;
    await plant(key, { etag: stored, offset: 0, state: "queued", updatedAt: NOW, token: "planted-9" }); const before = await work(key);
    expect(await processObjectCrc(jobEnv().env, start(key), { rangeBytes: MIB, now: NOW })).toBe("stale");
    expect(await work(key)).toEqual(before);
  });

  it("2. an owner whose HEAD sees the object gone after a takeover does not fail the run that took over", async () => {
    const key = `${prefix}r2-missing-displaced`; await database.MEDIA.put(key, random(2 * MIB));
    const media = { head: async () => { await database.DB.prepare("UPDATE object_crc32_work SET claim_token = 'takeover' WHERE r2_key = ?").bind(key).run(); return null; }, get: async () => null };
    expect(await processObjectCrc(jobEnv(undefined, media).env, start(key), { rangeBytes: MIB })).toBe("missing");
    expect(await work(key)).toMatchObject({ state: "running", last_error: null, claim_token: "takeover" });
  });

  it("3. a swept row whose HEAD keeps throwing ends failed, because the claim came first", async () => {
    const key = `${prefix}r2-sweep-head`; await plant(key, { updatedAt: NOW });
    const broken = { head: async () => { throw new Error("head failed"); }, get: async () => null }; const { env: job } = jobEnv(undefined, broken);
    await expect(processObjectCrc(job, start(key), { rangeBytes: MIB, attempts: 1, now: NOW })).rejects.toThrow("head failed");
    await expect(processObjectCrc(job, start(key), { rangeBytes: MIB, attempts: 2, now: NOW })).rejects.toThrow("head failed");
    expect(await processObjectCrc(job, start(key), { rangeBytes: MIB, attempts: 3, now: NOW })).toBe("failed");
    expect(await work(key)).toMatchObject({ state: "failed", attempts: 3, last_error: "head failed" });
  });

  it("4. a start for a quiet, already initialised row whose object is gone fails it, and one for a live row leaves it alone", async () => {
    const quiet = `${prefix}r2-quiet-gone`; await plant(quiet, { etag: "e", offset: 40, state: "queued", updatedAt: QUIET });
    expect(await processObjectCrc(jobEnv().env, start(quiet), { rangeBytes: MIB, now: NOW })).toBe("missing"); expect(await work(quiet)).toMatchObject({ state: "failed", last_error: "The object is not in R2" });
    const live = `${prefix}r2-live-gone`; await plant(live, { etag: "e", offset: 40, state: "queued", updatedAt: NOW }); const before = await work(live);
    expect(await processObjectCrc(jobEnv().env, start(live), { rangeBytes: MIB, now: NOW })).toBe("stale"); expect(await work(live)).toEqual(before);
  });

  it("a start never claims a live run, even on a retry, but takes a failed attempt's row back at once", async () => {
    const key = `${prefix}r2-retry`; await database.MEDIA.put(key, "abc");
    const flaky = { head: (k: string) => database.MEDIA.head(k), get: async () => { throw new Error("blip"); } };
    await expect(processObjectCrc(jobEnv(undefined, flaky).env, start(key), { rangeBytes: MIB, attempts: 1 })).rejects.toThrow("blip");
    expect(await work(key)).toMatchObject({ state: "queued", attempts: 1, last_error: "blip" });
    expect(await processObjectCrc(jobEnv().env, start(key), { rangeBytes: MIB, attempts: 2 })).toBe("stored");
    await plant(`${key}-live`, { etag: "e", state: "running", updatedAt: Date.now() });
    expect(await processObjectCrc(jobEnv().env, start(`${key}-live`), { rangeBytes: MIB, attempts: 2 })).toBe("stale");
  });
});

describe("processObjectCrc, a claim token never repeats (Sol r3)", () => {
  it("r3-1: a stalled old owner cannot store a CRC into a new run made after its row was deleted", async () => {
    const key = `${prefix}r3-reuse`; await database.MEDIA.put(key, "old bytes"); const { env: job } = jobEnv();
    const media = { head: (k: string) => database.MEDIA.head(k), get: async (k: string, o: R2GetOptions) => {
      // The old owner stalls in R2. Meanwhile its run finished elsewhere and the object was overwritten, so a new run began on the same key.
      await database.DB.prepare("DELETE FROM object_crc32_work WHERE r2_key = ?").bind(key).run();
      await database.DB.prepare(`INSERT INTO object_crc32_work (r2_key, etag, bytes, "offset", crc_partial, state, attempts, requested_at, updated_at, claim_token) VALUES (?, 'new-etag', 7, 0, 0, 'running', 1, 1, ?, 'new-owner')`).bind(key, Date.now()).run();
      return database.MEDIA.get(k, o); } };
    expect(await processObjectCrc({ ...job, MEDIA: media as never }, start(key), {})).toBe("stale");
    expect(await row(key)).toBeNull(); expect(await work(key)).toMatchObject({ etag: "new-etag", state: "running", claim_token: "new-owner" });
  });

  it("every claim stamps a new random token, and a queued row holds none", async () => {
    const key = `${prefix}r3-tokens`; await database.MEDIA.put(key, random(3 * MIB)); const { env: job, queue } = jobEnv(); const seen = new Set<string>();
    const spy = vi.spyOn(crypto, "randomUUID");
    await processObjectCrc(job, start(key), { rangeBytes: MIB }); expect(await work(key)).toMatchObject({ state: "queued", claim_token: null });
    await processObjectCrc(job, queue.sent.shift()!, { rangeBytes: MIB }); await processObjectCrc(job, queue.sent.shift()!, { rangeBytes: MIB });
    for (const result of spy.mock.results) seen.add(String(result.value)); spy.mockRestore();
    expect(seen.size).toBe(3);
  });
});

describe("crcOfBody", () => {
  it("reads an R2 body with a BYOB reader and calls readAtLeast", async () => {
    const key = `${prefix}byob`; const data = random(2 * MIB + 11); await database.MEDIA.put(key, data);
    const body = (await database.MEDIA.get(key))!.body; const original = body.getReader.bind(body); let reader: ReadableStreamBYOBReader | undefined; let readAtLeast: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(body, "getReader").mockImplementation(((options?: { mode: "byob" }) => { const made = original(options as never); if (options?.mode === "byob") { reader = made as ReadableStreamBYOBReader; readAtLeast = vi.spyOn(reader, "readAtLeast"); } return made; }) as never);
    const result = await crcOfBody(body, data.length, 0, MIB);
    expect(reader).toBeDefined(); expect(readAtLeast).toHaveBeenCalled();
    expect(readAtLeast!.mock.calls[0]![0]).toBe(MIB);
    expect(result).toEqual({ crc: crc32(data), bytes: data.length });
  });

  it("continues from a previous CRC", async () => {
    const data = random(5000); const head = crc32(data.subarray(0, 2000));
    expect(await crcOfBody(new Blob([data.subarray(2000)]).stream(), 3000, head)).toEqual({ crc: crc32(data), bytes: 3000 });
  });

  it("falls back to the default reader for a stream that is not a byte stream", async () => {
    const data = random(300_000);
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (let at = 0; at < data.length; at += 4096) controller.enqueue(data.subarray(at, at + 4096)); controller.close(); } });
    expect(await crcOfBody(body, data.length)).toEqual({ crc: crc32(data), bytes: data.length });
  });

  it("falls back to read() on a BYOB reader that has no readAtLeast, and sums short reads", async () => {
    const data = random(10_000); let at = 0;
    const reader = { read: async (view: Uint8Array) => { const n = Math.min(3000, data.length - at, view.byteLength); if (n === 0) return { done: true, value: new Uint8Array(view.buffer, 0, 0) }; view.set(data.subarray(at, at + n)); at += n; return { done: false, value: new Uint8Array(view.buffer, 0, n) }; }, releaseLock: () => undefined };
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
    expect(await crcOfBody(body, data.length, 0, 4096)).toEqual({ crc: crc32(data), bytes: data.length });
  });

  it("reports a long read rather than hiding it", async () => {
    const data = random(1000);
    expect((await crcOfBody(new Blob([data]).stream(), 400)).bytes).toBe(1000);
  });
});

describe("the quincy-object-crcs consumer", () => {
  const service = (extra: Record<string, unknown> = {}) => new QuincyBackground({} as ExecutionContext, { DB: database.DB, MEDIA: database.MEDIA, APP_ORIGIN: "https://portal.test", ...extra } as never);
  const message = (body: unknown, attempts = 1) => ({ body, attempts, ack: vi.fn(), retry: vi.fn() });
  const deliver = async (delivered: ReturnType<typeof message>, extra: Record<string, unknown> = {}) => { await service(extra).queue({ queue: "quincy-object-crcs", messages: [delivered] } as never); return delivered; };

  it("computes and acks, without RENDITIONS_ENABLED", async () => {
    const key = `${prefix}queued`; await database.MEDIA.put(key, "123456789");
    const delivered = await deliver(message(start(key)), { OBJECT_CRC_QUEUE: fakeQueue() });
    expect(delivered.ack).toHaveBeenCalledOnce(); expect(delivered.retry).not.toHaveBeenCalled();
    expect(await row(key)).toMatchObject({ crc32: 0xcbf43926 });
  });

  it("acks a message that does not parse, and one for a missing object", async () => {
    const bad = await deliver(message({ type: "object_crc32" })); expect(bad.ack).toHaveBeenCalledOnce(); expect(bad.retry).not.toHaveBeenCalled();
    const gone = await deliver(message(start(`${prefix}nothing`))); expect(gone.ack).toHaveBeenCalledOnce(); expect(await row(`${prefix}nothing`)).toBeNull();
  });

  it("acks a duplicate delivery", async () => {
    const key = `${prefix}dup`; await database.MEDIA.put(key, "dup"); await deliver(message(start(key)));
    const again = await deliver(message(start(key)));
    expect(again.ack).toHaveBeenCalledOnce(); expect(again.retry).not.toHaveBeenCalled();
  });

  it("retries a failure, and on the last attempt records it in the work row and acks", async () => {
    const key = `${prefix}consumer-fails`; await database.MEDIA.put(key, "abc");
    const media = { head: (k: string) => database.MEDIA.head(k), get: async () => { throw new Error("R2 is down"); } };
    const first = await deliver(message(start(key), 1), { MEDIA: media });
    expect(first.retry).toHaveBeenCalledOnce(); expect(first.ack).not.toHaveBeenCalled();
    const last = await deliver(message(start(key), CRC_MAX_ATTEMPTS), { MEDIA: media });
    expect(last.ack).toHaveBeenCalledOnce(); expect(last.retry).not.toHaveBeenCalled();
    expect(await work(key)).toMatchObject({ state: "failed", last_error: "R2 is down" });
  });
});
