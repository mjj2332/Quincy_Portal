# #883 plan — deep-reasoner (Opus, blind), base 4d7a5d2f

Raw planner output, kept for the record; the settled synthesis is `docs/plans/883-hover-scrub.md`.

Two corrections to the brief: the guest Version poster route is `guest/index.ts` (not `guest/media.ts`
`servePoster`, which serves comment-embedded videos); the public Delivery page serves posters from
`delivery/index.ts` `serveItem`.

## 1. Files and modules

- **Extraction:** the Media Transformations **Worker binding**, not URL mode. It takes an R2 `object.body`
  stream (`.input(stream).transform({width,height,fit}).output({mode:"frame"|"spritesheet", time, duration, imageCount})`),
  so no source URL: `__transform-source` keeps refusing video keys (`VIDEO_KEY_PATTERN`, #741). Bind as
  `"media": {"binding": "VIDEO_FRAMES"}` (`MEDIA` is the R2 binding). Open beta, not billed, no local
  simulation. Spritesheet `duration` ≤ 60 s, grid layout undocumented. Assume the 100 MB / 10 min input limit
  applies to the binding too.
- **Spike S0 before the build** (scratch Worker, `remote: true`): 95 MB accepted / 105 MB refused and which
  `MediaError.code`; fractional `time` (`"2.35s"`); wall time on 100 MB / 117 s for 48 `frame` calls vs 2
  `spritesheet` calls (`imageCount` 24, layout measured); `IMAGES` taking 48 `.draw(…,{top,left})` over a
  bundled black base; non-fast-start and H.264 `.mov` decode. Spritesheet only if its grid is deterministic,
  else 48 `frame` calls if under 5 min.
- **Format** (`VIDEO_STORYBOARD_SPEC`, `packages/shared/src/video-storyboard.ts`): v1 = 48 tiles, 8×6,
  256 px long edge (16:9 → 256×144 tiles, 2048×864 sheet; 9:16 → 1152×1536), JPEG q75, ~0.4–0.6 MB.
  Times `(i+0.5)·durationMs/48`, clamped below `durationMs − 1 frame`. 4.5 s → a tile every 94 ms (repeats
  under 48 frames are harmless); 117 s → every 2.4 s; 10 min → 12.5 s. `storyboardEligibility(bytes,
  durationMs)`: >100 MB `too_large`, >600 s `too_long`. Key `videoStoryboardKey(projectId, videoId, assetId,
  nonce)` → `projects/…/video/…/<asset>/storyboard-<nonce>.jpg`, beside `videoPosterKey`.
- **Pipeline:** completion batch in `video-uploads.ts` inserts `video_storyboards (asset_id, state='pending')`
  after the `video_version_meta` INSERT; after commit `waitUntil(VIDEO_STORYBOARD_QUEUE.send(...))`, never
  throws. New queue `quincy-video-storyboards` (batch 1, concurrency 1, retries 3, no DLQ — the renditions DLQ
  replays as photo `thumb`+`web`). Consumer `workers/background/src/video-storyboard.ts`
  `processVideoStoryboard`: live check → eligibility (`skipped`+reason) → claim (`attempts+1`,
  `claimed_until=now+20min`) → HEAD (`failed:object_changed`) → extract + compose, validate with
  `isJpeg`/`jpegDimensions` → embedded poster protocol (fresh-nonce key in `embedded_media_cleanup`, PUT, one
  batch: `state='ready'` fenced on attempts/liveness/unclaimed entry, audit `video.storyboard.set` NULL actor
  `WHERE changes()>0`, delete entry) → `discardUnreferencedObject` on lost adoption, `settleThrownAdoption` on
  throw. Last attempt → `failed:transform_failed`. Var `VIDEO_STORYBOARDS` off-switch. Hourly
  `sweepVideoStoryboards` re-sends stale pending rows (≤50), exhausts to `failed`.
- **Serving (one path per family, same authorization as the poster):** staff `media.ts`
  `readableVideoVersion` + `GET /media/video/:assetId/storyboard`, `serveVideoPoster` → `serveVideoStill`;
  guest `guest/index.ts` `resolveGrantedVersion` + `GET /d/api/links/:linkId/versions/:assetId/storyboard`
  (re-resolve after R2 get, `POSTER_HEADERS`); staff Delivery `delivery-media.ts` `serveAsset("storyboard")`
  for `items/:handle` and `preview-media/:assetId` (locked → 404); public Delivery `delivery/index.ts`
  `serveItem` takes the video `thumb` branch (locked → 403, `authorize` re-admission and `beforeServe` apply).
- **Lifecycle:** `video-trash-purge.ts` `notLiveKey` and each batch enqueue the storyboard key — **trap:** the
  extra statement shifts the positional audit result index (`results[3:4]` → `[4:5]`); name it with a
  constant. `embedded-media-sweep.ts` `holdsLiveVideoKey` widened the same way. Project delete covered by the
  prefix purge + FK cascade. The orphan sweep doesn't list video keys: same accepted gap as posters.
- **Backfill:** `POST /api/admin/video-versions/storyboards` (`adminBackend`, `withheld`, no MCP),
  `lib/video-storyboard-backfill.ts` copying `video-reprobe.ts`. `{dryRun=true, cursor?, limit 1..25=10}`;
  pages live Versions with no row; `missing` / `would_queue` / `would_skip:<reason>`. Real call per row: INSERT
  `ON CONFLICT DO NOTHING` + audit `video.storyboard.backfill` (`storyboard-backfill-<assetId>`), then
  `sendBatch`; one `admin.video_storyboard_backfill` summary. Dry run writes and sends nothing.

## 2. Schema and API

- `0081_video_storyboards.sql`, additive: `asset_id TEXT PK REFERENCES assets(id) ON DELETE CASCADE`,
  `state IN ('pending','ready','skipped','failed')`, `reason IN ('too_large','too_long','not_decodable',
  'transform_failed','object_changed')` nullable, `spec_version INTEGER NOT NULL`, `storyboard_key TEXT UNIQUE`,
  `bytes`, `attempts DEFAULT 0`, `claimed_until`, `created_at`/`updated_at` ms with `typeof` checks,
  `CHECK ((state='ready') = (storyboard_key IS NOT NULL))`, index `(state, updated_at)`. Journal,
  `migration-0081.test.ts`, `schema.ts`, QA seed and audit registers.
- **No DTO field:** the staff, guest and Delivery schemas are `.strict()` (lesson "Adding a key to a strictly
  parsed public payload breaks every page that is already open across the deploy (#858)"). The tile derives
  `storyboardUrl` from ids it holds, only with a poster; the fixed 8×6 grid makes geometry self-describing
  (`naturalWidth/8 : naturalHeight/6`). A too-large film costs one 404 on first hover, then the scrub is off
  for that mount.
- Cost: ~0.5 MB R2 per Version (42 ≈ 21 MB). 48 frame ops + 1 Images op ≈ $0.025 after beta; spritesheet
  ≈ $0.0015. Free during beta.

## 3. Tests (red first)

Parity table `workers/app/test/video-storyboard-routes.test.ts` (every family's `/storyboard` answers what its
`/poster`/`thumb` answers: no row, pending, ready, Version/Video in Trash, gate closed, no `viewVideo`, outsider
vs unassigned staff, grant revoked, member removed, locked Premium, item not in the latest set, R2 gone, live
check failing after the R2 get). Route manifest + `delivery-public-boundary.guard.test.ts`. Shared unit tests
(times, eligibility at 100 MB / 600 s, tile index edges, key shape). Consumer tests with injected fakes
(happy path, `too_large` never calls the binding, not live, duplicate during claim, lost adoption, PUT throws,
last attempt, var off). Sweep tests (prior art `object-crc-sweep.test.ts`). Purge/drain tests (key queued,
`purged` count after the index shift, restore wins, live key never queued). Completion test (pending row in the
batch, failed send still 201). Backfill test copying `video-reprobe.test.ts`. `VideoTile.dom.test.tsx`
(mouse → right `background-position`; touch/pen nothing; reduced motion nothing; no request before first hover;
error keeps poster, no retry; leave restores; none on locked/posterless; open control the only focus stop;
overlay `aria-hidden`).

## 4. Risks and decisions

- Traps: the purge batch's positional audit read; strict DTOs; embedded poster write order (lesson
  "2026-10-05 — Video in Project discussion (#494)"); "Embedded media orphan sweep (#549)"; arrow-wrapped
  bindings (illegal invocation); D1 UNIQUE errors in `error.cause`; "Image renditions / Cloudflare Images"
  (never N concurrent transforms of large sources).
- Rollout: `wrangler queues create quincy-video-storyboards`, bookmark, apply 0081 per CI-Deploy; confirm
  wrangler ^4.112 / workers-types accept the `media` binding.
- Runbook `docs/Guides/Video-Storyboard-Backfill.md` in the #900 layout; a separate boxed "Only if the run
  went wrong" section: targeted undo first (enqueue every `storyboard_key` for cleanup, delete the rows), Time
  Travel restore only as a last resort.
- **Owner:** O1 files over 100 MB — recommend (a) poster fallback + `skipped:too_large` now; later (e) a
  keyframe remux (build a small MP4 of ~48 IDR samples from the probe's sample tables — copied bytes, no
  decode — and feed it to the same binding: background, no transcode, within ADR 0020). Not (b) browser-built
  (replaces the background-job decision; backfill needs a browser), not (c) Container ffmpeg (contradicts ADR
  0020). O2 accept an open-beta binding in production. O3 ADR 0026 "Storyboard stills come from Media
  Transformations". O4 optional 2 px progress hairline.
- Session default: no scrub under `prefers-reduced-motion: reduce`.

## 5. UI

Extend `components/quincy/VideoTile.tsx` + new `components/quincy/use-storyboard-scrub.ts`; no ReUI item fits
(confirm with `mcp__ReUI__search` and note it in the PR). Handlers on the `Frame` root (the stretched open
control's `::after` covers the poster), `pointerType==="mouse"` only, inside the poster rect, rAF-throttled.
Prop `storyboardUrl?: string | null`. Preload once on first qualifying move with a detached `new Image()`.
`aria-hidden` overlay above `LazyImage`, below the chips, letterboxed like `object-contain`;
`background-size: 800% 600%`, position `col/7·100% row/5·100%`; no transition; leave restores the poster.
No keyboard scrub; the poster stays unfocusable. Browser pass: desktop and tablet in the built-in browser,
phone rows in iOS Simulator Safari showing touch unchanged, then design-reviewer against the rest of the Portal.
Docs: `docs/maps/queues.md`, `routes.md`, CI-Deploy entry, "Storyboard" in `packages/shared/GLOSSARY.md`, a
lessons section once shipped.
