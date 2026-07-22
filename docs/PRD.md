# Quincy Portal — Product Requirements Document (PRD)

> **Status:** Draft v0.3 · 21 July 2026
> **Owner:** _✏️ your name_
> **Prototype:** `index.html` (live React prototype)

---

## How to use this document

This is a **working brief**, not a contract. Edit it freely — that's the point.

- Anywhere you see **`✏️ NEEDS INPUT`**, I need a decision or detail from you.
- Change any wording, add requirements, strike things you don't want.
- Status tags tell you where the prototype stands today:
  - ✅ **Built** — exists in the current prototype
  - 🔶 **Partial** — partly there, needs work
  - ⬜ **New** — described but not yet built
- When you hand the file back, I'll update the prototype to match.

---

## 1. Summary

The **Quincy Portal** replaces Quincy Productions' Pixieset site. It is **one connected
portal** that runs the full media pipeline for a property shoot — from RAW capture,
through internal QA and editing, to the final client delivery gallery.

It serves two audiences from one system:
1. **Internal team** (admin, photographers, editors/QA) — produce and review work.
2. **Clients** (real-estate agents & agencies) — receive and download final media.

### Problem we're solving
- Pixieset only does **delivery** — there is no internal review or production pipeline.
- RAW selection, editing handoff (autoHDR), and QA happen in scattered tools / email.
- We need approvals, annotations, and a clean "review → publish" handoff in one place.

---

## 2. Goals & non-goals

### Goals
- ✅ A single portal covering **review → publish → deliver**.
- ✅ **Role-based access** so each person sees only what they should.
- ✅ A clear **RAW → autoHDR → Edited** production flow with selection gates.
- ✅ Editorial, on-brand client galleries (Quincy Productions design system).
- ✅ Frictionless client delivery — **no login**, private link, download + favourites.

### Non-goals (for now)
- Billing, invoicing (the premium-content paywall is a simulated checkout only).
- Full RAW developing / editing inside the portal (autoHDR is the external editor).
- A native mobile app (the web app is responsive instead).
- Client accounts / persistent client logins.

---

## 3. Personas (summary)

Full detail in **`Personas.md`**. Three internal roles + the external client.

| Persona | One-line | Access |
|---|---|---|
| **Project Manager / Admin** | Runs projects end-to-end, manages people & delivery | Everything |
| **Photographer** | Uploads RAW, annotates RAW | **RAW only** — nothing else |
| **Photo Editor / QA Officer** | Selects RAW for editing, QA's edits, publishes to client | RAW + Edited + Publish |
| **Client (Agent)** | Receives & downloads final media | Client delivery page only |

---

## 4. Roles & permissions matrix  ✅ Built

> Implemented in the prototype via the **"View as" switcher** (Admin / Photographer /
> Editor & QA / Client), with each role gated to the screens and actions below.

| Capability | Admin | Photographer | Editor / QA | Client |
|---|:--:|:--:|:--:|:--:|
| See all projects (dashboard) | ✓ | ✗ _(only assigned)_ | ✓ | ✗ |
| Create / edit / archive a project | ✓ | ✗ | ✗ | ✗ |
| Manage users & roles | ✓ | ✗ | ✗ | ✗ |
| **Upload RAW images** | ✓ | ✓ | ✓ | ✗ |
| Comment / annotate **RAW** | ✓ | ✓ | ✓ | ✗ |
| View **RAW** images | ✓ | ✓ | ✓ | ✗ |
| Recommend RAW frames (suggest to QA) | ✓ | ✓ | ✓ | ✗ |
| **Select RAW for editing** | ✓ | ✗ | ✓ | ✗ |
| **Execute AutoHDR handoff** | ✓ | ✗ | ✗ | ✗ |
| View / QA **Edited** images | ✓ | ✗ | ✓ | ✗ |
| Comment / annotate **Edited** | ✓ | ✗ | ✓ | ✗ |
| Compare images side-by-side | ✓ | ✓ | ✓ | ✗ |
| Manage **videos / floorplans / copywriting** | ✓ | ✗ | ✓ | ✗ |
| **Publish to client delivery page** | ✓ | ✗ | ✓ | ✗ |
| View client delivery page | ✓ | ✗ | ✓ | ✓ |
| Download final media | ✓ | ✗ | ✓ | ✓ |
| **Access Admin backend dashboard** (users, project CRUD/archive, agencies/agents, pipeline config, integrations) | ✓ | ✗ | ✗ | ✗ |

**Resolved decisions:**
- A Photographer **cannot** see the client delivery page — they are scoped to RAW on their assigned shoots only.
- **Project creation is Admin-only.** Editor/QA work within projects Admin sets up.
- **Video, floorplan and copywriting** can be managed by **both Admin and Editor/QA** (`canManageExtras`).
- **AutoHDR is an internal, Admin-only workflow.** Editor/QA can select RAWs for editing, but only Admin can execute the AutoHDR handoff. Non-admin staff see the neutral **Editing** stage and status; AutoHDR's name, provider details, watch-folder details, and handoff metadata are not part of their API projections. This privacy boundary must be enforced by API authorization and response projection, not by hiding controls in the UI.

---

## 4a. Project intake — Tonomo webhook  ✅ Built

Quincy takes bookings in **Tonomo**. When an order is created there, Tonomo fires a
webhook to the portal, which **creates the matching project automatically** — no
manual re-keying.

- **Trigger:** `POST /webhooks/tonomo/order.created` with the order payload
  (sample in `uploads/Webhook-data.md`).
- **Mapping** (Tonomo → Quincy project):

  | Tonomo field | → Quincy project |
  |---|---|
  | `property_address.street / city / zipcode` | address (street · suburb · postcode) |
  | `bookingFlow.name` | client / agency |
  | `listingAgents[0]` | agent name · email · phone |
  | `when.start_time` · `scheduled_time` | shoot date · time window |
  | `photographers[]` | assigned shooter(s) |
  | `services_a_la_cart` | ordered deliverables (photos / video / floorplan / copy) |
  | `invoice_amount` · `paymentStatus` | order value · payment state |
  | `property_feature_notes` · `entry_notes` · site-agent question | shoot notes |
  | `orderNo` · `orderId` | booking reference (kept on the project) |

- **Result:** a new project is created at **Awaiting RAW**, pre-filled with all the
  booking detail (shown in the project rail) and the right empty collections for the
  services ordered. RAW then arrives by **manual upload** or **Sync from Dropbox** —
  and if the Tonomo order carried a `rawFolderLink` / `rawFolderPath`, that Dropbox
  folder is pre-filled into the sync action (one click to pull the frames).
- **Prototype behaviour:** the admin **New shoot** button simulates an incoming
  webhook — it shows the received payload mapped to a project preview (with the raw
  JSON viewable) and a **Create project** action. In production this fires
  automatically on the webhook; no human step is required.
- ✏️ **NEEDS INPUT / planned:** auto-ingest deliverables too (Tonomo's payload already
  carries Dropbox/links for finished photos, video, floorplan & copywriting PDF — we
  could attach those to the project automatically rather than waiting on RAW upload).
  Confirm whether a Tonomo order should create a project at *Awaiting RAW* (current)
  or land already-delivered assets straight into the **Edited / Video / Floorplan /
  Copy** collections.

---

## 5. The production pipeline  🔶 Partial → ⬜ New

The portal models a shoot moving left-to-right through stages. **Selection gates**
between stages are where QA happens.

```
  ┌────────────┐   ┌──────────────┐   ┌───────────────┐   ┌───────────────┐   ┌──────────────┐
  │ 1. CAPTURE │ → │ 2. RAW QA    │ → │ 3. EDITING    │ → │ 4. EDITED QA  │ → │ 5. DELIVERY  │
  │ Photographer│   │ Editor / QA  │   │ autoHDR (ext.)│   │ Editor / QA   │   │ Client        │
  └────────────┘   └──────────────┘   └───────────────┘   └───────────────┘   └──────────────┘
   upload RAW,      review RAW,         selected RAWs       review returned     publish approved
   annotate         compare, select     auto-edited         edits, approve      images, video,
                    RAWs for editing                        / flag              floorplan, copy
```

### Stage detail

**1. Capture / RAW upload** ✅ Built
- RAW frames reach a project two ways:
  - **Manual upload** — Photographer / Admin / Editor drops RAW or image files (any format, no size limit) onto the project.
  - **Sync from Dropbox** — a one-click pull of the RAW frames from the shoot's Dropbox folder. The folder link/path can be **pasted manually** or **carried over automatically from the Tonomo booking** (`rawFolderLink` / `rawFolderPath` in the webhook). Syncing populates the RAW collection and moves the project into **RAW review**.
- Photographers annotate / comment on RAWs and **recommend** their picks to guide QA.
- **Accepted files:** any RAW or image file — **no format or size limit**. Bracketed sets are **not** grouped automatically; the editor brackets them manually during selection.
- ⬜ **Embedded star rating ingest.** Photographers cull on-site in Lightroom before export, applying a 1–5 star rating per frame. On upload/sync, the Portal **reads that rating from the JPEG's embedded XMP metadata** (`xmp:Rating`) and pre-populates the frame's star rating in RAW QA automatically — no re-rating by hand. An un-rated export (no `xmp:Rating` attribute present) shows as unrated, not zero-starred-by-default. QA can still override any rating manually; the metadata read only sets the *starting* value. Validated against 44 real studio export JPEGs (2.9–28 MB) — see `Implementation-Plan.md` §2 A2.

**2. RAW QA & selection** ✅ Built
- Editor/QA reviews all RAWs, compares similar frames, annotates, and sees photographer recommendations.
- Editor/QA **selects** (a state separate from approve) the RAWs that should be edited, then sends them to autoHDR.

**3. Editing — internal handoff** ✅ Built
- The Admin-only AutoHDR workflow copies selected RAWs to a Dropbox folder that AutoHDR monitors; AutoHDR retouches them automatically.
- Non-admin staff see this stage and its progress using the neutral **Editing** label. AutoHDR-specific provider and handoff details are admin-only and must be omitted from non-admin API responses, not merely hidden in the UI.
- Edited images come back into the project as the **Edited** set, shown with a "Processing → Returned" status.
- _Planned:_ sending images directly to AutoHDR via API (not implemented yet).

**4. Edited QA** ✅ Built
- Editor/QA reviews the edited images, approves / flags, rates, labels, annotates.
- _Open:_ whether to show **RAW vs Edited** of the same frame side-by-side in compare. ✏️ confirm.

**5. Delivery / publish** ✅ Built
- Editor/QA (or Admin) publishes approved **images, videos, floorplans, copywriting** to the client delivery page.
- Client opens a private link, browses, favourites, downloads.

---

## 6. Feature requirements by area

### 6.1 Dashboard (internal home) ✅ Built
- ✅ All projects as cards / list, with pipeline status, progress, agency/agent, search, filters.
- ✅ Dashboard filters **by the viewer's role** — photographers see the **same dashboard but only their assigned shoots** ("My shoots").
- ✅ Status reflects the new pipeline stages (see §7).
- ✅ **Three views:** Grid · List · **Kanban**. The Kanban has one column per pipeline stage (Awaiting RAW → Delivered); Admin / Editor can **drag a project card between columns to change its stage**. Photographers get a read-only, reduced-column Kanban.

### 6.2 Project workspace ✅ Built
- ✅ Per-project rail (client, agent, shoot date, photographer, collections, filters, labels).
- ✅ Collection tabs: **RAW · Edited · Floorplan · Copy · Video.**
- **Web & Print** sizes are **not** separate tabs — they're derived from the selected images published to the client page, with **Cloudflare Images** generating the smaller renditions on the fly.

### 6.3 Review tools ✅ Built
- ✅ Grid with approve / flag, **star ratings**, **colour labels**, comment counts.
- ⬜ **Star ratings on RAW frames are pre-populated from the photographer's on-site Lightroom culling** (embedded XMP metadata read at ingest, §5 stage 1) rather than starting blank; QA can re-rate freely from there. Edited-collection ratings remain purely QA-assigned (autoHDR output doesn't carry a meaningful rating of its own).
- ✅ **Freehand markup** (paint-style drawing) on a frame, attached to a note. _(replaced pin notes)_
- ✅ Lightbox with filmstrip, keyboard shortcuts (A approve, X flag, 1–5 rate, ⌘Z undo).
- ✅ **Compare** two frames side-by-side.
- ✅ **Bulk** select → approve / flag / label (and photographer **recommend**).
- ✅ "**Select for editing**" — a **separate state** from approve, gating RAW → autoHDR.

### 6.4 Videos ✅ Built (Vimeo)
- ✅ Films delivered as **Vimeo links**, shown as tiles with poster + a player modal; publishable to the client page; can be flagged premium/paywalled.
- _Planned:_ direct upload to Quincy Portal (Cloudflare backend), with **timestamped freehand annotation** and the same approve/comment review flow as photos.

### 6.5 Floorplans 🔶 Partial
- ✅ Floorplan collection exists (schematic placeholder).
- ⬜ Upload real floorplan (PDF + JPG), versioning. ✏️ confirm needs.

### 6.6 Copywriting ✅ Built (PDF)
- ✅ A per-project **downloadable PDF**, uploaded by the **project admin**, surfaced on the internal Copy tab and the client "Description" tab.
- _Planned:_ entering &amp; displaying copywriting directly in the Portal, plus delivering **social-media content** to the client alongside the copy.

### 6.7 Client delivery page ✅ Built
- ✅ Editorial cover hero, collection tabs (Gallery / Film / Floorplan / Description), favourites, slideshow, share, download (web/full-res, single + zip).
- ✅ **Video** and **Copywriting** sections on the delivered page.
- ✅ **Premium / paywalled content** — extra images & video shown **watermarked** behind a paywall; client unlocks to remove the watermark and download. _(replaces the former print store)_
- ✅ No login — private link. ✏️ confirm: link expiry, optional passcode?

### 6.8 Annotations & comments ✅ Built
- ✅ Threaded notes per image, freehand drawing, author + role + timestamp.
- ⬜ Notes should be **role-aware** (photographer's RAW notes vs QA's edit notes) and scoped to RAW or Edited.

### 6.9 Admin backend dashboard ⬜ New
A dedicated **Admin Settings** area, separate from the project workspace, for backend
and operational management. **Admin-only** (per §4 capabilities model).

- ⬜ **Users:** create / edit / deactivate staff accounts; assign roles & capabilities.
- ⬜ **Projects:** full CRUD outside the normal pipeline flow — edit any field or
  **archive** a project — for corrections and cleanup. **Archive-only, no hard-delete**,
  to stay consistent with the immutable-asset-version model used elsewhere (§6.6/§6.10 of
  `Implementation-Proposal.md`); an archived project is hidden from active dashboards/lists
  but its data and assets are retained and can be restored.
- ⬜ **Agencies / agents directory:** CRUD for client agencies and agents, so a shoot can
  be linked to an existing record instead of re-entering free-text contact details each
  time (agencies/agents currently arrive as free-text fields off the Tonomo webhook — see
  §4a).
- ⬜ **Pipeline configuration:** edit the pipeline stage labels/settings from §7 (e.g.
  rename a stage, change ordering) without a code change.
- ⬜ **Integrations:** a connections screen showing status (Connected / Expired / Error)
  for each external service, with a **Reconnect** action for OAuth refresh:
  - **Dropbox** — one **shared studio-level** OAuth connection, used for all RAW sync and
    the autoHDR watch folder (not a per-project or per-user connection — see §6.6/§6.7 of
    `Implementation-Proposal.md`).
  - Tonomo webhook status (last event received, signing key rotation).
  - Vimeo account connection.
---

## 7. Pipeline statuses  ✅ Built

Implemented stages, shown on the dashboard and project rail:

| Stage | Status label | Meaning |
|---|---|---|
| 1 | **Awaiting RAW** | Project created, no RAW uploaded yet |
| 2 | **RAW review** | RAW uploaded, QA selecting |
| 3 | **Editing** | Selected RAWs are in the internal admin-only AutoHDR workflow; non-admin API projections expose only the neutral stage/status |
| 4 | **Edited review** | Edits returned, QA reviewing |
| 5 | **Client review** | Published to client _(optional gate)_ |
| 6 | **Delivered** | Final media delivered |

---

## 8. Tech stack & architecture  ✅ Built (production `portal/`)

> This section describes the **production application** in `portal/` — a TypeScript
> monorepo running entirely on Cloudflare. It is a **summary**; the authoritative
> architecture and phase plan live in **`Implementation-Plan.md`** (§4 target
> architecture, §5 data model), which overrides this section on any conflict. The
> `prototype/` app (React via CDN + in-browser Babel, mock data, no backend) is
> **reference-only** and is not the production stack described here.

### 8.1 Stack at a glance

| Layer | Technology | Version | Notes |
|---|---|---|---|
| **Frontend** | React + React-DOM | 18.3.1 | SPA, no framework router (state-based routing) |
| Build / dev | Vite + `@vitejs/plugin-react` | 8.1.5 / 6.0.3 | `@cloudflare/vite-plugin` for Worker-aware dev |
| Language | TypeScript | 7.0.2 | strict; every workspace typechecks in CI |
| **API / backend** | Hono | 4.12.31 | runs on Cloudflare Workers |
| Auth | better-auth (+ Google provider) | 1.6.23 | sessions in D1 + KV; closed/allow-listed signup |
| ORM / schema | Drizzle ORM + drizzle-kit | 0.45.2 / 0.31.10 | typed D1 schema + SQL migrations |
| Validation | Zod | 3.25.76 | request/webhook payload parsing |
| R2 signing | aws4fetch | 1.0.20 | presigned S3-API multipart uploads |
| **Runtime / infra** | Cloudflare Workers · D1 · R2 · KV · Queues · Workflows · Durable Objects · Image Transformations | — | see §8.3–8.5 |
| Tooling | Wrangler · Vitest + `@cloudflare/vitest-pool-workers` | 4.112.0 / 4.1.10 | tests run in the Workers runtime |

Dependencies are **hoisted to the monorepo root** and pinned; workspaces don't install
their own copies.

### 8.2 Monorepo layout (`portal/`)

Six npm workspaces — three deployable Workers, one SPA, two shared libraries:

| Workspace | Package | Role |
|---|---|---|
| `apps/web` | `@quincy/web` | Vite + React 18 SPA — the staff UI (dashboard, workspace, review lightbox, admin). |
| `workers/app` | — | **Staff API** (Hono) + better-auth; also **serves the built SPA**; issues signed image-transform URLs. |
| `workers/background` | — | Queue consumers, **Workflows** (autoHDR round-trip), and the **Dropbox-sync + Tonomo-processor Durable Objects**. |
| `workers/webhook-ingress` | — | Thin **public** webhook receiver (Dropbox + Tonomo): verifies signatures, dedupes, fast-acks, hands off via service binding. |
| `packages/shared` | `@quincy/shared` | Single source for capabilities, pipeline stage keys, JPEG/media ingest rules, XMP star-rating parser, AES-GCM credential crypto. |
| `packages/db` | `@quincy/db` | Drizzle D1 schema, migrations (0000–0003 applied to prod), seed. |

### 8.3 Runtime architecture

```
                    ┌───────────── Tonomo ─────────────┐         ┌── Dropbox ──┐
                    │ order.created/updated + links     │         │ file change │
                    └───────────────┬───────────────────┘         └──────┬──────┘
                    signed POST /webhooks/tonomo           signed POST /webhooks/dropbox
                                    ▼                                    ▼
 Client ── signed link (Ph 5) ──►  ┌───────────────────────────────────────────┐
 (no login, public)                │  PUBLIC Worker — webhook-ingress            │
                                   │  HMAC verify · dedupe · fast-ack            │
                                   └───────────────────┬─────────────────────────┘
                                                       │ service bindings (RPC)
 Staff ── Google OAuth ─────────►  ┌────────────────────▼────────────────────────┐
 (better-auth: D1 + KV sessions)   │  APP / API Worker (staff)                    │
                                   │  Hono · better-auth · serves SPA             │
                                   │  R2-read → signed /cdn-cgi/image transform    │
                                   └──┬────────┬────────┬────────┬────────────────┘
                                      │        │        │        │ service binding
                                 ┌────▼─┐ ┌────▼─┐ ┌────▼──┐ ┌───▼──────────────────┐
                                 │  D1  │ │  R2  │ │Queues │ │  BACKGROUND Worker    │
                                 │ meta │ │media │ │(ingest)│ │  Queue consumers      │
                                 └──────┘ │(priv)│ └───┬───┘ │  Workflows (autoHDR)  │
                                          └──▲───┘     │     │  DropboxSyncDO (alarm)│
                            Image Transformations      │     │  TonomoProcessorDO    │
                            (remote path, ~100 MB;     └─────┤  → Dropbox API        │
                             resize in CF infra)             └───────────────────────┘
                                                                       ▲
                                                        autoHDR watches Dropbox folder
```

- **No 5th compute surface for images** — renditions use the **remote Image
  Transformation path** (`/cdn-cgi/image/…`, ~100 MB limit), not a Container. The app
  Worker issues **HMAC-signed transform-source URLs** so the public transform endpoint
  can read the private R2 original. (Signatures are currently unexpiring — a known
  hardening item.)
- **Client-side loading** is concurrency-limited (`LazyImage`, module-level semaphore)
  so a grid of large originals can't stampede Cloudflare edge rate-limits.
- **Deploy order matters** (service bindings resolve at deploy time):
  **background → webhook-ingress → app**; Phase 5 adds a `client-delivery` Worker last.

### 8.4 Data & storage (Cloudflare primitives)

| Primitive | Resource | Holds |
|---|---|---|
| **D1** (SQLite) | `quincy-portal` | All relational metadata — projects, assets, collections, selections, ratings/labels/decisions, comments, annotations (strokes → R2), publishes, `webhook_events`, `jobs`, `audit_log`, auth tables, `integration_connections`, `pipeline_stages`, agencies/agents. |
| **R2** | `quincy-portal-media` | Original media (private), edited assets, annotation stroke JSON, PDFs, cached renditions. **Immutable** — edits/deletes write new keys; old objects retained. Bucket versioning on. |
| **KV** | `quincy-portal-sessions` | better-auth session store (with D1). |
| **Queues** | `quincy-ingest` | Ingest / processing jobs (consumed by the background Worker). |
| **Workflows** | — | Durable multi-step autoHDR round-trip (selected RAW → Dropbox → returned edits). |
| **Durable Objects** | `DropboxSyncDO`, `TonomoProcessorDO` | Fixed-ID, single-writer serialization: Dropbox cursor sync (alarm-driven) and FIFO Tonomo event processing with poison-event operator queue. |

### 8.5 Auth, capabilities & security

- **Staff auth:** better-auth with **Google OAuth only** (D-14) — closed, allow-listed
  signup; deactivated users are locked out and sessions revoked. Sessions persist in
  **D1 + KV**. (Cloudflare Access was dropped in favour of owned auth.)
- **Capability model:** roles → capabilities (`uploadRaw`, `selectForEditing`,
  `viewEdited`, `manageExtras`, `publish`, `adminBackend`, …) in a **`role_capabilities`
  table**, enforced by capability middleware on API routes. `@quincy/shared` is the
  single source for these keys.
- **Credential encryption:** external-integration tokens (Dropbox) are stored
  **AES-GCM encrypted** under an `INTEGRATION_KEK` Worker secret — never in plaintext.
- **Webhook integrity:** constant-time HMAC verification (Dropbox `X-Dropbox-Signature`;
  Tonomo bearer token), dedupe by event id, fast-ack.
- **Audit integrity:** every mutation is audit-logged; comment/annotation **edit &
  delete are author-only** (admins are *not* exempt); media is never destructively
  deleted.

### 8.6 External integrations

- **Dropbox** — one **shared studio-level** OAuth connection (not per-user/per-project),
  used for RAW sync and the autoHDR watch folder; Business team-space aware
  (`Dropbox-API-Path-Root`); needs `sharing.read` for `scl/fo/…` shared-link folders.
- **Tonomo** — booking webhooks auto-create pre-filled projects at *Awaiting RAW*
  (§4a); DO-serialized processing.
- **autoHDR** — internal, **Admin-only** editing workflow that watches a Dropbox folder; integration is via Dropbox today (direct API is planned). Non-admin API projections use the neutral **Editing** label and omit provider, folder, and handoff details; authorization and projection are enforced at the API boundary, independently of UI visibility.
- **Vimeo** — films delivered as links/tiles (direct upload planned).

### 8.7 Environments & delivery

| Environment | Host | Notes |
|---|---|---|
| Production | `quincy.flamingfire.my` | Live. `main` is the source of truth. |
| Staging | `staging.quincy.flamingfire.my` | Pre-prod (shares a single `APP_ORIGIN` for OAuth). |
| Prototype | `prototype.quincy.flamingfire.my` | The old design prototype, reference-only. |

CI (`.github/portal.yml`) typechecks every workspace, runs the Vitest suites
(`packages/shared`, `workers/app`, `webhook-ingress`) in the Workers runtime, and builds
the SPA. Secrets are **Worker secrets** in prod; local dev reads gitignored
`.dev.vars`. Deploys run in the fixed **background → webhook-ingress → app** order.

---

## 9. Open questions (remaining)

The decisions resolved in v0.2 have been folded into the sections above. Still open:

1. **Edited QA:** show **RAW-vs-Edited** pairs side-by-side in compare? (§5 stage 4)
2. **Floorplans:** confirm upload needs — PDF + JPG, versioning? (§6.5)
3. **Client link:** expiry window and optional passcode? (§6.7)
4. **Client approval:** does the agent ever **review/approve** media, or only receive it? Your original brief mentioned "review before publish to end client" — confirm whether to (re)introduce a client/guest-reviewer step.

---

## 10. Out of current prototype scope / parked

- Real payment processing for premium unlocks (currently a simulated checkout).
- Notifications (email/SMS) on stage changes.
- Analytics (client opens, downloads).
- Audit log / version history.

_✏️ Move anything here into scope by noting it._
