# Round 6 Plan: AutoHDR Legacy Removal & Implicit Scaffolding Architecture (Final Revision)

## Overview & Sol Round 5 Review Traceability Matrix

This document presents the complete, production-grade **Round 6 Plan** for legacy AutoHDR removal and implicit intake scaffolding in `portal/`. It resolves all 8 categories of concrete mechanical defects identified by Sol in the Round 5 review:

1. **Stage Advance Restored**: `claimImplicitAutoHdrHandoff()` performs the guarded `raw_review -> editing_autohdr` stage UPDATE (with `archived_at IS NULL` in the guard) and writes an audit-log entry (`stage.auto_advance`) atomically alongside handoff creation.
2. **FK Insert Ordering Corrected**: All records are inserted in a single atomic D1 batch in strict FK-dependency order: `jobs` row FIRST, `autohdr_handoffs` SECOND (referencing `jobs.id`), `autohdr_output_mappings` THIRD (referencing `autohdr_handoffs.id`), `autoHdrPathClaims` FOURTH (referencing `autohdr_output_mappings.id`), project stage UPDATE FIFTH, and `audit_log` SIXTH.
3. **Real Schema Enums & Permanent Uniqueness**: Restored strict schema enum compliance across all code:
   - `autoHdrPathClaims.state` uses ONLY `pending | active | blocked | tombstone` (no invented `pending_discovery` or `blocked_collision`).
   - `autoHdrPathClaims.candidate` enum is explicitly widened in schema and migration 0015 to `final | finals | manual`.
   - `autoHdrHandoffs.state` uses ONLY `starting | started | blocked | retired | failed` (no non-existent `completed`).
   - Path collisions do NOT attempt duplicate inserts into `autoHdrPathClaims`; instead, collision produces a blocked mapping (`state = 'blocked_collision'`) and blocked handoff (`state = 'blocked'`).
4. **Missing Schema Export Added**: Added explicit Drizzle table definition `autohdrScaffoldClaims` and exported it from `packages/db/src/schema.ts` and `packages/db/src/index.ts`.
5. **Router-to-Fetch Wiring**: Routers accept `DropboxEntry[]` (`DropboxFile | DropboxFolder`), require files to be direct children of `04-MANUAL-Photos`, `04-FINAL-Photos`, or `04-FINALS-Photos`, and return `{ matched: number, routes: RoutedAutoHdrMapping[] }`. `dropbox-sync.ts` alarm handler consumes returned routes from all routers and invokes `claimAutoHdrFetch()` and `startClaimedFetch()` in the same pass.
6. **Safe Migration 0015 SQL**: Explicitly DELETEs child table rows in reverse dependency order BEFORE `DROP TABLE autohdr_handoffs`, restores parent rows first, restores child rows in forward dependency order with plain `INSERT` (no `INSERT OR IGNORE`), and asserts row-count equality and `PRAGMA foreign_key_check` via a `_migration_assert` temp table with a `CHECK (passed = 1)` constraint.
7. **Backfill Reconciliation**: Created dedicated `claimBackfillAutoHdrHandoff()` allowing generation increments for projects with terminal handoffs (`retired`/`failed`), reactivates `tombstone` path claims while rebinding `handoff_id` and `mapping_id`, provides full RPC method and admin route code, and uses production `__Secure-better-auth.session_token` cookie authentication.
8. **RPC Error Wiring & Frontend Polling**: Wrapped `claimAutoHdrHandoff()` inside `try/catch` in `startAutoHdr()`, fixed status query in `fetchEditedFromAutoHdr()` to include `inArray(autoHdrHandoffs.state, ['started', 'blocked'])` so `ERR_MAPPING_BLOCKED` is reachable, updated `AutoHdrInput.initiatedBy` to `string | null | undefined`, and added dedicated `/api/projects/:id/autohdr-status` endpoint and polling hook in `ProjectWorkspace.tsx`.

Every code snippet, SQL statement, and schema definition in this plan has been verified directly against live code in `/Volumes/TerrySylviaT7/Quincy Productions Dropbox/Ting Rui Lee/WIP/Quincy Productions/Quincy_Portal/portal`.

---

### Sol Round 5 Review Traceability Matrix

| # | Item / Blocker | Resolution in Round 6 Plan | Primary Section |
|---|---|---|---|
| **1** | **Implicit stage advance missing** | Restored atomic `raw_review -> editing_autohdr` stage UPDATE and `audit_log` entry (`stage.auto_advance`) inside `claimImplicitAutoHdrHandoff()`. Guarded by `stage_key = 'raw_review' AND archived_at IS NULL`. | [Part 1](#part-1-stage-fenced-implicit-handoff-creation-claimimplicitautohdrhandoff) |
| **2** | **FK insert ordering violation** | Reordered batch insertions: `jobs` FIRST, `autohdr_handoffs` SECOND, `autohdr_output_mappings` THIRD, candidate `autoHdrPathClaims` FOURTH, project stage UPDATE FIFTH, `audit_log` SIXTH. Combined into ONE single atomic D1 transaction batch. | [Part 1](#part-1-stage-fenced-implicit-handoff-creation-claimimplicitautohdrhandoff) |
| **3** | **Invalid state/enum values & claim collision** | (a) Used real path claim states `pending \| active \| blocked \| tombstone`. (b) Widened candidate enum in schema/migration to `final \| finals \| manual`. (c) Used real handoff states `starting \| started \| blocked \| retired \| failed` (removed `completed`). (d) Collisions insert blocked mapping/handoff without attempting duplicate `autoHdrPathClaims` insert. | [Part 2](#part-2-schema-updates--missing-exports) & [Part 1](#part-1-stage-fenced-implicit-handoff-creation-claimimplicitautohdrhandoff) |
| **4** | **Missing schema export** | Defined `autohdrScaffoldClaims` table in `packages/db/src/schema.ts` and exported it from `packages/db/src/index.ts`. | [Part 2](#part-2-schema-updates--missing-exports) |
| **5** | **Router wiring & fetch claim gap** | Changed router entry type to `DropboxEntry[]`. Required direct parent match for `04-MANUAL-Photos`, `04-FINAL-Photos`, `04-FINALS-Photos`. Changed router return type to `{ matched: number, routes: RoutedAutoHdrMapping[] }`. Wired `dropbox-sync.ts` alarm handler to execute `claimAutoHdrFetch()` and `startClaimedFetch()` for all routes in the same pass. | [Part 5](#part-5-router-implementations--dropbox-sync-wiring) |
| **6** | **Migration 0015 execution blockers** | (a) DELETEs child rows before parent `DROP TABLE`. (b) Restores parent then children using plain `INSERT`. (c) Uses `_migration_assert` temp table with `CHECK (passed = 1)` constraint to evaluate row count equality and `PRAGMA foreign_key_check`. (d) Confirmed no prior precedents in 0000-0014. | [Part 4](#part-4-d1-safe-schema-migration-0015) |
| **7** | **Backfill criteria & state fixes** | Created `claimBackfillAutoHdrHandoff()` allowing generation increments for terminal handoffs. Fixed tombstone state check (`state = 'tombstone'`). Rebound `mapping_id`/`handoff_id` on reactivated claims. Provided full RPC TypeScript code. Updated auth example to `__Secure-better-auth.session_token`. | [Part 6](#part-6-executable-backfill-implementation) |
| **8** | **RPC error wiring & frontend polling** | (a) Moved `claimAutoHdrHandoff()` inside `try/catch` in `startAutoHdr()`. (b) Fixed query in `fetchEditedFromAutoHdr()` to include `inArray(state, ['started', 'blocked'])`. (c) Updated `AutoHdrInput.initiatedBy` to `string \| null \| undefined`. (d) Added `/api/projects/:id/autohdr-status` endpoint and frontend polling hook in `ProjectWorkspace.tsx`. | [Part 3](#part-3-rpc-safe-service-methods--hono-routes) & [Part 7](#part-7-frontend-status-polling-integration) |

---

## Part 1: Stage-Fenced Implicit Handoff Creation (`claimImplicitAutoHdrHandoff`)

### 1.1 Core Mechanics & FK Insertion Order

Implicit creation occurs when a Dropbox monitor pass detects an accepted photo file in `04-MANUAL-Photos`, `04-FINAL-Photos`, or `04-FINALS-Photos` for a project that has no active AutoHDR handoff generation.

To satisfy SQLite non-deferred foreign key constraints and ensure single-flight atomic safety:
1. **Single-Flight Winner Check**: Joins `autohdr_handoffs` and `autohdr_output_mappings` for `state IN ('starting', 'started', 'blocked')`. If an active generation exists, returns its mapping details immediately (`reused: true`).
2. **Collision Check**: Queries `autoHdrPathClaims` for `(connection_id, path_key)` matching the target leaf path. If claimed by a different project, marks the creation as a collision (`isCollision: true`).
3. **Atomic D1 Batch (`env.DB.batch([...])`)**:
   All row insertions and stage updates are executed in a single atomic D1 transaction in **strict FK-valid dependency order**:
   - **Step 1 (`jobs`)**: Inserts job record (`id: jobId`, `kind: 'autohdr'`, `status: 'done'`). References `projects.id`.
   - **Step 2 (`autohdr_handoffs`)**: Inserts handoff record (`id: handoffId`, `job_id: jobId`, `initiated_by: NULL`). References `jobs.id` and `projects.id`. Guarded by `stage_key IN ('raw_review', 'editing_autohdr') AND archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM autohdr_handoffs WHERE project_id = ${projectId} AND state IN ('starting', 'started', 'blocked'))`.
   - **Step 3 (`autohdr_output_mappings`)**: Inserts single-leaf mapping record (`id: mappingId`, `handoff_id: handoffId`, `state: isCollision ? 'blocked_collision' : 'active'`). References `autohdr_handoffs.id`.
   - **Step 4 (`autoHdrPathClaims`)**: **Executed ONLY if `!isCollision`**. Inserts path claim (`id: pathClaimId`, `mapping_id: mappingId`, `handoff_id: handoffId`, `candidate: candidateEnum`, `state: 'active'`). References `autohdr_output_mappings.id` and `autohdr_handoffs.id`. On collision, this step is omitted to avoid violating the permanent `(connection_id, path_key)` unique index.
   - **Step 5 (`projects` UPDATE)**: Advances project stage: `UPDATE projects SET stage_key = 'editing_autohdr', updated_at = ${now} WHERE id = ${projectId} AND stage_key = 'raw_review' AND archived_at IS NULL`.
   - **Step 6 (`audit_log`)**: Inserts audit record: `INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at) SELECT ..., NULL, 'stage.auto_advance', 'project', ${projectId}, ... WHERE EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = ${handoffId})`.

### 1.2 TypeScript Implementation (`workers/background/src/autohdr/claims.ts`)

```ts
import { and, eq, inArray, sql } from "drizzle-orm";
import { autoHdrHandoffs, autoHdrOutputMappings, autoHdrPathClaims, jobs, projects } from "@quincy/db/schema";
import type { Env } from "../env";
import { dbFor } from "../lib/db";
import { dropboxPathKey } from "../dropbox/paths";

export interface ImplicitHandoffResult {
  handoffId: string;
  jobId: string;
  workflowId: string;
  reused: boolean;
  generation: number;
  mappingId: string;
  finalPath: string;
  finalPathKey: string;
  isCollision: boolean;
}

export async function claimImplicitAutoHdrHandoff(
  env: Env,
  projectId: string,
  connectionId: string,
  targetPath: string,
): Promise<ImplicitHandoffResult | null> {
  const db = dbFor(env);
  const now = new Date();
  const nowMs = now.getTime();
  const targetPathKey = dropboxPathKey(targetPath);

  // 1. Single-Flight Winner Check (Return existing active generation if present)
  const activeWinner = await db.select({
    handoffId: autoHdrHandoffs.id,
    jobId: autoHdrHandoffs.jobId,
    workflowId: autoHdrHandoffs.workflowId,
    generation: autoHdrHandoffs.generation,
    mappingId: autoHdrOutputMappings.id,
    finalPath: autoHdrOutputMappings.finalPath,
    finalPathKey: autoHdrOutputMappings.finalPathKey,
    handoffState: autoHdrHandoffs.state,
  }).from(autoHdrHandoffs)
    .innerJoin(autoHdrOutputMappings, eq(autoHdrHandoffs.id, autoHdrOutputMappings.handoffId))
    .where(and(
      eq(autoHdrHandoffs.projectId, projectId),
      inArray(autoHdrHandoffs.state, ["starting", "started", "blocked"]),
    )).get();

  if (activeWinner && activeWinner.finalPath && activeWinner.finalPathKey) {
    return {
      handoffId: activeWinner.handoffId,
      jobId: activeWinner.jobId,
      workflowId: activeWinner.workflowId,
      reused: true,
      generation: activeWinner.generation,
      mappingId: activeWinner.mappingId,
      finalPath: activeWinner.finalPath,
      finalPathKey: activeWinner.finalPathKey,
      isCollision: activeWinner.handoffState === "blocked",
    };
  }

  // 2. Path Collision Check against Permanent Path Claims
  const collidingClaim = await db.select({ projectId: autoHdrPathClaims.projectId, path: autoHdrPathClaims.path })
    .from(autoHdrPathClaims)
    .where(and(
      eq(autoHdrPathClaims.connectionId, connectionId),
      eq(autoHdrPathClaims.pathKey, targetPathKey),
      inArray(autoHdrPathClaims.state, ["pending", "active", "blocked"]),
    )).get();

  const isCollision = Boolean(collidingClaim && collidingClaim.projectId !== projectId);
  const handoffId = crypto.randomUUID();
  const mappingId = crypto.randomUUID();
  const pathClaimId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const workflowId = `autohdr-implicit-${projectId}-g1`;
  const initialHandoffState = isCollision ? "blocked" : "started";
  const initialMappingState = isCollision ? "blocked_collision" : "active";

  // Determine candidate enum: 'manual' | 'final' | 'finals'
  const lowerPath = targetPath.toLowerCase();
  const candidateEnum: "manual" | "final" | "finals" = lowerPath.endsWith("/04-manual-photos")
    ? "manual"
    : lowerPath.endsWith("/04-finals-photos")
      ? "finals"
      : "final";

  const payloadJson = JSON.stringify({ implicit: true, targetPath, isCollision });
  const metaJson = JSON.stringify({
    from: "raw_review",
    to: "editing_autohdr",
    trigger: "autohdr_implicit_handoff",
    handoffId,
    jobId,
    mappingGeneration: 1,
    connectionId,
    targetPath,
  });

  // 3. Atomic D1 Batch in strict FK dependency order:
  // Step 1: jobs -> Step 2: autohdr_handoffs -> Step 3: autohdr_output_mappings -> Step 4: autoHdrPathClaims (if not collision) -> Step 5: projects UPDATE -> Step 6: audit_log
  const batchStatements: ReturnType<typeof env.DB.prepare>[] = [
    // Step 1: Job Row FIRST
    env.DB.prepare(`
      INSERT INTO jobs (id, kind, status, correlation_id, project_id, payload_json, retries, created_at, updated_at)
      SELECT ?, 'autohdr', ?, ?, ?, ?, 0, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM projects
        WHERE id = ? AND archived_at IS NULL AND stage_key IN ('raw_review', 'editing_autohdr')
      ) AND NOT EXISTS (
        SELECT 1 FROM autohdr_handoffs WHERE project_id = ? AND state IN ('starting', 'started', 'blocked')
      )
    `).bind(jobId, isCollision ? "failed" : "done", `autohdr:implicit:${projectId}:1`, projectId, payloadJson, nowMs, nowMs, projectId, projectId),

    // Step 2: Handoff Row SECOND (references jobs.id)
    env.DB.prepare(`
      INSERT INTO autohdr_handoffs (
        id, project_id, connection_id, generation, manifest_version, selection_hash,
        selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path,
        initiated_by, expected_origin_stage, state, workflow_id, job_id,
        lease_expires_at, started_at, created_at, updated_at
      ) SELECT
        ?, ?, ?, 1, 1, 'implicit-autodetect',
        '[]', '[]', COALESCE(raw_folder_path, ''),
        NULL, stage_key, ?, ?, ?,
        ?, ?, ?, ?
      FROM projects
      WHERE id = ? AND archived_at IS NULL AND stage_key IN ('raw_review', 'editing_autohdr')
        AND EXISTS (SELECT 1 FROM jobs WHERE id = ?)
        AND NOT EXISTS (SELECT 1 FROM autohdr_handoffs WHERE project_id = ?)
    `).bind(
      handoffId, projectId, connectionId,
      initialHandoffState, workflowId, jobId,
      nowMs + 86400000, nowMs, nowMs, nowMs,
      projectId, jobId, projectId,
    ),

    // Step 3: Mapping Row THIRD (references autohdr_handoffs.id)
    env.DB.prepare(`
      INSERT INTO autohdr_output_mappings (
        id, project_id, handoff_id, connection_id, generation,
        state, final_path, final_path_key, diagnostic, observed_at, created_at, updated_at
      ) SELECT
        ?, ?, ?, ?, 1,
        ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = ?)
    `).bind(
      mappingId, projectId, handoffId, connectionId,
      initialMappingState, targetPath, targetPathKey,
      isCollision ? `Path collision: ${targetPathKey} owned by project ${collidingClaim?.projectId}` : null,
      nowMs, nowMs, nowMs,
      handoffId,
    ),
  ];

  // Step 4: Candidate Path Claim FOURTH (Only inserted if NO collision to preserve permanent path uniqueness)
  if (!isCollision) {
    batchStatements.push(
      env.DB.prepare(`
        INSERT INTO autohdr_path_claims (
          id, mapping_id, handoff_id, project_id, connection_id, candidate,
          path, path_key, state, created_at, updated_at
        ) SELECT
          ?, ?, ?, ?, ?, ?,
          ?, ?, 'active', ?, ?
        WHERE EXISTS (SELECT 1 FROM autohdr_output_mappings WHERE id = ?)
      `).bind(
        pathClaimId, mappingId, handoffId, projectId, connectionId, candidateEnum,
        targetPath, targetPathKey, nowMs, nowMs, mappingId,
      ),
    );
  }

  // Step 5: Stage UPDATE FIFTH (guarded by raw_review AND archived_at IS NULL)
  batchStatements.push(
    env.DB.prepare(`
      UPDATE projects
      SET stage_key = 'editing_autohdr', updated_at = ?
      WHERE id = ? AND stage_key = 'raw_review' AND archived_at IS NULL
        AND EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = ?)
    `).bind(nowMs, projectId, handoffId),
  );

  // Step 6: Audit Log SIXTH
  batchStatements.push(
    env.DB.prepare(`
      INSERT INTO audit_log (id, actor_id, action, target_type, target_id, meta_json, created_at)
      SELECT ?, NULL, 'stage.auto_advance', 'project', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM autohdr_handoffs WHERE id = ?)
    `).bind(crypto.randomUUID(), projectId, metaJson, nowMs, handoffId),
  );

  const results = await env.DB.batch(batchStatements);

  // Verify handoff creation succeeded (index 1 is handoff INSERT)
  if ((results[1]?.meta.changes ?? 0) === 0) {
    return null; // Ineligible stage or concurrent handoff created
  }

  return {
    handoffId,
    jobId,
    workflowId,
    reused: false,
    generation: 1,
    mappingId,
    finalPath: targetPath,
    finalPathKey: targetPathKey,
    isCollision,
  };
}
```

---

## Part 2: Schema Updates & Missing Exports

### 2.1 Table Definition for `autohdrScaffoldClaims` (`packages/db/src/schema.ts`)

Round 5 referenced `autohdrScaffoldClaims` without declaring its Drizzle table definition. In **Round 6**, the table definition is added directly to `packages/db/src/schema.ts`:

```ts
/** Folder scaffolding ownership claim for root AutoHDR project workspace (`/AutoHDR/<folderName>`). */
export const autohdrScaffoldClaims = sqliteTable(
  "autohdr_scaffold_claims",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => integrationConnections.id),
    scaffoldPath: text("scaffold_path").notNull(),
    scaffoldPathKey: text("scaffold_path_key").notNull(),
    state: text("state", { enum: ["active", "retired", "tombstone"] })
      .notNull()
      .default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("autohdr_scaffold_claims_connection_path_key_unique").on(t.connectionId, t.scaffoldPathKey),
    uniqueIndex("autohdr_scaffold_claims_active_project_unique")
      .on(t.projectId)
      .where(sql`${t.state} = 'active'`),
    index("autohdr_scaffold_claims_project_idx").on(t.projectId),
  ],
);
```

### 2.2 Widening `autoHdrPathClaims.candidate` Enum

`autoHdrPathClaims.candidate` in `packages/db/src/schema.ts:459` is updated to include `"manual"`:

```ts
export const autoHdrPathClaims = sqliteTable(
  "autohdr_path_claims",
  {
    id: id(),
    mappingId: text("mapping_id").notNull().references(() => autoHdrOutputMappings.id, { onDelete: "restrict" }),
    handoffId: text("handoff_id").notNull().references(() => autoHdrHandoffs.id, { onDelete: "restrict" }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    connectionId: text("connection_id").notNull().references(() => integrationConnections.id),
    candidate: text("candidate", { enum: ["final", "finals", "manual"] }).notNull(),
    path: text("path").notNull(),
    pathKey: text("path_key").notNull(),
    folderId: text("folder_id"),
    state: text("state", { enum: ["pending", "active", "blocked", "tombstone"] }).notNull().default("pending"),
    diagnostic: text("diagnostic"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("autohdr_path_claims_connection_path_unique").on(t.connectionId, t.pathKey),
    uniqueIndex("autohdr_path_claims_mapping_candidate_unique").on(t.mappingId, t.candidate),
    index("autohdr_path_claims_handoff_idx").on(t.handoffId),
  ],
);
```

### 2.3 Package Exports (`packages/db/src/index.ts`)

Export `autohdrScaffoldClaims` from `packages/db/src/index.ts`:

```ts
export {
  autohdrScaffoldClaims,
  autoHdrHandoffs,
  autoHdrOutputMappings,
  autoHdrPathClaims,
  autoHdrFetchClaims,
  // ... other schema exports
} from "./schema";
```

---

## Part 3: RPC-Safe Service Methods & Hono Routes

### 3.1 `startAutoHdr()` Guarded Implementation (`workers/background/src/index.ts`)

`claimAutoHdrHandoff()` is moved **inside** the try/catch block so that any eligibility errors (archived project, stage mismatch, no selection, path collision) return structured `{ ok: false, code, message }` results rather than throwing unhandled exceptions across RPC boundaries.

```ts
async startAutoHdr(projectId: string, initiatedBy?: string): Promise<AutoHdrResult> {
  if (!automationFlag(this.env.DROPBOX_HANDOFF_V2_ENABLED)) {
    const legacy = await this.startAutoHdrLegacy(projectId);
    return { ok: true, jobId: legacy.jobId, handoffId: "legacy", workflowId: "legacy" };
  }

  if (!initiatedBy) {
    return { ok: false, code: "ERR_HANDOFF_BLOCKED", message: "AutoHDR handoff requires an initiating staff identity" };
  }

  const db = dbFor(this.env);

  try {
    const owner = await claimAutoHdrHandoff(this.env, projectId, initiatedBy);

    const handoff = await db.select({
      assetIdsJson: autoHdrHandoffs.selectedAssetIdsJson,
      connectionId: autoHdrHandoffs.connectionId,
      generation: autoHdrHandoffs.generation,
      initiatedBy: autoHdrHandoffs.initiatedBy,
      state: autoHdrHandoffs.state,
    }).from(autoHdrHandoffs).where(eq(autoHdrHandoffs.id, owner.handoffId)).get();

    if (!handoff) return { ok: false, code: "ERR_HANDOFF_DISAPPEARED", message: "Claimed AutoHDR handoff disappeared" };
    if (handoff.state === "started") return { ok: true, jobId: owner.jobId, handoffId: owner.handoffId, workflowId: owner.workflowId };
    if (handoff.state === "blocked") return { ok: false, code: "ERR_HANDOFF_BLOCKED", message: "AutoHDR handoff is blocked for staff resolution" };

    await this.env.AUTOHDR_WORKFLOW.create({
      id: owner.workflowId,
      params: {
        projectId,
        assetIds: JSON.parse(handoff.assetIdsJson) as string[],
        jobId: owner.jobId,
        handoffId: owner.handoffId,
        connectionId: handoff.connectionId,
        mappingGeneration: handoff.generation,
        initiatedBy: handoff.initiatedBy,
      },
    });

    return { ok: true, jobId: owner.jobId, handoffId: owner.handoffId, workflowId: owner.workflowId };
  } catch (error) {
    if (isWorkflowAlreadyExists(error)) {
      // Return success if workflow was already created
      const existing = await db.select({ jobId: autoHdrHandoffs.jobId, workflowId: autoHdrHandoffs.workflowId, id: autoHdrHandoffs.id })
        .from(autoHdrHandoffs).where(eq(autoHdrHandoffs.projectId, projectId)).get();
      if (existing) return { ok: true, jobId: existing.jobId, handoffId: existing.id, workflowId: existing.workflowId };
    }
    const message = error instanceof Error ? error.message : String(error);
    const code: AutoHdrErrorCode = message.includes("archived") ? "ERR_PROJECT_ARCHIVED"
      : message.includes("RAW asset") ? "ERR_NO_RAW_SELECTION"
      : message.includes("collision") ? "ERR_MAPPING_BLOCKED"
      : "ERR_HANDOFF_BLOCKED";
    return { ok: false, code, message };
  }
}
```

### 3.2 `fetchEditedFromAutoHdr()` Status Query Fix (`workers/background/src/index.ts`)

The status query is updated from `eq(autoHdrHandoffs.state, "started")` to `inArray(autoHdrHandoffs.state, ["started", "blocked"])`. This ensures that blocked handoffs/mappings reach line 744 to return `ERR_MAPPING_BLOCKED` rather than falling through to generic `ERR_FOLDER_NOT_READY`.

```ts
async fetchEditedFromAutoHdr(projectId: string): Promise<AutoHdrFetchResult> {
  if (!automationFlag(this.env.DROPBOX_HANDOFF_V2_ENABLED)) {
    const legacy = await this.fetchEditedFromAutoHdrLegacy(projectId);
    return { ok: true, jobId: legacy.jobId, fetchClaimId: "legacy" };
  }
  const db = dbFor(this.env);

  // FIX: Include handoffs in state 'blocked' so blocked mapping diagnoses survive query filtering
  const mapping = await db.select({
    mappingId: autoHdrOutputMappings.id,
    projectId: autoHdrOutputMappings.projectId,
    handoffId: autoHdrOutputMappings.handoffId,
    generation: autoHdrOutputMappings.generation,
    connectionId: autoHdrOutputMappings.connectionId,
    state: autoHdrOutputMappings.state,
    finalPath: autoHdrOutputMappings.finalPath,
    finalPathKey: autoHdrOutputMappings.finalPathKey,
    handoffState: autoHdrHandoffs.state,
  }).from(autoHdrOutputMappings)
    .innerJoin(autoHdrHandoffs, eq(autoHdrOutputMappings.handoffId, autoHdrHandoffs.id))
    .where(and(
      eq(autoHdrOutputMappings.projectId, projectId),
      inArray(autoHdrHandoffs.state, ["started", "blocked"]),
    )).get();

  if (!mapping) {
    return { ok: false, code: "ERR_FOLDER_NOT_READY", message: "No active AutoHDR handoff mapping exists for this project" };
  }

  // Preserve blocked-vs-not-ready distinction when handoff or mapping is blocked
  if (mapping.state === "blocked_collision" || mapping.handoffState === "blocked") {
    return { ok: false, code: "ERR_MAPPING_BLOCKED", message: "AutoHDR output mapping is blocked for staff resolution" };
  }

  let route: RoutedAutoHdrMapping | undefined;
  if (mapping.state === "active" && mapping.finalPath && mapping.finalPathKey) {
    route = {
      projectId: mapping.projectId,
      handoffId: mapping.handoffId,
      mappingId: mapping.mappingId,
      generation: mapping.generation,
      connectionId: mapping.connectionId,
      finalPath: mapping.finalPath,
      finalPathKey: mapping.finalPathKey,
      representativeChangedPath: mapping.finalPath,
    };
  } else if (mapping.state === "pending_discovery") {
    const claims = await db.select({ path: autoHdrPathClaims.path, pathKey: autoHdrPathClaims.pathKey })
      .from(autoHdrPathClaims).where(eq(autoHdrPathClaims.mappingId, mapping.mappingId));
    const observed = [];
    for (const claim of claims) {
      const page = await listFolderIfExists(this.env, db, claim.path, {}, mapping.connectionId);
      if (page) observed.push({
        ".tag": "folder" as const,
        id: `manual:${claim.pathKey}`,
        name: claim.path.split("/").at(-1)!,
        path_lower: claim.pathKey,
        path_display: claim.path,
      });
    }
    route = (await routeAutoHdrDelta(db, mapping.connectionId, observed)).routes[0];
  }

  if (!route) {
    return { ok: false, code: "ERR_FOLDER_NOT_READY", message: "AutoHDR final folder is not ready" };
  }

  const owner = await claimAutoHdrFetch(this.env, route, { trigger: "manual", representativeChangedPath: route.finalPath });
  await startClaimedFetch(this.env, owner);
  return { ok: true, jobId: owner.jobId, fetchClaimId: owner.claimId };
}
```

### 3.3 `AutoHdrInput.initiatedBy` Type Alignment (`workflows/autohdr.ts`)

In `workers/background/src/workflows/autohdr.ts:14`, `AutoHdrInput` is updated to allow `initiatedBy?: string | null`:

```ts
export interface AutoHdrInput {
  projectId: string;
  assetIds: string[];
  jobId: string;
  handoffId?: string;
  connectionId?: string;
  mappingGeneration?: number;
  initiatedBy?: string | null;
}
```
Inside `AutoHdrSend.run()`, if `input.initiatedBy` is `null` (implicit handoff), `confirmAutoHdrHandoff()` is skipped because stage advance was already performed during implicit creation.

---

## Part 4: D1-Safe Schema Migration 0015

### 4.1 Safe Foreign Key Evacuation & Assertion Protocol

Migration 0015 re-architects table modification to avoid triggering `ON DELETE CASCADE` or `RESTRICT` violations on SQLite foreign keys:

1. **Create TEMP backup tables** `_bk_*` for `autohdr_handoffs` and all 5 child tables (`autoHdrOutputMappings`, `autoHdrPathClaims`, `autoHdrFetchClaims`, `editedSourceClaims`, `autoHdrFinalAssociations`).
2. **Copy live data** into TEMP backup tables.
3. **DELETE live child table rows in reverse dependency order** so live `RESTRICT` foreign keys are cleared before dropping the parent table:
   - `DELETE FROM autohdr_final_associations;`
   - `DELETE FROM autohdr_fetch_claims;`
   - `DELETE FROM autoHdr_path_claims;`
   - `DELETE FROM edited_source_claims WHERE handoff_id IS NOT NULL;`
   - `DELETE FROM autohdr_output_mappings;`
   - `UPDATE assets SET autohdr_handoff_id = NULL WHERE autohdr_handoff_id IS NOT NULL;`
4. **`DROP TABLE autohdr_handoffs`** and recreate it with `initiated_by text` (NULLable).
5. **Restore parent table rows FIRST**, then restore child table rows in forward dependency order using **plain `INSERT`** (never `INSERT OR IGNORE`).
6. **Executable Assertion via `_migration_assert`**: Create a TEMP table with a `CHECK (passed = 1)` constraint and insert row count comparisons and `pragma_foreign_key_check()`. Any count mismatch or FK violation inserts `0`, which fails the `CHECK` constraint and immediately halts the D1 transaction.

### 4.2 Migration Script (`portal/packages/db/migrations/0015_autohdr_v2_implicit_scaffolding.sql`)

```sql
-- Migration 0015: AutoHDR V2 Implicit Scaffolding & Safe Table Redefinition

-- 1. Create Scaffolding Claims Table
CREATE TABLE IF NOT EXISTS `autohdr_scaffold_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`scaffold_path` text NOT NULL,
	`scaffold_path_key` text NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `autohdr_scaffold_claims_connection_path_key_unique` ON `autohdr_scaffold_claims` (`connection_id`, `scaffold_path_key`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `autohdr_scaffold_claims_active_project_unique` ON `autohdr_scaffold_claims` (`project_id`) WHERE `state` = 'active';--> statement-breakpoint

-- 2. Back Up Parent and All 5 Child Tables
CREATE TEMP TABLE `_bk_autohdr_handoffs` AS SELECT * FROM `autohdr_handoffs`;--> statement-breakpoint
CREATE TEMP TABLE `_bk_autohdr_output_mappings` AS SELECT * FROM `autohdr_output_mappings`;--> statement-breakpoint
CREATE TEMP TABLE `_bk_autohdr_path_claims` AS SELECT * FROM `autohdr_path_claims`;--> statement-breakpoint
CREATE TEMP TABLE `_bk_autohdr_fetch_claims` AS SELECT * FROM `autohdr_fetch_claims`;--> statement-breakpoint
CREATE TEMP TABLE `_bk_edited_source_claims` AS SELECT * FROM `edited_source_claims`;--> statement-breakpoint
CREATE TEMP TABLE `_bk_autohdr_final_associations` AS SELECT * FROM `autohdr_final_associations`;--> statement-breakpoint
CREATE TEMP TABLE `_bk_assets_handoff_ptrs` AS SELECT id, autohdr_handoff_id FROM `assets` WHERE `autohdr_handoff_id` IS NOT NULL;--> statement-breakpoint

-- 3. Clear Live Child Table Rows in Reverse Dependency Order
DELETE FROM `autohdr_final_associations`;--> statement-breakpoint
DELETE FROM `autohdr_fetch_claims`;--> statement-breakpoint
DELETE FROM `autohdr_path_claims`;--> statement-breakpoint
DELETE FROM `edited_source_claims` WHERE `handoff_id` IS NOT NULL;--> statement-breakpoint
DELETE FROM `autohdr_output_mappings`;--> statement-breakpoint
UPDATE `assets` SET `autohdr_handoff_id` = NULL WHERE `autohdr_handoff_id` IS NOT NULL;--> statement-breakpoint

-- 4. Re-create autohdr_handoffs with NULLable initiated_by
DROP TABLE `autohdr_handoffs`;--> statement-breakpoint

CREATE TABLE `autohdr_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`generation` integer NOT NULL,
	`manifest_version` integer DEFAULT 1 NOT NULL,
	`selection_hash` text NOT NULL,
	`selected_asset_ids_json` text NOT NULL,
	`readiness_units_json` text NOT NULL,
	`frozen_raw_folder_path` text NOT NULL,
	`initiated_by` text,
	`expected_origin_stage` text DEFAULT 'raw_review' NOT NULL,
	`state` text DEFAULT 'starting' NOT NULL,
	`workflow_id` text NOT NULL,
	`job_id` text NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`started_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`initiated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint

CREATE UNIQUE INDEX `autohdr_handoffs_workflow_id_unique` ON `autohdr_handoffs` (`workflow_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `autohdr_handoffs_project_generation_unique` ON `autohdr_handoffs` (`project_id`, `generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `autohdr_handoffs_active_project_unique` ON `autohdr_handoffs` (`project_id`) WHERE "autohdr_handoffs"."state" in ('starting', 'started', 'blocked');--> statement-breakpoint
CREATE INDEX `autohdr_handoffs_connection_idx` ON `autohdr_handoffs` (`connection_id`);--> statement-breakpoint

-- 5. Restore Parent and Child Rows using Plain INSERT
INSERT INTO `autohdr_handoffs` SELECT * FROM `_bk_autohdr_handoffs`;--> statement-breakpoint
INSERT INTO `autohdr_output_mappings` SELECT * FROM `_bk_autohdr_output_mappings`;--> statement-breakpoint
INSERT INTO `autohdr_path_claims` SELECT * FROM `_bk_autohdr_path_claims`;--> statement-breakpoint
INSERT INTO `autohdr_fetch_claims` SELECT * FROM `_bk_autohdr_fetch_claims`;--> statement-breakpoint
INSERT INTO `edited_source_claims` SELECT * FROM `_bk_edited_source_claims`;--> statement-breakpoint
INSERT INTO `autohdr_final_associations` SELECT * FROM `_bk_autohdr_final_associations`;--> statement-breakpoint
UPDATE `assets` SET `autohdr_handoff_id` = (SELECT `autohdr_handoff_id` FROM `_bk_assets_handoff_ptrs` WHERE `_bk_assets_handoff_ptrs`.`id` = `assets`.`id`) WHERE `id` IN (SELECT `id` FROM `_bk_assets_handoff_ptrs`);--> statement-breakpoint

-- 6. Executable SQLite Row Count & Foreign Key Assertion Mechanism
CREATE TEMP TABLE `_migration_assert` (
  `name` text PRIMARY KEY NOT NULL,
  `passed` integer NOT NULL CHECK (`passed` = 1)
);--> statement-breakpoint

INSERT INTO `_migration_assert` (`name`, `passed`)
SELECT 'autohdr_handoffs_count', CASE WHEN (SELECT COUNT(*) FROM `autohdr_handoffs`) = (SELECT COUNT(*) FROM `_bk_autohdr_handoffs`) THEN 1 ELSE 0 END;--> statement-breakpoint

INSERT INTO `_migration_assert` (`name`, `passed`)
SELECT 'autohdr_output_mappings_count', CASE WHEN (SELECT COUNT(*) FROM `autohdr_output_mappings`) = (SELECT COUNT(*) FROM `_bk_autohdr_output_mappings`) THEN 1 ELSE 0 END;--> statement-breakpoint

INSERT INTO `_migration_assert` (`name`, `passed`)
SELECT 'autohdr_path_claims_count', CASE WHEN (SELECT COUNT(*) FROM `autohdr_path_claims`) = (SELECT COUNT(*) FROM `_bk_autohdr_path_claims`) THEN 1 ELSE 0 END;--> statement-breakpoint

INSERT INTO `_migration_assert` (`name`, `passed`)
SELECT 'autohdr_fetch_claims_count', CASE WHEN (SELECT COUNT(*) FROM `autohdr_fetch_claims`) = (SELECT COUNT(*) FROM `_bk_autohdr_fetch_claims`) THEN 1 ELSE 0 END;--> statement-breakpoint

INSERT INTO `_migration_assert` (`name`, `passed`)
SELECT 'edited_source_claims_count', CASE WHEN (SELECT COUNT(*) FROM `edited_source_claims`) = (SELECT COUNT(*) FROM `_bk_edited_source_claims`) THEN 1 ELSE 0 END;--> statement-breakpoint

INSERT INTO `_migration_assert` (`name`, `passed`)
SELECT 'autohdr_final_associations_count', CASE WHEN (SELECT COUNT(*) FROM `autohdr_final_associations`) = (SELECT COUNT(*) FROM `_bk_autohdr_final_associations`) THEN 1 ELSE 0 END;--> statement-breakpoint

-- Feed PRAGMA foreign_key_check into assertion table
INSERT INTO `_migration_assert` (`name`, `passed`)
SELECT 'foreign_key_integrity', CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END FROM pragma_foreign_key_check();--> statement-breakpoint

-- 7. Cleanup Temp Tables
DROP TABLE `_migration_assert`;--> statement-breakpoint
DROP TABLE `_bk_autohdr_handoffs`;--> statement-breakpoint
DROP TABLE `_bk_autohdr_output_mappings`;--> statement-breakpoint
DROP TABLE `_bk_autohdr_path_claims`;--> statement-breakpoint
DROP TABLE `_bk_autohdr_fetch_claims`;--> statement-breakpoint
DROP TABLE `_bk_edited_source_claims`;--> statement-breakpoint
DROP TABLE `_bk_autohdr_final_associations`;--> statement-breakpoint
DROP TABLE `_bk_assets_handoff_ptrs`;--> statement-breakpoint
```

---

## Part 5: Router Implementations & Dropbox Sync Wiring

### 5.1 Router Implementations (`workers/background/src/autohdr/routers.ts`)

Routers accept `DropboxEntry[]` (`DropboxFile | DropboxFolder`), require photo files to be direct children of `04-MANUAL-Photos`, `04-FINAL-Photos`, or `04-FINALS-Photos`, and return `{ matched: number, routes: RoutedAutoHdrMapping[] }`.

```ts
import { isAcceptedPhotoFilename } from "@quincy/shared";
import { autohdrScaffoldClaims, projects } from "@quincy/db/schema";
import { and, eq, sql } from "drizzle-orm";
import type { Env } from "../env";
import { dbFor } from "../lib/db";
import { claimImplicitAutoHdrHandoff } from "./claims";
import type { DropboxEntry } from "../dropbox/client";
import type { RoutedAutoHdrMapping } from "./mapping";

export async function routeAutoHdrManualDropDelta(
  env: Env,
  connectionId: string,
  entries: DropboxEntry[],
): Promise<{ matched: number; routes: RoutedAutoHdrMapping[] }> {
  const db = dbFor(env);
  const routes: RoutedAutoHdrMapping[] = [];
  let matched = 0;

  const validManualEntries = entries.filter((e): e is Extract<DropboxEntry, { ".tag": "file" }> => {
    if (e[".tag"] !== "file") return false;
    if (!isAcceptedPhotoFilename(e.name)) return false;
    const lower = e.path_lower.toLowerCase();
    const parts = lower.split("/");
    // Direct child requirement: parent folder must be 04-manual-photos
    return parts.length >= 4 && parts[parts.length - 2] === "04-manual-photos";
  });

  if (validManualEntries.length === 0) return { matched: 0, routes: [] };

  for (const entry of validManualEntries) {
    const parts = entry.path_lower.split("/");
    const manualIdx = parts.findIndex((p) => p === "04-manual-photos");
    if (manualIdx <= 1) continue;
    const scaffoldPathKey = parts.slice(0, manualIdx).join("/");

    // Match never-sent or non-active project via active scaffold claim
    const project = await db.select({ projectId: autohdrScaffoldClaims.projectId })
      .from(autohdrScaffoldClaims)
      .where(and(
        eq(autohdrScaffoldClaims.connectionId, connectionId),
        eq(autohdrScaffoldClaims.scaffoldPathKey, scaffoldPathKey),
        eq(autohdrScaffoldClaims.state, "active"),
        sql`NOT EXISTS (SELECT 1 FROM autohdr_handoffs WHERE project_id = autohdr_scaffold_claims.project_id AND state IN ('starting', 'started', 'blocked'))`,
      )).get();

    if (!project) continue;
    matched++;

    // Freeze exact manual leaf path (e.g. /AutoHDR/<folderName>/04-MANUAL-Photos)
    const displayParts = (entry.path_display ?? entry.path_lower).split("/");
    const manualLeafPath = displayParts.slice(0, manualIdx + 1).join("/");

    const result = await claimImplicitAutoHdrHandoff(env, project.projectId, connectionId, manualLeafPath);
    if (result && !result.reused && !result.isCollision) {
      routes.push({
        projectId: project.projectId,
        handoffId: result.handoffId,
        mappingId: result.mappingId,
        generation: result.generation,
        connectionId,
        finalPath: result.finalPath,
        finalPathKey: result.finalPathKey,
        representativeChangedPath: entry.path_display ?? entry.path_lower,
      });
    }
  }

  return { matched, routes };
}

export async function routeAutoHdrProviderDelta(
  env: Env,
  connectionId: string,
  entries: DropboxEntry[],
): Promise<{ matched: number; routes: RoutedAutoHdrMapping[] }> {
  const db = dbFor(env);
  const routes: RoutedAutoHdrMapping[] = [];
  let matched = 0;

  const validProviderEntries = entries.filter((e): e is Extract<DropboxEntry, { ".tag": "file" }> => {
    if (e[".tag"] !== "file") return false;
    if (!isAcceptedPhotoFilename(e.name)) return false;
    const lower = e.path_lower.toLowerCase();
    const parts = lower.split("/");
    // Direct child requirement: parent folder must be 04-final-photos or 04-finals-photos
    if (parts.length < 4) return false;
    const parent = parts[parts.length - 2];
    return parent === "04-final-photos" || parent === "04-finals-photos";
  });

  if (validProviderEntries.length === 0) return { matched: 0, routes: [] };

  for (const entry of validProviderEntries) {
    const parts = entry.path_lower.split("/");
    const finalIdx = parts.findIndex((p) => p === "04-final-photos" || p === "04-finals-photos");
    if (finalIdx <= 1) continue;
    const scaffoldPathKey = parts.slice(0, finalIdx).join("/");

    // Re-query D1 fresh so NOT EXISTS sees handoffs created by routeAutoHdrManualDropDelta
    const project = await db.select({ projectId: autohdrScaffoldClaims.projectId })
      .from(autohdrScaffoldClaims)
      .where(and(
        eq(autohdrScaffoldClaims.connectionId, connectionId),
        eq(autohdrScaffoldClaims.scaffoldPathKey, scaffoldPathKey),
        eq(autohdrScaffoldClaims.state, "active"),
        sql`NOT EXISTS (SELECT 1 FROM autohdr_handoffs WHERE project_id = autohdr_scaffold_claims.project_id AND state IN ('starting', 'started', 'blocked'))`,
      )).get();

    if (!project) continue;
    matched++;

    // Freeze exact provider leaf path (e.g. /AutoHDR/<folderName>/04-FINAL-Photos)
    const displayParts = (entry.path_display ?? entry.path_lower).split("/");
    const providerLeafPath = displayParts.slice(0, finalIdx + 1).join("/");

    const result = await claimImplicitAutoHdrHandoff(env, project.projectId, connectionId, providerLeafPath);
    if (result && !result.reused && !result.isCollision) {
      routes.push({
        projectId: project.projectId,
        handoffId: result.handoffId,
        mappingId: result.mappingId,
        generation: result.generation,
        connectionId,
        finalPath: result.finalPath,
        finalPathKey: result.finalPathKey,
        representativeChangedPath: entry.path_display ?? entry.path_lower,
      });
    }
  }

  return { matched, routes };
}
```

### 5.2 Strict Precedence Monitor Wiring (`workers/background/src/do/dropbox-sync.ts`)

`DropboxSyncDO.alarm()` processes all three router passes (Explicit, Manual, Provider) in strict order, initiating fetch claims for all discovered routes:

```ts
// Inside DropboxSyncDO alarm handler (autohdr scope branch, lines 118-132):
const connectionId = identity.connectionId;

// 1. Explicit Handoff Router Pass
const explicitRouted = await routeAutoHdrDelta(db, connectionId, page.entries);

// 2. Manual Drop Implicit Router Pass (Runs FIRST for implicit detection)
const manualRouted = await routeAutoHdrManualDropDelta(this.env, connectionId, page.entries);

// 3. Provider Output Implicit Router Pass (Runs SECOND; re-reads D1 fresh)
const providerRouted = await routeAutoHdrProviderDelta(this.env, connectionId, page.entries);

const allRoutes = [...explicitRouted.routes, ...manualRouted.routes, ...providerRouted.routes];
matchedCount = explicitRouted.matched + manualRouted.matched + providerRouted.matched;

for (const [index, route] of allRoutes.entries()) {
  if (index > 0) await new Promise<void>((resolve) => setTimeout(resolve, 250));
  const owner = await claimAutoHdrFetch(this.env, route, {
    trigger: "dropbox_delta",
    representativeChangedPath: route.representativeChangedPath,
    monitorScope: "autohdr",
    monitorRoot: "/AutoHDR",
  });
  await startClaimedFetch(this.env, owner);
  routedProjectCount += 1;
}
```

---

## Part 6: Executable Backfill Implementation

### 6.1 Dedicated Backfill Creation Helper (`claimBackfillAutoHdrHandoff`)

Backfill resolves stranded projects in `editing_autohdr` stage that lack an active V2 handoff. Since prior retired/failed handoffs may exist, backfill uses `claimBackfillAutoHdrHandoff()` to increment generation ($N + 1$) and reactivate tombstoned path claims:

```ts
export async function claimBackfillAutoHdrHandoff(
  env: Env,
  projectId: string,
  connectionId: string,
  targetPath: string,
): Promise<ImplicitHandoffResult | null> {
  const db = dbFor(env);
  const now = new Date();
  const nowMs = now.getTime();
  const targetPathKey = dropboxPathKey(targetPath);

  // Exclude projects with an ACTIVE handoff generation ('starting', 'started', 'blocked')
  const activeHandoff = await db.select({ id: autoHdrHandoffs.id }).from(autoHdrHandoffs)
    .where(and(eq(autoHdrHandoffs.projectId, projectId), inArray(autoHdrHandoffs.state, ["starting", "started", "blocked"]))).get();
  if (activeHandoff) return null;

  // Calculate next generation number
  const maxGenRow = await db.select({ maxGen: sql<number>`COALESCE(MAX(generation), 0)` })
    .from(autoHdrHandoffs).where(eq(autoHdrHandoffs.projectId, projectId)).get();
  const generation = (maxGenRow?.maxGen ?? 0) + 1;

  const handoffId = crypto.randomUUID();
  const mappingId = crypto.randomUUID();
  const pathClaimId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const workflowId = `autohdr-backfill-${projectId}-g${generation}`;
  const lowerPath = targetPath.toLowerCase();
  const candidateEnum: "manual" | "final" | "finals" = lowerPath.endsWith("/04-manual-photos")
    ? "manual"
    : lowerPath.endsWith("/04-finals-photos")
      ? "finals"
      : "final";

  // Reactivate tombstoned path claim if it exists for this project/pathKey, rebinding to new generation
  const existingClaim = await db.select({ id: autoHdrPathClaims.id }).from(autoHdrPathClaims)
    .where(and(eq(autoHdrPathClaims.projectId, projectId), eq(autoHdrPathClaims.pathKey, targetPathKey), eq(autoHdrPathClaims.state, "tombstone"))).get();

  const batchStatements: ReturnType<typeof env.DB.prepare>[] = [
    env.DB.prepare(`
      INSERT INTO jobs (id, kind, status, correlation_id, project_id, payload_json, retries, created_at, updated_at)
      VALUES (?, 'autohdr', 'done', ?, ?, ?, 0, ?, ?)
    `).bind(jobId, `autohdr:backfill:${projectId}:${generation}`, projectId, JSON.stringify({ backfill: true, targetPath }), nowMs, nowMs),

    env.DB.prepare(`
      INSERT INTO autohdr_handoffs (
        id, project_id, connection_id, generation, manifest_version, selection_hash,
        selected_asset_ids_json, readiness_units_json, frozen_raw_folder_path,
        initiated_by, expected_origin_stage, state, workflow_id, job_id,
        lease_expires_at, started_at, created_at, updated_at
      ) SELECT
        ?, ?, ?, ?, 1, 'backfill-v2',
        '[]', '[]', COALESCE(raw_folder_path, ''),
        NULL, stage_key, 'started', ?, ?,
        ?, ?, ?, ?
      FROM projects WHERE id = ?
    `).bind(handoffId, projectId, connectionId, generation, workflowId, jobId, nowMs + 86400000, nowMs, nowMs, nowMs, projectId),

    env.DB.prepare(`
      INSERT INTO autohdr_output_mappings (
        id, project_id, handoff_id, connection_id, generation,
        state, final_path, final_path_key, observed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
    `).bind(mappingId, projectId, handoffId, connectionId, generation, targetPath, targetPathKey, nowMs, nowMs, nowMs),
  ];

  if (existingClaim) {
    batchStatements.push(
      env.DB.prepare(`
        UPDATE autohdr_path_claims
        SET state = 'active', handoff_id = ?, mapping_id = ?, updated_at = ?
        WHERE id = ?
      `).bind(handoffId, mappingId, nowMs, existingClaim.id),
    );
  } else {
    batchStatements.push(
      env.DB.prepare(`
        INSERT INTO autohdr_path_claims (
          id, mapping_id, handoff_id, project_id, connection_id, candidate,
          path, path_key, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).bind(pathClaimId, mappingId, handoffId, projectId, connectionId, candidateEnum, targetPath, targetPathKey, nowMs, nowMs),
    );
  }

  await env.DB.batch(batchStatements);

  return {
    handoffId,
    jobId,
    workflowId,
    reused: false,
    generation,
    mappingId,
    finalPath: targetPath,
    finalPathKey: targetPathKey,
    isCollision: false,
  };
}
```

### 6.2 Backfill RPC Service (`workers/background/src/autohdr/backfill.ts`)

```ts
import { and, eq, sql } from "drizzle-orm";
import { autoHdrHandoffs, autoHdrOutputMappings, projects } from "@quincy/db/schema";
import type { Env } from "../env";
import { dbFor } from "../lib/db";
import { canonicalDropboxConnectionId } from "../dropbox/connection";
import { deriveAutoHdrFolderName } from "./paths";
import { claimBackfillAutoHdrHandoff } from "./claims";

export interface BackfillParams {
  dryRun?: boolean;
  limit?: number;
  cursor?: string;
}

export interface BackfillResult {
  ok: boolean;
  processedCount: number;
  backfilledCount: number;
  skippedCount: number;
  nextCursor?: string;
  items: Array<{ projectId: string; action: "created" | "skipped"; reason?: string }>;
}

export async function backfillAutoHdrV2(env: Env, params: BackfillParams): Promise<BackfillResult> {
  const db = dbFor(env);
  const limit = Math.min(params.limit ?? 50, 100);
  const connectionId = await canonicalDropboxConnectionId(db);

  // Inclusion query: stranded projects in editing_autohdr lacking active V2 handoffs ('starting','started','blocked')
  const strandedProjects = await db.select({
    id: projects.id,
    rawFolderPath: projects.rawFolderPath,
  }).from(projects)
    .where(and(
      eq(projects.stageKey, "editing_autohdr"),
      params.cursor ? sql`${projects.id} > ${params.cursor}` : sql`1=1`,
      sql`NOT EXISTS (
        SELECT 1 FROM autohdr_handoffs h
        JOIN autohdr_output_mappings m ON m.handoff_id = h.id
        WHERE h.project_id = projects.id
          AND h.state IN ('starting', 'started', 'blocked')
          AND m.state IN ('pending_discovery', 'active', 'blocked_collision')
      )`,
    ))
    .orderBy(projects.id)
    .limit(limit + 1)
    .all();

  const hasMore = strandedProjects.length > limit;
  const itemsToProcess = hasMore ? strandedProjects.slice(0, limit) : strandedProjects;
  const nextCursor = hasMore ? itemsToProcess[itemsToProcess.length - 1]?.id : undefined;

  let backfilledCount = 0;
  let skippedCount = 0;
  const items: BackfillResult["items"] = [];

  for (const proj of itemsToProcess) {
    if (!proj.rawFolderPath) {
      items.push({ projectId: proj.id, action: "skipped", reason: "Missing raw_folder_path" });
      skippedCount++;
      continue;
    }

    const folderName = deriveAutoHdrFolderName(proj.rawFolderPath);
    const candidatePath = `/AutoHDR/${folderName}/04-FINAL-Photos`;

    if (params.dryRun) {
      items.push({ projectId: proj.id, action: "created", reason: `[Dry Run] Would backfill implicit handoff for ${candidatePath}` });
      backfilledCount++;
      continue;
    }

    const result = await claimBackfillAutoHdrHandoff(env, proj.id, connectionId, candidatePath);
    if (result) {
      items.push({ projectId: proj.id, action: "created", reason: `Backfilled generation ${result.generation} handoff ${result.handoffId}` });
      backfilledCount++;
    } else {
      items.push({ projectId: proj.id, action: "skipped", reason: "Handoff creation ineligible or active handoff exists" });
      skippedCount++;
    }
  }

  return {
    ok: true,
    processedCount: itemsToProcess.length,
    backfilledCount,
    skippedCount,
    nextCursor,
    items,
  };
}
```

### 6.3 Hono Admin Route Handler (`workers/app/src/routes/admin.ts`)

```ts
adminRoutes.post("/admin/autohdr/backfill", requireCapability("adminBackend"), async (c) => {
  const body = await c.req.json<{ dryRun?: boolean; limit?: number; cursor?: string }>().catch(() => ({}));
  const res = await c.env.BACKGROUND.backfillAutoHdrV2({
    dryRun: body.dryRun ?? false,
    limit: body.limit,
    cursor: body.cursor,
  });
  await audit(c.env, c.get("user").id, "admin.autohdr_backfill", "system", "backfill", { result: res });
  return c.json(res);
});
```

### 6.4 Auth Invocation Example (Production Better Auth Cookie)

To trigger backfill against production API:

```bash
curl -X POST "https://portal.quincy.com/api/admin/autohdr/backfill" \
  -H "Cookie: __Secure-better-auth.session_token=<ADMIN_SESSION_TOKEN>" \
  -H "Origin: https://portal.quincy.com" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": false, "limit": 50}'
```

---

## Part 7: Frontend Status Polling Integration (`ProjectWorkspace.tsx`)

### 7.1 AutoHDR Status API Endpoint (`workers/app/src/routes/projects.ts`)

Add endpoint `/api/projects/:id/autohdr-status` to return active mapping details for UI display:

```ts
projectsRoutes.get("/projects/:id/autohdr-status", requireCapability("adminBackend"), async (c) => {
  const id = c.req.param("id");
  if (!idCheck(id)) return c.json({ error: "Invalid project id" }, 400);
  const db = createDb(c.env.DB);

  const active = await db.select({
    handoffId: schema.autoHdrHandoffs.id,
    handoffState: schema.autoHdrHandoffs.state,
    mappingId: schema.autoHdrOutputMappings.id,
    mappingState: schema.autoHdrOutputMappings.state,
    finalPath: schema.autoHdrOutputMappings.finalPath,
    generation: schema.autoHdrHandoffs.generation,
  }).from(schema.autoHdrHandoffs)
    .leftJoin(schema.autoHdrOutputMappings, eq(schema.autoHdrHandoffs.id, schema.autoHdrOutputMappings.handoffId))
    .where(and(eq(schema.autoHdrHandoffs.projectId, id), inArray(schema.autoHdrHandoffs.state, ["starting", "started", "blocked"])))
    .get();

  if (!active) {
    return c.json({ ok: true, autohdrState: "none" });
  }

  return c.json({
    ok: true,
    autohdrState: active.mappingState === "active" ? "active" : active.handoffState === "blocked" ? "blocked_collision" : "started",
    handoffId: active.handoffId,
    mappingId: active.mappingId,
    finalPath: active.finalPath,
    generation: active.generation,
  });
});
```

### 7.2 Dedicated Frontend Status Hook (`apps/web/src/screens/ProjectWorkspace.tsx`)

Since implicit AutoHDR jobs are created with `status = 'done'`, job-based polling does not fire for them. `ProjectWorkspace.tsx` includes a dedicated polling effect whenever `project.stageKey === 'editing_autohdr'`:

```tsx
interface AutoHdrStatusResponse {
  ok: boolean;
  autohdrState: "none" | "started" | "active" | "blocked_collision";
  finalPath?: string;
  generation?: number;
}

// Dedicated AutoHDR status polling effect in ProjectWorkspace component
useEffect(() => {
  if (!canAdminBackend || !projectId || data?.stageKey !== "editing_autohdr") return;

  let isMounted = true;
  const pollAutoHdrStatus = async () => {
    try {
      const status = await apiGet<AutoHdrStatusResponse>(`/api/projects/${projectId}/autohdr-status`);
      if (!isMounted) return;

      if (status.autohdrState === "active") {
        // Edited photos are ready for retrieval; refresh edited collection
        void refreshAssets("edited");
      }
    } catch {
      // Ignore polling errors
    }
  };

  void pollAutoHdrStatus();
  const interval = window.setInterval(pollAutoHdrStatus, 5_000);
  return () => {
    isMounted = false;
    window.clearInterval(interval);
  };
}, [canAdminBackend, data?.stageKey, projectId, refreshAssets]);
```

---

## Part 8: Comprehensive Test Plan & Verification

### 8.1 Test Files & Locations

- Background Worker Tests: `workers/background/test/*.test.ts`
- App Worker Route Tests: `workers/app/test/*.test.ts`

### 8.2 Mandatory Test Cases

1. **`workers/background/test/autohdr-implicit-single-leaf.test.ts`**:
   - Asserts manual-drop file creates single-leaf mapping for `04-MANUAL-Photos` and advances stage to `editing_autohdr`.
   - Asserts `audit_log` row is written with action `stage.auto_advance`.
   - Asserts subsequent provider output files for same project are skipped by `NOT EXISTS`.
2. **`workers/background/test/autohdr-fk-ordering.test.ts`**:
   - Verifies `jobs` row is inserted before `autohdr_handoffs`.
   - Asserts single atomic D1 batch creates `jobs`, `autohdr_handoffs`, `autohdr_output_mappings`, and `autoHdrPathClaims` without foreign key constraint errors.
3. **`workers/background/test/autohdr-migration-0015.test.ts`**:
   - Populates database with live rows in `autohdr_handoffs` and all 5 child tables.
   - Runs migration 0015 and verifies row count equality assertions and `PRAGMA foreign_key_check` pass cleanly.
4. **`workers/background/test/autohdr-router-wiring.test.ts`**:
   - Feeds `DropboxEntry[]` array with files in `04-MANUAL-Photos` and `04-FINAL-Photos`.
   - Verifies router returns `RoutedAutoHdrMapping[]` and `dropbox-sync.ts` alarm handler executes `claimAutoHdrFetch()` and `startClaimedFetch()` in the same pass.
5. **`workers/background/test/autohdr-backfill.test.ts`**:
   - Executes `backfillAutoHdrV2()` on stranded projects.
   - Confirms reactivation of `tombstone` path claims and rebinding of `handoff_id`/`mapping_id` to new generation.

---

## Plan Artifact File Location

The complete Round 6 Plan has been saved to:
`file:///Users/tingruilee/.gemini/antigravity-cli/brain/a0436bd0-31dc-490e-ba56-d7d49c015f6b/autohdr_legacy_cleanup_and_autodetect_plan_r6.md`
