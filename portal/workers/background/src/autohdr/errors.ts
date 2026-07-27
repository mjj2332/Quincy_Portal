export type AutoHdrErrorCode =
  | "ERR_PROJECT_ARCHIVED"
  | "ERR_NO_RAW_SELECTION"
  | "ERR_MAPPING_BLOCKED"
  | "ERR_HANDOFF_BLOCKED"
  | "ERR_HANDOFF_DISAPPEARED"
  | "ERR_FOLDER_NOT_READY"
  | "ERR_FETCH_CLAIM_FAILED"
  | "ERR_HANDOFF_ALREADY_ACTIVE"
  | "ERR_FETCH_IN_PROGRESS"
  | "ERR_SEND_IN_PROGRESS"
  | "ERR_REMOVAL_SET_CHANGED";

export class AutoHdrClaimError extends Error {
  constructor(
    public readonly code: AutoHdrErrorCode,
    message: string,
    public readonly details?: { removalCount?: number; removalSetHash?: string },
  ) {
    super(message);
    this.name = "AutoHdrClaimError";
  }
}

export type AutoHdrResult =
  | { ok: true; jobId: string; handoffId: string; workflowId: string }
  | { ok: false; code: AutoHdrErrorCode; message: string; removalCount?: number; removalSetHash?: string };

export type AutoHdrFetchResult =
  | { ok: true; jobId: string; fetchClaimId: string }
  | { ok: false; code: AutoHdrErrorCode; message: string };
