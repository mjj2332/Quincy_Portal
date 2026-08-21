# Current-State Audit

**Baseline:** `mjj2332/Quincy_Portal` `main` at `5b4cf91abde3d71f4b00ab936820f75529ea47c1`  
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

Specialized libraries already present:

- Tiptap v3 for rich text, links, mentions, lists, headings and task lists.
- dnd-kit for checklist and link reordering.
- Floating UI for anchored popovers.
- better-auth for staff authentication.

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

## 8. Existing Kanban

The Dashboard already has a project-stage Kanban board:

- each card is a project;
- columns are pipeline stages;
- cards link to `/projects/:projectId`;
- project priority and persisted `boardPosition` already exist;
- sort modes include board order and shoot-date ordering;
- stage moves use optimistic local updates and a server mutation;
- the board currently uses native HTML5 `DragEvent`, not dnd-kit;
- up/down controls exist for manual ordering in selected modes.

Therefore the future work is **Kanban modernization**, not a new board product.

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

## 10. Main architectural debts

- Server-backed data lifecycles are component-specific and inconsistent.
- Global CSS owns too many unrelated surfaces.
- Repeated generic UI behavior remains expensive.
- Project discussion and notice-board domains overlap but are separate implementations.
- Read state is not consistently server-owned.
- Notification delivery is not uniformly durable.
- Existing Kanban DnD lacks the richer keyboard/touch/scroll model expected from the installed dnd-kit stack.

## 11. Audit conclusion

The revamp should not discard the existing application. It should establish shared foundations through real consumers:

1. Tailwind/shadcn proof.
2. Route-aware server-state proof.
3. Project discussion migration.
4. Durable notification delivery.
5. Existing board modernization.
6. Reuse project discussion in the project-card experience.
7. Migrate the notice board after the shared model is proven.
