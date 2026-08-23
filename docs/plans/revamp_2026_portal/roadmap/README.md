# Tracer-Bullet Roadmap

These are scope briefs. Every bullet requires a current-main-aware repository-native implementation plan and the repository review pipeline before coding.

## Sequence

| Bullet | Primary outcome | Main architectural proof |
|---|---|---|
| [TB0](./TB0-Integrated-Architecture-And-Baseline.md) | Approved authority package, matched baseline and drift register | One coherent D-16–D-21/A8–A14 program |
| [TB0A](./TB0A-React-19-2-Runtime-Upgrade.md) | Production runs React 19.2 with no intended product/visual change | Runtime/type compatibility and rollback |
| [TB0B](./TB0B-Pipeline-Configuration-Boundary.md) | Global Stage order is developer-managed | UI/API policy boundary without data rewrite |
| [TB1](./TB1-Tailwind-Shadcn-Foundation.md) | First design-conformant Quincy shadcn form slice | UI platform and legacy coexistence |
| [TB2](./TB2-Route-Safe-Data-Freshness.md) | Project data updates without reload | Route/resource-keyed server state |
| [TB3](./TB3-Project-Discussion-V2.md) | Refreshed project discussion and cross-device read state | Adapter-first discussion service |
| [TB4](./TB4-Notification-Outbox-And-Queues.md) | Reliable mention delivery and minimal recovery operations | D1 outbox + Queue + delivery ledger |
| [TB4A](./TB4A-Project-Workspace-Assignment-Rail.md) | Photographers/Editors managed safely from canonical rail | Role-specific membership deltas/cycles |
| [TB4B](./TB4B-Project-Deadline-And-Reminders.md) | One Deadline/reminder schedule and Kanban due metadata | Versioned Sydney schedule + delivery |
| [TB4C](./TB4C-Editor-Wide-Project-Change-Notifications.md) | Approved changes reach every eligible assigned Editor | Activity registry + exact fan-out/coalescing |
| [TB4D](./TB4D-Checklist-Scheduling-Ranges.md) | Checklist work can be scheduled as due milestones or ranges | Additive Sydney schedule/version contract |
| [TB4E](./TB4E-External-Editor-Assigned-Scope-Access.md) | External Editors work only on assigned projects with safe data | Capability + membership-scoped authorization/projection |
| [TB5A](./TB5A-Project-Stage-And-Kanban-Ordering-Contract.md) | One Stage command and authoritative Board order | Semantic transitions + normalized manual order |
| [TB5B](./TB5B-Kanban-Interaction-Modernization.md) | Accessible refreshed project board | dnd-kit against accepted Stage/order command |
| [TB5C](./TB5C-Production-Calendar.md) | Staff can visualize/filter/reschedule production work by date | Authorized range projection + FullCalendar/shadcn interaction |
| [TB6](./TB6-Project-Card-Detail-And-Discussion.md) | URL-addressable project quick detail | Reused Overview/Activity/Discussion |
| [TB7](./TB7-Notice-Board-Migration.md) | Server-synchronized Notice Board read state | Second read/delivery consumer |
| [TB8](./TB8-Wider-UI-Migration-And-Cleanup.md) | Evidence-driven surface convergence and cleanup | Consolidation after proofs |

## Dependency view

```text
TB0 → TB0A → TB0B → TB1 → TB2 → TB3 → TB4
                                     │
                                     └→ TB4A → TB4B → TB4C → TB4D → TB4E → TB5A → TB5B → TB5C → TB6 → TB7 → TB8
```

Planning may overlap only when it does not assume unresolved upstream implementation contracts. Implementation follows the sequence.

## Why the inserted bullets are separate

- TB4D changes the checklist domain/schema/reminder contract and is independently useful without Calendar.
- TB4E is a reusable authorization/privacy proof that must exist before Calendar exposes a third audience.
- TB5C is the cross-project visualization/direct-interaction consumer and does not own source project/checklist authorization semantics.
- Existing TB numbers remain stable.

## Shared ownership

- TB4A establishes the operational-first Project Workspace rail and team controls.
- TB4B activates project Deadline/reminders.
- TB4D extends task-level checklist scheduling in Collaboration.
- TB4E extends the Editor slot/account role without moving task/project controls between surfaces.
- TB5A activates Stage and authoritative board ordering.
- TB5B modernizes Kanban interaction.
- TB5C adds Calendar as a third Dashboard projection over TB4B/TB4D with TB4E authorization.

## Rules for every bullet

- One primary user outcome and architectural proof.
- Exact scope/non-goals/current-main facts.
- Additive/reversible migration or explicit no-schema statement.
- Targeted tests + full gate + manual browser QA + independent diff review.
- Matched visual evidence for rendered UI.
- Clear accept/rollback checkpoint.
- Production remains coherent if later work stops.
- No proposed item described as live before deployment.
- Split a bullet before implementation if it hides unrelated acceptance checkpoints.
