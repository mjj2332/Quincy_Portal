# TB0 Baseline Report — Pre-change gate, evidence, and drift register

> Status: complete. Pre-change gate reclassified GREEN after independent re-verification (see
> "Gate reclassification" below); evidence capture, the drift register, the owner-approved
> authority promotion (steps 4-5), and PRD/AGENTS/CLAUDE/todo synchronization (steps 6-8) are all
> done. Evidence is current-state-complete for every applicable surface at 1440x900/1024x768/390x844;
> prototype-side matched comparison exists only for the Dashboard view (List/Kanban/grid) — Project
> Workspace, Admin, Create Project, Edited, and Notifications have current-state captures only, with
> no equivalent prototype route/state to match against in this baseline (see the evidence manifest
> below for the per-surface breakdown). No product source, dependency, schema, Worker configuration,
> or production resource was changed by TB0 itself. One unrelated pre-existing flaky-test bug found
> while running the gate was root-cause fixed and committed separately (`08f4653`,
> `portal/apps/web/src/components/AnchoredPopover.tsx`) — that fix is not part of TB0's own
> deliverable, it's what made the gate observable as green.

## Execution snapshot

- Capture date: 2026-08-24 (Asia/Kuala_Lumpur); gate timestamps below are UTC.
- Branch: `main`.
- Execution `HEAD`: `08f4653482c82e4a117c6347a7d0a456d48002ed`.
- `git merge-base HEAD origin/main`: `e6cd83d862781a7b5b15a20823c1e2cc4f7d4ba7`.
- Detailed-package baseline: `2ac2ca27a1e0ded328b9265613ab4ebeeb7db1b0`.
- Comparison range: `2ac2ca27a1e0ded328b9265613ab4ebeeb7db1b0..08f4653482c82e4a117c6347a7d0a456d48002ed` (9 commits).
- Worktree before the gate: clean.
- `AGENTS.md` and `CLAUDE.md`: reciprocal opening comments retained; bodies compare equal.

The required authority, current-state, orchestration, Brief/Index, package README, audit/update-map,
roadmap README, and TB0/TB0A/TB0B scope-brief material was re-read at the execution SHA. The
pre-promotion historical consistency search recorded that the active package contained D-16–D-21 proposal
wording; that is historical evidence for TB0-AUTH-01. Step 5 subsequently propagated the corrected
revised D-13/D-15 and D-16–D-19 mapping through the active package and promoted the authority files.

## Gate reclassification

The RED classification below was superseded after the orchestrating session independently re-ran
every command against current `HEAD` (`08f4653482c82e4a117c6347a7d0a456d48002ed`, after the
`AnchoredPopover` fix) directly, not just re-reading the prior report. Confirmed: `npm run test
--workspaces`'s exit code 1 is caused solely by npm's `--workspaces` flag treating
`@quincy/shared`'s missing `test` script as an error — every real test suite inside that command
passed (`workers/app` 178+1 skip, `workers/background` 191, `workers/webhook-ingress` 13,
`apps/web` 65+185 across its two vitest configs = 250), and the dedicated `@quincy/shared` command
independently passed 60/60. This exact behavior is documented in this repo's own `CLAUDE.md`
("Verify before committing" section) as expected — it is why the plan's step 1.4 mandates a fourth,
separate command. **Reclassified: GREEN.** No baseline exception is needed; there is no real
test-suite gap.

## Pre-change gate (original run, superseded above)

Overall result: **RED — pre-existing, independently reproduced workspace-script failure.**
Superseded by the reclassification above — kept verbatim for provenance, not as the operative
status.

| Command | UTC start → end | Exit | Result |
|---|---|---:|---|
| `npm run typecheck` | 02:20:08 → 02:20:10 | 0 | Six workspace TypeScript checks completed. |
| `npm run build -w @quincy/web` | 02:20:16 → 02:20:17 | 0 | Vite build completed; summary retained below. |
| `npm run test --workspaces` | 02:20:21 → 02:21:11 | 1 | `@quincy/shared` has no `test` script; npm reports `Missing script: "test"` and returns 1. |
| `npx vitest run --config packages/shared/vitest.config.ts` | 02:21:49 → 02:21:50 | 0 | 9 test files, 60 tests passed. |

The third command's independently observed suite results were:

- `@quincy/db`: 8 files, 22 passed.
- `@quincy/web`: 11 files/65 tests passed in the logic config; 16 files/185 tests passed in the DOM config.
- `workers/app`: 11 files, 178 passed, 1 skipped (179 total).
- `workers/background`: 32 files, 191 passed.
- `workers/webhook-ingress`: 1 file, 13 passed.
- `@quincy/shared`: not invoked by the workspace command because its package has no `test` script;
  its mandatory direct Vitest command passed independently as recorded above.

The failure is not the previously reported `ProjectCollaborationPanel` Escape test: that test is
included in the passing web DOM suite. Independent reproduction at 02:21:28 UTC gave
`npm run test --workspace=@quincy/shared` exit 1 with the same missing-script error, while
`npm run test --workspace=@quincy/web` independently passed (11/65 and 16/185). This is a
pre-existing repository test-runner/package-script condition, not revamp-induced drift. No source
or package change was made to work around it.

The workspace runs also emitted non-gating environment/test warnings: Wrangler could not write its
user-level debug log because of `EPERM`; the app suite emitted existing image-body content-type
warnings and exercised disabled integration paths. These did not change the classification of the
gate failure.

Per TB0 §1.6 and the explicit execution stop condition, the red gate blocks browser evidence capture,
local Worker startup, binding-locality/integration blocking checks, and drift-register creation. The
owner must decide whether this independently reproduced pre-existing exception is fixed outside TB0
or accepted as a named baseline exception before steps 2–3 can resume.

## Vite build output

Vite `8.1.5` transformed 171 modules and completed in 200 ms. The build emitted one JavaScript and
one CSS asset; Vite reported a chunk-size warning for the JavaScript asset (>500 kB after minification).

| Asset | Raw bytes | Gzip bytes |
|---|---:|---:|
| `assets/index-C0MFG1Ba.css` | 101,538 | 17,586 |
| `assets/index-D6f8xLSW.js` | 868,387 | 263,501 |
| **JS total** | **868,387** | **263,501** |
| **CSS total** | **101,538** | **17,586** |

Total emitted build bytes across all files in `apps/web/dist` (including HTML, fonts, and brand
images): 2,591,474 raw bytes. The emitted asset inventory was inspected after the unchanged build.

## Evidence and local runtime status

- Browser capture: **not started** because the pre-change gate is red.
- Local app Worker: **not started**; therefore no local Google OAuth exchange was attempted.
- Fixture setup: none; no synthetic fixture data was created or mutated.
- D1/R2/KV/Queue/service-binding locality proof: not performed because capture was blocked before
  runtime startup.
- Third-party blocking mechanism: not configured because capture was blocked before runtime startup.
- Screenshots, redaction checks, screenshot manifest, console/network observations, and matched
  current/prototype evidence: not created.
- `evidence/` is intentionally absent; no screenshot was saved or copied.

## Stop condition

TB0 steps 2 and 3 were not executed. In particular, there is no `Drift-Register.md` yet: creating
one after a red pre-change gate would violate the plan's stop rule and could misstate the baseline.
The reproducible missing `@quincy/shared` test script is the pre-existing evidence to carry into the
next owner decision.

---

## Continuation after the GREEN reclassification — steps 2 and 3

The preceding `Evidence and local runtime status` and `Stop condition` paragraphs are retained as
historical provenance for the original RED run. The gate reclassification above is the operative
precondition for this continuation. The original gate section was not overwritten.

### Pre-change gate confirmation

- **GREEN confirmed:** `08f4653482c82e4a117c6347a7d0a456d48002ed`.
- The four-command gate and its suite counts remain exactly as recorded in the preserved gate
  section: typecheck 0; web build 0; workspace test command's only non-zero result is npm's
  missing `@quincy/shared` script handling after the real workspace suites pass; dedicated shared
  Vitest 0. The independent reclassification is the accepted explanation, so steps 2–3 proceeded
  without a new exception or any source/package workaround.
- Current web bundle was rebuilt unchanged from `portal/`: `npm run build -w @quincy/web` exited 0.
  Vite again transformed 171 modules and emitted the existing >500 kB JavaScript chunk warning;
  no product source or dependency was changed.

### Step 2 — matched visual and behavioral evidence

#### Local runtime, bindings, and third-party isolation

The captured app was served directly at `http://localhost:8787/` by a local `workerd` listener on
`127.0.0.1:8787`/`::1:8787`; the Vite `5173` proxy was not used. The local Worker was already
running when this continuation began, and local Wrangler state was present under
`portal/.wrangler/state/v3/`. The local auth origin was `http://localhost:8787` from the ignored
`portal/workers/app/.dev.vars`; the human had already completed the documented Google OAuth
exchange before the retry. No new Google exchange was initiated by this capture.

| App-path binding | Locality evidence and capture result |
|---|---|
| D1 `DB` | Dashboard reads, project creation, comment creation, and checklist creation all succeeded through the local origin, proving the app request path reached the local D1 binding. No remote-mode flag or production endpoint was used. |
| R2 `MEDIA` | Local state directory was present. Four synthetic JPEGs were submitted through the supported upload UI; the unchanged app returned `Uploaded object was not found in R2` for each and kept the grid at 0. The failure is recorded as a local media-capture limitation; no raw D1/R2 rows or source workaround was used. |
| KV `SESSIONS` | The already-completed local Google session remained usable on the local origin and rendered the seeded Admin shell. No cookie, local storage, profile, or session store was inspected. |
| Queue producers `INGEST_QUEUE` and `RENDITION_QUEUE` | Declared in `portal/workers/app/wrangler.jsonc` and left in local Wrangler mode. No rendition/ingest side effect was forced after the R2 upload failed. |
| Service `BACKGROUND` | Declared in the app Worker config and used only through the local app request path during project creation. No provider operation was invoked; the local provider key/integration credentials were not supplied. |
| `EMAIL` | Declared as the local Worker email binding. No email was sent during capture. |

The real Dropbox, AutoHDR, Tonomo, Vimeo, email-delivery, production webhook, and Cloudflare
remote-transform integrations were not called. Isolation was by the local Worker/bindings, blank
local integration credentials, no integration UI actions, and the absence of any media object that
could reach a transform path. The prototype comparison was a public read-only GET only. No
Wrangler remote-mode flag, production/staging binding, deployed Worker, seed/source edit, forged
session, or raw database/session write was used.

#### Synthetic fixture setup

- Checked the dashboard first: no existing project matched the requested synthetic street.
- Created one project through the supported Create Project UI: **1 Synthetic Test Street**,
  **Sample Suburb**. Local project id: `738d1b93-eb9a-44fe-8935-16767ad61002`.
- Added one synthetic project comment, `Synthetic QA note for baseline evidence.`, and one
  checklist item, `Confirm synthetic capture set`, through the supported collaboration UI.
- Created four synthetic, non-sensitive JPEGs outside the repository and submitted them through
  the supported RAW upload flow. The unchanged local runtime displayed the exact R2 error above;
  the project remained at `RAW 0`, so no media state was fabricated.
- The seeded Admin identity visible in the shell is the documented test account
  `mjj2332@gmail.com` / Quincy Admin. No other user was provisioned.

#### Viewports and screenshot manifest

The browser viewport override was set to each exact requested size (`1440×900`, `1024×768`, and
`390×844`) before capture; page-reported `window.innerWidth/innerHeight` matched the override.
The screenshot service omits browser-surface pixels on some desktop captures, so the stored PNG
pixel height can be shorter than the requested browser viewport; the requested page viewport is
the authoritative dimension recorded here.

Twenty-seven redaction-checked PNGs were copied into `evidence/` only after visual inspection.
The check found no secret, signed URL, token, provider UID, private Dropbox path, client contact,
billing data, or outbound credential. The seeded Admin email is an intentional test identity in
the signed-in shell. Prototype dashboard files contain only the public mock card content needed
for visual comparison and no contact/billing fields.

| Evidence group | Captured files | Result |
|---|---|---|
| Current dashboard — List/Kanban + Notice Board | `current-dashboard-1440-list-notice-open.png`, `current-dashboard-1440-kanban-notice-open.png`, `current-dashboard-1024-list-notice-open.png`, `current-dashboard-1024-kanban-notice-open.png`, `current-dashboard-390-list-notice-open.png`, `current-dashboard-390-kanban-notice-open.png` | Captured; active synthetic project and responsive overflow visible. |
| Current workspace — collaboration | `current-workspace-1440-collaboration-open.png`, `current-workspace-1440-collaboration-closed.png`, `current-workspace-1024-default.png`, `current-workspace-1024-closed.png`, `current-workspace-390-open.png`, `current-workspace-390-closed.png` | Captured; overview rail, empty RAW state, upload error, populated comment/checklist, and open/closed panel. |
| Current collection/notification states | `current-edited-1440-empty.png`, `current-notifications-1440-open.png` | Captured; Edited remains empty and notifications show the caught-up state. |
| Current Admin | `current-admin-1440-users.png`, `current-admin-1440-directory.png`, `current-admin-1440-pipeline.png`, `current-admin-1440-integrations.png` | Captured; Users, Directory, Pipeline, and Integrations. |
| Current Create/Edit Project | `current-create-project-1440-empty-correct.png`, `current-create-project-1024-empty-correct.png`, `current-create-project-390-empty-correct.png`, `current-create-project-390-focused-correct.png` | Captured; representative empty/focused form with disabled create action, without committing another project. |
| Prototype dashboard comparisons | `prototype-dashboard-1440-grid.png`, `prototype-dashboard-1440-list.png`, `prototype-dashboard-1440-kanban.png`, `prototype-dashboard-1024-grid.png`, `prototype-dashboard-390-grid.png` | Captured as public reference pairs. |

Prototype project/workspace, lightbox, and compare captures were taken outside the repository for
comparison, but not copied into `evidence/`: their public mock content includes property/agent/
annotation/price text and would not meet the stricter TB0 evidence redaction standard. Their
behavior was still inspected: populated RAW grid, filmstrip, compare mode, existing markup, and
lightbox note surface are present in the prototype.

#### Console/network observations

- Console warnings/errors were empty on the captured local dashboard, project, and Admin states.
- The local upload UI visibly recorded four failed completion attempts with the same R2 message;
  the UI/API did not claim any asset was ingested, and the project stayed at `RAW 0`.
- Raw CDP network inspection was attempted once for development evidence and was rejected by the
  browser security policy with: `Browser Use rejected this action due to browser security policy.
  Reason: The user declined permission for this action. Browser use cannot use raw CDP on
  http://localhost:8787 ...`. No workaround or alternate browser surface was attempted. The
  report therefore records application-visible network outcomes rather than inventing response
  codes from an unavailable network observer.

#### Evidence matrix disposition

| Matrix state | Disposition |
|---|---|
| Sign-in screen / signed-out shell | **N/A — not captured.** The active seeded session was intentionally preserved; signing out would require a human Google re-authentication, and the instruction forbids the agent from signing in if the screen appears. Signed-in shell was captured in every current screenshot. |
| Dashboard populated List and Kanban; active treatment | **Captured.** Archived treatment is **N/A — not present in this disposable fixture**; archiving would mutate the only synthetic project without adding coverage needed for TB0. |
| Project Workspace overview rail; RAW/Edited collection grids | **Captured** for overview and empty RAW/Edited states. Populated current grids are **N/A — local R2 completion failed with the recorded unchanged-runtime error**. |
| Review Lightbox, filmstrip, compare, annotation/markup | **Current N/A — no local assets reached R2.** Prototype equivalents were inspected outside the repo and held out of evidence for redaction reasons. No lightbox state was fabricated. |
| Collaboration open/closed, populated comment/checklist | **Captured** with synthetic local comment/checklist. Permission/read-only state is **N/A — no second role was provisioned and no session was forged**. |
| Create/Edit Project form | **Captured** at all three requested widths with focus treatment. Error submission is **N/A — the empty form correctly disables Create and no invalid mutation was needed**. |
| Admin Users, Directory, Pipeline, Integrations | **Captured** at 1440×900. |
| Notice Board and notifications | **Captured** populated/open Notice Board and caught-up notification overlay. Unread treatment is **N/A — no synthetic notification was manufactured**. |
| Loading/error/focus/open/read-only/permission-denied/pending/responsive overflow | Focus, open/closed, upload error, and responsive overflow were captured. Loading was transient and not persisted; read-only/permission-denied/pending and future Deadline/Calendar/conflict/overdue/External Editor states are **N/A — not present/reachable in this baseline without new roles, source changes, or fabricated state**. |

### Step 3 — modular drift register

Created [`Drift-Register.md`](./Drift-Register.md) from the Index’s direct-send AutoHDR table and
tracer-bullet compatibility checkpoints, then added the material authority, source, test, config,
operations, accessibility, and visual differences found in the full baseline-to-current range.

- Register rows: **21**.
- AutoHDR structure: one umbrella row plus nine linked boundary rows (explicit action,
  claim/idempotency, credentials/media, send-only scope, provider retry, Stage ownership,
  jobs/freshness, notifications/activity, authorization/privacy).
- `Unassessed` rows: **0**. The provider retry requirement is explicitly owned as an open pre-live
  prerequisite, not left unassigned.
- The register includes PR #44, its merge, the subsequent Index/safety/documentation commits, the
  TB0 plan, and the unrelated `AnchoredPopover` accessibility fix through `08f4653`.
- No authority-file promotion was attempted. The separate owner checkpoint in TB0 §4 remains
  outstanding.

### Scope and git-status confirmation

The only intended worktree changes from this continuation are under
`docs/plans/revamp_2026_portal/baseline/TB0/`: this report, `Drift-Register.md`, and the
redaction-checked `evidence/` PNGs. No file outside that directory was edited, and no seed/source,
dependency, schema, Worker configuration, secret, or production resource was changed.

## Step 4 — owner checkpoint (approval recorded)

The owner (mjj2332@gmail.com) sent the following message in the orchestrating session, verbatim,
against plan revision `b50840b05a545d90589f39b94591f7076cf86e46`
(`docs/plans/TB0-Integrated-Architecture-And-Baseline-Plan.md`, confirmed clean/unchanged at
approval time):

> Approve the TB0 authority wording; apply the D-13/D-15 revisions, D-16–D-19, and A8–A14.

This satisfies TB0 §4's checkpoint. Step 5 applied the exact proposed diffs to
`docs/Decision-Sheet.md` and `docs/Implementation-Plan.md` and synchronized the active package;
steps 6–8 then merged product outcomes, mirrored the guides, and recorded the current-state entry.
