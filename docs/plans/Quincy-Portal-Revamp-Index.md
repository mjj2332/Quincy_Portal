# Quincy Portal Revamp — Index

**Status:** Coordinated planning and research proposal; owner decisions are settled inside this package, but repository-authority promotion is still pending.  
**Index reconciled:** 2026-08-24  
**Current `main` inspected:** `mjj2332/Quincy_Portal` at `b09baf48f9aeb8d3d24e43e28394e03b74b018b4` (merged PR [#44](https://github.com/mjj2332/Quincy_Portal/pull/44))  
**Detailed-package baseline:** `2ac2ca27a1e0ded328b9265613ab4ebeeb7db1b0`; every detailed file that describes “current” behavior must be revalidated against current `main` before implementation.  
**Detailed folder:** [`revamp_2026_portal/`](./revamp_2026_portal/README.md)

This is the shortest entry point for the coordinated Quincy Portal revamp. Read only the path relevant to the active task. Do **not** load the whole documentation tree by default; open additional files only when current source, authority, or a discovered dependency requires them.

## Start here

1. Check current repository authority and implementation state: current `main`, `AGENTS.md`, `docs/todo.md`, `docs/lessons.md`, and the relevant parts of `docs/Decision-Sheet.md`, `docs/Implementation-Plan.md`, and `docs/PRD.md`.
2. Read the [high-level brief](./Quincy-Portal-Revamp-Brief.md) and [decision register](./revamp_2026_portal/core/01-Decision-Register.md) as proposal context, not as proof that a feature is live.
3. Choose the narrow reading path below.
4. Before implementation, compare current `main` with the detailed-package baseline and capture material drift in TB0 or the active repository-native tracer-bullet plan.
5. Read `docs/Subagent-Orchestration.md` only when the active task actually uses subagents; it is not part of the universal reading path.

## Baseline drift: direct send-only AutoHDR

The detailed revamp package predates PR #44. Current `main` now includes an Admin-only direct AutoHDR API handoff from RAW Review. This is a **current source and authority baseline to preserve**, not a new revamp tracer bullet and not evidence that the wider revamp proposal has been promoted.

A merge to `main` does not by itself establish production deployment. Deployment, Worker-secret provisioning, and live verification status remain governed by `docs/todo.md` and the repository’s normal release rules.

Every affected tracer bullet must preserve these boundaries:

| Boundary | Current contract to preserve |
|---|---|
| Explicit action | `Send N selected to AutoHDR` remains a separate Admin-only operation. Manual Stage movement never calls AutoHDR. |
| Claim and idempotency | A send begins only from `raw_review`, freezes the server-side selected RAW asset IDs, reuses an identical active job, and blocks a different selection while that job is queued/running. |
| Credential and media boundary | `AUTOHDR_API_KEY` stays only on the background Worker. The Worker reads private R2 originals and uploads them through provider-issued presigned URLs; neither browser nor app responses receive the key. |
| Send-only scope | The direct path creates presigned uploads and finalizes the photoshoot. It supplies no completion callback, does not poll provider status, and does not retrieve edited photos. Legacy/manual edited-media intake remains a separate compatibility path. |
| Provider retry contract | Before first live use, verify with AutoHDR `mock_call` or written provider confirmation that callback omission is accepted and that repeated same-UID finalization after an ambiguous response is idempotent. An unresolved provider-acceptance outcome must be reconciled, not converted automatically into a fresh paid photoshoot. |
| Stage ownership | Provider finalization happens before the guarded automatic `raw_review → editing_autohdr` write. If the current Stage is no longer `raw_review`, that newer state wins. TB5A must strengthen this to its expected Stage/revision contract so an away-and-back Stage cycle cannot look unchanged. |
| Jobs and freshness | `autohdr_api_send` is the direct-send job kind. Preserve terminal-aware job refresh and do not accidentally revive the legacy AutoHDR round-trip polling/fetch path for a direct-send project. |
| Notifications and activity | Finalization plus its guarded Stage advance is one semantic operation. Cut over to durable activity/outbox exactly once, after provider acceptance; notification failure must not relabel an accepted send as failed. |
| Authorization and privacy | Future External Editors may receive neutral Stage/workflow presentation where approved, but never the AutoHDR send capability, provider credential, UID, diagnostic payload, or Admin job surfaces. |

### Production safety gate

The code shape is compatible with this revamp, but the direct provider path is not considered fully production-proven until all of the following are recorded:

1. `AUTOHDR_API_KEY` is provisioned on the production background Worker without entering repository files, app bindings, browser code, or logs.
2. A provider `mock_call` or support-assisted contract test confirms the create response, presigned PUT requirements, callback omission, and finalization response without consuming ordinary production credits.
3. Failure injection covers ambiguous external outcomes: provider create/finalize acceptance followed by a lost response, Workflow step retry, and a local completion-write failure. Recovery must reuse/reconcile the existing job and UID where known rather than silently creating a second paid photoshoot.
4. The first real send is verified from selection freeze through provider finalization, job/audit state, and guarded Stage behavior. This gate does not require or authorize edited-photo retrieval.

## Reading paths

| Reader/task | Read these files |
|---|---|
| Owner reviewing scope and direction | [Brief](./Quincy-Portal-Revamp-Brief.md) → [Decision register](./revamp_2026_portal/core/01-Decision-Register.md) → [PRD delta](./revamp_2026_portal/core/03-PRD-Delta.md) |
| Agent drafting the umbrella/authority update | Current [Decision Sheet](../Decision-Sheet.md) → [Implementation Plan](../Implementation-Plan.md) → [PRD](../PRD.md) → [Package README](./revamp_2026_portal/README.md) → [Current-state audit](./revamp_2026_portal/core/02-Current-State-Audit.md) → [Roadmap](./revamp_2026_portal/roadmap/README.md) → [Document update map](./revamp_2026_portal/core/10-Repository-Document-Update-Map.md) |
| AutoHDR explicit send, Editing Stage, jobs, or notifications | Current [Implementation Plan](../Implementation-Plan.md) → current [PRD](../PRD.md) → [Current-state audit](./revamp_2026_portal/core/02-Current-State-Audit.md) → [Route/data freshness](./revamp_2026_portal/core/05-Route-And-Data-Freshness.md) → [Notification architecture](./revamp_2026_portal/core/07-Notifications-On-Cloudflare.md) → [Kanban/stage architecture](./revamp_2026_portal/core/08-Kanban-Modernization.md) → [Migration/verification](./revamp_2026_portal/core/09-Migration-Rollback-And-Verification.md) |
| React 19.2 runtime upgrade | [Frontend architecture](./revamp_2026_portal/core/04-Frontend-Architecture.md) → [Migration/verification](./revamp_2026_portal/core/09-Migration-Rollback-And-Verification.md) → [TB0A](./revamp_2026_portal/roadmap/TB0A-React-19-2-Runtime-Upgrade.md) |
| Admin pipeline boundary | [Decision register](./revamp_2026_portal/core/01-Decision-Register.md) → [Kanban/stage architecture](./revamp_2026_portal/core/08-Kanban-Modernization.md) → [TB0B](./revamp_2026_portal/roadmap/TB0B-Pipeline-Configuration-Boundary.md) |
| Tailwind/shadcn or UI convergence | [Design convergence](./revamp_2026_portal/core/11-Design-Convergence.md) → [Frontend architecture](./revamp_2026_portal/core/04-Frontend-Architecture.md) → [UI research](./revamp_2026_portal/research/UI-Stack-Tailwind-Shadcn.md) → [TB1](./revamp_2026_portal/roadmap/TB1-Tailwind-Shadcn-Foundation.md) or [TB8](./revamp_2026_portal/roadmap/TB8-Wider-UI-Migration-And-Cleanup.md) |
| Automatic refresh, routing, multi-tab behavior | [Route/data freshness](./revamp_2026_portal/core/05-Route-And-Data-Freshness.md) → [TB2](./revamp_2026_portal/roadmap/TB2-Route-Safe-Data-Freshness.md) |
| Project discussion/read state | [Discussion architecture](./revamp_2026_portal/core/06-Discussions-And-Notice-Board.md) → [TB3](./revamp_2026_portal/roadmap/TB3-Project-Discussion-V2.md) |
| Notification reliability | [Notification architecture](./revamp_2026_portal/core/07-Notifications-On-Cloudflare.md) → [TB4](./revamp_2026_portal/roadmap/TB4-Notification-Outbox-And-Queues.md) |
| Project Workspace team assignment | [PRD delta](./revamp_2026_portal/core/03-PRD-Delta.md) → [Current-state audit](./revamp_2026_portal/core/02-Current-State-Audit.md) → [TB4A](./revamp_2026_portal/roadmap/TB4A-Project-Workspace-Assignment-Rail.md) |
| Project Deadline/reminders or Kanban due metadata | [PRD delta](./revamp_2026_portal/core/03-PRD-Delta.md) → [Notification architecture](./revamp_2026_portal/core/07-Notifications-On-Cloudflare.md) → [TB4B](./revamp_2026_portal/roadmap/TB4B-Project-Deadline-And-Reminders.md) |
| Editor-wide project-change alerts | [PRD delta](./revamp_2026_portal/core/03-PRD-Delta.md) → [Notification architecture](./revamp_2026_portal/core/07-Notifications-On-Cloudflare.md) → [TB4C](./revamp_2026_portal/roadmap/TB4C-Editor-Wide-Project-Change-Notifications.md) |
| Checklist start/end scheduling | [Scheduling architecture](./revamp_2026_portal/core/12-Production-Calendar-And-Checklist-Scheduling.md) → [Notification architecture](./revamp_2026_portal/core/07-Notifications-On-Cloudflare.md) → [TB4D](./revamp_2026_portal/roadmap/TB4D-Checklist-Scheduling-Ranges.md) |
| External Editor role/access | [External Editor architecture](./revamp_2026_portal/core/13-External-Editor-Authorization.md) → [Current-state audit](./revamp_2026_portal/core/02-Current-State-Audit.md) → [TB4E](./revamp_2026_portal/roadmap/TB4E-External-Editor-Assigned-Scope-Access.md) |
| Project Stage and Kanban ordering | [Kanban/stage architecture](./revamp_2026_portal/core/08-Kanban-Modernization.md) → [TB5A](./revamp_2026_portal/roadmap/TB5A-Project-Stage-And-Kanban-Ordering-Contract.md) |
| Kanban interaction modernization | Approved TB5A outcome → [TB5B](./revamp_2026_portal/roadmap/TB5B-Kanban-Interaction-Modernization.md) |
| Production Calendar | [Scheduling/Calendar architecture](./revamp_2026_portal/core/12-Production-Calendar-And-Checklist-Scheduling.md) → [External Editor architecture](./revamp_2026_portal/core/13-External-Editor-Authorization.md) → [Calendar research](./revamp_2026_portal/research/Production-Calendar-FullCalendar-Shadcn.md) → [TB5C](./revamp_2026_portal/roadmap/TB5C-Production-Calendar.md) |
| Reviewer or release owner | Current `docs/todo.md` → [Migration/verification](./revamp_2026_portal/core/09-Migration-Rollback-And-Verification.md) → active tracer-bullet file |
| New planning/implementation agent | Current-main/authority checkpoint above → [Next-agent handoff](./revamp_2026_portal/handoff/Next-Agent-Prompt.md) |
| Historical audit only | [`archive/`](./revamp_2026_portal/archive/README.md) |

## Program sequence

```text
TB0 → TB0A → TB0B → TB1 → TB2 → TB3 → TB4
                                     │
                                     └→ TB4A → TB4B → TB4C → TB4D → TB4E → TB5A → TB5B → TB5C → TB6 → TB7 → TB8
```

PR #44 is a baseline change before TB0, not an inserted tracer bullet and not a reason to renumber the sequence.

The inserted bullets do not renumber existing work:

- **TB0A:** React 19.2 runtime upgrade.
- **TB0B:** developer-managed global pipeline-order boundary.
- **TB4D:** checklist scheduling ranges.
- **TB4E:** External Editor assigned-scope access.
- **TB5C:** Production Calendar.

## Current headline decisions

- The current explicit AutoHDR handoff is Admin-only and send-only. Stage movement remains a separate operation; later freshness, notification, authorization, and Kanban work must preserve the boundary above.
- Upgrade production `portal/` to the latest stable pinned React `19.2.x` patch in a standalone release; retain the Vite SPA and do not adopt React Compiler, SSR, Server Components, or new React feature refactors as collateral work.
- Tailwind CSS v4 plus source-owned shadcn components is the target UI direction. Base UI, Sera, Lucide, CSS variables, Quincy semantic tokens, and disabled Preflight form the first proof.
- The Project Workspace **left rail** is canonical for Stage, Deadline/Reminders, Photographers, and Editors. Collaboration remains checklist/subtasks plus project discussion.
- One project Deadline uses `Australia/Sydney`; Kanban shows it and omits only card-level RAW count.
- Checklist items evolve additively from optional due-only values to optional start/end ranges while preserving existing due values as end-only milestones.
- Dashboard gains a third **Calendar** view for Admins and internal Editors plus assigned-scope External Editors. Initial views are Month, Week, and Agenda; project entries are Deadline milestones and checklist entries are due milestones or ranges.
- Calendar supports guarded direct manipulation: project Deadline drag, checklist drag/end-resize, external drag from an Unscheduled panel, accessible non-drag editing, URL-addressable filters, and conflict rollback.
- The Calendar engine is FullCalendar Standard through its official shadcn registry integration; Quincy owns surrounding composition, event rendering, tokens, and visual convergence. No premium Scheduler/resource timeline is planned.
- Add global role `external_editor`, displayed **External editor**, while project membership remains `roleOnProject="editor"`.
- External Editors keep normal assigned-project production capabilities but never receive `viewAllProjects`; they see only explicitly assigned non-archived projects, no Notice Board/global directory/Admin surfaces, and use role-safe server projections.
- External Editors may read assigned project production notes and project-participant email addresses, but not agent/client contact details, billing/order bookkeeping, agency-directory notes, Dropbox topology, provider credentials, provider diagnostics, or Admin job surfaces.
- `boardPosition` remains the sole persisted manual Kanban order; Priority/shoot-date views are non-writing sorts; TB5B uses dnd-kit.
- Notifications use a D1 outbox, Cloudflare Queue, delivery ledger, recovery scan, DLQ, explicit `unknown` email outcomes, role-safe assigned-Editor delivery, and one producer per semantic event.

## AutoHDR compatibility checkpoints by tracer bullet

- **TB0:** merge current AutoHDR authority amendments forward. Do not replace current `Implementation-Plan.md`/`PRD.md` with older package wording. Record PR #44 and every later commit in the baseline/drift register.
- **TB0A/TB1/TB8:** preserve the button’s Admin capability gate, disabled/active state, error handling, job visibility, and source-owned behavior while changing runtime or presentation.
- **TB2:** preserve the `autohdr_api_send` job lifecycle and terminal-aware refresh. Query migration must not duplicate sends, reset RAW selection, re-enable legacy AutoHDR status/fetch behavior for the direct path, or turn an ambiguous provider outcome into a new job without reconciliation.
- **TB4/TB4C:** register the direct-send Workflow as an existing automatic Stage writer and notification producer. Create durable activity/outbox only after finalization and ensure the generic Stage event and workflow summary do not double-deliver the same semantic operation.
- **TB4E:** keep the send route and AutoHDR job/status/history surfaces outside External Editor capabilities and DTOs. External Editors may see only neutral, external-safe production state.
- **TB5A/TB5B:** inventory `workers/background/src/workflows/autohdr-api-send.ts` alongside every other Stage writer. Manual entry/exit of `editing_autohdr` remains Stage-only; confirmation must say it does not send or cancel AutoHDR. Carry the expected Stage/revision from claim to completion so any intervening Stage cycle wins over the automatic advance.
- **TB5C:** Calendar may display authorized Stage/progress metadata only. It does not expose provider identifiers/diagnostics and does not add a Calendar-based AutoHDR send action.

## Authority and lifecycle

This package is still a coordinated proposal. It does not outrank:

```text
docs/Decision-Sheet.md
  → docs/Implementation-Plan.md
  → docs/PRD.md / Personas.md / Sitemap.md
  → supporting plans and architecture
```

Current `Implementation-Plan.md` and `PRD.md` already contain the direct send-only AutoHDR amendment from PR #44. Those changes are current authority baseline and must be preserved. They do **not** mean the proposed revamp authority package has been approved.

The proposed revamp authority package remains **D-16 through D-21** and Implementation Plan amendments **A8 through A14**. D-20/A13 cover checklist scheduling and Production Calendar; D-21/A14 cover External Editor assigned-scope authorization.

After separate owner approval, TB0 must promote the proposal **additively**, capture drift from the detailed-package baseline through current `main`, update stale current-state statements, and create the first repository-native implementation plan. A feature is not “implemented” for repository lifecycle purposes until it is verified and deployed to production under the normal release rules.