# Current-State Audit

**Detailed-package baseline:** `mjj2332/Quincy_Portal` `main` at `2ac2ca27a1e0ded328b9265613ab4ebeeb7db1b0`
**Current execution baseline:** `main` at `08f4653482c82e4a117c6347a7d0a456d48002ed`
**Audit date:** 2026-08-24
**Scope:** current facts that constrain the revised revamp; re-check before each implementation plan

## 1. Repository and process

- Production implementation is exclusively under `portal/`; `prototype/` is reference-only.
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

- Applied migrations are documented through `0029`; re-check the next number before any schema plan.

## 2. Runtime and frontend baseline

Current declarations remain React `18.3.1`, React DOM `18.3.1`, Vite `8.1.5`, `@vitejs/plugin-react` `6.0.3`, TypeScript `7.0.2`, `createRoot` under StrictMode, modern `react-jsx`, typed custom router, Tiptap v3, dnd-kit, Floating UI, Better Auth, and app CSS/tokens. No Tailwind, shadcn, or FullCalendar configuration is live.

Consequences:

- TB0A remains an independent React 19.2 compatibility release before generated shadcn code.
- TB5C must recheck the then-current FullCalendar/shadcn registry after TB1 establishes Quincy's shadcn foundation.

## 3. Design convergence baseline

Quincy tokens/fonts are substantially preserved; current production contains valuable real-data/accessibility evolution but is not automatic visual authority. The TB0 baseline area now owns the durable repository drift register. Calendar Month/Week/Agenda, Unscheduled panel, drag/resize, External Editor read-only/mutable states, and role badges become explicit evidence surfaces once introduced.

## 3a. PR #44 AutoHDR current baseline

Current `main` includes the Admin-only direct AutoHDR handoff from RAW Review. The explicit action
freezes the server-side RAW selection, uses one background Workflow job, uploads private R2 JPEGs
through provider-issued presigned URLs, and advances Stage only after provider finalization is
accepted. The direct path is send-only: it has no completion callback and does not retrieve AutoHDR
status or processed photos. Credentials remain on the background Worker, and provider UID,
diagnostics, and handoff details stay outside non-admin projections. Manual Stage movement remains
separate and never sends or cancels AutoHDR work. This is a current source/authority boundary to
preserve through later tracer bullets, not a new revamp feature.

## 4. Routing and freshness

The custom router already tracks pathname/search, validates internal destinations, supports direct project routes and multiple tabs, and scopes Project Workspace by ID. Staleness remains a data-lifecycle problem.

| Surface | Current behavior | Gap |
|---|---|---|
| Dashboard/Kanban/List | mount/scope/manual reload | no shared focus/poll/invalidation; no Calendar URL/range state |
| Project detail | load on project change plus own-action refreshes | external changes can stay stale |
| Active assets | project/tab changes plus explicit actions | no uniform route/resource cache |
| Jobs/AutoHDR | bespoke five-second polling while active | must not be duplicated by query migration |
| Project comments | load when panel opens, local updates after own mutation | no shared polling/read-state policy |
| Checklist | component-owned load/mutations | no cross-tab freshness or schedule-range contract |
| Notice Board | bespoke polling; seen marker local | unread state is not server-owned |
| Notifications | bespoke bell polling | delivery is not uniformly durable |

TB2 first migrates Project detail and active collection assets. Later Calendar queries must key visible range, event layers, filters, and authorization scope and must purge inaccessible data after membership/role loss.

## 5. Dashboard and Calendar baseline

Current Dashboard:

- supports only `list` and `kanban` views;
- persists the chosen Dashboard view in local storage;
- exposes active/archived scope for Admin;
- project summary includes address/client display, Stage, shoot date, cover, RAW counts, Priority and `boardPosition`;
- does not include project Deadline, project memberships, checklist schedules, or a cross-project schedule projection;
- uses native HTML5 Kanban drag today.

There is no Calendar component/library, Month/Week/Agenda route state, Unscheduled panel, range API, or direct scheduling interaction.

## 6. Project Workspace and Collaboration

Current `ProjectWorkspace.tsx` receives collections and all memberships, renders Agency/Agent/Shoot/read-only Stage/Photographers in the left rail, omits Editors there, and renders Collaboration separately. Collaboration owns project comments and checklist/subtasks and should remain task/discussion-focused.

Revised consequence: the left rail owns Stage, Deadline/Reminders, Photographers, and Editors; checklist scheduling stays with checklist items even when Calendar becomes another editing surface.

## 7. Membership, roles, and access

Current global role keys are exactly:

```text
admin | photographer | editor
```

Current capability facts:

- Admin and internal Editor have `viewAllProjects`.
- Photographer does not and requires explicit membership plus Photographer-visible Stage.
- `project_members` uses only `photographer | editor` role rows and supports a user holding both.
- Project collaboration is narrower than ordinary view access: non-admins require an explicit membership row.

Critical External Editor implementation fact:

- `hasProjectAccessForUser()` already falls back to membership for any role without `viewAllProjects` and applies the Stage restriction only to Photographer.
- **However, `GET /projects` currently special-cases only Photographer and otherwise returns the broad project set.** Adding a fourth role without generalizing that list/search projection would expose unassigned projects.

Other current facts:

- Create/Edit Project selects current Photographer/Editor candidates.
- Photographer eligibility currently includes Photographer/Editor/Admin.
- Editor eligibility currently includes Editor/Admin.
- User provisioning/patch validation derives from shared `ROLES`.
- User PATCH deletes sessions when `active=false`; changing `role` currently does **not** revoke existing sessions.
- No current account is `external_editor` and no rollout should infer one automatically.

## 8. Project and external-safe field baseline

Current `projects` schema includes, among other fields:

- address/location;
- Agency/Agent display snapshots and agent email/phone;
- shoot date/time window;
- Stage/Priority/order identifiers;
- invoice/payment fields;
- `notes` (project production notes);
- Dropbox/raw folder link/path;
- cover/archive metadata.

Admin directory `agencies.notes` is a separate field/domain.

Current project detail membership query includes member name **and email**. TB4E therefore needs an explicit project-scoped participant-contact contract rather than relying on incidental response shape.

## 9. Checklist scheduling baseline

Current `project_subtasks` fields include title, done, position, one nullable assignee, assignment version, one nullable `due_date`, one-shot due-reminder marker, creator and timestamps.

Current API accepts exactly:

```text
YYYY-MM-DD
YYYY-MM-DDTHH:MM
```

for due values and validates the literal calendar components without `Date` parsing.

There is currently:

- no start value;
- no independent checklist schedule version;
- no canonical UTC instant/fold storage for timed due values;
- no range endpoint/index;
- no cross-project schedule query.

Existing due values must remain truthful end-only milestones during TB4D.

## 10. Stage, pipeline, Deadline, notifications, and Kanban

Existing revamp conclusions remain:

- introduce `moveProjectStage` across rail/Kanban;
- preserve fixed semantic system-stage progression;
- TB0B removes ordinary Admin global Stage ordering;
- TB4B introduces independent Sydney project Deadline/reminder state;
- TB4/TB4C introduce durable outbox/activity/registry delivery;
- TB5A normalizes manual Kanban order and makes `boardPosition` authoritative;
- TB5B replaces native board drag with dnd-kit.

External Editor then consumes these contracts through assigned project scope rather than redefining them.

## 11. Discussion and Notice Board

Project comments and Notice Board posts already have rich text, mentions, author-only edit/delete, audit, and notifications. Project comments are project-scoped; Notice Board is staff-wide under `viewNoticeBoard`.

TB4E consequence:

- External Editors receive normal project Collaboration on assigned projects;
- project mention/assignee discovery must stay project-scoped;
- participant email may be exposed only within project context per the approved requirement;
- External Editors do not receive `viewNoticeBoard`.

## 12. Audit conclusion

Proceed in this order:

1. TB0 authority/baseline.
2. TB0A React 19.2.
3. TB0B pipeline boundary.
4. TB1 UI foundation.
5. TB2 freshness.
6. TB3 discussion read-state.
7. TB4 durable delivery.
8. TB4A assignment rail.
9. TB4B project Deadline/reminders.
10. TB4C Editor-wide registry.
11. TB4D checklist scheduling ranges.
12. TB4E External Editor assigned-scope authorization.
13. TB5A Stage/Kanban ordering.
14. TB5B Kanban interactions.
15. TB5C Production Calendar, consuming TB4B/TB4D/TB4E and TB5B interaction/freshness conventions.
16. TB6–TB8 later surfaces/convergence.
