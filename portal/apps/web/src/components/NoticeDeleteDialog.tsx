import { useRef, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/reui/alert-dialog";
import { Notice } from "./quincy/Notice";

// Reuse ledger (#523):
// - Shell, header, title, description, footer, Cancel, action: `components/reui/alert-dialog.tsx`
//   (base-nova `alert-dialog`), composed like `reui/rich-text-editor/delete-table-dialog.tsx`
//   (`size="sm"`, names the target) and `WhiteboardHistoryPanel.tsx` (pending state, Cancel focused first).
// - Destructive action: `AlertDialogAction variant="destructive"` (`reui/button`).
// - Error in the dialog: `components/quincy/Notice.tsx` `tone="critical" role="alert"`.
// No raw primitives here, so no ui-primitive-allowlist entry.

type NoticeDeleteDialogProps = {
  open: boolean;
  /** Plain-text excerpt of the notice, or "" when it has no text (images only). */
  excerpt: string;
  deleting: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  finalFocus: () => HTMLElement | true;
};

/** Confirms before a Notice board post is deleted for everyone. The dialog stays open on failure. */
export function NoticeDeleteDialog({ open, excerpt, deleting, error, onConfirm, onCancel, finalFocus }: NoticeDeleteDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const subject: ReactNode = excerpt
    ? <span className="text-foreground font-medium">“{excerpt}”</span>
    : "This notice";
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !deleting) onCancel(); }}>
      <AlertDialogContent size="sm" data-testid="notice-delete-confirm" initialFocus={cancelRef} finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete notice?</AlertDialogTitle>
          <AlertDialogDescription className="text-foreground-secondary">
            {subject} will be removed from the Notice board for everyone, with any images in it. This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <Notice tone="critical" role="alert" data-testid="notice-delete-error">{error}</Notice>}
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} disabled={deleting} data-testid="notice-delete-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={deleting} onClick={onConfirm} data-testid="notice-delete-confirm-action">
            {deleting ? "Deleting…" : "Delete notice"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
