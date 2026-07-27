# Dropbox RAW Fetch — Performance Analysis (2026-07-27)

**Read-only investigation.** No code or config changed. Basis for the follow-up plan that
raises `MAX_DOWNLOADS_PER_RUN` and the `quincy-ingest` queue's `max_concurrency`.

Source: production D1 (`quincy-portal`, `1d36b42e-f1e6-4659-8c9e-70afe822b6fa`), queried
directly via `mcp__cloudflare-bindings__d1_database_query` on 2026-07-27.

## Method

"Fully fetched" = span between the first and last `assets` row created for a project's RAW
collection (`kind = 'raw'`, `source = 'dropbox'`). Per-file gaps were computed with a SQL
`LAG()` window over `created_at`, split into:

- **Active** — gap ≤ 10s: the pipeline was working (download + R2 put + D1 write for one file).
- **Idle/stalled** — gap > 10s: nothing landed; the pipeline was waiting for something.

Cross-checked against the `jobs` table (`kind = 'dropbox_sync'`), which records per-invocation
`created_at`/`updated_at` and a `"partial sync — 40 downloaded, continuation enqueued"` note
whenever a run hits the `MAX_DOWNLOADS_PER_RUN` cap.

## Projects examined

| Project | Project ID | Raw collection ID | Files received |
|---|---|---|---|
| 28/40 Victoria Street | `3192629f-6116-4f07-b8ac-7b8d7c7d48a8` | `cadf48d6-f260-459b-90bd-decca5142f80` | 192 |
| 3/9 Chicago Avenue | `c5dd3ed8-1195-4a4d-b333-50dca22ea80d` | `774c3f6d-601e-4e0d-9fb1-32cabcf1f047` | 130 |

Both share Dropbox connection `ea29a4dd-f6e8-4c7a-a804-2a3f4b31ef39`. Both synced today
(2026-07-27), in an overlapping window.

## Headline numbers

| Project | First asset | Last asset | **Total wall time** | Active time | Idle time |
|---|---|---|---|---|---|
| Victoria | 09:13:27 UTC | 09:49:07 UTC | **35m 39s** | 12m 31s (183 files, ~4.13s/file avg) | **23m 8s** (9 stalls) |
| Chicago | 09:19:18 UTC | 09:51:09 UTC | **31m 51s** | 8m 54s (129 files, ~4.24s/file avg) | **22m 57s** (3 stalls) |

**~65% of wall-clock time on both projects was idle, not downloading.**

## Root cause

The `jobs` table shows 6 `dropbox_sync` jobs (3 per project) all *created* within a 12-second
window (09:13:20–09:13:32) — both projects picked up new Dropbox content at essentially the
same moment. `quincy-ingest` is configured `max_concurrency: 1` **account-wide** (not
per-project), so only one of those six jobs could execute at a time; the rest queued behind it.

- **Chicago's 3 stalls line up exactly** with `MAX_DOWNLOADS_PER_RUN = 40` boundaries — gaps
  land right after asset #41, #81, and #121 (i.e., immediately after each 40-file batch). This
  is the clean, expected continuation-cap signature.
- **Victoria's 9 stalls don't align to 40-multiples** (gaps at asset #12, 33, 73, 113, 128, 137,
  143, 183, 186) and Victoria also has one `status: failed` job that needed a retry. This is
  consistent with Victoria's batches being interleaved with Chicago's for the single ingest
  queue slot, not explained by the download cap alone.
- Checked `dropbox_monitor_health` for the shared connection: `last_error` is null and
  `reset_count` is 0 for the `raw` scope — no recorded Dropbox-side rate-limit event or cursor
  reset during this window. The stalling is self-inflicted queue serialization, not Dropbox
  throttling.

### Stall detail

**Chicago Avenue** (clean 40-cap pattern):

| After asset # | Stall |
|---|---|
| 41 | 4m 19s |
| 81 | 1m 06s |
| 121 | 17m 33s |

**Victoria Street** (irregular — cross-project contention + one failed/retried job):

| After asset # | Stall |
|---|---|
| 12 | 33s |
| 33 | 30s |
| 73 | 3m 55s |
| 113 | 8m 38s |
| 128 | 1m 35s |
| 137 | 1m 42s |
| 143 | 1m 47s |
| 183 | 2m 11s |
| 186 | 2m 18s |

## What would and wouldn't help

| Change | Affects RAW fetch time? |
|---|---|
| Raise `MAX_DOWNLOADS_PER_RUN` (40 → higher) | Partially — removes clean continuation-cap stalls (~5-6 min on a Chicago-sized run); doesn't fix cross-project contention |
| Raise `quincy-ingest` `max_concurrency` (1 → 2+) | **Yes, the dominant fix** — lets independent projects' syncs run side by side instead of blocking each other |
| Parallelize thumb/web rendition fetch | No — that's the downstream Images-transform stage, not the Dropbox download |
| Raise `quincy-renditions` queue concurrency | No — same, affects rendition generation only |

## Projected impact (both RAW-relevant changes applied)

Each project running close to its own active-time floor instead of waiting on the other:

- Victoria: ~35m 39s → **~12-13 min** (≈2.8x faster, ~23 min saved)
- Chicago: ~31m 51s → **~9 min** (≈3.5x faster, ~23 min saved)

**Caveats:**

1. The ~4.1-4.2s/file floor itself doesn't move — that's real Dropbox round-trip time for two
   content calls per file plus the deliberate 150ms×2 anti-rate-limit pacing, which stays as-is.
2. This assumes Dropbox doesn't start throttling once two projects hit it concurrently instead
   of one at a time. The account has already tripped a 429 ban once from a download burst (see
   `docs/lessons.md`, "Dropbox 429 burst amplification", 2026-07-25) — this is a real risk, not
   hypothetical, hence a conservative concurrency bump (2-3, not unbounded) with monitoring.
3. Single two-project sample. A busier day with 3+ simultaneous projects would see
   proportionally more benefit from the concurrency fix.
