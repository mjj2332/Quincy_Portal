# Current-State Audit

**Baseline:** `mjj2332/Quincy_Portal` `main` at `8bcb48245a727b048053bd3653cf07f3ad99b780`  
**Audit date:** 2026-08-22  
**Scope:** current facts that constrain the revised revamp; re-check before each implementation plan

## 1. Repository and process

- Production implementation is exclusively under `portal/`.
- `prototype/` is reference-only.
- `docs/todo.md` is the live current-state tracker.
- Repository authority is Decision Sheet → Implementation Plan → PRD/supporting docs.
- `AGENTS.md` and `CLAUDE.md` must remain exact mirrors.
- There is no staging environment.
- Required verification from `portal/` is:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

- Production deploy order is background → webhook-ingress → app when all three change. A web-only bundle change deploys through the app Worker.
- Applied migrations are documented through `0029`; re-check the next number before any schema plan.

## 2. Runtime and frontend baseline

Current declarations:

- React `18.3.1` and React DOM `18.3.1`.
- `createRoot` under `<StrictMode>`.
- modern `react-jsx` transform.
- Vite `8.1.5`, `@vitejs/plugin-react` `6.0.3`, TypeScript `7.0.2`.
- custom typed pathname/history router; no React Router/TanStack Router.
- Tiptap v3, dnd-kit, Floating UI, Better Auth.
- no Tailwind or shadcn configuration.
- app CSS/token files remain the dominant styling layer.

Consequences:

- Quincy is already on React 18.3, the recommended warning bridge for React 19.
- The root and JSX transform already meet React 19's core setup expectations.
- React 19 type changes still require a real source audit: no-argument `useRef`, implicit ref-callback returns, removed APIs, test error assumptions, and StrictMode behavior are not proven compatible merely because the app builds on React 18.
- TB0A must be an independent compatibility release before generated shadcn code is adopted.

## 3. Design convergence baseline

- Foundational Quincy tokens and fonts are substantially preserved.
- `app.css` and later component composition remain the main drift risk.
- Production contains valuable evolution—real data, auth, accessibility, collaboration, ordering, and operational UI—that the prototype never modeled.
- No repository-level drift register currently classifies material differences.

Conclusion: preserve the token system, audit application surfaces at fixed 1440×900, 1024×768, and 390×844 baselines, and classify differences rather than treating either current production or stock shadcn as automatic authority.

## 4. Routing and freshness

The custom router already:

- tracks pathname/search and `popstate`;
- validates internal destinations;
- supports direct project routes and multiple tabs;
- scopes `ProjectWorkspace` by project ID.

The freshness defect is data lifecycle, not path routing.

| Surface | Current behavior | Gap |
|---|---|---|
| Dashboard/Kanban | mount/scope/manual reload | no shared focus/poll/invalidation policy |
| Project detail | load on project change plus own-action refreshes | external changes can stay stale |
| Active assets | project/tab changes plus explicit actions | no uniform route/resource cache |
| Jobs/AutoHDR | bespoke five-second polling while active | must not be duplicated by query migration |
| Project comments | load when panel opens, local updates after own mutation | no shared polling/read-state policy |
| Checklist | component-owned load/mutations | no cross-tab freshness contract |
| Notice board | bespoke open/closed polling; seen marker local | unread state is not server-owned |
| Notifications | bespoke bell polling | delivery is not uniformly durable |

TB2 first migrates Project detail and active collection assets with keys containing project ID and collection kind. Same-browser mutations publish narrow invalidation; bounded polling and focus/reconnect remain the cross-session fallback.

## 5. Project Workspace and Collaboration

Current `ProjectWorkspace.tsx`:

- receives collections and all project memberships;
- renders a left rail with Agency, Agent, Shoot, read-only Stage, and Photographers;
- does not render Editors in the rail;
- renders the Collaboration panel as a separate right-edge surface.

Current Collaboration:

- owns project comments and checklist/subtasks;
- supports rich text, mentions, author-only comment edit/delete, anchored checklist assignee/due popovers, and stage-hidden collaboration-only access;
- should remain task/discussion-focused.

Revised consequence: the left rail—not Collaboration—must own Stage, Deadline/Reminders, Photographers, and Editors.

## 6. Membership model and mutation

Current facts:

- `project_members` has independent `(project_id, user_id, role_on_project)` rows.
- One user may hold both `photographer` and `editor` rows.
- Create/Edit Project can select multiple users for each role.
- Photographer eligibility currently includes active Photographer, Editor, and Admin users.
- Editor eligibility currently includes active Editor and Admin users.
- Edit Project submits caller-owned full lists.
- `syncProjectMembersAndClearSubtaskAssignments()` computes role diffs and atomically clears checklist assignments only after the user loses the final project role and is not an active Admin.

Consequences:

- Inline rail controls must not reuse stale full-list mutation.
- Use explicit role-specific idempotent routes and membership-cycle removal guards.
- Keep inactive assigned users visible/removable.
- Surface the existing last-role checklist-unassignment consequence before mutation.
- Create Project retains initial team selection; routine Edit Project selectors retire after rail parity.

## 7. Stage, capabilities, and pipeline

Current facts:

- `editProject` is currently Admin-only.
- Stage movement currently uses `selectForEditing`, held by Admins and Editors.
- Current Stage endpoint accepts active system stages, appends to the target Stage, audits, and emits the delivered notification.
- Non-admins see `editing_autohdr` projected as neutral `editing`/“Editing”.
- Admin Pipeline can edit labels, activate/deactivate Stages, and move them Up/Down.
- System-stage keys are hard-coded across creation defaults, AutoHDR, visibility, notifications, and presentation.

Revised consequences:

- Introduce `moveProjectStage` for Admins and Editors and use it across rail/Kanban movement.
- Keep fixed semantic progression independent of display order.
- Manual AutoHDR entry/exit is stage-only and uses dedicated confirmation.
- TB0B removes ordinary Admin global-order controls and their self-service endpoint while preserving label and active-state management.
- Dynamic stage creation/deletion remains deferred.

## 8. Deadline/reminder state

Current projects have shoot date/time-window fields; checklist items have literal Sydney due values and a one-shot reminder. There is no distinct project Deadline, configurable reminder set, or project deadline timezone/version.

Revised consequence:

- Add an independent versioned Sydney-time project schedule.
- Do not derive or backfill it from shoot/checklist fields.
- Materialize reminder occurrences, include Due-now, suppress stale versions, and suspend pending schedules on delivered/archive.
- Add a per-user reminder-email preference before enabling default-on email.

## 9. Notifications and activity

Current implementation includes:

- D1 notification rows and unread state;
- selected `sourceKey` deduplication;
- direct/best-effort email during emission;
- mention/assignment/due/pipeline event types;
- background scans;
- shared project-notification helper behavior that appends active Admins even under editor filtering.

Primary gaps:

- no general outbox/Queue boundary;
- no recipient/channel delivery ledger or explicit `unknown` email outcome;
- no unified retry/DLQ/recovery administration;
- no immutable safe project-activity domain;
- no finite mandatory assigned-Editor registry;
- existing general recipient helper cannot implement assigned-Editor-only fan-out unchanged.

## 10. Existing Kanban

- Card = project; column = Stage.
- Fields include Stage, Priority, and `boardPosition`.
- Board mode currently groups all non-null Priority ahead of null and then uses `boardPosition`.
- Shoot-date modes override that order.
- Priority mutation rewrites `boardPosition`.
- Up/Down uses flat persisted neighbours, which can disagree with the visible grouped order.
- Native HTML5 drag powers Stage movement.
- dnd-kit is already installed and used elsewhere.
- Cards currently show RAW count and no project Deadline.

Consequences:

- TB5A must normalize once to preserve current visible order, then make `boardPosition` the sole persisted manual order.
- Priority becomes metadata plus a view-only numeric sort (`1` highest; null last).
- Stage and target-position semantics are unified before TB5B replaces native drag with dnd-kit.
- Kanban cards inherit TB4B Deadline/RAW metadata without Deadline sorting.

## 11. Discussion and notice board

Project comments and notice-board posts already have rich text, mentions, author-only edit/delete, audit, and notification behavior. Project comments also have cursor pagination. Notice-board read/seen state remains browser-local.

Consequences:

- TB3 uses an adapter over current project-comment tables plus server-owned reads.
- TB3 remains a flat stream.
- TB7 proves the same read/freshness/delivery foundation for notices without adding replies/pinning/priority/expiry/acknowledgement.

## 12. Audit conclusion

The revised program should preserve the working application and proceed in this order:

1. Promote the settled decisions and capture the matched baseline/drift register (TB0).
2. Upgrade React independently (TB0A).
3. Enforce the pipeline configuration boundary (TB0B).
4. Prove the Quincy UI layer (TB1).
5. Prove route/resource freshness (TB2).
6. Add discussion read-state/freshness (TB3).
7. Prove durable delivery (TB4).
8. Build the assignment rail, Deadline schedule, and Editor registry (TB4A–C).
9. Establish Stage/Kanban semantics, then modernize interactions (TB5A–B).
10. Add card detail, notice synchronization, and evidence-driven remaining convergence (TB6–8).
