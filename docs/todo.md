# Quincy Portal — build tracker

Orchestration: Claude = planner/orchestrator/contract-layer; Codex/Agy = groundwork (see
`docs/Subagent-Orchestration.md`).

> **Compressed 2026-07-24.** Detailed historical narrative (bug mechanisms, review-round
> counts, full diagnostic transcripts) has been cut in favor of what/when/deploy-state. See
> `docs/lessons.md` for incident mechanics, and `docs/reviews/` for full QA-sweep detail.

## Current state (2026-07-24, batch status updated 2026-07-28, notification fix 2026-07-29, seed-admin UUID migration 2026-07-29, notification dismiss + stalled-guard 2026-07-30, download selection 2026-08-04, notice-board rich text + mentions 2026-08-17, project comments + collaboration panel 2026-08-17, project subtasks/checklist 2026-08-17, collaboration panel relocated to Project page 2026-08-17, collaboration panel UI fixes + due-time reminder 2026-08-17, notification click navigation 2026-08-17, comment ordering + Shift+Enter soft breaks 2026-08-17, mention-email content 2026-08-20, TB0 authority promotion 2026-08-24)

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
  authority/source baseline, not a revamp tracer bullet. Separate repository-native TB0A (React
  19.2 compatibility-only) and TB0B (developer-managed pipeline-order boundary) plans are not yet
  drafted; review not started. Neither phase is built or live. TB0A must not start until this
  authority promotion and its own reviewed plan are accepted, and Tailwind/shadcn must not start
  until TB0A and TB0B are live.

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

- [ ] Add `AUTOHDR_API_KEY` to the production **background Worker** before the direct-send branch
  is deployed (`cd portal/workers/background && npx wrangler secret put AUTOHDR_API_KEY`). Local
  development uses the gitignored `portal/workers/background/.dev.vars`.
- [ ] Configure Tonomo with the webhook URL:
  `https://quincy-portal-webhook-ingress.mjj2332.workers.dev/webhooks/tonomo?token=<see .prod-secrets.local>`.
- [ ] Real interactive Google browser login check at `https://quincy.flamingfire.my`.
- [ ] Rotate/retire production `BETTER_AUTH_SECRET`: still sits in gitignored
  `portal/workers/app/.prod-secrets.local` — move to password manager, delete the file.
- [x] Dropbox app registered, secrets uploaded, `sharing.read` scope added + connection
  re-authorized, first live sync confirmed working (all 2026-07-20/21).

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

- **`Revamp-TB0A-React-19-2-Runtime-Upgrade-Plan.md`** — not yet drafted; review not started.
  The scope brief exists at `docs/plans/revamp_2026_portal/roadmap/TB0A-React-19-2-Runtime-Upgrade.md`;
  no React 19 work is built or live.
- **`Revamp-TB0B-Pipeline-Configuration-Boundary-Plan.md`** — not yet drafted; review not started.
  The scope brief exists at `docs/plans/revamp_2026_portal/roadmap/TB0B-Pipeline-Configuration-Boundary.md`;
  no pipeline-order implementation is built or live.

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
