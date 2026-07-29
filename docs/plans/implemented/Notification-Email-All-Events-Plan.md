# Send Email for All 6 Notification Types — Plan

**Status: implemented and deployed to production** (commit `934eece`, deployed 2026-07-29 —
`background` then `app`, per the Rollout section below).

**User request** (2026-07-29): after confirming the Cloudflare Email Sending configuration works
(a live test email was sent and received), the user wants every notification type to send an
email, not just the 3 currently enabled — explicitly asked for this to go through the plan-review
process even though it's a small change, "just want to be safe."

## Current state (verified across three rounds — round 1 found the call-site audit and testing
## claims inaccurate; round 2 found the "stage guard" framing still too broad for `delivered`
## specifically, and that the proposed conflict test can't actually run where first drafted;
## round 3 found the `comment_added`-exclusivity claim still wrong once `delivered`'s real TOCTOU
## is accounted for, the sourceKey-free type count off by one, and the wrong mock interface named
## for the new package tests — all corrected below)

**The entire gate is one array.** `packages/db/src/notifications.ts:13`:
```ts
export const EMAIL_ENABLED_EVENTS: readonly NotificationType[] = ["raw_ready", "edited_landed", "autohdr_stalled"];
```
`emitNotifications()` (same file, `:107`) checks `EMAIL_ENABLED_EVENTS.includes(input.type)` before
attempting `input.email.send(...)`, **after** the in-app `notifications` row has already been
inserted — confirmed by re-reading the function's actual statement order. Widening this one array
is genuinely sufficient — no other file needs a code change.

**Every real call site, re-derived and re-verified across two rounds:**

| Type | Call sites | Recipients |
|---|---|---|
| `raw_ready` | 3 — `workers/app/src/lib/ingest.ts:118`, `workers/background/src/index.ts:50` (hourly scheduled reconciliation), `workers/background/src/dropbox/sync.ts:374` | all active project members |
| `edited_landed` | 4 — three in `workers/background/src/autohdr/finals.ts` (`:203,263,308`), one in `workers/background/src/workflows/autohdr-fetch.ts:184` | all active project members |
| `sent_to_editing` | 4 — `workers/background/src/workflows/autohdr.ts:282`, plus `workers/background/src/autohdr/claims.ts:137,621,870` (three) | all active project members |
| `autohdr_stalled` | 1 — `scanStalledAutoHdr`, hourly cron, `sourceKey: handoffId` (real dedup via the notifications table's own unique index) | all active project members |
| `delivered` | 1 — `workers/app/src/routes/projects.ts:659` | all active project members |
| `comment_added` | 1 — `workers/app/src/routes/annotations.ts:98`, the `POST` (creation) route only — the sibling `PATCH /annotations/:id` route (`:120`) never calls `notifyProject`, confirmed by reading it directly | project **editors only**, excluding the annotation's own author |

**Not all "once-per-lifecycle."** `edited_landed`/`sent_to_editing` can each fire multiple times —
AutoHDR rounds can repeat. `raw_ready`, `delivered`, and `autohdr_stalled` remain genuinely rare.
`comment_added` remains the clear frequency outlier (see below).

**A real, pre-existing gap, out of scope here**: `claims.ts:373`'s repeat-send path (a project
moving back into `editing_autohdr` for a second AutoHDR round) does not call `notifyProject(...,
"sent_to_editing")` at all — confirmed directly. Noted only so it isn't mistaken for something this
change introduces.

**Rate-limiting reality, corrected again in round 2 — `delivered` does not actually have a real
guard.** `raw_ready`, `edited_landed`, and `sent_to_editing` are each fired from call sites that
perform a genuinely **atomic, guarded** state transition — the notify only happens as a
consequence of a conditional `UPDATE`/batch that itself only succeeds from a specific prior state
(`guardedStageTransition` and equivalent inline guards). `delivered` is different, and round 1's
"stage guards keep the other 4 types rare" framing was still wrong to include it: re-reading
`projects.ts:645-659` directly —
```ts
const project = await db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
// ...
const updated = await db.update(schema.projects).set({ stageKey: data.stageKey, ... }).where(eq(schema.projects.id, id)).returning(...).all();
// ...
if (project.stageKey !== "delivered" && data.stageKey === "delivered") await notifyProject(c.env, id, "delivered");
```
the `UPDATE` has **no stage predicate at all** — it's unconditional on `id`, and the decision to
notify is made from a `SELECT` read *before* that update, not from the update's own result. Two
concurrent requests (or a project moving out of and back into `delivered`) can each read the old
stage as "not delivered," both commit the update, and both fire the notification — a genuine,
if narrow, double-send path this plan did not introduce but should not have mischaracterized as
guarded. This plan does not fix that route's own concurrency shape (out of scope — it's an
existing gap, not something widening the email array creates or worsens); it only corrects the
plan's own claim about it.

**`comment_added` and `delivered` both lack a stage-transition guard and a `sourceKey` dedup
key** — round 3 correction: `comment_added` is not uniquely unprotected, since `delivered`'s
"guard" is the stale-read TOCTOU documented above, which is not a real guard either. The actual
distinguishing fact is narrower: **`comment_added` is the only type that is unconditionally
emitted** — `POST /assets/:id/annotations` calls `notifyProject` on every successful request, with
no state check of any kind gating it. `delivered`, by contrast, is still gated by an
application-level conditional (`if (project.stageKey !== "delivered" && data.stageKey ===
"delivered")`) — that conditional is racy and can double-fire under concurrency, but in the normal
(non-racing) case it does bound the notification to transitions into `delivered`, unlike
`comment_added` which has no condition at all.

**Both workers are already fully wired for email.** `workers/app/wrangler.jsonc:21` and
`workers/background/wrangler.jsonc:24` both define a `send_email` binding named `EMAIL` —
repo-confirmable directly. `NOTIFICATIONS_FROM_ADDRESS`'s existence as a live secret on both
workers is **not** repo-provable (secrets are never committed); this plan relies on an earlier
live `npx wrangler secret list` run in this session, which listed it for both. Only
`workers/background`'s path was actually live-tested end-to-end (the real test email already sent
and received) — `workers/app`'s identical code path has not itself been exercised live in this
session. Both disclosures are stated as externally-verified facts, not repo-derived ones.

## Design

**One file changes**: `packages/db/src/notifications.ts`.
```ts
export const EMAIL_ENABLED_EVENTS: readonly NotificationType[] = [
  "raw_ready", "edited_landed", "sent_to_editing", "autohdr_stalled", "delivered", "comment_added",
];
```
No other file needs to change.

**Testing — split across two locations, corrected in round 2 for a real infrastructure
constraint the first draft missed, and refined in round 3 for the correct mock shape.**
`packages/db/vitest.config.ts` runs with `environment: "node"` — no Cloudflare D1/Miniflare
binding at all (confirmed by reading the config directly). The package's one existing test file
that touches DB-shaped code (`packages/db/src/stage-transition.test.ts`) works within that
constraint by hand-mocking a raw `D1Database` object exposing only `prepare()`/`batch()`
(`vi.fn()` stubs) — that shape is **not** what the new tests need. `emitNotifications()`'s
non-`sourceKey` insert path calls the Drizzle query-builder chain directly
(`db.insert(schema.notifications).values(values)`, and separately
`db.update(schema.notifications).set(...).where(...)`), not raw `prepare()`/`batch()` — so the new
tests must mock the Drizzle `Database` interface's chainable methods (`insert().values()`,
`update().set().where()`), a different shape from `stage-transition.test.ts`'s mock, which doesn't
expose those methods at all. Neither mock shape can exercise a real `INSERT ... ON CONFLICT`
against a real unique index, since a mock only returns whatever result is hard-coded, never
actually running SQL. `emitNotifications()`'s `sourceKey` path uses exactly that raw-SQL conflict
clause (`packages/db/src/notifications.ts:94-98`) — testing it for real needs a real D1
environment. Split accordingly:

**`packages/db/src/notifications.test.ts`** (new, Node env, mocking the Drizzle `Database`
interface's `insert().values()` / `update().set().where()` chain — not
`stage-transition.test.ts`'s `D1Database`/`prepare()`/`batch()` shape, which is a different
interface that doesn't cover what `emitNotifications()`'s non-`sourceKey` path actually calls):
1. All 6 `NotificationType` values are present in `EMAIL_ENABLED_EVENTS` — a direct assertion on
   the array itself, no DB involved at all.
2. `emitNotifications()` attempts an email send for each of the 6 types when `email`/`fromAddress`
   are provided (a fake `NotificationEmail` recording calls, a mocked DB whose `insert()` "succeeds"
   unconditionally — this doesn't need real conflict semantics, only the non-`sourceKey` insert
   path, which is a plain `db.insert(schema.notifications).values(values)` call), and does not
   attempt one when either is omitted.
3. A rejected send for one recipient (a fake `NotificationEmail` that rejects for one specific
   address, resolves for others) does not block the remaining recipients — assert the other
   recipients' rows still get `emailSentAt`/`emailMessageId`, **and** that the failing recipient's
   own row gets `emailError` set (round 2's minor finding — the existing app test only verifies
   this for a single recipient, this test explicitly covers the multi-recipient case for both
   outcomes together, not just the successful ones).
4. Precise about scope: an ordinary email-send rejection is caught and recorded to `emailError`
   without aborting the loop — these tests assert exactly that. They do not claim the *subsequent*
   `db.update(...).set({ emailError })` call succeeding is itself guaranteed — re-reading
   `emitNotifications()`'s exact structure confirms that specific inner update sits outside the
   function's `try`/`catch` and would propagate if it failed. Existing behavior, unrelated to
   widening the array, out of scope to change here — the tests should not imply a stronger
   guarantee than the code actually provides.

**`workers/background/test/notifications.test.ts`** (existing file, real Miniflare-backed D1 via
`cloudflare:test` — the only place this can actually be tested against real SQL): one new case —
seed a real `notifications` row for a specific `(type, sourceKey, userId)` triple (matching this
file's existing patterns for the stalled-scan dedup test already there), call `emitNotifications()`
again with the same triple and a fresh fake `NotificationEmail`, and assert **both** that the
`INSERT` is skipped (`ON CONFLICT DO NOTHING`, verified via a row-count check, not just trusting
the return value) **and** that the fake email's `.send()` was never called a second time for that
recipient — the row-level dedup and its email-level consequence are two different things to
verify, not one, and only one of them was previously tested here (the existing stalled-scan test
proves the row-dedup path works for `autohdr_stalled` specifically; this adds the email-side
assertion explicitly).

**Existing coverage, unduplicated.** `workers/app/test/notifications.test.ts` already covers
notification list/read scoping, `comment_added`'s `editorOnly`/`excludeUserId` filtering, and a
mocked email-send failure recording `emailError` (using `edited_landed`, already-enabled today).
`workers/background/test/notifications.test.ts` already covers multi-role recipient dedup with a
recorded email success and the stalled-handoff scan's own no-op-on-second-run behavior. This plan
adds to both files' existing scope, not around it.

## What is explicitly *not* changing

- No new binding, secret, or environment configuration.
- No retroactive email for `notifications` rows already inserted while a type was disabled.
- No retry, alerting, or queueing added for failed sends.
- No throttling, digesting, batching, or per-user email preference added for `comment_added` (or
  any type) — the user asked for all 6 types to email; this plan does exactly that, with
  `comment_added`'s unbounded frequency documented above rather than silently building unrequested
  scope on top of it.
- No fix to `delivered`'s unguarded-update concurrency shape (documented above as a real,
  pre-existing gap this plan's own research surfaced, not something it introduces or is
  responsible for fixing here) — flagged for awareness, not remediated by this change.
- No deduplication added for the 5 types that don't pass a `sourceKey` (every type except
  `autohdr_stalled`: `raw_ready`, `edited_landed`, `sent_to_editing`, `delivered`,
  `comment_added`).
- Repeated-AutoHDR-round email behavior is unchanged.
- The pre-existing `claims.ts:373` gap (a repeat-send transition not emitting `sent_to_editing` at
  all) is not fixed by this plan.

## Testing requirements for the build

1. `packages/db/src/notifications.test.ts` (new, mocked Drizzle `Database`) — the 4 cases above.
2. `workers/background/test/notifications.test.ts` (existing file, extended) — the real-D1
   source-key-conflict case above.
3. Full repo verify sequence per `CLAUDE.md` ("Verify before committing") — typecheck, `npm run
   build -w @quincy/web`, `npm run test --workspaces`, and the separate `packages/shared` vitest
   invocation the root script misses.
4. No existing test asserts a specific membership of `EMAIL_ENABLED_EVENTS`, so there is no old
   assertion to update or that could break from this change.

## Rollout

`packages/db` is a shared package consumed by both `workers/app` and `workers/background` — the
change takes effect once each worker that imports `@quincy/db` is rebuilt and redeployed. Deploy
**background then app**, matching the standing documented order. No migration.

## Routing (per Subagent-Orchestration.md §2 routing table)

A one-array-literal source change with an already-fully-wired execution path, plus new test
coverage correctly split across the two environments that can actually exercise each part —
**too small to be worth delegating**: Sonnet 5 (this session) builds directly. Terra still reviews
this plan and the diff afterward, per the user's explicit request and §2 policy 3.
