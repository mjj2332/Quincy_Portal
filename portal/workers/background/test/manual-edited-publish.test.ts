import { describe, expect, it } from "vitest";
import { enqueueManualEditedRenditions } from "../src/manual-edited-renditions";

describe("manual edited rendition handoff", () => {
  it("fails rather than completing publication when rendition enqueue is unavailable", async () => {
    await expect(enqueueManualEditedRenditions({ RENDITIONS_ENABLED: false } as never, crypto.randomUUID()))
      .rejects.toThrow("Rendition queue handoff failed");
  });
});
