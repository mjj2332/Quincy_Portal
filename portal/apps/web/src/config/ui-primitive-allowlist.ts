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
  "components/ProductionEventCalendarDialogs.tsx": { count: 1, ledger: "baseline (#262)" },
  "components/ProductionEventCalendarRail.tsx": { count: 1, ledger: "baseline (#262)" },
  "components/ProductionGantt.tsx": { count: 4, ledger: "baseline (#262)" },
  "components/ProjectActivityView.tsx": { count: 2, ledger: "#378: the Project | System segment — quincy/segment SEGMENT_GROUP + SEGMENT_BUTTON on two raw <button>, the Dashboard Active/Archived scope switcher was the precedent until #428 retired it (Archived is now a field of the shared Filter). base-nova toggle-group is not installed and would add a second segment style; quincy/TabStrip is rejected (a tablist nested in the Discussion/Activity tablist); quincy/Checkbox reads as a setting, not a view." },
  "components/ProjectCollaborationPanel.tsx": { count: 5, ledger: "baseline (#262)" },
  "components/ProjectFields.tsx": { count: 5, ledger: "baseline (#262)" },
  "components/ProjectHeaderDropbox.tsx": { count: 1, ledger: "baseline (#262)" },
  "components/ProjectTeamCombobox.tsx": { count: 2, ledger: "baseline (#262)" },
  "components/SubtaskChecklist.tsx": { count: 5, ledger: "baseline (#262); the schedule picker (6 raw controls) moved to quincy/SubtaskScheduleControl.tsx (#372)" },
  "components/UploadDropzone.tsx": { count: 2, ledger: "baseline (#262)" },
  "screens/Admin.tsx": { count: 3, ledger: "baseline (#262)" },
  "screens/ProjectWorkspace.tsx": { count: 3, ledger: "baseline (#262)" },
};
