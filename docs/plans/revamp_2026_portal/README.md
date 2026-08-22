# `revamp_2026_portal` — Documentation Package

**Status:** Revised coordinated planning package; owner decisions settled, authority promotion pending  
**Baseline:** `main` at `8bcb48245a727b048053bd3653cf07f3ad99b780`  
**Revised:** 2026-08-22

## Purpose

This package coordinates the Quincy Portal runtime, UI, freshness, discussion, notification, project-coordination, and Kanban revamp. It is modular so agents load only the files required for the active task.

The package is a proposal. It does not yet modify or outrank the repository authority chain.

## Package sections

### `core/`

| File | Purpose |
|---|---|
| [`01-Decision-Register.md`](./core/01-Decision-Register.md) | Settled owner decisions, superseded guidance, and authority mapping |
| [`02-Current-State-Audit.md`](./core/02-Current-State-Audit.md) | Current-`main` facts that constrain implementation |
| [`03-PRD-Delta.md`](./core/03-PRD-Delta.md) | Product requirements proposed for later PRD promotion |
| [`04-Frontend-Architecture.md`](./core/04-Frontend-Architecture.md) | React 19.2, Tailwind/shadcn, token, and component contracts |
| [`05-Route-And-Data-Freshness.md`](./core/05-Route-And-Data-Freshness.md) | Query identity, polling, focus refresh, invalidation, and cross-tab behavior |
| [`06-Discussions-And-Notice-Board.md`](./core/06-Discussions-And-Notice-Board.md) | Discussion/read-state and structured activity boundaries |
| [`07-Notifications-On-Cloudflare.md`](./core/07-Notifications-On-Cloudflare.md) | Outbox, Queue, delivery ledger, preferences, registry, and reminders |
| [`08-Kanban-Modernization.md`](./core/08-Kanban-Modernization.md) | Stage semantics, pipeline boundary, ordering correction, and dnd-kit modernization |
| [`09-Migration-Rollback-And-Verification.md`](./core/09-Migration-Rollback-And-Verification.md) | Release, rollback, testing, and operational gates |
| [`10-Repository-Document-Update-Map.md`](./core/10-Repository-Document-Update-Map.md) | Proposed D-16–D-19 and A8–A12 promotion map |
| [`11-Design-Convergence.md`](./core/11-Design-Convergence.md) | Evidence matrix, drift classification, and per-surface definition of done |

### `roadmap/`

One concise scope brief per tracer bullet. A scope brief is not a repository-native implementation plan. New bullets are:

- `TB0A-React-19-2-Runtime-Upgrade.md`
- `TB0B-Pipeline-Configuration-Boundary.md`

Renamed/reframed bullets are:

- `TB4A-Project-Workspace-Assignment-Rail.md`
- `TB5A-Project-Stage-And-Kanban-Ordering-Contract.md`

### `research/`

Option analysis and official-source links. Research explains the selected direction but does not authorize implementation.

### `handoff/`

The smallest safe entry prompt for the next agent.

### `archive/`

Superseded material retained only for provenance.

## Read only what the task requires

- **Owner approval:** decision register + PRD delta.
- **TB0/authority planning:** current-state audit + roadmap index + document update map.
- **TB0A:** frontend architecture + migration/verification + TB0A.
- **TB0B:** Kanban/stage architecture + TB0B.
- **TB1/TB8:** design convergence + frontend architecture + UI research + active bullet.
- **TB2:** current-state audit + route/data freshness + TB2.
- **TB3:** discussion architecture + TB3.
- **TB4:** notification architecture + TB4.
- **TB4A:** current-state audit + PRD delta + TB4A.
- **TB4B:** current-state audit + PRD delta + notification architecture + TB4B; read Kanban architecture for card metadata.
- **TB4C:** PRD delta + discussion/activity architecture + notification architecture + TB4C.
- **TB5A:** current-state audit + Kanban architecture + relevant historical implemented ordering plans + TB5A.
- **TB5B:** Kanban architecture + approved TB5A outcome + TB5B.
- **Reviewer:** active bullet + migration/verification + changed files.

## Status vocabulary

- **Approved direction:** owner explicitly selected it in planning.
- **Proposed authority:** wording prepared for Decision Sheet/Implementation Plan/PRD but not promoted.
- **Planned:** approved repository-native implementation plan, not built.
- **Implemented:** committed, not necessarily deployed.
- **Live:** deployed and production-verified.
- **Superseded:** retained only for history.

## Repository authority

```text
docs/Decision-Sheet.md
  → docs/Implementation-Plan.md
  → docs/PRD.md / Personas.md / Sitemap.md
  → supporting architecture and per-slice plans
```

This package proposes D-16–D-19 and A8–A12. Those authority files remain unchanged until a separate owner approval.

## Revised roadmap

```text
TB0 → TB0A → TB0B → TB1 → TB2 → TB3 → TB4
                                     │
                                     └→ TB4A → TB4B → TB4C → TB5A → TB5B → TB6 → TB7 → TB8
```

Planning may overlap only when it does not assume an unresolved upstream implementation contract. Implementation follows the sequence.

## Important current-main caveats

- Production is React 18.3.1 today; React 19.2 is approved only as a target until TB0A is implemented.
- The Project Workspace rail currently renders Stage read-only and Photographers only, although Editors already exist in the same project response and membership model.
- Edit Project currently sends full Photographer/Editor lists; left-rail changes must use role-specific deltas.
- Collaboration currently owns checklist and project comments; it must not gain project-level roster, Stage, or Deadline controls.
- Admin Pipeline currently permits label, active state, and Up/Down order changes. TB0B deliberately removes ordinary self-service global ordering while retaining label and active-state controls.
- Project Stage moves currently use `selectForEditing`; the revamp replaces that boundary with `moveProjectStage` for Admins and Editors.
- Project comments, notice-board posts, notifications, and a Kanban board already exist. The revamp modernizes them rather than building greenfield replacements.
- There is no staging environment. Production mutation remains human-authorized only.

## Plan lifecycle

1. Approve authority promotion separately.
2. Run TB0: promote decisions, establish baseline/drift register, and review the TB0A implementation plan.
3. Build one bullet, independently verify, deploy, and record actual results.
4. Update `docs/todo.md` only with real status.
5. Move an implementation plan to `docs/plans/implemented/` only after it matches live production.
