# Quincy Portal — Implementation Proposal

> **Status:** Draft v1.1 · 22 June 2026 (revised after multi-agent review — see §13)
> **Source of truth:** `project/docs/PRD.md`, `Personas.md`, `Sitemap.md`, `project/uploads/Webhook-data*.md`, and the Igor × Tez capture-workflow decisions.
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
`project/wrangler.jsonc` already deploys to Cloudflare Workers — so we extend a direction
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
| Worker topology | **3 Workers**: public *delivery* (client links + webhooks), staff *app/API* (behind Access), *background* consumers — joined by service bindings | was "single Worker" |
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

A phased rollout (§9) replaces Pixieset first (client delivery + a thin admin back-office),
then internalises the pipeline.

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
   (no login, public)                   │  DELIVERY Worker (public)               │
                                        │  • client galleries, downloads, webhooks │
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

### Request-flow examples
- **Tonomo order created/updated →** delivery Worker verifies signature, dedupes by event id,
  upserts the project (create at *Awaiting RAW*, or update scope/schedule/deliverables),
  enqueues deliverable hydration.
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
- Reuse `project/_ds/` as the component foundation; port the prototype screens (`dashboard`,
  `workspace`, `board`, `viewer`, `client`, `tonomo`) into typed components.
- **Default: Vite SPA** + JSON API. The client gallery is a private link with no SEO need, so
  SSR isn't warranted; revisit React Router v7 SSR only if a measured first-load metric demands it.
- Preserve the prototype's interactions (lightbox, keyboard shortcuts, freehand markup,
  compare, kanban drag).

### 6.2 API & worker topology (Hono)
- **Delivery Worker (public):** client galleries `/d/:token`, downloads, and `/webhooks/*`.
  No Access in front. Strict signed-token + signature checks.
- **App/API Worker (staff):** `/app/*`, `/api/*` behind Cloudflare Access.
- **Background Worker:** Queue consumers + Workflows (ingest, autoHDR, zip).
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

### 6.5 Tonomo intake (webhook)
- `POST /webhooks/tonomo/order.created` **and** `order.updated`: verify HMAC signature,
  enforce a replay window, dedupe by event id (`webhook_events`), map fields per PRD §4a,
  upsert the project + empty collections for ordered services, enqueue deliverable hydration.
  An **operator screen** surfaces failed/ambiguous mappings (poison events) for manual fix.
- **Open decision (PRD §4a):** per-service flag — start reshoots at *Awaiting RAW* while
  already-finished deliverables (floorplan/video/copy links in the payload) attach immediately.

### 6.6 Capture ingest, file counts & Dropbox sync
- **Manual upload:** **direct-to-R2 multipart** with presigned URLs (the *only* large-file
  path — Worker request bodies are capped at 100 MB Free/Pro, 200 MB Business), **resumable**
  with checksum validation; metadata to D1; stage → *RAW review*.
- **Dropbox sync:** a Queue/Workflow consumer streams the folder **file-by-file** (avoids
  Worker time limits), idempotent by `content_hash`, with explicit **conflict/version
  semantics** (renames, duplicate names, revised edits, deletions → immutable asset versions).
- **File-count verification:** `expected_count` from the Dropbox folder-name convention
  (input/output counts) vs. `received_count`; mismatches flagged in the UI ("upload 18 → see 18").
- **Rating metadata:** read the JPEG's embedded star rating (XMP/IPTC) at ingest into
  `rating_from_metadata`, so on-site culling drives selection from the start (meeting decision).

### 6.7 autoHDR handoff (Workflow + Dropbox webhook)
- A **Workflow** owns the round-trip: copy selected JPEGs to the autoHDR-watched Dropbox
  folder → mark *Editing·autoHDR* → **receive returned edits via a Dropbox webhook** (not
  polling) → ingest as Edited → *Edited review*. Includes explicit **timeout, manual retry,
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
  critical flows (intake → ingest → select → autoHDR → publish → client download/unlock).
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

Replace Pixieset first (value, low risk), then internalise the pipeline.

- **Phase 0 — Foundations.** 3-Worker skeleton, D1 schema + migrations, R2 buckets + versioning,
  Access, CI/CD, DS integration, observability/audit baseline.
- **Phase 1 — Client delivery + thin admin back-office (Pixieset replacement).** Publish model,
  signed client links, gallery, favourites, downloads (stream + cached zip), ingest renditions,
  premium watermark — **plus a minimal admin upload/publish screen** so delivery is usable
  before full intake exists. Ship to real clients.
- **Phase 2 — Intake + dashboard.** Tonomo `order.created`/`order.updated`, dashboard
  (grid/list/kanban), capability-based role gating.
- **Phase 3 — Capture pipeline.** Upload + Dropbox sync, file-count verification, rating-metadata
  ingest, RAW QA (ratings/labels/markup/compare/recommend), **select-for-editing** gate.
- **Phase 4 — autoHDR + Edited QA.** Workflow + Dropbox-webhook handoff, Edited ingest, Edited QA,
  publish from Edited, RAW↔Edited compare.
- **Phase 5 — Video + copy + extras.** Cloudflare Stream uploads, in-portal copy + social,
  floorplan versioning, stage notifications.

**Launch gates (must pass before each client-facing release):** auth + capability authorization,
ingest correctness + file-count verification, paywall enforcement, audit log, and backup/restore —
treated separately from "prototype parity" features (kanban drag, compare polish, etc.).

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

Build Quincy Portal as **three cooperating Cloudflare Workers** (Vite SPA + Hono API) over
**D1 + R2**, with **ingest-time rendition generation**, **Queues/Workflows** for the media
pipeline, **Cloudflare Access** for staff and **signed links** for clients. Treat the JPEG-only
ingest, paywall enforcement, file-count verification, and backup/restore as launch gates. It
satisfies the PRD, respects Cloudflare's real limits, matches the media-heavy/low-cost
constraint, and extends the Cloudflare direction the repo already targets. Start with client
delivery (plus a thin admin back-office) to retire Pixieset, then internalise the pipeline.

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
| 12 | Single Worker over-concentrated (Codex) | P1 | Split into delivery / app-API / background Workers (§6.2) |
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
| 23 | Phase order needs thin admin back-office in Phase 1 (Codex) | P2 | Added to Phase 1 (§9) |
| 24 | No notification plan (Codex) | P2 | Basic stage notifications in Phase 5 (§9) |
| 25 | Separate prototype parity from launch hardening (Codex) | P2 | Explicit **launch gates** (§9) |
| 26 | RAW↔Edited compare needs matched web JPEGs (agy) | P2 | Provided by ingest renditions (§6.4) |
| 27 | *Self:* rating metadata from JPEG; file-count verification; manual bracketing (meeting) | — | Added as first-class requirements (§2, §5, §6.6) |
