# Quincy Portal — Product Requirements Document (PRD)

> **Status:** Current product requirements + approved revamp targets · 24 August 2026
> **Owner:** _✏️ your name_
> **Production:** `portal/` at <https://quincy.flamingfire.my> · React 19.2.8 current baseline
> **Design authority:** `portal/apps/web/src/styles/` (the `prototype/` app was retired in #48;
> its export is archived under `docs/archive/`, historical and not authoritative)

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

The approved revamp is an incremental program, not a rewrite. Its planned outcomes cover the
React 19.2 compatibility release, Quincy-owned freshness/discussion/notification boundaries,
canonical Project Workspace coordination, additive checklist scheduling, assigned-scope External
Editor access, corrected Stage/Kanban semantics, and a third-view Production Calendar. These are
targets for their owning tracer bullets; they are not live merely because they are described here.

---

## 1. Summary

The **Quincy Portal** replaces Quincy Productions' Pixieset site. It is **one connected
portal** that runs the full media pipeline for a property shoot — from RAW capture,
through internal QA and editing, to the final client delivery gallery.

It serves two audiences from one system:
1. **Internal team** (admin, photographers, editors/QA) — produce and review work.
2. **Clients** (real-estate agents & agencies) — receive and download final media.

The planned External Editor role is an additional internal-production persona for assigned
contractors. It does not create a client account or broaden the client-delivery surface.

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

### Approved incremental revamp outcomes (planned, not live)

- Preserve deep routes, Quincy-owned Cloudflare data, current working behavior, and the Admin-only
  direct send-only AutoHDR boundary while modernizing each domain incrementally.
- Make the Project Workspace left rail the canonical home for Stage, project Deadline/reminders,
  Photographers, and Editors; keep Collaboration task/checklist/discussion-focused.
- Add an additive checklist due/range contract and a server-authorized Production Calendar
  projection with guarded, accessible direct manipulation.
- Add assignment-scoped `external_editor` access through one external-safe server projection, with
  no Notice Board, global directory, Admin, delivery/publish, RAW-selection, or extras scope.

### Non-goals (for now)
- Billing, invoicing (the premium-content paywall is a simulated checkout only).
- Full RAW developing / editing inside the portal (autoHDR is the external editor).
- A native mobile app (the web app is responsive instead).
- Client accounts / persistent client logins.

---

## 3. Personas (summary)

Full detail in **`Personas.md`**. Four internal-production roles + the external client.

| Persona | One-line | Access |
|---|---|---|
| **Project Manager / Admin** | Runs projects end-to-end, manages people & delivery | Everything within Admin capability policy |
| **Photographer** | Uploads RAW, annotates RAW | **RAW only** on assigned projects |
| **Photo Editor / QA Officer** | Selects RAW for editing, QA's edits, publishes to client | RAW + Edited + Publish |
| **External Editor** *(planned)* | Performs assigned production/editing work as a contractor | Explicit assigned-project allow-list only; no broad/Admin/Notice Board/delivery scope |
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
- **Default editors (#135).** An Admin can mark users as default editors on Admin → Users. Every Project created afterwards, by hand or from Tonomo, gets each active, editor-eligible default editor as an `editor` member, with the normal assignment notification. It is applied only at creation: removing a default editor from one Project sticks, restoring an archived Project adds nobody, and default editors play no part in the Editor Dropbox folder prerequisite (an active Photographer). Existing Projects were covered by a one-off, silent backfill (one audit row per Project).
- **Video, floorplan and copywriting** can be managed by **both Admin and Editor/QA** (`canManageExtras`).
- **AutoHDR is an internal, Admin-only workflow.** Editor/QA can select RAWs for editing, but only Admin can execute the AutoHDR handoff. Non-admin staff see the neutral **Editing** stage and status; AutoHDR's name, provider details, watch-folder details, and handoff metadata are not part of their API projections. This privacy boundary must be enforced by API authorization and response projection, not by hiding controls in the UI.

### Planned External Editor role (not live)

External Editor is a distinct global account role, displayed **External editor**, while project
membership remains the existing `editor` role. Every project surface requires current explicit
assignment and server-side scope; External Editors never receive `viewAllProjects`, have no
Photographer Stage restriction, and cannot use ordinary archived-project surfaces.

The complete allow-list is `uploadEdited`, `viewRaw`, `annotateRaw`, `recommendRaw`,
`compareFrames`, `viewEdited`, `reviewEdited`, `annotateEdited`, and `collaborateOnProject`, plus
`moveProjectStage` when TB5A ships and `viewProductionCalendar` when TB5C ships. Withhold
`publish`, `viewClientPreview`, `downloadFinal`, `manageExtras`, `selectForEditing`, `uploadRaw`,
`viewNoticeBoard`, project create/edit/archive, Admin/user/directory/integration/pipeline/
prioritization, AutoHDR send, and provider/job diagnostic capabilities.

On assigned projects, the shared server-side external-safe projection may expose production-safe
address/location, Agency/Agent display names, shoot date/time, Stage, Deadline,
services/deliverables, `productionNotes`, approved production media, checklist, discussion, roster
identity, and project-participant email. It excludes internal `projects.notes`, agent/client
contact, invoice/payment and unnecessary order data, agency-directory notes, Dropbox topology,
provider credentials/diagnostics, Admin data, and unrelated people/projects. `productionNotes` is a
distinct planned field; existing `notes` remains internal and is never copied into it.

Existing users are never auto-converted. Role changes revoke sessions; conversion is blocked while
incompatible Photographer memberships exist. Deactivation preserves membership history but blocks
authentication, new assignment, and pending delivery. Final membership removal warns about
immediate access loss and atomically applies approved checklist cleanup. Access loss purges
inaccessible cached project data and closes project-specific UI. Project discussion remains one
shared thread, and External Editors do not receive the staff Notice Board or a global directory.

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
- **Accepted files:** JPEG-only ingest (`.jpg` / `.jpeg`) per D-01; camera RAW remains with the photographer and is never uploaded. Bracketed sets are **not** grouped automatically; the editor brackets them manually during selection.
- ⬜ **Embedded star rating ingest.** Photographers cull on-site in Lightroom before export, applying a 1–5 star rating per frame. On upload/sync, the Portal **reads that rating from the JPEG's embedded XMP metadata** (`xmp:Rating`) and pre-populates the frame's star rating in RAW QA automatically — no re-rating by hand. An un-rated export (no `xmp:Rating` attribute present) shows as unrated, not zero-starred-by-default. QA can still override any rating manually; the metadata read only sets the *starting* value. Validated against 44 real studio export JPEGs (2.9–28 MB).

**2. RAW QA & selection** ✅ Built
- Editor/QA reviews all RAWs, compares similar frames, annotates, and sees photographer recommendations.
- Editor/QA **selects** (a state separate from approve) the RAWs that should be edited, then sends them to autoHDR.

**3. Editing — internal handoff** ✅ Built
- The Admin-only explicit handoff uploads the selected RAW-review JPEGs directly to AutoHDR using provider-issued presigned URLs, then finalizes the photoshoot so processing can begin.
- Non-admin staff see this stage and its progress using the neutral **Editing** label. AutoHDR-specific provider and handoff details are admin-only and must be omitted from non-admin API responses, not merely hidden in the UI.
- This API integration is intentionally send-only: Quincy Portal supplies no completion callback, does not poll AutoHDR processing status, and never fetches or retrieves the edited photos. Existing manual and legacy edited-media paths remain separate from this handoff.
- Manual Stage movement is a separate operation and never starts, cancels, or retrieves AutoHDR work. The fixed semantic progression is `awaiting_raw → raw_review → editing_autohdr → edited_review → delivered`; display order never changes those identities.

**4. Edited QA** ✅ Built
- Editor/QA reviews the edited images, approves / flags, rates, labels, annotates.
- _Open:_ whether to show **RAW vs Edited** of the same frame side-by-side in compare. ✏️ confirm.

**5. Delivery / publish** ✅ Built
- Editor/QA (or Admin) publishes approved **images, videos, floorplans, copywriting** to the client delivery page.
- Client opens a private link, browses, favourites, downloads.

---

## 6. Feature requirements by area

### 6.1 Dashboard (internal home) ✅ Built in current production; Calendar planned
- ✅ All projects as cards / list, with pipeline status, progress, agency/agent, search, filters.
- ✅ Dashboard filters **by the viewer's role** — photographers see the **same dashboard but only their assigned shoots** ("My shoots").
- ✅ Status reflects the new pipeline stages (see §7).
- ✅ **Current production views:** **Kanban** (default) · List. The Kanban has one column per pipeline stage (Awaiting RAW → Delivered); Admin / Editor can **drag a project card between columns to change its stage**. Photographers get a read-only, reduced-column Kanban. The archived dashboard is List-only.
- ⬜ **Planned third view:** Calendar, after its checklist/Deadline, authorization, freshness, and interaction prerequisites ship. It will support Month, Week, and Agenda, typed shareable URL/filter state, authorized Project/Checklist event layers, and guarded direct manipulation; it is not live in the current production dashboard.

### 6.2 Project workspace ✅ Built; coordination rail target planned
- ✅ Per-project rail (client, agent, shoot date, photographer, collections, filters, labels).
- ✅ Collection tabs: **RAW · Edited · Floorplan · Copy · Video.**
- ⬜ **Planned canonical coordination:** the left rail owns Stage, project Deadline/reminders, Photographers, and Editors. Collaboration remains focused on checklist/subtasks, project discussion, and task-level collaboration.
- **Web & Print** sizes are **not** separate tabs — they're derived from the selected images published to the client page, with **Cloudflare Images** generating the smaller renditions on the fly.

### 6.2a Production Calendar and scheduling (planned, not live)

The approved Schedule half of D-13 becomes a third Dashboard view only after its prerequisite
tracer bullets ship. Calendar is a projection over authorized project and checklist data, not a
new source of truth.

- A project has one nullable Deadline, separate from shoot date/time and checklist schedules.
- A checklist item is unscheduled, a due-only milestone (end/due only), or a scheduled range (start
  and end). Existing due values remain truthful end-only milestones; date-only values remain
  literal Sydney calendar dates. No start is invented, and no fabricated UTC-midnight instant is
  introduced.
- `Australia/Sydney` is canonical. DST gaps are rejected, repeated wall times require an explicit
  fold choice, and timed values preserve their civil/UTC/offset meaning. Range endpoints are both
  date-only or both timed; start precedes end; timed ranges are half-open; date-only range end is
  inclusive and remains the reminder boundary. No recurrence is included.
- Initial views are Month, Week, and Agenda. URL state carries the active date/view, event layers,
  Editor/Unassigned filters, Stage/status toggles, overdue state, and Dashboard search so links and
  Back/Forward restore the same authorized slice.
- Project events are Deadline milestones; checklist events are due milestones or ranges. A single
  range-bounded, server-authorized projection supplies the data, and filtering never broadens
  access or causes browser N+1 fetches.
- Deadline drag requires the project-edit permission, is never resizable, and confirms the old/new
  Deadline plus reminder consequences. Due-only checklist items drag but do not resize. Checklist
  range drag and Month moves preserve each endpoint's Sydney civil/wall-clock time-of-day on the
  moved dates, not elapsed duration, across DST; only the end edge resizes the end. Agenda provides
  keyboard-operable Move/Reschedule actions instead of relying on drag.
- The Unscheduled panel is operational: an unscheduled project dropped in Month defaults to 17:00
  Sydney and Week uses the selected 15-minute slot; an unscheduled checklist item dropped in Month
  becomes a date-only due milestone and in Week becomes a one-hour range. Empty calendar space
  creates nothing. External Editors may schedule assigned checklist work but cannot create or move
  project Deadlines.
- Timed checklist overlaps for one assignee are allowed and shown with a non-blocking conflict
  indicator. There is no premium resource timeline or external calendar synchronization.

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
- ⬜ Upload real floorplan (PDF + JPG) with immutable versioning, per D-08.

### 6.6 Copywriting ✅ Built (PDF)
- ✅ A per-project **downloadable PDF**, uploaded by **Admin or Editor/QA**, surfaced on the internal Copy tab and the client "Description" tab.
- _Planned:_ entering &amp; displaying copywriting directly in the Portal, plus delivering **social-media content** to the client alongside the copy.

### 6.7 Client delivery page ✅ Built
- ✅ Editorial cover hero, collection tabs (Gallery / Film / Floorplan / Description), favourites, slideshow, share, download (web/full-res, single + zip).
- ✅ **Video** and **Copywriting** sections on the delivered page.
- ✅ **Premium / paywalled content** — extra images & video shown **watermarked** behind a paywall; client unlocks to remove the watermark and download. _(replaces the former print store)_
- ✅ No login — private link. Planned link contract: 30-day default expiry, optional passcode, revocation, and hashed tokens per D-04.

### 6.8 Annotations & comments ✅ Built
- ✅ Threaded notes per image, freehand drawing, author + role + timestamp.
- ⬜ Notes should be **role-aware** (photographer's RAW notes vs QA's edit notes) and scoped to RAW or Edited.

#### Project discussion, activity, and notifications (current + planned outcomes)

Project discussion remains one flat, project-scoped, newest-first stream with rich text, mentions,
author-only edit/delete, and server-owned read state. Structured product activity remains separate
from security audit records and recipient inbox rows. The staff Notice Board remains Quincy-owned;
External Editors do not receive it or a global directory.

The approved notification direction is durable, role-safe delivery: an outbox/queue dispatch
re-checks current active status, role, capability, membership cycle, and event visibility immediately
before send. Failed reauthorization is silently dropped and audit-logged; ambiguous email
acceptance is not automatically retried. One producer owns each semantic event, and coalescing
limits recipient noise without falsifying committed activity. Access or membership loss purges
inaccessible cached project data and closes project-specific UI. These are planned revamp outcomes
until their owning tracer bullets are live; the current product's existing notification features
remain governed by the current implementation.

### 6.9 Admin backend dashboard ⬜ New
A dedicated **Admin Settings** area, separate from the project workspace, for backend
and operational management. **Admin-only** (per §4 capabilities model).

- ⬜ **Users:** create / edit / deactivate staff accounts; assign roles & capabilities.
- ⬜ **Projects:** full CRUD outside the normal pipeline flow — edit any field or
  **archive** a project — for corrections and cleanup. **Archive-only, no hard-delete**,
  to stay consistent with the immutable-asset-version model used elsewhere; an archived
  project is hidden from active dashboards/lists
  but its data and assets are retained and can be restored.
- ⬜ **Agencies / agents directory:** CRUD for client agencies and agents, so a shoot can
  be linked to an existing record instead of re-entering free-text contact details each
  time (agencies/agents currently arrive as free-text fields off the Tonomo webhook — see
  §4a).
- ⬜ **Pipeline configuration:** edit the pipeline stage labels/settings from §7 (e.g.
  rename a stage) without a code change. After planned TB0B, ordinary Admins retain label/active
  management but do not control global Stage ordering; developers own that ordering contract.
- ⬜ **Integrations:** a connections screen showing status (Connected / Expired / Error)
  for each external service, with a **Reconnect** action for OAuth refresh:
  - **Dropbox** — one **shared studio-level** OAuth connection, used for all RAW sync and
    the autoHDR watch folder (not a per-project or per-user connection).
  - Tonomo webhook status (last event received, signing key rotation).
  - Vimeo account connection.
---

## 7. Pipeline statuses  ✅ Current production semantic model

Implemented stages, shown on the dashboard and project rail:

| Stage key | Status label | Meaning |
|---|---|---|
| `awaiting_raw` | **Awaiting RAW** | Project created, no RAW uploaded yet |
| `raw_review` | **RAW review** | RAW uploaded, QA selecting |
| `editing_autohdr` | **Editing** | Selected RAWs are in the internal Admin-only AutoHDR workflow; non-admin API projections expose only the neutral stage/status |
| `edited_review` | **Edited review** | Edits returned, QA reviewing |
| `delivered` | **Delivered** | Final media delivered |

The public stage progression is fixed. A future client-review link is not part of the current
MVP, and display ordering/configuration never redefines automation semantics.

---

## 8. Tech stack & architecture — current production `portal/` baseline

> This section describes the **production application** in `portal/` — a TypeScript
> monorepo running entirely on Cloudflare, and now the only codebase in the repo.
> The `prototype/` reference app (React via CDN + in-browser Babel, mock data, no
> backend) was retired in #48 and never described this stack.

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
| `apps/web` | `@quincy/web` | Vite + React 18.3.1 SPA — the current staff UI (dashboard, workspace, review lightbox, admin). |
| `workers/app` | — | **Staff API** (Hono) + better-auth; also **serves the built SPA**; issues signed image-transform URLs. |
| `workers/background` | — | Queue consumers, direct send-only AutoHDR Workflow plus legacy compatibility paths, and the **Dropbox-sync + Tonomo-processor Durable Objects**. |
| `workers/webhook-ingress` | — | Thin **public** webhook receiver (Dropbox + Tonomo): verifies signatures, dedupes, fast-acks, hands off via service binding. |
| `packages/shared` | `@quincy/shared` | Single source for capabilities, pipeline stage keys, JPEG/media ingest rules, XMP star-rating parser, AES-GCM credential crypto. |
| `packages/db` | `@quincy/db` | Drizzle D1 schema, migrations 0000–0029 applied to prod, seed. |

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
  single source for these keys. Current production roles are Admin, Photographer, and Editor;
  the approved `external_editor` role and its assigned-safe capability profile are planned, not
  live.
- **Credential encryption:** external-integration tokens (Dropbox) are stored
  **AES-GCM encrypted** under an `INTEGRATION_KEK` Worker secret — never in plaintext.
- **Webhook integrity:** constant-time HMAC verification (Dropbox `X-Dropbox-Signature`;
  Tonomo bearer token), dedupe by event id, fast-ack.
- **Audit integrity:** every mutation is audit-logged; comment/annotation **edit &
  delete are author-only** (admins are *not* exempt — the one deliberate exception is an Admin
  actively impersonating that author via the runtime-gated user-impersonation feature, see
  `docs/Guides/Admin-Impersonation.md`); media is never destructively deleted.

### 8.6 External integrations

- **Dropbox** — one **shared studio-level** OAuth connection (not per-user/per-project),
  used for RAW sync and the autoHDR watch folder; Business team-space aware
  (`Dropbox-API-Path-Root`); needs `sharing.read` for `scl/fo/…` shared-link folders.
- **Tonomo** — booking webhooks auto-create pre-filled projects at *Awaiting RAW*
  (§4a); DO-serialized processing.
- **AutoHDR** — internal, **Admin-only** editing workflow. The explicit RAW-review handoff sends the selected images through AutoHDR's API; the API integration is intentionally send-only and does not fetch edited photos. Non-admin API projections use the neutral **Editing** label and omit provider and handoff details; authorization and projection are enforced at the API boundary, independently of UI visibility.
- **Vimeo** — films delivered as links/tiles (direct upload planned).

### 8.7 Environments & delivery

| Environment | Host | Notes |
|---|---|---|
| Production | `quincy.flamingfire.my` | Live. `main` is the source of truth. |
| Prototype | `prototype.quincy.flamingfire.my` | The old design prototype. Still deployed (Worker `quincyportal`), but its source was removed from the repo in #48, so it can no longer be redeployed. Awaiting a teardown decision. |

CI (`.github/portal.yml`) typechecks every workspace, runs the Vitest suites
(`packages/shared`, `workers/app`, `webhook-ingress`) in the Workers runtime, and builds
the SPA. Secrets are **Worker secrets** in prod; local dev reads gitignored
`.dev.vars`. Deploys run in the fixed **background → webhook-ingress → app** order.

---

## 9. Open questions (remaining)

The decisions resolved in v0.2 and the approved D-04/D-07/D-08/D-13 outcomes have been folded into
the sections above. Remaining product follow-ups are:

1. **Edited QA:** continue validating the RAW-vs-Edited compare workflow in the current product.
2. **Client delivery:** decide when optional client-link email delivery is worth implementing.
The client/guest-reviewer step remains excluded from the current MVP. The Schedule half of D-13 is
resolved as the approved planned Production Calendar/checklist-scheduling program; the Clients half
remains deferred and hidden.

---

## 10. Out of current prototype scope / parked

- Real payment processing for premium unlocks (currently a simulated checkout).
- Analytics (client opens, downloads).
- Audit log / version history.

Durable, role-safe notification delivery and the Production Calendar are approved revamp outcomes,
but remain planned until their owning tracer bullets are implemented, verified, committed, and
deployed. They are not live features of the current prototype or production dashboard merely
because they are specified above.

_✏️ Move anything here into scope by noting it._
