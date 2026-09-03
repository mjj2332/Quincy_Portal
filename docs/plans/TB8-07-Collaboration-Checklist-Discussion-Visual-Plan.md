# TB8-07 — Collaboration, Checklist and Discussion: Visual Plan

**Status: APPROVED, NOT BUILT.** Ranking candidate **#7** in
`Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md` ("Collaboration/checklist/comments"). Branch
`tb8-07-collaboration-checklist`, cut from `main` at `e4f7ffc` (TB8-06 shipped).

Pipeline: `docs/Subagent-Frontend-Orchestration.md` — this session drafts the plan, Sol reviews
scope and correctness (≤2 rounds), Sonnet subagents build it in slices, this session holds the
visual gate. Per `Subagent-Orchestration.md` §1 the Opus plan-review touchpoints are skipped: this
session is Opus 5.

Drift-register anchor: **TB0-VIS-03** ("Collaboration and Notice Board" — *intentional evolution*,
compatibility checkpoints TB3/TB6/TB7). The register records the surface as accepted-and-verified
in *behaviour*; it makes no visual claim, and TB8 is where the visual claim gets made.

---

## 0. The visual gate

*Not run. This section is filled in by the orchestrating session after slice 8, before merge.*

---

## 0.5 What the two Sol review rounds changed

Sol returned **REVISE** with 14 blocking findings on the first draft. Every one was independently
re-verified against the repo by this session before being accepted (per
`docs/Subagent-Orchestration.md` — an agent's claims are unverified until checked). All 14 held.
They are recorded rather than quietly patched, because four of them were the draft being *wrong*,
not merely thin, and a plan that hides its own corrections teaches the next one nothing.

The four that were outright wrong:

1. **The inward focus rings could not have worked.** `tokens/base.css:25-28` sets
   `:focus-visible { outline: …; outline-offset: 2px }` **unlayered**, and the `outline` shorthand
   resets `outline-offset`. The draft specified ordinary `focus-visible:outline-offset-[-2px]`
   utilities, which lose to it silently — the exact defect `docs/lessons.md` records from TB8-06
   ("A shorthand always resets its longhands"). Every ring in this plan now carries `!`, in the
   idiom `ProjectKanbanBoard.tsx` already ships (§4.3).
2. **Retiring `rich-text__editor-content` would have broken the prose CSS this plan keeps.** The
   draft replaced the class outright with a utility string, but nine retained selectors
   (`app.css:410, 414-415, 421-423, 443-446`) are scoped *through* that class. It stays, alongside
   the utilities (§6.4).
3. **Retiring `.subtask-checklist__title-trigger` would have broken live focus restoration.**
   `SubtaskChecklist.tsx:216` does
   `itemRefs.current.get(nextFocusId)?.querySelector(".subtask-checklist__title-trigger")?.focus()`
   after a delete. The draft marked the class retired *and* promised focus management was
   untouched — those two cannot both be true. The class survives as a non-painting hook (§5.2).
4. **`<Eyebrow>` cannot replace `<time>`.** It is hard-coded to a `<span>`
   (`ui/eyebrow.tsx:5-14`), so the substitution would have dropped `dateTime`. It also carries
   `--tracking-widest`, and `--type-eyebrow` is **12px**, not the 11px the draft's §4.5 claimed
   (`typography.css:25, 67`). Timestamps keep `<time dateTime>` and take a new exported class
   string instead (§4.1).

Plus one where **Sol was right and this session was wrong about Tailwind itself**: the draft
warned that a bare `aria-current:` variant "generates nothing." Probed against the installed
Tailwind **4.3.3**, `aria-current:underline` compiles to `[aria-current="true"]` exactly as the
arbitrary form does. The warning is deleted; the arbitrary form is kept only because it is
explicit, not because the short form is broken.

The other nine were scope and rigor: retirement assigned to the wrong slice (§4.4, §11), an
overclaimed "byte-identical" invariant that the plan's own structural changes contradict (§9),
contrast targets computed against the wrong ground (§2.1), a square icon primitive that cannot
hold a date string (§4.1), under-specified buttons (§5-§7), a ledger with overlaps and gaps (§8),
directional responsive prose (§4.2, §5.2, §5.4), an understated Notice Board blast radius (§1.2),
and stale inventory counts (§1.1, §13).

### Round 2, and where the review stopped

Sol reviewed the revision and returned **REVISE** again — eight new blocking findings. That
exhausts `Subagent-Frontend-Orchestration.md` step 2's **two-round cap**, so resolution passed to
this session, which verified each finding, fixed all eight, and self-approves (§1 of
`Subagent-Orchestration.md`: this session is Opus 5, so the Opus touchpoint is not a separate
spawn).

Sol confirmed round 1's #1, #2, #3, #7, #12, #13 and #14 as fully fixed, and its round-2 report
independently reproduced the contrast figures, the inventory counts, the ring compilation, the
`display: contents` analysis and the Tiptap attachment point. What it found still wrong:

1. **The ledger arithmetic was wrong — 128 rules, not 86.** Re-counted mechanically: 28 / 21 / 43
   / 11 / 1 / 24 across slices 2-7, and 33 kept. The hand count had treated a one-line
   `@media (…) { .x { … } }` as two rules and mis-sized three ranges. The kept table also listed
   `410, 414-415, 421-423` as a row of its own when they are inside `408-427`. Both fixed in §8.
2. **The responsive pair left a one-pixel dead zone.** Compiled against Tailwind 4.3.3,
   `max-[720px]:` is `width < 720px` and `min-[721px]:` is `width >= 721px`, so **[720, 721)
   matched neither** and the subtask row would have had no `display` there. It also disproved this
   plan's own claim that `max-[721px]` matches *at* 721px — it compiles to a strict `<`. The pair
   is now `max-[721px]` / `min-[721px]`, which is exhaustive, non-overlapping, and the same
   breakpoint the existing primitives already use (§5.2).
3. **`META_TRIGGER` inherited `shrink-0` from the base**, so `max-w-full` was not the no-overflow
   guarantee §4.1 claimed — a long schedule string would have taken the row and refused to give it
   back. It now overrides with `shrink` (§4.1).
4. **The RTE disabled fill selected the wrong element.** `data-[disabled=true]:` was written as a
   self-selector on the ProseMirror element, but the state lives on the React root, which is the
   only element that can carry it. Now `group` on the root and `group-data-[disabled]:` on the
   content box (§6.4).
5. **§9a's authorized list was incomplete** — it missed the `<div className="ey">` → `<Eyebrow>`
   substitution, which changes a `<div>` to a `<span>` at four sites, and the RTE's own
   `<NativeSelect>`; and it said "six `data-*`" while listing five. Now ten changes, enumerated.
6. **The Actions-popover Delete button had no `RING_IN`**, so it would have rendered an outward
   ring inside an `overflow: auto` panel — the exact clipping §4.3 exists to prevent (§5.3).
7. **Slices 3 and 4 were not independently executable.** They share `ScheduleControl` and
   `AssigneeControl` through the `compact` prop, and they share two `app.css` rules (`:933`,
   `:963`). The previous revision's slice-3 range would have deleted the whole `@600` block,
   removing popover-action wrapping a slice before its replacement landed. §11a now draws the
   boundary explicitly.
8. **§6.2 still carried the old `<Eyebrow>` instruction** two lines above its own correction.
   Deleted.

Plus four non-blocking notes, all taken: the Tailwind-scanner explanation was narrower than
stated, `POPOVER_ACTIONS`' left alignment is deliberate and now says so, §6.3's option string is
written out instead of derived, and §4.6's retained-CSS comment now carries §1.3's accurate
two-renderer rationale rather than the "React does not author this" slogan that §1.3 itself
disproves.

**One defect this session caught on its own** while round 2 was running, and fixed in `5187bf2`:
the round-1 fix for the overflow finding put `text-ellipsis` on the `StatusPill`, which is
`inline-flex` — and `text-overflow` truncates a flex *item*, not a flex container's own overflow.
It would have clipped without an ellipsis. Truncation is now a three-part contract (§4.1).

---

## 1. Scope

### 1.1 In scope — six components, one screen (seven files)

| File | What it owns | Lines |
|---|---|---|
| `components/ProjectCollaborationPanel.tsx` | The overlay/standalone shell, the vertical toggle tab, the unread badge, the Discussion/Activity tab strip | 105 |
| `components/ProjectDiscussionThread.tsx` | The comment ledger, the composer, edit/delete actions, load-older | 219 |
| `components/SubtaskChecklist.tsx` | The checklist head/progress, rows, drag grip, three popovers (schedule, assignee, actions), the composer | 222 |
| `components/ProjectActivityView.tsx` | The activity ledger and its three states | 62 |
| `components/MentionAutocomplete.tsx` | The `@`-mention listbox | 58 |
| `components/RichTextEditor.tsx` | The editor **chrome** — toolbar, content box, counter, validation | 404 |
| `screens/ProjectWorkspace.tsx` (2 functions) | `CollaborationOnly`'s read-only summary card and `CollaborationOnlyUnavailable` | ~18 |

### 1.2 Out of scope, stated rather than assumed

- **The Notice Board's own surface** is candidate **#8** and is not touched. But this release
  reaches into it through two shared owners, and the blast radius is wider than "the composer":

  | What this release changes | Where the Notice Board feels it |
  |---|---|
  | `RichTextEditor` chrome (§6.4) | its **create** composer (`NoticeBoard.tsx:145`) **and** its **edit** composer (`:124`) — toolbar, content box, counter, validation, disabled state |
  | `MentionAutocomplete` (§6.3) | the mention popup inside both of those composers |
  | `.rich-text` prose tokens (§4.6) | **every rendered post** (`RichTextContent` at `:138`), not just composers — the line-height and the mention chip's radius |

  This is deliberate and is the correct call: `RichTextEditor`, `MentionAutocomplete` and the
  `.rich-text` block are each **one** styling owner with two consumers, and splitting any of them
  would create exactly the duplicated-owner problem the roadmap forbids. Candidate #8 inherits
  already-converged shared pieces.

  **The price is paid at the gate, not in the plan.** §10's walk covers the Notice Board's
  rendered posts, both composers, their disabled states, and the mention popup, at all three
  viewports — the same standard as the surfaces this release owns. The `.rich-text` edits are
  deliberately held to three token substitutions with no selector or structural change (§4.6) so
  that the rendered-post blast radius stays measurable rather than open-ended.
- **`AnchoredPopover`'s panel** (`components/AnchoredPopover.tsx`, `PANEL`) is TB8-02's, already
  converged, and is not re-litigated. This release only owns what goes *inside* the panel.
- **`confirm()` / `ConfirmDialog` / `Modal`** are TB8-02's. Untouched.
- **Behaviour.** No API call, query key, cache write, optimistic update, focus-management effect,
  drag sensor, keyboard handler, `aria-*` computation, or gating prop changes. Where a class list
  is the *only* thing that differs on a line, that must be the only thing that differs.
  §11's per-slice check is a `className`-stripped semantic diff against `main`.
- **`--text-muted`'s 41 remaining paint sites app-wide** (`TB8-10` D-05). This release fixes the
  sites *it owns* and leaves the rest to D-05, which is the right owner for a global sweep.

### 1.3 The one-owner decision for `.rich-text`

`.rich-text*` (app.css:407-450) splits cleanly in two, and the two halves get **different**
dispositions. This is the release's most important scope call, so it is stated before anything
else depends on it:

- **Editor chrome** — `.rich-text-editor`, `.rich-text__toolbar*`, `.rich-text__editor-content`,
  `.rich-text__counter`, `.rich-text__validation`. React authors every one of these elements.
  **Disposition: convert to Tailwind on the component; retire the CSS.**
- **Rendered prose** — `.rich-text` and its descendant selectors (`p`, `h2`, `h3`, `ul`, `ol`,
  `a`, `u`, `s`, `__task-*`, `__mention`), plus the ProseMirror-generated
  `.rich-text__editor-content ul[data-type="taskList"]` rules.
  **Disposition: keep as CSS, and normalise its off-token values (§4.6).**

  The reason, stated precisely because the obvious version of it is wrong: it is *not* true that
  React never authors this markup — `RichTextContent.tsx` emits `rich-text__task-list`,
  `rich-text__task-item`, `is-checked`, `rich-text__task-indicator`, `rich-text__task-content`
  and `rich-text__mention` itself. The real reason is that **one stored document is rendered by
  two different renderers that must produce identical output**: `RichTextContent` (React, in the
  thread) and Tiptap/ProseMirror (in the composer). The majority of the block's selectors target
  **bare tags** — `p`, `h2`, `h3`, `ul`, `ol`, `li`, `a`, `u`, `s` — which `RichTextContent`
  emits with no `className` at all (`block()` and `marked()` return `<p>`, `<h2>`, `<li>`,
  `<strong>`…) and which ProseMirror emits from its own schema. Neither renderer has an element to
  hang a utility on without threading a class through every node type in both, twice, and keeping
  the two in sync forever. One CSS block is what guarantees a comment looks the same after it is
  posted as it did while it was being written. This is the roadmap's "specialized CSS remains
  where evidence shows it is clearer."

---

## 2. What is actually wrong — measured, not asserted

Every contrast figure below was computed from the token hex values in
`styles/tokens/colors.css` (WCAG 2.x relative luminance). Alpha composites were flattened against
their real ground before measuring. The script is reproducible from the token values alone.

**The grounds, established first, because the redesign moves several of them.** §3 deletes the
white `--paper-000` card each comment and each subtask row sits on today. What is underneath is
the panel: `.project-collaboration` sets `background: var(--paper-050)` (`app.css:845`) and
`--standalone` does not override it, so **both** panel modes are `--paper-050`, and a hovered row
or comment is `bg-secondary` = `--paper-100`. `AnchoredPopover`'s `PANEL` is `bg-popover` =
`--bg-surface` = `--paper-000` (`AnchoredPopover.tsx:36`), and so is the mention listbox. The
"After" column below is measured against **those** grounds, not against the card that is being
removed — the first draft got this wrong on five rows.

| Site | Paint today | Ratio | Bar | After (ground) |
|---|---|---|---|---|
| Comment `<time>`, `<small>Edited</small>` (app.css:857) | `--text-muted` on `--paper-000` | **3.57** | 4.5 | `--text-secondary` on `--paper-050`, **8.66** |
| `.mention-autocomplete__option small` (:462) | `--text-muted` on `--bg-surface` | **3.57** | 4.5 | on `--paper-000`, **9.20** |
| `.mention-autocomplete__status` (:463) | `--text-muted` on `--bg-surface` | **3.57** | 4.5 | on `--paper-000`, **9.20** |
| `.subtask-popover__member small` (:952) | `--text-muted` on `--bg-surface` | **3.57** | 4.5 | on `--paper-000`, **9.20** |
| Done subtask title (:906) | `--text-muted` on `--paper-000` | **3.57** | 4.5 | on `--paper-050`, **8.66**; hovered `--paper-100`, **8.09** |
| Idle collaboration tab (:873) | `--text-muted` on `--paper-050` | **3.36** | 4.5 | `TAB_IDLE` on `--paper-050`, **8.66** |
| `.rich-text__toolbar-button:disabled` (:437) | `--text-muted` on `--paper-000` | **3.57** | 4.5 | `--text-secondary` on `--bg-sunken`, **7.40** |
| `.rich-text__toolbar-select:disabled` (:440) | `--text-muted` on `--paper-000` | **3.57** | 4.5 | `FIELD_BOX` disabled on `--bg-sunken`, **7.40** |
| `.rich-text__counter` (:448) | `--text-muted` on `--paper-050` | **3.36** | 4.5 | on `--paper-050`, **8.66** |
| RTE placeholder (:447) | `--text-muted` on `--paper-050` | **3.36** | 4.5 | on `--paper-050`, **8.66** |
| `.empty` in `ProjectActivityView` (:638) | `--text-muted` on `--paper-050` | **3.36** | 4.5 | `EmptyState` on `--paper-050`, **8.66** |
| Disabled drag grip (:913) | `--text-secondary` **× `opacity:.5`** | **2.51** | 3.0 | `--text-secondary` on `--bg-sunken`, **7.40**, no opacity |
| `.subtask-checklist__overflow` (:918) | `--text-secondary` **× `opacity:.72`** | **4.21** | 4.5 | on `--paper-050`, **8.66**; hovered `--paper-100`, **8.09** |

The disabled-grip row is **the same defect TB8-06 fixed on the Kanban board's disabled drag
handle**, in a different file — an opacity multiplier stacked on an already-quiet colour.

**How the disabled state is differentiated, since the opacity goes.** Not by dimming the colour:
`--text-muted` on the hovered row's `--paper-100` is only **3.13:1**, which clears the 3:1
graphical bar by a margin too thin to defend. Instead the disabled control keeps
`--text-secondary` and takes a **`--bg-sunken` chip** — 7.40:1, and the affordance difference is
carried by the recessed background. That is TB8-06's *other* precedent, the one it used for the
disabled arrow ("differentiated by background, as the original rule did"), and it is the stronger
of the two. §4.1 encodes it once.

**And the RTE root `opacity: .65` goes with it** (`app.css:429`). A group opacity multiplies every
child's measured contrast, so no per-child "After" figure in this table survives it. The disabled
editor is instead expressed by its children's own disabled treatments — toolbar buttons and select
via `ICON_BUTTON`/`FIELD_BOX`, and the content box via an explicit `--bg-sunken` fill (§6.4).

### 2.2 `.subtask-checklist__metadata-trigger { opacity: .06 }` — 1.10:1, and no touch equivalent

app.css:914. The schedule and assignee triggers on an **unset** subtask render at 6% opacity —
`1.10:1`, indistinguishable from the row background — and are revealed only by
`:hover` / `:focus-within` (`:916`). A phone has no hover. On a 390px viewport there is therefore
**no visible affordance to schedule or assign a subtask at all**; a sighted touch user has to
guess that an invisible 24px target exists at a specific point in the row.

This is not a contrast nit, it is a missing control. §5.2 removes the hover-reveal mechanic
entirely rather than tuning its opacity.

### 2.3 Touch targets below 44px at ≤720px

TB8-01 through TB8-06 established 44px at `≤721px` for every interactive element
(`buttonClasses` BASE, `FIELD_BOX`, `TAB_BASE`, `CHECKBOX_INPUT`'s `TOGGLE_ROW`). This surface
predates it, and a subtask row is a phone control.

| Control | Computed height today |
|---|---|
| `.subtask-checklist__grip` (:911) | ~22px (`padding: 2px 3px`, `font: 18px/1`) |
| `.subtask-checklist__overflow` (:918) | ~24px (`padding: 2px 6px`, `font: 20px/1`) |
| `.subtask-checklist__metadata-trigger` (:914) | 24px (declared `min-height: 24px`) |
| `.subtask-checklist__done` native checkbox (:907) | UA default, ~13-16px |
| `.subtask-checklist__add-button` (:956) | ~30px (`padding: 7px 8px`, 12px text) |
| `.project-collaboration__comment-actions .button` (:859) | **30px — a legacy override that beats `buttonClasses`' 44px** |

Five 44px targets will not fit on one 390px row beside a title. §5.3 answers that with a
two-line row at ≤720px, not by shrinking the targets.

### 2.4 `--signal-warning` does not exist

app.css:931 — `.subtask-schedule__conflict { color: var(--signal-warning); }`. Grepped across
`apps/web/src`: **the token is defined nowhere.** The declaration is therefore invalid at
computed-value time, and because `color` is inherited, the property falls back to **inherit** — not
to the `--signal-critical` set one line above at `:930`. The schedule-conflict block, which exists
to warn that someone else's edit landed first, renders as **ordinary ink body text**, visually
identical to the rest of the popover.

Same class as `TB8-10` D-04 (a token reached through a `var()` fallback rather than defined), but
worse: D-04 renders correctly by accident, this one renders wrongly. Fix: `--signal-caution-text`
(**6.65:1** on `--paper-000`), which is the token the split in `colors.css` created for exactly
this "caution as text" case.

### 2.5 `.project-collaboration--unavailable` inherits a fixed-position overlay

`ProjectWorkspace.tsx:338` renders
`<section className="project-collaboration project-collaboration--unavailable">` on the
**standalone** `/collaboration` page. `--unavailable` has no rule of its own anywhere in
`app.css`, so the element takes all of `.project-collaboration` (:845): `position: fixed`,
`z-index: 70`, `width: min(460px, …)`, `box-shadow: var(--shadow-lg)`, and
`top/bottom/max-height` set from `--project-collaboration-*` custom properties.

Those custom properties are declared on `.project-collaboration__wrap` (:842), **which is not an
ancestor here** — the standalone page never renders the wrap. So `top`, `bottom` and `max-height`
are each invalid at computed-value time and fall back to `auto`/`none`. The result is a
460px-wide, hard-shadowed, `z-index: 70` fixed panel floating over the page, on the one screen
whose entire job is to say "this discussion is no longer available."

Fix in §7.3: the unavailable state stops borrowing `.project-collaboration` and gets its own
static treatment.

### 2.6 Off-scale type — nine sizes the scale does not contain

`--text-2xs` is the floor at 11px. This surface paints below it and between steps:

| Value | Sites |
|---|---|
| **9px** | `.project-collaboration__unread` (:844), `.subtask-checklist__assignee` (:910) |
| **10px** | comment `time`/`small` (:857), `.project-collaboration__toggle` (:843), `.subtask-checklist__due` (:909), `.subtask-schedule__endpoint legend` (:926), `.subtask-schedule__fold legend` (:928), `.project-collaboration__comment-actions .button` (:859) |
| **12px** | eleven sites — legal (`--text-xs`) but written as a literal, not the token |
| **13px** | `.project-collaboration__state` (:851), `.project-collaboration__comment header strong` (:856) |
| **17px** | `.subtask-checklist__progress-text` (:893) — overriding `--type-h3`'s 28px |
| **24px / 25px** | `.project-collaboration-summary h2` (:864) / `.project-collaboration__head h2` (:849) — both overriding `--type-h3`'s 28px with an off-scale literal |
| **1.55** | `.rich-text` line-height (:408) — the scale has 1.5 (`--leading-normal`) |

§4.5 maps every one onto a token.

### 2.7 `.statetag` is a photo-overlay chip reused as an inline text badge

`ProjectDiscussionThread.tsx` marks an external editor's comment with `<span class="statetag">`.
`.statetag` (:178) is `color: #fff; background: rgba(20,20,21,.6); backdrop-filter: blur(6px)` —
built to sit legibly on top of a **photograph** in the media grid (`.statetags`, :177, is
`position: absolute` inside a thumbnail). Inline in a comment header there is no photograph, so a
translucent smoked-glass chip is painting over warm paper for no reason, and the `backdrop-filter`
is a compositing layer doing nothing.

Fix: `StatusPill tone="info"`, the converged badge.

### 2.8 Three levels of box

The panel is bordered (`:845`); each comment inside it is bordered (`:854`); each subtask row
inside it is bordered (`:901`); the composer inside *that* is bordered (`:441`). Four nested
1px rectangles in a 460px column. The design system's own statement is
*"structure comes from rules and negative space, not from elevation"* — a rule is a line, not a
box. §3 answers this.

---

## 3. Design direction — "the ledger"

**One sentence:** collaboration on a shoot is a *running record* — who said what, what is still
open, what changed — so the surface is set as a **ledger with a margin**, not a stack of cards.

The device is a **left rule**. Every entry in the panel — a comment, an activity event — hangs off
a hairline that runs down its left edge, with its attribution set as an eyebrow above the content.
Nothing is boxed. Vertical space does the separating that four nested borders were doing badly.

**The one place boldness is spent:** a comment **you** wrote takes a `--border-width-rule` (3px)
**ink** left rule instead of the hairline. That is the design system's editorial "rule" — the same
3px ink line that sits under every `SectionHead` in the app — used here to make your own voice
findable when you scroll a long thread. It encodes something true (authorship, which also governs
who may edit or delete — annotation and comment edits are author-only), it costs one border-width
swap, and it is the only inked element in the thread.

Everything else stays quiet and disciplined:

- **Checklist** reads as a list: rows separated by a hairline *between* them, `last:` unruled. No
  row boxes.
- **Type** does the hierarchy. Author names and subtask titles in `--font-sans` at `--text-sm`;
  every timestamp, role, state and count in `--type-eyebrow`, uppercase, `--tracking-wide`. The
  panel head keeps `--type-h3` in Mazius — the one display face on the surface.
- **Elevation** stays flat everywhere except the two sanctioned overlays (the fixed collaboration
  panel and `AnchoredPopover`), exactly as TB8-06 left the board.
- **No new colour.** The palette here is ink, paper, the greige ramp, and the four signals already
  in `colors.css`.

**What this is not:** it is not a repaint of the same layout with different hex values, and it is
not an invention. The left rule, the eyebrow attribution, the hairline separator and the 3px ink
rule are all already in `tokens/spacing.css` and shipped on other Quincy surfaces; this release
puts them where four nested boxes are today.

### 3.1 Rejected alternative, recorded

**Avatars on comments.** The obvious "make the thread feel modern" move is a circular avatar
gutter. Rejected: this is a closed studio system where every participant is one of a handful of
named staff, `initials()` already exists and is used on the checklist assignee chip, and a column
of 32px ink circles down a 460px panel would be the single loudest thing on a surface whose
brief is discipline. The eyebrow attribution carries the same information in 11px of type.

---

## 4. Shared work — primitives and tokens

### 4.1 New primitives: `components/ui/icon-button.tsx` and one exported meta-text class

The surface has **four** interactive icon affordances — the drag grip, the overflow `⋯`, the
schedule trigger and the assignee trigger — with four different hand-rolled treatments, three of
them contrast failures. (The chevron is a non-interactive `<span>` inside the checklist toggle and
is **not** one of them; it is styled inline in §5.1.) `buttonClasses("text")` does not fit — these
are glyph targets, not text buttons. The app has a legacy `.icbtn` (`app.css:77-87`) with the
right *idea* and no Tailwind equivalent.

Two of the four are **not square**: `ScheduleControl` and `AssigneeControl` render a
`StatusPill`-shaped value inside the trigger when one is set (`SubtaskChecklist.tsx:101, :130` —
`formatSchedule()` can return a full date, a timestamp, or a range). A primitive that fixes both
dimensions would overflow at 390px. So the file exports **two** treatments off one base.

```tsx
// components/ui/icon-button.tsx
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Shared geometry and states for a glyph affordance: drag grips, overflow menus,
 * popover triggers. Not `buttonClasses("text")` — that is a text control with a
 * text baseline. 28px desktop / 44px at <=720px (44px touch target — WCAG 2.5.5
 * Enhanced / HIG, not a spacing token).
 *
 * Colour is NEVER dimmed by opacity to express disabled: a group opacity on an
 * already-quiet colour is what took the Kanban board's disabled handle to 1.72:1
 * (TB8-06) and this surface's drag grip to 2.51:1 (TB8-07 §2.1). The recessed
 * `--bg-sunken` chip carries it instead, at 7.40:1.
 */
const ICON_BUTTON_BASE =
  "inline-grid place-items-center shrink-0 p-0 m-0 " +
  "min-h-[28px] min-w-[28px] max-[721px]:min-h-[44px] max-[721px]:min-w-[44px] " +
  "bg-transparent border-0 rounded-[var(--radius-sm)] " +
  "text-foreground-secondary cursor-pointer " +
  "[font:var(--weight-regular)_var(--text-md)/1_var(--font-sans)] " +
  "transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "hover:not-disabled:bg-secondary " +
  // Important, not decorative: `tokens/base.css`'s unlayered
  // `:focus-visible { outline: … }` shorthand resets `outline-offset` (§4.3).
  "focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)] " +
  "focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-2 " +
  "disabled:bg-surface-sunken disabled:cursor-not-allowed " +
  "aria-disabled:bg-surface-sunken aria-disabled:cursor-default";

/** Square, glyph-only: the drag grip and the overflow menu. */
const ICON_BUTTON = ICON_BUTTON_BASE + " w-[28px] max-[721px]:w-[44px]";

/**
 * Variable width: a popover trigger that shows a glyph when empty and a value
 * chip when set (schedule, assignee). `min-w` keeps the empty state on the same
 * 28/44 grid as `ICON_BUTTON`; `max-w-full` plus the pill overrides keep a long
 * date range from overflowing a 390px row.
 */
const META_TRIGGER = ICON_BUTTON_BASE +
  // `shrink` overrides the base's `shrink-0`. Without it `max-w-full` is not a
  // no-overflow guarantee: a long schedule string would take the full row width
  // and refuse to give any back, pushing the assignee and overflow controls out
  // of a 390px row. `min-w-[28px]/[44px]` from the base still floors the target.
  " shrink w-auto max-w-full min-w-0 overflow-hidden px-[var(--space-1)] " +
  // The pill is `inline-flex` (`ui/status-pill.tsx`), and `text-overflow` does not
  // apply to a flex container's own overflow — it truncates a flex *item*. So the
  // pill gets `min-w-0` and the value text inside it is wrapped in a `truncate`
  // span at the call site. Do not put `text-ellipsis` on the pill itself; it is
  // silently inert there.
  "[&>[data-slot=status-pill]]:min-w-0 [&>[data-slot=status-pill]]:max-w-full";

function IconButton({ className, ...props }: React.ComponentProps<"button">) {
  return <button type="button" data-slot="icon-button" className={cn(ICON_BUTTON, className)} {...props} />;
}

export { IconButton, ICON_BUTTON, ICON_BUTTON_BASE, META_TRIGGER };
```

Notes the builder must not "clean up":

- Both `disabled:` and `aria-disabled:` are needed. The drag grip is disabled via
  `aria-disabled` (dnd-kit keeps it focusable); the popover triggers use the real attribute.
  Both are Tailwind v4 built-in variants — verified against the installed 4.3.3.
- The disabled state sets **background only**. `text-foreground-secondary` from the base is
  inherited unchanged, which is what produces §2.1's 7.40:1.
- `min-h/min-w` on the base and `w-` on the two variants, rather than `size-`, is what lets
  `META_TRIGGER` grow while `ICON_BUTTON` stays square. Do not collapse them back to `size-`.
- **The truncation is a three-part contract and all three parts are required**: `overflow-hidden`
  + `min-w-0` on the trigger, `min-w-0` on the pill, and `truncate` (`overflow-hidden`
  `text-ellipsis` `whitespace-nowrap`) on a `<span>` **inside** the pill wrapping the schedule
  text. `text-ellipsis` on the pill alone does nothing — the pill is an `inline-flex` container,
  and `text-overflow` truncates flex *items*, not a flex container's own overflow. §5.2's due-pill
  row spells out the call-site markup.
- 28px (not 24px) is the smallest square that clears the 3:1 target-size guidance with the
  existing 18px glyphs and still fits four controls beside a title on a 1440px row.

### 4.1a `META_TEXT` — the attribution/timestamp treatment

Timestamps, actor names, "Edited", role labels and the mention hint all want an eyebrow's
*typography* on an element that is **not** a `<span>` — `<time dateTime>` above all, which must
keep both its element and its attribute (§9). `Eyebrow` is hard-coded to a `<span>`
(`ui/eyebrow.tsx:5-14`), so it cannot be used for them, and it carries `--tracking-widest`
(0.22em), which is a section-label tracking, too loose for a timestamp.

Export a class string from the same file, beside the component:

```tsx
// components/ui/eyebrow.tsx — added export
/** Eyebrow typography for elements that are not <span>: <time>, <small>, <strong>. */
const META_TEXT =
  "[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";
```

`--type-eyebrow` is `var(--weight-regular) var(--text-xs)/1.2 var(--font-sans)` — **12px**
(`typography.css:25, 67`). Every "eyebrow" size figure in this plan is 12px; an earlier draft said
11px and was wrong (§0.5). The `<Eyebrow>` *component* is still used, unchanged, for real section
labels: "Collaboration", "Checklist", "Read-only summary", "Photographers", "Editors".

### 4.2 New shared constants in `components/AnchoredPopover.tsx`

Three popovers and the checklist composer all lay out "a stack of labelled controls, then a
right-aligned action row." Export them beside `PANEL` so there is one owner:

```tsx
/** The content stack inside a `PANEL`. Padding lives here, not on the panel. */
export const POPOVER_CONTENT = "grid gap-[var(--space-2)] p-[var(--space-3)] min-w-0";

/** A labelled control inside `POPOVER_CONTENT`. */
export const POPOVER_LABEL =
  "grid gap-[var(--space-1)] min-w-0 " +
  "[font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground-secondary";

/**
 * The action row that closes a popover or a composer.
 *
 * Deliberately NOT `justify-end`. Both consumers align by content, not by the
 * container: the checklist composer pushes its buttons right with an existing
 * `<span className="flex-1" />` spacer (which `max-[601px]:hidden` collapses),
 * and the schedule popover's actions are left-aligned under a left-aligned form.
 * Adding `justify-end` here would fight the spacer.
 *
 * Wrapping starts at <=600px only — that is where `app.css:958-965` puts it today
 * and this release preserves the breakpoint rather than folding it into the app's
 * usual 721px (§5.4).
 */
export const POPOVER_ACTIONS =
  "flex items-center gap-[var(--space-2)] min-w-0 max-[601px]:flex-wrap";
```

`POPOVER_LABEL` replaces `.subtask-popover__content label` (:924), whose 11px un-uppercased grey
label is the only field label in the app that is not `FieldLabel`'s eyebrow.

### 4.3 Focus rings — every one of them is `!`-prefixed

`app.css:892` exists because popover contents sit flush inside a bordered, `overflow: auto` panel,
so an outward ring is clipped. That fact has not changed. What the first draft missed is *why an
ordinary utility cannot express the fix*:

`tokens/base.css:25-28` declares, **unlayered**:

```css
:focus-visible {
  outline: var(--border-width-bold) solid var(--focus-ring);
  outline-offset: 2px;
}
```

Unlayered author CSS beats `@layer utilities` regardless of specificity (§4.4), **and** the
`outline` shorthand resets `outline-offset`. So a plain `focus-visible:outline-offset-[-2px]`
loses twice over and the ring silently renders outward, clipped. This is the defect
`docs/lessons.md` records under "A shorthand always resets its longhands" — TB8-06 hit it on all
six of the board's rings.

**The idiom, exactly as `ProjectKanbanBoard.tsx:220-230` already ships it.** Write all four
utilities; writing only the offset does not work.

```
/* outward — the default for anything not inside an AnchoredPopover */
focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)]
focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-2

/* inward — every control inside an AnchoredPopover */
focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)]
focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-[-2px]
```

Below, these two strings are referred to as **`RING_OUT`** and **`RING_IN`**.

**`RING_IN` is a real export** — slice 1 put it in `components/AnchoredPopover.tsx` beside
`PANEL`, because it is used at roughly a dozen popover-internal controls and repeating four
`!`-prefixed utilities that many times is how one of them ends up subtly different. Import it.

**`RING_OUT` is not an export**; write those four utilities out at the sites that need them. It is
deliberately not centralised: the existing primitives (`buttonClasses`, `FIELD_BOX`, `TAB_BASE`,
`CHECKBOX_INPUT`) already carry their own non-important outward rings that happen to match the
base rule exactly, so they need no change and this release does not widen scope to edit them.
`RING_OUT` is therefore only written where this plan specifies a *new* class string — the
checklist toggle, the title trigger, the add-item button. `RING_IN` goes on **every**
popover-internal control without exception.

### 4.4 The unlayered-`app.css` trap

`styles/index.css` imports `app.css` **outside** every `@layer`, so any surviving legacy rule
beats a Tailwind utility regardless of specificity. Consequence for this release, stated as a
rule the builder follows without thinking:

> A class is either **retired from `app.css` in the same slice that stops using it**, or it is
> **kept as a non-styling hook only**. There is no third state. A component may not carry both a
> legacy class that still paints and the Tailwind utilities meant to replace it — not even for
> one slice.

**This is a slicing constraint, not just a style note, and the first draft got the slicing
wrong.** It put every `app.css` deletion in slice 8. That would leave slices 2-7 each shipping a
component whose new utilities are dead on arrival, overridden by the legacy rule still sitting
unlayered in `app.css` — and each of those slices would end "green" on `typecheck` and `build`
while rendering the old design. TB8-06 hit exactly this and made deletion same-slice.

So: **each of slices 2-7 owns the `app.css` removals for the selectors it stops using**, listed
per slice in §11. Slice 8 no longer performs the retirement; it *audits* it against §8's ledger,
adds the survivors' justifying comments, and owns the tests and docs.

Where a class must survive as a test hook or a CSS-side selector target, it is converted to a
`data-*` attribute instead — the convention TB8-06 established (`data-*` conversions in its
slices 3 and 6). Named per site below. Two classes survive as **plain hooks** rather than
`data-*`, each for a stated reason: `.subtask-checklist__title-trigger` (§5.2) and
`.rich-text__editor-content` (§6.4).

### 4.5 Off-scale type → tokens (§2.6's answer)

| Was | Becomes | Note |
|---|---|---|
| 9px | `--text-2xs` (11px) | unread badge grows 18px → 20px to fit; assignee chip stays 24px (two initials at 11px ≈ 14px wide) |
| 10px | `--text-2xs` (11px) for the two chips (`__unread`, `__assignee`); `META_TEXT`'s `--type-eyebrow` (**12px**) for every attribution/timestamp/label; `--text-xs` (12px) for body | per site below. **12px, not 11px** — `--type-eyebrow` resolves through `--text-xs` (`typography.css:25, 67`); the first draft said 11px and was wrong (§0.5) |
| 12px literal | `--text-xs` | |
| 13px | `--text-sm` (14px) | |
| 13.5px (`.member`, :779) | untouched — shared global, D-05's | |
| 17px | `--type-h3` (28px), unmodified | the progress readout is the checklist's headline; see §5.1 |
| 24px / 25px | `--type-h3` (28px), unmodified | |
| `line-height: 1.55` | `var(--leading-normal)` (1.5) | |
| `border-radius: 3px` (mention chip, :427) | `var(--radius-xs)` (2px) | |
| `min-height: 68px` (RTE content, :441) | `min-h-[var(--space-8)]` (64px) | on the 4px grid |
| `min-width: 29px` (toolbar button, :433) | `size-[28px]` via `ICON_BUTTON` | |

### 4.6 `.rich-text` prose — the three token edits, and nothing else

The kept-as-CSS half of §1.3 gets exactly these changes. **No selector is added, removed or
restructured** — the Notice Board renders through these same rules and this release is not its
owner.

| Line | Was | Becomes |
|---|---|---|
| 408 | `font-size: 14px; line-height: 1.55` | `font-size: var(--text-sm); line-height: var(--leading-normal)` |
| 427 | `border-radius: 3px` | `border-radius: var(--radius-xs)` |
| 417 | `font-size: 11px` | `font-size: var(--text-2xs)` |

A comment above the block records that it is deliberately retained CSS and why — using §1.3's
accurate two-renderer rationale (**one stored document, two renderers that must agree, and mostly
bare tags with no element to hang a utility on**), *not* the inaccurate short version that "React
does not author this markup": `RichTextContent.tsx` demonstrably does author part of it. The next
sweep should inherit the real reason, not a slogan that a five-minute grep disproves.

---

## 5. `SubtaskChecklist` — the checklist

### 5.1 Head, progress and panel

```
┌──────────────────────────────────────────────┐
│ CHECKLIST            4 of 7 complete · 57% − │   <- one <button>, full width
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │   <- <progress>, 5px, ink
└──────────────────────────────────────────────┘
```

The toggle is one button holding an eyebrow, the progress readout, a chevron, and the progress
bar spanning both columns. That structure is right and is preserved verbatim; only paint changes.

| Element | Classes |
|---|---|
| `<section>` | `grid gap-[var(--space-3)] pb-[var(--space-4)] [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border` |
| `<h3>` | `m-0` |
| toggle `<button>` | `grid grid-cols-[minmax(0,1fr)_auto] w-full gap-x-[var(--space-3)] gap-y-[var(--space-1)] p-[var(--space-2)] min-h-[38px] max-[721px]:min-h-[44px] bg-transparent border-0 text-left cursor-pointer text-foreground transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:bg-secondary` + `RING_OUT` |
| eyebrow span | `<Eyebrow>` (replaces `className="ey"`) |
| `__toggle-meta` | `flex items-center justify-end gap-[var(--space-2)]` |
| `__progress-text` | `[font:var(--type-h3)] tracking-[var(--tracking-tight)] text-foreground` |
| `__chevron` | a non-interactive `<span>`, so **not** an `IconButton`: `[font:var(--weight-regular)_var(--text-md)/1_var(--font-sans)] text-foreground-secondary` |
| `<progress>` | `col-span-full w-full h-[5px] [accent-color:var(--accent)]` |
| `__notice` | `min-h-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-destructive` — `aria-live="polite"` kept |
| `__panel` | `grid gap-[var(--space-3)]`, collapsed → the **`hidden` utility class**, never the `hidden` attribute — see the note below the table |

**§2.6's 17px:** `.subtask-checklist__progress-text` currently overrides `--type-h3` down to 17px,
which makes "4 of 7 complete · 57%" the same weight as body text. It is the one number that says
whether the shoot is on track, and the full 28px Mazius is what the surface should lead with.
Restored to unmodified `--type-h3`. **This is a deliberate visual change, not a token
normalisation** — the gate must confirm it does not crowd the chevron at 390px (`--type-h3` at 28px
against a 44px chevron in a `minmax(0,1fr) auto` grid: it wraps to two lines before it collides,
which is acceptable and is why `gap-y-[var(--space-1)]` exists).

**`is-collapsed` → the `hidden` *utility class*, not the `hidden` attribute.** The collapsed
state stays a class swap — `className={cn("grid gap-[var(--space-3)]", !open && "hidden")}` —
because adding a real `hidden` attribute where there is none today
(`SubtaskChecklist.tsx:221` has only the class and `aria-hidden`) would be an ARIA/DOM change this
release has no business making. `aria-hidden={!open}`, `id`, and the toggle's
`aria-controls`/`aria-expanded` are all unchanged.

### 5.2 The row — and the end of hover-reveal

```
1440 / 1024                                  390 (two lines)
┌────────────────────────────────────────┐   ┌──────────────────────┐
│ ⠿ ☐ Confirm drone permit  ◷ ♙ ⋯       │   │ ⠿  ☐  Confirm drone   │
├────────────────────────────────────────┤   │       permit          │
│ ⠿ ☑ Book stylist        14 Mar JK ⋯   │   │    ◷    ♙    ⋯       │
└────────────────────────────────────────┘   ├──────────────────────┤
  hairline between rows, none after the last  each control 44×44
```

`SortableSubtaskRow`'s `<article>`:

```
grid gap-[var(--space-2)] py-[var(--space-2)] -mx-[var(--space-2)] px-[var(--space-2)]
[border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border
last:border-b-0
transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)]
hover:bg-secondary focus-within:bg-secondary
```

The negative inline margin lets the hover wash reach the panel gutter, so a row reads as a full-
width band rather than an inset block. `--dragging` becomes
`data-dragging` → `data-[dragging=true]:opacity-45 data-[dragging=true]:shadow-[var(--shadow-sm)]`
(a drag preview is the sanctioned elevation exception, as on the board).
`--done` becomes `data-done`; `--popover-open` becomes `data-popover-open`. All three are
`data-*` per §4.4 — the class strings are gone from `app.css` and the DOM tests key off the
attributes.

`__summary` and the meta wrapper — written as **mutually exclusive** breakpoint variants so that
Tailwind's emission order cannot decide the outcome. No bare `flex` or `grid` appears in either
string; every `display` declaration is inside a variant, and the two variants never both match.
(`docs/lessons.md`, "Tailwind's emission order is not your class order" — the first draft told the
builder to test the order and improvise a fallback, which is not a specification.)

```
/* summary container */
min-w-0
max-[721px]:grid max-[721px]:grid-cols-[auto_auto_minmax(0,1fr)]
max-[721px]:items-center max-[721px]:gap-[var(--space-2)]
min-[721px]:flex min-[721px]:items-center min-[721px]:gap-[var(--space-2)]

/* meta wrapper — a plain <div> with no ARIA, holding schedule + assignee + overflow */
min-w-0
max-[721px]:col-span-full max-[721px]:flex max-[721px]:items-center
max-[721px]:gap-[var(--space-1)] max-[721px]:pt-[var(--space-1)]
min-[721px]:contents
```

At ≥721px the wrapper is `display: contents`, so the three controls are direct flex children of
the summary row and the layout is byte-for-byte the single line it is today. At ≤720px it becomes
its own full-width row beneath the title, which is what gives the three controls their 44px.

**The wrapper `<div>` is a new element.** It is one of §9a's ten authorized structural changes;
it carries no `role`, no `aria-*`, no `id`, and does not sit between a label and its control.

**The breakpoint pair is `max-[721px]` / `min-[721px]`, and it must be that pair.** Compiled
directly against the installed Tailwind 4.3.3:

| Utility | Compiles to |
|---|---|
| `max-[721px]:…` | `@media (width < 721px)` |
| `min-[721px]:…` | `@media (width >= 721px)` |
| `max-[720px]:…` | `@media (width < 720px)` |

`max-[721px]` / `min-[721px]` is **exhaustive and non-overlapping** — every width matches exactly
one. The revision's first attempt used `max-[720px]` / `min-[721px]`, which leaves the interval
**[720px, 721px) matching neither**, so the row would have had no `display` at all there. (It also
claimed `max-[721px]` matches *at* 721px; it does not — the compiled query is strictly `<`.)
Using `max-[721px]` additionally aligns this pair with the breakpoint `buttonClasses`,
`FIELD_BOX`, `TAB_BASE` and `CHECKBOX_INPUT` already use internally, so the whole surface changes
layout at one width.

| Control | Treatment |
|---|---|
| grip | `<IconButton>` (square) + `cursor-grab active:cursor-grabbing`. **`opacity: .5` deleted**; disabled is the `--bg-sunken` chip from `ICON_BUTTON_BASE`, **7.40:1** (§2.1). |
| done checkbox | `<label>` wrapping `<Checkbox>` (`CHECKBOX_INPUT`, 18px, `accent-[var(--accent)]`) — `grid place-items-center min-h-[28px] max-[721px]:min-h-[44px] max-[721px]:min-w-[44px] cursor-pointer`. The `sr-only` "Mark X complete" span is unchanged. |
| title (read) | **keeps `subtask-checklist__title-trigger` as a non-painting hook** (see below), plus `flex-1 min-w-0 p-0 border-0 bg-transparent text-left cursor-pointer [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground [overflow-wrap:anywhere] min-h-[28px] max-[721px]:min-h-[44px]` + `RING_OUT`; done → `text-foreground-secondary line-through` (**8.66:1**, was 3.57) |
| title (editing) | `<Input className="flex-1 min-w-0">` — retires the hand-rolled box at `:908` |
| schedule / assignee triggers | `<button className={cn(META_TRIGGER, …)}>` — **`META_TRIGGER`, not `ICON_BUTTON`** (§4.1): each holds a value chip when set, and a fixed square would overflow at 390px. **Always visible.** |
| due pill | `<StatusPill tone="neutral" className="min-w-0"><span className="sr-only">Schedule </span><span className="block truncate min-w-0">{formatSchedule(value)}</span></StatusPill>` — retires `.subtask-checklist__due` (`:909`). The inner `truncate` span is the third part of §4.1's truncation contract, not optional. The existing `sr-only` "Schedule " prefix is kept verbatim and stays **outside** the truncating span so it is never clipped from the accessible name. |
| assignee chip | `grid place-items-center size-[var(--space-5)] shrink-0 rounded-[var(--radius-pill)] bg-primary text-[var(--accent-on)] [font:var(--weight-regular)_var(--text-2xs)/1_var(--font-sans)] tracking-[0.02em]` (**18.64:1**) |
| overflow `⋯` | `<IconButton>` (square — it only ever holds a glyph). **`opacity: .72` and the hover-reveal deleted.** |

**`.subtask-checklist__title-trigger` is the one class in this file that survives.** Not as
paint — its rule at `app.css:904` is retired — but as a live **runtime selector**:

```ts
// SubtaskChecklist.tsx:216, inside remove()
itemRefs.current.get(nextFocusId)?.querySelector<HTMLButtonElement>(".subtask-checklist__title-trigger")?.focus();
```

Deleting a subtask restores focus to the next row's title button through that query. The first
draft marked the class retired *and* promised focus management was untouched; both could not be
true (§0.5). It stays on the element as a hook and is not converted to `data-*` — converting it
would mean editing the runtime query too, which is a behaviour change inside a visual release for
no gain. §8 marks it **H**, and it gets a comment in the component saying it is a focus hook so
the next sweep does not delete it as dead.

**The hover-reveal mechanic is removed outright.** `.subtask-checklist__metadata-trigger`'s
`opacity: .06` → `1` on hover (:914, :916) and `.subtask-checklist__overflow`'s `.72` → `1`
(:918, :919) both go. Every control in a row is visible at full strength at all times.

Justification, since this is the release's largest visual change: the mechanic has no touch
equivalent (§2.2), so it does not degrade gracefully — it fails outright on the viewport where
this panel is most used. The row stays calm without it because the controls are now
`text-foreground-secondary` glyphs on a transparent ground with no borders, and because at ≤720px
they move to their own line. The hover *feedback* is preserved and strengthened: `bg-secondary`
now washes the whole row **and** the individual control under the pointer.

### 5.3 The three popovers

All three render `<div className={POPOVER_CONTENT}>` inside the existing `AnchoredPopover`.
`subtask-popover__content` is **retired outright** — grepped 2026-09-03, its only consumers are
`app.css:923-924` and `SubtaskChecklist.tsx` itself; **no DOM test queries it**, and the inward
focus-ring rule at `:892` scopes to `.subtask-popover` (the `AnchoredPopover` default
`className`), not to `__content`. The class name is deleted from both files.

**Schedule.** Every `<label>` → `POPOVER_LABEL`; every `<select>` → `<NativeSelect>`; every
`<input type="date"|"time"|"radio">` → `<Input>` / native radio in a `TOGGLE_ROW`-shaped label.
Each gets `RING_IN` in full (§4.3) — all four utilities, `!`-prefixed.

- `__endpoint` `<fieldset>`: `grid gap-[var(--space-2)] min-w-0 p-[var(--space-2)] [border-style:solid] border-[length:var(--border-width-hair)] border-border`
- its `<legend>`: `px-[var(--space-1)] [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground`
- `__fold` `<fieldset>`: same as `__endpoint` **except** `gap-[var(--space-1)]` (its rule was
  `gap: 4px`, which is `--space-1`, not the endpoint's `--space-2`) and `m-0`; plus
  `[border-style:dashed]` and a `text-foreground-secondary` `<legend>`. "Same as endpoint" was
  written loosely in an earlier draft and a builder correctly read it as identical, silently
  widening the fold's internal gap — the two fieldsets are *not* the same.
- **the fold's radio rows.** `.subtask-schedule__fold label` was `display: flex; align-items:
  center; gap: 5px` — a flex row that deliberately overrode `.subtask-popover__content label`'s
  grid. That override retires with the rule, so the treatment has to move onto the element or the
  rows collapse into the grid they were escaping:
  `flex items-center gap-[var(--space-1)] min-h-[38px] max-[721px]:min-h-[44px] cursor-pointer
  [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground`.
  The `<input type="radio">` itself takes `accent-[var(--accent)] cursor-pointer` **plus
  `RING_IN`** — it is a popover-internal control like every other, and an earlier draft left it
  out of the "every control" list by describing it only as "a native radio in a `TOGGLE_ROW`-shaped
  label", which reads as *keep the structure* rather than *convert it*.
- `__error`: `<Notice tone="critical">`
- `__conflict`: `<Notice tone="caution">` — the `caution` tone is **added by slice 1**, not here
  (this line originally read "requires adding", which is true of the release but not of this
  slice); `"border-signal-caution/35 bg-signal-caution/7 text-signal-caution-text"`,
  mirroring `StatusPill`'s existing caution split (border/wash keep the brand ochre, text takes
  the darkened value). **This is §2.4's fix**: the conflict block finally paints as a warning.
- the conflict `<dl>`: `grid gap-[var(--space-1)] m-0` with each `<div>`
  `flex items-baseline justify-between gap-[var(--space-3)]`, `<dt>` `POPOVER_LABEL`,
  `<dd>` `m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground`
- the two **"Use latest…" (discard draft)** buttons (`SubtaskChecklist.tsx:107` — one for
  `error.currentSubtask`, one for `error.current`):
  `buttonClasses("secondary", { className: "justify-self-start " + RING_IN })`. The
  `justify-self-start` replaces `:932`'s `.subtask-schedule__conflict .button` rule.
- the two trailing `<span>`s ("Save reapplies your retained schedule draft; Cancel discards it.")
  in each conflict block: `className={META_TEXT}` plus `[text-transform:none]` — these are
  sentences, not labels.
- `__actions`: `POPOVER_ACTIONS`; **Save** → `buttonClasses("primary", { className: RING_IN })`,
  **Cancel** → `buttonClasses("secondary", { className: RING_IN })`. This retires the
  `min-height: 38px` override at `:934` **and** its 44px `@media` counterpart at `:935-943`,
  because `buttonClasses` BASE already ships `min-h-[38px] max-[721px]:min-h-[44px]`. The 6-line
  comment at `:936-941` explaining the cascade ordering goes with them; the lesson it records
  lives in `docs/lessons.md`, which is where it belongs.

**Assignee.** Search `<input type="search">` → `<Input className={RING_IN}>`.
`__members` → `grid overflow-auto min-w-0`. `__member` button:

```
grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-[var(--space-3)] w-full text-left
min-h-[44px] px-[var(--space-3)] py-[var(--space-2)]   /* 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token */
bg-transparent border-0 [border-left-style:solid] border-l-[length:var(--border-width-bold)] border-l-transparent
text-foreground [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] cursor-pointer
hover:bg-secondary active:bg-surface-sunken
aria-[current=true]:border-l-border-strong
aria-selected:text-signal-positive
disabled:bg-surface-sunken disabled:text-foreground-secondary disabled:cursor-not-allowed
focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)]
focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-[-2px]
```

`<small>` → `text-foreground-secondary` (**9.20**, was 3.57).

Two things in that string are deliberate and must not be "simplified":

- `border-l-border-strong` needs **`--color-border-strong` adding to the `@theme inline` block in
  `tokens/tailwind.css`** (slice 1) — one line aliasing the existing `--border-strong`. It is the
  same left-rule selection marker `.mention-autocomplete__option.is-active` uses at `:460`, so
  both consumers of the marker get it from one place.
- `aria-[current=true]:` is written in the arbitrary form for explicitness only. **Both forms
  work**: probed against the installed Tailwind 4.3.3, `aria-current:underline` and
  `aria-[current=true]:underline` both compile to an `[aria-current="true"]` selector, and
  `SubtaskChecklist.tsx:134` supplies exactly `"true"` or omits the attribute. An earlier draft of
  this plan claimed the short form generates nothing; that was wrong (§0.5). Do not "fix" either
  form into the other.

**Actions.** The single Delete button → `buttonClasses("danger", { className: RING_IN })`. It is a
destructive action behind a `confirm()`; `secondary` (its treatment today) understates it and the
`danger` variant exists precisely for this. **`RING_IN` is not optional here**: `buttonClasses`
BASE carries a non-important *outward* ring (`ui/button.tsx:29-31`), and this button sits inside
an `AnchoredPopover`'s `overflow: auto` panel, where an outward ring clips (§4.3).

### 5.4 The composer

`<form>` `grid gap-[var(--space-2)]`; title `<input>` → `<Input>`; controls row →
`POPOVER_ACTIONS` with `<span className="flex-1" />` as the spacer (unchanged element, so the
`max-[601px]:hidden` behaviour at `:964` is preserved as a utility). `__composer-trigger` → **`META_TRIGGER`** plus
`border-solid border-[length:var(--border-width-hair)] border-border` — which is what `:955` meant
by `opacity: 1; border: …` once the hover-reveal is gone.

**`META_TRIGGER`, not `IconButton`.** An earlier draft of this line said `IconButton`; that is
wrong for the same reason §6.4's toolbar correction is: the composer's schedule and assignee
triggers hold a value chip (a schedule preview, an assignee's initials) exactly as the row's do,
and `IconButton` is a fixed `w-[28px]`. The rule, stated once for the whole plan: **`ICON_BUTTON`
is only for a button whose entire content is one glyph; anything that can hold a word takes
`ICON_BUTTON_BASE + w-auto`; anything that can hold a value takes `META_TRIGGER`.**
`__add-button`:

```
justify-self-start inline-flex items-center min-h-[38px] max-[721px]:min-h-[44px]
px-[var(--space-2)] py-[7px] bg-transparent
[border-style:solid] border-[length:var(--border-width-hair)] border-transparent
text-foreground-secondary [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] cursor-pointer
hover:border-border hover:bg-secondary hover:text-foreground
focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)]
focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-2
```

The `@media (max-width: 600px)` block (`:958-966`) becomes `max-[601px]:` variants on the two
elements that need it. **600px, not 720px** — it is a different breakpoint from the app's usual
one and changing it is out of scope; the ledger records that it was preserved deliberately.

The composer's two buttons (`SubtaskChecklist.tsx:221`): **Cancel** →
`buttonClasses("secondary")`, **Add** → `buttonClasses("primary")`. Neither is inside an
`AnchoredPopover`, so both take the default outward ring from `buttonClasses` and **not** `RING_IN`.
With §5.3's Save/Cancel and the two "Use latest" buttons, that is all six `.button` strings in
`SubtaskChecklist.tsx` accounted for.

Loading and empty states (`.project-collaboration__state`) → `<EmptyState>` with
`tone="empty"`, `className="px-0 py-[var(--space-4)] text-left"` (the panel is 460px wide; the
default `--space-8` vertical padding and centred text are for a full page). `role`/`aria-live`
pass through unchanged.

---

## 6. `ProjectDiscussionThread` and `ProjectActivityView` — the ledger

### 6.1 The comment

```
│ JORDAN KWAN · 14 MAR 2026, 09:12 · EDITED
│ Re-shoot the kitchen wide — the pendant is
│ clipped on the right in every frame.
┃ 
┃ TERRY LEE · 14 MAR 2026, 09:31          <- 3px ink rule: your own comment
┃ Booked for Friday 7am.
┃                                  Edit  Delete
```

`<article>`:

```
grid gap-[var(--space-2)] min-w-0 ps-[var(--space-3)] py-[var(--space-1)]
[border-left-style:solid] border-l-[length:var(--border-width-hair)] border-l-border
```

own comment (`comment.author.id === currentUserId`, the value already computed for the
edit/delete gate — **no new data**):
`border-l-[length:var(--border-width-rule)] border-l-primary`.

`<header>`: `flex flex-wrap items-baseline gap-x-[var(--space-2)] gap-y-[var(--space-1)] min-w-0`
- author `<strong>`: `[font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)] text-foreground min-w-0 [overflow-wrap:anywhere]`
- `<time dateTime={comment.createdAt}>` — **the element and the attribute both stay**; it takes
  `className={META_TEXT}` (§4.1a). It is **not** replaced by `<Eyebrow>`, which is hard-coded to a
  `<span>` and would drop `dateTime` (§0.5). 12px, **8.66:1**, was 10px at 3.57:1.
- `<small>Edited</small>`: same — element kept, `className={META_TEXT}`.
- external-editor badge: `<StatusPill tone="info">External editor</StatusPill>` (§2.7)

`__comments` container: `grid gap-[var(--space-5)]` — 24px, up from 12px. The rules need air; this
is the whitespace that replaces the deleted borders.

`__comment-actions`: `flex justify-end gap-[var(--space-3)]`. All four buttons in this file, by
name and variant — no `.button` string survives in `ProjectDiscussionThread.tsx`:

| Line | Control | Becomes |
|---|---|---|
| 211 | **Edit** | `buttonClasses("text")` |
| 211 | **Delete** | `buttonClasses("text")` |
| 211 | **Cancel** (while editing) | `buttonClasses("secondary")` |
| 211 | **Save** (while editing) | `buttonClasses("primary")` |
| 212 | **Load older comments** | `buttonClasses("secondary", { className: "justify-self-start" })` |
| 213 | **Post comment** | `buttonClasses("primary")` |

This retires `:859`'s `min-height: 30px; font-size: 10px` override, which was the one place in the
app where a `.button` was smaller than the 44px phone floor (§2.3).

> **Builder check, not optional.** `buttonClasses("text")` sets `min-h-[32px]` in its variant
> string while BASE sets `max-[721px]:min-h-[44px]`. Whether the phone floor survives depends on
> Tailwind's *emission* order, not the order in the class string. Measure the computed height of
> an Edit button at 390px in the browser and report the number. If it is 32px, add an explicit
> `className="max-[721px]:min-h-[44px]"` at the call sites rather than editing `button.tsx`
> (which would change every text button in the app — out of scope).

`__comment-compose` `<form>`:
`grid gap-[var(--space-2)] pt-[var(--space-3)] [border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border`;
its footer row `flex flex-wrap items-center justify-between gap-[var(--space-3)]` with the
"Use @ to mention project participants" hint as `<span className={META_TEXT}>` plus
`[text-transform:none]` (it is a sentence, not a label — same treatment as §5.3's conflict
captions), and the submit as
`buttonClasses("primary")`.

`__state` (loading / no-access / empty) → `<EmptyState>` as in §5.4.
`__read-anchor` keeps its 1px box exactly as-is — it is a scroll sentinel, not paint; class
retired, geometry moved to `className="w-px h-px m-0 overflow-hidden"` on the same element.
The `.notice` error divs → `<Notice tone="critical">`.

### 6.2 Activity

The same ledger, one level quieter — it is machine-written, so nothing in it is ever inked.

**The root `<section>` keeps a class, because it currently has one that does real work.**
`app.css:879` is `.project-activity-view { min-width: 0; }` — the only rule the component has, and
it is what stops a long activity title blowing out the 460px panel. Retiring the rule without
replacing it (the first draft's ledger did exactly that) would ship an overflow bug, and the
proposed `justify-self-start` on the load-more button would have had no grid parent to work
against. The section becomes:

```
grid content-start gap-[var(--space-4)] min-w-0
```

`<ol>`: `grid gap-[var(--space-4)] list-none m-0 p-0`
`<li> > <article>`: `grid gap-[var(--space-1)] min-w-0 ps-[var(--space-3)] [border-left-style:solid] border-l-[length:var(--border-width-hair)] border-l-border`
- `<header>`: `flex flex-wrap items-baseline gap-x-[var(--space-2)] gap-y-[var(--space-1)]`,
  title `<strong>` `[font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)] text-foreground`;
  the actor `<span>` and the `<time dateTime>` keep their existing elements and take
  `className={META_TEXT}` — **not** `<Eyebrow>`, which emits a `<span>` and would drop `dateTime`
- `<p>`: `m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary`
- the `<li>`s carry no class; the `<ol>`'s `list-none` covers them

- `<time dateTime={occurredAt.toISOString()}>` and the actor `<span>`: elements kept,
  `className={META_TEXT}` (§4.1a) — **not** `<Eyebrow>`, same reason as §6.1.

Four states and both buttons, by name:

| Line | Element | Becomes |
|---|---|---|
| 42 | "Activity is not available in this view." `.empty` | `<EmptyState role="status" title="Activity is not available in this view.">` |
| 44 | "Loading activity." `.empty` | `<EmptyState role="status" title="Loading activity.">` |
| 46 | error `.empty` (+ its **Retry**) | `<EmptyState role="alert" tone="error" …>`; Retry → `buttonClasses("secondary")` |
| 48 | "No activity yet." `.empty` | `<EmptyState role="status" title="No activity yet.">` |
| 53 | inline `.notice` (+ its **Retry**) | `<Notice tone="critical" role="alert">`; Retry → `buttonClasses("text")` |
| 54 | "Refreshing activity…" `.muted` | `<span role="status" className={META_TEXT}>` |
| 60 | **Load more activity** | `buttonClasses("secondary", { className: "justify-self-start" })` |

`role` and `aria-*` pass through to `EmptyState`/`Notice` unchanged — both spread
`...props` onto their root `<div>` (`quincy/EmptyState.tsx:14-19`, `quincy/Notice.tsx:18`). The
`tone="error"` variant gives the failure state the 3px destructive left rule, so the ledger's own
rule vocabulary carries it.

`.project-activity-view` / `__list` / `__item` / `__actor` paint nothing after this; all four
retire. `role="status"` / `role="alert"` / `aria-label` / `dateTime` are untouched.

### 6.3 `MentionAutocomplete`

Container `<div>`:
`[border-style:solid] border-[length:var(--border-width-hair)] border-border bg-card shadow-[var(--shadow-md)]`
(a floating listbox — the sanctioned elevation exception).
`__list`: `m-0 p-[var(--space-1)] list-none`.
`__option` button — written out in full rather than by reference, because "the same string minus
one utility" is an instruction to derive, not a specification:

```
flex items-baseline justify-between gap-[var(--space-3)] w-full text-left min-w-0
min-h-[44px] px-[var(--space-3)] py-[var(--space-2)]   /* 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token */
bg-transparent border-0 [border-left-style:solid]
border-l-[length:var(--border-width-bold)] border-l-transparent
text-foreground [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)]
cursor-pointer hover:bg-secondary active:bg-surface-sunken
data-[active=true]:border-l-border-strong
focus-visible:!outline focus-visible:!outline-[length:var(--border-width-bold)]
focus-visible:!outline-[var(--focus-ring)] focus-visible:!outline-offset-[-2px]
```

It is deliberately the **same treatment** as `.subtask-popover__member` (§5.3) but for the
`grid-cols` (this one is `flex justify-between`, that one is a two-column grid) and the selection
marker (`data-active` here, `aria-[current=true]` there — different state sources, same 2px ink
left rule). The two are the same control — a person-picker row — and after this release they read
as one.
`.is-active` → `data-active` → `data-[active=true]:border-l-border-strong` (§4.4).
`__status`: `p-[var(--space-2)] [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary` (**9.20**).
`<small>` role text: `text-foreground-secondary capitalize`.

### 6.4 `RichTextEditor` chrome

| Element | Classes |
|---|---|
| root | `group grid gap-[var(--space-2)]`, plus `data-disabled={disabled \|\| undefined}`. **The `opacity: .65` disabled wash is deleted, not ported** (`app.css:429`, §2.1): a group opacity multiplies every child's contrast and makes this section's figures unmeetable. Disabled is expressed by the children below. The `group` class is what lets the ProseMirror element — which is not a React child and cannot read the prop — reach the root's state. |
| `__toolbar` | `flex flex-wrap items-center gap-[var(--space-2)] p-[var(--space-1)] [border-style:solid] border-[length:var(--border-width-hair)] border-border bg-card` |
| `__toolbar-group` | `inline-flex flex-wrap gap-[var(--space-1)]` |
| `__toolbar-divider` | `w-px h-[var(--space-5)] bg-border shrink-0` |
| `__toolbar-button` | **`ICON_BUTTON_BASE` + `w-auto px-[var(--space-2)]`** — *not* `ICON_BUTTON`; see the correction below — plus `[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)] aria-pressed:bg-primary aria-pressed:!text-[var(--accent-on)]`. The `!` is needed on the text colour for the same shorthand reason as the rings; the base string sets `text-foreground-secondary` unconditionally. Disabled: the `--bg-sunken` chip from `ICON_BUTTON_BASE`, **7.40:1**. |
| `__toolbar-select` | `<NativeSelect className="min-w-[112px] w-auto">` — `FIELD_BOX`'s own `disabled:bg-surface-sunken disabled:text-foreground-secondary` gives **7.40:1** |
| `__editor-content` | **keeps `rich-text__editor-content`** (see below) **plus** `FIELD_BOX` + `min-h-[var(--space-8)] bg-[var(--paper-050)] group-data-[disabled]:bg-surface-sunken [&.is-editor-empty:first-child]:before:content-[attr(data-placeholder)] [&.is-editor-empty:first-child]:before:text-foreground-secondary [&.is-editor-empty:first-child]:before:float-left [&.is-editor-empty:first-child]:before:h-0 [&.is-editor-empty:first-child]:before:pointer-events-none` — every variant written out in full; no `…` |
| `__counter` | `text-right [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary`; over → append `!text-destructive` |
| `__validation` | **element and `aria-live="polite"` kept as they are** (`RichTextEditor.tsx:402`); it takes `min-h-[1.2em] [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-destructive`. **Not `<FieldError>`** — that primitive injects `role="alert"` (`ui/field.tsx:34-45`), which would turn a polite live region into an assertive one and change how a screen reader interrupts the user mid-typing. |

> **Correction, found during the slice-2 build (2026-09-03).** This table originally said
> `ICON_BUTTON`, which is a **fixed `w-[28px]`**. That is right for a glyph and wrong here: six of
> these buttons carry *text* labels — `• List`, `1. List`, `☑ List`, `Undo`, `Redo`, `Link` — which
> a 28px box overflows. The builder followed the table literally and correctly; the table was the
> defect. `ICON_BUTTON_BASE` still supplies the 28/44 minimum, every state and the ring, and
> `w-auto` plus symmetric padding lets a label size to its content.
>
> The general lesson, worth carrying into §5.2's own trigger work: **`ICON_BUTTON` is only for a
> button whose entire content is one glyph.** Anything that can hold a word takes the base plus
> `w-auto`, and anything that can hold a *value* takes `META_TRIGGER` (§4.1).

**`rich-text__editor-content` is not retired — it is *joined*.** Nine of the selectors §1.3 keeps
as CSS are scoped through that exact class:

```
app.css:410       .rich-text__editor-content h2:first-child, .rich-text__editor-content h3:first-child
app.css:414-415   .rich-text__editor-content ul[data-type="taskList"]  (+ the nested-list rule)
app.css:421-423   .rich-text__editor-content ul[data-type="taskList"] li  (+ its label, + its input)
app.css:443-446   .rich-text__editor-content p / h2 / h3 / (p+p, ul, ol)
```

Replacing the class with a utility string, as the first draft specified, would have silently
unstyled every heading, paragraph, list and task item **inside the composer** while leaving them
correct in the posted comment — the exact two-renderer divergence §1.3 exists to prevent (§0.5).
The class stays first in the attribute, with the utilities appended after it. `app.css:441-442`
(the box itself and its `:focus` border) are still retired; only the descendant rules survive, and
they need the ancestor class to reach.

**Where the class string actually goes.** `<EditorContent editor={editor} />`
(`RichTextEditor.tsx:399`) takes **no** `className` for this. The class is set through Tiptap at
`:228-229`:

```ts
editorProps: {
  attributes: { class: "rich-text__editor-content", "data-placeholder": placeholder, ...(id ? { id } : {}) },
},
```

The Tailwind string is **appended to** that `class` value, in place, in the `attributes` object —
`class: "rich-text__editor-content " + EDITOR_CONTENT_UTILITIES`. It is a plain HTML `class`
attribute on a ProseMirror-managed element, so:

- `cn()` is not available there — write the string as a single literal (or a module-level `const`
  next to the others), and do not try to merge it at render time.
- The `data-placeholder` attribute and the conditional `id` are untouched. `data-placeholder` is
  load-bearing: `content-[attr(data-placeholder)]` reads it.
- Tailwind's scanner works on lexical candidates in the source text, so the concatenation itself
  is fine: `"rich-text__editor-content " + EDITOR_CONTENT_UTILITIES` is safe **because every
  utility appears as a complete literal** in a module-level `const`. What is unsafe is a candidate
  *name* assembled at runtime (`` `bg-${tone}-500` ``). Keep every utility whole; concatenating
  whole strings is not the hazard.
- `is-editor-empty` is added to this same element by ProseMirror, which is why the placeholder
  variant is written as `[&.is-editor-empty:first-child]:before:…` rather than a `:empty` variant.
- **The disabled fill is `group-data-[disabled]:`, not `data-[disabled=true]:`.** The state lives
  on the React-rendered root (`RichTextEditor.tsx:338`); the ProseMirror element receives only
  `class`, `data-placeholder` and an optional `id` (`:223-230`), so a self-selector would never
  match and the disabled editor would silently stay `--paper-050`. The root carries `group` and
  `data-disabled` (set to `undefined` when enabled, so the attribute is absent rather than
  `"false"` — `group-data-[disabled]` is an attribute-presence test).

The toolbar gap goes 7px → `--space-2` (8px) and its padding 5px → `--space-1` (4px): both were
off-grid. Toolbar buttons rise from ~24px to 28px desktop / **44px at ≤720px**, which is the
first time the bold/italic/link controls have been reachable by thumb.

`w-auto` on the toolbar select is TB8-06's slice-5 correction repeated: `FIELD_BOX` carries
`w-full`, and a full-width select in a `flex-wrap` toolbar pushes every other control onto its own
line. Do not omit it.

---

## 7. `ProjectCollaborationPanel` and the standalone screen

### 7.1 The panel shell — mostly kept, deliberately

`.project-collaboration__wrap` / `__toggle` / `.project-collaboration` /
`--overlay` / `--standalone` (app.css:842-846, :868-869) and the two `.app--impersonating`
blocks (:967-969) **stay in CSS**, unchanged except where noted below.

The reason is specific, not reluctance: this geometry is four `env(safe-area-inset-*)`
calculations feeding three custom properties that are declared on a `display: contents` wrapper
and consumed by two different children, re-declared at one breakpoint and again under an
`.app--impersonating` ancestor — eight interacting declarations of pure layout arithmetic.
Expressed as Tailwind arbitrary values it would be longer, unreadable, and would lose the
single-point-of-change the custom properties give it. This is the roadmap's "specialized CSS
remains where evidence shows it is clearer", claimed explicitly and once.

Changed inside those kept rules:
- `__toggle` `font-size: 10px` → `var(--text-2xs)` (§4.5).
- `__toggle` gains `min-width: 44px` at `≤720px` (`padding: 14px 9px` gives it 18px of horizontal padding around a ~12px line box — ≈30px wide today).
- `.project-collaboration` drops nothing; `--unavailable` stops using it (§7.3).

**The vertical toggle tab is kept as the signature it already is.** `writing-mode: vertical-rl`,
uppercase, hairline-bordered, pinned to the right edge — it is the most Quincy-looking element on
the surface and it predates this plan. It is not redesigned.

`__unread` badge → Tailwind on the component:
`inline-grid place-items-center min-w-[20px] min-h-[20px] mt-[7px] rounded-[var(--radius-pill)] bg-destructive text-[var(--paper-000)] [font:var(--weight-regular)_var(--text-2xs)/1_var(--font-sans)]`
(**10.00:1**; `bg-[var(--signal-red, #7a2420)]` at `:844` also referenced an undefined token —
`--signal-red` does not exist either, so the badge has been painting from its literal fallback
since it shipped. Same family as §2.4, harmless because the fallback is correct, recorded because
the next person should not have to rediscover it.)

The overlay head's **Hide ›** button (`ProjectCollaborationPanel.tsx:64`) →
`buttonClasses("secondary")` — the only `.button` string in that file.

`__head` → `flex items-start justify-between gap-[var(--space-3)]`; overlay variant adds
`flex-none p-[var(--space-5)] [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border bg-[var(--paper-050)]`.
Its `<h2>` → unmodified `--type-h3` (§2.6's 25px goes). `<div className="ey">` → `<Eyebrow>`.
`__scroll` → `grid content-start gap-[var(--space-4)] min-h-0 flex-1 overflow-auto p-[var(--space-5)]`.

### 7.2 The tab strip

Adopt the **exported constants** from `components/ui/tabs.tsx` — `TAB_BASE`, `TAB_IDLE`,
`TAB_SELECTED` — on the existing buttons. **Do not adopt the `TabStrip` component**: it emits
`aria-controls` only on the selected tab (correct for its own consumers, which mount one panel),
whereas this panel keeps both panels mounted with `hidden`, and swapping the component would
change ARIA the plan has no business changing. The roving `tabIndex`, the arrow/Home/End handler
and every id are preserved exactly.

Strip container:
`flex flex-none gap-[var(--space-5)] bg-[var(--paper-050)] [border-bottom-style:solid] border-b-[length:var(--border-width-hair)] border-b-border`
plus `max-[721px]:*:flex-1 max-[721px]:*:justify-center` for the full-width phone tabs `:884`
provides today.
Idle tab text moves from `--text-muted` (**3.36**) to `TAB_IDLE`'s `text-foreground-secondary`
(**8.66**). Standalone's negative-margin bleed (`:880`, `:883`) becomes
`-mx-[var(--space-5)] px-[var(--space-5)] max-[721px]:-mx-[var(--space-4)] max-[721px]:px-[var(--space-4)]`.

### 7.3 `CollaborationOnly` and the fixed-overlay defect

`CollaborationOnlyUnavailable` stops rendering `className="project-collaboration project-collaboration--unavailable"`.
Both classes go; the `<section>` becomes:

```
grid content-start p-[var(--space-5)] bg-card
[border-style:solid] border-[length:var(--border-width-hair)] border-border
```

— static, in flow, no `z-index`, no shadow, full page width. Its inner `.empty` →
`<EmptyState tone="error" title="Collaboration unavailable.">`. `aria-label` unchanged.

`.project-collaboration--unavailable` had **zero** rules of its own; nothing is retired but the
class name. `.project-collaboration` keeps every rule — it still has its real consumer.

The two **Back to dashboard** `InternalLink`s (`ProjectWorkspace.tsx:330, :338`) →
`buttonClasses("secondary")`. They render real `<a>` elements, which is exactly why every
text-colour utility in `buttonClasses` is `!`-prefixed (`ui/button.tsx:6-14`, against `base.css`'s
unlayered `a { color: inherit }`) — no extra work is needed here, but do not strip the `!`s.

The read-only summary card: `.project-collaboration-summary` → Tailwind
(`grid gap-[var(--space-3)] p-[var(--space-5)] bg-card [border-style:solid] border-[length:var(--border-width-hair)] border-border`),
`__facts`/`__team` → `grid gap-[var(--space-3)]` / same + `grid-cols-2 max-[721px]:grid-cols-1 pt-[var(--space-3)] [border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border`
(which retires `:717`), `<h2>` → unmodified `--type-h3`, `.ey` → `<Eyebrow>`,
`<div className="empty">` → `<EmptyState>`.

`.member` (`:779`), `.kv`, `.pagehead` and `.serif` are **shared app-wide** and are not touched.

But their two *scoped* overrides are not shared and must retire **with** the class that scopes
them, or they become dangling selectors that match nothing:

- `.project-collaboration-summary .member em` (`:213`) — the "Inactive" marker.
- `.project-collaboration-summary .member` (`:867`) — a 13px size override.

`.project-collaboration-summary` is rendered in exactly one place (`ProjectWorkspace.tsx`'s
`CollaborationOnly`), so once that class is gone both selectors are unreachable. The member row
becomes an inline treatment on the element itself:

- row `<div>`: `py-[5px] [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary`
  (14px, up from the 13px override, back on the scale)
- `<em>Inactive</em>`: `ms-[6px] not-italic text-signal-caution-text` — **6.65:1**, the same value
  `:213` already used; the change is that it now travels with the element instead of depending on
  an ancestor class this release deletes.

---

## 8. Retirement ledger — every selector, with a disposition

**Counting method, stated once so every figure below means the same thing:** a **rule** is one
`selector-list { … }` block; a **selector member** is one comma-separated selector inside it. All
counts here are **rules**. Line numbers are `app.css` at `main@e4f7ffc`; they will drift as slices
delete, which is why every slice locates its targets **by selector grep, not by line range**
(`docs/lessons.md` — after six slices TB8-06's own line numbers were 60-70 lines stale).

**R** = retired (rule deleted). **H** = rule deleted, class name kept on the element as a
non-painting hook. **D** = class modifier converted to a `data-*` attribute. **K** = rule kept as
CSS, deliberately, reason given.

### 8a. Retired, by slice

The slice column is binding: §4.4 requires the deletion to land in the same slice as its
replacement.

| Slice | Lines | Rules | Disp. |
|---|---|---|---|
| 2 | 428, 429 | `.rich-text-editor`, `.is-disabled` | **R** / **D** (`data-disabled`) |
| 2 | 430-440 | `.rich-text__toolbar`, `-group`, `-divider`, `-button` (+ `:hover`, `:focus-visible`, `[aria-pressed]`, `:disabled`), `-select` (+ `:focus-visible`, `:disabled`) — 11 rules | **R** |
| 2 | 441, 442 | `.rich-text__editor-content` (the box), `:focus` | **R** — the *class* survives on the element (§6.4) |
| 2 | 447 | `.rich-text__editor-content.is-editor-empty:first-child::before` | **R** |
| 2 | 448, 449, 450 | `.rich-text__counter`, `.is-over`, `__validation` | **R** |
| 2 | 455-463 | `.mention-autocomplete`, `__list`, `__option`, `:hover`, `:active`, `.is-active`, `:focus-visible`, `__option small`, `__status` — 9 rules | **R**; `.is-active` → **D** (`data-active`) |
| 3 | 886-889 | `.subtask-checklist`, `__head h3`, `__toggle`, `__toggle:hover` | **R** |
| 3 | 890 | the 6-selector `:focus-visible` group | **R** — every member now carries its own `RING_OUT` |
| 3 | 893-900 | `__progress-text`, `__toggle-meta`, `__chevron`, `__toggle progress`, `__panel`, `.is-collapsed`, `__notice`, `__items` | **R** |
| 3 | 953-957 | `__composer`, `__composer-controls > span`, `__composer-trigger`, `__add-button`, `__add-button:hover` | **R** |
| 3 | 958-966 | the `@media (max-width: 600px)` block (3 rules) | **R** → `max-[601px]:` variants; **the 600px breakpoint is preserved deliberately** (§5.4) |
| 4 | 891, 892 | `.subtask-popover button/input:focus-visible` (the inward ring) | **R** — replaced by per-site `RING_IN` (§4.3). The `:891` comment explaining *why* the ring is inward moves into `AnchoredPopover.tsx` beside `PANEL`; the fact outlives the rule |
| 4 | 901-903 | `__item`, `__item:hover/:focus-within`, `__summary` | **R**; `--done` / `--dragging` / `--popover-open` → **D** |
| 4 | 904 | `__title-trigger` | **H** — live focus-restoration selector at `SubtaskChecklist.tsx:216` (§5.2) |
| 4 | 905-920 | `__title`, the done-title rule, `__done`, the shared 3-member input rule at `:908`, `__due`, `__assignee`, `__grip`, `:active`, `[aria-disabled]`, `__metadata-trigger` (+ `--filled`, the hover group, the nested `__due`), `__overflow`, its hover group, `__item--dragging` — 16 rules | **R** |
| 4 | — | *(note)* `:908` is `.subtask-checklist__title, .subtask-checklist__composer input, .subtask-popover input` — **three selector members, one rule**. Its middle member goes dead the moment slice 3 converts the composer, and the other two die here. Slice 4 deletes the whole rule; there is nothing left to scope it to. Recorded because §8c check 3 would otherwise flag an orphaned member with no ledger row | **R** |
| 4 | 921-932 | `__content`, `__content label`, `__endpoint`, `__endpoint legend`, `__fold`, `__fold legend`, `__fold label`, `__error`/`__conflict`, `__conflict`, `__conflict .button` — 9 rules | **R**, class name included; **no DOM test queries `.subtask-popover__content`** (§5.3) |
| 4 | 933, 934 | `__actions`/`__composer-controls`, `__actions .button` (38px) | **R** — obsolete: `buttonClasses` BASE ships 38px and the ≤721px 44px |
| 4 | 935-943 | the `@720` 44px block **and its 6-line cascade-ordering comment** | **R** — same reason; the lesson lives in `docs/lessons.md`, not in a rule that no longer exists |
| 4 | 944-952 | `__member` (the 44px rule), `__members`, `__member` (the layout rule), `:hover`, `:active`, `[aria-current]`, `[aria-selected]`, `:disabled`, `small` — **9 rules** | **R** |
| 5 | 851-861 | `__state`, `__read-anchor`, `__comments`, `__comment`, `__comment header`, `__comment header strong`, `__comment time/small`, `__comment-actions`, `__comment-actions .button`, `__comment-compose`, `__comment-compose > div:last-child` — 11 rules | **R** |
| 6 | 879 | `.project-activity-view` | **R** — replaced by an explicit `min-w-0` on the section (§6.2) |
| 7 | 844 | `__unread` | **R** |
| 7 | 847-850 | `__head`, the overlay `__head`, `__head h2`, `__scroll` | **R** |
| 7 | 872-878 | `__tabs`, `__tab`, `:hover`, `.is-active`, `:focus-visible`, `__panel`, `__panel[hidden]` | **R** |
| 7 | 880, 881 | the standalone `__tabs` bleed, the standalone `__panel` | **R** |
| 7 | 882-885 | the `@720` block (2 rules) | **R** → `max-[721px]:` variants |
| 7 | 862-867 | `.project-collaboration-only`, `-summary`, `-summary h2`, `__facts`/`__team`, `__team`, `-summary .member` — 6 rules | **R** |
| 7 | 213 | `.project-collaboration-summary .member em` | **R** — a scoped override whose scoping class this release deletes; it would otherwise dangle (§7.3) |
| 7 | 717 | `.project-collaboration-summary__team` @720 | **R** |

**128 rules retired**, across six slices: **28 / 20 / 44 / 11 / 1 / 24** for slices 2-7.

*(Corrected during the slice-3 build: the split was written 28/21/43/… on the assumption that
slice 3 removes all three rules inside the `@media (max-width: 600px)` block. It removes only the
two composer-only ones — §11a assigns the third to slice 4 — so one rule moves from slice 3 to
slice 4. The **total is unchanged at 128**; only the boundary moved.)*

Counted mechanically over the ranges above rather than by hand — a hand count in the previous
revision said 86 and was wrong by a third. Two things a re-counter must get right, both of which
that count got wrong: a one-line `@media (…) { .x { … } }` block contributes **one** rule, not
two (the wrapper is not a rule); and a comma-separated selector list is **one** rule regardless of
how many members it has. `app.css:921-932` is ten rules, not the nine an earlier draft claimed.

### 8b. Kept, and why

Each range appears **once**; no rule is listed twice.

| Lines | Rules | Justified by |
|---|---|---|
| 408-427 | **20** rules — the whole `.rich-text` prose block, including `:410`, `:414-415` and `:421-423` | §1.3 — two renderers, one stored document, mostly bare tags |
| 443-446 | **4** rules — the editor-content prose descendants (`p`, `h2`, `h3`, and the `p+p`/`ul`/`ol` group) | §1.3, §6.4 |
| 842, 843, 845, 846 | **4** rules — `__wrap`, `__toggle`, `.project-collaboration`, `--overlay` | §7.1 — eight interacting `env()`/custom-property declarations |
| 868, 869 | **2** rules — `--standalone`, and the one rule inside its `@min-width:1080px` block | §7.1 |
| 967, 968, 969 | **3** rules — the `@720` block's one rule, `.app--impersonating __wrap`, and the second `@720` block's one rule | §7.1 |

**33 rules kept.**

A previous revision listed `410, 414-415, 421-423` as a separate row from `408-427`, which
double-counted them — they are inside that range. And **`:410` is one rule, not two**: its selector
list spans both halves of the `.rich-text` block (six `.rich-text …:first-child` members and two
`.rich-text__editor-content …:first-child` members), and a selector list is one rule. It lives in
the `408-427` row and nowhere else. This is why the class must survive on the element (§6.4): the
`__editor-content` members of `:410`, and all of `:414-415`, `:421-423` and `:443-446`, reach
through it.

Rules **untouched** by this release because they are shared app-wide, and which this surface
merely stops *using*: `.statetag` (`:178`), `.empty` (`:638-639`), `.notice` (`:775`), `.muted`
(`:21`), `.serif` (`:22`), `.ey` (`:20`), `.member` (`:779`), `.kv` (`:235-237`), `.pagehead`
(`:121-122`). They are listed here so the slice-8 audit does not read them as misses. Their
`--text-muted` paint sites belong to `TB8-10` D-05, not here.

### 8c. The slice-8 audit

Slice 8 performs **no deletions**. Its four checks:

1. greps `app.css` for every selector in 8a and asserts zero matches;
2. greps for every selector in 8b and asserts it is present, with a one-line comment naming the
   section of this plan that justifies it;
3. asserts no collaboration, checklist, mention or rich-text-chrome selector exists in `app.css`
   that appears in neither table;
4. re-counts mechanically and asserts **128 gone, 33 kept**, using 8a's stated counting method
   (a one-line `@media` wrapper is not a rule; a selector list is one rule).

Any selector that fails one of those three is a finding for the Sol diff review.

## 9. What must not change — and the ten changes that are authorized

The first draft claimed a `className`-stripped diff would show "only class strings and `data-*`
conversions." That was not achievable and is corrected here: this release makes a small number of
**structural** changes, and a plan that promises otherwise gives the reviewer a check that must
fail. They are enumerated below; the invariant is that **nothing outside this list changes**.

### 9a. The ten authorized structural changes

| # | Change | Files | Why it is safe |
|---|---|---|---|
| 1 | `<div className="notice">` → `<Notice>` | Discussion, Activity | Same `<div>`; adds `data-slot="notice"`; `role` passed through |
| 2 | `<div className="empty">…</div>` → `<EmptyState>` | Activity, `CollaborationOnly*`, checklist/discussion `__state` | **Changes inner structure** — `<span class="serif">` + text becomes `<strong>` + a nested `<div>` (`quincy/EmptyState.tsx:23-33`). `role`/`aria-*` pass through via `...props`. Accessible name and reading order are preserved; the wrapper `<div>` carries no role |
| 3 | `<span className="statetag">` → `<StatusPill tone="info">` | Discussion | Same `<span>`; adds `data-slot` |
| 4 | Subtask due text → `<StatusPill tone="neutral">` | Checklist | Same `<span>`; the `sr-only` "Schedule " prefix is kept verbatim |
| 5 | A meta-wrapper `<div>` added inside each subtask row | Checklist | §5.2 — no `role`, no `aria-*`, no `id`; `display: contents` at ≥721px so the desktop DOM box tree is unchanged |
| 6 | `<Input>` / `<NativeSelect>` / `<Checkbox>` replace bare `<input>` / `<select>` | Checklist row + composer, both schedule/assignee popovers, **and the RTE toolbar's heading select** (`RichTextEditor.tsx:348-357`) | Same elements; each adds only `data-slot` and `className` |
| 7 | **Five** `data-*` attributes replace five class modifiers | Checklist (`data-done`, `data-dragging`, `data-popover-open`), Mention (`data-active`), RTE root (`data-disabled`) | Attributes carry no semantics; no `aria-*` is displaced |
| 8 | Hand-rolled buttons → `buttonClasses()` / `<IconButton>` | all | `<button type="button">` in, `<button type="button">` out; the two `InternalLink`s stay `<a>` |
| 9 | **`<div className="ey">` → `<Eyebrow>`, which changes `<div>` to `<span>`** | `ProjectCollaborationPanel.tsx:64`; `ProjectWorkspace.tsx:330, :332` (×3 — "Collaboration", "Read-only summary", "Photographers"/"Editors") | `Eyebrow` is hard-coded to a `<span>` (`ui/eyebrow.tsx:5-14`). Each of these is a bare label inside a flow container with no role, no id and no `aria-*`, and each is followed by a sibling heading — so the block→inline change is absorbed by the parent's `grid`/`flex` layout. `<Eyebrow className="block">` is used where the label must still occupy its own line. **This is the one place an element *type* changes**; it is listed rather than hidden inside "class changes" |
| 10 | `<div className="empty">` inside `CollaborationOnlyUnavailable` and the `__state` divs → `<EmptyState>` | Discussion, Checklist, `CollaborationOnly*` | Same as #2; called out separately only because these three sites have no `role` today and must not gain one |

**Ten, and nothing else.** §11's per-slice report checks the diff against *this* list, not against
a "classes and `data-*` only" rule — an earlier revision said the latter, which §9a's own contents
contradict.

**Explicitly *not* authorized**, each having been considered and rejected: adding a `hidden`
attribute to the checklist panel (§5.1), replacing `.rich-text__validation` with `FieldError`
(§6.4), replacing `<time>` with `<Eyebrow>` (§6.1), and swapping the collaboration tab strip for
the `TabStrip` component (§7.2). Each would have changed ARIA to buy paint.

### 9b. The invariants

The builder verifies each with a `className`-stripped diff against `main`, per slice. Anything the
diff shows that is not one of 9a's **ten** is a finding.

1. Every `aria-label`, `aria-labelledby`, `aria-controls`, `aria-expanded`, `aria-selected`,
   `aria-current`, `aria-checked`, `aria-invalid`, `aria-describedby`, `aria-live`, `aria-hidden`,
   `role`, `id`, `htmlFor`, `dateTime` and `sr-only` span is byte-identical.
2. Every `disabled`, `hidden`, `tabIndex` and `autoFocus` expression is byte-identical.
   **No `hidden` attribute is added or removed anywhere.**
3. Focus management is untouched: `closeRef`/`triggerRef`/`panelRootRef`/`tabRefs`,
   `scheduleReorderFocus`, `titleInputRef`, `composerInputRef`, `gripRef`, `initialFocus`.
4. dnd-kit wiring is untouched: sensors, `SortableContext`, `dragProps`, `combinedNodeRef`,
   `combinedGripRef`, the `transform`/`transition` inline `style`.
5. Every query key, mutation, invalidation and optimistic cache write is untouched.
6. `MentionAutocomplete.handleKeyDown`'s return values and `onAccessibilityChange`'s payload are
   untouched — the composer's `aria-activedescendant` depends on them.
7. `onAccessFailure` routing, `consumeOrForward`, `presentation.isCurrent` and every 401/403/404
   branch are untouched.
8. The read-anchor `IntersectionObserver` still observes the same element.
9. `remove()`'s focus restoration still finds `.subtask-checklist__title-trigger`
   (`SubtaskChecklist.tsx:216`) — the class stays on the element (§5.2).
10. The composer's `aria-activedescendant` still resolves: `MentionAutocomplete`'s `listboxId` and
    per-option ids are unchanged, so the `data-active` conversion must replace only
    `className="…is-active"`, never the `id`.

---

## 10. Acceptance criteria

Measured in the browser at **1440×900**, **1024×768**, **390×844**, on local dev with a project
that has ≥5 subtasks (mixed done/scheduled/assigned/unassigned), ≥6 comments including one from
another user and one from the signed-in user, and ≥3 activity events.

1. **Contrast.** Every row of §2.1 measures its "After" value or better, sampled from computed
   style. The disabled grip measures ≥3.0:1; every text site measures ≥4.5:1.
2. **The invisible controls are visible.** On an unscheduled, unassigned subtask at 390px, the
   schedule and assignee triggers are visible without hover or focus, and each measures ≥44×44.
3. **Touch targets.** At 390px every control in §2.3 measures ≥44px in its constrained dimension:
   grip, checkbox label, title trigger, schedule trigger, assignee trigger, overflow, add-item,
   comment Edit, comment Delete, every toolbar button, the collaboration toggle tab.
4. **No horizontal overflow** at 390px on the panel, any subtask row, any popover, the composer,
   or the standalone page. `document.documentElement.scrollWidth === clientWidth`.
5. **The schedule conflict paints as a warning.** Force a version conflict; the block renders in
   `--signal-caution-text` with the ochre wash, not ink.
6. **The unavailable state is in flow.** On `/collaboration` for an unavailable project,
   `getComputedStyle(section).position === "static"` and the section spans the page width.
7. **The ledger reads as one surface.** Comments and activity events share the left-rule
   treatment; the signed-in user's own comments carry the 3px ink rule and no one else's do.
8. **Focus is visible and unclipped** on all of: toggle tab, each tab, comment Edit/Delete/Save/
   Cancel, composer submit, every toolbar button, the RTE content box, the checklist toggle, grip,
   checkbox, title trigger, both metadata triggers, overflow, add-item, every control inside all
   three popovers, and every mention option. Popover-internal rings are inward (`-2px`) and none
   is clipped by the panel's `overflow: auto`.
9. **Keyboard.** Tab order unchanged; tab-strip arrows/Home/End work; mention
   ArrowUp/Down/Enter/Tab/Escape work; subtask drag-by-keyboard works and focus lands on the moved
   item's grip; Escape closes each popover and returns focus to its trigger; Escape closes the
   overlay panel and returns focus to the toggle.
10. **The Notice Board**, at all three viewports (§1.2's shared-owner blast radius): rendered
    posts (line-height and mention-chip radius), the **create** composer, the **edit** composer,
    a disabled composer, and the mention popup inside one. Headings, paragraphs, lists and task
    items must render **identically** in a rendered post and in the composer that produced it —
    that equivalence is the whole reason §1.3 keeps the prose block as CSS, and it is the check
    that would have caught the retired-editor-content-class defect (§0.5).
11. **Zero console errors and zero failed requests** across the walk (in-flight `ERR_ABORTED`s on
    navigation excepted, per TB8-05/TB8-06 precedent).
12. **`app.css` matches §8**: all four of the slice-8 audit's checks (§8c) pass — **128 rules
    gone**, §8b's **33** survivors present and each carrying its justifying comment, nothing
    collaboration-, checklist-, mention- or rich-text-chrome-shaped that appears in neither table,
    and the mechanical re-count agreeing.
13. `npm run typecheck` (6 workspaces), `npm run build -w @quincy/web`, and the full suite
    (`npm run test --workspaces` plus `npx vitest run --config packages/shared/vitest.config.ts`)
    are green with **zero** failures.

---

## 11. Slices

Bottom-up, per `Subagent-Frontend-Orchestration.md`. Each slice ends green on `typecheck` and
`build -w @quincy/web`; only slice 8 must satisfy the full gate. Each slice agent is given the
sections named below **plus** §1, §3, §4 and §9 in full — those four are the shared constraint
sections every slice needs.

**Every slice from 2 onward deletes its own `app.css` rules** (§4.4). The deletions are part of
the slice, not deferred to slice 8; §8a is the authority on which.

| # | Scope | `app.css` deletions | Reads |
|---|---|---|---|
| 1 | `ui/icon-button.tsx` (new: `ICON_BUTTON_BASE`, `ICON_BUTTON`, `META_TRIGGER`, `IconButton`); `META_TEXT` exported from `ui/eyebrow.tsx`; `POPOVER_CONTENT`/`POPOVER_LABEL`/`POPOVER_ACTIONS` exported from `AnchoredPopover.tsx`; `Notice` gains the `caution` tone; `--color-border-strong` added to `tokens/tailwind.css` | none | §4 |
| 2 | `MentionAutocomplete.tsx`; `RichTextEditor.tsx` chrome; the three `.rich-text` token edits | 428-442, 447-450, 455-463 — **28 rules** | §4.6, §6.3, §6.4 |
| 3 | `SubtaskChecklist.tsx` — section, head, toggle, progress, panel, notice, **composer**, add-button, empty/loading states | 886-890, 893-900, 953-957, and **`:964`, `:965` only** from the `@600` block — **20 rules** | §5.1, §5.4, **and §5.3's assignee/schedule specs for the `compact` branch only** |
| 4 | `SubtaskChecklist.tsx` — `SortableSubtaskRow`, and the non-`compact` branches of `ScheduleControl`/`AssigneeControl`/`ActionsControl` | 891-892, 901-952, and the **`@600` block's remaining rule `:963` plus the now-empty wrapper** — **44 rules** | §5.2, §5.3 |
| 5 | `ProjectDiscussionThread.tsx` | 851-861 — **11 rules** | §6.1 |
| 6 | `ProjectActivityView.tsx` | 879 — **1 rule** | §6.2 |
| 7 | `ProjectCollaborationPanel.tsx`; `ProjectWorkspace.tsx`'s `CollaborationOnly` and `CollaborationOnlyUnavailable` | 213, 717, 844, 847-850, 862-867, 872-885 — **24 rules** | §7 |
| 8 | **Audit only** (§8c) — no deletions; adds the survivors' justifying comments; test updates; docs | none | §8, §12 |

### 11a. The slice 3 / slice 4 boundary — the one real hazard

**Slice 4 is split into 4a and 4b** (decided during the build, 2026-09-03). The combined slice was
handed to one builder and the run **stalled during exploration having written nothing** — the exact
failure `Subagent-Frontend-Orchestration.md`'s "Slicing a large plan" section records from TB8-04.
Slice 4 is the largest in this release (44 CSS rules, the whole row, and three popover bodies), so
it splits at the natural seam:

- **4a — `SortableSubtaskRow`** and the row's CSS (`901-903`, `904`, `905-920`).
- **4b — the three popover bodies** (`ScheduleControl`, `AssigneeControl`, `ActionsControl`) and
  their CSS (`891-892`, `921-932`, `933-934`, `935-943`, `944-952`, and the `@600` remainder).

The two are disjoint in both files. The re-run prompts also give **exact line ranges to read** and
say to stop there, rather than naming sections — a cold agent handed "read §1, §3, §4 in full"
spends its whole allowance before writing, which is what killed the first attempt.

Slices 3 and 4 both edit `SubtaskChecklist.tsx` and run **in sequence**, never in parallel. They
also *share two components*, and the previous revision did not say how, which would have left the
boundary to the builder's judgment. It is fixed here:

**`ScheduleControl` and `AssigneeControl` each render the same trigger element for two callers**,
switched by the `compact` prop (`SubtaskChecklist.tsx:73-103` and `:113-135`): the checklist
composer passes `compact`, a row does not.

- **Slice 3 converts only the `compact` branch** — the `subtask-checklist__composer-trigger`
  modifier and the composer's own layout. It leaves the non-`compact` trigger's class string, and
  every popover *body* (schedule fields, member list, actions), exactly as it finds them.
- **Slice 4 converts the non-`compact` branch and all three popover bodies.**

Because both branches live in one `className` template string, slice 3's edit is a **conditional**
change — convert the `compact ? …` arm, leave the base arm — and slice 4 collapses the two into
one converted string. Slice 3's report must show the non-`compact` arm unchanged.

**Two `app.css` rules are shared between the slices and are split, not duplicated:**

| Rule | Members | Owner |
|---|---|---|
| `:933` | `.subtask-popover__actions, .subtask-checklist__composer-controls` | **Slice 4** deletes the whole rule. Slice 3 replaces the composer's use of it with `POPOVER_ACTIONS`; the popover's use survives one slice on the legacy rule, which is the documented one-slice overlap |
| `:963` | `.subtask-popover__actions, .subtask-checklist__composer-controls { flex-wrap }` inside `@600` | **Slice 4**, same reason. Slice 3 must **not** delete the `@600` wrapper — `:963` still needs it. Slice 3 deletes only `:964` and `:965`, which are composer-only |

Deleting the whole `@media (max-width: 600px)` block in slice 3, as the previous revision's
range implied, would have removed the popover-action wrapping a slice before slice 4 installs its
replacement — a real, if brief, regression. Slice 3 deletes two rules from inside the block and
leaves it standing; slice 4 deletes the last rule and the now-empty wrapper.

**A second one-slice gap, found during the slice-3 build and recorded so slice 4's builder and
the slice-8 audit do not read it as an oversight.** The 6-selector `:focus-visible` group at
`:890` is deleted by slice 3, but only two of its six members (`__toggle`, `__add-button`) are
slice 3's. The other four — `__title-trigger`, `__overflow`, `__metadata-trigger`, `__grip` — are
row elements that do not receive their own `RING_OUT` until slice 4. So between slice 3 and slice
4 those four have **no focus ring**.

This is accepted, not a defect: it is an intra-branch gap between two sequential slices with no
deploy between them, exactly like the `:933`/`:963` overlap above. It is called out because the
ledger's own justification for deleting `:890` in slice 3 ("every member now carries its own
ring") is only true *after* slice 4. **Slice 4 must therefore verify all six rings, not just its
own four** — and the visual gate's §10 item 8 checks every one regardless.

Everything else is disjoint: slice 3 owns `886-890`, `893-900`, `953-957`; slice 4 owns
`891-892`, `901-952`. No selector appears in both lists.

### 11b. What a slice reports

The diff; its §9b check **against §9a's ten authorized changes** (not against a "classes and
`data-*` only" rule — §9a's own contents contradict that); `typecheck` and `build` output; a grep
proving its `app.css` deletions landed and its neighbours did not; and, for slices 2-7, the
`className`-stripped semantic diff against `main`.

Each slice locates its deletions **by selector grep**, never by the line numbers in the table —
they drift as earlier slices delete (§8, and `docs/lessons.md` on TB8-06's 60-70-line drift).

## 12. Tests

Existing DOM suites that assert on retired class names must move to the `data-*` attribute or the
accessible name, never be loosened:

`SubtaskChecklist.dom.test.tsx`, `.access.dom.test.tsx`, `.inert.dom.test.tsx`,
`ProjectDiscussionThread.dom.test.tsx`, `ProjectCollaborationPanel.dom.test.tsx`,
`ProjectActivityView.dom.test.tsx`, `RichTextEditor.dom.test.tsx`, `RichTextByteGuard.dom.test.tsx`,
`ProductionCalendar-checklist*.dom.test.tsx` (they render subtask rows),
`ProjectWorkspace.dom.test.tsx` (queries `.project-collaboration-only`).

New assertions this release owns:

1. An unscheduled subtask's schedule trigger and an unassigned subtask's assignee trigger are
   rendered and are **not** hidden — the regression guard for §2.2.
2. The disabled drag grip carries no `opacity` in its class list — the guard for §2.1's
   TB8-06-repeat.
3. A comment authored by the current user carries the own-comment marker and another user's does
   not — the guard for §3's one inked element.
4. `.subtask-schedule__conflict`'s replacement renders with the caution tone — the guard for §2.4.
5. `CollaborationOnlyUnavailable` does not render `class="project-collaboration"` — the guard for
   §2.5.
6. `IconButton` renders `type="button"` by default and forwards `aria-disabled`.
7. **`SubtaskChecklist`'s delete still restores focus to the next row's title button** — the
   regression guard for the `.subtask-checklist__title-trigger` hook (§5.2, §0.5). This one is
   load-bearing: it is the assertion that would fail if a later sweep deletes the class as dead.
8. **`RichTextEditor`'s content element still carries `rich-text__editor-content`** — the guard
   for §6.4, so the retained prose CSS keeps its ancestor.
9. `RichTextEditor`'s validation element still has `aria-live="polite"` and **no** `role="alert"`
   — the guard for the rejected `FieldError` substitution (§9a).
10. `META_TRIGGER` truncates rather than overflows when given a long schedule string.

`docs/todo.md` gains a TB8-07 entry; `docs/lessons.md` gains the two new lesson candidates
(**an undefined custom property in an inherited property falls back to `inherit`, not to the
declaration above it**; **a hover-reveal affordance has no touch equivalent and fails outright on
the viewport it is most used on**) if the build confirms them.

---

## 13. Deferred, with an owner

| Item | Why | Owner |
|---|---|---|
| The remaining `--text-muted` paint sites app-wide | **Re-measured: 36 `var(--text-muted)` declarations in `app.css` at `main@e4f7ffc`**, not TB8-10 D-05's 41 (that figure counted selector members, and `:857` and `:906` each carry two selectors). This release fixes only the sites it owns; the global sweep, and D-05's own split of text roles from decorative ones, stays there | `TB8-10` D-05 |
| `.button` → `buttonClasses()` across the app | **Re-measured at `main@e4f7ffc`, one explicit method** — `className="button…"` string literals plus `className={\`button…\`}` template literals in non-test `.tsx` under `apps/web/src`: **50 occurrences across 19 files** (48 + 2). TB8-10's "51 / 36 files" predates TB8-06's three retirements and used a looser file count. This release retires **19** (17 across the four components, 2 in `CollaborationOnly`), leaving **31** | `TB8-10` D-06 |
| The Notice Board's own surface | Candidate #8; only its shared composer moves here | TB8-08 |
| Real assistive-technology verification of the new ledger semantics | No agent in this pipeline can drive a screen reader | The existing owner decision in `TB8-10`'s verification-debt table — this release adds a fourth row rather than a new question |
| — | *(removed: `.subtask-popover__content` is retired outright in slice 4; it has no DOM-test consumer, so there is nothing to defer — §5.3)* | — |

---

## Sources

- `docs/Subagent-Frontend-Orchestration.md` — the pipeline, the design-system source, the
  unlayered-`app.css` gotcha, the slicing rule.
- `docs/plans/revamp_2026_portal/roadmap/TB8-Wider-UI-Migration-And-Cleanup.md` — selection order,
  candidate list, rules, completion criteria.
- `docs/plans/revamp_2026_portal/baseline/TB0/Drift-Register.md` — TB0-VIS-03.
- `docs/plans/TB8-10-Deferred-Defects-And-Cleanup-Sweep-Plan.md` — D-04 (undefined-token class),
  D-05, D-06, the verification-debt table.
- `docs/plans/implemented/TB8-06-Kanban-Board-Visual-Plan.md` — the disabled-handle contrast
  precedent, the `data-*` conversion convention, the `w-auto` correction, the Tailwind
  emission-order lesson.
- `portal/apps/web/src/styles/tokens/*.css` — every token cited above.
- `prototype/_ds/quincy-productions-design-system-*/` — ink/paper duotone, hairline rules, square
  corners, no-shadow elevation.
