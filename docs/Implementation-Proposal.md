# Quincy Portal — Implementation Proposal

> **Status:** Draft v1.2 · 22 June 2026 (capture-pipeline-first re-sequencing; multi-agent review history in §13)
> **Source of truth:** `docs/PRD.md`, `Personas.md`, `Sitemap.md`, `prototype/uploads/Webhook-data*.md`, and the Igor × Tez capture-workflow decisions.
> **Audience:** Quincy Productions team + implementing engineers
> **Scope:** Turn the React prototype into a production system on Cloudflare.

---

## 1. Executive summary

The prototype proves the product: one connected portal running the full media pipeline
for a property shoot — **Tonomo booking → capture upload → RAW QA → autoHDR editing →
Edited QA → client delivery** — with role-based access for Admin, Photographer, Editor/QA,
and a no-login client delivery page.

This proposal recommends building it as a **Cloudflare-native application**. The decisive
reason is economics and fit: Quincy moves large media (multi-MB JPEG exports, HDR results,
1080p+ video). Cloudflare **R2 has zero egress fees**, **Workers + D1 + Queues + Workflows**
give a single, cheap, globally-fast platform with no servers to run, and the existing
`prototype/wrangler.jsonc` already deploys to Cloudflare Workers — so we extend a direction
already chosen.

> **Key product clarification (drives the whole media design).** Per the Igor × Tez capture
> decision, the portal ingests **full-resolution JPEGs exported from Lightroom** — *not*
> camera RAW. Camera RAW is retained by the photographer as a security backup and is **never
> uploaded** to the portal. The pipeline's "RAW" stage means *unedited JPEG exports awaiting
> QA*. This removes any need for in-cloud RAW decoding and makes edge image handling tractable.

**Recommended stack at a glance:**

| Concern | Recommendation | Notes / changed in v1.1 |
|---|---|---|
| UI | React 18 + TypeScript + **Vite SPA**, reusing the Quincy design system | SSR dropped as default (no SEO need; private links) |
| App framework | Plain SPA + JSON API; **React Router v7 SSR only if a measured first-load need** | was "SSR by default" |
| API | **Hono** on Cloudflare Workers (TypeScript) | — |
| Worker topology | **Workers split by surface**: thin public *webhook-ingress* (Tonomo + Dropbox), public *client-delivery* (links/gallery/paywall), staff *app/API* (behind Access), *background* consumers — joined by service bindings | webhook ingress separated from client delivery so it can ship earlier (§6.2, §9) |
| Relational data | **Cloudflare D1** (SQLite) + Drizzle ORM (metadata only) | Drizzle optional; plain typed SQL fine |
| Object storage | **Cloudflare R2** (originals, ingest-generated renditions, cached zips) — **versioned, immutable keys** | — |
| Image renditions | **Generated at ingest into R2** (web + thumbnail JPEGs). On-the-fly CF image transforms only for in-limit web JPEGs/watermark previews | was "Cloudflare Images on the fly" — see §6.4 |
| Video | **Vimeo now**; Cloudflare Stream later (signed playback URLs for paywall) | Stream demoted to later phase |
| Staff auth | **Cloudflare Access (Zero Trust)** — JWT validated (aud + signature), public routes excluded | hardened |
| Client access | Signed private-link tokens (hashed at rest), optional passcode (slow hash) + expiry | hardened |
| Async work | **Queues** (pass IDs only, 128 KB cap) + **Workflows** (durable ingest / autoHDR / zip) | — |
| Realtime | **Deferred** — polling/optimistic updates first; Durable Objects only if live co-review is needed | was "DO presence" |
| Sessions/flags | None needed for staff (Access); KV optional for non-critical cache only | KV demoted |
| Integrations | Tonomo webhook (`order.created` **+ order.updated**), Dropbox API (webhooks, not polling), autoHDR (Dropbox folder), Vimeo | — |
| CI/CD | Wrangler + GitHub Actions (deploy on push to `main`) | — |
| Observability | Workers Observability + Logpush + **correlation IDs, audit log, stuck-stage alerts, cost dashboards** | deepened |
| Backup/DR | **R2 versioning + lifecycle, D1 Time Travel + scheduled exports, soft-delete + retention** | new (§7) |

A phased rollout (§9) builds the **internal capture → edit → QA pipeline first** (the team's
daily workflow), then adds Tonomo intake and the dashboard, and delivers the client-facing
gallery **last** (the Pixieset replacement).

---

## 2. Goals this architecture must satisfy

From the PRD/personas/meeting decisions:

1. One portal, five pipeline stages with selection gates (PRD §5, §7).
2. Role-based, **capability-level** access — Admin / Photographer (RAW-only, assigned shoots) /
   Editor-QA / Client (PRD §4).
3. Automatic project intake from Tonomo webhooks, incl. order **updates** (PRD §4a).
4. Capture ingest by manual upload *and* Dropbox sync; **autoHDR handoff** via a watched
   Dropbox folder (PRD §5 stages 1 & 3).
5. Review tooling — ratings (incl. **rating metadata read from the JPEG**), labels, freehand
   markup, compare (incl. RAW↔Edited), bulk, select-for-editing (PRD §6.3, meeting decision).
6. **File-count verification** on ingest ("upload 18 → see 18"; folder name carries input/
   output counts) — a core trust requirement from the meeting.
7. Editorial client delivery — no login, favourites, download (web/full-res, zip),
   video, copy, **watermarked premium content** (PRD §6.7).
8. **Media-heavy and cheap to serve** — the non-functional requirement driving the platform.

---

## 3. Why Cloudflare (and what we'd pick differently)

Cloudflare is right for this workload. Refinements vs. the initial instinct (D1/R2/Pages/Workers):

- **Workers over Pages** (already in `wrangler.jsonc`).
- **Renditions at ingest, not "Cloudflare Images on the fly."** Cloudflare Images has a
  **10 MB source limit** and no camera-RAW support; full-res JPEG exports and HDR results can
  exceed that. So we generate web/thumbnail derivatives **at ingest** (in a background
  consumer) and store them in R2; on-the-fly CF image transforms are an optimisation only for
  sources within format/size limits. (§6.4)
- **Add Queues + Workflows** for ingest, the autoHDR round-trip, and zip building — these
  exceed a single request's CPU/memory budget and must be durable/retriable.
- **Cloudflare Access for staff**, signed links for clients — no auth code to own, but public
  routes (webhooks, client delivery) must be **excluded** from Access (§6.3).
- **Defer realtime (Durable Objects) and KV** until a concrete need appears.

### Alternatives considered

| Option | Verdict |
|---|---|
| **AWS (S3 + CloudFront + Lambda)** | Mature, but **egress fees** on media delivery are exactly what we're escaping; more ops. |
| **Supabase (Postgres + Storage)** | Great DX/real Postgres, but storage egress isn't free and we'd still need a CDN; splits the stack. |
| **Firebase** | Tonomo already uses it, but egress/storage cost for large media + lock-in rule it out for hosting. We *integrate* with Tonomo's Firebase (read its links), we don't host on it. |
| **Cloudflare (recommended)** | Free egress, one platform, lowest cost at Quincy's volume. Trade-off: Workers/D1/Images limits (§8) we design around. |

---

## 4. System architecture

```
                      ┌──────────────────── Tonomo (Firebase) ──────────────────┐
                      │  order.created / order.updated  +  deliverable Dropbox links │
                      └───────────────┬──────────────────────────────────────────┘
                                      │ POST /webhooks/tonomo/*  (signed, public)
                                      ▼
   Client ──signed link (/d/:token)──►  ┌───────────────────────────────────────┐
   (no login, public)                   │  PUBLIC Workers (ingress + delivery)    │
                                        │  • webhooks + client galleries/downloads │
                                        └───────────────┬─────────────────────────┘
                                                        │ service bindings
   Staff ──Cloudflare Access (SSO/MFA)──► ┌─────────────▼───────────────────────┐
   (JWT validated)                        │  APP/API Worker (staff, behind Access) │
                                          └───┬────────┬─────────┬────────┬───────┘
                                              │        │         │        │
                                        ┌─────▼──┐ ┌───▼───┐ ┌───▼────┐ ┌─▼─────────┐
                                        │  D1    │ │  R2   │ │ Queues │ │ BACKGROUND │
                                        │metadata│ │files +│ │(IDs)   │ │  Worker     │
                                        │        │ │rendit.│ └───┬────┘ │(consumers + │
                                        └────────┘ │+ zips │     │      │ Workflows)  │
                                                   └───┬───┘     └──────┴──┬──────────┘
                                                       │                    │
                                                       │        ┌───────────▼────────────┐
                                                       │        │ Dropbox API (webhooks)  │
                                                       │        │ • pull capture (sync)    │
                                                       │        │ • push selected→autoHDR  │
                                                       │        │ • receive returned edits │
                                                       │        └───────────┬─────────────┘
                                                 ┌─────▼─────┐        ┌──────▼──────┐
                                                 │ CF Stream │        │  autoHDR    │
                                                 │ (later)   │        │ (watches DB)│
                                                 └───────────┘        └─────────────┘
```

> The diagram is the **end-state**. Early phases build only the staff *App/API* + *Background*
> Workers; the thin public **webhook-ingress** Worker arrives in Phase 2 (Dropbox) / Phase 3
> (Tonomo), and the public **client-delivery** Worker in Phase 5 (§9).

### Request-flow examples
- **Tonomo order created/updated →** the **webhook-ingress Worker** verifies signature, dedupes
  by event id, upserts the project (create at *Awaiting RAW*, or update scope/schedule/
  deliverables, reconciling with manual projects by `order_id`), enqueues deliverable hydration.
- **Editor selects RAWs →** D1 records selection → a **Workflow** copies those JPEGs into the
  autoHDR-watched Dropbox folder, sets *Editing·autoHDR*, then ingests returned edits (on a
  Dropbox **webhook**, not polling) as the Edited collection → *Edited review*.
- **Client opens link →** signed token resolved (public Worker) → SPA gallery → thumbnails/web
  sizes served from R2-stored renditions; full-res and zips streamed from R2 (free egress)
  **only after** an unlock check for premium items.

---

## 5. Data model (Cloudflare D1, via Drizzle)

Core tables (all get `id`, `created_at`, `updated_at`):

- **users** — `email`, `name`, `role`, `active` (identity from Access JWT; row carries role/profile).
- **projects** — address (street/suburb/postcode), `agency`, agent (name/email/phone),
  `shoot_date`, `time_window`, `stage` (PRD §7), `order_no`, `order_id`, `invoice_amount`,
  `payment_status`, `notes`, `raw_folder_link`, `raw_folder_path`.
- **project_members** — `project_id`, `user_id`, `role_on_project`.
- **collections** — `project_id`, `kind` (`raw|edited|video|floorplan|copy`), `status`,
  `expected_count`, `received_count` (file-count verification, §6.6).
- **assets** — `collection_id`, `kind`, `r2_key` (immutable, versioned), `original_filename`,
  `bytes`, `width`, `height`, `content_hash`, `source` (`upload|dropbox|tonomo`),
  `rating_from_metadata` (XMP/IPTC star rating read at ingest), `stream_uid` (video),
  `is_premium`, `version`, `supersedes_asset_id` (immutable revisions, §6.7).
- **asset_renditions** — `asset_id`, `variant` (`thumb|web`), `r2_key`, `bytes` (generated at
  ingest; clean full-res is the original in R2).
- **selections** — `asset_id`, `selected_by`, `state` (`selected_for_editing`), `bracket_group`
  (manual bracketing by the editor — no auto-grouping).
- **ratings / labels / decisions** — per-asset QA state (`stars`, `color`, `approved|flagged`).
- **annotations** — `asset_id`, `author_id`, `role`, `scope` (`raw|edited`),
  `stroke_r2_key` (dense freehand vector JSON stored in **R2**, ref only in D1 — see §8),
  `note_text`, `thumbnail_r2_key`.
- **comments** — threaded (`asset_id`, `parent_id`, `author_id`, `role`, `body`).
- **publishes** — `project_id`, `asset_id`, `published_by`, `published_at`, `publish_version`.
- **client_links** — `project_id`, `token_hash`, `publish_version`, `expires_at`,
  `passcode_hash`, `revoked`.
- **premium_unlocks** — `client_link_id`, `scope` (`asset|all`), `unlocked_at`, `payment_ref`.
- **webhook_events** — raw Tonomo payloads, idempotency by event id (audit + replay).
- **jobs** — durable job/workflow tracking (status, retries, correlation id).
- **audit_log** — actor, action, target, timestamp (who selected/published/unlocked/deleted).

---

## 6. Component-by-component plan

### 6.1 Frontend (Quincy DS, React, TypeScript)
- Reuse `prototype/_ds/` as the component foundation; port the prototype screens (`dashboard`,
  `workspace`, `board`, `viewer`, `client`, `tonomo`) into typed components.
- **Default: Vite SPA** + JSON API. The client gallery is a private link with no SEO need, so
  SSR isn't warranted; revisit React Router v7 SSR only if a measured first-load metric demands it.
- Preserve the prototype's interactions (lightbox, keyboard shortcuts, freehand markup,
  compare, kanban drag).

### 6.2 API & worker topology (Hono)
- **App/API Worker (staff):** `/app/*`, `/api/*` behind Cloudflare Access. **Built first** —
  it carries the whole internal capture pipeline.
- **Background Worker:** Queue consumers + Workflows (ingest, autoHDR, zip).
- **Webhook-ingress Worker (public, thin):** `/webhooks/dropbox` and `/webhooks/tonomo/*`.
  Public but locked to signature/secret validation only — **no gallery, no asset serving**.
  Built when the first webhook is needed (Dropbox in Phase 2), extended for Tonomo in Phase 3.
  Kept separate from client delivery so the public attack surface stays minimal and the two
  ship independently.
- **Client-delivery Worker (public):** client galleries `/d/:token`, downloads, paywall.
  **Built last (Phase 5).** No Access in front; strict signed-token checks.
- Workers communicate via **service bindings**; this bounds blast radius, bundle size, and
  rollback per surface.

### 6.3 Auth & access control (hardened)
- **Staff:** Cloudflare Access on the staff Worker only. The Worker **validates the Access
  JWT** (verify signature against Access public keys + check `aud`), never just trusts the
  header. Email → `users.role`.
- **Public routes excluded from Access:** webhooks and client delivery must remain reachable
  without an Access session.
- **Client links:** unguessable token, **hashed at rest**, scoped to a `publish_version`,
  **expiring by default**, revocable; optional passcode stored with a **slow hash**; pages set
  `Referrer-Policy: no-referrer` to avoid token leakage.
- **Capability-based permissions:** enforce the PRD §4 matrix as discrete capabilities
  (`uploadRaw`, `selectForEditing`, `viewEdited`, `manageExtras`, `publish`, …) so a
  photographer scoped to assigned-RAW can never reach edited/client assets.

### 6.4 Storage & media (R2-first; Images as optimisation only)
- **R2** holds immutable, versioned originals (JPEG exports, edited JPEGs, floorplan PDF/JPG,
  copy PDF) and cached zips.
- **Renditions generated at ingest** (background consumer): web + thumbnail JPEGs written to
  R2. This sidesteps Cloudflare Images' 10 MB source limit and guarantees a fast preview for
  large HDR JPEGs, and produces the **matched-resolution web JPEGs** needed for RAW↔Edited
  compare (agy finding).
- **Clean full-res** is the R2 original, served via **authorised, signed URLs** — never
  through a public/cacheable transform.
- **On-the-fly CF image transforms** are an optional optimisation for web-size JPEGs within
  format/size limits and for **watermarked premium previews** (which must require signed URLs
  on *all* variants so the clean URL can't be guessed).
- **Internal-only during Phases 1–4:** every asset preview/download endpoint is
  **staff-Access-only**. The client signed-URL API and its **unlock checks** are introduced
  with the client-delivery Worker (Phase 5); an internal endpoint must never become the client
  path by simply being reused without those checks.
- **Data-model-forward:** the Phase 1 ingest writes `is_premium` and the rendition variants in
  the exact shape Phase 5 will read, even though nothing consumes them yet — so the paywall
  doesn't force a later migration of a populated asset store.

### 6.5 Tonomo intake (webhook)
- `POST /webhooks/tonomo/order.created` **and** `order.updated`: verify HMAC signature,
  enforce a replay window, dedupe by event id (`webhook_events`), map fields per PRD §4a,
  upsert the project + empty collections for ordered services, enqueue deliverable hydration.
  An **operator screen** surfaces failed/ambiguous mappings (poison events) for manual fix.
- **Open decision (PRD §4a):** per-service flag — start reshoots at *Awaiting RAW* while
  already-finished deliverables (floorplan/video/copy links in the payload) attach immediately.
- **Reconciliation with manually-created projects (Phase 3):** when intake is automated, match
  incoming orders to existing projects by **`order_id`** (address as a fallback) so the
  manually-created Phase 0/1 projects aren't duplicated; unmatched/ambiguous orders go to the
  operator screen for merge/confirm. Manual projects carry the Tonomo `order_id` where known so
  the later webhook merges cleanly.

### 6.6 Capture ingest, file counts & Dropbox sync
- **Manual upload:** **direct-to-R2 multipart** with presigned URLs (the *only* large-file
  path — Worker request bodies are capped at 100 MB Free/Pro, 200 MB Business), **resumable**
  with checksum validation; metadata to D1; stage → *RAW review*.
- **Dropbox sync:** a Queue/Workflow consumer streams the folder **file-by-file** (avoids
  Worker time limits), idempotent by `content_hash`, with explicit **conflict/version
  semantics** (renames, duplicate names, revised edits, deletions → immutable asset versions).
  In **Phase 1** sync is **manually triggered** from the UI; the Dropbox **webhook**
  (delta/cursor-driven) is added in **Phase 2** for hands-off sync and the autoHDR return.
- **File-count verification:** `expected_count` from the Dropbox folder-name convention
  (input/output counts) **or, for manual uploads, the browser's selected-file manifest
  (persisted before ingest)**, checked against `received_count`; mismatches flagged in the UI
  ("upload 18 → see 18").
- **Rating metadata:** read the JPEG's embedded star rating (XMP/IPTC) at ingest into
  `rating_from_metadata`, so on-site culling drives selection from the start (meeting decision).

### 6.7 autoHDR handoff (Workflow + Dropbox webhook)
- A **Workflow** owns the round-trip: copy selected JPEGs to the autoHDR-watched Dropbox
  folder → mark *Editing·autoHDR* → **the Dropbox webhook triggers a cursor/delta sync** and the
  changed files are correlated to the autoHDR output folder (not naive polling or a per-file
  push) → ingest as Edited → *Edited review*. Includes explicit **timeout, manual retry,
  and a "stuck in autoHDR" recovery screen**. (Direct autoHDR API remains a future option.)

### 6.8 Review tooling
- Ratings/labels/decisions/selections are D1 writes; **bulk actions chunked** to respect D1's
  100-bound-parameter and query-duration limits. Freehand markup stored as vector JSON in **R2**
  (ref in D1) + a flattened thumbnail. Realtime co-review deferred (polling/optimistic first).

### 6.9 Client delivery & downloads (paywall-safe)
- SPA gallery from `publishes` (by `publish_version`). **Premium enforcement is server-side on
  every path** — asset API, signed-URL minting, and zip jobs all check `premium_unlocks`; the
  clean original is never served without an unlock; previews are watermarked via signed-URL
  variants.
- **Zips stream on the fly** (R2 has no append; Workers have a 128 MB memory cap): stream R2
  objects through a zip stream to the client, or pre-build a per-`publish_version` "download
  all" zip in R2 as a job and serve a short-lived signed URL. Add **per-link rate limits, max
  size behaviour, cached reuse, and lifecycle expiry** to prevent abuse.

### 6.10 Floorplan & copywriting
- Floorplan: R2 PDF + JPG with versioning (PRD §6.5). Copy: per-project PDF now; in-portal copy
  entry + social content later (PRD §6.6).

---

## 7. Cross-cutting concerns

- **Backup / DR / deletion (new):** R2 **object versioning + lifecycle rules**; D1 **Time
  Travel** + scheduled logical exports to R2; **soft-delete + retention windows** for
  projects/assets/links so client media can't be lost to an accidental delete; periodic
  **restore drills**.
- **CI/CD:** GitHub Actions → `wrangler deploy` on push to `main`; PR preview deploys; Drizzle
  D1 migrations gated in the deploy.
- **Secrets:** Wrangler secrets for Tonomo signing key, Dropbox app token, Stream/Images keys.
- **Observability (deepened):** Workers Observability + Logpush, plus **correlation IDs from
  webhook → delivery**, an **audit log**, **alerting on stuck pipeline stages**, and a
  **cost/usage dashboard** (R2 ops, Images/Stream usage).
- **Privacy:** agent contact details + addresses are PII — scope access, log it, and apply
  retention; client links never leak via referrer.
- **Testing:** Vitest + `@cloudflare/vitest-pool-workers` (Miniflare), Playwright for the
  critical flows — **internal first**: manual project → upload/sync → renditions → RAW QA →
  select-for-editing → autoHDR → Edited ingest → Edited QA (Phases 1–2); then intake → publish →
  client download/unlock (Phases 3–5).
- **Environments:** `dev` (Miniflare/local D1+R2) → `staging` → `production` (separate D1/R2).

---

## 8. Risks, limits & mitigations

| Risk / limit | Mitigation |
|---|---|
| **Cloudflare Images 10 MB source + no RAW** | Generate renditions **at ingest** into R2; portal ingests JPEGs only (not camera RAW). |
| **Worker request-body cap** (100 MB Free/Pro, 200 MB Business) | Direct-to-R2 multipart, resumable, checksummed — the only large-file path. |
| **Worker 128 MB memory; R2 no append** | **Stream** zips; or job-build a per-version zip in R2; never buffer multi-GB in a Worker. |
| **Worker CPU/time on sync** | File-by-file streaming in a Queue/Workflow; backoff; idempotent by `content_hash`. |
| **D1 limits** (~10 GB/db, 2 MB row, 100 bound params, query duration) | Metadata only; dense JSON (annotations) in R2; **chunk** bulk rating/label/publish ops; index hot queries. |
| **Queue message 128 KB** | Pass **IDs/manifests**, not payloads; manifest rows in D1/R2. |
| **Dropbox API limits** | **Webhooks** over polling; batch + backoff; stuck-state recovery UI. |
| **autoHDR has no API** | Dropbox folder-watch contract; Workflow with timeout + manual retry. |
| **Premium paywall bypass** | Server-side unlock checks on every asset/zip/signed-URL; signed URLs on all variants; clean original gated. |
| **Access misrouting** | Exclude webhooks + client delivery from Access; validate JWT (sig + `aud`). |
| **Cost realism** | Build a **per-shoot volume model** before committing Images/Stream; Stream bills stored+delivered minutes, Images bills transforms/stored/delivered. |
| **Data loss** | R2 versioning/lifecycle, D1 Time Travel + exports, soft-delete + restore drills. |

---

## 9. Phased delivery plan

**Capture pipeline first.** The team will use the portal **internally** to run capture, QA
and the autoHDR editing loop before anything client-facing exists; the client delivery page
(the Pixieset replacement) is built **last**. This front-loads the workflow that saves the
team time daily and de-risks the hardest internal mechanics (ingest, Dropbox sync, autoHDR
round-trip) while there are no external users to disrupt. Each phase is independently
shippable to the internal team behind Cloudflare Access.

- **Phase 0 — Foundations (internal).** Staff app/API Worker behind Access with
  **capability-based authorization**, background Worker (Queues/Workflows), D1 schema +
  migrations, R2 buckets + versioning, CI/CD, observability + audit baseline, DS integration,
  and **manual admin project creation** capturing the fields Tonomo will later supply (address,
  agency/client, shoot date, ordered services/collections, expected RAW count, Dropbox folder
  link/path, assigned photographer/editor, stage) **plus an optional Tonomo `order_id`** as the
  reconciliation key. **Spike first:** prove the **rendition/image-processing path** against
  worst-case full-res Lightroom JPEGs (Worker/WASM vs. an external job runner vs. a
  Lightroom-side derivative export) before Phase 1 depends on it. *The public delivery Worker is
  not built until Phase 5.*
- **Phase 1 — Capture ingest + RAW QA (first daily-driver).** Capture upload (direct-to-R2
  multipart) + Dropbox sync, **file-count verification**, **rating-metadata ingest**,
  ingest-time renditions, a minimal project list, and RAW QA tooling (ratings, labels,
  freehand markup, compare, photographer *recommend*) ending in the **select-for-editing**
  gate. This is the first thing the team uses every day.
- **Phase 2 — autoHDR handoff + Edited QA.** Introduce the thin **public webhook-ingress
  Worker** (Dropbox webhook → cursor/delta sync) and the **Workflow** round-trip; Edited
  collection ingest, Edited QA (approve / flag / rate / label / annotate), RAW↔Edited compare.
  Completes the internal **capture → edit → QA** loop end-to-end.
- **Phase 3 — Tonomo intake + full dashboard.** Extend the webhook-ingress Worker for Tonomo
  (`order.created` / `order.updated`) to automate project creation, **with a
  reconciliation/backfill step** (match by `order_id`/address, dedupe against the manual
  projects, operator review); full dashboard (grid / list / kanban) with role-filtered views.
- **Phase 4 — Video / floorplan / copy (internal management).** Vimeo film links, floorplan
  PDF/JPG versioning, copywriting PDF — uploaded, managed and QA'd internally.
- **Phase 5 — Client delivery (Pixieset replacement, last).** The public **client-delivery
  Worker** (the webhook-ingress Worker already exists from Phase 2): signed client links,
  editorial gallery, favourites, downloads (streamed + cached zip), and the watermarked
  **premium paywall**; then retire Pixieset. Cloudflare Stream native video and basic **stage
  notifications** are optional follow-ons here.

**Launch gates.** Internal phases (0–4) gate on **auth + capability authorization, ingest
correctness + file-count verification, audit log, and backup/restore**. The first
client-facing release (Phase 5) additionally gates on **paywall enforcement and client-link
hardening**. These are kept separate from "prototype parity" polish (kanban drag, compare
refinements, etc.).

> **Sequencing trade-off (noted):** building delivery last means Pixieset keeps running until
> Phase 5, so there is no cost saving on client delivery egress until then — accepted, because
> the internal time-savings land far sooner. Phases 0–2 need only the staff + background
> Workers; the public delivery Worker and its client-link/paywall surface arrive in Phase 5.

---

## 10. Rough cost picture (order of magnitude)

For a small studio's volume the platform should sit in the **low tens of dollars/month**:
Workers Paid ($5/mo base), **R2 storage + operations (no egress)**, D1 (generous free tier),
small Queues/Workflows usage, plus **metered Images/Stream by volume** (model these per shoot
before committing). This preserves the "free-tier-to-~$20/mo" target from the team update, far
below AWS for the same egress — but the Images/Stream lines must be sized against real shoot
counts, not assumed flat.

---

## 11. Open questions to confirm (from the PRD)

1. **Edited QA:** RAW-vs-Edited pairs in compare? (PRD §5/§8) — supported by ingest renditions.
2. **Floorplans:** PDF + JPG with versioning? (PRD §6.5)
3. **Client link:** expiry window and/or passcode defaults? (PRD §6.7)
4. **Client approval step:** does the agent ever review/approve, or only receive? (Personas §4)
5. **Tonomo intake:** *Awaiting RAW* vs. land delivered assets immediately (per-service)? (PRD §4a)
6. **Admin vs PM:** one role or two? (Personas §1)
7. **Native video timing:** when to move off Vimeo to Cloudflare Stream? (PRD §6.4)

---

## 12. Recommendation

Build Quincy Portal as **four cooperating Cloudflare Workers** (staff app/API, background
consumers, a thin public webhook-ingress, and client-delivery — Vite SPA + Hono API) over
**D1 + R2**, with **ingest-time rendition generation**, **Queues/Workflows** for the media
pipeline, **Cloudflare Access** for staff and **signed links** for clients. Treat the JPEG-only
ingest, paywall enforcement, file-count verification, and backup/restore as launch gates. It
satisfies the PRD, respects Cloudflare's real limits, matches the media-heavy/low-cost
constraint, and extends the Cloudflare direction the repo already targets. Treat JPEG-only
ingest, file-count verification, and backup/restore as **internal launch gates**, with
**paywall enforcement and client-link hardening as the Phase 5 client-launch gates**.
**Start with the internal capture pipeline** (ingest → RAW QA → select-for-editing → autoHDR → Edited QA) so the
team gets daily value first, then add Tonomo intake and the dashboard, and build the client
delivery page (the Pixieset replacement) **last**.

---

## 13. Review log (multi-agent + self review)

This proposal was reviewed by **Codex** and **Antigravity** (via `acpx`/`agy`) and self-reviewed.
Gemini was requested but its CLI free tier was discontinued (`IneligibleTierError`) and no API
key was available, so Antigravity was substituted. Findings and resolutions:

| # | Finding (source) | Severity | Resolution in v1.1 |
|---|---|---|---|
| 1 | Cloudflare Images can't process camera RAW / 10 MB source cap (Codex, agy) | P0 | Clarified portal ingests **JPEGs only**; renditions generated **at ingest** into R2 (§1, §6.4, §8) |
| 2 | Upload understates Worker request-body limits (Codex, agy) | P0 | Direct-to-R2 multipart, resumable + checksum, only large-file path (§6.6, §8) |
| 3 | Paywall incomplete — clean originals/zips/caches unprotected (Codex, agy) | P0 | Server-side unlock on every path; signed URLs on all variants; clean asset gated (§6.9) |
| 4 | Images wrong for full-res delivery (Codex) | P0 | Full-res = R2 original via signed URL; Images for previews/watermark only (§6.4) |
| 5 | Access in front of `/api` breaks webhooks/client links; header trust unsafe (Codex) | P0 | 3-Worker split; public routes excluded; **JWT validated** (sig + aud) (§6.2, §6.3) |
| 6 | Zip can't be appended in R2; 128 MB Worker memory (agy, Codex) | P0 | Stream zips / job-built per-version zip; size caps + cached reuse (§6.9, §8) |
| 7 | No backup/restore/deletion policy (Codex) | P0 | R2 versioning/lifecycle, D1 Time Travel + exports, soft-delete + drills (§7) |
| 8 | Cost claim optimistic (Codex) | P1 | Per-shoot volume model required; Images/Stream metering called out (§10) |
| 9 | D1 limits ignored (2 MB row, 100 params, duration) (Codex) | P1 | Metadata only; annotations JSON to R2; chunked bulk ops (§5, §6.8, §8) |
| 10 | Queue 128 KB message cap (Codex) | P1 | Pass IDs/manifests only (§8) |
| 11 | Dropbox polling inefficient; needs stuck recovery (Codex, agy) | P1 | Dropbox **webhooks**; timeout/manual retry + recovery screen (§6.7) |
| 12 | Single Worker over-concentrated (Codex) | P1 | Split into staff app/API, background, webhook-ingress, and client-delivery Workers (§6.2; webhook-ingress added in v1.2) |
| 13 | SSR over-engineered for private galleries (Codex) | P1 | Default to **SPA**; SSR only if measured need (§1, §6.1) |
| 14 | Durable Objects presence premature (Codex) | P1 | Deferred; polling/optimistic first (§6.8) |
| 15 | KV weak fit (Codex) | P1 | Demoted to optional non-critical cache (§1) |
| 16 | Dropbox conflict/version semantics undefined (Codex) | P1 | Immutable asset versions; conflict rules (§5, §6.6) |
| 17 | Webhook security underspecified; handle order **updates** (Codex, agy) | P1 | Signature + replay + idempotency + poison-event screen; `order.updated` (§6.5) |
| 18 | Coarse roles leak edited/client assets (Codex) | P1 | Capability-based permissions (§6.3) |
| 19 | Client link hardening (Codex) | P1 | Hashed token, default expiry, revoke, slow passcode hash, no-referrer (§6.3) |
| 20 | Observability too thin (Codex) | P1 | Correlation IDs, audit log, stuck-stage alerts, cost dashboard (§7) |
| 21 | Stream should stay optional (Codex) | P2 | Vimeo first; Stream later phase (§1, §6, §9) |
| 22 | Drizzle not essential (Codex) | P2 | Marked optional (§1) |
| 23 | Phase order needs thin admin back-office (Codex) | P2 | Manual admin project creation in **Phase 0** (§9) |
| 24 | No notification plan (Codex) | P2 | Basic stage notifications in Phase 5 (§9) |
| 25 | Separate prototype parity from launch hardening (Codex) | P2 | Explicit **launch gates** (§9) |
| 26 | RAW↔Edited compare needs matched web JPEGs (agy) | P2 | Provided by ingest renditions (§6.4) |
| 27 | *Self:* rating metadata from JPEG; file-count verification; manual bracketing (meeting) | — | Added as first-class requirements (§2, §5, §6.6) |

### v1.2 review round — capture-first re-sequencing (Codex + Antigravity + self)

After re-sequencing to build the internal capture pipeline first and client delivery last,
the proposal was re-reviewed by **Codex** and **Antigravity**; findings and resolutions:

| # | Finding (source) | Severity | Resolution in v1.2 |
|---|---|---|---|
| 28 | Webhooks live on the delivery Worker, but it's deferred to Phase 5 while Dropbox (Ph2)/Tonomo (Ph3) webhooks are needed earlier — build-order blocker (Codex, agy) | P0 | Split a thin **public webhook-ingress Worker** from client delivery; built Phase 2 (§6.2, §9) |
| 29 | Rendition path only said "background consumer"; capture-first makes it a Phase-1 dependency (Codex) | P0 | **Phase 0 spike** proving the path on worst-case JPEGs (§9) |
| 30 | Manual project creation too vague to stand alone (Codex, agy) | P1 | Phase 0 captures the full Tonomo field set + `order_id` key (§9) |
| 31 | Tonomo automation needs reconciliation vs. manual projects (Codex, agy) | P1 | Match by `order_id`/address, dedupe, operator review (§6.5, §9) |
| 32 | File-count verification missing for manual upload (Codex) | P1 | `expected_count` from the browser upload manifest (§6.6) |
| 33 | Internal endpoints could become the client path ungated (Codex) | P1 | Phases 1–4 endpoints staff-Access-only; unlock checks added with delivery Worker (§6.4) |
| 34 | Paywall data-model drift if built last against a populated store (agy) | P1 | Phase 1 ingest writes `is_premium` + variants in Phase-5 shape (§6.4) |
| 35 | Dropbox "webhook" too literal (Codex) | P1 | Webhook triggers cursor/delta sync + correlation (§6.7, §9) |
| 36 | Phase-1 Dropbox sync trigger unclear without the webhook (agy) | P2 | Phase 1 = manual UI trigger; webhook from Phase 2 (§6.6) |
| 37 | Diagram/testing/recommendation still read delivery-first (Codex) | P2 | End-state note (§4); internal-first test path (§7); Phase-5 paywall gate (§12) |
| 38 | Review-log rows stale after re-sequencing (Codex) | P2 | Row 23 corrected; Phase 5 now lists notifications (§9, §13) |
