# TB8-04 — Project and Admin Forms: Visual Plan

**Status: DEPLOYED TO PRODUCTION — 2026-09-03.** Built, verified, merged to `main` as `a371671`
(implementation commit `9f1a5e3`), and deployed to <https://quincy.flamingfire.my> as app Worker
version `c620c514-fc3c-4c44-a463-214a734cb15e`. **App Worker only — no migration, no
background/webhook-ingress change.** Rollback target: app Worker
`9a021a5e-956b-43b4-a17c-ed05dc7be1af`.

Release gate: `npm run typecheck` green, `npm run build -w @quincy/web` green, 1569 tests passing
across the workspaces plus 144 in `packages/shared`, 0 failures. §10.2's sixteen real-browser
acceptance items were checked at 1440×900, 1024×768 and 390×844 — items 1, 2, 4, 6, 7, 8, 9, 13,
14, 15 and 16 PASS outright; **items 3 and 5 are verified structurally but not audibly** (the
stacked table reapplies every role it loses to `display: block`, and `FieldError` renders
`role="alert"` with `aria-invalid`/`aria-describedby` correctly wired, but confirming what a screen
reader actually announces needs assistive technology this session cannot drive — recorded as a
known limit on the TB5C precedent, not as a pass). Post-deploy passive verification on production:
38 requests, all 200/304, zero failures, zero app console errors.

Two defects were found and fixed during the gate rather than shipped: `FIELD_BOX`'s bare
`read-only:` variants painted **every** `<select>` as a read-only field (a `<select>` matches
`:read-only` unconditionally), and the `max-[720px]`/`min-[720px]` pairing left exactly 720px
matching neither branch. Both are written up in `docs/lessons.md`.

Out of scope and **not** fixed here — three pre-existing app-shell (TB8-01) defects confirmed
byte-identical at `HEAD`: the impersonation banner's Exit button goes Ink-on-Ink (1:1 contrast,
invisible) on hover, because `.button--text:hover:not(:disabled)` at specificity (0,3,0) beats the
scoped `.impersonation-banner .button--text` at (0,2,0); `.topbar__user` overflows horizontally in
the 721–747px band; and `.topbar__brand` is a 32px touch target below 721px.

Review history: **Sol round 1** (22 findings) and **Sol round 2** (8 build-blocking, 7 consistency)
are both closed — every finding was verified against source by this session rather than accepted on
report, and two were closed *against* Sol's framing where the evidence went the other way (round 2
finding 5: `ProjectFields.dom.test.tsx:54-62` queries `.ey`, `.create-project__checklist` and
`label.create-project__check` and never the two wrapper classes, so §5.14's prose was wrong and §7
rows 110/118 stay **D**; round 1 consistency 5: `--font-sans` is Apfel Grotezk, which ships one
`@font-face` at weight 400, so the sweep resolved to `--weight-regular`, not `--weight-bold`).
Round 2 was the final round by the pipeline's ≤2-round rule and Sol's own closing instruction was to
rewrite without further Sol review and self-approve here. One defect Sol did not catch was found and
fixed in the same pass: `E-41` duplicated `E-20`, and is now withdrawn in place (§3.1 preamble).

Verified at approval, by script against this document rather than from its prose: 42 evidence IDs
`E-1`…`E-42` with no gaps and no dangling references; 159 disposition rows tallying exactly
{D 120, R 15, S 12, K 11, O 1} at approval — {D 119, R 15, S 13, K 11, O 1} after slice-2 review
reclassified row 117 — numbered 1–151 with no gaps plus lettered 21a–21h; every one of the
sixteen components §5 names carries a full `function X(` definition. The §10.1-D gate block was
**executed** under `bash` against the pre-build tree — D1/D2/D3/D5/D5b silent, D4 and D4b each
reporting exactly `Admin.tsx:480` (E-42's known violation) — and each gate was additionally proved
*able to fail* against a throwaway probe carrying the exact violation it exists to catch, because
round 1 shipped two gates that could not.

The four owner questions in §12 were answered
2026-09-02 and are recorded there as a decision record; §12 is closed. One of them (Q4) put
`docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md` into this release's diff — see §1.1,
§1.4, §10.1-H, §11 artefact 21 and §13. Nothing in this plan is open to the builder.

Ranking candidate #4 of `docs/plans/Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md` ("remaining
project/admin forms"), widened by owner decision to absorb the operator-queue surfaces that ranking
candidate #5 called "Admin delivery UI". Fourth in the TB8 series after
[TB8-01 Dashboard Shell](implemented/TB8-01-Dashboard-Shell-Visual-Plan.md),
[TB8-02 Menus, Dialogs and Popovers](implemented/TB8-02-Menus-Dialogs-Popovers-Visual-Plan.md) and
[TB8-03 Project Workspace Rail](implemented/TB8-03-Project-Workspace-Rail-Visual-Plan.md), and the
fifth bounded Tailwind consumer overall (TB1 was the first).

Written under the Claude design lane in `docs/Subagent-Frontend-Orchestration.md`: Opus drafts at
implementation-detail resolution, Sol reviews scope and correctness only, a Sonnet subagent builds.
**This plan closes every design decision itself.** Where a class string appears below, the builder
applies it; it does not invent one. The four questions that were owner rather than builder decisions
are in §12, and all four are now answered.

## Styling-owner authority

The owner decision recorded in `Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md` §"Decision:
Tailwind adoption scope for TB8 (2026-09-01)" extends Tailwind v4 + shadcn (`base-sera`,
`cssVariables: true`, Lucide, Preflight disabled, no dark mode) surface-by-surface, using the
foundation already wired in `portal/apps/web/components.json` and `src/styles/index.css` — never a
new or parallel setup. TB8-04 claims **one more bounded surface**: the five files in §1.1. On that
surface Tailwind becomes the single styling owner and the legacy `app.css` rules that painted it are
disposed of per §7. Everything outside §1.1 keeps `app.css` as its owner, untouched.

## Authority boundary

This plan may change paint, geometry, markup structure and class ownership. It may **not** change
what the app does. Every capability gate, role check, mutation path, ARIA role, live-region
politeness, focus-return behaviour and network call in the five in-scope files survives byte-for-byte
in behaviour. Where a redesign forces a DOM-structure change adjacent to a capability gate, §8 names
it explicitly so the builder and Sol can check it. Per D-18 this plan has no authority to change
product semantics, the data contract, or capability definitions; §12 carries the four questions that
belonged to the owner rather than to me, with the answers given 2026-09-02.

---

## 1. Scope

### 1.1 In scope

| # | Surface | Source | What it paints today |
|---|---|---|---|
| 1 | Sign-in screen | `apps/web/src/screens/SignIn.tsx` (36 lines) | `.signin`, `.signin__panel`, `__wordmark`, `__title`, `__copy`, `__action`, `__note`, `.button`, `.button__google`, `.ey`, `.notice` |
| 2 | New shoot (create) | `apps/web/src/screens/CreateProject.tsx` (62 lines) | `.page`, `.create-project`, `__form`, `__hero`, `__hero-action`, `__address`, `__hero-error`, `__refinements`, `__details`, `__detail-content`, `__actions`, `.admin-field`, `.notice`, `.sr-only` |
| 3 | Edit shoot | `apps/web/src/screens/EditProject.tsx` (124 lines) | everything in row 2 plus `.create-project__section`, `__section-head`, `__fields`, `__fields--property`, `.edit-project__archived`, `.danger-zone` and its five descendants, `.empty` |
| 4 | Shared project fields | `apps/web/src/components/ProjectFields.tsx` (129 lines) | `.create-project__section`, `__section-head`, `__fields`, `__fields--two`, `__checks`, `__check`, `__checklist`, `__team`, `__team-state`, `.project-fields__section--readonly`, `__readonly-note`, `.admin-field`, `textarea`, `.notice`, `.ey`, `.serif` — **and TB1's already-migrated Client section at lines 90–98** |
| 5 | Administration — the entire screen | `apps/web/src/screens/Admin.tsx` (487 lines) | Users tab, Directory tab, Pipeline tab, Integrations cards, and all three operator queues (Tonomo failed events, rendition DLQ, notification delivery with its filter tab strip): `.admin-page`, `.admin-tabs`, `.ctab`, `.admin-section__head`, `.admin-provision`, `.admin-field`, `.admin-table-wrap`, `.admin-table`, `.admin-table__action`, `.admin-table__empty`, `.admin-role-select`, `.admin-inline-input`, `.admin-status--*`, `.integration-grid`, `.integration-card`, `.integration-meta`, `.admin-notice`, `.admin-directory-form`, `.admin-agent-form`, `.admin-subsection`, `.admin-stage-list`, `.admin-stage`, `.admin-stage__order`, `.admin-toggle`, `.admin-poison`, `.admin-warning`, `.empty`, `.notice`, `.ey`, `.serif`, `.sr-only` |

Per the pipeline's **"full UI rescue, not just the named control"** rule, the unit of work is the
whole visual surface each of those five files paints — page frame, heads, sections, tables, cards,
empty and error states, status pills, toggles, disclosure and the two tab strips — not only their
input controls.

**Five** shared primitives are also in scope because the surface consumes them and they carry
defects this release is the first to hit at volume: `components/ui/input.tsx`,
`components/ui/field.tsx`, `components/ui/eyebrow.tsx`, `components/ui/select.tsx` and
`components/ui/button.tsx`. Each gets a bounded, enumerated edit in §5.1 and §6.1 — not a redesign.
*(Corrected from "four" and a four-item list, 2026-09-02, Sol round 2 consistency 2: `button.tsx`
was always in §5.1's body and §6.1's table — one `max-[720px]:min-h-[44px]` inserted into `BASE` —
and only this sentence omitted it.)*

**One non-`portal/` file is also in scope, by owner decision (§12 Q4):**
`docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md` — a single appended `TB0-VIS-04` row,
drafted verbatim in §1.4. It is the only documentation edit in this diff and the only file outside
`portal/apps/web/` the release touches. It appends a row and bumps that file's own row count from
21 to 22 (§1.4); it rewrites no existing register row.

### 1.2 Deferred — and where the boundary falls

| Deferred | Boundary | Owner |
|---|---|---|
| `screens/NotificationPreferences.tsx` | It consumes `.page`, `.ey`, `.serif`, `.admin-toggle`, `.notice`, `.sr-only` and its own `.preferences-*` family. TB8-04 leaves every one of those rules standing (§7 case (b)), so this screen renders byte-identically after the release. | Candidate #5 |
| The notification bell and every notification surface outside `Admin.tsx` | `Topbar.tsx`'s bell, its popover, and the in-app inbox. TB8-04 touches only the **Admin-side operator view** of the notification outbox — the delivery queue table and its filter strip inside `Admin.tsx`. | Candidate #5 |
| Toasts — `.toasts`, `.toast`, `.toast--error` (app.css:723–726, :933) | `Admin.tsx:484` renders one of three toast hosts app-wide (`ProjectWorkspace.tsx`, `Dashboard.tsx` are the others, and `ProjectWorkspace.dom.test.tsx` queries `.toasts`). Migrating one host would leave two painted by a rule TB8-04 would then have to keep anyway. TB8-01 §10.5 already specified the target (`--shadow-md`, not the current `--shadow-lg`) and deferred it. TB8-04 keeps the markup and the classes exactly as they are. | Candidate #1 follow-on |
| `.page`, `.pagehead`, `.toolbar` (app.css:138–141) | Shared page scaffolding with consumers in `ProjectWorkspace.tsx` (×3), `Dashboard.tsx`, `NotificationPreferences.tsx`, and a cross-scope test that asserts DOM adjacency (`ProjectCollaborationPanel.dom.test.tsx:1020`, E-28). **What is deferred is deleting the rules, not carrying the classes.** The three rules survive this release untouched, for those out-of-scope consumers. On in-scope screens: `.page` **keeps** its class, because §5.4 overrides only its `max-width` with a narrow `!` utility (§7 rows 5, case **O**); `.pagehead` and `.pagehead h1` **lose** their classes, because the in-scope heading is rewritten wholesale as §5.4's `PAGE_HEAD` `<header>` and a surviving unlayered rule beside competing utilities is the forbidden sixth case (§7 rows 6-7, case **S**). The adjacency assertion keeps working through `header +` (§9.4). | Candidate #10 |
| `.empty` / `.empty .serif` (app.css:739–740) and `.empty--raw p` (:606) | 21 consumers outside §1.1 plus `ProjectWorkspace.dom.test.tsx:170`. TB8-04 introduces the replacement component and adopts it **only** on its own 10 sites (§7 case (b)); the rule stays for everyone else. *(Counts corrected 2026-09-02 to match E-22's recount — they read 19 / 9.)* | Candidate #10 |
| `.button`, `.button--secondary`, `.button--danger`, `.button--text`, `:hover`, `:disabled` (app.css:865–880) | 65 files outside §1.1 consume them. Identical treatment to TB8-01/02/03: in-scope elements switch to `buttonClasses()`; the rules stay. | Candidate #10 |
| `.ey`, `.serif`, `.muted` (app.css:20–22) | App-wide type hooks. In-scope elements stop using them; the rules stay. `.muted` has zero in-scope consumers. | Candidate #10 |
| The duplicate `.sr-only` (app.css:937 **and** :1046) | Byte-identical duplicates, one dead. TB8-02 §11.2 already assigned the deletion to candidate #10. TB8-04 records it (E-26) and deletes neither. | Candidate #10 |
| `.grow` (app.css:28) | The one surviving `app.css`-vs-Tailwind name collision. **Zero consumers in §1.1** (E-25), so it cannot bite this surface. TB8-03 deliberately left it; so does TB8-04. | Candidate #10 |
| `tokens/fonts.css` (a whole stylesheet imported by nothing) | TB8-02 §11.2 recorded and deferred it. Unchanged here. | Candidate #10 |
| `.ctabs`, `.cbar`, `.optcard`, `.ctab--premium` | Already dead before TB8-04 (E-21). `.ctab` itself **is** retired here because TB8-04 removes its only two consumers; its siblings were dead independently and are not this surface's to sweep. | Candidate #10 |

### 1.3 What "no drift-register entry" means here, and what replaces it

The roadmap rule in
`docs/plans/revamp_2026_portal/roadmap/TB8-Wider-UI-Migration-And-Cleanup.md` is "start from
drift-register entries." **For this surface there is no entry to start from.**
`docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md` holds 21 rows, none `Unassessed`, and
its only visual rows are:

- `TB0-VIS-01` — Dashboard shell (consumed by TB8-01),
- `TB0-VIS-02` — Project Workspace, media grids, lightbox, compare (partly consumed by TB8-03),
- `TB0-VIS-03` — Collaboration and Notice Board.

Nothing covers forms, `CreateProject`/`EditProject`/`ProjectFields`, `SignIn`, or the Admin screen.
TB0's visual baseline simply never captured them.

**The convergence rationale used instead**, in the roadmap's own selection-order terms:

1. **Ability to retire a legacy owner** — the strongest reason this release exists. 54 `app.css`
   selectors (§7) have *all* of their consumers inside §1.1. `.ctab`, `.create-project__*`,
   `.admin-*`, `.signin*`, `.danger-zone*`, `.edit-project__*`, `.project-fields__*` and
   `.quincy-input*` are retirable outright — roughly a fifth of `app.css` by rule count. No other
   remaining candidate retires that much.
2. **Accessibility risk** — the highest of any remaining candidate, and this is the release-blocking
   criterion. Six validation errors on this surface are announced to nobody (E-5); two tab strips are
   non-conformant (E-10); no `<th>` carries `scope` (E-9); three focus rings are actively suppressed
   (E-11) and a fourth is off-system (E-12); five inline editors have no accessible name at all
   (E-34); ten text roles fail 4.5:1 (E-16, E-17); and row selection is signalled by a 6% colour
   wash and nothing else (E-18).
3. **Unwanted-drift severity** — one live rendering defect (E-6: an undefined custom property), one
   raw non-brand typeface (E-14), two faux-bold sites (E-13), seventeen off-scale type values (E-15)
   and eight inline `style` literals (E-20).
4. **Reuse value** — the surface needs a table, a tab strip, a status pill, a textarea and a
   select-field. Those are the last five gaps in this repo's component vocabulary; candidates #5, #6
   and #8 all need them and none can be built without them.
5. **Operational pain** — the Admin screen is where the studio owner recovers failed deliveries.
   At 390px every one of its tables is a horizontal scroll of an 820px minimum inside a 294px box
   (E-8), and the responsive treatment its markup was written for was never implemented (E-7).

That is the enumerated evidence register in §3.1, `TB8-04-E-1` … `TB8-04-E-42`, and it is what this
plan converges against in place of a drift-register row.

**Owner decision (§12 Q4): the `TB0-VIS-04` row ships in this diff**, not as a follow-up. The plan's
original recommendation was to keep a baseline document out of a styling release; the owner chose to
close the gap now so the register stops under-describing the app. §1.4 drafts the row verbatim.

### 1.4 The `TB0-VIS-04` row — exact content to append

Append as a new final row of the drift-register table in
`docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md`, immediately after the `TB0-VIS-03`
row and before the `## Acceptance summary` heading. The table is 10 columns —
`ID / parent | Area / surface | Baseline evidence | Current evidence | Origin | Classification |
Compatibility boundary | Owner / phase | Disposition / status | Verification`. Column 1 carries the
ID bolded, `**TB0-VIS-04**`, matching `TB0-VIS-01`–`03`.

The edit is **two lines, not one**. The register's `## Acceptance summary` opens with
`- Register rows: **21**.`, and that count is part of the register's own correctness — leaving it at
21 with 22 rows present would be a new inconsistency introduced by this release. So:

1. Append the row below as the table's new final row, immediately after `TB0-VIS-03` and before the
   blank line preceding `## Acceptance summary`.
2. Change `- Register rows: **21**.` to `- Register rows: **22**.`

Nothing else in that file changes. In particular `- `Unassessed` rows: **0**.` stays at **0** —
`TB0-VIS-04` is classified `Unwanted drift`, not `Unassessed`, so the assertion still holds — and the
final bullet about what no row authorizes still holds too: this row assigns an owner and a phase
exactly as `TB0-VIS-01`–`03` do, and confers no editing authority the plan did not already have.

```
| **TB0-VIS-04** | Project forms and Administration — `SignIn`, `CreateProject`, `EditProject`, `ProjectFields`, and the whole `Admin.tsx` screen including Integrations and all three operator queues | TB0's visual baseline never captured these screens; there is no prototype or baseline comparison for them. | Enumerated at TB8-04 as `TB8-04-E-1` … `TB8-04-E-42` in `docs/plans/TB8-04-Project-And-Admin-Forms-Visual-Plan.md` §3.1: six validation errors announced to nobody (E-5), an undefined `--signal-negative` leaving the duplicate-email warning indistinguishable from ordinary cell text since it shipped (E-6), the `data-label` responsive table treatment written but never implemented (E-7), six tables at an 820px minimum inside a 294px viewport (E-8), no `<th scope>` (E-9), two non-conformant tab strips (E-10), three suppressed focus rings (E-11) plus a fourth off-system green `:focus` ring (E-12), two faux-bold sites (E-13), a raw non-brand typeface (E-14), seventeen off-scale type values (E-15), eleven text roles below 4.5:1 (E-16, E-17), row selection signalled by a 6% wash alone (E-18), five inline editors with no accessible name (E-34), and eight inline `style` literals (E-20). | TB8-04 source survey of the five in-scope files and `app.css`, 2026-09-02; no runtime capture claimed. | **Unwanted drift** — unlike `TB0-VIS-01`–`03`, this surface's material differences are accumulated defects, not deliberate product evolution: E-5/E-9/E-10/E-11/E-12/E-17/E-18/E-34 are objective accessibility failures and E-6 is a live rendering bug. Their remediation at TB8-04 is a **Required platform/accessibility/security change**. | Visual/accessibility/type/role | TB8-04 (this release); residual shared selectors to candidate #10, notification surfaces to candidate #5 | Resolve in TB8-04; the accessibility items are release-blocking there, not deferrable. Row opened retrospectively by owner decision so the register stops under-describing the app; **accepted as newly assessed, resolution verified by TB8-04's own gate** | TB8-04 plan §3.1 evidence register, §7's 159 per-selector dispositions, and §10.2's real-browser acceptance criteria; TB8-04 release evidence at 1440×900 / 1024×768 / 390×844. |
```

**Why `Unwanted drift` and not `Intentional evolution`.** `TB0-VIS-01`, `-02` and `-03` are all
`Intentional evolution` because each records a deliberate product decision that moved the app away
from the prototype. This row cannot honestly borrow that classification: nobody decided to suppress
a focus ring, to reference a token that does not exist, or to ship a 3.6:1 status pill. The register
already carries `Unwanted drift` as a first-class value (`docs/plans/revamp_2026_portal/core/11-Design-Convergence.md`
line 23 enumerates the five), and this is what it is for. The row states the remediation
classification separately so the accessibility work is not mistaken for optional polish.

---

## 2. Foundation

### 2.1 Reused verbatim from TB8-01, TB8-02 and TB8-03

These are settled. TB8-04 restates them because it must obey them, not because it may revisit them.

**The arbitrary-value-bound-to-a-Quincy-variable convention** (TB8-01 §1.2). Spacing, type, radius,
border width, duration and easing are written as arbitrary values bound to the ported custom
properties: `p-[var(--space-4)]`, `gap-[var(--space-3)]`, `[font:var(--type-h3)]`,
`text-[length:var(--text-sm)]`, `rounded-[var(--radius-sm)]`,
`border-[length:var(--border-width-hair)]`, `duration-[var(--dur-fast)]`,
`ease-[var(--ease-standard)]`. Colour roles go through the `@theme inline` names in
`tokens/tailwind.css` (`bg-card`, `text-foreground-secondary`, `border-border`, `text-destructive`,
`bg-surface-sunken`) because those are real Tailwind theme entries; everything else stays arbitrary.
Easings in particular stay arbitrary — a self-referential `@theme` entry would emit a circular
reference.

**The hard non-goal** (TB8-01 §1.2). Never map `--spacing-*`, `--text-*`, `--radius-*`, `--shadow-*`,
`--tracking-*`, `--leading-*`, `--font-*` or `--ease-*` into `@theme`. Tailwind's `p-5` is 20px;
Quincy's `--space-5` is 24px. **No bare Tailwind spacing or sizing utility appears anywhere on this
surface**, including where the pixel value happens to coincide. Acceptance criterion 6 greps for it.

**`border-*-solid` does not exist** (TB8-01 §1.3). Preflight is off, so the initial `border-style` is
`none` and a directional width utility alone renders nothing; `border-solid` sets all four sides, so
the three unstyled sides render at the 3px initial width. The only two correct forms:

- one or two sides — `[border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border`
- all four — `border-solid border-[length:var(--border-width-hair)] border-border`

This surface uses the directional form heavily (table cell rules, the section rule, the tab strip
underline, the danger-zone dividers). Criterion 7 greps for the broken form.

**The merged-shorthand rule** (TB8-03 §2.1, live at `ui/button.tsx:15-18` and `ui/select.tsx:82-87`).
Never write `[font:var(--type-x)]` and a separate `text-[length:…]` on the same element. Tailwind's
generated rule order between two utilities touching `font-size` is not guaranteed, and in production
the shorthand won: `[font:var(--type-label)] text-[length:var(--text-xs)]` resolved to 14px, not the
intended 12px. Where a role token's size is not the size wanted, write one explicit shorthand:
`[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)]`. Every deviation from a bare role
token in §5 is written that way.

**`!` is only ever needed against a surviving unlayered rule.** `cn()` is `twMerge(clsx(...))`
(`lib/utils.ts`), so a caller's `className` merges last and beats a component's defaults without any
important modifier. An `!` is justified *only* when an unlayered `app.css` or `tokens/base.css`
declaration would otherwise win. The one live instance is `ui/button.tsx`: `base.css:21` has an
unlayered `a { color: inherit }`, and `buttonClasses()` is used on real anchors via `InternalLink`,
so every text-colour utility in `BASE`/`VARIANT` carries `!`. **An unexplained `!` anywhere in this
release's diff is a defect** (criterion 8). TB8-04 introduces exactly one new `!` *pattern*, applied
at two sites, both named and justified in §5.4.

**The press behaviour is a 1px nudge, never a scale** — `active:not-disabled:translate-y-px`, from
`BASE`. Never `active:scale-95`, the stock reflex.

**44px is WCAG 2.5.5 Target Size (Enhanced), AAA — not 2.5.8.** 2.5.8 is the AA criterion and its
minimum is 24×24. TB8-01 §1.4 cited 2.5.8; TB8-02 §10.5 and TB8-03 §2.1 corrected it. No Quincy token
equals 44px, so every 44px site stays an explicit literal carrying the comment
`/* 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token */`. TB8-04 adds 44px the way
TB8-02's `Modal` FOOT does — **at `max-[720px]` only** (§2.1a below).

**The overlay contract** (TB8-02 §10.1–§10.5). Anchored overlays: `--shadow-md`, no scrim, 1px
`--border-hairline`, radius 0. Detached dialogs: `--shadow-lg` + `--scrim-overlay` + 3px blur.
Everything else: no shadow. Motion is `transition-[opacity,translate]` only, `motion-safe:`-prefixed,
base classes carry exit timing and `data-open:` overrides to entrance. **TB8-04 adds no new overlay.**
Its two dialog paths — `confirm()` from `lib/confirm` and the payload `Modal` — are already TB8-02's
and are not re-specified here.

**Colour roles, never the raw ramp** (`tokens/tailwind.css:47-59`). `text-foreground-secondary`,
`bg-surface-sunken`, `border-border-hover`, `bg-primary-hover` exist precisely so this surface never
writes `text-[var(--greige-600)]`. Criterion 5 greps for raw-ramp utilities.

**The contrast facts that decide nine substitutions on this surface** (TB8-01 §7.4, TB8-03 E-7):

| Pair | Ratio | Verdict |
|---|---|---|
| `--text-muted` (`--greige-400` `#8f8775`) on `--paper-000` `#ffffff` | 3.6:1 | fails 4.5:1 |
| `--text-muted` on `--paper-050` `#faf8f2` | 3.5:1 | fails |
| `--text-muted` on `--bg-sunken` `--paper-200` `#ece6d8` | 2.9:1 | fails |
| `--text-secondary` (`--greige-600` `#4d473c`) on `--paper-000` | 9.2:1 | passes AAA |
| `--text-secondary` on `--bg-sunken` | 7.4:1 | passes AAA |

**Every muted *text* role on this surface becomes `text-foreground-secondary`.** `--text-muted`
survives only where it is not text: it does not survive anywhere in §5.

### 2.1a Control height: 38px at desk, 44px in the hand

`.button` is `min-height: 38px` (app.css:867) and `.admin-field input` is `min-height: 38px`
(app.css:949); `buttonClasses` BASE and `ui/input.tsx` both carry `min-h-[38px]`. TB8-01 explicitly
retained 38px with `px-[14px] py-[9px]` as *inherited off-grid debt*, to be normalised in the release
that finally retires `.button` — which is candidate #10, not this one.

TB8-04 therefore **does not fork the 38px contract**. It adds, to `BASE` and to `Input`/`Textarea`/
`NativeSelect`, the same `max-[720px]:min-h-[44px]` that TB8-02 already ships on `Modal`'s footer
(`Modal.tsx:93`). Rationale: 720px is this repo's established touch breakpoint, 2.5.5 protects touch
interaction, and raising desktop controls to 44px would silently re-geometry every button in the app
from a plan whose scope is five files. One contract, applied where it matters, consistent with
shipped precedent.

### 2.2 The unlayered-`app.css` cascade rule, and the three dispositions

`src/styles/index.css:1` declares `@layer theme, base, components, utilities;` and then, at line 10,
imports `./app.css` **outside any layer**. Unlayered author CSS beats every layered rule regardless of
selector specificity. So on any element that still carries a legacy class, an ordinary Tailwind
utility loses.

This is the defect that nearly shipped in TB8-03: legacy `.grid` overrode Tailwind's `grid` and
`grid-cols-*` on the migrated rail. Ten clean code-level review rounds missed it; only live-browser
review caught it. The fix was to rename the legacy selector to `.legacy-grid` (now app.css:168).

**Every legacy selector an in-scope file touches gets one of exactly three dispositions, stated per
selector in §7.2:**

- **(a) Retire.** Delete the paint from `app.css` after a zero-remaining-*unmigrated-paint*-consumer
  search. The class name may stay on the element as a **non-styling hook** when a test or another
  selector depends on it — that is not a consumer of the paint, it is a handle. This is TB8-04's
  dominant disposition and the reason the release exists.
- **(b) Split the consumer.** Drop the class from in-scope elements only; leave the `app.css` rule
  untouched for consumers outside §1.1. Applies to `.button*`, `.empty`, `.notice`, `.ey`, `.serif`,
  `.page`, `.pagehead`, `.toasts`/`.toast`.
- **(c) Structurally override.** The narrowest possible `!`-prefixed utility, for the one property
  that must change, when neither (a) nor (b) fits. **TB8-04 uses this exactly once** (§5.4), and it is
  recorded in evidence.

**An ordinary Tailwind utility standing beside a surviving matching `app.css` selector is never
acceptable.** If the rule survives, either the class comes off the element (b) or the utility is
`!`-prefixed (c). There is no fourth option and no "it looked fine locally".

**Collision audit for this surface.** All 573 class names declared in `app.css` and
`production-calendar.css` were extracted and matched against Tailwind utility name shapes. Beyond the
already-fixed `.grid`, exactly two collisions exist app-wide:

- `.grow` (app.css:28, `flex: 1`) shadows Tailwind's `grow`. **Zero consumers in §1.1** — verified: no
  in-scope file uses `grow`, `row`, `spread` or `gap2`–`gap5`. It cannot bite this surface. Left
  alone, exactly as TB8-03 left it (E-25).
- `.sr-only` (app.css:937 **and** :1046, byte-identical) shadows Tailwind's own `sr-only` utility.
  **8 in-scope consumers.** The two declarations are functionally equivalent — the legacy rule writes
  `border: 0` where Tailwind writes `border-width: 0` — so the shadowing is non-symptomatic, and the
  in-scope `sr-only` spans render correctly either way. TB8-02 §11.2 already assigned the duplicate's
  deletion to candidate #10. TB8-04 **records it and deletes neither** (E-26). Criterion 15 asserts
  both declarations still stand after the diff, so an over-eager sweep is caught.

Nothing else collides. `.legacy-grid`, `.hairline`, `.nowrap`, `.spread`, `.chip`, `.empty`,
`.notice`, `.toast` and the `.admin-*`/`.create-project__*` families have no Tailwind counterpart.

### 2.3 Legacy type helpers, and their Tailwind equivalents

From TB8-01 §2.3, already shipped:

| Legacy | Equivalent | Component |
|---|---|---|
| `.ey` (app.css:20) | `[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary` | `<Eyebrow>` (`ui/eyebrow.tsx`) |
| `.serif` (app.css:22) | `font-[family-name:var(--font-display)] tracking-[var(--tracking-tight)]` | — (utility pair) |
| `.muted` (app.css:21) | `text-muted-foreground` | — (and **not used on this surface**, per §2.1's contrast table) |

`.serif` sets only family and tracking, never size — the size comes from the element's own role token.
Every in-scope `<h1>`/`<h2>`/`<h3>` in §5 therefore writes a `[font:var(--type-h*)]` shorthand, which
already carries `--font-display`, and adds `tracking-[var(--tracking-tight)]` — it does **not** write
`font-[family-name:…]` redundantly on top.

### 2.4 What this release does not introduce

No new runtime dependency. No `shadcn` CLI generation — every primitive below is hand-written against
the existing `components.json` conventions, the way `ui/button.tsx`, `ui/field.tsx`, `ui/input.tsx`
and `ui/select.tsx` were. **No `cva`** — TB1 removed it as unused and reintroducing it is outside a
plan's authority; variant maps stay plain `Record<Variant, string>` objects, as in
`ui/button.tsx:32-41`. No dark-mode variants. No Preflight re-enable. No new overlay primitive. No
change to `index.css`'s layer declaration or import order.

---

## 3. The survey

### 3.1 Evidence register

Every entry below was read first-hand in the file and line cited. Nothing is inferred from another
plan's summary.

**Count, stated precisely: 42 IDs (`E-1` … `E-42`) covering 41 distinct defects.** `E-41` was found
on 2026-09-02 to be a duplicate of `E-20` — the same eight inline `style` objects at the same eight
lines, written up twice. It is withdrawn in place rather than reclaimed or renumbered, so that the
~130 `E-n` cross-references elsewhere in this plan keep their meaning. Wherever this plan says the
register "runs `E-1` … `E-42`", that describes the ID range and is accurate; it is not a claim of 42
separate defects.

**Cascade and foundation**

- **TB8-04-E-1 — No drift-register row exists for this surface.**
  `docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md` holds 21 rows, none marked
  `Unassessed`; its visual rows are `TB0-VIS-01` (dashboard shell), `TB0-VIS-02` (workspace, media
  grid, lightbox, compare) and `TB0-VIS-03` (collaboration, notice board). Forms, `SignIn` and the
  Admin screen appear in no row. The roadmap's "start from drift-register entries" rule has no input
  here; §1.3 states what replaces it.
- **TB8-04-E-2 — The unlayered import.** `src/styles/index.css:1` declares
  `@layer theme, base, components, utilities;`; line 10 imports `./app.css` outside every layer, and
  `tokens/base.css` is likewise unlayered. Any `app.css` rule beats any Tailwind utility on the same
  property regardless of specificity. This is the cascade fact that governs §7 and it is why every
  selector below needs a stated disposition rather than "we just stopped using it".
- **TB8-04-E-3 — The field geometry already matches.** `app.css:949`
  (`.admin-field input, .admin-field select, .admin-role-select`) is
  `width:100%; min-height:38px; padding:8px 10px; border:1px solid var(--border-hairline);
  border-radius:var(--radius-sm); background:var(--paper-050); color:var(--text-primary);
  font:var(--type-body); font-size:14px`. `components/ui/input.tsx:11` is
  `w-full min-h-[38px] border border-solid border-[var(--border-hairline)]
  rounded-[var(--radius-sm)] bg-[var(--paper-050)] px-[10px] py-[8px]
  [font:var(--weight-regular)_14px/var(--leading-normal)_var(--font-sans)]
  text-[var(--text-primary)]`. These are the same box. **Migrating every `label.admin-field` to
  `QuincyField` is a zero-pixel visual change** — it is bought entirely for the accessibility wiring
  in E-5.
- **TB8-04-E-4 — The label paint already matches too.** `app.css:948` (`.admin-field`) is
  `display:flex; flex-direction:column; gap:6px; font:var(--type-eyebrow); text-transform:uppercase;
  letter-spacing:var(--tracking-wide); color:var(--text-secondary)`.
  `ui/field.tsx:19` (`Field`) is `flex w-full flex-col gap-[6px]` and `ui/field.tsx:26`
  (`FieldLabel`) is `[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)]
  text-[var(--text-secondary)]`. Identical, property for property.

**Accessibility**

- **TB8-04-E-5 — Six validation errors are announced to nobody.** Each site sets `aria-invalid` on
  the input and renders a bare `<small>` that is not referenced by `aria-describedby`, not an
  `aria-errormessage` target, and not in a live region: `CreateProject.tsx:55`
  (`.create-project__hero-error`, street), `EditProject.tsx:118` (street),
  `ProjectFields.tsx:105` (`errors.invoiceAmount`), `ProjectFields.tsx:116`
  (`errors.rawFolderLink`), `Admin.tsx:422` (provision name), `Admin.tsx:423` (provision email).
  A screen-reader user hears "invalid" and is told nothing about what is wrong. The one compliant
  field on the whole surface is TB1's `project-agent-email` (`ProjectFields.tsx:95`), because
  `QuincyField` wires `aria-describedby`/`aria-errormessage` to `${id}-error` and `FieldError`
  carries `role="alert"`.
- **TB8-04-E-6 — A live rendering defect: `--signal-negative` does not exist.**
  `app.css:997` is `.admin-warning { color: var(--signal-negative); font-size: 12px }`. Grepping the
  whole repo finds no `--signal-negative` declaration in `tokens/colors.css` or anywhere else — the
  defined critical role is `--signal-critical` (`tokens/colors.css`, `#7a2420`). The property is
  invalid at computed-value time, so `color` falls back to inherited: the "Duplicate email possible"
  warning at `Admin.tsx:469` renders in `--text-secondary` inherited from `.admin-table td`
  (app.css:962), indistinguishable from ordinary cell text, on the one control in the app that can
  double-send a client email. (`--signal-red` at `app.css:1076` is the same class of bug but carries
  a literal fallback and is out of scope.)
- **TB8-04-E-7 — `data-label` is dead markup.** `Admin.tsx` emits `data-label` on 25 table cells
  (verified 2026-09-02: `grep -o '<td [^>]*data-label' src/screens/Admin.tsx | wc -l` returns 25,
  and the same count on `<th` returns 0 — every one is on a `<td>`)
  (`Name`, `Email`, `Role`, `Access`, `Created`, `Agency`, `Agent`, `Event`, `Attempts`, `Status`,
  `Channel`, …). Grepping all of `src/styles/` for `data-label` returns **zero** hits. No rule
  consumes it. The stacked-card responsive table this markup was written for has never rendered.
- **TB8-04-E-8 — What actually happens at 390px is horizontal scroll.** `app.css:960` sets
  `.admin-table { min-width: 820px }` inside `.admin-table-wrap { overflow-x: auto }`
  (`app.css:959`). At 390×844 the content box is ~294px wide (`.page` has `padding: var(--space-7)`
  = 48px each side, app.css:138; `--space-7: 48px`, tokens/spacing.css), so every Admin table is
  ≈2.8 viewports wide and every row must be panned. The seven-column notification-delivery table is the worst case.
- **TB8-04-E-9 — No `<th>` on the surface carries `scope`.** Six tables:
  `Admin.tsx:432` (users), `:445` (agencies), `:448` (agents), `:467` (Tonomo failed events),
  `:468` (rendition DLQ), `:469` (notification delivery). Header association is left to the
  browser's heuristics, and those heuristics break entirely under the `display:block` stacking of
  §5.6.
- **TB8-04-E-10 — Both tab strips are non-conformant, and one controls nothing.**
  `Admin.tsx:410` is `<div className="admin-tabs" role="tablist" aria-label="Administration
  sections">` over `<button className={\`ctab …\`} role="tab" aria-selected={…}>` — with **no `id`,
  no `aria-controls`, no roving `tabIndex`, and no arrow-key handler**. The four panels
  (`:414`, `:441`, `:451`, `:457`) carry `role="tabpanel"` with **no `aria-labelledby`** and no
  `tabIndex={0}`. `Admin.tsx:469` carries a **second** `role="tablist"`
  (`aria-label="Notification delivery filters"`) with five `.ctab` buttons that control **no element
  with `role="tabpanel"` at all** — the filtered table is a plain sibling. Per WAI-ARIA APG a tablist
  must own its panels, and `aria-selected` without `aria-controls` is a promise the DOM does not
  keep.
- **TB8-04-E-11 — Three focus rings are actively suppressed.** `tokens/base.css:25-28` sets the
  system ring: `:focus-visible { outline: var(--border-width-bold) solid var(--focus-ring);
  outline-offset: 2px }`. Three unlayered rules cancel it and substitute a 1px border-colour change:
  `app.css:950` (`.admin-field input:focus, .admin-field select:focus, .admin-role-select:focus`),
  `app.css:953-957` (`.quincy-input:focus, .quincy-input:focus-visible` — which reaches **every**
  `ui/input.tsx` instance app-wide, including TB1's migrated Client fields), and `app.css:1044`
  (`.create-project textarea:focus`). This is exactly the regression class TB8-03 wrote its
  `suppressesOutline()` test helper to catch. `ui/input.tsx` has **no** `focus-visible` ring of its
  own, so it currently depends on the legacy rule for its focus affordance.
- **TB8-04-E-12 — And a fourth ring is off-system.** `app.css:1009`
  (`.create-project__address input:focus`) is `outline: 2px solid var(--signal-positive);
  outline-offset: 2px` — the only olive focus ring in the app, on the most important input on the
  most important form. Signal colours encode state, not focus.
- **TB8-04-E-13 — Faux bold, twice.** `app.css:1039` (`.create-project__check strong`) and
  `app.css:1203` (`.danger-zone strong`) both set `font-weight: 500`. **Apfel Grotezk is self-hosted
  at 400 only** — `styles/fonts.css:10-12` declares one face, `ApfelGrotezk-Regular.otf` at
  `font-weight: 400`, and there is no second `@font-face` for it. Only Messapia (`:26-28`) and
  Athelas (`:50-60`) ship a real 700 file. Since `--font-sans` is
  `"Apfel Grotezk", "Helvetica Neue", Arial, sans-serif` (`tokens/typography.css:18`) and the first
  family always resolves, **any** weight other than 400 on sans text renders browser-synthesised —
  thickened outlines, broken sidebearings. Same defect class as TB8-02 E-6 and TB8-03 E-5/E-9.

  *(Corrected 2026-09-02. This entry previously said "400 and 700 only", which is false and had
  propagated into §7 rows 116 and 144 as a `→ --weight-bold` remedy. **700 on sans is the same bug
  as 500.** The fix is `--weight-regular`, exactly as TB8-02 and TB8-03 shipped it — TB8-02's
  `__option strong` went to `font-normal` with "hierarchy comes from the `small` beneath going
  `text-muted-foreground`, not from a weight the font does not have", and TB8-03 §E-5 recorded
  "`font-weight: 500` is gone; hierarchy comes from case and colour." §5.14, §5.15 and §5.16 already
  said `--weight-regular` and were right; §7 and the two `<strong>` samples have been corrected to
  match. `--weight-bold` remains correct on `--font-display`, `--font-statement` and
  `--font-serif` text, which do have 700 faces.)*
- **TB8-04-E-14 — The only raw non-brand typeface on the surface.** `app.css:881`
  (`.button__google`) is `width:18px; height:18px; … font: 700 12px/1 Arial, sans-serif` — an 18px
  disc painting a hand-drawn letter "G" beside "Continue with Google" (`SignIn.tsx:26`). It is not
  Google's mark, it is not a brand asset, it duplicates the word already in the label, and it is the
  one place in the app that specifies Arial directly.
- **TB8-04-E-15 — Seventeen off-scale type sizes.** `--text-*` runs 11/12/14/16/18/22/28/36/48
  (`tokens/typography.css:24-32`). The surface declares, in `app.css`: `13.5px` (:947 provision copy,
  :1204 danger-zone body), `10px` (:967 status pills, :978 `dt`), `11px` (:961 `th` — on scale as
  `--text-2xs`, but written as a literal), `13px` (:981 `dd`, :1039 check `strong`), `14.5px`
  (:606 `.empty--raw p`, out of scope), `34px` (:944 `.admin-section__head h2`), `29px`
  (:1022 and :1201 section-head `h2`), `28px` (:975 integration `h3` — on scale, literal), `24px`
  (:991 stage ordinal), `25px` (:1007 address input), `15px` (:1016 details summary),
  `clamp(36px,5vw,58px)` (:1005 create hero), `clamp(38px,6vw,52px)` (:887 sign-in title),
  `12px` (:952, :997 — on scale, literal). Nine of those values exist on no scale at all.
- **TB8-04-E-16 — Nine failing text roles.** `--text-muted` is `--greige-400` `#8f8775`, 3.6:1 on
  white and 3.5:1 on `--paper-050` (§2.1). It paints text at: `app.css:961` `.admin-table th`;
  `:985` `.admin-table__empty`; `:980` `.integration-meta dt`; `:994` `.admin-stage small`;
  `:890` `.signin__note`; `:1013` `.create-project__refinements em`; `:1017`
  `.create-project__details summary span`; `:1008` the address `::placeholder`; `:1040`
  `.create-project__check small`. Also `:739` `.empty` and `:969` the inactive status pill (E-17).
- **TB8-04-E-17 — The neutral status pill is unreadable, and every pill variant differs in hue
  only.** `app.css:967` (`.admin-status`) is a bordered pill at `font-size: 10px`; `:968`
  (`--active`, `--connected`) paints `--signal-positive`; `:969` (`--inactive`, `--disconnected`,
  `--not-configured`) paints `--text-muted`; `:970` (`--expired`) `--signal-caution`; `:971`
  (`--error`) `--signal-critical`. **To be precise: this is not a WCAG 1.4.1 failure** — every pill
  carries its own text ("Active", "Inactive", "Connected", "Not configured"), so colour is not the
  sole means of conveying the state. The two real defects are that the neutral variant is
  `--text-muted` at **3.6:1** (E-16) and that 10px is below the type scale's smallest step (E-15).
  A secondary robustness point: all five variants are identical in shape, weight, fill and border,
  so hue is doing all of the *visual grouping* work even though the label carries the meaning.
- **TB8-04-E-18 — Row selection is colour alone.** `app.css:986` is
  `.admin-table tbody tr.is-selected td { background: color-mix(in srgb, var(--signal-positive) 6%,
  transparent) }`. A 6% olive wash on warm paper is both sub-threshold and the only indication that
  an agency row is selected and driving the agent list below it.
- **TB8-04-E-19 — A signal colour used decoratively.** `app.css:991`
  (`.admin-stage__order`) paints the pipeline ordinal `1`–`5` in `--signal-positive` at 24px. The
  ordinal is not a positive state; it is an index. Meanwhile `--signal-positive` genuinely means
  "connected/active" three sections away, on the same screen.
- **TB8-04-E-20 — Eight inline `style` literals, all off the 4px grid or duplicating a token.**
  `Admin.tsx:405` `{{marginBottom:14}}`; `Admin.tsx:429`, `:460`, `:467`, `:469`
  `{{marginTop:16}}` (four Load-more / retry wrappers); `CreateProject.tsx:49` and
  `EditProject.tsx:115` `{{marginBottom:14}}`; `ProjectFields.tsx:121` `{{marginTop:12}}`.
  14 is on no scale; 16 is `--space-4`; 12 is `--space-3` (`tokens/spacing.css` runs 0, 4, 8, 12,
  16, 24, 32, 48, 64, 96, 128, 192). An inline style is also **the one paint that no `app.css`
  retirement and no Tailwind utility can reach**, so these survive every other cleanup in this
  release unless they are named here. All eight are removed in §5. Verified against source
  2026-09-02: `grep -n 'style={{'` over the five in-scope files returns these eight lines and no
  others — `SignIn.tsx` has none.
  *(Absorbed the former **E-41** on 2026-09-02 — see that entry.)*
- **TB8-04-E-34 — Five inline editors have no accessible name.** `Admin.tsx` renders **six**
  `.admin-inline-input` nodes and exactly **one** of them is named: `:437`, the user-name editor,
  carries `aria-label={\`Name for ${user.name}\`}`. The other five have **no `aria-label`, no
  `<label>`, no `aria-labelledby`** — the agency editor's Name and Notes inputs (`Admin.tsx:445`)
  and the agent editor's Name, Email and Phone inputs (`:448`). A screen reader announces "edit
  text, blank" for each, so an operator cannot tell which field of which row they are editing, let
  alone distinguish the agent's email box from their phone box. §5.9 names all five.

  *(Corrected 2026-09-02, Sol round 1 correctness 6: this entry said "two inline editors" and §5.9
  named only the two Name inputs, leaving Notes, Email and Phone unnamed and §10.2 item 4 —
  "every control has a programmatic label" — unsatisfiable. Verified by
  `grep -o '<input[^>]*admin-inline-input[^>]*>' src/screens/Admin.tsx`, which returns six nodes,
  and `grep -o 'aria-label={\`[^\`]*\`}'`, which returns one.)*

**Legacy ownership and consumer counts**

- **TB8-04-E-21 — `.ctab` has exactly two consumers, both in scope.** `Admin.tsx:411` (the
  administration tab strip) and `Admin.tsx:469` (the notification-delivery filter strip). Nothing
  else in `apps/web/src` references `ctab`. Its declared siblings `.ctabs` (app.css:678) and `.cbar`
  are already at **zero** consumers app-wide, independent of this release. So TB8-04 can retire the
  whole `.ctab` family outright (§7 case (a)); `.ctabs`/`.cbar` are pre-existing dead weight left to
  candidate #10.
- **TB8-04-E-22 — `.empty` splits 10 / 21.** *(Recounted 2026-09-02 after Sol round 1; the plan
  previously said 9 / 19 with `Admin.tsx` ×8.)* In scope: `Admin.tsx` ×9 and `EditProject.tsx:120`
  = 10. Out of scope: 21 consumers across 7 files — `ProjectWorkspace.tsx`, `Dashboard.tsx`,
  `NoticeBoard.tsx`, `ProjectCollaborationPanel.tsx` and others — plus a test query at
  `ProjectWorkspace.dom.test.tsx:170`. Case **S**. Command of record:
  `grep -roE 'className="[^"]*\bempty\b[^"]*"' --include='*.tsx' src | wc -l` = 31 total.
- **TB8-04-E-23 — `.notice` splits 11 / 25.** *(Out-of-scope half recounted 2026-09-02; the plan
  previously said 6, and described `.admin-notice` as ×7.)* In scope: `Admin.tsx` ×6 (of which
  **2**, not 7, are the `.admin-notice` compound), `EditProject.tsx` ×2, `SignIn.tsx:29`,
  `CreateProject.tsx:52` and `ProjectFields.tsx:120` = 11. Out of scope: 25. No test queries it.
  Case **S**.
- **TB8-04-E-24 — `.button` and its modifiers have 65 consuming files outside §1.1.** Case (b),
  identical to TB8-01/02/03.
- **TB8-04-E-25 — Collision audit.** All 573 class names declared across `app.css` and
  `production-calendar.css` were matched against Tailwind utility name shapes. Beyond the
  already-fixed `.grid` → `.legacy-grid` (app.css:168), the only survivors are `.grow` (app.css:28,
  `flex: 1`) and `.sr-only` (E-26). **`.grow` has zero consumers in §1.1** — no in-scope file uses
  `grow`, and none uses `row`, `spread` or `gap2`–`gap5` either — so it cannot bite this surface and
  is left exactly as TB8-03 left it.
- **TB8-04-E-26 — `.sr-only` is declared twice, byte-identically, and shadows the Tailwind
  utility.** `app.css:937` and `app.css:1046` are the same rule. Both are functionally equivalent to
  Tailwind's own `sr-only` (the legacy form writes `border: 0`, Tailwind writes `border-width: 0`),
  so the shadowing is non-symptomatic and the eight in-scope `sr-only` spans
  (`CreateProject.tsx:53`, `Admin.tsx:432`, `:437`, `:445`, `:448`, `:467`, `:468`, `:469`) render
  correctly under either owner. TB8-02 §11.2 assigned the duplicate's deletion to candidate #10.
  TB8-04 keeps `className="sr-only"` on all eight and deletes neither declaration.
- **TB8-04-E-27 — `[&]:grid` is a dead escape hatch.** `ProjectFields.tsx:92` writes
  `className="[&]:grid grid-cols-1 min-[721px]:grid-cols-2 min-[1081px]:grid-cols-4
  gap-[var(--space-4)]"`. The doubled-specificity `[&]:` prefix existed because legacy `.grid`
  (unlayered) beat Tailwind's `grid`. TB8-03 renamed that selector to `.legacy-grid`, so the
  collision no longer exists and the workaround is now noise that misleads the next reader.
  `ProjectFields.test.ts:91-93` asserts it is present and that plain `grid` is absent, so removing it
  forces an exact test edit (§9).
- **TB8-04-E-28 — A cross-scope test pins two class names and a DOM adjacency.**
  `components/ProjectCollaborationPanel.dom.test.tsx:1018` asserts
  `editor.querySelector(".create-project__form")` is not null, and `:1020` asserts
  `editor.querySelector(".pagehead + .create-project__form")` is not null. The second one requires
  `.create-project__form` to remain the **immediate next sibling** of `.pagehead` in
  `EditProject.tsx`. Any wrapper inserted between them breaks a test in a file this release does not
  own. §8 carries this as a named invariant.
- **TB8-04-E-29 — A test string-matches a class attribute exactly.**
  `components/ProjectFields.test.ts:79` does
  `markup.indexOf('<section class="create-project__section" aria-labelledby="client-heading">')`
  against `renderToStaticMarkup` output. The Client `<section>`'s `class` attribute must therefore
  either stay exactly that string or the assertion must be rewritten. §9 rewrites it.

- **TB8-04-E-39 — Neither tab strip has a selected-state indicator except hue.**
  `app.css:942` is `.admin-tabs .ctab { border: 0; background: transparent; padding: 8px 0 11px }`.
  The `border: 0` cancels `.ctab.is-active`'s `border-bottom-color: var(--ink-900)` (app.css:681),
  so a selected tab differs from an unselected one **only** by `color: var(--text-primary)` against
  `var(--text-secondary)` — no underline, no weight change, no ground, no shape. That is WCAG 1.4.1
  on a control whose `aria-selected` promises a programmatically distinguishable state, and the hue
  difference itself is small (`#0a0a0a` against `#4d473c`). Both strips are affected:
  `className="admin-tabs"` appears at `Admin.tsx:410` (the four administration sections) **and** at
  `Admin.tsx:469` (the five notification-delivery filters), so the `.ctab.is-active` underline that
  `app.css:681` declares is dead on this screen everywhere it appears. `.ctab` has **no other
  consumer in `portal/`** — a repo-wide `\bctab\b` search returns exactly these two lines — so the
  whole `.ctab` family (`:679`–`:684`) is disposable here rather than shared. (`.ctabs` at `:678`
  and `.ctab .cnt` at `:682` already have zero consumers; `.ctab--premium` at `:683`–`:684` has zero
  consumers too. The apparent third hit in `ProductionCalendar.tsx` is the substring inside
  `sele**ctab**le={false}`, not a class.)
- **TB8-04-E-41 — WITHDRAWN 2026-09-02: a duplicate of E-20.** Both entries described the same
  eight inline `style` objects at the same eight lines. The ID is retained rather than reclaimed so
  that the ~130 `E-n` cross-references elsewhere in this plan keep their meaning; its substance —
  the `--space-*` scale listing and the "no retirement can reach an inline style" argument — has
  been folded into **E-20**, which is now the single citation for this defect. Every reference to
  E-41 in §6.1 was repointed to E-20 in the same pass. **Nothing about the work changes: it was
  always eight sites and one fix.** *(Neither Sol round caught this; both verified that the 42
  IDs are unique, which they are, without checking that the 42 findings are distinct.)*
- **TB8-04-E-40 — `.serif` is redundant on every in-scope heading.** `app.css:140` is
  `.pagehead h1 { font: var(--type-h1); letter-spacing: var(--tracking-tight) }`, and `--type-h1`
  already carries `--font-display`; `.signin__title` (app.css:887) does the same for the sign-in
  heading. The `className="serif"` on `CreateProject.tsx:50`, `EditProject.tsx:116` and
  `Admin.tsx:407` therefore changes nothing that the element does not already have. Dropping it is a
  zero-pixel change, and `.serif` itself stays for out-of-scope consumers (§7 case (b)).

**Primitive-level findings**

- **TB8-04-E-30 — Two raw pixel literals in shipped primitives.** `ui/input.tsx:11` writes
  `[font:var(--weight-regular)_14px/var(--leading-normal)_var(--font-sans)]` where `--text-sm` is
  14px; `ui/field.tsx:42` (`FieldError`) writes
  `[font:var(--weight-regular)_12px/1.5_var(--font-sans)]` where `--text-xs` is 12px. Both compute
  identically to the token, so normalising them is a zero-pixel change that removes two future drift
  sites.
- **TB8-04-E-31 — A stale WCAG citation in a shipped primitive.** `ui/select.tsx:92` carries the
  comment `/* 44px — WCAG 2.5.8 minimum target */` on `min-h-[44px]`. 2.5.8 (AA) requires 24×24;
  44×44 is 2.5.5 Target Size (Enhanced), AAA. TB8-02 §10.5 and TB8-03 §2.1 corrected the prose but
  the comment in the code was never fixed.
- **TB8-04-E-32 — The Admin payload dialog is already migrated.** TB8-02 §6.6 replaced the
  hand-rolled admin modal with `<Modal size="prose" testId="admin-payload-modal">`
  (`Admin.tsx:471-483`), and `app.css:998-999` records the deletion of the `.admin-modal*` family.
  The dialog's own structure is final and §6.2 excludes it. Its `<pre>` is the one exception —
  see E-42. *(Corrected 2026-09-02: this entry previously claimed the `<pre>` "already carries the
  final Tailwind class string". It does not.)*
- **TB8-04-E-42 — The merged-shorthand rule is violated in an in-scope file, by the exact
  mechanism TB8-01 documented.** `Admin.tsx:480` — the payload `<pre>` — carries
  `[font:var(--type-mono)] text-[length:var(--text-xs)] leading-[var(--leading-normal)]`: three
  utilities competing over `font-size` and `line-height`. `tokens/typography.css:68` defines
  `--type-mono` as `var(--weight-regular) var(--text-sm)/1.4 var(--font-mono)`, so the `font:`
  shorthand sets 14px/1.4 and the two separate utilities then try to override it with 12px/1.5.
  Which wins depends on Tailwind's generated rule order, not on authoring order — this is
  character-for-character the failure `components/ui/button.tsx:15-18` records having already hit
  once ("it was resolving to `--type-label`'s own 14px, not the intended 12px"). §5.12 merges it
  into the single explicit shorthand
  `[font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-mono)]`, dropping
  both competing utilities. Found 2026-09-02 by running §10.1-D4 against the current tree, which
  is also how the D3/D4 defects in that gate were found (§10.1-D preamble).
- **TB8-04-E-33 — Dense action cells with no wrap rule.** `app.css:965` is
  `.admin-table__action { text-align: right }` and nothing else. The Users action cell holds up to
  three buttons ("Edit"/"Save"+"Cancel", "Deactivate"/"Reactivate", "Act as"), each `min-height:38px`
  with `padding: 9px 14px`; at 1024×768 inside a 820px-minimum table they crowd against the right
  rule with no gap declaration and no wrapping.

- **TB8-04-E-37 — The design system's field ground is inverted in the app.**
  `tokens/colors.css:52-53` declares `--field-bg: var(--paper-000)` (white) and
  `--field-border: var(--ink-900)`. **Neither token is consumed anywhere in `apps/web/src`.**
  `ui/input.tsx:11` paints `bg-[var(--paper-050)]` and `app.css:949` paints
  `background: var(--paper-050)` — the canvas colour — while the sections *around* them are painted
  `--paper-000`. The system says "white field on warm ground"; the app ships "warm field on white
  ground". §4.2's removal of the white section card makes resolving this **forcing**, not optional:
  a `--paper-050` field on a `--paper-050` section would be invisible.
- **TB8-04-E-38 — `Input` has one product consumer, so `.quincy-input` is fully retirable.**
  `components/ui/input.tsx` is imported by `components/quincy/QuincyField.tsx:4` and by
  `components/quincy/QuincyField.dom.test.tsx:5` (a `ref`-forwarding test) and nowhere else;
  `QuincyField` is imported by `ProjectFields.tsx:5` and nowhere else. No test queries
  `.quincy-input`. Once `Input` carries its own focus and invalid styling, the class name and both
  legacy rules (app.css:953-958) can be deleted outright — §7 case (a).

**Layout findings**

- **TB8-04-E-35 — An off-grid, off-scale control pair.** `app.css:1007` gives the address input
  `min-height: 58px; padding: 12px 16px; font: var(--type-h3); font-size: 25px; border-radius: 0`
  and `app.css:1010` matches the adjacent submit button at `min-height: 58px`. 58 is on no scale;
  25px is on no scale; the nearest tokens are `--space-7` (48px) and `--text-lg` (22px). It is also
  the only radius-0 input in the app while every other field is `--radius-sm`.
- **TB8-04-E-36 — The mobile stack drops one full-width rule.** `app.css:1048-1062` (`max-width:
  720px`) sets `.create-project__hero-action .button { width: 100% }`, but `.admin-provision`,
  `.admin-directory-form` and `.admin-agent-form` only collapse to `grid-template-columns: 1fr` —
  their submit buttons stay auto-width and left-aligned under a full-width field stack at 390px,
  which reads as an unfinished form.

### 3.2 What the register adds up to

Two of these are true bugs a user can hit today (E-6 renders a warning invisible; E-11 removes the
focus ring from every migrated input in the app). Ten are accessibility failures that block release
by the owner's standing rule. Seven are visual drift against the ported design system. The rest are
ownership facts that make the retirement in §7 possible. Nothing here is speculative and nothing is
a matter of taste — the taste decisions are in §4, kept separate on purpose.

---

## 4. Design direction

### 4.1 The organising idea: the ledger sheet

The five in-scope screens are, without exception, **the studio's records**. A shoot is opened by
typing an address into a book. A shoot is edited by amending that entry. The Admin screen is where
the owner reads the studio's ledgers: who has access, which agencies and agents exist, what the
pipeline's five stages are, which integrations are connected, and which deliveries failed and need
replaying. Even sign-in is a name being presented at the door.

Today these screens are painted as **cards** — a white panel with a hairline border for every
section, seven of them stacked down the New Shoot page, four more on Admin. That is the generic
answer, it is the same answer the dashboard already gave before TB8-01, and it is wrong for this
content: a border around a section says "this is a discrete object", and a form section is not a
discrete object. It is a paragraph of a document.

**The direction is the ledger sheet: one continuous warm-paper surface, divided by rules and space
rather than by boxes, with borders reserved for things that genuinely are bounded objects.** Three
structural devices carry it, and each of them encodes something true rather than decorating.

**Device 1 — the section rule.** Every section head sits under a 3px ink rule spanning the section's
full width: `[border-top-style:solid] border-t-[length:var(--border-width-rule)] border-t-primary`.
`--border-width-rule` (3px) exists in `tokens/spacing.css` and is used by `base.css`'s `.q-rule`
helper, which nothing currently consumes — the design system shipped this device and the app never
used it. It replaces the card border as the thing that says "a new part of the record starts here",
and it is heavier than any other line on the page, so the reading order is unambiguous at a glance:
**rule → eyebrow → heading → fields**. Sections separate by `--space-8` (64px) of paper, not by a
gap between two boxes.

**Device 2 — the label column.** Form labels and table column headers get the *same* treatment:
`--type-eyebrow` (12px), uppercase, `--tracking-wide` (0.08em), `text-foreground-secondary`. That
is already `.admin-field`'s label paint (E-4) and already `FieldLabel`'s; it is *nearly*
`.admin-table th`'s, which differs only in using the failing `--text-muted` and a stray `11px`
literal. Unifying them is a two-property change that makes a true statement: a labelled field and a
labelled column are the same thing seen from two directions — one record's field, or one field
across many records. On the Users tab, where a provisioning form sits directly above the table it
writes into, the reader can see that "Name / Email / Role" above the inputs and "Name / Email / Role"
above the columns are the same three fields. Today they are set differently and that relationship is
invisible.

**Device 3 — the queue-head state declaration.** Each of the three operator queues declares its
backlog in its own head, as a status pill beside the heading: `12 events`, `No failures`,
`3 undelivered`. The rendition DLQ already does this (`Admin.tsx:468` renders a count pill in its
head); the Tonomo queue and the notification queue do not, though the data is already in hand —
`poisonTotal`, `renditionDlqOpenCount` and `notificationDeliveryCounts[view]` are all in component
state. This is the one place on the surface where a number genuinely is the content, and it is the
screen's operational job: an owner opening Admin should learn whether anything is broken without
scrolling three tables. It is a consistency fix and a use of data already present, not a new feature
— no new query, no new endpoint, no new state.

**Not used, deliberately:** numbered markers (`01 / 02 / 03`). The only genuine sequence on the whole
surface is the pipeline's five stages, and that one already numbers itself with real ordinals from
the data (`.admin-stage__order`). Everywhere else — form sections, integration cards, queues — the
order carries no meaning and numbering it would be decoration pretending to be structure.

### 4.2 The one aesthetic risk, and why it is worth taking

**The risk: removing the white card from every form and provisioning section.**

Concretely, `.create-project__section` (app.css:1020), `.project-fields__section--readonly`
(:1023), `.admin-provision` (:944), `.admin-directory-form` (:983) and `.admin-agent-form` (:984)
all lose `border: 1px solid var(--border-hairline)` and `background: var(--paper-000)`. They sit
directly on `--bg-canvas` (`--paper-050`, `#faf8f2`), separated from each other by `--space-8` and
headed by the §4.1 rule. Seven bordered panels become one continuous sheet.

**Why it is a real risk.** Card borders are load-bearing when a page is scanned rather than read:
they tell the eye where a group ends without the eye having to parse anything. Removing them on a
page with seven groups risks the sections bleeding together, especially the Services checkbox grid
and the Team panel, which are visually busy. If the rhythm is not exact the page reads as an
undifferentiated wall.

**Why it is worth it.** It is what the design system actually says. `tokens/spacing.css`'s own
header comment reads: *"structure comes from rules and negative space, not from elevation."* The app
has been contradicting that on its densest screens since TB0. And it earns a real semantic:
**after this release, a border on this surface means "a bounded data object"** — a table, an
integration card, the hero's single required input, the danger zone. It stops meaning "a section
exists here", which was never information.

**How the risk is contained** — these are commitments, not hopes:

1. The section rule is 3px, the heaviest line on the page. It is unmistakably a divider.
2. Section separation is `--space-8` (64px), one full step above the largest intra-section gap
   (`--space-5`, 24px). The gap ratio is 2.7:1 and reads as a break, not as padding.
3. The three groups that genuinely are bounded objects **keep** their borders and `--paper-000`
   ground: the address hero (the one thing the form actually requires), the checklist and services
   grids (bounded sets of tiles, whose 1px cell rules read as a table), and the danger zone (whose
   oxblood-tinted border is the warning). So the page still has anchors.
4. §10.2 makes it release-blocking: the New Shoot page is reviewed live at all three viewports and,
   if section boundaries are not legible at a glance at 1440×900, the borders come back on
   `.create-project__section` only. That is a one-line reversal and the plan authorises it in
   advance so nobody has to renegotiate mid-build.

### 4.3 Colour discipline

The palette does not expand. What changes is that signal colours stop being used for anything that
is not a signal, and muted grey stops being used for text.

| Role | Today | After | Why |
|---|---|---|---|
| Body and secondary text | `--text-secondary` | unchanged | 9.2:1, correct |
| Labels, table headers, captions, hints, placeholders, empty-state copy | `--text-muted` (3.6:1) | `text-foreground-secondary` | E-16 — nine sites, all failing 4.5:1 |
| Focus | four different treatments (E-11, E-12) | `--focus-ring` at `--border-width-bold`, offset 2 — one treatment everywhere | E-11, E-12 |
| Positive state (connected, active, delivered) | `--signal-positive` | unchanged — **plus** a non-colour cue on every pill and on row selection | E-17, E-18 |
| Neutral state (inactive, disconnected, not configured) | `--text-muted` at 3.6:1 | `text-foreground-secondary` on `bg-surface-sunken` with `border-border` — filled, where the signal variants stay outlined | E-16, E-17 |
| Field ground | `--paper-050` (canvas) inside `--paper-000` sections | `--field-bg` (`--paper-000`) on the canvas section | E-37 — forced by §4.2 |
| Caution (expired, pending) | `--signal-caution` | unchanged | correct |
| Critical (errors, failures, danger zone, the duplicate-email warning) | `--signal-critical`, and one undefined `--signal-negative` | `text-destructive` (= `--signal-critical`) everywhere, E-6 fixed | E-6 |
| The pipeline ordinal | `--signal-positive` at 24px | `text-foreground-secondary`, `[font:var(--type-h3)]` | E-19 — an index is not a state |
| Section grounds | `--paper-000` cards | `--bg-canvas`, ruled | §4.2 |
| Bounded-object grounds (tables, integration cards, hero, tiles) | `--paper-000` | unchanged | §4.2's new semantic |

**And one removal.** Per the "take one thing off" rule: **the `.button__google` disc goes** (E-14).
It is a hand-drawn "G" in Arial on an 18px circle, sitting next to a button that already says
"Continue with Google". It is the only non-brand typeface on the surface, it is not Google's actual
mark, and deleting it removes both a visual defect and a legal ambiguity in one line. The button
keeps its label, its full width and its position; the panel gets quieter, which is right for the one
screen in the app that is a door rather than a desk.

**Not removed, deliberately:** the `.signin::before` pinwheel (app.css:884) — a rotated radial
pattern at `opacity: .045`. It is the brand's own device, it is the only atmosphere on an otherwise
bare screen, and at 4.5% it costs nothing. It stays exactly as it is.

---

## 5. The target visual system

Every class string below is final. The builder types these; it does not derive them. Where a string
is long enough to be reused, it is given a name and a home file, and the name is what appears in the
JSX afterwards.

### 5.1 Edits to shipped primitives

**Five** existing files change — `input.tsx`, `field.tsx`, `eyebrow.tsx`, `select.tsx` and
`button.tsx`. *(Corrected from "four", 2026-09-02: the section always specified five and §6.1 always
listed five; only this sentence said four.)* Each edit is bounded and each is justified by an
evidence entry.

**`components/ui/input.tsx` — replace the class string, export it, add the states it never had.**

The file becomes:

```tsx
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The shared field box: input, textarea and native select all render this geometry.
 * min-h 38px is TB8-01's retained legacy control height; the 44px at <=720px is a
 * 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token.
 */
const FIELD_BOX =
  "w-full min-h-[38px] max-[720px]:min-h-[44px] " +
  "border-solid border-[length:var(--border-width-hair)] border-border rounded-[var(--radius-sm)] " +
  "bg-[var(--field-bg)] text-foreground px-[10px] py-[8px] " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] " +
  "placeholder:text-foreground-secondary " +
  "transition-[border-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "hover:not-disabled:border-border-hover " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 " +
  "aria-invalid:border-destructive " +
  "disabled:bg-surface-sunken disabled:text-foreground-secondary disabled:cursor-not-allowed " +
  "read-only:bg-surface-sunken read-only:text-foreground-secondary";

function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" className={cn(FIELD_BOX, className)} {...props} />;
}

export { Input, FIELD_BOX };
```

Four changes, each with its reason:

1. **`quincy-input` is gone.** E-38 establishes that `Input` has one product consumer, so the class
   and both legacy rules (app.css:953-958) retire together (§7 case (a)). Keeping the class while
   deleting the rules would leave a hook nothing needs; keeping the rules would keep E-11 alive.
2. **`focus-visible:outline-*` added.** E-11: `Input` currently has no ring of its own and inherits
   its focus affordance from the rule being deleted. The four utilities are exactly
   `buttonClasses()`'s, so a focused field and a focused button now ring identically.
3. **`aria-invalid:border-destructive` added**, replacing `app.css:958`. Tailwind v4 ships the
   `aria-invalid:` variant; no plugin needed.
4. **`bg-[var(--field-bg)]` replaces `bg-[var(--paper-050)]`**, and `text-foreground` replaces
   `text-[var(--text-primary)]`. E-37 and §4.2: the section beneath the field is now
   `--paper-050`, so the field must be `--paper-000` to read as a field at all. `--field-bg` is the
   token the design system defines for exactly this, and it resolves to `--paper-000`.
   `border-border` likewise replaces the raw `border-[var(--border-hairline)]` — same value, correct
   role name (criterion 5).

`ProjectFields.tsx`'s four Client fields are the only currently-rendered consumers, so this is also
the release that finally gives them a visible focus ring.

**`components/ui/field.tsx` — one token normalisation.** `FieldError`'s
`[font:var(--weight-regular)_12px/1.5_var(--font-sans)]` becomes
`[font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)]`
(E-30). `--text-xs` is 12px and `--leading-normal` is 1.5: computed output is byte-identical.
Nothing else in the file changes — `Field`, `FieldGroup` and `FieldLabel` are already correct and
already match `.admin-field` property-for-property (E-4).

**`components/ui/eyebrow.tsx` — add `data-slot`.**

```tsx
<span
  data-slot="eyebrow"
  className={cn("[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-widest)] text-foreground-secondary", className)}
  {...props}
/>
```

Every other primitive in `ui/` carries a `data-slot`; `Eyebrow` was the omission. It also matters
here for a concrete reason: `ProjectFields.dom.test.tsx:55-62` finds a section by
`querySelectorAll(".ey")`, and once the in-scope eyebrows stop carrying `.ey` that query needs a
replacement hook. `[data-slot="eyebrow"]` is that hook, and unlike a class it cannot be mistaken for
a styling handle. Zero visual change; the two existing consumers (`Dashboard.tsx`, `Modal.tsx`) are
unaffected.

**`components/ui/select.tsx` — fix the comment on line 92.**
`/* 44px — WCAG 2.5.8 minimum target */` becomes
`/* 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token */` (E-31). A comment-only
change; the class string is untouched. It is included because this release writes the same comment
at six new sites and leaving one contradictory copy in the codebase guarantees the wrong citation
gets copied forward.

**`components/ui/button.tsx` — one addition to `BASE`.** Insert `max-[720px]:min-h-[44px]`
immediately after `min-h-[38px]`, with the standard comment above the constant. §2.1a: desktop
geometry is unchanged, touch geometry conforms, and this matches `Modal.tsx:93`'s shipped
precedent. No variant changes, no colour changes, no new `!`.

### 5.2 New primitives in `components/ui/`

Six new files. None is generated by the shadcn CLI; each is hand-written in the same shape as
`button.tsx` and `field.tsx` — a plain constant map, no `cva`, `data-slot` on the root.

**`ui/table.tsx` — the table system.** This is the single largest piece of the release, because it
carries both the responsive redesign (§5.6) and the header-association fix (E-9).

```tsx
import * as React from "react";
import { cn } from "@/lib/utils";

/* Explicit ARIA roles are mandatory, not decorative: at <=720px the table switches to
   display:block, which strips the native table semantics the roles then restore. */

function TableWrap({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="table-wrap"
      className={cn(
        "w-full min-[721px]:overflow-x-auto",
        "min-[721px]:border-solid min-[721px]:border-[length:var(--border-width-hair)] min-[721px]:border-border min-[721px]:bg-card",
        className,
      )}
      {...props}
    />
  );
}

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <table
      role="table"
      data-slot="table"
      className={cn(
        "w-full border-collapse",
        "min-[721px]:min-w-[820px]",
        "max-[720px]:block",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead role="rowgroup" data-slot="table-head" className={cn("max-[720px]:sr-only", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      role="rowgroup"
      data-slot="table-body"
      className={cn("max-[720px]:block min-[721px]:[&>tr:last-child>td]:border-b-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      role="row"
      data-slot="table-row"
      className={cn(
        "max-[720px]:block max-[720px]:mb-[var(--space-4)] max-[720px]:p-[var(--space-4)]",
        "max-[720px]:border-solid max-[720px]:border-[length:var(--border-width-hair)] max-[720px]:border-border max-[720px]:bg-card",
        className,
      )}
      {...props}
    />
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      role="columnheader"
      scope="col"
      data-slot="table-header"
      className={cn(
        "px-[var(--space-4)] py-[12px] text-left align-bottom",
        "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary",
        "[border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      role="cell"
      data-slot="table-cell"
      className={cn(
        "align-middle text-foreground-secondary",
        "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]",
        "min-[721px]:px-[var(--space-4)] min-[721px]:py-[13px]",
        "min-[721px]:[border-bottom-style:solid] min-[721px]:border-b-[length:var(--border-width-hair)] min-[721px]:border-b-border",
        "[&>strong]:text-foreground [&>strong]:font-[var(--weight-regular)]",
        // Stacked-card mode: the column name is restated from the cell's own data-label.
        "max-[720px]:block max-[720px]:px-0 max-[720px]:py-[var(--space-2)]",
        "max-[720px]:before:content-[attr(data-label)] max-[720px]:before:block max-[720px]:before:mb-[var(--space-1)]",
        "max-[720px]:before:[font:var(--type-eyebrow)] max-[720px]:before:uppercase",
        "max-[720px]:before:tracking-[var(--tracking-wide)] max-[720px]:before:text-foreground-secondary",
        className,
      )}
      {...props}
    />
  );
}

export { TableWrap, Table, TableHead, TableBody, TableRow, TableHeader, TableCell };
```

Notes the builder must not lose:

- **`scope="col"` is baked into `TableHeader`**, so E-9 cannot regress by omission at a call site.
- The `[&>strong]` pair reproduces `app.css:964` (`.admin-table td strong` — primary colour, weight
  400) so `<strong>` inside cells keeps working without a wrapper component.
- The `role` attributes are unconditional. At ≥721px they duplicate the native semantics
  harmlessly; at ≤720px they are the only semantics left. This is the standard technique and it is
  the reason the stacked layout in §5.6 is safe to ship.
- The action column passes `className="text-right"` at the call site; there is no `TableActionCell`
  variant, because at ≤720px right-alignment is wrong and the override needs to be
  `min-[721px]:text-right` — see §5.6.

**`ui/tabs.tsx` — a conformant tab strip.** Fixes E-10 and E-39 for both strips at once.

```tsx
import * as React from "react";
import { cn } from "@/lib/utils";

type TabItem = { value: string; label: React.ReactNode; count?: number };

const TAB_BASE =
  "relative -mb-[var(--border-width-hair)] inline-flex items-center gap-[var(--space-2)] " +
  "min-h-[38px] max-[720px]:min-h-[44px] px-0 pt-[var(--space-2)] pb-[11px] " + // 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token
  "bg-transparent border-0 [border-bottom-style:solid] border-b-[length:var(--border-width-mid)] " +
  "cursor-pointer [font:var(--type-label)] uppercase tracking-[var(--tracking-wide)] " +
  "transition-[color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2";

const TAB_IDLE = "border-b-transparent text-foreground-secondary hover:text-foreground hover:border-b-border-hover";
const TAB_SELECTED = "border-b-primary text-foreground";

const TAB_COUNT = "[font-variant-numeric:tabular-nums] [font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] text-foreground-secondary";

function TabStrip({ items, value, onValueChange, idPrefix, label, className }: {
  items: TabItem[];
  value: string;
  onValueChange: (next: string) => void;
  idPrefix: string;
  label: string;
  className?: string;
}) {
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});

  function move(delta: number) {
    const index = items.findIndex((item) => item.value === value);
    if (index < 0) return;
    const next = items[(index + delta + items.length) % items.length];
    onValueChange(next.value);
    refs.current[next.value]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
    else if (event.key === "Home") { event.preventDefault(); onValueChange(items[0].value); refs.current[items[0].value]?.focus(); }
    else if (event.key === "End") { const last = items[items.length - 1]; event.preventDefault(); onValueChange(last.value); refs.current[last.value]?.focus(); }
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      data-slot="tab-strip"
      onKeyDown={onKeyDown}
      className={cn(
        "flex flex-wrap gap-[var(--space-5)]",
        "[border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border",
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${item.value}`}
            // Only the selected panel is mounted, so only the selected tab may claim one.
            // `undefined` omits the attribute entirely; `""` would emit a broken IDREF. (§8)
            aria-controls={selected ? `${idPrefix}-panel-${item.value}` : undefined}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            ref={(node) => { refs.current[item.value] = node; }}
            onClick={() => onValueChange(item.value)}
            className={cn(TAB_BASE, selected ? TAB_SELECTED : TAB_IDLE)}
          >
            {item.label}
            {/* A whitespace-only text node between flex items is discarded by flex layout, so this is
                visually inert — the `gap-[var(--space-2)]` above still supplies the separation. It
                exists so `textContent` and the accessible name read "DLQ 0", not "DLQ0". */}
            {typeof item.count === "number" ? <>{" "}<span className={TAB_COUNT}>{item.count}</span></> : null}
          </button>
        );
      })}
    </div>
  );
}

export { TabStrip, TAB_BASE, TAB_IDLE, TAB_SELECTED };
export type { TabItem };
```

*(The `{" "}` separator was added 2026-09-02, slice-3 review. Without it the count abuts the label
in the accessible name and in `textContent`, which is how the legacy strip never read — `Admin.tsx:469`
rendered `{view.toUpperCase()} ({count})`, with a space and parentheses. `Admin.dom.test.tsx:351`
caught it by parsing `label.split(" ")[0]`, but the assertion was only the messenger: "DLQ0" is what
a screen reader announced. The fix is in the primitive, not the test.)*

Design decisions closed here, so the builder does not have to choose:

- **`type="button"` is mandatory.** The notification-delivery filter strip sits on a page with live
  forms; an untyped `<button>` inside a `<form>` submits it. It is not inside a form today, but the
  component must be safe wherever it is used.
- **Automatic activation**, not manual. Arrow keys move selection *and* focus in one step. The APG
  permits this when revealing a panel is cheap; both strips here are cheap — the administration
  panels are already-mounted local state, and the delivery filter is a client-side view switch over
  data already fetched. Manual activation (arrow to move focus, Enter to select) would add a second
  keystroke to the operator's most common action for no benefit.
- **`-mb-[var(--border-width-hair)]`** pulls each tab's 1.5px underline down over the strip's own
  1px rule, so the selected indicator sits *on* the line rather than above it. This restores the
  underline the administration strip lost to `app.css:942` (E-39).
- The count slot replaces `.ctab .cnt` (app.css:682) and keeps its `tabular-nums`, but takes
  `text-foreground-secondary` rather than the failing `--text-muted`.

**`ui/status-pill.tsx`.**

```tsx
const PILL_BASE =
  "inline-flex items-center whitespace-nowrap px-[var(--space-2)] py-[4px] " +
  "rounded-[var(--radius-pill)] border-solid border-[length:var(--border-width-hair)] " +
  "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] uppercase tracking-[var(--tracking-wide)]";

const PILL_TONE: Record<StatusTone, string> = {
  positive: "text-signal-positive border-signal-positive/45 bg-signal-positive/8",
  caution:  "text-signal-caution border-signal-caution/45 bg-signal-caution/8",
  critical: "text-signal-critical border-signal-critical/45 bg-signal-critical/8",
  info:     "text-signal-info border-signal-info/45 bg-signal-info/8",
  neutral:  "text-foreground-secondary border-border bg-surface-sunken",
};

type StatusTone = keyof typeof PILL_TONE;

function StatusPill({ tone = "neutral", className, ...props }: React.ComponentProps<"span"> & { tone?: StatusTone }) {
  return <span data-slot="status-pill" className={cn(PILL_BASE, PILL_TONE[tone], className)} {...props} />;
}

export { StatusPill, PILL_BASE };
export type { StatusTone };
```

*(The component, the `StatusTone` type and the exports were added 2026-09-02, Sol round 2 new
finding 4. The section previously specified only the two constants while §6.1 required a
`StatusPill` export, leaving the builder to invent the API — and "the builder invents an API" is the
one thing this plan's exact-code style exists to prevent. `tone` defaults to `neutral` so a call
site that forgets it degrades to the safe, non-signalling appearance rather than a crash;
`React.ComponentProps<"span">` forwards `role`, `aria-*`, `title` and `children` unchanged, which is
what the archived badge and the six `.admin-status` sites need.)*

`--color-signal-{positive,caution,critical,info}` are real `@theme` entries
(`tokens/tailwind.css`), so the `/45` and `/8` opacity modifiers are Tailwind-native and produce the
same result the current `color-mix(…45%…)` / `(…8%…)` declarations do (app.css:968, :970, :971).
The neutral tone is the substantive change: `text-foreground-secondary` fixes the 3.6:1 failure
(E-16, E-17) and `bg-surface-sunken` gives it a *filled* ground where the four signal tones are
tinted-transparent — a difference in fill, not only in hue. Size moves from the off-scale `10px` to
`--text-2xs` (11px), E-15.

Mapping from the legacy modifiers, fixed here so no call site has to decide:
`active` and `connected` → `positive`; `expired` → `caution`; `error` → `critical`;
`inactive`, `disconnected` and `not-configured` → `neutral`. There is no `info` consumer on this
surface; the tone exists because `--signal-info` is a defined role and the delivery queue is the
obvious next consumer.

**`ui/textarea.tsx`.**

```tsx
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(FIELD_BOX, "min-h-[96px] resize-y leading-[var(--leading-normal)]", className)}
      {...props}
    />
  );
}
```

`min-h-[96px]` is deliberately the literal, not `min-h-[var(--space-9)]`, even though
`spacing.css:18` sets `--space-9: 96px`: this is a content height for a text box, not a step on the
spacing grid, and binding it to the spacing scale would make a future rescale of `--space-9` silently
resize every textarea. **The exact string in the sample is the one to write.** *(Corrected
2026-09-02: the round-1 text gave the literal in the code and then told the builder to write the
variable form in the very next sentence — two incompatible instructions for one class.)* `resize-y` only —
horizontal resize breaks the section grid. The one consumer is the Notes field
(`ProjectFields.tsx:126`), which today gets `rows={5}` plus `app.css:1043`; `rows` stays, and the
`min-h` guarantees the box does not collapse under a short `rows` value on a narrow column.

**`ui/native-select.tsx`.**

```tsx
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return <select data-slot="native-select" className={cn(FIELD_BOX, "pe-[var(--space-2)]", className)} {...props} />;
}
```

**A deliberate rejection, recorded so Sol can check the reasoning rather than the omission:** the
three `<select>` elements on this surface (provisioning Role, inline Role per user row, and the
directory forms' agency picker) are **not** converted to `ui/select.tsx`'s Base UI listbox. Three
reasons. (1) `Select`'s trigger is a `<button>` and two of the three selects sit inside `<form>`
elements with live mutation handlers — an untyped or mis-portalled trigger there is a real
submit-path risk, and `Admin.dom.test.tsx:140` asserts `.admin-stage button` is empty, which shows
how easily a hidden `<button>` appears where none is expected. (2) A portalled popup anchored inside
a horizontally-scrolling table cell is a positioning problem TB8-02's contract was not written for.
(3) On a phone, a native `<select>` gets the platform picker, which is better for an operator than
any listbox this repo would build. The native chevron is kept — it is the platform's own affordance
and drawing a replacement would add chrome for nothing. `pe-[var(--space-2)]` gives the chevron
room.

**`ui/checkbox.tsx`.**

```tsx
const CHECKBOX_INPUT =
  "size-[18px] shrink-0 m-0 accent-[var(--accent)] cursor-pointer " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 " +
  "disabled:cursor-not-allowed";

/* A bordered, selectable tile: the services grid and the create-mode team checklist. */
const CHECK_TILE =
  "flex items-start gap-[var(--space-3)] cursor-pointer " +
  "min-h-[var(--space-7)] p-[12px] bg-card text-foreground-secondary " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] " +
  "transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "hover:bg-secondary has-[:checked]:bg-surface-sunken " +
  "has-[:focus-visible]:outline-[length:var(--border-width-bold)] has-[:focus-visible]:outline-solid " +
  "has-[:focus-visible]:outline-ring has-[:focus-visible]:-outline-offset-2 " +
  "has-[:disabled]:cursor-default has-[:disabled]:text-foreground-secondary " +
  "has-[:disabled]:bg-surface-sunken has-[:disabled]:hover:bg-surface-sunken";

/* A single row toggle: the impersonation switch and the per-stage active checkbox. */
const TOGGLE_ROW =
  "flex items-center gap-[var(--space-2)] cursor-pointer " +
  "min-h-[38px] max-[720px]:min-h-[44px] text-foreground-secondary " + // 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]";

function Checkbox({ className, ...props }: React.ComponentProps<"input">) {
  return <input type="checkbox" data-slot="checkbox" className={cn(CHECKBOX_INPUT, className)} {...props} />;
}

export { Checkbox, CHECKBOX_INPUT, CHECK_TILE, TOGGLE_ROW };
```

*(The component and the exports were added 2026-09-02, Sol round 2 new finding 4 — §6.1 required a
`Checkbox` export that the section never defined. `type="checkbox"` is set before `{...props}` so a
call site cannot accidentally change it, while every other prop — `checked`, `onChange`,
`disabled`, `aria-label`, `id` — forwards untouched. `CHECK_TILE` and `TOGGLE_ROW` stay bare string
constants rather than becoming components: they go on the `<label>`, and wrapping the label would
break `ProjectFields.dom.test.tsx:59`'s `label.create-project__check` and §7 row 111's
requirement that the class stay on the `<label>` itself.)*

`--accent` is `--ink-900` (`tokens/colors.css:55`), so a checked box is brand ink rather than the
browser's blue — the one property that makes a native checkbox look like it belongs here. Today's
`accent-color: var(--ink-900)` at `app.css:1036` already does this; the change is that the box grows
from **15px to 18px**, which is the smallest size that reads as a control rather than a speck at
arm's length and still fits the tile's 12px padding. `min-h-[var(--space-7)]` is 48px, replacing the
off-grid `54px` of `app.css:1034`, and `gap-[var(--space-3)]` (12px) replaces the off-grid `10px` of
the same rule (E-15). The tile's focus ring is drawn on the tile via `has-[:focus-visible]` with a
**negative** outline offset, so the ring sits inside the 1px cell grid instead of overlapping the
neighbouring tile. `has-[:disabled]:bg-surface-sunken` reproduces `app.css:1026-1028`, which is how
a read-only Services grid renders today.

**`ui/tabs.tsx` and `ui/table.tsx` add no dependency.** Both are plain React over native elements.

### 5.3 New compositions in `components/quincy/`

**`quincy/SectionHead.tsx` — Device 1 and the page's reading order.**

```tsx
function SectionHead({ eyebrow, id, children, actions, className }: {
  eyebrow?: React.ReactNode;
  id?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="section-head"
      className={cn(
        "flex flex-wrap items-end justify-between gap-[var(--space-4)]",
        "[border-top-style:solid] border-t-[length:var(--border-width-rule)] border-t-primary",
        "pt-[var(--space-4)] mb-[var(--space-5)]",
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow ? <Eyebrow className="block mb-[var(--space-2)]">{eyebrow}</Eyebrow> : null}
        <h2 id={id} className="m-0 [font:var(--type-h3)] tracking-[var(--tracking-tight)] text-foreground text-pretty">
          {children}
        </h2>
      </div>
      {actions ? <div className="flex items-center gap-[var(--space-3)] shrink-0">{actions}</div> : null}
    </div>
  );
}
```

This one component replaces four separate legacy head treatments —
`.admin-section__head` + its 34px `h2` (app.css:943-944), `.create-project__section-head` + its 29px
`h2` (:1021-1022), `.danger-zone h2` at 29px (:1201) and the ad-hoc `<div className="ey">` +
`<h2 className="serif">` pairs in `ProjectFields.tsx`. All four collapse to `--type-h3` (28px),
which is the scale step those values were reaching for (E-15). `items-end` reproduces
`.admin-section__head`'s `align-items: flex-end`, so a "Refresh" button still baselines with the
heading. `text-pretty` prevents a one-word last line on "Studio controls" at 390px.

The 3px `border-t-primary` is the section rule of §4.1. It is worth stating plainly what it is not:
it is not a decorative divider dropped in for texture. It is the *only* thing separating one part of
the record from the next once the card borders come off, so it is the heaviest line on the page and
it sits above the eyebrow rather than under the heading — the rule opens the section, the way a rule
opens a column in a printed ledger.

**`quincy/EmptyState.tsx` — reused verbatim from TB8-01 §10.2/§10.3's specification.**

```tsx
function EmptyState({ title, tone = "empty", children, className, ...props }: {
  title: React.ReactNode;
  tone?: "empty" | "error";
  children?: React.ReactNode;
  className?: string;
} & React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "px-[var(--space-6)] py-[var(--space-8)]",
        tone === "error"
          ? "text-left ps-[var(--space-5)] [border-left-style:solid] border-l-[length:var(--border-width-rule)] border-l-destructive"
          : "text-center",
        className,
      )}
      {...props}
    >
      <strong className={cn(
        "block mb-[var(--space-3)] font-[var(--weight-regular)] tracking-[var(--tracking-tight)]",
        tone === "error" ? "[font:var(--type-h3)] text-destructive" : "[font:var(--type-h3)] text-foreground-secondary",
      )}>
        {title}
      </strong>
      {children ? (
        <div className="[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">
          {children}
        </div>
      ) : null}
    </div>
  );
}
```

Three things are settled here. **Padding is `--space-8` (64px), not `--space-9` (96px)** — TB8-01
§10.3 established that 96px of vertical air around two lines of text reads as a broken layout rather
than as restraint, and the states on this surface are frequent (eight in `Admin.tsx` alone).
**The title drops from `--type-h2` (36px) to `--type-h3` (28px)** — an empty table is not the loudest
thing on the page. **The error tone is distinguished by shape first**, a 3px oxblood rule down the
left edge with the text left-aligned, so it is legible without colour perception; TB8-01 §10.2
specified exactly this. The `role` (`status` or `alert`) is **not** set by the component — it is
passed through by the call site, because the choice between polite and assertive is the caller's
behavioural decision and this release must not change any of them (§8).

**`quincy/Notice.tsx` — the inline message block.**

```tsx
const NOTICE_BASE =
  "p-[var(--space-3)] border-solid border-[length:var(--border-width-hair)] " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]";

const NOTICE_TONE = {
  critical: "border-signal-critical/35 bg-signal-critical/7 text-signal-critical",
  positive: "border-signal-positive/35 bg-signal-positive/8 text-signal-positive",
};

type NoticeTone = keyof typeof NOTICE_TONE;

function Notice({ tone = "critical", className, ...props }: React.ComponentProps<"div"> & { tone?: NoticeTone }) {
  return <div data-slot="notice" className={cn(NOTICE_BASE, NOTICE_TONE[tone], className)} {...props} />;
}

export { Notice, NOTICE_BASE, NOTICE_TONE };
export type { NoticeTone };
```

Reproduces `app.css:891` (`.notice`) and `app.css:1208` (`.danger-zone__notice`) exactly, minus the
baked-in `margin-top: var(--space-4)` — spacing belongs to the call site, and three of the eleven
in-scope call sites currently fight that margin with an inline `style`. Two tones cover every
in-scope use.

**`Notice` never sets `role`.** `role="alert"` / `role="status"` is forwarded from the call site
through `{...props}`, unchanged, exactly as the `EmptyState` paragraph above requires and §8
guards. `tone` defaults to `critical` because ten of the eleven in-scope notices are errors; the
one positive is the danger zone's success message and it passes `tone="positive"` explicitly.

*(The component, the `NoticeTone` type and the exports were added 2026-09-02, Sol round 2 new
finding 4: §6.1 required a `Notice` export that this section never defined.)*

**`quincy/QuincySelectField.tsx` and `quincy/QuincyTextareaField.tsx`.** These exist so the Role
select and the Notes textarea get the same error wiring the Client inputs already have (E-5), rather
than a second hand-rolled pattern. Each is `src/components/quincy/QuincyField.tsx`'s structure with
one substitution — `Input` → `NativeSelect` / `Textarea`:

```tsx
// src/components/quincy/QuincySelectField.tsx
import * as React from "react";

import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";

type QuincySelectFieldProps = Omit<React.ComponentProps<typeof NativeSelect>, "id"> & {
  id: string;
  label: React.ReactNode;
  error?: React.ReactNode;
};

function QuincySelectField({ id, label, error, "aria-describedby": ariaDescribedby, "aria-errormessage": ariaErrormessage, children, ...selectProps }: QuincySelectFieldProps) {
  const errorId = `${id}-error`;
  const describedBy = error ? [ariaDescribedby, errorId].filter(Boolean).join(" ") : ariaDescribedby;

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <NativeSelect
        id={id}
        aria-describedby={describedBy || undefined}
        aria-errormessage={error ? errorId : ariaErrormessage}
        {...selectProps}
      >
        {children}
      </NativeSelect>
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

export { QuincySelectField };
export type { QuincySelectFieldProps };
```

```tsx
// src/components/quincy/QuincyTextareaField.tsx
import * as React from "react";

import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

type QuincyTextareaFieldProps = Omit<React.ComponentProps<typeof Textarea>, "id"> & {
  id: string;
  label: React.ReactNode;
  error?: React.ReactNode;
};

function QuincyTextareaField({ id, label, error, "aria-describedby": ariaDescribedby, "aria-errormessage": ariaErrormessage, ...textareaProps }: QuincyTextareaFieldProps) {
  const errorId = `${id}-error`;
  const describedBy = error ? [ariaDescribedby, errorId].filter(Boolean).join(" ") : ariaDescribedby;

  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        aria-describedby={describedBy || undefined}
        aria-errormessage={error ? errorId : ariaErrormessage}
        {...textareaProps}
      />
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

export { QuincyTextareaField };
export type { QuincyTextareaFieldProps };
```

Note the one structural difference from `QuincySelectField`: **no `children` destructure**. A
textarea's value is a prop, so `...textareaProps` carries everything, and `rows={5}` on the Notes
call site (§5.14) flows through it untouched.

Three things are load-bearing and easy to get wrong:

1. **`QuincySelectField` wraps `ui/native-select.tsx`, not `ui/select.tsx`.** The repo already
   exports a `Select` (`ui/select.tsx:28`) — a Base UI listbox taking `options`/`ariaLabel`, whose
   trigger is a `<button>`. It accepts no `id`, so `FieldLabel htmlFor={id}` would point at nothing,
   and it takes no `<option>` children, so §5.7's `<QuincySelectField>…<option></QuincySelectField>`
   would not compile against it. The two Admin selects (`Admin.tsx:424`, `:437`) are native
   `<select>` elements today and **stay native**; converting them to the Base UI listbox is a
   behaviour change this release does not authorize.
2. **`children` must be destructured explicitly** in `QuincySelectField` and passed inside
   `<NativeSelect>`. Left in `...selectProps` it still works by spread, but the explicit form is what
   makes the `<option>` contract visible at the call site.
3. **`errorId` is emitted whether or not there is an error**, exactly as `QuincyField.tsx:13` does;
   `FieldError` returns `null` for empty children (`ui/field.tsx:35`), so the id simply resolves to
   nothing. Do not add a conditional — `QuincyField.dom.test.tsx` pins this shape.

*(Written out 2026-09-02. The round-1 text said only "mirror `QuincyField.tsx` line for line", which
named no path, did not say which control primitive to wrap, and left the `ui/select.tsx` name
collision for the builder to walk into — the same class of gap Sol round 2 finding 4 raised against
`StatusPill`, `Checkbox` and `Notice`.)*

### 5.4 The page frame, and the two `!` sites

`.page` (app.css:138) survives for out-of-scope consumers (§7 case (b)) and its unlayered
`max-width: 1480px` therefore beats any ordinary utility on an element that still carries the class.
Both in-scope page widths must be narrower than 1480, so both need case (c):

```tsx
/* ! required: .page (app.css:138) is unlayered and its max-width wins over any utility. */
<main className="page !max-w-[1280px]">      {/* Admin.tsx — replaces .admin-page (app.css:940) */}
<main className="page !max-w-[1080px]">      {/* CreateProject.tsx and EditProject.tsx — replaces .create-project (app.css:1002) */}
```

These are the only two `!` sites this release adds. Every other in-scope element either keeps its
legacy class untouched (case b, no utility fights it) or drops the class entirely (case a).

**`.pagehead` comes off the in-scope headers; its `app.css` rules survive for out-of-scope
consumers.** This is §7 case **S**, recorded at rows 6 and 7. `className="serif"` comes off those
`<h1>`s at the same time: `--type-h1` already carries the display family (E-40), so that deletion is
zero-pixel. The `<div className="ey" style={{ marginBottom: 14 }}>` above each `<h1>` becomes
`<Eyebrow className="block mb-[var(--space-3)]">`, replacing an off-grid inline literal with a
token (E-20).

**The exact replacement, `PAGE_HEAD`, identical on all four in-scope page screens.** The wrapper
`<div>` becomes a `<header>` — see §8 for why the element change is required and not incidental —
and carries a one-for-one transcription of `app.css:139`, plus the `<h1>` transcription of `:140`
that row 7 retires:

```tsx
<header className="flex flex-wrap items-end justify-between gap-[var(--space-6)] mb-[var(--space-6)]">
  <div>
    <Eyebrow className="block mb-[var(--space-3)]">Production desk</Eyebrow>
    <h1 className="[font:var(--type-h1)] tracking-[var(--tracking-tight)]">Edit shoot</h1>
  </div>
  {/* the screen's own trailing control, unchanged */}
</header>
```

Every declaration of `app.css:139` is present: `display:flex` → `flex`, `flex-wrap:wrap` →
`flex-wrap`, `align-items:flex-end` → `items-end`, `justify-content:space-between` →
`justify-between`, `gap:var(--space-6)` → `gap-[var(--space-6)]`, `margin-bottom:var(--space-6)` →
`mb-[var(--space-6)]`. The `mb-` is the one that matters most: `.pagehead`'s own `margin-bottom` was
silently carrying the following form's top spacing (E-28), and dropping the class without
transcribing that margin collapses the gap. `[font:var(--type-h1)] tracking-[var(--tracking-tight)]`
is `app.css:140` verbatim.

*(Added 2026-09-02, Sol round 2 new finding 1. Round 1's fix reconciled the prose but left §5.7's
exact Admin sample still emitting `<div className="pagehead">`, so the plan's own code contradicted
its own disposition. The replacement is now written out once, here, and §5.7/§5.13/§5.15 reference
it rather than each re-deriving it.)*

*(Corrected 2026-09-02, Sol round 1 correctness 2. This paragraph previously said `.pagehead` "is
kept as-is on all four page screens" and that "TB8-04 changes nothing about it", which contradicted
§7 rows 6/7, §8 and E-28. The resolution is **drop the class, keep the rules** — §1.2's deferral of
`.pagehead` is a deferral of **deleting the rule**, which stays for `ProjectWorkspace.tsx`,
`Dashboard.tsx` and `NotificationPreferences.tsx`; it was never a promise to keep the class on
screens this release rewrites. The one cost is `ProjectCollaborationPanel.dom.test.tsx:1020`'s
`.pagehead + .create-project__form` adjacency selector, which §9.4 retargets to
`header + .create-project__form` rather than weakening.)*

### 5.5 Sign-in

The quietest screen in the app, and the one that most needs to stay quiet. Structure and copy are
unchanged; the wrapper, panel and pinwheel keep their exact geometry.

| Element | Final classes |
|---|---|
| `<main>` (was `.signin`) | `min-h-screen grid place-items-center p-[var(--space-6)] bg-background relative overflow-hidden` — plus **`signin` retained as a non-styling hook** for `::before` (see below) |
| `<section>` (was `.signin__panel`) | `relative w-[min(100%,430px)] p-[var(--space-8)] max-[720px]:p-[var(--space-6)] bg-card border-solid border-[length:var(--border-width-hair)] border-border` |
| `<img>` (was `.signin__wordmark`) | `w-[min(238px,100%)] h-auto mb-[var(--space-8)]` |
| eyebrow | `<Eyebrow className="block mb-[var(--space-3)]">Portal access</Eyebrow>` |
| `<h1>` (was `.signin__title`) | `m-0 mb-[var(--space-4)] [font:var(--type-h1)] max-[720px]:[font:var(--type-h2)] tracking-[var(--tracking-tight)] text-foreground` |
| `<p>` (was `.signin__copy`) | `max-w-[32ch] mb-[var(--space-6)] [font:var(--weight-regular)_var(--text-base)/var(--leading-relaxed)_var(--font-sans)] text-foreground-secondary` |
| button | `buttonClasses("primary", { busy: isSubmitting, className: "w-full" })` |
| error (was `.notice`) | `<div role="alert" className={cn(NOTICE_BASE, NOTICE_TONE.critical, "mt-[var(--space-4)]")}>` |
| `<p>` (was `.signin__note`) | `mt-[var(--space-4)] [font:var(--type-eyebrow)] tracking-[var(--tracking-wide)] text-foreground-secondary` |

Three decisions:

1. **`clamp(38px, 6vw, 52px)` → `--type-h1` (48px), stepping to `--type-h2` (36px) at ≤720px**
   (E-15). The clamp existed to stop a 52px heading overflowing a 390px panel; an explicit step does
   the same thing on the scale instead of between its rungs, and 36px is a real token where 38 is
   not.
2. **The `.button__google` disc is deleted** — the `<span aria-hidden="true">G</span>` comes out of
   `SignIn.tsx:26` entirely, and `app.css:881` retires with it (§4.3, E-14). The button reads
   "Continue with Google", full width, unchanged in height and position.
3. **`.signin` stays on the `<main>` as a non-styling hook, and `app.css:884` (`.signin::before`)
   stays.** This is the one place the plan keeps a legacy rule for a *visual* reason rather than a
   deferral: the pinwheel is a `::before` on a background image, it is brand-owned, it is
   deliberately kept (§4.3), and reimplementing a rotated repeating background as arbitrary
   utilities would be longer, less readable and no more correct. `app.css:883` (`.signin`'s own box)
   **is** retired — the utilities above replace it — so the surviving rule is reduced to the
   pseudo-element alone. §7 records this as the one **partial** retirement, and the retirement gate
   in §7.0 expects `signin` to keep exactly one hit in `SignIn.tsx` and one selector in `app.css`.

### 5.6 The table system in use, and what happens at 390px

**The decision, stated plainly: TB8-04 implements the stacked-card responsive table the `data-label`
markup was written for, and drops the horizontal scroll below 721px.** E-7 established the markup
exists and nothing consumes it; E-8 established what ships instead. Neither preserving a
2.3-viewport pan nor deleting 25 `data-label` attributes is the right answer when the attributes
already name every column correctly.

| Viewport | Behaviour |
|---|---|
| ≥1081px | Full table. `min-w-[820px]` is inert because the container is wider. |
| 721–1080px | Full table, `min-w-[820px]` in effect, `TableWrap` scrolls horizontally. Unchanged from today. |
| ≤720px | Each row becomes a bordered card on `bg-card`: `<thead>` is `sr-only`, every `<td>` is a block that prints its own `data-label` as an eyebrow above its value, and `TableWrap` drops its border and its scroll. |

Three things make this safe rather than clever:

- **Semantics survive** because `role="table" / "rowgroup" / "row" / "columnheader" / "cell"` are
  unconditional on the components (§5.2). `display: block` removes the native roles; the explicit
  ones replace them at every breakpoint.
- **`<thead>` becomes `sr-only`, not `hidden`.** A screen-reader user still gets the column headers,
  and `scope="col"` still associates them. Using `display: none` would silently drop the header row
  from the accessibility tree.
- **`before:content-[attr(data-label)]` reads the attribute already in the DOM.** No new CSS rule is
  added to `app.css`, no `[data-label]` selector is created, and a cell with no `data-label` renders
  an empty `::before` box of zero height — so the pattern degrades to "value only" rather than
  breaking. Every in-scope `<td>` that renders in a stacked card gets a `data-label`; the audit in
  §7.0 counts them.
- **The action cell is the exception.** It takes `className="min-[721px]:text-right max-[720px]:pt-[var(--space-3)] max-[720px]:flex max-[720px]:flex-wrap max-[720px]:gap-[var(--space-3)]"` and
  `data-label` is deliberately omitted from it — "Actions" above two buttons is noise, and the
  column header is already `<span className="sr-only">Actions</span>`. Right-alignment is
  desktop-only; in a stacked card the buttons align left with the values above them. This also
  fixes E-33's missing gap at 1024px, since `gap-[var(--space-3)]` applies at every width via a
  separate `min-[721px]:gap-[var(--space-3)]` on the same cell.

**Row selection (E-18).** The selected agency row takes, in addition to the 6% wash:

```tsx
<TableRow
  data-selected={isSelected ? "true" : undefined}
  className="data-[selected]:bg-signal-positive/6 min-[721px]:data-[selected]:[border-left-style:solid] min-[721px]:data-[selected]:border-l-[length:var(--border-width-rule)] min-[721px]:data-[selected]:border-l-signal-positive max-[720px]:data-[selected]:border-signal-positive"
>
```

and its first cell renders `<span className="sr-only">Selected</span>` before the agency name. A 3px
olive rule down the row's leading edge at desk, the card's whole border turning olive in the hand,
and an announced word for a screen reader — three independent channels where there was one 6% tint.
`data-selected` replaces the `is-selected` class (which `app.css:986` retires with).

### 5.7 Administration — the page and its tab strip

`Admin.tsx:402-412` becomes:

```tsx
<main className="page !max-w-[1280px]">
  {/* §5.4's PAGE_HEAD, verbatim. This screen has no trailing control. */}
  <header className="flex flex-wrap items-end justify-between gap-[var(--space-6)] mb-[var(--space-6)]">
    <div>
      <Eyebrow className="block mb-[var(--space-3)]">Administration</Eyebrow>
      <h1 className="[font:var(--type-h1)] tracking-[var(--tracking-tight)]">Studio controls</h1>
    </div>
  </header>

  <TabStrip
    idPrefix="admin"
    label="Administration sections"
    items={availableTabs.map((tab) => ({ value: tab, label: TAB_LABELS[tab] }))}
    value={activeTab}
    onValueChange={(next) => setActiveTab(next as AdminTab)}
    // `admin-tabs` is a required hook, not paint — §7 row 26 (R) and §8.
    // Without it `Admin.dom.test.tsx:85` and `:289` select nothing and pass vacuously.
    className="admin-tabs mb-[var(--space-6)]"
  />
```

and each of the four panels becomes:

```tsx
<section
  className="admin-section"
  role="tabpanel"
  id="admin-panel-users"
  aria-labelledby="admin-tab-users"
  tabIndex={0}
>
```

`.admin-section` is retained as a **non-styling hook** — it has no `app.css` rule of its own, it is
already only a handle, and `Admin.dom.test.tsx:143` queries through it. `aria-labelledby` and `id`
close E-10; `tabIndex={0}` makes the panel focusable so Tab from the strip lands inside it, per the
APG. The four-item `TAB_LABELS` map (`users` → "Users", `directory` → "Directory", `pipeline` →
"Pipeline", `integrations` → "Integrations") is a module-level constant, not derived at render.

**The capability gate is untouched.** `availableTabs` is still computed exactly as at
`Admin.tsx:96-100` from `canManageUsers` / `canAdminBackend` / `canManageIntegrations`, the
`if (availableTabs.length === 0) return null;` guard at `:399` is unchanged, and `TabStrip` receives
the already-filtered array. §8 carries this as a named invariant because it is the one place where a
component swap sits directly on a capability computation.

### 5.8 Administration — Users

**The provisioning form** (`Admin.tsx:415-425`) loses its card (§4.2) and gains error wiring:

```tsx
<form
  onSubmit={provisionUser}
  className="grid gap-[var(--space-4)] items-end mb-[var(--space-6)]
             grid-cols-1
             min-[721px]:grid-cols-2
             min-[1081px]:grid-cols-[minmax(210px,1.25fr)_minmax(150px,0.85fr)_minmax(220px,1.1fr)_minmax(130px,0.7fr)_auto]"
>
  <div className="self-center min-[721px]:col-span-full min-[1081px]:col-span-1">
    <Eyebrow className="block mb-[var(--space-2)]">Provision user</Eyebrow>
    <p className="m-0 max-w-[38ch] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">
      …unchanged copy…
    </p>
  </div>

  <QuincyField id="admin-provision-name" label="Name" value={…} onChange={…}
    aria-invalid={Boolean(formErrors.name)} error={formErrors.name} />
  <QuincyField id="admin-provision-email" label="Email" type="email" value={…} onChange={…}
    aria-invalid={Boolean(formErrors.email)} error={formErrors.email} />
  <QuincySelectField id="admin-provision-role" label="Role" value={…} onChange={…}>
    …unchanged <option> list…
  </QuincySelectField>

  <button type="submit" className={buttonClasses("primary", { busy: isProvisioning, className: "max-[720px]:w-full" })}>
    …unchanged label…
  </button>
</form>
```

*(Copy corrected 2026-09-02, slice-3 review. The sample above previously read "Add a teammate".
That string was this plan's invention — the screen ships `<div className="ey">Provision user</div>`
at `Admin.tsx:418` — and the builder transcribed it literally and flagged it, which was the right
call. This is a visual convergence release — it changes no copy. Same defect, same fix as §5.13's
hero eyebrow.)*

What this buys: the two `<small>` errors at `Admin.tsx:422-423` become `FieldError` elements with
`role="alert"`, referenced by `aria-describedby` and `aria-errormessage` — E-5 closed for this form.
The `max-[720px]:w-full` on the submit closes E-36. The three-tier grid reproduces `app.css:945`
(five columns), `app.css:1065-1066` (two columns at 721–1080 with the copy spanning) and `:1050` (one
column at ≤720) exactly, at the same breakpoints. The card border and `--paper-000` ground are gone
per §4.2; the fields are now `--field-bg` white on the canvas, which is what makes them still read
as fields.

**The impersonation toggle** (`Admin.tsx:430`) becomes
`<label className={cn(TOGGLE_ROW, "mb-[var(--space-4)]")}>` with
`<input type="checkbox" className={CHECKBOX_INPUT} aria-label="Enable user impersonation (testing)" …>`.
The `aria-label` string is unchanged — `Admin.dom.test.tsx` queries it verbatim, and it is also the
control's only accessible name.

**The users table** uses §5.2's components. Column headers: `Name`, `Email`, `Role`, `Access`,
`Created`, and `<TableHeader><span className="sr-only">Actions</span></TableHeader>`. Every body cell
keeps its existing `data-label`. Three cells carry call-site classes:

- the inline name editor — `<Input className="min-w-[130px] border-[var(--field-border)]" aria-label={\`Name for ${user.name}\`} …>`. `--field-border` is `--ink-900` (`tokens/colors.css:53`), reproducing `app.css:987`'s ink border. **This is the one place `--field-border` is used**, and it earns it: an ink-bordered box inside a table cell is the affordance that says "this row is in edit mode", which a hairline would not.
- the role select — `<NativeSelect className="min-w-[128px]" id={\`role-${user.id}\`} …>` preceded by the existing `<label className="sr-only" htmlFor={…}>`, both unchanged.
- the status — `<StatusPill tone={user.active ? "positive" : "neutral"}>{user.active ? "Active" : "Inactive"}</StatusPill>`.

Every button in the action cell becomes `buttonClasses("secondary")` or `buttonClasses("text")`,
matching its current `.button--secondary` / `.button--text` modifier one-for-one. The four load,
error and empty states become `<EmptyState>` with their existing `role` prop passed through
unchanged, and their `<div style={{ marginTop: 16 }}>` retry wrappers become
`className="mt-[var(--space-4)]"` (E-20).

### 5.9 Administration — Directory

Structurally identical to §5.8 and specified by reference, with three differences:

- The two forms take the same three-tier grid, with their ≥1081px templates from `app.css:983`
  (`minmax(200px,1.2fr) minmax(180px,1fr) minmax(180px,1fr) auto`) and `:984`
  (`minmax(190px,1fr) minmax(150px,.8fr) minmax(180px,1fr) minmax(160px,.8fr) auto`) preserved
  exactly, and the same `min-[721px]:grid-cols-2` middle tier from `app.css:1064`'s block.
- **All five unnamed inline editors get accessible names, closing E-34.** Every one follows the
  pattern already correct at `Admin.tsx:437` (`` aria-label={`Name for ${user.name}`} ``), so this
  is consistency, not invention — the field noun first, then the row's own identity:

  | Input | `aria-label` |
  | --- | --- |
  | Agency name (`Admin.tsx:445`) | `` {`Name for ${agency.name}`} `` |
  | Agency notes (`:445`) | `` {`Notes for ${agency.name}`} `` |
  | Agent name (`:448`) | `` {`Name for ${agent.name}`} `` |
  | Agent email (`:448`) | `` {`Email for ${agent.name}`} `` |
  | Agent phone (`:448`) | `` {`Phone for ${agent.name}`} `` |

  Each interpolates the row's **saved** value (`agency.name` / `agent.name`), not the draft being
  typed, so the name does not change under a screen reader mid-edit — same as `:437`, which reads
  `user.name` while the input's `value` is `userNameDraft`. Where the saved name is empty the label
  degrades to `"Name for "`, which is no worse than today's blank; a nameless row is an edge case
  the directory does not otherwise produce. *(Expanded 2026-09-02, Sol round 1 correctness 6 — this
  bullet previously named only the two Name inputs.)*
- The agency table's rows carry the `data-selected` treatment from §5.6, and the empty-state cell
  becomes `<TableCell colSpan={…} className="text-center text-foreground-secondary">` — replacing
  `.admin-table__empty` and its `--text-muted` (E-16).

The agent subsection keeps `.admin-subsection`'s 64px separation as
`className="mt-[var(--space-8)]"` on the wrapper.

### 5.10 Administration — Pipeline

Five stage rows. The list keeps its top hairline and each row its own hairline box — a stage *is* a
bounded record, so §4.2's "borders mean bounded objects" rule keeps them:

```tsx
<div className="admin-stage-list flex flex-col [border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border">
  {stages.map((stage) => (
    <div key={stage.key} className="admin-stage
        grid gap-[var(--space-4)] items-end p-[var(--space-4)]
        border-solid border-[length:var(--border-width-hair)] border-border border-t-0 bg-card
        grid-cols-[28px_minmax(0,1fr)] min-[721px]:grid-cols-[34px_minmax(150px,0.8fr)_minmax(180px,1fr)_90px]">
      <div className="admin-stage__order self-center [font:var(--type-h3)] tracking-[var(--tracking-tight)] text-foreground-secondary [font-variant-numeric:tabular-nums]">
        {stage.displayOrder}
      </div>
      <div className="min-w-0">
        <strong className="block capitalize text-foreground [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">{stage.key.replace(/_/g, " ")}</strong>
        <small className="block mt-[var(--space-1)] [font:var(--weight-regular)_var(--text-2xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">Stable stage key</small>
      </div>
      <QuincyField id={`stage-label-${stage.key}`} label="Label" className="max-[720px]:col-span-full" … />
      <label className={cn(TOGGLE_ROW, "max-[720px]:col-span-full")}>…</label>
    </div>
  ))}
</div>
```

Three changes, all from evidence. The ordinal drops `--signal-positive` for
`text-foreground-secondary` and 24px for `--type-h3` (E-19, E-15) — it is an index, and the display
face at 28px still gives it the weight the layout needs. `tabular-nums` keeps the five ordinals in a
column. `.admin-stage small`'s 11px is written as `--text-2xs` and its `--text-muted` becomes
`text-foreground-secondary` (E-15, E-16). The `max-[720px]:col-span-full` on the field and the toggle
reproduces `app.css:1048`'s block exactly.

**Invariant:** `Admin.dom.test.tsx:140` asserts `.admin-stage button` has length 0. `QuincyField`
renders an `<input>`, `TOGGLE_ROW` wraps an `<input type="checkbox">`, and no `<button>` appears —
which is precisely why §5.2 rejected the Base UI `Select` for this surface. `.admin-stage`,
`.admin-stage-list` and `.admin-stage__order` are all retained as non-styling hooks because the test
queries all three.

### 5.11 Administration — Integrations

The card grid is one of the places §4.2 *keeps* borders: an integration is a bounded object with its
own state, its own metadata and its own action.

```tsx
<div className="grid gap-[var(--space-4)] grid-cols-1 min-[1081px]:grid-cols-3">
  <article className="flex flex-col p-[var(--space-5)] bg-card border-solid border-[length:var(--border-width-hair)] border-border">
    <div className="flex items-start justify-between gap-[var(--space-3)]">
      <h3 className="m-0 [font:var(--type-h3)] tracking-[var(--tracking-tight)] text-foreground">{name}</h3>
      <StatusPill tone={TONE_FOR_STATUS[status]}>{statusLabel}</StatusPill>
    </div>
    <p className="mt-[var(--space-5)] mb-0 [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">
      {description}
    </p>
    <dl className="flex flex-wrap gap-x-[var(--space-5)] gap-y-[var(--space-3)] my-[var(--space-5)]">
      <div className="flex flex-col gap-[var(--space-1)]">
        <dt className="[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary">{term}</dt>
        <dd className="m-0 [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">{value}</dd>
      </div>
    </dl>
    {notice ? <div role="alert" className={cn(NOTICE_BASE, NOTICE_TONE.critical, "mb-[var(--space-4)]")}>{notice}</div> : null}
    <button type="button" className={buttonClasses("secondary", { className: "self-start mt-auto" })}>…</button>
  </article>
</div>
```

Four decisions. **`min-height: 270px` on the card and `min-height: 42px` on its `<p>` are both
dropped** (app.css:973, :976) — CSS grid already stretches every card in a row to the tallest, so
the two minimums only mattered for a single-card row, where they enforced empty space for nothing.
**`mt-auto` on the button keeps the actions baselined** across the row, which is what the minimums
were really protecting. **`.integration-meta`'s `flex` becomes `flex-wrap` with a row gap**, because
at 1081px three metadata pairs in a 1/3-width card overflow today. **`dt` moves from the off-scale
10px `--text-muted` to `--type-eyebrow` `text-foreground-secondary`** (E-15, E-16), which is now the
same treatment as a form label and a column header — Device 2, and here it makes the card's metadata
read as the same kind of thing as the table columns two sections up.

The grid drops from `repeat(3, …)` straight to one column below 1081px, matching `app.css:1071`'s
existing `.integration-grid { grid-template-columns: 1fr }` at ≤1080px. No middle tier is invented.

### 5.12 Administration — the three operator queues

This is the screen's operational core and it gets Device 3.

Each queue stays a **`<div>`**, keeps `admin-poison`, and takes `mt-[var(--space-8)]`. The
accessible-name situation is asymmetric today and stays asymmetric:

```tsx
{/* Tonomo and rendition queues — bare, exactly as today. No label is invented. */}
<div className="admin-poison mt-[var(--space-8)]">

{/* Notification delivery only — class and label on the SAME element (§8). */}
<div className="admin-poison mt-[var(--space-8)]" aria-label="Notification delivery operations">
```

*(Rewritten 2026-09-02, Sol round 2 new finding 3. The previous text said every queue becomes a
`<section …aria-label="…">` and called the strings "unchanged" — but only the third queue has a
label in the source (`Admin.tsx:469`), and §8 says so explicitly. Following the old text would have
made the builder invent two accessible names, which is a behavioural change the authority boundary
forbids. The element also stays a `<div>`: `<section aria-label>` is a `region` landmark, so
promoting these three would add two-or-three landmarks to the Admin screen's landmark map. That may
well be an improvement, but it is a new decision, and TB8-04 is a visual convergence.)*

`Admin.dom.test.tsx:393`, `:397` and `:431` query
`.admin-poison[aria-label="Notification delivery operations"]`, so on that one queue the class and
the label must stay on the same element and the string must survive verbatim.

Each queue's head becomes a `SectionHead` whose `actions` slot carries **exactly the controls that
section already has — no control is added and none is removed.** The eyebrow stays `"Operator
queue"` and each `<h2>` keeps its current text verbatim ("Failed Tonomo events", "Rendition delivery
failures", "Notification delivery").

*(Corrected 2026-09-02, Sol round 1 scope finding 2. The earlier draft gave all three queues a
Refresh button and bound it to an `isRefreshing` flag. Neither exists: `Admin.tsx:467` and `:460`
have no refresh control at all, and the screen has no `isRefreshing` — each existing Refresh is
disabled by its own loader flag, e.g. `isLoadingNotificationDeliveries` at `:469`. Adding two
refresh controls would have created two new user-triggered request paths and required new state,
both forbidden by §"Authority boundary".)*

**The count pill.** The rendition queue already renders one (`Admin.tsx:468`,
`<span className="admin-status admin-status--{error|active}">{n} stuck | No backlog</span>`). It
becomes a `StatusPill`, and the Tonomo and notification-delivery heads gain the matching pill so the
three read as one family:

```tsx
<SectionHead
  eyebrow="Operator queue"
  actions={
    <StatusPill tone={backlog > 0 ? "critical" : "neutral"}>
      {backlog > 0 ? `${backlog} ${noun}` : `No ${noun}`}
    </StatusPill>
  }
>
  Failed Tonomo events
</SectionHead>
```

The three nouns, fixed here rather than left to the builder (added 2026-09-02, slice-3 review):
Tonomo is `events` ("3 events" / "No events"), the rendition queue keeps its **shipped** strings
verbatim (`` `${n} stuck` `` / `"No backlog"`, `Admin.tsx:468`), and notification delivery is
`deliveries` ("3 deliveries" / "No deliveries"). The pattern needs a plural noun that survives the
`No …` branch; the first pass produced "No undelivered", which is not English.

with `backlog` bound to the count each queue **already holds in component state** — `poisonTotal`,
`renditionDlqOpenCount`, and `notificationDeliveryCounts[notificationDeliveryView]` respectively
(§3.2). **No new fetch, no new endpoint, no new state, no new handler, no change to any existing
query.** A pill is pure paint over a value the component has already computed and, in the rendition
queue's case, already displays. The tone flips to `critical` only when the backlog is non-zero, so a
healthy Admin screen shows three quiet neutral pills and a broken one shows oxblood exactly where
the problem is.

**The one queue that has a Refresh keeps it, re-clothed and unchanged in behaviour.** The
notification-delivery head's `actions` slot is the pill *and* that existing button:

```tsx
actions={
  <>
    <StatusPill …/>
    <button
      type="button"
      className={buttonClasses("secondary", { busy: isLoadingNotificationDeliveries })}
      disabled={isLoadingNotificationDeliveries}
      onClick={() => void loadNotificationDeliveries(notificationDeliveryView)}
    >Refresh</button>
  </>
}
```

`onClick`, `disabled` and the argument to `loadNotificationDeliveries` are copied from `:469`
verbatim. `buttonClasses`' `busy` option is real (`ui/button.tsx:43-48`, `opts.busy && "cursor-wait"`)
and is bound here to the same flag that already drives `disabled` — it adds a wait cursor, nothing
else. The four other Refresh buttons on the screen (Users `:417`, Directory `:442`, Pipeline `:452`,
Integrations `:458`) get the same class-only treatment in their own sections.

**The notification-delivery filter strip** (`Admin.tsx:469`) becomes a second `TabStrip`.

**The identifiers below are the real ones and must not be renamed** (corrected 2026-09-02, Sol round
1, which found the earlier sample using invented names `deliveryView`/`setDeliveryView`/
`DeliveryView`). The state is `notificationDeliveryView` (`Admin.tsx:115`), its type is
`NotificationDeliveryView` (`:30`), and `onValueChange` **must** call
`selectNotificationDeliveryView` (`:395-397`) — not the bare `setNotificationDeliveryView` — because
that function both sets the state *and* fires `void loadNotificationDeliveries(view)`. Calling the
setter alone would silently drop the refetch: the tab would highlight and the table would keep
showing the previous view's rows. That is a network-behaviour change, which §"Authority boundary"
forbids.

```tsx
<TabStrip
  idPrefix="admin-delivery"
  label="Notification delivery filters"
  items={DELIVERY_VIEWS.map((view) => ({ value: view, label: DELIVERY_LABELS[view], count: notificationDeliveryCounts[view] }))}
  value={notificationDeliveryView}
  onValueChange={(next) => selectNotificationDeliveryView(next as NotificationDeliveryView)}
  // Same required hook as the section strip — §7 row 26 (R). `Admin.dom.test.tsx:85`'s
  // `.admin-tabs button` matches both strips; dropping it here would halve that query silently.
  className="admin-tabs mb-[var(--space-5)]"
/>
<div
  role="tabpanel"
  id={`admin-delivery-panel-${notificationDeliveryView}`}
  aria-labelledby={`admin-delivery-tab-${notificationDeliveryView}`}
  tabIndex={0}
>
  …the delivery table…
</div>
```

**This is a DOM-structure change and §8 flags it**: a new `<div role="tabpanel">` wraps the delivery
table. It is placed **inside** the `canManageIntegrations` gate that already wraps the Integrations
panel, never around it, so no capability boundary moves. It closes E-10's worst case — five buttons
with `role="tab"` and `aria-selected` that controlled no panel at all. The counts move into the
strip because `TabStrip` supports them and they are already rendered next to those labels today.

**The duplicate-email warning** (`Admin.tsx:469`) is E-6's fix:

```tsx
<strong className="text-destructive [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)]">
  Duplicate email possible
</strong>
```

`text-destructive` resolves through the bridge to `--signal-critical`. `app.css:997`
(`.admin-warning`) and its undefined `--signal-negative` retire together. This is the only change in
the release that alters what a user sees on a *correctly functioning* path from something wrong to
something right, rather than from one correct thing to another.

*(Corrected 2026-09-02, Sol round 1 consistency finding 5, twice over. The earlier sample carried
both `font-[var(--weight-regular)]` **and** a `font:` shorthand — two utilities competing over
`font-weight`, which is the very defect §2.1's merged-shorthand rule exists to prevent, and which
§10.1-D4 would have caught only after the build. On the weight itself, Sol found the contradiction
but did not resolve it, and the resolution is **`--weight-regular`, not bold**: `--font-sans` is
Apfel Grotezk, which ships **one** face at 400 (`fonts.css:10-12`), so 700 is synthesised exactly
like the 500 that E-13 objects to. §7 rows 116/144 and E-13's own "400 and 700" claim were the
errors here and have been corrected; §5.14/§5.15/§5.16 were already right. Emphasis is carried by
`text-destructive` — colour, not weight — which is TB8-02's and TB8-03's shipped precedent for this
exact defect.)*

The `<code>` elements in that table take a single explicit shorthand,
`[font:var(--weight-regular)_var(--text-xs)/1.4_var(--font-mono)]` — per §2.1's merged-shorthand
rule, **not** `[font:var(--type-mono)] text-[length:var(--text-xs)]`.

**The payload dialog's `<pre>` is E-42 and is fixed here.** `Admin.tsx:480` currently reads:

```tsx
<pre className="max-h-[55vh] overflow-auto m-0 p-[var(--space-4)] bg-background text-foreground-secondary [font:var(--type-mono)] text-[length:var(--text-xs)] leading-[var(--leading-normal)]">
```

and becomes:

```tsx
<pre className="max-h-[55vh] overflow-auto m-0 p-[var(--space-4)] bg-background text-foreground-secondary [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-mono)]">
```

Same rule, same fix: `--type-mono` is itself a `font:` shorthand carrying `--text-sm`/1.4
(`tokens/typography.css:68`), so the two trailing utilities were competing with it over `font-size`
and `line-height` and the winner depended on Tailwind's generated rule order. The merged form pins
the intended 12px/1.5 unambiguously. This is the only edit inside the payload dialog; §6.2's
exclusion of that dialog covers its structure, which does not change.

The four `<div style={{ marginTop: 16 }}>` Load-more wrappers become
`className="mt-[var(--space-4)]"` (E-20).

### 5.13 New shoot

The page the direction was designed for. `.create-project` retires; the `<main>` becomes
`className="page !max-w-[1080px]"` and the form becomes:

```tsx
<form onSubmit={submit} noValidate className="create-project__form flex flex-col gap-[var(--space-8)]">
```

`.create-project__form` is retained as a **non-styling hook** — `ProjectCollaborationPanel.dom.test.tsx:1018`
and `:1020` query it from outside this release's scope (E-28), and `:1020` additionally requires it
to stay the **immediate next sibling of the page heading**. That heading is §5.4's `PAGE_HEAD`
`<header>`, so the form element must directly follow it with nothing in between; §9.4 retargets the
selector from `.pagehead +` to `header +` accordingly. The gap moves from `--space-5` (24px) to `--space-8`
(64px): §4.2 point 2, the separation that replaces the card borders.

**The hero** keeps its border and its white ground — it is §4.2's anchor and the one thing the form
requires:

```tsx
<section
  aria-labelledby="property-heading"
  className="p-[clamp(var(--space-5),6vw,var(--space-8))] bg-card border-solid border-[length:var(--border-width-hair)] border-border"
>
  <Eyebrow className="block mb-[var(--space-3)]">Start with the address</Eyebrow>
  <h2 id="property-heading" className="m-0 [font:var(--type-h1)] max-[720px]:[font:var(--type-h2)] tracking-[var(--tracking-tight)] text-foreground text-balance">
    Where is the shoot?
  </h2>
  <p className="mt-[var(--space-4)] mb-[var(--space-5)] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">
    …unchanged copy…
  </p>

  <div className="grid gap-[var(--space-3)] grid-cols-1 min-[721px]:grid-cols-[minmax(0,1fr)_auto]">
    <label className="flex flex-col gap-[6px]">
      <span className="sr-only">Street address</span>
      <input
        autoFocus
        required
        id="project-street"
        placeholder="12 Kings Road, Vaucluse"
        aria-invalid={Boolean(errors.street)}
        aria-describedby={errors.street ? "project-street-error" : undefined}
        aria-errormessage={errors.street ? "project-street-error" : undefined}
        className={cn(FIELD_BOX,
          "min-h-[var(--space-7)] rounded-none px-[16px] py-[12px]",
          "border-[var(--field-border)]",
          "[font:var(--weight-regular)_var(--text-lg)/var(--leading-snug)_var(--font-display)]")}
      />
    </label>
    <button type="submit" className={buttonClasses("primary", { busy: isSubmitting, className: "min-h-[var(--space-7)] max-[720px]:w-full" })}>
      …unchanged label…
    </button>
  </div>

  {errors.street ? (
    <p id="project-street-error" role="alert" className="mt-[var(--space-2)] mb-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-destructive">
      {errors.street}
    </p>
  ) : null}
  …
</section>
```

*(Copy corrected 2026-09-02, during slice-2 review. The sample above previously read
`<Eyebrow>Production desk</Eyebrow>` / `Where are we shooting?`. Both were copy-paste artifacts from
§5.4's `PAGE_HEAD` sample: "Production desk" is the page header's own eyebrow, rendered immediately
above this section, so the page carried it twice; and "Where are we shooting?" silently rewrote
shipped copy. **This is a visual convergence release — it changes no copy.** The hero's real strings
are `Start with the address` and `Where is the shoot?`, and the sample now shows them. The slice-2
builder transcribed the wrong strings faithfully and flagged the duplication, which is the correct
behaviour; the error was the plan's.)*

Five decisions closed here:

1. **The address error is wired.** `aria-describedby` + `aria-errormessage` + `role="alert"` +
   a stable `id`, exactly as `QuincyField` does it — E-5's most important instance, on the app's most
   used form. It is written inline rather than via `QuincyField` because this input's geometry is
   deliberately unique (see 3) and forcing it through the field component would mean parameterising
   the component for one caller.
2. **`min-height: 58px` → `min-h-[var(--space-7)]` (48px)** on both the input and the button
   (E-35). 58 is on no scale; 48 is. The pair still reads as the page's largest control by a wide
   margin, and the button now matches the input exactly because both name the same token.
3. **`font-size: 25px` → `--text-lg` (22px), keeping `--font-display`.** The display face at 22px
   in an ink-bordered box is still unmistakably the hero input; 25px was reaching for a rung that
   does not exist. `rounded-none` and `border-[var(--field-border)]` (ink) are kept from
   `app.css:1007` — this input is *supposed* to look different from every other field, and it is the
   second and last `--field-border` site.
4. **The olive focus ring is gone** (E-12): `FIELD_BOX` brings the system ring, and `app.css:1009`
   retires. Focus is not a positive state.
5. **The placeholder** inherits `placeholder:text-foreground-secondary` from `FIELD_BOX`, replacing
   `app.css:1008`'s `--text-muted` at `opacity: 1` (E-16).

**The refinements row** (`.create-project__refinements`) becomes
`grid gap-[var(--space-4)] max-w-[580px] grid-cols-1 min-[721px]:grid-cols-[minmax(0,1fr)_150px]`
with two `QuincyField`s whose optional marker becomes
`<em className="not-italic ms-[var(--space-2)] [font:var(--type-eyebrow)] normal-case tracking-[var(--tracking-normal)] text-foreground-secondary">optional</em>`
inside the label — `not-italic` because an italic Apfel Grotezk is synthesised the same way a 500
weight is (E-13's defect class), and the word is doing a label's job, not an emphasis one.

**The disclosure** keeps its border (a bounded object) and its native marker:

```tsx
<details open={showDetails} onToggle={…} className="bg-card border-solid border-[length:var(--border-width-hair)] border-border">
  <summary className="p-[var(--space-5)] cursor-pointer [font:var(--type-label)] uppercase tracking-[var(--tracking-wide)] text-foreground marker:text-foreground-secondary open:[border-bottom-style:solid] open:border-b-[length:var(--border-width-hair)] open:border-b-border">
    Add details now <span className="normal-case tracking-[var(--tracking-normal)] text-foreground-secondary">(optional)</span>
  </summary>
  <div className="p-[var(--space-5)] max-[720px]:p-[var(--space-4)] flex flex-col gap-[var(--space-8)]">…</div>
</details>
```

`font-size: 15px` becomes `--type-label` (14px) and the summary gains the uppercase label treatment
of Device 2 — a disclosure control is a label for the region it opens. The `open:` variant on the
summary reproduces `app.css:1018` (`.create-project__details[open] summary`).

**The actions row** is `flex flex-wrap justify-end gap-[var(--space-3)] max-[720px]:flex-col-reverse max-[720px]:[&>*]:w-full`,
reusing `Modal.tsx:93`'s shipped footer pattern so a cancel-then-submit pair stacks in the right
order on a phone. `.create-project__actions` is retained as a **non-styling hook**
(`CreateProject.dom.test.tsx:49` queries it).

### 5.14 Shared project fields

Seven sections, six of which lose their card. Each becomes:

```tsx
<section aria-labelledby="client-heading" className="create-project__section">
  <SectionHead eyebrow="Client" id="client-heading">Who is it for?</SectionHead>
  …
</section>
```

`.create-project__section` is retained as a **non-styling hook** because
`ProjectFields.test.ts:79` string-matches the `class` attribute exactly (E-29) — and because keeping
the name means that assertion needs only its expected string updated, not its whole approach. All
paint moves to `SectionHead` and the field grids.

**TB1's Client section is reconciled, not undone.** Its four `QuincyField`s, their ids, their
`aria-invalid` wiring and the `FieldGroup` all stay exactly as they are. Two changes:

- The `<div className="ey">` + `<h2 className="serif">` head pair becomes `<SectionHead>` — which is
  the same eyebrow-over-display-heading structure TB1 wrote by hand, now shared with the six
  sections beside it.
- **`[&]:grid` becomes `grid`** (E-27). The doubled-specificity prefix existed to beat legacy
  `.grid`; TB8-03 renamed that selector and the workaround is now a false clue. `ProjectFields.test.ts:91-93`
  asserts its presence and plain `grid`'s absence, and §9 rewrites both assertions to the inverse.
  The `grid-cols-1 / min-[721px]:grid-cols-2 / min-[1081px]:grid-cols-4 / gap-[var(--space-4)]`
  tail is unchanged, and becomes the shared field-grid string every other section adopts.

The three field-grid shapes, named once and used throughout:

| Name | Classes | Replaces |
|---|---|---|
| `FIELD_GRID_4` | `grid gap-[var(--space-4)] grid-cols-1 min-[721px]:grid-cols-2 min-[1081px]:grid-cols-4` | `.create-project__fields` (app.css:1029), plus its overrides in the `app.css:1048` and `app.css:1064` blocks |
| `FIELD_GRID_2` | `grid gap-[var(--space-4)] max-w-[620px] grid-cols-1 min-[721px]:grid-cols-2` | `.create-project__fields--two` (:1031) |
| `FIELD_GRID_PROPERTY` | `grid gap-[var(--space-4)] grid-cols-1 min-[721px]:grid-cols-2 min-[1081px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(110px,0.55fr)]` | `.create-project__fields--property` (:1030) |

Every legacy `label.admin-field` in this file becomes a `QuincyField`, `QuincySelectField` or
`QuincyTextareaField` — E-3 and E-4 establish this is a zero-pixel change, and it closes E-5 for
`errors.invoiceAmount` (`ProjectFields.tsx:105`) and `errors.rawFolderLink` (`:116`).

**Read-only sections.** `.project-fields__section--readonly` and `__readonly-note` retire; the note
becomes `mt-[var(--space-2)] mb-[var(--space-4)] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary`,
and the read-only appearance now comes from `FIELD_BOX`'s `read-only:bg-surface-sunken read-only:text-foreground-secondary`
— which is a real improvement, because today a read-only order field is visually identical to an
editable one. The `readOnly` and `disabled` attributes themselves, and `projectFieldsPolicy(mode)`
at `ProjectFields.tsx:43-46`, are untouched.

*(`mb-[var(--space-4)]` added to that string 2026-09-02, during slice-2 review. The note is a sibling
of `SectionHead`, whose own `mb-[var(--space-5)]` collapses with the note's `mt-[var(--space-2)]` to
give 24px above it — but with no bottom margin the note butted directly into the field grid below,
because a `<p>`'s default block margins are zeroed by preflight. 24px above / 16px below is the
intended rhythm.)*

Moving these to `Field` + `FieldLabel` + `Input` means each read-only control now needs an `id` —
**not** because the controls are unnamed today, but because the label stops being a wrapping
`<label>` and becomes a separate `for=`-associated one, and a `for=` needs something to point at.

*(Corrected 2026-09-02, Sol round 1 correctness 13. This paragraph previously claimed a wrapping
`<label>` "gave these fields no programmatic name at all". That is wrong: HTML's wrapping-label
association is real, and these controls **are** named today. The reason to change the structure is
not naming — it is that `FieldLabel` is a `for=` component and that an explicit association is
harder to break silently than an implicit one that depends on DOM containment surviving every
future refactor. Nothing here is an accessibility fix, so **this change is not release-blocking and
E-5 is not its justification** — E-5 is about validation errors not being announced, which §5.14
closes separately via `QuincyTextareaField` for `errors.invoiceAmount` and `errors.rawFolderLink`.
The one real naming risk is in the other direction: if the builder converts a wrapping label to a
`for=` label and the `id` does not match, a control that is named today becomes unnamed. §10.2
item 4 is what catches that, and it must be run against these controls specifically.)*

**The ids are fixed here, following the `project-agent-*` convention TB1 established at
`ProjectFields.test.ts:94`:** `project-order-number`, `project-order-id`, and
`project-order-notes` for the textarea. `ProjectFields.tsx:105` holds the two labels today. §9.2
asserts exactly these three strings, so they are a contract, not a suggestion.

**The services grid** keeps its 1px cell rules — a bounded set:

```tsx
<div role="group" aria-labelledby="services-heading"
     className="grid gap-[1px] bg-border border-solid border-[length:var(--border-width-hair)] border-border
                grid-cols-1 min-[721px]:grid-cols-3 min-[1081px]:grid-cols-5">
  <label className={CHECK_TILE}>
    <input type="checkbox" className={CHECKBOX_INPUT} … />
    <span className="flex min-w-0 flex-col gap-[var(--space-1)]">
      <strong className="text-foreground [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]">{label}</strong>
      <small className="[font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary">{hint}</small>
    </span>
  </label>
</div>
```

`gap-[1px]` on a `bg-border` ground is exactly `app.css:1033`'s technique, kept because it produces
hairline rules between tiles without four borders per tile. The grid wrapper's own
`.create-project__checks` class is **removed** (row 110, case **D**): nothing queries it. Its child
`.create-project__check` is **retained as a non-styling hook** (row 111, case **R**), because
`ProjectFields.dom.test.tsx:59` selects `label.create-project__check` — reaching it via
`.create-project__checklist`, which `:58` selects and row 109 therefore also keeps. Those two, and
only those two, are the checklist hooks. *(Corrected 2026-09-02: the round-1 text called all four
classes test hooks. `ProjectFields.dom.test.tsx:55-62` queries `.ey` (`:56`), `.create-project__checklist` (`:58`)
and `label.create-project__check` — never `.create-project__checks`, never
`.create-project__team`.)* **`font-weight: 500` becomes `--weight-regular`** on the tile's
`<strong>` (E-13); the label is distinguished from its hint by colour and size, which is how the
rest of the app does it and how a face with two weights can actually do it. The tile's `13px`
becomes `--text-sm` and its `12px` becomes `--text-xs` (E-15).

**The team checklist** (create mode only) keeps `.create-project__checklist` as a non-styling hook
(row 109) and drops `.create-project__team` from its wrapper (row 118), which takes `FIELD_GRID_2`'s
two-column shape. Its retry wrapper's `style={{ marginTop: 12 }}` becomes `mt-[var(--space-3)]` (E-20). Its
`.notice[role="alert"]` becomes `NOTICE_BASE` + `NOTICE_TONE.critical`, `role` unchanged.

The checklist box itself becomes
`grid gap-[1px] mt-[var(--space-3)] bg-border border-solid border-[length:var(--border-width-hair)] border-border`.
The `bg-border` is **an addition, not a transcription**: `app.css:1032` sets only `gap: 1px` and a
border, so today the 1px gutters show the section's paper and the team rows have no rules between
them, while the services grid two sections above *does* (`app.css:1033` grounds it in
`--border-hairline`). Two adjacent checklists built from the same tile, one ruled and one not, is
an inconsistency worth closing rather than preserving — §4.2's bounded-set device applies to both.
*(Decided 2026-09-02, during slice-2 review.)*

That ground has one consequence the legacy rule did not: the checklist's own empty message
(`No active photographers are provisioned.`, and the editors' equivalent) is the box's only child in
that state, so with no paper of its own it would render straight onto the rule colour. It gets a
tile's ground and the tile's own hint size —
`m-0 p-[12px] bg-card [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary`
— which also preserves `app.css:1041`'s 12px muted treatment of `.create-project__checklist p`. It
is **not** `SECTION_NOTE`: that one is a section-level note living outside any box.

**Notes** becomes a `QuincyTextareaField` with `rows={5}` preserved. *(Corrected 2026-09-02 from
`rows={4}`, which this plan asserted in three places — here, §1.4 and §5.2. `ProjectFields.tsx:126`
ships `rows={5}`; the intent was always "carry the existing value through", so the value follows the
source. Flagged by the slice-2 builder, which transcribed the plan's literal `4` and reported the
discrepancy rather than silently reconciling it.)*

### 5.15 Edit shoot, and the danger zone

Everything in §5.13 and §5.14 applies. Three additions.

**The archived badge** (`EditProject.tsx:115`) becomes
`<StatusPill tone="caution" role="status">Archived — hidden from the dashboard</StatusPill>` — same
copy, same `role`, now on the shared pill.

**The load/error state** (`EditProject.tsx:120`) becomes
`<EmptyState role={loadError ? "alert" : "status"} tone={loadError ? "error" : "empty"} title={…}>` —
the `role` expression is copied verbatim, and the new `tone` prop means a load failure is now
distinguishable from an empty result by shape, not only by wording.

**The danger zone keeps its border and its tint.** It is a bounded object and the border is the
warning:

```tsx
<section
  aria-labelledby="danger-zone-heading"
  className="flex flex-col gap-[var(--space-5)] mt-[var(--space-8)] p-[var(--space-5)]
             border-solid border-[length:var(--border-width-hair)] border-signal-critical/48
             bg-signal-critical/4"
>
  <SectionHead eyebrow="Irreversible" id="danger-zone-heading" className="border-t-destructive">Danger zone</SectionHead>
  …
</section>
```

The section rule turns oxblood here — the one place Device 1's rule takes a colour, and it takes it
because this is the one section whose *identity* is a warning. Each action row keeps its top
divider at its existing oxblood tint (app.css:1202):
`pt-[var(--space-5)] [border-top-style:solid] border-t-[length:var(--border-width-hair)]
border-t-signal-critical/28`, over
`grid gap-[var(--space-5)] items-end grid-cols-1 max-[720px]:items-stretch
min-[721px]:grid-cols-[minmax(0,1fr)_auto]` for the archive row and
`min-[721px]:grid-cols-[minmax(0,1fr)_minmax(220px,0.7fr)_auto]` for the delete row (app.css:1205).
Both rows' buttons take `max-[720px]:w-full`, reproducing `app.css:1209`.

`font-weight: 500` on `.danger-zone strong` becomes `--weight-regular` (E-13). The body copy's
`13.5px` becomes `--text-sm` and keeps `max-w-[52ch]` (E-15). The delete button becomes
`buttonClasses("danger")` — which already carries `--signal-critical`'s border, ground and hover
inversion, so `.danger-zone__button` (app.css:1206-1207) retires with nothing to replace. The
typed-street-match confirmation (`deleteMatchesStreet`, `EditProject.tsx:112`) and the `confirm()`
call are untouched; only the input's classes change, to `FIELD_BOX`.

`.danger-zone__notice` becomes `NOTICE_BASE` + `NOTICE_TONE.positive`, `role="status"` unchanged.

### 5.16 Type scale — every value, before and after

| Site | Today | After | Why |
|---|---|---|---|
| `.admin-section__head h2` (app.css:944) | 34px | `--type-h3` (28px) | E-15 |
| `.create-project__section-head h2` (:1022) | 29px | `--type-h3` | E-15 |
| `.danger-zone h2` (:1201) | 29px | `--type-h3` | E-15 |
| `.integration-card h3` (:975) | 28px literal | `--type-h3` | token, same value |
| `.create-project__hero h2` (:1005) | `clamp(36px,5vw,58px)` | `--type-h1` (48px), `--type-h2` (36px) ≤720 | E-15 |
| `.signin__title` (:887) | `clamp(38px,6vw,52px)` | `--type-h1`, `--type-h2` ≤720 | E-15 |
| `.admin-stage__order` (:991) | 24px olive | `--type-h3`, secondary | E-15, E-19 |
| `.create-project__address input` (:1007) | 25px | `--text-lg` (22px) | E-35 |
| `.create-project__details summary` (:1016) | 15px | `--type-label` (14px) | E-15 |
| `.admin-table` / `td` (:960, :962) | 14px literal | `--text-sm` | token, same value |
| `.admin-table th` (:961) | 11px literal, muted | `--text-2xs`, secondary | E-15, E-16 |
| `.admin-status` (:967) | 10px | `--text-2xs` (11px) | E-15 |
| `.integration-meta dt` (:980) | 10px, muted | `--type-eyebrow` (12px), secondary | E-15, E-16 |
| `.integration-meta dd` (:981) | 13px | `--text-sm` | E-15 |
| `.admin-provision__copy p` (:947) | 13.5px | `--text-sm` | E-15 |
| `.danger-zone p` (:1204) | 13.5px | `--text-sm` | E-15 |
| `.admin-toggle` (:995) | 13px | `--text-sm` | E-15 |
| `.admin-stage strong` (:993) | 14px | `--text-sm` | token, same value |
| `.admin-stage small` (:994) | 11px, muted | `--text-2xs`, secondary | E-15, E-16 |
| `.create-project__check strong` (:1039) | 13px, **weight 500** | `--text-sm`, `--weight-regular` | E-13, E-15 |
| `.create-project__check small` (:1040) | 12px, muted | `--text-xs`, secondary | E-15, E-16 |
| `.danger-zone strong` (:1203) | 14px, **weight 500** | `--text-sm`, `--weight-regular` | E-13 |
| `.admin-field small` (:952) | 12px | `FieldError` → `--text-xs` | E-30 |
| `.admin-warning` (:997) | 12px, **undefined colour** | `--text-xs`, `text-destructive` | E-6, E-15 |
| `.button__google` (:881) | `700 12px/1 Arial` | **deleted** | E-14 |

Every "After" value is a token that exists in `tokens/typography.css`. Nine of the twenty-five sites
were on no scale rung at all.

### 5.17 The responsive matrix

Breakpoints are unchanged: `max-[720px]` and `min-[721px]` are `app.css:1048`'s existing boundary,
`min-[1081px]` is `app.css:1064`'s. No new breakpoint is introduced.

| Surface | ≤720px | 721–1080px | ≥1081px |
|---|---|---|---|
| Admin tab strips | wrap, 44px targets | single row | single row |
| Admin tables | stacked cards, `<thead>` `sr-only` | 820px min-width, horizontal scroll | full width |
| Table action cells | left-aligned, wrapped, full-width buttons not forced | right-aligned | right-aligned |
| Provisioning / directory forms | 1 column, submit full-width | 2 columns, copy spans | 5 / 4 / 5 columns |
| Integration cards | 1 column | 1 column | 3 columns |
| Stage rows | 2 columns, field and toggle span | 4 columns | 4 columns |
| Project field grids | 1 column | 2 columns | 4 / 2 / 3 columns |
| Services tiles | 1 column | 3 columns | 5 columns |
| Hero heading | `--type-h2` | `--type-h1` | `--type-h1` |
| Hero input + submit | stacked, both full-width | side by side | side by side |
| Form actions | reversed column, full-width | right-aligned row | right-aligned row |
| Every control | `min-h-[44px]` | `min-h-[38px]` | `min-h-[38px]` |

---

## 6. Implementation shape

### 6.1 The complete touched-file list

This is exhaustive. A file not on this list is not edited by TB8-04, and a file appearing in the
diff that is not on this list is a scope finding for Sol.

**Screens and components rewritten in place (5 files, 838 lines today):**

| File | Lines today | What changes |
| --- | --- | --- |
| `portal/apps/web/src/screens/Admin.tsx` | 487 | Every `className` on the screen; **six** `<table>` blocks become `ui/table` elements; two `role="tablist"` strips become `TabStrip`; **three** `.integration-card` blocks (one per entry in `PROVIDERS`, `Admin.tsx:49` — `dropbox`, `tonomo`, `vimeo`) and the provisioning form recompose; **five** inline `style` objects removed (E-20). No hook, no handler, no query, no capability expression changes. *(Counts corrected 2026-09-02 after Sol round 1: the plan previously said four tables, four cards and four style objects.)* |
| `portal/apps/web/src/screens/EditProject.tsx` | 124 | Page frame, `.pagehead`, the archived badge, the danger zone, one inline `style` (E-20). |
| `portal/apps/web/src/screens/CreateProject.tsx` | 62 | Page frame, the address hero, the `<details>` disclosure, the actions row, one inline `style` (E-20). |
| `portal/apps/web/src/components/ProjectFields.tsx` | 129 | Every section except the Client `<section>`, whose four-control contract is preserved byte-for-byte except for the two class-token changes §5.14 specifies; one inline `style` (E-20). |
| `portal/apps/web/src/screens/SignIn.tsx` | 36 | The whole screen; the `.button__google` disc element is deleted. |

**Shipped primitives edited (5 files, §5.1):**

| File | Edit |
| --- | --- |
| `components/ui/input.tsx` | Replace the class string with the exported `FIELD_BOX`; drop the `quincy-input` class name; add hover, disabled, read-only and `aria-invalid` states. |
| `components/ui/field.tsx` | `FieldError` token normalisation only. |
| `components/ui/eyebrow.tsx` | Add `data-slot="eyebrow"`. |
| `components/ui/select.tsx` | Correct the stale comment at line 92. No behaviour change. |
| `components/ui/button.tsx` | Insert `max-[720px]:min-h-[44px]` into `BASE`. |

`components/ui/label.tsx` (9 lines) and `components/ui/menu.tsx` (107 lines) are **not** touched.

**New files (11):**

| File | Exports |
| --- | --- |
| `components/ui/table.tsx` | `TableWrap`, `Table`, `TableHead`, `TableBody`, `TableRow`, `TableHeader`, `TableCell` |
| `components/ui/tabs.tsx` | `TabStrip` |
| `components/ui/status-pill.tsx` | `StatusPill`, `PILL_BASE` |
| `components/ui/textarea.tsx` | `Textarea` |
| `components/ui/native-select.tsx` | `NativeSelect` |
| `components/ui/checkbox.tsx` | `Checkbox`, `CHECKBOX_INPUT`, `CHECK_TILE`, `TOGGLE_ROW` |
| `components/quincy/SectionHead.tsx` | `SectionHead` |
| `components/quincy/EmptyState.tsx` | `EmptyState` |
| `components/quincy/Notice.tsx` | `Notice` |
| `components/quincy/QuincySelectField.tsx` | `QuincySelectField` |
| `components/quincy/QuincyTextareaField.tsx` | `QuincyTextareaField` |

**Stylesheet (1 file):** `portal/apps/web/src/styles/app.css` — §7's dispositions only. No other
stylesheet is edited; in particular **no token file changes**, because every value TB8-04 needs
already exists (§2.1's verification pass found no gap, and E-37's fix is *consuming* `--field-bg`,
not defining it).

**Tests (4 edited files + 1 new file, 1 listed at zero):** §9 states the exact edits —
`Admin.dom.test.tsx`, `ProjectFields.test.ts`, `ProjectFields.dom.test.tsx` and
`ProjectCollaborationPanel.dom.test.tsx`, with `CreateProject.dom.test.tsx` recorded at zero edits.
The one new file is **`components/ui/tabs.dom.test.tsx`** (§9.6) — seven `happy-dom` cases pinning
`TabStrip`'s ARIA/`tabIndex`/callback contract, including the single-`aria-controls` assertion that
mechanically catches Sol round 1's correctness 3. *(Added 2026-09-02, Sol round 1 correctness 11;
§9.6 previously declared no new test files.)*

**Documentation (1 file, outside `portal/`):** `docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md`
— the two-line edit of §1.4, in scope by owner decision (§12 Q4) and gated by §10.1-H. *(Added
2026-09-02: Sol round 1 found §6.1 calling itself exhaustive while omitting this file.)*

**Nothing else.** That is the whole diff: 5 screens/components, 5 shipped primitives, 11 new
component files, 1 stylesheet, 4 edited test files, 1 new test file, 1 doc.

### 6.2 What is deliberately not touched

- **`ConfirmDialog.tsx` and the shared `Modal`.** Per E-32, the Admin payload dialog was already
  absorbed into the shared `Modal` by TB8-02; `app.css:998-999` records it. TB8-04 opens no dialog
  of its own and adds no overlay. `.button--danger` (`app.css:877-878`) survives untouched because
  `ConfirmDialog.tsx:15` is its only consumer and that file is out of scope.
- **`NotificationPreferences.tsx`** and every notification surface outside `Admin.tsx` (§1.2).
- **`components/atoms.tsx`.** It carries `.ey` and `.serif` consumers for out-of-scope screens; §7
  splits those selectors rather than editing this file.
- **The `.cbar` / `.ctabs` / `.optcard` collection-bar family.** §7 retires `.ctab`, `.ctab:hover`
  and `.ctab.is-active` because `Admin.tsx:411` and `:469` are their only consumers in `portal/`,
  but leaves `.ctabs` (`:678`), `.ctab .cnt` (`:682`) and `.ctab--premium` (`:683-684`) in place:
  those three already have zero consumers and belong to the collections surface, not this one.
  Deleting dead code on someone else's surface is scope creep, so it is named as a follow-up
  instead.
- **`.grow` (`app.css:28`)** and **both `.sr-only` declarations (`app.css:937` and `:1046`)** — the
  two surviving Tailwind name collisions, both analysed in §2.2 and neither symptomatic here.

### 6.3 Order of work

The builder should land this in five commits on one branch, because a single 1,000-line diff cannot
be reviewed and because commits 1 and 2 are provably behaviour-free:

1. **Primitives.** The five edits of §5.1 plus the eleven new files of §5.2–§5.3, with no consumer
   changes. `npm run test --workspaces` must be green at this commit with **zero test edits** —
   the existing `QuincyField.dom.test.tsx` exercises the new `FIELD_BOX`, and if it fails here the
   `Input` change has altered behaviour, which it must not.
2. **Sign-in.** The smallest surface (36 lines), no tests, and it exercises `Button`, `Notice` and
   the page-frame decision end to end. Screenshot it at all three viewports before continuing —
   if §4.2's card removal is going to be wrong, it is cheapest to discover here.
3. **New shoot and shared project fields.** `CreateProject.tsx` + `ProjectFields.tsx`, with the
   `ProjectFields` test edits of §9.
4. **Edit shoot.** `EditProject.tsx` and the danger zone.
5. **Administration.** `Admin.tsx` with the `Admin.dom.test.tsx` edits of §9, then the §7
   `app.css` deletions as the final change in this commit — **not earlier**, because the retirement
   gate of §7.0 can only be run once every consumer has moved.

### 6.4 No new runtime dependency

No package is added. `ui/table.tsx`, `ui/tabs.tsx`, `ui/status-pill.tsx`, `ui/textarea.tsx`,
`ui/native-select.tsx` and `ui/checkbox.tsx` are plain React over native elements plus `cn()`;
`TabStrip`'s keyboard handling is ~25 lines of `onKeyDown` (§5.2), which is smaller than the
integration cost of a headless tabs library and avoids introducing a second focus-management
system beside the Base UI one TB8-02 already ships for menus and dialogs. **No `shadcn` CLI
generation** — every new file is hand-written against the conventions of §2.1. **No `cva`**, per the
TB1 baseline: variants are plain string maps, as `buttonClasses` already does.

---

## 7. Legacy CSS retirement

### 7.0 The retirement gate

Restated from TB8-03 §7.0, because it is the procedure that caught the `.grid` defect and it is not
optional here. **A rule may be deleted from `app.css` only when a repo-wide raw search for its class
name returns zero *unmigrated-paint* consumers**, and every remaining hit is classified as exactly
one of:

- **a kept hook** — the class is still in the markup, but nothing paints it; it exists for a test
  query or for a surviving sibling selector. The row below says so explicitly.
- **a test-only reference** — a `querySelector`, a class-token assertion, or a snapshot string.
  **A `querySelector` in a test file is a consumer.** If §9 does not already rewrite it, the rule
  cannot be deleted.
- **the rule being deleted itself**, i.e. the hit is the `app.css` line under disposition.

Any fourth kind of hit stops the deletion.

The search is run on the finished branch, not on this plan, and it is run **raw** — on the bare
class name without a leading dot — because `className={`ctab ${…}`}`, `class="admin-table"` and a
CSS selector are three different strings:

```
cd portal/apps/web
grep -rn "<name>" src --exclude-dir=node_modules
```

**Expected-hit inventory.** A gate that only looks for unexpected hits is half a gate: a *kept hook*
that returns zero hits means the builder dropped a class a test depends on, and the test may not
fail until someone else's branch. So each row below states the hits it expects to survive, and the
following **fourteen** hooks — thirteen rows, the checklist row covering two — **must** still be
present on the finished branch. Every count in the right-hand column was re-verified against the
current source on 2026-09-02 with `grep -o … | wc -l`, not by reading the old plan:

| Kept hook | Expected surviving hits |
| --- | --- |
| `admin-tabs` | `Admin.tsx:410`, `Admin.tsx:469`; `Admin.dom.test.tsx:85`, `:289` |
| `admin-section` | 4 in `Admin.tsx` (the four `role="tabpanel"` sections); `Admin.dom.test.tsx:143`. **`app.css` has never had a `.admin-section` rule** — this class is already a pure hook, so it appears in no §7 row. It must survive anyway. |
| `admin-section__head` | **8** in `Admin.tsx`; `Admin.dom.test.tsx:143`, `:393` |
| `admin-table` | **6** in `Admin.tsx`; `Admin.dom.test.tsx:98` |
| `admin-table__action` | **6** in `Admin.tsx`; `Admin.dom.test.tsx:183`, `:186`, `:248`, `:397`, `:431` |
| `admin-poison` | 3 in `Admin.tsx`; `Admin.dom.test.tsx:393`, `:397`, `:431` |
| `admin-stage-list` | 1 in `Admin.tsx`; `Admin.dom.test.tsx:139` (as rewritten by §9) |
| `admin-stage` | 1 in `Admin.tsx`; `Admin.dom.test.tsx:92`, `:137`, `:140` |
| `admin-stage__order` | 1 in `Admin.tsx`; `Admin.dom.test.tsx:138` |
| `create-project__hero-action` | 1 in `CreateProject.tsx`; `CreateProject.dom.test.tsx:119` |
| `create-project__actions` | 1 in `CreateProject.tsx`; `CreateProject.dom.test.tsx:49` |
| `create-project__checklist` / `create-project__check` | `create-project__checklist`: **2**, both on `ProjectFields.tsx:122`; `ProjectFields.dom.test.tsx:58`. `create-project__check`: **4** — `ProjectFields.tsx:110`, `:111` and two on `:122`; `ProjectFields.dom.test.tsx:59`. The `:109` hit is the separate `create-project__checks`, which is case **D** and must reach zero. *(Corrected from "2 + 2" and re-attributed 2026-09-02: the round-1 row listed `__check`'s four sites under `__checklist` and cited test lines `:57`/`:58`, which are `:58`/`:59`.)* |
| `signin` | 1 in `SignIn.tsx` (for `.signin::before`) |

Zero hits on any of these is a **finding**, not a success.

### 7.1 Legend

| Case | Meaning |
| --- | --- |
| **R** | **Retire the paint.** The `app.css` rule is deleted; the class name survives in the markup as a non-styling hook. Utilities own the paint. |
| **D** | **Delete outright.** Rule deleted *and* class name removed from every element. Zero remaining consumers. |
| **S** | **Split the consumer.** The rule survives for out-of-scope consumers; the class is removed from in-scope elements only. No in-scope element carries both the class and a competing utility. |
| **O** | **Structural override.** The rule survives and wins; a narrow `!`-prefixed utility beats one declaration. Every use is justified inline. |
| **K** | **Keep.** Rule and consumers untouched by this release. |

**There is no sixth case.** In particular, an ordinary (non-`!`) utility beside a surviving matching
`app.css` selector never appears in this diff — that is the TB8-03 defect, and §10.1 greps for it.

### 7.2 Tiny helpers — `app.css:19-28`

| # | Selector(s) | Case | Disposition |
| --- | --- | --- | --- |
| 1 | `.ey` (:20) | **S** | Out-of-scope consumers in 15 files (`atoms.tsx`, `Topbar.tsx`, `Lightbox.tsx`, `NoticeBoard.tsx`, `PhotoGrid.tsx`, `CollectionPanel.tsx`, `UploadDropzone.tsx`, `SubtaskChecklist.tsx`, `ExternalEditedUpload.tsx`, `ProjectKanbanBoard.tsx`, `ProjectCollaborationPanel.tsx`, `ProductionCalendar.tsx`, `ProductionCalendarFilters.tsx`, `ProjectWorkspace.tsx`, `NotificationPreferences.tsx`). Rule survives verbatim. All in-scope occurrences become `<Eyebrow>`. `ProjectFields.dom.test.tsx:56` queries `.ey` and is rewritten by §9. |
| 2 | `.muted` (:21) | **K** | No in-scope consumer — a raw `muted` search hits only out-of-scope files. Untouched. |
| 3 | `.serif` (:22) | **S** | 12 out-of-scope consumers. Per E-40 the class is deleted from every in-scope heading: `.pagehead h1` (:140), `.signin__title` (:887), `.admin-section__head h2` (:944), `.create-project__section-head h2` (:1022) and `.danger-zone h2` (:1201) all already set a `--type-h*` shorthand that carries `--font-display`, so the deletion is a zero-pixel change. Rule survives for `.empty .serif` (:740) and out-of-scope screens. |
| 4 | `.grow` (:28) | **K** | Tailwind name collision (§2.2). Zero in-scope consumers; the three that exist (`ProjectWorkspace.tsx`, `Topbar.tsx`, `PhotoGrid.tsx`) are out of scope, so it cannot bite this surface. Left exactly as TB8-03 left it, and named as a follow-up in §12. |

### 7.3 Page scaffolding — `app.css:138-141`

| # | Selector(s) | Case | Disposition |
| --- | --- | --- | --- |
| 5 | `.page` (:138) | **O** | The rule survives (Dashboard, ProjectWorkspace). Its `max-width: 1480px` is unlayered and beats any utility, so §5.4 uses `!max-w-[1280px]` on `Admin.tsx`'s `<main>` and `!max-w-[1080px]` on the two project forms, replacing `.admin-page` (:940) and `.create-project` (:1002). **These are the only two `!` utilities TB8-04 adds**, and they are the same `!` *pattern* applied twice. Its padding and centring are kept as-is — TB8-04 does not change the page gutter. |
| 6 | `.pagehead` (:139) | **S** | `ProjectWorkspace.tsx` is an out-of-scope consumer; the rule survives. In-scope headings drop the class and become §5.4's `PAGE_HEAD` `<header>`, which transcribes every declaration of this rule as utilities. Watch E-28: `.create-project__form`'s vertical rhythm depended on `.pagehead`'s `margin-bottom`, so dropping the class must be paired with the explicit gap §5.13 specifies. |
| 7 | `.pagehead h1` (:140) | **S** | Same. Safe under row 3 because this rule sets `--type-h1`, which already carries the display family. |
| 8 | `.toolbar` (:141) | **K** | No in-scope consumer (`ProductionCalendarToolbar.tsx`, `RichTextEditor.tsx`, `Lightbox.tsx` only). |

### 7.4 The tab family — `app.css:678-684`

| # | Selector(s) | Case | Disposition |
| --- | --- | --- | --- |
| 9 | `.ctab` (:679) | **D** | Only consumers in `portal/` are `Admin.tsx:411` and `Admin.tsx:469`; both become `TabStrip`. Rule deleted, class deleted. No hook needed: `Admin.dom.test.tsx` queries `.admin-tabs button`, `.admin-tabs > button` and `[role="tab"]`, never `.ctab`. |
| 10 | `.ctab:hover` (:680) | **D** | Same. |
| 11 | `.ctab.is-active` (:681) | **D** | Same; per E-39 its `border-bottom-color` is already dead on this screen, so deleting it removes nothing visible. `TabStrip` restores a real underline. |
| 12 | `.ctabs` (:678), `.ctab .cnt` (:682), `.ctab--premium` (:683), `.ctab--premium svg` (:684) | **K** | Already zero-consumer dead code belonging to the `.cbar` collections surface (§6.2). Left in place; follow-up in §12. |

### 7.5 Empty state — `app.css:739-740`

| # | Selector(s) | Case | Disposition |
| --- | --- | --- | --- |
| 13 | `.empty` (:739) | **S** | 21 out-of-scope consumers including `ProjectWorkspace.dom.test.tsx:170`. Rule survives. The 10 in-scope occurrences — 9 in `Admin.tsx` (`grep -c 'className="empty"'`) plus 1 in `ProjectFields.tsx` — become `<EmptyState>`, whose `--text-secondary` body fixes the 3.6:1 `--text-muted` failure (E-17's class of defect) without touching the shared rule. |
| 14 | `.empty .serif` (:740) | **K** | Depends on `.serif` surviving, which row 3 guarantees. |

### 7.6 Buttons — `app.css:865-881`

| # | Selector(s) | Case | Disposition |
| --- | --- | --- | --- |
| 15 | `.button` (:865-872) | **S** | 21 out-of-scope consumers. Rule survives; in-scope buttons take `<Button>` / `buttonClasses`, which TB8-01 already matched to this rule's geometry. |
| 16 | `.button:hover:not(:disabled)` (:873) | **S** | Same. |
| 17 | `.button:disabled` (:874) | **S** | Same. Note the legacy `cursor: wait`; `buttonClasses` uses `cursor-not-allowed` for a genuinely disabled control and keeps `wait` only for the busy state, which is what `isProvisioning`/`isOperating` actually mean. |
| 18 | `.button--secondary` (:875), `:hover` (:876) | **S** | Same. |
| 19 | `.button--danger` (:877), `:hover/:focus-visible` (:878) | **K** | Sole consumer `ConfirmDialog.tsx:15`, out of scope (§6.2). Untouched. |
| 20 | `.button--text` (:879), `:hover` (:880) | **S** | Same as row 15. |
| 21 | `.button__google` (:881) | **D** | Sole consumer `SignIn.tsx`, and §4.3 deletes the element itself — the 18px Arial "G" disc is the release's one removal. Rule and class both go, zero remaining consumers. |

### 7.6b Sign-in — `app.css:883-890`

*(Added 2026-09-02, Sol round 1 correctness 7: §5.5 specified this block's treatment in prose but
the ledger jumped straight from row 21 to row 22, so the "exhaustive" retirement table did not
actually cover the eight sign-in rules. The rows are lettered `21a`–`21h` rather than inserted as
`22`–`29` so that the other 130 numbered rows, and every cross-reference to them elsewhere in this
plan, keep their identities. The ledger stays ordered by `app.css` line either way.)*

Every rule here has **exactly one consumer, `SignIn.tsx`, which is in scope**, and **zero test
consumers** — verified by `grep -rn "signin" src --include='*.tsx' --include='*.ts'`, which returns
seven lines, all in `SignIn.tsx:21-32`, and no test file. So nothing in this block is shared, and
case **S** does not arise.

| # | Selector | Case | Disposition |
| --- | --- | --- | --- |
| 21a | `.signin` (:883) | **R** | The box rule (`min-height:100vh`, `display:grid`, `place-items:center`, `padding`, `background`, `position:relative`, `overflow:hidden`) is deleted; §5.5's utilities replace it on the `<main>`. **The class stays** — it is the anchor `.signin::before` selects through (row 21b). This is the release's one partial retirement: one of the two rules on a class goes and the other does not. `overflow-hidden` must be among the replacing utilities or the pinwheel escapes the viewport (§10.2 item 8). |
| 21b | `.signin::before` (:884) | **K** | The brand pinwheel. Kept untouched, for a visual reason rather than a deferral (§4.3, §5.5 item 3): a rotated repeating background image expressed as arbitrary utilities would be longer, less readable and no more correct. This is the only **K** in the plan that is not a deferral or an out-of-scope consumer. |
| 21c | `.signin__panel` (:885) | **D** | → `w-[min(100%,430px)] relative p-[var(--space-8)] bg-card [border-style:solid] border-[length:var(--border-width-hair)] border-border` (§5.5). Rule and class both go. *(Corrected from `bg-surface` 2026-09-02, Sol round 2: there is no `--color-surface` `@theme` entry — `tokens/tailwind.css:25` defines `--color-card`, and `bg-surface` would emit nothing. §5.5 already said `bg-card`.)* |
| 21d | `.signin__wordmark` (:886) | **D** | → `w-[min(238px,100%)] h-auto mb-[var(--space-8)]`. |
| 21e | `.signin__title` (:887) | **D** | → `[font:var(--type-h1)] max-[720px]:[font:var(--type-h2)] tracking-[var(--tracking-tight)] mb-[var(--space-4)]`, replacing the off-scale `clamp(38px, 6vw, 52px)` (E-15, §5.5 item 1). The `id="sign-in-title"` that `SignIn.tsx:22`'s `aria-labelledby` points at is **not** a styling hook and stays (§8). |
| 21f | `.signin__copy` (:888) | **D** | → the class string at §5.5's table row for `<p>`. |
| 21g | `.signin__action` (:889) | **D** | `width: 100%` → `w-full` on the `buttonClasses("primary")` element. |
| 21h | `.signin__note` (:890) | **D** | → `mt-[var(--space-4)] [font:var(--type-eyebrow)] tracking-[var(--tracking-wide)] text-foreground-secondary`. The `--text-muted` it currently paints is one of E-17's sub-4.5:1 roles, so this row is an accessibility fix, not only a convergence. |

`.signin__brand`, `.signin__actions` and `.signin__foot` are **not** in this table because they do
not exist — they appear in no rule and on no element. Any §7 row for them would be inventing work.

### 7.7 Notice — `app.css:891`

| # | Selector(s) | Case | Disposition |
| --- | --- | --- | --- |
| 22 | `.notice` (:891) | **S** | Out-of-scope consumers in `NoticeBoard.tsx`, `ProjectDiscussionThread.tsx`, `ProjectDeadlineControl.tsx`, `ProjectActivityView.tsx` and `ProductionCalendar.tsx`. Rule survives. Every in-scope occurrence — `Admin.tsx` (6), `CreateProject.tsx`, `EditProject.tsx`, `SignIn.tsx`, `ProjectFields.tsx`; 11 in total — becomes `<Notice>`, preserving its `role="alert"` verbatim. |

### 7.8 The `.sr-only` duplicate — `app.css:937` and `app.css:1046`

| # | Selector(s) | Case | Disposition |
| --- | --- | --- | --- |
| 23 | `.sr-only` (:937) | **K** | Byte-identical to :1046 and shadows Tailwind's own `sr-only` utility (§2.2's second surviving collision). Because the legacy declaration and the utility are functionally equivalent, the collision is non-symptomatic, and this surface has 8 consumers that all behave correctly today. |
| 24 | `.sr-only` (:1046) | **K** | The duplicate. Deleting it is already assigned to ranking candidate #10 by TB8-02 §11.2. TB8-04 deletes **neither** declaration, and §10.1 asserts both still exist, so this release cannot silently absorb another candidate's cleanup. |

### 7.9 Administration — `app.css:940-997`

Every rule in this 58-line block is disposed of. Unless a row says otherwise, the class name is
**deleted from the markup** along with the rule; rows marked **R** keep the name as a hook and name
the test that requires it.

| # | Selector(s) | Case | Disposition |
| --- | --- | --- | --- |
| 25 | `.admin-page` (:940) | **D** | Replaced by `!max-w-[1280px]` on `.page` (row 5). |
| 26 | `.admin-tabs` (:941) | **R** | `TabStrip`'s root carries the paint. Class kept as a hook for `Admin.dom.test.tsx:85` and `:289` — and because `:289` is `.admin-tabs > button`, **`TabStrip` must render its buttons as direct children of the element carrying this class** (§8). |
| 27 | `.admin-tabs .ctab` (:942) | **D** | The `border: 0` that killed the selected-state underline (E-39). Deleted; `TabStrip` owns the underline. |
| 28 | `.admin-section__head` (:943) | **R** | Class kept for `Admin.dom.test.tsx:143` and `:393`. `SectionHead` supplies the flex layout. |
| 29 | `.admin-section__head h2` (:944) | **D** | The 34px off-scale heading (E-15) → `--type-h3` (28px). |
| 30 | `.admin-provision` (:945) | **D** | Five-column grid → §5.8's three-tier `grid-cols-*`, same breakpoints. |
| 31 | `.admin-provision__copy` (:946) | **D** | |
| 32 | `.admin-provision__copy p` (:947) | **D** | The 13.5px sub-pixel body size (E-16) → `--text-sm` (14px). |
| 33 | `.admin-field` (:948) | **D** | Replaced by `Field` + `FieldLabel`, which is what closes E-5's missing programmatic association. |
| 34 | `.admin-field input, .admin-field select, .admin-role-select` (:949) | **D** | Replaced by `FIELD_BOX` (§5.1). Per E-3 the geometry is unchanged; per E-37 the ground moves from `--paper-050` to `--field-bg`. |
| 35 | `.admin-field input:focus, select:focus, .admin-role-select:focus` (:950) | **D** | **`outline: none` — the E-11 defect.** Deleted. `FIELD_BOX`'s `focus-visible:outline-*` replaces it with a real 2px ring at `--focus-ring`. |
| 36 | `.admin-field input[aria-invalid="true"]` (:951) | **D** | → `aria-invalid:border-destructive` in `FIELD_BOX`. |
| 37 | `.admin-field small` (:952) | **D** | → `FieldError`, which adds the `role="alert"` and `id` wiring the bare `<small>` never had. |
| 38 | `.quincy-input:focus, .quincy-input:focus-visible` (:953-957) | **D** | The second `outline: none` (E-11). Per E-38, `ui/input.tsx` has two importers and `QuincyField` one product consumer, all in scope, and **no test queries `.quincy-input`** — so the class name is removed from `Input` and this rule has zero remaining consumers. |
| 39 | `.quincy-input[aria-invalid="true"]` (:958) | **D** | Same; folded into `FIELD_BOX`. |
| 40 | `.admin-table-wrap` (:959) | **D** | → `TableWrap`. No test queries it. |
| 41 | `.admin-table` (:960) | **R** | Class kept for `Admin.dom.test.tsx:98` (`.admin-table tbody tr`), which also requires `TableBody` to render a real `<tbody>`. |
| 42 | `.admin-table th` (:961) | **D** | → `TableHeader`, which bakes in `scope="col"` (**E-9**, not E-19 — corrected 2026-09-02, Sol round 2) and `role="columnheader"`. |
| 43 | `.admin-table td` (:962) | **D** | → `TableCell`. |
| 44 | `.admin-table tbody tr:last-child td` (:963) | **D** | → `min-[721px]:[&>tr:last-child>td]:border-b-0` on `TableBody`, per §5.6's exact implementation. *(Corrected 2026-09-02, Sol round 2: this row previously said `last:[&>td]:border-b-0`, which is a different selector — `last:` on `TableBody` targets the body, not its last row — and lacked the `min-[721px]:` guard the stacked-card mode needs.)* |
| 45 | `.admin-table td strong` (:964) | **D** | The `font-weight: 400` reset on `<strong>`; §5.6 keeps the same visual result via `TableCell`. |
| 46 | `.admin-table__action` (:965) | **R** | Class kept for `Admin.dom.test.tsx:183`, `:186`, `:248`, `:397`, `:431`. Note `:248` is `[class*="admin-table__action"] button:last-child`, so the class must remain on the `<td>` itself, not move to a wrapper. |
| 47 | `.admin-role-select` (:966) | **D** | → `NativeSelect`. |
| 48 | `.admin-status` (:967) | **D** | → `PILL_BASE`; the 10px off-scale size (E-17) becomes `--text-2xs` (11px). |
| 49 | `.admin-status--active, .admin-status--connected` (:968) | **D** | → the `positive` tone. |
| 50 | `.admin-status--inactive, --disconnected, --not-configured` (:969) | **D** | → the `neutral` tone. **This row is E-17's contrast fix**: the legacy `--text-muted` on `--paper-000` is 3.6:1; the neutral tone uses `--text-secondary` at 9.2:1. |
| 51 | `.admin-status--expired` (:970) | **D** | → the `caution` tone. |
| 52 | `.admin-status--error` (:971) | **D** | → the `critical` tone. |
| 53 | `.integration-grid` (:972) | **D** | → §5.11's three-tier grid, same breakpoints as :1067 and :1050. |
| 54 | `.integration-card` (:973) | **D** | The `min-height: 270px` is dropped (§5.11) — grid already equalises row heights. |
| 55 | `.integration-card__top` (:974) | **D** | |
| 56 | `.integration-card h3` (:975) | **D** | 28px literal → `--type-h3`, which is 28px. Zero-pixel change, now traceable. |
| 57 | `.integration-card > p` (:976) | **D** | The `min-height: 42px` spacer is dropped with row 54. |
| 58 | `.integration-card .button` (:977) | **D** | → `mt-auto self-start` on the button (§5.11). |
| 59 | `.integration-meta` (:978) | **D** | |
| 60 | `.integration-meta div` (:979) | **D** | |
| 61 | `.integration-meta dt` (:980) | **D** | 10px `--text-muted` → `Eyebrow` at `--text-xs` / `--text-secondary`. |
| 62 | `.integration-meta dd` (:981) | **D** | 13px → `--text-sm`. |
| 63 | `.admin-notice` (:982) | **D** | → `Notice`'s own top margin. |
| 64 | `.admin-directory-form` (:983) | **D** | Four-column grid → §5.9's three-tier grid. |
| 65 | `.admin-agent-form` (:984) | **D** | Five-column grid → §5.9's three-tier grid. |
| 66 | `.admin-table__empty` (:985) | **D** | → `<TableCell colSpan={…} className="text-center text-foreground-secondary">`, exactly as §5.9 specifies. *(Corrected 2026-09-02, slice-3 review: this row previously said `EmptyState` inside a full-span `TableCell`, which contradicted §5.9's own sample. `EmptyState` renders a display-face title and body copy — right for a whole panel, wrong for one row of a table that still has its column headers above it.)* |
| 67 | `.admin-table tbody tr.is-selected td` (:986) | **D** | E-18: selection was a 6% green tint alone. Replaced by `data-selected` on `TableRow`, which adds a left rule and `aria-selected`, not just a hue. |
| 68 | `.admin-inline-input` (:987) | **D** | → `Input` with `min-w-[130px] border-[var(--field-border)]`. **One of the two sites where `--field-border` (ink) is used deliberately** (§5.8). |
| 69 | `.admin-subsection` (:988) | **D** | → `mt-[var(--space-8)]`. |
| 70 | `.admin-stage-list` (:989) | **R** | Class kept for `Admin.dom.test.tsx:139` as §9 rewrites it (`.admin-stage-list + button`). |
| 71 | `.admin-stage` (:990) | **R** | Class kept for `Admin.dom.test.tsx:92`, `:137`, `:140`. Grid template moves to utilities at the same two breakpoints (:1051). |
| 72 | `.admin-stage__order` (:991) | **R** | Class kept for `Admin.dom.test.tsx:138`, which asserts the textContent sequence `1…5`. |
| 73 | `.admin-stage strong, .admin-stage small` (:992) | **D** | |
| 74 | `.admin-stage strong` (:993) | **D** | |
| 75 | `.admin-stage small` (:994) | **D** | 11px → `--text-2xs` (11px). Zero-pixel, now traceable. |
| 76 | `.admin-toggle` (:995) | **S** | **Corrected from D, 2026-09-02.** This rule has a live out-of-scope consumer: `screens/NotificationPreferences.tsx:22` carries `className="admin-toggle"`, and that screen is deferred to candidate #5 (§1.2). Deleting the rule would silently unstyle it — the exact failure this plan's §7 case **S** exists to prevent. So: **the `app.css:995` rule survives untouched**, and the class is removed only from the in-scope element, `Admin.tsx:430`'s `<label className="admin-toggle admin-impersonation-toggle">`, which becomes `TOGGLE_ROW` (§5.2) and also gains a 44px checkbox target at `max-[720px]`. `NotificationPreferences.tsx` is not edited. Per case **S**, no in-scope element carries both the class and a competing utility. |
| 77 | `.admin-poison` (:996) | **R** | Class kept for `Admin.dom.test.tsx:393`, `:397`, `:431`, all of which key off `.admin-poison[aria-label="…"]` — so **both the class and the `aria-label` must stay on the same element** (§8). |
| 78 | `.admin-warning` (:997) | **D** | **E-6:** `color: var(--signal-negative)` — a token that does not exist in `tokens/colors.css`, so this text has been inheriting its parent's colour since it shipped. Replaced by `text-destructive` at `--text-2xs`. |

The comment at `app.css:998-999` (recording that `.admin-modal*` was absorbed into the shared
`Modal` by TB8-02) is left in place — it documents a prior release, not this one.

### 7.10 New shoot and shared project fields — `app.css:1002-1045`

Every consumer of this block is in scope: a raw `create-project` search returns `CreateProject.tsx`,
`EditProject.tsx` and `ProjectFields.tsx` only. (`App.tsx:26`, `:50`, `:102` and `Topbar.tsx:12` are
the route-kind string `"create-project"`, not a class — verified by reading each line.) **The entire
block is therefore retirable**, and rows below marked **R** keep only the four class names that
tests query.

| # | Selector(s) | Case | Disposition |
| --- | --- | --- | --- |
| 79 | `.create-project` (:1002) | **D** | → `!max-w-[1080px]` on `.page` (row 5). |
| 80 | `.create-project__form` (:1003) | **R** | **Corrected from D, 2026-09-02 (Sol round 1, correctness 1).** Paint retires to `flex flex-col gap-[var(--space-8)]` — the gap change is E-28's fix — but **the class name stays on the element**: `ProjectCollaborationPanel.dom.test.tsx:1018` asserts `editor.querySelector(".create-project__form")` is not null, and §9 does **not** edit that line — it is an out-of-scope test and the class must keep matching it. (`:1020`'s `.pagehead + .create-project__form` is a different matter: its `.pagehead` half dies with row 6, so §9.4 authorizes retargeting that one assertion to `header + .create-project__form` — the adjacency guard survives, only the left-hand selector changes. The `.create-project__form` half of it is untouched either way, which is the same reason this row is **R**.) Hook added to §7.0's expected-hit inventory. |
| 81 | `.create-project__hero` (:1004) | **D** | |
| 82 | `.create-project__hero h2` (:1005) | **D** | `--type-display` at `clamp(36px,5vw,58px)` → §5.13's clamp between real scale steps. |
| 83 | `.create-project__hero-action` (:1006) | **R** | Class kept for `CreateProject.dom.test.tsx:119`. |
| 84 | `.create-project__address input` (:1007) | **D** | 58px / 25px / `border-radius: 0` (E-35) → `min-h-[var(--space-7)]` (48px) and `--text-lg` (22px). **The second deliberate `--field-border` site** (§5.13). |
| 85 | `.create-project__address input::placeholder` (:1008) | **D** | → `placeholder:text-foreground-secondary` in `FIELD_BOX`, which raises the placeholder from 3.6:1 to 9.2:1. |
| 86 | `.create-project__address input:focus` (:1009) | **D** | **E-12:** `outline: 2px solid var(--signal-positive)` — the only green focus ring in the app, and it fires on `:focus` rather than `:focus-visible`, so it appears on mouse click too. Replaced by `FIELD_BOX`'s `focus-visible` ring at `--focus-ring`. |
| 87 | `.create-project__hero-action .button` (:1010) | **D** | → `min-h-[var(--space-7)]` on the submit. |
| 88 | `.create-project__hero-error` (:1011) | **D** | → `FieldError`. |
| 89 | `.create-project__refinements` (:1012) | **D** | |
| 90 | `.create-project__refinements em` (:1013) | **D** | |
| 91 | `.create-project__hero p` (:1014) | **D** | |
| 92 | `.create-project__details` (:1015) | **D** | |
| 93 | `.create-project__details summary` (:1016) | **D** | §5.13 adds the focus-visible ring the bare `<summary>` never had. |
| 94 | `.create-project__details summary span` (:1017) | **D** | |
| 95 | `.create-project__details[open] summary` (:1018) | **D** | |
| 96 | `.create-project__detail-content` (:1019) | **D** | |
| 97 | `.create-project__section` (:1020) | **R** | **Corrected from D, 2026-09-02 (Sol round 1, correctness 1).** **The §4.2 risk lives here**: this is the white card that is being removed, and reversal is still one line per §4.2's containment. But the class name stays on the `<section>`: `ProjectFields.test.ts:79` matches the exact string `<section class="create-project__section" aria-labelledby="client-heading">`, and §9 explicitly keeps that line unedited. Paint retires; the hook and the exact attribute string do not. Because that locator matches the **whole** `class` attribute, this element is the one place in the release where the class attribute must stay *bare* — no utilities may be added to the Client `<section>` itself; §5.14 puts its two tokens on the inner grid instead. Hook added to §7.0's expected-hit inventory. |
| 98 | `.create-project__section-head` (:1021) | **D** | → `SectionHead`. |
| 99 | `.create-project__section-head h2` (:1022) | **D** | 29px off-scale → `--type-h3` (28px). |
| 100 | `.project-fields__section--readonly` (:1023) | **D** | |
| 101 | `.project-fields__readonly-note` (:1024) | **D** | 13px → `--text-sm`. |
| 102 | `.project-fields__section--readonly .admin-field input[readonly], … textarea[readonly]` (:1025) | **D** | → `read-only:` variants in `FIELD_BOX`, which is why row 34 had to carry them. |
| 103 | `.project-fields__section--readonly .create-project__check` (:1026) | **D** | → `has-[:disabled]:` variants on `CHECK_TILE`. |
| 104 | `… .create-project__check:hover` (:1027) | **D** | Same; the hover-suppression is `has-[:disabled]:hover:bg-surface-sunken`. |
| 105 | `… .create-project__check input:disabled` (:1028) | **D** | Same. |
| 106 | `.create-project__fields` (:1029) | **D** | → `FIELD_GRID_4`. |
| 107 | `.create-project__fields--property` (:1030) | **D** | → `FIELD_GRID_PROPERTY`. |
| 108 | `.create-project__fields--two` (:1031) | **D** | → `FIELD_GRID_2`. |
| 109 | `.create-project__checklist` (:1032) | **R** | Class kept for `ProjectFields.dom.test.tsx:58`. |
| 110 | `.create-project__checks` (:1033) | **D** | *(Sol round 2, new finding 5 — §5.14 and this row disagreed. Resolved in favour of **D**, and §5.14 was corrected: no test queries this class. The round-1 row's "→ real borders" gloss was separately wrong and is gone.)* The 1px-gap technique is **kept**, not replaced: → `grid gap-[1px] bg-border border-solid border-[length:var(--border-width-hair)] border-border grid-cols-1`, the exact utilities in §5.14. Class removed from the wrapper. |
| 111 | `.create-project__check` (:1034) | **R** | Class kept for `ProjectFields.dom.test.tsx:59` (`label.create-project__check`), so **the class must stay on the `<label>`**. |
| 112 | `.create-project__check:hover` (:1035) | **D** | |
| 113 | `.create-project__check input` (:1036) | **D** | The 15px box → 18px (§5.14). `accent-color: var(--ink-900)` already shipped here and is preserved in `CHECKBOX_INPUT`. |
| 114 | `.create-project__check input:disabled` (:1037) | **D** | |
| 115 | `.create-project__check span` (:1038) | **D** | → `flex min-w-0 flex-col gap-[var(--space-1)]`. **This adds a `class` attribute to a `<span>` that `ProjectFields.test.ts:66` matches as bare `<span>`** — §9 rewrites that regex. |
| 116 | `.create-project__check strong` (:1039) | **D** | **E-13:** `font-weight: 500` against a family that ships **only 400**, i.e. synthesised faux-bold. → `--weight-regular`; the tile's hierarchy comes from the `<small>` beneath going `text-foreground-secondary` (§5.14). *(Corrected 2026-09-02: this row said `--weight-bold`, which is the same bug — see E-13.)* |
| 117 | `.create-project__check small, .create-project__checklist p` (:1040) | **D** | The rule is deleted outright; `TILE_HINT` and `CHECKLIST_EMPTY` (§5.14) carry the two treatments, the latter adding the `bg-card` its `bg-border` ground now needs. Both class names stay on their elements as `ProjectFields.dom.test.tsx:58-59` selector hooks — that is a hook, not a paint survival, so it does not make this case S. *(Restored to **D** 2026-09-03, reverting the 2026-09-02 slice-2 reclassification — see the correction row in §7.13.)* |
| 118 | `.create-project__team` (:1041) | **D** | → `FIELD_GRID_2`. *(Sol round 2, new finding 5 — §5.14's prose called this a surviving hook while the row said delete. Resolved in favour of **D**: `ProjectFields.dom.test.tsx` reaches the team checklists through `.ey` and `.create-project__checklist`, never through this wrapper. §5.14 corrected.)* |
| 119 | `.create-project__team-state` (:1042) | **D** | |
| 120 | `.create-project textarea` (:1043) | **D** | → `Textarea`. |
| 121 | `.create-project textarea:focus` (:1044) | **D** | The third `outline: none` (E-11). |
| 122 | `.create-project__actions` (:1045) | **R** | Class kept for `CreateProject.dom.test.tsx:49`. |

### 7.11 The two responsive blocks — `app.css:1048-1062` and `:1064-1071`

Every in-scope rule here is reproduced as a `max-[720px]:` or `min-[721px]:max-[1080px]:` variant at
**the same pixel breakpoints**, so the responsive matrix of §5.17 is a like-for-like port, not a
redesign. The two exceptions are stated in the rows.

| # | Selector(s) | Case | Disposition |
| --- | --- | --- | --- |
| 123 | `.signin__panel` (:1049) | **D** | → `max-[720px]:p-[var(--space-6)]`. |
| 124 | `.admin-provision, .integration-grid, .admin-directory-form, .admin-agent-form` (:1050) | **D** | → `max-[720px]:grid-cols-1` on each of the four. |
| 125 | `.admin-stage` (:1051) | **D** | → `max-[720px]:grid-cols-[28px_1fr]`. |
| 126 | `.admin-stage .admin-field` (:1052) | **D** | → `max-[720px]:col-span-full` on the stage row's field. |
| 127 | `.admin-provision__copy` (:1053) | **D** | → `max-[720px]:mb-[var(--space-2)]`. |
| 128 | `.admin-section__head` (:1054) | **D** | → `max-[720px]:items-start`. |
| 129 | `.create-project__fields, --property, --two, __checks, __team` (:1055) | **D** | → `max-[720px]:grid-cols-1` inside each of the five grid constants. |
| 130 | `.create-project__section` (:1056) | **D** | The section padding at ≤720. Under §4.2 the section no longer has a card, so this becomes the section's own `max-[720px]` inset rather than card padding; §5.17 states the value. |
| 131 | `.create-project__hero-action, .create-project__refinements` (:1057) | **D** | → `max-[720px]:grid-cols-1`. |
| 132 | `.create-project__hero-action .button` (:1058) | **D** | → `max-[720px]:w-full` on the hero submit. |
| 133 | `.document-group` (:1059), `.document-preview` (:1060), `.document-group__head` (:1061) | **K** | Out of scope. **The `@media (max-width: 720px)` block at `:1048` therefore survives**, containing only these three rules after rows 123-132 are removed. It must not be deleted. |
| 134 | `.admin-provision` (:1065) | **D** | → `min-[721px]:max-[1080px]:grid-cols-2`. |
| 135 | `.admin-provision__copy` (:1066) | **D** | → `min-[721px]:max-[1080px]:col-span-full`. |
| 136 | `.integration-grid` (:1067) | **D** | → `min-[721px]:max-[1080px]:grid-cols-1`. |
| 137 | `.admin-directory-form, .admin-agent-form` (:1068) | **D** | → `min-[721px]:max-[1080px]:grid-cols-2`. |
| 138 | `.create-project__fields` (:1069) | **D** | → `min-[721px]:max-[1080px]:grid-cols-2` in `FIELD_GRID_4`. |
| 139 | `.create-project__checks` (:1070) | **D** | → `min-[721px]:max-[1080px]:grid-cols-3`. |

**Rows 134-139 empty the `@media (max-width: 1080px) and (min-width: 721px)` block entirely, so the
block itself (`app.css:1064-1071`) is deleted.** This is the one whole-block deletion in the release
and §10.1 asserts it, because an empty `@media` left behind is the tell that a rule was missed.

### 7.12 Edit shoot and the danger zone — `app.css:1199-1209`

| # | Selector(s) | Case | Disposition |
| --- | --- | --- | --- |
| 140 | `.edit-project__archived` (:1199) | **D** | 10px caution badge → `StatusPill` at the `caution` tone, `--text-2xs`. Sole consumer `EditProject.tsx`. |
| 141 | `.danger-zone` (:1200) | **D** | The oxblood-tinted card. **This border stays** — §4.2's "a border means a bounded data object" rule keeps the danger zone bounded, because here the border *is* the warning. |
| 142 | `.danger-zone h2` (:1201) | **D** | 29px off-scale → `--type-h3` (28px). |
| 143 | `.danger-zone__action, .danger-zone__delete` (:1202) | **D** | → the grid of §5.15, keeping the `color-mix(… --signal-critical 28% …)` top divider verbatim as `border-t-signal-critical/28`. |
| 144 | `.danger-zone strong` (:1203) | **D** | **E-13** again: `font-weight: 500` → `--weight-regular` (§5.15); the danger zone's emphasis is its oxblood rule and `text-destructive` heading, not a weight `--font-sans` does not have. *(Corrected 2026-09-02 with row 116.)* |
| 145 | `.danger-zone p` (:1204) | **D** | 13.5px sub-pixel → `--text-sm`. |
| 146 | `.danger-zone__delete` (:1205) | **D** | → `min-[721px]:grid-cols-[minmax(0,1fr)_minmax(220px,0.7fr)_auto]`. |
| 147 | `.danger-zone__button` (:1206) | **D** | → `buttonClasses("danger")`. *(Corrected from `"destructive"`, 2026-09-02: `ButtonVariant` is `"primary" \| "secondary" \| "danger" \| "text"`, `components/ui/button.tsx:5`. §5.15 already said `"danger"`.)* |
| 148 | `.danger-zone__button:hover:not(:disabled)` (:1207) | **D** | Same; the `color-mix(… 84% … --ink-900)` hover is preserved by §5.15. |
| 149 | `.danger-zone__notice` (:1208) | **D** | → `Notice` at the `positive` tone. |
| 150 | `.danger-zone__action, .danger-zone__delete` / `.danger-zone__action` / `.danger-zone__action .button, .danger-zone__delete .button` inside the `@media (max-width: 720px)` at (:1209) | **D** | Three rules → `max-[720px]:items-stretch`, `max-[720px]:grid-cols-1` and `max-[720px]:w-full` in §5.15. |
| 151 | `.project-collaboration__wrap` inside the same `@media` at (:1209) | **K** | Out of scope. **The media block at `:1209` therefore survives** with only this rule; it must not be deleted. |

### 7.13 What §7 adds up to

**159 dispositions — 151 numbered plus the eight lettered `21a`–`21h` of §7.6b — covering 187
individual selectors** (16 rows group selectors that `app.css` declares together). By case:
**120 D** (deleted outright), **15 R** (paint retired, class kept as a named hook), **12 S** (split
— the rule survives for its out-of-scope consumers), **11 K** (untouched), and **1 O** (narrow `!`
utilities that beat an unlayered rule). 120 + 15 + 12 + 11 + 1 = 159.

**Case O now covers two situations, not one.** Its original instance is the `.page` max-width
override. The Sol whole-branch round added the second: `tokens/base.css` is imported **outside any
`@layer`** — exactly like `app.css` — so its `h1, h2, h3, h4 { margin: 0 }` and `p { margin: 0 }`
beat every margin utility Tailwind emits into `@layer utilities`. Ten non-zero margin declarations
this release puts on a heading or paragraph therefore computed to zero. Each now carries a leading
`!`, with a comment at the site giving this reason. Making `base.css` layered would be the root
fix, but it changes the cascade for the entire app — `a { color: inherit }`, `:focus-visible`,
`::selection` — and is far outside TB8-04's blast radius; it is **not** attempted here.

*(Recomputed 2026-09-02 after Sol rounds 1 and 2. Four corrections were made; three moved the
totals and the fourth was resolved on the §5 side. Each is recorded on its own §7 row rather than
only here:*

| Change | Effect on totals |
| --- | --- |
| Row 76 `.admin-toggle` **D → S** — a consumer sweep found `NotificationPreferences.tsx:22`, an out-of-scope file, carrying the class. The same sweep checked every other **D** selector against every out-of-scope `className` in `src/` and found no second instance, so this is isolated, not systemic. | −1 D, +1 S |
| Row 80 `.create-project__form` **D → R** — `ProjectCollaborationPanel.dom.test.tsx:1018` needs the hook. | −1 D, +1 R |
| Row 97 `.create-project__section` **D → R** — `ProjectFields.test.ts:79` matches the whole class attribute, so the class stays and stays *bare*. | −1 D, +1 R |
| §7.6b added, rows `21a`–`21h` — the eight `app.css:883-890` sign-in rules had no dispositions at all, so the ledger was not the exhaustive document it claimed to be. Six **D**, one **R** (`.signin`, class kept as the pinwheel's anchor), one **K** (`.signin::before`). | +6 D, +1 R, +1 K |
| Rows 110 `.create-project__checks` and 118 `.create-project__team` — §7 said **D** while §5.14's prose called both surviving test hooks. *(Sol round 2, new finding 5.)* Resolved in favour of **D**, because the claim was false: `ProjectFields.dom.test.tsx:55-62` queries `.ey` (`:56`), `.create-project__checklist` (`:58`) and `label.create-project__check` and never touches either wrapper class. §5.14 and its exact sample were corrected instead of the rows. | no change (0) |
| ~~Row 117 `.create-project__check small, .create-project__checklist p` **D → S**~~ — **reverted 2026-09-03; see the row below.** | ~~−1 D, +1 S~~ (withdrawn) |
| Row 117 **S → D**, restoring the original disposition. The 2026-09-02 reclassification misread §7.1's legend: case **S** is *"the rule survives for an **out-of-scope** consumer"*, and a consumer sweep now confirms `ProjectFields.tsx` is the **only** file in `src/` carrying either `create-project__check` or `create-project__checklist`. Diverging *Tailwind* treatments between two **in-scope** elements is not case S — it is two ordinary **D** replacements, which is what `TILE_HINT` and `CHECKLIST_EMPTY` already are. Leaving the rule alive had a live consequence, not just a bookkeeping one: because `app.css` is imported outside any `@layer`, `color: var(--text-muted); font-size: 12px; line-height: 1.35` silently beat both constants' own colour, size and leading utilities. *(Sol whole-branch round, finding 2. This also settles the open question slice 4 raised — §7.1's **S** does **not** stretch to "shared rule, diverging in-scope treatments"; reading it that way is what produced this defect.)* | +1 D, −1 S |

*Running the arithmetic: the pre-review figures were 116 D / 12 R / 12 S / 10 K / 1 O = 151; after
the three round-1 case changes, 114 D / 14 R / 12 S / 10 K / 1 O = 151; after §7.6b, 120 / 15 / 12
/ 11 / 1 = 159; round 2's finding 5 was resolved on the §5 side and moved no cell; slice-2 review's
row 117 gave 119 / 15 / 13 / 11 / 1 = 159; and the Sol whole-branch round's reversal of that same
row returns it to **120 / 15 / 12 / 11 / 1 = 159** — the §7.6b figure, which was right all along.
Verified by counting the disposition cells in §7.2–§7.12 directly rather than by hand-tallying the
deltas.)*

After the branch lands, `app.css` loses roughly 140 rules and gains none. Two `@media` blocks are
partially emptied and survive (rows 133 and 151); one is fully emptied and is deleted (rows
134-139).

**The closing grep gates on the finished diff.** Each must return exactly what is stated:

```
cd portal/apps/web

# 1. Every class whose rule was deleted outright is gone from src/ too.
#    Expect: zero hits for each.
for n in admin-page admin-provision admin-field admin-role-select admin-status \
         admin-table-wrap admin-notice admin-directory-form admin-agent-form \
         admin-table__empty admin-inline-input admin-subsection \
         admin-warning integration-grid integration-card integration-meta \
         quincy-input '\bctab\b' button__google signin__panel signin__title \
         signin__copy signin__action signin__note signin__wordmark \
         edit-project__archived danger-zone project-fields__section--readonly \
         project-fields__readonly-note create-project__checks create-project__team \
         create-project__team-state; do
  printf '%-38s %s\n' "$n" "$(grep -rlE "$n" src --exclude-dir=node_modules | tr '\n' ' ')"
done
# `\bctab\b` rather than `ctab`: a bare search matches the substring inside
# `selectable={false}` in ProductionCalendar.tsx and reports a false consumer.
# `admin-toggle` is deliberately NOT in this list — it is case S (row 76), not D.
# Gate 1b below asserts the split instead.

# 1b. The `.admin-toggle` split (row 76). Three assertions, all required:
grep -c '^\.admin-toggle' src/styles/app.css              # expect 1 — rule survives
grep -c 'admin-toggle' src/screens/Admin.tsx              # expect 0 — class removed in scope
grep -c 'admin-toggle' src/screens/NotificationPreferences.tsx   # expect 1 — untouched
git diff --numstat -- src/screens/NotificationPreferences.tsx    # expect no output at all
# The last one is the point: a case-S split must not edit the out-of-scope consumer.

# 1c. Row 117 is a real D, not a survival (added 2026-09-03, Sol whole-branch round finding 2).
#     The rule is gone from app.css, but BOTH class names stay in ProjectFields.tsx as the
#     selector hooks gate 2 asserts. Deleting the classes as well would break the dom test;
#     keeping the rule would let unlayered app.css beat TILE_HINT and CHECKLIST_EMPTY.
grep -c '^\.create-project__check' src/styles/app.css          # expect 0 — rule deleted.
#   Anchored to a declaration, not a bare mention: the deletion leaves a comment behind that
#   names the selector, and an unanchored grep matches that comment and reports a false survivor.
grep -rl 'create-project__check' src --include='*.tsx'         # expect exactly two files:
                                                               #   ProjectFields.tsx (paint hook)
                                                               #   ProjectFields.dom.test.tsx (query)

# 1d. Case O, group 2: no non-zero margin utility sits unprefixed on an h1-h4 or p, where the
#     unlayered `tokens/base.css` `margin: 0` would silently zero it. Expect: no output.
for p in $(git diff --name-only | grep 'apps/web/src.*\.tsx$' | sed 's|.*/src/||'); do
  perl -ne 'if (/<(h[1-4]|p)\b[^>]*className=(?:"([^"]*)"|\{cn\(\s*"([^"]*)")/) {
      my ($t,$c)=($1,($2//$3));
      my @m = ($c =~ /(?<![\w:!\/-])(-?m[trblxyse]?-\[[^\]]+\]|-?m[trblxyse]?-(?!0\b)[\w.]+)/g);
      print "$ARGV:$.: <$t> @m\n" if @m; }' "src/$p"
done
# The three margin constants are checked separately, since they are not inline on the tag:
grep -nE '^const (SECTION_NOTE|DANGER_COPY)' src/components/ProjectFields.tsx src/screens/EditProject.tsx
#   expect both to lead with `!mt-`/`!mb-`.

# 2. Every kept hook is still present, with the hit counts of §7.0's inventory.
#    Expect: the exact files and lines listed there. Zero hits is a FINDING.
for n in admin-tabs admin-section__head admin-table admin-table__action admin-poison \
         admin-stage-list admin-stage admin-stage__order \
         create-project__hero-action create-project__actions \
         create-project__checklist create-project__check signin; do
  printf '%-34s %s\n' "$n" "$(grep -rl "$n" src --exclude-dir=node_modules | tr '\n' ' ')"
done

# 3. No empty @media block survives in app.css. Expect: no output.
perl -0ne 'print "EMPTY MEDIA: $1\n" while /(\@media[^{]*\{\s*\})/g' src/styles/app.css

# 3b. The two partially-emptied blocks survive with exactly their kept rules.
#     Expect: the :1048 block contains only .document-group / .document-preview /
#     .document-group__head, and the :1209 block only .project-collaboration__wrap.
#     NOTE (2026-09-03, gate run on the finished branch): those two line numbers are the
#     PRE-deletion ones. §7 removes 142 lines from this file, so on the finished branch the
#     same two blocks are at **:941** and **:1073**. Both were verified to hold exactly the
#     rules named above and nothing else. Match on contents, not on the stale line number.
grep -n '@media (max-width: 720px)' src/styles/app.css

# 4. The two .sr-only declarations both still exist. Expect: 2.
grep -c '^\.sr-only' src/styles/app.css

# 5. .grow is untouched. Expect: 1, at line 28.
grep -n '^\.grow' src/styles/app.css
```

---

## 8. Behavioural invariants and risks

**Styling and markup change; logic does not.** No hook, handler, query key, mutation, capability
expression, route or piece of state is edited by TB8-04. The risks below are the places where a
*markup* change can nevertheless alter behaviour, and each carries a guard the builder must apply
and Sol must check.

**The one authorized exception: `TabStrip`'s keyboard and focus contract.** *(Added 2026-09-03 —
Sol whole-branch round, finding 3. The sentence above was written before §5.2 existed and was
false as stated; this paragraph is the correction, not a widening of scope.)* Adopting the ARIA
tabs pattern necessarily adds keyboard behaviour that the old markup did not have, because the old
markup was **non-conformant**: it already declared `role="tablist"` and `role="tab"` while
supporting no arrow-key navigation at all, which is an accessibility defect, not a baseline worth
preserving. The new contract is bounded and is exactly this — nothing beyond it is authorized:

- **Arrow/Home/End on the tablist.** `ArrowRight`/`ArrowLeft` move the selection one step with
  wraparound; `Home`/`End` jump to the first/last item. Each calls the **existing**
  `onValueChange` — the same setter the existing `onClick` already called — and then focuses the
  newly selected tab. No new state, no new query, no new capability read.
- **A roving `tabIndex`.** The selected tab is `0`, every other tab `-1`, so the strip is one tab
  stop rather than N. This *reduces* the number of tab stops in the strip.
- **`tabIndex={0}` on each mounted `role="tabpanel"`.** This is Radix's default for tab content
  and makes the panel reachable directly after its tab. It adds one tab stop per rendered panel —
  the only net-new tab stop in the release. It is inside the existing capability gate, so it can
  never expose a panel a user could not already see.

`Admin.dom.test.tsx` and `tabs.dom.test.tsx` between them pin all three. Any keyboard behaviour
beyond this list — type-ahead, `Enter`/`Space` remapping, automatic vs. manual activation
switching, focus trapping — is **out of scope** and must be rejected in review.

| Risk | Why it is real | Required guard |
| --- | --- | --- |
| **The `availableTabs` capability computation feeding `TabStrip`.** | `Admin.tsx:96-100` builds `availableTabs` from `canManageUsers`, `canAdminBackend` (which contributes **two** tabs, `directory` and `pipeline`) and `canManageIntegrations`, and `:101` seeds `activeTab` from `availableTabs[0] ?? "users"`. `:399` returns `null` when the list is empty. Passing this array into a new component is exactly the kind of edit where an "improvement" — sorting, de-duplicating, defaulting — changes who sees what. | `TabStrip` takes `items` and renders them **in the given order with no filtering, sorting or de-duplication**. The `availableTabs` expression, the `?? "users"` fallback and the `:399` early return are copied verbatim. Sol diffs lines 93-101 and 399 and expects zero change. |
| **The `role="tabpanel"` wrappers sit *inside* the capability gates.** | Each panel is `{activeTab === X && canY && <section className="admin-section" role="tabpanel">}` (`:414`, `:441`, `:451`, `:457`). The gate and the panel are one expression. Adding an `id` for `aria-controls`, or hoisting the panel out to give it a stable id, would move the panel outside its capability gate and render a shell to a user who lacks the capability. | The `id` is added **to the existing `<section>` inside the existing conditional** — no hoisting, no fragment wrapper, no new parent element between the gate and the `<section>`. The four conditions are copied character-for-character. |
| **`aria-controls` can point at an element that does not exist.** | Only the *selected* panel is rendered; the other three are unmounted. An `aria-controls` on every tab button would emit three IDREFs that resolve to nothing, which is an ARIA violation and worse for a screen reader than omitting the attribute. | Per §5.2, `TabStrip` emits `aria-controls` **only on the tab whose `aria-selected` is `true`**. Every other tab button omits the attribute entirely. This is stated here because it is the one place §5.2's contract is driven by `Admin.tsx`'s render shape rather than by the ARIA pattern in the abstract. |
| **`.admin-poison[aria-label="…"]` couples a class and an ARIA label on one element.** | `Admin.dom.test.tsx:393`, `:397` and `:431` all scope through `.admin-poison[aria-label="Notification delivery operations"]`. Splitting the wrapper — putting the class on an outer `<div>` and the label on an inner one, which is a natural thing to do when adding a `SectionHead` — silently makes three tests select nothing and pass vacuously or throw on `!`. | The class and the `aria-label` stay on the **same** element. Only the third `.admin-poison` carries a label — the Tonomo and rendition queues are bare `className="admin-poison"` divs — so `"Notification delivery operations"` is the one string that is load-bearing, and it is preserved verbatim. `Admin.tsx` has exactly four static `aria-label`s in total (`"Administration sections"`, `"Enable user impersonation (testing)"`, `"Notification delivery filters"`, `"Notification delivery operations"`) plus the template-literal `` aria-label={`Name for ${user.name}`} `` that `Admin.dom.test.tsx:184` queries; all five survive unchanged. |
| **`.admin-tabs > button` is a direct-child selector.** | `Admin.dom.test.tsx:289` is `.admin-tabs > button`. If `TabStrip` wraps each button in a `<span>` or renders an inner scroll container, the test finds nothing and the Integrations-tab assertion silently stops testing anything. | `TabStrip` renders `<div className="admin-tabs" role="tablist">` with `<button role="tab">` as **immediate** children. No wrapper elements. |
| **`Admin.dom.test.tsx:140` asserts `.admin-stage button` has length 0.** | Pipeline stage rows are read-only: they contain an `<input>` and a checkbox but **no button**. `SectionHead` or a new row affordance that introduces any `<button>` inside `.admin-stage` breaks a real invariant, not just a selector. | No `<button>` is introduced inside `.admin-stage`. The stage row keeps exactly its current interactive elements: one text `<input>` and one checkbox `<input type="checkbox">` (`:152`, `:161`). |
| **E-28: `.pagehead`'s bottom margin was carrying the form's top spacing.** | `.create-project__form` (`app.css:1003`) sets only `gap`; the space between the page heading and the first section came from `.pagehead { margin-bottom: var(--space-6) }` (`:139`) as an adjacent sibling. §7 row 6 drops the `.pagehead` class from in-scope headers. | §5.13's explicit `mb-[var(--space-6)]` (or larger, per §4.1's rhythm) on the in-scope `<header>`. Verified visually at 1440×900 — a missing 32px gap is invisible in a diff and obvious on screen. **Dropping the class also breaks `ProjectCollaborationPanel.dom.test.tsx:1020`'s `.pagehead + .create-project__form` adjacency selector; §9.4 retargets it to `header + .create-project__form`, preserving the guard, and it is the only out-of-scope test file this release touches.** |
| **Author-only annotation semantics and the impersonation bypass.** | Not on this surface — but `Admin.tsx` is where impersonation is *toggled* (`:206`, `:261`: `aria-label="Enable user impersonation (testing)"`) and where "Act as" is invoked (`:226`, `:235`). | Both `aria-label` strings and both button labels (`"Act as"`, `"Deactivate"`) are preserved verbatim; `TOGGLE_ROW` wraps the existing `<input type="checkbox">` without changing its `aria-label` or its handler. |
| **Read-only fields must stay read-only, and disabled service checkboxes disabled.** | `ProjectFields.tsx`'s order block renders `readOnly` inputs and a `readOnly` textarea; the five service checkboxes are `disabled` in edit mode. `ProjectFields.test.ts:63-68` and `:129-131` assert exactly this against `renderToStaticMarkup`. §7 rows 102-105 move the *paint* of that state from descendant selectors to `read-only:` / `has-[:disabled]:` variants. | The `readOnly` and `disabled` **attributes** are untouched; only classes change. §9's rewrite of those regexes must keep asserting the attributes, and must not relax them into "contains readonly somewhere". |
| **The Client section is TB1's, and is a byte-for-byte contract.** | `ProjectFields.test.ts:104` asserts `editClient === createClient` — the Create and Edit renderings of the Client `<section>` must be *identical strings*. `:79` locates the section by the literal `<section class="create-project__section" aria-labelledby="client-heading">`, matching the **whole** class attribute. (Line numbers corrected from `:99`/`:75`, Sol round 1.) | §5.14 changes exactly two class tokens in that section and nothing else, and §9 updates **only** the `[&]:grid` assertions — **not** the locator string, which must keep working unchanged (§9.2 "Line 79"). That is why §7 row 97 is **R**, not **D**, and why the Client `<section>` carries `create-project__section` and no other class token: the two utilities go on the inner grid. The `aria-labelledby="client-heading"` wiring and the four `for="project-…"` associations are untouched. Reconcile with TB1's work, do not undo it. |
| **`role="alert"` and `role="status"` are announcement contracts.** | `Admin.tsx` carries eight `role="alert"` and three `role="status"` nodes; `.notice` and `.empty` are the classes they ride on, both of which §7 splits. A `Notice`/`EmptyState` component that forgets to forward `role` turns a live announcement into silent text. | `Notice` and `EmptyState` both spread `...props` and neither hard-codes a `role`. Every existing `role` is passed through from the call site, so the diff shows the same eleven attributes in the same eleven places. |
| **The stacked-card table at ≤720px changes `display` on table elements.** | §5.6 sets `display: block` on rows and cells below 720px so each row reads as a card. In every browser, `display: block` on a `<td>` **drops its implicit `cell` role**, and the table stops being a table for assistive technology at exactly the width where it is hardest to navigate. | `ui/table.tsx` sets `role="table"`, `role="rowgroup"`, `role="row"`, `role="columnheader"` and `role="cell"` **unconditionally**, not behind a media query — the roles are inert while the implicit ones apply and load-bearing once they do not. `<thead>` becomes `sr-only`, **never `display: none`**, so the header cells stay in the accessibility tree for `scope="col"` association. This is the single highest-risk item in the release and §10.2 makes it release-blocking. |
| **The `data-label` markup is currently dead.** | Every `<td>` in `Admin.tsx` already carries `data-label="…"`, but no rule consumes it — the responsive pattern it was written for was never implemented (the tables just scroll). §5.6 activates it via `max-[720px]:before:content-[attr(data-label)]`. | Activating dead markup is a **visual** change with no logic change, but it is a change: every `data-label` string becomes user-visible for the first time. The builder reads all of them and reports any that are placeholders or duplicates rather than silently shipping them. No `data-label` attribute is edited without saying so. |
| **The one `!` pattern.** | `.page`'s `max-width` is unlayered and beats any utility (§2.2). Two sites need to override it. | Exactly two `!` utilities appear in the diff, both `!max-w-[…]` on `.page`, both carrying the inline comment §5.4 specifies. **Any other `!` in the diff is a defect** — §10.1 greps for it — because `cn()` is `twMerge(clsx(...))` and a utility never needs `!` to beat another utility. |
| **§4.2's card removal is the one aesthetic risk, and it is reversible.** | Removing the `--paper-000` card from form and provisioning sections is a real change to how the page is scanned, and it is the decision most likely to be wrong. | §4.2's four containments hold, including the pre-authorised one-line reversal (restore `bg-card` + the hairline border on the section wrapper). The reversal is a *design* decision reserved to the owner and to §8-review, not to the builder mid-build. |

---

## 9. Required test edits — exact

**Ten** edits across four edited files, plus a fifth file listed at zero and one new file. Counted
explicitly, because Sol round 1 found the earlier total unverifiable:

| Sub-§ | File | Edits |
| --- | --- | --- |
| 9.1 | `screens/Admin.dom.test.tsx` | 2 |
| 9.2 | `components/ProjectFields.test.ts` | 6 |
| 9.3 | `components/ProjectFields.dom.test.tsx` | 1 |
| 9.4 | `components/ProjectCollaborationPanel.dom.test.tsx` | 1 |
| 9.5 | `screens/CreateProject.dom.test.tsx` | 0 |
| | **Total** | **10 across 4 edited files** |
| 9.6 | `components/ui/tabs.dom.test.tsx` | new file, 7 cases |

*(Raised from 7 to 10 on 2026-09-02, during the slice-1 build — §9.2 gained edits 4, 5 and 6. All
three are one defect wearing three faces: an assertion that tests for an HTML **attribute** by
searching the raw tag for a bare **substring**, which silently starts matching Tailwind's
`disabled:`/`not-disabled:`/`has-[:disabled]:` variant prefixes the moment `FIELD_BOX` or
`CHECKBOX_INPUT` lands on the element. Neither Sol round caught it, and it is not visible from the
plan alone — edit 4's failure appeared the first time the suite ran against a built `input.tsx`.
See the note below the three diffs.)*

An "edit" is one conceptual change; §9.2's first entry rewrites two assertion lines and their two
negated twins as a single edit, because the four move together or not at all. §9.6 is counted
separately and deliberately: it is a new file, not an edit to an existing assertion, so folding it
into the ten would make the "no more, no fewer" gate in §13 unfalsifiable.

Every other assertion in every other test stays as it is; if the builder needs an **eleventh** edit,
that is a signal that behaviour changed, and it goes back to §8 rather than into the test file.

**None of these edits weakens an assertion.** Each one either follows a class that moved or inverts
an assertion whose premise TB8-03 already removed. Loosening an assertion to get to green is not
available here.

**Why the list is only these six files.** *(Added 2026-09-02 — a sweep of every test file that names
an in-scope screen, run because §9's round-1 line citations for `ProjectFields.dom.test.tsx` proved
to be off by one and the same slip could have hidden a missing file.)* The sweep —
`grep -rln 'EditProject\|CreateProject\|ProjectFields\|SignIn\|screens/Admin' src --include='*.test.ts*'`
— returns three files beyond §9's list. All three are unaffected, for reasons that must hold on the
finished branch:

| File | Why it needs no edit |
| --- | --- |
| `src/App.dom.test.tsx` | It `vi.mock`s **every** in-scope screen — `SignIn`, `Admin`, `CreateProject` and `EditProject` are all replaced by bare `<main>` stubs (`:14-18`). No TB8-04 markup reaches it. **`:145`'s `expect(host.querySelector("header")).toBeNull()` looks like it collides with §5.4's `PAGE_HEAD`, and does not**: the only `<header>` this file can see is the mocked `Topbar` at `:11`, and the mocked screens render none. If a builder ever unmocks a screen here, that assertion breaks — which is correct, not a reason to change §5.4. |
| `src/screens/EditProject-coordinator.dom.test.tsx` | Renders the real `EditProject`, but selects only by `button[type="submit"]` (`:58`) and by `textContent` (`:71`). It contains **no class selector at all**, so no §7 retirement can reach it. |
| `src/lib/router.test.ts` | Route-parsing only; never mounts a component. |

### 9.1 `src/screens/Admin.dom.test.tsx` — 2 edits

**Line 139.** The Add-stage button loses the `.button` class when it becomes `<Button>`, so the
current selector would match nothing and the assertion would pass for the wrong reason — it asserts
*absence*, which is the one shape where a stale selector is invisible.

```diff
-    expect(host.querySelector(".admin-stage-list + .button")).toBeNull();
+    expect(host.querySelector(".admin-stage-list + button")).toBeNull();
```

**Line 143.** The Refresh button likewise loses `.button`. This one asserts presence, so it would
fail loudly — but it must still be updated, not deleted.

```diff
-    expect(host.querySelector(".admin-section .admin-section__head .button")?.textContent).toBe("Refresh");
+    expect(host.querySelector(".admin-section .admin-section__head button")?.textContent).toBe("Refresh");
```

Both rely on `.admin-stage-list`, `.admin-section` and `.admin-section__head` surviving as hooks —
§7 rows 70 and 28, and the `.admin-section` entry in §7.0's inventory.

**Nothing else in this file changes.** In particular `:85` (`.admin-tabs button`), `:289`
(`.admin-tabs > button`), `:98` (`.admin-table tbody tr`), `:137-138`, `:140`, `:183-186`, `:248`,
`:343`, `:393-397`, `:426` and `:431` all keep working under §7's hooks and §8's guards, and any of
them needing an edit is a §8 violation to be reported, not patched.

### 9.2 `src/components/ProjectFields.test.ts` — 6 edits

**Lines 63-64** (and their negated twins at **129-130**). The read-only order fields move from a
bare `<label><span>…</span><input>` to `Field` + `FieldLabel` + `Input`, which puts a `<label
for=…>` before the input rather than a `<span>` inside one. The assertion's *purpose* — "this field
renders read-only" — is preserved, and strengthened, by keying off the label's `for` and the
input's `id` instead of adjacency:

```diff
-    expect(markup).toMatch(/<span>Order number<\/span><input[^>]*(?:readOnly|readonly)=""/);
-    expect(markup).toMatch(/<span>Order ID<\/span><input[^>]*(?:readOnly|readonly)=""/);
+    expect(markup).toMatch(/for="project-order-number"[^>]*>Order number<\/label><input[^>]*id="project-order-number"[^>]*(?:readOnly|readonly)=""/);
+    expect(markup).toMatch(/for="project-order-id"[^>]*>Order ID<\/label><input[^>]*id="project-order-id"[^>]*(?:readOnly|readonly)=""/);
```

and the same two lines at 129-130 take the identical patterns under `not.toMatch`. Line 65's
`<textarea[^>]*(?:readOnly|readonly)=""` and line 131's negation are unaffected and stay as they
are. **The `id`/`for` values above are the contract §5.14 must emit** — if the builder chooses
different ids, these are the two places to change, and the four `project-agent-*` ids at
`ProjectFields.test.ts:94` show the naming convention to follow.

**Line 66.** §7 rows 115, 116 and 117 give the services tile's `<span>`, its `<strong>` and its
`<small>` a `class` attribute each (`flex min-w-0 flex-col gap-[var(--space-1)]` on the span,
`TILE_LABEL` and `TILE_HINT` on the other two), and none of the three bare-tag literals in the
current regex can match once they carry one. The fix widens **every tag in this regex that §7 now
gives a class**, and nothing else — the five labels and the `toHaveLength(5)` and `disabled=""`
assertions at `:67-68` are untouched:

```diff
-    const serviceInputs = [...markup.matchAll(/<input type="checkbox"[^>]*><span>(?:<strong>RAW<\/strong><small>Always included<\/small>|Edited photography|Video|Floorplan|Copywriting)<\/span>/g)];
+    const serviceInputs = [...markup.matchAll(/<input type="checkbox"[^>]*><span[^>]*>(?:<strong[^>]*>RAW<\/strong><small[^>]*>Always included<\/small>|Edited photography|Video|Floorplan|Copywriting)<\/span>/g)];
```

*(Corrected 2026-09-02, slice-5 build. The first draft widened only the outer `<span>` and stated in
prose that "the `<strong>`/`<small>` structure … are untouched" — which contradicted rows 116 and
117 of this plan's own ledger, and made the RAW tile the one service of five the regex could not
match, so `toHaveLength(5)` failed against correct markup with a count of 4. This remains **one**
edit, not an eleventh: the conceptual change is "widen the tags this release gives classes to", and
the count in §9's table is unchanged. It loosens nothing — the pattern still requires a `<strong>`
holding exactly `RAW` immediately followed by a `<small>` holding exactly `Always included`, inside
the tile's `<span>`, after a checkbox `<input>`. Only tolerance for a `class` attribute changes.
This is the same defect as edits 4, 5 and 6 one element deeper, and the fourth face of the lesson
recorded below.)*

**Lines 92-93 — the inversion.** These assert that the Client grid uses the `[&]:grid` escape hatch
and *not* the plain `grid` utility. That workaround existed only because legacy `.grid`
(`app.css`, pre-TB8-03) was unlayered and beat Tailwind's `grid`. **TB8-03 renamed that rule to
`.legacy-grid`** (now `app.css:168`), so the collision is gone and the escape hatch is now just
noise that hides the real utility from `twMerge`. §5.14 writes plain `grid`; the assertion inverts
to lock that in:

```diff
-      expect(classTokens).toContain("[&amp;]:grid");
-      expect(classTokens).not.toContain("grid");
+      expect(classTokens).toContain("grid");
+      expect(classTokens).not.toContain("[&amp;]:grid");
```

This is the one edit in §9 that changes what is being asserted rather than how. It is deliberate,
it is the direct consequence of a fix that already shipped, and it is the reason §5.14 touches TB1's
Client section at all.

**Line 90 — edit 4.** *(Added 2026-09-02, slice-1 build.)* The assertion's purpose is "none of the
four Client inputs is read-only or disabled", and that stays true. Its *mechanism* was a raw
substring search of the rendered tag, written when an input's `class` contained no such word.
§5.1's `FIELD_BOX` ends with `hover:not-disabled:…`, `disabled:bg-surface-sunken`,
`disabled:text-foreground-secondary`, `disabled:cursor-not-allowed` and `read-only:…`, so
`input.includes("disabled")` is now true for every input on the surface and the assertion fails
against correct markup. Key off the **attribute**, which `renderToStaticMarkup` emits as
`disabled=""` / `readonly=""` and which no class token can imitate:

```diff
-      expect(inputs.every((input) => !input.includes("readonly") && !input.includes("disabled"))).toBe(true);
+      expect(inputs.every((input) => !/\s(?:readonly|readOnly|disabled)=""/.test(input))).toBe(true);
```

**Line 134 — edit 5.** *(Added 2026-09-02, slice-1 build.)* Identical defect, one element over, and
latent rather than live: it fires only once §5.14 gives the services checkbox `CHECKBOX_INPUT`,
which ends `disabled:cursor-not-allowed`. `editedService` is the checkbox's attribute string and the
assertion means "this checkbox is not disabled":

```diff
-    expect(editedService).not.toContain("disabled");
+    expect(editedService).not.toMatch(/\sdisabled=""/);
```

**Line 132 — edit 6.** *(Added 2026-09-02, slice-1 build.)* The same `<span>` widening this section
already applies to line 66, on the same element, missed there because the two regexes sit 66 lines
apart. §7 row 115 gives the services tile's `<span>` a `class` attribute, which a bare `<span>`
cannot match:

```diff
-    const editedService = markup.match(/<input type="checkbox"([^>]*)><span>Edited photography<\/span>/)?.[1];
+    const editedService = markup.match(/<input type="checkbox"([^>]*)><span[^>]*>Edited photography<\/span>/)?.[1];
```

**None of the three loosens anything.** Edits 4 and 5 make the assertions *stricter* — a real
`disabled` attribute is still caught, while a class token no longer produces a false positive; the
old form could not tell the two apart and would have passed a genuinely-disabled input that happened
to lack the class. Edit 6 widens one token, exactly as edit 2 does. The lesson generalises past this
release: **an assertion that searches rendered markup for a bare word is unsafe on any surface
Tailwind paints**, because every state variant puts its own name in the class attribute.

**Line 79** (corrected from "line 75", Sol round 1) must be updated if — and only if — the Client
`<section>`'s class attribute changes. §5.14 keeps `class="create-project__section"` on that element
precisely so this locator keeps working:

```
const start = markup.indexOf('<section class="create-project__section" aria-labelledby="client-heading">');
```

Under §7 row 97 the *rule* `.create-project__section` is deleted while the class stays on the
element as a hook; the class attribute string in the markup therefore stays exactly as written and
**line 79 needs no edit**. Because `indexOf` matches the *whole* attribute, this is a stronger
constraint than "the class survives": the Client `<section>` must carry that class and **nothing
else**, so §5.14's two tokens go on the inner grid, not on the section. If the builder finds line 79
needs an edit, the Client section has been restyled beyond §5.14 and that is a §8 violation.
`expect(editClient).toBe(createClient)` at `:104` (corrected from `:99`) is the assertion that will
catch it.

### 9.3 `src/components/ProjectFields.dom.test.tsx` — 1 edit

**Line 56.** `.ey` is split, not retired (§7 row 1), and in-scope headings become `<Eyebrow>`, which
§5.1 gives `data-slot="eyebrow"`:

```diff
-  const headingEl = [...host.querySelectorAll(".ey")].find((el) => el.textContent === heading);
+  const headingEl = [...host.querySelectorAll('[data-slot="eyebrow"]')].find((el) => el.textContent === heading);
```

Lines 58-59 (`.create-project__checklist`, `label.create-project__check`) are **not** edited — §7
rows 109 and 111 keep both class names as hooks, and row 111 additionally requires the class to stay
on the `<label>` so `label.create-project__check` still matches.

### 9.4 `src/components/ProjectCollaborationPanel.dom.test.tsx` — 1 edit

**Added 2026-09-02 (Sol round 1, correctness 2).** This file tests an out-of-scope component, but
one of its assertions reaches into `EditProject`'s markup and depends on a class TB8-04 retires.

**Line 1020**, third assertion. §7 row 6 drops `.pagehead` from in-scope headers (the rule survives
for `ProjectWorkspace.tsx`), so the adjacency selector would stop matching:

```diff
-    expect(editor.querySelector(".pagehead + .create-project__form")).not.toBeNull();
+    expect(editor.querySelector("header + .create-project__form")).not.toBeNull();
```

**The adjacency guard is preserved, not dropped.** §5.4's `PAGE_HEAD` renders the page heading as a
`<header>` element, and it remains the form's immediate previous sibling, so `header +` asserts
exactly what `.pagehead +` asserted: *the editor route renders heading-then-form, not the two-column
collaboration wrapper*. That is the whole point of the assertion, and it is the reason §5.4 changes
the element to `<header>` rather than leaving a bare `<div>` — the semantic element is both correct
markup and the only stable selector left once the class goes.

*(Rewritten 2026-09-02, Sol round 2 new finding 1. The round-1 version replaced this with a bare
`.create-project__form` presence check — which is byte-identical to the assertion already on
`:1018`, so it would have deleted the guard while §9's preamble claimed no assertion is weakened.
Sol caught that; the `header +` form is Sol's suggestion and it is the right one.)*

**Nothing else in this file changes.** `:1018`'s `.create-project__form` assertion keeps working
unedited, which is the reason row 80 is **R** rather than **D**.

This edit is the alternative to the two worse options: keeping `.pagehead` on `EditProject`'s header
alongside competing utilities (the forbidden sixth case of §7.1), or leaving `EditProject`'s header
on legacy paint while `CreateProject`'s converts (a visibly inconsistent pair of sibling screens).

### 9.5 `src/screens/CreateProject.dom.test.tsx` — 0 edits

Listed here explicitly so its absence is a decision rather than an oversight. `:49`
(`.create-project__actions button[type=submit]`) and `:119`
(`.create-project__hero-action button`) both select a bare `button`, not `.button`, and both class
names survive as hooks under §7 rows 122 and 83. No edit.

### 9.6 One new test file — `src/components/ui/tabs.dom.test.tsx`

*(Changed 2026-09-02, Sol round 1 correctness 11. This section previously said "no new test files"
and deferred all of `TabStrip`'s contract to the §10.2 browser pass. That was wrong about where the
line falls, and it left the plan's own internal contradiction — the sample emitting `aria-controls`
on every tab while §8 requires it only on the selected one, correctness 3 — with nothing mechanical
to catch it. A defect a `grep` cannot see and a test does not cover is a defect that ships.)*

**The line is between DOM state and rendering, not between "keyboard" and "everything else."**
`aria-controls`, `aria-selected`, `tabIndex` and whether `onValueChange` fires with the right value
are attributes and callbacks — plain DOM, asserted exactly as truthfully in `happy-dom` as in
Chrome. What a `happy-dom` test genuinely cannot tell you is whether a focus ring is *visible*,
whether the selected underline reads, or whether the ≤720px stacked card looks like a card. Those
stay in §10.2.

`apps/web` already runs a `happy-dom` config and `src/components/quincy/QuincyField.dom.test.tsx` is
the pattern to copy — `createRoot` + `act`, `IS_REACT_ACT_ENVIRONMENT = true`, a `host` div in
`beforeEach`, unmount in `afterEach`. Seven cases, all against a three-item strip:

| # | Assertion |
| --- | --- |
| 1 | The root is `role="tablist"` with the given `aria-label`, and its **immediate** children are the `role="tab"` buttons — `root.querySelectorAll(":scope > [role=tab]")` has length 3. This is `Admin.dom.test.tsx:289`'s `.admin-tabs > button` contract expressed as a unit test (§8). |
| 2 | Exactly one tab has `aria-selected="true"`; the other two are `"false"`, not absent. |
| 3 | **Exactly one tab carries `aria-controls`, and it is the selected one** — `root.querySelectorAll("[role=tab][aria-controls]")` has length 1. This is the assertion that catches correctness 3. |
| 4 | Roving `tabIndex`: the selected tab is `0`, the other two `-1`. `getAttribute("tabindex")`, not the property, so an omitted attribute fails loudly. |
| 5 | `ArrowRight` on the tablist calls `onValueChange` once with the **next** item's value **and** leaves `document.activeElement` on that item's button; `ArrowLeft` from the first item wraps to the **last** (the `% items.length` in `move`), by both measures. Dispatch a real `KeyboardEvent` with `bubbles: true`, not a synthetic React call. |
| 6 | `Home` calls it with `items[0].value` and focuses that button; `End` does the same for the last. |
| 7 | Every tab button has `type="button"`. A `<button>` with no `type` inside a `<form>` submits it, and §5.2 makes this mandatory for exactly that reason. |

**Cases 5 and 6 assert focus as well as the callback.** `TabStrip` moves focus itself — `move()` and
the `Home`/`End` branches both call `refs.current[…]?.focus()` — so focus movement is this
component's contract, not the parent's, and `document.activeElement` is deterministic in
`happy-dom`; `QuincyField.dom.test.tsx:29-35` already relies on exactly that. The `host` div must be
appended to `document.body` (as that file does) or `.focus()` has nothing to move focus within.

*(Corrected 2026-09-02, Sol round 2 new finding 6. The first draft of this section asserted only the
callback and called focus "the parent's business", which misread the component's own code —
`TabStrip` is controlled for `value` but **not** for focus. Since `value` does not change in a
controlled test, the callback assertion alone would pass even if the `.focus()` calls were deleted
entirely, which is precisely the regression worth catching.)*

What stays in §10.2 is the part `happy-dom` genuinely cannot judge: whether the ring that lands on
the focused tab is *visible* (item 1), and the ≤720px stacked-card appearance (item 3).

`TabStrip` is not exported from `Admin.tsx`; it lives in `components/ui/tabs.tsx` (§6.1), so the
test imports it directly and needs no screen, no router and no fetch mock.

**This file is required, not optional.** It is the release's only new test file, and the fifth test
file touched; §6.1 lists it. (It is not one of §9's ten *edits* — those are edits to existing
assertions, counted separately in §9's table.)

---

## 10. Acceptance criteria

Split deliberately. §10.1 is what a machine can prove and what the builder must have green before
asking for review; §10.2 is what only a human in a real browser can see, and **it is
release-blocking, not advisory** — a green §10.1 with an unchecked §10.2 is not a candidate.

### 10.1 Automated — must be green before review

**A. The standard gate (from `portal/`, per `CLAUDE.md`).**

```
npm run typecheck                                   # all six workspaces
npm run build -w @quincy/web
npm run test --workspaces                           # includes apps/web's own suite
npx vitest run --config packages/shared/vitest.config.ts
```

All four green. The fourth is listed because `npm run test --workspaces` silently misses
`packages/shared`; TB8-04 touches nothing there, so it must be green *unchanged* — a failure means
something escaped the frontend.

**B. The §7.0 retirement gate**, run in full on the finished branch, including the expected-hit
inventory. Zero hits on a kept hook is a finding.

**C. The §7.13 closing greps**, all five returning exactly what is stated there.

**D. Convention greps on the diff.** Each must return **no output** unless it says otherwise.

**Run this block under `bash`, not the login shell.** The repo's default shell is zsh, which does
**not** word-split an unquoted parameter, so `grep … $CHANGED` passes the whole list as one
filename and every check silently "passes" with `No such file or directory`. Use a bash array, or
prefix the block with `bash -c`. *(Found 2026-09-02 by running the gate as written; the same
session found the D3/D4/D5 defects below. A gate that cannot fail is worse than no gate.)*

**Every gate here has been run in both directions before being written down** — Sol round 2's
finding 7 was that D1, D3 and D4 still had false-negative paths, and "it looks stricter now" is not
an answer to that. Executed 2026-09-02:

| Gate | Against the current tree | Against a probe file carrying the exact violation |
| --- | --- | --- |
| D1 | silent | catches `gap-2` and `px-4` **inside a `const` string**, which the round-1 `className="…"`-anchored form missed entirely |
| D2 | silent | *(unchanged from round 1)* |
| D3 | silent | catches `border-[var(--ink-900)]`, which the round-1 `text-`/`bg-`-only form let through |
| D4 | one line, `Admin.tsx:480` (E-42) | **misses** a shorthand split across a `" +` concatenation — this is the blind spot, and it is why D4b exists |
| D4b | one line, `Admin.tsx:480` (E-42) | catches that same split constant |
| D5 / D5b | silent | *(unchanged from round 1)* |

The probe was a throwaway file, not committed. The point of the right-hand column is that each gate
is known to fail on the thing it claims to catch — not merely to pass today.

```bash
cd portal/apps/web
CHANGED=(src/screens/Admin.tsx src/screens/CreateProject.tsx src/screens/EditProject.tsx
         src/screens/SignIn.tsx src/components/ProjectFields.tsx src/components/ui src/components/quincy)

# D1 — no bare Tailwind spacing/sizing utility (§2.1's hard non-goal).
#      Every spacing value binds to a Quincy variable or is an explicit arbitrary px.
#      `-0` is exempt and matched by `[1-9][0-9]*`: zero is a reset, not a scale step,
#      and §5 legitimately specifies `p-0`, `m-0`, `mb-0`, `px-0` and `border-t-0`.
#      Bounded by quote-or-space rather than anchored to `className="…"`, because most of
#      the new primitives keep their class strings in module constants (TAB_BASE, CHECK_TILE,
#      PILL_BASE, FIELD_BOX …) and a `className=`-anchored form sees none of them.
#      Arbitrary values are untouched: `min-h-[38px]` has `[` where this needs `[1-9]`.
#      (Corrected twice: Sol round 1 found the old `[0-9]+` form rejecting the plan's own
#      `-0` resets; Sol round 2 found the `className=` anchor blind to constants.)
grep -rnE '[" ]-?(p|m|gap|space|w|h|min-w|min-h|max-w|max-h|top|right|bottom|left|inset)(-[xytrbl])?-[1-9][0-9]*[" ]' "${CHANGED[@]}" \
  | grep -vE ':[0-9]+: *(//|\*|/\*)'

# D2 — `border-*-solid` does not exist; Preflight is off so border-style starts at none.
grep -rnE 'border-(t|r|b|l|x|y)-solid' "${CHANGED[@]}"

# D3 — no raw colour-ramp utility: colours come from semantic roles, never --ink-*/--paper-*/--greige-* directly.
#      Matches the ramp variable itself rather than an enumerated list of utility prefixes, so
#      `border-[var(--ink-900)]`, `accent-[var(--paper-000)]`, `outline-[var(--greige-600)]` and
#      every other property are caught, not just `text-` and `bg-`. (Corrected 2026-09-02, Sol
#      round 2: the two-prefix form let every other property through.) `accent-[var(--accent)]`
#      in CHECKBOX_INPUT is a semantic role, not a ramp, and correctly passes.
#      Scans added lines only. One pre-existing violation is knowingly left alone:
#      `ui/input.tsx:11` paints `bg-[var(--paper-050)]`, which is E-37's subject — §5 replaces that
#      declaration, so after the build this file is clean and the whole-file form would also pass.
#      Diff-scoped anyway, so a later unrelated primitive cannot make this gate unrunnable.
git diff -U0 -- "${CHANGED[@]}" | grep '^+[^+]' \
  | grep -nE '\[var\(--(ink|paper|greige)-[0-9]'

# D4 — merged-shorthand rule: no element carries [font:var(--type-*)] AND a separate text-[length:…].
#      `grep -v` drops comment lines: `ui/button.tsx:15` *documents* the anti-pattern in prose and
#      is a false positive, not a violation. Whole-file form is right here — the rule must hold for
#      every line of a touched file, and E-42 (`Admin.tsx:480`) is exactly the case this catches.
#      D4 only sees the two utilities when they land on one physical line; D4b covers the rest.
grep -rn '\[font:var(--type-' "${CHANGED[@]}" | grep 'text-\[length:' | grep -vE ':[0-9]+: *(//|\*|/\*)'

# D4b — the same rule where D4 is blind: a class string split across lines by `" +` concatenation
#       or spread over several `cn()` arguments. (Added 2026-09-02, Sol round 2 new finding 7 —
#       every new primitive builds its class string that way, so D4 alone guarded almost nothing.)
#       Strips comments, flattens concatenation and newlines, then tests each region delimited by
#       `const ` or `className=`. Comment-stripping is required, not tidiness: `ui/button.tsx:15-17`
#       and `ui/select.tsx:82-87` both *document* the anti-pattern in prose, and without stripping
#       they are the only two hits this check reports — noise that trains the reader to ignore it.
#       Over-reports rather than under-reports by design: two unrelated class strings inside one
#       region trip it, and a human clears that in one read. Silence is the pass condition.
#       Verified 2026-09-02 against the pre-build tree: reports exactly `Admin.tsx` (E-42) and
#       nothing else. If it reports a third file after the build, that file is the finding.
python3 - "${CHANGED[@]}" <<'PY'
import re, sys, pathlib
hits = []
for arg in sys.argv[1:]:
    p = pathlib.Path(arg)
    files = [p] if p.is_file() else sorted(p.rglob("*.tsx")) + sorted(p.rglob("*.ts"))
    for f in files:
        if f.name.endswith((".test.ts", ".test.tsx")):
            continue
        src = f.read_text()
        src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)      # block comments
        src = re.sub(r"(?<!:)//[^\n]*", "", src)             # line comments, sparing `https://`
        flat = re.sub(r'"\s*\+\s*"', "", src)                # join "a " + "b" into "a b"
        flat = re.sub(r"\s*\n\s*", " ", flat)                # one logical line
        for region in re.split(r"(?=\bconst\b|\bclassName=)", flat):
            if "[font:var(--type-" in region and "text-[length:" in region:
                hits.append(f"{f}: {region[:160]}")
for h in hits:
    print(h)
sys.exit(1 if hits else 0)
PY

# D5 — exactly two `!` utilities introduced by THIS diff, both !max-w-[…] on .page, both commented.
#      Scans added lines only, not the whole file. (Corrected 2026-09-02 — Sol round 1: the old
#      whole-file form could never pass, because `components/ui/button.tsx` is a touched file and
#      already carries seven required `!text-*` utilities at :29 and :33-40, which exist to beat
#      the unlayered `base.css:21` `a { color: inherit }` rule and are none of TB8-04's business.
#      This release's only edit to that file inserts `max-[720px]:min-h-[44px]` into `BASE` (§5.1),
#      which touches no line carrying a `!`.)
#      (Corrected again 2026-09-03 — Sol whole-branch round, finding 4. The old matcher made `[`
#      optional, so it also reported ordinary JavaScript negations such as `!isLoadingUsers` and
#      `!archivedAt`; requiring `-[` admits only real arbitrary-value utilities. The old expected
#      count of 2 was wrong on its own terms too — `!max-w-[…]` appears at three sites, in Admin,
#      CreateProject and EditProject, across two distinct values.)
#      Expect exactly these 9 rows (15 occurrences) and nothing else — the two authorized case-O
#      groups. *(Count corrected 2026-09-03 from "10" when the gate was first run on the finished
#      branch: the enumeration below has always listed 9 distinct rows, and the run matches it
#      exactly. The stale "10" was prose drift, not a missing row.)*
#        2 !max-w-[1080px]      1 !max-w-[1280px]                      <- the .page override
#        1 !mt-[var(--space-1)] 2 !mt-[var(--space-2)]                 <- the base.css margin override
#        2 !mt-[var(--space-4)] 3 !mt-[var(--space-5)]
#        2 !mb-[var(--space-4)] 1 !mb-[var(--space-5)] 1 !mb-[var(--space-6)]
git diff -U0 -- "${CHANGED[@]}" | grep '^+[^+]' | grep -oE '![a-z][a-z-]*-\[[^]]*\]' | sort | uniq -c

# D5b — button.tsx's seven pre-existing `!text-*` lines are not in the diff at all.
git diff -U0 -- src/components/ui/button.tsx | grep -c '^[-+][^-+].*!text-'   # expect: 0
```

D5 is the one that returns output rather than nothing: it must show `2 !max-w-[…]` and no other
`!`-prefixed token. **An unexplained *new* `!` is a defect** (§2.1) because `cn()` is
`twMerge(clsx(...))` and a utility never needs `!` to beat another utility. The exception is the
one documented in §2.2: a `!` utility that exists to beat an *unlayered `app.css`/`base.css` rule*
is legitimate (that is what `button.tsx`'s `!text-*` set is, and what disposition case **O** means
in §7). D5b keeps the distinction honest by proving TB8-04 neither adds to nor disturbs that set.

**E. Structural assertions on `app.css`.**

- Both `.sr-only` declarations still present (§7 rows 23-24). `grep -c '^\.sr-only'` returns **2**.
- `.grow` still at line 28, unedited (§7 row 4).
- `.legacy-grid` untouched — TB8-04 must not re-introduce a `.grid` rule.
- No new rule is added to `app.css` by this release. The diff on that file is deletions only, plus
  the two surviving-block comments. `git diff --numstat src/styles/app.css` shows insertions ≈ 0.

**F. Behaviour-preservation diffs Sol checks by eye**, because no test covers them:

- `Admin.tsx:93-101` (the capability booleans and `availableTabs`) and `:399`: **zero change**.
- The four tabpanel conditions at `:414`, `:441`, `:451`, `:457`: unchanged except for an added
  `id` attribute on the existing `<section>`.
- All five `aria-label` strings (§8), all eight `role="alert"` and three `role="status"`
  attributes, and every `sr-only` header: present, same count, same elements.
- Every `readOnly` / `disabled` attribute in `ProjectFields.tsx`: unchanged.
- Exactly ten test-file edits, matching §9 line for line.

**G. Zero console errors and zero failed network requests** on each of the five screens in local
dev. This is the same passive bar TB5C and TB6 shipped against.

**H. The drift-register edit is exactly the two lines of §1.4** (§1.1, §12 Q4). The one non-`portal/`
file this release touches is `docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md`, and its
diff must be the appended row plus the row-count bump — nothing else:

```
cd "$(git rev-parse --show-toplevel)"
REG=docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md

# H1 — insertions exactly 2, deletions exactly 1 (the count line is a modification).
git diff --numstat -- "$REG"        # expect: 2  1  <path>

# H2 — the two added lines are the TB0-VIS-04 row and the bumped count, in that order.
git diff -U0 -- "$REG" | grep -c '^+[^+]'     # expect: 2
git diff -U0 -- "$REG" | grep    '^+[^+]'     # expect: the §1.4 row verbatim,
                                              #         and `- Register rows: **22**.`

# H3 — the only deleted line is the old count. No existing register row is rewritten.
#      (Matcher corrected 2026-09-03, on the finished-branch run. The old form was
#      `grep '^-[^-]'`, which could NEVER show the line it claims to expect: the count line is a
#      markdown bullet, `- Register rows: …`, so its diff line is `-- Register rows…` — two
#      hyphens, which `[^-]` rejects. The gate returned silence and silence reads as a pass, so
#      this check was asserting nothing. Excluding only the `---` file header is the honest form.
#      Same defect class as the D5 matcher Sol caught: a gate that cannot fail is worse than none.
#      The second command below was never affected — a rewritten row's diff line starts `-|`.)
git diff -U0 -- "$REG" | grep '^-' | grep -v '^---'  # expect: `- Register rows: **21**.` only
git diff -- "$REG" | grep -E '^-.*TB0-(VIS|OPS|UI|[A-Z]+)-[0-9]'   # expect: no output

# H4 — the appended row has the register's 10 columns (11 pipes on a `| … |` row).
grep '^| \*\*TB0-VIS-04\*\*' "$REG" | tr -cd '|' | wc -c   # expect: 11

# H5 — the other three acceptance-summary assertions are untouched and still true.
#      (Expanded 2026-09-02, Sol round 1 correctness 12: this previously checked only the
#      `Unassessed` bullet and asserted nothing about the other two at Drift-Register.md:68-70.)

# H5a — `Unassessed` rows stay 0, and TB0-VIS-04 is not one of them.
grep -c 'Unassessed. rows: \*\*0\*\*' "$REG"        # expect: 1
grep    'TB0-VIS-04' "$REG" | grep -c 'Unassessed'  # expect: 0

# H5b — the provider-prerequisite bullet is byte-identical (it describes TB0-OPS-01, not this row).
grep -c 'The provider retry row remains an explicitly owned pre-live prerequisite, not an unassigned drift\.' "$REG"   # expect: 1

# H5c — the no-edit-authority bullet is byte-identical, and TB0-VIS-04 does not violate it.
#       This is the load-bearing one: the new row must not be read as authorizing source edits.
#       TB8-04's own authority comes from the release, not from the register.
grep -c 'No row authorizes editing `Decision-Sheet.md`, `Implementation-Plan.md`, `PRD.md`, `AGENTS.md`,' "$REG"   # expect: 1
grep -c '`CLAUDE.md`, source, tests, configuration, schema, or production resources\.' "$REG"                       # expect: 1
git diff -U0 -- "$REG" | grep -cE '^[-+][^-+].*(No row authorizes|provider retry row)'                             # expect: 0
```

H3 is the containment §12 Q4 relies on: the row is appended and no existing register row is
rewritten. A deletion of anything but the count line is a finding, not a tidy-up — reclassifying or
restating `TB0-VIS-01`/`-02`/`-03` is out of scope for TB8-04. H5 exists because the count bump is
the first sign that the acceptance summary is derived from the table; if a later reader adds a row
without re-reading that block, the register starts lying about itself.

### 10.2 Real-browser-only — release-blocking

None of these can be asserted in `happy-dom`, and each has a matching evidence artefact in §11.
A failure here blocks the release regardless of §10.1.

**Accessibility — every item below is release-blocking.**

1. **Focus-visible rings exist on every focusable control on all five screens.** This is the
   regression TB8-03 actually shipped and had to fix. §7 rows 35, 38, 86 and 121 delete **four**
   separate `outline: none` declarations; if `FIELD_BOX`'s `focus-visible` ring is wrong, the
   surface ends up with *less* focus indication than before. Tab through each screen end to end and
   confirm a visible ring on: every `Input`, `Textarea`, `NativeSelect`, checkbox, `<summary>`,
   every `Button`, and every tab in both strips. Port TB8-03's `suppressesOutline()` helper
   approach if a scripted check is wanted, but the eye check is the one that counts.
2. **Both tab strips operate from the keyboard.** Arrow-Left/Right move selection with automatic
   activation, Home/End jump to first/last, Tab moves *out* of the strip (roving `tabIndex`), and
   focus lands on the newly selected tab. Verified with a screen reader active on the
   administration strip, since that one also changes what is rendered.
3. **The ≤720px stacked-card table is still a table to assistive technology.** At 390×844, with a
   screen reader, navigate the notification-delivery table and confirm: row/column position is
   announced, each cell's column header is announced (`scope="col"` association surviving
   `display: block`), and the `<thead>` is reachable rather than hidden. **This is the highest-risk
   item in the release** (§8) — if it fails, the fallback is to keep horizontal scroll at ≤720px
   and ship the stacked cards as a follow-up, not to ship a broken table.
4. **Every form control has a programmatically associated label**, checked with the accessibility
   inspector rather than by reading the JSX: the five provisioning fields, both directory forms,
   the pipeline stage label and toggle, the impersonation toggle, all four Client controls, the
   three read-only order controls, the property/address fields and the five service checkboxes.
5. **Validation errors are announced.** Trigger an invalid submit on New shoot and on the Admin
   provisioning form; confirm the `FieldError` is announced by the screen reader on appearance and
   that `aria-describedby` / `aria-errormessage` resolve to it.
6. **44px minimum touch targets at ≤720px.** Measured in devtools, not assumed: every `Button`,
   both tab strips' tabs, every checkbox row, and the table row action buttons.
7. **Contrast.** Spot-measure the four cases §2.1's table calls out, on real rendered pixels: pill
   text at each of the five tones, `FieldError` text, placeholder text, and `EmptyState` body copy.
   Nothing on the surface falls below 4.5:1 for body text or 3:1 for a UI boundary.

**Visual and typographic.**

8. **No horizontal scrollbar on the page body at any of the three viewports**, on any of the five
   screens. The `.signin::before` pinwheel (§7 row 23) is the specific hazard — it is 58vw wide and
   positioned at `right: -17%`, so it only stays contained if the `overflow-hidden` utility §7 row
   22 requires actually lands.
9. **No synthesised faux-bold anywhere on the surface** (E-13). Apfel Grotezk ships **one** face,
   at 400 (`fonts.css:10-12`), so on any `--font-sans` text the only non-synthesised weight is 400.
   §7 rows 116 and 144 take the two `font-weight: 500` sites to `--weight-regular`. In devtools'
   Computed panel, **every element whose computed `font-family` starts with `Apfel Grotezk` must
   show `font-weight: 400`** — including both `<strong>` elements, which get their emphasis from
   colour instead. A synthesised weight is invisible to the eye at small sizes and is exactly why
   this defect survived. *(Corrected 2026-09-02 — this item previously said "400 and 700", which
   would have licensed the very thing it is checking for.)*
10. **The type scale matches §5.16's 25-row before/after table**, spot-checked on at least the
    eight rows that change a value.
11. **The responsive matrix of §5.17 holds at all three viewports** on all five screens — in
    particular the three-tier grids (provisioning, directory, agent, integrations, field grids,
    services) breaking at exactly 720px and 1080px, matching the ports in §7 rows 123-139.
12. **§4.2's card removal reads correctly.** This is the taste judgment the plan cannot make for
    itself: at 1440×900, do the form sections still read as separate objects without their
    borders? If they do not, §4.2's one-line reversal is applied before the release, not after.
13. **Activated `data-label` strings are correct and non-duplicated** at 390px (§8) — they become
    user-visible for the first time in this release.

**Behaviour.**

14. **Every mutation path still works, exercised as Admin in local dev**: provision a user,
    deactivate/reactivate, inline-rename a directory agency and agent, rename a pipeline stage and
    toggle it, toggle impersonation, replay and discard a notification delivery, load more,
    switch all five delivery filters, create a shoot, edit a shoot, archive and delete. Local dev
    (`http://localhost:8787`, seeded admin) is the mutation-safe target; production QA stays
    passive-only.
15. **Impersonation still works end to end** — "Act as" a Photographer and an Editor and confirm
    the Admin screen's capability gating and the two project forms behave as that role. One
    sign-in covers every role (`docs/Admin-Impersonation.md`).
16. **Both `role="tabpanel"` sections still appear and disappear with their capability**, verified
    while impersonating a user who lacks `adminBackend` and one who lacks `manageIntegrations`.

---

## 11. Evidence deliverables

Captured in local dev signed in as the seeded admin, at three fixed viewports — **1440×900,
1024×768, 390×844** — with the browser at 100% zoom and the default theme. Matched pairs: the same
screen, same data, same viewport, before and after. An unmatched "after" screenshot is not evidence.

**Screen captures — 5 screens × 3 viewports × before/after = 30 images.**

| # | Screen | What must be visible in the frame |
| --- | --- | --- |
| 1 | Sign-in | The panel, the wordmark, the Google button (with the `.button__google` disc gone in the "after"), the note, and enough of the ground to show the `::before` pinwheel is still there and still contained. |
| 2 | New shoot | The address hero, the `<details>` disclosure **open**, at least two field grids, the services tiles, and the actions row. |
| 3 | Edit shoot | The archived badge in its `StatusPill` form, a read-only order field beside an editable one (the E-37 ground change is only legible in that pair), and the full danger zone including both action rows. |
| 4 | Administration — Users | The tab strip with a **selected** tab (E-39's restored underline is the point of the frame), the provisioning form, and the users table with at least one row in inline-edit mode and one selected row (E-18). |
| 5 | Administration — Integrations | All **three** integration cards in one frame — `PROVIDERS` (`Admin.tsx:49`) is `dropbox`, `tonomo`, `vimeo` — showing the `min-height: 270px` removal and the `mt-auto` button baseline. *(Corrected from "four", 2026-09-02, Sol round 2: a four-card frame cannot be captured.)* |

**Additional captures — 9 images across 8 numbered frames, "after" only unless noted.** Frame 6 is a
before/after pair and therefore counts twice; frames 7-13 are one image each. *(Corrected 2026-09-02,
Sol round 1 consistency 6 — this said "8 images", counting frames rather than images. **The release
total is 30 + 9 = 39 images.**)*

| # | What | Why it needs its own frame |
| --- | --- | --- |
| 6 | Notification-delivery queue at 390×844, before **and** after | The stacked-card conversion is the release's highest-risk change (§10.2 item 3). Before-and-after because "an 820px table in a 294px box" is the defect being fixed. |
| 7 | Notification-delivery filter strip at 1440×900, all five tabs, one selected | The second tab strip — E-39 affects both, and §8 requires them to indicate identically. |
| 8 | Pipeline stages at 390×844 | The `28px 1fr` two-column collapse (§7 rows 125-126) and the `.admin-stage button` = 0 invariant. |
| 9 | Directory tab at 1024×768 | The 721–1080px two-column tier of both directory forms (§7 row 137) — the only tier that exists solely at this viewport. |
| 10 | Focus-visible ring on an `Input`, a `NativeSelect`, a checkbox and a `<summary>` | §10.2 item 1. Four deleted `outline: none` rules; the ring must be photographed, not asserted. |
| 11 | Focus ring on a tab, mid-Arrow-key traversal | §10.2 item 2. |
| 12 | Devtools Computed panel showing `font-weight: 400` **and** `font-family` resolving to `Apfel Grotezk`, on a services-tile `<strong>` and a danger-zone `<strong>` | §10.2 item 9. Faux-bold is invisible in a screenshot of the page itself, and the weight alone proves nothing without the family beside it. *(Corrected 2026-09-02 from `700` — see E-13.)* |
| 13 | Devtools box model on a `Button` and a checkbox row at 390px, showing ≥44px | §10.2 item 6. |

**Non-image evidence.**

| # | Artefact |
| --- | --- |
| 14 | Terminal output of all four §10.1-A commands, green. |
| 15 | Terminal output of the §7.0 retirement gate **including the expected-hit inventory**, annotated where a hit is a kept hook. |
| 16 | Terminal output of the five §7.13 closing greps and the **seven** §10.1-D convention greps (D1, D2, D3, D4, D4b, D5, D5b), the D-block run under `bash` per its own preamble. **On the finished branch all seven must be silent, D4 and D4b included.** Their pre-build baseline is one line each, both naming `Admin.tsx:480` — E-42's merged shorthand, which §5 replaces. Silence after the build therefore proves two things at once: E-42 is fixed, and no new violation was introduced. Any other output is a finding. |
| 17 | `git diff --stat`, plus `git diff --numstat src/styles/app.css` showing insertions ≈ 0. |
| 18 | A contrast measurement table for §10.2 item 7's four cases, with measured ratios. |
| 19 | A short written note recording the §10.2 item 3 screen-reader result — which reader, which table, what was announced. A pass here is a claim about assistive technology and needs a sentence, not a checkmark. |
| 20 | Console + network capture for each of the five screens (§10.1-G): zero errors, zero failed requests. |
| 21 | Terminal output of the §10.1-H checks on `Drift-Register.md` — H1's `numstat` reading `2 1`, H2's two added lines, H3's deletion grep showing only the old `Register rows: **21**.` line, H4's pipe count of `11`, and all three H5 sub-checks (H5a `Unassessed`, H5b the provider-prerequisite bullet, H5c the no-edit-authority bullet). This is the evidence that the one non-`portal/` file in the diff was appended to and not rewritten. |

---

## 12. Open questions for the owner

**All four are answered — the owner responded 2026-09-02 and this section is now a decision record,
not an open list.** Three confirmed the plan as drafted (Q1, Q2, Q3); Q4 overrode it and put the
drift-register row into this diff. Each entry below carries the answer first and the original framing
beneath it, so a later reader can see what was traded.

Everything else in this plan was closed by the plan itself — where a decision could be made from the
evidence, it was made, and §4 and §5 record the reasoning rather than deferring it. These four needed
the owner because they were taste or scope judgments, not derivations.

**Q1 — The white card on form sections (§4.2). Ship the removal, or keep the cards?**
**ANSWERED 2026-09-02: remove the cards.** The plan's proposal is approved as drafted; §4.2's four
containments and its one-line reversal stand as the contingency, unused. §5.13 and §5.14 ship as
written, and the E-37 field-ground fix ships with them.

Original framing, kept for the record: this is the release's one aesthetic risk and the one place the
plan changes how the page is *scanned* rather than how it is *painted*. The plan commits to removing
it because it is what the design system says and because it makes the E-37 field-ground fix forcing
rather than optional. A "keep the cards" answer would have cost one line in §5.14 and §5.13 and
changed nothing else.

**Q2 — Is `.serif` allowed to disappear from in-scope headings (E-40, §7 row 3)?**
**ANSWERED 2026-09-02: remove it.** The plan's proposal is approved. §7 row 3 ships as drafted: the
class comes off every in-scope heading, the rule itself survives for `.empty .serif` and out-of-scope
screens. It is a provably zero-pixel change — `--type-h1`, `--type-h2` and `--type-h3` all already
carry `--font-display` — and §10.1's zero-pixel assertion covers it.

Original framing, kept for the record: `.serif` is a brand hook, and keeping it as an intentional
marker of "this heading is display type" would have been the conservative answer, guarding against a
future heading that loses its `--type-h*` shorthand falling back to the UI face. The owner took the
plan's view that a class which does nothing is a class the next person has to reason about.

**Q3 — Does the notification-delivery queue's phone treatment have to ship in this release?**
**ANSWERED 2026-09-02: ship the stacked-card conversion.** The plan's proposal is approved. §5.6
ships as drafted and §10.2 item 3 stands as a release-blocking check — the release does not ship if
its screen-reader pass fails. The de-risking alternative (keep horizontal scroll, take the cards as
a follow-up) is **not** taken; the builder must not silently fall back to it if the check proves
awkward. If item 3 fails, that is an escalation to the owner, not a quiet descope.

Original framing, kept for the record: §5.6's stacked-card conversion is the biggest single change in
TB8-04 and §10.2 item 3 is the one release-blocking check that could plausibly fail. The plan
proposed shipping it because leaving an 820px-minimum table in a 294px viewport is the single worst
thing about this surface on a phone, and because the `data-label` markup is already written and
merely dead. It trades a real user benefit against a real accessibility risk; the owner took the
benefit.

**Q4 — Should a `TB0-VIS-04` drift-register row be opened for this surface?**
**ANSWERED 2026-09-02: yes, and it ships in this diff** — overriding the plan's recommendation of a
separate follow-up. `docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md` is therefore an
in-scope file (§1.1), and **§1.4 drafts the row verbatim** so the builder appends it rather than
composing it. It is classified `Unwanted drift`, not `Intentional evolution` — §1.4 states why, and
that divergence from `TB0-VIS-01`–`03` is deliberate and reviewed.

Original framing, kept for the record: the plan argued a baseline document is not a place to make a
convenience change in the middle of a styling release. The owner's view is that the register should
stop under-describing the app now rather than accrue another deferred documentation task. The
containment is that the edit **appends one row and rewrites no existing row** — its only other change
is bumping that file's own `Register rows` count from 21 to 22, which the register's correctness
requires. §10.1-H asserts both, and treats any further deletion as a finding.

**Deliberately not asked here.** The following were decisions this plan owed and has made, and they
are recorded in §4 and §5 rather than escalated: the ledger-sheet direction and its three devices;
rejecting `01/02/03` numbered markers; keeping the `.signin::before` pinwheel and removing the
`.button__google` disc; rejecting Base UI `Select` in favour of a styled `NativeSelect`, with three
recorded reasons; adopting `--field-bg` everywhere while keeping `--border-hairline` for ordinary
field borders and spending `--field-border` at exactly two sites; the 38px/44px control-height
split; the eleven new files and their boundaries; and every class string in §5.

---

## 13. Completion boundary

**TB8-04 is complete when**, and only when:

1. The five screens and the eleven new files are built to §5's specification, with §6.1's file list
   and no other file touched — the single exception being
   `docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md`, which is in scope by owner
   decision (§1.1, §12 Q4) for an append only.
2. §7's 159 dispositions are applied, the §7.0 retirement gate passes **including its expected-hit
   inventory**, and the §7.13 closing greps return what they say.
3. §9's ten test edits are made — no more, no fewer — §9.6's `tabs.dom.test.tsx` exists with all
   seven cases green, and §10.1's four commands are green.
4. §10.2's sixteen real-browser checks pass, with the seven accessibility items treated as
   release-blocking.
5. The `TB0-VIS-04` row of §1.4 is appended to the drift register verbatim and its `Register rows`
   count is bumped 21 → 22, with §10.1-H's checks (H1-H4 plus H5a/H5b/H5c) proving nothing else on
   that file moved.
6. §11's twenty-one evidence artefacts exist and have been reviewed — 39 images and 8 non-image
   artefacts.
7. Fresh Sol has reviewed the whole-branch diff for scope and correctness, and Opus has passed the
   visual/taste review in the Browser pane — including the §4.2 judgment (Q1).
8. The `docs/Subagent-Orchestration.md` §5 gate has been re-verified by the orchestrating session,
   not by a subagent's claim.

**TB8-04 does not include, and its completion must not be read to imply:**

- `NotificationPreferences.tsx`, the notification bell, or any notification surface outside
  `Admin.tsx` (§1.2) — these remain with ranking candidate #5.
- The `.sr-only` duplicate deletion (candidate #10, §7 rows 23-24).
- `.grow`'s collision (§7 row 4), the `.cbar`/`.ctabs`/`.optcard` dead code (§6.2), or the
  `.empty`, `.notice`, `.ey`, `.serif`, `.muted`, `.page`, `.pagehead`, `.toolbar` and `.button*`
  rules, all of which survive this release for their out-of-scope consumers (§7 rows 1-8, 13-20, 22).
- Any drift-register work beyond §1.4's two lines — the appended `TB0-VIS-04` row and the 21 → 22
  row-count bump (Q4). Reclassifying, restating or re-verifying `TB0-VIS-01`, `-02` or `-03` is out
  of scope, and §10.1-H treats any deletion on that file other than the old count line as a finding.
- Any change to `tokens/*.css`. TB8-04 consumes the design system; it does not extend it.

**Deployment and doc hygiene.** This plan stays in `docs/plans/` while it is drafted or built. Once
the change is built, verified, committed **and deployed to production**, this file's status line is
updated to say so with the commit hash, and the file is moved to `docs/plans/implemented/` with
`git mv` — per `CLAUDE.md`, `implemented/` means "matches what is live in production right now."
`docs/todo.md` and, if this release teaches one, `docs/lessons.md` are updated in the same pass.
No migration is involved: TB8-04 touches no schema, no Worker and no binding, so the deploy is the
app Worker alone.
