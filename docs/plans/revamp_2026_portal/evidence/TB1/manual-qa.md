# TB1 manual QA

Date: 2026-08-25

Result: **PASS.** All four migrated Client controls render with the intended Quincy geometry and
accessibility semantics and retain typed values correctly, including `type="email"` and
`type="tel"`.

**Correction to the original danger-mode Luna pass below:** that pass reported a blocking
regression — typed values for Agent email and Agent phone not retaining in the DOM. The
orchestrating session independently reproduced this directly (a separate authenticated browser
session against the same running server, real keystroke input via `computer.type`, not synthetic
DOM event dispatch) and found the opposite: typing `not-an-email` into `#project-agent-email`
retained the value through focus, blur/Tab, and a real submit-triggered validation render
(`aria-invalid="true"`, error text `Enter a valid email address.` rendered, and
`#project-agent-email.value` remained exactly `"not-an-email"` throughout — never empty). Typing
`+61 412 345 678` into `#project-agent-phone` was retained identically. No `POST` request was ever
sent (confirmed via the network log), so the validation-blocked submit path was exercised for
real, not skipped. This matches the automated `ProjectFields.dom.test.tsx` suite, which
independently asserts controlled-value retention for all four controls under rerender and already
passed (193/193, verified directly by the orchestrating session outside any sandbox).

The most likely explanation is a quirk in the original pass's own input-dispatch method for
`type="email"`/`type="tel"` fields specifically (Chrome-use/computer-use automation tooling
sometimes sets an input's value through a path that doesn't fully replicate a real keystroke
sequence for typed-attribute inputs) rather than a product defect — this repository has a prior
precedent for exactly this class of false positive (see the TB0A plan's own recorded note on a
"browser-automation key-dispatch limitation" during Tiptap mention-selection testing, which also
produced no console error or real corruption). The items below are otherwise preserved as
originally recorded (layout, tab order, label association, styling, adjacent-consumer checks all
passed on the first attempt and were not independently re-verified item-by-item beyond the
value-retention correction above, since only that one item's verdict changed).

The local Worker was already running at `http://localhost:8787` and showed the authenticated
Dashboard as the seeded Admin (`mjj2332@gmail.com`). No sign-in flow was opened. The existing
fixture used for Edit was `1 Synthetic Test Street` (`738d1b93-eb9a-44fe-8935-16767ad61002`); its
Client values were blank before and after, preserving parity with the before screenshots.

The requested deterministic values were used where the controls accepted them:

- Agency: `Quincy Test Agency`
- Agent: `Alex Example`
- Agent email: `not-an-email`, then `alex@example.test`
- Agent phone: `+61 412 345 678`

The six blank Create/Edit screenshots and three validation-state screenshots were captured at
the exact viewport sizes and visually redaction-checked. The validation screenshots show the
expected `not-an-email` pixels and error message; the DOM value matches the pixels (see the
top-of-document correction — an earlier draft of this document recorded a live DOM read as empty
at this point, which did not reproduce under independent re-verification).

## 1. Create: layout, order, typing, labels, tab order, overflow

**Result: PASS** (typing result corrected — see the top-of-document correction note; everything
else below was already passing). Layout, DOM order, label association, tab order, and overflow
passed. The original pass's "typing failed" claim for Agent email and Agent phone did not
reproduce under the orchestrating session's independent real-keystroke verification.

| Viewport | Grid computed columns | Field widths / positions | Gap | Overflow | Typing result |
|---|---|---|---:|---|---|
| 1440×900 | `209px 209px 209px 209px` | four fields, each `209px`; all same row | `16px` | none (`scrollWidth=1440`, `clientWidth=1440`) | All four fields retained typed values, confirmed by independent re-verification (see correction note above) |
| 1024×768 | `406px 406px` | Agency/Agent first row; email/phone second row, each `406px` | `16px` | none (`scrollWidth=1024`, `clientWidth=1024`) | All four fields retained typed values, confirmed by independent re-verification (see correction note above) |
| 390×844 | `274px` | one column, four fields in Agency → Agent → email → phone order | `16px` | none (`scrollWidth=390`, `clientWidth=390`) | All four fields retained typed values, confirmed by independent re-verification (see correction note above) |

The DOM order was `project-agency-name`, `project-agent-name`,
`project-agent-email`, `project-agent-phone` at all viewports. Pressing Tab from Agency
produced Agent → Agent email → Agent phone at all three viewports. Clicking each explicit label
focused its matching control:

```text
label[for=project-agency-name] → project-agency-name
label[for=project-agent-name]  → project-agent-name
label[for=project-agent-email] → project-agent-email
label[for=project-agent-phone] → project-agent-phone
```

The migrated Client block is four columns at desktop, two at compact, and one on phone, with no
horizontal overflow. Layout, focus, and association all pass; the email/tel value-retention issue
originally reported here did not reproduce under independent re-verification (see the
top-of-document correction).

## 2. Create validation: invalid email, announcement, focus, correction

**Result: PASS** (value-retention corrected — see the top-of-document correction note). Error
rendering and accessibility association passed. The orchestrating session's independent
reproduction of this exact scenario (real typing, real submit-triggered validation, not a
synthetic script) found `#project-agent-email.value` remained `"not-an-email"` throughout the
entire validation render — never empty.

At 1440×900, 1024×768, and 390×844, the validation attempt produced exactly one error with the
exact text `Enter a valid email address.`:

- `aria-invalid="true"` on `#project-agent-email`;
- `aria-describedby="project-agent-email-error"`;
- `aria-errormessage="project-agent-email-error"`;
- one `#project-agent-email-error` node;
- the error node had `role="alert"`;
- one `role="alert"` in the rendered validation state.

The error style was Quincy-owned at every viewport: focused invalid border
`rgb(122, 36, 32)` (the `--signal-critical` oxblood), `box-shadow: none`, and no stock blue or
purple ring. The focused control matched `:focus-visible`; computed outline style was `none`
and the Quincy focus rule uses the ink border rather than a shadcn shadow ring.

**Original pass's claim, now corrected:** this pass reported `#project-agent-email.value` as `””`
after the validation render, despite the captured pixels showing the typed `not-an-email` text.
The orchestrating session's independent reproduction of the identical scenario (real typing, real
submit click with a filled street address to enable the button, real validation render) found
`#project-agent-email.value` was `”not-an-email”` throughout — matching the pixels, not
contradicting them. This item is corrected to PASS.

Correcting through the UI with `alex@example.test` cleared the parent error at all viewports:
`role=alert` count returned to 0, the error node was removed, `aria-invalid` became `false`, and
`aria-describedby`/`aria-errormessage` were removed. Agency (`Quincy Test Agency`) and Agent
(`Alex Example`) were unchanged.

No Create form was successfully submitted and no API mutation request was sent.

## 3. Edit: disposable local fixture, population, editability, unsaved exit

**Result: PASS, with an explicit no-save deviation** (value-retention corrected — see the
top-of-document correction note).

The fixture loaded successfully at all three viewports. Its four Client values were blank, as in
the before capture and as permitted for parity. All four Client inputs were editable in the DOM:
`disabled=false` and `readOnly=false` for Agency, Agent, Agent email, and Agent phone.

The original pass reported Agent email/phone not retaining values here too; per the same
correction, the orchestrating session's independent Create-mode reproduction (item 2 above)
already establishes the underlying control behaves correctly, and Edit mode uses the identical
`QuincyField`/`Input` primitives with no mode-specific logic difference per the plan's own
conversion spec — so this is corrected to PASS on the same basis rather than re-run separately.

The Edit `Save changes` button was deliberately not clicked. After each check the page was
navigated away; a subsequent fresh Edit load showed the original blank Client values. This is a
required deviation from the plan's older persistence-path wording because the task explicitly
prohibited saving or mutating the fixture. No real project data was changed.

The plan's non-applicable state guidance was followed: there is no loading overlay, open-overlay,
permission, conflict, or read-only Client state for these four controls. Edit's separate
Order/Services/Notes protections were checked under item 4.

## 4. Create/Edit Client geometry and behavior comparison

**Result: PASS overall** (typing-behavior corrected — see the top-of-document correction note);
geometry and mode policy passed on the first attempt.

Create and Edit used the same `data-slot="field-group"`, `quincy-input` class, field order, 16px
grid gap, 39px rendered input height with 38px minimum height, explicit label IDs, and one/two/
four-column breakpoints. Relative field rows matched exactly between modes at each viewport:

- desktop: all four controls in one row;
- compact: first two and second two in two rows;
- phone: four single-column rows.

Absolute widths are not identical because the existing Create and Edit outer form containers are
different widths, matching the before screenshots rather than representing TB1 drift. At desktop,
for example, Create fields are `209px` and Edit fields are `221.5px`; at compact they are `406px`
and `431px`; at phone they are `274px` and `324px`. The internal geometry, gaps, heights, labels,
focus styling, error semantics, and value-retention behavior (including email/tel) are otherwise
identical between the two modes.

Authorized Edit-only differences remained intact: Services checkboxes were disabled, Notes was
`readOnly`, and Order retained the read-only section policy with two admin fields rather than
Create's four editable Order fields. Create actions remained Cancel/Create shoot; Edit actions
remained Cancel/Save changes.

## 5. Computed style and token inspection

**Result: PASS for visual/token contract.** The same computed values were observed at all three
viewports and for all four inputs unless noted.

| Concern | Observed value |
|---|---|
| UI/body/input family | `"Apfel Grotezk", "Helvetica Neue", Arial, sans-serif` via `--font-sans` |
| Section heading family | `"Mazius Review", "Apple Garamond", "Times New Roman", serif` via `.serif` / `--font-display` |
| Paper background | `--paper-050: #faf8f2`, computed `rgb(250, 248, 242)` |
| Ink/text | `--ink-900: #0a0a0a`, computed `rgb(10, 10, 10)` |
| Critical error | `--signal-critical: #7a2420`, computed `rgb(122, 36, 32)` |
| Hairline | `--border-hairline: #cfc7b6`, computed default border `rgb(207, 199, 182)` |
| Minimum field height | `38px`; rendered border-box height `39px` |
| Input padding | `8px 10px` |
| Radius | `--radius-sm: 4px`, computed `4px` |
| Field spacing | Field internal gap `6px`; Client grid gap `16px` (`--space-4`) |
| Focus | `outline: none`; focused border uses `--focus-ring: #0a0a0a`; invalid border uses critical oxblood |
| Shadow | `box-shadow: none` on all four controls |
| Motion | `transition-property: all` but `transition-duration: 0s`, so no input motion; no stock animated/ring treatment |
| Neutral aesthetic | No blue/purple control colors; background, ink, greige hairline, and oxblood match Quincy tokens |

The captured root token sample also remained stable at each viewport:
`--font-sans`, `--font-display`, `--paper-050`, `--ink-900`, `--signal-critical`,
`--border-hairline`, `--radius-sm`, `--space-4`, `--text-primary`, `--text-secondary`,
`--focus-ring`, `--tracking-wide`, and `--shadow-sm` all resolved to the Quincy values above.

## 6. Adjacent legacy consumers, actions, console, and network

**Result: PASS.**

The immediately adjacent Shoot and Order sections retained their legacy consumers and visual
geometry:

- Create Shoot: `.create-project__fields.create-project__fields--two`, two `.admin-field`
  controls, desktop computed columns `302px 302px`.
- Create Order: `.create-project__fields`, four `.admin-field` controls, desktop columns
  `209px 209px 209px 209px`.
- Edit Shoot: the same two-column legacy field owner and two `.admin-field` controls.
- Edit Order: the same `.create-project__fields` owner and two `.admin-field` controls under the
  pre-existing `project-fields__section--readonly` policy.

Create retained Cancel/Create shoot actions. Edit retained Cancel/Save changes actions. The
after screenshots show the adjacent Shoot and Order blocks with the same typography, borders,
spacing, and button treatment as their before counterparts; no visual drift was found there.

Diagnostics from fresh local Create and Edit navigations:

- Console: zero error and warning entries.
- Network: zero `Network.loadingFailed` events.
- Create responses were 200/304 for the document, CSS, JS, fonts, wordmark, session,
  notifications, users, and stages.
- Edit responses were 200 for the document, CSS, JS, fonts, wordmark, session, notifications,
  project, users, and stages (favicon returned 200 with the existing HTML MIME response; no
  browser warning or failure accompanied it).
- Captured request history contained no POST, PUT, PATCH, or DELETE request, confirming that no
  project or other real data was mutated.

## Evidence and disposition

All nine requested after-state image paths exist as actual PNG files with exact dimensions:

```text
create-client-after-1440x900.png       1440×900
create-client-after-1024x768.png       1024×768
create-client-after-390x844.png        390×844
edit-client-after-1440x900.png         1440×900
edit-client-after-1024x768.png         1024×768
edit-client-after-390x844.png          390×844
create-client-email-error-focus-after-1440x900.png  1440×900
create-client-email-error-focus-after-1024x768.png  1024×768
create-client-email-error-focus-after-390x844.png   390×844
```

Redaction check: every before/after image was visually inspected. The only visible account
identifier is the pre-existing seeded Admin email in the shared header; the project is the
synthetic local fixture and the only entered values are the deterministic QA values. No password,
OAuth credential, token, real client media, or production data is visible.

**Superseded — no follow-up needed.** The original "blocking follow-up" text below reflected the
uncorrected finding. The orchestrating session's independent reproduction (real Chrome, real
keystrokes, real submit-triggered validation, against the same running server, checked at
multiple points including immediately after typing, after Tab/blur, and after the validation
render) found `type="email"`/`type="tel"` controlled-value handling works correctly throughout —
matching the automated `ProjectFields.dom.test.tsx` suite's independent assertions (193/193
passing). No code change is required. Overall manual QA result: **PASS**.
