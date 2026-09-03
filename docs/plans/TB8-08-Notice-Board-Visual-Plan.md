# TB8-08 — Staff Notice Board: Visual Plan

**Status: DRAFTED, not yet reviewed or built.** Ranking candidate **#8** in
`Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md` ("Notice board"). Branch
`tb8-08-notice-board`, to be cut from `main` at `c025fbb` (TB8-07 shipped).

Pipeline: `docs/Subagent-Frontend-Orchestration.md` — this session drafts the plan, Sol reviews
scope and correctness (≤2 rounds), a Sonnet subagent builds it in slices, this session holds the
final visual gate. Matched-evidence viewports stay TB1's: `1440×900`, `1024×768`, `390×844`.

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
Admin, against a real notice with a real author. Contrast computed from resolved `getComputedStyle`
colours against the nearest painted ancestor background, WCAG 2.x relative luminance.

### 2.1 Owner actions are below the minimum touch target — the headline

At **390×844**, on your own notice:

| Control | Measured | Contract |
|---|---|---|
| `Edit` | **20.5 × 24** | 44 × 44 |
| `Delete` | **34.2 × 24** | 44 × 44 |

`.notice-board__edit, .notice-board__delete { padding: 3px 0 }` on 12px text is the whole box.
Both fail WCAG **2.5.5 Enhanced (44×44)**, which this codebase adopted as its own contract — it is
what `buttonClasses` BASE, `ICON_BUTTON`, and `Modal`'s footer all enforce at `max-[721px]`. `Edit`
at **20.5px wide** additionally fails **2.5.8 Minimum (24×24)**, which is a Level AA criterion.

They sit **8px apart** (`gap: var(--space-1) var(--space-3)` gives 4px inline… see §2.4), and the
right-hand one **destroys a post with no confirmation**. A 34×24 destructive target adjacent to a
20×24 non-destructive one, on a phone, is the defect this release exists to fix.

**Fix:** `buttonClasses("text")`. Verified empirically at three widths — 38px at 1440, **44px at
720 and at 390** — because `BASE`'s `max-[721px]:min-h-[44px]` correctly overrides the `text`
variant's `min-h-[32px]`. It is exactly what TB8-07 gave the discussion thread's own Edit/Delete.

> **Note for the builder, and a correction to a probe I ran first.** I initially measured this by
> concatenating `BASE + VARIANT.text` into one raw class string and reading the result: padding
> came back `9px 14px`, not the `px-0 py-[6px]` the variant asks for, which looked like a live
> defect in `buttonClasses("text")`. **It is not.** `cn()` is `twMerge(clsx(...))`, so
> tailwind-merge resolves `px-[14px]` vs `px-0` by source order and `px-0` wins — confirmed by
> finding **zero** elements in the live DOM carrying both classes. Never probe a `cn()`-composed
> class list by hand-concatenating it; go through `cn` or read the real element.

### 2.1a The delete confirmation is a product question, flagged not taken

`deletePost` fires immediately from a 34×24 target. This repo already has a confirmation modal
(`docs/plans/implemented/Confirmation-Modal-And-Admin-Impersonation-Plan.md`). Adding one here is
defensible, but it changes a flow rather than a treatment and belongs to the owner, not to a visual
release. **This plan raises the target to 44×44 and stops there.** Recorded for the owner in §0.

### 2.2 Three sites at 3.57:1 — the same token, the same ratio, the same fix TB8-07 already shipped

| Site | Size | Colour | Measured |
|---|---|---|---|
| `.notice-board__post-head time` | 12px | `--text-muted` | **3.57:1** |
| `.notice-board__edited` | 12px | `--text-muted` | **3.57:1** |
| `.notice-board__composer-foot > span` ("Use @ to mention…") | 12px | `--text-muted` | **3.57:1** |

12px is not large text, so the threshold is **4.5:1**. All three fail.

This is not a new finding — it is *numerically identical* to the discussion-thread timestamp
TB8-07 fixed (3.57:1 → 8.66:1), because it is the same `--greige-400` on the same paper. The fix is
already written and already shipped: **`META_TEXT`** from `components/ui/eyebrow.tsx`, which
resolves to `--text-secondary` (`--greige-600`) at **9.2:1** — the value the eyebrow, summary,
chevron, Edit and Delete on this very surface already measure at.

Use `META_TEXT` and not `<Eyebrow>` for the `<time>`: `Eyebrow` is hard-coded to a `<span>` and
would drop `dateTime`. That constraint is recorded in `eyebrow.tsx`'s own doc comment and guarded
by a TB8-07 regression test.

### 2.3 The unread badge announces itself through a role-less `<span>`

```tsx
{hasUnread && <span className="notice-board__badge" aria-label="New notice" />}
```

A 7×7 empty `<span>` with `aria-label` and **no role**. `aria-label` on a generic element with no
role is not reliably exposed — the ARIA spec permits a user agent to ignore it, and browser/AT
behaviour varies. So the one signal that says "there is something new" may be silent.

It could not be measured live (production currently has no unread state for this account), so this
is a **static reading of the markup**, stated as such.

**Fix:** `role="status"` on the badge with the label as its text content in an `sr-only` span, so
the announcement rides a real live region instead of an unlabelled generic. The visual dot stays a
decorative `aria-hidden` sibling.

### 2.4 The timestamp is a 1,138px spacer on desktop

`.notice-board__post-head time { flex: 1 1 auto }`. Measured at 1440: the `<time>` element is
**1,138.8px wide** inside a 1,344px board. It is not a timestamp; it is a strut that exiles Edit
and Delete to the far right rim of the screen, roughly a metre of pixels from the author name they
belong to.

At 390 it measures 152.8px and the row is fine, so this is a desktop-only layout defect.

**Fix:** the discussion thread's shape — author, timestamp and "edited" grouped at natural width on
a `flex-wrap` baseline row, with the owner actions in their own `justify-end` group. No strut.

### 2.5 Token drift

Hard-coded values in the block, none of which trace to the design system: `13px` (summary),
`12px` (×3), `14px` (empty state), `24px` (chevron), `7px` (badge), `4px`, `8px`, `10px`,
`3px 0`, and `1px` borders where the system has `--border-width-hair`.

`.notice-board__author` is its own small bug: it sets `font: var(--type-label)` and then
immediately overrides `font-size: 12px` on the next declaration — the shorthand is doing nothing
but supply a family and weight it could state directly.

### 2.6 Two primitives already exist and are not being used

| Hand-rolled | Existing primitive | Note |
|---|---|---|
| `.notice-board__error` (`role="alert"`, critical wash) | `<Notice tone="critical">` (`quincy/Notice.tsx`) | TB8-07 built it. Same wash, same border maths. |
| `.notice-board__empty` ("No notices yet.") | `<EmptyState title=… />` (`quincy/EmptyState.tsx`) | The discussion thread's "No comments yet." is already this. |

### 2.7 Three `.button` occurrences

`button`, `button--secondary`, `button` at lines 125 and 145. Migrating them to `buttonClasses`
retires **3 of TB8-10's 51** `.button` occurrences. Not the point of the release, but free.

---

## 3. Design direction — "the same voice at two scopes"

No new visual language. The direction is **the discussion thread's ledger, applied at board
scope**, because the two surfaces are the same object and the studio reads them the same way.

Concretely, three things carry over unchanged:

1. **The meta line is uppercase eyebrow type at `--text-secondary`.** Author in ink at `--text-sm`,
   then timestamp and "edited" in `META_TEXT`. This is what the discussion thread does and it is
   the treatment that took its own timestamp from 3.57:1 to 8.66:1.
2. **Owner actions are `buttonClasses("text")` in a `justify-end` group**, separated from the meta
   line rather than trailing it as inline links. This is what buys the 44px target.
3. **The composer foot is `flex-wrap` with the hint on the left and the primary on the right** —
   already the current shape; it only needs the hint's contrast fixed and the button migrated.

**What stays distinct, deliberately:** the board is a *disclosure* and the discussion is not. The
collapsible toggle, the unread left-rule (`border-left-color: var(--border-strong)` on
`.is-unread`), and the ± chevron are the notice board's own affordances and this release keeps all
three. The unread left-rule in particular is a good, quiet signal and measures fine; it is being
kept because it works, not by omission.

---

## 4. Retirement ledger

All 29 rules at `app.css:374-404` are retired. There is **no kept block** on this surface — every
rule maps to a utility or a primitive.

| Rule | Disposition |
|---|---|
| `.notice-board` | Utilities on `<section>` |
| `.notice-board__toggle` (+ `:hover`, `.is-unread`, `> span:first-child`) | Utilities; the unread left-rule becomes a conditional border utility |
| `.notice-board__summary` | Utilities, `--text-sm` (was 13px) |
| `.notice-board__chevron` | Utilities, `--text-lg`-class token (was 24px) |
| `.notice-board__badge` | Utilities + the §2.3 markup change |
| `.notice-board__panel` (+ `.is-collapsed`) | Utilities; keep `display:none` semantics via `hidden` |
| `.notice-board__posts` | Utilities |
| `.notice-board__post` | Utilities |
| `.notice-board__post-head` (+ `time`, per §2.4) | Utilities, strut removed |
| `.notice-board__author` | Utilities, single `[font:…]` shorthand (§2.5) |
| `.notice-board__post > .rich-text` | Utility on the content wrapper |
| `.notice-board__edit` / `__delete` (+ `:hover`) | `buttonClasses("text")` / `buttonClasses("text")` with destructive colour |
| `.notice-board__edited` | `META_TEXT` |
| `.notice-board__empty` | `<EmptyState>` |
| `.notice-board__error` | `<Notice tone="critical">` |
| `.notice-board__composer` (+ `-foot`, `-foot > span`) | Utilities |
| `.notice-board__edit-composer` | Utilities |
| `.notice-board__post--changed` | Utility background |
| `.notice-board__edit-target-changed` | `<Notice tone="caution">` |

**Load-bearing check — done, not delegated.** Unlike TB8-07 (where
`.subtask-checklist__title-trigger` was a live `querySelector` focus hook and
`.rich-text__editor-content` scoped nine retained prose selectors), **no `.notice-board__*` class is
queried from application JS.** Verified: `grep -rn "querySelector.*notice-board"` across all
non-test `.ts`/`.tsx` returns **zero** hits. The only consumers outside `app.css` are the test
files, which is §6.

---

## 5. Structural changes requiring authorization

Everything below changes DOM shape or ARIA, not just classes. Each is authorized by this plan;
nothing else is.

1. **§2.3** — the unread badge gains `role="status"` and an `sr-only` text label; the dot becomes
   `aria-hidden`.
2. **§2.4** — the post head splits into a meta group and an owner-actions group. The `<time>` loses
   `flex: 1 1 auto`.
3. **§2.1** — Edit/Delete become `buttonClasses("text")` buttons in a `justify-end` group.
4. **§2.6** — `.notice-board__error` becomes `<Notice tone="critical">`; it **keeps `role="alert"`**,
   which `Notice` does not inject, so it must be passed explicitly.
5. **§2.6** — `.notice-board__empty` becomes `<EmptyState>`.
6. **§2.4/§3** — `.notice-board__edit-target-changed` becomes `<Notice tone="caution">`; it
   **keeps `role="status"`**, passed explicitly.
7. **§2.7** — three `.button` sites become `buttonClasses`.

**ARIA that must NOT change:** `aria-expanded` / `aria-controls` on the toggle, `aria-hidden` on
the collapsed panel, `aria-live="polite"` on `.notice-board__posts`, `htmlFor`/`sr-only` on the
composer label, and `<time dateTime>` as a real `<time>`. The `presentation.anchorRef` placement
(on the posts container when empty, on the first post otherwise) is freshness logic and must
survive the refactor byte-for-byte.

---

## 6. The four test files are the real risk

`NoticeBoard.dom.test.tsx` (470), `NoticeBoard.freshness.dom.test.tsx` (702),
`Dashboard-notice-board.dom.test.tsx` (46) and `RichTextByteGuard.dom.test.tsx` (57) —
**1,275 lines of tests against 148 lines of component.**

They do select by class, and I counted rather than guessing: **48 `.notice-board__*` selector sites
across 6 distinct classes.**

| Class | Sites | File split |
|---|---|---|
| `.notice-board__post` | 14 | dom 21 / freshness 26 / byte-guard 1 total |
| `.notice-board__toggle` | 12 | " |
| `.notice-board__edit` | 12 | " |
| `.notice-board__edit-composer` | 4 | " |
| `.notice-board__delete` | 4 | " |
| `.notice-board__composer` | 3 | " |

`Dashboard-notice-board.dom.test.tsx` has **zero** — it is safe.

So retiring the block turns a green suite red by construction, and the builder must update these 48
sites as part of the slice that retires each class, not as a cleanup pass afterwards. Prefer
`data-slot` / role / accessible-name selectors over re-introducing a class purely to be selected.

The rule: **a test that asserts behaviour gets its selector updated; a test that asserts a
retired class is deleted only if the class was purely presentational.** Nothing may be deleted to
get to green — if a test fails for a real reason, that is a defect in the build, not in the test.

---

## 7. Acceptance criteria

Measured at 1440×900, 1024×768 and 390×844, on a board with at least one own-authored notice.

1. `Edit` and `Delete` each measure **≥44×44 at 390 and 720**, and ≥38px tall at 1440.
2. Timestamp, "edited", and the mention hint each measure **≥4.5:1** (expected 9.2:1).
3. Every other text site holds its current ratio or better — the eyebrow, summary, chevron, author,
   Edit and Delete already measure 9.2 / 9.2 / 9.2 / 19.8 / 9.2 / 10.0 and must not regress.
4. The `<time>` is **not** a full-width strut at 1440.
5. Zero horizontal overflow at all three widths; nothing inside the board overflows its own box.
6. Every focus ring visible and unclipped, including on the toggle, both owner actions, and both
   composer buttons.
7. `app.css:374-404` contains **zero** `.notice-board` selectors.
8. Unread state: the badge is exposed to AT via a real role. (Verified in local dev, where an unread
   state can be produced without writing to production.)
9. `npm run typecheck` 6/6, `npm run build -w @quincy/web`, and the full suite green — including
   `npx vitest run --config packages/shared/vitest.config.ts`.

---

## 8. Slicing

Three slices. This surface does not warrant more.

| Slice | Scope | Commit shape |
|---|---|---|
| **1** | Toggle (12 test sites), badge (§2.3), panel, posts container, empty state (§2.6). | `feat(tb8-08): slice 1 — the board shell, the unread badge and the empty state` |
| **2** | The post: head split (§2.4), meta on `META_TEXT` (§2.2), owner actions on `buttonClasses("text")` (§2.1), the changed-target notice (§5.6). | `feat(tb8-08): slice 2 — the post, its meta line and its owner actions` |
| **3** | Both composers, the error notice (§5.4), the three `.button` migrations (§2.7), and the full `app.css:374-404` retirement. | `feat(tb8-08): slice 3 — the composers, the error notice and the app.css retirement` |

Then: this session's visual gate, the §5 orchestration gate, merge, deploy on the owner's word.

---

## 9. Open questions for Sol

1. Is §2.3's `role="status"` + `sr-only` label the right call, or should the badge be folded into
   the toggle's own accessible name so it is announced when the control is reached rather than when
   it appears?
2. §2.4 removes the `flex: 1 1 auto` strut. Is there a reading in which that strut was load-bearing
   at some width I did not measure — the TB8-06 lesson was that a media query outside the range you
   read inverts your finding.
3. §6: is "update the selector, never delete the assertion" the right rule for 1,275 lines of test
   against a 148-line component, or does the ratio itself argue that some of those tests are
   asserting presentation and should go?
