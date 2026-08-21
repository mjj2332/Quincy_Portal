# `revamp_2026_portal` — Documentation Package

**Status:** Coordinated research and planning package  
**Baseline:** `main` at `dfddccbaaaaeff4b0ce3146c58af338d070d345e`  
**Scope:** UI platform, automatic freshness, asynchronous discussions, notifications, time-critical project coordination, and the existing project Kanban board

## Purpose

This folder is intentionally modular. Agents should load the smallest set of documents required for the active task instead of reading one monolithic handoff.

The 2026-08-21 plan review split the former combined TB4A into three independently reviewable releases: editor assignment (TB4A), project deadline/reminders and card metadata (TB4B), and editor-wide project-change alerts (TB4C).

## Package sections

### `core/`

Stable decisions, current-state evidence, product requirements and technical architecture.

| File | Purpose |
|---|---|
| [`01-Decision-Register.md`](./core/01-Decision-Register.md) | Approved decisions, pending choices and superseded guidance |
| [`02-Current-State-Audit.md`](./core/02-Current-State-Audit.md) | What current `main` actually does |
| [`03-PRD-Delta.md`](./core/03-PRD-Delta.md) | Product requirements to merge into the PRD |
| [`04-Frontend-Architecture.md`](./core/04-Frontend-Architecture.md) | Tailwind/shadcn and component boundaries |
| [`05-Route-And-Data-Freshness.md`](./core/05-Route-And-Data-Freshness.md) | Deep links, query keys, polling, focus refresh and multi-tab behavior |
| [`06-Discussions-And-Notice-Board.md`](./core/06-Discussions-And-Notice-Board.md) | Quincy-owned asynchronous discussion model |
| [`07-Notifications-On-Cloudflare.md`](./core/07-Notifications-On-Cloudflare.md) | D1 outbox, Queues, email and preferences |
| [`08-Kanban-Modernization.md`](./core/08-Kanban-Modernization.md) | Existing board modernization and shared project discussion |
| [`09-Migration-Rollback-And-Verification.md`](./core/09-Migration-Rollback-And-Verification.md) | Additive rollout, testing, release and rollback rules |
| [`10-Repository-Document-Update-Map.md`](./core/10-Repository-Document-Update-Map.md) | How to update Decision Sheet, Plan, PRD, AGENTS, README and todo |
| [`11-Design-Convergence.md`](./core/11-Design-Convergence.md) | Visual authority, drift classification, evidence and per-surface definition of done |

### `research/`

Option analysis and official source links. These explain why the target was chosen; they are not implementation plans.

### `roadmap/`

One concise file per tracer bullet. A bullet file is a scope brief, not a substitute for the repository's required reviewed implementation plan.

### `handoff/`

Entry prompt for the next planning/implementation agent.

### `archive/`

Superseded material preserved only for provenance. Do not use it as active direction.

## Read only what the task requires

- **Owner approval:** decision register + PRD delta.
- **Master-plan author:** current-state audit + all core architecture files + roadmap index.
- **Design-convergence/TB1/TB8 UI agent:** design-convergence contract + frontend architecture + UI research + active bullet.
- **TB2 freshness agent:** current-state audit + route/freshness architecture + TB2.
- **TB3 discussion agent:** discussion architecture + messaging research + TB3.
- **TB4 notification agent:** notification architecture + Cloudflare research + TB4.
- **TB4A editor-assignment agent:** current-state audit + PRD delta + collaboration-pane source + TB4A.
- **TB4B deadline/reminder agent:** current-state audit + PRD delta + notification architecture + Cloudflare research + TB4B; read Kanban architecture for the card metadata change.
- **TB4C editor-alert agent:** current-state audit + PRD delta + notification architecture + Cloudflare research + TB4C.
- **TB5A ordering agent:** current-state audit + Kanban architecture + the two historical implemented ordering plans + TB5A.
- **TB5B board agent:** Kanban architecture + Kanban research + approved TB5A outcome + TB5B.
- **Reviewer:** active bullet + migration/verification + files changed by the bullet.

## Status vocabulary

Use these labels consistently:

- **Approved direction:** user has explicitly selected it.
- **Proposed:** recommended by research; not yet approved as a repository decision.
- **Planned:** approved in a reviewed plan but not built.
- **Implemented:** code is committed but may not be deployed.
- **Live:** deployed and verified in production.
- **Superseded:** historical; must not guide current implementation.

## Repository authority

This package does not replace the existing authority chain. Once approved, its decisions must be merged into:

```text
docs/Decision-Sheet.md
  → docs/Implementation-Plan.md
  → docs/PRD.md
  → supporting documents and per-slice plans
```

`docs/todo.md` remains the current-state tracker. `AGENTS.md` and `CLAUDE.md` must remain exact mirrors.

## Plan lifecycle

1. Approve decisions.
2. Update authority documents.
3. Create/review one implementation plan for the next tracer bullet.
4. Build and independently verify.
5. Deploy using the repository's Cloudflare order.
6. Update the plan status and `docs/todo.md` with actual results.
7. Move a completed plan to `docs/plans/implemented/` only when it matches live production.

## Important baseline caveats

- Current production already has a Kanban board; it is not greenfield, but its ordering semantics are not automatically preserved by the revamp.
- The design tokens are largely intact; design drift must be assessed at the component, layout, interaction and responsive-behavior layers.
- Current production already has project comments, a notice board, rich-text mentions and an in-app/email notification pipeline.
- Current production already supports multiple editor memberships, but editor assignment is exposed in Edit Project rather than the collaboration pane.
- Current production has checklist due values and a one-shot due reminder, but no distinct project-level deadline or configurable multi-reminder schedule.
- Current Kanban cards show a RAW count and do not show a project deadline.
- The path router is not inherently broken; the missing cross-screen freshness policy is the core issue.
- There is no staging environment.
- Production mutation remains human-authorized only.
