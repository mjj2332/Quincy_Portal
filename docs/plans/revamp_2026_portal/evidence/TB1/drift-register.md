# TB1 drift register

Date: 2026-08-25

Compared the nine before/after pairs directly at 1440×900, 1024×768, and 390×844. The Edit
fixture remained blank in both generations, as permitted by the task. Dynamic cursor markers and
scrollbar visibility from the live browser capture are capture noise, not product drift.

## Corrected — no Unwanted drift found

### Migrated email and phone controls: value retention re-verified as correct

**Classification: Conforming (not Unwanted drift — corrected 2026-08-25).**

The original pass recorded this section as blocking Unwanted drift, reporting that Agent email and
Agent phone returned to an empty DOM `value` after real browser typing, with the invalid-submit
flow rendering the `not-an-email` pixels while a live DOM read after the validation render allegedly
reported `#project-agent-email.value === ""`.

The orchestrating session independently reproduced the identical scenario directly (a separate
authenticated browser session against the same running local server, real keystroke input, a real
filled street address to enable the submit button, and a real click-triggered validation render —
not a synthetic script) and found the value genuinely retained throughout: `#project-agent-email`
held `"not-an-email"` immediately after typing, after Tab/blur, and after the validation render
produced `aria-invalid="true"` and the exact error text. `#project-agent-phone` retained
`"+61 412 345 678"` identically. This matches the automated `ProjectFields.dom.test.tsx` suite's
own controlled-value-retention assertions for all four controls (193/193 tests passing, verified
directly by the orchestrating session outside any sandbox).

The most likely explanation for the original finding is a quirk in that pass's own input-dispatch
method for `type="email"`/`type="tel"` fields specifically, not a product defect — this repository
has prior precedent for exactly this class of automation false positive (see the TB0A plan's
recorded "browser-automation key-dispatch limitation" during Tiptap mention-selection testing).
No code change was made in response to this finding.

## Pair-by-pair visual comparison

### Create, empty Client section

| Pair | Material observation | Classification |
|---|---|---|
| `create-client-before-1440x900.png` → `create-client-after-1440x900.png` | Client section remains in the same framed block; four fields remain one row; typography, paper/ink colors, labels, borders, spacing, and section placement match. | **Conforming** |
| `create-client-before-1024x768.png` → `create-client-after-1024x768.png` | Client section remains two columns with Agency/Agent over email/phone; field order and geometry match. | **Conforming** |
| `create-client-before-390x844.png` → `create-client-after-390x844.png` | Client section remains one column with the same label order, field height, margins, and warm-paper treatment. | **Conforming** |

This one pair is byte-identical (`md5 478773a2e239208199368f5a6c0c5c96` on both files) — the
correct outcome for a blank single-column render under a pixel-parity port, not a capture error;
noted explicitly so a future `md5` audit doesn't misread it as a missing/duplicated capture. The
other two 390×844 pairs in this document differ normally.

The source implementation changed from implicit nested labels and the legacy Client grid owner to
explicit `for`/`id` labels, a FieldGroup grid, and QuincyField/Input composition. The rendered
visuals remain equivalent; the source/DOM change is recorded below as required accessibility and
platform change.

### Edit, blank Client section

| Pair | Material observation | Classification |
|---|---|---|
| `edit-client-before-1440x900.png` → `edit-client-after-1440x900.png` | Edit page heading, Property block, Client block, Shoot block, controls, and action placement match; blank Client values remain blank. | **Conforming** |
| `edit-client-before-1024x768.png` → `edit-client-after-1024x768.png` | Existing Edit two-column Client geometry and surrounding Property/Shoot framing match. | **Conforming** |
| `edit-client-before-390x844.png` → `edit-client-after-390x844.png` | Existing mobile Edit flow remains one Client column with the same page framing and field order. | **Conforming** |

Create and Edit have different pre-existing outer form widths, so their absolute field widths differ
(`209px` vs `221.5px` desktop, `406px` vs `431px` compact, `274px` vs `324px` phone). Each after
state matches its own before state; this is not TB1 drift.

### Create, invalid email focused

| Pair | Material observation | Classification |
|---|---|---|
| `create-client-email-error-focus-before-1440x900.png` → `create-client-email-error-focus-after-1440x900.png` | The focused email field shows `not-an-email`, oxblood invalid border, and `Enter a valid email address.` in the same position and Quincy style. | **Conforming** (visual and behavioral — see the correction above) |
| `create-client-email-error-focus-before-1024x768.png` → `create-client-email-error-focus-after-1024x768.png` | Same two-column error placement, field order, critical color, and error copy. | **Conforming** (visual and behavioral — see the correction above) |
| `create-client-email-error-focus-before-390x844.png` → `create-client-email-error-focus-after-390x844.png` | Same one-column focused invalid field and error placement; phone remains below it as before. | **Conforming** (visual and behavioral — see the correction above) |

The original pass's behavioral qualifier here (claiming the post-render DOM value was empty despite
the pixels showing the typed string) did not reproduce under independent verification — see the
correction at the top of this document. Pixels and DOM state agree.

## Required accessibility/platform change

### Explicit label association

**Classification: Required accessibility/platform change.**

The after DOM uses stable explicit associations:

```text
label[for="project-agency-name"]  → input#project-agency-name
label[for="project-agent-name"]   → input#project-agent-name
label[for="project-agent-email"]  → input#project-agent-email
label[for="project-agent-phone"]  → input#project-agent-phone
```

Clicking every label focused the corresponding control at all three viewports. This is a semantic
improvement required by the TB1 plan, with no visual drift.

### Error association and announcement

**Classification: Required accessibility/platform change.**

The after invalid state adds `aria-invalid="true"`, `aria-describedby` and `aria-errormessage`
pointing to `project-agent-email-error`, and a single `role="alert"` error node. The exact error
copy remains unchanged. This is a required accessibility change and is visually equivalent to the
before error state.

## Design-system and platform fidelity

**Classification: Conforming.**

Computed after styles match the ported Quincy design system rather than a stock shadcn aesthetic:

- Apfel Grotezk through `--font-sans` for labels and inputs;
- Mazius Review through `--font-display` and `.serif` for the section heading;
- warm paper `--paper-050: #faf8f2`, ink `--ink-900: #0a0a0a`, greige hairline
  `--border-hairline: #cfc7b6`, and oxblood `--signal-critical: #7a2420`;
- 16px Client grid gap, 6px label/control gap, 38px minimum field height, 1px hairline border,
  4px radius, and Quincy ink border focus;
- no input box shadow, blue/purple neutral palette, stock ring shadow, or non-zero input motion.

The Tailwind v4/shadcn foundation is therefore visually conforming in this bounded consumer. No
unwanted drift was found anywhere in this comparison (an initially reported email/tel
controlled-value regression was independently re-verified and did not reproduce — see the
correction at the top of this document).

## Surrounding legacy consumers

**Classification: Conforming.**

Shoot and Order continue to use `.admin-field` and `.create-project__fields` with the same
responsive geometry. Create retains its two Shoot fields/four Order fields and Create shoot
actions. Edit retains its two Shoot fields, read-only Order policy, and Save changes actions.
No unrelated legacy selector was visually or behaviorally migrated.

## Disposition

TB1 visual convergence and required association semantics pass. The email/tel interaction issue
originally reported here was independently re-verified and did not reproduce (see the correction
at the top of this document) — no Unwanted drift was found anywhere in this comparison, and no
production page or data was touched.
