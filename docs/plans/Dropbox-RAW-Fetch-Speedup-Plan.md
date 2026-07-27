# Dropbox RAW Fetch Speedup — Plan (revision 3, narrowed scope)

**Status: Change 1 only, in this change.** Drafted by Sonnet 5 (this session) directly — no
subprocess. Revisions 1 and 2 (below) proposed also raising `quincy-ingest`'s `max_concurrency`
and were both **REJECTED** by Terra, each review surfacing more scope than the last. Per user
decision, that concurrency work is **deferred to its own, separately-planned future change** —
not abandoned, just no longer part of what ships now. This revision's scope is exactly one
constant.

Motivated by, and should be read alongside,
[Dropbox-RAW-Fetch-Performance-Analysis.md](Dropbox-RAW-Fetch-Performance-Analysis.md).

## This change (in scope)

### Raise `MAX_DOWNLOADS_PER_RUN`: 40 → 120

File: [`portal/workers/background/src/dropbox/sync.ts:19`](../../portal/workers/background/src/dropbox/sync.ts)

```diff
- const MAX_DOWNLOADS_PER_RUN = 40;
+ const MAX_DOWNLOADS_PER_RUN = 120;
```

**Why 120, not 150 or 200:** across both review rounds, Terra's consistent concern was margin
against Cloudflare's documented **15-minute wall-clock limit for Queue consumer invocations**
(confirmed directly against Cloudflare's docs, not just Terra's claim). At the measured
~4.1-4.2s/file, 120 downloads is ~8-8.5 minutes of active time — leaving real margin (not just
"probably fine") for the parts of an invocation that don't scale with the download count: the
initial `allFolderFiles()` full-folder listing, and the D1 round-trip every *reconciliation-only*
file incurs even though it doesn't count toward the cap (`sync.ts:193-239`). Round 2 specifically
flagged that 150 didn't leave enough headroom for that unquantified overhead; 120 is inside the
100-120 range Terra suggested there. At ~9-10 subrequests/file, 120 downloads ≈ 1,080-1,200
subrequests, comfortably under the 10,000/invocation Workers Paid default — no `wrangler.jsonc`
`limits` block needed.

**Effect, per the performance analysis:** both measured projects (192 and 130 files) drop from
4-5 continuation runs to 2 runs each. This does **not** fix the cross-project queue contention
identified as the larger driver of idle time in the analysis — that requires the deferred
concurrency change below. It does remove the clean 40-file-boundary stalls (confirmed against
Chicago Avenue's data: exactly 3 stalls at the old 40/80/120 boundaries), on any project synced
without a concurrent collision from another project.

**Why this is safe on its own, with no concurrency-related risk:** `max_concurrency` on
`quincy-ingest` stays at 1. This constant only changes how many *new* files one invocation may
download before enqueueing a continuation for the same project — it doesn't touch how many
invocations can run at once, so none of the claim-contention findings from revisions 1-2 apply
here. It's a pure count change to an existing, already-idempotent continuation loop.

### Comment updates alongside the diff

- `sync.ts:14-18` (the comment above the constant): update the subrequest math (~400 → ~1,080-1,200)
  and add the wall-clock-limit rationale, not just the subrequest one — the sizing basis has
  shifted from "stay under the old Free-tier subrequest ceiling" to "stay under the 15-minute
  Queue consumer wall-clock limit with margin for unquantified per-run overhead."
- `wrangler.jsonc:10-16` (the comment explaining why `limits` is omitted): update the referenced
  subrequest figure to match.

## Verification (this session, §5 gate)

1. `npm run typecheck` (from `portal/`, covers all six workspaces).
2. `npm run build -w @quincy/web`.
3. `npx vitest run --config packages/shared/vitest.config.ts` (per `CLAUDE.md`).
4. `npm test -w @quincy/background` (or the workspace's own `vitest run`) — no existing test
   should reference the literal value `40`; if one does, it needs updating alongside this change,
   not treated as an unrelated failure.
5. This session reads the actual diff directly before considering it done, per the §5 gate —
   this is small enough that a Terra diff review (fresh context, read-only) is a fast
   confirmation, not a blocking multi-round cycle like the concurrency change was.

## Rollout

- Single worker affected: **background only.** `cd portal/workers/background && npx wrangler deploy`.
- **Rollback:** revert the one-line constant change and redeploy. No data migration involved
  either direction.
- Nothing to monitor beyond normal operation — this doesn't change failure modes, only how many
  files one invocation processes before its existing, already-tested continuation logic fires.

---

## Deferred work (not in this change)

The `quincy-ingest` `max_concurrency` change and everything it depends on (claim-contention fix,
DLQ-or-outbox decision, wall-clock cutoff, multi-page regression coverage) has moved to its own
document: [Dropbox-Ingest-Concurrency-Safety-Plan.md](Dropbox-Ingest-Concurrency-Safety-Plan.md)
— marked **low priority, not scheduled**, with a suggested trigger for when to revisit it. The
revision history below is kept here since it's specifically about *this* plan's review rounds;
the design requirements for the deferred work itself now live in that other document instead of
being duplicated here.

### Revision history

**Revision 1** proposed two pure config/constant changes (`MAX_DOWNLOADS_PER_RUN` 40→200,
`quincy-ingest` `max_concurrency` 1→2) with no logic changes. Terra rejected it and found a real
bug, which this session verified directly against the code:

1. **Data-loss race, confirmed.** `dropbox/sync.ts:286` enqueues a continuation queue message
   *before* the RAW reconciliation claim is released at `dropbox/sync.ts:319-322`.
   `index.ts:594-601` acks the `dropbox_sync` message unconditionally — it never inspects the
   `claimed` field `syncProjectRawFolder` returns. If a second concurrent consumer picks up a
   message for the *same* project while the first is still mid-run, it hits the unique-claim
   collision path (`sync.ts:142-160`), returns `claimed: false`, and is acked anyway — silently
   dropping whatever that trigger was meant to fetch. `do/dropbox-sync.ts:157-183` shows this
   isn't only a self-continuation risk: a genuinely new Dropbox delta for a project already
   mid-sync creates its own fresh job/message with no in-flight check, so two independent
   triggers for the same project landing seconds apart (which the performance analysis shows is
   close to normal here, not an edge case) hit the same bug. **At `max_concurrency: 1` this is
   structurally impossible** — raising concurrency is what opens the window.
2. **200 was too close to the 15-minute Queue-consumer wall-clock limit** (confirmed against
   Cloudflare's docs). At ~4.1-4.2s/file, 200 downloads alone is ~14 minutes.

**Revision 2** added a fix for (1) — retry with a lease-derived delay instead of acking on
`claimed: false` — and lowered the download cap to 150. Terra reviewed again (fresh context) and
**rejected again**:

3. **The ack fix is mechanically correct but the safety net behind it is missing.** `quincy-ingest`
   has `max_retries: 3` and **no dead-letter queue** — Cloudflare permanently deletes a message
   once retries are exhausted. Terra's point: this isn't a rare "unusually slow claim" case, it's
   an ordinary consequence of `do/dropbox-sync.ts` creating a fresh job/message per delta page
   with no in-flight check, which the performance analysis already showed happening routinely
   (both example projects had 2-3 near-simultaneous same-project triggers). Needed before
   `max_concurrency: 2` is safe: a DLQ with alerting/replay on `quincy-ingest`, or real
   per-project coalescing/outbox semantics.
4. **The retry-delay formula had a bug:** `min(900, remaining + 15)` silently drops the 15s
   safety margin whenever the remaining lease exceeds 885s, and since the owner keeps renewing
   its own lease while running, a delay computed from a stale snapshot can fire too early.
5. **The download-cap concern recurred one level deeper:** a *count*-based cap can't account for
   unquantified per-run overhead (folder listing, reconciliation-only scans) against a
   *time*-based platform limit. Terra's suggestion: either a lower count (100-120, adopted above
   for this change) or a genuine wall-clock cutoff inside the loop as a more robust long-term fix.

The full set of design requirements for picking this back up — DLQ-vs-outbox decision, the
ack/claim fix with its jitter/margin bug fixed, the wall-clock-cutoff idea, and the multi-page
regression coverage Terra's round 2 called for — now lives in
[Dropbox-Ingest-Concurrency-Safety-Plan.md](Dropbox-Ingest-Concurrency-Safety-Plan.md), along
with a suggested trigger for when it's worth scheduling. Not duplicated here.
