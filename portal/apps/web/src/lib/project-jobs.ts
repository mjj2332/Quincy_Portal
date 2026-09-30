/**
 * Background jobs as the Collaboration tab shows them (#378). `ProjectWorkspace` owns the fetching,
 * polling and the AutoHDR retry; this module owns what a job is called, how its status reads and
 * when it may be retried, so the Activity "System" view and the Collection body share one rule.
 */
export type JobKind =
  | "autohdr_api_send" | "autohdr" | "fetch_edited" | "autohdr_scaffold"
  | "editor_reconcile" | "editor_sync" | "manual_edited_publish" | "manual_raw_publish";
export type JobStatus = "queued" | "running" | "done" | "failed" | "stuck";
export type Job = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  error: string | null;
  correlationId: string | null;
  createdAt: string;
  updatedAt: string;
};

/** The tones `quincy/StatusPill` accepts for a job status. */
export type JobStatusTone = "neutral" | "positive" | "critical";

export function jobKindLabel(kind: JobKind): string {
  switch (kind) {
    case "autohdr_api_send": return "API send";
    case "fetch_edited": return "Fetch";
    case "autohdr_scaffold": return "Scaffold";
    case "editor_reconcile": return "Editor folder";
    case "editor_sync": return "Editor sync";
    case "manual_edited_publish":
    case "manual_raw_publish": return "Manual upload";
    default: return "Send";
  }
}

export function jobStatusTone(status: JobStatus): JobStatusTone {
  if (status === "done") return "positive";
  if (status === "failed" || status === "stuck") return "critical";
  return "neutral";
}

/** A failed or stuck job may be retried, except an AutoHDR API send (the server does not requeue it). */
export function canRetryJob(job: Pick<Job, "kind" | "status">): boolean {
  return job.kind !== "autohdr_api_send" && (job.status === "failed" || job.status === "stuck");
}
