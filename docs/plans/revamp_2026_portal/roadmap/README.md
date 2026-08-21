# Tracer-Bullet Roadmap

These are scope briefs. Each bullet requires a separate current-main-aware implementation plan and the repository's review pipeline before coding.

## Sequence

| Bullet | Primary outcome | Main architectural proof |
|---|---|---|
| [TB0](./TB0-Integrated-Architecture-And-Baseline.md) | Approved synchronized docs, matched visual baseline and drift register | One coherent program/decision set |
| [TB1](./TB1-Tailwind-Shadcn-Foundation.md) | First design-conformant Quincy shadcn form slice | UI platform and CSS coexistence |
| [TB2](./TB2-Route-Safe-Data-Freshness.md) | Project pages update without reload | Route-keyed server state |
| [TB3](./TB3-Project-Discussion-V2.md) | Automatically refreshed project discussion/read state | Shared discussion direction |
| [TB4](./TB4-Notification-Outbox-And-Queues.md) | Durable mention delivery | D1 outbox + Cloudflare Queue |
| [TB4A](./TB4A-Collaboration-Pane-Editor-Assignment.md) | Editors are assigned safely in context | Role-specific idempotent membership deltas |
| [TB4B](./TB4B-Project-Deadline-And-Reminders.md) | One project deadline is visible and reliably reminded | Versioned D1 schedule + Kanban metadata |
| [TB4C](./TB4C-Editor-Wide-Project-Change-Notifications.md) | Approved project changes alert every assigned editor without storms | Versioned registry + exact recipient fan-out |
| [TB5A](./TB5A-Kanban-Ordering-Model-Correction.md) | Understandable authoritative Kanban order | One visible/persisted ordering contract |
| [TB5B](./TB5B-Kanban-Interaction-Modernization.md) | Accessible refreshed project board | dnd-kit + guarded board moves |
| [TB6](./TB6-Project-Card-Detail-And-Discussion.md) | Project-card quick detail with shared discussion/activity | UI/domain reuse |
| [TB7](./TB7-Notice-Board-Migration.md) | Server-synchronized notice board | Second discussion consumer |
| [TB8](./TB8-Wider-UI-Migration-And-Cleanup.md) | Surface-by-surface design convergence and retirement of duplicates | Consolidation only after proofs |

## Dependency view

```text
TB0 → TB1 → TB2 → TB3 → TB4
                        │
                        └→ TB4A → TB4B → TB4C → TB5A → TB5B → TB6 → TB7 → TB8
```

Planning may overlap when it does not assume an unresolved upstream contract. Implementation does not:

- TB4A uses TB4's accepted delivery envelope for targeted assignment events.
- TB4B uses TB4A's proven editor-roster contract for reminder recipients.
- TB4C uses TB4A membership timing and TB4B coordination/deadline event shapes.
- TB5A/TB5B preserve TB4B's deadline/RAW card metadata.
- TB5B cannot begin until TB5A's ordering contract is approved and its correction is live or established as the implementation baseline.

TB8 is an umbrella for multiple feature-surface releases, not permission for a final wholesale rewrite.

## Decision ownership

TB0 approves umbrella architecture and TB0-gated defaults. Feature details stay visibly proposed until the named bullet:

| Gate | Decisions |
|---|---|
| TB3 | Discussion/reply/reaction/subscription shape |
| TB4 | Delivery/email ambiguity and replay administration |
| TB4A | Editor-roster write capability |
| TB4B | Deadline timezone, tolerance, reminder bounds, past offsets and reminder email |
| TB4C | Event registry, noise/coalescing, queued eligibility and optional email |
| TB5A | Priority/manual/date ordering and stage insertion |
| TB6/TB7 | Card-detail/activity and notice-board feature choices |

## Rules for every bullet

- One primary user outcome.
- One main architectural question.
- Exact scope and non-goals.
- Additive/reversible migration.
- Targeted tests plus full repository gate.
- Matched visual evidence when UI changes.
- Manual browser QA.
- Independent diff review.
- Clear stop/accept checkpoint.
- Production coherent if the roadmap stops after this bullet.
- Proposed decisions remain labeled until the owning gate approves them.
- If a bullet needs several unrelated acceptance checkpoints, split it before implementation rather than hiding a mini-program inside one status.
