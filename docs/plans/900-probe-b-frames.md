# #900: the probe counts the frames an edit list presents, and stored versions are re-probed

Settled from two blind plans (Opus deep-reasoner and Codex), 2026-10-17, against `main` at 6fd107e6.
Paths are relative to `portal/`.

## Decisions

| # | Question | Settled | Why |
|---|---|---|---|
| D1 | Trimmed edit lists (head `media_time` past the first composition time, or a short `segment_duration`) | **Keep accepting them and count the window correctly**, as `main` does today. | Codex proposed rejecting them; that would refuse uploads that work today. The issue's "keep rejecting genuinely trimmed edits" misreads `main`, which accepts single aligned trims. |
| D2 | `ctts` version 0 offsets | **Signed int32 for both versions.** | What ffmpeg does; QuickTime writes signed values in v0. |
| D3 | `cslg` | **Ignored.** The edit's `media_time` and `DTS + ctts` share one composition timeline. Pinned by a test with a `cslg` box present. | Codex's profile-specific reconstruction adds risk with no file that needs it. |
| D4 | New validation | Reject a `ctts` whose counts do not sum to the `stts` sample count (`box_size_invalid`). | Malformed file; the dry run proves no stored file trips it. |
| D5 | Backfill surface | **Admin-only paged route the owner runs from their signed-in Admin browser.** | Runs inside the Worker (R2 ranged reads pinned to the ETag); needs no production cookie in a script. |
| D6 | Rows whose count does not change | Left at `probe_version` 1, no write, no audit. | Writes only where a value changes. |
| D7 | Range notes ending at the old last frame | Not extended. | They stay valid. |
| D8 | When to apply | During a quiet review window; viewers reload afterwards. | Codex: paste's freshness fence does not cover metadata lengths. |

## 1. Probe (`packages/shared/src/video-mp4-probe.ts`)

- `parseMedia` also reads `ctts` from `stbl`: flattened `[count, offset]` runs, offset signed int32. Absent table = one run of offset 0. Bounded by `checkTable`.
- After the CFR check: `ctts` counts must sum to `totalSamples`, else `box_size_invalid` (`"ctts sample count"`).
- Replace the comment "Ctts (B-frames) is irrelevant" with "Ctts is irrelevant to the rate but not to the edit window."
- No edit list, or zero entries: `frameCount = totalSamples` (unchanged).
- One entry (existing rejections kept: multiple entries, empty edit, rate ≠ 1, `media_time` not frame-aligned):
  - window start `S = media_time`; window end `E = S + segFrames × delta`, `segFrames` = today's rounded conversion of `segment_duration`; `segment_duration` 0 = no end.
  - `frameCount` = number of samples `i` whose composition time `i·delta + off_i` lies in `[S, E)`.
  - Count per run, never per sample (stts counts are unbounded uint32): for a run `[a, a+n)` at offset `off`, `lo = max(a, ceilDiv(S − off, delta))`, `hi = min(a+n, ceilDiv(E − off, delta))`, add `max(0, hi − lo)`. BigInt, with a `ceilDiv` correct for negative numerators.
  - `> MAX_SAFE_INTEGER` → `box_size_invalid`; `≤ 0` → `zero_frames`.
- `durationMs` keeps its formula, on the new `frameCount`.
- `export const MP4_PROBE_VERSION = 2`, re-exported from `packages/shared/src/index.ts`; `workers/app/src/routes/video-uploads.ts` binds it instead of the literal `1`. No migration (`probe_version > 0` holds).
- The browser pre-check (`apps/web/src/lib/video-upload.ts`) calls the same probe; no change.

## 2. Tests (synthesised boxes; no binaries — `packages/shared/src/testing/mp4-builder.ts`)

Builder: `TrackSpec` gains `ctts?: Array<[count, offset]>`, `cttsVersion?: 0 | 1`, `cslg?: boolean`; `trak()` writes `ctts` after `stts` with `u32(off >>> 0)`. Helper `bFrameCtts(n, delta)`: I at 2d, then P 4d / B d / B d groups, closed with 2d, so composition times are a permutation of `2d … (n+1)d`.

`packages/shared/test/video-mp4-probe.test.ts`, describe "probeMp4 edit lists":

| Test | Expected |
|---|---|
| a B-frame file whose edit only absorbs the composition delay presents every frame (cfr-25 shape: ts 12800, delta 512, 500 samples, movie ts 1000, elst {20000, 1024}) | 500 frames, 20000 ms |
| the same with segment_duration 0 | 500 |
| a version 1 ctts with negative offsets, media_time 0 and a cslg box presents every frame | n |
| a version 0 ctts is read as signed | n |
| a file without B-frames (no ctts, no edts) counts every sample | all |
| a B-frame file trimmed at the head (media_time = delay + 10 frames) | n − 10 |
| a B-frame file trimmed at the tail by segment_duration | the window's count, matching durationMs |
| a ctts whose counts do not cover stts is box_size_invalid | rejected |
| a ctts count larger than its payload is box_size_invalid | rejected |
| an edit window holding no composition time is zero_frames | rejected |
| a 4e9-sample stts with one ctts run probes without overflow | probes |

Existing: rename `a B-frame edit (media_time = 2 * delta) is accepted and trims the frame count` to `without ctts, media_time trims leading frames` (still 298). Other edit-list tests keep their values. Add `ctts` to the spec in `truncating a valid moov at every byte offset never throws`.

Also: `apps/web/src/lib/video-upload.test.ts` — `checkVideoFile()` on the cfr-25 shape returns 500 / 20000. `workers/app/test/video-upload.test.ts` — completion stores 500 / 20000 / `MP4_PROBE_VERSION` despite a client claiming 498; the L368 `probe_version: 1` assertion uses the constant.

One-off local cross-check (not committed): ffmpeg `testsrc` 25 fps 20 s with `-bf 2`, `-bf 0`, and `-movflags negative_cts_offsets`, plus a stream-copy `-ss` trim; compare the probe with `ffprobe -count_frames`; delete the files.

## 3. Downstream (no code change; raising a count only loosens upper bounds)

Note writes (`routes/video-notes.ts`, `guest/notes-write.ts`, `lib/video-notes.ts`, `lib/video-notes-sql.ts`) check `start < frame_count`, `end ≤ frame_count`. Paste clamps to the target. Marker export 422s only on a lowered count. `video-frame-clock.ts` `lastFrame()` is also capped by the element's duration. Compare derives per render, nothing stored. Delivery reads `duration_ms` live. Builder adds one clock test: ended on the cfr-25 shape parks on frame 499 of 500.

## 4. Backfill route

`POST /api/admin/video-versions/reprobe` in `workers/app/src/routes/admin.ts`, `adminAllowed`, manifest entry `{ method: "POST", path: "/api/admin/video-versions/reprobe", class: "withheld" }` in `lib/terminal-route.ts`.

- Extract the ETag-pinned R2 `ByteSource` and `ProbeUnavailable` from `video-uploads.ts` into `lib/video-probe-source.ts` (`r2ProbeSource(bucket, key, head)`); upload and backfill share it.
- `lib/video-reprobe.ts`: `reprobePage(env, { cursor, limit, dryRun, actor })` → `{ scanned, items, nextCursor }`.
- Input `{ dryRun?: boolean (default true), cursor?: string, limit?: 1..10 (default 5) }`. Rows: `probe_version < MP4_PROBE_VERSION ORDER BY asset_id`, joined to `assets` for `r2_key`, `bytes`; live and trashed versions.
- Per row, in order; each item `{ assetId, videoId, version, status, old, new? }` (ids only):
  1. HEAD `r2_key`; missing → `missing`.
  2. size ≠ `assets.bytes` or content type differs → `object_changed`; an `object_crc32` row whose ETag differs from the HEAD → `object_changed`.
  3. Probe with every read pinned to the HEAD's ETag (and R2 version where the API gives one); swap or short read → `unavailable`; rejection → `rejected:<reason>`.
  4. Probe facts (fps, media timescale, frame delta, width, height, codec, codec string, start timecode) must equal the row → else `facts_changed`.
  5. new < old → `would_lower`; equal → `unchanged`; greater → `changed`.
- Writes only for `changed`, never on `dryRun`; **a dry run writes nothing, audit included.** One batch per row: a compare-and-swap UPDATE of `frame_count`, `duration_ms`, `probe_version = 2` matching the old values and `probe_version = 1` and `new > frame_count`; then an audit row `video.version.reprobe` with deterministic id `reprobe-v2-<assetId>` (`ON CONFLICT DO NOTHING`), inserted only if the update landed, meta = old, new, projectId, videoId, version. A real call also writes one summary audit `admin.video_probe_backfill`.
- `workers/app/test/video-reprobe.test.ts`: dry run reports and writes nothing; real run raises and audits; second run is a no-op; `would_lower` never written; missing / size mismatch / crc32 ETag mismatch skipped; `facts_changed` skipped; rejected reported not written; ETag swap mid-probe → `unavailable`; CAS loses to a concurrent change; non-admin 403; paging and `nextCursor` null on the last page; `route-manifest.test.ts` green.

## 5. Runbook and docs

New `docs/Guides/Video-Probe-Backfill.md` (linked from `docs/Guides/CI-Deploy.md`), a line in `docs/maps/routes.md`, and a `docs/lessons.md` entry "An edit list's media_time is a composition time, not frames cut".

Production, owner-run, after merge and deploy:
1. Dry run every page; review with the owner. Expected: cfr-25 v2 498 → 500, 19920 → 20000; zero `rejected`, `would_lower`, `facts_changed`, `object_changed`.
2. D1 Time Travel bookmark.
3. Real run, in a quiet review window.
4. Dry run again: everything `unchanged`.
5. `SELECT COUNT(*) FROM video_version_meta WHERE probe_version = 2` equals the changed count.
6. Browser: cfr-25 v2 reaches frame 499 at the end.

## Risks

- D4's new rejection could refuse a file the old probe took; the dry run shows it before any write.
- Negative-offset files can legitimately present fewer frames than the old formula; reported as `would_lower`, never written.
- A head gap (edit start before the first composition time) stays uncaught, as today; separate issue if wanted.
- Worker CPU on a 2M-run `ctts`: use Number arithmetic when every value is below 2^53.
