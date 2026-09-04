# TB0 — Integrated Architecture, Authority Promotion, and Baseline Plan

> **Status: APPROVED AND ACTIONED, 2026-08-24.** D-16–D-19 approved by the owner that day
> (`Decision-Sheet.md`); every subsequent tracer bullet (TB0A onward) has been built against this
> authority package since. This header was never updated after approval — corrected 2026-09-04
> during a full TB0–TB8 completion audit. TB0 changed no product source, package dependency,
> schema, Worker configuration, or production resource itself; it is the documentation/decision
> phase every later bullet depends on.

**Plan drafted against:** `main` at `0c771df5bc00c8d6e81820b0c0762bfde6138ff2` on 2026-08-24

**Detailed-package baseline:** `2ac2ca27a1e0ded328b9265613ab4ebeeb7db1b0`

**Primary sources:** `Quincy-Portal-Revamp-Brief.md` (authoritative where it corrects the package),
`Quincy-Portal-Revamp-Index.md`, and `revamp_2026_portal/roadmap/TB0-Integrated-Architecture-And-Baseline.md`

## What this phase resolves

The detailed revamp package is a coordinated proposal, not repository authority. It also predates
PR #44's direct send-only AutoHDR handoff and still contains superseded authority numbering and
several superseded External Editor/Calendar statements. Starting TB0A or any later tracer bullet
without reconciling those facts would let an implementation plan cite mutually inconsistent
contracts.

TB0 turns the reviewed proposal into one reviewable authority diff, establishes a reproducible
React 18.3.1/current-product baseline, records all material drift from the detailed-package
baseline through execution-time `main`, and creates the two next repository-native plan documents.
It does not build either next phase.

The corrected authority proposal is:

- four new decisions, **D-16 through D-19**;
- inline revisions to the existing **D-13** and **D-15**, following D-14's historical-revision
  convention; and
- Implementation Plan amendments **A8 through A14**.

The stale six-new-decision mapping in the TB0 scope brief and active package is not authority. In
particular, React 19.2 belongs to revised D-15, Production Calendar/checklist scheduling belongs to
revised D-13, and External Editor becomes D-19.

## Scope

TB0 includes only:

1. a pre-change repository/process/verification gate;
2. current/prototype matched evidence, build-output capture, and a durable drift register;
3. a separately owner-approved additive promotion into `Decision-Sheet.md` and
   `Implementation-Plan.md`;
4. corrected product outcomes in `PRD.md`, mirrored target-vs-live guidance in `AGENTS.md` and
   `CLAUDE.md`, and accurate `todo.md` status;
5. propagation of the Brief's corrections and execution-time current facts through the active
   revamp package; and
6. creation and review of separate TB0A and TB0B implementation plans.

### Explicit non-goals

- No edits under `portal/` or `prototype/`.
- No `package.json` or lockfile change, dependency install/update, React 19 upgrade, Tailwind,
  shadcn, FullCalendar, source refactor, schema/migration, Worker config, secret, deployment, or
  production mutation.
- No implementation of TB0A, TB0B, or any later tracer bullet.
- No Calendar or External Editor screenshots fabricated before those surfaces exist.
- No rewrite of `docs/plans/implemented/`, archived package material, or historical authority
  text whose history should remain visible.
- No claim that a planned target is implemented or live.

## Deliverables and durable locations

Create one self-contained baseline area under the active package:

```text
docs/plans/revamp_2026_portal/baseline/TB0/
├── Baseline-Report.md
├── Drift-Register.md
└── evidence/
    ├── current-main/
    └── prototype/
```

`Baseline-Report.md` records the compared SHAs, capture date, role/data fixture, URLs, exact gate
commands and results, browser/console/network observations, Vite bundle output, and raw/gzip byte
counts for emitted JavaScript and CSS. `Drift-Register.md` owns classifications and phase
assignments. PNG filenames use
`<surface>--<state>--<width>x<height>.png`; matched current/prototype captures use the same stem.
Do not store screenshots in this plan's directory or as transient session-only artifacts.

## Execution plan

### 1. Establish the pre-change gate

Before editing any TB0 deliverable:

1. Branch from and record execution-time `main`; record both `git rev-parse HEAD` and
   `git merge-base HEAD origin/main`. Require a clean worktree or identify every pre-existing
   change and keep it out of TB0. Do not absorb unrelated work.
2. Re-read, at that recorded SHA:
   - root `AGENTS.md` and `CLAUDE.md` and confirm their bodies below the reciprocal opening
     comments still match;
   - `docs/Decision-Sheet.md`, `docs/Implementation-Plan.md`, and the affected `docs/PRD.md`
     sections;
   - `docs/todo.md` Current state/Open plans and `docs/lessons.md`;
   - `docs/Subagent-Orchestration.md` policy 7 and §5;
   - the Brief, Index, package README, current-state audit, document update map, roadmap README,
     TB0/TB0A/TB0B scope briefs, and every active package file found by the consistency searches
     in step 5.
3. Confirm the detailed baseline commit exists locally and record the complete commit range
   `2ac2ca27a1e0ded328b9265613ab4ebeeb7db1b0..HEAD`. The comparison endpoint is the recorded
   execution SHA, never a moving branch name.
4. From `portal/`, run and record the full repository gate exactly as required by the guides:

   ```bash
   npm run typecheck
   npm run build -w @quincy/web
   npm run test --workspaces
   npx vitest run --config packages/shared/vitest.config.ts
   ```

   Record command, start/end time, exit status, test counts/skips, and relevant failure output in
   `Baseline-Report.md`. The fourth command is mandatory because the workspace test command skips
   `packages/shared`.
5. Preserve the Vite build summary, then inventory every emitted JS/CSS asset with its filename,
   raw bytes, and gzip bytes. Record total JS, total CSS, and total build bytes. This is the TB0A
   comparison baseline; do not optimize or regenerate source to improve it.
6. If a gate is red, stop authority editing. Classify the failure as pre-existing evidence in the
   drift register, independently reproduce it, and ask the owner whether it must be fixed outside
   TB0 or accepted as a named baseline exception. A dirty or unexplained red baseline must not be
   presented as revamp-induced drift.

### 2. Capture matched visual and behavioral evidence

Build the unchanged web bundle, run the local app Worker, and browse
`http://localhost:8787` directly; do not use the Vite `5173` proxy. Authenticate only through the
documented local Google OAuth flow as the seeded Admin; its real Google token exchange is the sole
permitted third-party call during capture because local auth already depends on it. Before capture,
inventory every D1, R2, KV, Queue, and service binding the app path uses and prove that each resolves
to a local resource. Do not use a Wrangler remote-mode flag, a production/staging binding, or any
endpoint that can fall through to a deployed Worker or remote data store. Block outbound calls to
real third-party integrations, including Dropbox, AutoHDR, Tonomo, Vimeo, email-delivery providers,
Cloudflare remote Image Transformations, and production webhook/integration endpoints; use local
fakes, request blocking, or disabled bindings and record the mechanism in the baseline report.

Use only synthetic, non-sensitive fixtures in disposable local state, populated through existing
supported UI/API flows or existing test fixtures; never use real client data. Record the setup in the
baseline report and do not edit seed/source files or write raw session/database rows. Use the
session's available browser-automation tooling to open each local URL, set the exact viewport, and
inspect console/network state. The public prototype may be captured with the same tooling. Do not use
production as an evidence source for this capture. Save every screenshot to a location outside the
repository first. Only after a redaction check confirms that no secret, signed URL, token, provider
UID, private Dropbox path, client contact, billing data, or other sensitive value is visible may the
file be copied into `evidence/`; record that check in the screenshot manifest. Do not forge sessions
or edit D1 to manufacture a state.

Capture equivalent role/content at exactly:

- 1440×900;
- 1024×768; and
- 390×844.

The base surface matrix is:

| Surface | Required current state(s) | Prototype comparison |
|---|---|---|
| Sign-in and application shell | signed-out; signed-in navigation | closest equivalent shell/sign-in |
| Dashboard | populated List; populated Kanban; active/archived treatment where available | same role/view/content class |
| Project Workspace | overview rail; RAW and Edited collection grids; responsive navigation | same project/collection class |
| Review Lightbox | open; filmstrip; compare; existing annotation/markup state | equivalent open/overlay states |
| Collaboration | panel closed/open; populated comments/checklist; permission/read-only state reachable without mutation | equivalent collaboration or mark N/A |
| Create/Edit Project | representative form, focus/error treatment obtainable without committing a mutation | equivalent form |
| Admin | Users, Directory, Pipeline, Integrations | equivalent existing admin surfaces |
| Notice Board and notifications | populated/open overlays; empty or unread treatment if already present | equivalent surface or mark N/A |

For material states—empty, populated, loading, error, focus, open, read-only, permission-denied,
pending, and responsive overflow—capture each state that can be reached without changing product
source or mutating production. Local browser throttling/request blocking may be used to expose a
real loading/error path, and the method must be recorded. Mark a state `N/A — not present in this
baseline` rather than fabricating future Deadline, Calendar, conflict, overdue, or External Editor
behavior. Record screenshot pairs and console/network observations in the baseline report's
manifest. A screenshot is evidence of rendering, not proof of successful media/API loading; record
network status for those claims.

### 3. Create the modular drift register

Seed `Drift-Register.md` from the Index; do not re-derive PR #44's AutoHDR contract from scratch.
Create an umbrella entry for PR #44 and one linked child entry for each boundary in the Index's
**Baseline drift: direct send-only AutoHDR** table: explicit action, claim/idempotency,
credentials/media, send-only scope, provider retry, Stage ownership, jobs/freshness,
notifications/activity, and authorization/privacy. Copy the Index's contract faithfully, cite its
section, and link the relevant PR/commit. Derive each child's later tracer-bullet assignments by
cross-referencing that boundary-organized table with the phase-organized bullets in **AutoHDR
compatibility checkpoints by tracer bullet**; the Index does not state the boundary-to-phase
mapping directly.

Then inspect the full baseline-to-current range with commit log, diff/stat, authority docs,
source/tests/config, and the evidence matrix. Include PR #44 and every later commit through the
recorded execution SHA, including documentation-only changes when they alter authority, planning,
or claimed current state. Every material difference gets one row:

| Field | Required content |
|---|---|
| ID / parent | Stable `TB0-<area>-NN` ID and optional parent (for modular child entries) |
| Area / surface | Authority, product contract, source, test, config, UI surface, build output, or operations |
| Baseline evidence | Baseline SHA plus file/line, screenshot, or recorded command result |
| Current evidence | Execution SHA plus matching evidence |
| Origin | Commit/PR and summary; `unknown` is allowed only temporarily |
| Classification | `Conforming`, `Intentional evolution`, `Required platform/accessibility/security change`, `Unwanted drift`, or `Unassessed` |
| Compatibility boundary | AutoHDR/security/data/URL/role/visual boundary affected, or `none` |
| Owner / phase | TB0A, TB0B, a later named tracer bullet, owner decision, or out-of-program follow-up |
| Disposition / status | Preserve, promote, correct, defer, remove later, or blocked; open/accepted/verified |
| Verification | Test/evidence/authority link and reviewer/date |

No material row may remain unassigned. `Intentional evolution` and deferral require owner
disposition. Objective platform/accessibility/security corrections remain evidenced and reviewed.
`Unassessed` blocks TB0 acceptance. Update the active package's stale current-state statements from
this register; do not replace current `Implementation-Plan.md` or `PRD.md` with older package text.
For a row assigned to TB0A or TB0B, an accepted owner disposition is a hard prerequisite to that
phase plan passing review. The owner disposition must either resolve the row before review or
explicitly designate it as still open and blocking; in the latter case, carry it into that phase
plan as a blocking decision with the competing outcomes stated. Never leave it in the register for
the builder to interpret silently. A plan that neither resolves nor explicitly blocks on each of
its assigned rows cannot pass review or hand off to implementation.

### 4. Owner checkpoint before authority promotion

Completion or approval of this plan is **not** permission to edit the authority files. After the
pre-change gate, evidence, and drift register are reviewable, present the literal wording below
and obtain a separate written owner instruction. The instruction must either repeat this literal
sentence:

> Approve the TB0 authority wording; apply the D-13/D-15 revisions, D-16–D-19, and A8–A14.

or explicitly name both approved ranges—revised D-13/D-15 plus D-16–D-19, and A8–A14. In either
form, the approval record must cite the specific plan revision reviewed, using this plan's git blob
hash or its containing commit SHA at review time. Generic acknowledgements such as “looks good,”
“continue,” or “yes go ahead” do not satisfy the checkpoint. Neither does any earlier approval of
this plan document: authority approval is a separate, distinct act. Before either authority file is
touched, quote the approval message verbatim, with its cited revision, into the plan's execution
record or `Baseline-Report.md`.

If the owner amends any wording, first update this plan's proposed text, run the required plan
review on the amendment, and obtain explicit approval of the revised text. Stop before editing
`Decision-Sheet.md` or `Implementation-Plan.md` until that happens.

## Exact proposed authority diffs

### `docs/Decision-Sheet.md`

Preserve every existing row and its historical approval text. Update `Last updated` to the actual
authority-approval date, leave the existing `Approved on: 2026-07-19` field unchanged, and insert
this distinct frontmatter field immediately after it:

```text
Authority revision approved on: <approval-date>
```

In the existing **Can defer** table, replace only the existing D-13 data row with this single data
row (do not add another header or separator):

```markdown
| D-13 | What happens to Clients and Schedule nav stubs? | A. Leave hidden or stubbed until needed. B. Build both in MVP. C. Remove permanently. | **D — Custom: Clients remain deferred; authorize Production Calendar and checklist scheduling (revised `<approval-date>`).** Add Calendar as a third Dashboard view after its prerequisite tracer bullets, backed by the approved project Deadline and additive checklist due/range schedule contracts. | Production scheduling is now an approved operational need, while a Clients management surface still does not block the production pipeline. Keeping the two nav decisions coupled under the old blanket deferral would hide that distinction. | flow / UI / schema / API | Sitemap §Top-level structure/§Screen-by-screen routing notes; PRD §9; Quincy Portal Revamp Brief §Authority proposal; Implementation-Plan §2 A13 | Change: ✓ Clients remain deferred; Schedule becomes the approved Production Calendar program |
```

In the existing **Blocking before coding** table, replace only the existing D-15 data row with this
single data row (do not add another header or separator):

```markdown
| D-15 | Confirm frontend stack. | A. React 18 + TypeScript + Vite SPA with Quincy design system and Hono RPC. B. React Router SSR by default. C. Different frontend framework. | **D — Custom: latest stable pinned React 19.2 patch + TypeScript + Vite SPA reusing the Quincy design system, internal API via Hono RPC (revised `<approval-date>`).** Revise only the React/React DOM runtime major through TB0A; retain the rest of the approved stack. | A standalone compatibility release modernizes the supported React runtime without authorizing a framework/router migration, SSR, Server Components, React Compiler, or product redesign as collateral work. | UI / architecture / API / runtime | Implementation-Proposal §1/§6.1/§6.2; Quincy Portal Revamp Brief §Authority proposal; Implementation-Plan §2 A12 | Change: ✓ React 19.2 patch only; TypeScript/Vite SPA/Quincy/Hono retained |
```

Append these four data rows to the existing **Blocking before coding** table, immediately before the
**Can defer** heading (reuse the table's existing header and separator; do not append new ones):

```markdown
| D-16 | What UI platform and convergence contract should govern the revamp? | A. Tailwind CSS v4 plus source-owned shadcn components under Quincy visual authority. B. Keep every surface on unconstrained hand-authored CSS. C. Replace the SPA/design system wholesale. | **A — adopt Tailwind CSS v4 and source-owned shadcn incrementally only after TB0A and TB0B are live.** Use Base UI/Sera/Lucide, semantic Quincy tokens, controlled/disabled Preflight initially, no dark mode, and fixed matched evidence at 1440×900, 1024×768, and 390×844. FullCalendar's official shadcn registry is one later reviewed specialist exception, not visual authority. | This creates a maintainable component platform while preserving Quincy's fonts, geometry, signals, accessibility, working product behavior, and evidence-led convergence instead of shipping a stock framework aesthetic or a rewrite. | UI / accessibility / architecture / delivery sequence | Quincy Portal Revamp Brief §Program outcomes; revamp package core/11 | Approve ☑ |
| D-17 | What architecture should govern freshness, collaboration, notifications, pipeline semantics, and Kanban? | A. Preserve deep routes and Quincy-owned Cloudflare data while modernizing each boundary incrementally. B. Replace routing/state/collaboration wholesale with an external platform. C. Leave current freshness and ordering behavior unchanged. | **A — keep the typed custom router and adopt TanStack Query incrementally; keep discussions, read state, activity, and notification delivery Quincy-owned on Cloudflare.** Use route/resource/range-aware query identities, bounded refresh and draft/interaction preservation; a D1 outbox + Cloudflare Queue with send-time authorization; fixed semantic Stage identities; developer-managed global Stage order; and `boardPosition` as the sole persisted manual Kanban order before dnd-kit interaction modernization. | The current product already has valuable routes, comments, notifications, AutoHDR/job refresh, and Kanban behavior. Incremental ownership changes preserve those contracts, prevent cross-project/access leakage and duplicate semantic events, and avoid a rewrite. | UI / data lifecycle / notifications / pipeline / Kanban / Cloudflare | Quincy Portal Revamp Brief §§Program outcomes, Data/discussion/notifications; revamp package core/05–08 | Approve ☑ |
| D-18 | Where should project coordination live, and how are Stage, Deadline, team, and Editor-wide changes governed? | A. Make the Project Workspace left rail canonical. B. Keep project-level controls duplicated in Collaboration/Edit Project. C. Create a separate coordination product. | **A — make the Project Workspace left rail canonical for Stage, project Deadline/reminders, Photographers, and Editors; keep Collaboration focused on checklist/subtasks and project discussion.** Retain `editProject` for roster and Deadline writes; introduce `moveProjectStage` for every Stage movement path; use Sydney civil-time/version rules for Deadline reminders; and deliver approved role-safe project changes to eligible assigned Editors through the durable registry. | One canonical operational surface prevents conflicting ownership while preserving task-level collaboration. Shared guarded commands, membership cycles, Deadline revisions, and finite notification rules keep rail, Kanban, and delivery behavior coherent. | flow / UI / auth / schema / notifications / Kanban | Quincy Portal Revamp Brief §§Canonical coordination model, Project Deadline; revamp package core/03, core/07, core/08 | Approve ☑ |
| D-19 | How should non-employee External Editors access Quincy production work? | A. Add a distinct assignment-scoped global role with a shared safe projection. B. Reuse the internal Editor role and broad access. C. Create a separate portal/data copy. | **A — add global role `external_editor`, displayed External editor, while retaining existing project membership role `editor`.** Require current assignment for every project surface; grant only the explicit approved production/collaboration capabilities; withhold broad project, Admin, Notice Board, delivery/publish, RAW-selection, extras, and AutoHDR administration; and enforce one shared server-side external-safe projection, role/session lifecycle, project-scoped participant contact, and assigned-scope Calendar. | A distinct least-privilege role lets contractors work across assigned productions without exposing unrelated projects, internal notes/contact/billing/Dropbox/provider data, staff-wide surfaces, or Admin operations. | auth / privacy / schema / API / UI / notifications / Calendar | Quincy Portal Revamp Brief §External Editor; revamp package core/13 | Approve ☑ |
```

Replace the single historical footer with:

```text
Decisions D-01–D-15 approved on 2026-07-19 by mjj2332@gmail.com.
D-13 and D-15 revised; D-16–D-19 approved on <approval-date> by mjj2332@gmail.com.
```

`<approval-date>` is a mechanical placeholder, replaced with the date of the explicit authority
approval; it is not an invitation to change the approved substance.

### `docs/Implementation-Plan.md`

Preserve A1–A7 and every current AutoHDR addition verbatim. Update the status line to:

```text
> **Status:** v1.1 · <approval-date> · Approved through A14 (v1.0 · 19 July 2026)
```

Replace the current header line

```text
> **Authority order:** `Decision-Sheet.md` (approved 2026-07-19) → this plan → `PRD.md` → `Implementation-Proposal.md` → `Personas.md` / `Sitemap.md`
```

with:

```text
> **Authority order:** `Decision-Sheet.md` (D-01–D-15 approved 2026-07-19; D-13/D-15 revised and D-16–D-19 approved <approval-date>) → this plan → `PRD.md` → `Implementation-Proposal.md` → `Personas.md` / `Sitemap.md`
```

Replace the current header line

```text
> **Inputs:** repo inventory, Cloudflare platform compatibility audit (2026-07-19, retrieval-based), independent cross-doc consistency review (Codex, 21 findings), approved Decision Sheet D-01…D-15.
```

with:

```text
> **Inputs:** repo inventory, Cloudflare platform compatibility audit (2026-07-19, retrieval-based), independent cross-doc consistency review (Codex, 21 findings), approved Decision Sheet D-01…D-19 (D-13/D-15 revised <approval-date>).
```

These replacements keep the original v1.0 date visible in the file and preserve its provenance in
the document history while making the promoted header agree with the approved through-A14 status.

In §3, replace contract decision 6:

```text
6. **Clients / Schedule nav (D-13):** **hidden in production MVP** (not rendered), not stubbed.
```

with:

```text
6. **Clients / Schedule nav (D-13, revised <approval-date>):** **Clients remain hidden and not stubbed.** The Schedule half is superseded by A13: Calendar ships as a third Dashboard view after its prerequisite tracer bullets; planned, not live.
```

Append the following text after A7 in §2. A1–A7 in the live file are `###`-level headings; the
A8–A14 headings below are shown one level deeper (`####`) only for nesting inside this plan
document's own `### docs/Implementation-Plan.md` section — when actually appended to
`Implementation-Plan.md` itself, apply them at `###`, matching A1–A7:

A8–A14 (added `<approval-date>`) amend this plan's program scope under revised D-13/D-15 and
D-16–D-19; they do not amend `Implementation-Proposal.md`.

#### A8 — UI platform and design convergence (D-16)

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

#### A9 — Route-aware server-state freshness (D-17)

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

#### A10 — Discussions, activity, durable notifications, fixed pipeline semantics, and Kanban (D-17)

Project discussion remains one flat, project-scoped, newest-first stream with rich text, mentions,
author-only edit/delete, cursor pagination, and server-owned read state. The staff Notice Board
remains asynchronous and Quincy-owned; TB7 synchronizes only each user's read/unread state across
their devices. Structured product activity is separate from security audit and recipient inbox
rows.

Durable delivery uses a D1 outbox, Cloudflare Queue, recipient/channel ledger, recovery scan, and
DLQ. Every dispatch re-checks current active status, role, capability, membership cycle, and event
visibility immediately before send. Failed reauthorization is silently dropped without retry or
user-visible error and is audit-logged. Ambiguous email acceptance is `unknown`, not automatically
retried. One producer owns each semantic event; coalescing limits noise without falsifying committed
activity.

Stage machine identities remain
`awaiting_raw → raw_review → editing_autohdr → edited_review → delivered`; display order never
redefines automation. TB0B moves global Stage ordering out of ordinary Admin self-service while
preserving label/active management. `boardPosition` is the sole persisted manual Kanban order;
Priority and shoot-date views are non-writing sorts; TB5B later replaces native drag with dnd-kit.
PR #44's Admin-only direct AutoHDR send remains a separate send-only operation: manual Stage
movement never sends/cancels work, provider credentials/UID/diagnostics remain private, ambiguous
provider outcomes reconcile the existing job/UID, and finalization plus its guarded Stage advance
produces durable activity/notification exactly once only after provider acceptance.

#### A11 — Project Workspace coordination, including the `moveProjectStage` Stage capability and the Stage/order contract TB5A delivers (D-18)

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

#### A12 — React 19.2 compatibility-only runtime upgrade (D-15, revised `<approval-date>`)

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

#### A13 — Checklist scheduling and Production Calendar (D-13, revised `<approval-date>`)

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

#### A14 — External Editor assigned-scope authorization (D-19)

Add a fourth global account role `external_editor`, displayed **External editor**, with its own
explicit capability entry. Project membership remains the existing `editor` role. External
Editors never receive `viewAllProjects`; every list, search, direct route, media, Collaboration,
quick-detail, notification, and Calendar surface requires current explicit project membership and
server-side scope. They have no Photographer Stage restriction and no ordinary archived-project
access.

The complete initial allow-list is `uploadEdited`, `viewRaw`, `annotateRaw`, `recommendRaw`,
`compareFrames`, `viewEdited`, `reviewEdited`, `annotateEdited`, and `collaborateOnProject`, plus
`moveProjectStage` when TB5A ships and `viewProductionCalendar` when TB5C ships. Explicitly withhold
`publish`, `viewClientPreview`, `downloadFinal`, `manageExtras`, `selectForEditing`, `uploadRaw`,
`viewNoticeBoard`, project create/edit/archive, Admin/user/directory/integration/pipeline/
prioritization, the staff Notice Board, AutoHDR send, and provider/job diagnostic capabilities.

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

After the inserted amendments, add this approval note without rewriting the original v1.0
provenance:

```text
> **A8–A14 approved:** <approval-date> by mjj2332@gmail.com. D-13 and D-15 were revised inline;
> D-16–D-19 were added. Planned outcomes remain targets until their owning tracer bullets are
> implemented, verified, committed, deployed, and recorded live.
```

### 5. Apply the approved edits and synchronize active package authority

Only after the checkpoint in step 4:

1. Apply the exact Decision Sheet and Implementation Plan changes additively. Before continuing,
   diff those two files alone against pre-edit `HEAD` and confirm A1–A7 plus the PR #44 AutoHDR
   wording are byte-for-byte preserved except for the declared header/footer insertions.
2. Propagate the Brief's corrected numbering into the five files its header explicitly names:
   `Quincy-Portal-Revamp-Index.md`, package `README.md`, `core/01-Decision-Register.md`,
   `core/10-Repository-Document-Update-Map.md`, and the TB0 scope brief. Use D-16–D-19 plus revised
   D-13/D-15 everywhere.
3. Also update active routing/index duplicates revealed by the bounded consistency search—notably
   `roadmap/README.md` and `handoff/Next-Agent-Prompt.md`. These are mechanical propagation, not
   new authority. Do not edit `archive/`.
4. Propagate the Brief's other three explicit corrections through every contradictory active
   package occurrence:
   - External Editor allow-list/withheld capabilities in TB4E and duplicated active core/PRD/handoff
     guidance;
   - internal `projects.notes` plus new external-safe `productionNotes`, with no data copy; and
   - wall-clock-preserving checklist range drag/Month moves across DST, replacing
     duration-preserving language in TB5C and duplicated active scheduling/PRD guidance.
5. Reconcile `core/02-Current-State-Audit.md`, package README caveats, and any other active file
   claiming “current” against the recorded execution SHA and drift register. Add the PR #44
   send-only AutoHDR current fact and compatibility boundaries; preserve the Index's production
   safety gate. Update baseline/current-SHA metadata precisely. A target stays labelled planned.
6. Run both stale-text sweeps after the primary authority edits:
   - Search `docs/Decision-Sheet.md` and `docs/Implementation-Plan.md` themselves for every remaining
     `D-13` and `D-15` reference. Explicitly reconcile every hit with the promoted decisions; do not
     assume the enumerated header/row/§3 edits are exhaustive. Leave `Implementation-Plan.md` §6
     Phase 0's shipped-phase React 18 historical record unchanged; React 18.3.1 remains the live PRD
     baseline until TB0A/TB1 actually ship.
   - Search the active package for `D-16–D-21`, React-as-D-19, `D-20`, `D-21`, the superseded
     External Editor grants, external visibility of `projects.notes`, and duration-preserving range
     drag. Every active-package hit must be corrected or annotated as a quotation/historical note.

### 6. Merge product outcomes into `docs/PRD.md`

Merge product behavior, not implementation-library/schema detail, and retain current/live facts:

- §§1–2: add the incremental revamp objective and product outcomes; do not describe it as a
  rewrite.
- §§3–4: add External Editor as a fourth internal-production persona/role with the exact A14
  allow-list, assigned-only scope, withheld capabilities, privacy bounds, and lifecycle. Keep
  AutoHDR Admin-only and server-projected.
- §5 and §7: preserve the current direct send-only AutoHDR description and fixed semantic Stage
  progression; state that manual Stage movement never invokes AutoHDR.
- §6.1: add planned Calendar beside List/Kanban, its authorized audience, URL/filter behavior, and
  Deadline/checklist event model.
- §6.2: make the left rail the planned canonical Stage/Deadline/Photographer/Editor surface and
  keep Collaboration task/discussion-focused.
- §6.8: merge flat discussion, server-owned read state, activity, durable role-safe notification,
  and access-loss outcomes.
- §6.9: correct pipeline configuration so ordinary Admins retain labels/active state but not global
  ordering after TB0B.
- Add a clearly planned scheduling/Calendar subsection for project Deadline, checklist
  unscheduled/due-only/range semantics, Sydney DST behavior, Month/Week/Agenda, filters/shareable
  state, authorized range data, guarded direct manipulation, accessibility, Unscheduled behavior,
  and no recurrence/external sync.
- §8: keep React 18.3.1 and the current dependency inventory labelled live until TB0A/TB1/TB5C
  deploy. Add target notes only; do not make the technical summary claim React 19, Tailwind,
  shadcn, FullCalendar, Calendar, or External Editor is installed/live.
- §§9–10: mark the Schedule half of D-13 resolved, leave Clients deferred, and move only approved
  notification/Calendar outcomes out of “parked.”

Use the Brief's corrections over stale `core/03-PRD-Delta.md`: External Editors do not gain
publish/client-preview/final-download/extras/RAW-selection, `projects.notes` is internal, and range
drag/Month moves preserve wall-clock endpoints rather than elapsed duration. Preserve all current
PR #44 authority text.

### 7. Update `AGENTS.md` and `CLAUDE.md` as mirrors

The files currently differ only in their reciprocal opening comments; everything below those
comments is byte-for-byte mirrored. Retain each comment, then apply the same substantive body edit
to both and prove equality after stripping only that opening comment.

- Update the authority-chain sentence to D-01–D-19, explicitly noting revised D-13/D-15.
- Keep `portal/` described as React 18.3.1/current until TB0A is live.
- Add one concise **Approved revamp targets — not live until their tracer bullet deploys** block:
  React 19.2 compatibility-only; incremental Tailwind/shadcn under Quincy authority; route/resource/
  range query keys with draft/drag preservation; rail versus Collaboration ownership;
  role-specific membership cycles; `moveProjectStage` and fixed Stage semantics; Deadline separate
  from shoot/checklist schedules; finite/noise-bounded delivery registry; checklist due/range
  contract; authorized Calendar range/direct-manipulation boundary; and assignment-scoped
  `external_editor` through one external-safe server projection with no Notice Board/global
  directory/Admin scope.
- Add the PR #44 preservation rule: direct AutoHDR send is Admin-only/send-only, distinct from
  Stage movement, credentials remain on the background Worker, and later phases must not revive
  direct-path retrieval/polling or duplicate semantic delivery.
- Keep verification, deploy, migration, local-auth, and brand facts current; do not add anticipated
  migrations or dependencies.

### 8. Add the `docs/todo.md` umbrella/current-state entry

Insert this as the newest Current state bullet only after the facts represented by its placeholders
are true. Replace placeholders from recorded evidence; do not pre-announce completion. The drift
register counts as **reviewed** only after every row has an accepted owner disposition; while any
disposition remains open, describe the register as open/draft and do not use the template's reviewed
claim:

```markdown
- **Quincy Portal revamp TB0 is the active authority/baseline phase; TB0 itself changes no product
  source, dependency, schema, Worker, or production resource.** The owner approved the corrected
  authority package on `<approval-date>`: D-13 and D-15 revised inline, four new decisions D-16–D-19,
  and Implementation Plan amendments A8–A14 (`docs/plans/TB0-Integrated-Architecture-And-Baseline-Plan.md`).
  The current-main baseline at `<execution-main-sha>` is recorded under
  `docs/plans/revamp_2026_portal/baseline/TB0/` with the full verify result, 1440×900 / 1024×768 /
  390×844 matched evidence, bundle/CSS output, and a fully dispositioned, reviewed drift register.
  PR #44's Admin-only,
  direct send-only AutoHDR handoff is carried forward as existing authority/source baseline, not a
  revamp tracer bullet. Separate repository-native TB0A (React 19.2 compatibility-only) and TB0B
  (developer-managed pipeline-order boundary) plans are `<review-status>`; neither phase is built
  or live. TB0A must not start until this authority promotion and its own reviewed plan are accepted,
  and Tailwind/shadcn must not start until TB0A and TB0B are live.
```

Also add the two new plan filenames to Open plans with their actual review state. Do not mark
Calendar, External Editor, React 19, Tailwind, or shadcn live. The template above is an active-phase
entry, not TB0's terminal state. Once TB0 is accepted, replace the active wording with the real
completed/accepted state in the authority-promotion close-out commit and accurately state the final
disposition and TB0A/TB0B review states. Because a commit cannot record its own hash, immediately
follow it with a small documentation-only commit that records the authority-promotion commit hash
in this todo bullet. Do not leave TB0 marked active after it has closed.

### 9. Create—but do not execute—the TB0A and TB0B plans

Create separate repository-native files:

```text
docs/plans/Revamp-TB0A-React-19-2-Runtime-Upgrade-Plan.md
docs/plans/Revamp-TB0B-Pipeline-Configuration-Boundary-Plan.md
```

Each plan must re-check execution-time `main`, cite its roadmap scope brief and accepted authority,
name exact files/owners/tests/rollback, preserve the drift-register and AutoHDR boundaries assigned
to it, and pass the repository's complete plan-review pipeline. TB0A owns only the React 19.2
compatibility release; TB0B owns only the global pipeline-configuration boundary. This TB0 plan
does not pre-draft their file-by-file implementation content, choose execution-time package
versions, or authorize either build. Later tracer-bullet plans are created only when their upstream
contracts are accepted and current.

Before either plan can pass review, every drift-register row assigned to that phase must have an
accepted owner disposition. That disposition must resolve the row or explicitly designate it as
still open and blocking; if blocking, list it in that phase's plan with its unresolved alternatives
and owner. A reviewer must reject a plan that silently leaves any assigned row for its builder to
interpret.

### 10. Independent review and final gate

Authority editing is not final on the editor's or any agent's self-report. After all TB0 document
changes and the two next-plan drafts exist:

1. Run a fresh, read-only independent diff review under `docs/Subagent-Orchestration.md`. The
   reviewer checks the exact approved wording, additive history preservation, authority order,
   Brief corrections, PR #44 compatibility, target-vs-live labels, matched evidence completeness,
   drift classifications/assignments, and TB0A/TB0B scope isolation.
2. Apply findings through the normal capped review loop. Any change to approved D/A substance
   returns to the explicit owner checkpoint; a reviewer cannot silently rewrite authority.
3. In the orchestrating session, perform §5 directly: read the authority/security/current-state
   diff, confirm the evidence files exist, prove `AGENTS.md`/`CLAUDE.md` body parity, run stale-text
   searches, and independently rerun all four verify commands from `portal/`.
4. Run `git diff --check`, inspect `git status --short`, and confirm there are no `portal/`,
   dependency, lockfile, migration, Worker-config, secret, or generated-source changes.
5. Commit only after the §5 gate passes and the owner separately authorizes the commit. There is no
   deployment in TB0. Do not begin TB0A until both the authority promotion and the reviewed TB0A
   plan are accepted. Do not initialize Tailwind/shadcn until TB0A and TB0B are live.

## Risks and rollback

- **Authority history loss:** broad replacement could erase A1–A7 or PR #44. Mitigation: additive
  inserts, file-scoped diff, and explicit byte-preservation check. Roll back only the TB0 authority
  commit; never restore older whole files over current authority.
- **Proposal/live confusion:** PRD/guides may accidentally state planned dependencies/features are
  live. Mitigation: retain current React 18.3.1 inventory and add explicit target labels.
- **Incomplete package correction:** duplicated stale numbering/capability/notes/DST language can
  mislead a narrow-path reader. Mitigation: bounded active-package searches plus reviewer sign-off;
  archives remain historical.
- **Baseline contamination:** unexplained test failure or dirty worktree can be misattributed to
  revamp drift. Mitigation: stop before edits and require independent reproduction/owner
  disposition.
- **Evidence isolation/privacy:** a misbound local Worker or integration call could touch deployed
  data or expose client/contact/provider details. Before capture, prove every used D1/R2/KV/Queue/
  service binding is local, prohibit Wrangler remote mode and production/staging fallthrough, and
  block every real third-party integration and Cloudflare remote Image Transformation except local
  auth's Google token exchange. Use only synthetic, non-sensitive fixtures. Capture screenshots
  outside the repository first; copy them into `evidence/` only after a recorded redaction check
  verifies that no secret, signed URL, token, provider UID, private Dropbox path, client contact,
  billing data, or other sensitive value is visible.
- **No product rollback exists for TB0:** it ships no product. Document rollback is a targeted
  revert/forward correction after owner review; evidence and drift history should be retained.

## Acceptance checklist

- [ ] Execution-time `main`, clean-worktree state, detailed baseline SHA, and complete commit range
      are recorded.
- [ ] AGENTS/CLAUDE, authority docs, todo, lessons, orchestration policy, Brief/Index, and required
      package paths were re-read at that SHA.
- [ ] Both pre-change and final independent gates ran all four required commands; every result is
      green or a pre-existing failure has independent evidence and explicit owner disposition.
- [ ] `Baseline-Report.md` records Vite output and per-asset/total raw+gzip JS/CSS sizes.
- [ ] Matched current/prototype evidence exists at 1440×900, 1024×768, and 390×844 for every
      applicable base surface; material states are evidenced or explicitly N/A with reason.
- [ ] Screenshot claims involving API/media loading have matching console/network observations,
      every used binding was proven local, real integrations were blocked except the documented
      Google token exchange, only synthetic data was used, and committed evidence passed the
      outside-repository redaction check with no private data or credentials.
- [ ] Every material baseline-to-current difference has a stable drift ID, evidence, origin,
      classification, compatibility boundary, owner/phase, disposition, status, and verification.
- [ ] PR #44 plus every later commit through execution `HEAD` is represented; the Index's
      **Baseline drift: direct send-only AutoHDR** boundary table and **AutoHDR compatibility
      checkpoints by tracer bullet** phase-organized bullets are formalized without weakening or
      re-deriving them, with each boundary-to-phase assignment derived by cross-referencing the two
      organizations rather than treated as a directly listed mapping.
- [ ] No `Unassessed` or unassigned material drift remains; owner dispositions are recorded for
      intentional evolution/deferral.
- [ ] Every TB0A/TB0B-assigned drift row has an accepted owner disposition; any disposition that
      leaves the row open explicitly marks it blocking and names it in that phase's plan before its
      review can pass.
- [ ] The owner explicitly approved the literal D-13/D-15/D-16–D-19/A8–A14 wording separately
      from approving this plan, against a recorded plan blob hash or commit SHA; the verbatim
      approval record exists before authority editing.
- [ ] Decision Sheet and Implementation Plan match that wording, preserve history, and preserve
      all current PR #44 authority language.
- [ ] Decision Sheet, Implementation Plan, PRD, active revamp package, AGENTS/CLAUDE, and todo agree
      on corrected numbering, product contracts, and target-vs-live status.
- [ ] Active-package searches find no unannotated stale D-16–D-21 mapping, React-as-D-19,
      D-20/D-21 mapping, superseded External Editor grants/notes exposure, or duration-preserving
      DST movement rule.
- [ ] AGENTS/CLAUDE substantive bodies match; their reciprocal opening comments remain correct.
- [ ] The todo umbrella/current bullet contains actual SHA/date/review status and does not claim a
      later tracer bullet is live; the register is called reviewed only after every disposition is
      accepted, and TB0's active entry is replaced with its accepted/committed state at close-out.
- [ ] Separate TB0A and TB0B repository-native plans exist, stay within their scope briefs, carry
      assigned drift/AutoHDR boundaries, and pass the required plan reviews; neither is executed.
- [ ] A fresh independent diff review and the orchestrator's §5 gate approve the complete TB0 diff.
- [ ] `git diff --check` is clean and the diff contains no product source, dependency, lockfile,
      schema/migration, Worker config, secret, deployment, or production mutation.
- [ ] TB0A has not started; Tailwind/shadcn has not been initialized.

## Owner judgment calls that remain explicit

1. **Authority approval:** approve the exact wording above or amend it. Plan approval alone does
   not answer this.
2. **Visual/drift disposition:** for every candidate `Intentional evolution`, `Unwanted drift`, or
   deferral, choose preserve/correct/defer before TB0 acceptance. Evidence collectors do not make
   product taste decisions implicitly.
3. **Red baseline:** if any pre-change gate is not green, decide whether the separately verified
   pre-existing failure blocks TB0 or is accepted as a named exception; TB0 cannot fix product code.
4. **Plan lifecycle for a no-deploy phase:** repository convention moves plans to `implemented/`
   only after live deployment, but TB0 deliberately has no deployment. Default: leave this plan in
   `docs/plans/` with a completed/committed status and the authority-promotion hash recorded by an
   immediate small follow-up documentation commit; move it only if the owner explicitly decides
   that an authority-only commit satisfies this exceptional lifecycle.
