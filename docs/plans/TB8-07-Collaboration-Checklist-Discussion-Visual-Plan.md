# TB8-07 — Collaboration, Checklist and Discussion: Visual Plan

**Status: DRAFTED, NOT BUILT.** Ranking candidate **#7** in
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

## 1. Scope

### 1.1 In scope — six files, one screen

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

- **The Notice Board** is candidate **#8** and is not touched — *except* that it consumes
  `RichTextEditor` and `RichTextContent`. Converting the editor chrome (§1.3) necessarily changes
  the Notice Board composer's appearance. This is deliberate: the component is one styling owner,
  and splitting it would create exactly the duplicated-owner problem the roadmap forbids. **The
  visual gate must therefore also open the Notice Board composer at all three viewports**, and
  candidate #8 inherits an already-converged composer.
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

### 2.1 Contrast failures

| Site | Paint today | Ratio | Bar | After |
|---|---|---|---|---|
| Comment `<time>`, `<small>Edited</small>` (app.css:857) | `--text-muted` on `--paper-000` | **3.57** | 4.5 | `--text-secondary`, **9.20** |
| `.mention-autocomplete__option small` (:462) | `--text-muted` on `--bg-surface` | **3.57** | 4.5 | **9.20** |
| `.mention-autocomplete__status` (:463) | `--text-muted` on `--bg-surface` | **3.57** | 4.5 | **9.20** |
| `.subtask-popover__member small` (:952) | `--text-muted` on `--bg-surface` | **3.57** | 4.5 | **9.20** |
| Done subtask title (:906) | `--text-muted` on `--paper-000` | **3.57** | 4.5 | **9.20** |
| Idle collaboration tab (:873) | `--text-muted` on `--paper-050` | **3.36** | 4.5 | **8.66** |
| `.rich-text__toolbar-button:disabled` (:437) | `--text-muted` on `--paper-000` | **3.57** | 4.5 | **9.20** |
| `.rich-text__toolbar-select:disabled` (:440) | `--text-muted` on `--paper-000` | **3.57** | 4.5 | **9.20** |
| `.rich-text__counter` (:448) | `--text-muted` on `--paper-050` | **3.36** | 4.5 | **9.20** |
| RTE placeholder (:447) | `--text-muted` on `--paper-050` | **3.36** | 4.5 | **8.66** |
| `.empty` in `ProjectActivityView` (:638) | `--text-muted` on `--paper-050` | **3.36** | 4.5 | `EmptyState`, **8.66** |
| Disabled drag grip (:913) | `--text-secondary` **× `opacity:.5`** | **2.51** | 3.0 | `--text-muted`, **3.57**, no opacity |
| `.subtask-checklist__overflow` (:918) | `--text-secondary` **× `opacity:.72`** | **4.21** | 4.5 | `--text-secondary`, **9.20**, no opacity |

The disabled-grip row is **the same defect TB8-06 fixed on the Kanban board's disabled drag
handle**, in a different file — an opacity multiplier stacked on an already-quiet colour. The fix
matches TB8-06's exactly (drop the opacity; differentiate with the colour alone, at the 3:1
graphical-object bar), so the two disabled handles in the app finally agree.

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

### 4.1 New primitive: `components/ui/icon-button.tsx`

The surface has **five** icon-glyph affordances (grip, overflow, schedule trigger, assignee
trigger, chevron) with five different hand-rolled treatments, three of them contrast failures.
`buttonClasses("text")` does not fit — these are square glyph targets, not text buttons. The app
has a legacy `.icbtn` (app.css:77-87) with the right *idea* and no Tailwind equivalent.

```tsx
// components/ui/icon-button.tsx
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A square glyph affordance: drag grips, overflow menus, popover triggers.
 * Not `buttonClasses("text")` — that is a text control with a text baseline.
 * 28px desktop / 44px at <=720px (44px touch target — WCAG 2.5.5 Enhanced / HIG,
 * not a spacing token). Colour, never opacity, carries the disabled state — an
 * opacity multiplier on an already-quiet colour is what took the Kanban board's
 * disabled handle to 1.72:1 (TB8-06) and this surface's grip to 2.51:1 (TB8-07 §2.1).
 */
const ICON_BUTTON =
  "inline-grid place-items-center shrink-0 p-0 m-0 " +
  "size-[28px] max-[721px]:size-[44px] " +
  "bg-transparent border-0 rounded-[var(--radius-sm)] " +
  "text-foreground-secondary cursor-pointer " +
  "[font:var(--weight-regular)_var(--text-md)/1_var(--font-sans)] " +
  "transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] " +
  "hover:not-disabled:bg-secondary " +
  "focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid " +
  "focus-visible:outline-ring focus-visible:outline-offset-2 " +
  "disabled:text-[var(--text-muted)] disabled:bg-transparent disabled:cursor-not-allowed " +
  "aria-disabled:text-[var(--text-muted)] aria-disabled:cursor-default";

function IconButton({ className, ...props }: React.ComponentProps<"button">) {
  return <button type="button" data-slot="icon-button" className={cn(ICON_BUTTON, className)} {...props} />;
}

export { IconButton, ICON_BUTTON };
```

Notes the builder must not "clean up":

- `disabled:text-[var(--text-muted)]` is an **arbitrary value, deliberately**, not
  `text-muted-foreground`. It is the 3.57:1 graphical-object treatment §2.1 specifies, matching
  TB8-06's disabled handle. The 3:1 bar applies because these are glyphs, not text.
- Both `disabled:` and `aria-disabled:` are needed: the drag grip is disabled via
  `aria-disabled` (dnd-kit keeps it focusable), the popover triggers via the real attribute.
- `size-[28px]` (not 24px) because 28px is the smallest square that clears the 3:1 target-size
  guidance with the existing 18px glyphs and still fits five controls on a 1440 row.

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

/** The action row that closes a popover or a composer. */
export const POPOVER_ACTIONS = "flex flex-wrap items-center gap-[var(--space-2)] min-w-0";
```

`POPOVER_LABEL` replaces `.subtask-popover__content label` (:924), whose 11px un-uppercased grey
label is the only field label in the app that is not `FieldLabel`'s eyebrow.

### 4.3 The inward focus ring stays inward

app.css:892 exists because popover contents sit flush inside a bordered, `overflow: auto` panel,
so an `outline-offset: 2px` ring is clipped. That fact has not changed. Every control **inside**
an `AnchoredPopover` in this release uses `focus-visible:outline-offset-[-2px]`, overriding the
`+2px` its base constant sets. Spelled out per site in §5-§6; the builder must not omit it.

### 4.4 The unlayered-`app.css` trap

`styles/index.css` imports `app.css` **outside** every `@layer`, so any surviving legacy rule
beats a Tailwind utility regardless of specificity. Consequence for this release, stated as a
rule the builder follows without thinking:

> A class is either **retired from `app.css` in the same slice that stops using it**, or it is
> **kept as a non-styling hook only**. There is no third state. A component may not carry both a
> legacy class that still paints and the Tailwind utilities meant to replace it.

Where a class must survive as a test hook or a CSS-side selector target, it is converted to a
`data-*` attribute instead — the convention TB8-06 established (`data-*` conversions in its
slices 6-7). Named per site below.

### 4.5 Off-scale type → tokens (§2.6's answer)

| Was | Becomes | Note |
|---|---|---|
| 9px | `--text-2xs` (11px) | unread badge grows 18px → 20px to fit; assignee chip stays 24px (two initials at 11px ≈ 14px wide) |
| 10px | `--text-2xs` (11px) where the value is an eyebrow; `--text-xs` (12px) where it is body | per site below |
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

A comment above the block records that it is deliberately retained CSS and why (React does not
author ProseMirror's output), so the next sweep does not read it as an oversight.

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
| toggle `<button>` | `grid grid-cols-[minmax(0,1fr)_auto] w-full gap-x-[var(--space-3)] gap-y-[var(--space-1)] p-[var(--space-2)] min-h-[38px] max-[721px]:min-h-[44px] bg-transparent border-0 text-left cursor-pointer text-foreground transition-[background-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:bg-secondary focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2` |
| eyebrow span | `<Eyebrow>` (replaces `className="ey"`) |
| `__toggle-meta` | `flex items-center justify-end gap-[var(--space-2)]` |
| `__progress-text` | `[font:var(--type-h3)] tracking-[var(--tracking-tight)] text-foreground` |
| `__chevron` | `[font:var(--weight-regular)_var(--text-md)/1_var(--font-sans)] text-foreground-secondary` |
| `<progress>` | `col-span-full w-full h-[5px] [accent-color:var(--accent)]` |
| `__notice` | `min-h-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-destructive` |
| `__panel` | `grid gap-[var(--space-3)]`, collapsed → `hidden` |

**§2.6's 17px:** `.subtask-checklist__progress-text` currently overrides `--type-h3` down to 17px,
which makes "4 of 7 complete · 57%" the same weight as body text. It is the one number that says
whether the shoot is on track, and the full 28px Mazius is what the surface should lead with.
Restored to unmodified `--type-h3`. **This is a deliberate visual change, not a token
normalisation** — the gate must confirm it does not crowd the chevron at 390px (`--type-h3` at 28px
against a 44px chevron in a `minmax(0,1fr) auto` grid: it wraps to two lines before it collides,
which is acceptable and is why `gap-y-[var(--space-1)]` exists).

**`is-collapsed` → `hidden`.** The panel's collapsed state moves from a class to the plain
`hidden` attribute, matching the tab panels. `aria-hidden={!open}` is already on the element and
is unchanged; `aria-controls`/`aria-expanded` on the toggle are unchanged.

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

`__summary`:
- ≤720px: `grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-[var(--space-2)]` with the
  three meta controls on a **second** row spanning all columns
  (`col-span-full flex items-center gap-[var(--space-1)]`).
- ≥721px: `flex items-center gap-[var(--space-2)] min-w-0`, single line.

Implemented as one container with `flex max-[721px]:grid …` plus a meta wrapper
`contents max-[721px]:col-span-full max-[721px]:flex …`. The builder must verify in the browser
which of the two `display` utilities Tailwind emits last (**this repo has been bitten twice**:
`docs/lessons.md`, "Tailwind's emission order is not your class order"), and if the media-query
variant loses, split the container into an explicit `md:`-style pair rather than relying on order.

| Control | Treatment |
|---|---|
| grip | `<IconButton>` + `cursor-grab active:cursor-grabbing aria-disabled:cursor-default`. **`opacity: .5` deleted** (§2.1). |
| done checkbox | `<label>` wrapping `<Checkbox>` (`CHECKBOX_INPUT`, 18px, `accent-[var(--accent)]`) — `grid place-items-center min-h-[28px] max-[721px]:min-h-[44px] max-[721px]:min-w-[44px] cursor-pointer`. The `sr-only` "Mark X complete" span is unchanged. |
| title (read) | `flex-1 min-w-0 p-0 border-0 bg-transparent text-left cursor-pointer [font:var(--weight-regular)_var(--text-sm)/var(--leading-normal)_var(--font-sans)] text-foreground [overflow-wrap:anywhere] min-h-[28px] max-[721px]:min-h-[44px] focus-visible:outline-…offset-2`; done → `text-foreground-secondary line-through` (**9.20:1**, was 3.57) |
| title (editing) | `<Input className="flex-1 min-w-0">` — retires the hand-rolled box at `:908` |
| schedule / assignee triggers | `<IconButton>`, **always visible** |
| due pill | `<StatusPill tone="neutral">` — retires `.subtask-checklist__due` (:909) |
| assignee chip | `grid place-items-center size-[var(--space-5)] shrink-0 rounded-[var(--radius-pill)] bg-primary text-[var(--accent-on)] [font:var(--weight-regular)_var(--text-2xs)/1_var(--font-sans)] tracking-[0.02em]` (**18.64:1**) |
| overflow `⋯` | `<IconButton>`. **`opacity: .72` and the hover-reveal deleted.** |

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
Each gets `focus-visible:outline-offset-[-2px]` (§4.3).

- `__endpoint` `<fieldset>`: `grid gap-[var(--space-2)] min-w-0 p-[var(--space-2)] [border-style:solid] border-[length:var(--border-width-hair)] border-border`
- its `<legend>`: `px-[var(--space-1)] [font:var(--type-eyebrow)] uppercase tracking-[var(--tracking-wide)] text-foreground`
- `__fold` `<fieldset>`: same, `[border-style:dashed]`, `<legend>` `text-foreground-secondary`
- `__error`: `<Notice tone="critical">`
- `__conflict`: `<Notice tone="caution">` — **requires adding a `caution` tone to
  `components/quincy/Notice.tsx`**, `"border-signal-caution/35 bg-signal-caution/7 text-signal-caution-text"`,
  mirroring `StatusPill`'s existing caution split (border/wash keep the brand ochre, text takes
  the darkened value). **This is §2.4's fix**: the conflict block finally paints as a warning.
- the conflict `<dl>`: `grid gap-[var(--space-1)] m-0` with each `<div>`
  `flex items-baseline justify-between gap-[var(--space-3)]`, `<dt>` `POPOVER_LABEL`,
  `<dd>` `m-0 [font:…_var(--text-xs)/…] text-foreground`
- `__actions`: `POPOVER_ACTIONS`, buttons `buttonClasses("primary"|"secondary")` — retires the
  `min-height: 38px` override at `:934` **and its 44px `@media` counterpart at `:935-943`**,
  because `buttonClasses` BASE already ships `min-h-[38px] max-[721px]:min-h-[44px]`. The long
  comment at `:936-941` explaining the cascade ordering goes with them; a short note in the
  ledger records that the whole mechanism is obsolete, not that the lesson was forgotten.

**Assignee.** Search `<input type="search">` → `<Input>` (`focus-visible:outline-offset-[-2px]`).
`__members` → `grid overflow-auto min-w-0`. `__member` button:

```
grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-[var(--space-3)] w-full text-left
min-h-[44px] px-[var(--space-3)] py-[var(--space-2)]   /* 44px touch target — WCAG 2.5.5 Enhanced / HIG, not a spacing token */
bg-transparent border-0 [border-left-style:solid] border-l-[length:var(--border-width-bold)] border-l-transparent
text-foreground [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] cursor-pointer
hover:bg-secondary active:bg-surface-sunken
aria-current:border-l-border-strong
aria-selected:text-signal-positive
disabled:bg-surface-sunken disabled:text-foreground-secondary disabled:cursor-not-allowed
focus-visible:outline-[length:var(--border-width-bold)] focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-[-2px]
```

`<small>` → `text-foreground-secondary` (**9.20**, was 3.57). `border-l-border-strong` needs
`--color-border-strong` adding to the `@theme inline` block in `tokens/tailwind.css` — one line,
aliasing the existing `--border-strong`; it is the same left-rule selection marker
`.mention-autocomplete__option.is-active` uses, so both consumers get it.

**Actions.** The single Delete button → `buttonClasses("danger")`. It is a destructive action
behind a `confirm()`; `secondary` (its treatment today) understates it and the `danger` variant
exists precisely for this.

### 5.4 The composer

`<form>` `grid gap-[var(--space-2)]`; title `<input>` → `<Input>`; controls row →
`POPOVER_ACTIONS` with `<span className="flex-1" />` as the spacer (unchanged element, so the
`max-[601px]:hidden` behaviour at `:964` is preserved as a utility). `__composer-trigger` →
`<IconButton className="border-solid border-[length:var(--border-width-hair)] border-border">`,
which is what `:955` meant by `opacity: 1; border: …` once the hover-reveal is gone.
`__add-button`:

```
justify-self-start inline-flex items-center min-h-[38px] max-[721px]:min-h-[44px]
px-[var(--space-2)] py-[7px] bg-transparent
[border-style:solid] border-[length:var(--border-width-hair)] border-transparent
text-foreground-secondary [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] cursor-pointer
hover:border-border hover:bg-secondary hover:text-foreground
focus-visible:outline-…offset-2
```

The `@media (max-width: 600px)` block (`:958-966`) becomes `max-[601px]:` variants on the two
elements that need it. **600px, not 720px** — it is a different breakpoint from the app's usual
one and changing it is out of scope; the ledger records that it was preserved deliberately.

Loading and empty states (`.project-collaboration__state`) → `<EmptyState>` with
`tone="empty"`, `className="px-0 py-[var(--space-4)] text-left"` (the panel is 460px wide; the
default `--space-8` vertical padding and centred text are for a full page).

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
- `<time>` and `<small>Edited</small>`: `<Eyebrow>` (11px, **8.66:1**, was 10px at 3.57:1)
- external-editor badge: `<StatusPill tone="info">External editor</StatusPill>` (§2.7)

`__comments` container: `grid gap-[var(--space-5)]` — 24px, up from 12px. The rules need air; this
is the whitespace that replaces the deleted borders.

`__comment-actions`: `flex justify-end gap-[var(--space-3)]`. Edit and Delete become
`buttonClasses("text")`; Cancel and Save while editing stay `secondary` and `primary`. This
retires `:859`'s `min-height: 30px; font-size: 10px` override, which was the one place in the app
where a `.button` was smaller than the 44px phone floor (§2.3).

> **Builder check, not optional.** `buttonClasses("text")` sets `min-h-[32px]` in its variant
> string while BASE sets `max-[721px]:min-h-[44px]`. Whether the phone floor survives depends on
> Tailwind's *emission* order, not the order in the class string. Measure the computed height of
> an Edit button at 390px in the browser and report the number. If it is 32px, add an explicit
> `className="max-[721px]:min-h-[44px]"` at the call sites rather than editing `button.tsx`
> (which would change every text button in the app — out of scope).

`__comment-compose` `<form>`:
`grid gap-[var(--space-2)] pt-[var(--space-3)] [border-top-style:solid] border-t-[length:var(--border-width-hair)] border-t-border`;
its footer row `flex flex-wrap items-center justify-between gap-[var(--space-3)]` with the
"Use @ to mention project participants" hint as `<Eyebrow>` and the submit as
`buttonClasses("primary")`.

`__state` (loading / no-access / empty) → `<EmptyState>` as in §5.4.
`__read-anchor` keeps its 1px box exactly as-is — it is a scroll sentinel, not paint; class
retired, geometry moved to `className="w-px h-px m-0 overflow-hidden"` on the same element.
The `.notice` error divs → `<Notice tone="critical">`.

### 6.2 Activity

The same ledger, one level quieter — it is machine-written, so nothing in it is ever inked.

`<ol>`: `grid gap-[var(--space-4)] list-none m-0 p-0`
`<li> > <article>`: `grid gap-[var(--space-1)] min-w-0 ps-[var(--space-3)] [border-left-style:solid] border-l-[length:var(--border-width-hair)] border-l-border`
- `<header>`: `flex flex-wrap items-baseline gap-x-[var(--space-2)] gap-y-[var(--space-1)]`,
  title `<strong>` `[font:var(--weight-regular)_var(--text-sm)/1.2_var(--font-sans)] text-foreground`,
  actor + `<time>` as `<Eyebrow>`
- `<p>`: `m-0 [font:var(--weight-regular)_var(--text-xs)/var(--leading-normal)_var(--font-sans)] text-foreground-secondary`

Three states → `<EmptyState>` (`tone="error"` for the error state, which gives it the
3px destructive left rule and makes the ledger's own rule vocabulary carry the failure).
"Refreshing activity…" → `<Eyebrow role="status">`. `hasNextPage` button →
`buttonClasses("secondary")`, `justify-self-start`.

`.project-activity-view` / `__list` / `__item` / `__actor` paint nothing after this; all four
retire. `role="status"` / `role="alert"` / `aria-label` / `dateTime` are untouched.

### 6.3 `MentionAutocomplete`

Container `<div>`:
`[border-style:solid] border-[length:var(--border-width-hair)] border-border bg-card shadow-[var(--shadow-md)]`
(a floating listbox — the sanctioned elevation exception).
`__list`: `m-0 p-[var(--space-1)] list-none`.
`__option` button: the **same** string as `.subtask-popover__member` in §5.3, minus the
`grid-cols` (it is `flex items-baseline justify-between`) — the two are the same control
(a person-picker row) and after this release they share one treatment.
`.is-active` → `data-active` → `data-[active=true]:border-l-border-strong` (§4.4).
`__status`: `p-[var(--space-2)] [font:…_var(--text-xs)/…] text-foreground-secondary` (**9.20**).
`<small>` role text: `text-foreground-secondary capitalize`.

### 6.4 `RichTextEditor` chrome

| Element | Classes |
|---|---|
| root | `grid gap-[var(--space-2)]`; disabled → `data-disabled` → `data-[disabled=true]:opacity-65` (a whole-control disabled wash is legitimate; it is not stacked on a quiet colour) |
| `__toolbar` | `flex flex-wrap items-center gap-[var(--space-2)] p-[var(--space-1)] [border-style:solid] border-[length:var(--border-width-hair)] border-border bg-card` |
| `__toolbar-group` | `inline-flex flex-wrap gap-[var(--space-1)]` |
| `__toolbar-divider` | `w-px h-[var(--space-5)] bg-border shrink-0` |
| `__toolbar-button` | `ICON_BUTTON` + `[font:var(--weight-regular)_var(--text-xs)/1.2_var(--font-sans)] aria-pressed:bg-primary aria-pressed:text-[var(--accent-on)]` |
| `__toolbar-select` | `<NativeSelect className="min-w-[112px] w-auto">` |
| `__editor-content` | `FIELD_BOX` + `min-h-[var(--space-8)] bg-[var(--paper-050)] [&.is-editor-empty:first-child]:before:content-[attr(data-placeholder)] …:before:text-foreground-secondary …:before:float-left …:before:h-0 …:before:pointer-events-none` — **see the note below on where this string goes** |
| `__counter` | `text-right [font:…_var(--text-xs)/…] text-foreground-secondary`; over → `text-destructive` |
| `__validation` | `<FieldError>` (already `role="alert"`) |

**Where the editor-content class string actually goes.** `<EditorContent editor={editor} />`
(`RichTextEditor.tsx:399`) takes **no** `className` for this. The class is set through Tiptap at
`:228-229`:

```ts
editorProps: {
  attributes: { class: "rich-text__editor-content", "data-placeholder": placeholder, ...(id ? { id } : {}) },
},
```

The Tailwind string replaces that `class` value **in place**, in the `attributes` object. It is a
plain HTML `class` attribute on a ProseMirror-managed element, so:

- `cn()` is not available there — write the string as a single literal (or a module-level `const`
  next to the others), and do not try to merge it at render time.
- The `data-placeholder` attribute and the conditional `id` are untouched. `data-placeholder` is
  load-bearing: `content-[attr(data-placeholder)]` reads it.
- Tailwind's scanner must see the literal. It scans `.tsx` source, and a module-level `const`
  string literal is scanned fine — but a string **built** at runtime is not. Keep it literal.
- `is-editor-empty` is added to this same element by ProseMirror, which is why the placeholder
  variant is written as `[&.is-editor-empty:first-child]:before:…` rather than a `:empty` variant.

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

**R** = retired (deleted from `app.css`). **H** = kept as a non-styling hook (paints nothing).
**D** = converted to a `data-*` attribute. **K** = kept as CSS, deliberately, reason given.

| Lines | Selector(s) | Disp. |
|---|---|---|
| 407-450 | `.rich-text` **prose** half — `.rich-text`, `p`, `h2`, `h3`, `ul`, `ol`, `a`, `u`, `s`, `__task-list`, `__task-item`, `__task-indicator`, `__task-content`, `__mention`, and the four `__editor-content ul[data-type="taskList"]` rules | **K** — ProseMirror authors this markup; §1.3, §4.6 |
| 428-429 | `.rich-text-editor`, `.is-disabled` | **R** / **D** (`data-disabled`) |
| 430-440 | `.rich-text__toolbar`, `-group`, `-divider`, `-button` (+4 states), `-select` (+2 states) | **R** |
| 441-447 | `.rich-text__editor-content` and its `p`/`h2`/`h3`/`p+p`/`ul`/`ol`/placeholder rules | **R** for the box and placeholder; **K** for the four ProseMirror descendant rules (same reason as the prose half) |
| 448-450 | `.rich-text__counter`, `.is-over`, `__validation` | **R** |
| 455-463 | `.mention-autocomplete` and all 8 descendants; `.is-active` | **R**; `.is-active` → **D** (`data-active`) |
| 717 | `.project-collaboration-summary__team` @720 | **R** |
| 842-846 | `__wrap`, `__toggle`, `__unread`, `.project-collaboration`, `--overlay` | **K** (§7.1), except `__unread` → **R** |
| 847-850 | `__head`, overlay `__head`, `__head h2`, `__scroll` | **R** |
| 851-861 | `__state`, `__read-anchor`, `__comments`, `__comment` (+3 descendant rules), `__comment-actions` (+`.button`), `__comment-compose` (+`> div:last-child`) | **R** |
| 862-867 | `.project-collaboration-only`, `-summary` (+`h2`, `__facts`, `__team`, `.member`) | **R** |
| 213 | `.project-collaboration-summary .member em` | **R** — a scoped override whose scoping class this release deletes; it would otherwise dangle (§7.3) |
| 868-869 | `--standalone`, its `@min-width:1080px` width rule | **K** (§7.1) |
| 872-885 | `__tabs`, `__tab` (+3 states), `__panel`, `__panel[hidden]`, `.project-activity-view`, standalone tab/panel rules, the @720 block | **R** |
| 886-900 | `.subtask-checklist`, `__head h3`, `__toggle` (+2), `__progress-text`, `__toggle-meta`, `__chevron`, `__toggle progress`, `__panel`, `.is-collapsed`, `__notice`, `__items` | **R**; `.is-collapsed` → the `hidden` attribute |
| 890 | the 6-selector `:focus-visible` group | **R** — every member now carries its own ring |
| 891-892 | `.subtask-popover button/input:focus-visible` (the inward ring) | **R** — replaced by per-site `outline-offset-[-2px]` (§4.3). The *comment* at `:891` explaining why the ring is inward moves into `AnchoredPopover.tsx` beside `PANEL`; the fact outlives the rule. |
| 901-920 | `__item` (+3 modifier/state rules), `__summary`, `__title-trigger`, `__title`, done-title rule, `__done`, the shared input rule at `:908`, `__due`, `__assignee`, `__grip` (+2), `__metadata-trigger` (+3), `__overflow` (+1) | **R**; `--done`/`--dragging`/`--popover-open` → **D** |
| 921-932 | `__content` (+`label`), `__endpoint` (+`legend`), `__fold` (+`legend`,`label`), `__error`, `__conflict` (+`.button`) | **R** — including the class name itself; it has no DOM-test consumer (§5.3) |
| 933-943 | `__actions`/`__composer-controls`, `.button` 38px, the whole @720 44px block and its 6-line comment | **R** — obsolete: `buttonClasses` BASE ships both heights |
| 944-952 | `__member` (both rules), `__members`, 4 state rules, `small` | **R** |
| 953-957 | `__composer`, `__composer-controls > span`, `__composer-trigger`, `__add-button` (+hover) | **R** |
| 958-966 | the `@media (max-width: 600px)` block | **R** → `max-[601px]:` variants; the 600px breakpoint is **preserved deliberately** (§5.4) |
| 967-969 | the `@720` and `.app--impersonating` `__wrap` custom-property blocks | **K** (§7.1) |
| 178 | `.statetag` | **K** — shared with the media grid; this surface stops using it (§2.7) |
| 638-639 | `.empty` | **K** — shared app-wide; this surface stops using it |
| 775 | `.notice` | **K** — shared app-wide; this surface stops using it |

**Expected end state — the exact survivors, enumerated rather than counted:**

| Lines | What survives | Justified by |
|---|---|---|
| 408-427 | the 20 `.rich-text` prose rules | §1.3 |
| 443-446 | the 4 `.rich-text__editor-content` prose-descendant rules | §1.3 |
| 842, 843, 845, 846 | `__wrap`, `__toggle`, `.project-collaboration`, `--overlay` | §7.1 |
| 868, 869 | `--standalone` and its `@min-width:1080px` width rule | §7.1 |
| 967, 968, 969 | the `@720` and `.app--impersonating` custom-property blocks | §7.1 |

**33 rules, zero marked H.** Every one gets a one-line comment naming the section of this plan
that justifies it, so the next sweep reads them as decisions rather than leftovers. Any
collaboration, checklist, mention or rich-text-chrome selector in `app.css` that is not in this
table after slice 8 is a finding for the Sol diff review.

---

## 9. What must not change — behavioural invariants

The builder verifies each of these with a `className`-stripped diff against `main`, per slice:

1. Every `aria-label`, `aria-labelledby`, `aria-controls`, `aria-expanded`, `aria-selected`,
   `aria-current`, `aria-checked`, `aria-invalid`, `aria-describedby`, `aria-live`, `aria-hidden`,
   `role`, `id`, `htmlFor`, `dateTime` and `sr-only` span is byte-identical.
2. Every `disabled`, `hidden`, `tabIndex` and `autoFocus` expression is byte-identical.
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
10. **The Notice Board composer** (§1.2) renders correctly at all three viewports with the
    converted toolbar and content box.
11. **Zero console errors and zero failed requests** across the walk (in-flight `ERR_ABORTED`s on
    navigation excepted, per TB8-05/TB8-06 precedent).
12. **`app.css`'s surviving rules are exactly §8's 33**, each carrying its justifying comment.
13. `npm run typecheck` (6 workspaces), `npm run build -w @quincy/web`, and the full suite
    (`npm run test --workspaces` plus `npx vitest run --config packages/shared/vitest.config.ts`)
    are green with **zero** failures.

---

## 11. Slices

Bottom-up, per `Subagent-Frontend-Orchestration.md`. Each slice ends green on `typecheck` and
`build -w @quincy/web`; only slice 8 must satisfy the full gate. Each slice agent is given the
exact line ranges below **plus** §1, §3, §4 and §9 in full — those four are the shared constraint
sections every slice needs.

| # | Scope | Reads |
|---|---|---|
| 1 | `ui/icon-button.tsx` (new), `AnchoredPopover.tsx` constants, `Notice` gains `caution`, `--color-border-strong` in `tokens/tailwind.css` | §4 |
| 2 | `MentionAutocomplete.tsx`, `RichTextEditor.tsx` chrome, `app.css` rich-text token edits | §4.6, §6.3, §6.4 |
| 3 | `SubtaskChecklist.tsx` — head, toggle, progress, panel, notice, composer, add-button, states | §5.1, §5.4 |
| 4 | `SubtaskChecklist.tsx` — `SortableSubtaskRow` and the three popover controls | §5.2, §5.3 |
| 5 | `ProjectDiscussionThread.tsx` | §6.1 |
| 6 | `ProjectActivityView.tsx` | §6.2 |
| 7 | `ProjectCollaborationPanel.tsx`, `ProjectWorkspace.tsx`'s two collaboration functions | §7 |
| 8 | The `app.css` retirement ledger, test updates, docs | §8, §12 |

Slices 3 and 4 both edit `SubtaskChecklist.tsx` and run **in sequence**, not in parallel.

A slice reports: the diff, its own §9 check, `typecheck`/`build` output, and — for slices 2-7 —
the `className`-stripped semantic diff against `main` showing that nothing but class strings and
the named `data-*` conversions changed.

---

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

`docs/todo.md` gains a TB8-07 entry; `docs/lessons.md` gains the two new lesson candidates
(**an undefined custom property in an inherited property falls back to `inherit`, not to the
declaration above it**; **a hover-reveal affordance has no touch equivalent and fails outright on
the viewport it is most used on**) if the build confirms them.

---

## 13. Deferred, with an owner

| Item | Why | Owner |
|---|---|---|
| The remaining `--text-muted` paint sites app-wide | Global sweep; this release fixes only what it owns | `TB8-10` D-05 |
| `.button` → `buttonClasses()` across the app | 51 occurrences / 36 files; this release retires **19** of them (17 in the four components, 2 in `CollaborationOnly`), leaving 32 to re-measure | `TB8-10` D-06 |
| The Notice Board's own surface | Candidate #8; only its shared composer moves here | TB8-08 |
| Real assistive-technology verification of the new ledger semantics | No agent in this pipeline can drive a screen reader | The existing owner decision in `TB8-10`'s verification-debt table — this release adds a fourth row rather than a new question |
| `.subtask-popover__content` as a surviving hook | Retired once its DOM-test consumers move to `data-*`; not worth a test rewrite inside a visual release | `TB8-10` D-02/D-03 sweep |

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
