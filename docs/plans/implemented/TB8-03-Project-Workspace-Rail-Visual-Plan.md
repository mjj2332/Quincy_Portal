# TB8-03 — Project Workspace Rail and Reached Collection Controls: Visual Plan

**Status: DEPLOYED TO PRODUCTION 2026-09-02** (commit `77187a5`
`feat(tb8): TB8-03 Project Workspace rail and reached-collection controls on Tailwind/shadcn`;
app Worker `9a021a5e-956b-43b4-a17c-ed05dc7be1af`; frontend/CSS only — no worker source changes,
background and webhook-ingress not redeployed; no migration; rollback target app
`7248b49a-dbd4-4316-b433-af82e8ed7792`, TB8-02's deploy). Drafted by the Opus design lane, two Sol
scope/correctness rounds complete, round-2's nine findings fixed by the Opus design lane past the
≤2-round Sol cap (`docs/Subagent-Frontend-Orchestration.md` pipeline step 3), then approved by an
independent fresh-Opus self-review, exactly as TB8-01 and TB8-02 both closed out. Built by a Sonnet
subagent, taken through 11 rounds of fresh Sol diff review — round 11 fixed a genuine production CSS
defect (a pre-existing unlayered `.grid` legacy selector silently overriding Tailwind's `grid`/
`grid-cols-*` utilities) found only during Opus's live-browser visual review, not by code reading —
then Opus visual/taste-approved and the orchestrating session's own §5 gate passed clean.

> **Fresh-Opus terminal gate — APPROVED with three corrections applied in place, 2026-09-02.**
> Independent re-review with no drafting context. All nine round-2 fixes were re-derived against the
> live source rather than taken on report, and all nine hold:
> **E-20's cascade fix is correct.** `.app--impersonating .rail` (`app.css:41`) is (0,2,0) and
> `@media (max-width:1080px) .rail` (`:836`) is (0,1,0) — media queries add no specificity, so `:41`'s
> `max-height: calc(100vh - 106px)` does survive the reset today, with `:231`'s `overflow: auto`
> uncontested. The added rule matches at (0,2,0) and sits ~795 lines later, so it wins with no
> `!important`; above 1080 the block does not apply, so `:41`'s desktop geometry is untouched; and
> `overflow: auto` on an auto-height block is inert, so one declaration is genuinely enough.
> **The completeness fixes are real, not nominal.** `app.css:980` is confirmed
> `display:grid; gap:6px` + type, and `CollectionPanel.tsx:160` renders `<label><span>…</span><input>`
> — so `LINK_FORM_LABEL`'s `grid gap-*` is load-bearing, not decorative; the standalone "Add link"
> at `:160` is confirmed on legacy `className="button"` and now has a real `buttonClasses("primary", …)`
> replacement with the class dropped. `ProjectDeadlineControl.tsx:174` is confirmed to hold all four
> conflict-subtree defects the fix claims: `.project-deadline__conflict-comparison` grouped into
> `:283`'s `grid; gap:3px`, an **unclassed** action `<div>`, "Review and reapply my draft" on
> `.button button--text`, and a bare `<strong>` rendering browser-synthesised bold.
> **E-17 is now factually accurate.** `production-calendar.css:175` does set
> `font: 14px/1.5 var(--font-serif, Athelas, Georgia, serif)`, `ProductionCalendarScheduleEditor.tsx:151`
> does consume it, `--font-serif` is defined **nowhere** in the repo, `.q-body-serif`
> (`tokens/base.css:37`) has zero consumers, and `typography.css:7`'s comment is false on both halves.
> **Both contrast figures recompute exactly**: `#8f8775` on `#ffffff` → L 0.2445 → **3.6:1**;
> `#4d473c` → **9.2:1**. `text-foreground-secondary` is used for the collection count in both states,
> and §4.3's `--text-muted` row is scoped to non-text with no exception. **The 44px citation is clean** —
> the only surviving "2.5.8" strings are the correction narrative itself (§2.1) explaining why 2.5.8
> is wrong. Criterion 17's list is exhaustive against everything §5 changes focus treatment on; the
> `.workspace-intro` / `.empty` deferrals name candidates #9 and #10 as owners and now carry the
> shared 3.6:1 contrast defect, not only the spacing/type literals.
>
> **§7.0's expected-hit inventory was independently re-grepped, not trusted** — this was the one item
> flagged as sourced from the plan's own prior citations. Most of it is exact: `.empty` really is **31
> occurrences across nine files** in the stated per-file split; `.project-team__remove` really is 1
> rendering + **8** test queries at the exact eight cited lines; `.statetag`'s six consumers, the two
> `.project-deadline__overdue` Kanban lines, `.dropcard`'s two test hits, `.rail__edit`, `.work`,
> `.rail`, `.filterlist` and the `.collection-*` set all match. **Two counts had drifted and are fixed
> here:** `.rail__sec` is **7** renderings, not 3 (the "3" appears to have come from a substring grep
> conflated with `.rail__section-label`), and `.frow` is **11** test queries on 11 distinct lines, not
> 8 (the cited `209-212` is a four-line range that was counted as one hit; the "8" also appeared in §7
> row 16 and §10.1 item 14 and is corrected in all three). Both were understatements, so neither
> weakens a disposition — but a gate whose whole premise is "a kept hook returning zero hits is a
> finding" cannot ship with wrong expected counts, since the builder checks its greps against them.
> A stale sentence in §5.6 claiming §4.3's `text-muted-foreground` row was "struck" was also
> corrected — the row survives, scoped to non-text.
>
> Nothing else required a change. No invalid Tailwind class, no unauthorized `@theme` token, no raw-ramp
> or bare-numeric utility, and no `border-*-solid` form appears anywhere in §5; the D-18 boundary holds
> (no capability, DTO, query key, mutation or Stage identity moves, and nothing crosses into
> Collaboration/checklist/subtask territory); §7 row 13's warning that `.kcard-stage-control` is a
> different selector is a genuine catch, confirmed live at `ProjectKanbanBoard.tsx`. **Implementation
> may proceed on §5 as written.**

> **Revision note — round-2 Sol-review fix pass (2026-09-02).** Sol's second pass returned five
> blocking, three should-fix and one nit finding. All nine are fixed in place, each verified against
> the live source rather than against the finding text:
> **(1) E-20 was wrong and is now a defect, not a preservation row.** `.app--impersonating .rail`
> (`app.css:41`) is (0,2,0) and beats the ≤1080 `.rail { max-height: none }` reset (`:836`, (0,1,0)),
> so the `vh` max-height and `overflow: auto` survive at 1024×768 **and** 390×844 while
> impersonating — the mobile URL-bar hazard and a nested in-flow scroller are both live today. Fixed
> by one added `app.css` rule (§5.1, §7 row 2a); criterion 16 now covers all three viewports in both
> impersonation states.
> **(2) §5.9d's add-form replacement completed** — the label keeps `app.css:980`'s `display:grid` +
> gap as `LINK_FORM_LABEL`, and the standalone "Add link" button (`CollectionPanel.tsx:160`) gets a
> real `buttonClasses("primary", …)` string at 44px instead of staying on legacy `.button`.
> **(3) §5.4's conflict subtree completed** — `.project-deadline__conflict-comparison`'s grid/gap/
> type, the unclassed conflict action row, "Review and reapply my draft"'s migration off
> `.button--text`, and the conflict `<strong>`'s faux-bold all now have replacements.
> **(4) The inactive collection count moves off `--text-muted`** (3.6:1, which this plan's own E-7
> rules out) to `text-foreground-secondary` in both states, and §5.6 no longer defers that call to
> the browser pass; `--text-muted` now has no text exception on this surface at all.
> **(5) The §7 retirement gate is rewritten as §7.0** — zero *unmigrated-paint* consumers with a
> per-class expected-hit inventory, because the literal zero-occurrence form was unsatisfiable
> against the hooks this plan deliberately keeps.
> **(6) E-17's "Athelas is used nowhere" premise was false** and is corrected: TB5C already renders
> Athelas at `production-calendar.css:175`. The owner-approved decision itself is unchanged.
> **(7) Criterion 17's keyboard pass is now exhaustive**, covering the Video inputs, Add/Save/Cancel,
> Edit/Remove and link anchors whose focus rings this release restores.
> **(8) The `.workspace-intro` / `.empty` deferral now records the shared 3.6:1 contrast defect** and
> names its owner; the deferral decision itself stands.
> **(9) 44px is cited as WCAG 2.5.5 Enhanced**, not 2.5.8 (whose minimum is 24×24).
> Item 2's round-1 portions Sol confirmed clean (link body, Video-only stacking, form containers,
> editor, editor action row) were not touched. No design direction, disposition or owner-approved
> decision was reversed; E-20 changed disposition because the underlying fact changed.

> **Revision note — round-1 Sol-review fix pass (2026-09-02).** Sol's step-2 scope/correctness pass
> returned *send back for revision* with four blocking, three should-fix and one nit finding, all
> mechanical completeness bugs rather than aesthetic disagreements. Fixed in place: (1) the rail's
> padding utilities now appear on the final `<aside>` string in §5.1; (2) §5.9 now gives complete
> replacement class strings for the link body, the Video-only stacking, the add form, the inline
> editor and its action row, so §7 row 20's blanket deletion leaves nothing unreplaced; (3) §5.4 now
> replaces the Deadline editor's fieldset reset, editor head, input row, custom-offset wrapper and
> custom-chip remove button; (4) §5.5 puts `.project-team__add` / `.project-team__remove` back into
> the actual class strings and gives `.project-team` / `.project-team__role` their own replacement
> utilities; (5) the `.empty` consumer inventory is corrected to its real size; (6) `.statetag`'s
> deferred-consumer list gains `ProjectWorkspace.tsx:488`; (7) §5.3's Stage-control claim is rewritten
> as a stated divergence from the Dashboard `Select` rather than an identical reproduction; (8) the
> `.project-deadline__overdue` deferred-consumer citation now names both Kanban lines. No decision,
> disposition or design direction changed — only completeness and factual accuracy.

> **This supersedes an earlier, non-design-authored draft of the same candidate.** That draft's
> scope mapping, `file:line` citation work and drift-register framing were verified twice
> independently and are reused here where noted. **Every visual and token decision in this document
> was made fresh.** Where this plan reaches a different conclusion than that draft — the
> `.workspace-intro` split, the `.empty` split, the `StatusBadge`/`.statetag` identification, the
> fact-row rhythm, the Stage control's paint owner, and the `--text-muted` contrast finding — the
> divergence is stated at the point it occurs, with its reason. Two of those divergences correct
> factual errors in the earlier draft (§3.2 items **b** and **c**).

Candidate release **#3** of
[TB8 — Surface-by-Surface Design Convergence and Cleanup](revamp_2026_portal/roadmap/TB8-Wider-UI-Migration-And-Cleanup.md),
ranked third in the kickoff doc's
[Ranking (2026-09-01)](Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md#ranking-2026-09-01).
Pipeline per [Subagent-Frontend-Orchestration.md](../Subagent-Frontend-Orchestration.md)'s §
"Pipeline"; scope widened per its § "Scope: full UI rescue, not just the named control", which does
**not** waive any roadmap rule.

**Precedent, treated as settled authority and not re-derived.**
[TB8-01 — Dashboard Shell](implemented/TB8-01-Dashboard-Shell-Visual-Plan.md) established: the
`Button`/`buttonClasses()` seam (§2.1 there), the `Select` primitive on `@base-ui/react` (§2.2), the
arbitrary-value-bound-to-a-Quincy-variable convention (§1.2), the narrow-semantic-role `@theme`
extension and its hard non-goals (§1.4), the `border-*-solid`-does-not-exist trap (§1.3), and the
unlayered-`app.css`-outranks-Tailwind cascade fact (§1.5).
[TB8-02 — Menus, Dialogs, Popovers](implemented/TB8-02-Menus-Dialogs-Popovers-Visual-Plan.md) added:
the three-step elevation ladder (§3.1 there), the **highlight-is-ink / hover-is-paper** device
(§3.3), the `--z-*` family, and the faux-bold finding (§1.2 defect I). Where this plan needs one of
those, it cites and stops.

**Styling-owner authority.** Per the kickoff doc's
[Tailwind adoption scope decision](Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md#decision-tailwind-adoption-scope-for-tb8-2026-09-01),
**TB8-03 extends the TB1 Tailwind v4 + shadcn foundation to the Project Workspace rail and the
reached collection shell as its fourth bounded consumer.** Extension of TB1's setup
(`portal/apps/web/components.json:1-24` — `base-sera`, `cssVariables: true`, Lucide, no prefix;
`portal/apps/web/src/styles/index.css:1-10` — theme + utilities layered, Preflight deliberately
absent, no dark mode), never a parallel one. Every value traces to
`portal/apps/web/src/styles/tokens/`.

**Authority boundary — D-18, unchanged by this release.** The rail stays canonical for Stage,
project Deadline/reminders, Photographers and Editors; Collaboration stays canonical for
checklist/subtasks and discussion (`docs/Decision-Sheet.md:31`;
`docs/Implementation-Plan.md:157-184`). `editProject` still owns roster and Deadline writes;
`moveProjectStage` remains the one guarded Stage command; project Deadline stays distinct from shoot
time and checklist schedules. **No capability, API call, DTO, query key, mutation, membership rule,
reminder rule or Stage identity moves in this release.** This is a visual convergence and
accessibility release.

---

## 1. Scope

### 1.1 In scope

| # | Surface | Source |
| --- | --- | --- |
| 1 | Rail frame, masthead, section rhythm, responsive transitions | `ProjectOverviewRail.tsx:86-134`; `app.css:230-237,834-836,844-868`; impersonation geometry `app.css:41` |
| 2 | Stage presentation and the Stage `<select>` | `ProjectOverviewRail.tsx:20-47,96`; `app.css:599-601` |
| 3 | Fact rows (Stage, Shoot, Agency, Agent, Deadline, Next reminder) | `ProjectOverviewRail.tsx:36,96-97,109-110`; `ProjectDeadlineControl.tsx:162-163`; `app.css:275-277` |
| 4 | Deadline summary, actions, editor, conflict, inactive/resume states | `ProjectDeadlineControl.tsx:161-177`; `app.css:278-296` |
| 5 | Team role heads, member rows, empty/inactive/error/pending, add/remove | `ProjectTeamControl.tsx:184-204`; `app.css:238-253` |
| 6 | Client facts and Production notes | `ProjectOverviewRail.tsx:107-116` |
| 7 | Collection switcher | `ProjectOverviewRail.tsx:118-126`; `app.css:300-305,955-958,800` |
| 8 | Dropbox sync control | `ProjectOverviewRail.tsx:128-133`; `app.css:656-659` |
| 9 | Reached collection shell: Video link tiles/empty/add/edit/provenance/reorder, Floorplan & Copy delivered-link shell | `CollectionPanel.tsx:32-56,160,170`; `app.css:965-987` |
| 10 | Legacy CSS retirement, **only** for selectors whose last consumer moves here (§7) | — |

### 1.2 Explicitly deferred, with the boundary named

| Deferred | Boundary | Owner |
| --- | --- | --- |
| RAW/Edited `PhotoGrid`, `UploadDropzone`, ingest toolbar, selection/action bar, AutoHDR direct-send toolbar, Lightbox, filmstrip, compare, annotations | `TB0-VIS-02` records that populated local media evidence was unavailable and must not be fabricated (`revamp_2026_portal/baseline/TB0/Drift-Register.md:61`) | candidate #9 / media runtime owner |
| `.workspace-intro` and `.empty` — the two shared shells the collection panel renders inside. **Both carry a deferred `--text-muted` 3.6:1 contrast defect** (the same one E-7 fixes on the rail), not only off-grid spacing/type literals | **Deliberately not split.** §5.9a and §5.9b give the reasoning and the full defect list; this is a divergence from the earlier draft | `.workspace-intro` → **candidate #9 / media runtime owner** (the candidate that moves `ProjectWorkspace.tsx:488`'s RAW/Edited header); `.empty` → **candidate #10**, the shared-atom sweep that also owns `.statetag` and `.chip`. Each must fix the contrast defect, not only the literals |
| `.wsbar` (`app.css:373`, rendered `ProjectWorkspace.tsx:488`) | RAW/Edited workspace chrome above the collection shell | media candidate |
| `.member` (`app.css:959`), `.project-collaboration-summary*` | Collaboration summary at `ProjectWorkspace.tsx:332` | candidate #7 |
| `.document-*` (`app.css:988-1000`), document preview/version-history/approve/upload/delete | Floorplan & Copy workflow internals; TB8-03 aligns only the outer shell and the shared link controls above them | later document-workflow release |
| `.statetag` paint (`app.css:197-200`), `.chip` paint (`app.css:110-120`) | Shared atoms. `.statetag`'s remaining consumers after TB8-03 are `PhotoGrid.tsx:177-181`, `CollectionPanel.tsx:170` (the document-approval tag), `ProjectDiscussionThread.tsx:211` and `ProjectWorkspace.tsx:488` (the AutoHDR jobs list's `statetag st-${job.status}`); `.chip` is consumed app-wide (`ProjectWorkspace.tsx:488`, `CollectionPanel.tsx:38,170`, and others). TB8-03 drops the classes from *its own* elements and leaves both rules whole. `.chip`'s off-scale `12.5px` and `--radius-pill` shape are recorded as deferred | candidates #6 / #10 |
| `production-calendar.css:175`'s `font: 14px/1.5 var(--font-serif, Athelas, Georgia, serif)` — the app's existing Athelas consumer, reaching the face through an **undefined** `--font-serif`'s fallback plus a hard-coded size rather than through `--type-body-serif` (E-17) | Production Calendar surface, shipped TB5C; TB8-03 owns neither the file nor the surface | candidate #10 / shared-atom and token normalisation |
| `.quincy-input:focus { outline: none }` (`app.css:1040-1044`) — found in passing, real | TB1's `ui/input.tsx` owns `ProjectFields` | candidate #4, remaining project/admin forms |
| `AnchoredPopover` positioning, dismissal, focus-return; the Team picker's overlay lifecycle | TB8-02 shipped it; only the surrounding rail paint is in scope | already delivered |
| Any responsive transformation of the rail into a modal sheet | The rail becomes an in-flow block at ≤1080 (`app.css:834-836`); changing that is information architecture, not paint | not planned |
| Board filters/card controls, notification bell/preferences, project/admin forms, Collaboration, notice board, React 19, Calendar, External Editor product scope, dark mode, Preflight, final dead-selector sweep | Their own candidates | #4-#10 |

**`.app.acc-olive` (`app.css:796-804`) is dead** — zero `.tsx`/`.ts` consumers of `acc-olive`
repo-wide. Only the one selector this candidate owns — `.app.acc-olive .frow.is-active`
(`app.css:800`) — is removed from its grouped rule here. Deleting the rest of the dead block belongs
to candidate #10.

---

## 2. Foundation

### 2.1 Reused verbatim from TB8-01

TB8-01 §1.1's semantic-utility table; §1.2's arbitrary-value convention
(`p-[var(--space-4)]`, `text-[length:var(--text-sm)]`, `[font:…]`, `duration-[var(--dur-fast)]`);
§1.3's directional-border form; §1.4's seven added roles (`text-foreground-secondary`,
`bg-surface-sunken`, `border-border-hover`, `bg-primary-hover`, …, live at
`tokens/tailwind.css:47-59`) **and its hard non-goal** — never map `--spacing-*`, `--text-*`,
`--radius-*`, `--shadow-*`, `--tracking-*`, `--leading-*`, `--font-*`, `--ease-*` into `@theme`, and
**no bare Tailwind spacing/sizing utility anywhere on this surface**, even where a pixel value
coincides. `min-h-[44px]` stays an explicit literal carrying the comment
`/* WCAG 2.5.5 Enhanced target, not a spacing token */` at each site.

**The 44px figure cites 2.5.5, and this is a correction.** An earlier revision of this plan
attributed 44×44 to **SC 2.5.8 Target Size (Minimum)** throughout. That is wrong: 2.5.8 is the AA
success criterion added in WCAG 2.2 and its minimum is **24×24 CSS pixels**, with exceptions
(spacing, inline, user-agent control, essential). **44×44 is SC 2.5.5 Target Size (Enhanced)**, AAA
— which is also what Apple's HIG and the readme's own touch guidance land on. Every 44px target in
this plan is therefore a deliberate choice to hold the *Enhanced* bar, not the floor: the surface
already clears 24px in most places today, so citing 2.5.8 would have made this release's central
accessibility fix look like remediation of a violation when it is an uplift beyond the AA
requirement. Keep the citation accurate in the shipped comments — a reviewer who checks it and finds
"24px" will otherwise conclude the whole target argument is unsound.

**No new token is created by this plan.** Every value below already exists in
`tokens/colors.css`, `tokens/spacing.css`, `tokens/typography.css` or `tokens/tailwind.css`.

**One merged-shorthand rule, learned twice already** (`ui/button.tsx:15-18`, `ui/select.tsx:82-87`):
never write `[font:var(--type-x)]` *and* a separate `text-[length:…]` on the same element — Tailwind's
emitted rule order between two utilities touching `font-size` is not guaranteed and the shorthand has
won in production. Write one explicit `[font:<weight>_<size>/<leading>_<family>]`.

### 2.2 The unlayered-`app.css` disposition rule

`app.css` is imported outside every declared layer (`styles/index.css:1,10`), so any matching rule
in it beats an ordinary Tailwind utility regardless of specificity. **Every legacy selector this
release touches takes exactly one disposition, and it is named in §7:**

- **(a) Retire** — delete the `app.css` paint after a fresh zero-remaining-consumer search; keep the
  class name only where a test or stable DOM hook needs it, as a **non-styling** hook.
  Use only when the complete visual consumer set moves in TB8-03.
- **(b) Split the consumer** — remove the legacy class from the in-scope element only, replace it
  with a component-specific non-styling hook plus utilities, and **leave the legacy rule completely
  untouched** for its deferred consumers.
- **(c) Structurally override** — retain a shared legacy primitive and use the narrowest
  `!`-prefixed utility for the one property TB8-03 must change. Reserved for load-bearing shared
  atoms that can be neither retired nor split. Every use is recorded in the drift evidence. **An
  ordinary utility beside a surviving matching `app.css` selector is never acceptable.**

**When `!` is *not* needed, and why it matters.** `cn()` is `twMerge(clsx(...))`
(`lib/utils.ts:1-6`). Inside `buttonClasses(variant, { className })` the caller's `className` is
merged last, so `min-h-[44px]` passed there defeats `BASE`'s `min-h-[38px]` and `VARIANT.text`'s
`min-h-[32px]` **without** `!`. `!` is required only against a surviving *unlayered `app.css`* rule,
never against another Tailwind utility on the same element. Builders must not scatter `!`
defensively; Sol should treat an unexplained `!` as a defect.

---

## 3. The survey — what actually exists

Run against `portal/apps/web/src` on 2026-09-02. The rail is the app's densest information surface
and the only one that has never had a styling owner assigned: its paint accreted across
`app.css:230-305`, `:599-601`, `:656-659`, `:800`, `:834-836`, `:844-870` and `:955-987`, in seven
non-adjacent blocks, two of which style the *same selector* differently.

### 3.1 Drift register — TB8-03-E-1 … E-20

Implementation creates `docs/plans/revamp_2026_portal/evidence/TB8-03/drift-register.md` using the
TB8-02 table shape (`evidence/TB8-02/drift-register.md:1-11`). Matched before/after at 1440×900,
1024×768 and 390×844, same role, project, active collection and data state.

| ID | Finding (evidenced unless marked) | Disposition |
| --- | --- | --- |
| **E-1** | **Rail masthead has no display moment and no rule.** `.rail h2` overrides `--type-h3` (28px) down to a `24px` literal that exists on no scale step (`app.css:232`); the badge/locality spacing is two inline `style` literals, `marginBottom: 10` and `marginTop: 8` (`ProjectOverviewRail.tsx:89,91`); `--border-width-rule`, the system's *"signature 3px ink rule under section eyebrows"* (readme § Visual foundations; `tokens/spacing.css:35`), appears nowhere on this surface although TB8-01 shipped it on the Dashboard masthead (`Dashboard.tsx:922`). Separately, the masthead's top inset is doubled on desktop — `.rail__sec`'s 24px `padding-top` (`app.css:233`) sits inside `.rail`'s own 32px padding (`:231`), and is zeroed only at ≤720 (`:867`). | **Fix unwanted drift** (§5.1). The 24px→28px increase is a deliberate size change, not normalization; a long-address capture is a required gate. |
| **E-2** | **The rail states the Stage twice.** `StatusBadge` (`ProjectOverviewRail.tsx:89` → `atoms.tsx:12-23`) resolves through `presentationStageKey` and renders a dot plus the stage label; the Stage fact row (`:36` inside `StageControl`, or `:96` read-only) resolves through the *same* `presentationStageKey` and renders the *same* label, ~200px below. | **Fix by relocation** (§5.1/§5.3). The shared atom is preserved byte-for-byte; only its placement changes. |
| **E-3** | **The Stage `<select>` is unstyled native browser chrome.** The only rule touching it is `.stage-control select { width: 100% }` (`app.css:600`). `app.css:29` sets `font-family` on `button`, not `select`. It therefore renders with the platform's own font, corner radius and focus ring inside a design system whose premise is square corners, Apfel Grotezk and a 2px ink focus ring — the single loudest foreign body on the surface. | **Fix unwanted drift** (§5.3). Element type preserved; see §5.3 for why it does **not** migrate to `ui/select.tsx`. |
| **E-4** | **`.kv` sets facts as a two-sided split with right-aligned values** (`app.css:275-277`: `justify-content: space-between`, `.vv { text-align: right }`), plus off-grid `6px` padding and a `14px` literal. At the rail's 224px content measure this produces a ragged centre gutter and halves the space available to every value. Shared with the deferred Collaboration summary and AutoHDR jobs list (`ProjectWorkspace.tsx:332,488`). | **Fix — case (b)** (§5.2). New `.rail-kv` hook; `app.css:275-277` untouched. |
| **E-5** | **Faux-bold on a family that ships only weight 400.** `styles/fonts.css:9-15` declares exactly one Apfel Grotezk face at 400. `.project-team__role-head h3` and `.project-team__identity strong` both set `font-weight: 500` (`app.css:241,248`) and `<strong>`/`<em>` elements default to 700; all render browser-synthesised. Same defect class as TB8-02 §1.2 item I. | **Fix unwanted drift** (§5.5). `app.css:272` already solves this correctly for the picker option — apply that precedent. |
| **E-6** | **Team rows are cards-with-gaps in a hairline system,** with off-scale and sub-target values: per-row `1px` box border (`app.css:245`), `5px` grid gaps (`:244`), identity `12px` / metadata `10px` — `10px` is below `--text-2xs` (11px) and on no scale step (`:248-249`), 30px add/remove targets (`:242`) reaching 44px only at ≤720 (`:870`), and inactive membership signalled by `border-style: dashed` plus `opacity: .78` (`:246`), which reduces text contrast to convey state. | **Fix accessibility/unwanted drift** (§5.5). 44px at every pointer size; opacity removed. |
| **E-7** | **`--text-muted` fails 4.5:1 as text on the rail.** `--text-muted` is `--greige-400` `#8f8775` (`colors.css:23,44`); the rail's background is `--paper-000` `#ffffff` (`app.css:231`). Relative luminance 0.2445 → **3.6:1**. Every muted text role on this surface fails: fact keys (`app.css:276`), the collection count (`:304`), team metadata and empty text (`:249,253`), the Deadline summary/zone/inactive/mandatory copy (`:280,283,284`), the link-form `<em>` (`:981`) — and Production notes, which is a *paragraph* rendered `.muted` (`ProjectOverviewRail.tsx:115`). TB8-01 §7.4 made the identical substitution for the same reason. | **Fix accessibility** (§4.3). On this surface `--text-muted` is used only for non-text; every muted **text** role becomes `text-foreground-secondary` (`--greige-600` `#4d473c`, **9.2:1**). |
| **E-8** | **The Deadline editor is an invisible card.** `.project-deadline__editor` is `border: 1px solid var(--border-hairline); background: var(--paper-000)` (`app.css:285`) nested inside `.rail`, which is *also* `var(--paper-000)` (`:231`) — a white card on white paper, so the boundary carries no information. Its inputs have no `min-height` (`:289`, `7px` padding ≈ 30px tall), its literals are `3/7/8/9/11/12/15px` (`:279-296`), and `.project-deadline__conflict` uses a `3px` left border (`:296`) — the weight `tokens/spacing.css:35` reserves for section heads. | **Fix unwanted drift/accessibility** (§5.4). |
| **E-9** | **`<strong>Overdue</strong>` is faux-bold at an off-scale 11px** (`ProjectDeadlineControl.tsx:162`; `app.css:279,281`). `.project-deadline__overdue` has **two deferred Kanban consumers**, at `ProjectKanbanBoard.tsx:277` and `:322`; `.project-deadline__zone` has none. | **Fix — case (b)** (§5.4, §7). |
| **E-10** | **The collection switcher has two live CSS owners that disagree.** `.frow` at `app.css:301-305` is a rounded, negatively-margined pill whose active state is inverse ink; `.frow` at `:955-958` is a square row whose active state is a 2px ink left rule on raised paper. Both apply. `:955` wins on padding/font/border, but `:301`'s `border-radius: var(--radius-sm)` and `margin: 0 -10px` survive because `:955` never sets them — so the live control is a **4px-rounded, edge-bleeding row in a `--radius-card: 0` system**. Its count is `13px` (`:304`, off-scale) beside a `12px` label (`:955`). A third path, `.app.acc-olive .frow.is-active` (`:800`), would paint solid olive under ink text. | **Fix duplicate owner** (§5.6, §7). Keep the later editorial direction; delete both base blocks and the olive selector. |
| **E-11** | **The collection switcher exposes no state to assistive technology.** `ProjectOverviewRail.tsx:122` renders plain `<button>`s whose only current-state cues are a background tint and a 2px rule — neither reaches AT. Rows are ≈33px tall and are the workspace's primary navigation. | **Fix accessibility** (§5.6). `aria-pressed` on every rendered row; 44px. |
| **E-12** | **The link form suppresses the focus ring for everyone.** `.collection-link-form input:focus { outline: none }` (`app.css:983`) — `:focus`, not `:focus-visible`, at specificity (0,2,1) against `base.css:25`'s `:focus-visible` at (0,1,0), both unlayered. The 2px ink ring is dead on the add and inline-edit inputs; a 1px border colour change is the entire replacement. | **Fix accessibility** (§5.9d). Delete the rule. |
| **E-13** | **Link tiles are off-scale and off-grid throughout.** `.collection-link__name` overrides `--type-h3` to a `21px` literal (`app.css:971` — `--text-lg` is 22, `--text-xl` 28); tile `min-height: 118px` (`:967`); grip `34px` with `6px` padding and `font: 18px/1 sans-serif` (`:974`); form label `10px` (`:980`); input `38px` (`:982`); editor error `13px` (`:986`). | **Fix unwanted drift/accessibility** (§5.9c-e). |
| **E-14** | **A dragged, in-flow tile takes `--shadow-sm`** (`app.css:978`), although the system reserves shadow for true overlays (`tokens/spacing.css:37-41`; readme § Visual foundations) and there is no `DragOverlay` — the node stays in flow. | **Fix unwanted elevation** (§5.9e). Opacity plus an ink border; no shadow, no new `DragOverlay`. |
| **E-15** | **Two raw glyphs stand in for the icon system.** `⠿` (U+283F, a braille pattern) is the reorder grip (`CollectionPanel.tsx:42`) and `◈` (U+25C8) is the Dropbox mark (`ProjectOverviewRail.tsx:131`). The readme names **Lucide at 1.5px stroke** as the sanctioned set, `lucide-react@1.34.0` is installed (`portal/package.json:42`) and already consumed (`ui/select.tsx:3,61`). The `◈` span additionally sits inside the sync button's accessible name. | **Fix unwanted drift** (§5.7, §5.9e). |
| **E-16** | **The Dropbox card is off-grid and carries two dead rules.** `.dropcard` uses `12px 14px` padding and a `12px` gap (`app.css:656`); `.dropcard.is-on` (`:658`) has no consumer that ever sets `is-on`, and `.dropcard svg:first-child` (`:659`) has no consumer that renders an `svg`. Its "Blocked" chip is `.statetag` (`:197`) — a `rgba(20,20,21,.6)` + `backdrop-filter: blur(6px)` pill designed to sit over a **photo tile** (`:196`), here rendered as a 60%-grey translucent pill on warm paper, inside a button. | **Fix unwanted drift** (§5.7). Shared `.statetag` rule untouched; the class leaves this consumer. |
| **E-17** | **The brand's fourth type voice ships, renders in one place already, and reaches that place by a fallback chain rather than by its own token.** `styles/fonts.css:33-63` self-hosts four Athelas faces from `/fonts/Athelas-*.ttf`. **Athelas is already rendered in production today**: `production-calendar.css:175` sets `.qc-calendar-schedule-editor__intro { font: 14px/1.5 var(--font-serif, Athelas, Georgia, serif) }`, consumed by `ProductionCalendarScheduleEditor.tsx:151`, and `--font-serif` is **defined nowhere in the repo**, so the literal `Athelas` fallback is what actually resolves — shipped with TB5C. The real defects are three, and none of them is "unused": **(i)** that consumer reaches Athelas through an *undefined* variable's fallback list and a hard-coded `14px/1.5`, not through `--font-body-serif` / `--type-body-serif` (`tokens/typography.css:15,60`), so the one live serif on the product does not trace to the token that owns the role; **(ii)** the tokens themselves have no `.tsx` consumer — `.q-body-serif` (`tokens/base.css:37`) consumes `--type-body-serif` but that class has no consumer either, so the token pair is reachable but unreached; **(iii)** `tokens/typography.css:7`'s comment still claims Athelas "was named in the kit but not supplied" and "falls back to a Charter/Georgia stack", which is false twice over — the faces landed at `styles/fonts.css:33-63`, and the face is already painting. | **Fix — second, token-correct use** (§4.2, §5.8). Production notes take `--font-body-serif` via the class string in §5.8. This is **not** Athelas's first activation; it is its second, and the first one that cites the role token. Plus the one-line comment correction at `typography.css:7`. Normalising `production-calendar.css:175` onto `--type-body-serif` is **out of scope** — Calendar is not this candidate's surface — and is recorded as a deferral to the Calendar/shared-atom owner (candidate #10). |
| **E-18** | *(latent, source-read)* **The drag contract is not proven by any test.** `CollectionPanel.dom.test.tsx:19-41,134-138` mocks `DndContext` and captures its callbacks, so pointer geometry, the 6px activation distance (`CollectionPanel.tsx:51`), the keyboard sensor and the sortable strategy are unexercised. | **Preserve required interaction behavior.** Styling only; real-browser gate (§10.2 criterion 18). |
| **E-19** | *(latent, source-read)* **Two DOM tests will fail on correct styling work.** `CollectionPanel.dom.test.tsx:219` asserts the tile's children have `className` **exactly** `["collection-link__name", "chip"]`, so any utility added to either element fails it. `ProjectDeadlineControl.dom.test.tsx:62` asserts `querySelectorAll(".kv")` has length 2 — the hook E-4 renames. `ProjectWorkspace.dom.test.tsx:1267,1271,1278` require the collection row's `textContent` to *start with* the collection label. | **Fix the tests, precisely** (§9). Not "update snapshots". |
| **E-20** | **A `vh` max-height survives the ≤1080 reset while impersonating, and nests an in-flow scroller.** `.rail`'s `max-height: calc(100vh - 64px)` (`app.css:231`) uses `vh`, the iOS *large* viewport — the hazard TB8-02 §1.2 defect E records. For the **non-impersonating** case it is genuinely inert: `@media (max-width:1080px) { .rail { position: static; max-height: none } }` (`app.css:836`) matches `.rail` at (0,1,0), same as `:231`, and wins on source order. **For the impersonating case it is not.** `.app--impersonating .rail { top: 106px; max-height: calc(100vh - 106px) }` (`app.css:41`) has specificity **(0,2,0)**, which beats `:836`'s (0,1,0) regardless of the media query or source order. So while an Admin impersonates, at **1024×768 and at 390×844** the rail is `position: static` (from `:836`, which `:41` does not contest) but still `max-height: calc(100vh - 106px)` with `overflow: auto` (from `:231`, likewise uncontested) — an in-flow block that is *also* a nested scroll container sized off the large viewport. Two consequences, both reachable today: on mobile the URL bar's collapse leaves the rail taller than the visual viewport with its own trapped scrollbar, and on any impersonating ≤1080 viewport the rail scrolls inside the page rather than with it. `top: 106px` is inert under `position: static` and is not part of the defect. | **Fix — one `app.css` declaration** (§5.1, criterion 16). Add `.app--impersonating .rail { max-height: none; }` **inside** the existing `@media (max-width: 1080px)` block, after the `.rail` reset at `:836`. Same (0,2,0) specificity as `:41`, later in source, so it wins without `!important` and without touching `:41`, whose desktop geometry is unchanged. `overflow: auto` on a block with no `max-height` is inert, so no second declaration is needed. Impersonating captures at **all three** viewports are required evidence. |

Every row is fixed, preserved or explicitly deferred; none is left unassessed.
`TB0-VIS-02` (`revamp_2026_portal/baseline/TB0/Drift-Register.md:61`) gains TB8-03 evidence **only**
for its truthful rail and non-media collection subset. Its media/Lightbox portion stays N/A.

### 3.2 Where this plan diverges from the earlier draft

**a. `.workspace-intro` and `.empty` are not split.** The earlier draft proposed replacing both with
collection-only hooks. Both are shared with surfaces this candidate defers — `.workspace-intro` with
the RAW/Edited header (`ProjectWorkspace.tsx:488`), `.empty` with **31 occurrences across nine
source files** (grep of `className` strings on `main`, 2026-09-02): `Admin.tsx` (9),
`ProjectWorkspace.tsx` (8), `ProjectActivityView.tsx` (4), `ProductionCalendar.tsx` (3),
`CollectionPanel.tsx` (2), `App.tsx` (2), `EditProject.tsx` (1), `Dashboard.tsx` (1) and
`PhotoGrid.tsx` (1). An earlier six-file figure was stale; the three files it omitted —
`ProductionCalendar.tsx`, `Dashboard.tsx` and `PhotoGrid.tsx` — sit on Calendar, Dashboard and media
surfaces this candidate does not own, which makes the leave-untouched disposition **more**
clear-cut, not less.
Splitting them — to fix an off-grid `6px` margin, a `13.5px` literal **and, in both, a `--text-muted`
3.6:1 body-text contrast failure** (`app.css:21,793`; the same defect E-7 fixes on the rail) — would
ship a **visible divergence between sibling tabs of the same workspace**: RAW and Edited would keep
one header dialect while Video, Floorplan and Copy took another, and a user switching tabs would see
the difference. That is the opposite of convergence, and it would leave the *worse-lit* half of each
pair on the surfaces this candidate does not own. Both stay whole and untouched; **all three**
defects per selector are recorded as a deferral with a named owner (§1.2, §5.9a, §5.9b) so they
change together with their other consumers.

**b. `StatusBadge` does not use `.statetag`.** The earlier draft identified `StatusBadge`
(`atoms.tsx:12`) with `.statetag` (`app.css:197-200`). It does not: `atoms.tsx:18-22` renders
`<span class="row gap2"><span class="sdot" …/><span class="ey">…</span></span>` — a 7px colour dot
(`app.css:133`) plus a spaced-caps label. `.statetag` is a different, photo-overlay atom used by
`PhotoGrid.tsx:177-181`, `CollectionPanel.tsx:42,170`, `ProjectDiscussionThread.tsx:211`,
`ProjectWorkspace.tsx:488` (the AutoHDR jobs list) and `ProjectOverviewRail.tsx:131`. TB8-03 removes
the class from exactly two of those — `CollectionPanel.tsx:42`'s link provenance and
`ProjectOverviewRail.tsx:131`'s "Blocked" pill — and leaves the other four, and the rule itself,
untouched. The correction matters twice: it makes E-2's duplication finding
exact, and it makes E-16 a `.statetag` problem rather than a `StatusBadge` one.

**c. `.project-deadline__overdue` has deferred consumers.** The earlier draft placed the whole
`.project-deadline*` family under blanket retirement. `ProjectKanbanBoard.tsx:277` **and `:322`**
both render `.project-deadline__overdue` — the compact and the expanded card body — so retiring
`app.css:279,281` wholesale would have silently unstyled a Kanban card in two places. §7 row 12
splits the grouped selector instead.

**d. The fact rhythm changes.** The earlier draft preserved the two-column key/value split. §4.1
and §5.2 replace it, for the reason given in E-4.

**e. The Stage control's paint owner is stated concretely.** The earlier draft said only "style its
label/control consistently with other 44px fields." §5.3 gives the exact class string and the
reasoning for keeping the native element.

---

## 4. Design direction

### 4.1 The organising idea: the rail is a docket, not a sidebar

Quincy's system is *"an arthouse film studio's letterhead"* — ink on warm paper, hairline rules,
spaced caps, square corners, structure drawn with rules rather than boxes (readme § Visual
foundations). The rail is where a staffer answers one question: *where is this job, when is it due,
who is on it, and what has been delivered.* That is a **job docket**, and a docket is set as a
masthead over a stack of ruled entries — not as eight identically-weighted panels separated by eight
identical hairlines, which is what it is today.

**Three structural devices carry the whole surface. All three are named by the system already.**

1. **One 3px ink rule, spent once.** `--border-width-rule` (`tokens/spacing.css:35`) is described in
   the system's own token comment as *"the editorial rule under section heads."* It goes under the
   **masthead only** — the boundary between *which property this is* and *what work it needs*.
   Every other section keeps the 1px greige hairline. TB8-01 shipped the identical device on the
   Dashboard masthead (`Dashboard.tsx:922`), so the two surfaces now open the same way. This is the
   plan's one loud move, and it is spent in one place.
2. **Facts stack; they do not straddle.** Key in spaced caps above its value, both flush to the same
   left edge. This is how a call sheet sets metadata, it kills E-4's ragged gutter, and at a 224px
   measure it hands every value the full column instead of half of it.
3. **A rule marks the active thing; a fill never does.** The 2px `--border-width-bold` ink left rule
   means exactly one thing across this surface — *this is the row you are on, or the editor you have
   open.* Hover tints paper (`bg-secondary`); the rule is what distinguishes. That is TB8-02 §3.3's
   *highlight-is-ink, hover-is-paper* device, extended from option lists to the rail, and it is why
   state is never colour-alone.

### 4.2 The one aesthetic risk: Production notes are set in Athelas

`--font-body-serif` / `--type-body-serif` are fully specified (`tokens/typography.css:15,60`) and the
four Athelas faces are self-hosted and loaded (`styles/fonts.css:33-63`).

**Athelas is already on the product, and that strengthens this decision rather than weakening it.**
TB5C shipped `production-calendar.css:175`, which paints the schedule editor's intro paragraph in
Athelas via `var(--font-serif, Athelas, Georgia, serif)` — and since `--font-serif` is defined
nowhere, that literal fallback is what renders (E-17). So this is **not a first activation** and
must not be argued as one. The precedent it sets is the argument: the one existing use is a short
paragraph of explanatory running prose, set in the serif, inside a surface otherwise built from
labels and controls — **exactly** the role and shape Production notes has here. Setting Production
notes in the same face is a *consistent second use*, not a novel gesture, and the readme names the
role directly: *"the long-form body serif… a warm, readable book face for running prose (paired with
Apfel for UI)."*

What is new is only that this is the **first consumer to reach the face through its own role token**
(`--font-body-serif`) rather than through an undefined variable's fallback list — which is the small
correctness gain the decision carries alongside the aesthetic one.

Production notes are the only running prose on this surface — a sentence one person wrote for
another, in a rail otherwise made of labels, values and controls. Setting them in Athelas gives the
rail the one thing that makes it memorable rather than generically competent, and does so in a voice
the app has already established.

**Committed, not left open** (this lane exists to close ambiguity, not restate it):
`[font:var(--weight-regular)_var(--text-sm)/var(--leading-relaxed)_var(--font-body-serif)]` —
14px rather than `--type-body-serif`'s 18px, because at the rail's 224px measure 18px yields ~24
characters per line. At 14px/1.65 it yields ~31, and at ≤1080 the rail is full-width where the
measure is generous. If a reviewer disagrees, they are overruling **one stated decision**, not
re-opening a direction.

### 4.3 Colour discipline

No new colour. No gradient. No shadow on any in-flow element. The palette this surface uses:

| Role | Token / utility | Where |
| --- | --- | --- |
| Rail ground | `--paper-000` / `bg-card` | the rail itself (`app.css:231`, preserved) |
| Raised / hover / open-editor ground | `--paper-100` / `bg-secondary` | tab hover + active, Deadline editor |
| Ink | `--ink-900` / `border-l-primary`, `outline-ring` | the 3px masthead rule, the 2px active rule, focus |
| Body text | `--text-primary` / `text-foreground` | values, member names, tile titles |
| Labels, keys, metadata | `--text-secondary` / `text-foreground-secondary` | **every** muted *text* role — E-7 |
| Non-text muted | `--text-muted` / `text-muted-foreground` | **non-text only — no text exception anywhere on this surface** (E-7, §5.6). Not used on the collection count in either state |
| Caution | `--signal-caution` | inactive membership, Deadline conflict, Dropbox blocked |
| Critical | `--signal-critical` | errors, Overdue |
| Positive | `--signal-positive` | already-selected candidate (`app.css:269`, preserved) |
| Stage hue | `atoms.tsx:3-10`'s `stageColors` | the `.sdot` only — preserved, untouched |

**Removals — the "take one thing off" pass.** The duplicated Stage badge in the masthead (relocated,
not deleted); the `.statetag` translucent pill inside the sync button; the Deadline editor's
invisible card border; `--shadow-sm` on the dragged tile; the 4px radius leaking onto the collection
rows; `opacity: .78` and `border-style: dashed` on inactive members; two raw Unicode glyphs.

---

## 5. Target visual system

All class strings below are complete and final. The builder applies them; it does not invent.
`cn(...)` from `lib/utils.ts` composes them.

### 5.1 Rail frame and masthead

Preserve, unchanged: the `288px 1fr` grid (`app.css:230`), sticky `top: 64px` with
`max-height: calc(100vh - 64px)` and `overflow: auto` (`:231`), the impersonation override at `:41`,
and the ≤1080 in-flow transition at `:834-836`.

**One declaration is added to `app.css`, and it is the only addition this plan makes to that file
(E-20).** Inside the existing `@media (max-width: 1080px)` block, immediately after the `.rail`
reset at `:836`:

```css
.app--impersonating .rail { max-height: none; }
```

`:41`'s `.app--impersonating .rail` is (0,2,0) and today defeats `:836`'s (0,1,0) `max-height: none`,
so an impersonated rail keeps a large-viewport `vh` height *and* `overflow: auto` at 1024×768 and
390×844 — an in-flow nested scroller with the iOS URL-bar hazard. The added rule matches at the same
(0,2,0) and sits later in source, so it wins without `!important`. `:41` itself is not edited: its
`top: 106px` is inert under `position: static`, and its desktop geometry above 1080 is untouched.
This is a fix to a real cascade defect, not a paint migration, which is why it lives in `app.css`
beside the geometry it corrects rather than in a utility (§7 row 2a).

`.work` and `.rail` keep their class names as
non-styling hooks — **retaining `.rail` is what keeps `app.css:41` working**; `.rail`'s own paint
migrates but the selector's *geometry* declarations at `:231` stay in `app.css` (§7 row 2).

**Section rhythm — one rule per section, on its bottom edge.** This is the single change that
removes the doubling problem the current `border-top` model creates against the new masthead rule.

```tsx
<aside className="rail p-[var(--space-6)] max-[720px]:p-[var(--space-4)]" aria-label="Project Overview">
```

The two padding utilities are **on the element, not implied**: §7 row 2 deletes `padding` from
`app.css:231` and deletes the `.rail { padding: var(--space-4) }` ≤720 override at `:865` outright,
so this string is the only thing left that pads the rail. Everything else `.rail` owns —
`position: sticky`, `top`, `align-self`, `max-height`, `overflow`, `border-right`, `background` — is
geometry that stays in `app.css` for `:41` and `:836` to override, which is why the class name is
retained.

Masthead (`ProjectOverviewRail.tsx:88-92`):

```tsx
<section
  className="rail__sec project-overview__header
             pt-0 pb-[var(--space-5)] max-[720px]:pb-[var(--space-4)]
             [border-bottom-style:solid] border-b-[length:var(--border-width-rule)] border-b-primary"
  aria-labelledby="project-overview-property"
>
  <h2 id="project-overview-property"
      className="[font:var(--type-h3)] tracking-[var(--tracking-tight)] text-foreground [text-wrap:pretty]">
    {project.street}
  </h2>
  <div className="mt-[var(--space-2)]
                  [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)]
                  uppercase tracking-[var(--tracking-wide)] text-foreground-secondary">
    {[project.suburb, project.postcode].filter(Boolean).join(" · ")}
  </div>
</section>
```

- `[font:var(--type-h3)]` is `400 28px/1.18 --font-display`, used **unmodified** — the cleanest
  possible citation, and a deliberate 24px→28px increase (E-1). `.serif` is dropped from this `h2`;
  its `app.css:22` rule stays for its many other consumers.
- The `<div style={{ marginBottom: 10 }}>` wrapper around `StatusBadge` at
  `ProjectOverviewRail.tsx:89` **is removed with the badge** (E-2 → §5.3).
- **`pt-0` at every viewport**, not only ≤720. Today `.rail__sec`'s 24px top padding applies to the
  masthead on desktop and is zeroed only at ≤720 (`app.css:867`); the rail's own 32px padding
  already provides that space, so the desktop inset is doubled today. Zeroing it everywhere is a
  deliberate, stated change and makes `app.css:867` redundant (§7 row 6a).
- `base.css:19` already sets `h2 { margin: 0; font-weight: 400 }` unlayered; the shorthand restates
  the weight, so no `!` is needed.

Every other section:

```tsx
<section className="rail__sec py-[var(--space-5)] max-[720px]:py-[var(--space-4)]
                    [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border
                    last:border-b-0" …>
```

Section label — **replaces `.ey` on rail labels** (`.ey`'s `app.css:20` rule stays for its many other
consumers; the class is simply not applied here). `.rail__section-label` is kept as a non-styling
hook.

```tsx
<div className="ey rail__section-label …"          ← BEFORE
<div className="rail__section-label mb-[var(--space-3)]
                [font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)]
                uppercase tracking-[var(--tracking-wide)] text-foreground" …>   ← AFTER
```

Two decisions stated: **`--tracking-wide`, not `--tracking-widest`** — `.q-eyebrow`'s widest tracking
(`base.css:40-45`) is set for a marketing page's generous measure; TB1's shipped `FieldLabel` uses
`tracking-[var(--tracking-wide)]` for exactly this UI-label role (`ui/field.tsx:26`), and that is the
in-repo precedent. And **ink, not secondary** — the section label is a heading; the fact *keys*
beneath it are `--text-2xs` + `text-foreground-secondary`, giving a two-step hierarchy in both size
and weight of colour, with both values on-scale.

`.project-overview__heading` ("Project Overview", `display: none` desktop / `block` ≤720,
`app.css:236,866`) keeps that behaviour; its paint moves to the same utilities as a section label
plus `hidden max-[720px]:block`.

### 5.2 Fact rows — `.rail-kv`

Case (b). Applied at `ProjectOverviewRail.tsx:36,96,97,109,110` and
`ProjectDeadlineControl.tsx:162,163`. `.kv` and its entire `app.css:275-277` rule are **left
untouched** for `ProjectWorkspace.tsx:332,488`. `.rail-kv`, `.k` and `.vv` are non-styling hooks.

```tsx
<div className="rail-kv grid gap-[var(--space-1)] py-[var(--space-2)]">
  <span className="k [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)]
                   uppercase tracking-[var(--tracking-wide)] text-foreground-secondary">Stage</span>
  <span className="vv [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]
                   text-foreground [overflow-wrap:anywhere]">…</span>
</div>
```

`[overflow-wrap:anywhere]` replaces the current strategy of shrinking a right-aligned value; long
agency names and pending-date strings now wrap within the full column.

### 5.3 Stage

`StatusBadge` moves out of the masthead and **becomes the Stage row's value**, in both branches of
`ProjectOverviewRail.tsx:96`. One statement instead of two (E-2), and the rail's only chromatic mark
— the `.sdot` — now sits where Stage actually lives. **`atoms.tsx` receives no edit**;
`components/atoms.tsx` is explicitly excluded from the touched-file list (§6).

```tsx
// read-only branch (canMoveStage === false)
<div className="rail-kv …"><span className="k …">Stage</span>
  <span className="vv …"><StatusBadge stageKey={project.stageKey} /></span></div>

// StageControl's own row, ProjectOverviewRail.tsx:36 — same shape
```

**The `<select>` stays a `<select>`.** It is *not* migrated to `ui/select.tsx`, for three reasons
that are each independently sufficient:

1. `SelectOption<T>` is `{ value: T; label: string }` (`ui/select.tsx:16`) — it cannot express a
   disabled item. The rail requires one: the current-but-inactive Stage stays visible and
   unselectable (`ProjectOverviewRail.tsx:42`), asserted at `ProjectOverviewRail.dom.test.tsx:70`.
2. `ProjectWorkspace.tsx:407-408` restores post-move focus via
   `querySelector<HTMLSelectElement>('[data-focus-key=…]')` and reads `.disabled`. Base UI's trigger
   is a `<button>`; the cast and the `disabled`-vs-`aria-disabled` distinction deliberately encoded
   at `ProjectOverviewRail.tsx:30-34` do not survive the swap.
3. The roadmap forbids a whole-app rewrite and requires one styling owner — not one implementation.
   Painting the native control to match the shipped `Select` trigger delivers the visual convergence
   at a fraction of the behavioural risk.

`buttonClasses()` is **not** reused here: it returns `inline-flex` plus `justify-center`/`gap`, which
are inert or wrong on a replaced form control. The constant below takes its surface, border, radius,
focus and disabled treatment from `VARIANT.secondary` (`ui/button.tsx:35-36`) and `BASE` (`:19-30`),
so the two controls read as the same family.

**Two values deliberately diverge from the Dashboard `Select` trigger, and this is a design choice,
not a reproduction.** The shipped trigger is `buttonClasses("secondary")` plus
`normal-case tracking-normal` (`ui/select.tsx:52-57`), which means `--text-xs` (12px) and
`min-h-[38px]`, reaching 44px only at ≤720 via `Dashboard.tsx:964,973`'s
`max-[720px]:min-h-[44px]`. `STAGE_SELECT` instead uses **`--text-sm` (14px) and `min-h-[44px]` at
every viewport**, because:

- The Dashboard control is one row of a dense, scannable board toolbar sitting beside other 12px
  chrome; the rail's Stage control is the surface's single most consulted **fact** and its only
  guarded write. A rail fact deserves an always-legible size and an always-full pointer target, not
  one that shrinks on the viewport where the rail is widest.
- 14px is the same step the rest of the rail's *values* take (`.rail-kv`'s `.vv`, §5.2), so the
  control matches the column it sits in rather than a different surface's toolbar.
- 44px everywhere is the same rule this plan applies to every other rail control (§5.4, §5.5, §5.6,
  §5.7, §5.9) — E-6's finding is precisely that 44px-only-at-≤720 is the defect.

Everything else — `--radius-sm`, the hairline border, `bg-card`/`border-border`, the hover pair, the
2px ink `focus-visible` ring at `outline-offset-2`, the disabled set, sentence case (no
`uppercase`/`tracking-wide`), and the `ChevronDown` treatment — is the shipped trigger's, unchanged.
`BASE`'s `active:not-disabled:translate-y-px` is dropped: a nudge-on-press reads as a button
affordance and a `<select>` opens a native menu instead. The divergence is stated here so a reviewer
can accept or overrule **two named values**, not re-litigate the control.

```tsx
// ProjectOverviewRail.tsx — module scope
const STAGE_SELECT =
  "w-full appearance-none cursor-pointer text-left " +
  "min-h-[44px] " /* WCAG 2.5.5 Enhanced target, not a spacing token */ +
  "pl-[14px] pr-[var(--space-7)] py-[9px] " +
  "rounded-[var(--radius-sm)] border-solid border-[length:var(--border-width-hair)] " +
  "bg-card border-border text-foreground " +
  "[font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)] " +
  "transition-[background-color,color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "hover:not-disabled:bg-secondary hover:not-disabled:border-border-hover " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 " +
  "disabled:text-foreground-secondary disabled:bg-surface-sunken disabled:border-border disabled:cursor-not-allowed";
```

```tsx
<div className="stage-control grid gap-[var(--space-1)]">
  <div className="rail-kv …">…Stage / <StatusBadge …/>…</div>
  <label className="sr-only" htmlFor={…}>Move project Stage</label>
  <div className="relative">
    <select className={STAGE_SELECT} …>{…}</select>
    <ChevronDown aria-hidden="true"
      className="pointer-events-none absolute right-[var(--space-3)] top-1/2 -translate-y-1/2
                 size-[var(--space-3)] stroke-[1.5] text-foreground" />
  </div>
  {unavailable && <span className="stage-control__message block mt-[var(--space-1)]
                   [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)]
                   text-foreground-secondary">{unavailable}</span>}
</div>
```

`ChevronDown` at `stroke-[1.5]` and `size-[var(--space-3)]` matches `ui/select.tsx:61` exactly.
`.stage-control__message`'s `text-align: right` (`app.css:601`) becomes left, aligning with the new
flush-left fact rhythm. `data-focus-key`, `aria-label`, `aria-disabled`, `aria-busy`, `value`,
`disabled`, the option set and the `onChange` guard are all untouched.

`.rail__edit` (the "Edit details" `InternalLink`) becomes
`buttonClasses("secondary", { className: "w-full mt-[var(--space-4)] min-h-[44px]" })` — it stays a
real `<a href>` via `InternalLink`, per TB8-01 §2.1's anchor-safety rule. The class name
`rail__edit` is retained as a non-styling hook (`ProjectWorkspace.dom.test.tsx:1262` queries it).

### 5.4 Deadline

Deadline stays inline in the rail — it is its canonical home (D-18). Query-ownership acquisition and
release (`ProjectDeadlineControl.tsx:62-71`), the conflict reapply buffer (`:83-105,141-150`), the
DST fold flow and every mutation path are untouched. **No wrapper, conditional or `key` may be
introduced that remounts this component during a background refresh.**

**Facts.** The two rows adopt `.rail-kv` (§5.2). The zone line and Overdue mark drop
`.project-deadline__zone` / `.project-deadline__overdue` (case (b) — the `app.css:279,281` rules stay
for `ProjectKanbanBoard.tsx:277` and `:322`; §7 row 12 splits the grouped selector):

```tsx
<small className="block mt-[var(--space-1)]
                  [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)]
                  text-foreground-secondary">Sydney (Australia/Sydney) · {…}</small>
{overdue && <strong className="block mt-[var(--space-1)]
                  [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)]
                  uppercase tracking-[var(--tracking-wide)] text-[color:var(--signal-critical)]">Overdue</strong>}
```

The `<strong>` element is kept for semantics; `--weight-regular` in the shorthand kills the
faux-bold (E-5/E-9), and the state is carried by the word plus case plus hue — never hue alone.

**Summary, inactive and mandatory copy.**
`grid gap-[var(--space-1)] [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary`.

**Actions.** `Edit Deadline` / `Set Deadline` / `Resume reminders` / `Clear` become
`buttonClasses("text", { className: "min-h-[44px]" })`; `Save Deadline` becomes
`buttonClasses("primary", { className: "min-h-[44px]" })`; `Reload latest` and `Add` become
`buttonClasses("secondary", { className: "min-h-[44px]" })`. Per §2.2, no `!` is needed — the
caller's `className` merges last through `twMerge`. Action rows: `flex flex-wrap
gap-[var(--space-2)] mt-[var(--space-3)]`.

**The editor stops being a card and becomes an opened state** (E-8):

```tsx
<form className="project-deadline__editor grid gap-[var(--space-3)] mt-[var(--space-3)]
                 p-[var(--space-4)] bg-secondary
                 [border-left-style:solid] border-l-[length:var(--border-width-bold)] border-l-primary">
```

Same 2px ink rule as the active collection row (§4.1 device 3): *this is the thing you have open.*
The white-on-white hairline box is gone, and the editor is now legibly distinct from the resting
state at a glance.

**Editor structure — every element §7 row 11 unstyles gets its replacement here.** `app.css:286-287`
and `:290` carry layout and user-agent resets that nothing else in this plan reproduced; without
them the built UI would expose raw `<fieldset>` chrome and a collapsed editor head. Each is named
below with its complete final class string, in render order
(`ProjectDeadlineControl.tsx:169-172`).

```tsx
{/* :169 — editor head. Replaces app.css:286's flex row for this element. */}
<div className="project-deadline__editor-head flex items-center justify-between gap-[var(--space-2)]">
  <strong className="[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)]
                     uppercase tracking-[var(--tracking-wide)] text-foreground">
    {deadline ? "Edit Deadline" : "Set Deadline"}
  </strong>
  <button type="button" className={buttonClasses("text", { className: "min-h-[44px] shrink-0" })} …>Cancel</button>
</div>

{/* :170 — date + time. Replaces app.css:286-287 (flex row, `> label { flex: 1 }`). */}
<div className="project-deadline__inputs grid gap-[var(--space-3)]">
  <label className={DEADLINE_LABEL}>Date<input className={DEADLINE_FIELD} … /></label>
  <label className={DEADLINE_LABEL}>Time<input className={DEADLINE_FIELD} … /></label>
</div>

{/* :171,:172 — both fieldsets. Replaces app.css:290's reset in full. */}
<fieldset className="project-deadline__fieldset grid gap-[var(--space-2)] border-0 p-0 m-0 min-w-0">
  <legend className="mb-[var(--space-1)] p-0
                     [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)]
                     uppercase tracking-[var(--tracking-wide)] text-foreground-secondary">…</legend>
  {/* preset checkbox rows — see "Checkboxes and radios" below */}

  {/* :171 — custom-offset wrapper. Replaces app.css:286-287 for this element. */}
  <div className="project-deadline__custom flex flex-wrap items-end gap-[var(--space-2)]">
    <input className={cn(DEADLINE_FIELD, "flex-1 min-w-0")} type="number" … />
    <button type="button" className={buttonClasses("secondary", { className: "min-h-[44px] shrink-0" })} …>Add</button>
  </div>
  …
</fieldset>
```

Three stated decisions in that block:

- **`border-0 p-0 m-0` on the `<fieldset>` is not optional.** The user agent's default
  `border: 2px groove` and `padding: 0.35em 0.75em` are exactly what `app.css:290` existed to kill;
  §7 row 11 deletes that rule, so the reset must be carried by the element. `min-w-0` is added
  because a `<fieldset>` does not shrink below its content's `min-content` width by default, which
  at the rail's 224px measure would push the number input out of the column.
- **Date and time stack rather than sitting two-up.** `app.css:286` put them side by side; inside a
  190px editor column that gives each ~91px, which no platform's native date control fits — a
  guaranteed criterion-20 horizontal-overflow failure. One column at every viewport; below 1080 the
  rail is full width and the stack simply reads generously.
- **The editor head's `<strong>` takes `--weight-regular`** and carries hierarchy through case and
  colour, for the same reason as everywhere else on this surface (E-5).

Both fieldsets get `.project-deadline__fieldset` as a **new non-styling hook**; it is a new class
name, not a retained legacy one, and no `app.css` rule is written for it.

**Fields.** One constant, `RAIL_FIELD`, defined in `lib/` and imported by **both**
`ProjectDeadlineControl.tsx` and `CollectionPanel.tsx` (§5.9d) — the rail and the collection shell
get the same field or the release has two owners again. `DEADLINE_FIELD` below **is** that constant;
the name is used in §5.4's snippets for readability and resolves to the same import. It deliberately does **not** reuse
`ui/input.tsx`: that primitive carries `.quincy-input`, whose unlayered
`:focus, :focus-visible { outline: none }` (`app.css:1040-1044`) would import a defective focus
contract into the rail (§1.2 deferral). The rail's fields keep the real 2px ink ring.

```tsx
const DEADLINE_FIELD =
  "w-full min-w-0 min-h-[44px] " /* WCAG 2.5.5 Enhanced target, not a spacing token */ +
  "px-[var(--space-3)] py-[var(--space-2)] " +
  "rounded-[var(--radius-sm)] border-solid border-[length:var(--border-width-hair)] border-border " +
  "bg-card text-foreground " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] " +
  "hover:not-disabled:border-border-hover " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 focus-visible:border-[color:var(--border-strong)]";
```

`bg-card` (paper-000) rather than the current `--paper-050`, because the editor ground is now
`bg-secondary` (paper-100) — fields must read *lighter* than their container, which is the direction
the current combination has backwards.

**Editor labels and legends.** A second shared constant beside `DEADLINE_FIELD`, replacing
`app.css:288` (which §7 row 11 deletes):

```tsx
const DEADLINE_LABEL =
  "grid gap-[var(--space-1)] " +
  "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] " +
  "uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";
```

The `<legend>` uses the same three type/colour utilities without `grid gap-*` (it is not a wrapper),
as written in the structure block above.

**Checkboxes and radios.** The native control stays conventionally sized and ink-accented; the
**label row** carries the target:

```tsx
<label className="flex items-center gap-[var(--space-2)] min-h-[44px] cursor-pointer
                  [font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)] text-foreground">
  <input type="checkbox" className="size-[var(--space-4)] shrink-0 [accent-color:var(--ink-900)]" … />
  {deadlineOffsetLabel(preset)}
</label>
```

`[accent-color:…]` is written in Tailwind's arbitrary-property form rather than the `accent-*`
utility, so no assumption is made about the utility's colour-value parsing.

**Custom-offset chip.** `.project-deadline__custom-chip` becomes
`inline-flex items-center gap-[var(--space-2)] w-fit px-[var(--space-2)] py-[var(--space-1)]
bg-card border-solid border-[length:var(--border-width-hair)] border-border
[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] text-foreground` — square, per
`--radius-card: 0`.

Its `×` remove button carries the **whole** of `app.css:295`'s user-agent reset, which §7 row 11
deletes, plus the target — a `min-h`/`min-w` pair alone would leave the browser's default button
border, grey background and 13px system font inside the chip:

```tsx
<button
  type="button"
  aria-label={`Remove ${deadlineOffsetLabel(value)} reminder`}
  className="grid place-items-center shrink-0
             min-h-[44px] min-w-[44px] /* WCAG 2.5.5 Enhanced target, not a spacing token */
             border-0 p-0 bg-transparent cursor-pointer
             [font:var(--weight-regular)_var(--text-sm)/1_var(--font-sans)]
             text-foreground-secondary hover:text-foreground
             focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid
             focus-visible:outline-ring focus-visible:outline-offset-2"
  onClick={() => toggleOffset(value, false)}
>×</button>
```

`font: inherit` in the legacy rule is replaced by an explicit shorthand rather than inheritance,
because the chip's own type is now `--text-2xs` and a `×` glyph at 11px is not a usable mark. The
44×44 box grows outside the chip's own padding, so the chip's `py-[var(--space-1)]` stays as written
and the row's height is set by the target — that is the measured box criterion 20 checks.

**Conflict.** The `3px` left border (E-8) becomes `--border-width-bold` in caution, and the
`color-mix` tint is dropped entirely — the block now sits on `bg-card` inside the `bg-secondary`
editor, so the surface flip carries the separation and one fewer computed colour exists:

```tsx
<div className="project-deadline__conflict grid gap-[var(--space-2)] p-[var(--space-3)] bg-card
                [border-left-style:solid] border-l-[length:var(--border-width-bold)]
                border-l-[color:var(--signal-caution)]
                [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)]
                text-foreground" role="alert">
```

**The conflict subtree is replaced completely — all four descendants, not just the container**
(`ProjectDeadlineControl.tsx:174`). §7 row 11 deletes `app.css:283` and `:296`, and `.button--text`
leaves this element, so nothing below keeps a legacy owner:

```tsx
<div className="project-deadline__conflict …" role="alert">           {/* container, above */}

  {/* the lede. `<strong>` kept for semantics; --weight-regular kills the browser-synthesised
      bold (E-5) exactly as the editor head and the Overdue mark do. */}
  <strong className="[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)]
                     uppercase tracking-[var(--tracking-wide)] text-foreground">
    Deadline changed elsewhere.
  </strong>

  <span>Latest version: {conflict.version}. Your draft is still here for review.</span>

  {/* :174 — app.css:283's `.project-deadline__conflict-comparison` half. That rule is grouped with
      `__summary` and carries `display:grid; gap:3px; color; font-size:11px; line-height:1.45`;
      the grid and gap are what keep the two lines stacked, so a type-only string would collapse
      them onto one line inside a 190px column. */}
  {reapplyBuffer && (
    <div className="project-deadline__conflict-comparison grid gap-[var(--space-1)]
                    [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)]">
      <span className="text-foreground">Authoritative: {scheduleText(conflict)}</span>
      <span className="text-foreground-secondary">Saved draft: {draftText(conflictDraft)}</span>
    </div>
  )}

  {/* the conflict's action row — an unclassed <div> today, so it has never had a rule at all and
      its two buttons sit flush against each other. It takes the same generic action-row string as
      every other action row in §5.4. */}
  <div className="flex flex-wrap gap-[var(--space-2)]">
    <button type="button" className={buttonClasses("secondary", { className: "min-h-[44px]" })}
            onClick={() => void reloadLatest()}>Reload latest</button>
    <button type="button" className={buttonClasses("text", { className: "min-h-[44px]" })}
            onClick={reapplyDraft}>Review and reapply my draft</button>
  </div>
</div>
```

Three things this closes. **"Review and reapply my draft" migrates off `.button button--text`** —
it is `ProjectDeadlineControl.tsx:174`'s second button and was the one action in this component still
on legacy paint and a sub-44px target. **The action row gets `mt-*` from nothing** — unlike §5.4's
other action rows it needs no top margin, because the container's own `gap-[var(--space-2)]` already
separates it; adding one would double the space. **`--space-1` (4px) replaces `gap: 3px`**, the same
on-grid substitution `__summary` takes above, so the comparison block and the summary block still
read as the same construction.

`.project-deadline__conflict-comparison` is retained as a non-styling hook.
Authoritative-vs-saved-draft lines keep their existing text and stay visually distinguishable: the
authoritative line `text-foreground`, the saved draft `text-foreground-secondary`.

**Errors.** `.notice` (`app.css:951`) is app-wide shared — **left untouched**, class retained.

### 5.5 Team

Roster mutation logic, eligibility, optimistic deltas, confirmation counts, membership-cycle conflict
and access-loss behaviour (`ProjectTeamControl.tsx:121-182`) are untouched. The picker remains an
`AnchoredPopover` (`:69-100`); its engine, portal, Escape and focus behaviour are **not reopened** —
synchronous Escape focus restoration is a hard, twice-rediscovered invariant
(`docs/lessons.md:904-929`). `.project-team-picker*` (`app.css:256-274`) is TB8-02's owner and stays.

Photographers and Editors remain separate labelled sections.

**Containers.** `app.css:238-239` own the two stacking rhythms §7 row 8 deletes; both are replaced on
their own elements, and both class names stay as the hooks
`ProjectTeamControl.dom.test.tsx` and `data-testid="project-team-control"` rely on:

```tsx
<div className="project-team grid gap-[var(--space-4)]" data-testid="project-team-control">   {/* :200 */}
  <section className="project-team__role grid gap-[var(--space-2)]"                            {/* :187 */}
           aria-labelledby={`project-team-${roleOnProject}-heading`}>
```

Values are the legacy ones unchanged (`--space-4` between the two role sections, `--space-2` inside
one) — these two rules were already on-scale, so this is a pure ownership move with no visual delta,
and the matched capture should show the two sections in exactly their current positions.

**Role head:**

```tsx
<div className="project-team__role-head flex items-center justify-between gap-[var(--space-2)]">
  <h3 id={…} className="[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)]
                        uppercase tracking-[var(--tracking-wide)] text-foreground">{roleLabel(…)}s</h3>
  {canEdit && <TeamPicker … />}
</div>
```

`font-weight: 500` is gone (E-5); hierarchy comes from case and colour.

**The picker trigger** (`ProjectTeamControl.tsx:68`) becomes

```tsx
<button ref={setTrigger} type="button" aria-label={`Add ${roleLabel(roleOnProject)}`} …
  className={buttonClasses("secondary", {
    className: "project-team__add min-h-[44px] px-[var(--space-3)] shrink-0",
  })}
>+ Add</button>
```

The `--radius-pill` shape (`app.css:242`) is dropped: the readme allows pills *"only for the
toggle."* **`.project-team__add` is written inside the `className` passed to `buttonClasses`, not
merely "retained"** — the class only exists in the built DOM if it is in the string, and `cn()` is
`twMerge(clsx(...))`, which leaves a non-utility token like `project-team__add` untouched while
merging the rest. It carries no paint after §7 row 8; it is a hook, exactly like `.frow`,
`.dropcard` and `.rail__edit` elsewhere in this plan.

**Member rows become a ruled list, not a stack of boxes** (E-6):

```tsx
<div className="project-team__members grid">
  <div className="project-team__member grid grid-cols-[minmax(0,1fr)_auto] items-center
                  gap-[var(--space-3)] min-w-0 min-h-[44px] py-[var(--space-2)]
                  [border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border
                  first:border-t-0" …>
    <div className="project-team__identity grid min-w-0 gap-[var(--space-1)]">
      <strong className="[font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)]
                         text-foreground [overflow-wrap:anywhere]">{name || email}</strong>
      <small className="[font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)]
                        text-foreground-secondary [overflow-wrap:anywhere]">…</small>
    </div>
    {canEdit && <button type="button" disabled={…}
      className={buttonClasses("text", { className: "project-team__remove min-h-[44px] shrink-0" })}
      …>Remove</button>}
  </div>
</div>
```

`min-h-[44px]` on the row and on both controls, at **every** viewport — not only ≤720 (E-6).

**`.project-team__remove` is inside the `buttonClasses` `className`, not implied.** Eight live
queries select it directly — `ProjectTeamControl.dom.test.tsx:130,141,156,174,190,207,217` and
`ProjectTeamControl.confirm.dom.test.tsx:52` all call
`querySelector<HTMLButtonElement>(".project-team__remove")` — so omitting it from the string would
turn every one of those into a null-dereference throw, not a styling regression. §9 adds **no** edit
for these tests: they must pass untouched, and that is the proof the hook survived.
`.project-team__member`, `.project-team__identity` and `data-testid="project-member-…"` are hooks on
the same terms (`ProjectTeamControl.dom.test.tsx:189,206`).

**Inactive membership** drops `border-style: dashed` and `opacity: .78` entirely. The existing
`<em>Inactive</em>` (`ProjectTeamControl.tsx:195`) becomes the whole cue:
`ml-[var(--space-2)] not-italic uppercase tracking-[var(--tracking-wide)] text-[color:var(--signal-caution)]`.
The word carries the state, so this is not colour-alone, and no text has its contrast reduced.
`app.css:250`'s grouped rule also serves `.project-collaboration-summary .member em` — §7 row 8
splits it.

**Empty:** `<p className="project-team__empty m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">Not assigned</p>`.

**Error/conflict messages:** `.project-team__message` keeps its `role="alert"` and grid placement;
paint becomes `col-span-full [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)] text-[color:var(--signal-critical)]`,
and its inline Retry button becomes `buttonClasses("text", { className: "ml-[var(--space-2)] min-h-[44px]" })`
so the retry affordance is reachable by touch.

### 5.6 Collection switcher

Keep buttons, labels, counts and the `onActiveTabChange` contract. `availableTabs` continues to be
computed by capability and denial at `ProjectWorkspace.tsx:399`; the visual layer receives the list
and recreates no authorization logic. Denial-driven tab removal and cached-asset cancellation
(`ProjectWorkspace.tsx:243-250`) are tested exactly as they behave today. **Adding a link-loading
state, or relocating focus when a denied tab disappears, is runtime work and is deferred** — TB8-03
neither claims nor adds it.

```tsx
<div className="filterlist grid gap-[var(--space-1)]">
  {availableTabs.map((tab) => {
    const isActive = activeTab === tab;
    return (
      <button
        key={tab} type="button" aria-pressed={isActive}
        className={cn(
          "frow flex w-full items-center justify-between gap-[var(--space-3)] text-left cursor-pointer",
          "min-h-[44px] " /* WCAG 2.5.5 Enhanced target, not a spacing token */,
          "pl-[var(--space-3)] pr-[var(--space-3)] py-[var(--space-2)]",
          "rounded-none border-0 [border-left-style:solid] border-l-[length:var(--border-width-bold)]",
          "[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)] uppercase tracking-[var(--tracking-wide)]",
          "transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-standard)]",
          "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid",
          "focus-visible:outline-ring focus-visible:outline-offset-[-2px]",
          isActive
            ? "border-l-primary bg-secondary text-foreground"
            : "border-l-transparent bg-transparent text-foreground-secondary hover:bg-secondary hover:text-foreground",
        )}
        onClick={() => onActiveTabChange(tab)}
      >
        <span>{collectionLabel(tab)}</span>
        <span className="cnt [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-mono)]
                         [font-variant-numeric:tabular-nums] text-foreground-secondary"
        >{collection ? collection.receivedCount : "—"}</span>
      </button>
    );
  })}
</div>
```

Four things closed here:

- **Hover and active share the paper tint; only the rule differs.** TB8-02 §3.3's device, applied.
- **`rounded-none` is explicit**, defeating E-10's leaked `--radius-sm`. The `margin: 0 -10px` bleed
  is simply not reproduced.
- **`aria-pressed` on every rendered row** — `true` on exactly one, `false` on every other (E-11).
  **Not `aria-current="page"`**: this is component state (`ProjectWorkspace.tsx:399`,
  `props.activeTabChange`), not navigation.
- **`role="tablist"` was considered and rejected.** The rendered panels are not `role="tabpanel"`;
  adopting tab semantics would require roving tabindex, arrow-key navigation and `aria-controls`,
  which is behaviour change beyond a styling release and would land half-implemented — the exact
  defect TB8-02 §1.2 item L found in the two `role="menu"` widgets. `aria-pressed` on toggle buttons
  is the complete, honest contract for what this widget actually is.

`.filterlist` and `.frow` are retained as non-styling hooks — `.frow` is queried directly at
`ProjectWorkspace.dom.test.tsx:107,209-212,589,757,1222,1267,1271,1278`. **The label span must remain
the first child**, because `:1267,1271,1278` match on `textContent.startsWith(...)` (E-19).

**The count takes `text-foreground-secondary` in both states — decided here, not deferred to the
build or to the browser pass.** An earlier revision of this section split it, giving the inactive
row's count `text-muted-foreground`. That contradicted this plan's own E-7, which establishes
`--text-muted` at **3.6:1** on this exact ground (`--paper-000`) and rules it out for **every** muted
text role on the surface. A received-asset count is real UI content — the number a staffer reads to
know what has landed — not decoration, and it does not become decoration by sitting beside its own
label. The 11px size makes it worse, not exempt. So `--text-muted` survives on this surface for
**non-text only** (§4.3), with no text exception at all, and the two rows differ by the ink left rule
and the paper tint (§4.1 device 3) rather than by degrading one row's legibility. §4.3's palette
table keeps its single `text-muted-foreground` row, but scoped to **non-text only** — the count is
named there explicitly as not one of its uses.

### 5.7 Dropbox

Capability and folder gates (`ProjectOverviewRail.tsx:128`) unchanged. AutoHDR direct send remains
separate and Admin-only; Stage movement never implies send or cancel
(`docs/Implementation-Plan.md:147-155`).

```tsx
<button
  type="button" disabled={isSyncing} aria-busy={isSyncing || undefined}
  className={buttonClasses("secondary", { className: "dropcard w-full min-h-[44px]" })}
  onClick={onSyncDropbox}
>
  <RefreshCw aria-hidden="true" className="size-[var(--space-4)] shrink-0 stroke-[1.5]" />
  <span>{isSyncing ? "Syncing Dropbox…" : "Sync from Dropbox"}</span>
</button>
{autohdrBlocked && (
  <p role="status" className="mt-[var(--space-2)] m-0
       [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)]
       uppercase tracking-[var(--tracking-wide)] text-[color:var(--signal-caution)]">Blocked</p>
)}
```

Four decisions:

- **`RefreshCw`, `aria-hidden`, `stroke-[1.5]`** replaces `◈` (E-15), matching `ui/select.tsx:61`'s
  icon treatment. **It does not spin while syncing** — the readme forbids spin and infinite loops on
  content, and `app.css:825`'s reduced-motion rule would neutralise it anyway. The label change plus
  `aria-busy` carries the state.
- **`buttonClasses("secondary")` unmodified, uppercase and centred**, so this control and the
  "Edit details" link directly above it read as one pair of full-width rail actions. `select.tsx:54`'s
  `normal-case tracking-normal` override was considered and rejected: that override exists because a
  Select trigger displays a *value*, whereas this is a command label.
- **"Blocked" leaves the button.** It was a non-interactive status inside a control's accessible
  name, painted with a photo-overlay atom (E-16). As a sibling `role="status"` line in spaced caps
  and caution ink it says the same thing more clearly, gives the button the accessible name "Sync
  from Dropbox", and **leaves `.statetag`'s shared rule completely untouched**.
- `.dropcard` is retained as a non-styling hook (`ProjectWorkspace.dom.test.tsx:628,1263`).

### 5.8 Client facts and Production notes

Client facts adopt `.rail-kv` (§5.2) with no other change.

Production notes (`ProjectOverviewRail.tsx:115`) drop `.muted` and the inline `style`:

```tsx
<p className="m-0 [white-space:pre-wrap]
              [font:var(--weight-regular)_var(--text-sm)/var(--leading-relaxed)_var(--font-body-serif)]
              text-foreground-secondary">{project.productionNotes}</p>
```

This is §4.2's committed decision. `white-space: pre-wrap` is preserved. Contrast rises from 3.6:1 to
9.2:1 (E-7), and the paragraph becomes the one place *on this surface* set in the brand's book face —
matching the Calendar schedule editor's intro paragraph, which has been setting running prose in
Athelas since TB5C (`production-calendar.css:175`). This is the app's second Athelas use and its
first via `--font-body-serif`.

**One-line comment correction, in scope because this plan cites the file:**
`tokens/typography.css:7` currently reads *"Athelas (long-form body serif) was named in the kit but
not supplied; it falls back to a Charter/Georgia stack -- replace when the file arrives."* Both
halves are false: the four faces landed at `styles/fonts.css:33-63`, and the face is already being
painted on the Calendar. Correct the comment to record that Athelas is self-hosted, that
`--font-body-serif` / `--type-body-serif` are live, and that `production-calendar.css:175` reaches
the face through an undefined `--font-serif`'s fallback and should be normalised onto the role token
by its own candidate. **No declaration in that file changes.**

### 5.9 Reached collection shell

#### a. `.workspace-intro` — deliberately untouched

Both `CollectionPanel.tsx:160,170` consumers keep the class; `app.css:960-962` is not edited and not
split. Reasoning in §3.2a. **This is the mechanical seam that stops TB8-03 repainting RAW/Edited.**

**Deferred defects, recorded in full — three, not two.** The deferral is a scope decision, not a
clean bill of health, so the evidence names everything left behind:

1. **Off-grid spacing.** `.workspace-intro h1`'s `margin: 6px 0 0` (`app.css:961`) — 6px is on no
   step of `tokens/spacing.css`.
2. **Off-scale type.** `.workspace-intro .muted`'s `font-size: 13.5px` (`:962`) — between
   `--text-sm` (14px) and `--text-xs` (12px), on no step of `tokens/typography.css`.
3. **Failing text contrast — the same defect E-7 fixes everywhere else on this surface.**
   `.muted` is `color: var(--text-muted)` (`app.css:21`), and `--text-muted` is `--greige-400`
   `#8f8775` — **3.6:1**, below 4.5:1, and here it paints an entire descriptive paragraph rendered
   at 13.5px. That is the *same* token, the *same* ground and the *same* failure E-7 records for the
   rail; it is left in place only because the selector is shared with RAW/Edited, not because it
   passes.

**Named owner for all three: candidate #9 / the media runtime owner** — the candidate that moves
`ProjectWorkspace.tsx:488`'s RAW/Edited header (§1.2 row 1). It is the first candidate that can touch
`.workspace-intro` without creating the sibling-tab dialect §3.2a rules out, and it must fix the
contrast defect at the same time it normalises the two literals. Recording the contrast issue here,
rather than only the spacing and type, is what makes that obligation visible to it.

#### b. `.empty` — deliberately untouched

**31 occurrences across nine source files** app-wide, only two of them in `CollectionPanel.tsx`
(full inventory in §3.2a). Repainting or splitting it here would create a second empty-state dialect
inside one workspace — and would leak into Dashboard, Calendar, Admin, Activity and media surfaces
this candidate does not own. Reasoning in §3.2a.

**Deferred defects, recorded in full.** `.empty`'s **body text also fails contrast**:
`app.css:793` sets `color: var(--text-muted)` on the whole block — the same `#8f8775` at **3.6:1**
E-7 rules out for every muted text role on this surface — and `.empty` renders a real sentence of
guidance copy ("Add the first delivery link below."), not decoration. Its heading half is fine
(`:794` uses `--text-secondary`), which is precisely why the defect is easy to miss: the large serif
line reads well and the instruction under it does not. Alongside that, `.empty--raw p`'s
`font-size: 14.5px` (`:660`) is off-scale.

**Named owner: candidate #10, the app-wide shared-atom and dead-selector sweep** (§1.2's final row).
`.empty` is a nine-file shared atom with no single surface owner, so it belongs to the candidate that
takes the shared atoms as a set — the same one that owns `.statetag` and `.chip` — rather than to any
one surface candidate. It must treat the contrast failure as in scope, not only the off-scale
literal. Deferring the *fix* stays justified; deferring the *record* would not be.

#### c. Link tiles

```tsx
<div className={cn(
  "collection-link flex flex-col justify-between min-h-[var(--space-10)] p-[var(--space-4)]",
  "bg-card border-solid border-[length:var(--border-width-hair)] border-border rounded-none",
  isDragging && "opacity-[.45] border-[color:var(--border-strong)]",
)} …>
```

`min-h-[var(--space-10)]` (128px) replaces the off-grid `118px`; the extra height is consumed by the
grip growing 34px → 44px. `isDragging` **drops `--shadow-sm`** (E-14) and substitutes the ink border
— the tile is still in flow, so the system's shadow rule applies and no `DragOverlay` is introduced.

Tile title, at 21px → `--text-lg` (22px):

```tsx
<span className="collection-link__name
                 [font:var(--weight-regular)_var(--text-lg)/var(--leading-snug)_var(--font-display)]
                 tracking-[var(--tracking-tight)] text-foreground [overflow-wrap:anywhere]">{title}</span>
```

`.chip` (the host label) is left exactly as it renders today — shared atom, deferred (§1.2). Adding
utilities to either of these two elements requires the §9 test edit.

Links remain real `<a href>` anchors with their existing `target`/`rel`
(`CollectionPanel.tsx:42`); no card-level click handler is introduced.

**The link body — `app.css:968-970`'s replacement.** Those three rules lay out the tile's content
row (`.collection-link > a` and its non-link twin `.collection-link__plain`), set the anchor's
colour and kill its underline, and stack the pair into a column in the Video grid only. §7 row 20
deletes all three, so one constant carries all of it, applied to **both** branches so the linked and
unlinked tiles stay identical — which is what `CollectionPanel.dom.test.tsx`'s real-anchor
assertions depend on:

```tsx
// CollectionPanel.tsx — module scope
const LINK_BODY =
  "flex items-start justify-between gap-[var(--space-3)] min-w-0 " +
  "text-foreground no-underline " +
  // Video-only column stacking, replacing app.css:970. `.collection-links--video` stays on the
  // grid (§5.9f) purely as the structural hook this arbitrary variant reads.
  "[.collection-links--video_&]:flex-col [.collection-links--video_&]:items-start";
```

```tsx
{safeUrl
  ? <a href={safeUrl.href} target="_blank" rel="noopener noreferrer" className={LINK_BODY}>{content}</a>
  : <div className={cn("collection-link__plain", LINK_BODY)}>{content}</div>}
```

**The parent-class arbitrary variant is deliberate, in preference to threading the existing `video`
prop down from `LinkTiles` into `LinkTile`.** `video` is currently a `LinkTiles`-only prop
(`CollectionPanel.tsx:46,53`); adding it to `LinkTile`'s signature would change a component
interface in a paint-only release, and the descendant selector reproduces `app.css:970`'s semantics
exactly. `.collection-links--video` therefore keeps its class name — as a **structural** hook, the
one place in this plan where a retained class name is read by a utility rather than only by a test.

`no-underline` and `text-foreground` are the anchor's; the `<div>` branch inherits both from
`.collection-link` anyway and carries them harmlessly, which is the point of using one constant.

**Provenance** drops `.statetag`/`st-editing` (case (b); the shared rule stays whole for its four
remaining consumers — `PhotoGrid.tsx:177-181`, `CollectionPanel.tsx:170`,
`ProjectDiscussionThread.tsx:211` and `ProjectWorkspace.tsx:488`) and becomes metadata rather than a
translucent pill on paper:

```tsx
<span className={cn(
  "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] uppercase tracking-[var(--tracking-wide)]",
  link.source === "tonomo" ? "text-[color:var(--signal-caution)]" : "text-foreground-secondary",
)}>{link.source === "tonomo" ? "Tonomo" : "Manual"}</span>
```

The ochre/neutral distinction the current `st-editing` background carries is preserved as ink, and
the word names the source, so it is never hue-alone.

Meta row: `collection-link__meta flex items-center justify-between gap-[var(--space-2)] mt-[var(--space-4)]`.
Edit/Remove become `buttonClasses("text", { className: "min-h-[44px]" })` with `ml-auto` on the first
of them, reproducing `app.css:973`.

#### d. Add form and inline editor

**One `<form>` element, two states, two complete class strings.** `CollectionPanel.tsx:42` renders
the inline editor as `className="collection-link-form collection-link-editor"` — the same base form
with `app.css:984` overriding it back to one column, no padding, no border and a transparent ground
so it sits *inside* a tile. §7 row 20 deletes both rules, so the base is shared as a constant and the
two states diverge explicitly. **The responsive three-column track is added only by the add form**,
which is the mechanical reason a tile-sized editor never picks it up:

```tsx
// CollectionPanel.tsx — module scope
const LINK_FORM_BASE =
  "collection-link-form grid grid-cols-1 gap-[var(--space-3)] items-end min-w-0";
```

```tsx
{/* the standalone add form */}
<form className={cn(
  LINK_FORM_BASE,
  "p-[var(--space-4)] bg-secondary border-solid border-[length:var(--border-width-hair)] border-border",
  "min-[640px]:grid-cols-[minmax(220px,1.5fr)_minmax(180px,1fr)_auto]",
)} …>

{/* the inline editor, inside a tile (CollectionPanel.tsx:42) — app.css:984's replacement */}
<form className={cn(LINK_FORM_BASE, "collection-link-editor p-0 border-0 bg-transparent")} …>
```

`p-0 border-0 bg-transparent` reproduces `app.css:984` declaration for declaration; the
one-column track comes from `LINK_FORM_BASE`'s `grid-cols-1`, which the editor never overrides. Both
class names are retained as hooks — `CollectionPanel.dom.test.tsx` queries `.collection-link-form`
and `.collection-link-editor` directly.

**The editor's action row — `app.css:985`'s replacement:**

```tsx
<div className="collection-link-editor__actions flex flex-wrap gap-[var(--space-2)]">
  <button className={buttonClasses("primary", { className: "min-h-[44px]" })} disabled={savingEdit}>
    {savingEdit ? "Saving…" : "Save"}
  </button>
  <button type="button" className={buttonClasses("secondary", { className: "min-h-[44px]" })}
          disabled={savingEdit} onClick={onCancelEdit}>Cancel</button>
</div>
```

`flex-wrap` is added to the legacy `display: flex; gap` pair because both buttons now carry a 44px
target inside a tile that can be as narrow as 220px. The two `.button`/`.button--secondary` classes
leave these elements; `app.css:925-941` is untouched for its many other consumers (§7 row 21).

**The 640px transition is derived, not chosen.** The declared field minima plus the action and the
grid/padding sum to `220 + 180 + ~120 + 2×12 + 2×16 = 576px` of container. `.collection-content`
adds `2 × var(--space-6)` = 64px of padding, so three columns need a **640px viewport**. Both
regimes check out: below 1080 the rail is stacked, so container = viewport − 64 and 640 is exactly
the threshold; above 1080 the rail takes 288, leaving 1080 − 288 − 64 = 728 ≥ 576 at the narrowest
point where the rail exists. 640 also happens to equal `--container-sm` (`spacing.css:52`) — noted
as a coincidence, not a citation, since a media query cannot read a custom property.

**Labels — the complete replacement, layout included.** `app.css:980` is **not** a type-only rule: it
is `display: grid; gap: 6px; color; font: var(--type-eyebrow); font-size: 10px; letter-spacing;
text-transform`. The grid and the gap are what stack each label's caption above its input; a type-only
replacement would leave the `<span>` and the `<input>` as inline siblings on one line at every
viewport. Both halves are carried, in a shared constant so the add form and the inline editor cannot
drift apart:

```tsx
// CollectionPanel.tsx — module scope
const LINK_FORM_LABEL =
  "grid gap-[var(--space-1)] min-w-0 " +           // replaces app.css:980's `display:grid; gap:6px`
  "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] " +  // 10px → 11px, E-13
  "uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";
```

```tsx
<label className={LINK_FORM_LABEL}><span>Link URL</span><input className={RAIL_FIELD} … /></label>
<label className={LINK_FORM_LABEL}><span>Label <em className="not-italic text-foreground-secondary">optional</em></span>
  <input className={RAIL_FIELD} … /></label>
```

6px → `--space-1` (4px) is the on-grid step and matches `DEADLINE_LABEL` (§5.4), which replaces the
same construction in the Deadline editor; `min-w-0` is added so a long placeholder cannot push the
label's grid track past its column at the 220px minimum.

**The standalone "Add link" button — `CollectionPanel.tsx:160`.** This is the add form's own submit
control, and it is the last legacy `.button` on this surface. It gets a real replacement string, on
the same terms as every other primary action in this plan (§5.4, §5.9d's editor row):

```tsx
<button className={buttonClasses("primary", { className: "min-h-[44px] self-end" })} disabled={savingLink}>
  {savingLink ? "Adding…" : "Add link"}
</button>
```

`primary`, not `secondary`: it is the form's submit and the only action in the row, matching the
inline editor's `Save`. `self-end` replaces the alignment `app.css:979`'s `align-items: end` gave it
from the grid container — `LINK_FORM_BASE` keeps `items-end`, so `self-end` is a restatement that
survives the single-column regime below 640px where the button sits in its own row rather than beside
the fields. `min-h-[44px]` defeats the legacy 38px target (E-13) through `twMerge`, per §2.2 — no `!`,
because `app.css:925-941`'s `.button` rules no longer match once the class is dropped from the
element. **Dropping the `.button` class is required, not optional**: leaving it would keep an
unlayered `app.css` rule live beside the utilities, which §2.2 forbids outright. `app.css:925-941`
itself is untouched for its many other consumers (§7 row 21).

**Inputs — decided, not left to the builder.** The field treatment is defined **once**, as
`RAIL_FIELD`, exported from `lib/` (alongside `cn`), and imported by **both**
`ProjectDeadlineControl.tsx` and `CollectionPanel.tsx`. Its value is `DEADLINE_FIELD`'s exact string
from §5.4, unchanged; §5.4's `DEADLINE_FIELD` becomes that same import rather than a second literal.
One constant, two consumers — the alternative (duplicating the string with a cross-reference comment)
is exactly the two-owners-that-drift condition this release exists to remove, and there is no import
obstacle: `lib/utils.ts` is already imported by both files for `cn`. **`app.css:983`'s
`outline: none` is deleted** with the block and the global 2px ink `:focus-visible` ring returns
(E-12).

Errors keep `role="alert"` and become
`m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-[color:var(--signal-critical)]`.
Drafts remain visible after a rejected save, as currently asserted
(`CollectionPanel.dom.test.tsx:230-290`). The inline editor stays inside its tile and **must not
change the tile's `key`**.

#### e. Reorder grip and drag

```tsx
// module scope
const LINK_GRIP =
  "collection-link__grip grid place-items-center shrink-0 " +
  "min-w-[44px] min-h-[44px] " /* WCAG 2.5.5 Enhanced target, not a spacing token */ +
  "border-0 bg-transparent text-foreground-secondary cursor-grab [touch-action:none] " +
  "hover:text-foreground active:cursor-grabbing " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 " +
  "aria-disabled:cursor-default aria-disabled:opacity-[.5]";
```

```tsx
<button ref={setActivatorNodeRef} type="button" className={LINK_GRIP}
        aria-label={`Reorder ${title}`} {...dragProps}>
  <GripVertical aria-hidden="true" className="size-[var(--space-4)] stroke-[1.5]" />
</button>
```

`⠿` → Lucide `GripVertical` (E-15); the accessible label is byte-identical. **`useSortable`'s
`attributes`, `listeners`, `setNodeRef`, `setActivatorNodeRef`, the `transform`/`transition` inline
style, the `PointerSensor`'s 6px activation distance, the `KeyboardSensor`,
`sortableKeyboardCoordinates`, `closestCenter` and `rectSortingStrategy`
(`CollectionPanel.tsx:37,42,51,55`) are all untouched.** Growing the target from 34px to 44px changes
the activator's box, not its contract — which is exactly why §10.2 criterion 18 is release-blocking
(E-18: the DOM tests mock `DndContext` and cannot prove geometry).

Server-canonical reordering, the 409 reload path and the retryable toast
(`CollectionPanel.tsx:115-127`) are unchanged.

#### f. Content shell

`.collection-content` → `grid gap-[var(--space-5)] p-[var(--space-6)]`;
`.collection-links` → `grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-[var(--space-3)]`,
with the existing `collection-links--video` modifier still appended for the Video collection
(`CollectionPanel.tsx:53`) — it carries no paint of its own but is the structural hook `LINK_BODY`'s
arbitrary variant reads (§5.9c), and `CollectionPanel.dom.test.tsx` queries it;
`.collection-delivered` → `grid gap-[var(--space-3)]`, its `.ey` heading kept as-is (shared atom).
`.document-group` and every `.document-*` descendant keep their present CSS owner (§1.2).

---

## 6. Implementation shape

Touched files, bounded:

- `components/ProjectOverviewRail.tsx`
- `components/ProjectDeadlineControl.tsx`
- `components/ProjectTeamControl.tsx` — surrounding rail paint only; the `TeamPicker` popover body
  (`:69-100`) is not edited
- `components/CollectionPanel.tsx`
- `lib/` — one added export, `RAIL_FIELD` (§5.4), the shared field class string both the Deadline
  editor and the link forms import. No other change; `cn` and `buttonClasses` are untouched.
- `screens/ProjectWorkspace.tsx` — **only if** a hook is genuinely required; no change is currently
  foreseen
- `styles/app.css` — deletions and grouped-selector splits per §7, plus the **single** added rule in
  §7 row 2a (`.app--impersonating .rail { max-height: none }` inside the ≤1080 block). No other
  declaration is added to this file.
- `styles/tokens/typography.css` — the one comment line in §5.8
- the four DOM test files named in §9

**`components/atoms.tsx` is explicitly excluded.** `StatusBadge` is preserved as the shared atom and
receives no edit (§5.3).

No new runtime dependency. No `shadcn` generation. No `cva`. Reuses the installed and already-consumed
`Button`/`buttonClasses`, `lucide-react`, `AnchoredPopover` and `@dnd-kit`.

---

## 7. Legacy CSS retirement

### 7.0 The retirement gate — zero *unmigrated paint* consumers, not zero occurrences

TB8-01 §1.5's rule is "re-grep before deleting." Applied naively to this release it is **unsatisfiable
by construction**: this plan deliberately *keeps* class names like `.frow`, `.rail__edit`,
`.rail__sec` and `.project-team__remove` in the rendered DOM as non-styling hooks, so a grep for them
can never return zero — and demanding zero would force the builder either to strip hooks eight DOM
tests depend on, or to quietly declare the gate met while it isn't. Both outcomes are worse than the
defect the gate exists to catch.

**The gate is therefore restated, and this is the form the builder and Sol check.** For every
selector §7 marks **(a) retire**, the pre-deletion grep must return zero **unmigrated paint
consumers**, where a consumer is *unmigrated paint* unless it is one of:

- **(i) a kept rendering hook** — the class appears in a `className`/`cn(...)`/`buttonClasses(…,
  { className })` string on an element §5 gives a complete replacement string for. Its presence is
  *required*, and its absence is the defect.
- **(ii) a test-only reference** — the class appears solely inside `*.test.tsx` /
  `*.dom.test.tsx` as a `querySelector`, `querySelectorAll`, `classList` or `closest` argument.
- **(iii) the `app.css` rule being deleted itself.**

Any *other* hit — a `className` on an element outside this release's touched files, a rule elsewhere
in `app.css`, a reference in a `.css` file other than the one being edited — is an unmigrated paint
consumer, and the selector must be split (case (b)) rather than retired.

**The inventory below is the expected-hit list.** The grep is checkable because every hit is
pre-classified: a hit that does not appear here is a finding, and a class listed as *kept* that
returns **zero** hits is equally a finding (the hook was dropped).

| Class | Expected hits after the change | Class |
| --- | --- | --- |
| `.work` | 1 rendering (`ProjectWorkspace.tsx`) + `app.css` geometry (retained, not deleted) | kept-as-hook |
| `.rail` | 1 rendering + `app.css:41,231,836` geometry (retained) | kept-as-hook |
| `.rail__sec` | **7** renderings (`ProjectOverviewRail.tsx:88,94,102,107,113,118,128` — masthead, Production, Team, Client, Production notes, Collections, Dropbox). A substring grep also returns the six `.rail__section-label` lines; those belong to the row below, not here | kept-as-hook |
| `.rail__edit` | 1 rendering + `ProjectWorkspace.dom.test.tsx:1262` | kept-as-hook |
| `.rail__section-label` | renderings only | kept-as-hook |
| `.project-overview__header` / `__heading` | renderings only | kept-as-hook |
| `.project-team`, `__role`, `__member`, `__identity` | renderings + `ProjectTeamControl.dom.test.tsx` | kept-as-hook |
| `.project-team__add` | 1 rendering (inside `buttonClasses`' `className`, §5.5) | kept-as-hook |
| `.project-team__remove` | 1 rendering (inside `buttonClasses`' `className`) + **8** test queries (`ProjectTeamControl.dom.test.tsx:130,141,156,174,190,207,217`; `ProjectTeamControl.confirm.dom.test.tsx:52`) | kept-as-hook |
| `.stage-control`, `__message` | renderings only | kept-as-hook |
| `.dropcard` | 1 rendering (inside `buttonClasses`' `className`) + `ProjectWorkspace.dom.test.tsx:628,1263` | kept-as-hook |
| `.filterlist` | 1 rendering | kept-as-hook |
| `.frow` | 1 rendering + **11** test queries on 11 distinct lines (`ProjectWorkspace.dom.test.tsx:107,209,210,211,212,589,757,1222,1267,1271,1278` — `209-212` is a four-line range, not one hit) | kept-as-hook |
| `.rail-kv`, `.k`, `.vv` | renderings + `ProjectDeadlineControl.dom.test.tsx:62` (post-§9-edit) | **new** hook |
| `.project-deadline`, `__actions`, `__summary`, `__conflict-comparison`, `__inactive`, `__mandatory`, `__editor*`, `__custom-chip`, `__conflict` | renderings + existing `ProjectDeadlineControl.dom.test.tsx` queries | kept-as-hook |
| `.project-deadline__fieldset` | renderings only | **new** hook |
| `.collection-content`, `.collection-links`, `.collection-links--video`, `.collection-link`, `__name`, `__plain`, `__meta`, `__grip`, `.collection-link-form`, `.collection-link-editor`, `__actions`, `.collection-delivered` | renderings + `CollectionPanel.dom.test.tsx` / `ProjectWorkspace.dom.test.tsx` queries. `.collection-links--video` additionally appears **inside a Tailwind arbitrary variant** in `LINK_BODY` (§5.9c) — a *structural* hook, still not paint | kept-as-hook |
| `.project-deadline__zone` | **zero, everywhere** — the one class this release retires outright | **actually retired** |
| `.app.acc-olive .frow.is-active` | **zero** — removed from its grouped rule (§7 row 15) | **actually retired** |
| `.collection-link--dragging` | **zero** — replaced by the `isDragging &&` conditional utilities (§5.9c), no class emitted | **actually retired** |

Only three entries are true retirements; everything else is a rule deleted while its class name
survives as a hook, which is the intended shape of this release and not a gap in it. §11 item 3's
evidence table records, per selector, the command run, the raw hit list, and the classification of
each hit against (i)/(ii)/(iii) above.

Greps below were run 2026-09-02 and must be re-run at build time.

| # | Selector(s) | Case | Disposition |
| --- | --- | --- | --- |
| 1 | `.work` (`app.css:230`) | (a) | Grid geometry stays in `app.css` (it is layout, not paint, and `:834-836`'s responsive override depends on it). No paint to retire. Class retained. |
| 2 | `.rail` (`:231`) | mixed | **Geometry declarations stay** (`position`, `top`, `max-height`, `overflow`, `align-self`, `border-right`, `background`) — `app.css:41` and `:836` both override them, and reproducing that in utilities would fight unlayered CSS. **`padding` migrates** to utilities (`p-[var(--space-6)] max-[720px]:p-[var(--space-4)]`) — **written on the `<aside>`'s own class string in §5.1**, not implied by this row; delete only that declaration from `:231` **and** the whole `.rail { padding: var(--space-4) }` rule at `:865`, which exists only to override it. Class retained. |
| 2a | `.app--impersonating .rail` (`:41`) and the ≤1080 `.rail` reset (`:836`) | — | **`:41` untouched.** **Add** one rule — `.app--impersonating .rail { max-height: none; }` — inside the existing `@media (max-width: 1080px)` block, after `:836`. This is the plan's **only** `app.css` addition; every other row here deletes or splits. It fixes E-20's cascade defect at equal specificity and later source order, so no `!important` and no change to desktop impersonating geometry. |
| 3 | `.rail h2` (`:232`) | (a) | **Delete.** Sole consumer `ProjectOverviewRail.tsx:90` moves to utilities. |
| 4 | `.rail__sec`, `.rail__sec:first-of-type` (`:233-234`), `.rail__sec` ≤720 (`:868`) | (a) | **Delete all three.** Sole consumer is `ProjectOverviewRail.tsx`. Class retained as a hook. |
| 5 | `.rail__edit` (`:235`) | (a) | **Delete.** Class retained — `ProjectWorkspace.dom.test.tsx:1262`. |
| 6 | `.project-overview__heading` (`:236`), and `:866`'s ≤720 `display: block` | (a) | **Delete both.** Sole consumer `ProjectOverviewRail.tsx:87`; `hidden max-[720px]:block` replaces them. |
| 6a | `.project-overview__header { padding-top: 0 }` ≤720 (`:867`) | (a) | **Delete.** `pt-0` now applies at every viewport (§5.1), so this override has nothing left to do. Class retained as a hook. |
| 7 | `.rail__section-label` (`:237`) | (a) | **Delete.** Class retained as a hook. |
| 8 | `.project-team*` (`:238-249,251-253`), and `:869-870`'s ≤720 rules | (a) | **Delete.** Sole consumer `ProjectTeamControl.tsx`. Replacements are complete in §5.5 — including `.project-team` (`:238`) and `.project-team__role` (`:239`), whose `grid`/`gap` move onto their own elements. Class names retained as **non-styling hooks written into the element's class string**, not merely left in `app.css`: `.project-team`, `.project-team__role`, `.project-team__member`, `.project-team__identity`, and — inside the `buttonClasses(…)` `className`, per §5.5 — `.project-team__add` and `.project-team__remove` (eight direct `querySelector` calls across `ProjectTeamControl.dom.test.tsx` and `ProjectTeamControl.confirm.dom.test.tsx`). **`app.css:250` is grouped with `.project-collaboration-summary .member em` — split it: drop `.project-team__identity em` from the selector list and leave the Collaboration half intact.** |
| 9 | `.project-team-picker*` (`:256-274`), `:876`, `:883-884` | — | **Untouched.** TB8-02's owner. |
| 10 | `.kv`, `.kv .k`, `.kv .vv` (`:275-277`) | (b) | **Untouched.** Deferred consumers `ProjectWorkspace.tsx:332,488`. The in-scope elements move to `.rail-kv`. |
| 11 | `.project-deadline` (`:278`), `.project-deadline__actions` (`:282`), `__summary`/`__conflict-comparison` (`:283`), `__inactive`/`__mandatory` (`:284`), `__editor*` (`:285-293`), `__custom-chip` (`:294-295`), `__conflict` (`:296`) | (a) | **Delete.** Sole consumer `ProjectDeadlineControl.tsx`. §5.4 carries a complete replacement for every element in the range, including the three that are pure resets rather than paint: the `<fieldset>` reset (`:290`), the editor-head / input-row / custom-wrapper layout (`:286-287`) and the custom-chip remove button's border/padding/background/font reset (`:295`). **The conflict subtree is replaced element by element**, not just at its container: `.project-deadline__conflict-comparison`'s half of the grouped `:283` rule (`grid` + gap + type + colour), the conflict's unclassed action `<div>` (which had no rule at all), the conflict `<strong>` (moved to `--weight-regular`, E-5), and "Review and reapply my draft", which leaves legacy `.button--text` for `buttonClasses("text", …)` at 44px. Class names retained as hooks. |
| 12 | `.project-deadline__zone, .project-deadline__overdue` (`:279`) and `.project-deadline__overdue` (`:281`) | (b) | **Split.** `ProjectKanbanBoard.tsx:277` **and `:322`** both consume `__overdue` (the compact and expanded card renders). Remove `.project-deadline__zone` from `:279`'s selector list **only after** the rail's `<small>` drops the class and a fresh grep proves `__zone` has **zero occurrences repo-wide** — it is one of §7.0's three true retirements, so here the strict form of the gate does apply. `:281` stays whole. |
| 13 | `.stage-control`, `.stage-control select`, `.stage-control__message` (`:599-601`) | (a) | **Delete all three.** Sole consumer `ProjectOverviewRail.tsx`. **`.kcard-stage-control` (`:573`) is a different selector — do not touch it.** Class retained as a hook. |
| 14 | `.dropcard`, `.dropcard:hover`, `.dropcard.is-on`, `.dropcard svg:first-child` (`:656-659`) | (a) | **Delete all four.** Sole consumer `ProjectOverviewRail.tsx:130`; the last two are dead today (E-16). Class retained — `ProjectWorkspace.dom.test.tsx:628,1263`. |
| 15 | `.app.acc-olive .frow.is-active` (`:800`) | (a) | **Remove this selector from the grouped rule only.** The other grouped selectors (`.chip.is-active`, `.segment button.is-active`) and the rest of the dead `acc-olive` block stay for candidate #10. |
| 16 | `.filterlist` (`:300`), `.frow*` (`:301-305`), `.frow*` (`:955-958`) | (a) | **Delete all of both blocks** — this is E-10's duplicate-owner fix. Both class names retained as non-styling hooks; `.frow` is load-bearing for **11** test queries (§7.0). |
| 17 | `.workspace-intro*` (`:960-962`) | — | **Untouched** (§5.9a). |
| 18 | `.empty`, `.empty .serif` (`:793-794`) | — | **Untouched** (§5.9b). |
| 19 | `.member` (`:959`) | — | **Untouched.** Collaboration summary only. |
| 20 | `.collection-content` (`:965`), `.collection-links*` (`:966,970`), `.collection-link*` (`:967-978`), `.collection-link-form*` (`:979-983`), `.collection-link-editor*` (`:984-986`), `.collection-delivered` (`:987`) | (a) | **Delete.** Sole consumer `CollectionPanel.tsx`. **§5.9 carries a named replacement for every rule in the range**, including the four that are easy to miss because they are layout on an unclassed or modifier-selected element: `.collection-link > a` / `.collection-link__plain` (`:968-969` → `LINK_BODY`, §5.9c), the Video-only column direction (`:970` → `LINK_BODY`'s `[.collection-links--video_&]:` variant), the inline editor's one-column/reset override (`:984` → `LINK_FORM_BASE` + `p-0 border-0 bg-transparent`, §5.9d) and the editor action row (`:985`, §5.9d). Retain every class name queried by `CollectionPanel.dom.test.tsx` and `ProjectWorkspace.dom.test.tsx` (`.collection-link`, `.collection-links`, `.collection-links--video`, `.collection-link__name`, `.collection-link__meta`, `.collection-link__plain`, `.collection-link__grip`, `.collection-link-form`, `.collection-link-editor`, `.collection-link-editor__actions`); `.collection-links--video` is additionally load-bearing as the structural hook §5.9c's arbitrary variant reads. `app.css:983`'s `outline: none` dies with this block (E-12). |
| 21 | `.document-*` (`:988-1000`), `.wsbar` (`:373`), `.statetag*` (`:197-200`), `.chip*` (`:110-120`), `.ey`/`.muted`/`.serif`/`.row`/`.gap*` (`:20-26`), `.notice` (`:951`), `.button*` (`:925-941`), `.sdot` (`:133`), `.quincy-input*` (`:1040-1045`) | — | **Untouched.** Shared or deferred owners; the in-scope elements simply stop applying the classes where §5 says so. |

**Grep gates on the diff** (each a defect if it hits): `border-t-solid` / `border-b-solid` /
`border-l-solid` / `border-r-solid` / `border-x-solid` / `border-y-solid`; any raw Tailwind palette
utility (`bg-slate-*`, `text-gray-*`, …); any raw Quincy-ramp utility (`bg-paper-*`, `border-greige-*`,
`text-ink-*`); any bare numeric spacing/type/radius utility (`p-5`, `gap-3`, `text-sm`, `rounded-md`,
`min-h-11`); `dark:`; stock shadcn radius/shadow/scale animation; any **new** `outline-none` on an
interactive control; any `!` without an adjacent comment naming the surviving `app.css` rule it
beats; any selector deletion without §7.0-classified retirement evidence, and any class §7.0's
inventory lists as a kept hook that has disappeared from the rendered class string.

---

## 8. Behavioural invariants and risks

| Risk | Why it is real | Required guard |
| --- | --- | --- |
| Deadline draft lost on refresh or remount | The editor acquires query ownership on open and releases on close (`ProjectDeadlineControl.tsx:62-71`) and keeps a conflict reapply buffer (`:83-105,141-150`) | No new wrapper, conditional or `key`. Existing draft/conflict DOM tests plus §10.1 item 10. |
| Stage focus lost after a confirmed move | `ProjectWorkspace.tsx:404-409` restores focus by `data-focus-key` and reads `.disabled` on an `HTMLSelectElement` | The `<select>` stays a `<select>` (§5.3); same-task focus assertion after a settled move. |
| Team picker focus stolen | Deferred Escape restoration is a recorded live failure (`docs/lessons.md:904-929`) | No picker-engine edit; real-browser Escape / outside-pointerdown / second-popover check. |
| Active collection becomes forbidden | Denial removes the tab and purges the cached resource (`ProjectWorkspace.tsx:175,243-250`) | DOM tests for denied active and inactive collections and the existing safe fallback. |
| Link draft or an active drag destroyed by a background refresh | Add/edit drafts and post-drop state are local (`CollectionPanel.tsx:68-69,115-127`); live drag state is owned by the `DndContext`/sensors at `:51-55`. Refresh must preserve drafts, open controls, selection, scroll and active drag (`docs/Implementation-Plan.md:115-130`) | Dirty-draft refresh DOM tests; real-browser drag across a permitted invalidation. |
| dnd-kit passes happy-dom and fails a browser | Tests mock `DndContext` (`CollectionPanel.dom.test.tsx:19-41,134-138`) — geometry and sensors are unexercised (E-18) | §10.2 criterion 18 is release-blocking. |
| A 34px→44px activator changes the drag contract | The grip is `setActivatorNodeRef`; its box is the pointer target | Pointer **and** keyboard reorder on ≥3 links, both directions, plus a 409 recovery. |
| External Editor sees internal data or control | One shared server projection is mandatory for every reachable DTO (`docs/Implementation-Plan.md:248-275`) | Rerun the shared-projection regression; confirm the diff adds or touches **no** DTO — this plan does neither, so the conditional mandate at `:265-275` is satisfied by inspection plus the rerun as defence in depth. |
| Touch-target growth distorts a 288px rail | Current desktop actions are 30/34/38px (`app.css:242,974,982`) | Measure actual boxes at all three viewports; compact inner paint inside a 44px box where needed. |
| A CSS deletion silently unstyles another surface | `.frow` is a load-bearing test hook; `.kv`, `.project-deadline__overdue`, `.workspace-intro`, `.empty`, `.statetag`, `.chip` and `app.css:250` all have deferred consumers | Apply §2.2 and §7 exactly; record the `rg`/`grep` command and result for every deletion. |
| Lightbox regression from wrapper edits | Tab switch closes the Lightbox; round-trip assertions are existing release gates | `ProjectWorkspace.dom.test.tsx`'s Lightbox close-on-tab-switch coverage stays green. |
| TB0 evidence overclaims media convergence | `TB0-VIS-02` has no truthful populated local media evidence (`Drift-Register.md:61`) | Mark media N/A; test non-media collection data only; fabricate nothing. |

---

## 9. Required test edits — exact

These are consequences of correct work, not a licence to loosen assertions. Nothing below reduces
coverage.

1. **`components/CollectionPanel.dom.test.tsx:219`** — the exact-`className` assertion (E-19) blocks
   any utility on `.collection-link__name`. Replace it with an identity-and-order assertion that
   tolerates additional classes:

   ```ts
   const [name, chip] = [...contentParent.children];
   expect(contentParent.children).toHaveLength(2);
   expect(name!.classList.contains("collection-link__name")).toBe(true);
   expect(chip!.classList.contains("chip")).toBe(true);
   ```

2. **`components/ProjectDeadlineControl.dom.test.tsx:62`** — `querySelectorAll(".kv")` becomes
   `querySelectorAll(".rail-kv")`, same expected length of 2.

3. **`components/ProjectDeadlineControl.dom.test.tsx:65`** — `querySelectorAll("button")` must still
   be `0` in the read-only Delivered state. **No control may be added to the Deadline read-only
   render.** Left unchanged; called out so the builder does not break it.

4. **`components/ProjectOverviewRail.dom.test.tsx`** — the three existing Stage cases stay green
   unchanged (§5.3 preserves the element and every attribute they read). **Add**: a
   labelled-region assertion for the rail, and a collection-switcher state assertion (§10.1 item 8).

5. **`screens/ProjectWorkspace.dom.test.tsx:1267,1271,1278`** — unchanged; §5.6 keeps the label span
   first so `textContent.startsWith(...)` still matches.

---

## 10. Acceptance criteria

### 10.1 Automated, DOM and repository — required

1. `npm run typecheck` and `npm run build -w @quincy/web` pass from `portal/`.
2. `npm run test --workspaces` **and** `npx vitest run --config packages/shared/vitest.config.ts`
   pass.
3. `ProjectOverviewRail.dom.test.tsx` preserves the Stage option set, capability gating, disabled
   reason and focus identity (`:55-87`).
4. `ProjectDeadlineControl.dom.test.tsx` passes unchanged for query ownership, dirty draft,
   conflict/reload/reapply, DST fold, inactive/resume, clear confirmation and focus (`:59-186`),
   with the §9 item 2 selector edit. **Add** an assertion that no class or style on the editor's
   inputs and actions suppresses the global focus ring.
5. `ProjectTeamControl*.dom.test.tsx` passes all role-specific add/remove, membership-cycle,
   confirmation, pending, conflict, inactive and picker-keyboard cases. **Add** a same-task Escape
   focus assertion if absent — **no timer may be advanced to make it pass**
   (`docs/lessons.md:918-923`).
6. `ProjectWorkspace.dom.test.tsx` retains selection reset, loading, denial, refresh preservation,
   Lightbox close-on-tab-switch, initial Edited selection and External Editor collection permissions.
7. `CollectionPanel.dom.test.tsx` keeps real anchors and permission/provenance behaviour
   (`:150-228`), draft retention and errors (`:230-290`), successful and duplicate adds
   (`:292-375`), canonical reorder and conflict behaviour (`:377-440`) and version-specific deletion
   (`:442-455`), with the §9 item 1 edit.
8. **New — collection-switcher semantics.** Only available tabs render; when at least one is
   available, **exactly one** has `aria-pressed="true"` and **every other rendered tab** has
   `aria-pressed="false"`; a denied current collection selects the existing fallback; a denied
   inactive tab disappears; a project change resets to RAW without leaking prior state. Assert
   current transitions only — focus relocation after removal is deferred and must not be added.
9. **New — visual-contract assertions where robust:** every Lucide icon carries `aria-hidden`; the
   grip keeps its `aria-label`; the sync button's accessible name is exactly `Sync from Dropbox`;
   no nested interactive element; `role="alert"` / `role="status"` are preserved; disabled and
   pending controls remain non-activatable. **Do not snapshot Tailwind class strings.**
10. **New — refresh regression on existing ownership paths:** a dirty Deadline draft, a dirty link
    add form and an inline link edit draft each survive their currently-permitted background
    invalidation, while a project-id change intentionally clears project-scoped state. **Do not add
    or infer a `CollectionPanel` loading state from `assetsPending` to make this pass.**
11. Rerun the shared External Editor projection regression; confirm the diff adds or touches no DTO.
12. **Grep gates** — the full list in §7's closing paragraph, each hit a defect.
13. Built CSS still omits `tailwindcss/preflight.css`; record built-CSS size before and after. No new
    runtime dependency; no second Tailwind setup; no `cva`.
14. **Selector-retirement gate, in §7.0's form.** For every selector §7 marks (a), a recorded
    repo-wide search returning **zero unmigrated-paint consumers** — *not* zero occurrences, which
    §7.0 explains is unsatisfiable here because this release intentionally keeps most of these class
    names as rendering and test hooks. Each raw hit is classified against §7.0's (i) kept rendering
    hook / (ii) test-only reference / (iii) the rule being deleted. Two failure modes, both defects:
    a hit that fits none of the three, **and** a class §7.0's inventory lists as *kept* that returns
    zero hits (the hook was silently dropped — this is what would break the eight
    `.project-team__remove` and **11** `.frow` test queries). Exactly three entries —
    `.project-deadline__zone`, `.app.acc-olive .frow.is-active` and `.collection-link--dragging` —
    must return zero occurrences outright; all three are verified so today.

### 10.2 Real-browser only — release-blocking, not replaceable by happy-dom

15. **Matched visual pass** at 1440×900, 1024×768 and 390×844, same project, role and data state
    before and after. Capture: masthead (short and long address); every rail section; Production
    notes present and absent; Team populated / inactive / empty / error / pending; Deadline unset /
    set / overdue / inactive / resume / open / conflict; collections active, empty and denied;
    Dropbox ready / syncing / blocked / hidden; Video empty / populated / add / edit / error;
    Floorplan and Copy delivered-link shell. Confirm **no horizontal overflow, no clipped focus ring,
    no hidden action**. Agy is the repository's default Chrome tester
    (`docs/Subagent-Orchestration.md` §2.8-§2.10).
16. **Impersonating state at all three viewports — 1440×900, 1024×768 *and* 390×844** — with five
    collection rows, a populated Team, a set Deadline and Dropbox visible (E-20). Three distinct
    checks, one per regime:
    - **1440×900 (>1080, sticky regime).** `app.css:41`'s `top: 106px` /
      `max-height: calc(100vh - 106px)` still holds, the rail still sticks below the impersonation
      banner and topbar, and every rail control remains reachable by scrolling the rail.
    - **1024×768 (≤1080, in-flow regime).** With the §7 row 2a rule applied the rail must have
      **`max-height: none` in DevTools' computed style** and **no scrollbar of its own** — it grows
      to content and scrolls with the page, exactly as the non-impersonating 1024 state does.
      Verify by computed style, not by eye. Capture the same state **before** the fix as the matched
      "before" evidence, since this is a behaviour change, not a paint change.
    - **390×844 (≤1080, in-flow regime, mobile URL bar).** Same computed-style check, plus: scroll
      the page far enough to collapse and re-expand the browser's URL bar and confirm the rail
      neither traps scroll nor leaves content behind a nested scrollbar, and that the last rail
      control (Dropbox) is reachable by ordinary page scrolling.

    Both the non-impersonating and impersonating variants of the 1024 and 390 states are required,
    so the fix is proven to change only the impersonating one.
17. **Keyboard pass — every control this release changes the focus treatment of, not a sample.**
    Traverse the surface **in source order** and confirm each control below shows a visible, complete,
    unclipped 2px ink `:focus-visible` indicator at all three viewports. Focus-ring visibility and
    clipping cannot be proven by happy-dom — a `:focus-visible` outline that is painted but sheared by
    an ancestor's `overflow: auto`, or defeated by a surviving unlayered rule, passes every DOM
    assertion — which is why the list is exhaustive rather than representative:
    - **Rail:** Stage `<select>`, "Edit details", the Dropbox sync button.
    - **Deadline:** Date and Time inputs, every preset checkbox and fold radio **label row**, the
      custom-minutes number input, "Add", the custom-chip `×` remove button, "Edit/Set Deadline",
      "Resume reminders", "Save Deadline", "Clear", the editor head's "Cancel", and — in the conflict
      state — "Reload latest" and "Review and reapply my draft".
    - **Team:** the picker trigger, every "Remove" button, the message row's inline "Retry".
    - **Collections:** every collection tab.
    - **Video links:** the add form's URL and Label inputs and its "Add link" submit; the inline
      editor's two inputs, "Save" and "Cancel"; each tile's reorder grip, "Edit" and "Remove"; and
      **the tile's own `<a href>` link anchor**.

    The Video add/edit inputs and the link anchors are called out because they are the specific
    controls where a *restored* ring is the fix, not a preserved one: `app.css:983`'s
    `input:focus { outline: none }` currently kills the ring on all four inputs (E-12), and the
    anchors have never been checked for ring clipping inside a 128px tile. A missing or clipped ring
    on any listed control is a release-blocking defect, not a note.

    Also in this pass: Escape from the team picker restores focus to its trigger **synchronously**;
    an outside `pointerdown` dismisses with no stale focus steal.
18. **Video-link drag — pointer *and* keyboard, mandatory.** On a collection with ≥3 links, reorder
    first→last and last→middle by pointer, then by keyboard. Verify activation at the unchanged 6px
    threshold, focus, the accessible announcement, no white screen, no page-scroll fight, no draft
    loss, and server-canonical order after reload. Trigger a 409 and confirm canonical reload plus a
    retryable toast. A mocked `DndContext` is insufficient (E-18).
19. **Draft and drag survive a refresh.** With a link edit draft dirty, exercise the normal
    invalidation path and verify the draft and active collection persist. Start a drag, let a
    permitted background refresh occur, and confirm dnd-kit's active drag is neither cancelled nor
    visually remounted.
20. **Touch pass at 390×844.** Measured boxes ≥44×44 for team add/remove, Deadline fields, actions,
    checkbox/radio label rows and the custom-chip remove, collection tabs, the link grip, form fields
    and actions, and Dropbox. Native date/time pickers open and commit. No horizontal scrolling.
21. **Collection transition and access pass.** RAW → Video → Floorplan → Copy and back; active state
    and count stay correct; a denied collection is removed and follows the existing fallback; a tab
    switch closes the Lightbox as before; browser Back and deep project navigation leak no prior
    tab or draft. Observe the current transient Video-empty behaviour during link fetch and record it
    as a **deferred baseline**, not an acceptance state.
22. **Stage and Deadline behaviour.** Exercise a confirmation-requiring Stage move and verify focus
    returns to the Stage select; open a dirty Deadline editor through a background refresh; exercise
    conflict → reload latest → review/reapply; verify no duplicate save or reminder mutation.
23. **External Editor role, via Admin impersonation** (`docs/Admin-Impersonation.md`). Assigned-safe
    rail facts and approved collections only; no Dropbox, internal notes, client contacts, unrelated
    project, Admin or AutoHDR control appears. Membership loss closes and purges the project UI
    rather than leaving cached rail or collection content.
24. **Typography check.** Production notes render in **Athelas**, not the Charter/Georgia fallback —
    verify the loaded family in DevTools' computed style, not by eye (§4.2, E-17). If the face fails
    to load, that is a `styles/fonts.css` asset-path defect to fix, not a reason to change the
    decision.
25. **`prefers-reduced-motion: reduce`.** No rail or collection transition impedes a state change or
    focus. Hover is never the sole state cue; every status signal keeps readable contrast. Agy
    attempts this first; if its Chrome cannot emulate the query, the orchestrating session retries in
    its signed-in Browser pane. If neither can, record the limitation in TB8-03 evidence and obtain an
    explicit written owner waiver before deploy — absent that waiver this item remains **failed**.

Items 15-25 are release-blocking even when every DOM test passes. Drag geometry, native date/time
controls, focus timing, pointer dismissal, measured hit targets, sticky overflow, font loading and
responsive wrapping cannot be proven by happy-dom.

---

## 11. Evidence deliverables

In `docs/plans/revamp_2026_portal/evidence/TB8-03/`:

1. `drift-register.md` — E-1 … E-20 with dispositions and exact changed-file references, in the
   TB8-02 table shape.
2. Matched before/after captures at all three fixed viewports, named by state and role, including the
   impersonating state at **each** of the three (criterion 16), each paired with its
   non-impersonating twin.
3. A selector-retirement table in **§7.0's form**: for every deletion and grouped-selector split in
   §7, the actual search command, its raw hit list, and each hit classified as (i) kept rendering
   hook / (ii) test-only reference / (iii) the deleted rule itself. It must also show the three true
   retirements (`.project-deadline__zone`, `.app.acc-olive .frow.is-active`,
   `.collection-link--dragging`) returning zero occurrences, and every class §7.0 lists as kept
   returning at least its expected rendering hit.
4. Automated command output summary, plus built-CSS size, Preflight and dependency checks.
5. The real-browser checklist for criteria 15-25, with the drag, External Editor, Athelas and
   reduced-motion lines explicit.
6. Any unresolved difference classified as intentional evolution or deferral, with owner disposition.

Do not store captures containing real client-sensitive content in the repository. Use sanctioned
local QA data; record the evidence location and description without fabricating media.

---

## 12. Open questions for the owner

Only one decision in this plan is a matter of taste rather than of evidence, and it is stated so it
can be accepted or overruled as a single item.

| # | Question | The plan's recommendation |
| --- | --- | --- |
| **Q1** | **Should Production notes be set in Athelas** (§4.2, §5.8), extending the brand's fourth type voice to a second surface? | **Yes — and this is the default: silence is assent, so implementation proceeds with Athelas unless the owner explicitly overrules it.** §4.2 states it as a committed decision and §5.8 gives the final class string; the question exists to make the one taste call overrulable, not to block the build. The face ships, is loaded, is tokenized, the readme names this exact role for it, **and the app already renders it** on the Calendar schedule editor's intro paragraph — the same running-prose role, shipped in TB5C (`production-calendar.css:175`, E-17). So this is a consistent second use, not a first activation. It is one paragraph, on one surface, and it is the single thing that makes the rail look designed rather than assembled. Overruling it means one line changes to `--font-sans`; nothing else in the plan depends on it. |

**Q1 resolved 2026-09-02 — owner explicitly confirmed Athelas activation** (not by silent default;
asked directly). §4.2/§5.8 proceed as written.

Everything else is settled: **E-1 … E-17 and E-20 are documented drift, accessibility, cascade or
duplicate-owner defects with token-derived fixes; E-18 and E-19 are test-coverage rows.** No new token, no
new dependency and no capability change is proposed, so no further owner sign-off is required to
implement §5 as written. Review may tighten implementation detail but must not broaden this release
into the candidates deferred in §1.2.

---

## 13. Completion boundary

TB8-03 is complete when:

- the rail and the reached collection-link controls have **one** current styling owner;
- E-1 … E-20 each carry an evidence-backed disposition, with none left unassessed;
- every selector in §7 is retired, split or preserved exactly as stated, each backed by a recorded
  §7.0-classified retirement search — zero *unmigrated-paint* consumers, with every kept hook still
  present in the rendered DOM;
- §10.1's automated gates and §10.2's real-browser gates all pass, or carry a written owner waiver;
- and the deployed surface matches the fixed evidence without any change to functional ownership.

The plan stays in `docs/plans/` until its change is built, verified, committed **and** deployed to
production; only then is its status line updated with the commit hash and the file moved to
`docs/plans/implemented/` (`CLAUDE.md` § "Approved revamp targets", plan-lifecycle rule).
