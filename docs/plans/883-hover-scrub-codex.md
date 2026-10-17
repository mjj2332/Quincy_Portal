# #883 plan — Codex (blind), base 4d7a5d2f

Raw planner output, kept for the record; the settled synthesis is `docs/plans/883-hover-scrub.md`.

## 1. Files and modules

- Base verified: `HEAD` and `origin/main` are `4d7a5d2f`; paths below are under `portal/` unless stated otherwise.
- **Recommend option (a): background extraction for supported inputs, poster fallback otherwise. OWNER decision:** approve incomplete coverage for files ≥100 MB or >10 minutes. This preserves background generation but narrows coverage; the reported 10 oversized Versions must be explicitly accounted for.
- Option (b) changes the settled background-job approach and needs browser-driven backfill; (c) supports larger inputs but adds Container/ffmpeg operations and requires an owner-approved amendment to ADR 0020; (d) retains both systems’ complexity. Recommend neither for this ticket.
- First prove private extraction and composition with representative fixtures. Add background binding `VIDEO_TRANSFORMS` alongside existing R2 `MEDIA` and `IMAGES`; verify locked Wrangler 4.112.0/types support it before selecting any dependency update.
- Current [Media binding](https://developers.cloudflare.com/stream/transform-videos/bindings/) supports `spritesheet.imageCount`, but documents no grid control; spritesheet selection spans at most 60 seconds. Recommend **20 `mode=frame` extractions plus Images composition** for explicit geometry and full-film coverage. [Limits/options](https://developers.cloudflare.com/stream/transform-videos/)
- Add `packages/shared/src/video-sprite.ts`, exported from `src/index.ts`: immutable spec v1, sampling/index calculations, `videoSpriteKey(...)`, `VideoSpriteMessage`, DTO schemas and best-effort enqueue helper.
- Spec v1: **20 frames, five columns × four rows, 320×180 cells, 1600×720 JPEG, quality 70**. Preserve aspect ratio and centre each frame over black padding; no cropping. Use a small bundled black canvas and existing `IMAGES.draw` composition.
- Sample presentation-frame centres uniformly: `fᵢ = min(frameCount−1, floor((i+0.5)×frameCount/20))`; convert through shared rational frame-time helpers. This spans 4.5-second and 117-second films; very short sources may repeat frames. Verify fractional timestamps against Cloudflare.
- Add `packages/db/src/video-sprite-lifecycle.ts`: `requestVideoSprite`, `claimVideoSprite`, `generateVideoSprite`, generation-fenced failure/release/adoption; inject extraction/composition for tests. Reuse cleanup helpers from `embedded-media-lifecycle.ts`.
- In `workers/app/src/routes/video-uploads.ts`, initialize eligible sprite work **inside successful server-probed completion’s D1 batch**, then enqueue after commit. Rejected uploads create none; repeated completion cannot start another generation. Poster capture/upload remains its existing independent operation.
- Add `workers/background/src/video-sprites.ts`; extend `queue-dispatch.ts` and `index.ts` for `{ type: "video_sprite", assetId, generation }` on `quincy-renditions`. Respect its existing concurrency of one and `RENDITIONS_ENABLED`; add a sprite-specific rollout switch.
- Extend the rendition DLQ branch **before its unknown-message fallback**: mark only the matching pending generation failed; do not create photo rendition replay records for sprite jobs.
- Add `video-sprite-recovery.ts`: minute cron resends at most ten stale pending requests using their original generation, separately stamping resend time. Missing historical rows must never become automatic backfill candidates.
- Extraction HEAD-checks source size/type, pins every R2 GET to that ETag, streams original bytes, and buffers only bounded frame JPEGs. Validate final JPEG dimensions/content and cap output at 1 MB before publication.
- Publication: fresh `sprite-<uuid>.jpg` under `projects/<project>/video/<video>/<asset>/`; cleanup entry **before PUT**; one batch adopts key/spec/status, audits success and removes that exact unclaimed cleanup entry. Fence on generation, attempt, lease, live Version/Video and unarchived Project.
- Duplicate/current-spec jobs no-op. Transient failures release their lease before queue retry; permanent unsupported inputs stop cleanly; attempt cap/DLQ records failure. A thrown adoption uses adopted/miss/unknown settlement: unknown retains bytes for reconciliation.
- Extend `video-trash-purge.ts`’s Version and whole-Video batches, `notLiveKey`, and `embedded-media-sweep.ts:holdsLiveVideoKey` to include `sprite_key`. Trash retains adopted sprites; restore can request a missing eligible sprite.
- Extend `embedded-media-orphan-sweep.ts` with strict Video sprite recognition and a resumable per-Project `video/` scan. Its exact-key reference test must preserve **trashed as well as live** Version references. Keep enqueue-only deletion.
- Project hard delete already covers the Project R2 prefix; verify late generation cannot adopt after deletion. `routes/assets.ts` rejects direct Video deletion, so it needs no new Video deletion path.

## 2. Schema, routes and DTOs

- Add migration **`0081_video_sprites.sql`**, Drizzle schema changes and journal entry; 0080 is the highest migration at this base. Use additive columns on `video_version_meta`, no rebuild, trigger or new table.
- Exact columns: `sprite_key TEXT DEFAULT NULL`; `sprite_spec_version INTEGER NOT NULL DEFAULT 0`; `sprite_status TEXT NOT NULL DEFAULT 'missing'`; `sprite_attempts INTEGER NOT NULL DEFAULT 0`.
- Also: `sprite_requested_at INTEGER DEFAULT NULL`, `sprite_resent_at INTEGER DEFAULT NULL`, `sprite_lease_until INTEGER DEFAULT NULL`, `sprite_error TEXT DEFAULT NULL`.
- Add unique partial index on non-null `sprite_key`; CHECK status in `missing,pending,ready,failed,unsupported`, spec/attempts nonnegative integers, and nullable timestamps integer epoch milliseconds. Geometry comes from the immutable spec, not separate columns.
- `sprite_requested_at` identifies a generation; a new request uses `max(now, previous+1)`. Resends never change it. Every claim, release, failure, DLQ update and adoption repeats it.
- **Keep existing staff, guest and Delivery DTOs unchanged.** Add supplemental `GET <base>/sprite-info` returning `{ sprite: null | { url, specVersion, frameCount, columns, rows, tileWidth, tileHeight } }`; `GET <base>/sprite` returns JPEG bytes.
- Bases: `/media/video/:assetId`; `/d/api/links/:linkId/versions/:assetId`; `/d/api/pages/:slug/items/:handle`; `/api/projects/:projectId/delivery/items/:handle`; `/api/projects/:projectId/delivery/preview-media/:assetId`.
- `routes/media.ts`: share `readableVideoVersion` admission with poster; metadata requires a poster and ready current-spec sprite. Binary serving repeats Version liveness after R2.
- **Correct ticket pointer:** Version guest posters live in `guest/index.ts`; `guest/media.ts:servePoster` serves embedded note videos. Add Version sprite routes through `withSession` and `resolveGrantedVersion`, rechecking session/link/grant/liveness before returning bytes.
- `delivery/index.ts`: extend raw-path matching and use `admitItem`/`serveItem` authorization, current-set identity and Premium recheck. `routes/delivery-media.ts`: support current-set and eligible-preview families through `admitDelivery`; recheck lock/set/eligibility after R2.
- Preserve each poster surface’s denial semantics. Locked Delivery films receive neither metadata nor sprite bytes; Delivery remains independent of the Video Review gate. Public responses expose handles, never Asset IDs or R2 keys.
- Sprite metadata and bytes use private `no-store` responses and existing security headers. Missing/failed/unavailable sprites retain today’s poster without visible status UI.
- Register every route in `lib/terminal-route.ts` and `route-manifest.test.ts`; classify Admin backfill as `withheld`, with no MCP tool.
- Add `POST /api/admin/video-versions/sprites/backfill` in `routes/admin.ts`, backed by `lib/video-sprite-backfill.ts`: `adminBackend`, default `{ dryRun:true, limit:5 }`, UUID cursor, limit 1–10.
- Response: `{ dryRun, scanned, items, nextCursor }`; items identify Version, source facts and status: `would_queue|ready|pending|failed|unsupported_size|unsupported_duration|trashed|archived|missing|object_changed|conflict`. Dry run performs **no D1, R2, queue or audit writes**.
- Real requests require the approved page’s explicit `{assetId, etag, specVersion}` candidates; recheck them before conditional request writes. Return `queued` versus `pending_send`; persist per-Version request audit plus page summary. Repetition cannot duplicate a generation.
- Recommend inventorying all reported 42 Versions, explicitly skipping Trash/archived rows for generation; restore handles missing sprites later. Recalculate totals and the live/size intersection—“32 live” does not establish “32 eligible.”
- Add `docs/Guides/Video-Sprite-Backfill.md`, copying #900’s signed-in Admin console procedure: owner reviews **every dry-run page**, approves exact candidates, captures a fresh D1 bookmark, then runs the approved pages and reconciles completion/audits.
- Migration follows `CI-Deploy.md`: owner bookmark → apply only 0081 remotely → rerun deploy. Backfill needs its own post-deploy bookmark before its first write.
- Put recovery in a separate appendix labelled **“ONLY IF THE RUN WENT WRONG”**: pause sprite producers/consumers before `npx wrangler d1 time-travel restore DB --bookmark=<id>`. State that restore loses subsequent D1 writes and does not restore R2 or queue state.
- Estimated storage: **100–300 KB/Version**, hard cap 1 MB; measure fixtures. At [$0.015/GB-month](https://developers.cloudflare.com/r2/pricing/), typical marginal storage is about $0.0000015–$0.0000045/month per Version, plus operations.
- Budget 20 frame operations—about **$0.01/Version** at published non-beta rates—plus Images composition, Workers/D1/queue operations and retries. Media binding extraction is currently unbilled during beta; shared free allowances and composition metering must be checked in the spike. [Media billing](https://developers.cloudflare.com/stream/transform-videos/bindings/), [Images pricing](https://developers.cloudflare.com/images/pricing/)

## 3. Tests: red first

- Add `packages/db/test/migration-0081.test.ts`: defaults preserve existing rows; checks/index reject invalid state; journal ordering; FK safety and QA fixture column/teardown guards.
- Add shared sampling/geometry/DTO tests: 4.5 s, 117 s, fractional fps, one-frame repetition, first/last hover bin, portrait padding, exact size/duration boundaries and no raw storage keys.
- Add lifecycle/background tests using prior art `embedded-display.test.ts`, `queue-dispatch.test.ts`, `rendition-dlq.test.ts` and `video-upload.test.ts`: committed-only enqueue, duplicate completion, lost sends, stale generation/DLQ, expired lease, retry cap, ETag changes and malformed/oversized output.
- Extend purge/sweep tests: Trash retains sprites; restore defeats purge; whole-Video purge queues every sprite; cleanup claim defeats late adoption; PUT commits then throws; adoption outcomes adopted/miss/unknown; deletion/requeue failures; Project deletion during generation.
- Extend `embedded-media-orphan-sweep.test.ts`: new prefix recognition, exact retained reference including Trash, stale sibling sprite, listing/adoption race, cursor resume and starvation bounds.
- Extend `video-stream.test.ts`, `guest-surface.test.ts`, `delivery-media.test.ts`, `delivery-public.test.ts`: poster-equivalent admission, locked Premium, revoked/expired/replaced guest sessions, ungrant, stale set handle, Trash/purge and access changes during R2 reads.
- Add backfill tests modelled on `video-reprobe.test.ts`: zero-write dry run across all stores, Admin/Origin checks, cursor boundaries, exact approved candidates, source changes, reruns, send failure recovery and audit attribution.
- Extend `VideoTile.dom.test.tsx`, `VideoCard.tile.dom.test.tsx` and guest/Delivery tile tests: stretched-control events, clamped bins, load/error fallback, late image results, pointer leave/cancel, Version changes, touch, reduced motion, keyboard and menu/drop/select behavior.
- Run targeted suites, web build before app tests, then `npm run verify`. Browser pass through `serve-branch.sh`: desktop/tablet plus real iOS Simulator Safari confirming unchanged touch behavior; save measured screenshots for independent design review.

## 4. Risks and decisions

- **OWNER:** approve option (a)’s coverage gap before implementation; approve migration application and exact backfill list before production writes. Sprite geometry/JPEG/sampling and skipping Trash are the engineering recommendations above.
- Private binding availability, fractional timestamps, 20-overlay composition, H.264 MOV/PCM compatibility and latency require a deployed fixture spike; local mocks cannot establish decoder support.
- Cite lessons **“Image renditions / Cloudflare Images”**, **“Rendition DLQ silent backlog”** and **“HEIC in Embedded media, server half”**: bound extraction concurrency, handle typed DLQ before fallback, release transient leases and recover lost sends.
- Cite **“2026-10-05 — Video in Project discussion”** and **“Embedded media orphan sweep”**: preserve nonce/reference-before-bytes and permanent cleanup claims. Existing documented double-failure/unknown-outcome gaps require observable reconciliation; absolute zero orphan retention cannot be promised.
- Cite **“Adding a key to a strictly parsed public payload breaks every page that is already open across the deploy”**: supplemental metadata avoids that regression.
- Cite **“Escape needs an order, decided before anything runs; per-Version state must not outlive its Version”**, **“A portaled menu’s click bubbles to the card that renders it”**, and **“duration-* without a transition-* property animates every property”**: invalidate stale preview work, exclude portaled controls and never tween sprite positions.
- Preserve ADRs 0020/0021/0022/0023/0025 and guards `video-live.guard.test.ts`, `route-manifest.test.ts`, guest/public boundary guards, `migration-fk-safety.guard.test.ts`, `design-system-guards.test.ts` and `ui-primitive-ratchet.guard.test.ts`.
- Read-only planning only: no implementation or tests run. Luna supplied lifecycle exploration; the required independent Opus planning pass remains unavailable in this session.

## 5. UI reuse and behavior

- ReUI plan: operational existing media grid; Frame-led; existing density; poster → title/menu → footer; retain existing region states; no entrance animation or added controls.
- Start from installed `quincy/VideoTile`, `reui/Frame`/`FramePanel`, `LazyImage`, `Badge`, Quincy open/select/menu/drop controls. Add an aria-hidden, pointer-transparent sprite layer inside the existing poster box.
- Add neutral `lib/video-sprite.ts` transport/loading helpers and a tile-local hook. `VideoCard`, guest `GuestScreens` and Delivery `FilmList` supply `spriteInfoUrl` derived from their existing poster endpoint family; lazy metadata returns URL and geometry.
- Enable only for `(hover:hover) and (pointer:fine)`, mouse pointer events and no reduced-motion preference. Fetch/decode on eligible poster entry; retain poster until ready. Reduced motion and touch perform no preview fetch.
- Listen on the shared tile ancestor because the stretched open control intercepts poster events; calculate against poster bounds, exclude menu/select/footer/drop interactions, update frame position through a ref and coalesced animation frame.
- Restore poster on leave/cancel/drag, media-query change or Version replacement; discard late results. Keyboard keeps the existing focus order and open action; the poster gains no focusability or key handling.
- Map existing tile frames T1–T5 to `VideoTile`/staff/guest adapters and Delivery D30–D37 to `FilmList`/`VideoTile`; preserve their resting layout and compare corresponding screenshot states during both browser-review stages.