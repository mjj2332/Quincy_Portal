# #221 Gantt writes — reuse ledger and known gaps

Per AGENTS.md "Reuse ledger": one line per UI element added or changed on `feat/221-gantt-writes`. Copy into the PR body.


| Element | Source | Notes |
|---|---|---|
| Drop-warning ghost state (`data-drop-warning`, caution border/wash) | `components/reui/gantt/gantt-view.tsx` — extends the vendored ghost's existing valid/invalid states | Vendor edit-log entry; ADR 0009 addendum. Tokens per `tokens/reui.css` (`text-warning`, `signal-caution` border/wash). |
| Drop-warning reason hint (move clone pill; resize-chip segment + caution dot) | `components/reui/gantt/gantt-dnd.tsx` — added to the vendor's own cursor-following move clone and resize chip | Hand-built inside the vendor overlays: the overlays are imperative DOM the vendor owns; ReUI `tooltip` is anchored to a trigger and can't follow the pointer mid-drag. |
| Drop-target row tint (`bg-signal-caution/7`) | `gantt-view.tsx` `dragTarget` — third state beside the vendor's valid/invalid | |
| Warning in announcements | `gantt-i18n.tsx` `dropWarningSuffix` + existing vendor announcer; controller "saved" announcement | |
| Caution toast tone (glyph `!`, `--signal-caution` at 4.20:1 on ink) | `components/quincy/ToastViewport.tsx` (existing Quincy toast) | Needs design-reviewer sign-off on the glyph colour. |
| Undo action, 10s TTL, pause on hover/focus, single activation | `components/quincy/ToastViewport.tsx` + `lib/toast-store.ts` | #215 forbids `sonner`. |
| Gantt live region | Same `sr-only` live-region pattern as `ProductionCalendar.tsx` | |
| Gantt settle-recovery notice + Refresh | Same notice + `buttonClasses("secondary")` pattern as `ProductionCalendar.tsx` | |
| Fold choice dialog (Sydney DST) | `components/ProductionCalendarFoldChoice.tsx`, reused unchanged | |
| Move dialog (Set/Fix deadline) | `components/ProductionCalendarMoveDialog.tsx`, reused unchanged | |
| Deadline confirmation shell | `components/reui/alert-dialog.tsx` (base-nova) — first production consumer | |
| From → to + reminder consequences | `components/ProductionCalendarMoveConfirmation.tsx`, reused unchanged | |
| Affected checklist items list | `components/reui/item.tsx` (`ItemGroup`/`Item outline xs`/`ItemContent`/`ItemActions`), composed as ReUI `c-item-5` (found via `mcp__ReUI__search`) | Status tag = Quincy `StatusPill` (matches the Portal's other status tags). |
| Clash warnings | `components/quincy/Notice.tsx` `tone="caution"` | |
| Truncated caveat | plain `p` on Quincy tokens | One line of text. |
| Set deadline / Fix deadline buttons | `components/reui/button.tsx` `size="sm" variant="ghost"` | |
| Harness "Warn instead of refuse" toggle | Same control as the existing `enforceCanDrop` toggle in `harness/reui-scheduling/GanttPreview.tsx` | Dev-only. |

## Known gaps (not fixed, by decision)
- Placing an unscheduled subtask shows its warning only in the saved toast/announcement, not while dragging: the vendor's select-slot path has no `dropWarning` hook.
- While the Deadline confirmation is open at coarse zoom, the bar shows the pointer's instant; the saved value keeps the Deadline's wall time. Cosmetic; the controller overlay replaces it on confirm.
- Undo on a continuation-page row is covered at controller level (`onUndone`), not by a Gantt DOM test.
- The ProductionCalendar sibling dialog-key collision (found here, fixed in the Gantt) is a separate task.
- Browser pass (Agy + design-reviewer) not yet run.
