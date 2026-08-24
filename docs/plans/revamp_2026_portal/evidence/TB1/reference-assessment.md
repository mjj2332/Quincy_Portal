# TB1 reference assessment

Date: 2026-08-25

## Prototype comparability

The prototype still has no comparable editable Create/Edit Project Client form. It is not a valid
visual counterpart for this TB1 surface.

The closest prototype surface is the workspace rail. `prototype/app/workspace.jsx` renders Client
and Agent as read-only key/value rows (`Client` and `Agent` at lines 40–41), alongside Shoot and
other project facts. Those rows are display spans inside `.kv`; they are not inputs, labels for
inputs, a form, or an editable Create/Edit state.

The Tonomo surface is also non-comparable. `prototype/app/tonomo.jsx` maps incoming webhook data
into a preview: the mapped section uses read-only `Row` values for Client, Agent email, Shoot,
Photographer, Order value, and Site agent (lines 265–272). Its only actions are Cancel and Create
project for the webhook preview (lines 309–314); it does not expose the four editable Client
controls or the Create/Edit Project form contract. The Tonomo view therefore documents source
facts and ingestion, not an editable counterpart. No fabricated prototype match is claimed.

## Ported Quincy design-system comparison

The after screenshots were instead assessed against the source-owned Quincy tokens and the
existing legacy form visual language in `portal/apps/web/src/styles/`.

### Typography

- `tokens/typography.css` defines `--font-sans` as
  `"Apfel Grotezk", "Helvetica Neue", Arial, sans-serif`; this is the computed family for all
  four inputs and field labels.
- The same file defines `--font-display` as
  `"Mazius Review", "Apple Garamond", "Times New Roman", serif`; the Client heading computed
  to this family and retained the existing `.serif` geometry.
- `--type-eyebrow` supplies the 12px/1.2 Apfel UI label role with `.08em` tracking. Computed
  labels were 12px, 14.4px line-height, and `0.96px` letter spacing.

### Color and semantic tokens

`tokens/colors.css` remains the authority for the observed visual values:

- `--paper-050: #faf8f2` for field/background paper;
- `--paper-000: #ffffff` for raised section surfaces;
- `--ink-900: #0a0a0a` for text and focus border;
- `--greige-200: #cfc7b6`, exposed as `--border-hairline`, for the 1px hairline;
- `--signal-critical: #7a2420` for invalid border and error text;
- `--focus-ring: #0a0a0a` for Quincy focus treatment.

The live computed styles matched those values: warm-paper `rgb(250, 248, 242)`, ink
`rgb(10, 10, 10)`, hairline `rgb(207, 199, 182)`, and critical `rgb(122, 36, 32)`. There was
no blue/purple stock neutral treatment.

### Geometry and interaction treatment

`tokens/spacing.css` defines `--space-4: 16px`, `--space-2: 8px`, and `--radius-sm: 4px`.
The Client FieldGroup computed to a 16px grid gap; each Field composite used a 6px label/control
gap; each input had 8px × 10px padding, a 1px border, a 4px radius, 38px minimum height, and a
39px rendered border-box height. Those values match the before geometry at all three breakpoints:
four columns at 1440, two at 1024, and one at 390.

The source-owned `app.css` rules retain the legacy `.admin-field` contract for surrounding Shoot
and Order sections and add the bounded `.quincy-input` focus/invalid rules. The Client primitive
source uses the Quincy token classes in `components/ui/input.tsx`; `components/ui/field.tsx`
provides only the minimal Field/Label/Error surface; and `components/quincy/QuincyField.tsx`
owns the branded composition. This yields the intended foundation behavior without importing a
stock shadcn visual system.

### Accessibility fidelity

`ProjectFields.tsx` retains the four domain fields, types, order, callbacks, and validation message.
The after DOM adds stable explicit label IDs and the error association/announcement contract:
`aria-invalid`, `aria-describedby`, `aria-errormessage`, and one `role="alert"` error. These are
required platform/accessibility improvements and do not change the visual authority.

### Assessment

The prototype is **non-comparable** for editable Client form parity. Against the ported Quincy
system, the after screenshots are visually faithful in typography, tokens, geometry, spacing,
border/radius, and focus/error color. A separate functional regression reported by the original
manual QA pass (Base UI-backed email/phone controls not retaining typed values) was independently
reproduced and found not to hold — see the correction in `manual-qa.md` and `drift-register.md`.
No functional or visual regression blocks acceptance.
