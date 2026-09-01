# TB8-02 drift register

Date: 2026-09-02. Source: TB8-02's own plan, §12.1's twelve `E-` drift rows (raw scrims, invented
shadows, off-scale type/spacing, the hover/highlight collision, ad-hoc z-index, sub-44px touch
targets, generated-shadcn residue, `border-*-solid`). None of these twelve map to an existing row
in `docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md` (that register's rows are all
`TB0-*` — pre-TB1 baseline drift, not overlay-primitive drift) or in `evidence/TB1/drift-register.md`
(Dashboard-shell-specific). No per-tracer-bullet drift-register directory exists for TB2–TB4's
successors (TB5A onward, including TB8-01) — this file follows `evidence/TB1/drift-register.md`'s
naming convention (`evidence/<bullet>/drift-register.md`) as the closest established precedent
rather than inventing a new one.

**Evidence basis.** Source file:line citations and the automated test suite, not live-browser
screenshots — TB8-02's own criterion 18 assigns visual/interaction verification (the §5 matrix,
criteria 2/4/5/7/15/17) to a real-browser Agy pass, which is out of scope for this implementation
session (no live app/browser available here). Each row below is disposed, not left `Unassessed`;
rows needing the Agy pass say so rather than claiming visual verification that did not happen.

## Register

| ID | §12.1 row | Where it lived | Disposition | Evidence |
| --- | --- | --- | --- | --- |
| **TB8-02-E-1** | Four raw `rgba(10,10,10,…)` scrims at three alphas | `app.css` `.scrim`, `.rich-text__link-backdrop`, `.admin-modal`, `.viewer__panel-scrim` (deferred) | **Fixed.** One token, `--scrim-overlay` (`color-mix(in srgb, var(--ink-900) 50%, transparent)`), consumed by `Modal`'s scrim class. `.viewer__panel-scrim` stays deferred to the Lightbox candidate (out of scope), token now exists for it to adopt. | `tokens/colors.css` (new `--scrim-overlay`); `Modal.tsx`'s `SCRIM` constant; `.admin-modal`/`.rich-text__link-backdrop` CSS blocks deleted from `app.css`. |
| **TB8-02-E-2** | Two invented `box-shadow` values bypassing the token scale | `app.css:529` (`.rich-text__link-dialog`), `:537` (`.mention-autocomplete`) | **Fixed.** Both replaced with `--shadow-md`/`--shadow-lg` per the elevation ladder (§10.1) — the RTE dialog now inherits `Modal`'s `--shadow-lg`; `.mention-autocomplete` takes `--shadow-md`. | `app.css` `.mention-autocomplete` rule; `Modal.tsx` panel class (`shadow-[var(--shadow-lg)]`). |
| **TB8-02-E-3** | `--shadow-lg` (dialog elevation) on four anchored popovers | `.topbar__notification-menu`, `.project-team-picker`, `.kanban-move-popover`, `.subtask-popover` | **Fixed.** All four now inherit `--shadow-md` from `AnchoredPopover`'s/`Menu`'s shared panel class (§7.3/§8.2), not their own rule. | `AnchoredPopover.tsx`'s `PANEL` constant; `ui/menu.tsx`'s `PANEL` constant. |
| **TB8-02-E-4** | `scale(.98)` entrance — the only scale in the product | `@keyframes pop`, `app.css` | **Fixed.** `@keyframes pop` deleted (grep-verified zero remaining consumers); `Modal`'s entrance/exit is `translateY` + opacity only, via Tailwind `motion-safe:` utilities. | `app.css` (keyframe removed); `Modal.tsx` panel class. |
| **TB8-02-E-5** | `color: #fff` raw literal | `.topbar__notification-badge`, `app.css` | **Fixed.** `bg-destructive !text-destructive-foreground`. | `Topbar.tsx`'s badge `className`. |
| **TB8-02-E-6** | `font-weight: 500` on a font shipping only 400 (faux-bold) | `.topbar__notification-item strong`, `.project-team-picker__option strong` | **Fixed.** Both now `font-normal` (or unset — inheriting `--weight-regular`); hierarchy carried by colour/size, not an invented weight. | `Topbar.tsx`'s `ITEM_TITLE`; `app.css` `.project-team-picker__option strong`. |
| **TB8-02-E-7** | Off-scale type (30/13/12/10/9px) and off-grid spacing (7/8/9/10/13/14px) across nine overlay blocks | `Modal`, `.project-team-picker`, `.kanban-move-popover`, `.subtask-popover`, `.mention-autocomplete`, `.rich-text__link-dialog`, `.topbar__notification-*` | **Fixed** across all named blocks — every value now cites a `--text-*`/`--space-*` token. `Modal`'s 30px head title → `--type-h3` (28px, an actual step). | `Modal.tsx` (`TITLE` constant); `app.css` (all six selector groups edited in place); `Topbar.tsx` (`ITEM_TITLE`/`ITEM_BODY`/`ITEM_META`/`HEAD`). |
| **TB8-02-E-8** | Hover and keyboard-highlight painted identically | `app.css:78,270,540,587` (four option lists) | **Fixed**, and extended to a fifth and sixth list this candidate added highlight-tracking to: `.topbar__notification-row` (3px unread rule, distinct device — §8.2), `.project-team-picker__option`, `.kanban-move-popover__option`, `.subtask-popover__member` (newly wired with real keyboard highlight — `SubtaskChecklist.tsx`'s `AssigneeControl` gained `activeIndex`/Arrow-key tracking it did not have before), `.mention-autocomplete__option`. Each now splits hover (`:hover`/`hover:bg-secondary`, paper tint) from highlight (a 2px ink leading border on `data-highlighted`/`[aria-current]`/`[aria-selected]`), per §10.3. | `app.css` (all five selector groups); `Topbar.tsx`'s `HIGHLIGHT_STATE` constant; `SubtaskChecklist.tsx`'s `AssigneeControl`. |
| **TB8-02-E-9** | Ad-hoc z-index with two live inversions (H-i, H-ii, H-iii) | Admin modal below the top bar; `Select` below the top bar/dialogs; dialogs tied with popovers at 90 | **Fixed.** `--z-popover: 90` (traced), `--z-dialog: 95` (new), `--z-toast: 98` (new) — see `tokens/spacing.css`. Stacking correctness for the nested case (§4.2a) is real-browser-only (criterion 23) — not claimed verified here. | `tokens/spacing.css`; `Modal.tsx`/`AnchoredPopover.tsx`/`ui/menu.tsx`/`ui/select.tsx` z-index classes; `app.css` `.toasts` (95→`var(--z-toast)`). |
| **TB8-02-E-10** | Touch targets below 44px in six overlay controls | Team-picker option (was the only 44px one), Kanban option/actions, subtask popover actions/member, notification dismiss/trigger, mobile-menu trigger, team-picker search input | **Fixed, corrected twice: 2026-09-02 Sol round 2 (four sites were still below 44px after an earlier pass falsely claimed completeness), then again the same day (Sol round 3) after the round-2 fix for `.subtask-popover__actions .button` was itself silently defeated by a CSS cascade-order bug** (Sol round 4 confirmed the fix with no further defect) — the new ≤720px override and the file's pre-existing unconditional 38px rule have equal specificity, and the 38px rule sat *later* in the file, so it won regardless of the media query. Fixed by moving the override to a dedicated `@media (max-width: 720px)` block placed immediately after that base rule, so source order — the actual tiebreaker — resolves in its favor; verified directly in the built CSS output (`@media (width<=720px){.subtask-popover__actions .button{min-height:44px}}` appears after the unconditional 38px declaration). `.kanban-move-popover__actions .button` and `.project-team-picker > input` were checked for the same hazard and are clean (no later same-specificity rule exists for either). All six sites now reach 44px at ≤720px, each carrying the WCAG 2.5.5 Enhanced / HIG comment. | `app.css` (`.kanban-move-popover__option/__actions`, `.subtask-popover__member/__actions` — the latter's override now lives beside its base rule, not in the shared 720px block, specifically to keep this cascade-order fix visible next to what it fixes — `.topbar__menu-trigger`, `.project-team-picker > input`); `Topbar.tsx`'s `DISMISS`/`TRIGGER`; built-CSS grep, 2026-09-02. |
| **TB8-02-E-11** | Stock shadcn classes arriving with generated source | `ui/menu.tsx` (new) | **Fixed at generation time** — no `rounded-md`/`shadow-sm`/`ring-offset-background`/`focus:ring-2`/`animate-in`/`zoom-in-95`/`active:scale-*`/`hover:bg-accent/50`/any `dark:` branch anywhere in the file (grep-verified: zero matches). | `ui/menu.tsx` (whole file — hand-written to the token system from the start, not generated-then-stripped). |
| **TB8-02-E-12** | Non-existent `border-*-solid` utilities compiling to nothing | Every directional-border site in this candidate | **Confirmed clean.** Every directional border in the diff uses the arbitrary-style-property form (`[border-top-style:solid] border-t-[length:…]`) — grep-verified zero `border-[trblxy]-solid` matches across `apps/web/src`. | Repo-wide grep, `border-[trblxy]-solid\b`, run 2026-09-02: no matches. |

## Not yet verified — real-browser / Agy-pass items

Per this candidate's own criteria 2, 4, 5, 7, 15, 17, 18 and 23, the following are implemented and
covered by automated (happy-dom) tests where that is possible, but their *visual* correctness and
several interaction timings genuinely require a real browser and are not claimed as verified by
this register:

- The §5 sixteen-row before/after visual matrix (no live capture in this session).
- §4.2a's full nested-overlay stacking/clipping/trap verification (criterion 23a–g) — the
  mechanism is implemented (§4.2a's slot, `positionMethod="fixed"`/`strategy: "fixed"` on all
  three portaling primitives) and unit-testable pieces pass, but the real DOM stacking-context
  and CSS transform/backdrop-filter interactions criterion 23 depends on are not exercised by
  happy-dom.
- Real-browser pointer *and* keyboard cross-column Kanban drag verification (criterion 17,
  `docs/lessons.md:901`) — this candidate's two `ProjectKanbanBoard.tsx` edits are lifecycle-only
  (`open` → `mounted`), but the mandate is unconditional regardless of edit size.
- `prefers-reduced-motion: reduce` suppressing all overlay animation (criterion 5's cross-cutting
  row) — the `motion-safe:` prefix is applied everywhere per §10.2, but not exercised by a real
  media-query toggle in this session.
- **`Modal`'s background scroll lock and its restoration** (criterion 4) — `FloatingOverlay
  lockScroll` is wired (§6.1), and happy-dom cannot exercise real wheel/touch scroll or verify
  `scrollY` is restored within ±1px on close; this needs a real browser.
- **Press-contained pointer drag dismissal** (criterion 5, defect F's closure gate) — the
  `pointerdown`+`click`-target-match logic is implemented on `Modal`'s scrim, and
  `ConfirmDialog.dom.test.tsx`/`RichTextEditor.dom.test.tsx` prove the *event-target* contract
  with synthetic events, but a real press-drag-release gesture (mouse down inside the panel,
  drag past its edge, release on the scrim) is not something happy-dom can simulate.
- **RTE link-dialog selection survival across the open→cancel round trip** (criterion 15,
  `docs/lessons.md:833` — TipTap/ProseMirror native-listener timing is a repeat regression
  source) — `RichTextEditor.dom.test.tsx`'s unit coverage passes, but the plan's own caveat is
  explicit that a green unit test here is not sufficient evidence; this needs the real-browser
  check the plan names directly.
- **Native menu activation, touch, and modifier-click semantics** — `Menu.dom.test.tsx` and
  `Topbar.dom.test.tsx` prove the *outcome* of Enter/Space activation via `.click()` (the
  browser's own substitute action, empirically verified to be the only path available in jsdom —
  a bare `KeyboardEvent({key:"Enter"})` on a native `<button>` produces zero clicks) and prove
  touch-tap dismissal via a reconstructed `touchstart`/`touchend`/synthetic-`mousedown` sequence
  traced through the installed `useDismiss.mjs`; genuine native keydown-to-click conversion,
  real touch events, and real ctrl-/middle-click browser chrome (new-tab opening) all remain
  real-browser-only (criterion 18's Agy pass covers this class of gap generally).
- **Floating-focus timing under real paint/layout** — `AnchoredPopover`'s TB0 synchronous-focus
  fix (§7.1, criterion 7) is asserted at the JS-task level (no timer flush needed to observe it),
  but the original bug it fixed (`08f4653`) was itself a *cross-instance* timing race that only
  surfaced when running the *full* suite, not in isolation — the class of regression it guards
  against is inherently sensitive to real scheduling/paint timing happy-dom does not reproduce.
- **`Menu`'s `data-highlighted` styling does not survive a full item-list re-registration**,
  found empirically while writing `Topbar.dom.test.tsx`'s dynamic-poll test: after a poll
  replaces the notification array, React's `key={n.id}` correctly preserves the *same* DOM node
  for an unchanged notification (proven by reference equality) and real DOM focus genuinely
  stays on it (proven directly, not inferred) — but Base UI's own `data-highlighted` attribute
  resets to absent on that same node. The keyboard user's actual position is not lost; the
  highlight *ring* painted from that attribute (§10.3) may flicker off during a poll. Not fixed
  here — it is Base UI's own internal active-item bookkeeping, not app code, and the
  accessibility-critical property (real focus) is unaffected. Worth a real-browser visual check
  before this primitive gains more consumers.
