# Next-Agent Handoff — Quincy Portal Revamp

You are continuing planning or implementation for `mjj2332/Quincy_Portal`.

## Start/process

1. Inspect current `main` and record exact SHA.
2. Read `AGENTS.md`, `docs/todo.md`, `docs/lessons.md`, and `docs/Subagent-Orchestration.md`.
3. Start at `docs/plans/Quincy-Portal-Revamp-Index.md`.
4. Read only the active tracer-bullet path.
5. Do not load archive unless auditing history.
6. The corrected authority package is now promoted: revised **D-13/D-15, D-16–D-19, and A8–A14**. Treat planned outcomes as targets until their owning tracer bullets ship.

Package baseline for this revision: `2ac2ca27a1e0ded328b9265613ab4ebeeb7db1b0`; recheck before implementation.

## Approved proposal direction

- TB0 promoted revised D-13/D-15 and D-16–D-19/A8–A14 and established the baseline/drift record.
- TB0A React 19.2 compatibility-only; TB0B developer-managed global Stage order; TB1 Tailwind v4/Base UI/Sera/Lucide/Preflight-off foundation.
- Keep typed custom router; TB2 incremental TanStack Query + focus/poll/broadcast + access-loss purge.
- TB3 flat project discussion/read state; TB4 durable D1 outbox/Queue/ledger/recovery/DLQ.
- Project Workspace left rail canonical for Stage/Deadline/team; Collaboration owns checklist/discussion.
- TB4A role-specific team deltas; TB4B Sydney project Deadline/reminders; TB4C safe assigned-Editor activity/registry.
- **TB4D:** checklist schedule states = unscheduled, due-only, or start/end range; preserve current `due_date` as end; Sydney/DST/versioned conflict; end drives due reminder; no recurrence.
- **TB4E:** add global `external_editor`, project membership remains `editor`; assigned-project-only with the explicit allow-list (`uploadEdited`, `viewRaw`, `annotateRaw`, `recommendRaw`, `compareFrames`, `viewEdited`, `reviewEdited`, `annotateEdited`, `collaborateOnProject`, then `moveProjectStage`/`viewProductionCalendar` when shipped); withhold publish/client-preview/final-download/extras/RAW-selection/RAW-upload, `viewAllProjects`, project administration, Notice Board/Admin, AutoHDR send, and provider diagnostics; role-safe server DTO/event projection; participant email only project-scoped; `productionNotes` is external-safe while internal `projects.notes` is excluded and never copied; client contacts/billing/order/agency notes/Dropbox/provider/Admin hidden.
- TB5A one Stage command/Board order; TB5B dnd-kit board interaction.
- **TB5C:** Dashboard `List | Kanban | Calendar`; Month/Week/Agenda; project Deadline milestones + checklist milestones/ranges; dedicated authorized range API; typed filters/URL; Unscheduled drag; project Deadline drag confirmation; checklist drag/end-resize; keyboard Reschedule; FullCalendar Standard official shadcn registry; no premium Scheduler/recurrence/external calendar sync.
- TB6 URL-addressable Overview/Activity/Discussion; TB7 Notice Board read migration (External Editor excluded); TB8 evidence-driven wider convergence.

## External Editor critical invariants

- Existing global roles are only three today; TB4E must migrate role schema/types before provisioning External Editor.
- Current `hasProjectAccessForUser` is membership-friendly for non-`viewAllProjects`, but current project-list route special-cases Photographer and otherwise returns broad scope. **Generalize server list/search before exposing the new role.**
- External Editor is never a Photographer candidate.
- Conversion to External Editor blocked while Photographer memberships exist; incompatible memberships are never silently deleted.
- Every role transition revokes all sessions; current code only revokes on deactivation, so this is real work.
- Archived project unavailable; delivered remains available while membership active.
- Assigned project may expose `productionNotes` and participant emails, not internal `projects.notes`, `agencies.notes`, agent/client contact fields, billing/order bookkeeping, Dropbox/provider/Admin data; existing `notes` is never copied into `productionNotes`.
- No global directory/Search leakage; participant contact is project-scoped.
- Final membership removal warns immediate access loss and atomically applies checklist cleanup.
- Access loss purges stale client caches/project UI.

## Checklist/Calendar critical invariants

- Existing date-only due is a calendar date, never fabricated UTC midnight.
- Range drag and Month moves preserve each endpoint's Sydney civil/wall-clock time-of-day on the moved dates, not elapsed duration, across DST.
- Start-only invalid; range start<end; multi-day allowed.
- Canonical timezone Australia/Sydney; DST gaps reject, repeated time asks fold choice.
- Project Deadline remains separate and uses TB4B schedule version/reminders.
- Calendar is projection over source domains, not new source of truth.
- Calendar filters never widen authorization.
- Project Month unscheduled drop = 17:00 Sydney Deadline + confirmation/no invented reminder offsets; Week = dropped 15-minute slot.
- Checklist Month unscheduled drop = date-only due; Week = one-hour range.
- Week snap 15 min; explicit editor minute-precise.
- Stale conflict reverts and never auto-retries.
- Same-assignee timed overlap allowed with non-blocking indicator.
- FullCalendar flavor selected by Quincy evidence, not dependency aesthetics.

## Narrow reading paths

- TB4D: `core/12-Production-Calendar-And-Checklist-Scheduling.md` → `core/07-Notifications-On-Cloudflare.md` → `core/09-Migration-Rollback-And-Verification.md` → TB4D.
- TB4E: `core/13-External-Editor-Authorization.md` → current-state audit → notification/discussion privacy → TB4E.
- TB5C: `core/12-Production-Calendar-And-Checklist-Scheduling.md` → `core/13-External-Editor-Authorization.md` → frontend/freshness → `research/Production-Calendar-FullCalendar-Shadcn.md` → TB5C.

## Full verification

From `portal/`:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Agent reports are never final verification. Update todo/status only with actual results and move an implementation plan to `implemented/` only after live deployment/production verification.
