# TB8-10 — Deferred Defects and the App-Wide Cleanup Sweep: Register

**Status: DRAFTED, NOT BUILT.** This is a *register*, not yet a visual plan: it collects work that
earlier TB8 releases deliberately deferred, so none of it is carried only in a closed release's
prose. It becomes a plan — Opus draft, Sol scope review, Sonnet build, per
`docs/Subagent-Frontend-Orchestration.md` — when it is picked up.

**Scheduling.** This is ranking candidate **#10** in
`Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md` ("dead selectors / final base/Preflight
decision — cleanup, near the end"). It runs **after** candidates #6–#9, per the owner's
instruction to visit these once the existing tracer bullets are finished. Two consequences worth
stating rather than assuming:

- **It is not TB8-06.** Candidate #6 is Board filters/card controls and is unaffected by this
  register. Some earlier prose named the scrim defect's destination "TB8-06" before the ranking was
  reconciled; the destination is this document.
- **Waiting is load-bearing for most items, but not all.** A dead-selector sweep run before the
  remaining surfaces converge would delete rules those surfaces are about to stop using anyway, and
  would have to run twice. D-01 is the exception — see its own note.

---

## The deferred items

### D-01 — The mobile menu has no scrim
**Found:** TB8-05 visual gate (Opus), 2026-09-03. **Surface owner:** TB8-02 (menus/dialogs/popovers).
**Evidence:** at 390×844 the open menu panel is opaque but nothing dims the page behind it, so the
page `<h1>` runs up to the panel's left edge and is sliced mid-word. It reads as a rendering bug at
a glance even though the panel itself is painting correctly.
**Root cause, confirmed in source:** `components/ui/menu.tsx` renders `MenuPrimitive.Portal` with a
`Positioner` and `Popup` and **no `Backdrop`**. Base UI supplies one; the port never adopted it.
**Why it is the exception to "wait":** it is a visible defect on the live production phone layout,
it is one component, and it does not depend on any surface still to converge. If it is fixed ahead
of this sweep as a standalone hotfix, delete this entry rather than leaving it to be re-found.

### D-02 — Duplicate `.sr-only`
`styles/app.css:899` and `:911` declare byte-identical `.sr-only` rules. Harmless in cascade terms
(the second simply re-wins), which is exactly why it survived. One deletion.

### D-03 — Dead `.app.acc-olive` accent block
`styles/app.css:719-725`, seven selectors implementing an olive accent theme. **No `acc-olive`
consumer exists** anywhere in `apps/web/src` — verified 2026-09-03. It descends from the prototype's
accent-switching, which the portal never shipped. Deletable outright; confirm once more at build
time rather than trusting this line.

### D-04 — `production-calendar.css:175` reaches Athelas through an undefined token
`.qc-calendar-schedule-editor__intro` sets `font: 14px/1.5 var(--font-serif, Athelas, Georgia, serif)`.
**`--font-serif` is defined nowhere** — the face arrives through the *fallback* half of the `var()`,
not through a token. It renders correctly today and would keep rendering correctly if the design
system's serif changed, which is the actual defect. Normalise onto `--type-body-serif`. Already
flagged in `styles/tokens/typography.css:5-13`, which explicitly routes the fix to "that surface's
own candidate" — this one.

### D-05 — `--text-muted` fails 4.5:1 on every remaining unconverged surface
`--text-muted` is `--greige-400 #8f8775`: **3.6:1** on `--paper-000`, 3.5:1 on `--paper-050`, 2.9:1
on `--bg-sunken` (measured in TB8-04 §2.1). Converged surfaces moved their muted *text* roles to
`text-foreground-secondary`; **41 `var(--text-muted)` paint sites remain in `app.css`** as of
2026-09-03 — including `.muted` itself (`:21`), the notice-board head/empty/counter rules, and the
rich-text toolbar's disabled states.
**Scope decision this register does not make:** some of those 41 are non-text roles (icon fills at
`:72`, `:308`, `:363`; `::before` em-dashes at `:342`, `:354`) where 4.5:1 is not the applicable
bar. The eventual plan must separate the text roles from the decorative ones instead of sweeping
all 41, or it will flatten deliberate visual hierarchy in the name of a rule that does not apply.

### D-06 — Retire `.button` — **much larger than first recorded**
`app.css:835-850` — the legacy button family (`.button`, `--secondary`, `--danger`, `--text`).

**Corrected 2026-09-03, during TB8-06 slice 4.** This register first said "live consumers in
`App.tsx:106` and `ProjectWorkspace.tsx:330,338`". That count came from a grep matching
`className="button"`, which misses `className="button button--secondary"` — the far more common
form. The real figure is **51 occurrences across 36 files**, spanning the production calendar
(8 files), subtasks, notice board, discussion thread, upload dropzone, confirm dialog, external
edited upload, and more.

So D-06 is **not** a cleanup item. It is a 36-file migration to `buttonClasses()` plus the test
updates that follow, and it should be scoped as its own release rather than folded into a sweep.
TB8-06 retires three of the 51 (`.kcard__retry` in slice 4; the move-to popover's two action
buttons in slice 7). Every other TB8 candidate that converges a surface will retire a few more, so
the number to re-measure before planning D-06 is whatever survives once #7-#9 are done — not this
one.

### D-07 — The base/Preflight decision
The roadmap's own open question, carried since TB1: whether Tailwind Preflight stays disabled once
the ported `tokens/base.css` no longer has to co-exist with `app.css`. It cannot be answered until
the surfaces above are converged, which is why it sits at the end. **Read `docs/lessons.md` first**
— the unlayered-cascade trap and its second door through `tokens/base.css` (TB8-05) are the reason
this decision is delicate rather than mechanical.

---

## Verification debt (not defects)

These are **not** failures; they are acceptance items that were verified structurally and were
explicitly *not* claimed as passes. They are recorded here so the gap has an owner.

| Release | Items | What was proved | What was not |
|---|---|---|---|
| TB8-04 | §10.2 items 3 and 5 | The stacked table reapplies every ARIA role it loses to `display: block`; `FieldError` wires `role="alert"` + `aria-invalid`/`aria-describedby` | What a screen reader actually announces |
| TB8-05 | §10.2 items 1–17 (accessible name) | The computed `aria-label`, and the accname precedence rule that `aria-label` outranks a wrapping `<label>` | Whether the checkbox is announced as "Project deadline reminder emails" |
| TB8-06 | §7 item 9 (popover step change) | `data-step`, the `radiogroup`/`listbox` roles and `aria-checked`/`aria-selected` are wired and asserted in DOM tests | Whether a screen reader announces the stage→position step transition |

Both were recorded on the **TB5C precedent**, where the owner waived physical-phone and real-AT
checks. Closing this debt needs assistive technology no agent in this pipeline can drive, so it is
an owner decision — waive again, or run one real VoiceOver/NVDA pass covering both releases at once.
It does not belong to any single candidate.

---

## Sources

Each item's origin, so none of this rests on this document alone:

- D-01 — `docs/plans/implemented/TB8-05-…-Visual-Plan.md`, status-line deviation (3); `docs/todo.md` TB8-05 bullet.
- D-02, D-03, D-06 — `docs/plans/implemented/TB8-01-…-Visual-Plan.md` dead-selector register; re-verified 2026-09-03.
- D-04 — `portal/apps/web/src/styles/tokens/typography.css:5-13`.
- D-05 — `docs/plans/implemented/TB8-04-…-Visual-Plan.md` §2.1 contrast table and E-16.
- D-07 — `docs/plans/Revamp-TB8-Wider-UI-Migration-And-Cleanup-Plan.md`, ranking item 10.
- Verification debt — TB8-04 plan status line; TB8-05 plan §10.3.

## D-TB8-09-1 — the annotation toolbar covers the filmstrip on phone

**Deferred from TB8-09's visual gate, 2026-09-04, with the measurement.**

At 390px the markup toolbar wraps to **136px** tall at `bottom: 18px`, spanning y 746–882, while
the fixed filmstrip sits at 766–828. The toolbar (z-6) covers the filmstrip (z-4) whenever markup
is available.

**Pre-existing, not introduced by TB8-09** — verified against `7c9544f`: the legacy phone rules
also set 44px `.swatch`/`.wbtn` targets and pinned `.strip` at `bottom: calc(72px + safe-area)`,
so the same collision existed before the convergence.

**Why it was not fixed in TB8-09:** the fix requires deciding *where the annotation toolbar lives
on a phone* when the filmstrip is fixed above it — collapse the filmstrip while drawing, dock the
toolbar to the top, or make it scrollable. That is a product decision, not a convergence one, and
inventing one at the end of a release is exactly the kind of unowned change the pipeline is meant
to prevent. **Needs owner input before it is planned.**

