# #802 — native ZIP writer: settled plan

Synthesised 2026-10-11 from two blind plans (Opus deep-reasoner and Codex/Sol) over the WIP on
`fix/802-native-zip`. Shared foundation for #787 slice 7: keep `ZipObjectEntry`, `authorize` and
`nativeZipResponse` stable across both PRs.

## Why

R2 bodies arrive in ~4 KB chunks, and per-chunk JS in `createZipStream` costs ~37–52 ms of CPU per MB,
so any archive above ~600 MB is cut off at `cpu_ms` 30000. Native `pipeTo` into a `FixedLengthStream`
with CRC and size known up front costs 0.05–0.07 ms/MB (probe on #787).

## Two PRs

### PR A — CRC foundation (no download behaviour changes)

Fresh branch from `origin/main`. Lift the A-side files out of the WIP commit; don't rebase the mixed commit.

1. **Migration 0072** (still unapplied, so it can grow):
   - `object_crc32` as in the WIP.
   - New `object_crc32_work(r2_key PK, etag, bytes, offset, crc_partial, state CHECK IN ('queued','running','failed'), attempts, requested_at, updated_at, last_error)`.
   - The work table does three things:
     - **Dedupe:** the gate re-enqueues only when there is no work row, or the row is older than 10 minutes.
     - **Durable failure:** `attempts >= 3` sets state `failed`, and a download then answers 502 `download_unavailable`, not an endless "preparing".
     - **Resumable range reads:** see item 3.
   - Schema, journal, migration test and fixture accounting are updated.
2. **Dedicated queue** `quincy-object-crcs`:
   - Settings: batch 1, `max_concurrency` 4, `max_retries` 3, no DLQ queue. A failure is recorded in the work row before the last retry is acked.
   - Producer binding `OBJECT_CRC_QUEUE` in both the app and background `wrangler.jsonc`; the consumer runs in the background Worker.
   - Message types move to `packages/shared/src/object-crc.ts`, out of `RenditionMessage`.
   - Sends use `sendBatch` (≤100).
3. **CRC job, resumable.** Each message handles one range of ≤512 MiB, read with R2 `range` plus `onlyIf: { etagMatches }`.
   - Within a range, use the 1 MiB BYOB `readAtLeast` with a default-reader fallback. Carry the running `crc32(chunk, prev)` and the offset in the work row.
   - Self-re-enqueue until `offset == size`, then upsert `object_crc32` and delete the work row in one batch, **only if** the etag still matches.
   - An etag change midway restarts at offset 0 with the new etag.
   - Worst case at the probe's 11 ms/MB is ~6 s of CPU per message, so background `limits` stay unchanged.
   - A stale delivery (etag or offset mismatch with the row) is acked with no write.
4. **`node:zlib` shim** for the background Worker (`src/node-zlib.d.ts`, the same narrow `crc32` declaration as the app). Also declare `readAtLeast` if workers-types lacks it. Lesson: "`node:zlib` is runtime-only in the app Worker".
5. **Producers:**
   - **Intent hooks:**
     - The RAW "select for editing" write enqueues the selected keys.
     - A video version release (`lib/video-approval.ts`) enqueues its original.
   - **Hourly sweep** on the existing `0 * * * *` cron: zip-eligible originals (photo RAW and edited originals, released video versions) with no `object_crc32` row and no live work row, newest first, at most 500 per run.
     - This is the backfill and the repair path for lost sends.
     - It skips `failed` rows.
   - A failed enqueue never undoes the write that caused it.
6. **Tests, red first:**
   - CRC with known vector, empty and ragged bodies.
   - `readAtLeast` actually called, plus the fallback.
   - Short/long reads, multi-range resume, etag change midway, stale delivery.
   - Dedupe, failure recorded at the 3rd attempt.
   - Sweep: picks only missing keys, respects the cap, skips failed rows.
   - Intent hooks enqueue the committed key.
7. **Owner step before merge:**
   - `npx wrangler queues create quincy-object-crcs`.
   - A Time Travel bookmark.
   - `npx wrangler d1 migrations apply DB --remote`, from `portal/workers/app`.

   A missing queue fails the deploy, and the migration guard blocks it.

### PR B — routes, preparation UI, flag (rebased onto A after A merges)

1. **Writer fixes (`zip-native.ts`):**
   - ZIP64 at `>=` the sentinels (`0xFFFFFFFF` size/offset/central size, `0xFFFF` entry count).
   - Assert the total length is a safe integer.
   - Correct the `waitUntil` comment: a connected stream keeps the request alive, and `waitUntil` doesn't extend it after a disconnect.
2. **Gate (`object-crc.ts`):**
   - Every route HEADs every object.
   - A missing object, or a HEAD size ≠ D1 size, answers 502 `download_unavailable`.
   - Pending means no row, or the row's etag ≠ the HEAD etag. Drop the D1-bytes-vs-row comparison.
   - A `failed` work row answers 502.
   - Plan the archive (`createNativeZip` planning) **before** the audit row, so a planning error leaves no audit.
3. **Hybrid, behind a D1 flag `native_zip`** (missing = off, per "ship dark behind flags"):
   - **Flag off:**
     - ≤ 256 MiB: today's `createZipStream`, unchanged.
     - > 256 MiB: 413 `download_too_large` with a clear message. That replaces today's silently truncated file, and 256 MiB is ~0.5 × 30000 ms ÷ 52 ms/MB.
   - **Flag on:**
     - Every CRC ready: native writer.
     - Not ready and ≤ 256 MiB: legacy writer.
     - Otherwise: 409 `download_preparing` with the pending count and `retryAfterSeconds`.
4. **Preparation endpoints (POST, so no GET side effects):**
   - **Staff selected RAW:** `POST /api/projects/:id/selected-raw/prepare` reads the server's selected set and answers `ready` / `preparing` / `unavailable` / `too_large`.
     - The web button calls it first and clicks the download anchor only on `ready`.
   - **Staff download-selection:** the existing POST handles 409 `download_preparing` and keeps the ids for retry.
   - **Guest:**
     - The manifest GET stays read-only and gains `archive: { state, pending }`.
     - `POST …/downloads/prepare` (guest fence + origin checks, its own rate limit) enqueues the missing objects.
     - **Quota:** `reserveAttempts` moves to just before the audit insert, so preparing never spends ZIP-start quota.
5. **UI:**
   - Copy: "Preparing this download. This may take a few minutes." / "Couldn't prepare this zip. Try again or download the files one at a time."
   - Poll every 30 s for up to 5 minutes while the surface is open and visible; cancel on close or unmount; then offer **Check again**.
   - Becoming ready never auto-downloads.
   - Reuse: `reui/button`, `reui/dialog`, `reui/spinner`, `quincy/Notice`, the existing toast. Ledger line per element.
6. **Deferred to #787 slice 7, stated in the PR:** staff mid-stream `authorize` (the old code never had it; the etag-conditional GET bounds the damage).
7. **Tests:**
   - Writer at ZIP64 boundaries, abort and cancel, and no reads after a failure.
   - An independent `unzip -t` / `python3 -m zipfile -t` on ZIP32 and ZIP64 archives.
   - Routes: all hybrid branches, no audit while preparing, guest quota untouched by prepare, a stale etag marks the object pending.
   - Web: the preparing → ready flow, polling cleanup.
   - Two-stage browser pass (Agy → design-reviewer) on both surfaces.

## Rollout

1. Owner creates the queue, takes the bookmark and applies 0072; then PR A merges and the deploy succeeds.
2. The sweep backfills hourly. Watch the CRC work rows, failures and rendition latency.
3. PR B merges with `native_zip` off, which caps legacy zips at 256 MiB; large downloads that were silently broken now answer with a clear 413.
4. Turn `native_zip` on and check a 1.23 GB archive, a 300-entry archive, a ZIP64 archive over 4 GiB, and revocation mid-stream.

**Rollback:** turn the flag off. The tables and queue are additive and safe to leave in place.
