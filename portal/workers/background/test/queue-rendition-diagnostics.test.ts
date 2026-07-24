import { describe, expect, it, vi } from "vitest";

import QuincyBackground from "../src";

describe("background rendition queue failures", () => {
  it("logs a sanitized diagnostic and retries a failed rendition message", async () => {
    const retry = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = new QuincyBackground(
      {} as ExecutionContext,
      { RENDITIONS_ENABLED: true } as never,
    );

    try {
      await worker.queue({
        queue: "quincy-renditions",
        messages: [{
          body: { type: "generate_renditions", assetId: "asset-1" },
          ack: vi.fn(),
          retry,
        }],
      } as never);

      expect(retry).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith("Background queue message failed", {
        queue: "quincy-renditions",
        type: "generate_renditions",
        assetId: "asset-1",
        renditionFailure: {
          stage: "unknown",
          code: "unclassified-rendition-failure",
        },
      });
      expect(JSON.stringify(error.mock.calls)).not.toContain("TRANSFORM_SOURCE_SECRET");
    } finally {
      error.mockRestore();
    }
  });
});
