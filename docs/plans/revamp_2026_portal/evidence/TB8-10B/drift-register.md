# TB8-10B — evidence register

Measured 2026-09-04, on `main` at `3d25e55` (i.e. with TB8-10A's changes in place). Every figure
here was counted against the repo, not carried forward from the deferred register — whose numbers
were already shown to be stale once.

TB8-10B owns **D-05** (`--text-muted` contrast), **D-06** (retire `.button`) and **D-07** (the
base/Preflight decision). D-08 is not here: it still needs the owner.

---

## D-06 — retire `.button`: 48 class tokens across 14 files

Counted by parsing every `className=` literal in non-test `.tsx`/`.ts` and taking whitespace-
delimited tokens equal to `button` or beginning `button--`. (Sol's `@babel/parser` pass over the
same question returned **50**; the two counts differ by parse strategy, not by substance. Re-count
before planning the slices and use the parser's figure if they still disagree.)

**The shape is the finding: 8 of the 14 files are the Production Calendar.**

| | Files | Tokens |
|---|---|---|
| Production Calendar | 8 | 31 |
| Everything else | 6 | 17 |

| Tokens | File |
|---|---|
| 6 | `screens/ProjectWorkspace.tsx` |
| 6 | `components/ProductionCalendarToolbar.tsx` |
| 6 | `components/ProductionCalendarEvent.tsx` |
| 4 | `components/ProductionCalendar.tsx` |
| 4 | `components/ProductionCalendarUnscheduledPanel.tsx` |
| 3 | `components/ConfirmDialog.tsx` |
| 3 | `components/ProductionCalendarFoldChoice.tsx` |
| 3 | `components/ProductionCalendarMoveDialog.tsx` |
| 3 | `components/ProductionCalendarScheduleEditor.tsx` |
| 2 | `App.tsx` |
| 2 | `components/CollectionPanel.tsx` |
| 2 | `components/ProductionCalendarFilters.tsx` |
| 2 | `components/UploadDropzone.tsx` |
| 2 | `components/ExternalEditedUpload.tsx` |

**By variant:** `button` 26, `button--secondary` 15, `button--text` 6, `button--danger` 1. The
legacy family lives at `styles/app.css:585-600`.

**Consequence for scoping.** The calendar has never been through a TB8 convergence — it runs on
`production-calendar.css` from TB5C. Migrating its buttons to `buttonClasses()` is a *visual change
to a surface with no convergence evidence behind it*, which is a release with its own gate, not a
line item in a sweep. The six non-calendar files are ordinary retirement work.

---

## D-05 — `--text-muted`: 19 sites, and **half of them are dead CSS, not a contrast problem**

`--text-muted` is `--greige-400` `#8f8775`: 3.6:1 on `--paper-000`, 3.5:1 on `--paper-050`, 2.9:1 on
`--bg-sunken` (measured in TB8-04 §2.1). The register framed D-05 as "fix the contrast on the
remaining sites, minus the decorative ones". That framing is wrong in a useful way: **you cannot
know which sites need a contrast fix until you know which ones render at all.**

### How this was measured, and why the method is part of the finding

Four successive greps gave four different answers, and three were wrong:

1. A `className=[^>]*` regex reported *everything* dead, including `.muted` — it matched the
   attribute but then searched the already-extracted literal for quotes that were not there.
2. A literals-only parser reported `.rich-text` dead — it reads `"…"` and `'…'` but the root class
   is emitted from a **template literal** (`RichTextContent.tsx:56`,
   ``className={`rich-text${…}`}``).
3. A raw `grep -rn` reported `.ctab` live — the single hit was the substring `ctab` inside
   **`selectable`**, and `.search` live on 32 hits that are all `searchRef`,
   `window.location.search`, `${id}-search` label ids and the unrelated `dashboard-search`.

The authority is `classcheck.py` (kept at `/tmp` in-session; re-create it rather than trusting this
table blind) which reads `className=` attributes **and** `cn()`/`clsx()` arguments, in string and
template literals, dropping `${…}` interpolations. **It has one known blind spot** — a nested
interpolation inside a template literal, which is exactly the `.rich-text` case — so its DEAD
verdicts were each cross-checked with a raw grep, which can only over-report.

**Do this again at build time.** Do not delete a rule on the strength of this table alone.

### Dead — delete the rule, do not restyle it (9 of the 19 sites)

| Line | Selector | Note |
|---|---|---|
| 72 | `.search svg` | `.search` has no class consumer; the whole `:64-72` block is dead |
| 313 | `.copyread li::before` | |
| 325 | `.docpreview li::before` | |
| 334 | `.dropzone svg` | |
| 414 | `.trow .ey` | |
| 416 | `.trow__sub` | |
| 447 | `.ctab .cnt` | the one apparent consumer was `selectable` |
| 460 | `.premium-sec .cnt` | |
| 486 | `.optcard .d` | |

### Live — the actual contrast work (10 sites)

`:16`, `:21` `.muted` (6 files — the important one), `:245` `.project-team-picker__option small`,
`:246` `.project-team-picker__empty`, `:248` `.kv .k`, `:373` `.rich-text u`, `:374` `.rich-text s`,
`:504` `.empty` (6 files), `:628` `.document-history small`, `:637` `.upload-file span:last-child`.

**`:373`/`:374` are not colour sites** — they set `text-decoration-color` on underline and strike
marks, where 4.5:1 does not apply as a text-contrast bar. They belong to the "decorative, leave
alone" bucket the register warned about, and they are live, so they must not be swept.

---

## The focus-guard baselines: one dead, one **a live defect**

`SUPPRESSED_FOCUS_BASELINE` carries two entries, both recorded as "replaced by a border-color change
only. Owner: TB8-10." They are not the same case:

- **`.copyinput:focus`** (`app.css:305-307`) — **dead.** Zero occurrences of the string `copyinput`
  anywhere in non-test source. Delete all three rules; the baseline entry goes with them.
- **`.search input:focus`** (`app.css:64-72`) — **also dead**, on the same evidence as D-05's `:72`
  above. Delete all four rules.

So TB8-10B does not have to design two focus treatments. It deletes seven rules and
**`SUPPRESSED_FOCUS_BASELINE` empties out.** All three guard baselines then read `{}` — the state
the guard file was written to reach, reached by deletion rather than by redesign.

---

## D-07 — the base/Preflight decision

Unchanged and still last: it cannot be answered until `app.css` stops carrying a button family,
which is D-06's job. `docs/lessons.md`'s unlayered-cascade entry and its second door through
`tokens/base.css` (TB8-05) are why this is delicate rather than mechanical.

---

## Suggested shape

1. **Dead-CSS sweep first** — the 9 dead `--text-muted` rules and the 7 dead `.search`/`.copyinput`
   rules (overlapping at `:72`), re-verified with `classcheck.py` plus a raw grep. Empties the last
   guard baseline. No visual change by construction, which makes it independently shippable.
2. **`.button` retirement, non-calendar** — 6 files, 17 tokens.
3. **`.button` retirement, Production Calendar** — 8 files, 31 tokens. Needs its own visual
   evidence at the three viewports, because the calendar has never been converged.
4. **`--text-muted` contrast on what survives** — 8 live *text* sites (`:16`, `:21`, `:245`, `:246`,
   `:248`, `:504`, `:628`, `:637`). `:373`/`:374` are `text-decoration-color` and stay.
5. **D-07** — answerable only once `app.css:585-600` is gone.
