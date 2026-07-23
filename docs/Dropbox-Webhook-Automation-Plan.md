# Dropbox Webhook Automation Plan — RAW and AutoHDR Finals

**Status:** Proposed implementation plan — hardened after independent architecture review
**Scope:** Event-driven Dropbox intake and its stage transitions. This plan retires the legacy calendar-based `reconcileAwaitingRawProjects` scheduled handler and its hourly cron: `awaiting_raw → raw_review` occurs only after qualifying RAW media is durably available.

## Context

Quincy Portal already receives verified, account-level Dropbox webhook notifications at `/webhooks/dropbox`. A webhook says that the connected Dropbox account changed; it does not contain the file-change list. The Background Worker’s `DropboxSyncDO` must use Dropbox’s cursor-based delta API to determine actual changed paths.

Today, one Durable Object tracks the Dropbox account root, matches changed paths to stored project `rawFolderPath` values, and triggers RAW reconciliation. AutoHDR final-photo retrieval remains a manually initiated workflow. The current monitor has an account-root cursor; that cursor cannot be continued from a root-scoped monitor.

This plan converts the event path into two independent root-scoped intake flows:

1. **RAW capture reconciliation** for configured project folders beneath `/Tonomo/Raw Files`.
2. **AutoHDR final-photo reconciliation** for a project handoff’s persisted, exact final-output folder beneath `/AutoHDR`.

The Dropbox webhook remains account-level. Strict path identity and root-scoped Dropbox cursors determine whether a notification affects either supported flow.

## Confirmed behavior and safety contracts

- Quincy Portal continues to use its existing single canonical studio Dropbox connection. The root monitors belong to that connection; this work does not add per-project or multi-account routing.
- RAW automation considers only paths under `/Tonomo/Raw Files` and identifies a project only through its stored `projects.rawFolderPath`.
- AutoHDR automation considers only a connection-bound, handoff-owned final-output mapping. A known handoff preclaims its two supported final-folder candidates; a Dropbox delta below exactly one candidate promotes it to the observed exact mapping. Automation never infers a project from an arbitrary Dropbox folder name and never creates a project from Dropbox alone.
- The current provider integration supports both `04-FINAL-Photos` and `04-FINALS-Photos`. A handoff may preclaim only these connection-bound candidates; if both candidates appear, or a permanent path claim collides, the mapping enters staff-visible blocked state and automation chooses neither.
- An active AutoHDR handoff owns a frozen final-output mapping and immutable handoff manifest. A later RAW-folder correction cannot silently redirect a still-running handoff to a different Dropbox folder, and changing live selections cannot redefine that handoff’s readiness units.
- Final-output folder claims are retained after project archive. A path can be reassigned only through an explicit, audited staff operation that verifies the new handoff’s ownership; automation never silently reuses an archived project’s folder.
- There is no fallback that syncs every project.
- Manual RAW sync remains unrestricted: it can use either RAW Folder Path or RAW Folder Link. A successful link-based sync persists the canonical RAW Folder Path for later automatic matching.
- Manual AutoHDR fetch preserves its legacy candidate fallback during migration; it may discover and persist a mapping, but does not auto-route an unobserved candidate.
- Dropbox deletions are non-destructive. Automation neither deletes R2 media nor existing portal assets. Listing requests use `include_deleted: false`, and routing defensively ignores any deleted entry supplied by a degraded or synthetic test source.
- All automatic imports are system-initiated and audit-log their trigger metadata with no human actor.
- If AutoHDR replaces a final at the same Dropbox source path with a different content hash, Quincy Portal creates one new immutable edited-asset version, preserves the old R2 object, marks the prior version superseded, and exposes only the current version by default.
- Trigger-time eligibility is not sufficient. Writers must recheck archive state, expected pipeline stage, mapping generation, path identity, and connection immediately before durable metadata changes.
- Automatic stage changes are guarded, monotonic only from their expected predecessor, and paired with exactly one system/human-attributed audit record in the same D1 transaction. They never undo a later staff stage decision.

## Target architecture

```text
Dropbox account change
        |
        v
/webhooks/dropbox
  - validate HMAC signature
  - persist receipt / re-wake on duplicate
  - wake both root-specific monitors
        |
        +-------------------------------------------+
        |                                           |
        v                                           v
DropboxSyncDO: <connection>:raw       DropboxSyncDO: <connection>:autohdr
root: /Tonomo/Raw Files                root: /AutoHDR
cursor/alarm/dirty generation          cursor/alarm/dirty generation
        |                                           |
        v                                           v
match configured rawFolderPath         match frozen exact output mapping
        |                                           |
        v                                           v
claimed RAW reconciliation             claimed AutoHDR fetch workflow
        |                                           |
        v                                           v
RAW assets / Raw Review                current edited versions / Edited Review
```

Each named monitor has isolated Durable Object storage, cursor, alarm, dirty generation, and scope-level health. Large or failed RAW work must not delay AutoHDR detection, and vice versa. The existing account-root monitor stops receiving webhook wakes; its account-root cursor is intentionally abandoned rather than reused.

## Implementation plan

### 0. Establish deployment and migration truth before schema work

**Primary files and systems**

- `docs/todo.md`
- `portal/packages/db/migrations/meta/_journal.json`
- `portal/packages/db/migrations/`
- Production and staging D1 migration ledger and `sqlite_master`

1. Treat the current remote migration state as unverified until reconciled. Repository documentation currently records an irregular history: the local journal has migrations beyond the broadly reported production baseline, while at least one later schema change was applied directly.
2. Before generating a new migration, run a read-only production and staging preflight that records:
   - the D1 migration ledger;
   - actual tables, indexes, and SQL from `sqlite_master`;
   - existing duplicate RAW identities, duplicate AutoHDR path claims, and legacy edited assets without `source_path`.
3. Reconcile the remote DDL and migration ledger with the checked-in Drizzle journal. Document the repaired baseline in `docs/todo.md` before attempting this feature’s migration.
4. Author schema changes in `portal/packages/db/src/schema.ts`, then generate the migration with Drizzle so the SQL and journal remain consistent. Do not hand-author an untracked migration file.
5. Prove the complete chain on a fresh database and on a production-like snapshot before applying it remotely.
6. Use **expand → backfill → validate → constrain → enable**. Nullable additive schema lands first; uniqueness constraints and automated writers are enabled only after collision and legacy remediation reports are clean.
7. Before remote schema work, create the studio’s approved D1 recovery point (Time Travel bookmark/export or equivalent documented backup). Rollback after data-writing activation is a forward-fix/automation-disable operation, not an assumed down migration.

### 1. Add shared Dropbox path, identity, and monitor contracts

**Primary files**

- `portal/workers/background/src/dropbox/delta.ts`
- New focused Dropbox path/routing module under `portal/workers/background/src/dropbox/`
- `portal/workers/background/src/autohdr/paths.ts`
- `portal/workers/background/src/do/dropbox-sync.ts`

1. Define fixed normalized roots:
   - `TONOMO_RAW_ROOT = "/Tonomo/Raw Files"`
   - `AUTOHDR_ROOT = "/AutoHDR"`
2. Move or reuse existing `normalisePath()` semantics through one neutral Dropbox-path module so RAW, AutoHDR, delta routing, persisted mapping keys, and legacy local-mount cleanup share exactly one implementation.
3. Define boundary-safe containment and equality checks. `/Tonomo/Raw Files/A` is eligible; `/Tonomo/Raw Files 2/A` is not.
4. Define a validated monitor identity contract:

   ```ts
   type DropboxMonitorScope = "raw" | "autohdr";

   type DropboxMonitorIdentity = {
     connectionId: string; // bare integration_connections.id
     scope: DropboxMonitorScope;
     watchedRoot: "/Tonomo/Raw Files" | "/AutoHDR";
   };
   ```

   Parse the named DO form `<connectionId>:<scope>` once, reject malformed/unknown/legacy names safely, and derive the root exclusively from the validated scope. Never pass the composite DO name to D1, credentials, Dropbox APIs, jobs, or Workflows.
5. Keep watched roots explicit at matching and listing call sites so an account-wide fallback cannot be introduced accidentally.
6. Keep `include_deleted: false` explicit and reject deleted entries defensively before routing.
7. Preserve `deriveAutoHdrFolderName(normalisePath(rawFolderPath))`, including its terminal `Listing Images` parent-folder rule. No second folder-name derivation is permitted.

### 2. Persist connection-bound, handoff-owned AutoHDR output mappings

**Primary files**

- `portal/packages/db/src/schema.ts`
- Generated D1 migration under `portal/packages/db/migrations/`
- `portal/workers/background/src/autohdr/paths.ts`
- `portal/workers/background/src/workflows/autohdr.ts`
- `portal/workers/background/src/workflows/autohdr-fetch.ts`
- `portal/workers/background/src/dropbox/sync.ts`
- Project RAW-path update paths

1. Add a dedicated output-mapping/claim model rather than relying only on mutable project RAW fields. Each mapping records at least:
   - project ID and canonical Dropbox connection ID;
   - display final path plus normalized `path_lower`-style comparison key;
   - optional observed Dropbox folder ID when available;
   - mapping generation and handoff/job ownership;
   - mapping state (`pending_discovery`, `active`, `blocked_collision`, `retired` or equivalent), timestamps, and actionable diagnostic state.
2. Add a durable AutoHDR handoff manifest/claim model. It freezes the selected asset IDs, selection hash, bracket/readiness units, initiating staff ID, connection, mapping generation, expected origin stage, and job/workflow owner. It is the only readiness source for that handoff; live `selections` remain editable but cannot alter an active handoff.
3. A mapping is created for a known AutoHDR handoff. Its candidate paths are frozen while that handoff is active. Do not refresh an active mapping merely because Tonomo, staff, or RAW sync changes `rawFolderPath`.
4. Use the existing folder derivation only to form candidates. At handoff creation, preclaim both supported final candidates for that connection-bound handoff:

   ```text
   /AutoHDR/<derived-folder>/04-FINAL-Photos
   /AutoHDR/<derived-folder>/04-FINALS-Photos
   ```

   A delta beneath exactly one pending candidate atomically promotes it to the observed exact mapping. A delta beneath both candidates, or any permanent claim collision, blocks automation for staff resolution. This is handoff-bound candidate promotion, not arbitrary folder-name inference.
5. Enforce a permanent connection-scoped claim for a normalized final-output key. Do not use an active-project-only unique index that releases a folder on archive. Preserve a tombstone/retired claim after archive.
6. Collision or existing-path reuse blocks automatic routing for all affected mappings and creates staff-visible remediation state; the system never picks a winner silently.
7. Reassignment requires a deliberate audited staff action plus verification that the folder/folder ID belongs to the new handoff.
8. Backfill safely:
   - derive candidates only from valid stored canonical RAW paths using the shared helper;
   - do not map raw links or malformed paths automatically;
   - report collisions and legacy ambiguity instead of guessing;
   - reconcile legacy AutoHDR imports that lack `source_path` before treating them as new source-keyed versions.
9. Preserve manual legacy fetching while mappings are incomplete. A successful manual discovery may persist/promote the exact mapping under the same collision rules.

### 3. Use independent root-scoped Dropbox monitors without losing signals

**Primary files**

- `portal/workers/background/src/do/dropbox-sync.ts`
- `portal/workers/background/src/index.ts`
- `portal/workers/background/src/dropbox/webhook.ts`
- `portal/workers/background/src/dropbox/client.ts`
- `portal/workers/background/src/dropbox/delta.ts`
- `portal/workers/background/src/do/tonomo-processor.ts` as the pending-drain reference

1. Keep the existing `DropboxSyncDO` class but create two named instances for the existing canonical studio connection:
   - `${connectionId}:raw` monitors `/Tonomo/Raw Files`.
   - `${connectionId}:autohdr` monitors `/AutoHDR`.
2. `handleDropboxWebhook()` resolves the same canonical connection convention currently used by the system and wakes both validated monitor names via the existing all-settled fan-out. Failure to wake one must not prevent the other from receiving the signal; an aggregate failure remains retryable by ingress.
3. Pass the decoded bare connection ID to every Dropbox client, connection health, job, audit, and Workflow operation. Workflow inputs always include their originating connection ID.
4. Each object uses its own normal `cursor` key and Durable Object alarm because state is object-local. Do not read, migrate, or continue the current connection-named account-root cursor.
5. First run and cursor reset call recursive `listFolder()` at that monitor’s fixed root, never `""`:
   - RAW: `/Tonomo/Raw Files`
   - AutoHDR: `/AutoHDR`
6. Continue only with the cursor created by that same monitor/root and same Dropbox connection.
7. Add a durable dirty/kick generation marker. `kick()` increments it and schedules an alarm. The drain records the generation at start and may clear its alarm only if no newer kick arrived before cursor persistence and drain completion. This preserves a webhook signal received during long project work.
8. Preserve page safety: affected work succeeds before cursor commit; failure leaves the cursor retryable. Bound project work per alarm/page or durably hand off claimed work so a large delta page cannot monopolize a monitor indefinitely.
9. Treat first root listings as baseline reconciliation only after RAW reconciliation and final-import ownership have their required idempotency/claim guarantees. Never label a baseline safe solely because it is a fresh cursor.
10. Store and expose per-monitor health: scope, root, last successful page, last error, cursor age/fingerprint, reset count, scan/match/skip counts, routed project count, and duration. Derive aggregate connection health from scope-level state so RAW success cannot mask AutoHDR failure.
11. Serialize or optimistically fence connection-token refresh so two root monitors cannot race refresh persistence.
12. No new Durable Object class migration is required merely for new named instances of the existing class.

### 4. Restrict and make RAW reconciliation baseline-safe

**Primary files**

- `portal/workers/background/src/dropbox/delta.ts`
- `portal/workers/background/src/do/dropbox-sync.ts`
- `portal/workers/background/src/dropbox/sync.ts`
- `portal/workers/app/src/lib/ingest.ts`
- Shared guarded stage-transition helper
- `portal/packages/db/src/schema.ts`

1. Refactor `changedProjectIds()` or add a pure RAW matcher that accepts changed entries, configured paths, normalizer, and explicit Tonomo root.
2. Match only non-archived projects that have a non-empty stored `rawFolderPath`, whose configured path is inside `/Tonomo/Raw Files`, and whose changed path equals or is beneath that configured path.
3. Preserve case-insensitive matching and per-page ID de-duplication. Skip link-only, unconfigured, out-of-root, unmatched, deleted, and newly created Dropbox folders until a canonical RAW path is stored.
4. Reuse `syncProjectRawFolder()` for manual behavior and the direct-upload finalizer for manual intake, but harden automatic and baseline work before enabling it:
   - deduplicate existing RAW rows;
   - define and enforce RAW content/source identity uniqueness appropriate to the collection;
   - use an atomic per-project reconciliation claim when manual sync, queue retry, and webhook baseline can overlap;
   - make R2 writes deterministic or recoverable around ownership/metadata failure;
   - return durable RAW evidence (`newlyImported` and `currentRawAvailable`) from every intake path;
   - recheck terminal/archive eligibility at the durable writer, not only before a long listing.
5. After an intake has durable qualifying RAW evidence, conditionally advance only an active project from `awaiting_raw → raw_review`. Webhook receipt, path detection, an empty/invalid scan, a failed import, and a purely no-op duplicate sync do not qualify. A retry may repair a stale `awaiting_raw` stage when a durable current RAW already exists.
6. In the same D1 transaction, perform the predecessor- and archive-guarded update and insert exactly one system `stage.auto_advance` audit only when the update changes a row. Store trigger (`dropbox_delta`, manual Dropbox sync, or direct upload), reconciliation/job context, and durable RAW evidence. If staff already moved the project, or it was archived, lose safely without a stage regression.
7. Retire `reconcileAwaitingRawProjects()`, `scheduled()`, its cron trigger, and their date-based tests after equivalent durable-intake and race coverage exists. Preserve the historical deployment record in `docs/todo.md`, marked superseded rather than deleted.
8. Preserve the 150-download continuation limit, hash/path reconciliation, canonical RAW-path persistence, immutable R2 preservation, and archived-project protections while closing the concurrent baseline gap.

### 5. Claim, start, and fence AutoHDR handoffs and final fetches atomically

**Primary files**

- `portal/workers/background/src/workflows/autohdr-fetch.ts`
- `portal/workers/background/src/workflows/autohdr.ts`
- `portal/workers/background/src/do/dropbox-sync.ts`
- `portal/workers/background/src/index.ts`
- `portal/workers/background/src/lib/jobs.ts`
- `portal/packages/db/src/schema.ts`

1. Extract reusable final-folder listing/import/reconciliation logic from `AutoHdrFetch` into an internal service with trigger context: `manual` or `dropbox_delta`.
2. Keep Cloudflare Workflow as durable orchestration, retries, job lifecycle, and the single authority for automatic stage commits; do not import finals inline in the Durable Object.
3. Replace the current read-then-create active-job lookup with an atomic D1-backed active fetch claim/lease per project and mapping generation. A partial unique index or dedicated claim table is acceptable if it supports insert-or-return-owner semantics.
4. Add recoverable lifecycle states for each claim. A claim written before Workflow creation must not strand an indefinitely queued job: record/confirm the Workflow start, expire or restart orphaned `starting` claims, and make repeated requests reuse or safely recover the owner.
5. Use a deterministic Workflow ID as a secondary collision fence, not as the only source of ownership. Handle database uniqueness conflicts and Workflow “already exists” outcomes as successful reuse after verifying ownership.
6. Use the same ownership pattern for AutoHDR send. A Send to AutoHDR request must:
   - validate the project is non-archived and exactly `raw_review`, its target stage is machine-eligible, and it has a valid frozen selection, unique filenames, canonical connection, and mappable output candidates;
   - atomically create or return one `starting` handoff claim and frozen manifest, including the initiating staff ID;
   - create/reuse the deterministic send Workflow;
   - atomically confirm the handoff as started, advance `raw_review → editing_autohdr`, and write exactly one attributed stage audit; and
   - permit the owner Workflow to repair an interrupted confirmation idempotently.

   Failed validation or unrecoverable Workflow-start failure leaves the project in `raw_review`. Repeated clicks return the owner. A delayed retry must never move a later staff-selected stage backward to Editing.
7. Route an AutoHDR delta only when it is beneath a non-blocked mapping’s observed exact key, or exactly one eligible pending candidate that can be atomically promoted; it must use the same canonical Dropbox connection and be eligible for automatic fetch.
8. Workflow input and job/audit payload include: connection ID, project ID, mapping generation, exact display/key path, frozen handoff ID/manifest version, trigger, representative changed path, monitor scope/root, job ID, and initiating actor where applicable.
9. At the final metadata writer, separate import eligibility from stage-transition eligibility:

   ```text
   import eligibility:
     archived_at IS NULL
     mapping generation/path/connection and frozen handoff equal workflow input
     stage_key IN (editing_autohdr, edited_review)

   first-final transition eligibility:
     stage_key = editing_autohdr
     a newly imported current final has credible frozen-handoff coverage
   ```

   An archived, retired, mismatched, delivered, or otherwise unrelated project is an auditable safe skip/quarantine and must not receive new portal metadata. A project already in `edited_review` may import an audited new/replacement current version for the same handoff, but does not transition or regress stage; that version begins unreviewed. R2 writes before a lost guard must remain deterministic/recoverable.
10. Preserve final-import behavior: never create AutoHDR’s final folder; a missing final folder is “not ready”; retain unmatched finals; pair RAW by exact basename then `_vs` / `_staged`; enqueue renditions; and use immutable handoff readiness units, not live selections.
11. On the first successfully committed **current** final with credible handoff coverage, atomically advance `editing_autohdr → edited_review` and write one system `stage.auto_advance` audit. `edited_review` means review can begin; it does not mean every requested edit has returned. Receipt, path detection, missing folders, failed imports, same-path/same-hash no-ops, superseded-only work, and unmatched/no-coverage finals never advance the stage.
12. Retain full handoff coverage as a visible QA/readiness diagnostic rather than a stage gate. Each ungrouped selected RAW is one immutable readiness unit; selected RAWs in a frozen bracket group may be one unit. Unmatched finals cover no unit. Add a many-to-one edited-source/handoff-association model or an equivalent explicit manual-resolution path so one merged bracket final can cover its unit.

### 6. Version replaced AutoHDR finals immutably and make current state queryable

**Primary files**

- `portal/packages/db/src/schema.ts`
- Generated D1 migration under `portal/packages/db/migrations/`
- `portal/workers/background/src/workflows/autohdr-fetch.ts`
- `portal/packages/db/src/collection-count.ts`
- Edited-asset readers in `portal/workers/app/src/routes/review.ts`, `collections.ts`, and future publish/delivery paths

1. Persist both a display `sourcePath` and normalized `sourcePathKey` for every Dropbox AutoHDR final. Require a usable Dropbox `contentHash`; explicitly quarantine/skip or define a trusted substitute if Dropbox cannot provide one.
2. Add explicit current/supersession state such as `supersededAt` and replacement linkage. Enforce exactly one current Dropbox-edited asset for `(collectionId, sourcePathKey)`.
3. Make final import replay-safe:
   - no current asset at a source key: reserve/create the first current version;
   - same source key and content hash: idempotent no-op/reconcile;
   - same key with new hash: conditionally supersede the old current row and create exactly one replacement;
   - on a lost race: reread current state and accept only same-key/same-hash as success.
4. Use deterministic/content-addressed R2 keys or durable asset reservations before external writing. R2 bytes and D1 version state must be recoverable across Workflow replay after either external-write or metadata-write fault points.
5. In one conditioned durable operation, update supersession state, create the new metadata row, preserve the valid RAW relation, update current counts and frozen-handoff readiness, and record system audit data. Keep prior immutable R2 objects and historical asset records.
6. A replacement imported while the same handoff is in `edited_review` becomes a new unreviewed current asset but does not change the project stage or inherit review/approval state. A delivered project is never silently switched to a replacement; it is quarantined/safely skipped pending an explicit audited staff operation.
7. Define a shared **current asset** predicate, normally `superseded_at IS NULL`. Use it for normal operational readers: review grids, current edited counts, frozen-handoff readiness, current approval/publish, future delivery/export, and client-facing resolution. Historical rows are opt-in staff audit/recovery only.
8. Do not apply the current-only predicate to destructive safety checks that intentionally count all evidence/history. Document each exception.
9. Reconcile legacy AutoHDR assets without source keys before auto-versioning. Quarantine ambiguous rows rather than treating all same-name legacy files as a single source identity.

### 7. Add focused automated coverage, including real Workers behavior

**Primary files**

- `portal/workers/background/test/dropbox-delta.test.ts`
- `portal/workers/background/test/autohdr-paths.test.ts`
- New root-monitor, claim, workflow, and versioning tests
- A `@cloudflare/vitest-pool-workers` background integration configuration
- `portal/workers/webhook-ingress/test/index.test.ts`

1. Test path contracts: configured project entries, JPEGs/folders/nested files, unmatched root entries, sibling-prefix paths, out-of-root paths, case normalization, `Listing Images`, de-duplication, link-only RAW skips, deleted-entry rejection, both final candidates, pending-candidate promotion, dual-candidate/collision blocking, and observed mapping matching.
2. Test monitor identity and cursor behavior: composite monitor names decode to the bare D1 connection ID; malformed/legacy names fail safely; initial/reset listings use fixed roots and never `""`; old account-root cursor is ignored; scopes continue/commit/retry/reset independently; a RAW failure does not prevent AutoHDR progress.
3. Test kick/alarm interleaving: a webhook arriving during a drain is preserved through cursor persistence and does not get erased by `deleteAlarm()`.
4. Test RAW stage commits: new qualifying RAW success, empty/invalid/no-op scans, failed R2 or metadata writes, duplicate retry repair, manual Dropbox sync, direct upload, archive/path/stage races, and exactly one audit. Verify the date-driven scheduled handler and cron have been removed.
5. Test atomic AutoHDR ownership with truly concurrent callers: duplicate webhook pages, manual fetch, and retry create one active fetch claim/workflow; an orphaned start is recovered; concurrent sends create one handoff/mapping; repeated clicks return the owner; validation/start failures leave `raw_review`; a manual-stage race cannot regress a later stage; exactly one transition audit exists.
6. Test final writer fencing and first-final semantics: archive, stage, mapping generation, final-path key, or connection changes between trigger and import produce an auditable no-op and no new metadata; first newly committed current covered final advances exactly once; receipt/detection/no-op/superseded-only/unmatched finals do not; partial returns remain visible in readiness but do not block Edited Review. Cover replay faults after R2 write and before/after D1 version commit.
7. Test versioning: same-path/same-hash idempotency; same-path/new-hash one-current replacement; same filename/different source paths; lost supersession race; legacy source-key ambiguity; old R2 retention; current counts, review lists, and readiness excluding superseded versions; post-Edited-Review replacements remain unreviewed without stage mutation; Delivered rejects/quarantines replacement; staff history explicitly includes historical versions.
8. Keep ingress coverage for HMAC validation, durable receipts, duplicate wake-ups, retryable handoff failures, and receipt timestamps. The existing ingress durability behavior is a foundation, not a redesign target.

### 8. Roll out safely and update operational documentation

**Documentation files**

- `docs/Dropbox-Setup.md`
- `docs/Implementation-Plan.md`
- `docs/todo.md`
- `docs/lessons.md` after production learning

1. Document account-level webhook wake-up versus cursor delta routing, the single canonical Dropbox connection convention, two monitor roots, mapping and frozen-handoff lifecycle, current-asset semantics, stage meaning, and system audit trigger fields.
2. Document that RAW automation requires a canonical RAW path; link-only projects require explicit sync first. Document that AutoHDR routing is handoff-bound: it may preclaim only the two supported candidates, promotes one only from a matching delta, and never infers a project from a folder name.
3. Document that `edited_review` means a first credible current returned edit is available for review, while frozen-handoff readiness remains a separate completion diagnostic. Document first-root baseline and reset behavior, non-destructive deletions, mapping collisions/reassignment, archived path tombstones, final-version retention, per-monitor health, and operator cursor inspection/reset.
4. Provide an authenticated operator procedure to inspect/reset one monitor scope without touching its sibling. Include cursor age, last error, root, scan/match counts, mapping/job diagnostics, handoff readiness, and blocked-candidate resolution.
5. Mark the date-driven Awaiting RAW cron in `docs/todo.md` as superseded historical behavior. Reconcile stale webhook-health wording: ingress persists receipts, duplicate deliveries re-wake processing, and handoff failure returns retryable non-2xx.
6. Use staged activation:
   1. D1 preflight and recovery point;
   2. nullable schema expansion;
   3. deploy current-aware readers and disabled/feature-flagged monitor/workflow writers in the required service order;
   4. backfill, legacy reconciliation, collision remediation, and validation;
   5. controlled isolated-Dropbox verification;
   6. remove the legacy cron only when durable RAW intake transition coverage is live;
   7. enable RAW then AutoHDR automation deliberately;
   8. monitor per-scope telemetry before broad use.
7. If rollback is needed after activation, disable automation and forward-fix. Do not deploy stale readers that expose historical versions as current, revive the incompatible account-root cursor, or reinstate the date-based stage transition.

## Verification

### Automated verification

From `portal/`, run the required repository gate:

```bash
npx tsc -p packages/shared/tsconfig.json
```

```bash
npx tsc -p packages/db/tsconfig.json
```

```bash
npx tsc -p apps/web/tsconfig.json
```

```bash
npx tsc -p workers/app/tsconfig.json
```

```bash
npx tsc -p workers/background/tsconfig.json
```

```bash
npx tsc -p workers/webhook-ingress/tsconfig.json
```

```bash
npx vitest run --config packages/shared/vitest.config.ts
```

```bash
npx vitest run --config workers/app/vitest.config.ts
```

Run the background unit and Workers-pool integration suites, the webhook-ingress suite, and then the web build required by `CLAUDE.md`.

```bash
npm run build -w @quincy/web
```

### Controlled Dropbox end-to-end verification

Use isolated test projects, a known canonical Dropbox connection, and disposable Dropbox folders:

1. Run migration preflight, take the documented D1 recovery point, apply nullable expansion, and confirm no mapping/version constraints activate before backfill validation.
2. Add qualifying files below a configured RAW path under `/Tonomo/Raw Files`; confirm one claimed matching RAW job, durable R2/D1 intake, one guarded `awaiting_raw → raw_review` system audit, and idempotent retries. Race it with manual sync and direct upload; confirm no duplicate assets/R2 writes and no stage regression. Confirm empty/invalid/no-op or failed intake remains Awaiting RAW.
3. Change paths outside the RAW root and under `/Tonomo/Raw Files 2`; confirm no automatic RAW job. Confirm link-only projects do not auto-match until explicit sync stores a canonical path.
4. Start an AutoHDR handoff from Raw Review; confirm one connection-bound frozen manifest plus two pending final-candidate claims, an attributable guarded `raw_review → editing_autohdr` audit, and duplicate-click owner reuse. Confirm validation/start failure leaves Raw Review, and changing RAW path or live selection afterward does not alter the active handoff.
5. Add a final beneath exactly one preclaimed candidate; confirm atomic promotion to the observed exact path. Confirm both candidates, `/AutoHDR-backup`, unconfigured folders, collision-blocked mappings, and archived-path reuse block automation or require staff resolution.
6. Confirm duplicate notifications, multi-page deltas, and manual fetch share one recoverable claimed final-fetch workflow. Simulate a start failure and confirm stale claim recovery.
7. Upload a first covered final into the observed folder; confirm durable import/association, renditions, system audit metadata, and one `editing_autohdr → edited_review` transition. Confirm unmatched, no-op, failed, or superseded-only results do not advance. Confirm partial frozen-handoff coverage remains visible as a QA diagnostic without blocking Edited Review.
8. Replace a final at the same Dropbox source path with different bytes while the handoff remains in Edited Review. Confirm exactly one new unreviewed current version, preserved old R2 bytes/history, no stage mutation, correct current-only gallery/count/readiness results, and explicit staff history access. Confirm Delivered/archived projects safely skip or quarantine replacements.
9. Archive or manually move a project to an unrelated stage after routing but before workflow write; confirm no new metadata/stage transition occurs and the skip is auditable. Delete a Dropbox source file; confirm no R2 deletion or accidental reconciliation job.
10. Force pagination, cursor reset, and a webhook during long monitor work. Confirm root-scoped monitors resume independently, account-root processing never resumes, and late kick generations cannot be cleared by a draining alarm.
11. Confirm `reconcileAwaitingRawProjects`, the Background Worker `scheduled()` handler, and its hourly cron have been removed; no date-based transition remains.

### Deployment verification

1. Complete D1 preflight/recovery, schema expansion, backfill, validation, and constraint enablement according to the rollout gate before enabling writers.
2. Deploy in the existing required worker-service order with automation disabled until application readers and mapping data are ready:

   ```text
   background → webhook-ingress → app
   ```

3. Enable root monitors through the approved feature flag only after controlled testing succeeds. Inspect Worker/DO logs, webhook receipts, system audit rows, jobs/claims, mapping collisions, version rows, per-monitor health, and cursor behavior.
4. Confirm the public webhook remains HMAC-protected. Confirm no Dropbox polling cron or `scheduled()` path remains: the date-based Awaiting RAW reconciliation was retired and Dropbox intake is exclusively webhook → root-monitor → claimed durable work.
