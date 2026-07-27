import { describe, expect, it } from "vitest";
import { parseDeleteBatchCheckResult, parseDeleteBatchResult } from "../src/dropbox/client";

describe("Dropbox delete_batch response parsing", () => {
  const success = { ".tag": "success" };
  const missing = { ".tag": "failure", failure: { ".tag": "path", path: { ".tag": "not_found" } } };

  it("parses synchronous and asynchronous launch results", () => {
    expect(parseDeleteBatchResult({ ".tag": "complete", entries: [success, missing] })).toMatchObject({ ".tag": "complete", entries: [{ ".tag": "success" }, { ".tag": "failure" }] });
    expect(parseDeleteBatchResult({ ".tag": "async_job_id", async_job_id: "delete-job" })).toEqual({ ".tag": "async_job_id", async_job_id: "delete-job" });
  });

  it("models in-progress, complete, and top-level failed checks", () => {
    expect(parseDeleteBatchCheckResult({ ".tag": "in_progress" })).toEqual({ ".tag": "in_progress" });
    expect(parseDeleteBatchCheckResult({ ".tag": "complete", complete: { entries: [success] } })).toMatchObject({ ".tag": "complete" });
    expect(parseDeleteBatchCheckResult({ ".tag": "failed", failed: { ".tag": "other" } })).toMatchObject({ ".tag": "failed" });
  });
});
