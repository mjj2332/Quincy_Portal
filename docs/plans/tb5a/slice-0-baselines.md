# TB5A Slice 0 — baselines

Captured 2026-08-28 before and after the characterization-only changes.

## Repository baseline

- Branch: `tb5a-stage-kanban-ordering`.
- Parent / implementation baseline: `2a7a2bc5f3262c3a64c0019e22c518aeba7ce886` (`2a7a2bc`), whose parent is `192c12bbe04c6e7425b5fe4dadf946bb6eeb7c46`.
- Migration journal and migration-directory tail: `0036_external_editor_assigned_scope` (journal index 36). No migration or snapshot was added; the next available migration number remains `0037`.
- React and React DOM: `19.2.8`. Dependencies were already installed and remain pinned as checked in; no `npm install` was run.
- Existing untracked `qa-evidence/` is user-owned evidence. It was preserved and is not part of this Slice 0 change or commit.

## Test counts

Counts are Vitest file/test totals printed by the workspace commands. The Worker pool suites could not reach collection in this managed sandbox: Wrangler/Miniflare attempted to listen on `127.0.0.1` and received `listen EPERM`. Their before/after counts are therefore recorded as not collected rather than inferred.

| Workspace / command | Before Slice 0 | After Slice 0 |
|---|---:|---:|
| `@quincy/worker-app` / `npm test -w @quincy/worker-app` | not collected — pool bootstrap `EPERM` | not collected — pool bootstrap `EPERM` |
| `@quincy/worker-background` / `npm test -w @quincy/worker-background` | not collected — pool bootstrap `EPERM` | not collected — pool bootstrap `EPERM` |
| `@quincy/db` / `npm test -w @quincy/db` | 17 files / 60 tests | 18 files / 62 tests |
| `@quincy/web` Node sub-run / `npm test -w @quincy/web` | 15 files / 108 tests | 17 files / 110 tests |
| `@quincy/web` happy-dom sub-run / `npm test -w @quincy/web` | 31 files / 309 tests | 31 files / 309 tests |
| `@quincy/shared` / `npx vitest run --config packages/shared/vitest.config.ts` | 15 files / 89 tests | 15 files / 89 tests |

The web DOM sub-run still reports its existing blocked-localhost `AggregateError` diagnostics, but the command exits successfully and reports the totals above. The worker failures are detailed in the Slice 0 gate report.

## Added characterization coverage

- Internal Board comparator, including null Priority, midpoint, and equal-position ID ties.
- `orderedBoardRows`, `manualInsertNeighbors`, and legacy `renumberedInsertPosition` outputs.
- Priority route's current Priority-to-`board_position` coupling and exact midpoint result.
- External adapter's manufactured `boardPosition: 0` and resulting ID fallback.
- `guardedStageTransition` append position, single audit, winning-batch hook, and loser behavior.
- Archived-row exclusion plus visible/escapable inactive configured Stage behavior.
- Current API list ordering, which remains shoot-date-based and is distinct from the Board comparator.
