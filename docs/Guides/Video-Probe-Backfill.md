# Video probe backfill (#900)

The MP4 probe used to count `stts` samples minus `media_time / frame delta`. An edit list's `media_time` is a composition time, so on a B-frame file whose edit only absorbs the `ctts` delay it undercounted: the cfr-25 Version 2 stored 498 frames and 19920 ms for a film of 500 frames and 20000 ms, and review could not reach the last two frames. The probe now counts the samples whose `DTS + ctts` falls in the edit window and stamps `MP4_PROBE_VERSION = 2` (`packages/shared/src/video-mp4-probe.ts`). New uploads are right from the deploy. Versions stored before it keep `probe_version = 1` until this backfill re-probes them from R2.

This is an operator-run backfill, **not a D1 migration**. It writes production rows: **get the owner's explicit approval before the real run.** The owner runs it from their signed-in Admin browser (`docs/agents/production-data.md`); no session cookie goes into a script.

## The route

`POST /api/admin/video-versions/reprobe` (Admin, `adminBackend`, seed class `withheld`, no MCP tool). Body `{ dryRun?: boolean (default true), cursor?: string, limit?: 1..10 (default 5) }`. Answer `{ dryRun, scanned, items, nextCursor }`; each item is `{ assetId, videoId, version, status, old, new? }` (ids only, no keys or addresses).

It pages the Versions with `probe_version < 2` by `asset_id`, live and trashed. Per row, in order:

1. HEAD the object: gone is `missing`.
2. Size or content type differs from the row, or an `object_crc32` row holds another ETag: `object_changed`.
3. Probe with every read pinned to the HEAD's ETag: a swap or short read is `unavailable`; a probe rejection is `rejected:<reason>`.
4. fps, media timescale, frame delta, size, codec, codec string or start timecode differs from the row: `facts_changed`.
5. New count lower: `would_lower`. Equal: `unchanged`. Higher: `changed`.

Only `changed` is written, and never on a dry run (a dry run writes nothing, audit included). The write is one batch: a compare-and-swap UPDATE of `frame_count`, `duration_ms` and `probe_version = 2` on the values just read, then the audit row `video.version.reprobe` (id `reprobe-v2-<assetId>`, meta `projectId, videoId, version, old, new`) only if the swap landed. A swap that loses to a concurrent change reports `conflict` and writes nothing. A real call also writes one `admin.video_probe_backfill` summary row. `unchanged` and `would_lower` rows stay at `probe_version = 1`, so every real run lists them again; that is expected.

## Order (after merge and deploy)

1. Dry run every page: `{ "dryRun": true }`, then `{ "cursor": "<nextCursor>" }` with `dryRun` still true, until `nextCursor` is null. Review with the owner. Expected: cfr-25 v2 498 to 500 and 19920 to 20000; zero `rejected`, `would_lower`, `facts_changed`, `object_changed`, `missing`, `unavailable`. Anything else is explained before a write.
2. Take a D1 Time Travel bookmark.
3. Real run in a quiet review window (metadata lengths are not covered by paste's freshness fence, so viewers reload afterwards): the same pages with `{ "dryRun": false }`.
4. Dry run again: every item is `unchanged`.
5. The backfill's own audit rows match the `changed` items, one per asset: `SELECT target_id FROM audit_log WHERE action = 'video.version.reprobe'` lists exactly the changed asset ids. (Not a count of `probe_version = 2`: every upload since the deploy stores 2 as well.)
6. In the browser, cfr-25 v2 reaches frame 499 at the end.

## Rollback

Time Travel to the bookmark undoes the writes, along with every write since. Note ranges that ended on the old last frame stay valid and are not extended.
