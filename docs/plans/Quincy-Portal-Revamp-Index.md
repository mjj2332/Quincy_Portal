# Quincy Portal Revamp — Index

**Status:** Planning and research package; not yet promoted into the repository authority documents.  
**Prepared:** 2026-08-21  
**Repository baseline inspected:** `mjj2332/Quincy_Portal` `main` at `dfddccbaaaaeff4b0ce3146c58af338d070d345e`  
**Detailed folder:** [`revamp_2026_portal/`](./revamp_2026_portal/README.md)

This is the shortest entry point for the coordinated Quincy Portal revamp. The package intentionally separates high-level decisions from detailed architecture and per-slice plans, so an agent does not need to load one very large Markdown file.

## Start here

1. Read the [high-level brief](./Quincy-Portal-Revamp-Brief.md).
2. Read the [decision register](./revamp_2026_portal/core/01-Decision-Register.md).
3. Choose the reading path below that matches the task.
4. Before implementation, re-read current `main`, `AGENTS.md`, `docs/todo.md`, `docs/lessons.md`, and `docs/Subagent-Orchestration.md`.

## Reading paths

| Reader/task | Read these files |
|---|---|
| Owner reviewing scope and direction | [Brief](./Quincy-Portal-Revamp-Brief.md) → [Decision register](./revamp_2026_portal/core/01-Decision-Register.md) → [PRD delta](./revamp_2026_portal/core/03-PRD-Delta.md) |
| Agent drafting the master plan | [Folder README](./revamp_2026_portal/README.md) → [Current-state audit](./revamp_2026_portal/core/02-Current-State-Audit.md) → [Roadmap index](./revamp_2026_portal/roadmap/README.md) → relevant architecture files |
| Design-system/prototype convergence or UI/Tailwind/shadcn work | [Design convergence](./revamp_2026_portal/core/11-Design-Convergence.md) → [Frontend architecture](./revamp_2026_portal/core/04-Frontend-Architecture.md) → [UI research](./revamp_2026_portal/research/UI-Stack-Tailwind-Shadcn.md) → [TB0](./revamp_2026_portal/roadmap/TB0-Integrated-Architecture-And-Baseline.md), [TB1](./revamp_2026_portal/roadmap/TB1-Tailwind-Shadcn-Foundation.md) or [TB8](./revamp_2026_portal/roadmap/TB8-Wider-UI-Migration-And-Cleanup.md) |
| Automatic refresh, routing, multi-tab behavior | [Route and data freshness](./revamp_2026_portal/core/05-Route-And-Data-Freshness.md) → [TB2](./revamp_2026_portal/roadmap/TB2-Route-Safe-Data-Freshness.md) |
| Project comments or notice board | [Discussion architecture](./revamp_2026_portal/core/06-Discussions-And-Notice-Board.md) → [Messaging research](./revamp_2026_portal/research/Messaging-And-Commenting-Research.md) → [TB3](./revamp_2026_portal/roadmap/TB3-Project-Discussion-V2.md) or [TB7](./revamp_2026_portal/roadmap/TB7-Notice-Board-Migration.md) |
| Notifications/email reliability | [Cloudflare notifications](./revamp_2026_portal/core/07-Notifications-On-Cloudflare.md) → [Cloudflare research](./revamp_2026_portal/research/Cloudflare-Native-Architecture-Research.md) → [TB4](./revamp_2026_portal/roadmap/TB4-Notification-Outbox-And-Queues.md) |
| Direct editor assignment in the collaboration pane | [PRD delta](./revamp_2026_portal/core/03-PRD-Delta.md) → [TB4A](./revamp_2026_portal/roadmap/TB4A-Collaboration-Pane-Editor-Assignment.md) |
| Project deadline, advance reminders or Kanban due metadata | [PRD delta](./revamp_2026_portal/core/03-PRD-Delta.md) → [Cloudflare notifications](./revamp_2026_portal/core/07-Notifications-On-Cloudflare.md) → [TB4B](./revamp_2026_portal/roadmap/TB4B-Project-Deadline-And-Reminders.md) |
| Editor-wide project-change alerts | [PRD delta](./revamp_2026_portal/core/03-PRD-Delta.md) → [Cloudflare notifications](./revamp_2026_portal/core/07-Notifications-On-Cloudflare.md) → [TB4C](./revamp_2026_portal/roadmap/TB4C-Editor-Wide-Project-Change-Notifications.md) |
| Kanban ordering or interaction modernization | [Kanban architecture](./revamp_2026_portal/core/08-Kanban-Modernization.md) → [Kanban/Trello research](./revamp_2026_portal/research/Kanban-And-Trello-Research.md) → [TB5A ordering correction](./revamp_2026_portal/roadmap/TB5A-Kanban-Ordering-Model-Correction.md) → [TB5B interaction modernization](./revamp_2026_portal/roadmap/TB5B-Kanban-Interaction-Modernization.md) |
| Reviewer or release owner | [Migration, rollback and verification](./revamp_2026_portal/core/09-Migration-Rollback-And-Verification.md) → the active tracer-bullet file |
| Agent updating repository docs | [Repository document update map](./revamp_2026_portal/core/10-Repository-Document-Update-Map.md) |
| New implementation agent | [Next-agent handoff](./revamp_2026_portal/handoff/Next-Agent-Prompt.md) |
| Historical audit only | [`archive/`](./revamp_2026_portal/archive/README.md) |

## Folder map

```text
docs/plans/
  Quincy-Portal-Revamp-Index.md       # this file
  Quincy-Portal-Revamp-Brief.md       # owner/high-level brief
  revamp_2026_portal/
    README.md                          # package rules and reading guide
    core/                              # decisions, requirements, architecture
    research/                          # evaluated options and source links
    roadmap/                           # one document per tracer bullet
    handoff/                           # next-agent entry prompt
    archive/                           # explicitly superseded handoff material
```

## Authority and lifecycle

These files are a coordinated proposal package. They do not outrank the repository's approved authority order:

```text
docs/Decision-Sheet.md
  → docs/Implementation-Plan.md
  → docs/PRD.md / Personas.md / Sitemap.md
  → supporting architecture and plan documents
```

After owner approval, the relevant decisions and requirements must be incorporated into those authority documents. Each implementation tracer bullet should receive its own reviewed implementation plan before code changes begin.

## Current program gate

| Control | Current state |
|---|---|
| Repository authority | D-16, D-17 and D-18 are proposed; owner approval and authority-document promotion remain TB0 work. |
| First implementation slice | TB1 may begin only after TB0 accepts the platform decisions, baseline evidence and drift register. |
| Project-coordination sequence | TB4A editor assignment → TB4B deadline/reminders + Kanban due metadata → TB4C editor-wide event registry. Each receives its own reviewed implementation plan and release checkpoint. |
| Deferred product choices | TB0 records the owning tracer bullet and deferral explicitly; it does not need to decide later-slice product details prematurely. |

## Current headline decisions

Approved by the user in this planning conversation:

- Tailwind CSS v4 and shadcn are the target UI direction.
- The outcome is design convergence: the Quincy design system is the visual authority, the prototype is the visual/flow reference, and intentional production deviations must be recorded.
- Existing Kanban ordering behavior is not grandfathered into the revamp; ordering semantics must be corrected and approved before interaction modernization.
- The revamp is one coordinated program implemented through tracer bullets.
- Quincy will not depend on a separate managed messaging, notification-orchestration, social-feed, Trello, or Kanban vendor.
- Cloudflare Workers, D1, R2, Queues, Workflows, Cron Triggers, and related Cloudflare services are acceptable infrastructure dependencies.
- Quincy remains asynchronous; Slack or Google Chat handles real-time chat.
- Path-based, deep-linkable URLs must remain.
- Pages must regain automatic freshness without requiring a browser reload.
- Multiple editors can be assigned or removed directly in the project collaboration pane without opening Edit Project.
- Every active assigned editor, including the actor, receives a mandatory durable in-app notification for the approved registry of project changes, including checklist, comment and collection changes; email is an additional channel under the approved delivery policy.
- A project can have one due date/time plus one or more configurable advance reminder offsets, managed in the collaboration pane.
- Kanban cards show the project due date/time and no longer show the RAW count; other RAW-count surfaces are unchanged unless separately approved.

Open implementation choices are tracked in the [decision register](./revamp_2026_portal/core/01-Decision-Register.md).
