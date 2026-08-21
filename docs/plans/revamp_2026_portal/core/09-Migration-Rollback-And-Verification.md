# Migration, Rollback and Verification

**Status:** Program-wide guardrails  
**Applies to:** every tracer bullet

## 1. Migration principles

- Add before removing.
- One primary user outcome per release.
- One clear old/new ownership boundary.
- No dual-write indefinitely.
- Backfill is deterministic, resumable and audited.
- Old data remains available until parity is proven.
- Schema changes are backward-compatible with the currently deployed Worker during rollout whenever practical.
- A Worker rollback does not roll back D1/R2/Queue schema/resources; plan compatibility explicitly.

## 2. Feature flags and cohorting

Use a feature flag or narrowly selected internal test project when a slice changes high-risk behavior such as:

- discussion storage;
- notification delivery;
- board movement;
- global CSS reset;
- query/cache ownership.

Flags must have a removal plan; they are not permanent parallel architectures.

## 3. Data migration pattern

For discussion/notification schema changes:

```text
1. Create additive schema.
2. Deploy code that can tolerate both old and new state.
3. Backfill in bounded batches with progress/checkpointing.
4. Verify counts, IDs, authors, timestamps, content and mention mappings.
5. Switch reads for a controlled cohort.
6. Switch writes.
7. Observe and compare.
8. Make old path read-only.
9. Remove only in a later release after backup/export and approval.
```

Do not perform destructive table changes in the same release that first proves the new path.

For TB4A, existing `project_members` editor rows remain the assignment source of truth; prefer role-specific deltas without a schema change unless deterministic concurrency or membership-interval evidence requires an additive version.

For TB4B, existing projects backfill to no project deadline and no reminder rules. Add nullable/versioned project fields and a reminder table; do not reinterpret `shootDate`, `timeWindow` or `project_subtasks.dueDate`.

For TB4C, add only the event/delivery fields needed beyond TB4 and keep the owner-approved registry version explicit.

## 4. D1 migration care

Follow repository-specific D1 lessons:

- prefer additive `ALTER TABLE ADD COLUMN` for suitable single-column checks;
- do not trust local table-rebuild success as proof against production foreign-key data;
- update Drizzle schema, migration journal and snapshot consistently;
- confirm next migration number against current `main`;
- test raw invalid values against D1/Miniflare where constraints matter;
- include production query/backup/runbook steps.

## 5. Rollback design

### UI/Tailwind/query-only release

- revert Worker/web bundle;
- legacy CSS/API remains compatible;
- do not delete old selectors until migrated component is verified.

### Additive D1 release

- prior Worker must tolerate new nullable tables/columns;
- rollback code only; leave additive schema;
- forward-fix data if writes used the new schema.

### Queue/outbox release

- domain write remains successful even if consumers are disabled;
- pending outbox rows can be replayed;
- old notification path remains for unmigrated events;
- provide a switch to stop new producer publication if consumer defect appears.

### Editor-roster release (TB4A)

- the previous Edit Project editor UI remains a fallback until collaboration-pane controls are verified;
- disabling the pane control leaves existing memberships unchanged;
- both UI surfaces use the same role-specific mutation contract;
- rollback never removes or rewrites membership rows.

### Project deadline/reminder release (TB4B)

- prior Workers tolerate nullable deadline fields and the additive reminder table;
- disabling the new scheduler stops new reminder intent without deleting deadline data;
- stale reminder occurrences are version-suppressed after rollback/reschedule;
- restoring the prior web bundle may restore the card RAW count but does not corrupt deadline data.

### Editor-wide registry release (TB4C)

- a producer-ownership table identifies the one authoritative path per semantic event;
- disabling a registry producer does not remove already-created notifications;
- queued events keep their registry version and deterministic recipient rule;
- rollback restores one old producer at a time without dual-write ambiguity.

### Discussion cutover

- maintain an export/backfill verification report;
- keep old data read-only;
- be able to switch feature flag/read adapter back without losing new writes, or explicitly define a forward-only migration.

## 6. Verification layers

### Automated gate

From `portal/`:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

### Targeted tests

Each slice runs the narrowest changed suites during iteration, then the full gate.

### Manual local browser QA

Use the real local OAuth flow at `http://localhost:8787` after building the web app.

Verify:

- keyboard and pointer;
- phone width;
- collaboration panel width;
- direct URLs and Back/Forward;
- multiple project tabs;
- simulated external data change;
- failed requests;
- console/network errors;
- focus and draft retention.

### Production

No staging exists. Production checks are passive/read-only unless the human explicitly performs or authorizes mutation.

## 7. Visual regression approach

Before TB1 capture representative screenshots:

- dashboard list and Kanban;
- project workspace;
- project form;
- collaboration panel;
- notice board;
- notification bell;
- mobile/narrow states.

Compare each migrated slice against the baseline for brand, spacing, focus, overflow and typography.

## 8. Data freshness test matrix

- route A/B isolation;
- late response guard;
- focus/reconnect refresh;
- polling update;
- mutation invalidation;
- background hidden behavior;
- access removal;
- draft/drag/lightbox preservation;
- no duplicate current 5-second job polling.

## 9. Notification reliability matrix

- outbox and domain write atomicity;
- queue publish recovery;
- duplicate delivery;
- retry/DLQ;
- preference/access recheck;
- email failure;
- replay;
- observability.
- complete assigned-editor fan-out, the approved actor behavior and proof that unassigned admins are not implicitly included;
- editor removal/deactivation between event and delivery;
- versioned project deadline reminders at multiple offsets;
- reschedule/clear/past-offset suppression;
- timezone/DST and approved minute-level tolerance;
- bulk collection coalescing;
- mandatory in-app delivery includes every active assigned editor/actor;
- recipient/channel uniqueness and claim lease/token concurrency;
- provider-supported email idempotency or explicit ambiguous-delivery handling;
- per-event old/new producer ownership during cutover.

## 10. Kanban matrix

- pointer/touch/keyboard;
- empty columns;
- optimistic rollback;
- conflict;
- sort modes;
- refresh during/after drag;
- open link/new tab;
- large-board fixture.
- deadline metadata at desktop/narrow widths;
- card RAW count removed without altering non-Kanban count surfaces;
- deadline metadata preserved through TB5A/TB5B reorder, refresh and conflict paths.

## 11. Release documentation

For each bullet record:

- approved plan path;
- commit SHA;
- migrations/resources;
- approved editor-roster capability for TB4A; project-deadline timezone and scheduler cadence/SLO for TB4B; event-registry version and recipient/channel defaults for TB4C;
- deploy IDs/order;
- automated verification result;
- manual verification performed;
- known limitations;
- next checkpoint.

Update `docs/todo.md` only with what is actually planned/live. Move a plan to `implemented/` only after deployment and verification.

## 12. Stop conditions

Stop and revise the plan when:

- baseline tests are not understood;
- Tailwind/shadcn requires a React/toolchain upgrade not approved;
- global Preflight changes unrelated screens;
- query migration loses drafts or leaks cross-project data;
- common discussion model weakens access/audit rules;
- Queue delivery cannot be made idempotent;
- board conflict handling silently loses newer writes;
- migration cannot be rolled back or safely forward-fixed.
