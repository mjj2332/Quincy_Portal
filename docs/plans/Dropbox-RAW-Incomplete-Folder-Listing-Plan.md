# Dropbox RAW Incomplete Folder Listing — Diagnosis + Fix Plan

**Status: NOT READY TO BUILD — and most likely never will be, because the evidence now points at
an operational fix rather than a code change.** 4 Terra rounds + a final Opus 5 session review
(2026-07-29) that re-queried production instead of re-reading the text; it corrected two factual
errors all four Terra rounds carried and added a cross-project comparison that eliminated Branch C
and demoted B and E to long shots. **Branch A (the configured folder is real but is not where the
capture set lives) is now the leading hypothesis — its fix is a corrected `raw_folder_path` and a
re-sync, no code.** Do not build against Branch B on the strength of this document. Start with the
two-minute "Fast path" check at the top of the diagnostic section; it may close this out entirely.
See "Review history" for what each round found.

Filed against a live bug report: on the "17 Oxford Street" project workspace
(`https://quincy.flamingfire.my/projects/6ff8beae-51bf-4e19-b082-f69e359d039c`), only 25 RAW
images are visible out of a reported 255 that exist for the shoot. The reporter noticed all 25
fetched images carry star ratings — that observation turned out to be a real, useful clue (see
"Ruled out" below for why it's not what it first looks like, and "Confirmed facts" for what it
actually points to).

This doc is diagnosis + a decision tree for the fix, not a ready-to-build spec — the decisive
test in "Required diagnostic step before any fix" hasn't been run yet (needs live Dropbox API
access this session doesn't have), and which fix applies depends on its result. Whoever picks
this up should run that test first, then follow the matching branch below.

## Ruled out: this is not a query/pagination/rating-filter bug

Read `GET /api/projects/:id/assets` end to end
(`portal/apps/web/src/screens/ProjectWorkspace.tsx` → `portal/workers/app/src/routes/review.ts:20-76`)
before looking at the data:

- **No pagination anywhere in this path.** `ProjectWorkspace.tsx` never sends `limit`/`page`/
  `offset`/`cursor` on any call that fetches assets. Two paths hit `GET .../assets` directly: the
  initial-load effect (line 124) and `refreshEditedCollection` (its own `apiGet`, line 104 — a
  plain on-demand fetch helper, not a poller by itself). Every other assets refresh goes through
  the `refreshAssets` wrapper (defined at line 82, its `apiGet` at line 89), called from `refresh`
  (line 101), the tab-switch effect (line 155), the admin job-polling interval (line 163), the
  AutoHDR-status poll's terminal-state branch (line 195), `syncDropbox()` after a manual sync
  (line 248, alongside a direct `refreshEditedCollection()` call and `refreshAutohdrStatus()`),
  and three JSX callbacks (`UploadDropzone.onComplete={refresh}` on the RAW tab at line 344, the
  edited-tab `UploadDropzone.onComplete` at line 346, and `CollectionPanel.onChanged` at line 349)
  — line 213 is only that effect's dependency array, not a call site. Every one of these funnels
  through the same single unpaginated `GET .../assets?collection=<kind>` call. `AssetsResponse` has no
  `hasMore`/`nextCursor`/`total` field for the frontend to act on even if it wanted to. The
  backend query (`review.ts:32-47`) has no `.limit()` call and no default page size read from the
  query string — `c.req.query("collection")` is the only param consumed.
- **No rating-based filtering or ordering.** The only conditional `WHERE` is
  `publishStatus = 'ready'` for the `edited` collection kind; `raw` only filters
  `supersededAt IS NULL`. `orderBy` is alphabetical by filename
  (`lower(originalFilename)`, then `originalFilename`, then `id`) — rating never enters the
  query at all. So "ORDER BY rating + LIMIT 25 happens to only surface rated ones" is not what's
  implemented.
- **The only literal `25` anywhere near a fetch/limit pattern in the whole repo is unrelated** —
  `workers/app/src/routes/notifications.ts:11` (`Number(c.req.query("limit") ?? 25)`), the
  notification-bell dropdown's page size. Confirmed via full-repo grep for `.limit(`, `LIMIT`,
  and page-size constants; nothing else matches.
- `PhotoGrid.tsx`'s client-side "Rated" filter chip only affects what's rendered from an
  already-fetched `assets` array — it doesn't touch the fetch or the "N frames" counter, so it
  can't produce this symptom either (worth a 5-second check on reproduction: confirm the "All"
  chip is active, not "Rated", but this is not the cause).

**This was confirmed against the actual production database, not just the code** — see below.

## Confirmed facts (queried directly against prod D1, `quincy-portal`, 2026-07-29)

```sql
SELECT c.kind, count(*) total,
  sum(case when a.rating_from_metadata is not null then 1 else 0 end) rated
FROM assets a JOIN collections c ON a.collection_id = c.id
WHERE c.project_id = '6ff8beae-51bf-4e19-b082-f69e359d039c' GROUP BY c.kind;
-- raw | 25 | 25
```

- **There are genuinely only 25 rows in `assets` for this project's `raw` collection.**
  `collections.received_count` (also 25) agrees with the row count — the portal's own count is
  internally consistent. The "255" the reporter is comparing against is **not** a portal
  miscount; it's a number from outside the `assets` table (see the required diagnostic step).
- **Every one of the 25 rows lives in exactly two single-level subfolders**, `NOTES/` (7 files)
  and `PROOFSHEET/` (18 files) under the registered `raw_folder_path`
  (`/tonomo/raw files/igor melo/12-06-2026/17 oxford st, bondi junction nsw 2022, australia`).
  No files at folder root, no other subfolders.
- **Filenames are `NOTE.DJI_<timestamp>_<seq>_D_28Jul[...].jpg` /
  `PROO.DJI_<timestamp>_<seq>_D_28Jul.jpg`.** The `DJI_` infix is a stock drone-camera filename
  pattern; the `NOTE.`/`PROO.` prefixes and the fact that near-identical seq numbers (e.g.
  `_0033_`) appear in **both** folders strongly suggest these are auto-generated proof-sheet and
  note-overlay derivatives from a drone capture/review tool — not the primary listing-photo
  capture set.
- **`rating_from_metadata` is `1` for all 25, with zero variation.** A tool stamping a uniform
  placeholder rating into its derivative exports explains this far better than 25 independently
  photographed, independently rated real images all landing on exactly 1 star. This is the
  mechanism behind the reporter's "all fetched images have star ratings" observation — it's not
  that rated images were selectively fetched, it's that the entire ingested set happens to be a
  same-origin batch that all carries the same stamped rating.
- **Five `dropbox_sync` jobs ran for this project across three days, all `status = 'done'`, all
  `error IS NULL` — four of which actually performed a Dropbox listing.** Full timeline, queried
  from prod `jobs` plus `assets.created_at` (all times UTC):

  | Job | Window | Runtime | Trigger | Outcome |
  |---|---|---|---|---|
  | `39bffdf6…` | 07-27 05:07:26→05:07:34 | 8.4s | `dropbox_delta` | listed, imported nothing |
  | `4fbc8679…` | 07-28 23:29:43→23:29:49 | 5.4s | `dropbox_delta` | listed, imported nothing |
  | `fe829763…` | 07-28 23:30:18→23:31:36 | 78.8s | `dropbox_delta` | **imported all 25** |
  | `6ad53f81…` | 07-29 00:01:07→00:01:31 | 24.3s | manual (`payload_json: null`) | listed, imported **zero** |
  | `a21a5c4d…` | 07-29 00:01:34→00:02:06 | 32.2s | redelivery | **no listing at all** (see below) |

  All 25 assets were created between 07-28 23:30:26 and 23:31:35 — entirely inside `fe829763`'s
  78.8-second window. Nothing has been ingested for this project since.

  `syncProjectRawFolder` writes a `payload_json` note when a run either (a) hits
  `MAX_DOWNLOADS_PER_RUN` (120) and enqueues a continuation (`sync.ts:251-254` sets
  `continuationEnqueued = true` only from inside the `downloadsThisRun >= 120` branch, so by
  construction `downloadsThisRun` is already ≥120, not 0, whenever this fires — the outer
  `downloadsThisRun > 0` guard at `sync.ts:292` is therefore redundant in the current code, not a
  distinct edge case), or (b) skips files nested 3+ subfolder levels deep (`skippedSubfolderFiles`,
  from `sectionForDropboxFile`'s depth cap, `sync.ts:86-99`). **Neither note appears on any run.**
  Separately, the loop has two silent exclusion paths with no telemetry at all: the
  `.jpg`/`.jpeg`-only extension filter (`isAcceptedPhotoFilename`, `sync.ts:207`, backed by
  `packages/shared/src/media.ts:19-25`, deliberate per Decision D-01 — "photo ingest is JPEG-only,
  camera RAW never enters the portal" — not a bug, but a real source of "255 files visible in
  Dropbox, fewer than 255 eligible"), and the content-hash/source-path reconciliation path
  (`sync.ts:213-247`), which updates an existing row rather than creating a new one when
  Dropbox's `content_hash` (or, absent that, the stored source path) already matches an ingested
  asset — so duplicate or re-exported copies collapse to one row silently.

- **The decisive record is `6ad53f81…`, and it is much stronger evidence than "a stable row
  count."** Its `payload_json` is `NULL`, which under `sync.ts`'s control flow is only reachable
  on the full-success path (`setJobStatus(done)`, `sync.ts:334`) having written *neither*
  optional note — the claim-collision short-circuit always writes a non-null
  `reusedClaimOwnerJobId` payload (`sync.ts:159-163`), and a failure sets `status = 'failed'`.
  So this run provably: completed a full `allFolderFiles(rawFolderPath)` recursive listing;
  found **zero** files nested 3+ levels deep; did **not** hit the 120-download cap; and created
  **zero** new assets (no `assets` row carries a `created_at` in its window). It ran **30 minutes
  after** the 25 were ingested, on the manual path — `POST /api/projects/:id/sync-dropbox` →
  `triggerDropboxSync()` (`workers/background/src/index.ts:59-69`), which creates its job with no
  payload and calls `syncProjectRawFolder` directly, **entirely independent of the delta
  monitor's durable cursor**. Its 24.3-second runtime is itself corroborating: a reconcile-only
  pass costs roughly a second per file in D1 round-trips, so ~25 files ≈ ~24s fits, while a
  listing returning 255 files could not have finished in that time *and* would have been forced
  to download the ~230 it had never seen, hitting the 120 cap and writing the continuation note.
  **Conclusion: a fresh, authenticated, cursor-independent recursive listing of the exact
  configured `raw_folder_path` returned only this small set.** That is a direct constraint on
  Dropbox's own response, not an inference from row counts — and it effectively eliminates
  Branch C for *this* project (see the branch prioritisation below).

- **Side finding, not this bug's cause — worth its own follow-up.** `a21a5c4d…` is a *redelivery*
  of a message carrying an already-used `jobId`: its payload is
  `{"reusedClaimOwnerJobId":"a21a5c4d…"}` — the owner it found is **itself**. Per
  `sync.ts:139-168`, that means a second entry into `syncProjectRawFolder` with the same
  `trackingJobId` hit the claim's UNIQUE constraint against a `running` claim its own earlier
  attempt had inserted (the stale-lease sweep at `sync.ts:136-137` didn't clear it, so that claim
  was under the 15-minute `RAW_CLAIM_LEASE_MS`). The retry then marked the job `done` and returned
  `claimed: false` **having performed no listing** — i.e. a redelivered attempt can report success
  while doing nothing, and the earlier attempt that left the claim behind never ran its own catch
  block (which would have marked the claim `failed`), suggesting it was killed rather than failing
  cleanly. This is adjacent to the known ack/retry gap in
  [`Dropbox-Ingest-Concurrency-Safety-Plan.md`](Dropbox-Ingest-Concurrency-Safety-Plan.md) — add
  it there as a concrete observed instance rather than fixing it inside this plan's scope.

## Cross-project comparison — two anomalies unique to this project (prod D1, 2026-07-29)

Added in the final review round. Both come from D1 alone, needed no Dropbox access, and together
they re-rank the branches more than anything else in this document.

**1. This is the only project in the entire database with no `Listing Images` section.** Section
breakdown across every project with RAW assets:

| Project | RAW | Sections |
|---|---|---|
| 168 Botany Street | 192 | `Listing Images`, `/EXTRAS`, `/ADDITIONAL`, `/NOTES` |
| 28/40 Victoria Street | 192 | `Listing Images`, `/extras`, `/notes` |
| 3/9 Chicago Avenue | 130 | `Listing Images`, `/extras`, `/notes` |
| 4 McGowen Avenue | 119 | `Listing Images`, `/drone selects`, `/EXTRAS`, `/NOTES` |
| 6/120 Beach Street | 81 | `Listing Images`, `/EXTRAS` |
| 243 Victoria Road | 43 | `Listing Images`, `/EXTRAS`, `/NOTES` |
| 225-227 Victoria Road | 40 | `Listing Images`, `/EXTRAS` |
| **17 Oxford Street** | **25** | **`NOTES`, `PROOFSHEET`** — no `Listing Images` |
| 12 Brompton Road | 17 | `Listing Images` |

The studio's convention is unambiguous: the actual capture set lives at
`<raw_root>/Listing Images/*.jpg` (section `Listing Images`), with `EXTRAS`/`NOTES`/`drone
selects` as *children of it*. 17 Oxford has `NOTES` and `PROOFSHEET` at the **top level** and no
`Listing Images` folder at all. Since `skippedSubfolderFiles` was `0` on every run, no JPEG under
this root was 4+ levels deep either — so this isn't a `Listing Images` folder hiding below the
depth cap. **The folder where every other shoot's photos live was simply not present in what
Dropbox returned for this root.**

**2. The ingested files post-date the shoot by ~6.5 weeks.** `shoot_date` is `2026-06-12` and the
folder is `.../igor melo/12-06-2026/...`, but the 25 files are DJI captures stamped `20260728`
and were ingested 2026-07-28. Every other project's ingest lands within days of its shoot date.
A June shoot's folder received July drone derivatives.

**What this does to the branch ranking — this is the most important paragraph in the document:**

- **Branch B drops sharply.** The *same connection*, under the *same* `/Tonomo/Raw Files` root,
  successfully lists and ingests two-level-deep content (`Listing Images/EXTRAS`) for eight other
  projects across three different photographers' folders. Recursive traversal demonstrably works.
  For B to be the cause, the failure would have to be scoped to one specific subfolder of one
  project — possible if that one folder is independently mounted, but no longer the systematic
  traversal bug the branch was written around.
- **Branch E drops sharply, both sub-cases.** The resolved connection sees `igor melo`,
  `christian quinlan`, and `andrew vassiliades` folders fine, and resolves deep paths correctly
  across all of them. Neither an account-visibility nor a namespace-resolution problem is
  consistent with that.
- **Branch A (narrowed) is now the leading hypothesis by a wide margin**, with Branch D as the
  secondary. The coherent story: the 12 June listing shoot's photos were never uploaded to this
  folder (or live under a different path), and on 28 July someone dropped drone proof/note
  derivatives into it. The reporter's "255" would then describe a folder the portal was never
  pointed at.

**Consequence for build readiness: the most likely outcome of the diagnostic is now that no code
change is required at all** — this looks like a data/operations problem, not an ingestion bug.
Do not build anything against Branch B on the strength of this document.

## Root causes not yet ruled out — the "255" figure itself is unverified

"255" is a number the reporter supplied from outside the system, and it still hasn't been checked
against what Dropbox's API returns for the exact configured path using the exact connected
account/namespace and path-root. Five concrete, code-grounded, **non-exclusive** branches follow
(A/B/C/E affect what Dropbox returns or how the app resolves it; D affects what a human sees vs.
what's eligible even once returned correctly).

**Two constraints from the `6ad53f81…` evidence above narrow this list before the diagnostic even
runs, and the next agent should not re-litigate them:**

- *The configured path resolves and returns real content.* The listing succeeded and returned
  `NOTES/` and `PROOFSHEET/`, so this is not a typo'd or nonexistent path — Dropbox would have
  thrown `path/not_found` (handled at `dropbox/client.ts:515`). Branch A therefore survives only
  in its "path points at a real folder that isn't where the captures actually are" form, not its
  "path is broken" form. For the same reason **Branch E sub-case (ii) (wrong namespace/team root)
  is now unlikely**: a path-root mismatch would almost certainly fail to resolve this very
  specific nested path at all rather than resolve it to a plausible-looking folder — keep it as a
  cheap check in diagnostic steps 1-2, not as a leading hypothesis.
- *Branch C is effectively eliminated for this project.* The manual run bypassed the delta cursor
  entirely and still saw only this small set, so a cursor/routing miss cannot explain the missing
  files here. It stays in this document only as a **general** risk worth guarding for *other*
  projects that have never had a manual sync — not as a candidate for this incident.

Then the cross-project comparison above demoted B and E as well. **Net ranking going into the
diagnostic: A (narrowed) is the leading hypothesis, D is the plausible secondary, B and E are
long shots retained only because the diagnostic checks them for free.** Distinguishing them is
still the point of the diagnostic below — but expect an operational fix, not a code one.

- **Branch A — wrong/stale `raw_folder_path`.** The 255 real capture photos are simply not
  inside the folder the portal is configured to sync — `raw_folder_path` was set to (or drifted
  to) the wrong Dropbox path, or the photographer's actual capture upload landed in a sibling
  folder Tonomo never communicated. A **data/configuration problem**, not an ingestion bug.
- **Branch B — recursive listing doesn't cross a shared/mounted-folder boundary
  (unverified hypothesis, not a confirmed mechanism).** `docs/lessons.md` ("Dropbox 429 burst
  amplification", 2026-07-25) documents that content served from a Dropbox **shared folder
  mounted via `sharing.read`** can be rate-limited differently from content in the connection's
  own namespace on authenticated calls — that entry establishes a *traffic/rate-limit*
  difference for shared-folder content, **not** that `files/list_folder(recursive: true)` fails
  to traverse into a mount point. Treat "recursive listing skips mount boundaries" as a plausible
  but unconfirmed hypothesis needing direct verification (see diagnostic step), not an established
  fact to design a fix around yet. Compounding the uncertainty: `DropboxFolder`
  (`dropbox/client.ts:35-41`) only retains `.tag`/`name`/`path_lower`/`path_display`/`id` from
  each folder entry — any `shared_folder_id`/mount-indicating field Dropbox's API response
  actually includes is discarded before the app code ever sees it, so today's code has no way to
  even detect a mount boundary if one exists.
- **Branch C — Dropbox delta-monitor cursor/routing miss (automatic syncs only, narrower than it
  first looks).** The raw delta monitor (`DropboxSyncDO.alarm()`, `do/dropbox-sync.ts:120-186`)
  either continues an existing cursor (`listFolderContinue`) or, when no cursor is stored yet,
  performs its own initial `recursive: true` listing of the whole `watchedRoot` and routes every
  entry on that first page through `changedProjectIds()` (`do/dropbox-sync.ts:140-150` and
  `:155-159`) — so "a cursor established after files were uploaded" is *not*, by itself, a miss:
  establishing a cursor already involves one full listing pass that would route this project if
  its files were present under `watchedRoot` at that moment. The real miss conditions are
  narrower: this project's `raw_folder_path` being registered (or corrected) *after* that
  baseline listing already ran, files landing outside `watchedRoot` entirely, a delta page that
  legitimately lists the change but `changedProjectIds()` fails to match it against
  `rawFolderPath` (e.g. a path-normalisation mismatch) leave no *project-specific* job or alert —
  nothing ever ran to fail on this project's behalf. That said, even these "silent" cases aren't
  completely invisible at the connection level: every successfully processed page, matched or
  not, updates `dropbox_monitor_health` with `scannedCount`/`matchedCount`/`skippedCount`/
  `routedProjectCount`/`lastSuccessfulPageAt` (`do/dropbox-sync.ts:226-258`) — so an operator
  checking that table would see healthy, ongoing scan activity, just with `routedProjectCount`
  never crediting this project. **A genuine, unrecovered listing/continuation exception is a
  separate case, more visible still**: `DropboxSyncDO.alarm()`'s outer catch block
  (`do/dropbox-sync.ts:275-294`) records `dropbox_monitor_health.lastError`, schedules a retry
  via `alarmRetryDelay()`, and logs to console — but a `DropboxCursorResetError` specifically is
  recovered inline first (`do/dropbox-sync.ts:146-150`, discarding the stale cursor and
  re-listing from `watchedRoot` fresh) and never reaches this outer catch, so only an
  *unrecognized* thrown error surfaces this way; a plain cursor reset self-heals silently by
  design. So a hard, unrecovered continuation failure is operator-visible via `lastError`, while
  both a clean reset-recovery and a routing/registration-timing miss leave no error, only ordinary
  scan telemetry with this project absent from it. **None of this explains the current state of
  this project** — see the prioritisation note above: `6ad53f81…` bypassed the cursor entirely
  (manual trigger, its own fresh `allFolderFiles` recursive listing) and provably still saw only
  the small set, so no cursor or routing failure can account for the missing files here. This
  branch is retained purely as a **general** risk for *other* projects that rely on the automatic
  delta path and have never had a manual sync run — if that's worth hardening, do it on its own
  merits, not as part of this incident.
- **Branch D — extension/dedup mismatch inflates the human-visible "255."** Ingest is
  deliberately JPEG-only (Decision D-01, enforced by `isAcceptedPhotoFilename`,
  `packages/shared/src/media.ts:19-25`) — camera RAW files (`.CR2`/`.NEF`/`.ARW`/etc.) sitting
  alongside JPEGs in the same Dropbox folder would appear in a human's file count but never in
  `assets`, by design, not by bug. Similarly, files that are byte-identical or path-recognized
  duplicates of an already-ingested asset collapse into the existing row
  (`sync.ts:213-247`) rather than adding a new one. Neither of these is a defect to fix — they're
  reasons "255 files visible" and "N eligible" can legitimately differ — but the diagnostic step
  needs to account for them before concluding Branch A, B, or E explains the *entire* gap.
- **Branch E — the studio's single Dropbox connection can't see where the files actually are.**
  `getConnection()` (`dropbox/client.ts:315-334`) resolves to one row per provider whenever no
  `connectionId` is explicitly passed — the oldest `integrationConnections` row with
  `encryptedCredentials` set, with no filter on any connection-status field (so "the resolved
  connection" is the precise claim; "the active connection" overstates what the query itself
  guarantees if that schema has more than one row in practice) — and neither the manual-sync
  route nor the delta monitor's default path passes a `connectionId`, so in practice this studio
  resolves to one Dropbox account for every project's sync. Two distinct sub-cases fall under
  this branch: **(i) a genuinely different account** — the photographer (Igor Melo, per the
  Tonomo order sample) uploaded the real capture files into a Dropbox location the resolved
  account can't see at all without an explicit share (a personal account, a different team, or a
  folder never shared into the connected account); **(ii) the same account, wrong namespace/team
  root** — the resolved account *can* see the files, but `createDropboxClientContext()`
  (`dropbox/client.ts:452-478`) resolved the wrong `pathRootHeader` for this particular call (or
  none, when one was needed), so the path is being interpreted relative to the wrong namespace
  root even though the underlying account has access. Both sub-cases mean the connected account's
  `list_folder` call would never return the real files, full recursive traversal or not — this is
  a distinct mechanism from Branch B (which is about *whether a boundary the account can already
  see, in the namespace it's already resolved to, gets traversed*) and doesn't depend on any
  traversal bug existing. Unlike A/B/C, this is primarily a **permissions/access or
  namespace-resolution problem**, not a path-string or traversal-algorithm problem — the
  diagnostic step's same-account requirement (step 5 below) is what would surface sub-case (i);
  sub-case (ii) needs the path-root header explicitly checked against what the account's own
  `root_info` says it should be (diagnostic step 1-2), not just inferred from a same-account
  human browse.

## Required diagnostic step before any fix (not yet run — needs live Dropbox access)

The `6ad53f81…` evidence establishes *that* Dropbox returned only a small set for this path, and
rules out Branch C — but not *why*. The extension filter and dedup/reconciliation (Branch D)
remain live alongside B, E(i), and the narrowed form of A, and they need different fixes
(operational path correction vs. code change vs. no fix at all vs. an access/sharing fix).
**Fast path — try this first; it may end the investigation in two minutes.** Have someone open
Dropbox and look at
`/Tonomo/Raw Files/Igor Melo/12-06-2026/17 Oxford St, Bondi Junction NSW 2022, Australia/` and
answer one question: **is there a `Listing Images` subfolder, and does it contain the ~255
photos?**
- *No `Listing Images` folder, and only `NOTES`/`PROOFSHEET` are there* → Branch A confirmed. The
  photos are elsewhere; find the real folder (ask Igor Melo, or check whether a 12-06-2026 shoot
  folder exists under a different path) and go to Fix branch A. No code required.
- *`Listing Images` is there with the photos in it, visible to the same account the app uses* →
  that is the Branch B/E case after all, and the full protocol below becomes necessary. Treat
  this outcome as surprising given the cross-project evidence, and re-verify the account you're
  signed in as before concluding it.
- *`Listing Images` is there but holds camera RAW/non-JPEG files* → Branch D; no bug.

Only if the fast path is inconclusive, run the full protocol, using the project's exact connected
Dropbox account:

1. Identify which `integrationConnections` row the app actually resolves for this sync
   (`getConnection()`, `dropbox/client.ts:315-334` — the canonical row per provider unless a
   specific `connectionId` is passed, which today's callers don't) and which Dropbox
   account/email that row authenticates as. This is what step 5 needs to match. For this project
   the runs recorded `connectionId: ea29a4dd-f6e8-4c7a-a804-2a3f4b31ef39` in their delta-job
   payloads — confirm that's still the row that resolves today.
2. Resolve the client context exactly as `syncProjectRawFolder` does —
   `createDropboxClientContext()` (`dropbox/client.ts:452-478`), which resolves the account's
   `root_info` and sets `pathRootHeader` (a `Dropbox-API-Path-Root` header) whenever the account
   has a team root distinct from the member's home namespace. **Use the same header on every
   diagnostic call** — comparing a plain home-namespace listing against a human browsing in a
   different (e.g. team) namespace would falsely look like a mount-boundary or wrong-path
   problem when it's really a namespace mismatch.
3. Call `files/list_folder` with `recursive: true` on the exact `raw_folder_path`, fully draining
   `has_more`/`list_folder/continue` the same way `allFolderFiles` does (`sync.ts:73-82`), and
   **capture the raw JSON response**, not just the fields the app's `DropboxFolder`/`DropboxFile`
   types keep — those types currently drop anything that might indicate a shared-folder mount.
   Record: total entry count, count broken down by extension, and count broken down by folder
   depth relative to the root.
4. Separately call `recursive: false` at each folder level down the tree (not just the root) and
   inspect each folder entry's full raw metadata for any shared-folder/mount indicator Dropbox's
   API returns, since a single top-level `recursive: false` call alone would make an *ordinary*,
   non-mounted nested subfolder (e.g. a plain `Captures/` folder two levels down) look identical
   to a "missing" mount boundary — it is not sufficient on its own to distinguish Branch A from
   Branch B.
5. Have a human browse the identical path in the Dropbox desktop/web UI, **signed into the exact
   account identified in step 1** — not a different team member's view, which can see a
   different mix of mounted shares, and not the photographer's own account without first
   confirming it's the same one the connection uses. If the human has to sign into a *different*
   account than the app's connection to see the full 255, stop and record that directly — it's
   Branch E regardless of what the recursive listing shows.
6. Diff the two: files present in the UI but absent from the API recursive listing (same
   account) → Branch B evidence. Files/folders simply not under this path at all in either →
   Branch A. Extra non-JPEG or duplicate-content files present in the UI count but absent from
   `assets` even though the API listing does return them → Branch D, not a bug. The UI only
   showing the full set under a different signed-in account → Branch E.

These branches are not mutually exclusive — run the full comparison once; more than one may
apply (e.g. the path is subtly wrong *and* a subset of what's there is non-JPEG).

## Fix branch A — wrong/stale `raw_folder_path`

**Now the leading hypothesis** — see the cross-project comparison above.

1. Confirm the correct Dropbox path with the studio and update `projects.raw_folder_path`.
   Concretely: every other shoot stores its capture set at `<raw_root>/Listing Images/`, and this
   project has no such folder, so ask Igor Melo where the 12 June 17 Oxford Street listing photos
   were actually uploaded. Note the shoot date (2026-06-12) predates the ingested drone files
   (2026-07-28) by ~6.5 weeks — worth asking whether the June shoot was rescheduled, reshot, or
   filed under a different date folder, since `raw_folder_path` embeds `12-06-2026`. Also worth
   checking whether `raw_folder_link` (this project has one) points somewhere different from
   `raw_folder_path`; `pathFromRawFolderLink()` (`sync.ts:44-62`) is only consulted when
   `raw_folder_path` is empty, so a correct link would be silently ignored today.
2. Re-run `syncProjectRawFolder` (existing manual "Sync from Dropbox" button, per
   `Unified-Dropbox-Fetch-Plan.md`, already shipped) and confirm the asset count converges
   toward 255 (allowing for `isAcceptedPhotoFilename`'s `.jpg`/`.jpeg`-only filter and any
   genuine dedup).
3. **Hardening, so this doesn't reach a client silently again — extend the existing
   count-mismatch banner rather than build a parallel heuristic system.** The portal already has
   an expected-vs-received warning: `GET /projects/:id/ingest-status`
   (`workers/app/src/routes/uploads.ts:155-186`) computes `mismatch` **only for the no-manifest
   path** — `collections.expected_count IS NOT NULL AND expected_count != received_count`
   (`uploads.ts:180-185`) — and `ProjectWorkspace.tsx:340` renders it ("Capture count needs
   attention. Expected X, received Y."). Note this route has a *second* branch
   (`uploads.ts:188-198`) that instead sums `upload_manifests.expected_count`/`received_count`
   whenever manifests exist for the collection (i.e. browser-uploaded batches, not Dropbox-sourced
   ones) — any hardening here must preserve that branch, not just extend the `collections`-level
   field, or it would silently do nothing for manifest-tracked collections. **Confirmed live on
   this exact project (Dropbox-sourced, no manifests, so the first branch applies):
   `collections.expected_count` is `NULL`** (queried directly against prod D1), so this banner is
   silently inactive here even though the business apparently already knows the real expected
   count is 255 — `expectedCountFromFolder()` (`sync.ts:64-71`) only populates `expected_count`
   when the Dropbox folder *name* itself carries an `[expected N]`/trailing `- N` convention,
   which this folder's name doesn't have. The actionable hardening is closing that gap, not
   inventing a new mechanism: when a trustworthy expected count is available from elsewhere (e.g.
   Tonomo's order payload, if it carries a capture-count field — check
   `prototype/uploads/Webhook-data-with-dropbox-raw-folder.md` and the live webhook payload shape)
   but the folder-name convention doesn't supply one, populate `expected_count` from that source
   too, so the existing banner fires instead of staying silent. **Whatever source is used, its
   count must be in the same unit `received_count` measures — eligible ingested assets — not a raw
   Dropbox file count (which would include non-JPEGs, per Branch D) or a Tonomo package/order
   quantity (e.g. this project's Tonomo sample shows a "15x Daylight Images" *delivery* package
   tier, an unrelated number to raw capture count) — using a mismatched unit would manufacture
   false warnings on healthy projects.** Treat a uniform rating value or a `NOTE.`/`PROO.`-style
   filename prefix only as a **secondary, non-blocking diagnostic hint** surfaced alongside the
   existing banner (e.g. in its detail text) when both conditions independently suggest something
   off — never as a standalone trigger, and never as anything that blocks or delays ingestion
   itself. A uniform rating is not proof of a wrong folder on its own.

## Fix branch B — recursive listing doesn't cross a shared/mounted-folder boundary

1. Reproduce directly: call `files/list_folder` with `recursive: false` on `raw_folder_path`,
   inspect each returned subfolder entry's metadata (a Dropbox API mount point typically appears
   as a distinct `shared_folder_id`/namespace on the folder entry, not merely a plain subfolder)
   to confirm which child folder is the mount boundary.
2. If confirmed, `allFolderFiles` (`sync.ts:73-82`) needs to stop relying on a single
   `recursive: true` call for the whole tree. Options, in rough order of invasiveness:
   - Walk one level at a time (`recursive: false` per directory, recursing manually in code) so
     each subfolder boundary — including a mount point — gets its own explicit `list_folder`
     call instead of depending on Dropbox to traverse it implicitly.
   - Or, keep the single recursive call for the common case but detect mount-boundary folder
     entries in the results and issue a follow-up `list_folder` scoped to each one.
3. Whichever approach is chosen, add a regression test using a mocked Dropbox client that
   returns a mount-boundary folder entry among ordinary entries, asserting the sync still
   ingests files inside it.
4. This is the same class of "shared-folder content behaves differently from owned content"
   territory already noted (for a rate-limiting effect, not confirmed traversal failure) for
   AutoHDR delivery in `docs/lessons.md` — cross-reference that entry in the eventual fix's
   commit/plan for provenance, and check whether AutoHDR's own delivery-folder listing
   (`workers/background/src/autohdr/*`) has the identical exposure once Branch B is actually
   confirmed, since it's a different code path built against the same Dropbox API.

## Fix branch C — delta-monitor cursor/routing miss

If the diagnostic finds `dropbox_monitor_health`/the DO's stored cursor for the raw scope is
stale, records a `lastError`, or shows registration/routing timing consistent with a missed
delta page: this doesn't necessarily need a `sync.ts` change — the manual path uses its own
independent `allFolderFiles` recursive listing rather than the DO's cursor, and the available job
evidence (see the caveats above) is *consistent with* it seeing the complete candidate set on at
least one run, though that's inferred from a stable ingested-row count across runs, not proven by
a logged file count. If manual sync turns out to genuinely resolve the gap, the fix is either
operator-level (re-trigger a manual sync whenever cursor health looks suspect for a project) or a
small robustness addition such as a periodic reconciliation sweep for projects
that haven't had *any* successful sync since their `raw_folder_path` was last set, so an
automatic-only project isn't silently stuck the way this one might have been for a window of
time. Do not build this speculatively — confirm the cursor was actually implicated first.

## Fix branch D — no fix; diagnostic-only

If the gap is fully explained by non-JPEG files and/or duplicate-content collapsing, there is no
bug to fix. Optionally surface the JPEG-only policy more visibly in the "Sync from Dropbox" UI
(e.g. a one-time note distinguishing "255 files in Dropbox" from "N eligible JPEGs") if this
turns out to be a recurring point of confusion for staff, but that's a UX nice-to-have, not a
correctness fix — don't build it unless the diagnostic shows this is actually a meaningful chunk
of the gap here.

## Fix branch E — connected account can't see where the files are

Two different actions depending on which Branch E sub-case the diagnostic found:

**Sub-case (i), genuinely different account** — an access/sharing problem, not primarily a code
problem:

1. Confirm with the studio which Dropbox account holds the real capture files, and whether that
   account differs from the one `getConnection()` resolves to for this sync
   (`dropbox/client.ts:315-334`).
2. If it differs, either share the folder into the connected account (simplest, no code change),
   or re-point the connection/credentials to the account that actually has visibility — check
   whether doing so would affect any *other* project currently relying on the existing connection
   before changing it, since today's resolution is a single canonical connection per provider,
   not per-project.
3. If this turns out to be a recurring pattern (multiple photographers uploading to accounts the
   studio's resolved connection can't see), that's a larger design question — supporting multiple
   named Dropbox connections routed per-project — worth its own plan, not a fix folded into this
   one. Don't build multi-connection support speculatively off a single incident.

**Sub-case (ii), same account, wrong namespace/team root** — this one *is* a code path to check,
though the fix may still be operational:

1. Compare what `createDropboxClientContext()` actually resolved for this sync (`pathRootHeader`,
   derived from the account's `root_info.root_namespace_id`/`home_namespace_id`/`.tag`,
   `dropbox/client.ts:452-478`) against what the account's `users/get_current_account` response
   says it should be, called fresh as part of the diagnostic.
2. If the resolved header is wrong for this account/path combination, that's a real bug in
   `createDropboxClientContext()`'s resolution logic — fix it there, with a regression test
   pinning the account shape (team root vs. home namespace) that was mishandled.
3. If the header is being resolved correctly but `raw_folder_path` was recorded relative to a
   *different* namespace than the one the connection now resolves to (e.g. the path was entered
   assuming the home namespace, but the account has since started resolving a team root), that's
   closer to Branch A territory — the operational fix is correcting the stored path to match the
   namespace the connection actually uses, not a code change.

## Explicitly out of scope for this plan

- Any change to `GET /api/projects/:id/assets`, `review.ts`, `ProjectWorkspace.tsx`, or
  `PhotoGrid.tsx` — the read/display path is confirmed correct and unrelated to the bug.
- `MAX_DOWNLOADS_PER_RUN` / continuation-cap tuning — the continuation note never fired on any of
  the four listing runs, and it can only fire *after* 120 downloads have already happened in a
  single run. Had the listing returned 255 files, the manual run would have been forced to
  download the ~230 it had never seen and would necessarily have tripped that cap. It didn't, in
  24.3 seconds. The cap is not implicated.
- Any change to XMP rating parsing (`packages/shared/src/xmp.ts`) — ratings are read correctly
  per-file; the uniform-1 pattern is a data characteristic of the (wrong) ingested set, not a
  parsing bug.

## Open questions for the user / next agent

1. **Highest-value question, ask first.** Where did "255" come from — a direct count of files
   visible in the Dropbox UI for this exact path/account/namespace, or from Tonomo's
   order/expected-count metadata? Given the evidence that a correct authenticated listing of the
   configured path returned only ~25 eligible files, this single answer likely separates Branch D
   ("255 counted whole-folder including non-JPEGs/duplicates — no bug") from B/E(i) ("255 genuinely
   visible as JPEGs under this path to a human, but not to the API") faster than any other step.
2. Does Igor Melo (or whoever uploaded this shoot) know whether `NOTES`/`PROOFSHEET` are
   auto-generated by a drone review tool, and if so, where the actual capture files were
   uploaded relative to them?
3. Which Dropbox account does the studio's resolved connection (`getConnection()`,
   `dropbox/client.ts:315-334`) actually authenticate as, is it a Business/Team account with a
   distinct team root, and does the account that uploaded the 255 files match it? Needed to run
   the diagnostic correctly (Branches B/E both hinge on this), not just to explain a hypothetical
   mismatch.

## Review history

- **Round 1 (2026-07-29, Terra, `codex exec --sandbox read-only`, high effort): NEEDS REVISION.**
  Confirmed the read-path and core `sync.ts` mechanics as accurate, but found the original draft
  overstated what the telemetry absence proves, was missing two plausible root-cause branches
  (delta-cursor/routing miss; namespace/team-root mismatch), had an insufficient diagnostic step,
  proposed a hardening mechanism that duplicated an existing one instead of extending it, and
  cited `docs/lessons.md`'s shared-folder lesson for a stronger claim than it actually supports.
- **Round 2 (2026-07-29, Terra, same invocation shape): NEEDS REVISION.** Round 1's fixes were
  broadly right in substance but imprecise in the details: the telemetry section still
  self-contradicted (claiming both "shortfall happens before filtering" and "filtering is an
  unruled-out cause"); the claimed `continuationEnqueued`/zero-download edge case was factually
  wrong (`continuationEnqueued` can only become `true` from inside the `downloadsThisRun >= 120`
  branch, so `downloadsThisRun` is already ≥120, never 0, whenever it fires — confirmed by
  re-reading `sync.ts:251-254`/`292` directly); the namespace/account-mismatch idea was present
  only in the diagnostic and open questions, not as a first-class branch with its own fix path;
  several `ProjectWorkspace.tsx` call-site descriptions were imprecise (line 104 mischaracterized
  as "the poller" rather than a plain fetch helper, line 213 wrongly counted as a call site when
  it's only a dependency array entry, line 248's role understated); the cursor branch's "cursor
  established after files were uploaded" framing didn't account for the DO's initial listing pass
  already routing the baseline page; the hardening proposal didn't account for
  `uploads.ts`'s manifest-based mismatch branch; and the manual-job inference needed to be stated
  as conditional evidence (no explicit `trigger` column in `jobs`, mutable `payload_json`, no
  logged file count) rather than as settled fact. **This revision addresses all of round 2's
  required changes** — this session independently re-read every cited line range
  (`ProjectWorkspace.tsx:82-213`/`241-256`/`332-349`, `sync.ts:200-298`, `uploads.ts:155-199`,
  `dropbox/client.ts:35-41`/`315-334`/`452-478`, `do/dropbox-sync.ts:120-186`) before writing the
  fixes rather than taking the review's line numbers on faith, and added Branch E (connected
  account lacks visibility — distinct from Branch B's traversal question) plus its own Fix
  section, grounded in `getConnection()`'s single-canonical-connection-per-provider behavior.
  **Not yet re-submitted for a round 3 approval pass** — do that before treating this plan as
  final, though given round 2 found no new branch gaps (only precision/citation corrections), a
  short verification-focused round should be enough to close this out.
- **Round 3 (2026-07-29, Terra, same invocation shape): NEEDS REVISION, but confirmed no new
  branch gaps — all findings were wording/citation precision, matching the round 2→3 prediction
  above.** Found: the "Required diagnostic step" section's own intro sentence still had the
  round-2-flagged telemetry overstatement (a leftover instance the earlier fix pass missed
  outside the "Confirmed facts" section); a genuinely missing call site
  (`UploadDropzone.onComplete={refresh}` on the RAW tab, line 344 — only the edited-tab dropzone
  and `CollectionPanel` callbacks had been listed); Branch C's "no error anywhere" claim was too
  broad — re-reading `do/dropbox-sync.ts:275-294` directly confirmed an actual
  cursor-continuation exception *is* caught, recorded to `dropbox_monitor_health.lastError`, and
  retried (only a routing/registration-timing miss on a page that lists successfully is truly
  silent); Fix branch C's "manual sync already works correctly once triggered" overstated the
  evidence beyond what round 2 had already asked to qualify; the out-of-scope section's "25-32
  candidate files" phrasing needed the same evidence-vs-inference qualification applied
  elsewhere; and Branch E was asked to explicitly cover the same-account-but-wrong-namespace
  sub-case, not just a different-account sub-case, plus soften "active connection" since
  `getConnection()` doesn't filter by any status field. All six specific wording fixes applied in
  this pass, each re-verified against a fresh read of the cited source
  (`do/dropbox-sync.ts:255-295` for the continuation-error handling in particular, since that was
  the one claim in this round with real code-behavior content rather than pure wording/precision).
- **Round 4 (2026-07-29, Terra, same invocation shape): NEEDS REVISION, but explicitly confirmed
  no new root-cause branch is needed and the rest of the document read as internally coherent —
  the same convergence pattern as round 3, now two rounds running.** Found three remaining
  precision issues, all in Branch C/E: (a) "on any thrown error" overstated Branch C's continuation
  section — a `DropboxCursorResetError` is specially recovered inline
  (`do/dropbox-sync.ts:146-150`) and never reaches the outer catch, so only an *unrecognized*
  thrown error produces the `lastError`/retry path; (b) "literally nothing recorded anywhere" for
  a routing miss was false — re-reading `do/dropbox-sync.ts:226-258` directly confirmed
  `dropbox_monitor_health` is updated with `scannedCount`/`matchedCount`/`skippedCount`/
  `routedProjectCount` on *every* successfully processed page, matched or not, so the accurate
  claim is "no project-specific job or alert," not "nothing recorded"; (c) Fix branch E covered
  the different-account sub-case but had no corresponding action for the same-account/
  wrong-namespace sub-case, and one leftover "single active connection" phrasing (Open Question 3)
  hadn't been updated to match the "resolved connection" wording used everywhere else. All three
  fixed in this pass, with the `dropbox_monitor_health` insert re-verified directly against
  `do/dropbox-sync.ts:220-258` before writing the correction, and Fix branch E split into two
  numbered sub-sections matching the two Branch E sub-cases. **A formal round-5 confirmation pass
  was not run** — this and round 3 both found zero new branch-level gaps, two consecutive rounds
  of pure wording/citation precision on a diagnosis-only document, which is the point of
  diminishing returns for further automated review loops; a human engineer picking this up should
  still treat every code citation as a claim to re-verify against source at the time they act on
  it, per this repo's own gate discipline (`docs/Subagent-Orchestration.md` §5), not as
  self-certifying because it passed four rounds.
- **Final round (2026-07-29, this session running as Opus 5, directly — no subagent spawned, per
  `docs/Subagent-Orchestration.md` §1's "skip the Opus reviewer when the session *is* Opus 5").**
  Rounds 2-4 had each converged on wording precision, which is exactly the failure mode of
  reviewing a *document* rather than the *evidence underneath it* — so this round went back to
  production D1 instead. It found two factual errors every prior round had propagated, and one
  substantial missed inference:
  - **"Four `dropbox_sync` jobs" was wrong — there are five** (`39bffdf6`, `4fbc8679`, `fe829763`,
    `6ad53f81`, `a21a5c4d`). Four of the five performed a listing; `a21a5c4d` short-circuited on
    the claim-collision path before any Dropbox call, so it was never evidence of anything. Every
    round from 1 onward had reasoned over a miscounted, partly-inapplicable evidence base.
  - **The `6ad53f81` manual run is far stronger evidence than the doc claimed**, and rounds 2-4
    had progressively *weakened* the claim (correctly, on the text as written) instead of checking
    whether better evidence existed. `payload_json IS NULL` is only reachable on the full-success
    path having written neither optional note, which pins four independent facts about that run;
    combined with the asset timestamps (all 25 created inside `fe829763`'s window, none in
    `6ad53f81`'s) and its 24.3s runtime, it proves a fresh cursor-independent recursive listing of
    the configured path returned only the small set. The doc had been hedging this as "inferred
    from a stable row count."
  - **Consequences the earlier rounds could not reach:** Branch C is eliminated for this project
    (not merely "not the sole cause"); Branch A survives only in its narrowed "real folder, wrong
    one" form and Branch E(ii) drops to unlikely, since the path demonstrably resolves rather than
    returning `path/not_found`; and `MAX_DOWNLOADS_PER_RUN` is now positively excluded rather than
    just unobserved. A branch-prioritisation note was added so the next agent doesn't re-derive
    this, and Open Question 1 was re-ranked as the cheapest discriminator.
  - **New side finding:** `a21a5c4d` is a redelivered message that short-circuited against its own
    prior attempt's claim and reported `done` having done no work — logged here and pointed at
    `Dropbox-Ingest-Concurrency-Safety-Plan.md`, not fixed in this plan's scope.
  - Also fixed: a stale "Not yet re-submitted for a round 4 pass" line contradicting the round-4
    entry above it, and a diagnostic cross-reference pointing at "step 4" when the human-browse
    step is step 5 (numbering drifted when a step was inserted in the round-2 revision, and three
    subsequent review rounds missed it).

  **Lesson worth carrying** (candidate for `docs/lessons.md` if this pattern recurs): four
  successive review rounds on a diagnosis document converged on prose precision while a
  miscounted evidence base sat unexamined underneath. Reviewing a document tests whether it is
  *internally coherent and correctly cited*; it does not test whether the underlying data was read
  correctly in the first place. When a doc's core claims rest on a query, re-run the query.

- **Follow-up, same session, prompted by "is this ready to build?".** Answering that honestly
  required checking whether the remaining code-requiring branch (B) was plausible, which surfaced
  the **cross-project comparison** now recorded above — the single most decisive evidence in this
  document, and available from D1 the whole time. Every one of the five prior rounds (four Terra +
  the Opus pass) had reasoned only about *this* project's rows in isolation; nobody had asked what
  a *healthy* project looks like. One `GROUP BY` over `assets.section` showed the studio's
  universal `Listing Images` convention and that 17 Oxford Street is the sole project missing it,
  plus a ~6.5-week gap between its shoot date and its ingested files. That demoted Branch B (the
  only branch needing code) from "live hypothesis" to "long shot," since the same connection
  traverses two-level-deep folders correctly for eight other projects on the same root, and
  promoted Branch A (no code) to leading. A two-minute "Fast path" check was added at the top of
  the diagnostic that may resolve the incident outright.

  **Second lesson, sharper than the first:** the anomaly was only visible *by comparison*. Five
  rounds of increasingly careful analysis of the failing case produced steadily better prose about
  the failing case; a single query against the working cases reframed the whole diagnosis. When
  investigating "X is broken," query what unbroken looks like before deep-diving X — and note that
  the trigger here was a scoping question from the user, not another review round, which is its own
  argument for asking "what would make this cheap to answer?" earlier than round five.
