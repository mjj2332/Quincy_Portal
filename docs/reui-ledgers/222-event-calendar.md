# #222 Production Calendar on the ReUI event calendar — reuse ledger

Per AGENTS.md "Reuse ledger": one line per UI element added or changed on `feat/222-new-calendar`. Copy into the PR body.

**Search evidence.** The ReUI MCP (`mcp__ReUI__search`) was unavailable for this build; every line below was
checked against the local block and registry source in `tmp/ReUI_Full_Source_Code/` (can be out of date), and
each needs its `mcp__ReUI__search` confirmation before the PR merges.

| Element | Source | Notes |
|---|---|---|
| Calendar shell (rail beside grid) | ReUI block `event-calendar-2` layout (plain grid; no `reui/card` wrapper — the Dashboard panel is already the surface) | Block's `sonner`, `@/components/ui/*` and `Intl` time-zone code stripped. Check against ADR 0002 in review. |
| Grid, views, nav + view switcher | Vendored `components/reui/event-calendar/` — `EventCalendar`, `EventCalendarNav showViewSwitcher`, `EventCalendarContent` | Only consumer: `ProductionEventCalendar.tsx` (exact-file guard entry). Two additive vendor edits (dated edit-log): `"deferred"` update result, `granularity` on proposals. |
| Mini month | `components/reui/calendar` (`CalendarDayButton`) + block calendar-rail | Busy-day dot from the range's events. |
| Up next list | Block rail list + `components/reui/item`, `components/reui/scroll-area`, `quincy/Eyebrow` | Second read-only agenda query from today (Sydney), outside the accept gate. |
| Layers filter | `components/reui/combobox` (chips) | ≥1 layer selected. |
| People filter | `components/reui/combobox` (chips) + `components/reui/avatar` | Chip classes reused from `ProjectTeamCombobox` (`TEAM_CHIP`); options from `filterFacets.people` only. |
| "N filters active · Clear" | `components/reui/button` `variant="link"` | Hidden URL filters; full chip row is a follow-up issue. |
| Unscheduled list | `components/reui/item`, `components/reui/scroll-area`, `components/reui/button` | Rows are external drag sources via the vendored `useEventCalendarExternalDrop` (`data-drag-source`); Schedule / Repair schedule actions otherwise. |
| Narrow rail | `components/reui/sheet` (JS media query, no `lg:`) | Rail renders inside `<EventCalendar>` in both places so the drop hook has its provider. |
| Event chips | Vendor `renderEvent` / `eventClassName` + `components/quincy/InitialsAvatar` | Deadline solid ink, checklist paper, done dimmed. Overlap and needs-attention copy are `sr-only` in the chip (the chip is a small vendor `<button>`). |
| Selection strip (chip click) | `components/reui/button` (`outline` / `ghost`, `sm`) + `ProjectCalendarAnchor` (`components/ProductionCalendarEvent.tsx`) | Hand-composed row: the vendor chip is itself a `<button>`, so "Reschedule…" (`data-focus-key="calendar-move:<id>"`) cannot live inside it; the block's own pattern is `onEventClick` → a consumer-owned surface. Visible overlap / needs-attention copy lives here. Block pattern confirmed in `tmp/ReUI_Full_Source_Code/reui-blocks-main/components/event-calendar-event.tsx:496-499` (chip click calls `settings.onEventClick`, then selects the event; nothing rendered inside the chip). Candidates `reui/popover` and `reui/item` rejected by inspection of the installed components (popover would anchor to a vendor chip that re-renders on every range change; item is used plainly as the row) — no registry search run this round (MCP unavailable). |
| Deadline confirmation | `components/ProductionGanttDeadlineDialog.tsx` on `components/reui/alert-dialog` | Reused with `preview` optional (`null` here). |
| Move dialog + fold choice | `components/reui/alert-dialog`, `components/reui/input`, `components/reui/button` | `ProductionCalendarMoveConfirmation` reused as content; open-token keys namespaced (lesson 3915). |
| Schedule editor | `components/reui/sheet` + `components/reui/field` | Field body extracted to `ProductionCalendarScheduleEditorFields`; the old Modal wrapper reuses it. |
| Settle-recovery notice + Refresh | `components/quincy/Notice` `tone="caution"` + `components/reui/button` | Same contract as `ProductionCalendar.tsx` (`data-focus-key="calendar-recovery"`). |
| Empty / error / loading | `components/quincy/EmptyState`, `components/reui/skeleton` | Skeleton first-load only. |
| Live region | `sr-only` `aria-live` bound to the controller's `announcement` (`data-testid="dashboard-live-region"`) | Same pattern as the FullCalendar renderer. |
| Toasts | `lib/toast-store` | Undo toast is a follow-up issue. |
