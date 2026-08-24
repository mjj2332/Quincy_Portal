# Quincy Portal — Implementation Plan

> **Status:** v1.1 · 2026-08-24 · Approved through A14 (v1.0 · 19 July 2026)
> **Supersedes where they conflict:** `Implementation-Proposal.md` v1.2 (22 June 2026)
> **Authority order:** `Decision-Sheet.md` (D-01–D-15 approved 2026-07-19; D-13/D-15 revised and D-16–D-19 approved 2026-08-24) → this plan → `PRD.md` → `Implementation-Proposal.md` → `Personas.md` / `Sitemap.md`
> **Inputs:** repo inventory, Cloudflare platform compatibility audit (2026-07-19, retrieval-based), independent cross-doc consistency review (Codex, 21 findings), approved Decision Sheet D-01…D-19 (D-13/D-15 revised 2026-08-24).

---

## 1. Pre-implementation check — results

### 1.1 Repo reality

The repo is a **prototype, not a foundation**. React 18 via CDN + Babel standalone, `window.QP` globals, no package.json, no TypeScript, no build, no tests, no backend, and `wrangler.jsonc` is a static-assets-only skeleton with zero bindings. Phase 0 is therefore a **greenfield scaffold**.

What ports directly:
- **Design system** — full token kit (colors/typography/spacing/motion), 4 brand fonts, `app.css` (token-driven, hand-authored). Production-ready.
- **Data shapes** — the prototype's project/photo/review/comment state tree maps cleanly onto the D1 schema and Zod/TS types.
- **Tonomo mapping** — `QP.fromTonomo()` + two real payload samples in `prototype/uploads/` make the webhook mapper directly implementable.

What gets rewritten: all component logic (as typed Vite/React modules), all state (localStorage → D1 + API).

### 1.2 Cloudflare compatibility verdict

The stack is **compatible with two material corrections** and a set of caveats. Full audit: 12-point matrix, retrieval-based as of 2026-07-19.

| # | Item | Verdict | Consequence for the plan |
|---|---|---|---|
| 1 | Google OAuth (staff login) | ✅ | **better-auth v1.5** (stable since Feb 2026, native D1 adapter, Google social provider, documented Hono integration). **Google ships first per revised D-14** — no email dependency for MVP login. Lucia is dead; openauth still beta; Clerk/WorkOS conflict with "app owns auth". |
| 2 | Magic-link email sending | 🕒 **planned, deferred until needed** | Stays in the approved auth design (D-14) but is **not implemented in MVP** — built later, on demand (e.g. a staff member without Google), not on a fixed phase date. No transactional-email provider needed until then. A `sendEmail()` seam is kept now so it drops in without rework. |
| 3 | Renditions from 20–50 MB JPEGs | ✅ **(re-scoped 2026-07-19)** | Use the **remote/URL Image Transformation path (100 MB source limit)**, not the Workers `env.IMAGES` binding (20 MB) — the resize runs in Cloudflare's managed infra, so the 128 MB isolate ceiling never applies. **No Cloudflare Container needed.** Originals stay private in R2; a Worker authenticates and transforms on the way out. XMP star rating read via a Worker header range-read (no decode). |
| 4 | R2 presigned multipart from browser | ✅ | Works via standard S3 semantics; no canned Cloudflare recipe — validate in a Phase-0 spike. CORS must expose `ETag`. |
| 5 | D1 metadata-only design | ✅ | 10 GB/db, 2 MB row cap, 100 bound params — fits. Sessions API is beta; don't contract on it. |
| 6 | Queues + Workflows | ✅⚠️ | Sleep-based Workflows are ideal for the hours-long autoHDR wait. New per-step billing from **Aug 10, 2026** (negligible at our volume). Verify GA banner at build time. |
| 7 | Vite SPA on Workers Static Assets | ⚠️ | Correct path (not Pages). Spike the `not_found_handling: "single-page-application"` + `run_worker_first: ["/api/*"]` interaction with Hono early. |
| 8 | Service bindings (4 Workers) | ⚠️ | Bindings resolve at deploy time → **CI/CD must deploy in dependency order**; encode it in GitHub Actions. |
| 9 | Dropbox from Workers | ⚠️ | Cursor sync via **Durable Object alarm** per connection (not polling/cron). Refresh token is rewritten on every refresh → store **encrypted in D1** (KEK in a wrangler secret); Secrets Store is read-only from Workers, wrong fit. |
| 10 | Zip delivery | ⚠️ | **Pre-build the zip per publish-version in R2** (Workflow job), then stream/pass-through. On-the-fly *compression* of multi-GB galleries risks the CPU cap. |
| 11 | Cloudflare Stream (later) | ✅ | ~$3–5/mo at our scale. Defer as planned. |
| 12 | Total cost | ✅ | ~**$15–40/mo** at launch → $25–50/mo as R2 retention grows. R2 storage is the long-run cost driver to watch. |

### 1.3 Consistency review verdict

The independent review confirmed the docs are implementable **only after the deltas in §2 are applied**. All 21 findings are dispositioned by this plan: the P0s become §2 amendments (auth swap, stage model, admin-dashboard schema, capability storage) and §5 schema entries; the P1s are folded into phase exit criteria (§6), the contract decisions (§3), and the week-1 checklist (§7); the P2 documentation cleanups are queued in §9.

---

## 2. Amendments to the Implementation Proposal (the "v1.3 deltas")

The proposal remains the architectural baseline. These amendments override it.

### A1 — Staff auth: Cloudflare Access → owned auth, Google first (D-14, revised 2026-07-19)

Every Access assumption in the proposal (§1, §3, §4 diagram, §5 users, §6.2–6.4, §8, §9, §12) is replaced by:

- **Library:** better-auth v1.5+ on the staff app/API Worker (Hono), native D1 adapter, **Google social provider in MVP**. Magic link **stays in the approved design (D-14) but is deferred** — implemented later, when a real need arises (e.g. a staff member without a Google account), not against a fixed phase date. Deferring it means no transactional-email dependency, no magic-link token table, and no login SPOF until it's actually built.
- **Sessions:** D1 as source of truth; **KV as secondary/hot session store** (accept ~60 s eventual consistency on revocation for a small staff team; document it). Cookies: `httpOnly`, `secure`, `sameSite: Lax`, signed.
- **CSRF:** Hono `csrf()` middleware on all state-changing routes; OAuth `state` + PKCE.
- **Provisioning:** closed system — **no self-signup**. Admin creates the user row (email + role) first; Google sign-in only succeeds for allow-listed active users. Deactivation revokes sessions (KV delete + D1 flag). **Prerequisite while Google is the only live method: every staff member has a Google account** — the day that stops being true is the trigger to build magic link.
- **No email needed for login yet.** Keep a thin `sendEmail()` interface (unimplemented until magic link is triggered) so it — or client-link delivery email in Phase 5 — drops in without touching auth logic.
- **New risk ownership:** auth is first-class production surface. Add auth integration tests (OAuth callback, session revocation, deactivated-user lockout, allow-list enforcement) to the Phase-0 launch gate.

### A2 — Rendition pipeline: remote Image Transformations, no Container (re-scoped 2026-07-19)

The original audit assumed the Workers `env.IMAGES` binding (20 MB source cap) or in-isolate decode (128 MB memory) — both fail for 20–50 MB Lightroom exports. The **remote/URL transformation path lifts the source limit to 100 MB** (100 MP, 12,000 px) and runs the resize in Cloudflare's managed infrastructure, so the isolate memory ceiling is irrelevant. This **removes the Cloudflare Container** the earlier draft added.

- **Originals:** stored **durably in R2** (versioned, immutable keys), never expired — they are the clean full-res for delivery, the paywall source, and the RAW↔Edited compare source. **Dropbox remains the capture/backup source that syncs *into* R2**; transforms are never served from Dropbox directly.
- **Renditions:** a Worker binds the private R2 bucket, authenticates the request (staff session in Phases 1–4; client signed-link + unlock check in Phase 5), fetches the private original, and applies the transform via `cf.image` / `/cdn-cgi/image/`. QA renditions target ~2560–3840 px at high quality (crisp on a 4K monitor); thumbnails small. The clean full-res original is served only via signed URL from R2 (free egress) for pixel-peeping/download — never through a public transform.
- **Generation strategy:** start **on-the-fly with edge caching** (simplest — no ingest compute, no rendition store; `asset_renditions` becomes an optional lazy cache). If per-transform cost climbs, persist hot renditions to R2 after first generation. Cost check: ~60 shoots × ~250 frames × 2 variants ≈ 30k transforms/mo ≈ ~$12.50/mo after the 5,000 free tier, minus cache reuse.
- **XMP star rating** (`rating_from_metadata`): read at ingest by a Worker that **range-reads the JPEG header** and parses the XMP/APP1 segment (e.g. `exifr` on a partial buffer) — no full decode, no Container.
  **Format validated against real files (2026-07-19):** rating is a plain RDF attribute, `xmp:Rating="N"`, inside the `<x:xmpmeta>…</x:xmpmeta>` packet — standard Lightroom output. **Absence of the attribute means unrated (not 0)** — the parser must distinguish "no `xmp:Rating` found" from "`xmp:Rating="0"`" and store the former as null/unrated in `rating_from_metadata`, not as a zero star count. Checked 44 real studio export JPEGs (2.9–28 MB) in `test-data/Test Images with star rating/` at repo root — 8 carried `xmp:Rating="1"`, 35 had no attribute at all. No IPTC-`Urgency` or Microsoft-percentage rating schemes were found in this set, so a single XMP-attribute parse path covers the studio's actual export tool; no fallback parser needed unless a different culling tool is introduced later. These files double as the fixture set for the Phase-0 spike (④ below) — no need to source new test data.
- The stack stays at **4 Workers** (no 5th compute surface).

### A3 — Admin backend dashboard (PRD §6.9, new)

Added to scope, phased (§6): staff user CRUD, project edit/**archive-only** (restorable, audited — no hard delete), **agencies/agents directory** (projects link to directory records while keeping the Tonomo-supplied contact snapshot), **pipeline stage configuration**, and an **integrations screen** (Dropbox studio-level OAuth connect/reconnect/status, Tonomo webhook health + signing-key rotation, Vimeo).

### A4 — Pipeline stage model (resolves PRD §7 vs §6.9 vs D-03)

- Stages have **stable machine keys**; Admin-editable **labels and active/inactive status**, together with developer-managed **display order**, live in a `pipeline_stages` config table. Global display order is not ordinary Admin self-service. Code and transitions reference keys only.
- MVP keys: `awaiting_raw`, `raw_review`, `editing_autohdr`, `edited_review`, `delivered`. **`client_review` is not shipped** (D-03); the key is reserved for a future review-link feature. Stage *reordering* is display-order only — transition logic does not change when labels/order change.

### A5 — Dropbox integration lifecycle (resolves "app token" gap)

One **studio-level OAuth connection** (D-decision in PRD §6.9): connect/reconnect flow in the admin integrations screen; access/refresh tokens **encrypted in D1** (AES-GCM, KEK in wrangler secret); refresh rotation handled in-Worker; connection status + last-webhook-received surfaced. Cursor/delta sync runs on a **Durable Object alarm** per connection.

### A6 — Schema additions the proposal is missing

See §5: auth tables (via better-auth, Google in MVP — `magic_link_tokens` added later when built), `role_capabilities` mapping, `agencies`/`agents`, `integration_connections`, `pipeline_stages`, `projects.archived_at/archived_by`, `assets.source_raw_asset_id` (RAW↔Edited pairing for D-07), floorplan version pairing (PDF + preview as one version via `version_group_id`).

### A7 — Delivery mechanics

Zips: **pre-built per `publish_version` into R2** by a Workflow job; client downloads stream the pre-built object (or short-lived signed GET). On-the-fly compression is a fallback for small ad-hoc sets only.

A8–A14 (added 2026-08-24) amend this plan's program scope under revised D-13/D-15 and D-16–D-19;
they do not amend `Implementation-Proposal.md`.

### A8 — UI platform and design convergence (D-16)

The production SPA converges incrementally on Tailwind CSS v4 and source-owned shadcn components
only after TB0A and TB0B are live. TB1 proves the boundary with Base UI, Sera scaffold, Lucide,
CSS-variable-backed Quincy semantic tokens, and Preflight disabled initially. Dark mode is not in
scope. Generated components are reviewed and owned as application source; neither shadcn, Sera,
Tailwind, nor FullCalendar becomes visual authority. FullCalendar's official shadcn registry is a
single specialist exception for TB5C after the base platform exists.

Current production, the reference prototype, and each migrated surface are compared at 1440×900,
1024×768, and 390×844 plus material open/loading/error/focus/read-only/permission/conflict states.
Every material difference is classified as conforming, intentional evolution, required
platform/accessibility/security change, unwanted drift, or unassessed. Intentional evolution and
deferral require owner disposition; unassessed differences block acceptance. Preserve Quincy
fonts, signal colors, geometry, hairlines, low elevation, calm motion, keyboard behavior, and
working product/security constraints throughout coexistence.

### A9 — Route-aware server-state freshness (D-17)

Keep the typed custom router and deep URLs. Adopt TanStack Query incrementally, beginning with
Project detail and active collection assets in TB2 rather than rewriting every data path at once.
Every server-backed surface defines query identity using every route, project, collection, visible
range, filter, and authorization-scope variable that changes the result. It also defines
stale/fresh timing, cancellation, focus/reconnect behavior, same-browser invalidation, bounded
polling, and access-loss cleanup.

Background refresh must not destroy form/comment drafts, open controls, Lightbox position,
selection, scroll, Calendar filters, or active drag/resize. Same-browser mutations use narrow
`BroadcastChannel` invalidation; other sessions converge through bounded polling. Permanently
forbidden resources stop retrying, and role/membership loss purges inaccessible cached data and
closes project-specific UI. Preserve the existing terminal-aware `autohdr_api_send` refresh and do
not duplicate sends, reset RAW selection, revive legacy round-trip polling/fetch for the direct
path, or retry an ambiguous provider outcome as a new paid job.

### A10 — Discussions, activity, durable notifications, fixed pipeline semantics, and Kanban (D-17)

Project discussion remains one flat, project-scoped, newest-first stream with rich text, mentions,
author-only edit/delete, cursor pagination, and server-owned read state. The staff Notice Board
remains asynchronous and Quincy-owned; TB7 synchronizes only each user's read/unread state across
their devices. Structured product activity is separate from security audit and recipient inbox
rows.

Durable delivery uses a D1 outbox, Cloudflare Queue, recipient/channel ledger, recovery scan, and
DLQ. Every dispatch re-checks current active status, role, capability, membership cycle, and event
visibility immediately before send. Failed reauthorization is silently dropped without retry or
user-visible error and is audit-logged. Ambiguous email acceptance is `unknown`, not automatically
retried. One producer owns each semantic event; coalescing limits noise without falsifying
committed activity.

Stage machine identities remain
`awaiting_raw → raw_review → editing_autohdr → edited_review → delivered`; display order never
redefines automation. TB0B moves global Stage ordering out of ordinary Admin self-service while
preserving label/active management. `boardPosition` is the sole persisted manual Kanban order;
Priority and shoot-date views are non-writing sorts; TB5B later replaces native drag with dnd-kit.
PR #44's Admin-only direct AutoHDR send remains a separate send-only operation: manual Stage
movement never sends/cancels work, provider credentials/UID/diagnostics remain private, ambiguous
provider outcomes reconcile the existing job/UID, and finalization plus its guarded Stage advance
produces durable activity/notification exactly once only after provider acceptance.

### A11 — Project Workspace coordination, including the `moveProjectStage` Stage capability and the Stage/order contract TB5A delivers (D-18)

The Project Workspace left rail is canonical for Stage, project Deadline/reminders,
Photographers, and Editors. Collaboration remains canonical for checklist/subtasks, project
discussion, and task-level collaboration. Photographer and Editor rows mutate independently with
immediate idempotent per-person deltas and membership-cycle guards. Inactive assignees remain
visible/removable but cannot be newly selected. Removing a final compatible project role warns
about and atomically clears affected checklist assignments; retaining another compatible role or
active Admin status preserves them.

Team-assignment eligibility is exact: the Photographer slot permits active Photographers, internal
Editors, and Admins; the Editor slot permits active internal Editors and Admins before TB4E, then
active internal Editors, External Editors, and Admins after TB4E. External Editors are never
eligible for the Photographer slot. A person may hold both project roles only while their global
account role remains eligible for both.

`editProject` remains the capability for team-assignment and project Deadline/reminder writes.
TB5A introduces `moveProjectStage`, initially granted to Admins, internal Editors, and assigned
External Editors, and makes it the single guarded command for rail, Kanban, keyboard, and non-drag
Stage movement. Semantic backward, skipped, delivered, and `editing_autohdr` transitions use the
approved confirmations; manual AutoHDR Stage entry/exit is Stage-only.

One nullable project Deadline remains separate from shoot time and checklist schedule. It uses
`Australia/Sydney` civil time with explicit DST gap/fold treatment and one shared schedule
revision/conflict token across rail and Calendar mutation. Reminder offsets are bounded, Due-now
always materializes, and delivered/archive suppress pending occurrences. Kanban shows
Deadline/overdue metadata and omits only card-level RAW count. The assigned-Editor event registry
is finite, role-safe, membership-cycle-aware, and noise-bounded.

### A12 — React 19.2 compatibility-only runtime upgrade (D-15, revised 2026-08-24)

TB0A is a standalone app-Worker release that pins React and React DOM to the same latest stable
exact `19.2.x` patch and pins compatible exact React type packages after checking the registry and
official migration guidance at implementation time. Retain TypeScript, Vite SPA, `createRoot`,
StrictMode, modern JSX transform, typed custom router, Hono RPC, Cloudflare Worker asset serving,
and current product behavior/visual output.

No React Compiler, SSR, Server Components, hydration architecture, framework/router migration,
`Activity`, Actions/form rewrite, `useEffectEvent` sweep, ref-as-prop sweep, Tailwind/shadcn setup,
or product redesign belongs in TB0A. Update a supporting dependency only when a demonstrated React
19 blocker requires the minimum compatible change. Record lockfile, warnings, tests, bundle delta,
and focused before/after evidence. Rollback is the previous app Worker/web bundle; no schema is
introduced.

### A13 — Checklist scheduling and Production Calendar (D-13, revised 2026-08-24)

Extend checklist scheduling additively: an item is unscheduled (no start/end), a due-only
milestone (end/due only), or a scheduled range (start and end). Existing due values remain truthful
end-only milestones and existing date-only values remain literal Sydney calendar dates; never
invent starts or fabricated UTC midnight instants. Range endpoints are both date-only or both
timed, start precedes end, same-day and multi-day ranges are both allowed, date-only persisted end
is inclusive, and timed ranges are half-open.
`Australia/Sydney` is canonical; persist deterministic civil/UTC/offset-fold data for timed values,
reject DST gaps, require an explicit fold choice, version/conflict-guard writes, and keep reminders
on the persisted end/due boundary. FullCalendar's exclusive end exists only in the Calendar's
wire/event representation: the range endpoint derives it when serializing and converts it back on
write. The stored value remains the inclusive final Sydney calendar date, and no other stored
column, query, or surface receives the exclusive form. Repeated broad checklist-schedule
notifications for the same item/actor coalesce within five minutes, while audit/activity still
records each actual committed operation. No recurrence is introduced.

Calendar becomes the third Dashboard view beside List and Kanban, with Month, Week, and Agenda;
typed URL state; Projects/Checklist layers; multi-Editor OR plus Unassigned, Stage,
completion/delivery/overdue, and Dashboard-search filters; and one range-bounded server-authorized
projection rather than browser N+1 fetches. Project events are Deadline milestones; checklist
events are due milestones or ranges. No shoot-date, comment, upload, or activity event layer is
inferred.

TB5C rechecks and pins FullCalendar Standard React through its official shadcn registry after TB1,
using only Standard Month/TimeGrid/List/Interaction capabilities. Quincy owns composition,
renderers, permissions, confirmations, accessibility, responsive behavior, and tokens. Project
Deadline drag requires `editProject`, is never resizable, and its confirmation shows the old and
new Deadline values plus the resulting reminder consequences. Due-only checklist items are
draggable but never resizable. Checklist ranges are draggable; only the end edge resizes the end,
while independent start changes use the schedule editor. These operations use guarded optimistic
state with stale `409` rollback; every editable event has a keyboard-operable Move/Reschedule
equivalent, and Agenda uses accessible Reschedule actions instead of drag. Range drag and Month
moves preserve each endpoint's Sydney civil/wall-clock time-of-day on the moved dates, not elapsed
duration, across DST; Week snaps to 15-minute increments.

The Unscheduled panel is operational, not decorative: dropping an unscheduled project into Month
creates a 17:00 Sydney Deadline on that date, while Week uses the selected 15-minute slot; project
confirmation still applies and no advance reminder offset is invented. Dropping an unscheduled
checklist item into Month creates a date-only due milestone, while Week creates a one-hour range.
External Editors may drag unscheduled checklist work for assigned projects, but cannot create or
move project Deadlines because they lack `editProject`. Empty calendar space creates nothing.
Overlapping timed checklist ranges for one assignee are allowed and show a non-blocking conflict
indicator; work is never auto-moved, and a project Deadline is never treated as exclusive capacity.
Calendar filters never broaden authorization; External Editors receive only A14's assigned-safe
projection. No premium Scheduler/resource timeline or external calendar sync is included.

### A14 — External Editor assigned-scope authorization (D-19)

Add a fourth global account role `external_editor`, displayed **External editor**, with its own
explicit capability entry. Project membership remains the existing `editor` role. External
Editors never receive `viewAllProjects`; every list, search, direct route, media, Collaboration,
quick-detail, notification, and Calendar surface requires current explicit project membership and
server-side scope. They have no Photographer Stage restriction and no ordinary archived-project
access.

The complete initial allow-list is `uploadEdited`, `viewRaw`, `annotateRaw`, `recommendRaw`,
`compareFrames`, `viewEdited`, `reviewEdited`, `annotateEdited`, and `collaborateOnProject`, plus
`moveProjectStage` when TB5A ships and `viewProductionCalendar` when TB5C ships. Explicitly
withhold `publish`, `viewClientPreview`, `downloadFinal`, `manageExtras`, `selectForEditing`,
`uploadRaw`, `viewNoticeBoard`, project create/edit/archive, Admin/user/directory/integration/
pipeline/prioritization, the staff Notice Board, AutoHDR send, and provider/job diagnostic
capabilities.

One shared server-side External Editor projection owns every reachable DTO. For an assigned
project it may expose address/location, Agency/Agent display names, shoot date/time, Stage,
Deadline, services/deliverables, `productionNotes`, approved production media, checklist,
discussion, roster identity, and project-participant email. It must exclude the existing
internal-staff-only `projects.notes`, agent/client email or phone, invoice/payment, unnecessary
order bookkeeping, agency-directory notes, Dropbox topology, provider credentials/diagnostics,
Admin data, and unrelated people/projects. Add `productionNotes` as a distinct column; existing
`notes` remains internal and is not copied into it. Project discussion remains one shared thread.
An automated regression gate proves every External-Editor-reachable DTO uses the shared
projection. Every phase from TB5A through TB8 that adds or touches a DTO reachable by an External
Editor must rerun that same shared-projection regression test as a release gate.

Create Project and the rail may assign External Editors only in the Editor slot. Existing users
are never auto-converted. Role transitions revoke sessions; conversion is blocked until
incompatible Photographer memberships are removed. Deactivation preserves membership history but
blocks authentication, new assignment, and pending delivery. Final membership removal warns of
immediate access loss and atomically applies approved checklist cleanup. Access-loss signals purge
inaccessible cached data and close project UI. Assigned External Editors receive only the
external-safe subset of targeted assignments, mentions, Deadline reminders, broad project events,
activity, and Calendar data, with send-time reauthorization.

> **A8–A14 approved:** 2026-08-24 by mjj2332@gmail.com. D-13 and D-15 were revised inline;
> D-16–D-19 were added. Planned outcomes remain targets until their owning tracer bullets are
> implemented, verified, committed, deployed, and recorded live.

---

## 3. Contract decisions locked for implementation

Small ambiguities the consistency review flagged, resolved here so week 1 doesn't stall (flag any you want changed):

1. **RAW upload permission:** PRD §4 wins over the Sitemap — **Admin, Photographer, and Editor/QA can all upload RAW**. Sitemap will be corrected.
2. **Copy upload:** per D-12 + PRD §4 `canManageExtras` — **Admin and Editor/QA** (PRD §6.6 "project admin only" wording will be corrected).
3. **Client links:** 30-day default expiry (D-04) becomes a `client_links.expires_at` default computed at creation; passcode optional per link.
4. **Photographer surfaces (D-02/D-11):** Phase 1's "minimal project list" ships **role-filtered from day one** (assigned shoots only); photographers can compare their own RAWs and see selected-for-editing state. Personas' open questions are resolved accordingly.
5. **"View as" switcher (D-09):** implemented as a build-time env flag (`VITE_ALLOW_VIEW_AS`), stripped from production bundles; a CI check asserts the production build does not contain the affordance. Production capability checks never consult it.
6. **Clients / Schedule nav (D-13, revised 2026-08-24):** **Clients remain hidden and not stubbed.** The Schedule half is superseded by A13: Calendar ships as a third Dashboard view after its prerequisite tracer bullets; planned, not live.
7. **No auth email provider in MVP** (revised D-14 — Google ships first, magic link stays planned but deferred). A `sendEmail()` interface is stubbed but unimplemented; it activates whenever magic link is triggered by need, or for Phase 5 client-link delivery if that's built before then. Prerequisite while Google-only: all current staff have Google accounts.

---

## 4. Target architecture (amended)

```
                    ┌───────────────── Tonomo ─────────────────┐
                    │ order.created / order.updated + links     │
                    └──────────────┬───────────────────────────┘
                                   │ POST /webhooks/tonomo/* (signed, public)
                                   ▼
 Client ─signed link (/d/:token)─► ┌──────────────────────────────┐
 (no login, public)                │ PUBLIC Workers                │
                                   │ • webhook-ingress (Ph 2)      │
                                   │ • client-delivery (Ph 5)      │
                                   └──────────────┬───────────────┘
                                                  │ service bindings
 Staff ──── Google OAuth ─────────► ┌─────────────▼───────────────┐
 (better-auth sessions: D1+KV)      │ APP/API Worker (staff)       │
                                    │ Hono + better-auth + SPA      │
                                    │ + R2-read → cf.image transform│
                                    └──┬──────┬───────┬───────┬────┘
                                       │      │       │       │
                                  ┌────▼─┐ ┌──▼──┐ ┌──▼───┐ ┌─▼──────────┐
                                  │  D1  │ │ R2  │ │Queues│ │ BACKGROUND │
                                  │ meta │ │orig.│ │ (IDs)│ │ Worker     │
                                  └──────┘ │(priv)│ └──┬───┘ │ +Workflows │
                                           └──▲──┘     │     └─┬─────┬────┘
                                  Image Transformations│       │     │ DO binding
                                  (remote path, 100 MB;└───────┐│     │
                                   resize in CF infra) ┌───────▼▼─────▼──┐
                                            ┌──────────┤  Dropbox API    │
                                            │ autoHDR  │  (DO-alarm      │
                                            │(watches  │   cursor sync)  │
                                            │ Dropbox) │                 │
                                            └──────────┴─────────────────┘
```

Deploy order (encoded in CI): background → webhook-ingress → app/api → client-delivery.
No 5th compute surface: image renditions use the remote Image Transformation path, not a Container. No transactional-email provider in MVP (Google ships first; magic link stays planned but deferred).

---

## 5. Data model v1 (D1)

Proposal §5 tables stand, with these changes/additions (all tables get `id`, `created_at`, `updated_at`):

**Auth & access (new)**
- better-auth managed tables: `user`, `session`, `account` (Google), `verification` — via its D1 adapter/migrations. Our `users` profile fields (role, active) merge into/extend better-auth's user table. (`magic_link_tokens` is not created in MVP — added when the magic-link plugin is switched on later, per D-14.)
- `role_capabilities` — role → capability grants (`uploadRaw`, `selectForEditing`, `viewEdited`, `manageExtras`, `publish`, `adminBackend`, …). Static-seeded for MVP; a table (not code constants) so D-06's future role split needs no rewrite.

**Admin backend (new)**
- `agencies` — name, branding fields.
- `agents` — `agency_id`, name, email, phone.
- `projects` gains `agency_id?`, `agent_id?` (nullable FKs; Tonomo free-text snapshot fields retained), `archived_at?`, `archived_by?`.
- `pipeline_stages` — `key` (stable), `label`, `display_order`, `active`.
- `integration_connections` — `provider` (`dropbox|tonomo|vimeo|email`), `status`, `encrypted_credentials`, `expires_at`, `scopes`, `last_event_at`, `last_error`.

**Pipeline (amended)**
- `assets` gains `source_raw_asset_id?` — links a returned edit to its source RAW (D-07 compare; populated by autoHDR-return correlation).
- Floorplans: `assets.version_group_id` ties the PDF + preview JPG of one floorplan version together; `supersedes_asset_id` chains versions; latest approved version publishes by default (D-08).
- `client_links.expires_at` defaults to +30 days (D-04).
- `projects.stage` stores the stable stage **key**.

Everything else (collections, asset_renditions, selections, ratings/labels/decisions, annotations→R2, comments, publishes, premium_unlocks, webhook_events, jobs, audit_log) is unchanged from proposal §5.

---

## 6. Phase plan (amended)

Sequencing philosophy unchanged: **internal capture pipeline first, client delivery last.** Each phase ships to the internal team.

### Phase 0 — Foundations + owned auth
Scaffold monorepo (Vite + React 18 + TS SPA, Hono, per-Worker wrangler configs, Drizzle/typed-SQL migrations, Vitest + vitest-pool-workers, GitHub Actions with ordered deploys, dev/staging/prod envs). Port design-system tokens/fonts/CSS. D1 schema v1 (§5) + R2 buckets (versioning on). **Auth:** better-auth + Google provider only, sign-in screen, session middleware, capability middleware, admin user CRUD (the first §6.9 slice), audit log. Manual admin project creation (full Tonomo field set + optional `order_id`).
**Spikes (all in Phase 0):** ① **Remote Image Transformation from a private R2 original** against worst-case 50 MB JPEGs — confirm the authenticated-Worker → `cf.image` transform wiring, QA rendition quality on a 4K monitor, and on-the-fly-vs-store cost (*go/no-go gate for Phase 1*); ② R2 presigned multipart from the browser incl. CORS/ETag; ③ SPA-fallback + `run_worker_first` routing with Hono; ④ **XMP star-rating parse from a range-read JPEG header** — format already validated by hand against the real fixture set (§2 A2), so this spike is now just building the range-read parser against `test-data/Test Images with star rating/` and confirming it agrees with the manual scan, not discovering the format from scratch.
**Exit criteria:** staff can sign in with Google; non-allow-listed and deactivated users are locked out with sessions revoked; capability matrix enforced on API routes; auth integration tests green; all four spikes pass; CI deploys all envs in order.

### Phase 1 — Capture ingest + RAW QA (first daily driver)
Direct-to-R2 multipart upload (JPEG-only validation per D-01) + manually-triggered Dropbox sync (studio OAuth connect ships here in minimal form); file-count verification (folder-name convention + browser manifest); remote Image-Transformation renditions + XMP rating ingest (Worker range-read); **role-filtered** project list (photographers: assigned only, per contract decision 4); RAW QA tooling (ratings, labels, freehand markup→R2, compare, recommend) ending in select-for-editing.
**Exit:** "upload 18 → see 18" holds; photographer scoping verified by tests; select-for-editing gate functional.

### Phase 2 — autoHDR handoff + Edited QA
Public **webhook-ingress Worker** (Dropbox webhook → DO-alarm cursor/delta sync); Workflow round-trip (copy selected → *Editing·autoHDR* → correlate returns via `source_raw_asset_id` → Edited collection → *Edited review*), timeout + manual retry + stuck-recovery screen; Edited QA + **RAW↔Edited compare** (D-07).

**2026-08-24 handoff amendment:** the explicit RAW-review button now sends the frozen selection
through AutoHDR's presigned-upload API from the background Worker and advances only after the
provider accepts finalization. That API path is deliberately send-only: it supplies no completion
callback and does not call AutoHDR status or processed-photo retrieval endpoints. The original
Dropbox round-trip remains only as compatibility infrastructure for legacy/in-flight work and
separate edited-media intake paths.
**Exit:** full internal capture→edit→QA loop runs end-to-end on a real shoot.

### Phase 3 — Tonomo intake + full dashboard + admin backend completion
Tonomo webhooks (`order.created`/`order.updated` — **amended 2026-07-20:** Tonomo cannot HMAC-sign; auth is a secret token in the webhook URL (constant-time compared, worker secret) and replay protection comes from body-hash idempotent dedupe in `webhook_events`, which makes redeliveries no-ops; plus poison-event operator screen); **per-service hybrid intake (D-05)** — photos → *Awaiting RAW*, finished video/floorplan/copy links attach immediately with received/status metadata (explicit acceptance criterion); reconciliation by `order_id`/address against manual projects. Full dashboard (Kanban/List, role-filtered): Kanban is the active-dashboard default and archived projects are List-only. Admin backend completion: agencies/agents directory, project archive/restore, pipeline stage config, integrations screen (Dropbox reconnect/status, Tonomo health, Vimeo).
**Exit:** a Tonomo order creates a correct project with zero re-keying; hybrid attach verified per service; archive is restorable and audited.

### Phase 4 — Video / floorplan / copy (internal)
Vimeo link tiles; floorplan PDF+preview versioning (`version_group_id`, latest-approved default); copywriting PDF upload (Admin + Editor).
**Exit:** all five collection types managed and QA'd internally.

### Phase 5 — Client delivery (Pixieset replacement, last)
Public **client-delivery Worker**: signed links (hashed tokens, 30-day default expiry, optional passcode, revocation, `Referrer-Policy: no-referrer`), editorial gallery, favourites, downloads (**pre-built zip per publish-version** + signed streaming), watermarked premium paywall with server-side unlock checks on every path. Then retire Pixieset. Optional follow-ons: Stream, stage notifications.
**Exit (client launch gates):** paywall bypass attempts fail on asset/zip/signed-URL paths; link hardening verified; a real delivery replaces a Pixieset gallery.

---

## 7. Week-1 setup checklist (external registrations & secrets)

| # | Item | Owner/notes |
|---|---|---|
| 1 | Cloudflare account/zone confirmed; Workers Paid enabled; **Image Transformations enabled on the zone**; names reserved for 4 Workers; D1/R2/KV/Queues created per env (dev/staging/prod) | binding inventory doc kept in repo; no Container to provision |
| 2 | **Google Cloud OAuth client** (consent screen, redirect URIs per env, client ID/secret as wrangler secrets) | decide the Google account that owns it |
| 3 | **Confirm all staff have Google accounts** to allow-list (photographers, editors, any contractor) | the one prerequisite while Google is the only live login method; the first contractor without one is the trigger to build magic link |
| 4 | **Session/crypto secrets**: better-auth secret, cookie signing key, KEK for integration-token encryption — `wrangler secret put`, never in config files | rotate procedure noted |
| 5 | **Dropbox app** registration: scopes, redirect URI (admin connect flow), webhook endpoint registration; identify the studio account that will authorize it | autoHDR folder layout/ownership confirmed with the editor |
| 6 | **Tonomo**: webhook signing key exchanged; event contract (`order.created`/`updated`) confirmed; test payloads (already in `prototype/uploads/`) | |
| 7 | Vimeo credentials (for the Phase-3 integrations screen) | |
| 8 | **Initial admin bootstrap**: seed migration creates the first Admin user (Google email), so someone can sign in on day one | decide whose email |
| 9 | GitHub repo CI secrets (Cloudflare API token per env) + ordered-deploy workflow | |
| 10 | **AutoHDR API key** as `AUTOHDR_API_KEY` on the background Worker (`wrangler secret put`); local value only in `portal/workers/background/.dev.vars` | never in `wrangler.jsonc`, app bindings, browser code, or logs |

*(No transactional-email provider row: Google-only login needs none for now. Add Resend/Postmark + SPF/DKIM/DMARC whenever magic link is triggered by need, or if Phase 5 emails client links from the portal rather than out-of-band.)*

---

## 8. Risks (merged, current)

1. **Image Transformation wiring for private R2 originals** is the remaining unknown (not a new compute surface — the Container is gone). Mitigation: Phase-0 go/no-go spike proving authenticated-Worker → `cf.image` transform + QA quality + cost; fallback is persisting renditions to R2 after first transform, or a Lightroom-side derivative export contract if transforms disappoint.
2. **Owned auth is high-severity surface** a small team must maintain. Mitigation: better-auth (stable, maintained), Google-first rollout (smaller MVP surface than shipping both methods at once — no magic-link token/email paths until needed), closed provisioning, auth-specific tests in launch gates, scheduled dependency updates.
3. **Google-only login (for now) requires every current staff member to have a Google account.** Mitigation: confirm in week 1 (checklist #3); magic link stays in the approved design and drops in via the `sendEmail()` seam the moment a Google-less contractor needs access — build it then, not preemptively. No email SPOF exists in the MVP login path.
4. **Workflows GA/billing ambiguity** (new billing from Aug 10, 2026). Verify status at build time; volume makes cost impact negligible.
5. **Deploy-order fragility** across service-bound Workers. Mitigation: order encoded in CI + a bootstrap script for fresh environments.
6. **KV session eventual-consistency** (~60 s) on revocation. Accepted for a small staff; documented; D1 remains source of truth.
7. **R2 storage growth** is the real long-run cost. Add the cost dashboard (proposal §7) early and a retention policy decision before Phase 5.

---

## 9. Documentation cleanup queue (after plan approval)

Stale text that would mislead an implementer — to be patched in one pass:
- PRD §5 stage 1 "any RAW or image file, no format or size limit" → JPEG-only per D-01; §6.3/§4a prototype-era "Built" labels annotated as *prototype* capability.
- PRD §7 stage table → stable-key model, `client_review` removed from MVP (D-03); PRD §8 open questions 1–4 → resolved by D-07/D-08/D-04/D-03.
- PRD §6.6 "uploaded by the project admin" → Admin + Editor/QA (D-12).
- Personas §1/§2/§3 and Sitemap ✏️ marks → resolved per D-02/D-06/D-11/D-12 and contract decisions §3; Sitemap sign-in node → Google sign-in + session-expired states (magic link added when built); Sitemap RAW upload row → include Editor.
- Proposal → header note: "superseded on auth, renditions, admin backend, and stage model by Implementation-Plan.md v1.0."

---

## 10. Verification plan

- **Per phase:** Vitest + `@cloudflare/vitest-pool-workers` for API/capability/webhook logic; Playwright for the phase's critical flow; the phase's exit criteria (§6) are the definition of done.
- **Standing gates (all internal phases):** capability matrix enforcement tests, auth flow tests (Google OAuth callback, session revocation, deactivated/non-allow-listed lockout), ingest correctness + file-count verification, audit-log coverage of privileged actions, backup/restore drill (R2 versioning + D1 Time Travel export) before Phase 1 exit.
- **Client launch gate (Phase 5):** paywall enforcement attempts on every path, link expiry/revocation/passcode tests, no-referrer verification.
