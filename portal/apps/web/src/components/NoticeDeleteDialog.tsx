import { useEffect, useRef, type ReactNode } from "react";
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
// Also the Project discussion's comment Delete (#568): the copy and test-id prefix are props, so there is one confirmation, not a fork.

type NoticeDeleteDialogProps = {
  open: boolean;
  /** Plain-text excerpt of the notice, or "" when it has no text (images only). */
  excerpt: string;
  deleting: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  finalFocus: () => HTMLElement | true;
  /** Copy and test ids; the defaults are the Notice board's (#523). */
  copy?: { title: string; action: string; pending: string; description: (subject: ReactNode) => ReactNode; fallbackSubject: string };
  testIdPrefix?: string;
};

const NOTICE_COPY: NonNullable<NoticeDeleteDialogProps["copy"]> = {
  title: "Delete notice?", action: "Delete", pending: "Deleting…", fallbackSubject: "This notice",
  description: (subject) => <>{subject} will be removed from the Notice board for everyone, with any images in it. This can't be undone.</>,
};

/** Confirms before a Notice board post is deleted for everyone. The dialog stays open on failure. */
export function NoticeDeleteDialog({ open, excerpt, deleting, error, onConfirm, onCancel, finalFocus, copy = NOTICE_COPY, testIdPrefix = "notice-delete" }: NoticeDeleteDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  // Both buttons are disabled while deleting, so focus drops to <body>. On a failure the dialog stays open:
  // move focus to the error so it is announced and focus is back inside the dialog (#568 review).
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const subject: ReactNode = excerpt
    ? <span className="text-foreground font-medium">“{excerpt}”</span>
    : copy.fallbackSubject;
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next && !deleting) onCancel(); }}>
      <AlertDialogContent size="sm" data-testid={`${testIdPrefix}-confirm`} initialFocus={cancelRef} finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription className="text-foreground-secondary">
            {copy.description(subject)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && <Notice ref={errorRef} tabIndex={-1} tone="critical" role="alert" data-testid={`${testIdPrefix}-error`}>{error}</Notice>}
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} disabled={deleting} data-testid={`${testIdPrefix}-cancel`}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={deleting} onClick={onConfirm} data-testid={`${testIdPrefix}-confirm-action`}>
            {deleting ? copy.pending : copy.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
