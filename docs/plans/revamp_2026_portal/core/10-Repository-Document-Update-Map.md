# Repository Document Update Map

**Status:** Proposed synchronization checklist after owner approval  
**Purpose:** prevent the revamp package from drifting away from Quincy's approved authority documents

## 1. `docs/Decision-Sheet.md`

Keep D-15. Add:

### Proposed D-16 — UI platform

```markdown
| D-16 | What frontend styling/component architecture should Quincy use for the revamp? | A. Tailwind CSS v4 + source-owned shadcn components, migrated incrementally and mapped to Quincy semantic tokens. B. Keep custom global CSS only. C. Replace the UI wholesale with a themed visual framework. | **A — Tailwind CSS v4 + shadcn, incrementally.** | Reduces global CSS and repeated primitive work while preserving Quincy's visual identity and existing React/Vite SPA. | UI / architecture / build / accessibility | Revamp package 2026-08-21 | Approve ☐ / Change: ___ |
```

### Proposed D-17 — collaboration/freshness/Kanban ownership

```markdown
| D-17 | How should Quincy implement automatic freshness, asynchronous discussions, notifications and Kanban? | A. Quincy-owned domain/data on Cloudflare infrastructure, delayed refresh and tracer-bullet migration. B. Adopt a managed collaboration/Kanban vendor. C. Keep current bespoke behavior without a coordinated architecture. | **A — Quincy-owned on Cloudflare.** Keep deep links; use route-keyed server state, D1/R2/Queues/Workflows where appropriate, existing Tiptap and a headless DnD engine. | Avoids vendor data lock-in while fixing stale pages and reusing existing production foundations. | product / UI / data / infra / notifications | Revamp package 2026-08-21 | Approve ☐ / Change: ___ |
```

Update metadata and the final approved-decision range only after owner sign-off.

## 2. `docs/Implementation-Plan.md`

Add amendments rather than rewriting history:

- **A8 — Tailwind v4 + shadcn UI platform.**
- **A9 — Route-aware server-state freshness.**
- **A10 — Quincy-owned discussions/notifications/Kanban on Cloudflare.**

A8 should cover token bridge, Preflight policy, component ownership and incremental coexistence.

A9 should cover deep links, query identity, focus/poll refresh, mutation invalidation and router retention.

A10 should cover D1 discussion/read state, notification outbox/Queues, R2 attachments, current project Kanban modernization and no external managed vendor.

Do not change old implementation history to pretend these were original assumptions.

## 3. `docs/PRD.md`

Merge product outcomes from [`03-PRD-Delta.md`](./03-PRD-Delta.md):

- deep links and multi-tab isolation;
- automatic freshness;
- asynchronous discussions;
- server-side read state;
- reliable notifications/preferences;
- accessible Kanban movement;
- UI consistency/brand;
- incremental rollout/no-regression requirements.

Keep implementation specifics such as exact query libraries and Queue schema in architecture/plan docs.

## 4. New supporting architecture docs

After approval, either:

- promote the core files into stable `docs/` architecture documents; or
- keep them in this revamp folder during implementation and consolidate only when the target becomes live.

Recommended stable destinations later:

```text
docs/Frontend-Architecture.md
docs/Collaboration-Architecture.md
docs/Notification-Architecture.md
```

Avoid duplicating the same contract in both places indefinitely.

## 5. `AGENTS.md` and `CLAUDE.md`

Update identically after D-16/D-17 approval.

Add concise rules:

- Tailwind/shadcn is an incremental target, not fully migrated state.
- Quincy semantic tokens/brand are authoritative.
- generated shadcn source is first-party code.
- Preflight policy.
- one styling owner per migrated element.
- TanStack Query route keys include all resource variables once adopted.
- preserve deep links and automatic freshness.
- no managed collaboration/Kanban vendor.
- D1 is authoritative for collaboration/board data; R2 for attachments; Queues for asynchronous delivery.
- project Kanban card equals project; reuse project discussion.
- date/time literal contract remains exact.

Do not claim a stack item is live before its first deployed slice.

## 6. `README.md`

Update the stack summary in two stages:

### After decisions but before implementation

Describe Tailwind/shadcn and collaboration architecture as an **approved migration target**.

### After first live slice

Describe Tailwind/shadcn as active but incremental. Do not imply all legacy CSS is gone.

Add links to the revamp index and any promoted architecture docs.

## 7. `docs/todo.md`

Add one umbrella open-plan entry plus the active tracer bullet.

Example:

```markdown
- [ ] **Quincy Portal revamp — approved umbrella program.** Tailwind v4/shadcn, route-safe automatic freshness, Quincy-owned asynchronous discussions/notifications and existing Kanban modernization, delivered through separate reviewed tracer bullets. See `docs/plans/Quincy-Portal-Revamp-Index.md`.
```

Track exact deployed slices. Do not mark the umbrella complete while legacy surfaces remain.

## 8. `docs/lessons.md`

Add only verified lessons from implementation, not research speculation.

Likely categories if they actually occur:

- Tailwind Preflight/base interaction;
- shadcn generated-source updates;
- query-key collision or draft reset;
- D1/Queue outbox race;
- Queue batch retry duplication;
- dnd-kit board refresh/drag interaction.

## 9. Historical plans

Do not rewrite files under `docs/plans/implemented/`. They record what was designed and deployed at the time.

The archived MUI-first handoff in this package is explicitly superseded and should not be copied into active root plans.

## 10. Active slice plans

Each roadmap brief must be converted into a repository-native plan under `docs/plans/` and pass `docs/Subagent-Orchestration.md` before code changes.

Suggested plan names:

```text
Revamp-TB0-Architecture-And-Baseline-Plan.md
Revamp-TB1-Tailwind-Shadcn-Foundation-Plan.md
Revamp-TB2-Route-Safe-Freshness-Plan.md
...
```

After live deployment, update status and move to `implemented/` according to the existing convention.
