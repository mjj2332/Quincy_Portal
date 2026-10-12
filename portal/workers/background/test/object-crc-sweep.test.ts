import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectCrcMessage } from "@quincy/shared";
import QuincyBackground from "../src";
import { CRC_STALE_MS, processObjectCrc } from "../src/object-crc";
import { OBJECT_CRC_SWEEP_LIMIT, sweepObjectCrcs } from "../src/object-crc-sweep";

/** The hourly object CRC sweep (#802): backfills and repairs the CRC of every zip-eligible original that has no stored CRC and no live work row. */
const database = env as unknown as { DB: D1Database; MEDIA: R2Bucket };
declare const __PORTAL_MIGRATION_SQL__: string;
const NOW = 1_800_000_000_000;
const userId = "d2222222-2222-4222-8222-222222222222";
const id = () => crypto.randomUUID();
const run = (sql: string, ...binds: unknown[]) => database.DB.prepare(sql).bind(...binds).run();
const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); }
  }
}
function fakeQueue(fail = false) {
  const sent: ObjectCrcMessage[] = [];
  return { sent, sendBatch: vi.fn(async (messages: Array<{ body: ObjectCrcMessage }>) => { if (fail) throw new Error("queue unavailable"); for (const message of messages) sent.push(message.body); }) };
}
const keys = (queue: { sent: ObjectCrcMessage[] }) => queue.sent.map((message) => message.r2Key).sort();
const workRows = async () => (await database.DB.prepare('SELECT r2_key, etag, state, "offset", attempts FROM object_crc32_work ORDER BY r2_key').all<{ r2_key: string; etag: string | null; state: string; offset: number; attempts: number }>()).results;

let projectId = ""; const collections: Record<string, string> = {};
beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await run("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'Sweep Editor', 'sweep-editor@example.test', 1, 'editor', 1, ?, ?)", userId, NOW, NOW);
});
beforeEach(async () => {
  await database.DB.batch(["projects", "audit_log", "object_crc32", "object_crc32_work"].map((table) => database.DB.prepare(`DELETE FROM ${table}`)));
  projectId = id();
  await run("INSERT INTO projects (id, street, stage_key, created_at, updated_at) VALUES (?, 'Sweep Street', 'editing_autohdr', ?, ?)", projectId, NOW, NOW);
  for (const kind of ["raw", "edited", "video", "floorplan"]) { collections[kind] = id(); await run("INSERT INTO collections (id, project_id, kind, status, received_count, created_at, updated_at) VALUES (?, ?, ?, 'received', 1, ?, ?)", collections[kind], projectId, kind, NOW, NOW); }
});
afterEach(() => { consoleError.mockClear(); consoleLog.mockClear(); });

type AssetInput = { collection: string; kind?: string; publish?: string; superseded?: boolean; at?: number; key?: string };
async function asset(input: AssetInput): Promise<{ id: string; key: string }> {
  const assetId = id(); const key = input.key ?? `projects/${projectId}/${input.collection}/${assetId}/file`; const at = input.at ?? NOW;
  await run("INSERT INTO assets (id, collection_id, kind, r2_key, original_filename, bytes, source, publish_status, superseded_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'f.jpg', 4, 'upload', ?, ?, ?, ?)", assetId, collections[input.collection], input.kind ?? "photo", key, input.publish ?? "ready", input.superseded ? NOW : null, at, at);
  return { id: assetId, key };
}
async function version(input: { released?: boolean; withdrawn?: boolean; trashed?: boolean; at?: number } = {}): Promise<{ id: string; key: string }> {
  const videoId = id(); const a = await asset({ collection: "video", kind: "video", at: input.at });
  await run("INSERT INTO videos (id, project_id, collection_id, title, premium, position, created_by, created_at, updated_at, version_high_water) VALUES (?, ?, ?, 'Walkthrough', 0, 0, ?, ?, ?, 1)", videoId, projectId, collections.video, userId, NOW, NOW);
  await run("INSERT INTO video_version_meta (asset_id, video_id, fps_num, fps_den, media_timescale, frame_delta, frame_count, duration_ms, width, height, codec, codec_string, start_tc_frames, tc_nominal_fps, tc_drop_frame, fast_start, has_audio, probe_version, poster_key, uploaded_by, created_at, removed_at) VALUES (?, ?, 25, 1, 25000, 1000, 250, 10000, 1920, 1080, 'avc1', 'avc1.640028', NULL, 25, 0, 1, 1, 1, NULL, ?, ?, ?)", a.id, videoId, userId, NOW, input.trashed ? NOW : null);
  if (input.released !== false) {
    const eventId = id();
    await run("INSERT INTO video_approval_events (id, project_id, video_id, asset_id, link_id, revision, decision, note, actor_guest_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, NULL, 1, 'approved', NULL, NULL, ?, ?)", eventId, projectId, videoId, a.id, userId, NOW);
    await run("INSERT INTO video_releases (id, project_id, video_id, asset_id, approval_event_id, approval_revision, released_by, released_at, withdrawn_at, withdrawn_by) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)", id(), projectId, videoId, a.id, eventId, userId, NOW, input.withdrawn ? NOW : null, input.withdrawn ? userId : null);
  }
  return a;
}
const crcRow = (key: string) => run("INSERT INTO object_crc32 (r2_key, crc32, bytes, etag, computed_at) VALUES (?, 1, 4, 'e', ?)", key, NOW);
const workRow = (key: string, state: string, updatedAt: number, etag: string | null = null) => run('INSERT INTO object_crc32_work (r2_key, etag, bytes, "offset", crc_partial, state, attempts, requested_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, 1, ?, ?)', key, etag, etag === null ? null : 4, state, updatedAt, updatedAt);

describe("sweepObjectCrcs", () => {
  it("picks the zip-eligible originals: RAW photos, ready Edited photos and released live video Versions", async () => {
    const raw = await asset({ collection: "raw" }); const edited = await asset({ collection: "edited" }); const released = await version();
    const queue = fakeQueue();
    const result = await sweepObjectCrcs({ DB: database.DB, OBJECT_CRC_QUEUE: queue as never }, NOW);
    expect(result).toEqual({ candidates: 3, queued: 3 });
    expect(keys(queue)).toEqual([raw.key, edited.key, released.key].sort());
    for (const message of queue.sent) expect(message).toEqual({ type: "object_crc32", r2Key: message.r2Key });
  });

  it("leaves out what no zip route includes", async () => {
    await asset({ collection: "edited", publish: "pending" }); await asset({ collection: "edited", publish: "failed" });
    await asset({ collection: "raw", superseded: true }); await asset({ collection: "floorplan", kind: "floorplan_pdf" }); await asset({ collection: "raw", kind: "floorplan_preview" });
    await version({ released: false }); await version({ withdrawn: true }); await version({ trashed: true });
    const queue = fakeQueue();
    expect(await sweepObjectCrcs({ DB: database.DB, OBJECT_CRC_QUEUE: queue as never }, NOW)).toEqual({ candidates: 0, queued: 0 });
    expect(queue.sendBatch).not.toHaveBeenCalled(); expect(await workRows()).toEqual([]);
  });

  it("includes a superseded RAW that is still selected for editing, as selected-raw.zip does, and not one that is merely superseded", async () => {
    const selected = await asset({ collection: "raw", superseded: true }); const plain = await asset({ collection: "raw", superseded: true });
    await run("INSERT INTO selections (id, asset_id, selected_by, state, created_at) VALUES (?, ?, ?, 'selected_for_editing', ?)", id(), selected.id, userId, NOW);
    const queue = fakeQueue();
    expect(await sweepObjectCrcs({ DB: database.DB, OBJECT_CRC_QUEUE: queue as never }, NOW)).toEqual({ candidates: 1, queued: 1 });
    expect(keys(queue)).toEqual([selected.key]); expect(plain.key).not.toBe(selected.key);
  });

  it("picks only the keys with no stored CRC and no live work row", async () => {
    const stored = await asset({ collection: "raw" }); const live = await asset({ collection: "raw" }); const failed = await asset({ collection: "raw" }); const missing = await asset({ collection: "raw" });
    await crcRow(stored.key); await workRow(live.key, "queued", NOW - 60_000, "e-live"); await workRow(failed.key, "failed", NOW - 99 * CRC_STALE_MS);
    const queue = fakeQueue();
    expect(await sweepObjectCrcs({ DB: database.DB, OBJECT_CRC_QUEUE: queue as never }, NOW)).toEqual({ candidates: 1, queued: 1 });
    expect(keys(queue)).toEqual([missing.key]);
    expect((await workRows()).map((row) => [row.r2_key, row.state]).sort()).toEqual([[failed.key, "failed"], [live.key, "queued"], [missing.key, "queued"]].sort());
  });

  it("inserts a queued work row, with no etag yet, for every key it sends", async () => {
    const raw = await asset({ collection: "raw" }); await sweepObjectCrcs({ DB: database.DB, OBJECT_CRC_QUEUE: fakeQueue() as never }, NOW);
    expect(await workRows()).toEqual([{ r2_key: raw.key, etag: null, state: "queued", offset: 0, attempts: 0 }]);
  });

  it("never mutates an existing work row, and sends a start for one a start can claim", async () => {
    const abandoned = await asset({ collection: "raw" }); const lost = await asset({ collection: "raw" }); const live = await asset({ collection: "raw" });
    await workRow(abandoned.key, "running", NOW - CRC_STALE_MS - 1, "e1"); await workRow(lost.key, "queued", NOW - CRC_STALE_MS - 1); await workRow(live.key, "running", NOW - 1000, "e2");
    const before = await workRows(); const queue = fakeQueue();
    expect(await sweepObjectCrcs({ DB: database.DB, OBJECT_CRC_QUEUE: queue as never }, NOW)).toEqual({ candidates: 2, queued: 2 });
    expect(keys(queue)).toEqual([abandoned.key, lost.key].sort());
    expect(await workRows()).toEqual(before);
    expect(await database.DB.prepare("SELECT count(*) AS n FROM object_crc32_work WHERE updated_at = ?").bind(NOW).first()).toEqual({ n: 0 });
  });

  it("r3-2: a start emitted for an abandoned, initialised row can claim it (the sweep did not refresh it)", async () => {
    const lostContinuation = await asset({ collection: "raw" }); await database.MEDIA.put(lostContinuation.key, "bytes!");
    await workRow(lostContinuation.key, "queued", NOW - CRC_STALE_MS - 1, "an-old-etag");
    const queue = fakeQueue(); await sweepObjectCrcs({ DB: database.DB, OBJECT_CRC_QUEUE: queue as never }, NOW);
    expect(queue.sent).toEqual([{ type: "object_crc32", r2Key: lostContinuation.key }]);
    const outcome = await processObjectCrc({ DB: database.DB, MEDIA: database.MEDIA, OBJECT_CRC_QUEUE: queue as never }, queue.sent[0]!, { now: NOW });
    expect(outcome).not.toBe("stale"); expect(["restarted", "advanced", "stored"]).toContain(outcome);
  });

  it("r3-3: a delivery that claims a row between the sweep's read and its write is not undone", async () => {
    const raw = await asset({ collection: "raw" }); await workRow(raw.key, "running", NOW - CRC_STALE_MS - 1, "e1");
    // The claim lands right after the sweep's read of its candidates, before anything it writes.
    const racing = new Proxy(database.DB, { get(target, property) {
      if (property === "prepare") return (sql: string) => { const statement = target.prepare(sql); if (!sql.includes("FROM (")) return statement;
        return new Proxy(statement, { get(inner, key) { const value = Reflect.get(inner, key, inner); if (key === "bind") return (...binds: unknown[]) => { const bound = inner.bind(...binds); return new Proxy(bound, { get(b2, k2) { const v2 = Reflect.get(b2, k2, b2); return k2 === "all" ? async () => { const result = await b2.all(); await run("UPDATE object_crc32_work SET state = 'running', updated_at = ? WHERE r2_key = ?", NOW, raw.key); return result; } : typeof v2 === "function" ? v2.bind(b2) : v2; } }); }; return typeof value === "function" ? value.bind(inner) : value; } }); };
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    await sweepObjectCrcs({ DB: racing as D1Database, OBJECT_CRC_QUEUE: fakeQueue() as never }, NOW);
    expect(await workRows()).toEqual([expect.objectContaining({ r2_key: raw.key, state: "running" })]);
    expect(await database.DB.prepare("SELECT updated_at FROM object_crc32_work WHERE r2_key = ?").bind(raw.key).first()).toEqual({ updated_at: NOW });
  });

  it("queues rows nobody has before rows that went quiet, and the oldest quiet first", async () => {
    const quietOld = await asset({ collection: "raw", at: NOW + 9000 }); const quietNew = await asset({ collection: "raw", at: NOW + 9000 });
    await workRow(quietOld.key, "queued", NOW - 5 * CRC_STALE_MS); await workRow(quietNew.key, "queued", NOW - 2 * CRC_STALE_MS);
    const fresh = await asset({ collection: "raw", at: NOW + 1 }); const fresher = await asset({ collection: "raw", at: NOW + 2 });
    const queue = fakeQueue();
    expect(await sweepObjectCrcs({ DB: database.DB, OBJECT_CRC_QUEUE: queue as never }, NOW, 3)).toEqual({ candidates: 3, queued: 3 });
    expect(keys(queue)).toEqual([fresh.key, fresher.key, quietOld.key].sort());
  });

  it("takes newest first and stops at the cap", async () => {
    const made: Array<{ key: string; at: number }> = [];
    for (let index = 0; index < 8; index += 1) made.push({ key: (await asset({ collection: "raw", at: NOW + index * 1000 })).key, at: NOW + index * 1000 });
    const queue = fakeQueue();
    expect(await sweepObjectCrcs({ DB: database.DB, OBJECT_CRC_QUEUE: queue as never }, NOW, 3)).toEqual({ candidates: 3, queued: 3 });
    expect(keys(queue)).toEqual(made.slice(-3).map((entry) => entry.key).sort());
    expect(OBJECT_CRC_SWEEP_LIMIT).toBe(500);
  });

  it("sweeps the same key once however many ways it is eligible", async () => {
    const key = `projects/${projectId}/shared/key`; await asset({ collection: "raw", key: `${key}-a` });
    const queue = fakeQueue(); await sweepObjectCrcs({ DB: database.DB, OBJECT_CRC_QUEUE: queue as never }, NOW);
    expect(new Set(keys(queue)).size).toBe(queue.sent.length);
  });

  it("never throws: a failing queue leaves the work rows to go stale and be taken back, and no binding queues nothing", async () => {
    const raw = await asset({ collection: "raw" });
    expect(await sweepObjectCrcs({ DB: database.DB, OBJECT_CRC_QUEUE: fakeQueue(true) as never }, NOW)).toEqual({ candidates: 1, queued: 0 });
    expect(await workRows()).toHaveLength(1);
    const queue = fakeQueue();
    // A row that was never begun is sent again at once (a start can claim it); the send that failed is the repair.
    expect(await sweepObjectCrcs({ DB: database.DB, OBJECT_CRC_QUEUE: queue as never }, NOW)).toEqual({ candidates: 1, queued: 1 });
    expect(keys(queue)).toEqual([raw.key]);
    expect(await sweepObjectCrcs({ DB: database.DB }, NOW)).toEqual({ candidates: 1, queued: 0 });
  });
});

describe("the hourly cron", () => {
  it("runs the sweep on 0 * * * * and not on the minute cron", async () => {
    const raw = await asset({ collection: "raw" }); const queue = fakeQueue();
    const service = new QuincyBackground({} as ExecutionContext, { DB: database.DB, MEDIA: database.MEDIA, OBJECT_CRC_QUEUE: queue, APP_ORIGIN: "https://portal.test" } as never);
    await service.scheduled({ cron: "* * * * *", scheduledTime: NOW } as never);
    expect(queue.sent).toEqual([]);
    await service.scheduled({ cron: "0 * * * *", scheduledTime: NOW } as never);
    expect(keys(queue)).toEqual([raw.key]);
  });
});
