# TB8-08 — Staff Notice Board: Visual Plan

**Status: BUILT, VISUAL GATE PASSED, not yet merged or deployed.** Slices `0a36964`, `3504e30`,
`72c2325`. Gate results in §0a.

**Prior status: REVIEWED (both Sol rounds).** Sol returned 10 findings in
round 1 (7 blocking) and 5 in round 2 (3 blocking). **All 15 were independently verified against the
repo and all 15 were upheld** — see §0. The ≤2-round cap is now spent. Ranking candidate **#8** in
`Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md` ("Notice board"). Branch
`tb8-08-notice-board`, to be cut from `main` at `c025fbb` (TB8-07 shipped).

Pipeline: `docs/Subagent-Frontend-Orchestration.md` — this session drafts the plan, Sol reviews
scope and correctness (≤2 rounds), a Sonnet subagent builds it in slices, this session holds the
final visual gate. Matched-evidence viewports stay TB1's: `1440×900`, `1024×768`, `390×844`.

---

## 0. What the two Sol rounds changed, and what I got wrong

Ten findings, seven blocking. I verified each against the repo before acting. **All ten held.**
Four of them were the draft being outright wrong, not merely thin:

| # | Finding | Verified how | Outcome |
|---|---|---|---|
| 1 | `buttonClasses("text")` **cannot** reach 44×44 — no `min-width` exists in it at all, and its `min-h-[32px]` beats BASE's `min-h-[38px]` | Ran the real `cn()` (`twMerge(clsx(…))`) and printed the resolved string | **Upheld.** §2.1's fix and criterion 1 were unachievable as written. Rewritten. |
| 4 | A plain `text-destructive` on the text variant does nothing — the variant's `!text-foreground-secondary` outranks it | Same probe: both classes survive twMerge; the `!` one wins in CSS | **Upheld.** Now prescribes `!text-destructive`. |
| 5 | Bare `META_TEXT` would uppercase the composer hint; the precedent uses `cn(META_TEXT, "!normal-case")` | `ProjectDiscussionThread.tsx` — exactly one such call site | **Upheld.** This is TB8-07's gate defect #3 and I was about to re-ship it. |
| 3 | The plan is not at implementation-detail resolution, which the pipeline requires | `Subagent-Frontend-Orchestration.md:17-22`: "exact Tailwind classes/tokens, spacing scale, every component state … **Done when:** the plan closes every design decision itself rather than deferring it to the builder's judgment" | **Upheld, and it is the main revision.** §5 is new: an exact class specification for every element and state. |
| 7 | The per-file test split in my §6 table was fabricated; and `querySelector` cannot select by accessible name, so my advice was not actionable | Recounted per class per file | **Upheld.** Table corrected, `data-slot` hooks prescribed. Also: the true occurrence count is **49**, not 48 — my 48 came from `grep -c`, which counts lines, and one line carries two. |
| 8 | `gap: var(--space-1) var(--space-3)` is row-then-column, so the inline gap is **12px**, not the 8px I wrote; and a 20.5px-wide target with 12px spacing likely **passes** WCAG 2.5.8's spacing exception | Read the shorthand; computed the 24px-circle test — centres are 39.35px apart, well clear | **Upheld.** The 2.5.8 failure claim is withdrawn. The 2.5.5 / repo-contract rationale stands on its own. |
| 9 | §2.6 claimed `Notice` has "the same wash and border maths" as the rule it replaces. It does not — 6% vs 7% wash, no border vs a 35% hairline, 12×24 vs 12 all-round, 13px vs 14px | Read both | **Upheld.** Reframed as a deliberate convergence change, not an equivalence. |
| 10 | Inventory stale: `.button` and `.ey` counts | Recounted | **Upheld.** See §2.7. |
| 6 | Removing the strut is safe, but my replacement layout was internally unresolved — `justify-end` on a natural-width group does not position anything | Read | **Upheld.** §5.3 now fixes DOM order and width explicitly. |
| 2 | `role="status"` inside the toggle `<button>` is flattened (ARIA button is *Children Presentational*), and a conditionally-created live region is not a dependable announcement | I had **already withdrawn this myself** before Sol reported, having measured Chrome's AX tree | **Upheld, and Sol's replacement is better than my withdrawal** — see §2.3. |

**The one thing I found that Sol did not:** a wrap defect at 480px with a long author name, where
`Delete` orphans onto a second line at the far left. Measured after the draft, recorded as §2.1b.

### Round 2 — five findings, three blocking, all upheld

| # | Finding | Verified how | Outcome |
|---|---|---|---|
| 1 | §6 counted only class selectors and **missed 12 `[aria-label="New notice"]` assertions** that §5.2's badge change breaks | Counted the selector form specifically: **4 in dom, 8 in freshness**, exactly Sol's split | **Upheld.** Total migration is **61 sites, not 49**. Also replaced my non-actionable "scoped button-text lookup" with explicit `data-slot` hooks. |
| 2 | Retiring the block drops `.notice-board__post > .rich-text { margin-top: 8px }` (`app.css:391`) with no replacement — content would render flush against the header | Read the rule; confirmed §5.3's markup omitted it and the article is not a grid | **Upheld.** `RichTextContent` now carries `className="mt-[var(--space-2)]"`. |
| 3 | The edit composer was specified as the create composer "but instead" — leaving the winner to composition and emission order | Read; `.px-0` is emitted before `.px-[var(--space-5)]` | **Upheld.** Both composers are now separate complete strings, with a standing rule against "base plus overrides" in §5.4. |
| 4 | `cn()` **silently discards** the bare `focus-visible:!outline` from `RING` as conflicting with the `-[length:…]` utility | Ran the real `cn()`; then read the built CSS | **Upheld** as an accuracy fix → `!outline-solid`. **No live defect**, here or in TB8-07's shipped `ICON_BUTTON_BASE`: the length utility already emits `outline-style:…!important`. |
| 5 | §7's viewport list and criterion 1 disagreed (720 missing), and "both composer buttons" is three | Read; `Post notice` / `Cancel` / `Save` | **Upheld.** Five viewports; criterion 9 corrected. |

Sol also confirmed, unprompted, three things I had asked about and resolved myself: `ACTION_SIZING`
belongs at the call site rather than in `button.tsx` (the compact `text` variant is intentional
across 21 call sites), `hidden` preserves the mounted anchor and the freshness gating, and the
author shorthand really is `--type-eyebrow`.

---

---

## 0a. Visual gate — PASSED

Run by this session (never delegated), on local dev at all five §7 viewports, against a **seeded
own-authored notice** — local dev is the project's sanctioned mutation-safe target, and the fixture
was deleted afterwards (both copies, `200` each; the 6 pre-existing posts untouched).

### The headline fix, measured

| Width | `Edit` | `Delete` | Same row |
|---|---|---|---|
| 1440 | 46.4 × **38** | 65 × **38** | yes |
| 1024 | 46.4 × **38** | 65 × **38** | yes |
| 720 | 46.4 × **44** | 65 × **44** | yes |
| 480 | 46.4 × **44** | 65 × **44** | yes |
| 390 | 46.4 × **44** | 65 × **44** | yes |

Was 20.5 × 24 and 34.2 × 24. Both axes now clear 44 at and below the `max-[721px]` breakpoint, and
38 above it — criterion 1 met exactly, including the `min-w` that §2.1 proved `buttonClasses` does
not supply on its own.

### Contrast

| Site | Before | After |
|---|---|---|
| Timestamp | **3.57:1** | **9.2:1** |
| "edited" | **3.57:1** | **9.2:1** |
| Mention hint | **3.57:1** | **9.2:1** |
| `Edit` | 9.2:1 | 9.2:1 (held) |
| `Delete` | 10.0:1 | 10.0:1 (held) |
| Author | 19.8:1 | 19.8:1 (held) |
| Eyebrow / summary / chevron | 9.2:1 | 9.2:1 (held) |

Nothing regressed. Summary is now **14px** (was the hard-coded 13px) and the chevron **28px** (was
24px), both at 9.2:1.

### The rest of §7

| # | Criterion | Result |
|---|---|---|
| 4 | Mention hint in sentence case | `text-transform: none` at all five widths — `!normal-case` held |
| 5 | `<time>` is not a strut | **102.8px** at 1440 (was 1,138.8px) |
| 6 | **No orphaning at 480 with a long name** | Edit and Delete on the **same row**, 11.9px apart, 24px right inset, 0 overflow. Was: Delete alone at x=0 on a second line |
| 7 | Zero horizontal overflow | 0 at all five widths; 0 elements overflowing their own box |
| 8 | Toggle name carries the unread signal | `"STAFF NOTICE BOARD Messages for the production desk **New notice**"` — and via the `sr-only` span, not a descendant `aria-label` |
| 9 | Focus rings | toggle / Edit / Delete all `solid 2px rgb(10,10,10)` at `offset 2px`; Post notice / Cancel / Save all carry the ring |
| 10 | `app.css` retirement | `grep -c "notice-board"` → **0**; `grep -rn "notice-board__" src/` → **0** |
| 11 | Full suite | typecheck 6/6, build green, **1,742 tests** (115+221+700+296+253+13, plus 144 shared), 0 failures, all 61 test sites migrated, none deleted |

Zero console errors and zero failed requests throughout.

### Two things worth recording

**Sol r2 #3 was confirmed by direct measurement, not just reasoning.** The edit composer computes
`padding-left: 0px`, `padding-top: 16px`, `padding-bottom: 0px` — exactly what
`pt-[var(--space-4)] px-0 pb-0` asks for. Had it been written as the create composer *plus* an
override, `px-[var(--space-5)]` would have won and the left padding would read 24px.

**One apparent defect that was my own measurement error.** My first gate pass reported the summary
at 13.333px and 19.8:1 — wrong on both counts. The selector `querySelectorAll("span").find(…text
matches…)` had matched the *outer label-stack span*, which contains the summary and inherits the
button's UA font size. Re-measuring the element itself gave 14px at 9.2:1. **Nothing was wrong with
the build.** Recorded because the failure mode — a text-matching selector silently resolving to an
ancestor — will recur.

*Limit:* the focus-ring check reports an ancestor with `overflow-x: clip` (`main.page`). The board
sits 24px inside it and the ring is 2px at 2px offset, so it cannot reach that boundary; the rings
are not clipped. Stated rather than assumed.

---

## 1. Why this surface, and why it is small

The notice board is the last un-converged *content* surface. It is also the smallest remaining
candidate by a wide margin: **one component at 148 lines** and **29 `app.css` rules**
(`app.css:374-404`). There is no structural redesign to do here and no state machine to unpick —
`lib/notice-board-data.ts` (679 lines) owns every bit of the freshness/read-marker logic and this
release does not touch it.

The reason to do it anyway is not the size of the CSS block. It is this:

> **The notice board and the project discussion thread are the same object at two scopes — an
> authored rich-text post with an author, a relative timestamp, an "edited" marker, owner-only
> Edit/Delete, and a mention-aware composer — and after TB8-07 they no longer look like it.**

TB8-07 converged the project discussion onto `META_TEXT`, `buttonClasses`, `EmptyState`, `Notice`
and the ledger idiom. The notice board still renders the identical shape out of hand-rolled CSS
with its own type sizes, its own muted grey, and its own inline text buttons. A studio member who
reads a project comment and then reads a staff notice is looking at two different design systems
describing the same act. **This release is convergence, not a repaint**, and the retirement of 29
rules is the by-product rather than the point.

### 1.1 What is in scope

- `portal/apps/web/src/components/NoticeBoard.tsx` (148 lines).
- `portal/apps/web/src/styles/app.css:374-404` — the `.notice-board__*` block, 29 rules.

### 1.2 What is explicitly NOT in scope

| Out of scope | Why |
|---|---|
| `lib/notice-board-data.ts` | Data/freshness logic. No visual surface. Untouched. |
| `RichTextEditor` / `RichTextContent` chrome | Already converged by TB8-07. Consumed as-is. |
| The legacy `.notice` rule (`app.css:748`) | Still has one live consumer, `ProjectDeadlineControl.tsx:279`. Retiring it is a `ProjectDeadlineControl` change, not a notice-board one. **Deferred to TB8-10.** |
| `.ey` (`app.css:20`) | 17 consumers across the app. A notice-board-scoped release must not retire a shared class. **Deferred to TB8-10.** |
| Adding a delete confirmation | See §2.1a. A product decision, flagged not taken. |

---

## 2. Measured defects

Measured on **production** (`quincy.flamingfire.my`, app Worker `3be901b7`) over CDP, signed in as
Admin, against a real notice with a real author. Contrast computed from resolved
`getComputedStyle` colours against the nearest painted ancestor background, WCAG 2.x relative
luminance. Where a claim is *not* a live measurement, it says so.

### 2.1 Owner actions are far below the touch-target contract — the headline

At **390×844**, on your own notice:

| Control | Measured | Repo contract |
|---|---|---|
| `Edit` | **20.5 × 24** | 44 × 44 |
| `Delete` | **34.2 × 24** | 44 × 44 |

`.notice-board__edit, .notice-board__delete { padding: 3px 0 }` on 12px text is the whole box.

**The contract being missed is this repo's own**, adopted in `buttonClasses` BASE, `ICON_BUTTON`
and `Modal`'s footer, all of which raise to 44px at `max-[721px]`. It corresponds to WCAG **2.5.5
Enhanced**.

> **Withdrawn from the first draft:** I also claimed a WCAG **2.5.8 Minimum (24×24, Level AA)**
> failure on `Edit`'s 20.5px width. Sol was right that this does not follow. 2.5.8 has a spacing
> exception, and the inline gap here is 12px — not the 8px I wrote (`gap: var(--space-1)
> var(--space-3)` is *row then column*, so 4px row / **12px column**). Centre-to-centre for
> Edit→Delete is `10.25 + 12 + 17.1 = 39.35px`, comfortably clearing the 24px undisturbed-circle
> test. **The 2.5.8 claim is dropped.** The 2.5.5 / repo-contract rationale stands by itself.

The right-hand control **deletes a post with no confirmation** (§2.1c).

**The fix is not simply `buttonClasses("text")`.** Sol's blocking finding #1, verified by running
the real `cn()` and printing the resolved class string:

```
buttonClasses("text")
  → … max-[721px]:min-h-[44px] … min-h-[32px] px-0 py-[6px] !text-foreground-secondary …
```

Two things follow, both fatal to the draft's version of this fix:

1. **There is no `min-width` anywhere in `buttonClasses`.** The variant would stay ~20px and ~34px
   wide. Height alone is not a touch target.
2. **`min-h-[32px]` beats BASE's `min-h-[38px]`** under twMerge, so the desktop height would
   *drop* from the current 24px… to 32px (an improvement, but not the 38px the plan implied).

The prescription is therefore explicit, and lives in §5.3.

### 2.1a Correction: how I measured this wrong the first time

My first probe hand-concatenated `BASE + VARIANT.text` into a raw class string and read the
computed style off an injected node. It returned `padding: 9px 14px`, which looked like a live
defect in every `buttonClasses("text")` in the app. **It is not.** `cn()` is `twMerge(clsx(…))`, so
`px-0` correctly wins — confirmed by finding **zero** elements in the live DOM carrying both
classes.

**Never probe a `cn()`-composed class list by hand-concatenating it.** Go through `cn` itself (a
four-line Node script inside `apps/web` is enough) or read the real element. That same discipline
is what turned Sol's finding #1 from an assertion into a verified fact.

### 2.1b A destructive control orphans onto its own line at 480px

Found after the draft, not in it, and not in Sol's report. Measured by substituting a
40-character author name (`.notice-board__author` already sets `overflow-wrap: anywhere`, so long
names are anticipated) and reading every child's box at nine widths.

At **480px**, the head becomes 52px tall and the children land like this, relative to the head:

| Child | x | y | w × h |
|---|---|---|---|
| author | 0 | 5 | 245 × 14.4 |
| `<time>` | 257 | 3 | 62.6 × 18 |
| "edited" | 331.5 | 3 | 34 × 18 |
| **`Edit`** | **377.5** | **0** | 20.5 × 24 |
| **`Delete`** | **0** | **28** | 34.2 × 24 |

**`Delete` wraps to a second line and sits alone at the far left**, under the author's name and
detached from the `Edit` it belongs beside. A destructive control, isolated, in the position the
eye reads first. It is the only width in the nine tested (320/390/480/600/768/900/1024/1280/1440)
where this happens, and only with a long author name — which is exactly why the flat "the strut is
harmless" reading in the first draft was too generous.

*Method note:* my first pass at this used a "distinct `y` values" count as a proxy for row count.
That is worthless here — `align-items: baseline` gives every differently-sized child its own `y` on
the same visual line. The table above uses real boxes instead.

### 2.1c The delete confirmation is a product question, flagged not taken

`deletePost` fires immediately. This repo already has a confirmation modal
(`docs/plans/implemented/Confirmation-Modal-And-Admin-Impersonation-Plan.md`). Adding one changes a
flow rather than a treatment and belongs to the owner. **This plan raises the target and fixes the
orphaning, and stops there.**

### 2.2 Three sites at 3.57:1 — the same token, ratio and fix TB8-07 already shipped

| Site | Size | Colour | Measured |
|---|---|---|---|
| `.notice-board__post-head time` | 12px | `--text-muted` | **3.57:1** |
| `.notice-board__edited` | 12px | `--text-muted` | **3.57:1** |
| `.notice-board__composer-foot > span` ("Use @ to mention…") | 12px | `--text-muted` | **3.57:1** |

12px is not large text, so the threshold is **4.5:1**. All three fail.

Numerically identical to the discussion-thread timestamp TB8-07 fixed (3.57:1 → 8.66:1) — same
`--greige-400`, same paper. The fix is already written: **`META_TEXT`**, resolving to
`--text-secondary` at **9.2:1**, which is what the eyebrow, summary, chevron and Edit on this very
surface already measure.

**But the hint is a sentence, not a label.** Sol's blocking finding #5: `META_TEXT` includes
`uppercase`, and the precedent this plan claims to copy writes `cn(META_TEXT, "!normal-case")` —
the `!` load-bearing, because TB8-07's visual gate found that a plain `normal-case` loses to
`META_TEXT`'s `uppercase` on Tailwind emission order. Exact calls in §5.3 and §5.4.

### 2.3 The unread badge: my finding was wrong, and Sol's replacement beats my withdrawal

The draft claimed the badge — `<span className="notice-board__badge" aria-label="New notice" />`,
a role-less generic — might never be announced. I measured that myself before Sol reported, by
injecting three variants into the live page and reading Chrome's AX tree via
`Accessibility.getPartialAXTree`:

| Variant | Toggle button's accessible name |
|---|---|
| **Current markup** | `"Staff notice board Messages for the production desk New notice"` ✅ |
| My proposed `role="status"` + `sr-only` | `"Staff notice board Messages for the production desk"` ❌ **signal lost** |
| `aria-describedby` | `"…production deskNew notice"` (no separator) |

So the signal *is* announced today, because the button's name is computed from its contents and
name-from-content uses a descendant's `aria-label`. My proposed fix **removed** it. I withdrew the
finding and specified "no change".

**Sol's finding #2 then gave the reason my measurement came out that way, and a better end state:**
the ARIA `button` role is *Children Presentational*, so semantic descendants are flattened — which
is why `role="status"` contributed nothing — and a conditionally-created live region is not a
dependable announcement anyway, since AT announces *changes*, not initial content.

**Resolution — Sol's, not mine:** fold an `sr-only` "New notice" string into the toggle's
accessible name and make the visual dot `aria-hidden="true"`. Same measured name as today, but it
no longer depends on a descendant `aria-label` on a role-less element to get there. Exact markup in
§5.2.

*Honest limit:* one browser's AX tree, no real screen reader. Descendant `aria-label` feeding
name-from-content is what the accname spec says, so this is not a Chrome quirk — but it was not
checked against a second engine.

### 2.4 The timestamp is a 1,138px strut

`.notice-board__post-head time { flex: 1 1 auto }`. Measured at 1440: the `<time>` is **1,138.8px**
wide inside a 1,344px board.

Sol's finding #6 sharpened what this means, and corrected how the draft framed it. Checked across
all nine widths, with both a short and a 40-character author name: there is **no later media query
overriding it** (`app.css:388-390` is the whole story), and at every width it does exactly one
thing — absorb slack so the actions sit hard right. It is right-alignment machinery, nothing more,
and removing it is safe.

But the draft's framing — "the strut exiles Edit and Delete to the far rim, so remove it" — was
muddled, because a `justify-end` group *also* puts them at the rim. The honest statement is:

> **The defect is a semantically false element width, not the position of the actions.** A
> `<time>` reporting 1,138.8px is lying about what it contains, and it is what produces the 480px
> orphaning in §2.1b.

§5.3 fixes the DOM order and the width explicitly, rather than leaving "where do the actions go" to
the builder.

### 2.5 Token drift

Hard-coded and not traceable to the design system: `13px` (summary), `12px` (×3), `14px` (empty),
`24px` (chevron), `7px` (badge), `4px`, `8px`, `10px`, `3px 0`, and `1px` borders where
`--border-width-hair` exists.

`.notice-board__author` sets `font: var(--type-label)` then overrides `font-size: 12px` on the next
declaration. Per Sol's finding #10 the shorthand is **not** redundant — it still supplies family,
weight **and line-height**; only its size is overridden. §5.3 restates it as one explicit shorthand.

### 2.6 Two primitives exist and are not used — a convergence change, not an equivalence

| Hand-rolled | Primitive | Sol's #9: they are **not** the same |
|---|---|---|
| `.notice-board__error` | `<Notice tone="critical">` | no border → 35% hairline; 6% → 7% wash; 12×24 asymmetric → 12px all-round; 13px → 14px |
| `.notice-board__empty` | `<EmptyState>` | 24px/14px left-aligned → 32×64 padding, centred 28px display type |

Both differences are **intended**: the point is that a notice-board error should look like every
other error in the app, and its empty state like every other empty state. But the draft asserted
equivalence, which was false, and `EmptyState`'s defaults are far heavier than the current message —
so §5.2 pins the exact override classes rather than accepting the primitive's defaults.

### 2.7 Legacy-class inventory (corrected)

| Class | Draft said | Actual | Note |
|---|---|---|---|
| `.button` sites (`className="button…"`) | 51 (from TB8-10's D-06) | **27 across 15 files** | The 51 figure is stale. This release retires 3, leaving 24. |
| `.ey` sites | 17 | **21** | Shared; deferred to TB8-10. |
| `.notice` live consumers | 1 | 1 (`ProjectDeadlineControl.tsx:279`) | Deferred to TB8-10. |

Also spotted while verifying, and **not** fixed here: `.sr-only` is declared **twice** in
`app.css` (lines 794 and 806), identically. A shared class with a duplicate declaration — TB8-10's
territory, recorded so it is not lost.

TB8-10's own D-06 line should be re-measured when that release is drafted; **this plan does not
edit TB8-10.**

---

## 3. Design direction — "the same voice at two scopes"

No new visual language. The direction is **the discussion thread's ledger applied at board scope**,
because the two surfaces are the same object and the studio reads them the same way.

1. **The meta line is uppercase eyebrow type at `--text-secondary`.** Author in ink at `--text-sm`;
   timestamp and "edited" in `META_TEXT`.
2. **Owner actions are a `justify-end` row of their own, after the content** — the discussion
   thread's shape exactly. This is what buys both the 44px target and the fix for §2.1b.
3. **The composer foot is a `flex-wrap` row**, hint left, primary right.

**What stays distinct, deliberately:** the board is a *disclosure* and the discussion is not. The
collapsible toggle, the unread left-rule, and the ± chevron are the notice board's own affordances
and all three are kept — the unread rule in particular measures fine and is a good quiet signal.

---

## 4. Retirement ledger

All 29 rules at `app.css:374-404` retire. **No kept block** — every rule maps to a utility or a
primitive, and §5 gives the exact classes.

**Load-bearing check — done, not delegated.** `grep -rn "querySelector.*notice-board"` across all
non-test `.ts`/`.tsx` returns **zero** hits. No application JS depends on any `.notice-board__*`
class. The only non-CSS consumers are the test files (§6).

---

## 5. The exact specification

Per `Subagent-Frontend-Orchestration.md:17-22`, the plan closes every design decision. Classes below
are literal. Where a class carries `!`, the `!` is load-bearing and stated why.

**Two cascade facts that govern everything here** (both cost TB8-07 a review round):

- `styles/index.css` imports `app.css` **outside every `@layer`**, so any surviving legacy rule
  beats a Tailwind utility regardless of specificity. This release retires the whole block, so the
  only risk is a *shared* class — hence `.ey` and `.notice` staying out of scope.
- `tokens/base.css:25-28`'s unlayered `:focus-visible { outline: …; outline-offset: 2px }` uses the
  `outline` **shorthand**, which resets `outline-offset`. **Every focus-ring utility in this
  release must be `!`-prefixed**, exactly as `ICON_BUTTON_BASE` does.

Shared constant, defined once at the top of `NoticeBoard.tsx`.

> **Why `!outline-solid` and not `!outline`.** Sol r2 #4, verified by running the real `cn()`: a
> bare `focus-visible:!outline` is **silently dropped by twMerge** as conflicting with
> `focus-visible:!outline-[length:…]`. Nothing breaks visually, because the length utility emits
> `outline-style:var(--tw-outline-style)!important` alongside the width — confirmed by reading the
> built CSS — **so TB8-07's shipped `ICON_BUTTON_BASE`, which has the same bare `!outline`, is not
> defective either.** But the class list is not what it claims to be, and a future reader would
> reasonably assume all four survive. `!outline-solid` makes all four survive unambiguously.

```tsx
const RING =
  // `!outline-solid`, not `!outline`: `cn()` is twMerge, and it discards a bare
  // `focus-visible:!outline` as conflicting with the `-[length:…]` utility (Sol r2 #4, verified).
  "focus-visible:!outline-solid focus-visible:!outline-[length:var(--border-width-bold)] " +
  "focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-2";
```

### 5.1 Shell and toggle

| Element | Classes |
|---|---|
| `<section>` | `mb-[var(--space-6)] border-[length:var(--border-width-hair)] border-solid border-border bg-card` |
| toggle `<button>` | `cn("w-full flex items-center gap-[var(--space-4)] px-[var(--space-5)] py-[var(--space-4)] min-h-[44px] bg-transparent border-0 [border-left-style:solid] border-l-[length:var(--border-width-rule)] text-left text-foreground cursor-pointer transition-[background-color,border-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:bg-secondary", hasUnread ? "border-l-border-strong" : "border-l-transparent", RING)` |
| label stack (`> span:first-child`) | `flex flex-col gap-[var(--space-1)] flex-1 min-w-0` |
| eyebrow | `<Eyebrow>Staff notice board</Eyebrow>` — replaces `className="ey"`, so this call site leaves the shared class behind without touching the other 20 |
| summary | `[font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary` — `--text-sm` (14px) replaces the hard-coded 13px |
| chevron | `[font:var(--weight-regular)_var(--text-xl)/1_var(--font-sans)] text-foreground-secondary` + keeps `aria-hidden="true"` — `--text-xl` (28px) replaces 24px |

`bg-card` = `--bg-surface` = `--paper-000`; `hover:bg-secondary` = `--bg-raised` = `--paper-100`;
`border-l-border-strong` = `--border-strong` = `--ink-900`. All three preserve the current paint.

### 5.2 Unread badge, panel, posts, empty state

**Badge (§2.3, Sol's resolution).** Replaces the role-less `aria-label` span:

```tsx
{hasUnread && (
  <>
    <span className="sr-only">New notice</span>
    <span aria-hidden="true" className="w-[7px] h-[7px] flex-none rounded-[var(--radius-pill)] bg-primary" />
  </>
)}
```

`bg-primary` = `--accent` = `--ink-900`, the current dot colour. **Acceptance:** the toggle's
computed accessible name still ends in "New notice" (criterion 8).

| Element | Classes |
|---|---|
| panel `<div>` | `border-t-[length:var(--border-width-hair)] [border-top-style:solid] border-t-border` + **`hidden={!open}`** in place of `.is-collapsed`. Keeps `id={panelId}` and `aria-hidden={!open}`. `hidden` is safe here: the artifact skeleton's reset carries `[hidden]{display:none!important}` and this is the same `display:none` semantics the retired class had. |
| posts `<div>` | `grid` — keeps `aria-live="polite"` **and** the `presentation.anchorRef` placement byte-for-byte (§5.6) |
| post `<article>` | `px-[var(--space-5)] py-[var(--space-4)] border-b-[length:var(--border-width-hair)] [border-bottom-style:solid] border-b-border` |
| changed-target `<article>` | same + `bg-secondary` (was `--paper-100`) |
| empty state | `<EmptyState title="No notices yet." className="px-[var(--space-5)] py-[var(--space-5)] text-left" />` — the overrides are required: the primitive defaults to `px-[var(--space-6)] py-[var(--space-8)]` centred, which is far heavier than the current 24px left-aligned line (§2.6) |

### 5.3 The post head, meta line and owner actions

**DOM order changes** (§2.4, §2.1b). The single wrapping row becomes a meta row plus a separate
action row placed **after the rendered content**, matching `ProjectDiscussionThread.tsx`:

```tsx
<article className={POST}>
  <header className="flex flex-wrap items-baseline gap-x-[var(--space-3)] gap-y-[var(--space-1)] min-w-0">
    <span className="[font:var(--type-eyebrow)] text-foreground min-w-0 [overflow-wrap:anywhere]">{post.authorName}</span>
    <time dateTime={post.createdAt} className={META_TEXT}>{relativeTime(post.createdAt)}</time>
    {post.editedAt && <span title={post.editedAt} className={META_TEXT}>edited</span>}
  </header>
  {editingId === post.id
    ? renderEditComposer(post.id)
    /* `mt-[var(--space-2)]` replaces the retired `.notice-board__post > .rich-text { margin-top: 8px }`
       (app.css:391). The article is not a grid, and the first rich-text child has no margin of its
       own, so without this the content renders flush against the header (Sol r2 #2).
       `RichTextContent` takes `className` and appends it to `rich-text` by plain string
       concatenation — no `cn()`, so no twMerge — which is fine here: `mt-` conflicts with nothing
       in `.rich-text`. */
    : <RichTextContent content={post.content} className="mt-[var(--space-2)]" />}
  {post.authorId === currentUserId && (
    <div className="flex justify-end gap-[var(--space-3)] mt-[var(--space-2)]">
      <button type="button" className={EDIT_ACTION} onClick={…}>Edit</button>
      <button type="button" className={DELETE_ACTION} onClick={…}>Delete</button>
    </div>
  )}
</article>
```

The `<time>` has **no** `flex` utility — that is the strut removal. The author keeps
`overflow-wrap: anywhere`; with the actions no longer in this row, the 480px orphaning in §2.1b
cannot recur, because there is nothing left in the row to orphan.

> **Author `font` shorthand — resolved, no invented token.** Per §2.5 the retired rule supplied
> family, weight *and* line-height from `--type-label`, with only size overridden. Reading the
> tokens closes this exactly:
>
> ```
> --type-label:   var(--weight-regular) var(--text-sm)/1.2 var(--font-sans)   /* 14px */
> --type-eyebrow: var(--weight-regular) var(--text-xs)/1.2 var(--font-sans)   /* 12px */
> ```
>
> The two differ *only* in size, and the retired rule overrode size to 12px. So
> `font: var(--type-label); font-size: 12px` **is** `--type-eyebrow`, computed identically —
> `[font:var(--type-eyebrow)]` with `text-foreground` for the ink, and none of `Eyebrow`'s
> `uppercase`/`tracking`. Nothing is inlined and no token is invented.

**The two action constants** — this is Sol's #1 and #4, in full:

```tsx
// `min-w` is prescribed because `buttonClasses` contains NO min-width at all (§2.1); height
// alone is not a touch target. `min-h-[38px]` is prescribed because the `text` variant's own
// `min-h-[32px]` beats BASE's 38px under twMerge, and this release converges on 38/44, not 32/44.
const ACTION_SIZING = "min-h-[38px] max-[721px]:min-w-[44px] max-[721px]:min-h-[44px] px-[var(--space-2)]";

const EDIT_ACTION = buttonClasses("text", { className: ACTION_SIZING });

// `!` is load-bearing: the `text` variant sets `!text-foreground-secondary`, which a plain
// `text-destructive` cannot outrank even though twMerge keeps both (Sol #4, verified).
const DELETE_ACTION = buttonClasses("text", {
  className: ACTION_SIZING + " !text-destructive hover:not-disabled:!text-destructive",
});
```

`buttonClasses` already carries its own focus ring, so `RING` is **not** added here.

`px-[var(--space-2)]` is deliberate: it gives the 44px min-width something to be wider than on a
short label like "Edit", instead of relying on `min-w` alone to stretch an unpadded box.

### 5.4 Both composers and the notices

| Element | Classes |
|---|---|
| create composer `<form>` | `grid gap-[var(--space-3)] px-[var(--space-5)] py-[var(--space-4)]` |
| edit composer `<div>` | `grid gap-[var(--space-3)] pt-[var(--space-4)] px-0 pb-0` — **a separate complete string, not the create string plus overrides** (mirrors the retired `padding: var(--space-4) 0 0`) |
| composer foot | `flex flex-wrap items-center justify-between gap-[var(--space-3)]` |
| mention hint | exactly `<span className={cn(META_TEXT, "!normal-case", "flex-[1_1_12rem] min-w-0")}>` — **`!normal-case` is mandatory** (§2.2, Sol r1 #5) |
| error | `<Notice tone="critical" role="alert">` — `Notice` does **not** inject a role, so `role="alert"` must be passed explicitly or the announcement is lost |
| changed-target message | `<Notice tone="caution" role="status">` — same reasoning |
| Post notice / Save | `buttonClasses("primary")` |
| Cancel | `buttonClasses("secondary")` |

> **No "base plus overrides" anywhere in this table.** Sol r2 #3: writing the edit composer as the
> create composer "but with `px-0`" leaves the winner to whichever the builder composes and, absent
> `cn()`, to Tailwind's emission order — `.px-0` is emitted *before* `.px-[var(--space-5)]`, so the
> padding the edit composer is supposed to drop would come back. Each row above is a complete,
> standalone string. Compose with `cn()` only to add call-site classes, never to cancel one from
> this table.

### 5.5 States, in full

| State | Treatment |
|---|---|
| default | as above |
| hover | toggle `hover:bg-secondary`; actions inherit `buttonClasses`' own hover |
| focus-visible | `RING` on the toggle; `buttonClasses`' built-in ring elsewhere. **Every ring `!`-prefixed** |
| disabled | `buttonClasses`' `disabled:` states only. **No opacity multiplier anywhere** — that is what took TB8-06's handle to 1.72:1 and TB8-07's grip to 2.51:1 |
| collapsed | `hidden` + `aria-hidden={!open}` |
| unread | `border-l-border-strong` on the toggle, `sr-only` text + `aria-hidden` dot |
| error | `<Notice tone="critical" role="alert">` |
| empty | `<EmptyState>` with the §5.2 overrides |

### 5.7 Every class in §5 compiles — verified, not assumed

Dropped all 23 literal class strings above into a temporary module in `apps/web/src`, ran
`npm run build`, and grepped the emitted CSS for each resulting declaration. **All compile against
the installed Tailwind 4.3.3.** Spot-checks:

| Class | Emitted |
|---|---|
| `w-[7px]` | `width:7px` |
| `rounded-[var(--radius-pill)]` | `border-radius:var(--radius-pill)` |
| `max-[721px]:min-w-[44px]` | `.max-\[721px\]\:min-w-\[44px\]{min-width:44px}` |
| `min-h-[38px]` | `min-height:38px` |
| `border-l-border-strong` | present (the TB8-07 theme alias resolves) |
| `gap-x-[var(--space-3)]` | `column-gap:var(--space-3)` |
| `!normal-case` | `text-transform:none` |

**One near-miss worth recording.** `flex-[1_1_12rem]` emits `flex:12rem`, **not** `flex:1 1 12rem`,
so a grep for the three-value form returns zero and looks like a compile failure. It is not: CSS's
one-value `flex: <width>` syntax *is* `1 1 <width>`, so the behaviour is identical. I checked what
was actually emitted instead of concluding from the absence — the same discipline §2.1a exists to
enforce.

The probe module was deleted and the build re-run; `dist` returns to the byte-identical
`index-DhbZB4Gh.css` currently in production, confirming it left nothing behind.

### 5.8 §5.3 eliminates the §2.1b orphaning — simulated at 28 combinations

Before building, I injected the §5.3 structure (meta row with no strut and no actions; a separate
`justify-end` action row) into a live page and measured it at **7 widths × 4 author/timestamp
combinations**, including a 55-character name paired with an 11-character relative time.

**All 28: `Edit` and `Delete` on the same row, flush right (0px gap to the container edge), zero
horizontal overflow.** `Edit` resolves to 44px wide via `min-w`; `Delete` to 56.6px on its natural
width. The orphaning cannot recur because there is no longer anything in the wrapping row to
orphan — the actions are not in it.

*Honest limit:* this is a structural simulation with inline styles approximating the prescribed
classes on a system font, not the built component in Apfel Grotezk. It confirms the **structure**
resolves the defect; it does not pre-empt the visual gate's own measurement (criterion 6), which
still runs against the real build at 480×900 with a long name.

### 5.6 The freshness contract — must survive byte-for-byte

`presentation.anchorRef` attaches to the **posts container when `posts.length === 0`** and to the
**first `<article>` otherwise**. `useNoticeBoardPresentation` drives read-marker behaviour this
release does not touch. Sol's verdict confirms nothing in §5 disturbs it *provided the ref stays
exactly there*. Also unchanged: `aria-live="polite"` on the posts container, `aria-expanded` /
`aria-controls` on the toggle, `aria-hidden` on the collapsed panel, the `sr-only` composer label
with its `htmlFor`, and `<time dateTime>` as a real `<time>`.

---

## 6. The tests are the real risk — corrected

`NoticeBoard.dom.test.tsx` (470), `NoticeBoard.freshness.dom.test.tsx` (702),
`Dashboard-notice-board.dom.test.tsx` (46), `RichTextByteGuard.dom.test.tsx` (57).

**61 selector sites in total**, in two groups the first draft counted as one:

**Group A — 49 `.notice-board__*` occurrences across 6 classes.** (The draft said 48; that came from `grep
-c`, which counts *lines*, and one line carries two.) Per-file, verified:

| Class | dom | freshness | byte-guard | total |
|---|---|---|---|---|
| `__post` | 10 | 4 | 0 | 14 |
| `__toggle` | 5 | 7 | 0 | 12 |
| `__edit` | 5 | 7 | 0 | 12 |
| `__edit-composer` | 0 | 3 | 1 | 4 |
| `__delete` | 2 | 2 | 0 | 4 |
| `__composer` | 0 | 3 | 0 | 3 |

**Group B — 12 `[aria-label="New notice"]` selector assertions**, which §6 originally missed
entirely because it only counted class selectors (Sol r2 #1). Verified: **4 in
`NoticeBoard.dom.test.tsx`, 8 in `NoticeBoard.freshness.dom.test.tsx`.** §5.2's badge change
**removes that attribute**, so all 12 fail unless migrated in the same slice.

(Careful when counting these: a bare `grep -c "New notice"` returns 5 and 10, because both files
also carry a *post-body fixture* whose text is the string "New notice". Only the
`[aria-label="New notice"]` selector form counts.)

`Dashboard-notice-board.dom.test.tsx` has **zero** of either group and is safe.

**Sol's #7, upheld and adopted: delete none of these.** None of the four files contains
`getComputedStyle`, `classList`, `toHaveClass`, or a class-attribute assertion — every occurrence is
purely a *locator* for behaviour: concurrency, polling, mutation, draft preservation, payload
shape, rich-text rendering. The 1,275:148 ratio is not over-testing; it is that ratio because
`notice-board-data.ts` is 679 lines of freshness logic exercised through this component.

My draft's "prefer accessible-name selectors" was **not actionable** — these are plain
`querySelector` tests and `querySelector` cannot select by accessible name.

**The prescription:** add stable hooks and migrate each site in the slice that retires its class.

| Retired class | Replacement selector |
|---|---|
| `.notice-board__toggle` | `[data-slot="notice-board-toggle"]` |
| `.notice-board__post` | `[data-slot="notice-board-post"]` |
| `.notice-board__composer` | `[data-slot="notice-board-composer"]` |
| `.notice-board__edit-composer` | `[data-slot="notice-board-edit-composer"]` |
| `.notice-board__edit` | `[data-slot="notice-board-edit"]` |
| `.notice-board__delete` | `[data-slot="notice-board-delete"]` |
| `[aria-label="New notice"]` | `[data-slot="notice-board-unread-indicator"]` on the `sr-only` span in §5.2 |

The draft said "scoped button-text lookup" for Edit/Delete. Sol r2 #1 is right that this is not an
implementation prescription — and since these are plain `querySelector` tests, a text lookup would
need a hand-written helper. **Explicit `data-slot` attributes instead**, on the two action buttons
and on the unread indicator, so every one of the 61 sites has an exact one-for-one replacement and
no test needs new machinery.

---

## 7. Acceptance criteria

Measured at **1440×900, 1024×768, 720×900, 480×900 and 390×844** — five viewports, on a board with
at least one own-authored notice. 720 is required because criterion 1's breakpoint contract lives
at `max-[721px]`; 480 because that is where §2.1b's orphaning appears, and that pass uses a
≥40-character author name.

1. `Edit` and `Delete` each measure **≥44 × 44 at 390 and 720**, and **≥38px tall at 1440**.
2. Timestamp, "edited" and the mention hint each measure **≥4.5:1** (expected 9.2:1).
3. No regression: eyebrow, summary, chevron, author, Edit and Delete currently measure
   9.2 / 9.2 / 9.2 / 19.8 / 9.2 / 10.0 and must hold or improve.
4. The mention hint renders in **sentence case**, not uppercase (`!normal-case` held).
5. The `<time>` is **not** a full-width strut at 1440.
6. **At 480 with a long author name, no control is orphaned onto its own line** — the §2.1b table
   is the before; the after must show the actions in one right-aligned group.
7. Zero horizontal overflow at all five widths; nothing inside the board overflows its own box.
8. The toggle's **computed accessible name ends in "New notice"** when `hasUnread` is true.
   Verified in local dev, where an unread state can be produced without writing to production.
9. Every focus ring visible and unclipped — the toggle, both owner actions, and **all three**
   composer buttons (`Post notice`, `Cancel`, `Save`; the draft said "both", which missed one).
10. `app.css:374-404` contains **zero** `.notice-board` selectors.
11. `npm run typecheck` 6/6, `npm run build -w @quincy/web`, the full suite green **including**
    `npx vitest run --config packages/shared/vitest.config.ts`, with **all 49 test sites migrated
    and none deleted** — all 61 sites, both groups.

---

## 7a. Slices 1 and 2 are visually inert by construction — verified

Legacy `.notice-board__*` classes stay on the elements until slice 3 retires the CSS, so that
nothing regresses mid-release. But `styles/index.css` imports `app.css` **outside every `@layer`**,
so while both are present **the legacy rule wins and the new utilities do nothing**.

Measured on local dev after slice 1 landed, using two properties where old and new disagree:

| | Legacy | Slice 1's utility | Computed |
|---|---|---|---|
| `.notice-board__summary` | 13px | `--text-sm` = 14px | **13px** |
| `.notice-board__chevron` | 24px | `--text-xl` = 28px | **24px** |

**This is expected, not a defect** — but three things follow, and they are why it is written down:

1. **The visual gate cannot run until slice 3.** Do not attempt it after slice 1 or 2; it would
   measure the old surface and report a false pass.
2. **Slice 3 must strip the legacy classes from the JSX**, not only the rules from `app.css`.
   Retiring the CSS alone would leave dead attributes behind and hide which classes were load-
   bearing.
3. A reviewer reading slice 1's diff in isolation will correctly observe that it changes nothing on
   screen. That is the staging, not a broken build.

What *is* immediately live after slice 1 — because it is markup, not paint — is the badge change,
the `<EmptyState>` substitution, `hidden` on the panel, and the `data-slot` hooks.

---

## 8. Slicing

| Slice | Scope | Commit |
|---|---|---|
| **1** | §5.1 shell + toggle, §5.2 badge/panel/posts/empty. Migrates `__toggle` (12) **and all 12 `[aria-label="New notice"]` assertions** — the badge change lands here, so its test migration must too. | `feat(tb8-08): slice 1 — the board shell, the unread badge and the empty state` |
| **2** | §5.3 in full — head split, meta on `META_TEXT`, the two action constants. Migrates `__post` (14), `__edit` (12), `__delete` (4). | `feat(tb8-08): slice 2 — the post, its meta line and its owner actions` |
| **3** | §5.4 composers + notices, the 3 `.button` migrations, **stripping every remaining legacy `.notice-board__*` class from the JSX** (§7a), and the whole `app.css:374-404` retirement. Migrates `__composer` (3), `__edit-composer` (4). | `feat(tb8-08): slice 3 — the composers, the notices and the app.css retirement` |

Then: this session's visual gate (including the 480px long-name case), the §5 orchestration gate,
merge, deploy on the owner's word.

---

## 9. Review record — closed

Both Sol rounds are spent and all 15 findings are adopted. The questions this section carried are
resolved:

1. **§5 as a whole** — it is new, and it is the finding-#3 fix. Is it actually at implementation
   resolution, or have I left a decision to the builder that I think I have closed?
2. **§5.3's `ACTION_SIZING`.** I prescribe `min-h-[38px]` to override the `text` variant's 32px, so
   this surface reads 38/44 like every other control. Is overriding the variant the right call, or
   does it argue the `text` variant itself is wrong and should be fixed in `button.tsx` — which
   would be a shared change and therefore out of this release's scope?
3. ~~**§5.3's author `font` shorthand.**~~ **Closed myself after round 1:** `--type-label` and
   `--type-eyebrow` differ only in size, so the retired `font: var(--type-label); font-size: 12px`
   *is* `--type-eyebrow`. No token invented, nothing inlined. Flag if that reading is wrong.
4. **§5.2's `hidden`** replacing `.is-collapsed`'s `display: none`, alongside the existing
   `aria-hidden={!open}`. Any interaction with the freshness/anchorRef behaviour when the panel is
   closed and posts are not rendered?
5. **§2.1b.** Does moving the actions out of the wrapping row actually eliminate the orphaning at
   every width, or have I traded it for a different break I have not measured?
