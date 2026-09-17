import type { EditorFolderAttentionDto } from "@quincy/shared";
import { Notice } from "@/components/quincy/Notice";

/** The per-project banner for a latched Editor folder mapping (#163). The server withholds
 * `detail` from viewers without `adminBackend`, so this renders whatever it is given. */
export function EditorFolderAttentionNotice({ attention }: { attention: EditorFolderAttentionDto }) {
  const paused = attention.kind === "editor_folder_move_stuck" || attention.kind === "editor_folder_move_overdue";
  return <Notice tone={paused ? "critical" : "caution"} role={paused ? "alert" : "status"} className="m-[var(--space-4)]" data-testid="editor-folder-attention">
    <strong>{attention.headline}</strong>
    {attention.detail
      ? <><br /><code>{attention.code}</code> {attention.detail}</>
      : <> An admin can see the details under Admin → Pipeline.</>}
  </Notice>;
}
