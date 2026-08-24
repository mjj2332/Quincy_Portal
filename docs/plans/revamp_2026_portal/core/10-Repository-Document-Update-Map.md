# Repository Document Update Map

**Status:** Applied synchronization record after authority-promotion approval on 2026-08-24
**Purpose:** prevent the revised package from drifting from Quincy's authority chain

The exact authority wording was applied to the authority files on 2026-08-24; this map records the
active package propagation and remaining target-vs-live boundaries.

## 1. `docs/Decision-Sheet.md`

Preserve existing history. The approved additions are:

### D-16 — Frontend UI platform and design convergence
Tailwind v4 + source-owned shadcn, Base UI/Sera/Lucide, semantic Quincy tokens, controlled Preflight, no dark mode, evidence-led convergence.

### D-17 — Quincy-owned collaboration, freshness, pipeline, and Kanban architecture
Keep deep routes/custom router; incremental TanStack Query; Cloudflare-owned collaboration/activity/notification data; fixed semantic Stage identities; developer-managed global order; correct ordering before dnd-kit modernization.

### D-18 — Project Workspace coordination, Deadline, and Editor notifications
Left rail canonical for Stage/Deadline/team; `editProject` rosters/deadlines; `moveProjectStage` Stage; Sydney project Deadline/reminders; assigned-Editor registry; Kanban Deadline metadata.

### Revised D-15 — React 19.2 compatibility-only runtime baseline
Standalone exact stable React 19.2 upgrade; retain TypeScript/Vite SPA/Cloudflare; no Compiler/RSC/SSR/product refactor collateral.

### Revised D-13 — Production Calendar and checklist scheduling
Dashboard Calendar beside List/Kanban; Sydney project Deadline milestones plus optional checklist due/range schedules; Month/Week/Agenda; typed filters/URL state; dedicated authorized range API; FullCalendar Standard official shadcn integration; guarded direct manipulation and accessible alternatives; no recurrence/external calendar sync.

### D-19 — External Editor assigned-scope access
Distinct global `external_editor` role using existing project Editor membership; assigned-project-only authorization; explicit production/collaboration allow-list with no delivery/publish/RAW-selection/extras or broad/Admin/Notice Board scope; server-side external-safe DTO/event policy; project-scoped collaboration/contact; assigned-scope Calendar; role/session/membership lifecycle rules.

## 2. `docs/Implementation-Plan.md`

Add amendments while preserving history:

- **A8 — UI platform and design convergence.**
- **A9 — Route-aware server-state freshness.**
- **A10 — Discussions, activity, durable notifications, fixed pipeline semantics, and Kanban.**
- **A11 — Project Workspace coordination.**
- **A12 — React 19.2 runtime upgrade.**
- **A13 — Checklist Scheduling and Production Calendar.** Additive schedule model/versioning/DST, dedicated range API, FullCalendar/shadcn integration, direct manipulation/accessibility/filter/freshness contracts.
- **A14 — External Editor Assigned-Scope Authorization.** Role/capability matrix, generic membership scoping, safe DTOs, session transition rules, assignment UX, project-scoped contact/privacy, external-safe notification/activity/Calendar behavior.

## 3. `docs/PRD.md`

Merge product outcomes from [`03-PRD-Delta.md`](./03-PRD-Delta.md), excluding library/schema details better kept in architecture docs.

Required additions now include:

- React/UI/freshness/canonical rail/Stage/pipeline/Deadline/notification/Kanban outcomes already proposed;
- checklist unscheduled/due-only/start-end schedule semantics and Sydney time;
- Calendar as third Dashboard view, Month/Week/Agenda, filters/shareable state, direct manipulation/accessibility and Unscheduled behavior;
- External Editor identity, assigned-project visibility, explicit production/collaboration allow-list, privacy/contact bounds, collaboration/Calendar/notification behavior, and lifecycle/access-loss rules.

## 4. `AGENTS.md` and `CLAUDE.md`

Update identically after revised D-13/D-15 and D-16–D-19 approval, and label targets versus live state accurately. Add concise rules for:

- React 19.2 target/compatibility boundary;
- incremental Tailwind/shadcn and Quincy visual authority;
- route/resource/range query keys and draft/drag preservation;
- canonical rail vs Collaboration ownership;
- role-specific membership deltas/cycles;
- `moveProjectStage` and fixed Stage semantics;
- Deadline distinct from shoot/checklist schedule;
- broad registry finite/noise-bounded;
- checklist due/start-end schedule contract;
- Calendar authorized range projection/direct manipulation;
- `external_editor` is assignment-scoped and requires external-safe server projection;
- External Editor has no staff Notice Board/global directory/Admin scope.

Do not claim planned stack/features are live before deployment.

## 5. README/todo/lessons

- README: after authority approval describe approved migration targets; after live slices describe actual adoption.
- `docs/todo.md`: after authority approval add one umbrella entry plus only active bullet; never mark planned Calendar/role live early.
- `docs/lessons.md`: add only verified implementation lessons (React/Tailwind/query/membership/Deadline/schedule/DST/role projection/FullCalendar interaction), not planning speculation.

## 6. Historical plans

Do not rewrite `docs/plans/implemented/`. Historical Collaboration placement, React-18 non-goal, List/Kanban-only Dashboard, and three-role assumptions remain historical records, not current proposal authority.

## 7. Repository-native implementation plans

Each scope brief becomes a reviewed current-main-aware implementation plan before code. Suggested additions:

```text
Revamp-TB4D-Checklist-Scheduling-Ranges-Plan.md
Revamp-TB4E-External-Editor-Assigned-Scope-Access-Plan.md
Revamp-TB5C-Production-Calendar-Plan.md
```

Follow repository review/orchestration, full verification, production deployment, status update, and `git mv` to `implemented/` only after live verification.
