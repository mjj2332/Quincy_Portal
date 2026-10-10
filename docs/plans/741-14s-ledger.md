# #741 14-ui-staff reuse ledger (staff Decisions + Release + premium)

One line per UI element in `portal/apps/web/src/components/video/VideoDeliveryPanel.tsx`. Nothing new is installed, nothing is hand-built. Paths are under `portal/apps/web/src/`.
Placement (spec-silent): under the player in the viewer's left column, so the notes panel and the Version details column are untouched; not shown in Compare.

| Element | Where | Uses |
|---|---|---|
| Panel container, title, description | `VideoDeliveryPanel.tsx` | `components/reui/frame.tsx` (`Frame`, `FramePanel`, `FrameHeader`, `FrameTitle`, `FrameDescription`), the same composition as `VideoCard.tsx` |
| State chip (No client decision / Changes requested / Approved / Released) | `VideoDeliveryPanel.tsx` (`delivery-state`) | `components/reui/badge.tsx` |
| Decision rows (who, what, when, link or "Recorded by staff", note) | `VideoDeliveryPanel.tsx` (`delivery-decision`) | `components/reui/item.tsx` (`ItemGroup`, `Item size="xs"`, `ItemContent`, `ItemTitle`, `ItemDescription`) |
| Release, Withdraw, Record approval, Record changes requested, Retry, Unlock, Re-lock | `VideoDeliveryPanel.tsx` | `components/reui/button.tsx` |
| Release / Withdraw / Unlock / Re-lock / Record confirmations | `VideoDeliveryPanel.tsx` | `components/reui/alert-dialog.tsx`, the composition of `components/ConfirmDialog.tsx` |
| Record-decision note | `VideoDeliveryPanel.tsx` (`delivery-note`) | `components/reui/textarea.tsx` with `components/reui/label.tsx` (new line beyond the plan table: the table lists no textarea for 14-ui-staff, and 14b asks for an optional note) |
| Payment reference | `VideoDeliveryPanel.tsx` (`delivery-payment-ref`) | `components/reui/input.tsx` with `components/reui/label.tsx` |
| Premium switch | `VideoDeliveryPanel.tsx` (`delivery-premium-switch`) | `components/reui/switch.tsx` with `components/reui/label.tsx` |
| Locked / Unlocked chip | `VideoDeliveryPanel.tsx` (`delivery-lock-state`) | `components/reui/badge.tsx` |
| Refusal text, decisions load error | `VideoDeliveryPanel.tsx` (`delivery-version-problem` beside the decision and Release controls, `delivery-premium-problem` beside the premium controls) | `components/quincy/Notice.tsx`, as in `VideoCollectionPanel.tsx` |
| Reason lines (the empty-state `<p>` `delivery-empty`, why Release is off, read-only, why premium is off, and the premium explanation `<p>`) | `VideoDeliveryPanel.tsx` | Plain `<p>` in the existing `[font:var(--type-label)]` role. No widget. |
