import { describe, expect, it } from "vitest";
import { enqueueManualEditedRenditions, publishStatusAfterWorkflowCreateFailure } from "../src/manual-edited-renditions";

describe("manual edited rendition handoff", () => {
  it("keeps a Dropbox-published asset ready when retry workflow creation fails", () => {
    expect(publishStatusAfterWorkflowCreateFailure("ready")).toBe("ready");
    expect(publishStatusAfterWorkflowCreateFailure("pending")).toBe("failed");
    expect(publishStatusAfterWorkflowCreateFailure("failed")).toBe("failed");
  });

  it("fails rather than completing publication when rendition enqueue is unavailable", async () => {
    await expect(enqueueManualEditedRenditions({ RENDITIONS_ENABLED: false } as never, crypto.randomUUID()))
      .rejects.toThrow("Rendition queue handoff failed");
  });
});
