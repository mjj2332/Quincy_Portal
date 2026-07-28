# In-App + Email Notifications (v1) — Plan

**Status: APPROVED by Terra (round 8, 2026-07-28). Ready to build whenever the user authorizes it
— not yet built.** By far the largest revision of the 6 plans in this batch — 8 rounds, since the
real trigger surface turned out far more scattered than the original draft assumed, one event was
miscategorized for 4 rounds before being caught, and one of this plan's own fixes (round 5)
introduced a fresh TOCTOU race that took another round to surface. The events table still
mandates a build-time exhaustive re-grep of every stage-key writer as a final safety net, since
this plan's own enumeration was wrong or incomplete in nearly every round — treat that as a
required pre-implementation step, not optional.
Amended from the original in-app-only draft in response to explicit user direction:
(1) fold Cloudflare Email Service in now, rather than deferring it to an unplanned follow-up —
research below resolves the account/plan question that previously blocked designing it; (2) add
a comment/annotation event notifying the project's assigned editor(s). Scoped per user
direction: staff-only recipients for v1 (schema left extensible for clients/agents later, not
built now), and polling — not push — for in-app delivery latency, matching every other
near-real-time pattern already in this codebase. In-app bell and email now ship together, since
the account-tier blocker that justified splitting them is resolved (§ Cloudflare Email Service).

## What's actually in this codebase today (confirmed by direct read, not assumed)

- **No outbound integration of any kind exists** — no email, Slack, or webhook egress anywhere.
  `integrationConnections.provider` has an unused `"email"` enum value; nothing reads or writes it.
- **No polling library and no push infrastructure.** Every near-real-time behavior today is a
  hand-rolled `setInterval`/recursive `setTimeout`, screen-scoped inside `ProjectWorkspace.tsx`
  (`:155`, `:194`, `:196`) and `UploadDropzone.tsx:69`, each at a 5s interval. No shared
  `usePolling` hook exists — each screen reimplements it. The two existing Durable Objects
  (`DropboxSyncDO`, `TonomoProcessorDO`) use alarms only; neither has WebSocket hibernation, and no
  SSE endpoint exists anywhere.
- **`audit_log`** (`packages/db/src/schema.ts:830-842`) is a real, structured event log
  (`actorId`/`action`/`targetType`/`targetId`/`metaJson`/`createdAt`) already covering most
  stage transitions, but not all: `workers/background/src/workflows/autohdr.ts:276-278` sets
  `stageKey: "editing_autohdr"` via a plain `db.update()` with no audit insert at all, when
  `input.handoffId` is undefined (an older code path in the same Workflow). There is also no
  automated trigger for reaching `delivered` — that stage only ever changes via the manual
  `stage.set` admin route. Both are relevant below.
- **`project_members`** (`packages/db/src/schema.ts:170-187`) already maps staff to projects
  (`projectId`, `userId`, `roleOnProject: "photographer" | "editor"`) — the table this fanout's
  recipient queries select directly from. **Corrected per Terra round 1**: `hasProjectAccess()`
  (`workers/app/src/middleware/capability.ts:18-23`) answers a single-user yes/no access question
  ("can *this* user see project X"), not an enumeration query — it cannot be called to "get the
  recipient list" the way the original draft implied. Recipient computation is a direct
  `SELECT ... FROM project_members WHERE project_id = ?` (optionally filtered to
  `roleOnProject = 'editor'`, per event — see the comment/annotation event below), not a reuse of
  `hasProjectAccess` itself.
- **Topbar** (`apps/web/src/components/Topbar.tsx`) is the only header component, a single flex
  row (brand → nav → spacer → `.topbar__user` → mobile menu trigger). It already contains one
  bespoke accessible dropdown — the mobile nav menu (`:25-47`, `:93-101`): `useState` open/closed,
  `useRef` for trigger+panel, `useId()` for `aria-controls`, a `useEffect` that focuses the first
  menu item on open, closes on `Escape` (refocusing the trigger), and closes on outside
  `pointerdown`. No `Popover`/`Dropdown` library or shared component exists anywhere in
  `apps/web/src` — this hook/ref/ARIA pattern is the one to copy for the notification dropdown, not
  a new dependency. No icon library exists either — icons are hand-authored inline SVGs
  (`viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"`,
  e.g. `Dashboard.tsx:186`), paired with `<span className="sr-only">` — match this for the bell.
  No badge/unread-count component exists; this would be new, minimal CSS.

## Cloudflare Email Service — now designed, not deferred

Re-researched directly against current Cloudflare docs (`developers.cloudflare.com/email-service/`,
fetched during this amendment) rather than carried forward from the earlier "confirmed hands-on
later" placeholder. **The finding that unblocks this**: sending to a small, known set of
pre-verified destination addresses is free on every plan, including Workers Free — the Workers
Paid plan is only required for sending to *arbitrary/unverified* recipients
([Pricing](https://developers.cloudflare.com/email-service/platform/pricing/)). Quincy's
recipients are exactly the "small, known, internal staff" case this exemption covers, so there is
no billing blocker to resolve before building this.

**What's still a genuine beta product**: Cloudflare Email Service "is currently in beta, and
features and APIs may change before general availability" (same source) — not a reason to avoid
building on it (this repo already builds on Cloudflare's evolving primitives elsewhere), but worth
re-confirming the binding shape against docs immediately before the build, not just at plan time.

**Mechanism** ([Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/),
[Configure send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/)):

- **Corrected after Terra round 1 — the binding belongs on both Workers, not just `app`.** The
  original draft put `send_email` only on `workers/app/wrangler.jsonc`, but most of the actual
  trigger sites live in the **background** Worker: RAW-ready (`reconcile-awaiting-raw.ts:90-103`
  — line range also corrected below), sent-to-AutoHDR and edited-landed (`autohdr/claims.ts`,
  `autohdr/finals.ts`), and the AutoHDR-stalled cron check all run there, not in `workers/app`.
  Only the two comment/annotation triggers (`annotations.ts`) live in `workers/app`. Each Worker
  has its own independent D1/R2 bindings already (confirmed: both `workers/app/wrangler.jsonc`
  and `workers/background/wrangler.jsonc` declare their own `DB`/`MEDIA` bindings, no shared RPC
  between them for this) — the fix is simply to add the *same* `send_email` binding
  independently to **both** `wrangler.jsonc` files, and call `env.EMAIL.send(...)` locally
  wherever each Worker performs its own notification-row insert. No cross-Worker RPC needed.
  ```jsonc
  "send_email": [{ "name": "EMAIL" }]
  ```
  no `destination_address` restriction, since there are multiple distinct staff recipients, not
  one fixed address. Binding usage no longer needs the older `mimetext`/`EmailMessage`
  MIME-construction path — the current structured API takes plain fields directly:
  ```ts
  const result = await env.EMAIL.send({ to: recipientEmail, from: senderAddress, subject, text, html });
  // returns { messageId: string }; throws an Error with a .code on failure
  ```
- **One-time, manual, hands-on setup (not code, do before building)** — **corrected per Terra
  round 2**, which found the round-1 fix wrongly presented these as two sequential steps in a
  fixed order; they're **two independent axes**, not a pipeline: **Email Routing** (inbound
  routing + destination-address verification) and **Email Service sender-domain onboarding**
  (what authorizes the domain to *send* via the binding at all) don't depend on each other in a
  strict before/after sense
  ([domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/),
  [send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/)).
  What's confirmed: sending to already-verified destination addresses is free regardless of plan;
  sender-domain onboarding is what additionally unlocks sending to *arbitrary* (non-verified)
  recipients. What's genuinely **not** confirmed from docs alone and needs a hands-on check before
  the build: whether the `send_email` binding requires sender-domain onboarding to be complete
  before it can send *at all* (even to a pre-verified destination), or whether verified-destination
  sending works independently of that onboarding step. Given Quincy's whole design here only ever
  sends to a small, pre-verified staff list, it's possible sender-domain onboarding (the
  Workers-Paid-adjacent gate) isn't even required for this plan's scope — but that needs an actual
  Cloudflare dashboard session to settle, not further doc research. Regardless of that answer: add
  every current staff member's email as a *verified destination address* (each gets a one-click
  confirmation email — a per-person, one-time step, same shape newly onboarded staff will need
  repeated for them going forward — note this in the Admin "add user" flow's
  documentation/checklist, not enforced by code). Confirm all of this immediately before the build
  starts — it does not block *planning* the mechanism, only actually sending a test email.
- **Sender address** (added per Terra round 2, which found this undefined): a wrangler secret/var,
  e.g. `NOTIFICATIONS_FROM_ADDRESS`, set per environment (staging/prod may reasonably use
  different sender addresses) — not a hardcoded constant, matching this codebase's existing
  pattern of environment-specific config via `wrangler.jsonc` vars/secrets rather than in-code
  literals.
- Limits worth designing around: 50 combined `to`/`cc`/`bcc` recipients per send; message size is
  5 MiB generally, but Terra round 1 found verified-destination messages (this plan's exact case)
  currently allow up to 25 MiB
  ([Limits](https://developers.cloudflare.com/email-service/platform/limits/)) — either figure is
  no concern at this studio's plain-text-notification scale, so no batching logic needed either
  way.

**Send integration — reuses the exact call sites already designed below, in each Worker where
they actually live, no new infrastructure**: at each notification-row-insert call site
(background Worker for the five stage-transition/stalled-scan triggers, app Worker for the two
comment/annotation triggers), best-effort attempt `env.EMAIL.send(...)` for that row if the event
type is email-enabled (§ Which events email, below), following the same non-blocking pattern as
`workers/background`'s existing best-effort side effects
(`ensureAutoHdrScaffold(...).catch((error) => console.error(...))` at `projects.ts:144-145,205-206`
— precedent for "fire it, log failure, never block the main write"). **Corrected after Terra
round 1**: describing this as happening "in the same D1 batch" as the audit insert, guarded by
`WHERE changes() = 1`, overstated what the actual call sites do today — e.g. `stage.set`
(`projects.ts:592-596`) performs an unguarded `db.update()` followed by a *separate* `audit()`
call, not a single fenced batch. The notification insert (and email attempt) is a **best-effort,
sequential follow-up** after the primary mutation succeeds, same as the audit call it sits next
to — not claiming atomicity that doesn't exist at these call sites. **No retry queue for v1** — a
failed send sets `email_error` on the row (schema below) and is otherwise silent; this matches
the existing `lastError` pattern already used for Dropbox sync (`schema.ts`
`integrationConnections.lastError`) rather than introducing new retry infrastructure for a first
version serving a small internal team. **Made unambiguous per Terra round 2**: a failed send is
**not resendable in v1** — there is no resend mechanism, button, or endpoint, only *query
visibility*: `SELECT * FROM notifications WHERE email_error IS NOT NULL`, something a human would
have to think to run. A real resend UI is a fast-follow if this turns out to matter, not part of
this plan.

**Idempotency — a real requirement for the stalled-scan event specifically, corrected per Terra
round 1.** The five stage-transition triggers and the two comment/annotation triggers are each a
one-shot action (a specific stage change, a specific comment) — a genuine duplicate would require
the same underlying action to literally repeat, which is rare and low-consequence (an extra bell
notification). The **AutoHDR-stalled cron check is different**: it re-evaluates the *same*
still-stalled condition on every hourly tick for as long as the handoff stays stalled, so without
a dedup key it would insert a fresh notification (and attempt a fresh email) every single hour.
Fix: add a nullable `source_key text` column to `notifications` (schema below), populated only for
this event type with the stalled handoff's own id, plus a unique index on `(type, source_key, user_id)`;
the insert uses `onConflictDoNothing()` against that index, so a second scan for the same
still-stalled handoff is a safe no-op rather than a duplicate **row**. **Corrected per Terra
round 2**: this index only guards row-level duplication, not the email send specifically — if a
Worker instance crashes between a successful `EMAIL.send()` and the row's `email_sent_at` write,
the row was already inserted (the `onConflictDoNothing()` succeeded once, on the *first* attempt),
so a later cron tick's insert attempt for that same `source_key`/user pair is a no-op and will
**never retry the email** for that stuck row — it stays looking "unsent" forever, silently. This
is an accepted gap for v1, not a solved one: matches the same "no retry queue, best-effort" stance
already taken for ordinary send failures elsewhere in this plan, rather than building crash-safe
send/record atomicity (which would need a durable outbox pattern this codebase has no precedent
for). A stuck-forever row is visible via the same direct query already proposed for ordinary
`email_error` rows (`email_sent_at IS NULL AND created_at < <old threshold>` also catches this
silent case, not just explicit errors).

**Schema**: `email_sent_at`/`email_error`/`email_message_id`/`source_key` are folded directly into
the one `notifications` table below (§ Schema) — one event, one row, two delivery channels, not a
separate table.

**Which events email, vs. in-app only**: recommend a hardcoded allowlist in code for v1 (e.g. a
`const EMAIL_ENABLED_EVENTS: NotificationType[] = [...]` constant), not an admin-configurable
per-type toggle UI — this is the same "no per-user/per-type preference UI in v1" call already
made below for in-app notifications, applied consistently to the same question for email. RAW
ready and edited-landed (the two events the user named explicitly) are the clear candidates for
email; AutoHDR-stalled arguably deserves email too since it's the kind of thing worth reaching
someone even if they're not watching the bell — recommend including it. Repeat-round-started and
delivered stay in-app-only (already deferred as low-value/redundant above) until proven otherwise.
**Comment/annotation added (new, below) is recommended in-app only, not email** — it's a
higher-frequency, lower-urgency event than a pipeline-stage transition, and emailing on every
comment risks exactly the noise-fatigue concern already flagged for the `viewAllProjects`
recipient question.

## v1 scope

**Recipients:** staff only — every **distinct** `project_members` user for the affected project (a
direct query, not a reuse of `hasProjectAccess`, corrected above), filtered to `user.active = true`
**for every event type, not only the comment/annotation event** (broadened per Terra round 2,
which found the round-1 fix only applied the `active` filter to that one event) — plus (open
question below) whether to also notify admins/editors who can see all projects but aren't
explicitly assigned. **Deduplication is required, not optional** (added per Terra round 2): a
single user can hold *both* a photographer row and an editor row on the same project
(`project_members`'s unique index is `(projectId, userId, roleOnProject)` — two rows, same user,
different `roleOnProject`, is valid and real — `schema.ts:183-185`), so a naive "every
`project_members` row" query would insert two notification rows for that one person. Every
recipient query in this plan selects `DISTINCT user_id` (or dedups in JS after the query, matching
this codebase's stated preference for JS-side dedup over more complex SQL, per
`Multi-Role-Staff-Identity-Plan.md`'s own observation about this repo's house style), not a raw
per-row join. Schema keeps a single `user_id` foreign key for v1; a future client/agent channel
would be a separate table/columns added later, not speculative columns added now.

**Events, and the real (scattered) trigger inventory — substantially corrected per Terra round 2,
which found the actual call sites don't match a clean "one route per event" picture at all.**
Verified directly against the code, not carried forward from the round-1 assumption:

| Event | Actual trigger site(s) | Notes |
|---|---|---|
| RAW ready for review | **Three** call sites (awaiting_raw → raw_review): `guardedStageTransition()` at `dropbox/sync.ts:311-322` and `workers/app/src/lib/ingest.ts:107-117` (`direct_upload` path, **runs in `workers/app`**), plus `reconcile-awaiting-raw.ts:90-103` (invoked from `background/src/index.ts:47-49`'s cron) — **the third site, added per round 4, which found this plan's own round-1 fix had dropped it from the events table entirely while correcting its line citation, then round 2/3's focus on `guardedStageTransition()` sites never restored it** | `reconcile-awaiting-raw.ts` is inline-guarded like `claims.ts`, not via the shared helper — test its own success signal independently. |
| Sent to AutoHDR | **Four call sites total — three in `autohdr/claims.ts` plus one in `workflows/autohdr.ts`** (corrected per round 7, which found the round-6 wording said "four call sites in `claims.ts`" when only three actually live there): `claims.ts:120-127` (`confirmAutoHdrHandoff`, the normal handoff transition, called from `workflows/autohdr.ts:262-268`); `claims.ts:592-605` (`claimImplicitAutoHdrHandoff`) and `claims.ts:773-799` (`claimBackfillAutoHdrHandoff`) — confirmed genuinely distinct from `:120-127`, not re-citations of the same site; **plus `workflows/autohdr.ts:277-279`**, reclassified per round 5 (previously miscategorized in this plan as an "edited landed" site — confirmed by direct read that this is actually the legacy **no-handoff raw_review → editing_autohdr send path**) | Runs in **background**. The three `claims.ts` sites hand-roll their own `d1.batch([...])` with a `WHERE stage_key = 'raw_review'` guard; `autohdr.ts:277-279` had **no guard at all**, now fixed — see the mechanism below for both the guard and a required behavior change in the surrounding Workflow step. **For `:120-127` specifically, check `results[0]` (the project stage-key update) for success — the current code returns `results[2]` (the handoff-state update) at `claims.ts:127`, which must change during implementation, not just at the notification call site.** Lower-value on its own (it's the send, not a delivery) — candidate to omit from v1's default-on set. |
| Edited images landed | **Four distinct paths — corrected per round 7, which found this cell said "three" while actually listing four**: `guardedStageTransition()` calls in `autohdr/finals.ts:190,285` (editing_autohdr → edited_review, two call sites — likely automatic vs. manual-supplement variants, confirm at build time); a third, direct site in the same file, `autohdr/finals.ts:244-247` (outside `guardedStageTransition()` — the identical miss the sibling `Kanban-Priority-And-Manual-Ordering-Plan.md` independently found and fixed in its own review); and a legacy inline-guarded path in `workflows/autohdr-fetch.ts:179-182` | Runs in **background**. `finals.ts:244-247` is inline-guarded like `claims.ts` — check its own statement's affected-row result, not assumed from the helper. |
| Repeat round started | `autohdr/claims.ts:362-365` ("autohdr_repeat_send") — **explicitly not implemented in v1, made concrete per round 4** (the plan previously listed this event but never gave it a mechanism, test, or rollout step, an inconsistency Terra flagged directly): this event is **deferred, not built**, matching the existing recommendation elsewhere in this doc to ship the two explicitly-requested events plus AutoHDR-stalled first. No emit-call-site is added at `claims.ts:362-365` for v1. | Listed here for completeness/future reference only — not part of this plan's build. |
| Project delivered | manual `stage.set` route, **`workers/app`**, `projects.ts:584-598` | **Runs in the app Worker, not background** — corrected per Terra round 2, which found this contradicted the round-1 draft's blanket "all 5 stage-transition triggers are in background" framing. This route has no `WHERE changes() = 1`-style guard at all today (confirmed round 1) — see the duplicate-notification fix below. |
| **AutoHDR round stalled** (candidate, not in existing audit_log at all) | A `started` handoff (`autohdr_handoffs.state = 'started'`, `schema.ts:404-431`) whose corresponding `autohdr_output_mappings` row is still `state = 'pending_discovery'` and `autohdr_handoffs.started_at` is older than a threshold (proposed: 3 hours — open question below) | Not something this session invented for effect — this is *exactly* the `6/120 Beach Street` situation from earlier in this session: a round sent, AutoHDR never delivered, and nobody knew until a staff member happened to notice. Worth strong consideration for v1. Concrete predicate (corrected per Terra round 2, which found the original draft never defined one): `SELECT h.id, h.project_id FROM autohdr_handoffs h JOIN autohdr_output_mappings m ON m.handoff_id = h.id WHERE h.state = 'started' AND m.state = 'pending_discovery' AND h.started_at < ?` (now minus threshold), scoped to non-archived projects. |
| **Comment or annotation added** (new, this amendment) | `POST /assets/:id/annotations` (`annotations.ts:92-116`) and `POST /assets/:id/comments` (`annotations.ts:118-138`) | Runs in **app**. User-requested: notify the project's assigned editor(s) when a comment or annotation is added, so review feedback doesn't sit unnoticed. **Recipients differ from every other event here**: every other event is recipient-agnostic (`project_members`, full stop); this one specifically means *editor* members only (`roleOnProject = "editor"`, not the photographer members), and — a genuinely new case for this mechanism — must **exclude the actor who just posted the comment/annotation**, since every prior event is server-triggered (auto-advance/manual stage-set by someone acting on the *system*, not commenting on their own action) and self-notification was never a concern before now. If a project has zero (active, non-actor) editor members, there is nothing to notify — not an error, just an empty recipient set. |

**Generation mechanism — event-driven, not audit-log polling, hooked at the narrowest common
choke point available for each group of triggers rather than scattered ad hoc inserts:**

1. **For the four transitions already routed through the shared `guardedStageTransition()`
   helper** (`packages/db/src/stage-transition.ts:17-40` — RAW-ready via `dropbox/sync.ts` *and*
   `ingest.ts` (added per round 3), edited-landed's two `autohdr/finals.ts` call sites): extend the
   helper itself with an optional post-success hook, since it already knows the from/to stage, the
   `projectId`, and whether the transition actually fired (`(result[0]?.meta.changes ?? 0) === 1`,
   `stage-transition.ts:39`). This is the single cleanest hook point — one function, four call
   sites covered. **Failure isolation, added per round 3**: the hook itself is wrapped in its own
   `try/catch` inside `guardedStageTransition` — a notification-insert or email-send failure must
   never propagate out and turn an already-committed, successful stage transition into an apparent
   failure for the caller. Log and swallow, exactly like every other best-effort side effect in
   this plan.
1a. **`autohdr/finals.ts:244-247`, added per round 5**: a third, direct edited-landed transition
   in the same file as the two `guardedStageTransition()` calls above, but not routed through the
   helper — treat it like the inline-guarded sites in point 2 below: check its own statement's
   affected-row result independently, don't assume it's covered by extending the shared helper.
2. **For `reconcile-awaiting-raw.ts:90-103`'s RAW-ready site, all four "sent to AutoHDR"
   `autohdr/claims.ts`/`autohdr.ts` call sites, and the `autohdr-fetch.ts` legacy "edited landed"
   path**: add the notification insert as an explicit, individual follow-up at each of these
   **seven non-helper sites total** (this one, plus `finals.ts:244-247` at 1a above — corrected
   per round 7, which found "six sites" undercounted once `finals.ts:244-247` is included),
   **checking that specific site's own success signal**:
   - `reconcile-awaiting-raw.ts`: check its own guarded update's `changes()` count, following the
     same pattern as `claims.ts` below (it doesn't use `guardedStageTransition()` either).
   - `claims.ts:120-127`: check `results[0]` (the project stage-key update) specifically — the
     current code returns `results[2]` (the handoff-state update) at `claims.ts:127`, which must
     be changed as part of this build, not worked around at the notification call site.
   - `claims.ts:592-605` and `:773-799`: check the `changes()` count of the **`UPDATE projects SET
     stage_key = ...` statement itself**, not `results[handoffInsertIndex]` (which validates the
     *handoff* insert succeeding, a different statement in the same batch).
   - `autohdr-fetch.ts`: capture the `db.update(projects)...` call's own affected-row result (not
     `readyForReview` alone, which only says the *eligibility* condition was true — it doesn't
     prove the guarded `WHERE stageKey = "editing_autohdr"` update actually changed a row, e.g. if
     a concurrent request already moved the project elsewhere first).
   - **`workflows/autohdr.ts:277-279`** (reclassified per round 5 as a "sent to AutoHDR" site, not
     "edited landed" — see the events table): this path has no guard/audit at all today.
     **Corrected per round 6, which found the round-5 fix (read `stageKey` immediately before the
     update, notify only if it was `raw_review`) was itself a TOCTOU race** — another worker could
     change the project between that read and this update's write, producing a duplicate/false
     notification or, worse, silently overwriting a newer stage change with no record of what
     happened in between. **This plan now adds a real guard to the update statement itself**
     (a minimal, targeted addition — one `WHERE` clause on an existing single-row `UPDATE`, not a
     broader refactor onto the shared helper, which stays out of scope): change
     `UPDATE projects SET stage_key = 'editing_autohdr', ...` to
     `UPDATE projects SET stage_key = 'editing_autohdr', ... WHERE id = ? AND stage_key = 'raw_review' AND archived_at IS NULL`,
     and emit the notification only when that statement's own `changes()` count is `1` — the same
     atomic check-and-write pattern every other guarded site in this table already uses, matching
     this repo's own documented lesson that stage mutations must be guarded (`docs/lessons.md:12-15`).
     This closes the underlying gap rather than working around it with a racy read, and is a
     genuine (if small) correctness fix to `autohdr.ts:277-279` itself, justified because building
     a correct notification here is not possible without it — narrower in scope than, and not a
     substitute for, the broader "refactor onto `guardedStageTransition()`" cleanup that remains
     out of scope. **Coordination note**: the sibling `Kanban-Priority-And-Manual-Ordering-Plan.md`
     also touches this same statement (to splice in its `board_position` expression) and currently
     describes it as "unconditional, no guard to gate on" — whichever plan is built first adds
     this `WHERE` guard; the second build should find it already present and splice its own change
     into the now-guarded statement rather than re-adding the guard.
     **Required behavior change in the surrounding Workflow step, added per Terra round 7** (which
     found that adding this guard, by itself, creates a new correctness gap this plan must also
     close, not leave dangling): this update lives inside `AutoHdrSend.run()`'s `"mark-send-running"`
     step (`autohdr.ts:274-279`), which today ignores the update's result entirely and unconditionally
     proceeds to load RAW assets and transfer them to Dropbox (`autohdr.ts:280` onward) — with the
     guard now in place, a `changes() === 0` result is a real, reachable outcome (the project moved
     on, or was archived, since this Workflow was scheduled), and blindly continuing to transfer
     files for a project no longer in the expected state would be wrong. Fix, **mirroring the
     handoff-path's own existing guard-check pattern already in this same function**
     (`autohdr.ts:271-273`: `if (confirmed?.state !== "started" || confirmed.stageKey !== "editing_autohdr") { throw new Error(...) }`
     — not a new pattern, the same one already used one branch over): on `changes() === 0`, read the
     project's current `stageKey`/`archivedAt`. If `stageKey` is already `editing_autohdr`, this is
     a safe idempotent retry (the transition already happened on an earlier attempt of this same
     step) — continue the Workflow normally, but **do not** emit a second notification. If the
     project is in any other stage, or archived, the scheduled send is stale — `throw` (the same
     abort-the-Workflow response the handoff path already uses for its own equivalent violation)
     rather than continuing to transfer RAW files.
   This plan does **not** refactor any of these onto the shared helper (a legitimate future
   cleanup, but a larger, separate scope than this notifications feature needs to force through).
   **Given this list has been incomplete at every round so far, the build must re-grep
   `workers/background/src/` and `workers/app/src/` for every direct `stage_key` write before
   implementation, cross-checked against this list rather than trusting it as final** — the
   sibling `Kanban-Priority-And-Manual-Ordering-Plan.md` makes the identical mandate for the
   identical underlying reason.
3. **For "project delivered"** (`stage.set`, `workers/app`, unguarded today): fix the duplicate-
   notification risk directly rather than accepting it — the route already fetches the project's
   *old* `stageKey` before updating (`projects.ts:592`: `const project = await db.select()...`),
   so gate the notification on `project.stageKey !== "delivered" && data.stageKey === "delivered"`
   (was already `delivered`, re-setting it to `delivered` again produces no notification). This
   closes the common case (an admin re-submitting the same stage). A genuine *concurrent* race —
   two simultaneous requests both reading the pre-update stage before either writes — is accepted
   as an extremely narrow, low-frequency gap for v1 (matching the same "no new
   locking/transactional-fencing infrastructure for a rare race" call already made in the sibling
   `Photographer-Stage-Visibility-Plan.md`), not solved with a DB-level guard here.
4. **For comment/annotation** (`annotations.ts`, `workers/app`): insert as a direct follow-up
   after the existing insert+audit call, as already designed above.
5. **AutoHDR-stalled** is the one true periodic scan — piggybacked on the existing hourly cron
   (`workers/background/wrangler.jsonc:17`, `reconcileAwaitingRawProjects` already runs there) as
   a second, small check using the concrete predicate above, **with the `source_key` uniqueness
   guard** (below) so repeated ticks against the same still-stalled handoff don't duplicate — and
   structured so a failure in this new check cannot suppress or crash the existing RAW
   reconciliation it's piggybacking alongside (added per Terra round 2).
6. **Notification copy must not leak AutoHDR/vendor details to non-admin recipients — added per
   Terra round 4, a genuine gap the earlier rounds missed.** `stages.ts`'s existing
   `projectStageForRole`/`stagesForRole` (`stages.ts:27-41`) already hides the internal
   `editing_autohdr` stage name from non-`adminBackend` roles, presenting a generic "Editing"
   label instead — its own comment states the reason: "Hide the implementation vendor from staff
   who do not operate the autoHDR integration." A notification whose title/body says "Sent to
   AutoHDR" or references a connection/folder would leak exactly what that existing mechanism
   hides, to the same `project_members` (including photographers) this plan already notifies for
   every other event. **Fix, following the existing precedent rather than building a second,
   role-branched copy path**: "Sent to AutoHDR," "AutoHDR round stalled," and "Repeat round
   started" (if ever built) use vendor-neutral notification copy for *every* recipient — e.g.
   "Moved to editing," "Editing round taking longer than expected" — never the word "AutoHDR," a
   connection ID, folder path, or other integration-specific detail, in either the in-app title/
   body or the email subject/text. This is one shared copy, not an admin-sees-more variant — the
   same "one label for everyone" choice `stagesForRole` already made, applied here for
   consistency, not a new design decision this plan invents. RAW-ready, edited-landed, and
   "delivered" have no equivalent leak (they don't reference AutoHDR-specific details) and are
   unaffected.

All of the above are **best-effort, sequential follow-ups** after each site's own primary
mutation succeeds — not claiming atomicity with it (§ Cloudflare Email Service corrects the
earlier "same D1 batch, `changes() = 1` guard" framing, which didn't hold at every cited call
site), and every one of them is wrapped so its own failure cannot surface as the caller's failure
(point 1's isolation requirement applies uniformly across all six groups, not just the shared
helper).

**Schema (illustrative, not final):**

```sql
CREATE TABLE notifications (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  read_at integer,
  email_sent_at integer,
  email_error text,
  email_message_id text, -- Cloudflare's returned messageId on a successful send; added per
                          -- Terra round 1, an attempt marker distinct from success/failure alone
  source_key text, -- only populated for the AutoHDR-stalled event (the handoff's own id);
                    -- NULL for every other event type
  created_at integer NOT NULL
);
CREATE INDEX notifications_user_unread_idx ON notifications (user_id, read_at, created_at);
CREATE UNIQUE INDEX notifications_source_key_unique ON notifications (type, source_key, user_id)
  WHERE source_key IS NOT NULL; -- added per Terra round 1 — the stalled-scan idempotency guard.
  -- Scoped per-recipient (user_id in the key), not per-handoff alone: a stalled handoff notifies
  -- every recipient once each, so the guard must allow N rows (one per recipient) for the same
  -- source_key, while still blocking a second row for the *same* recipient on a repeat cron tick.
```

**API** (new routes in `workers/app/src/routes/`, no new capability required beyond being
authenticated — every row is already scoped to `user_id = current user`, so there's no cross-user
exposure risk to gate):

- `GET /api/notifications` — recent notifications for the current user (limit/cursor), plus an
  unread count.
- `POST /api/notifications/:id/read`, `POST /api/notifications/read-all`.

**Frontend:** a bell icon added to `Topbar.tsx`'s `.topbar__user` block, copying the existing
mobile-menu's dropdown pattern exactly (focus trap, `Escape`, outside-click) rather than a new
library. Unread-count badge (new, small CSS addition — no existing badge component to reuse).
Polling `GET /api/notifications` on a fixed interval (matching the existing 5s-ish convention used
elsewhere, though a notification bell likely doesn't need to be that aggressive — 20-30s is
probably enough and reduces load; open question below).

**Retention:** not addressed by any existing pattern in this codebase (R2 media is explicitly
*never* deleted per this repo's own conventions, but that's a different kind of data). Notifications
are ephemeral by nature; propose pruning read notifications past some age (e.g. 90 days) via the
same hourly cron, to bound table growth. Open question below on the exact window.

**Comment/annotation event — recipient computation** (new, this amendment): at both call sites
(`annotations.ts:92-116`, `annotations.ts:118-138`), after the existing insert+audit call, query
`project_members` joined to `user` for `roleOnProject = "editor"` on `asset.projectId`, filtered
to `user.active = true` (added per Terra round 1 — a deactivated staff member shouldn't be
notified even if their membership row is still present, matching `schema.ts:20-32`'s `active`
column already used elsewhere to gate a user out), excluding `c.get("user").id` (the actor — see
events table above for why this event alone needs that exclusion), and insert one `notifications`
row per remaining recipient. If the actor *is* the project's only (active) editor (commenting on
their own project), the recipient set is correctly empty — no notification, no error. **Replies
count as new comments** (clarified per Terra round 1): a reply (`parentId` set) uses the same
trigger and the same recipient computation as a top-level comment — it is not exempted just
because it's nested; the only exclusion is the actor, same as any other comment.

## Open questions (recommendations given, not yet decided)

1. **Do admins/editors (who can see every project via `viewAllProjects`, but aren't necessarily
   *assigned* to it) get notified about every project's events, or only actual `project_members`?**
   Recommendation: `project_members` only for v1 — blanket-notifying every admin/editor about every
   project risks noise fatigue fast, and it's easy to broaden later if this turns out to be too
   narrow, harder to narrow after people get used to a noisy inbox.
2. **Which of the starter events should be on by default** — all of them, or just the two the user
   named explicitly (RAW ready, edited landed), with the rest (repeat-round-started, delivered,
   AutoHDR-stalled) opt-in or added in a fast-follow? Recommendation: ship RAW-ready,
   edited-landed, and AutoHDR-stalled together (the first two were explicitly requested; the third
   is a real, recently-observed operational gap worth closing at the same time since the mechanism
   is being built anyway) — defer repeat-round-started and delivered as likely-low-value/likely-
   redundant-with-existing-UI-state, revisit after v1 usage.
3. **Poll interval** — 20-30s proposed; confirm that's an acceptable staleness window for a bell
   icon (versus, say, wanting sub-10s, which would push toward the "needs infrastructure" tier
   already ruled out for v1).
4. **Retention window** — 90 days for read notifications proposed; confirm, or specify a different
   window / a max-count-per-user cap instead of a time window.
5. **Should there be a per-user mute/preference mechanism in v1** (e.g. "don't notify me about
   project X", or per-event-type opt-out), or is a single global on/off per event type (admin-
   configured, not per-user) enough for a first release? Recommendation: no per-user preferences in
   v1 — this is a real feature in its own right and the team is small enough that it's not yet clear
   it's needed; add if it turns out to matter after the first version ships.
6. **(New) Which events should email, beyond RAW-ready/edited-landed/AutoHDR-stalled?**
   Recommendation given above (§ Which events email) — confirm or adjust the allowlist.
7. **(New) Is Email Routing already enabled on `flamingfire.my`, is sender-domain onboarding done,
   and are any staff addresses already verified destinations?** Needs an actual Cloudflare
   dashboard login to answer — flagged as a pre-build hands-on check, not a planning blocker
   (see § Cloudflare Email Service).
8. **(New, per Terra round 2) Stalled-handoff threshold** — 3 hours proposed for the
   `autohdr_handoffs.started_at` cutoff; confirm or adjust based on how long a healthy AutoHDR
   round normally takes versus how quickly staff should be alerted to a stuck one.
9. **(New, per Terra round 2) Should the two "sent to AutoHDR" call sites
   (`autohdr/claims.ts:592-604` normal send, `:773-798` backfill/recovery) both notify, or only
   the normal send path?** Recommendation: both, since either one represents a real handoff
   starting and this event is already a candidate to default off (§ Which events email) — treat
   them identically rather than special-casing the recovery path.

## Explicitly out of scope for this plan

- Client/agent-facing notifications (schema won't actively block adding this later, but nothing
  about auth, delivery, or content-safety for an external audience is designed here).
- Real-time/push delivery (Durable Object WebSocket hibernation or SSE) — polling only.
- Per-user notification preferences/muting.
- Email retry queue on send failure — best-effort, logged, no automatic retry (§ Cloudflare Email
  Service). A stuck/failed row is query-visible only, **not resendable in v1** (made explicit per
  Terra round 2).
- Refactoring `autohdr/claims.ts`, `autohdr-fetch.ts`, or `workflows/autohdr.ts:277-279` onto the
  shared `guardedStageTransition()` helper — a legitimate future cleanup, out of scope for this
  notifications feature (§ Generation mechanism) and for the sibling
  `Kanban-Priority-And-Manual-Ordering-Plan.md`, which independently found and deferred the same
  cleanup. **Updated per Terra round 7**: this plan *does* now fix `autohdr.ts:277-279`'s missing
  stage-transition guard (§ Generation mechanism) — that's no longer out of scope, only the
  refactor-onto-the-shared-helper cleanup is. The missing **audit insert** at this same site
  remains genuinely out of scope (a separate, smaller gap this plan doesn't need to close to
  build a correct notification).
- Admin-configurable per-event-type email toggle UI — v1 ships a hardcoded allowlist in code.
- **"Repeat round started" — made explicit per Terra round 4**: listed in the events table for
  completeness/future reference, but no emit-call-site is added at `claims.ts:362-365` for v1 —
  this event is deferred, not built, consistent with the "likely low-value" recommendation
  elsewhere in this doc, now made unambiguous rather than left as an inconsistency between the
  table and the actual mechanism.

## Testing requirements for the build

1. `packages/db`: `guardedStageTransition()`'s new post-success hook fires exactly when the
   transition actually happens (`changes() === 1`), not when the guard fails (project already in
   a different stage, or already archived) — covers RAW-ready's two helper-routed sites
   (`dropbox/sync.ts`, `ingest.ts`) and both edited-landed `finals.ts` call sites. **Failure
   isolation**: a notification-insert/email-send failure thrown inside the hook is caught and
   logged, never propagates out of `guardedStageTransition` — construct a fixture where the hook
   itself throws and confirm the caller still sees a successful transition result.
2. `workers/background/test`: `reconcile-awaiting-raw.ts`'s RAW-ready site;
   `autohdr/finals.ts:244-247`'s third edited-landed site (added per round 5); all four "sent to
   AutoHDR" call sites (`claims.ts:120-127`, `:592-605`, `:773-799`, and the reclassified
   `autohdr.ts:277-279`) — for `:120-127` specifically, verify the check reads `results[0]` (the
   project update), not `results[2]` (the handoff-state update); the `autohdr-fetch.ts` legacy
   "edited landed" path — each insert a notification only when their own transition actually
   happened — **checked against the correct signal**: for `claims.ts`'s `:592-605`/`:773-799`
   sites, the `UPDATE projects` statement's own `changes()` count, not
   the handoff-insert statement's (a distinct index in the same batch — construct a fixture where
   the handoff insert succeeds but the stage update's guard fails, and confirm no notification
   fires); for `autohdr-fetch.ts`, the update's own affected-row count, not `readyForReview` alone
   (construct a fixture where `readyForReview` is true but a concurrent update already moved the
   project elsewhere, and confirm no notification fires). None of these sites use
   `guardedStageTransition()` (§ Generation mechanism), so each is tested independently.
3. `workers/app/test`: `stage.set`'s "delivered" notification fires exactly once for
   `!delivered → delivered`, and **not again** for a subsequent `delivered → delivered` no-op
   re-submission (the `project.stageKey !== "delivered"` guard, § Generation mechanism).
4. Recipient deduplication (added per Terra round 2): a user holding *both* a photographer and an
   editor `project_members` row on the same project receives exactly **one** notification row per
   event, not two — construct this exact fixture and assert on row count, don't just trust a
   `DISTINCT` clause is present in the query text.
5. Comment/annotation event: recipient set is exactly the project's *active* editor
   `project_members` minus the actor (both conditions tested independently — an inactive editor
   is excluded even though their membership row exists); a project with zero (non-actor, active)
   editor members produces zero notification rows, not an error; both the annotation and comment
   endpoints are covered independently; a reply (`parentId` set) triggers the same as a top-level
   comment.
6. Email: a mocked `env.EMAIL.send` on **both** Workers (background and app) — success path sets
   `email_sent_at` and `email_message_id` from the mocked `messageId`; a thrown error sets
   `email_error` and does not throw past the call site (the surrounding request/audit write still
   succeeds); an event type not on `EMAIL_ENABLED_EVENTS` never calls `send` at all.
7. `GET /api/notifications` / `read`/`read-all`: scoped to `user_id = current user` only (a
   second user's notifications are never returned or markable-read); unread count matches
   `read_at IS NULL` rows.
8. AutoHDR-stalled scan: the concrete predicate (`autohdr_handoffs.state = 'started'` joined to
   `autohdr_output_mappings.state = 'pending_discovery'`, `started_at` older than the threshold,
   § Events table) correctly identifies a stalled handoff and correctly excludes a healthy one
   (mapping already past `pending_discovery`, or not old enough yet); running the scan twice
   against the same still-stalled handoff produces exactly one notification row per recipient, via
   the `notifications_source_key_unique` index and `onConflictDoNothing()` — verify the second
   scan's insert attempt is a genuine no-op (no error, no duplicate row), not just that a
   duplicate happens not to occur in the test's specific timing; a failure inside this new check
   (e.g. a malformed handoff row) does not throw past its own try/catch and does not prevent the
   existing `reconcileAwaitingRawProjects` check in the same cron tick from running (added per
   Terra round 2's isolation requirement).
9. Notification copy: "Sent to AutoHDR" (all four sites, including the reclassified
   `autohdr.ts:277-279`) and "AutoHDR round stalled" notification title, **body, and email
   subject and body text** (assert on all of these, not just the subject line — added per Terra
   round 5) never contain the string "AutoHDR", a connection ID, or a folder path, for any
   recipient role — assert on the literal generated copy, not just that the row was inserted;
   RAW-ready, edited-landed, and delivered copy is unaffected (no AutoHDR-specific content to leak
   in the first place). `autohdr.ts:277-279`'s guard (§ Generation mechanism, corrected per round
   6 to a real `WHERE`-clause condition on the update itself, not a racy pre-read): construct a
   fixture where this update is attempted against a project already in `editing_autohdr` (not
   `raw_review`) and confirm both the update itself is a no-op (`changes() === 0`) and no
   notification fires, versus one where `stage_key` genuinely was `raw_review` at the moment the
   guarded update executes; **concurrency regression test, added per round 6**: two simulated
   concurrent attempts against the same project — only one succeeds (guard matches once), the
   other's guard fails and emits no notification, with no possibility of both firing or of a
   later, unrelated stage change being silently overwritten. **`AutoHdrSend.run()`'s guard-miss
   handling, added per round 7**: a guard miss where the project's current stage is already
   `editing_autohdr` lets the Workflow continue normally (idempotent retry) with no second
   notification; a guard miss where the project is in any other stage, or archived, throws and
   the Workflow does not proceed to load/transfer RAW assets — construct both fixtures explicitly,
   don't only test the guard-succeeds path.
10. `apps/web`: bell dropdown open/close/focus/`Escape`/outside-click, matching the existing
   mobile-menu test coverage pattern; polling interval is configurable/mockable in tests (no real
   `setInterval` in the test run).

## Verification (per CLAUDE.md / Subagent-Orchestration.md §5, once built)

- `npm run typecheck` (all six workspaces) and `npm run build -w @quincy/web`.
- `npm run test --workspaces` **and** `npx vitest run --config packages/shared/vitest.config.ts`
  (the latter is silently skipped by the workspaces script per this repo's own gotcha).
- Manual smoke, after the hands-on Cloudflare setup (§ Cloudflare Email Service) is confirmed: an
  actual RAW-ready transition sends both an in-app notification and an email to a verified staff
  address; a comment on a project with an assigned editor produces an in-app notification (no
  email) to that editor and not to the commenter.

## Rollout

1. Migration (additive: `notifications` table including `email_sent_at`/`email_error`/
   `email_message_id`/`source_key`) — safe to apply to prod independent of any code deploy.
2. Hands-on Cloudflare check/setup (Email Routing, Email Service sender-domain onboarding, staff
   destination-address verification — confirmed as independent axes, not a fixed sequence,
   § Cloudflare Email Service) — do this before step 5, since step 5's manual smoke test depends
   on it.
3. **`packages/db`**: the extended `guardedStageTransition()` post-success hook, with its own
   internal `try/catch` isolation (§ Generation mechanism) — covers `dropbox/sync.ts` and both
   `finals.ts` edited-landed sites directly; `ingest.ts` (`workers/app`) also calls into this same
   extended helper.
4. **`workers/background`**: `send_email` binding in `wrangler.jsonc`; the individually-added
   inserts at `reconcile-awaiting-raw.ts`'s RAW-ready site, `autohdr/finals.ts:244-247`'s third
   edited-landed site, all four "sent to AutoHDR" sites (`claims.ts:120-127`, `:592-605`,
   `:773-799`, and the reclassified `autohdr.ts:277-279` with its own duplicate-emission guard),
   and `autohdr-fetch.ts`'s legacy edited-landed path, each checking that specific site's own
   correct success signal; the `claims.ts:127` index fix (`results[0]`, not `results[2]`); the
   vendor-neutral notification-copy requirement for AutoHDR-specific events; the AutoHDR-stalled
   cron check (with its `source_key` guard and isolation from the existing RAW-reconciliation
   check) — corrected across Terra rounds 1-5, which found the original rollout omitted this
   Worker, then understated how many distinct sites within it need touching (three times more),
   then found a privacy gap in the notification copy, then found a misclassified event bucket.
   **Run the exhaustive re-grep (§ Generation mechanism) before finalizing this step's
   scope** — this list has been wrong at every round so far. Deploys first, matching this repo's
   existing background → webhook-ingress → app order (`CLAUDE.md`).
5. **`workers/app`**: `send_email` binding in its own `wrangler.jsonc`; `ingest.ts`'s use of the
   extended `guardedStageTransition()` (added per round 3); the two comment/annotation
   emit-call-sites (with `DISTINCT`/dedup recipient queries); the `stage.set` "delivered" guard fix
   (`project.stageKey !== "delivered"`); the notifications API routes — deploys after step 4, same
   existing order.
6. **Run a real send** against a verified staff address to confirm the Cloudflare setup (step 2)
   actually works end-to-end before considering email live — a hands-on check step 2 alone doesn't
   fully replace.
7. `apps/web`: Topbar bell — depends on step 5's API being live.

## Routing (per Subagent-Orchestration.md §2 routing table)

Schema + new binding + API + frontend + a cron addition + **multiple individually-touched
`workers/background` call sites** (broader than originally scoped, § Generation mechanism),
coordinated, moderate-to-large size — Terra plan review, then (when the user authorizes a build)
Terra build, Terra diff review, Opus final read, §5 gate.
