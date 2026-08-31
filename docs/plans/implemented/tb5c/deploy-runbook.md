# TB5C — deploy runbook

Prepared 2026-08-31. Branch `tb5c-production-calendar` @ `8853fb2`, base `main` @ `f6af664`.

## Pre-flight (all green as of prep)

- [x] 6-workspace gate: `npm run typecheck`; `npm run build -w @quincy/web`;
      `npm run test -w @quincy/web` (190 node + 529 dom); `npx vitest run --config
      packages/shared/vitest.config.ts` (126); `workers/app` 279 (+1 skip); `background` 253;
      `webhook-ingress` 13.
- [x] Boundary: **app Worker only.** `git diff main...HEAD --name-only` — no
      `packages/db/**`, no `**/migrations/**`, no `schema.ts`, no `workers/background/**`,
      no `workers/webhook-ingress/**`, no `prototype/**`. `workers/app` changes are only
      `src/index.ts` (router mount), `src/lib/terminal-route.ts` (external-surface allow-list +
      seed rows), `src/routes/production-calendar.ts` (new), + tests. D1 migration **0038** is
      still unused.
- [x] Launch gate: the `viewProductionCalendar` capability (granted admin / internal editor /
      external_editor in `packages/shared/src/capabilities.ts`). **No `feature_flags` seed** —
      the capability lands atomically with a fully mounted handler.
- [x] Deps: `@fullcalendar/core@7.0.2`, `@fullcalendar/react@7.0.2`, `temporal-polyfill@1.0.4`
      (pinned) + 2 zero-dep polyfill transitives; no install scripts.
- [x] Reviews: fresh-Sol whole-branch APPROVE; Opus final-draft APPROVE WITH FOLLOW-UPS (all
      resolved); Agy Slice 10/11 matrix all-PASS. Physical-phone + real-AT waived by owner.

## Rollback target

**Current production app Worker version: `2b515484-44c6-4550-a1e2-62f88c6a8b73`**
(deployed 2026-08-29T21:58 — the TB5B deploy).

Rollback:
```bash
cd portal/workers/app
npx wrangler rollback 2b515484-44c6-4550-a1e2-62f88c6a8b73
```
Any TB4B/TB4D writes that land before a rollback are canonical `deadline_*` / `project_subtasks`
writes against unchanged commands — valid source data, no repair needed. No DB rollback.

## Deploy steps

1. **Merge to `main`** (from `portal/` repo root):
   ```bash
   git checkout main && git pull --ff-only
   git merge --no-ff tb5c-production-calendar -m "Merge TB5C: Production Calendar"
   git push origin main
   ```

2. **Build the SPA + deploy the app Worker** (the app Worker bundles `apps/web/dist` as static
   assets via its `assets.directory` binding):
   ```bash
   cd portal
   npm run build -w @quincy/web
   cd workers/app
   npx wrangler deploy
   ```
   Record the new version id from the deploy output.

   `workers/background` and `workers/webhook-ingress` are **not** redeployed — neither changed and
   neither consumes the new `/api/production-calendar` route.

## Post-deploy passive checks (production, no mutations)

- Sign in at <https://quincy.flamingfire.my> as Admin → the Dashboard shows the **Calendar** view
  selector (3rd option). Open it → Month renders, toolbar reads "Sydney time · AEST" (or
  "AEST/AEDT" for a grid crossing Oct 4). No console errors.
- A non-capability principal (Photographer) → no Calendar selector; a direct
  `/?view=calendar&...` URL replaces to `/`.
- `GET /api/production-calendar?...` for Admin returns 200 with the strict shape; for an
  unauthenticated request, 401.
- Do **not** perform a real drag-save on a live project as a smoke test unless intended — the
  first real save is a genuine TB4B/TB4D mutation.

## Deployed 2026-08-31

- Merge commit on `main`: **`a7684d8`** ("Merge TB5C: Production Calendar"), pushed
  `6fad404..a7684d8` (also carried the previously-unpushed `f6af664` circular-import fix +
  `a7317c3` lessons doc).
- Post-merge 6-workspace gate green on `main`.
- App Worker deployed: **version `2ba08078-3db8-4a4c-b787-c41484da224e`** (2026-08-30 23:12 UTC),
  `cd portal/workers/app && npx wrangler deploy` — 5 static assets uploaded, Worker startup 74 ms.
  `background` / `webhook-ingress` **not** redeployed.
- Post-deploy passive checks (all PASS): `https://quincy.flamingfire.my/` → 200;
  `GET /api/production-calendar?...` → 401 "Authentication required" (route + auth/capability gate
  live); trailing-slash `/api/production-calendar/?...` → 401 (both route forms registered);
  `/assets/ProductionCalendar-CPONk_wj.js` → 200 / 340,735 B and referenced by a dynamic import in
  `index-*.js`; `wrangler deployments status` shows `2ba08078` at 100%.
- Plan moved to `docs/plans/implemented/`.

## Optional follow-ups (not blocking, recorded for later)

- Opus N1 — drop the write-only `calendarSettle` prop from `Dashboard` (a settle transition in the
  child re-renders Dashboard for no consumer).
- The two waived real-hardware checks (physical phone Week, real VoiceOver/NVDA) if a later
  a11y pass wants them; append results to `slice-10-11-acceptance.md`.
- If `calendar_range_too_dense` ever appears in prod logs (or active projects approach ~400),
  revisit the range-scoped density fix per `slice-4-query-review.md`.
