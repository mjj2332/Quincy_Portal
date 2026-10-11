import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OBJECT_CRC_QUEUE_NAME } from "../../shared/src/object-crc";

/** The object CRC queue (#802) is its own queue: a message is up to a 512 MiB range read, so it must not share the rendition queue's consumer, concurrency or DLQ. */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const strip = (jsonc: string) => JSON.parse(jsonc.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n")) as { queues: { consumers?: Array<Record<string, unknown>>; producers: Array<Record<string, unknown>> } };
const background = strip(read("../../../workers/background/wrangler.jsonc")); const app = strip(read("../../../workers/app/wrangler.jsonc"));

describe("the quincy-object-crcs queue wiring", () => {
  it("is consumed by the background Worker with batch 1, concurrency 4, 3 retries and no dead-letter queue", () => {
    expect(OBJECT_CRC_QUEUE_NAME).toBe("quincy-object-crcs");
    const consumers = background.queues.consumers!.filter((consumer) => consumer.queue === OBJECT_CRC_QUEUE_NAME);
    expect(consumers).toEqual([{ queue: "quincy-object-crcs", max_batch_size: 1, max_concurrency: 4, max_retries: 3 }]);
  });

  it("is produced through OBJECT_CRC_QUEUE by both Workers, and the app consumes nothing", () => {
    for (const config of [app, background]) expect(config.queues.producers).toContainEqual({ binding: "OBJECT_CRC_QUEUE", queue: "quincy-object-crcs" });
    expect((app.queues as { consumers?: unknown }).consumers).toBeUndefined();
  });

  it("leaves the rendition queue and its DLQ as they were", () => {
    expect(background.queues.consumers).toContainEqual({ queue: "quincy-renditions", max_batch_size: 1, max_concurrency: 1, max_retries: 3, dead_letter_queue: "quincy-renditions-dlq" });
  });

  it("types the binding in both Workers' Env", () => {
    expect(read("../../../workers/app/src/env.ts")).toMatch(/OBJECT_CRC_QUEUE\?: Queue<ObjectCrcMessage>/);
    expect(read("../../../workers/background/src/env.ts")).toMatch(/OBJECT_CRC_QUEUE\?: Queue<ObjectCrcMessage>/);
  });
});
