# Repository Document Update Map

**Status:** Proposed synchronization checklist after separate authority-promotion approval  
**Purpose:** prevent the revised package from drifting from Quincy's authority chain

This package revision intentionally does **not** modify the files below.

## 1. `docs/Decision-Sheet.md`

Preserve D-15 as the historical React 18 + TypeScript + Vite SPA decision. Add four decisions after owner approval.

### Proposed D-16 — Frontend UI platform and design convergence

Tailwind CSS v4 plus source-owned shadcn components, migrated incrementally. Base UI/Sera/Lucide, semantic Quincy token mapping, disabled Preflight initially, no dark mode. Quincy design system is visual authority; prototype is visual/flow reference; material deviations require matched evidence and classification.

### Proposed D-17 — Quincy-owned collaboration, freshness, pipeline, and Kanban architecture

Keep deep routes and typed custom router; adopt TanStack Query incrementally; keep collaboration/activity/notification/Kanban data Quincy-owned on Cloudflare; no managed collaboration/Kanban vendor. Fixed semantic Stage identities remain independent of display order. Global Stage order is developer-managed. Correct ordering before dnd-kit interaction modernization.

### Proposed D-18 — Project Workspace coordination, Deadline, and Editor notifications

The Project Workspace left rail is canonical for Stage, Deadline/Reminders, Photographers, and Editors. `editProject` governs rosters/deadlines. New `moveProjectStage` governs Stage for Admins and Editors. Add Sydney Deadline/reminder scheduling, durable assigned-Editor registry, and Kanban Deadline metadata replacing card RAW count.

### Proposed D-19 — React 19.2 runtime baseline

Upgrade production `portal/` to the latest stable exact React `19.2.x` patch in standalone TB0A. Retain TypeScript/Vite SPA/Cloudflare architecture. No React Compiler, Server Components, SSR, or product refactor as upgrade collateral. D-19 supersedes only the React-major portion of D-15.

Update approval metadata/range only after explicit owner sign-off.

## 2. `docs/Implementation-Plan.md`

Add amendments, preserving history:

- **A8 — UI platform and design convergence.** Tailwind/shadcn setup, token bridge, Preflight, component ownership, evidence/drift process.
- **A9 — Route-aware server-state freshness.** Query keys, focus/poll/broadcast, invalidation, cancellation, draft preservation, router retention.
- **A10 — Discussions, activity, durable notifications, fixed pipeline semantics, and Kanban.** Adapter-first discussion, server reads, activity domain, outbox/Queue, system-stage identity, developer-managed order, TB5A-before-TB5B.
- **A11 — Project Workspace coordination.** Canonical rail, role deltas/cycles, `moveProjectStage`, Deadline versions/reminders/preferences, Editor registry/privacy/coalescing.
- **A12 — React 19.2 runtime upgrade.** Exact pins, reviewed codemods, minimum dependency churn, StrictMode, error behavior, QA/deploy/rollback.

## 3. `docs/PRD.md`

Merge product outcomes from [`03-PRD-Delta.md`](./03-PRD-Delta.md), excluding implementation-specific library/schema detail where architecture docs are more appropriate.

Required product additions:

- React 19.2 target and compatibility-only boundary;
- design convergence/evidence and browser floor;
- route-safe freshness and draft preservation;
- canonical left-rail coordination/responsive summary;
- team eligibility, dual roles, inactive/stale-cycle behavior;
- Stage semantics/permissions/confirmations;
- developer-managed global order;
- Sydney Deadline/reminders/preference/delivery target;
- activity and durable assigned-Editor registry;
- corrected Kanban order and accessible movement;
- URL-addressable card detail and notice read-state migration.

## 4. `AGENTS.md` and `CLAUDE.md`

Update identically after D-16–D-19 approval. Add concise rules only when they are approved targets/live states accurately labelled:

- React 19.2 upgrade is TB0A target until deployed; no incidental new React architecture.
- Tailwind/shadcn is incremental; Quincy design system authoritative; Preflight disabled initially.
- generated source is first-party; one styling owner.
- all query keys include route/resource variables; preserve deep links/drafts.
- Project Workspace rail owns project-level coordination; Collaboration owns tasks/discussion.
- role-specific membership mutations preserve other roles and cycles.
- `moveProjectStage` owns Stage; system-stage semantics do not follow display order.
- global order is developer-managed.
- Deadline is separate from shoot/subtask due fields.
- broad notifications are a finite activity registry, not every write.

Do not claim stack/feature items are live before deployment.

## 5. `README.md`

Two stages:

- after authority approval: describe React 19.2/Tailwind/shadcn/freshness/coordination as approved migration targets and link the revamp index;
- after first live slices: describe actual runtime/component/query adoption accurately and incrementally.

## 6. `docs/todo.md`

After authority approval, add one umbrella entry plus only the currently active tracer bullet. Track exact deployed slices. Do not mark the umbrella complete while legacy surfaces or open drift entries remain.

Suggested umbrella wording:

```markdown
- [ ] **Quincy Portal revamp — approved umbrella program.** React 19.2 runtime baseline; evidence-led Tailwind v4/shadcn convergence; route-safe freshness; Quincy-owned discussion/activity/notifications; Project Workspace coordination rail; corrected Stage/Kanban semantics; independently reviewed tracer bullets. See `docs/plans/Quincy-Portal-Revamp-Index.md`.
```

## 7. `docs/lessons.md`

Add only verified implementation lessons, not planning speculation. Candidate categories if observed:

- React 19 types/StrictMode/error behavior;
- Tailwind Preflight/source detection;
- shadcn generated-source update behavior;
- query-key or draft-reset defects;
- membership-cycle/Deadline conflict defects;
- D1/Queue/outbox/replay races;
- dnd-kit refresh/drag behavior.

## 8. Supporting architecture

Keep core files under the revamp package during implementation or promote selected stable architecture later. Avoid permanent duplicated contracts in both locations.

## 9. Historical plans

Do not rewrite `docs/plans/implemented/`. They remain accurate records of what shipped. Do not use historical Collaboration-pane placement or React-18 non-goal as current direction.

## 10. Repository-native implementation plans

Each scope brief becomes a reviewed plan before code. Suggested names:

```text
Revamp-TB0-Architecture-And-Baseline-Plan.md
Revamp-TB0A-React-19-2-Runtime-Upgrade-Plan.md
Revamp-TB0B-Pipeline-Configuration-Boundary-Plan.md
Revamp-TB1-Tailwind-Shadcn-Foundation-Plan.md
Revamp-TB2-Route-Safe-Freshness-Plan.md
Revamp-TB3-Project-Discussion-V2-Plan.md
Revamp-TB4-Notification-Outbox-And-Queues-Plan.md
Revamp-TB4A-Project-Workspace-Assignment-Rail-Plan.md
Revamp-TB4B-Project-Deadline-And-Reminders-Plan.md
Revamp-TB4C-Editor-Wide-Project-Change-Notifications-Plan.md
Revamp-TB5A-Project-Stage-And-Kanban-Ordering-Plan.md
Revamp-TB5B-Kanban-Interaction-Modernization-Plan.md
...
```

Follow `docs/Subagent-Orchestration.md`, full verification, production deployment, status update, and `git mv` to `implemented/` only after live verification.
