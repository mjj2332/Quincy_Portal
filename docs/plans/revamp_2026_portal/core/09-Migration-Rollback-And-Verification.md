# Migration, Rollback and Verification

**Status:** Program-wide guardrails  
**Applies to:** every tracer bullet

## 1. Principles

- Add before removing.
- One primary outcome and one ownership boundary per release.
- No indefinite dual write/style/query owner.
- Backfills are deterministic/resumable/verified.
- Preserve old data until parity is proven.
- Prefer backward-compatible additive schema.
- Worker rollback does not roll back D1/R2/Queue resources; plan forward compatibility.
- Production mutation is human-authorized; there is no staging environment.

## 2. Sequence

```text
TB0 → TB0A → TB0B → TB1 → TB2 → TB3 → TB4
                                     │
                                     └→ TB4A → TB4B → TB4C → TB4D → TB4E → TB5A → TB5B → TB5C → TB6 → TB7 → TB8
```

Do not combine React, pipeline policy, or UI foundation into one deployment. TB4D schedule storage and TB4E authorization remain independently reversible before TB5C consumes both.

## 3. Existing foundational releases

- **TB0A:** exact React 19.2 compatibility release; no schema; rollback app Worker.
- **TB0B:** remove ordinary Admin global Stage ordering while preserving rows/order values.
- **TB1/TB2:** preserve legacy styling/fetch paths until migrated consumer accepted; Preflight disabled.
- **TB3/TB7:** adapter-first discussion/read-state migration.
- **TB4/TB4C:** durable outbox/activity/recipient ledger; one producer per semantic event.
- **TB4A:** project_members source of truth; role delta/cycle protection; rail rollback does not rewrite memberships.
- **TB4B:** additive project Deadline fields/version/occurrences; scheduler can be disabled without deleting data.

## 4. TB4D checklist scheduling ranges

- Preserve existing `project_subtasks.due_date` as effective end/due value.
- Add nullable start civil data and timed start/end UTC/offset-fold/version fields additively.
- Do not invent start values for existing rows.
- Date-only due remains a literal calendar date with no fabricated UTC midnight.
- Add only indexes needed for approved range/assignee queries after production-shaped query verification.
- Old Worker should tolerate additive columns where practical.
- Rollback disables range editor/API fields/Calendar producer while leaving existing due behavior/data intact.
- Reminder compatibility is end-based; reschedule clears/reversions existing one-shot reminder marker under guarded mutation.

## 5. TB4E External Editor

- Extend the user role constraint/type additively with a reviewed migration compatible with real production foreign keys.
- No current user is automatically changed to `external_editor`.
- Generalize list/search/detail authorization before or atomically with making the role assignable; never ship a window where External Editor exists but broad project list still falls through.
- Role-safe DTOs must be server-enforced before first External Editor account is provisioned.
- Role transitions revoke sessions; incompatible membership conversions fail safely and preserve memberships.
- Rollback must not reinterpret an existing External Editor as internal Editor. If code rollback cannot understand the new role safely, disable login/role assignment or forward-fix rather than deploying an authorization-unsafe old Worker.
- Preserve membership history on deactivation.

## 6. TB5A/TB5B

Capture/rewrite Kanban ordering only under TB5A's reversible normalization contract. TB5B replaces interaction engine only after TB5A accepted; dnd-kit rollback does not change persisted ordering semantics.

## 7. TB5C Production Calendar

- No new independent source of truth: consume TB4B project Deadline and TB4D checklist schedule fields.
- Add dedicated server-authorized range endpoint; do not expose broad project/checklist payloads for convenience.
- Recheck/pin latest stable FullCalendar Standard React/shadcn integration and inspect registry-generated source/dependencies before commit.
- Record bundle/CSS delta and selected official FullCalendar shadcn flavor/rationale.
- Calendar can be rolled back by removing/hiding the Dashboard Calendar view and range endpoint while preserving all schedule data/source editors.
- Do not require destructive data migration for Calendar rendering.
- External Editor Calendar cannot launch before TB4E scope/privacy is accepted.

## 8. D1 migration care

- Recheck migration number against current `main`.
- Prefer additive `ALTER TABLE ADD COLUMN` for suitable nullable changes/checks.
- Do not trust local table-rebuild success against production FK data.
- Update Drizzle schema/journal/snapshot consistently.
- Test invalid raw values and production-shaped fixtures.
- Include backup/query/runbook steps.

## 9. Automated gate

From `portal/`:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Every slice also runs targeted tests during iteration.

## 10. Manual QA

Use authenticated local Worker flow. Verify as applicable:

- sign-in, role changes/session revocation, routing/Back/Forward/new-tab;
- Dashboard List/Kanban/Calendar;
- Project Workspace/rail;
- External Editor assigned/unassigned/archived/delivered access and field privacy;
- media/lightbox/rich text/mentions;
- checklist schedule editor, due-only/range/multi-day/DST;
- Calendar Month/Week/Agenda, filters, URL sharing, Unscheduled drag, project confirmation, checklist drag/end-resize, overlap indicator, keyboard Move/Reschedule;
- notifications/preferences/Admin;
- desktop 1440×900, compact 1024×768, phone 390×844;
- failure/conflict/access-loss behavior;
- console/network warnings/errors.

## 11. Required matrices

### Freshness/access

- project A/B/range/filter isolation;
- focus/reconnect/poll/broadcast;
- access removal clears private data;
- active drag/resize/drafts preserved;
- External versus internal DTO/query isolation.

### Checklist scheduling

- legacy date-only/timed due migration;
- unscheduled/due-only/range transitions;
- start<end and multi-day;
- Sydney DST gap/fold;
- exact-minute form + 15-minute Calendar snapping;
- schedule conflict/version;
- end-based reminder reset;
- broad coalescing.

### External Editor

- capability matrix;
- assigned-only list/search/direct/media/collaboration/Calendar;
- no Photographer Stage restriction;
- archived denial/delivered access;
- field allow/deny contract;
- participant email project scope/no global directory;
- assignment eligibility and Photographer exclusion;
- role transition guards/session revocation;
- deactivation/final membership/access-loss cleanup;
- Notice Board exclusion;
- external-safe Activity/notification categories.

### Production Calendar

- range endpoint authorization and N+1 avoidance;
- Month/Week/Agenda and phone behavior;
- URL state/back-forward/copied slice;
- Editor OR/Unassigned/Stage/status/search filters;
- project progress metadata;
- project drag confirmation/reminder version;
- checklist milestone/range drag/end-resize;
- Unscheduled defaults;
- DST invalid/fold handling;
- stale `409` rollback/no retry;
- overlap warning non-blocking;
- keyboard/action path/focus/announcements;
- dense/multi-day render and no stock-framework drift.

## 12. Release documentation

Record plan path, commit SHA, schema/resources, contract/version, deploy IDs/order, automated/manual results, bundle/evidence, known limitations, rollback/next checkpoint. Move plan to `implemented/` only after verified production.
