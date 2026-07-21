import { describe, expect, it } from "vitest";
import { INGEST_QUEUE_NAME, parseQueueBody, RENDITION_QUEUE_NAME } from "../src/queue-dispatch";

describe("queue-name dispatch", () => {
  it("accepts rendition work only on its concurrency-limited queue", () => {
    expect(parseQueueBody(RENDITION_QUEUE_NAME, { type: "generate_renditions", assetId: "asset-1" })).toEqual({ queue: RENDITION_QUEUE_NAME, body: { type: "generate_renditions", assetId: "asset-1" } });
    expect(parseQueueBody(INGEST_QUEUE_NAME, { type: "generate_renditions", assetId: "asset-1" })).toBeNull();
  });

  it("rejects malformed and unknown queue messages for explicit retry/DLQ handling", () => {
    expect(parseQueueBody(RENDITION_QUEUE_NAME, { type: "generate_renditions" })).toBeNull();
    expect(parseQueueBody(RENDITION_QUEUE_NAME, { type: "dropbox_sync", projectId: "p" })).toBeNull();
    expect(parseQueueBody(INGEST_QUEUE_NAME, { type: "autohdr_check", projectId: "p" })).toBeNull();
    expect(parseQueueBody(INGEST_QUEUE_NAME, { type: "autohdr_check", jobId: "job-1" })).toEqual({ queue: INGEST_QUEUE_NAME, body: { type: "autohdr_check", jobId: "job-1" } });
    expect(parseQueueBody("unknown", { type: "asset_ingested", assetId: "asset-1" })).toBeNull();
  });
});
