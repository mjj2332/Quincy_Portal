# Dropbox Webhook Automation Plan — RAW and AutoHDR Finals

**Status:** Proposed implementation plan  
**Scope:** Event-driven Dropbox intake only; no scheduled polling or Cron Trigger

## Context

Quincy Portal already receives verified, account-level Dropbox webhook notifications at `/webhooks/dropbox`. A webhook says that the connected Dropbox account changed; it does not contain the complete file-change list. The Background Worker’s `DropboxSyncDO` must use Dropbox’s cursor-based delta API to identify actual changed paths.

Today, one Durable Object tracks the Dropbox account root, matches changed paths only to stored project `rawFolderPath` values, and triggers existing RAW reconciliation. AutoHDR final-photo retrieval is a separately initiated manual workflow.

This plan converts that existing event path into two independently scoped automatic intake flows:

1. **RAW capture reconciliation** for configured project folders beneath `/Tonomo/Raw Files`.
2. **AutoHDR final-photo reconciliation** for a project’s persisted exact `/AutoHDR/<project-folder>/04-FINAL-Photos` folder.

The Dropbox webhook remains account-level. Quincy Portal will use strict path matching and root-scoped Dropbox cursors to identify whether that notification affects either supported intake flow.

## Confirmed behavior and constraints

- RAW automatic intake considers only paths under `/Tonomo/Raw Files`.
- RAW changes identify a project only through its stored `projects.rawFolderPath`.
- AutoHDR automatic intake considers only paths under `/AutoHDR` that are inside a project’s persisted exact final-output folder.
- The canonical AutoHDR final-output folder is:

  ```text
  /AutoHDR/<project-folder>/04-FINAL-Photos
  ```

- Automated routing never infers a project from a folder name.
- Automated routing never creates a project from Dropbox alone.
- There is no fallback that syncs all projects.
- Manual RAW sync remains unrestricted: it can use either RAW Folder Path or RAW Folder Link. A successful link-based manual sync continues to save the canonical RAW Folder Path for later automatic matching.
- Dropbox deletions remain non-destructive: automation does not delete R2 media or existing portal assets.
- If AutoHDR replaces a final at the same Dropbox path with a different content hash, Quincy Portal creates a new immutable edited-asset version, preserves the old R2 object, and marks the prior portal asset superseded.

## Target architecture

```text
Dropbox account change
        |
        v
/webhooks/dropbox
  - validate HMAC signature
  - persist webhook receipt
  - wake both root-specific monitors
        |
        +-----------------------------------------+
        |                                         |
        v                                         v
DropboxSyncDO: <connection>:raw        DropboxSyncDO: <connection>:autohdr
root: /Tonomo/Raw Files                root: /AutoHDR
        |                                         |
        v                                         v
match configured rawFolderPath          match persisted final-output path
        |                                         |
        v                                         v
syncProjectRawFolder()                  fetchEditedFromAutoHdr()
        |                                         |
        v                                         v
RAW assets / renditions                 edited assets / renditions / stage update
```

Each monitor maintains its own Dropbox cursor and Durable Object alarm. A large or failed RAW reconciliation must not delay the detection of AutoHDR finals, and vice versa.

## Implementation plan

### 1. Add shared Dropbox path contracts

**Primary files**

- `portal/workers/background/src/dropbox/delta.ts`
- New focused Dropbox path/routing module under `portal/workers/background/src/dropbox/`, if that keeps delta matching pure and testable
- `portal/workers/background/src/autohdr/paths.ts`

1. Define fixed normalized roots:
   - `TONOMO_RAW_ROOT = "/Tonomo/Raw Files"`
   - `AUTOHDR_ROOT = "/AutoHDR"`
2. Reuse the existing Dropbox `normalisePath()` semantics, moving that helper to a neutral Dropbox-path module if required so RAW, AutoHDR, and delta routing share one implementation.
3. Add boundary-safe containment checks. For example, `/Tonomo/Raw Files/A` is eligible but `/Tonomo/Raw Files 2/A` is not.
4. Keep watched roots explicit at delta-matching and Durable Object call sites so a future account-wide fallback cannot be introduced accidentally.
5. Keep Dropbox listing calls explicit with `include_deleted: false`. Deletions should not produce expensive reconciliation work because Quincy Portal does not mirror Dropbox deletion into R2 deletion.

### 2. Persist an exact AutoHDR final-output mapping

**Primary files**

- `portal/packages/db/src/schema.ts`
- New D1 migration under `portal/packages/db/migrations/`
- `portal/workers/background/src/autohdr/paths.ts`
- `portal/workers/background/src/workflows/autohdr.ts`
- `portal/workers/background/src/workflows/autohdr-fetch.ts`
- `portal/workers/background/src/dropbox/sync.ts`
- Project create/update paths that modify a RAW folder

1. Add nullable project-level fields for the canonical AutoHDR final-output path and its normalized comparison key.
2. Derive the canonical final path from the resolved project RAW path and store it as:

   ```text
   /AutoHDR/<project-folder>/04-FINAL-Photos
   ```

3. Add a partial unique index across non-archived projects’ normalized AutoHDR final-output keys. Two active projects must never claim the same final-output folder.
4. Populate or refresh the mapping when:
   - Tonomo creates or fills `rawFolderPath`;
   - staff change a project RAW path;
   - `syncProjectRawFolder()` resolves a RAW Folder Link and saves a canonical path;
   - AutoHDR send/fetch begins for a legacy project without a stored mapping.
5. Backfill existing projects from valid stored RAW paths. Detect and flag collisions rather than choosing a project silently.
6. Retain the existing `04-FINALS-Photos` fallback for manual legacy fetching during migration. Automated webhook routing uses only the persisted exact canonical path.
7. When a collision exists, block automatic AutoHDR routing for the conflicting projects and provide an actionable staff-visible error/job state.

### 3. Use independent root-scoped Dropbox monitors

**Primary files**

- `portal/workers/background/src/do/dropbox-sync.ts`
- `portal/workers/background/src/index.ts`
- `portal/workers/background/src/dropbox/webhook.ts`
- `portal/workers/background/src/dropbox/client.ts`, if a clearer scoped-listing API is useful
- `portal/workers/background/src/dropbox/delta.ts`

1. Keep the existing `DropboxSyncDO` class, but create two named instances per canonical Dropbox connection:
   - `${connectionId}:raw` monitors `/Tonomo/Raw Files`.
   - `${connectionId}:autohdr` monitors `/AutoHDR`.
2. Update `handleDropboxWebhook()` to wake both monitor IDs through the existing all-settled fan-out pattern. A failure to wake one monitor must not prevent the other from receiving the same webhook signal.
3. Each monitor uses its own normal `cursor` storage key and its own Durable Object alarm.
4. Stop waking the current connection-named account-root monitor. Its existing cursor cannot be reused because Dropbox continuation cursors are tied to their original list-folder root.
5. The newly named monitors establish clean root-scoped baselines without a new Durable Object class or Cloudflare DO migration.
6. On first run or cursor reset, call recursive `listFolder()` at the monitor’s root, never `""`:
   - RAW: `/Tonomo/Raw Files`
   - AutoHDR: `/AutoHDR`
7. Continue with `listFolderContinue()` only through the cursor stored by that same monitor.
8. Treat each first root listing as safe, idempotent baseline reconciliation:
   - known configured RAW folders are reconciled once;
   - known persisted AutoHDR final folders are reconciled once.
9. Preserve the current per-page commit contract in each monitor:
   - run affected project work;
   - set a next alarm only when that monitor has more work or needs retry;
   - write the next cursor only after its work succeeds;
   - clear that monitor’s alarm after its root drains.
10. Include the monitor type, watched root, project ID, and representative changed path in job payloads and error diagnostics.

### 4. Restrict RAW delta routing to known project paths

**Primary files**

- `portal/workers/background/src/dropbox/delta.ts`
- `portal/workers/background/src/do/dropbox-sync.ts`
- `portal/workers/background/src/dropbox/sync.ts`

1. Refactor `changedProjectIds()` or add an equivalent pure RAW matcher that accepts changed entries, configured project paths, a normalizer, and the explicit Tonomo root.
2. Match only non-archived projects that:
   - have a non-empty stored `rawFolderPath`;
   - have a path inside `/Tonomo/Raw Files`; and
   - receive a change at that configured path or below it.
3. Preserve case-insensitive matching and per-page project-ID de-duplication.
4. Reuse `syncProjectRawFolder()` without changing its explicit/manual behavior, including its archived-project writer guard, 150-download continuation limit, hash/path reconciliation, and canonical-path persistence.
5. Skip link-only, unconfigured, out-of-root, unmatched, and newly created Dropbox folders until a canonical RAW path has been stored.

### 5. Reuse AutoHDR final fetching for delta-triggered imports

**Primary files**

- `portal/workers/background/src/workflows/autohdr-fetch.ts`
- `portal/workers/background/src/workflows/autohdr.ts`
- `portal/workers/background/src/do/dropbox-sync.ts`
- `portal/workers/background/src/index.ts`
- Existing background job/message helpers for active workflow lookup

1. Extract reusable final-folder listing/import/reconciliation logic from `AutoHdrFetch` into an internal service with trigger context: `manual` or `dropbox_delta`.
2. Keep the Cloudflare Workflow as the durable orchestration, retry, job-lifecycle, and project-stage owner.
3. Reuse or extract the existing active `fetch_edited` job lookup so a manual fetch and a Dropbox delta share one single-flight fetch per project. Duplicate notifications and multi-page deltas must not start concurrent fetches.
4. Route an AutoHDR delta entry only when it is inside an active project’s persisted exact final-output path.
5. Launch or reuse the existing final-fetch workflow; do not perform final import inline inside the Durable Object.
6. Limit automatic final fetches to non-archived projects currently in `editing_autohdr`. This prevents historic or delivered output folders from reopening work.
7. Preserve existing final-import behavior:
   - never create AutoHDR’s final folder;
   - treat a missing final folder as “not ready,” not an integration error;
   - retain unmatched finals;
   - retain RAW pairing with exact basename first, then `_vs` / `_staged` fallback;
   - enqueue renditions;
   - advance `editing_autohdr → edited_review` only when every selected RAW has a returned edit.
8. Record `dropbox_delta`, watched root, and a representative changed path with the fetch job/audit data.

### 6. Version replaced AutoHDR finals immutably

**Primary files**

- `portal/packages/db/src/schema.ts`
- New D1 migration under `portal/packages/db/migrations/`
- `portal/workers/background/src/workflows/autohdr-fetch.ts`
- Edited-asset queries used by review, delivery, collection counts, and readiness

1. Use Dropbox final `sourcePath` and `contentHash` to identify the current imported version of an AutoHDR final.
2. Add explicit supersession fields, for example `supersededAt` and a replacement-asset link, so R2 objects and audit history remain immutable while one version is current.
3. On final import:
   - no current asset at the Dropbox source path: import the first version;
   - same source path and content hash: reconcile/no-op;
   - same source path with different content hash: import a new edited asset, preserve the RAW relationship where valid, supersede the previous current asset, and keep the older R2 object.
4. Make current edited versions the default for operations and client delivery. Keep historical versions available for audit/recovery in staff-facing contexts.
5. Verify replacement does not corrupt RAW pairing, collection counts, delivery readiness, or immutable URLs.

### 7. Add focused automated coverage

**Primary files**

- `portal/workers/background/test/dropbox-delta.test.ts`
- `portal/workers/background/test/autohdr-paths.test.ts`
- New root-monitor and AutoHDR delta-routing/import orchestration tests
- `portal/workers/webhook-ingress/test/index.test.ts`

1. Test path matching for:
   - configured project-folder entries, JPEGs, folders, and nested files;
   - unmatched root-level entries;
   - paths outside either root;
   - sibling-prefix paths such as `/Tonomo/Raw Files 2` and `/AutoHDR-backup`;
   - project paths outside their automatic root;
   - case normalization and de-duplication;
   - link-only RAW projects being skipped automatically;
   - deleted entries causing no routing.
2. Add monitor tests proving:
   - initial and reset listings use the two fixed roots and never `""`;
   - the old account-root cursor is ignored because webhook dispatch uses per-root monitor names;
   - each monitor continues, commits, retries, and resets independently;
   - RAW monitor failure does not prevent AutoHDR monitor wake-up or progress;
   - each monitor keeps its own alarm while its root has more pages.
3. Add AutoHDR routing/import tests proving:
   - an exact final-folder change starts or reuses one `fetch_edited` workflow/job;
   - duplicate Dropbox notifications do not create parallel fetches;
   - archived and non-editing projects are ignored;
   - plural legacy folders remain manual-only unless explicitly persisted;
   - same-path/same-hash finals are idempotent;
   - same-path/different-hash finals create a new current version, keep the old R2 object, and supersede the old asset;
   - unmatched finals are imported but do not falsely complete editing.
4. Retain ingress coverage for signature validation, durable receipts, duplicate wake-ups, retryable handoff failures, and receipt timestamps.

### 8. Update documentation and operational guidance

**Documentation files**

- `docs/Dropbox-Setup.md`
- `docs/Implementation-Plan.md`
- `docs/todo.md`
- `docs/lessons.md`, after implementation establishes production lessons

1. Document the webhook’s account-level wake-up role and Dropbox delta listing’s responsibility for determining actual changed paths.
2. Document the two monitored roots and independent cursor/monitor model.
3. Document that RAW automation needs a stored canonical RAW path; link-only projects require an explicit sync before automatic matching is possible.
4. Document that AutoHDR automation needs the project’s exact persisted final-output mapping and never derives a project from a Dropbox folder name.
5. Document first-run baseline reconciliation, cursor-reset behavior, deletion non-destructiveness, expected final-folder spelling, collision handling, and final-version retention.
6. Reconcile stale webhook-health statements in `docs/todo.md`: current ingress persists receipts, duplicate deliveries re-wake processing, and handoff failure returns a retryable non-2xx response.

## Verification

### Automated verification

From `portal/`, run the background typecheck:

```bash
npx tsc -p workers/background/tsconfig.json
```

Run the background Vitest suite, including all new root-monitor, delta-routing, AutoHDR workflow/job, and final-versioning coverage. Then run every required shared, app, webhook-ingress test suite and the web build defined in `CLAUDE.md`.

### Controlled Dropbox end-to-end verification

Use isolated test projects and Dropbox folders:

1. Add files/folders below a configured RAW path under `/Tonomo/Raw Files`; confirm one matching `dropbox_sync` job and idempotent RAW intake.
2. Change paths outside the RAW root and under `/Tonomo/Raw Files 2`; confirm no automatic RAW job.
3. Confirm a link-only project does not auto-match. Perform an explicit sync, confirm its canonical path is stored, then confirm a later qualifying change does match.
4. Send a project to AutoHDR, confirm the exact final-output path is persisted, then upload finals into its `04-FINAL-Photos` folder.
5. Confirm AutoHDR changes create/reuse one final-fetch workflow, import/associate edited assets, generate renditions, and advance stage only after all selected RAW assets return.
6. Replace a final at the same Dropbox path with different bytes. Confirm a new current edited version is created while the old asset and R2 object remain.
7. Change paths outside `/AutoHDR`, under `/AutoHDR-backup`, in an unconfigured final folder, or for a project outside `editing_autohdr`; confirm no final-fetch workflow begins.
8. Delete a Dropbox source file; confirm there is no R2 deletion or accidental reconciliation job.
9. Force pagination and cursor-reset scenarios. Confirm monitors resume independently, account-root processing does not resume, and each monitor alarm drains once its root is complete.

### Deployment verification

Deploy in the existing required order:

```text
background → webhook-ingress → app
```

After the background deployment, inspect Worker/DO logs, webhook receipts, jobs, asset records, and monitor cursor behavior during the controlled tests. Confirm the public webhook remains HMAC-protected and no Cron Trigger or `scheduled()` handler has been added.
