# TB8-10B — The Dead-CSS Sweep and the `.button` Retirement

**Status: §1 DEPLOYED (app Worker `876fb239`). §2 BUILT AND GATED, NOT DEPLOYED. §3–§5 not started.** Second half of TB8 candidate #10. Runs the frontend lane in
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
the button family. **Read `docs/lessons.md` first** — the unlayered-cascade trap and its second door
through `tokens/base.css` (TB8-05) are why this is delicate rather than mechanical.

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
