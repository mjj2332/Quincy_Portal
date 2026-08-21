# Tracer-Bullet Roadmap

These are scope briefs. Each bullet requires a separate current-main-aware implementation plan and the repository's plan-review pipeline before coding.

## Sequence

| Bullet | Primary outcome | Main architectural proof |
|---|---|---|
| [TB0](./TB0-Integrated-Architecture-And-Baseline.md) | Approved synchronized docs, matched visual baseline and drift register | One coherent program/decision set |
| [TB1](./TB1-Tailwind-Shadcn-Foundation.md) | First design-conformant Quincy shadcn form slice | UI platform and CSS coexistence |
| [TB2](./TB2-Route-Safe-Data-Freshness.md) | Project pages update without reload | Route-keyed server state |
| [TB3](./TB3-Project-Discussion-V2.md) | Automatically refreshed project discussion/read state | Shared discussion direction |
| [TB4](./TB4-Notification-Outbox-And-Queues.md) | Durable mention delivery | D1 outbox + Cloudflare Queue |
| [TB4A](./TB4A-Project-Coordination-Deadline-And-Editor-Notifications.md) | Editors are assigned in context and reliably alerted to project changes/deadlines | Existing membership + versioned deadline schedule + TB4 outbox |
| [TB5A](./TB5A-Kanban-Ordering-Model-Correction.md) | Understandable, authoritative Kanban order | One visible/persisted ordering contract |
| [TB5B](./TB5B-Kanban-Interaction-Modernization.md) | Accessible, refreshed project board | dnd-kit + guarded board moves |
| [TB6](./TB6-Project-Card-Detail-And-Discussion.md) | Project-card quick detail with shared discussion/activity | UI/domain reuse |
| [TB7](./TB7-Notice-Board-Migration.md) | Server-synchronized notice board | Second discussion consumer |
| [TB8](./TB8-Wider-UI-Migration-And-Cleanup.md) | Surface-by-surface design convergence and retirement of duplicates | Consolidation only after proofs |

## Dependency view

```text
TB0
 └─ TB1
     └─ TB2
         └─ TB3
             └─ TB4
                 └─ TB4A
                     └─ TB5A
                         └─ TB5B
                             └─ TB6
                                 └─ TB7
                                     └─ TB8
```

TB3 and TB5A planning may overlap after TB2 stabilizes, but TB4A implementation depends on the accepted TB4 outbox pattern and must land before TB5A/TB5B so later board work preserves the deadline metadata contract. TB5B cannot begin until TB5A's ordering contract is approved and its required correction is live or otherwise established as the implementation baseline. Every implementation remains isolated.

TB8 is an umbrella for multiple feature-surface releases, not permission for a final wholesale rewrite.

## Rules for every bullet

- One primary user outcome.
- One main architectural question.
- Exact scope and non-goals.
- Additive/reversible migration.
- Targeted tests + full repository gate.
- Matched visual evidence when UI changes.
- Manual browser QA.
- Independent diff review.
- Clear stop/accept checkpoint.
- Production coherent if the roadmap stops after this bullet.
