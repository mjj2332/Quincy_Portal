# `revamp_2026_portal` — Documentation Package

**Status:** Revised coordinated planning package; authority promotion completed 2026-08-24
**Baseline:** `main` at `2ac2ca27a1e0ded328b9265613ab4ebeeb7db1b0`  
**Current execution baseline:** `main` at `08f4653482c82e4a117c6347a7d0a456d48002ed`
**Revised:** 2026-08-23

## Purpose

This package coordinates the Quincy Portal runtime, UI, freshness, discussion, notification, project-coordination, checklist scheduling, External Editor authorization, Kanban, and Production Calendar revamp. It is modular so agents load only the files required for the active task.

The package contains proposed implementation details below the repository authority chain. Its
corrected D/A authority wording was promoted on 2026-08-24; planned outcomes remain non-live until
their owning tracer bullets are shipped.

## Package entry points

- [`Brief.md`](./Brief.md) — the high-level owner brief; authoritative over the rest of the package
  on the specific points it names in its own header.
- [`Index.md`](./Index.md) — the shortest entry point for an agent: read only the path relevant to
  the active task, rather than this whole tree.

Both moved into this folder 2026-09-04 so everything related to the revamp lives in one place; see
their own headers for full status.

## Package sections

### `core/`

| File | Purpose |
|---|---|
| [`01-Decision-Register.md`](./core/01-Decision-Register.md) | Settled owner decisions, superseded guidance, and authority mapping |
| [`02-Current-State-Audit.md`](./core/02-Current-State-Audit.md) | Current-`main` facts that constrain implementation |
| [`03-PRD-Delta.md`](./core/03-PRD-Delta.md) | Product requirements proposed for later PRD promotion |
| [`04-Frontend-Architecture.md`](./core/04-Frontend-Architecture.md) | React 19.2, Tailwind/shadcn, token, component, and Calendar UI contracts |
| [`05-Route-And-Data-Freshness.md`](./core/05-Route-And-Data-Freshness.md) | Query identity, polling, invalidation, Calendar URL/range state, and access-loss behavior |
| [`06-Discussions-And-Notice-Board.md`](./core/06-Discussions-And-Notice-Board.md) | Discussion/read-state, structured activity, and role-safe visibility |
| [`07-Notifications-On-Cloudflare.md`](./core/07-Notifications-On-Cloudflare.md) | Outbox, Queue, preferences, registry, reminders, and External Editor delivery |
| [`08-Kanban-Modernization.md`](./core/08-Kanban-Modernization.md) | Stage semantics, pipeline boundary, ordering correction, and dnd-kit modernization |
| [`09-Migration-Rollback-And-Verification.md`](./core/09-Migration-Rollback-And-Verification.md) | Release, rollback, testing, scheduling, role, and Calendar gates |
| [`10-Repository-Document-Update-Map.md`](./core/10-Repository-Document-Update-Map.md) | Promoted revised D-13/D-15, D-16–D-19, and A8–A14 synchronization map |
| [`11-Design-Convergence.md`](./core/11-Design-Convergence.md) | Evidence matrix, drift classification, and per-surface definition of done |
| [`12-Production-Calendar-And-Checklist-Scheduling.md`](./core/12-Production-Calendar-And-Checklist-Scheduling.md) | Checklist schedule model, Calendar product/API/interaction contract |
| [`13-External-Editor-Authorization.md`](./core/13-External-Editor-Authorization.md) | External Editor role, capabilities, project scoping, privacy, lifecycle, and Calendar scope |

### `roadmap/`

One concise scope brief per tracer bullet. A scope brief is not a repository-native implementation plan.

Inserted bullets:

- `TB4D-Checklist-Scheduling-Ranges.md`
- `TB4E-External-Editor-Assigned-Scope-Access.md`
- `TB5C-Production-Calendar.md`

Existing TB numbers remain stable.

### `research/`

Option analysis and official-source links. The Calendar selection is documented in `Production-Calendar-FullCalendar-Shadcn.md`. Research explains the selected direction but does not authorize implementation.

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
- **TB4B:** PRD delta + notification architecture + TB4B.
- **TB4C:** discussion/activity + notification architecture + TB4C.
- **TB4D:** scheduling architecture + notification architecture + migration/verification + TB4D.
- **TB4E:** External Editor architecture + current-state audit + notification/discussion privacy + TB4E.
- **TB5A:** current-state audit + Kanban architecture + historical ordering plans + TB5A.
- **TB5B:** Kanban architecture + accepted TB5A outcome + TB5B.
- **TB5C:** scheduling architecture + External Editor architecture + frontend/freshness contracts + Calendar research + TB5C.
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

This package records the promoted authority package: revised **D-13/D-15**, four new decisions
**D-16–D-19**, and **A8–A14**. Planned outcomes remain targets until their owning tracer bullets
are implemented, verified, committed, deployed, and recorded live.

## Revised roadmap

```text
TB0 → TB0A → TB0B → TB1 → TB2 → TB3 → TB4
                                     │
                                     └→ TB4A → TB4B → TB4C → TB4D → TB4E → TB5A → TB5B → TB5C → TB6 → TB7 → TB8
```

Planning may overlap only when it does not assume an unresolved upstream implementation contract. Implementation follows the sequence.

## Important current-main caveats

- Production is still React 18.3.1; React 19.2 is a target until TB0A is implemented.
- Dashboard currently supports List and Kanban only; there is no Calendar surface or FullCalendar dependency.
- Current `project_subtasks` has one optional literal `due_date` and no start boundary or schedule version.
- Current global roles are only Admin, Photographer, and Editor. `external_editor` is not live.
- Current project access already falls back to membership for roles without `viewAllProjects`, but the project-list route special-cases Photographer and otherwise returns the broader role set; TB4E must generalize that query safely before adding the role.
- Current user-role updates revoke sessions on deactivation only, not on role change.
- Current project detail includes member names/emails; TB4E must make participant-email exposure project-scoped rather than a global directory surface.
- The Project Workspace rail currently renders Stage read-only and Photographers only; Editors/Deadline/Stage mutation remain planned work.
- Collaboration currently owns checklist and project comments; it remains task/discussion-focused.
- Project comments, Notice Board, notifications, and Kanban already exist; the revamp modernizes them rather than building greenfield replacements.
- There is no staging environment. Production mutation remains human-authorized only.

## Plan lifecycle

1. Approve authority promotion separately.
2. Run TB0: promote decisions, establish baseline/drift register, and review foundational implementation plans.
3. Build one bullet, independently verify, deploy, and record actual results.
4. Update `docs/todo.md` only with real status.
5. Move an implementation plan to `docs/plans/implemented/` only after it matches live production.
