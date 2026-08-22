# Tracer-Bullet Roadmap

These are scope briefs. Every bullet requires a current-main-aware repository-native implementation plan and the repository review pipeline before coding.

## Sequence

| Bullet | Primary outcome | Main architectural proof |
|---|---|---|
| [TB0](./TB0-Integrated-Architecture-And-Baseline.md) | Approved authority package, matched baseline and drift register | One coherent program/decision set |
| [TB0A](./TB0A-React-19-2-Runtime-Upgrade.md) | Production runs React 19.2 with no intended product/visual change | Runtime/type compatibility and rollback |
| [TB0B](./TB0B-Pipeline-Configuration-Boundary.md) | Global Stage order is developer-managed | UI/API policy boundary without data rewrite |
| [TB1](./TB1-Tailwind-Shadcn-Foundation.md) | First design-conformant Quincy shadcn form slice | UI platform and legacy coexistence |
| [TB2](./TB2-Route-Safe-Data-Freshness.md) | Project data updates without reload | Route/resource-keyed server state |
| [TB3](./TB3-Project-Discussion-V2.md) | Refreshed project discussion and cross-device read state | Adapter-first discussion service |
| [TB4](./TB4-Notification-Outbox-And-Queues.md) | Reliable mention delivery and minimal recovery operations | D1 outbox + Queue + delivery ledger |
| [TB4A](./TB4A-Project-Workspace-Assignment-Rail.md) | Photographers/Editors managed safely from canonical rail | Role-specific membership deltas/cycles |
| [TB4B](./TB4B-Project-Deadline-And-Reminders.md) | One Deadline/reminder schedule and Kanban due metadata | Versioned Sydney schedule + delivery |
| [TB4C](./TB4C-Editor-Wide-Project-Change-Notifications.md) | Approved changes reach every eligible assigned Editor | Activity registry + exact fan-out/coalescing |
| [TB5A](./TB5A-Project-Stage-And-Kanban-Ordering-Contract.md) | One Stage command and understandable authoritative Board order | Semantic transitions + normalized manual order |
| [TB5B](./TB5B-Kanban-Interaction-Modernization.md) | Accessible refreshed project board | dnd-kit against accepted Stage/order command |
| [TB6](./TB6-Project-Card-Detail-And-Discussion.md) | URL-addressable project quick detail | Reused Overview/Activity/Discussion |
| [TB7](./TB7-Notice-Board-Migration.md) | Server-synchronized notice-board read state | Second read/delivery consumer |
| [TB8](./TB8-Wider-UI-Migration-And-Cleanup.md) | Evidence-driven surface convergence and cleanup | Consolidation after proofs |

## Dependency view

```text
TB0 → TB0A → TB0B → TB1 → TB2 → TB3 → TB4
                                     │
                                     └→ TB4A → TB4B → TB4C → TB5A → TB5B → TB6 → TB7 → TB8
```

Planning may overlap only when it does not assume an unresolved upstream implementation contract. Implementation follows the sequence.

## Why TB0A and TB0B are separate

- React runtime/type compatibility must be diagnosed independently from generated UI code.
- Pipeline administration policy has a distinct authorization/rollback boundary from UI-platform adoption.
- Existing TB1–TB8 numbers remain stable.

## Shared Project Workspace rail ownership

- TB4A establishes the operational-first rail shell and activates Photographer/Editor controls.
- TB4B activates the combined Deadline/Reminders block.
- TB5A activates the Stage picker.
- Stage may be visible/read-only in its target position before TB5A.
- Collaboration never regains ownership of project-level coordination controls.

## Rules for every bullet

- One primary user outcome.
- One main architectural proof.
- Exact scope/non-goals and current-main facts.
- Additive/reversible migration or explicit no-schema statement.
- Targeted tests plus full gate.
- Matched visual evidence when rendered UI changes.
- Manual browser QA.
- Independent diff review.
- Clear accept/rollback checkpoint.
- Production remains coherent if later work stops.
- No proposed item is described as live before deployment.
- Split a bullet before implementation if it hides unrelated acceptance checkpoints.
