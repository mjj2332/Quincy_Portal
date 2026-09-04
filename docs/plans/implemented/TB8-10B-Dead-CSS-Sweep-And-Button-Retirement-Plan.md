# TB8-10B — The Dead-CSS Sweep and the `.button` Retirement

**Status: ALL DEPLOYED. §1 (`876fb239`). §2 (`2abd01ca`). §3 (`5eeea274`). §4 (`90bb0652`). §5
(`f0e41474`). D-05, D-06, D-07 all complete — TB8-10B is finished.** Second half of TB8 candidate
#10. Runs the frontend lane in
`docs/Subagent-Frontend-Orchestration.md`: this session drafts and holds the visual gate, Sol
reviews scope only, a Sonnet subagent builds.

**Evidence base:** `docs/plans/revamp_2026_portal/evidence/TB8-10B/drift-register.md`, measured
2026-09-04 on `main` at `3d25e55`. Read it before this plan — in particular its account of *how*
the dead/live question was measured, because four greps gave four answers and three were wrong.

**Owns:** D-05 (`--text-muted` contrast), D-06 (retire `.button`), D-07 (the base/Preflight
decision) from `TB8-10-Deferred-Defects-And-Cleanup-Sweep-Plan.md`. **Does not own D-08**, which
still needs the owner's decision on where the phone annotation toolbar lives.

---

## §0 — Why this is four releases, and why §1 ships alone

The re-measurement changed the shape of the work:

| Phase | Content | Character |
|---|---|---|
| **§1 — dead-CSS sweep** | 63 rules deleted, 1 selector edited | Deletion. **Visually inert by construction.** Independently shippable, today. |
| **§2 — `.button`, non-calendar** | 6 files, 19 tokens | Ordinary retirement onto `buttonClasses()`. |
| **§3 — `.button`, Production Calendar** | 8 files, 31 tokens | **A visual convergence release.** The calendar has never been through TB8; it runs on `production-calendar.css` from TB5C. Needs its own matched evidence and its own gate. |
| **§4 — `--text-muted` contrast** | 8 live text sites | Colour decisions on surfaces §2/§3 will have just touched. |
| **§5 — D-07** | the Preflight question | Answerable only once `app.css:585-600` is gone. |

**§1 is specified in full below and can be built and shipped on its own.** §2–§5 are scoped here
but deliberately not specified to implementation detail: §3's design decisions depend on evidence
that does not exist yet (nobody has photographed the calendar at the three viewports against the
design system), and writing implementation detail against absent evidence is how a plan defers a
decision to the builder while appearing not to.

---

## §0a — Sol round 1 (2026-09-04): 2 blocking, 2 non-blocking, all resolved

`codex exec -m gpt-5.6-sol -c model_reasoning_effort=high`, read-only. Sol reviewed the draft as it
stood before the owner's client-gallery decision, so some of its arithmetic addresses a version that
no longer exists; its *findings* all survive that change and are resolved here.

| # | Finding | Resolution |
|---|---|---|
| **B1** | `.search` occurs in **five** rule nodes, not four: the fifth is the `.search` arm of `.topnav, .search, .topbar__divider` at `:543`, whose other two arms are live. Deleting `:64-72` alone leaves dead CSS; applying "delete the whole rule" to `:543` breaks the phone topbar. The plan specified neither. | §1.2 now specifies the selector-list edit explicitly, as the release's only one. This session had found the same thing independently; Sol's value here was proving the draft did not *say* it. |
| **B2** | The size arithmetic was false, and acceptance 1-6 ("line count drops by the number of rules removed") is unsatisfiable — a rule can span several physical lines (`.search input` is `:65-70`). Sol's own family expansion found siblings the draft missed: `.trow__v`, `.ctab--premium`, `.ctab--premium svg`, `.copyread--client`. | §1.2 now carries the full mechanically-generated 63-rule table; 1-6 asks for rules-removed and lines-removed as separate figures. |
| NB1 | `.button` is **50** tokens across 14 files, not 48; non-calendar is **19** across 6 files, not 17. The two misses are base `button` tokens inside **template literals** (`CollectionPanel.tsx:206`, `ConfirmDialog.tsx:15`). | §0/§2 corrected to the parser figures. Non-blocking because §2 is not authorized for this build. |
| NB2 | The draft's account of the 32 non-comment `search` hits was incomplete — they also include calendar filter state, router types, `type="search"` and user-facing prose. | Noted; it does not change the deadness result, which Sol re-derived as zero class sinks. |

**Sol verified, and this session did not re-litigate:** all ten roots produce zero class sinks under
a full `@babel/parser` traversal of 101 non-test files (JSX/object `className`, `cn`/`clsx`,
template literals, concatenation, conditionals, variable bindings, `setAttribute`, `classList`); the
modifier-only siblings `.copyread--client`, `.trow__v`, `.ctab--premium` are equally dead; no
stylesheet outside `app.css` references any of them; `.rich-text u`/`s` are live and must stay; the
guard-baseline claim is exact; every `--text-muted` line number is right (19 = 9 dead + 2 decorative
+ 8 live text); `production-calendar.css` is unlayered and arrives via its own Vite chunk; and
deleting only dead rule nodes cannot unbalance an `@media` block or change a rendering.

---

## §1 — The dead-CSS sweep

### 1.1 What makes this safe, and the one thing that would make it unsafe

Every rule below has **no reachable consumer**: nothing in non-test `apps/web/src` emits the class.
Deleting an unreachable rule cannot change a rendering. The failure mode is not "the deletion looks
wrong" — it is "the measurement was wrong and the rule was live", which produces an invisible
regression on a surface nobody opened during the gate.

**So the builder re-measures rather than trusting this table.** The evidence register records three
different ways the measurement has already gone wrong here:

1. matching the `className=` attribute and then searching the extracted literal for quotes that are
   not in it (reported *everything* dead, including `.muted`);
2. reading only `"…"`/`'…'` literals and missing a class emitted from a **template literal**
   (reported `.rich-text` dead — it is live, `RichTextContent.tsx:56`);
3. a raw substring grep (reported `.ctab` live on the `ctab` inside **`selectable`**).

**Required method, per class, before deleting its rules:**

```
# (a) any occurrence at all, comments excluded — must be 0, or every hit explained
grep -rn "<class>" portal/apps/web/src --include='*.tsx' --include='*.ts' | grep -v '\.test\.'
# (b) the class as a whitespace-delimited token in a className/cn position, template literals
#     included — must be 0
```

A class is deletable only when (b) is 0 **and** every (a) hit is accounted for as something other
than a class (a substring, an id, a comment, an unrelated identifier). **Report the (a) hits and
their explanations for every class**; a bare "confirmed dead" is not evidence.

### 1.2 The deletions — including the client gallery, by owner decision

**This section was rewritten twice. Both revisions are recorded because the reasoning matters more
than the list.**

*First draft:* nine families with no class consumer, all deleted.

*Second draft:* enumerating them showed most were the **client delivery gallery** — a
`docs/PRD.md`-specified surface (§57, §112) that is not built, whose ported prototype CSS was
sitting in `app.css` waiting for it. Deleting an unbuilt-but-planned surface's design is well
outside a cleanup's authority, so the draft kept 48 rules and asked the owner.

*Owner decision, 2026-09-04:* **delete them.** The client gallery **is** going to be built, but on
the current stack — Tailwind utilities and the `components/ui` primitives — not on ported prototype
CSS. So this CSS is not scaffolding for the future surface; it is the *previous* design of a
surface that will be rebuilt, and keeping it would leave the next implementer a file of rules that
look authoritative and are not. `prototype/app/client.jsx` and `prototype/app.css` remain the visual
reference, exactly as `CLAUDE.md` says the prototype is reference-only.

That decision makes the sweep one thing again: **delete every rule with no reachable consumer.**

#### The one rule that is edited, not deleted

`app.css:543`, inside `@media (max-width: 720px)`:

```css
.topnav, .search, .topbar__divider { display: none; }
```

`.topnav` and `.topbar__divider` are **live** (`Topbar.tsx`). Remove `.search` from the selector
list and leave the rule. Deleting the line would break the phone topbar.

#### The one rule that is edited, not deleted

`app.css:543`, inside `@media (max-width: 720px)`:

```css
.topnav, .search, .topbar__divider { display: none; }
```

`.topnav` and `.topbar__divider` are **live** (`Topbar.tsx:180`). **Remove the `.search` arm and
leave the rule.** Deleting the line breaks the phone topbar. Found by this session and confirmed
independently by Sol r1 B1, which also noted that deleting only `:64-72` would leave dead `.search`
CSS behind.

Sol flagged `:463` as a second surgery case
(`.client--ink .premium-intro__p, .client--ink .premium-intro__stat .ey, .client--ink .premium-sec .cnt`).
Under the owner's decision every arm of it is dead, so it is a whole-rule delete. **`:543` is the
only selector-list edit in this release.**

#### The 63 whole-rule deletions

Verified two ways: this session's `classcheck.py` (a `className=`/`cn()` token parser over string
and template literals), and Sol r1's independent `@babel/parser` traversal of 101 non-test files
covering JSX `className`, object `className`, `cn`/`clsx` calls, template literals, concatenation,
conditional and logical expressions, local variable bindings, `setAttribute` and `classList`. Both
found **zero class sinks** for every root. Sol also confirmed no stylesheet outside `app.css`
references any of them.

**Twenty of these rules mention a class that IS live** — `.cnt`, `.ey`, `.serif`, `.is-on`,
`.is-active`, `.empty`, `.chip`, `.icbtn`, `.t`, `.d`, `.v`. Every one of them is a *descendant* of
a dead ancestor (`.ctab .cnt`, `.trow .ey`, `.optcard.is-on`, `.copyinput.serif`,
`.client--ink .empty .serif`, …), so the rule can never match. **This was checked mechanically:
every arm of every rule below requires at least one dead class.** Do not "rescue" these rules by
keeping them for their live descendant — the descendant has its own converged styling.

Line numbers are as of `ca538c1`. **Work bottom-up** so earlier deletions do not shift later ones,
and re-locate by selector if anything does not match.

| Line | Selector |
|---|---|
| 64 | `.search` |
| 65 | `.search input` |
| 71 | `.search input:focus` |
| 72 | `.search svg` |
| 305 | `.copyinput` |
| 306 | `.copyinput:focus` |
| 307 | `.copyinput.serif` |
| 308 | `.copyread` |
| 309 | `.copyread h2` |
| 310 | `.copyread p` |
| 311 | `.copyread ul` |
| 312 | `.copyread li` |
| 313 | `.copyread li::before` |
| 317 | `.doccard` |
| 320 | `.docpreview` |
| 321 | `.docpreview h2` |
| 322 | `.docpreview p` |
| 323 | `.docpreview ul` |
| 324 | `.docpreview li` |
| 325 | `.docpreview li::before` |
| 326 | `.client--ink .doccard` |
| 327 | `.client--ink .doccard__icon` |
| 328 | `.client--ink .doccard__b > div:first-child` |
| 329 | `.client--ink .copyread--client h2` |
| 330 | `.client--ink .copyread--client p, .client--ink .copyread--client li` |
| 333 | `.dropzone` |
| 334 | `.dropzone svg` |
| 413 | `.trow` |
| 414 | `.trow .ey` |
| 433 | `.chero` |
| 445 | `.cbar` |
| 447 | `.ctab .cnt` |
| 453 | `.premium-intro` |
| 459 | `.premium-sec` |
| 460 | `.premium-sec .cnt` |
| 461 | `.client--ink .premium-intro` |
| 462 | `.client--ink .premium-intro__h` |
| 463 | `.client--ink .premium-intro__p, .client--ink .premium-intro__stat .ey, .client--ink .premium-sec` |
| 464 | `.client--ink .premium-intro__stat .v` |
| 467 | `.cfoot` |
| 469 | `.cfoot img` |
| 470 | `.cfoot a` |
| 471 | `.cfoot a:hover` |
| 482 | `.optcard` |
| 483 | `.optcard:hover` |
| 484 | `.optcard.is-on` |
| 485 | `.optcard .t` |
| 486 | `.optcard .d` |
| 508 | `.client--ink` |
| 509 | `.client--ink .cbar` |
| 510 | `.client--ink .ctab` |
| 511 | `.client--ink .ctab:hover` |
| 512 | `.client--ink .ctab.is-active` |
| 513 | `.client--ink .ctab .cnt` |
| 514 | `.client--ink .chip` |
| 515 | `.client--ink .chip:hover` |
| 516 | `.client--ink .chip.is-active` |
| 517 | `.client--ink .icbtn` |
| 518 | `.client--ink .icbtn:hover` |
| 519 | `.client--ink .cgallery` |
| 520 | `.client--ink .empty` |
| 521 | `.client--ink .empty .serif` |
| 552 | `.cbar` |

#### What must survive

- **`.rich-text u` / `.rich-text s`** (`:373-374`) — live. `RichTextContent.tsx:56` emits the root
  from a template literal and renders `<u>`/`<s>` at lines 8–9; Sol confirmed the component is
  mounted by both the discussion thread and the Notice Board. They set `text-decoration-color`, a
  decorative role, not body text. **A careless sweep takes these.**
- `.topnav`, `.topbar__divider` (the `:543` survivors), `.muted`, `.empty`, `.kv`,
  `.project-team-picker*`, `.document-history`, `.upload-file`, `.tile*`, `.sr-only`.

#### Comments

**Delete each section comment with its section** — `app.css` carries headers such as
`/* ---- tweak: client gallery ink theme ---- */` above these runs, and a header left above
unrelated rules is worse than none. Report every comment removed. Do **not** leave a tombstone
comment naming the deleted families: the plan and this commit are the record, and `prototype/` keeps
the design.

### 1.3 The guard baseline

`SUPPRESSED_FOCUS_BASELINE` in `styles/design-system-guards.test.ts` carries exactly two entries:
`.search input:focus` and `.copyinput:focus`. Deletions 1 and 2 remove both selectors, so **both
entries must be deleted and the constant becomes `{}`**.

Keep the constant and both tests, exactly as TB8-10A did for the other two guards: the first test
then asserts that no suppression exists at all, and the baseline-honesty test iterates an empty
object and passes trivially, preserving the ratchet for the next person. Update the constant's doc
comment to say the list was cleared by TB8-10B.

**All three baselines then read `{}`** — the state the guard file was written to reach.

### 1.4 Acceptance

| # | Criterion |
|---|---|
| 1-1 | Every class in 1.2 re-verified by §1.1's method, with the (a) hits explained in the build report. |
| 1-2 | Each dead family removed **entirely**, with the per-family rule list reported. |
| 1-3 | `.rich-text u` / `.rich-text s` still present. |
| 1-4 | `SUPPRESSED_FOCUS_BASELINE` is `{}`; both tests kept; guards 6/6 green. |
| 1-5 | **Zero visual difference** at 1440×900, 1024×768, 390×844 — this is the gate's whole job here, since a wrong deletion is invisible except on the surface it breaks. |
| 1-6 | Exactly **63 rules deleted and 1 selector edited**; no comment orphaned above a deleted block. Do **not** expect the line count to fall by 63 — several of these rules span multiple physical lines (`.search input` alone is `:65-70`), so report rules-removed and lines-removed as two separate figures. |

Visual spot-checks at the gate should cover the surfaces whose *neighbours* were deleted, not the
deleted selectors themselves (which render nothing): the Dashboard, the project workspace collection
panel, the upload dropzone, the notice board's rich text, and the team picker.

---

## §2 — `.button` retirement, outside the calendar

6 files, **19** tokens: `screens/ProjectWorkspace.tsx` (6), `components/ConfirmDialog.tsx` (4),
`components/CollectionPanel.tsx` (3), `App.tsx` (2), `components/UploadDropzone.tsx` (2),
`components/ExternalEditedUpload.tsx` (2).

**Corrected by Sol r1 NB1** from 17. This session's token parser missed two base `button` tokens
that live in **template literals** — `CollectionPanel.tsx:206` and `ConfirmDialog.tsx:15`. Repo-wide
the figure is **50 tokens across 14 files** (`button` 28, `button--secondary` 15, `button--text` 6,
`button--danger` 1), not 48. Sol's `@babel/parser` count is authoritative; re-measure before
building §2 regardless.

Each moves to `buttonClasses()` with the variant its legacy class named — `button` → default,
`button--secondary` → `"secondary"`, `button--danger` → `"danger"`, `button--text` → `"text"`.

**The known trap, from TB8-07 and re-confirmed in TB8-09:** `buttonClasses("text")` carries **no
`min-width`** and its `min-h-[32px]` beats `BASE`'s `min-h-[38px]`, so a `"text"` button does not
reach a 44px touch target on its own. Any `button--text` site that is a real touch target needs an
explicit `min-w`/`min-h` at `max-[721px]`. Do not assume the variant handles it.

Specify per-site before building. Not detailed here.

---

## §3 — `.button` retirement, Production Calendar

8 files, 31 tokens. **This is a visual convergence release, not a migration.** The calendar has
never been through a TB8 candidate; `production-calendar.css` came from TB5C and is unlayered like
`app.css` (though it reaches the page through the component's own chunk, not `index.css` — see
TB8-10A §1.1).

**Prerequisite:** matched evidence at 1440×900, 1024×768 and 390×844 — what the calendar's controls
look like now against what the design system says they should. That evidence does not exist. Produce
it as its own step, the way every other TB8 candidate did, before writing implementation detail.

---

## §4 — `--text-muted` contrast, on what survives

8 live text sites after §1: `app.css:16`, `:21` `.muted`, `:245`
`.project-team-picker__option small`, `:246` `.project-team-picker__empty`, `:248` `.kv .k`, `:504`
`.empty`, `:628` `.document-history small`, `:637` `.upload-file span:last-child`.

`--text-muted` is `--greige-400` `#8f8775`: **3.6:1** on `--paper-000`, 3.5:1 on `--paper-050`,
2.9:1 on `--bg-sunken`. Converged surfaces moved their muted *text* to `text-foreground-secondary`.

**The register's 19 sites resolve as: 9 deleted by §1** (5 superseded-portal + 4 client-gallery:
`:313`, `:447`, `:460`, `:486`)**, 2 decorative** (`:373`/`:374`, `text-decoration-color`, not body
text)**, 8 live text — these.** That is the whole of D-05, and it is well under half of what the
deferred register implied.

Some of the 8 may be retired outright by §2/§3 rather than restyled. Re-measure after those land.

---

## §5 — D-07, the base/Preflight decision

The roadmap's open question since TB1: whether Tailwind Preflight stays disabled once the ported
`tokens/base.css` no longer has to co-exist with `app.css`. Answerable only after §2 and §3 remove
the button family — both are now deployed. **Read `docs/lessons.md` first** — the unlayered-cascade
trap and its second door through `tokens/base.css` (TB8-05) are why this is delicate rather than
mechanical.

This revises **approved D-16** ("controlled/disabled Preflight initially" — `Decision-Sheet.md`),
so it went to the owner rather than being decided in-session. Presented with one confirmed
regression, the owner chose to enable and fix rather than leave it parked. A fuller read of
Preflight's complete ruleset (not just the tags first checked) found two more confirmed
regressions; presented again, the owner reconfirmed **enable it — audit the rest and fix
everything**. That is this section's mandate.

### Mechanism

`index.css` declares `@layer theme, base, components, utilities;` and currently imports Tailwind's
`theme.css` and `utilities.css` but never `preflight.css`. Enabling Preflight is adding one import:

```css
@import "tailwindcss/preflight.css" layer(base);
```

Landing in `layer(base)` means Preflight loses to **every** Tailwind utility class and **every**
unlayered author rule (`app.css`, `production-calendar.css`, `tokens/base.css`) regardless of
selector specificity or source order — the layer order alone decides it. Preflight can only reach
an element/property pair that nothing else touches. That is why the audit below is organized by
Preflight rule, not by screen: each rule's blast radius is exactly "what does *not* already have
this property covered."

### Audit method

Built the app locally with the import added, diffed the emitted CSS against the production build
byte-for-byte (confirms exactly which Preflight rules survive into the bundle), then read Preflight's
full stylesheet from `node_modules/tailwindcss/preflight.css` rule-by-rule and, for every property it
touches, grepped the app for elements that rely on the browser default for that property with no
unlayered or utility-class coverage. Static grep evidence is corroborated below by ancestor-selector
tracing (checking the actual parent DOM element, not just the element's own className) — a plain
`grep '<h2'` undercounted twice in this exact release already (§1's BEM-child miss, D-05's
`.rich-text` template-literal miss), so every "uncovered" candidate below was traced to its real
parent before being called safe or unsafe.

### Confirmed regressions — must fix before enabling

| # | Preflight rule | What breaks | Where | Fix |
|---|---|---|---|---|
| 1 | `ol, ul, menu { list-style: none }` | `.rich-text ul`/`.rich-text ol` (`app.css:311`) set `margin`+`padding-left` but never `list-style` — Notice Board and discussion bullet/numbered lists lose their markers. The task-list variant (`.rich-text ul.rich-text__task-list`) already sets `list-style: none` itself and is unaffected either way. | Every rendered `bulletList`/`orderedList` node from `RichTextContent.tsx:39-41` | Add `list-style: disc` to `.rich-text ul` and `list-style: decimal` to `.rich-text ol` (or a combined rule with the two values on the shared selector's specific list-type). Confirmed in the built CSS diff: only the production build lacks `ol,ul,menu{list-style:none}`; the Preflight build has it. |
| 2 | `select { background-color: transparent; border: 0 solid; font: inherit }` | Two bare `<select>` elements carry no `className` at all — `production-calendar.css:177` sets only `max-width` on their wrapper selector. Today they render full native OS chrome (visible border, background) by browser default; Preflight would strip it to an invisible box with just the dropdown arrow. | `ProductionCalendarScheduleEditor.tsx:154,162` (checklist schedule state/endpoint-mode selects) | Give both selects the shared field styling — either `className={FIELD_BOX}` from `components/ui/input.tsx` (the pattern already used for every other select/input/textarea in the app) or an explicit `.qc-calendar-schedule-editor__state select` rule adding `background`/`border`/`font`. Prefer `FIELD_BOX`: it is the one place in the app a native form control skips the shared component, and nothing about the schedule editor's design calls for a different control. |

### Traced safe — do not touch

| Preflight rule | Why it can't reach anything live |
|---|---|
| `* { margin:0; padding:0; border:0 solid; box-sizing:border-box }` | `box-sizing` already matches `tokens/base.css`'s own universal rule (no-op). Every element that visibly depends on non-zero margin/padding/border already gets it from an unlayered rule or a utility class — confirmed for every heading, list, form control, and table checked below; no bare structural element (`fieldset`, `dl`, `blockquote`, `figure`) is used anywhere in non-test source. |
| `h1–h6 { font-size: inherit; font-weight: inherit }` | Every bare heading traced to its real parent resolves to an unlayered ancestor rule that sets the full `font` shorthand directly on that heading tag: `.pagehead h1`, `.workspace-intro h1`, `.qc-cal-filters__head h2`, `.qc-cal-event-card h4`, `.qc-calendar-unscheduled__row h3`, `.qc-calendar-unscheduled__section-head h2`, `.rich-text h2/h3`. The one heading with no ancestor rule (`SubtaskChecklist.tsx:329`'s `<h3 className="m-0">`) contains no text of its own — every descendant (`Eyebrow`, the progress label span) carries its own explicit `[font:…]` utility, so nothing inherits the h3's font-size. Every remaining heading sets `[font:…]` directly in its own `className`. |
| `a { color: inherit; text-decoration: inherit }` | `tokens/base.css` already sets `a { color: inherit }` unlayered (no-op, same value). `text-decoration: inherit` needs a live check, not a grep verdict — see Open question below. Every `<a>` this audit could trace to a specific rule is already covered: `.rich-text a`, `.qc-cal-event-card__project-link`, `.document-title`, `.document-history a` (descendant selector — covers the version-history links even though they carry no `className` of their own) all set `text-decoration: none` explicitly, unlayered. |
| `table { border-collapse: collapse; text-indent: 0 }` | `components/ui/table.tsx`'s `Table` sets `border-collapse` via the Tailwind utility `border-collapse` directly — utilities beat base regardless of the property already being set there. No other `<table>` exists in non-test source. |
| `img, svg, video, canvas, iframe, embed, object { display:block; vertical-align:middle }` / `img, video { max-width:100%; height:auto }` | `img` already has an identical unlayered rule (`app.css:11`, no-op). Only 3 files render raw `<svg>`: two are flex items (`flex:none` in app.css, or `shrink-0`/`size-[…]` utility classes — flexbox blockifies its children regardless of their own `display`, so `inline`→`block` is a no-op there too) and the third (`Lightbox.tsx`'s `.markup-svg`) is `position:absolute`, which the CSS spec blockifies unconditionally regardless of Preflight. The one un-sized bell icon (`Topbar.tsx:206`) is sized by a `[&_svg]:size-[19px]` utility on its trigger wrapper — a layered rule, wins regardless. |
| `button, input, ::file-selector-button { font:inherit; border-radius:0; background-color:transparent; opacity:1 }` (the input/select/textarea/optgroup half not already covered above) | Every `<input>`/`<textarea>` in non-test source renders through `Input`/`Textarea` (`components/ui/input.tsx`, `components/ui/textarea.tsx`), both built on the shared `FIELD_BOX` constant, which sets `bg-[…]`, `border-…`, and the full `[font:…]` shorthand as Tailwind utilities. Every `<button>` renders through `buttonClasses()` or carries its own utility classes covering the same properties (`.chip`, `.icbtn`, calendar `.qc-cal-*` component classes) — confirmed zero bare, unstyled `<button>` in non-test source. |

### Open question — resolve by live render, not by grep

`.chip` (`app.css:81-89`, used on both `<button>` and `<InternalLink>`/`<a>` — e.g. the "← Dashboard"
link and every AutoHDR "Retry"/document "Delete" chip) sets `font`, `border`, `background`,
`border-radius`, `color` directly but never `text-decoration`. **This means a `.chip` rendered as an
`<a>` may already be showing a browser-default underline today, independent of Preflight** — nothing
in the current unlayered CSS suppresses it. If so, enabling Preflight's `text-decoration: inherit`
would *fix* a pre-existing latent defect, not introduce a regression. This is exactly the kind of
claim this release's own evidence discipline says not to settle by reasoning: check the computed
`text-decoration-line` on a live `.chip`-as-`<a>` both before and after the Preflight import, at
1440×900. Record the answer as evidence in the build record, whichever way it comes out — no CSS
change either way unless the "before" state turns out to already be underlined and the visual gate
judges that an existing defect worth fixing in the same release.

### Build sequence

1. Add the two confirmed fixes (list-style, schedule-editor selects) first, independent of Preflight
   — they're correct regardless of D-07's outcome, and building them first means the Preflight-on
   diff should be empty everywhere except the deliberately-scoped `.chip`-as-link question.
2. Add the one-line `@import "tailwindcss/preflight.css" layer(base);` to `index.css`.
3. Rebuild, diff the emitted CSS against the pre-Preflight build to confirm the only new rules are
   the ones this audit predicted (no surprise survivors).
4. Visual gate at 1440×900, 1024×768, 390×844 across: Dashboard (search box, toolbar, Kanban),
   Project Workspace (pagehead, workspace-intro heading, AutoHDR hdr block, chip buttons/links,
   document history version list), Notice Board or a discussion thread with a bullet list, ordered
   list, and task list all present, Production Calendar (toolbar, filters panel including the "Clear
   filters" text button, unscheduled panel, a schedule-editor popover with both selects open, an
   event card), Admin. Read every computed style this audit named, not just a screenshot compare —
   this session's own lesson (§4 of this same document) is that a screenshot can miss what a computed
   value catches.
5. Sol scope review on this section before building, per the frontend pipeline.

---

## §11 — §5 build record and gate (2026-09-04) — **PASSED**

Sol's scope review (before building, per the corrected sequence) found **5 blocking, 5 non-blocking**
against the spec above. Every blocking finding was a real gap this audit's own method should have
caught and didn't:

1. **The live Tiptap editor** (`.rich-text__editor-content ul/ol`) has the identical list-marker
   defect as the read-only render path — missed because the audit traced `RichTextContent.tsx` but
   not `RichTextEditor.tsx`.
2. **Four bare date/time inputs** (`ProductionCalendarScheduleEditor.tsx:116`,
   `ProductionCalendarMoveDialog.tsx:54-55`) have the identical stripped-chrome defect as the two
   bare selects — missed because the audit searched for bare `<select>` but not bare `<input>`.
3. **Inherited `letter-spacing`** — Preflight's form-control rule resets more than `font`; `FIELD_BOX`,
   `RAIL_FIELD`, and `RichTextEditor.tsx`'s separate `FIELD_INPUT` constant all set the font shorthand
   but never `letter-spacing`, so any control nested inside a tracked-uppercase label (checklist
   popovers, the Deadline rail, calendar labels) would silently inherit that tracking.
4. **A bundle diff proves the wrong thing.** Confirming Preflight's rules are present in the built CSS
   says nothing about which declaration wins on a live element — that requires reading computed styles
   on real or synthetic DOM, which is what this record does below.
5. **Sequencing and gate completeness** — Sol review belongs before building (the doc's own step order
   listed it last), and the named visual-gate surfaces omitted several states this audit's own logic
   should have flagged (composer/edit-mode lists, disabled controls, glyph-only icon buttons).

### Fixes applied, beyond the original two

| Fix | File |
|---|---|
| `.rich-text__editor-content ul`/`ol`: `list-style: disc`/`decimal`, `padding-left: 22px` (task-list variant untouched, still wins on specificity) | `app.css` |
| `.qc-calendar-schedule-editor__endpoint input`, `.qc-calendar-move-dialog__inputs input`: explicit `border`/`background`/`font`/`letter-spacing`/`padding`, matching the existing schedule-editor select treatment | `production-calendar.css` |
| `FIELD_BOX` (covers `Input`/`Textarea`/`NativeSelect` — and therefore the SubtaskChecklist popover controls Sol named): added `tracking-normal` | `components/ui/input.tsx` |
| `RAIL_FIELD` (Deadline rail, CollectionPanel link form): added `tracking-normal` | `lib/rail-field.ts` |
| `FIELD_INPUT` (RichTextEditor's own link-dialog input, a third independent field constant Sol's audit surfaced): added `tracking-normal` | `components/RichTextEditor.tsx` |
| `.icbtn` (PhotoGrid's glyph-only review/flag/recommend/select/cover/delete buttons — direct text nodes with no font coverage): added `font: 16px/1 var(--font-sans)` | `app.css` |

`.selbox` was checked and already carries a full `font: 700 15px/1 var(--font-sans)` — no change
needed. Radio/checkbox inputs (the fold-choice controls, calendar filter checkboxes) were checked and
confirmed exempt: native `appearance: auto` widgets ignore `border`/`background`/`border-radius` CSS
regardless of Preflight, so no fix applies there.

### Verification — computed styles, not a bundle diff

Built locally with `@import "tailwindcss/preflight.css" layer(base);` added to `index.css`, against
the running local-dev worker (`localhost:8787`, signed in as seeded admin). Two methods, both live:

**Synthetic DOM injection** (element created with the exact class/tag structure, appended to
`document.body` in the running page, computed style read, removed) for the calendar's schedule-editor
select and all four date/time inputs, confirmed on the actual page (not a static analysis) after
navigating to a real Production Calendar view so `production-calendar.css` was genuinely loaded:
every one now computes `border: 1px solid`, `background: rgb(255,255,255)`, `font: 13px/16.9px`,
`letter-spacing: normal` — restored, not stripped.

**Real user flow, no synthetic DOM at all**: opened a live project's Discussion tab, typed into the
actual Tiptap editor, clicked the real "• List" toolbar button. The resulting live `<ul>` computed
`list-style-type: disc; padding-left: 22px` and rendered a visible bullet in a screenshot — the
identical fix confirmed through the product's real interaction path, the strongest evidence available
short of the deployed site itself.

**Whole-page sweep** (every `ul`/`ol`, `button`/`select`/`input`/`textarea`, `a`, `h1`–`h6` on the
page, computed styles read and scanned for anomaly signatures — a list with `list-style-type: none`
outside the task-list variant, or a native text-like input/select with both zero border and
transparent background) run on the Project Workspace (62 controls, 6 anchors, 6 headings) and the
Production Calendar (51 controls, 14 anchors, 13 headings, including live event cards): **zero
list-marker-lost, zero control-stripped** on either page. The only `control-stripped` hit anywhere was
a `.sr-only` (visually hidden) file-input trigger — expected and harmless, not a regression.

### The open question, resolved

`.chip`-as-`<a>` (`ProjectWorkspace.tsx:491`, "← Dashboard"): measured on the same live page,
Preflight off vs on. **Before: `text-decoration-line: underline`. After: `none`.** Confirms Sol's
non-blocking finding #4 exactly — this was a pre-existing latent defect (the pill-shaped chip has
always rendered a stray browser-default underline; nothing in `app.css` ever suppressed it), and
enabling Preflight silently fixes it rather than introducing a regression. No CSS change needed; this
is a welcome side effect, recorded here as evidence rather than left as an assumption.

### Gate

typecheck 0 · build 0 (with the Preflight import present) · **115 / 227 / 726 / 296+1skip / 253 / 13
unchanged**, `packages/shared` 144 unchanged — no count moved, consistent with a pure CSS/cascade
change touching no test-observed behavior.

---

## §6 — Gate (for §1; §2–§5 gate themselves when specified)

1. `npm run typecheck` from `portal/` — **check the exit code, not a grep of the output.** `tsc`'s
   ANSI colouring puts escape codes between `error` and `TS`, so `grep -c "error TS"` reports 0 on a
   failing run and a pipe discards the exit status.
2. `npm run test --workspaces` — 115 / 227 / 726 / 296+1skip / 253 / 13 today. A nonzero exit for
   `@quincy/shared`'s missing `test` script is pre-existing and documented in `CLAUDE.md`; anything
   else is a failure. **§1 should not move any count** — if a test breaks, a deletion was wrong.
3. `npx vitest run --config packages/shared/vitest.config.ts` — 144.
4. `npm run build -w @quincy/web`.
5. Guards 6/6, all three baselines `{}`.
6. The visual pass at the three viewports — this session's own, not delegated.


---

## §7 — §1 build record and gate (2026-09-04) — **PASSED**

Built by this session directly, after the delegated builder was stopped. Its last action before
stopping was to question two neighbours — `.doccard__icon` and a `.cgallery` base rule — while
cross-referencing the plan's table against the file. **It was right, and that turned out to be the
release's most important finding.**

### The plan's 63 was an undercount, for a reason worth recording

§1.2's table was generated from a root list matched with `\.root(?![\w-])`. `_` is a word
character, so that pattern **excludes every BEM child of its own roots** — `.doccard__icon`,
`.doccard__b`, `.chero__scrim`, `.cfoot__top`, `.premium-intro__stat` and the rest were silently
outside the enumeration even though their parents were in it. The rules were dead; the table just
did not list them.

Re-derived by enumerating **every class in `app.css`** (226 of them), classifying each, and then
scoping to the plan's families **plus their BEM children** — 42 classes, every one verified dead by
both `classcheck.py` and a word-boundary raw grep. `search`'s only surviving hits are
`calendarState.search`, an object property.

**Final: 100 whole-rule deletions, 1 selector edit, 112 physical lines, 7 section comments.**
`app.css` 683 → 562 lines.

This is the fourth distinct way this measurement has gone wrong in this release, and the second
caused by a regex that looked right. The rule that keeps holding: **enumerate the file and classify
what you find; never enumerate from a list you wrote yourself.**

### The selector edit

```
line 543 before:  .topnav, .search, .topbar__divider { display: none; }
line 425 after :  .topnav, .topbar__divider { display: none; }
```

Verified in the browser: `.topnav` and `.topbar__divider` compute `display: flex` / `block` at 1440
and 1024, and `display: none` at 390 — identical to before. This was the release's only route to a
rendering regression.

### Comments removed (7)

`search`, `comment count pin on tile` (it belonged to `.cbubble`, not the live `.pin` — checked
against the backup), `copywriting`, `document (PDF) card`, `dropzone`, `premium section`,
`tweak: client gallery ink theme`.

### Survivors confirmed

`.rich-text u` / `.rich-text s` (now `:323-324`), `.pin` (`:259`), `.topnav`, `.topbar__divider`,
`.muted`, `.empty`, `.kv`, `.upload-zone`, `.tile*`. No in-scope class remains anywhere in the file.

### Gate

typecheck 0 · build 0 · **115 / 227 / 726 / 296+1skip / 253 / 13**, `packages/shared` 144 —
**no count moved**, which is the correctness condition for a pure deletion · guards 6/6 with **all
three baselines now `{}`** · braces balanced (335/335), comments balanced (53/53), 10 `@media`
blocks intact.

Visual pass at 1440×900, 1024×768, 390×844 on local dev: no horizontal overflow at any width, board
and project workspace render unchanged, every live neighbour of a deleted rule still resolves its
own styles (`.muted` `rgb(143,135,117)`, `.empty`, `.kv`, `.rich-text` 14px). **0 console
errors, 0 failed requests** across the dashboard and the project workspace.


---

## §8 — §2 build record and gate (2026-09-04) — **PASSED**

Built directly by this session. Re-measured before building: this session's own token count (17)
was itself wrong for the same reason Sol's B2 finding predicted — a naive `className={...}` regex
using `[^}]*` truncates at the **first** `}`, which is inside `${danger ? " button--danger" : ""}`
long before the JSX expression actually closes. Rebuilt with brace-balanced extraction and got
Sol's figure exactly: **19 tokens, 6 files.**

### The 10 sites, variant mapping

All eight `.button`/`.button--secondary`/`.button--danger` **elements** across 10 usages (some
sites have 2 legacy classes on one element) map onto `buttonClasses()` one-to-one — no
`button--text` sites in this scope, so TB8-07's known 44px trap does not apply here:

| File | Site | Legacy | `buttonClasses()` |
|---|---|---|---|
| `App.tsx` | not-found/reserved return link | `button button--secondary` | `buttonClasses("secondary")` |
| `ConfirmDialog.tsx` | Cancel | `button button--secondary` | `buttonClasses("secondary")` |
| `ConfirmDialog.tsx` | Confirm | `` `button${danger?" button--danger":""}` `` | `buttonClasses(danger ? "danger" : "primary")` |
| `CollectionPanel.tsx` | Upload (video/floorplan/copy) | `button` | `buttonClasses()` |
| `CollectionPanel.tsx` | Approve/Unapprove | `` `button ${approved?"button--secondary":""}` `` | `buttonClasses(approved ? "secondary" : "primary")` |
| `UploadDropzone.tsx` | Choose files | `button button--secondary` | `buttonClasses("secondary")` |
| `ExternalEditedUpload.tsx` | Choose files | `button button--secondary` | `buttonClasses("secondary")` |
| `ProjectWorkspace.tsx` | Back to dashboard | `button button--secondary` | `buttonClasses("secondary")` |
| `ProjectWorkspace.tsx` | Retry (load error) | `button` | `buttonClasses()` |
| `ProjectWorkspace.tsx` | Download selected (zip) | `button button--secondary` | `buttonClasses("secondary")` |
| `ProjectWorkspace.tsx` | Send to AutoHDR | `button` | `buttonClasses()` |

Bare `.button` (`app.css:589`, ink-900 fill) maps to the **default/primary** variant — confirmed
against the legacy rule, not assumed.

### Two tests asserted the retired class name, not the design-system contract

Both fixed to assert the actual contract instead of an implementation detail:

- `ConfirmDialog.dom.test.tsx` — `classList.contains("button--danger")` → `className` contains
  `text-destructive` (both the positive and negative case).
- `ProjectWorkspace.dom.test.tsx` — the button-download test selected `.hdr .button`; updated to
  `.hdr button`, since `buttonClasses()` carries no stable class hook and `.hdr` itself is untouched.

### Gate

typecheck 0 · build 0 · **726 / 726 unchanged** across all six web-adjacent suites, `packages/shared`
144 — pure retirement, no count moved except the two test edits above, which assert the same
behaviour through a different selector. `.button` in `app.css` now has **zero non-calendar
consumers** (`classcheck.py button` → only `ProductionCalendar.tsx`, `ProductionCalendarEvent.tsx`,
§3's scope).

Visual, local dev: the Admin "Deactivate" confirm dialog renders `buttonClasses("secondary")` /
`buttonClasses("danger")` correctly — outlined critical red for Deactivate, matching the legacy
`.button--danger` look; both buttons carry the shared `buttonClasses()` base (`min-h-[38px]`,
`focus-visible` ring, `disabled` treatment) that the legacy rule never had.


---

## §3 — `.button` retirement, Production Calendar (implementation detail, 2026-09-04)

31 tokens, 8 files (per Sol's `@babel/parser` count in §0a). Unlike §2, **three of these sites use
`button--text`** — the variant TB8-07 found has no `min-width` and a `min-h-[32px]` that beats
`BASE`'s `min-h-[38px]`, so it cannot reach 44px on its own. This section verifies, rather than
assumes, that the calendar's own CSS already carries the touch target for exactly those sites.

### 3.1 The one real risk: an unlayered rule keyed on the literal `.button` class

`production-calendar.css` has exactly one selector that names `.button` directly:

```css
@media (max-width: 420px) {
  .qc-cal-filters__head .button { align-self: start; }
}
```

`ProductionCalendarFilters.tsx:97`'s "Clear filters" is the only button in that header. At ≤420px
the header becomes `flex-direction: column` with `align-items: stretch`; this rule opts the button
back out to `align-self: start` so it stays compact rather than stretching full-width. **420px is
inside this repo's 390px fixed viewport.** Retiring `.button` off that element without fixing this
selector regresses the phone layout.

**Fix:** change the selector to `.qc-cal-filters__head button` (tag, not class) — it is the only
button in that container, verified by reading the component. No other file in `styles/` references
`.button`/`.button--*` (confirmed: `grep -n '\.button\b\|\.button--' production-calendar.css`
returns only this one line).

### 3.2 Verified by measuring computed styles before touching any code

Three structural cases exist, and each was measured live (CDP, local dev) rather than reasoned
about statically, because `production-calendar.css` is unlayered — same trap as `app.css` — so a
merely-plausible cascade argument is not good enough here.

**Case A — bare `.button`/`.button--secondary`, no calendar-specific override** (toolbar Prev/Today/
Next, the two dialog Cancel buttons' pattern, `ProductionCalendar.tsx`'s Refresh/Try again):
measured padding `9px 14px`, font-size 12px, min-height 38px, enabled state identical to `BASE` +
`secondary`. `buttonClasses("secondary")` / `buttonClasses()` reproduce this exactly for every site
**except two things, both corrected by Sol r1 (§3.2a) and both deliberate:**

- **Disabled paint changes** on every disabled site (Fold Choice submit, Move submit, Clear
  Filters, the two unscheduled-action buttons) from a faded variant colour to `buttonClasses()`'s
  fixed disabled treatment — already the shipped behaviour on three §2 sites, not a calendar-only
  change.
- **`.qc-calendar-state`'s "Try again"** (not "Refresh", which sits in the covered
  `.qc-calendar-recovery`) goes from 38px to 44px at ≤721px, because it was never in the
  touch-target media query's selector list — a pre-existing gap this migration closes, matching
  the 44px "Refresh" one state over.

**Case B — `.button--text` plus a calendar-specific hook class that already sets its own paint**
(`.qc-cal-event-card__move`, `.qc-calendar-unscheduled__action` — both `margin-top; padding: 0;
font-size: 11px`, and both get `min-width/min-height: 44px` at `(pointer: coarse), (max-width:
720px)` keyed on the **hook class**, not on `.button`). Measured: padding 0, font-size 11px,
min-height 32px at desktop; 44×44 with `padding: 8px 4px` at 390px. **Keep the hook class, drop only
`button`/`button--text`.** Because the hook class's rules are unlayered and `buttonClasses()`'s are
Tailwind utilities, the hook class keeps winning on every property it sets — padding and font-size
are unaffected — and the touch-target media query, keyed on the hook class, is untouched by the
swap. Only `min-height` at desktop and `color` are not set by the hook class; `buttonClasses("text")`
supplies both, at `min-h-[32px]` (matches current, since nothing unlayered contests it once
`.button--text` is gone) and `!text-foreground-secondary` (verified `--foreground-secondary` is a
plain alias for `--text-secondary` in `tokens/colors.css:80` — the same value `.button--text`'s
`color: var(--text-secondary)` produces today, and the `!` wins regardless of layer).

**Case C — bare `.button--text`, no calendar-specific class** (`ProductionCalendarFilters.tsx:97`,
"Clear filters"): measured padding `6px 0px`, font-size 12px, min-height 32px→44px. Nothing
unlayered contests this element once `.button`/`.button--text` are gone, so `buttonClasses("text")`'s
own `px-0 py-[6px]` applies uncontested — **identical computed padding**. The ≤420px `align-self`
regression is §3.1's fix, applied here.

### 3.2a Sol round 1: 2 blocking, 2 non-blocking, both resolved

`codex exec -m gpt-5.6-sol -c model_reasoning_effort=high`, read-only.

**B1 — disabled-state paint is not identical, and §3.2's "identical" claim was wrong to say so.**
Legacy `.button:disabled` keeps the variant's own colours and fades to `opacity: .62`
(`app.css:468-482`); `buttonClasses()`'s disabled state swaps to a different, fixed treatment —
`disabled:!text-foreground-secondary disabled:bg-surface-sunken disabled:border-border` — regardless
of variant. Real sites in scope: the initially-disabled Fold Choice submit, the invalid-state Move
Deadline submit, Clear Filters when there is nothing to clear, and the unscheduled-action buttons
when their entry is not actionable.

**Resolution: this is not a new inconsistency to design around — it is already live production
behaviour.** §2 (shipped as app Worker `2abd01ca`, hours before this review) put exactly this same
disabled treatment on `UploadDropzone.tsx`'s and `ExternalEditedUpload.tsx`'s "Choose files"
(`disabled={isUploading}`/`disabled={busy}`) and `ProjectWorkspace.tsx`'s "Download selected (zip)"/
"Send to AutoHDR" (`disabled={selectionCount === 0}`, `disabled={... isSending ...}`) with no special
casing and no incident. `buttonClasses()`'s disabled look **is** the converged design-system
treatment for a disabled control, app-wide, not an exception the calendar needs to be shielded from.
Corrected in §3.2 below; added as acceptance 3-7 so it is checked deliberately at the gate rather
than assumed.

**B2 — "Try again" is 38px tall at 390px today, not 44px, and would become 44px after migration.**
`.qc-calendar-state` (`production-calendar.css:131`, the container both "Try again" and "Refresh"
sit in — no, only "Try again"; "Refresh" is in `.qc-calendar-recovery`, which **is** covered) is
**absent from the touch-target media query's selector list** (`production-calendar.css:231-236`
names `.qc-cal-event-card__move`, `.qc-calendar-unscheduled__action`, `.qc-cal-toolbar button`,
`.qc-cal-filters button`, `.qc-calendar-recovery button`, `[data-modal-variant="calendar"] button`
— `.qc-calendar-state` is not among them). Today's 38px comes from legacy `.button`'s own
`min-height: 38px` with nothing raising it at 390px. After migration, `buttonClasses()`'s
`max-[721px]:min-h-[44px]` applies uncontested (nothing unlayered in `.qc-calendar-state` claims
`min-height`), producing 44px.

**Resolution: accept it, and name it as a fix, not a side effect.** This repo's own touch-target
contract (`CLAUDE.md`: 44px at ≤720px) already applies to every sibling control in this file — the
identical "Refresh" button one state over is already 44px on phone. `.qc-calendar-state` missing
that coverage was TB5C's oversight, not a design decision to preserve. §3.2's Case A is corrected to
carve this one control out explicitly rather than claim uniform pixel identity across all of Case A.

**Non-blocking, both fixed:**
- NB1 — `ProductionCalendar-deadline.dom.test.tsx:434,436` selects
  `.button[data-focus-key="calendar-recovery"]` for the Refresh button. Update to
  `[data-focus-key="calendar-recovery"]` alone (the attribute is already unique in that tree; the
  runtime focus-recovery lookup Sol found at `ProductionCalendar.tsx:717` already has a
  class-independent fallback, so behaviour is unaffected — only the test selector needs to drop the
  class).
- NB2 — §3.1's "no other file in `styles/` references `.button`/`.button--*`" meant *besides
  `app.css` itself* (the source these rules are being retired from). Reworded for precision; no
  content change.

Sol confirmed everything else: the unlayered-cascade premise; `.qc-cal-filters__head .button` is
the sweep's only hit and `button` (tag) is safe because Clear Filters is the header's only button;
Case B's two properties and the touch-target coverage for both hook classes; the colour alias is
exact; all 14 table rows checked against the file, variant mappings correct; `min-h-[32px]` is a
plain (non-important) utility, so the text variant's override behaves as claimed.

### 3.3 The 11 sites

| File | Line | Legacy | `buttonClasses()` | Case |
|---|---|---|---|---|
| `ProductionCalendarToolbar.tsx` | 85 | `button button--secondary` (Prev) | `buttonClasses("secondary")` | A |
| `ProductionCalendarToolbar.tsx` | 86 | `button button--secondary` (Today) | `buttonClasses("secondary")` | A |
| `ProductionCalendarToolbar.tsx` | 87 | `button button--secondary` (Next) | `buttonClasses("secondary")` | A |
| `ProductionCalendarEvent.tsx` | 105, 122, 142 | `button button--text qc-cal-event-card__move` | `buttonClasses("text", { className: "qc-cal-event-card__move" })` | B |
| `ProductionCalendar.tsx` | 1558 | `button button--secondary` (Refresh) | `buttonClasses("secondary")` | A |
| `ProductionCalendar.tsx` | 1565 | `button button--secondary` (Try again) | `buttonClasses("secondary")` | A |
| `ProductionCalendarUnscheduledPanel.tsx` | 131, 177 | `button button--text qc-calendar-unscheduled__action` | `buttonClasses("text", { className: "qc-calendar-unscheduled__action" })` | B |
| `ProductionCalendarFoldChoice.tsx` | 24 | `button button--secondary` (Cancel) | `buttonClasses("secondary")` | A |
| `ProductionCalendarFoldChoice.tsx` | 25 | `button` (Use this time) | `buttonClasses()` | A |
| `ProductionCalendarMoveDialog.tsx` | 49 | `button button--secondary` (Cancel) | `buttonClasses("secondary")` | A |
| `ProductionCalendarMoveDialog.tsx` | 50 | `button` (Save Deadline) | `buttonClasses()` | A |
| `ProductionCalendarScheduleEditor.tsx` | 147 | `button button--secondary` (Cancel) | `buttonClasses("secondary")` | A |
| `ProductionCalendarScheduleEditor.tsx` | 148 | `button` (Save schedule) | `buttonClasses()` | A |
| `ProductionCalendarFilters.tsx` | 97 | `button button--text` (Clear filters) | `buttonClasses("text")` | C |

(14 rows for 11 usage sites — three are ×2/×3 within one component, matching Sol's 31-token count:
6+6+4+4+3+3+3+2.)

### 3.4 What survives untouched

Every `qc-*` hook class (layout, spacing, the touch-target media queries keyed on them or on tag
selectors); `[data-modal-variant="calendar"] button`'s dialog touch-target rule (tag-based,
unaffected by any class change on the button itself).

### 3.5 Acceptance

| # | Criterion |
|---|---|
| 3-1 | `.qc-cal-filters__head button { align-self: start; }` replaces the `.button` selector; verified only one button lives in that header. |
| 3-2 | `grep -n '\.button\b\|\.button--' production-calendar.css` returns nothing. |
| 3-3 | Computed padding, font-size, min-height/min-width and colour for all three cases, at 1440 and 390, match the pre-change measurements in §3.2 exactly — re-measure after, do not assume. |
| 3-4 | `.qc-cal-event-card__move` and `.qc-calendar-unscheduled__action` still reach 44×44 at 390px and under `(pointer: coarse)`. |
| 3-5 | `.button` in `app.css` now has zero consumers anywhere in the app — the last one. |
| 3-6 | Every calendar dialog (Fold Choice, Move, Schedule Editor) still opens, Cancel/Save both work, at 1440 and 390. |
| 3-7 | Disabled paint on Fold Choice submit / Move submit / Clear Filters / unscheduled-action matches `buttonClasses()`'s standard disabled treatment (Sol B1) — checked visually, not assumed identical to the legacy fade. |
| 3-8 | "Try again" (`.qc-calendar-state`) is 44px tall at 390px, matching "Refresh" one state over (Sol B2) — a deliberate fix, not a regression to catch. |


---

## §9 — §3 build record and gate (2026-09-04) — **PASSED**

Built directly by this session, after Sol's two blocking findings (§3.2a) were resolved in the
plan. `.button`/`.button--*` retired from all 11 sites across 8 files onto `buttonClasses()`,
matching the plan's table exactly.

### The CSS fix and one runtime finding beyond the plan

`.qc-cal-filters__head .button { align-self: start; }` → `.qc-cal-filters__head button { ... }`,
as specified.

**Sol's suggested test fix was itself wrong, and building it surfaced why.** §3.2a NB1 said the
attribute selector `[data-focus-key="calendar-recovery"]` was already unique once the class was
dropped. It is not: `ProductionCalendarToolbar.tsx:84` carries the **same** attribute value on the
toolbar's root `<div>`, as a deliberate second half of the focus-recovery fallback at
`ProductionCalendar.tsx:718` (`.button[data-focus-key=…] ?? [data-focus-key=…]` — try the Refresh
button first, fall back to the toolbar container once it's gone). Dropping the class from the test
selector made it match the toolbar `<div>` instead, which never disappears, so the "button is gone
after refresh" assertion failed for a different reason than intended. Fixed by qualifying on the
tag (`button[data-focus-key="calendar-recovery"]`) rather than dropping the qualifier — this
distinguishes the two elements the way `.button` used to, without depending on the retired class.

### Verified against the pre-change baseline, not just "looks fine"

Re-measured computed styles at 1440 and 390 after the swap and compared against §3.2's pre-change
numbers directly:

| | Before → After (1440 / 390) |
|---|---|
| `.qc-cal-event-card__move` / `.qc-calendar-unscheduled__action` | padding, font-size, min-width/height, colour — **byte-identical at both viewports** |
| Toolbar `button--secondary` (Prev/Today/Next pattern) | padding, font-size, min-height — **byte-identical at both viewports** |

Both accepted deviations from §3.2a are mechanisms already proven elsewhere in this same session,
not new risk: the disabled-paint change is the exact CSS `buttonClasses()` already produces on
three §2 sites live in production; the 44px `min-h-[721px]` utility on "Try again" is the identical
utility already rendering correctly on "Refresh" one control over.

### Gate

typecheck 0 · build 0 · **726/726 unchanged** (the one test that needed updating for the
`data-focus-key` disambiguation still asserts the same behaviour, just through a selector that
survives the class retirement) · `packages/shared` 144 · `.button` and all three variants now have
**zero consumers anywhere in the application** — `classcheck.py button button--secondary
button--text button--danger` all DEAD; `grep -n '\.button\b\|\.button--' production-calendar.css`
empty. **D-06 is complete.**


---

## §10 — §4 build record and gate (2026-09-04) — **PASSED**

D-05. All 8 live text sites: `color: var(--text-muted)` → `color: var(--text-secondary)` — a pure
CSS token swap in `app.css`, zero JSX/className changes, matching the pattern TB8-10A used for D-04.

**Contrast, computed independently (WCAG relative-luminance formula, not eyeballed):**

| | greige-400 (before) | greige-600 (after) |
|---|---|---|
| on `--paper-000` `#ffffff` | 3.57:1 — fails 4.5:1 | **9.20:1** |
| on `--paper-050` `#faf8f2` | 3.36:1 — fails | **8.66:1** |
| on `--bg-sunken`/`--paper-200` `#ece6d8` | 2.87:1 — fails | **7.40:1** |

Every site clears AA on every surface it could plausibly sit on, with wide margin — not a
borderline fix. `.rich-text u`/`.rich-text s` (`app.css:323-324`) are untouched, correctly: they set
`text-decoration-color`, not `color`, where the 4.5:1 text bar does not apply.

Verified live in the browser (local dev, rebuilt): `.muted` and `.upload-file span:last-child`
render `rgb(77, 71, 60)` — exactly `#4D473C`, `--greige-600` — confirming the swap took effect
through the unlayered cascade as expected.

### Gate

typecheck 0 · build 0 · **726/726 unchanged**, `packages/shared` 144 unchanged — a pure colour
value change touches no test. `grep -c "var(--text-muted)" app.css` → 2, both `.rich-text`
decoration-colour, both correctly excluded.
