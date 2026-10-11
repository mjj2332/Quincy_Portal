**Plan for #776: Remove a Version / Video, with Trash, restore and purge (built on the owner's 2026-10-10 decisions)**
Read at `e88dc849` (in `~/quincy-wt/776-plan`), plus the open branches #774, #775, 11b, 12b, 7c and 9. All paths are under `portal/`.

**0. Facts the plan rests on**
- A Version is an `assets` row with `kind='video'` plus its `video_version_meta` row. Its `version_group_id` is the Video id.
- "Current" means `assets.superseded_at IS NULL`. Readers: `lib/video-dto.ts:30,53`, `packages/db/src/collection-count.ts:5`, the reserve SQL at `routes/video-uploads.ts:94`.
- New Version numbers are `MAX(version)+1` over every video asset (`video-uploads.ts:93`). If a purge deletes the newest row, that number would be handed out again.
- Completion supersedes only the reservation's `supersedes_asset_id` (`video-uploads.ts:343`). If a removal lands mid-upload, the Video ends up with **two current Versions**.
- `routes/assets.ts:141-146,170` already refuses to delete a video with `VIDEO_VERSION_IMMUTABLE_BODY`. Leave that as it is: Trash is a separate path.
- Every 0069 foreign key to `assets`, `videos` or `video_notes` is `ON DELETE CASCADE`. These are not: `assets.version_group_id`, `supersedes_asset_id`, `replaced_by_asset_id`, and `video_upload_reservations.video_id` / `asset_id` (the `NO_FK_ID_COLUMNS` rule).
- Video markup lives in D1 (`video_note_markup.strokes_json`). The only R2 objects per Version are the original and the poster.
- **No trash pattern exists in the Portal.** The closest restore pattern is `WhiteboardHistoryPanel.tsx`: the list is re-read every time it opens, restore is confirmed first, the request carries a fresh expected state, and the list refetches after a refusal. Reuse that shape.
- The R2 delete queue to reuse is `embedded_media_cleanup` with the drain in `workers/background/src/embedded-media-sweep.ts`; video posters and reservations already use it.

**1. PR slices.** Each one ships dark, and all land after #774, #775, 11b, 12b, 7c and 9.

**A. `feat/776-video-trash-0070`** (migration only; the owner applies it)
- Files: `0070_video_trash.sql`, `_journal.json`, `schema.ts`, `test/migration-0070.test.ts`.

**B. `feat/776-live-version-filter`** (no new routes, no behaviour change while nothing is removed)
- New `workers/app/src/lib/video-live-sql.ts` with:
  - `LIVE_VERSION(m)` = `m.removed_at IS NULL`
  - `LIVE_VIDEO(v)` = `v.removed_at IS NULL`
  - `RECOMPUTE_CURRENT_SQL(videoId, now)`
- Fold the two filters into the shared fragments: `VERSION_FROM` (`lib/video-notes-sql.ts:11`), `reachSql` (`lib/guest-fence-sql.ts:34-39`) and `LIVE_ACCESS` (`guest/read.ts:12-15`). Patch every inline join listed in §3.
- `RECOMPUTE_CURRENT_SQL`: the newest live Version of a live Video gets `superseded_at=NULL` and `replaced_by_asset_id=NULL`. Every other video asset of the group with `superseded_at IS NULL` gets `superseded_at=now`.
- Invariant: a removed Version, or any Version of a removed Video, always has `superseded_at NOT NULL`. That keeps the collection count and note counts right with no change to them.
- Upload completion (`video-uploads.ts:343`): replace the targeted supersede with `RECOMPUTE_CURRENT_SQL`, and add `UPDATE videos SET version_high_water = MAX(version_high_water, ?version)`.
- Reserve (`:93`): the new number becomes `MAX(MAX(a.version), v.version_high_water)+1`, and the Video must be live.
- Add the guard test from §5.

**C. `feat/776-video-trash-api`**
- Routes in new `routes/video-trash.ts`; SQL in new `lib/video-trash.ts`; schemas in new `packages/shared/src/video-trash.ts` (all `.strict()`).
- New part `trash` (flag `video_review_trash`) and new capability `manageVideoTrash` for Admin and Editor only. Add both to `VIDEO_REVIEW_PARTS` and `VIDEO_REVIEW_PART_CAPABILITY` (`packages/shared/src/video-review.ts:9-12`).
- Retention: `VIDEO_TRASH_RETENTION_DAYS = 30` in shared. Purge time is `removed_at + retention`, so changing the constant applies to items already in Trash.

**D. `feat/776-video-trash-purge`**
- `workers/background/src/video-trash-purge.ts`, run on the existing `0 * * * *` cron (`background/src/index.ts`).

**E. `feat/776-video-trash-ui`**
- In `components/video/`: the Remove action, both confirmations, the Undo toast and the Trash dialog. Gets a browser pass (Agy, then design-reviewer).

**2. Schema and API contract**

Migration `0070_video_trash.sql`. All additive, single-column CHECKs only (0069 precedent), no PRAGMA, `__new_` or DROP:
```sql
ALTER TABLE videos ADD COLUMN removed_at integer CHECK (removed_at IS NULL OR typeof(removed_at)='integer');
ALTER TABLE videos ADD COLUMN removed_by text REFERENCES user(id);
ALTER TABLE videos ADD COLUMN version_high_water integer NOT NULL DEFAULT 0 CHECK (version_high_water >= 0);
UPDATE videos SET version_high_water = COALESCE((SELECT MAX(a.version) FROM assets a WHERE a.version_group_id = videos.id AND a.kind='video'), 0);
ALTER TABLE video_version_meta ADD COLUMN removed_at integer CHECK (removed_at IS NULL OR typeof(removed_at)='integer');
ALTER TABLE video_version_meta ADD COLUMN removed_by text REFERENCES user(id);
ALTER TABLE video_version_meta ADD COLUMN removed_with_video integer NOT NULL DEFAULT 0 CHECK (removed_with_video IN (0,1));
CREATE INDEX videos_removed_idx ON videos (project_id, removed_at) WHERE removed_at IS NOT NULL;
CREATE INDEX video_version_meta_removed_idx ON video_version_meta (removed_at) WHERE removed_at IS NOT NULL;
```
- The `removed_at`/`removed_by` pairing and "`removed_with_video=1` only while the Video is removed" are enforced in route SQL and pinned by tests.
- The migration test asserts the migration is additive only, the backfill is right, and an FK `ADD COLUMN` works under `foreign_keys=ON`.

Every route below runs its checks in the `videos.ts` order:
1. 400 for a malformed id
2. gate with part `trash` off → 404
3. no `manageVideoTrash` → 403 (Photographers and External editors)
4. no Project access → External 404, staff 403
5. archived Project → 409 `project_archived` (writes only)
6. row → 404
7. body (`.strict()`)

| Route | Result |
|---|---|
| `GET /projects/:p/video-versions/:a/removal-impact` | `{lastVersion, uploading, notes, decisions, release:boolean, links:[{id,label}]}` |
| `POST /projects/:p/video-versions/:a/remove` with `{expected:{notes,decisions,release,links}, removeVideo:boolean}` | 200 `{video: VideoDto \| null}` |
| `POST /projects/:p/video-versions/:a/restore` | 200 `{video}` |
| `POST /projects/:p/videos/:v/restore` | 200 `{video}` |
| `GET /projects/:p/video-trash` | `{retentionDays, items:[{kind:'version'\|'video', videoId, title, assetId?, version?, versionCount?, removedAt, removedBy person, purgeAt}]}` |

Refusals:
- Remove: a counts mismatch → 409 `impact_changed {impact}`. `removeVideo` not equal to "this is the last live Version" → 409 `last_version {impact}`. Removing the Video while an upload is active on it → 409 `upload_in_progress`.
- Restore a Version: 404 when it is not in Trash or already purged; 409 `video_in_trash` when its Video is in Trash.
- Restore a Video: 404 when it is not in Trash or already purged.

Remove batch, all fenced on one audit row via `INSERT … SELECT … WHERE` (the `video-approval.ts:119` shape):
- The fence holds: the Version and Video are live, the impact counts still match, the live-Version count for `removeVideo` still matches, there is no active reservation when the Video is being removed, and the Project is not archived.
- Statements: set `meta.removed_at` and `removed_by`; when it is the last Version, also set `removed_with_video=1` and the `videos.removed_*` columns; run `RECOMPUTE_CURRENT_SQL`; run `COLLECTION_RECEIVED_COUNT_SQL`.
- **Grants, notes, decisions, Releases and memberships are not touched.** They are hidden by the read filters, so a restore brings them back exactly as they were (owner decision 2).

Restore:
- A Version: clear its `removed_*` columns, then recompute. The newest live Version is current, so restoring an older Version leaves it non-current (owner decision 4). Restoring a Version newer than the current one makes it current again; tell the owner this explicitly.
- A Video: clear `videos.removed_*` and every Version with `removed_with_video=1`, then recompute. Versions trashed individually before the Video was removed stay in Trash, each on its own clock.

Audit: target `asset` for `video_version.remove|restore|purge`; target `video` for `video.remove|restore|purge`. Meta carries the impact counts and never note text. Purge rows have a NULL actor.

Purge (slice D):
- Each run takes the oldest due items, up to 25.
- **A Version.** One batch:
  1. `INSERT INTO embedded_media_cleanup` the r2_key and poster_key, selected `WHERE removed_at < cutoff`.
  2. `DELETE FROM assets WHERE id=? AND kind='video' AND EXISTS(meta removed_at < cutoff)`. This cascades meta, notes, markup, grants, events, Releases and digest rows.
  3. Null the self-reference columns on surviving assets (the `assets.ts:150` pattern).
  4. Delete `video_upload_reservations` rows for that asset in terminal states.
  5. Write the audit row `WHERE changes()`.
- **A Video.** The same batch, but delete over `version_group_id` (there is no FK from assets to videos), then `DELETE FROM videos`.
- Fencing the DELETE on `removed_at < cutoff` makes a restore racing the purge either win or lose atomically. The R2 queue row is upserted, so if a restore wins, the drain must not delete. Gate the enqueue with `AND NOT EXISTS (live row with that key)` placed after the DELETE, and put a matching recheck in the drain classifier.
- The purge ignores flags and archive state: retention is retention.

**3. Every read path that must exclude a removed Version or Video**

Staff:
- `lib/video-dto.ts:34` (Videos), `:36-40` (Versions), `:41-44` (upload in flight). The note counts at `:28-31` come right through the superseded invariant.
- `routes/media.ts:268` `readableVideoVersion`. This covers the stream (`:276`) and the poster (`:281`). A stream that is already flowing finishes; the next Range request gets a 404.
- `VERSION_FROM` users:
  - `lib/video-notes.ts:57,64,157,170,176,244` (list, create, edit range)
  - `lib/video-note-paste.ts:38`
  - `lib/video-marker-export.ts:29` (EDL/FCPXML export)
- Inline joins in `lib/video-notes-sql.ts:48-50` (`pasteFence`) and `:65`.
- Notes reached by id: `lib/video-notes.ts:86` `findNoteHead`, `:111` `readThread`, `:140` `readNoteMarkup`, `:150` snapshot. These feed `routes/video-notes.ts:95,109,161,171,192` (reply, edit, markup, delete, resolution). A note on a removed Version → 404.
- `REPLY_INSERT_SQL` (`video-notes-sql.ts:14`): add a live-Version fence.
- `lib/video-approval.ts`: `:53` `loadDecisions`, `:65` `findVersion`, `:83-85` staff decision, `:119-123` Release INSERT (gets the fence), `:141` withdraw goes through `findVersion`.
- `lib/review-links.ts`:
  - `:35` `versionsByVideo` (the grant picker; Compare and paste pick from the filtered DTO)
  - `:60` members, `:66` grants DTO: hide removed Videos and Versions
  - `:116` `COUNT_PAIRS` (a grant to a removed Version → 422 `grant_not_version`)
  - create's Video fence
  - **`:196` the PUT-grants diff must not revoke grants on trashed Versions.** The picker can't show them, so without this an edit made while a Version is in Trash would destroy its link access for good.
- `routes/video-uploads.ts`: `:93-96` reserve (live Video, high-water), `:343` the recompute, `:404` the poster PUT.
- `GET /projects/:p/videos` is the only Version list. The Compare selects (7c), the paste source picker, the grant picker (11b) and the export menu (9) all read it, so the API filter covers them.

Guest:
- `reachSql`. Through it: every guest write fence (`guest/notes-write.ts`), `video-notes.ts:93` `findNoteHeadForLink`, `guest/read.ts:130` `readGuestThread`, and #775 `guest/download.ts:65,98,132`.
- `guest/read.ts:12-15` `LIVE_ACCESS`. Through it: `:70` stream and poster resolver, `:112` markup. Plus inline joins at `:30-35` (the Video list's EXISTS) and `:45` (released set).
- `guest/approval.ts:67-74`: the guest decision INSERT.
- #775 `guest/download.ts`:
  - `:59` `deliverableSql`: join a live Version and a live Video
  - `:151-156` `readDownloadSet` (manifest and zip): inline join
  - the zip already re-authorises before each entry, so a removal mid-zip ends it at the next entry
- Guest sessions need no change. Every guest read joins live rows, so nothing has to be revoked.

Notifications and digests:
- #774 `notification-delivery.ts:547-550` `VIDEO_REVIEW_AUTHORIZED_SQL`. Staff email digests reuse it through `email-digest.ts`, so queued or deferred items for a removed Version are suppressed.
- #774 `notification-delivery.ts:603` `videoReviewFacts`.
- #774 `lib/video-review-notifications.ts:55-64` (recipients and source checks).
- In-app rows already delivered stay. Opening one falls back to `versions[0]` (`VideoReviewViewer.tsx:81`).
- 15b's client digest (not built yet) must re-filter through `reachSql` at send.

Untouched and correct:
- `routes/assets.ts:141` (videos refused); `/media/asset/*` (404 for video).
- Service removal (`routes/projects.ts:650` counts every asset), so a Collection with Videos in Trash can't be removed until the purge.
- Project hard delete purges the whole Project prefix, which includes trashed objects. Do not filter removed rows there.

**4. Tests (red first)**

Prior art: `test/video-upload.test.ts`, `video-stream.test.ts`, `video-notes.test.ts`, `video-note-paste.test.ts`, `video-marker-export.test.ts`, `video-release.test.ts`, `review-links.test.ts`, `guest-surface.test.ts`, `guest-notes.test.ts`, `guest-approval.test.ts`, #775's `guest-download.test.ts`, `asset-deletion.test.ts`, `video-side-doors.test.ts`, `packages/db/test/migration-0069.test.ts`, `background/test/embedded-media-sweep.test.ts`, `video-upload-sweep.test.ts`, and `WhiteboardHistoryPanel.dom.test.tsx`.

- **B:** a fixture with one removed Version and one removed Video. Every route in §3 returns 404, the stub, or an absent row. A leak sweep over the serialized bytes of the staff and guest DTOs finds none of the removed ids. The invariant holds after every operation: exactly one current Version per live Video, and none for a removed one.
- **C, order matrix:** gate off, Photographer, External, unassigned staff, archived, malformed id.
- **C, behaviour:** the impact counts, the `impact_changed` and `last_version` refusals, restore of an older Version stays non-current, restore of the Video brings back only `removed_with_video` Versions, and a restore brings back grants, memberships, a live Release, decisions and notes byte-for-byte.
- **Concurrency.** Each is two real interleavings in the D1 test pool, asserting the end state:
  - Reserve with v3 current → remove v3 → complete: exactly one current (v4), the number 4 used once.
  - Remove v3 → purge v3 → next reserve: v4, not v3 (high-water).
  - Release vs removal, both orders: a Release on a removed Version is refused; a removal after a Release succeeds and the Release is hidden.
  - Guest decision lands after the impact read → 409 `impact_changed`.
  - Grant PUT vs removal, both orders. PUT while the Version is in Trash keeps that grant.
  - Stream in flight: the response finishes; the next Range is a 404 or the stub.
  - Two concurrent removals of the last two Versions without `removeVideo` → one wins, the other gets `last_version`.
  - Restore racing the purge, both orders: no R2 delete of a restored key.
  - Removing the Video with an active reservation → 409.
- **D:** an item before the cutoff is kept; after it, rows cascade (count every child table) and the keys are enqueued once. The self-references are nulled, the audit row is written, and a re-run is a no-op. Register teardown, `appRows` and audit types (`packages/db/test/qa-seed-app-rows.ts:93`), then run `npx vitest run --config packages/db/vitest.config.ts qa-seed`.
- **E (DOM):**
  - the Remove menu shows for Admin and Editor only, and only with the part on
  - the confirmation copy lists the impact; the last-Version confirmation is the Video one
  - the viewer moves to the new current Version, Compare exits if one side was removed, and the note form slot of the removed Version is retired
  - Undo calls restore
  - the Trash list shows days left; restore refreshes the list and the Videos query; a 404 on restore means it was already gone
- **Browser pass** at 1440 and 390, on `serve-branch.sh`.

**5. Risks and traps**
- **A missed read path is the main risk.** Add `workers/app/src/lib/video-live.guard.test.ts`: every SQL string in `workers/*/src` that names `video_version_meta` or joins or selects from `videos` must contain `removed_at` or a live fragment, or carry an allowlist entry that says why (trash, purge, restore, completion insert).
  - Falsify it against planted fixtures before trusting it (lessons "A guard's matcher must be validated against forms that actually exist" and "A guard widened to make a build pass is a guard that has already failed once").
  - The filters never depend on a flag: turning `trash` off hides the UI, not the filtering.
- "A cascade-only delete misses every table whose id column has no FK": `version_group_id`, the self-references and the reservation columns need explicit statements in the purge.
- "A production guard checked once at the top proves nothing about the statement that runs last": every remove, restore and purge write repeats its fence in SQL; there is no check-then-write.
- Merge the migration on its own and apply it with bookmark → `--remote` → rerun (`docs/Guides/CI-Deploy.md` §"A PR that adds a D1 migration"). B through D must not merge before 0070 is applied.
- `migration-fk-safety.guard.test.ts` bans rebuilds, so all cross-column invariants live in SQL and tests.
- Every PR runs `npm run verify` with `origin/main` merged in just before merging (the aged-worktree lesson).
- "Form lifetime is not component lifetime" and "per-Version state must not outlive its Version" (#741 5b): retire the form-store slot of a removed Version, and warn in the confirmation when that Version has an unsent draft.
- The Escape order in the viewer (`escapeSnapshot`), and #523's rule that a menu item opening a dialog returns `finalFocus=false`. Both apply to the Remove menu.
- `AlertDialog` is `role=alertdialog` (#625); `project-sheet-layers.ts` already handles it.
- The guest page (12b) must treat a stream 404 as "this Version is gone": refetch the list rather than show the unavailable screen.

**6. Decisions.** The owner has settled all four; these are the build defaults within them.
1. **Trash and purge.** Soft removal for 30 days, then a hard purge of rows and R2 objects. The hiding columns sit on `video_version_meta` and `videos`, which are video-only tables, rather than on `assets`, which photos share.
2. **Versions with activity are removable.** Nothing is cascaded or revoked at removal; everything is hidden by the read filters, so restore is exact. The one exception to "as it was" is a link that was revoked or expired in the meantime: it stays dead, because that is the link's own state.
3. **Removing the last Version removes the Video,** behind its own confirmation, sent as an explicit `removeVideo:true` so a stale dialog can't do it by accident. It is refused while an upload is active on that Video.
4. **Restore.** It is not undo-only: there is a Trash list, plus an Undo action on the success toast that calls the same restore route. Restore re-runs the current-Version recompute. Version numbers are never reused, even after a purge, because of the high-water column.

**7. Reuse ledger (slice E).** Nothing new is installed.

| Element | Item |
|---|---|
| "⋯ Remove Version…" beside the Version select | installed `components/quincy/menu.tsx` + `quincy/icon-button.tsx` |
| Remove-Version and Remove-Video confirmations | installed `reui/alert-dialog`; the impact list as `reui/item` rows; a live Release on `reui/badge` |
| Undo after a removal | `quincy/ToastViewport` action toast (`ToastViewport-action.dom.test.tsx` shows the API) |
| "Trash (n)" opener in the Video Collection header | installed `reui/button` (variant ghost, as Review links in 11b) |
| Trash list | installed `reui/dialog` + `reui/frame` + `reui/item` + `reui/scroll-area`; the "N days left" chip on `reui/badge` (warning when ≤3 days); the empty state on `quincy/EmptyState` |
| Restore button and confirmation | `reui/button` + `reui/alert-dialog`; the interaction follows `WhiteboardHistoryPanel.tsx` (re-read on open, confirm, refetch after a refusal) |
| Remover's name | the existing person label used in `VideoReviewViewer`'s details rows (no avatar) |
| Searched, not used | ReUI MCP `search` for "trash", "deleted items", "restore", "recycle bin": settings-page blocks only (the `form-*` row pattern is already composed from installed `item`, `badge` and `button`). The base-nova `sheet` was rejected because the Video Collection's other lists (Review links, 11b) are dialogs. |

The UI's raw-element count is unchanged: `ui-primitive-allowlist.ts` gains nothing.

**Next steps**
1. The owner applies 0070 (bookmark → `--remote` → rerun).
2. fast-worker builds B, then C ∥ D, then E.
3. Sol reviews each diff. E gets Agy, then design-reviewer.
4. Docs: `docs/maps/routes.md` (C), `docs/maps/queues.md` cron line (D), `GLOSSARY.md` ("Trash", "Removed Version"), and a lessons entry if any trap bites.