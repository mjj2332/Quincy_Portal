# AutoHDR repeat-send: overlap guard removed

**Status:** shipped and deployed to prod. **Commit:** `33d56d0` on `main` (pushed, on top of
`aea9c8a`/`aea05e8`, the original repeat-send feature). **Date:** 2026-07-27.

This is a heads-up for whoever picks up `docs/plans/AutoHDR-Manual-Supplement-Independence-Plan.md`
next (or anyone else touching `portal/workers/background/src/autohdr/`) — a small, deliberate
behavior change landed in the same area while that plan's work was paused mid-session. No file
conflict: this change touched `claims.ts`/`errors.ts`/`autohdr-claims.test.ts` only, not
`manual-supplement.ts` or `routers.ts`.

## What changed and why

`docs/plans/AutoHDR-Repeat-Send-Plan.md` §2 originally gated every repeat send on a
basename-overlap precondition: if the new selection reused a filename from a still-open
(un-associated) readiness unit in the current round, the send was refused with
`ERR_SELECTION_OVERLAPS_OPEN_DELIVERY`.

Terry decided that's more friction than the system needs: he wants repeat sends allowed as soon
as the *previous round's own Dropbox copy* has finished, filename overlap or not — and if a late
final for an old, superseded filename lands after that, it's fine for it to just overwrite
whatever's there.

That second half — the overwrite — required no new code. `writeAutoHdrFinal()`
(`portal/workers/background/src/autohdr/finals.ts`) already replaces same-Dropbox-path deliveries
in place (marks the prior asset `superseded_at`, inserts the new version) whenever the content
hash differs, and `routeAutoHdrDelta()` already re-routes a late-arriving file to whichever
mapping is currently `active` once the old one's path claims are tombstoned at retirement. So a
stale final for a reused filename lands, matches the *new* round's readiness unit by filename, and
replaces cleanly — the exact behavior Terry asked for, already in place before this change.

So the fix in `claims.ts` (`claimAutoHdrRepeatSend`) was narrower than it first looked:

- **Removed:** the basename-overlap check and its `ERR_SELECTION_OVERLAPS_OPEN_DELIVERY` throw
  (the `oldUnits`/`openAssetIds`/`oldBasenames`/`overlapping` block, and the now-unused
  `plainBasename`/`strippedBasename` import).
- **Promoted to an explicit, named check:** whether the *previous round's own send job* (the
  Dropbox `copy_batch` Workflow that copies raw files into the AutoHDR input folder) has finished.
  This condition already existed as a silent atomic guard buried in the retirement batch's SQL
  (`... AND EXISTS (... jobs j WHERE h.id = ? AND j.status NOT IN ('queued','running'))`) — it just
  failed generically as `ERR_HANDOFF_BLOCKED` with no clear message. It's now a fast, explicit
  precheck with its own code, `ERR_SEND_IN_PROGRESS` ("The previous AutoHDR send is still copying
  files to Dropbox; wait for it to finish before starting a new round").

Net effect: a repeat send is blocked only while the prior round's raw-copy is still in flight, not
by filename overlap with an unresolved delivery.

## Files touched

- `portal/workers/background/src/autohdr/claims.ts` — the change above, in
  `claimAutoHdrRepeatSend`.
- `portal/workers/background/src/autohdr/errors.ts` — swapped
  `ERR_SELECTION_OVERLAPS_OPEN_DELIVERY` for `ERR_SEND_IN_PROGRESS` in the `AutoHdrErrorCode` union.
- `portal/workers/background/test/autohdr-claims.test.ts` — the old "rejects a repeat send that
  overlaps an open prior delivery" test now asserts the send **succeeds** once the prior job is
  done; the existing "old send job still active" case now asserts `ERR_SEND_IN_PROGRESS` instead
  of the generic `ERR_HANDOFF_BLOCKED`.

No API route or frontend change was needed — `POST /api/projects/:id/send-to-autohdr`
(`portal/workers/app/src/routes/projects.ts`) already maps any non-`ERR_NO_RAW_SELECTION` AutoHDR
error code to a 409 with `{ error, code }`, and the workspace UI's generic error toast already
surfaces `result.message` as-is.

## Verification

`npm run typecheck` (all six workspaces), `npm run build -w @quincy/web`, and all four
workspace/shared test suites (`workers/background` 143 tests, `workers/app` 101+1 skipped,
`workers/webhook-ingress` 13, `packages/shared` 35 via its dedicated vitest config) are green.
Deployed same day in the required order (background → webhook-ingress → app); no D1 migration
was needed (no schema change).

## For the paused tree

Your `manual-supplement.ts`/`routers.ts` WIP (the `pending_discovery` → manual-folder promotion
work) is untouched and still sitting uncommitted in the working tree — it was stashed only
transiently during this deploy (to keep it out of the Worker bundle) and popped back immediately
after. `main` is now at `33d56d0`; rebase/continue from there whenever you resume.
