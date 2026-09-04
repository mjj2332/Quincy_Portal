# TB8 — Wider UI Migration and Cleanup: Kickoff

**Status: COMPLETE, 2026-09-04.** All 11 roadmap candidates resolved: #1–#10 shipped to production
(see their own dated status lines below); #11 (legacy fetch/emission paths) investigated and closed
as not applicable — its two plausible targets turned out to be active, load-bearing code, not dead
legacy owners (see #10's entry below for the full finding). See
[roadmap/TB8-Wider-UI-Migration-And-Cleanup.md](revamp_2026_portal/roadmap/TB8-Wider-UI-Migration-And-Cleanup.md)
for the approved scope (selection order, candidate releases, rules, completion criteria) — this doc
adds the pipeline this session used and the scope extension agreed 2026-09-01.

## Why this deviates from the standing pipeline

TB8 is the tracer-bullet series that originated a Claude-only design lane for frontend
plan-and-build work, now generalized and recorded at
[Subagent-Frontend-Orchestration.md](../Subagent-Frontend-Orchestration.md) — read that doc for
the full pipeline, rationale, scope-extension rule, design-system source, and the unlayered-CSS
gotcha. It is a scoped, deliberate exception per
[Subagent-Orchestration.md](../Subagent-Orchestration.md) §1's own footnote that Sonnet-tool builds
are valid at this session's discretion, and every TB8 candidate release runs through it.

Agy retains its normal QA/testing role (§2.8–§2.10 of the standing doc) unchanged — the frontend
lane only touches the plan-and-build stages, not testing.

## Next step

Rank the roadmap's candidate releases per the roadmap's selection-order criteria (operational
pain, unwanted-drift severity, reuse value, accessibility risk, ability to retire a legacy owner)
and pick the first surface to run through the pipeline above.

## Ranking (2026-09-01)

1. **Dashboard shell/filters/cards/navigation** — highest reuse value, TB0-VIS-01 flags a real
   390px overflow/clipping bug, roadmap itself favors shell/ordinary-controls first.
2. Ordinary menus/dialogs/popovers/sheets
3. Project Workspace rail/collection controls/states
4. Remaining project/admin forms
5. Notification bell/preferences/Admin delivery UI
6. Board filters/card controls — **shipped as TB8-06, 2026-09-03** (the whole Kanban board; the
   filters half was already converged by TB8-01)
7. Collaboration/checklist/comments (fresh from TB6, low priority) — **shipped as TB8-07, 2026-09-04**
8. Notice board (fresh from TB7, too new) — **shipped as TB8-08, 2026-09-04**
9. Lightbox controls (only if evidence warrants) — **shipped as TB8-09, 2026-09-04** (warrant confirmed; app Worker `7c7cdafe`).
   Evidence: ~250 lines of `app.css` (the largest remaining legacy block) owned by a single
   consumer, `Lightbox.tsx`; TB8-02-E-1's deferred `.viewer__panel-scrim` points here explicitly;
   and TB0-VIS-02's "no local media" blocker on matched evidence is resolved (the R2 storage-plane
   fix in `lessons.md`, plus `media.ts`'s dev direct-original fallback for `/web` and `/thumb`).
10. Dead selectors / final base/Preflight decision (cleanup, near the end) — **registered as
    `TB8-10-Deferred-Defects-And-Cleanup-Sweep-Plan.md`**, which also absorbs every defect the
    earlier candidates deferred. Runs after #6-#9. **Split in two, 2026-09-04**, once re-measurement
    showed the register's figures were stale: **TB8-10A** (the owner's toolbar change plus the seven
    bounded defects — **shipped 2026-09-04, app Worker `e8825a98`**) and **TB8-10B** (D-05
    `--text-muted`, D-06 the `.button` retirement, D-07 the base/Preflight decision — **all three
    shipped 2026-09-04**, final app Worker `f0e41474`; moved to `implemented/`). D-06 turned out to be
    100 whole-app tokens across 14 files, 8 of them Production Calendar — i.e. converging a surface
    that was never on the TB8 list, which is a visual release with its own evidence and gate, not a
    cleanup item. D-07 (enable Preflight) revised approved D-16.
11. Legacy fetch/emission paths (roadmap-gated: last, only after replacements prove ownership) —
    **investigated 2026-09-04, closed as not applicable to the two candidates checked.** The two
    plausible "legacy" targets in the codebase are `emitNotifications()` (`packages/db/src/
    notifications.ts`) and the AutoHDR poll fallback (`legacyTimerRef`,
    `screens/ProjectWorkspace.tsx`). Neither is a safe retirement as scoped:
    - `emitNotifications()` is **not legacy-dead code** — it is the active, only in-app-notification
      /email path for `raw_ready`, `sent_to_editing`, `edited_landed`, `comment_added`,
      `autohdr_stalled`, `subtask_due_today`, `subtask_assigned`, and `mentioned`, called from 13+
      live sites across background Workflows, Durable Object claims, ingest, and annotation routes
      (verified directly, not just by a subagent's report). The TB4 `notification_outbox` system is
      a parallel mechanism for external-editor-safe delivery, not a superset replacement — retiring
      this would delete real notification delivery, not clean up dead code.
    - The AutoHDR poll loop is confirmed scoped only to the pre-PR-44 manual/scaffold AutoHDR flow —
      its effect explicitly bails out (`jobs.some((job) => job.kind === "autohdr_api_send")`)
      whenever a modern Direct Send job exists (verified directly at
      `ProjectWorkspace.tsx` line ~270). Whether it is safe to retire depends on whether the manual/
      scaffold flow is still used in production, which is a product fact, not something code-reading
      answers, and it was not available this session.
    If "legacy fetch/emission paths" was meant to refer to something else, it needs re-identifying
    before this candidate can be planned. **TB8 is otherwise complete** — see candidate #10's
    close-out above.

## Decision: Tailwind adoption scope for TB8 (2026-09-01)

TB1 (deployed 2026-08-25) scoped Tailwind v4/shadcn/Base UI to exactly one bounded consumer — the
`ProjectFields` Client section — per D-16/A8. `app.css`/`index.css` for the rest of `apps/web` does
not otherwise consume Tailwind; the Dashboard shell currently styles entirely through the ported
CSS-custom-property token system.

**Owner decision: TB8 extends Tailwind to the Dashboard shell surface** (candidate release #1),
using the existing Tailwind v4 + shadcn (`base-sera` style, `cssVariables: true`, Lucide icons,
Preflight disabled, no dark mode) foundation already wired in `portal/apps/web/components.json`
and `src/styles/index.css` — not a new/parallel Tailwind setup. This widens what TB1 called "one
bounded consumer" to a second, TB8-owned surface; it is not a whole-app rewrite (roadmap rule
still holds) and every token must still trace to the ported design-system values, now expressed as
Tailwind theme/utility classes instead of raw CSS custom properties directly. Matched evidence
stays at TB1's viewports (`1440×900`, `1024×768`, `390×844`).

The first Dashboard shell visual plan (`TB8-01-Dashboard-Shell-Visual-Plan.md`, drafted before this
decision) assumed `app.css`/CSS-custom-properties stays the sole styling owner — it is being
revised to the Tailwind/shadcn foundation per this decision before it goes to Sol for review.
