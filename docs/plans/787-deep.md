# #787 Client Delivery page: build plan (Opus planner)

Basis: `main` at 7c7c42b8 (ADR 0022 + glossary merged in #788). Assumes #789, #790 and 15b (client digest, `/d/unsubscribe`) merge first. Planning only; nothing edited.

## 0. Findings that shape the plan (code vs the issue)

1. **A Video Version is an `assets` row.** `video_version_meta.asset_id → assets.id` with `assets.kind = 'video'` (see `workers/app/src/guest/download.ts` `readVersion`). So one asset-keyed membership table covers Photos, Floorplan PDFs, Copy PDFs and Video Versions. No separate Video column is needed; `videos.premium` / `video_premium_unlocks` are reached by `video_version_meta.video_id`.
2. **Re-edits create new asset ids.** Edited photos and documents are superseded by a new row (`supersedes_asset_id`, old row gets `superseded_at`). A premium flag or unlock keyed only on the asset id would silently drop on the next Publish unless every supersede path copies it forward. Only two writers name `is_premium` today (`background/src/dropbox/sync.ts` lines ~414/451/471 and `background/src/editor-folders/sync-output.ts` ~344/364), and the Dropbox UPDATE at ~414 actively **clobbers it to 0** whenever `existing.isPremium` is set.
3. **`manageVideoPremium` is Admin-only** (`packages/shared/src/capabilities.ts`), yet stories 26–28 have an Editor unlock "everywhere, including a premium Video's Review links". This is a real contradiction with #741's matrix; see Open question 1 (default chosen below).
4. **`RENDITION_SPEC_VERSION` is global** and `generateRenditions` hard-codes `["thumb","web"]`. Bumping it would regenerate every thumb and web rendition in production. New variants need their own spec constant, not a bump.
5. **The `env.IMAGES` binding caps input at 20 MB** and 46% of real captures exceed it (lessons, "Image renditions / Cloudflare Images"). `/cdn-cgi/image/` URL options have no `draw`. So the watermark must be drawn by the Images binding over the existing **`web` rendition** (3200 px, a few MB, already in R2), not over the original. This makes the spike narrow.
6. **The existing `web` rendition is not a client Web-size file.** It's 3200 px, usually WebP, `bytes` NULL on legacy rows, and the zip writer (`lib/zip-stream.ts`) needs exact sizes up front. Agents post to listing portals, which expect JPEG.
7. **Legacy tables.** `publishes` (0000, seeded and touched by 0022, nothing reads it) and `premium_unlocks` (0000, read only by the asset-delete guard in `routes/assets.ts` ~144/179 and named in `mcp/tools/admin-writes.ts:126` copy). `client_links.kind` defaults to `'delivery'`, and narrowing that CHECK needs a table rebuild, which 0069's header rules out.
8. **`/d/unsubscribe` is not on `main`** (it ships in 15b). The slug grammar below excludes it by construction anyway.
9. **The staff `components/Lightbox.tsx` imports `lib/api` and `lib/auth`**, so it fails the guest boundary and cannot be reused publicly. `lib/lightbox-navigation.ts` and `lib/lightbox-zoom.ts` are pure and reusable. `lib/lightbox-neighbor-preload.ts` imports a type from `PhotoGrid`, which the guard counts, so it can't be reused as is. `LazyImage` (+ `image-preload-scheduler`, `lazy-image-observer`), `quincy/VideoPlayer` and `guest/PremiumWatermark` are boundary-clean.
10. **Migration number.** #776 holds 0070 in draft PRs (#778). Ours takes the next free number at merge (expected **0071**). The cleanup migration later takes the one after.

## 1. Data model and migrations

### Migration A (expected 0071): additive only, safe under the old Worker

```sql
-- One Delivery page per Project. Exists from the first Publish.
CREATE TABLE delivery_pages (
  project_id text PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE CHECK (length(slug) BETWEEN 8 AND 96 AND slug NOT GLOB '*[^a-z0-9-]*' AND slug GLOB '*-*'),
  enabled integer NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  current_set_number integer NOT NULL CHECK (current_set_number >= 1),
  created_by text NOT NULL REFERENCES user(id),
  created_at integer NOT NULL CHECK (typeof(created_at) = 'integer'),
  updated_at integer NOT NULL CHECK (typeof(updated_at) = 'integer'),
  switched_by text REFERENCES user(id),            -- last on/off actor
  switched_at integer CHECK (switched_at IS NULL OR typeof(switched_at) = 'integer')
);
-- The numbered, frozen Published sets. Append-only.
CREATE TABLE delivery_sets (
  id text PRIMARY KEY NOT NULL,
  project_id text NOT NULL REFERENCES delivery_pages(project_id) ON DELETE CASCADE,
  set_number integer NOT NULL CHECK (set_number >= 1),
  cover_asset_id text REFERENCES assets(id) ON DELETE SET NULL,
  published_by text NOT NULL REFERENCES user(id),
  published_at integer NOT NULL CHECK (typeof(published_at) = 'integer'),
  UNIQUE (project_id, set_number)
);
CREATE TABLE delivery_set_items (
  set_id text NOT NULL REFERENCES delivery_sets(id) ON DELETE CASCADE,
  handle text NOT NULL CHECK (length(handle) = 16 AND handle NOT GLOB '*[^a-z0-9]*'),  -- opaque, random per row
  tab text NOT NULL CHECK (tab IN ('photo', 'video', 'floorplan', 'copy')),
  position integer NOT NULL CHECK (position >= 0),
  asset_id text NOT NULL REFERENCES assets(id) ON DELETE CASCADE,  -- photo | Video Version | floorplan_pdf | copy_pdf
  PRIMARY KEY (set_id, handle),
  UNIQUE (set_id, asset_id),
  UNIQUE (set_id, tab, position)
);
CREATE INDEX delivery_set_items_asset_idx ON delivery_set_items (asset_id);
-- Per-Asset unlock (photos, floorplans, copy). The same shape as video_premium_unlocks; relock deletes the row, and the audit log keeps the history.
CREATE TABLE asset_premium_unlocks (
  asset_id text PRIMARY KEY NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  unlocked_by text NOT NULL REFERENCES user(id),
  unlocked_at integer NOT NULL CHECK (typeof(unlocked_at) = 'integer'),
  payment_ref text CHECK (payment_ref IS NULL OR length(payment_ref) <= 200)
);
CREATE INDEX asset_premium_unlocks_project_idx ON asset_premium_unlocks (project_id);
```

Decisions:

- **New tables, `publishes` untouched.** Reshaping it would not be additive. It is dropped in Migration B.
- **Premium flag: revive `assets.is_premium`** rather than add a column. 0006 reset every row to 0, and both writers force 0, so it holds no meaning today. This needs no DDL. Rewrite the drizzle comment ("Deprecated in favour of section") to say this is the Premium Asset flag. Preflight for the owner: `SELECT COUNT(*) FROM assets WHERE is_premium <> 0` must be 0. It applies to `photo`, `floorplan_pdf` and `copy_pdf`. A floorplan's `floorplan_preview` follows its PDF through `version_group_id` and never carries its own flag.
- **Coexistence with Video premium.** Videos keep `videos.premium` + `video_premium_unlocks`, unchanged. One SQL helper, `lockedSql(assetAlias)`, answers "locked" for any item. For a `video` asset it reads the Video's flag and unlock through `video_version_meta`. For anything else it reads `assets.is_premium` and `asset_premium_unlocks`, resolving a floorplan preview to its PDF. Every public gate (the page DTO, single downloads, each zip entry) uses this one helper, so an Unlock on either surface is the same row.
- **Premium state is live; membership is frozen.** Marking, Unlock and Relock take effect on the current page with no re-publish. The set never changes.
- **Carry forward on supersede.** Every statement that supersedes a photo or document (`dropbox/sync.ts`, `editor-folders/sync-output.ts`, `autohdr/finals.ts`, the document upload in `routes/collections.ts`) inherits `is_premium` from the superseded row instead of the literal `0`. Each also gets one extra statement in the same batch, `INSERT INTO asset_premium_unlocks … SELECT <new id>, … FROM asset_premium_unlocks WHERE asset_id = <old id>`, so a paid Unlock carries to the re-edit (Open question 2). Remove `isPremium` from the Dropbox clobber condition and SET. A guard test lists every `superseded_at =` writer and fails when one lacks the carry.
- **Slug.** Minted at the first Publish from `street` + `suburb`: NFKD, strip diacritics, lowercase, `[^a-z0-9]+` → `-`, trim, cut at ≤ 60 chars on a hyphen boundary, fall back to `delivery` when empty. Then `-` plus a **6-char suffix from the vowel-free alphabet `23456789bcdfghjkmnpqrstvwxz`** (27⁶ ≈ 387M; no accidental words; Open question 3 if the owner wants the issue's 4). The slug always contains a hyphen. It is never recomputed. On a UNIQUE collision, retry with a new suffix; detect it by walking `error.cause` (lesson "Recurring drizzle/D1 error-shape trap").
- **On/off.** `delivery_pages.enabled`. Off makes every public route answer the `/d` stub. The address is unchanged when the page comes back on.
- **Feature gate.** `feature_flags` rows, a missing row meaning off, mirroring `video-review-gate.ts`: `client_delivery` (master) plus `client_delivery_all_projects` or `client_delivery_pilot:<projectId>`. When the gate is shut, staff routes return a fixed 404, public routes return the stub, and the UI hides the tab. The migration seeds nothing.
- **Audit actions** (`audit_log`, one row in the same batch as the write, fenced on `changes()` as in `lib/video-approval.ts`):
  - `delivery.publish`: meta `{ projectId, setNumber, firstPublish, counts, assetIds, coverAssetId }`.
  - `delivery.stage_moved`: only when the first Publish moved the Stage.
  - `delivery.page_enabled` and `delivery.page_disabled`.
  - `asset.premium_set` with `{ premium }`.
  - `asset.premium_unlock`, carrying `hasPaymentRef` and never the reference itself, as the video version does.
  - `asset.premium_relock`.
  - `delivery.unlock_requested`: actor NULL. The meta holds the item's asset id and an IP bucket hash, never a raw IP.
  - No audit rows for public views or downloads (analytics are out of scope).
- **Asset delete guard.** In `routes/assets.ts` and the MCP tool copy, replace the `premium_unlocks` check with two:
  - The asset is in the **current** Published set of a page → 409 `{ blocker: "delivery_published" }`.
  - The asset has an `asset_premium_unlocks` row → 409 `premium_unlock`.

  Older sets cascade, so history never blocks a delete.
- **`client_links.kind = 'delivery'`**: leave it. A narrowing would need a rebuild. Document in the schema comment and the glossary that nothing uses it.

### Migration B (cleanup, after the slice that stops reading `premium_unlocks` is deployed)
`DROP TABLE premium_unlocks; DROP TABLE publishes;` plus schema.ts removal. It is a separate PR and the owner applies it. It isn't additive, so it must land only once no deployed Worker reads either table (CI-Deploy "A PR that adds a D1 migration").

## 2. Routes and authorisation

### Capabilities (`packages/shared/src/capabilities.ts`, pinned by the capability matrix test)
| Action | Capability | Admin | Editor | Photographer | External editor |
|---|---|---|---|---|---|
| Read delivery state, Preview | `viewClientPreview` (exists, unchecked today) | ✓ | ✓ | – | – |
| Publish | `publish` (exists, unchecked today) | ✓ | ✓ | – | – |
| Mark/unmark premium, Unlock/Relock an Asset | `manageExtras` (exists) | ✓ | ✓ | – | – |
| Premium/Unlock a Video | `manageVideoPremium` — **add Editor** (Open question 1) | ✓ | ✓ | – | – |
| Switch page on/off | **new `switchDeliveryPage`** | ✓ | – | – | – |

The project's address (slug/URL) appears only in the delivery-state response. `ProjectDetail` and the external DTOs never carry it, so Photographers and External editors can't see it even through the API. Archived Project: Publish, premium, Unlock and on/off answer 409 `project_archived` (the `NOT_ARCHIVED` pattern in `lib/video-approval.ts`). The page keeps serving.

### Staff API (`/api`, session + `requireAppOrigin` as for every staff route; a new file `routes/delivery.ts`; manifest class `scoped-project`)
Order on every route: id shape 400 → gate (404, same body for real and unknown) → capability 403 → project visibility → archived 409 → body → state.
- `GET /api/projects/:id/delivery` (`viewClientPreview`) returns:
  - `page`: `null`, or `{ url, enabled, currentSet: { number, publishedAt, publishedBy } }`.
  - `history`: the set numbers with their times.
  - `candidates`: every current Edited photo (`superseded_at IS NULL AND publish_status='ready'`, in the Edited order; see §5), Floorplans (PDF + preview), Copy PDFs, and each live Video's Versions. Each candidate carries `{ assetId, tab, label, thumbUrl, premium, unlocked, inCurrentSet, renditionsReady }`.
  - `defaultSelection`: all photos, floorplans and copy, plus the newest live Version of each Video.
  - `extrasSuggestion`: the ids of EXTRAS-section photos not yet premium.
  - `switchable`: whether the caller can switch the page on and off.
- `POST /api/projects/:id/delivery/preview` (`viewClientPreview`). The body is the draft selection (the same schema as publish, minus `expectedSetNumber`). It returns **the same public page DTO** with staff `/media/...` URLs and `downloads: null` everywhere. It writes nothing; the test asserts that the D1 row counts are unchanged.
- `POST /api/projects/:id/delivery/publish` (`publish`). Body: `{ expectedSetNumber: number | null, coverAssetId: uuid | null, items: [{ assetId, tab }] }`, where order within a tab is position. Validation:
  - Every photo, floorplan and copy item is current and belongs to the Project.
  - Video items are live Versions of Videos in the Project, using #776's live-Version predicate once that has merged.
  - At most one Version per Video.
  - The set is non-empty, else 409 `empty_selection`.
  - A superseded id answers 409 `selection_stale`, and the UI reloads.
  - The cover is a **non-premium** photo in the set; null means the first non-premium photo.
  - `expectedSetNumber` must match the page's current number, else 409 `set_changed`. This prevents two Editors clobbering each other.

  One `db.batch` then does the following:
  1. Upsert `delivery_pages`. On first Publish this inserts the slug, guarded by `ON CONFLICT(project_id) DO NOTHING`.
  2. Insert the `delivery_sets` row with `set_number = expected + 1`; UNIQUE handles a race.
  3. Insert the items with fresh random handles.
  4. Bump `current_set_number`, but only `WHERE current_set_number = expected`.
  5. Write the audit row.

  After the batch:
  - If `set_number = 1`, call `moveProjectStage` toward `delivered`. It reads fresh `stageKey` and `boardRevision`, uses the default placement, and acknowledges every `confirmation_required` reason, because Publish is the explicit act. If the Project is already at or past Delivered, that's `no_change`. Any other outcome (conflict, disabled, schema maintenance) does **not** undo the Publish: the response carries `stage: { moved: false, reason }` and the UI shows a toast pointing at the Board. Later Publishes never call it.
  - Enqueue `generate_renditions` for every published photo whose `delivery_web` (or `premium_preview` when premium) is missing.

  Response: the new state, plus `stage` and `url`.
- `PUT /api/projects/:id/delivery/enabled` (`switchDeliveryPage`). Body `{ enabled }`. Idempotent: the same state writes nothing. Returns 404 if no page exists yet.
- `PUT /api/projects/:id/assets/:assetId/premium` (`manageExtras`). Body `{ premium }`. Kinds are `photo`, `floorplan_pdf` and `copy_pdf`; any other kind answers 422. Marking a photo or floorplan premium enqueues `generate_renditions`, which now includes `premium_preview`.
- `PUT /api/projects/:id/assets/:assetId/premium-unlock` (`manageExtras`). Body `{ unlocked, paymentRef? }`, the same shape and semantics as the Video route (`lib/video-approval.ts` `setUnlock`). It refuses a non-premium asset with 409 `not_premium`.
- Videos keep `PUT /api/projects/:projectId/videos/:videoId/premium` and `/premium-unlock` unchanged, apart from the capability change.
- Staff media: `/media/asset/:id/:variant` accepts `delivery_web` and `premium_preview` (`viewEdited`), so Preview and the panel can show the watermarked image.
- MCP: every new staff route is `withheld` in `mcp/route-allowlist.ts`. Publishing over MCP is out of scope.

### Public surface (no session, no cookie; a new dir `workers/app/src/delivery/`)
- **Path grammar.** `DELIVERY_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*-[23456789bcdfghjkmnpqrstvwxz]{6}$/`, length 8–96, mirrored in `@quincy/shared`. The suffix part guarantees at least one hyphen, so `review`, `api` and `unsubscribe` can never match. A shared test also asserts that explicitly against the #741 literals.
- **Mount order in `index.ts`:** `mountGuest(app)` → `mountDelivery(app)` → the `/d` and `/d/*` stubs → SPA fallback. Each route is wrapped like `guestRoute`: terminal, hygiene headers (`referrer-policy: no-referrer`, `x-robots-tag: noindex`, `cache-control: private, no-store`, `nosniff`), and a bare 500 on throw. Factor `withHygiene`, `guestNotFound`, `readBoundedText` and `reserveAttempts` out of `guest/` into `lib/public-http.ts` and `lib/public-rate-limit.ts`, so the stub stays byte-identical across both surfaces. `guest/http.ts` and `guest/rate-limit.ts` keep re-exporting the same names, so 15b's `/d/unsubscribe` code in `guest/` rebases unchanged.
- **Routes** (new `SecurityRouteClass` `"delivery-public"`, projection `guest-public`):
  - `GET /d/:slug` is the SPA shell. It returns the same bytes for any well-formed slug, live, off or unknown, re-wrapped with `frame-ancestors 'none'` and `x-frame-options: DENY` exactly as `/d/review` does. A malformed slug falls through to the stub. The API tells the page whether it exists, so the shell is never an oracle.
  - `GET /d/api/pages/:slug` returns the page DTO (below).
  - `GET|HEAD /d/api/pages/:slug/items/:handle/:variant`, with `variant ∈ thumb | preview | web | full | file | stream | poster`.
  - `GET /d/api/pages/:slug/photos.zip?size=web|full`. Exactly one query param is accepted, as `/d/review` accepts only `link`. HEAD answers 405.
  - `POST /d/api/pages/:slug/items/:handle/unlock-request`. The Origin and JSON content-type check uses the guest `originRejection`, and the body must be empty or `{}`.
- **Resolution (every route).** The sequence is:
  1. Check the slug grammar.
  2. Check the gate is globally open, with one flag read.
  3. Look up the miss limiter (below).
  4. Load the page: `WHERE slug = ? AND enabled = 1`, the per-project gate open, and the Project not deleted.
  5. Load the current set.
  6. For item routes, load the item by `(set_id, handle)`.

  Any miss answers **`guestNotFound`**, the same bytes as the `/d/*` fallback. So page off, unknown slug, a stale handle and gate shut are indistinguishable.
- **Miss limiter.** Only a lookup that misses spends from the per-IP bucket `delivery-miss` (30 / 15 min). Over the limit, the route answers 429 before the lookup. Hits cost no write. With the 6-char suffix this makes enumerating one street's addresses impractical.
- **Lock enforcement (story 56).** For a locked item, `thumb | web | full | file` answer **403 `premium_locked`** on GET, Range and HEAD alike. The check runs before any R2 call, ending with a last `stillServable` re-read just before `serveR2Object`, as `guest/download.ts` does. `preview` on a locked photo or floorplan serves **only** `premium_preview`. While that isn't ready it answers 409 `preparing`, and it **never** falls back to `web`. A locked Video may `stream` (with #741's browser overlay) and `poster`, but `full` answers 403. For an unlocked item, `preview` serves `web`.
- **Item variants.**
  - `thumb` serves the thumb rendition.
  - `web` serves the `delivery_web` rendition, or answers 409 `preparing`.
  - `full` serves the original as an attachment.
  - `file` serves the PDF.
  - `stream` and `poster` serve the Video, through `serveR2Object` with `VIDEO_STREAM_HEADERS`.

  Image responses for `thumb` and `preview` carry `private, max-age=300` (the #362 lesson). Everything else is `no-store`.
- **Public filenames (story 57).** Names never use `original_filename`. They are built from the slug's address part and position: `13-asquith-avenue-rosebery-07.jpg` (web), `…-07-full-res.jpg`, `…-floorplan-1.pdf`, `…-copy.pdf`, and the Video uses its staff-authored title through the existing `safeFileName` (titles are already public on Review links). The disposition goes through the `attachment()` helper, moved from `guest/download.ts` to `lib/content-disposition.ts`.

### Page DTO (`deliveryPageDtoSchema` in `@quincy/shared`, `.strict()` everywhere)
```
{ property: { addressLine, suburb, shootDate|null },
  studio: { name, contactEmail },
  cover: { previewUrl, width, height } | null,
  tabs: { photos: Item[], films: Item[], floorplans: Item[], copy: Item[], premium: Item[] },
  photoZips: { web: url|null, full: url|null, webPreparing: boolean, count, fullBytes } }
Item = { handle, kind: "photo"|"video"|"floorplan"|"copy", label, width?, height?, thumbUrl|null, previewUrl|null,
         locked, downloads: { web?: url|null, full?: url|null, file?: url|null },
         video?: { streamUrl, posterUrl, durationMs, fps..., /* frame fields VideoPlayer needs, as GuestVersionDto minus ids */ },
         requestUnlockUrl: url|null }
```
- `label` is synthesized, never a filename: "Photo 7", "Floorplan", "Property copy", or the Video title.
- A **locked** premium item appears only under `premium`. An **unlocked** one appears in its normal tab, and is included in zips, as an ordinary deliverable (story 54).
- Empty tabs are empty arrays, and the UI hides them. This needs no owner input.
- The DTO carries no ids, R2 keys, emails of people, staff names or invoice/payment fields. Studio `contactEmail` comes from a new Worker var `STUDIO_CONTACT_EMAIL` (Open question 4).
- Display fields are **live** from `projects`, so address typo fixes show up. Only the slug is frozen.
- **The cover re-checks the lock when the DTO is read.** Publish validates a non-premium cover, but premium is live. So the DTO builder applies `lockedSql` to `cover_asset_id` each time it builds the response. When the cover is now locked, the builder substitutes the first non-locked photo in the set, or `null` if there is none, and never serves `web` for a locked cover (story 55).

## 3. Image derivatives, watermark and zips

- **New rendition variants** (`RENDITION_VARIANTS += "delivery_web", "premium_preview"`; `asset_renditions.variant` has no DB CHECK, so no DDL):
  - `delivery_web`: **JPEG, 2048 px longest edge, q85**. It comes from the original through the existing signed `/cdn-cgi/image/` URL path (`width=2048,height=2048,fit=scale-down,quality=85,format=jpeg`), so there's no draw and no 20 MB cap. It is generated for photos in any Published set. The lesson's format-agnostic validation stays; here it requires JPEG.
  - `premium_preview`: **WebP or JPEG, 1600 px longest edge, watermark burned in**. It is generated only when `is_premium = 1` (for a photo, or a floorplan's preview JPG). The **source is the asset's own `web` rendition** (≤ 3200 px, well under 20 MB), passed to the **Images binding**: `env.IMAGES.input(webBytes).transform({ width:1600, height:1600, fit:"scale-down" }).draw(env.IMAGES.input(watermarkPng).transform({ width: <35% of edge> }), { opacity: 0.5, repeat: true or centred }).output({ format:"image/webp", quality:80 })`. Add an `images` binding to `workers/background/wrangler.jsonc`. The watermark PNG ships with the background Worker as a bundled asset (Open question 5: artwork).
  - Per-variant spec versions: `RENDITION_VARIANT_SPEC = { thumb:"v1", web:"v1", delivery_web:"v1", premium_preview:"v1" }`. `RENDITION_SPEC_VERSION` stays as the thumb/web value, so nothing existing regenerates. A watermark redesign later bumps only `premium_preview`.
- **Pipeline.** Keep the single `generate_renditions` message type, so DLQ, `rendition_dlq_events` and replay stay unchanged. `generateRenditions` computes the variant list from the asset:
  - thumb and web always;
  - `delivery_web` if the photo is in any `delivery_set_items` row;
  - `premium_preview` if it is premium, with `web` generated first.

  Enqueue from three places: mark-premium, Publish, and the supersede carry (a new premium row).
- **Spike first (slice 0).** On a preview deploy, prove:
  - (a) the background Worker's Images binding with `draw` over a real `web` rendition gives a correct 1600 px watermarked output, with measured CPU and bytes;
  - (b) its fallback: a `cf.image` fetch with `draw` from the background Worker through `global_fetch_strictly_public` over the same source URL;
  - (c) one 1.2 GB Full-res zip of 50 real originals streams to completion from the app Worker (wall time, CPU, no subrequest error), plus a 300-entry run to pin the cap.

  Write the result as a lesson. If (a) and (b) both fail, Premium photos ship as a locked "Premium extra" placeholder tile with no image, and that becomes Open question 5b. Nothing watermark-dependent merges before the spike passes.
- **Zips** (`delivery/zip.ts`, reusing `createZipStream`):
  - Photos only (story 46). `size=web` needs `delivery_web` ready for every included photo, else 409 `preparing` (the DTO says `webPreparing`). `size=full` uses originals with `assets.bytes`.
  - Locked items are excluded. A `Left out.txt` lists "Photo 7: premium, not unlocked yet" lines.
  - Caps: **300 entries, 12 GB**, to be pinned by the spike. A set over the cap answers 422, and the UI offers singles. No 256 MB staff cap.
  - Before byte 0, HEAD every object and compare sizes (502 `download_unavailable` on mismatch, as in the guest zip). **Each entry re-authorises** in one SQL statement, so a page switched off, a republish that dropped the item, or a relock mid-zip errors the stream and the archive is visibly truncated. The re-check covers the page still enabled, the item still in the current set, and the item still unlocked.
  - The archive is named `<address-part>-web.zip` or `-full-res.zip`.
  - Rate limit: per-IP 10 and per-page 60 zip starts per 15 min (`guest_rate_limits`, buckets `delivery-zip:ip:<hash>` and `delivery-zip:page:<projectId>`).
  - Singles and streams are not D1-limited (#741 precedent; a Range request must not be a write).
  - Optional owner hardening, not code: a Cloudflare rate-limiting rule on `/d/api/pages/*`.

## 4. Request unlock

- `POST /d/api/pages/:slug/items/:handle/unlock-request` checks, in order:
  1. Resolution as above.
  2. Origin and content-type (403 `invalid_origin`).
  3. The item is locked. If it isn't, answer 409 `not_locked`.
  4. Reserve the buckets: `delivery-unlock:ip:<hash>` 5 per 15 min, `delivery-unlock:page:<projectId>` 30 per day, and `delivery-unlock:item:<projectId>:<assetId>` **1 per day**.

  When the per-item bucket is full, answer **202 `{ status: "already_requested" }`** and write nothing. The client's experience is the same, and staff get no duplicates. When other buckets are full, answer 429 with `Retry-After`.
- One batch writes the audit row `delivery.unlock_requested` (actor NULL) and the notification outbox rows. The batch is fenced on the audit row, following `lib/video-review-notifications.ts`, and the actor id is the literal `delivery_page`.
- **Recipients:** active Admins, plus users with `project_members.role_on_project = 'editor'` on the Project. They need `viewClientPreview`, so External editors and Photographers are excluded even when they are members. The channels are `in_app` and `email`.
- **New notification type `delivery_unlock_requested`.** Touch every registry in one slice:
  - `NOTIFICATION_TYPES`;
  - `NOTIFICATION_WORKSPACE_TAB` → `"delivery"` (the exhaustive test);
  - a new outbox event type `project.delivery.unlock_requested`, with its payload type and the strict consumer parser;
  - `notification-enrichment` (system actor);
  - `external-notification` channel and title tables, plus `external-project-policy` as **denied** (never delivered to externals);
  - the consumer's title composer;
  - the parity tests.

  The payload is `{ projectId, assetId, tab }`. At delivery the consumer composes "Unlock requested: <Photo filename or Video title> · <street>". Staff may see filenames. The link goes to the Delivery tab.

## 5. UI

### Staff: a new **Delivery** workspace tab (only with `viewClientPreview` and an open gate)
- **Placement.** A new `WorkspaceTab` value `"delivery"`, not a Collection. It appears after the Collection tabs in `quincy/TabStrip`. `availableCollectionTabs` is untouched; the strip adds the tab when `GET /delivery` succeeds. A 404 means the gate is shut and the tab is hidden.
- **Header** (`reui/frame`, modelled on ReUI block `settings-8`'s URL row + Switch):
  - the address field (read-only `reui/input-group` + a copy button, with copy logic as in `quincy/CopyProjectLinkButton`);
  - "Published set N · <time> by <name>";
  - an Admin-only `reui/switch` "Page on" behind a `ConfirmDialog` when switching off;
  - a `quincy/StatusPill` for On or Off.
- **Checklist.** A `reui/frame` stacked per tab (Photos / Films / Floorplans / Copy), with `reui/item` rows. Each row has:
  - a `quincy/Checkbox`, ticked by `defaultSelection`;
  - the thumb (`LazyImage`);
  - the label;
  - a Premium `reui/switch`, which writes immediately through the premium PUT, with an optimistic toggle plus server truth;
  - Unlock/Relock: a `reui/button` that opens a `reui/dialog` with an optional payment reference, reusing the VideoDeliveryPanel unlock dialog pattern;
  - a "Preparing preview" `reui/badge` when `renditionsReady` is false.

  Photos follow the Edited order: Captures first, then sections by name, then `lower(original_filename)` inside each. Extract this into a shared pure `editedDeliveryOrder` used by both `PhotoGrid.groupWorkspaceAssetsBySection` and the server default, so the two can never drift.

  Each Video row has a `reui/select` of its Versions, defaulting to the latest; the premium controls call the existing Video routes. Section-level "Select all / none" uses `reui/button` variant ghost.
- **EXTRAS callout.** A `quincy/Notice` reads "N photos are in EXTRAS — mark them premium?" with one button. Nothing is ever auto-marked.
- **Cover.** A "Cover" radio among ticked non-premium photos (`reui/radio-group`). It defaults to the first.
- **Actions.** A sticky footer offers **Preview** (`reui/button` secondary) and **Publish** (primary), with the Publish confirm "Publish set N+1 to <url>" (`ConfirmDialog`). After the first Publish a toast reports the Stage move outcome. A 409 `set_changed` or `selection_stale` answer reloads the state and shows a `quincy/Notice`.
- **Preview.** A full-screen `reui/dialog` hosts `<DeliveryPage data={previewDto} mode="preview" />` from `src/delivery/`. A `reui/toggle-group` switches Desktop and Phone (a 390 px frame). In preview, download controls render disabled with the tooltip "Downloads are off in Preview" (`reui/tooltip`). The staff adapter (`lib/delivery-preview.ts`) calls the staff API. Only staff code imports `delivery/DeliveryPage`, never the reverse, and the boundary guard enforces that direction.

### Public page (`apps/web/src/delivery/`, a lazy chunk)
- **Mount.** `main.tsx` checks `isGuestReviewPath`, then **`isDeliveryPath(pathname)`** (the shared slug grammar), then mounts `mountDelivery(root)` before any staff boot. That gives no `captureBootLanding`, no preload and no `/api`. A `DeliveryLoadFailure` with Reload mirrors `GuestLoadFailure`. `delivery-api.ts` is the only `fetch` site.
- **Components** (all built from `reui` and boundary-clean `quincy` parts):
  - `DeliveryApp`: loads the DTO. A 404 shows the not-available state with `reui/empty` ("This delivery isn't available. Contact the studio." plus a mailto).
  - `DeliveryCover`: full-bleed `<img>` of `cover.previewUrl` with a scrim, the address in `--font-display`, the suburb, and the shoot date as an eyebrow (`quincy/Eyebrow`).
  - `DeliveryTabs`: `reui/tabs`, sticky, horizontally scrollable on a phone. Empty tabs are hidden. The Premium tab shows only when locked items exist.
  - `DeliveryGrid`: a CSS grid of `LazyImage` tiles (2 columns on a phone, 3–4 on desktop), each a button that opens the lightbox. Its ledger line is hand-built over `LazyImage`: the ReUI searches for "gallery/lightbox/slideshow" returned only sortable or ecommerce blocks, logged with `weakMatch` in this plan.
  - `DeliveryLightbox`: a `reui/dialog` full-screen holding the **shadcn base-nova `carousel`** (embla), a new install through the sandbox per `docs/reui-reuse.md`, ledger `@reui/c-carousel-8`. It reuses `lib/lightbox-navigation.ts` and `lib/lightbox-zoom.ts`. Keyboard ←/→/Esc, swipe via embla, `quincy/icon-button` controls, and a neighbour preload written locally because the staff hook imports a `PhotoGrid` type.
  - Slideshow: the same lightbox in `embla-carousel-autoplay` mode with the Fullscreen API, play/pause and a 5 s interval. `prefers-reduced-motion` stops the auto-advance.
  - `DeliveryDownloadMenu`: `quincy/menu.tsx` (Base UI menu) with "Web-size (JPEG, 2048 px)" and "Full-res (original)". It downloads through a programmatic `<a download>`, as the guest download does. "Download all" offers the same two choices plus a byte estimate, and shows `webPreparing` as disabled with "Preparing web-size files…".
  - Films: `quincy/VideoPlayer` fed the DTO's frame fields, plus `PremiumWatermark`, **moved from `guest/` to `components/quincy/PremiumWatermark.tsx`** so both public trees share it, when locked. Download is a single button, disabled when locked.
  - Floorplan: the preview image (watermarked when locked) plus a PDF download. Copy: a `reui/item` card with a PDF download.
  - `LockedTile`: the watermarked preview with a `reui/badge` "Premium". **Request unlock** is a `quincy/Button`; it moves through sent, already requested and 429 states, with the 429 shown as a `quincy/Notice` "Try again in N minutes". Beside it sits `mailto:` "Ask the studio".
  - Footer: the studio credit and contact.

  Tokens only, no hard-coded colours. It respects `design-system-guards`, and `ui-primitive-ratchet` needs no allowlist entry.
- **Reuse ledger (one line each, carried into every UI PR):** cover; tab bar (`reui/tabs`); grid tile (hand-built over `LazyImage`, with the searches noted); lightbox (`reui/dialog` + base-nova `carousel`); slideshow (`carousel` + `embla-carousel-autoplay`); download menu (`quincy/menu`); premium tile (`reui/badge` + `PremiumWatermark` for video); Request unlock (`quincy/Button` + `quincy/Notice`); not-available (`reui/empty`); Publish panel (`reui/frame` + `reui/item` + `quincy/Checkbox` + `reui/switch`, after ReUI `settings-8` and `settings-9`); preview (`reui/dialog` + `reui/toggle-group`); on/off (`reui/switch` + `ConfirmDialog`); address copy (`reui/input-group`, after `settings-8` and `CopyProjectLinkButton`).

## 6. Slices (ordered; each is one PR unless noted)

| # | Slice | Depends on | Key tests | Browser pass |
|---|---|---|---|---|
| **0** | **Spike** (branch + preview deploy, not merged): Images `draw` over a `web` rendition; `cf.image` fallback; a 1.2 GB / 50-entry zip and a 300-entry zip from the app Worker. Output: lesson + caps + chosen mechanism. | – | manual evidence in the lesson | no |
| 1 | **Docs + schema**: PRD §6.7 rewrite and its ✅ ticks, the Sitemap client-delivery entry, the Personas client persona; ADR 0022 → `accepted` **only with the owner's nod** (otherwise left `proposed`); glossary note on `client_links.kind='delivery'`. Migration A + drizzle schema; the `is_premium` comment rewritten; shared zod contracts (page DTO, publish body, slug grammar + `mintSlug`). No routes. **Owner applies the migration.** | – | db migration test (constraints, cascades, UNIQUE races); shared slug tests (grammar, never matches `review` `api` `unsubscribe`, ASCII fold, cut) | no |
| 2 | **Asset premium (server)**: premium/unlock routes; capability changes (`switchDeliveryPage` new, Editor + `manageVideoPremium`); the delivery gate helper; audit rows; the delete guard switched to `asset_premium_unlocks` + current-set membership; MCP copy. | 1 | worker HTTP: role matrix incl. Photographer and External 403; archived 409; idempotency; audit rows; gate-shut 404; capability matrix test | no |
| 3 | **Supersede carry**: `is_premium` and the unlock row copied in every supersede path; the Dropbox clobber removed; a guard test listing every `superseded_at =` writer. | 1 | background tests for dropbox, editor-folders and autohdr finals; app test for document re-upload | no |
| 4 | **Renditions**: the `delivery_web` and `premium_preview` variants; per-variant spec; conditional variant list; Images binding in the background wrangler; the watermark PNG; staff media variants; enqueue on mark-premium. | 0, 2 | seam 2: a premium photo gets a 1600 px watermarked variant; marking enqueues it; an un-published photo gets no `delivery_web`; failure → DLQ path; existing thumb/web spec unchanged | no |
| 5 | **Publish API**: GET state, POST preview, POST publish (slug mint, sets, handles, first-Publish Stage move), PUT enabled; manifest; publish enqueues renditions; the `editedDeliveryOrder` shared helper. | 2, 4 | seam 1: a numbered set + slug minted once; re-publish keeps the slug; re-upload leaves the page unchanged; first Publish → Delivered, later ones don't; `set_changed` and `selection_stale`; Preview writes nothing; roles | no |
| 6 | **Public read API**: `/d/:slug` shell, page DTO, item variants with lock enforcement, the miss limiter, `lib/public-http.ts` extraction, the new route class; `/d` pinned lists in route-manifest, the `/d`-reserved API test and `guest-stub.test.ts` updated deliberately; worker boundary guard extended to `src/delivery`. | 5 | page off ≡ unknown ≡ gate shut (byte-identical); locked refused on GET, Range and HEAD; preview never falls back to web; a cover marked premium after Publish is never served above `premium_preview`; Asset and Video Unlock live on both surfaces; **leak sweep** over every public body and header (no uuids, R2 keys, filenames, emails, staff names, invoice or payment fields) | no |
| 7 | **Public zip**: `photos.zip?size=web|full`, caps, per-entry re-auth, Left out, rate limits. | 6 | excludes locked items; relock or switch-off mid-stream truncates; web `preparing` 409; streams > 256 MB of declared entries (real objects of moderate size + ZIP64 path via `zip32Max`); 429 | no |
| 8 | **Request unlock + notification type** across all registries. | 6 | writes an outbox fenced on audit; per-item dedupe 202; IP and page 429; recipients = Admins + Project Editors only; parity, workspace-tab and external-policy tests | no |
| 9 | **Public web app** (`src/delivery/`): mount, API module, page, tabs, grid, lightbox, slideshow, films, floorplan, copy, locked tile, Request unlock, not-available; carousel install via the sandbox; `PremiumWatermark` move. | 6, 7, 8 | seam 3 (happy-dom, fake API): tab visibility, lightbox keys and swipe, slideshow, download menu, locked behaviour, Request unlock states, not-available, phone layout; web boundary guard extended; ratchet; routing-transport; design-system guards | **yes** (desktop + phone, Agy → design-reviewer) |
| 10 | **Staff Delivery tab**: tab, checklist, premium/unlock controls, EXTRAS callout, cover, Preview dialog, Publish, copy address, on/off. | 5, 9 (DeliveryPage) | dom tests: defaults, untick, cover rule, Preview writes nothing, 409 handling, Photographer and External never render the tab; notification arrival opens the tab | **yes** (desktop + phone) |
| 11 | **Cleanup Migration B**: drop `premium_unlocks` and `publishes`. | 2 deployed | db test; owner applies | no |

Slices 2–4 can run in parallel after 1, and 6–8 after 5 (7 and 8 depend only on 6). The rollout runs after 10: the owner inserts `client_delivery` and `client_delivery_pilot:<id>` for one real Project, sends the link to themself, checks it, then turns on `client_delivery_all_projects`.

## 7. Risks and open questions

**Risks (mitigated in the plan):**
- **The watermark mechanism is unproven.** Slice 0 gates it, and the fallback is the "no image" locked tile.
- **Supersede paths are many.** Slice 3's guard test lists every writer.
- **Zip subrequest and wall-time limits.** Slice 0 pins the caps.
- **#776 video Trash.** Public reads must exclude Trashed Versions with #776's predicate. If #776 lands after slice 6, slice 6 adds the filter when it rebases.
- **Address enumeration.** The 6-char suffix and the miss limiter cover it.

**Open questions for the owner (everything else is decided above):**
1. **Editors and Video premium.** #741 made `manageVideoPremium` Admin-only, but stories 26–28 have Editors unlocking everything, including Video. *Default: give Editor `manageVideoPremium`, which makes one premium capability set for all media.*
2. **Unlock on re-edit.** Should a paid Unlock carry to a re-edited version of the same photo? *Default: yes (premium and unlock both carry forward).*
3. **Suffix length.** *Default: 6 chars from a vowel-free alphabet*, instead of the issue's example of 4, against bots that know the street.
4. **Studio credit and contact email** for the page footer and the "Ask the studio" link. *Default: "Quincy Productions" and a `STUDIO_CONTACT_EMAIL` var you set.*
5. **Watermark artwork and placement.** *Default: a tiled diagonal studio wordmark at 50% opacity; the owner supplies the PNG.* (5b, only if the spike fails: ship locked premium photos as an imageless "Premium extra" tile.)
