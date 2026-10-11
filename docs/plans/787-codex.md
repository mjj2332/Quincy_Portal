# Issue #787 — Client Delivery build plan

Planning only; no files edited or tests run. This is the Codex planning report for the Opus/Codex synthesis.

Assume #789, #790 and #741’s client digest merge first. ADR 0022 and the shared glossary remain authoritative: one public address per Project, explicit Publish, frozen Published sets, and shared premium Unlock state.

## 1. Data model and migrations

### New storage

Use new tables rather than reshape the unused `publishes` table.

| Table | Fields and constraints |
|---|---|
| `delivery_pages` | `id`; unique `project_id`; unique immutable `slug`; `enabled`; `latest_set_number`; optimistic `revision`; creation/update timestamps. |
| `delivery_published_sets` | `id`; `page_id`; positive `set_number`; publisher and timestamp; idempotency key; frozen public address/suburb/shoot date/studio credit; cover Asset reference. Unique `(page_id, set_number)` and `(page_id, idempotency_key)`. |
| `delivery_published_items` | `id`; `set_id`; random unique `public_handle`; media kind; explicit display order; frozen public label; either a non-video Asset reference or Video plus exact Version Asset reference; optional paired Floorplan preview Asset reference. Enforce valid combinations. |
| `delivery_item_renditions` | `id`; item reference; rendition purpose; immutable R2 key, bytes, content type, dimensions and spec version. Unique `(item_id, purpose)`. Never return these keys publicly. |
| `asset_premium_unlocks` | `id`; unique canonical `asset_id`; Project reference; unlocking staff member; timestamp; optional payment reference, maximum 200 characters. Row presence means unlocked; Re-lock removes it. |

All new FKs target single-column `id` keys, following `docs/maps/new-table.md`. Published media references use **RESTRICT**, not cascading Asset deletion.

Add:

- `assets.delivery_premium`, boolean, default false. Use a fresh column because `is_premium` is explicitly deprecated and historically related to section classification.
- `videos.delivery_premium_committed_at`, nullable timestamp: a permanence guard for a Video adopted into Delivery, **not another premium entitlement or unlock model**.
- Operator-owned `delivery_pages` feature flag, seeded off with `ON CONFLICT DO NOTHING`.

Keep legacy `publishes`, link-scoped `premium_unlocks`, and `client_links.kind = 'delivery'` dormant. Dropping or narrowing them offers no benefit to this feature.

Allocate migration numbers after checking merged and open branches; do not assume 0070 is available. Update schema, journal, migration tests, QA fixtures, teardown graph, audit target registrations and deletion handling. Use additive migrations without table rebuilds. The owner alone applies production migrations under `docs/Guides/CI-Deploy.md`.

### What Publish freezes

A Published set freezes:

- Membership and exact media revisions.
- Display order, public labels and cover.
- Public Project display fields.
- Original and ordinary derivative object references.

It does **not** freeze the page switch or premium access state. Unlock/Re-lock must affect an already published item immediately.

Current source ordering is:

- Edited photos: case-folded filename, original filename, Asset id, matching `routes/review.ts`.
- Videos: existing Video position/order.
- Floorplans and Copy: current document revisions; Floorplan PDF and its matching JPEG preview are one public item.

Store that order explicitly. No filename sorting occurs in the public browser.

**Retain the delivered bytes.** Reads must use pinned rows even after `superseded_at` is set. Add a friendly 409 deletion refusal and an atomic publication-reference predicate to Asset deletion. The existing delete route commits the D1 deletion before removing R2 bytes; RESTRICT provides the concurrent Publish/delete backstop. Cover both members of a Floorplan pair.

Integrate publication pins with #776’s Video trash/purge path. Trashing or superseding workspace media must not change a Published set; physical purge skips pinned Versions. Historical sets retain their media until Project hard deletion. Hard deletion deliberately removes Delivery records and purges every owned media prefix.

### Publish transaction

One D1 batch must:

1. Validate the selection, Project state, page revision and expected latest set.
2. Allocate the next set number and, on first Publish, the address.
3. Insert the frozen set, membership and rendition references.
4. On first Publish, compose the existing stage-move bundle to Delivered.
5. Write Publish audit/activity/outbox records.
6. Advance the latest-set pointer.

Reuse `lib/project-stage.ts` and the `@quincy/db` stage bundle composition. Do not call a separately committing stage HTTP endpoint after publishing.

The Publish action explicitly acknowledges the Delivered transition. A stale board revision, inactive Delivered stage or failed membership validation leaves **no partial publication**. If already Delivered, first Publish creates no redundant stage move. Later Publishes leave Stage alone.

Use a client operation id for retries. Retrying the same operation returns the committed result; a deliberate subsequent Publish creates another set. Concurrent different Publishes produce one winner and a 409 for the other.

### Address and premium defaults

- Mint `<address-slug>-<8 random base36 characters>` using cryptographic randomness, a unique index and bounded collision retries.
- Normalize to bounded lowercase ASCII; use `property` when normalization produces no usable address.
- Mint only at first Publish; address edits never change it.
- First Publish enables the page. Re-publishing an off page keeps it off.

Non-video premium marking is permanent. Reconciliation must preserve the new flag; replacement revisions inherit premium status, while a new physical Asset starts locked. Floorplan access is governed by its canonical PDF Asset, including the paired JPEG.

Videos retain `videos.premium` and **the existing `video_premium_unlocks` row**. One Unlock therefore applies to Delivery and Review links.

There is a real code/glossary mismatch: the existing Video setter and UI permit clearing premium. Chosen correction: when a premium Video is marked through Delivery or first published there, stamp `delivery_premium_committed_at`; every shared Video premium writer subsequently refuses clearing it. Review-only Videos retain their existing behavior until adopted. This preserves a dark rollout and requires an explicit compatibility change to `VideoDeliveryPanel` and its tests.

Audit Publish, premium marking, Unlock, Re-lock and page switching in the same batch as their mutations. Preserve impersonation provenance. Audit only whether a payment reference exists, never its contents.

## 2. Routes and authorization

### Staff routes

Suggested family: `/api/projects/:projectId/delivery`.

| Method and suffix | Purpose | Capability |
|---|---|---|
| `GET /` | Published state and authoritative address for copying | `publish` |
| `GET /candidates` | Default selection, readiness and premium state | `publish` |
| `POST /preview` | Render DTO for the submitted unpublished selection | `viewClientPreview` |
| `GET/HEAD /preview/items/...` | Staff-authenticated preview media/downloads | `viewClientPreview` |
| `POST /publishes` | Publish the submitted selection and cover | `publish` |
| `PUT /assets/:assetId/premium` | Mark a canonical non-video Asset premium | `manageExtras` |
| `PUT /assets/:assetId/premium-unlock` | Unlock/Re-lock | `manageExtras` |
| `PUT /videos/:videoId/premium[-unlock]` | Delivery wrappers around the existing shared Video mutations | `manageExtras` |
| `PATCH /enabled` | Switch off/on with expected revision | Admin-only `adminBackend` |

Every route requires the feature gate, an active staff session and Project visibility. Mutations require the existing Origin protection.

| Role | Publish / Preview / copy | Premium management | Page switch |
|---|---:|---:|---:|
| Admin | Yes | Yes | Yes |
| Editor | Yes | Yes | No |
| Photographer | No | No | No |
| External editor | No | No | No |

Use `manageExtras` for Delivery’s media-wide controls. Today `manageVideoPremium` is Admin-only; do not silently widen existing Review authorization. Delivery’s Video wrappers call the same mutation functions and unlock table. Under the Delivery gate, `VideoDeliveryPanel` can use those wrappers for Editors.

Archived Projects remain readable but refuse Publish and premium mutations. Admin page switching remains available, including on archived Projects. Archiving alone does not revoke an already delivered page.

Preview creates no page, slug, Published set, audit publication or Stage change. Its media stays behind the staff session and simulates client locks. “Request unlock” in Preview is a local demonstration and sends no notification.

### Public routes

| Route | Behavior |
|---|---|
| `GET /d/:slug` | Lazy public page shell |
| `GET /d/api/pages/:slug` | Strict, minimal latest-set DTO |
| `GET/HEAD .../items/:handle/preview` and `/thumb` | Permitted display bytes |
| `GET/HEAD .../items/:handle/stream` and `/poster` | Exact published Video Version |
| `GET/HEAD .../items/:handle/download?size=web\|full` | Photo download |
| `GET/HEAD .../items/:handle/download` | Video or document original |
| `GET .../downloads?size=web\|full` | Photo zip preflight |
| `GET .../downloads/all.zip?size=web\|full` | Streaming photo zip |
| `POST .../items/:handle/request-unlock` | Anonymous unlock request |

No public route uses a staff session, Review token, guest identity, `client_links`, Version grant, approval or Release. Publishing a Version is sufficient for Delivery playback/download.

Reuse `serveR2Object`, `createZipStream`, HTTP hygiene, bounded `readJson`, and client refusal parsing. Write distinct Published-set authorization and DTOs; `guest/read.ts` and `guest/download.ts` contain Review-only predicates.

Every media lookup checks:

- Global Delivery gate and enabled page.
- Membership in the latest Published set.
- Handle-to-page ownership.
- Current premium/unlock state.

Check locks **before** R2 HEAD, Range parsing or conditional handling. Locked photo/document downloads return 403 `premium_locked` for GET, HEAD and Range alike, without size/ETag disclosure.

Public DTOs expose random handles and generated labels such as “Photo 07,” never Asset/Project/Video ids, R2 keys or original filenames. Generate download filenames from the public property slug and ordinal. Omit staff, agent, invoice and payment fields. The configured **studio** contact address is the intentional email exception.

### Refusals and `/d` collisions

Follow #741’s shell pattern: valid slug syntax receives the same shell regardless of existence; its data request determines availability. Unknown, unpublished, disabled and gate-closed data requests return the same hygienic 404. `classifyRefusal` renders “Not available — contact the studio”; transport/500 failures remain retryable errors.

Register existing Review/unsubscribe routes first, then Delivery API and the exact single-segment slug route, then `/d` and `/d/*` stubs, then SPA fallback.

The slug matcher requires lowercase canonical syntax containing a hyphen. Explicitly exclude `review`, `unsubscribe` and `api`; reject encoded spellings, trailing slashes and extra segments without normalization.

Update:

- Route manifest and terminal-route registrations.
- `/d`-reserved API tests.
- Guest stub tests and raw-path matcher tests.
- Public import-boundary guards.

Preserve `/d/review`’s synchronous fragment scrub before its lazy import. Select the Delivery tree before staff boot timing, preloads or rendering.

All public responses—including media, errors and zips—carry `noindex`, `no-referrer`, `private, no-store` and `nosniff`. Never expose signed transform-source redirects.

## 3. Derivatives and large zips

### Web-size and watermarking

Today’s durable `web` is 3200px, quality 85, and can be WebP **or JPEG**. Chosen delivery format is JPEG for listing/social compatibility.

Add rendition variants:

- `delivery_web`: JPEG, 3200px longest edge, quality 85, no upscale.
- `premium_preview`: JPEG, at most 1600px longest edge, server-burned studio watermark.
- `premium_thumb`: thumbnail derived from the watermarked output.

Generate `delivery_web` from the immutable original through the existing background transformation path. Feed that bounded stored result into a new background Images binding for watermarking. The binding accepts R2 streams and has a 20 MB input cap; remote transformations support sources up to 100 MB. [Cloudflare Images binding](https://developers.cloudflare.com/images/optimization/binding/), [Images limits](https://developers.cloudflare.com/images/get-started/limits/).

Extend the variant registry and versioning without invalidating existing staff thumb/web reads or frozen publication references. Queue/backfill the new variants; marking premium queues secure previews. Preserve retry and DLQ diagnostics. Missing secure previews fail closed with a processing state, never an ordinary thumbnail or original.

For Floorplans, watermark the existing paired JPEG. Copy PDFs currently have no raster preview; default to a locked document tile with no PDF bytes. Unlocked Copy offers the original PDF.

**Prerequisite Preview spike:** prove the complete generation-and-storage path using real landscape/portrait studio photographs, including originals above 20 MB. Verify dimensions, actual JPEG decoding, visible burned-in watermark, stripped metadata, R2 persistence and failure handling. A 200 response or mocked transform is insufficient. Follow the lessons “Image renditions / Cloudflare Images,” “Renditions + transforms deploy,” and “Rendition DLQ silent backlog.”

Locked Videos retain #741’s browser overlay and server-refused download; no re-encoding.

### Zip strategy

Reuse the pull-driven STORE/ZIP64 writer and native CRC. Do not buffer archives, use browser Blob downloads, or apply the staff 256 MiB cap.

Choose **500 photos / 8 GiB aggregate** per Delivery zip. This is independent of Review’s **20 films / 8 GiB** cap.

1. Rate-limit the start before expensive work.
2. Capture the latest set; include ordinary and unlocked premium photos once.
3. Preflight actual R2 sizes with bounded concurrency.
4. Write the fenced download audit before streaming.
5. Stream one R2 object at a time.
6. Before each entry, recheck gate, page switch, captured latest set and unlock state.
7. Include a sanitized `Left out.txt` note for initially excluded locked items.

A subsequent Publish, switch-off or Re-lock aborts the archive before the next entry; never finalize a misleading partial archive. Cancel R2 readers on disconnect. ZIP HEAD returns 405 and performs no generation; zip resume is unsupported. Singles retain Range support.

Workers document 128 MB isolate memory, six connections awaiting headers, a default paid subrequest budget of 10,000, and no enforced response-body limit. The repository still sets 30 seconds CPU. Streaming fits these constraints, subject to a deployed workload check. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

Measure a real 40-photo archive above 256 MiB and a ZIP64 archive above 4 GiB on Preview. Already sent bytes cannot be withdrawn; new requests fail immediately after switching off or relocking.

## 4. Request unlock

Reuse `guest/rate-limit.ts`’s atomic reservations with Delivery-specific buckets. No anonymous session is needed.

Initial defaults:

- Unlock requests: **10/IP and 30/page per 15 minutes**.
- Deduplicate the same page/item request within that window, across IPs.
- Zip starts: **10/IP and 30/page per 15 minutes**.
- Read/media requests: generous separate quotas, charged per request without a low video-seek cap.

Hash IP/window values; store no raw IP. Use bounded JSON, same-origin POST protection and `429` with `Retry-After`. Unknown/off pages and invalid handles produce no notification. Only a currently published, locked premium item is eligible.

An accepted request writes, in one D1 batch:

- Anonymous-provenance audit row.
- Deduplication marker.
- Notification outbox rows for active Admins and the Project’s assigned internal Editor(s), deduplicated.

Example staff notification:

> **Unlock requested — 13 Asquith Avenue, Rosebery**  
> An anonymous Delivery-page visitor requested Photo 07: `[staff Asset name]`, Published set 3.

Link to the Project workspace’s Delivery controls. Claim no client identity. Register the notification across the shared parity registry, preferences, enrichment and delivery pipeline; use normal staff digest behavior. Do not inherit Review’s broader recipient policy, which can include External editors.

## 5. UI and reuse ledger

### Staff Publish panel

Open from the Project workspace header, visible only to Admin/Editor behind the gate.

- Pre-tick current Edited photos, current Floorplan/Copy documents and each Video’s latest complete Version.
- Preserve unticks and cover choice through refreshes/conflicts.
- Default cover to the first selected photo; unticking it selects the next. With no photos, use a branded address/date cover.
- Show readiness and premium state.
- Preview uses the same public presentation with a staff API adapter.
- Publish shows the set number and first-Publish Stage effect.
- After publishing, show immutable address, Copy action, publication details and Admin switch.
- An off page stays off during re-publication.

### Public page

Full-bleed cover, address and shoot date; sticky tabs; ordered photo grid; lightbox; slideshow; Film player; Floorplan preview/download; Description PDF; studio footer.

Hide empty media tabs. Ordinary tabs contain non-premium and unlocked items. Premium remains a catalog of marked extras, showing locked/Unlocked state. Zip inclusion deduplicates handles.

Use keyboard and swipe photo navigation, Escape/focus restoration, and an explicitly started slideshow with pause/next/previous. Stop timers when closed or backgrounded. Pause Video playback on unmount.

On phones, retain visible actions and 44px targets; no hover-only controls. Use the Portal’s existing phone breakpoint and token set.

### Reuse ledger

All named primitives are installed. ReUI MCP was unavailable in this session; the dated local fallback was inspected for gallery/carousel candidates.

| Element | Reuse |
|---|---|
| Publish panel and grouped settings | `reui/frame`, `FramePanel`, `reui/item` |
| Selection ticks | `quincy/Checkbox` |
| Cover choice and premium status | `reui/button`, `reui/radio-group`, `reui/badge` |
| Publish/Preview actions | `reui/button`; `reui/dialog` or `reui/sheet` |
| Address copy | `CopyProjectLinkButton`’s shipped Copy/Copied pattern, with the server-supplied Delivery URL |
| Admin switch and confirmation | `reui/switch`, `reui/alert-dialog` |
| Public cover and metadata | `LazyImage`, `quincy/Eyebrow`, `quincy/SectionHead`; `Frame` where a surface is needed |
| Sticky tab bar | `quincy/TabStrip` |
| Grid and premium tiles | `reui/item`, `reui/button`, `LazyImage`, `reui/badge` |
| Lightbox | `reui/dialog`; safe `lightbox-navigation`, `lightbox-zoom` and neighbor-preload helpers |
| Slideshow | Same lightbox plus `reui/button`/`toggle` controls |
| Download menu | Quincy-owned `quincy/menu` |
| Video player and locked overlay | `quincy/VideoPlayer`, `VideoStage`, guest `PremiumWatermark` |
| Floorplan/Copy tiles | `reui/frame`, `reui/item`, `LazyImage`, `reui/button` |
| Request unlock and studio email | `reui/button`, ordinary mail link |
| Loading, refusal and errors | `reui/skeleton`, `spinner`, `quincy/EmptyState`, `Notice` |

Do not import the staff `Lightbox.tsx`: it reaches staff auth/API. Compose its safe presentation pieces behind `Dialog`. The fallback `product-detail-3` gallery and `c-carousel-*` examples lack the required full-screen delivery viewer/download behavior; no carousel adoption is needed.

Every UI PR carries its complete ledger. Add no raw widget primitives or allowlist growth. Use **frame**, following ADR 0014.

## 6. Ordered PR slices

| Slice | Dependencies and scope | Required verification | Browser pass |
|---|---|---|---|
| **1. Contracts and docs** | After #789/#790/digest. Correct PRD §6.7, Sitemap and Personas; include ADR/glossary if absent. Record schema/API decisions and ledger. | Documentation/contract guards; confirm prerequisite routes and migrations on merged main. | No |
| **2. Watermark spike** | After 1. Gated background Images binding and representative generation proof. | Real Preview images, dimensions/format/watermark/R2 evidence; no original fallback. | Visual media inspection |
| **3. Schema and retention** | After 1; settle spike before locking derivative references. New tables/columns/flag, QA fixtures, publication pins and purge integration. | Migration chain/FKs; flag ownership; Asset pair deletion and Video purge protection; Project hard delete. | No |
| **4. Derivative pipeline** | After 2–3. JPEG Web-size, secure preview/thumb, generation/backfill/DLQ; premium inheritance in ingestion. | Background tests for readiness, dimensions, replay and failures; existing staff media remains readable. | No additional UI pass |
| **5. Publish and staff read/Preview API** | After 3–4. Atomic publication, numbering, immutable slug, frozen DTO and Delivered bundle. | `SELF.fetch`: all roles, Origin, retry/concurrency, first/later Stage behavior, re-upload freeze, Preview writes nothing, Publish/delete races. | No |
| **6. Premium and page controls** | After 3 and 5. Asset Unlock/Re-lock, shared Video wrappers/permanence guard, Admin switch. | Role matrix; audit/provenance; archive behavior; same Video unlock on Review and Delivery; off retained on re-Publish. | Yes if existing Video controls change |
| **7. Public read/media and boot** | After 5–6. Strict slug routes, boundary, minimal DTO, display/playback and single downloads. | GET/HEAD/Range lock matrix; unknown/off equality; stale/cross-page handles; leak sweep; route/stub/import guards. | Yes—public shell and media states |
| **8. Large photo zips** | After 7. Preflight, bounded streaming, ZIP64, quotas and exclusions. | Above-256-MiB HTTP stream; CRC/archive extraction; cap boundaries; switch/relock/re-Publish interruption; cancellation; deployed ZIP64 workload. | Yes when download UI lands |
| **9. Unlock notifications** | After 6–7. Anonymous request, dedupe, recipient policy and outbox parity. | Concurrent dedupe; IP/page limits; no rows for invalid/off/unlocked items; atomic audit/outbox; no External/Photographer recipients. | Yes when request UI lands |
| **10. Staff Publish UI** | After 5–6. Panel, defaults/unticks/cover, staff Preview, Publish/address/switch. | DOM behavior with fake API; draft retention; clipboard failure; role hiding; Preview notification simulation. | Yes |
| **11. Public presentation and final gate** | After 7–10. Complete tabs/grid/lightbox/slideshow/mobile/download/unlock states. | Happy-dom behavior, all boundary/design/routing/primitive guards, final `npm run verify` on current main. | Yes—complete desktop/phone pass |

Every UI pass has **Agy measurements, then blind Opus design-reviewer judgment**, followed by session screenshot verification. Serve only through `serve-branch.sh`; record server pid/cwd/HEAD/bundle before and after. Use fixtures containing durable derivatives rather than triggering unsupported local transforms.

Keep production dark throughout. Owner applies migrations before deployment; enable the gate only after end-to-end verification.

## 7. Risks and owner questions

**Material risks**

- Publication pins increase retained storage; history must survive re-edits and deletion attempts.
- Watermark generation needs deployed proof; local tests cannot establish Cloudflare transform behavior.
- The Video permanence correction changes existing controls for Videos adopted into Delivery. Include that compatibility change explicitly in review.
- Streaming revocation applies to subsequent requests/entries; downloaded bytes cannot be recalled. Video protection remains the accepted #741 browser-overlay model.

**Owner input genuinely needed**

1. Which studio email should the public “email the studio” link use? No suitable public contact configuration was found.
2. Is a visual preview of locked **Copy PDFs** required for this release? Default: a locked document tile. A visual preview needs a separately scoped PDF rasterizer or preview-upload contract; the existing image pipeline cannot rasterize PDFs.