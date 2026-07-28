# Build Handoff — 6 Approved Feature Plans

**COMPLETED 2026-07-28 — all six plans built, verified, committed, migrated, and deployed to
production.** See `docs/todo.md`'s "Implemented plans" section for the final summary (commits,
bugs found/fixed, the real production migration-0020 failure and fix) and
`docs/plans/implemented/` for the plan docs themselves (moved there from `docs/plans/` once
shipped). Kept below for historical/provenance reference only — the recommended build order and
cross-plan coordination notes it describes are what was actually followed, but nothing in this
batch is still pending.

**Purpose (historical)**: resume implementation of six already-planned, already-Terra-approved features on a
different machine/session without re-deriving context. Read this first, then
`docs/Subagent-Orchestration.md` for the mechanics of actually running the pipeline.

**Snapshot state at handoff**: `main` @ `7498bf3` (pushed). Nothing in this batch is built yet —
only the six plan documents and a `docs/todo.md` update are on `main`. Next available D1
migration number: **`0018`** (confirmed against `packages/db/migrations/meta/_journal.json` at
handoff time — **re-confirm this yourself before generating any migration**, since two plans in
this batch each need one and the number depends on build order).

---

## 1. What's already done

All six plans went through the full Sonnet-drafts → Terra-reviews-in-fresh-context loop per
`docs/Subagent-Orchestration.md` §2 and are **APPROVED**. Nothing has been built — planning only,
per explicit user instruction at the time. Read each plan doc in full before building it; this
handoff does not repeat their content, only orients you to the batch.

| # | Plan doc | Feature(s) | Review depth | Notes |
|---|---|---|---|---|
| 1 | [`docs/plans/PhotoGrid-Select-All-Plan.md`](plans/PhotoGrid-Select-All-Plan.md) | Select-all button for the images grid | 2 rounds | Frontend-only, single component, zero dependencies |
| 2 | [`docs/plans/Editor-As-Photographer-Assignment-Plan.md`](plans/Editor-As-Photographer-Assignment-Plan.md) | Editors assignable to a project's photographer slot | 3 rounds | Frontend-only, one-line picker-filter change, zero dependencies |
| 3 | [`docs/plans/Photographer-Stage-Visibility-Plan.md`](plans/Photographer-Stage-Visibility-Plan.md) | Restrict photographer visibility to awaiting_raw/raw_review | 4 rounds, max effort throughout | **Fixes a live access-control gap** — photographers currently see assigned projects at every stage. No migration, no dependencies. |
| 4 | [`docs/plans/Notice-Board-Plan.md`](plans/Notice-Board-Plan.md) | Collapsible dashboard chat-style message board | 3 rounds | New table + routes + frontend, self-contained. **One open question** — see §4 below. |
| 5 | [`docs/plans/Notifications-Plan.md`](plans/Notifications-Plan.md) | In-app + email notifications, incl. comment/annotation alerts | 8 rounds — largest in the batch | New table + `send_email` binding + many scattered background-worker call sites. Needs a migration. |
| 6 | [`docs/plans/Kanban-Priority-And-Manual-Ordering-Plan.md`](plans/Kanban-Priority-And-Manual-Ordering-Plan.md) | Project priority + manual Kanban reordering | 9 rounds — tied for largest | New columns on `projects` + many scattered background-worker call sites. Needs a migration. Coordinates with #5 — see §3 below. |

Why #5 and #6 took so many rounds, worth knowing before you build them: the real set of code
paths that change a project's `stage_key` turned out to be far more scattered across
`workers/background` and `workers/app` than either first draft assumed (multiple distinct AutoHDR
code paths, some not discovered until round 3-4 of review). Both plan docs now carry an explicit
**mandate to re-grep the whole `workers/background/src/` and `workers/app/src/` tree for every
direct `stage_key`/`stageKey` write before implementation**, cross-checked against the plan's own
enumeration rather than trusting it as final. Do not skip that re-grep — it's there because the
plan's own list was wrong or incomplete in nearly every review round.

---

## 2. Recommended build order

1. **PhotoGrid-Select-All-Plan.md** — small enough to build directly (this session, per
   `docs/Subagent-Orchestration.md` §2's "too small to be worth handing off" row) rather than
   delegate to Terra; still gate with a fresh-context Terra diff review before §5.
2. **Editor-As-Photographer-Assignment-Plan.md** — same tier, same treatment.
3. **Photographer-Stage-Visibility-Plan.md** — prioritize early on correctness grounds (it's
   closing a live gap, not just reducing risk). Routes to the security/auth row: Terra builds,
   Terra reviews the diff in a **separate max-effort run**.
4. **Notice-Board-Plan.md** — self-contained, no interaction with #5/#6. Normal Terra build →
   Terra review. Confirm the global-vs-project-scoped open question (§4 below) before or during
   the build.
5. **Notifications-Plan.md**, then
6. **Kanban-Priority-And-Manual-Ordering-Plan.md** —
   **build these last, back-to-back, in this order.** Both independently landed on the same wide
   set of scattered stage-writer call sites (`dropbox/sync.ts`, `ingest.ts`, `autohdr/claims.ts`,
   `autohdr/finals.ts`, `autohdr-fetch.ts`, and `workflows/autohdr.ts:277-279` specifically — see
   §3 below for why order matters here). Both route to "large cross-system change": Terra builds,
   Terra reviews at max effort given the size and file count. Confirm the actual next migration
   number in `packages/db/migrations/meta/_journal.json` immediately before *each* build — don't
   reuse the `0018` noted above without rechecking, since #5's own migration consumes it first in
   this order.

---

## 3. Cross-plan coordination point — read before building #5 or #6

Both `Notifications-Plan.md` and `Kanban-Priority-And-Manual-Ordering-Plan.md` touch the exact
same statement: the unguarded `stage_key = 'editing_autohdr'` update in
`workers/background/src/workflows/autohdr.ts:277-279`.

- `Notifications-Plan.md`'s own build **adds a real guard** to this statement
  (`WHERE id = ? AND stage_key = 'raw_review' AND archived_at IS NULL`) to fix a genuine TOCTOU
  gap in its own notification-emission logic, and also specifies new behavior for the surrounding
  Cloudflare Workflow step (`AutoHdrSend.run()`'s `"mark-send-running"` step) on a guard miss —
  see that plan's "Generation mechanism" section for the exact required behavior (idempotent
  continue if already `editing_autohdr`, throw/abort otherwise, mirroring a guard-check pattern
  that function already uses one branch over).
- `Kanban-Priority-And-Manual-Ordering-Plan.md`'s own build splices a `board_position`-assignment
  SQL expression into this same statement.

Building #5 (Notifications) first, per the recommended order above, means #6's (Kanban's) build
should find the guard already present and just splice its expression into the now-guarded
statement — not re-add the guard itself. If for any reason you build Kanban first instead,
Kanban's plan describes the statement as "unconditional, no guard to gate on" (still correct, just
a different atomicity story) — Notifications' later build then adds the guard on top of Kanban's
already-present `board_position` expression. Either order is workable per both plans' own text;
just don't build both without checking what the other has already touched at this exact site.

---

## 4. Open decision still needed — Notice-Board-Plan.md

The plan defaults to a **global** message board (not project-scoped) — Terra approved it on that
basis, but the request itself didn't explicitly rule out project-scoping, and this was never
confirmed with the user as a hard decision (unlike the two decisions in §5 below, which *were*
explicitly confirmed). Confirm with the user before or during this build; the plan's own "Open
question" section has the full context and reasoning for the default.

---

## 5. Decisions already made explicitly by the user (don't re-litigate)

- **Kanban ordering semantics**: a priority edit repositions *only* the edited card among its
  column siblings (via an anchor/tie-break rule) — **not** a full-column resort. This was a
  deliberate choice between two designs Terra's round-1 review surfaced; the user picked this one
  specifically because the full-resort alternative could silently erase other admins' manual
  up/down nudges.
- **Photographer stage-visibility cutoff**: a **blanket** cutoff — once a project passes
  raw_review, the photographer loses all access to it, including their own past
  uploads/annotations there. The softer alternative (read-only access to their own prior
  contributions) was explicitly offered and declined.

---

## 6. Process reminders (see `docs/Subagent-Orchestration.md` for full detail)

- **Pipeline per plan**: builder (Terra/Luna/this session, per §2's routing table) implements and
  self-checks against every plan item → **Terra reviews the diff itself, fresh context, separate
  invocation from whoever built it** → builder applies clearly-identified fixes → Terra final
  focused pass on unresolved high-severity findings → Opus final-draft review (skip only if this
  session is itself running as Opus) → **§5 gate, run independently in this session, never
  trusted from an agent's self-report**: full verify sequence from `CLAUDE.md` ("Verify before
  committing"), plus a direct read of the security/correctness-critical parts of the diff → only
  then deploy and commit.
- **Verify-before-committing, from `portal/`**: `npm run typecheck` (all six workspaces),
  `npm run build -w @quincy/web`, `npm run test --workspaces`, **and** the separately-invoked
  suites `npm run test --workspaces` silently misses:
  `npx vitest run --config packages/shared/vitest.config.ts` (pre-existing gap) **and, once
  Kanban's build adds it**, `npx vitest run --config packages/db/vitest.config.ts` (a new gap
  Kanban's plan explicitly creates and documents — `packages/db` has never needed a test runner
  before this batch).
- **Deploy order**: background → webhook-ingress → app, because service bindings resolve at
  deploy time. Both #5 and #6 touch `workers/background` *and* `workers/app` — deploy background
  first for each.
- **Spawn procedure** (§4 of Subagent-Orchestration.md): write the build/review spec to a
  scratchpad file first, launch Codex in the background (`workspace-write` for builds,
  `read-only` for reviews), read the report file, never the raw transcript.
- **Nothing deploys or commits on an agent's self-report** — only after the §5 gate passes in
  this session, independently.

---

## 7. Before you start

```bash
git pull
```
to make sure you have `7498bf3` and everything after it. Then re-read
`docs/Subagent-Orchestration.md` in full (it may have changed since this handoff was written —
it's a living document) and start with plan #1 above.
