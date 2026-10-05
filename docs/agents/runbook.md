# Agent runbook

Commands run from `portal/` unless a line says otherwise.

## Test & verify

- **Everything CI runs:** `npm run verify` (`portal/scripts/verify.mjs`) runs each tsc, the web build and
  every vitest config, one log per step in `$VERIFY_LOG_DIR` (default: a fresh temp dir), and prints
  `PASS/FAIL  step  seconds  logpath`. Narrow with `-- --only <substring>` or `-- --from <step>`.
  `packages/shared/test/verify-steps.guard.test.ts` keeps its `STEPS` equal to `.github/workflows/portal.yml`.
- **One file:** `cd <package dir> && npx vitest run <path>`. `apps/web` finds `*.test.ts` and
  `*.dom.test.tsx` alike (two projects, `unit` and `dom`, in `apps/web/vitest.config.ts`). Select one with
  `npx vitest run --project dom` or `--project unit` (add a path to narrow further).
- **Type check one package:** `npx tsc -p <package dir>/tsconfig.json`.
- **Web build prerequisite:** `workers/app` tests read `apps/web/dist`. A missing build stops at
  `apps/web/dist is missing` (`workers/app/vitest.global-setup.ts`); run `npm run build -w @quincy/web`.
- **Long runs:** the full suite takes over 120s. Run it in the background with output to a file
  (`npm run verify > "$SCRATCH/verify.out" 2>&1 &`), then grep the log.

| Directory | Workspace name |
|---|---|
| `packages/shared` | `@quincy/shared` |
| `packages/db` | `@quincy/db` |
| `apps/web` | `@quincy/web` |
| `workers/app` | `@quincy/worker-app` |
| `workers/background` | `@quincy/worker-background` |
| `workers/webhook-ingress` | `@quincy/worker-webhook-ingress` |

## macOS zsh

- In-place edit: `sed -i '' 's/a/b/' file` (BSD sed takes an empty suffix argument).
- Quote globs (`'src/**/*.ts'`) and use `rg -g '*.ts'`; unquoted, zsh aborts with `no matches found`.
- There is no `timeout`: `perl -e 'alarm 60; exec @ARGV' cmd args`.
- `${PIPESTATUS[@]}` is bash-only. In zsh read `$pipestatus`, or run the commands separately and check `$?`.

## Touching X, read Y

| You are touching | Read first |
|---|---|
| A D1 table or column | `docs/Guides/Local-QA-Fixtures.md` ("What a new table or column must touch") and `docs/maps/new-table.md` |
| A Hono route | `docs/maps/routes.md`, then add it to `workers/app/test/route-manifest.test.ts` |
| A DOM test (`*.dom.test.tsx`) | `apps/web/src/testing/test-seam.guard.test.ts`: select by role, label or `data-testid`, never a Quincy class name |
| A vitest config | `packages/shared/test/ci-vitest-configs.guard.test.ts` (CI must run it; it must wire `requireExecutedTests`) |
| Auth, Hono routing, the review lightbox | `docs/lessons.md`; find the entry with `node scripts/lessons-index.mjs <tag\|#NNN\|text>` (from the repo root) and tags in `docs/lessons-tags.md` |
