import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { roleHasCapability, VIDEO_NOTE_PASTE_MAX, type VideoDto } from "@quincy/shared";
import { VideoNotePasteDialog } from "./VideoNotePasteDialog";
import type { VideoNotesSession } from "./use-video-notes";

/** What a notes ⋯ (the desktop panel's menu, the phone header's action sheet) offers for copy and paste, and the paste dialog it opens. */
export type NotesClipboard = {
  /** The person may write notes here (annotateVideo, not archived): only then do Copy and Paste exist. */
  canCopy: boolean;
  /** Nothing is listed under the filters, so there is nothing to copy. */
  copyDisabled: boolean;
  copyShown: () => void;
  /** "Paste N notes from vX…" while the Video's clipboard holds notes from another of its Versions; null otherwise. */
  pasteLabel: string | null;
  openPaste: () => void;
  /** The last copy's or paste's words, for a few seconds, on the Version they were said on. */
  status: string | null;
  /** The paste dialog, rendered by whoever calls the hook, above the panel and the action sheet so neither one's lifetime ends it. */
  dialog: ReactNode;
};

const STATUS_MS = 6000;

/**
 * Copy and paste notes between Versions (#741 5c-ui), lifted out of the panel (#879 PR 3b) so the desktop notes ⋯ and the phone header's ⋯ sheet drive one controller. The clipboard is
 * the form store's, per Video, so it outlives a Version switch; the paste dialog's offset and ticks live there too. Copy takes `session.shown`: the roots the filters show, never a
 * thread pinned only because a form is open on it. `phone` picks where focus returns when the dialog closes: the header ⋯ on a phone, the notes ⋯ on a desktop.
 */
export function useNotesClipboard({ session, video, phone }: { session: VideoNotesSession; video: VideoDto; phone: boolean }): NotesClipboard {
  const { forms, assetId, version, shown } = session;
  const canCopy = !session.readOnly && roleHasCapability(session.role, "annotateVideo");
  const clipboard = useSyncExternalStore(forms.subscribe, () => forms.clipboard(video.id));
  const pasteFrom = clipboard && clipboard.sourceAssetId !== assetId ? clipboard : null;
  const pasteOpen = useSyncExternalStore(forms.subscribe, () => forms.pasteOpen(assetId));
  const pasteResult = useSyncExternalStore(forms.subscribe, () => forms.pasteResult(assetId));
  const setPasteOpen = (next: boolean) => { forms.setPasteOpen(assetId, next); };
  // A copy's words belong to the Version they were said on: switching Version does not carry them along.
  const [copied, setCopied] = useState<{ assetId: string; text: string } | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const timer = setTimeout(() => { setCopied(null); }, STATUS_MS);
    return () => { clearTimeout(timer); };
  }, [copied]);
  useEffect(() => {
    if (pasteResult === null) return;
    const timer = setTimeout(() => { forms.clearPasteResult(assetId); }, STATUS_MS);
    return () => { clearTimeout(timer); };
  }, [pasteResult, forms, assetId]);
  const copyShown = () => {
    const ids = shown.map((thread) => thread.id);
    if (ids.length === 0) { setCopied({ assetId, text: "No notes to copy" }); return; }
    forms.copyNotes(video.id, { sourceAssetId: assetId, sourceVersion: version.version, noteIds: ids });
    setCopied({ assetId, text: ids.length > VIDEO_NOTE_PASTE_MAX ? `Copied the first ${VIDEO_NOTE_PASTE_MAX} of ${ids.length} notes` : `Copied ${ids.length} ${ids.length === 1 ? "note" : "notes"}` });
  };
  const returnTo = phone ? '[data-testid="video-header-menu"]' : '[data-testid="video-notes-menu"]';
  return {
    canCopy,
    copyDisabled: shown.length === 0,
    copyShown,
    pasteLabel: canCopy && pasteFrom ? `Paste ${pasteFrom.noteIds.length} ${pasteFrom.noteIds.length === 1 ? "note" : "notes"} from v${pasteFrom.sourceVersion}…` : null,
    openPaste: () => { setPasteOpen(true); },
    status: pasteResult ?? (copied && copied.assetId === assetId ? copied.text : null),
    dialog: canCopy && pasteFrom ? <VideoNotePasteDialog
      key={assetId}
      open={pasteOpen}
      onOpenChange={setPasteOpen}
      finalFocus={() => document.querySelector<HTMLElement>(returnTo)}
      store={forms}
      assetId={assetId}
      target={version}
      source={video.versions.find((candidate) => candidate.assetId === pasteFrom.sourceAssetId)}
      clipboard={pasteFrom}
      previewPaste={session.previewPaste}
      commitPaste={session.commitPaste}
    /> : null,
  };
}
