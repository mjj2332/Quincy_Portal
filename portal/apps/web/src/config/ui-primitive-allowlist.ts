/**
 * #262: the hand-built UI primitive ratchet's allowlist, read by `ui-primitive-ratchet.guard.test.ts`.
 *
 * One entry per file OUTSIDE `components/reui/` and `components/quincy/` that renders a raw
 * interactive primitive (`<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>`) or declares a
 * widget role (`dialog`, `menu`, `menuitem`, `listbox`, `option`, `tab`, `tablist`, `combobox`).
 * `count` is the exact number of those signatures in the file, comments excluded.
 *
 * This list may only shrink. A new file, or a higher count, fails the guard: reach for an installed
 * ReUI or Quincy component first (AGENTS.md, "Reuse ReUI before building UI"). A deliberate
 * exception is added here in the same PR, with its reuse-ledger line as `ledger`. A LOWER count also
 * fails until this list is lowered to match, so a removal is locked in and cannot quietly return.
 *
 * `ledger: "baseline (#262)"` marks the entries that already existed when the guard landed.
 */
export type UiPrimitiveAllowance = { count: number; ledger: string };

export const UI_PRIMITIVE_ALLOWLIST: Record<string, UiPrimitiveAllowance> = {
  "components/CollectionPanel.tsx": { count: 16, ledger: "baseline (#262)" },
  "components/ConfirmDialog.tsx": { count: 2, ledger: "baseline (#262)" },
  "components/ExternalEditedUpload.tsx": { count: 2, ledger: "baseline (#262)" },
  "components/ImpersonationBanner.tsx": { count: 1, ledger: "baseline (#262)" },
  "components/Lightbox.tsx": { count: 28, ledger: "baseline (#262)" },
  "components/MentionAutocomplete.tsx": { count: 3, ledger: "baseline (#262)" },
  "components/Modal.tsx": { count: 1, ledger: "baseline (#262)" },
  "components/NoticeBoard.tsx": { count: 5, ledger: "baseline (#262)" },
  "components/PhotoGrid.tsx": { count: 18, ledger: "baseline (#262)" },
  "components/ProductionCalendarScheduleEditorFields.tsx": { count: 1, ledger: "baseline (#262)" },
  "components/ProductionEventCalendarDialogs.tsx": { count: 2, ledger: "baseline (#262)" },
  "components/ProductionEventCalendarRail.tsx": { count: 1, ledger: "baseline (#262)" },
  "components/ProductionGantt.tsx": { count: 4, ledger: "baseline (#262)" },
  "components/ProjectActivityView.tsx": { count: 3, ledger: "baseline (#262)" },
  "components/ProjectCollaborationPanel.tsx": { count: 5, ledger: "baseline (#262)" },
  "components/ProjectDeadlineControl.tsx": { count: 13, ledger: "baseline (#262)" },
  "components/ProjectDiscussionThread.tsx": { count: 6, ledger: "baseline (#262)" },
  "components/ProjectFields.tsx": { count: 5, ledger: "baseline (#262)" },
  "components/ProjectHeaderDropbox.tsx": { count: 1, ledger: "baseline (#262)" },
  "components/ProjectTeamCombobox.tsx": { count: 2, ledger: "baseline (#262)" },
  "components/RichTextEditor.tsx": { count: 3, ledger: "baseline (#262)" },
  "components/SubtaskChecklist.tsx": { count: 16, ledger: "baseline (#262)" },
  "components/UploadDropzone.tsx": { count: 2, ledger: "baseline (#262)" },
  "components/kanban2/board.tsx": { count: 2, ledger: "baseline (#262)" },
  "components/kanban2/card.tsx": { count: 2, ledger: "baseline (#262)" },
  "components/kanban2/move-to-control.tsx": { count: 9, ledger: "baseline (#262)" },
  "screens/Admin.tsx": { count: 3, ledger: "baseline (#262)" },
  "screens/Dashboard.tsx": { count: 7, ledger: "baseline (#262)" },
  "screens/ProjectWorkspace.tsx": { count: 4, ledger: "baseline (#262)" },
};
