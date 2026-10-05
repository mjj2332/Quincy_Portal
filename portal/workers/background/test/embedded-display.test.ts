import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import QuincyBackground from "../src";
import { recoverEmbeddedRenditions } from "../src/embedded-display-recovery";
import { sweepEmbeddedMedia } from "../src/embedded-media-sweep";
import { parseQueueBody, RENDITION_DLQ_QUEUE_NAME, RENDITION_QUEUE_NAME, INGEST_QUEUE_NAME } from "../src/queue-dispatch";

/** The HEIC display copy consumer (#495): claim, transform, check, adopt, the retry and DLQ paths, and the recovery cron. */
declare const __PORTAL_MIGRATION_SQL__: string;
const database = env as unknown as { DB: D1Database; MEDIA: R2Bucket };
const projectId = "d1111111-1111-4111-8111-111111111111";
const userId = "d2222222-2222-4222-8222-222222222222";
const now = 1_800_000_000_000;
const minute = 60_000;

async function executeSql(source: string): Promise<void> {
  for (const chunk of source.split("--> statement-breakpoint")) {
    const sql = chunk.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const statement of sql.split(";")) { const flat = statement.replace(/\s+/g, " ").trim(); if (flat) await database.DB.exec(`${flat};`); }
  }
}

function jpeg(options: { width?: number; height?: number; exif?: boolean; xmp?: boolean } = {}): Uint8Array {
  const { width = 640, height = 480 } = options;
  const text = (value: string) => [...value].map((c) => c.charCodeAt(0));
  const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
  return new Uint8Array([0xff, 0xd8, ...segment(0xe0, [...text("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(options.exif ? segment(0xe1, [...text("Exif\0\0"), 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8]) : []),
    ...(options.xmp ? segment(0xe1, [...text("http://ns.adobe.com/xap/1.0/\0"), 60, 120]) : []),
    ...segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ...segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]), 9, 8, 7, 6, 5, 4, 3, 2, 1, 0xff, 0xd9]);
}
const heic = () => { const bytes = new Uint8Array(512); bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0x68, 0x65, 0x69, 0x63]); return bytes; };
const edgeOk = { "content-type": "image/jpeg", "cf-resized": "internal=ok" };

type Seed = { state?: "uploading" | "pending" | "attached" | "detached"; status?: "not_required" | "pending" | "ready" | "failed"; attempts?: number; lease?: number | null; requestedAt?: number | null; createdAt?: number; notice?: boolean; display?: boolean };
async function seed(input: Seed = {}) {
  const id = crypto.randomUUID(); const notice = input.notice === true; const state = input.state ?? "pending";
  const key = notice ? `notice-board/embedded-media/${id}/original` : `projects/${projectId}/embedded-media/${id}/original`;
  const displayKey = input.display ? `${key.replace(/original$/, "")}display-seed.jpg` : null;
  const ownerId = state === "attached" || state === "detached" ? crypto.randomUUID() : null;
  const createdAt = input.createdAt ?? now;
  await database.DB.prepare("INSERT INTO embedded_media (id, owner_kind, owner_id, project_id, uploader_id, kind, content_type, bytes, original_key, display_key, display_content_type, state, detached_at, created_at, updated_at, rendition_status, rendition_attempts, rendition_lease_until, rendition_requested_at) VALUES (?, ?, ?, ?, ?, 'image', 'image/heic', 512, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, notice ? "notice_post" : "project_comment", ownerId, notice ? null : projectId, userId, key, displayKey, displayKey ? "image/jpeg" : null, state, state === "detached" ? now : null, createdAt, createdAt, input.status ?? "pending", input.attempts ?? 0, input.lease ?? null, input.requestedAt === undefined ? now : input.requestedAt).run();
  await database.MEDIA.put(key, heic());
  if (displayKey) await database.MEDIA.put(displayKey, jpeg());
  return { id, key, displayKey };
}
const row = (id: string) => database.DB.prepare("SELECT * FROM embedded_media WHERE id = ?").bind(id).first<Record<string, unknown>>();
const dlqEvents = async () => (await database.DB.prepare("SELECT count(*) AS n FROM rendition_dlq_events").first<{ n: number }>())!.n;
const objectKeys = async (id: string) => (await database.MEDIA.list({ prefix: `projects/${projectId}/embedded-media/${id}/` })).objects.map((object) => object.key);

const workerEnv = (extra: Record<string, unknown> = {}) => ({ DB: database.DB, MEDIA: database.MEDIA, APP_ORIGIN: "https://portal.test", TRANSFORM_SOURCE_SECRET: "test-transform-source-secret-32-bytes", RENDITIONS_ENABLED: true, ...extra });
const service = (extra: Record<string, unknown> = {}) => new QuincyBackground({} as ExecutionContext, workerEnv(extra) as never);
function message(body: unknown) { return { body, attempts: 1, ack: vi.fn(), retry: vi.fn() }; }
async function deliver(queue: string, body: unknown, extra: Record<string, unknown> = {}) { const delivered = message(body); await service(extra).queue({ queue, messages: [delivered] } as never); return delivered; }
const stubFetch = (handler: (url: string) => Response | Promise<Response>) => { const calls: string[] = []; vi.stubGlobal("fetch", async (input: RequestInfo | URL) => { const url = new Request(input).url; calls.push(url); return handler(url); }); return calls; };

beforeAll(async () => {
  await executeSql(__PORTAL_MIGRATION_SQL__);
  await database.DB.prepare("INSERT INTO user (id, name, email, email_verified, role, active, created_at, updated_at) VALUES (?, 'U', 'u@example.test', 1, 'admin', 1, ?, ?)").bind(userId, now, now).run();
  await database.DB.prepare("INSERT INTO projects (id, street, stage_key, board_position, created_at, updated_at) VALUES (?, 'S', 'editing_autohdr', 0, ?, ?)").bind(projectId, now, now).run();
});
beforeEach(async () => { await database.DB.exec("DELETE FROM rendition_dlq_events; DELETE FROM embedded_media; DELETE FROM embedded_media_cleanup;"); });
afterEach(() => { vi.unstubAllGlobals(); });
const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
afterEach(() => { consoleError.mockClear(); consoleLog.mockClear(); });

describe("queue dispatch for the embedded_display message", () => {
  it("carries the generation through when it is a finite integer, and drops it otherwise (Sol P2-4)", () => {
    for (const queue of [RENDITION_QUEUE_NAME, RENDITION_DLQ_QUEUE_NAME]) {
      expect(parseQueueBody(queue, { type: "embedded_display", mediaId: "m-1", generation: 1_800_000_000_000 })).toEqual({ queue, body: { type: "embedded_display", mediaId: "m-1", generation: 1_800_000_000_000 } });
      expect(parseQueueBody(queue, { type: "embedded_display", mediaId: "m-1", generation: "x" })).toEqual({ queue, body: { type: "embedded_display", mediaId: "m-1" } });
    }
  });

  it("accepts it on the rendition queue and its dead-letter queue, and nowhere else", () => {
    expect(parseQueueBody(RENDITION_QUEUE_NAME, { type: "embedded_display", mediaId: "m-1" })).toEqual({ queue: RENDITION_QUEUE_NAME, body: { type: "embedded_display", mediaId: "m-1" } });
    expect(parseQueueBody(RENDITION_DLQ_QUEUE_NAME, { type: "embedded_display", mediaId: "m-1" })).toEqual({ queue: RENDITION_DLQ_QUEUE_NAME, body: { type: "embedded_display", mediaId: "m-1" } });
    expect(parseQueueBody(INGEST_QUEUE_NAME, { type: "embedded_display", mediaId: "m-1" })).toBeNull();
    for (const bad of [{ type: "embedded_display" }, { type: "embedded_display", mediaId: "" }, { type: "embedded_display", mediaId: 5 }, { type: "embedded_display", assetId: "a" }]) expect(parseQueueBody(RENDITION_QUEUE_NAME, bad), JSON.stringify(bad)).toBeNull();
    expect(parseQueueBody(RENDITION_QUEUE_NAME, { type: "generate_renditions", assetId: "a-1" })?.body).toEqual({ type: "generate_renditions", assetId: "a-1" });
  });
});

describe("the embedded_display consumer", () => {
  it("makes the JPEG from a signed source URL asking for a 4096 px JPEG with no metadata, adopts it, and acks", async () => {
    const { id, key } = await seed(); const output = jpeg({ width: 4096, height: 3072 });
    const calls = stubFetch(() => new Response(output, { headers: edgeOk }));
    const delivered = await deliver(RENDITION_QUEUE_NAME, { type: "embedded_display", mediaId: id });
    expect(delivered.ack).toHaveBeenCalledOnce(); expect(delivered.retry).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!);
    expect(url.pathname.startsWith("/cdn-cgi/image/width=4096,height=4096,fit=scale-down,quality=85,format=jpeg,metadata=none/")).toBe(true);
    expect(calls[0]).toContain(`/__transform-source/${key.split("/").map(encodeURIComponent).join("/")}`);
    expect(calls[0]).toMatch(/sig=[0-9a-zA-Z_-]+/);
    const stored = await row(id);
    expect(stored).toMatchObject({ rendition_status: "ready", display_content_type: "image/jpeg", display_bytes: output.byteLength, display_width: 4096, display_height: 3072, rendition_lease_until: null, rendition_attempts: 1 });
    const body = new Uint8Array(await (await database.MEDIA.get(stored!.display_key as string))!.arrayBuffer());
    expect([...body]).toEqual([...output]);
    expect([...new Uint8Array(await (await database.MEDIA.get(key))!.arrayBuffer())].slice(4, 8)).toEqual([0x66, 0x74, 0x79, 0x70]); // the HEIC original is untouched
    expect(await database.DB.prepare("SELECT count(*) AS n FROM embedded_media_cleanup").first()).toEqual({ n: 0 });
  });

  it("acks without converting a message from an older generation, and converts one that matches (Sol P2-4)", async () => {
    const { id } = await seed({ requestedAt: now + minute }); const calls = stubFetch(() => new Response(jpeg(), { headers: edgeOk }));
    const stale = await deliver(RENDITION_QUEUE_NAME, { type: "embedded_display", mediaId: id, generation: now });
    expect(stale.ack).toHaveBeenCalledOnce(); expect(calls).toHaveLength(0); expect(await row(id)).toMatchObject({ rendition_status: "pending", rendition_attempts: 0 });
    const current = await deliver(RENDITION_QUEUE_NAME, { type: "embedded_display", mediaId: id, generation: now + minute });
    expect(current.ack).toHaveBeenCalledOnce(); expect(calls).toHaveLength(1); expect(await row(id)).toMatchObject({ rendition_status: "ready" });
  });

  it("acks a duplicate delivery with no fetch", async () => {
    const { id } = await seed(); const calls = stubFetch(() => new Response(jpeg(), { headers: edgeOk }));
    await deliver(RENDITION_QUEUE_NAME, { type: "embedded_display", mediaId: id });
    const again = await deliver(RENDITION_QUEUE_NAME, { type: "embedded_display", mediaId: id });
    expect(again.ack).toHaveBeenCalledOnce(); expect(calls).toHaveLength(1);
    const gone = await deliver(RENDITION_QUEUE_NAME, { type: "embedded_display", mediaId: crypto.randomUUID() });
    expect(gone.ack).toHaveBeenCalledOnce(); expect(calls).toHaveLength(1);
  });

  it("fails the row and acks when the output still carries EXIF or XMP, writing no object", async () => {
    for (const output of [jpeg({ exif: true }), jpeg({ xmp: true })]) {
      const { id } = await seed(); stubFetch(() => new Response(output, { headers: edgeOk }));
      const delivered = await deliver(RENDITION_QUEUE_NAME, { type: "embedded_display", mediaId: id });
      expect(delivered.ack).toHaveBeenCalledOnce(); expect(delivered.retry).not.toHaveBeenCalled();
      expect(await row(id)).toMatchObject({ rendition_status: "failed", display_key: null, rendition_lease_until: null });
      expect(String((await row(id))!.rendition_error)).toContain("EXIF");
      expect(await objectKeys(id)).toEqual([`projects/${projectId}/embedded-media/${id}/original`]);
    }
  });

  it("fails permanently on a non-JPEG, an err= result and an output over 4096 px", async () => {
    const cases: Response[] = [new Response(heic(), { headers: { "content-type": "image/heic", "cf-resized": "internal=ok" } }), new Response("x", { status: 415, headers: { "content-type": "text/plain", "cf-resized": "err=9520" } }), new Response(jpeg({ width: 5000, height: 10 }), { headers: edgeOk })];
    for (const response of cases) {
      const { id } = await seed(); stubFetch(() => response.clone());
      const delivered = await deliver(RENDITION_QUEUE_NAME, { type: "embedded_display", mediaId: id });
      expect(delivered.ack).toHaveBeenCalledOnce(); expect(await row(id)).toMatchObject({ rendition_status: "failed" });
    }
  });

  it("releases the lease and retries the message on a transient failure, so the redelivery can claim it again", async () => {
    const { id } = await seed(); stubFetch(() => new Response("edge", { status: 503 }));
    const delivered = await deliver(RENDITION_QUEUE_NAME, { type: "embedded_display", mediaId: id });
    expect(delivered.retry).toHaveBeenCalledOnce(); expect(delivered.ack).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ rendition_status: "pending", rendition_lease_until: 0, rendition_attempts: 1 });
    expect(consoleError).toHaveBeenCalledWith("Background queue message failed", expect.objectContaining({ queue: "quincy-renditions", type: "embedded_display", mediaId: id, embeddedFailure: expect.stringContaining("503") }));
    stubFetch(() => new Response(jpeg(), { headers: edgeOk }));
    const redelivered = await deliver(RENDITION_QUEUE_NAME, { type: "embedded_display", mediaId: id });
    expect(redelivered.ack).toHaveBeenCalledOnce(); expect(await row(id)).toMatchObject({ rendition_status: "ready", rendition_attempts: 2 });
  });

  it("sets the row failed once it has been claimed past the attempt cap, without a transformation", async () => {
    const { id } = await seed({ attempts: 4 }); const calls = stubFetch(() => new Response(jpeg(), { headers: edgeOk }));
    const delivered = await deliver(RENDITION_QUEUE_NAME, { type: "embedded_display", mediaId: id });
    expect(delivered.ack).toHaveBeenCalledOnce(); expect(calls).toHaveLength(0);
    expect(await row(id)).toMatchObject({ rendition_status: "failed", rendition_error: "attempts" });
  });

  it("throws (retries) without touching the row while renditions are disabled", async () => {
    const { id } = await seed(); const calls = stubFetch(() => new Response(jpeg(), { headers: edgeOk }));
    const delivered = await deliver(RENDITION_QUEUE_NAME, { type: "embedded_display", mediaId: id }, { RENDITIONS_ENABLED: false });
    expect(delivered.retry).toHaveBeenCalledOnce(); expect(delivered.ack).not.toHaveBeenCalled(); expect(calls).toHaveLength(0);
    expect(await row(id)).toMatchObject({ rendition_status: "pending", rendition_attempts: 0, rendition_lease_until: null });
  });

  it("converts a Notice board image and an attached whiteboard-style row", async () => {
    stubFetch(() => new Response(jpeg(), { headers: edgeOk }));
    const notice = await seed({ notice: true }); const attached = await seed({ state: "attached" });
    for (const { id } of [notice, attached]) await deliver(RENDITION_QUEUE_NAME, { type: "embedded_display", mediaId: id });
    expect((await row(notice.id))!.display_key).toMatch(/^notice-board\/embedded-media\/.+\/display-.+\.jpg$/);
    expect(await row(attached.id)).toMatchObject({ rendition_status: "ready", state: "attached" });
  });

  it("loses to a sweep that claimed the row mid conversion: the copy is deleted and the row stays swept", async () => {
    const old = now - 8 * 24 * 60 * minute;
    const { id } = await seed({ createdAt: old });
    stubFetch(async () => { await sweepEmbeddedMedia(workerEnv() as never, now); return new Response(jpeg(), { headers: edgeOk }); });
    const delivered = await deliver(RENDITION_QUEUE_NAME, { type: "embedded_display", mediaId: id });
    expect(delivered.ack).toHaveBeenCalledOnce();
    expect(await row(id)).toBeNull(); expect(await objectKeys(id)).toEqual([]);
    expect(await database.DB.prepare("SELECT count(*) AS n FROM embedded_media_cleanup WHERE storage_key LIKE '%/display-%'").first()).toEqual({ n: 0 });
  });
});

describe("the rendition dead-letter queue and embedded_display", () => {
  it("sets a pending row failed with no rendition_dlq_events row, and acks", async () => {
    const { id } = await seed({ attempts: 4, lease: now + 5 * minute });
    const delivered = await deliver(RENDITION_DLQ_QUEUE_NAME, { type: "embedded_display", mediaId: id });
    expect(delivered.ack).toHaveBeenCalledOnce(); expect(delivered.retry).not.toHaveBeenCalled();
    expect(await row(id)).toMatchObject({ rendition_status: "failed", rendition_error: "dlq", rendition_lease_until: null });
    expect(await dlqEvents()).toBe(0);
    expect(consoleError).toHaveBeenCalledWith("Embedded display DLQ message", expect.objectContaining({ mediaId: id, failedRow: true }));
  });

  it("does not fail a new run on a stale DLQ redelivery: DLQ, then Retry, then the old DLQ message again leaves the row pending (Sol P2-4)", async () => {
    const { id } = await seed({ requestedAt: now });
    const first = await deliver(RENDITION_DLQ_QUEUE_NAME, { type: "embedded_display", mediaId: id, generation: now });
    expect(first.ack).toHaveBeenCalledOnce(); expect(await row(id)).toMatchObject({ rendition_status: "failed", rendition_error: "dlq" });
    // Retry, exactly as the uploader's route writes it: back to pending with a fresh generation.
    await database.DB.prepare("UPDATE embedded_media SET rendition_status = 'pending', rendition_attempts = 0, rendition_lease_until = NULL, rendition_error = NULL, rendition_requested_at = ? WHERE id = ? AND rendition_status = 'failed'").bind(now + minute, id).run();
    const stale = await deliver(RENDITION_DLQ_QUEUE_NAME, { type: "embedded_display", mediaId: id, generation: now });
    expect(stale.ack).toHaveBeenCalledOnce();
    expect(await row(id)).toMatchObject({ rendition_status: "pending", rendition_error: null, rendition_requested_at: now + minute });
    expect(consoleError).toHaveBeenCalledWith("Embedded display DLQ message", expect.objectContaining({ mediaId: id, failedRow: false }));
    // The new generation's own DLQ message does fail it.
    await deliver(RENDITION_DLQ_QUEUE_NAME, { type: "embedded_display", mediaId: id, generation: now + minute });
    expect(await row(id)).toMatchObject({ rendition_status: "failed", rendition_error: "dlq" });
  });

  it("is a no-op for a missing row and for one that is already ready", async () => {
    const ready = await seed({ status: "ready", display: true });
    for (const mediaId of [crypto.randomUUID(), ready.id]) { const delivered = await deliver(RENDITION_DLQ_QUEUE_NAME, { type: "embedded_display", mediaId }); expect(delivered.ack).toHaveBeenCalledOnce(); }
    expect(await row(ready.id)).toMatchObject({ rendition_status: "ready" }); expect(await dlqEvents()).toBe(0);
  });

  it("still records an asset message exactly as before", async () => {
    const delivered = await deliver(RENDITION_DLQ_QUEUE_NAME, { nonsense: true });
    expect(delivered.ack).toHaveBeenCalledOnce(); expect(await dlqEvents()).toBe(1);
  });
});

describe("the recovery cron", () => {
  const sent: unknown[] = [];
  const queueEnv = (extra: Record<string, unknown> = {}) => ({ DB: database.DB, RENDITIONS_ENABLED: true, RENDITION_QUEUE: { send: async (body: unknown) => { sent.push(body); } }, ...extra }) as never;
  beforeEach(() => { sent.length = 0; });

  it("re-sends a stale pending row once, and bumps its requested time so an overlapping run sends nothing", async () => {
    const stale = await seed({ requestedAt: now - 11 * minute });
    expect(await recoverEmbeddedRenditions(queueEnv(), now)).toEqual({ resent: 1, failed: 0 });
    expect(sent).toEqual([{ type: "embedded_display", mediaId: stale.id, generation: now }]);
    expect((await row(stale.id))!.rendition_requested_at).toBe(now);
    expect(await recoverEmbeddedRenditions(queueEnv(), now + minute)).toEqual({ resent: 0, failed: 0 });
    expect(sent).toHaveLength(1);
  });

  it("leaves alone a fresh row, a leased row, a ready or failed row, an uploading row and a row with no request time", async () => {
    await seed({ requestedAt: now - 5 * minute }); await seed({ requestedAt: now - 30 * minute, lease: now + minute });
    await seed({ requestedAt: now - 30 * minute, status: "ready", display: true }); await seed({ requestedAt: now - 30 * minute, status: "failed" });
    await seed({ requestedAt: now - 30 * minute, state: "uploading" }); await seed({ requestedAt: null }); await seed({ requestedAt: now - 30 * minute, status: "not_required" });
    expect(await recoverEmbeddedRenditions(queueEnv(), now)).toEqual({ resent: 0, failed: 0 }); expect(sent).toEqual([]);
  });

  it("takes a row whose lease has expired, and one that is attached", async () => {
    const expired = await seed({ requestedAt: now - 30 * minute, lease: now - minute }); const attached = await seed({ requestedAt: now - 29 * minute, state: "attached" });
    expect(await recoverEmbeddedRenditions(queueEnv(), now)).toEqual({ resent: 2, failed: 0 });
    expect(sent).toEqual([{ type: "embedded_display", mediaId: expired.id, generation: now }, { type: "embedded_display", mediaId: attached.id, generation: now }]);
  });

  it("stays within ten rows a run, oldest first", async () => {
    const seeded = []; for (let index = 0; index < 13; index += 1) seeded.push(await seed({ requestedAt: now - (60 - index) * minute }));
    expect((await recoverEmbeddedRenditions(queueEnv(), now)).resent).toBe(10);
    expect(sent).toEqual(seeded.slice(0, 10).map((item) => ({ type: "embedded_display", mediaId: item.id, generation: now })));
  });

  it("fails a row past the attempt cap instead of re-sending it", async () => {
    const { id } = await seed({ requestedAt: now - 30 * minute, attempts: 5 });
    expect(await recoverEmbeddedRenditions(queueEnv(), now)).toEqual({ resent: 0, failed: 1 });
    expect(await row(id)).toMatchObject({ rendition_status: "failed", rendition_error: "attempts" }); expect(sent).toEqual([]);
  });

  it("does nothing while renditions are off, and keeps the row's request time when the send fails", async () => {
    const { id } = await seed({ requestedAt: now - 30 * minute });
    expect(await recoverEmbeddedRenditions(queueEnv({ RENDITIONS_ENABLED: false }), now)).toEqual({ resent: 0, failed: 0 }); expect(sent).toEqual([]);
    const failing = queueEnv({ RENDITION_QUEUE: { send: async () => { throw new Error("queue down"); } } });
    expect(await recoverEmbeddedRenditions(failing, now)).toEqual({ resent: 0, failed: 0 });
    expect((await row(id))!.rendition_requested_at).toBe(now); // the next attempt is ten minutes out
  });
});

describe("the sweep and a HEIC row", () => {
  it("reclaims an old ready HEIC that was never posted: original and display copy both go", async () => {
    const old = now - 8 * 24 * 60 * minute;
    const { id, key, displayKey } = await seed({ status: "ready", display: true, createdAt: old });
    const result = await sweepEmbeddedMedia({ DB: database.DB, MEDIA: database.MEDIA }, now);
    expect(result.reclaimed).toBe(1);
    expect(await row(id)).toBeNull(); expect(await database.MEDIA.head(key)).toBeNull(); expect(await database.MEDIA.head(displayKey!)).toBeNull();
  });
});
