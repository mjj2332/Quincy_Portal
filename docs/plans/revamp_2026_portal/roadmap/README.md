# Tracer-Bullet Roadmap

These are scope briefs. Each bullet requires a separate current-main-aware implementation plan and the repository's plan-review pipeline before coding.

## Sequence

| Bullet | Primary outcome | Main architectural proof |
|---|---|---|
| [TB0](./TB0-Integrated-Architecture-And-Baseline.md) | Approved synchronized docs and clean baseline | One coherent program/decision set |
| [TB1](./TB1-Tailwind-Shadcn-Foundation.md) | First Quincy-branded shadcn form slice | UI platform and CSS coexistence |
| [TB2](./TB2-Route-Safe-Data-Freshness.md) | Project pages update without reload | Route-keyed server state |
| [TB3](./TB3-Project-Discussion-V2.md) | Automatically refreshed project discussion/read state | Shared discussion direction |
| [TB4](./TB4-Notification-Outbox-And-Queues.md) | Durable mention delivery | D1 outbox + Cloudflare Queue |
| [TB5](./TB5-Kanban-Modernization.md) | Accessible, refreshed project board | dnd-kit + guarded board moves |
| [TB6](./TB6-Project-Card-Detail-And-Discussion.md) | Project-card quick detail with shared discussion/activity | UI/domain reuse |
| [TB7](./TB7-Notice-Board-Migration.md) | Server-synchronized notice board | Second discussion consumer |
| [TB8](./TB8-Wider-UI-Migration-And-Cleanup.md) | Expand proven patterns and retire duplicates | Consolidation only after proofs |

## Dependency view

```text
TB0
 └─ TB1
     └─ TB2
         ├─ TB3 ── TB4
         └─ TB5 ── TB6
                    └─ TB7
                        └─ TB8
```

TB3 and TB5 planning may overlap after TB2 stabilizes, but each implementation remains isolated.

## Rules for every bullet

- One primary user outcome.
- One main architectural question.
- Exact scope and non-goals.
- Additive/reversible migration.
- Targeted tests + full repository gate.
- Manual browser QA.
- Independent diff review.
- Clear stop/accept checkpoint.
- Production coherent if the roadmap stops after this bullet.
