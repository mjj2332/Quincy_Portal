# Quincy Portal Revamp — Index

**Status:** Revised planning and research package; owner decisions are settled in this package but have not yet been promoted into repository authority documents.  
**Revised:** 2026-08-22  
**Repository baseline inspected:** `mjj2332/Quincy_Portal` `main` at `8bcb48245a727b048053bd3653cf07f3ad99b780`  
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
| Project deadline/reminders or Kanban due metadata | [PRD delta](./revamp_2026_portal/core/03-PRD-Delta.md) → [Notification architecture](./revamp_2026_portal/core/07-Notifications-On-Cloudflare.md) → [TB4B](./revamp_2026_portal/roadmap/TB4B-Project-Deadline-And-Reminders.md) |
| Editor-wide project-change alerts | [PRD delta](./revamp_2026_portal/core/03-PRD-Delta.md) → [Notification architecture](./revamp_2026_portal/core/07-Notifications-On-Cloudflare.md) → [TB4C](./revamp_2026_portal/roadmap/TB4C-Editor-Wide-Project-Change-Notifications.md) |
| Project Stage and Kanban ordering | [Kanban/stage architecture](./revamp_2026_portal/core/08-Kanban-Modernization.md) → [TB5A](./revamp_2026_portal/roadmap/TB5A-Project-Stage-And-Kanban-Ordering-Contract.md) |
| Kanban interaction modernization | Approved TB5A outcome → [TB5B](./revamp_2026_portal/roadmap/TB5B-Kanban-Interaction-Modernization.md) |
| Reviewer or release owner | [Migration/verification](./revamp_2026_portal/core/09-Migration-Rollback-And-Verification.md) → active tracer-bullet file |
| New planning/implementation agent | [Next-agent handoff](./revamp_2026_portal/handoff/Next-Agent-Prompt.md) |
| Historical audit only | [`archive/`](./revamp_2026_portal/archive/README.md) |

## Program sequence

```text
TB0 → TB0A → TB0B → TB1 → TB2 → TB3 → TB4
                                     │
                                     └→ TB4A → TB4B → TB4C → TB5A → TB5B → TB6 → TB7 → TB8
```

The new foundation bullets do not renumber the existing roadmap:

- **TB0A:** React 19.2 runtime upgrade.
- **TB0B:** enforce the developer-managed global pipeline-order boundary.

## Current headline decisions

- Upgrade production `portal/` to the latest stable pinned React `19.2.x` patch in a standalone release; retain the Vite SPA and do not adopt React Compiler, SSR, Server Components, or new React feature refactors as collateral work.
- Tailwind CSS v4 plus source-owned shadcn components is the target UI direction. Base UI, Sera, Lucide, CSS variables, Quincy semantic tokens, and disabled Preflight form the first proof.
- The Project Workspace **left rail** is the canonical project-level coordination surface for Stage, Deadline/Reminders, Photographers, and Editors. The Collaboration panel remains checklist/subtasks plus project discussion.
- `editProject` governs roster and deadline mutations. A new `moveProjectStage` capability governs Stage changes and is initially granted to Admins and Editors.
- Global pipeline label and active/inactive management remains in Admin. Global stage ordering becomes developer-managed; ordinary Admin Up/Down controls and their self-service endpoint are removed in TB0B.
- Quincy keeps fixed semantic system-stage identities. Manual entry to and exit from `editing_autohdr` is allowed but is stage-only and never starts or cancels AutoHDR work.
- One project deadline uses `Australia/Sydney`, supports zero to eight unique lead-time rules from 1 minute to 30 days, emits a Due-now event, and targets delivery within two minutes of scheduled time.
- Kanban cards show the project deadline and omit only the card-level RAW count.
- `boardPosition` becomes the sole persisted manual order. Priority is metadata plus an optional view-only sort. Existing positions are normalized once to preserve the current visible board order.
- Project discussion remains a flat stream in TB3, using an adapter over the current tables plus server-owned read state.
- Notifications use a D1 outbox, Cloudflare Queue, delivery ledger, recovery scan, DLQ, and explicit `unknown` email outcomes.
- Quincy remains asynchronous, deep-linkable, Cloudflare-native, and vendor-independent for collaboration/Kanban domain data.

## Authority and lifecycle

This package is still a coordinated proposal. It does not outrank:

```text
docs/Decision-Sheet.md
  → docs/Implementation-Plan.md
  → docs/PRD.md / Personas.md / Sitemap.md
  → supporting plans and architecture
```

The proposed authority package is D-16 through D-19 and Implementation Plan amendments A8 through A12. Those files are intentionally unchanged in this revision. After a separate owner approval, TB0 promotes the proposal, captures the baseline/drift register, and creates the first repository-native implementation plan.
