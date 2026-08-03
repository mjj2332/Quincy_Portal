# Download Selection — Plan

**Status: APPROVED for build — Opus plan-tier review returned the plan to Terra once (1 of the 2
allowed reverts); all five Opus findings are resolved in Terra revision round 1 and re-verified by
Opus. Not yet built.**

## User request

Add a **Download selection** action immediately after **Clear** in the floating multi-select
toolbar shown in the project workspace screenshot.  The request is for the assets checked in that
toolbar at the instant of the click—for example, the ten checked RAW frames in a 111-frame grid—
not for the server-persisted "selected for editing" set.  The delivered file is a ZIP.

## Current state (verified against the code, not assumed)

- `PhotoGrid` owns the checkbox selection as `multi: Set<string>`
  (`portal/apps/web/src/components/PhotoGrid.tsx:63-75`).  It is local React state, pruned only
  to the current `assets` prop; it is not a database-backed selection.  Its action bar is rendered
  when `multi.size > 0` (`PhotoGrid.tsx:180`).  Rate/label/approve/flag/recommend/select-for-
  editing fan out from `bulk()` through the existing per-asset callbacks with `Promise.all`
  (`PhotoGrid.tsx:122-128`), and deletion follows the separately supplied bulk callback
  (`PhotoGrid.tsx:135-143`).
- `ProjectWorkspace` supplies those callbacks to the grid at `ProjectWorkspace.tsx:405`.
  In particular, bulk delete is still intentionally a client-side `Promise.allSettled` over
  individual `DELETE /api/assets/:id` calls (`ProjectWorkspace.tsx:286-296`).  This feature does
  not turn any of those existing mutations into a batch endpoint.
- One supplied fact was stale: the grid is **not** used for every collection type.  The workspace
  mounts `PhotoGrid` only inside the `activeTab === "raw" || activeTab === "edited"` branch
  (`ProjectWorkspace.tsx:398-406`); video, floorplan, and copy use `CollectionPanel` instead.
  Also, `key={activeTab}` on that mount means the checkbox selection is reset on a tab change.
  Consequently v1 covers the RAW and Edited photo grids, one active tab at a time; it cannot
  contain a cross-tab selection through the real UI.
- The existing `GET /projects/:id/selected-raw.zip` is deliberately a different operation
  (`portal/workers/app/src/routes/projects.ts:500-525`).  It checks project access and
  `selectForEditing`, queries `selections.state = 'selected_for_editing'` joined to the project's
  RAW collection, streams its entries through `createZipStream`, and names the archive from the
  street.  It has no caller-supplied asset list.  A repository search found the only
  `createZipStream` call site is this route; there is no existing arbitrary-selection ZIP route.
- The current persisted-selection download is initiated by a same-origin, programmatically
  clicked `<a download>` (`ProjectWorkspace.tsx:350-354`).  That is suitable only because the
  existing GET already knows its set from D1.  Encoding 111 UUIDs in a query string would be a
  brittle, length-dependent API contract, so the new selection must not use that pattern.
- The ZIP writer is already a pull-driven streaming writer (`workers/app/src/lib/zip-stream.ts:1-5,
  79-82`), and the existing ZIP route reads each immutable `assets.r2Key` directly with the
  Worker R2 binding (`projects.ts:506-521`).  `assets.r2_key`, `original_filename`, and `bytes`
  are existing schema columns (`portal/packages/db/src/schema.ts:299-345`); the media route uses
  the same direct R2 pattern and no signed URLs (`workers/app/src/routes/media.ts:25-40`).
- `downloadFinal` is an existing but unused capability: it is declared at
  `packages/shared/src/capabilities.ts:10-37` and granted to admin and editor at lines 47-90.
  A search of `workers/app/src` and `apps/web/src` found no current use.  `selectForEditing` is
  also admin/editor-only; photographer has only the RAW upload/view/annotation/recommend/compare
  capability set (`capabilities.ts:92-98`).  Separately, a photographer's project access ends
  after `awaiting_raw`/`raw_review` through `PHOTOGRAPHER_VISIBLE_STAGES`
  (`packages/shared/src/stages.ts:17-20`) and the central `hasProjectAccess` check
  (`workers/app/src/middleware/capability.ts:18-28`).
- The asset-list route itself shows the visibility rules a download must preserve: it accepts all
  collection kinds, restricts Edited to `publish_status = 'ready'`, and only returns current
  (`superseded_at IS NULL`) assets (`workers/app/src/routes/review.ts:20-47`).  Pending/failed
  Edited assets are deliberately invisible (`workers/app/src/lib/asset-visibility.ts:4-17`).
- Existing integration coverage for the persisted RAW ZIP is in
  `workers/app/test/api.test.ts:1411-1432`; it seeds R2 and D1, asserts the ZIP content type and
  local-header magic, and checks non-member/capability denial.  The existing DOM harness for
  action-bar controls is in `apps/web/src/components/PhotoGrid.dom.test.tsx:14-78` and locates
  buttons from `.actionbar .barbtn` in its current tests (for example lines 177-208 and 226-254).
- `projects.ts` already has a local `chunked<T>(items, size = 80)` helper and uses it for
  D1 `IN` queries (`projects.ts:72-82`).  This is directly reusable by the new validation
  helper.  [Cloudflare D1's current hard limit](https://developers.cloudflare.com/d1/platform/limits/)
  is **100 bound parameters per query**.  The
  proposed ownership query also binds `projectId`, so a 500-item `inArray()` is invalid; chunks
  of 80 IDs keep each query to at most 81 bound values.
- The app's `wrangler.jsonc` has no `limits.cpu_ms` override.  Production already serves
  `GET /projects/:id/selected-raw.zip`, which streams whole RAW objects through this same
  `createZipStream` and its per-byte JavaScript CRC32 loop, with one R2 `get()` per selected
  asset.  That is strong empirical evidence that the production account is already on Workers
  Paid: at the measured roughly 171 MiB/s, Workers Free's 10 ms CPU limit covers only about
  1.7 MiB of CRC—less than a single RAW frame—and Free's 50-subrequest limit would fail a
  moderately sized selection.  [Cloudflare's current Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
  give Workers Paid 30 seconds of CPU by default (configurable to five minutes) and 10,000
  subrequests, versus Free's 10 ms and 50.  Confirm that existing plan in the production
  account's Cloudflare Dashboard **Workers & Pages** plan/billing page before release; Queues
  bindings are not evidence of Paid because Queues are available on Workers Free.  If the
  dashboard unexpectedly shows Free, stop this release and move the production account to Paid
  before deploying; do not deploy this feature on Workers Free.
- `createZipStream` is memory-bounded but not CPU-free.  Its exact `crc32()` iterates every byte
  in JavaScript and does one table lookup/update per byte (`zip-stream.ts:24-32, 55-61`).  A local
  benchmark of that exact loop over 256 MiB, after warm-up, measured 1.49-1.50 seconds
  (171-172 MiB/s).  Workers CPU is hardware-dependent, so the feature must use a conservative
  byte budget rather than extrapolating a file count from that workstation result.
- KV is unsuitable for an immediate POST-to-anchor-GET handoff: [Cloudflare documents](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
  that KV is eventually consistent, can take 60 seconds or more at other locations, and caches
  negative lookups.  In contrast, this app uses plain `env.DB`/Drizzle queries and never calls
  the D1 Sessions API (`withSession()`).  [Cloudflare's D1 Worker API documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/)
  guarantees that, without the Sessions API, all queries continue to execute only on the primary
  database even if read replication is enabled.  A committed ticket is therefore available to the
  immediately following GET regardless of edge, without KV's cross-PoP cache model.  If the app
  ever adopts `withSession()` for its main binding, this route must use `first-primary` or carry a
  bookmark, otherwise its ticket GET could read a stale replica and spuriously 404.  The app has
  concrete expiring-record precedents in `autohdr_manual_ingest_leases` and
  `raw_reconciliation_claims` (`schema.ts:485-589`).

## Design

### Scope and capability decision

The button appears in both places where the real app renders `PhotoGrid`, not in the other three
collection tabs that use `CollectionPanel`:

- **RAW:** show it only with `selectForEditing`.  This exactly matches the existing RAW ZIP
  route's authorization precedent and preserves its present admin/editor audience.
- **Edited:** show it only with `downloadFinal`.  This makes the currently dormant capability
  serve its natural purpose—downloading completed work—without granting it to photographers.

The server, not the visibility condition, is authoritative.  It derives the required capability
from the validated selected collection and rechecks it when bytes are served.  Current role grants
make both conditions admin/editor-only, but keeping the two checks semantically distinct avoids
silently tying a future final-download role decision to the AutoHDR selection permission.
`PHOTOGRAPHER_VISIBLE_STAGES` needs no special feature code: `hasProjectAccess` remains the first
project-scope gate, and photographers never satisfy either download capability.

### Two-step API: POST the arbitrary list, then stream a short-lived GET

Use a ticketed two-step flow rather than either URL-query IDs or `fetch(...).blob()`:

1. `POST /api/projects/:id/download-selection` accepts JSON exactly shaped as
   `{ "assetIds": ["<uuid>", "..."] }`.  It validates a UUID project id, a non-empty,
   duplicate-free UUID array, a maximum of **500** IDs, and (after all ownership/visibility
   checks pass) a maximum aggregate stored `assets.bytes` of **256 MiB**.  These are hard
   all-or-nothing limits, not pagination: the current grid has no pagination and the screenshot's
   full 111-frame selection remains supported when it fits the byte budget.  Neither count nor
   bytes are truncated; an over-count request gets the existing validation `400`, and a valid
   selection over the byte budget gets `413 { error: "Selected assets exceed the 256 MiB download
   limit" }`, so the user can split it deliberately.
2. After full validation and authorization, the POST inserts an opaque UUID ticket into a new
   D1 `download_selection_tickets` table, with only `id`, `user_id`, `project_id`,
   `asset_ids_json`, `expires_at`, and `created_at`; it expires five minutes after creation.  The
   JSON response is `201 { "downloadUrl":
   "/api/projects/:id/download-selection/:ticket/archive.zip" }`.
3. `GET /api/projects/:id/download-selection/:ticket/archive.zip` reads the clean ticket UUID
   with `c.req.param("ticket")`, loads that ticket, requires the same authenticated user and
   project id, repeats project access, asset validation, and the collection-derived capability
   check, then returns the streaming ZIP.  The ticket is opaque and short lived; the GET never
   trusts a raw asset id from the URL.  It is intentionally not single-use; the D1 row is an
   authorization-scoped, expiring record, not a consume lock.  Its user/session recheck and the
   full revalidation immediately before R2 access are the security boundary.  Keep `.zip` in the
   static `archive.zip` segment: Hono treats `:ticket.zip` as a parameter literally named
   `ticket.zip`, not as a `ticket` parameter with a literal suffix.

Add `downloadSelectionTickets` to `packages/db/src/schema.ts` and an additive
`0024_download_selection_tickets.sql` migration.  Use UUID primary key, `user_id` and
`project_id` foreign keys with `ON DELETE CASCADE`, non-null JSON/text and millisecond expiry
columns, plus an `expires_at` index.  This is a new table, so write a direct `CREATE TABLE` / index
migration—never a Drizzle table rebuild.  On POST, delete rows already expired (indexed lazy
cleanup) before inserting the new row; GET selects only a row with matching ticket, project,
user, and `expires_at > now`.  Because both routes use normal `env.DB` queries rather than D1
Sessions, the immediately following GET reads the committed ticket from the primary regardless
of which edge receives it, unlike KV's cross-PoP cache model.

This preserves the browser's native, streamed download behavior for real RAW files.  A direct
POST followed by `response.blob()` would avoid URL length but force the browser to materialize an
entire potentially multi-gigabyte ZIP before saving it.  The ticket lets the frontend POST the
large ID list safely, then use the established plain anchor GET convention with a short URL.  It
is intentionally a new API flow, but not a Blob-download idiom.

The POST is covered by the app's existing `/api` origin middleware
(`workers/app/src/index.ts:24-30`) and normal cookie session middleware.  Do not add a
router-wide `use("*", ...)` capability middleware; the route's capability is data-dependent, and
that pattern is explicitly unsafe on these mounted Hono routers.

### Exact server validation and response behavior

Factor the common validation into a local helper used by both routes so the ticket cannot become
a stale authorization decision.  First load the current `user` row by the session user ID and use
its current active/role values for every project-access and capability decision; a ticket stores
no role or capability.  This is critical on GET: a role downgrade must use the downgraded role,
and an inactive/missing account returns the normal authentication failure even if a ticket exists.
Refactor `hasProjectAccess` or add a sibling helper that accepts this freshly loaded principal;
do not manufacture a fake Hono context or fall back to `c.get("user").role` for the GET decision.
After the project-access check, issue the ownership query below **once for each sequential**
`chunked(assetIds, 80)` chunk, then aggregate the rows before making any decision.  Sequential
execution keeps below D1's six simultaneous-connection limit as well as the 100-bind limit.  Each
query is equivalent to:

```ts
db.select({
  id: assets.id,
  r2Key: assets.r2Key,
  originalFilename: assets.originalFilename,
  bytes: assets.bytes,
  collectionKind: collections.kind,
  publishStatus: assets.publishStatus,
  assetKind: assets.kind,
})
  .from(assets)
  .innerJoin(collections, and(
    eq(assets.collectionId, collections.id),
    eq(collections.projectId, projectId),
  ))
  .where(and(inArray(assets.id, assetIdChunk), isNull(assets.supersededAt)))
```

Do not stop after a failing chunk or authorize chunk-by-chunk.  The helper first aggregates every
chunk's result, then requires all of the following before it returns any entry metadata:

- The returned row count is exactly the unique submitted-id count, and every row is
  `isUserVisibleAsset(collectionKind, publishStatus)`.  Otherwise return a generic `404
  { error: "One or more selected assets are not available in this project" }`.  This covers an
  unknown ID, an ID from another project, a deleted/superseded row, and a non-ready Edited row
  without returning a partial ZIP or exposing which ID failed.
- Every row is a `photo` and all rows have one collection kind, either `raw` or `edited`.
  A hand-crafted mixed-tab or non-photo request gets `400 { error: "Download Selection supports
  one RAW or Edited photo selection" }`; it cannot arise from the current keyed UI but must not
  acquire accidental semantics at the API boundary.
- For RAW require `selectForEditing`; for Edited require `downloadFinal`.  On failure return the
  standard `403 { error: "Forbidden", capability }`.  A non-member or a photographer past the
  visibility cutoff fails the preceding project-access check with the existing 403 response.
- Preserve submitted order by mapping the ownership-query rows back through `assetIds` before
  constructing the async entry generator.  `IN (...)` query order is not a ZIP ordering contract.
- Sum the validated rows' non-negative `bytes` exactly once, using a safe integer accumulator.
  Only after the all-or-nothing ownership/visibility test passes, reject a total above 256 MiB
  with the 413 above; otherwise pass both the ordered metadata and total to the route.  This order
  preserves the generic unavailable-asset 404 and never turns a foreign/unknown ID into a size
  oracle.

Malformed JSON, an invalid project/id, an empty/duplicate list, or more than 500 IDs returns the
existing `400 Invalid JSON`/`400 Invalid input` shape from `jsonInput`/Zod.  A valid request whose
entire selection has become unavailable uses the same all-or-nothing 404 above; there is no
"zero eligible" empty archive.  A missing/expired/wrong-user ticket also returns a generic 404.
If a referenced R2 object is unexpectedly absent, or its actual size disagrees with the stored
`bytes`, retain the existing `selected-raw.zip` failure mode: `createZipStream` throws after the
200 headers may already be flushed, so the client receives a truncated/corrupt ZIP under a
success status and the broken-invariant detail is only in the Worker log.  This behavior is
deliberately inherited, not changed here; log enough context to investigate rather than
substituting or omitting a file.

The GET streams those validated `r2Key` objects through the existing `createZipStream`.  Return
`content-type: application/zip`, `content-disposition: attachment`, and `cache-control: private,
no-store`.  Reuse the existing safe street-slug logic and project-id fallback, but make the new
operation distinguishable from the persisted-selection archive:
`<safe-street-or-project-id>-selection-raw.zip` or
`<safe-street-or-project-id>-selection-edited.zip`.  Keep the archive writer's existing
duplicate-filename disambiguation behavior.  After the GET has passed its fresh session,
project, ticket, asset, and capability checks—and immediately before returning the streaming
response—write one audit row such as `project.download_selection` with `collection`, `count`,
`totalBytes`, and the requested `assetIds`.  This is an **authorized download initiation** audit,
matching the existing `selected-raw.zip` route's placement; a stream cannot truthfully establish
that the client received every byte.  Do not audit a POST that merely created a ticket and may
never be downloaded.

### Selection budget and Worker prerequisites

Keep the requested **500-asset** maximum, but pair it with the **256 MiB total-byte** maximum;
the latter is the actual ZIP CPU boundary.  The current CRC loop measured about 171 MiB/s locally,
so 256 MiB consumed about 1.5 CPU seconds there.  Budgeting for a deliberately conservative
10× slower Worker leaves the CRC at about 15 seconds, half of the 30-second paid default; ZIP
headers, D1 work, and the fixed authorization code are comparatively small.  Waiting on R2 I/O
does not itself consume Worker CPU, but CRC executes for every streamed byte.  This does not claim
that 500 RAWs fit: 500 tiny fixtures do, while a 500-file multi-gigabyte RAW set is deliberately
rejected before streaming.

The implementation should add `limits.cpu_ms: 30000` to the app Worker's `wrangler.jsonc`, making
the intended Paid default explicit.  If `wrangler deploy` rejects the `limits` block (it is only
supported on the Standard Usage Model), remove that key and proceed: 30 seconds is already the
Paid default, so this cosmetic documentation setting must not gate the release.  Confirm the
existing production plan in the Cloudflare Dashboard before release.  Do not deploy this feature
on Workers Free: its 10 ms CPU and 50 subrequests cannot support the existing per-object ZIP
design, much less 500 R2 reads.  Before production release, run the exact CRC/stream path against
a 256 MiB staging fixture and inspect Worker CPU logs; if it reaches 15 seconds, lower the byte
cap before release.  Larger deliveries need a separate background/prebuilt ZIP or queued
client-delivery design, rather than an increased foreground file-count limit.

### Frontend behavior

- Add `canDownloadSelection` and an async `onDownloadSelection(assetIds)` contract to
  `PhotoGrid`.  In the action bar, append **Download selection** after **Clear**, only when the
  capability prop and handler are present.  Capture `const ids = [...multi]` at the click, await
  the callback, disable that button while it is preparing, and retain `multi` on either success
  or failure.  Downloading is non-mutating, so it must not clear selections or alter the existing
  shift-click anchor/bulk-action behavior.
- In `ProjectWorkspace`, derive the prop as `activeTab === "raw" ? can("selectForEditing") :
  can("downloadFinal")`.  Its callback posts the captured IDs to the ticket endpoint using the
  existing JSON API helper, toasts `Preparing your download…`, and only after the 201 response
  creates a same-origin `<a download>` for `downloadUrl`, appends/clicks/removes it as the
  current `downloadSelectedRaw()` convention does.  The browser honors the GET response's
  `Content-Disposition` filename while streaming directly to the user's download manager.
  Catch an `ApiError` from the POST and show its server message as an error toast; leave the
  checked assets visible so the user can retry or adjust them.
- Put the count and byte constants in `@quincy/shared` so API and UI cannot drift.  `PhotoGrid`
  already receives each selected asset's `bytes`, so it can calculate the current selection total
  without trusting it for authorization.  Disable/title the button before a request when it has
  more than 500 items or more than 256 MiB (for example, `Download up to 500 assets / 256 MiB`),
  while the server remains authoritative.  This is preferable to silently downloading a prefix.

## What is explicitly not changing

- `GET /projects/:id/selected-raw.zip` remains the persisted
  `selections.state = 'selected_for_editing'`, RAW-only download.  Its route, capability, URL,
  filename, and AutoHDR-toolbar caller retain their current semantics.
- Rate/label/approve/flag/recommend/select-for-editing/delete remain their current client-side
  per-asset fan-out actions.  This adds a read/download path only; it does not introduce a batch
  mutation endpoint or change `multi` persistence.
- Video, floorplan, and copy do not gain this button in v1 because they do not render `PhotoGrid`.
  The ticket endpoint rejects their asset kinds rather than creating an undocumented download API
  for them.
- The feature adds the small, expiring D1 ticket table and migration described above.  It does not
  add a role, capability, R2 mutation, background job, or new Cloudflare binding; `SESSIONS` KV is
  not used for this ticket.
- R2 objects remain immutable and are never changed or deleted by a download.

## Testing requirements for the build

### `portal/workers/app/test/api.test.ts` (real Miniflare)

Extend the ZIP fixture style near lines 1411-1432; do not replace the persisted-selection test.

1. Seed a project with an assigned editor, two current RAW photos with distinct R2 bodies and a
   current ready Edited photo.  POST the two RAW IDs to the ticket route, assert 201 and an opaque
   project-scoped `downloadUrl` exactly matches
   `/api/projects/${projectId}/download-selection/${ticket}/archive.zip` for the returned ticket,
   then GET that URL with the editor cookie.  Assert
   `application/zip`, attachment filename `...-selection-raw.zip`, ZIP local-header magic, both
   original filenames, and both distinct seeded byte payloads in the stored ZIP (not only magic
   bytes).  Assert the audit row has the new action, collection, count, total bytes, and IDs.  The
   assertion is for an authorization/initiation audit written before stream return, not an
   unobservable "download completed" event.
2. Repeat for a ready Edited asset and assert its `...-selection-edited.zip` filename.  This is
   the positive test proving `downloadFinal` gates the Edited path rather than being a dormant
   declaration.
3. Authorization matrix: an **unassigned photographer** is 403; an assigned photographer is 403
   for RAW with `capability: selectForEditing` and for Edited with `capability: downloadFinal`;
   an editor succeeds; and an admin succeeds for both RAW and Edited through `viewAllProjects` +
   both capability grants.  Do not call a bare "unassigned user" a denial test: admin and editor
   have `viewAllProjects`.  Move a photographer's assigned project past the visible-stage cutoff
   and confirm the normal project-access 403 still wins.  This follows the lesson that each
   capability needs authenticated integration coverage, not just a hidden UI control.
4. Submit a valid asset ID from another project alongside a local one and assert an all-or-nothing
   404 with no ticket/ZIP/audit row; it must never emit the local asset alone.  Cover an unknown,
   superseded, and pending Edited ID with the same generic unavailable result.  Cover mixed
   RAW/Edited and a non-photo ID as the explicit 400 unsupported-selection case.
5. Prove the chunking boundary, not just its rejection: create a 100-ID selection and a 500-ID
   selection (all tiny current RAW photo fixtures, total below 256 MiB), POST each successfully,
   then GET each successfully and assert all requested entry names/payloads are present in
   submitted order.  This exercises two and seven 80-ID ownership queries respectively.  Retain
   the separate 501-ID input (400) case.
6. Cover malformed/empty/duplicate/501-ID input (400), an otherwise valid selection whose summed
   stored size is 256 MiB + 1 (413, with no ticket or audit), an expired/wrong-user ticket (404),
   a well-formed but non-existent UUID ticket at
   `/api/projects/${projectId}/download-selection/${nonExistentTicket}/archive.zip` (the generic
   404), and a valid ticket whose selected asset is deleted or becomes unpublished before its GET
   (404).  The GET must repeat validation rather than stream a decision frozen at POST time.  Do
   not assert a non-2xx response for a missing R2 object or changed streamed size: that is a
   post-header, truncated-stream failure, not a routable HTTP error response.
7. Create a ticket as an editor, then before GET (a) change that account's role to photographer
   and assert the GET is 403 with the collection's current required capability, and (b) in a
   separate fixture deactivate the account (which deletes its Better Auth sessions) and assert the
   GET is the normal 401 authentication failure.  These prove GET re-loads the current principal
   and is not merely replaying ticket contents or an old role.

### Web DOM/unit coverage

1. Extend `portal/apps/web/src/components/PhotoGrid.dom.test.tsx` using its existing mount/render/
   click harness.  Select multiple tiles, locate `.actionbar .barbtn` by text, and assert
   **Download selection** appears after **Clear** only when `canDownloadSelection` is true and
   invokes its handler once with exactly the currently checked IDs.  Assert the handler's pending
   state disables/relabels only this control and that completion/error leaves the checkbox state
   and action bar intact.  Add the capability-false, over-500, and over-256-MiB disabled cases.
2. Extend `portal/apps/web/src/screens/ProjectWorkspace.dom.test.tsx` (or extract a small pure
   ticket-to-anchor helper with a focused DOM test) to mock the POST response.  Assert it sends
   `{ assetIds }` to `/api/projects/:id/download-selection`, then creates/clicks/removes an anchor
   whose `href` is the returned ticket URL and whose `download` attribute is set.  Assert a POST
   error produces an error toast and does not remove the selected tiles.  This specifically guards
   the deliberate POST-then-streamed-GET contract; do not replace it with a Blob/object-URL test.
3. Regression-test the existing RAW AutoHDR-toolbar download separately enough to prove it still
   calls `/selected-raw.zip` and not the new ticket route.

### Full verification once implemented

- From `portal/`: `npm run typecheck`, `npm run build -w @quincy/web`,
  `npm run test --workspaces`, and
  `npx vitest run --config packages/shared/vitest.config.ts`.
- Manual authenticated smoke as an editor: select ten RAW tiles whose combined size is within the
  limit, download and open the ZIP to confirm exactly those ten files; change the selection and
  repeat; then select an Edited set and confirm the edited filename/content.  Confirm photographer
  sees no download action and cannot call either ticket endpoint directly.  Confirm the existing
  AutoHDR `Download N selected (zip)` still downloads the persisted selected-for-editing set.
- Before release, confirm the existing Workers Paid subscription in the production account's
  Cloudflare Dashboard and, when the usage model accepts it, the explicit 30,000 ms app-worker
  CPU setting; stream a 256 MiB staging selection and inspect the Worker CPU log.  Lower the byte
  cap if CRC/route CPU reaches 15 seconds; do not compensate by merely raising a file-count cap.

## Rollout

This is an additive schema migration plus app-worker/frontend change: the D1 ticket table, shared
limit constants, app route, optional CPU-documentation configuration, and Vite bundle.  No
background or webhook-ingress code, binding, or deployment is required.  First confirm in the
production account's Cloudflare Dashboard Workers & Pages plan/billing page that the existing
plan is Paid; if it unexpectedly is Free, stop rather than deploying this foreground ZIP design.
Then apply migration `0024` to production and deploy the app Worker (`cd portal/workers/app &&
npx wrangler deploy`).  Include the explicit 30,000 ms `limits` setting when supported, but if
Wrangler rejects that block, remove it and redeploy—the Paid default is already 30 seconds.  A
failed migration must be inspected before retrying per `docs/lessons.md`; this direct `CREATE
TABLE` migration avoids the known table-rebuild/FK failure mode.  Leave this plan in `docs/plans/`
until it has been built, verified, committed, migrated, and deployed; only then update the status
and move it to `docs/plans/implemented/` with `git mv`.

## Routing (per `docs/Subagent-Orchestration.md` §2)

Route the implementation as **Terra, max effort**, with a fresh Terra reviewer.  Although the UI
button is small, the routing table classifies security/auth work separately: this feature creates
a caller-supplied bulk media egress path, project-ownership validation, data-dependent capability
checks, and an expiring D1 ticket.  It is therefore not appropriate for Luna's small mechanical
row or the "too small to delegate" row.  The policy-1 plan sequence is complete: both Terra
plan-review rounds were used, the independent Opus plan-tier review then reverted the plan to a
fresh Terra once (1 of 2 allowed) and approved the result.  Implementation may begin.
