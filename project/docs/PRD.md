# Quincy Portal — Product Requirements Document (PRD)

> **Status:** Draft v0.2 · 18 June 2026
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
| **Select RAW → send to autoHDR** | ✓ | ✗ | ✓ | ✗ |
| View / QA **Edited** images | ✓ | ✗ | ✓ | ✗ |
| Comment / annotate **Edited** | ✓ | ✗ | ✓ | ✗ |
| Compare images side-by-side | ✓ | ✓ | ✓ | ✗ |
| Manage **videos / floorplans / copywriting** | ✓ | ✗ | ✓ | ✗ |
| **Publish to client delivery page** | ✓ | ✗ | ✓ | ✗ |
| View client delivery page | ✓ | ✗ | ✓ | ✓ |
| Download final media | ✓ | ✗ | ✓ | ✓ |

**Resolved decisions:**
- A Photographer **cannot** see the client delivery page — they are scoped to RAW on their assigned shoots only.
- **Project creation is Admin-only.** Editor/QA work within projects Admin sets up.
- **Video, floorplan and copywriting** can be managed by **both Admin and Editor/QA** (`canManageExtras`).

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

**2. RAW QA & selection** ✅ Built
- Editor/QA reviews all RAWs, compares similar frames, annotates, and sees photographer recommendations.
- Editor/QA **selects** (a state separate from approve) the RAWs that should be edited, then sends them to autoHDR.

**3. Editing — autoHDR handoff** ✅ Built
- Selected RAWs are **copied to a Dropbox folder that autoHDR monitors**; autoHDR retouches them automatically.
- Edited images come back into the project as the **Edited** set, shown with a "Processing → Returned" status.
- _Planned:_ sending images directly to autoHDR via API (not implemented yet).

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

---

## 7. Pipeline statuses  ✅ Built

Implemented stages, shown on the dashboard and project rail:

| Stage | Status label | Meaning |
|---|---|---|
| 1 | **Awaiting RAW** | Project created, no RAW uploaded yet |
| 2 | **RAW review** | RAW uploaded, QA selecting |
| 3 | **Editing · autoHDR** | Selected RAWs copied to autoHDR's Dropbox folder |
| 4 | **Edited review** | Edits returned, QA reviewing |
| 5 | **Client review** | Published to client _(optional gate)_ |
| 6 | **Delivered** | Final media delivered |

---

## 8. Open questions (remaining)

The decisions resolved in v0.2 have been folded into the sections above. Still open:

1. **Edited QA:** show **RAW-vs-Edited** pairs side-by-side in compare? (§5 stage 4)
2. **Floorplans:** confirm upload needs — PDF + JPG, versioning? (§6.5)
3. **Client link:** expiry window and optional passcode? (§6.7)
4. **Client approval:** does the agent ever **review/approve** media, or only receive it? Your original brief mentioned "review before publish to end client" — confirm whether to (re)introduce a client/guest-reviewer step.

---

## 9. Out of current prototype scope / parked

- Real payment processing for premium unlocks (currently a simulated checkout).
- Notifications (email/SMS) on stage changes.
- Analytics (client opens, downloads).
- Audit log / version history.

_✏️ Move anything here into scope by noting it._
