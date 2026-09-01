# TB8-02 — Ordinary Menus, Dialogs, Popovers and Sheets: Visual Plan

**Status: APPROVED 2026-09-01 by a second, independent fresh-Opus gate — ready to build (pipeline
step 4).** Drafted 2026-09-01, all four open questions resolved by owner the same day, two Sol rounds
complete, then **blocked at the first final-Opus gate** on a mechanism defect in §4.2a plus eight
must-fix items. **All nine were fixed** — §4.2a's nested-overlay mechanism is redesigned from
scratch (container inside the panel, `.modal__scroll` split, `positionMethod="fixed"`, with the
stacking and focus-trap logic walked through explicitly and a pre-authorised fallback), and a
`file:line` citation sweep was run across the document rather than spot-fixing the four the gate
named. The gate's review block is retained verbatim below as the record.

> **Second fresh-Opus gate — APPROVED, 2026-09-01.** Independent re-review with no drafting
> context. **§4.2a's redesigned mechanism holds**, re-derived from the CSS spec and the installed
> packages rather than taken on report: `FloatingOverlay` sets `position: fixed` as an *inline*
> style (`floating-ui.react.mjs:2244`, `...rest.style` spread last) and §6.2's class adds
> `z-index: 95`, so it establishes a stacking context; the slot is a descendant of it, so a portaled
> popup can no longer paint at the outer level against the dialog, and inside the panel's own
> context a positioned `z: 90` child paints above the panel's in-flow content. The slot sits inside
> `FloatingFocusManager`'s child subtree, so the popup is inside `refs.floating` and the trap. The
> `overflow: auto` claim is exact (`floating-ui.react.mjs:2245`, class-unoverridable), the
> `positionMethod` default is `'absolute'` (`internals/useAnchorPositioning.d.mts:84`, impl `:58`)
> and `alignItemWithTrigger` defaults `true` (`select/positioner/SelectPositioner.mjs:49`), and
> floating-ui's own `getOffsetParent` → `getContainingBlock` path explicitly detects `translate`
> (`@floating-ui/utils` `isContainingBlock`), so a `translate`d panel is a containing block the
> library resolves correctly. Two clipping/containing-block statements were **imprecise, not wrong**,
> and are corrected in §4.2a below. Also fixed at this gate: the missing `OverlayContainerContext`
> wiring for `AnchoredPopover`/`Menu` (§4.2a claimed all three consume it; only §9.2 showed it),
> §6.7's CSS delete list contradicting §12.2, a test assertion §12.2 did not flag, a new criterion
> 23(g), the §11.2 bullet §4.2a forward-references, and eight residual ±1–3 `file:line` drifts.
> **The gate's own `Admin.tsx:464`→`:465` dispute is resolved in the plan's favour: the
> `{payload && <div className="admin-modal"…` line is `Admin.tsx:465`, verified directly.**

Every section is committed; **§13 carries zero open questions**. The owner's four
decisions (2026-09-01), each taking the plan's own recommendation: **Q1** Topbar menus are in full
scope, behavior and paint — the `Menu` primitive ships (§8); **Q2** the ≤720px sheet presentation is
approved as written (§6.5); **Q3** the `--z-*` token family is approved (§4.2); **Q4** `Modal`
absorbs both the Admin payload and RTE link dialogs (§6.6, §6.7), with acceptance criterion 15 as
the explicit gate on §6.7's selection-restoration risk. Candidate release #2 of
[TB8 — Surface-by-Surface Design Convergence and Cleanup](TB8-Wider-UI-Migration-And-Cleanup.md),
ranked second in the kickoff doc's
[Ranking (2026-09-01)](../../Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md#ranking-2026-09-01)
on the rationale that this is *the* cross-cutting primitive: nearly every later candidate
(Workspace rail, project/admin forms, notification UI, board card controls, Collaboration, notice
board) opens an overlay, so converging it here means those releases inherit the fix instead of each
reinventing it. Pipeline per
[Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md](../../Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md)
§ "Pipeline for TB8". History: drafted 2026-09-01; four owner decisions resolved; two fresh-Sol
review rounds (the pipeline's ≤2-round cap); self-edited past the cap per the standing §2.1 rule;
first fresh-Opus gate blocked it; author redesigned §4.2a and fixed all eight must-fix items; second
fresh-Opus gate approved it with the corrections listed above.
**Next: pipeline step 4 — Sonnet subagent builds.**

> ## Final Opus self-review — **NOT APPROVED (blocked)**, 2026-09-01
>
> *(Retained verbatim as the review record. Every finding below was verified against live source
> and acted on — see the status line above. One correction to the review itself: its citation-drift
> item gives the Admin dialog as `Admin.tsx:464`; the `{payload && <div className="admin-modal"…`
> line is at **`:465`**, as the plan already had it. The plan's other three drift corrections
> — Topbar `setTimeout`, `handleLinkDialogKeyDown`'s end line, `.topbar__mobile-menu` — were
> confirmed accurate and applied, and the sweep found two further errors the review did not:
> a wrong `fonts.css` and two stale Calendar `Modal` line numbers.)*
>
> Independent terminal-gate review with no drafting context, per the standing "past the ≤2-round
> cap Opus edits the plan itself and a fresh Opus self-review approves it" rule (pipeline step 3).
> This review made **no edits to the plan body** — the blocker below changes a mechanism, not
> wording, and the fix plus its knock-ons (§4.2a, §9.2, §5 row 16, criterion 23) should be made by
> one hand rather than patched piecemeal at the gate.
>
> **Verified accurate and left alone** — checked directly against live source and the installed
> packages, not taken on report:
>
> - **No new dependency is needed.** `@floating-ui/react@0.27.16` and `@base-ui/react@1.7.0` are
>   both in `portal/package.json`. `react`/`react-dom` are **19.2.8**, so §8.1's claim that `ref` is
>   an ordinary prop and that `ComponentPropsWithRef<"a">` needs no `forwardRef` is correct.
>   (Note the repo's root `CLAUDE.md` still says "React 18.3.1 current baseline" — the plan is
>   right and `CLAUDE.md` is stale. Out of scope here.)
> - **`FloatingPortal` genuinely accepts `root`**, typed
>   `HTMLElement | ShadowRoot | null | MutableRefObject<…>`
>   (`node_modules/@floating-ui/react/dist/floating-ui.react.d.ts:490–507`), and **Base UI's
>   `Menu.Portal` / `Select.Portal` genuinely accept `container`**, typed
>   `HTMLElement | ShadowRoot | React.RefObject<…> | null`
>   (`menu/portal/MenuPortal.d.mts`, `select/portal/SelectPortal.d.mts`). §4.2a's API claims are
>   verbatim correct; it is the *stacking argument built on them* that fails — see the blocker.
> - `TransitionStatus` is exactly `'unmounted' | 'initial' | 'open' | 'close'` and
>   `useTransitionStatus(context, { duration })` returns `{ isMounted, status }`
>   (`floating-ui.react.d.ts:734, 1347–1358`). §6.0 is correctly specified.
> - `--dur-base: 220ms` / `--dur-fast: 120ms` (`tokens/spacing.css:47–48`) match §6.0's JS literals.
>   `--ease-exit` is confirmed **unused anywhere** in `portal/apps/web/src` — §4.3 is its first
>   consumer, as claimed.
> - Every token §§4/6/7/10 cites is real and semantic: `--shadow-md/lg`, `--border-width-bold: 2px`,
>   `--border-width-rule: 3px`, `--border-strong`, `--text-2xs: 11px`, `--radius-card`,
>   `--bg-surface`, and `bg-popover` → `--popover` → `--bg-surface` → `--paper-000`
>   (`tokens/tailwind.css:6,27`). §6.3's `bg-background`-not-`bg-card` warning is correct:
>   `--background` → `--bg-canvas` → `--paper-050`, which is `.modal`'s live background.
> - Defect **H**'s z-index table is exact: `.admin-modal` 30 (`app.css:1078`), `Select` `z-20`
>   (`ui/select.tsx:61`), notification menu 60 (`:74`), `.topbar` 75 (`:46`), banner 76 (`:35`),
>   the four-way tie at 90 (`:266, :583, :1232, :764`), `.rich-text__link-modal` 100 (`:527`),
>   `.toasts` 95 (`:781`). Defects A, B, C, D, F, G, I, J, K, M all reproduce in source.
> - **`Modal`'s consumer set is complete.** Exactly four files import it — `ConfirmDialog.tsx`,
>   `ProductionCalendarFoldChoice.tsx`, `ProductionCalendarMoveDialog.tsx`,
>   `ProductionCalendarScheduleEditor.tsx`. `ProductionCalendarMoveConfirmation.tsx` does **not**,
>   so there is no missed fifth consumer.
> - **The RTE `×` removal (§6.7) is sound, and is not a regression.** `RichTextEditor.tsx:373`'s
>   `×` calls `closeLinkDialog()` with no arguments — **byte-for-byte the same call as the Cancel
>   button at `:376`**. It is a pure duplicate of Cancel, not a distinct destination, so dropping it
>   removes an affordance and no capability. And the shared `Modal` does *not* need its own close
>   affordance for this consumer: §6.7's footer retains `Cancel`, so a user who knows neither
>   Escape nor outside-click still has a visible, labelled control. (Confirmed `Modal.tsx:32–35`
>   renders eyebrow + title only, with no `×` — so option (c) is only safe *because* the footer
>   Cancel survives. Any future consumer that drops the footer would need option (b).)
>
> ### BLOCKING — §4.2a's portal-containment strategy does not produce the stacking it claims
>
> §4.2a specifies the container as *"the node its own `FloatingPortal` created"* and argues the
> nested overlay then *"paints above it by document order — no z value involved."* Both halves fail
> against the structure §6.1/§6.2 actually build:
>
> 1. **A z value *is* involved, and it loses.** §6.2 puts `z-[var(--z-dialog)]` (95) on the
>    `FloatingOverlay`, which is `position: fixed` — so the overlay **creates a stacking context at
>    z 95**. The `FloatingPortal` node is that context's *parent*, so a `Select` portaled into it is
>    the overlay's **sibling**, not its descendant. §4.2a explicitly keeps `z-[var(--z-popover)]`
>    (90) on the Positioner ("purely as a local ordering hint among siblings"), so the popup paints
>    at 90 against the dialog's 95 — **underneath the dialog**, which is the exact defect §4.2a
>    exists to close. Dropping the class does not rescue it either: a `z-auto` positioned element
>    paints in the z-0/auto layer, still below a positive integer. Document order never enters,
>    because the two are not in an ancestor/descendant relationship.
> 2. **The focus half is wrong for the same reason.** §6.1 makes `FloatingFocusManager`'s child the
>    *panel*. "The dialog's own subtree," for trap purposes, means inside that panel. A sibling of
>    `[data-confirm-modal-root]` is outside the trap, so §4.2a's third bullet — the one it calls
>    "required for focus correctness, independently of z" — is not delivered. Criterion 23(a) and
>    23(b) therefore both fail as specified.
> 3. **The obvious repair collides with two `overflow` boxes.** Moving the container inside the
>    panel satisfies both of the above, but `FloatingOverlay` hard-sets `overflow: 'auto'` as an
>    **inline style** (`floating-ui.react.mjs:2243–2251`, so no class can override it) and §6.3
>    gives the panel `overflow-auto` as well. Base UI positions with **`positionMethod`
>    defaulting to `'absolute'`** (`internals/useAnchorPositioning.d.mts:80–84`, impl `:58`), so an
>    absolutely-positioned popup inside the panel is clipped and scroll-bound by it — the same
>    clipping hazard `Checklist-Popovers-And-Drag-Reorder-Plan.md:100–108` records as the reason
>    `FloatingPortal` was mandatory for the checklist popovers.
>
> **Why this blocks build:** the plan's stated mechanism is not merely imprecise, it produces the
> opposite of the required result, and the builder is explicitly told to improvise nothing. A
> correct solution does exist — container = a non-scrolling node rendered *inside* the panel
> (so it is inside the trap and inside the z-95 context), plus `positionMethod="fixed"` on nested
> Base UI positioners (so neither `overflow: auto` clips them) — but that adds a prop §4.2a never
> mentions and needs its own check against `alignItemWithTrigger`, `collisionPadding` and overlay
> scrolling. That is a mechanism decision, not a copy-edit, so this gate does not make it.
> Re-verify §4.2a, §9.2's Positioner line, §5 row 16 and criterion 23 together once it is chosen.
>
> ### Must fix before re-review (found real, each anchored, none of them the blocker)
>
> 1. **§8.1 item 5's terminal focus case is unimplementable as written.** It sends focus to
>    "the **'Mark all read' button** in the menu head — it is **always present**, always focusable."
>    It is not: `Topbar.tsx:151` renders it only under `{unreadCount > 0 && …}`. Dismiss the last
>    notification when nothing is unread and the target does not exist. This also **contradicts
>    criterion 14.9**, which asserts the third case leaves "focus on the open popup." Make both say
>    *the menu popup itself* — which is also what the live code already does
>    (`Topbar.tsx:105`, `(target ?? menu)?.focus()`, the popup carrying `tabIndex={-1}` at `:150`).
> 2. **§8.1 item 5 mis-describes the status quo.** "Left alone, the browser drops focus to
>    `<body>`" is true of Base UI with no policy, but the plan presents it as today's behavior.
>    `Topbar.tsx:97–107` **already implements** next-row → previous-row → menu, via
>    `setTimeout(0)`. The plan is replacing a policy, not inventing one — and the honest framing
>    strengthens it, since the deferred `setTimeout` is exactly what §8's own TB0 argument wants
>    gone. State it that way.
> 3. **§6.0's Calendar table would regress `ProductionCalendarScheduleEditor`.** The row says
>    "`key` on the edited entity's id." The live call site
>    (`ProductionCalendar.tsx:1582`) already carries a **composite** key —
>    `` `${scheduleEditor.source.id}:${JSON.stringify(scheduleEditor.initialSchedule ?? null)}` `` —
>    deliberately, so a re-proposal after a validation error (`:1439`, `:1444` set a new
>    `initialSchedule` on the same source) **remounts** the editor and re-seeds `useState` from it
>    (`ProductionCalendarScheduleEditor.tsx:100`). Narrowing that key to the entity id silently
>    breaks TB5C's validation-retry flow. Preserve the existing key verbatim; retention only.
> 4. **§6.0's Calendar table under-describes the Move dialog's retention.** It names a `moveTarget`
>    that does not exist and retains only `event`. The real state is `moveDialog`
>    (`ProductionCalendar.tsx:473`), and the call site (`:1581`) passes **three** data props —
>    `event`, `initialCivil`, `foldChoices`. Retain the whole `moveDialog` object in the ref.
>    Likewise `checklistFold` feeds `endpoint`/`choices`/`eyebrow` at `:1583`. Also state the rule
>    the `ConfirmModalHost` snippet already follows but this table omits: **`key` must be computed
>    from the retained value, not the live state**, or it goes `undefined` mid-exit and remounts the
>    dialog it is trying to keep on screen.
> 5. **§12.3's "mechanical edits enumerated" omits four files that §6.0 requires editing.**
>    `ProductionCalendar.tsx` and the three dialog components
>    (`ProductionCalendarMoveDialog.tsx:47`, `ProductionCalendarFoldChoice.tsx:22`,
>    `ProductionCalendarScheduleEditor.tsx:145`) each render `<Modal>` unconditionally inside their
>    own body, so every one needs a new `open` prop threaded through to `Modal`, and the parent
>    needs the retention from item 4. A twelve-item list that claims the builder "improvises
>    nothing" cannot leave the largest consumer group out.
> 6. **§6.7's Shift-Tab claim is false.** "The `focusin` listener is a *worse* trap — it forces
>    focus to the URL field rather than cycling, so Shift-Tab from the field is impossible today."
>    `handleLinkDialogKeyDown` (`RichTextEditor.tsx:330–338`) handles **both** directions —
>    `:336` computes the wrap-around index for `event.shiftKey`. The disposition (delete both
>    owners) stays right; the reason given for it is not.
> 7. **Two undisclosed visual deltas on the absorbed Admin dialog.** §6.6 says it "loses nothing."
>    `.admin-modal__panel` is `border: 1px solid var(--ink-900)` (`app.css:1079`) — a *solid ink*
>    border, becoming a greige hairline under §6.3, which is a second change beyond the stated
>    paper step. And the dialog's accessible name changes: today `aria-label="Tonomo event payload"`
>    (`Admin.tsx:464`), under `Modal` it becomes `aria-labelledby` → "Event details". Both are
>    defensible; both should be stated, as §6.3 states the paper step.
> 8. **Line-number drift, ±1–4, throughout.** Spot-checked: the Admin dialog is `Admin.tsx:464`
>    (plan says `:465`); the Topbar `setTimeout(0)` calls are `:37, :42, :55, :60` (plan says
>    `:36, 41, 55, 59`); `handleLinkDialogKeyDown` runs to `:338` (plan says `:336`);
>    `.topbar__mobile-menu` is `app.css:858` (plan says `:854`). Harmless individually, and §12.2's
>    grep-before-delete rule absorbs it — but re-run the citations at build rather than trusting them.
>
> ### Confirmed clean — no regression of the previously-fixed problems
>
> No invalid Tailwind class forms, no self-referential theme alias, no raw-ramp or raw-palette
> class, no unauthorized dependency, no mischaracterized library API (the `closeOnClick`
> asymmetry, the `render` prop, and the `TransitionStatus` names are all now stated correctly), the
> Kanban QA waiver is properly withdrawn as an unconditional mandate matching
> `docs/lessons.md:901–902`, the exit-timing mismatch is resolved by §10.2's direction-specific
> durations, and §6.6/§6.7's consumer snippets now carry `open`. All four owner decisions are
> applied consistently: Topbar menus in full scope (§8), the ≤720px sheet (§6.5), the `--z-*` family
> with honest traced-vs-new labelling (§4.2's table), and both dialogs absorbed (§6.6/§6.7).
> Apart from the §4.2a section, the document reads as one coherent voice with no leftover fragments.

**Precedent.** [TB8-01 — Dashboard Shell](TB8-01-Dashboard-Shell-Visual-Plan.md) shipped to
production and established the conventions this plan reuses rather than re-derives: the
`Button`/`buttonClasses()` seam (§2.1 there), the `Select` primitive built on `@base-ui/react`
(§2.2), the arbitrary-value-bound-to-Quincy-variable convention (§1.2), the narrow-semantic-role
`@theme` extension with its hard non-goals (§1.4), the `border-*-solid`-does-not-exist trap (§1.3),
and the unlayered-`app.css`-outranks-Tailwind cascade fact (§1.5). Those are treated as settled
authority here. Where this plan needs the same thing, it cites TB8-01 and stops.

**Styling-owner authority.** Per the kickoff doc's
[Tailwind adoption scope decision](../../Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md#decision-tailwind-adoption-scope-for-tb8-2026-09-01),
TB8 extends the TB1 Tailwind v4 + shadcn foundation surface by surface. **TB8-02 extends it to the
shared overlay primitives as its third bounded consumer.** Extension of TB1's setup, never a
parallel one. Every value still traces to `portal/apps/web/src/styles/tokens/`.

---

## 0. Scope

**In scope — the overlay primitives and every consumer that renders through them:**

- the shared dialog (`components/Modal.tsx` + `.scrim`/`.modal`) and its four consumers;
- the shared anchored popover (`components/AnchoredPopover.tsx`) and its four popover instances
  across two CSS skins;
- the two hand-rolled dialogs that bypass the shared one (`.admin-modal`,
  `.rich-text__link-modal`);
- the one bespoke floating picker that duplicates the shared popover
  (`.project-team-picker`);
- the mention autocomplete popup's paint (`.mention-autocomplete`);
- the overlay *contract* itself: scrim, elevation, radius, motion, z-order, focus, Escape,
  outside-dismiss, and touch geometry, unified into one stated set of rules;
- one already-converged consumer's z-order defect (`ui/select.tsx:61`).

**The app's only two real menus** (`.topbar__notification-menu`, `.topbar__mobile-menu`) — §8,
**in full scope, behavior and paint, per owner decision 2026-09-01** (§13 Q1). This includes the new
shared `Menu` primitive. The fence is the menu popups and their two triggers; `.topbar` itself,
`.topnav`, the identity block and the impersonation banner stay untouched.

**Explicitly out of scope:**

| Surface | Why |
| --- | --- |
| `.viewer` — the Lightbox (`Lightbox.tsx:484`) | Roadmap: *"Lightbox controls where valuable"* is the ninth candidate, deliberately last. A full-screen media surface is not an "ordinary" overlay. |
| `.project-collaboration--overlay` (`ProjectCollaborationPanel.tsx:93`) | It is an `<aside>` disclosure, not a dialog — no `role="dialog"`, no trap, deliberately non-modal (`ProjectCollaborationPanel.dom.test.tsx:257` *asserts there is no scrim*). Belongs to the *Collaboration/checklist/comments* candidate. |
| `.compare` (`app.css:708`), `.actionbar` (`:316`), `.drawbar` (`:362`), `.viewer__panel-scrim` (`:843`) | Lightbox/annotation family, same deferral. |
| `.toasts`/`.toast` (`app.css:781`) | Not an overlay a user interacts with; TB8-01 already converted the Dashboard's and left the `app.css` rules for `Admin.tsx` and `ProjectWorkspace.tsx`. Their migration belongs to those surfaces' own candidates. |
| The Notice Board panel, board card controls, Workspace rail | Their own candidates. |

---

## 1. The survey — what actually exists

Run against `portal/apps/web/src` on 2026-09-01. **Eleven distinct implementations of "an overlay
that appears near or over other content."** Ten predate TB8; one (`Select`) is TB8-01's.

### 1.1 Inventory

| # | Pattern | Source | CSS | Positioning / focus engine | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | **Shared dialog** `Modal` | `Modal.tsx:16–42` | `.scrim` `app.css:764`, `.modal` `:765–772` | `@floating-ui/react` — `FloatingPortal` + `FloatingFocusManager modal returnFocus` (`:27,:29`) | **Converge onto it** (§6) |
| 1a | ↳ `ConfirmDialog` + global `confirm()` queue | `ConfirmDialog.tsx:10–23`, `lib/confirm.ts`, host mounted `main.tsx:16` | inherits | inherits | consumer, unchanged API |
| 1b | ↳ Calendar Move / Fold / Schedule dialogs | `ProductionCalendarMoveDialog.tsx:47`, `ProductionCalendarFoldChoice.tsx:22`, `ProductionCalendarScheduleEditor.tsx:145` | + `[data-modal-variant="calendar"]` overrides, `production-calendar.css:237,246,253,268,277` | inherits | consumer, unchanged API |
| 2 | **Hand-rolled dialog — Admin payload** | `Admin.tsx:465` (single inline JSX line) | `.admin-modal` `app.css:1078–1080` | **none**: no portal, no focus trap, no Escape, no outside-click, no focus restore | **Retire → `Modal`** (§6.6) |
| 3 | **Hand-rolled dialog — RTE link** | `RichTextEditor.tsx:370–378`, trap at `:330–338` | `.rich-text__link-modal` `app.css:527`, `__dialog` `:529–535`, `__backdrop` `:528` | **bespoke**: manual `querySelectorAll` focus cycle, non-portaled, backdrop `onMouseDown` preventDefault with **no close** | **Retire → `Modal`** (§6.7) |
| 4 | **Shared anchored popover** | `AnchoredPopover.tsx:11–59` | `.subtask-popover` `app.css:1232–1248` | `@floating-ui/react` — `useFloating` + `offset(6) flip shift`, `FloatingFocusManager modal={false} returnFocus={false}`, explicit `pointerdown`/`focusin` boundary | **Converge onto it** (§7) |
| 4a | ↳ 3 checklist popovers (schedule, assignee, actions) | `SubtaskChecklist.tsx:103,122,133` | `.subtask-popover*` | inherits | consumer |
| 4b | ↳ Kanban "Move to…" | `ProjectKanbanBoard.tsx:210–229` (`modal` variant) | `.kanban-move-popover` `app.css:583–589` | inherits | consumer, **CSS stays** (§9.3) |
| 5 | **Bespoke floating picker** | `ProjectTeamControl.tsx:55–95` | `.project-team-picker` `app.css:266–276` | **duplicate**: its own `useFloating`, own `pointerdown` effect (`:56–65`), own Escape/Arrow handler (`:73–78`), `returnFocus={triggerRef}` | **Retire → `AnchoredPopover`** (§7.4) |
| 6 | **Mention autocomplete** | `MentionAutocomplete.tsx:46–57` | `.mention-autocomplete` `app.css:537–542` | **none — static in flow**; keyboard owned imperatively by `RichTextEditor` via `useImperativeHandle` (`:29–38`) | **Preserve; paint only** (§9.1) |
| 7 | **Notification menu** | `Topbar.tsx:150–156` | `.topbar__notification-menu` `app.css:74–85` | **hand-rolled**: CSS `position:absolute`, `window` keydown/pointerdown, `setTimeout(0)` focus (`:58–69`) | **Retire → new `Menu`** (§8) |
| 8 | **Mobile nav menu** | `Topbar.tsx:172–178` | `.topbar__mobile-menu` `app.css:67`, `:617`, `:858–861` | same hand-rolled pattern (`:34–50`) | **Retire → new `Menu`** (§8) |
| 9 | **Lightbox `.viewer`** | `Lightbox.tsx:484` | `app.css:329–342` | own | out of scope |
| 10 | **Collaboration overlay** | `ProjectCollaborationPanel.tsx:93` | `app.css:1159–1161` | own, deliberately non-modal | out of scope |
| 11 | **`Select` popup** (TB8-01) | `ui/select.tsx:59–94` | Tailwind, no CSS block | `@base-ui/react/select` — Portal + Positioner | **Converged already; one z-order fix** (§9.2) |

**Reach.** The dialog primitive is the widest-used single UI contract in the app: `confirm()` alone
has **20 call sites across 10 files** (`EditProject`, `Admin`, `CollectionPanel`,
`ProjectDeadlineControl`, `SubtaskChecklist`, `ProjectDiscussionThread`, `ProductionCalendar`,
`ProjectTeamControl`, `PhotoGrid`, `Lightbox`). That is the reuse argument for ranking this second,
stated as a number.

### 1.2 What the survey proves — cross-cutting defects

These recur across implementations. They are the plan's actual subject; the per-pattern sections
below are how each gets fixed.

**A. Four scrims, four different raw literals, zero tokens.**

| Scrim | Value | Source |
| --- | --- | --- |
| `.scrim` | `rgba(10,10,10,.5)` + `blur(3px)` | `app.css:764` |
| `.rich-text__link-backdrop` | `rgba(10,10,10,.5)` + `blur(3px)` — *byte-identical duplicate* | `app.css:528` |
| `.admin-modal` | `rgba(10, 10, 10, .48)`, no blur | `app.css:1078` |
| `.viewer__panel-scrim` | `rgba(10,10,10,.52)` + `blur(2px)` | `app.css:843` (out of scope) |

`rgba(10,10,10,…)` is `--ink-900` written as a literal. Three near-identical values that should be
one token; two of them differ by 2% for no reason anyone can name.

**B. `--shadow-lg` is the system's *dialog* elevation and four non-dialogs use it.**
`spacing.css:39–41` grades the three shadows, and the design-system readme reserves shadow for
*"true overlays (dialogs, menus)"*. Today: `.modal` `--shadow-lg` (correct), but
`.topbar__notification-menu` (`:74`), `.project-team-picker` (`:266`), `.kanban-move-popover`
(`:583`) and `.subtask-popover` (`:1232`) all take `--shadow-lg` too — an anchored popover
presenting itself at the same elevation as a modal dialog. Worse, two overlays invent their own
shadow entirely rather than use any token:

```css
.rich-text__link-dialog { box-shadow: 0 10px 26px color-mix(in srgb, var(--ink-900) 15%, transparent); }  /* app.css:529 */
.mention-autocomplete   { box-shadow: 0 8px 20px  color-mix(in srgb, var(--ink-900) 13%, transparent); }  /* app.css:537 */
```

**C. Highlight and hover are the same paint, everywhere.** Four option lists set `:hover` and
their *keyboard-active* state to the identical `--paper-100`:

| Selector | Rule |
| --- | --- |
| `.project-team-picker__option:hover, …[aria-current="true"]` | `app.css:270` |
| `.kanban-move-popover__option:hover, …[aria-selected="true"]` | `app.css:587` |
| `.mention-autocomplete__option.is-active, …:hover` | `app.css:540` |
| `.topbar__notification-row:hover, ….is-unread` | `app.css:78` — hover collides with *unread*, a data state |

A keyboard user cannot see which option Enter will commit while the pointer rests on a different
one, and on the notification menu hovering a read row makes it look unread. This is the single most
consequential comprehension defect the survey found and §10.3 fixes it once for every list.

**D. No exit motion anywhere; entrance motion on exactly one overlay.** `.scrim` fades
(`animation: fade var(--dur-base) var(--ease-standard)`, `app.css:764`, keyframe `:827`) and
`.modal` pops (`app.css:765`, keyframe `:828`). Every other overlay in the inventory appears and
disappears instantaneously, and *all eleven* disappear instantaneously — nothing in the app has an
exit transition, because every one of them unmounts on a boolean.

`@keyframes pop` (`app.css:828`) is `translateY(10px) scale(.98)`. The readme's motion rule is
*"Fades and small translates only — no bounce, no spin"*, and its press rule is *"a 1px downward
nudge on buttons; no scaling"*. The `scale(.98)` is the one place the app scales anything, and at
`--dur-slow` (420ms) it is also the slowest motion in the product. §10.4 replaces it.

**E. The dialog does not lock background scroll and measures itself in `vh`.**
`Modal.tsx` renders `FloatingPortal` + `FloatingFocusManager` but no `FloatingOverlay`, and a
repo-wide grep finds **no scroll lock of any kind** (`FloatingOverlay`, `lockScroll`,
`document.body.style` — zero hits outside tests). Behind an open modal the page scrolls freely on
wheel and touch. Separately `.modal { max-height: min(100%, calc(100vh - 48px)) }` (`app.css:771`)
uses `vh`, which on iOS Safari is the *large* viewport — with the URL bar visible the dialog's
computed max-height exceeds the visual viewport and its footer buttons sit below the fold. Both are
390×844 defects.

**F. `.scrim`'s dismissal closes on a stray `click`, not a contained press.**
`Modal.tsx:30` is `<div className="scrim" onClick={onClose}>`. A `click` fires when press and
release share a common ancestor — so selecting text inside the dialog and releasing past its edge
dismisses the dialog and discards the input. The Calendar Move dialog has two text inputs and a
radio group; this is a real data-loss path, not a nit.

**G. Two dialogs have no Escape, no outside-dismiss, and no focus management at all.**
`.admin-modal` (`Admin.tsx:465`) is a bare `<div role="dialog" aria-modal="true">` whose only exit
is a Close button — no trap, so Tab walks straight out into the page behind it, which
`aria-modal="true"` has told assistive tech is not there. `.rich-text__link-modal` traps focus by
hand (`RichTextEditor.tsx:330–338`) and its backdrop calls `preventDefault()` on `mousedown`
without closing (`:371`), so clicking outside does nothing at all.

**H. Z-order is an undocumented, partly-broken ad-hoc scale.** Live values:

| Layer | z-index | Source |
| --- | --- | --- |
| `.admin-modal` | **30** | `app.css:1078` |
| `Select` popup | **20** | `ui/select.tsx:61` (`z-20`) |
| `.topbar__notification-menu` | 60 | `app.css:74` |
| `.topbar` | 75 | `app.css:46` |
| `.impersonation-banner` | 76 | `app.css:35` |
| `.project-team-picker`, `.kanban-move-popover`, `.subtask-popover`, `.scrim` | **90 — all four tied** | `:266`, `:583`, `:1232`, `:764` |
| `.rich-text__link-modal` | **100** | `app.css:527` |

Three consequences, all real: (i) the Admin payload dialog at 30 renders **beneath the sticky top
bar at 75** — its scrim does not cover the bar and the bar stays clickable; (ii) `Select`'s popup at
20 is below both the top bar and every dialog, so the moment a `Select` is placed inside a dialog —
which this plan's own form work in later candidates will do — its popup renders *underneath* the
dialog; (iii) `.scrim` ties with the three popovers at 90, so whether the confirm dialog paints over
the popover that launched it is decided by DOM order alone. That last one is currently *working*
by accident: the confirm host is mounted at `main.tsx:16`, late in the tree.

**I. Faux-bold sans.** `styles/fonts.css:9–14` ships **exactly one Apfel Grotezk face, weight 400**
(`font-family` at `:10`, `font-weight: 400` at `:12`).

> **Cite `styles/fonts.css`, not `tokens/fonts.css`.** There are two files by that name and an
> earlier revision cited the wrong one. `index.css:9` imports `./fonts.css`;
> **`tokens/fonts.css` is imported by nothing** — grep-verified — so it is a dead duplicate whose
> line numbers describe styles nobody loads. The faux-bold finding itself is unaffected: the
> *loaded* file has exactly one Apfel face at 400. The dead file is recorded in §11.2.
`typography.css:46–47` defines `--weight-regular: 400` / `--weight-bold: 700`, but only Messapia and
Athelas ship a 700 file. Every `font-weight: 500` and every `<strong>` on sans text inside an
overlay therefore renders as a browser-synthesised faux-bold: `.topbar__notification-item strong`
(`app.css:80`, an invented 500 — already logged in TB8-01 §11.1),
`.project-team-picker__option strong` (`:274`, the same invented 500), and the `<strong>` elements
in `ProjectTeamControl.tsx:91`, `MentionAutocomplete`'s option labels, and
`RichTextEditor.tsx:373`'s dialog title.

**J. Off-scale type and off-grid spacing throughout the overlay family.**
`.modal__head h3 { font-size: 30px }` (`app.css:768`) — no such step exists (`--text-xl` 28,
`--text-2xl` 36). `.project-team-picker > input { margin: 8px; padding: 9px 10px }` (`:267`);
`.project-team-picker__option { padding: 8px }`, `strong` 12px, `small` 10px (`:269,274,275`);
`.kanban-move-popover__option { padding: 7px 8px; font-size: 12px }` (`:586`);
`.subtask-popover__content label { font-size: 10px }` (`:1234`);
`.mention-autocomplete__option { padding: 7px 8px }`, `__status` 13px (`:539,542`);
`.rich-text__link-dialog { padding: 12px; gap: 10px }`, `input { padding: 7px 8px }`,
head `button { font-size: 18px }` (`:529,532,534`); `.topbar__notification-*` 13px/12px/10px and
`padding: 13px 14px` (`:75,79,80,81,82`).

**K. Touch targets.** `.project-team-picker__option` is the *only* overlay option in the app with
`min-height: 44px` (`app.css:269`). The Calendar dialogs get 44px through a variant override
(`production-calendar.css:237,246`) that no other dialog receives. Everything else —
`.kanban-move-popover__option` at 32px (`:586`), `.subtask-popover__actions .button` at 30px
(`:1244`), `.kanban-move-popover__actions .button` at 30px (`:589`),
`.topbar__notification-dismiss` at 34px (`:83`), `.topbar__notification-trigger` at 34×34
(`:70`) — is below the 44px touch-target convention this plan applies (WCAG 2.5.5 Enhanced / HIG;
see §6.3's attribution note).

**L. No `role="menu"` menu has arrow-key navigation.** `Topbar.tsx:150,172` declare `role="menu"`
with `role="menuitem"` children. The WAI-ARIA menu pattern requires Up/Down to move between items
with a roving tabindex; both menus implement Escape and outside-click only, so Tab is the sole
means of traversal — a `role` that promises AT users a keyboard contract the widget does not honour.

**M. Dead and duplicated selectors.** `.sr-only` is declared twice, identically, at `app.css:1017`
and `app.css:1127`.

### 1.3 Evidenced vs latent — the honesty split

Following TB8-01 §5's discipline. **Evidenced** — reproducible today by opening the UI:
A, B, C, D, F, G, H(i), H(ii), I, J, K, L, M. **Latent** — read from source, fixed here, but not
demonstrated by a capture: E's iOS `vh` overflow (needs a real iOS Safari, not the 390×844 emulation
— the scroll-lock half of E *is* evidenced), and one further item worth recording because a future
reader will otherwise assume it is live:

> `ProjectTeamControl`'s outside-click handler (`ProjectTeamControl.tsx:56–65`) does **not** exempt
> `[data-confirm-modal-root]`, the exemption `AnchoredPopover.tsx:27` carries deliberately. If a
> `confirm()` were ever raised from inside the picker, clicking the confirm dialog would close the
> picker underneath it. It is **latent, not live**: the component's only `confirm()`
> (`ProjectTeamControl.tsx:163`) fires from the member-chip remove flow, outside the picker. §7.4's
> migration removes the divergence by deleting the duplicate handler.

---

## 2. The convergence decision

The roadmap requires *one styling/data owner*, forbids a *whole-app rewrite*, and says
**"specialized CSS remains where evidence shows it is clearer."** The call, pattern by pattern:

| Pattern | Decision | Evidence |
| --- | --- | --- |
| `Modal` (#1) | **Keep and deepen.** Same public props, same consumers, internals fixed. | 4 consumers + 20 `confirm()` sites already route through one 43-line component with a clean prop API. The seam exists; only the internals are wrong (E, F). |
| `.admin-modal` (#2) | **Retire → `Modal`.** Delete the CSS block. | It is one JSX line reimplementing a dialog with *none* of the behavior (G), at a broken z-layer (H-i). Zero unique requirement — a title, a body, a Close button. Retiring a legacy owner is an explicit roadmap selection criterion. |
| `.rich-text__link-modal` (#3) | **Retire → `Modal`.** Delete the CSS block; keep the URL-validation logic untouched. | A hand-written focus trap (`:330–338`) duplicating what `FloatingFocusManager` already does correctly for four other dialogs, plus a backdrop that does not dismiss (G) and a byte-identical duplicate scrim (A). |
| `AnchoredPopover` (#4) | **Keep and deepen.** | Purpose-built, correct, and carries the TB0 synchronous-focus fix (§7.2). Its two CSS skins are consumer paint, not engine. |
| `.project-team-picker` (#5) | **Retire the *engine* → `AnchoredPopover`; keep the *skin* as scoped CSS.** | Its floating setup is a near-line-for-line duplicate of `useAnchoredPopover` (same middleware need, same outside-close, same Escape-plus-focus-return), with two divergences that are both bugs — the missing confirm exemption (§1.3) and `returnFocus={triggerRef}` where the shared contract mandates `returnFocus={false}` plus explicit Escape restoration (`Checklist-Popovers-And-Drag-Reorder-Plan.md:110–113`). Its *search-plus-listbox* composition, however, is genuinely specialized and no other popover needs it — that stays. |
| `MentionAutocomplete` (#6) | **Preserve wholesale; paint only.** | It is not a positioned overlay: it renders statically in the composer's flow (`RichTextEditor.tsx:380`) with no `position` rule in `app.css:537`. Its keyboard contract is an imperative handle driven by TipTap's suggestion plugin (`MentionAutocomplete.tsx:29–38`), and `docs/lessons.md:833` records that TipTap native-listener/event-timing changes are a repeat source of regressions. Converting it would buy nothing and risk the mention flow. **This is the roadmap's "specialized CSS remains where evidence shows it is clearer" clause being used, with evidence.** |
| Topbar menus (#7, #8) | **Retire the engine → a new shared `Menu` primitive** (§8). | The app's only two `role="menu"` widgets, both declaring a keyboard contract they do not honour (defect L), both still carrying the `setTimeout(0)` focus-restoration shape the TB0 fix removed from `AnchoredPopover`. Owner-confirmed in full scope 2026-09-01 (§13 Q1). |
| `Select` (#11) | **Preserve; one-line z-order fix.** | TB8-01 authority. Only H-ii touches it. |

**Net: eleven implementations become three owned primitives** — `Modal` and `AnchoredPopover` on
`@floating-ui/react`, `Menu` on `@base-ui/react` (§2.1) — plus **one preserved specialist**
(`MentionAutocomplete`), **one already-converged primitive** (`Select`), and **two deferred
out-of-scope surfaces** (Lightbox, Collaboration).

### 2.1 Dependency decision — no new dependency; engine chosen per primitive, on its own merits

**No new runtime dependency is introduced.** Both engines are already installed and already have
live consumers: `@floating-ui/react@0.27.16` (`Modal`, `AnchoredPopover` ×4, `ProjectTeamControl`)
and `@base-ui/react@1.7.0` (TB8-01's `Select`). The question is not *which one library* but *which
engine each primitive should own*, and the honest answer differs by primitive.

**`Modal` and `AnchoredPopover` stay on `@floating-ui/react`.** Not because Base UI is unsuitable in
general, but because of one concrete, tested interlock: `AnchoredPopover.tsx:27` exempts
`[data-confirm-modal-root]` from its outside-dismiss boundary so a `confirm()` raised from *inside*
a checklist popover does not dismiss the popover under it (shipped by `f2d3700`, asserted by
`ConfirmDialog.dom.test.tsx:52` and by this plan's criterion 6). That interlock spans the popover
and the dialog, so **those two primitives must share one dismiss engine** or the exemption has to be
reimplemented across a library boundary for no gain. Both also already work; the defects in §1.2 are
in their *configuration* (no `FloatingOverlay`, no transition status), not their engine.

**`Menu` (§8) goes on `@base-ui/react`, and the interlock argument deliberately does not transfer.**
Sol's plan review correctly flagged that reusing it here would be reasoning by association: the two
Topbar menus raise no `confirm()`, sit inside no `AnchoredPopover`, and touch nothing the exemption
protects. Judged on its own terms, Base UI wins on three counts:

1. **It ships the contract complete.** §8.1's eight-row keyboard table — open-on-click, ArrowDown/Up
   from the trigger, wrap-around navigation, Home/End, typeahead, Escape-with-focus-return,
   Tab-to-close, outside-dismiss — is what `Menu.Root` provides. On floating-ui the same contract is
   hand-assembled from `useClick` + `useDismiss` + `useRole` + `useListNavigation` + `useTypeahead` +
   `useInteractions` + `FloatingList` + `useListItem`, with the active-index state, item
   registration and prop merging owned by us. Hand-assembling a contract the dependency ships
   complete is precisely what TB8-01 §2.2 refused to do for `Select` ("no separate hand-rolled
   listbox"), and the same reasoning applies to the only two `role="menu"` widgets in the app.
2. **`Menu.LinkItem` exists and is exactly what the notification menu needs.** Verified present at
   `node_modules/@base-ui/react/menu/link-item`. The notification menu's rows are real navigations
   (`InternalLink role="menuitem"`, `Topbar.tsx:154`); a menu item that must stay an `<a href>` is a
   first-class part here, where on floating-ui it is another manual composition. This is the same
   anchor-safety concern TB8-01 §2.1 solved with `buttonClasses()` — solved for us this time.
3. **They already coexist, by the dependency's own design.** Base UI vendors floating-ui internally
   (`node_modules/@base-ui/react/floating-ui-react`), and TB8-01's `Select` has shipped alongside
   `AnchoredPopover` in production since 2026-09-01 with no interaction. "Two focus managers in one
   app" is the status quo, not a new risk this release introduces.

**Consequence for the acceptance criteria:** the earlier claim that "`@base-ui/react` gains no new
consumer" is **withdrawn** — `ui/menu.tsx` is a second Base UI consumer, deliberately. Criterion 12
now verifies the accurate thing: no *new dependency* in either `package.json`, and no `cva`.

Everything else this plan needs is in the installed floating-ui:

| Need | Already available |
| --- | --- |
| Background scroll lock (defect E) | `FloatingOverlay` with `lockScroll` |
| Exit motion (defect D) | `useTransitionStatus` — §6.4 |
| Collision-aware anchoring | `offset`/`flip`/`shift` — already used, `AnchoredPopover.tsx:17` |
| Modal focus trap + restore | `FloatingFocusManager` — already used, `Modal.tsx:29` |

---

## 3. Design direction

The system is authoritative and this plan does not reinvent it. The organising idea for this
surface, derived from the readme's own elevation sentence — *"Borders over shadow: elevation is
almost never used. Shadows are whisper-quiet and reserved for true overlays (dialogs, menus)"* —
is that **overlays are the one place in Quincy where elevation is allowed to speak, so it must say
exactly one thing: how far this surface is from the page.** Today it says four contradictory things
(defect B).

Three moves:

1. **A three-step elevation ladder, and nothing else.** Anchored to a trigger →
   `--shadow-md`. Detached over the whole page → `--shadow-lg` **plus** a scrim. Nothing on this
   surface gets `--shadow-sm` or a shadow it invented. One rule, stated in §10.1, applied to all
   eight overlays.
2. **The hairline is the boundary; the shadow only separates.** Every overlay keeps its 1px greige
   hairline and square corners (`--radius-card: 0`) — the shadow is depth, the border is the edge.
   This is why the two invented `color-mix` shadows go: they were being asked to do the border's job.
3. **Highlight is ink, hover is paper.** The system already grades these — *"Hover: surfaces tint up
   one paper step"* — but has no stated device for keyboard highlight, which is why every list
   collapsed the two (defect C). The device: hover keeps `--paper-100`; the **active/highlighted**
   option additionally takes a **2px ink leading rule** (`--border-width-bold`, `--border-strong`)
   down its inline-start edge. Structural, not chromatic, so it survives the hover tint underneath
   it and does not rely on colour alone (WCAG 1.4.1). It is the same "a rule marks the current
   thing" vocabulary TB8-01 established for the Notice Board unread state, one step lighter.

No new colour. No gradient. No shadow on a non-overlay. No motion outside 120–420ms. No scale.

---

## 4. Foundation, tokens and the z-order contract

### 4.1 Reused verbatim from TB8-01

§1.1's semantic-utility table, §1.2's arbitrary-value convention, §1.3's directional-border form,
§1.4's seven added roles and its **hard non-goal** (never map `--spacing-*`, `--text-*`,
`--radius-*`, `--shadow-*`, `--tracking-*`, `--leading-*`, `--font-*`, `--ease-*` into `@theme`; no
bare Tailwind spacing/sizing utility anywhere on this surface), and §1.5's grep-before-delete rule.
All still in force. `bg-popover` (→ `--bg-surface` → `--paper-000`) is the correct role for every
overlay panel here and already exists (`tokens/tailwind.css:6,27`).

The `!`-prefix lesson recorded in `ui/button.tsx:7–18` also applies: `base.css` has an unlayered
`a { color: inherit }`, `app.css` is imported unlayered (`index.css:10`), and unlayered author CSS
outranks Tailwind's `@layer utilities` regardless of specificity. Any overlay class that must beat
a surviving `app.css` rule needs `!`, and the builder must not assume source order helps.

### 4.2 New tokens — the scrim, and the z ladder

Two additions to `tokens/colors.css`, in the semantic-alias block (`colors.css:33` onward), each
naming an *existing live value* rather than inventing one:

```css
  /* ---- TB8-02 overlay roles ---- */
  /* The wash behind a detached overlay. Was four raw rgba() literals differing by 2%
     (app.css:764, :528, :1078, :843) — one token, one value. */
  --scrim-overlay: color-mix(in srgb, var(--ink-900) 50%, transparent);
```

`50%` is the value `.scrim` and `.rich-text__link-backdrop` already use; `.admin-modal`'s `.48`
converges up to it. `color-mix` on `--ink-900` rather than `rgba(10,10,10,.5)` so it tracks the ink
token — the same form `app.css` already uses in five places.

And a z-order ladder in `tokens/spacing.css`, in the Layout block (`spacing.css:51`):

```css
  /* ---- Overlay stacking — see TB8-02 §4.2 for which of these are traced and which are new ---- */
  --z-popover:  90;   /* TRACED: already live on .subtask-popover / .kanban-move-popover /
                         .project-team-picker (app.css:1232, :583, :266) */
  --z-dialog:   95;   /* NEW: dialogs move up from 90 so they deterministically clear a popover */
  --z-toast:    98;   /* NEW: derived — the next step above --z-dialog, so a toast still shows
                         over an open dialog (.toasts moves 95 → 98, app.css:781) */
```

**Honesty about what this does, corrected.** An earlier revision claimed the whole family
"codifies, it does not invent". Sol's plan review showed that is true of only one of the three, and
the accurate split matters because TB8-01 §1.4's discipline is precisely *"New values are not
invented; the plan cites the existing token"*:

| Token | Status | Basis |
| --- | --- | --- |
| `--z-popover: 90` | **Traced codification.** | 90 is verbatim the live value of three selectors (`app.css:266`, `:583`, `:1232`). Nothing moves; the number is lifted into a name. |
| `--z-dialog: 95` | **New, owner-approved.** | Dialogs are at **90** today, tied with the three popovers, which is defect H-iii — whether a confirm paints over the popover that launched it is decided by DOM order. 95 is chosen as the smallest increment that breaks the tie deterministically while staying below the toast layer. `95` does appear live in `app.css:781`, but on `.toasts`, not on any dialog — so citing it as "the existing dialog value" would be false. |
| `--z-toast: 98` | **New, derived, no live antecedent.** | No selector in the app uses 98. It is chosen as the next clear step above `--z-dialog` so a toast still reaches the user over an open dialog — preserving the *relationship* `.toasts` had when it sat at 95 above the 90 dialog, which the dialog's move to 95 would otherwise invert. |

The owner approved creating this family (§13 Q3), so the two new values need no further sign-off —
but they are **new intentional assignments with stated reasoning**, not traced values, and the plan
says so rather than overclaiming. Toasts moving 95 → 98 remains the one out-of-scope selector this
plan touches: one declaration, no paint change (§11.1).

### 4.2a Nested overlays — the z ladder is a *page-level* contract, and it is not enough

**This is a second correction, and the first one was wrong.** Revision 2 identified the gap
correctly — `--z-popover` (90) sits **below** `--z-dialog` (95), so a `Select` or popover opened
from inside a dialog renders underneath it, contradicting §5 row 16 — but the mechanism it
prescribed does not fix it. The fresh-Opus gate review blocked the plan on exactly this, and it was
right. What follows is the corrected mechanism, verified against the installed packages.

#### Why the previous mechanism failed

Revision 2 said the container should be *"the node its own `FloatingPortal` created."* Against the
structure §6.1 builds, that node is the **parent** of the dialog, not a descendant of it:

```
FloatingPortal node          ← revision 2's container
└── div[data-confirm-modal-root]
    └── FloatingOverlay      ← position:fixed + z-95  ⇒ CREATES A STACKING CONTEXT
        └── FloatingFocusManager
            └── div.modal    ← the panel; the focus trap's child
```

- **Stacking.** A popup portaled into the `FloatingPortal` node is the `FloatingOverlay`'s
  **sibling**. Sibling at z 90 vs. sibling at z 95 → the popup paints *under* the dialog. Document
  order never enters, because they are not ancestor/descendant. Dropping the z class does not help:
  a `z-auto` positioned element still paints below a positive integer.
- **Focus.** `FloatingFocusManager`'s trap covers its child — the panel. A sibling of
  `[data-confirm-modal-root]` is outside the trap entirely.

Both failures have the same root cause: **the container was outside the dialog's box, when it needed
to be inside it.**

#### The corrected mechanism

**Rule: a nested overlay portals into a dedicated, non-scrolling slot rendered inside the dialog
panel, and positions itself with `positionMethod="fixed"`.**

```
FloatingOverlay              ← position:fixed, z-95, backdrop-blur  (stacking context)
└── FloatingFocusManager
    └── div.modal            ← panel: border/bg/shadow/max-h + motion.  NO overflow  ← CHANGED
        ├── div.modal__scroll   ← overflow-auto lives HERE now, holds head/body/foot
        └── div ref={slot}      ← the nested-overlay container. Empty, zero-height,
                                   no overflow, no transform of its own.
```

`Modal` provides `slot` through `OverlayContainerContext`; `AnchoredPopover`, `Menu` and `Select`
consume it. At page level the context is `null` → `document.body` and today's behavior.

```tsx
const container = React.useContext(OverlayContainerContext);   // HTMLElement | null
// floating-ui:  <FloatingPortal root={container}>
// Base UI:      <Select.Portal container={container}>  /  <Menu.Portal container={container}>
//               <Select.Positioner positionMethod={container ? "fixed" : "absolute"} …>
```

**Walking the stacking logic, explicitly:**

1. The slot is a **descendant of the panel**, which is a descendant of the `FloatingOverlay`. The
   overlay's `position: fixed` + `z-index: 95` makes it a stacking context; **everything inside it,
   including the popup, is painted within that context.** The popup no longer competes with the
   dialog at all — it competes with the dialog's *own children*, where it wins on document order
   (the slot is the panel's last child) and on being positioned.
2. `z-[var(--z-popover)]` on a nested positioner is now genuinely a local sibling hint inside that
   context, which is what revision 2 claimed it was but wasn't.
3. **Focus:** the slot is inside `FloatingFocusManager`'s child subtree, so the popup is inside the
   trap. Tab cycles trigger → popup → back, and never reaches the page behind. This is the half
   revision 2 called "required for focus correctness" and did not deliver.
4. **The opposite nesting still works.** `ConfirmModalHost` is mounted at `main.tsx:16`, outside
   every popover, so its context is `null`, it portals to `<body>`, and the page-level ladder puts
   it at 95 over a checklist popover's 90 — §5 row 3, unchanged.

**Why `positionMethod="fixed"`, and what it escapes.** Base UI defaults to
`positionMethod: 'absolute'` (`internals/useAnchorPositioning.d.mts`), and an absolutely-positioned
popup is clipped by any `overflow` ancestor. There are two:

| Box | `overflow` | Can a class override it? |
| --- | --- | --- |
| `FloatingOverlay` | `auto`, set as an **inline style** (`floating-ui.react.mjs:2245`) | **No.** Only the `style` prop can, and `...rest.style` spreads last — but overriding it would defeat `lockScroll` for a taller-than-viewport dialog. Leave it. |
| the panel | `overflow-auto` from §6.3 | Yes — and §6.3 now moves it to `.modal__scroll` so the slot is not inside it. |

With the slot outside `.modal__scroll`, only the overlay remains, and `position: fixed` resolves
against the nearest ancestor that establishes a containing block for fixed descendants rather than
against that scroll box. **That ancestor is the panel**, because §6.3 gives it a `translate`
(non-`none` `translate`/`transform`/`filter` all establish one). The panel has **no** `overflow`
after this change, and floating-ui computes `fixed` coordinates against a transformed offset parent
correctly: for a `fixed` floating element `getTrueOffsetParent` returns `null`, so `getOffsetParent`
falls through to `getContainingBlock`, whose `isContainingBlock` test explicitly includes
`translate` as well as `transform`/`filter` (`@floating-ui/utils`, verified in the installed copy).

**Precision, because the second gate corrected it:** the overlay does *not* stop clipping. A box
with `overflow: auto` clips any descendant whose containing block is itself or a descendant of it,
and the panel is a descendant of the overlay — so the popup is still clipped **by the overlay**.
That is harmless, and it is why this works: the overlay is `inset: 0` with no border, so its clip
rect **is the viewport**, which is exactly where `collisionPadding={8}` already keeps the popup.
What the `.modal__scroll` split removes is the clipper that *would* have cut the popup off — the
panel's own 460×(dialog-height) scroll box. Read the two boxes that way: the panel's overflow had
to go; the overlay's is a viewport-shaped no-op.

**Three interactions checked, not assumed:**

- **`alignItemWithTrigger`** defaults to **`true`** on `Select.Positioner`
  (`select/positioner/SelectPositioner.d.mts`) — it overlaps the trigger to align the selected
  item's text, measuring available space to do so. Inside a height-constrained dialog that
  measurement is against the wrong box. **Nested positioners set `alignItemWithTrigger={false}`**,
  giving a plain below-trigger dropdown. Page-level `Select` keeps the default, so TB8-01's shipped
  appearance is untouched.
- **`collisionPadding={8}`** is kept. Under `positionMethod="fixed"` the collision boundary is the
  viewport's clipping ancestors, which is the right boundary — the popup should stay on screen, not
  inside the dialog.
- **Overlay scrolling.** When a dialog is taller than the viewport the overlay scrolls, moving the
  panel and therefore the popup's containing block. Base UI's positioner tracks this the same way it
  tracks any scroll (`autoUpdate`), so the popup follows its trigger. **Criterion 23(d) verifies it
  rather than trusting it.**

**Pre-authorised fallback, if verification fails on the transform interaction.** The single
assumption carrying the most weight above is that a `translate`d panel is a well-behaved containing
block for a `fixed` popup. If the real browser disagrees, **drop the panel's translate and make the
dialog's motion opacity-only** (`--overlay-enter`/`--overlay-exit` on opacity alone), and every
other part of this mechanism is unchanged. A fade-only dialog remains inside the design system —
*"fades and small translates only"* permits a fade — and the scrim's own fade still carries the
entrance. The builder takes this fallback without escalating; it is a two-class change.

**What the fallback actually moves, stated precisely** (the second gate corrected an over-claim
here — an earlier revision said "no ancestor then establishes a containing block, `fixed` resolves
against the viewport"). §6.2 puts `backdrop-blur-[3px]` on the overlay, and a non-`none`
`backdrop-filter` **is itself a containing block for fixed descendants** on non-WebKit engines —
floating-ui's `isContainingBlock` mirrors exactly that engine split (`backdropFilter`/`filter` are
tested only when `!isWebKit()`), so library and browser agree either way. So the fallback moves the
containing block from the panel to **the overlay** on Chrome, and to the viewport on Safari. Both
are viewport-shaped and coordinates come out the same. The one difference worth knowing: the
overlay's box does not move when its content scrolls, so under the fallback a tall-dialog scroll
tracks the trigger through `autoUpdate`'s recomputation rather than natively. **If the fallback is
taken, re-run criterion 23(d) rather than assuming it still passes** — it is the one criterion the
fallback can affect.

**Scope note.** No in-scope popover currently contains a `Select` or `Menu` (the team picker holds a
search input, the checklist popovers hold inputs and buttons, Kanban Move holds buttons), so
popover-inside-popover nesting is not exercised by this release. The context mechanism generalises
to it, but only the dialog case is verified here — §11.2 records that for whoever needs it first.

**Which primitives wire the context, and which one exercises it.** `Modal` *provides*
`OverlayContainerContext`; all three portaling primitives *read* it, so the next candidate inherits
the fix rather than rediscovering it. Only `Select` has a nesting case in this release:
`Select` (§9.2, the wiring shown in full),
`AnchoredPopover` (§7.2 addition 4), `Menu` (§8.1's composition note). For `AnchoredPopover` and
`Menu` the context is `null` at every call site that exists today, so both compile to today's
behavior exactly; criterion 23 exercises `Select` only.

### 4.3 Named motion presets

No new duration or easing values; the two overlay motions get named so all eight sites cite one
thing. Added to `tokens/spacing.css` beneath the Motion block:

```css
  /* Overlay entrance/exit. Fades and small translates only, per the design-system
     readme; --dur-base in, --dur-fast out (an exit must never outlast the intent). */
  --overlay-enter: var(--dur-base) var(--ease-entrance);
  --overlay-exit:  var(--dur-fast) var(--ease-exit);
```

`--ease-exit` (`spacing.css:46`) is currently **unused anywhere in the app** — grep-verified. This
is the first consumer, and it is the correct one: an accelerating curve on the way out.

---

## 5. Viewport, state and evidence matrix

Fixed viewports per TB1/TB8-01: **1440×900**, **1024×768**, **390×844**. Because the overlays are
scattered across screens, evidence is captured per overlay at its own route, matched pairs before
and after.

| # | Overlay | State | 1440 | 1024 | 390 |
| --- | --- | --- | --- | --- | --- |
| 1 | Confirm dialog (non-danger) | open, resting | ✓ | ✓ | ✓ |
| 2 | Confirm dialog (`danger: true`) | open, Confirm focused | ✓ | — | ✓ |
| 3 | Confirm dialog | raised **from inside** a checklist popover — both visible, correct stacking | ✓ | — | ✓ |
| 4 | Calendar Move dialog | open, with fold radio group | ✓ | ✓ | ✓ |
| 5 | Calendar Schedule editor | open, long body — internal scroll, footer pinned | ✓ | — | ✓ |
| 6 | Admin payload dialog | open over the sticky top bar — **scrim must cover the bar** | ✓ | — | ✓ |
| 7 | RTE link dialog | Add-link, and Edit-link with `role="alert"` error | ✓ | — | ✓ |
| 8 | Checklist assignee popover | open, one option pointer-hovered, a *different* one keyboard-highlighted | ✓ | ✓ | ✓ |
| 9 | Checklist schedule + actions popovers | open | ✓ | — | ✓ |
| 10 | Kanban "Move to…" | both steps (`data-step="stage"` / `"position"`) | ✓ | — | ✓ |
| 11 | Team picker | open; empty result; one option `disabled` (pending) | ✓ | ✓ | ✓ |
| 12 | Mention autocomplete | idle w/ results, loading, error, empty | ✓ | — | ✓ |
| 13 | Every overlay | keyboard focus ring on every control (criterion 3) | ✓ | — | ✓ |
| 14 | Every overlay | `prefers-reduced-motion: reduce` — entrance and exit both suppressed | ✓ | — | — |
| 15 | Topbar menus (§8) | notification menu populated/empty; mobile menu | ✓ | — | ✓ |
| 16 | Dialog + `Select` | a `Select` opened *inside* a dialog — popup over, not under | ✓ | — | ✓ |

**TB1/TB8-01-inherited evidence**, unchanged: `tailwindcss/preflight.css` still absent from built
CSS; before/after CSS-size record; TB1's live `ProjectFields` Client section and TB8-01's Dashboard
shell both render byte-identically at all three viewports.

---

## 6. `Modal` — the dialog primitive

`components/Modal.tsx`. Every existing prop — `title`, `eyebrow`, `children`, `footer`, `onClose`,
`wide`, `testId`, `variant`, `initialFocus` — keeps its exact meaning. Four props are added
(`open`, `size`, `describedBy`, `returnFocus`); `size`, `describedBy` and `returnFocus` are optional
with today's behavior as the default. **`open` is not optional, and it changes how every consumer
mounts the component — §6.0.**

### 6.0 Lifecycle: who keeps the dialog mounted while it closes

**This is a correction.** An earlier revision of this plan claimed `useTransitionStatus` would supply
exit motion while the public lifecycle stayed unchanged. That is unbuildable, and Sol's plan review
was right to block it: `Modal.tsx:18` calls `useFloating({ open: true })` — hard-coded — while every
consumer unmounts the component the instant its condition flips (`{payload && …}` `Admin.tsx:465`,
`{linkOpen && …}` `RichTextEditor.tsx:370`, and `ConfirmModalHost` returning `null` when the queue
empties, `ConfirmDialog.tsx:22`). The hook can never observe `open === false`, because by then the
component that owns the hook has already been destroyed. **No exit frame can render.** Entrance
motion works today only because mounting *is* the entrance trigger.

Exit motion therefore requires one thing, and there is no way around it: **the consumer's boolean
must become a prop, not a mount guard.** `Modal` owns the delay; the consumer owns the intent.

```tsx
// Modal.tsx
export function Modal({ open, onClose, /* …everything else unchanged… */ }: ModalProps) {
  const { context, refs } = useFloating({
    open,
    onOpenChange: (next) => { if (!next) onClose(); },
  });
  // Durations are JS numbers here and CSS values in §6.2/§6.3. They MUST stay in sync:
  // 220 === --dur-base, 120 === --dur-fast. See the duplication note below.
  const { isMounted, status } = useTransitionStatus(context, {
    duration: { open: 220, close: 120 },
  });
  if (!isMounted) return null;   // ← the delayed unmount lives here, not in the consumer
  // TransitionStatus is 'unmounted' | 'initial' | 'open' | 'close' (verified in
  // @floating-ui/react 0.27.16 dist types). data-open is set only while status === "open";
  // "initial" is the pre-entrance frame that makes the CSS transition actually run.
  …
}
```

`open` reaches the transition hook through `useFloating`'s own `open` argument — the hook derives
`status`/`isMounted` from that context and nothing else. `isMounted` stays `true` for `close`'s 120ms
after `open` goes false, which is the entire mechanism.

**Known, deliberate duplication.** `{ open: 220, close: 120 }` are JavaScript numbers that must
match `--dur-base` and `--dur-fast` (`spacing.css:47–48`). `useTransitionStatus` cannot read a CSS
custom property, so this is unavoidable; it is **not** licence to invent a third value. Both literals
carry the comment `/* === --dur-base */` and `/* === --dur-fast */` at the call site, and acceptance
criterion 21 asserts they match the tokens.

#### The four consumer edits, enumerated

| Consumer | Was | Becomes |
| --- | --- | --- |
| `ConfirmModalHost` (`ConfirmDialog.tsx:20–24`) | `if (!active) return null;` then `<ConfirmDialog key={active.id} …>` | see below — retention + `key`, spelled out because a promise queue is involved |
| `Admin.tsx:465` | `{payload && <Modal …>}` | `<Modal open={!!payload} …>`, body reads `payload ?? lastPayload.current` — **full snippet in §6.6** |
| `RichTextEditor.tsx:370` | `{linkOpen && <Modal …>}` | `<Modal open={linkOpen} returnFocus={false} …>` — no retention needed; `linkHref`/`linkError`/`linkWasActive`/`linkSelection` all persist in state or refs across the close. **Full snippet in §6.7** |
| Calendar Move / Fold / Schedule | each rendered conditionally by `ProductionCalendar` | see the retention rule below |

**The three Calendar dialogs — retention specified against the real call sites.** An earlier
revision described these from the dialog components' signatures rather than from
`ProductionCalendar.tsx`'s render sites, and got two of the three wrong; the fresh-Opus gate review
caught both. Corrected against live source:

| Dialog | Real state + call site | Retention |
| --- | --- | --- |
| `ProductionCalendarMoveDialog` (`:47`) | state is **`moveDialog`** (`ProductionCalendar.tsx:473`) — not a `moveTarget`, which does not exist. The call site (`:1581`) passes **three** props: `event`, `initialCivil`, `foldChoices`. | Retain the **whole `moveDialog` object** in a ref, not just `event`, and read all three props from the retained value. `open={!!moveDialog}`. |
| `ProductionCalendarFoldChoice` (`:22`) | state is `checklistFold`; call site (`:1583`) passes `endpoint`, `choices`, `eyebrow`. | Retain the whole `checklistFold` object; `open={!!checklistFold}`. |
| `ProductionCalendarScheduleEditor` (`:145`) | call site (`:1582`) **already carries a composite key**: `` key={`${scheduleEditor.source.id}:${JSON.stringify(scheduleEditor.initialSchedule ?? null)}`} `` | Retain the whole `scheduleEditor` object. **Preserve that key expression verbatim** — see below. |

**Do not "simplify" the ScheduleEditor key.** An earlier revision said "`key` on the edited entity's
id," which would have silently broken the validation-retry flow: a retry sets a **new
`initialSchedule` on the same `source`**, and it is precisely the `initialSchedule` half of the
composite key that forces the remount that re-seeds the editor's fields. Narrowing the key to
`source.id` would leave the editor showing the pre-retry values. The existing expression is
deliberate; it is carried across unchanged.

**Re-mount keys for the other two — use an open-token, not a data value.** Today these dialogs
re-seed their `useState` because the parent unmounts them; once the parent stops unmounting, a
`key` must reproduce that. Deriving it from the data is subtly wrong in both directions: too broad
and the Move dialog remounts mid-flow (`ProductionCalendar.tsx:1074,1077,1080` deliberately set a
new `initialCivil`/`foldChoices` on the **same** open dialog for a fold retry, and today that does
*not* re-seed); too narrow and reopening the same event after a close shows stale values. So:

```tsx
// Parent increments once per null → non-null transition. Stable across in-flow updates.
const moveToken = useRef(0);
useEffect(() => { if (moveDialog) moveToken.current += 1; }, [moveDialog !== null]);
// …then key={moveToken.current}
```

This reproduces today's behavior exactly on all three paths: fresh open → new token → re-seed; fold
retry on the open dialog → token unchanged → no re-seed (matching the current no-key behavior);
reopen after close → new token → re-seed.

**The retention `key` must be computed from the retained value, not live state.** The
`ConfirmModalHost` snippet above already does this (`key={shown.id}`); the Calendar sites must too.
Reading `key={moveDialog.event.id}` while `moveDialog` is `null` during the exit would evaluate to
`undefined` and remount the very dialog the retention exists to keep on screen.

**If a Calendar dialog's retention proves awkward**, §6.0's pre-authorised fallback applies to that
dialog alone: pass `open` through but leave the parent's conditional mount in place, which yields
entrance motion and no exit for that one dialog. That is strictly no worse than today.

**`ConfirmModalHost` — spelled out, because a promise queue is involved.** The host must keep
rendering the *last* options for 120ms after the queue empties, or the dialog vanishes instantly and
the exit is exactly as absent as before:

```tsx
export function ConfirmModalHost(): JSX.Element | null {
  const active = useSyncExternalStore(confirmStore.subscribe, confirmStore.getSnapshot, () => null);
  const last = useRef<ActiveConfirm | null>(null);
  if (active) last.current = active;          // retain for the close transition
  const shown = active ?? last.current;
  if (!shown) return null;
  return <ConfirmDialog key={shown.id} open={active !== null} {...shown.options}
                        onConfirm={() => confirmStore.resolve(true)}
                        onCancel={() => confirmStore.resolve(false)} />;
}
```

Two properties this preserves, both load-bearing:

- **The promise still resolves immediately.** `confirmStore.resolve()` is called by the button
  handler, unchanged; only the *visual* unmount is delayed. No caller waits 120ms for its boolean.
- **`key={shown.id}` still forces a fresh dialog per request**, so a queued second `confirm()` cannot
  inherit the first's focus or DOM state. Criterion 14(g) asserts the queue still serialises.

**Risk, stated.** This is the plan's largest behavioral change to a shared component, and it touches
the confirm queue that 20 call sites depend on. It is why criterion 14(g) exists and why criterion 22
requires the four `Modal` consumers' open/close cycles to be tested explicitly rather than assumed.
If the build finds the `ConfirmModalHost` retention fights the queue in a way this plan has not
foreseen, **the correct fallback is to ship dialog entrance motion only** — set
`duration: { open: 220, close: 0 }`, keep every other §6 fix, and record the dialog-exit deferral in
§11. Popover and menu exit motion (§7.2, §8) are independent and unaffected. That fallback is
pre-authorised here so the builder does not have to improvise one.

### 6.1 Structure

```tsx
<FloatingPortal>
  <div data-confirm-modal-root={testId === "confirm-modal" ? "" : undefined}>
    <FloatingOverlay lockScroll className={SCRIM} data-open={status === "open" ? "" : undefined}>
      <FloatingFocusManager context={context} modal returnFocus initialFocus={initialFocus}>
        <div ref={refs.setFloating} className={PANEL} role="dialog" aria-modal="true"
             aria-labelledby={titleId} aria-describedby={describedBy} tabIndex={-1}
             data-testid={testId} data-modal-variant={variant}
             data-open={status === "open" ? "" : undefined}
             onKeyDown={handleKeyDown}>
          <div className={PANEL_SCROLL}>…head / body / foot…</div>
          {/* §4.2a: nested-overlay slot. Outside the scroller, inside the panel and the
              focus trap. Provided to descendants via OverlayContainerContext. */}
          <div ref={setNestedSlot} />
        </div>
      </FloatingFocusManager>
    </FloatingOverlay>
  </div>
</FloatingPortal>
```

Five structural changes, each closing a surveyed defect:

1. **`FloatingOverlay lockScroll`** replaces the plain `<div className="scrim">` — defect E's scroll
   half. `FloatingOverlay` is exported by the installed `@floating-ui/react` and handles the
   scrollbar-width compensation that a naive `body { overflow: hidden }` gets wrong.
2. **`onClick={onClose}` on the scrim is replaced by a press-contained dismissal** — defect F:
   ```tsx
   const pressStartedOutside = useRef(false);
   // on the overlay: onPointerDown={(e) => { pressStartedOutside.current = e.target === e.currentTarget; }}
   //                 onClick={(e) => { if (e.target === e.currentTarget && pressStartedOutside.current) onClose(); }}
   ```
   Both halves are required: `e.target === e.currentTarget` alone still fires when a press that
   began *inside* the panel is released on the overlay. The panel keeps its
   `onClick={(e) => e.stopPropagation()}` (`Modal.tsx:31`) as a second line of defence.
3. **`useTransitionStatus`** supplies `isMounted` and `status`, so exit motion exists (defect D).
   `data-open` is set only while `status === "open"`; the delayed unmount is §6.0's `if (!isMounted)
   return null`, and `useFloating` now takes the real `open` prop instead of the hard-coded `true`
   at `Modal.tsx:18`. `FloatingFocusManager` also gains `returnFocus={returnFocus}` (new prop,
   default `true`) — §6.7 is the one consumer that passes `false`.
4. **`aria-describedby`** — new optional `describedBy`. Not cosmetic: `ConfirmDialog`'s message
   (`ConfirmDialog.tsx:15`) is the thing the user must read before confirming a destructive action
   and today has no programmatic association with the dialog. `ConfirmDialog` passes the `<p>`'s id.
5. **`data-confirm-modal-root` stays exactly where it is** (`Modal.tsx:28`) — outside the overlay,
   wrapping everything. It is queried by `ConfirmDialog.dom.test.tsx:52` and, critically, by
   `AnchoredPopover.tsx:27`'s `closest()` exemption. **Moving or renaming it silently breaks the
   confirm-from-inside-a-popover interlock.** Acceptance criterion 6.

`handleKeyDown` (`Modal.tsx:20–25`) is unchanged: Escape, `preventDefault`, `stopPropagation`,
`onClose`. `stopPropagation` is deliberate — `ProjectCollaborationPanel.tsx:54` and
`RichTextEditor`'s handlers both watch for Escape and must not also fire.

### 6.2 Scrim

```
fixed inset-0 z-[var(--z-dialog)] grid place-items-center
p-[var(--space-6)] max-[720px]:p-0 max-[720px]:items-end
bg-[var(--scrim-overlay)] backdrop-blur-[3px]
motion-safe:transition-opacity motion-safe:ease-[var(--ease-exit)]
motion-safe:duration-[var(--dur-fast)]
data-open:motion-safe:ease-[var(--ease-entrance)] data-open:motion-safe:duration-[var(--dur-base)]
opacity-0 data-open:opacity-100
```

`backdrop-blur-[3px]` preserves `app.css:764`'s existing 3px exactly — this is *not* the
glassmorphism TB8-01 flagged on `.topbar` (§11.1 there): that was a decorative wash on an opaque
chrome element; this is a modal scrim, where a slight defocus of the page behind is the
conventional and system-sanctioned reading of "this is not available right now."

`max-[720px]:items-end` + `max-[720px]:p-0` is the **sheet presentation** — §6.5, owner-approved.

### 6.3 Panel

```
w-full max-w-[460px] max-h-[min(100%,calc(100dvh-var(--space-7)))]
flex flex-col
bg-background border-solid border-[length:var(--border-width-hair)] border-border
rounded-none shadow-[var(--shadow-lg)]
focus:outline-none
motion-safe:transition-[opacity,translate] motion-safe:ease-[var(--ease-exit)]
motion-safe:duration-[var(--dur-fast)]
data-open:motion-safe:ease-[var(--ease-entrance)] data-open:motion-safe:duration-[var(--dur-base)]
opacity-0 translate-y-[var(--space-3)] data-open:opacity-100 data-open:translate-y-0
max-[720px]:max-w-none max-[720px]:max-h-[85dvh]
```

- **The panel no longer scrolls; `.modal__scroll` does — required by §4.2a.** `overflow-auto` moves
  off the panel onto an inner wrapper holding head/body/foot, and the panel becomes
  `flex flex-col` with `.modal__scroll` as `flex-1 min-h-0 overflow-auto`. This is what lets the
  nested-overlay slot sit inside the panel (for stacking and focus) while staying outside any
  scroll box (so a nested popup is not clipped). `max-h` stays on the panel so the dialog's overall
  height is unchanged; visually nothing moves.
- **`bg-background`, not `bg-card` — check this, it is the plan's easiest mistake.**
  `.modal` is `background: var(--paper-050)` (`app.css:765`), which is `--bg-canvas` →
  `bg-background`. `bg-card` is `--paper-000` (pure white, `colors.css:36–37`). Writing `bg-card`
  here would visibly lift every dialog in the app off warm paper onto white — the identical error
  TB8-01 §D-4 caught in its own first revision on `--field-bg`. The dialog stays warm paper.
- **Two absorbed dialogs do change one paper step, deliberately.** `.admin-modal__panel`
  (`app.css:1079`) and `.rich-text__link-dialog` (`:529`) are both `--paper-000` today; under
  `Modal` they become `--paper-050`. Stated rather than discovered: it is a one-step tint that makes
  all five dialogs one surface, and it is the point of converging them. Captured in §5 rows 6 and 7.
- `100vh → 100dvh` and `48px → var(--space-7)`: defect E's measurement half, plus J's off-grid
  literal. `dvh` is the *dynamic* viewport, which is what a modal must fit inside on iOS Safari.
- `--shadow-lg` is correct here and stays — a scrimmed, detached dialog is precisely what
  `spacing.css:41` reserves it for.
- `focus:outline-none` preserves `app.css:772`, which exists because the panel is `tabIndex={-1}`
  and `FloatingFocusManager` may focus it programmatically. Note this is `:focus`, **not**
  `:focus-visible` — every *control inside* keeps the full 2px ink ring.
- `rounded-none` is explicit, not inherited: `--radius-card: 0` (`spacing.css:29`) and stock shadcn
  dialogs arrive with `rounded-lg`. Grep-verified out (criterion 8).

| Sub-element | Was | Classes |
| --- | --- | --- |
| `.modal--wide` | `max-width: 560px` (`:766`) | `size="wide"` → `max-w-[560px]`; new `size="prose"` → `max-w-[820px]` for the Admin payload (§6.6), replacing `.admin-modal__panel`'s `min(820px,100%)` |
| `.modal__head` (`:767`) | `padding: 32px 32px 16px` | `p-[var(--space-6)] pb-[var(--space-4)]` |
| head eyebrow | inline `style={{marginBottom:10}}` (`Modal.tsx:33`) — off-grid **and** an inline styling owner | `<Eyebrow className="mb-[var(--space-3)]">` — TB8-01's `ui/eyebrow.tsx` |
| head `h3` (`:768`) | `font: var(--type-h2); font-size: 30px` | `[font:var(--type-h3)] tracking-[var(--tracking-tight)] text-pretty` — **28px, an actual scale step**, replacing the off-scale 30px (defect J). `--type-h3` is `--text-xl`/28px; it is the nearest real step and the one that keeps a 460px dialog title on one line. |
| `.modal__body` (`:769`) | `padding: 0 32px 24px` | `flex flex-col gap-[var(--space-4)] px-[var(--space-6)] pb-[var(--space-5)]` |
| `.modal__foot` (`:770`) | `padding: 24px 32px`, top hairline | `flex flex-wrap justify-end gap-[var(--space-3)] px-[var(--space-6)] py-[var(--space-5)] [border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border max-[720px]:flex-col-reverse max-[720px]:[&>*]:w-full max-[720px]:[&>*]:min-h-[44px]` |

**Correction — `w-full` alone does not produce a 44px target.** An earlier revision claimed these
classes gave each footer control "a full 44px-wide-and-tall target". The width half was true; the
height half was false, because TB8-01's `Button` sets `min-h-[38px]` and nothing here overrode it.
Sol's plan review caught it. **`max-[720px]:[&>*]:min-h-[44px]` is the missing half** and is now
explicit above; criteria 3 and §10.5 depend on it actually being written.

Otherwise the footer's `max-[720px]` treatment is as described: `flex-col-reverse` keeps the primary
action **last in DOM order but bottom-most visually**, which is the phone convention. DOM order is
unchanged, so tab order and `ConfirmDialog.dom.test.tsx`'s `data-testid` queries are unaffected.

**Target-size attribution, corrected.** This plan (inheriting the phrasing from TB8-01 §1.4) called
44px "the WCAG 2.5.8 minimum". That is wrong: **WCAG 2.5.8 Target Size (Minimum) is Level AA at
24×24 CSS px**; 44×44 is **WCAG 2.5.5 Target Size (Enhanced), Level AAA**, and is also the
Apple-HIG convention. 44px stays as the value — it is the right call for a touch surface and it is
what TB8-01 shipped — but every comment in this release reads
`/* 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token */`. The false 2.5.8
attribution is not repeated. TB8-01's already-shipped comments are left alone; correcting them
belongs to whichever candidate next touches that file.

**Directional borders use TB8-01 §1.3's arbitrary-style form.** `border-t-solid` does not exist and
compiles to nothing with Preflight disabled. Acceptance criterion 9 greps for it.

### 6.4 Motion

| Phase | Rule |
| --- | --- |
| Scrim in | `opacity 0 → 1`, `--dur-base` (220ms) `--ease-entrance` |
| Panel in | `opacity 0 → 1` **and** `translateY(12px) → 0`, same timing |
| Scrim + panel out | both reversed at `--dur-fast` (120ms) `--ease-exit`. Driven by `data-open` being *removed* while `status === "close"`, during the 120ms `isMounted` keeps the component alive — §6.0. |
| Reduced motion | `motion-safe:` on every motion utility, plus the existing global clamp at `app.css:830` and the Calendar's `[data-modal-variant="calendar"] *` overrides (`production-calendar.css:268,277`), which continue to apply because `variant` still lands on the panel |

**`@keyframes pop`'s `scale(.98)` is gone** (defect D) — a scale contradicts the readme's
*fades and small translates only*, and it was the only scale in the product. `translateY` alone,
12px (`--space-3`) instead of the old 10px so it sits on the grid. `--dur-slow` → `--dur-base`,
matching the toast decision TB8-01 §10.5 already made for the same reason.

`@keyframes pop` (`app.css:828`) is then **dead and deleted** — grep first (criterion 11);
`@keyframes fade` (`:827`) **stays**, TB8-01's loading skeleton uses it.

### 6.5 The sheet presentation — approved evolution (§13 Q2)

The roadmap requires *owner approval for intentional evolution*, and this is the plan's one
intentional evolution. **Approved by the owner 2026-09-01 as written.** Today at 390 a dialog is a
326px centred card (`.scrim`'s 32px padding each side) whose footer buttons are two 38px pills. At
`≤720px` the dialog now **docks to the bottom edge**, full width, entrance translate only.

That is the `max-[720px]:` classes already written into §6.2/§6.3 (`items-end`, `p-0`,
`max-w-none`, `max-h-[85dvh]`, `flex-col-reverse` footer). It is genuinely a "sheet" — the pattern
this candidate's name promises and the app currently has none of. The bug repairs bundled nearby —
the `dvh` fix, the scroll lock, the press-contained dismissal and the footer's 44px targets — were
never contingent on this decision; they are bug repair, not evolution.

No drag-to-dismiss, no rubber-banding, no handle affordance — those are the stock mobile-sheet
reflexes and none of them is in this design system.

### 6.6 Retiring `.admin-modal`

`Admin.tsx:465` becomes — **consistent with §6.0: `open` is a prop, the component is not
conditionally unmounted, and the body reads a retained payload so the `<pre>` does not blank out
mid-transition.** An earlier revision's snippet kept `{payload && …}` and omitted `open` entirely,
which would have reintroduced the exact defect §6.0 exists to fix; Sol's round-2 review caught it.

```jsx
// Retain the last payload so the dialog still has content during its 120ms close.
const lastPayload = useRef<PayloadShape | undefined>(undefined);
if (payload) lastPayload.current = payload;
const shownPayload = payload ?? lastPayload.current;

<Modal open={!!payload}
       title="Event details" eyebrow="Webhook payload" size="prose"
       testId="admin-payload-modal" onClose={() => setPayload(undefined)}
       footer={<Button variant="secondary" onClick={() => setPayload(undefined)}>Close</Button>}>
  <pre className="max-h-[55vh] overflow-auto m-0 p-[var(--space-4)] bg-background
                  text-foreground-secondary [font:var(--type-mono)]
                  text-[length:var(--text-xs)] leading-[var(--leading-normal)]">
    {shownPayload?.json}
  </pre>
</Modal>
```

`Modal` itself returns `null` while `!isMounted` (§6.0), so rendering it unconditionally here costs
nothing when closed — the retention ref exists only to keep the body populated for the 120ms the
dialog is animating out.

Gains, all from §6.1: focus trap, focus restore, Escape, outside dismissal, scroll lock, and a
scrim that covers the top bar (H-i).

**Three deltas, stated rather than glossed.** An earlier revision claimed this consumer "loses
nothing"; the fresh-Opus gate review found two undisclosed visual/semantic changes on top of the one
already documented. All three are accepted, and all three are captured by §5 row 6:

| # | Delta | Assessment |
| --- | --- | --- |
| 1 | **Panel background** `--paper-000` → `--paper-050` (`.admin-modal__panel`, `app.css:1079`) | Already documented in §6.3. One paper step; makes all five dialogs one surface. |
| 2 | **Panel border** `1px solid var(--ink-900)` (`app.css:1079`) → the shared hairline `--border-hairline` (`--greige-200`) | **New disclosure.** The solid-ink border is a one-off: no other dialog, card, or popover in the app draws one, and the design-system readme specifies hairline greige rules with elevation carried by shadow. Converging it is the point of the release — but it is a real, visible change to this dialog's edge, not a no-op. |
| 3 | **Accessible name** `aria-label="Tonomo event payload"` (`Admin.tsx:465`) → `aria-labelledby` → the rendered title, **"Event details"** | **New disclosure.** The name a screen reader announces changes. Defensible and arguably better — the name now matches the visible heading, which is the WCAG 2.5.3 *Label in Name* preference, and the eyebrow "Webhook payload" preserves the old wording on screen. But it is a semantic change and must not be discovered at QA. **Check `Admin.dom.test.tsx` for a query on the old `aria-label`** (criterion 11) and migrate it to the new name rather than loosening it. |

Beyond those three, the structure is preserved: the `.admin-section__head` wrapper is replaced by
`Modal`'s own eyebrow+title head, rendering the same two strings in the same order.

`Button` is TB8-01's primitive; this is its first non-Dashboard consumer, which is the reuse the
selection order asks each candidate to bank. `.admin-modal`, `.admin-modal__panel` and
`.admin-modal pre` (`app.css:1078–1080`) are **deleted** after the §12 grep.

**Watch:** `screens/Admin.dom.test.tsx` — re-run the grep for `.admin-modal` in tests, and if a
query exists, migrate it to `[data-testid="admin-payload-modal"]` or a role query. Never loosen it.

### 6.7 Retiring `.rich-text__link-modal`

`RichTextEditor.tsx:370–378` becomes — **complete, with §6.0's `open` and §6.7's `returnFocus`, both
of which an earlier revision's snippet omitted despite its own reasoning requiring them:**

```jsx
<Modal
  open={linkOpen}                          {/* §6.0 — no longer `{linkOpen && …}` */}
  onClose={() => closeLinkDialog()}        {/* default returnFocus: true → trigger */}
  returnFocus={false}                      {/* §6.7 — owner #3 keeps focus authority */}
  title={linkWasActive.current ? "Edit link" : "Add link"}
  initialFocus={linkInput}
  testId="rich-text-link-modal"
  describedBy={linkError ? linkErrorId : undefined}
  footer={<>
    {linkWasActive.current && <Button variant="secondary" onClick={removeLink}>Remove link</Button>}
    <span className="flex-1" />
    <Button variant="secondary" onClick={() => closeLinkDialog()}>Cancel</Button>
    <Button onClick={applyLink}>Apply link</Button>
  </>}
>
  <label className={FIELD_LABEL}>URL
    <input ref={linkInput} type="url" value={linkHref}
           onInput={(e) => { setLinkHref(e.currentTarget.value); setLinkError(null); }}
           onChange={(e) => { setLinkHref(e.target.value); setLinkError(null); }}
           onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } }}
           aria-invalid={linkError ? true : undefined}
           placeholder="https://example.com" />
  </label>
  {linkError && <p id={linkErrorId} className={ERROR} role="alert">{linkError}</p>}
</Modal>
```

**The × close button — where it goes.** Today the dialog head carries its own
`<button aria-label="Close link dialog">×</button>` (`RichTextEditor.tsx:373`), and `Modal`'s head
renders only an eyebrow and a title (`Modal.tsx:32–35`) with no dismiss affordance. Three options
were considered; the decision is **(c)**:

| | Option | Verdict |
| --- | --- | --- |
| (a) | Add a `×` to `Modal`'s shared head for every dialog | **No.** It would add a dismiss control to the four existing dialogs — a visual and behavioral change to `ConfirmDialog` and the three Calendar dialogs, all out of scope, and it would give `ConfirmDialog` a third exit path its tests do not expect. |
| (b) | Give `Modal` an opt-in `dismissible` prop rendering a `×` for this consumer only | Workable, but it puts a one-consumer affordance into the shared head and invites the next consumer to turn it on inconsistently. |
| (c) | **Drop the `×`; the dialog already has Cancel, Escape, and now outside-dismiss** | **Chosen.** The `×` existed because the hand-rolled dialog had no outside-click dismissal at all (defect G) — it was the compensating affordance. With §6.1's press-contained overlay dismissal plus Escape plus an explicit `Cancel` button in the footer, a fourth exit path is redundant, and every other dialog in the app already dismisses exactly this way. This makes the RTE dialog *more* consistent with the shared primitive, not less. |

All three surviving exits land on the trigger, per the exit-path table below — so removing the `×`
removes an affordance, never a destination. **Check `RichTextEditor.dom.test.tsx` for a query on
`aria-label="Close link dialog"`** before deleting it (criterion 11); if one exists, migrate it to
the Cancel button rather than loosening the assertion.

**Preserve exactly, all of it:**

- `linkHref` state, the `onInput` **and** `onChange` pair (both are present deliberately — TipTap
  and happy-dom disagree about which fires), the Enter-to-apply handler, `applyLink`, `removeLink`,
  `closeLinkDialog`, `linkWasActive`, and every URL-validation branch. **This plan touches no
  link-validation logic.**
- `id="rich-text-link-title"` and `aria-labelledby` — `Modal` generates its own `titleId`, so the
  labelling moves to `Modal`'s mechanism; **check `RichTextEditor.dom.test.tsx` for a query on that
  literal id** before changing it (criterion 11).
- `<p className="rich-text__link-error" role="alert">` keeps its role; only its paint is tokenised
  (`app.css:536`'s bare `font-size: 12px` → `text-[length:var(--text-xs)]`,
  `--signal-critical` → `text-destructive`).

#### The complete focus inventory — both owners, not one

**This is a correction.** An earlier revision inventoried only `handleLinkDialogKeyDown` and left the
component's *second* focus owner in place. Sol's plan review was right: `RichTextEditor` manages link
focus in **two** places, and migrating one while leaving the other means two owners fighting
`FloatingFocusManager` — the precise regression criterion 15 exists to catch.

| # | Owner | Lines | Does | Disposition |
| --- | --- | --- | --- | --- |
| 1 | `handleLinkDialogKeyDown` | `:330–338` | Escape → `closeLinkDialog()`; Tab **and Shift-Tab** → manual focus cycle over `querySelectorAll('input:not([disabled]), button:not([disabled])')`, with the reverse wrap computed at `:336` | **Delete entirely.** Escape is `Modal`'s (`Modal.tsx:20–25`); Tab is `FloatingFocusManager`'s, which also correctly includes `<a>`, `<select>` and `[tabindex]` that the hand-rolled query misses. |
| 2 | the `linkOpen` effect | `:275–290` | on open: `linkInput.current?.focus()` **and** a `document` `focusin` listener that yanks focus back to `linkInput` whenever focus leaves the dialog | **Delete both.** Initial focus becomes `Modal`'s `initialFocus={linkInput}`; containment becomes `FloatingFocusManager modal`'s real trap. |
| 3 | the same effect's `!linkOpen` branch | `:276–281` | on close: if `returnFocusToLinkTrigger.current`, focus `linkTrigger` | **Keep, verbatim.** This is the half `FloatingFocusManager` must *not* take over — see below. |
| 4 | `returnFocusToLinkTrigger` ref + `closeLinkDialog({returnFocus})` | `:310–313` | records where focus should land | **Keep, verbatim.** |
| 5 | `linkSelection` ref, `linkWasActive` ref | `:304–306` | restores the ProseMirror selection before applying | **Keep, verbatim.** Untouched by this plan. |

**The reason both owners go is that there are two of them, not that either is broken.** An earlier
revision justified the deletion by claiming the `focusin` listener "forces focus to the URL field
rather than cycling, so Shift-Tab from the field is impossible today." That is false:
`handleLinkDialogKeyDown` handles **both** directions, computing the reverse wrap-around index for
`event.shiftKey` at `RichTextEditor.tsx:336`. Today's trap works. The real justification — and the
one that matters — is that keeping *either* hand-rolled owner alongside `FloatingFocusManager`
leaves two mechanisms competing for the same focus, which is exactly the regression criterion 15
exists to catch. One owner, and it is the library's.

#### Why `Modal` gains a `returnFocus` prop

`applyLink` (`:314–321`) and `removeLink` (`:323–328`) both run `editor.chain().focus()…run()` and
then call `closeLinkDialog({ returnFocus: false })` — because after applying a link, focus belongs in
**the editor, at the restored selection**, not back on the toolbar button. Cancel and Escape use the
default `returnFocus: true` and land on the trigger. That distinction is deliberate and correct.

`FloatingFocusManager returnFocus` (default `true`) would override it — restoring focus to the
trigger *after* `chain().focus()` had put the caret in the editor, silently undoing the apply's focus
result. So `Modal` takes a new optional `returnFocus` prop (default `true`, preserving every other
consumer) and **this consumer alone passes `returnFocus={false}`**, keeping owner #3 authoritative.

#### Every exit path, every destination — no builder judgment left

| Path | `returnFocus` arg | Focus lands on | Owner |
| --- | --- | --- | --- |
| **Apply link** (valid URL) | `false` | the **editor**, at `linkSelection`'s restored range | `chain().focus()` in `applyLink` |
| **Apply link** (invalid URL) | — dialog stays open | the **URL field**, `role="alert"` announces the error | `setLinkError`, no close |
| **Remove link** | `false` | the **editor**, at `linkSelection`'s restored range | `chain().focus()` in `removeLink` |
| **Cancel button** | `true` (default) | the **Link toolbar trigger** | effect owner #3 |
| ~~Close (×) button~~ | — | **removed** — see the × decision above; Cancel, Escape and outside-dismiss all cover it, each landing on the trigger | — |
| **Escape** | `true` (default) | the **Link toolbar trigger** | `Modal`'s `handleKeyDown` → `onClose` → `closeLinkDialog()` → owner #3 |
| **Outside press-contained dismissal** | `true` (default) | the **Link toolbar trigger** | `Modal`'s overlay handler → `onClose` → owner #3 |

The last two are new capabilities — today Escape works but outside-click does nothing at all
(`:371`'s backdrop calls `preventDefault()` without closing, defect G). Both now route through the
same `closeLinkDialog()` that Cancel uses, so all three land identically.

**Ordering caveat the builder must not get wrong:** owner #3 fires from a `useEffect` on `linkOpen`
going false, while `Modal`'s unmount is now delayed 120ms by §6.0. The effect therefore runs *before*
the dialog leaves the DOM. With `returnFocus={false}` on the focus manager nothing competes for
focus, so the trigger receives it immediately and keeps it — but this is exactly the interaction
criterion 15 must exercise in a real browser, not only happy-dom.

**Also delete:** the `rich-text__link-backdrop` element (`:371`) and the CSS blocks
**`app.css:527–535`** — the whole contiguous run, matching §12.2's row. An earlier revision wrote
`527–530,532,534,535`, silently sparing `:531` (`.rich-text__link-dialog-head strong`, replaced by
`Modal`'s `<h3>`) and `:533` (`.rich-text__link-dialog label`, replaced by `FIELD_LABEL`); both are
orphaned by this section and both go. `:536`'s `.rich-text__link-error` is the one rule in the run
that **stays** and is tokenised in place. `.rich-text__link-dialog` **loses `z-index: 100`** —
`--z-dialog` now governs (H).

**Keep:** `app.css:511`'s `.rich-text__toolbar-button:focus-visible` rule, but **remove the
now-orphaned `.rich-text__link-dialog button/input` selectors from it** — those controls become
`Button`/tokenised inputs carrying their own ring. Verify the toolbar half of the selector is
untouched.

**Caveat, flagged for the builder:** the link dialog opens from a TipTap toolbar button whose
`onMouseDown` calls `preventDefault()` to hold the editor selection (`RichTextEditor.tsx:359`), and
the applied selection is restored from `linkSelection` rather than from the live editor state. The
whole of the table above is therefore behavior that **happy-dom cannot be trusted to reproduce**:
`docs/lessons.md:586–607` records a TipTap/ProseMirror case where a native listener's timing differed
from React's synthetic dispatch and corrupted the document while a loose test assertion passed
anyway, and `docs/lessons.md:833–834` generalises it — *native listener / event timing and
scroll/focus behavior can pass happy-dom while failing Chrome.* Neither entry records a link-dialog
selection regression specifically; they are cited as the reason to distrust a green unit test here,
not as evidence this exact bug has occurred. Criterion 15 requires the real-browser check.

### 6.8 Interactive states — `Modal` and its controls

| Element | default | hover | focus-visible | active | disabled | error |
| --- | --- | --- | --- | --- | --- | --- |
| Scrim | `bg-[var(--scrim-overlay)]` | none — a scrim is not a control | n/a | n/a | n/a | n/a |
| Panel | **`bg-background`** (`--paper-050`) + hairline + `--shadow-lg` | none | `focus:outline-none` (programmatic focus only) | none | n/a | n/a |
| Footer buttons | `Button` variant per role | inherited | inherited | inherited 1px nudge | inherited token disabled | n/a |
| Danger confirm | `Button variant="danger"` | `bg-destructive` + `!text-destructive-foreground` | inherited | inherited | inherited | n/a |
| Body inputs (Calendar, RTE) | `bg-card` hairline `rounded-[var(--radius-sm)]` `[font:var(--type-body)] text-[length:var(--text-sm)] px-[var(--space-3)] py-[var(--space-2)]` | `hover:border-border-hover` | `focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2` | n/a | `disabled:bg-surface-sunken disabled:!text-foreground-secondary disabled:cursor-not-allowed` | `aria-invalid:border-destructive` + the `role="alert"` message |
| — at ≤720 | `min-h-[44px]` /* 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token */ | | | | | |

Every state derives from `Button`/TB8-01 rather than being restated, which is the point of having
the primitive.

**Field background, stated:** dialog inputs take `bg-card` (`--paper-000`, which is also
`--field-bg`, `colors.css:52`) on the `bg-background` panel — a field reads one step *up* from its
dialog, matching TB1's live `Input`. Today `.rich-text__link-dialog input` (`app.css:534`) and
`.project-team-picker > input` (`:267`) both sit at `--paper-050`, i.e. flush with the panel. This
is a deliberate one-step change, captured in §5 rows 7 and 11. **The `Input` primitive (`ui/input.tsx`) stays out of scope** — TB8-01 §D-4 settled
that, and these dialog inputs are styled in place, not migrated.

The `[data-modal-variant="calendar"]` 44px overrides (`production-calendar.css:237,246`) become
**redundant** once the footer/body rules above apply at ≤720. **Leave them in place anyway** — they
are TB5C's matched-evidence contract, removing them is a Calendar-candidate decision, and a
redundant `min-height: 44px` changes nothing. Recorded in §11.2 so nobody "cleans it up" here.

---

## 7. `AnchoredPopover` — the popover primitive

`components/AnchoredPopover.tsx`. **The engine is correct and the hook's contract does not change.**
Three additions, one absorption.

### 7.1 What stays exactly as-is — the non-negotiables

| Line | Behavior | Why it must not move |
| --- | --- | --- |
| `:17` | `offset(6), flip({padding:8}), shift({padding:8})` | Collision handling that keeps popovers inside the narrow Collaboration panel and the 390 viewport. `Checklist-Popovers-And-Drag-Reorder-Plan.md:100–108` records why `FloatingPortal` is mandatory: both `.project-collaboration--overlay` (`overflow:hidden`) and `.project-collaboration__scroll` (`overflow:auto`) would clip an in-place popover. |
| `:27` | `node.closest("[data-confirm-modal-root]")` exemption | A `confirm()` raised from inside a popover (`SubtaskChecklist.tsx:133`) must not dismiss the popover under it. Shipped by `f2d3700`. |
| `:29–30` | `[data-floating-ui-focus-guard]` / `[data-floating-ui-portal]` exemptions in the `focusin` boundary | Without them the portal's own focus guards close the popover the instant it opens. |
| `:39–44` | **Escape closes and calls `.focus()` on the reference *synchronously*** | **This is the TB0 fix, commit `08f4653`.** It replaced `window.setTimeout(() => …focus(), 0)`. A stale timer queued by one popover's Escape could fire after a *different* popover opened, steal its focus, and close it too — surfacing as a `ProjectCollaborationPanel` Escape test that failed only in the full suite, never in isolation. **Do not reintroduce any deferral — no `setTimeout`, no `queueMicrotask`, no `requestAnimationFrame`, no `useEffect` — on this path.** Acceptance criterion 7 asserts it. |
| `:57` | `returnFocus={false}` on `FloatingFocusManager` | Required on *every* usage (`Checklist-Popovers-And-Drag-Reorder-Plan.md:110–113`): Escape returns focus explicitly, and an outside pointer/focus close must **not** yank focus back to the trigger. |
| `:57` | `order={["reference","floating","content"]}` | Tab follows logical popover order across the portal. |

This table is the plan's answer to "note any known accessibility-behavior traps you must preserve."
It is reproduced as acceptance criterion 7 and Sol should treat any diff hunk touching these lines
as blocking until justified.

### 7.2 Additions

1. **Exit motion** (defect D). `useTransitionStatus` on the popover's own `context`, emitting
   `data-open` on the floating div. Because consumers pass `open &&` into the JSX
   (`SubtaskChecklist.tsx:103`, `ProjectKanbanBoard.tsx:210`), the *unmount* is the consumer's, so
   the hook must expose `mounted` and consumers switch `{open && <AnchoredPopover …>}` to
   `{mounted && <AnchoredPopover …>}`. Five call sites, mechanical, enumerated in §12.
   **Risk noted:** this changes when the popover leaves the DOM, which is exactly the kind of timing
   the TB0 race lived in. The Escape path must still close *and restore focus* synchronously — the
   focus call does not wait for the exit transition. Criterion 7 covers both together.
2. **A `z-[var(--z-popover)]` class on the floating div**, replacing the three CSS `z-index: 90`
   declarations (`app.css:266,583,1232`) so one owner sets it.
3. **An optional `label` prop** rendering `aria-label` on the floating div. Today
   `AnchoredPopover`'s own div is unlabelled and every consumer wraps an inner `role="group"` with
   the label (`SubtaskChecklist.tsx:103`). That works; the prop exists so §7.4's absorbed picker,
   which labels the floating div itself (`ProjectTeamControl.tsx:82`), keeps its accessible name
   without adding a wrapper. **No consumer's existing accessible name changes.**
4. **The nested-overlay container (§4.2a).** `AnchoredPopover`'s `FloatingPortal` becomes
   `<FloatingPortal root={React.useContext(OverlayContainerContext)}>`. Every call site in this
   release sits outside a dialog, so the context is `null` and `FloatingPortal` falls back to
   `document.body` — **byte-identical to today**. This is wiring for the first popover-inside-a-
   dialog consumer, not a behavior change here, and §5 row 3's opposite nesting (a `confirm()`
   raised from *inside* a popover) is unaffected: `ConfirmModalHost` is mounted at `main.tsx:16`,
   outside every popover, so its own context is `null` too.

### 7.3 Shared popover paint

Applied to the floating div by `AnchoredPopover` itself, replacing the four hand-written CSS panels:

```
z-[var(--z-popover)] w-max
max-w-[min(320px,calc(100vw-var(--space-4)))]
max-h-[min(420px,calc(100dvh-var(--space-5)))] overflow-auto
bg-popover border-solid border-[length:var(--border-width-hair)] border-border
rounded-none shadow-[var(--shadow-md)]
motion-safe:transition-[opacity,translate] motion-safe:ease-[var(--ease-exit)]
motion-safe:duration-[var(--dur-fast)]
data-open:motion-safe:ease-[var(--ease-entrance)] data-open:motion-safe:duration-[var(--dur-base)]
opacity-0 translate-y-[var(--space-1)] data-open:opacity-100 data-open:translate-y-0
```

- **`--shadow-lg` → `--shadow-md`** on all four popovers — defect B. An anchored popover is not a
  dialog. TB8-01 §2.2 made the identical call for the `Select` popup and gave the identical reason;
  this generalises it.
- `100vw`/`100dvh` bounds replace `calc(100vw - 16px)` and `calc(100dvh - 24px)`
  (`app.css:1232,583,617,1255`) — same intent, tokenised, and `dvh` for the iOS reason in §6.3.
- 4px entrance translate (`--space-1`), a quarter of the dialog's — an anchored surface should
  barely move; it is already where it belongs.

### 7.4 Absorbing `ProjectTeamControl`'s picker

`ProjectTeamControl.tsx:55–95`. **Delete** the local `useFloating` call, the `pointerdown` effect
(`:56–65`), and the Escape branch of `onKeyDown` (`:73`). **Replace** with
`useAnchoredPopover({ open, onClose, placement: "bottom-start" })` and `<AnchoredPopover
label={\`Add ${roleLabel(roleOnProject)}\`} initialFocus={searchRef} …>`.

**Keep:**

- `setTrigger`, the stable `useCallback` reference setter (`:69–72`). Its comment records issue
  #185 — an inline `(node) => setReference(node)` re-runs every render and floating-ui's
  `setReference` setStates with no equality guard, producing a detach/attach storm that can exceed
  React's update-depth limit. `useAnchoredPopover` returns the same `refs`, so the callback is
  rewired to it verbatim. **Do not inline it.**
- The Arrow/Enter branches of `onKeyDown` (`:75–77`) — they drive `activeIndex` over the `role="option"`
  list, which is picker-specific and correct. Passed through `AnchoredPopover`'s `onKeyDown`
  composed with the hook's Escape handler.
- `role="dialog"` on the floating div wrapping `role="listbox"`. It is unusual but deliberate: the
  popover contains a search input *and* a listbox, which is not a plain listbox. Unchanged.

**Behavior deltas, both fixes:** the confirm-root exemption is gained (§1.3's latent bug), and
`returnFocus={triggerRef}` becomes `returnFocus={false}` + explicit synchronous Escape restore —
converging on the contract `Checklist-Popovers-And-Drag-Reorder-Plan.md:110–113` mandates.
**`ProjectTeamControl.dom.test.tsx:71,188` query `.project-team-picker`** — the class stays on the
inner content wrapper as a test hook (§12), so those assertions do not move.

### 7.5 Per-consumer skins and their states

The panel is shared; each consumer's *contents* keep a scoped class. Tokenised in place:

**`.project-team-picker`** (`app.css:266–276`) — panel properties deleted (now
`AnchoredPopover`'s); contents retained and fixed:

| Element | Was | Becomes |
| --- | --- | --- |
| `> input` (`:267`) | `margin: 8px; padding: 9px 10px; font-size: 13px` — off-grid, off-scale | `m-[var(--space-2)] w-[calc(100%-var(--space-4))] px-[var(--space-3)] py-[var(--space-2)] [font:var(--type-body)] text-[length:var(--text-sm)]` + §6.8's input state set |
| `__results` (`:268`) | `max-height: min(360px, calc(100vh - 120px))` | inherits the panel's `max-h`; keeps `overflow-auto` + `px-[var(--space-2)] pb-[var(--space-2)]` |
| `__option` (`:269`) | `min-height: 44px; padding: 8px`, bottom hairline | keeps 44px, `px-[var(--space-2)] py-[var(--space-2)]`, `[border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border last:border-b-0` — the `last:` reset is new; today the final option double-rules against the panel edge |
| `__option:hover` / `[aria-current="true"]` (`:270`) | **both `--paper-100`** | **split — §10.3** |
| `__option.is-selected` (`:271`) | `color: var(--signal-positive)` | `!text-signal-positive`, retained. Not colour-alone: the `✓` glyph at `ProjectTeamControl.tsx:91` carries it too. |
| `__option:disabled` | **nothing** — a pending option looks live | `disabled:bg-surface-sunken disabled:!text-foreground-secondary disabled:cursor-not-allowed` — 7.4:1, the contrast pair TB8-01 §7.4 computed |
| `__option strong` (`:274`) | `font-size: 12px; font-weight: 500` — **faux-bold** (defect I) | `text-[length:var(--text-xs)] font-normal` — hierarchy comes from the `small` beneath going `text-muted-foreground`, not from a weight the font does not have |
| `__option small` (`:275`) | `font-size: 10px` — below the scale floor | `text-[length:var(--text-2xs)] text-muted-foreground` (11px, the real floor) |
| `__empty` (`:276`) | `font-size: 12px` | `px-[var(--space-2)] py-[var(--space-3)] text-[length:var(--text-xs)] text-muted-foreground` |

**`.kanban-move-popover`** (`app.css:583–589`) — **stays as CSS**, edited in place. TB8-01 §1.5
carved the Kanban out on release-ownership grounds and §12.11 there priced the drag-regression risk.
That carve-out holds for the *styling*. Only the panel-level properties move to `AnchoredPopover`
(which `ProjectKanbanBoard.tsx:210` already renders through), plus three in-place declarations:

```css
/* :583 — panel properties deleted; AnchoredPopover owns width/border/background/shadow/z. */
.kanban-move-popover__option { min-height: 44px; padding: var(--space-2) var(--space-3);
                               font-size: var(--text-xs); }   /* was 32px / 7px 8px / 12px */
.kanban-move-popover__actions .button { min-height: 38px; padding: 9px 14px;
                                        font-size: var(--text-xs); }  /* was 30px / 5px 7px / 10px */
```
plus §10.3's highlight rule for `[aria-selected="true"]`.

> **Correction — the QA waiver is withdrawn.** An earlier revision claimed "nothing in that file
> changes" and that drag verification was therefore not triggered. That was **false and
> self-contradictory**: §7.2 and §12.3 both require two lifecycle edits *in that very file*
> (`ProjectKanbanBoard.tsx:149,210`, `open` → `mounted`), and the styling carve-out was never a QA
> carve-out. `docs/lessons.md:901–902` is unconditional — *"Real-browser drag verification on a
> **multi-card** column is mandatory for any change under `ProjectKanbanBoard` / dnd-kit config"* —
> and TB8-01 §12.11 already applied that rule to this codebase for an edit of comparable size (a
> single added prop). Sol's plan review caught the contradiction.
>
> **Real-browser pointer *and* keyboard cross-column drag verification is mandatory for this
> release.** It is acceptance criterion 17, restated there in full and matching TB8-01 §12.11's
> wording exactly. Note also that the two edits change *when the popover unmounts*, which is closer
> to the drag/focus machinery than a prop addition — if anything the case for verification is
> stronger here, not weaker.

**`.subtask-popover`** (`app.css:1232–1248`) — same treatment: panel properties deleted, contents
tokenised in place. `__content label` 10px → `--text-2xs`; `__actions .button` and `__member`
30px → 38px (44px at ≤720); `__member small` → `text-muted-foreground`; `__members`
`max-height: 190px` → the panel's `max-h`; `__member:hover` gets §10.3's split. `app.css:1203`'s
`:focus-visible` block is unchanged — those selectors are correct and match `base.css:25`'s ring.

---

## 8. `Menu` — the Topbar menus

**In scope in full — behavior and paint — per owner decision 2026-09-01 (§13 Q1).**

The case that carried it: `.topbar__notification-menu` and `.topbar__mobile-menu` are the **only two
`role="menu"` widgets in the entire app**, this candidate is literally named "ordinary menus," and
they carry two live accessibility defects — L (no arrow-key navigation behind a `role` that promises
it) and the `setTimeout(0)` focus-restoration pattern at `Topbar.tsx:37,42,55,60`, the exact shape
the TB0 fix removed from `AnchoredPopover`. Building `Menu` here also means the later
*notification bell/preferences/Admin delivery UI* candidate inherits the primitive instead of
building it.

**The fence, held tight.** This section changes the two menu *popups* and their two triggers, and
nothing else. TB8-01 §11.1's deferral of `.topbar` itself, `.topnav`, the identity block and the
impersonation banner stands — see §8.2's closing note.

### 8.1 The primitive

**This is a correction.** An earlier revision put `Menu` on `@floating-ui/react` and named four
hooks without the plumbing that makes them work. Sol's plan review was right on both counts, and
§2.1 now records the engine decision on its own merits: **`components/ui/menu.tsx` is built on
`@base-ui/react/menu`**, verified present at `node_modules/@base-ui/react/menu` with the full part
set (`Root`, `Trigger`, `Portal`, `Positioner`, `Popup`, `Item`, `LinkItem`, `Group`, `GroupLabel`,
`Backdrop`, `Arrow`). This is the same dependency and the same `X as XPrimitive` import convention
TB8-01's `ui/select.tsx:2` established.

#### Composition

```tsx
import { Menu as MenuPrimitive } from "@base-ui/react/menu";

<MenuPrimitive.Root open={open} onOpenChange={setOpen} modal={false}>
  <MenuPrimitive.Trigger className={TRIGGER} aria-label={triggerLabel}>…</MenuPrimitive.Trigger>
  <MenuPrimitive.Portal>
    <MenuPrimitive.Positioner side="bottom" align="end" sideOffset={10} collisionPadding={8}
                              className="z-[var(--z-popover)] outline-none">
      <MenuPrimitive.Popup className={PANEL} aria-label={menuLabel}>
        {children}
      </MenuPrimitive.Popup>
    </MenuPrimitive.Positioner>
  </MenuPrimitive.Portal>
</MenuPrimitive.Root>
```

**`Menu.Portal` takes the §4.2a container too**, on the same terms as `Select` (§9.2):
`<MenuPrimitive.Portal container={container}>` with
`positionMethod={container ? "fixed" : "absolute"}` on the `Positioner`, `container` read from
`OverlayContainerContext`. Neither Topbar menu is ever rendered inside a dialog, so `container` is
`null` at both call sites and the rendered result is exactly the snippet above; this is wiring for
the *notification bell/preferences/Admin delivery UI* candidate, which is the one likely to put a
menu inside a dialog first.

`modal={false}` is deliberate: these are dropdown menus in a sticky bar, not modal surfaces, and
`modal` would `aria-hidden` the page behind a notification list. **`Portal` is required** — today's
menus are `position: absolute` inside `.topbar` (`app.css:74`), which cannot flip or shift, so the
notification menu is hard-capped at `calc(100vw - 24px)` to avoid overflowing at 390. Portaled with
real collision handling, that cap becomes an honest `max-w` rather than a workaround.

#### What the primitive owns, and what we no longer write

`Menu.Root` supplies the entire contract below. **We register no items, own no active index, merge
no prop getters, and write no keyboard handler** — that plumbing (`useClick`, `useDismiss`,
`useInteractions`, `useListItem`, item refs, label arrays for typeahead) is the dependency's, which
is the whole reason §2.1 chose it.

| Input | Behavior | Owner |
| --- | --- | --- |
| click / tap on trigger | toggles open | `Menu.Trigger` |
| `Enter` / `Space` / `ArrowDown` on trigger | opens, highlights **first** item | `Menu.Root` |
| `ArrowUp` on trigger | opens, highlights **last** item | `Menu.Root` |
| `ArrowDown` / `ArrowUp` | move highlight, wrapping | `Menu.Root` |
| `Home` / `End` | first / last | `Menu.Root` |
| printable characters | typeahead | `Menu.Root` |
| `Enter` / `Space` on an item | activates it, then closes | `Menu.Item` / `Menu.LinkItem` |
| `Escape` | closes, returns focus to the trigger | `Menu.Root` |
| `Tab` | closes and moves on | `Menu.Root` |
| outside pointerdown / tap | closes without returning focus | `Menu.Root` |
| disabled trigger | does not open at all — no popup, no highlight | `Menu.Trigger disabled` |
| **roving focus** (`tabindex` management — real DOM focus moves to the highlighted item), `role="menu"`/`"menuitem"` | maintained automatically | `Menu.Root` |

This closes defect L, and it removes the `setTimeout(0)` focus restoration at
`Topbar.tsx:37,42,55,60` along with the two `useEffect` blocks at `:40–51` and `:58–69` that own
Escape, outside-pointerdown and initial focus by hand. **All four `window` listeners and both
`setTimeout(0)` calls are deleted**, which is the last instance in the app of the pattern the TB0 fix
removed from `AnchoredPopover` (§7.1).

#### The notification menu's dynamic rows — spelled out

`Topbar.tsx:150–156` is the hard case and the reason the plumbing matters: rows are built from a
polled array, each row is a `role="none"` wrapper holding **two** menu items — a link *or* a button
for the notification itself, plus a dismiss button — and the head holds a "Mark all read" button.

```jsx
<Menu label="Notifications" triggerLabel="Notifications" …>
  <div className={HEAD}>
    <span>Notifications</span>
    <MenuPrimitive.Item closeOnClick={false} render={<Button variant="text" />}
                        onClick={markAllRead}>Mark all read</MenuPrimitive.Item>
  </div>
  {notifications.map((n) => (
    <div key={n.id} role="none" className={ROW} data-unread={n.readAt ? undefined : ""}>
      {route?.kind === "project"
        ? <MenuPrimitive.LinkItem render={<InternalLink to={staffPathFor(route)} />}
                                  closeOnClick                     /* REQUIRED — default is false */
                                  label={n.title}
                                  onClick={() => void markNotificationRead(n)}>…</MenuPrimitive.LinkItem>
        : <MenuPrimitive.Item label={n.title}
                              onClick={() => void markNotificationRead(n)}>…</MenuPrimitive.Item>}
      <MenuPrimitive.Item closeOnClick={false}
                          label={`Dismiss ${n.title}`}
                          aria-label={`Dismiss notification: ${n.title}`}
                          data-notification-dismiss={n.id}
                          onClick={() => void dismissNotification(n)}>×</MenuPrimitive.Item>
    </div>
  ))}
  {!notifications.length && <div className={EMPTY} role="none">You're all caught up.</div>}
</Menu>
```

Five things this pins down that the earlier revision left to judgment:

1. **Two items per row is fine and intended.** Base UI registers items by render order, not by DOM
   nesting depth, so a `role="none"` wrapper does not break navigation: ArrowDown walks
   *notification → its dismiss → next notification → its dismiss*. That is the correct reading
   order and matches what the current markup already declares.
2. **`Menu.LinkItem` keeps the row a real `<a href>`.** The notification rows are navigations
   (`Topbar.tsx:154`); this is the same anchor-safety requirement TB8-01 §2.1 solved with
   `buttonClasses()`, and Base UI ships the part for it. Middle-click and ⌘-click keep working —
   asserted by criterion 14.
3. **`closeOnClick` is set explicitly on every item, because the two parts default differently.**
   Verified in the installed 1.7.0 types: **`Menu.Item` defaults `closeOnClick` to `true`**
   (`menu/item/MenuItem.d.mts`) but **`Menu.LinkItem` defaults it to `false`**
   (`menu/link-item/MenuLinkItem.d.mts:25–29`; the props interface itself opens at `:16`). An earlier revision assumed both closed on activation
   and omitted the prop from the `LinkItem`, which would have left the menu **open behind a
   navigation** — Sol's round-2 review caught it. So: `closeOnClick` (true) is written explicitly on
   the navigating `LinkItem`; `closeOnClick={false}` is written explicitly on "Mark all read" and on
   every dismiss button, which mutate the list in place and must not close the menu under the user.
   No item relies on a default.
4. **Dynamic list membership needs no bookkeeping from us.** The polled array re-renders and Base UI
   re-registers on render — there is no index array to keep in sync. What *does* need care is item 5.
5. **Focus continuity when the focused row disappears — we are *replacing* a policy, not
   inventing one.** Two corrections here, both from the fresh-Opus gate review.

   First, the status quo. `Topbar.tsx:97–107` **already implements** next-row → previous-row →
   menu, resolving the target by `data-notification-dismiss` id and focusing it inside a
   `window.setTimeout(…, 0)` (`:102`). An earlier revision wrote "left alone, the browser drops
   focus to `<body>`" as though that were today's behavior; it is not — that is what Base UI would
   do with no policy at all. The honest framing is stronger for the change, not weaker: **the
   existing policy is correct and we keep its shape; what we remove is the `setTimeout(0)`
   deferral**, which is precisely the pattern §8's own TB0 argument (`08f4653`, §7.1) wants gone
   from this file. The other four `setTimeout(0)` focus calls in `Topbar.tsx`
   (`:37`, `:42`, `:55`, `:60`) are deleted outright, since `Menu.Root` owns those paths.

   Second, the terminal case. An earlier revision sent focus to the **"Mark all read"** button,
   calling it "always present." It is not — `Topbar.tsx:151` renders it only under
   `{unreadCount > 0 && …}`, so dismissing the last notification when nothing is unread would
   target an element that does not exist. It also contradicted criterion 14.9. **Both now say the
   menu popup itself**, which is what the live code already does (`Topbar.tsx:105`,
   `(target ?? menu)?.focus()`) and is safe because the popup carries `tabIndex={-1}` (`:150`).

   | Situation after removal | Focus destination |
   | --- | --- |
   | A later row still exists | the **next** remaining notification row |
   | The removed row was last, earlier rows exist | the **previous** remaining notification row |
   | No notification rows remain | **the menu popup itself** (`tabIndex={-1}`) — keeps the user inside the open menu with no dependence on any conditionally-rendered control |
   | The menu is closing anyway (the row was activated, not dismissed) | no intervention — `Menu.Root`'s own close path returns focus to the trigger |

   Deliberately **not** the trigger: dismissing one notification is not a request to leave the menu,
   and closing it would prevent dismissing several in a row — the actual use case.

   **Implementation:** keep `dismissNotification`'s existing target resolution verbatim
   (`:98–99` — capture the neighbour's id *before* the state update, resolve it by
   `data-notification-dismiss` after), and replace only the `window.setTimeout(…, 0)` wrapper
   (`:102–106`) with a layout effect keyed on the notification array, so focus lands in the same
   commit as the removal. **Never a timer** — §7.1's rule applies for the same reason it applies to
   `AnchoredPopover`: a queued focus call can land after a poll has changed the list again.

   **Criterion 14.9 asserts all three list cases.** This is the single most likely regression in §8
   and the least likely to be caught by eye.

6. **Typeahead needs an explicit `label` on these rows.** `Menu.Item` exposes
   `label?: string` — *"Overrides the text label to use when the item is matched during keyboard
   text navigation"* (verified in `menu/item/MenuItem.d.mts`). The notification rows render JSX
   (`<strong>` + `<span>` + `<small>`), not a plain string, so typeahead needs
   `label={n.title}` on each; the dismiss buttons render `×` and take
   `label={\`Dismiss ${n.title}\`}`. Without this, criterion 14.4's typeahead assertion fails.

`aria-expanded`/`aria-controls` on the trigger and the menu's accessible name are preserved; the
dismiss button's `aria-label` (`Topbar.tsx:154`) and its `data-notification-dismiss` hook are copied
across verbatim.

**API surface — all verified against the installed `1.7.0` type definitions.** An earlier revision
left `render` as "builder-verify"; it is now resolved, because it was resolvable by reading the
package:

| Fact | Source |
| --- | --- |
| Part set: `Root`, `Trigger`, `Portal`, `Positioner`, `Popup`, `Item`, `LinkItem`, `Group`, `GroupLabel`, `Backdrop`, `Arrow` | `menu/index.parts.d.mts` |
| `Menu.Root` accepts `modal` | `menu/root/MenuRoot.d.mts` |
| `Menu.Item` accepts `closeOnClick` (**default `true`**), `disabled`, `onClick`, `label` | `menu/item/MenuItem.d.mts` |
| `Menu.LinkItem` accepts `closeOnClick` (**default `false`**), `label`, `id` | `menu/link-item/MenuLinkItem.d.mts:16` (interface), default at `:28` |
| **`render` is explicitly declared**, typed `React.ReactElement \| ComponentRenderFn<…>` | `internals/types.d.mts`, on `BaseUIComponentProps` |
| `MenuLinkItemProps extends BaseUIComponentProps<'a', MenuLinkItemState, React.ComponentPropsWithRef<'a'>>` — so it inherits `render`, and its render-function props include a **ref** | `menu/link-item/MenuLinkItem.d.mts` |
| `Menu.Portal` accepts `container?: HTMLElement \| ShadowRoot \| RefObject<…> \| null` (§4.2a) | `menu/portal/MenuPortal.d.mts` |

**`render` is confirmed available and is the correct seam.** No ambiguity remains, and the
notification row stays a real `<a href>` (criterion 14.11).

#### `InternalLink` must forward its ref — a required prerequisite

`MenuLinkItem` is a `ForwardRefExoticComponent` whose render props are
`React.ComponentPropsWithRef<'a'>`: Base UI needs the **actual anchor DOM node** for item
registration, roving focus and typeahead. Reading the current source
(`portal/apps/web/src/components/InternalLink.tsx`), it does **not** provide one:

```tsx
type InternalLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

export function InternalLink({ to, onClick, ...props }: InternalLinkProps) {
  return <a {...props} href={to} onClick={…} />;
}
```

`AnchorHTMLAttributes` does not include `ref`, so `<InternalLink ref={…}>` is a **type error** today.
At runtime it would happen to work — this repo is on **React 19.2.8**, where `ref` is an ordinary
prop for function components, so an undeclared `ref` would fall into `...props` and be spread onto
the `<a>`. Relying on that accident is not acceptable in a plan; the type must say what the runtime
does.

**The fix is one line, and no `forwardRef` is needed on React 19:**

```tsx
// was: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }
type InternalLinkProps = React.ComponentPropsWithRef<"a"> & { to: string };
```

The existing `{ to, onClick, ...props }` destructure then carries `ref` through the existing
`<a {...props}>` spread unchanged — **no other edit to `InternalLink`**, and no behavior change for
its many existing consumers, which simply never passed a `ref`.

**Verification:** `npm run typecheck` covers it, and criterion 14.11's DOM assertion confirms the
rendered row is an `<a href>` that Base UI has registered (it receives roving focus under ArrowDown).
Because this touches a shared component used app-wide, criterion 23 requires confirming no existing
`InternalLink` call site changes behavior.

#### Stripping generated source

`base-sera`'s menu source arrives with stock defaults. Strip on generation, per TB8-01 §D-8 and
E-11: every `rounded-md`/`rounded-lg`, `shadow-sm`, `ring-offset-background`, `focus:ring-2`,
`animate-in`, `fade-in-0`, `zoom-in-95`, `slide-in-from-*`, `active:scale-*`, `hover:bg-accent/50`,
and every `dark:` branch. **A stock aesthetic surviving into the diff is a review failure, not a
nit.**

### 8.2 Paint

Panel: §7.3's shared classes with `max-w-[min(360px,calc(100vw-var(--space-5)))]` and
`max-h-[min(520px,calc(100dvh-var(--space-9)))]` — the live values from `app.css:74`, tokenised.
**`--shadow-lg` → `--shadow-md`** (defect B; TB8-01 §11.1 flagged this exact rule).

| Element | Was | Becomes |
| --- | --- | --- |
| `__head` (`:75`) | `padding: 13px 14px` | `px-[var(--space-4)] py-[var(--space-3)]` + bottom hairline |
| `__head button` (`:76`) | bespoke bare button | `Button variant="text"` |
| `__row:hover` / `.is-unread` (`:78`) | **the same `--paper-100`** — hovering a read row makes it look unread | **split:** hover → `hover:bg-secondary`; unread → a **3px ink leading rule**, `[border-left-style:solid] border-l-[length:var(--border-width-rule)] border-l-primary`, reusing TB8-01 §9's exact unread device so the app has *one* vocabulary for "unread". Read rows get a transparent 3px leading border so nothing shifts. |
| `__item strong` (`:80`) | `font-size: 13px; font-weight: 500` — **faux-bold** (I) | `text-[length:var(--text-sm)] font-normal !text-foreground` |
| `__item span` (`:81`) | `12px`, `line-height: 1.4` | `text-[length:var(--text-xs)] leading-[var(--leading-normal)] text-foreground-secondary` |
| `__item small` (`:82`) | `10px` | `text-[length:var(--text-2xs)] text-muted-foreground` |
| `__dismiss` (`:83`) | `width: 34px`, `font-size: 18px` | `size-[44px]` /* 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token */, `[font:var(--type-mono)] text-[length:var(--text-md)]`; keeps its `aria-label` (`Topbar.tsx:154`) verbatim |
| `__trigger` (`:70`) | `34×34` | `size-[44px]` at ≤720; hover `bg-secondary` replaces the raw `--paper-100` |
| `__badge` (`:73`) | `color: #fff` — **a raw literal**, the last hard-coded colour in the bar | `bg-destructive !text-destructive-foreground`; `font-size: 9px` → `text-[length:var(--text-2xs)]` |
| `__empty` (`:85`) | `13px` | `px-[var(--space-4)] py-[var(--space-5)] text-[length:var(--text-sm)] text-muted-foreground` |
| `.topbar__mobile-menu` (`:617`) | `min-width: min(290px, …)`, **no `max-width`** | §7.3's bounded panel; items `min-h-[44px]`; hover/`.is-active` split per §10.3 |

**Scope fence.** `.topbar` itself, `.topnav`, the identity block, and the impersonation banner are
**untouched** — TB8-01 §11.1's glassmorphism and nav-underline findings stay deferred to the
shared-shell owner. This section changes only what is inside the two menu popups and their two
triggers.

---

## 9. Preserved as-is

### 9.1 `MentionAutocomplete` — paint only

Per §2's evidence. **No structural, positioning, focus, or keyboard change.** The imperative
`handleKeyDown` contract (`MentionAutocomplete.tsx:29–38`), `onAccessibilityChange`, the
`aria-activedescendant` id scheme (`:40`), and `onMouseDown` preventDefault on options (`:51`,
which holds the editor selection) are all untouched. Four token fixes in `app.css:537–542`:

```css
.mention-autocomplete { border: var(--border-width-hair) solid var(--border-hairline);
                        background: var(--bg-surface); box-shadow: var(--shadow-md); }
                        /* was an invented `0 8px 20px color-mix(…13%…)` — defect B */
.mention-autocomplete__option { min-height: 44px; padding: var(--space-2) var(--space-3); }
                        /* was 7px 8px, no min-height — defect K */
.mention-autocomplete__status { padding: var(--space-2); font-size: var(--text-xs); }
                        /* was 8px / 13px */
```
plus §10.3's highlight split for `.is-active` and a `:focus-visible` ring on `__option`, which has
none today.

### 9.2 `Select` — one token

`ui/select.tsx:61` changes in three ways, together closing defect H-ii and making §4.2a real:

```tsx
const container = React.useContext(OverlayContainerContext);   // null at page level
<SelectPrimitive.Portal container={container}>
  <SelectPrimitive.Positioner
    className="z-[var(--z-popover)] outline-none"   // was z-20
    positionMethod={container ? "fixed" : "absolute"}
    alignItemWithTrigger={container ? false : undefined}
    sideOffset={4}
    collisionPadding={8}
  >
```

**Page-level behavior is byte-identical to what TB8-01 shipped** — `container` is `null`,
`positionMethod` falls back to its `'absolute'` default and `alignItemWithTrigger` to its `true`
default, so only the z class changes. The two conditional props engage **only** inside a dialog,
which is a context `Select` has never yet been rendered in. Everything else about TB8-01's `Select`,
including its ten-item accessibility contract, is untouched.

### 9.3 `.kanban-move-popover` contents

Kanban carve-out honoured; see §7.5.

---

## 10. The overlay contract — one table per axis

This is the artefact later TB8 candidates inherit. Every row is a rule, not a suggestion.

### 10.1 Elevation and boundary

| Overlay class | Shadow | Scrim | Border | Radius |
| --- | --- | --- | --- | --- |
| Anchored to a trigger (popover, menu, select popup, autocomplete) | `--shadow-md` | none | 1px `--border-hairline` | 0 |
| Detached, page-level (dialog) | `--shadow-lg` | `--scrim-overlay` + 3px blur | 1px `--border-hairline` | 0 |
| Anything else | **no shadow** | — | — | — |

No overlay may invent a shadow. Two did (`app.css:529,537`); both are deleted.

### 10.2 Motion

| | Enter | Exit |
| --- | --- | --- |
| Dialog scrim | opacity, `--overlay-enter` | opacity, `--overlay-exit` |
| Dialog panel | opacity + `translateY 12px→0`, `--overlay-enter` | reverse, `--overlay-exit` |
| Popover / menu | opacity + `translateY 4px→0`, `--overlay-enter` | reverse, `--overlay-exit` |
| Autocomplete | none (it tracks a caret; movement would read as lag) | none |

Every motion utility is `motion-safe:` prefixed. No scale, no bounce, no spin, no infinite loop, no
`transition: all` (`transition-[opacity,translate]` only — `all` would animate the `translate` used
for positioning and the geometry `shift()` writes each frame).

**Direction-specific durations are mandatory, not a nicety.** An earlier revision wrote one
`duration-[var(--dur-base)]` for both directions while §6.0's hook unmounts after **120ms**. A 220ms
exit inside a 120ms unmount window is cut off at roughly its halfway point — the dialog would vanish
mid-fade, which looks worse than no exit motion at all. The base classes therefore carry the **exit**
timing (`--dur-fast` / `--ease-exit`) and the `data-open:` variants override to the **entrance**
timing (`--dur-base` / `--ease-entrance`). Reading it as CSS: while `data-open` is present the
element transitions in at 220ms; the moment it is removed the base rule applies and it transitions
out at 120ms — exactly the window `isMounted` holds open.

This makes three values one contract, and criterion 21 asserts all three agree:

| | CSS | JS |
| --- | --- | --- |
| enter | `data-open:motion-safe:duration-[var(--dur-base)]` = 220ms | `duration.open: 220` |
| exit | `motion-safe:duration-[var(--dur-fast)]` = 120ms | `duration.close: 120` |

### 10.3 Option-list states — the defect-C fix, applied once

Five lists share this table: `.project-team-picker__option`, `.kanban-move-popover__option`,
`.subtask-popover__member`, `.mention-autocomplete__option`, `.topbar__notification-row` (§8).

| State | Paint | Rationale |
| --- | --- | --- |
| default | `bg-transparent text-foreground` | |
| **hover** | `bg-secondary` (= `--paper-100`) | readme: *"surfaces tint up one paper step"* |
| **highlighted** (keyboard: `.is-active` / `[aria-current="true"]` / `[aria-selected="true"]`) | keeps its own background **and** gains `[border-left-style:solid] border-l-[length:var(--border-width-bold)] border-l-primary`; non-highlighted options carry the same 2px border in `transparent` so nothing shifts | **structural, so it composes with hover instead of colliding with it** — the whole of defect C |
| hover **and** highlighted | both: paper tint **and** the ink rule | the previously-impossible state becomes legible |
| **selected** (a committed value) | `!text-signal-positive` + the existing `✓` glyph | already correct in the team picker; generalised |
| **press** | `active:bg-surface-sunken` | a list row is not a button; no 1px nudge (TB8-01 §8.1's reasoning) |
| **focus-visible** | `focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring focus-visible:-outline-offset-2` | **inset** — options sit flush inside a bordered panel with `overflow-auto`; an outward ring is clipped |
| **disabled** | `disabled:bg-surface-sunken disabled:!text-foreground-secondary disabled:cursor-not-allowed` | 7.4:1 (TB8-01 §7.4's computation); `--text-muted` on `--bg-sunken` is only 2.9:1 |
| **error** | `role="alert"` message in `text-destructive` **plus** a `--border-width-rule` oxblood leading rule on its container | not colour alone (WCAG 1.4.1); TB8-01 §10.2's device |

Base UI's `Select` already expresses this via `data-[highlighted]`/`data-[selected]`
(`ui/select.tsx:84`) and is **left alone** — its trigger-committed model has no pointer/keyboard
ambiguity to resolve.

### 10.4 Focus, dismissal and keyboard

| | Dialog | Popover | Menu (§8) | Autocomplete |
| --- | --- | --- | --- | --- |
| Trap | **yes** (`modal`) | no (`modal={false}`; Kanban Move passes `modal`) | no | no |
| Initial focus | `initialFocus` prop; `ConfirmDialog` passes `0` (the panel) | `0` or a named ref | first (or last on ArrowUp) item | none — focus stays in the editor |
| Escape | closes, `preventDefault` + `stopPropagation`, library restores focus | closes, **synchronous** `.focus()` on reference — §7.1 | closes, **synchronous** restore | clears results, `return true` |
| Outside click | overlay press-contained (§6.1.2) | `pointerdown` boundary with both exemptions | `pointerdown` boundary | composer-owned |
| Outside focus | trapped | `focusin` boundary with both exemptions | `focusin` boundary | n/a |
| `returnFocus` | `true` | **`false`** — mandatory | `false` | n/a |
| Arrow keys | n/a | consumer-owned where a list exists | **primitive-owned** | imperative handle |
| Scroll lock | **yes** | no | no | no |
| `aria-modal` | `true` | absent | absent | absent |

### 10.5 Touch geometry at ≤720px

Every interactive element inside any overlay: `min-h-[44px]` and, for icon-only controls,
`size-[44px]`, each carrying `/* 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token */`
per TB8-01 §1.4's literal rule. **Note the corrected attribution in §6.3: 44px is WCAG 2.5.5
(Enhanced, AAA), not 2.5.8 (Minimum, AA, which is 24px).** It is applied here by the dialog footer's
`max-[720px]:[&>*]:min-h-[44px]`, not by `w-full` alone. Applies to option rows, footer buttons, dialog inputs, dismiss buttons and
menu triggers. Panels bound to `100dvh`, never `100vh`.

---

## 11. Deferrals recorded for later candidates

### 11.1 Touched-but-not-owned

- **`.toasts` `z-index: 95 → 98`** (`app.css:781`) — one declaration, forced by `--z-dialog`
  taking 95. No paint change. The class itself stays for `Admin.tsx` / `ProjectWorkspace.tsx`
  (TB8-01 §1.5).
- **`.rich-text__toolbar-button:focus-visible`** (`app.css:511`) — the link-dialog halves of the
  selector are removed with the dialog; the toolbar half stays untouched.

### 11.2 Findings preserved for their owners

- **Popover-inside-popover nesting is wired but unverified** (§4.2a's scope note). `AnchoredPopover`
  and `Menu` both read `OverlayContainerContext`, but no in-scope popover contains a `Select` or a
  `Menu`, so only the *dialog* nesting case is proven by criterion 23. The first candidate that puts
  a menu or select inside a popover — most likely *notification bell/preferences/Admin delivery UI*
  or *Workspace rail* — owns proving it, and should reuse criterion 23's shape rather than inventing
  a new one. Note the one structural difference it will meet: `AnchoredPopover`'s panel **does**
  carry `overflow-auto` (§7.3), so a popover acting as a nesting host needs the same
  scroller/slot split `Modal` takes in §6.3, not just the context.
- **Calendar 44px overrides** (`production-calendar.css:237,246`) become redundant under §6.8 but
  are **deliberately left in place** — TB5C matched-evidence contract.
- **`tokens/fonts.css` is imported by nothing** — `index.css:9` loads `styles/fonts.css` instead,
  and grep finds no other importer. A whole dead stylesheet, discovered during this release's
  citation sweep. Same owner as the duplicate `.sr-only` below — the *dead selectors and final
  base/Preflight decision* candidate. **Not deleted here**, for the same reason: it wants a
  whole-repo dead-file sweep, not an opportunistic removal.
- **`.sr-only` declared twice, identically** (`app.css:1017` and `:1127`) — defect M. One is dead.
  Belongs to the *dead selectors and final base/Preflight decision* candidate; **not deleted here**,
  because the grep-before-delete rule wants a whole-file dead-selector sweep, not an opportunistic
  one.
- **`.topbar`/`.topnav` glassmorphism, nav-underline channel, faux-bold** — TB8-01 §11.1, still
  deferred, and §8 explicitly does not touch them.
- **`.viewer` / `.compare` / `.actionbar` / `.drawbar` / `.viewer__panel-scrim`** — Lightbox
  candidate. `.viewer__panel-scrim`'s `rgba(10,10,10,.52)` should become `--scrim-overlay` when
  that candidate runs; the token now exists for it.
- **`.project-collaboration--overlay`** — Collaboration candidate. With §6.5 approved, it is the
  app's best candidate for a *real* sheet once that pattern proves out here.
- **`.chip { transition: all }`** — TB8-01 §11.4, unchanged.

---

## 12. Drift catalogue, migration mechanics and acceptance criteria

### 12.1 Stock-default and raw-palette drift

The roadmap forbids *stock shadcn appearance* and *raw framework palette contract*.
**Grep-verified 2026-09-01: no raw Tailwind palette utility (`bg-gray-*`, `text-slate-*`, …) exists
anywhere in `portal/apps/web/src`.** The contract is clean. Drift found on *this* surface:

| # | Drift | Where | Replacement |
| --- | --- | --- | --- |
| E-1 | Four raw `rgba(10,10,10,…)` scrims at three different alphas | `app.css:764,528,1078` (+`:843` deferred) | `--scrim-overlay` — §4.2 |
| E-2 | Two invented `box-shadow` values bypassing the token scale | `app.css:529,537` | `--shadow-md` — §10.1 |
| E-3 | `--shadow-lg` (dialog elevation) on four anchored popovers | `app.css:74,266,583,1232` | `--shadow-md` — §10.1 |
| E-4 | `scale(.98)` entrance — the only scale in the product, against the readme's motion rule | `@keyframes pop`, `app.css:828` | `translateY` only — §6.4 |
| E-5 | `color: #fff` raw literal | `app.css:73` | `!text-destructive-foreground` — §8.2 |
| E-6 | `font-weight: 500` on a font shipping only 400 → faux-bold | `app.css:80,274` | `font-normal` + hierarchy by colour — §7.5, §8.2 |
| E-7 | Off-scale type (30/13/12/10/9px) and off-grid spacing (7/8/9/10/13/14px) across nine overlay blocks | §1.2 J | tokenised throughout §§6–9 |
| E-8 | Hover and keyboard-highlight painted identically | `app.css:78,270,540,587` | §10.3 |
| E-9 | Ad-hoc z-index with two live inversions | §1.2 H | `--z-*` ladder — §4.2 |
| E-10 | Touch targets below 44px in six overlay controls | §1.2 K | §10.5 |
| E-11 | Stock shadcn classes arriving with any generated source | `menu.tsx` (§8) | Strip on sight: `rounded-md`, `rounded-lg`, `shadow-sm`, `ring-offset-background`, `focus:ring-2`, `animate-in`, `fade-in-0`, `zoom-in-95`, `slide-in-from-*`, `active:scale-*`, `hover:bg-accent/50`, every `dark:` branch. **A stock aesthetic surviving into the diff is a review failure, not a nit.** (TB8-01 D-8.) |
| E-12 | Non-existent `border-*-solid` utilities compiling to nothing with Preflight off | §§6–10 | Arbitrary per-side style property — TB8-01 §1.3 |

### 12.2 Selectors deleted, and the grep rule

**TB1/TB8-01's rule carries forward verbatim: re-run the repo-wide consumer grep immediately before
removing any selector; only a selector with zero remaining source consumer may be removed; and
a `querySelector` in a test file is a consumer.** Grep run 2026-09-01, to be re-run at build:

| Selector | Consumers | Disposition |
| --- | --- | --- |
| `.scrim`, `.modal`, `.modal--wide`, `.modal__head/__body/__foot` (`app.css:764–772`) | `Modal.tsx` only; **`ConfirmDialog.dom.test.tsx:53` queries `.modal__body`** | → Tailwind; **delete**, but `.modal__body` stays as a class attribute (no CSS rule) so the test hook survives |
| `.admin-modal*` (`:1078–1080`) | `Admin.tsx:465` only — re-grep `Admin.dom.test.tsx` | **delete** after §6.6 |
| `.rich-text__link-modal/__dialog/__backdrop/__dialog-head/__dialog-actions` (`:527–535`) | `RichTextEditor.tsx` only — re-grep `RichTextEditor.dom.test.tsx` | **delete** after §6.7 |
| `.rich-text__link-error` (`:536`) | `RichTextEditor.tsx:375` | **keep the element**, tokenise the rule |
| `.project-team-picker` panel properties (`:266`) | `ProjectTeamControl.tsx`; **`ProjectTeamControl.dom.test.tsx:71,188` query it** | panel properties move to `AnchoredPopover`; **the class stays on the content wrapper as a test hook** |
| `.project-team-picker__*` (`:267–276`) | as above | **keep, tokenised in place** |
| `.subtask-popover` panel properties (`:1232`), `.kanban-move-popover` panel properties (`:583`) | `AnchoredPopover` renders both | panel properties **delete**; content selectors **keep, tokenised** |
| `@keyframes pop` (`:828`) | `.modal` only | **delete** |
| `@keyframes fade` (`:827`) | TB8-01's skeleton | **keep** |
| `@keyframes slidein` (`:829`) | toasts | **keep** |
| `.topbar__notification-*`, `.topbar__mobile-menu` | `Topbar.tsx`; **`ProjectCollaborationPanel.dom.test.tsx:464,466,470,472` query both** | §8 only, and the classes stay as test hooks |
| `.mention-autocomplete*` | `MentionAutocomplete.tsx` | **keep** — paint only |
| `.sr-only` duplicate (`:1127`) | — | **not touched here** — §11.2 |
| `.button`, `.button--*`, `.empty`, `.ey`, `.serif`, `.muted` | app-wide | **stay**; these overlays stop using them |

**46 test-file `querySelector` hits on overlay classes** were counted in the survey. Every one must
be enumerated at build time and either kept as a class-only hook or migrated to a role/text query.
**Never loosened, never deleted.**

**One test assertion the "keep the hook" rule above does not save**, called out because it will go
red and must be *migrated, not loosened*: `ConfirmDialog.dom.test.tsx:53` asserts `.modal__body`'s
`innerHTML` is **exactly** `"<p>This cannot be undone.</p>"`. §6.1's `describedBy` work (§12.3
item 6) adds an `id` to that `<p>`, so the string becomes `"<p id=\"…\">This cannot be
undone.</p>"` — carrying a `useId()` value that is not a stable literal. Migrate it to query the
`<p>`, assert its text, and assert the dialog's `aria-describedby` resolves to that same `id` —
which is the property §6.1 item 4 actually adds, and a stronger assertion than the `innerHTML`
equality it replaces. Criterion 14(d) covers the same ground.

### 12.3 Mechanical edits enumerated

Spelled out so the builder improvises nothing (TB8-01 §8.2's precedent):

1. `AnchoredPopover.tsx` — add `useTransitionStatus`, return `mounted`, add `label` prop, add panel
   classes, and `root={container}` from `OverlayContainerContext` on its `FloatingPortal` (§7.2
   addition 4 — `null` at every current call site). **Lines 17, 27, 29–30, 39–44, 57 unchanged**
   (§7.1).
2. `SubtaskChecklist.tsx:103,122,133` — `{open && <AnchoredPopover` → `{mounted && <AnchoredPopover`
   (three sites, plus `:78,:115,:130` destructuring `mounted` from the hook).
3. `ProjectKanbanBoard.tsx:149,210` — same two edits, and **nothing else in that file** (§7.5).
4. `ProjectTeamControl.tsx` — §7.4's delete/replace; `setTrigger` (`:69–72`) rewired, not inlined.
5. `Modal.tsx` — §6.0's lifecycle (`open` prop, `useTransitionStatus`, `isMounted` gate,
   `returnFocus` prop) and §6.1's five structural changes, plus §6.3's panel/`.modal__scroll` split
   and §4.2a's nested-overlay slot + `OverlayContainerContext`.
5a. **`ProductionCalendar.tsx`** — retention refs and open-tokens for all three dialogs, `open`
   threaded at `:1581`, `:1582`, `:1583`; the ScheduleEditor composite key preserved verbatim.
5b. **`ProductionCalendarMoveDialog.tsx:47`**, **`ProductionCalendarFoldChoice.tsx:22`**,
   **`ProductionCalendarScheduleEditor.tsx:145`** — each renders `<Modal>` unconditionally, so each
   accepts a new `open` prop and passes it straight through. No other change to any of the three.
   *(An earlier revision omitted these four files entirely — the largest consumer group in the
   release — from a list that claims the builder improvises nothing. The fresh-Opus gate review
   caught it.)*
6. `ConfirmDialog.tsx:15` — add an `id` to the `<p>` and pass `describedBy`.
7. `Admin.tsx:465` — §6.6.
8. `RichTextEditor.tsx:275–290,330–338,370–378` — §6.7 (both focus owners, not just the keydown handler).
9. `ui/select.tsx:61` — one class.
10. `tokens/colors.css`, `tokens/spacing.css` — §4.2/§4.3's four declarations.
11. `app.css` — deletions and in-place tokenisation per §12.2.
12. `Topbar.tsx`, `ui/menu.tsx` — §8: the new `Menu` primitive (including `Menu.Portal`'s
    `container` + `positionMethod` pair from `OverlayContainerContext`, `null` at both call sites),
    both menus migrated onto it, and §8.2's paint. No edit to `.topbar`, `.topnav`, the identity
    block or the impersonation banner.
13. `components/OverlayContainerContext.tsx` (new, ~5 lines) — `React.createContext<HTMLElement |
    null>(null)`, the single owner §4.2a's four consumers import. Its own file so `Modal`,
    `AnchoredPopover`, `ui/menu.tsx` and `ui/select.tsx` do not import each other.

### 12.4 Acceptance criteria

1. All sixteen rows of the §5 matrix captured before and after at their marked viewports, matched
   pairs, and reviewed visually — assertions catch geometry, not an overlay that has become
   unreadable.
2. **Stacking proven, not assumed:** row 3 (confirm over a checklist popover), row 6 (Admin dialog's
   scrim over the sticky top bar), and row 16 (a `Select` popup over its containing dialog) each
   verified in a real browser. These are defects H-i/H-ii/H-iii and this is their closure gate.
3. **Every interactive element in every overlay shows the 2px ink focus ring** at offset 2, or inset
   −2 where §10.3 specifies: dialog footer buttons, dialog inputs and radios, the RTE link field and
   its three actions, the Admin Close button, every option in all five lists, the team-picker search
   field, both menu triggers and every menu item (§8).
4. **Scroll lock verified:** with a dialog open at 390×844, wheel and touch produce no scroll of the
   document behind it, and closing restores the exact prior `scrollY` (±1px).
5. **Press-contained dismissal verified:** press inside the Calendar Move dialog's date input, drag
   past the panel edge, release on the scrim → **the dialog stays open** and the field keeps its
   value. Defect F's closure gate.
6. **`[data-confirm-modal-root]` is present, in the same position, with the same attribute name**,
   and `AnchoredPopover.tsx:27`'s `closest()` exemption still matches it — asserted by a test that
   opens a checklist popover, triggers `confirm()` from inside it, clicks the confirm dialog, and
   asserts the popover is **still open**.
7. **The TB0 synchronous focus restoration is intact.** `AnchoredPopover.tsx:39–44` contains no
   `setTimeout`, `queueMicrotask`, `requestAnimationFrame`, or effect-deferred `.focus()` —
   grep-verified — and a test asserts that after Escape, `document.activeElement` is the trigger
   **within the same task**, with no timer flush. Every §7.1 row re-verified.
8. **Exit motion does not defer focus.** With `mounted`-based unmounting, Escape still closes *and*
   restores focus synchronously; the popover's DOM removal may lag, focus may not.
9. **No `border-t-solid`/`-b-`/`-l-`/`-r-`/`-x-`/`-y-solid` anywhere in the diff** — grep-verified
   (TB8-01 §1.3).
10. **No raw Tailwind palette utility and no raw Quincy-ramp utility** (`bg-gray-*`, `text-slate-*`,
    `bg-paper-*`, `border-greige-*`, `bg-ink-*`) and **no bare numeric spacing/type/radius utility**
    (`p-5`, `text-sm`, `rounded-md`, `z-20`) standing in for a token — grep-verified.
11. **No selector deleted without a fresh repo-wide grep showing zero consumers, tests included.**
    The §12.2 table re-run at build time and the result recorded in the PR.
12. **No new runtime dependency.** Neither `package.json` gains an entry; `cva` is not introduced;
    `@floating-ui/react` stays at 0.27.16 and `@base-ui/react` at 1.7.0. **`ui/menu.tsx` is a second
    `@base-ui/react` consumer by design (§2.1)** — that is an intended use of an installed
    dependency, not a new one, and the earlier "gains no new consumer" claim is withdrawn.
    `tailwindcss/preflight.css` still absent from built CSS; built-CSS size delta recorded (this
    release should *reduce* it — five CSS blocks retire).
13. `npm run typecheck` and `npm run build -w @quincy/web` green; `npm run test --workspaces` plus
    `npx vitest run --config packages/shared/vitest.config.ts` green. Attention to
    `ConfirmDialog.dom.test.tsx`, `ProjectTeamControl.dom.test.tsx`,
    `ProjectTeamControl.confirm.dom.test.tsx`, `SubtaskChecklist*.dom.test.tsx` (three files),
    `ProjectKanbanBoard.dom.test.tsx`, `RichTextEditor.dom.test.tsx`,
    `ProductionCalendarMoveDialog/FoldChoice/ScheduleEditor.dom.test.tsx`, `Admin.dom.test.tsx`,
    `ProjectCollaborationPanel.dom.test.tsx`, `Topbar.dom.test.tsx`.
14. **Accessibility test matrix, release-blocking**, matching the rigor TB8-01 §2.2 demanded of
    `Select`. Per primitive:
    - **`Modal`:** (a) focus moves into the dialog on open and is trapped both directions;
      (b) Escape closes and focus returns to the element that opened it; (c) outside press-contained
      dismissal per criterion 5; (d) `role="dialog"`, `aria-modal="true"`, `aria-labelledby`
      resolving to the visible title, and `aria-describedby` resolving to the confirm message;
      (e) background scroll locked; (f) footer buttons reachable and ≥44px at 390; (g) the
      `confirm()` queue still serialises — two `confirm()` calls resolve in order, one dialog at a
      time (`lib/confirm.ts`).
    - **`AnchoredPopover`:** (a) opens on trigger activation with `initialFocus` honoured;
      (b) Escape closes with synchronous focus return (criterion 7); (c) outside pointerdown closes
      **without** returning focus; (d) `focusin` outside closes; (e) neither a focus guard nor the
      confirm root counts as outside (criterion 6); (f) `flip`/`shift` keep it inside the viewport
      at 390 with the trigger near each edge; (g) the team picker's Arrow/Enter list navigation
      still moves `aria-current` and commits the right candidate; (h) a disabled (pending) option
      is not activatable and is visibly disabled at ≥4.5:1.
    - **`Menu` (§8) — at least the rigor TB8-01 §2.2 required of `Select`.** Each of the following
      is a concrete required test in `Topbar.dom.test.tsx` (plus the real-browser items in
      criterion 18), not a general statement:
      1. Trigger exposes an accessible name; the popup exposes `role="menu"` with its label, and
         every item `role="menuitem"` — the roles the current markup declares are preserved.
      2. **Opens on click/tap** of the trigger, and closes on a second click.
      3. Opens on `Enter`, `Space` and `ArrowDown` from a focused trigger, highlighting the **first**
         item; opens on `ArrowUp` highlighting the **last**.
      4. `ArrowDown`/`ArrowUp` move the highlight and **wrap** at both ends; `Home`/`End` jump to
         first/last; printable-character typeahead reaches a matching item.
      5. **Activation:** `Enter` on a notification item fires the same `markNotificationRead` call
         the current `onClick` fires, with the identical id, and the menu closes. `Enter` on
         "Mark all read" and on a dismiss button fires its handler and **leaves the menu open**
         (`closeOnClick={false}`).
      6. `Escape` closes **and returns focus to the trigger**.
      7. **Outside click and outside tap** dismiss without activating anything.
      8. **Disabled trigger does not open at all** — no popup, no highlight, no focus trap.
      9. **Focus continuity after dismissing the focused item** — §8.1 item 5's three cases, each
         asserted: dismissing a middle row moves focus to the **next** remaining item; dismissing
         the last row moves it to the **previous**; dismissing the only row leaves focus on **the
         open menu popup** (never `<body>`, and never the conditionally-rendered "Mark all read"
         button). Plus: focus lands **synchronously** — the assertion must pass without advancing
         any timer, which is what proves the `setTimeout(0)` is gone.
      10. **Dynamic list:** a poll that replaces the notification array while the menu is open does
          not strand the highlight on a removed item or reset it to index 0 unnecessarily.
      11. **Anchor semantics preserved:** notification rows that navigate are still real `<a href>`
          elements (`Menu.LinkItem`) — asserted in the DOM and by a middle-click/⌘-click check in
          the Agy pass, matching TB8-01 §2.1's acceptance wording.
      12. **Touch reachability at 390×844:** trigger ≥44px, popup fully within the viewport, every
          item and dismiss button tappable.
      13. The mobile menu's items (`Topbar.tsx:174–177`) keep their `is-active` marking and
          `Sign out` still calls `handleSignOut`.
      14. The dismiss button's `aria-label` (`Dismiss notification: …`) and its
          `data-notification-dismiss` attribute are unchanged.
    - **Cross-cutting:** with `prefers-reduced-motion: reduce`, no overlay animates in or out and
      every one still opens, closes and restores focus correctly.
15. **RTE selection survives the link-dialog round trip** — open the link dialog from a text
    selection, cancel, and the selection is still there and still linkable. Unit test plus a
    real-browser check (§6.7's caveat).
16. **No behavior regression in the four `Modal` consumers.** `ConfirmDialog`'s `data-testid`s
    (`confirm-modal`, `-cancel`, `-confirm`), the three Calendar dialogs' `data-testid`s and their
    `data-modal-variant="calendar"` attribute, and every `initialFocus` value are unchanged —
    verified by diffing a DOM snapshot of each dialog open, before and after.
17. **Real-browser drag verification — MANDATORY, not waived.** §7.2/§12.3 edit
    `ProjectKanbanBoard.tsx:149,210`, so `docs/lessons.md:901–902` applies unconditionally and
    TB8-01 §12.11's precedent is matched exactly: **pointer *and* keyboard cross-column drag, on a
    column holding ≥2 cards, in a real browser** — not a mocked `DndContext`, not a generic Agy
    pass. The card lands in the target column, no white screen, no lost focus, announcements fire.
    Additionally, because these two edits specifically change *when the Move-to popover unmounts*:
    open Move-to, dismiss it, and immediately start a drag on the same card — no stale portal, no
    focus stranded on a removed node.
18. **Agy QA pass** per `docs/Subagent-Orchestration.md` §2.8–§2.10 covering the §5 matrix, with
    criteria 2, 4, 5, 7 and 15 tracked as their own checklist lines — happy-dom does not reproduce
    scroll locking, pointer-drag dismissal, floating-ui focus timing, or TipTap selection, exactly
    as TB8-01 §12.18 found for Base UI's Escape/Space paths.
19. **`docs/lessons.md` gains one entry** recording the synchronous-focus-restoration rule as a
    *primitive-level invariant*, not a one-off bug fix — it has now been re-derived twice
    (`08f4653`, and this plan's §7.1) and the next person to touch `AnchoredPopover` should find it
    in lessons rather than in a commit message.
20. **Drift-Register rows updated** for every E-row in §12.1 that maps to an existing entry;
    E-rows with no existing row are added, with evidence filenames.
21. **Transition durations match their tokens.** `useTransitionStatus`'s
    `{ open: 220, close: 120 }` (§6.0) equals `--dur-base` and `--dur-fast` (`spacing.css:47–48`),
    and both literals carry their `/* === --dur-* */` comment. If a token moves, this assertion
    fails — that is the point. Verified by a unit test reading the constants, not by eye.
22. **Every `Modal` consumer's open→close cycle is exercised**, because §6.0 changes how all four
    mount. For `ConfirmModalHost`, `Admin`, the RTE link dialog and each Calendar dialog: the dialog
    appears on open, **disappears completely after the close transition** (no orphaned portal node,
    asserted after advancing timers past 120ms), and re-opens cleanly a second time. Plus the
    §6.0 retention property: a `confirm()` resolved while its dialog is still visually closing does
    not block or corrupt the next queued `confirm()`. **And the retention/`key` pair (§6.0's Calendar
    table): open dialog A, close it, open dialog B — B shows B's data, with no flash of A's.**
23. **Nested overlays stack, clip and trap correctly (§4.2a).** The mechanism the gate review
    blocked revision 2 over; **every part is verified in a real browser, none inferred:**
    (a) a `Select` opened from inside an open dialog renders **above** the dialog and is fully
    operable — §5 row 16;
    (b) its popup is **not clipped** by the panel or the overlay — open it near the panel's bottom
    edge, where an `absolute`-positioned popup would be cut off, and confirm the full list shows;
    (c) the popup is **inside the dialog's focus trap** — Tab from the last dialog control cycles
    within the dialog and never reaches the page behind;
    (d) **overlay scrolling:** with a dialog taller than the viewport, scroll the overlay with the
    `Select` open and confirm the popup tracks its trigger rather than detaching;
    (e) the **opposite nesting** still holds — a `confirm()` raised from inside a checklist popover
    renders above that popover (§5 row 3), which a naive z bump would have broken;
    (f) at all three viewports, and with `positionMethod="fixed"` confirmed active
    (`getComputedStyle(popup).position === "fixed"`) so the test cannot silently pass on the
    `absolute` default;
    (g) **Escape dismisses only the innermost overlay** — with the nested `Select` open, one Escape
    closes the `Select` and **leaves the dialog open**; a second Escape closes the dialog. This is a
    new interaction: the nested popup is now a DOM *and* React descendant of the panel, so its
    keydown reaches `Modal`'s `handleKeyDown` (`Modal.tsx:20–25`), which does not check
    `defaultPrevented`. It should already pass — Base UI's dismiss calls both `preventDefault()`
    and `stopPropagation()` on Escape unless `bubbles` is opted in, and nothing here opts in
    (verified in the installed `floating-ui-react/hooks/useDismiss.mjs`) — but it depends on
    library internals, so it is asserted rather than assumed. **If it fails, the fix is a
    containment guard in `Modal`'s `handleKeyDown`** (ignore an Escape whose `target` is inside the
    nested slot), *not* removing `stopPropagation` from `handleKeyDown`, which
    `ProjectCollaborationPanel.tsx:54` and `RichTextEditor` both depend on (§6.1).
    **If (b) or (d) fails, apply §4.2a's pre-authorised fallback** (drop the panel translate, make
    dialog motion opacity-only) and re-run — do not weaken the assertions. Note the fallback's own
    caveat in §4.2a: it can move (d)'s behavior, so re-verify (d) after taking it.
    Plus: no existing `InternalLink` call site changes behavior after §8.1's
    `ComponentPropsWithRef` widening — `npm run typecheck` green and the app's links still navigate.

---

## 13. Open questions — none

All four questions this plan raised at drafting were **resolved by owner decision 2026-09-01**, each
in favour of the plan's own recommendation. Every section is now committed, not conditional. The
resolutions are recorded here so the review trail shows what was asked and what was answered.

| Was | Resolution (owner, 2026-09-01) |
| --- | --- |
| **Q1 — Are the Topbar menus in scope?** TB8-01 §11.1 dropped the top bar by owner decision, and the roadmap has *notification bell/preferences/Admin delivery UI* as its own later candidate — yet `.topbar__notification-menu` / `.topbar__mobile-menu` are the app's only two `role="menu"` widgets and this candidate is named "menus". Options were (a) full scope, (b) paint only, (c) defer whole. | **Resolved: (a) — full scope, behavior and paint.** §8 is committed as written: the `Menu` primitive ships, closing defect L and removing the app's last `setTimeout(0)` focus restoration. §8's fence stays tight — the menu *popups* and their two triggers only; `.topbar`, `.topnav`, the identity block and the impersonation banner remain untouched and TB8-01 §11.1's glassmorphism/nav-underline findings stay deferred to the shared-shell owner. |
| **Q2 — Approve the ≤720px sheet presentation?** The roadmap requires owner approval for intentional evolution, and this was the plan's only one. | **Resolved: approved as written.** §6.5 is committed. The five `max-[720px]:` utilities in §6.2/§6.3 ship, and the app gains its first real sheet. The bug repairs bundled nearby (`dvh`, scroll lock, press-contained dismissal, 44px footer targets) were never contingent on this and ship regardless. No drag-to-dismiss, no handle, no rubber-banding. |
| **Q3 — May this plan create a `--z-*` token family?** TB8-01 §1.4's discipline is *"New values are not invented; the plan cites the existing token"*, and there is no existing z token to cite. | **Resolved: approved.** §4.2 is committed. Note the accuracy correction made at Sol review round 1: only `--z-popover: 90` is a traced codification; `--z-dialog: 95` and `--z-toast: 98` are **new intentional assignments**, each with its reasoning stated in §4.2's table. The owner's approval covers creating the family, so no further sign-off is needed — but the plan no longer describes all three as traced. Consumed as `z-[var(--z-dialog)]` with **no `@theme` mapping**, so it cannot collide with Tailwind's bare-integer `z-*` scale. |
| **Q4 — Does `Modal` absorbing two dialogs breach *no whole-app rewrite*?** §6.6/§6.7 rewrite JSX in `Admin.tsx` and `RichTextEditor.tsx`, files whose surfaces belong to later candidates; the conservative alternative was to take §6.6 and defer §6.7. | **Resolved: take both.** §6.6 and §6.7 are committed. This is primitive convergence, not surface work — neither edit touches a form field, validation rule, API call, or any layout outside the dialog's own box. **Acceptance criterion 15 is the explicit gate on §6.7's selection-restoration risk** (`docs/lessons.md:833`): if the RTE selection does not survive an open→cancel round trip in both the unit test and the real-browser check, §6.7 does not ship. |

**Nothing in this plan awaits an *owner* decision.** Sol review (pipeline step 2) is complete — two
rounds, then a self-edit past the ≤2-round cap. The first fresh-Opus gate's §4.2a mechanism blocker
and its eight must-fix items are all resolved, and the second fresh-Opus gate **approved the plan**
(see the status block at the top of this document for what that gate corrected). **Nothing remains
open: the next step is the build, pipeline step 4.**
