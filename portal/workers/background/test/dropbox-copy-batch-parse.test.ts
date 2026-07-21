import { describe, expect, it } from "vitest";
import { parseCopyBatchResult, type DropboxCopyBatchCompleteResult } from "../src/dropbox/client";

// Regression: copy_batch_v2 / copy_batch/check_v2 serialization varies (some structs inline, some
// nest under the tag name). The parser must never throw AFTER a copy has landed. We don't read
// success metadata; we only need to distinguish complete/async and success/failure. See lessons.md.
describe("parseCopyBatchResult", () => {
  const successEntry = { ".tag": "success", success: { ".tag": "file", name: "a.jpg", path_lower: "/x/a.jpg", id: "id:1", size: 100 } };
  const conflictFailure = { ".tag": "failure", failure: { ".tag": "relocation_error", relocation_error: { ".tag": "to", to: { ".tag": "conflict", conflict: { ".tag": "file" } } } } };

  it("parses a complete result with entries inline under the tag", () => {
    const result = parseCopyBatchResult({ ".tag": "complete", entries: [successEntry, conflictFailure] }) as DropboxCopyBatchCompleteResult;
    expect(result[".tag"]).toBe("complete");
    expect(result.entries.map((e) => e[".tag"])).toEqual(["success", "failure"]);
  });

  it("parses a complete result with entries nested under `complete`", () => {
    const result = parseCopyBatchResult({ ".tag": "complete", complete: { entries: [successEntry] } }) as DropboxCopyBatchCompleteResult;
    expect(result[".tag"]).toBe("complete");
    expect(result.entries[0][".tag"]).toBe("success");
  });

  it("does not throw on a success entry regardless of metadata shape", () => {
    const inlineSuccess = { ".tag": "success", name: "b.jpg", path_lower: "/x/b.jpg", id: "id:2", size: 5 };
    const result = parseCopyBatchResult({ ".tag": "complete", entries: [inlineSuccess] }) as DropboxCopyBatchCompleteResult;
    expect(result.entries[0][".tag"]).toBe("success");
  });

  it("parses an async_job_id result", () => {
    expect(parseCopyBatchResult({ ".tag": "async_job_id", async_job_id: "job-xyz" })).toEqual({ ".tag": "async_job_id", async_job_id: "job-xyz" });
  });
});
