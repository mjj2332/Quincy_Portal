# TB5C Slice 10 + 11 — real-browser & role-matrix acceptance evidence

Records the plan's Slice 10 acceptance ("real browser / hardware — not DOM emulation — proves the
FullCalendar interaction claims; the accessibility checklist is fully evidenced") and the Slice 11
"complete Agy functional matrix". Run **2026-08-31** against local dev
(`http://localhost:8787`, app Worker at branch `d81fc99` / dist built 06:25) in the
human-authenticated dedicated Chrome (CDP `:9333`, `mjj2332@gmail.com` Admin, `user_impersonation`
flag ON for the run).

## Method

- **Agy** (`gemini-3.7-flash-high`, `--effort high`, danger-mode PASSIVE) drove Chrome via
  `chrome-devtools-mcp` — 12-check acceptance matrix, every drag Escaped, every dialog Cancelled,
  **zero confirmed mutations** (verified: 0 `PATCH`/`PUT`/`POST` to `/api/projects/*` across the
  whole run; only `GET /api/production-calendar`).
- **Orchestrating session** independently re-verified checks 1, 3 (seam), 8, and the toolbar
  label over CDP.

Fixtures on `test1` (`0fd29236-…`), September 2026: Deadline 2026-09-03 14:00; "QA due-only
milestone" (Sep 5); "QA date range" (Sep 9–11); "QA unscheduled item"; "QA legacy-unresolved";
"QA invalid-storage"; **new** "QA overlap A" (Sep 10 10:00–12:00, assignee TB4E Ext QA) and
"QA overlap B" (Sep 10 11:00–13:00, same assignee) — the server marked `sameAssigneeOverlap: true`
on **both** (confirmed via CDP: `overlap: ["QA overlap A","QA overlap B"]`).

## Results — all 12 checks PASS

| # | Check | Result |
|---|---|---|
| 1 | **Overlap indicator** — text not colour | PASS. `<span class="qc-cal-pill qc-cal-pill--overlap">Overlaps another task</span>` on both overlapping cards (real text node, `--signal-caution` accent `rgb(154,106,31)`, `role`/`aria-live` null). Non-overlapping events + the Deadline: no pill. *Re-verified over CDP.* |
| 2 | **Overlap → announcement** | PASS. Reschedule on "QA overlap A" → polite region: `"Picked up the checklist schedule for test1. Current time: 2026-09-10 10:00. This item overlaps another task for the same assignee."` Cancel → 0 mutations. |
| 3 | **Drag mirror out of a11y tree** | PASS (seam + dom test). At rest exactly one `[data-focus-key="calendar-move:…"]` per event. `applyProductionCalendarEventMirrorA11y` (surface `eventDidMount`) sets `aria-hidden="true"` + `inert` + `tabIndex=-1` on the mirror and its inner controls; `ProductionCalendar.dom.test.tsx:52-65` covers it. **A live drag mirror could not be produced via synthetic pointer events (FC v7 pointer-drag needs real pointer capture); the real VoiceOver/NVDA pass is the final confirmation** — but see check 8: FC v7 emits no assertive announcement of its own, so a duplicated mirror node is the only residual risk and the card is `tabIndex=-1` regardless. |
| 4 | **`prefers-reduced-motion`** | PASS. CDP media emulation → `.qc-calendar-screen[data-reduced-motion="true"]`; `transitionDuration`/`animationDuration` → `0s` on `.qc-cal-event-card`, `.modal`, `.modal__body`. Schedule-editor state switch still adapts the form instantly (state feedback retained). |
| 5 | **Phone Week action-only + 24h scroll** | PASS. 390×844 + coarse: surface `editable`/`eventStartEditable`/`eventDurationEditable`/`droppable` all `false`; every card keeps its Move/Reschedule button; Unscheduled panel drops `data-event` but keeps enabled Schedule/Repair buttons; all 24 slots (12am–11pm) scroll into view. Month tap opens the selected-day disclosure; Agenda = actions only. Desktop 1440×900 fine-pointer restores drag. |
| 6 | **200% zoom reflow** | PASS. 720×450 CSS viewport: `bodyScrollWidth === bodyClientWidth`, no `<body>` horizontal scroll (no 2-D trap); toolbar / Filters / Unscheduled reflow without clipping; action buttons still clickable. Screenshot on file. |
| 7 | **44×44 touch targets + focus rings** | PASS. Coarse/narrow: `.qc-cal-event-card__move` 84.8×44.4, `.qc-calendar-unscheduled__action` 112.8×44.0, toolbar "Prev" 61.6×44.0, dialog Cancel 80.4×44.0 / Save 125.8×44.0 — all min-dimension ≥ 44px. `:focus-visible` → `outline: 2px solid var(--focus-ring,#2f3b4d)` + 2px offset, non-transparent against Warm Paper. |
| 8 | **Live-region setup** | PASS **+ material finding: FullCalendar v7 renders NO live region of its own** (`.fc-liveregion` absent; no `fc-*` class matching live/region/announce). *Re-verified over CDP.* Quincy's polite atomic region is the only announcer. The `.production-calendar` wrapper has `data-suppress-fullcalendar-drop-announcement` **absent** — the seam ships off and **there is nothing for it to suppress**. (Minor, pre-existing: two `.dashboard-live-region` elements exist — the Dashboard's general one and the Calendar's — both `polite`/`atomic`, different views; not a TB5C regression.) |
| 9 | **Matched evidence 1440/1024/390** | PASS. Screenshots at all three sizes. Apfel Grotezk UI + Athelas/Mazius display; Warm Paper `rgb(250,248,242)` / Ink / the four signals — not a stock FC blue or shadcn look. Toolbar: "September 2026", zone label **"Sydney time · AEST/AEDT"** (correct — the 6-week September grid crosses the Oct-4 DST boundary; *re-verified over CDP*). No clipped controls at any width. |
| 10 | **Refresh during a dialog** | PASS. Move/Reschedule dialog open with a drafted `15:45`; focus/blur/visibility refetch fired → dialog stayed open, values retained (exercises the `8cf2514` parent-rerender fix). Cancel → 0 mutations. |
| 11 | **Role matrix** | PASS. **Admin**: Deadline + checklist + Unscheduled all interactive. **TB4E Ed QA** (internal editor, no `test1` membership): Deadline read-only (`aria-readonly`, no button), checklist read-only (`can_collaborate=0`), legacy/invalid = copy only, no Admin nav. **TB4E Ext QA** (external_editor, `test1` member): Deadline read-only; checklist/ranges **mutable** (Reschedule on overlap A/B, date range, due-only); overlap pill still renders; "Repair schedule" on legacy; no Admin scope. Both impersonations exited clean (`impersonatedBy: null`). |
| 12 | **Console / network clean** | PASS. 0 errors/warnings re Calendar/FullCalendar/unscheduled/Draggable/Temporal/aria/React; 0 mutation requests; only `GET /api/production-calendar`. |

**Agy verdict: PASS — all 12, zero mutations, no anomalies.**

## Impact on `SUPPRESS_FULLCALENDAR_DROP_ANNOUNCEMENT`

The plan's a11y checklist line 972 anticipated a cadence fight — "FullCalendar's assertive output
[pre-empting] the polite settled/conflict result" — and shipped a suppression seam for it.
**Check 8 establishes there is no such assertive output in FullCalendar v7**: it renders no live
region. The seam stays at its shipped default (`false`); it exists as forward insurance if a
future FC version reintroduces one. The remaining real-VoiceOver/NVDA pass is therefore a
confirmation that Quincy's polite region reads cleanly on a keyboard Move/Reschedule — not a
cadence-conflict test.

## Real-hardware obligations — WAIVED by owner 2026-08-31

The plan's §Deployment precondition ("physical phone Week and real AT keyboard acceptance all
pass") was **waived by the owner (Terry) on 2026-08-31** — deploy proceeds on the strength of
the Agy matrix + the FullCalendar-v7-has-no-live-region finding (which removes the specific
cadence risk the AT check was for). Precedent: the TB4E production spot-check was similarly
waived. The two checks below remain available as a post-deploy confirmation if desired:

- **Physical phone** Week: events cannot be dragged, every event exposes Move/Reschedule,
  ordinary scrolling reaches all 24 hours.
- **Real VoiceOver or NVDA**: a keyboard Move/Reschedule on a Deadline and on a checklist range —
  focus containment/return, and the polite region's saving/saved/reverted/conflict/DST/access-loss
  copy announced in order with no drag-mirror duplication.

## Bundle / chunk evidence (final, supersedes the Slice-5 proof's 274 kB figure)

`npm run build -w @quincy/web` at `d81fc99`:

| Chunk | raw | gzip |
|---|---|---|
| `ProductionCalendar-*.js` (lazy route chunk) | 340.73 kB | 93.13 kB |
| `ProductionCalendar-*.css` | 31.62 kB | 6.48 kB |
| `index-*.js` (main) | 1,256.47 kB | 372.53 kB |
| `index-*.css` (main) | 127.71 kB | 22.11 kB |

FullCalendar and `temporal-polyfill` appear **only** in the lazy `ProductionCalendar-*.js` chunk
— `grep` for `@fullcalendar` / `Temporal` in `index-*.js` returns nothing (also verified by Opus).
The growth from the Slice-5 figure (274 kB / 22 kB) is Slices 6–11 and is correctly isolated
behind `React.lazy` + `Suspense` in `Dashboard.tsx`; a principal without `viewProductionCalendar`
never downloads it.
