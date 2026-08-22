# Migration, Rollback and Verification

**Status:** Program-wide guardrails  
**Applies to:** every tracer bullet

## 1. Principles

- Add before removing.
- One primary outcome and one clear ownership boundary per release.
- No indefinite dual write/style/query owner.
- Backfills are deterministic, resumable, and verified.
- Preserve old data until parity is proven.
- Prefer backward-compatible additive schema.
- A Worker rollback does not roll back D1/R2/Queue resources; plan forward compatibility.
- Production mutation is human-authorized. There is no staging environment.

## 2. Revised sequence and release boundaries

```text
TB0 → TB0A → TB0B → TB1 → TB2 → TB3 → TB4
                                     │
                                     └→ TB4A → TB4B → TB4C → TB5A → TB5B → TB6 → TB7 → TB8
```

Do not combine React, pipeline policy, and UI foundation into one deployment.

## 3. TB0A React 19.2

- No schema/resource changes.
- Pin latest stable `19.2.x` React/React DOM and compatible type packages exactly.
- Use reviewed official codemods; manually review every change.
- Keep StrictMode and modern JSX transform.
- Minimum supporting dependency updates only after a proven blocker.
- No new React feature/Compiler/SSR architecture.
- Record JS/CSS bundle deltas and React warnings.
- Deploy app Worker only.
- Roll back to previous app Worker version if acceptance fails.
- Focused before/after screenshots prove no intended visual change; accepted React build becomes TB1 baseline.

## 4. TB0B pipeline boundary

- Remove Admin Up/Down UI and ordinary self-service global Stage-order endpoint.
- Preserve Stage rows, display-order values, labels, and active flags.
- No D1 migration expected unless endpoint ownership requires an additive guard.
- Rollback restores prior app bundle/API but must be explicitly authorized because it reopens Admin self-service ordering.

## 5. UI/Tailwind/query releases

- Revert app bundle for rollback.
- Preserve legacy CSS/API until migrated component/query is verified.
- Do not delete selectors or old fetch paths until their last consumer is gone.
- Preflight remains disabled; enabling it is a separate whole-app decision.
- Feature flags/cohorts require a removal plan.

## 6. Membership/rail release (TB4A)

- Existing `project_members` remains source of truth.
- Prefer explicit role delta without schema change; add membership-cycle/version only if deterministic stale-remove protection cannot use row identity.
- Create Project remains intact.
- Edit Project team controls remain available behind a temporary rollback path until rail parity.
- Rollback hides/disables rail mutations without rewriting memberships.
- Last-role checklist cleanup is atomic and reported.

## 7. Deadline/reminder release (TB4B)

- Add nullable Deadline fields/version and occurrence table.
- Existing projects backfill to no Deadline/rules.
- Never reinterpret shoot or checklist due fields.
- Prior Worker tolerates additive schema where practical.
- Rollback disables scheduler/producer and leaves data.
- Schedule-version checks suppress stale occurrences after rollback/reschedule/clear/delivery/archive.
- Restoring a project/leaving delivered never silently resumes old rows.

## 8. Notification/outbox releases (TB4/TB4C)

- Domain state survives Queue/consumer failure.
- Pending outbox remains replayable.
- Old producer remains only for unrelated/unmigrated semantics.
- One producer-ownership record per semantic event.
- Unique recipient/channel delivery prevents duplicate in-app rows.
- `unknown` email is never auto-retried.
- Rollback disables new producer without deleting activity/outbox/inbox data.

## 9. Discussion/read-state migration (TB3/TB7)

TB3 uses adapter-first storage:

1. add server-owned read state;
2. deploy compatible API/query behavior;
3. verify current comments/mentions/pagination/access;
4. keep current comment tables authoritative.

TB7 proves a second consumer. A common storage migration, if later justified, follows additive/backfill/cohort/read-switch/write-switch/observe/read-only/remove-later discipline.

## 10. Stage/Kanban release (TB5A)

- Capture production-shaped current ordering before mutation.
- Store a verified pre-normalization export/rollback record.
- Normalize `boardPosition` once to current visible order.
- Deploy one command for rail/native board/non-drag movement.
- Preserve Deadline card metadata and absence of card RAW count.
- Rollback must not strand mixed old/new ordering semantics; either restore captured positions with old code or forward-fix under the new contract.
- TB5B does not start until this is accepted.

## 11. D1 migration care

- Recheck migration number against current `main`.
- Prefer additive `ALTER TABLE ADD COLUMN` for suitable single-column nullable checks.
- Do not trust local table-rebuild success against production foreign-key data.
- Update Drizzle schema, journal, and snapshot consistently.
- Test invalid raw values and production-shaped fixtures.
- Include backup/query/runbook steps.

## 12. Automated gate

From `portal/`:

```bash
npm run typecheck
npm run build -w @quincy/web
npm run test --workspaces
npx vitest run --config packages/shared/vitest.config.ts
```

Every slice runs targeted tests during iteration and the full gate before release.

## 13. Manual local QA

Use real local OAuth at `http://localhost:8787` after building web. Verify as applicable:

- sign-in, routing, Back/Forward, direct/new-tab links;
- Dashboard/Kanban/List;
- Project Workspace and left rail;
- Lightbox, media, rich text/mentions;
- Collaboration/checklist drag/popovers;
- notice board, notifications/preferences, Admin;
- keyboard, pointer, touch-equivalent, focus/Escape/return;
- desktop 1440×900, compact 1024×768, phone 390×844;
- failed/conflict requests;
- console/network warnings/errors;
- simulated external changes and draft preservation.

## 14. Production

Production checks are passive/read-only unless a human explicitly performs/authorizes mutation. Record Worker deploy IDs and verify changed surfaces load, render, route, and produce clean console/network results.

## 15. Required matrices

### React TB0A

- dependency/typecheck/build/full tests;
- mount/unmount/effect/ref/portal/generated ID behavior;
- StrictMode warnings;
- Tiptap/Floating UI/dnd-kit/Lightbox/LazyImage;
- render-error test assumptions;
- bundle delta and representative visual parity.

### Freshness

- route A/B and collection isolation;
- late response;
- focus/reconnect/poll/broadcast;
- narrow invalidation;
- access removal;
- draft/drag/Lightbox preservation;
- no duplicate special polling.

### Coordination

- eligibility, inactive users, dual roles;
- per-person optimistic/error/conflict;
- membership-cycle stale removal;
- last-role checklist cleanup;
- stage-hidden summary privacy;
- archived read-only.

### Deadline

- set/edit/clear/past/overdue;
- presets/custom limits/normalization;
- DST gap/fold;
- Due-now and versions;
- one-minute scan/two-minute target;
- recipient membership cycles;
- delivered/archive suppression;
- preference opt-out;
- Kanban due/no RAW.

### Stage/Kanban

- fixed semantic progression;
- confirmations and inactive escape;
- AutoHDR/delivered stage-only behavior;
- rail append/drag neighbour;
- normalization/priority/temp sorts;
- conflict/audit/activity/outbox;
- pointer/touch/keyboard/non-drag in TB5B;
- active-drag refresh and large fixture.

### Notifications

- domain/outbox atomic intent;
- Queue recovery, duplicate, retry, DLQ;
- `unknown` email;
- Admin replay/discard;
- targeted/broad suppression;
- actor/unassigned Admin/membership cycles;
- coalescing/privacy/producer ownership.

## 16. Release documentation

Record per bullet:

- approved implementation-plan path;
- commit SHA;
- schema/resources;
- exact approved contract/version;
- deploy IDs/order;
- automated and manual results;
- bundle/evidence where applicable;
- known limitations;
- rollback/next checkpoint.

Move a plan to `implemented/` only after it matches verified production.
