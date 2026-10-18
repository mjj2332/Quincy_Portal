# #916 Dashboard views revamp — settled plan

Spec: #916. Tickets: #918 foundations → (#919 Timeline 3a ∥ #922 Calendar 3d) → #920 Colour by People 3b → #921 phone 3c. #923 (Table/Board) waits on round 4 frames.
Integration branch: `feat/916-dashboard-views`. Synthesised from blind Opus and Codex plans (2026-10-18); owner decisions below.

## Owner decisions (2026-10-18)

- **D-phone-cal (2026-10-18, owner):** on phone widths the Calendar Stage key moves into the same Key drawer as the phone Timeline (no Colour by there). The Calendar week all-day lane is left uncapped.
- **Done Subtask:** paper-100 fill, solid `--text-muted` edge, tick. Amend the #247 "done bar rests as an outline" guard to the new look (scoped to the Dashboard variant).
- **Key chip vs complex Filter:** root AND with at most one plain Stage leaf → toggle it. OR root, negated, nested or repeated Stage rule → chip disabled, titled "Edit Stage in Filter". Never rewrite a complex tree.
- **People-mode key row:** person chips ("N open") + Unassigned, display-only; no People filter write.
- **Phone Colour by:** inside the phone Key drawer (44px "Key" button → ReUI Drawer with StageKeyRow + Colour by). Not in Display.
- **Dark pair** = an `-on-inverse` twin per new token + guard. No dark theme (guards ban `dark:`).
- Deadline passed earlier today → "Late today". Key chips show no counts.
- Diamond: drag kept, resize grips hidden; Day zoom draws a bar.
- Phone: 28px bars, Week fits 7 days to the track width, Dashboard tabs stay (no view dropdown).
- Calendar keeps its shipped views; no shoot events, "Not scheduled", Calendar Colour by, or hour-height change.
- Hidden External assignee → "shared" neutral tone; never infer hidden ids.
- Table/Board keep `STAGE_HATCH_CLASS`/`stage-colors.ts` until #923.

## Opus plan (base of the settled plan; where the Codex notes below add detail, follow them too)

Order: #918 → (#919 ∥ #922) → (#920 ∥ #921). #920/#921 branch from #919 merged into feat/916-dashboard-views, not from #918.

## #918 Foundations: appearance module, tokens, glossary, key-row parts (no view changes)
1. **`W/lib/dashboard-appearance.ts`** (new, pure). Imports: `import type` stage keys from `./stages` (the stage-colors.ts rule), `sydneyDayKey` from `./date-format`. No React, no vendored imports (harness-reachability guard).
   - `type StageTone = { stage: StagePresentationKey; color: string /* "var(--stage-…)" */; treatment: "hollow-dashed" | "solid" | "wash" }`; `stageTone(key: StageTransportKey | null | undefined): StageTone`. editing_autohdr maps to editing; null/unknown falls back to Awaiting RAW (as `stageColorFor`). Awaiting RAW is hollow-dashed, Delivered is wash, the rest solid.
   - `type Lateness = { late: false } | { late: true; daysLate: number }`. `projectLateness({ stageKey, deadlineAt: string | number | null, archived }, now: Date)`: late when deadline < now, not delivered, not archived. `subtaskLateness({ dueAt /* range end */, complete }, now)`. `civilDaysBetween(a, b)` diffs two `sydneyDayKey`s parsed as UTC dates, so DST cannot shift the count. `lateLabel(l)` returns "Late today", "1 day late" or "N days late".
   - `subtaskShape({ start, end }): "bar" | "diamond"`: diamond when both fall on the same Sydney day key. An end at 00:00 is the next day, so it draws a bar.
   - `type PeopleTone = { kind: "person"; personId; color; initials } | { kind: "shared"; people: { initials; color }[]; hiddenCount } | { kind: "unassigned" }`. `subtaskPeopleTone({ assignees, otherAssigneeCount })`: one named assignee AND hiddenCount 0 gives person. Any hidden External assignee gives shared, so work is never credited to one person.
   - `PEOPLE_TONE_COUNT = 8`; `personColorIndex(userId)` is FNV-1a 32-bit mod 8; `personColor(id) = "var(--people-N)"`. `personInitials(name)` moves here; `assigneeInitials` in production-event-calendar-adapter re-exports it.
   - `doneCount({ completed, total }) => { done, total, label: "3 of 5 done" } | null`, null when total = 0.
   - `W/lib/dashboard-summary.ts` `isOverdueProject` delegates to `projectLateness(...).late`: one rule ("Overdue means isOverdueProject, everywhere").
2. **Tokens, `W/styles/tokens/colors.css`**. Role tokens over existing steps: `--stage-awaiting-raw: var(--greige-500)`, `--stage-raw-review: var(--signal-caution)`, `--stage-editing: var(--signal-info)`, `--stage-delivered: var(--signal-positive)`, `--late: var(--signal-critical)`. New hexes: `--stage-edited-review: #2f6b66` (5.79:1 on paper-050); `--people-1..8`: `#3d5a80 #6b4a6e #8a4b2a #5b6a2e #2a5f74 #7a3e5c #6e5136 #4a4f8a`. Each is ≥5.9:1 under white initials, ≥5.5:1 on paper-050, and distinct from every stage tone and `--late`. The prototype's pp-jm/pp-rk reused teal and ochre.
   Each new hex gets an `-on-inverse` twin (e.g. `#8fc7c0`, 10.46:1 on ink-900); see D1. `lib/stage-colors.ts` and `STAGE_HATCH_CLASS` stay: Board, Table, card-menu and the Filter still draw the hatch.
3. **Shared key-row parts**, so #919 and #922 do not overlap: `W/components/quincy/StageKeyRow.tsx`: props `entries: { key, label, tone, pressed, disabled }[]`, `onToggle(key)`, `trailing?`. ReUI `Toggle` chips, `text-sm`, swatch from tone; `toggleStageInDashboardFilter(filter, key): DashboardFilter | null` in `W/lib/dashboard-filter-query.ts` (shape below).
4. **Glossary, `portal/packages/shared/GLOSSARY.md`**: **Late** (both rules, plus "same rule as the Filter's 'is overdue' and the server's project-deadline.ts"); **Colour by** (per-browser viewer preference, Timeline only); under **Subtask range**: "drawn as a diamond when start and end share a civil day; a display rule, not a kind". due-only and milestone stay in _Avoid_.
**Tests.** `dashboard-appearance.test.ts` (node, fixed `now`) covers: every tone, plus autohdr and the fallback; Edited review past Deadline is late; Delivered past, archived and null Deadline are not; deadline == now is not late; a completed Subtask past due is not late; civil days across 2026-10-04 (AEDT start) and 2026-04-05; "Late today"; diamond for 09–17 and 09–09:30; bar for 22:00–02:00 and for an end at 00:00; people for 0, 1, 1 + hidden and 3 assignees; a pinned id→index table, so colours stay stable; doneCount for 0/0, 3/5 and 5/5; `isOverdueProject` ≡ `projectLateness` on a fixture table.

Also: toggle cases in `dashboard-filter-query.test.ts`, and `StageKeyRow.dom.test.tsx`.

Guard: new describe "dashboard appearance tokens (#916)" in `styles/design-system-guards.test.ts`, reusing gantt-skin's `resolveToken`/`contrast`: every `--stage-*`/`--people-*` is declared and has an `-on-inverse` twin; ≥3:1 on `--bg-canvas`/`--bg-surface`; people ≥4.5:1 under paper-000 initials; twins ≥3:1 on ink-900/800; the 5 stage tones are pairwise distinct; planted self-test.

## #919 Timeline Stage mode, frame 3a
1. **`W/lib/production-gantt-adapter.ts`**: `ProductionGanttRowFacts` gains `appearance`. Project: `{ tone, lateness, done }`. Task: `{ tone (parent Project's), lateness, shape, people, complete }`.
   - Drop the `STAGE_HATCH_CLASS`/`stagePatternFor` use. `color = tone.color`, which drives `--gantt-event-color`.
   - `className` comes from new pure `W/lib/production-gantt-appearance-classes.ts`. Each class owns rest/`hover:`/`data-selected:`/`data-completed:`, per the lesson "A consumer `eventClassName` must override every state the vendor tints…".
   - Delivered Project: `resizable:false` (no Deadline grip). Resources get `minRowHeight`: Project 3rem, Subtask 2.5rem; the view raises coarse pointers to 2.75.
2. **Vendored gantt, scoped variants plus adaptation notes:**
   - (a) `gantt-view.tsx` ~l.1470 honours `GanttResource.minRowHeight` before `metrics.minRowHeight`;
   - (b) `renderEventTrailing?: (props) => ReactNode` is a sibling after the bar, for the late chip.
   Metrics from ProductionGantt: `laneHeight: 1.75` (28px) and `unitWidths: { week: 3.25 }` (52px days; the vendor week default is 10rem/day).
3. **`W/components/ProductionGanttBarContent.tsx`** (new): `renderGanttEventContent` moves here. It returns content for every bar: Project Stage label, Subtask title, tick, `gantt-same-day-marker` diamond, `gantt-late-chip`. Cite "A render-override prop gated on its own PRESENCE…".
4. **`W/components/ProductionGantt.tsx`**:
   - `useState<GanttScale>("week")` (was "month", ~l.1889);
   - the per-pointer metrics merge;
   - `GanttLegend` → `<StageKeyRow>` built from new `ganttKeyEntries` in production-gantt-filters.ts: every role-aware option (`productionStageFilterOptions`), `pressed` from `dashboardFilterStageScope`;
   - new prop `onFilterChange(next: DashboardFilter)`. Dashboard.tsx passes `writeFilter`, so `writeGanttFacet` → `ganttFacetForWrite` keeps the Delivered pairing and notice;
   - attention and child-retry labels: `text-[10px]` → `text-xs`;
   - "N of M done" in the `GanttResourceLabel` meta;
   - `stageOptionsWithColor` uses `stageTone`, so the Filter popover swatches match (D3).
**Filter-tree write** (`toggleStageInDashboardFilter`): take `tree = dashboardFilterTreeOf(normalizeDashboardFilter(f))`.
- If the root `op:"and"` has no non-negated root-level `stages` leaf, append `{ kind:"leaf", field:"stages", values:[key] }`.
- If it has exactly one, toggle `key` in its `values`; an empty leaf is removed.
- Otherwise (an OR root, a negated, nested or repeated Stage rule) return `null`. The chip is disabled, titled "Edit Stage in Filter".
- Return `normalizeDashboardFilter({ tree })`, flat `stageKeys` when representable. The Filter badge is `dashboardFilterAppliedCount`. Tree helpers only (`dashboard-filter-access.guard.test.ts`).
**Tests.**
- Adapter: each bar's `data.appearance` equals the module output; no Delivered grip; no hatch.
- `ProductionGantt-filters.dom`: chip → `onFilterChange` tree; Delivered chip → delivered shown plus notice; OR tree → disabled chip.
- `-zoom.dom`: Week default.
- `-completion.dom`: "3 of 5 done" and tick.
- New `ProductionGantt-appearance.dom`: diamond, late chip text, `data-treatment`.
- `-attention-badge`: `text-xs`.
- `.writes.dom` and `-create-draft`: green.
- Vendor `gantt-row-min-height.dom` (48/40/44).
- gantt-skin Detector 9 also iterates `stageTone`.
- New `W/components/timeline-type-floor.guard.test.ts`: no `text-[<12px]`, `text-2xs` or `text-[0.6875rem]` in ProductionGantt*.tsx, `reui/gantt/*.tsx`, StageKeyRow or the classes module; none imports `STAGE_HATCH_CLASS`/`stagePatternFor`; planted self-test.

## #920 Colour by People, frame 3b
- `W/lib/timeline-colour-by.ts`: `normalizeColourBy(raw) => "stage" | "people"`, key `uiPrefKey("dashboard:timeline:colour-by")`, read via `useUiPref`. It is per-browser and best-effort like `DASHBOARD_VIEW_KEY` (dashboard-helpers.ts), which is the real "last view" store; `dashboard-view-store` is in-memory only. `useUiPref` also syncs every reader in the tab.
- Adapter option `colourBy`: Project: neutral, paper-200 fill with a greige border; Task "person": a solid `personColor` fill with paper initials; "shared": neutral with an `AvatarStack` of every avatar; "unassigned": dashed `--stage-awaiting-raw`; BarContent people branch: initials are always printed (`gantt-bar-initials`); the Project label is "Mon 14 → Fri 18"; Switch: a ReUI `ToggleGroup` in `ProductionGanttNav` ("Colour by: Stage | People"). Key row in People mode: person chips "N open" + Unassigned, display-only (D6).
**Tests.** `ProductionGantt-colour-by.dom`: switch, three tones, initials, persistence across remount (seeded and blocked storage). Plus `timeline-colour-by.test.ts` and adapter people cases.

## #921 Phone view-only, frame 3c (≤720px, the existing `phone` media query)
- Vendor variant `GanttTreePanelConfig.placement?: "side" | "inline"`. "inline" renders no tree column. Each row draws its label (name + "Stage · due Tue 22", or the late label) as a sticky inline-start line above the lane inside the single scroller ("Native scrolling needs one passive scroller; the sticky tree lives inside it"). Row height adds `metrics.inlineLabelHeight`; bars are 24/20px; phone `week` width = track/7.
- Phone branch: `interactions` all false; `canCreateTask` false; no Deadline grip; `readOnly`, so no Space adjust; `onEventClick` → `onOpenProject(projectId)` instead of `itemMenu.openFromClick` (a Subtask opens its Project); pinch zoom kept; The key row collapses to a 44px "Key" `QuincyButton` (`COARSE_TAP_TARGET`) opening a ReUI `Drawer` with StageKeyRow + Colour by (D7).
**Tests.** `-narrow-layout.dom` (720/721): no tree, label above bar, Key drawer. `-readonly.dom`: no grip or `draggable`, tap → `onOpenProject(id)`, no item menu. Vendor `gantt-inline-labels.dom`; `gantt-single-scroller.guard` green. The iOS Simulator pass runs against 3c.

## #922 Calendar, frame 3d
- `W/lib/production-event-calendar-adapter.ts`: `data.appearance` (Deadline: `projectLateness`; range: `stageTone(project.stageKey)`, `subtaskLateness(end, status.completed)`, PeopleTone). `color = tone.color`.
- `chipColourClassName`, each class owning every vendor state:
  - range: 14% stage wash + 1.5px stage `inset-ring`;
  - done: paper-100, greige, line-through;
  - Deadline: ink, `--late` when late, `--stage-delivered` when delivered;
  - late range: 2px `--late` ring + "N days late" in `ChipContent`.
- Draw from the module only, never from `status.overdue`; a test asserts the two agree.
- Type: `event-calendar-event.tsx` `text-[0.6875rem]` (11px) gets a scoped `size="readable"` variant (14px title, 12px meta) with an adaptation note.
- Month, agenda and resource views take the same classes. The layers and people filter are untouched.
- `StageKeyRow` comes in through a new ProductionEventCalendar `onFilterChange` (Dashboard.tsx `writeFilter`).
**Tests.**
- Adapter: appearance equals the module output; agrees with `status.overdue`.
- `-chip-contrast.dom`: the resolver learns `--stage-*`, `--late` and alpha washes; 4.5:1 for text in every state and view.
- `-chips.dom`: tones, late, done.
- `-phone.dom`: green.
- Calendar files join the type-floor guard.

## File overlap: owned-file boundaries
- **#918**: appearance module, colors.css, StageKeyRow, toggle, GLOSSARY, design guard. Plus a one-line re-export in the calendar adapter and the dashboard-summary delegation.
- **#919**: gantt adapter, appearance-classes, BarContent, production-gantt-filters, `reui/gantt` variants (a)(b), ProductionGantt.tsx. Dashboard.tsx: only the `<ProductionGantt` props.
- **#920** (after #919): timeline-colour-by.ts, the BarContent people branch, the adapter/classes `colourBy` branch, `ProductionGanttNav`. In ProductionGantt.tsx it only threads `colourBy`. No `reui/gantt` edits.
- **#921** (after #919): `reui/gantt/*` (inline variant) and ProductionGantt.tsx's phone `<Gantt>` props plus the drawer. Never the adapter or BarContent.
- Known conflict: the `<Gantt>` props block. Merge #920 first; #921 rebases.
- **#922**: calendar adapter, ProductionEventCalendar*.tsx, `reui/event-calendar/*`. Dashboard.tsx shared with #919 at different JSX elements only.

## Risks and traps
- There is no dark theme: `.dark` is inert (`reui.css`), and gantt-skin Detector 1 bans `dark:`. So "dark pair" means the `-on-inverse` twin (#741) — D1; Detector 9 reads `stageColors` only. A new tone below 3:1 passes unless Detector 9 also reads `stageTone`; #247 "a done bar rests as an outline" contradicts "complete = filled + tick" (D2); A key-row write that bypasses `writeGanttFacet` makes Stage=Delivered draw nothing (#270 pairing); The key row must list every role-aware stage (#254 "a legend comes from the role-aware stage set"), or pressed-away chips vanish.
- Flat filter reads are banned in ProductionGantt, Dashboard and production-gantt-filters; Coarse vs phone cascade (#692/#695): JS row metrics key on `(pointer: coarse)`; 12px attention labels truncate at 360 until #921 drops the phone tree; measure with `getBoundingClientRect`; A comment spelling a removed class keeps it in the CSS: describe the hatch in words; No rail sub-items (#119 lesson, ADR 0015).

## Open decisions (recommendation)
- D1. Dark pair = an `-on-inverse` twin plus the guard; no new dark theme.
- D2. Done Subtask = paper-100 fill, `--text-muted` solid edge (3.36:1) and a tick. It stays distinct from the greige-500 dashed Awaiting RAW. Amend the #247 guard with owner sign-off; the prototype's greige-300 edge is 2.17:1 and fails 3:1.
- D3. Filter popover swatches move to the module in #919 (one Stage, one look per screen). Board/Table keep the hatch until PR 4.
- D4. Diamond: drag kept, resize grips hidden (the range is still editable in the Due cell). At Day zoom draw a bar: the view honours `shape` at Week and coarser only.
- D5. Key chip counts: omit. The query is server-filtered, so unselected-stage counts are unknowable without a second query. Alternative: drawn-on-screen counts.
- D6. People-mode chips are display-only, with no People filter write.
- D7. 3c says "Colour by under Display". Put it in the phone Key drawer instead, keeping Dashboard.tsx out of #921 (`useUiPref` lets either work).
- D8. 0 civil days reads "Late today". The Project chip reads "N days late", not the prototype's "Overdue · 1 day".

## Frame → component map, and frame conflicts left open for the owner
- **3a** → ProductionGantt (vendored `Gantt`/`GanttView`) + ProductionGanttBarContent + StageKeyRow + ProductionGanttNav.
  Conflicts:
  - rail sub-items: not built;
  - "two-week zoom" = Week at 52px, no new level;
  - task `.fill` progress: dropped;
  - "Due date only" key symbol: rename to "Same day" (glossary);
  - 48/40 rows and the outside late chip need vendor variants (a) and (b).
- **3b** → the same plus the `ToggleGroup` people branch.
  Conflicts:
  - prototype people hues reuse stage teal/ochre;
  - person-chip filter behaviour is unspecified (D6).
- **3c** → ProductionGantt phone branch + vendor `placement:"inline"` + Key `Drawer`.
  Conflicts:
  - Colour by under Display (D7);
  - the phone "Timeline ▾" view selector: keep the shipped tabs (#119);
  - the frame shows 2 tasks per Project: draw all.
- **3d** → ProductionEventCalendar (vendored `EventCalendar`) + ChipContent + StageKeyRow.
  Conflicts:
  - Colour by switch: out of scope;
  - "Not scheduled" sidebar: dropped (ADR 0011);
  - shoot events: no DTO kind, so an API change; not built;
  - Day/Week/Month segmented control vs the shipped month/week/day/3-day/agenda/resource set: keep the shipped set;
  - mini-month rail: keep ProductionEventCalendarRail.

## Additions from the Codex plan (adopted)

- #919: replace the mount-frozen `now` with `useNow` feeding the appearance memos; clock ticks must not reset query generations, child pagination, accepted baselines or drafts.
- #919: forward appearance options through `lib/production-gantt-create.ts::buildPinnedGanttModel`; pinned rows get identical appearance without consuming the draw budget.
- #919: register any new vendor view props in `VIEW_CONFIG_KEYS` (lesson "A typed config key can be silently dropped by a runtime allow-list"). Diamond changes painting/hit geometry only — never the stored range or scheduling proposals.
- #919: add key → badge → view-switch → Back/Forward coverage in `screens/Dashboard-gantt.dom.test.tsx`.
- #921: phone rows include missing-deadline/error rows and child Retry; keep the pointer-travel guard so scrolling never opens a Project; test 720/721/1023/1024 with fine/coarse pointers.
- #922: feed `useNow(60_000)` into the mapping memo; use real Deadline/Subtask instants, not the synthetic display end; don't use `status.overdue` to decide appearance. Supply both `renderEvent` and `renderAgendaEvent` where late content is needed. Contrast tests read merged rendered chips across rest/hover/selected/focus.
