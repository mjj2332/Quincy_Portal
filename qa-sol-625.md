1. **minor — `portal/apps/web/src/components/AnchoredPopover.tsx:119`**: The dismissal exemption misses AlertDialog’s sibling `data-base-ui-focus-guard` elements. Open Subtask Actions → Delete, then Shift+Tab from Cancel or Tab past Confirm: wrapping focus closes the underlying actions popover while the confirm remains pending. Reproduced in memory. Exempt the alert dialog’s focus guards and add focus-wrap coverage.

2. **minor — `portal/apps/web/src/components/ConfirmDialog.dom.test.tsx:63`**: Removing both styling assertions leaves the `danger` mapping untested. Dropping or reversing that mapping would make destructive confirmations look ordinary while tests pass; Button tests do not cover this renderer. Restore a contract test for destructive and default variants. The test-seam guard explicitly permits assertions on Tailwind utilities encoding design contracts; correct the misleading comment and lesson.

Reuse ledger: missing for ConfirmDialog’s shell, title, message, and actions in the supplied review material.

FIX FIRST