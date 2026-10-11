## 1. PR slices and ownership

- Base: `origin/main@e88dc849`; land after #774, #775 and the four named UI branches; repeat the read-path inventory against their merged code.
- **API/schema PR:** add provisional `portal/packages/db/migrations/0070_video_trash.sql`, Drizzle declarations in `src/schema.ts`, QA graph/fixture registrations and migration tests; apply before deploying readers. No removals become available.
- **API/behavior PR:** add `workers/app/src/routes/video-trash.ts`, `lib/video-trash.ts`, shared active-Version SQL and `packages/shared/src/video-trash.ts`; update every reader and mutation fence below, capability/gate declarations, route manifest and collection counts.
- Add `workers/background/src/video-trash-purge.ts`, scheduled-handler integration, retention binding/types and queue suppression. Implement `readRemovalImpact`, `trashVersion`, `listVideoTrash`, `restoreVideoTrash`, `claimDueTrash` and `purgeClaimedTrash`.
- **UI PR:** add `apps/web/src/components/video/VideoVersionsDialog.tsx`, `VideoTrashDialog.tsx`, `lib/video-trash-data.ts`; wire viewer/collection entry points, confirmations, invalidation and state retirement. Both API and UI ship behind default-off `video_review_trash`.
- Update #741’s no-delete decision, relevant maps, package-domain documentation and operator instructions; the shared GLOSSARY is authoritative here, and no package `CONTEXT.md` exists.

## 2. Schema and API contract

- Create `video_trash_entries`: `id TEXT PRIMARY KEY NOT NULL`; `project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE`; `kind TEXT NOT NULL CHECK(kind IN ('version','video'))`.
- Remaining columns: `video_id TEXT NOT NULL`, `asset_id TEXT NULL DEFAULT NULL`, `removed_at INTEGER NOT NULL`, `removed_by TEXT NOT NULL REFERENCES user(id)`, `purge_at INTEGER NOT NULL`, `state TEXT NOT NULL DEFAULT 'trashed' CHECK(state IN ('trashed','purging'))`, `claim_token TEXT NULL DEFAULT NULL`, `claim_until INTEGER NULL DEFAULT NULL`.
- Checks: Version kind requires `asset_id`; Video kind requires NULL; timestamps must be integer epoch milliseconds; `purge_at > removed_at`; trashed entries have no claim, purging entries require both claim fields. Target IDs deliberately lack FKs so purge ownership survives target cleanup; register them in `NO_FK_ID_COLUMNS`.
- Indexes: `video_trash_project_removed_idx(project_id,removed_at,id)`, `video_trash_due_idx(state,purge_at,id)`, `video_trash_claim_idx(state,claim_until,id)`; unique partial indexes on `asset_id WHERE kind='version'` and `video_id WHERE kind='video'`.
- Add `videos.trash_entry_id TEXT NULL DEFAULT NULL REFERENCES video_trash_entries(id)` and identical `video_version_meta.trash_entry_id`, both NO ACTION; index each column; add partial meta index `(video_id,asset_id) WHERE trash_entry_id IS NULL`. Clear references before deleting entries.
- Add `videos.version_high_watermark INTEGER NOT NULL DEFAULT 0 CHECK(typeof(version_high_watermark)='integer' AND version_high_watermark>=0)`; backfill maximum Asset/reservation number, advance atomically when reserving, initialize at first completion. Purging must never reuse Version numbers.
- Active means **Video and Version both have NULL `trash_entry_id`**, regardless of the Trash feature flag. There is no stored current pointer: derive `currentAssetId`/`current` from highest-numbered active Version; use this for upload predecessor and visible counts without rewriting historical supersession fields.
- Remove/restore run as fenced D1 batches with audit. Block while that Video has pending/completing/aborting uploads. Last-Version removal creates a Video bundle, repoints all unexpired retained Versions, absorbs their standalone Trash entries and records original removal metadata in audit; expired/purging siblings require cleanup first.
- Purge irreversibly claims due entries before R2 deletion; expired leases remain retryable. Keep target rows/keys until original and poster deletion succeeds, then delete Assets **before** Video, terminal reservations and related FK-less queue references; delete entry last. Markup currently resides in D1 `strokes_json`, not an R2 object.
- New staff routes, all under `/api/projects/:projectId`: **GET** `/video-versions/:assetId/removal-impact` →200; **DELETE** `/video-versions/:assetId` with `{expectedImpact,confirmVideo}` →200; **GET** `/video-trash` →200; **POST** `/video-trash/:entryId/restore` →200.
- Impact contains affected Asset IDs, note count including replies, decision count/latest revision, live Release IDs, live grant IDs, absorbed-entry IDs/deadlines and `removesVideo`. Recompute and compare this exact scope in committing SQL; changed scope returns409 `removal_stale` with refreshed impact.
- Mutation results contain `trashEntry`, updated `video` or NULL, and `currentAssetId` or NULL. Trash DTOs expose kind, title/Version labels, remover, removal/deadline timestamps, state, `daysLeft` and `canRestore`; never storage keys.
- Status/error contract:400 `invalid_id`/`invalid_input`;403 `forbidden`;404 `not_found` for closed gates, missing targets or wrong-project targets;409 `project_archived`, `upload_in_progress`, `removal_stale`, `trash_cleanup_pending`, `trash_purging`;410 `trash_expired`.
- Require master/project pilot plus `trash`, Project access and new Admin/Editor-only `manageVideoTrash`; retain normal staff Origin checks and terminal registration. Reads may list archived Trash, but archived Projects cannot remove/restore.
- Audit `video_version.trash|restore|purge` and `video.trash|restore|purge`; preserve IDs, scope, deadlines and impersonation provenance, with system provenance for purge. Retention uses positive integer `VIDEO_TRASH_RETENTION_DAYS`, default30, frozen per removal; purge continues with gates closed.

## 3. Exhaustive read exclusions

- References below: `A=portal/workers/app/src`, `B=portal/workers/background/src`, `W=portal/apps/web/src`, `D=portal/packages/db/src`. Unqualified lines are base; pending references use `774=e731f914`, `775=f09eb496`, `11b=bb170ea4`, `12b=500d4644`, `7c=3b39a99d`, `9=084a1d56`.
- **Staff list/current/counts:** `A/routes/videos.ts:39`; `A/lib/video-dto.ts:23,29,34,36,42,53,63`—filter Videos, Versions, reservations and counts; assign current from active ordering.
- **Collection/service display counts:** `D/collection-count.ts:2`, `A/routes/collections.ts:72`, surfaced by `A/lib/external-project-query.ts:56,93`—count active Video currents; recount on remove, restore and purge.
- **Upload reads:** `A/routes/video-uploads.ts:89,92,94,98,169,228,404`—active existing Video/predecessor, retry completion DTO and poster lookup; repeat protection at completion323/333 and poster adoption421. Cleanup ownership checks432 remain unfiltered.
- **Staff stream/poster:** `A/routes/media.ts:268`; `A/lib/r2-serve.ts:10,16,32,38`—active lookup plus final authorization after R2 acquisition, before returning headers; retain readable historical active Versions.
- **Notes/frame metadata:** `A/lib/video-notes-sql.ts:11` (`VERSION_FROM`); `A/lib/video-notes.ts:56,62,64,65`—apply ancestor predicates directly to the separate note query.
- **Thread/note/markup reads:** `A/lib/video-notes.ts:72,85,92,140,148`—join through active ancestors; note-ID-only reads must not bypass Version protection.
- **Paste source/target:** `A/lib/video-note-paste.ts:35,38`; `A/lib/video-notes-sql.ts:45,65`—both Versions active in preview and each committing statement.
- **Marker export:** `A/lib/video-marker-export.ts:24,29`; `A/routes/video-marker-export.ts:43,57,64`—active snapshot and final export/audit admission.
- **Decisions/Release:** `A/lib/video-approval.ts:37,45,51,53,64,68,99`—events, Releases, Version list and verdict facts; repeat active fences in decision83, Release119, withdrawal141 and premium200 writes.
- **Review-link membership/grants:** `A/lib/review-links.ts:34,42,57,64,66,116`—hide removed Videos/grants and reject granting removed Versions. At190/196, revoke only omitted **active** grants; retain hidden grants. Explicit membership removal178 still revokes all.
- **Guest Video/Version DTOs/reach:** `A/guest/read.ts:12,28,31,36,43,45,69`; `A/lib/guest-fence-sql.ts:34`—active ancestors in shared reach, lists, decisions and Releases.
- **Guest notes/markup/thread:** `A/guest/read.ts:95,99,110,121`—filter the actual read statements, including reads following a separate access precheck.
- **Guest sessions/resource routes:** `A/guest/link.ts:52,76`; `A/guest/index.ts:85,119,125`—retain link-scoped sessions for sibling Videos; every resource admission rechecks active reach.
- **Guest decision admission:** `A/guest/approval.ts:67,72,73`—include active ancestors in the committing SQL, not only route reads.
- **Notification list/count/emission:** `A/routes/notifications.ts:53,55,82,83`; `774:D/external-notification-visibility.ts:119`; `774:A/lib/video-review-notifications.ts:61`—exclude removed subjects from every audience and prevent new emissions.
- **Already queued notifications/digests:** `774:B/notification-delivery.ts:546,562,591,603`; `B/email-digest.ts:175,253,283,317`—active source checks for every event kind and final send admission; removal terminally suppresses outstanding deliveries/digest items so restore cannot replay them.
- **Guest digest rows:** `D/schema.ts:2159` / migration0069:189—no executor exists at base; consume pending affected rows without sending, and require active reach in any executor added before this lands.
- **Downloads/manifest/zip:** `775:A/guest/download.ts:59,63,93,137,151,174,197,199`—filter deliverable lookup/manifest, reauthorize GET/HEAD/Range after R2 acquisition and each zip entry before acquisition.
- **Staff cached selections/drafts:** `W/components/video/VideoReviewViewer.tsx:84`; `W/lib/project-data.ts:49,145,150,431`; `W/lib/video-note-form-store.ts:524,601`; `W/lib/video-compare-store.ts:51`—invalidate/refetch, retire missing Versions, drafts, paste clipboard, offsets and media.
- **Review-link picker caches:** `11b:W/components/video/ReviewLinkCreateView.tsx:29`, `ReviewLinkDetail.tsx:90,147`—prune hidden grants and remove the fallback that fabricates “unlisted” Versions from cached IDs.
- **Compare/export UI:** `7c:W/components/video/CompareView.tsx:65,232`; `9:W/components/video/VideoMarkerExportMenu.tsx:45,79,90`—prune pairs/options, abort pending exports and reject late blob saves after removal.
- **Guest UI:** `12b:W/guest/GuestApp.tsx:41,93`, `GuestVideoScreen.tsx:47,65,75`—refresh on resource404/media failure, focus and bounded polling; use stable Video IDs, clear stale notes/selection and pause retired media.
- **Intentional retention reads:** service-delete fences `A/routes/projects.ts:648,691,701`, Project hard-delete inventory1323/1331/1373 and MCP destruction preview `A/mcp/tools/admin-writes.ts:221` must still include Trash. Ordinary photo/review/media reads already exclude native video; audit and Trash are explicit history surfaces.

## 4. Red-first tests and verification

- **DB:** follow `packages/db/test/migration-0068.test.ts`, `migration-0069.test.ts`, FK-safety/feature-flag guards and QA teardown/no-FK/verify-columns tests; prove backfill, constraints, bundle reassignment, Project cascade and permanent number monotonicity.
- **API:** reuse `workers/app/test/video-review-support.ts`, guest support and existing `video-stream`, `video-upload`, `video-notes`, `video-note-markup`, `video-note-paste`, `video-marker-export`, `video-release`, `review-links`, `guest-*`, `video-lifecycle` and route-manifest tests.
- **Background:** model claim/retry tests on `video-upload-sweep.test.ts` and `embedded-media-sweep.test.ts`; extend #774 notification tests, `email-digest.integration.test.ts` and #775 download tests.
- Key failures first: every read above returns no removed Version; historical active Versions remain readable; last-Version confirmation is mandatory; roles/gates/origin/project/archive checks; complete activity survives restore with identical IDs/revisions; newer current wins; revoked/expired access stays revoked; no successful audit on failed mutation.
- Race through held D1/R2 seams, without sleeps: removal versus reserve/completion, Release, guest decision, grant edit, note/reply/markup/paste and export. Completion-first refreshes impact; removal-first denies new uploads; active reservations block removal; every activity write has a final active fence.
- Exercise restore versus purge claim/deadline, partial R2 failure/crash/stale lease, Project hard delete, already claimed notification/digest and in-flight stream/zip. Authorization admitted before removal may finish; admission after removal fails; later zip entries are refused.
- **UI:** extend viewer/collection/notes DOM tests, compare-store/early-exit tests, ReviewLinkDetail, GuestApp and marker-export late-save tests; use `testing/video-element.ts` to prove pause, source retirement and no stale selection resurrection.
- Run focused suites per `docs/agents/runbook.md`, then `npm run verify` on integrated main; Sol reviews diff, Luna owns non-browser QA, Agy captures 1440/390 viewport states, then blind Opus design review audits screenshots and measurements.

## 5. Codebase risks and traps

- Repeat authorization inside the committing SQL: lessons **“A production guard checked once at the top proves nothing about the statement that runs last”** and **“Video notes: a reply copies its root in SQL, and delete decides hard-versus-tombstone in one batch.”**
- Purging only `videos` leaves Assets because `version_group_id` has no FK; inspect reservations/queue subjects too. Cite **“A cascade-only delete misses every table whose id column has no FK”**; service removal must remain blocked while recoverable Assets exist.
- ADR0020 keeps Version bytes immutable; ADR0021 preserves guest boundaries and next-request revocation; ADR0018 requires send-time digest authorization. Already admitted bytes/emails cannot be recalled; do not promise instantaneous cancellation of delivered content.
- Retire stores and pause media explicitly: lessons **“Escape needs an order, decided before anything runs; per-Version state must not outlive its Version,” “Form lifetime is not component lifetime,”** and **“A media element taken out of the page keeps playing…”**
- Follow ADR0014 surfaces, live style tokens, `design-system-guards`, UI primitive ratchet, registry guard, guest-boundary and routing-transport guards; navigation uses `InternalLink`/`locationStore`, and Quincy’s menu remains Quincy-owned.
- Follow `docs/Guides/CI-Deploy.md`: additive migration, no triggers/PRAGMA/table rebuild; owner-approved bookmark/remote apply before API deployment. An older Worker can expose Trash rows: close video review before rollback; code rollback is not a schema/data rollback.
- Before build, obtain the independent Opus plan required by orchestration; Opus was unavailable here. This Codex plan incorporates the verified Luna read-path audit.

## 6. Decisions and recommendations

- **Delete with 30-day Trash:** retain original/poster bytes and all activity until purge. This suits mistakes found minutes later, supports genuine restoration and bounds R2 cost; retention changes affect future removals.
- **Activity never blocks removal:** confirmation names notes/replies, decisions, live Release and Review-link access. Restore retained state, while respecting subsequent link revocation, membership removal, expiry and permission changes; suppress old notification delivery permanently.
- **Last Version removes Video:** require an additional Video confirmation. Recommend bundling previously removed, unexpired Versions into the new retention window so Video restore is complete; disclose this scope/deadline extension and preserve their original removal provenance in audit.
- **Restore through Trash only:** Admin/Editor access, no permanent-delete button or separate undo mechanism. Restore Video bundles together; restore individual Versions as non-current when newer active Versions exist. Existing Project/whiteboard restore patterns supply confirmation/refetch behavior; no asset/photo Trash implementation exists to reuse.

## 7. UI reuse ledger

- Versions and project Trash openers; Restore/retry buttons → `W/components/reui/button.tsx`; dialog containers/scrolling → `reui/dialog.tsx`, `reui/scroll-area.tsx`. Keep row actions outside the existing Version Select listbox.
- Version/Trash rows, titles, remover/time/deadline/activity metadata → `W/components/reui/item.tsx`; kind/current/expiry indicators → `reui/badge.tsx`.
- Row action trigger and “Move to Trash” menu → `W/components/quincy/icon-button.tsx`, `quincy/menu.tsx`; use installed danger/focus behavior.
- Version/activity, additional last-Video and restore confirmations → `W/lib/confirm.ts` → `W/components/ConfirmDialog.tsx` → `reui/alert-dialog.tsx`; follow lesson **“One confirm look: the AlertDialog renderer for `lib/confirm`, and what its portal does to popovers.”**
- Loading → `W/components/reui/skeleton.tsx`; empty Trash/list → `quincy/EmptyState.tsx`; failure/expired/purging messages → `quincy/Notice.tsx`, with installed buttons for available actions.
- Existing Version/Compare selects and Review-link grant checkboxes retain their installed `reui/select.tsx`/`reui/checkbox.tsx` primitives; only authoritative data and retirement behavior change. All elements fit installed components, so no registry installation or hand-built primitive is needed.