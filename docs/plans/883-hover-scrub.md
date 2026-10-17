# #883 — hover-scrub storyboards on Video tiles (plan, ON HOLD)

**Status (2026-10-17): on hold, blocked by #911 (video transcoding), by owner decision.** Planning only.
Nothing is built. Base `origin/main` 4d7a5d2f. Two blind plans fed this synthesis:
[`883-hover-scrub-deep.md`](883-hover-scrub-deep.md) (Opus deep-reasoner) and
[`883-hover-scrub-codex.md`](883-hover-scrub-codex.md) (Codex). Owner decisions already settled on the
issue: a **storyboard sprite** made by a background job on upload, and the scope is **staff, guest and
Delivery tiles, desktop pointer only**.

## The finding that put this on hold

- **No Worker decodes video.** Today's poster is captured in the uploader's browser
  (`apps/web/src/lib/video-poster.ts`) and PUT once (`video-uploads.ts`, the embedded poster protocol).
  ADR 0020 declines server-side FFmpeg and any transcode.
- The only server-side frame extraction available without new infrastructure is **Cloudflare Media
  Transformations** (URL mode or the Worker binding, which is in open beta). It caps **input at 100 MB and
  10 minutes**.
- **Production, read-only query, 2026-10-17:** 42 Versions (32 live). Durations run from 4.5 s to 117 s,
  so none is over 10 minutes. **10 are over 100 MB** (the mean is 119 MB, the largest 713 MB), so a pure
  Media Transformations job leaves about 1 in 4 films with no storyboard:

| assetId | videoId | size | duration | frame | state |
|---|---|---|---|---|---|
| 59637115-6edc-43a8-8a92-fdef14c7580e | 3d02c756-a897-47da-a8c6-0489ebc99ceb | 713 MB | 117.0 s | 3840×2160 | live |
| 948c4279-41bf-4c62-8c71-d71ed0e6cc04 | 3d02c756-a897-47da-a8c6-0489ebc99ceb | 713 MB | 117.0 s | 3840×2160 | live |
| 8134597e-41aa-4129-9162-a0a840697e63 | 7f4dd22e-ea84-48e3-99be-f37af9edf1f2 | 546 MB | 111.7 s | 3840×2160 | live |
| e4ab7c07-2d01-4dd7-8269-f6f1fd02668b | 76c59711-929a-4e40-bbe6-b8e6fa438f1f | 245 MB | 101.5 s | 1080×1920 | live |
| 07ce40b2-298c-49d3-8b65-3a3ceb63d011 | 76c59711-929a-4e40-bbe6-b8e6fa438f1f | 245 MB | 101.5 s | 1080×1920 | live |
| cb3b2d63-61e0-4964-97d2-c9aad5a02ca6 | 49562409-454b-4b25-b119-28985853c065 | 140 MB | 55.8 s | 1080×1920 | live |
| a60b2c96-6c82-4de5-8b7e-a49ee5ca5c4c | 7c2edd88-07e5-4981-a368-453cd6b110b2 | 115 MB | 91.4 s | 1080×1920 | live |
| 0e7cbe8b-6109-49ac-97c7-d5cfc272ab01 | 45a7120c-cf59-47f0-bc3c-73554b936d44 | 104 MB | 86.0 s | 3840×2160 | live |
| 7f74efc0-fb22-4aeb-8ce8-c8369d0a9a0d | 0969a9b6-c812-402d-8c9c-f7a644362203 | 103 MB | 83.4 s | 1080×1920 | trashed |
| 23db37b2-5adc-40e6-ab56-d95cec763661 | d7aac9c2-0311-4a08-a092-ac9e17330045 | 103 MB | 83.4 s | 1080×1920 | live |

Uploads may be up to 2 GB, so this share will not shrink.

## Synthesis: what both plans agree on and what was chosen

Where the plans differ, the choice and its reason are given.

- **Sprite spec v1:** 48 tiles in an 8×6 grid, 256 px on the long edge (a 16:9 film gives a 2048×864
  sheet, a 9:16 film 1152×1536), JPEG q75, about 0.4–0.6 MB.
  - Codex proposed 20 tiles. At 117 s that is one still every 5.9 s, too coarse, so 48 was chosen.
  - Tile times are `(i+0.5)·duration/48`, clamped below the last frame. A film shorter than 48 frames
    repeats tiles, which is harmless.
  - The spec lives in `packages/shared/src/video-storyboard.ts`.
  - The key is `projects/<p>/video/<v>/<asset>/storyboard-<nonce>.jpg`, beside the poster, so the Project
    prefix purge covers it.
- **State:** a new additive table, `0081_video_storyboards`, keyed by `asset_id`, with
  state, reason, spec, key, attempts and claim columns (from deep-reasoner).
  - The alternative was eight new columns on `video_version_meta` (Codex).
  - A table keeps the state machine apart from the probe facts, and its FK cascade is clean.
- **Queue:** its own queue, `quincy-video-storyboards`, with batch 1, concurrency 1, 3 retries and no DLQ.
  - Both plans flagged that the renditions DLQ replays a message as a photo `thumb`+`web`, so the job
    must not ride on `quincy-renditions`.
  - Completion inserts a `pending` row inside the same batch, then sends after commit.
  - A sweep re-sends a stale `pending` row, and an off-switch var stops the job.
- **Write order:** the embedded poster protocol. The fresh-nonce key goes into `embedded_media_cleanup`
  before the PUT. A fenced adoption batch writes the audit row only when the adoption lands. A lost
  adoption is handled with `discardUnreferencedObject`, a throw with `settleThrownAdoption`.
- **Lifecycle:**
  - Trash purge and the embedded-media sweep's live-key check include the storyboard key.
  - Trap: the extra purge statement shifts the positional audit result index. Name it with a constant.
- **Auth:** both plans agree on **one code path per poster family**, so a storyboard is served under
  exactly the poster's admission:
  - staff `/media/video/:assetId/storyboard`
  - guest `/d/api/links/:linkId/versions/:assetId/storyboard` in `guest/index.ts`
  - staff Delivery `items/:handle/storyboard` and `preview-media/:assetId/storyboard`
  - public Delivery: `serveItem`'s `thumb` branch, with a locked item refused as `thumb` is
  - A parity test table, written red first, proves each `/storyboard` answers what its poster answers.
- **No DTO change.** The staff, guest and Delivery schemas are `.strict()` (lesson #858).
  - The tile derives `storyboardUrl` from ids it already holds, only when it has a poster.
  - The fixed grid makes the geometry self-describing.
  - Codex's alternative, a separate `sprite-info` endpoint, was not taken: it doubles the routes.
- **Backfill:** `POST /api/admin/video-versions/storyboards`, built as #900's `reprobe` was:
  `adminBackend`, seed class `withheld`, `dryRun` true by default, a cursor, and a dry run that makes no
  writes, sends and audit rows.
  - The owner approves the dry-run list. Then they take a Time Travel bookmark and do the real run from
    their Admin console.
  - The runbook keeps the **"Only if the run went wrong"** steps in a separate boxed section: a targeted
    undo first, Time Travel restore last.
- **UI:**
  - `VideoTile` gains a `storyboardUrl` prop and a `use-storyboard-scrub` hook.
  - The handlers go on the tile root, because the stretched open control covers the poster. They respond
    to `pointerType === "mouse"` under `(hover:hover) and (pointer:fine)` only.
  - Nothing is fetched before the first hover, and every frame change waits for an animation frame.
  - The overlay is `aria-hidden`. It changes `background-position` with no transition, and leaving the
    tile restores the poster.
  - Nothing happens under `prefers-reduced-motion: reduce`, or with keyboard focus: the open control stays
    the only focus stop.
  - On error the tile keeps the poster and never retries.
- **Cost:**
  - Storage is about 0.5 MB per Version, roughly 21 MB for today's 42.
  - Media Transformations costs about $0.025 per Version with 48 frame calls, or $0.0015 with the
    spritesheet mode, after the beta. It is free during the beta.

## Owner decisions this plan surfaced

1. **What feeds extraction for films over 100 MB.** This is now #911's question.
2. Whether to accept an **open-beta** Media binding in production, if the server path is kept.
3. An ADR, "storyboard stills are not a transcode", if the server path is kept.
4. An optional 2 px progress hairline. The prototype has no frame for hover-scrub.

## Browser-side extraction compared with "transcode first" (#911)

**Browser-side:** while the upload runs, the uploader's browser seeks the local file 48 times
(`<video>` and canvas, as the poster already does) or decodes with WebCodecs, builds the sheet and PUTs it
the way the poster is PUT.

**Transcode first:** #911 produces a derived file server-side. #883 then extracts from that file, or the
transcoder emits the sprite itself.

| | Browser-side sprite | Transcode first (#911) |
|---|---|---|
| ADR 0020 | Kept. Nothing server-side decodes. | Needs an amendment: 0020 declines server-side FFmpeg and any transcode service. |
| New infrastructure | None: no queue, no beta binding, no spike. Adds a client module, one PUT route and the table. | A runtime that can decode, such as a Container with ffmpeg or an external service. Media Transformations cannot help: its video mode has the same 100 MB input cap. |
| Effort for #883 | Medium. The server half is small: the poster PUT copied, the serving parity routes and the lifecycle work. | #883 itself becomes small once a proxy exists, but #911 is the large piece. |
| Coverage | Every new upload of any size, as long as the browser can decode it. All 42 posters were captured this way, so the files decode in the browsers in use. | Every Version, independent of the browser. |
| Safari / Firefox | `<video>` seek is proven by the poster path. Each seek on a 4K long-GOP file decodes from the previous keyframe, so 48 seeks may take about 5–25 s; this must be measured. WebCodecs needs a demuxer: the shared MP4 probe has the sample tables, but that is more code. Firefox decodes H.264 through OS codecs. | Not a factor. |
| Large files | Seeking a local `File` has no network cost, but memory and time grow at 4K. It needs its own timeout, longer than the poster's 8 s. | Not a factor. |
| Tab closed mid-upload | The upload itself already needs the tab open (browser multipart). Building the sprite during the upload hides most of the time. If the tab closes after completion but before the sprite PUT, that Version keeps only its poster until a backfill. | Not a factor: the job is server-side. |
| Server check that the sprite matches its Version | Weak. The server can check that it is a JPEG, its exact grid dimensions, a size cap, uploader-only, once, and that it is bound to the asset id. It **cannot** check that the frames come from that film. This is the same trust the poster already carries, and staff are the only uploaders. | Strong. The server made it from the stored object, pinned to its ETag. |
| Backfill | An Admin browser page streams each Version through the existing staff stream (Range) into a `<video>`, builds the sheet and PUTs it through an Admin-only backfill PUT, with a dry-run list first. It covers all 42, oversize included, but needs the owner's tab open while it runs (#900 was run that way anyway). | The server job runs over the dry-run list from the Admin route. No browser needed. |

**Third option, from deep-reasoner:** a keyframe remux, still unspiked. A Worker copies about 48 IDR
samples, found through the probe's `stss` and sample tables, into a small MP4. Bytes are copied and nothing
is decoded. It then feeds that MP4 to Media Transformations. That keeps ADR 0020 and keeps the work
server-side for oversize files. Its risk is the GOP length of the editors' exports, and the beta binding.

**Bottom line:**

- For #883 alone, **browser-side is the cheapest route that keeps ADR 0020 and covers every size**. Its
  costs are a trust gap, the same one the poster has, and a backfill that runs in the owner's browser.
- **Transcode first is worth it only if #911 is wanted for other reasons.** If it is, #911 should emit the
  storyboard directly, since ffmpeg can build a tiled sheet in one pass, rather than a proxy for #883 to
  re-extract.

## What #911 must produce for #883

Choose one of these.

- **(A) A storyboard directly. Preferred.** One JPEG per Version that matches spec v1: 48 tiles in an 8×6
  grid, 256 px long edge, tile *i* taken at `(i+0.5)·duration/48`, JPEG q75, at most 1 MB.
- **(B) A proxy rendition.** Per Version: an H.264 MP4 of at most 95 MB and at most 10 minutes, with the
  same duration as the original. It can be low resolution (about 640 px long edge, a low bitrate). It must
  be an R2 object Media Transformations can read.

For either output:

- It is stored under `projects/<p>/video/<v>/<asset>/`, so the Project prefix purge covers it, with a
  fresh-nonce key written through the embedded poster protocol.
- It has a D1 record carrying state, spec version and key, so a tile and the Trash purge can find it.
  For (A), that record is `video_storyboards` from this plan.
- It is immutable per Version, made from the stored original pinned to its ETag.
- The Trash purge and the embedded-media sweep's live-key check include it.
- When it finishes it fires a ready signal (a queue message or the row turning `ready`), so #883's job,
  if any, starts after it.
- It covers every existing Version through the same dry-run, approval and bookmark backfill pattern.
