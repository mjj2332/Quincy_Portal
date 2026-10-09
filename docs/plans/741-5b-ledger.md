# #741 PR 5b reuse ledger

One line per new UI element. Searches: installed `components/reui/` and `components/quincy/` first; ReUI MCP `search` run 2026-10-09 for "comment thread panel with replies, resolve, filter tabs open resolved" (best: premium block `sheet-5`, a right Sheet, with emoji reactions and premium adoption cost: its composition is adopted with installed items, the block is not), "segmented control radio two options visibility switch" (`c-toggle-group-5`, `c-tabs-9`) and "timeline markers range overlay on slider track" (only vertical event timelines). The local `tmp/ReUI_Full_Source_Code` copy was read for sheet-5's import list only.

| Element | Item used | Notes |
|---|---|---|
| Notes aside surface | `data-surface="default"` panel inside the inverse dialog | precedent: the paper `Notice` in `VideoPlayer`; on the inverse surface `StatusPill`'s signal tones are not declared |
| Panel heading "Notes on v3" and totals | heading with the display-font tokens, as the 4d-ii "Version n" heading | text |
| Version details button and popover | `reui/popover` (`Popover`, `PopoverTrigger render=`, `PopoverContent`) + `reui/item` rows | installed; same rows and test ids as the 4d-ii column |
| Status filter Open / Resolved / All | `reui/toggle-group` (single value, `variant="outline"`) | installed; `c-toggle-group-5` composition; an empty value is refused |
| Visibility filter All / Client-visible / Internal | `reui/toggle-group` | as above; both filter rows are hidden while the version has no notes. Selected state is the toggle-group's own `aria-pressed:bg-muted` token (no stronger variant is installed), left as is (design r3 item 8) |
| Note list scroller | `reui/scroll-area` | installed; the only inner scroller, desktop only (on a phone the root has no height cap); `min-h-32`, the panel is `overflow-clip` so focus cannot scroll it; an opening edit form is `scrollIntoView({ block: "nearest" })` |
| Thread container | `reui/item` (`Item variant="outline"`) | sheet-5 composition; selected = `data-selected` border token |
| Author avatar | `quincy/InitialsAvatar` | installed; Discussion precedent |
| Timestamp | `quincy/CollaborationTimestamp` | installed |
| Internal badge | `quincy/StatusPill tone="caution"` + lucide `Lock` | on paper; root only, first item of the badge, timecode and "⋯" row (menu pushed right); replies inherit it and show none |
| Client-visible badge | `quincy/StatusPill tone="info"` | design-reviewer may prefer `neutral` |
| Timecode (anchor) button | `reui/button` `variant="secondary"` `size="sm"` + mono token, `pointer-coarse:min-h-11` | installed |
| Reply / Resolve / Reopen / Retry / Refresh notes / Clear marks / Make point | `quincy/Button variant="text"` | Discussion precedent; always visible (no hover reveal) |
| Own-note "⋯" (Edit, Delete); on a root it ends the badge and timecode row, on a reply the author row | `quincy/menu` (`Menu`, `MENU_ITEM`) + `quincy/icon-button` `ICON_BUTTON` | Discussion precedent (#376) |
| Delete confirm | `components/ConfirmDeleteDialog` with note copy (tombstone wording when others replied) | installed |
| Composer, reply and edit text areas | `reui/textarea` with an `sr-only` label | installed |
| Composer visibility switch | `reui/toggle-group` (two items, Internal pressed by default) | over `reui/switch` because both options stay labelled; over `c-tabs-9` because tabs mean panels |
| Set in / Set out | `quincy/Button variant="secondary"` + `reui/kbd` hint, `aria-keyshortcuts`; the composer is an `@container` and the Kbd goes `@max-[280px]:sr-only` (still read by assistive tech) | installed |
| Post / Save / Cancel | `quincy/Button` primary / secondary; Post stays left-aligned, the lock hint follows it | installed |
| Anchor text in composer and edit form | mono text span as a `bg-muted` chip (as the 4d-ii timecode chip); composer shows only the timecode (or In / Out), Set in / Set out share its row; one `ANCHOR_CHIP` class set shared with the edit form | text |
| Archived notice | `ARCHIVED_NOTICE_CLASS` paragraph (`components/archived-notice`) | #527 precedent |
| Load, write and conflict errors | `quincy/Notice` (`critical`, `caution`) | installed |
| Empty states | `quincy/EmptyState size="compact"` | installed |
| **Marker lane, range bars, pending band** | **hand-built** `div` / `span` in `quincy/VideoTimelineMarkers.tsx` | searches above plus installed `reui/slider` (single or multi thumb, no marks API), `reui/progress`, `reui/gantt` (wrong scale and contract). None draws frame-positioned, non-thumb marks aligned to an edge-aligned slider thumb. A `div` with a pointer handler, not buttons (the lane is `aria-hidden` and inert on touch), so no ratchet signature |

No allowlist entry was added: every button, input, textarea and dialog is a `reui/` or `quincy/` primitive. `ui-primitive-ratchet.guard.test.ts`, `reui-skin.guard.test.ts` and `design-system-guards.test.ts` pass unchanged.
Not in 5b: the copy / paste menu (5c), markup (6b), Compare (7), export markers (8/9), sharing (11b), card note counts (5b-counts), notifications (15a).

| "Outside current filters" label on a pinned thread (#741 5b forms) | `quincy/Notice` (tone caution) | installed |
| Cluster pill on the marker lane (design r3 item 6) | part of the hand-built lane in `quincy/VideoTimelineMarkers.tsx` (`h-4`, amber edge and a diamond glyph when it holds an internal note) | same searches and reasons as the lane row; shape (diamond) plus colour, never colour alone |
| Composer lock hint (design r3 item 7) | text span beside Post, whole composer `opacity-60` while another form is open | text |
| Orphan notice above the list (Sol r6) | `quincy/Notice` (critical) + `quincy/Button variant="text"` Dismiss | installed; shows a closed form's notice when its root thread is no longer listed |
