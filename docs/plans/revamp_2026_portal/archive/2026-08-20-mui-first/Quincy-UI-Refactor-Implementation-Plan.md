> [!WARNING]
> **Archived and superseded.** Preserve for provenance only. Do not use this file as active implementation guidance; start at `../../../Quincy-Portal-Revamp-Index.md`.

# Quincy Portal UI Refactor — Tracer-Bullet Implementation Plan

**Status:** DRAFT FOR NEXT-AGENT REVIEW  
**Date:** 2026-08-20  
**Repository:** `mjj2332/Quincy_Portal`  
**Companion context:** `Quincy-UI-Architecture-Handoff.md`

---

## 1. Planning principle

Implement this as a sequence of **tracer bullets**: small vertical slices that cross the minimum necessary layers to deliver a real, usable improvement and prove an architectural direction.

Avoid horizontal foundation work such as:

> "Build 15 UI primitives, migrate all CSS, install 5 libraries, then start using them."

Prefer:

> "Improve one real due-date interaction end-to-end using the proposed foundation, preserve all contracts/tests, and only extract the reusable pieces that the slice proves are needed."

Every slice below should be independently reviewable and should leave production in a coherent state.

---

## 2. Global guardrails

These apply to every slice.

### Preserve

- Quincy custom CSS and design tokens.
- existing visual identity.
- keyboard/focus behavior in touched controls.
- API capability/auth boundaries.
- existing subtask due string semantics.
- existing test behavior unless the behavior is intentionally replaced with an equivalent/better UX.

### Avoid

- bulk visual-framework migration;
- Tailwind;
- `CssBaseline`;
- unrelated dependency upgrades;
- route migration;
- server-state migration;
- broad CSS churn;
- backend/schema changes without an actual requirement.

### Date-time invariant

Subtask due serialization remains exactly one of:

```text
YYYY-MM-DD
YYYY-MM-DDTHH:MM
```

No `Z`, offset, seconds, or automatic timezone conversion.

---

# Tracer Bullet 0 — Baseline and dependency decision record

## Goal

Create a safe baseline and make the intended UI-library boundary explicit before product code changes.

## User-visible change

None.

## Scope

- Re-read current `main`:
  - `AGENTS.md`
  - `docs/todo.md`
  - `docs/lessons.md`
  - `docs/Subagent-Orchestration.md`
  - `portal/package.json`
  - `portal/apps/web/src/main.tsx`
  - `portal/apps/web/src/styles/index.css`
  - `SubtaskChecklist.tsx` and its DOM test
  - `AnchoredPopover.tsx`
- Run the full verify sequence before changes and record baseline.
- Confirm dependency versions compatible with React 18 and current Vite/TypeScript.
- Record the architecture decision in the implementation plan before build:
  - MUI X = date/time engine only.
  - custom Quincy CSS remains visual authority.
  - Radix Primitives = candidate generic behavior layer, to be proven in a later bounded slice.

## Acceptance criteria

- Full baseline verification is green, or any pre-existing failure is explicitly documented before implementation.
- No source changes other than a planning/decision document if the repo's process requires it.
- No dependencies installed yet unless required to validate a compatibility blocker.

## Why this is a tracer-bullet precursor

It is intentionally tiny and prevents the next slice from mixing pre-existing failures with refactor regressions.

---

# Tracer Bullet 1 — MUI X subtask due picker, end-to-end

## Goal

Replace the current native date/time picker experience for **one real production surface** — subtask due date/time — with a Quincy-styled MUI X experience while preserving the existing backend/data contract.

This is the highest-value architectural proof because it validates:

- MUI X dependency integration;
- MUI theming inside custom CSS;
- Day.js serialization discipline;
- custom compact trigger + richer picker composition;
- existing focus/popover behavior;
- narrow panel/mobile constraints.

## User-visible behavior

Clicking a subtask due-date metadata trigger opens a polished Quincy picker with:

- calendar date selection;
- quick shortcuts such as `Today`, `Tomorrow`, `Next Monday`, `In 7 days`;
- an explicit optional-time control;
- scrollable time selection via MUI `DigitalClock` or `MultiSectionDigitalClock`;
- Quincy `Remove`, `Cancel`, and `Save` actions.

Date-only remains possible.

## Recommended implementation shape

Create the minimum reusable module needed, e.g.:

```text
portal/apps/web/src/ui/DateTimePicker/
  QuincyDueDatePicker.tsx
  QuincyDueDatePicker.css
  due-date.ts
```

or colocate initially under `SubtaskChecklist/` if the abstraction is not yet proven generic.

Do **not** force a generic `DateTimePicker` abstraction before the actual due-date semantics are clear.

### Dependencies

At monorepo root, pinned consistently with the repo:

```text
@mui/x-date-pickers
@mui/material
@emotion/react
@emotion/styled
dayjs
```

Do not install Ant Design in parallel.

### Provider setup

Add only the providers MUI X actually needs near the web root.

Do not add MUI `CssBaseline`.

### Theme

Map picker internals toward Quincy:

- primary/selection: ink black;
- paper/surfaces: Quincy white/warm paper;
- UI font: Apfel Grotezk / existing sans stack;
- small radius;
- hairline borders;
- restrained shadow.

Keep surrounding layout/actions as Quincy classes.

### Serialization

Prefer pure helpers with explicit tests, e.g.:

```ts
parseDueDate(value: string | null)
serializeDueDate(date: Dayjs | null, includeTime: boolean)
formatDueDate(value: string)
```

`serializeDueDate` must return only the two accepted literal shapes.

Never use `toISOString()` for subtask due values.

## Existing behavior to retain

- keyboard-accessible trigger;
- Escape close;
- focus return;
- outside-click/outside-focus close;
- one metadata popover at a time;
- Remove;
- date-only save;
- date+time save;
- composer due-date support;
- failed network update handling;
- drag/drop unaffected.

## New test cases

At minimum:

1. Existing `YYYY-MM-DD` initializes with time disabled/unset.
2. Existing `YYYY-MM-DDTHH:MM` initializes date and time correctly.
3. Saving date only emits exactly `YYYY-MM-DD`.
4. Saving date+time emits exactly `YYYY-MM-DDTHH:MM`.
5. Removing time from a datetime emits date-only.
6. Output never contains seconds, `Z`, or an offset.
7. `Tomorrow` changes the draft without bypassing intended Save/Accept semantics.
8. The selected scrollable time changes the draft.
9. Escape closes and restores focus.
10. Interaction inside the picker does not trigger Quincy's outside-focus close unexpectedly.
11. Composer cancel/reset still clears due metadata.
12. Narrow viewport/panel does not overflow in the intended responsive presentation.

## Verification

Run full repo verify sequence plus targeted DOM tests.

Manual local check at desktop and phone-width equivalent.

## Stop condition

Do not proceed to a wider MUI adoption. This slice proves MUI X date/time only.

---

# Tracer Bullet 2 — First Quincy form primitives on one ProjectFields section

## Goal

Prove a tiny Quincy-owned form primitive layer without turning the refactor into a component-library project.

## User-visible behavior

None intended beyond pixel-equivalent or slightly improved field consistency/accessibility.

## Scope

Extract only the primitives needed for one bounded section of `ProjectFields.tsx`, for example the **Client** section:

```text
ui/Field/
ui/TextField/
```

Possible public shape:

```tsx
<Field label="Agent email" error={errors.agentEmail}>
  <TextField ... />
</Field>
```

The actual API should be derived from Quincy's current markup, not copied from another design system.

## Why one section only

This tests whether the abstraction reduces repetition without hiding normal React/HTML behavior or creating prop soup.

## Acceptance criteria

- Client-section fields render/behave the same.
- Existing validation remains intact.
- CSS continues to derive from Quincy tokens.
- Primitive CSS is owned with the primitive rather than adding another large `app.css` block.
- No migration of every form in the codebase.

## Tests

Update/add `ProjectFields.dom.test.tsx` only where needed to prove label/error/control behavior remains correct.

## Decision checkpoint

After this slice, review whether `Field`/`TextField` are genuinely clearer. If not, simplify or stop before spreading the abstraction.

---

# Tracer Bullet 3 — Radix Popover proof on the smallest real overlay

## Goal

Determine whether Radix Primitives should replace custom generic overlay/focus behavior over time.

## Suggested surface

Start with the smallest checklist popover whose domain behavior is simple, likely `ActionsControl` (Delete-only), rather than migrating due date and assignee simultaneously.

Do not use the MUI slice as the first Radix experiment if that would make failures ambiguous between two new libraries.

## Scope

- Add only `@radix-ui/react-popover` if required.
- Create a Quincy `Popover` wrapper only as far as this one consumer proves useful.
- Preserve trigger markup/classes where practical.
- Preserve Escape/focus return/outside click semantics.
- Keep current `AnchoredPopover` for all other consumers during this slice.

## Acceptance criteria

- Same user-visible behavior for Actions popover.
- Keyboard and focus tests remain green.
- No double portal/focus-boundary regressions.
- Less bespoke interaction code is required than the current implementation.
- CSS remains Quincy-owned.

## Decision checkpoint

After implementation, explicitly decide one of:

1. **Adopt Radix incrementally** for ordinary popover/dialog/menu/tooltip behavior.
2. **Keep existing Floating UI wrapper** because Radix creates more integration cost than it removes.

Do not assume adoption before this proof.

---

# Tracer Bullet 4 — Split `SubtaskChecklist` by responsibility while changing no behavior

## Goal

Reduce cognitive load in the feature that is already becoming an interaction hub.

## Preconditions

Only do this after Tracer Bullets 1 and 3 stabilize the due/popover direction. Otherwise file boundaries will be guessed and immediately churn.

## Scope

Extract obvious responsibility boundaries, potentially:

```text
SubtaskChecklist/
  SubtaskChecklist.tsx
  SubtaskRow.tsx
  SubtaskComposer.tsx
  SubtaskDueDate.tsx
  SubtaskAssignee.tsx
  SubtaskActions.tsx
  subtask-date.ts
```

Do not extract `useSubtasks.ts` unless network/mutation state has a clean contract after the visual controls are separated.

## User-visible change

None.

## Acceptance criteria

- DOM behavior/tests remain equivalent.
- Public `SubtaskChecklist({ projectId })` contract remains unchanged.
- Focus scheduling and drag/drop behavior remain easy to trace.
- No new generalized abstraction created solely to reduce file size.

## Verification

Full existing checklist DOM suite is the primary safety net.

---

# Tracer Bullet 5 — CSS ownership migration for the touched checklist/date-picker surface

## Goal

Start reducing `app.css` growth without a dangerous whole-app stylesheet reorganization.

## Scope

Move only styles owned by the already-refactored surfaces, for example:

```text
SubtaskChecklist.css
QuincyDueDatePicker.css
```

Leave token files global.

Leave unrelated `app.css` sections untouched.

## Acceptance criteria

- No visual change beyond explicitly approved picker improvements.
- Import order is deterministic.
- No duplicate stale rules remain in `app.css`.
- Desktop and narrow panel rendering remains correct.

## Manual QA

Use the widths already relevant to the collaboration panel: wide desktop, ordinary desktop, phone-width.

---

# Tracer Bullet 6 — Expand proven form primitives to the rest of `ProjectFields`

## Goal

Only after Tracer Bullet 2 proves the API, remove repeated field wrappers from the rest of the project create/edit form.

## Scope

Migrate straightforward inputs/textarea/error wrappers.

Do not force checkbox groups, team selectors, or read-only policy sections into an abstraction if their semantics differ.

## User-visible change

None intended.

## Acceptance criteria

- Existing create/edit form behavior remains unchanged.
- Read-only policy remains exact.
- Error associations and accessibility remain correct.
- Markup becomes substantially easier to scan.

---

# Tracer Bullet 7 — Shared date picker on project shoot date only

## Goal

Prove the MUI X/Quincy date foundation has a second consumer before calling it a generic shared component.

## Scope

Replace only `shootDate` native date input with a Quincy-styled date picker.

Keep `timeWindow` as free text because it represents a range, not a single time.

## Acceptance criteria

- `shootDate` remains the exact API/form string shape expected today.
- `timeWindow` contract unchanged.
- Create/edit screens work.
- No automatic timezone conversion.

## Architecture checkpoint

If the subtask due picker and shoot-date picker now share meaningful behavior, promote common pieces into `ui/DateTimePicker/`.

If they do not, keep separate domain wrappers over the same MUI primitives.

---

# Tracer Bullet 8 — Evaluate server-state tooling using one future dynamic surface

## Status

**Deferred decision, not part of the initial refactor.**

## Trigger

Revisit when a real feature—likely direct video review—requires meaningful combinations of:

- background processing status;
- comments/annotations changing independently;
- optimistic mutations;
- invalidation/refetch;
- retry;
- stale cache coordination.

## Proof approach

If triggered, introduce TanStack Query on one vertical feature flow rather than converting the entire app.

---

# Tracer Bullet 9 — Evaluate router library only when route pressure is real

## Status

**Deferred decision, not part of the initial refactor.**

## Trigger examples

- `/projects/:id/video/:videoId`
- timestamp/deep-link query state
- asset-specific review URLs
- nested admin subsections
- route-level loading/data contracts becoming difficult to maintain manually

## Proof approach

If triggered, compare TanStack Router and React Router against Quincy's current typed route helpers. Do not rewrite routing just because a library is conventional.

---

## 3. Suggested delivery grouping

Each tracer bullet should normally be independently reviewable/committable. A practical grouping is:

### Release A — Date/time proof

- TB0 baseline
- TB1 subtask MUI X due picker

This delivers immediate user value and proves the most important new library integration.

### Release B — UI primitive proof

- TB2 `Field`/`TextField` on one ProjectFields section
- TB3 one Radix popover proof

This proves the two architectural directions without large-scale migration.

### Release C — Consolidate proven patterns

- TB4 split SubtaskChecklist responsibilities
- TB5 move only touched CSS ownership
- TB6 expand proven form primitives

### Release D — Second date consumer

- TB7 project shoot date

TB8/TB9 remain future decision points.

---

## 4. Review focus by slice

### TB1 review hotspots

- no timezone semantic regression;
- optional time remains optional;
- MUI portal/focus behavior;
- narrow panel overflow;
- MUI global styles do not leak into Quincy.

### TB2/TB6 review hotspots

- label/error association;
- read-only behavior;
- abstractions do not hide native semantics;
- no over-generalization.

### TB3 review hotspots

- Escape/outside click/focus return;
- nested portals;
- focus guards;
- comparison of deleted custom code vs introduced wrapper complexity.

### TB4/TB5 review hotspots

- behavior-only refactor remains behavior-only;
- CSS import order;
- stale/duplicate global selectors;
- dnd/focus refs remain stable.

---

## 5. Required verification for every implementation slice

Follow current repository instructions and rerun from `portal/`:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Also run the narrowest relevant test file during iteration, but do not substitute that for the final full gate.

For UI slices, perform local browser verification at relevant desktop and narrow widths.

There is no staging environment. Production verification is passive/read-only unless the human explicitly authorizes or performs a mutating walkthrough.

---

## 6. Expected outcome after the initial program

The first program should end with:

```text
React
  |
  +-- Quincy visual system (custom CSS tokens)
  |
  +-- Quincy UI wrappers/primitives
  |     +-- proven Field/TextField
  |     +-- proven overlay direction
  |     +-- Quincy date/time wrappers
  |
  +-- Specialized libraries
        +-- MUI X: date/time
        +-- Tiptap: rich text
        +-- dnd-kit: drag/drop
        +-- Floating UI: special positioning and/or legacy surfaces
        +-- Radix: generic overlay behavior only if TB3 proves it
```

The desired result is **less custom behavior code, not less custom design**.
