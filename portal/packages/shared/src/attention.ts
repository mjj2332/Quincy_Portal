/** Latches a human has to clear (#163), as the app serves them. Most severe kind first. */
export const EDITOR_FOLDER_ATTENTION_KINDS = [
  "editor_folder_move_stuck",
  "editor_folder_move_overdue",
  "editor_folder_needs_review",
  "editor_folder_move_blocked",
] as const;
export type EditorFolderAttentionKind = (typeof EDITOR_FOLDER_ATTENTION_KINDS)[number];

export type EditorFolderAttentionDto = {
  kind: EditorFolderAttentionKind;
  /** Safe for any staff viewer: says what is affected, never why. */
  headline: string;
  code: string;
  /** Operator diagnostics (paths, provider errors); null when withheld from the viewer. */
  detail: string | null;
  /** The row's last write, which is not necessarily when the latch began. */
  updatedAt: number;
};

export type AttentionItemDto = EditorFolderAttentionDto & { projectId: string; projectLabel: string };

/** #161's External Editor provisioning freeze, read-only. Released from Admin → Users. */
export type ProvisioningFreezeDto = { frozenAt: number; attempts: number | null; jobId: string | null };

export type AdminAttentionResponse = { items: AttentionItemDto[]; truncated: boolean; provisioningFreeze: ProvisioningFreezeDto | null };
