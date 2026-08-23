# Quincy Portal Revamp — Index

**Status:** Revised planning and research package; owner decisions are settled in this package but have not yet been promoted into repository authority documents.  
**Revised:** 2026-08-23  
**Repository baseline inspected:** `mjj2332/Quincy_Portal` `main` at `2ac2ca27a1e0ded328b9265613ab4ebeeb7db1b0`  
**Detailed folder:** [`revamp_2026_portal/`](./revamp_2026_portal/README.md)

This is the shortest entry point for the coordinated Quincy Portal revamp. Read only the path relevant to the active task.

## Start here

1. Read the [high-level brief](./Quincy-Portal-Revamp-Brief.md).
2. Read the [decision register](./revamp_2026_portal/core/01-Decision-Register.md).
3. Choose the narrow reading path below.
4. Before implementation, re-read current `main`, `AGENTS.md`, `docs/todo.md`, `docs/lessons.md`, and `docs/Subagent-Orchestration.md`.

## Reading paths

| Reader/task | Read these files |
|---|---|
| Owner reviewing scope and direction | [Brief](./Quincy-Portal-Revamp-Brief.md) → [Decision register](./revamp_2026_portal/core/01-Decision-Register.md) → [PRD delta](./revamp_2026_portal/core/03-PRD-Delta.md) |
| Agent drafting the umbrella/authority update | [Package README](./revamp_2026_portal/README.md) → [Current-state audit](./revamp_2026_portal/core/02-Current-State-Audit.md) → [Roadmap](./revamp_2026_portal/roadmap/README.md) → [Document update map](./revamp_2026_portal/core/10-Repository-Document-Update-Map.md) |
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
| Reviewer or release owner | [Migration/verification](./revamp_2026_portal/core/09-Migration-Rollback-And-Verification.md) → active tracer-bullet file |
| New planning/implementation agent | [Next-agent handoff](./revamp_2026_portal/handoff/Next-Agent-Prompt.md) |
| Historical audit only | [`archive/`](./revamp_2026_portal/archive/README.md) |

## Program sequence

```text
TB0 → TB0A → TB0B → TB1 → TB2 → TB3 → TB4
                                     │
                                     └→ TB4A → TB4B → TB4C → TB4D → TB4E → TB5A → TB5B → TB5C → TB6 → TB7 → TB8
```

The inserted bullets do not renumber existing work:

- **TB0A:** React 19.2 runtime upgrade.
- **TB0B:** developer-managed global pipeline-order boundary.
- **TB4D:** checklist scheduling ranges.
- **TB4E:** External Editor assigned-scope access.
- **TB5C:** Production Calendar.

## Current headline decisions

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
- External Editors may read assigned project production notes and project-participant email addresses, but not agent/client contact details, billing/order bookkeeping, agency-directory notes, Dropbox topology, or provider/Admin diagnostics.
- `boardPosition` remains the sole persisted manual Kanban order; Priority/shoot-date views are non-writing sorts; TB5B uses dnd-kit.
- Notifications use a D1 outbox, Cloudflare Queue, delivery ledger, recovery scan, DLQ, explicit `unknown` email outcomes, and role-safe assigned-Editor delivery.

## Authority and lifecycle

This package is still a coordinated proposal. It does not outrank:

```text
docs/Decision-Sheet.md
  → docs/Implementation-Plan.md
  → docs/PRD.md / Personas.md / Sitemap.md
  → supporting plans and architecture
```

The proposed authority package is now **D-16 through D-21** and Implementation Plan amendments **A8 through A14**. D-20/A13 cover checklist scheduling and Production Calendar; D-21/A14 cover External Editor assigned-scope authorization. Those authority files are intentionally unchanged in this revision. After a separate owner approval, TB0 promotes the proposal, captures the baseline/drift register, and creates the first repository-native implementation plan.
