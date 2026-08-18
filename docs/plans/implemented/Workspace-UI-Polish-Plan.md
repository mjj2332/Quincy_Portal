# Workspace UI Polish — Plan

**Status: APPROVED — Terra (2 rounds) + Opus (1 revert) plan-review complete. Not yet built.**

## Problem and scope

Three independently deliverable presentation refinements were requested together:

1. Video delivery link tiles squeeze their title and source chip into one flex row.
2. The overlay collaboration panel's header scrolls out of view with its checklist and comments.
3. The project checklist is always expanded and every item exposes all editing controls, making a
   short Trello-like checklist visually noisy.

This plan is deliberately frontend-only. It preserves the current server APIs, authorization
behavior, and mutation request semantics. The compact-row work deliberately changes local
`load()`/`move()` return contracts to report success for focus handling; it does not preserve
their previous void handler signatures. The three sections below may be built and reviewed as
separate parts of one diff, but the checklist accordion and compact-row redesign are one cohesive
item.

## Source map

- [`CollectionPanel.tsx`](../../portal/apps/web/src/components/CollectionPanel.tsx#L24) owns the
  video-link tile markup. Its `LinkTiles` content at line 31 is a fragment containing two direct
  spans; line 34 places that fragment in either the safe-URL anchor or the non-link plain div.
- [`ProjectCollaborationPanel.tsx`](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx#L14)
  renders the shared header at line 87 and mounts `SubtaskChecklist` at line 89. The overlay-only
  fixed `aside` is at line 97; the standalone section uses the same content fragment at line 96.
- [`SubtaskChecklist.tsx`](../../portal/apps/web/src/components/SubtaskChecklist.tsx#L18) owns
  all checklist fetch, mutation, focus-restoration, and local UI state. Its current header/list
  are at lines 103–118 and its existing `update`, `move`, and `remove` handlers are at lines
  70–100.
- [`app.css`](../../portal/apps/web/src/styles/app.css#L817) has the collection-link rules;
  collaboration panel and checklist rules begin at line 1000.
- [`NoticeBoard.tsx`](../../portal/apps/web/src/components/NoticeBoard.tsx#L67) is the sole
  accordion precedent: a button with `aria-expanded`/`aria-controls`, followed by an identified
  panel with `is-collapsed` and `aria-hidden`. Its CSS collapse rule is
  [`app.css:408–416`](../../portal/apps/web/src/styles/app.css#L408).

## 1. Video link title/source rows

### Change

`LinkTiles` is also used for delivered floorplan and copy links, so this change must be scoped
to video rather than changing the current shared selectors. Give the video invocation at
[`CollectionPanel.tsx:91`](../../portal/apps/web/src/components/CollectionPanel.tsx#L91) an
explicit `collection-links--video` modifier on its `collection-links` parent (via a narrow
`LinkTiles` variant/boolean prop); leave the floorplan/copy invocation at line 101 unmodified.
In [`app.css`](../../portal/apps/web/src/styles/app.css#L818), retain the outer `.collection-link`
column card and apply the vertical override only below that modifier to both direct content
parents:

- `.collection-links--video .collection-link > a` (line 819), and
- `.collection-links--video .collection-link__plain` (line 820).

Keep the shared base selectors as the current horizontal `display: flex` row with
`justify-content: space-between`; the video-only override changes them to a vertical flex stack
(`flex-direction: column`, aligned to the start, with the existing spacing token as the row gap).
Keep their text/link styling and leave `.collection-link__meta` unchanged.

No content wrapper is needed. `content` in
[`CollectionPanel.tsx:31`](../../portal/apps/web/src/components/CollectionPanel.tsx#L31) is a
bare fragment, so `.collection-link__name` and `.chip` are already the two direct flex children
of either parent. A column direction therefore makes the title row 1 and source chip row 2
without adding non-semantic markup. Do not alter the source/status chip in
`.collection-link__meta` (line 822): Manual/Tonomo already has its own lower card row and is not
part of the squeeze.

Before finalizing the CSS, inspect both branches at
[`CollectionPanel.tsx:34`](../../portal/apps/web/src/components/CollectionPanel.tsx#L34): valid
HTTPS links must still use the anchor, and server-supplied/non-safe links must still use the plain
div. Also confirm the selector does not reach the sibling `.collection-link-form` or the inline
`.collection-link-editor`; the Add link form remains its existing three-control grid at
[`app.css:824–830`](../../portal/apps/web/src/styles/app.css#L824).

### Non-goals

- No change to link loading, HTTPS validation, host labeling, editing, deletion, or source tags.
- No title truncation, host-label copy change, or responsive-card-grid change.
- No change to the Add link form or its inline edit form.

## 2. Overlay collaboration fixed header and inner scroller

### Change

Do not use `position: sticky`: the current fixed aside is a single-column implicit-row grid whose
own `overflow: auto` is the only scroll box, leaving its header grid item no sticky scroll travel.
Instead, use this app's existing viewer-panel pattern
([`.vpanel` / `.vpanel__head` / `.vpanel__scroll`](../../portal/apps/web/src/styles/app.css#L527))
for the overlay only.

In [`ProjectCollaborationPanel.tsx:86–97`](../../portal/apps/web/src/components/ProjectCollaborationPanel.tsx#L86),
separate the shared header from the remaining collaboration content. The overlay `aside` receives
an explicit `project-collaboration--overlay` modifier and renders two direct children:

1. a non-scrolling `.project-collaboration__head`, retaining the title and overlay-only Hide
   button; and
2. a `.project-collaboration__scroll` wrapper around the notice, checklist, loading/comments,
   load-older control, and compose form.

The existing `contentMarkup` fragment is shared by the overlay and standalone paths, so do not
blindly wrap that fragment: conditionally render the new scroll wrapper only when `overlay` is
true. The standalone branch continues to render its ordinary header and the same content
unwrapped, as it does today. This keeps `.project-collaboration--standalone` completely outside
the new flex/scroller structure rather than accidentally inheriting the base shared rule.

In [`app.css`](../../portal/apps/web/src/styles/app.css#L1000), scope the structural CSS to the
overlay modifier: change that overlay aside from the current grid/outer-scroller to `display:
flex; flex-direction: column; min-height: 0; overflow: hidden`, with no row gap/padding that
would split the fixed head from the scroller. Give the head its existing paper background,
appropriate panel padding, `flex: none`, and `border-bottom: 1px solid
var(--border-hairline)`. Give the new inner wrapper `min-height: 0; flex: 1; overflow: auto`,
the former content padding, and a column flex/grid gap matching the current visual rhythm. This
makes only the body scroll, while the head stays visibly fixed by structure, not z-index. Do not
introduce a new color token, sticky positioning, or a heavy shadow.

Leave the panel and floating `.project-collaboration__toggle` at their existing `z-index: 70` and
positions ([`app.css:1002–1003`](../../portal/apps/web/src/styles/app.css#L1002)). Verify at the
base 460px panel, the 560px desktop variant, and the narrow full-width calculation that the fixed
head does not clip content or cover/intercept the edge tab. Standalone remains ordinary
document-flow content with no dedicated scroll wrapper.

### Non-goals

- No change to panel open/close behavior, close-button copy/handler, Escape handling, fetch
  timing, panel dimensions, or its z-index relationship with other application overlays.
- No fixed-head/scroller restructuring for `project-collaboration--standalone`.

## 3. Checklist accordion and compact item rows

### 3a. Accordion and progress

Keep the component self-contained: add local `open` state in
[`SubtaskChecklist.tsx`](../../portal/apps/web/src/components/SubtaskChecklist.tsx#L18), initialized
to `true`. Do not read/write storage and do not add a prop. Since the overlay unmounts the
checklist when it closes, a freshly opened panel naturally recreates the component expanded.

Adapt the NoticeBoard accordion interaction convention, but do not overclaim identical markup:
`NoticeBoard` uses `section > button` with no heading. Here retain the existing checklist heading
with valid `header > h3 > button type="button"` nesting.

- Generate a stable local panel id with `useId()`.
- Use valid heading/button nesting: `header > h3 > button type="button"`. The button has
  `aria-expanded={open}` and `aria-controls={panelId}`, and uses `span`s for the eyebrow,
  title/progress text, and layout hooks; do not place the current `div` or an `h3` inside a
  button.
- Keep the existing `aria-live` notice outside the collapsible panel, as an always-mounted direct
  child of the checklist section after the header. Errors such as the unconditional assignee-load
  failure must remain visible and announced even while the accordion is collapsed.
- Wrap only the loading/empty/list states and add-task form in the immediately following
  `<div id={panelId} className={\`subtask-checklist__panel${open ? "" : " is-collapsed"}\`} aria-hidden={!open}>`.
- Add `.subtask-checklist__panel.is-collapsed { display: none; }`, following
  `.notice-board__panel.is-collapsed` rather than using `<details>` or a new hide mechanism.

Compute `doneCount` once from `subtasks`; let `total = subtasks.length`; and calculate
`percent = total === 0 ? 0 : Math.round((doneCount / total) * 100)`. Place a native
`<progress>` **inside** the toggle button alongside/replacing the old bare `x/y complete` heading
text: `value={doneCount}`, `max={Math.max(total, 1)}`, and `aria-hidden="true"`. The visible
summary text (for example, `2 of 3 complete · 67%`) supplies the button's accessible name, so the
progress must not add a redundant `aria-label`/name fragment. `max=1` is only the safe zero-item
rendering guard and never reports a fictional completion.

Style the toggle and bar using existing paper/border/type tokens and ensure the full header has a
clear hover and `:focus-visible` treatment. The panel's content keeps the current bottom divider;
do not create named checklist groups—there remains exactly one flat project checklist and one
progress bar.

### 3b. Compact rows, edit state, and overflow actions

Replace each current three-row, always-editable article
([`SubtaskChecklist.tsx:113–117`](../../portal/apps/web/src/components/SubtaskChecklist.tsx#L113))
with a compact summary row plus conditionally rendered editing controls.

#### State and interaction model

Add two narrow, local pieces of state:

- `editingId: string | null` controls which single item is in the existing title-edit mode.
  A compact title is a real title-styled button, not an input. It enters edit mode only through an
  explicit activation: click, or Enter/Space while that trigger has keyboard focus. Bare
  Tab-focus must not set `editingId`, so keyboard users can Tab past every compact row to the
  composer without mounting controls. Keep per-item title-input callback refs (parallel to the
  existing item refs), and use a `useLayoutEffect` to focus the matching newly mounted input when
  `editingId` *transitions* to that id. Track the prior id in a ref so a `load()` re-render while
  the same item remains in edit mode does not refocus it or steal focus from another control. The
  input continues to use `draftTitles`, Enter-to-blur/save, Escape-to-restore-and-blur, and the
  current `update(item, { title }, "title")` behavior.

  Choose the busy-state resolution that keeps the focus target valid: disable/inert the compact
  title trigger whenever `itemBusy` is true, so it cannot create `editingId` while the title
  input would render disabled. The layout effect must only transfer focus for an activable,
  non-busy entry; it must not call `.focus()` on a disabled input. This is preferable to retrying
  focus after an unrelated mutation because it gives a clear, visible unavailable state and
  prevents the edit transition entirely until that mutation settles.
- `openMenuId: string | null` controls the one item's overflow action group. The ellipsis button
  toggles it and exposes `aria-expanded` and `aria-controls`; the disclosed group is labelled
  `Actions for ${item.title}`. Use ordinary buttons in that labelled group rather than ARIA
  `role="menu"`/`menuitem`, avoiding an unnecessary roving-arrow-key implementation while still
  providing standard Tab/Shift+Tab operation. Render that group inline in normal document flow,
  directly below the item's summary row—not as an absolutely positioned popover—so it remains
  correctly anchored and cannot be clipped by the fixed panel's scroll boundary. Escape calls
  `event.preventDefault()` before closing the group and restoring focus to its ellipsis trigger,
  so the overlay's window Escape listener cannot also close the collaboration panel.

The title input's Escape handler likewise calls `event.preventDefault()` *before* restoring the
draft and blurring/collapsing. Escape cancellation must also be signalled synchronously to the
blur-save path: keep a per-item cancellation ref (or small `Set` held in a ref), set that item's
marker *before* restoring `draftTitles` and calling `.blur()`, and have the input's `onBlur`
handler synchronously check and consume the marker before it considers `update()`. If the marker
is present, that blur skips `update()` entirely; React's asynchronous draft-state update must not
be relied on to make the blur handler see the restored title. This local consumption is required
because the parent overlay closes on an unprevented Escape originating within it.
Clear that item's cancellation marker when entering edit mode as well as when `onBlur` consumes
it. This prevents an unconsumed marker (for example, after an unmount or same-commit input
removal) from swallowing a later legitimate save for the same item.

Make move completion explicit rather than treating an awaited `move()` as proof of success:
change its local return contract to `Promise<boolean>` (or an equivalent explicit result), with
`true` only after both the move POST and its `await load()` refresh succeed; have `load()` report
its caught fetch failure to this caller while retaining its current notice/loading behavior. The
catch path still announces the error and returns `false`. The overflow action awaits that result:
only on `true` does it close `openMenuId` and schedule focus to the moved item's always-mounted
ellipsis trigger, after the refreshed DOM commits. This deliberately replaces the old focus on
`[data-move]`: those buttons are unmounted when the menu closes. On a failed POST or reload, keep
the menu open and do not run the success focus transfer. On a successful delete, clear
`openMenuId` if it is the deleted item before applying the normal next-title/add-input focus
fallback, so no stale menu state survives the removal.
Remove the now-dead `moveFocus` state and its `setTimeout` effect that queries `[data-move]`; the
new explicit success path is the only move-focus mechanism.

CSS `:hover` and `:focus-within` are sufficient for *revealing* the ellipsis button, so do not
add a `hoveredId`. Keep the ellipsis button in the tab order at a concrete resting `opacity: .62`
(matching the app's existing disabled-button subdued level), never `display:none` or
`visibility:hidden`; reveal it at `opacity: 1` for `.subtask-checklist__item:hover`,
`.subtask-checklist__item:focus-within`, its own `:focus-visible` state, and the new
`is-menu-open` row state. The latter is required: an open menu forces its row's revealed styling
even after hover/focus moves away from the trigger. On touch/narrow full-width panels there is no
hover dependency: the visible-at-rest trigger can be tapped, and opening it applies the same
full-opacity `is-menu-open` state.

Close `openMenuId` when a pointerdown lands outside its owning article, or when focus crosses that
article's blur boundary, reusing the `editingId` boundary concept. This prevents a visible inline
Delete action from being left exposed after the user clicks another row or the composer; contained
pointer/action interactions remain open until their action, Escape, or an explicit trigger toggle
closes it.

`editingId` cannot be replaced by CSS alone: the default title must be plain text and the raw
edit controls should not exist until editing begins. Further, title blur must not collapse the
controls when focus moves to the assignee, due field, or ellipsis within the same article. Retain
the title input's immediate blur-to-save behavior, but put the collapse decision on the article's
blur boundary: only clear `editingId` when `relatedTarget` is outside that article. This preserves
editing while focus moves within it, and collapses after a true blur or Escape as requested.
Treat `relatedTarget === null` as outside (`Node.contains(null)` is false): focus leaving the
browser window therefore collapses editing/the open action group, which is expected and
acceptable behavior.

#### Markup

The default compact summary row contains, in order:

1. The existing labelled completion checkbox, still wired to `update(item, { done }, "done")`.
2. The interactive title-text trigger, styled as plain task text. Preserve the existing done
   muted/strikethrough presentation for this text.
3. A due pill only when `item.dueDate` exists: use a `<time dateTime={item.dueDate}>`-style badge,
   prefixed by sr-only `Due`, and show a compact human string such as `30 May` or `30 May ·
   14:30` when the stored literal also carries a time. Never show the literal stored value or a
   native date control in the summary.
4. An assignee initial-avatar only when `item.assignee` exists: derive up to two initials from
   the existing helper, retain `title` as a supplementary mouse tooltip, and provide sr-only
   `Assigned to {name}` text rather than relying on `title` for accessibility. Do not render an
   empty placeholder for an unassigned item.
5. The ellipsis (`⋯`) button, with an explicit accessible name such as `Actions for Call client`.

There is no reusable general calendar-date formatter in this app. The nearby exported
`formatDashboardDate` is specifically a shoot-date helper, includes a year, and has
dashboard-specific fallback copy ([`dashboard-helpers.ts:64–81`](../../portal/apps/web/src/screens/dashboard-helpers.ts#L64));
the other formatters are file-local `Date`/`Intl` helpers. Add a small file-local checklist
formatter instead, based on `dueDateParts()`' literal `YYYY-MM-DD` prefix and a month-name table,
so it produces the intentionally compact day-first `30 May` display without `new Date()` timezone
conversion. This is not the app-wide formatter convention: existing surfaces show day, short
month, and year. Include the literal year when the due date is outside the current calendar year
(`30 May 2027`), and append the stored time when present. It must gracefully fall back to the
literal date only if an unexpected persisted value cannot be parsed.

Do not introduce a second initials implementation in `SubtaskChecklist.tsx`. Extract the current
file-local `initials()` helper from [`Topbar.tsx:20`](../../portal/apps/web/src/components/Topbar.tsx#L20)
to a small reusable frontend helper, update Topbar to import it, and reuse it for the checklist
avatar (whose styling can follow the existing `.avatar` precedent).

When `editingId === item.id`, render the existing title input and a compact edit-controls block
below/alongside the summary row: the existing assignee select and native date/time inputs, with
their exact current `update()` calls and the time-disabled-without-date rule. The overflow group
replaces—not supplements—the three permanently visible action buttons:

- **Move up** calls `move(item, "up")`, preserves its `data-move="up"`, current first-item
  disabled state, reload, and the explicit successful-move result/focus sequence above.
- **Move down** calls `move(item, "down")`, with the equivalent last-item disabled state and
  `data-move="down"` for the existing action/test identity.
- **Delete** calls `remove(item, index)`.

Update the existing post-delete focus selector to target the next compact title trigger rather
than an incidental first button, then fall back to `#subtask-add-${projectId}` exactly as today.
Do not duplicate `move()`/`remove()` or alter their API requests, optimistic/local replacement,
busy-state handling, error live region, or ordering. The move focus target intentionally changes
from the unmounted action to the moved item's ellipsis trigger as specified above.
Hide the summary due/assignee badges for the item while it is in edit mode; the labelled raw
controls are then the single source of that information, avoiding duplicate date/time/assignee
announcements and visual clutter.

#### Styling and accessibility

Restyle `.subtask-checklist__item` as a compact, bordered paper row; use the codebase's existing
row-hover convention—`background: var(--paper-100)` as used by `.prow`, `.frow`, the notice-board
toggle, and video tiles—plus a short existing transition token. The same visual treatment should
apply for `:focus-within` so keyboard navigation has an equivalent cue. Preserve current
`var(--paper-000)`, `var(--border-hairline)`, `var(--text-*)`, space, and typography tokens; do
not introduce a new highlight color.

Add dedicated classes for compact title, badges/avatar, overflow trigger/group, and expanded edit
controls rather than overloading the old three-row selectors. Constrain title/badge flex sizing
and use `min-width: 0`/overflow wrapping so a long title cannot force badges or the ellipsis out
of the fixed-width overlay. Raw date/time and assignee controls must be absent or visually hidden
only in the collapsed default state; when present for the editing item, they remain ordinary,
labelled native controls reachable by Tab. The title trigger (when not busy), ellipsis trigger,
Move up, Move down, and Delete are all keyboard reachable without mouse hover; every visible
focus target gets the project's normal focus-visible outline.

### Non-goals

- No checklist-groups feature, multiple checklists, group headings, drag and drop, or item
  persistence beyond the existing server mutations.
- No persistence of accordion state (no storage and no parent prop threading).
- No `project_subtasks` API, schema, migration, capability, audit, notification, or `Subtask`
  type change. Existing title/done/assignee/due/position data cover the redesign.
- No change to `ProjectCollaborationPanel`'s standalone render path.

## Tests and verification

### Existing coverage to update

- [`CollectionPanel.dom.test.tsx`](../../portal/apps/web/src/components/CollectionPanel.dom.test.tsx)
  already mounts video tiles, safe links, inline editing, and manual/Tonomo behavior.
- [`SubtaskChecklist.dom.test.tsx`](../../portal/apps/web/src/components/SubtaskChecklist.dom.test.tsx)
  covers scoped load, done/assignee/due mutations, reorder/focus restoration, deletion, date/time
  literal handling, mutation errors, and adding a task.
- [`ProjectCollaborationPanel.dom.test.tsx`](../../portal/apps/web/src/components/ProjectCollaborationPanel.dom.test.tsx)
  covers default overlay state, toggle/Escape/focus behavior, and deep-link signals. The
  form-only EditProject regression boundary remains in
  [`ProjectWorkspace.dom.test.tsx`](../../portal/apps/web/src/screens/ProjectWorkspace.dom.test.tsx),
  whose current standalone assertion is a useful guard even though a direct standalone
  `mode="standalone"` render should be added for the overlay-scroller boundary assertion.

### New/changed DOM tests

1. **Link tiles:** extend `CollectionPanel.dom.test.tsx` with safe-anchor and plain-link video
   fixtures. Assert the video `collection-links--video` modifier is present and that
   `.collection-link__name` and the source `.chip` are the two direct children of their content
   parent in title-then-chip order—the structural contract that the column CSS turns into two
   rows—while the Manual/Tonomo `.collection-link__meta` remains a separate sibling. Render
   floorplan and copy delivered-link fixtures too and assert their `collection-links` parents do
   not receive the video modifier, preserving the shared horizontal-tile path. Assert the normal
   Add link form and its inputs/button still render outside a tile/editor. Do not add wrapper-only
   JSX merely to make a snapshot look like rows. Do not add CSS-source assertions: neither the
   Node nor happy-dom Vitest configuration inspects `app.css`, and this codebase has no such test
   precedent; the structural DOM boundary plus the manual browser check cover the CSS scope.
2. **Fixed head/inner scroller:** render overlay mode and assert the overlay modifier, the direct
   non-scrolling head, and the wrapper containing checklist/comments/compose content; render
   `mode="standalone"` and assert it has neither the overlay modifier nor the scroller wrapper,
   with its shared content still unwrapped. Preserve the current edge-tab/toggle assertions.
   Happy-dom cannot model actual scrolling, so browser verification below proves the fixed-head
   behavior and edge-tab non-overlap; do not add a CSS-source assertion.
3. **Accordion/progress:** assert the default `aria-expanded="true"`, matching panel id and
   non-collapsed content; click to assert `false`, `aria-hidden="true"`, and `is-collapsed`; click
   again to reopen. Cover 0/0 → 0%, a partial set (for example 1/3 → 33%), and all complete →
   100%, asserting the `progress` `value`/`max`, `aria-hidden="true"`, and visible summary
   without division by zero. Mock an assignee-load failure while collapsed and assert its existing
   always-mounted live notice remains available for announcement outside the hidden panel.
4. **Compact rows:** assert default rows contain plain title triggers and no date/select edit
   controls, while due and assignee badges appear only for populated values. Verify literal
   `2026-05-30` formats as `30 May`, a different-year date includes its year, and a due time is
   retained in the badge; assert its sr-only `Due` prefix. Assert the avatar has initials,
   supplementary full-name tooltip, and sr-only `Assigned to {name}`. Separately enter edit mode
   by mouse click and keyboard Enter/Space activation; in each case assert the matching title
   input receives focus via the layout-effect transfer and the date/time/select controls become
   available. Tab through compact title triggers without activation and assert none enters edit
   mode, allowing Tab to reach the composer. While an item mutation is pending, assert its title
   trigger is inert/disabled and cannot enter edit mode or lose focus to a disabled input. Assert
   badges hide when its raw controls are shown. Test Enter/normal-blur save preserves the current
   PATCH payloads. After changing a title, test Escape `preventDefault()`/revert/collapse with a
   mocked PATCH spy and assert **zero** PATCH requests for that discarded title change—not merely
   that the rendered value reverts; then re-enter that item and save a changed title to prove a
   previously unconsumed cancellation marker cannot swallow the later save.
5. **Overflow actions and keyboard:** assert the ellipsis trigger remains tabbable when the row
   is otherwise compact, toggles its labelled action group, and supports Escape
   `preventDefault()`/focus return. Assert its disclosed group is the inline, following content
   below the summary row, not a detached popover. Pointerdown/focus outside the owning article
   must close it, while an open menu keeps the row in its explicit revealed state. Do not claim
   happy-dom proves `:hover` or `:focus-within` rendering; those pseudo-class visuals are
   browser-verified below. Exercise Move up/down and Delete through the group, preserving the
   exact existing POST/DELETE calls and disabled edge actions. Mock the move POST plus its `await
   load()` re-fetch and assert that a successful move closes the group and focuses the moved
   item's ellipsis; mock either the POST or reload failure and assert it leaves the menu open with
   no success focus transfer. For deletion, assert the deleted item's `openMenuId` is cleared and
   focus moves to the next compact title trigger (or the add input when no item remains). Keep the
   current date/time and assignee PATCH tests, but perform them while the matching item is in
   editing state.
6. **Overlay Escape integration:** in `ProjectCollaborationPanel.dom.test.tsx`, mount the real
   `SubtaskChecklist` inside the overlay, enter title editing, dispatch Escape from that input,
   and assert the title reverts/collapses while `.project-collaboration` remains open. Repeat for
   an open overflow group. This specifically covers the parent window listener that an isolated
   checklist test cannot exercise.
7. **Manual browser check:** load a project with long title, assigned/due and unassigned/no-due
   subtasks. At base, wide, and phone-narrow panel widths, verify no clipping; actual hover and
   `:focus-within` row highlights/ellipsis visibility including the non-zero resting opacity and
   touch tap/open behavior; Tab can pass titles without expanding them, while Enter/Space edits
   and the inline menu remains usable; accordion reset after closing/reopening; and the
   non-scrolling fixed head with its solid border while only checklist/comments scroll. Confirm
   the floating edge tab remains usable and unobscured. In the video collection after the item-1
   CSS change, re-check the stacked layout for both safe anchor and plain-link variants, then
   re-check that the existing Add-link form and the inline video-link editor still lay out and
   operate normally.

Run the required verification sequence from `CLAUDE.md`, from `portal/`, before this work is
considered complete:

```sh
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

The final shared-package invocation is required because the workspace-root test command silently
skips that suite, even though this presentation-only change is not expected to modify it.

## Routing and review

Under [`docs/Subagent-Orchestration.md`](../Subagent-Orchestration.md) §1–§2, this is a normal,
frontend-only feature/refactor with no migration or backend contract change: Terra is the default
builder, followed by a fresh, read-only Terra diff review. Before any build starts, this draft
must proceed through the documented plan pipeline: fresh Terra review (at most two rounds), then
fresh Opus plan review; any requested revision returns to a fresh Terra under the capped
Opus→Terra loop. The builder must self-check each of the three independently scoped pieces; the
§5 gate then reruns the full verification sequence above and directly inspects the diff before
commit/deploy.

## Review-focus decisions and risks

- The exact hover highlight is intentionally pinned to the established `var(--paper-100)` row
  treatment rather than a new token; review should confirm it has adequate contrast against the
  fixed panel's `var(--paper-050)` background.
- The due badge deliberately uses a more compact current-year `30 May` form than the app's usual
  day/month/year format, preserves any stored time, includes a different year, and uses literal
  parsing rather than browser `Date` construction; review should confirm unexpected persisted
  values still fall back safely to their literal value.
- Local `editingId`, its guarded layout-effect input transfer, and article-level focus-boundary
  handling are required to avoid both a focus void on entering edit mode and collapsing the newly
  revealed due/assignee controls the moment a user Tabs out of the title input. Review should
  scrutinize Escape consumption and the explicit move-result sequence: on a successful refetch,
  the menu closes and focus moves to the always-mounted ellipsis; failures retain the menu; delete
  clears its menu id before moving focus to the next title/add control.
- The fixed-head behavior is structural rather than sticky. Its overlay/standalone and
  head/scroller DOM boundaries are automated, while real scrolling and edge-tab non-overlap remain
  a required browser check because happy-dom does not model scrolling layout.

## Builder notes from final Opus review (non-blocking, absorb during build)

The plan was APPROVED with these six notes flagged for the builder to handle as judgment calls —
none required a third plan-revision round:

1. **Scope the overlay head CSS correctly.** `.project-collaboration__head` (`app.css:1004`) is a
   shared class used by both the overlay and standalone paths. The new head styling (padding,
   `flex: none`, `border-bottom`) must be written as
   `.project-collaboration--overlay .project-collaboration__head`, not a bare
   `.project-collaboration__head` rule — unscoped, it silently restyles the standalone header too,
   and the DOM test boundary would not catch it.
2. **Leave the ellipsis ("⋯") trigger enabled during `itemBusy`**, rather than disabling it like
   the other row controls. This keeps one focusable, actionable control on a busy row and makes
   the post-move focus transfer (which targets the ellipsis) unconditionally robust — no busy-row
   edge case to reason about.
3. **`opacity: .62` collides with `.button:disabled`'s existing opacity value** (`app.css:783`).
   An enabled, resting ellipsis at the exact disabled-affordance opacity may read as disabled
   during a real browser check; nudge it up slightly if so.
4. **`MONTHS` at `dashboard-helpers.ts:14` is module-private**, so the new file-local checklist
   date formatter will duplicate a month-name array rather than reuse it — this is justified by
   the plan's own different-format reasoning (compact `30 May` vs. the dashboard's fuller format),
   but exporting `MONTHS` instead is an equally acceptable resolution if it's cheap during build.
5. **Two existing test lines will break and need direct updates**:
   `SubtaskChecklist.dom.test.tsx:43` currently clicks `[data-move="down"]` directly (must open
   the overflow menu first under the new markup), and `SubtaskChecklist.dom.test.tsx:46` asserts
   focus lands on the Move-down button after a reorder (must become the ellipsis trigger instead,
   per the new focus-restoration design).
6. **Optional keyboard polish, not required**: Enter-to-save and Escape both currently collapse
   edit mode via the `relatedTarget === null` path, which drops focus to `<body>` — this matches
   today's existing behavior (not a regression), but returning focus to the compact title trigger
   on collapse would be a cheap UX improvement if the builder has room for it.
