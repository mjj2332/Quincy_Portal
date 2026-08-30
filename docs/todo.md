# Quincy Portal — build tracker

Orchestration: Claude = planner/orchestrator/contract-layer; Codex/Agy = groundwork (see
`docs/Subagent-Orchestration.md`).

> **Compressed 2026-07-24.** Detailed historical narrative (bug mechanisms, review-round
> counts, full diagnostic transcripts) has been cut in favor of what/when/deploy-state. See
> `docs/lessons.md` for incident mechanics, and `docs/reviews/` for full QA-sweep detail.

## Current state (2026-07-24, batch status updated 2026-07-28, notification fix 2026-07-29, seed-admin UUID migration 2026-07-29, notification dismiss + stalled-guard 2026-07-30, download selection 2026-08-04, notice-board rich text + mentions 2026-08-17, project comments + collaboration panel 2026-08-17, project subtasks/checklist 2026-08-17, collaboration panel relocated to Project page 2026-08-17, collaboration panel UI fixes + due-time reminder 2026-08-17, notification click navigation 2026-08-17, comment ordering + Shift+Enter soft breaks 2026-08-17, mention-email content 2026-08-20, TB0 authority promotion 2026-08-24, TB0A React 19.2 deployed + accepted 2026-08-25, TB0B pipeline configuration boundary deployed 2026-08-24, TB1 Tailwind v4/shadcn foundation deployed 2026-08-25, TB2 route-safe project data freshness deployed 2026-08-25, TB3 project discussion v2 deployed 2026-08-25, TB4 notification outbox deployed 2026-08-26, confirmation modal + admin user impersonation deployed 2026-08-26, TB4A project workspace assignment rail deployed 2026-08-27, TB4B project deadline and reminders deployed 2026-08-27, TB4C editor-wide project-change notifications deployed 2026-08-27, TB4D checklist scheduling & ranges deployed 2026-08-28, TB4E external editor assigned-scope access deployed 2026-08-28, TB4E QA + cache-purge secrets done / phase fully closed 2026-08-28, TB5A Stage & Kanban Ordering Contract deployed to production 2026-08-29 — migration 0037 applied, tb5a_board_contract_enabled flipped ON, app 4ba551a3 / bg fa876454, TB5B Kanban Interaction Modernization (dnd-kit) deployed to production 2026-08-30 — UI-only, merge 578d2a1, app Worker 2b515484 only, no migration, rollback target app 4ba551a3, TB5C Production Calendar deployed to production 2026-08-31 — merge a7684d8, app Worker 2ba08078 only, no migration, rollback target app 2b515484)

- **TB4E (External Editor Assigned-Scope Access — a global `external_editor` role that does normal
  editing work only on explicitly assigned projects, sees external-safe data, discovers no
  unrelated projects) is deployed to production, 2026-08-28**
  (`docs/plans/implemented/Revamp-TB4E-External-Editor-Assigned-Scope-Access-Plan.md`, merge commit
  `b2efb17`, background Worker version `00baf29f-b70d-43fc-a12b-3949dc12def4`, webhook-ingress
  `f6037769-60a1-4bd2-8ddc-86efffe8503d`, app Worker version
  `18ff1c86-a827-41b7-9798-172c2ca17e0b`; rollback targets `e7133940-…` (background),
  `b8a1d549-…` (webhook-ingress), `65ad323b-…` (app) — TB4D's versions). Migration **`0036`**
  applied to prod D1 2026-08-28 06:57:57 UTC (3 additive columns `projects.production_notes` /
  `user.authorization_epoch` NOT NULL DEFAULT 0 / `notification_outbox.recipient_authorization_epoch`
  nullable; 2 tables `external_edited_upload_sessions` + `_parts` with multi-column CHECKs inside
  CREATE; 3 indexes; no role-column migration, no rebuild). Postflight: all 3 columns + 2 tables +
  3 indexes present, 12 users all `authorization_epoch=0`, 126 outbox rows all
  `recipient_authorization_epoch` NULL (fail-closed), FK check clean, quick_check ok. Pre-migration
  recovery export `../db-recovery/quincy-portal-before-tb4e-20260828T065731Z.sql`
  (sha256 `49086cbbf462770fa002a11da253e9533560675045d0fc2222ab619e30bed747`). **Ships
  enabled-but-dark — no `external_editor` account provisioned (acceptance bar met: 2 admin /
  8 editor / 2 photographer), no feature flag.** Passive prod verification: login screen renders,
  `/api/health` 200, all unauthenticated API returns 401 (session middleware + 0036 did not break
  auth), upload-session tables empty, no unexpected audit writes.
  Security/authorization/privacy tracer bullet. Adds: `external_editor` in `ROLES` + a 9-capability
  allow-list (no `viewAllProjects`); one server-side `visibleProjectWhere` every list/detail/
  child-resource endpoint routes through (generic 404/403 for unassigned/nonexistent; staff
  `viewAllProjects` still reach archived projects by id); an external-safe DTO matrix (explicit
  column selects, `.strict()` `@quincy/shared` schemas, `projects.production_notes` distinct from
  internal `notes`, `editing_autohdr → editing` stage neutralization); per-registry-type
  allowed|suppressed external notification policy scoped to `external_editor` recipients only
  (staff legacy delivery byte-identical to pre-TB4E); `user.authorization_epoch` + per-outbox stamp
  fencing role-transition races; opaque R2-binding multipart upload sessions (3-session cap as a
  serialized conditional insert, lease/expiry sweep); revocable transform signatures (principal +
  epoch, 120s TTL); an enforced route security manifest (integration probes hit every withheld +
  external-surface route with a real external session); winner-gated role-transition (atomic
  incompatible-membership `NOT EXISTS` + `DELETE FROM session`).
  Pre-provisioning follow-up **DONE 2026-08-28**: the background-Worker-only secrets
  `CLOUDFLARE_ZONE_ID` (`7e11e946205d0674ed3c7557019d440b`) + `CLOUDFLARE_CACHE_PURGE_TOKEN`
  (Zone·Cache Purge·Purge, scoped to `flamingfire.my`) are set on `quincy-portal-background` prod.
  First token was rolled after exposure. Setup guide: `docs/Cloudflare-Cache-Purge-Setup.md`.
  **TB4E is now fully closed** — provisioning the first `external_editor` account is a standalone
  Admin decision, nothing dev-side blocks it.
  Pipeline: Sol draft → fresh-Sol review ×2 (7B+3S then 4B) → Opus plan-tier revert 1/2 (3 Blocking:
  transform-bearer replay; upload proxy transport; unsatisfiable manifest) → fresh-Sol revision
  (bearer state machine ~84→19 lines; migration 0036 6→3 columns; transport → `env.MEDIA` R2
  multipart) → **Opus plan-tier re-review APPROVED** (9 Should-fix + 5 Nits into the build spec) →
  Luna build + **9 fix rounds** (rounds 1-3: SQL binding, epoch over-application, unwrapped
  terminal routes, `roleHasCapability` fail-closed; round 4: 5 Sol diff-review blockers —
  role-transition atomicity, exhaustive external copy, epoch-atomic admission, route-manifest
  contract, upload linearization; rounds 5-7: those regressed the TB4B deadline suite —
  `reminderAuthorization` NULL-safety, `channelAdmission` `EXISTS()` wrapper + outbox-id binding
  mode, post-send lease-only convergence, and the fix-4 SQL fences re-scoped to `external_editor`
  recipients only with `main`'s staff path restored; round 8: Opus final-draft 2 blockers
  (staff archived-project regression in `visibleProjectWhere`, expired-`open` upload-session
  lockout) + 5 bugs; round 9: Opus re-check nits — `/api/stages` reclassified `principal-global`,
  withheld probe `>= 400`, explicit `sql\`1=1\``, deleted dead `visibleProjectScopeSql`). Sol
  diff-review at medium effort was unusable (regurgitated the pre-fix blocker list); Opus carried
  the final review. ~8 Codex credit exhaustions across the plan + build pipeline.
  **Residual QA:** local mutating role-matrix QA (Agy, Option A, `http://localhost:8787`) **DONE
  2026-08-28** — all 33 checks PASS (Setup S1–S6, Matrix A/B/C/D), including the two Opus round-8
  blockers verified live (staff archived-project-by-id 200; upload-cap slot frees after abort).
  Agy's `agy --print` wrapper hung post-completion (it started `wrangler dev` itself → async
  shutdown hang, see `docs/subagents/agy-cli.md`); the report was recovered verbatim from the
  conversation DB and its D1 end-state independently re-verified. Human authenticated prod
  spot-check **waived by the user 2026-08-28** (passive verification already clean). Deferred Opus
  nits: F4 (hoist `isMissingMultipartUploadError` to `@quincy/shared`), F5 (bound the
  completing-session sweep alert).
- **TB4D (Checklist Scheduling & Ranges — every project checklist item carries one truthful
  optional schedule: unscheduled / due-only / start+end range, without changing the shipped
  `due_date` or its due-today reminder) is deployed to production, 2026-08-28**
  (`docs/plans/implemented/Revamp-TB4D-Checklist-Scheduling-Ranges-Plan.md`, merge commit `37c6219`
  + this documentation commit, background Worker version `e7133940-5c55-4faf-9db6-4c15394dcb39`,
  app Worker version `65ad323b-4ba5-4c19-8b9e-5e838a3562e6`, rollback targets `ea917b33-…`
  (background) / `aecde3a7-…` (app) — TB4C's versions). Migration **`0035`** applied to prod D1
  (11 nullable `project_subtasks` schedule columns + `schedule_version`, all bare
  `ALTER TABLE ADD COLUMN`, no rebuild/backfill; postflight: 11 cols, 19 rows all
  `schedule_version=0` + 0 with metadata, FK check clean, quick_check ok). Pre-migration recovery
  export `../db-recovery/quincy-portal-before-tb4d-20260827T194205Z.sql`
  (sha256 `a5476331dc000a87d01b3c342a1d8d8db0a0a0c50113106e2133780ee9c41a31`). Deployed
  `CHECKLIST_SCHEDULE_RANGES_ENABLED = true` directly (user chose direct write-enabled over the
  plan's 3-app inert rollout; the inert build is tested but not a deployed artifact — rollback is
  recovery-export + `git revert` + redeploy). `TB4D_SCHEDULE_ACTIVITY_CUTOVER_DATE` confirmed
  `2026-08-28` (Sydney deploy date) at deploy.
  Pipeline: Sol draft → fresh-Sol review ×2 (2B+6S then 1B+2S+1N) → Opus plan-tier revert 1/2
  (5B+6S+4N) → fresh-Sol revision → **Opus plan-tier re-review APPROVED** → Luna build + **5 fix
  rounds** (schedule-intent coalesce + create position + test isolation; legacy `dueDate` adapters
  as version-0 passthroughs; Sol diff-review 4B+4S — Sydney 1895-offset resolver bug, `resolution`
  provenance leaking into endpoint-change classification, inert gate not forcing activity-only,
  inherited TC4C cutover date, +web; Sol focused pass — S3 optimistic-concurrency regression where
  Save rebased the retained draft past a newer version + independent differential oracle + deletion
  race; Opus final-draft 3 pre-deploy should-fixes — schedule conflict draft cleared by unrelated
  PATCH, dead `resolveSydneyCivilMinuteExhaustive` in the public barrel, inert-gate test coverage)
  → **Opus final-draft review APPROVE FOR DEPLOY** → §5 gate green (typecheck; web build; workers/app
  242; workers/background 239 no regression; webhook 13; shared 82; db 54; web 417; `drizzle-kit
  generate` no-op). Adds a route-independent create-or-update task command owning POST+PATCH
  persistence with a non-throwing `invalid_request` arm (400/503) and one shared
  `finalizeProjectSubtaskCommandResult`; an O(1) Sydney civil-time resolver (≤6 `formatToParts`,
  bit-identical to the TB4B O(1681) scan across 1895/pre-1895 LMT/year 0999/9999) extracted to
  `packages/shared/src/sydney-civil-time.ts` with TB4B's `resolveSydneyCivilTime` kept as an alias;
  admission of `project.checklist.schedule_changed` (`reserved`→`live`, versioned source key with
  full project/item/version identity agreement, 5-min leading-edge `<projectId>:<itemId>:<actorId>`
  coalescing via TB4C's `coalesce_key`/`coalesce_until` outbox columns, broad email off); a
  five-state schedule DTO (`unscheduled | due_only | range | legacy_unresolved | invalid`, total
  fail-closed partition); the `CHECKLIST_SCHEDULE_RANGES_ENABLED` build-time rollback switch; and
  permanent POST + one-release PATCH raw-`dueDate` compatibility adapters that write only `due_date`
  (version 0, no metadata, no schedule activity). No new Cron; reminder scan unchanged (reads
  `due_date` directly, exempt from the serializer).
  **Follow-up:** the PATCH raw-`dueDate` adapter is a one-release sunset — remove it in the first
  reviewed app release after this deploy. `capability.ts` `active !== true` now gates every
  collaboration route (comments, read-markers), not just TB4D — a correct tightening, recorded.
  Opus final-draft nits deferred: `project-subtasks.ts:247` `canonicalSchedule = schedule!`
  restructure; vestigial `NormalizedChecklistSchedule.startChanged/endChanged`; post-commit reread
  failure throws before the finalizer (rows stay `pending`, outbox-recoverable — error shape only);
  `packages/shared/tsconfig.json` doesn't typecheck the new test suites.
- **TB4C (Editor-Wide Project-Change Notifications — one immutable safe activity event per
  approved semantic project change, delivered as one durable in-app broad alert per eligible
  active assigned Editor via TB4's outbox/Queue/ledger) is deployed to production, 2026-08-27**
  (`docs/plans/implemented/Revamp-TB4C-Editor-Wide-Project-Change-Notifications-Plan.md`, build
  commit `f857f3f` + this documentation commit, background Worker version
  `ea917b33-4ba8-4ee3-a713-ae31cc336484`, app Worker version
  `aecde3a7-c525-4836-8272-e2b4eef0ef29`, rollback targets `2668a652-dca8-4a24-a2c8-f0b712b8ff0f`
  (background) / `15b45ad1-620d-4c00-94e2-1b27484d29a0` (app) — TB4B's versions).
  Persists one immutable `project_activity_events` row per approved semantic operation (comment
  create/edit/delete, checklist create/update/delete, priority/board-position, video
  collection-link reorder, archive/restore, project details/services, initial-project roster,
  post-create membership add, collection-link create/delete, document-completion,
  manual-edited-ready, aggregate RAW reconciliation) — separate from `audit_log` and from
  `notifications`/`notification_outbox`. Delivers one **in-app-only** broad alert (event type
  `project.activity.broad`, no email ledger row ever) to every active event-time-eligible assigned
  Editor, resolving TB4A's exact `project_members.id` membership cycles (cycle began ≤ event
  occurrence, still exists at delivery, active + eligible) inside the marker-gated fan-out SQL, and
  re-checking the full exact-cycle predicate inside the guarded `pending → processing` admission —
  closing the delivery-time TOCTOU. Consumes TB4B's existing `ProjectDeadlineScheduleEventIntent`
  unchanged (no second Deadline producer). Fixed 5-minute leading-edge coalescing for
  same-comment/same-actor edits, scoped by `recipient_membership_cycle_id` + `coalesce_key` (so a
  remove/re-add editor cycle can't lose its first alert). A finite shared type registry in
  `@quincy/shared` owns per-type producer/source-key/safe-payload/deep-link/coalescing/email/
  cutover; `project.stage.changed`, checklist-schedule, and workflow-outcome types are registered
  but **reserved** (reject as producer intents until their owning tracer bullet). System-authored
  events use a fixed reserved sentinel for the non-null `notification_outbox.actor_id`, never
  joined to `user` or rendered. Every producer emits only on a semantic-mutation win, marker-gated,
  one summary per bulk op, with **equality-guarded no-op semantics** — a same-value HTTP retry or a
  concurrent racer does not double-emit (the `PATCH /projects/:id` service delta was refactored
  into one guarded all-or-nothing batch; priority/board-position and link-reorder winners guard on
  `(col IS NOT ?)` + a `changes()=1` marker; archive guards `archived_at IS NULL`). Admin ops view
  gains a "Project activity" label; broad events never create `preference_suppressed`/`sent`/
  `failed`/`unknown` email states. Additive migration `0034_project_activity_events.sql` — one new
  table (`typeof`/actor-kind-partition/`json_valid`/deep-link CHECKs, `UNIQUE(event_type,
  source_key)`), three bare `ALTER TABLE ADD COLUMN` on `notification_outbox`, one index; no table
  rebuild, no wrangler/Queue/Cron change.
  Plan review: Sol draft → 2 Sol review rounds (4 Blocking / 4 Should-fix → resolved → confirmed)
  → 2 Opus plan-tier rounds (structure + all 8 fixes confirmed sound vs landed code, 7 surgical
  revert items → all resolved → APPROVE, 7 implementation nits N1–N7 folded in). Build: Luna built
  it; the orchestrating session independently ran the Wrangler/Miniflare Worker suites Luna can't
  after every round. **6 §5-gate fix rounds** (a `PATCH /projects` SQL syntax error, a dropped
  `boardPosition` in the PATCH response, a subtask assignment-notice miscount, comment-producer
  atomicity + broad fan-out counts, a suppressed-broad outbox not terminalizing to `completed`,
  stale pre-TB4C test assertions). Fresh **Sol diff review**: 3 Blocking + 4 Should-fix, all one
  theme — producers guarded only on identity/stage instead of snapshot-fencing the complete
  canonical state in the winning mutation (fixed; one follow-on round when the first priority-fence
  fix over-corrected into a whole-board JSON optimistic-lock that 409'd everything). **Sol final
  focused pass**: 5/7 resolved, 2 partials (video tied-rebase still touched unchanged rows; the
  rollback test injected its failure before the activity/broad statements ran) → resolved. **Opus
  final-draft review**: NOT APPROVED but **"no production-code defect found" — test-only** —
  `failWholeOccurrence()` / the 5 bounded permanent codes had zero coverage, the delivery-time
  barrier only tested cycle removal (not deactivate/role-demote), the per-slot initial-roster
  suppression matrix was unproven; + 5 nits (checklist-delete 404→409 on a rename race, a dead
  `failureCode` arm, two missing plan-mandated assertions, the outbox `last_error_code` disagreeing
  between the two broad-suppress paths, `AGENTS.md` stale migration number). All resolved across 3
  further rounds, then Opus re-verified the deltas and **APPROVED FOR DEPLOY** with no production
  drift. Full verify green throughout and independently re-run at deploy: typecheck (6 workspaces),
  `apps/web` build, `apps/web` 412, `packages/db` 51, `packages/shared` 77, `workers/app` 230
  (229/1 skipped), `workers/background` 239, `webhook-ingress` 13; `drizzle-kit generate` no-op;
  migration 0034 independently applied to a scratch SQLite instance (clean apply, FK check empty,
  `quick_check` ok, query plans use their intended indexes).
  Production: rollback targets/preflight recorded, pre-migration remote D1 recovery export saved to
  `../db-recovery/quincy-portal-before-tb4c-20260827T110021Z.sql` (13.4 MB, sha256
  `3b88d6a27a172c2136f13f8958fa5e47a907a48ff22bfd840a10e7efa69bb003`); remote `d1_migrations` tail
  confirmed `0033` before apply; `0034` applied cleanly; postflight confirmed the new table (15
  cols) + 3 nullable outbox columns + index, FK check empty, `quick_check` ok, all 9 existing
  outbox rows `coalesce_key IS NULL` (no backfill), 0 activity rows. Deploy order `background → app`
  (webhook-ingress unchanged, not redeployed). Post-deploy: every-minute cron clean over ~25 min
  (`Project Deadline occurrence scan {scanned:0,fired:0,published:0}` + `Notification outbox
  recovery scan {recovered:0}` — the recovery scan now runs through the extended consumer that
  recognizes `project.activity.broad`, zero exceptions), `notification_outbox` 9 rows all
  `completed` / 0 DLQ/failed, endpoints gated (401, not 5xx).
  **Local mutating QA matrix** run against `http://localhost:8787` (TB4C code + migration 0034
  applied locally) by **Agy** (`gemini-3.7-flash-high`) driving Chrome via the `chrome-devtools-mcp`
  MCP server (Option A, human-authenticated dedicated profile) — the first QA task delegated to Agy
  instead of Luna, run as a capability trial. All 9 checks PASS, each independently re-verified by
  the orchestrating session against local D1: one activity row per semantic op with correct
  event_type/category (no row for a pure Kanban reorder); broad fan-out writes one
  `project.activity.broad` outbox row per eligible editor cycle with **zero** email ledger rows;
  comment-edit coalescing (create → broad, first edit → broad with `coalesce_key`, second rapid
  edit → activity row but **0** broad); priority no-op (two identical POSTs → `200`/`200`, exactly
  1 audit + 1 activity); unchanged Edit-Project save → `200` (not 409), no new activity; archive →
  `project.archived`, repeat-archive → no-op no new row, restore → `project.restored`; Admin ops
  "Project activity" label + all filters load + no payload/email/cycle-id leak; bell/Kanban/rail
  render clean, no console errors; broad outbox payload contains only `schemaVersion`/`event`/
  `authorizationAtOccurrence`/`activity` (id+projectId). Agy's report was accurate under
  independent D1 verification — no fabrication, cleanup performed, stayed on localhost, no direct
  D1 writes. **Residual QA gap** (tracked below): the fire → outbox → in-app-notification →
  bell **delivery** half is not locally exercisable (no local background Worker; covered by the
  `workers/background` automated suite, 239 tests), and no authenticated *production* render check
  (rail/bell/Admin) was performed — Agy has no production danger/YOLO sanction and the passive
  production checks above stayed unauthenticated.

- **TB4B (Project Deadline, Reminders and Kanban Due Metadata — one nullable versioned
  Sydney-civil project Deadline with bounded advance reminders, delivered through TB4's durable
  outbox as a third event type) is deployed to production, 2026-08-27**
  (`docs/plans/implemented/Revamp-TB4B-Project-Deadline-And-Reminders-Plan.md`, build commit
  `dba2e40` + this documentation commit, background Worker version
  `2668a652-dca8-4a24-a2c8-f0b712b8ff0f`, app Worker version
  `15b45ad1-620d-4c00-94e2-1b27484d29a0`, rollback targets `c236a205-ab55-4ac6-8a04-97e2a867bd12`
  (background) / `8af4bcf9-903e-4d3b-9979-eab34e4f70dc` (app) — TB4A's versions).
  Adds one nullable, versioned project Deadline (civil `YYYY-MM-DDTHH:mm` + IANA zone + resolved
  UTC offset + fold + UTC instant + `deadline_version`) independent of Shoot and checklist dates,
  a shared DST-aware Sydney civil-time resolver in `@quincy/shared` (gap → `400
  deadline_nonexistent_local_time`, repeated → `400 deadline_repeated_local_time` with
  Earlier/Later choices; advance offsets are absolute-duration subtractions, so a "1 day" reminder
  can land at a different Sydney wall-clock hour across a DST transition), and one combined
  set/edit/clear/resume domain command (`PUT /api/projects/:id/deadline`) authorized by
  `editProject` with optimistic version-conflict handling (`409 deadline_version_conflict`, draft
  retained, explicit review/reapply — no silent overwrite). The versioned save uses a guarded
  project update → adjacent `changes()=1` audit marker → marker-gated occurrence/delivery writes,
  so a concurrent different-schedule loser leaves zero downstream footprint. Materialized
  `project_deadline_occurrences` history (presets 1 day / 4 hours / 1 hour, custom 1 min–30 days,
  ≤8 advance offsets, implicit mandatory Due-now; elapsed advances at save → terminal
  `skipped/elapsed_at_save`; a structural `CHECK (fire_at = deadline_at - offset*60000)`),
  scanned every minute by a new background Cron trigger `* * * * *` (added beside the retained
  `0 * * * *`; the scheduled handler now branches on `controller.cron` and wraps every individual
  job — minute and hourly — in its own `try/catch`). The fire batch mirrors the save pattern:
  guarded occurrence claim → adjacent `changes()=1` fire-audit marker → marker-gated
  outbox/ledger fan-out that resolves eligible active `editor` membership cycles (exact
  `project_members.id`, `created_at <= fired_at`, active + `isProjectAssignmentEligible`) inside
  the SQL, with same-batch lazy terminalization of guard-stale due rows. Delivery reuses TB4's
  event-dispatched consumer unchanged — a third `project.deadline.reminder` branch in
  `resolveRecipient()` plus an atomic per-channel authorization/admission batch that re-evaluates
  membership/account/preference inside the guarded `pending → processing` transition; an admitted
  email is never retroactively reclassified. Archive suppression is atomic in the archive D1
  batch (`superseded/project_archived`); Delivered-entry suppression is a best-effort
  own-result-gated post-success hook (`superseded/project_delivered`) backstopped by scan-time
  lazy terminalization, with explicit Resume required after leave/restore. Adds personal
  Notification Preferences (`/settings/notifications`, self-only `GET`/`PATCH
  /api/notification-preferences`, one default-on "Project deadline reminder emails" toggle;
  in-app always mandatory), a read-only Admin `preference_suppressed` delivery-ops view, and
  Kanban Deadline/overdue card metadata replacing the card-level RAW count (List row RAW count
  untouched). Migration `0033_project_deadline_and_reminders.sql` — strictly additive: 7 bare
  `ALTER TABLE ADD COLUMN` on `projects` (6 nullable + `deadline_version NOT NULL DEFAULT 0`),
  new `project_deadline_occurrences` + `notification_preferences` tables, one
  `notification_outbox` index — no table rebuild (avoids the migration-0020 D1 failure mode).
  Constructs one typed `ProjectDeadlineScheduleEventIntent` (`project.deadline.schedule_changed`)
  per state-changing save but does not persist/deliver broad activity — TB4C owns that seam.
  Plan review: 2 Sol rounds + fix passes, 2 Opus plan-tier reverts + fix passes, Opus final
  approval. Build: Luna built it; independent verification outside Luna's sandbox after every
  round (Luna cannot run the Wrangler/Miniflare Worker suites at all). Real defects found and
  fixed: a version-conflict transaction with no atomic winner marker; a delivery-suppression race
  that could falsify an already-admitted email's outcome; Delivered-transition suppression
  originally specified against a D1 batch that doesn't exist in the real Stage-transition code
  (resolved as an explicit best-effort hook + lazy scan-time backstop, distinct from archive's
  genuinely atomic suppression); a rollback plan that didn't account for the new Cron trigger
  being a Worker script-level setting rather than something carried inside a Worker version; three
  new request-owned audit writes that dropped admin-impersonation provenance; a destructive
  "Reload latest" conflict-resolution control; an arithmetically wrong DST test fixture caught on
  the final review pass. Four Codex-credit-exhaustion interruptions mid-review, each resumed
  cleanly. Full verify sequence green throughout and independently re-run at deploy: typecheck (6
  workspaces), `apps/web` build, `apps/web` 412 tests, `workers/app` 220 tests/1 skipped,
  `workers/background` 231 tests, `packages/db` 44 tests, `packages/shared` 68 tests,
  `webhook-ingress` 13 tests (unaffected, not redeployed) — 989 total. Migration proof: applied to
  an isolated scratch SQLite instance outside any test framework — clean apply, `PRAGMA
  foreign_key_check` empty, `PRAGMA quick_check` ok, the structural `fire_at` CHECK correctly
  rejects a bad value, and all three real query shapes confirmed via `EXPLAIN QUERY PLAN` to use
  their intended covering indexes. Production: rollback targets/preflight recorded, pre-migration
  remote D1 recovery export saved to `../db-recovery/quincy-portal-before-tb4b-20260827T033801Z.sql`
  (13.3 MB, sha256 `3036281e25c0e9399a7f451cdda42f5b3594277ab9b748767012c5fe814e2696`); remote
  `d1_migrations` tail confirmed `0032` before apply; `0033` applied cleanly; postflight confirmed
  7 columns + 2 tables + index, FK check empty, quick_check ok, all 73 existing projects
  unset/version 0 with no backfill, 0 occurrence/preference rows. Deploy order `background → app`
  (webhook-ingress unchanged, not redeployed). Cron monitored via `wrangler tail` for ~20 min: 19
  consecutive every-minute ticks + the 04:00 UTC hourly boundary all `ok`, zero exceptions —
  minute trigger ran only `scanProjectDeadlineOccurrences` + `recoverNotificationOutbox` (both
  `0`), hourly trigger ran only its 4 jobs; `notification_outbox` stayed 9 rows all `completed`,
  0 DLQ, so the new every-minute `recoverNotificationOutbox()` cadence isn't disturbing live
  mention/assignment traffic. Passive production verification (this session's Browser pane +
  Luna danger-mode, zero mutations confirmed via 0 audit_log rows in the window + impersonation
  flag still OFF): dashboard clean, Kanban card RAW count removed / List RAW count retained /
  priority+drag intact, rail renders the new single Deadline control (`Not set` / `Next reminder
  None` / `Set Deadline` for Admin), `/settings/notifications` renders the exact toggle
  (desktop + mobile surfaces) with `GET /api/notification-preferences` → 200, Admin `Preference
  suppressed (0)` filter present and safe, bell opens. Local mutating QA against
  `http://localhost:8787` (Luna items 1–6 + this session driving the Browser pane for items
  7–13, after a human sign-in): DST matrix incl. the exact `2026-10-04T09:00` Sydney fixture
  (advance `fire_at` = `2026-10-02T22:00:00.000Z`, offset +660 → displayed +600) verified to the
  millisecond; set/presets/edit/clear with correct terminal reasons and retained history;
  version-conflict 409 with zero occurrence/audit/outbox footprint; Delivered → `409
  deadline_project_delivered` + rail hides controls; leave Delivered → synchronous
  `superseded/project_delivered` + "Reminders inactive" + explicit Resume (no auto-resume);
  Resume → new version + fresh pending occurrences; archive → atomic `superseded/project_archived`
  in the archive batch + `409 deadline_project_archived`; read-only rail — impersonated
  photographer `PUT /deadline` → `403 editProject` (refused server-side) while `GET` still
  returns the schedule; Kanban future/overdue/unset card labels correct. **Residual QA gap**
  (tracked below): the fire → outbox → in-app/email delivery half is not locally exercisable (no
  local background Worker; covered by the `workers/background` automated suite), and a full
  keyboard-only accessibility sweep of the editor/preferences/conflict flow was not completed
  live.

- **TB4A (Project Workspace Assignment Rail — role-scoped photographer/editor membership
  routes replacing full-roster project PATCH) is deployed to production, 2026-08-27**
  (`docs/plans/implemented/Revamp-TB4A-Project-Workspace-Assignment-Rail-Plan.md`, commit
  `15f28ef`, background Worker version `c236a205-ab55-4ac6-8a04-97e2a867bd12`, app Worker version
  `8af4bcf9-903e-4d3b-9979-eab34e4f70dc`, rollback targets `ac7c4753-0b48-4951-87c0-382b18714195`
  (background) / `58fe2088-605a-46ca-a5e8-67e196715058` (app)). Replaces the old full-roster
  `PATCH /projects/:id` membership write with explicit `PUT/DELETE
  /projects/:id/photographers|editors/:userId` routes: idempotent add via guarded
  `INSERT...RETURNING` (never a post-batch reload), exact membership-cycle DELETE with 409 on
  staleness and a server-verified `confirmedAssignmentCount` precondition for final-role
  checklist cleanup, and an atomic all-or-nothing Create batch. Targeted assignment notifications
  cut over from the retired direct `notifyProjectAssignments()` helper onto TB4's durable D1
  outbox/Queue/delivery-ledger as a new `project.assignment.created` event, reusing
  `resolveRecipient`/`releaseBeforeRetry`/`completeIfTerminal` unchanged so all TB4 mention-path
  tests stayed green. Reorganizes the Project Overview rail into
  header → Production (Stage read-only, Shoot, honest Deadline/reminder placeholders for TB4B) →
  Team (Photographers and Editors, both now rendered — Editors were previously absent from the
  rail) → Client → Collections/Dropbox, with an optimistic per-person picker and a
  mutation-token ledger so concurrent add/remove operations for different people commute without
  clobbering each other's pending state. Adds a new presentation-safe `GET
  /projects/:id/collaboration-summary` endpoint for Stage-hidden collaborators, reusing the real
  `purgeProjectCommentData()`-style generation-bump fence on access loss. No schema migration —
  reuses `project_members.id` as the membership cycle and TB4's existing outbox/ledger schema
  for the new event type; migration tail remains `0032`.
  Plan review: 2 Sol rounds + fix passes, 1 Opus plan-tier revert + fix pass → APPROVE. Build:
  Luna built it; independent verification outside Luna's sandbox (which cannot run the
  Wrangler/Miniflare-backed Worker integration suites) caught and fixed 5 test-authoring bugs in
  Luna's own new/updated tests (an eligibility-mismatched dual-role fixture, a wrong expected
  HTTP status, a stale test still driving the now-roster-free `PATCH` route, a query against a
  `notifications.link` column that has never existed in the schema, and a `LIKE` pattern
  exceeding D1/SQLite's default 50-byte pattern-length limit) — all confirmed to be test bugs, not
  implementation defects, by direct inspection of the real schema/source. Diff review: a fresh Sol
  pass found and a fix round closed a real privacy leak (the optimistic membership-mutation
  ledger was pushing full member email/global-role data into the collaboration-summary cache via
  two separate code paths — one write-side, one read-side, the second caught independently after
  Luna's first fix only closed the write side) plus incomplete high-risk test coverage. A second
  Sol focused pass then caught a real UI regression — the final-role-removal confirmation dialog
  was skipping the mandatory unconfirmed server probe and using a client-cached assignment count,
  reintroducing exactly the bug class two earlier *plan*-review rounds had hardened against — and
  more coverage gaps; both were fixed, independently re-verified line-by-line. Opus final-draft
  review then found two further real issues nothing had caught: a dependency-array bug making the
  project checklist reload and collapse to a loading state on every keystroke in the comment
  composer (`onAccessFailure` was a fresh closure every render; fixed with the existing
  ref-callback pattern from `ProjectWorkspace.tsx`), and a "compatibility Edit-page" rollout
  control gated by a feature flag that existed nowhere but the one line reading it and that
  couldn't reflect its own mutations even if enabled — resolved by removing the inert
  compatibility stage entirely in favor of a single canonical deployment (Edit Project no longer
  renders any team control; the rail is the sole owner from the start). One Codex-workspace
  credits interruption mid-fix-round left a partially-applied diff with a missing regression test;
  every landed code change was independently verified correct directly against source before the
  missing test (checklist-reload regression coverage) was added directly. Full verify sequence
  green throughout every round: typecheck (6 workspaces), `apps/web` build, `apps/web` 288 tests,
  `workers/app` 210 tests/1 skipped, `workers/background` 207 tests, `packages/db` 42 tests,
  `packages/shared` 62 tests, `webhook-ingress` 13 tests (unaffected, not redeployed). Two
  accepted, Opus-agreed test-coverage limitations remain undocumented in automated tests but are
  low-risk and structural: a jsdom DOM test cannot prove a CSS `@media` bottom-sheet rule actually
  engages (no `matchMedia`/layout engine; covered instead by live production passive verification
  below), and a candidate-ordering ID tie-break is unreachable in any real integration test
  because `(name, email)` is already a total order under the real `user.email` UNIQUE constraint.
  Production: rollback targets recorded above, deploy order `background → app` (webhook-ingress
  skipped, unchanged), passive smoke performed directly in this session's Browser pane against
  real production data — dashboard/project list loaded clean, a real project's rail rendered the
  new Production/Team sections correctly (Deadline/reminder placeholders, a real Photographer
  membership with working display, Editors correctly "Not assigned"), both new endpoints
  (`GET /project-assignment-candidates`, `GET /projects/:id/collaboration-summary`) returned 200
  against real data, `notification_outbox` confirmed healthy post-deploy (existing mention rows
  still `completed`, no stuck/errored rows), zero console/network errors throughout. No mutating
  membership walkthrough was performed against production, per
  `docs/Subagent-Orchestration.md` §2.9 — local mutating QA against `http://localhost:8787` per
  the plan's manual QA matrix remains outstanding follow-up, tracked below.

- **TB4 (notification outbox and Cloudflare Queues — durable delivery for project-comment
  mentions only) is deployed to production, 2026-08-26**
  (`docs/plans/implemented/Revamp-TB4-Notification-Outbox-And-Queues-Plan.md`, commits `0b90439`
  build+review, `f04e6e9` merged flaky-test fix, `ea68916` manual QA, `cd393bd` production smoke;
  background Worker version `ac7c4753-0b48-4951-87c0-382b18714195`, app Worker version
  `2fb292aa-f042-4982-96f9-1b64991922cf`, rollback targets `8f6dfce5-9efa-4681-91cf-274a2d14fcc5`
  (background) / `e6d0879d-b739-46ea-be2c-9f772bec9a66` (app)). This pipeline's first Cloudflare-
  Queue-based infrastructure (`quincy-notifications` + `quincy-notifications-dlq`) and second
  live-production schema migration (`0031_notification_outbox_and_delivery_ledger`, additive-only,
  two new tables + indexes). Plan review: 2 Sol rounds (2 findings round 1, 5 more round 2) + Opus
  tier-2 edit to resolve all 5 (unifying email-status invariant, in-app retry-release fix,
  quota-retry pacing fence, missing FK index) → APPROVE. Build review: a corrective pass fixed
  Luna's overstated test-coverage claim by adding real Miniflare integration tests; independent
  verification then found and fixed a real bug neither review round had caught —
  `deleteProjectComment` threw a false "could not be deleted" error and skipped its audit entry for
  any comment with mentions, because `ON DELETE CASCADE` inflates D1's JS-level `.meta.changes`
  (not the separate SQL-level `changes()` function — confirmed empirically). Diff review: 2 Sol
  rounds (9 findings round 1 — stale-consumer ownership-fencing gaps in the delivery consumer, an
  Admin replay/discard race that could return 200 on both sides — plus 5 more round 2, most
  seriously a selective-replay path that left the outbox stuck in `processing` forever) + Opus
  final-draft review (APPROVE, 4 cosmetic Low findings, one fixed). Manual QA (Chrome work routed
  to Luna) passed all 11 matrix items — two of Luna's own findings were independently re-verified
  rather than taken at face value: a "transient 500" traced to unrelated, already-documented local
  `wrangler dev`/D1 flakiness, not TB4 code; an "unresolved" native replay-confirmation gap is a
  `window.confirm()` browser-automation limitation (same class as TB3's accepted device/visibility
  gaps), fully covered by route-level tests. A real admin-email leak in two QA screenshots was
  caught and cropped before commit. Production: rollback targets/preflight/recovery export
  recorded, 0031 applied cleanly, both Queues created, background-then-app deploy, authenticated
  smoke test (comment creation done by the human operator after an agent-driven mutation hit a
  confirmation-gate block; verification/cleanup agent-driven) confirmed outbox/ledger/bell/Admin/
  audit all correct with a clean console. Full review-and-fix history:
  `docs/plans/revamp_2026_portal/evidence/TB4/review-and-fix-cycle.txt`.
- **In-app confirmation modal + admin user impersonation is deployed to production, 2026-08-26**
  (`docs/plans/implemented/Confirmation-Modal-And-Admin-Impersonation-Plan.md`, commits `f2d3700`
  build, `3b9632a`/`de17a59` two diff-review fix passes, `320959b` Opus final-draft fix pass, app
  Worker version `58fe2088-605a-46ca-a5e8-67e196715058`, rollback target
  `2fb292aa-f042-4982-96f9-1b64991922cf`). Ad hoc dev-tooling work (not a numbered TB tracer
  bullet), motivated by repeated automation friction this pipeline hit testing native
  `window.confirm()` dialogs. Replaces all 16 `window.confirm()` call sites with a real-DOM,
  automation-testable confirmation modal (promise-based singleton, focus-trapped portal via
  `@floating-ui/react`, stable `data-testid` selectors), and wires up better-auth's official
  admin-impersonation plugin (installed but previously unconfigured) behind a runtime D1 toggle so
  an Admin can act as a real Photographer/Editor for testing — never another Admin, never a client
  (clients aren't user accounts). Deliberately, explicitly bypasses the annotation/notice-board/
  project-comment author-only invariant while impersonating (see the caveat added to `CLAUDE.md`/
  `AGENTS.md`'s author-only gotcha) and has no automatic session-recovery path if the original or
  target session is invalidated out-of-band — both are accepted, bounded, toggle-gated tradeoffs
  the user chose explicitly after seeing the alternative (a more complex auto-recovery subsystem
  coupled to better-auth's private cookie internals) and rejecting it. Migration `0032` added
  better-auth's plugin-compatibility columns plus the additive `feature_flags` table (seeded OFF).
  Plan review: 2 Sol rounds (6 findings round 1, 5 more round 2) + 3 Opus rounds (2 High/4
  Medium/4 Low round 1 — most seriously an unenforced original-session-liveness check and a
  target-promotion-to-Admin gap — then a user-directed simplification dropping an over-engineered
  auto-recovery subsystem in favor of the accepted manual fallback, then 2 more Medium/2 Low round
  2) → APPROVE. Build: Luna built it; independent verification (outside Luna's sandbox, which
  can't run the worker-app test suite at all) found and fixed 3 pre-existing test-authoring bugs in
  the impersonation integration suite — all confirmed to be test bugs, not implementation defects,
  by reading the actual better-auth internals directly. Diff review: 2 Sol rounds (2 Medium/3 Low
  round 1 — a failed-Exit message that could cover the topbar's Sign-out control, materially
  incomplete security-test coverage — then a test-isolation leak and an unfalsifiable focus-trap
  assertion found round 2, the latter replaced with an honest comment instead of a test that
  couldn't actually fail) + Opus final-draft review (APPROVE, 4 Low findings fixed, including a
  real Hono trailing-slash gate-bypass gap — not exploitable given the plugin's own permission
  check and session-hook revalidation, but hardened anyway). Production: rollback target/preflight/
  recovery export recorded, 0032 applied cleanly, app-only deploy (background/webhook-ingress
  unchanged), authenticated smoke test performed live by the human operator in the Claude Browser
  pane (flag toggle, Act-as, banner, identity switch, Exit-restore, and the full audit trail all
  verified directly against production D1) — no client project data touched, since the disposable
  QA test account has zero project memberships. Flag disabled after the smoke window, zero live
  impersonated sessions confirmed remaining.
- **TB3 (project discussion v2 — TanStack Query freshness for project comments plus a new
  per-user server-owned read-marker table) is deployed to production, 2026-08-25**
  (`docs/plans/implemented/Revamp-TB3-Project-Discussion-V2-Plan.md`, commits `08f56f4` code/tests +
  `2cba9a1` composer-clear fix + `9dab8da`/`28d3063` manual QA evidence, production Worker version
  `e6d0879d-b739-46ea-be2c-9f772bec9a66`, rollback target `4a4c61a2-a59f-4c8a-ab99-0ceeb690485e`).
  This pipeline's first live-production schema migration (`0030_project_comment_read_markers`,
  additive-only `CREATE TABLE`, applied cleanly with a verified recovery export beforehand). Plan
  review: 2 Sol rounds (8 findings) + 1 Opus tier-2 revert (8 more, most seriously an undefined
  read-advancement proof-delivery channel and a deleted-comment marker/allocator gap — fixed with a
  three-way `MAX()` allocator and a composite covering index), then Opus APPROVE verified by
  actually executing the migration SQL/cascades/index plans in SQLite. Build review: 2 Sol diff
  rounds (10 findings — most seriously a collaboration-only access-loss branch that fell through to
  mounting unauthorized full-workspace reads, and an unfenced concurrent read-marker drain able to
  resurrect purged cache) + 1 Opus final-draft round (APPROVE, no material defect). Manual QA (real
  local dev server, real browser) found one genuine bug automated tests couldn't reach: the comment/
  edit composer silently kept its stale text after a successful submit, caused by Tiptap dispatching
  a no-op transaction (traced to `editor.setEditable()` toggling during the mutation's `saving`
  state) that the old `onUpdate` handler propagated unconditionally — root-caused live via temporary
  console instrumentation, fixed by comparing against the last committed document instead of
  Tiptap's `transaction.docChanged` flag (environment-dependent between real Chrome and the DOM test
  harness), independently Sol-reviewed clean. Two apparent QA failures turned out to be QA-execution
  artifacts, not product bugs (a tab not kept foregrounded before measuring poll convergence; a
  marker timestamp predating the hidden window it was accused of violating). Items 4 (two-device)
  and 6 (out-of-view gate) hit a shared tooling limit: this session's Browser-pane tabs never report
  `document.visibilityState` as `"visible"`, so the client-driven visible-read gate can't be forced
  live here — the reviewed automated DOM suite (full control over mocked visibility/focus/
  intersection state) is the operative coverage for that mechanism. Production smoke (authenticated,
  real admin session, one disposable clearly-labeled test project, archived afterward) exercised the
  full create→edit→delete cycle with zero errors, directly confirming the composer-clear fix live in
  production. `docs/lessons.md` gained two entries: the `RichTextEditor` no-op-transaction bug, and
  a pre-existing local `wrangler dev` stability issue (crashes intermittently under sustained
  request load, reproduces on `main`, D1 state persists correctly across restarts).
- **TB2 (route-safe project data freshness, TanStack Query for Project Workspace detail + active
  collection assets) is deployed to production, 2026-08-25** (`docs/plans/implemented/
  Revamp-TB2-Route-Safe-Data-Freshness-Plan.md`, commits `155b957` code/tests + `cb6f1e1` manual QA
  evidence, production Worker version `4a4c61a2-a59f-4c8a-ab99-0ceeb690485e`, rollback target
  `a55375f5-2b92-4eb2-860f-541f3ec212b5`). The highest-stakes phase built in this pipeline: 2 Sol
  plan rounds + 2 Opus tier-2 plan rounds (11 real issues found and fixed, including a
  role-downgrade cache-leak privacy gap and a reachable Sync-from-Dropbox self-purge bug), then 2
  Sol diff-review rounds + 2 Opus final-draft rounds on the build (14 more real issues found and
  fixed, most seriously a special-owner ownership bug that would have permanently frozen detail/
  Edited freshness for any Admin viewing a project in `raw_review`/`editing_autohdr` with no active
  AutoHDR handoff — the normal case post-PR#44 — plus a UI regression where RAW/Edited tab switches
  silently discarded unsent comment drafts). Manual QA covered all 12 matrix items: 1–9 and 12 via
  danger-mode local testing (real network-throttled race capture, multi-tab timing); 10 (access
  removal, both membership-removal and full-deactivation) via a genuine second authorized session —
  the owner signed a disposable QA account into a real, separate Chrome browser, and the
  orchestrating session live-drove the admin-side revocation while observing that account's own tab
  react correctly in real time; item 11 recorded as not attempted live, by owner judgment, backed
  by existing automated + code-review coverage. Passive production smoke (real client data)
  confirmed the core mechanism — initial load, hidden-tab pause, focus/reconnect refetch, exact-
  resource scoping — working correctly live, zero regressions.
- **TB1 (Tailwind v4 + shadcn/Base UI foundation, first consumer: `ProjectFields`'s Client section)
  is deployed to production, 2026-08-25** (`docs/plans/implemented/
  Revamp-TB1-Tailwind-Shadcn-Foundation-Plan.md`, commit `00e2bd3`, production Worker version
  `a55375f5-2b92-4eb2-860f-541f3ec212b5`, rollback target `02fe617d-d83d-4e96-889c-0ce23e71f941`).
  Converts Agency/Agent/Agent email/Agent phone (Create and Edit) to source-owned shadcn/Base UI
  primitives on a pinned Tailwind v4 CSS-first setup, no Preflight, matched to the existing Quincy
  visual system — no other form/screen changed. Went through 2 Sol plan rounds, 2 Opus tier-2 plan
  rounds, 2 Sol diff-review rounds (4 real issues fixed, including a legacy `.grid` CSS name
  collision that silently broke the responsive layout), and 3 Opus final-draft/evidence rounds
  (a `FieldGroup` double-display-utility fragility fixed; the full 18-screenshot + 5-document
  evidence package captured; a false-positive "email/tel values don't retain" finding independently
  reproduced-and-refuted by the orchestrating session via direct DOM/network verification, traced
  to its root cause in Base UI's `Field.Root`-less code path — see `docs/lessons.md`'s new entry
  for the non-blocking latent risk this surfaced for future `Field.Root` consumers). Passive
  production smoke against real client data found zero regressions.
- **TB0B (developer-managed pipeline-order boundary) is deployed to production, 2026-08-24**
  (`docs/plans/implemented/Revamp-TB0B-Pipeline-Configuration-Boundary-Plan.md`, commits `05f52d8`
  code/tests + `7b1a2ce` the A4 authority-file edit, production Worker version
  `02fe617d-d83d-4e96-889c-0ce23e71f941`, rollback target `202d4cd5-c6ec-4f98-8cd2-e7fb2b0d0d60`).
  Removed the Admin UI's Up/Down stage-reorder controls and deleted the
  `POST /admin/stages/:key/move` route entirely (falls through to the existing terminal 404, no
  stub). `GET /admin/stages` and `PATCH /admin/stages/:key` (label/active only) are untouched.
  Went through 2 Sol review rounds, an Opus plan review, a fresh Sol diff review (CLEAN) and an
  Opus final-draft review (APPROVE), independent local QA (label edit, both activation directions,
  direct move-URL 404, D1 order-query unchanged), and a passive production smoke (404 confirmed,
  order query identical before/after, zero console errors — live label/activation mutation testing
  deliberately skipped as a documented risk decision since that code path is byte-for-byte
  unchanged and already covered locally). TB0B is now live, unblocking TB1.

- **TB0A (React 19.2 compatibility-only runtime upgrade) is deployed to production and accepted,
  2026-08-25** (`docs/plans/implemented/Revamp-TB0A-React-19-2-Runtime-Upgrade-Plan.md`, commits
  `fef61f5` prerequisite R2 fix + `eb76732` the upgrade itself, production Worker version
  `202d4cd5-c6ec-4f98-8cd2-e7fb2b0d0d60`, rollback target `84ca29ba-c2fb-4e65-8a2a-880bb2e8e5ea`).
  Went through 2 Sol review rounds, an Opus final-draft review (which caught a real
  component-attribution error in the manual verification record and required recording an explicit
  release exception rather than silently deferring Lightbox/rendition checks), and a passive
  production smoke with zero regressions found. Found and fixed a genuine, unrelated local-dev bug
  along the way: `.dev.vars` missing `APP_ENV=dev` let local uploads presign against production R2
  while completion checked local R2, producing TB0's own recorded "Uploaded object was not found in
  R2" failure — see `docs/lessons.md`. One reproduction during that diagnosis reached real
  production R2 before the fix landed, leaving a harmless orphaned test object (key/timestamp
  recorded in the TB0A plan); the exposed R2 S3 credentials were blanked from local `.dev.vars` but
  **still need rotation on the Cloudflare side** (see "Waiting on user/external" below). All 22
  matched `tb0a-*` visual-parity screenshots were captured 2026-08-25 (danger-mode Luna,
  `docs/plans/revamp_2026_portal/baseline/TB0A/evidence/Visual-Parity-Report.md`) and show zero
  React 19 regression. **Owner formally accepted TB0A 2026-08-25** on this evidence; Lightbox/
  PhotoGrid interaction and the sign-out/in cycle remain unverified against a real rendered asset
  (low-risk per the static React-19 removed-API sweep, zero hits) and are tracked as follow-up debt
  below rather than blocking further work.
- **Quincy Portal revamp TB0 is the active authority/baseline phase; TB0 itself changes no product
  source, dependency, schema, Worker, or production resource.** The owner approved the corrected
  authority package on 2026-08-24: D-13 and D-15 revised inline, four new decisions D-16–D-19,
  and Implementation Plan amendments A8–A14 (`docs/plans/TB0-Integrated-Architecture-And-Baseline-Plan.md`).
  The current-main baseline at `08f4653482c82e4a117c6347a7d0a456d48002ed` is recorded under
  `docs/plans/revamp_2026_portal/baseline/TB0/` with the full verify result, current-state evidence
  at 1440×900 / 1024×768 / 390×844 for every applicable surface (prototype-side comparison captured
  for Dashboard only — see `Baseline-Report.md`), bundle/CSS output, and a fully dispositioned,
  reviewed drift register.
  PR #44's Admin-only, direct send-only AutoHDR handoff is carried forward as existing
  authority/source baseline, not a revamp tracer bullet. TB0A (React 19.2 compatibility-only),
  TB0B (developer-managed pipeline-order boundary), TB1 (Tailwind v4 + shadcn foundation), TB2
  (route-safe project data freshness), and TB3 (project discussion v2) are all drafted, reviewed,
  and deployed to production (see the bullets above). All five are now live; TB4's plan is now
  APPROVED (see the bullet above) and is next in the Revised sequence — build in progress.

- **Mention-triggered emails for project comments and notice-board posts now carry the author's
  name and a 400-char, surrogate-safe excerpt of the actual comment/post body, deployed 2026-08-20
  (`docs/plans/implemented/Comment-Notification-Email-Content-Plan.md`, commit `5b55d64`, no
  migration).** Previously every mention email used a generic "You were mentioned..." line
  regardless of scope. HTML output goes through a single-pass `escapeHtml` helper in `@quincy/db`;
  the plain-text excerpt is truncated in `@quincy/shared`'s new `truncateForEmail` before escaping,
  never after. The project-comment email keeps its existing "View project" link; notice-board
  mentions structurally never show one — a fresh Terra diff review caught and fixed a case where
  the notice-board formatter would have shown that link block had any future caller passed one, even
  though no live caller does today. The in-app notification bell is unchanged (email-only
  enrichment, user-confirmed scope). Went through the full plan pipeline (two Terra plan
  self-review rounds, two Opus plan-tier review rounds) before any code was written, then build →
  fresh-Terra-diff-review → Terra fix round → Terra final focused pass → Opus final-draft review
  (approved after mutation-testing the new tests) → an independent §5 gate re-running the full
  verify sequence, including the two Worker test suites Codex's own sandbox cannot run.

- **Project comments now show newest-first, and Shift+Enter inserts a soft line break inside
  bullet/numbered list items in both project comments and the notice board, deployed 2026-08-17
  (`docs/plans/implemented/Comment-Input-Shift-Enter-And-Message-Order-Plan.md`, commits `d1d6bd3`
  then a follow-up on `main`, no migration).** Shipped as two separate, isolated deploys per the
  plan's own Sequencing section. Feature B (ordering) flipped `project-comments.ts` to stop
  reversing its already-descending query, and flipped `ProjectCollaborationPanel.tsx`'s
  prepend/append and "Load older comments" button position to match — the notice board already
  worked this way and needed no change. Feature A (soft breaks) registers Tiptap's `HardBreak`
  node scoped to list items via a custom keyboard shortcut in the shared `RichTextEditor.tsx`, and
  widens `@quincy/shared`'s rich-text document schema to accept `hardBreak` in any paragraph — not
  gated to list items — because the node is also reachable via paste or lifting a list item out of
  its list, and a list-item-gated server rule would 400 an ordinary paste with no way for the user
  to recover. Also fixes a real regression the schema change would otherwise have introduced:
  `mentionQuery`'s leaf-text separator didn't match its own mention-detection regex for the new
  inline node, silently breaking `@`-mention autocomplete immediately after a soft break. Went
  through the full plan pipeline from `docs/Subagent-Orchestration.md` (Terra draft, two Terra
  review rounds, three Opus plan-tier review rounds — round 3, after the Terra-revert budget was
  exhausted, found and fixed the mention regression directly, then a fresh Opus self-review
  approved it) before any code was written, then each feature separately through
  build → fresh-Terra-diff-review → Opus-final-draft-review → independent §5 gate.

- **Notifications are now clickable to their project, in-app and by email, deployed 2026-08-17
  (`Notification-Click-Navigation-Plan.md`, commit `2285093`, no migration).** Previously only 2
  of 10 notification types (`mentioned`, `subtask_assigned`) linked anywhere; the other 8 were
  plain mark-as-read buttons. Added a single shared `projectNotificationRoute` helper in
  `@quincy/shared` — `mentioned`/`subtask_assigned`/`subtask_due_today` deep-link into the
  collaboration panel (`?collaboration=open`), every other project-scoped type links to the plain
  project page — reused by both the `Topbar.tsx` click handler and the new email-link builder so
  the grouping can't drift out of sync between the two surfaces. Notification emails now carry a
  clickable link in both `text` and `html` bodies. Threaded through all seven production
  `emitNotifications` call sites (four in `workers/app`, three in `workers/background`, including
  two separately-implemented `notifyProject` functions a first review-round draft undercounted as
  one). A `/grill-me` round explicitly scoped this to the bare project page, not tab- or
  asset-specific deep-linking (e.g. `edited_landed` → Edited tab, `comment_added` → the exact
  commented asset) — flagged as a natural, larger follow-up if wanted later. Two Terra review
  rounds caught a wrong test-file path, an undercounted call-site list, and several test fixtures
  missing `APP_ORIGIN` that would have made new link assertions silently pass against broken
  `undefined/projects/...` strings.

- **Collaboration panel UI fixes + subtask due-time/reminder, deployed 2026-08-17
  (`Collaboration-Panel-UI-Fixes-Plan.md`, commit `aab76e5`, migration `0028` — additive nullable
  `project_subtasks.due_reminder_sent_at` column).** Three UI bugs reported against the just-shipped
  collaboration panel: the checklist item's row layout was broken at every width (a viewport media
  query never matched the panel's actual fixed width — fixed by restructuring into three explicit
  rows, checkbox+title / assignee+actions / date+time, sized to fit without any conditional CSS);
  the panel defaulted closed instead of open; and the close button read "Close collaboration"
  instead of a terser "Hide ›". A `/grill-me` round mid-plan added a real feature: subtask due dates
  gain an optional time (backward-compatible — bare `YYYY-MM-DD` stays valid forever), stored as a
  literal Sydney wall-clock string, plus a due-day-morning reminder notification built on the exact
  claim-then-guarded-rollback pattern the stalled-AutoHDR-handoff scan already uses, driven by the
  same existing hourly cron. Deliberately minimal v1 (one-shot, no escalation) — a more complete
  reminder system is separate future work. Five Terra review rounds across the plan (arithmetic,
  `display: contents` container-query gotcha, and — most seriously — a reminder-state bug where
  rescheduling a subtask never cleared its "already reminded" marker, so it could never remind
  again) plus a diff review that caught a CSS regression (the new wide-panel width rule accidentally
  also shrank the unrelated stage-hidden-photographer standalone fallback view) and a missing
  Drizzle migration snapshot. The §5 gate itself then caught a test-isolation bug the diff review
  missed: a new reschedule test left a subtask assigned to a shared fixture user with no cleanup,
  inflating an unrelated test's count. Live production smoke test on the exact project from the bug
  report confirmed the fix directly.

- **Collaboration panel relocated from EditProject to the Project page, deployed 2026-08-17
  (`Project-Collaboration-Panel-Relocation-Plan.md`, commit `15528f7`, no migration).** Comments +
  subtask checklist (still one unit — not split) moved from the `EditProject` form screen to
  `ProjectWorkspace` (the Project page) as a fixed, non-modal, right-edge overlay toggled by a
  vertical edge tab: collapsed by default, uniform behavior at every viewport width (no separate
  mobile scrim/drawer, unlike the old EditProject drawer it replaces), and it never disturbs
  `.work`'s two-column grid layout while open. Mention/subtask-assignment notifications now deep-
  link to the Project page and auto-open the panel via a typed, one-shot `collaborationOpenSignal`
  transported through a new `?collaboration=open` route intent (not a boolean — a monotonic
  counter, so a repeat notification to an already-open or already-closed panel still reopens/re-
  acknowledges correctly).
  The plan-drafting process itself is worth noting: a Terra draft, two Terra self-review rounds,
  and two full Opus plan-tier review/revert cycles plus a terminal Opus edit pass caught a real
  access-control gap the original brief missed entirely — `hasProjectCollaborationAccess()` grants
  a project member comments/subtasks access regardless of pipeline stage, but `hasProjectAccess()`
  (gating the Project page's actual data reads) blocks a photographer whose project sits in a stage
  outside `PHOTOGRAPHER_VISIBLE_STAGES`. Resolved (user's explicit choice) with a collaboration-only
  fallback: the Project route detects this via a comments-endpoint probe after the project-details
  request 403s, and renders comments/subtasks only — never the full workspace or an error page —
  preserving the exact pre-existing media/visibility policy. The same review pipeline also caught
  and fixed, before any code was written: a global `Escape` listener that would have closed the
  panel out from under an open Lightbox or a mention-autocomplete dropdown; a tab-effect "consumed"
  marker that could be silently eaten by an unrelated stage-driven Edited-tab switch, breaking a
  later manual RAW refresh; z-index gaps that would have covered the topbar's notification dropdown
  and PhotoGrid's multi-select action bar; a wrong "frontend-only" rollout claim (`
  safeStaffDestination()` is also bundled into the `app` Worker for OAuth callback validation —
  turned out to still be one atomic `wrangler deploy`, not an ordered pair, since the Worker serves
  the web build via its `ASSETS` binding); and a signal-leak bug that would have auto-opened the
  panel on a plain return visit to a project. The build itself then caught two more real bugs in a
  fresh diff review — the comments-probe fallback firing on any request failure in the load
  sequence (not just a details-request 403) and the collaboration wrapper still participating in
  `.work`'s CSS grid instead of using `display: contents` — both fixed and re-verified. Live
  rollout: `app` Worker deployed (version `02cd2e3d-5704-46a3-aec1-644672230aec`), and a full live
  production smoke test — default-collapsed edge tab, non-modal overlay confirmed by switching
  collection tabs with the panel open, a real subtask added and deleted with no residue, EditProject
  confirmed to no longer render the panel — completed cleanly with zero console errors. See
  `docs/plans/implemented/Project-Collaboration-Panel-Relocation-Plan.md` for full history.

- **Project subtasks/checklist (Phase 3 of 3 — collaboration plan complete), deployed 2026-08-17
  (`Collaboration-Rich-Text-Mentions-Subtasks-Plan.md`, migration `0027_project_subtasks.sql`,
  commit `10d88de`).** A flat, ordered checklist per project inside Phase 2's collaboration panel:
  title, done state, optional single assignee (current project members/admins only), optional
  due date (validated as a calendar-real `YYYY-MM-DD` string, never `Date`-parsed). Subtasks are
  shared project state — any current participant or admin can create/complete/edit/reorder/delete
  any item, deliberately not author-only like Phase 1/2's posts and comments. Assignment
  notifies (in-app + email, versioned/retry-safe source key); completion does not.
  The highest-risk piece: refactoring the already-shipped, production `syncMembers()`/project-PATCH
  membership path into a single atomic D1 batch that also clears a user's subtask assignments when
  they lose their last project role in that same request — without disturbing the existing
  `notifyProjectAssignments()` contract. Deactivation and admin-role-demotion deliberately stay
  outside that scrub (a stale, non-notifying assignee reference), per the plan's own scoped
  judgment call. This refactor was independently re-derived as correct **four separate times**:
  by this session's own line-by-line read, by a fresh Terra diff review, by an Opus final-draft
  review that additionally ran the move-endpoint's swap SQL against real SQLite to rule out a
  partial-update race, and by a final regression test (added after Opus flagged it as the one
  remaining untested branch) that exercises the exact "removed from one role, added to another in
  the same request" case and passes for real. Along the way: this session's own test run caught a
  real bug in the build's own test suite (a duplicate-row test-setup error that made the single
  most important test in this phase fail outright — fixed by removing the redundant insert, since
  the membership already existed from `beforeAll`); a fresh Terra diff review found and a fix
  closed a frontend bug where reordering a subtask left the swapped neighbor's local position
  stale until a reload; and this session directly fixed two small bugs an Opus review flagged as
  non-blocking (two CSS custom-property typos — `--type-h4` and `--text-tertiary` don't exist in
  this app's token set — and an `aria-live` region that was pulled out of the accessibility tree
  while empty via `:empty { display: none }`, which could cause the first error announcement to be
  missed). Live rollout: migration applied to `quincy-portal` remote D1 (schema confirmed via
  direct query), `app` Worker deployed, and a full live production smoke test — add a subtask,
  confirm it renders with working assignee/due-date/move/delete controls, delete it — completed
  cleanly with no console errors and no test data left behind. **All three phases of the
  collaboration plan are now live**; see
  `docs/plans/implemented/Collaboration-Rich-Text-Mentions-Subtasks-Plan.md` for full history.
- **Project comments + EditProject collaboration panel (Phase 2 of 3), deployed 2026-08-17
  (`Collaboration-Rich-Text-Mentions-Subtasks-Plan.md`, migration `0026_project_comments.sql`,
  commit `6525ed1`).** Reuses Phase 1's rich-text editor/renderer/mention infrastructure unchanged;
  adds a new `hasProjectCollaborationAccess()` rule (active admin → every project; everyone else →
  a real `project_members` row) deliberately distinct from the existing
  `hasProjectAccess()`/`viewAllProjects` shortcut and photographer stage-visibility gate — an
  assigned photographer can now collaborate on a project even when it's outside their normal
  stage-visible dashboard window, while an unassigned editor with blanket `viewAllProjects` cannot.
  Comments are project-scoped (mentions draw from project members + admins, not all staff),
  author-only edit/delete (admins not exempt), and deliberately comments-only — no automatic
  activity/audit feed, per the plan's explicit scope boundary. A new `collaborateOnProject`
  capability (UI-route-guard only, never checked by any API endpoint) opens the existing
  EditProject screen to every staff role; a `ProjectCollaborationPanel` renders there open by
  default, restructured so a collaboration-only user's render never triggers the stage-gated
  `GET /projects/:id` or the admin-only `GET /api/users` that the existing form/`ProjectFields`
  depend on. Reachability for a stage-hidden collaborator comes from new Topbar notification deep
  links (`mentioned`/`subtask_assigned` types with a project id become real links to the edit
  screen; every other notification type, and these two types when project-null, stay plain
  mark-read buttons) — there is no project-workspace rail entry, by design. Cleared Terra build → a
  fresh Terra diff review, which confirmed the security-critical property first (collaboration
  access checked *before* project-existence on every route, so a non-member can't use 403-vs-404
  as a project-existence oracle — the same class of ordering mistake was Phase 1's own blocking
  Opus finding) but found test coverage thin in three places (mention/pagination/inactive-target
  coverage in the Worker suite; no DOM test at all for the new panel or the collaboration-only
  render path; only one of two allowed notification deep-link types tested) → a test-only fix pass
  closed all three → a final Terra pass approved. An Opus final-draft review re-verified the
  access-before-existence ordering line-by-line in all five places, confirmed the FK cascade on
  comment deletion is real (traced against the production hard-delete route, which relies on it
  live), and approved with only non-blocking nits — two were worth fixing and applied directly:
  a CSS grid-column bug that would have rendered the collaboration panel in the wrong-width column
  for users without the editable form, and a stale `CLAUDE.md` migration-range note. Live rollout:
  migration applied to `quincy-portal` remote D1 (confirmed via direct schema query), `app` Worker
  deployed, and a live production smoke check confirmed `GET /api/projects/:id/comments` responding
  200 with the panel rendering correctly (project street, empty state, rich-text composer) and no
  console errors. Phase 3 (subtasks/checklist) remains unbuilt; the plan stays in `docs/plans/`
  until all three ship.
- **Notice-board rich text + @mentions (Phase 1 of 3), deployed 2026-08-17
  (`Collaboration-Rich-Text-Mentions-Subtasks-Plan.md`, migration
  `0025_collaboration_rich_text_notice_mentions.sql`, commit `df4844e`).** Staff notice board gets
  a shared, server-validated rich-text format (bold/italic/lists/links/@mentions — a small JSON
  contract in `packages/shared/src/rich-text.ts`, not raw HTML; the parser is a strict whitelist
  that rebuilds every node fresh rather than trusting client structure), a reusable TipTap
  editor/renderer pair, and an active-staff mention lookup endpoint (`{id,name,role}`, never
  email). `viewNoticeBoard` now opens both viewing and posting to every active staff role,
  including photographers. Mentions notify in-app + email through the existing pipeline, with
  send-time eligibility re-checks and versioned/mapping-row source keys so retries can't
  double-deliver. Posts gain author-only edit (admins not exempt) alongside the existing delete.
  Cleared Terra draft → 2 Terra self-reviews → 2 Opus plan-tier review-and-revert rounds → an Opus
  self-edit (revert budget exhausted) → final Opus plan approval, then build → a fresh Terra diff
  review (found and fixed: a missing `drizzle-kit` snapshot that would have let the next
  `generate` regenerate a duplicate migration — same failure class as the 2026-07-30 incident
  below; a mention-autocomplete accessibility bug with `aria-activedescendant` on a non-focused
  element; missing required test coverage) → a Terra final pass (approved) → an Opus final-draft
  review, which found one real blocker: pressing **Enter** to accept a mention corrupted the post,
  because ProseMirror's own native `keydown` listener on the contenteditable fires before React's
  synthetic `onKeyDown` on a wrapper element ever runs, so PM's default paragraph-split had already
  applied by the time the React handler tried to intercept it — fixed by moving the interception
  into TipTap's own `editorProps.handleKeyDown` hook, which runs inside PM's own event pipeline.
  Also independently caught and fixed in this session: a fabricated `@tiptap/*` npm version
  (`2.26.2`, which doesn't exist on the registry) corrected to the real latest 2.x release
  (`2.27.2`), and a test-mock shape bug that crashed `NoticeBoard` in tests. One Terra sub-agent
  run genuinely stalled for ~2.5 hours retrying a Workers/Miniflare test command its own sandbox
  structurally can't run (repeating log content, near-zero CPU relative to wall clock) — killed,
  its actual code changes verified correct on disk, and the fix confirmed independently instead of
  waiting on it. Live rollout: migration applied to `quincy-portal` remote D1 (confirmed via direct
  schema query), `app` Worker deployed, and a live production smoke check confirmed the new
  `GET /api/notice-board/posts` endpoint responding 200 with the new rich-text UI rendering
  correctly (toolbar, mention hint, author-only Edit/Delete) and no console errors. See the Phase 2
  entry above for the next milestone; Phase 3 (subtasks/checklist) remains unbuilt.
- **"Download selection" multi-select button, deployed 2026-08-04
  (`Download-Selection-Plan.md`, migration `0024_download_selection_tickets.sql`, commit
  `538a020`).** Lets a user download an ad-hoc ZIP of just their checked RAW or Edited photos from
  the photo grid's multi-select action bar, separate from the existing persisted "selected for
  editing" ZIP route. `POST /api/projects/:id/download-selection` validates the selection
  (chunked ownership/visibility queries to stay under D1's bound-parameter limit, all-or-nothing
  generic 404, 500-item/256 MiB caps) and writes a short-lived D1-backed ticket — not KV, which is
  only eventually consistent across edge PoPs and could 404 an immediate first download. `GET
  .../download-selection/:ticket/archive.zip` reloads the current principal and re-validates
  everything live before streaming, so a role downgrade or deactivation between ticket creation
  and download is honored rather than replaying a frozen decision. Capability split: RAW requires
  `selectForEditing`, Edited requires `downloadFinal`. Cleared 2 Terra plan rounds, an Opus
  plan-tier review (1 of 2 reverts used — caught a real Hono routing bug: `:ticket.zip` parses as
  a param literally named `ticket.zip`, not "param plus literal suffix"; corrected route is
  `.../download-selection/:ticket/archive.zip`), a Terra diff review (found missing
  malformed-JSON/asset-deletion test coverage and a schema-strictness gap, fixed), and an Opus
  final-draft review (approved with should-fix notes only — memoize the selection byte total,
  derive the disabled-button caption from the shared byte constant, strengthen two tests that
  weren't actually discriminating — all applied). Live rollout: migration applied, app Worker
  deployed, and a real production download verified end-to-end (correct ZIP magic bytes, filename,
  and byte count, both via the browser UI and direct API calls).
- **User-clearable notifications + AutoHDR stalled-notification guard, deployed 2026-07-30
  (`Notification-Dismiss-Delete-Plan.md`, migration `0023_autohdr_stalled_notification_guard.sql`,
  commit `82143b2`).** Added a dismiss control to the bell dropdown (`DELETE
  /api/notifications/:id`) so a notification is permanently removed from the database instead of
  accumulating forever. The final review of that route found a real side effect: `autohdr_stalled`
  is the only notification type deduplicated purely by row existence, so dismissing one while its
  AutoHDR handoff is still genuinely stalled would let the next hourly scan silently re-insert and
  re-email it. Fixed with a new nullable `autohdr_handoffs.stalled_notified_at` column and a
  claim-before-emit redesign of `scanStalledAutoHdr` — each candidate is claimed via an atomic
  conditional `UPDATE` that re-validates all five original eligibility predicates before any
  emission, closing a real TOCTOU/concurrency race two Terra review rounds and an Opus plan-tier
  review caught and fixed. Also independently caught and fixed in this session: a `drizzle-kit`
  snapshot gap that would have made the next `drizzle-kit generate` regenerate a duplicate,
  prod-breaking migration (confirmed by reproducing the failure, then fixed with drizzle-kit's own
  correctly-computed snapshot output). Live rollout: migration applied, `background` then `app`
  deployed, post-deploy smoke clean, and a real production dismissal verified end-to-end (removed
  immediately with correct focus handoff, confirmed gone from the server after a full reload).
- **Seed admin UUID migration, applied to production 2026-07-29 15:12 UTC
  (`Seed-Admin-UUID-Migration-Plan.md`, migration `0022_seed_admin_uuid.sql`, commit `3897501`).**
  The studio admin's `user.id` was the literal string `seed-admin` (a seed-script artifact, not a
  UUID like every other user), which failed the strict `.uuid()` validator on project
  photographer/editor assignment ("Invalid input"). Repaired the data rather than relaxing
  validation: migrated to a real UUID (`6b851dc8-14cf-4f90-bd29-ce6c27f86385`) across all 14
  FK-referencing tables plus Better Auth's `session`/`account`. Terra plan-reviewed across 2 rounds
  (caught and fixed a real `UNIQUE`-constraint SQL bug in the email-swap sequence) plus an Opus
  plan-tier review (added a full failure/recovery runbook for interrupted-migration states), built
  by Terra, Terra diff-reviewed (fixed two gaps: a non-reproducible local-D1 verification and an
  incomplete durability check), and Opus final-draft reviewed (corrected the runbook's
  race-condition analysis for `CASCADE`-configured tables, added a window-scoped detection probe).
  Live rollout executed with a 60-second drain window: zero races detected, session continuity
  confirmed (pre-migration session token resolved to the new UUID, no re-login needed), and the
  original assignment bug confirmed fixed live (POST+PATCH both succeeded). No Worker redeploy
  needed — pure D1 data operation. D1 migrations 0000-0022 now applied to prod; next available
  number is 0023.
- **Admin notification visibility + assignment alerts, deployed 2026-07-29
  (`Admin-Notification-Visibility-And-Assignment-Alerts-Plan.md`, commit `bc3c18f`).** Diagnosed
  live in-session (direct production D1 queries) that admins received zero notifications ever,
  because recipient resolution only reads `project_members`, which has no admin role — the send
  pipeline itself was already proven working via two real Kanban stage-transitions to `delivered`
  during diagnosis. Fixed by having admins implicitly receive every project notification
  (deduped against real membership, `excludeUserId` still honored), and separately added a new
  `assigned_to_project` notification fired when a user is newly assigned as photographer/editor —
  previously silent for everyone. Terra plan-reviewed across 5 rounds (caught and fixed a real
  concurrent-PATCH double-notification race via `INSERT ... ON CONFLICT DO NOTHING RETURNING`
  instead of a stale pre-read snapshot), built by Terra, independently re-verified in this session
  (one stale test assertion caught and fixed — Terra's own sandbox couldn't run the Miniflare
  suites at all), Terra diff-reviewed, and Opus final-draft reviewed. All green: typecheck, web
  build, and all real test suites (D1, app, background, webhook-ingress, shared, web — 516 tests).
  Deployed background → webhook-ingress → app; post-deploy smoke clean.
- **The 6-feature batch (priority/reorder, notifications, notice board, select-all,
  editor-as-photographer, photographer visibility) is fully built, verified, committed, migrated,
  and DEPLOYED to production as of 2026-07-28.** All six plans Terra plan-reviewed, built (five by
  Terra, one — PhotoGrid Select-All — directly in-session per its small-task routing), independently
  re-verified in this session (catching and fixing real bugs Terra's own sandbox couldn't find,
  since it can't run the Miniflare-backed Worker integration suites), and Terra diff-reviewed.
  Commits: `ad2b60b` (select-all), `99b7509` (editor-as-photographer), `57f87a6`
  (photographer-stage-visibility), `dcc3213` (notice board), `bb6dca9` (notifications), `bdcf612`
  (Kanban priority/ordering), `222b037` (migration `0020` prod-deploy fix, see below). Migrations
  `0018`-`0020` applied to prod; all three Workers redeployed (background → webhook-ingress → app);
  post-deploy smoke clean (site 200, unauth API routes correctly 401 including the two new
  `/api/notifications` and `/api/notice-board/posts` surfaces). See each plan doc for
  build-specific detail (bugs found/fixed, deviations, coordination-point outcomes).
  `docs/Build-Handoff-6-Feature-Plans.md` has the original recommended build order and cross-plan
  coordination notes, now all resolved.
- **Real production migration failure and fix, 2026-07-28 — read `docs/lessons.md` before
  generating any future table-rebuild migration.** Migration `0020` (Kanban priority/board_position)
  as originally generated by `drizzle-kit` used the standard SQLite table-rebuild form for its
  `CHECK` constraint; it passed every local/Miniflare check but failed against real prod D1
  (`FOREIGN KEY constraint failed` on `DROP TABLE projects`) because `PRAGMA foreign_keys=OFF`
  doesn't reliably persist across D1's remote migration execution. Production was left clean by the
  failed attempt (verified directly). Fixed by replacing it with a bare
  `ALTER TABLE ADD COLUMN ... CHECK(...)` form (verified locally first), re-applied successfully.
  **Cloudflare Email Service is now configured and confirmed live (2026-07-29)** — verified by
  querying production D1 directly: real `notifications` rows for both the `delivered` type
  (`workers/app`'s send path) and `autohdr_stalled` (`workers/background`'s send path) show
  `email_sent_at` populated with a real `email_message_id` and no `email_error`, so both workers'
  identical email code paths are proven working end-to-end in prod, not just `background`'s as
  earlier noted. `docs/Cloudflare-Email-Service-Setup.md` remains useful background on the setup
  steps already completed, not a pending TODO.
  **Not yet done:** live manual smoke test of each feature as a real staff account (photographer
  losing dashboard visibility, notice board post round-trip, Kanban priority/reorder, notification
  bell) — the automated verification is thorough but no one has clicked through the actual UI yet.
- **`main` is source of truth** — `build/phase-0-2` merged via PR #3. Production live at
  `quincy.flamingfire.my` (prototype on its own hostname). Branch off `main` for new work.
  **2026-08-18: the staging environment was removed** — it shared production's D1/R2/`APP_ORIGIN`
  and never had working Google OAuth, so it offered no real isolation. See
  `docs/Subagent-Orchestration.md` §2 policy 9 for the downstream consequence: danger-mode UI
  testing no longer has a mutation-safe target and is passive-only everywhere now.
- **Phases 0–4 shipped and live**: foundations/auth/infra; capture ingest + RAW QA; AutoHDR +
  Edited QA + review lightbox; Tonomo intake + dashboard (Kanban/List) + admin backend;
  video/floorplan/copy collections.
- **D1 migrations: `0000`–`0020` confirmed applied to prod (2026-07-28).** Next available
  migration number is `0021`. Migration `0020`'s originally-generated table-rebuild form failed
  against real prod data (`PRAGMA foreign_keys=OFF` doesn't reliably persist across D1's remote
  migration execution, even though every local/Miniflare check passed) — replaced with a bare
  `ALTER TABLE ADD COLUMN ... CHECK(...)` form and re-applied successfully; production was left
  clean by the failed attempt (D1 only marks a migration applied on success). See `docs/lessons.md`
  for the full mechanics — worth reading before generating any future table-rebuild migration.
- **Rendition pipeline is live and working**: background queue generates thumb/web WebP on
  ingest/AutoHDR-return, served from R2 with a live-transform fallback (the "thumbnail
  rendition cache" plan from 2026-07-21 — Phases 1–3 all shipped as part of the 2026-07-24
  manual-edited-publish wave, below). The 2026-07-24 Cloudflare-side outage (see "Resolved
  incidents") is unrelated to this pipeline's own code, which was independently exonerated.
- **Deploy loop**: terra/agy (implement) → sol (review) → Claude (gate), full verification
  matrix re-run independently every time (agent sandboxes can't run vitest — always report
  tests "couldn't start"; never trust that as a pass). Deploy order: background →
  webhook-ingress → app.
- **Plan docs live in `docs/plans/`** (`docs/plans/implemented/` for shipped ones) — see
  "Implemented plans" and "Open plans" below.
- **Waves 1a, 1b, 2, 3 merged to `main` and deployed to production (2026-07-24).** PRs #12–#15
  (docs housekeeping was #11). Deploy order `background → webhook-ingress → app` completed;
  migrations `0012`–`0014` applied to prod; smoke-tested (`/`, `/api/session`, `/d` reservation
  all responding correctly).
  - **1a** `feat/staff-routing-deep-links` — SPA History-API router, `/d/*` Worker reservation,
    mandatory OAuth callback allowlist. **Live.**
  - **1b** `fix/r2-rendition-purge-on-delete` — R2 renditions now purged on project delete. **Live.**
  - **2** `feat/capture-count-and-dropbox-mirror` — durable manifest-based capture count, manual
    RAW uploads now mirror to Dropbox. **Live.**
  - **3** `feat/dropbox-webhook-automation` — event-driven Dropbox intake, dual root-scoped
    monitors, AutoHDR handoff/claim/versioning model. Shipped dormant, then **progressively
    enabled 2026-07-25**: `DROPBOX_RAW_AUTOMATION_ENABLED="1"` and
    `DROPBOX_AUTOHDR_AUTOMATION_ENABLED="1"` are now live; `DROPBOX_HANDOFF_V2_ENABLED` is the
    last one still `"0"` and is **required** to complete AutoHDR auto-fetch — see the
    webhook-triggered auto-fetch entry under "Open, not yet fixed" for the sequenced plan.
    The legacy hourly cron is deliberately still present as a safety net — do not remove it in
    the same deploy that enables the new monitors. An independent review caught and a
    follow-up fix pass resolved 8 real races/gaps before this was considered done — see
    `docs/lessons.md` for the two most reusable patterns (partial-unique-index backstop for
    "exactly one current row"; never retire a legacy safety mechanism in the same deploy that
    defaults its replacement off). **Still outstanding:** four rollout doc updates
    (`docs/Dropbox-Setup.md`, `docs/Implementation-Plan.md` — the plan's step 8 checklist).

- **Branch `fix/gate-manual-edited-upload-on-raw-folder` (2026-07-25) — not yet merged or
  deployed.** Manual *edited* uploads were accepted (presign 200 → R2 bytes → D1 row → 202) on
  projects with neither `raw_folder_path` nor `raw_folder_link`, then failed minutes later in
  `ManualEditedPublish` and landed at `publish_status = 'failed'` — permanently invisible, because
  the edited listing filters on `'ready'`. Recovery was `adminBackend`-only, while `editor` holds
  `uploadEdited`. Now refused up front (409 `raw_folder_missing` / `raw_folder_invalid`) on
  presign, complete and dev direct-PUT, with the Edited dropzone replaced by a notice telling the
  user to create the shoot folder in Tonomo. Portal never creates that folder — Tonomo owns it.
  The Portal-owned `/AutoHDR/{name}/Manual-Uploads/{assetId}` chain is now created explicitly by
  the Workflow (`ensure-manual-edited-folder`), matching the AutoHDR hand-off's `ensure-dest-folder`
  instead of relying on the provider's implicit parent creation. RAW is deliberately *not* gated:
  a failed RAW mirror never hides the asset. No migration. **Still open:** existing prod assets
  already stuck at `publish_status = 'failed'` are not backfilled — check with
  `SELECT count(*) FROM assets WHERE publish_status = 'failed';` after deploy, then set each
  project's RAW folder and retry the job.

## Waiting on user / external

- [ ] **TB4D residual QA** (`docs/plans/implemented/Revamp-TB4D-Checklist-Scheduling-Ranges-Plan.md`):
  **local mutating QA matrix — DONE 2026-08-28** (Agy via Option A against `http://localhost:8787` on
  `main` + migration `0035` applied to local D1). 17-check matrix ALL PASS, every functional claim
  independently re-verified against local D1 by the orchestrating session (§5): 13 `schedule_changed`
  activity rows with contiguous versions 1–13 (one per committed change; none for no-op / rejected /
  legacy-adapter writes); `safe_payload_json` = exactly `{itemId, checklistTitle, scheduleState,
  version}` (privacy-safe); `source_key` = `project-checklist-schedule:<projectId>:<itemId>:version:<n>`;
  1 broad `project.activity.broad` outbox row with `coalesce_key`
  `...:<itemId>:<actorId>` + 300000 ms window, 2nd same-item/same-actor edit coalesced (count stayed
  1); 0 email ledger rows; version-conflict → 409 + authoritative state + no UI auto-retry; Sydney
  DST gap (Oct 4) → 400 `nonexistent_local_time`, fold (Apr 5) → 400 `repeated_local_time` with
  Earlier/Later `choices` (offset 660 vs 600); exact-minute round-trip; pure-start edit → activity
  yes / broad no / reminder untouched; legacy `dueDate` adapter (version-0 works, version≥1 →
  `reload_required`); reorder/reassign unchanged (no schedule activity); responsive editor at
  1280/900/375. Still open: the fire → outbox → **bell delivery** half is NOT locally exercisable
  (no local background Worker) — covered by the `workers/background` 239-test suite; no authenticated
  **production** walkthrough (Agy has no prod danger/YOLO sanction; post-deploy prod checks stayed
  passive — site 200, outbox 9/9 completed, cron clean). The **PATCH raw-`dueDate` one-release
  adapter** removal and the deferred Opus final-draft nits (see the TB4D entry above) remain open.
- [ ] **TB4C residual QA** (`docs/plans/implemented/Revamp-TB4C-Editor-Wide-Project-Change-Notifications-Plan.md`):
  the fire → outbox → in-app-notification → bell **delivery** half of the broad-activity path is not
  locally exercisable (no local background Worker — `BACKGROUND` binding `[not connected]` under
  `wrangler dev`), covered instead by the `workers/background` automated suite (239 tests, incl. the
  Opus-mandated permanent-failure / deactivate / role-demote / initial-roster-matrix coverage). No
  authenticated **production** render check (rail/bell/Admin ops) was performed — Agy (which ran the
  local QA matrix) has no production danger/YOLO sanction, and the post-deploy production checks
  stayed unauthenticated (D1 health, cron, endpoint gating). The 9-item local mutating matrix was
  fully run and independently D1-verified — see the TB4C entry.
- [ ] **TB4B residual QA** (`docs/plans/implemented/Revamp-TB4B-Project-Deadline-And-Reminders-Plan.md`'s
  "Manual QA matrix"): the fire → outbox → in-app/email **delivery** half of items 4/6/7/8/9 is not
  locally exercisable (no local background Worker — the app Worker's `BACKGROUND` binding is
  `[not connected]` under `wrangler dev`), and is covered instead by the `workers/background`
  automated suite (231 tests) and the passive production Cron monitoring in the TB4B entry above.
  Item 13's full keyboard-only accessibility sweep of the Deadline editor / preferences / conflict
  flow was not completed live (the inline editor uses an explicit Cancel button and does not
  dismiss on Escape — noted, not a defect). Everything else in the matrix (save-side occurrence
  materialization, DST, conflict, Delivered/archive/Resume lifecycle, read-only rail, Kanban) was
  verified locally — see the TB4B entry. No mutating walkthrough was performed against production
  per `docs/Subagent-Orchestration.md` §2.9.
- [ ] **TB4A local mutating QA matrix** (`docs/plans/implemented/
  Revamp-TB4A-Project-Workspace-Assignment-Rail-Plan.md`'s "Manual local browser QA matrix", 11
  items): idempotent/concurrent add, independent dual-role removal, final-role checklist cleanup
  with the real confirmation dialog, stale-cycle 409, failure recovery, the Create/Edit rollout
  boundary, the collaboration-only Stage-hidden boundary, and cross-tab freshness — all deliberately
  left to local `http://localhost:8787` testing per `docs/Subagent-Orchestration.md` §2.9 (no
  mutating walkthrough against production). Production itself was only passively smoke-tested
  (see the TB4A entry above).
- [ ] Add `AUTOHDR_API_KEY` to the production **background Worker** before the direct-send branch
  is deployed (`cd portal/workers/background && npx wrangler secret put AUTOHDR_API_KEY`). Local
  development uses the gitignored `portal/workers/background/.dev.vars`.
- [ ] Configure Tonomo with the webhook URL:
  `https://quincy-portal-webhook-ingress.mjj2332.workers.dev/webhooks/tonomo?token=<see .prod-secrets.local>`.
- [ ] Real interactive Google browser login check at `https://quincy.flamingfire.my`.
- [ ] Rotate/retire production `BETTER_AUTH_SECRET`: still sits in gitignored
  `portal/workers/app/.prod-secrets.local` — move to password manager, delete the file.
- [ ] **Rotate the production R2 S3 API token** (account ID / access key ID / secret access key
  pair). It sat in local `portal/workers/app/.dev.vars` without `APP_ENV=dev` set, which let a
  local upload reach real production R2 during TB0A diagnosis 2026-08-24 (see the TB0A plan's
  implementation record for the exact orphaned object key). The local `.dev.vars` copy has been
  blanked, but the underlying Cloudflare credential itself has not been rotated — do this via the
  Cloudflare dashboard (R2 → Manage API tokens), then update wherever the production value is
  actually used (this repo's own local dev never needs real S3 credentials again per the TB0A fix
  in `portal/workers/app/src/lib/r2s3.ts`).
- [x] Dropbox app registered, secrets uploaded, `sharing.read` scope added + connection
  re-authorized, first live sync confirmed working (all 2026-07-20/21).
- [ ] **TB0A follow-up debt (low-priority, accepted 2026-08-25 without this):** verify Lightbox
  open/close/filmstrip navigation, RAW-vs-Edited comparison, PhotoGrid load-failure/retry, and a
  full sign-out/in cycle against real rendered media on React 19.2. Twice attempted and twice
  blocked this session: no local project has processed RAW/Edited renditions (the background Worker
  that consumes the rendition queue has no local dev entry point — standing it up means resolving
  the app Worker's `BACKGROUND` service binding, queue consumers, Workflows, and Durable Objects
  together), and this environment's Browser pane denied navigation to production for a passive
  check. Low-risk (a static sweep for every React 18→19 removed/changed API found zero hits
  touching these surfaces), but genuinely unverified — do not silently mark passed. Close via either
  a future normal session sampling a real populated project in production, or standing up the local
  background Worker.

## Open, not yet fixed

- [ ] **Direct send-only AutoHDR API handoff — implemented on PR #44, awaiting review/deploy.**
  The RAW-review button freezes the server-side selection, creates one background Workflow job,
  obtains provider presigned URLs, streams the private R2 JPEGs, and finalizes the AutoHDR
  photoshoot. It intentionally supplies no callbacks and contains no status/processed-photo
  retrieval call. Duplicate clicks reuse the active identical job; a changed selection is blocked
  until that send terminates. No migration.
- [ ] **P1** Comment/annotation *creation* fails silently — `postComment()`/`saveAnnotation()`
  in `Lightbox.tsx` have no `catch` (unlike their edit-handler siblings). Annotation create
  schema is `z.unknown()` for strokes while edit validates properly
  (`workers/app/src/routes/annotations.ts`).
- [ ] **P2** Narrow-screen (≤720px) nav loses Admin + Sign-out, no mobile-menu replacement.
- [ ] **P2** Floorplan PDF+preview version pairing not enforced (independent per-kind
  counters); external collection links never bump `receivedCount`; collection tab-switch race
  can apply a stale response; compare-mode layout not reset on an unpaired asset; no
  CSRF/origin guard on custom `/api` mutations; `LazyImage` terminal failure looks identical
  to loading (no retry).
- [ ] **P3** Lightbox synced zoom (RAW↔Edited compare, deferred, works-as-designed gap) · move
  50MB document uploads off `formData()` onto presigned upload.
- [ ] Hardening: add expiry to the `/__transform-source` HMAC signature (currently unexpiring
  per-key URLs — `TODO(hardening)` in `portal/workers/app/src/routes/media.ts`).
- [ ] Harden project DELETE: a stale `queued`/orphaned job can block it forever (409) — reap
  jobs past a staleness threshold, or clear terminal-eligible jobs on archive.
- [ ] Add a partial unique index on `(collection_id, content_hash) WHERE content_hash IS NOT
  NULL` (+ dedup existing rows) so concurrent Dropbox syncs can't insert duplicate assets.
- [ ] Validate JPEG magic bytes from R2 on ingest (RAW and edited currently trust the
  extension).
- [ ] **USER/testing:** validate the AutoHDR fetch flow against a real `04-FINAL(S)-Photos`
  sample once one exists — confirm exact finals-folder spelling and finished-filename ↔ RAW
  basename mapping for bracket-merged sets. Code currently reads both spellings and ingests
  unmatched finals as `source_raw_asset_id = null` (nothing lost meanwhile).
- [ ] Phase 5 (queued, own launch gates): client-delivery Worker — signed links, gallery,
  favourites, pre-built zips, premium paywall (Pixieset replacement).
- [ ] **Operator action:** fix the `TRANSFORM_SOURCE_SECRET` drift between `workers/app` and
  `workers/background` (`wrangler secret put` in both) — the root cause behind the rendition DLQ
  incident below. The DLQ monitoring/replay tooling is live, but the drift itself is unfixed.
- [x] **Webhook-triggered auto-fetch for RAW *and* AutoHDR edited — DONE and verified live
  end-to-end, 2026-07-25 (user-required feature).** A new file landing in either a Tonomo RAW
  folder or an AutoHDR `04-FINAL-Photos` folder is now ingested automatically off the Dropbox
  webhook, no button press. Both flags live: `DROPBOX_RAW_AUTOMATION_ENABLED="1"`,
  `DROPBOX_AUTOHDR_AUTOMATION_ENABLED="1"`, `DROPBOX_HANDOFF_V2_ENABLED="1"`.
  - **RAW**: the monitor matches changed paths against `projects.raw_folder_path` directly, no
    claims needed. Verified: a file dropped into 12 Brompton's folder ingested unprompted.
  - **AutoHDR**: routes via `autohdr_path_claims`/`autohdr_output_mappings`, created only by the
    V2 send path — chosen over deriving the folder name from `raw_folder_path` (the RAW
    approach) specifically because that has no collision detection, and two live projects were
    found sharing a folder name differing only in case (Dropbox paths are case-insensitive).
    `autohdr_path_claims`' unique index catches exactly that and parks it in `blocked_collision`
    for a human — do not replace this with path-derived routing.
  - **Verified end-to-end 2026-07-25**: sent 168 Botany to AutoHDR via V2 → path claim +
    output mapping created (`pending`/`pending_discovery`) → dropped `places-04.jpg` into its
    `04-FINAL-Photos` → claim resolved to `active`, mapping's `final_path` populated, a
    `fetch_edited` job appeared on its own (`trigger: "dropbox_delta"` in its payload, not a
    click) → asset ingested with 2 renditions within 10 seconds.
  - **Scope**: auto-fetch applies to projects *sent through V2*. A project sent on the legacy
    path has no claim and always needs the manual button.
  - **Real bug hit and fixed along the way** — see `docs/lessons.md`: both V2 Workflow instance
    ids used `:`, which Cloudflare rejects (`instance.invalid_id`). Broke V2 send *and* fetch;
    stayed invisible until the day V2 was actually switched on, because the legacy paths use a
    bare UUID and never exercised the bad format. Fixed with a regression test.
  - **Also found while getting there** (kept as open follow-ups, not blocking):
    - A project sent to AutoHDR with **zero** RAW assets in `selected_for_editing` can never
      leave `editing_autohdr` — `advance-stage` requires `selectedRawAssets.length > 0` before
      it will even check readiness. Worth a guard or a surfaced warning at send time.
    - The account was found to be on the Workers **Free** plan (50 subrequests/request, 100k
      requests/day), which made the whole pipeline unable to run reliably at real volume.
      Upgraded to Workers Paid 2026-07-25 — see `docs/lessons.md` for how much this looked like
      unrelated application bugs before the plan tier was checked.
  - **Optional backstop, safe only after V2:** an hourly cron sweep over `editing_autohdr`
    projects as a missed-webhook safety net (claims make folder→project ownership unambiguous).

## Resolved incidents (kept for pattern-recognition; see `docs/lessons.md` for mechanics)

- **Dropbox `files/download` 429 from cursor-reset burst amplification (2026-07-25).** One new
  AutoHDR image triggered a shared-content traffic-limit 429 on the Admin dashboard. Root
  cause: a cursor-reset full re-list of `/AutoHDR` could match several projects and start
  concurrent `AutoHdrFetch` Workflows, with no `Retry-After`-aware backoff and no pacing
  between downloads anywhere in the stack. Fixed: `DropboxRateLimitError` +
  `rate_limited` classification (self-heals like `transient`), `Retry-After`-aware alarm
  rescheduling, and pacing/stagger in `dropbox/sync.ts` and `workflows/autohdr-fetch.ts`. Not
  escalated to Dropbox Support — fully explained by this code gap; escalate only if the
  affected link/folder is still throttled after ~24-48h or a 429 recurs post-fix.
- **Tonomo webhooks poisoned on manually-entered addresses (2026-07-25).** `parseTonomoOrder`
  never checked `property_address.formatted_address` as a fallback when `.street` was blank
  (common for manually-entered addresses that skip Tonomo's place-autocomplete). Fixed by
  adding it to the fallback chain, ordered after the structured `.street` field. See
  `docs/lessons.md` for the asymmetric-fallback-helper pattern this exposed.
- **Rendition DLQ had zero consumers bound (2026-07-24, merged via PR #9).** Exhausted
  rendition jobs (root cause: `TRANSFORM_SOURCE_SECRET` drift between `workers/app` and
  `workers/background`) piled up in `quincy-renditions-dlq` with no signal beyond stuck
  "Processing preview…" tiles. Fixed with a bound DLQ consumer recording arrivals into
  `rendition_dlq_events` (migration `0011_dapper_tarantula`, confirmed applied to prod), plus
  `GET/POST /admin/renditions-dlq*` (list/replay/discard) and an Admin.tsx card. The root-cause
  secret drift itself is a separate, still-pending operator action — see "Open, not yet fixed".

- **Cloudflare `err=9401` rendition outage (2026-07-21 diagnosed → 2026-07-24 resolved).**
  Every `/cdn-cgi/image/` transform on the zone was rejected, reproduced even for a trivial
  static PNG untouched by our code/signing. Verified not our config (Sources allow-list,
  master toggle, secrets all correct). Resolved on its own — likely the paid Images plan
  Terry added took hours to propagate; confirmed via a zero-R2-involvement test flipping from
  failing to succeeding, and production D1 showing real recovery (not just one test). Two
  independent reviews (git blob-SHA diff + Sol read-only) exonerated the code entirely —
  `renditions.ts`/`transform-source.ts`/`media.ts`/app `wrangler.jsonc` were byte-identical
  across every suspected commit and HEAD. `ALLOW_PRODUCTION_RENDITION_BACKFILL=1` is still set
  on the background worker from the recovery attempt — clear it.
- **Spaced-filename HMAC bug (WP-AC, 2026-07-21):** the `/__transform-source` signature was
  verified against the percent-encoded path while signed over the raw R2 key. Fixed
  (per-segment encode on issue, decode-before-verify on receipt); regression test pins the
  round-trip.
- **Grid-concurrency rate-limit outage (2026-07-21):** 24–40 simultaneous live-transform
  thumbnails tripped Cloudflare edge rate-limiting. Fixed with `LazyImage` (4-permit
  semaphore, watchdog, retry+backoff) across grid/dashboard/lightbox filmstrip; transforms
  made immutable+cacheable. Verified live: 69 media requests, all 200, zero 403.
- **Same-zone subrequest bypass (Spike ①, pre-2026-07-21):** a Worker's same-zone subrequest
  bypassed the whole Cloudflare pipeline; fixed via a signed `/cdn-cgi/image/` redirect. Gate
  passed at 28.4MB and 83.8MB/88MP real photos.
- **Stale P1 (webhook reliability) — already fixed at HEAD, caught 2026-07-24.** Old entry
  claimed Dropbox webhook failures were acked 200 and never rewoke the DO. Current
  `workers/webhook-ingress/src/index.ts` already wakes on both new/duplicate deliveries,
  writes `last_event_at` unconditionally, and returns 503 (not 200) on failure so Dropbox
  retries. The sticky-error-status behavior mentioned in the original report is unverified —
  recheck separately if it resurfaces.

**Agy can build, not just plan.** Confirmed 2026-07-24: Agy (`gemini-3.6-flash-high`, this
account's default) is now a second, independent build pipeline alongside Codex. Requires
`--mode accept-edits` (no `--sandbox` — combined with accept-edits it silently blocks writes
with zero error) and `--add-dir "<repo root>"` (writes outside Agy's `trustedWorkspaces`
allowlist are silent no-ops otherwise). Full mechanics in `docs/subagents/agy-cli.md`.

## Implemented plans (see `docs/plans/implemented/`)

- **`Revamp-TB5C-Production-Calendar-Plan.md`** (+ `docs/plans/tb5c/`) — **deployed to production
  2026-08-31**, merge `a7684d8`, **app Worker `2ba08078` only** (no D1 migration — 0038 still
  free — no `feature_flags` seed, no background/webhook-ingress, no `prototype/`), rollback target
  app `2b515484` (the TB5B deploy). Third Dashboard view (List | Kanban | **Calendar**;
  Month/Week/Agenda) — a **read + direct-manipulation projection** over the existing TB4B
  project-Deadline and TB4D checklist-schedule commands; every write goes through the unchanged
  `PUT /api/projects/:id/deadline` / `PATCH /api/projects/:projectId/subtasks/:id`. New:
  `GET /api/production-calendar` (bounded ≤2-`.all()` three-principal range endpoint, 42-day cap,
  corpus-proportional 10k density ceiling — see `tb5c/slice-4-query-review.md`), the shared
  `production-calendar.ts` domain module (query schema + strict DTOs + pure Sydney-DST drag→command
  mappers), the `viewProductionCalendar` capability (admin / internal editor / external_editor —
  NOT photographer; `EXTERNAL_EDITOR_CAPABILITIES` → 11), FullCalendar v7
  (`@fullcalendar/{core,react}@7.0.2` + `temporal-polyfill@1.0.4`, lazy route chunk). Two Calendar
  gates never merged and never joined to the Board's state machine: `calendarInteractionBlocked`
  (accept gate — defers/coalesces refetches) vs `calendarSettle` (command gate — disables
  activators after a changed winner, never blocks navigation). ID-free `production-calendar-invalidated`
  cross-tab broadcast. Overlap indicator (text, not colour). Phone Week = action-only (coarse
  pointer + ≤720px). `prefers-reduced-motion`, 44×44 touch targets, drag-mirror `aria-hidden`.
  Review pipeline: Sol draft → fresh-Sol ×2 → 3 Sol revisions → Opus plan-tier REVERT #1 → Sol
  revision → Opus plan-tier APPROVE → 12 slices each with mid-slice + confirm Sol passes → fresh
  Sol whole-branch review (2 passes) → Opus final-draft **APPROVE WITH FOLLOW-UPS** (S3 fixed, S2
  fixed, S1 documented as a known corpus-density limit) → Agy Slice 10/11 acceptance matrix all-PASS.
  Physical-phone + real-VoiceOver/NVDA checks **waived by owner** (FC v7 has no live region of its
  own, so the cadence risk the AT check was for does not exist).

- **`Revamp-TB5B-Kanban-Interaction-Modernization-Plan.md`** (+ `implemented/tb5b/`) — **deployed
  to production 2026-08-30**, merge `578d2a1`, **app Worker `2b515484` only** (no migration, no
  background/webhook-ingress, no `@quincy/shared`, no dependency change), rollback target app
  `4ba551a3`. dnd-kit replaces the board's native HTML5 drag over the shipped TB5A contract:
  dedicated drag handle, pointer + touch + keyboard sensors, position-aware **Move to…**,
  `DragOverlay`, single-writer optimistic overlay in component state (never the query cache),
  two orthogonal gates (`interactionBlocked` accept gate / `movementSettlePending` cross-Stage
  command gate — never merged), target-authoritative/source-provisional reconcile, ID-free
  cross-tab `dashboard-board-invalidated` broadcast, Workspace-rail Stage parity + deterministic
  focus restore. Sort-key ruled **Option A** (Opus plan-tier: network key stays
  authorization-scoped, sort is a derived interaction identity). Review pipeline: Opus plan-tier
  APPROVE → 9 slices → mid-build + full Sol diff-review → Sol focused verify → Opus cross-model
  final-draft (1 blocking regression on empty-Stage-column moves, fixed `71203f1`) → Sol focused
  confirm CLEARED → Agy local-dev functional QA matrix PASS (independently §5-re-verified) →
  Slice-5 real-hardware acceptance (touch + VoiceOver/NVDA) PASS. Also carried `b4f8fda`
  (pre-existing `main` breakage: TB5A fence-design test path).

- **`Revamp-TB5A-Stage-And-Kanban-Ordering-Contract-Plan.md`** (+ `implemented/tb5a/`) — **deployed
  to production 2026-08-29**, merge `b4cda86`, migration `0037`, app `4ba551a3` / bg `fa876454`,
  `tb5a_board_contract_enabled` ON. `board_revision` optimistic token + `board_position` sole
  persisted manual order; migration `0037` one-time normalization to `0,1024,2048,…`;
  `moveProjectStage` command + shared `/stage` route + typed cumulative confirmation reasons;
  transactional workflow-premise fence for every automatic Stage writer (a stale/ABA premise
  yields a zero-row winner — nothing commits, replacing the old post-hoc "interpret trailing
  SELECTs" approach); schema-variant seam (`pre_0037` → 503, `tb5a_0037` + flag-OFF →
  inert-by-fence, creation + Priority still work); Dashboard/rail exact-neighbour drag + keyboard
  Move Stage + Priority view. Reviews: 2 full Sol diff-review rounds (15 + 6 blockers, all closed);
  the fence mechanism took 3 Sol design rounds + 3 Opus verification passes; Opus final-draft MERGE.
  Deferred follow-ups: SF5 (Workflow `deferred` return completes the Workflow) + SF6
  (maintenance-window queue/alarm replay) — see `implemented/tb5a/slice-6-writer-closeout.md`.
- **`Dropbox-Webhook-Automation-Plan.md`** — Wave 3: event-driven Dropbox intake, dual
  root-scoped monitors, AutoHDR handoff/versioning. Live (automation flags off by default).
- **`staff-routing-and-deep-link-plan.md`** — Wave 1a: SPA History-API router, `/d/*` Worker
  reservation. Live.
- **`capture-count-manifest-verification-plan.md`** — Wave 2: fixed the false "Capture count
  needs attention" banner on top-up uploads; manual RAW uploads now mirror to Dropbox. Live.
- **`Implementation-Sequencing-Plan.md`** — the master plan that sequenced all of the above
  (plus the R2 rendition-purge fix, Wave 1b, which had no standalone plan doc) into
  dependency-ordered waves. Kept for provenance now that every wave has shipped.
- **`Dropbox-RAW-Fetch-Speedup-Plan.md`** (with its basis doc
  `Dropbox-RAW-Fetch-Performance-Analysis.md`) — narrowed-scope fix for RAW-sync idle time found
  on two real projects (28/40 Victoria Street, 3/9 Chicago Avenue) that lost time to hitting the
  old 40-file-per-run download cap. **Change 1 only**: raised `MAX_DOWNLOADS_PER_RUN` in
  `portal/workers/background/src/dropbox/sync.ts` from 40 to 120, sized against Cloudflare's
  15-minute Queue-consumer wall-clock limit at the measured ~4.1-4.2s/file. Two earlier revisions
  also proposed raising `quincy-ingest`'s `max_concurrency`; both were rejected by Terra review
  and that work deferred to its own plan — see `Dropbox-Ingest-Concurrency-Safety-Plan.md` under
  "Open plans". Shipped as commit `9c17af3`.
- **`AutoHDR-Implicit-Scaffolding-Plan.md`** — legacy pre-V2 AutoHDR send/fetch paths and their
  feature flag removed; AutoHDR intake folders now scaffold automatically at project-create/
  RAW-path-set time (five real writers converging on a fenced, concurrency-safe D1 write), and a
  Dropbox drop into `04-MANUAL-Photos` or `04-FINAL(S)-Photos` auto-detects and claims the handoff
  with no button click, closing the auto-fetch scope gap noted above. Operator backfill
  (`POST /admin/autohdr/backfill`) covers projects sent through the legacy path before V2
  existed. Migration 0015 (`autohdr_scaffold_claims`, widened `candidate` enum) applied to prod
  2026-07-26; all three Workers redeployed same day (background → webhook-ingress → app), smoke
  test clean. Went through 9 rounds of Terra pre-build review (rounds 7-15 of the plan doc, after
  the earlier 6 Agy/Terra-Sol rounds plus an independent Opus pass — read all three doc files
  together for full provenance) plus a separate fresh-context diff review. Independent
  verification outside the builder's own sandbox caught and fixed three issues the build missed:
  a typecheck regression, migration 0015 originally using `CREATE TEMP TABLE` (a documented,
  broken Cloudflare D1 limitation that would have failed against real D1 entirely), and a flaky
  cross-test-pollution bug in a test fixture — see `docs/lessons.md`. A new
  `POST /admin/autohdr/scaffold-backfill` route (dry-run capable) was added same-day to retroactively
  scaffold the 21 pre-rollout projects that already had `raw_folder_path` set before the automatic
  trigger existed — run once against prod 2026-07-26, all 21 succeeded, zero failures. **Verified
  end-to-end live 2026-07-26** on 29 Stanley Street: a manual drop into `04-MANUAL-Photos` was
  picked up by the Dropbox webhook within seconds, auto-created the handoff, advanced the project
  raw_review → editing_autohdr, fetched the file, and published it to the Edited collection — no
  button ever clicked. RAW-side webhook auto-fetch reconfirmed working on the same project. See
  `docs/lessons.md` for a gotcha hit while picking a test project (a project can have zero
  `autohdr_handoffs` rows yet still be ineligible, if it went through the pre-V2 legacy flow and is
  already past `raw_review`/`editing_autohdr` — check `stage_key` too, not just handoff absence).
- **`Mobile-Lightbox-Plan.md`**, **`Unified-Dropbox-Fetch-Plan.md`**,
  **`AutoHDR-Manual-Supplement-Fetch-Plan.md`** — three independent plans (4/7/6 Terra
  pre-build rounds respectively), built in parallel by three separate Terra invocations, each
  diff-reviewed in fresh context, fixed, and independently re-verified (typecheck, build, all
  four workspace/shared test suites — the parallel-build sandbox's own `EPERM` test failures were
  a Codex sandbox networking limitation, not real; the real environment passed clean: workers/app
  100/101+1 skip, workers/background 116/116, webhook-ingress 13/13, shared 33/33). Diff review
  found and fixed 4 real issues: AutoHDR manual-supplement guard-skips weren't logged (added);
  Mobile Lightbox's `aria-hidden` was incorrectly hiding the visible phone peek bar from assistive
  tech while leaving it focusable (High — fixed), "Compare with RAW" wasn't disabled at phone
  width and would visibly break the layout (Medium — fixed), and focus restoration could target
  the wrong trigger across a viewport-band change (Low — fixed). Unified Dropbox Fetch's diff was
  clean on first review. Deployed 2026-07-27 (background → webhook-ingress → app) and smoke-tested
  live: the unified "Sync from Dropbox" button (rail heading renamed from "Dropbox RAW folder" to
  "Dropbox") posts to the new route and returns 200; the Edited-tab autoHDR status block renders
  correctly in place of the removed button; the phone-width Lightbox shows the new peek bar
  (Approve/Flag/rating/Review handle) which expands to the full existing review-panel content in a
  bottom sheet. AutoHDR manual-supplement itself is webhook-driven and wasn't live-smoke-tested
  (would need an actual Dropbox drop) — verified instead via the real test suite and direct code
  read of the atomic D1 guard, dedup, and `mapping.ts` scoping.

- **`AutoHDR-Repeat-Send-Plan.md`** — fixes "Send N selected to autoHDR" silently doing nothing for
  any project's *second* send. Root cause: `claimAutoHdrHandoff()` short-circuits to the stale
  existing handoff whenever one is already `starting`/`started`/`blocked` for the project, and
  nothing in the codebase ever retires a handoff except archiving the whole project — confirmed live
  on `225-227 Victoria Road` (3 identical stale-jobId audit entries for what looked like 3 separate
  sends). **The hardest plan of this session — 8 Terra review rounds**, most finding real
  correctness gaps (not just polish): a non-partial unique index meaning a repeat send must
  *reactivate* the same `autohdr_path_claims` rows rather than insert fresh ones; the fresh-claim
  path's `raw_review`-only stage gate; a genuine quarantine risk for an in-flight fetch and a
  cross-generation filename-collision/asset-overwrite risk if retirement isn't gated correctly; six
  distinct D1 `changes()`-chaining mistakes across rounds 3-6 (partial retirement, an un-atomic
  per-candidate reactivation, a missing `jobs` insert violating a `NOT NULL` FK, a wrong
  compensating-batch shape); and, in round 7, a real regression this plan would have introduced in
  the existing stuck-job retry route (`POST /jobs/:id/retry`) if shipped as first drafted. **§7
  (added post-approval, user-requested)**: repeat-sending after deselecting a previously-sent asset
  now also removes that asset's file from the AutoHDR Dropbox folder — needed its own 4-round review
  after round 1 found the naive design (remove-by-selection-membership) could delete the wrong file
  under a filename collision or a stale/re-derived path. Fixed with a new `autohdr_sent_files`
  provenance table (this plan's one schema addition, migration `0016`) recording exactly what each
  generation's own send confirmed it wrote, plus a dual-fence (retirement-side + writer-side, same
  pattern as §4/§5) closing a race where the retiring generation's own still-in-flight send could
  write content after cleanup already ran. Built by Terra, diff-reviewed in fresh context across 3
  rounds: round 1 found the non-fatal `"remove-deselected"` step could skip its own audit-log write
  and that most of §7's required test coverage was missing (fixed); round 2 found several of those
  new tests didn't actually test what they claimed — a collision test whose mock made every path
  not-found, a combined test that never reached its own poll-exhaustion assertion, and a fresh
  instance of a recurring type-narrowing anti-pattern inside a test the same fix round had just
  added (all fixed, plus a new test exercising a Workflow's `run()` end-to-end via a hand-rolled
  `WorkflowStep` shim — no prior test in this codebase had done that for any `WorkflowEntrypoint`);
  round 3 found a genuine High-severity bug — retrying a failed repeat-send via the existing
  `POST /jobs/:id/retry` route lost `retiredHandoffId` (the `resumeExisting` path never carried it
  forward), silently skipping deselected-file cleanup on retry. Fixed by persisting it in the job's
  `payload_json` rather than the tempting-but-unsound shortcut of deriving it from `generation - 1`
  (project-archive and scaffold code can also mark a handoff `'retired'` with no successor
  generation, so that alone isn't a reliable signal) — plus a mid-run retirement test was added.
  Independent verification (this session, outside any Terra sandbox) then caught 4 more real bugs
  no review round could have found: Codex's own sandbox blocks Miniflare's `127.0.0.1` bind, so the
  real `workers/background` Vitest suite (139 tests) had never actually executed until this gate
  ran it directly. Found: a genuine production off-by-one in the delete-batch poll loop (it checked
  the *initial* submission's response tag to decide whether to keep polling, so it silently gave up
  after one check instead of the intended 45 — fixed to match the copy-loop's existing sentinel
  pattern); two tests that never activated their `autohdr_output_mappings` row before calling the
  fetch-claim path (fixed); three tests that never closed out the prior round's readiness units, so
  they tripped an unrelated overlap guard before reaching what they were meant to test — that guard
  itself had zero coverage until a dedicated test was added; and one flaky test asserting a fixed
  row order from a query sorted by a random UUID (fixed). `npm run typecheck`, the web build, and
  all four workspace/shared test suites (253 tests total) are green. Migration `0016` applied to
  prod D1 2026-07-27; all three Workers redeployed same day (background → webhook-ingress → app).
  Basic connectivity verified post-deploy (site loads, an authenticated API route returns 401 as
  expected rather than erroring). The repeat-send + deselected-asset-removal flow itself has not
  been live-smoke-tested against a real project — doing so would delete a real file from a real
  client's AutoHDR Dropbox folder, so it needs a deliberately-chosen test project, not a
  unilaterally-picked one.
- **`AutoHDR-Repeat-Send-Overlap-Guard-Removed.md`** — a separate, concurrent session removed
  `claimAutoHdrRepeatSend()`'s basename-overlap check (`ERR_SELECTION_OVERLAPS_OPEN_DELIVERY`),
  since staff need to resend a *changed* raw selection before AutoHDR returns the previous round's
  edits, and the final writer already replaces same-path deliveries in place. Replaced with an
  explicit `ERR_SEND_IN_PROGRESS` gate on the previous round's own raw-copy job. Shipped as commit
  `33d56d0`, deployed same day the change landed.
- **`AutoHDR-Manual-Supplement-Independence-Plan.md`** — root-caused live on `6/120 Beach Street`:
  AutoHDR's automated pipeline never delivered anything for that project's first round (still
  `pending_discovery` after 24+ hours), and `04-MANUAL-Photos` — built earlier this session
  specifically to *supplement* an already-delivered round — had no way to be the delivery for a
  round that was never discovered at all, by a deliberate, reviewed decision in that earlier plan.
  §§1-3 (2 Terra rounds): let the first manual file promote a `pending_discovery` mapping to
  `active`, using the manual folder itself as the canonical path — same mechanics
  `routeAutoHdrDelta()` already uses for FINAL/FINALS. Round 1 found a real regression risk
  (shifting the asset-insert's D1-batch result index without updating the code that reads it,
  which would have silently broken rendition-enqueueing for the common already-active-mapping
  case) plus 4 smaller fixes. §4 (added after a diff review of the built §§1-3 code, cross-checked
  against the concurrently-landed `33d56d0` above): closes a real data-loss race — a repeat send
  could retire a mapping mid-way through a Dropbox-delta batch of manual files, silently and
  permanently losing every file processed after the retirement, now made easier to hit by
  `33d56d0` loosening the guard that used to make it rare. Took 3 plan-review rounds to get right:
  round 1 found a pre-acquisition race, lease theft (no true mutual exclusion), an insufficient
  fixed TTL, and a deferred error code; round 2 (after fixing all of round 1) found the refresh
  didn't check its own expiry, a single slow file's download could outlast a refresh taken only at
  file-start, a non-lease `skipped` result wasn't treated as a page failure, and the release
  try/finally didn't cover the acquisition phase; round 3 found no further race, independently
  executed the lease's conditional-acquire SQL against real SQLite to confirm its semantics, and
  confirmed the mechanism (a new `autohdr_manual_ingest_leases` table, ownership-tokened,
  mirroring the existing `autohdr_fetch_claims` pattern) is proportionate — a same-DO lock can't
  coordinate with repeat-send retirement, which happens in a separate Worker entirely. Diff review
  of the actual build was clean; independent verification (this session) found and fixed one more
  test-only bug (a test omitting its Dropbox-download mock, unrelated to the lease logic itself).
  `npm run typecheck`, the web build, and all four workspace/shared test suites (300 tests total:
  150 background, 101+1 skip app, 13 webhook-ingress, 35 shared) are green. Migration `0017`
  applied to prod D1 and all three Workers redeployed 2026-07-27 (background → webhook-ingress →
  app). Basic connectivity verified post-deploy; the manual-supplement-independence flow itself has
  not been live-smoke-tested against a real project (would need an actual stuck-round project and a
  real Dropbox drop into `04-MANUAL-Photos`).

- **`Gallery-Eager-Background-Preload-Plan.md`** — background preload for the RAW/Edited grid,
  lightbox filmstrip, and dashboard project covers: visible images still load first, but the rest
  of a gallery now keeps loading via a priority-aware scheduler using idle browser time, without
  requiring the user to scroll. Went through 7 plan-review rounds (Terra) before approval — most
  found real concurrency bugs (a reserved-headroom guarantee that didn't hold at drain time, a
  self-contradicting future-consumer rule, a process-global test-override that wasn't safe under
  concurrent tests) — then 2 diff-review rounds (the first caught an unauthorized doc
  reorganization the builder made on its own initiative, reverted) plus an Opus final-draft review
  that found and fixed one more real bug (`succeed()`/`fail()` ownership-check asymmetry that
  could permanently wedge a tile on its loading placeholder). Added a `thumb`-scale-only
  type-level guard (background preload can't request `web`/`original`), a new `happy-dom` DOM
  test environment for `apps/web` (previously untestable — `npm run test --workspaces` silently
  skipped it, same class of gap as `packages/shared`), and 52 tests. `npm run typecheck`, the web
  build, and the full six-workspace test suite are green.
- **`Lightbox-Neighbor-Preload-Plan.md`** — prefetches the lightbox's next/prev `/web` image
  ahead of navigation, via its own small dedicated scheduler (separate from the grid's), so paging
  through a review sequence feels instant instead of loading cold on every click. Split out of the
  gallery plan above per Terra's round-4 recommendation; went through its own 4 plan-review rounds
  (found and fixed a reincarnation of this codebase's own documented "reused DOM node releases the
  wrong permit" bug at the map-tracking level instead of the component level, closed with the same
  reference-equality-guard pattern; a radius-normalization bug in the neighbor-index math; and a
  corrected, honestly-qualified worst-case concurrency count) plus a diff review and an Opus
  final-draft review (asked to specifically hunt for the same bug class it caught in the gallery
  plan — found a latent instance in `finish()`'s permit-release logic, not reachable via the real
  call path today but fixed anyway since it's cheap and the same shape as a bug that already
  shipped once). `npm run typecheck`, the web build, and the full test suite are green.

- **The 6-feature batch (2026-07-28)** — `PhotoGrid-Select-All-Plan.md`,
  `Editor-As-Photographer-Assignment-Plan.md`, `Photographer-Stage-Visibility-Plan.md`,
  `Notice-Board-Plan.md`, `Notifications-Plan.md`, `Kanban-Priority-And-Manual-Ordering-Plan.md`
  — see "Current state" above for the full deploy summary, commits, and the real production
  migration-0020 failure/fix; each plan doc has its own build-specific detail (bugs found and
  fixed, deviations, coordination-point outcomes). All six built (five by Terra, one — PhotoGrid
  Select-All — directly in-session), independently re-verified against real Miniflare (catching
  real bugs in four of the six that the build sandboxes couldn't find), Terra diff-reviewed,
  migrated (`0018`-`0020`), and deployed (background → webhook-ingress → app). Cloudflare Email
  Service for `Notifications-Plan.md`'s email sends is now confirmed configured and live as of
  2026-07-29 (see "Current state" above) — `docs/Cloudflare-Email-Service-Setup.md` documents
  completed setup, not a pending step. `ProjectWorkspace-Asset-Tab-Sync-Plan.md` (the fuller
  architectural fix deferred out of `PhotoGrid-Select-All-Plan.md`) remains in "Open plans" below,
  not implemented.

## Open plans (see `docs/plans/`)

<!-- TB0A and TB0B shipped weeks ago (2026-08-24/25) — see the "Implemented plans" section and the
     dedicated "deployed" entries above. Their stale "not yet deployed" bullets were removed here
     2026-08-29; both plan files are in docs/plans/implemented/ and React is pinned at 19.2.8. -->

- **`ProjectWorkspace-Asset-Tab-Sync-Plan.md`** — stub only, not yet drafted as a full plan.
  `ProjectWorkspace.tsx`'s `assets` state is shared across every collection tab and only updates
  once the new tab's fetch resolves, so a render can show one collection's assets under another
  collection's controls for a window; `PhotoGrid-Select-All-Plan.md` shipped a pragmatic mitigation
  (synchronous clear-to-empty + Lightbox close-on-switch) but not the fully synchronous fix (derive
  displayed assets from a tracked `assetsKind` at render time). **Deferred by explicit user
  decision: pick up after the current 6-feature batch, not before.**
- **`Dropbox-Ingest-Concurrency-Safety-Plan.md`** — raising `quincy-ingest`'s
  `max_concurrency` above 1 so independent projects' RAW syncs can overlap. **Priority LOW, not
  scheduled**: deferred out of the RAW-Fetch speedup work above after two Terra review rounds
  found it exposes a real data-loss race (a `dropbox_sync` message for a project already
  mid-sync gets acked and dropped instead of retried). Needs a fresh trigger check before
  picking back up — see the doc for the ack fix and DLQ safety-net this would require.
- **`Cloudflare-Images-Pilot-Plan.md`** — renditions-only Cloudflare Images pilot.
  **Not recommended to proceed now**: the outage that motivated it resolved on its own, and an
  independent two-reviewer debate (Agy + Sol) on a related idea (moving originals to Dropbox)
  concluded reject — Hosted Images could cost more than the R2 storage it would touch.
- **`Multi-Role-Staff-Identity-Plan.md`** — general-purpose multi-role staff identity
  (`user_roles` join table replacing the single `role` column). **Not scheduled**: the
  immediate need (one staff member who is both photographer and editor) is already solved
  with zero code changes — `editor`'s capability set is already a strict superset of
  `photographer`'s, so setting that person's `role` to `"editor"` works today. Kept as a
  ready-to-execute reference in case the workaround's tradeoffs (unscoped project visibility,
  lost photographer-only review restriction) become a real problem.

## Reference: infra & credentials (stable, rarely changes)

- Cloudflare account `5649541c0660b8c9b45d114a868ebc13`: D1 `quincy-portal`
  (`1d36b42e-f1e6-4659-8c9e-70afe822b6fa`), KV `quincy-portal-sessions`, Queue
  `quincy-ingest`, R2 `quincy-portal-media`.
- Google OAuth client `keen-virtue-502912-m2` (secret only in password manager/Worker
  secrets, never in the repo).
- R2 S3 API token for presigned multipart uploads; credentials in gitignored `.dev.vars`.
- Repo layout: `prototype/ · portal/ · docs/ · test-data/`; `CLAUDE.md`/`AGENTS.md` are the
  project guide (kept in sync, identical content).
- Disposable QA account `tsseotsseo@gmail.com` (Photographer role), provisioned 2026-08-25 via
  Admin → Users "Provision user" — currently registered in **local dev only**, active, no project
  memberships. Exists specifically for manual QA needing a genuine second authorized session
  (cross-session polling/broadcast, access-removal reproduction); reuse for future TB-phases rather
  than provisioning another. Only the human signs into it — never an agent (standing rule).
- Production project `73ab6e89-1166-4599-bdfe-3cabc6cd7170` ("ZZZ TB3 QA Fixture — DELETE ME"),
  created 2026-08-25 for TB3's production smoke test, archived immediately after (no comments
  remain). There is no hard-delete for projects in this app; it stays archived and recoverable
  unless someone with direct D1 access chooses to purge it. Do not reuse it for future smoke tests
  — create a fresh, clearly-labeled disposable project each time and archive it afterward.
- **Pre-migration D1 recovery exports** now live outside the repo at
  `/Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/
  db-recovery/` (chosen 2026-08-25 for TB3's migration 0030, no prior convention existed). Reuse
  this same directory for future migrations' recovery exports.
