import { describe, expect, it } from "vitest";
import { canRetryJob, jobKindLabel, jobStatusTone, type Job } from "./project-jobs";

const base: Job = { id: "j", kind: "fetch_edited", status: "failed", error: null, correlationId: null, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z" };

describe("project jobs", () => {
  it("labels every kind as the Background jobs card did", () => {
    const labels: Record<Job["kind"], string> = {
      autohdr_api_send: "API send",
      fetch_edited: "Fetch",
      autohdr_scaffold: "Scaffold",
      editor_reconcile: "Editor folder",
      editor_sync: "Editor sync",
      manual_edited_publish: "Manual upload",
      manual_raw_publish: "Manual upload",
      autohdr: "Send",
    };
    for (const [kind, label] of Object.entries(labels)) expect(jobKindLabel(kind as Job["kind"]), kind).toBe(label);
  });

  it("maps statuses to pill tones", () => {
    expect(jobStatusTone("queued")).toBe("neutral");
    expect(jobStatusTone("running")).toBe("neutral");
    expect(jobStatusTone("done")).toBe("positive");
    expect(jobStatusTone("failed")).toBe("critical");
    expect(jobStatusTone("stuck")).toBe("critical");
  });

  it("allows retry only for failed or stuck jobs that are not an API send", () => {
    for (const status of ["failed", "stuck"] as const) {
      expect(canRetryJob({ ...base, status })).toBe(true);
      expect(canRetryJob({ ...base, status, kind: "autohdr_api_send" })).toBe(false);
    }
    for (const status of ["queued", "running", "done"] as const) expect(canRetryJob({ ...base, status })).toBe(false);
  });
});
