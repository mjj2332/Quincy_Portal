# TB7 Slice 1 — Sol diff review 1

## Blocking

None. The production schema/server implementation matches the approved Slice 1 contract: `0039` is the next migration in both the directory and journal; the migration is the exact additive table with `PRIMARY KEY (user_id)` and no post foreign key; the snapshot differs from 0038 only by its IDs and the new table; the post allocator and marker upsert implement the specified maxima and tuple ordering with bound parameters; authoritative reads use `(created_at, id)` consistently; and the four gated bare/trailing-slash routes are classified `withheld` and dynamically reconciled by `route-manifest.test.ts`.

## Should-fix

1. **The read-marker cleanup fix is not complete per test.** In `portal/workers/app/test/notice-board.test.ts:134-148`, `createNoticeBoardPost` touches the `editorId` marker for `ownId` and the `photographerId` marker for `otherId`, but cleanup deletes only `editorId`. In lines 150-173, the deleted post touches `editorId`, while both successors touch (and the second advances) `photographerId`; cleanup again deletes only `editorId`. The third future-clock test correctly deletes both users at lines 200-201. Consequently the current full-file order can be green because test three eventually removes the leaked photographer marker before the legacy-order test, but tests one and two are individually order-dependent and can contaminate later tests if execution is focused, reordered, or fails before test three completes. Delete both marker rows in each applicable test and put fixture cleanup in `finally`/`afterEach`, since end-of-body cleanup is skipped after a failed assertion.

2. **The pre-deletion allocator test does not prove the posts high-water term.** Lines 136-145 create `...aaa1` followed by lexically higher `...aaa2` at one wall clock. If the allocator incorrectly assigned equal timestamps, tuple ordering by ID would still make the second post unread and the test would pass. Plan §6 calls for a lexically lower later UUID. Reverse the lexical relationship and assert the stored `created_at` values (or their strict relative delta), so the test fails without `MAX(posts.created_at) + 1`. The retained-marker/deletion test does use lower successor IDs and adequately exercises `MAX(markers.last_read_post_created_at) + 1`.

3. **Mutation-contract coverage is partial.** The route implementation returns `{ post, readState }` correctly, and the edit invariant test checks its `readState`, but create-route tests only unwrap `.post`. Add a direct assertion that a create response contains authoritative `readState` whose marker points through the created post and whose unread count reflects any later surviving post as appropriate. Also strengthen the monotonic-`updated_at` case with an existing future `updated_at` plus an earlier supplied wall clock, to prove the required `existing.updated_at + 1` branch rather than merely observing two naturally later `Date.now()` calls.

The future-clock tests are inherently fragile in this shared D1 fixture because the allocator consults every user's marker globally. Even after correcting the two missing IDs, precise manual cleanup remains easy to regress and does not run after an assertion failure. I would prefer an isolated database/fixture boundary for these invariants, or at minimum a shared helper plus unconditional cleanup that tracks every created post and every author/marker user. Relative ordering assertions are preferable to escalating `Date.now() + 50m/+60m/+70m` offsets. This is a test-design concern, not a defect in the reviewed allocator.

## Nits

- `portal/packages/db/migrations/meta/_journal.json` lost its final newline.
- `portal/packages/db/test/migration-0038.test.ts:81` now owns the whole-directory `0...39` assertion even though that test applies only through 0038. It works, but puts future migration-number churn in an older migration test; the contiguous/current-head assertion would be clearer in the 0039 test or a migration-ledger test.
- The three invariant tests duplicate small `create` wrappers and hand-written cleanup lists. A fixture helper that records touched authors/posts would make the global allocator dependency visible and prevent this exact omission.

Existing rich-text, mentions, notification delivery, audit, and author-only edit/delete assertions were adapted only to unwrap the required response envelope; their behavioral checks were not weakened. No other newly added test uses a far-future `Date.now()`/`wallClockMs` pattern: the three reviewed invariant tests are the complete set. The pre-existing `+10_000` and `+20_000` legacy fixtures are unchanged.

**Verdict: APPROVE WITH FOLLOWUPS.**
