# Repository Document Update Map

**Status:** Proposed synchronization checklist after owner approval  
**Purpose:** prevent the revamp package from drifting away from Quincy's approved authority documents

## 1. `docs/Decision-Sheet.md`

Keep D-15. Add:

### Proposed D-16 — UI platform

```markdown
| D-16 | What frontend styling/component architecture should Quincy use for the revamp? | A. Tailwind CSS v4 + source-owned shadcn components, migrated incrementally; Quincy design system authoritative and prototype used as the visual/flow reference with documented deviations. B. Keep custom global CSS only. C. Replace the UI wholesale with a themed visual framework. | **A — Tailwind CSS v4 + shadcn as implementation tools for design convergence.** | Reduces global CSS and repeated primitive work while restoring disciplined alignment with Quincy's visual identity and existing React/Vite SPA. | UI / architecture / build / accessibility | Revamp package 2026-08-21 | Approve ☐ / Change: ___ |
```

### Proposed D-17 — collaboration/freshness/Kanban ownership

```markdown
| D-17 | How should Quincy implement automatic freshness, asynchronous discussions, notifications and Kanban? | A. Quincy-owned domain/data on Cloudflare infrastructure, route-safe refresh and tracer-bullet migration; correct Kanban ordering before interaction modernization. B. Adopt a managed collaboration/Kanban vendor. C. Keep current bespoke behavior without a coordinated architecture. | **A — Quincy-owned on Cloudflare, with Kanban semantics repaired before dnd-kit modernization.** Keep deep links; use route-keyed server state, D1/R2/Queues/Workflows where appropriate, existing Tiptap and one headless DnD engine. | Avoids vendor data lock-in while fixing stale pages and preventing the interaction refactor from preserving confusing ordering behavior. | product / UI / data / infra / notifications | Revamp package 2026-08-21 | Approve ☐ / Change: ___ |
```

Update metadata and the final approved-decision range only after owner sign-off.

### Proposed D-18 — project coordination, deadlines and editor notifications

```markdown
| D-18 | How should Quincy coordinate time-critical editor work from the project collaboration pane? | A. Reuse multi-editor project membership; allow capability-gated in-pane assignment; add one project deadline with multiple lead-time reminders; durably notify active assigned editors for an approved event registry; show deadline instead of RAW count on Kanban cards. B. Keep assignment/deadline in Edit Project and rely on manual communication. C. Add a separate task/collaboration vendor. | **A — Quincy-owned project coordination on the existing membership, activity and notification domains.** | Removes navigation friction and gives editors reliable deadline/change awareness without duplicating assignment or project-card data. | product / collaboration / data / notifications / Kanban | Revamp package 2026-08-21 | Approve ☐ / Change: ___ |
```

TB0 records later choices as explicit deferrals. TB4A records editor-roster write capability; TB4B records timezone, delivery tolerance, past-offset/custom-reminder and reminder-email policy; TB4C records the event registry/coalescing, queued-eligibility and channel/actor defaults.

## 2. `docs/Implementation-Plan.md`

Add amendments rather than rewriting history:

- **A8 — Tailwind v4 + shadcn UI platform.**
- **A9 — Route-aware server-state freshness.**
- **A10 — Quincy-owned discussions/notifications/Kanban on Cloudflare.**
- **A11 — Project coordination, deadline/reminders and editor-wide change delivery.**

A8 should cover design-system authority, prototype/current drift classification, matched visual evidence, token bridge, Preflight policy, component ownership and incremental coexistence.

A9 should cover deep links, query identity, focus/poll refresh, mutation invalidation and router retention.

A10 should cover D1 discussion/read state, notification outbox/Queues, R2 attachments, TB5A ordering correction before TB5B interaction modernization, and no external managed vendor.

A11 should record the split delivery sequence: TB4A reuses `project_members` for collaboration-pane editor deltas; TB4B adds a deadline distinct from shoot/subtask values, deterministic IANA/DST handling, versioned reminders and card deadline/RAW metadata replacement; TB4C adds the finite project-event registry, exact assigned-editor fan-out, optional email semantics, recipient rechecks/coalescing and producer cutover ownership.

Do not change old implementation history to pretend these were original assumptions.

## 3. `docs/PRD.md`

Merge product outcomes from [`03-PRD-Delta.md`](./03-PRD-Delta.md):

- deep links and multi-tab isolation;
- automatic freshness;
- asynchronous discussions;
- server-side read state;
- reliable notifications/preferences;
- accessible Kanban movement;
- design-system/prototype convergence, drift classification and UI consistency/brand;
- one understandable Kanban ordering contract with no invisible side effects;
- incremental rollout/no-regression requirements;
- direct multi-editor assignment in the collaboration pane;
- one project due date/time and multiple selectable advance reminders;
- editor-wide alerts for the approved finite project-change registry;
- due date/time on Kanban cards in place of the card-level RAW count.

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

Update identically after D-16/D-17/D-18 approval.

Add concise rules:

- Tailwind/shadcn is an incremental target, not fully migrated state.
- Quincy semantic tokens/design system are authoritative; the prototype is the visual/flow reference, never an implementation template.
- material reference deviations are classified and approved surface by surface.
- generated shadcn source is first-party code.
- Preflight policy.
- one styling owner per migrated element.
- TanStack Query route keys include all resource variables once adopted.
- preserve deep links and automatic freshness.
- no managed collaboration/Kanban vendor.
- D1 is authoritative for collaboration/board data; R2 for attachments; Queues for asynchronous delivery.
- project Kanban card equals project; reuse project discussion.
- TB5A ordering correction precedes TB5B interaction modernization; current priority/position/sort semantics are not grandfathered.
- date/time literal contract remains exact.
- project deadline is a separate instant/timezone contract and never changes the checklist due literal contract.
- collaboration-pane editor changes reuse current membership/capability/audit rules and preserve other roles.
- “all project changes” is a versioned user-visible event registry with explicit batching, not every D1 write.

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
- [ ] **Quincy Portal revamp — approved umbrella program.** design-system/prototype convergence through Tailwind v4/shadcn, route-safe automatic freshness, Quincy-owned asynchronous discussions/notifications, Kanban ordering correction and later interaction modernization, delivered through separate reviewed tracer bullets. See `docs/plans/Quincy-Portal-Revamp-Index.md`.
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
Revamp-TB4A-Collaboration-Pane-Editor-Assignment-Plan.md
Revamp-TB4B-Project-Deadline-And-Reminders-Plan.md
Revamp-TB4C-Editor-Wide-Project-Change-Notifications-Plan.md
Revamp-TB5A-Kanban-Ordering-Model-Correction-Plan.md
Revamp-TB5B-Kanban-Interaction-Modernization-Plan.md
...
```

After live deployment, update status and move to `implemented/` according to the existing convention.
