# Plan (deferred, priority-downgraded): Cloudflare Images hosted-storage pilot for photo renditions

> **Status:** DRAFTED, NOT YET IMPLEMENTED. Awaiting Terry's go/no-go — see "Should this even
> proceed?" below before anything is built. Produced by GPT-5.6-sol (`--sandbox read-only`,
> high effort) reading this repository directly on 2026-07-24, reviewed against a companion
> debate on Dropbox-vs-R2 original storage (see "Related decision" below).

## Should this even proceed? (read this first)

This plan was originally motivated by two things:

1. **An active production incident** (Cloudflare `/cdn-cgi/image/` returning `403 err=9401` on
   every request, zone-wide) — **this has since resolved** (confirmed 2026-07-24 evening: the
   same zero-R2-involvement test that was failing all session now returns `200`,
   `cf-resized: internal=ok`; production D1 shows only 5 of 382 photo assets missing a
   rendition, all very recent uploads still in normal queue processing, not the old stuck
   backlog). See `docs/todo.md` "Live incident ... RESOLVED". **The urgency that originally
   drove this plan is gone.**
2. **A related idea from Terry**: since Cloudflare Images was being evaluated anyway, could
   original photos move to Dropbox-only storage (the studio's existing backup) with Cloudflare
   Images handling delivery, shrinking R2's role? An independent two-reviewer debate (Agy +
   Sol, `docs/Subagent-Orchestration.md` process) on that specific question concluded
   **REJECT** — see "Related decision" below. R2 remains canonical for originals regardless of
   what happens with this plan.

So what's left to decide is narrower than the original framing: **is a renditions-only
Cloudflare Images pilot (originals stay in R2 exactly as today; only the small thumb/web
derivatives would live in Cloudflare Images instead of R2) worth doing on its own merits** —
mainly "does it remove a dependency on `/cdn-cgi/image/` that could break again," not "fix an
active outage." Given the outage has resolved on its own and the cost math below shows this
isn't a savings, **this plan is not recommended to proceed immediately.** It's preserved here,
fully specced, in case Terry wants a resilience hedge against a repeat Cloudflare
Transformations outage, or revisits it later.

## Related decision: Dropbox vs. R2 for original photo storage

A separate proposal (store RAW/original photos in Dropbox only, not R2) was debated
independently by two reviewers (Agy and Sol, each with full repo read access, working in
parallel without seeing each other's response) reading this repository directly. **Verdict:
REJECT** from both, converging on the same conclusion via independent evidence:

- Dropbox sync is already copy-once: everything downstream (renditions, media serving,
  RAW↔Edited compare, AutoHDR) reads exclusively from R2 today; nothing reads Dropbox live.
- Manual (non-Dropbox) uploads have no Dropbox presence at all — moving originals to
  "Dropbox-only" would need a new reverse-sync path and create two asymmetric storage stories
  for the same collection kind.
- Real current R2 cost is **$0–$0.30/month** (401 assets × 20–50MB ≈ 8–20GB, under or barely
  over the 10GB free tier). Even at full projected scale (~60 shoots × 250 frames/month) it's
  roughly $4.50–$11.25/month added per retained cohort, ~$53.85–$134.85/month after a year of
  retention, ~$349–$876 cumulative first-year spend. Real future growth, but not a problem
  solvable by an architecture rewrite today, and not urgent at current scale.
- **Cloudflare Hosted Images' own pricing ($5 per 100,000 stored images/month, plus delivery)
  could itself cost more than the R2 originals it would replace** — this is not obviously a
  cost optimization even setting aside the reliability trade-offs.
- Dropbox temporary links expire in ~4 hours with no custom headers/expiry control, and
  Cloudflare's remote Transformations send no cookies/auth/custom headers — so a private
  Dropbox source would need either a temporary-link hop or a signed intermediary route,
  adding real latency/complexity to every full-res download and every derivative
  (re)generation, not just a one-time migration cost.
- Dropbox is a staff-managed file system (renames/moves/deletes happen for the studio's own
  organizational reasons) — storing the canonical original there would break the durable
  guarantee "asset ID X always resolves to the exact bytes/hash ingested for X, regardless of
  later studio folder operations" that R2's immutable-original architecture provides today
  (`docs/PRD.md` §"data model", `CLAUDE.md`'s "media in R2 is never deleted" agreement). Note:
  D-08 in `Decision-Sheet.md` is specifically a floorplan-versioning decision, not itself the
  universal photo-immutability requirement — the broader guarantee comes from the PRD's R2
  architecture description, which is the more precise citation.
- The manual-Edited-publish workflow already learned this lesson once: R2 is deliberately
  retained as the durable fallback source specifically because Dropbox publication can fail
  (`docs/lessons.md` "Manual edited Dropbox publication"). Removing that safety copy would
  reverse a lesson this exact codebase already paid to learn.
- On-demand derivative regeneration from Dropbox's API (rate-limited, OAuth-gated, ~500–3000ms
  latency per Dropbox's own performance guide) is materially worse than reading a private R2
  object the same Cloudflare account already owns — and generation from Dropbox wouldn't even
  have helped during this session's actual outage, since that was Cloudflare Transformations
  control-plane trouble (reproduced with a totally unrelated static PNG), not an R2/signing
  problem — moving the source to Dropbox would add a new failure boundary, not remove the one
  that broke.

**If storage growth becomes a real concern later** (e.g. multi-TB after a year+), both
reviewers converged on the same alternative lever: an explicit, Terry-decided **post-delivery
retention policy** — e.g. evict unselected/non-source-linked Dropbox-sourced RAW JPEGs from R2
after client-link expiry and a defined retention window, while published edits, selected/
source-linked RAWs, manual uploads, and active client downloads stay R2-canonical. That's a
deliberate product decision (revising today's "retain everything immutably" promise) plus a
much smaller, additive engineering change than any storage-architecture rewrite — and it isn't
yet justified by current or near-term scale.

This conclusion is independent of whether the Cloudflare Images pilot below proceeds — Dropbox
does not become the originals store either way.

---

## The pilot plan (as originally drafted, preserved for future reference)

### Recommendation (if pursued)

Do not replace R2, and do not begin an incident-driven production migration.

The only viable candidate is a staged **renditions-only pilot**:

- Full-resolution photo originals, PDFs, annotation data, zips, and all authoritative versions
  remain private and immutable in R2.
- Cloudflare Images stores at most one private, ≤10 MB **delivery master** per photo asset.
- Two predefined private variants — `thumb` and `web` — are produced from that master at
  delivery time.
- The existing authenticated `/media/asset/:id/:variant` Worker route remains in front and
  proxies the private Images response after running the existing project, role, and
  publication checks.
- R2 rendition rows and objects remain untouched through the pilot and rollback window.

Proceed beyond a smoke-test pilot only if Terry approves a sustainable way to produce the
≤10 MB delivery master independently of remote `/cdn-cgi/image/` Transformations (since that
path is exactly what just had the outage this plan was originally hedging against). The
preferred candidate is a Lightroom-side 3200px derivative export contract, already identified
as a fallback in `docs/Implementation-Plan.md:227`. Without that input contract — or a new
processor/Container — this migration does not remove the dependency it was meant to hedge
against.

### Options evaluated

| Option | Verdict | Reason |
|---|---|---|
| Full R2 replacement | Reject | Hosted Images accepts only 10MB per upload; real originals are 20–50MB. R2 also holds PDFs, JSON, zips, and other non-image objects Images cannot replace. |
| Renditions only | Conditional | One small delivery master can feed both native variants, but a separate process must first create that ≤10MB master. |
| Permanent R2 + Images dual delivery | Reject | Doubles provider state, reconciliation, health checks, and failure modes without solving source resizing. |
| Wait for Transformations, do nothing | **Current best default** | Preserves the already-built, already-working system. The outage that motivated this plan has resolved on its own. |

Cloudflare confirms Hosted Images uploads are limited to 10MB; remote Transformations
separately allow 100MB; the Images binding's transform input is 20MB. These are different
paths/limits. ([Cloudflare Images limits](https://developers.cloudflare.com/images/get-started/limits/))

### What Hosted Images can and cannot do

```text
R2 full-resolution original
        ↓ separate derivative producer (NOT solved by this plan alone)
≤10 MB / ≤3200px delivery master
        ↓ one Hosted Images upload
private named variant: quincy-thumb-v1
private named variant: quincy-web-v1
```

- Variants resize at delivery time; they do not make a 20–50MB original eligible for upload.
- **Flexible variants cannot be used with signed/private delivery** — only predefined named
  variants work for private images
  ([docs](https://developers.cloudflare.com/images/optimization/hosted-images/enable-flexible-variants/)).
  So the resize step still has to happen before upload, at delivery time.
- Predefined variants don't expose the same per-variant quality contract currently defined in
  `portal/packages/shared/src/media.ts:28-32` — visual QA on a 4K display would be required.
- Use Cloudflare-generated image IDs (Direct Creator Upload custom IDs can't be private under
  signed-URL delivery).
- Prefer the `env.IMAGES.hosted.upload()` binding over a separate API token for trusted
  background uploads (Cloudflare added hosted-image management to the binding June 2026).

### Does it route around a future `/cdn-cgi/image/` outage?

Probably for **delivery** of already-uploaded derivatives, yes — Hosted delivery uses
`imagedelivery.net`, a different code path from `/cdn-cgi/image/` Transformations, so it
wouldn't have been affected by the specific outage this session diagnosed. It does **not**
help with **producing** a new derivative in the first place if Transformations are down again,
unless a non-Transformations derivative producer exists (see the Lightroom-export note above).
It's also the same vendor/wider Images platform, so it's not resilience against a broad
Cloudflare-account-level incident.

### Access control design

Never expose Images URLs directly to the browser. Recommended flow:

1. Browser requests the existing `/media/asset/:id/thumb|web`.
2. App Worker runs the current session, project, role, and publication checks (unchanged).
3. Selects the current verified Hosted Images delivery row.
4. Constructs and signs a short-lived private named-variant URL server-side.
5. Fetches that URL inside the Worker and streams the result to the browser.
6. Browser receives `private, no-store`, `nosniff`, and no Images image ID or bearer URL.

Cloudflare private-image cache lifetime can be as short as one hour rather than immediate
session-revocation semantics — the server-side proxy (not a redirect) is what preserves
per-request authorization.

### Schema plan (if pursued)

Do not overload `asset_renditions` — it represents two physical R2 objects and is unique on
`(asset_id, variant)`. A Hosted Images base is one physical stored image with two logical
delivery variants. Add two new tables in the next available migration:

**`asset_delivery_images`**: `id`, `asset_id` (FK, `ON DELETE RESTRICT`), `provider`
(`cloudflare_images`), `cloudflare_image_id` (nullable while pending, unique once known),
`spec_version`, `source_digest` (SHA-256), `source_bytes/content_type/width/height`,
`require_signed_urls` (must be true), `status` (`pending|uploaded|verified|failed`),
`supersedes_delivery_image_id`, `failure_code`, timestamps. Unique on
`(asset_id, spec_version, source_digest)` for idempotency.

**`asset_delivery_variant_checks`**: `delivery_image_id`, `variant` (`thumb|web`),
`content_type/width/height`, `verified_at`. Unique `(delivery_image_id, variant)`. A delivery
image becomes `verified` only after both signed variants return valid image responses within
expected dimensions — `review.ts` should report `ready` only when both checks pass, preserving
the current two-variant readiness rule.

Leave `asset_renditions` and its R2 keys completely unchanged throughout.

### Rollout (if pursued) — 5 phases

1. **Phase 0 — pilot smoke test.** Enable Hosted Images on a non-production account/env,
   create versioned predefined variants (`quincy-thumb-v1` 640×640, `quincy-web-v1` 3200×3200,
   both `scale-down`, metadata stripped, never bypassing signed-URL requirements), upload one
   existing R2 web rendition, verify unsigned access fails / signed access works / no `9401` /
   dimensions and visual quality match. **A failed smoke test ends the proposal here — no
   schema or production changes.**
2. **Phase 1 — additive schema, provider-aware reads**, gated behind
   `RENDITION_DELIVERY_PROVIDER=r2|images|images_with_r2_fallback` defaulting to `r2`.
3. **Phase 2 — backfill existing assets** with valid R2 renditions (HEAD+validate, upload as
   the hosted master, verify both variants, leave R2 objects untouched). Note: current
   generator permits renditions up to 16MB (`renditions.ts:15`) which exceeds Hosted Images'
   10MB ceiling — enforce the limit before upload even though typical outputs are small.
4. **Phase 3 — transitional dual-write + canary**, one internal project first, then a small
   percentage, hold at least one operating week, monitor delivery success/latency/auth
   failures/fallback rate.
5. **Phase 4 — cutover or stop.** Cut over only when every intended asset has a verified
   hosted master, a sustainable derivative producer exists for all ingest paths (manual,
   Dropbox, AutoHDR-return), multi-PoP checks pass, and Terry accepts the cost and weaker
   rollback posture (see below).

### Immutability, rollback, and cost (if pursued)

- Never delete R2 originals or existing R2 renditions during/after the pilot — their storage
  cost is negligible (~29MB total across all 401 current assets' renditions).
- Hosted Images has no documented object-versioning recovery model equivalent to R2's —
  meet immutability at the application level instead: always-new image IDs, never replace,
  `supersedes_delivery_image_id` linkage, no delete endpoint ever called.
- Rollback before any R2 cleanup is immediate (flip the provider flag back to `r2`, redeploy).
  After new assets become Images-only, rollback gets slower (hosted masters would need
  reconstruction from R2) — don't stop R2 dual-write until Terry explicitly accepts that.
- Cost: not a current savings. ~$5/month minimum (100k-image billing block) plus delivery,
  versus R2's current ~$0.06–$7.73/month depending on scale. This is a resilience/architecture
  trade, not a cost optimization.

### Required verification (if pursued)

Hosted-limit rejection at >10MB; generated private ID with unsigned access denied; both signed
variants valid at 2+ PoPs; exact dimensions/no upscaling/4K visual QA; anonymous request → 401;
unassigned user → 403; photographer RAW-only enforcement; revoked session loses access
immediately; signed Images URL never reaches the browser; both variant checks required for
`ready`; upload/D1-failure reconciliation without duplicate stored images; backfill dry-run
matches production counts exactly; full rollback drill; grid/lightbox/filmstrip/RAW↔Edited
compare verified via HTTP status/headers (not screenshots); full repository typecheck, tests,
and web build per `CLAUDE.md`.

## Orchestration note

If/when Terry approves proceeding: this plan should go through the same review loop as other
plans in this repo (`docs/Subagent-Orchestration.md`) — a fresh Sol review of this exact
document before build, Terra or Sol builds Phase 0 only first (cheap, reversible), independent
verification of the smoke test before any schema work begins.
