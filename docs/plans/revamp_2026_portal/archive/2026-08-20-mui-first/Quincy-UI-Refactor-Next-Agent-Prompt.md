> [!WARNING]
> **Archived and superseded.** Preserve for provenance only. Do not use this file as active implementation guidance; start at `../../Index.md`.

# Ready-to-Paste Prompt for the Next Agent

You are taking over planning and implementation design for a UI architecture refactor in the private repository:

`mjj2332/Quincy_Portal`

Before doing anything, read:

1. `AGENTS.md`
2. `docs/todo.md`
3. `docs/lessons.md`
4. `docs/Subagent-Orchestration.md`
5. `Quincy-UI-Architecture-Handoff.md`
6. `Quincy-UI-Refactor-Implementation-Plan.md`

Then inspect the current `main` branch directly. The repository is active, so do not assume the handoff's file contents are still exact.

## Objective

Refactor Quincy's UI architecture incrementally so the product can keep adding features without accumulating bespoke implementations of solved UI behavior.

Do **not** redesign Quincy or migrate it wholesale to a visual framework.

The intended direction is:

- retain Quincy's custom CSS/token design system;
- introduce small Quincy-owned UI primitives only when proven by real consumers;
- use MUI X as the selected date/time engine, especially for scrollable time selection;
- preserve custom Quincy wrappers/styles around MUI X;
- evaluate Radix Primitives incrementally for generic popover/dialog/menu/tooltip behavior rather than continuing to hand-build focus/outside-click semantics;
- keep Floating UI for special positioning or until a bounded Radix proof demonstrates a better replacement;
- split large feature components and `app.css` by ownership as those surfaces are touched;
- defer TanStack Query/router/form-library changes until actual product pressure justifies them.

## Critical correctness constraint

Subtask due dates currently accept and must continue to accept exactly:

```text
YYYY-MM-DD
YYYY-MM-DDTHH:MM
```

Time is optional forever.

A datetime is a literal Sydney wall-clock value, not a UTC instant. Do not introduce `toISOString()`, `Z`, offsets, seconds, or browser-local timezone shifts into this contract.

## Planning style

Use **tracer bullets** / vertical slices.

Do not propose a giant horizontal refactor such as "build a design system first, migrate all CSS, then convert every component."

Each implementation slice must:

1. improve or prove one real production surface end-to-end;
2. be small enough for focused review;
3. preserve current behavior outside its scope;
4. include targeted tests plus the full repo gate;
5. leave production coherent if later slices are delayed or cancelled.

Start from the implementation plan's proposed order, but challenge it based on current `main` and `docs/lessons.md` before build.

## First recommended product slice

The leading candidate is the existing subtask due-date/time control:

- keep Quincy's compact metadata trigger and action language;
- add MUI X calendar + scrollable time UX;
- include Today/Tomorrow/Next Monday/etc. shortcuts;
- retain optional time;
- preserve existing focus/Escape/outside-click behavior and composer flow;
- add explicit parse/serialize tests protecting the literal date contract.

Treat this as the proof for MUI X integration. Do not use it as justification to convert unrelated controls to Material UI.

## Process

Follow `docs/Subagent-Orchestration.md` exactly for planning, review, implementation, diff review, and independent verification.

Before committing, from `portal/` run:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

There is no staging environment. Production checks are passive/read-only unless a human explicitly authorizes or performs mutation.

## Deliverable expected from you first

Produce a current-main-aware implementation plan in `docs/plans/` that:

- names the exact files/dependencies expected per tracer bullet;
- states behavior and non-goals per slice;
- identifies focus/portal/CSS/timezone risks;
- lists test changes and manual QA per slice;
- defines explicit stop/decision checkpoints after the MUI X and Radix proofs;
- does not begin implementation until the repository's required plan-review pipeline is complete.
