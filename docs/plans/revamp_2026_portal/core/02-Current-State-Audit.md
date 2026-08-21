# Current-State Audit

**Baseline:** `mjj2332/Quincy_Portal` `main` at `ff01974f91f4b459a31352fbdf20981e6d38977a`  
**Audit date:** 2026-08-21  
**Scope:** facts that constrain the revamp; re-check before implementation

## 1. Repository and process

- Production implementation is exclusively under `portal/`.
- `prototype/` is reference-only.
- `docs/todo.md` is the live current-state tracker.
- Repository authority is Decision Sheet → Implementation Plan → PRD/supporting docs.
- `AGENTS.md` and `CLAUDE.md` must remain exact mirrors.
- There is no staging environment.
- The required full gate from `portal/` is:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

- Production deploy order is background → webhook-ingress → app.
- Applied migrations are documented through `0029`; the next available number is `0030` at this baseline.

## 2. Production frontend

Current declarations and architecture:

- React `18.3.1` and React DOM `18.3.1`.
- Vite `8.1.5`.
- TypeScript `7.0.2`.
- Custom state/history route parser; no React Router/TanStack Router.
- Custom token files plus monolithic `app.css`.
- Dependencies pinned at `portal/package.json`.
- No Tailwind or shadcn configuration yet.
- Production `colors.css`, `fonts.css`, `spacing.css` and `typography.css` are byte-identical to the prototype design-system sources; production `base.css` differs only in the pattern asset URL.
- Production `app.css` is about 112 KB versus about 51 KB in the prototype. Growth alone is not proof of visual failure, but it locates the main drift risk in application selectors, component composition and responsive behavior rather than in the foundational tokens.

Specialized libraries already present:

- Tiptap v3 for rich text, links, mentions, lists, headings and task lists.
- dnd-kit for checklist and link reordering.
- Floating UI for anchored popovers.
- better-auth for staff authentication.

## 2a. Design convergence today

The design foundation is substantially preserved, but there is no repository-level conformance process for the surfaces built after the prototype.

Current facts:

- the design-system tokens and core dashboard/Kanban geometry remain recognizable;
- production has added real auth, server data, accessibility behavior, notice-board/collaboration UI, ordering controls and other functionality the prototype never modeled;
- some differences are intentional product evolution, while others may be ad hoc drift;
- no active document currently classifies those differences or records owner-approved deviations;
- TB0 previously required representative current screenshots but not matched prototype/current evidence.

Conclusion: do not replace or reconstruct the token system. Audit the application layer surface by surface using the design system as visual authority and the prototype as the visual/flow reference.

## 3. Routing and deep links

The custom router:

- reads pathname + search;
- subscribes to `popstate`;
- notifies after its own `pushState`/`replaceState` calls;
- validates internal destinations;
- supports typed project routes;
- renders `ProjectWorkspace` with `key={projectId}`.

Conclusion: path-based routing is not the root defect. It correctly enables direct project links and multiple projects in separate tabs.

## 4. Data freshness today

| Surface | Initial load | Ongoing refresh today | Gap |
|---|---|---|---|
| Dashboard/project list/Kanban | Fetch on mount, scope change or manual reload counter | No general interval/focus policy | Other-tab/server changes remain stale |
| Project details | Fetch when `projectId` changes | Some explicit refreshes after own mutations | External changes may remain stale |
| Assets/current collection | Fetch on project/tab changes and explicit actions | No uniform general policy | External uploads/reviews may remain stale outside special flows |
| Jobs | Fetch and poll while active | Five-second polling | Already dynamic but bespoke |
| AutoHDR status | Conditional five-second recursive polling | Yes in selected stages | Bespoke and separate from other data |
| Project comments | Fetch when panel opens; local-state updates after own actions | No general polling | Other users/tabs do not appear automatically |
| Subtasks | Component-managed load/mutations | No unified route/query policy | Other-user changes may remain stale |
| Notice board | Poll full list every 25 seconds open; latest every 60 seconds closed | Yes | Seen marker is browser-local, not server/user synchronized |
| Notifications | Bell polling exists | Yes, bespoke | No complete preferences/digest/retry system |

## 5. Existing project discussions

Backend already provides:

- project collaboration access enforcement;
- cursor pagination;
- Tiptap-compatible rich-text JSON;
- active/project-eligible mentions;
- create/edit/delete;
- author-only edit/delete;
- auditing;
- mention notification/email emission.

Frontend currently keeps comment data in component state, prepends its own newly posted comments and loads older pages manually.

The same collaboration pane already hosts the checklist, whose anchored assignee and due-date popovers provide the interaction precedent for the proposed editor/deadline controls. Multiple editor memberships already exist and the Edit Project form can select several editors, but routine add/remove is not exposed in the collaboration pane. There is no distinct project-level due date/time or configurable project reminder schedule.

## 6. Existing notice board

Backend already provides:

- staff capability gating;
- rich text and mentions;
- author-only edit/delete;
- auditing;
- mention notifications.

Frontend currently:

- polls with different open/closed intervals;
- stores collapse state and latest-seen ID in localStorage;
- treats a top-level notice as the content unit;
- does not yet provide comments/replies under a notice.

## 7. Existing notifications

Current implementation includes:

- D1 notification rows;
- per-user unread count;
- mark read, read all and delete;
- event types for project pipeline, assignment, mention and due events;
- `sourceKey` deduplication for selected events;
- email sent/error metadata;
- direct best-effort email sending during emission;
- background scans for due/stalled events.

Primary gaps:

- no durable general outbox between domain writes and delivery;
- no full preference center;
- no per-project/thread subscription level;
- no digest policy;
- no general retry/DLQ flow for request-path email failures;
- no unified observability/admin recovery interface.
- no editor-wide project-change event registry or guaranteed fan-out to all assigned editors;
- no project-level deadline with multiple user-configurable advance reminders.

## 8. Existing Kanban

The Dashboard already has a project-stage Kanban board:

- each card is a project;
- columns are pipeline stages;
- cards link to `/projects/:projectId`;
- project priority and persisted `boardPosition` already exist;
- sort modes include board order and shoot-date ordering;
- stage moves use optimistic local updates and a server mutation;
- the board currently uses native HTML5 `DragEvent`, not dnd-kit;
- up/down controls exist for manual ordering in selected modes;
- board mode displays all non-null-priority cards ahead of null-priority cards, then sorts by `boardPosition`;
- shoot-date modes override both priority grouping and manual order;
- changing priority also rewrites `boardPosition`, including while a shoot-date view hides the resulting manual-order change;
- the up/down API uses the flat persisted order while the UI displays a priority-grouped order, so an accepted historical edge case can persist a successful move with no visible movement;
- stage moves append a project to the target stage's persisted order while retaining its priority value.
- cards currently show a RAW count and do not have a project due date/time field to display.

Therefore the future work is not a new board product, but it is also not only a DnD-library swap. The ordering model must be corrected and approved before interaction modernization so the revamp does not encode the current inconsistencies more deeply.

Key consequence: a Kanban-card discussion is currently the same project discussion. Do not create duplicate comment storage for the same project card.

## 9. Strengths to preserve

- Strong brand tokens and visual identity.
- Explicit backend capability checks.
- Mature auditing discipline.
- Good focus/Escape DOM tests in complex surfaces.
- Tiptap content validation is shared server/client.
- dnd-kit has already been integrated successfully.
- Existing guarded/optimistic update patterns can inform Kanban conflicts.
- Existing deep links from notifications/emails already target project routes.
- Existing `project_members` rows and multi-editor Edit Project UI prove that editor membership is already many-to-many.
- Existing checklist assignee/date popovers provide a tested interaction pattern for compact collaboration-pane controls.

## 10. Main architectural debts

- Server-backed data lifecycles are component-specific and inconsistent.
- Global CSS owns too many unrelated surfaces.
- Repeated generic UI behavior remains expensive.
- Project discussion and notice-board domains overlap but are separate implementations.
- Read state is not consistently server-owned.
- Notification delivery is not uniformly durable.
- Time-critical project coordination is split between Edit Project, checklist controls and direct notification helpers; there is no project deadline/reminder contract.
- Existing Kanban DnD lacks the richer keyboard/touch/scroll model expected from the installed dnd-kit stack.
- There is no design-conformance/drift register distinguishing approved product evolution from accidental divergence.
- Kanban visible order and persisted/manual-order behavior can disagree, and some successful mutations have no immediate visible effect.

## 11. Audit conclusion

The revamp should not discard the existing application. It should establish shared foundations through real consumers:

1. Establish a matched prototype/current design baseline and drift register.
2. Prove Tailwind/shadcn as an implementation tool for Quincy—not as a replacement aesthetic.
3. Prove route-aware server state.
4. Migrate project discussion.
5. Prove durable notification delivery.
6. Add collaboration-pane editor assignment, a versioned project deadline/reminder schedule, editor-wide project-change events and Kanban due metadata.
7. Correct the existing Kanban ordering contract, then modernize its interactions.
8. Reuse project discussion in the project-card experience.
9. Migrate the notice board after the shared model is proven.
10. Converge remaining UI one feature surface at a time.
