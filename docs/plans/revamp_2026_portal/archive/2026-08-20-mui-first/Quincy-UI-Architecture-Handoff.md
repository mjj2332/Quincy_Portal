> [!WARNING]
> **Archived and superseded.** Preserve for provenance only. Do not use this file as active implementation guidance; start at `../../../Quincy-Portal-Revamp-Index.md`.

# Quincy Portal UI Architecture Refactor — Handoff

**Status:** HANDOFF DRAFT — planning context for the next agent; no implementation has been performed by this handoff.  
**Prepared:** 2026-08-20  
**Repository:** `mjj2332/Quincy_Portal` (private)  
**Primary implementation area:** `portal/` only  
**Prototype:** `prototype/` is visual/reference-only; do not extend or copy its application structure into production.

---

## 1. Purpose of this handoff

The Quincy Portal frontend is healthy enough that a framework rewrite would create more risk than value, but it is approaching an inflection point: product features are growing faster than the small set of reusable UI primitives.

The goal is **not** to replace Quincy's design system with Material UI, Ant Design, Tailwind, or another full visual framework.

The goal is to:

1. Preserve Quincy's custom editorial visual identity and CSS token system.
2. Stop hand-implementing generic, accessibility-heavy UI behavior where mature libraries are better.
3. Introduce a small, explicit Quincy UI primitives layer.
4. Split large feature components and monolithic CSS by ownership as those areas are touched.
5. Adopt MUI X for date/time behavior, while wrapping it in Quincy-owned components and styles.
6. Keep larger architectural additions such as a server-state library or routing framework demand-driven rather than speculative.

A useful design principle for this work is:

> **Own the design; rent the difficult behavior.**

Quincy should own its appearance, domain workflows, media review UX, and product-specific components. It should not need to own calendar arithmetic, generic popover focus management, rich-text editing internals, drag-and-drop accessibility, or similar solved problems.

---

## 2. Current frontend architecture

Production frontend:

- React 18.3.1 + React DOM.
- Vite SPA.
- TypeScript strict mode.
- State/history-based routing, no React Router/TanStack Router.
- Custom CSS design system.
- Dependencies are hoisted and pinned at `portal/package.json`.
- `apps/web/package.json` intentionally contains only workspace-local scripts/dev-only entries.

Important current specialized libraries:

- `@floating-ui/react` — custom anchored popover positioning/focus behavior.
- `@dnd-kit/*` — sortable/drag-and-drop behavior.
- Tiptap packages — rich text, links, mentions, hard breaks.
- `better-auth` — auth.

There is currently no app-wide visual component framework such as MUI, Ant Design, Mantine, Chakra, or Tailwind.

### Production CSS system

The existing CSS foundation is a strength and should remain authoritative:

```text
portal/apps/web/src/styles/
  index.css
  fonts.css
  app.css
  tokens/
    colors.css
    spacing.css
    typography.css
    base.css
```

The design intent is explicitly editorial/architectural:

- ink `#0a0a0a`
- warm paper `#faf8f2`
- muted functional colors
- Apfel Grotezk for UI/body
- Mazius Review for display
- square or barely-softened corners
- hairline rules
- very limited elevation/shadows

The problem is **not custom CSS**. The growing risk is that `app.css` owns too many unrelated feature surfaces and generic controls.

---

## 3. Assessment of the current UI codebase

### What is good

Do not discard these strengths:

1. **Strong visual token discipline.** Colors, spacing, typography, radii, borders, motion, and focus behavior are already centrally represented.
2. **Good accessibility instincts.** Existing code explicitly handles focus restoration, Escape behavior, outside focus/pointer behavior, screen-reader labels, and keyboard interaction.
3. **Good DOM test coverage in important interactive surfaces.** `SubtaskChecklist.dom.test.tsx` is particularly thorough.
4. **Clear domain boundaries.** Backend capability/auth rules are not assumed to be enforced by UI hiding.
5. **Typed routing helpers.** The custom router is not a naive pathname switch; it has safe destination parsing and history subscription.
6. **Specialized libraries are already used where they add real value.** Tiptap and dnd-kit are examples of the right direction.

### Where debt is accumulating

#### A. Generic interaction primitives are being implemented repeatedly

`AnchoredPopover.tsx` is careful, but it exists because Quincy has implemented generic popover behavior itself:

- positioning
- outside click
- outside focus
- focus guards
- Escape handling
- focus return

That creates maintenance and test burden every time another menu/popover/dialog is added.

#### B. `app.css` is becoming a shared dumping ground

The token files are good; the application stylesheet is the scaling risk. New features can increasingly collide through global selectors, z-index rules, breakpoints, and large distant style sections.

#### C. Some feature components carry too many responsibilities

`SubtaskChecklist.tsx` currently includes, in one feature module:

- list loading
- mutations
- drag/drop
- reorder conflict behavior
- editor focus restoration
- composer state
- due-date picker behavior
- assignee picker behavior
- actions popover behavior
- formatting helpers
- row rendering

It is tested, but it is now costly to reason about when adding a new interaction.

#### D. Form field markup is repeated

`ProjectFields.tsx` repeatedly expresses variants of:

```tsx
<label className="admin-field">
  <span>Label</span>
  <input ... />
  {error && <small>{error}</small>}
</label>
```

This is a good candidate for a small Quincy `Field`/`TextField` abstraction, not for replacing the whole screen with a framework's form system.

---

## 4. Architecture direction

### 4.1 Keep the Quincy design system

Do **not**:

- migrate to Tailwind;
- rewrite all controls with MUI Material;
- rewrite all controls with Ant Design;
- introduce a second app-wide visual language;
- replace working product-domain components only for stylistic consistency.

Quincy should remain visually Quincy.

### 4.2 Introduce a small `ui/` primitives layer

Target structure, adjusted as the implementation proves useful:

```text
portal/apps/web/src/
  ui/
    Button/
    IconButton/
    Field/
    TextField/
    TextArea/
    Checkbox/
    Select/
    Popover/
    Dialog/
    DropdownMenu/
    Tooltip/
    DateTimePicker/
```

This is **not** a requirement to build all primitives up front.

Only create a primitive when a tracer-bullet slice has at least one real consumer and the abstraction is clear from actual use.

### 4.3 Recommended behavior library: Radix Primitives, incrementally

For generic overlays/interactions, evaluate Radix Primitives first, particularly:

- `@radix-ui/react-popover`
- `@radix-ui/react-dialog`
- `@radix-ui/react-dropdown-menu`
- `@radix-ui/react-tooltip`
- possibly `@radix-ui/react-select`

Use **Radix Primitives**, not Radix Themes.

Reason: Quincy needs robust behavior/accessibility while retaining custom classes and CSS.

Do not bulk-replace Floating UI immediately. Prove the approach on one bounded surface first.

Keep Floating UI where its lower-level positioning is genuinely useful, especially for media/review interactions or custom overlay geometry.

### 4.4 Selected date/time direction: MUI X

The user has evaluated the demos and prefers MUI X, especially the scrollable time selection (`DigitalClock`/`MultiSectionDigitalClock`). Quincy uses custom CSS, not Tailwind.

Use:

- `@mui/x-date-pickers`
- `@mui/material`
- `@emotion/react`
- `@emotion/styled`
- `dayjs`

But treat MUI as a **specialized date/time engine**, not Quincy's design system.

Preferred composition for the existing subtask due control:

```text
Quincy trigger
  -> Quincy/Radix or existing anchored popover
      -> Quincy shortcuts
      -> MUI DateCalendar
      -> optional-time toggle
      -> MUI DigitalClock or MultiSectionDigitalClock
      -> Quincy Remove / Cancel / Save actions
```

Avoid replacing the entire surrounding feature with a stock Material `TextField` + `DateTimePicker` if doing so would weaken the current compact metadata-trigger UX.

### 4.5 MUI styling guardrails

- Do not add MUI `CssBaseline`.
- Map MUI theme values to Quincy tokens/brand values.
- Keep Quincy CSS authoritative for surrounding layout and controls.
- Use MUI theme/slot overrides for picker internals rather than fragile generated CSS class names.
- Do not begin opportunistically converting unrelated buttons/forms to Material components.

---

## 5. Critical current date/time contract

This is a **correctness requirement**, not merely presentation.

Subtask due values currently support:

```text
YYYY-MM-DD
```

or:

```text
YYYY-MM-DDTHH:MM
```

Time is permanently optional.

The value is a **literal Sydney wall-clock value** when time is present. Example:

```text
2026-08-20T14:30
```

means 2:30 PM Sydney time, independent of the viewer's local device timezone.

### Do not

- call `toISOString()` for this subtask value;
- append `Z`;
- convert the value through a browser-local `Date` in a way that shifts the calendar day/time;
- force existing date-only rows to acquire a time;
- replace the two valid shapes with one mandatory datetime shape.

### Existing API validator

`portal/workers/app/src/routes/project-subtasks.ts` accepts calendar-valid:

- `YYYY-MM-DD`
- `YYYY-MM-DDTHH:MM`

No backend or schema migration should be required for the UI picker replacement.

The due reminder system depends on these semantics and computes the current calendar day in `Australia/Sydney` server-side.

---

## 6. Existing interaction behavior that must survive refactoring

When touching the checklist/due-date UI, preserve the behaviors already covered by tests:

- due trigger remains keyboard focusable;
- Escape closes an open popover;
- Escape returns focus appropriately;
- pointer outside closes;
- focus moving outside closes without treating focus guards as outside;
- one metadata popover replaces another cleanly;
- date can be saved without time;
- date can be saved with time;
- due value can be removed;
- composer metadata can be reset/cancelled;
- failed network mutations preserve relevant draft state;
- drag/drop and title editing behavior do not regress.

The new picker should add tests for:

- date-only -> date-only serialization;
- adding time -> exact `YYYY-MM-DDTHH:mm` serialization;
- removing time -> exact `YYYY-MM-DD` serialization;
- no timezone suffix/seconds;
- shortcut behavior;
- clock interaction;
- mobile-width usability;
- no focus-boundary regression from nested picker internals.

---

## 7. Project form date/time is a different domain concept

`ProjectFields.tsx` currently stores:

- `shootDate`: one date
- `timeWindow`: free text such as `9:00–11:00 am`

Do not incorrectly replace `timeWindow` with a single time picker.

If the project booking model is later structured into start/end times, treat that as a separate product/data-model feature.

A low-risk UI improvement may replace the native shoot-date input with the shared Quincy date picker while leaving the time-window contract unchanged.

---

## 8. CSS refactor direction

Do not perform a giant `app.css` move-only rewrite in one PR.

Split CSS **as a feature is actively changed**.

Example target:

```text
components/
  SubtaskChecklist/
    SubtaskChecklist.tsx
    SubtaskChecklist.css
    SubtaskChecklist.dom.test.tsx

ui/
  DateTimePicker/
    QuincyDateTimePicker.tsx
    QuincyDateTimePicker.css
```

Keep `styles/tokens/*` global.

Keep a small set of intentional global utilities in one place.

Avoid CSS Modules unless there is a concrete benefit; the existing BEM-like naming scheme is already understandable and brand styles are intentionally shared.

---

## 9. Component refactor direction

### `SubtaskChecklist.tsx`

Likely eventual decomposition:

```text
SubtaskChecklist/
  SubtaskChecklist.tsx          orchestration/composition
  SubtaskRow.tsx                item display/edit interaction
  SubtaskComposer.tsx           new-item form
  SubtaskDueDate.tsx            due trigger + picker
  SubtaskAssignee.tsx           assignee trigger + picker
  SubtaskActions.tsx            row actions
  useSubtasks.ts                API/mutation lifecycle if extraction proves useful
  subtask-date.ts               parse/serialize/format pure functions
```

Do not split merely to reduce line count. Split when responsibilities have clear contracts and tests can be preserved or improved.

### `ProjectFields.tsx`

Good candidate for incremental use of:

- `Field`
- `TextField`
- `TextArea`
- possibly a Quincy checkbox abstraction

Again, migrate one real section/screen first before generalizing.

---

## 10. Libraries that should remain demand-driven

### TanStack Query — likely later, not mandatory in this refactor

Current screens manually manage loading/mutations. This is still workable.

Re-evaluate TanStack Query when video review or other collaborative/processing states introduce substantial:

- cache invalidation;
- refetching;
- optimistic updates;
- retry;
- stale-state coordination;
- background refresh.

Do not add it solely to modernize the stack.

### TanStack Router / React Router — later decision

The current typed custom router is acceptable for the present route set.

Re-evaluate once routes become materially nested/deep-linked, e.g. video review timestamps/assets, richer admin subsections, or asset-specific URLs.

Do not rewrite routing as part of the first UI foundation slice.

### Form library — no current need

Do not add React Hook Form or similar unless actual form complexity (nested arrays, touched/dirty orchestration, multi-step forms, etc.) makes the value clear.

---

## 11. Repository/process constraints for the next agent

Read these before planning/building:

1. `AGENTS.md`
2. `docs/todo.md`
3. `docs/lessons.md`
4. `docs/Subagent-Orchestration.md`
5. Any relevant implemented plan under `docs/plans/implemented/`

Important repo rules:

- Implementation happens in `portal/`, not `prototype/`.
- Dependencies are hoisted/pinned; inspect `portal/package.json` before installing anything.
- Do not touch auth/security behavior as collateral refactoring.
- Media keys are immutable; unrelated to this UI change, but do not accidentally broaden scope.
- There is no staging environment.
- Production testing is passive/read-only unless the human explicitly performs a mutating check.
- Local dev is available at `http://localhost:8787` after building the web app; use the repo's documented OAuth setup.

### Verify sequence before any commit/deploy

From `portal/`:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Follow the current `docs/Subagent-Orchestration.md` pipeline and independent verification gate. An agent self-report is not sufficient.

---

## 12. Non-goals for the first refactor program

Unless separately approved, do not bundle these into the UI cleanup:

- React version upgrade.
- Vite/toolchain upgrade.
- router migration.
- TanStack Query migration.
- form-library migration.
- Tailwind adoption.
- global MUI/Ant Design migration.
- visual redesign of the product.
- database migration.
- backend due-date contract change.
- reminder-system redesign.
- broad accessibility rewrite outside touched components.

---

## 13. Definition of success

This refactor program is successful if, after several small vertical slices:

1. Quincy looks materially the same or better.
2. Date/time UX is substantially better and uses MUI X scrollable time selection.
3. Existing date-only/date+optional-time contracts remain exact.
4. New generic overlays do not require bespoke focus/outside-click code each time.
5. New form controls can be built from a small Quincy UI layer instead of copying markup/style behavior.
6. Feature CSS is increasingly colocated/owned without a destabilizing stylesheet rewrite.
7. Large components become easier to extend without losing test coverage.
8. Bundle/framework surface is kept purposeful: libraries are added because they remove meaningful product engineering burden.

---

## 14. Immediate next step

Use `Quincy-UI-Refactor-Implementation-Plan.md` as a starting draft, then re-read current `main` before implementation because the repository is active and may have changed after this handoff was generated.
