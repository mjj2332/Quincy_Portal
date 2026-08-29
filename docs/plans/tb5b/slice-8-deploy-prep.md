# TB5B Slice 8 — proof, deploy prep, rollback

Companion to `docs/plans/Revamp-TB5B-Kanban-Interaction-Modernization-Plan.md`. Records the
pre-deploy proof and the deploy/rollback procedure. **Not deploy authorization** — the fresh Sol
diff review, the Opus final-draft review, the Agy local-dev QA matrix, and a clean final §5 gate
must all pass first.

## Scope of the change

**UI-only. Web bundle / app-Worker deploy only.** No D1 migration, no `@quincy/shared`, no Worker
route/handler, no background/webhook-ingress change, no dependency change, no feature flag.

TB5B is **inert whenever `tb5a_board_contract_enabled` is OFF** or the board schema reports
maintenance — in those states the board renders ordinary cards/list, the drag handle button
renders **disabled** (out of tab order), and the ↑/↓ arrows and "Move to…" action are hidden. No
movement request can be issued. The flag is currently **ON** in production (flipped at the TB5A
deploy 2026-08-29).

## Build proof (fix-round worktree based on commit `6f27c20`, branch `tb5b-kanban-interaction-modernization`)

### Feature diff boundary — `git diff b4f8fda..HEAD` (measured at `a02f450`)

- 27 files: 23 under `portal/apps/web/`, 4 under `docs/` (`lessons.md`, `todo.md`, the plan, this
  deploy-prep doc). **Zero** changes to `portal/package.json`, `portal/package-lock.json`,
  `portal/packages/**`, `portal/workers/**`.
- `ls portal/packages/db/migrations/*.sql | tail -1` → `0037_project_board_order_contract.sql`
  (unchanged — next migration number stays `0038` for a later phase).
- `b4f8fda` (`fix(db-tests): repoint TB5A fence-design path`) is a **pre-existing `main` breakage**
  fix (TB5A's deploy commit `bbbb8cf` git-mv'd `docs/plans/tb5a/` without updating two
  `packages/db` test paths). Orthogonal to TB5B; safe to cherry-pick to `main` independently. It is
  the reason the TB5B feature diff is measured from `b4f8fda`, not `47e9675`.

### `@dnd-kit` — no dependency change

`@dnd-kit/core@6.3.1`, `@dnd-kit/sortable@10.0.0`, `@dnd-kit/utilities@3.2.2` were already pinned +
installed + used in production (`CollectionPanel`, `SubtaskChecklist`) before TB5B. TB5B imports
only their public APIs (`DndContext`, sensors, `SortableContext`, `useSortable`, `useDroppable`,
`DragOverlay`, collision helpers, `sortableKeyboardCoordinates`, `CSS.Transform`). **No**
`@dnd-kit/modifiers` or `@dnd-kit/accessibility` direct import (verified by grep;
`@dnd-kit/accessibility` remains transitive through core).

### Bundle / CSS delta

- `@dnd-kit` was already in the bundle pre-TB5B, so the marginal JS delta is the new board module
  source only (`ProjectKanbanBoard.tsx` + `kanban-interaction.ts`, ~1.7k source lines) minus the
  deleted native-drag code in `Dashboard.tsx`. Post-TB5B: `dist/assets/index-*.js` ≈ 1,213 kB
  (gzip ≈ 361 kB), `dist/assets/index-*.css` ≈ 128 kB (gzip ≈ 22 kB). The ">500 kB chunk" Vite
  warning is pre-existing (single-bundle SPA), not introduced by TB5B.

### §5 gate (run from `portal/`, 2026-08-30, fix-round worktree based on commit `6f27c20`)

| Command | Result |
|---|---|
| `npm run typecheck` (6 workspaces) | PASS |
| `npm run build -w @quincy/web` | PASS |
| `npm run test --workspaces` | PARTIAL — `packages/db` 109, `apps/web` node 135 + happy-dom 377, `webhook-ingress` 13; `workers/app` / `workers/background` blocked by sandbox `EPERM` on loopback bind and Wrangler log writes |
| `npx vitest run --config packages/shared/vitest.config.ts` | PASS — 99 |

`apps/web` node went 147→135 across Slice 7 — a verified 1:1 dedup of pure-logic assertions from
the `./Dashboard` re-export era into the direct `kanban-interaction.test.ts` / `stage-move.test.ts`
suites. No coverage lost.

### Invariants held across the whole build (grep-verified on `Dashboard.tsx`)

- `setQueryData` on the dashboard query key appears **once** — Priority's `updateProjects`. No Board
  movement path writes the cache (Opus B4).
- `movementSettlePending` is **absent** from the `interactionBlocked` expression and never gates
  `acceptDashboardProjects` / `queuedRefreshRef` / the queued-refetch effect (Opus B1 — no
  self-deadlock; the barrier-release is tested on both the happy path and after a failed-then-
  successful settle refetch).
- `markPrincipalTerminal()` in `runBoardMovement` fires only on `401` (a `moveProjectStage`
  capability `403` is a command failure, not a principal wipe).
- `DndContext.accessibility.restoreFocus === false` (asserted in DOM tests).
- The cross-tab `dashboard-board-invalidated` message carries exactly
  `{version, type, sourceTabId, committedAt}` — no project/Stage/revision/role identifier.
- No native drag: zero `draggable=` / `dataTransfer` / `DragEvent` / `suppressNavigation` in
  `Dashboard.tsx` + `ProjectKanbanBoard.tsx`; zero synthetic native `DragEvent` in tests.

## Review status

1. **Fresh Sol diff review** of `b4f8fda..HEAD` — **DONE** (2 rounds: mid-build S1–S3 + full diff;
   5 blocking + 8 should-fix + 2 nits closed) → Luna fix rounds → **Sol focused verify pass DONE**
   (all closed, all invariants CONFIRMED).
2. **Opus final-draft review** (`Agent` tool, `model: opus`) — **DONE**: all four load-bearing
   invariants + the shipped TB5A contract independently CONFIRMED, gate reproduced green; **1
   blocking regression** (empty-Stage-column moves) found + fixed (`71203f1`); **Sol focused confirm
   DONE — CLEARED FOR QA + DEPLOY**.

## Still required before deploy

3. **Agy local-dev QA matrix** against `http://localhost:8787` (needs a human Google sign-in in
   Agy's dedicated Chrome; see `docs/Subagent-Orchestration.md` §2.8). Plus the **Slice 5
   acceptance items that need real hardware** (orchestrator/owner action):
   - a physical touch-capable Chrome or remote-debuggable Android for touch-drag activation vs.
     scroll-fling;
   - real VoiceOver or NVDA for the live-announcement cadence (assertive dnd-kit region vs. polite
     Dashboard region);
   - horizontal + nested autoscroll under a real drag;
   - keyboard drag → confirmation-required → focus stays inside the modal ≥ 2 animation frames;
   - keyboard multi-container / off-screen-column traversal (if `sortableKeyboardCoordinates` fails
     the matrix, switch to the plan's approved Board-local coordinate getter and rerun).
4. **Final §5 gate** from a clean tree.

## Deploy (after all of the above pass)

App Worker only. There is no background / webhook-ingress / migration step.

```bash
# 1. record the rollback target
cd portal/workers/app && npx wrangler deployments list   # note the current live version id

# 2. merge the branch to main (squash or merge commit per Terry's preference), then from main:
cd portal && npm run typecheck && npm run build -w @quincy/web \
  && npm run test --workspaces \
  && npx vitest run --config packages/shared/vitest.config.ts

# 3. deploy
cd portal/workers/app && npx wrangler deploy
```

Host: `quincy.flamingfire.my` (prod, no staging).

## Rollback

`npx wrangler rollback [<previous-version-id>]` on `quincy-portal-app` (or
`cd portal/workers/app && npx wrangler deploy` from the pre-merge commit). **No D1 recovery, no
background rollback, no flag change, no data repair** — TB5B touches only the served SPA bundle.
Flipping `tb5a_board_contract_enabled` OFF also renders TB5B inert (falls back to plain
cards/list) without a redeploy, as a faster mitigation for a board-interaction-only regression.

## Passive production verification checklist (post-deploy, no mutations)

- [ ] `/api/health` → 200; login screen renders.
- [ ] Dashboard loads; Kanban view renders all active Stage columns with cards in authorized order.
- [ ] Each card shows: the project link (`/projects/:id`, opens/new-tabs normally), a dedicated
      `Move {street}` handle button (separate from the link), a `Move to…` button, the TB4B
      Deadline/overdue label, and **no** card-level RAW count. List row still shows RAW received.
- [ ] `Move to…` opens the two-step dialog (Stage → position) and closes on Escape / outside click;
      no request is made by just opening/closing it.
- [ ] Sort control switches Board / Priority / shoot-date with no full-board reload and no blank
      flash; sort is disabled while a drag/proposal is active.
- [ ] Flag-OFF spot check (if a maintenance window is used): board renders cards; the drag handle
      is present but `disabled`; the ↑/↓ arrows and "Move to…" are hidden; no movement request fires.
- [ ] Archived Dashboard is List-only.
- [ ] Project Workspace rail Stage control renders and is keyboard-focusable
      (`data-focus-key="rail-stage:…"`).
- [ ] Console + network clean; no 4xx/5xx from `/api/projects` or the board assets.
- [ ] No mutation performed (confirm via `audit_log` in the window if in doubt).

## Post-deploy closeout

1. Fill the `docs/lessons.md` STUB entry from the QA-phase real-Chrome + AT observations (or record
   "no real-browser defect found").
2. Update `docs/todo.md` — move the TB5B bullet from "built, not deployed" to a deployed record
   with the merge commit + app Worker version + rollback target + the passive-verification result,
   and append TB5B to the "Current state" one-liner.
3. Update this plan's status line to deployed (commit + version), and `git mv`
   `docs/plans/Revamp-TB5B-Kanban-Interaction-Modernization-Plan.md` → `docs/plans/implemented/`
   and `docs/plans/tb5b/` → `docs/plans/implemented/tb5b/` (to keep history).
