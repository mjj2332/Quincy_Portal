/** Latches a human has to clear (#163), as the app serves them. Most severe kind first. */
export const EDITOR_FOLDER_ATTENTION_KINDS = [
  "editor_folder_move_stuck",
  "editor_folder_move_overdue",
  "editor_folder_needs_review",
  "editor_folder_move_blocked",
] as const;
export type EditorFolderAttentionKind = (typeof EDITOR_FOLDER_ATTENTION_KINDS)[number];

/** Whether the Editor pipeline (Output sync, manual publishing, RAW reconciliation) is fenced off.
 * Only a `moving` mapping is; a blocked move and a review leave sync running. */
export function editorFolderAttentionPausesPipeline(kind: EditorFolderAttentionKind): boolean {
  return kind === "editor_folder_move_stuck" || kind === "editor_folder_move_overdue";
}

export type EditorFolderAttentionDto = {
  kind: EditorFolderAttentionKind;
  /** Says what is affected, never why. Sent to every role that sees the project except a
   * photographer — External Editors included, by the owner's decision on #163. */
  headline: string;
  /** The precise reason within `kind`: the `move_note` code (e.g. `editor_folder_move_conflict` for
   * a blocked move), `needs_review`, or the kind itself when nothing more specific is recorded. */
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
