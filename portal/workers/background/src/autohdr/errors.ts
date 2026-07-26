export type AutoHdrErrorCode =
  | "ERR_PROJECT_ARCHIVED"
  | "ERR_NO_RAW_SELECTION"
  | "ERR_MAPPING_BLOCKED"
  | "ERR_HANDOFF_BLOCKED"
  | "ERR_HANDOFF_DISAPPEARED"
  | "ERR_FOLDER_NOT_READY";

export type AutoHdrResult =
  | { ok: true; jobId: string; handoffId: string; workflowId: string }
  | { ok: false; code: AutoHdrErrorCode; message: string };

export type AutoHdrFetchResult =
  | { ok: true; jobId: string; fetchClaimId: string }
  | { ok: false; code: AutoHdrErrorCode; message: string };
