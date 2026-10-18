# #923 Dashboard header, Table and Board on the appearance module — settled plan

Spec: #916 (user story 39, delivery step "PR 4"). Ticket: #923. Frames: `design/prototypes/dashboard-views/project/Dashboard views v4.dc.html`, 4a–4h, and the owner's round 4 decisions in the folder README and on #923.
Integration branch: `feat/923-table-board`. This plan merges the blind Opus and Codex plans of 2026-10-19 with the owner decisions below.

Paths are relative to `portal/apps/web/src/` unless they say otherwise.

## Owner decisions (2026-10-19)

- **D1 Progress: add the API field.** The staff `GET /api/projects` response gains an optional `checklist: { completed: number; total: number }` per Project. It comes from one batched `GROUP BY` over `project_subtasks` for the matched ids, the same pattern as `editorsByProject`.
  - This amends #916's "no API change" for this one field.
  - Both integers are non-negative, with `completed ≤ total`. A Project with no Subtasks gets `{0,0}`, shown as "No tasks".
  - A missing `checklist` means unknown, never "No tasks". Progress renders only when the field is present.
  - The External DTO (`.strict()`) is untouched, so External Editors get no Progress column.
- **D2 Narrow shell: follow the frames.** On the Dashboard at narrow widths (≤771, ADR 0015's breakpoint, which stays as it is), the nav Sheet trigger and the bell move into the view row. Nothing sits above the view row: no breadcrumb row and no 50px shell header.
  - At wide widths the Dashboard has no shell header either; the view row is the only row.
  - Every other screen keeps its shell header and breadcrumb as today.
  - Hide the header on "the Dashboard is mounted", including as the backdrop under the Project sheet, not on `route.kind`. Keying on the route would bring the header back and shift the Dashboard down when the sheet opens. `app.css`'s `.app:has(.page--fill)` rule (#363) is the precedent.
  - Record the chrome change as an amendment note in `docs/adr/0015-the-rail-is-icon-only.md`.
- **D3 Extras with no capability: drop them.**
  - Dropped: the row checkboxes and the 4c pager.
  - Kept: the "N of T projects" footer in flat mode.
  - A column "+ New shoot" appears only in Awaiting RAW, as that column's empty action as well, and only for viewers with `createProject`. It links to `/projects/new` with no Stage preset.
- **D4 Card details: shipped rules win.**
  - No dashed "No editor" avatar (#82).
  - Stars keep `--star-on` / `--star-off` and their 36px (44px on touch) hit cells; only the glyph gets smaller (ADR 0003).
- **Session defaults** (frames plus both plans):
  - The compact Board card is used everywhere. 4d is not built, and Display has no Card option.
  - Table Group by defaults to Stage. A stored explicit choice, `none` included, is kept.
  - Delivered starts collapsed on both views. `board-collapse-store`: nothing stored means `["delivered"]`; a stored `[]` stays `[]`.
  - The Table Display gains "Show: Delivered projects", default on. This is a viewer preference, not a Filter rule.
  - The RAW column stays as a column you can hide, hidden by default for new viewers.
  - Controls keep `CONTROL_HEIGHT` (38px, 44px on phone), not the prototype's 34px. Prototype sizes that aren't on the token scale snap to the nearest token.
  - The page keeps an sr-only `<h1>`. The removed summary (search "N of T", "· N shown") moves to an sr-only `aria-live` status.
  - 4h is the look of the region states: one query feeds every column, so no column ever shows an error on its own. Each view gets a skeleton in its own shape and the inline error "Couldn't load these projects." with Retry, which refetches. An empty column or group shows its own empty copy.
  - Phone Board: Stage pills (`reui/toggle` chip) scroll the column strip with `scrollIntoView`. Every column stays mounted, so no droppable mounts or unmounts during a drag. Drag stays as it is today; no new phone drag rules.
  - Follow-up, outside #923: `StageDot` / `StatusBadge` on the Project header and review screens still draw Edited review in ochre.

## Shared rules and adapters

- `lib/dashboard-appearance.ts` adds `dueToday(project, now)`: true when the Deadline falls on today's Sydney civil day and the Project isn't late. It drives the "Today · 17:00" dot.
- New pure `lib/dashboard-project-appearance.ts`:
  - `projectAppearance(p, now)` returns `{ tone, lateness, lateLabel, dueToday, done }`. It calls `stageTone`, `projectLateness` (archived comes from `archivedAt`), `lateLabel` and `doneCount(p.checklist)`, and gives `done: null` when there is no `checklist`.
  - `stageGroupAppearance(rows, now)` returns `{ count, lateCount, oldestDaysLate, done }`. `done` sums known counts and is `null` when none is known.
  - The Table and Board both get their appearance from these two functions and never derive it again.
- New Quincy parts:
  - `quincy/LateChip.tsx`: lifted from `ProductionGanttBarContent.tsx` (~L194–200). The Timeline then uses it as well.
  - `quincy/StageLabel.tsx`: `StageToneSwatch` plus a 14px sentence-case label, plus "· autoHDR" at 12px for `editing_autohdr`.
  - `quincy/DoneProgress.tsx`: "N of M done" in 12px over `reui/progress`, which gets a scoped 4px variant tinted to the Stage tone, with an adaptation note.

## Frame map

| Frame | Component |
|---|---|
| 4a | `screens/DashboardViewBar.tsx`, one 56px row: `reui/tabs` on the left; New shoot, `DashboardSearch` (input-group), Filter and Display on the right. Also `ShellHeader` / `RailedShell` with no header on the Dashboard, and `DashboardHeader` reduced to sr-only |
| 4a-t | the bar as an `@container`: the search drops to 200px below 1100px |
| 4a-s | the bar in compact mode: tabs other than the current one show icon only (`reui/tooltip`), and search becomes an icon that expands the single, always-mounted `DashboardSearch`. Tapping the icon focuses the field synchronously so iOS raises the keyboard. Narrow shell: the nav trigger and bell sit in this row (D2) |
| 4b | `components/DashboardTable.tsx`, grouped: group header row (chevron, swatch, label, count, "N late", "Oldest late: N days", "d of t done"), 52px rows, Delivered collapsed |
| 4c | the same Table flat and dense (44px rows), sorted by Deadline ascending by default, with the "N of T projects · Delivered hidden by Display" footer |
| 4d | not built |
| 4e | `components/board/board.tsx` columns plus the compact `KanbanCard2` in `board/card.tsx` |
| 4f | the bar's phone row: a view picker (`reui/dropdown-menu` radio, 44px), 44px icon actions, nav trigger and bell; then `StagePills`, then compact cards |
| 4g | the bar's phone row plus `TablePhoneList`: a list grouped by Stage, each row showing thumb, street, suburb, deadline with chip, and editors |
| 4h | `TableSkeleton` and `BoardSkeleton` (`reui/skeleton`), `quincy/EmptyState`, and an inline error with a `reui/button` Retry |
| 3a–3d, 2c | unchanged; only the header above them changes |

## Sub-tasks (each file has exactly one owner)

- **S0 API** (no dependencies):
  - Files: `portal/workers/app/src/routes/projects.ts` and its test, the shared `ProjectSummary` type (`checklist?`) wherever it is defined (`lib/kanban-interaction.ts` and/or `packages/shared`), and the client decoder for `/projects`.
  - Cached snapshots without the field must still decode.
- **S1 Shared** (no dependencies):
  - Files: `lib/dashboard-appearance.ts` (`dueToday`), `lib/dashboard-project-appearance.ts` and its test, `quincy/LateChip.tsx`, `quincy/StageLabel.tsx`, `quincy/DoneProgress.tsx`, `reui/progress.tsx` (the scoped variant), and `ProductionGanttBarContent.tsx` (switches to `LateChip`).
  - S1 types `checklist` structurally (`{ checklist?: { completed: number; total: number } }`), so it doesn't wait on S0.
- **S2 Header and shell** (no dependencies):
  - Files: `screens/DashboardHeader.tsx`, `screens/DashboardViewBar.tsx` and a new DOM test, `quincy/ShellHeader.tsx`, `quincy/RailedShell.tsx`, `styles/app.css`, the header and summary region of `screens/Dashboard.tsx`, the ADR 0015 note, and the shell and search tests (`App-navigation-rail-shell`, `App-rail-dashboard-agreement`, `Dashboard-search-*`).
- **S3 Table** (after S1):
  - Files: `components/DashboardTable.tsx`, `lib/dashboard-table-model.ts` and its test, `use-dashboard-table-prefs.ts`, `screens/DashboardDisplay.tsx` and its test, `Dashboard-table.dom.test.tsx`, and a new `TablePhoneList`.
  - `now` travels to the cells through `CellContext` (lesson "#431 Dashboard Table on the ReUI data-grid").
- **S4 Board** (after S1):
  - Files: `components/board/**`, `lib/board-collapse-store.ts` and its tests, `StageSwatch.tsx`, and the hatch exports in `lib/stage-colors.ts`, which are deleted once nothing uses them.
- **S5 Integration** (after S0, S2, S3, S4):
  - Files: the view region of `screens/Dashboard.tsx` (passes `now` and the `showDelivered` filter, mounts the 4h skeletons and the error with Retry), a new `components/dashboard-table-board.guard.test.ts` (cloned from `timeline-type-floor.guard.test.ts`, it bans below-`text-xs`, the hatch, `StatusBadge`, `stageColorFor` and "overdue" in Table and Board files), and the `docs/lessons.md` entry.
- Then: `npm run verify`, the two-stage browser pass, and code review.

## Tests (red first)

- **Pure:** `dashboard-project-appearance.test.ts` with a fixed "now". Cases:
  - every Stage tone, including `editing_autohdr`;
  - Edited review late; Delivered and archived never late;
  - due today vs. late today;
  - group late count, oldest lateness, and the done sum, which is `null` when no count is known.
- **Adapters:** Table and Board DOM tests check that the late text equals `lateLabel(...)` and that the Stage swatch has the `stageTone` colour, so each view provably calls the module.
- **Model:**
  - `dashboard-table-model.test.ts`: the defaults, a saved `none` kept, corrupt or blocked storage, `showDelivered`, the flat default sort.
  - `board-collapse-store` tests: unset vs. an explicit `[]`.
- **DOM:**
  - Table: group row text, `data-late`, the footer, Delivered collapsed, the phone list.
  - Board: "N late" and "N days late" replace the Overdue tests (~L957, L1831–1884). Keep the `MeasuringStrategy.Always` pin and the "never rewrites SortableContext" pin. The pills scroll without unmounting a column.
  - Header: one row, exactly one `DashboardSearch`, the picker calls `onSelectView`, New shoot gated, the nav trigger and bell in the row when narrow, no shell header on the Dashboard, and the breadcrumb still shown on other screens.
- **API:** the `checklist` counts (zero, partial, all done), batched with no N+1, and the External response unchanged.
- **Guards:** keep `ui-primitive-ratchet`, `routing-transport`, `design-system-guards`, the 721 spelling, `dashboard-fill` and `vendor-skin` green. Never loosen a guard to fit a prototype value.

## Traps (cite these lessons)

- **Board drag:**
  - "Kanban cross-column drag white-screened the app".
  - "The vendored board hard-codes the measuring strategy…".
  - Nothing in-flow changes during a drag, and collapse stays disabled while one is in progress.
- **Board cards:** "#432 Board cards on `frame`". The link stays the stretched drag handle. Stars and ⋯ stay siblings outside the link.
- **Header:** "Dashboard tabs, toolbar search and view rename (#427)". Tabs are `role=tab`, ⌘K stays a focus request, and the phone picker keeps the tabpanel labelled.
- **Filter and Display:** "#430 Calendar and Timeline join the shared Filter and Display". `focusFilterTrigger` and `focusDisplayTrigger` must keep working.
- **Rail:** "The rail and the Dashboard computed 'which view is showing' independently, and drifted (#119)". The tabs and the picker both read `renderedView`.
- **Unmount:** "A Calendar or Board unmount left the Dashboard's controls stuck disabled".
- **Touch:** "A touch phone matches `pointer-coarse:` too…".
