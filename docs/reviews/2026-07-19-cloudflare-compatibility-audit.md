# Quincy Portal — Cloudflare Platform Compatibility Audit
### Pre-implementation audit — as of 2026-07-19

Audit of the approved June 2026 implementation proposal against current Cloudflare platform reality (docs, pricing, GA status), incorporating **decision D-14** (2026-07-19): staff auth is no longer Cloudflare Access — the app now owns Google OAuth, magic-link email issuance, session management, and transactional email sending from a Worker. Figures below are retrieval-based; source URLs are cited inline. Where a current number could not be confirmed, that is stated explicitly rather than guessed.

---

## Compatibility Matrix

| # | Item | Verdict | One-line note |
|---|------|---------|----------------|
| 1 | Auth: Google OAuth + magic link | ⚠️ Compatible with caveats | better-auth (v1.5, stable, native D1) is the right primary choice; session storage and CSRF/state-param handling need explicit design |
| 2 | Magic-link email sending | ⚠️ Compatible with caveats | Cloudflare Email Sending is still in **public beta** (not GA) as of July 2026 — viable but carries beta risk for a transactional auth-critical path; Resend/Postmark are safer GA fallbacks |
| 3 | Ingest-time image processing (20-50MB JPEGs) | ❌ Problem (as originally scoped) | Cloudflare Images binding caps input at 20MB (below your range); Workers 128MB memory is tight for full-res decode/resize; Cloudflare Containers (GA April 2026) is the correct venue |
| 4 | R2 presigned multipart uploads | ✅ Compatible | S3-compatible multipart API supports browser-direct presigned part uploads; standard CORS config required |
| 5 | D1 limits ("metadata only") | ✅ Compatible | Current limits comfortably fit a metadata-only design; Sessions API (read replicas) is still public beta, not GA |
| 6 | Queues + Workflows | ✅ Compatible with caveats | Queues is production-grade; Workflows GA status unclear from docs but functionally solid — sleeps support the hours-long autoHDR wait cheaply; a Workflows pricing change lands Aug 10, 2026 |
| 7 | Static assets + SPA serving | ⚠️ Compatible with caveats | Workers Static Assets is the current path (not Pages); SPA fallback via `not_found_handling` + `run_worker_first`; Pages' long-term status is murky in official docs |
| 8 | Service bindings (4 Workers) | ⚠️ Compatible with caveats | 32-invocation call-depth cap is a non-issue at this scale; deploy-order dependency (bound Worker must exist first) needs CI/CD sequencing |
| 9 | Dropbox from Workers | ⚠️ Compatible with caveats | No native long-poll support — use Durable Object alarm or Cron+Queue for cursor sync; Secrets Store is read-only from Workers, wrong place for a rotating refresh token |
| 10 | Zip streaming | ⚠️ Compatible with caveats | Streaming/passthrough is cheap (CPU excludes I/O wait); live zip *compression* of multi-GB payloads risks the CPU cap — pre-built-in-R2 is the safer default |
| 11 | Cloudflare Stream (later) | ✅ Compatible | ~$3-5/month at small-studio scale — trivial |
| 12 | Overall cost picture | ✅ Compatible | Roughly $15-40/month on Workers Paid, growing mainly with R2 storage retention over time |

---

## 1. Auth: Google OAuth + Magic Link on Workers/Hono (highest priority)

**Verdict: ⚠️ Compatible with caveats.**

### Library landscape (current, 2026-07-19)

- **Lucia** is dead as a library. The maintainer deprecated it in 2025 ("not working" as a library model) and it is now positioned purely as a *learning resource* for hand-rolled auth; database adapters were deprecated by end of 2024. **Do not adopt Lucia for new work.** (github.com/lucia-auth/lucia/discussions/1707, /1714)
- **better-auth** is the strongest fit. As of the **1.5 release (Feb 28, 2026)** it is explicitly out of beta and "production-ready," with **native Cloudflare D1 support** ("pass your D1 binding directly — no custom adapter setup required," using D1's `batch()` API for atomicity since D1 lacks interactive transactions). It ships first-class `magic-link` and Google OAuth (social provider) plugins, a documented Hono integration (hono.dev/examples/better-auth-on-cloudflare), and an official `better-auth-cloudflare` community package wiring D1 + KV + R2 + Hyperdrive together. 2026 patch releases have specifically hardened the magic-link flow (fixed a race condition where two concurrent verify requests could mint two sessions from one single-use token; fixed hangs on connection-limited serverless DB adapters). (better-auth.com/blog/1-5, github.com/better-auth/better-auth, github.com/zpg6/better-auth-cloudflare, hono.dev/examples/better-auth-on-cloudflare)
- **openauth (SST)** is a credible alternative but is still explicitly labeled **"beta"** on its own docs site, recommends **KV** for its storage adapter on Workers, and its magic-link/email-code flow requires you to implement the actual email-sending callback yourself (no batteries-included transactional email). Feature-complete and Workers/Hono-native, but the beta label is a real consideration for a production auth path. (openauth.js.org/docs/, sst.dev/blog/openauth-beta/)
- **Hand-rolled with arctic + oslo primitives**: `arctic` (OAuth 2.0 client library, runs on Workers/Node/Bun/Deno, has a documented Google provider) remains a viable low-level building block, but oslo itself has had maintenance churn (same author as Lucia) — treat as a toolkit, not a framework, and expect to write session/CSRF/state handling yourself. Reasonable only if the team wants minimal dependencies and has bandwidth to own the security-critical code.
- **Clerk**: `@clerk/backend` is explicitly built for V8-isolate runtimes including Cloudflare Workers, with networkless JWT verification (~1.8ms) via `CLERK_JWT_KEY`, and Google OAuth + magic-link-style passwordless flows out of the box. Fully managed (hosted UI/session infra), which conflicts somewhat with "the app now owns OAuth flow, session management, magic-link issuance" — Clerk would mean the app *delegates* rather than *owns* these. Pricing is usage/MAU-based.
- **WorkOS**: also workable from Workers (AuthKit supports Google OAuth + Magic Auth), free for the first 1M MAUs, then $2,500/mo per additional 1M MAU. Enterprise-leaning (SSO/Directory Sync features you don't need); at studio scale this is free but is another hosted dependency and, like Clerk, means the app doesn't "own" the flow the way D-14 specifies.

### Recommendation

**Primary: better-auth on D1**, using its native D1 adapter (already in your stack), the `magic-link` plugin, and the Google social-provider plugin. Rationale: it is the only option that is (a) stable/GA, (b) Workers/Hono-native with a documented integration path, (c) uses your existing D1 binding rather than adding a new managed dependency, and (d) genuinely satisfies D-14's intent that the app owns the auth flow rather than delegating to Clerk/WorkOS. Treat Clerk/WorkOS as the fallback if the team decides mid-build that owning session/CSRF logic is too much risk for the timeline — both are legitimate, Workers-compatible managed alternatives, WorkOS notably free at this scale.

### Session storage

Cloudflare's own storage guidance and community benchmarks both point to **Workers KV** as the default for session lookups: hot-key reads land in the 500µs-10ms range, versus D1's single-write-primary model where writes from many regions queue at the primary. The tradeoff to design around explicitly: **KV is eventually consistent (~propagation up to ~60s globally)**, so a "logout everywhere" or session-revocation action will not be instantaneous at the edge. Given this is a small internal staff app (not high-QPS, not globally distributed users), this is a manageable caveat, not a blocker — but do not assume KV writes are instantly visible on the next request from a different colo. better-auth 1.5 explicitly supports a secondary-storage pattern (documented against Redis; KV is the Workers-native equivalent) plus `deferSessionRefresh`/`setShouldSkipSessionRefresh` options aimed at exactly this kind of read-replica/edge-consistency tradeoff. D1 remains the source of truth for user/account records; KV holds the hot session token → session mapping. Signed, `httpOnly`, short-TTL cookies (JWT or opaque token) as the transport layer either way.

### CSRF

Hono ships a built-in `csrf()` middleware that validates `Origin`/`Sec-Fetch-Site` headers — use it for all state-changing routes. Session cookies should use `sameSite: 'Lax'`, `httpOnly: true`, `secure: true`. Separately from cookie-CSRF, the **OAuth `state` parameter** and magic-link tokens must be single-use, time-boxed, and validated server-side (better-auth 1.5 already fixed a magic-link double-consumption race condition — confirms this is a real class of bug to test for, not just theoretical). Never put encryption/session keys in `wrangler.toml`/`wrangler.jsonc` (committed to git) — use `wrangler secret put` / dashboard secrets, `.dev.vars` locally.

---

## 2. Magic-link email sending

**Verdict: ⚠️ Compatible with caveats.**

- **Cloudflare Email Service (Email Sending)** entered **public beta on 2026-04-16** and, as of this audit (2026-07-19), is **not GA**. It is only ~3 months into public beta. (developers.cloudflare.com/email-service/, blog.cloudflare.com/email-service/)
- **Pricing**: first 3,000 emails/month included free per account; metered overage reported at roughly **$0.09–$0.35 per 1,000 emails** depending on source (figures diverge between the pricing page and third-party trackers — confirm the exact current rate at developers.cloudflare.com/email-service/platform/pricing/ before committing budget). Sends to *verified* destination addresses are free and don't count against the quota; sending to arbitrary recipients requires Workers Paid.
- **Setup**: domain onboarded via Dashboard (Compute → Email Service → Email Sending → Onboard Domain) or `wrangler email sending enable yourdomain.com`; Cloudflare auto-provisions SPF and DKIM (`cf-bounce._domainkey`) TXT records (5-15 min typical propagation, up to 24h worst case). **Important gotcha**: Email Sending and Email Routing use *separate* DKIM selectors — don't cross-reference them.
- **Workers usage**: binding-based (`send_email: [{ name: "EMAIL" }]` in wrangler config, `env.EMAIL.send({...})`), no API keys needed in-Worker; add `remote: true` to exercise the real API during local `wrangler dev`. A REST API and SMTP option also exist for out-of-Worker use.
- **Comparison — Resend**: free tier 3,000 emails/mo (100/day cap), Pro $20-35/mo, Scale $90 (100k) up to $1,150 (2.5M)/mo, now with pay-as-you-go overage billing. Mature, GA, widely used from Workers via plain `fetch()` to their REST API.
- **Comparison — Postmark**: Free dev tier 100 emails/mo (non-expiring); paid plans start ~$15-18/mo for 10,000 emails with per-1,000 overage ($1.20-1.80). Strong deliverability reputation, GA, mature webhooks/bounce handling — historically the gold standard for transactional-only (non-marketing) email, which matches this use case (magic links, notifications) well.

**Recommendation**: Given magic-link email is on the **critical path for staff login** (if the email doesn't deliver, staff can't get in), don't make it the flagship spike for an unproven beta service. Two reasonable options: (a) ship on Cloudflare Email Sending now given the low volume (a handful of staff, low email count — comfortably inside the free 3,000/mo tier) and accept public-beta risk with a documented fallback plan, or (b) use **Resend** or **Postmark** (both GA, both trivially callable from a Worker via `fetch()`, both cheap at staff-only volume — likely free-tier or low tens of dollars/month) for the auth-critical magic-link + notification path, and revisit Cloudflare Email Sending once it reaches GA. At this studio's tiny staff headcount, cost is a non-factor either way — GA maturity should drive the decision for the auth-critical path. This is a low-cost, low-effort decision to defer to implementation time rather than lock in now.

---

## 3. Ingest-time image processing (Phase-0 spike)

**Verdict: ❌ Problem as originally scoped — Workers alone / Images-binding-only is not the right primary venue; Cloudflare Containers is.**

- **Workers CPU time**: default 30 seconds (Paid plan); max configurable via `limits.cpu_ms` in wrangler config is **300,000 ms (5 minutes)**, opt-in (raised from a 30s hard cap as of 2025-03-26). This is CPU time, not wall-clock — HTTP requests have no separate wall-clock cap while the client stays connected. (developers.cloudflare.com/workers/platform/limits/, /changelog/post/2025-03-25-higher-cpu-limits/)
- **Memory**: confirmed still **128 MB per isolate** (JS heap + all WASM linear memory combined), unchanged.
- **WASM codec options**: **jSquash** (MozJPEG-based, Workers-safe) and **@cf-wasm/photon** (photon-rs wrapper) both exist and are usable in Workers, but neither has a published, vendor-verified benchmark for 20-50MB source JPEGs. A back-of-envelope estimate: a 4000×3000 JPEG decodes to ~48MB of raw RGBA8, and resize scratch buffers roughly double that transiently — leaving little headroom under the 128MB ceiling, with **no margin for concurrent requests sharing an isolate** and no vendor confirmation this is safe at your upper size bound (50MB source). WASM bundle-size ceilings (10MB gzipped / 64MB uncompressed on Paid) and the 400ms startup-CPU budget for module init are additional friction for bundling a full codec.
- **Cloudflare Images "transform via binding" (`env.IMAGES`)**: hard-capped at **20MB source input** — this is *below* your stated 20-50MB range, meaning a meaningful fraction of full-resolution Lightroom exports would be rejected outright by the binding. No documented direct R2-object-in path either (fetch-then-pipe only). Pricing is per-transformation ($0.50/1,000 beyond 5,000 free/month) when the source isn't stored in Cloudflare Images (which fits your R2-primary design) — cheap, but moot given the size ceiling.
- **Cloudflare Containers reached GA on 2026-04-13** (about 3 months old as of this audit) — integrates with Workers via a Durable Objects binding (`getContainer()`), supports full CPU cores and memory/disk well beyond isolate limits, and is purpose-built for exactly this class of heavier, non-isolate-bounded compute. Pricing: ~$0.0000025/GiB-second memory (25 GiB-hours free/mo), ~$0.000020/vCPU-second (375 vCPU-min free/mo), ~$0.00000007/GB-second disk (200 GB-hours free/mo), billed per 10ms active — cheap at 30-60 shoots/month.

**Recommendation**: Re-scope the Phase-0 spike. Don't attempt full-resolution decode+resize+re-encode of 20-50MB JPEGs inside a Worker isolate or via the Images binding — the 20MB Images-binding cap and the 128MB Worker memory ceiling are both real, not theoretical, constraints against your stated source-file range. Move ingest-time rendition generation to a **Cloudflare Container** invoked from the background Worker (Queue consumer triggers a container run, e.g. using `sharp`/`libvips` or ImageMagick, writes renditions to R2). Reserve Workers/Images-binding for lightweight, already-under-20MB on-the-fly transforms (e.g., re-deriving a smaller crop from an already-generated web rendition, or watermarked preview generation from a rendition that's already in range) — which is what the proposal called "optimization," and that framing is still valid. This changes Phase-0 from "can Workers do this" (no, not reliably) to "stand up a Container-based image pipeline" — a bigger but well-supported lift now that Containers is GA.

---

## 4. R2 presigned multipart uploads from browser

**Verdict: ✅ Compatible.**

- R2's S3-compatible API fully implements `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`, `AbortMultipartUpload`, `ListParts` (developers.cloudflare.com/r2/api/s3/api/). Standard SigV4 presigning applies uniformly to any S3 operation, so presigning individual `UploadPart` calls for direct browser upload is the same mechanism as presigning a `PUT` — this is a widely-used community pattern (AWS SDK `UploadPartCommand` + `getSignedUrl`). **Caveat**: Cloudflare's own presigned-URL doc only shows canned single-op GET/HEAD/PUT/DELETE examples and explicitly states POST-policy form uploads are unsupported — it does **not** publish a first-class "presigned multipart" recipe. Treat this as "works via standard S3 semantics" rather than an officially documented recipe, and validate it in a small spike before relying on it.
- Part size: minimum **5 MiB** (except the final part), maximum **5 GiB** per part; maximum **10,000 parts**; maximum object size **~5 TiB**. (developers.cloudflare.com/r2/objects/multipart-objects/, /r2/platform/limits/)
- CORS: must configure exact-match `AllowedOrigins`, `AllowedMethods` (include `PUT`), `AllowedHeaders` (include `Content-Type`), and critically **`ExposeHeaders: ["ETag"]`** — the browser needs each part's returned ETag to assemble the `CompleteMultipartUpload` manifest; omitting this is the most common cause of "multipart upload silently fails to complete." (developers.cloudflare.com/r2/buckets/cors/)
- Pricing: storage $0.015/GB-mo; Class A (write) $4.50/million; Class B (read) $0.36/million; **egress free**. Free tier: 10GB storage, 1M Class A, 10M Class B/month.

**Recommendation**: Proceed as planned, but budget a small early spike specifically to validate the presigned-`UploadPart` flow end-to-end (sign each part server-side, upload from browser, complete server-side) with correct CORS/`ExposeHeaders` config, since Cloudflare doesn't provide this as a canned example.

---

## 5. D1 current limits

**Verdict: ✅ Compatible — the metadata-only design is the explicitly supported pattern.**

- Max database size: **10 GB on Workers Paid** (500 MB on Free). (developers.cloudflare.com/d1/platform/limits/)
- Pricing: rows read **$0.001/million** (25B/mo included free); rows written **$1.00/million** (50M/mo included free); storage **$0.75/GB-mo** (5GB included free).
- Max bound parameters per query: **100**. Max SQL statement length: 100,000 bytes. Max query duration: **30 seconds**. Max per-row/BLOB/string size: **2,000,000 bytes (2 MB)** — this hard ceiling reinforces that D1 cannot hold media blobs; it structurally forces the R2-for-blobs/D1-for-metadata split you've already designed for.
- **Sessions API (read replication)**: is currently **public beta**, not a confirmed GA feature — provides sequential consistency via bookmark tokens (monotonic reads/writes, read-your-writes), available only via the Worker binding (not REST API). Disabling replication takes up to 24h to fully drain.
- The "metadata only" design remains exactly Cloudflare's recommended pattern (large objects → R2, relational/metadata → D1); nothing here changes that recommendation.

**Recommendation**: No changes needed to the D1 design. If the Sessions API is used for read-replica consistency (e.g., for the client-delivery Worker reading gallery metadata), treat it as beta — don't build contractual guarantees around it yet, and have a fallback to primary-only reads if needed.

---

## 6. Queues + Workflows

**Verdict: ✅ Compatible with caveats.**

**Queues**: Cloudflare's docs describe it as "available on Free and Paid plans" without an explicit beta label — treated here as production-grade, though no single "General Availability" statement was located in the fetched pages (worth a quick dashboard check). Max message size **128 KB** (comfortably fits an "IDs only" payload design). Per-queue throughput **5,000 messages/sec**; max consumer batch 100 messages/256KB; backlog cap 25GB/queue; retention up to 14 days. Pricing: **$0.40/million operations** (an operation = each 64KB chunk written/read/deleted), 1M ops/month included free on Paid. At 30-60 shoots/month with ID-only messages, this is trivially cheap.

**Workflows**: GA status is similarly unconfirmed from docs — a changelog dated 2026-07-07 still references Workflows' "initial public beta" in the context of legacy billing, so the exact GA graduation point is unclear; verify the current status banner in the dashboard before final sign-off. Functionally, though, it is solid: **10,000 steps default, configurable to 25,000** (Paid) per workflow; **max sleep duration 365 days**; `step.sleep()`/`step.sleepUntil()` durably park an instance for seconds to days, and **sleeping instances consume no CPU time and don't count against concurrency limits** — this is exactly the mechanism needed for the hours-long autoHDR watched-folder round-trip, and it is cheap (you pay for active steps, not sleep time). CPU time per step: 30s default, extendable to 5 minutes (Paid) — same ceiling as Workers generally, so long zip-build steps still need chunking rather than one giant step.

**Pricing change to flag**: Workflows currently piggybacks on ordinary Workers CPU/request billing, but **new per-step billing ($0.80/100,000 steps beyond 500,000/month included) and per-GB storage billing ($0.20/GB-mo beyond 1GB included) begin no earlier than August 10, 2026** — about three weeks after this audit. At 30-60 shoots/month this is very unlikely to matter financially, but note it as a near-term pricing change, not a hypothetical one.

**Fit assessment**:
- **Ingest fan-out**: good fit — design coarser steps given the 10k/25k step ceiling and the incoming per-step billing.
- **AutoHDR hours-long wait**: excellent fit — `step.sleep`/event-wait is the intended mechanism for exactly this pattern, and it's cheap while asleep.
- **Zip builds**: workable, but the 30s/5min per-step CPU cap means large zip-build jobs should be chunked across multiple steps or should stream to R2 incrementally rather than buffering in one step.

**Recommendation**: Proceed with Queues + Workflows as planned. Confirm Workflows' current GA/beta status directly in the Cloudflare dashboard at implementation time (docs are ambiguous), and account for the Aug 10, 2026 billing change in cost projections (negligible impact expected at this scale).

---

## 7. Static assets + SPA serving

**Verdict: ⚠️ Compatible with caveats.**

- **Workers Static Assets vs Pages**: Workers Static Assets is the current recommended path for a single Worker that serves a Vite/React SPA alongside a Hono API. Cloudflare's official migration guide is framed neutrally ("migrating is often a straightforward process," Workers has "a distinctly broader feature set") and stops short of formally declaring Pages deprecated. However, third-party reporting (citing Cloudflare's own Workers tech lead) describes Pages functionality being folded into Workers over time, with newer products (Secrets Store, Workflows, Containers) shipping Workers-only — Pages is effectively in maintenance mode even without an official deprecation notice. Don't cite "Pages is deprecated" as documented fact, but do treat Workers Static Assets as the forward-looking choice, which is what the proposal already specifies.
- **SPA fallback routing**: configure via `assets: { directory, binding }` in `wrangler.jsonc`; use `not_found_handling: "single-page-application"` to return `index.html` (200) for unmatched routes, and `run_worker_first` (boolean or a route-pattern array, e.g. `["/api/*"]`) to force the Hono Worker to execute before falling back to the static asset handler — this is exactly the mechanism needed to route `/api/*` to Hono RPC and everything else to the SPA shell.
- **Gotchas**: with the Cloudflare Vite plugin, `assets.directory` is typically auto-detected — don't hand-override it. For manual build pipelines, point `assets.directory` explicitly at the Vite `dist` output and have the Worker call `env.ASSETS.fetch(request)` as the final fallback.

**Recommendation**: Proceed with Workers Static Assets as planned (this matches the proposal already). Budget a small early spike to nail down `not_found_handling` + `run_worker_first` interaction with Hono RPC route matching, since this is the kind of config detail that's easy to get subtly wrong (e.g., API routes falling through to the SPA shell, or the SPA shell never being reached because `run_worker_first` is set too broadly).

---

## 8. Service bindings between 4 Workers

**Verdict: ⚠️ Compatible with caveats.**

- **Call-depth limit**: hard cap of **32 Worker invocations per request**, and each service-binding hop counts against it. Irrelevant at your scale (4 Workers, shallow call chains).
- **Deploy ordering**: service bindings are resolved **at deploy time by name, not lazily** — Cloudflare's docs state the target Worker "must be deployed first... otherwise deployment will fail." This is a real operational concern for a 4-Worker, CI/CD-deployed system: your GitHub Actions pipeline must deploy in dependency order (e.g., background Worker before the staff-app and webhook-ingress Workers that bind to it), and a from-scratch environment bootstrap (new `dev`/`staging` env) needs an explicit first-deploy sequence, not a parallel "deploy everything" step.
- **Smart Placement**: relevant and Cloudflare explicitly recommends splitting edge-facing logic from backend logic and connecting via service bindings for Smart Placement to work — but it explicitly **does not affect RPC methods or named entrypoints**, meaning Hono RPC calls between Workers bypass Smart Placement's latency optimization. No documented interaction with Queues either way (Queue consumers are their own invocation context, not proxied through Smart Placement).

**Recommendation**: Encode explicit deploy ordering in the GitHub Actions workflow (deploy background Worker → webhook-ingress → staff-app → client-delivery, or whatever the actual dependency graph is) rather than relying on wrangler to figure it out. Don't expect Smart Placement to meaningfully help the Hono-RPC-over-service-binding paths — it's more relevant if you have a plain `fetch()`-based binding hop, not RPC.

---

## 9. Dropbox from Workers

**Verdict: ⚠️ Compatible with caveats.**

- **Long-lived cursor sync**: Workers are request-scoped with no built-in support for long-lived polling loops, so a Dropbox `list_folder/continue` delta-sync loop cannot simply run continuously inside a Worker. Two architecturally sound patterns: (a) **Cron Triggers** (max 3 per Worker, configured via dashboard/API, not fully dynamic) firing into a Queue that processes one delta-sync tick per invocation, or (b) a **Durable Object alarm** (`setAlarm()`) that reschedules itself after each tick, with guaranteed at-least-once execution and exponential backoff (up to 6 retries) built in. The DO-alarm pattern is more fine-grained and self-scheduling — better suited to a per-studio (per-Dropbox-connection) cursor loop than a fixed global cron slot, especially if multiple studio-Dropbox-connections need independent cadences.
- **Refresh token storage**: **Cloudflare Secrets Store is currently in open beta** (unavailable on the China network) and is **read-only from the Worker runtime** — `env.<BINDING>.get()` is the only in-Worker access pattern; there is no documented write/update/rotate path from inside a Worker. Since Dropbox OAuth refresh tokens must be **rewritten after every token refresh**, Secrets Store is the wrong fit unless you're willing to make an out-of-band call to the Cloudflare REST API to update the secret (extra moving part, extra latency, and awkward to do transactionally with the refresh flow). **D1 with app-level encryption (envelope encryption via a Workers secret as the KEK) is the practical choice** — it's read/write from within the Worker, already in your stack, and lets you update the encrypted refresh token in the same transaction as other ingest-state bookkeeping. KV is a workable alternative if you don't need it queryable alongside other metadata, but D1 is more consistent with "metadata store" already being D1.

**Recommendation**: Use a Durable Object alarm per studio-Dropbox-connection for the cursor-sync loop (cleaner than cron for multi-tenant cadence), and store the OAuth refresh token encrypted in D1 (not Secrets Store, not a static wrangler secret — a wrangler secret is fine for the KEK/encryption key itself, but not for the token value that must be rewritten on every refresh).

---

## 10. Zip streaming

**Verdict: ⚠️ Compatible with caveats — pre-built-in-R2 is the safer default; live streaming-without-compression is fine.**

- **CPU time only counts active JS execution** — network I/O, stream pass-through, and waiting operations are explicitly excluded from the CPU-time meter. Wall-clock duration is effectively unbounded for an HTTP response while the client stays connected. Memory remains capped at **128MB per isolate** (JS heap + WASM combined) — this bounds how much can be buffered at once, not how much can be streamed through.
- Given this, **streaming pre-built zip bytes from R2 straight through to the client** (no compression happening in the Worker — the zip already exists in R2) is architecturally sound and cheap: it's pure I/O pass-through, doesn't touch the CPU-time budget meaningfully, and doesn't need to hold the object in memory.
- **Building a zip on-the-fly** (compressing many R2 objects into a zip stream in real time, in response to a client request) is a different story — that's active CPU work (compression), and for a multi-GB payload could approach the CPU-time cap (30s default / 5min max), especially if compression ratios or file counts are high. This is the riskier pattern of the two "zip" options in your proposal.

**Recommendation**: Prefer the proposal's second option — **pre-build the zip per publish-version into R2 via a Workflow/Queue job**, then have the client-delivery Worker simply stream that pre-built R2 object straight to the client (or issue a signed R2 URL / presigned GET directly, bypassing the Worker entirely for the download itself). Reserve on-the-fly zip *streaming* (not *building*) for cases where the object already exists and you're just proxying it. Avoid on-the-fly zip *compression* of multi-GB galleries as the default path — use it only as a fallback for small/rare ad-hoc downloads if ever needed.

---

## 11. Cloudflare Stream (later phase)

**Verdict: ✅ Compatible — trivially affordable at this scale.**

- Pricing is dual usage-based: **$5 per 1,000 minutes stored/month**, **$1 per 1,000 minutes delivered/month**; ingest/encoding is free, no separate egress fee.
- Sanity check for a small studio (e.g., ~5 hours = 300 minutes stored, ~1,500 minutes delivered/month from modest client gallery traffic): storage ≈ $1.50/mo + delivery ≈ $1.50/mo ≈ **$3-5/month total**.

**Recommendation**: No concerns — defer Stream adoption to the later phase as planned; Vimeo embeds are a reasonable interim choice and the eventual Stream cost is a rounding error at this studio's scale.

---

## 12. Overall cost picture

**Verdict: ✅ Compatible.**

Rough monthly estimate for 30-60 shoots/month, ~40GB new media/month, low client traffic, on Workers Paid:

| Line item | Basis | Rough monthly cost |
|---|---|---|
| Workers Paid base | $5/mo flat, includes 10M requests + 30M CPU-ms | $5 |
| R2 storage | $0.015/GB-mo; grows as media accumulates (not just 40GB — retained history) | ~$1-15+/mo, rising over time as retained volume grows (e.g., toward high single/low double digits once several hundred GB to low TB are retained) |
| R2 operations (Class A/B) | Free tier (1M/10M ops) likely covers this volume | ~$0 |
| D1 | Free tier (25B reads, 50M writes, 5GB storage) comfortably covers metadata-only workload at this shoot volume | ~$0 |
| Queues | Free tier (1M ops/mo on Paid); ID-only messages keep volume low | ~$0 |
| Workflows | Covered by Workers CPU/request billing today; new step/storage billing (Aug 10, 2026) has generous included tiers (500k steps, 1GB storage) | ~$0 initially |
| Cloudflare Images (if used for optimization layer only) | $0.50/1,000 transformations beyond 5,000 free/mo | ~$0-5/mo depending on gallery view volume |
| Cloudflare Containers (image-processing pipeline, per §3 recommendation) | Free tiers (25 GiB-hrs mem, 375 vCPU-min, 200 GB-hrs disk) likely cover 30-60 shoots/month; modest overage if not | ~$0-10/mo |
| Cloudflare Stream (later phase) | Per §11 | ~$3-5/mo once adopted |
| Email (Cloudflare Email Sending, or Resend/Postmark per §2) | Staff-only volume, well within free tiers of any option | ~$0-15/mo |

**Rough total: ~$15-40/month** at launch, most likely trending toward the **$25-50/month** range within the first year as R2 storage retention accumulates (this is the dominant long-run cost driver, not compute or requests) and once the Container-based image pipeline and Stream are both live. This remains inexpensive for a small studio's operating budget; the number to actually watch over time is R2 storage growth, not any of the compute/orchestration products.

---

## Top 5 Risks to the Plan

1. **Ingest-time image processing was scoped for Workers/Images-binding but neither fits the stated 20-50MB source range.** The Images binding's 20MB input cap and the Worker 128MB memory ceiling are hard, documented constraints, not edge cases. This is the single biggest architectural gap between the June 2026 proposal and current platform reality — it requires adding Cloudflare Containers (GA since April 2026) to the stack, which is a new operational surface (a 5th "compute" component beyond the 4 Workers) that wasn't in the original design.

2. **Magic-link email is now a single point of failure for staff login, riding on a service still in public beta.** Cloudflare Email Sending launched public beta only 2026-04-16 (~3 months old). If it has an outage, delivery delay, or deliverability issue, staff literally cannot log in (no Cloudflare Access fallback anymore, per D-14). This risk didn't exist under the old Cloudflare Access model and needs an explicit decision + fallback plan (e.g., GA provider for auth email specifically), not just "we'll use whatever we use for other emails."

3. **D-14 shifts real security-engineering burden onto the app that Cloudflare Access used to absorb.** Session management, CSRF, OAuth state-param handling, magic-link single-use enforcement, and token storage are now all app-owned. better-auth substantially de-risks this, but it's still new production surface area (auth bugs are high-severity by nature) for a small team to own, test, and maintain going forward — budget real code review and security testing time for this, not just integration time.

4. **Workflows' GA status is genuinely ambiguous in current Cloudflare documentation**, and a non-trivial billing model change (per-step + per-GB-storage billing) takes effect August 10, 2026 — three weeks after this audit. The autoHDR hours-long-wait design depends on Workflows' sleep semantics working exactly as documented; verify current GA/beta status and the new billing model directly against the dashboard before treating Workflows as a stable foundation for a multi-hour-duration business process.

5. **Deploy ordering across 4 service-bound Workers is a manual CI/CD discipline problem, not something Cloudflare enforces for you.** Service bindings resolve by name at deploy time and fail if the target isn't already deployed — for a from-scratch environment bootstrap (spinning up a fresh `staging` or a new `dev` environment), or after any Worker is deleted/recreated, the GitHub Actions pipeline must deploy in the correct dependency order every time. This is easy to get right once and easy to silently break later (e.g., a new engineer adds a 5th Worker without understanding the ordering constraint).

