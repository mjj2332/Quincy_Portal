# TB8-05 — Notification Preferences and the Three App-Shell Defects: Visual Plan

**Status: REVIEWED — Sol rounds 1 and 2 complete, not built, not deployed.** Branch off `main` at
`e8053af`
(TB8-04 live in production: app Worker `c620c514`, no migration, rollback target app `9a021a5e`).
Move to `docs/plans/implemented/` once built, verified, committed **and** deployed, per the
standing convention in `CLAUDE.md`.

**Review record.** Sol round 1 returned ten findings (all resolved or, in one case, withdrawn by
Sol on evidence). Sol round 2 — the lane's final round — returned one blocker, one should-fix and
three nits; every one was independently verified against the source by this session before being
applied, and all five are now folded in: the blocker is §5.4.2b (1) / §7 rows 18b-18c (`.avatar`
has a **second** consumer), the should-fix is §9.1 test 6 (React 19.2.8 makes the runtime-only
version of that test vacuous), and the nits are the §7 tally, the overstated `!`-usage claim in §7,
and §10.2's item numbering. **Awaiting owner plan-approval before build.**

Ranking candidate **#5** of
[Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md](Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md)
("notification bell / preferences / Admin delivery UI"), **rescoped by owner decision 2026-09-03**
— see §1.2. Fifth in the TB8 series after
[TB8-01 Dashboard Shell](implemented/TB8-01-Dashboard-Shell-Visual-Plan.md),
[TB8-02 Menus, Dialogs and Popovers](implemented/TB8-02-Menus-Dialogs-Popovers-Visual-Plan.md),
[TB8-03 Project Workspace Rail](implemented/TB8-03-Project-Workspace-Rail-Visual-Plan.md) and
[TB8-04 Project and Admin Forms](implemented/TB8-04-Project-And-Admin-Forms-Visual-Plan.md), and
the sixth bounded Tailwind consumer overall (TB1 was the first).

Written under the Claude design lane in
[Subagent-Frontend-Orchestration.md](../Subagent-Frontend-Orchestration.md): Opus drafts at
implementation-detail resolution, Sol reviews scope and correctness only, a Sonnet subagent builds.
**This plan closes every design decision itself.** Where a class string appears below, the builder
applies it verbatim; it does not invent one. The one measurement this plan does not yet carry is
`N` in §5.4, and §5.4.1 is the procedure that pins it **before** this plan goes to Sol — it is not
a builder decision.

## Styling-owner authority

The owner decision in `Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md` §"Decision: Tailwind
adoption scope for TB8 (2026-09-01)" extends Tailwind v4 + shadcn (`base-sera`,
`cssVariables: true`, Lucide, Preflight disabled, no dark mode) surface-by-surface, on the
foundation already wired in `portal/apps/web/components.json` and `src/styles/index.css` — never a
new or parallel setup. TB8-05 claims **three more bounded surfaces**: the Notification preferences
screen, the impersonation banner, and the topbar's brand link plus its responsive collapse. On
those surfaces Tailwind becomes the single styling owner and the `app.css` rules that painted them
are disposed of per §7. Everything else keeps `app.css` as its owner, untouched.

## Authority boundary

This plan may change paint, geometry, markup structure, copy that describes existing behaviour,
and class ownership. It may **not** change what the app does. Every capability gate, role check,
mutation path, network call, ARIA role, live-region politeness and focus behaviour survives
byte-for-byte in behaviour. Per D-18 it has no authority to change product semantics, the data
contract, or capability definitions. In particular: no new notification preference is introduced,
no preference is removed, and the `/api/notification-preferences` contract
(`{ projectDeadlineReminderEmails: boolean }`) is untouched. §12 carries the questions that belong
to the owner rather than to me.

---

## 1. Scope

### 1.1 In scope — four files, three surfaces

| # | File | Surface |
|---|------|---------|
| 1 | `portal/apps/web/src/screens/NotificationPreferences.tsx` | The Notification preferences screen (rebuilt) |
| 2 | `portal/apps/web/src/components/ImpersonationBanner.tsx` | The impersonation banner (converged; fixes defect B1) |
| 3 | `portal/apps/web/src/components/Topbar.tsx` | The brand link (defect B3), the responsive collapse (defect B2), **the invisible mobile menu (defect B4, §5.4.2a)**, and the bell's last two `app.css` rules (§5.5) |
| 4 | `portal/apps/web/src/styles/app.css` | The retirement ledger in §7 |

Test files updated in the same commit (§9):
`screens/NotificationPreferences.dom.test.tsx`, `components/ImpersonationBanner.dom.test.tsx`,
`components/Topbar.dom.test.tsx`.

### 1.2 Why the named candidate was rescoped — and by how much

Candidate #5 names three surfaces. Two of them are **already converged**, verified against `HEAD`
this session:

- **The notification bell.** `Topbar.tsx:24-68` carries the whole panel, row, unread-rule,
  highlight, dismiss and badge system as Tailwind utility strings on the shared `Menu` primitive
  (TB8-01 for the paint, TB8-02 for the overlay). `app.css` retains exactly one bell rule
  (`:73`, the 19px SVG sizing) and one positioning rule (`:69`); every other
  `.topbar__notification-*` class is already a non-styling test hook.
- **The Admin delivery UI.** `Admin.tsx:673-710` is `SectionHead` + `StatusPill` + `TabStrip` +
  `TableWrap`/`Table` + `Notice` + `EmptyState`, with TB8-04's `min-[721px]`/`max-[721px]` stacked
  table pattern and `data-label` cells. `.admin-poison`, `.admin-section__head`, `.admin-table`,
  `.admin-table__action` and `.admin-tabs` have **zero rules** in `app.css` — they are already
  test hooks only.

What is genuinely unconverged is the third surface, and it is one 23-line screen. Rather than
ship a release that touches one file, the owner decided 2026-09-03 to widen TB8-05 to absorb the
**three pre-existing app-shell defects** TB8-04 confirmed at `HEAD` and deliberately left. That is
a defensible pairing, not a grab-bag: `.topbar__user` is the bell's own container, so its overflow
band is a bell defect; and the impersonation banner sits directly above the bell in the same shell.

### 1.3 Deferred — and where the boundary falls

- ~~**The bell's remaining two `app.css` rules** (`:69`, `:73`).~~ **Folded into this release**
  (owner, 2026-09-03, §12 Q4). The draft deferred them to candidate #10 to keep the `Topbar.tsx`
  diff narrow; the owner's call is that finishing the bell in the release named after the bell is
  worth four lines of extra diff. See §5.5. With this, `app.css` retains **zero** styling rules for
  the notification bell.
- **The Admin delivery UI.** No change. It is converged; re-touching it would be churn.
- **`.notice` (`app.css:880`).** Kept — five out-of-scope consumers (§7 row 5).
- **`.button--text` (`app.css:876-877`).** Kept — **seven** occurrences across **four** files
  after this release (§7 row 6). This plan removes **four** of its eleven occurrences
  (`ImpersonationBanner.tsx:38`, `Topbar.tsx:145`, `:217`, `:219` — the whole of `Topbar.tsx`) and
  fixes the defect its hover rule causes on one of them; it does not retire the class, because
  `ProjectActivityView.tsx:53` and the six Calendar consumers still use it.
- **A shared `Switch` primitive.** Not introduced. There is one toggle in the app outside the
  Admin screen; a primitive with one consumer is speculative. §5.1 composes the existing
  `Checkbox` + `TOGGLE_ROW`.
- **New preference rows.** Out of authority (§Authority boundary).

### 1.3a Scope change since owner approval — defect B4

**The owner approved this release against three shell defects (B1, B2, B3). Sol's round-1 review
surfaced a fourth, and it is in this plan without a fresh approval, so it is flagged here rather
than buried in §5.**

**B4: the mobile navigation menu panel has been invisible at every width since TB8-02
(`c5e246f`), and TB8-02 is deployed.** At any viewport ≤720px the app today has no navigation, no
Notification preferences link and no Sign out — the trigger opens a panel whose computed `display`
is `none`. Measured, not inferred; the evidence table, the control comparison and the git
archaeology are in §5.4.2a.

It is in scope for three reasons, and the owner should overrule any of them they disagree with:

1. **It is a precondition, not an addition.** §5.4's approved change sends *more* of the topbar
   into that menu. Shipping B2 without B4 would take a layout defect and make it a total loss of
   navigation on phones.
2. **It is the same rule.** B4 and half of B2's implementation are both `app.css:67`. There is no
   version of this release that does not already delete that line.
3. **It is a live production defect on the surface this release owns**, found by this release's own
   review, and the fix is a one-line deletion (§7 row 18a).

**Owner ruling, 2026-09-03: folded in, as written here** (§12.0 Q5). The alternative — a
standalone hotfix deleting `.topbar__mobile-menu` from `app.css:67` ahead of TB8-05 — was
considered and declined; the accepted consequence is that phone navigation is restored when TB8-05
deploys, not before.

### 1.4 Drift register

`docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md` carries no row for the preferences
screen. Following TB8-04's precedent (its §1.3/§1.4), this plan's §3 evidence register **is** the
drift record for this surface, and a `TB0-VIS-05` row is appended to the register in the same
commit with the exact content in §11 artefact 8.

Defect B4 additionally gets its **own** row, `TB0-VIS-06`, because it is a regression *caused by* a
prior TB8 release rather than pre-existing drift, and the register should show that the series
introduced it and the series caught it (§11 artefact 8b).

---

## 2. Foundation

### 2.1 Reused verbatim — nothing new is invented

Every primitive below already ships. This release adds **no** new file under `components/`.

| Primitive | From | Used here for |
|---|---|---|
| `Eyebrow` | `components/ui/eyebrow.tsx` | The page eyebrow and the two channel labels |
| `Checkbox`, `CHECKBOX_INPUT`, `TOGGLE_ROW` | `components/ui/checkbox.tsx` | The email toggle and its row metrics |
| `Notice` | `components/quincy/Notice.tsx` | The save/load error |
| `buttonClasses` | `components/ui/button.tsx` | The banner's Exit button |
| `cn` (`clsx` + `twMerge`) | `lib/utils.ts` | Every composed string |

**`cn` is `twMerge`-backed**, so a later conflicting utility deterministically replaces an earlier
one *within the same variant key*. This is load-bearing in §5.2 (overriding `VARIANT.text`'s
colours) and §5.1 (overriding `TOGGLE_ROW`'s `flex` with `grid`). It does **not** merge across
different variant keys (`min-h-[32px]` does not remove `max-[721px]:min-h-[44px]`).

**Arbitrary *property* utilities do merge when the property name matches.** The installed
`tailwind-merge` is **3.6.0** (`portal/package.json`), which derives a conflict group from the
arbitrary property name itself, so `[font:var(--a)]` followed by `[font:var(--b)]` collapses to the
second. Only *different* property names stay independent (`[font:…]` and `[color:…]` both survive).
Verified directly against the installed package, not assumed:

```
twMerge('[font:var(--type-label)]','[font:var(--type-body)]') → '[font:var(--type-body)]'
twMerge('[font:var(--a)]','[color:red]')                      → '[font:var(--a)] [color:red]'
```

Consequence for this plan: no constant here may set `[font:…]` twice and expect both to apply, and
a consumer passing a `[font:…]` through `className` *replaces* the constant's own — which is the
behaviour §5.2's `EXIT` and §5.1's constants rely on, not a hazard, but it is now stated correctly.

### 2.1a Control height: 38px at desk, 44px in the hand

Unchanged from TB8-04 §2.1a. `TOGGLE_ROW` already encodes it
(`min-h-[38px] max-[721px]:min-h-[44px]`); §5.1 and §5.3 cite those exact values rather than
restating a number.

### 2.2 The unlayered-`app.css` cascade rule

`src/styles/index.css` declares `@layer theme, base, components, utilities` and then imports
`app.css` **outside any layer**. Any rule in `app.css` therefore beats an ordinary Tailwind utility
regardless of specificity. Every legacy selector this plan touches carries an explicit disposition
in §7, one of:

- **D** — Delete. The rule's last consumer is gone in this release.
- **R** — Retain as a non-styling hook. The class stays in the JSX (a test or another selector
  queries it), the rule is deleted.
- **K** — Keep, rule and all. Out-of-scope consumers survive.
- **!** — Neither fits; the Tailwind side carries an `!`-prefixed utility.

### 2.3 The three CSS traps

`docs/lessons.md` §"Three CSS traps a Tailwind convergence walks straight into (TB8-04,
2026-09-03)" is binding on this plan:

1. **`:read-only` matches every `<select>`.** Not reachable here — this release renders no
   `<select>` and does not touch `FIELD_BOX`. The `[&:read-only:not(select)]:` guard in
   `components/ui/input.tsx` is **not** to be touched; the `:not(select)` is load-bearing.
2. **`max-[Npx]` is exclusive.** Every breakpoint utility in this plan is written as the
   complementary pair `max-[Npx]` / `min-[Npx]`, so exactly one branch matches at every width.
   Where a legacy `@media (max-width: 720px)` block is the counterpart, the Tailwind form is
   `max-[721px]` — do not "simplify" it to 720.
3. **`display:block` on a table destroys the a11y tree.** Not reachable here — no table.

---

## 3. The survey

Evidence IDs `E-1`…`E-16`. Every one was verified against `HEAD` (`e8053af`) this session by
reading the named file and line, except `E-13`, which §5.4.1 measures.

### 3.1 Evidence register — the preferences screen

**E-1 — the whole screen is one unformatted JSX line.**
`screens/NotificationPreferences.tsx:22` is a single **935**-character return statement. Nothing is
wrong with that as code, but it makes every state and every class invisible to review, and it is
the reason the defects below survived four TB8 releases.

**E-2 — `.page__head` and `.lede` have no CSS at all, and this screen is their only consumer.**
`grep -n "page__head\|lede" src/styles/app.css` returns nothing; `grep -rn "page__head"` over
`*.tsx` returns exactly `NotificationPreferences.tsx:22`. So the screen's `<h1 className="serif">`
renders at the **browser default `2em` (32px)** in the display serif, not the `--type-h1` 48px
every other screen head uses (`Admin.tsx:435`), and the `<p className="lede">` renders at the
inherited body size with no colour or measure. **This is a live visual defect, not merely
unconverged markup.**

**E-3 — the page head does not match the app's own converged pattern.**
`Admin.tsx:432-437` is the shipped head: a flex `<header>`, `<Eyebrow className="block mb-…">`,
`<h1 className="[font:var(--type-h1)] tracking-[var(--tracking-tight)]">`. This screen uses
`div.page__head > div > div.ey + h1.serif + p.lede` instead.

**E-4 — the card is legacy CSS with three rules and one consumer.**
`app.css:258-260`. `display:flex; justify-content:space-between; max-width:720px; padding:24px;
border:1px solid var(--border-hairline); background:var(--paper-000)` plus an `h2` at a hardcoded
`font-size: 22px` (which is `--text-lg`, the value `--type-h3` already carries) and a `p` at
`margin: 7px 0 0` (off the 4px grid).

**E-5 — the toggle is a raw `<input type="checkbox">` on a legacy class.**
`app.css:929` `.admin-toggle` has `min-height: 38px` and **no `max-width: 720px` bump to 44px**,
so the only interactive control on the screen is a 38px touch target on a phone. `font-size: 13px`
is also off the type scale (nearest tokens: `--text-xs` 12px, `--text-sm` 14px).
`.admin-toggle`'s last other consumer went away in TB8-04, which moved the impersonation switch
onto `TOGGLE_ROW`; this screen is now its only consumer.

**E-6 — the error is rendered at the bottom of the page, far from the control that failed.**
`NotificationPreferences.tsx:22` closes with `{error && <div className="notice" role="alert">…}`
*after* `</section>`. `.notice` carries `margin-top: var(--space-4)`, so a save failure appears
below the card rather than beside the toggle that caused it. `role="alert"` means it is announced,
but a sighted user's eye has to travel to find it.

**E-7 — "Loading…" and the on/off state share one text slot, so the control's label changes
identity.** The visible span reads `Loading…`, then `On`, then `Off`. Because that span sits
*inside* the `<label>`, it is part of the checkbox's accessible name: the control is announced as
"Project deadline reminder emails Loading…" during load.

**E-8 — the saving state has no visible affordance.** `saving` only disables the checkbox
(`disabled={loading || saving}`) and writes into a `sr-only` live region. A sighted user sees the
control grey out with no explanation.

**E-9 — the mandatory channel is prose, not a state.** "In-app Deadline reminders are always
delivered." is a `<p>` under the heading. The fact it states — that one delivery channel is not a
choice — is exactly the kind of thing an interface should show structurally, and the app already
has the vocabulary for it: the Admin delivery table's own **Channels** column renders
`channel: status` pairs (`Admin.tsx:703`).

**E-10 — `.preferences-page` is already a dead selector.** Zero rules in `app.css`, one consumer
in the JSX, queried by no test.

### 3.2 Evidence register — the three app-shell defects

**E-11 (defect B1) — the impersonation banner's Exit button is invisible on hover.**
`app.css:37` `.impersonation-banner .button--text { color: var(--paper-050); }` has specificity
**(0,2,0)**. `app.css:877` `.button--text:hover:not(:disabled) { color: var(--text-primary); }`
has specificity **(0,3,0)** — `:not()` contributes its argument's specificity, so that is three
class-level components against two. On hover the later, more specific rule wins and the label
becomes `--text-primary` (`--ink-900`, `#0a0a0a`) on the banner's `background: var(--ink-900)`
(`app.css:35`): **1:1 contrast, fully invisible.** A scoped
`.impersonation-banner .button--text:hover` would be (0,3,0) and would win only on source order —
which is why the naive fix is fragile, and why §5.2 removes the legacy class from the component
instead of escalating.

**E-12 (defect B1, second half) — the focus ring has the same problem.** `.button--text` inherits
the shared focus treatment; the Tailwind `buttonClasses` path uses `focus-visible:outline-ring`,
and `--ring` resolves to `--focus-ring` → `--ink-900`. An ink ring on an ink banner is invisible
too. Any fix that only addresses hover leaves keyboard users with no focus indicator.

**E-13 (defect B2) — `.topbar__user` overflows horizontally in a band above 720px.**
`app.css:787-792` hides `.topbar__identity`, `.avatar` and `.topbar__user > .button` — and reveals
`.topbar__menu-trigger` — at `@media (max-width: 720px)`, i.e. **≤720px**. Above that the full
desktop cluster renders: bell (34px) + identity block (name up to 180px + email) + the
"Notification preferences" text link + avatar (32px) + "Sign out", at `gap: var(--space-3)`,
alongside brand + divider + topnav at `gap: var(--space-6)` inside `padding: 0 var(--space-7)`.
That is far more than 721px of content. **The exact band is measured in §5.4.1** — TB8-04 recorded
it as 721–747px; this plan does not trust that number without re-measuring, because the band's
upper edge depends on the rendered name length and TB8-04 did not record which account it
measured.

**E-14 (defect B3) — `.topbar__brand` is a 32px touch target below 721px.**
`Topbar.tsx:145` renders `className="topbar__brand button--text"`. `.topbar__brand`
(`app.css:55-56`) sets no height; the 18px wordmark plus `.button--text`'s
`min-height: 32px; padding: 6px 0` (`app.css:876`) gives **32px**. The `@media (max-width: 720px)`
block never raises it. The brand link is the app's "home" affordance and is one of only two
controls visible on a phone topbar.

**E-15 — the Tailwind text button does *not* have E-14's problem, which shows the fix.**
`buttonClasses("text")` composes `BASE`'s `min-h-[38px] max-[721px]:min-h-[44px]` with
`VARIANT.text`'s `min-h-[32px]`. `twMerge` replaces `min-h-[38px]` (same variant key, later wins)
but leaves `max-[721px]:min-h-[44px]` untouched (different variant key). So a converged text
button is already 32px at desk and 44px in the hand. Only the **legacy** `.button--text` class
lacks the bump.

**E-16 — the banner's own CSS is four rules with one consumer.** `app.css:35-38`, consumed only by
`ImpersonationBanner.tsx`. `ImpersonationBanner.dom.test.tsx:56` queries `.impersonation-banner`,
so that class name must survive as a hook.

### 3.3 What the register adds up to

Ten findings on a 23-line screen, two of which (E-2, E-5) are live defects rather than drift, plus
four shell findings of which three are the defects this release was widened to fix. The screen is
not "unconverged but fine"; it is the least-finished surface in the app.

---

## 4. Design direction

### 4.1 The organising idea: the delivery ledger

The screen's single job is to let one person decide whether deadline reminders also reach their
inbox. The template answer is a settings card with a title, a sentence, and a switch floated
right — which is exactly what ships today, and it is why the mandatory in-app channel had to be
explained in prose (E-9).

The truer structure is a **delivery ledger**: one row per channel, each row stating that channel's
state. In-app reads `Always on` and carries no control, because it is not a choice. Email carries
the toggle. The structure itself then encodes the thing the prose had to say, and it says it in
the vocabulary the app already uses for the same subject one screen away — the Admin delivery
table's **Channels** column renders `channel: status` (E-9). Staff-facing and operator-facing
views of notification delivery start speaking the same language.

This is the repo's own editorial system doing what it is for: hairline rules, square corners,
eyebrow labels in the left column, values in the right, no elevation. It is not a new device.

### 4.2 The one aesthetic risk, and why it is worth taking

**A row with no control in it.** The In-app row is a live-looking ledger row whose value is static
text. A reviewer's instinct is that it should be a disabled switch, for symmetry. It should not:
a disabled switch says "you may not do this", implies the state is changeable in principle, and
adds a second greyed-out control next to the one that is legitimately grey while saving (E-8) —
the exact signal-dilution the `:read-only` defect caused on the Admin screen in TB8-04. Static
text says "this is how it is", which is true. The asymmetry is the message.

The risk is that the row reads as unfinished. It is mitigated by giving the value slot the same
type and alignment in both rows, so the ledger reads as a table of states rather than a form with
a missing input.

### 4.3 Colour discipline

No new colour. The card is `bg-card` (`--paper-000`) on the page's `--paper-050`, bordered
`border-border` at `--border-width-hair`. `Always on` is `text-foreground-secondary`
(`--greige-600`) — it is a statement, not an action. `On`/`Off` is `text-foreground`
(`--ink-900`) — it is the live value. `Loading…`/`Saving…` is `text-muted-foreground`
(`--greige-400`) — transient. The error is `Notice tone="critical"`, which is the existing
oxblood wash. That is four greys and one signal, all tokens, no invention.

On the banner, the two overrides are `--color-on-inverse` (`--paper-050`) and
`--color-on-inverse-muted` (`--greige-200`), both already declared in `tokens/tailwind.css:57-58`
for exactly this purpose ("Ink surface for inverse elements").

### 4.4 Copy

Every string below is either kept verbatim from `HEAD` or is a restatement of a fact the code
already establishes. Nothing asserts product behaviour this session could not verify.

| Slot | Before | After | Source |
|---|---|---|---|
| Eyebrow | `Personal settings` | `Personal settings` | kept |
| H1 | `Notification preferences` | `Notification preferences` | kept |
| Lede | `Choose how deadline reminders reach you.` | `How deadline reminders reach you.` | tightened — the page *is* the choosing, so the verb was doing double duty |
| Card heading | `Project deadline reminder emails` | `Project deadlines` | **revised 2026-09-03 (§12 Q2).** The old string named a *channel* (`emails`) in a slot that should name a *category*. The ledger rows own the channels, so the heading owns the category — and a second category later (mentions, stage changes) becomes a second card of the same shape with nothing renamed. |
| Mandatory-channel prose | `In-app Deadline reminders are always delivered.` | *(removed as prose)* → row value `Always on` + footnote `In-app reminders always arrive in your notification bell.` | same fact, stated as a state plus a plain-language pointer to where they arrive |
| Channel labels | — | `In-app`, `Email` | new; matches the Admin Channels column's own channel names |
| Toggle value | `On` / `Off` / `Loading…` | `On` / `Off` / `Loading…` / `Saving…` | `Saving…` is new (fixes E-8) |
| Errors | server message, else `Preferences could not be loaded.` / `Preferences could not be saved.` | unchanged | kept |

---

## 5. The target visual system

### 5.1 `screens/NotificationPreferences.tsx` — the rebuild

The file is rewritten. **All logic is preserved exactly**: the same `useState` set, the same
`apiGet`/`apiPatch` calls and paths, the same optimistic update with rollback on failure, the same
`ApiError` handling, the same `active` cleanup flag, the same `sr-only` live region. Only the
render changes, plus the two additions §5.1.5 names.

#### 5.1.1 Class constants

Declared at module scope, above the component, in this order:

```tsx
// The page frame. `.page` is unlayered app.css (max-width 1480px), so the narrower measure this
// single-column screen wants must be `!`-prefixed to beat it — same device as Admin.tsx:431.
const PAGE = "page !max-w-[var(--container-md)]";

// The page head, matched to the app's shipped pattern (Admin.tsx:432-437).
const HEAD = "flex flex-wrap items-end justify-between gap-[var(--space-6)] mb-[var(--space-6)]";
const H1 = "[font:var(--type-h1)] tracking-[var(--tracking-tight)] m-0";
const LEDE = "mt-[var(--space-3)] mb-0 max-w-[46ch] " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] " +
  "text-foreground-secondary";

// The card. Square, hairline-bordered, no elevation — the brand's own card.
const CARD = "bg-card [border-style:solid] border-[length:var(--border-width-hair)] border-border " +
  "p-[var(--space-5)] max-[721px]:p-[var(--space-4)]";
const CARD_TITLE = "m-0 [font:var(--type-h3)] tracking-[var(--tracking-tight)] text-foreground";

// One ledger row: eyebrow left, value right. Below 721px the two columns stack, because a 140px
// label column plus a value does not fit a 390px viewport without the value wrapping mid-word.
// `max-[721px]` and `min-[721px]` are exactly complementary — see lessons.md trap 2.
const ROW = "grid grid-cols-[minmax(0,140px)_minmax(0,1fr)] items-center gap-[var(--space-4)] " +
  "max-[721px]:grid-cols-1 max-[721px]:gap-[var(--space-1)] " +
  "py-[var(--space-4)] " +
  "[border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border " +
  "first:border-t-0 first:pt-[var(--space-4)]";

// The email row is the same grid, wearing TOGGLE_ROW's metrics and cursor. TOGGLE_ROW leads with
// `flex`; `grid` appears later in the merged string and `cn` is twMerge-backed, so `grid` wins
// deterministically (§2.1) — this is not source-order luck.
const CONTROL_ROW = cn(TOGGLE_ROW, ROW, "text-foreground");

// The value slot. Same type and alignment in both rows, so the ledger reads as a table of states
// (§4.2) rather than a form with a missing input.
const VALUE = "flex items-center gap-[var(--space-2)] " +
  "[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)]";

// The footnote under the ledger.
const FOOT = "mt-[var(--space-4)] mb-0 " +
  "[font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] " +
  "text-muted-foreground";
```

`TOGGLE_ROW` and `cn` are imported; `Eyebrow`, `Checkbox`, `Notice` are imported.

#### 5.1.2 The render

```tsx
const busy = loading || saving;
const valueText = loading ? "Loading…" : saving ? "Saving…" : enabled ? "On" : "Off";
const valueTone = busy ? "text-muted-foreground" : "text-foreground";

return (
  <main className={PAGE}>
    <header className={HEAD}>
      <div>
        <Eyebrow className="block mb-[var(--space-3)]">Personal settings</Eyebrow>
        <h1 className={H1}>Notification preferences</h1>
        <p className={LEDE}>How deadline reminders reach you.</p>
      </div>
    </header>

    <section className={CARD} aria-labelledby="deadline-reminders">
      <h2 id="deadline-reminders" className={CARD_TITLE}>Project deadlines</h2>

      <div className="mt-[var(--space-4)]">
        <div className={ROW}>
          <Eyebrow>In-app</Eyebrow>
          <span className={cn(VALUE, "text-foreground-secondary")}>Always on</span>
        </div>

        <label className={CONTROL_ROW}>
          <Eyebrow>Email</Eyebrow>
          <span className={cn(VALUE, valueTone)}>
            <Checkbox
              // `aria-label` deliberately overrides the wrapping <label>'s computed name. The
              // label exists to make the whole row clickable; without this the control would be
              // announced as "Email On", which names the column rather than the preference.
              // Load-bearing — do not remove as redundant.
              aria-label="Project deadline reminder emails"
              checked={enabled}
              disabled={busy}
              className={saving ? "disabled:!cursor-wait" : undefined}
              onChange={(event) => void change(event.target.checked)}
            />
            {valueText}
          </span>
        </label>
      </div>

      <p className={FOOT}>In-app reminders always arrive in your notification bell.</p>

      {error && <Notice role="alert" className="mt-[var(--space-4)]">{error}</Notice>}
    </section>

    <div aria-live="polite" className="sr-only">{saving ? "Saving notification preferences" : ""}</div>
  </main>
);
```

`className="page preferences-page"` becomes `className={PAGE}` — `preferences-page` is dropped
entirely (E-10: zero rules, no test queries it). `.page__head`, `.ey`, `.serif`, `.lede`,
`.preferences-card`, `.admin-toggle` and `.notice` all leave this file.

#### 5.1.3 Every state, closed

| State | Checkbox | Value text | Colour | Cursor | Announced |
|---|---|---|---|---|---|
| Loading | rendered, `disabled` | `Loading…` | `text-muted-foreground` | `not-allowed` (`CHECKBOX_INPUT`) | name stays "Project deadline reminder emails" (fixes E-7) |
| On | enabled, checked | `On` | `text-foreground` | `pointer` | — |
| Off | enabled, unchecked | `Off` | `text-foreground` | `pointer` | — |
| Saving | `disabled` | `Saving…` | `text-muted-foreground` | `wait` (`disabled:!cursor-wait`) | existing `aria-live` region (fixes E-8) |
| Error | returns to its pre-save state | reflects the rolled-back value | `text-foreground` | `pointer` | `Notice role="alert"`, now inside the card (fixes E-6) |
| Focus | `CHECKBOX_INPUT`'s `focus-visible:outline-ring` + `outline-offset-2` | — | — | — | — |
| Hover | row-wide via the `<label>`; no paint change | — | — | `pointer` | — |

**No hover background on the row.** The card has one interactive row; tinting it on hover would
imply the row is a menu item. The cursor and the checkbox's own affordance carry it.

#### 5.1.4 Responsive

| Viewport | Layout |
|---|---|
| 1440×900 | Page capped at `--container-md` (860px). Ledger rows two-column, 140px label. Control row 38px min. |
| 1024×768 | Identical — the page measure, not the viewport, governs. |
| 390×844 | `.page` padding drops to `var(--space-4)` (`app.css:788`, out of scope, unchanged). Card padding `var(--space-4)`. Rows stack to one column, `gap-[var(--space-1)]`. Control row 44px min via `TOGGLE_ROW`. |

The boundary pair is `max-[721px]` / `min-[721px]` throughout: `max-[721px]` matches ≤720,
`min-[721px]` matches ≥721, complementary with no gap (lessons.md trap 2).

#### 5.1.5 The two behavioural additions, and why each is in scope

1. **`Saving…` in the value slot.** Purely presentational; it renders existing `saving` state that
   was previously visible only to a screen reader (E-8). No new state, no new call.
2. **`disabled:!cursor-wait` while saving.** `CHECKBOX_INPUT` ships `disabled:cursor-not-allowed`;
   both live in the utilities layer at equal specificity, so which wins depends on Tailwind's
   generated rule order, not on class-string order — the exact cascade trap TB8-02 shipped once
   (`.subtask-popover__actions .button`). The `!` makes it deterministic.

Neither changes what the app does.

### 5.2 `components/ImpersonationBanner.tsx` — defect B1

The component is converged whole, so the banner has one styling owner (§Styling-owner authority).
`app.css:35-38` is deleted; `.impersonation-banner` and `.impersonation-banner__identity` /
`__error` survive in the JSX as non-styling hooks (E-16).

```tsx
// The banner is a fixed ink strip above the topbar. Its 42px height is load-bearing: five
// app.css rules offset the topbar, rail, worktools, viewer and collaboration wrap by exactly
// 42px under `.app--impersonating` (app.css:39-43, :823, :1074-1075). Do not change it here.
const BANNER = "impersonation-banner fixed inset-x-0 top-0 z-[76] flex items-center " +
  "gap-[var(--space-3)] h-[42px] overflow-hidden px-[var(--space-6)] " +
  "bg-surface-inverse text-on-inverse " +
  "[font:var(--weight-regular)_var(--text-2xs)/1.2_var(--font-sans)] " +
  "uppercase tracking-[var(--tracking-wide)]";

const IDENTITY = "impersonation-banner__identity min-w-0 overflow-hidden text-ellipsis whitespace-nowrap";

// Exit sits on ink, so every colour `VARIANT.text` sets has to be inverted — including the
// disabled colour from BASE and the focus ring, which is `--ring` → `--ink-900`: an ink ring on
// an ink strip is as invisible as the ink label was (E-11, E-12). `cn` is twMerge-backed, so
// these later utilities replace the earlier ones within each variant key (§2.1).
//
// `focus-visible:!outline-on-inverse` needs the important modifier, and the reason is the §2.2
// cascade rule, not specificity: `styles/tokens/base.css:25` declares a GLOBAL
// `:focus-visible { outline: var(--border-width-bold) solid var(--focus-ring); }`, and
// `index.css:8` imports `base.css` outside any layer. That unlayered *shorthand* resets
// `outline-color` and beats an ordinary layered `outline-*` utility, so without the `!` the ring
// stays `--focus-ring` (ink) on an ink strip — E-12 unfixed. This is the same trap as §2.2, met
// through a token file rather than through `app.css`.
const EXIT = buttonClasses("text", {
  className: "!text-on-inverse-muted hover:not-disabled:!text-on-inverse " +
    "disabled:!text-on-inverse-muted disabled:bg-transparent disabled:border-transparent " +
    "focus-visible:!outline-on-inverse",
});

const ERROR = "impersonation-banner__error flex-[1_1_160px] min-w-0 overflow-hidden " +
  "text-signal-critical normal-case tracking-normal text-ellipsis whitespace-nowrap " +
  "[font:var(--weight-regular)_var(--text-xs)/1.35_var(--font-sans)]";
```

Render: `<aside className={BANNER} …>`, `<span className={IDENTITY}>`,
`<button className={EXIT} …>`, `<span className={ERROR} …>`. The `aria-label`,
`data-invalidated`, `role="alert"`, `title` and `disabled` attributes and every handler are
untouched.

**Why the root-cause fix is removal, not escalation.** A scoped
`.impersonation-banner .button--text:hover` would also be (0,3,0) and would win only because it
sits later in the file — a tie broken by source order, i.e. the same fragility that produced
TB8-02's `.subtask-popover__actions .button` regression. Taking the component off `.button--text`
entirely removes the collision instead of winning it. `.button--text` itself stays for its nine
surviving occurrences across five files (§7 row 6).

**Contrast, to be measured (§10.2 item 6).** `--greige-200` `#cfc7b6` on `--ink-900` `#0a0a0a`
computes to roughly 12:1, and `--paper-050` `#faf8f2` on the same ground to roughly 19:1 — both
far clear of the 4.5:1 AA floor for the 11px label, against `HEAD`'s 1:1. The measurement is taken
by canvas composite (lessons.md, "The method, which generalises") rather than by parsing a colour
string, because `bg-surface-inverse` resolves through nested `var()`.

### 5.3 `components/Topbar.tsx` — the brand link, defect B3

`Topbar.tsx:145` becomes:

```tsx
<InternalLink className={BRAND} to="/" aria-label="Quincy Portal home">
```

with, at module scope:

```tsx
// The brand is a wordmark, not a button — it never wore `.button--text` for its paint, only for
// its (32px) height, which is below the touch minimum on a phone where it is one of two visible
// controls (E-14). `buttonClasses("text")` would be correct too, but a link wearing a button's
// uppercase label type for an image it does not have is noise. 44px touch target — WCAG 2.5.5
// Enhanced / HIG, not a spacing token.
const BRAND = "topbar__brand flex items-center gap-[var(--space-4)] cursor-pointer no-underline " +
  "min-h-[32px] max-[721px]:min-h-[44px] [&_img]:h-[18px]";
```

`app.css:55-56` is deleted; `.topbar__brand` survives as a hook.

**Nothing else about the brand changes.** The wordmark asset, its 18px height, the `aria-label`
and the route are identical.

### 5.4 `components/Topbar.tsx` — the responsive collapse (defect B2) and the invisible mobile menu (defect B4)

#### 5.4.1 The measurement that pins `N` — a plan-blocking step

The band's edges are not guessable, and TB8-04's recorded "721–747px" did not name the account it
measured, so a longer display name moves the upper edge. Before this plan goes to Sol, this
session measures it, in the Browser pane, against local dev at `http://localhost:8787` signed in
as `mjj2332@gmail.com`.

**Procedure** (the same-origin-iframe method from lessons.md — the emulated viewport is pinned at
2560 CSS px and window resizing does not move it):

1. Create `<iframe src="/" style="width:Wpx;height:844px;border:0">` on the dashboard, same
   origin, so its media queries evaluate against `W` and its `contentDocument` stays scriptable.
2. For `W` from 721 upward in 1px steps to 1200, read from the iframe document the rendered
   width of `.topbar .grow`, `.topbar__brand`, `.topbar__brand img`, `.topbar__divider`,
   `.topnav` and `.topbar__user`, plus `header.scrollWidth` / `header.clientWidth`.
3. `N` = the smallest `W` at which **`.grow` has non-zero width**, staying non-zero and
   non-decreasing for every `W` above it up to 1200 — the first width at which every topbar item
   is at its natural size with slack left over.

   **Absence of overflow is NOT the criterion, and using it produces a wrong number by ~230px.**
   Measured 2026-09-03: the no-overflow width is 763, but flexbox reaches it by *compressing* —
   below ~797px `.topbar__brand` and `.topbar__divider` are squashed to **0px** and
   `.topbar__user` is crushed from its 523px intrinsic width to 402px. A topbar that "fits"
   with an invisible wordmark is not a topbar that fits. `.grow` is the honest signal: it is the
   flex spacer, so it can only open up once nothing else is being squeezed. The first draft of
   this procedure got this wrong; it is recorded here so the next breakpoint measurement in this
   repo does not repeat it.
4. Repeat with `.topbar__identity strong` forced to its 180px `max-width` cap (the longest name
   the CSS can render) and take the larger `N` of the two runs. The cap, not the seeded name, is
   what the fix has to survive.
5. Sanity-check the method itself before trusting any number: at `W = 400` the iframe must report
   `.topbar__menu-trigger` with a computed `display` other than `none`. A sweep whose media
   queries are not actually evaluating produces confident wrong numbers silently.

**Decision rule, stated in advance so the number does not become a judgement call:**

- If `N ≤ 1024`: the collapse breakpoint is `N`, expressed as the complementary pair
  `max-[Npx]` / `min-[Npx]`.
- If `N > 1024`: the collapse breakpoint is **1024** anyway — the repo's own evidence viewport
  must keep the desktop topbar — and the residual 1024→`N` overflow is closed by *also* hiding
  `.topbar__identity` and `.avatar` (the two widest optional items) below `N`, giving a two-stage
  collapse.

**Superseded by the owner, 2026-09-03 — see §5.4.2.** The rule above assumed the only cost of a
single-stage collapse was overflow, and it silently ignored *band width*. `N` measured at 1007,
which takes the first branch, but that branch means every window narrower than 1007 — landscape
tablets, any half-screen laptop — gets the phone shell. The owner reviewed the real band and chose
the **two-stage** shape instead, which the rule above had reserved for the `N > 1024` case. The
rule was not wrong about the arithmetic; it was wrong about what made the decision.

Both branches are fully specified; the measurement selects between them and supplies one integer.
The measured `N`, both runs' raw numbers, and the branch taken are recorded in §5.4.3 before Sol
review, and the ASCII of the chosen layout goes in §5.4.2.

#### 5.4.2 The fix, in structure

Every item that disappears from the topbar at the new breakpoint is already present in the mobile
`Menu` (`Topbar.tsx:229-236`: identity, Dashboard, Admin, Notification preferences, Sign out). The
defect B2 half is only that the switch is hard-coded at a phone width (720px) while the desktop
cluster needs far more room.

**But the mobile `Menu` does not currently work, and this release cannot ship the collapse until
it does — see §5.4.2a (defect B4).** Invariant §8.6 — "every item hidden from the topbar remains
reachable in the mobile `Menu`" — is *false in production today*. Sending more of the cluster into
a menu that never paints would turn a layout defect into a total loss of navigation.

##### 5.4.2a Defect B4 — the mobile navigation menu has been invisible since TB8-02

**Found during Sol's round-1 review (2026-09-03), confirmed by measurement, not by reading.**

`app.css:67` carries the unlayered rule

```css
.topbar__menu-trigger, .topbar__mobile-menu { display: none; }
```

`.topbar__mobile-menu` is the mobile `Menu`'s **panel** (`Topbar.tsx:230`,
`panelClassName="topbar__mobile-menu"`, landing on `MenuPrimitive.Popup` via
`cn(PANEL, panelClassName)` in `components/ui/menu.tsx:98`). Nothing re-enables it: the
`@media (max-width: 720px)` block says nothing about it, and `menu.tsx`'s `PANEL` sets **no
`display` at all**. Per §2.2, the unlayered rule wins at every width.

**Measured 2026-09-03**, Agy over CDP against local dev at `http://localhost:8787`, signed in as
the seeded admin, in a 390×844 same-origin iframe with the 720 media block confirmed active
(`.topnav` computed `display: none`, `.topbar__menu-trigger` computed `flex`). After clicking the
trigger:

| | `.topbar__mobile-menu` | `.topbar__notification-menu` (control) |
|---|---|---|
| In DOM, `data-open=""` | yes | yes |
| computed `display` | **`none`** | `block` |
| `visibility` / `opacity` | `visible` / `1` | `visible` / `1` |
| `getBoundingClientRect()` | **0 × 0** | 156.38 × 110.40 |
| `checkVisibility({checkOpacity, checkVisibilityCSS})` | **`false`** | `true` |
| interactive descendants | 4 (Dashboard, Admin, Notification preferences, Sign out) | 0 (empty state) |
| those descendants' boxes | **all 0 × 0** | non-zero |

The bell menu is the control: same primitive, same portal, same positioner, no `display:none` rule
against it — and it paints. That isolates the cause to `app.css:67` exactly. Devtools'
matched-rules list for the panel confirms `:67` is the only rule setting `display` on it. A
screenshot of the 390px iframe after the click shows the MENU trigger focused and no panel.

**Introduced by TB8-02** (`c5e246f`, "Menus, Dialogs and Popovers convergence"), which deleted the
`@media (max-width: 720px)` rule that used to supply the panel's display —

```css
/* deleted by c5e246f, formerly app.css:653 */
.topbar__mobile-menu { position: fixed; top: 58px; right: 10px; z-index: 50; display: grid; … }
```

— and replaced it with a comment saying position and paint had moved onto the shared `Menu`
primitive. Position and paint did move. `display` did not: `PANEL` never declared one, relying on
the browser default, which `:67` overrides. TB8-02 is deployed, so **this is live in production**:
at any width ≤720px the app has no navigation, no Notification preferences link, and no Sign out.

**Why the dom tests did not catch it.** `Topbar.dom.test.tsx:57` and `:344-345` and
`ProjectCollaborationPanel.dom.test.tsx:474` all assert DOM *presence* of
`.topbar__mobile-menu` and its links. happy-dom performs no layout and applies no stylesheet, so a
`display:none` panel satisfies every one of them. This is the same class of gap §9.3 already warns
about, met from the other side.

**The fix, and why it is removal rather than a utility.** Delete `.topbar__mobile-menu` from
`app.css:67`. The panel is portalled and Base UI mounts it only while open —
`ProjectCollaborationPanel.dom.test.tsx:476` asserts it is `null` after close — so it never needed
a hidden default. With the rule gone, `PANEL`'s block default applies and the panel paints exactly
where the positioner puts it, which is what TB8-02 intended. No utility, no `!`, no new class.

**Scope note.** B4 is not an extension of this release's ambition; it is a precondition for the
change §5.4 already had owner approval to make. It lives in the same rule, the same file and the
same component as defect B2, and fixing B2 without it would ship a regression. It is nonetheless a
*fourth* defect that was not in the approved scope, and is flagged as such for the owner.

**Owner decision (2026-09-03, §12 Q1): approved, and shaped as a two-stage collapse.** The
approval was first given against a band this session had quoted from TB8-04 as 721–747px. The
measurement (§5.4.3) put the real band at 721–1006px — 286px wide, covering landscape tablets and
any half-screen laptop window. Re-put to the owner with the true number, the decision was **not**
to send that whole band to the phone shell. Three stages:

```
W >= 1007        [brand] [nav] ........ [bell] [Terry / Admin] (TL) [Prefs] [Sign out]
771 <= W <= 1006 [brand] [nav] ........ [bell] [Prefs] [Sign out]
721 <= W <= 770  [brand] [nav] ........ [bell] [Menu]
W <= 720         [brand] .............. [bell] [Menu]
```

**Four configurations, not three, and the bell is in every one.** Sol's round-1 review corrected
the first draft's diagram on both points, and both corrections are behavioural, not cosmetic:

- **The bell never hides.** It is `.topbar__notifications`, a `<div>` — not a
  `.topbar__user > .button` — so no rule in the 720 media block touched it, and none of §5.4's new
  utilities do either. That is correct and deliberate: notifications are the one thing worth a
  permanent slot at every width, and it is 19px wide. The first draft's phone row read
  `[brand] … [Menu]`, which simply mis-drew what already ships.
- **721–770 is a real fourth band**, because the two breakpoints answer different questions
  (below). In it the desktop `.topnav` is still visible *and* the Menu is showing — and the Menu
  repeats Dashboard and Admin. That duplication is intended and harmless: the Menu is the only
  route to Notification preferences and Sign out in that band, and a nav link appearing twice
  costs nothing. It is named here so §10.2 tests it rather than discovering it.

The middle stage drops exactly the two widest optional items — `.topbar__identity` and `.avatar` —
and keeps every *control*. Nothing a person can act on disappears until the phone breakpoint, where
all of it is in the Menu. The identity block is also already reproduced inside the mobile menu
(`.topbar__mobile-identity`, `Topbar.tsx:229`), so nothing is unreachable at any width.

`M = 771`, measured, not chosen — §5.4.3.

##### 5.4.2b The cascade problem, and why the fix is three retirements rather than three `!`s

Sol's round-1 review caught a blocker here that this plan's first draft had wrong: **the collapse
cannot be expressed in ordinary Tailwind display utilities**, because §2.2's unlayered `app.css`
beats every one of them. Three separate rules stand in the way:

| Element | Unlayered rule that wins | Utility it defeats |
|---|---|---|
| `.avatar` | `app.css:75` `.avatar { … display: grid; … }` | `max-[1007px]:hidden` |
| prefs link, Sign out | `app.css:862` `.button { display: inline-flex; … }` | `max-[771px]:hidden` |
| `.topbar__menu-trigger` | `app.css:67` `{ display: none; }` | `max-[771px]:inline-flex` |

The obvious repair is `!hidden` / `!inline-flex` on all three. **This plan does not do that**, for
the reason §5.2 gives about defect B1: winning a cascade fight leaves the fight in place. Every one
of these three has a cheaper root-cause fix, and taking them removes the conflict instead:

1. **`.avatar` is retired into its two consumers.** The first draft of this section claimed it
   had "exactly one consumer"; **Sol's round-2 review found that is false** —
   `SubtaskChecklist.tsx:130` also renders `className="subtask-checklist__assignee avatar"`, and
   its own rule (`app.css:1016`) supplies only `display`, `place-items`, 24px dimensions and 9px
   size. Everything that makes it *look* like an avatar — `border-radius: var(--radius-pill)`,
   `background: var(--ink-900)`, `color: var(--paper-050)`, the `--type-label` font shorthand,
   `letter-spacing: .02em`, `flex: none` — comes from `:75`. Deleting `:75` without acting on that
   would have silently stripped an out-of-scope TB6 component.

   So the retirement is two-sided: `:1016` **absorbs those six shared declarations verbatim**
   (`font: var(--type-label)` before its own `font-size: 9px`, so the shorthand cannot reset it),
   `SubtaskChecklist.tsx:130` drops the now-meaningless `avatar` word from its class list, and
   `:75` is then genuinely dead and retires into an `AVATAR` constant in `Topbar.tsx`. The Topbar
   avatar keeps **no** legacy class — `.avatar` had zero test queries, so there is no hook to
   preserve; §9.3's test queries `[data-slot="avatar"]` instead, matching the `<Notice>`
   convention this release already adopts. `max-[1007px]:hidden` then faces nothing.

   This is the second time in this plan that a TB8-era migration was found to have moved *some* of
   a rule's declarations and left the rest behind (the first is defect B4, §5.4.2a). The §7.1
   retirement gate exists precisely to catch it, and here it did — one review round late.
2. **The prefs link and Sign out converge onto `buttonClasses("text")`**, exactly as §5.2 does for
   the banner's Exit. They leave `.button`/`.button--text` entirely, so `app.css:862`'s
   `display: inline-flex` no longer applies to them. `buttonClasses`' own `BASE` supplies
   `inline-flex` as a *layered* utility in the base variant key, and `max-[771px]:hidden` is a
   different key, so `twMerge` keeps both and the responsive one simply wins by media query — no
   `!`, no source-order dependency. This also takes `.button--text` from **eleven** occurrences to
   **seven, across four files** (§7 row 6) — `Topbar.tsx` leaves the class entirely.
3. **`app.css:67` is deleted outright**, both halves. Its `.topbar__mobile-menu` half is defect B4
   (§5.4.2a) and must go regardless. Its `.topbar__menu-trigger` half is then unnecessary, because
   the trigger's *own* class string can carry `hidden max-[771px]:inline-flex` — again two
   different variant keys, both layered, both surviving `twMerge`. The `hidden` also overrides
   `menu.tsx`'s `TRIGGER` constant, which sets a bare `inline-flex` in the same base key, so
   `cn(TRIGGER, MENU_TRIGGER)` resolves to hidden-by-default correctly.

**Net: the collapse needs zero `!important`.** §7's tally stays `! 0` — not because the first
draft's cascade analysis was right, but because the retirements make it true.

##### 5.4.2c The change, concretely

- `app.css:67` — **deleted** (§5.4.2a, and (3) above).
- `app.css:75` (`.avatar`) — **deleted**, its six shared declarations copied into `:1016`
  (`.subtask-checklist__assignee`) and its Topbar use migrated to `AVATAR` below.
- `app.css:1016` (`.subtask-checklist__assignee`) — **expanded**, not deleted. It becomes
  `{ display: grid; place-items: center; width: 24px; height: 24px; border-radius:
  var(--radius-pill); background: var(--ink-900); color: var(--paper-050); font: var(--type-label);
  font-size: 9px; letter-spacing: .02em; flex: none; }` — every property it computes today, in an
  order that preserves today's values.
- `SubtaskChecklist.tsx:130` — `className="subtask-checklist__assignee avatar"` becomes
  `className="subtask-checklist__assignee"`. One word; no visual change; the only out-of-scope
  file this release touches, and it is touched because §7.1's gate says a retirement may not be
  worked around.
- `app.css:791-792` — **deleted.** `.topbar__user`'s `margin-left: auto` is not moved: `.grow`
  already pushes the cluster right at every width. The child hiding moves onto the children
  themselves as `max-[1007px]:hidden` (identity, avatar) and `max-[771px]:hidden` (the two
  controls).
- `app.css:796` (`.topbar__menu-trigger { … }`) — **deleted**, migrated *in full* to
  `MENU_TRIGGER` below. Sol's round-1 review caught that the first draft claimed the trigger
  "already carries" its 44px minimum and `margin-left: auto` from JSX. It does not: `Topbar.tsx:229`
  passes the bare string `triggerClassName="topbar__menu-trigger"`, and **every** declaration —
  44px target, `ml-auto`, padding, typography, colour, border reset, cursor — comes from `:796`.
  Deleting it without migrating all of them would leave an unstyled, sub-touch-target trigger.
- Everything else in the 720 media block stays at 720: `.page` padding, `.topbar`'s 58px height and
  reduced padding, and the hiding of `.topnav` / `.search` / `.topbar__divider`. Those are phone
  decisions and are correct at 720.

At module scope in `Topbar.tsx`:

```tsx
// Migrated verbatim from app.css:75. No `avatar` class: the rule is gone and nothing queried it.
// The div carries `data-slot="avatar"` for §9.3's query. No `uppercase` either — `.avatar` never
// set `text-transform`; `initials()` already returns capitals.
const AVATAR = "max-[1007px]:hidden w-[32px] h-[32px] rounded-[var(--radius-pill)] " +
  "grid place-items-center bg-[var(--ink-900)] text-[var(--paper-050)] " +
  "[font:var(--weight-regular)_12px/1.2_var(--font-sans)] " +
  "tracking-[0.02em] flex-none";

const IDENTITY = "topbar__identity max-[1007px]:hidden";

// Migrated verbatim from app.css:796, which was the trigger's ONLY source of style. `hidden` and
// `max-[771px]:inline-flex` are different variant keys, so twMerge keeps both; `hidden` also
// beats menu.tsx's TRIGGER `inline-flex` in the shared base key. 44px touch target — WCAG 2.5.5
// Enhanced / HIG, not a spacing token.
const MENU_TRIGGER = "topbar__menu-trigger hidden max-[771px]:inline-flex items-center " +
  "justify-center min-h-[44px] ml-auto pt-[6px] pr-0 pb-[6px] pl-[10px] border-0 " +
  "bg-transparent text-[var(--text-primary)] " +
  "[font:var(--weight-regular)_11px/1.2_var(--font-sans)] " +
  "tracking-[var(--tracking-wide)] uppercase cursor-pointer";

// The two topbar controls leave `.button button--text` for the shared primitive (§5.4.2b (2)),
// which is what lets `max-[771px]:hidden` work without `!`.
const TOPBAR_CONTROL = buttonClasses("text", { className: "max-[771px]:hidden" });
```

`Topbar.tsx:217` becomes `<InternalLink className={cn(TOPBAR_CONTROL, activeView === "notifications" && "is-active")} …>`,
`:218` becomes `<div className={AVATAR} data-slot="avatar" aria-hidden="true">`, `:219`'s Sign out button takes
`className={TOPBAR_CONTROL}`, the identity `<div>` takes `IDENTITY`, and `:229`'s
`triggerClassName` becomes `MENU_TRIGGER`.

**Why the phone breakpoint stays at 720 while the controls switch at 771.** They answer different
questions. 720 is "is this a phone" — it governs type scale, padding, and whether primary nav is
worth the room. 771 is "does the cluster fit" — pure arithmetic. Tying them together is what
produced the defect being fixed here. The two are 51px apart, and that gap is the 721–770 band
above: desktop type scale and padding, desktop nav, controls already in the Menu. That is correct,
not a gap — the band is below the width at which the controls fit, and above the width at which the
page should switch to phone metrics.

**Observation, recorded and deliberately not fixed.** `Topbar.tsx:217` puts `is-active` on the
Notification preferences link, but no `app.css` rule matches `.button.is-active` or a bare
`.is-active` — only `.topnav a.is-active` and unrelated `.chip`/`.segment`/`.ctab` selectors. The
class is inert: the link has no active state today. §5.4.2c carries `is-active` through unchanged,
so behaviour is identical after this release. Designing an active state for it is a visual addition
outside this release's approved scope; filed as evidence for a future candidate.

#### 5.4.3 Measured values

**Measured 2026-09-03**, Agy over CDP against local dev at `http://localhost:8787`, signed in as
the seeded admin, via the §5.4.1 same-origin-iframe sweep. Method sanity check passed:
`.topbar__menu-trigger` computed `display: flex` at `W = 400`.

**`N` = 1007.** Branch taken: **`N ≤ 1024`** — the collapse breakpoint is `N` itself,
expressed as the complementary pair `max-[1007px]` (matches ≤1006, the mobile shell) /
`min-[1007px]` (matches ≥1007, the desktop cluster). Per lessons.md trap 2 these are exactly
complementary with no gap — do not "simplify" 1007 to 1006.

| Run | Identity | `.topbar__user` intrinsic | `N` |
|---|---|---|---|
| 1 | seeded display name | 523.46875px | 993 |
| 2 | `.topbar__identity strong` at its 180px cap | 537.671875px | **1007** |

`N = max(N1, N2) = 1007`.

Boundary rows, run 2 (the governing run) — `growW` is the criterion:

| W | growW | brandW / imgW | dividerW | navW | userW |
|---|---|---|---|---|---|
| 1005 | 0 | 73.531250 | 1 | 169.9375 | 536.531250 |
| 1006 | 0 | 73.648438 | 1 | 169.9375 | 537.414062 |
| **1007** | **0.703125** | **73.687500** | 1 | 169.9375 | 537.671875 |
| 1008 | 1.703125 | 73.687500 | 1 | 169.9375 | 537.671875 |

**Verified in closed form by this session, independently of the measurement.** The uncompressed
footprint is `2 × --space-7` padding + `4 × --space-6` gaps (five flex children) + brand + divider
+ topnav + user:

```
96 + 128 + (73.6875 + 1 + 169.9375) + 537.671875 = 1006.296875  →  N = 1007, slack 0.703125px
96 + 128 + (73.6875 + 1 + 169.9375) + 523.468750 =  992.093750  →  N =  993, slack 0.906250px
```

Both `N` values and both sub-pixel slack figures reproduce exactly, and `--space-6: 32px` /
`--space-7: 48px` were read from `styles/tokens/spacing.css:15-16`. The measurement is arithmetic,
not judgement.

**Two consequences worth stating.**

1. **`1007` is the worst case, so it is safe for every role.** The 180px cap is the widest name the
   CSS can render, and a non-admin has no `Admin` nav link, so `.topnav` is narrower and their true
   `N` is lower. A single breakpoint at the maximum is correct for all of them; a role-dependent
   breakpoint would be worse in every way.
2. **The margin at the 1024 evidence viewport is 17px** (`growW` ≈ 17.7px there). That is real
   slack, not overflow, and the brand is at full intrinsic width — but it is tight, so §10.2 item 5
   measures 1024 explicitly rather than assuming it from `N`.

### The mid-stage breakpoint `M`

**Measured 2026-09-03**, same method, with `.topbar__identity` and `.avatar` forced to
`display: none` inside the iframe — exactly the two elements the middle stage drops.

**`M` = 771.** Both name variants agreed exactly, as they must once `.topbar__identity` is out of
flow; the run confirmed rather than assumed it. `771 > 720`, so the mid stage does not collide
with the phone breakpoint. `growW` stayed positive and rose monotonically by 1px per viewport
pixel across the whole 771→1006 band, with zero violations.

| W | growW | brandW / imgW | dividerW | navW | userW |
|---|---|---|---|---|---|
| 769 | 0 | 73.429688 | 1 | 169.9375 | 300.632812 |
| 770 | 0 | 73.625000 | 1 | 169.9375 | 301.437500 |
| **771** | **0.703125** | **73.687500** | 1 | 169.9375 | 301.671875 |
| 772 | 1.703125 | 73.687500 | 1 | 169.9375 | 301.671875 |

Mid-stage `.topbar__user` intrinsic width, read at `W = 1200`: **301.671875px** —
bell 34 + "Notification preferences" 181.546875 + "Sign out" 62.125 + `2 × --space-3` gaps 24.

**Verified in closed form by this session:**

```
96 + 128 + (73.6875 + 1 + 169.9375) + 301.671875 = 770.296875  →  M = 771, slack 0.703125px
```

Both the total and the sub-pixel slack reproduce the measurement exactly.

**One thing this exposed, deliberately not acted on.** The "Notification preferences" link is
**181.5px — 60% of the entire mid-stage cluster**, and the single largest reason `N` is as high as
1007. Reducing it to an icon would pull both breakpoints down by roughly 150px. That is a change
to the desktop topbar every user sees at every width, it is a design decision rather than a defect
fix, and the owner considered and declined it when choosing the two-stage shape. Recorded here as
evidence for a future candidate, not as a deferral this release owes anyone.

**Not carried over from the first run:** an earlier sweep this session reported `N = 763` using
"no overflow" as the criterion. That number is wrong and is recorded here only so it is not
rediscovered — see §5.4.1's note on why compression makes absence-of-overflow the wrong signal.

### 5.5 `components/Topbar.tsx` — the bell's last two `app.css` rules (§12 Q4)

`app.css:69` (`.topbar__notifications { position: relative; }`), `app.css:73`
(`.topbar__notification-trigger svg { width: 19px; height: 19px; }`) and the now-stale §8.2
comment at `:70-72` are all deleted.

**The `:70-72` comment's stated reason is wrong, and that is part of why it goes.** It claims both
class names are kept because `ProjectCollaborationPanel.dom.test.tsx` queries them. That test
(`:478`) queries `.topbar__notification-trigger` only; `Topbar.dom.test.tsx` queries the same
trigger in eleven places. **`.topbar__notifications` has zero test queries and appears only in
`Topbar.tsx:161`.**

So the two names get different treatment:

- `.topbar__notification-trigger` **stays** — twelve real test queries depend on it (§7 row 21).
- `.topbar__notifications` **stays too, but as a deliberate structural hook, not a test hook** —
  it names the bell's positioning context for anyone reading the topbar's DOM, and renaming it to
  a bare `relative` would be a gratuitous diff in a release that is not otherwise touching the
  bell's structure. §7 row 20 records that rationale instead of the false one.

Two edits in `Topbar.tsx`:

```tsx
// was: <div className="topbar__notifications">
<div className="topbar__notifications relative">
```

```tsx
// was: triggerClassName={cn("topbar__notification-trigger", TRIGGER)}
// The 19px glyph is the bell's own size, one notch above the shell's default icon metric; it
// belongs to the trigger, not to a global descendant selector.
triggerClassName={cn("topbar__notification-trigger", TRIGGER, "[&_svg]:size-[19px]")}
```

`size-[19px]` sets both `width` and `height`, matching the deleted rule exactly. `TRIGGER` sets no
`svg` size of its own, so there is nothing for `twMerge` to resolve here.

After this, **`app.css` holds zero styling rules for the notification bell** — the surface
candidate #5 is named after is finished, not partially finished.

---

## 6. Implementation shape

### 6.1 Touched-file list — complete

| # | File | Change |
|---|---|---|
| 1 | `src/screens/NotificationPreferences.tsx` | Rewritten render per §5.1; logic preserved |
| 2 | `src/screens/NotificationPreferences.dom.test.tsx` | Updated + extended per §9.1 |
| 3 | `src/components/ImpersonationBanner.tsx` | Converged per §5.2 |
| 4 | `src/components/ImpersonationBanner.dom.test.tsx` | Extended per §9.2 |
| 5 | `src/components/Topbar.tsx` | §5.3 brand, §5.4 collapse + defect B4, §5.5 bell rules |
| 6 | `src/components/Topbar.dom.test.tsx` | Extended per §9.3 |
| 7 | `src/styles/app.css` | §7 retirement ledger |
| 8 | `docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md` | `TB0-VIS-05` and `TB0-VIS-06` rows, §11 artefacts 8 and 8b |
| 9 | `docs/todo.md`, `docs/lessons.md` | §13 |

No other file is touched. No file is added. No dependency is added.

### 6.2 Deliberately not touched

`components/ui/*` (every primitive is reused as-is — in particular `input.tsx`'s
`[&:read-only:not(select)]:` guard), `screens/Admin.tsx`, `Topbar.tsx`'s notification menu block
(lines 24-68 and 161-214, apart from the two one-line class-string edits §5.5 names), `app.css`'s `.notice` and `.button--text`, and every `.app--impersonating`
offset rule (they depend on the banner's 42px height, which §5.2 preserves exactly).

### 6.3 Order of work — one slice

At roughly 700 lines this plan is well under the 1,500-line slicing threshold in
`Subagent-Frontend-Orchestration.md`, so it goes to a single builder. Within the slice, bottom-up:

1. `app.css` retirements (§7) — do these **first**, so any Tailwind utility that was silently
   losing to an unlayered rule fails visibly rather than appearing to work. **Ordering constraint
   inside this step:** row 18c (expand `.subtask-checklist__assignee`) and the
   `SubtaskChecklist.tsx:130` class removal land *before* row 18b (delete `.avatar`). Reversing
   them ships an unstyled assignee chip.
2. `ImpersonationBanner.tsx` (§5.2) — smallest, and independently verifiable.
3. `Topbar.tsx` brand (§5.3), then collapse (§5.4), then the bell rules (§5.5).
4. `NotificationPreferences.tsx` (§5.1).
5. Tests (§9).
6. The gate (§10.1).

---

## 7. Legacy CSS retirement ledger

Legend per §2.2: **D** delete · **R** retain as hook, rule deleted · **K** keep · **!** important.

| # | Selector | Line | Last consumer after this release | Disposition |
|---|---|---|---|---|
| 1 | `.impersonation-banner` | `app.css:35` | none (moved to §5.2 `BANNER`) | **R** — class stays; `ImpersonationBanner.dom.test.tsx:56` queries it |
| 2 | `.impersonation-banner__identity` | `:36` | none | **R** |
| 3 | `.impersonation-banner .button--text` | `:37` | none — the component leaves `.button--text` | **D** — this rule *is* defect B1 |
| 4 | `.impersonation-banner__error` | `:38` | none | **R** |
| 5 | `.notice` | `:880` | `ProjectActivityView.tsx:53`, `ProjectDeadlineControl.tsx:279`, `ProjectDiscussionThread.tsx:206` and `:207`, `ProductionCalendar.tsx:1558` | **K** — five out-of-scope consumers; the prefs screen moves to `<Notice>` and the rule stays |
| 6 | `.button--text`, `.button--text:hover:not(:disabled)` | `:876-877` | **seven occurrences, four files** — `ProjectActivityView.tsx:53`, `ProductionCalendarEvent.tsx:105`, `:122`, `:142`, `ProductionCalendarFilters.tsx:97`, `ProductionCalendarUnscheduledPanel.tsx:131`, `:177` | **K** — of eleven occurrences today this release removes **four** (`ImpersonationBanner.tsx:38`, `Topbar.tsx:145`, `:217`, `:219`) and fixes the defect its hover rule caused; retirement belongs to candidate #10 |
| 7 | `.topbar__brand` | `:55` | none (moved to §5.3 `BRAND`) | **R** — `.topbar__brand` stays as a hook |
| 8 | `.topbar__brand img` | `:56` | none | **D** — folded into `[&_img]:h-[18px]` |
| 9 | `.preferences-card` | `:258` | none | **D** |
| 10 | `.preferences-card h2` | `:259` | none | **D** |
| 11 | `.preferences-card p` | `:260` | none | **D** |
| 12 | `.admin-toggle` | `:929` | none — its other consumer went in TB8-04 | **D** |
| 13 | `.preferences-page` | — (no rule) | JSX only | **D** — removed from the JSX; zero rules, zero test queries |
| 14 | `.page__head` | — (no rule) | JSX only | **D** — removed from the JSX |
| 15 | `.lede` | — (no rule) | JSX only | **D** — removed from the JSX |
| 16 | `.topbar__user` (`:923`, base) | `:923` | `Topbar.tsx:160` | **K** — the base flex rule is correct at every width; only the §5.4 responsive half moves |
| 17 | `@media (max-width:720px)` `.topbar__user` + child hiding | `:791-792` | none after §5.4 | **D** — `margin-left:auto` deleted outright (redundant with `.grow`); identity/avatar hiding → `max-[1007px]:hidden` on the children; `> .button` hiding → `max-[771px]:hidden` on `TOPBAR_CONTROL` |
| 18 | `@media (max-width:720px)` `.topbar__menu-trigger` | **`:796`** | none after §5.4 | **D** — migrated **in full** to §5.4.2c's `MENU_TRIGGER`: `min-h-[44px]`, `ml-auto`, `items-center justify-center`, `pt-[6px] pr-0 pb-[6px] pl-[10px]`, `border-0`, `bg-transparent`, `text-[var(--text-primary)]`, the 11px uppercase label shorthand, `tracking-[var(--tracking-wide)]`, `cursor-pointer`, plus `hidden max-[771px]:inline-flex`. This rule was the trigger's **only** source of style (`Topbar.tsx:229` passed a bare class string), so nothing here is optional |
| 18a | `.topbar__menu-trigger, .topbar__mobile-menu { display: none; }` | `:67` | none after §5.4 | **D** — both halves. The `.topbar__mobile-menu` half **is defect B4** (§5.4.2a): it hides the mobile menu panel at every width, in production, today. The `.topbar__menu-trigger` half is superseded by `MENU_TRIGGER`'s own `hidden`. Both class names survive in the JSX; `.topbar__mobile-menu` is queried by `Topbar.dom.test.tsx:57, 344, 345` and `ProjectCollaborationPanel.dom.test.tsx:474, 476`, and `.topbar__menu-trigger` by `ProjectCollaborationPanel.dom.test.tsx:472` |
| 18b | `.avatar` | `:75` | none — **two** consumers today (`Topbar.tsx:218`, `SubtaskChecklist.tsx:130`), both leaving the class | **D** — **zero** test queries, so no hook is kept; the Topbar div takes `data-slot="avatar"` instead. Sol's round-2 review corrected the first draft's "single consumer" claim: `SubtaskChecklist` relies on `:75` for radius, background, colour, font, tracking and `flex`, so `:75` may not be deleted until row 18c lands (§5.4.2b (1)). Retiring it is what lets `max-[1007px]:hidden` work without `!` |
| 18c | `.subtask-checklist__assignee` | `:1016` | `SubtaskChecklist.tsx:130` | **K — expanded, the one rule this release modifies.** Absorbs row 18b's six shared declarations verbatim, `font: var(--type-label)` placed before its own `font-size: 9px`. Out-of-scope component, zero intended visual change; proved by §10.2 item 17 |
| 19 | `.topbar__mobile-identity` | `:801` | `Topbar.tsx:229` | **K** — mobile-menu internals, out of scope |
| 20 | `.topbar__notifications` | `:69` | none (moved to `relative` in §5.5) | **R** — class stays as a *structural* hook. It has **zero** test queries (§5.5 corrects the `:70-72` comment, which claimed otherwise); it is retained to keep the bell's positioning context named, not because a test needs it |
| 21 | `.topbar__notification-trigger svg` | `:73` | none | **D** — folded into `[&_svg]:size-[19px]`; the stale, factually wrong `:70-72` comment goes with it. The *class* `.topbar__notification-trigger` is **K**: `Topbar.dom.test.tsx` queries it at `:67, 102, 107, 120, 124, 134, 158, 175, 212, 237, 254, 320` and `ProjectCollaborationPanel.dom.test.tsx:478` once |

**Tally: D 14 · R 5 · K 5 · ! 0** — D rows 3, 8-15, 17, 18, 18a, 18b, 21; R rows 1, 2, 4, 7, 20;
K rows 5, 6, 16, 18c, 19. Net `app.css` change: **17 rules removed, 1 modified (row 18c), 0
added** —
`:35` `:36` `:37` `:38` (banner ×4), `:55` `:56` (brand ×2), `:67` (the shared `display:none`),
`:75` (`.avatar`), `:69` `:73` (bell ×2), `:258` `:259` `:260` (`.preferences-card` ×3),
`:929` (`.admin-toggle`) — that is 14 — plus, inside the `@media (max-width:720px)` block, the
whole of `:791`, `:792` and `:796`, for 17. Rows 13-15 are JSX-only and remove no rule; row 18c
removes none either. Also deleted: two now-stale comments (`:70-72`, and `:797-799`'s claim about
`.topbar__mobile-menu`, which §5.4.2a shows was describing a migration that never completed).

**`! 0` is a real zero, not an oversight.** Sol's round-1 review correctly found that the first
draft's plain display utilities would all lose to unlayered `app.css`. The answer taken here is
rows 18a and 18b plus the `buttonClasses` convergence in §5.4.2b — retire the three conflicting
rules rather than out-shout them. Every remaining `!` in this plan (§5.1, §5.2) is on a *colour*,
where the unlayered owner is a global token rule that is not this release's to retire — **except**
`!max-w-[var(--container-md)]` (§5.1, over `.page`'s geometry) and `disabled:!cursor-wait` (§5.1,
over `CHECKBOX_INPUT`'s own cursor). Sol's round-2 review caught that overstatement. The claim that
holds without qualification is the narrower and more load-bearing one: **the responsive collapse
uses no `!` on any display utility.**

### 7.1 The retirement gate

Before deleting any rule marked **D** or **R**, the builder runs, from `portal/apps/web/src`, for
each class name in that row:

```
grep -rn "<class-name>" --include='*.tsx' --include='*.ts' --include='*.css' .
```

and confirms every remaining hit is either (a) the JSX hook this plan keeps, (b) a test query this
plan keeps, or (c) a row marked **K**. A hit that is none of those blocks the deletion and is
reported rather than worked around.

---

## 8. Behavioural invariants — what must not change

1. **The banner is exactly 42px tall.** Five `app.css` rules (`:39-43`), plus `:823` and
   `:1074-1075`, offset the topbar, rail, worktools, viewer and collaboration wrap by 42px (and
   the derived 106px / 100px) under `.app--impersonating`. §5.2's `h-[42px]` preserves it.
   Verified by measurement, §10.2 item 7.
2. **`z-index: 76` on the banner, `75` on the topbar.** The banner must paint above the sticky
   topbar. `z-[76]` preserves it.
3. **The preferences API contract.** `GET`/`PATCH /api/notification-preferences` with
   `{ projectDeadlineReminderEmails: boolean }`, the optimistic update, and the rollback to the
   previous value on `ApiError` are unchanged.
4. **The `sr-only` live region** stays `aria-live="polite"` and keeps its exact text
   (`"Saving notification preferences"` while saving, `""` otherwise). Guarded by §9.1 test 5.
5. **The checkbox stays a real `<input type="checkbox">`** — the dom test queries
   `input[type="checkbox"]` and clicks it. No custom switch, no `role="switch"`.
6. **Every item hidden from the topbar by §5.4 remains reachable in the mobile `Menu`.** This is
   the whole justification for the fix; a build that hides an item without a menu route for it is
   wrong.
7. **`aria-label="Quincy Portal home"`** stays on the brand link.
8. **The impersonation banner's `data-invalidated`, `role="alert"` and `title`** survive.
9. **The `active` cleanup flag around the deferred initial `GET`** survives the rewrite — a
   resolution arriving after unmount must not set state. Guarded by §9.1 test 6's **source-level**
   assertion — under React 19.2.8 the runtime half of that test cannot detect the flag's removal.

10. **`SubtaskChecklist`'s assignee chip is visually unchanged.** It is out of scope and is touched
    only because `.avatar` cannot be retired otherwise (§5.4.2b (1), §7 rows 18b/18c). Every
    computed property it has today it must still have. Guarded by §10.2 item 17.

---

## 9. Tests

### 9.1 `NotificationPreferences.dom.test.tsx`

Two existing assertions change because the copy they assert changed (§4.4), and they are updated,
not loosened:

- `expect(host.textContent).toContain("Project deadline reminder emails")` →
  `expect(host.querySelector("h2")!.textContent).toBe("Project deadlines")`.

  **Scoped to the heading on purpose.** §5.1.2 renders the heading as `Project deadlines`, and the
  checkbox keeps `aria-label="Project deadline reminder emails"` (§8.4) — so an unscoped
  `toContain("Project deadline reminders")` would fail (no node has that text) and an unscoped
  `toContain("Project deadlines")` would pass on the `aria-label` alone even if the heading were
  deleted. Neither is a real guard.
- `expect(host.textContent).toContain("In-app Deadline reminders are always delivered.")` →
  two assertions: `toContain("Always on")` and
  `toContain("In-app reminders always arrive in your notification bell.")`.

Everything else in the existing file — the `apiGet` path assertion, the optimistic-rollback test,
the `apiPatch` body assertion — is unchanged and must still pass.

**But three §8 invariants are not actually covered by that file today, and this plan does not get
to claim them as protected without saying so.** The gap, stated precisely:

- The existing rollback test (`NotificationPreferences.dom.test.tsx:41`) rejects the PATCH
  immediately and asserts only the restored value (`expect(checkbox.checked).toBe(true)`). It
  proves the *rollback*; it never observes the *optimistic* state, because the promise is already
  settled. A rewrite that dropped the optimistic update entirely and only wrote on success would
  still pass it.
- Nothing asserts the live region's `aria-live="polite"` value or its exact text.
- Nothing exercises the `active` cleanup flag around the deferred GET.

Six tests are added — the four the design needs, plus two closing that gap:

1. **Accessible name.** The checkbox's `aria-label` is `"Project deadline reminder emails"`, and
   it is that in the loading state too (fixes E-7, which the old markup could not express).
2. **Saving state, and the optimistic value with it.** With an `apiPatch` promise held open (a
   deferred, resolved by the test — not an already-settled one), assert *in flight*: the checkbox
   is `disabled`, the value slot reads exactly `Saving…`, **and `checkbox.checked` is already the
   new value** — that last assertion is what the existing rollback test cannot make. After the
   deferred resolves, the slot reads `Off`.
3. **The error renders inside the card.** After a failed save,
   `host.querySelector('[data-slot="notice"]')` is non-null and its `closest("section")` is the
   card — not a sibling of `<main>` (fixes E-6). This asserts the behaviour, not a class name.
4. **The row label is clickable.** Clicking the `<label>`'s eyebrow text toggles the checkbox —
   i.e. the `aria-label` override did not break the wrapping label's activation behaviour, which
   is the one real risk of §5.1.2's naming decision.
5. **The live region is polite and says exactly one thing.** The region's `aria-live` attribute is
   `"polite"`; its `textContent` is `""` at rest and exactly
   `"Saving notification preferences"` while the deferred PATCH is in flight. Asserted on the
   element, not on `host.textContent`, so a stray copy of the string elsewhere cannot satisfy it.
6. **The deferred GET does not write after unmount.** With the initial `apiGet` held open, unmount
   the screen, then resolve it; no error is thrown. **This is a smoke test, not a guard**, and the
   draft's claim that it "passes only if the `active` flag survives" was wrong: Sol's round-2
   review established that the repo runs **React 19.2.8** (`portal/package.json:43`), which
   *silently ignores* a post-unmount state update rather than emitting the React 17/18
   `console.error` the assertion was built on. Deleting every `if (active)` would still pass it.

   So the actual guard for invariant 9 is a **source-level** assertion in the same file, in the
   same form as §9.3 test 4: read `screens/NotificationPreferences.tsx` from disk and assert its
   effect body still contains a cleanup return and an `active` check. Ugly, and correct for the
   reason §9.3 gives — happy-dom plus React 19 leave no observable behavioural difference to assert
   on. The runtime half is kept as the smoke test it honestly is.

   **Second correction, from Sol's diff review (2026-09-03).** The paragraph above was still not
   enough, and the built test inherited its gap: asserting `let active = true;` and the cleanup
   return does **not** assert the guard, because deleting all three `if (active)` checks leaves
   both of those intact. The flag and its cleanup are the *scaffolding*; the three guarded
   continuations are the thing invariant 9 actually depends on. The test asserts each of them by
   name — `if (active) setEnabled(...)`, `if (active) setError(`, `if (active) setLoading(false)` —
   plus `toHaveLength(3)` on the guard count, and was proved able to fail by stripping the guards
   from the real source (1 failed / 7 passed) and passing again once restored. Three rounds of
   review on one test is the honest cost of a source-level assertion: each round asserted the
   nearest visible token rather than the behaviour, which is the failure mode this note exists to
   record.

### 9.2 `ImpersonationBanner.dom.test.tsx`

The existing test (`alert.parentElement` is `.impersonation-banner`) must still pass — that is why
row 1 of §7 is **R**, not **D**.

One test added: the Exit button carries no `button--text` class, and its class list contains
`hover:not-disabled:!text-on-inverse`. This is a DOM-level guard against a future "cleanup" putting
the legacy class back; the *painted* contrast is verified in the browser (§10.2 item 6), because a
happy-dom test cannot compute it.

### 9.3 `Topbar.dom.test.tsx`

The existing bell tests are unchanged and must still pass. Four added:

1. The brand link's class list contains `max-[721px]:min-h-[44px]` and does **not** contain
   `button--text`.
2. `.topbar__identity` and `[data-slot="avatar"]` carry `max-[1007px]:hidden`, and neither
   carries the retired `avatar` class; the prefs link and Sign out
   carry `max-[771px]:hidden` and **not** `button--text`; `.topbar__menu-trigger` carries both
   `hidden` and `max-[771px]:inline-flex`, plus `min-h-[44px]` and `ml-auto`. So a later edit
   cannot silently collapse the stages back into one, move a breakpoint back to 720, or repeat
   TB8-02's mistake of deleting a migrated declaration without noticing (§5.4.2c).
3. The notification trigger's class list contains `[&_svg]:size-[19px]` and the notifications
   wrapper contains `relative` (§5.5) — the two rules `app.css` no longer supplies.
4. **Defect B4's regression guard.** `.topbar__mobile-menu`'s class list contains **no** `hidden`
   and no `display`-setting utility, and — the part that actually bites — a source-level assertion
   that `styles/app.css` contains no rule matching `.topbar__mobile-menu`. Implemented by reading
   the stylesheet from disk in the test and asserting the regex finds nothing, because that is the
   only form of this check happy-dom can make true (see below).

**These are structural guards, not behaviour proofs.** Whether the collapse actually removes the
overflow is a browser measurement (§10.2 items 3-5); happy-dom does no layout.

**And that limit is exactly how defect B4 survived TB8-02 undetected.** `Topbar.dom.test.tsx:57`
and `:344-345` assert the mobile menu's links are *in the DOM*; `ProjectCollaborationPanel.dom.test.tsx:474`
asserts the panel is. All four passed for the entire period the panel was invisible, because
happy-dom applies no stylesheet and computes no layout. **No dom test added by this release may be
described as proving anything about visibility.** Test 4 above is deliberately a *source* assertion
rather than a computed-style one, for that reason. Painted visibility is proved only in §10.2
item 15.

---

## 10. Verification and acceptance

### 10.1 The §5 gate — run from `portal/`

```
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

All four green. The fourth is **not** covered by `--workspaces` (`packages/shared` has a vitest
config but no `test` script) and is not optional. Baseline to beat: **1569 passing across the
workspaces + 144 in `packages/shared`, 0 failures** — this release adds **11** tests (6 in
`NotificationPreferences.dom.test.tsx` §9.1, 1 in `ImpersonationBanner.dom.test.tsx` §9.2, 4 in
`Topbar.dom.test.tsx` §9.3), so the expected
result is 1580 + 144.

Plus a grep gate, run from `portal/apps/web/src`, each of which must return **zero** lines:

```
grep -rn "preferences-card\|admin-toggle\|preferences-page\|page__head" --include='*.tsx' --include='*.css' .
CSS() { perl -0pe 's{/\*.*?\*/}{}gs' styles/app.css; }
CSS | grep -n "impersonation-banner .button--text"
grep -rnE '"[^"]*button--text' components/ImpersonationBanner.tsx components/Topbar.tsx | grep -v "sign-out\|topbar__user"
grep -rn "max-\[720px\]\|min-\[720px\]" --include='*.tsx' .
CSS | grep -n "topbar__notification"
CSS | grep -n "topbar__mobile-menu"
CSS | grep -n "\.avatar[ ,{:]"
```

**Correction, applied after the build (2026-09-03).** The first draft of gates 3 and 5 matched a
class name *anywhere in the file, comments included*, and both therefore could not return zero
against the very content this plan mandates: §5.4.2b's explanatory comments at `Topbar.tsx:71`
and `:99` name `.button--text` in backticks to record why the class is gone, and `app.css:770`
keeps a comment explaining that the bell menu's position is Base UI's Positioner. Those comments
are correct and worth keeping; the gates were wrong. Gates 2, 5, 6 and 7 now strip CSS comments
before matching, so they test **selectors**, and gate 3 requires the class inside a double-quoted
string, so it tests a `className`. All five were re-proved able to fail against planted probes
(`className="button--text"`; `.topbar__notification-menu {}`; `.topbar__mobile-menu {}`;
`.avatar {}`; `.impersonation-banner .button--text {}`) — each is caught. This is the second
release running where a gate shipped that could not fail (TB8-04 round 1 shipped two); the
"prove it can fail" step in the paragraph below exists precisely because writing the gate is
easier than writing a gate that discriminates.

The fifth is §12 Q4's gate: `app.css` must hold no bell selector at all after this release. **The
sixth is defect B4's** (§5.4.2a): `app.css` must hold no rule targeting the mobile menu panel — the
single line whose presence made the phone navigation invisible for the whole of TB8-02's life.
**The seventh is row 18b's**, and it may only be run *after* row 18c has landed — deleting
`.avatar` before `.subtask-checklist__assignee` absorbs it is exactly the failure mode Sol found.
The
fourth catches lessons.md trap 2 — the off-by-one is the fix, and `720` in a Tailwind
arbitrary variant is always wrong in this repo. Each of the seven gates must additionally be proved **able to
fail** against a throwaway probe carrying the violation it exists to catch, per TB8-04's precedent
(round 1 there shipped two gates that could not fail).

### 10.2 Real-browser acceptance — 1440×900, 1024×768, 390×844

Local dev, signed in as Admin. Items 6 and 7 need an active impersonation session, which is a
local-dev mutation against the disposable QA account — permitted (`CLAUDE.md`, Agy YOLO-mode
scope), never against production.

| # | Item | How it is proved |
|---|---|---|
| 1 | The `<h1>` computes to 48px in `--font-display`, not the 32px browser default | `getComputedStyle(h1).fontSize` at all three viewports (fixes E-2) |
| 2 | The lede computes to 14px `--greige-600`, measure ≤46ch | computed style + `getBoundingClientRect().width` |
| 3 | No horizontal overflow on the preferences page at any of the three viewports | `documentElement.scrollWidth <= clientWidth` in the iframe |
| 4 | The topbar does not overflow at **any** integer width from 390 to 1440 | the §5.4.1 sweep, re-run against the built branch; every width false (fixes E-13) |
| 5 | **All three boundaries are exact, and the four bands of §5.4.2 are the four that occur.** At 1007 the identity block and avatar are visible; at 1006 neither is and the two controls still are. At 771 the controls are visible and the Menu trigger is not; at 770 the reverse. At 721 vs 720 the phone metrics flip (`.topbar` height 64→58) while the control/Menu state does **not** change. Recorded as a visibility matrix over `{brand, topnav, bell, identity, avatar, prefs, signout, menu-trigger}` × `{1440, 1008, 1007, 1006, 900, 772, 771, 770, 750, 721, 720, 390}` | computed `display` and `getBoundingClientRect()` per element per width, in the iframe (lessons.md trap 2's method) |
| 5d | **The bell is visible at every one of those twelve widths** — it is in all four bands by design (§5.4.2) | same matrix, `.topbar__notifications` row |
| 5b | Nothing is compressed anywhere in 390–1440: `.grow` is ≥0 at every width and `.topbar__brand img` is at its 73.6875px intrinsic width at every width ≥771 | the §5.4.1 sweep re-run against the built branch — this is the check that would have caught the 763 error |
| 5c | The 1024 evidence viewport shows the **full** cluster (1024 ≥ 1007) with ~17px of slack | `growW` at exactly 1024 |
| 6 | The Exit button's painted label clears 4.5:1 against the banner in **both** rest and hover | canvas composite of the computed colours, not an `rgba()` regex — `bg-surface-inverse` resolves through nested `var()` and `hover:` needs the state forced (fixes E-11) |
| 7 | The banner is exactly 42px and the topbar's `top` is 42px while impersonating | `getBoundingClientRect().height` and `getComputedStyle(topbar).top` (invariant 8.1) |
| 8 | The Exit button's focus ring is visible on ink | `:focus-visible` forced, `outline-color` composited (fixes E-12) |
| 9 | The brand link is ≥44px tall at 390px and ≥32px at 1440px | `getBoundingClientRect().height` in the iframe at both (fixes E-14) |
| 10 | The email row is ≥44px at 390px, ≥38px at 1440px | same |
| 11 | The ledger stacks to one column at 390px and is two-column at 1440px | `getComputedStyle(row).gridTemplateColumns` |
| 12 | `Saving…` is visible during a real save | throttle the PATCH in devtools, screenshot |
| 13 | The error `Notice` renders inside the card | force a failing PATCH, read `closest("section")` |
| 14 | **Defect B4 is fixed: the mobile menu panel actually paints.** At 390, 720 and 770, clicking `.topbar__menu-trigger` gives a `.topbar__mobile-menu` with computed `display` ≠ `none`, a non-zero `getBoundingClientRect()`, `checkVisibility({checkOpacity:true, checkVisibilityCSS:true}) === true`, and all four of its links/buttons with non-zero boxes. Compared against the pre-fix baseline in §5.4.2a's table (`display: none`, 0 × 0, `false`, all four 0 × 0) | the §5.4.2a measurement re-run against the built branch, same iframe method |
| 15 | Each of the four mobile-menu items **navigates**: Dashboard, Admin, Notification preferences route correctly and Sign out is clickable (not activated) | click through in the iframe at 390 |
| 16 | **The subtask assignee chip is byte-identical to `main`** (invariant 10). At 1440, on a project with an assigned subtask, `getComputedStyle` on `.subtask-checklist__assignee` returns the same `borderRadius`, `backgroundColor`, `color`, `font`, `letterSpacing`, `flex`, `width`, `height` and `fontSize` as the same measurement taken against `main` before the branch — the proof that row 18c copied `.avatar` faithfully | side-by-side computed-style capture, `main` vs branch |
| 17 | Zero console errors and zero failed requests across the walk | console + network panel |

All measurement is done through a **same-origin iframe** sized to the target viewport — the
emulated viewport here is pinned at 2560 CSS px and window resizing does not move it (lessons.md,
"The method, which generalises").

### 10.3 Known limits, declared in advance

Whether a screen reader *announces* the checkbox as "Project deadline reminder emails" is
verifiable only with assistive technology this session cannot drive. Items 1-17 verify the
accessible name **structurally** (the computed `aria-label`, and the accname precedence rule that
`aria-label` outranks a wrapping `<label>`). Recorded as a known limit on the TB5C/TB8-04
precedent, **not** claimed as a pass.

---

## 11. Artefacts

1. `screens/NotificationPreferences.tsx` — rewritten
2. `screens/NotificationPreferences.dom.test.tsx` — 2 updated, 6 added (§9.1)
3. `components/ImpersonationBanner.tsx` — converged
4. `components/ImpersonationBanner.dom.test.tsx` — 1 added
5. `components/Topbar.tsx` — brand + collapse + defect B4
6. `components/Topbar.dom.test.tsx` — 4 added (§9.3)
7. `styles/app.css` — 17 rules deleted, 1 rule expanded (`:1016`), 0 added (§7 tally)
7b. `components/SubtaskChecklist.tsx` — one class word removed (§5.4.2c); no test change
8. `docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md` — one appended row:

   > `TB0-VIS-05` · Notification preferences screen and three app-shell defects · The preferences
   > screen rendered its head through `.page__head`/`.lede`, which carry no CSS, so its `<h1>` sat
   > at the browser-default 32px instead of `--type-h1`'s 48px; its only control was a 38px touch
   > target on a phone; its error rendered outside the card; and its mandatory in-app channel was
   > prose rather than a state. Three shell defects were fixed alongside: the impersonation
   > banner's Exit button was Ink-on-Ink (1:1) on hover because
   > `.button--text:hover:not(:disabled)` (0,3,0) outranked the scoped
   > `.impersonation-banner .button--text` (0,2,0); `.topbar__user` overflowed above 720px because
   > the desktop-to-mobile collapse was hard-coded at a phone width; and `.topbar__brand` was a
   > 32px touch target below 721px. Resolved by TB8-05.

8b. `docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md` — a second appended row:

   > `TB0-VIS-06` · Mobile navigation menu invisible since TB8-02 · `app.css:67`'s unlayered
   > `.topbar__menu-trigger, .topbar__mobile-menu { display: none; }` applied to the mobile menu's
   > **panel** at every width. TB8-02 (`c5e246f`) moved the panel's position and paint onto the
   > shared `Menu` primitive and deleted the `@media (max-width:720px)` rule that had supplied its
   > `display: grid`, but `menu.tsx`'s `PANEL` declares no `display`, so the unlayered `:67` rule
   > won and the panel computed to `display: none` — 0 × 0, `checkVisibility() === false`, all four
   > of its links unreachable. At any width ≤720px the app had no navigation, no Notification
   > preferences link and no Sign out. Undetected because the three dom tests covering the panel
   > assert DOM presence only, and happy-dom applies no stylesheet. Found during TB8-05's Sol
   > round-1 review, confirmed by browser measurement, resolved by TB8-05.

9. Evidence images at 1440×900, 1024×768 and 390×844 for: the preferences screen (default, saving,
   error, loading), the banner (rest, hover, focus), the topbar at each of the three boundaries
   (`1008/1007/1006`, `772/771/770`, `721/720`), and the mobile menu **open and painted** at 390 —
   the direct before/after for §5.4.2a's screenshot.

---

## 12. Owner decisions

### 12.0 Q5 — defect B4 — resolved 2026-09-03

**Owner decision: fold it in, as this plan is written.** Defect B4 (§1.3a, §5.4.2a) ships as part
of TB8-05 rather than as a separate hotfix ahead of it: one deleted line (`app.css:67`, §7 row
18a), one dom-test guard (§9.3 test 4), one grep gate (§10.1's sixth), one browser acceptance item
(§10.2 item 15), one `TB0-VIS-06` register row (§11 artefact 8b).

**Consequence, stated plainly and accepted:** the phone navigation stays broken in production until
TB8-05 deploys, rather than being restored today. The release is one slice (§6.3), so that window
is this release's build-and-verify time, not an open-ended one.

**No further owner questions are open. This plan is cleared to proceed to Sol round 2.**

### 12.1-12.4 Resolved 2026-09-03

All four are closed. Nothing in this plan is open.

**Q1 — the collapse breakpoint is a visible shell change. → Approved, fix it.** Between 721px and
`N` the topbar drops the identity block, avatar, "Notification preferences" link and "Sign out"
button in favour of the Menu trigger. Every one of those is in the Menu, and that band overflows
today. Recorded in §5.4.2.

**Q2 — the card heading. → Refactored, not renamed.** The draft's `Project deadline reminders`
still carried the original string's flaw: it named a channel-flavoured *thing* in a slot that
should name a *category*. The heading is now **`Project deadlines`** — the card's ledger rows own
the channels (`In-app`, `Email`), so the heading owns the category. That is what makes the shape
reusable: a second notification category (mentions, stage changes, delivery failures) becomes a
second card of exactly this shape, with no string in the first card rewritten and no new primitive.
The `<section aria-labelledby>` target is unchanged, so the accessible name of the card follows the
heading automatically. Recorded in §4.4 and §5.1.2.

*Not done, deliberately:* the API key stays `projectDeadlineReminderEmails`. Renaming it is a
server + D1 + shared-package change with a migration, which is outside this release's authority
(§Authority boundary) and outside a visual convergence release generally. The UI reads as a
category-plus-channels ledger while the wire format stays exactly as it is.

**Q3 — the footnote. → Approved.** `In-app Deadline reminders are always delivered.` becomes
`In-app reminders always arrive in your notification bell.` Recorded in §4.4.

**Q4 — the two `app.css` bell rules (`:69`, `:73`). → Folded into this release.** See §5.5 and §7
rows 20–21. `app.css` ends this release with zero bell styling rules, and §10.1 gains a fifth grep
gate that proves it.

---

## 13. Docs to update on completion

- `docs/todo.md` — the line-10 deploy header and a TB8-05 prose bullet, in the established form
  (merge commit, app Worker version, "no migration", rollback target).
- `docs/lessons.md` — only if the build surfaces a new mechanism. The specificity arithmetic
  behind defect B1 (`:not()` contributes its argument's specificity, so
  `.button--text:hover:not(:disabled)` is (0,3,0)) is worth a short entry either way, because the
  naive scoped-override fix looks correct and is not.
- This file — status line, then `git mv` to `docs/plans/implemented/`.
