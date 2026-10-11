import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueueObjectCrcMessages, enqueueObjectCrcs, OBJECT_CRC_QUEUE_NAME, OBJECT_CRC_SEND_BATCH, parseObjectCrcMessage } from "../src/object-crc";
import * as shared from "../src/index";

const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
afterEach(() => consoleError.mockClear());
const queue = () => { const batches: Array<Array<{ body: unknown }>> = []; return { batches, sendBatch: vi.fn(async (messages: Array<{ body: unknown }>) => { batches.push(messages); }) }; };

describe("the object CRC queue contract (#802)", () => {
  it("names its own queue, apart from renditions, and is exported from the package", () => {
    expect(OBJECT_CRC_QUEUE_NAME).toBe("quincy-object-crcs");
    expect(shared.OBJECT_CRC_QUEUE_NAME).toBe("quincy-object-crcs");
    expect(OBJECT_CRC_SEND_BATCH).toBe(100);
  });

  it("parses a start message and a continuation, and refuses anything else", () => {
    expect(parseObjectCrcMessage({ type: "object_crc32", r2Key: "k" })).toEqual({ type: "object_crc32", r2Key: "k" });
    expect(parseObjectCrcMessage({ type: "object_crc32", r2Key: "k", etag: "e", offset: 5 })).toEqual({ type: "object_crc32", r2Key: "k", etag: "e", offset: 5 });
    for (const bad of [null, "k", {}, { type: "object_crc32" }, { type: "object_crc32", r2Key: "" }, { type: "object_crc32", r2Key: 7 }, { type: "generate_renditions", r2Key: "k" },
      { type: "object_crc32", r2Key: "k", offset: 5 }, { type: "object_crc32", r2Key: "k", etag: "", offset: 5 }, { type: "object_crc32", r2Key: "k", etag: "e", offset: -1 }, { type: "object_crc32", r2Key: "k", etag: "e", offset: 1.5 }, { type: "object_crc32", r2Key: "k", etag: "e" }]) {
      expect(parseObjectCrcMessage(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("enqueueObjectCrcs", () => {
  it("sends one start message per distinct key with sendBatch, at most 100 to a call", async () => {
    const q = queue(); const keys = Array.from({ length: 250 }, (_, index) => `k${index}`);
    expect(await enqueueObjectCrcs({ OBJECT_CRC_QUEUE: q }, [...keys, "k0", "k1"], "test")).toBe(250);
    expect(q.batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(q.batches[0]![0]).toEqual({ body: { type: "object_crc32", r2Key: "k0" } });
    expect(new Set(q.batches.flat().map((message) => (message.body as { r2Key: string }).r2Key)).size).toBe(250);
  });

  it("sends nothing for no keys", async () => {
    const q = queue(); expect(await enqueueObjectCrcs({ OBJECT_CRC_QUEUE: q }, [], "test")).toBe(0); expect(q.sendBatch).not.toHaveBeenCalled();
  });

  it("never throws: a missing binding and a failing send are logged and counted as not sent", async () => {
    expect(await enqueueObjectCrcs({}, ["a"], "test")).toBe(0);
    const failing = { sendBatch: vi.fn(async () => { throw new Error("queue unavailable"); }) };
    expect(await enqueueObjectCrcs({ OBJECT_CRC_QUEUE: failing }, ["a", "b"], "test")).toBe(0);
    expect(consoleError).toHaveBeenCalledTimes(2);
  });

  it("keeps sending the later batches when one batch fails", async () => {
    let call = 0; const sent: number[] = [];
    const flaky = { sendBatch: vi.fn(async (messages: unknown[]) => { call += 1; if (call === 1) throw new Error("once"); sent.push(messages.length); }) };
    expect(await enqueueObjectCrcs({ OBJECT_CRC_QUEUE: flaky }, Array.from({ length: 150 }, (_, index) => `k${index}`), "test")).toBe(50);
    expect(sent).toEqual([50]);
  });
});

describe("enqueueObjectCrcMessages", () => {
  it("sends continuations as they are", async () => {
    const q = queue();
    expect(await enqueueObjectCrcMessages({ OBJECT_CRC_QUEUE: q }, [{ type: "object_crc32", r2Key: "k", etag: "e", offset: 7 }], "test")).toBe(1);
    expect(q.batches[0]).toEqual([{ body: { type: "object_crc32", r2Key: "k", etag: "e", offset: 7 } }]);
  });
});
