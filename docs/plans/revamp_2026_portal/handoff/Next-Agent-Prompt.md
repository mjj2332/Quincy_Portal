# Next-Agent Handoff — Quincy Portal Revamp

You are continuing planning or implementation for the private repository `mjj2332/Quincy_Portal`.

## Start and process

1. Inspect current `main` and record its exact SHA.
2. Read `AGENTS.md`, `docs/todo.md`, `docs/lessons.md`, and `docs/Subagent-Orchestration.md`.
3. Start at `docs/plans/Quincy-Portal-Revamp-Index.md`.
4. Read only the path relevant to the active tracer bullet.
5. Do not load the archive unless auditing historical decisions.
6. Do not treat this proposal package as repository authority until D-16–D-19/A8–A12 are explicitly promoted.

The package baseline when revised was `8bcb48245a727b048053bd3653cf07f3ad99b780`; recheck it.

## Approved proposal direction

- TB0 proposes/promotes D-16–D-19 and A8–A12, captures the matched baseline and drift register, and creates reviewed foundational implementation plans.
- TB0A upgrades production `portal/` to the latest stable exact React `19.2.x` patch. It is compatibility-only; no React Compiler, SSR, Server Components, or feature refactor.
- TB0B removes ordinary Admin global Stage ordering from both UI and self-service API while retaining label and active/inactive management.
- TB1 uses Tailwind v4, Base UI/Sera shadcn source, Lucide, semantic Quincy tokens, app-local ownership, and disabled Preflight. First consumer is ProjectFields Client section.
- Keep the typed custom router; TB2 introduces TanStack Query incrementally for Project detail plus active collection assets, with focus/poll/broadcast freshness and draft preservation.
- TB3 keeps a flat project discussion stream, current storage via adapter, and adds server-owned read state.
- TB4 proves D1 outbox + Cloudflare Queue + delivery ledger/DLQ/recovery/Admin operations using project-comment mention.
- The Project Workspace left rail is canonical for Stage, Deadline/Reminders, Photographers, and Editors. Collaboration remains checklist/subtasks and project comments.
- TB4A establishes the operational-first rail and role-specific assignment deltas/cycles.
- TB4B adds one versioned `Australia/Sydney` Deadline schedule, bounded offsets, Due-now, reminder-email preference, and Kanban due metadata/no card RAW count.
- TB4C adds immutable safe activity plus a finite mandatory assigned-Editor registry with membership-cycle eligibility, privacy-safe copy, and operation-level coalescing.
- TB5A introduces `moveProjectStage`, activates the rail Stage picker, preserves semantic system-stage progression, allows stage-only manual AutoHDR entry/exit, normalizes current visible board order, and makes `boardPosition` the sole manual order.
- TB5B uses dnd-kit for pointer/touch/keyboard/non-drag movement against TB5A.
- TB6 is a URL-addressable responsive sheet with separate Overview/Activity/Discussion.
- TB7 migrates notice read state/freshness/reliable mentions only.
- TB8 is evidence-driven, one surface release at a time.

## Canonical capability/surface contracts

- `editProject`: Photographer, Editor, Deadline, Reminder mutations.
- `moveProjectStage`: Stage mutation, initially Admins and Editors.
- Collaboration/workspace visibility never grants mutation rights.
- Create Project retains initial assignments. Routine Edit Project team selectors retire only after rail parity.
- Archived projects are read-only until restored.
- Global pipeline order is developer-managed; display order never redefines system workflow semantics.

## System-stage contract

```text
awaiting_raw → raw_review → editing_autohdr → edited_review → delivered
```

- Normal one-step public forward move: immediate.
- Backward/skip/delivered: confirm.
- AutoHDR entry/exit: dedicated confirmation; allowed Admin/Editor; Stage-only; Editor sees neutral **Editing**.
- Rail/non-drag target placement: bottom. Positional drag: exact neighbours.
- Entering delivered supersedes pending project Deadline occurrences but does not publish artifacts.

## Deadline contract

- Separate from shoot and checklist due fields.
- `Australia/Sydney`; gap rejection and explicit fold choice.
- Presets 1 day/4 hours/1 hour, none preselected.
- Custom 1 minute–30 days, max eight unique normalized offsets.
- Due-now always; past Deadline emits one overdue event and skips elapsed advances.
- Every-minute scan, target in-app within two minutes.
- Recipients use active Editor membership cycles at fire/delivery; no unassigned Admins.
- Delivered/archive supersedes pending rows; no silent resume.
- Reminder email default-on only after global per-user opt-out exists.

## Critical invariants

- Implementation only under `portal/`; prototype reference-only.
- Do not weaken auth, audit, immutable-media, or collaboration access.
- Deep links/native new-tab remain.
- No cross-project/collection cache leakage.
- Refresh never destroys drafts, Lightbox, selection, open controls, or active drag.
- Subtask due literal remains `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` Sydney wall-clock.
- Role removal preserves the other role and warns/atomically clears checklist assignments only after final non-admin role loss.
- Broad project-change means approved finite activity registry, not every D1/storage write.
- One semantic notification producer at a time.
- Email `unknown` is not automatically retried.
- There is no staging environment; production verification is passive unless human-authorized.

## Narrow reading paths

- TB0A: `core/04-Frontend-Architecture.md` → `core/09-Migration-Rollback-And-Verification.md` → TB0A.
- TB0B: `core/08-Kanban-Modernization.md` → TB0B.
- TB4A: current-state audit + PRD delta + TB4A.
- TB4B: PRD delta + notification architecture + TB4B.
- TB4C: discussion/activity + notification architecture + TB4C.
- TB5A: current-state audit + Kanban architecture + historical implemented ordering plans + TB5A.

## Full verification

From `portal/`:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

An agent report is never verification. Follow the independent review/gate, update the active plan and todo with actual results, and move a plan to `implemented/` only after live deployment and production verification.
