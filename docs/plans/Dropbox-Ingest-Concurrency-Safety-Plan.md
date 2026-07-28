# Dropbox Ingest Concurrency Safety — Plan

**Priority: LOW. Not scheduled — do not implement without a fresh trigger check (see below).**
Deferred out of [Dropbox-RAW-Fetch-Speedup-Plan.md](implemented/Dropbox-RAW-Fetch-Speedup-Plan.md) after two
rounds of Terra review rejected raising `quincy-ingest`'s `max_concurrency` without this work
landing first. This document exists so the reasoning and the review history aren't lost between
now and whenever it's picked up — not to schedule it.

Read alongside [Dropbox-RAW-Fetch-Performance-Analysis.md](implemented/Dropbox-RAW-Fetch-Performance-Analysis.md)
(the original measurement) and the "Revision history" in
[Dropbox-RAW-Fetch-Speedup-Plan.md](implemented/Dropbox-RAW-Fetch-Speedup-Plan.md) (both rejections, in full).

## What this is, in one paragraph

`quincy-ingest`'s queue consumer is configured `max_concurrency: 1` — every `dropbox_sync`,
`autohdr_scaffold`, etc. message for the *entire account* is processed one at a time, not just
one at a time per project. When two projects need RAW ingestion at once (measured as routine,
not rare, in the performance analysis — two real projects lost ~23 minutes each of idle time on
2026-07-27, though that idle time was a mix of old 40-file-continuation-cap overhead, confirmed
for one project, and cross-project contention, attributed but not fully isolated for the other —
see the analysis doc), they queue behind each other instead of running in parallel. Raising
`max_concurrency` to let independent projects overlap is the obvious fix, but it exposes a real
data-loss race: a `dropbox_sync` message for a project already mid-sync currently gets acked and
dropped instead of retried (the collision path in `sync.ts` returns `claimed: false`, but
`index.ts`'s consumer acks unconditionally regardless — see requirement 2 below). A dead-letter
queue alone would **not** catch this today, since the message is never retried in the first
place; a DLQ only becomes a meaningful safety net once that ack behavior is fixed to retry
instead. Closing this properly — the ack fix *and* a safety net for when retries are exhausted —
is a small concurrency-safety project in its own right, not a one-line config change.

## When to pick this up

**Don't implement this speculatively.** The cost of the current behavior is wasted wall-clock
time on RAW ingestion, not a correctness problem or a user-facing failure — it's worth fixing
once it's actually costing meaningful time on a regular basis, not before.

**Primary trigger — measure it directly, don't guess:** re-run the same kind of query used in
the performance analysis, periodically (e.g., monthly), against production D1:

```sql
-- Count days where 2+ *different* projects each had a dropbox_sync job created within
-- 60 seconds of another project's job — i.e., days with measurable cross-project contention.
WITH pairs AS (
  SELECT a.created_at AS t, a.project_id AS p1, b.project_id AS p2
  FROM jobs a JOIN jobs b
    ON a.kind = 'dropbox_sync' AND b.kind = 'dropbox_sync'
    AND a.project_id != b.project_id
    AND b.created_at BETWEEN a.created_at AND a.created_at + 60000
)
SELECT date(t / 1000, 'unixepoch') AS day,
  COUNT(DISTINCT CASE WHEN p1 < p2 THEN p1 || '|' || p2 ELSE p2 || '|' || p1 END) AS contending_pairs
FROM pairs GROUP BY day ORDER BY day DESC;
```

(The pair must be canonicalized — `CASE WHEN p1 < p2 ...` — before deduping. Without it, two
projects whose jobs happen to interleave in both orders across the same day produce both
`p1||p2` and `p2||p1`, over-counting the same pair as two.)

Pick this up once contending pairs show up on **most business days**, not just occasionally —
that's the point at which the ~20-25 min/project cost (measured, not assumed — re-check it's
still in that range) starts compounding into a real daily drag on RAW-to-editing turnaround.

**Rough volume proxy, if you'd rather reason from shoot count than run the query:** somewhere
around **5-8+ shoots landing in Dropbox per day** across the team is a reasonable point to
expect same-day overlap to become the norm rather than a coincidence — but this is a heuristic,
not a measurement, and a weak one: overlap actually depends on how tightly shoots' Dropbox
uploads cluster in time and how long each sync run takes, not on the raw daily count. A studio
doing 8 shoots/day with staggered uploads across the day may see less contention than one doing
4/day that all land within the same hour. Prefer the query above when you actually want to
decide; use this number only as a rough gut-check between measurements.

**Secondary trigger:** if RAW-to-editing SLA ever tightens enough that a 20-25 minute ingestion
delay on an overlapping day becomes visibly painful (e.g., same-day turnaround commitments),
that changes the cost side of the equation independent of volume — worth revisiting then too,
even at lower project counts.

## Design requirements when this is picked up

Carried over from the two rejected review rounds — start here, don't re-derive from scratch.

### 1. A decision on the safety-net question (make this deliberately, not by default)

`quincy-ingest` has `max_retries: 3` and no dead-letter queue, so a message that can't acquire
its project's claim within 3 retries is silently, permanently dropped by Cloudflare. Terra's
round-2 review flagged this as the actual blocker, not the ack logic itself. Two directions,
pick one on purpose:

- **Add a DLQ to `quincy-ingest`**, alerting/replay tooling, so a dropped trigger is at minimum
  operator-visible and re-drivable. This cannot simply copy `quincy-renditions-dlq`'s pattern
  verbatim: the existing `renditionDlqEvents` table and its consumer are rendition-specific
  (keyed on `assetId`), but `quincy-ingest` carries multiple message *types* — `dropbox_sync` and
  `autohdr_scaffold` at minimum (`messages.ts`). A `quincy-ingest` DLQ needs a generic,
  append-only event shape: the original message body, project/job identity, error/attempt
  metadata, a status field, and a defined replay operation — not an asset-shaped table reused for
  a different domain.
- **Or build real per-project coalescing/outbox semantics** — e.g., a durable "this project needs
  a re-sync" flag that a completing run checks before releasing its claim, rather than relying on
  queue messages as the only signal that more work is needed. More invasive, potentially more
  robust; needs its own design discussion before committing to it over the DLQ option.

### 2. The ack/claim-contention fix (mechanically correct in the reviewed design, needs polish)

Revision 2's approach — when `syncProjectRawFolder` returns `claimed: false` because another
invocation holds the project's RAW reconciliation claim, `message.retry({ delaySeconds })`
instead of `message.ack()` — was confirmed correct in principle by Terra's round-2 review. Two
concrete bugs in that specific implementation still need fixing:

- The delay formula `min(900, max(30, ceil((leaseExpiresAt - now)/1000) + 15))` silently loses
  its 15-second safety margin whenever the remaining lease exceeds 885 seconds — confirmed
  against `RAW_CLAIM_LEASE_MS = 15 * 60_000` (900,000ms) in `sync.ts`: `remaining + 15` exceeds
  the 900-second cap whenever `remaining` alone exceeds 885 seconds, and the `min(900, …)` clips
  it right there, silently. Fix so the margin is preserved regardless of remaining lease length
  (e.g., don't cap the computed delay at all, or cap it well above the lease ceiling), and add
  jitter so multiple contending retries don't all land on the same instant. Cloudflare Queues'
  own `delaySeconds` bound (0-86400s) is not the binding constraint here — the lease length is —
  so whatever cap is chosen needs to be justified against the lease, not against the platform.
- The owner keeps renewing its own lease while it runs (`assertLease()` calls throughout
  `sync.ts`), so a retry delay computed from one snapshot of `leaseExpiresAt` can still fire too
  early if the owner extends its lease afterward. Test the "owner completes between the
  collision check and the retry firing" case specifically, and the "owner is still running and
  has since renewed" case.

### 3. A wall-clock-based continuation cutoff, not just a download count

`MAX_DOWNLOADS_PER_RUN` (now 120, see `Dropbox-RAW-Fetch-Speedup-Plan.md`) is a count-based
proxy for staying under Cloudflare's 15-minute Queue-consumer wall-clock limit. It can't account
for projects with large numbers of *already-ingested* files that still cost a D1 round-trip on
every scan even though they don't count toward the cap (`sync.ts`'s reconciliation-only path).
A genuine wall-clock deadline check inside the download loop — bail out and enqueue a
continuation once N minutes have elapsed, regardless of download count — would remove this
dependency on assumptions about reconciliation-scan volume per project. Worth doing alongside
the concurrency work since both touch the same loop.

### 4. Regression coverage for the actual failure pattern, not just the simple case

Revision 2's planned test only covered one continuation racing one claim. Terra's round-2 review
specifically flagged that `do/dropbox-sync.ts` creates a fresh job/message *per delta page* with
no in-flight check — meaning the real failure pattern is **multiple** independent triggers for
the same project landing close together, not just a self-continuation racing itself. Test that
shape directly: seed a running claim, then deliver two or three separate `dropbox_sync` messages
for the same project in quick succession, and assert none of them silently drops without either
succeeding or being retried in a way that's provably bounded (not just "eventually consistent in
this test run").

### 5. Re-verify, don't re-litigate

Both confirmed sound in round 2 and shouldn't need re-arguing from scratch, just a quick recheck
that the surrounding code hasn't changed by the time this is picked up:

- Dropbox OAuth token refresh already handles concurrent refreshes correctly
  (`dropbox/client.ts`, optimistic conditional update + reread-on-loss).
- `autohdr_scaffold`'s claim table (`autohdr_scaffold_claims`) already guards against concurrent
  duplicate scaffolding.

## Suggested `max_concurrency` value when this ships

Still **2, not higher**, per both earlier reviews — the account has already tripped a Dropbox
429 ban once from a download burst (`docs/lessons.md`, 2026-07-25). Validate with live data
before considering 3+, same reasoning as before, unaffected by anything above.
