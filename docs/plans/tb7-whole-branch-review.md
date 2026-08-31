# TB7 whole-branch review

## Blocking

None.

The whole-branch integration checks are clean:

- **Server/client contracts:** POST/PATCH return `{ post, readState }` in
  `portal/workers/app/src/routes/notice-board.ts:114-115,146-147`, matching
  `NoticeBoardMutationResponse` and its consumers in
  `portal/apps/web/src/lib/notice-board-data.ts:34-35,286-318`. The server and client
  `NoticeBoardReadState` fields match exactly
  (`portal/workers/app/src/lib/notice-board-read-state.ts:1-9,79-98` and
  `portal/apps/web/src/lib/notice-board-data.ts:24-32`). The server's
  `{ error, code: "notice_board_read_target_changed" }` 409 at
  `portal/workers/app/src/routes/notice-board.ts:76-81` is retained as `ApiError.details` by
  `portal/apps/web/src/lib/api.ts:46-54` and recognized by
  `portal/apps/web/src/lib/notice-board-data.ts:335-340`. Both ends have focused coverage at
  `portal/workers/app/test/notice-board.test.ts:136-145` and
  `portal/apps/web/src/components/NoticeBoard.freshness.dom.test.tsx:376-402`.
- **Migration/deploy readiness:** current local `main` ends at 0038 in both the migration
  directory and `meta/_journal.json`; the branch adds the sole 0039 entry, with a snapshot whose
  `prevId` equals the 0038 snapshot id. `0039_notice_board_read_markers.sql:1-7` is one additive
  `CREATE TABLE` and contains no `ALTER`, drop, rebuild, copy, or backfill. The live D1 ledger was
  deliberately not queried under this review's command restrictions, so the plan's final
  pre-deploy ledger check remains mandatory.
- **Route security:** the four bare/trailing-slash GET/PATCH registrations at
  `portal/workers/app/src/routes/notice-board.ts:84-87` have four distinct `withheld` entries at
  `portal/workers/app/src/lib/terminal-route.ts:127-130`. There are no duplicate method/path keys.
  The existing dynamic manifest reconciliation test covers them
  (`portal/workers/app/test/route-manifest.test.ts:94-125`), and Slice 2 introduced no route.
- **Test-suite interaction:** Worker tests run in the Cloudflare Worker package; the client logic
  and DOM suites run in the web package's separate Node and happy-dom invocations. The new web
  suites reset mocks and dispose their query clients/roots, and Worker-only fixture IDs do not
  overlap client fixtures. No cross-file global-state or fixture collision was found. No superseded
  export was found; `/posts/latest` is intentionally server-retained for compatibility and absent
  from the production frontend polling path.

Acceptance-criteria sweep against plan §7:

- **Two-device read state — satisfied in code/tests.** D1 owns the per-user marker
  (`portal/packages/db/migrations/0039_notice_board_read_markers.sql:1-7`); authoritative state is
  computed in `notice-board-read-state.ts:47-123`; the mounted read-state query keeps polling while
  collapsed at `notice-board-data.ts:221-233`. Device convergence is exercised at
  `NoticeBoard.freshness.dom.test.tsx:620-633`, and legacy seen-localStorage non-authority is covered
  at `NoticeBoard.dom.test.tsx:269-307`.
- **Hidden/background semantics — satisfied in code/tests.** Eligibility requires open, visible,
  focused, intersecting positive geometry at `notice-board-data.ts:382-449`; generation and
  immediately-before-PATCH checks are at `:458-520,542-580`. Cached, collapsed,
  hidden/unfocused/off-viewport, stale-generation, failure, and 409 paths are covered at
  `NoticeBoard.freshness.dom.test.tsx:148-185,332-402,592-617,670-690`.
- **New notice without reload — satisfied in code/tests.** Open posts and mounted read state use the
  visible 30-second/focus/reconnect policy at `notice-board-data.ts:206-233`; open-list and collapsed
  badge convergence are covered at `NoticeBoard.freshness.dom.test.tsx:157-185,620-633`.
- **Mention delivery — satisfied and unchanged behaviorally.** The existing direct
  `notifyNoticeBoardMentions()` calls remain on POST and PATCH at
  `portal/workers/app/src/routes/notice-board.ts:112,144`; notification/outbox/Queue implementation
  files are untouched. Existing create/edit semantics remain covered at
  `portal/workers/app/test/notice-board.test.ts:256-289,317-325`, and marker actions are proven
  side-effect-free at `:229-240`.
- **Author/access rules — satisfied in code/tests.** The path-scoped `viewNoticeBoard` middleware is
  retained at `portal/workers/app/src/routes/notice-board.ts:67-69`; author-only checks remain at
  `:119-127,151-159`. Internal roles, unauthenticated/inactive users, and External Editors are
  covered at `portal/workers/app/test/notice-board.test.ts:57-90`; author-only behavior including
  ordinary Admin denial is covered at `:292-300`. No External Editor projection/navigation change
  exists in this branch.
- **Drafts — satisfied in code/tests.** Draft state remains component-owned at
  `portal/apps/web/src/components/NoticeBoard.tsx:31-39`, clears only on its own success/cancel at
  `:96-125`, and survives a remotely removed target at `:129-143`. Poll/focus/mutation/error and
  editor identity/selection preservation are covered at
  `NoticeBoard.freshness.dom.test.tsx:248-330`; failed publish retention is covered at
  `NoticeBoard.dom.test.tsx:459-469`. `RichTextEditor.tsx` is untouched.
- **Desktop/phone — no code-level regression found; manual proof remains pending.** Disclosure,
  badge, ARIA, and concrete viewport anchoring remain in `NoticeBoard.tsx:128-147` and
  `notice-board-data.ts:428-449`. The only Notice Board CSS additions are changed-target styling at
  `portal/apps/web/src/styles/app.css:493-494`; no responsive/touch rule was removed. This review is
  not the plan's real-browser desktop/phone verification.
- **Full gate/manual QA — partially complete as a process criterion.** The orchestrating session
  reports typecheck, web build, workspace tests, and shared-package Vitest green after every fix
  round; this review did not rerun them per directive. Those results are not yet recorded in a TB7
  build/QA record, and the authenticated manual matrix in plan §6 has not yet been recorded. Both
  must be recorded before deploy as required by plan §7.

## Should-fix

1. **Update the plan's stale build status before Opus final-draft review.**
   `docs/plans/Revamp-TB7-Notice-Board-Migration-Plan.md:3-6` says "ready for build" and "Not
   implemented," while `:8-10` records a correction made during Slice 2 and both slices are now
   committed. It should say built/reviewed but not deployed; it should remain outside
   `implemented/` until production matches it.
2. **Make the plan's test-preservation wording internally achievable.** The plan requires
   author-only tests "verbatim" at `:205-208` and mention/delivery tests "unchanged" at `:363-365`,
   while the mandatory response envelope at `:214-217` necessarily required test response
   unwrapping changes. The behavioral assertions are preserved. Say "behaviorally unchanged,
   adapted only for the envelope" (and keep the §7 behavior-level criterion).
3. **Decouple the historical 0038 migration test from future migrations.**
   `portal/packages/db/test/migration-0038.test.ts:78-82` now asserts that the entire directory is
   exactly `0000..0039`. Adding 0040 will force an unrelated edit to a test whose subject is 0038.
   Scope that continuity assertion through 0038, as `migration-0039.test.ts:15-27` scopes its own
   baseline. This is maintainability/test health, not a current correctness failure.
4. **Record the already-green automated gate and complete/record authenticated manual QA before
   deploy.** This is the remaining process portion of the §7 acceptance criterion, not a code
   blocker for Opus review.

The plan is otherwise internally consistent after its Slice-2 ordering correction. The companion
roadmap (`revamp_2026_portal/roadmap/TB7-Notice-Board-Migration.md:3-13,26-28`), core §9
(`revamp_2026_portal/core/06-Discussions-And-Notice-Board.md:70-72`), and revamp brief
(`Quincy-Portal-Revamp-Brief.md:241,251`) all accurately describe TB7 as a per-user read-state
migration with the direct mention path unchanged and durable global delivery deferred.

## Nits

1. `portal/apps/web/src/screens/Dashboard-notice-board.dom.test.tsx:26-30` still stubs the legacy
   `/posts/latest` request and lets the real `/read-marker` request fall through to `{ stages: [] }`.
   The test only proves the capability-gated component renders, so it still passes, but its fixture
   no longer models the server contract. Return `{ marker: null, latest: null, unreadCount: 0 }` for
   `/read-marker`, and optionally assert that `/posts/latest` was not called.

**Verdict: APPROVE WITH FOLLOWUPS.**
